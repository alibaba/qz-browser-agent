import { toolT } from "./tool-messages.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolContext } from "#sdk/background";
type DiagnosticsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "makeSessionTabTargetError" | "sendCdp"
  | "secondsToMs" | "assertUrlAllowed">;
interface RemoteObject { type?: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string }
interface CallFrame { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }
interface StackTrace { callFrames?: CallFrame[] }
interface ConsoleEvent {
  type?: string; args?: RemoteObject[]; timestamp?: number; stackTrace?: StackTrace;
  exceptionDetails?: CallFrame & { text?: string; exception?: RemoteObject; stackTrace?: StackTrace };
}
interface NetworkEvent {
  requestId: string; timestamp: number; wallTime?: number; type?: string; encodedDataLength?: number;
  errorText?: string; canceled?: boolean; initiator?: { type?: string };
  request?: { url?: string; method?: string; headers?: Record<string, unknown> };
  response?: { status?: number; statusText?: string; mimeType?: string; headers?: Record<string, unknown>;
    fromDiskCache?: boolean; fromServiceWorker?: boolean; remoteIPAddress?: string };
}
interface Monitor { tabId: number; enabled: boolean; maxRecords: number; sessionId: string; runId: string }
interface NetworkRecord {
  requestId: string; url: string; method: string; resourceType: string; requestHeaders: Record<string, string>;
  timestamp: number; wallTime: number | null; initiatorType: string; status: number | null; statusText: string;
  mimeType: string; responseHeaders: Record<string, string>; fromDiskCache: boolean; fromServiceWorker: boolean;
  encodedDataLength: number | null; durationMs: number | null; failed: boolean; errorText: string;
  canceled: boolean; finished: boolean; remoteIPAddress?: string; responseTime?: number; endTime?: number;
}
interface NetworkMonitor extends Monitor {
  records: Map<string, NetworkRecord>; order: string[]; inFlight: Set<string>; waiters: Set<{ check(): void }>;
}
interface RecordFilter {
  textPattern?: string; urlPattern?: string; flags?: string; level?: string; type?: string;
  method?: string; mimePattern?: string; status?: number; failed?: boolean; resourceType?: string;
}
interface RegexError { error: true; code: string; message: string; pattern: string; flags: string }
type Filtered<T> = { records: T[]; error?: false } | RegexError;
import { pageWaitTimeout } from "#sdk/background/tools";
import { getSecurityGuardrails, matchBlockedUrl } from "#sdk/shared/security";

/** Owns per-tab Network/Console monitors and registers diagnostic tools. */
export function createDiagnosticsTools({
  registerTool,
  ToolExecutionError,
  makeSessionTabTargetError,
  sendCdp,
  secondsToMs,
  assertUrlAllowed: assertUrlAllowedBySecurityGuardrails,
}: DiagnosticsHost) {
interface ConsoleRecord {
  type: string; text: string; timestamp: number; url: string; lineNumber: number | null; columnNumber: number | null;
  stackTrace: ReturnType<typeof formatStackTrace>; args?: ReturnType<typeof formatRemoteObject>[];
  exception?: ReturnType<typeof formatRemoteObject>; level?: string;
}
interface ConsoleMonitor extends Monitor { records: ConsoleRecord[] }

// ---------------------------------------------------------------------------
// Network monitor: per-tab ring buffer over CDP Network events
// ---------------------------------------------------------------------------

const networkMonitors = new Map<number, NetworkMonitor>();
const DEFAULT_NETWORK_LIMIT = 200;
const DEFAULT_BODY_LIMIT = 120000;

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  if (source.sessionId || source.tabId == null || !method.startsWith("Network.")) return;
  const monitor = networkMonitors.get(source.tabId);
  if (!monitor?.enabled) return;
  handleNetworkEvent(monitor, method, params as NetworkEvent);
});

const consoleMonitors = new Map<number, ConsoleMonitor>();
const DEFAULT_CONSOLE_LIMIT = 200;

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  if (source.sessionId || source.tabId == null || !method.startsWith("Runtime.")) return;
  const monitor = consoleMonitors.get(source.tabId);
  if (!monitor?.enabled) return;
  handleConsoleEvent(monitor, method, params as ConsoleEvent);
});

chrome.debugger?.onDetach?.addListener((source) => {
  if (source.tabId == null) return;
  const networkMonitor = networkMonitors.get(source.tabId);
  if (networkMonitor) networkMonitor.enabled = false;
  const consoleMonitor = consoleMonitors.get(source.tabId);
  if (consoleMonitor) consoleMonitor.enabled = false;
});

function getNetworkMonitor(tabId: number) {
  let monitor = networkMonitors.get(tabId);
  if (!monitor) {
    monitor = {
      tabId,
      enabled: false,
      maxRecords: DEFAULT_NETWORK_LIMIT,
      sessionId: "",
      runId: "",
      records: new Map(),
      order: [],
      inFlight: new Set(),
      waiters: new Set(),
    };
    networkMonitors.set(tabId, monitor);
  }
  return monitor;
}

function getConsoleMonitor(tabId: number) {
  let monitor = consoleMonitors.get(tabId);
  if (!monitor) {
    monitor = {
      tabId,
      enabled: false,
      maxRecords: DEFAULT_CONSOLE_LIMIT,
      sessionId: "",
      runId: "",
      records: [],
    };
    consoleMonitors.set(tabId, monitor);
  }
  return monitor;
}

function resetConsoleMonitor(monitor: ConsoleMonitor, maxRecords = monitor.maxRecords) {
  monitor.maxRecords = clampNumber(maxRecords, 20, 1000, DEFAULT_CONSOLE_LIMIT);
  monitor.records = [];
}

async function enableConsoleMonitor(tabId: number | undefined, { reset = false, maxRecords = DEFAULT_CONSOLE_LIMIT } = {}, context: ToolContext = {}) {
  if (!tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "read_console_messages" });

  const monitor = getConsoleMonitor(tabId);
  const runChanged = monitor.sessionId !== String(context.sessionId || "")
    || monitor.runId !== String(context.runId || "");
  if (runChanged) {
    resetConsoleMonitor(monitor, maxRecords);
    monitor.sessionId = String(context.sessionId || "");
    monitor.runId = String(context.runId || "");
  }
  if (reset) resetConsoleMonitor(monitor, maxRecords);
  monitor.maxRecords = clampNumber(maxRecords, 20, 1000, monitor.maxRecords);

  await sendCdp(tabId, "Runtime.enable", {}, context);
  monitor.enabled = true;
  return monitor;
}

function handleConsoleEvent(monitor: ConsoleMonitor, method: string, params: ConsoleEvent) {
  if (method === "Runtime.consoleAPICalled") {
    const frame = params.stackTrace?.callFrames?.[0] || {};
    pushConsoleRecord(monitor, {
      type: params.type || "log",
      text: formatConsoleArgs(params.args || []),
      timestamp: params.timestamp || Date.now(),
      url: frame.url || "",
      lineNumber: Number.isFinite(frame.lineNumber) ? frame.lineNumber! : null,
      columnNumber: Number.isFinite(frame.columnNumber) ? frame.columnNumber! : null,
      stackTrace: formatStackTrace(params.stackTrace),
      args: (params.args || []).slice(0, 20).map(formatRemoteObject),
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    pushConsoleRecord(monitor, {
      type: "exception",
      text: details.exception?.description || details.text || "Unknown exception",
      timestamp: params.timestamp || Date.now(),
      url: details.url || details.stackTrace?.callFrames?.[0]?.url || "",
      lineNumber: Number.isFinite(details.lineNumber) ? details.lineNumber! : null,
      columnNumber: Number.isFinite(details.columnNumber) ? details.columnNumber! : null,
      stackTrace: formatStackTrace(details.stackTrace),
      exception: formatRemoteObject(details.exception || {}),
    });
  }
}

function pushConsoleRecord(monitor: ConsoleMonitor, record: ConsoleRecord) {
  monitor.records.push({
    ...record,
    level: normalizeConsoleLevel(record.type),
  });
  while (monitor.records.length > monitor.maxRecords) monitor.records.shift();
}

function normalizeConsoleLevel(type: string) {
  const value = String(type || "").toLowerCase();
  if (["error", "assert", "exception"].includes(value)) return "error";
  if (["warning", "warn"].includes(value)) return "warning";
  if (["debug", "trace"].includes(value)) return "debug";
  return "info";
}

function formatConsoleArgs(args: RemoteObject[] = []) {
  return args.map(formatRemoteObjectText).filter(Boolean).join(" ");
}

function formatRemoteObjectText(object: RemoteObject = {}) {
  if (Object.prototype.hasOwnProperty.call(object, "value")) {
    try {
      return typeof object.value === "string" ? object.value : JSON.stringify(object.value);
    } catch(_e) {
      return String(object.value);
    }
  }
  return String(object.description || object.unserializableValue || object.type || "");
}

function formatRemoteObject(object: RemoteObject = {}) {
  return {
    type: object.type || "",
    subtype: object.subtype || "",
    value: Object.prototype.hasOwnProperty.call(object, "value") ? object.value : undefined,
    description: object.description || "",
    unserializableValue: object.unserializableValue || "",
  };
}

function formatStackTrace(stackTrace?: StackTrace | null) {
  const frames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
  return frames.slice(0, 20).map((frame) => ({
    functionName: frame.functionName || "",
    url: frame.url || "",
    lineNumber: Number.isFinite(frame.lineNumber) ? frame.lineNumber! : null,
    columnNumber: Number.isFinite(frame.columnNumber) ? frame.columnNumber! : null,
  }));
}

function filterConsoleRecords(monitor: ConsoleMonitor, filter: RecordFilter = {}): Filtered<ConsoleRecord> {
  const textPattern = filter.textPattern ? safeRegExp(filter.textPattern, filter.flags || "i") : null;
  if (textPattern?.error) return textPattern;
  const urlPattern = filter.urlPattern ? safeRegExp(filter.urlPattern, filter.flags || "i") : null;
  if (urlPattern?.error) return urlPattern;
  const level = filter.level ? String(filter.level).toLowerCase() : "";
  const type = filter.type ? String(filter.type).toLowerCase() : "";

  return {
    records: monitor.records.filter((record) => {
      if (textPattern) textPattern.lastIndex = 0;
      if (urlPattern) urlPattern.lastIndex = 0;
      if (level && record.level !== level) return false;
      if (type && String(record.type || "").toLowerCase() !== type) return false;
      if (textPattern && !textPattern.test(record.text || "")) return false;
      if (urlPattern && !urlPattern.test(record.url || "")) return false;
      return true;
    }),
  };
}

function resetNetworkMonitor(monitor: NetworkMonitor, maxRecords = monitor.maxRecords) {
  monitor.maxRecords = clampNumber(maxRecords, 20, 1000, DEFAULT_NETWORK_LIMIT);
  monitor.records.clear();
  monitor.order = [];
  monitor.inFlight.clear();
}

async function enableNetworkMonitor(tabId: number | undefined, { reset = false, maxRecords = DEFAULT_NETWORK_LIMIT } = {}, context: ToolContext = {}) {
  if (!tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "network_watch" });

  const monitor = getNetworkMonitor(tabId);
  const runChanged = monitor.sessionId !== String(context.sessionId || "")
    || monitor.runId !== String(context.runId || "");
  if (runChanged) {
    resetNetworkMonitor(monitor, maxRecords);
    monitor.sessionId = String(context.sessionId || "");
    monitor.runId = String(context.runId || "");
  }
  if (reset) resetNetworkMonitor(monitor, maxRecords);
  monitor.maxRecords = clampNumber(maxRecords, 20, 1000, monitor.maxRecords);

  await sendCdp(tabId, "Network.enable", {
    maxTotalBufferSize: 50 * 1024 * 1024,
    maxResourceBufferSize: 10 * 1024 * 1024,
  }, context);
  monitor.enabled = true;
  return monitor;
}

async function enablePreNavigationNetworkWatch(tabId: number, {
  resetNetwork = true,
  networkMaxRecords = DEFAULT_NETWORK_LIMIT,
} = {}, context: ToolContext = {}) {
  const monitor = await enableNetworkMonitor(tabId, {
    reset: resetNetwork !== false,
    maxRecords: networkMaxRecords,
  }, context);
  return {
    watching: true,
    startedBeforeNavigation: true,
    tabId: monitor.tabId,
    maxRecords: monitor.maxRecords,
    records: monitor.order.length,
    inFlight: monitor.inFlight.size,
    note: toolT("networkWatchingBeforeNavigation"),
  };
}

function handleNetworkEvent(monitor: NetworkMonitor, method: string, params: NetworkEvent) {
  if (method === "Network.requestWillBeSent") {
    const requestId = params.requestId;
    const record: NetworkRecord = {
      requestId,
      url: params.request?.url || "",
      method: params.request?.method || "",
      resourceType: params.type || "",
      requestHeaders: summarizeHeaders(params.request?.headers),
      timestamp: params.timestamp,
      wallTime: params.wallTime || null,
      initiatorType: params.initiator?.type || "",
      status: null,
      statusText: "",
      mimeType: "",
      responseHeaders: {},
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedDataLength: null,
      durationMs: null,
      failed: false,
      errorText: "",
      canceled: false,
      finished: false,
    };
    monitor.records.set(requestId, record);
    monitor.order.push(requestId);
    monitor.inFlight.add(requestId);
    trimNetworkRecords(monitor);
    notifyNetworkWaiters(monitor);
    return;
  }

  const record = monitor.records.get(params.requestId);
  if (!record) return;

  if (method === "Network.responseReceived") {
    const response = params.response || {};
    record.status = response.status ?? null;
    record.statusText = response.statusText || "";
    record.mimeType = response.mimeType || "";
    record.responseHeaders = summarizeHeaders(response.headers);
    record.fromDiskCache = !!response.fromDiskCache;
    record.fromServiceWorker = !!response.fromServiceWorker;
    record.remoteIPAddress = response.remoteIPAddress || "";
    record.responseTime = params.timestamp;
  } else if (method === "Network.loadingFinished") {
    record.finished = true;
    record.encodedDataLength = params.encodedDataLength ?? null;
    record.endTime = params.timestamp;
    record.durationMs = record.timestamp ? Math.round((params.timestamp - record.timestamp) * 1000) : null;
    monitor.inFlight.delete(params.requestId);
  } else if (method === "Network.loadingFailed") {
    record.finished = true;
    record.failed = true;
    record.errorText = params.errorText || "";
    record.canceled = !!params.canceled;
    record.endTime = params.timestamp;
    record.durationMs = record.timestamp ? Math.round((params.timestamp - record.timestamp) * 1000) : null;
    monitor.inFlight.delete(params.requestId);
  }

  notifyNetworkWaiters(monitor);
}

function trimNetworkRecords(monitor: NetworkMonitor) {
  while (monitor.order.length > monitor.maxRecords) {
    const id = monitor.order.shift()!;
    monitor.records.delete(id);
    monitor.inFlight.delete(id);
  }
}

function summarizeHeaders(headers: Record<string, unknown> = {}) {
  const keep = new Set([
    "content-type", "content-length", "location", "cache-control",
    "x-request-id", "x-trace-id", "date", "server",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (keep.has(lower) || lower.startsWith("x-")) out[key] = String(value).slice(0, 300);
  }
  return out;
}

function networkRecordSummary(record: NetworkRecord) {
  return {
    requestId: record.requestId,
    method: record.method,
    url: record.url,
    resourceType: record.resourceType,
    status: record.status,
    statusText: record.statusText,
    mimeType: record.mimeType,
    failed: record.failed,
    errorText: record.errorText || null,
    canceled: record.canceled,
    finished: record.finished,
    durationMs: record.durationMs,
    encodedDataLength: record.encodedDataLength,
    fromDiskCache: record.fromDiskCache,
    fromServiceWorker: record.fromServiceWorker,
  };
}

function filterNetworkRecords(monitor: NetworkMonitor, filter: RecordFilter = {}): Filtered<NetworkRecord> {
  const pattern = filter.urlPattern ? safeRegExp(filter.urlPattern, filter.flags || "i") : null;
  if (pattern?.error) return pattern;
  const method = filter.method ? String(filter.method).toUpperCase() : "";
  const mimePattern = filter.mimePattern ? safeRegExp(filter.mimePattern, "i") : null;
  if (mimePattern?.error) return mimePattern;

  const records = monitor.order
    .map(id => monitor.records.get(id))
    .filter((record): record is NetworkRecord => Boolean(record))
    .filter((record) => {
      if (pattern) pattern.lastIndex = 0;
      if (pattern && !pattern.test(record.url)) return false;
      if (mimePattern) mimePattern.lastIndex = 0;
      if (method && record.method !== method) return false;
      if (filter.status != null && record.status !== filter.status) return false;
      if (filter.failed != null && record.failed !== !!filter.failed) return false;
      if (filter.resourceType && record.resourceType !== filter.resourceType) return false;
      if (mimePattern && !mimePattern.test(record.mimeType || "")) return false;
      return true;
    });
  return { records };
}

function safeRegExp(pattern: string, flags = "i"): (RegExp & { error?: never }) | RegexError {
  try { return new RegExp(pattern, flags); }
  catch (err) {
    return {
      error: true,
      code: "INVALID_REGEX",
      message: err instanceof Error ? err.message : String(err),
      pattern,
      flags,
    };
  }
}

function notifyNetworkWaiters(monitor: NetworkMonitor) {
  for (const waiter of [...monitor.waiters]) waiter.check();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function getNetworkBody(tabId: number, requestId: string, maxBytes = DEFAULT_BODY_LIMIT, context: ToolContext = {}) {
  const raw = await sendCdp(tabId, "Network.getResponseBody", { requestId }, context);
  const bodyResult = raw && typeof raw === "object" ? raw as { body?: unknown; base64Encoded?: unknown } : {};
  const body = String(bodyResult.body ?? "");
  return {
    requestId,
    base64Encoded: !!bodyResult.base64Encoded,
    body: body.length > maxBytes ? body.slice(0, maxBytes) : body,
    truncated: body.length > maxBytes,
    size: body.length,
  };
}

registerTool({
  name: "read_console_messages",
  get description() { return toolT("readConsoleMessagesDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      reset: { type: "boolean", description: toolT("readConsoleMessagesReset") },
      limit: { type: "number", description: toolT("readConsoleMessagesLimit") },
      maxRecords: { type: "number", description: toolT("readConsoleMessagesMaxRecords") },
      level: { type: "string", enum: ["info", "warning", "error", "debug"], description: toolT("readConsoleMessagesLevel") },
      type: { type: "string", description: toolT("readConsoleMessagesType") },
      textPattern: { type: "string", description: toolT("readConsoleMessagesTextPattern") },
      urlPattern: { type: "string", description: toolT("readConsoleMessagesUrlPattern") },
      flags: { type: "string", description: toolT("readConsoleMessagesFlags") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, reset = false, limit = 50, maxRecords = DEFAULT_CONSOLE_LIMIT, ...filter }, _signal, context = {}) => {
    const monitor = await enableConsoleMonitor(tabId, { reset, maxRecords }, context);
    const filtered = filterConsoleRecords(monitor, filter);
    if (filtered.error) {
      return {
        error: `Invalid regular expression: ${filtered.message}`,
        code: filtered.code,
        details: { pattern: filtered.pattern, flags: filtered.flags },
      };
    }
    const guardrails = await getSecurityGuardrails();
    const rows = filtered.records
      .filter(record => !matchBlockedUrl(record.url, guardrails))
      .slice(-clampNumber(limit, 1, 200, 50))
      .reverse();
    return {
      watching: true,
      tabId: monitor.tabId,
      records: rows.length,
      totalBuffered: monitor.records.length,
      results: rows,
    };
  },
});

registerTool({
  name: "network_watch",
  get description() { return toolT("networkWatchDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      reset: { type: "boolean", description: toolT("networkWatchReset") },
      maxRecords: { type: "number", description: toolT("networkWatchMaxRecords") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, reset = true, maxRecords = DEFAULT_NETWORK_LIMIT }, _signal, context = {}) => {
    const monitor = await enableNetworkMonitor(tabId, { reset, maxRecords }, context);
    return {
      watching: true,
      tabId: monitor.tabId,
      maxRecords: monitor.maxRecords,
      records: monitor.order.length,
      inFlight: monitor.inFlight.size,
    };
  },
});

registerTool({
  name: "network_recent",
  get description() { return toolT("networkRecentDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      limit: { type: "number", description: toolT("networkRecentLimit") },
      urlPattern: { type: "string", description: toolT("networkRecentUrlPattern") },
      flags: { type: "string", description: toolT("networkRecentFlags") },
      method: { type: "string", description: toolT("networkRecentMethod") },
      status: { type: "number", description: toolT("networkRecentStatus") },
      failed: { type: "boolean", description: toolT("networkRecentFailed") },
      resourceType: { type: "string", description: toolT("networkRecentResourceType") },
      mimePattern: { type: "string", description: toolT("networkRecentMimePattern") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, limit = 20, ...filter }, _signal, context = {}) => {
    const monitor = await enableNetworkMonitor(tabId, { reset: false }, context);
    const filtered = filterNetworkRecords(monitor, filter);
    if (filtered.error) {
      return {
        error: `Invalid regular expression: ${filtered.message}`,
        code: filtered.code,
        details: { pattern: filtered.pattern, flags: filtered.flags },
      };
    }
    const guardrails = await getSecurityGuardrails();
    const rows = filtered.records
      .filter(record => !matchBlockedUrl(record.url, guardrails))
      .slice(-clampNumber(limit, 1, 100, 20))
      .reverse()
      .map(networkRecordSummary);
    return {
      tabId: monitor.tabId,
      records: rows.length,
      inFlight: monitor.inFlight.size,
      results: rows,
    };
  },
});

registerTool({
  name: "network_body",
  get description() { return toolT("networkBodyDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      requestId: { type: "string", description: "CDP requestId" },
      maxBytes: { type: "number", description: toolT("networkBodyMaxBytes") },
    },
    required: ["requestId"],
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, requestId, maxBytes = DEFAULT_BODY_LIMIT }, _signal, context = {}) => {
    const monitor = await enableNetworkMonitor(tabId, { reset: false }, context);
    const record = monitor.records.get(requestId);
    if (!record) {
      return {
        error: `Network request not found: ${requestId}`,
        code: "NETWORK_REQUEST_NOT_FOUND",
        details: { tabId: monitor.tabId, requestId },
      };
    }
    assertUrlAllowedBySecurityGuardrails(record.url, await getSecurityGuardrails(), { tool: "network_body", source: "request_url", tabId: monitor.tabId });
    const body = await getNetworkBody(monitor.tabId, requestId, clampNumber(maxBytes, 1000, 1000000, DEFAULT_BODY_LIMIT), context);
    return { ...networkRecordSummary(record), ...body };
  },
});

registerTool({
  name: "wait_for_response",
  get description() { return toolT("waitForResponseDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      urlPattern: { type: "string", description: toolT("waitForResponseUrlPattern") },
      flags: { type: "string", description: toolT("networkRecentFlags") },
      method: { type: "string", description: toolT("networkRecentMethod") },
      status: { type: "number", description: toolT("waitForResponseStatus") },
      mimePattern: { type: "string", description: toolT("waitForResponseMimePattern") },
      timeout: { type: "number", description: toolT("waitForResponseTimeout") },
      includeBody: { type: "boolean", description: toolT("waitForResponseIncludeBody") },
      maxBytes: { type: "number", description: toolT("waitForResponseMaxBytes") },
    },
    required: ["urlPattern"],
  } as const; },
  page: "owned",
  timeout: pageWaitTimeout,
  execute: async ({ tabId, timeout = 10, timeoutMs, includeBody = false, maxBytes = DEFAULT_BODY_LIMIT, ...filter }, signal, context = {}) => {
    const monitor = await enableNetworkMonitor(tabId, { reset: false }, context);
    const filtered = filterNetworkRecords(monitor, filter);
    if (filtered.error) {
      return {
        error: `Invalid regular expression: ${filtered.message}`,
        code: filtered.code,
        details: { pattern: filtered.pattern, flags: filtered.flags },
      };
    }

    const guardrails = await getSecurityGuardrails();
    const timeoutMsValue = clampNumber(timeoutMs != null ? timeoutMs : secondsToMs(timeout, 10000), 100, 120000, 10000);
    const bodyLimit = clampNumber(maxBytes, 1000, 1000000, DEFAULT_BODY_LIMIT);

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        monitor.waiters.delete(waiter);
      };
      const onAbort = () => {
        cleanup();
        reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting for network response", filter));
      };
      const finish = async (record: NetworkRecord) => {
        cleanup();
        const summary = networkRecordSummary(record);
        if (!includeBody) {
          resolve({ tabId: monitor.tabId, matched: true, response: summary });
          return;
        }
        try {
          const body = await getNetworkBody(monitor.tabId, record.requestId, bodyLimit, context);
          resolve({ tabId: monitor.tabId, matched: true, response: summary, body });
        } catch (err) {
          resolve({
            tabId: monitor.tabId,
            matched: true,
            response: summary,
            bodyError: {
              error: err instanceof Error ? err.message : String(err),
              code: err instanceof ToolExecutionError ? err.code : "NETWORK_BODY_UNAVAILABLE",
              details: err instanceof ToolExecutionError ? err.details : {},
            },
          });
        }
      };
      const waiter = {
        check: () => {
          const current = filterNetworkRecords(monitor, filter);
          if (current.error) return;
          const record = current.records.find(r => r.status != null && (!includeBody || r.finished) && !matchBlockedUrl(r.url, guardrails));
          if (record) finish(record);
        },
      };
      timer = setTimeout(() => {
        cleanup();
        resolve({
          tabId: monitor.tabId,
          matched: false,
          timedOut: true,
          timeoutSeconds: timeoutMsValue / 1000,
          inFlight: monitor.inFlight.size,
        });
      }, timeoutMsValue);
      signal?.addEventListener("abort", onAbort, { once: true });
      monitor.waiters.add(waiter);
      waiter.check();
    });
  },
});

registerTool({
  name: "wait_for_network_idle",
  get description() { return toolT("waitForNetworkIdleDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("readConsoleMessagesTabId") },
      idleSeconds: { type: "number", description: toolT("waitForNetworkIdleIdleSeconds") },
      timeout: { type: "number", description: toolT("waitForNetworkIdleTimeout") },
      urlPattern: { type: "string", description: toolT("waitForNetworkIdleUrlPattern") },
      flags: { type: "string", description: toolT("networkRecentFlags") },
    },
  } as const; },
  page: "owned",
  timeout: pageWaitTimeout,
  execute: async (args, signal, context = {}) => {
    const { tabId, idleSeconds = 0.8, idleMs, timeout = 10, timeoutMs, urlPattern, flags = "i" } = args as typeof args & { idleMs?: number };
    const monitor = await enableNetworkMonitor(tabId, { reset: false }, context);
    const pattern = urlPattern ? safeRegExp(urlPattern, flags) : null;
    if (pattern?.error) {
      return {
        error: `Invalid regular expression: ${pattern.message}`,
        code: pattern.code,
        details: { pattern: pattern.pattern, flags: pattern.flags },
      };
    }
    const idle = clampNumber(idleMs != null ? idleMs : secondsToMs(idleSeconds, 800), 100, 10000, 800);
    const timeoutMsValue = clampNumber(timeoutMs != null ? timeoutMs : secondsToMs(timeout, 10000), 100, 120000, 10000);

    const relevantInFlight = () => {
      const ids = [...monitor.inFlight];
      if (!pattern) return ids;
      return ids.filter(id => {
        const record = monitor.records.get(id);
        pattern.lastIndex = 0;
        return record && pattern.test(record.url);
      });
    };

    return new Promise((resolve, reject) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onAbort);
        monitor.waiters.delete(waiter);
      };
      const onAbort = () => {
        cleanup();
        reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting for network idle"));
      };
      const complete = () => {
        cleanup();
        resolve({ tabId: monitor.tabId, idle: true, idleSeconds: idle / 1000, inFlight: monitor.inFlight.size });
      };
      const scheduleIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(complete, idle);
      };
      const waiter = {
        check: () => {
          if (relevantInFlight().length === 0) scheduleIdle();
          else clearTimeout(idleTimer);
        },
      };
      timeoutTimer = setTimeout(() => {
        cleanup();
        resolve({
          tabId: monitor.tabId,
          idle: false,
          timedOut: true,
          timeoutSeconds: timeoutMsValue / 1000,
          inFlight: relevantInFlight(),
        });
      }, timeoutMsValue);
      signal?.addEventListener("abort", onAbort, { once: true });
      monitor.waiters.add(waiter);
      waiter.check();
    });
  },
});


  return Object.freeze({
    defaultNetworkLimit: DEFAULT_NETWORK_LIMIT,
    enablePreNavigationNetworkWatch,
    releaseRun(sessionId: string, runId: string) {
      for (const monitor of [...networkMonitors.values(), ...consoleMonitors.values()]) {
        if (monitor.sessionId === sessionId && monitor.runId === runId) monitor.enabled = false;
      }
    },
  });
}


export default ((host) => {
  const runtime = createDiagnosticsTools(host);
  return { enablePreNavigationNetworkWatch: runtime.enablePreNavigationNetworkWatch, releaseRun: runtime.releaseRun };
}) satisfies ToolExtension;

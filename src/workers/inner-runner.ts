import { safeValueForMessage, scriptValue, scriptToolArguments, installSecurityGuards, formatScriptErrorTrace } from "../shared/script-runtime.js";
import { createQzSdk } from "../shared/qz-script-sdk.js";
import type { FetchResult, InnerWorkerInput, InnerWorkerOutput, ScriptEnvelope, ScriptFailure, ToolBridgeResponse, TraceRow, WorkerExecute } from '../shared/contracts/inner-runner.js';

type ToolCall = { toolName: string; resolve(response: Extract<ToolBridgeResponse, {ok: true}>): void; reject(error: unknown): void };
type FetchCall = { resolve(response: FetchResult): void; reject(error: unknown): void; cleanup(): void };
type PushTrace = (level: string, items: unknown[]) => void;
const failure = (value: unknown): ScriptFailure => value instanceof Error ? value : Object.assign(new Error(String(value)), value && typeof value === 'object' ? value : {});
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
const send = (message: InnerWorkerOutput) => self.postMessage(message);
const pendingToolCalls = new Map<string, ToolCall>();
const pendingFetchCalls = new Map<string, FetchCall>();
const liveInnerTraces = new Map<string, TraceRow[]>();

self.onmessage = (event: MessageEvent<InnerWorkerInput>) => {
  const data = event.data || {};
  if (data.type === "trace_snapshot") {
    const requestId = String(data.requestId || "");
    const rows = liveInnerTraces.get(requestId) || [];
    send({ type: "trace_snapshot", requestId, trace: rows.slice(-5) });
    return;
  }
  if (data.type === "execute") {
    runInnerScript(data).catch((error) => {
      send({
        type: "result",
        result: makeEnvelope(false, null, error, [], [], Date.now()),
      });
    });
    return;
  }
  if (data.type === "tool_response") {
    const call = pendingToolCalls.get(String(data.callId || ""));
    if (!call) return;
    pendingToolCalls.delete(String(data.callId || ""));
    const response = data.response;
    if (!response) {
      call.reject(new Error("tools." + call.toolName + " returned empty bridge response"));
      return;
    }
    if (!response.ok) {
      const error: ScriptFailure = new Error(response.message || response.error || ("tools." + call.toolName + " bridge failed"));
      if (response.code) error.code = response.code;
      if (response.hint) error.hint = response.hint;
      if (response.details) error.details = response.details;
      call.reject(error);
      return;
    }
    call.resolve(response);
    return;
  }
  if (data.type === "fetch_response") {
    const call = pendingFetchCalls.get(String(data.callId || ""));
    if (!call) return;
    pendingFetchCalls.delete(String(data.callId || ""));
    call.cleanup?.();
    const response = data.response;
    if (!response?.ok) {
      const error: ScriptFailure = new TypeError(response?.error || "Skill fetch bridge failed");
      if (response?.code) error.code = response.code;
      if (response?.details) error.details = response.details;
      if (response?.diagnostic) error.diagnostic = response.diagnostic;
      call.reject(error);
      return;
    }
    call.resolve(response.result);
  }
};

async function runInnerScript(payload: WorkerExecute) {
  const startedAt = Date.now();
  const traceRows: TraceRow[] = [];
  const requestId = String(payload.requestId || "");
  if (requestId) liveInnerTraces.set(requestId, traceRows);
  const artifacts: unknown[] = [];
  const observations = new WeakMap<object, unknown>();
  const source = String(payload.source || "");
  const input = payload.scriptArgs;
  const args = input;
  const tabId = null;
  let seq = 0;
  let traceIndex = 0;

  function traceText(value: unknown) {
    try {
      if (typeof value === "string") return value;
      if (value instanceof Error) return formatScriptErrorTrace(value);
      if (value && typeof value === "object") return JSON.stringify(safeValueForMessage(value));
      return String(value);
    } catch (_err) {
      return "[unserializable]";
    }
  }

  function pushTrace(level: string, items: unknown[]) {
    const message = Array.from(items || []).map(traceText).join(" ");
    const row = {
      traceIndex: ++traceIndex,
      time: new Date().toISOString(),
      level: String(level || "trace"),
      message: message.length > 1000 ? message.slice(0, 1000) + "…[truncated]" : message,
    };
    traceRows.push(row);
    if (traceRows.length > 80) traceRows.splice(0, traceRows.length - 80);
    send({ type: "script_trace", row });
  }

  function trace(...items: unknown[]) { pushTrace("trace", items); }
  const log = trace;

  function addToolArtifacts(items: unknown) {
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    for (const item of list) {
      if (item && typeof item === "object") artifacts.push(item);
    }
  }

  function callTool(name: string, args: unknown = {}) {
    const toolName = String(name || "").trim();
    if (!toolName) throw new Error("tools call requires a tool name");
    const toolArgs: Record<string, unknown> = isRecord(args) && !Array.isArray(args) ? { ...args } : {};
    const safeToolArgs = scriptToolArguments(toolName, toolArgs);
    const callId = "inner_tool_" + Date.now() + "_" + (++seq);
    send({
      type: "tool_call",
      callId,
      toolName,
      args: safeToolArgs,
    });
    return new Promise<unknown>((resolve, reject) => {
      pendingToolCalls.set(callId, {
        toolName,
        resolve(response) {
          addToolArtifacts(response.artifacts || response.artifact);
          // Modern scripts receive business values; legacy callers retain the declared receipt.
          const result = payload.strictResult && response.resultFormat === "receipt" && isRecord(response.result)
            ? response.result.result : response.result;
          if (result && typeof result === "object" && response.observation) {
            observations.set(result, response.observation);
          }
          resolve(result);
        },
        reject,
      });
    });
  }

  const tool = callTool;
  const qz = createQzSdk(callTool);
  const tools = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toStringTag) return "RunScriptInnerTools";
      if (prop === "$call") return callTool;
      if (typeof prop !== "string") return undefined;
      return (args = {}) => callTool(prop, args);
    },
  });

  const originalFetch = self.fetch;
  if (payload.fetchBridge === true) self.fetch = createBridgedFetch(() => ++seq);
  const restoreConsole = patchConsole(pushTrace);
  const restoreSecurity = installSecurityGuards(payload.securityGuardrails || {});
  try {
    const fn = new Function("input", "args", "$plugin", "tools", "tool", "trace", "log", "tabId", "qz", "\"use strict\"; return (async () => {\n" + source + "\n})();");
    const result = await fn(input, args, isRecord(input) ? input.$plugin || {} : {}, tools, tool, trace, log, tabId, qz);
    const value = payload.strictResult ? scriptValue(result) : result;
    const returnedObservations: unknown[] = [];
    const visited = new Set<object>();
    const collectObservations = (item: unknown) => {
      if (!item || typeof item !== "object" || visited.has(item)) return;
      visited.add(item);
      const observation = observations.get(item);
      if (observation) returnedObservations.push(observation);
      // Legacy Skill values can contain inaccessible properties; optional image discovery must not change their result.
      try { for (const child of Object.values(item)) collectObservations(child); } catch { /* No readable child observations. */ }
    };
    collectObservations(result);
    send({
      type: "result",
      result: { ...makeEnvelope(true, value, null, traceRows, artifacts, startedAt, payload.strictResult),
        ...(returnedObservations.length ? { observations: scriptValue(returnedObservations) } : {}) },
    });
  } catch (error) {
    decorateSyntaxError(error, source);
    if (error instanceof SyntaxError) {
      pushTrace("source.preview", [summarizeSourceForError(source)]);
      const hints = findSuspiciousSourceTokens(source);
      if (hints.length) pushTrace("source.hints", [hints]);
    }
    pushTrace("error", [error]);
    send({
      type: "result",
      result: makeEnvelope(false, null, error, traceRows, artifacts, startedAt),
    });
  } finally {
    if (requestId) liveInnerTraces.delete(requestId);
    restoreSecurity();
    if (payload.fetchBridge === true) self.fetch = originalFetch;
    restoreConsole();
  }
}

function createBridgedFetch(nextSequence: () => number): typeof fetch {
  return async function fetch(input: RequestInfo | URL, init?: RequestInit) {
    const serialized = await serializeFetchRequest(input, init);
    const request = serialized.request;
    const signal = serialized.signal;
    if (signal?.aborted) throw makeFetchAbortError();
    const callId = "inner_fetch_" + Date.now() + "_" + nextSequence();
    const result = await new Promise<FetchResult>((resolve, reject) => {
      const abort = () => {
        const call = pendingFetchCalls.get(callId);
        if (!call) return;
        pendingFetchCalls.delete(callId);
        call.cleanup?.();
        send({ type: "fetch_cancel", callId });
        reject(makeFetchAbortError());
      };
      const cleanup = () => signal?.removeEventListener?.("abort", abort);
      pendingFetchCalls.set(callId, { resolve, reject, cleanup });
      signal?.addEventListener?.("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      send({ type: "fetch_call", callId, request });
    });
    const bytes = base64ToBytes(result?.bodyBase64 || "");
    const status = Number(result?.status || 0);
    const body = status === 204 || status === 205 || status === 304 ? null : bytes;
    const response = new Response(body, {
      status,
      statusText: String(result?.statusText || ""),
      headers: Array.isArray(result?.headers) ? result.headers : [],
    });
    try { Object.defineProperty(response, "url", { value: String(result?.url || request.url) }); } catch (_err) {}
    try { Object.defineProperty(response, "redirected", { value: result?.redirected === true }); } catch (_err) {}
    return response;
  };
}

async function serializeFetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  const explicitHeaders = headerPairs(init?.headers !== undefined
    ? init.headers
    : (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
  const request = new Request(input, init);
  const headers = new Map<string, string>();
  request.headers.forEach((value, name) => headers.set(String(name).toLowerCase(), String(value)));
  for (const [name, value] of explicitHeaders) headers.set(name, value);
  let bodyBase64 = "";
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    if (bytes.byteLength) bodyBase64 = bytesToBase64(bytes);
  }
  return {
    signal: request.signal,
    request: {
      url: request.url,
      method: request.method.toUpperCase(),
      headers: Array.from(headers.entries()),
      bodyBase64,
    },
  };
}

function makeFetchAbortError() {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch (_err) {
    const error: ScriptFailure = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

function headerPairs(value: HeadersInit | undefined): [string, string][] {
  if (!value) return [];
  const out: [string, string][] = [];
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    value.forEach((headerValue, name) => out.push([String(name).toLowerCase(), String(headerValue)]));
    return out;
  }
  if (Array.isArray(value)) {
    for (const row of value) {
      if (Array.isArray(row) && row.length >= 2) out.push([String(row[0]).toLowerCase(), String(row[1])]);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [name, headerValue] of Object.entries(value)) out.push([String(name).toLowerCase(), String(headerValue)]);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decorateSyntaxError(error: unknown, source: string) {
  if (!(error instanceof SyntaxError)) return;
  const annotated: ScriptFailure = error;
  annotated.code = "SCRIPT_SYNTAX_ERROR";
  const hints = findSuspiciousSourceTokens(source);
  annotated.details = {
    sourcePreview: summarizeSourceForError(source),
    suspiciousTokens: hints,
  };
}

function summarizeSourceForError(source: string) {
  const text = String(source || "");
  const singleLine = text
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return singleLine.length > 500 ? singleLine.slice(0, 500) + "…[truncated]" : singleLine;
}

function findSuspiciousSourceTokens(source: string) {
  const text = String(source || "");
  const hints = [];
  const known = [
    ["“", "curly_open_quote"],
    ["”", "curly_close_quote"],
    ["‘", "curly_open_single_quote"],
    ["’", "curly_close_single_quote"],
    ["；", "fullwidth_semicolon"],
    ["，", "fullwidth_comma"],
    ["：", "fullwidth_colon"],
  ];
  for (const [token, name] of known) {
    const index = text.indexOf(token);
    if (index >= 0) hints.push({ token, name, index });
  }
  const rawNewline = findRawNewlineInQuotedString(text);
  if (rawNewline >= 0) hints.push({ token: "\n", name: "raw_newline_in_string", index: rawNewline });
  return hints.slice(0, 8);
}

function findRawNewlineInQuotedString(text: string) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      else if (ch === "\n" || ch === "\r") return i;
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
    }
  }
  return -1;
}

function makeEnvelope(ok: boolean, result: unknown, thrown: unknown, traceRows: TraceRow[], artifacts: unknown[], startedAt: number, strictResult = false): ScriptEnvelope {
  const error = thrown == null ? null : failure(thrown);
  const safeResult = ok && result !== undefined ? strictResult ? scriptValue(result) : safeValueForMessage(result) : null;
  const out: ScriptEnvelope = {
    __runScriptEnvelope: true,
    ok,
    hasResult: ok && result !== undefined,
    result: safeResult,
    resultType: ok ? (result === null ? "null" : Array.isArray(result) ? "array" : typeof result) : "error",
    engine: "offscreen_inner",
    execution_world: "inner",
    reason: "inner",
    trace: safeValueForMessage(Array.isArray(traceRows) ? traceRows.slice() : []),
    elapsedMs: Date.now() - startedAt,
  };
  if (!ok) {
    out.error = error?.message || String(error || "Script evaluation failed");
    out.code = error?.code || "SCRIPT_EVALUATION_FAILED";
    if (error?.hint) out.hint = error.hint;
    out.details = safeValueForMessage(error?.details && typeof error.details === "object" ? error.details : {});
    if (error?.diagnostic && typeof error.diagnostic === "object") out.diagnostic = safeValueForMessage(error.diagnostic);
  } else if (result === undefined) {
    out.message = "Script completed successfully but returned undefined. Put an expression at the end or use return to inspect a value.";
  }
  if (Array.isArray(artifacts) && artifacts.length) out.artifacts = safeValueForMessage(artifacts.slice());
  return out;
}

function patchConsole(pushTrace: PushTrace) {
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = new Map<typeof levels[number], (...items: unknown[]) => void>();
  for (const level of levels) {
    try {
      const method = console[level];
      original.set(level, method);
      console[level] = (...items: unknown[]) => { pushTrace('console.' + level, items); return method.apply(console, items); };
    } catch (_err) {}
  }
  return () => { for (const [level, method] of original) { try { console[level] = method; } catch (_err) {} } };
}


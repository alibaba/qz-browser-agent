interface BridgeConfig {
  enabled: boolean; endpoint: string; clientId: string;
  pollIntervalMs: number; pollTimeoutMs: number; requestTimeoutMs: number;
  maxBatch: number; includeCapabilities: boolean;
}
interface BridgeDependencies {
  dispatch?: (request: { id: string; method: string; params: Record<string, unknown>; raw: Record<string, unknown> }) => unknown | Promise<unknown>;
  describe?: () => unknown | Promise<unknown>;
  trace?: (message: string) => void;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
// Only recovery metadata with known owners crosses the bridge; provider/request details may contain credentials.
function errorDetails(error: unknown) {
  const value = record(error), details = record(value.details);
  const keys = value.code === "DOWNLOAD_INTERRUPTED" ? ["downloadId", "filename", "reason"]
    : value.code === "SKILL_NOT_FOUND" ? ["name"] : value.code === "SKILL_RESOURCE_NOT_FOUND" ? ["name", "path"] : [];
  return Object.fromEntries(keys.filter(key => typeof details[key] === "string" || typeof details[key] === "number")
    .map(key => [key, details[key]]));
}

const BRIDGE_STORAGE_KEY = "_qingzhou_mcp_bridge";
const BRIDGE_CLIENT_ID_KEY = "_qingzhou_mcp_bridge_client_id";
const BRIDGE_PROTOCOL_VERSION = 1;
const DEFAULT_ENDPOINT = "http://127.0.0.1:18765";
const DEFAULT_POLL_INTERVAL_MS = 750;
// Leave headroom below Chrome's 30-second service-worker fetch deadline.
const DEFAULT_POLL_TIMEOUT_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BATCH = 4;
const STATUS_TRACE_MIN_INTERVAL_MS = 60000;
const MAX_POLL_FAILURES = 3;
const RECONNECT_ALARM = "qingzhou-mcp-bridge-reconnect";
let clientIdentity: Promise<string> | undefined;

export function qingzhouMcpBridgeStorageKey() {
  return BRIDGE_STORAGE_KEY;
}

export async function getQingzhouMcpBridgeConfig() {
  const [data, clientId] = await Promise.all([
    chrome.storage.local.get(BRIDGE_STORAGE_KEY),
    getDefaultClientId(),
  ]);
  const raw = record(data?.[BRIDGE_STORAGE_KEY]);
  return normalizeBridgeConfig({ ...raw, clientId: String(raw.clientId || "").trim() || clientId });
}

function getDefaultClientId(): Promise<string> {
  return clientIdentity ??= (async () => {
    const data = await chrome.storage.local.get(BRIDGE_CLIENT_ID_KEY);
    const saved = data?.[BRIDGE_CLIENT_ID_KEY];
    if (typeof saved === "string" && saved.trim()) return saved.trim();
    const clientId = `qingzhou-${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [BRIDGE_CLIENT_ID_KEY]: clientId });
    return clientId;
  })().catch(error => { clientIdentity = undefined; throw error; });
}

export async function saveQingzhouMcpBridgeConfig(patch: Partial<BridgeConfig> = {}) {
  const current = await getQingzhouMcpBridgeConfig();
  const clientId = String(patch?.clientId ?? current.clientId).trim() || await getDefaultClientId();
  const next = normalizeBridgeConfig({ ...current, ...(patch || {}), clientId });
  await chrome.storage.local.set({ [BRIDGE_STORAGE_KEY]: next });
  return next;
}

export function startQingzhouMcpBridge(dependencies: BridgeDependencies = {}) {
  const runtime = new QingzhouMcpBridgeRuntime(dependencies);
  runtime.start();
  return runtime;
}

class QingzhouMcpBridgeRuntime {
  config = normalizeBridgeConfig();
  timer: ReturnType<typeof setTimeout> | null = null;
  started = false;
  generation = 0;
  inFlight = false;
  pollController: AbortController | null = null;
  activeRequests = new Map<string, Promise<void>>();
  failureCount = 0;
  storageListener: ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) | null = null;
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  private reconnectAlarmEnabled = false;
  private alarmRevision = 0;
  private alarmUpdate: Promise<void> = Promise.resolve();
  connected = false;
  lastStatusTraceAt = 0;
  lastStatusTraceKey = "";
  private configReadRevision = 0;
  private trace: (message: string) => void;
  constructor(private readonly dependencies: BridgeDependencies = {}) {
    this.trace = dependencies.trace || defaultTrace;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.failureCount = 0;
    this.storageListener = (changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes?.[BRIDGE_STORAGE_KEY]) return;
      this.refreshConfig()
        .catch((err) => this.trace(`[mcp-bridge] config refresh failed: ${err?.message || err}`));
    };
    chrome.storage?.onChanged?.addListener?.(this.storageListener);
    this.alarmListener = alarm => {
      if (alarm.name !== RECONNECT_ALARM || !this.started || !this.config.enabled
        || this.connected || this.failureCount < MAX_POLL_FAILURES) return;
      // The alarm survives a worker restart; only a previously connected profile has one.
      this.reconnectAlarmEnabled = true;
      this.resumePolling(MAX_POLL_FAILURES - 1);
    };
    chrome.alarms?.onAlarm?.addListener?.(this.alarmListener);
    this.refreshConfig()
      .catch((err) => this.trace(`[mcp-bridge] config load failed: ${err?.message || err}`));
    return this;
  }

  stop() {
    this.generation += 1;
    this.configReadRevision += 1;
    this.started = false;
    this.connected = false;
    this.pollController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.storageListener) chrome.storage?.onChanged?.removeListener?.(this.storageListener);
    this.storageListener = null;
    if (this.alarmListener) chrome.alarms?.onAlarm?.removeListener?.(this.alarmListener);
    this.alarmListener = null;
    this.updateReconnectAlarm(false);
  }

  private async refreshConfig() {
    const revision = ++this.configReadRevision;
    const isCurrent = () => this.started && revision === this.configReadRevision;
    try {
      const config = await getQingzhouMcpBridgeConfig();
      if (!isCurrent()) return false;
      this.applyConfig(config);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      throw error;
    }
  }

  applyConfig(config: unknown) {
    const next = normalizeBridgeConfig(config);
    if (Object.entries(next).every(([key, value]) => this.config[key as keyof BridgeConfig] === value)) {
      // Unrelated model writes must not discard commands already dequeued by a poll.
      if (!this.inFlight && !this.timer) this.schedulePoll(0);
      return;
    }
    this.generation += 1;
    this.pollController?.abort();
    const previousKey = this.configKey();
    const wasEnabled = this.config.enabled === true;
    this.config = next;
    this.failureCount = 0;
    const nextKey = this.configKey();
    if (!this.config.enabled) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.connected = false;
      this.updateReconnectAlarm(false);
      if (wasEnabled) {
        this.traceStatus("disabled", "[mcp-bridge] disabled", { force: true });
      }
      return;
    }
    this.connected = false;
    this.traceStatus(
      `enabled:${nextKey}`,
      `[mcp-bridge] enabled; polling ${this.config.endpoint} client=${this.config.clientId}`,
      { force: previousKey !== nextKey },
    );
    this.schedulePoll(0);
  }

  /** A verified local connection page explicitly resumes an idle connection. */
  wake() {
    this.resumePolling(0);
  }

  private resumePolling(failureCount: number) {
    if (!this.started) return;
    this.failureCount = failureCount;
    void this.refreshConfig().then(current => {
      if (current && !this.inFlight) this.schedulePoll(0);
    }).catch(error => this.trace(`[mcp-bridge] config wake failed: ${errorMessage(error)}`));
  }

  schedulePoll(delayMs: number) {
    if (!this.started || !this.config.enabled || this.failureCount >= MAX_POLL_FAILURES) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.floor(Number(delayMs) || 0));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delay);
  }

  async pollOnce() {
    if (!this.config.enabled || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    const config = this.config;
    const controller = new AbortController();
    this.pollController = controller;
    let supersededConfig = false;
    try {
      // Reconcile permission/config changes at each network boundary, including after a worker wake.
      if (!(await this.refreshConfig())) {
        supersededConfig = true;
        return;
      }
      if (generation !== this.generation || !this.started) return;
      const payload = await this.buildPollPayload();
      if (generation !== this.generation || !this.started) return;
      const response = await postJson(config.endpoint, "/v1/qingzhou/poll", payload, config.pollTimeoutMs + 5000, controller);
      if (generation !== this.generation || !this.started) return;
      if (!Array.isArray(response.requests)) throw new Error("Invalid bridge poll response: requests must be an array");
      this.failureCount = 0;
      this.updateReconnectAlarm(true);
      if (!this.connected) {
        this.connected = true;
        this.traceStatus(
          `connected:${this.configKey()}`,
          `[mcp-bridge] connected ${this.config.endpoint} client=${this.config.clientId}`,
          { force: true },
        );
      }
      const requests = Array.isArray(response?.requests) ? response.requests.slice(0, this.config.maxBatch) : [];
      for (const request of requests) this.startRequest(request, config);
      this.schedulePoll(requests.length ? 0 : this.config.pollIntervalMs);
    } catch (error) {
      if (generation === this.generation && this.started) {
        this.handlePollFailure(error);
        this.schedulePoll(this.nextDelayMs());
      }
    } finally {
      this.inFlight = false;
      this.pollController = null;
      if ((supersededConfig || generation !== this.generation) && this.started) this.schedulePoll(0);
    }
  }

  async buildPollPayload() {
    const client: Record<string, unknown> = {
      id: this.config.clientId || defaultClientId(),
      extensionId: chrome.runtime?.id || "",
      name: "qingzhou",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      pollTimeoutMs: this.config.pollTimeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
      maxBatch: this.config.maxBatch,
      connectedAt: Date.now(),
    };
    if (this.dependencies.describe && this.config.includeCapabilities) {
      try {
        client.capabilities = await Promise.resolve(this.dependencies.describe());
      } catch (err) {
        client.capabilityError = errorMessage(err);
      }
    }
    return { client };
  }

  startRequest(value: unknown, config = this.config) {
    const request = record(value);
    const requestId = String(request.id || "");
    if (!requestId || this.activeRequests.has(requestId)) return;
    const task = this.handleRequest(request, config)
      .catch((err) => {
        this.trace(`[mcp-bridge] request ${requestId} failed to report result: ${normalizeTraceError(err)}`);
      })
      .finally(() => {
        this.activeRequests.delete(requestId);
      });
    this.activeRequests.set(requestId, task);
  }

  async handleRequest(request: Record<string, unknown>, config = this.config) {
    const requestId = String(request.id || "");
    if (!requestId) return;
    const startedAt = Date.now();
    try {
      if (!this.dependencies.dispatch) throw new Error("Qingzhou MCP bridge dispatcher is unavailable");
      const result = await withTimeout(
        Promise.resolve(this.dependencies.dispatch({
          id: requestId,
          method: String(request.method || ""),
          params: record(request.params),
          raw: request,
        })),
        normalizePositiveInteger(request.timeoutMs, config.requestTimeoutMs, 1000, 10 * 60 * 1000),
      );
      await this.postResult({
        requestId,
        ok: true,
        result: toJsonValue(result),
        durationMs: Date.now() - startedAt,
      }, config);
    } catch (err) {
      await this.postResult({
        requestId,
        ok: false,
        error: errorMessage(err),
        code: record(err).code || "",
        details: errorDetails(err),
        durationMs: Date.now() - startedAt,
      }, config);
    }
  }

  async postResult(payload: Record<string, unknown>, config: BridgeConfig) {
    await postJson(
      config.endpoint,
      "/v1/qingzhou/result",
      {
        clientId: config.clientId || defaultClientId(),
        ...payload,
      },
      15000,
    );
  }

  nextDelayMs() {
    const base = Math.max(this.config.pollIntervalMs, 1000);
    const delay = base * Math.max(1, 2 ** Math.min(this.failureCount, 4));
    return Math.min(15000, delay);
  }

  private updateReconnectAlarm(enabled: boolean) {
    if (enabled && this.reconnectAlarmEnabled) return;
    this.reconnectAlarmEnabled = enabled;
    if (!chrome.alarms?.create || !chrome.alarms?.clear) return;
    const revision = ++this.alarmRevision;
    // Serialize alarm writes so disabling/stopping also revokes an unfinished create.
    this.alarmUpdate = this.alarmUpdate.then(async () => {
      if (this.started && this.config.enabled && this.reconnectAlarmEnabled) {
        await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
      } else {
        await chrome.alarms.clear(RECONNECT_ALARM);
      }
    }).catch(error => {
      if (revision === this.alarmRevision) this.reconnectAlarmEnabled = false;
      this.traceStatus("reconnect-alarm-failed", `[mcp-bridge] reconnect alarm failed: ${normalizeTraceError(error)}`);
    });
  }

  handlePollFailure(err: unknown) {
    this.failureCount += 1;
    this.connected = false;
    const message = normalizeTraceError(err);
    this.traceStatus(
      `failed:${this.configKey()}:${message}`,
      `[mcp-bridge] local bridge unavailable (${message}); ${this.failureCount >= MAX_POLL_FAILURES ? "polls paused; qz connect resumes immediately" : "reconnecting"}`,
      { force: this.failureCount === MAX_POLL_FAILURES },
    );
  }

  configKey() {
    return `${this.config.enabled ? 1 : 0}|${this.config.endpoint}|${this.config.clientId}`;
  }

  traceStatus(key: string, message: string, { force = false } = {}) {
    const now = Date.now();
    const changed = key !== this.lastStatusTraceKey;
    if (!force && !changed && now - this.lastStatusTraceAt < STATUS_TRACE_MIN_INTERVAL_MS) return;
    this.lastStatusTraceKey = key;
    this.lastStatusTraceAt = now;
    this.trace(message);
  }
}

function normalizeBridgeConfig(value: unknown = {}): BridgeConfig {
  const raw = record(value);
  return {
    enabled: raw.enabled !== false,
    endpoint: normalizeEndpoint(raw.endpoint || DEFAULT_ENDPOINT),
    clientId: String(raw.clientId || defaultClientId()).trim().slice(0, 120),
    pollIntervalMs: normalizePositiveInteger(raw.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 100, 60000),
    pollTimeoutMs: normalizePositiveInteger(raw.pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS, 1000, DEFAULT_POLL_TIMEOUT_MS),
    requestTimeoutMs: normalizePositiveInteger(raw.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1000, 10 * 60 * 1000),
    maxBatch: normalizePositiveInteger(raw.maxBatch, DEFAULT_MAX_BATCH, 1, 16),
    includeCapabilities: raw.includeCapabilities !== false,
  };
}

function normalizeEndpoint(value: unknown) {
  const text = String(value || DEFAULT_ENDPOINT).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(text)) return DEFAULT_ENDPOINT;
  return text;
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function normalizeTraceError(err: unknown) {
  const text = errorMessage(err || "unknown error").replace(/\s+/g, " ").trim();
  if (!text) return "unknown error";
  if (/failed to fetch|networkerror|load failed/i.test(text)) return "fetch failed";
  if (/aborted|aborterror/i.test(text)) return "request aborted";
  if (/timed out|timeout/i.test(text)) return "timeout";
  return text.slice(0, 180);
}

function defaultClientId() {
  const id = String(chrome.runtime?.id || "extension").replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `qingzhou-${id || "extension"}`;
}

async function postJson(endpoint: string, path: string, body: unknown, timeoutMs: number, controller = new AbortController()): Promise<Record<string, unknown>> {
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    try {
      const result = JSON.parse(text) as unknown;
      if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("Expected a JSON object");
      return result as Record<string, unknown>;
    } catch (_err) {
      throw new Error(`Invalid bridge JSON: ${text.slice(0, 240)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Qingzhou MCP bridge request timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toJsonValue(value: unknown): unknown {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return String(value);
  }
}

function defaultTrace(message: string) {
  console.debug("[轻舟]", message);
}

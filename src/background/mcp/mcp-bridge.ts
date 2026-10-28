import type { CliConnectionInput, CliConnectionStatus } from "../../shared/mcp-connection.js";
import { RECONNECT_ALARM } from "../../shared/reconnect-alarm.js";
import {
  BRIDGE_STORAGE_KEY, RETRY_LIMIT, LEASE_WAIT_LIMIT, RETRY_DELAY_MS, connectionEndpoint, connectionName, connectionStatus,
  getConnectionConfig, updateConnectionConfig,
} from "./connection-store.js";
import type { BridgeConfig } from "./connection-store.js";

interface BridgeDependencies {
  dispatch?: (request: { id: string; method: string; params: Record<string, unknown>; raw: Record<string, unknown>; signal: AbortSignal }) => unknown | Promise<unknown>;
  describe?: () => unknown | Promise<unknown>;
  assertConsent?: () => void;
  onStatus?: (status: CliConnectionStatus) => void;
  trace?: (message: string) => void;
  fetch?: typeof fetch;
}
export { RECONNECT_ALARM };
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const cancelled = () => failure("MCP_CONNECTION_CANCELLED", "The connection was cancelled.");
const permanent = new Set(["MCP_CONNECTION_INCOMPATIBLE", "MCP_CONNECTION_PAGE_CHANGED", "DATA_CONSENT_REQUIRED", "BRIDGE_NAME_INVALID", "BRIDGE_NAME_IN_USE", "BRIDGE_PAIRING_REQUIRED", "BRIDGE_PAIRING_INVALID"]);
const BLOCKED_WAKE_RESUME = new Set([...permanent, "BRIDGE_CLIENT_IN_USE"]);
interface FirefoxMcpWakeHandlers {
  noteEnabled?(enabled: boolean): void;
  onAlarm?(): void;
  onSuspend?(): void;
}
interface FirefoxMcpWakeChrome {
  qzFirefoxMcpWake?: boolean;
  qzFirefoxMcpWakePending?: boolean;
  qzFirefoxMcpWakeHandlers?: FirefoxMcpWakeHandlers;
}
function firefoxWakeChrome(): FirefoxMcpWakeChrome | undefined {
  const host = (globalThis as { chrome?: FirefoxMcpWakeChrome }).chrome;
  return host?.qzFirefoxMcpWake === true ? host : undefined;
}
const upgradeGuidance = "Wait for running tasks to finish, then run npx --yes qz-browser-agent@latest stop (disconnects ALL browsers). Update/reload the extension in each browser and run npx --yes qz-browser-agent@latest connect. Reconnect other browsers from Settings.";
const newPairingToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function qingzhouMcpBridgeStorageKey() { return BRIDGE_STORAGE_KEY; }
/** Management callers receive public configuration, never pairing credentials. */
export async function getQingzhouMcpBridgeConfig() {
  const config = await getConnectionConfig();
  const { pairingToken: _token, instanceId: _instance, authorizationId: _authorization, connectionId: _connection, ...visible } = config;
  return visible;
}
export async function getQingzhouMcpConnectionStatus() { return connectionStatus(await getConnectionConfig()); }

/** Configuration updates cannot authorize a connection; Connect owns that operation. */
export async function saveQingzhouMcpBridgeConfig(value: unknown = {}) {
  const patch = record(value);
  await updateConnectionConfig(current => ({
    ...current,
    ...(typeof patch.name === "string" ? { name: connectionName(patch.name) } : {}),
    ...(patch.endpoint !== undefined ? { endpoint: connectionEndpoint(patch.endpoint) } : {}),
    ...(patch.enabled === false ? { enabled: false, state: "disconnected", authorizationId: "" } : {}),
  }));
  return getQingzhouMcpBridgeConfig();
}

export function startQingzhouMcpBridge(dependencies: BridgeDependencies = {}) {
  return new QingzhouMcpBridgeRuntime(dependencies).start();
}

class QingzhouMcpBridgeRuntime {
  private config: BridgeConfig | undefined;
  private started = false;
  private generation = 0;
  private authorizationId = "";
  private connectionId: string = crypto.randomUUID();
  private paired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private flight: Promise<void> | undefined;
  private nameChanges: Promise<void> = Promise.resolve();
  private nameRevision = 0;
  private initial: Promise<void> = Promise.resolve();
  private alarmUpdate: Promise<unknown> = Promise.resolve();
  private requests = new Map<string, Promise<void>>();
  private storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !changes[BRIDGE_STORAGE_KEY] || !this.started) return;
    const next = record(changes[BRIDGE_STORAGE_KEY].newValue);
    if (this.config && (next.enabled !== this.config.enabled || next.authorizationId !== this.authorizationId
      || next.endpoint !== this.config.endpoint || next.name !== this.config.name)) {
      this.revoke();
      const generation = this.generation;
      void this.restore(generation);
    }
  };
  private alarmListener = (alarm: chrome.alarms.Alarm) => {
    if (alarm.name === RECONNECT_ALARM && this.started) void this.attempt();
  };

  constructor(private readonly deps: BridgeDependencies) {}
  start() {
    if (this.started) return this;
    this.started = true;
    this.bindFirefoxWake();
    chrome.storage.onChanged.addListener(this.storageListener);
    chrome.alarms?.onAlarm?.addListener(this.alarmListener);
    this.initial = this.restore(this.generation).catch(() => {
      this.deps.trace?.("[mcp-bridge] local connection settings could not be loaded");
    });
    return this;
  }
  /** Disposes this worker instance without deleting durable authorization or resetting retries. */
  stop() {
    if (!this.started) return;
    this.started = false;
    this.revoke();
    chrome.storage.onChanged.removeListener(this.storageListener);
    chrome.alarms?.onAlarm?.removeListener(this.alarmListener);
    this.noteFirefoxWake();
  }
  private bindFirefoxWake() {
    const host = firefoxWakeChrome();
    if (!host) return;
    const handlers = host.qzFirefoxMcpWakeHandlers ??= {};
    handlers.onAlarm = () => { if (this.started) void this.attempt(); };
    handlers.onSuspend = () => { void this.flushLease(); };
  }
  private noteFirefoxWake() {
    const host = firefoxWakeChrome();
    if (!host) return;
    const enabled = Boolean(this.started && this.config?.enabled && this.config.state !== "paused");
    host.qzFirefoxMcpWakeHandlers?.noteEnabled?.(enabled);
  }
  private adoptLease(config: BridgeConfig) {
    if (firefoxWakeChrome() && config.connectionId) this.connectionId = config.connectionId;
  }
  private leaseFields(): Partial<BridgeConfig> {
    return firefoxWakeChrome() ? { connectionId: this.connectionId } : {};
  }
  private shouldResumeAfterSleep(config: BridgeConfig): boolean {
    if (!firefoxWakeChrome() || !config.enabled) return false;
    if (BLOCKED_WAKE_RESUME.has(config.lastError?.code || "")) return false;
    return config.state === "paused" || config.attemptsRemaining <= 0;
  }
  private consumeWakePending() {
    const host = firefoxWakeChrome();
    if (!host?.qzFirefoxMcpWakePending) return;
    host.qzFirefoxMcpWakePending = false;
    if (this.started && this.config?.enabled && this.config.state !== "paused") void this.attempt();
  }
  private flushLease() {
    if (!firefoxWakeChrome() || !this.started || !this.config?.enabled) return;
    const connectionId = this.connectionId;
    const authorizationId = this.authorizationId;
    void updateConnectionConfig(current => {
      if (!current.enabled || current.authorizationId !== authorizationId || current.connectionId === connectionId) return null;
      return { ...current, connectionId };
    }).catch(() => {});
  }
  private revoke() {
    this.generation++;
    this.nameRevision = 0;
    this.controller.abort(cancelled());
    this.controller = new AbortController();
    this.paired = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private current(generation: number) { return this.started && generation === this.generation && !this.controller.signal.aborted; }
  private check(generation: number) {
    if (!this.current(generation)) throw cancelled();
    this.deps.assertConsent?.();
  }
  private async restore(generation: number) {
    let config = await getConnectionConfig();
    if (!this.current(generation)) return;
    this.adoptLease(config);
    this.config = config;
    this.authorizationId = config.authorizationId;
    if (this.shouldResumeAfterSleep(config)) {
      config = await this.persist(generation, {
        state: config.connectedAt ? "reconnecting" : "connecting",
        attemptsRemaining: RETRY_LIMIT,
        ...(config.lastError ? { lastError: config.lastError } : {}),
      });
    } else if (config.enabled && config.attemptsRemaining <= 0 && config.state !== "paused") {
      config = await this.persist(generation, { state: "paused", lastError: config.lastError || {
        code: "MCP_CONNECTION_UNAVAILABLE", message: "Connection attempts are paused. Run qz connect or click Connect to retry.",
      } });
    }
    this.emit();
    if (config.enabled && config.state !== "paused" && config.attemptsRemaining > 0) {
      this.schedule(Math.max(0, config.nextRetryAt - Date.now()));
    } else {
      await this.setAlarm(false);
    }
    this.consumeWakePending();
  }
  async status(): Promise<CliConnectionStatus> {
    await this.initial;
    const config = await getConnectionConfig();
    // Persisted connected is not proof that a newly restarted worker has a live lease yet.
    return connectionStatus(!this.paired && config.state === "connected" ? { ...config, state: "reconnecting" } : config);
  }
  async connect(input: CliConnectionInput = {}, assertCurrent: () => void | Promise<void> = () => {}) {
    this.deps.assertConsent?.();
    const requestedEndpoint = input.endpoint === undefined ? undefined : connectionEndpoint(input.endpoint);
    const name = input.name === undefined ? undefined : connectionName(input.name);
    if (this.paired && this.config?.enabled && this.config.state === "connected"
      && (requestedEndpoint === undefined || requestedEndpoint === this.config.endpoint)) {
      return this.renameCurrent(name, assertCurrent);
    }
    let prior: BridgeConfig | undefined;
    const oldConnectionId = this.connectionId;
    this.revoke();
    const generation = this.generation;
    const previous = this.flight;
    this.authorizationId = crypto.randomUUID();
    this.connectionId = crypto.randomUUID();
    const authorizationId = this.authorizationId;
    await this.initial;
    await assertCurrent();
    this.check(generation);
    const saved = await updateConnectionConfig(current => {
      if (!this.current(generation)) return null;
      prior = current;
      const next: BridgeConfig = {
        ...current, enabled: true, authorizationId, endpoint: requestedEndpoint ?? current.endpoint,
        name: connectionName(name === undefined ? current.name : name),
        // Persist credentials before pairing so a lost response remains safely retryable.
        pairingToken: current.pairingToken || newPairingToken(), instanceId: "",
        state: "connecting", attemptsRemaining: RETRY_LIMIT, leaseWaitRemaining: LEASE_WAIT_LIMIT, nextRetryAt: 0,
        lastError: undefined, connectedAt: undefined,
        ...this.leaseFields(),
      };
      // Our storage listener must see this operation's authority before Chrome emits the change.
      this.config = next;
      return next;
    });
    this.check(generation);
    this.config = saved;
    this.emit();
    if (previous) await previous;
    this.check(generation);
    if (prior?.pairingToken && prior.instanceId) await this.release(prior, oldConnectionId);
    this.check(generation);
    await this.attempt(assertCurrent);
    return this.status();
  }
  private renameCurrent(name: string | undefined, assertCurrent: () => void | Promise<void>): Promise<CliConnectionStatus> {
    const generation = this.generation;
    const operation = this.nameChanges.then(async () => {
      this.check(generation);
      await assertCurrent(); this.check(generation);
      const config = this.config!;
      if (name && name !== config.name) {
        const paired = await this.json(config.endpoint, "/v1/qingzhou/rename", {
          clientId: config.clientId, name, pairingToken: config.pairingToken,
          instanceId: config.instanceId, connectionId: this.connectionId,
        }, this.controller.signal, 5000);
        this.check(generation);
        if (paired.instanceId !== config.instanceId || paired.clientId !== config.clientId
          || paired.connectionId !== this.connectionId || paired.name !== name) {
          throw failure("MCP_CONNECTION_INCOMPATIBLE", upgradeGuidance);
        }
        await assertCurrent(); this.check(generation);
        this.nameRevision++;
        await this.persist(generation, { name });
      }
      return this.status();
    });
    this.nameChanges = operation.then(() => {}, () => {});
    return operation;
  }
  async disconnect() {
    const prior = this.config;
    const connectionId = this.connectionId;
    this.revoke();
    this.authorizationId = "";
    const generation = this.generation;
    this.config = await updateConnectionConfig(current => {
      if (!this.current(generation)) return null;
      const next: BridgeConfig = { ...current, enabled: false, authorizationId: "", state: "disconnected", nextRetryAt: 0, lastError: undefined };
      if (firefoxWakeChrome()) delete next.connectionId;
      this.config = next;
      return next;
    });
    await this.setAlarm(false);
    this.emit();
    // Revoke locally first. Service cleanup is bounded and cannot resume this connection.
    if (prior?.pairingToken && prior.instanceId) await this.release(prior, connectionId);
    return this.status();
  }
  private async release(config: BridgeConfig, connectionId: string) {
    try { await this.json(config.endpoint, "/v1/qingzhou/disconnect", {
      clientId: config.clientId, pairingToken: config.pairingToken, instanceId: config.instanceId, connectionId,
    }, new AbortController().signal, 3000); } catch { /* An offline service will expire its old lease. */ }
  }
  private emit() {
    if (this.config) this.deps.onStatus?.(connectionStatus(!this.paired && this.config.state === "connected"
      ? { ...this.config, state: "reconnecting" } : this.config));
    this.noteFirefoxWake();
  }
  private async persist(generation: number, change: Partial<BridgeConfig> | (() => Partial<BridgeConfig>)) {
    const authorizationId = this.authorizationId;
    const config = await updateConnectionConfig(current => {
      if (!this.current(generation) || current.authorizationId !== authorizationId || !current.enabled) return null;
      const patch = typeof change === "function" ? change() : change;
      const next = { ...current, ...patch, ...this.leaseFields() };
      this.config = next;
      return next;
    });
    if (!this.current(generation) || config.authorizationId !== authorizationId || !config.enabled) throw cancelled();
    this.config = config;
    this.emit();
    return config;
  }
  private schedule(delay: number) {
    if (!this.started || !this.config?.enabled || this.config.state === "paused" || this.config.attemptsRemaining <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.attempt(); }, delay);
    void this.setAlarm(true, Date.now() + Math.max(RETRY_DELAY_MS, delay));
  }
  private setAlarm(enabled: boolean, when?: number) {
    this.alarmUpdate = this.alarmUpdate.catch(() => {}).then(async () => {
      if (enabled && this.started && this.config?.enabled && this.config.state !== "paused") {
        await chrome.alarms?.create(RECONNECT_ALARM, { when: when ?? Date.now() + RETRY_DELAY_MS, periodInMinutes: 0.5 });
      } else await chrome.alarms?.clear(RECONNECT_ALARM);
    }).catch(() => {});
    return this.alarmUpdate;
  }
  private attempt(assertCurrent: () => void | Promise<void> = () => {}): Promise<void> {
    if (this.flight) return this.flight;
    const work = this.poll(assertCurrent).catch(error => {
      this.deps.trace?.(`[mcp-bridge] local connection: ${record(error).code || "unavailable"}`);
    }).finally(() => { if (this.flight === work) this.flight = undefined; });
    this.flight = work;
    return work;
  }
  private async poll(assertCurrent: () => void | Promise<void>) {
    const generation = this.generation;
    if (!this.current(generation)) return;
    const latest = await getConnectionConfig();
    if (!this.current(generation) || !latest.enabled || latest.authorizationId !== this.authorizationId || latest.state === "paused") return;
    this.config = latest;
    if (latest.attemptsRemaining <= 0) {
      await this.persist(generation, { state: "paused" }); await this.setAlarm(false); return;
    }
    if (latest.state !== "connected" && latest.nextRetryAt > Date.now()) { this.schedule(latest.nextRetryAt - Date.now()); return; }
    const signal = this.controller.signal;
    try {
      this.check(generation);
      // Reserve the attempt before any network operation. A worker termination cannot refund it.
      let config = await this.persist(generation, {
        attemptsRemaining: latest.attemptsRemaining - 1, nextRetryAt: Date.now() + RETRY_DELAY_MS,
        state: this.paired ? "connected" : latest.connectedAt ? "reconnecting" : "connecting",
      });
      await this.setAlarm(true, config.nextRetryAt);
      if (!this.paired) {
        await assertCurrent(); this.check(generation);
        const health = await this.json(config.endpoint, "/health", undefined, signal, 5000);
        if (health.service !== "qz-browser-agent" || health.protocolVersion !== 1 || record(health.features).browserPairing !== 1 || typeof health.instanceId !== "string" || !health.instanceId) {
          throw failure("MCP_CONNECTION_INCOMPATIBLE", upgradeGuidance);
        }
        await assertCurrent(); this.check(generation);
        const paired = await this.json(config.endpoint, "/v1/qingzhou/pair", {
          clientId: config.clientId, name: config.name || undefined, pairingToken: config.pairingToken || undefined,
          connectionId: this.connectionId, instanceId: health.instanceId,
        }, signal, 5000);
        if (paired.instanceId !== health.instanceId || paired.clientId !== config.clientId || paired.connectionId !== this.connectionId
          || typeof paired.pairingToken !== "string" || !paired.pairingToken || typeof paired.name !== "string") {
          throw failure("MCP_CONNECTION_INCOMPATIBLE", upgradeGuidance);
        }
        await assertCurrent(); this.check(generation);
        config = await this.persist(generation, {
          name: paired.name, pairingToken: paired.pairingToken, instanceId: paired.instanceId,
          serviceVersion: typeof health.version === "string" ? health.version : undefined,
        });
        this.paired = true;
      }
      const client: Record<string, unknown> = {
        id: config.clientId, name: config.name, extensionId: chrome.runtime.id, protocolVersion: 1,
        pairingVersion: 1, pairingToken: config.pairingToken, instanceId: config.instanceId, connectionId: this.connectionId,
        pollTimeoutMs: config.connectedAt ? config.pollTimeoutMs : 1000, pollIntervalMs: config.pollIntervalMs, maxBatch: config.maxBatch,
      };
      if (this.deps.describe && config.includeCapabilities) client.capabilities = await this.deps.describe();
      this.check(generation);
      const nameRevision = this.nameRevision;
      const response = await this.json(config.endpoint, "/v1/qingzhou/poll", { client }, signal, Number(client.pollTimeoutMs) + 5000);
      this.check(generation);
      if (!Array.isArray(response.requests)) throw failure("MCP_CONNECTION_INCOMPATIBLE", upgradeGuidance);
      if (response.instanceId !== config.instanceId) throw failure("BRIDGE_INSTANCE_CHANGED", "The local service restarted. Reconnecting.");
      if (response.clientId !== config.clientId || response.connectionId !== this.connectionId
        || typeof response.name !== "string" || !response.name || connectionName(response.name) !== response.name) {
        throw failure("MCP_CONNECTION_INCOMPATIBLE", upgradeGuidance);
      }
      const serviceName = response.name;
      await this.persist(generation, () => ({ state: "connected", attemptsRemaining: RETRY_LIMIT, leaseWaitRemaining: LEASE_WAIT_LIMIT,
        nextRetryAt: 0, lastError: undefined, connectedAt: config.connectedAt || Date.now(),
        ...(nameRevision === this.nameRevision ? { name: serviceName } : {}),
      }));
      await this.setAlarm(true);
      for (const request of response.requests.slice(0, config.maxBatch)) this.startRequest(record(request), config, generation, signal);
      this.schedule(response.requests.length ? 0 : config.pollIntervalMs);
    } catch (error) {
      if (!this.current(generation) || signal.aborted) return;
      const code = typeof record(error).code === "string" ? String(record(error).code) : "MCP_CONNECTION_UNAVAILABLE";
      // A lost lease revokes queued work and result authority before recovery begins.
      // Retain the wire connection ID on transport failures for idempotent pair retries.
      this.revoke();
      const recoveryGeneration = this.generation;
      if (code === "BRIDGE_INSTANCE_CHANGED") this.connectionId = crypto.randomUUID();
      const retryAfterMs = Number(record(error).retryAfterMs);
      const leaseWait = code === "BRIDGE_CLIENT_IN_USE" && (this.config?.leaseWaitRemaining || 0) > 0
        && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 120_000;
      const attemptsRemaining = (this.config?.attemptsRemaining || 0) + (leaseWait ? 1 : 0);
      const recoverSleep = Boolean(firefoxWakeChrome()) && !BLOCKED_WAKE_RESUME.has(code);
      const paused = permanent.has(code) || (!recoverSleep && attemptsRemaining <= 0);
      await this.persist(recoveryGeneration, {
        state: paused ? "paused" : "reconnecting",
        ...(leaseWait ? { attemptsRemaining, leaseWaitRemaining: 0, nextRetryAt: Date.now() + Math.ceil(retryAfterMs) + 100 } : {}),
        ...(recoverSleep && attemptsRemaining <= 0 ? { attemptsRemaining: RETRY_LIMIT, nextRetryAt: Date.now() + RETRY_DELAY_MS } : {}),
        lastError: { code, message: error instanceof Error ? error.message : "The local service is unavailable. Run qz connect to retry." },
      });
      if (paused) await this.setAlarm(false);
      else this.schedule(Math.max(0, (this.config?.nextRetryAt || 0) - Date.now()));
    }
  }
  private startRequest(request: Record<string, unknown>, config: BridgeConfig, generation: number, signal: AbortSignal) {
    const id = String(request.id || "");
    const connectionId = this.connectionId;
    const key = `${connectionId}:${id}`;
    if (!id || this.requests.has(key) || !this.current(generation)) return;
    const work = (async () => {
      let payload: Record<string, unknown>;
      const started = Date.now();
      try {
        this.check(generation);
        if (!this.deps.dispatch) throw new Error("qz dispatcher is unavailable");
        const result = await bounded(Promise.resolve(this.deps.dispatch({ id, method: String(request.method || ""), params: record(request.params), raw: request, signal })), signal,
          Math.max(1000, Math.min(600_000, Number(request.timeoutMs) || config.requestTimeoutMs)));
        payload = { ok: true, result };
      } catch (error) {
        payload = { ok: false, error: error instanceof Error ? error.message : String(error), code: record(error).code || "", details: errorDetails(error) };
      }
      this.check(generation);
      // Results are bound to the exact service/worker lease that dequeued the request.
      await this.json(config.endpoint, "/v1/qingzhou/result", {
        clientId: config.clientId, pairingToken: config.pairingToken, instanceId: config.instanceId, connectionId,
        requestId: id, ...payload, durationMs: Date.now() - started,
      }, signal, 15_000);
    })().catch(() => {}).finally(() => this.requests.delete(key));
    this.requests.set(key, work);
  }
  private async json(endpoint: string, path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Record<string, unknown>> {
    return bounded((async () => {
      const response = await (this.deps.fetch || fetch)(`${endpoint}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      const value = record(await response.json());
      if (!response.ok) {
        const detail = record(value.error);
        throw Object.assign(failure(String(detail.code || value.code || "MCP_CONNECTION_UNAVAILABLE"), String(detail.message || value.error || "The local service is unavailable. Run qz connect to retry.")), {
          retryAfterMs: value.retryAfterMs ?? detail.retryAfterMs,
        });
      }
      return value;
    })(), signal, timeoutMs);
  }
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason || cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(signal.reason || cancelled());
    const timer = setTimeout(() => finish(failure("MCP_CONNECTION_UNAVAILABLE", "The local service timed out. Run qz connect to retry.")), ms);
    const finish = (error: unknown, value?: T) => {
      clearTimeout(timer); signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(null, value), finish);
  });
}
function errorDetails(error: unknown) {
  const value = record(error), details = record(value.details);
  const keys = value.code === "DOWNLOAD_INTERRUPTED" ? ["downloadId", "filename", "reason"]
    : value.code === "SKILL_NOT_FOUND" ? ["name"] : value.code === "SKILL_RESOURCE_NOT_FOUND" ? ["name", "path"] : [];
  return Object.fromEntries(keys.filter(key => typeof details[key] === "string" || typeof details[key] === "number").map(key => [key, details[key]]));
}

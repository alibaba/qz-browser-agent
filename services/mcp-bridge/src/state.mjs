import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export const PROTOCOL_VERSION = 1;
export const PROJECT_URL = "https://github.com/alibaba/qz-browser-agent";
const now = () => Date.now() / 1000;
const rounded = value => Math.round(value * 1000) / 1000;
const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(Number(value), max)) : fallback;

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.code = code;
    const fields = code === "DOWNLOAD_INTERRUPTED" ? ["downloadId", "filename", "reason"]
      : code === "SKILL_NOT_FOUND" ? ["name"] : code === "SKILL_RESOURCE_NOT_FOUND" ? ["name", "path"] : [];
    this.details = Object.fromEntries(fields.filter(key => typeof details?.[key] === "string" || typeof details?.[key] === "number")
      .map(key => [key, details[key]]));
    if (["SKILL_NOT_FOUND", "SKILL_RESOURCE_NOT_FOUND"].includes(code) && Array.isArray(details?.available)) {
      this.details.available = details.available.filter(value => typeof value === "string");
    }
  }
}

export class BridgeState {
  constructor({ endpoint = "http://127.0.0.1:18765", requestTimeoutSeconds = 180, connectWaitMs = 2000 } = {}) {
    this.endpoint = endpoint;
    this.requestTimeoutSeconds = Math.max(1, requestTimeoutSeconds);
    this.connectWaitMs = connectWaitMs;
    this.clients = new Map();
    this.pending = new Map();
    this.inflight = new Map();
    this.jobs = new Map();
    this.startedAt = now();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.closed = new AbortController();
  }

  liveClients() {
    return [...this.clients.values()].filter(client => now() - client.lastSeenAt <= client.pollLeaseSeconds);
  }

  status() {
    const clients = this.liveClients().map(client => ({
      clientId: client.id,
      lastSeenAt: client.lastSeenAt,
      ageSeconds: rounded(now() - client.lastSeenAt),
      extensionId: client.extensionId || "",
      name: client.name || "",
      capabilities: client.capabilities || {},
    })).sort((a, b) => a.clientId.localeCompare(b.clientId));
    return {
      endpoint: this.endpoint, protocolVersion: PROTOCOL_VERSION, connected: clients.length > 0,
      clientCount: clients.length, clients, pending: this.pending.size, inflight: this.inflight.size,
      uptimeSeconds: rounded(now() - this.startedAt),
    };
  }

  enableSnippet(clientId = "") {
    const config = {
      enabled: true, endpoint: this.endpoint, pollIntervalMs: 500, pollTimeoutMs: 30000,
      requestTimeoutMs: this.requestTimeoutSeconds * 1000, maxBatch: 4, includeCapabilities: true,
      ...(clientId ? { clientId } : {}),
    };
    return `await chrome.storage.local.set({\n  "_qingzhou_mcp_bridge": ${JSON.stringify(config, null, 2)}\n});\nawait chrome.storage.local.get("_qingzhou_mcp_bridge");`;
  }

  registerClient(client, timeoutMs = client.pollTimeoutMs || 30000) {
    const id = String(client.id || client.clientId || "qingzhou-extension").trim() || "qingzhou-extension";
    const info = {
      ...client, id, lastSeenAt: now(),
      pollLeaseSeconds: (bounded(timeoutMs, 30000, 100, 60000)
        + bounded(client.pollIntervalMs ?? 750, 750, 100, 60000)) / 1000 + 15,
    };
    this.clients.set(id, info);
    this.events.emit("change");
    return info;
  }

  signal(signal) {
    return signal ? AbortSignal.any([this.closed.signal, signal]) : this.closed.signal;
  }

  waitForChange(timeoutMs, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        this.events.off("change", changed);
        signal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const changed = () => finish();
      const aborted = () => finish(signal.reason);
      const timer = setTimeout(changed, Math.max(0, timeoutMs));
      this.events.once("change", changed);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async resolveClient(clientId, timeoutMs, signal) {
    const deadline = Date.now() + Math.min(timeoutMs, this.connectWaitMs);
    while (true) {
      signal.throwIfAborted();
      const clients = this.liveClients();
      if (clientId && clients.some(client => client.id === clientId)) return clientId;
      if (!clientId && clients.length === 1) return clients[0].id;
      if (!clientId && clients.length > 1) throw new BridgeError("BRIDGE_CLIENT_REQUIRED",
        `Multiple qz browsers are connected. Pass clientId from qingzhou_bridge_status: ${clients.map(client => client.id).sort().join(", ")}`);
      if (Date.now() >= deadline) throw new BridgeError("BRIDGE_NOT_CONNECTED",
        `No active qz extension${clientId ? ` (${clientId})` : ""}. Open qz in Chrome and accept its data notice, then retry. Install qz: ${PROJECT_URL}`);
      await this.waitForChange(deadline - Date.now(), signal);
    }
  }

  async poll(client, { timeoutMs = 30000, maxBatch = 4, signal } = {}) {
    const activeSignal = this.signal(signal);
    activeSignal.throwIfAborted();
    const info = this.registerClient(client, timeoutMs);
    const deadline = Date.now() + bounded(timeoutMs, 30000, 100, 60000);
    const limit = Math.floor(bounded(maxBatch, 4, 1, 16));
    while (true) {
      activeSignal.throwIfAborted();
      const requests = [];
      for (const [id, request] of this.pending) {
        if (requests.length >= limit) break;
        if (request.clientId !== info.id) continue;
        this.pending.delete(id);
        this.inflight.set(id, request);
        requests.push({ id, method: request.method, params: request.params, timeoutMs: request.timeoutMs });
      }
      if (requests.length || Date.now() >= deadline) return requests;
      await this.waitForChange(deadline - Date.now(), activeSignal);
    }
  }

  async callExtension(method, params = {}, { timeoutSeconds, clientId = "", signal } = {}) {
    if (typeof method !== "string" || !method.trim()) throw new BridgeError("INVALID_ARGUMENTS", "method is required");
    const activeSignal = this.signal(signal);
    const seconds = bounded(timeoutSeconds || this.requestTimeoutSeconds, this.requestTimeoutSeconds, 1, 86400);
    const target = await this.resolveClient(String(clientId || "").trim(), seconds * 1000, activeSignal);
    activeSignal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = `qz_${Date.now()}_${randomUUID()}`;
      const finish = (error, result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.inflight.delete(id);
        activeSignal.removeEventListener("abort", aborted);
        error ? reject(error) : resolve(result);
      };
      const aborted = () => finish(activeSignal.reason);
      const timer = setTimeout(() => finish(new BridgeError("BRIDGE_REQUEST_TIMEOUT",
        `Request timed out after ${seconds}s: ${method}. A started operation may still be running; check its state before retrying.`)), seconds * 1000);
      activeSignal.addEventListener("abort", aborted, { once: true });
      this.pending.set(id, { id, method, params, clientId: target, timeoutMs: seconds * 1000, finish });
      this.events.emit("change");
    });
  }

  complete(requestId, payload) {
    const request = this.inflight.get(requestId);
    if (!request) return false;
    // Legacy v1 clients may omit clientId; an explicit identity must match the dispatched request.
    if (payload.clientId && payload.clientId !== request.clientId) return false;
    if (payload.ok === false) request.finish(new BridgeError(payload.code || "BRIDGE_TOOL_ERROR", String(payload.error || "qz bridge request failed"), payload.details));
    else request.finish(null, payload.result);
    return true;
  }

  startExtensionJob(method, params = {}, options = {}) {
    if (!method?.trim()) throw new BridgeError("INVALID_ARGUMENTS", "method is required");
    this.pruneJobs();
    const job = {
      id: `job_${Date.now()}_${randomUUID()}`, method, status: "queued", createdAt: now(), startedAt: 0, completedAt: 0,
      timeoutSeconds: bounded(options.timeoutSeconds || this.requestTimeoutSeconds, this.requestTimeoutSeconds, 1, 86400),
    };
    this.jobs.set(job.id, job);
    queueMicrotask(async () => {
      job.status = "running";
      job.startedAt = now();
      try {
        // Async jobs outlive their initial MCP call and can be polled with get_tool_job.
        job.result = await this.callExtension(method, params, { ...options, signal: undefined });
        job.status = "completed";
      } catch (error) {
        job.error = error.message || String(error);
        job.status = "failed";
      }
      job.completedAt = now();
    });
    return this.serializeJob(job, false);
  }

  getJob(jobId, includeResult = true) {
    this.pruneJobs();
    const job = this.jobs.get(String(jobId || "").trim());
    if (!job) throw new BridgeError("JOB_NOT_FOUND", `Unknown qz bridge job: ${jobId}`);
    return this.serializeJob(job, includeResult);
  }

  serializeJob(job, includeResult = true) {
    return {
      jobId: job.id, method: job.method, status: job.status,
      done: ["completed", "failed"].includes(job.status), createdAt: job.createdAt,
      startedAt: job.startedAt || null, completedAt: job.completedAt || null,
      ageSeconds: rounded(now() - job.createdAt), timeoutSeconds: job.timeoutSeconds,
      ...(job.completedAt && job.startedAt ? { durationSeconds: rounded(job.completedAt - job.startedAt) } : {}),
      ...(job.status === "failed" ? { error: job.error } : {}),
      ...(includeResult && job.status === "completed" ? { result: job.result } : {}),
    };
  }

  pruneJobs() {
    if (this.jobs.size <= 200) return;
    const completed = [...this.jobs.values()].filter(job => ["completed", "failed"].includes(job.status))
      .sort((a, b) => a.completedAt - b.completedAt);
    for (const job of completed.slice(0, this.jobs.size - 200)) this.jobs.delete(job.id);
  }

  close() {
    this.closed.abort(new BridgeError("BRIDGE_CLOSED", "The local bridge has stopped"));
  }
}

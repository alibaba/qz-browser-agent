import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserRegistry, browserName, isBrowserId, sameToken, pairingError } from "./browser-registry.mjs";
import { INSTALL_URL } from "./package-info.mjs";

export const PROTOCOL_VERSION = 1;
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
  constructor({ endpoint = "http://127.0.0.1:18765", requestTimeoutSeconds = 180, connectWaitMs = 2000, instanceId = randomUUID(), registry = new BrowserRegistry() } = {}) {
    this.endpoint = endpoint;
    this.instanceId = instanceId;
    this.registry = registry;
    this.registration = Promise.resolve();
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
      paired: Boolean(client.connectionId),
    })).sort((a, b) => a.clientId.localeCompare(b.clientId));
    return {
      endpoint: this.endpoint, protocolVersion: PROTOCOL_VERSION, connected: clients.length > 0,
      clientCount: clients.length, clients, browsers: this.registry.list().map(entry => ({ ...entry, online: clients.some(client => client.clientId === entry.clientId) })), pending: this.pending.size, inflight: this.inflight.size,
      uptimeSeconds: rounded(now() - this.startedAt),
    };
  }

  serializeRegistration(operation) {
    const result = this.registration.then(() => {
      this.closed.signal.throwIfAborted();
      return operation();
    });
    this.registration = result.catch(() => {});
    return result;
  }

  requireInstance(instanceId) {
    if (instanceId !== this.instanceId) throw pairingError("BRIDGE_INSTANCE_CHANGED", "The local service changed. Check its health and pair again.");
  }

  revokeClient(id, message = "The browser connection ended. Reconnect that browser before retrying.") {
    const client = this.clients.get(id);
    if (!client) return;
    const error = pairingError("BRIDGE_CLIENT_DISCONNECTED", message);
    this.clients.delete(id);
    client.controller.abort(error);
    for (const request of [...this.pending.values(), ...this.inflight.values()]) {
      if (request.client === client) request.finish(error);
    }
    this.events.emit("change");
  }

  pair(input) {
    return this.serializeRegistration(async () => {
      this.requireInstance(input.instanceId);
      if (!isBrowserId(input.clientId) || !isBrowserId(input.connectionId)) {
        throw pairingError("INVALID_ARGUMENTS", "clientId and connectionId must be UUIDs.");
      }
      const previous = this.clients.get(input.clientId);
      if (previous && this.liveClients().includes(previous) && previous.connectionId !== input.connectionId) {
        throw Object.assign(pairingError("BRIDGE_CLIENT_IN_USE", "This browser identity has an active connection. Wait for it to disconnect, or connect from a distinct browser profile."), {
          retryAfterMs: Math.max(1, Math.ceil((previous.lastSeenAt + previous.pollLeaseSeconds - now()) * 1000) + 1),
        });
      }
      const entry = await this.registry.pair(input);
      this.closed.signal.throwIfAborted();
      if (previous?.connectionId !== input.connectionId) this.revokeClient(input.clientId);
      const client = this.clients.get(input.clientId) || { id: input.clientId, connectionId: input.connectionId, controller: new AbortController() };
      Object.assign(client, { name: entry.name, lastSeenAt: now(), pollLeaseSeconds: 46 });
      this.clients.set(client.id, client);
      this.events.emit("change");
      return { ok: true, ...entry, connectionId: input.connectionId, instanceId: this.instanceId };
    });
  }

  authenticatedClient(input) {
    this.requireInstance(input.instanceId);
    const id = input.clientId || input.id;
    const entry = this.registry.entries.get(id), client = this.clients.get(id);
    if (!entry || !sameToken(input.pairingToken, entry.pairingToken) || !client?.connectionId
      || client.connectionId !== input.connectionId) {
      throw pairingError("BRIDGE_PAIRING_REQUIRED", "This browser connection is no longer paired. Connect again from the extension settings.");
    }
    return client;
  }

  connectionInfo(input) {
    const client = this.authenticatedClient(input);
    return { clientId: client.id, name: client.name, connectionId: client.connectionId, instanceId: this.instanceId };
  }

  rename(input) {
    return this.serializeRegistration(async () => {
      const client = this.authenticatedClient(input);
      if (!this.liveClients().includes(client)) throw pairingError("BRIDGE_CLIENT_OFFLINE", "Reconnect this browser before renaming it.");
      const entry = await this.registry.pair({ ...input, name: browserName(input.name) });
      this.closed.signal.throwIfAborted();
      client.name = entry.name;
      return { ok: true, ...this.connectionInfo(input) };
    });
  }

  disconnect(input) {
    return this.serializeRegistration(() => {
      const client = this.authenticatedClient(input);
      this.revokeClient(client.id);
      return { ok: true, clientId: client.id };
    });
  }

  forgetBrowser(selector) {
    return this.serializeRegistration(async () => {
      const entry = this.registry.get(selector);
      if (!entry) throw pairingError("BRIDGE_CLIENT_NOT_FOUND", `No registered browser named ${selector}. Use qz browsers to list names and UUIDs.`);
      if (this.liveClients().some(client => client.id === entry.clientId)) {
        throw pairingError("BRIDGE_CLIENT_IN_USE", "Disconnect this browser in its extension settings before forgetting its registration.");
      }
      await this.registry.forget(entry.clientId);
      this.revokeClient(entry.clientId);
      return { forgotten: true, clientId: entry.clientId, name: entry.name };
    });
  }

  touchClient(info, client, timeoutMs) {
    Object.assign(info, { lastSeenAt: now(), extensionId: client.extensionId || info.extensionId,
      capabilities: client.capabilities || info.capabilities,
      pollLeaseSeconds: (bounded(timeoutMs, 30000, 100, 60000)
        + bounded(client.pollIntervalMs ?? 750, 750, 100, 60000)) / 1000 + 15 });
    this.clients.set(info.id, info);
    this.events.emit("change");
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

  async resolveClient(clientId, timeoutMs, signal, returnConnection = false) {
    const registered = clientId && this.registry.get(clientId);
    const target = registered?.clientId || clientId;
    const deadline = Date.now() + Math.min(timeoutMs, this.connectWaitMs);
    while (true) {
      signal.throwIfAborted();
      const clients = this.liveClients();
      const selected = target && clients.find(client => client.id === target);
      if (selected) return returnConnection ? selected : selected.id;
      if (clientId && (registered || this.clients.has(target) || Date.now() >= deadline)) throw new BridgeError(registered || this.clients.has(target) ? "BRIDGE_CLIENT_OFFLINE" : "BRIDGE_CLIENT_NOT_FOUND",
        `Browser ${clientId} is ${registered || this.clients.has(target) ? "offline" : "not registered"}. Use qz browsers to inspect browser names and UUIDs.`);
      if (!clientId && clients.length === 1) return returnConnection ? clients[0] : clients[0].id;
      if (!clientId && clients.length > 1) throw new BridgeError("BRIDGE_CLIENT_REQUIRED",
        `Multiple qz browsers are connected. Pass clientId from qingzhou_bridge_status: ${clients.map(client => `${client.name || client.id} (${client.id})`).sort().join(", ")}`);
      if (Date.now() >= deadline) throw new BridgeError("BRIDGE_NOT_CONNECTED",
        `No active qz extension${clientId ? ` (${clientId})` : ""}. Run qz connect, then confirm the connection in the extension. Install qz: ${INSTALL_URL}`);
      await this.waitForChange(deadline - Date.now(), signal);
    }
  }

  async poll(client, { timeoutMs = 30000, maxBatch = 4, signal } = {}) {
    const info = await this.serializeRegistration(() => {
      this.signal(signal).throwIfAborted();
      if (client.pairingVersion !== 1) throw pairingError("BRIDGE_PAIRING_REQUIRED", "Update qz to use the supported pairing protocol.");
      const info = this.authenticatedClient(client);
      this.touchClient(info, client, timeoutMs);
      return info;
    });
    const activeSignal = AbortSignal.any([this.signal(signal), info.controller.signal]);
    activeSignal.throwIfAborted();
    const deadline = Date.now() + bounded(timeoutMs, 30000, 100, 60000);
    const limit = Math.floor(bounded(maxBatch, 4, 1, 16));
    while (true) {
      activeSignal.throwIfAborted();
      const requests = [];
      for (const [id, request] of this.pending) {
        if (requests.length >= limit) break;
        if (request.client !== info) continue;
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
    const client = await this.resolveClient(String(clientId || "").trim(), seconds * 1000, activeSignal, true);
    activeSignal.throwIfAborted();
    const target = client.id;
    if (this.clients.get(target) !== client || !this.liveClients().includes(client)) throw pairingError("BRIDGE_CLIENT_OFFLINE", "The selected browser disconnected before the request could start.");
    client.controller.signal.throwIfAborted();
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
      this.pending.set(id, { id, method, params, clientId: target, client, timeoutMs: seconds * 1000, finish });
      this.events.emit("change");
    });
  }

  complete(requestId, payload) {
    const request = this.inflight.get(requestId);
    if (!request) return false;
    let client;
    try { client = this.authenticatedClient(payload); } catch { return false; }
    if (client !== request.client) return false;
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
        // Jobs outlive the initial MCP response, but retain that browser connection's authority.
        job.result = await this.callExtension(method, params, { ...options, signal: options.connectionSignal });
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

import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION, QzError, readHealth } from "./client.mjs";
import { ensureDaemon, findDaemon, restartDaemon } from "./daemon.mjs";
import { openConnectionBrowser } from "./open-browser.mjs";

import { SCRIPT_API_VERSION } from "./script-call.mjs";

const offlineCodes = new Set(["BRIDGE_NOT_CONNECTED", "BRIDGE_CLIENT_OFFLINE", "BRIDGE_CLIENT_DISCONNECTED", "BRIDGE_REQUEST_TIMEOUT", -32001]);

/** Upgrade a verified service at most once, before any browser operation is submitted. */
export async function prepareService({ options = {}, script = false } = {}, dependencies = {}) {
  const signal = dependencies.signal;
  signal?.throwIfAborted();
  const find = dependencies.findDaemon || findDaemon;
  const ensure = dependencies.ensureDaemon || ensureDaemon;
  let running = await find({ allowIncompatible: true });
  signal?.throwIfAborted();
  if (!running) {
    running = await ensure({ ...(options.port === undefined ? {} : { preferredPort: options.port }), signal });
    signal?.throwIfAborted();
  }
  const compatible = service => service.compatible !== false
    && (service.health.protocolVersion === undefined || service.health.protocolVersion === PROTOCOL_VERSION)
    && service.health.features?.browserPairing === 1 && (!script || service.health.features?.scriptApiVersion >= SCRIPT_API_VERSION);
  if (!compatible(running)) {
    running = await (dependencies.restartDaemon || restartDaemon)({ expected: running, preferredPort: Number(new URL(running.endpoint).port), signal });
    signal?.throwIfAborted();
    if (!compatible(running)) throw new QzError("UPGRADE_REQUIRED", "The local qz service is incompatible. No browser operation was submitted.", {
      hint: "Update the installed CLI and browser extension, then retry the command.",
    });
  }
  return running;
}

export function connectionUri(running, options = {}) {
  const url = new URL("/qz-connect", running.endpoint);
  let name = options.name;
  if (options["client-id"]) {
    const entry = [...(running.health.status?.browsers || []), ...(running.health.status?.clients || [])]
      .find(client => client.clientId === options["client-id"] || client.name === options["client-id"]);
    if (!entry) throw new QzError("CLIENT_NOT_FOUND", "The selected browser is not registered. Run qz browsers to inspect names and UUIDs.");
    name = entry.name;
  }
  if (name) url.searchParams.set("name", name);
  return url.href;
}

/** Select one responding identity; every later call in the command keeps that UUID. */
export async function prepareConnection({ options = {}, timeoutSeconds = 30, sessionId = "", script = false } = {}, dependencies = {}) {
  const running = await prepareService({ options, script }, dependencies);
  const startedAt = Date.now(), commandDeadline = startedAt + timeoutSeconds * 1000;
  let deadline = Math.min(commandDeadline, startedAt + 30000), reconnectUntil = 0;
  const signal = dependencies.signal;
  const selector = options["client-id"];
  const registered = selector ? [...(running.health.status?.browsers || []), ...(running.health.status?.clients || [])]
    .find(client => client.clientId === selector || client.name === selector) : undefined;
  if (selector && !registered) throw new QzError("CLIENT_NOT_FOUND", "The selected browser is not registered. Run qz browsers to inspect names and UUIDs.");
  const clientId = registered?.clientId;
  const uri = connectionUri(running, options);
  const call = async (name, args) => {
    signal?.throwIfAborted();
    const timeoutMs = Math.max(1, Math.min(2000, deadline - Date.now()));
    return dependencies.callTool(running.endpoint, name, { ...args, timeoutSeconds: timeoutMs / 1000 }, { timeoutMs, signal });
  };
  const locate = async health => {
    const clients = (health.status?.clients || []).filter(client => !clientId || client.clientId === clientId);
    const matches = [];
    for (const client of clients) {
      try { await call("qingzhou_call", { method: "ping", clientId: client.clientId }); }
      catch (error) {
        signal?.throwIfAborted();
        if (!offlineCodes.has(error.code)) throw error;
        if (sessionId && clients.length > 1) throw error;
        continue;
      }
      // A unique connection retains the tool producer's authoritative occupied/ended checks.
      if (!sessionId || selector || clients.length === 1) return client.clientId;
      try {
        await call("qingzhou_get_drive_session", { sessionId, clientId: client.clientId });
        matches.push(client.clientId);
      } catch (error) {
        if (error.code !== "DRIVE_SESSION_NOT_FOUND") throw error;
        const snapshot = await call("qingzhou_get_session_snapshot", { sessionId, clientId: client.clientId, compact: true, tail: true });
        if (snapshot?.session) matches.push(client.clientId);
      }
    }
    if (matches.length > 1) throw new QzError("SELECTION_REQUIRED", "This session exists in more than one browser. Select its browser with --client NAME|UUID.");
    if (matches.length === 1) return matches[0];
    if (sessionId && clients.length > 1) throw new QzError("DRIVE_SESSION_NOT_FOUND", "The session was not found in the connected browsers.", {
      hint: "Check the session ID and use --client NAME|UUID to select its browser.",
    });
    return "";
  };
  const observeReconnect = health => {
    const waiting = (health.status?.connecting || []).filter(client => !clientId || client.clientId === clientId);
    const retryAfterMs = Math.max(0, ...waiting.map(client => Number.isFinite(client.retryAfterMs) ? client.retryAfterMs : 0));
    reconnectUntil = retryAfterMs > 0 ? Math.min(commandDeadline, Date.now() + retryAfterMs) : 0;
    deadline = Math.max(deadline, reconnectUntil);
  };
  observeReconnect(running.health);
  let selected = await locate(running.health);
  if (selected) return { running, clientId: selected };
  const attempted = [];
  let opened = Boolean(selector);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!opened && Date.now() >= reconnectUntil) {
      const browser = await (dependencies.openConnectionBrowser || openConnectionBrowser)(uri, {
        signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())),
      });
      attempted.push(browser.browser || "System default browser");
      opened = true;
    }
    if (Date.now() >= deadline) break;
    let health;
    try {
      health = await (dependencies.readHealth || readHealth)(running.endpoint, {
        timeoutMs: Math.max(1, Math.ceil(Math.min(1000, deadline - Date.now()))), signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) break;
      throw error;
    }
    signal?.throwIfAborted();
    if (Date.now() >= deadline) break;
    if (running.instanceId && health.instanceId !== running.instanceId) throw new QzError("CONNECTION_CHANGED", "The local service changed during connection. Retry the command.");
    observeReconnect(health);
    selected = await locate(health);
    if (selected) return { running: { ...running, health }, clientId: selected };
    await delay(Math.max(1, Math.min(200, deadline - Date.now())), undefined, { signal });
  }
  throw new QzError(selector ? "CLIENT_OFFLINE" : "CONNECTION_PENDING", `${selector ? "The selected browser is not responding." : "qz is waiting for its browser extension."} No browser operation was submitted.`, {
    stage: "browser-connection",
    ...(registered ? { selectedBrowser: { clientId: registered.clientId, name: registered.name } } : {}),
    attemptedBrowsers: attempted, operationSubmitted: false,
    url: uri,
    hint: selector
      ? "Open qz in the selected browser profile, then retry. Use qz connect uri --client NAME|UUID to reconnect that profile."
      : "Check the connection page in your default browser, then retry. Use qz connect uri to connect a different supported browser profile.",
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startQingzhouMcpBridge, getQingzhouMcpBridgeConfig, getQingzhouMcpConnectionStatus,
  saveQingzhouMcpBridgeConfig,
} from "../../src/background/mcp/mcp-bridge.js";
import { getConnectionConfig, updateConnectionConfig } from "../../src/background/mcp/connection-store.js";
import { BridgeState } from "../../services/mcp-bridge/src/state.mjs";
import { createMcpTransport } from "../../src/background/transports/mcp.js";

const KEY = "_qingzhou_mcp_bridge";
const ID = "_qingzhou_mcp_bridge_client_id";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function drain() { for (let i = 0; i < 120; i++) await Promise.resolve(); }
async function until(check) { for (let i = 0; i < 100; i++) { await drain(); if (check()) return; } assert.fail("expected state did not settle"); }
function setup(t, initial = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  const data = structuredClone(initial), listeners = new Set(), alarmListeners = new Set(), alarms = new Map(), alarmCreates = [];
  const calls = [], statuses = [], instances = [];
  let consent = true, responder, requests = [];
  globalThis.chrome = {
    runtime: { id: "fixture-extension" },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); },
        async set(values) {
          const changes = {};
          for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
          for (const fn of listeners) fn(changes, "local");
        },
      },
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    },
    alarms: {
      async create(name, info) { alarms.set(name, info); alarmCreates.push({ name, info }); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener: fn => alarmListeners.add(fn), removeListener: fn => alarmListeners.delete(fn) },
    },
  };
  const fetch = async (url, options) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body);
    calls.push({ url: String(url), path, body, options });
    if (responder) { const custom = await responder(path, body, options); if (custom !== undefined) return custom; }
    if (path === "/health") return Response.json({ service: "qz-browser-agent", protocolVersion: 1, features: { browserPairing: 1 }, instanceId: "instance-a", version: "0.1.1" });
    if (["/v1/qingzhou/pair", "/v1/qingzhou/rename"].includes(path)) return Response.json({ ok: true, ...body, name: body.name || "default", pairingToken: body.pairingToken });
    if (path === "/v1/qingzhou/poll") { const batch = requests; requests = []; return Response.json({ requests: batch, instanceId: "instance-a", clientId: body.client.id, connectionId: body.client.connectionId, name: data[KEY].name }); }
    return Response.json({ ok: true });
  };
  const start = extra => {
    const r = startQingzhouMcpBridge({ fetch, onStatus: s => statuses.push(s), assertConsent() { if (!consent) throw Object.assign(new Error("Consent required"), { code: "DATA_CONSENT_REQUIRED" }); }, ...extra });
    instances.push(r); return r;
  };
  t.after(() => { for (const r of instances) r.stop(); t.mock.timers.reset(); delete globalThis.chrome; });
  return { data, calls, statuses, alarms, alarmCreates, start, setConsent: v => { consent = v; }, setResponder: fn => { responder = fn; }, setRequests: v => { requests = v; }, tick: async ms => { t.mock.timers.tick(ms); await drain(); }, fireAlarm: async () => { for (const fn of alarmListeners) fn({ name: "qingzhou-mcp-bridge-reconnect" }); await drain(); } };
}

test("new profile and first-use consent stay network/alarms quiet; status is local", async t => {
  const f = setup(t), r = f.start(); await drain();
  assert.equal((await r.status()).state, "disconnected");
  await getQingzhouMcpConnectionStatus(); await getQingzhouMcpBridgeConfig();
  await f.tick(300000); await f.fireAlarm();
  assert.equal(f.calls.length, 0); assert.equal(f.alarmCreates.length, 0);
  await saveQingzhouMcpBridgeConfig({ enabled: true }); await drain();
  assert.equal((await r.status()).state, "disconnected", "configuration writes do not authorize network access");
  f.setConsent(false);
  await assert.rejects(r.connect(), { code: "DATA_CONSENT_REQUIRED" }); assert.equal(f.calls.length, 0);
  f.setConsent(true);
  const s = await r.connect({ name: "work" });
  assert.equal(s.state, "connected"); assert.equal(s.name, "work");
  assert.deepEqual(f.calls.map(c => c.path), ["/health", "/v1/qingzhou/pair", "/v1/qingzhou/poll"]);
  assert.equal("pairingToken" in s, false); assert.equal("pairingToken" in await getQingzhouMcpBridgeConfig(), false);
});

test("unsupported connection formats reset only bridge settings and receive independent UUIDs", async t => {
  const uuid = "0a4d8fbe-7ac7-4ada-9f1e-48263996a709";
  const unrelated = { sessions: [{ id: "user-session", title: "Keep this task" }], model: { provider: "fixture" } };
  const f = setup(t, unrelated), identities = new Set([uuid]);
  for (const [schemaVersion, storedId] of [[undefined, `qingzhou-${uuid}`], [1, uuid], [3, uuid], [2, `qingzhou-${uuid}`]]) {
    f.data[KEY] = { schemaVersion, enabled: true, clientId: "office-chrome", name: "old-name", endpoint: "http://localhost:19999", token: "old-secret",
      authorizationId: "old-authorization", pairingToken: "old-proof", instanceId: "old-instance", state: "connected", attemptsRemaining: 0,
      leaseWaitRemaining: 0, nextRetryAt: 900000, lastError: { code: "OLD_ERROR", message: "old" }, pollTimeoutMs: 90000, includeCapabilities: false };
    f.data[ID] = storedId;
    const config = await getConnectionConfig();
    assert.match(config.clientId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    assert.equal(identities.has(config.clientId), false); identities.add(config.clientId);
    assert.deepEqual(config, {
      schemaVersion: 2, enabled: false, authorizationId: "", clientId: config.clientId, name: "", endpoint: "http://127.0.0.1:18765",
      pairingToken: "", instanceId: "", state: "disconnected", attemptsRemaining: 3, leaseWaitRemaining: 1, nextRetryAt: 0,
      pollIntervalMs: 750, pollTimeoutMs: 20000, requestTimeoutMs: 120000, maxBatch: 4, includeCapabilities: true,
    });
    assert.equal(f.data[ID], config.clientId); assert.deepEqual(f.data[KEY], config);
    assert.deepEqual(await getConnectionConfig(), config, "the new identity remains stable on subsequent reads");
    const runtime = f.start(); await drain(); await f.tick(300000); await f.fireAlarm(); runtime.stop();
  }
  assert.equal(f.calls.length, 0); assert.equal(f.alarmCreates.length, 0);
  assert.deepEqual(f.data.sessions, unrelated.sessions); assert.deepEqual(f.data.model, unrelated.model);
});

test("current connection format preserves identity, endpoint and durable connection state", async t => {
  const f = setup(t), fresh = await getConnectionConfig();
  const current = { ...fresh, enabled: true, name: "office-chrome", endpoint: "http://localhost:19999", authorizationId: "authorization",
    pairingToken: "proof", instanceId: "instance", state: "paused", attemptsRemaining: 0, leaseWaitRemaining: 0, nextRetryAt: 900000,
    connectedAt: 80000, serviceVersion: "0.1.1", lastError: { code: "MCP_CONNECTION_UNAVAILABLE", message: "offline" },
    pollIntervalMs: 1000, pollTimeoutMs: 15000, requestTimeoutMs: 180000, maxBatch: 2, includeCapabilities: false };
  await updateConnectionConfig(() => current);
  assert.deepEqual(await getConnectionConfig(), current);
  const r = f.start(); await drain(); await f.tick(300000); await f.fireAlarm();
  assert.deepEqual(await getConnectionConfig(), current); assert.equal(f.calls.length, 0); assert.equal(f.alarmCreates.length, 0);
  await saveQingzhouMcpBridgeConfig({ clientId: "someone-else", name: "renamed" });
  assert.equal((await getConnectionConfig()).clientId, fresh.clientId); assert.equal((await getConnectionConfig()).name, "renamed");
  r.stop(); assert.equal((await getConnectionConfig()).clientId, fresh.clientId);
});

test("unsupported service pauses after one health request and exposes upgrade guidance", async t => {
  const f = setup(t), r = f.start(); await drain();
  f.setResponder(path => path === "/health" ? Response.json({ service: "qz-browser-agent", protocolVersion: 1, instanceId: "old" }) : undefined);
  const status = await r.connect();
  assert.equal(status.state, "paused"); assert.equal(status.lastError.code, "MCP_CONNECTION_INCOMPATIBLE"); assert.match(status.lastError.message, /tasks to finish.*latest stop.*ALL browsers.*extension in each browser.*latest connect/);
  assert.equal(f.calls.length, 1); await f.tick(300000); await f.fireAlarm(); assert.equal(f.calls.length, 1); assert.equal(f.alarms.size, 0);
});

test("retry budget is reserved before networking and survives repeated worker restarts", async t => {
  const f = setup(t); let r = f.start(); await drain();
  f.setResponder(() => { assert.ok(f.data[KEY].attemptsRemaining < 3); throw new Error("offline"); });
  assert.equal((await r.connect()).retryCount, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.alarms.size, 1);
  for (let attempt = 2; attempt <= 3; attempt++) {
    r.stop(); r = f.start(); await drain();
    assert.equal(f.calls.length, attempt - 1, "restart does not retry before the saved deadline");
    await f.tick(30000); await until(() => f.data[KEY].attemptsRemaining === 3 - attempt);
    await until(() => f.data[KEY].state === (attempt === 3 ? "paused" : "reconnecting"));
  }
  assert.equal((await r.status()).state, "paused"); assert.equal(f.alarms.size, 0);
  r.stop(); r = f.start(); await drain(); await f.tick(300000); await f.fireAlarm(); assert.equal(f.calls.length, 3);
  f.setResponder(undefined); const status = await r.connect(); assert.equal(status.state, "connected"); assert.equal(status.retryCount, 0);
});

test("termination during the final reserved attempt remains paused on restart", async t => {
  const f = setup(t); let r = f.start(); await drain();
  f.setResponder(() => { throw new Error("offline"); }); await r.connect(); await f.tick(30000); await until(() => f.data[KEY].attemptsRemaining === 1); await drain();
  const pending = deferred(); f.setResponder(() => pending.promise);
  await f.tick(30000); await until(() => f.data[KEY].attemptsRemaining === 0);
  r.stop(); r = f.start(); await drain();
  assert.equal((await r.status()).state, "paused"); const n = f.calls.length;
  pending.resolve(Response.json({})); await drain(); await f.tick(300000); assert.equal(f.calls.length, n);
});

test("worker restart has a new lease id, retains token, and does not steal a live copied profile", async t => {
  const f = setup(t); let r = f.start(); await drain(); await r.connect();
  const first = f.calls.find(c => c.path.endsWith("/pair")).body;
  r.stop(); f.setResponder(path => path.endsWith("/pair") ? Response.json({ code: "BRIDGE_CLIENT_IN_USE", error: "Another profile is connected" }, { status: 409 }) : undefined);
  r = f.start(); await drain(); await f.tick(0); await until(() => f.data[KEY].state === "reconnecting");
  const second = f.calls.filter(c => c.path.endsWith("/pair")).at(-1).body;
  assert.notEqual(second.connectionId, first.connectionId); assert.equal(second.clientId, first.clientId); assert.equal(second.pairingToken, first.pairingToken);
  assert.equal(f.calls.filter(c => c.path.endsWith("/poll")).length, 1, "conflicting lease never polls or dispatches");
  f.setResponder(undefined); await f.tick(30000); await until(() => f.data[KEY].state === "connected");
});

test("the final retry can wait once for the previous worker lease without an unbounded restart budget", async t => {
  const f = setup(t); let r = f.start(); await drain(); await r.connect(); r.stop();
  const stoppedAt = Date.now(), expiresAt = stoppedAt + 35750;
  await updateConnectionConfig(current => ({ ...current, state: "connecting", attemptsRemaining: 1, nextRetryAt: stoppedAt + 30000 }));
  f.setResponder(path => path.endsWith("/pair") && Date.now() < expiresAt ? Response.json({ code: "BRIDGE_CLIENT_IN_USE", error: "previous worker lease active", retryAfterMs: expiresAt - Date.now() }, { status: 409 }) : undefined);
  r = f.start(); await drain(); await f.tick(30000); await until(() => f.data[KEY].leaseWaitRemaining === 0);
  assert.equal(f.data[KEY].attemptsRemaining, 1); assert.equal(f.data[KEY].state, "reconnecting");
  const count = f.calls.length;
  r.stop(); r = f.start(); await drain(); await f.fireAlarm(); await f.tick(5749);
  assert.equal(f.calls.length, count, "a worker restart cannot shorten the service lease deadline");
  await f.tick(101); await until(() => f.data[KEY].state === "connected");
  assert.equal(f.data[KEY].attemptsRemaining, 3); assert.equal(f.data[KEY].leaseWaitRemaining, 1);
});

test("a healthy copied profile cannot refund lease waits indefinitely across worker restarts", async t => {
  const f = setup(t); let r = f.start(); await drain();
  f.setResponder(path => path.endsWith("/pair") ? Response.json({ code: "BRIDGE_CLIENT_IN_USE", error: "healthy original remains connected", retryAfterMs: 40000 }, { status: 409 }) : undefined);
  await r.connect(); assert.equal(f.data[KEY].leaseWaitRemaining, 0); assert.equal(f.data[KEY].attemptsRemaining, 3);
  for (let i = 0; i < 3; i++) {
    r.stop(); r = f.start(); await drain(); await f.tick(i === 0 ? 40100 : 30000);
    await until(() => f.data[KEY].attemptsRemaining === 2 - i);
    await drain();
  }
  assert.equal((await r.status()).state, "paused"); assert.equal(f.alarms.size, 0);
  assert.equal(f.calls.filter(c => c.path.endsWith("/pair")).length, 4);
  const count = f.calls.length; await f.tick(300000); await f.fireAlarm(); assert.equal(f.calls.length, count);
});

test("explicit endpoint changes preserve the profile proof used by the persistent registry", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect({ endpoint: "http://127.0.0.1:23001", name: "work" });
  const first = f.calls.find(c => c.path.endsWith("/pair")).body;
  await r.connect({ endpoint: "http://127.0.0.1:23002", name: "work" });
  const second = f.calls.filter(c => c.path.endsWith("/pair")).at(-1).body;
  assert.equal(second.clientId, first.clientId); assert.equal(second.pairingToken, first.pairingToken);
  assert.notEqual(second.connectionId, first.connectionId); assert.equal((await r.status()).state, "connected");
});

test("an immediate connect after cold start uses the persisted endpoint", async t => {
  const f = setup(t); let r = f.start(); await drain(); await r.connect({ endpoint: "http://127.0.0.1:19999", name: "work" });
  const token = f.data[KEY].pairingToken; r.stop(); f.calls.length = 0;
  r = f.start(); const status = await r.connect();
  assert.equal(status.endpoint, "http://127.0.0.1:19999"); assert.equal(status.state, "connected");
  assert.equal(f.data[KEY].pairingToken, token);
  for (const call of f.calls) assert.equal(new URL(call.url).port, "19999");
});

test("disconnect during health/pair aborts and cannot re-enable a late response", async t => {
  for (const gate of ["/health", "/v1/qingzhou/pair"]) {
    const f = setup(t), r = f.start(); await drain(); const pending = deferred();
    f.setResponder(path => path === gate ? pending.promise : undefined);
    const connecting = r.connect(); await until(() => f.calls.some(c => c.path === gate));
    const signal = f.calls.find(c => c.path === gate).options.signal;
    await r.disconnect(); assert.equal(signal.aborted, true);
    pending.resolve(Response.json({ service: "qz-browser-agent", protocolVersion: 1, features: { browserPairing: 1 }, instanceId: "instance-a" }));
    await connecting; await drain();
    assert.equal((await r.status()).state, "disconnected"); assert.equal(f.data[KEY].enabled, false);
    const n = f.calls.length; await f.tick(300000); await f.fireAlarm(); assert.equal(f.calls.length, n); r.stop();
    t.mock.timers.reset();
  }
});

test("renaming keeps the healthy connection and in-flight task authority", async t => {
  const f = setup(t), pending = deferred(); let signal;
  const r = f.start({ dispatch(request) { signal = request.signal; return pending.promise; } }); await drain();
  f.setRequests([{ id: "same-id", method: "create_session" }]); await r.connect({ name: "first" }); await until(() => signal);
  const old = f.calls.find(c => c.path.endsWith("/pair")).body;
  await r.connect({ name: "renamed" }); assert.equal(signal.aborted, false);
  pending.resolve({ result: "kept" }); await until(() => f.calls.some(c => c.path.endsWith("/result")));
  const renamed = f.calls.find(c => c.path.endsWith("/rename")); assert.equal(renamed.body.connectionId, old.connectionId);
  assert.equal(f.calls.find(c => c.path.endsWith("/result")).body.connectionId, old.connectionId);
  assert.equal(f.calls.some(c => c.path.endsWith("/disconnect")), false);
  assert.equal((await r.status()).name, "renamed");
  const count = f.calls.length;
  for (const input of [{}, { name: "" }, { name: "renamed" }]) assert.equal((await r.connect(input)).name, "renamed");
  assert.equal(f.calls.length, count, "same-profile rebinding is idempotent");
});

test("a rejected name change preserves the old healthy connection and can retry", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect({ name: "first" });
  const original = structuredClone(f.data[KEY]);
  f.setResponder(path => path.endsWith("/rename") ? Response.json({ code: "BRIDGE_NAME_IN_USE", error: "Name is taken" }, { status: 409 }) : undefined);
  await assert.rejects(r.connect({ name: "taken" }), { code: "BRIDGE_NAME_IN_USE" });
  assert.deepEqual(f.data[KEY], original); assert.equal((await r.status()).state, "connected");
  assert.equal(f.calls.some(c => c.path.endsWith("/disconnect")), false);
  f.setResponder(undefined); await f.tick(750); await until(() => f.calls.filter(c => c.path.endsWith("/poll")).length === 2);
  assert.equal((await r.connect({ name: "available" })).name, "available");
});

test("queued renames serialize and disconnect revokes a pending rename", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect({ name: "first" });
  const gate = deferred();
  f.setResponder(async (path, body) => { if (path.endsWith("/rename") && body.name === "second") await gate.promise; });
  const first = r.connect({ name: "second" }), second = r.connect({ name: "third" });
  await until(() => f.calls.some(c => c.path.endsWith("/rename") && c.body.name === "second"));
  assert.equal(f.calls.some(c => c.body?.name === "third"), false);
  gate.resolve(); await Promise.all([first, second]); assert.equal((await r.status()).name, "third");
  const late = deferred(); f.setResponder(path => path.endsWith("/rename") ? late.promise : undefined);
  const pending = r.connect({ name: "late" }); const rejected = assert.rejects(pending, { code: "MCP_CONNECTION_CANCELLED" });
  await until(() => f.calls.some(c => c.body?.name === "late"));
  const signal = f.calls.at(-1).options.signal;
  await r.disconnect(); assert.equal(signal.aborted, true); await rejected;
  late.resolve(Response.json({ ok: true })); await drain();
  assert.equal((await r.status()).state, "disconnected"); assert.equal(f.data[KEY].name, "third");
});

async function realServiceRuntime(t, intercept = (_path, _body, proceed) => proceed()) {
  const f = setup(t), state = new BridgeState();
  t.after(() => state.close());
  f.setResponder(async (path, body, options) => {
    const proceed = async () => {
      try {
        if (path === "/health") return Response.json({ service: "qz-browser-agent", protocolVersion: 1, features: { browserPairing: 1 }, instanceId: state.instanceId });
        if (path.endsWith("/pair")) return Response.json(await state.pair(body));
        if (path.endsWith("/rename")) return Response.json(await state.rename(body));
        if (path.endsWith("/disconnect")) return Response.json(await state.disconnect(body));
        if (path.endsWith("/poll")) {
          const requests = await state.poll(body.client, { timeoutMs: 1 });
          return Response.json({ requests, ...state.connectionInfo(body.client) });
        }
        throw new Error(`Unexpected route ${path}`);
      } catch (error) { return Response.json({ code: error.code, error: error.message }, { status: 409 }); }
    };
    return intercept(path, body, proceed, options);
  });
  const r = f.start(); await drain();
  const connecting = r.connect({ name: "first" });
  await until(() => f.calls.some(call => call.path.endsWith("/poll"))); await f.tick(100);
  await connecting;
  assert.equal((await r.status()).state, "connected");
  return { ...f, r, state };
}

test("a lost rename acknowledgement converges through an authoritative healthy poll", async t => {
  const f = await realServiceRuntime(t, async (path, _body, proceed) => {
    const response = await proceed();
    if (path.endsWith("/rename")) throw new Error("response lost after service commit");
    return response;
  });
  await assert.rejects(f.r.connect({ name: "renamed" }), /response lost/);
  assert.equal((await f.r.status()).name, "first", "an unknown outcome is not reported as successful");
  assert.equal(f.state.status().clients[0].name, "renamed");
  await f.tick(750); await f.tick(100);
  assert.equal((await f.r.status()).name, "renamed"); assert.equal(f.data[KEY].name, "renamed");
  assert.equal((await f.r.status()).state, "connected");
  assert.equal(f.calls.filter(call => call.path.endsWith("/rename")).length, 1, "reconciliation does not resend the mutation");
  assert.equal(f.calls.filter(call => call.path.endsWith("/pair")).length, 1);
});

test("a rename processed after disconnect cannot recreate the cancelled service connection", async t => {
  const gate = deferred(), processed = deferred();
  const f = await realServiceRuntime(t, async (path, _body, proceed) => {
    if (path.endsWith("/rename")) {
      await gate.promise; const response = await proceed(); processed.resolve(await response.clone().json()); return response;
    }
    return proceed();
  });
  const changing = f.r.connect({ name: "late" }), rejected = assert.rejects(changing, { code: "MCP_CONNECTION_CANCELLED" });
  await until(() => f.calls.some(call => call.path.endsWith("/rename")));
  await f.r.disconnect(); await rejected;
  gate.resolve();
  assert.equal((await processed.promise).code, "BRIDGE_PAIRING_REQUIRED");
  assert.equal(f.state.status().clientCount, 0); assert.equal(f.state.registry.list()[0].name, "first");
  assert.equal((await f.r.status()).state, "disconnected"); assert.equal(f.data[KEY].name, "first");
});

test("a pre-rename poll delivered late cannot overwrite the acknowledged name", async t => {
  const gate = deferred(), captured = deferred(); let hold = false;
  const f = await realServiceRuntime(t, async (path, _body, proceed) => {
    const response = await proceed();
    if (hold && path.endsWith("/poll")) { captured.resolve(await response.clone().json()); await gate.promise; }
    return response;
  });
  hold = true; await f.tick(750); await f.tick(100);
  assert.equal((await captured.promise).name, "first");
  await f.r.connect({ name: "renamed" });
  gate.resolve(); await drain();
  assert.equal((await f.r.status()).name, "renamed"); assert.equal(f.data[KEY].name, "renamed");
  assert.equal(f.state.status().clients[0].name, "renamed");
  hold = false; await f.tick(750); await f.tick(100);
  assert.equal((await f.r.status()).state, "connected"); assert.equal(f.data[KEY].name, "renamed");
});

test("queued transport work is cancelled before readiness resolves", async t => {
  setup(t); const ready = deferred(), controller = new AbortController(); let started = false;
  const transport = createMcpTransport({ system: { ready: () => ready.promise }, sessions: { create: () => { started = true; } } });
  const task = transport.dispatch({ method: "create_session", params: {}, signal: controller.signal }); controller.abort(new Error("disconnected")); ready.resolve();
  await assert.rejects(task, /disconnected/); assert.equal(started, false);
});

test("tool transport forwards connection cancellation without exposing it as a wire parameter", async t => {
  setup(t); const controller = new AbortController(); let received;
  const transport = createMcpTransport({ system: { ready() {} }, tools: { execute(params, signal) { received = { params, signal }; } } });
  await transport.dispatch({ method: "execute_tool", params: { name: "read_article" }, signal: controller.signal });
  assert.deepEqual(received.params, { name: "read_article" }); assert.equal(received.signal, controller.signal);
});

test("task admission routes carry the internal connection signal", async t => {
  setup(t); const controller = new AbortController(), seen = [];
  const transport = createMcpTransport({ system: { ready() {} }, sessions: Object.fromEntries(["create", "send", "followUp"].map(method => [method, (params, signal) => seen.push({ method, params, signal })])) });
  for (const method of ["create_session", "send_message", "follow_up"]) await transport.dispatch({ method, params: { text: "task" }, signal: controller.signal });
  assert.deepEqual(seen.map(x => x.method), ["create", "send", "followUp"]);
  for (const entry of seen) { assert.equal(entry.signal, controller.signal); assert.deepEqual(entry.params, { text: "task" }); }
});

test("resource and settings writes receive connection authority separately from wire arguments", async t => {
  setup(t); const controller = new AbortController(), seen = [];
  const capture = (params, signal) => seen.push({ params, signal });
  const transport = createMcpTransport({ system: { ready() {} }, data: { deleteTable: capture, exportTable: capture, deleteImageCollection: capture, exportImageCollection: capture }, skills: { export: capture }, settings: { update: capture } });
  for (const method of ["delete_data_table", "export_data_table", "delete_image_collection", "export_image_collection", "export_skill", "update_settings"]) {
    await transport.dispatch({ method, params: { target: method }, signal: controller.signal });
  }
  assert.equal(seen.length, 6);
  for (const entry of seen) { assert.equal(entry.signal, controller.signal); assert.deepEqual(Object.keys(entry.params), ["target"]); }
});

test("pending-input and terminal routes retain internal connection authority", async t => {
  setup(t); const controller = new AbortController(), seen = [];
  const capture = (...args) => seen.push(args);
  const transport = createMcpTransport({ system: { ready() {}, runtimeMessage: capture }, sessions: {
    respondToUserInput: capture, continueWait: capture, submitWaitForm: capture, cancelWait: capture, stop: capture, clearGoal: capture,
  }, config: { save: capture }, automations: { run: capture } });
  for (const method of ["respond_to_user_input", "continue_task", "submit_wait_form", "cancel_wait", "stop_session", "runtime_message", "clear_goal", "save_config", "run_automation"]) {
    await transport.dispatch({ method, params: { sessionId: "task", waitId: "wait" }, signal: controller.signal });
  }
  assert.equal(seen.length, 9); for (const args of seen) assert.equal(args.at(-1), controller.signal);
});

test("config disable during dispatch, and a delayed config read, cannot resurrect network work", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect();
  const read = chrome.storage.local.get, gate = deferred(); let intercepted = false;
  chrome.storage.local.get = async keys => { const value = await read(keys); if (!intercepted) { intercepted = true; await gate.promise; } return value; };
  const status = r.status(); await until(() => intercepted);
  const disconnect = r.disconnect(); gate.resolve(); await disconnect; await status;
  assert.equal((await r.status()).state, "disconnected"); const n = f.calls.length;
  await f.tick(300000); assert.equal(f.calls.length, n);
});

test("result posting carries the exact pairing, instance and worker fence; errors redact provider details", async t => {
  const f = setup(t), r = f.start({ dispatch() { throw Object.assign(new Error("missing"), { code: "SKILL_NOT_FOUND", details: { name: "fixture", apiKey: "must-not-leak" } }); } }); await drain();
  f.setRequests([{ id: "error-id", method: "get_skill" }]); await r.connect(); await until(() => f.calls.some(c => c.path.endsWith("/result")));
  const result = f.calls.find(c => c.path.endsWith("/result")).body, pair = f.calls.find(c => c.path.endsWith("/pair")).body;
  assert.equal(result.connectionId, pair.connectionId); assert.equal(result.instanceId, "instance-a"); assert.equal(result.pairingToken, pair.pairingToken);
  assert.equal(result.code, "SKILL_NOT_FOUND"); assert.deepEqual(result.details, { name: "fixture" });
});

test("pair credentials are durable before networking and survive a lost pairing response", async t => {
  const f = setup(t), r = f.start(); await drain(); let first;
  f.setResponder((path, body) => {
    assert.match(f.data[KEY].pairingToken, /^[A-Za-z0-9_-]{43}$/);
    if (path.endsWith("/pair") && !first) { first = body; throw new Error("response lost after pairing"); }
    if (path.endsWith("/pair")) assert.deepEqual(body, first);
  });
  assert.equal((await r.connect()).state, "reconnecting");
  await f.tick(30000); await until(() => f.data[KEY].state === "connected");
  assert.equal(f.calls.filter(c => c.path.endsWith("/pair")).length, 2);
  assert.equal(f.data[KEY].pairingToken, first.pairingToken);
});

test("losing the explicit connection page during health pauses instead of retrying without its authority", async t => {
  const f = setup(t), r = f.start(); await drain(); let checks = 0;
  const status = await r.connect({}, () => {
    if (++checks === 3) throw Object.assign(new Error("connection page changed"), { code: "MCP_CONNECTION_PAGE_CHANGED" });
  });
  assert.equal(status.state, "paused"); assert.deepEqual(f.calls.map(c => c.path), ["/health"]);
  assert.equal(f.alarms.size, 0); await f.tick(300000); await f.fireAlarm(); assert.equal(f.calls.length, 1);
});

test("connected workers retain one wake-up alarm and disconnect removes it", async t => {
  const f = setup(t); let r = f.start(); await drain(); await r.connect();
  assert.equal(f.alarms.size, 1); assert.equal([...f.alarms.values()][0].periodInMinutes, 0.5);
  const count = f.calls.length;
  r.stop(); r = f.start(); await drain(); await f.fireAlarm();
  await until(() => f.calls.length > count && f.data[KEY].state === "connected");
  assert.equal(f.alarms.size, 1);
  await r.disconnect(); assert.equal(f.alarms.size, 0);
  const stopped = f.calls.length; await f.fireAlarm(); await f.tick(300000); assert.equal(f.calls.length, stopped);
});

test("failed polls revoke in-flight request authority before a new connection attempt", async t => {
  const f = setup(t), pending = deferred(); let signal;
  const r = f.start({ dispatch(request) { signal = request.signal; return pending.promise; } }); await drain();
  f.setRequests([{ id: "old-request", method: "create_session" }]); await r.connect(); await until(() => signal);
  f.setResponder(path => path.endsWith("/poll") ? Response.json({ code: "BRIDGE_INSTANCE_CHANGED", error: "service restarted" }, { status: 409 }) : undefined);
  await f.tick(0); await until(() => f.data[KEY].state === "reconnecting");
  assert.equal(signal.aborted, true); pending.resolve({ sessionId: "obsolete" }); await drain();
  assert.equal(f.calls.filter(c => c.path.endsWith("/result")).length, 0);
  f.setResponder(undefined); await f.tick(30000); await until(() => f.data[KEY].state === "connected");
  const pairs = f.calls.filter(c => c.path.endsWith("/pair"));
  assert.notEqual(pairs[0].body.connectionId, pairs[1].body.connectionId);
});

test("invalid names fail locally before replacing a healthy connection", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect({ name: "work-Chrome_2" });
  const count = f.calls.length;
  for (const name of ["two words", "中文", "-leading", "a/b", "0a4d8fbe-7ac7-4ada-9f1e-48263996a709"]) {
    await assert.rejects(r.connect({ name }), { code: "BRIDGE_NAME_INVALID" });
  }
  assert.equal(f.calls.length, count); assert.equal((await r.status()).state, "connected");
});

test("connection URLs remain loopback-only and HTTP redirects never dispatch commands", async t => {
  const f = setup(t), r = f.start(); await drain();
  for (const endpoint of ["https://example.com", "http://127.0.0.1.evil.test", "http://user@localhost:123", "http://localhost:123/path", "http://localhost:123?target=x"]) {
    await assert.rejects(r.connect({ endpoint }), { code: "MCP_CONNECTION_INVALID_ENDPOINT" });
  }
  assert.equal(f.calls.length, 0);
  let dispatched = false;
  r.stop(); const next = f.start({ dispatch() { dispatched = true; } }); await drain();
  f.setResponder((_path, _body, options) => {
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    throw new TypeError("redirect rejected");
  });
  assert.equal((await next.connect({ endpoint: "http://localhost:123" })).state, "reconnecting");
  assert.equal(dispatched, false); assert.equal(f.calls.length, 1);
});

test("slow requests keep polling, duplicate request IDs execute once, and equivalent config preserves authority", async t => {
  const f = setup(t), pending = deferred(); const seen = [];
  const r = f.start({ dispatch(request) { seen.push(request); return pending.promise; } }); await drain();
  f.setRequests([{ id: "slow", method: "get_session_state" }]); await r.connect(); await until(() => seen.length === 1);
  await saveQingzhouMcpBridgeConfig({ name: "default" });
  f.setRequests([{ id: "slow", method: "get_session_state" }, { id: "other", method: "get_config" }]);
  await f.tick(0); await until(() => seen.length === 2);
  assert.deepEqual(seen.map(r => r.id), ["slow", "other"]); assert.equal(seen[0].signal.aborted, false);
  pending.resolve({ delivered: true }); await until(() => f.calls.filter(c => c.path.endsWith("/result")).length === 2);
});

test("changing config while a poll is pending revokes the old response before dispatch", async t => {
  const f = setup(t), pending = deferred(); let dispatched = false;
  const r = f.start({ dispatch() { dispatched = true; } }); await drain();
  f.setResponder(path => path.endsWith("/poll") ? pending.promise : undefined);
  const connection = r.connect(); await until(() => f.calls.some(c => c.path.endsWith("/poll")));
  await saveQingzhouMcpBridgeConfig({ enabled: false });
  pending.resolve(Response.json({ requests: [{ id: "obsolete", method: "create_session" }] })); await connection; await drain();
  assert.equal(dispatched, false); assert.equal((await r.status()).state, "disconnected"); assert.equal(f.alarms.size, 0);
});

test("public error details retain download recovery fields and strip arbitrary credential data", async t => {
  const f = setup(t), r = f.start({ dispatch(request) {
    throw Object.assign(new Error("operation failed"), request.id === "download" ? { code: "DOWNLOAD_INTERRUPTED", details: { downloadId: 42, filename: "report.zip", reason: "USER_CANCELED", token: "private-key" } }
      : { code: "PROVIDER_ERROR", details: { apiKey: "private-key" } });
  } }); await drain();
  f.setRequests([{ id: "download", method: "list_downloads" }, { id: "provider", method: "create_session" }]); await r.connect();
  await until(() => f.calls.filter(c => c.path.endsWith("/result")).length === 2);
  const results = f.calls.filter(c => c.path.endsWith("/result")).map(c => c.body);
  assert.deepEqual(results[0].details, { downloadId: 42, filename: "report.zip", reason: "USER_CANCELED" });
  assert.deepEqual(results[1].details, {}); assert.equal(JSON.stringify(results).includes("private-key"), false);
});


test("changing endpoint revokes an in-flight and queued name change without touching the new connection", async t => {
  const f = setup(t), r = f.start(); await drain(); await r.connect({ name: "first" });
  const gate = deferred(); f.setResponder((path, body) => path.endsWith("/rename") && body.name === "late" ? gate.promise : undefined);
  const renaming = r.connect({ name: "late" }), queued = r.connect({ name: "queued" });
  const rejected = [assert.rejects(renaming, { code: "MCP_CONNECTION_CANCELLED" }), assert.rejects(queued, { code: "MCP_CONNECTION_CANCELLED" })];
  await until(() => f.calls.some(c => c.body?.name === "late"));
  const changed = await r.connect({ endpoint: "http://127.0.0.1:23002", name: "new-service" });
  await Promise.all(rejected); gate.resolve(Response.json({ ok: true })); await drain();
  assert.equal(changed.state, "connected"); assert.equal(changed.name, "new-service");
  assert.equal(f.calls.some(c => c.body?.name === "queued"), false);
  assert.equal((await r.status()).endpoint, "http://127.0.0.1:23002");
});

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const RECONNECT = "qingzhou-mcp-bridge-reconnect";

test("chrome bridge restarts keep a fresh lease id out of storage", async t => {
  const f = setup(t);
  assert.notEqual(globalThis.chrome.qzFirefoxMcpWake, true);
  let r = f.start(); await drain(); await r.connect();
  const first = f.calls.find(c => c.path.endsWith("/pair")).body.connectionId;
  assert.equal(f.data[KEY].connectionId, undefined);
  assert.equal("connectionId" in await getQingzhouMcpBridgeConfig(), false);
  r.stop(); r = f.start(); await drain(); await f.tick(0);
  await until(() => f.calls.filter(c => c.path.endsWith("/pair")).length >= 2);
  const second = f.calls.filter(c => c.path.endsWith("/pair")).at(-1).body.connectionId;
  assert.notEqual(second, first);
  assert.equal(f.data[KEY].connectionId, undefined);
  assert.equal(f.alarms.has(RECONNECT), true);
});

test("firefox wake reuses the stored lease and refills transport retries", async t => {
  const f = setup(t);
  globalThis.chrome.qzFirefoxMcpWake = true;
  let r = f.start(); await drain(); await r.connect({ name: "firefox" });
  const lease = f.data[KEY].connectionId;
  const token = f.data[KEY].pairingToken;
  assert.match(lease, UUID);
  assert.equal("connectionId" in await getQingzhouMcpBridgeConfig(), false);
  assert.equal(f.alarms.has(RECONNECT), true);
  r.stop(); f.calls.length = 0;
  r = f.start(); await drain(); await f.tick(0);
  await until(() => f.data[KEY].state === "connected");
  const resumed = f.calls.find(c => c.path.endsWith("/pair")).body;
  assert.equal(resumed.connectionId, lease);
  assert.equal(resumed.pairingToken, token);
  assert.equal(f.alarms.has(RECONNECT), true);

  r.stop();
  f.data[KEY] = { ...f.data[KEY], state: "paused", attemptsRemaining: 0, nextRetryAt: Date.now() + 30000,
    lastError: { code: "MCP_CONNECTION_UNAVAILABLE", message: "suspended" } };
  f.calls.length = 0;
  r = f.start(); await drain();
  assert.equal(f.data[KEY].state, "reconnecting");
  assert.equal(f.data[KEY].attemptsRemaining, 3);
  assert.equal(f.data[KEY].connectionId, lease);
  assert.equal(f.alarms.has(RECONNECT), true);
  await f.tick(30000);
  await until(() => f.data[KEY].state === "connected");
  assert.equal(f.calls.find(c => c.path.endsWith("/pair")).body.connectionId, lease);

  await r.disconnect();
  assert.equal(f.data[KEY].connectionId, undefined);
  assert.equal(f.data[KEY].enabled, false);
  assert.equal(f.alarms.has(RECONNECT), false);
});

test("firefox transport failures keep the reconnect alarm armed", async t => {
  const f = setup(t);
  globalThis.chrome.qzFirefoxMcpWake = true;
  f.setResponder(() => { throw new Error("offline"); });
  const r = f.start(); await drain(); await r.connect();
  assert.equal(f.data[KEY].state, "reconnecting");
  assert.equal(f.alarms.has(RECONNECT), true);
  await f.tick(30000);
  await until(() => f.data[KEY].attemptsRemaining === 1);
  await f.tick(30000);
  await until(() => f.data[KEY].attemptsRemaining === 3);
  assert.equal(f.data[KEY].state, "reconnecting");
  assert.equal(f.alarms.has(RECONNECT), true);
  const before = f.calls.length;
  f.setResponder(undefined);
  await f.tick(30000);
  await until(() => f.data[KEY].state === "connected");
  assert.ok(f.calls.length > before);
  assert.equal(f.alarms.has(RECONNECT), true);
});

test("firefox still pauses a live foreign lease", async t => {
  const foreign = setup(t);
  globalThis.chrome.qzFirefoxMcpWake = true;
  foreign.setResponder(path => path.endsWith("/pair") ? Response.json({ code: "BRIDGE_CLIENT_IN_USE", error: "healthy original remains connected", retryAfterMs: 40000 }, { status: 409 }) : undefined);
  let runtime = foreign.start(); await drain();
  await runtime.connect();
  assert.equal(foreign.data[KEY].leaseWaitRemaining, 0);
  for (let i = 0; i < 3; i++) {
    runtime.stop(); runtime = foreign.start(); await drain();
    await foreign.tick(i === 0 ? 40100 : 30000);
    await until(() => foreign.data[KEY].attemptsRemaining === 2 - i);
    await drain();
  }
  assert.equal((await runtime.status()).state, "paused");
  assert.equal(foreign.alarms.size, 0);
  const held = foreign.calls.length;
  await foreign.tick(300000); await foreign.fireAlarm();
  assert.equal(foreign.calls.length, held);
});

test("firefox keeps an incompatible bridge paused", async t => {
  const incompatible = setup(t);
  globalThis.chrome.qzFirefoxMcpWake = true;
  incompatible.setResponder(path => path === "/health" ? Response.json({ service: "qz-browser-agent", protocolVersion: 1, instanceId: "old" }) : undefined);
  const paused = incompatible.start(); await drain();
  assert.equal((await paused.connect()).state, "paused");
  assert.equal(incompatible.data[KEY].lastError.code, "MCP_CONNECTION_INCOMPATIBLE");
  paused.stop();
  const again = incompatible.start(); await drain(); await incompatible.tick(300000); await incompatible.fireAlarm();
  assert.equal(incompatible.calls.length, 1);
  assert.equal(incompatible.alarms.size, 0);
  assert.equal((await again.status()).state, "paused");
});

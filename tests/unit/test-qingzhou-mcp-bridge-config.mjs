import assert from "node:assert/strict";

const storageData = {};
const listeners = [];
const alarms = new Map();
const alarmListeners = [];
const alarmCreations = [];
const reconnectAlarm = "qingzhou-mcp-bridge-reconnect";

globalThis.chrome = {
  runtime: { id: "test-extension" },
  alarms: {
    async create(name, info) { alarms.set(name, { name, ...info }); alarmCreations.push({ name, ...info }); },
    async clear(name) { return alarms.delete(name); },
    onAlarm: {
      addListener(listener) { alarmListeners.push(listener); },
      removeListener(listener) { const index = alarmListeners.indexOf(listener); if (index >= 0) alarmListeners.splice(index, 1); },
    },
  },
  storage: {
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      },
      removeListener(fn) {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storageData[item]]));
        }
        if (typeof key === "string") return { [key]: storageData[key] };
        return { ...storageData };
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values || {})) {
          changes[key] = { oldValue: storageData[key], newValue: value };
          storageData[key] = value;
        }
        for (const listener of listeners.slice()) listener(changes, "local");
      },
    },
  },
};

const bridge = await import("../../src/background/mcp/mcp-bridge.js?test=mcp-config");

let config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, true, "MCP bridge defaults on; startup is gated by data consent");
assert.match(config.clientId, /^qingzhou-[\da-f-]{36}$/);
assert.equal(config.clientId, storageData._qingzhou_mcp_bridge_client_id);
const defaultIdentity = config.clientId;
assert.equal((await bridge.getQingzhouMcpBridgeConfig()).clientId, defaultIdentity, "profile identity survives config reloads");
const restartedBridge = await import("../../src/background/mcp/mcp-bridge.js?test=mcp-restart");
assert.equal((await restartedBridge.getQingzhouMcpBridgeConfig()).clientId, defaultIdentity, "a fresh worker loads the persisted identity");
delete storageData._qingzhou_mcp_bridge_client_id;
const otherProfile = await import("../../src/background/mcp/mcp-bridge.js?test=mcp-other-profile");
assert.notEqual((await otherProfile.getQingzhouMcpBridgeConfig()).clientId, defaultIdentity, "browser profiles get distinct identities");
storageData._qingzhou_mcp_bridge_client_id = defaultIdentity;
storageData._qingzhou_mcp_bridge = { clientId: " " };
assert.equal((await bridge.getQingzhouMcpBridgeConfig()).clientId, defaultIdentity);
assert.equal((await bridge.saveQingzhouMcpBridgeConfig({ clientId: " " })).clientId, defaultIdentity);
assert.equal((await bridge.saveQingzhouMcpBridgeConfig({ clientId: "" })).clientId, defaultIdentity);
delete storageData._qingzhou_mcp_bridge;

storageData.llmConfig = { debugMode: true };
config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, true, "debug mode does not control bridge connectivity");
assert.equal(config.endpoint, "http://127.0.0.1:18765");
assert.equal(config.pollTimeoutMs, 20000, "default polling stays below Chrome's fetch deadline");
assert.equal("token" in config, false);

for (const pollTimeoutMs of [30000, 120000]) {
  storageData._qingzhou_mcp_bridge = { pollTimeoutMs };
  assert.equal((await bridge.getQingzhouMcpBridgeConfig()).pollTimeoutMs, 20000,
    "existing long-poll configurations must inherit the safe worker timeout");
}

storageData._qingzhou_mcp_bridge = { enabled: false, endpoint: "http://evil.example:9", token: "secret" };
config = await bridge.getQingzhouMcpBridgeConfig();
assert.equal(config.enabled, false, "explicit bridge config should override debug-mode default");
assert.equal(config.endpoint, "http://127.0.0.1:18765", "bridge endpoint should stay localhost-only");
assert.equal("token" in config, false, "legacy pairing tokens are ignored");

const saved = await bridge.saveQingzhouMcpBridgeConfig({ enabled: true, endpoint: "http://localhost:18765" });
assert.equal(saved.enabled, true);
assert.equal(saved.endpoint, "http://localhost:18765");
assert.equal(storageData._qingzhou_mcp_bridge.enabled, true);
assert.equal("token" in storageData._qingzhou_mcp_bridge, false, "saving removes obsolete pairing credentials");

const traces = [];
globalThis.fetch = async () => {
  throw new Error("Failed to fetch");
};
const runtime = bridge.startQingzhouMcpBridge({
  dispatch: async () => ({}),
  describe: () => ({ tools: [] }),
  trace: (message) => traces.push(message),
});
try {
  await waitFor(() => traces.some((message) => message.includes("local bridge unavailable")));
  assert.ok(traces.some((message) => message.includes("enabled; polling")), "bridge should trace polling state");
  assert.equal(
    traces.filter((message) => message.includes("local bridge unavailable")).length,
    1,
    "bridge failure trace should be throttled while status is unchanged",
  );
} finally {
  runtime.stop();
}

await chrome.storage.local.set({
  _qingzhou_mcp_bridge: {
    enabled: true,
    endpoint: "http://127.0.0.1:18765",
    clientId: "test-extension",
    pollIntervalMs: 100,
    pollTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    maxBatch: 1,
  },
});

const resultPosts = [];
let pollCount = 0;
let releaseSlowRequest;
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(String(url)).pathname;
  if (pathname === "/v1/qingzhou/poll") {
    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({ requests: [{ id: "slow-1", method: "execute_tool", params: {}, timeoutMs: 1000 }] });
    }
    if (pollCount === 2) {
      return jsonResponse({ requests: [{ id: "fast-1", method: "ping", params: {}, timeoutMs: 1000 }] });
    }
    return jsonResponse({ requests: [] });
  }
  if (pathname === "/v1/qingzhou/result") {
    resultPosts.push(JSON.parse(options.body || "{}"));
    return jsonResponse({ ok: true });
  }
  throw new Error(`unexpected fetch url: ${url}`);
};

const asyncRuntime = bridge.startQingzhouMcpBridge({
  dispatch: async ({ method }) => {
    if (method === "execute_tool") {
      await new Promise(resolve => {
        releaseSlowRequest = resolve;
      });
      return { slow: true };
    }
    if (method === "ping") return { pong: true };
    return {};
  },
  describe: () => ({ methods: ["execute_tool", "ping"] }),
  trace: () => {},
});
try {
  await waitFor(() => resultPosts.some(item => item.requestId === "fast-1"), 1000);
  assert.ok(pollCount >= 2, "bridge should keep polling while a previous request is still running");
  assert.deepEqual(
    resultPosts.find(item => item.requestId === "fast-1")?.result,
    { pong: true },
    "fast request should complete before slow execute_tool resolves",
  );
  assert.equal(
    resultPosts.some(item => item.requestId === "slow-1"),
    false,
    "slow request should not have completed yet",
  );
  releaseSlowRequest();
  await waitFor(() => resultPosts.some(item => item.requestId === "slow-1"), 1000);
} finally {
  asyncRuntime.stop();
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

function jsonResponse(payload) {
  return {
    ok: true,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

// Disabling the bridge while a poll is pending must discard the received commands.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true, pollIntervalMs: 100 } });
let resolvePoll;
let dispatched = false;
globalThis.fetch = async (_url, options) => {
  assert.equal(options.redirect, "error", "bridge requests must stay on the configured loopback endpoint");
  assert.deepEqual(options.headers, { "content-type": "application/json" });
  return await new Promise(resolve => { resolvePoll = resolve; });
};
const revokedRuntime = bridge.startQingzhouMcpBridge({ dispatch: () => { dispatched = true; }, trace() {} });
try {
  await waitFor(() => resolvePoll);
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: false } });
  await waitFor(() => !revokedRuntime.config.enabled);
  resolvePoll(jsonResponse({ requests: [{ id: "late", method: "execute_tool" }] }));
  await waitFor(() => !revokedRuntime.inFlight);
  assert.equal(dispatched, false);
} finally { revokedRuntime.stop(); }

// The bridge has already dequeued a command when its pending poll returns.
// Updating model settings must not revoke that command's polling generation.
for (const update of [
  { llmConfig: { model: "different-model", debugMode: false, temperature: 0.4 } },
  { _qingzhou_mcp_bridge: { enabled: true, token: "same-pair", endpoint: "http://127.0.0.1:18765/", pollIntervalMs: 100 } },
]) {
  await chrome.storage.local.set({
    _qingzhou_mcp_bridge: { enabled: true, token: "same-pair", pollIntervalMs: 100 },
    llmConfig: { model: "initial-model", debugMode: true },
  });
  let completePoll;
  let polls = 0;
  const dispatchedIds = [];
  const postedResults = [];
  globalThis.fetch = async (url, options) => {
    if (new URL(String(url)).pathname.endsWith("/result")) {
      postedResults.push(JSON.parse(options.body));
      return jsonResponse({ ok: true });
    }
    polls += 1;
    if (polls === 1) return new Promise(resolve => { completePoll = resolve; });
    return jsonResponse({ requests: [] });
  };
  const unchangedRuntime = bridge.startQingzhouMcpBridge({
    dispatch: ({ id }) => { dispatchedIds.push(id); return { delivered: true }; },
    trace() {},
  });
  try {
    await waitFor(() => completePoll);
    const generation = unchangedRuntime.generation;
    await chrome.storage.local.set(update);
    await new Promise(resolve => setImmediate(resolve));
    completePoll(jsonResponse({ requests: [{ id: "dequeued-before-update", method: "ping" }] }));
    await waitFor(() => postedResults.length === 1, 1000);
    assert.deepEqual(dispatchedIds, ["dequeued-before-update"]);
    assert.equal(postedResults[0].requestId, "dequeued-before-update");
    assert.deepEqual(postedResults[0].result, { delivered: true });
    assert.equal(unchangedRuntime.generation, generation, "equivalent bridge config must preserve polling authority");

    unchangedRuntime.stop();
    await waitFor(() => !unchangedRuntime.inFlight);
    const pollsBeforeRestart = polls;
    unchangedRuntime.start();
    await waitFor(() => polls > pollsBeforeRestart, 1000);
  } finally { unchangedRuntime.stop(); }
}

// Each connection identity change must invalidate a pending response.
for (const patch of [
  { endpoint: "http://localhost:18765" },
  { clientId: "replacement-client" },
  { enabled: false },
]) {
  const initial = { enabled: true, pollIntervalMs: 100 };
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: initial });
  let completePoll;
  const dispatchedIds = [];
  globalThis.fetch = async () => {
    if (!completePoll) return new Promise(resolve => { completePoll = resolve; });
    return jsonResponse({ requests: [] });
  };
  const changedRuntime = bridge.startQingzhouMcpBridge({
    dispatch: ({ id }) => { dispatchedIds.push(id); },
    trace() {},
  });
  try {
    await waitFor(() => completePoll);
    const generation = changedRuntime.generation;
    await chrome.storage.local.set({ _qingzhou_mcp_bridge: { ...initial, ...patch } });
    await waitFor(() => changedRuntime.generation !== generation);
    completePoll(jsonResponse({ requests: [{ id: "obsolete-connection", method: "execute_tool" }] }));
    await waitFor(() => !changedRuntime.inFlight);
    assert.deepEqual(dispatchedIds, [], "a changed connection must not execute the old poll's commands");
  } finally { changedRuntime.stop(); }
}

// Truncated and malformed successful HTTP responses must not mark the browser connected.
for (const response of [
  { ok: true, async text() { throw new Error("Body stream disconnected"); } },
  { ok: true, async text() { return ""; } },
  jsonResponse([]),
  jsonResponse({ requests: {} }),
]) {
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true } });
  globalThis.fetch = async () => response;
  const invalidRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
  try {
    await waitFor(() => invalidRuntime.failureCount === 1);
    assert.equal(invalidRuntime.connected, false);
    assert.equal(invalidRuntime.activeRequests.size, 0);
  } finally { invalidRuntime.stop(); }
}

// A missed storage event must still revoke access before the next network request.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true } });
let refreshedPolls = 0;
globalThis.fetch = async () => { refreshedPolls++; return jsonResponse({ requests: [] }); };
const freshConfigRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
try {
  await waitFor(() => freshConfigRuntime.connected);
  const before = refreshedPolls;
  storageData._qingzhou_mcp_bridge = { enabled: false };
  if (freshConfigRuntime.timer) clearTimeout(freshConfigRuntime.timer);
  await freshConfigRuntime.pollOnce();
  assert.equal(freshConfigRuntime.config.enabled, false);
  assert.equal(refreshedPolls, before, "a disabled connection cannot make another request");
} finally { freshConfigRuntime.stop(); }

// Exhausted discovery is quiet; an explicit connection wake resumes it without duplicate polls.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true } });
let offlinePolls = 0;
globalThis.fetch = async () => { offlinePolls++; throw new Error("Failed to fetch"); };
const quietRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
try {
  await waitFor(() => quietRuntime.failureCount === 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    clearTimeout(quietRuntime.timer); quietRuntime.timer = null;
    await quietRuntime.pollOnce();
  }
  assert.equal(quietRuntime.failureCount, 3);
  assert.equal(quietRuntime.timer, null);
  assert.equal(alarms.has(reconnectAlarm), false, "failed first discovery never enables background retries");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(offlinePolls, 3);
  globalThis.fetch = async () => { offlinePolls++; return jsonResponse({ requests: [] }); };
  quietRuntime.wake(); quietRuntime.wake();
  await waitFor(() => quietRuntime.connected);
  assert.equal(offlinePolls, 4, "overlapping wake requests start only one poll");
} finally { quietRuntime.stop(); }

// An explicit runtime restart begins a new connection attempt after exhausted discovery.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true } });
globalThis.fetch = async () => { throw new Error("Failed to fetch"); };
const exhaustedRestart = bridge.startQingzhouMcpBridge({ trace() {} });
try {
  await waitFor(() => exhaustedRestart.failureCount === 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    clearTimeout(exhaustedRestart.timer); exhaustedRestart.timer = null;
    await exhaustedRestart.pollOnce();
  }
  exhaustedRestart.stop();
  globalThis.fetch = async () => jsonResponse({ requests: [] });
  exhaustedRestart.start();
  await waitFor(() => exhaustedRestart.connected);
} finally { exhaustedRestart.stop(); }

// Established connections keep one low-frequency alarm after their fast retry budget is exhausted.
await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true, endpoint: "http://127.0.0.1:43210" } });
let recoveringPolls = 0;
let recoveringOffline = false;
globalThis.fetch = async url => {
  assert.equal(new URL(url).origin, "http://127.0.0.1:43210", "recovery uses only the saved endpoint");
  recoveringPolls++;
  if (recoveringOffline) throw new Error("Failed to fetch");
  return jsonResponse({ requests: [] });
};
const recoveringRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
let persistedAlarm;
try {
  const createdBefore = alarmCreations.length;
  await waitFor(() => recoveringRuntime.connected && alarms.has(reconnectAlarm));
  assert.equal(alarmCreations.length, createdBefore + 1);
  assert.equal(alarms.get(reconnectAlarm).periodInMinutes, 1);
  persistedAlarm = structuredClone(alarms.get(reconnectAlarm));
  recoveringOffline = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    clearTimeout(recoveringRuntime.timer); recoveringRuntime.timer = null;
    await recoveringRuntime.pollOnce();
    if (attempt < 2) {
      const retryTimer = recoveringRuntime.timer;
      for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(recoveringRuntime.failureCount, attempt + 1,
        "an alarm must not consume retries while the fast retry budget remains");
      assert.equal(recoveringRuntime.timer, retryTimer, "an alarm must leave the scheduled retry unchanged");
    }
  }
  const failedPolls = recoveringPolls;
  assert.equal(recoveringRuntime.failureCount, 3);
  assert.equal(recoveringRuntime.timer, null);
  assert.equal(alarms.has(reconnectAlarm), true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(recoveringPolls, failedPolls, "offline recovery cannot continue a rapid failure loop");
  for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
  await waitFor(() => recoveringPolls === failedPolls + 1 && !recoveringRuntime.inFlight);
  assert.equal(recoveringRuntime.failureCount, 3);
  assert.equal(recoveringRuntime.timer, null, "each alarm allows one recovery probe, not another rapid retry burst");
  recoveringOffline = false;
  for (let wake = 0; wake < 2; wake++) for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
  await waitFor(() => recoveringRuntime.connected);
  assert.equal(recoveringPolls, failedPolls + 2, "concurrent alarm notifications start one recovery poll");
  assert.equal(alarmCreations.length, createdBefore + 1, "ordinary polls never reset the alarm period");
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: false } });
  await waitFor(() => !recoveringRuntime.config.enabled && !alarms.has(reconnectAlarm));
  const disabledPolls = recoveringPolls;
  for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveringPolls, disabledPolls, "a late alarm cannot revive a disabled bridge");
  await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true, endpoint: "http://127.0.0.1:43210" } });
  await waitFor(() => recoveringRuntime.connected && alarms.has(reconnectAlarm));
} finally { recoveringRuntime.stop(); }

// Browser worker termination preserves Chrome alarms, unlike explicit runtime.stop().
await waitFor(() => !alarms.has(reconnectAlarm));
alarms.set(reconnectAlarm, persistedAlarm);
storageData._qingzhou_mcp_bridge = { enabled: true, endpoint: "http://127.0.0.1:43210" };
recoveringOffline = true;
const workerRestart = bridge.startQingzhouMcpBridge({ trace() {} });
try {
  for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
  assert.equal(workerRestart.failureCount, 0, "a persisted alarm cannot shorten a fresh worker's retry budget");
  await waitFor(() => workerRestart.failureCount === 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    clearTimeout(workerRestart.timer); workerRestart.timer = null;
    await workerRestart.pollOnce();
  }
  assert.equal(alarms.has(reconnectAlarm), true, "startup must retain the existing recovery alarm while offline");
  recoveringOffline = false;
  for (const listener of alarmListeners.slice()) listener({ name: reconnectAlarm });
  await waitFor(() => workerRestart.connected);
} finally { workerRestart.stop(); }
await waitFor(() => !alarms.has(reconnectAlarm));

// Explicit shutdown must clear even an alarm whose creation was still pending.
{
  const create = chrome.alarms.create;
  let releaseCreate;
  chrome.alarms.create = async (...args) => {
    await new Promise(resolve => { releaseCreate = resolve; });
    await create(...args);
  };
  globalThis.fetch = async () => jsonResponse({ requests: [] });
  const stoppingRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
  try {
    await waitFor(() => releaseCreate);
    stoppingRuntime.stop();
    releaseCreate();
    await waitFor(() => !alarms.has(reconnectAlarm));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alarms.has(reconnectAlarm), false);
    assert.equal(alarmListeners.length, 0);
  } finally { stoppingRuntime.stop(); chrome.alarms.create = create; }
}

// A delayed startup read must never override a newer enable/disable storage event.
for (const enabled of [true, false]) {
  storageData._qingzhou_mcp_bridge = { enabled: !enabled };
  const originalGet = chrome.storage.local.get;
  let releaseOldRead;
  let firstRead = true;
  chrome.storage.local.get = async key => {
    if (key === "_qingzhou_mcp_bridge" && firstRead) {
      firstRead = false;
      const snapshot = storageData[key];
      return new Promise(resolve => { releaseOldRead = () => resolve({ [key]: snapshot }); });
    }
    return originalGet(key);
  };
  let requests = 0;
  globalThis.fetch = async () => { requests++; return jsonResponse({ requests: [] }); };
  const reorderedRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
  try {
    await waitFor(() => releaseOldRead);
    await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled } });
    await waitFor(() => enabled ? reorderedRuntime.connected : !reorderedRuntime.config.enabled);
    releaseOldRead();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reorderedRuntime.config.enabled, enabled, "a stale load cannot replace the newer stored setting");
    assert.equal(reorderedRuntime.connected, enabled);
    if (!enabled) assert.equal(requests, 0, "a delayed enabled load cannot revive a disabled connection");
  } finally {
    reorderedRuntime.stop();
    chrome.storage.local.get = originalGet;
  }
}

// Stop/start invalidates configuration reads owned by the previous runtime lifecycle.
storageData._qingzhou_mcp_bridge = { enabled: false };
{
  const originalGet = chrome.storage.local.get;
  let releaseOldRead;
  let firstRead = true;
  chrome.storage.local.get = async key => {
    if (key === "_qingzhou_mcp_bridge" && firstRead) {
      firstRead = false;
      return new Promise(resolve => { releaseOldRead = () => resolve({ [key]: { enabled: false } }); });
    }
    return originalGet(key);
  };
  globalThis.fetch = async () => jsonResponse({ requests: [] });
  const restartedRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
  try {
    await waitFor(() => releaseOldRead);
    restartedRuntime.stop();
    storageData._qingzhou_mcp_bridge = { enabled: true };
    restartedRuntime.start();
    await waitFor(() => restartedRuntime.connected);
    releaseOldRead();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restartedRuntime.config.enabled, true);
    assert.equal(restartedRuntime.connected, true);
  } finally {
    restartedRuntime.stop();
    chrome.storage.local.get = originalGet;
  }
}

// A poll superseded by an equivalent configuration read must schedule another poll.
storageData._qingzhou_mcp_bridge = { enabled: true };
{
  const originalGet = chrome.storage.local.get;
  let reads = 0;
  let releasePollRead;
  chrome.storage.local.get = async key => {
    if (key === "_qingzhou_mcp_bridge" && ++reads === 2) {
      return new Promise(resolve => { releasePollRead = () => resolve({ [key]: { enabled: true } }); });
    }
    return originalGet(key);
  };
  globalThis.fetch = async () => jsonResponse({ requests: [] });
  const supersededRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
  try {
    await waitFor(() => releasePollRead);
    await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: true } });
    await new Promise(resolve => setImmediate(resolve));
    releasePollRead();
    await waitFor(() => supersededRuntime.connected);
    assert.equal(supersededRuntime.failureCount, 0);
  } finally {
    supersededRuntime.stop();
    chrome.storage.local.get = originalGet;
  }
}

// Wake reconciles missed storage events before deciding whether it may poll.
storageData._qingzhou_mcp_bridge = { enabled: false };
let wakePolls = 0;
globalThis.fetch = async () => { wakePolls++; return jsonResponse({ requests: [] }); };
const wakeRuntime = bridge.startQingzhouMcpBridge({ trace() {} });
try {
  await waitFor(() => !wakeRuntime.config.enabled);
  storageData._qingzhou_mcp_bridge = { enabled: true };
  wakeRuntime.wake();
  await waitFor(() => wakeRuntime.connected);
  const beforeDisable = wakePolls;
  storageData._qingzhou_mcp_bridge = { enabled: false };
  wakeRuntime.wake();
  await waitFor(() => !wakeRuntime.config.enabled);
  assert.equal(wakePolls, beforeDisable, "wake must honor the stored disabled setting");
  wakeRuntime.stop();
  storageData._qingzhou_mcp_bridge = { enabled: true };
  wakeRuntime.wake();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wakeRuntime.config.enabled, false, "wake cannot revive a stopped runtime");
} finally { wakeRuntime.stop(); }

// Known typed errors include safe recovery metadata, never arbitrary provider/request objects.
storageData._qingzhou_mcp_bridge = { enabled: false };
const errorPosts = [];
globalThis.fetch = async (_url, options) => {
  errorPosts.push(JSON.parse(options.body));
  return jsonResponse({ ok: true });
};
let dispatchedError;
const errorRuntime = bridge.startQingzhouMcpBridge({ dispatch: () => { throw dispatchedError; }, trace() {} });
try {
  await waitFor(() => !errorRuntime.config.enabled);
  dispatchedError = Object.assign(new Error("Download interrupted"), {
    code: "DOWNLOAD_INTERRUPTED", details: { downloadId: 42, filename: "report.zip", reason: "USER_CANCELED", apiKey: "private-key" },
  });
  await errorRuntime.handleRequest({ id: "download-error", method: "export_skill" });
  assert.equal(errorPosts[0].code, "DOWNLOAD_INTERRUPTED");
  assert.deepEqual(errorPosts[0].details, { downloadId: 42, filename: "report.zip", reason: "USER_CANCELED" });
  dispatchedError = Object.assign(new Error("Settings update failed"), { code: "SETTINGS_UPDATE_FAILED", details: { request: { apiKey: "private-key" } } });
  await errorRuntime.handleRequest({ id: "settings-error", method: "update_settings" });
  assert.deepEqual(errorPosts[1].details, {});
  assert.equal(JSON.stringify(errorPosts).includes("private-key"), false);
} finally { errorRuntime.stop(); }

console.log("qingzhou MCP bridge config tests passed");

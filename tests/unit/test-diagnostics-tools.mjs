import assert from "node:assert/strict";

const eventListeners = [];
const detachListeners = [];
const removedListeners = [];
const debuggerCommands = [];
const cdpCommands = [];
let debuggerRun = null;
let connectionId = 1;
let activePins = 0;

globalThis.chrome = {
  tabs: { onRemoved: { addListener(listener) { removedListeners.push(listener); } } },
  storage: { local: { async get() { return {}; } } },
  debugger: {
    onEvent: { addListener(listener) { eventListeners.push(listener); } },
    onDetach: { addListener(listener) { detachListeners.push(listener); } },
    async sendCommand(target, method, params) {
      debuggerCommands.push([target.tabId, method, params]);
      return {};
    },
  },
};

const { createDiagnosticsTools } = await import("../../src/capabilities/diagnostics/tools.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const definitions = new Map();
const runtime = createDiagnosticsTools({
  registerTool(definition) { definitions.set(definition.name, definition); },
  ToolExecutionError,
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  getDebuggerRun: () => debuggerRun,
  onDebuggerDetached(listener) { detachListeners.push(listener); return () => {}; },
  retainDebugger() {
    activePins++;
    let released = false;
    return () => { if (!released) { released = true; activePins--; } };
  },
  async sendCdp(tabId, method, params, context) {
    debuggerRun = { sessionId: context.sessionId, runId: context.runId, connectionId };
    cdpCommands.push([tabId, method, params, context]);
    if (method === "Network.getResponseBody") return { body: `body-${tabId}`, base64Encoded: false };
    return {};
  },
  assertUrlAllowed() {},
  secondsToMs(value, fallback) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : fallback;
  },
});

assert.deepEqual([...definitions.keys()], [
  "read_console_messages",
  "network_watch",
  "network_recent",
  "network_body",
  "wait_for_response",
  "wait_for_network_idle",
]);

const runOne = { sessionId: "s1", runId: "r1" };
assert.equal(definitions.get("network_watch").parameters.properties.enabled.type, "boolean");
await definitions.get("network_watch").execute({ tabId: 4, reset: true, maxRecords: 20 }, null, runOne);
assert.ok(cdpCommands.some(call => call[1] === "Network.enable"));
assert.equal(activePins, 1, "explicit monitoring survives idle periods between scripts");
await definitions.get("network_watch").execute({ tabId: 4, reset: false }, null, runOne);
assert.equal(activePins, 1, "repeated watch calls share one persistent hold");

function emit(method, params) {
  for (const listener of eventListeners) listener({ tabId: 4 }, method, params);
}

emit("Network.requestWillBeSent", {
  requestId: "r1",
  request: { url: "https://example.test/api", method: "GET", headers: {} },
  type: "Fetch",
  timestamp: 1,
});
emit("Network.responseReceived", {
  requestId: "r1",
  response: { status: 200, statusText: "OK", mimeType: "application/json", headers: {} },
  timestamp: 1.1,
});
emit("Network.loadingFinished", { requestId: "r1", timestamp: 1.2, encodedDataLength: 12 });

const recent = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, runOne);
assert.equal(recent.records, 1);
for (const listener of eventListeners) listener({ tabId: 4, sessionId: "child" }, "Network.requestWillBeSent", {
  requestId: "child",
  request: { url: "https://example.test/child", method: "GET", headers: {} },
  type: "Fetch",
  timestamp: 1.3,
});
const afterChildSession = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, runOne);
assert.equal(afterChildSession.records, 1, "a child debugger session must not enter the page network monitor");
assert.equal(recent.results[0].status, 200);
assert.equal(recent.results[0].durationMs, 200);

const body = await definitions.get("network_body").execute({ tabId: 4, requestId: "r1" }, null, runOne);
assert.equal(body.body, "body-4");
assert.equal(Object.hasOwn(body, "tabId"), false);

const missingBody = await definitions.get("network_body").execute({ tabId: 4, requestId: "missing" }, null, runOne);
assert.equal(missingBody.code, "NETWORK_REQUEST_NOT_FOUND");
assert.match(missingBody.message, /missing/);
assert.match(missingBody.hint, /network_recent/);
assert.deepEqual(missingBody.details, { requestId: "missing" });
assert.deepEqual(Object.keys(missingBody).sort(), ["code", "message", "hint", "details"].sort());

const invalidFilter = await definitions.get("network_recent").execute({ tabId: 4, urlPattern: "[" }, null, runOne);
assert.equal(invalidFilter.code, "INVALID_REGEX");
assert.match(invalidFilter.message, /regular expression/i);
assert.match(invalidFilter.hint, /pattern/);
assert.deepEqual(Object.keys(invalidFilter).sort(), ["code", "message", "hint", "details"].sort());

await definitions.get("read_console_messages").execute({ tabId: 4, reset: true }, null, runOne);
emit("Runtime.consoleAPICalled", {
  type: "warning",
  args: [{ type: "string", value: "hello" }],
  timestamp: 2,
});
const consoleResult = await definitions.get("read_console_messages").execute({ tabId: 4, level: "warning" }, null, runOne);
assert.equal(consoleResult.records, 1);
assert.equal(consoleResult.results[0].text, "hello");

const waiting = definitions.get("wait_for_response").execute({
  tabId: 4,
  urlPattern: "next",
  timeout: 1,
}, null, runOne);
await new Promise(resolve => setTimeout(resolve, 0));
emit("Network.requestWillBeSent", {
  requestId: "r2",
  request: { url: "https://example.test/next", method: "POST", headers: {} },
  type: "Fetch",
  timestamp: 3,
});
emit("Network.responseReceived", {
  requestId: "r2",
  response: { status: 201, statusText: "Created", mimeType: "application/json", headers: {} },
  timestamp: 3.1,
});
emit("Network.loadingFinished", { requestId: "r2", timestamp: 3.2, encodedDataLength: 8 });
const waited = await waiting;
assert.equal(waited.matched, true);
assert.equal(waited.response.status, 201);

// Future response waits cannot reuse a captured response, even when its body finishes later.
await assert.rejects(definitions.get("wait_for_response").execute({
  tabId: 4, urlPattern: "next", timeout: 0.01,
}, undefined, runOne), { code: "TOOL_TIMEOUT" });
const emitResponse = requestId => {
  emit("Network.requestWillBeSent", { requestId, request: { url: "https://example.test/next", method: "POST" }, timestamp: 6 });
  emit("Network.responseReceived", { requestId, response: { status: 202, mimeType: "application/json" }, timestamp: 6.1 });
  emit("Network.loadingFinished", { requestId, timestamp: 6.2 });
};
let triggered = 0;
const afterTrigger = await definitions.get("wait_for_response").execute({
  tabId: 4, urlPattern: "next", includeBody: true, timeout: 1,
  trigger: { name: "act_on_element", args: { tabRef: "page", target: "css:#send", action: "click" } },
}, undefined, { ...runOne, async invokeTool(name, args, { signal }) {
  triggered++; assert.equal(name, "act_on_element"); assert.equal(args.tabRef, "page"); assert.equal(signal.aborted, false);
  emitResponse("r3"); return { inputDelivered: true };
} });
assert.equal(triggered, 1); assert.equal(afterTrigger.response.requestId, "r3"); assert.equal(afterTrigger.body.body, "body-4");
const actionFailure = { code: "ACTION_FAILED", message: "Input was rejected", hint: "Inspect the button" };
await assert.rejects(definitions.get("wait_for_response").execute({
  tabId: 4, urlPattern: "next", timeout: 1, trigger: { name: "act_on_element" },
}, undefined, { ...runOne, async invokeTool() { emitResponse("r4"); throw actionFailure; } }), error => {
  assert.notEqual(error, actionFailure, "adding execution evidence must not mutate the original error");
  assert.equal(error.code, actionFailure.code);
  assert.equal(error.message, actionFailure.message);
  assert.equal(error.details.tool, "act_on_element");
  assert.equal(error.details.pending, "wait_for_response");
  assert.equal(Object.hasOwn(actionFailure, "details"), false);
  return true;
});

runtime.releaseRun("other-session", runOne.runId);
assert.equal(activePins, 1);
emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "still watching" }], timestamp: 4 });
runtime.releaseRun(runOne.sessionId, runOne.runId);
assert.equal(activePins, 0, "terminal cleanup releases the network hold");
debuggerRun = null;
emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "late event" }], timestamp: 5 });
emit("Network.requestWillBeSent", { requestId: "late", request: { url: "https://example.test/late", method: "GET" }, type: "Fetch", timestamp: 5 });
const stoppedConsole = await definitions.get("read_console_messages").execute({ tabId: 4, level: "warning" }, null, runOne);
assert.equal(stoppedConsole.totalBuffered, 0, "terminal run cleanup discards its console history");
const stoppedNetwork = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, runOne);
assert.equal(stoppedNetwork.records, 0, "terminal run cleanup discards its network history");

const nextRun = { sessionId: "s1", runId: "r2" };
const afterRunChange = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, nextRun);
assert.equal(afterRunChange.records, 0, "a new Agent run must not inherit the previous run's Network buffer");
const consoleAfterRunChange = await definitions.get("read_console_messages").execute({ tabId: 4 }, null, nextRun);
assert.equal(consoleAfterRunChange.records, 0, "a new Agent run must not inherit the previous run's Console buffer");

const idle = await definitions.get("wait_for_network_idle").execute({ tabId: 4, idleSeconds: 0.1, timeout: 0.5 }, undefined, nextRun);
assert.equal(idle.idle, true);
assert.equal(activePins, 0, "network reads and waits do not retain idle connections");
emit("Network.requestWillBeSent", { requestId: "pending", request: { url: "https://example.test/pending", method: "GET" }, timestamp: 7 });
await assert.rejects(definitions.get("wait_for_network_idle").execute({ tabId: 4, idleSeconds: 0.1, timeout: 0.01 }, undefined, nextRun), error => {
  assert.equal(error.code, "TOOL_TIMEOUT");
  assert.equal(error.details.timeoutMs, 10);
  return true;
});

debuggerRun = null;
detachListeners.forEach(listener => listener(4, connectionId));
assert.equal(runtime.defaultNetworkLimit, 200);

const beforeDisabled = cdpCommands.length;
const neverWatched = await definitions.get("network_watch").execute({ tabId: 99, enabled: false }, undefined, nextRun);
assert.equal(neverWatched.watching, false);
const stopped = await definitions.get("network_watch").execute({ tabId: 4, enabled: false }, undefined, nextRun);
assert.equal(stopped.watching, false);
assert.equal(cdpCommands.length, beforeDisabled, "stopping a missing or disconnected watch never attaches");

connectionId++;
await runtime.enablePreNavigationNetworkWatch(4, {}, nextRun);
assert.equal(activePins, 1, "pre-navigation watch retains initial responses across scripts");
emitResponse("retained-body");
const retainedBody = await definitions.get("network_body").execute({ tabId: 4, requestId: "retained-body" }, undefined, nextRun);
assert.equal(retainedBody.body, "body-4");
const concurrentWait = definitions.get("wait_for_response").execute({ tabId: 4, urlPattern: "next", timeout: 1 }, undefined, nextRun);
await new Promise(resolve => setTimeout(resolve, 0));
const beforeStop = cdpCommands.length;
await definitions.get("network_watch").execute({ tabId: 4, enabled: false }, undefined, nextRun);
await definitions.get("network_watch").execute({ tabId: 4, enabled: false }, undefined, nextRun);
assert.equal(activePins, 0, "explicit stop releases its hold idempotently");
assert.equal(cdpCommands.length, beforeStop, "stop uses the existing monitor without CDP calls");
emitResponse("armed-wait");
assert.equal((await concurrentWait).response.requestId, "armed-wait", "stopping a persistent watch preserves already armed waits");
emitResponse("after-stop");
const afterStop = await definitions.get("network_recent").execute({ tabId: 4 }, undefined, nextRun);
assert.equal(afterStop.results.some(record => record.requestId === "after-stop"), false, "stopped capture does not restart on a history read");
debuggerRun = null;
detachListeners.forEach(listener => listener(4, connectionId));
const beforeExpired = cdpCommands.length;
const expiredBody = await definitions.get("network_body").execute({ tabId: 4, requestId: "retained-body" }, undefined, nextRun);
assert.equal(expiredBody.code, "NETWORK_RESPONSE_EXPIRED");
assert.match(expiredBody.hint, /includeBody:true/);
const preservedHistory = await definitions.get("network_recent").execute({ tabId: 4 }, undefined, nextRun);
assert.equal(preservedHistory.results.some(record => record.requestId === "retained-body"), true);
assert.equal(cdpCommands.length, beforeExpired, "expired bodies and retained summaries never reacquire a connection");

connectionId++;
await definitions.get("network_watch").execute({ tabId: 4, reset: false }, undefined, nextRun);
assert.equal(activePins, 1);
detachListeners.forEach(listener => listener(4, connectionId - 1));
assert.equal(activePins, 1, "a delayed detach notification cannot release the replacement connection");
const oldBody = await definitions.get("network_body").execute({ tabId: 4, requestId: "retained-body" }, undefined, nextRun);
assert.equal(oldBody.code, "NETWORK_RESPONSE_EXPIRED", "request identifiers from a retired connection never reach CDP");
runtime.releaseRun(nextRun.sessionId, nextRun.runId);
assert.equal(activePins, 0);

await definitions.get("network_watch").execute({ tabId: 4 }, undefined, nextRun);
emitResponse("closed-tab");
removedListeners.forEach(listener => listener(4));
assert.equal(activePins, 0, "closing a tab releases its persistent monitor");
const closedBody = await definitions.get("network_body").execute({ tabId: 4, requestId: "closed-tab" }, undefined, nextRun);
assert.equal(closedBody.code, "NETWORK_REQUEST_NOT_FOUND", "closing a tab discards its buffered responses");

const temporaryWait = definitions.get("wait_for_response").execute({ tabId: 4, urlPattern: "next", timeout: 1 }, undefined, nextRun);
await new Promise(resolve => setTimeout(resolve, 0));
emitResponse("temporary-response");
await temporaryWait;
emitResponse("after-temporary-wait");
const temporaryHistory = await definitions.get("network_recent").execute({ tabId: 4 }, undefined, nextRun);
assert.deepEqual(temporaryHistory.results.map(record => record.requestId), ["temporary-response"], "a standalone wait stops capturing even if another feature retains the physical connection");

console.log("diagnostics monitor tests passed");

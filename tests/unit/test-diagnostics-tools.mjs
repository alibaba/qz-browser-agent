import assert from "node:assert/strict";

const eventListeners = [];
const detachListeners = [];
const debuggerCommands = [];
const cdpCommands = [];

globalThis.chrome = {
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
  registerTool({ name, description: _description, parameters: _parameters, execute }) { definitions.set(name, { execute }); },
  ToolExecutionError,
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async sendCdp(tabId, method, params, context) {
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
await definitions.get("network_watch").execute({ tabId: 4, reset: true, maxRecords: 20 }, null, runOne);
assert.ok(cdpCommands.some(call => call[1] === "Network.enable"));

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

runtime.releaseRun("other-session", runOne.runId);
emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "still watching" }], timestamp: 4 });
runtime.releaseRun(runOne.sessionId, runOne.runId);
emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "late event" }], timestamp: 5 });
emit("Network.requestWillBeSent", { requestId: "late", request: { url: "https://example.test/late", method: "GET" }, type: "Fetch", timestamp: 5 });
const stoppedConsole = await definitions.get("read_console_messages").execute({ tabId: 4, level: "warning" }, null, runOne);
assert.deepEqual(stoppedConsole.results.map(item => item.text).sort(), ["hello", "still watching"], "retained CDP must not append console events after run cleanup");
const stoppedNetwork = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, runOne);
assert.equal(stoppedNetwork.records, 2, "late Network events are ignored even without a physical detach");

const nextRun = { sessionId: "s1", runId: "r2" };
const afterRunChange = await definitions.get("network_recent").execute({ tabId: 4, limit: 10 }, null, nextRun);
assert.equal(afterRunChange.records, 0, "a new Agent run must not inherit the previous run's Network buffer");
const consoleAfterRunChange = await definitions.get("read_console_messages").execute({ tabId: 4 }, null, nextRun);
assert.equal(consoleAfterRunChange.records, 0, "a new Agent run must not inherit the previous run's Console buffer");

detachListeners.forEach(listener => listener({ tabId: 4 }));
assert.equal(runtime.defaultNetworkLimit, 200);

console.log("diagnostics monitor tests passed");

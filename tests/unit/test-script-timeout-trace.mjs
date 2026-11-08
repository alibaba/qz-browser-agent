import assert from "node:assert/strict";
import test from "node:test";

globalThis.SCRIPT_RUNTIME_SOURCE = "const QZ_SCRIPT_RUNTIME = { safeValueForMessage(value) { return value; }, installSecurityGuards() { return () => {}; } };";
const tabs = new Map([[7, { id: 7, windowId: 2, url: "https://example.test/page", title: "Page", status: "complete" }]]);
const bridgeMessages = [];
globalThis.window = {
  addEventListener() {},
  postMessage() {},
};
globalThis.chrome = {
  runtime: {
    getURL: path => `chrome-extension://test/${path}`,
    async sendMessage(message) {
      bridgeMessages.push(message);
      return { ok: true };
    },
    lastError: undefined,
  },
  storage: { local: { async get() { return {}; } } },
  offscreen: {
    Reason: { BLOBS: "BLOBS", USER_MEDIA: "USER_MEDIA", AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
    async hasDocument() { return true; },
    async createDocument() { return {}; },
  },
  debugger: {
    onDetach: { addListener() {} },
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; },
  },
  tabs: {
    async get(id) {
      if (!tabs.has(id)) throw new Error("No tab");
      return { ...tabs.get(id) };
    },
    onUpdated: { addListener() {}, removeListener() {} },
    async sendMessage() { return { ok: true }; },
  },
  scripting: {
    async executeScript(details) {
      if (details?.func?.name === 'documentReadiness') return [{ result: true }];
      return [{ documentId: "doc", result: { readyState: "complete", title: "Page", url: "https://example.test/page", observedAt: 1 } }];
    },
  },
};

const { createToolRuntime } = await import("../../src/background/tools/runtime.js");

const rows = count => Array.from({ length: count }, (_, index) => ({ level: "trace", message: `row-${index}` }));
const runtime = createToolRuntime({
  sessions: {
    isRunCurrent: () => true,
    async resolveTargetTab({ tabId }) {
      return tabs.has(tabId) ? { ok: true, tabId, ownedByCurrentTask: true } : { ok: false, code: "SESSION_TAB_UNAVAILABLE" };
    },
    async updateWorkingTab() { return { ok: true }; },
    listOwnedTabIds: () => [...tabs.keys()],
  },
});
const context = { sessionId: "timeout-trace", runId: "run", workingTabId: 7 };
const scriptMessages = () => bridgeMessages.map(message => message.type).filter(type => String(type).startsWith("run_script"));

test("script timeouts read the last five traces once from the execution environment", async () => {
  bridgeMessages.length = 0;
  chrome.runtime.sendMessage = async message => {
    bridgeMessages.push(message);
    if (message.type === "run_script_inner_ping") return { ok: true, ready: true };
    if (message.type === "run_script_inner_execute") return { ok: true, accepted: true };
    if (message.type === "run_script_inner_trace_snapshot") {
      runtime.handleRunScriptInnerRuntimeMessage({
        type: "run_script_inner_trace_snapshot_result",
        requestId: message.requestId,
        trace: rows(6),
      });
      return { ok: true };
    }
    return { ok: true };
  };
  const inner = await runtime.execute("run_script", {
    timeout: 1,
    code: "async () => { await new Promise(() => {}); }",
  }, undefined, context);
  assert.equal(inner.code, "TOOL_TIMEOUT");
  assert.deepEqual(inner.details.trace.map(row => row.message), ["row-1", "row-2", "row-3", "row-4", "row-5"]);
  const innerTypes = scriptMessages();
  assert.deepEqual(innerTypes.filter(type => type === "run_script_inner_trace_snapshot"), ["run_script_inner_trace_snapshot"]);
  assert.ok(innerTypes.indexOf("run_script_inner_trace_snapshot") < innerTypes.indexOf("run_script_inner_cancel"));
  assert.equal(innerTypes.includes("run_script_inner_script_trace"), false);
  assert.equal(innerTypes.includes("run_script_page_trace"), false);

  bridgeMessages.length = 0;
  chrome.debugger.sendCommand = async (_target, method, params) => {
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression || "");
      assert.match(expression, /Object\.defineProperty\(__qzPromise, "__qzTrace"/);
      assert.doesNotMatch(expression, /qz-run-script-trace/);
      assert.equal(params.awaitPromise, false);
      assert.equal(params.returnByValue, false);
      return { result: { type: "object", subtype: "promise", objectId: "promise-page", className: "Promise" } };
    }
    if (method === "Runtime.awaitPromise") return new Promise(() => {});
    if (method === "Runtime.callFunctionOn") {
      assert.equal(params.objectId, "promise-page");
      assert.equal(params.returnByValue, true);
      assert.match(params.functionDeclaration, /function\(\)\{ const rows = this && this\.__qzTrace/);
      return { result: { type: "object", value: rows(6).slice(-5) } };
    }
    if (method === "Runtime.terminateExecution") return {};
    return {};
  };
  const page = await runtime.execute("evaluate", {
    timeout: 1,
    tabRef: 7,
    code: "async () => { await new Promise(() => {}); }",
  }, undefined, context);
  assert.equal(page.code, "TOOL_TIMEOUT");
  assert.deepEqual(page.details.trace.map(row => row.message), ["row-1", "row-2", "row-3", "row-4", "row-5"]);
  assert.equal(scriptMessages().includes("run_script_page_trace"), false);
});

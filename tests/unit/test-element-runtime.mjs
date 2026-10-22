import assert from "node:assert/strict";

let currentUrl = "https://example.test/page#one";
const listeners = new Set();
const commands = [];
const contentCalls = [];
let debuggerUses = 0;
globalThis.chrome = {
  runtime: { id: "extension-id" },
  tabs: { async get(tabId) { return { id: tabId, url: currentUrl }; } },
  debugger: {
    onEvent: { addListener(listener) { listeners.add(listener); } },
    onDetach: { addListener() {} },
    async sendCommand() { return {}; },
  },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const runtime = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return { sessions: { async resolveTargetTab() { return { ok: true }; } } };
  },
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {},
  async sendToContent(tabId, action, params = {}) {
    contentCalls.push({ tabId, action, ...params });
    return { ok: true, action, selector: params.selector, index: params.index };
  },
  async withDebugger(tabId, callback) {
    debuggerUses += 1;
    return await callback({ tabId }, async (method, params = {}) => {
      commands.push({ method, params });
      if (method === "Runtime.enable") {
        for (const listener of listeners) {
          listener({ tabId }, "Runtime.executionContextCreated", {
            context: {
              id: 7,
              origin: "chrome-extension://extension-id",
              auxData: { type: "isolated", frameId: "main" },
            },
          });
          listener({ tabId }, "Runtime.executionContextCreated", {
            context: {
              id: 8,
              origin: "chrome-extension://extension-id",
              auxData: { type: "isolated", frameId: "child" },
            },
          });
        }
        return {};
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: params.loaderId || "loader-live" } } };
      if (method === "DOM.getDocument") return { root: { nodeId: 3 } };
      if (method === "DOM.querySelectorAll") {
        return { nodeIds: String(params.selector).includes("dup") ? [11, 12] : [9] };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 44 } };
      if (method === "DOM.resolveNode") return { object: { objectId: "uid-node" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true, action: params.arguments?.[0]?.value?.action || "" } } };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method ${method}`);
    });
  },
});

const context = { sessionId: "session-a", runId: "run" };
runtime.registerElementRef({
  uid: "t5_ax_1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.primary",
  backendNodeId: 41,
  loaderId: "loader-live",
});

const resolved = await runtime.resolveElementReference(undefined, { target: "uid:t5_ax_1" }, context);
assert.equal(resolved.selector, "");
assert.equal(commands.length, 0, "resolving a uid must not query or generate a selector");
assert.equal(runtime.selectorFromBackendNode, undefined);

const css = await runtime.resolveElementReference(5, { target: "css:main > button" }, context);
assert.equal(css.selector, "main > button");
assert.equal(css.index, 0, "an omitted css index stays at the first match");

const beforeCss = debuggerUses;
const cssRead = await runtime.callElement(5, { tabId: 5, selector: "#save", target: "css:#save" }, "inspectElement", {}, context);
const cssWrite = await runtime.callElement(5, { tabId: 5, selector: "#plain", target: "css:#plain" }, "actOnElement", { elementAction: "fill", value: "next" }, context);
const cssIndexed = await runtime.callElement(5, { tabId: 5, selector: "button.dup", index: 1, target: "css:button.dup" }, "inspectElement", {}, context);
assert.equal(debuggerUses, beforeCss, "css read and write must not attach the debugger");
assert.equal(cssRead.selector, "#save");
assert.equal(cssRead.index, 0);
assert.equal(cssWrite.action, "actOnElement");
assert.equal(cssWrite.index, 0);
assert.equal(cssIndexed.index, 1);
assert.equal(contentCalls.at(-1).elementAction, undefined);
assert.equal(contentCalls.find(call => call.action === "actOnElement").value, "next");

const called = await runtime.callElement(5, resolved, "inspectElement", {}, context);
assert.equal(called.ok, true);
assert.ok(commands.some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 7));
assert.equal(commands.some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 8), false, "an iframe isolated world is not the content script");
assert.ok(commands.some(command => command.method === "Runtime.callFunctionOn"));
assert.ok(commands.some(command => command.method === "Runtime.releaseObjectGroup"));
assert.equal(commands.some(command => command.method === "DOM.querySelector"), false);

runtime.registerElementRef({
  uid: "t5_ax_old",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  backendNodeId: 41,
  loaderId: "loader-previous",
});
const beforeStale = commands.length;
await assert.rejects(
  runtime.callElement(5, { tabId: 5, uid: "t5_ax_old", target: "uid:t5_ax_old", ref: { backendNodeId: 41, loaderId: "loader-previous" } }, "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
);
assert.equal(commands.slice(beforeStale).some(command => command.method === "DOM.resolveNode"), false, "a replaced document must not be rematched");

const bound = await runtime.bindBackendNodes(5, ["button.dup", "#only"], context);
assert.equal(bound.loaderId, "loader-live");
assert.deepEqual(bound.ids, [0, 44], "a selector that matches two nodes must not bind the first");

console.log("element runtime ownership tests passed");

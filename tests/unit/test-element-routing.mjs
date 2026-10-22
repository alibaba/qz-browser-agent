import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

const listeners = new Set();
let frameLoader = "loader-live";
let resolveNodeError = null;
let probedDocumentId = "";
globalThis.chrome = {
  runtime: { id: "extension-id" },
  storage: { local: { async get() { return {}; } } },
  tabs: {
    async get(tabId) { return { id: tabId, url: "https://example.test/page" }; },
    async update() {},
  },
  debugger: {
    onEvent: { addListener(listener) { listeners.add(listener); } },
    onDetach: { addListener() {} },
  },
  scripting: {
    async executeScript() {
      return [{ documentId: probedDocumentId, result: null }];
    },
  },
};

const contentCalls = [];
const nodeMethods = [];
const pageMethods = [];
let state = { value: "old", checked: false, kind: "button" };

function replyFor(action, params = {}) {
  const button = state.kind !== "check" && state.kind !== "fill";
  const body = {
    tag: state.kind === "check" ? "input" : button ? "button" : "input",
    type: state.kind === "check" ? "checkbox" : state.kind === "fill" ? "text" : "",
    visible: true,
    disabled: false,
    readOnly: false,
    editable: state.kind === "fill",
    focused: true,
    checked: state.checked,
    value: state.value,
    clickablePoint: { x: 12, y: 16 },
    selector: params.selector || "",
    index: params.index,
  };
  if (action === "prepareElementFill") return { ...body, fillMode: "text", contentEditable: false };
  if (action === "readDom") return { content: "scoped-text", selector: params.selector || "" };
  if (action === "resolveCheckTarget") return { ...body, element: { ...body } };
  return body;
}

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
const { registerPageElementTools } = await import("../../src/capabilities/page/tools.js");

const element = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return { sessions: { async resolveTargetTab() { return { ok: true }; }, listOwnedTabIds: () => [5] } };
  },
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {},
  async initializeContentScript() {},
  async sendToContent(tabId, action, params = {}) {
    contentCalls.push({ tabId, action, selector: params.selector, index: params.index, via: "content" });
    return replyFor(action, params);
  },
  async withDebugger(tabId, callback) {
    return callback({ tabId }, async (method, params = {}) => {
      nodeMethods.push(method);
      if (method === "Runtime.enable") {
        for (const listener of listeners) {
          listener({ tabId }, "Runtime.executionContextCreated", {
            context: { id: 7, origin: "chrome-extension://extension-id", auxData: { type: "isolated", frameId: "main" } },
          });
        }
        return {};
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: frameLoader } } };
      if (method === "DOM.resolveNode") {
        if (resolveNodeError) throw resolveNodeError;
        return { object: { objectId: "bound-node" } };
      }
      if (method === "Runtime.evaluate") return { result: { value: { extensionId: "extension-id", bridge: true } } };
      if (method === "Runtime.callFunctionOn") {
        const payload = params.arguments?.[0]?.value || {};
        contentCalls.push({ tabId, action: payload.action, selector: payload.selector, index: payload.index, via: "node" });
        return { result: { value: replyFor(payload.action, payload) } };
      }
      if (method === "Runtime.releaseObjectGroup" || method === "Runtime.disable") return {};
      return {};
    });
  },
});

const tools = new Map();
registerPageElementTools({
  registerTool(definition) { tools.set(definition.name, definition); },
  ToolExecutionError,
  async sendToContent(tabId, action, params = {}) {
    contentCalls.push({ tabId, action, selector: params.selector, index: params.index, via: "content" });
    return replyFor(action, params);
  },
  resolveSelectorTarget: element.resolveSelectorTarget,
  resolveElementReference: element.resolveElementReference,
  useElement: element.useElement,
  addElementTargetsToFindResult: element.addElementTargetsToFindResult,
  elementTargetForRef: element.elementTargetForRef,
  elementTargetForSelector: element.elementTargetForSelector,
  elementTargetGrammar: element.elementTargetGrammar,
  getElementTargetDescription: () => "target",
  clickPointReady: inspected => Boolean(inspected?.clickablePoint) && !inspected.error,
  clickNotReadyResult: () => ({ error: "no point", code: "CLICK_POINT_OUT_OF_VIEWPORT" }),
  async getTabPageState() { return { url: "https://example.test/page", title: "Page" }; },
  pageStateDelta: () => ({ urlChanged: false }),
  async prepareKnownPageNavigation() { return null; },
  commitObservedPageNavigation: () => null,
  getPageContext: () => ({ pageMode: "desktop" }),
  async sendCdp(_tabId, method, params = {}) { return sendPageCommand(method, params); },
  async withDebugger(_tabId, callback) { return callback({}, sendPageCommand); },
});

function sendPageCommand(method, params = {}) {
  pageMethods.push(method);
  if (method === "Input.insertText") state.value = params.text;
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") state.checked = !state.checked;
  return {};
}

const context = { sessionId: "session-a", runId: "run" };

function register(uid, fields) {
  element.registerElementRef({
    uid,
    tabId: 5,
    sessionId: "session-a",
    pageUrl: "https://example.test/page",
    ...fields,
  });
  return `uid:${uid}`;
}

function callsSince(mark) {
  return contentCalls.slice(mark);
}

describe("element uid routing", { concurrency: 1 }, () => {
test("selector-only uid click, fill, check, and read use the stored selector", async () => {
  const clickTarget = register("t5.00aa01.1", { selector: "button.save", index: 1 });
  const fillTarget = register("t5.00aa01.2", { selector: "input.name", index: 2 });
  const checkTarget = register("t5.00aa01.3", { selector: "input.agree", index: 3 });
  const readTarget = register("t5.00aa01.4", { selector: "main.article", index: 4 });
  const before = contentCalls.length;
  nodeMethods.length = 0;
  state = { value: "old", checked: false, kind: "button" };

  const clicked = await tools.get("act_on_element").execute({ tabId: 5, target: clickTarget, action: "click" }, undefined, context);
  assert.equal(clicked.clickDispatched, true);
  assert.equal(clicked.code, undefined);
  assert.equal(callsSince(before).some(call => call.action === "inspectElement" && call.selector === "button.save" && call.index === 1 && call.via === "content"), true);

  state.kind = "fill";
  state.value = "old";
  const filled = await tools.get("act_on_element").execute({ tabId: 5, target: fillTarget, action: "fill", value: "next" }, undefined, context);
  assert.equal(filled.filled, true);
  assert.equal(filled.value, "next");
  assert.equal(callsSince(before).some(call => call.action === "prepareElementFill" && call.selector === "input.name" && call.index === 2), true);

  state.kind = "check";
  state.checked = false;
  const checked = await tools.get("act_on_element").execute({ tabId: 5, target: checkTarget, action: "check" }, undefined, context);
  assert.equal(checked.checked, true);
  assert.equal(checked.changed, true);
  assert.equal(callsSince(before).some(call => call.action === "resolveCheckTarget" && call.selector === "input.agree" && call.index === 3), true);

  state.kind = "button";
  const read = await tools.get("read_dom").execute({ tabId: 5, selector: readTarget, limit: 20 }, undefined, context);
  assert.equal(read.content, "scoped-text");
  assert.equal(callsSince(before).some(call => call.action === "readDom" && call.selector === "main.article" && call.index === 4), true);
  assert.equal(callsSince(before).some(call => call.selector === "body"), false);
  assert.equal(nodeMethods.includes("DOM.resolveNode"), false, "a selector-only uid must not open a node connection");
});

test("a uid with neither a node nor a selector fails before reading the page", async () => {
  const target = register("t5.00aa02.1", {});
  const before = contentCalls.length;
  await assert.rejects(
    tools.get("read_dom").execute({ tabId: 5, selector: target, limit: 20 }, undefined, context),
    error => error?.code === "STALE_ELEMENT_UID",
  );
  assert.equal(contentCalls.length, before);
  assert.equal(contentCalls.some(call => call.selector === "body"), false);
});

test("a deleted node is not operated through the replacement's selector", async () => {
  const target = register("t5.00aa03.1", {
    selector: "button.same",
    backendNodeId: 41,
    loaderId: "loader-live",
  });
  resolveNodeError = new Error("node removed");
  const before = contentCalls.length;
  try {
    await assert.rejects(
      tools.get("read_dom").execute({ tabId: 5, selector: target, limit: 20 }, undefined, context),
      error => error?.code === "STALE_ELEMENT_UID",
    );
    await assert.rejects(
      tools.get("act_on_element").execute({ tabId: 5, target, action: "click" }, undefined, context),
      error => error?.code === "STALE_ELEMENT_UID",
    );
  } finally {
    resolveNodeError = null;
  }
  assert.equal(callsSince(before).some(call => call.via === "content" && call.selector === "button.same"), false);
  assert.equal(callsSince(before).some(call => call.action === "actOnElement"), false);
});

test("the same url with a new document invalidates the old uid", async () => {
  const target = register("t5.00aa04.1", {
    selector: "button.stay",
    backendNodeId: 41,
    loaderId: "loader-live",
    documentId: "doc-old",
  });
  probedDocumentId = "doc-new";
  const before = contentCalls.length;
  await assert.rejects(
    tools.get("act_on_element").execute({ tabId: 5, target, action: "click" }, undefined, context),
    error => error?.code === "STALE_ELEMENT_UID",
  );
  assert.equal(contentCalls.length, before);
  probedDocumentId = "doc-old";
  frameLoader = "loader-next";
  await assert.rejects(
    element.callElement(5, await element.resolveElementReference(5, { target }, context), "inspectElement", {}, context),
    error => error?.code === "STALE_ELEMENT_UID",
  );
  frameLoader = "loader-live";
  probedDocumentId = "";
});

test("one node binding covers every step of a fill", async () => {
  const target = register("t5.00aa05.1", {
    selector: "div.rich",
    backendNodeId: 77,
    loaderId: "loader-live",
  });
  state = { value: "kept", checked: false, kind: "fill" };
  const beforeNodes = nodeMethods.filter(method => method === "DOM.resolveNode").length;
  const before = contentCalls.length;
  const filled = await tools.get("act_on_element").execute({ tabId: 5, target, action: "fill", value: "kept" }, undefined, context);
  assert.equal(filled.filled, true);
  const resolveCount = nodeMethods.filter(method => method === "DOM.resolveNode").length - beforeNodes;
  assert.equal(resolveCount, 1, "the action keeps the node resolved at the start");
  assert.equal(callsSince(before).some(call => call.via === "content"), false);
  assert.equal(callsSince(before).every(call => call.via === "node"), true);
});
});

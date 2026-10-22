import assert from "node:assert/strict";

const debuggerListeners = { event: [], detach: [] };
globalThis.chrome = {
  runtime: { id: "extension-id" },
  tabs: { async get(tabId) { return { id: tabId, url: "https://example.com/forms/post" }; } },
  debugger: {
    onEvent: { addListener(listener) { debuggerListeners.event.push(listener); } },
    onDetach: { addListener(listener) { debuggerListeners.detach.push(listener); } },
  },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
const { registerAccessibilityTools } = await import("../../src/capabilities/accessibility/tools.js");
const { frameContentOrigin, openChildFrame } = await import("../../src/background/tools/child-frames.js");
const { ToolExecutionError } = await import("../../src/background/tools/arguments.js");

const calls = [];
let echo = false;
const mainNodes = [
  ax({ id: "root", children: ["frame", "other", "parent"], backend: 1, role: "RootWebArea", name: "Page" }),
  ax({ id: "frame", parent: "root", backend: 50, role: "Iframe", name: "Child frame" }),
  ax({ id: "other", parent: "root", backend: 60, role: "Iframe", name: "Cross frame" }),
  ax({ id: "parent", parent: "root", backend: 3, role: "button", name: "Parent" }),
];
const childNodes = [
  ax({ id: "croot", children: ["inside", "field"], backend: 1, role: "RootWebArea", name: "Child" }),
  ax({ id: "inside", parent: "croot", backend: 3, role: "button", name: "Inside" }),
  ax({ id: "field", parent: "croot", backend: 8, role: "textbox", name: "Field" }),
];
const oopifNodes = [
  ax({ id: "oroot", children: ["cross"], backend: 1, role: "RootWebArea", name: "Remote document" }),
  ax({ id: "cross", parent: "oroot", backend: 3, role: "button", name: "Remote" }),
];
const hiddenNodes = [
  ax({ id: "hroot", children: ["hidden"], backend: 1, role: "RootWebArea", name: "Hidden" }),
  ax({ id: "hidden", parent: "hroot", backend: 9, role: "button", name: "Hidden" }),
];

const send = async (method, params = {}) => {
  calls.push({ method, params, session: "" });
  if (method === "Page.getFrameTree") return {
    frameTree: {
      frame: { id: "main", loaderId: "main-loader" },
      childFrames: [
        { frame: { id: "child", parentId: "main", loaderId: "child-loader" }, childFrames: [
          { frame: { id: "grand", parentId: "child", loaderId: "grand-loader" } },
        ] },
        { frame: { id: "orphan", parentId: "main", loaderId: "orphan-loader" } },
        { frame: { id: "broken", parentId: "main", loaderId: "broken-loader" } },
      ],
    },
  };
  if (method === "Target.getTargets" || method === "Target.attachToTarget") {
    throw new Error(`${method} is not used`);
  }
  if (method === "Target.setAutoAttach") {
    if (!params.autoAttach) return {};
    for (const listener of debuggerListeners.event) {
      listener({ tabId: send.tabId }, "Target.attachedToTarget", {
        sessionId: "oopif-session",
        targetInfo: { type: "iframe", targetId: "oopif-target", parentFrameId: "main", url: "http://localhost/cross" },
      });
      listener({ tabId: send.tabId }, "Target.attachedToTarget", {
        sessionId: "nested-session",
        targetInfo: { type: "iframe", targetId: "nested-target", parentFrameId: "oopif", url: "http://localhost/nested" },
      });
      listener({ tabId: send.tabId }, "Target.attachedToTarget", {
        sessionId: "worker-session",
        targetInfo: { type: "worker", targetId: "worker-target", parentFrameId: "main" },
      });
    }
    return {};
  }
  if (method === "Accessibility.getFullAXTree") {
    if (params.frameId === "grand") throw new Error("grandchild fetched");
    if (params.frameId === "child") return { nodes: echo ? mainNodes : childNodes };
    if (params.frameId === "orphan") return { nodes: hiddenNodes };
    if (params.frameId === "broken") throw new Error("frame unavailable");
    return { nodes: mainNodes };
  }
  if (method === "DOM.getFrameOwner") {
    if (params.frameId === "child") return { backendNodeId: 50 };
    if (params.frameId === "oopif") return { backendNodeId: 60 };
    if (params.frameId === "orphan") return { backendNodeId: 999 };
    return {};
  }
  if (method === "DOM.getBoxModel") return { model: { content: [12, 34, 112, 34, 112, 84, 12, 84] } };
  if (method === "DOM.describeNode") return { node: {} };
  return {};
};
send.tabId = 8;
send.connectionId = 3;
send.inSession = session => async (method, params = {}) => {
  calls.push({ method, params, session });
  if (session === "nested-session") {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "nested", loaderId: "nested-loader" } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [
      { nodeId: "nroot", childIds: ["deep"], role: { value: "RootWebArea" }, name: { value: "Nested" } },
      { nodeId: "deep", parentId: "nroot", backendDOMNodeId: 4, role: { value: "button" }, name: { value: "Deep" } },
    ] };
  }
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "oopif", loaderId: "oopif-loader" } } };
  if (method === "Accessibility.getFullAXTree") return { nodes: oopifNodes };
  return {};
};

const element = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies: () => ({ sessions: { async resolveTargetTab() { return { ok: true }; }, listOwnedTabIds: () => [8] } }),
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  async assertTabAllowed() {},
  async sendToContent() { return {}; },
  async withDebugger() { throw new Error("unused"); },
});

let definition;
registerAccessibilityTools({
  registerTool: value => { definition = value; },
  ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(max, Math.floor(Number(value)))),
  makeSnapshotId: element.makeSnapshotId,
  makeElementUid: element.makeElementUid,
  elementTargetForUid: element.elementTargetForUid,
  registerElementRef: element.registerElementRef,
  resolveElementReference: element.resolveElementReference,
  backendNodeIdForSelector: async () => 0,
  bindBackendNodes: async () => ({ loaderId: "main-loader", ids: [3] }),
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => ({ title: "Page", url: "https://example.com/forms/post", actions: [{ selector: "#parent", role: "button", text: "Parent" }] }),
  callElement: async () => ({ title: "Page", url: "https://example.com/forms/post", actions: [] }),
  readMainDocumentId: async () => "",
  withDebugger: async (_id, fn) => fn({}, send),
  elementTargetGrammar: "target grammar",
});

const context = { sessionId: "owner", runId: "run" };
const result = await definition.execute({ tabId: 8, limit: 80 }, null, context);
assert.match(result.snapshot, /button "Parent"/);
assert.match(result.snapshot, /button "Inside"/);
assert.match(result.snapshot, /textbox "Field"/);
assert.match(result.snapshot, /button "Remote"/);
assert.doesNotMatch(result.snapshot, /Hidden|frame:|child-loader|oopif-loader/);
assert.equal(calls.some(call => call.params?.frameId === "grand"), false, "a nested frame is not fetched");
assert.doesNotMatch(result.snapshot, /button "Deep"/);
assert.equal(calls.some(call => call.session === "nested-session"), false, "a nested frame is not addressed");
assert.equal(calls.some(call => call.method === "Target.getTargets" || call.method === "Target.attachToTarget"), false);
assert.equal(calls.some(call => call.method === "Target.setAutoAttach" && call.params?.autoAttach === true), true);
assert.ok(calls.some(call => call.method === "Accessibility.getFullAXTree" && call.params?.frameId === "child"));
assert.ok(calls.some(call => call.method === "Accessibility.getFullAXTree" && call.session === "oopif-session" && call.params?.frameId == null));

const insideTarget = targetFor(result.snapshot, 'button "Inside"');
const fieldTarget = targetFor(result.snapshot, 'textbox "Field"');
const parentTarget = targetFor(result.snapshot, 'button "Parent"');
const crossTarget = targetFor(result.snapshot, 'button "Remote"');
const inside = await element.resolveElementReference(8, { target: insideTarget }, context);
const field = await element.resolveElementReference(8, { target: fieldTarget }, context);
const parent = await element.resolveElementReference(8, { target: parentTarget }, context);
const cross = await element.resolveElementReference(8, { target: crossTarget }, context);
assert.equal(inside.ref.frameId, "child");
assert.equal(inside.ref.backendNodeId, 3);
assert.equal(inside.ref.loaderId, "child-loader");
assert.equal(inside.ref.selector, undefined);
assert.equal(field.ref.frameId, "child");
assert.equal(field.ref.loaderId, "child-loader");
assert.equal(parent.ref.frameId, undefined);
assert.equal(parent.ref.backendNodeId, 3);
assert.equal(parent.ref.selector, "#parent", "a colliding child backend id must not take the parent action");
assert.equal(parent.selector, "");
assert.equal(cross.ref.frameId, "oopif");
assert.equal(cross.ref.loaderId, "oopif-loader");
assert.equal(cross.ref.backendNodeId, 3);

const opened = await openChildFrame(send, "child");
assert.equal(opened.sessionId, "");
assert.equal(opened.loaderId, "child-loader");
assert.equal(await openChildFrame(send, "grand"), null, "a nested frame is not addressed");
calls.length = 0;
assert.equal((await openChildFrame(send, "oopif")).sessionId, "oopif-session");
assert.equal(calls.some(call => call.method === "Target.setAutoAttach"), false, "a live child session is reused");
assert.deepEqual(await frameContentOrigin(send, "child"), { x: 12, y: 34 });
assert.equal(await frameContentOrigin(send, "missing"), null);

echo = true;
calls.length = 0;
const echoed = await definition.execute({ tabId: 8, limit: 80 }, null, context);
assert.doesNotMatch(echoed.snapshot, /button "Inside"/);
assert.equal(echoed.snapshot.split("\n").filter(line => line.includes('button "Parent"')).length, 1);

echo = false;
for (const listener of debuggerListeners.detach) listener({ tabId: 8 });
calls.length = 0;
assert.equal((await openChildFrame(send, "oopif")).sessionId, "oopif-session");
assert.equal(calls.some(call => call.method === "Target.setAutoAttach" && call.params?.autoAttach === true), true, "reconnect opens auto-attach again");
assert.equal(calls.some(call => call.session === "nested-session"), false, "a nested frame is not addressed");

function ax({ id, parent, children = [], backend, role, name }) {
  const node = { nodeId: id, childIds: children, role: { value: role }, name: { value: name } };
  if (parent) node.parentId = parent;
  if (backend) node.backendDOMNodeId = backend;
  return node;
}

function targetFor(snapshot, part) {
  const line = String(snapshot || "").split("\n").find(item => item.includes(part));
  assert.ok(line, part);
  return line.match(/target=(uid:\S+)/)?.[1] || "";
}

console.log("one-level iframe snapshot tests passed");

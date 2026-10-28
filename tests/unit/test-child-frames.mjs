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
const { createCdpRuntime } = await import("../../src/background/tools/cdp-runtime.js");
const { registerAccessibilityTools } = await import("../../src/capabilities/accessibility/tools.js");
const { frameContentOrigin, openChildFrame } = await import("../../src/background/tools/child-frames.js");
const { ToolExecutionError } = await import("../../src/background/tools/arguments.js");

const calls = [];
let echo = false;
let remotePresent = true;
let overviewActions = [{ selector: "#parent", role: "button", text: "Parent", rect: { x: 12, y: 34, w: 100, h: 50 } }];
let scopedActions = [];
let boundIds = [3];
let ancestorNodes = {};
const bindings = [];
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
      if (remotePresent) listener({ tabId: send.tabId }, "Target.attachedToTarget", {
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
  if (method === "DOM.describeNode") return { node: ancestorNodes[params.backendNodeId || params.nodeId] || {} };
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
  bindBackendNodes: async (_tabId, selectors, _context, scope) => {
    bindings.push({ selectors, scope });
    return { loaderId: scope?.loaderId || "main-loader", ids: boundIds };
  },
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => ({ title: "Page", url: "https://example.com/forms/post", viewport: { height: 600 }, actions: overviewActions }),
  callElement: async () => ({ title: "Child", url: "https://child.example.com/", actions: scopedActions }),
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

// A parent action can be missing from the AX depth budget while its backend id
// exists in another process. It must retain a separate parent-document uid.
const parentNode = mainNodes.pop();
mainNodes[0].childIds.pop();
childNodes[1].backendDOMNodeId = 31;
let isolated = await definition.execute({ tabId: 8, limit: 80 }, null, context);
let synthetic = await element.resolveElementReference(8, { target: targetFor(isolated.snapshot, 'button "Parent"') }, context);
assert.equal(synthetic.ref.frameId, undefined);
assert.equal(synthetic.ref.backendNodeId, 3);
assert.equal(synthetic.ref.selector, "#parent");
assert.equal((await element.resolveElementReference(8, { target: targetFor(isolated.snapshot, 'button "Remote"') }, context)).ref.selector, undefined);
oopifNodes[1].ignored = true;
const ignored = await definition.execute({ tabId: 8, limit: 80 }, null, context);
assert.doesNotMatch(ignored.snapshot, /button "Remote"/, "a parent action cannot revive an ignored child with the same backend id");
delete oopifNodes[1].ignored;

// A missing ancestor must not attach the synthetic action to a colliding child.
boundIds = [99];
ancestorNodes = {
  99: { backendNodeId: 99, parentId: 30 },
  30: { backendNodeId: 3, parentId: 10, children: [{ backendNodeId: 99 }] },
  10: { backendNodeId: 1 },
};
isolated = await definition.execute({ tabId: 8, limit: 80 }, null, context);
assert.match(isolated.snapshot, /^ target=uid:\S+ button "Parent"/m, "the missing parent action stays under the main root");

// Anonymous actions also belong to the overview document, even when their name
// matches a child-frame control exactly.
boundIds = [0];
overviewActions = [{ role: "button", text: "Remote", rect: { x: 12, y: 34, w: 100, h: 50 } }];
isolated = await definition.execute({ tabId: 8, limit: 80 }, null, context);
const remoteLines = isolated.snapshot.split("\n").filter(line => line.includes('button "Remote"'));
assert.equal(remoteLines.length, 2);
assert.match(remoteLines.find(line => !line.includes("target=")), /^ button "Remote"/);
assert.ok(remoteLines.some(line => line.includes("target=uid:")), "the real frame control keeps its own uid");

// A child-root overview must bind its selectors in that child's document. Its
// DOM-only actions remain available even when the child AX tree omits them.
overviewActions = [{ selector: "#parent", role: "button", text: "Parent", rect: { x: 12, y: 34, w: 100, h: 50 } }];
scopedActions = [{ selector: "#parent", role: "button", text: "Child-only" }];
boundIds = [77];
ancestorNodes = {};
const scoped = await definition.execute({ tabId: 8, root: crossTarget, limit: 80 }, null, context);
assert.equal(bindings.at(-1).scope?.frameId, "oopif");
assert.equal(bindings.at(-1).scope?.loaderId, "oopif-loader");
synthetic = await element.resolveElementReference(8, { target: targetFor(scoped.snapshot, 'button "Child-only"') }, context);
assert.equal(synthetic.ref.frameId, "oopif");
assert.equal(synthetic.ref.loaderId, "oopif-loader");
assert.equal(synthetic.ref.backendNodeId, 77);
assert.equal(synthetic.ref.pageUrl, "https://example.com/forms/post", "child refs retain the owning tab's URL guard");
assert.doesNotMatch(scoped.snapshot, /Parent|Inside|Child frame|Cross frame/);

boundIds = [0];
const unbound = await definition.execute({ tabId: 8, root: crossTarget, limit: 80 }, null, context);
assert.equal(targetFor(unbound.snapshot, 'button "Child-only"'), "", "an unresolved child selector cannot fall back to the parent document");
const removedRoot = oopifNodes.pop();
const missing = await definition.execute({ tabId: 8, root: crossTarget, limit: 80 }, null, context);
assert.equal(missing.rootFound, false);
assert.equal(missing.snapshot, "", "a removed root cannot publish synthetic controls from an earlier overview");
oopifNodes.push(removedRoot);
mainNodes[0].childIds.push("parent");
mainNodes.push(parentNode);
childNodes[1].backendDOMNodeId = 3;
boundIds = [3];
scopedActions = [];

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

// chrome.debugger.detach() does not emit onDetach. Ending a lease must retire
// its child sessions even if the next auto-attach reports no remote frames.
let detached = false;
const cdp = createCdpRuntime({
  ToolExecutionError,
  isRunCurrent: () => true,
  debuggerApi: {
    onDetach: chrome.debugger.onDetach,
    async attach() {},
    async detach() { detached = true; },
    async sendCommand(target, method, params) {
      if (target.sessionId) {
        if (detached && target.sessionId === "oopif-session") {
          calls.push({ method, params, session: target.sessionId });
          throw new Error("old child session was detached");
        }
        return send.inSession(target.sessionId)(method, params);
      }
      return send(method, params);
    },
  },
});
assert.equal((await cdp.withDebugger(8, (_target, command) => openChildFrame(command, "oopif"), context)).sessionId, "oopif-session");
await cdp.releaseDebugger(8, context);
assert.equal(detached, true);
remotePresent = false;
calls.length = 0;
assert.equal(await cdp.withDebugger(8, (_target, command) => openChildFrame(command, "oopif"), context), null);
assert.equal(calls.some(call => call.session === "oopif-session"), false, "a new connection must not query a programmatically detached child session");
assert.equal(calls.some(call => call.method === "Target.setAutoAttach" && call.params?.autoAttach === true), true, "a new connection arms auto-attach again");
await cdp.releaseDebugger(8, context);
remotePresent = true;

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

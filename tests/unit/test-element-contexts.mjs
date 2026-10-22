import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const events = [], detaches = [];
globalThis.chrome = {
  runtime: { id: "current-extension" },
  debugger: {
    onEvent: { addListener: listener => events.push(listener) },
    onDetach: { addListener: listener => detaches.push(listener) },
  },
};
const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
class ToolExecutionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
let nextTab = 100;
function world(id, extra = {}) {
  return { id, frameId: "main", origin: "chrome-extension://current-extension", type: "isolated",
    extensionId: "current-extension", bridge: true, ...extra };
}
function harness(worlds, options = {}) {
  const tabId = nextTab++, commands = [];
  let loaderId = "document-1", initialized = 0, actions = 0, resolvedContext;
  const emit = (method, params) => events.forEach(listener => listener({ tabId }, method, params));
  const host = {
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({}),
    makeSessionTabTargetError: code => new ToolExecutionError(code, code),
    assertTabAllowed: async () => {},
    sendToContent: async () => { throw new Error("UID must not use CSS fallback"); },
    async initializeContentScript() { initialized++; await options.initialize?.(h); },
    async withDebugger(_tabId, callback) {
      return callback({ tabId }, async (method, params = {}) => {
        commands.push({ method, params });
        await options.beforeSend?.(method, params, h);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId } } };
        if (method === "Runtime.disable" || method === "Runtime.releaseObjectGroup") return {};
        if (method === "Runtime.enable") {
          for (const item of worlds) emit("Runtime.executionContextCreated", { context: {
            id: item.id, origin: item.origin, auxData: { type: item.type, frameId: item.frameId },
          } });
          return {};
        }
        if (method === "Runtime.evaluate") {
          const item = worlds.find(item => item.id === params.contextId);
          if (!item) throw new Error("Cannot find context with specified id");
          if (item.error) throw item.error;
          return { result: { value: runInNewContext(params.expression, {
            chrome: { runtime: { id: item.extensionId } },
            __qzInvoke: item.bridge ? () => {} : undefined,
          }) } };
        }
        if (method === "DOM.resolveNode") {
          resolvedContext = params.executionContextId;
          return { object: { objectId: "original-node" } };
        }
        if (method === "Runtime.callFunctionOn") {
          actions++;
          if (options.actionError) throw options.actionError;
          return { result: { value: { ok: true, contextId: resolvedContext } } };
        }
        throw new Error(`Unexpected CDP method ${method}`);
      });
    },
  };
  const runtime = createElementRuntime(host);
  const h = {
    commands, worlds, emit,
    detach: () => detaches.forEach(listener => listener({ tabId })),
    navigate: () => { loaderId = "document-2"; },
    get initialized() { return initialized; },
    get actions() { return actions; },
    call: (action = "inspectElement") => runtime.callElement(tabId, {
      tabId, uid: "original", ref: { backendNodeId: 44, loaderId: "document-1" },
    }, action),
  };
  return h;
}

test("reload candidates are selected by live identity and bridge, independent of report order or id", async () => {
  for (const bridge of [false, true]) for (const liveId of [7, 99]) for (const reverse of [false, true]) {
    const worlds = [world(liveId), world(100 - liveId, { extensionId: undefined, bridge })];
    if (reverse) worlds.reverse();
    worlds.push(world(200, { frameId: "child" }), world(201, { origin: "chrome-extension://other" }),
      world(202, { type: "default" }), world(203, { extensionId: "other-extension" }));
    const h = harness(worlds);
    for (const action of ["inspectElement", "actOnElement", "readImageElement"]) {
      assert.equal((await h.call(action)).contextId, liveId);
    }
    assert.equal(h.actions, 3);
    assert.equal(h.initialized, 0);
    assert.equal(h.commands.some(item => item.method === "Runtime.disable"), false);
    assert.ok(h.commands.filter(item => item.method === "Runtime.evaluate")
      .every(item => ![200, 201, 202].includes(item.params.contextId)));
    h.detach();
  }
});

test("a candidate disappearing during validation leaves the other candidates usable", async () => {
  const h = harness([world(7), world(8)], { beforeSend(method, params, h) {
    if (method === "Runtime.evaluate" && params.contextId === 7) {
      h.emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
      throw new Error("Execution context was destroyed.");
    }
  } });
  assert.equal((await h.call()).contextId, 8);
  assert.equal(h.initialized, 0);
  assert.equal(h.actions, 1);
});

for (const reset of ["destroy", "clear", "detach"]) test(`${reset} removes cached candidates before the next operation`, async () => {
  const h = harness([world(7)]);
  await h.call();
  if (reset === "destroy") h.emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
  if (reset === "clear") h.emit("Runtime.executionContextsCleared", {});
  if (reset === "detach") h.detach();
  h.worlds.splice(0, 1, world(8));
  h.commands.length = 0;
  assert.equal((await h.call()).contextId, 8);
  assert.deepEqual(h.commands.filter(item => item.method === "Runtime.evaluate").map(item => item.params.contextId), [8]);
  assert.equal(h.commands.some(item => item.method === "Runtime.disable"), false);
});

test("a responding Content without a bridge is initialized once and validated before resolving the node", async () => {
  const h = harness([world(7, { bridge: false })], { initialize(h) { h.worlds.push(world(8)); } });
  assert.equal((await h.call("actOnElement")).contextId, 8);
  assert.equal(h.initialized, 1);
  assert.equal(h.actions, 1);
  assert.equal(h.commands.some(item => item.method === "Runtime.disable"), false);
  const resolve = h.commands.findIndex(item => item.method === "DOM.resolveNode");
  assert.ok(h.commands.slice(0, resolve).some(item => item.method === "Runtime.evaluate" && item.params.contextId === 8));
});

test("an initializer's success or a child-frame bridge cannot substitute for a valid main-frame bridge", async () => {
  const h = harness([world(7, { bridge: false }), world(8, { frameId: "child" })]);
  await assert.rejects(h.call(), { code: "CONTENT_SCRIPT_NOT_READY" });
  assert.equal(h.initialized, 1);
  assert.equal(h.actions, 0);
  assert.equal(h.commands.some(item => item.method === "DOM.resolveNode"), false);
  assert.ok(h.commands.filter(item => item.method === "Runtime.evaluate").every(item => item.params.contextId === 7));
});

test("a navigation during initialization rejects the old UID before resolving or acting", async () => {
  const h = harness([world(7, { bridge: false })], { initialize(h) {
    h.navigate(); h.worlds.push(world(8));
  } });
  await assert.rejects(h.call("actOnElement"), { code: "STALE_ELEMENT_UID" });
  assert.equal(h.initialized, 1);
  assert.equal(h.actions, 0);
  assert.equal(h.commands.some(item => item.method === "DOM.resolveNode"), false);
});

for (const code of ["OPERATION_ABORTED", "SECURITY_GUARDRAIL_BLOCKED", "CDP_RUN_RELEASED", "CDP_TAB_LEASE_CONFLICT", "PERMISSION_DENIED"]) {
  test(`candidate validation propagates ${code} without initialization or dispatch`, async () => {
    const error = new ToolExecutionError(code, code);
    const h = harness([world(7, { error }), world(8)]);
    await assert.rejects(h.call("actOnElement"), value => value === error);
    assert.equal(h.initialized, 0);
    assert.equal(h.actions, 0);
  });
}

test("failure after action dispatch never initializes or replays the action", async () => {
  const error = new Error("Execution context was destroyed.");
  const h = harness([world(7)], { actionError: error });
  await assert.rejects(h.call("actOnElement"), value => value === error);
  assert.equal(h.initialized, 0);
  assert.equal(h.actions, 1);
});

test("detaching a child session drops only that session's isolated contexts", async () => {
  const tabId = nextTab++;
  const commands = [];
  let reportSess = true;
  const emitContext = (sessionId, id, frameId) => events.forEach(listener => listener(
    sessionId ? { tabId, sessionId } : { tabId },
    "Runtime.executionContextCreated",
    { context: { id, origin: "chrome-extension://current-extension", auxData: { type: "isolated", frameId } } },
  ));
  const send = async (method, params = {}) => {
    commands.push({ method, params, sessionId: "" });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "document-1" } } };
    if (method === "Target.setAutoAttach") {
      for (const [sessionId, targetId] of [["sess", "oopif-target"], ["kept", "side-target"]]) {
        events.forEach(listener => listener({ tabId }, "Target.attachedToTarget", {
          sessionId, targetInfo: { type: "iframe", targetId, parentFrameId: "main" },
        }));
      }
      return {};
    }
    if (method === "Runtime.enable") {
      emitContext("", 7, "main");
      return {};
    }
    if (method === "Runtime.evaluate") return { result: { value: { extensionId: "current-extension", bridge: true } } };
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  };
  send.tabId = tabId;
  send.connectionId = 4;
  send.inSession = sessionId => async (method, params = {}) => {
    commands.push({ method, params, sessionId });
    if (method === "Page.getFrameTree") {
      const frame = sessionId === "kept"
        ? { id: "side", loaderId: "side-loader" }
        : { id: "oopif", loaderId: "oopif-loader" };
      return { frameTree: { frame } };
    }
    if (method === "Runtime.enable") {
      if (sessionId === "sess" && reportSess) emitContext("sess", 9, "oopif");
      if (sessionId === "kept") emitContext("kept", 11, "side");
      return {};
    }
    if (method === "Runtime.evaluate") return { result: { value: { extensionId: "current-extension", bridge: true } } };
    if (method === "DOM.resolveNode") return { object: { objectId: `${sessionId}-node` } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected child CDP method ${method}`);
  };
  const runtime = createElementRuntime({
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({}),
    makeSessionTabTargetError: code => new ToolExecutionError(code, code),
    assertTabAllowed: async () => {},
    sendToContent: async () => { throw new Error("UID must not use CSS fallback"); },
    initializeContentScript: async () => {},
    async withDebugger(_tabId, callback) { return callback({ tabId }, send); },
  });
  const call = (frameId, loaderId) => runtime.callElement(tabId, {
    tabId,
    uid: frameId,
    ref: { backendNodeId: 3, loaderId, ...(frameId === "main" ? {} : { frameId }) },
  }, "inspectElement");
  assert.equal((await call("main", "document-1")).ok, true);
  assert.equal((await call("oopif", "oopif-loader")).ok, true);
  assert.equal((await call("side", "side-loader")).ok, true);

  events.forEach(listener => listener({ tabId }, "Target.detachedFromTarget", { sessionId: "sess" }));
  events.forEach(listener => listener({ tabId }, "Target.attachedToTarget", {
    sessionId: "sess",
    targetInfo: { type: "iframe", targetId: "oopif-target", parentFrameId: "main" },
  }));
  reportSess = false;

  commands.length = 0;
  assert.equal((await call("main", "document-1")).ok, true);
  assert.equal(commands.some(item => item.method === "Runtime.enable"), false, "the main frame context stays");

  commands.length = 0;
  assert.equal((await call("side", "side-loader")).ok, true);
  assert.equal(commands.some(item => item.method === "Runtime.enable"), false, "another child session's context stays");

  commands.length = 0;
  await assert.rejects(call("oopif", "oopif-loader"), error => error?.code === "CONTENT_SCRIPT_NOT_READY");
  assert.ok(
    commands.some(item => item.sessionId === "sess" && item.method === "Runtime.enable"),
    "the detached session discovers contexts again",
  );
  assert.equal(commands.some(item => item.method === "Runtime.disable"), false);
});

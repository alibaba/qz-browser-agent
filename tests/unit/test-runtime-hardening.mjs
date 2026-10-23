import assert from "node:assert/strict";
import { test } from "node:test";

const eventListeners = [];
const detachListeners = [];
let detachNotices = 0;
globalThis.chrome = {
  runtime: { id: "current-extension" },
  debugger: {
    onEvent: { addListener(listener) { eventListeners.push(listener); } },
    onDetach: {
      addListener(listener) {
        detachListeners.push(source => {
          detachNotices += 1;
          listener(source);
        });
      },
    },
  },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
const { createCdpRuntime } = await import("../../src/background/tools/cdp-runtime.js");
const { directChildFrames, openChildFrame } = await import("../../src/background/tools/child-frames.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function elementHost(withDebugger, initialize = async () => {}) {
  return {
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({}),
    makeSessionTabTargetError: code => new ToolExecutionError(code, code),
    assertTabAllowed: async () => {},
    sendToContent: async () => { throw new Error("UID must not use CSS fallback"); },
    initializeContentScript: initialize,
    withDebugger,
  };
}

function binding(tabId) {
  return { tabId, uid: "uid", ref: { backendNodeId: 44, loaderId: "document-1" } };
}

function isolatedPage(tabId) {
  let runtimeEnabled = false;
  let nextId = 0;
  let current = null;
  let initialized = 0;
  const commands = [];
  const emit = (method, params) => {
    for (const listener of eventListeners) listener({ tabId }, method, params);
  };
  const send = async (method, params = {}) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "document-1" } } };
    if (method === "Runtime.disable") throw new Error("Runtime.disable");
    if (method === "Runtime.enable") {
      if (runtimeEnabled) return {};
      runtimeEnabled = true;
      nextId += 1;
      current = { id: nextId, uniqueId: `iso-${nextId}` };
      emit("Runtime.executionContextCreated", {
        context: {
          id: current.id,
          uniqueId: current.uniqueId,
          origin: "chrome-extension://current-extension",
          auxData: { type: "isolated", frameId: "main" },
        },
      });
      return {};
    }
    if (method === "Runtime.evaluate") {
      if (params.uniqueContextId && params.uniqueContextId === current?.uniqueId) {
        return { result: { value: { extensionId: "current-extension", bridge: true } } };
      }
      throw new Error("Cannot find context with specified id");
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  };
  const runtime = createElementRuntime(elementHost(async (_tabId, callback) => callback({ tabId }, send), async () => {
    initialized += 1;
  }));
  return {
    commands,
    get initialized() { return initialized; },
    disarm() {
      runtimeEnabled = false;
      current = null;
    },
    call: () => runtime.callElement(tabId, binding(tabId), "inspectElement"),
  };
}

function cdpHarness() {
  const calls = [];
  const activeRuns = new Set();
  const debuggerApi = {
    onDetach: { addListener() {} },
    async attach(target) { calls.push(["attach", target.tabId]); },
    async detach(target) { calls.push(["detach", target.tabId]); },
    async sendCommand(target, method, params) {
      calls.push(["command", target.tabId, method, params || {}]);
      return {};
    },
  };
  const runtime = createCdpRuntime({
    ToolExecutionError,
    debuggerApi,
    isRunCurrent: input => activeRuns.has(`${input.sessionId}:${input.runId}`),
  });
  const key = run => `${run.sessionId}:${run.runId}`;
  return {
    runtime,
    calls,
    activate(run) { activeRuns.add(key(run)); },
    retire(run) { activeRuns.delete(key(run)); },
  };
}

test("programmatic detach clears isolated contexts so later runs probe once", async () => {
  const tabId = 80;
  const page = isolatedPage(tabId);
  const cdp = cdpHarness();
  const notices = detachNotices;
  const counts = [];
  for (let index = 1; index <= 8; index += 1) {
    const run = { sessionId: "session-a", runId: `run-${index}` };
    cdp.activate(run);
    await cdp.runtime.sendCdp(tabId, "Page.enable", {}, run);
    const mark = page.commands.length;
    assert.equal((await page.call()).ok, true);
    const slice = page.commands.slice(mark);
    const probes = slice.filter(command => command.method === "Runtime.evaluate");
    counts.push(probes.length);
    assert.equal(probes.length, 1, `run ${index} evaluate count`);
    assert.equal(probes[0].params.contextId, undefined);
    assert.equal(typeof probes[0].params.uniqueContextId, "string");
    assert.equal(slice.filter(command => command.method === "Runtime.enable").length, 1);
    assert.equal(slice.some(command => command.method === "Runtime.disable"), false);
    await cdp.runtime.releaseRun(run.sessionId, run.runId);
    page.disarm();
    cdp.retire(run);
  }
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(page.initialized, 0, "a fresh connection already has a bridged context");
  assert.equal(detachNotices, notices, "programmatic detach does not emit onDetach");
  assert.equal(cdp.calls.filter(call => call[0] === "detach" && call[1] === tabId).length, 8);
  assert.equal(cdp.calls.some(call => call[2] === "Runtime.disable"), false);
});

test("a retained connection keeps Runtime and its isolated contexts", async () => {
  const tabId = 81;
  const page = isolatedPage(tabId);
  const cdp = cdpHarness();
  const run = { sessionId: "mobile", runId: "first" };
  cdp.activate(run);
  await cdp.runtime.sendCdp(tabId, "Page.enable", {}, run);
  assert.equal((await page.call()).ok, true);
  cdp.runtime.setDebuggerRetention(tabId, true, run);
  const beforeRelease = cdp.calls.length;
  await cdp.runtime.releaseRun(run.sessionId, run.runId);
  const cleanup = cdp.calls.slice(beforeRelease).filter(call => call[0] === "command").map(call => call[2]);
  assert.deepEqual(cleanup, ["Input.dispatchTouchEvent", "Network.disable", "Page.disable"]);
  assert.equal(cdp.calls.some(call => call[0] === "detach"), false, "mobile mode keeps the connection");
  const mark = page.commands.length;
  assert.equal((await page.call()).ok, true);
  const slice = page.commands.slice(mark);
  assert.equal(slice.filter(command => command.method === "Runtime.evaluate").length, 1);
  assert.equal(slice.some(command => command.method === "Runtime.enable"), false);
  assert.equal(slice.some(command => command.method === "Runtime.disable"), false);
  cdp.retire(run);
});

test("a real debugger disconnect clears isolated contexts", async () => {
  const tabId = 83;
  const page = isolatedPage(tabId);
  await page.call();
  const notices = detachNotices;
  for (const listener of detachListeners) listener({ tabId });
  assert.ok(detachNotices > notices);
  page.disarm();
  const mark = page.commands.length;
  assert.equal((await page.call()).ok, true);
  const slice = page.commands.slice(mark);
  assert.equal(slice.filter(command => command.method === "Runtime.evaluate").length, 1);
  assert.equal(slice.filter(command => command.method === "Runtime.enable").length, 1);
  assert.notEqual(slice.find(command => command.method === "Runtime.evaluate").params.uniqueContextId, "iso-1");
});

test("selection uses uniqueContextId when a numeric execution context id is reused", async () => {
  const tabId = 82;
  const commands = [];
  let phase = "live";
  let initialized = 0;
  const emit = (method, params) => {
    for (const listener of eventListeners) listener({ tabId }, method, params);
  };
  const contextEvent = (uniqueId) => emit("Runtime.executionContextCreated", {
    context: {
      id: 7,
      uniqueId,
      origin: "chrome-extension://current-extension",
      auxData: { type: "isolated", frameId: "main" },
    },
  });
  const runtime = createElementRuntime(elementHost(async (_tabId, callback) => callback({ tabId }, async (method, params = {}) => {
    commands.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "document-1" } } };
    if (method === "Runtime.disable") throw new Error("Runtime.disable");
    if (method === "Runtime.enable") {
      if (phase === "live") contextEvent("iso-a");
      if (phase === "replaced") contextEvent("iso-b");
      return {};
    }
    if (method === "Runtime.evaluate") {
      assert.equal(params.contextId, undefined, "a reported unique id is the probe identity");
      if (params.uniqueContextId === "iso-a" && phase === "live") {
        return { result: { value: { extensionId: "current-extension", bridge: true } } };
      }
      if (params.uniqueContextId === "iso-b" && phase === "replaced") {
        return { result: { value: { extensionId: "current-extension", bridge: true } } };
      }
      if (!params.uniqueContextId) {
        return { result: { value: { extensionId: "current-extension", bridge: true } } };
      }
      throw new Error("Cannot find context with specified id");
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  }), async () => { initialized += 1; }));
  const call = () => runtime.callElement(tabId, binding(tabId), "inspectElement");

  assert.equal((await call()).ok, true);
  assert.equal(commands.filter(command => command.method === "Runtime.evaluate").at(-1).params.uniqueContextId, "iso-a");

  phase = "stale";
  commands.length = 0;
  await assert.rejects(call(), error => error?.code === "CONTENT_SCRIPT_NOT_READY");
  assert.equal(commands.find(command => command.method.startsWith("Runtime.")).method, "Runtime.evaluate");
  assert.ok(commands.some(command => command.method === "Runtime.evaluate" && command.params.uniqueContextId === "iso-a"));
  assert.equal(commands.some(command => command.method === "Runtime.evaluate" && command.params.contextId != null), false);
  assert.equal(commands.some(command => command.method === "DOM.resolveNode"), false);
  assert.equal(commands.some(command => command.method === "Runtime.disable"), false);
  assert.equal(initialized, 1);

  phase = "replaced";
  contextEvent("iso-b");
  commands.length = 0;
  assert.equal((await call()).ok, true);
  assert.deepEqual(
    commands.filter(command => command.method === "Runtime.evaluate").map(command => command.params.uniqueContextId),
    ["iso-b"],
  );
  assert.equal(commands.find(command => command.method === "DOM.resolveNode").params.executionContextId, 7);
  assert.equal(commands.some(command => command.method === "Runtime.enable" || command.method === "Runtime.disable"), false);

  emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
  phase = "stale";
  commands.length = 0;
  await assert.rejects(call(), error => error?.code === "CONTENT_SCRIPT_NOT_READY");
  assert.equal(commands.find(command => command.method.startsWith("Runtime.")).method, "Runtime.enable", "destroying a context drops its unique id");
  assert.equal(commands.some(command => command.params?.uniqueContextId === "iso-b"), false);
  assert.equal(commands.some(command => command.method === "Runtime.disable"), false);
});

test("detaching a child session drops that session's unique context id", async () => {
  const tabId = 84;
  const commands = [];
  let reportSess = true;
  const emitContext = (sessionId, id, frameId, uniqueId) => {
    for (const listener of eventListeners) {
      listener(sessionId ? { tabId, sessionId } : { tabId }, "Runtime.executionContextCreated", {
        context: {
          id,
          uniqueId,
          origin: "chrome-extension://current-extension",
          auxData: { type: "isolated", frameId },
        },
      });
    }
  };
  const send = async (method, params = {}) => {
    commands.push({ method, params, sessionId: "" });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "document-1" } } };
    if (method === "Target.setAutoAttach") {
      for (const [sessionId, targetId] of [["sess", "oopif-target"], ["kept", "side-target"]]) {
        for (const listener of eventListeners) {
          listener({ tabId }, "Target.attachedToTarget", {
            sessionId,
            targetInfo: { type: "iframe", targetId, parentFrameId: "main" },
          });
        }
      }
      return {};
    }
    if (method === "Runtime.enable") {
      emitContext("", 7, "main", "main-1");
      return {};
    }
    if (method === "Runtime.evaluate") {
      if (params.uniqueContextId !== "main-1") throw new Error("Cannot find context with specified id");
      assert.equal(params.contextId, undefined);
      return { result: { value: { extensionId: "current-extension", bridge: true } } };
    }
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
      if (sessionId === "sess" && reportSess) emitContext("sess", 9, "oopif", "oopif-1");
      if (sessionId === "kept") emitContext("kept", 11, "side", "side-1");
      return {};
    }
    if (method === "Runtime.evaluate") {
      const expected = sessionId === "kept" ? "side-1" : reportSess ? "oopif-1" : "";
      if (!expected || params.uniqueContextId !== expected) throw new Error("Cannot find context with specified id");
      assert.equal(params.contextId, undefined);
      return { result: { value: { extensionId: "current-extension", bridge: true } } };
    }
    if (method === "DOM.resolveNode") return { object: { objectId: `${sessionId}-node` } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected child CDP method ${method}`);
  };
  const runtime = createElementRuntime(elementHost(async (_tabId, callback) => callback({ tabId }, send)));
  const call = (frameId, loaderId) => runtime.callElement(tabId, {
    tabId,
    uid: frameId,
    ref: { backendNodeId: 3, loaderId, ...(frameId === "main" ? {} : { frameId }) },
  }, "inspectElement");
  assert.equal((await call("main", "document-1")).ok, true);
  assert.equal((await call("oopif", "oopif-loader")).ok, true);
  assert.equal((await call("side", "side-loader")).ok, true);

  for (const listener of eventListeners) listener({ tabId }, "Target.detachedFromTarget", { sessionId: "sess" });
  for (const listener of eventListeners) {
    listener({ tabId }, "Target.attachedToTarget", {
      sessionId: "sess",
      targetInfo: { type: "iframe", targetId: "oopif-target", parentFrameId: "main" },
    });
  }
  reportSess = false;

  commands.length = 0;
  assert.equal((await call("main", "document-1")).ok, true);
  assert.equal(commands.some(command => command.method === "Runtime.enable"), false);
  assert.deepEqual(
    commands.filter(command => command.method === "Runtime.evaluate").map(command => command.params.uniqueContextId),
    ["main-1"],
  );

  commands.length = 0;
  assert.equal((await call("side", "side-loader")).ok, true);
  assert.equal(commands.some(command => command.method === "Runtime.enable"), false);
  assert.deepEqual(
    commands.filter(command => command.method === "Runtime.evaluate").map(command => command.params.uniqueContextId),
    ["side-1"],
  );

  commands.length = 0;
  await assert.rejects(call("oopif", "oopif-loader"), error => error?.code === "CONTENT_SCRIPT_NOT_READY");
  assert.ok(commands.some(command => command.sessionId === "sess" && command.method === "Runtime.enable"));
  assert.equal(commands.some(command => command.params?.uniqueContextId === "oopif-1"), false);
  assert.equal(commands.some(command => command.method === "Runtime.disable"), false);
});

test("direct child lookup reads auto-attached frames from the same table", async () => {
  const tabId = 85;
  const calls = [];
  const send = async (method, params = {}) => {
    calls.push({ method, params, session: "" });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "main-loader" } } };
    if (method === "Target.setAutoAttach") {
      for (const listener of eventListeners) {
        listener({ tabId }, "Target.attachedToTarget", {
          sessionId: "oopif-session",
          targetInfo: { type: "iframe", targetId: "oopif-target", parentFrameId: "main" },
        });
      }
      return {};
    }
    return {};
  };
  send.tabId = tabId;
  send.connectionId = 9;
  send.inSession = sessionId => async (method, params = {}) => {
    calls.push({ method, params, session: sessionId });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "oopif", loaderId: "oopif-loader" } } };
    return {};
  };
  const listed = await directChildFrames(send);
  assert.equal(listed.find(frame => frame.id === "oopif")?.sessionId, "oopif-session");
  calls.length = 0;
  const opened = await openChildFrame(send, "oopif");
  assert.equal(opened?.sessionId, "oopif-session");
  assert.equal(calls.some(call => call.method === "Target.setAutoAttach"), false);
});

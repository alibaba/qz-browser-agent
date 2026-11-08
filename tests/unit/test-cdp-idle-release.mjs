import assert from "node:assert/strict";
import test from "node:test";
import { createCdpRuntime } from "../../src/background/tools/cdp-runtime.js";
import { runToolWithTimeout } from "../../src/background/tools/tool-timeout.js";

const IDLE_MS = 40;
const runA = { sessionId: "idle-session", runId: "idle-run" };
const runB = { sessionId: "reader-session", runId: "reader-run" };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function advance(t, milliseconds = IDLE_MS) {
  t.mock.timers.tick(milliseconds);
  await flush();
}

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    Object.assign(this, { code, details });
  }
}

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const calls = [], listeners = [];
  let attach = async () => {}, detach = async () => {}, command = async () => ({});
  const runtime = createCdpRuntime({
    idleMs: IDLE_MS,
    ToolExecutionError,
    isRunCurrent: () => true,
    authorizeRunTab: async () => {},
    ...options,
    debuggerApi: {
      onDetach: { addListener(listener) { listeners.push(listener); } },
      async attach(target) {
        calls.push(["attach", target.tabId]);
        await attach(target);
        calls.push(["attached", target.tabId]);
      },
      async detach(target) {
        calls.push(["detach", target.tabId]);
        await detach(target);
        calls.push(["detached", target.tabId]);
      },
      async sendCommand(target, method, params) {
        calls.push(["command", target.tabId, method]);
        return command(target, method, params);
      },
    },
  });
  t.after(async () => {
    await runtime.releaseSession(runA.sessionId);
    await runtime.releaseSession(runB.sessionId);
  });
  return {
    runtime, calls,
    count: kind => calls.filter(call => call[0] === kind).length,
    attach: handler => { attach = handler; },
    detach: handler => { detach = handler; },
    command: handler => { command = handler; },
    dismiss: () => listeners.forEach(listener => listener({ tabId: 7 }, "canceled_by_user")),
  };
}

test("a timeout terminates before returning, even when its trace arrives during the next evaluation", async t => {
  const f = harness(t), trace = Promise.withResolvers(), next = Promise.withResolvers();
  const release = f.runtime.beginDebuggerExecution(runA);
  let evaluations = 0;
  const params = { expression: 'Object.defineProperty(__qzPromise, "__qzTrace"', awaitPromise: true };
  f.command(async (_target, method, args) => {
    if (method === "Runtime.evaluate") return { result: { type: "object", subtype: "promise", objectId: `p${++evaluations}` } };
    if (method === "Runtime.awaitPromise") return args.promiseObjectId === "p1" ? new Promise(() => {}) : next.promise;
    if (method === "Runtime.callFunctionOn") return trace.promise;
    if (method === "Runtime.terminateExecution" && evaluations > 1) next.reject(new Error("Execution was terminated"));
    return {};
  });
  t.after(() => { trace.resolve({}); next.resolve({}); release(); });
  const first = runToolWithTimeout("evaluate", signal => f.runtime.evaluateCdpScript(7, params, signal, runA),
    undefined, 10, async () => null, runA).catch(error => error);
  await flush();
  await advance(t, 10);
  await advance(t, 1000);
  assert.equal((await first).code, "TOOL_TIMEOUT");
  const terminations = () => f.calls.filter(call => call[2] === "Runtime.terminateExecution").length;
  assert.equal(terminations(), 1, "termination must not wait for a stalled trace read");
  const second = f.runtime.evaluateCdpScript(7, params, undefined, runA);
  second.catch(() => {});
  await flush();
  assert.equal(evaluations, 2);
  trace.resolve({ result: { value: [{ level: "trace", message: "late checkpoint" }] } });
  await flush();
  assert.equal(terminations(), 1, "late diagnostics have no authority to terminate a subsequent call");
  next.resolve({ result: { value: 42 } });
  assert.equal((await second).result.value, 42);
});

test("aborting an evaluation on a replaced connection cannot terminate its same-run successor", async t => {
  const f = harness(t), stop = new AbortController(), next = Promise.withResolvers();
  let evaluations = 0;
  f.command(async (_target, method, args) => {
    if (method === "Runtime.evaluate") return { result: { type: "object", subtype: "promise", objectId: `p${++evaluations}` } };
    if (method === "Runtime.awaitPromise") return args.promiseObjectId === "p1" ? new Promise(() => {}) : next.promise;
    return {};
  });
  t.after(() => { stop.abort(); next.resolve({}); });
  const first = f.runtime.evaluateCdpScript(7, { expression: "pending()", awaitPromise: true }, stop.signal, runA);
  first.catch(() => {});
  await flush();
  f.dismiss();
  const second = f.runtime.evaluateCdpScript(7, { expression: "next()", awaitPromise: true }, undefined, runA);
  await flush();
  assert.equal(evaluations, 2);
  stop.abort();
  await assert.rejects(first, { code: "OPERATION_ABORTED" });
  assert.equal(f.calls.some(call => call[2] === "Runtime.terminateExecution"), false);
  next.resolve({ result: { value: "next result" } });
  assert.equal((await second).result.value, "next result");
});

test("a script keeps its connection across waits, then releases after the idle delay", async t => {
  const { runtime, count } = harness(t);
  const release = runtime.beginDebuggerExecution(runA);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  await advance(t, IDLE_MS * 10);
  assert.equal(count("detach"), 0);
  release();
  release();
  await advance(t, IDLE_MS - 1);
  assert.notEqual(runtime.getDebuggerConnectionId(7), null);
  await advance(t, 1);
  assert.equal(runtime.getDebuggerConnectionId(7), null);
  assert.equal(count("detach"), 1, "repeated release does not schedule duplicate cleanup");
});

test("new activity cancels an old idle deadline and receives a full new grace period", async t => {
  const { runtime, count } = harness(t);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  await advance(t, IDLE_MS - 1);
  const release = runtime.beginDebuggerExecution(runA);
  await advance(t, IDLE_MS * 3);
  assert.equal(count("detach"), 0);
  release();
  await advance(t, IDLE_MS - 1);
  assert.equal(count("detach"), 0);
  await advance(t, 1);
  assert.equal(count("detach"), 1);
});

test("the same run reconnects after idle release and detach notifications identify each connection", async t => {
  const { runtime, count } = harness(t);
  const detached = [];
  const unsubscribe = runtime.onDebuggerDetached((tabId, connectionId) => detached.push({ tabId, connectionId }));
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  const first = runtime.getDebuggerConnectionId(7);
  await advance(t);
  assert.deepEqual(detached, [{ tabId: 7, connectionId: first }]);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  const second = runtime.getDebuggerConnectionId(7);
  assert.notEqual(second, first);
  assert.equal(count("attach"), 2);
  unsubscribe();
  await advance(t);
  assert.equal(count("detach"), 2);
  assert.equal(detached.length, 1);
});

test("parallel and nested execution scopes release independently", async t => {
  const { runtime, count } = harness(t);
  const parent = runtime.beginDebuggerExecution(runA);
  const child = runtime.beginDebuggerExecution(runA);
  const sibling = runtime.beginDebuggerExecution(runA);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  parent();
  child();
  await advance(t, IDLE_MS * 3);
  assert.equal(count("detach"), 0);
  sibling();
  await advance(t);
  assert.equal(count("detach"), 1);
});

test("cancellation releases scopes and pending commands even when their handler settles late", async t => {
  const f = harness(t);
  const controller = new AbortController();
  const context = { ...runA, signal: controller.signal };
  const release = f.runtime.beginDebuggerExecution(context);
  const gate = Promise.withResolvers();
  f.command(() => gate.promise);
  const pending = f.runtime.sendCdp(7, "Runtime.evaluate", {}, context);
  const rejected = assert.rejects(pending, error => ["OPERATION_ABORTED", "CDP_RUN_RELEASED", "CDP_COMMAND_FAILED"].includes(error.code));
  await flush();
  controller.abort();
  await advance(t);
  assert.equal(f.count("detach"), 1, "an uncooperative command cannot keep the debugging bar alive");
  gate.resolve({ result: "late" });
  await rejected;
  release();
  await advance(t);
  assert.equal(f.count("detach"), 1);
});

test("persistent retention reasons are independent and survive script signal cancellation", async t => {
  const { runtime, count } = harness(t);
  const controller = new AbortController();
  const context = { ...runA, signal: controller.signal };
  runtime.beginDebuggerExecution(context);
  await runtime.sendCdp(7, "Network.enable", {}, context);
  const stopWatch = runtime.retainDebugger(7, "network-watch", context);
  const stopCapture = runtime.retainDebugger(7, "capture", context);
  controller.abort();
  await advance(t, IDLE_MS * 3);
  assert.equal(count("detach"), 0);
  stopWatch();
  stopWatch();
  await advance(t);
  assert.equal(count("detach"), 0, "ending one feature must not end another feature's retention");
  stopCapture();
  await advance(t);
  assert.equal(count("detach"), 1);
});

test("mobile emulation remains attached after network retention is released", async t => {
  const { runtime, count } = harness(t);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  runtime.setDebuggerRetention(7, true, runA);
  const stopWatch = runtime.retainDebugger(7, "network-watch", runA);
  stopWatch();
  await advance(t, IDLE_MS * 3);
  assert.equal(count("detach"), 0);
  runtime.setDebuggerRetention(7, false, runA);
  await advance(t);
  assert.equal(count("detach"), 1);
});

test("a shared read-only compound operation protects its owner's physical connection", async t => {
  const f = harness(t, { isReadOnlyAccess: (_tabId, context) => context.runId === runB.runId });
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  const ownerConnection = f.runtime.getDebuggerConnectionId(7);
  const gate = Promise.withResolvers();
  const reading = f.runtime.withDebugger(7, async (_target, send) => {
    await send("DOM.getDocument");
    await gate.promise;
    return send("DOM.describeNode");
  }, runB);
  await flush();
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 0);
  assert.equal(f.runtime.getDebuggerConnectionId(7), ownerConnection);
  assert.equal(f.runtime.getDebuggerRun(7).runId, runA.runId, "a reader does not take ownership");
  gate.resolve();
  await reading;
  await advance(t);
  assert.equal(f.count("detach"), 1);
});

test("a pending CDP command stays attached without an outer script scope", async t => {
  const f = harness(t);
  const gate = Promise.withResolvers();
  f.command(() => gate.promise);
  const pending = f.runtime.sendCdp(7, "Page.captureScreenshot", {}, runA);
  await flush();
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 0);
  gate.resolve({ data: "image" });
  assert.deepEqual(await pending, { data: "image" });
  await advance(t);
  assert.equal(f.count("detach"), 1);
});

test("page evaluation holds across awaitPromise and releases when its separate signal aborts", async t => {
  const f = harness(t);
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  f.command((_target, method) => method === "Runtime.evaluate"
    ? { result: { type: "object", subtype: "promise", objectId: "pending-script" } }
    : method === "Runtime.awaitPromise" ? gate.promise : {});
  const pending = f.runtime.evaluateCdpScript(7, { expression: "new Promise(() => {})", awaitPromise: true }, controller.signal, runA);
  const rejected = assert.rejects(pending, { code: "OPERATION_ABORTED" });
  await flush();
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 0);
  controller.abort();
  await rejected;
  await advance(t);
  assert.equal(f.count("detach"), 1);
  assert.ok(f.calls.some(call => call[2] === "Runtime.terminateExecution"));
  gate.resolve({ result: { value: "late" } });
});

test("page evaluation preserves non-enumerable runtime authority when given a separate signal", async t => {
  const authority = Symbol("runtime-authority");
  const context = { ...runA };
  Object.defineProperty(context, authority, { value: {} });
  let checks = 0;
  const f = harness(t, { isRunCurrent: access => {
    checks++;
    return access.context === context && access.context[authority] === context[authority];
  } });
  f.command(() => ({ result: { type: "number", value: 7 } }));
  const result = await f.runtime.evaluateCdpScript(7, { expression: "7" }, new AbortController().signal, context);
  assert.equal(result.result.value, 7);
  assert.ok(checks > 0);
  await advance(t);
  assert.equal(f.count("detach"), 1);
});

test("a stale retention release cannot affect the replacement connection", async t => {
  const { runtime, count } = harness(t);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  const oldRelease = runtime.retainDebugger(7, "network-watch", runA);
  await runtime.releaseDebugger(7, runA);
  await runtime.sendCdp(7, "Page.enable", {}, runA);
  const newRelease = runtime.retainDebugger(7, "network-watch", runA);
  oldRelease();
  await advance(t, IDLE_MS * 3);
  assert.equal(count("detach"), 1);
  newRelease();
  await advance(t);
  assert.equal(count("detach"), 2);
});

test("a new call waits for in-progress idle detach before creating its replacement connection", async t => {
  const f = harness(t);
  const gate = Promise.withResolvers();
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  f.detach(() => gate.promise);
  await advance(t);
  assert.equal(f.count("detach"), 1);
  const release = f.runtime.beginDebuggerExecution(runA);
  const pending = f.runtime.sendCdp(7, "Page.enable", {}, runA);
  await flush();
  assert.equal(f.count("attach"), 1, "attach cannot race the previous detach");
  gate.resolve();
  await pending;
  assert.equal(f.count("attach"), 2);
  assert.ok(f.calls.findIndex(call => call[0] === "detached") < f.calls.findLastIndex(call => call[0] === "attach"));
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 1, "the old cleanup cannot retire the new active connection");
  release();
  await advance(t);
  assert.equal(f.count("detach"), 2);
});

test("cancellation during attach never dispatches the command and cleans up the completed attach", async t => {
  const f = harness(t);
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  const context = { ...runA, signal: controller.signal };
  f.attach(() => gate.promise);
  const release = f.runtime.beginDebuggerExecution(context);
  const pending = f.runtime.sendCdp(7, "Input.dispatchMouseEvent", {}, context);
  const rejected = assert.rejects(pending, error => ["OPERATION_ABORTED", "CDP_RUN_RELEASED", "CDP_COMMAND_FAILED"].includes(error.code));
  await flush();
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 0);
  controller.abort();
  gate.resolve();
  await rejected;
  release();
  await advance(t);
  assert.equal(f.count("command"), 0);
  assert.equal(f.count("detach"), 1);
});

test("terminal run cleanup releases persistent watch retention immediately", async t => {
  const { runtime, count } = harness(t);
  await runtime.sendCdp(7, "Network.enable", {}, runA);
  const stop = runtime.retainDebugger(7, "network-watch", runA);
  await runtime.releaseRun(runA.sessionId, runA.runId);
  assert.equal(count("detach"), 1);
  stop();
  await advance(t);
  assert.equal(count("detach"), 1);
});

test("manual dismissal does not trigger automatic reattachment or retained-mode recovery", async t => {
  const f = harness(t);
  let restores = 0;
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  f.runtime.setDebuggerRetention(7, true, runA, async () => { restores++; });
  f.dismiss();
  const release = f.runtime.beginDebuggerExecution(runA);
  await advance(t, IDLE_MS * 3);
  release();
  await advance(t);
  assert.equal(f.count("attach"), 1);
  assert.equal(restores, 0);
  assert.equal(f.runtime.getDebuggerConnectionId(7), null);
});

test("a transient idle detach failure preserves the connection and retries once", async t => {
  const f = harness(t);
  let attempts = 0;
  f.detach(async () => { if (++attempts === 1) throw new Error("Temporary debugger transport failure"); });
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  const connection = f.runtime.getDebuggerConnectionId(7);
  await advance(t);
  assert.equal(f.count("detach"), 1);
  assert.equal(f.runtime.getDebuggerConnectionId(7), connection);
  await advance(t);
  assert.equal(f.count("detach"), 2);
  assert.equal(f.runtime.getDebuggerConnectionId(7), null);
  assert.equal(f.count("attach"), 1);
});

test("repeated idle detach failures do not spin and explicit activity can retry without a duplicate attach", async t => {
  const f = harness(t);
  f.detach(async () => { throw new Error("Temporary debugger transport failure"); });
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  const connection = f.runtime.getDebuggerConnectionId(7);
  await advance(t);
  await advance(t);
  await advance(t, IDLE_MS * 10);
  assert.equal(f.count("detach"), 2, "idle retry must be bounded");
  assert.equal(f.runtime.getDebuggerConnectionId(7), connection);
  await f.runtime.sendCdp(7, "DOM.getDocument", {}, runA);
  assert.equal(f.count("attach"), 1, "the debugger is already attached despite the failed cleanup");
  f.detach(async () => {});
  await advance(t);
  assert.equal(f.count("detach"), 3);
  assert.equal(f.runtime.getDebuggerConnectionId(7), null);
});

test("new activity awaiting a failed detach keeps the restored connection active", async t => {
  const f = harness(t);
  const gate = Promise.withResolvers();
  f.detach(() => gate.promise);
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  const connection = f.runtime.getDebuggerConnectionId(7);
  await advance(t);
  const release = f.runtime.beginDebuggerExecution(runA);
  const pending = f.runtime.sendCdp(7, "DOM.getDocument", {}, runA);
  await flush();
  gate.reject(new Error("Temporary debugger transport failure"));
  await pending;
  assert.equal(f.runtime.getDebuggerConnectionId(7), connection);
  assert.equal(f.count("attach"), 1);
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 1, "the failed cleanup's retry cannot interrupt the new operation");
  f.detach(async () => {});
  release();
  await advance(t);
  assert.equal(f.count("detach"), 2);
});

test("terminal cleanup supersedes an in-progress idle detach failure", async t => {
  const f = harness(t);
  const gate = Promise.withResolvers();
  f.detach(() => gate.promise);
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  await advance(t);
  const terminal = f.runtime.releaseRun(runA.sessionId, runA.runId);
  gate.reject(new Error("Temporary debugger transport failure"));
  await terminal;
  assert.equal(f.runtime.getDebuggerConnectionId(7), null, "failed idle cleanup must not revive a terminal lease");
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 1);
});

test("an already detached browser target retires the cached connection without retry", async t => {
  const f = harness(t);
  f.detach(async () => { throw new Error("Debugger is not attached"); });
  await f.runtime.sendCdp(7, "Page.enable", {}, runA);
  await advance(t);
  assert.equal(f.runtime.getDebuggerConnectionId(7), null);
  await advance(t, IDLE_MS * 3);
  assert.equal(f.count("detach"), 1);
});

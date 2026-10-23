import assert from "node:assert/strict";
import { createCdpRuntime } from "../../src/background/tools/cdp-runtime.js";

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function createHarness({ confirmUserReattach = null } = {}) {
  const detachListeners = [];
  const calls = [];
  const allowedTabs = [];
  const authorized = [];
  const activeRuns = new Set();
  const livenessChecks = [];
  const reattachPrompts = [];
  let commandHandler = async (_target, method) => ({ method });
  let authorizeHandler = async () => {};
  const debuggerApi = {
    onDetach: { addListener(listener) { detachListeners.push(listener); } },
    async attach(target, version) { calls.push(["attach", target.tabId, version]); },
    async detach(target) { calls.push(["detach", target.tabId]); },
    async sendCommand(target, method, params) {
      calls.push(["command", target.tabId, method, params, target.sessionId || ""]);
      return await commandHandler(target, method, params);
    },
  };
  const runtime = createCdpRuntime({
    ToolExecutionError,
    debuggerApi,
    isRunCurrent(input) {
      livenessChecks.push(input);
      return activeRuns.has(runKey(input));
    },
    async assertTabAllowed(tabId) { allowedTabs.push(tabId); },
    async authorizeRunTab(input) {
      authorized.push(input);
      await authorizeHandler(input);
      if (input.tabId === 99) {
        throw new ToolExecutionError("SESSION_TAB_FOREIGN", "foreign tab", { tabId: input.tabId });
      }
    },
    ...(typeof confirmUserReattach === "function" ? {
      confirmUserReattach(input) {
        reattachPrompts.push(input);
        return confirmUserReattach(input);
      },
    } : {}),
  });
  return {
    runtime,
    calls,
    allowedTabs,
    authorized,
    livenessChecks,
    detachListeners,
    reattachPrompts,
    activateRun(run) { activeRuns.add(runKey(run)); },
    retireRun(run) { activeRuns.delete(runKey(run)); },
    setCommandHandler(handler) { commandHandler = handler; },
    setAuthorizeHandler(handler) { authorizeHandler = handler; },
  };
}

function runKey({ sessionId, runId } = {}) {
  return `${String(sessionId || "")}:${String(runId || "")}`;
}

const runA = { sessionId: "session-a", runId: "run-a" };
const runB = { sessionId: "session-b", runId: "run-b" };
const harness = createHarness();
const { runtime, calls, allowedTabs, authorized, livenessChecks, detachListeners } = harness;
harness.activateRun(runA);
harness.activateRun(runB);

await runtime.sendCdp(7, "Page.enable", {}, runA);
await runtime.sendCdp(7, "Runtime.enable", {}, runA);
const firstConnection = runtime.getDebuggerConnectionId(7);
assert.equal(typeof firstConnection, "number");
await runtime.releaseDebugger(7, runB);
assert.equal(runtime.getDebuggerConnectionId(7), firstConnection, "failed setup cannot release another run's lease");
assert.equal(calls.filter(call => call[0] === "attach" && call[1] === 7).length, 1, "one run reuses one physical tab connection");
assert.equal(calls.filter(call => call[0] === "detach" && call[1] === 7).length, 0, "tool completion must not detach a run-owned tab");
assert.deepEqual(allowedTabs, [7]);
assert.equal(authorized.length, 1, "ownership is checked once for the physical run/tab connection");
assert.ok(livenessChecks.length >= 2, "Supervisor liveness is checked even when reusing a cached connection");

await Promise.all([
  runtime.sendCdp(8, "Page.enable", {}, runA),
  runtime.sendCdp(8, "Runtime.enable", {}, runA),
]);
assert.equal(calls.filter(call => call[0] === "attach" && call[1] === 8).length, 1, "concurrent first use must coalesce attach");

await assert.rejects(
  runtime.sendCdp(7, "Page.enable", {}, runB),
  error => error?.code === "CDP_TAB_LEASE_CONFLICT" && error?.details?.currentRunId === "run-a",
  "another run must not steal an attached tab",
);
await assert.rejects(
  runtime.sendCdp(99, "Page.enable", {}, runA),
  error => error?.code === "SESSION_TAB_FOREIGN",
);
assert.equal(calls.some(call => call[0] === "attach" && call[1] === 99), false, "foreign ownership is rejected before attach");
await assert.rejects(
  runtime.sendCdp(10, "Page.enable"),
  error => error?.code === "CDP_RUN_CONTEXT_REQUIRED",
);

detachListeners.forEach(listener => listener({ tabId: 7 }, "canceled_by_user"));
assert.equal(runtime.getDebuggerConnectionId(7), null, "detached emulation must not be reported as active");
await runtime.sendCdp(7, "Runtime.enable", {}, runA);
assert.notEqual(runtime.getDebuggerConnectionId(7), firstConnection, "reconnection has a new identity");
assert.equal(calls.filter(call => call[0] === "attach" && call[1] === 7).length, 2, "external detach is repaired on the next use");
assert.equal(
  authorized.filter(item => item.tabId === 7 && item.sessionId === runA.sessionId && item.runId === runA.runId).length,
  2,
  "reconnecting after an external detach revalidates ownership",
);

harness.setCommandHandler(async (_target, method) => {
  if (method === "Runtime.evaluate") {
    return { result: { type: "object", subtype: "promise", objectId: "promise-1" } };
  }
  if (method === "Runtime.awaitPromise") return { result: { type: "number", value: 42 } };
  return {};
});
const evaluated = await runtime.evaluateCdpScript(11, {
  expression: "Promise.resolve(42)",
  awaitPromise: true,
  returnByValue: true,
}, undefined, runA);
assert.equal(evaluated.result.value, 42);
assert.ok(calls.some(call => call[2] === "Runtime.awaitPromise"));

harness.setCommandHandler(async (_target, method) => {
  if (method === "Runtime.evaluate") return await new Promise(() => {});
  return {};
});
const controller = new AbortController();
const aborted = runtime.evaluateCdpScript(12, { expression: "while (true) {}" }, controller.signal, runA);
await new Promise(resolve => setTimeout(resolve, 0));
controller.abort();
await assert.rejects(aborted, error => error?.code === "OPERATION_ABORTED");
assert.ok(calls.some(call => call[1] === 12 && call[2] === "Runtime.terminateExecution"), "abort must terminate page execution");

harness.setCommandHandler(async () => { throw new Error("boom"); });
await assert.rejects(
  runtime.sendCdp(13, "Page.crash", {}, runA),
  error => error?.code === "CDP_COMMAND_FAILED" && error?.details?.method === "Page.crash",
);

harness.setCommandHandler(async (_target, method) => ({ method }));
const temporary = await runtime.withTemporaryDebugger(20, async (_target, send) => send("Page.enable"), "pdf");
assert.equal(temporary.method, "Page.enable");
assert.deepEqual(
  calls.filter(call => call[1] === 20).map(call => call[0]),
  ["attach", "command", "detach"],
  "temporary/system tabs own a complete local attach boundary",
);

harness.retireRun(runA);
await assert.rejects(
  runtime.sendCdp(7, "Page.enable", {}, runA),
  error => error?.code === "CDP_RUN_RELEASED",
  "a stale run cannot reuse its still-attached connection",
);
const released = await runtime.releaseRun("session-a", "run-a");
assert.deepEqual(new Set(released.tabIds), new Set([7, 8, 11, 12, 13]));
assert.equal(await runtime.releaseRun("session-a", "run-a").then(result => result.released), 0, "terminal release is idempotent");
await assert.rejects(
  runtime.sendCdp(7, "Page.enable", {}, runA),
  error => error?.code === "CDP_RUN_RELEASED",
  "late work from a terminal run must not reattach the tab",
);
await runtime.sendCdp(7, "Page.enable", {}, runB);
assert.equal(calls.filter(call => call[0] === "attach" && call[1] === 7).length, 3, "a new run can acquire the released tab without inheriting old state");
harness.retireRun(runB);
await runtime.releaseRun(runB.sessionId, runB.runId);

let finishAuthorization;
const authorizationGate = new Promise(resolve => { finishAuthorization = resolve; });
const raceCalls = [];
let authorizationRunCurrent = true;
const raceRuntime = createCdpRuntime({
  ToolExecutionError,
  isRunCurrent: () => authorizationRunCurrent,
  debuggerApi: {
    onDetach: { addListener() {} },
    async attach(target) { raceCalls.push(["attach", target.tabId]); },
    async detach(target) { raceCalls.push(["detach", target.tabId]); },
    async sendCommand(target, method) { raceCalls.push(["command", target.tabId, method]); return {}; },
  },
  async authorizeRunTab() { await authorizationGate; },
});
const racingAcquire = raceRuntime.sendCdp(30, "Page.enable", {}, { sessionId: "race", runId: "run" });
await Promise.resolve();
authorizationRunCurrent = false;
await raceRuntime.releaseRun("race", "run");
finishAuthorization();
await assert.rejects(racingAcquire, error => error?.code === "CDP_RUN_RELEASED");
assert.deepEqual(raceCalls, [], "a terminal run cannot attach after an asynchronous ownership check returns");

let finishAttach;
const attachGate = new Promise(resolve => { finishAttach = resolve; });
const attachRaceCalls = [];
let attachRunCurrent = true;
const attachRaceRuntime = createCdpRuntime({
  ToolExecutionError,
  isRunCurrent: () => attachRunCurrent,
  debuggerApi: {
    onDetach: { addListener() {} },
    async attach(target) { attachRaceCalls.push(["attach:start", target.tabId]); await attachGate; attachRaceCalls.push(["attach:done", target.tabId]); },
    async detach(target) { attachRaceCalls.push(["detach", target.tabId]); },
    async sendCommand(target, method) { attachRaceCalls.push(["command", target.tabId, method]); return {}; },
  },
  async authorizeRunTab() {},
});
const acquiringDuringRelease = attachRaceRuntime.sendCdp(31, "Page.enable", {}, { sessionId: "race", runId: "attach" });
await new Promise(resolve => setTimeout(resolve, 0));
attachRunCurrent = false;
const releaseDuringAttach = attachRaceRuntime.releaseRun("race", "attach");
finishAttach();
await assert.rejects(acquiringDuringRelease, error => error?.code === "CDP_RUN_RELEASED");
await releaseDuringAttach;
assert.deepEqual(attachRaceCalls, [
  ["attach:start", 31],
  ["attach:done", 31],
  ["detach", 31],
], "release waits for an in-progress attach, detaches it, and blocks the late command");

let finishCommand;
const commandGate = new Promise(resolve => { finishCommand = resolve; });
const commandRaceCalls = [];
let commandRunCurrent = true;
const commandRaceRuntime = createCdpRuntime({
  ToolExecutionError,
  isRunCurrent: () => commandRunCurrent,
  debuggerApi: {
    onDetach: { addListener() {} },
    async attach(target) { commandRaceCalls.push(["attach", target.tabId]); },
    async detach(target) { commandRaceCalls.push(["detach", target.tabId]); },
    async sendCommand(target, method) {
      commandRaceCalls.push(["command:start", target.tabId, method]);
      await commandGate;
      commandRaceCalls.push(["command:done", target.tabId, method]);
      return {};
    },
  },
  async authorizeRunTab() {},
});
const commandDuringRelease = commandRaceRuntime.sendCdp(32, "Input.dispatchMouseEvent", {}, {
  sessionId: "race",
  runId: "command",
});
await new Promise(resolve => setTimeout(resolve, 0));
commandRunCurrent = false;
await commandRaceRuntime.releaseRun("race", "command");
finishCommand();
await assert.rejects(commandDuringRelease, error => error?.code === "CDP_RUN_RELEASED");
assert.deepEqual(commandRaceCalls, [
  ["attach", 32],
  ["command:start", 32, "Input.dispatchMouseEvent"],
  ["detach", 32],
  ["command:done", 32, "Input.dispatchMouseEvent"],
], "a command finishing after the run terminal boundary cannot return as successful work");

{
  const f = createHarness();
  const first = { sessionId: "mobile", runId: "first" };
  const next = { sessionId: "mobile", runId: "next" };
  f.activateRun(first); f.activateRun(next); f.activateRun(runB);
  const oldSend = await f.runtime.withDebugger(41, (_target, send) => send, first);
  f.runtime.setDebuggerRetention(41, true, first);
  const connection = f.runtime.getDebuggerConnectionId(41);
  let finishOld;
  f.setCommandHandler(async (_target, method) => method === "Runtime.evaluate"
    ? new Promise(resolve => { finishOld = resolve; }) : {});
  const lateResult = oldSend("Runtime.evaluate");
  assert.deepEqual(await f.runtime.releaseRun(first.sessionId, first.runId), { released: 0, tabIds: [] });
  assert.equal(f.runtime.getDebuggerConnectionId(41), connection, "run completion preserves physical emulation");
  assert(f.calls.some(call => call[2] === "Input.dispatchTouchEvent" && call[3].type === "touchCancel"),
    "retaining a stopped run's connection must release any held finger");
  assert.deepEqual(f.calls.filter(call => call[0] === "command" && call[2].endsWith(".disable")).map(call => call[2]),
    ["Network.disable", "Page.disable"], "idle emulation stops network and page events and leaves Runtime enabled");
  finishOld({ stale: true });
  await assert.rejects(lateResult, { code: "CDP_RUN_RELEASED" });
  await assert.rejects(oldSend("Input.dispatchMouseEvent"), { code: "CDP_RUN_RELEASED" });
  await assert.rejects(f.runtime.sendCdp(41, "Page.enable", {}, first), { code: "CDP_RUN_RELEASED" }, "release is final even before Supervisor liveness catches up");
  f.retireRun(first);
  await assert.rejects(f.runtime.sendCdp(41, "Page.enable", {}, runB), { code: "CDP_TAB_LEASE_CONFLICT" });
  const freshSend = await f.runtime.withDebugger(41, (_target, send) => send, next);
  assert.equal(f.authorized.filter(access => access.runId === "next").length, 1, "the next borrower is authorized afresh");
  assert.equal(f.calls.filter(call => call[0] === "attach").length, 1, "a new run reuses the physical connection");
  await f.runtime.releaseDebugger(41, first);
  await freshSend("Page.enable");
  await assert.rejects(oldSend("Page.enable"), { code: "CDP_RUN_RELEASED" });
  f.detachListeners.forEach(listener => listener({ tabId: 41 }, "canceled_by_user"));
  await f.runtime.sendCdp(41, "Page.enable", {}, next);
  assert.notEqual(f.runtime.getDebuggerConnectionId(41), connection);
  await assert.rejects(freshSend("Page.enable"), { code: "CDP_RUN_RELEASED" }, "old connection callbacks cannot use a replacement connection");
  await f.runtime.releaseRun(next.sessionId, next.runId);
  await f.runtime.releaseSession("unrelated");
  assert.notEqual(f.runtime.getDebuggerConnectionId(41), null);
  await f.runtime.releaseSession("mobile");
  assert.equal(f.runtime.getDebuggerConnectionId(41), null, "deleting an idle session releases its retained connection");
}

{
  const f = createHarness();
  const next = { ...runA, runId: "next" };
  f.activateRun(runA); f.activateRun(next);
  await f.runtime.sendCdp(42, "Page.enable", {}, runA);
  f.runtime.setDebuggerRetention(42, true, runA);
  let finishReset;
  f.setCommandHandler(async (_target, method) => method === "Network.disable"
    ? new Promise(resolve => { finishReset = resolve; }) : {});
  const reset = f.runtime.releaseRun(runA.sessionId, runA.runId);
  const nextCommand = f.runtime.sendCdp(42, "Network.enable", {}, next);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.some(call => call[2] === "Network.enable"), false, "a new run waits for old domain cleanup");
  finishReset({}); await reset; await nextCommand;
  f.runtime.setDebuggerRetention(42, false, next);
  await f.runtime.releaseRun(next.sessionId, next.runId);
  assert.equal(f.runtime.getDebuggerConnectionId(42), null, "a stopped mode transition must detach rather than retain partial settings");
  await f.runtime.releaseSession(runA.sessionId);
  await assert.rejects(f.runtime.sendCdp(42, "Page.enable", {}, { ...next, runId: "revoked" }), { code: "CDP_RUN_RELEASED" });
}

{
  const f = createHarness();
  f.activateRun(runA);
  await f.runtime.sendCdp(51, "Page.enable", {}, runA);
  const firstConnection = f.runtime.getDebuggerConnectionId(51);
  let restores = 0;
  f.runtime.setDebuggerRetention(51, true, runA, async send => {
    await send("Emulation.setDeviceMetricsOverride", { width: 412 });
    restores++;
  });
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
  f.retireRun(runA);
  f.detachListeners.forEach(listener => listener({ tabId: 51 }, "target_closed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(restores, 1, "navigation restores retained configuration even while the task is idle");
  assert.notEqual(f.runtime.getDebuggerConnectionId(51), firstConnection);
  assert.equal(f.authorized.length, 2, "recovery freshly checks tab ownership");
  assert.equal(f.calls.some(call => call[2] === "Page.reload"), false, "restoration never repeats a form submission");
  await assert.rejects(f.runtime.sendCdp(51, "Page.enable", {}, runA), { code: "CDP_RUN_RELEASED" });
  f.detachListeners.forEach(listener => listener({ tabId: 51 }, "canceled_by_user"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(restores, 1, "user detach must not trigger automatic reconnection");
  await f.runtime.releaseSession(runA.sessionId);
}

for (const scenario of ["closed-or-foreign", "delete-during-authorization", "cancel-during-authorization", "detach-during-restore"]) {
  const f = createHarness();
  f.activateRun(runA);
  await f.runtime.sendCdp(52, "Page.enable", {}, runA);
  let finishAuthorization;
  let restores = 0;
  f.runtime.setDebuggerRetention(52, true, runA, async send => {
    restores++;
    f.detachListeners.forEach(listener => listener({ tabId: 52 }, "target_closed"));
    await send("Emulation.setDeviceMetricsOverride", { width: 412 });
  });
  f.setAuthorizeHandler(async () => {
    if (scenario === "closed-or-foreign") throw new Error("Tab is no longer owned or available");
    if (scenario.endsWith("during-authorization")) await new Promise(resolve => { finishAuthorization = resolve; });
  });
  f.detachListeners.forEach(listener => listener({ tabId: 52 }, "target_closed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  if (finishAuthorization) {
    if (scenario === "delete-during-authorization") await f.runtime.releaseSession(runA.sessionId);
    else f.detachListeners.forEach(listener => listener({ tabId: 52 }, "canceled_by_user"));
    finishAuthorization();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(f.runtime.getDebuggerConnectionId(52), null, scenario);
  assert.equal(restores, scenario === "detach-during-restore" ? 1 : 0, scenario);
  assert.equal(f.calls.filter(call => call[0] === "attach").length, scenario === "detach-during-restore" ? 2 : 1,
    "failed recovery is bounded and cannot revive a deleted session");
}

{
  const f = createHarness();
  const next = { ...runA, runId: "after-navigation" };
  f.activateRun(runA); f.activateRun(next);
  const oldSend = await f.runtime.withDebugger(53, (_target, send) => send, runA);
  let finishRestore;
  f.setCommandHandler(async (_target, method) => method === "Emulation.setDeviceMetricsOverride"
    ? new Promise(resolve => { finishRestore = resolve; }) : {});
  f.runtime.setDebuggerRetention(53, true, runA, async send => { await send("Emulation.setDeviceMetricsOverride", { width: 412 }); });
  f.detachListeners.forEach(listener => listener({ tabId: 53 }, "target_closed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const cleanup = f.runtime.releaseRun(runA.sessionId, runA.runId);
  f.retireRun(runA);
  const screenshot = f.runtime.sendCdp(53, "Page.captureScreenshot", {}, next);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.some(call => call[2] === "Page.captureScreenshot"), false, "new tools wait for complete emulation recovery");
  finishRestore({});
  await cleanup; await screenshot;
  await assert.rejects(oldSend("Page.enable"), { code: "CDP_RUN_RELEASED" });
  assert.notEqual(f.runtime.getDebuggerConnectionId(53), null, "run completion during recovery keeps emulation");
  await f.runtime.releaseSession(runA.sessionId);
}

{
  const f = createHarness();
  f.activateRun(runA);
  await f.runtime.withDebugger(7, async (_target, send) => {
    await send("Page.getFrameTree");
    await send.inSession("child-session")("Accessibility.getFullAXTree", { depth: 1 });
  }, runA);
  const frames = f.calls.filter(call => call[2] === "Page.getFrameTree");
  const trees = f.calls.filter(call => call[2] === "Accessibility.getFullAXTree");
  assert.equal(frames.at(-1)[4], "");
  assert.equal(trees.at(-1)[4], "child-session");
  assert.equal(trees.at(-1)[1], 7);
}

const gate = (f, run, signal = null) => f.runtime.confirmRunReattach({
  sessionId: run.sessionId,
  runId: run.runId,
  context: run,
  signal,
});

{
  // Dismissing the debugging bar pauses the run: the pre-tool gate asks, then the tool re-attaches on approval.
  const f = createHarness({ confirmUserReattach: async () => true });
  f.activateRun(runA);
  const controller = new AbortController();
  await gate(f, runA);
  assert.equal(f.reattachPrompts.length, 0, "a run without a detached tab is never asked");
  await f.runtime.sendCdp(60, "Page.enable", {}, runA);
  f.detachListeners.forEach(listener => listener({ tabId: 60 }, "canceled_by_user"));
  await gate(f, runA, controller.signal);
  assert.equal(f.reattachPrompts.length, 1, "user detach asks once before the next tool call");
  assert.deepEqual(
    [f.reattachPrompts[0].tabId, f.reattachPrompts[0].sessionId, f.reattachPrompts[0].runId],
    [60, runA.sessionId, runA.runId],
  );
  assert.equal(f.reattachPrompts[0].signal, controller.signal, "the tool signal reaches the confirmation");
  await f.runtime.sendCdp(60, "Runtime.enable", {}, runA);
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 60).length, 2, "approval re-attaches through the normal path");
  assert.ok(f.calls.some(call => call[1] === 60 && call[2] === "Runtime.enable"), "the tool call continues after approval");
  await gate(f, runA);
  await f.runtime.sendCdp(60, "Network.enable", {}, runA);
  assert.equal(f.reattachPrompts.length, 1, "an approved run is not asked about again");
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
}

{
  // Every other detach reason keeps the silent reconnection.
  const f = createHarness({ confirmUserReattach: async () => true });
  f.activateRun(runA);
  await f.runtime.sendCdp(61, "Page.enable", {}, runA);
  for (const reason of ["target_closed", "replaced_with_devtools"]) {
    f.detachListeners.forEach(listener => listener({ tabId: 61 }, reason));
    await gate(f, runA);
    await f.runtime.sendCdp(61, "Page.enable", {}, runA);
  }
  assert.equal(f.reattachPrompts.length, 0, "non-user detach reasons never ask");
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 61).length, 3, "both re-attach silently");
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
}

{
  // Rejection stops the run without re-attaching, and run release clears the flag for the next run.
  const f = createHarness({ confirmUserReattach: async () => false });
  f.activateRun(runA);
  f.activateRun(runB);
  await f.runtime.sendCdp(62, "Page.enable", {}, runA);
  f.detachListeners.forEach(listener => listener({ tabId: 62 }, "canceled_by_user"));
  await assert.rejects(gate(f, runA), { code: "CDP_RUN_RELEASED" });
  assert.equal(f.reattachPrompts.length, 1);
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 62).length, 1, "rejection never re-attaches");
  await assert.rejects(gate(f, runA), { code: "CDP_RUN_RELEASED" });
  assert.equal(f.reattachPrompts.length, 2, "a settled prompt is never reused or left dangling");
  f.retireRun(runA);
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
  await gate(f, runB);
  await f.runtime.sendCdp(62, "Page.enable", {}, runB);
  assert.equal(f.reattachPrompts.length, 2, "run release clears the flag; the next run attaches directly");
  await f.runtime.releaseRun(runB.sessionId, runB.runId);
}

{
  // Parallel prechecks within one run share a single prompt.
  let finishReattach;
  const f = createHarness({
    confirmUserReattach: () => new Promise(resolve => { finishReattach = resolve; }),
  });
  f.activateRun(runA);
  await f.runtime.sendCdp(63, "Page.enable", {}, runA);
  f.detachListeners.forEach(listener => listener({ tabId: 63 }, "canceled_by_user"));
  const first = gate(f, runA);
  const second = gate(f, runA);
  const third = gate(f, runA);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.reattachPrompts.length, 1, "parallel prechecks share one prompt");
  finishReattach(true);
  await Promise.all([first, second, third]);
  await f.runtime.sendCdp(63, "Runtime.enable", {}, runA);
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 63).length, 2, "approval lets the next tool re-attach");
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
}

{
  // A run that ends while the prompt is open cannot re-attach after a late approval.
  let finishReattach;
  const f = createHarness({
    confirmUserReattach: () => new Promise(resolve => { finishReattach = resolve; }),
  });
  f.activateRun(runA);
  await f.runtime.sendCdp(64, "Page.enable", {}, runA);
  f.detachListeners.forEach(listener => listener({ tabId: 64 }, "canceled_by_user"));
  const pending = gate(f, runA);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.reattachPrompts.length, 1);
  f.retireRun(runA);
  const released = f.runtime.releaseRun(runA.sessionId, runA.runId);
  finishReattach(true);
  await pending;
  await released;
  await assert.rejects(f.runtime.sendCdp(64, "Runtime.enable", {}, runA), { code: "CDP_RUN_RELEASED" });
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 64).length, 1, "approval after run end never re-attaches");
  f.activateRun(runB);
  await gate(f, runB);
  await f.runtime.sendCdp(64, "Page.enable", {}, runB);
  assert.equal(f.reattachPrompts.length, 1, "the next run attaches without a stale prompt");
  await f.runtime.releaseRun(runB.sessionId, runB.runId);
}

{
  // Hosts without a confirmation channel keep the silent re-attach.
  const f = createHarness();
  f.activateRun(runA);
  await f.runtime.sendCdp(65, "Page.enable", {}, runA);
  f.detachListeners.forEach(listener => listener({ tabId: 65 }, "canceled_by_user"));
  await gate(f, runA);
  await f.runtime.sendCdp(65, "Runtime.enable", {}, runA);
  assert.equal(f.calls.filter(call => call[0] === "attach" && call[1] === 65).length, 2, "a prompt-less host re-attaches silently");
  await f.runtime.releaseRun(runA.sessionId, runA.runId);
}

console.log("CDP run/tab lifecycle tests passed");

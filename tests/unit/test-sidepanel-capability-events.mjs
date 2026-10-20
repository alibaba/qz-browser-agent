import assert from "node:assert/strict";
import test from "node:test";
import { createSessionState } from "../../src/sidepanel/features/sessions/session-state.js";
import { createSidepanelEventRouter } from "../../src/sidepanel/features/app/sidepanel-event-router.js";
import { createSidepanelUiRuntime } from "../../src/sidepanel/capability-host/runtime.js";
import { createTranscriptReconcileFeature } from "../../src/sidepanel/features/chat/transcript/recovery.js";

function fixture({ current = "visible", listen, reconcile = false } = {}) {
  const state = createSessionState({ now: () => "2026-09-18 12:00:00" });
  const calls = [], observed = [], errors = [];
  const ui = createSidepanelUiRuntime({ host: { root: {}, settings: {}, extensions: {} },
    onError: (error, context) => errors.push({ error, ...context }) });
  let router;
  ui.mount({ id: "observer", mount(host) {
    host.onEvent(event => {
      observed.push({ event, runtime: state.getRuntime(event.sessionId), transcript: state.getTranscript(event.sessionId) });
      listen?.(event, { state, router, calls });
    });
    return {};
  } });
  const call = name => (...args) => { calls.push({ name, args }); };
  const transcriptReconcile = reconcile ? createTranscriptReconcileFeature({
    getCurrentSessionId: () => current,
    getCurrentTranscriptCount: () => state.getTranscript(current).length,
    isDeletedSession: id => router.isDeletedSession(id),
    requestSnapshot: call("snapshot"),
  }) : { handleEvent: call("reconcile"), clear: call("clearReconcile") };
  router = createSidepanelEventRouter({
    sessionState: state, switchToSession: call("switch"),
    getCurrentSessionId: () => current, isCurrentSession: id => id === current,
    getCurrentTab: () => "chat", runStates: { RUNNING: "running", WAITING_USER: "waiting_user" },
    runController: {
      shouldIgnoreBlocked: () => false, renderStatusVisibility: call("visibility"),
      makeLive: call("live"), showStatus: call("status"), start: call("start"), finish: call("finish"),
      accept: () => true, acceptTerminal: () => true, isRestoring: () => false,
      areEventsSuppressed: () => false, isBlocked: () => false,
      forgetSession: call("forgetRun"), setSuppressEvents: call("suppress"), requestCurrentState: call("getState"),
      hasVisibleConversation: () => true, hideWelcome: call("hideWelcome"),
      handleRuntimeContextUsage: call("contextUsage"), applySnapshot: call("applySnapshot"),
    },
    transcriptRenderer: {
      markChanged: call("markChanged"), scheduleRender: call("render"),
      getTranscript: id => state.getTranscript(id), setTranscript: (id, transcript) => state.replaceTranscript(id, transcript),
      seedCreated: session => state.mergeRecord(session), hideAssistantActions: call("hideActions"),
      forgetSession: call("forgetTranscript"),
    },
    transcriptReconcile,
    queuedFollowups: { itemsSignature: (a, b) => JSON.stringify([a, b]), render: call("queue"), settleAccepted: () => null },
    goalStrip: { renderCurrent: call("goal"), forget: call("forgetGoal") },
    forgetComposerSession: call("forgetComposer"), syncKeepAlive: call("keepAlive"),
    onEvent: event => ui.emit(event),
    onUiEvent: event => { calls.push({ name: "uiEvent", event, deleted: router.isDeletedSession(event.sessionId || current) }); },
    transitionToSession: async () => false,
  });
  return { state, router, ui, calls, observed, errors, transcriptReconcile };
}
const event = (type, sessionId = "visible", fields = {}) => ({ type, sessionId, runId: "new", ...fields });
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const statusFields of [{ status: "interrupted" }, { runtime: { status: "interrupted" } }]) {
  test(`equivalent interrupted state recovers nonempty history with throttled read-only snapshots (${Object.keys(statusFields)[0]})`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const f = fixture({ reconcile: true });
    t.after(() => f.transcriptReconcile.reset());
    const oldTranscript = [{ type: "user", text: "saved question" }, { type: "assistant", content: "saved partial answer" }];
    f.state.replaceTranscript("visible", oldTranscript);
    const interrupted = event("state", "visible", { hasHistory: true, isStreaming: false, ...statusFields });
    f.state.applyEvent(interrupted);
    const before = f.state.get("visible");
    const snapshots = () => f.calls.filter(call => call.name === "snapshot");
    f.router.handle(interrupted);
    f.router.handle(interrupted);
    assert.deepEqual(f.state.get("visible"), before, "reconnection may repeat an already projected state");
    t.mock.timers.tick(399);
    assert.equal(snapshots().length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(snapshots(), [{ name: "snapshot", args: ["visible", { persist: false }] }]);
    assert.deepEqual(f.state.getTranscript("visible"), oldTranscript, "reconciliation only requests a snapshot");
    f.router.handle(interrupted);
    t.mock.timers.tick(2499);
    f.router.handle(interrupted);
    t.mock.timers.tick(1);
    assert.equal(snapshots().length, 1, "equivalent events obey the existing request interval");
    f.router.handle(interrupted);
    t.mock.timers.tick(400);
    assert.equal(snapshots().length, 2, "a later reconnection can recover again");

    const completed = event("state", "visible", { hasHistory: true, status: "completed", isStreaming: false });
    f.router.handle(completed);
    t.mock.timers.tick(10_000);
    f.router.handle(completed);
    t.mock.timers.tick(400);
    assert.equal(snapshots().length, 2, "normal completed history does not cause repeated snapshot reads");
    await f.ui.dispose();
  });
}

test("reconnection recovery retains stale-event, inactive-session and deletion barriers", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const f = fixture({ reconcile: true });
  t.after(() => f.transcriptReconcile.reset());
  f.state.replaceTranscript("visible", [{ type: "assistant", content: "saved partial answer" }]);
  f.state.applyEvent(event("agent_start", "visible", { eventSeq: 2 }));
  const interrupted = event("state", "visible", { hasHistory: true, status: "interrupted", isStreaming: false, eventSeq: 3 });
  f.router.handle({ ...interrupted, runId: "old", eventSeq: 99 });
  f.router.handle({ ...interrupted, eventSeq: 1 });
  f.router.handle({ ...interrupted, sessionId: "background" });
  t.mock.timers.tick(400);
  assert.equal(f.calls.some(call => call.name === "snapshot"), false);
  assert.equal(f.state.getRuntime("visible").running, true);

  f.router.handle(interrupted);
  f.router.handle(event("session_deleted"));
  t.mock.timers.tick(400);
  f.router.handle({ ...interrupted, eventSeq: 99 });
  t.mock.timers.tick(400);
  assert.equal(f.calls.some(call => call.name === "snapshot"), false, "deletion cancels scheduled reads and blocks late events");
  assert.equal(f.state.has("visible"), false);
  await f.ui.dispose();
});

test("capabilities receive accepted projections from background sessions before active-chat filtering", async () => {
  const f = fixture();
  f.router.handle(event("agent_start", "background", { eventSeq: 1 }));
  f.router.handle(event("message_start", "background", { eventSeq: 2, message: { role: "assistant", content: "accepted" } }));
  assert.equal(f.observed.length, 2);
  assert.equal(f.observed[0].runtime.runId, "new", "listeners read the already committed SessionState projection");
  assert.equal(f.observed[1].transcript.at(-1).content, "accepted");
  assert.equal(f.calls.some(call => ["start", "live", "status"].includes(call.name)), false,
    "a background-session fact must not take over current Chat status");
  assert.ok(f.calls.some(call => call.name === "render" && call.args[0] === "background"));
  await f.ui.dispose();
});

test("stale runs and out-of-order sequences cannot reach capability or chat callbacks", async () => {
  const f = fixture();
  f.router.handle(event("agent_start", "visible", { eventSeq: 1 }));
  f.router.handle(event("tool_execution_start", "visible", { eventSeq: 3, toolCallId: "current", toolName: "test_tool", args: {} }));
  const before = f.state.get("visible");
  f.observed.length = 0;
  f.calls.length = 0;
  f.router.handle(event("tool_execution_end", "visible", { runId: "old", eventSeq: 100, toolCallId: "old", result: "stale" }));
  f.router.handle(event("tool_execution_update", "visible", { eventSeq: 2, toolCallId: "current", statusText: "stale sequence" }));
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state.get("visible"), before);
  await f.ui.dispose();
});

test("deletion installs its barrier before callbacks and ignores every late mutation until explicit revival", async () => {
  let deletionSnapshot;
  const f = fixture({ listen: (message, { state, router, calls }) => {
    if (message.type !== "session_deleted") return;
    deletionSnapshot = { deleted: router.isDeletedSession("visible"), present: state.has("visible"), calls: calls.map(call => call.name) };
  } });
  f.router.handle(event("agent_start", "visible", { eventSeq: 1 }));
  f.calls.length = 0;
  f.router.handle(event("session_deleted"));
  assert.equal(deletionSnapshot.deleted, true);
  assert.equal(deletionSnapshot.present, false);
  assert.ok(deletionSnapshot.calls.includes("forgetRun"));
  assert.equal(f.calls.filter(call => call.name === "uiEvent").length, 1, "deletion must publish one refresh after cleanup, not an intermediate projected state");
  assert.equal(f.calls.find(call => call.name === "uiEvent").deleted, true);
  f.observed.length = 0;
  f.calls.length = 0;
  for (const type of ["agent_start", "state", "tool_execution_update", "session_resources_changed", "messages"]) {
    f.router.handle(event(type, "visible", { eventSeq: 99, message: "late", runtime: { running: true }, transcript: [] }));
  }
  assert.equal(f.router.updateRuntime("visible", event("state", "visible", { runtime: { running: true } })), false);
  assert.deepEqual(f.observed, []);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.has("visible"), false);
  f.router.handle({ type: "session_created", sessionId: "visible", session: { id: "visible", title: "Recreated" } });
  f.router.handle(event("agent_start", "visible", { runId: "replacement", eventSeq: 1 }));
  assert.equal(f.router.isDeletedSession("visible"), false);
  assert.equal(f.state.getRuntime("visible").runId, "replacement");
  assert.deepEqual(f.observed.map(item => item.event.type), ["session_created", "agent_start"]);
  await f.ui.dispose();
});

test("throwing and rejected capability listeners stay isolated from siblings and current Chat", async () => {
  const f = fixture();
  f.ui.mount({ id: "throws", mount(host) {
    host.onEvent(() => { throw new Error("sync listener failure"); });
    return {};
  } });
  f.ui.mount({ id: "rejects", mount(host) {
    host.onEvent(async () => { throw new Error("async listener failure"); });
    return {};
  } });
  assert.doesNotThrow(() => f.router.handle(event("agent_start", "visible", { eventSeq: 1 })));
  assert.doesNotThrow(() => f.router.handle(event("thinking_update", "visible", { eventSeq: 2 })));
  await tick();
  assert.equal(f.observed.length, 2);
  assert.equal(f.calls.filter(call => call.name === "status").length, 2);
  assert.equal(f.errors.length, 4);
  assert.ok(f.errors.every(error => error.phase === "event"));
  await f.ui.dispose();
});

test("event observers share one immutable snapshot without changing router terminal behavior", async () => {
  const f = fixture();
  const first = [], second = [];
  await f.ui.mountAll([{ id: "mutates", setup(qz) {
    qz.on("agent_end", message => {
      first.push(message);
      assert.throws(() => { message.runtime.detail.labels[0] = "corrupted"; }, TypeError);
      message.type = "corrupted";
    });
  } }, { id: "sibling", setup(qz) {
    qz.on("agent_end", message => second.push(message));
  } }]);
  for (const runId of ["new", "recovery"]) {
    f.router.handle(event("agent_start", "visible", { runId, eventSeq: 1 }));
    const terminal = event("agent_end", "visible", { runId, eventSeq: 2,
      runtime: { status: "completed", detail: { labels: ["original"] } },
    });
    assert.doesNotThrow(() => f.router.handle(terminal));
    assert.equal(terminal.type, "agent_end");
    assert.deepEqual(terminal.runtime.detail.labels, ["original"]);
    assert.equal(Object.isFrozen(terminal), false, "the router retains its own event");
    assert.notEqual(second.at(-1), terminal);
    assert.equal(first.at(-1), second.at(-1), "a dispatch clones once for all observers");
    assert.equal(second.at(-1).type, "agent_end");
    assert.deepEqual(second.at(-1).runtime.detail.labels, ["original"]);
  }
  assert.equal(f.calls.filter(call => call.name === "finish").length, 2);
  assert.equal(f.state.getRuntime("visible").running, false);
  assert.equal(second.length, 2);
  assert.equal(f.errors.length, 2);
  assert.ok(f.errors.every(entry => entry.error instanceof TypeError && entry.phase === "event"));
  await f.ui.dispose();
});

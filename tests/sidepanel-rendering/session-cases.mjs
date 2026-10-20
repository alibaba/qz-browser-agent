import assert from "node:assert/strict";
import { createSessionState } from "../../src/sidepanel/features/sessions/session-state.js";
import { createSidepanelEventRouter } from "../../src/sidepanel/features/app/sidepanel-event-router.js";
import { createSessionNavigationFeature } from "../../src/sidepanel/features/sessions/session-navigation-feature.js";
import { createSessionRecord } from "../../src/shared/session/session-codec.js";
import { createSiblingOrders, rankBySessionId, resolveStableSiblingOrders } from "../../src/capabilities/sessions/session-order.js";

export function testSessionState() {
  const state = createSessionState({ now: () => "2026-07-11 12:00:00" });
  const record = state.mergeRecord({ id: "s1", title: "任务一", listSummary: {} });
  assert.equal(record.recordChanged, true);
  assert.equal(record.artifactsChanged, false);

  const start = state.applyEvent({ type: "agent_start", sessionId: "s1", runId: "r1", eventSeq: 1 });
  assert.equal(start.runtimeChanged, true);
  assert.equal(start.snapshot.runtime.status, "running");

  const user = state.applyEvent({
    type: "message_start",
    sessionId: "s1",
    runId: "r1",
    eventSeq: 2,
    message: { role: "user", content: "开始任务" },
  });
  assert.equal(user.transcriptChanged, true);
  assert.equal(state.getTranscript("s1").at(-1).type, "user");
  const artifactRevisionBefore = user.revision.artifacts;

  const assistant = state.applyEvent({
    type: "message_end",
    sessionId: "s1",
    runId: "r1",
    eventSeq: 3,
    spanId: "assistant-1",
    message: { role: "assistant", content: "完成" },
  });
  assert.equal(assistant.recordChanged, true);
  assert.equal(assistant.revision.artifacts, artifactRevisionBefore);

  const dirty = state.applyEvent({ type: "session_resources_changed", sessionId: "s1", runId: "r1" });
  assert.equal(dirty.artifactsChanged, true);
  assert.equal(dirty.snapshot.artifactsDirty, true);

  const hydrated = state.mergeArtifactSummary("s1", {
    dataTables: [{ title: "结果表", totalRows: 2 }],
    files: [],
  }, { updatedAt: "2026-07-11 12:00:10" });
  assert.equal(hydrated.snapshot.artifactsDirty, false);
  assert.equal(hydrated.snapshot.artifactSummary.artifactCount, 1);
  assert.equal(hydrated.snapshot.artifactSummary.dataCount, 1);

  state.applyEvent({ type: "agent_start", sessionId: "s2", runId: "r2", eventSeq: 1 });
  assert.equal(state.getRuntime("s2").status, "running");
  assert.equal(state.getRuntime("s1").runId, "r1");
}

export function testSessionCausality() {
  const invalid = [];
  const state = createSessionState({ onInvalidEvent: (...args) => invalid.push(args) });
  assert.equal(state.applyEvent(null).reason, "invalid_event");
  assert.equal(invalid.length, 1);

  state.applyEvent({ type: "agent_start", sessionId: "s1", runId: "new", eventSeq: 1 });
  state.applyEvent({ type: "message_update", sessionId: "s1", runId: "new", eventSeq: 2, spanId: "a", content: "new" });
  const duplicate = state.applyEvent({ type: "message_update", sessionId: "s1", runId: "new", eventSeq: 2, spanId: "a", content: "duplicate" });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, "stale_event_seq");

  const stale = state.applyEvent({ type: "message_update", sessionId: "s1", runId: "old", eventSeq: 9, spanId: "old", content: "old" });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale_run");
  assert.equal(state.getTranscript("s1").some(entry => entry.content === "old"), false);

  const nextRun = state.applyEvent({ type: "agent_start", sessionId: "s1", runId: "next", eventSeq: 1 });
  assert.equal(nextRun.accepted, true);
  assert.equal(nextRun.snapshot.runtime.runId, "next");
}

export function testPendingRunLifecycle() {
  for (const terminal of ["error", "aborted", "agent_end"]) {
    const state = createSessionState();
    const emit = (type, runId, eventSeq, fields = {}) => state.applyEvent({
      type, sessionId: "s1", runId, eventSeq, ...fields,
    });
    emit("agent_start", "r1", 1);
    emit("message_end", "r1", 2, { spanId: "answer", message: { role: "assistant", content: "First answer" } });
    emit("agent_end", "r1", 3);
    const transcript = state.getTranscript("s1");

    const pending = emit("session_pending", "r2", 1);
    assert.equal(pending.accepted, true, "initialization must establish the next run before agent_start");
    assert.equal(pending.snapshot.runtime.runId, "r2");
    assert.equal(pending.snapshot.runtime.status, "pending");
    assert.equal(pending.snapshot.runtime.running, true);
    assert.equal(pending.snapshot.runtime.pendingStart, true);
    assert.equal(pending.snapshot.runtime.endedAt, "");
    assert.deepEqual(state.getTranscript("s1"), transcript, "initialization preserves the previous answer");
    assert.equal(emit("session_pending", "r2", 1).reason, "stale_event_seq");
    assert.equal(emit("error", "r1", 4, { message: "stale error" }).reason, "stale_run");
    assert.equal(emit("agent_end", "r1", 5).reason, "stale_run");

    let eventSeq = 2;
    if (terminal === "agent_end") {
      const started = emit("agent_start", "r2", eventSeq++);
      assert.equal(started.snapshot.runtime.status, "running");
      assert.equal(started.snapshot.runtime.pendingStart, false);
    }
    assert.equal(emit(terminal, "r2", eventSeq++, { message: "Model configuration failed" }).accepted, true);
    if (terminal !== "agent_end") emit("agent_end", "r2", eventSeq++);
    const ended = state.getRuntime("s1");
    assert.equal(ended.status, terminal === "agent_end" ? "completed" : terminal);
    assert.equal(ended.running, false);
    assert.equal(ended.pendingStart, false);
    const errors = state.getTranscript("s1").filter(entry => entry.type === "error");
    assert.deepEqual(errors.map(entry => entry.text), terminal === "error" ? ["Model configuration failed"] : []);
    assert.equal(emit("session_pending", "r2", 1).reason, "stale_event_seq", "a replay cannot reopen a terminal run");

    assert.equal(emit("session_pending", "r3", 1).accepted, true);
    assert.equal(emit("agent_end", "r2", eventSeq).reason, "stale_run");
    emit("agent_start", "r3", 2);
    emit("agent_end", "r3", 3);
    assert.equal(state.getRuntime("s1").status, "completed", "initialization failure or cancellation permits a later run");
  }
}

export function testSessionReducerGates() {
  const state = createSessionState({ now: () => "2026-07-11 12:00:00" });
  state.mergeRecord({ id: "s1", title: "原始" });
  const before = state.get("s1").revision;
  const transcriptOnly = state.applyEvent({
    type: "message_update",
    sessionId: "s1",
    runId: "r1",
    eventSeq: 1,
    spanId: "assistant",
    content: "partial",
  }, { runtime: false, record: false, artifacts: false });
  assert.equal(transcriptOnly.transcriptChanged, true);
  assert.equal(transcriptOnly.revision.runtime, before.runtime);
  assert.equal(transcriptOnly.revision.record, before.record);
  assert.equal(transcriptOnly.revision.artifacts, before.artifacts);

  const runtimeOnly = state.applyEvent({
    type: "context_usage",
    sessionId: "s1",
    runId: "r1",
    eventSeq: 2,
    inputTokensEstimate: 500,
    contextWindow: 1000,
  }, { transcript: false, record: false, artifacts: false });
  assert.equal(runtimeOnly.runtimeChanged, true);
  assert.equal(runtimeOnly.revision.transcript, transcriptOnly.revision.transcript);

  const ignoredArtifact = state.applyEvent(
    { type: "session_resources_changed", sessionId: "s1", runId: "r1" },
    { runtime: false, transcript: false, record: false, artifacts: false },
  );
  assert.equal(ignoredArtifact.artifactsChanged, false);
  assert.equal(ignoredArtifact.revision.artifacts, before.artifacts);
}

export function testRuntimeProjection() {
  const state = createSessionState({ now: () => "2026-07-11 12:00:00" });
  const live = state.applyEvent({
    type: "state",
    sessionId: "s1",
    isStreaming: true,
    runtime: { status: "idle" },
  });
  assert.equal(live.snapshot.runtime.status, "running");
  assert.equal(live.snapshot.runtime.running, true);

  const usage = state.applyEvent({
    type: "context_usage",
    sessionId: "s1",
    inputTokensEstimate: 12345,
    contextWindow: 262144,
    usage: { input_tokens: 12345 },
  });
  assert.equal(usage.snapshot.runtime.contextUsageText, "ctx 12.3k/262.1k");
  assert.equal(usage.snapshot.runtime.inputTokensEstimate, 12345);

  const tool = state.applyEvent({ type: "tool_call_update", sessionId: "s1", toolName: "run_script" });
  assert.equal(tool.snapshot.runtime.currentToolName, "run_script");
  assert.equal(tool.snapshot.runtime.currentTool.phase, "preparing");
  assert.equal(tool.snapshot.runtime.currentTool.rendererId, undefined);
  const customTool = state.applyEvent({
    type: "tool_execution_start", sessionId: "s1", toolName: "example_table", rendererId: "table",
  });
  assert.equal(customTool.snapshot.runtime.currentTool.rendererId, "table");
  const toolUpdate = state.applyEvent({ type: "tool_execution_update", sessionId: "s1", toolName: "example_table" });
  assert.equal(toolUpdate.snapshot.runtime.currentTool.rendererId, "table");

  state.applyEvent({
    type: "queue_update",
    sessionId: "s1",
    pendingFollowUps: [
      { clientMessageId: "queued-1", text: "第一条" },
      { clientMessageId: "queued-2", text: "第二条" },
    ],
    pendingSteerings: [
      { clientMessageId: "steering-1", text: "先调整方向" },
    ],
  });
  const aborted = state.applyEvent({ type: "aborted", sessionId: "s1", runId: "r0" });
  assert.deepEqual(
    aborted.snapshot.runtime.pendingFollowUps.map(item => item.clientMessageId),
    ["queued-1", "queued-2"],
    "the Side Panel projection must retain queued messages when only the current run is aborted",
  );
  assert.deepEqual(
    aborted.snapshot.runtime.pendingSteerings.map(item => item.clientMessageId),
    ["steering-1"],
    "the Side Panel projection must retain steering when only the current run is aborted",
  );

  state.applyEvent({ type: "tracker_update", sessionId: "s1", tracker: { title: "分页", current: 2 } });
  state.applyEvent({ type: "goal_update", sessionId: "s1", goal: { objective: "完成采集" } });
  const nextRun = state.applyEvent({ type: "agent_start", sessionId: "s1", runId: "r1", eventSeq: 1 });
  assert.equal(nextRun.snapshot.runtime.tracker, null);
  assert.equal(nextRun.snapshot.runtime.contextUsageText, "ctx 12.3k/262.1k", "a new run should keep the last context reading until its fresh estimate arrives");
  assert.equal(nextRun.snapshot.runtime.goal.objective, "完成采集");
}

export function testEventRouterCausality() {
  const fixture = createEventRouterFixture();
  const { router, state, calls } = fixture;
  router.handle({ type: "agent_start", sessionId: "current", runId: "r1", eventSeq: 1 });
  assert.equal(state.getRuntime("current").status, "running");
  assert.equal(countCalls(calls, "run.start"), 1);

  const userEvent = {
    type: "message_start",
    sessionId: "current",
    runId: "r1",
    eventSeq: 2,
    clientMessageId: "client-1",
    message: { role: "user", content: "开始", clientMessageId: "client-1" },
  };
  router.handle(userEvent);
  assert.equal(countCalls(calls, "transcript.hideActions"), 1);
  assert.equal(countCalls(calls, "ui.ui_chat_submitted"), 1);
  assert.deepEqual(calls.find(call => call.name === "ui.ui_chat_submitted").value,
    { type: "ui_chat_submitted", sessionId: "current", clientMessageId: "client-1" });
  assert.equal(countCalls(calls, "transcript.armOutgoing"), 0, "direct accepted messages already own their optimistic entry animation");

  router.handle(userEvent);
  assert.equal(countCalls(calls, "transcript.hideActions"), 1, "stale events must not run UI side effects");
  assert.equal(countCalls(calls, "ui.ui_chat_submitted"), 1);

  const queuedUserEvent = {
    type: "message_start",
    sessionId: "current",
    runId: "r1",
    eventSeq: 3,
    clientMessageId: "queued-client",
    message: { role: "user", content: "排队消息", clientMessageId: "queued-client", _origin: "user" },
  };
  router.handle(queuedUserEvent);
  assert.equal(countCalls(calls, "transcript.armOutgoing"), 1, "a drained queued message should reuse the outgoing bubble animation");
  router.handle(queuedUserEvent);
  assert.equal(countCalls(calls, "transcript.armOutgoing"), 1, "a duplicate queued message event must not replay the animation");

  const makeLiveBeforeBackground = countCalls(calls, "run.makeLive");
  router.handle({
    type: "message_update",
    sessionId: "background",
    runId: "r2",
    eventSeq: 1,
    spanId: "assistant-bg",
    content: "后台生成",
  });
  assert.equal(state.getTranscript("background").some(entry => entry.content === "后台生成"), true);
  assert.equal(countCalls(calls, "run.makeLive"), makeLiveBeforeBackground, "background events must not enter current-run UI");

  router.handle({ type: "agent_end", sessionId: "background", runId: "r2", eventSeq: 2 });
  assert.equal(countCalls(calls, "snapshot.request"), 1);
  const acceptedTerminal = calls.filter(call => call.name === "accepted.agent_end");
  assert.equal(acceptedTerminal.length, 1);
  assert.equal(acceptedTerminal[0].value.sessionId, "background", "the capability receives the accepted background terminal fact");

  const startsBeforePending = countCalls(calls, "run.start");
  router.handle({ type: "session_pending", sessionId: "background", runId: "r3", eventSeq: 1 });
  assert.equal(state.getRuntime("background").status, "pending");
  assert.equal(countCalls(calls, "run.start"), startsBeforePending, "background initialization must not start the current chat");
  router.handle({ type: "error", sessionId: "background", runId: "r3", eventSeq: 2, message: "Initialization failed" });
  assert.equal(state.getRuntime("background").status, "error");
  assert.equal(state.getTranscript("background").at(-1).text, "Initialization failed");

  router.handle({ type: "agent_end", sessionId: "current", runId: "r1", eventSeq: 4 });
  router.handle({ type: "session_pending", sessionId: "current", runId: "r4", eventSeq: 1 });
  assert.equal(countCalls(calls, "run.start"), startsBeforePending + 1, "the current chat tracks initialization before agent_start");
}

export async function testSessionNavigationSingleReveal() {
  const originalChrome = globalThis.chrome;
  let currentSessionId = null;
  let currentTab = "chat";
  let switchEpoch = 0;
  let transcriptLoaded = false;
  const calls = [];
  const record = createSessionRecord([], [{ type: "assistant", content: "已加载" }]);
  const storage = {
    local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => key.startsWith("_session_")).map(key => [key, record]));
      },
    },
  };
  globalThis.chrome = { storage };
  const navigation = createSessionNavigationFeature({
    storage,
    chatTab: "chat",
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionIdValue: value => { currentSessionId = value; },
    getSessionSwitchEpoch: () => switchEpoch,
    incrementSessionSwitchEpoch: () => ++switchEpoch,
    getCurrentTab: () => currentTab,
    switchToChatTab: options => {
      currentTab = "chat";
      calls.push(options?.refresh === false ? "switch-no-refresh" : "switch");
    },
    request: async () => ({}),
    send: () => {},
    isDeletedSession: () => false,
    getRuntime: () => ({ status: "idle" }),
    isRuntimeRunning: () => false,
    resetUi: () => calls.push("reset"),
    startPerfTrace: () => () => {},
    perfTrace: (_name, _meta, callback) => callback(),
    perfTraceAsync: (_name, _meta, callback) => callback(),
    chatSearch: { close: () => {} },
    chatScroll: { requestLatest: () => calls.push("latest") },
    goalStrip: { renderCurrent: () => {} },
    sessionExport: { syncCurrentControl: () => {} },
    transcriptRenderer: {
      hasTranscript: () => transcriptLoaded,
      seedFromStorage: () => { transcriptLoaded = true; return true; },
      maybeRenderUpdated: () => calls.push("maybe-render"),
      renderCurrent: options => calls.push(options?.intent === "opening" ? "render-opening" : "render"),
    },
    runController: {
      setSuppressEvents: () => {},
      syncCurrentRuntimeView: () => {},
      finish: () => {},
      beginRestore: () => {},
    },
    sessions: { scheduleRefresh: () => {} },
    artifacts: { releaseCardSuppression: () => {} },
  });
  try {
    await navigation.switchToSession("session-1");
    assert.equal(calls.filter(call => call === "render-opening").length, 1);
    assert.equal(calls.filter(call => call === "switch-no-refresh").length, 1);
    assert.equal(calls.includes("maybe-render"), false, "uncached hydration must not render before reveal");
    assert.equal(calls.filter(call => call === "reset").length, 1);
  } finally {
    globalThis.chrome = originalChrome;
  }
}

export function testStableSessionOrdering() {
  const previous = new Map([["0", ["a", "b"]]]);
  const records = [
    { id: "a", parentSessionId: "0", updatedAt: "2026-07-11 10:00:00" },
    { id: "b", parentSessionId: "0", updatedAt: "2026-07-11 11:00:00" },
  ];
  const deferred = resolveStableSiblingOrders({
    records,
    previousOrders: previous,
    now: 1000,
    holdUntil: 2000,
    lastAppliedAt: 900,
    throttleMs: 500,
  });
  assert.deepEqual(deferred.orders.get("0"), ["a", "b"]);
  assert.equal(deferred.deferredUntil, 2000);

  const withNewMember = resolveStableSiblingOrders({
    records: [...records, { id: "c", parentSessionId: "0", updatedAt: "2026-07-11 12:00:00" }],
    previousOrders: previous,
    now: 1000,
    holdUntil: 2000,
    lastAppliedAt: 900,
    throttleMs: 500,
  });
  assert.deepEqual(withNewMember.orders.get("0"), ["a", "b", "c"], "new members must remain visible during hold");

  const applied = resolveStableSiblingOrders({
    records,
    previousOrders: previous,
    now: 2500,
    holdUntil: 2000,
    lastAppliedAt: 900,
    throttleMs: 500,
  });
  assert.deepEqual(applied.orders.get("0"), ["b", "a"]);
  assert.deepEqual([...rankBySessionId(applied.orders).entries()], [["b", 0], ["a", 1]]);

  const orphaned = createSiblingOrders([
    { id: "orphan", parentSessionId: "missing", updatedAt: "2026-07-11 10:00:00" },
  ]);
  assert.deepEqual(orphaned.get("0"), ["orphan"]);
}

function createEventRouterFixture() {
  const state = createSessionState({ now: () => "2026-07-11 12:00:00" });
  const calls = [];
  const call = (name, value = null) => calls.push({ name, value });
  const runController = {
    isTerminalEvent: event => ["agent_end", "aborted", "error"].includes(event.type),
    hasVisibleConversation: () => false,
    hideWelcome: () => call("run.hideWelcome"),
    handleRuntimeContextUsage: () => call("run.runtimeUsage"),
    applySnapshot: () => call("run.applySnapshot"),
    makeLive: () => call("run.makeLive"),
    showStatus: value => call("run.status", value),
    accept: () => true,
    ensureActive: () => call("run.ensureActive"),
    isRestoring: () => false,
    areEventsSuppressed: () => false,
    isBlocked: () => false,
    start: () => call("run.start"),
    acceptTerminal: () => true,
    finish: () => call("run.finish"),
    getStatus: () => "idle",
    enterState: value => call("run.enterState", value),
    requestCurrentState: () => call("run.requestState"),
    finishRestore: () => call("run.finishRestore"),
    shouldIgnoreBlocked: () => false,
    renderStatusVisibility: () => call("run.renderStatus"),
    forgetSession: () => call("run.forget"),
    setSuppressEvents: () => call("run.suppress"),
  };
  const transcriptRenderer = {
    scheduleRender: id => call("transcript.schedule", id),
    setTranscript: (id, transcript) => state.replaceTranscript(id, transcript),
    seedCreated: () => call("transcript.seed"),
    markChanged: id => call("transcript.changed", id),
    getTranscript: id => state.getTranscript(id),
    armOutgoingEntry: (sessionId, clientMessageId) => call("transcript.armOutgoing", { sessionId, clientMessageId }),
    hideAssistantActions: () => call("transcript.hideActions"),
    forgetSession: () => call("transcript.forget"),
  };
  const router = createSidepanelEventRouter({
    sessionState: state,
    runController,
    transcriptRenderer,
    transcriptReconcile: { handleEvent: () => call("reconcile.handle"), clear: () => call("reconcile.clear") },
    queuedFollowups: {
      itemsSignature: (followUps, steerings) => JSON.stringify([followUps || [], steerings || []]),
      settleAccepted: clientMessageId => {
        call("queue.settle", clientMessageId);
        return clientMessageId === "queued-client";
      },
      render: () => call("queue.render"),
    },
    goalStrip: { renderCurrent: () => call("goal.render"), forget: () => call("goal.forget") },
    // Domain reactions belong to capabilities; the router publishes only accepted facts and UI intents.
    onEvent: event => call(`accepted.${event.type}`, event),
    onUiEvent: event => call(`ui.${event.type}`, event),
    runStates: { WAITING_USER: "waiting_user", RUNNING: "running" },
    getCurrentSessionId: () => "current",
    getCurrentTab: () => "chat",
    isCurrentSession: id => id === "current",
    switchToSession: () => {},
    requestConversationSnapshot: () => call("snapshot.request"),
    syncKeepAlive: () => call("keepalive.sync"),
    saveCurrentSession: () => call("session.save"),
  });
  return { router, state, calls };
}

function countCalls(calls, name) {
  return calls.filter(call => call.name === name).length;
}

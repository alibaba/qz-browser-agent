import { createTestAgentOptions } from "../support/agent-services.mjs";
import { getSessionRepository } from "../../src/background/session/repository.js";
import assert from "node:assert/strict";
import {
  editUserTranscriptAndTruncate,
  extractUserMessageImages,
  findEditableUserMessageIndex,
  normalizeEditMessageId,
  normalizeUserImageInputs,
  replaceUserMessageAndTruncate,
} from "../../src/shared/session/conversation-edit.js";
import {
  serializeConversation,
  transcriptFromConversation,
} from "../../src/shared/session/session-codec.js";
import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";

installImageAssetsFixture();

assertNormalizeEditMessageId();
assertFindsLatestEditableUserMessage();
assertTargetsUserMessageByClientMessageId();
assertReplacementTruncatesAssistantAndToolTail();
assertMissingTargetFailsClosed();
assertImagePartsSurviveEditExtraction();
assertTranscriptEditTruncatesTail();
assertTranscriptEditCanUseLatestUserFallback();
assertTranscriptEditMissingTargetDoesNotMutate();
assertConversationCodecAfterEditHasNoStaleTail();
await assertAgentEditRerunUsesPendingUserMessage();
await assertAgentEditRerunFallsBackToNewMessage();
await assertAgentFollowUpQueueEvents();
await assertAgentSteeringReentersAtSafeBoundary();
await assertAgentSteeringStaysQueuedUntilPrepared();
await assertRemovedIdleSteeringDoesNotStartAnEmptyTurn();
await assertAgentIdleSteeringRunsBeforeFollowUps();
await assertAgentFollowUpsRunOneAtATime();
await assertAgentRestoredFollowUpsResume();
await assertAgentRestoredQueuesDedupeDeliveredMessages();
await assertAgentAbortPreservesFollowUps();
await assertRetiredAgentCannotDrainFollowUps();
await assertRetiredAgentCannotDrainSteering();

function assertNormalizeEditMessageId() {
  assert.equal(normalizeEditMessageId("  cm_1  "), "cm_1");
  assert.equal(normalizeEditMessageId(""), "");
  assert.equal(normalizeEditMessageId(null), "");
  assert.equal(normalizeEditMessageId("x".repeat(200)).length, 160);
}

function assertFindsLatestEditableUserMessage() {
  const messages = [
    system(),
    user("first", "cm_first"),
    assistant("answer 1"),
    user("second", "cm_second"),
    assistant("answer 2"),
  ];

  assert.equal(findEditableUserMessageIndex(messages), 3);
  assert.equal(findEditableUserMessageIndex(messages, "cm_first"), 1);
  assert.equal(findEditableUserMessageIndex(messages, "missing"), -1);
}

function assertTargetsUserMessageByClientMessageId() {
  const messages = [
    system(),
    user("first", "cm_first"),
    assistant("answer 1"),
    user("second", "cm_second"),
    assistant("answer 2"),
  ];
  const replacement = user("edited first", "cm_first");
  const result = replaceUserMessageAndTruncate(messages, replacement, { clientMessageId: "cm_first" });

  assert.equal(result.targetIndex, 1);
  assert.deepEqual(result.messages.map(labelMessage), ["system", "edited first"]);
  assert.equal(result.previous.content, "first");
}

function assertReplacementTruncatesAssistantAndToolTail() {
  const messages = [
    system(),
    user("plan", "cm_1"),
    assistant("old answer"),
    assistantWithTool("call_1"),
    tool("call_1", "old tool result"),
  ];
  const replacement = user("edited plan", "cm_1");
  const result = replaceUserMessageAndTruncate(messages, replacement, { clientMessageId: "cm_1" });

  assert.equal(result.targetIndex, 1);
  assert.deepEqual(result.messages.map(msg => msg.role), ["system", "user"]);
  assert.equal(result.messages.at(-1).content, "edited plan");
  assert.equal(result.messages.some(msg => msg.role === "assistant" || msg.role === "tool"), false);
}

function assertMissingTargetFailsClosed() {
  assert.throws(
    () => replaceUserMessageAndTruncate([system(), user("hello", "cm_1")], user("edited", "cm_missing"), { clientMessageId: "cm_missing" }),
    /没有找到要编辑的用户请求/,
  );
  assert.throws(
    () => replaceUserMessageAndTruncate([system(), user("hello", "cm_1")], assistant("not user")),
    /必须是用户消息/,
  );
}

function assertImagePartsSurviveEditExtraction() {
  const message = {
    role: "user",
    clientMessageId: "cm_image",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
      { type: "image_url", image_url: { url: "https://example.com/not-inline.png" } },
    ],
  };

  assert.deepEqual(extractUserMessageImages(message), [{
    dataUrl: "data:image/png;base64,AAAA",
    type: "image/png",
    name: "",
  }]);
  assert.deepEqual(normalizeUserImageInputs([
    { dataUrl: "data:image/jpeg;base64,BBBB", name: "photo" },
    { dataUrl: "https://example.com/not-inline.png" },
  ]), [{
    dataUrl: "data:image/jpeg;base64,BBBB",
    type: "image/jpeg",
    name: "photo",
  }]);
}

function assertTranscriptEditTruncatesTail() {
  const history = [
    transcriptUser("first", "cm_first"),
    { type: "assistant", content: "answer 1" },
    transcriptUser("second", "cm_second"),
    { type: "error", text: "stale error" },
  ];
  const result = editUserTranscriptAndTruncate(history, {
    clientMessageId: "cm_second",
    text: "edited second",
    images: [{ dataUrl: "data:image/png;base64,BBBB" }],
    now: () => "2026-06-22 18:00:00",
  });

  assert.equal(result.changed, true);
  assert.equal(result.targetIndex, 2);
  assert.deepEqual(result.transcript.map(entry => entry.type), ["user", "assistant", "user"]);
  assert.equal(result.entry.text, "edited second");
  assert.equal(result.entry.deliveryStatus, "pending");
  assert.equal(result.entry.editedAt, "2026-06-22 18:00:00");
  assert.deepEqual(result.entry.images, [{ dataUrl: "data:image/png;base64,BBBB" }]);
}

function assertTranscriptEditCanUseLatestUserFallback() {
  const history = [
    transcriptUser("first", "cm_first"),
    { type: "assistant", content: "answer 1" },
    transcriptUser("second", "cm_second"),
    { type: "assistant", content: "answer 2" },
  ];
  const result = editUserTranscriptAndTruncate(history, {
    text: "edited latest",
    now: "2026-06-22 18:01:00",
  });

  assert.equal(result.changed, true);
  assert.equal(result.targetIndex, 2);
  assert.deepEqual(result.transcript.map(entry => entry.type), ["user", "assistant", "user"]);
  assert.equal(result.transcript.at(-1).text, "edited latest");
  assert.equal(result.transcript.at(-1).clientMessageId, "cm_second");
}

function assertTranscriptEditMissingTargetDoesNotMutate() {
  const history = [transcriptUser("hello", "cm_1"), { type: "assistant", content: "answer" }];
  const result = editUserTranscriptAndTruncate(history, {
    clientMessageId: "missing",
    text: "edited",
  });

  assert.equal(result.changed, false);
  assert.notEqual(result.transcript, history);
  assert.deepEqual(result.transcript, history);
}

function assertConversationCodecAfterEditHasNoStaleTail() {
  const messages = [
    system(),
    user("first", "cm_first"),
    assistant("answer 1"),
    user("second", "cm_second"),
    assistant("answer 2"),
  ];
  const result = replaceUserMessageAndTruncate(messages, user("edited second", "cm_second"), {
    clientMessageId: "cm_second",
  });
  const conversation = serializeConversation(result.messages);
  const transcript = transcriptFromConversation(conversation);

  assert.deepEqual(
    transcript.map(entry => entry.type === "user" ? `user:${entry.text}` : `assistant:${entry.content}`),
    ["user:first", "assistant:answer 1", "user:edited second"],
  );
  assert.equal(JSON.stringify(conversation).includes("answer 2"), false);
}

async function assertAgentEditRerunUsesPendingUserMessage() {
  const { agent, store } = await createTestAgent("edit-pending");
  agent.messages = [system(), user("previous", "cm_previous"), assistant("partial answer")];
  agent.followUp("queued original", [{ dataUrl: "data:image/png;base64,QUEUED", name: "queued.png" }], "cm_queued");

  let replaced = null;
  await agent.editUserMessageAndRerun({
    clientMessageId: "cm_queued",
    text: "edited queued",
    onReplaced: async (payload) => { replaced = payload; },
  });

  assert.equal(agent.__ran, true);
  assert.equal(agent.followUpQueue.hasItems(), false);
  assert.equal(agent.messages.at(-1).role, "user");
  assert.equal(agent.messages.at(-1).clientMessageId, "cm_queued");
  assert.deepEqual(labelUserContent(agent.messages.at(-1).content), {
    text: "edited queued",
    imageCount: 1,
  });
  assert.equal(replaced.targetIndex, 3);
  assert.equal(store[`_active_conversation_edit-pending`].entries.at(-1).message.clientMessageId, "cm_queued");
}

async function assertAgentEditRerunFallsBackToNewMessage() {
  const { agent, store } = await createTestAgent("edit-missing");
  agent.messages = [system(), user("previous", "cm_previous"), assistant("previous answer")];

  let replaced = null;
  await agent.editUserMessageAndRerun({
    clientMessageId: "cm_missing",
    text: "fallback new",
    images: [{ dataUrl: "data:image/png;base64,FALLBACK", name: "fallback.png" }],
    onReplaced: async (payload) => { replaced = payload; },
  });

  assert.equal(agent.__ran, true);
  assert.equal(agent.messages.at(-1).role, "user");
  assert.equal(agent.messages.at(-1).clientMessageId, "cm_missing");
  assert.deepEqual(labelUserContent(agent.messages.at(-1).content), {
    text: "fallback new",
    imageCount: 1,
  });
  assert.equal(replaced.targetIndex, 3);
  assert.equal(replaced.conversation.entries.at(-1).message.clientMessageId, "cm_missing");
  assert.equal(store[`_active_conversation_edit-missing`].entries.at(-1).message.clientMessageId, "cm_missing");
}

async function assertAgentFollowUpQueueEvents() {
  const { agent } = await createTestAgent("follow-up-queue-events");
  const events = [];
  agent.subscribe(event => events.push(event));
  const document = {
    sessionId: "follow-up-queue-events",
    messageId: "cm_follow_up",
    attachmentId: "att_follow_up",
    fileId: "file_follow_up",
    docModelId: "model_follow_up",
    filename: "queued.py",
    mimeType: "text/x-python",
    format: "code",
    size: 42,
  };
  agent.followUp("queued later", [], "cm_follow_up", [document]);

  assert.equal(agent.followUpQueue.hasItems(), true);
  assert.equal(agent.hasPendingUserInput(), true);
  assert.equal(agent.findPendingUserMessage("cm_follow_up")?.clientMessageId, "cm_follow_up");
  assert.equal(events.some(event => event.type === "message_start"), false, "queued follow-up should not enter transcript immediately");
  const queueEvent = events.find(event => event.type === "queue_update");
  assert.ok(queueEvent, "queued follow-up should emit a queue_update event");
  assert.deepEqual(queueEvent.pendingFollowUps.map(item => item.clientMessageId), ["cm_follow_up"]);

  const removal = await agent.removeFollowUp("cm_follow_up", async message => {
    assert.deepEqual(message.documents, [document]);
    assert.equal(await agent._runNextFollowUpRun(), false, "attachment cleanup must pause queue handoff");
    return { attachmentCount: 1, deletedFileCount: 1, deletedModelCount: 1 };
  });
  assert.equal(agent.followUpQueue.hasItems(), false);
  assert.equal(agent.hasPendingUserInput(), false);
  assert.equal(agent.findPendingUserMessage("cm_follow_up"), null);
  assert.deepEqual(events.at(-1).pendingFollowUps, []);
  assert.equal(removal.cleanup.attachmentCount, 1);

  const restoredDocument = {
    ...document,
    messageId: "cm_restore",
    attachmentId: "att_restore",
    fileId: "file_restore",
    docModelId: "model_restore",
  };
  agent.followUp("before restored item", [], "cm_before");
  agent.followUp("restore on failure", [], "cm_restore", [restoredDocument]);
  agent.followUp("after restored item", [], "cm_after");
  await assert.rejects(
    agent.removeFollowUp("cm_restore", async () => {
      throw Object.assign(new Error("cleanup failed"), { code: "CLEANUP_FAILED" });
    }),
    error => error.code === "CLEANUP_FAILED",
  );
  assert.deepEqual(
    agent.getPendingFollowUps().map(item => item.clientMessageId),
    ["cm_before", "cm_restore", "cm_after"],
    "rollback must restore a middle message at its original FIFO position",
  );
  assert.deepEqual(
    events.at(-1).pendingFollowUps.map(item => item.clientMessageId),
    ["cm_before", "cm_restore", "cm_after"],
  );
  await agent.removeFollowUp("cm_restore");
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_before", "cm_after"]);
  await agent.removeFollowUp("cm_before");
  await agent.removeFollowUp("cm_after");

  for (const id of ["steer_before", "steer_restore", "steer_after"]) {
    agent.followUp(id, [], id);
    agent.steerFollowUp(id);
  }
  await assert.rejects(agent.removeSteering("steer_restore", async () => {
    assert.equal(await agent._runNextFollowUpRun(), false, "steering cleanup must pause queue handoff");
    throw Object.assign(new Error("cleanup failed"), { code: "CLEANUP_FAILED" });
  }), error => error.code === "CLEANUP_FAILED");
  assert.deepEqual(agent.getPendingSteerings().map(item => item.clientMessageId), ["steer_before", "steer_restore", "steer_after"]);
  assert.deepEqual(events.at(-1).pendingSteerings.map(item => item.clientMessageId), ["steer_before", "steer_restore", "steer_after"]);
  assert.deepEqual(agent.getPendingFollowUps(), [], "steering rollback must not insert into the follow-up queue");
  for (const id of ["steer_before", "steer_restore", "steer_after"]) await agent.removeSteering(id);
}

async function assertAgentSteeringReentersAtSafeBoundary() {
  const { agent } = await createTestAgent("steering-safe-boundary");
  const events = [];
  const llmSnapshots = [];
  const document = {
    sessionId: "steering-safe-boundary",
    messageId: "cm_steer_one",
    attachmentId: "att_steer_one",
    fileId: "file_steer_one",
    docModelId: "model_steer_one",
    filename: "steering.md",
    mimeType: "text/markdown",
    format: "markdown",
    size: 24,
  };
  agent.subscribe(event => events.push(event));
  agent._scheduleNextFollowUpRun = () => {};
  agent._persistConversation = async () => {};
  agent._persistIfInterruptedTurnRepaired = async () => false;
  agent._persistIfToolLedgerRepaired = async () => false;
  agent._flushPendingContextEvents = async () => {};
  let dynamicContextRefreshCount = 0;
  let contextCapsuleBuildCount = 0;
  let goalCapsuleBuildCount = 0;
  agent._refreshDynamicContextSnapshot = async () => {
    dynamicContextRefreshCount += 1;
    return { pageUrl: "https://example.com/steering-batch" };
  };
  agent._buildContextCapsuleMessage = (_dynamicContext, reason) => {
    contextCapsuleBuildCount += 1;
    return {
      role: "user",
      _origin: "context_capsule",
      _contextCapsule: { reason },
      content: "[运行上下文 capsule] steering batch",
    };
  };
  agent._buildGoalSnapshotCapsuleMessage = () => {
    goalCapsuleBuildCount += 1;
    return {
      role: "user",
      _origin: "context_capsule",
      _contextCapsule: { reason: "goal_snapshot" },
      content: "[当前目标追踪 capsule] steering batch",
    };
  };
  agent.followUp(
    "steer one",
    [{ dataUrl: "data:image/png;base64,STEER", name: "steer.png" }],
    "cm_steer_one",
    [document],
  );
  agent.followUp("steer two", [], "cm_steer_two");

  let llmCall = 0;
  agent._callLLM = async () => {
    llmSnapshots.push(agent.messages.map(message => ({
      role: message.role,
      clientMessageId: message.clientMessageId || "",
      toolCallId: message.tool_call_id || "",
      origin: message._origin || "",
      capsuleReason: message._contextCapsule?.reason || "",
    })));
    llmCall += 1;
    if (llmCall === 1) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_safe_boundary",
          type: "function",
          function: { name: "list_tabs", arguments: "{}" },
        }],
        _stopReason: "tool_calls",
      };
    }
    return { role: "assistant", content: "done", tool_calls: [], _stopReason: "stop" };
  };
  agent._executeToolCalls = async () => {
    const first = agent.steerFollowUp("cm_steer_one");
    const second = agent.steerFollowUp("cm_steer_two");
    assert.equal(first instanceof Promise, false, "follow-up to steering must be one synchronous queue mutation");
    assert.ok(second);
    const pending = agent.getPendingSteeringMessages();
    assert.deepEqual(pending.map(message => message.clientMessageId), ["cm_steer_one", "cm_steer_two"]);
    assert.deepEqual(pending[0].documents, [document], "steering must preserve document references");
    assert.deepEqual(labelUserContent(pending[0].content), { text: "steer one", imageCount: 1 });
    return [{ role: "tool", tool_call_id: "call_safe_boundary", content: "tabs ready" }];
  };

  await agent._runLoop(new AbortController().signal, [user("initial", "cm_initial")]);

  assert.equal(llmSnapshots.length, 2);
  assert.deepEqual(
    llmSnapshots[0].filter(message => message.role === "user" && message.clientMessageId).map(message => message.clientMessageId),
    ["cm_initial"],
    "steering created during a tool batch must not enter the in-flight LLM turn",
  );
  assert.deepEqual(
    llmSnapshots[1].filter(message => message.role === "user" && message.clientMessageId).map(message => message.clientMessageId),
    ["cm_initial", "cm_steer_one", "cm_steer_two"],
    "all steering available at the next safe boundary must enter one continuation",
  );
  assert.equal(dynamicContextRefreshCount, 1, "one steering batch should refresh dynamic context once");
  assert.equal(contextCapsuleBuildCount, 1, "one steering batch should build one runtime-context capsule");
  assert.equal(goalCapsuleBuildCount, 1, "one steering batch should build one goal capsule");
  const secondSnapshot = llmSnapshots[1];
  assert.equal(
    secondSnapshot.filter(message => message.capsuleReason === "queued_user_message").length,
    1,
    "multiple steering messages must share one runtime-context capsule",
  );
  assert.equal(
    secondSnapshot.filter(message => message.capsuleReason === "goal_snapshot").length,
    1,
    "multiple steering messages must share one goal capsule",
  );
  assert.ok(
    secondSnapshot.findIndex(message => message.role === "tool")
      < secondSnapshot.findIndex(message => message.clientMessageId === "cm_steer_one"),
    "steering must be appended after the complete assistant tool-call/result pair",
  );
  assert.deepEqual(agent.getPendingSteerings(), []);
  assert.deepEqual(agent.getPendingFollowUps(), []);
  assert.deepEqual(
    events.filter(event => event.type === "message_start" && event.message?.role === "user")
      .map(event => event.message.clientMessageId),
    ["cm_initial", "cm_steer_one", "cm_steer_two"],
  );
}

async function assertAgentSteeringStaysQueuedUntilPrepared() {
  const { agent } = await createTestAgent("steering-prepared-handoff");
  const events = [];
  const handoffOrder = [];
  agent.subscribe(event => {
    events.push(event);
    if (event.type === "queue_update" && event.pendingSteerings?.length === 0) {
      handoffOrder.push("queue_update");
    }
    if (event.type === "message_start" && event.message?.clientMessageId === "cm_slow_steer") {
      handoffOrder.push("message_start");
    }
  });
  agent._scheduleNextFollowUpRun = () => {};
  agent._persistIfInterruptedTurnRepaired = async () => false;
  agent._persistIfToolLedgerRepaired = async () => false;
  agent._flushPendingContextEvents = async () => {};
  agent._buildContextCapsuleMessage = () => null;
  agent._buildGoalSnapshotCapsuleMessage = () => null;
  agent._persistConversation = async () => {
    handoffOrder.push("persist");
  };

  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise(resolve => {
    markRefreshStarted = resolve;
  });
  const slowRefresh = new Promise(resolve => {
    releaseRefresh = resolve;
  });
  agent._refreshDynamicContextSnapshot = async () => {
    markRefreshStarted();
    await slowRefresh;
    return { pageUrl: "https://example.com/slow-context" };
  };
  agent._callLLM = async () => ({
    role: "assistant",
    content: "done",
    tool_calls: [],
    _stopReason: "stop",
  });

  agent.followUp("slow steering", [], "cm_slow_steer");
  agent.steerFollowUp("cm_slow_steer");
  events.length = 0;
  handoffOrder.length = 0;
  const runPromise = agent._runLoop(new AbortController().signal);

  await refreshStarted;
  assert.deepEqual(
    agent.getPendingSteerings().map(message => message.clientMessageId),
    ["cm_slow_steer"],
    "steering must remain visible while dynamic context is still being prepared",
  );
  assert.equal(
    events.some(event => event.type === "queue_update" && event.pendingSteerings?.length === 0),
    false,
    "a slow context refresh must not announce dequeue before handoff is ready",
  );
  assert.equal(
    events.some(event => event.type === "message_start" && event.message?.clientMessageId === "cm_slow_steer"),
    false,
  );

  releaseRefresh();
  await runPromise;

  const queueUpdateIndex = events.findIndex(event => (
    event.type === "queue_update" && event.pendingSteerings?.length === 0
  ));
  const messageStartIndex = events.findIndex(event => (
    event.type === "message_start" && event.message?.clientMessageId === "cm_slow_steer"
  ));
  assert.notEqual(queueUpdateIndex, -1);
  assert.equal(
    messageStartIndex,
    queueUpdateIndex + 1,
    "the accepted user message must immediately follow the visible steering dequeue",
  );
  assert.deepEqual(
    handoffOrder.slice(0, 3),
    ["persist", "queue_update", "message_start"],
    "the steering batch should be durable before one gapless queue-to-transcript handoff",
  );
}

async function assertRemovedIdleSteeringDoesNotStartAnEmptyTurn() {
  const { agent } = await createTestAgent("steering-removed-during-preparation");
  agent._scheduleNextFollowUpRun = () => {};
  agent._persistConversation = async () => {};
  agent._persistIfInterruptedTurnRepaired = async () => false;
  agent._persistIfToolLedgerRepaired = async () => false;
  agent._flushPendingContextEvents = async () => {};
  agent._buildContextCapsuleMessage = () => null;
  agent._buildGoalSnapshotCapsuleMessage = () => null;

  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise(resolve => {
    markRefreshStarted = resolve;
  });
  const slowRefresh = new Promise(resolve => {
    releaseRefresh = resolve;
  });
  agent._refreshDynamicContextSnapshot = async () => {
    markRefreshStarted();
    await slowRefresh;
    return {};
  };
  let llmCalls = 0;
  agent._callLLM = async () => {
    llmCalls += 1;
    return { role: "assistant", content: "unexpected", tool_calls: [], _stopReason: "stop" };
  };

  agent.followUp("remove while preparing", [], "cm_removed_steer");
  agent.steerFollowUp("cm_removed_steer");
  const runPromise = agent._runLoop(
    new AbortController().signal,
    [],
    { requireSteeringHandoff: true },
  );
  await refreshStarted;
  await agent.removeSteering("cm_removed_steer");
  releaseRefresh();
  await runPromise;

  assert.equal(llmCalls, 0, "removing the last visible steering during preparation must cancel the empty idle turn");
  assert.deepEqual(agent.getPendingSteerings(), []);
}

async function assertAgentIdleSteeringRunsBeforeFollowUps() {
  const { agent } = await createTestAgent("steering-idle-priority");
  const runs = [];
  let admissions = 0;
  agent._canStartQueuedRun = async () => { admissions += 1; return true; };
  agent._scheduleNextFollowUpRun = () => {};
  agent._runWithLifecycle = async (pending = [], { requireFollowUpHandoff = false } = {}) => {
    if (requireFollowUpHandoff) pending = agent.followUpQueue.drain();
    runs.push({
      initial: pending.map(message => message.clientMessageId),
      visibleSteerings: agent.getPendingSteerings().map(message => message.clientMessageId),
    });
    agent.steeringQueue.drain();
  };
  agent.followUp("steer first", [], "cm_steer_first");
  agent.followUp("steer second", [], "cm_steer_second");
  agent.followUp("ordinary follow-up", [], "cm_follow_after");
  agent.steerFollowUp("cm_steer_first");
  agent.steerFollowUp("cm_steer_second");

  assert.equal(await agent._runNextFollowUpRun(), true);
  assert.equal(admissions, 1, "steering and follow-ups share one supervisor admission per run");
  assert.deepEqual(runs, [{
    initial: [],
    visibleSteerings: ["cm_steer_first", "cm_steer_second"],
  }], "idle fallback must keep steering visible through run startup");
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_follow_after"]);
  assert.equal(await agent._runNextFollowUpRun(), true);
  assert.equal(admissions, 2);
  assert.deepEqual(runs, [{
    initial: [],
    visibleSteerings: ["cm_steer_first", "cm_steer_second"],
  }, {
    initial: ["cm_follow_after"],
    visibleSteerings: [],
  }]);
}

async function assertAgentFollowUpsRunOneAtATime() {
  const { agent } = await createTestAgent("follow-up-run-boundary");
  const runs = [];
  const events = [];
  agent.subscribe(event => events.push(event));
  agent._runWithLifecycle = async (initialPendingMessages = [], { requireFollowUpHandoff = false } = {}) => {
    if (requireFollowUpHandoff) initialPendingMessages = agent.followUpQueue.drain();
    runs.push(initialPendingMessages.map(msg => msg.clientMessageId));
    agent._emit({ type: "agent_start", runId: `run_${runs.length}` });
    for (const msg of initialPendingMessages) {
      agent._emit({ type: "message_start", message: msg, clientMessageId: msg.clientMessageId });
      agent._emit({ type: "message_end", message: msg, clientMessageId: msg.clientMessageId });
    }
    agent._emit({ type: "agent_end", runId: `run_${runs.length}` });
  };

  agent.followUp("first queued", [], "cm_first");
  agent.followUp("second queued", [], "cm_second");

  assert.equal(await agent._runNextFollowUpRun(), true);
  assert.deepEqual(runs, [["cm_first"]]);
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_second"]);

  assert.equal(await agent._runNextFollowUpRun(), true);
  assert.deepEqual(runs, [["cm_first"], ["cm_second"]]);
  assert.deepEqual(agent.getPendingFollowUps(), []);
  assert.equal(events.filter(event => event.type === "message_start").length, 2);
}

async function assertAgentRestoredFollowUpsResume() {
  const { agent } = await createTestAgent("follow-up-restore-resume");
  let scheduleCount = 0;
  agent._scheduleNextFollowUpRun = () => {
    scheduleCount += 1;
  };

  agent.restorePendingFollowUps([user("restored queued", "cm_restored")]);
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_restored"]);
  assert.equal(scheduleCount, 1, "restored idle follow-up queue should schedule background consumption");
}

async function assertAgentRestoredQueuesDedupeDeliveredMessages() {
  const { agent } = await createTestAgent("steering-restore-dedupe");
  let scheduleCount = 0;
  agent.messages = [system(), user("already delivered", "cm_delivered")];
  agent._scheduleNextFollowUpRun = () => {
    scheduleCount += 1;
  };

  agent.restorePendingQueues({
    steerings: [
      user("stale steering", "cm_delivered"),
      user("restored steering", "cm_steering"),
      user("steering wins duplicate", "cm_cross_queue"),
    ],
    followUps: [
      user("stale follow-up", "cm_delivered"),
      user("duplicate lower priority", "cm_cross_queue"),
      user("restored follow-up", "cm_follow_up"),
    ],
  });

  assert.deepEqual(
    agent.getPendingSteerings().map(item => item.clientMessageId),
    ["cm_steering", "cm_cross_queue"],
  );
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_follow_up"]);
  assert.equal(scheduleCount, 1, "restoring both queues should arm one idle handoff");
}

async function assertAgentAbortPreservesFollowUps() {
  const { agent } = await createTestAgent("follow-up-abort-preserve");
  agent.followUp("first queued", [], "cm_first");
  agent.followUp("second queued", [], "cm_second");

  agent.abort();

  assert.deepEqual(
    agent.getPendingFollowUps().map(item => item.clientMessageId),
    ["cm_first", "cm_second"],
    "aborting the current run must not cancel messages already accepted into the FIFO queue",
  );
  assert.ok(agent._followUpRunTimer, "aborting outside an active run must leave the queued handoff armed");
  agent._clearScheduledFollowUpRun();
}

async function assertRetiredAgentCannotDrainFollowUps() {
  let active = true;
  const { agent } = await createTestAgent("follow-up-retired-lease", {
    conversationLease: { isActive: () => active },
  });
  agent.followUp("still queued", [], "cm_retired");
  agent._clearScheduledFollowUpRun();
  active = false;

  assert.equal(await agent._runNextFollowUpRun(), false);
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ["cm_retired"]);
}

async function assertRetiredAgentCannotDrainSteering() {
  let active = true;
  const { agent } = await createTestAgent("steering-retired-lease", {
    conversationLease: { isActive: () => active },
  });
  agent._scheduleNextFollowUpRun = () => {};
  agent.followUp("still steering", [], "cm_retired_steering");
  agent.steerFollowUp("cm_retired_steering");
  active = false;

  assert.equal(await agent._runNextFollowUpRun(), false);
  assert.deepEqual(agent.getPendingSteerings().map(item => item.clientMessageId), ["cm_retired_steering"]);
}

async function createTestAgent(sessionId, options = {}) {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: store[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, store[item]]));
          return { ...store };
        },
        async set(value) {
          Object.assign(store, value || {});
        },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete store[item];
        },
      },
    },
    runtime: {
      getURL(path) {
        return path;
      },
    },
  };
  const { Agent } = await import(`../../src/background/agent/agent.js?test=${sessionId}`);
  const agent = new Agent(sessionId, createTestAgentOptions({ conversationRepository: getSessionRepository(), ...options }));
  agent._refreshDynamicContextSnapshot = async () => {};
  agent._runWithLifecycle = async () => {
    agent.__ran = true;
  };
  return { agent, store };
}

function labelUserContent(content) {
  if (typeof content === "string") return { text: content, imageCount: 0 };
  const parts = Array.isArray(content) ? content : [];
  return {
    text: parts.find(part => part?.type === "text")?.text || "",
    imageCount: parts.filter(part => part?.type === "image_url").length,
  };
}

function system() {
  return { role: "system", content: "system prompt" };
}

function user(content, clientMessageId) {
  return { role: "user", content, clientMessageId, _origin: "user" };
}

function assistant(content) {
  return { role: "assistant", content };
}

function assistantWithTool(id) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: { name: "save_file", arguments: "{}" },
    }],
  };
}

function tool(id, content) {
  return { role: "tool", tool_call_id: id, content };
}

function transcriptUser(text, clientMessageId) {
  return { type: "user", text, images: [], clientMessageId, deliveryStatus: "committed" };
}

function labelMessage(msg) {
  if (msg.role === "system") return "system";
  if (msg.role === "user") return msg.content;
  return msg.role;
}

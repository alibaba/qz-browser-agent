import { buildSiteSkillContextEventMessage } from "../../src/background/agent/context.js";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { formatContextUsageText } from "../../src/sidepanel/ui/ui-utils.js";
import { createTestAgentOptions } from "../support/agent-services.mjs";
import { getSessionRepository } from "../../src/background/session/repository.js";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  buildCompactionPlan,
  contextTokensFromUsage,
  createCompactMessage,
  estimateContextTokens,
  estimateToolSchemaTokens,
  estimateTokens,
  findFallbackCompactionCutIndex,
  latestCompactIndex,
  serializeMessagesForCompaction,
} from "../../src/background/agent/compaction.js";
import {
  buildCompactUserPrompt,
  COMPACT_SYSTEM_PROMPT,
  COMPACT_USER_PROMPT,
} from "../../src/background/agent/prompts.js";
import {
  deserializeConversationWithRepair,
  serializeConversation,
  transcriptFromConversation,
  updateTranscriptWithAgentEvent,
} from "../../src/shared/session/session-codec.js";
import { findEditableUserMessageIndex } from "../../src/shared/session/conversation-edit.js";
import { SessionState } from "../../src/sidepanel/features/sessions/session-state.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

assertBelowThresholdDoesNotCompact();
assertCompactionCutsCompleteRounds();
assertExplicitCompactionRetainsLatestRound();
assertCompactionRollsUpLatestCheckpoint();
assertCompactionPreservesDocumentReferences();
assertOversizedLatestRoundDoesNotLoopCompaction();
assertCompactNodePersistsThroughConversationCodec();
assertCompactTranscriptLifecycle();
assertStandaloneCompactHasIndependentCausality();
assertAssistantMessageStartCreatesStreamingTranscript();
assertUiAndRuntimeKnowCompactEvents();
assertContextUsageHasSingleSourceOfTruth();
assertProviderUsageAnchorsContextEstimate();
assertProviderUsagePersistsThroughConversationCodec();
assertProviderStateCountsTowardTokenEstimate();
assertProviderStateOnlyAssistantPersistsThroughConversationCodec();
assertContextCapsulesPersistButStayHidden();
assertHiddenContextDoesNotEnterCompactionInput();
assertUserImageTranscriptDoesNotExposeOmittedPlaceholder();
assertToolSchemasCountTowardBudget();
await assertAgentUsesVerifiedUsageAnchor();
assertCompactionPrefersCompleteRoundsBeforeToolBoundaries();
assertContextCapsulePrefixDoesNotCauseNoopCompact();
assertClosedToolChainCanCompactWithoutRetainedTail();
assertCompactionPlansHaveUsefulPostconditions();
assertUsageBoundaryPreventsStaleAnchorAfterCompact();
assertAgentHasCompactionBarrier();
assertCompactionPromptIsAnchoredAfterHistory();
await assertAgentSendBudgetGateTransitionMatrix();
await assertExplicitCompactionWorksBelowLocalThreshold();
await assertSequentialCompactionRollsUpPriorCheckpoint();
await assertCompactIdentitySurvivesAgentRecreation();
await assertExplicitCompactionCanBeAborted();
await assertStandaloneCompactionBlocksFollowUpRuns();
await assertFailedCompactionRollsBackStagedMessages();
await assertAgentUsesStableToolResultPruning();
await assertAgentLimitsImageMessagesWithinOneRound();
await assertImageMessageLimitBoundaries();
await assertImageMessageLimitInvalidatesUsageAnchor();
assertAgentAllowsDisablingOldToolResultTrim();
assertAgentUsesContextCapsulesInsteadOfEphemeralDynamicTail();

function assertBelowThresholdDoesNotCompact() {
  const plan = buildCompactionPlan({
    messages: [system(), user("hello"), assistant("world")],
    messageTokens: [0, 10, 10],
    inputTokens: 1000,
    contextWindow: 32000,
    reserveTokens: 16000,
  });

  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "below_threshold");
}

function assertCompactionCutsCompleteRounds() {
  const messages = [
    system(),
    user("r1"),
    assistant("a1"),
    user("r2"),
    assistant("a2"),
    user("r3"),
    assistant("a3"),
    user("r4"),
    assistant("a4"),
  ];

  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((_, index) => (index === 0 ? 0 : 1000)),
    inputTokens: 17000,
    contextWindow: 20000,
    reserveTokens: 4000,
    maxKeepTokens: 4000,
  });

  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.cutIndex, 5, "retained suffix should start at a user round");
  assert.deepEqual(plan.sourceMessages.map(messageLabel), ["r1", "a1", "r2", "a2"]);
  assert.deepEqual(plan.retainedMessages.map(messageLabel), ["r3", "a3", "r4", "a4"]);
}

function assertExplicitCompactionRetainsLatestRound() {
  const messages = [
    system(),
    user("r1"),
    assistant("a1"),
    user("r2"),
    assistant("a2"),
    user("r3"),
    assistant("a3"),
    user("r4"),
    { role: "assistant", content: "", tool_calls: [{ id: "call_latest", function: { name: "read_page", arguments: "{}" } }] },
    toolResult("latest", "latest result", 100),
    assistant("a4"),
  ];

  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((_, index) => (index === 0 ? 0 : 100)),
    inputTokens: 1100,
    contextWindow: 20000,
    reserveTokens: 4000,
    force: true,
    retainLatestRound: true,
  });

  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.cutIndex, 7, "explicit compaction should fold every complete round before the latest one");
  assert.deepEqual(plan.sourceMessages.map(messageLabel), ["r1", "a1", "r2", "a2", "r3", "a3"]);
  assert.deepEqual(
    plan.retainedMessages.map(messageLabel),
    ["r4", "", "latest result", "a4"],
    "the latest round must stay intact, including its tool call and result",
  );

  const thresholdRecoveryPlan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((_, index) => (index === 0 ? 0 : 100)),
    inputTokens: 1100,
    contextWindow: 20000,
    reserveTokens: 4000,
    force: true,
  });
  assert.equal(
    thresholdRecoveryPlan.cutIndex,
    3,
    "bypassing the threshold alone must retain the automatic budget-based cut policy",
  );
}

function assertCompactionRollsUpLatestCheckpoint() {
  const compact = createCompactMessage({
    compactId: "compact_prev",
    summary: "older summary",
    plan: { sourceMessageCount: 2, retainedMessageCount: 4 },
    contextWindow: 32000,
    inputTokensBefore: 24000,
    inputTokensAfter: 9000,
  });
  const messages = [
    system(),
    user("old"),
    compact,
    user("r1"),
    assistant("a1"),
    user("r2"),
    assistant("a2"),
    user("r3"),
    assistant("a3"),
  ];

  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((_, index) => (index === 0 ? 0 : 1000)),
    inputTokens: 19000,
    contextWindow: 22000,
    reserveTokens: 4000,
    maxKeepTokens: 4000,
  });

  assert.equal(latestCompactIndex(messages), 2);
  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.minIndex, 3, "raw source must begin after the latest compact node");
  assert.deepEqual(
    plan.sourceMessages.map(messageLabel),
    ["older summary", "r1", "a1"],
    "the prior checkpoint must roll into the next checkpoint",
  );
  assert.match(serializeMessagesForCompaction(plan.sourceMessages), /\[Previous checkpoint\]: older summary/);
  assert.deepEqual(plan.retainedMessages.map(messageLabel), ["r2", "a2", "r3", "a3"]);
}

function assertCompactionPreservesDocumentReferences() {
  const message = {
    ...user("继续分析附件"),
    documents: [{
      sessionId: "session-doc",
      messageId: "message-doc",
      attachmentId: "attachment-doc",
      fileId: "file-doc",
      docModelId: "model-doc",
      filename: "report.xlsx",
      format: "xlsx",
    }],
  };
  const serialized = serializeMessagesForCompaction([message]);
  assert.match(serialized, /\[Documents\]: report\.xlsx/);
  assert.match(serialized, /docModelId=model-doc/);
  assert.match(serialized, /fileId=file-doc/);
}

function assertOversizedLatestRoundDoesNotLoopCompaction() {
  const messages = [
    system(),
    user("huge-user"),
    assistant("huge-assistant"),
  ];
  const plan = buildCompactionPlan({
    messages,
    messageTokens: [0, 20000, 1000],
    inputTokens: 23000,
    contextWindow: 24000,
    reserveTokens: 4000,
    maxKeepTokens: 4000,
  });

  assert.equal(plan.shouldCompact, false);
  assert.equal(plan.reason, "no_compactable_segment");
}

function assertCompactNodePersistsThroughConversationCodec() {
  const compact = createCompactMessage({
    compactId: "compact_codec",
    summary: "用户确认了检索范围；后续只需继续读取论文。",
    plan: {
      sourceMessageCount: 6,
      retainedMessageCount: 3,
      minIndex: 1,
      cutIndex: 7,
      threshold: 16000,
      keepBudget: 9000,
    },
    contextWindow: 32000,
    inputTokensBefore: 28500,
    inputTokensAfter: 9400,
  });
  const saved = serializeConversation([
    system(),
    user("before"),
    compact,
    user("after"),
  ]);
  const restored = deserializeConversationWithRepair(saved, "system prompt").messages;
  const compactRestored = restored.find(msg => msg._kind === "compaction");

  assert.ok(compactRestored, "compact node should survive conversation serialization");
  assert.equal(compactRestored._origin, "compaction");
  assert.equal(compactRestored._compact.compactId, "compact_codec");
  assert.equal(compactRestored._compact.inputTokensAfter, 9400);

  const transcript = transcriptFromConversation(saved);
  const compactTranscript = transcript.find(entry => entry.type === "compact");
  assert.ok(compactTranscript, "conversation transcript should expose compact as a first-class event");
  assert.equal(compactTranscript.compactId, "compact_codec");
  assert.equal(compactTranscript.status, "done");
  assert.match(compactTranscript.summary, /检索范围/);
}

function assertCompactTranscriptLifecycle() {
  const runId = "run_compact_lifecycle";
  let result = updateTranscriptWithAgentEvent([], {
    type: "context_compaction_start",
    runId,
    compactId: "compact_live",
    inputTokensBefore: 57000,
    contextWindow: 64000,
    threshold: 48000,
    sourceMessageCount: 12,
    retainedMessageCount: 5,
  });

  assert.equal(result.changed, true);
  assert.equal(result.transcript.length, 1);
  assert.equal(result.transcript[0].type, "compact");
  assert.equal(result.transcript[0].status, "running");
  assert.equal(result.transcript[0].streaming, true);

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "context_compaction_end",
    runId,
    compactId: "compact_live",
    status: "done",
    summary: "历史已经压缩成一个稳定摘要。",
    inputTokensBefore: 57000,
    inputTokensAfter: 11800,
    contextWindow: 64000,
    threshold: 48000,
    sourceMessageCount: 12,
    retainedMessageCount: 5,
  });

  assert.equal(result.transcript.length, 1, "compact end should update the running compact node");
  assert.equal(result.transcript[0].status, "done");
  assert.equal(result.transcript[0].streaming, undefined);
  assert.equal(result.transcript[0].summary, "历史已经压缩成一个稳定摘要。");
  assert.equal(result.transcript[0].inputTokensAfter, 11800);

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "context_compaction_failed",
    runId,
    compactId: "compact_failed",
    message: "模型调用失败",
    inputTokensBefore: 52000,
  });

  const failed = result.transcript.find(entry => entry.compactId === "compact_failed");
  assert.ok(failed, "failed compact should still be represented as a compact event");
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary, "模型调用失败");

  result = updateTranscriptWithAgentEvent([], {
    type: "context_compaction_start",
    runId,
    compactId: "compact_abort",
    inputTokensBefore: 49000,
  });
  result = updateTranscriptWithAgentEvent(result.transcript, { type: "aborted", runId });
  assert.equal(result.transcript[0].status, "aborted", "abort should settle a running compact node");
  assert.equal(result.transcript[0].streaming, undefined);
}

function assertStandaloneCompactHasIndependentCausality() {
  const sessionId = "standalone-compact-causality";
  const state = new SessionState({ now: () => "2026-07-21 12:00:00" });
  state.applyEvent({ type: "agent_start", sessionId, runId: "old-run" });
  state.applyEvent({
    type: "message_update",
    sessionId,
    runId: "old-run",
    spanId: "old-run:llm:1",
    eventSeq: 12,
    content: "旧一轮输出",
  });
  state.applyEvent({ type: "agent_end", sessionId, runId: "old-run" });

  const started = state.applyEvent({
    type: "context_compaction_start",
    sessionId,
    compactId: "manual-compact",
    eventSeq: 1,
    inputTokensBefore: 4200,
  });
  assert.equal(started.accepted, true);
  assert.equal(started.transcriptChanged, true, "a standalone compact must not inherit the previous run sequence");
  assert.equal(state.getTranscript(sessionId).find(entry => entry.compactId === "manual-compact")?.status, "running");

  const completed = state.applyEvent({
    type: "context_compaction_end",
    sessionId,
    compactId: "manual-compact",
    eventSeq: 2,
    status: "done",
    summary: "手动压缩已经完成。",
    inputTokensBefore: 4200,
    inputTokensAfter: 1200,
  });
  assert.equal(completed.accepted, true);
  assert.equal(completed.transcriptChanged, true);
  const compact = state.getTranscript(sessionId).find(entry => entry.compactId === "manual-compact");
  assert.equal(compact.status, "done");
  assert.equal(compact.summary, "手动压缩已经完成。");
}

function assertAssistantMessageStartCreatesStreamingTranscript() {
  const result = updateTranscriptWithAgentEvent([], {
    type: "message_start",
    runId: "run_assistant_start",
    spanId: "run_assistant_start:llm:1",
    message: { role: "assistant", content: "" },
  });
  assert.equal(result.changed, true);
  assert.equal(result.transcript.length, 1);
  assert.equal(result.transcript[0].type, "assistant");
  assert.equal(result.transcript[0].content, "");
  assert.equal(result.transcript[0].streaming, true);

  const updated = updateTranscriptWithAgentEvent(result.transcript, {
    type: "message_update",
    runId: "run_assistant_start",
    spanId: "run_assistant_start:llm:1",
    delta: "hello",
    content: "hello",
  });
  assert.equal(updated.transcript.length, 1);
  assert.equal(updated.transcript[0].content, "hello");
  assert.equal(updated.transcript[0].streaming, true);
}

function assertUiAndRuntimeKnowCompactEvents() {
  const sessionState = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/sessions/session-state.ts"), "utf8"), { mode: "transform" });
  const eventRouter = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/sidepanel-event-router.ts"), "utf8"), { mode: "transform" });
  const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
  const sidepanel = [sessionState, eventRouter, transcriptRenderer].join("\n");
  const sidepanelCss = readStylesheetSource(join(root, "src/sidepanel/sidepanel.css"));
  const serviceWorker = stripTypeScriptTypes(readFileSync(join(root, "src/background/service-worker.ts"), "utf8"), { mode: "transform" });
  const sidepanelChannel = stripTypeScriptTypes(readFileSync(join(root, "src/background/transports/sidepanel-channel.ts"), "utf8"), { mode: "transform" });
  const runtimeReducer = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/runtime-reducer.ts"), "utf8"));
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));

  for (const eventType of ["context_compaction_start", "context_compaction_end", "context_compaction_failed"]) {
    assert.match(agent, new RegExp(`"${eventType}"`), `${eventType} should be stamped in the agent timeline`);
    assert.match(sidepanelChannel, new RegExp(`"${eventType}"`), `${eventType} should be handled by runtime broadcast`);
    assert.match(eventRouter, new RegExp(`"${eventType}"`), `${eventType} should be known by sidepanel runtime routing`);
  }
  const transcriptRecorder = extractFunction(eventRouter, "trackBackgroundRun");
  assert.match(sessionState, /updateTranscriptWithAgentEvent/, "SessionState should reuse the shared transcript reducer");
  assert.match(transcriptRecorder, /applyTranscriptUiSideEffects\(sessionId,\s*event\)/, "sidepanel should keep UI effects outside transcript state reduction");
  assert.match(transcriptRecorder, /sessionState\.applyEvent\(\{\s*\.\.\.event,\s*sessionId\s*\},\s*\{\s*transcript:\s*!ignoreTranscript\s*\}\)/, "sidepanel should render live events through the shared reducer without waiting for a snapshot");
  assert.doesNotMatch(sidepanel, /SIDE_PANEL_CUSTOM_TRANSCRIPT_EVENT_TYPES/, "sidepanel should not fork transcript state by event type");
  assert.doesNotMatch(transcriptRecorder, /switch\s*\(event\.type\)/, "sidepanel transcript recording should not duplicate reducer state transitions");
  const routerBody = extractFunction(eventRouter, "handle");
  assert.match(routerBody, /trackBackgroundRun\(event\)[\s\S]*case "context_compaction_start":[\s\S]*case "context_compaction_failed":\s*break;/, "compact events should reduce before side-effect routing and never wait for snapshot reconciliation");
  assert.match(transcriptRenderer, /createCompactTranscriptElement/, "sidepanel should render compact nodes");
  assert.match(transcriptRenderer, /msg-compact/, "compact nodes should have their own UI class");
  assert.match(
    transcriptRenderer,
    /patchCompactMarkdownSummary\(summary,\s*compactNodeSummary\(entry\)\)/,
    "compact summary should render through the markdown-aware compact patcher",
  );
  const compactMarkdownPatcher = extractFunction(transcriptRenderer, "patchCompactMarkdownSummary");
  assert.match(
    compactMarkdownPatcher,
    /patchHtmlContent\(summaryEl,\s*renderMarkdown\(source,\s*\{\s*math:\s*true\s*\}\)/,
    "compact summary should reuse the normal markdown renderer with math support",
  );
  assert.match(
    sidepanelCss,
    /\.compact-node-summary\s*\{[\s\S]*white-space:\s*normal/,
    "compact markdown should not inherit pre-wrap text layout",
  );
  assert.match(
    sidepanelCss,
    /\.compact-node-summary\s+\.copyable-code-block/,
    "compact markdown should support highlighted copyable code blocks",
  );
  assert.match(
    sidepanelCss,
    /\.compact-node-summary pre code\s*\{[\s\S]*white-space:\s*pre/,
    "compact markdown code blocks should keep code whitespace while the box wraps prose",
  );
}

function assertContextUsageHasSingleSourceOfTruth() {
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  const eventRouter = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/sidepanel-event-router.ts"), "utf8"), { mode: "transform" });
  const chatRunController = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-run-controller.ts"), "utf8"), { mode: "transform" });
  const serviceWorker = stripTypeScriptTypes(readFileSync(join(root, "src/background/service-worker.ts"), "utf8"), { mode: "transform" });
  const sessionCommands = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/commands.ts"), "utf8"));
  const sessionRuntimeState = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/runtime-state.ts"), "utf8"));
  const mcpRuntime = stripTypeScriptTypes(readFileSync(join(root, "src/background/mcp/mcp-runtime.ts"), "utf8"), { mode: "transform" });
  const runtimeReducer = stripTypeScriptTypes(readFileSync(join(root, "src/background/session/runtime-reducer.ts"), "utf8"));
  const runProfile = readFileSync(join(root, "src/background/agent/run-profile.ts"), "utf8");
  const llmGateway = readFileSync(join(root, "src/background/llm/index.ts"), "utf8");
  const llmConfig = transformSync(readFileSync(join(root, "src/background/llm/config.ts"), "utf8"), { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code;
  const runtimeConfig = stripTypeScriptTypes(readFileSync(join(root, "src/background/runtime-config.ts"), "utf8"));
  const compactBody = extractClassMethod(agent, "_compactIfNeeded");

  assert.doesNotMatch(
    compactBody,
    /_emitContextUsage|_emitSendWindowContextUsage/,
    "compaction planning should not publish transient ctx values",
  );
  assert.match(
    agent,
    /preparedWindow = await this\._prepareSendWindowOrBlock\(signal,\s*\{\s*dynamicContext,\s*toolSchemas,\s*phase:\s*"stream"\s*\}\)/,
    "streaming calls should prepare the final send window through the budget gate",
  );
  assert.match(
    agent,
    /_emitSendWindowContextUsage\(preparedWindow\.sendMessages,\s*\{\s*phase:\s*"stream"[\s\S]*contextEstimate:\s*preparedWindow\.contextEstimate/,
    "streaming calls should publish ctx from the final send-window estimate",
  );
  assert.match(
    agent,
    /_emitSendWindowContextUsage\(preparedWindow\.sendMessages,\s*\{\s*phase:\s*"fallback"[\s\S]*contextEstimate:\s*preparedWindow\.contextEstimate/,
    "fallback calls should publish ctx from the final send-window estimate",
  );
  assert.match(
    agent,
    /usage: usage => this\._emitProviderContextUsage\(usage\)/,
    "provider usage should be recorded without becoming the ctx source of truth",
  );
  assert.match(
    agent,
    /alignedMessage\._usage = usage/,
    "fallback calls should preserve provider usage as the next estimate anchor",
  );
  assert.match(
    agent,
    /getContextUsageState\(\)/,
    "agent state should expose a persisted-conversation-derived ctx estimate",
  );
  assert.match(
    runtimeReducer,
    /inputTokensEstimate:\s*event\.inputTokensEstimate\s*\|\|\s*previous\.inputTokensEstimate\s*\|\|\s*0/,
    "runtime state should preserve the latest send-window estimate when usage-only events arrive",
  );
  assert.match(
    mcpRuntime,
    /const entry = id \? await sessions\.getLiveAgentEntry\(id\) : null;/,
    "get_state should not cold-create an agent and overwrite the last real send-window ctx estimate",
  );
  assert.match(
    mcpRuntime,
    /getContextUsageState\(\)/,
    "get_state should merge live agent ctx only when a live entry already exists",
  );
  assert.match(
    runtimeConfig,
    /export async function getCurrentRuntimeConfig/,
    "background should expose a central current runtime config store",
  );
  assert.match(
    runProfile,
    /config: RuntimeConfig/,
    "run profile requires the host runtime config snapshot",
  );
  assert.doesNotMatch(
    runProfile,
    /from "\.\/llm\.js"/,
    "run profile should not bypass the central runtime config store",
  );
  assert.match(
    extractClassMethodDefinition(agent, "async _buildRunProfile()"),
    /_service\("getRuntimeConfig"\)\(\)/,
    "agent should snapshot the current runtime config before building a run profile",
  );
  assert.match(
    extractClassMethodDefinition(agent, "_llmOptions()"),
    /config:\s*this\._runtimeConfig\s*\|\|\s*null/,
    "agent LLM calls should use the same config snapshot as compact/profile planning",
  );
  assert.match(
    extractClassMethodDefinition(agent, "_llmOptions()"),
    /runId:\s*this\._currentRunId\s*\|\|\s*""/,
    "agent LLM calls should carry their owning run into provider traces",
  );
  assert.match(agent, /spanId:\s*compactId/, "compaction retains its local diagnostic identity");
  assert.match(
    llmGateway,
    /resolveConfig\s*=\s*resolveRequestConfig[\s\S]*const config = await resolveConfig\(options\);/,
    "LLM calls should accept and normalize the agent runtime config snapshot",
  );
  assert.match(
    llmConfig,
    /async function resolveRequestConfig\(options = \{\}\) \{[\s\S]*options\.config[\s\S]*normalizeConfig\(\{ \.\.\.DEFAULT_CONFIG, \.\.\.options\.config \}\)[\s\S]*getConfig\(\)[\s\S]*\n\}/,
    "explicit LLM config snapshots should share the same normalization path as stored config",
  );
  assert.match(
    extractFunction(sessionRuntimeState, "clearContextUsage"),
    /contextWindow:\s*0[\s\S]*inputTokensEstimate:\s*0/,
    "model config changes should clear stale derived runtime ctx cache",
  );
  // test-background-services exercises the real ConfigRuntime: saving/applying
  // config updates the live snapshot and invalidates derived context usage.
  // The compaction roundtrip and persistence assertions remain in this suite.
  assert.match(
    serviceWorker,
    /getCurrentRuntimeConfig/,
    "service-worker direct LLM calls should read from the central runtime config store",
  );
  assert.match(
    extractFunction(sessionCommands, "generateSessionTitleFromFirstMessage"),
    /llmChat\([\s\S]*config:\s*runtimeConfig/,
    "session title generation should pass the current runtime config snapshot into LLM calls",
  );
  assert.match(
    extractFunction(sessionCommands, "generateSessionTitleFromFirstMessage"),
    /rateLimit:\s*false/,
    "session title generation should not consume interactive provider admission capacity",
  );
  assert.doesNotMatch(
    extractClassMethodDefinition(agent, "async getContextUsageState()"),
    /_lastContextUsageSnapshot/,
    "state ctx should be recomputed from the current config instead of returning a stale snapshot",
  );
  assert.match(
    extractFunction(eventRouter, "handle"),
    /case "state":[\s\S]*runController\.handleRuntimeContextUsage\(event\.runtime\);/,
    "state snapshots should refresh the bottom ctx display from runtime context usage",
  );

  assert.match(
    extractFunction(chatRunController, "handleContextUsage"),
    /formatContextUsageText\(event\.inputTokensEstimate, event\.contextWindow\)/,
    "ctx should use the send-window estimate, never raw provider token usage",
  );
  assert.equal(formatContextUsageText(57000, 64000), "ctx 57k/64k");
  assert.equal(formatContextUsageText(undefined, 32000), "", "missing estimate must not show a provider usage fallback");
}

function assertProviderUsageAnchorsContextEstimate() {
  const trailing = user("后续新增内容".repeat(40));
  const tools = [largeToolSchema("read_page", 20)];
  const contextKey = "deepseek\ndeepseek-v4-flash\nhttps://example.test/v1";
  const prefix = [
    system(),
    user("旧上下文".repeat(500)),
  ];
  const fingerprint = estimateContextTokens(prefix, { toolSchemas: tools, contextKey }).requestFingerprint;
  const messages = [...prefix, assistant("完成", { total_tokens: 12000 }, "root", fingerprint), trailing];
  const estimate = estimateContextTokens(messages, { toolSchemas: tools, contextKey });

  assert.equal(contextTokensFromUsage({ input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 300 }), 6000);
  assert.equal(estimate.source, "usage_anchor");
  assert.equal(estimate.usageTokens, 12000);
  assert.equal(estimate.trailingTokens, estimateTokens([trailing]));
  assert.equal(estimate.tokens, 12000 + estimateTokens([trailing]));
  assert.equal(estimate.lastUsageIndex, 2);

  const failedAssistant = { ...messages[2], _stopReason: "error" };
  assert.equal(estimateContextTokens([...prefix, failedAssistant, trailing], { toolSchemas: tools, contextKey }).source, "estimate");
  const emptyUsageAssistant = { ...messages[2], _usage: { total_tokens: 0 } };
  assert.equal(estimateContextTokens([...prefix, emptyUsageAssistant, trailing], { toolSchemas: tools, contextKey }).source, "estimate");

  messages[0] = { role: "system", content: "changed system" };
  assert.equal(estimateContextTokens(messages, { toolSchemas: tools, contextKey }).source, "estimate", "a changed request prefix must invalidate provider usage");
  messages[0] = system();
  assert.equal(
    estimateContextTokens(messages, { toolSchemas: [...tools, largeToolSchema("new_tool", 20)], contextKey }).source,
    "estimate",
    "a changed tool set must invalidate provider usage",
  );
  assert.equal(
    estimateContextTokens(messages, { toolSchemas: tools, contextKey: `${contextKey}\nnew-model` }).source,
    "estimate",
    "a changed provider/model scope must invalidate provider usage",
  );

  const compact = createCompactMessage({
    compactId: "compact_usage_boundary",
    summary: "压缩后的摘要",
    plan: { sourceMessageCount: 4, retainedMessageCount: 1 },
    contextWindow: 64000,
  });
  const afterCompact = estimateContextTokens([system(), compact, trailing]);
  assert.equal(afterCompact.source, "estimate", "pre-compact provider usage should not anchor post-compact context");
}

function assertProviderUsagePersistsThroughConversationCodec() {
  const prefix = [system(), user("hello")];
  const fingerprint = estimateContextTokens(prefix).requestFingerprint;
  const saved = serializeConversation([
    ...prefix,
    assistant("world", { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 }, "compact_boundary_1", fingerprint),
  ]);
  const restored = deserializeConversationWithRepair(saved, "system").messages;
  const restoredAssistant = restored.find(msg => msg.role === "assistant");

  assert.deepEqual(restoredAssistant._usage, { input_tokens: 1000, output_tokens: 50, total_tokens: 1050 });
  assert.equal(restoredAssistant._usageContextBoundaryId, "compact_boundary_1");
  assert.equal(restoredAssistant._usageContextFingerprint, fingerprint);
  assert.equal(estimateContextTokens(restored, { boundaryId: "compact_boundary_1" }).usageTokens, 1050);
  assert.equal(estimateContextTokens(restored, { boundaryId: "another_boundary" }).source, "estimate");
}

function assertProviderStateCountsTowardTokenEstimate() {
  const base = estimateTokens([assistant("ok")]);
  const withReasoning = estimateTokens([{
    ...assistant("ok"),
    _providerState: {
      version: 1,
      kind: "openai_reasoning",
      reasoningText: "x".repeat(1000),
    },
  }]);
  assert.ok(withReasoning > base + 500, "provider continuation state should count toward input estimate");
}

function assertProviderStateOnlyAssistantPersistsThroughConversationCodec() {
  const stateOnlyAssistant = {
    role: "assistant",
    content: null,
    _providerState: {
      version: 1,
      provider: "openaicodex",
      api: "openai-codex-responses",
      protocol: "openai-codex",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      model: "gpt-5.4",
      kind: "openai_responses_reasoning",
      reasoningItems: [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }],
    },
  };
  const saved = serializeConversation([system(), user("hello"), stateOnlyAssistant, user("continue")]);
  const restored = deserializeConversationWithRepair(saved, "system prompt").messages;
  const restoredStateOnly = restored.find(msg => msg.role === "assistant" && msg._providerState?.kind === "openai_responses_reasoning");
  assert.ok(restoredStateOnly, "assistant provider state without visible text should survive codec");
  assert.equal(restoredStateOnly.content, null);
  assert.equal(restoredStateOnly._providerState.reasoningItems[0].encrypted_content, "opaque");
}

function assertContextCapsulesPersistButStayHidden() {
  const capsule = {
    role: "user",
    _origin: "context_capsule",
    _kind: "context_capsule",
    _contextCapsule: { reason: "prompt", createdAt: "2026-06-23 12:00:00", signature: "sig" },
    content: [{ type: "text", text: "[运行上下文 capsule]\n隐藏上下文" }],
  };
  const contextEvent = {
    role: "user",
    _origin: "context_event",
    _kind: "context_event",
    _contextEvent: { kind: "site_skill_update", toolName: "navigate", createdAt: "2026-06-23 12:00:01", added: ["x"], removed: [] },
    content: [{ type: "text", text: "[运行上下文事件]\n新增: x" }],
  };
  const realUser = { role: "user", _origin: "user", clientMessageId: "u1", content: "真实请求" };
  const saved = serializeConversation([system(), capsule, realUser, assistant("ok"), contextEvent]);
  const restored = deserializeConversationWithRepair(saved, "system prompt").messages;

  assert.ok(restored.some(msg => msg._origin === "context_capsule"), "context capsule should survive codec");
  assert.ok(restored.some(msg => msg._origin === "context_event"), "context event should survive codec");
  assert.equal(findEditableUserMessageIndex(restored, ""), restored.findIndex(msg => msg.clientMessageId === "u1"));

  const transcript = transcriptFromConversation(saved);
  assert.equal(transcript.some(entry => entry.type === "user" && /隐藏上下文|运行上下文/.test(entry.text || "")), false);
  assert.deepEqual(transcript.filter(entry => entry.type === "user").map(entry => entry.text), ["真实请求"]);
}

function assertUserImageTranscriptDoesNotExposeOmittedPlaceholder() {
  const imagePart = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } };
  const userMessage = user([{ type: "text", text: "这个图呢？" }, imagePart]);
  const saved = serializeConversation([system(), userMessage]);
  const transcript = transcriptFromConversation(saved);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].type, "user");
  assert.equal(transcript[0].text, "这个图呢？");
  assert.equal(transcript[0].images.length, 1);
  assert.equal(transcript[0].images[0].dataUrl, "data:image/png;base64,AAAA");

  const updated = updateTranscriptWithAgentEvent([], { type: "message_start", message: userMessage });
  assert.equal(updated.changed, true);
  assert.equal(updated.transcript[0].text, "这个图呢？");
  assert.equal(updated.transcript[0].images.length, 1);
}

function assertToolSchemasCountTowardBudget() {
  const tools = [
    { type: "function", function: { name: "save_file", parameters: { type: "object", properties: { content: { type: "string" } } } } },
  ];
  assert.ok(estimateToolSchemaTokens(tools) > 0, "tool schema estimate should account for non-message prompt overhead");
}

async function assertAgentUsesVerifiedUsageAnchor() {
  const agent = await createBudgetTestAgent("verified-usage-anchor", { contextWindow: 100000 });
  agent._runProfile.model.provider = "deepseek";
  agent._runProfile.model.id = "deepseek-v4-flash";
  agent._runProfile.model.endpoint = "https://example.test/v1";
  const tools = [largeToolSchema("read_page", 80)];
  const oldToolResult = tool("old page content".repeat(40));
  agent.messages = [system(), user("open page"), assistantTool("read_page"), oldToolResult];

  const prepared = agent._buildPreparedSendWindow(null, tools);
  const response = assistant("done", { total_tokens: 8000 });
  agent._stampAssistantUsageContext(response, prepared.sendBoundaryId, prepared.sendUsageContextFingerprint);
  const trailing = user("continue");
  agent.messages.push(response, trailing);

  const anchored = agent._estimateSendWindowContext(null, tools);
  assert.equal(anchored.source, "usage_anchor");
  assert.equal(anchored.tokens, 8000 + estimateTokens([trailing]));
  assert.equal(anchored.toolSchemaTokens, 0, "provider usage already includes the unchanged tool schemas");

  oldToolResult.trim = true;
  const invalidated = agent._estimateSendWindowContext(null, tools);
  assert.equal(invalidated.source, "estimate", "changing an older request prefix must invalidate the usage anchor");
  assert.ok(invalidated.toolSchemaTokens > 0);
}

function assertCompactionPrefersCompleteRoundsBeforeToolBoundaries() {
  const messages = [
    system(),
    user("first task"),
    assistantTool("use_tab"),
    tool("tab opened"),
    assistant("first answer", { total_tokens: 24000 }),
    user("second task"),
    assistantTool("read_article"),
    tool("article result"),
  ];
  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((msg, index) => index === 0 ? 0 : estimateTokens([msg])),
    inputTokens: 30000,
    contextWindow: 32000,
    reserveTokens: 16000,
    maxKeepTokens: 40000,
  });

  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.reason, undefined);
  assert.equal(plan.cutIndex, 5, "complete user rounds should be preferred over assistant tool-chain boundaries");
  assert.deepEqual(plan.sourceMessages.map(messageLabel), ["first task", "", "tab opened", "first answer"]);
  assert.deepEqual(plan.retainedMessages.map(messageLabel), ["second task", "", "article result"]);

  const oneRound = [
    system(),
    user("long tool task"),
    assistantTool("use_tab"),
    tool("tab opened"),
    assistantTool("read_article"),
    tool("article result"),
  ];
  assert.equal(findFallbackCompactionCutIndex(oneRound, 1), 4, "single-round tool chains can compact early tool history");

  const noUsefulBoundary = [system(), user("hello"), assistant("world")];
  assert.equal(findFallbackCompactionCutIndex(noUsefulBoundary, 1), -1, "simple single-turn chats should not compact into a loop");
}

function assertContextCapsulePrefixDoesNotCauseNoopCompact() {
  const capsule = {
    role: "user",
    _origin: "context_capsule",
    _kind: "context_capsule",
    content: [{ type: "text", text: "[运行上下文 capsule]\n可见标签页和定位信息" }],
  };
  const messages = [
    system(),
    capsule,
    user("生成 Hacker News Skill"),
    assistantTool("read_item"),
    tool("story result ".repeat(10000)),
    assistantTool("read_user"),
    tool("user result ".repeat(10000)),
  ];
  const plan = buildCompactionPlan({
    messages,
    messageTokens: [0, 300, 1000, 500, 180000, 500, 70000],
    inputTokens: 256700,
    contextWindow: 262000,
    reserveTokens: 16000,
    maxKeepTokens: 40000,
  });

  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.reason, "closed_tool_chain");
  assert.equal(plan.cutIndex, messages.length, "a context-only prefix must not produce a no-op compact before the first real run");
  assert.equal(messageLabel(plan.sourceMessages[0]), "生成 Hacker News Skill");
  assert.equal(plan.sourceMessages.some(msg => msg.role === "tool" && String(msg.content).startsWith("story result")), true);
  assert.equal(plan.retainedMessageCount, 0);
}

function assertHiddenContextDoesNotEnterCompactionInput() {
  const hiddenGoal = {
    role: "user",
    _origin: "context_capsule",
    _kind: "context_capsule",
    _contextCapsule: { reason: "goal_snapshot", createdAt: "2026-07-05 19:10:00", signature: "goal-v1" },
    content: [{ type: "text", text: "[当前目标追踪 capsule]\n旧 goal 状态不应进入 compact source" }],
  };
  const hiddenEvent = {
    role: "user",
    _origin: "context_event",
    _kind: "context_event",
    content: [{ type: "text", text: "隐藏站点 skill 更新不应进入 compact source" }],
  };
  const serialized = serializeMessagesForCompaction(
    [hiddenGoal, user("真实历史"), hiddenEvent, assistant("真实回答")],
    { currentGoal: "状态: 进行中\n目标: 最新 goal" },
  );

  assert.match(serialized, /\[Current goal state\]\n状态: 进行中\n目标: 最新 goal/);
  assert.match(serialized, /\[User\]: 真实历史/);
  assert.match(serialized, /\[Assistant\]: 真实回答/);
  assert.doesNotMatch(serialized, /旧 goal 状态|隐藏站点 skill/);

  const messages = [system(), hiddenGoal, user("真实历史"), assistant("真实回答"), hiddenEvent, user("尾部")];
  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((msg, index) => index === 0 ? 0 : estimateTokens([msg])),
    inputTokens: 30000,
    contextWindow: 32000,
    reserveTokens: 16000,
    maxKeepTokens: 4000,
  });
  assert.equal(plan.shouldCompact, true);
  assert.deepEqual(plan.sourceMessages.map(messageLabel), ["真实历史", "真实回答"]);
}

function assertClosedToolChainCanCompactWithoutRetainedTail() {
  const messages = [
    system(),
    user("曲院风荷怎么停车"),
    assistantTool("use_tab"),
    tool("已打开搜索结果页"),
  ];
  const plan = buildCompactionPlan({
    messages,
    messageTokens: messages.map((msg, index) => index === 0 ? 0 : estimateTokens([msg])),
    inputTokens: 27277,
    contextWindow: 32000,
    reserveTokens: 16000,
    maxKeepTokens: 40000,
  });

  assert.equal(plan.shouldCompact, true);
  assert.equal(plan.reason, "closed_tool_chain");
  assert.equal(plan.cutIndex, messages.length, "a completed tool chain can be summarized into a boundary at the tail");
  assert.equal(plan.retainedMessageCount, 0);
  assert.deepEqual(plan.sourceMessages.map(messageLabel), ["曲院风荷怎么停车", "", "已打开搜索结果页"]);
}

function assertCompactionPlansHaveUsefulPostconditions() {
  const cases = [
    {
      name: "multi-round",
      messages: [system(), user("r1"), assistant("a1"), user("r2"), assistant("a2"), user("r3"), assistant("a3")],
      tokens: [0, 1000, 1000, 1000, 1000, 1000, 1000],
      inputTokens: 19000,
      contextWindow: 22000,
      reserveTokens: 4000,
      maxKeepTokens: 3000,
    },
    {
      name: "context-prefix-single-tool-chain",
      messages: [
        system(),
        contextCapsule("隐藏上下文"),
        user("生成站点 skill"),
        assistantTool("read_page"),
        tool("page ".repeat(2000)),
        assistantTool("read_more"),
        tool("more ".repeat(2000)),
      ],
      tokens: [0, 300, 700, 300, 12000, 300, 12000],
      inputTokens: 26000,
      contextWindow: 32000,
      reserveTokens: 8000,
      maxKeepTokens: 5000,
    },
    {
      name: "closed-tool-chain",
      messages: [system(), user("查页面"), assistantTool("use_tab"), tool("opened")],
      tokens: [0, 600, 300, 22000],
      inputTokens: 24000,
      contextWindow: 32000,
      reserveTokens: 8000,
      maxKeepTokens: 5000,
    },
  ];

  for (const item of cases) {
    const plan = buildCompactionPlan({
      messages: item.messages,
      messageTokens: item.tokens,
      inputTokens: item.inputTokens,
      contextWindow: item.contextWindow,
      reserveTokens: item.reserveTokens,
      maxKeepTokens: item.maxKeepTokens,
    });
    assert.equal(plan.shouldCompact, true, `${item.name} should compact`);
    assert.ok(plan.sourceMessages.some(isUsefulCompactionSource), `${item.name} should not compact hidden context only`);
    assert.ok(
      plan.retainedTokens <= plan.keepBudget || plan.retainedTokens + 1200 < plan.threshold,
      `${item.name} should have a useful after-compact estimate`,
    );
    assert.ok(plan.cutIndex > plan.minIndex, `${item.name} should cut a non-empty source segment`);
  }

  const noOp = buildCompactionPlan({
    messages: [system(), contextCapsule("only hidden"), user("hello"), assistant("world")],
    messageTokens: [0, 300, 500, 500],
    inputTokens: 26000,
    contextWindow: 32000,
    reserveTokens: 8000,
    maxKeepTokens: 5000,
  });
  assert.equal(noOp.shouldCompact, false, "planner should reject compacting hidden context plus a simple current turn");
}

function assertUsageBoundaryPreventsStaleAnchorAfterCompact() {
  const compact = createCompactMessage({
    compactId: "compact_new_epoch",
    summary: "压缩摘要",
    plan: { sourceMessageCount: 3, retainedMessageCount: 2 },
    contextWindow: 32000,
  });
  const retainedOldAssistant = assistant("保留的旧回答", { total_tokens: 30000 });
  const messages = [system(), compact, retainedOldAssistant, user("继续")];
  const estimate = estimateContextTokens(messages, { boundaryId: "compact_new_epoch" });

  assert.equal(estimate.source, "estimate", "old provider usage must not anchor a new compact epoch");
  assert.equal(estimate.usageTokens, 0);

  retainedOldAssistant._usageContextBoundaryId = "compact_new_epoch";
  retainedOldAssistant._usageContextFingerprint = estimateContextTokens(messages.slice(0, 2)).requestFingerprint;
  const sameBoundary = estimateContextTokens(messages, { boundaryId: "compact_new_epoch" });
  assert.equal(sameBoundary.source, "usage_anchor", "same-boundary provider usage may anchor the active window");
}

function assertAgentHasCompactionBarrier() {
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  assert.match(agent, /_compactionPromise\s*=\s*null/, "agent should keep a compact promise barrier");
  assert.match(agent, /await this\._compactionPromise\.catch/, "LLM sends should wait for an active compact barrier");
  assert.match(agent, /compact llm start/, "compact summarization should trace the non-streaming LLM request start");
  assert.match(agent, /compact llm done/, "compact summarization should trace the non-streaming LLM request completion");
  assert.match(agent, /usage: usage \|\| summaryMsg\._usage/, "compaction should keep the summarizer call's provider usage");
  assert.match(agent, /_stampAssistantUsageContext\(stream\.state\.message,\s*sendBoundaryId,\s*sendUsageContextFingerprint\)/, "streamed assistant usage should be stamped with its request context");
  assert.match(agent, /_stampAssistantUsageContext\(alignedMessage,\s*sendBoundaryId,\s*sendUsageContextFingerprint\)/, "fallback assistant usage should be stamped with its request context");
  assert.match(agent, /_prepareSendWindowOrBlock/, "LLM sends should be gated by a single prepared send-window budget check");
  assert.match(agent, /_service\("getRuntimeConfigVersion"\)/, "agent should detect runtime config changes between LLM calls");
  assert.match(agent, /_ensureFreshRunProfile\(\)/, "agent should refresh run profile before each LLM call");
}

function assertCompactionPromptIsAnchoredAfterHistory() {
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  assert.match(COMPACT_SYSTEM_PROMPT, /不要继续对话/);
  assert.match(COMPACT_SYSTEM_PROMPT, /不要实际调用或模拟工具/);
  assert.match(COMPACT_USER_PROMPT, /严格使用以下格式/);
  for (const heading of ["目标", "约束与偏好", "进展", "关键决策", "下一步", "关键上下文"]) {
    assert.match(COMPACT_USER_PROMPT, new RegExp(`## ${heading}`));
  }
  assert.match(COMPACT_USER_PROMPT, /不要把计划、尝试或待执行的工具调用写成已完成/);
  assert.equal(buildCompactUserPrompt(""), COMPACT_USER_PROMPT, "automatic compaction should keep the established prompt unchanged");
  const instructedPrompt = buildCompactUserPrompt("重点保留数据库设计和未完成事项");
  assert.match(instructedPrompt, /仅影响信息取舍与强调重点/);
  assert.match(instructedPrompt, /重点保留数据库设计和未完成事项/);
  assert.match(
    agent,
    /content:\s*`<conversation>\\n\$\{serialized\}\\n<\/conversation>\\n\\n\$\{buildCompactUserPrompt\(instruction, this\._runLanguage\)\}`/,
    "the compact instruction must remain after the serialized history",
  );
}

async function assertAgentSendBudgetGateTransitionMatrix() {
  const within = await createBudgetTestAgent("budget-within", { contextWindow: 20000 });
  within.messages = [system(), user("hello")];
  let compactCalls = 0;
  within._compactIfNeeded = async () => {
    compactCalls++;
    throw new Error("compact should not run when the window already fits");
  };
  let prepared = await within._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, "within_budget");
  assert.equal(compactCalls, 0, "within-budget sends must not compact");
  assert.ok(prepared.contextEstimate.tokens < prepared.contextEstimate.threshold);
  assert.equal(within._isWithinInputBudget({ tokens: 999, threshold: 1000 }), true, "budget predicate is strict below threshold");
  assert.equal(within._isWithinInputBudget({ tokens: 1000, threshold: 1000 }), false, "equal-to-threshold input should compact or block");

  const noSegment = await createBudgetTestAgent("budget-no-segment", { contextWindow: 17000 });
  noSegment.messages = [system(), user("x".repeat(2000))];
  prepared = await noSegment._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.status, "blocked_no_compactable_segment");
  assert.ok(prepared.contextEstimate.tokens >= prepared.contextEstimate.threshold);

  const toolOnlyOverflow = await createBudgetTestAgent("budget-tool-schema", { contextWindow: 17000 });
  toolOnlyOverflow.messages = [system(), user("short")];
  prepared = await toolOnlyOverflow._prepareSendWindowOrBlock(new AbortController().signal, {
    toolSchemas: [largeToolSchema("large_tool_schema", 4000)],
    phase: "test",
  });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.status, "blocked_no_compactable_segment");
  assert.ok(prepared.contextEstimate.toolSchemaTokens > prepared.contextEstimate.messageTokens);
  assert.ok(prepared.contextEstimate.tokens >= prepared.contextEstimate.threshold);

  const failed = await createBudgetTestAgent("budget-failed", { contextWindow: 17000 });
  failed.messages = [system(), user("x".repeat(2000))];
  failed._compactIfNeeded = async (_signal, dynamicContext, toolSchemas) => ({
    compacted: false,
    failed: true,
    error: new Error("boom"),
    contextEstimate: failed._estimateSendWindowContext(dynamicContext, toolSchemas),
    plan: { shouldCompact: true },
  });
  prepared = await failed._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.status, "blocked_compact_failed");

  const generic = await createBudgetTestAgent("budget-generic-over", { contextWindow: 17000 });
  generic.messages = [system(), user("x".repeat(2000))];
  generic._compactIfNeeded = async (_signal, dynamicContext, toolSchemas) => ({
    compacted: false,
    contextEstimate: generic._estimateSendWindowContext(dynamicContext, toolSchemas),
    plan: { shouldCompact: true, reason: "unsupported_cut" },
  });
  prepared = await generic._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.status, "blocked_over_budget");

  const compacted = await createBudgetTestAgent("budget-compacted", { contextWindow: 20000 });
  compacted.messages = [
    system(),
    user("old " + "x".repeat(4000)),
    assistant("old answer " + "y".repeat(4000)),
    user("tail"),
  ];
  compacted._compactIfNeeded = async () => {
    compacted.messages.splice(1, 2, createCompactMessage({
      compactId: "compact_gate_ok",
      summary: "old round summary",
      plan: { sourceMessageCount: 2, retainedMessageCount: 1, minIndex: 1, cutIndex: 3 },
      contextWindow: 20000,
    }));
    return { compacted: true, plan: { shouldCompact: true } };
  };
  prepared = await compacted._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status, "compacted_within_budget");
  assert.ok(prepared.contextEstimate.tokens < prepared.contextEstimate.threshold);

  const stillOver = await createBudgetTestAgent("budget-still-over", { contextWindow: 20000 });
  stillOver.messages = [
    system(),
    user("old " + "x".repeat(4000)),
    assistant("old answer " + "y".repeat(4000)),
    user("tail " + "z".repeat(8000)),
  ];
  stillOver._compactIfNeeded = async () => {
    stillOver.messages.splice(1, 2, createCompactMessage({
      compactId: "compact_gate_large_tail",
      summary: "old round summary",
      plan: { sourceMessageCount: 2, retainedMessageCount: 1, minIndex: 1, cutIndex: 3 },
      contextWindow: 20000,
    }));
    return { compacted: true, plan: { shouldCompact: true } };
  };
  prepared = await stillOver._prepareSendWindowOrBlock(new AbortController().signal, { toolSchemas: [], phase: "test" });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.status, "blocked_still_over_budget");
  assert.ok(prepared.contextEstimate.tokens >= prepared.contextEstimate.threshold);
}

async function assertExplicitCompactionWorksBelowLocalThreshold() {
  const agent = await createBudgetTestAgent("provider-overflow-force", { contextWindow: 100000 });
  const toolSchemas = [largeToolSchema("read_page", 80)];
  let toolSchemaReads = 0;
  agent._tools = { getSchemas: () => { toolSchemaReads += 1; return toolSchemas; } };
  agent._ensureFreshRunProfile = async () => agent._runProfile;
  agent.messages = [
    system(),
    user("old one " + "x".repeat(4000)),
    assistant("old answer one " + "y".repeat(4000)),
    user("old two " + "a".repeat(4000)),
  ];
  const prepared = agent._buildPreparedSendWindow(null, toolSchemas);
  const anchored = assistant("old answer two " + "b".repeat(4000), { total_tokens: 32000 });
  agent._stampAssistantUsageContext(anchored, prepared.sendBoundaryId, prepared.sendUsageContextFingerprint);
  agent.messages.push(anchored, user("current turn"));
  const anchoredEstimate = agent._estimateSendWindowContext(null, toolSchemas);
  assert.equal(anchoredEstimate.source, "usage_anchor");
  assert.ok(
    anchoredEstimate.tokens < agent._compactThreshold(),
    "the local model profile should consider this conversation below its configured threshold",
  );
  let compactRequest = null;
  let compactOptions = null;
  agent._llm = {
    async chat(messages, _tools, _signal, options) {
      compactRequest = messages;
      compactOptions = options;
      assert.match(options.spanId, /:compact:/);
      return { message: { role: "assistant", content: "provider-sized summary" }, usage: { total_tokens: 100 } };
    },
    async *chatStream() {},
  };
  let dynamicContextLoads = 0;
  agent._ensureDynamicContextSnapshot = async () => {
    dynamicContextLoads += 1;
    return {};
  };
  const events = [];
  const compactChecks = [];
  agent._traceContextEstimate = (label, estimate) => {
    if (label === "compact_check") compactChecks.push(estimate);
  };
  agent.subscribe(event => events.push(event));

  const result = await agent.compactContext(new AbortController().signal, {
    trigger: "manual",
    instruction: "重点保留数据库设计和未完成事项",
  });
  assert.equal(result.compacted, true);
  assert.equal(toolSchemaReads, 1, "manual compact should resolve the active tool schemas when none are supplied");
  assert.equal(compactChecks[0]?.source, "usage_anchor", "manual compact should verify usage against the same tool fingerprint as a normal send");
  assert.equal(dynamicContextLoads, 1, "an explicit compact should resolve its own current context when invoked outside the send path");
  assert.equal(result.plan.trigger, "manual");
  assert.deepEqual(
    result.plan.retainedMessages.map(messageLabel),
    ["current turn"],
    "the Agent manual path should retain the latest round rather than the automatic token-budget suffix",
  );
  assert.match(compactRequest[1].content, /重点保留数据库设计和未完成事项/);
  assert.match(compactRequest[1].content, /仅影响信息取舍与强调重点/);
  assert.ok(compactOptions.spanId, "compaction retains its request identity");
  assert.ok(agent.messages.some(message => message._kind === "compaction"));
  assert.deepEqual(
    events.filter(event => event.type.startsWith("context_compaction_")).map(event => [event.type, event.trigger]),
    [
      ["context_compaction_start", "manual"],
      ["context_compaction_end", "manual"],
    ],
  );
}

async function assertSequentialCompactionRollsUpPriorCheckpoint() {
  const agent = await createBudgetTestAgent("sequential-compact", { contextWindow: 100000 });
  const earlyDocument = {
    sessionId: "sequential-compact",
    messageId: "message-doc",
    attachmentId: "attachment-doc",
    fileId: "file-doc",
    docModelId: "model-doc",
    filename: "requirements.xlsx",
    format: "xlsx",
  };
  agent.messages = [
    system(),
    { ...user("early requirement " + "x".repeat(4000)), documents: [earlyDocument] },
    assistant("early decision " + "y".repeat(4000)),
    user("first tail"),
  ];
  agent._ensureDynamicContextSnapshot = async () => ({});
  agent._persistConversation = async () => {};
  const requests = [];
  agent._llm = {
    async chat(messages) {
      requests.push(messages[1].content);
      return {
        message: {
          role: "assistant",
          content: requests.length === 1 ? "checkpoint keeps early requirement" : "checkpoint still keeps early requirement",
        },
      };
    },
    async *chatStream() {},
  };

  assert.equal((await agent.compactContext(new AbortController().signal)).compacted, true);
  let documentCapsules = agent._buildSendMessages()
    .filter(message => String(message.content || "").startsWith("[文档附件 capsule]"));
  assert.equal(documentCapsules.length, 1, "the compacted send window should carry one document capsule");
  assert.match(documentCapsules[0].content, /docModelId=model-doc/);
  assert.equal(
    agent.messages.filter(message => message._kind === "context_capsule" && message._contextCapsule?.reason === "document_attachment").length,
    1,
    "compaction should persist one durable document capsule after its checkpoint",
  );
  agent.messages.push(
    user("new requirement " + "a".repeat(4000)),
    assistant("new decision " + "b".repeat(4000)),
    user("second tail"),
  );
  assert.equal((await agent.compactContext(new AbortController().signal)).compacted, true);
  assert.match(requests[1], /\[Previous checkpoint\]: checkpoint keeps early requirement/);
  const sendMessages = agent._buildSendMessages();
  assert.match(sendMessages.map(message => message.content || "").join("\n"), /still keeps early requirement/);
  documentCapsules = sendMessages
    .filter(message => String(message.content || "").startsWith("[文档附件 capsule]"));
  assert.equal(documentCapsules.length, 1, "a later compact should expose only its current checkpoint capsule");
  assert.match(documentCapsules[0].content, /docModelId=model-doc/);
}

async function assertCompactIdentitySurvivesAgentRecreation() {
  const sessionId = "compact-id-recreation";
  const events = [];
  for (let index = 0; index < 2; index += 1) {
    const agent = await createBudgetTestAgent(sessionId, { contextWindow: 100000 });
    agent.messages = [
      system(),
      user("old one " + "x".repeat(4000)),
      assistant("old answer one " + "y".repeat(4000)),
      user("old two " + "a".repeat(4000)),
      assistant("old answer two " + "b".repeat(4000)),
      user("current turn"),
    ];
    agent._ensureDynamicContextSnapshot = async () => ({});
    agent._persistConversation = async () => {};
    agent._llm = {
      async chat() {
        return { message: { role: "assistant", content: `summary ${index + 1}` } };
      },
      async *chatStream() {},
    };
    agent.subscribe(event => {
      if (event.type.startsWith("context_compaction_")) events.push({ ...event, sessionId });
    });
    const result = await agent.compactContext(new AbortController().signal, { trigger: "manual" });
    assert.equal(result.compacted, true);
  }

  const starts = events.filter(event => event.type === "context_compaction_start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].compactId, starts[1].compactId, "Agent recreation must not reuse a compact identity");

  const state = new SessionState();
  for (const event of events) {
    assert.equal(state.applyEvent(event).accepted, true, "each recreated Agent compact event must retain its own causal scope");
  }
  const compactEntries = state.getTranscript(sessionId).filter(entry => entry.type === "compact");
  assert.equal(compactEntries.length, 2, "a later compact must not overwrite the earlier card after Agent recreation");
  assert.deepEqual(compactEntries.map(entry => entry.summary), ["summary 1", "summary 2"]);
}

async function assertExplicitCompactionCanBeAborted() {
  const agent = await createBudgetTestAgent("manual-compact-abort", { contextWindow: 100000 });
  agent.messages = [
    system(),
    user("old one " + "x".repeat(4000)),
    assistant("old answer one " + "y".repeat(4000)),
    user("old two " + "a".repeat(4000)),
    assistant("old answer two " + "b".repeat(4000)),
    user("current turn"),
  ];
  agent._ensureDynamicContextSnapshot = async () => ({});
  let receivedSignal = null;
  agent._llm = {
    async chat(_messages, _tools, signal) {
      receivedSignal = signal;
      await new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
      return { message: { role: "assistant", content: "unreachable" } };
    },
    async *chatStream() {},
  };

  const compactPromise = agent.compactContext(null, { trigger: "slash_command" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(receivedSignal, "standalone compact should own an abort signal");
  assert.ok(agent._abortCtrl, "standalone compact should expose its controller to Agent.abort");
  agent.abort();
  assert.equal(receivedSignal.aborted, true);
  const result = await compactPromise;
  assert.equal(result.failed, true);
  assert.equal(agent._abortCtrl, null, "standalone compact should release its owned controller");
}

async function assertStandaloneCompactionBlocksFollowUpRuns() {
  const agent = await createBudgetTestAgent("manual-compact-follow-up", { contextWindow: 100000 });
  agent.messages = [
    system(),
    user("old one " + "x".repeat(4000)),
    assistant("old answer one " + "y".repeat(4000)),
    user("old two " + "a".repeat(4000)),
    assistant("old answer two " + "b".repeat(4000)),
    user("current turn"),
  ];
  agent._ensureDynamicContextSnapshot = async () => ({});
  agent._persistConversation = async () => {};
  let resolveSummary;
  let notifySummaryStarted;
  const summaryStarted = new Promise(resolve => { notifySummaryStarted = resolve; });
  agent._llm = {
    async chat() {
      notifySummaryStarted();
      return new Promise(resolve => { resolveSummary = resolve; });
    },
    async *chatStream() {},
  };
  let followUpRuns = 0;
  agent._runWithLifecycle = async (pendingMessages = []) => {
    followUpRuns += 1;
    assert.deepEqual(pendingMessages.map(messageLabel), ["continue after compact"]);
  };

  const compactPromise = agent.compactContext(null, { trigger: "slash_command" });
  await summaryStarted;
  agent.followUp("continue after compact");
  await delay(220);
  assert.equal(followUpRuns, 0, "a queued follow-up must not overlap standalone compaction");

  resolveSummary({ message: { role: "assistant", content: "checkpoint summary" } });
  assert.equal((await compactPromise).compacted, true);
  await delay(220);
  assert.equal(followUpRuns, 1, "the queued follow-up should resume after compaction settles");
}

async function assertFailedCompactionRollsBackStagedMessages() {
  const agent = await createBudgetTestAgent("manual-compact-persist-failure", { contextWindow: 100000 });
  agent.messages = [
    system(),
    user("old one " + "x".repeat(4000)),
    assistant("old answer one " + "y".repeat(4000)),
    user("old two " + "a".repeat(4000)),
    assistant("old answer two " + "b".repeat(4000)),
    user("current turn"),
  ];
  const before = agent.messages.slice();
  agent._ensureDynamicContextSnapshot = async () => ({});
  agent._persistConversation = async () => {
    throw Object.assign(new Error("repository unavailable"), { code: "STORE_UNAVAILABLE" });
  };
  agent._llm = {
    async chat() {
      return { message: { role: "assistant", content: "must not commit" } };
    },
    async *chatStream() {},
  };

  const result = await agent.compactContext(null, { trigger: "slash_command" });
  assert.equal(result.failed, true);
  assert.deepEqual(agent.messages, before, "failed persistence must restore the pre-compaction message array");
  assert.equal(agent.messages.some(message => message._kind === "compaction"), false);
  assert.equal(agent.messages.some(message => message._contextCapsule?.reason === "document_attachment"), false);
}

function assertAgentAllowsDisablingOldToolResultTrim() {
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  assert.doesNotMatch(agent, /FULL_CONTEXT_ROUNDS|fullFromRound/, "send windows should not move a round-based pruning boundary on every request");
  assert.doesNotMatch(agent, /TOOL_RESULT_MAX_PROTECT_TOKENS/, "tool-result protection should stay proportional instead of using an absolute cap");
  assert.match(agent, /Math\.floor\(this\._compactThreshold\(\) \* TOOL_RESULT_PROTECT_RATIO\)/, "tool-result protection should use 20% of the usable context");
  assert.match(agent, /await this\._pruneOldToolResultsIfNeeded\(\)/, "stable pruning should run once when an agent run ends");
  assert.match(agent, /_trimOldToolResultsEnabled\(runProfile = this\._runProfile\)/, "agent should expose a dedicated trim policy helper");
}

async function assertAgentLimitsImageMessagesWithinOneRound() {
  const agent = await createBudgetTestAgent("image-message-limit-single-round", { imageInput: true });
  agent._persistConversation = async () => { assert.fail("request projection must not write history"); };
  const imageMessages = Array.from({ length: 12 }, (_, index) => {
    const count = index === 0 ? 2 : index === 11 ? 3 : 1;
    return userWithImages(`frame ${index + 1}`, count, "tool_image");
  });
  agent.messages = [system(), user("inspect images in one round"), ...imageMessages.flatMap((message, index) => [
    assistantTool(`read_${index}`), toolResult(`read_${index}`, `metadata ${index}`), message,
    contextCapsule(`context ${index}`), { ...user(`text-only ${index}`), _origin: "context_event" },
  ])];
  const before = structuredClone(agent.messages);
  const send = agent._buildSendMessages();
  const sentImages = send.filter(message => countImages([message]) > 0);
  assert.deepEqual(sentImages.map(messageText), imageMessages.slice(-8).map(messageText), "only the latest eight image-bearing messages retain pixels");
  assert.equal(countImages(send), 10, "multiple images in one message consume one message slot");
  for (let index = 0; index < imageMessages.length; index++) {
    const projected = send.find(message => messageText(message).split("\n")[0] === `frame ${index + 1}`);
    assert.ok(projected, "image omission must retain the message and its explanatory text");
    if (index < 4) assert.equal(messageText(projected), `frame ${index + 1}\n[image omitted for context saving] x${index === 0 ? 2 : 1}`);
    const tool = send.find(message => message.tool_call_id === `call_read_${index}`);
    assert.equal(tool.content, `metadata ${index}`, "image count pruning must not remove tool metadata");
    assert.ok(send.some(message => message.tool_calls?.some(call => call.id === tool.tool_call_id)), "tool call/result identity must remain paired");
  }
  assert.deepEqual(agent._buildContextEstimateMessages(), send, "token estimates must use the same image projection as requests");
  assert.deepEqual(agent.messages, before, "projection must preserve original image bytes and trim markers");
  const exported = serializeConversation(agent.messages);
  assert.equal(countImages(exported.entries.map(entry => entry.message)), 15, "export retains every original image");
  const restored = deserializeConversationWithRepair(exported, "system").messages;
  assert.equal(countImages(restored), 15, "reload must preserve original image history");

  agent._runProfile.model.trimOldToolResults = false;
  assert.equal(countImages(agent._buildSendMessages()), 15, "disabling pruning reveals stored images without reloading them");
  agent._runProfile.features.imageInput = false;
  assert.equal(countImages(agent._buildSendMessages()), 0, "text-only model projection still suppresses all images");
}

async function assertImageMessageLimitBoundaries() {
  const agent = await createBudgetTestAgent("image-message-limit-boundaries", { imageInput: true });
  const frames = Array.from({ length: 10 }, (_, index) => userWithImages(`image ${index}`, 1, "tool_image"));
  for (const count of [0, 1, 7, 8, 9, 10]) {
    agent.messages = [system(), user("one round"), ...frames.slice(0, count)];
    assert.deepEqual(agent._buildSendMessages().filter(message => countImages([message])).map(messageText),
      frames.slice(0, count).slice(-8).map(messageText), `the fixed eight-message window handles ${count} image messages`);
  }

  const old = userWithImages("older", 2);
  const roundPruned = { ...userWithImages("round-pruned", 3), trim: true };
  const recent = Array.from({ length: 7 }, (_, index) => userWithImages(`recent ${index}`, 1));
  agent.messages = [system(), old, roundPruned, ...recent];
  assert.equal(countImages(agent._buildSendMessages()), 7, "already round-pruned messages still occupy their raw recency position");
  agent._runProfile.model.trimOldToolResults = false;
  assert.equal(countImages(agent._buildSendMessages()), 12, "the existing pruning switch disables both policies");
  assert.equal(roundPruned.trim, true, "disabling projection does not rewrite stored markers");

  agent._runProfile.model.trimOldToolResults = true;
  const compact = createCompactMessage({ compactId: "image-boundary", summary: "earlier images summarized", plan: { sourceMessageCount: 10, retainedMessageCount: 9 } });
  const retained = Array.from({ length: 9 }, (_, index) => userWithImages(`post-compact ${index}`, 1));
  agent.messages = [system(), ...frames, compact, ...retained];
  const prepared = agent._buildPreparedSendWindow();
  assert.deepEqual(prepared.sendMessages.filter(message => countImages([message])).map(messageText), retained.slice(-8).map(messageText));

  const remote = user([{ type: "image_url", image_url: { url: "https://fixture.test/image.png" } }]);
  agent.messages = [system(), ...frames.slice(0, 8), remote];
  const remoteWindow = agent._buildPreparedSendWindow();
  assert.equal(countImages(remoteWindow.sendMessages), 8, "remote image blocks count before the gateway validates their source");
  assert.equal(remoteWindow.sendMessages.at(-1).content[0].image_url.url, "https://fixture.test/image.png");
}

async function assertImageMessageLimitInvalidatesUsageAnchor() {
  const agent = await createBudgetTestAgent("image-message-limit-usage", { imageInput: true });
  const tools = [largeToolSchema("read_image", 80)];
  agent.messages = [system(), ...Array.from({ length: 8 }, (_, index) => userWithImages(`frame ${index}`, 1))];
  const prepared = agent._buildPreparedSendWindow(null, tools);
  const response = assistant("observed", { total_tokens: 8000 });
  agent._stampAssistantUsageContext(response, prepared.sendBoundaryId, prepared.sendUsageContextFingerprint);
  agent.messages.push(response, user("continue"));
  assert.equal(agent._estimateSendWindowContext(null, tools).source, "usage_anchor");
  agent.messages.push(userWithImages("ninth", 1, "tool_image"));
  const next = agent._buildPreparedSendWindow(null, tools);
  assert.equal(next.contextEstimate.source, "estimate", "evicting an older image changes the request prefix and invalidates its usage anchor");
  assert.notEqual(next.sendUsageContextFingerprint, prepared.sendUsageContextFingerprint);
  assert.equal(next.contextEstimate.tokens, estimateTokens(next.sendMessages) + estimateToolSchemaTokens(tools));
  assert.equal(countImages(next.sendMessages), 8);
  assert.equal(countImages(agent.messages), 9);
}

function userWithImages(text, count, origin = "user") {
  return {
    ...userWithImage(text), _origin: origin,
    content: [{ type: "text", text }, ...Array.from({ length: count }, (_, index) => ({
      type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(`${text}:${index}`).toString("base64")}`, detail: "auto" },
    }))],
  };
}

function countImages(messages) {
  return messages.reduce((count, message) => count + (Array.isArray(message?.content) ? message.content.filter(part => part?.type === "image_url").length : 0), 0);
}

async function assertAgentUsesStableToolResultPruning() {
  const agent = await createBudgetTestAgent("stable-tool-prune", {
    contextWindow: 26000,
    imageInput: true,
  });
  let persistCount = 0;
  agent._persistConversation = async () => { persistCount++; };
  agent._estimateStoredMessageTokens = msg => Number(msg?._testTokens) || 0;

  const oldOne = toolResult("old_one", "old one result", 600);
  const oldTwo = toolResult("old_two", "old two result", 600);
  const skill = toolResult("load_skill", "important skill instructions", 5000);
  const kept = toolResult("kept", "newest eligible result", 1500);
  const recent = toolResult("recent", "recent protected result", 5000);
  agent.messages = [
    system(),
    user("r1"),
    assistantTool("old_one"),
    oldOne,
    user("r2"),
    assistantTool("load_skill"),
    skill,
    assistantTool("old_two"),
    oldTwo,
    userWithImage("r3"),
    assistantTool("kept"),
    kept,
    userWithImage("r4"),
    assistantTool("recent"),
    recent,
    user("r5"),
    assistant("done"),
  ];

  assert.equal(await agent._pruneOldToolResultsIfNeeded(), true);
  assert.equal(persistCount, 1, "a pruning batch should persist once");
  assert.equal(oldOne.trim, true);
  assert.equal(oldTwo.trim, true);
  assert.equal(kept.trim, undefined, "the newest protected token budget should stay intact");
  assert.equal(skill.trim, undefined, "load_skill instructions must stay intact until compaction");
  assert.equal(recent.trim, undefined, "the latest two user rounds must stay intact");
  assert.equal(agent.messages.find(msg => messageText(msg) === "r3")?.trim, true, "older images should use the same stable marker");
  assert.equal(agent.messages.find(msg => messageText(msg) === "r4")?.trim, undefined, "the second-latest user round should remain intact");

  assert.equal(await agent._pruneOldToolResultsIfNeeded(), false, "stable markers should make the next pass a no-op");
  assert.equal(persistCount, 1, "a no-op pass must not rewrite storage");

  let send = agent._buildSendMessages();
  assert.equal(send.find(msg => msg.tool_call_id === oldOne.tool_call_id)?.content, "[tool result omitted for context saving]");
  const trimmedImage = send.find(msg => messageText(msg).startsWith("r3"));
  assert.ok(trimmedImage.content.every(part => part.type !== "image_url"));
  const recentImage = send.find(msg => messageText(msg) === "r4");
  assert.ok(recentImage.content.some(part => part.type === "image_url"));

  const saved = serializeConversation(agent.messages);
  const restored = deserializeConversationWithRepair(saved, "system").messages;
  assert.equal(restored.find(msg => msg.tool_call_id === oldOne.tool_call_id)?.trim, true, "trim markers should survive session reloads");
  const transcript = transcriptFromConversation(saved);
  assert.equal(transcript.find(entry => entry.type === "tool" && entry.name === "old_one")?.result, oldOne.content, "UI reconstruction should keep the original tool result");
  assert.equal(transcript.find(entry => entry.type === "user" && entry.text === "r3")?.images.length, 1, "UI reconstruction should keep original images");

  agent._runProfile.model.trimOldToolResults = false;
  send = agent._buildSendMessages();
  assert.equal(send.find(msg => msg.tool_call_id === oldOne.tool_call_id)?.content, oldOne.content, "disabling pruning should reveal stored tool content");
  assert.ok(send.find(msg => messageText(msg) === "r3").content.some(part => part.type === "image_url"));
  assert.equal(await agent._pruneOldToolResultsIfNeeded(), false);
  assert.equal(persistCount, 1);

  const belowBatch = await createBudgetTestAgent("stable-tool-prune-below-batch", { contextWindow: 26000 });
  let belowBatchPersists = 0;
  belowBatch._persistConversation = async () => { belowBatchPersists++; };
  belowBatch._estimateStoredMessageTokens = msg => Number(msg?._testTokens) || 0;
  const smallCandidate = toolResult("small_candidate", "small candidate", 600);
  const budgeted = toolResult("budgeted", "protected by token budget", 1500);
  belowBatch.messages = [
    system(),
    user("r1"), assistantTool("small_candidate"), smallCandidate,
    user("r2"), assistantTool("budgeted"), budgeted,
    user("r3"), assistant("a3"),
    user("r4"), assistant("a4"),
  ];
  assert.equal(await belowBatch._pruneOldToolResultsIfNeeded(), false, "sub-threshold savings should wait for a later batch");
  assert.equal(smallCandidate.trim, undefined);
  assert.equal(belowBatchPersists, 0);

  const largeContext = await createBudgetTestAgent("stable-tool-prune-large-context", { contextWindow: 316000 });
  largeContext._persistConversation = async () => {};
  largeContext._estimateStoredMessageTokens = msg => Number(msg?._testTokens) || 0;
  const olderLargeResult = toolResult("older_large", "older large result", 35000);
  const protectedLargeResult = toolResult("protected_large", "protected large result", 50000);
  largeContext.messages = [
    system(),
    user("r1"), assistantTool("older_large"), olderLargeResult,
    user("r2"), assistantTool("protected_large"), protectedLargeResult,
    user("r3"), assistant("a3"),
    user("r4"), assistant("a4"),
  ];
  assert.equal(await largeContext._pruneOldToolResultsIfNeeded(), true);
  assert.equal(olderLargeResult.trim, true, "results beyond the 20% budget should be pruned");
  assert.equal(protectedLargeResult.trim, undefined, "a 60K proportional budget should not be capped at 40K");
}

function assertAgentUsesContextCapsulesInsteadOfEphemeralDynamicTail() {
  const agent = stripTypeScriptTypes(readFileSync(join(root, "src/background/agent/agent.ts"), "utf8"));
  const sendWindow = extractClassMethod(agent, "_buildSendWindowMessages");
  assert.doesNotMatch(sendWindow, /_buildEphemeralDynamicContextMessage/, "send window should not append mutable dynamic context tail");
  assert.match(agent, /_buildContextCapsuleMessage/, "agent should create persistent context capsules");
  assert.equal(buildSiteSkillContextEventMessage([], [{ name: "site" }])._origin, "context_event", "site skill changes must use hidden context events");
}

function system() {
  return { role: "system", content: "system" };
}

function user(content) {
  return { role: "user", content };
}

function contextCapsule(text) {
  return {
    role: "user",
    _origin: "context_capsule",
    _kind: "context_capsule",
    content: [{ type: "text", text }],
  };
}

function assistant(content, usage = null, usageContextBoundaryId = "", usageContextFingerprint = "") {
  const out = usage ? { role: "assistant", content, _usage: usage } : { role: "assistant", content };
  if (usageContextBoundaryId) out._usageContextBoundaryId = usageContextBoundaryId;
  if (usageContextFingerprint) out._usageContextFingerprint = usageContextFingerprint;
  return out;
}

function assistantTool(name) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: "{}" } }],
  };
}

function tool(content) {
  return { role: "tool", tool_call_id: "call_tool", content };
}

function toolResult(name, content, tokens = 0) {
  return { role: "tool", tool_call_id: `call_${name}`, content, _testTokens: tokens };
}

function userWithImage(text) {
  return {
    role: "user",
    _origin: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
    ],
  };
}

function messageLabel(msg) {
  return String(msg.content || "").replace(/^\[之前的对话摘要\]\s*/u, "");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function messageText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (!Array.isArray(msg?.content)) return "";
  return msg.content
    .filter(part => part?.type === "text")
    .map(part => String(part.text || ""))
    .join("\n");
}

function isUsefulCompactionSource(msg) {
  if (!msg || msg._origin === "context_capsule" || msg._origin === "context_event") return false;
  return msg.role === "tool"
    || (msg.role === "assistant" && (String(msg.content || "").trim() || msg.tool_calls?.length))
    || (msg.role === "user" && (!msg._origin || msg._origin === "user"));
}

async function createBudgetTestAgent(sessionId, {
  contextWindow = 20000,
  imageInput = false,
  trimOldToolResults = true,
} = {}) {
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
  const { Agent } = await import(`../../src/background/agent/agent.js?budget=${sessionId}-${Date.now()}-${Math.random()}`);
  const options = createTestAgentOptions({ conversationRepository: getSessionRepository() });
  options.tools.getModelPolicy = name => ({ preserveResult: name === "load_skill" });
  const agent = new Agent(sessionId, options);
  agent._runProfile = {
    model: { contextWindow, trimOldToolResults },
    features: { imageInput },
  };
  return agent;
}

function largeToolSchema(name, size) {
  return {
    type: "function",
    function: {
      name,
      description: "x".repeat(size),
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "y".repeat(size) },
        },
      },
    },
  };
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  return extractBracedBlockFrom(source, start, source.indexOf("{", start));
}

function extractClassMethod(source, name) {
  const start = source.indexOf(`${name}(`);
  assert.notEqual(start, -1, `missing method ${name}`);
  return extractBracedBlockFrom(source, start, source.indexOf("{", start));
}

function extractClassMethodDefinition(source, signature) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = source.search(new RegExp(`${escaped}\\s*\\{`));
  assert.notEqual(start, -1, `missing method definition ${signature}`);
  return extractBracedBlockFrom(source, start, source.indexOf("{", start));
}

function extractBracedBlockFrom(source, start, braceStart) {
  assert.notEqual(braceStart, -1, "missing opening brace");
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated block at ${start}`);
}

const serialized = serializeMessagesForCompaction([
  user("请总结"),
  {
    role: "assistant",
    content: "我会读取网页",
    tool_calls: [{ function: { name: "read_page", arguments: "{\"url\":\"https://example.com\"}" } }],
  },
  { role: "tool", content: "x".repeat(700) },
]);
assert.match(serialized, /\[User\]: 请总结/);
assert.match(serialized, /read_page/);
assert.match(serialized, /truncated/);
assert.ok(estimateTokens([{ role: "user", content: "abcd" }]) > 0);

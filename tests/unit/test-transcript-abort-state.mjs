import assert from "node:assert/strict";
import {
  createSessionRecord,
  mergeTranscriptSnapshotWithLocalState,
  readSessionRecord,
  updateTranscriptWithAgentEvent,
} from "../../src/shared/session/session-codec.js";

assertAbortedToolState({ type: "aborted", runId: "run_abort_event" }, "run_abort_event");
assertAbortedToolState({
  type: "state",
  runId: "run_abort_state",
  isStreaming: false,
  status: "aborted",
  runtime: { status: "aborted" },
}, "run_abort_state");
assertToolArgumentStateLifecycle();
assertThinkingOnlyAbortState();
assertEmptyAbortState();
assertRunStatusPersistence();
assertRuntimeRunIdAbortState();
assertInterruptedRuntimeSettlesStreamingState();
assertWaitTerminalReasonPersistence();
assertLateAgentEndDoesNotRewriteAbort();
assertToolExecutionUpdateMergesIntoRunningTool();
assertUnexecutedToolStateOnAgentEnd();
assertUnexecutedToolStateOnCompletedRuntimeState();
assertToolExecutionEndPreservesEventTime();
assertStaleSnapshotPreservesLiveToolEvidence();
assertFinalToolSnapshotCanReplaceLocalInterruptedEvidence();
assertFailedLocalUserSurvivesSnapshotReconciliation();
assertTerminalEventsPreservePreviousSnapshot();

function assertTerminalEventsPreservePreviousSnapshot() {
  for (const type of ["aborted", "error", "agent_end", "state"]) {
    const history = Object.freeze([
      Object.freeze({ type: "assistant", content: "partial", streaming: true }),
      Object.freeze({ type: "thinking", text: "reasoning", streaming: true }),
      Object.freeze({ type: "tool", toolCallId: "pending", runId: "run", isRunning: true, argsState: "executing" }),
      Object.freeze({ type: "assistant", content: "completed" }),
    ]);
    const previous = structuredClone(history);
    const result = updateTranscriptWithAgentEvent(history, { type, runId: "run", status: "interrupted", message: "failed" });
    assert.deepEqual(history, previous, `${type} must preserve the previous checkpoint's entries`);
    for (let index = 0; index < 3; index++) assert.notEqual(result.transcript[index], history[index]);
    assert.equal(result.transcript[3], history[3], "unchanged entries retain their identity");
  }
}

function assertFailedLocalUserSurvivesSnapshotReconciliation() {
  const failed = {
    type: "user",
    text: "retry this message",
    clientMessageId: "failed-local-message",
    deliveryStatus: "failed",
  };
  const merged = mergeTranscriptSnapshotWithLocalState([failed], []);
  assert.deepEqual(merged, [failed], "a failed optimistic bubble must survive an older canonical snapshot");
}

function assertAbortedToolState(terminalEvent, runId) {
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_call_update",
    runId,
    spanId: `tool-call-create-skill-${runId}`,
    toolCallId: `call_create_skill_${runId}`,
    toolName: "create_skill",
    argsText: "{\"name\":\"hello-world\",\"content\":\"# Hello",
    argsComplete: false,
    phase: "preparing",
  });

  assert.equal(result.changed, true);
  const transcript = result.transcript;
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].isRunning, true);
  assert.equal(transcript[0].argsIncomplete, true);
  assert.equal(transcript[0].argsGenerating, true);
  assert.equal(transcript[0].argsState, "generating");
  assert.equal(transcript[0].phase, "preparing");

  result = updateTranscriptWithAgentEvent(transcript, terminalEvent);

  assert.equal(result.changed, true);
  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.ok(tool, `${terminalEvent.type} should keep the streamed tool entry`);
  assert.equal(tool.isRunning, false);
  assert.equal(tool.argsIncomplete, false);
  assert.equal(tool.argsGenerating, false);
  assert.equal(tool.argsState, "aborted");
  assert.equal(tool.phase, "aborted");
  assert.equal(tool.isError, true);
  assert.equal(tool.result?.code, "TOOL_ABORTED");
  assert.equal(tool.result?.interrupted, true);

  const statuses = result.transcript.filter(entry => entry.type === "run-status" && entry.status === "aborted");
  assert.equal(statuses.length, 1, `${terminalEvent.type} should append one aborted run-status`);
  assert.equal(statuses[0].runId, runId);
  assert.equal(statuses[0].text, "已取消");

  result = updateTranscriptWithAgentEvent(result.transcript, terminalEvent);
  const repeatedStatuses = result.transcript.filter(entry => entry.type === "run-status" && entry.status === "aborted");
  assert.equal(repeatedStatuses.length, 1, `${terminalEvent.type} should not duplicate aborted run-status entries`);
}

function assertToolArgumentStateLifecycle() {
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_call_update",
    runId: "run_args_lifecycle",
    spanId: "tool-call-open-tab",
    toolCallId: "call_open_tab",
    toolName: "open_tab",
    arguments: "{\"url\":\"https://www.example",
    argsComplete: false,
  });

  let tool = result.transcript.find(entry => entry.type === "tool");
  assert.ok(tool, "streaming tool call should create a transcript entry");
  assert.deepEqual(tool.args, {});
  assert.equal(tool.argsText, "{\"url\":\"https://www.example");
  assert.equal(tool.argsIncomplete, true);
  assert.equal(tool.argsGenerating, true);
  assert.equal(tool.argsState, "generating");
  assert.equal(tool.phase, "preparing");

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_call_update",
    runId: "run_args_lifecycle",
    spanId: "tool-call-open-tab",
    toolCallId: "call_open_tab",
    toolName: "open_tab",
    arguments: "{\"url\":\"https://www.example.com\"}",
    argsComplete: true,
  });

  tool = result.transcript.find(entry => entry.type === "tool");
  assert.equal(tool.argsText, "{\"url\":\"https://www.example.com\"}");
  assert.equal(tool.argsIncomplete, false);
  assert.equal(tool.argsGenerating, false);
  assert.equal(tool.argsState, "ready");

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_start",
    runId: "run_args_lifecycle",
    spanId: "tool-call-open-tab",
    toolCallId: "call_open_tab",
    toolName: "open_tab",
    args: { url: "https://www.example.com" },
  });

  tool = result.transcript.find(entry => entry.type === "tool");
  assert.deepEqual(tool.args, { url: "https://www.example.com" });
  assert.equal(tool.argsIncomplete, false);
  assert.equal(tool.argsGenerating, false);
  assert.equal(tool.argsState, "executing");
  assert.equal(tool.phase, "running");

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_end",
    runId: "run_args_lifecycle",
    spanId: "tool-call-open-tab",
    toolCallId: "call_open_tab",
    toolName: "open_tab",
    args: { url: "https://www.example.com" },
    result: { ok: true },
  });

  tool = result.transcript.find(entry => entry.type === "tool");
  assert.equal(tool.argsState, "final");
  assert.equal(tool.isRunning, false);

  result = updateTranscriptWithAgentEvent([], {
    type: "tool_execution_end",
    runId: "run_args_empty",
    spanId: "tool-call-no-args",
    toolCallId: "call_no_args",
    toolName: "get_status",
    args: {},
    result: { ok: true },
  });

  tool = result.transcript.find(entry => entry.type === "tool");
  assert.deepEqual(tool.args, {});
  assert.equal(tool.argsState, "final_empty");
  assert.equal(tool.argsGenerating, false);
}

function assertToolExecutionUpdateMergesIntoRunningTool() {
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_execution_start",
    runId: "run_tool_update",
    spanId: "tool-call-open-tab-update",
    toolCallId: "call_open_tab_update",
    toolName: "open_tab",
    args: { url: "https://news.ycombinator.com" },
  });

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_update",
    runId: "run_tool_update",
    spanId: "tool-call-open-tab-update",
    toolCallId: "call_open_tab_update",
    toolName: "open_tab",
    args: { url: "https://news.ycombinator.com" },
    phase: "queued",
    statusText: "流控等待中",
    rateLimit: {
      host: "news.ycombinator.com",
      minOpenIntervalMs: 3000,
      waitMs: 2500,
    },
  });

  let tools = result.transcript.filter(entry => entry.type === "tool");
  assert.equal(tools.length, 1, "tool update should merge into the existing tool card");
  assert.equal(tools[0].phase, "queued");
  assert.equal(tools[0].statusText, "流控等待中");
  assert.equal(tools[0].rateLimit.host, "news.ycombinator.com");
  assert.equal(tools[0].isRunning, true);

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_end",
    runId: "run_tool_update",
    spanId: "tool-call-open-tab-update",
    toolCallId: "call_open_tab_update",
    toolName: "open_tab",
    args: { url: "https://news.ycombinator.com" },
    result: { id: 1, url: "https://news.ycombinator.com" },
  });

  tools = result.transcript.filter(entry => entry.type === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].phase, "done");
  assert.equal(tools[0].statusText, "");
  assert.equal(tools[0].isRunning, false);
  assert.equal(tools[0].result.id, 1);
}

function assertUnexecutedToolStateOnAgentEnd() {
  const runId = "run_tool_not_executed_end";
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_call_update",
    runId,
    spanId: "tool-call-create-skill-unfinished",
    toolCallId: "call_create_skill_unfinished",
    toolName: "create_skill",
    arguments: "{\"name\":\"hacker-news-tools\",\"content\":\"# Hacker News",
    argsComplete: false,
    phase: "preparing",
  });

  result = updateTranscriptWithAgentEvent(result.transcript, { type: "agent_end", runId });
  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.ok(tool, "agent_end should keep an unfinished tool card");
  assert.equal(tool.isRunning, false);
  assert.equal(tool.argsIncomplete, false);
  assert.equal(tool.argsGenerating, false);
  assert.equal(tool.argsState, "not_executed");
  assert.equal(tool.phase, "not_executed");
  assert.equal(tool.isError, true);
  assert.equal(tool.argsText, "{\"name\":\"hacker-news-tools\",\"content\":\"# Hacker News");
  assert.equal(tool.result?.code, "TOOL_NOT_EXECUTED");
  assert.equal(tool.result?.interrupted, true);
  assert.match(tool.result?.error || "", /工具未执行/);

  const record = createSessionRecord(null, result.transcript);
  const restored = readSessionRecord(record).transcript.find(entry => entry.type === "tool");
  assert.ok(restored, "unexecuted tool evidence should survive session record normalization");
  assert.equal(restored.phase, "not_executed");
  assert.equal(restored.argsState, "not_executed");
  assert.equal(restored.result?.code, "TOOL_NOT_EXECUTED");
}

function assertUnexecutedToolStateOnCompletedRuntimeState() {
  const runId = "run_tool_not_executed_state";
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_call_update",
    runId,
    spanId: "tool-call-ready-no-exec",
    toolCallId: "call_ready_no_exec",
    toolName: "create_skill",
    arguments: "{\"name\":\"demo\",\"description\":\"demo\",\"content\":\"# Demo\"}",
    argsComplete: true,
    phase: "running",
  });

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "state",
    runId,
    status: "completed",
    runtime: { status: "completed" },
  });

  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.ok(tool, "completed runtime state should close a ready-but-unexecuted tool card");
  assert.equal(tool.argsState, "not_executed");
  assert.equal(tool.phase, "not_executed");
  assert.equal(tool.result?.code, "TOOL_NOT_EXECUTED");
  assert.match(tool.result?.error || "", /没有执行/);
}

function assertToolExecutionEndPreservesEventTime() {
  const runId = "run_tool_event_time";
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_execution_start",
    runId,
    spanId: "tool-call-timed",
    toolCallId: "call_timed",
    toolName: "data_store",
    args: { action: "insert", table: "launch_leads" },
    timestamp: "2026-06-24 10:01:00",
  });

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_end",
    runId,
    spanId: "tool-call-timed",
    toolCallId: "call_timed",
    toolName: "data_store",
    args: { action: "insert", table: "launch_leads" },
    result: { ok: true },
    timestamp: "2026-06-24 10:03:00",
  });

  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.ok(tool, "tool execution should render a transcript entry");
  assert.equal(tool.timestamp, "2026-06-24 10:01:00");
  assert.equal(tool.endedAt, "2026-06-24 10:03:00");
}

function assertStaleSnapshotPreservesLiveToolEvidence() {
  const runId = "run_stale_snapshot_live_tool";
  const live = {
    type: "tool",
    runId,
    spanId: "tool-call-create-skill-live",
    toolCallId: "call_create_skill_live",
    name: "create_skill",
    args: {},
    argsText: "{\"name\":\"hacker-news-tools\",\"content\":\"# Hacker News\\n\\n生成中",
    argsIncomplete: true,
    argsGenerating: true,
    argsState: "generating",
    phase: "preparing",
    result: null,
    isError: false,
    isRunning: true,
    timestamp: "2026-06-30 13:35:00",
    eventSeq: 12,
  };
  const stale = {
    type: "tool",
    runId,
    spanId: "tool-call-create-skill-live",
    toolCallId: "call_create_skill_live",
    name: "create_skill",
    args: {},
    argsText: "{\"name\":\"hacker-news-tools\"",
    argsIncomplete: false,
    argsGenerating: false,
    argsState: "",
    phase: "",
    result: null,
    isError: false,
    isRunning: false,
    timestamp: "2026-06-30 13:35:00",
    eventSeq: 11,
  };

  const merged = mergeTranscriptSnapshotWithLocalState([live], [stale]);
  assert.equal(merged.length, 1, "stale snapshot should not duplicate same toolCallId");
  const tool = merged[0];
  assert.equal(tool.toolCallId, live.toolCallId);
  assert.equal(tool.isRunning, true);
  assert.equal(tool.argsGenerating, true);
  assert.equal(tool.argsState, "generating");
  assert.equal(tool.phase, "preparing");
  assert.equal(tool.argsText, live.argsText);
  assert.equal(tool.eventSeq, stale.eventSeq, "snapshot ordering metadata should stay stable while live evidence is preserved");
}

function assertFinalToolSnapshotCanReplaceLocalInterruptedEvidence() {
  const runId = "run_final_snapshot_wins";
  const localInterrupted = {
    type: "tool",
    runId,
    toolCallId: "call_create_skill_final",
    name: "create_skill",
    args: {},
    argsText: "{\"name\":\"hacker-news-tools\"",
    argsIncomplete: false,
    argsGenerating: false,
    argsState: "not_executed",
    phase: "not_executed",
    result: { error: "模型没有完成工具参数生成，工具未执行。", code: "TOOL_NOT_EXECUTED", interrupted: true },
    isError: true,
    isRunning: false,
    timestamp: "2026-06-30 13:35:00",
  };
  const finalSnapshot = {
    type: "tool",
    runId,
    toolCallId: "call_create_skill_final",
    name: "create_skill",
    args: { name: "hacker-news-tools" },
    argsText: "",
    argsIncomplete: false,
    argsGenerating: false,
    argsState: "final",
    phase: "done",
    result: { ok: true, name: "hacker-news-tools" },
    isError: false,
    isRunning: false,
    timestamp: "2026-06-30 13:35:00",
    endedAt: "2026-06-30 13:40:00",
  };

  const merged = mergeTranscriptSnapshotWithLocalState([localInterrupted], [finalSnapshot]);
  assert.equal(merged.length, 1);
  const tool = merged[0];
  assert.equal(tool.phase, "done");
  assert.equal(tool.argsState, "final");
  assert.equal(tool.isError, false);
  assert.deepEqual(tool.result, { ok: true, name: "hacker-news-tools" });
}

function assertThinkingOnlyAbortState() {
  const runId = "run_abort_thinking";
  let result = updateTranscriptWithAgentEvent([], {
    type: "thinking_update",
    runId,
    spanId: "thinking-span",
    thinking: "正在分析用户意图",
  });

  assert.equal(result.changed, true);
  assert.equal(result.transcript.length, 1);
  assert.equal(result.transcript[0].type, "thinking");
  assert.equal(result.transcript[0].streaming, true);

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "state",
    runId,
    isStreaming: false,
    status: "aborted",
    runtime: { status: "aborted", reason: "stopped_by_user" },
  });

  assert.equal(result.changed, true);
  const thinking = result.transcript.find(entry => entry.type === "thinking");
  assert.ok(thinking, "thinking-only abort should keep thinking entry");
  assert.equal(thinking.streaming, undefined);
  assert.equal(thinking.phase, "aborted");
  assert.ok(thinking.endedAt, "thinking-only abort should stamp endedAt");

  const record = createSessionRecord(null, result.transcript);
  const restored = readSessionRecord(record).transcript.find(entry => entry.type === "thinking");
  assert.ok(restored, "thinking-only abort should survive session record normalization");
  assert.equal(restored.phase, "aborted", "aborted thinking phase should persist across reopen");

  const status = result.transcript.find(entry => entry.type === "run-status");
  assert.ok(status, "thinking-only abort should append run-status");
  assert.equal(status.status, "aborted");
  assert.equal(status.reason, "stopped_by_user");
  assert.equal(status.text, "已取消");
}

function assertEmptyAbortState() {
  const runId = "run_abort_empty";
  const result = updateTranscriptWithAgentEvent([], {
    type: "state",
    runId,
    isStreaming: false,
    status: "aborted",
    runtime: { status: "aborted" },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.transcript.map(entry => ({ type: entry.type, status: entry.status, text: entry.text, runId: entry.runId })),
    [{ type: "run-status", status: "aborted", text: "已取消", runId }],
  );
}

function assertRunStatusPersistence() {
  const runId = "run_abort_persist";
  const transcript = updateTranscriptWithAgentEvent([], {
    type: "state",
    runId,
    isStreaming: false,
    status: "aborted",
    runtime: { status: "aborted", reason: "stopped_by_user" },
  }).transcript;

  const record = createSessionRecord(null, transcript);
  const read = readSessionRecord(record);
  const status = read.transcript.find(entry => entry.type === "run-status");
  assert.ok(status, "run-status should survive session record normalization");
  assert.equal(status.status, "aborted");
  assert.equal(status.reason, "stopped_by_user");
  assert.equal(status.text, "已取消");
  assert.equal(status.runId, runId);
}

function assertRuntimeRunIdAbortState() {
  const runId = "run_abort_runtime_only";
  let result = updateTranscriptWithAgentEvent([], {
    type: "state",
    isStreaming: false,
    status: "aborted",
    runtime: { status: "aborted", runId, reason: "stopped_by_user" },
  });

  assert.equal(result.changed, true);
  let statuses = result.transcript.filter(entry => entry.type === "run-status" && entry.status === "aborted");
  assert.equal(statuses.length, 1, "runtime runId should identify terminal run-status entries");
  assert.equal(statuses[0].runId, runId);

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "state",
    isStreaming: false,
    status: "aborted",
    runtime: { status: "aborted", runId, reason: "stopped_by_user" },
  });

  statuses = result.transcript.filter(entry => entry.type === "run-status" && entry.status === "aborted");
  assert.equal(statuses.length, 1, "restored terminal state with runtime.runId should not append a second run-status");
  assert.equal(statuses[0].runId, runId);
  assert.equal(statuses[0].reason, "stopped_by_user");
}

function assertInterruptedRuntimeSettlesStreamingState() {
  const runId = "run_service_worker_restart";
  const transcript = [
    {
      type: "thinking",
      text: "仍在思考",
      runId,
      spanId: "thinking-restart",
      streaming: true,
    },
    {
      type: "assistant",
      content: "已经生成但尚未完成的正文",
      runId,
      spanId: "assistant-restart",
      streaming: true,
    },
    {
      type: "tool",
      name: "read_page",
      toolCallId: "call-restart",
      runId,
      argsIncomplete: true,
      argsGenerating: true,
      argsState: "generating",
      phase: "preparing",
      isRunning: true,
      result: null,
      streaming: true,
    },
  ];

  let result = updateTranscriptWithAgentEvent(transcript, {
    type: "state",
    sessionId: "s-restart",
    runId,
    isStreaming: false,
    status: "interrupted",
    runtime: { status: "interrupted", running: false, runId, reason: "service_worker_restarted" },
  });

  assert.equal(result.changed, true);
  assert.equal(result.transcript.some(entry => entry.streaming), false, "interrupted runtime must close every live transcript entry");
  assert.equal(result.transcript.find(entry => entry.type === "assistant")?.content, "已经生成但尚未完成的正文");
  assert.equal(result.transcript.find(entry => entry.type === "thinking")?.text, "仍在思考");
  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.equal(tool?.isRunning, false);
  assert.equal(tool?.phase, "interrupted");
  assert.equal(tool?.argsState, "aborted");
  assert.equal(tool?.result?.code, "TOOL_INTERRUPTED");
  assert.equal(tool?.result?.interrupted, true);
  const notice = result.transcript.at(-1);
  assert.equal(notice.type, "run-status");
  assert.equal(notice.status, "interrupted", "restart recovery must remain distinct from user cancellation");
  assert.equal(notice.runId, runId);
  assert.equal(notice.text, "运行已中断，已恢复保存的对话。发送消息可继续。");
  assert.equal(notice.reason, "service_worker_restarted");
  const saved = readSessionRecord(createSessionRecord([], result.transcript));
  assert.deepEqual(saved.transcript.at(-1), notice, "the interruption notice survives persistence");

  result = updateTranscriptWithAgentEvent(saved.transcript, {
    type: "state",
    runId,
    isStreaming: false,
    status: "interrupted",
    runtime: { status: "interrupted", running: false, runId },
  });
  assert.equal(result.changed, false, "repeated interrupted snapshots should be idempotent");
  assert.equal(result.transcript.filter(entry => entry.type === "run-status").length, 1);
  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "message_start", runId: "next-run",
    message: { role: "user", content: "继续", clientMessageId: "continue-after-restart" },
  });
  assert.equal(result.transcript.at(-2).status, "interrupted", "continuing keeps the notice with its old round");
  assert.equal(result.transcript.at(-1).text, "继续");
}

function assertWaitTerminalReasonPersistence() {
  for (const reason of ["aborted", "superseded", "stale", "cancelled"]) {
    const runId = `run_wait_${reason}`;
    const waitId = `wait_${reason}`;
    let result = updateTranscriptWithAgentEvent([], {
      type: "waiting_for_user",
      runId,
      waitId,
      title: "需要确认",
      message: "等待用户处理",
    });
    result = updateTranscriptWithAgentEvent(result.transcript, {
      type: "user_wait_resolved",
      runId,
      waitId,
      reason,
    });

    const wait = result.transcript.find(entry => entry.type === "wait");
    assert.ok(wait, `${reason} wait should stay in transcript`);
    assert.equal(wait.status, reason, `${reason} wait should keep terminal status`);

    const restored = readSessionRecord(createSessionRecord(null, result.transcript))
      .transcript
      .find(entry => entry.type === "wait");
    assert.ok(restored, `${reason} wait should survive session record normalization`);
    assert.equal(restored.status, reason, `${reason} wait status should persist across reopen`);
    assert.equal(restored.reason, reason, `${reason} wait reason should persist across reopen`);
  }
}

function assertLateAgentEndDoesNotRewriteAbort() {
  const thinkingRunId = "run_late_end_thinking";
  let result = updateTranscriptWithAgentEvent([], {
    type: "thinking_update",
    runId: thinkingRunId,
    spanId: "late-thinking",
    thinking: "正在处理",
  });
  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "state",
    runId: thinkingRunId,
    status: "aborted",
    runtime: { status: "aborted" },
  });
  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "agent_end",
    runId: thinkingRunId,
  });
  assert.equal(
    result.transcript.find(entry => entry.type === "thinking")?.phase,
    "aborted",
    "late agent_end should not rewrite aborted thinking as completed",
  );

  const toolRunId = "run_late_end_tool";
  result = updateTranscriptWithAgentEvent([], {
    type: "tool_call_update",
    runId: toolRunId,
    spanId: "late-tool",
    toolCallId: "late-tool-call",
    toolName: "run_script",
    argsText: "return",
    argsComplete: false,
  });
  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "state",
    runId: toolRunId,
    status: "aborted",
    runtime: { status: "aborted" },
  });
  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "agent_end",
    runId: toolRunId,
  });
  assert.equal(
    result.transcript.find(entry => entry.type === "tool")?.phase,
    "aborted",
    "late agent_end should not rewrite aborted tool as completed",
  );
}

console.log("transcript abort state contracts passed");

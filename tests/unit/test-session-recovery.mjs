import assert from "node:assert/strict";
import test from "node:test";
import { readSessionSnapshot } from "../../src/shared/session/session-recovery.js";
import { createSessionRecord, serializeConversation, transcriptFromConversation, updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";
import { createLoopAgent } from "../support/agent-provider-error-recovery-fixture.mjs";

const user = (content, clientMessageId = "u1") => ({ role: "user", content, clientMessageId });
const assistant = content => ({ role: "assistant", content });
const toolCall = {
  role: "assistant", content: null,
  tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: '{"query":"inspect"}' } }],
};

test("saved display history is returned unchanged while the current model conversation remains available", () => {
  const old = [user("question"), assistant("saved answer")];
  const record = createSessionRecord(old, [
    ...transcriptFromConversation(old), { type: "thinking", text: "saved reasoning", spanId: "saved-span" },
  ]);
  for (const messages of [[...old, user("new model input", "u2")], [user("different model history")], []]) {
    const active = serializeConversation(messages);
    const before = structuredClone({ record, active });
    const recovered = readSessionSnapshot(record, active);
    assert.deepEqual(recovered.transcript, record.transcript, "model content never reconciles the display snapshot");
    assert.deepEqual(recovered.conversation, active, "Agent hydration still receives the current model conversation");
    assert.deepEqual({ record, active }, before, "reading must not mutate either source");
  }
  assert.deepEqual(readSessionSnapshot(record).conversation, record.conversation);
});

test("an explicitly empty display snapshot never resurrects model history", () => {
  const record = createSessionRecord([user("saved model input")], []);
  for (const active of [undefined, serializeConversation([user("active model input")])]) {
    assert.deepEqual(readSessionSnapshot(record, active).transcript, []);
  }
});

test("only absent display snapshots fall back to the chosen conversation", () => {
  const legacy = createSessionRecord([user("legacy model input")], []);
  delete legacy.transcript;
  const active = serializeConversation([user("active model input")]);
  assert.deepEqual(readSessionSnapshot(legacy, active).transcript, transcriptFromConversation(active));
  assert.deepEqual(readSessionSnapshot(legacy).transcript, transcriptFromConversation(legacy.conversation));
  assert.deepEqual(readSessionSnapshot(null, active).transcript, transcriptFromConversation(active));
  assert.deepEqual(readSessionSnapshot(null), { conversation: null, transcript: [] });
});

test("reading does not repair saved tool state from a different model result", () => {
  const messages = [user("inspect"), toolCall, { role: "tool", tool_call_id: "tool-1", content: '{"ok":true}' }];
  const rich = updateTranscriptWithAgentEvent(transcriptFromConversation([messages[0]]), {
    type: "tool_execution_start", toolCallId: "tool-1", toolName: "lookup", args: { query: "inspect" },
  }).transcript;
  const record = createSessionRecord(messages, rich);
  assert.deepEqual(readSessionSnapshot(record, serializeConversation(messages)).transcript, record.transcript);
});

test("the actual executed screenshot and page metadata survive a display snapshot read", async () => {
  const agent = createLoopAgent([]);
  agent.messages = [user("inspect"), toolCall];
  agent._dynamicContextSnapshot = { workingTab: { id: 42, title: "Saved page", url: "https://example.test/saved" } };
  agent._browserContext.getTab = async id => ({ id, title: "Saved page", url: "https://example.test/saved" });
  agent._tools = {
    getIdentity: () => ({ capabilityId: "lookup", title: "Inspect page", familyId: "page" }),
    getModelPolicy: () => ({ pageContext: "working" }),
    execute: async () => ({ ok: true, _image: "data:image/png;base64,AAAA" }),
  };
  let rich = transcriptFromConversation([agent.messages[0]]);
  agent.subscribe(event => { rich = updateTranscriptWithAgentEvent(rich, event).transcript; });
  agent.messages.push(...await agent._executeToolCalls(toolCall.tool_calls, new AbortController().signal));
  rich.push({ type: "thinking", text: "reasoning after screenshot", spanId: "after-tool" });
  const active = agent.exportSession();
  assert.equal(transcriptFromConversation(active).find(entry => entry.type === "tool").image, null);
  const record = createSessionRecord(active, rich);
  const recovered = readSessionSnapshot(record, active).transcript;
  assert.deepEqual(recovered, record.transcript);
  const tool = recovered.find(entry => entry.type === "tool");
  assert.equal(tool.image, "data:image/png;base64,AAAA");
  assert.deepEqual(tool.args, { query: "inspect", tabId: 42, _tabId: 42, _pageTitle: "Saved page", _pageUrl: "https://example.test/saved" });
  assert.equal(tool.title, "Inspect page");
  assert.equal(recovered.at(-1).spanId, "after-tool");
});

test("actual 401 display-only errors survive direct reads and a successful retry", async () => {
  const failure = {
    role: "assistant", content: "❌ LLM 调用失败: 模型服务鉴权失败。",
    _stopReason: "error", _spanId: "provider-failure",
    _error: { kind: "auth", code: "invalid_api_key", status: 401 },
  };
  const agent = createLoopAgent([failure, { ...assistant("retry succeeded"), _spanId: "retry-answer" }]);
  agent.messages = [user("needs authentication")];
  let rich = transcriptFromConversation(agent.messages);
  agent.subscribe(event => { rich = updateTranscriptWithAgentEvent(rich, event).transcript; });
  await assert.rejects(agent._runLoop(new AbortController().signal), error => error.status === 401);
  rich = updateTranscriptWithAgentEvent(rich, {
    type: "error", runId: agent._currentRunId, message: failure.content.replace(/^❌\s*/u, ""),
  }).transcript;
  assert.equal(rich.some(entry => entry.type === "error"), false, "the visible failure is an assistant, not a fabricated error entry");
  for (const retry of [false, true]) {
    if (retry) await agent.prompt("retry with corrected credentials", null, [], "u2");
    assert.equal(agent.messages.some(message => message.content === failure.content), false);
    const record = createSessionRecord(agent.exportSession(), rich);
    const recovered = readSessionSnapshot(record, agent.exportSession()).transcript;
    assert.deepEqual(recovered, record.transcript);
    assert.equal(recovered.filter(entry => entry.content === failure.content).length, 1);
    if (retry) assert.equal(recovered.at(-1).spanId, "retry-answer");
  }
});

test("the saved interruption notice survives two restarts without inserting a model-only assistant", async () => {
  const agent = createLoopAgent([{ ...assistant("continued answer"), _spanId: "continued-answer" }]);
  agent.messages = [user("unfinished request")];
  let rich = updateTranscriptWithAgentEvent(transcriptFromConversation(agent.messages), {
    type: "state", runId: "interrupted-run", status: "interrupted", isStreaming: false,
    runtime: { status: "interrupted", running: false, runId: "interrupted-run" },
  }).transcript;
  agent.subscribe(event => { rich = updateTranscriptWithAgentEvent(rich, event).transcript; });
  await agent.prompt("continue here", null, [], "u2");
  const synthetic = agent.messages.find(message => message._kind === "interrupted");
  assert.ok(synthetic, "the real prompt path repairs the model turn without emitting a display message");
  const active = agent.exportSession();
  let record = createSessionRecord(active, rich);
  for (let restart = 0; restart < 2; restart++) {
    const recovered = readSessionSnapshot(record, active);
    assert.deepEqual(recovered.transcript, record.transcript);
    assert.deepEqual(recovered.conversation, active);
    assert.equal(recovered.transcript.filter(entry => entry.type === "run-status" && entry.status === "interrupted").length, 1);
    assert.equal(recovered.transcript.some(entry => entry.content === synthetic.content), false);
    assert.equal(recovered.transcript.at(-1).spanId, "continued-answer");
    record = createSessionRecord(recovered.conversation, recovered.transcript);
  }
});

test("unsupported stored formats remain explicit errors even with a display snapshot", () => {
  const record = createSessionRecord([user("saved")], [{ type: "assistant", content: "saved display" }]);
  assert.throws(() => readSessionSnapshot({ ...record, version: 99 }, []), { code: "UNSUPPORTED_SESSION_RECORD_VERSION" });
  assert.throws(() => readSessionSnapshot(record, { type: "conversation", version: 99, entries: [] }), { code: "UNSUPPORTED_CONVERSATION_VERSION" });
  assert.throws(() => readSessionSnapshot(record, { unexpected: true }), { code: "INVALID_SESSION_FORMAT" });
});

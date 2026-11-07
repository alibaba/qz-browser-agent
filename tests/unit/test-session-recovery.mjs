import assert from "node:assert/strict";
import test from "node:test";
import { readSessionSnapshot } from "../../src/shared/session/session-recovery.js";
import { createSessionRecord, serializeConversation, transcriptFromConversation, updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";
import { createLoopAgent } from "../support/agent-provider-error-recovery-fixture.mjs";
import { bindToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import { projectMessage } from "../../src/background/llm/message-projection.js";

const user = (content, clientMessageId = "u1") => ({ role: "user", content, clientMessageId });
const assistant = content => ({ role: "assistant", content });
const toolCall = {
  role: "assistant", content: null,
  tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: '{"query":"inspect"}' } }],
};

test('conversation fallback preserves explicit execution status outside authored result data and provider wire', () => {
  const business = { error: 'authored', code: 'BUSINESS_ERROR', message: 'Business status', ok: false };
  for (const isError of [false, true]) {
    const message = { role: 'tool', tool_call_id: 'tool-1', content: JSON.stringify(business), _toolIsError: isError };
    const conversation = serializeConversation([toolCall, message]);
    const stored = conversation.entries.at(-1).message;
    assert.equal(stored._toolIsError, isError);
    const recovered = transcriptFromConversation(conversation).find(entry => entry.type === 'tool');
    assert.equal(recovered.isError, isError);
    assert.deepEqual(recovered.result, business);
    assert.deepEqual(projectMessage(stored, false), { role: 'tool', tool_call_id: 'tool-1', content: message.content });
  }
  const legacy = transcriptFromConversation([toolCall, { role: 'tool', tool_call_id: 'tool-1', content: JSON.stringify(business) }]);
  assert.equal(legacy.find(entry => entry.type === 'tool').isError, true, 'legacy records retain their compatibility classification');
});

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
  const calls = [{ ...toolCall.tool_calls[0], function: { name: "lookup", arguments: '{"query":"inspect","tabRef":"saved"}' } }];
  agent.messages = [user("inspect"), { ...toolCall, tool_calls: calls }];
  agent._tools = {
    getTabAliases: () => ({ saved: 42 }),
    getIdentity: () => ({ capabilityId: "lookup", title: "Inspect page", familyId: "page" }),
    getModelPolicy: () => ({ pageContext: "explicit" }),
    execute: async () => bindToolResultPresentation({ ok: true, _image: "data:image/png;base64,AAAA" }, {
      _pageTitle: "Saved page", _pageUrl: "https://example.test/saved",
    }),
  };
  let rich = transcriptFromConversation([agent.messages[0]]);
  agent.subscribe(event => { rich = updateTranscriptWithAgentEvent(rich, event).transcript; });
  agent.messages.push(...await agent._executeToolCalls(calls, new AbortController().signal));
  rich.push({ type: "thinking", text: "reasoning after screenshot", spanId: "after-tool" });
  const active = agent.exportSession();
  assert.equal(transcriptFromConversation(active).find(entry => entry.type === "tool").image, null);
  const record = createSessionRecord(active, rich);
  const recovered = readSessionSnapshot(record, active).transcript;
  assert.deepEqual(recovered, record.transcript);
  const tool = recovered.find(entry => entry.type === "tool");
  assert.equal(tool.image, "data:image/png;base64,AAAA");
  assert.deepEqual(tool.args, { query: "inspect", tabRef: "saved" });
  assert.equal(tool.result._pageTitle, "Saved page");
  assert.equal(tool.result._pageUrl, "https://example.test/saved");
  assert.doesNotMatch(JSON.stringify(agent.messages.filter(message => message.role === "tool")), /_pageTitle|_pageUrl/);
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

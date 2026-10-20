import assert from "node:assert/strict";
import test from "node:test";
import { readSessionSnapshot } from "../../src/shared/session/session-recovery.js";
import { createSessionRecord, serializeConversation, transcriptFromConversation } from "../../src/shared/session/session-codec.js";

const user = (content, clientMessageId = "u1") => ({ role: "user", content, clientMessageId });
const assistant = content => ({ role: "assistant", content });
const thinking = text => ({ type: "thinking", text, phase: "completed", runId: "old-run", spanId: text });
const save = (messages, transcript = transcriptFromConversation(messages)) => createSessionRecord(messages, transcript);
const visible = transcript => transcript.filter(entry => ["user", "assistant"].includes(entry.type))
  .map(entry => entry.text ?? entry.content);
const toolCall = (id = "tool-1", args = { query: "first" }) => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: JSON.stringify(args) } }],
});
const toolResult = (content, id = "tool-1") => ({ role: "tool", tool_call_id: id, content: JSON.stringify(content) });

test("active checkpoint fills the lost round while retaining historical thinking and metadata", () => {
  const old = [user("first"), assistant("old answer")];
  const rich = transcriptFromConversation(old);
  rich.splice(1, 0, thinking("old reasoning"));
  Object.assign(rich[2], { runId: "old-run", spanId: "answer-1", timestamp: "2026-01-01 12:00:00" });
  const record = save(old, rich);
  const active = serializeConversation([...old, user("second", "u2"), assistant("checkpointed answer")]);
  const before = structuredClone({ record, active });
  const recovered = readSessionSnapshot(record, active);
  assert.deepEqual(visible(recovered.transcript), ["first", "old answer", "second", "checkpointed answer"]);
  assert.equal(recovered.transcript[1].text, "old reasoning");
  assert.equal(recovered.transcript[2].spanId, "answer-1");
  assert.equal(recovered.transcript[2].timestamp, "2026-01-01 12:00:00");
  assert.deepEqual({ record, active }, before, "recovery must not mutate either persisted source");
  assert.deepEqual(recovered.conversation, active);
});

test("absent active preserves record-only rich history and an empty active explicitly clears old history", () => {
  const record = save([user("old"), assistant("old answer")], [thinking("rich-only")]);
  assert.equal(readSessionSnapshot(record).transcript[0].text, "rich-only");
  assert.deepEqual(readSessionSnapshot(record, []).transcript, []);
  assert.deepEqual(readSessionSnapshot(null), { conversation: null, transcript: [] });
  assert.deepEqual(visible(readSessionSnapshot(save([user("fallback")], [])).transcript), ["fallback"]);
});

for (const wrap of [messages => messages, messages => ({ messages }), messages => ({ entries: messages.map(message => ({ message })) })]) {
  test("legacy active formats recover even when the stored transcript is missing or stale", () => {
    const old = [user("old"), assistant("old answer")];
    const active = wrap([...old, user("new", "u2"), assistant("new answer")]);
    for (const record of [null, save(old, []), save(old, transcriptFromConversation(old).slice(0, 1))]) {
      assert.deepEqual(visible(readSessionSnapshot(record, active).transcript), ["old", "old answer", "new", "new answer"]);
    }
  });
}

for (const replacement of ["edited", "second"]) {
  test(`same-ID edit/resend (${replacement}) cannot resurrect the removed answer or thinking`, () => {
    const old = [user("first"), assistant("retained"), user("second", "u2"), assistant("removed")];
    const rich = transcriptFromConversation(old);
    rich.splice(1, 0, thinking("retained thinking"));
    rich.splice(4, 0, thinking("removed thinking"));
    const active = [old[0], old[1], user(replacement, "u2")];
    const recovered = readSessionSnapshot(save(old, rich), active).transcript;
    assert.deepEqual(visible(recovered), ["first", "retained", replacement]);
    assert.deepEqual(recovered.filter(entry => entry.type === "thinking").map(entry => entry.text), ["retained thinking"]);
  });
}

test("repeated text and repeated tool IDs retain their order and separate rich metadata", () => {
  const old = [user("repeat"), assistant("same"), toolCall(), toolResult({ value: 1 }),
    user("repeat", "u2"), assistant("same"), toolCall(), toolResult({ value: 2 })];
  const rich = transcriptFromConversation(old);
  const answers = rich.filter(entry => entry.type === "assistant");
  answers[0].spanId = "first-answer";
  answers[1].spanId = "second-answer";
  const tools = rich.filter(entry => entry.type === "tool");
  tools[0].title = "first tool";
  tools[1].title = "second tool";
  const recovered = readSessionSnapshot(save(old, rich), [...old, user("repeat", "u3")]).transcript;
  assert.deepEqual(recovered.filter(entry => entry.type === "assistant").map(entry => entry.spanId), ["first-answer", "second-answer"]);
  assert.deepEqual(recovered.filter(entry => entry.type === "tool").map(entry => entry.title), ["first tool", "second tool"]);
  assert.equal(recovered.filter(entry => entry.type === "user").length, 3);
});

test("inserting a compaction boundary retains history, hides capsules, and never compares snapshot length", () => {
  const old = [user("first"), assistant("first answer"), user("second", "u2"), assistant("second answer")];
  const rich = transcriptFromConversation(old);
  rich.splice(1, 0, thinking("retain before compaction"));
  rich.splice(4, 0, thinking("retain after compaction"));
  const compact = { role: "user", _kind: "compaction", content: "summary", _compact: { id: "compact-1", status: "done" } };
  const capsule = { role: "user", _kind: "context_capsule", _origin: "context_capsule", content: "hidden context" };
  const active = [old[0], old[1], compact, capsule, old[2], old[3]];
  const recovered = readSessionSnapshot(save(old, rich), active).transcript;
  assert.deepEqual(visible(recovered), ["first", "first answer", "second", "second answer"]);
  assert.equal(recovered.filter(entry => entry.type === "compact").length, 1);
  assert.equal(recovered.filter(entry => entry.type === "thinking").length, 2);
});

test("completed compaction retains rich metrics and a saved failed compaction stays on the retained branch", () => {
  const compact = { role: "user", _kind: "compaction", content: "summary", _compact: { id: "c1", status: "done", inputTokensAfter: 50 } };
  const old = [user("question"), compact, assistant("answer")];
  const rich = transcriptFromConversation(old).filter(entry => entry.type !== "compact");
  rich.push({ type: "compact", compactId: "c1", status: "done", summary: "summary", inputTokensBefore: 100, runId: "run-1" },
    thinking("saved tail thinking"), { type: "compact", compactId: "c2", status: "failed", summary: "Saved failure" });
  const recovered = readSessionSnapshot(save(old, rich), old).transcript;
  const completed = recovered.find(entry => entry.compactId === "c1");
  assert.equal(completed.inputTokensBefore, 100);
  assert.equal(completed.inputTokensAfter, 50);
  assert.equal(completed.runId, "run-1");
  assert.equal(recovered.at(-2).text, "saved tail thinking");
  assert.equal(recovered.at(-1).summary, "Saved failure");
  const edited = readSessionSnapshot(save(old, rich), [old[0]]).transcript;
  assert.deepEqual(edited.map(entry => entry.type), ["user"], "neither removed markers nor trailing old decorations survive an edit");
});

test("completed rich tool results, screenshots and identity survive canonical result truncation", () => {
  const old = [user("look"), toolCall(), toolResult({ text: "x".repeat(21000) })];
  const rich = transcriptFromConversation(old);
  Object.assign(rich[1], {
    result: { text: "full rich result", extra: true }, image: "data:image/png;base64,AAAA",
    capabilityId: "lookup", title: "Lookup title", familyId: "search", runId: "old-run", phase: "done",
  });
  const recovered = readSessionSnapshot(save(old, rich), serializeConversation(old)).transcript[1];
  assert.deepEqual(recovered.result, rich[1].result);
  assert.equal(recovered.image, rich[1].image);
  assert.equal(recovered.title, "Lookup title");
  assert.equal(recovered.familyId, "search");
  assert.equal(recovered.isRunning, false);
});

for (const phase of ["error", "not_executed", "interrupted"]) {
  test(`historical tool terminal phase ${phase} keeps its explanation`, () => {
    const old = [user("look"), toolCall(), toolResult({ error: "stopped" })];
    const rich = transcriptFromConversation(old);
    Object.assign(rich[1], { phase, statusText: "Historical explanation", isError: true, argsState: phase === "interrupted" ? "aborted" : phase });
    const recovered = readSessionSnapshot(save(old, rich), old).transcript[1];
    assert.equal(recovered.phase, phase);
    assert.equal(recovered.statusText, "Historical explanation");
    assert.equal(recovered.isError, true);
  });
}

test("a durable result completes a stale running tool, and a changed result never reuses old rich output", () => {
  const old = [user("look"), toolCall(), toolResult({ answer: "done" })];
  const rich = transcriptFromConversation(old);
  Object.assign(rich[1], { result: null, isRunning: true, phase: "running", argsState: "executing", title: "Lookup" });
  const recovered = readSessionSnapshot(save(old, rich), old).transcript[1];
  assert.deepEqual(recovered.result, { answer: "done" });
  assert.equal(recovered.title, "Lookup");
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.argsState, "final");
  assert.equal(recovered.isRunning, false);
  const changed = readSessionSnapshot(save(old, [
    ...rich.slice(0, 1), { ...rich[1], isRunning: false, phase: "done", result: { wrong: true }, image: "data:image/png;base64,AAAA" },
  ]), [old[0], old[1], toolResult({ answer: "changed" })]).transcript[1];
  assert.deepEqual(changed.result, { answer: "changed" });
  assert.equal(changed.image, null);
});

test("user image bytes and document references remain canonical while attachment display metadata survives", () => {
  const document = { sessionId: "s", messageId: "u1", attachmentId: "a", fileId: "f", docModelId: "d", filename: "report.pdf" };
  const old = [{ ...user([{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), documents: [document] }];
  const rich = transcriptFromConversation(old);
  rich[0].images[0].name = "uploaded.png";
  const recovered = readSessionSnapshot(save(old, rich), old).transcript[0];
  assert.equal(recovered.images[0].name, "uploaded.png");
  assert.equal(recovered.images[0].dataUrl, "data:image/png;base64,AAAA");
  assert.equal(recovered.documents[0].filename, "report.pdf");
  const changed = [{ ...old[0], documents: [{ ...document, fileId: "new-file" }] }];
  assert.equal(readSessionSnapshot(save(old, rich), changed).transcript[0].documents[0].fileId, "new-file");
});

test("incompatible versions remain explicit errors even when another snapshot is usable", () => {
  const record = save([user("old")]);
  assert.throws(() => readSessionSnapshot({ ...record, version: 99 }, []), { code: "UNSUPPORTED_SESSION_RECORD_VERSION" });
  assert.throws(() => readSessionSnapshot(record, { type: "conversation", version: 99, entries: [] }), { code: "UNSUPPORTED_CONVERSATION_VERSION" });
  assert.throws(() => readSessionSnapshot(record, { unexpected: true }), { code: "INVALID_SESSION_FORMAT" });
});

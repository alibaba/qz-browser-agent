import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRepository, SESSION_TRANSCRIPT_CHECKPOINT_PREFIX } from "../../src/background/session/repository.js";
import { createSessionTranscript } from "../../src/background/session/transcript.js";
import { createSessionRecord, readSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import { SESSION_RECORD_PREFIX } from "../../src/shared/session/session-store.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

const sessionId = "checkpoint-session";
const recordKey = id => `${SESSION_RECORD_PREFIX}${id}`;
const image = "data:image/png;base64,AAAA";
const user = (content, clientMessageId) => ({ role: "user", content, clientMessageId });
const assistant = content => ({ role: "assistant", content });

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages = [user("old question", "old-user"), assistant("old answer"), user("new question", "new-user")];
  const initial = createSessionRecord(messages, [
    { type: "user", text: "old question", clientMessageId: "old-user" },
    { type: "thinking", text: "old thinking", phase: "completed", spanId: "old-thinking" },
    { type: "tool", toolCallId: "old-tool", name: "lookup", args: { query: "old" }, result: { ok: true }, image, phase: "done" },
    { type: "assistant", content: "old answer", spanId: "old-answer" },
    { type: "user", text: "new question", clientMessageId: "new-user" },
  ]);
  const storage = createMemoryStorage({ [recordKey(sessionId)]: initial });
  const repository = createSessionRepository({ storage });
  let active = true, exports = 0;
  const entry = {
    lease: { sessionId, isActive: () => active },
    agent: { exportSession: () => { exports++; return serializeConversation(messages); } },
  };
  const owners = [];
  const checkpoints = [];
  const owner = (runtime = { status: "running" }) => {
    const next = createSessionTranscript({
      repository: {
        ...repository,
        writeTranscriptCheckpoint: (...args) => {
          checkpoints.push(args[1]);
          return repository.writeTranscriptCheckpoint(...args);
        },
      },
      supervisor: { peekEntry: () => entry, getRuntime: () => runtime },
      getLiveAgentEntry: async () => entry,
      normalizeSessionId: value => String(value || "").trim(),
      resolveToolDefinition: () => null,
      getToolIdentity: () => ({}),
    });
    owners.push(next);
    return next;
  };
  const transcript = owner();
  transcript.set(sessionId, initial.transcript.slice(0, -1), initial.transcript.slice(-1));
  const emit = event => transcript.recordEvent(sessionId, { runId: "new-run", spanId: "new-answer", ...event });
  const saved = async () => readSessionRecord(await repository.readRecord(sessionId), { repairTools: false });
  const writes = () => storage.writes.filter(write => write.type === "set"
    && (write.patch[recordKey(sessionId)] || write.patch[`${SESSION_TRANSCRIPT_CHECKPOINT_PREFIX}${sessionId}`]));
  t.after(() => owners.forEach(item => item.remove(sessionId)));
  return { messages, initial, storage, repository, transcript, emit, saved, writes, owner, checkpoints,
    revoke: () => { active = false; }, exports: () => exports };
}

test("continuous streaming checkpoints the latest display every second without exporting model history", async t => {
  const f = fixture(t);
  for (let window = 0; window < 2; window++) {
    f.emit({ type: "message_update", content: `window-${window}-0` });
    for (let delta = 1; delta <= 4; delta++) {
      t.mock.timers.tick(200);
      f.emit({ type: "message_update", content: `window-${window}-${delta}` });
    }
    t.mock.timers.tick(199);
    await f.repository.flush();
    assert.equal(f.writes().length, window, "later deltas must neither write per token nor postpone the first deadline");
    assert.equal(f.exports(), 0, "display checkpoints must not export model history");
    t.mock.timers.tick(1);
    await f.repository.flush();
    const saved = await f.saved();
    assert.deepEqual(saved.transcript.slice(0, -1), f.initial.transcript);
    assert.equal(saved.transcript.at(-1).content, `window-${window}-4`);
    assert.equal(f.writes().length, window + 1);
  }
  assert.equal(f.exports(), 0);
});

const interrupted = {
  status: "interrupted", runId: "new-run", reason: "service_worker_restarted", endedAt: "2026-10-20 12:00:00",
};

async function restartAfterPartial(t, f) {
  f.emit({ type: "thinking_update", thinking: "partial reasoning" });
  f.emit({ type: "message_update", content: "partial answer" });
  t.mock.timers.tick(1000);
  await f.repository.flush();
  f.transcript.remove(sessionId);
  const owner = f.owner(interrupted);
  return { owner, restored: await owner.hydrate(sessionId) };
}

test("a new transcript owner restores checkpointed partial content and one interruption notice", async t => {
  const f = fixture(t);
  const { owner, restored } = await restartAfterPartial(t, f);
  assert.deepEqual(restored.slice(0, f.initial.transcript.length), f.initial.transcript);
  assert.deepEqual(restored.slice(f.initial.transcript.length, -1).map(entry => entry.text || entry.content),
    ["partial reasoning", "partial answer"]);
  assert.ok(restored.every(entry => !entry.streaming && !entry.isRunning));
  assert.equal(restored.filter(entry => entry.type === "run-status").length, 1);
  assert.equal(restored.at(-1).status, "interrupted");
  assert.equal(restored.at(-1).runId, interrupted.runId);
  assert.equal(restored.at(-1).reason, interrupted.reason);
  assert.equal(await owner.hydrate(sessionId), restored);
  assert.deepEqual(owner.snapshot(sessionId).current, [], "interrupted recovery archives the settled current turn");
  await owner.checkpoint(sessionId);
  await f.repository.flush();
  owner.remove(sessionId);
  assert.deepEqual(await owner.hydrate(sessionId), restored, "persisted recovery does not add a second notice");
  assert.equal(f.exports(), 0, "checkpointing and hydrating display history must not export or resume the live Agent");
  assert.equal((await f.saved()).conversation.entries.at(-1).message.content, "new question",
    "the partial answer exists only in the saved display snapshot");
});

test("continuing after recovery preserves the previous interruption notice through completion and another restart", async t => {
  const f = fixture(t);
  const { owner, restored } = await restartAfterPartial(t, f);
  const notice = restored.at(-1);
  owner.recordEvent(sessionId, { type: "agent_end", runId: interrupted.runId });
  const request = user("continue", "continued-user");
  f.messages.push(request);
  owner.recordEvent(sessionId, { type: "message_start", runId: "continued-run", message: request });
  f.messages.push(assistant("continued answer"));
  owner.recordEvent(sessionId, { type: "message_end", runId: "continued-run", spanId: "continued-answer", message: f.messages.at(-1) });
  owner.recordEvent(sessionId, { type: "agent_end", runId: "continued-run" });
  await f.repository.flush();
  owner.remove(sessionId);
  const again = await f.owner({ status: "completed", runId: "continued-run" }).hydrate(sessionId);
  assert.deepEqual(again.slice(0, restored.length), restored);
  assert.deepEqual(again.filter(entry => entry.type === "run-status"), [notice]);
  assert.deepEqual(again.slice(restored.length).map(entry => entry.text || entry.content), ["continue", "continued answer"]);
});

for (const event of [
  { type: "message_end", message: assistant("complete answer") },
  { type: "tool_execution_end", toolCallId: "new-tool", toolName: "lookup", args: { query: "new" }, result: { ok: true, _image: image } },
  { type: "waiting_for_user", waitId: "new-wait", message: "Please confirm", form: { title: "Confirm" } },
  { type: "error", message: "Provider failed" },
  { type: "reset" },
]) {
  test(`${event.type} immediately checkpoints display state and cancels its stream timer`, async t => {
    const f = fixture(t);
    f.emit({ type: "thinking_update", spanId: "current-thinking", thinking: "new thinking" });
    f.emit({ type: "message_update", content: "partial answer" });
    if (event.type === "message_end") f.messages.push(event.message);
    f.emit(event);
    await f.repository.flush();
    const saved = await f.saved();
    assert.deepEqual(saved.transcript, createSessionRecord(f.messages, f.transcript.getCached(sessionId)).transcript);
    assert.equal(f.writes().length, 1, "semantic completion must persist before any timer advances");
    if (event.type === "reset") assert.deepEqual(saved.transcript, []);
    else {
      assert.deepEqual(saved.transcript.slice(0, f.initial.transcript.length), f.initial.transcript);
      assert.ok(saved.transcript.some(entry => entry.text === "new thinking"));
    }
    if (event.type === "tool_execution_end") assert.equal(saved.transcript.at(-1).image, image);
    t.mock.timers.tick(1000);
    await f.repository.flush();
    assert.equal(f.writes().length, 1, "the superseded timer cannot write a second snapshot");
    assert.equal(f.exports(), 0);
  });
}

test("semantic checkpoints capture display synchronously while model history remains independent", async t => {
  const f = fixture(t);
  f.messages.push(assistant("first complete answer"));
  f.emit({ type: "message_end", message: f.messages.at(-1) });
  f.messages.push(user("later question", "later-user"));
  f.emit({ type: "message_update", spanId: "later-answer", content: "later partial answer" });
  await f.repository.flush();
  const saved = await f.saved();
  assert.equal(saved.conversation.entries.at(-1).message.content, "new question");
  assert.equal(saved.transcript.at(-1).content, "first complete answer");
  assert.equal(f.writes().length, 1);
  assert.equal(f.exports(), 0);
});

test("later finalization cannot mutate a previously captured display checkpoint", async t => {
  const f = fixture(t);
  f.emit({ type: "message_update", content: "partial answer" });
  f.emit({ type: "tool_execution_start", toolCallId: "running-tool", toolName: "lookup", args: {} });
  const captured = f.checkpoints.at(-1);
  const expected = structuredClone(captured);
  f.emit({ type: "agent_end" });
  assert.deepEqual(captured, expected);
  assert.ok(captured.current.some(entry => entry.type === "assistant" && entry.streaming));
  assert.ok(captured.current.some(entry => entry.type === "tool" && entry.isRunning));
  await f.repository.flush();
  assert.deepEqual((await f.saved()).transcript, createSessionRecord(null, [...expected.history, ...expected.current]).transcript);
  assert.equal(f.exports(), 0);
});

for (const action of ["set", "remove"]) {
  test(`${action} cancels a pending stream checkpoint`, async t => {
    const f = fixture(t);
    f.emit({ type: "message_update", content: "discarded partial answer" });
    if (action === "set") f.transcript.set(sessionId, [{ type: "assistant", content: "replacement" }]);
    else f.transcript.remove(sessionId);
    t.mock.timers.tick(1000);
    await f.repository.flush();
    assert.equal(f.writes().length, 0);
    assert.deepEqual(await f.repository.readRecord(sessionId), f.initial);
  });
}

test("agent_end cancels the stream timer so the host's terminal record remains authoritative", async t => {
  const f = fixture(t);
  f.emit({ type: "message_update", content: "partial answer" });
  f.emit({ type: "agent_end" });
  const terminal = createSessionRecord(f.messages, [...f.transcript.getCached(sessionId), { type: "note", text: "terminal commit" }]);
  await f.repository.writeRecord(sessionId, terminal);
  t.mock.timers.tick(1000);
  await f.repository.flush();
  assert.equal(f.writes().length, 1);
  assert.deepEqual(await f.repository.readRecord(sessionId), terminal);
});

test("each completed run archives its current turn once and keeps later runs separate", async t => {
  const f = fixture(t);
  let history = f.transcript.snapshot(sessionId).history;
  for (let round = 0; round < 3; round++) {
    const runId = `round-${round}`;
    if (round) f.emit({ type: "message_start", runId, message: user(`question ${round}`, `user-${round}`) });
    f.emit({ type: "message_end", runId, spanId: `answer-${round}`, message: assistant(`answer ${round}`) });
    const pending = f.transcript.snapshot(sessionId);
    assert.strictEqual(pending.history, history, "current events leave the history segment intact");
    assert.equal(pending.current.length, 2);
    f.emit({ type: "agent_end", runId });
    const finished = f.transcript.snapshot(sessionId);
    assert.deepEqual(finished.history, [...history, ...pending.current]);
    assert.deepEqual(finished.current, []);
    f.transcript.finish(sessionId);
    assert.deepEqual(f.transcript.snapshot(sessionId), finished, "finishing twice never duplicates a turn");
    history = finished.history;
  }
  assert.deepEqual(f.transcript.getCached(sessionId), history);
  await f.repository.flush();
});

test("steering messages stay inside the current run until it ends", async t => {
  const f = fixture(t);
  const history = f.transcript.snapshot(sessionId).history;
  f.emit({ type: "message_end", spanId: "before-steer", message: assistant("before steering") });
  f.emit({ type: "message_start", message: user("use a different source", "steer-user") });
  f.emit({ type: "message_end", spanId: "after-steer", message: assistant("after steering") });
  const pending = f.transcript.snapshot(sessionId);
  assert.strictEqual(pending.history, history);
  assert.deepEqual(pending.current.map(entry => entry.text || entry.content),
    ["new question", "before steering", "use a different source", "after steering"]);
  assert.equal(pending.current.filter(entry => entry.type === "user").length, 2);
  f.emit({ type: "agent_end" });
  assert.deepEqual(f.transcript.snapshot(sessionId).current, []);
  assert.deepEqual(f.transcript.getCached(sessionId), [...history, ...pending.current]);
  await f.repository.flush();
});

test("repeated UI checkpoints keep one partial assistant in the current turn", async t => {
  const f = fixture(t);
  const history = f.transcript.snapshot(sessionId).history;
  for (const content of ["partial", "partial answer", "partial answer continued"]) {
    f.emit({ type: "message_update", content });
    await f.transcript.checkpoint(sessionId);
    await f.repository.flush();
    const state = f.transcript.snapshot(sessionId);
    assert.strictEqual(state.history, history, "saving does not archive the live turn");
    assert.equal(state.current.filter(entry => entry.type === "assistant").length, 1);
    assert.equal(state.current.at(-1).content, content);
    assert.equal(state.current.at(-1).streaming, true);
    assert.deepEqual((await f.saved()).transcript, createSessionRecord(null, [...history, ...state.current]).transcript);
  }
  f.emit({ type: "message_end", message: assistant("final answer") });
  assert.deepEqual(f.transcript.snapshot(sessionId).current.filter(entry => entry.type === "assistant").map(entry => entry.content),
    ["final answer"]);
  await f.repository.flush();
});

test("an edited last user in the current segment receives the newly allocated run identity", async t => {
  const f = fixture(t);
  const history = f.transcript.snapshot(sessionId).history;
  f.transcript.set(sessionId, history, [{ type: "user", text: "edited question", clientMessageId: "new-user" }]);
  f.emit({ type: "agent_start", runId: "edited-run", clientMessageId: "new-user", eventSeq: 1 });
  const state = f.transcript.snapshot(sessionId);
  assert.deepEqual(state.history, history);
  assert.deepEqual(state.current.map(entry => [entry.text, entry.clientMessageId, entry.runId, entry.eventSeq]),
    [["edited question", "new-user", "edited-run", 1]]);
  await f.repository.flush();
  assert.equal((await f.saved()).transcript.at(-1).runId, "edited-run");
});

test("an unscoped terminal event only settles current entries and never rewrites history", async t => {
  const f = fixture(t);
  const old = [
    ...f.initial.transcript.slice(0, -1),
    { type: "assistant", content: "historical partial", streaming: true },
    { type: "tool", toolCallId: "historical-tool", name: "lookup", isRunning: true, result: null },
    { type: "compact", compactId: "historical-compact", status: "running" },
  ];
  f.transcript.set(sessionId, old, f.initial.transcript.slice(-1));
  f.emit({ type: "message_update", content: "current partial" });
  const history = f.transcript.snapshot(sessionId).history;
  const before = structuredClone(history);
  history.forEach(Object.freeze);
  f.transcript.recordEvent(sessionId, { type: "state", status: "interrupted" });
  const settled = f.transcript.snapshot(sessionId);
  assert.strictEqual(settled.history, history);
  assert.deepEqual(settled.history, before);
  assert.equal(settled.current.find(entry => entry.type === "assistant").streaming, undefined);
  assert.equal(settled.current.at(-1).status, "interrupted");
  await f.repository.flush();
});

for (const queued of [false, true]) {
  test(`a revoked lease drops a checkpoint ${queued ? "waiting behind another record write" : "during asynchronous storage validation"}`, async t => {
    const f = fixture(t);
    const originalGet = f.storage.get;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    let block = true;
    f.storage.get = async keys => {
      if (block && Array.isArray(keys)) {
        block = false;
        entered();
        await gate;
      }
      return originalGet(keys);
    };
    const first = queued ? f.repository.writeRecord(sessionId, f.initial) : null;
    if (queued) await waiting;
    f.emit({ type: "message_end", message: assistant("stale answer") });
    if (!queued) await waiting;
    f.revoke();
    release();
    await first;
    await f.repository.flush();
    assert.equal(f.writes().length, queued ? 1 : 0);
    assert.deepEqual(await f.repository.readRecord(sessionId), f.initial);
  });
}

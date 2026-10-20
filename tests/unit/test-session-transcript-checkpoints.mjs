import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRepository } from "../../src/background/session/repository.js";
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
  const owner = (runtime = { status: "running" }) => {
    const next = createSessionTranscript({
      repository,
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
  transcript.set(sessionId, initial.transcript);
  const emit = event => transcript.recordEvent(sessionId, { runId: "new-run", spanId: "new-answer", ...event });
  const saved = async () => readSessionRecord(await repository.readRecord(sessionId), { repairTools: false });
  const writes = () => storage.writes.filter(write => write.type === "set" && write.patch[recordKey(sessionId)]);
  t.after(() => owners.forEach(item => item.remove(sessionId)));
  return { messages, initial, storage, repository, transcript, emit, saved, writes, owner,
    revoke: () => { active = false; }, exports: () => exports };
}

test("continuous streaming checkpoints the latest full transcript every second without waiting for silence", async t => {
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
    assert.equal(f.exports(), window, "the full model history is exported only at a checkpoint");
    t.mock.timers.tick(1);
    await f.repository.flush();
    const saved = await f.saved();
    assert.deepEqual(saved.transcript.slice(0, -1), f.initial.transcript);
    assert.equal(saved.transcript.at(-1).content, `window-${window}-4`);
    assert.equal(f.writes().length, window + 1);
  }
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
  assert.equal(f.exports(), 1, "hydrating display history must not export or resume the live Agent");
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
  test(`${event.type} immediately checkpoints the complete display snapshot and cancels its stream timer`, async t => {
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
  });
}

test("semantic checkpoints capture model and display synchronously before queued storage work", async t => {
  const f = fixture(t);
  f.messages.push(assistant("first complete answer"));
  f.emit({ type: "message_end", message: f.messages.at(-1) });
  f.messages.push(user("later question", "later-user"));
  f.emit({ type: "message_update", spanId: "later-answer", content: "later partial answer" });
  await f.repository.flush();
  const saved = await f.saved();
  assert.equal(saved.conversation.entries.at(-1).message.content, "first complete answer");
  assert.equal(saved.transcript.at(-1).content, "first complete answer");
  assert.equal(f.writes().length, 1);
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

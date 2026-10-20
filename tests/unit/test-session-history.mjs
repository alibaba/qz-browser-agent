import assert from "node:assert/strict";
import test from "node:test";
import { readStoredTranscript } from "../../src/shared/session/session-history.js";
import { readCheckpointRecord } from "../../src/shared/session/session-recovery.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

function fixture(t, seed) {
  const previous = globalThis.chrome;
  const storage = createMemoryStorage(seed);
  globalThis.chrome = { storage: { local: storage } };
  t.after(() => { globalThis.chrome = previous; });
  return storage;
}

const conversation = content => [{ role: "user", content }];
const record = transcript => ({ type: "qz-browser-agent-session", version: 4, transcript });

test("saved display snapshot takes precedence over active model history without rewriting storage", async t => {
  const storage = fixture(t, {
    _session_task: { ...record([{ type: "user", text: "stored" }]), conversation: conversation("saved conversation") },
    _active_conversation_task: conversation("active conversation"),
  });
  const before = storage.snapshot();
  const reads = t.mock.method(storage, "get");
  const result = await readStoredTranscript(" task ");
  assert.deepEqual(result, [{ type: "user", text: "stored", images: [], documents: [] }]);
  assert.equal(reads.mock.callCount(), 1);
  assert.deepEqual(storage.snapshot(), before);
  assert.deepEqual(storage.writes, []);
});

test("stored history reads current content once, including empty overrides and obsolete revisions", async t => {
  const storage = fixture(t, {
    _session_task: {
      ...record([{ type: "assistant", content: "old" }]), transcriptRevision: "base",
      currentTranscript: [{ type: "assistant", content: "initial current" }],
    },
  });
  assert.deepEqual((await readStoredTranscript("task")).map(entry => entry.content), ["old", "initial current"]);
  await storage.set({ _session_transcript_checkpoint_task: { version: 2, baseRevision: "base", transcript: [] } });
  assert.deepEqual((await readStoredTranscript("task")).map(entry => entry.content), ["old"]);
  await storage.set({ _session_transcript_checkpoint_task: {
    version: 2, baseRevision: "base",
    transcript: [{ type: "thinking", text: "partial reasoning" }, { type: "error", text: "provider failed" }],
  } });
  storage.writes.length = 0;
  assert.deepEqual((await readStoredTranscript("task")).map(entry => entry.text || entry.content),
    ["old", "partial reasoning", "provider failed"]);
  const raw = storage.snapshot();
  const merged = readCheckpointRecord(raw._session_task, raw._session_transcript_checkpoint_task);
  assert.deepEqual(readCheckpointRecord(merged, raw._session_transcript_checkpoint_task), merged,
    "reading an already projected record must not append current content twice");
  assert.equal(merged.currentTranscript, undefined);
  assert.equal(merged.transcriptRevision, undefined);
  assert.deepEqual(storage.writes, []);
  await storage.set({ _session_task: { ...record([]), transcriptRevision: "edited" } });
  assert.deepEqual(await readStoredTranscript("task"), [], "a stale checkpoint must not undo an edit");
});

test("without a display snapshot, active conversation takes precedence over a legacy record conversation", async t => {
  const storage = fixture(t, {
    _session_task: { type: "qz-browser-agent-session", version: 3, conversation: conversation("legacy record") },
    _active_conversation_task: conversation("active conversation"),
  });
  assert.equal((await readStoredTranscript("task"))[0].text, "active conversation");
  assert.deepEqual(storage.writes, []);
  await storage.remove("_active_conversation_task");
  storage.writes.length = 0;
  assert.equal((await readStoredTranscript("task"))[0].text, "legacy record");
  assert.deepEqual(storage.writes, []);
});

for (const wrap of [messages => messages, messages => ({ messages }), messages => ({ entries: messages.map(message => ({ message })) })]) {
  test("historical active conversation formats restore only without a saved display snapshot", async t => {
    const storage = fixture(t, { _active_conversation_task: wrap(conversation("legacy active")) });
    assert.equal((await readStoredTranscript("task"))[0].text, "legacy active");
    await storage.set({ _session_task: record([]) });
    storage.writes.length = 0;
    assert.deepEqual(await readStoredTranscript("task"), []);
    assert.deepEqual(storage.writes, []);
  });
}

test("absent history is empty, and invalid session identity never touches storage", async t => {
  const storage = fixture(t, {});
  const reads = t.mock.method(storage, "get");
  for (const id of [undefined, null, " ", 42, {}]) assert.deepEqual(await readStoredTranscript(id), []);
  assert.equal(reads.mock.callCount(), 0);
  assert.deepEqual(await readStoredTranscript("missing"), []);
  assert.equal(reads.mock.callCount(), 1);
});

test("unrecognized stored versions block fallback instead of becoming empty history", async t => {
  const storage = fixture(t, {
    _session_task: { ...record([]), version: 99 },
    _active_conversation_task: conversation("must not hide incompatible record"),
  });
  await assert.rejects(readStoredTranscript("task"), { code: "UNSUPPORTED_SESSION_RECORD_VERSION" });
  await storage.remove("_session_task");
  await storage.set({ _active_conversation_task: { type: "conversation", version: 99, entries: [] } });
  storage.writes.length = 0;
  await assert.rejects(readStoredTranscript("task"), { code: "UNSUPPORTED_CONVERSATION_VERSION" });
  assert.deepEqual(storage.writes, []);
});

test("storage failure propagates without rewriting history", async t => {
  const storage = fixture(t, {});
  t.mock.method(storage, "get", async () => { throw new Error("storage unavailable"); });
  await assert.rejects(readStoredTranscript("task"), /storage unavailable/);
  assert.deepEqual(storage.writes, []);
});

for (const cancelAt of [0, 1]) {
  test(`cancellation at read boundary ${cancelAt} cannot return late history`, async t => {
    const storage = fixture(t, { _active_conversation_task: conversation("late result") });
    const controller = new AbortController();
    const cancelled = new Error("history view was closed");
    const get = storage.get;
    let reads = 0;
    t.mock.method(storage, "get", async keys => {
      reads += 1;
      const result = await get(keys);
      if (reads === cancelAt) controller.abort(cancelled);
      return result;
    });
    if (cancelAt === 0) controller.abort(cancelled);
    await assert.rejects(readStoredTranscript("task", controller.signal), error => error === cancelled);
    assert.equal(reads, cancelAt);
    assert.deepEqual(storage.writes, []);
  });
}

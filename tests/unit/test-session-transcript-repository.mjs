import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionRepository, DeletedSessionWriteError, StaleSessionLeaseError,
  SESSION_TRANSCRIPT_CHECKPOINT_PREFIX,
} from "../../src/background/session/repository.js";
import { createSessionRecord } from "../../src/shared/session/session-codec.js";
import { SessionFormatError } from "../../src/shared/session/session-format.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";

import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";
import { resolveSessionImages } from "../../src/shared/session/session-image-assets.js";
const assets = installImageAssetsFixture();
test.after(() => assets.dispose());

const id = "display-checkpoint";
const baseKey = `_session_${id}`;
const checkpointKey = `${SESSION_TRANSCRIPT_CHECKPOINT_PREFIX}${id}`;
const image = `data:image/png;base64,${"A".repeat(128 * 1024)}`;
const answer = content => ({ type: "assistant", content, spanId: "current" });
const normalize = transcript => createSessionRecord(null, transcript).transcript;

function fixture() {
  const initial = createSessionRecord([
    { role: "user", content: "same question" }, { role: "assistant", content: "same answer" },
  ], [
    { type: "user", text: "same question", clientMessageId: "first" },
    { type: "thinking", text: "saved reasoning", spanId: "reasoning" },
    { type: "tool", name: "screenshot", toolCallId: "shot", args: { tabId: 7 }, result: { ok: true }, image },
    { type: "assistant", content: "same answer", spanId: "old-answer" },
    { type: "error", text: "HTTP 401: saved provider failure" },
    { type: "run-status", status: "interrupted", reason: "service_worker_restarted", runId: "old-run" },
  ]);
  const storage = createMemoryStorage({ [baseKey]: initial });
  const repository = createSessionRepository({ storage });
  let active = true;
  const lease = { sessionId: id, isActive: () => active };
  const write = current => repository.writeTranscriptCheckpoint(id, { history: initial.transcript, current }, lease);
  return { initial, storage, repository, lease, write, revoke: () => { active = false; } };
}

function blockNextSet(storage) {
  const set = storage.set;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked = false;
  storage.set = async patch => {
    if (!blocked && (patch[baseKey] || patch[checkpointKey])) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    return set(patch);
  };
  return { entered: entered.promise, release: release.resolve };
}

test("current checkpoints retain rich history across restart without rewriting old images or model history", async () => {
  const f = fixture();
  const first = [answer("first partial")];
  await f.write(first);
  const base = f.storage.snapshot()[baseKey];
  assert.deepEqual(await resolveSessionImages(base.transcript), f.initial.transcript);
  assert.ok(!JSON.stringify(base.transcript).includes("data:image/"));
  assert.deepEqual(base.currentTranscript, normalize(first));
  assert.equal(f.storage.snapshot()[checkpointKey], undefined, "the first complete snapshot uses one storage key");
  const before = f.storage.writes.length;
  const latest = [answer("latest partial")];
  await f.write(latest);
  const writes = f.storage.writes.slice(before).filter(write => write.type === "set");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch[baseKey], undefined);
  assert.ok(!JSON.stringify(writes[0].patch).includes(image), "old display images belong only in the baseline");
  const checkpoint = f.storage.snapshot()[checkpointKey];
  assert.deepEqual(checkpoint, { version: 2, baseRevision: base.transcriptRevision, transcript: normalize(latest) });
  const restored = await createSessionRepository({ storage: f.storage }).readRecord(id);
  assert.deepEqual(restored.transcript, [...f.initial.transcript, ...normalize(latest)]);
  assert.deepEqual(restored.conversation, f.initial.conversation);
  assert.equal(restored.transcriptRevision, undefined);
  assert.equal(restored.currentTranscript, undefined);
});

test("current tool edits and empty checkpoints replace the entire current turn", async () => {
  const f = fixture();
  const tool = { type: "tool", name: "list_tabs", toolCallId: "current-tabs", args: {}, isRunning: true };
  await f.write([{ type: "user", text: "same question" }, answer(""), tool, answer("before")]);
  const current = [{ ...tool, isRunning: false, result: { tabs: [] } }, answer(""), answer("same answer")];
  await f.write(current);
  assert.deepEqual((await createSessionRepository({ storage: f.storage }).readRecord(id)).transcript,
    [...f.initial.transcript, ...normalize(current)]);
  await f.write([]);
  assert.deepEqual(f.storage.snapshot()[checkpointKey].transcript, []);
  assert.deepEqual((await createSessionRepository({ storage: f.storage }).readRecord(id)).transcript, f.initial.transcript);
});

test("a blocked write coalesces sixty updates into one pending write and persists the latest", async () => {
  const f = fixture();
  await f.write([answer("initial")]);
  const before = f.storage.writes.length;
  const gate = blockNextSet(f.storage);
  const active = f.write([answer("active")]);
  await gate.entered;
  const pending = Array.from({ length: 60 }, (_, index) => f.write([answer(`pending-${index}`)]));
  assert.equal(new Set(pending).size, 1, "same-base pending updates share one operation");
  assert.notEqual(pending[0], active);
  gate.release();
  await Promise.all([active, ...pending]);
  await f.repository.flush();
  assert.equal(f.storage.writes.slice(before).filter(write => write.type === "set").length, 2);
  assert.equal((await f.repository.readRecord(id)).transcript.at(-1).content, "pending-59");
});

for (const action of ["terminal full write", "edit truncation", "delete"]) {
  test(`${action} supersedes an active and pending checkpoint`, async () => {
    const f = fixture();
    const raw = [answer("base")];
    await f.write(raw);
    const gate = blockNextSet(f.storage);
    const active = f.write([answer("old active")]);
    await gate.entered;
    const pending = f.write([answer("old pending")]);
    const settled = Promise.allSettled([active, pending]);
    const replacement = createSessionRecord(f.initial.conversation,
      action === "edit truncation" ? f.initial.transcript.slice(0, 1) : [...f.initial.transcript, answer("terminal")]);
    const barrier = action === "delete"
      ? f.repository.deleteSession(id) : f.repository.writeRecord(id, replacement);
    gate.release();
    await Promise.all([settled, barrier]);
    await f.repository.flush();
    assert.ok(f.storage.snapshot()[checkpointKey] == null);
    assert.deepEqual(await createSessionRepository({ storage: f.storage }).readRecord(id), action === "delete" ? null : replacement);
    if (action === "delete") await assert.rejects(async () => f.write(raw), DeletedSessionWriteError);
  });
}

test("revoking a lease while checkpoint validation is blocked prevents the write", async () => {
  const f = fixture();
  const get = f.storage.get;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let block = true;
  f.storage.get = async keys => {
    if (block) { block = false; entered.resolve(); await release.promise; }
    return get(keys);
  };
  const pending = f.write([answer("stale")]);
  const rejected = assert.rejects(pending, StaleSessionLeaseError);
  await entered.promise;
  f.revoke();
  release.resolve();
  await rejected;
  assert.deepEqual(await f.repository.readRecord(id), f.initial);
  assert.equal(f.storage.writes.length, 0);
});

for (const stage of ["base", "current"]) {
  test(`a failed ${stage} checkpoint can retry without exposing uncommitted content`, async () => {
    const f = fixture();
    if (stage === "current") await f.write([answer("before failure")]);
    const before = await f.repository.readRecord(id);
    const set = f.storage.set;
    let fail = true;
    f.storage.set = async patch => {
      if (fail) { fail = false; throw new Error("checkpoint storage failed"); }
      return set(patch);
    };
    const next = [answer("recovered")];
    await assert.rejects(f.write(next), /checkpoint storage failed/);
    assert.deepEqual(await createSessionRepository({ storage: f.storage }).readRecord(id), before);
    await f.write(next);
    assert.deepEqual((await createSessionRepository({ storage: f.storage }).readRecord(id)).transcript,
      [...f.initial.transcript, ...normalize(next)]);
  });
}

test("a terminal full write adopts its explicit saved history for the next turn", async () => {
  const f = fixture();
  await f.write([answer("partial")]);
  const history = [...f.initial.transcript, answer("completed")];
  const terminal = createSessionRecord(f.initial.conversation, history);
  const saved = f.repository.writeRecord(id, terminal, f.lease, history);
  const current = [{ type: "user", text: "next question" }, answer("next partial")];
  const next = f.repository.writeTranscriptCheckpoint(id, { history, current }, f.lease);
  await Promise.all([saved, next]);
  assert.deepEqual((await f.repository.readRecord(id)).transcript, [...normalize(history), ...normalize(current)]);
  const before = f.storage.writes.length;
  await f.repository.writeTranscriptCheckpoint(id, { history, current: [answer("latest")] }, f.lease);
  const sets = f.storage.writes.filter(write => write.type === "set");
  assert.deepEqual(sets.slice(1).map(write => Object.keys(write.patch)), [[baseKey], [checkpointKey], [checkpointKey]],
    "the full save writes history once; both next-turn checkpoints write only current content");
  assert.ok(!JSON.stringify(f.storage.writes.slice(before)).includes(image));
  assert.deepEqual((await createSessionRepository({ storage: f.storage }).readRecord(id)).transcript,
    [...normalize(history), ...normalize([answer("latest")])]);
});

test("an explicit edit preserves current user content and later checkpoints update only current", async () => {
  const f = fixture();
  const history = f.initial.transcript;
  const editedUser = { type: "user", text: "edited question", clientMessageId: "edited-user" };
  const edited = { ...createSessionRecord(f.initial.conversation, history), currentTranscript: normalize([editedUser]) };
  await f.repository.writeRecord(id, edited, undefined, history);
  const saved = await createSessionRepository({ storage: f.storage }).readRecord(id);
  assert.deepEqual(saved.transcript, [...history, ...normalize([editedUser])]);
  assert.deepEqual(saved.conversation, f.initial.conversation);
  const before = f.storage.writes.length;
  const current = [{ ...editedUser, runId: "edited-run" }, { ...answer("edited answer"), runId: "edited-run" }];
  await f.repository.writeTranscriptCheckpoint(id, { history, current }, f.lease);
  assert.deepEqual(f.storage.writes.slice(before).map(write => Object.keys(write.patch)), [[checkpointKey]]);
  const restored = await createSessionRepository({ storage: f.storage }).readRecord(id);
  assert.deepEqual(restored.transcript, [...history, ...normalize(current)]);
  assert.deepEqual(restored.conversation, f.initial.conversation);
});

test("a full record remains authoritative when clearing its obsolete checkpoint fails", async () => {
  const f = fixture();
  await f.write([answer("old base")]);
  await f.write([answer("old current")]);
  const oldCheckpoint = f.storage.snapshot()[checkpointKey];
  const remove = f.storage.remove;
  let fail = true;
  f.storage.remove = async keys => {
    if ([keys].flat().includes(checkpointKey) && fail) { fail = false; throw new Error("checkpoint cleanup failed"); }
    return remove(keys);
  };
  const terminal = createSessionRecord(f.initial.conversation, [...f.initial.transcript, answer("terminal answer")]);
  await assert.rejects(f.repository.writeRecord(id, terminal), /checkpoint cleanup failed/);
  assert.deepEqual(f.storage.snapshot()[checkpointKey], oldCheckpoint);
  assert.deepEqual(await createSessionRepository({ storage: f.storage }).readRecord(id), terminal);
  await f.repository.writeRecord(id, terminal);
  assert.equal(f.storage.snapshot()[checkpointKey], undefined);
  assert.deepEqual(await createSessionRepository({ storage: f.storage }).readRecord(id), terminal);
});

test("restart rejects unknown checkpoint formats and ignores current content belonging to another base", async () => {
  const f = fixture();
  const raw = [answer("base")];
  await f.write(raw);
  await f.write([answer("current")]);
  const checkpoint = f.storage.snapshot()[checkpointKey];
  await f.storage.set({ [checkpointKey]: { ...checkpoint, baseRevision: "obsolete" } });
  assert.deepEqual((await createSessionRepository({ storage: f.storage }).readRecord(id)).transcript,
    [...f.initial.transcript, ...normalize(raw)]);
  for (const invalid of [
    { ...checkpoint, version: 1 },
    { ...checkpoint, version: 3 },
    { ...checkpoint, transcript: null },
    { ...checkpoint, baseRevision: "" },
  ]) {
    await f.storage.set({ [checkpointKey]: invalid });
    await assert.rejects(createSessionRepository({ storage: f.storage }).readRecord(id), SessionFormatError);
  }
});

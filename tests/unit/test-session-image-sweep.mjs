import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRepository } from "../../src/background/session/repository.js";
import { createSessionImageStorage, persistSessionImages } from "../../src/shared/session/session-image-assets.js";
import { createSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import { getHistoryImage, saveHistoryImage } from "../../src/shared/asset-store.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";
const image = "data:image/png;base64,AAAA";
const message = url => ({ role: "user", content: [{ type: "image_url", image_url: { url } }] });
const lease = sessionId => ({ sessionId, isActive: () => true });
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t) {
  const assets = installImageAssetsFixture();
  t.after(() => assets.dispose());
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  return { assets, storage, repository };
}

test("sweep marks every persisted key, including active/current checkpoints and unknown future keys", async t => {
  const f = setup(t);
  const reference = await saveHistoryImage(image);
  for (const key of ["_active_conversation_keeper", "_session_transcript_checkpoint_keeper", "_future_session_data"]) {
    await f.storage.set({ [key]: { image: reference } });
    await f.repository.deleteSession("unrelated");
    assert.equal(await getHistoryImage(reference), image);
    await f.storage.remove(key);
  }
  await f.repository.deleteSession("unrelated");
  assert.equal(await getHistoryImage(reference), null);
});

test("a prepared conversation is protected between preparation and its queued commit", async t => {
  const f = setup(t);
  const prepared = await f.repository.prepareConversation("pending", [message(image)], lease("pending"));
  await f.repository.deleteSession("other");
  await f.repository.writeActiveConversation("pending", prepared, lease("pending"));
  assert.equal((await f.repository.readActiveConversation("pending")).entries[0].message.content[0].image_url.url, image);
  await f.repository.deleteSession("pending");
  assert.equal(f.assets.stores.get("history_images").rows.size, 0);
});

test("a concurrent persist waits behind sweep and re-creates a swept cached image", async t => {
  const f = setup(t);
  await f.repository.writeRecord("old", createSessionRecord([message(image)], []));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const get = f.storage.get;
  f.storage.get = async keys => {
    if (keys === null) { entered.resolve(); await release.promise; }
    return get(keys);
  };
  const deleting = f.repository.deleteSession("old");
  await entered.promise;
  let committed = false;
  const writing = f.repository.writeRecord("new", createSessionRecord([message(image)], []))
    .then(() => { committed = true; });
  await tick();
  assert.equal(committed, false);
  release.resolve();
  await Promise.all([deleting, writing]);
  assert.equal((await f.repository.readRecord("new")).conversation.entries[0].message.content[0].image_url.url, image);
});

test("sweep waits for in-flight image hashing and marks its completed storage write", async t => {
  const f = setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "digest", async (...args) => { entered.resolve(); await release.promise; return digest(...args); });
  const writing = f.repository.writeRecord("new", createSessionRecord([message(image)], []));
  await entered.promise;
  const deleting = f.repository.deleteSession("other");
  release.resolve();
  await Promise.all([writing, deleting]);
  assert.equal((await f.repository.readRecord("new")).conversation.entries[0].message.content[0].image_url.url, image);
});

test("failed marking preserves all assets and releases the sweep barrier", async t => {
  const f = setup(t);
  const reference = await saveHistoryImage(image);
  const get = f.storage.get;
  f.storage.get = async keys => { if (keys === null) throw new Error("read unavailable"); return get(keys); };
  await f.repository.deleteSession("other");
  assert.equal(await getHistoryImage(reference), image);
  await f.repository.writeRecord("new", createSessionRecord([message(image)], []));
});

test("fresh transcript checkpoints: measure SHA-256 volume over 60 image turns", async t => {
  const f = setup(t);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let hashed = 0, hashes = 0;
  t.mock.method(crypto.subtle, "digest", (...args) => {
    hashed += args[1].byteLength; hashes++;
    return digest(...args);
  });
  const measurements = {};
  for (const mode of ["before", "after"]) {
    const current = [], history = [];
    hashed = 0; hashes = 0; persistSessionImages.clear();
    for (let turn = 0; turn < 60; turn++) {
      const dataUrl = `data:image/png;base64,${Buffer.alloc(256 * 1024, turn).toString("base64")}`;
      current.push({ type: "user", text: `image ${turn}`, images: [{ dataUrl }] });
      // With fresh holders, clearing the value memo reproduces round one's
      // WeakMap-only misses. Both runs exercise the real repository checkpoint.
      if (mode === "before") persistSessionImages.clear();
      await f.repository.writeTranscriptCheckpoint(mode, { history, current: structuredClone(current) }, lease(mode));
    }
    measurements[mode] = { hashedBytes: hashed, hashes };
    if (mode === "after") {
      await f.repository.writeRecord(mode, createSessionRecord([], structuredClone(current)));
      assert.equal(hashed, measurements.after.hashedBytes, "fresh full record also reuses exact payloads");
    }
  }
  assert.equal(measurements.before.hashes, 1830);
  assert.equal(measurements.after.hashes, 60);
  assert.equal(measurements.before.hashedBytes, measurements.after.hashedBytes * 30.5);
  console.log("IMAGE_CHECKPOINT_HASH_PROXY", JSON.stringify(measurements));
});

test("exact-value memo rejects middle-byte changes, evicts at its bound, and releases on clear", async () => {
  let calls = 0;
  const save = createSessionImageStorage(async () => `ref-${++calls}`, { maxMemoChars: 100, maxMemoEntries: 2 });
  const a = "data:image/png;base64," + "A".repeat(20);
  const b = a.slice(0, 30) + "B" + a.slice(31);
  assert.equal((await save({ image: a })).image, "ref-1");
  assert.equal((await save({ image: a })).image, "ref-1");
  assert.equal((await save({ image: b })).image, "ref-2");
  await save({ image: a + "C" });
  assert.ok(save.memoStats().chars <= 100);
  assert.ok(save.memoStats().entries <= 2);
  save.clear();
  assert.deepEqual(save.memoStats(), { entries: 0, chars: 0 });
});

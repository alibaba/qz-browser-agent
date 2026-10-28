import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../src/background/agent/agent.js";
import { createSessionRepository } from "../../src/background/session/repository.js";
import { createSessionRecord, readSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionImageStorage, persistSessionImages, resolveSessionImages } from "../../src/shared/session/session-image-assets.js";
import { gcImageAssets, saveHistoryImage, getHistoryImage, saveImageAsset, getImageAsset, getImageAssetStats, deleteImageAsset } from "../../src/shared/asset-store.js";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { readStoredTranscript } from "../../src/shared/session/session-history.js";
import { buildSessionExportHtml } from "../../src/sidepanel/features/export/session-export-feature.js";
import { projectMessage } from "../../src/background/llm/message-projection.js";
import { prepareModelImages } from "../../src/background/llm/image-budget.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlqUAAAAASUVORK5CYII=";
const user = url => ({ role: "user", content: [{ type: "text", text: "keep this image" }, { type: "image_url", image_url: { url, detail: "high" } }] });
const id = "image-storage";
const lease = { sessionId: id, isActive: () => true };
const activeKey = `_active_conversation_${id}`;
const recordKey = `_session_${id}`;
const wire = messages => JSON.stringify(messages.map(message => projectMessage(message, false)).filter(Boolean));

function fixture(t) {
  const assets = installImageAssetsFixture();
  t.after(() => assets.dispose());
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  const agent = new Agent(id, { conversationRepository: repository, conversationLease: lease });
  return { assets, storage, repository, agent };
}

test("60 image turns persist references, store each payload once, and measure old/new copy volume", async t => {
  const f = fixture(t);
  const N = 60, imageBytes = 256 * 1024;
  let before = 0, after = 0, cloneVolume = 0, readVolume = 0, reading = false;
  const get = f.storage.get;
  f.storage.get = async keys => {
    reading = true;
    try { return await get(keys); } finally { reading = false; }
  };
  const nativeClone = globalThis.structuredClone;
  t.mock.method(globalThis, "structuredClone", value => {
    if (value?.type === "conversation") {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (reading) readVolume += size;
      else cloneVolume += size;
    }
    return nativeClone(value);
  });
  f.agent.messages = [];
  const store = {
    ...f.repository,
    async writeActiveConversation(sessionId, conversation, authority) {
      const json = JSON.stringify(conversation);
      assert.ok(!json.includes("data:image/"));
      after += Buffer.byteLength(json);
      return f.repository.writeActiveConversation(sessionId, conversation, authority);
    },
  };
  f.agent._conversationRepository = store;
  for (let turn = 0; turn < N; turn++) {
    const bytes = Buffer.alloc(imageBytes, turn);
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    f.agent.messages.push(user(dataUrl));
    // This is the original serializer, not an estimated compression ratio.
    before += Buffer.byteLength(JSON.stringify(serializeConversation(f.agent.messages)));
    await f.agent.persist();
    assert.equal(f.assets.counts.adds, turn + 1);
    assert.equal(f.agent.messages.at(-1).content[1].image_url.url, dataUrl);
  }
  assert.equal(f.assets.counts.opens, 1, "asset operations share one connection");
  assert.equal(f.assets.counts.puts, 0, "immutable images are not rewritten/touched");
  assert.ok(after < N * N * 600, "only small per-entry metadata grows in snapshots");
  assert.ok(after < before / 500);
  assert.equal(cloneVolume, after, "repository structuredClone never sees image bytes");
  const measured = { writeBytes: after, cloneBytes: cloneVolume, readBytes: readVolume };
  const beforeRepeated = f.assets.counts.adds;
  for (let index = 0; index < 5; index++) await f.agent.persist();
  assert.equal(f.assets.counts.adds, beforeRepeated);
  console.log("IMAGE_PERSIST_PROXY", JSON.stringify({ turns: N, imageBytes,
    beforeWriteActiveConversationBytes: before, afterWriteActiveConversationBytes: measured.writeBytes,
    beforeStructuredCloneBytes: before, afterStructuredCloneBytes: measured.cloneBytes,
    afterStorageReadBytes: measured.readBytes,
    assetWrites: f.assets.counts.adds, assetBytes: f.assets.counts.blobBytes }));
});

test("restore replays byte-identical uploaded/tool images and exports self-contained HTML", async t => {
  const f = fixture(t);
  // Noncanonical header spelling must survive too, not just decoded pixels.
  const toolImage = image.replace("image/png;", "image/png;charset=UTF-8;");
  f.agent.messages = [user(image), { ...user(toolImage), _origin: "tool_image" }, { role: "assistant", content: "remembered" }];
  const original = structuredClone(f.agent.messages);
  const replay = wire(original);
  await f.agent.persist();
  await f.repository.writeRecord(id, createSessionRecord(f.agent.exportSession(), [
    { type: "user", text: "uploaded", images: [{ dataUrl: image, name: "upload" }] },
    { type: "tool", name: "screenshot", toolCallId: "shot", args: {}, result: { ok: true }, image: toolImage },
  ]), lease);
  assert.ok(!JSON.stringify(f.storage.snapshot()).includes("data:image/"));
  assert.equal(f.assets.counts.adds, 2, "conversation/transcript share content-addressed images");
  const repository = createSessionRepository({ storage: f.storage });
  const restored = new Agent(id, { conversationRepository: repository, conversationLease: lease });
  await restored.hydrateFromStore();
  assert.deepEqual(restored.messages.filter(message => message.role !== "system"), original);
  assert.equal(wire(restored.messages), replay);
  await restored.restoreSession(f.storage.snapshot()[activeKey]);
  assert.equal(wire(restored.messages), replay, "explicit restore also accepts persisted references");
  const oldDecoder = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  t.after(() => { globalThis.createImageBitmap = oldDecoder; });
  assert.equal(wire(await prepareModelImages(restored.messages)), wire(await prepareModelImages(original)),
    "provider image preparation receives identical image content after restore");
  await restored.persist();
  assert.equal(f.assets.counts.adds, 2, "a new Agent does not store duplicate payloads");
  const saved = readSessionRecord(await repository.readRecord(id));
  const payload = createSessionExchangePayload({ session: { id, title: "Images" }, ...saved });
  const oldRuntimeSource = globalThis.SESSION_EXPORT_RUNTIME_SOURCE;
  globalThis.SESSION_EXPORT_RUNTIME_SOURCE = "/* inline export runtime fixture */";
  t.after(() => { globalThis.SESSION_EXPORT_RUNTIME_SOURCE = oldRuntimeSource; });
  const oldDocument = globalThis.document;
  // This export entry only needs the browser's text escaping primitive.
  globalThis.document = { createElement: () => ({ textContent: "", get innerHTML() {
    return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  } }) };
  t.after(() => { globalThis.document = oldDocument; });
  const html = buildSessionExportHtml({ id, title: "Images" }, payload, {
    chatHtml: saved.transcript.map(entry => `<img src="${entry.image || entry.images[0].dataUrl}">`).join(""),
  });
  assert.ok(html.includes(`<img src="${image}">`));
  assert.ok(html.includes(`<img src="${toolImage}">`));
  assert.ok(html.includes('"url":"' + image + '"'), "portable exchange also contains the original bytes");
  assert.ok(!html.includes("qz-history-image:"));
  assert.ok(!html.includes('src="blob:'));
  const oldChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: f.storage } };
  t.after(() => { globalThis.chrome = oldChrome; });
  assert.deepEqual(await readStoredTranscript(id), saved.transcript, "direct UI history reads resolve assets");
});

test("legacy inline snapshots load and migrate losslessly on the next write", async t => {
  const f = fixture(t);
  const legacy = serializeConversation([user(image)]);
  await f.storage.set({ [activeKey]: legacy });
  await f.agent.hydrateFromStore();
  assert.equal(wire(f.agent.messages), wire([user(image)]));
  await f.agent.persist();
  assert.ok(!JSON.stringify(f.storage.snapshot()[activeKey]).includes("data:image/"));
  assert.deepEqual(await f.repository.readActiveConversation(id), f.agent.exportSession());
});

test("five parallel gallery saves deduplicate before publishing asset IDs", async t => {
  const f = fixture(t);
  const input = { blob: new Blob(["parallel image"], { type: "image/png" }), width: 2560, height: 1920 };
  const saved = await Promise.all(Array.from({ length: 5 }, () => saveImageAsset(input, { thumbnail: false, maxImages: 1 })));
  assert.equal(new Set(saved.map(asset => asset.assetId)).size, 1);
  assert.equal(saved.filter(asset => asset.deduped).length, 4);
  assert.equal(f.assets.counts.adds, 1);
  assert.deepEqual(await getImageAssetStats(), { count: 1, totalBytes: input.blob.size });
  const stored = await getImageAsset(saved[0].assetId);
  assert.equal(await stored.blob.text(), "parallel image");
  assert.equal(stored.width, 2560);
  assert.equal(stored.height, 1920);
});

test("gallery GC cannot evict history; deleting the last Session reference reclaims it", async t => {
  const f = fixture(t);
  const reference = await saveHistoryImage(image);
  const gallery = await saveImageAsset({ blob: new Blob(["gallery"], { type: "image/png" }) }, { thumbnail: false });
  await gcImageAssets({ maxImages: 0, maxBytes: 0, dryRun: false });
  await deleteImageAsset(gallery.assetId);
  await deleteImageAsset(reference);
  for (const sessionId of [id, "shared"]) {
    await f.repository.createMetadata({ id: sessionId });
    await f.repository.writeRecord(sessionId, createSessionRecord([user(image)], []));
  }
  await f.repository.deleteSession(id);
  assert.equal(await getHistoryImage(reference), image);
  await f.repository.deleteSession("shared");
  assert.equal(await getHistoryImage(reference), null);
  assert.deepEqual(persistSessionImages.memoStats(), { entries: 0, chars: 0 });
  // A surviving in-memory image can be saved again after its previous Session
  // was deleted; neither the weak nor the string memo may reuse a swept ID.
  await f.repository.writeRecord("new", createSessionRecord([user(image)], []));
  assert.equal(await getHistoryImage(reference), image);
});

test("missing images degrade gracefully; failed saves retry and revoked leases never publish references", async t => {
  const f = fixture(t);
  const missing = "qz-history-image:v1:" + "a".repeat(64);
  await f.storage.set({ [activeKey]: serializeConversation([user(missing)]) });
  await f.agent.hydrateFromStore();
  assert.ok(!wire(f.agent.messages).includes(missing));
  let attempts = 0;
  const persist = createSessionImageStorage(async value => {
    if (++attempts === 1) throw new Error("quota");
    return saveHistoryImage(value);
  });
  const messages = [user(image)];
  await assert.rejects(persist(messages), /quota/);
  const saved = await persist(messages);
  assert.deepEqual(await resolveSessionImages(saved), messages);
  let active = true;
  const authority = { sessionId: id, isActive: () => active };
  const writing = f.repository.writeActiveConversation(id, serializeConversation(messages), authority);
  active = false;
  await assert.rejects(writing, { code: "STALE_SESSION_LEASE" });
  assert.equal(f.storage.snapshot()[activeKey].entries[0].message.content[1].image_url.url, missing);
});

test("a transient asset read failure cannot hydrate an empty Agent over intact history", async t => {
  const f = fixture(t);
  f.agent.messages = [user(image)];
  await f.agent.persist();
  const stored = f.storage.snapshot()[activeKey];
  const reference = stored.entries[0].message.content[1].image_url.url;
  const rows = f.assets.stores.get("history_images").rows;
  const payload = rows.get(reference);
  // An unavailable/corrupt Blob read is a failure, unlike an absent record.
  rows.set(reference, { assetId: reference, blob: null });
  const restored = new Agent(id, { conversationRepository: f.repository, conversationLease: lease });
  await assert.rejects(restored.hydrateFromStore(), { code: "SESSION_IMAGE_READ_FAILED" });
  assert.deepEqual(f.storage.snapshot()[activeKey], stored);
  rows.set(reference, payload);
  await restored.hydrateFromStore();
  assert.equal(wire(restored.messages), wire([user(image)]));
});

test("history reads overlap at most four payloads, preserve order, and stop after a failed batch", async () => {
  const refs = Array.from({ length: 9 }, (_, index) => "qz-history-image:v1:" + index.toString(16).padStart(64, "0"));
  const gate = Promise.withResolvers();
  let active = 0, peak = 0, loads = 0;
  const reading = resolveSessionImages([...refs, refs[0]], async reference => {
    loads++; active++; peak = Math.max(peak, active);
    await gate.promise;
    active--;
    return "data:image/png;base64," + refs.indexOf(reference);
  });
  assert.equal(active, 4);
  gate.resolve();
  const images = await reading;
  assert.equal(peak, 4);
  assert.equal(loads, refs.length, "duplicate references share a read");
  assert.deepEqual(images, [...refs, refs[0]].map(reference => "data:image/png;base64," + refs.indexOf(reference)));
  loads = 0;
  await assert.rejects(resolveSessionImages(refs, async () => { loads++; throw new Error("read failed"); }), { code: "SESSION_IMAGE_READ_FAILED" });
  assert.equal(loads, 4, "a rejected batch never starts the remaining reads");
});

test("image persistence captures a snapshot before awaiting asset writes", async () => {
  const gate = Promise.withResolvers();
  const persist = createSessionImageStorage(async () => { await gate.promise; return "ref"; });
  const messages = [user(image), { role: "assistant", content: "before" }];
  const pending = persist(messages);
  messages[1].content = "after";
  messages.push(user(image + "later"));
  gate.resolve();
  const saved = await pending;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].content, "before");
});

test("snapshot capture preserves arbitrary JSON keys and sparse array lengths", async () => {
  const persist = createSessionImageStorage(async () => "reference");
  const input = JSON.parse('{"__proto__":{"image":"' + image + '"},"constructor":"text"}');
  input.items = new Array(3);
  input.items[0] = "first";
  const saved = await persist(input);
  assert.equal(Object.getPrototypeOf(saved), Object.prototype);
  assert.equal(Object.hasOwn(saved, "__proto__"), true);
  assert.equal(saved.__proto__.image, "reference");
  assert.equal(saved.constructor, "text");
  assert.equal(saved.items.length, 3);
});

test("concurrent Sessions store the same history image only once", async t => {
  const f = fixture(t);
  const refs = await Promise.all(Array.from({ length: 6 }, () => saveHistoryImage(image)));
  assert.equal(new Set(refs).size, 1);
  assert.equal(f.assets.counts.adds, 1);
});

for (const boundary of ["active", "record", "checkpoint"]) {
  test(`revocation during asset hashing blocks the ${boundary} storage commit`, async t => {
    const f = fixture(t);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(crypto.subtle, "digest", async (...args) => {
      entered.resolve();
      await release.promise;
      return digest(...args);
    });
    let active = true;
    const authority = { sessionId: id, isActive: () => active };
    const conversation = serializeConversation([user(image)]);
    const writing = boundary === "active" ? f.repository.writeActiveConversation(id, conversation, authority)
      : boundary === "record" ? f.repository.writeRecord(id, createSessionRecord(conversation, []), authority)
      : f.repository.writeTranscriptCheckpoint(id, { history: [], current: [{ type: "user", images: [{ dataUrl: image }] }] }, authority);
    await entered.promise;
    active = false;
    release.resolve();
    await assert.rejects(writing, { code: "STALE_SESSION_LEASE" });
    assert.equal(f.storage.writes.length, 0);
    assert.equal(f.assets.counts.adds, 1, "an orphan asset is harmless; an obsolete Session write is not");
  });
}

test("holder memoization reuses bytes without pinning holders and invalidates changed image slots", async () => {
  let saves = 0;
  const persist = createSessionImageStorage(async () => `ref-${++saves}`, { maxMemoChars: 0 });
  const messages = [user(image)];
  const slot = messages[0].content[1].image_url;
  for (let index = 0; index < 60; index++) await persist(messages);
  assert.equal(saves, 1);
  slot.url = image + "changed";
  assert.equal((await persist(messages))[0].content[1].image_url.url, "ref-2");
  assert.equal(saves, 2);
  messages.length = 0;
  await persist([user(image)]);
  assert.equal(saves, 3, "there is no process-wide byte-keyed cache keeping retired images alive");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptReconcileFeature } from "../../src/sidepanel/features/chat/transcript/recovery.js";
import { persistSessionImages } from "../../src/shared/session/session-image-assets.js";
import { serializeConversation, transcriptFromConversation } from "../../src/shared/session/session-codec.js";
import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";
const image = "data:image/png;base64,AAAA";
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const assets = installImageAssetsFixture();
  t.after(() => assets.dispose());
  let listener, removed = 0;
  const seeded = [], requested = [];
  const feature = createTranscriptReconcileFeature({
    activeConversationPrefix: "_active_conversation_",
    storage: { onChanged: { addListener: callback => { listener = callback; }, removeListener: () => { removed++; } } },
    transcriptFromConversation, getTranscriptCount: () => 0,
    requestSnapshot: id => requested.push(id),
    seedTranscript: (id, transcript) => { seeded.push({ id, transcript }); return true; },
  });
  feature.start();
  t.after(() => feature.stop());
  return { feature, seeded, requested, emit: value => listener({ _active_conversation_test: { newValue: value } }, "local"), removed: () => removed };
}

const snapshot = () => persistSessionImages(serializeConversation([{ role: "user", content: [
  { type: "image_url", image_url: { url: image } },
] }]));

test("storage.onChanged recovery resolves references before projecting user images", async t => {
  const f = fixture(t);
  f.emit(await snapshot());
  for (let tries = 0; !f.seeded.length && tries < 30; tries++) await tick();
  assert.equal(f.seeded[0].transcript[0].images[0].dataUrl, image);
  assert.ok(!JSON.stringify(f.seeded).includes("qz-history-image:"));
});

for (const action of ["stop", "clear", "newer"]) for (const fail of [false, true]) {
  test(`late onChanged hydration ${fail ? "failure " : ""}is revoked by ${action}`, async t => {
    const f = fixture(t);
    const saved = await snapshot();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const text = Blob.prototype.text;
    t.mock.method(Blob.prototype, "text", async function () {
      entered.resolve(); await release.promise;
      if (fail) throw new Error("transient read failure");
      return text.call(this);
    });
    f.emit(saved);
    await entered.promise;
    if (action === "stop") f.feature.stop();
    else if (action === "clear") f.feature.clear("test");
    else f.emit(serializeConversation([{ role: "user", content: "newer" }]));
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.requested.length, 0);
    assert.equal(f.seeded.length, action === "newer" ? 1 : 0);
    if (action === "newer") assert.equal(f.seeded[0].transcript[0].text, "newer");
    if (action === "stop") assert.equal(f.removed(), 1);
  });
}

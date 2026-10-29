import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.route("**/asset-store-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Asset storage fixture</title>" }));
  await page.goto("/asset-store-fixture");
});

test("image storage keeps binary data, deduplicates, enforces limits and preserves assets during a dry run", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = await import("/extension/shared/asset-store.js");
    const image = async color => {
      const canvas = new OffscreenCanvas(16, 16);
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 16, 16);
      return canvas.convertToBlob({ type: "image/png" });
    };
    const blue = await image("blue");
    const first = await store.saveImageAsset({ blob: blue, width: 16, height: 16 });
    const duplicate = await store.saveImageAsset({ blob: blue });
    const data = await store.getImageAssetDataUrl(first.assetId);
    const object = await store.getImageAssetObjectUrl(first.assetId, { thumbnail: true });
    const fetched = await fetch(object.objectUrl).then(response => response.blob());
    URL.revokeObjectURL(object.objectUrl);
    let limitError = "";
    try { await store.saveImageAsset({ blob: await image("red") }, { maxImages: 1 }); }
    catch (error) { limitError = error.message; }
    const before = await store.getImageAssetStats();
    const preview = await store.gcImageAssets({ maxImages: 0 });
    const stillPresent = Boolean(await store.getImageAsset(first.assetId));
    const collected = await store.gcImageAssets({ maxImages: 0, dryRun: false });
    const missing = await store.getImageAsset(first.assetId);
    const repeatedDelete = await store.deleteImageAsset(first.assetId);
    return { first, duplicate, isPng: data.dataUrl.startsWith("data:image/png;base64,"), thumbnailBytes: fetched.size, limitError, before, preview: preview.deleted.length, stillPresent, collected: collected.deleted.length, missing, repeatedDelete };
  });
  expect(result.duplicate.assetId).toBe(result.first.assetId);
  expect(result.first.deduped).toBe(false);
  expect(result.duplicate.deduped).toBe(true);
  expect(result.first).not.toHaveProperty("blob");
  expect(result.before.count).toBe(1);
  expect(result.before.totalBytes).toBeGreaterThan(0);
  expect(result.isPng).toBe(true);
  expect(result.thumbnailBytes).toBeGreaterThan(0);
  expect(result.limitError).toContain("image asset limit exceeded");
  expect(result.preview).toBe(1);
  expect(result.stillPresent).toBe(true);
  expect(result.collected).toBe(1);
  expect(result.missing).toBeNull();
  expect(result.repeatedDelete.deleted).toBe(false);
});

test("five independent contexts collect the same image without unique-index races", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = await import("/extension/shared/asset-store.js");
    const canvas = new OffscreenCanvas(16, 16);
    canvas.getContext("2d").fillRect(0, 0, 16, 16);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await store.blobToDataUrl(blob);
    const gate = Promise.withResolvers();
    let arrivals = 0;
    // Pause thumbnail work until every context has missed the initial lookup.
    window.assetThumbnailGate = () => {
      if (++arrivals === 5) gate.resolve();
      return gate.promise;
    };
    const frames = await Promise.all(Array.from({ length: 5 }, () => new Promise(resolve => {
      const frame = document.createElement("iframe");
      frame.onload = () => resolve(frame);
      frame.src = "/asset-store-fixture";
      document.body.append(frame);
    })));
    try {
      const saved = await Promise.all(frames.map(frame => frame.contentWindow.eval(`(async () => {
        const native = createImageBitmap;
        globalThis.createImageBitmap = async (...args) => {
          await parent.assetThumbnailGate();
          return native.call(globalThis, ...args);
        };
        const store = await import("/extension/shared/asset-store.js");
        return store.saveImageAsset({ dataUrl: ${JSON.stringify(dataUrl)}, width: 16, height: 16 }, { maxImages: 1 });
      })()`)));
      const restored = await store.getImageAssetDataUrl(saved[0].assetId);
      return { saved, stats: await store.getImageAssetStats(), identical: restored.dataUrl === dataUrl };
    } finally {
      frames.forEach(frame => frame.remove());
      delete window.assetThumbnailGate;
    }
  });
  expect(new Set(result.saved.map(asset => asset.assetId)).size).toBe(1);
  expect(result.saved.filter(asset => asset.deduped)).toHaveLength(4);
  expect(result.stats.count).toBe(1);
  expect(result.identical).toBe(true);
});

test("transaction helpers report abort and the store remains usable after rollback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { requestToPromise, txDone } = await import("/extension/shared/indexeddb.js");
    const open = indexedDB.open("transaction-rollback-test", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("records");
    const db = await requestToPromise(open);
    const failed = db.transaction("records", "readwrite");
    const rejected = txDone(failed).then(() => false, () => true);
    failed.objectStore("records").put("must be rolled back", "key");
    failed.abort();
    const aborted = await rejected;
    const absent = await requestToPromise(db.transaction("records").objectStore("records").get("key"));
    const retry = db.transaction("records", "readwrite");
    const committed = txDone(retry);
    retry.objectStore("records").put("saved", "key");
    await committed;
    const saved = await requestToPromise(db.transaction("records").objectStore("records").get("key"));
    db.close();
    return { aborted, absent, saved };
  });
  expect(result).toEqual({ aborted: true, absent: undefined, saved: "saved" });
});

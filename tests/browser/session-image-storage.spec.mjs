import { expect, test } from "./fixtures.mjs";

test("native history sweep preserves shared references and deletes the last one", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
    const { createSessionRepository } = await import("/extension/background/session/repository.js");
    const { createSessionRecord } = await import("/extension/shared/session/session-codec.js");
    const { getHistoryImage } = await import("/extension/shared/asset-store.js");
    const storage = createMemoryStorage();
    const repository = createSessionRepository({ storage });
    const image = "data:image/png;base64,AAAA";
    const record = createSessionRecord([{ role: "user", content: [{ type: "image_url", image_url: { url: image } }] }], []);
    await repository.writeRecord("one", record);
    await repository.writeRecord("two", record);
    const reference = storage.snapshot()._session_one.conversation.entries[0].message.content[0].image_url.url;
    await repository.deleteSession("one");
    const shared = await getHistoryImage(reference);
    await repository.deleteSession("two");
    const removed = await getHistoryImage(reference);
    return { image, shared, removed };
  });
  expect(result.shared).toBe(result.image);
  expect(result.removed).toBeNull();
});

test("native asset DB upgrade, GC and reload preserve inline history and offline export", async ({ page, context }) => {
  await page.goto("/__test_health");
  const stored = await page.evaluate(async () => {
    // Upgrade an existing gallery DB without replacing its assets.
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("qz-browser-agent-assets", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("image_assets", { keyPath: "assetId" });
        for (const key of ["sha256", "updatedAt", "lastAccessedAt"]) store.createIndex(key, key, { unique: key === "sha256" });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    const image = canvas.toDataURL("image/png");
    const { saveHistoryImage, gcImageAssets } = await import("/extension/shared/asset-store.js");
    const { persistSessionImages } = await import("/extension/shared/session/session-image-assets.js");
    const { createSessionRecord } = await import("/extension/shared/session/session-codec.js");
    const refs = await Promise.all(Array.from({ length: 6 }, () => saveHistoryImage(image)));
    const record = createSessionRecord([{ role: "user", content: [{ type: "image_url", image_url: { url: image } }] }], [
      { type: "user", text: "upload", images: [{ dataUrl: image }] },
      { type: "tool", name: "screenshot", image, args: {}, result: { ok: true } },
    ]);
    const snapshot = await persistSessionImages(record);
    await gcImageAssets({ maxImages: 0, maxBytes: 0, dryRun: false });
    localStorage.setItem("snapshot", JSON.stringify(snapshot));
    localStorage.setItem("image", image);
    const count = await new Promise((resolve, reject) => {
      const request = indexedDB.open("qz-browser-agent-assets", 2);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("history_images");
        const count = tx.objectStore("history_images").count();
        tx.oncomplete = () => { db.close(); resolve(count.result); };
        tx.onerror = () => reject(tx.error);
      };
    });
    return { refs, count, json: JSON.stringify(snapshot) };
  });
  expect(new Set(stored.refs).size).toBe(1);
  expect(stored.count).toBe(1);
  expect(stored.json).not.toContain("data:image/");
  await page.reload();
  const restored = await page.evaluate(async () => {
    const { resolveSessionImages } = await import("/extension/shared/session/session-image-assets.js");
    const { readSessionRecord, deserializeConversation } = await import("/extension/shared/session/session-codec.js");
    const { createSessionExchangePayload } = await import("/extension/shared/session/session-exchange.js");
    const { buildSessionExportHtml } = await import("/extension/sidepanel/features/export/session-export-feature.js");
    const image = localStorage.getItem("image");
    const saved = readSessionRecord(await resolveSessionImages(JSON.parse(localStorage.getItem("snapshot"))));
    const session = { id: "native-images", title: "Images" };
    const payload = createSessionExchangePayload({ session, ...saved });
    const container = document.createElement("div");
    for (const entry of saved.transcript) {
      const img = document.createElement("img");
      img.src = entry.image || entry.images[0].dataUrl;
      container.append(img);
      await img.decode();
    }
    document.body.append(container);
    return { image, replay: deserializeConversation(saved.conversation)[0].content[0].image_url.url,
      html: buildSessionExportHtml(session, payload, { chatHtml: container.innerHTML }) };
  });
  expect(restored.replay).toBe(restored.image);
  expect(restored.html).not.toContain("qz-history-image:");
  await expect(page.locator("img")).toHaveCount(2);
  const offline = await context.newPage();
  await context.setOffline(true);
  await offline.setContent(restored.html);
  const images = await offline.locator("img").evaluateAll(async images => {
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => ({ src: image.getAttribute("src"), width: image.naturalWidth }));
  });
  expect(images).toEqual([{ src: restored.image, width: 2 }, { src: restored.image, width: 2 }]);
  await offline.close();
});

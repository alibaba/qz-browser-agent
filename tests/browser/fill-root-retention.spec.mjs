import { expect, test, testAssetUrl } from "./fixtures.mjs";

async function installContentScript(page) {
  await page.setContent(`<!doctype html><title>fill roots</title>
    <div id="rich" contenteditable="true">kept<b id="child">child</b></div>`);
  await page.evaluate(() => {
    const maps = [];
    const Original = Map;
    window.__qzMaps = maps;
    window.Map = class extends Original {
      constructor(...args) {
        super(...args);
        maps.push(this);
      }
    };
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: async () => ({ ok: true }),
      },
    });
  });
  await page.addScriptTag({ url: testAssetUrl("extension/content/content-script.js") });
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

test("rich-text fill roots are released and do not keep disconnected elements", async ({ page }) => {
  await installContentScript(page);
  const report = await page.evaluate(async () => {
    const invoke = (node, payload) => window.__qzInvoke(node, payload);
    const book = () => (window.__qzMaps || []).find(item => [...item.keys()].some(key => String(key).startsWith("fill:")));
    const host = document.querySelector("#rich");
    const child = host.querySelector("#child");
    await invoke(child, { action: "inspectElement", editingHost: true, fillToken: "fill:keep" });
    child.remove();
    const kept = await invoke(null, { action: "inspectElement", editingHost: true, fillToken: "fill:keep" });
    const hadKeep = Boolean(book()?.has("fill:keep"));
    await invoke(null, { action: "releaseFillRoot", fillToken: "fill:keep" });
    const stillHasKeep = Boolean(book()?.has("fill:keep"));
    const released = await invoke(null, { action: "inspectElement", editingHost: true, fillToken: "fill:keep" });
    for (let index = 0; index < 9; index += 1) {
      const element = document.createElement("div");
      element.contentEditable = "true";
      element.textContent = `root ${index}`;
      document.body.append(element);
      await invoke(element, { action: "inspectElement", editingHost: true, fillToken: `fill:n${index}` });
      if (index === 0) element.remove();
    }
    const next = document.createElement("div");
    next.contentEditable = "true";
    next.textContent = "next";
    document.body.append(next);
    await invoke(next, { action: "inspectElement", editingHost: true, fillToken: "fill:next" });
    const roots = book();
    return {
      keptText: kept?.text || "",
      keptCode: kept?.code || "",
      hadKeep,
      stillHasKeep,
      releasedCode: released?.code || "",
      size: roots ? roots.size : -1,
      hasOld: roots ? roots.has("fill:n0") : true,
      hasNext: roots ? roots.has("fill:next") : false,
    };
  });
  expect(report.keptCode, JSON.stringify(report)).toBe("");
  expect(report.keptText).toContain("kept");
  expect(report.hadKeep).toBe(true);
  expect(report.stillHasKeep).toBe(false);
  expect(report.releasedCode).toBe("STALE_ELEMENT_UID");
  expect(report.size).toBeLessThanOrEqual(8);
  expect(report.hasOld).toBe(false);
  expect(report.hasNext).toBe(true);
});

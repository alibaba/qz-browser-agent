import { expect, test, testAssetUrl } from "./fixtures.mjs";

async function installContentScript(page, html) {
  await page.setContent(`<base href="https://example.test/canvas/">${html}`);
  await page.evaluate(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: { addListener(nextListener) { listener = nextListener; } },
        sendMessage: async () => ({ ok: true }),
      },
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") return reject(new Error("content-script listener is not installed"));
      listener({ action, ...params }, {}, resolve);
    });
  });
  await page.addScriptTag({ url: testAssetUrl("extension/content/content-script.js") });
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function pageOverview(page, selector = "body") {
  return page.evaluate(
    nextSelector => window.__callQingzhouContent("pageOverview", { selector: nextSelector, limit: 20 }),
    selector,
  );
}

test("page overview reports only large visible canvases using rendered CSS size", async ({ page }) => {
  await installContentScript(page, `
    <style>
      body { margin: 0; }
      canvas { display: block; }
      #board { width: 640px; height: 360px; }
      #tiny-hi-dpi { width: 32px; height: 32px; }
      #hidden { display: none; width: 640px; height: 360px; }
      #later { width: 300px; height: 150px; margin-top: 1000px; }
      #outside { width: 500px; height: 300px; }
    </style>
    <main id="game">
      <canvas id="board" width="1280" height="720" aria-label="数独棋盘"></canvas>
      <canvas id="tiny-hi-dpi" width="1024" height="1024" aria-label="高清小图标"></canvas>
      <canvas id="hidden" width="1280" height="720" aria-label="隐藏画布"></canvas>
      <canvas id="later" aria-label="页面下方画布">浏览器不支持 Canvas</canvas>
    </main>
    <aside>
      <canvas id="outside" aria-label="范围外画布"></canvas>
    </aside>
  `);

  const scoped = await pageOverview(page, "#game");
  expect(scoped.canvases).toHaveLength(2);
  expect(scoped.canvases[0]).toMatchObject({
    name: "数独棋盘",
    rect: { x: 0, y: 0, w: 640, h: 360 },
    inViewport: true,
    bitmapSize: { width: 1280, height: 720 },
  });
  expect(scoped.canvases[1]).toMatchObject({
    name: "页面下方画布",
    inViewport: false,
    bitmapSize: { width: 300, height: 150 },
  });
  expect(scoped.canvases.map(item => item.name)).not.toContain("高清小图标");
  expect(scoped.canvases.map(item => item.name)).not.toContain("隐藏画布");
  expect(scoped.canvases.map(item => item.name)).not.toContain("范围外画布");

  const fullPage = await pageOverview(page);
  expect(fullPage.canvases.map(item => item.name)).toContain("范围外画布");
});

test('page overview ranks every candidate but resolves selectors only for retained actions', async ({ page }) => {
  await installContentScript(page, `<style>a { display:block }</style>${Array.from({ length: 800 }, (_, i) =>
    `<a id="link-${i}" href="/item/${i}">Item ${i}</a>`).join('')}`);
  const result = await page.evaluate(async () => {
    const original = document.querySelectorAll.bind(document);
    let selectorReads = 0;
    document.querySelectorAll = selector => { if (selector.startsWith('#link-')) selectorReads++; return original(selector); };
    try {
      const overview = await __callQingzhouContent('pageOverview', { limit: 5 });
      return { actions: overview.actions, selectorReads };
    } finally { document.querySelectorAll = original; }
  });
  expect(result.actions.map(item => item.selector)).toEqual(['#link-0', '#link-1', '#link-2', '#link-3', '#link-4']);
  expect(result.actions.map(item => item.text)).toEqual(['Item 0', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
  expect(result.selectorReads).toBe(10, 'unique-ID and final-selector checks are bounded by output size');
});

test("page overview bounds Canvas hints for model context", async ({ page }) => {
  const canvases = Array.from({ length: 10 }, (_, index) => (
    `<canvas width="300" height="150" aria-label="画布 ${index + 1}"></canvas>`
  )).join("");
  await installContentScript(page, `<main style="width:300px">${canvases}</main>`);

  const overview = await pageOverview(page);
  expect(overview.canvases).toHaveLength(8);
  expect(overview.canvases.map(item => item.name)).toEqual([
    "画布 1",
    "画布 2",
    "画布 3",
    "画布 4",
    "画布 5",
    "画布 6",
    "画布 7",
    "画布 8",
  ]);
});

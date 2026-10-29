import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, testAssetUrl } from "./fixtures.mjs";

const html = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures/open-shadow-article.html"), "utf8");
const componentHtml = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures/shadow-components-article.html"), "utf8");
const contentScripts = [
  "extension/content/article-extractor.js",
  "extension/content/content-script.js",
];

async function install(page, markup = html) {
  await page.setContent(markup, { waitUntil: "load" });
  await page.evaluate(() => {
    document.querySelectorAll("script").forEach(script => script.remove());
    let listener = null;
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: {
          addListener(next) { listener = next; },
          removeListener() { listener = null; },
        },
        sendMessage: async () => ({ ok: true }),
      },
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  });
  for (const script of contentScripts) {
    await page.addScriptTag({ url: testAssetUrl(script) });
  }
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function call(page, action, params) {
  return page.evaluate(
    ({ nextAction, nextParams }) => window.__callQingzhouContent(nextAction, nextParams),
    { nextAction: action, nextParams: params },
  );
}

test("read_article and find_elements see open shadow tables and skip closed roots", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await install(page);

  const light = await call(page, "readArticle", { source: "selector", selector: "#light-block", limit: 8000 });
  expect(light.text).toContain("Light paragraph remains.");
  expect(light.text).toContain("| Alpha | 1 |");
  expect(light.text).not.toContain("NESTED-SHADOW-117");
  expect(light.text).not.toContain("CLOSED-SHADOW-SECRET");

  const nested = await call(page, "readArticle", { source: "selector", selector: "#compat-block", limit: 8000 });
  expect(nested.text).toContain("| Chrome | 2023-09-15 | 117 |");
  expect(nested.text).toContain("Full support");
  expect(nested.text).toContain("NESTED-SHADOW-117");
  expect(nested.text).not.toContain("CLOSED-SHADOW-SECRET");
  expect(nested.outline.some(item => item.title === "Support matrix")).toBe(true);

  const article = await call(page, "readArticle", { source: "auto", limit: 20000 });
  expect(article.text).toContain("117");
  expect(article.text).toContain("Full support");
  expect(article.text).not.toContain("CLOSED-SHADOW-SECRET");
  expect(article.text.match(/SLOTTED-LIGHT-TEXT/g)).toEqual(["SLOTTED-LIGHT-TEXT"]);

  const version = await call(page, "findElements", { selector: "#compat-host", pattern: "^117$" });
  expect(version.matches).toBeGreaterThan(0);
  expect(version.results.some(item => item.match === "117")).toBe(true);

  const closed = await call(page, "findElements", { selector: "#story", pattern: "CLOSED-SHADOW-SECRET" });
  expect(closed.matches).toBe(0);
});

for (const source of ['auto', 'selector', 'body']) {
  test(`read_article preserves component content without lifecycle callbacks · ${source}`, async ({ page }) => {
    await install(page, componentHtml);
    const before = await page.evaluate(() => ({ calls: {...componentCalls}, html: document.body.innerHTML,
      shadow: document.querySelector('#shadow-host').shadowRoot.innerHTML }));
    const result = await call(page, 'readArticle', { source, selector: '#story', limit: 20000 });
    const after = await page.evaluate(() => ({ calls: {...componentCalls}, html: document.body.innerHTML,
      shadow: document.querySelector('#shadow-host').shadowRoot.innerHTML }));
    expect(after).toEqual(before);
    expect(result.code, result.error).toBeUndefined();
    for (const marker of ['LIGHT-SLOT-EVIDENCE', 'NESTED-SLOT-EVIDENCE', 'DEEP-SLOT-EVIDENCE']) {
      expect(result.text.match(new RegExp(marker, 'g')), result.text).toEqual([marker]);
    }
    expect(result.text.match(/FULL-117/g)).toHaveLength(3);
    expect(result.text.match(/FULL-118/g)).toHaveLength(3);
    expect(result.text).toContain('https://example.test/research/reference.html');
    if (source === 'auto') expect(result.text).not.toMatch(/HIDDEN-(LIGHT|SHADOW)-SECRET/);
  });
}

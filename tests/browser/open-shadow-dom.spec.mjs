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
  for (const hit of version.results) {
    // Background converts this private node reference into a uid: target;
    // shadow-hit-test.spec.mjs covers the public tool and actual click path.
    expect(hit._elementRef).toEqual(expect.any(String));
    expect(hit).not.toHaveProperty("line");
    expect(hit).not.toHaveProperty("lineRange");
  }

  const closed = await call(page, "findElements", { selector: "#story", pattern: "CLOSED-SHADOW-SECRET" });
  expect(closed.matches).toBe(0);
});

test("shadow locations cannot borrow identical light markup and references keep node identity", async ({ page }) => {
  await install(page, '<button id="same">Same</button><div id="host"></div>');
  await page.evaluate(() => {
    const root = document.querySelector('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="same">Same</button><button>Shadow only</button>';
  });
  const found = await call(page, 'findElements', { roles: ['button'] });
  const shadows = found.results.filter(hit => hit._elementRef);
  expect(shadows).toHaveLength(2);
  for (const hit of shadows) {
    expect(hit.selector).toBe('');
    expect(hit).not.toHaveProperty('line');
    expect(hit).not.toHaveProperty('lineRange');
    const inspected = await page.evaluate(async token => {
      const node = await window.__qzInvoke(null, { action: 'resolveFindElement', elementRef: token });
      const inspection = await window.__qzInvoke(node, { action: 'inspectElement' });
      const consumed = await window.__qzInvoke(null, { action: 'resolveFindElement', elementRef: token });
      return { inspection, consumed };
    }, hit._elementRef);
    expect(inspected.inspection.text).toBe(hit.text);
    expect(inspected.inspection).not.toHaveProperty('lineRange');
    expect(inspected.consumed).toBeNull();
  }
  const fresh = await call(page, 'findElements', { pattern: 'Shadow only', roles: ['button'] });
  await page.evaluate(() => document.querySelector('#host').shadowRoot.lastElementChild.remove());
  expect(await page.evaluate(token => window.__qzInvoke(null, { action: 'resolveFindElement', elementRef: token }), fresh.results[0]._elementRef)).toBeNull();
});

test("light-DOM find results retain their pre-fix JSON bytes and field order", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await install(page, '<style>body { margin: 0 } button { display: block; width: 120px; height: 40px; padding: 0; border: 0 }</style><main id="light"><button id="first">First</button><button id="second" disabled>Second</button></main>');
  const found = await call(page, 'findElements', { selector: '#light', roles: ['button'] });
  // Captured from 848edd6 before the fix, with this exact markup and viewport.
  expect(JSON.stringify(found)).toBe('{"pattern":"","flags":"i","matches":2,"searched":3,"limit":20,"resultTruncated":false,"results":[{"selector":"#first","tag":"button","role":"button","type":"","name":"","text":"First","value":"","placeholder":"","href":"","visible":true,"disabled":false,"editable":false,"rect":{"x":0,"y":0,"w":120,"h":40},"clickablePoint":{"x":60,"y":20},"actionable":true,"inViewport":true,"line":1,"lineRange":[1,1],"match":"","matchKind":"none","score":58,"obscuredAtCenter":false},{"selector":"#second","tag":"button","role":"button","type":"","name":"","text":"Second","value":"","placeholder":"","href":"","visible":true,"disabled":true,"editable":false,"rect":{"x":0,"y":40,"w":120,"h":40},"clickablePoint":{"x":60,"y":60},"actionable":true,"inViewport":true,"line":2,"lineRange":[2,2],"match":"","matchKind":"none","score":13,"obscuredAtCenter":false}]}');
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

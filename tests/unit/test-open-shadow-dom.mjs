import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const html = await readFile(join(root, "tests/fixtures/open-shadow-article.html"), "utf8");

let browser;
let page;
let directory;

async function readArticle(params) {
  return page.evaluate(next => window.__callQingzhouContent("readArticle", next), params);
}

async function findElements(params) {
  return page.evaluate(next => window.__callQingzhouContent("findElements", next), params);
}

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "qz-open-shadow-"));
  await build({
    absWorkingDir: root,
    entryPoints: {
      "article-extractor": "src/content/article-extractor.ts",
      "content-script": "src/content/content-script.ts",
    },
    outdir: directory,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome114",
    logLevel: "silent",
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => {
    document.querySelectorAll("script").forEach(script => script.remove());
  });
  await page.evaluate(() => {
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
  await page.addScriptTag({ path: join(directory, "article-extractor.js") });
  await page.addScriptTag({ path: join(directory, "content-script.js") });
  await page.waitForFunction(() => window.__QZ_CONTENT_READY === true);
});

test.after(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("light DOM reads and search counts stay on the light tree", async () => {
  const article = await readArticle({ source: "selector", selector: "#light-block", limit: 8000 });
  assert.equal(article.code, undefined, article.error);
  assert.match(article.text, /Light section/);
  assert.match(article.text, /Light paragraph remains\./);
  assert.match(article.text, /\| Light \| Count \|/);
  assert.match(article.text, /\| Alpha \| 1 \|/);
  assert.doesNotMatch(article.text, /SINGLE-OPEN-SHADOW|NESTED-SHADOW-117|CLOSED-SHADOW-SECRET|Full support/);

  const found = await findElements({ selector: "#light-block", pattern: "Light paragraph remains" });
  const lightCount = await page.evaluate(() => document.querySelectorAll("#light-block *").length + 1);
  assert.equal(found.searched, lightCount);
  assert.ok(found.results.some(item => item.text === "Light paragraph remains." && item.tag === "p"));
});

test("read_article reads a single open shadow and two nested open shadows", async () => {
  const single = await readArticle({ source: "selector", selector: "#single-block", limit: 8000 });
  assert.equal(single.code, undefined, single.error);
  assert.match(single.text, /SINGLE-OPEN-SHADOW/);
  assert.equal(single.text.match(/SINGLE-OPEN-SHADOW/g).length, 1);

  const nested = await readArticle({ source: "selector", selector: "#compat-block", limit: 8000 });
  assert.equal(nested.code, undefined, nested.error);
  assert.match(nested.text, /Browser compatibility/);
  assert.match(nested.text, /Support matrix/);
  assert.match(nested.text, /\| Browser \| Release date \| Support \|/);
  assert.match(nested.text, /\| Chrome \| 2023-09-15 \| 117 \|/);
  assert.match(nested.text, /\| Firefox \| 2023-08-01 \| Full support \|/);
  assert.match(nested.text, /NESTED-SHADOW-117/);
  assert.equal(nested.text.match(/\| Chrome \| 2023-09-15 \| 117 \|/g).length, 1);
  assert.ok(nested.outline.some(item => item.title === "Support matrix"));
  assert.doesNotMatch(nested.text, /CLOSED-SHADOW-SECRET/);
});

test("read_article skips closed shadow roots and keeps slotted light text once", async () => {
  const article = await readArticle({ source: "selector", selector: "#story", limit: 20000 });
  assert.equal(article.code, undefined, article.error);
  assert.match(article.text, /Light paragraph remains\./);
  assert.match(article.text, /SINGLE-OPEN-SHADOW/);
  assert.match(article.text, /NESTED-SHADOW-117/);
  assert.match(article.text, /\| Chrome \| 2023-09-15 \| 117 \|/);
  assert.equal(article.text.match(/SLOTTED-LIGHT-TEXT/g).length, 1);
  assert.doesNotMatch(article.text, /CLOSED-SHADOW-SECRET/);
});

test("read_article auto and body include the nested open-shadow table", async () => {
  for (const source of ["auto", "body"]) {
    const article = await readArticle({ source, limit: 20000 });
    assert.equal(article.code, undefined, `${source}: ${article.error}`);
    assert.match(article.text, /Light paragraph remains\./, source);
    assert.match(article.text, /117/, source);
    assert.match(article.text, /Full support/, source);
    assert.match(article.text, /Release date/, source);
    assert.match(article.text, /NESTED-SHADOW-117/, source);
    assert.doesNotMatch(article.text, /CLOSED-SHADOW-SECRET/, source);
  }
});

test("find_elements matches text inside nested open shadows and ignores closed shadows", async () => {
  const version = await findElements({ selector: "#story", pattern: "^117$" });
  assert.equal(version.code, undefined, version.error);
  assert.ok(version.matches >= 1, `expected a 117 match, searched ${version.searched}`);
  assert.ok(version.results.some(item => item.match === "117" && item.tag === "td"));

  const words = await findElements({ selector: "#compat-host", pattern: "Release date|Full support" });
  assert.ok(words.matches >= 2, `expected release-date and full-support matches, got ${words.matches}`);
  assert.ok(words.results.some(item => /Release date/.test(item.match)));
  assert.ok(words.results.some(item => /Full support/.test(item.match)));

  const scoped = await findElements({ selector: "#inner-host", pattern: "^117$" });
  assert.equal(scoped.code, undefined, scoped.error);
  assert.ok(scoped.matches >= 1);

  const single = await findElements({ selector: "#single-block", pattern: "SINGLE-OPEN-SHADOW" });
  assert.equal(single.matches, 1);

  const closed = await findElements({ selector: "#story", pattern: "CLOSED-SHADOW-SECRET" });
  assert.equal(closed.matches, 0);
  assert.equal(closed.results.length, 0);

  const invalid = await findElements({ selector: "###", pattern: "117" });
  assert.equal(invalid.code, "INVALID_SELECTOR");
});

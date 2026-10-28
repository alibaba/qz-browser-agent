import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildExtension, EXTENSION_ENTRIES } from "../../scripts/build-extension.mjs";
import { FIREFOX_TOOLBAR_ICON } from "../../scripts/firefox-manifest.mjs";

const BRAND_ICON = { 16: "icons/icon16.png" };

test("the firefox package ships the toolbar glyph and the chrome package keeps the brand icon only", async t => {
  const sourceDir = await fixture(t);
  await put(sourceDir, FIREFOX_TOOLBAR_ICON, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>\n');
  const work = dirname(sourceDir);

  const firefox = await buildExtension({ sourceDir, outputDir: join(work, "firefox"), browser: "firefox" });
  assert.ok(firefox.files.includes(FIREFOX_TOOLBAR_ICON));
  const firefoxManifest = JSON.parse(await readFile(join(firefox.outputDir, "manifest.json"), "utf8"));
  assert.equal(firefoxManifest.action.default_icon, FIREFOX_TOOLBAR_ICON);
  assert.equal(firefoxManifest.sidebar_action.default_icon, FIREFOX_TOOLBAR_ICON);
  assert.deepEqual(firefoxManifest.icons, BRAND_ICON);

  const chrome = await buildExtension({ sourceDir, outputDir: join(work, "chrome"), browser: "chrome" });
  assert.equal(chrome.files.some(path => path.startsWith("icons/firefox/")), false);
  const chromeManifest = JSON.parse(await readFile(join(chrome.outputDir, "manifest.json"), "utf8"));
  assert.deepEqual(chromeManifest.action.default_icon, BRAND_ICON);
  assert.deepEqual(chromeManifest.icons, BRAND_ICON);
});

test("a firefox package without the toolbar glyph fails and leaves no output", async t => {
  const sourceDir = await fixture(t);
  const outputDir = join(dirname(sourceDir), "firefox");
  await assert.rejects(buildExtension({ sourceDir, outputDir, browser: "firefox" }),
    new RegExp(`Firefox manifest icon is not in the package: ${FIREFOX_TOOLBAR_ICON}`));
  await assert.rejects(readFile(join(outputDir, "manifest.json")), { code: "ENOENT" });
});

async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-firefox-icon-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const sourceDir = join(work, "source");
  await put(sourceDir, "manifest.json", JSON.stringify({
    manifest_version: 3,
    name: "fixture",
    version: "0.0.1",
    background: { service_worker: "background/service-worker.js", type: "module" },
    side_panel: { default_path: "sidepanel/sidepanel.html" },
    action: { default_title: "fixture", default_icon: BRAND_ICON },
    icons: BRAND_ICON,
    content_scripts: [{ js: EXTENSION_ENTRIES.filter(entry => entry.path.startsWith("content/")).map(entry => entry.path) }],
    sandbox: { pages: ["runner-sandbox.html"] },
    declarative_net_request: { rule_resources: [] },
  }));
  for (const entry of EXTENSION_ENTRIES) await put(sourceDir, entry.path, "globalThis.fixture = true;\n");
  await put(sourceDir, "sidepanel/sidepanel.html", '<script type="module" src="sidepanel.js"></script>');
  await put(sourceDir, "offscreen.html", '<script type="module" src="offscreen.js"></script>');
  await put(sourceDir, "runner-sandbox.html", '<script src="runner-sandbox.js"></script>');
  await put(sourceDir, "background/firefox-boot.ts", 'import "./service-worker.js";\n');
  await put(sourceDir, "sidepanel/firefox-boot.ts", 'import "./sidepanel.js";\n');
  await put(sourceDir, "icons/icon16.png", "png");
  return sourceDir;
}

async function put(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

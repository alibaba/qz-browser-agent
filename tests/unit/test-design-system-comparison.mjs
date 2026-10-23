import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { fixtureDirectories, createComparisonServer, stableCapture, compareCaptures } from "../design-system/comparison.mjs";
import { MISSING_IMAGEMAGICK_REASON, imageMagickCommandAvailable } from "../support/imagemagick.mjs";

test("CSS-only fixture arguments remain compatible and each application can override its own root", () => {
  assert.deepEqual(fixtureDirectories({ "fixture-dir": "shared" }), { reference: resolve("shared"), candidate: resolve("shared") });
  assert.deepEqual(fixtureDirectories({ "fixture-dir": "shared", "candidate-fixture-dir": "new" }), {
    reference: resolve("shared"), candidate: resolve("new"),
  });
  assert.deepEqual(fixtureDirectories({ "reference-fixture-dir": "old", "candidate-fixture-dir": "new" }), {
    reference: resolve("old"), candidate: resolve("new"),
  });
  assert.throws(() => fixtureDirectories({ "reference-fixture-dir": "old" }), /candidate-fixture-dir/);
});

test("each server serves its frozen control markup instead of sharing the mutable repository fixture", async t => {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-controls-comparison-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const referenceHtml = '<main class="data-toolbar">Original control</main>';
  const candidateHtml = '<main class="data-toolbar qz:flex">Candidate control</main>';
  const servers = [];
  try {
    for (const controlsHtml of [referenceHtml, candidateHtml]) {
      servers.push(await createComparisonServer({ fixtureDir: root, root, stylesheet: "", controlsHtml }));
    }
    assert.equal(await (await fetch(`${servers[0].origin}/tests/button-system/smoke.html`)).text(), referenceHtml);
    assert.equal(await (await fetch(`${servers[1].origin}/tests/button-system/smoke.html`)).text(), candidateHtml);
  } finally { await Promise.all(servers.map(server => server.close())); }
});

test("real application markup and module class changes are detected without a pixel tolerance", async t => {
  if (!imageMagickCommandAvailable()) return t.skip(MISSING_IMAGEMAGICK_REASON);
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-css-comparison-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stylesheet = String.raw`body { margin: 0; background: white; } #app { width: 180px; height: 90px; background: #d4e4f4; }
    #content { width: 80px; height: 20px; background: #476783; }
    .qz\:p-4 { padding: 16px; } #app.qz\:bg-red { background: red; }`;
  const captures = {};
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [name, htmlClass, scriptClass] of [
    ["reference", "", ""], ["equivalent", "qz:unused", ""],
    ["markup-layout", "qz:p-4", ""], ["module-color", "", "qz:bg-red"],
  ]) {
    const fixtureDir = join(directory, name);
    await mkdir(join(fixtureDir, "sidepanel"), { recursive: true });
    await writeFile(join(fixtureDir, "sidepanel/sidepanel.html"), `<html><head><link rel="stylesheet" href="sidepanel.css"></head><body><main id="app" class="${htmlClass}"><div id="content"></div></main><script type="module" src="app.js"></script></body></html>`);
    await writeFile(join(fixtureDir, "sidepanel/app.js"), `if (${JSON.stringify(scriptClass)}) document.querySelector('#app').classList.add(${JSON.stringify(scriptClass)}); window.ready = true;`);
    const server = await createComparisonServer({ fixtureDir, stylesheet, root: directory });
    const context = await browser.newContext({ viewport: { width: 360, height: 200 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${server.origin}/extension/sidepanel/sidepanel.html`);
      await page.waitForFunction(() => window.ready);
      captures[name] = await stableCapture(page.locator("body"), join(directory, `${name}.png`));
      assert.deepEqual(errors, []);
      assert.match(await readFile(join(directory, `${name}.html`), "utf8"), new RegExp(htmlClass || scriptClass || 'id="app"'));
    } finally {
      await context.close();
      await server.close();
    }
  }
  const compare = name => compareCaptures(captures.reference, captures[name], join(directory, `${name}-diff.png`));
  assert.equal(compare("equivalent").exact, true, "class labels alone are not a visual regression");
  const layout = compare("markup-layout");
  assert.equal(layout.exact, false);
  assert.equal(layout.geometryEqual, false, "candidate HTML is actually served and its new utility changes geometry");
  assert.ok(layout.pixel.differentPixels > 0);
  const color = compare("module-color");
  assert.equal(color.exact, false);
  assert.equal(color.geometryEqual, true, "a module-created class may change pixels without changing geometry");
  assert.ok(color.pixel.differentPixels > 0, "pixel-only changes must also fail");
});

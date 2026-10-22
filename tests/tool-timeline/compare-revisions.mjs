#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildExtension } from "../../scripts/build-extension.mjs";
import { comparePixels } from "../benchmarks/conversation-render/compare-revisions.mjs";
import { createRevisionFixtureAdapter } from "./revision-fixture.mjs";
import { skipWithoutImageMagick } from "../support/imagemagick.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const suites = option("--suites", "core,plugin,states,export").split(",");
const output = resolve(option("--output", `tests/results/renderer-migration-${Date.now()}`));
const commit = execFileSync("git", ["rev-parse", "--verify", `${option("--baseline", "01dbe268")}^{commit}`], { encoding: "utf8", cwd: root }).trim();
if (existsSync(output)) throw new Error(`Refusing to overwrite audit evidence: ${output}`);
skipWithoutImageMagick("tool timeline revision comparison");
mkdirSync(output, { recursive: true });
const save = (path, value) => writeFileSync(join(output, path), `${JSON.stringify(value, null, 2)}\n`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const archive = execFileSync("git", ["archive", commit, "extension"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
mkdirSync(join(output, "baseline"));
execFileSync("tar", ["-xf", "-", "-C", join(output, "baseline")], { input: archive });
const candidateDir = option("--candidate-dir") ? resolve(option("--candidate-dir")) : join(output, "current-extension");
const build = option("--candidate-dir")
  ? JSON.parse(readFileSync(join(candidateDir, ".qingzhou-build.json"), "utf8"))
  : await buildExtension({ outputDir: candidateDir, mode: "development" });
if (build.mode !== "development") throw new Error("Renderer comparison requires a development build with individual modules");
save("current-build.json", { ...build, outputDir: candidateDir, hashes: Object.fromEntries(build.files.map(path => [path, hash(readFileSync(join(candidateDir, path)))])) });

// Both revisions use exactly the same fixture, resources, browser and viewport.
// Only the /extension asset root changes; no live model or remote page is used.
const servers = [];
const browser = await chromium.launch();
const results = [];
const diagnostics = [];
const imageReplacements = new Set();
const fixturePaths = ["tests/tool-timeline/visual-test.html", "tests/tool-timeline/visual-test.js",
  "tests/tool-timeline/migration-cases.js", "tests/plugin-renderers/smoke.html"];
const fixtureAssets = new Map(fixturePaths.map(path => [`/${path}`, readFileSync(join(root, path))]));
for (const [path, bytes] of fixtureAssets) {
  mkdirSync(dirname(join(output, "fixtures", path)), { recursive: true });
  writeFileSync(join(output, "fixtures", path), bytes);
}
let inputs;
let complete = false;
const profiles = [360, 660].flatMap(width => ["light", "dark"].map(colorScheme => ({ width, colorScheme })))
  .filter(profile => !args.includes("--profiles") || option("--profiles").split(",").includes(`${profile.width}-${profile.colorScheme}`));
if (!profiles.length) throw new Error("No audit profiles selected");
const plan = { commit, archiveSha256: hash(archive), browser: browser.version(), profiles,
  suites, fixtureHashes: Object.fromEntries([...fixtureAssets].map(([path, bytes]) => [path, hash(bytes)])),
  fixtureHash: hash(readFileSync(join(root, "tests/tool-timeline/visual-test.js"))),
  pluginFixtureHash: hash(readFileSync(join(root, "tests/plugin-renderers/smoke.html"))),
  fixedTime: "2026-09-18T04:00:00.000Z", externalImages: "Deterministic local SVG; no network access",
  legacyGlobals: "Load baseline sidepanel's marked/highlight scripts before fixture modules; current TS imports its locked dependencies",
  pixelComparison: "Unmasked ImageMagick AE; report exact equality separately from benchmark tolerance",
};
save("plan.json", plan);
try {
  const origins = {};
  const fixtureAdapters = {};
  for (const revision of ["before", "after"]) {
    const extensionDir = revision === "before" ? join(output, "baseline/extension") : candidateDir;
    fixtureAdapters[revision] = createRevisionFixtureAdapter(extensionDir);
    origins[revision] = await serve(extensionDir, fixtureAdapters[revision]);
  }
  for (const profile of profiles) {
    const contexts = {};
    const pages = {};
    for (const revision of ["before", "after"]) {
      contexts[revision] = await browser.newContext({ viewport: { width: 1280, height: 900 },
        colorScheme: profile.colorScheme, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 });
      const context = contexts[revision];
      await context.route("**/*", route => {
        if (route.request().url().startsWith(origins[revision]) || /^(data|blob):/.test(route.request().url())) return route.continue();
        if (route.request().resourceType() === "image") {
          imageReplacements.add(route.request().url());
          return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#547fa3"/></svg>' });
        }
        diagnostics.push({ revision, profile, externalRequest: route.request().url() });
        return route.abort();
      });
      await context.addInitScript(({ fixedTime }) => {
        const OriginalDate = Date;
        globalThis.Date = class extends OriginalDate {
          constructor(...values) { super(...(values.length ? values : [fixedTime])); }
          static now() { return new OriginalDate(fixedTime).getTime(); }
        };
      }, plan);
      const page = pages[revision] = await context.newPage();
      page.on("response", response => {
        if (response.status() >= 400) diagnostics.push({ revision, profile, httpStatus: response.status(), url: response.url() });
      });
      page.on("requestfailed", request => diagnostics.push({ revision, profile, requestFailed: request.url(), reason: request.failure()?.errorText }));
      page.on("pageerror", error => diagnostics.push({ revision, profile, error: error.message }));
      page.on("console", message => {
        if (message.type() === "error") diagnostics.push({ revision, profile, console: message.text() });
      });
    }
    try {
      for (const [revision, page] of Object.entries(pages)) {
        await page.goto(`${origins[revision]}/tests/tool-timeline/visual-test.html`);
        await page.waitForFunction(() => !!window.visualTimelineTest);
        if (!inputs) {
          inputs = await page.evaluate(async () => {
            const { createMigrationCases } = await import("/tests/tool-timeline/migration-cases.js");
            return createMigrationCases(window.visualTimelineTest);
          });
          save("inputs.json", inputs);
        }
        await page.evaluate(async ({ width, inputs, rendererUrl }) => {
          window.visualTimelineTest.setDeviceWidth(width);
          const { renderToolEvent } = await import(rendererUrl);
          const root = document.querySelector("#messages");
          root.replaceChildren();
          for (const item of inputs) {
            const card = document.createElement("section");
            card.className = "visual-tool-component";
            card.dataset.toolName = item.id;
            card.append(renderToolEvent(item.event, { expanded: true, lazyDetails: false }));
            root.append(card);
          }
        }, { width: profile.width, inputs, rendererUrl: fixtureAdapters[revision].moduleUrl("/extension/sidepanel/tools/tool-renderer.js") });
        await settle(page);
      }
      if (suites.includes("core")) await compareCards(pages, profile, "core", ".visual-tool-component", "data-tool-name");

      if (suites.includes("states")) {
        for (const page of Object.values(pages)) {
          await page.evaluate(async inputs => (await import("/tests/tool-timeline/migration-cases.js")).renderMigrationStateMatrix(inputs), inputs);
          await settle(page);
        }
        await compareCards(pages, profile, "states", ".visual-tool-component", "data-tool-name");
      }

      if (suites.includes("export")) {
        for (const [revision, page] of Object.entries(pages)) {
          const exported = await page.evaluate(async inputs => (await import("/tests/tool-timeline/migration-cases.js")).exportMigrationMatrix(inputs), inputs);
          writeFileSync(join(output, `${profile.width}-${profile.colorScheme}-${revision}-export.html`), exported.html);
          await page.setViewportSize({ width: profile.width, height: 900 });
          await page.setContent(exported.html);
          await page.evaluate(ids => {
            const cards = [...document.querySelectorAll("#messages > .msg-tool")];
            if (cards.length !== ids.length) throw new Error(`Wrong export count: ${cards.length} vs ${ids.length}`);
            cards.forEach((card, index) => {
              card.dataset.toolName = ids[index];
              card.querySelector(":scope > .tool-summary").click();
              const targetIndex = Number(card.dataset.migrationTargetIndex);
              if (Number.isInteger(targetIndex) && targetIndex > 0) {
                const target = card.querySelector(`[data-tool-timeline-index="${targetIndex}"]`);
                if (!target) throw new Error(`Missing exported target navigator: ${ids[index]}`);
                target.click();
                if (Number(card.querySelector(":scope > .tool-timeline-details")?.dataset.activeToolIndex) !== targetIndex) throw new Error(`Export navigator did not select target: ${ids[index]}`);
              }
            });
          }, exported.ids);
          await settle(page);
        }
        await compareCards(pages, profile, "export", "#messages > .msg-tool", "data-tool-name");
      }

      if (suites.includes("plugin")) {
      for (const [revision, page] of Object.entries(pages)) {
        await page.setViewportSize({ width: profile.width, height: 900 });
        await page.goto(`${origins[revision]}/tests/plugin-renderers/smoke.html`);
        await page.waitForFunction(() => !!window.__pluginRendererSmoke);
        const smoke = await page.evaluate(() => window.__pluginRendererSmoke);
        if (smoke.failures.length) diagnostics.push({ revision, profile, pluginFailures: smoke.failures });
        await settle(page);
      }
      await compareCards(pages, profile, "plugin", ".smoke-case", "data-case");
      }
    } finally {
      for (const context of Object.values(contexts)) await context.close();
    }
    console.log(`Compared ${profile.width}px ${profile.colorScheme}: ${results.length} pairs so far`);
    save("comparison.json", { plan, results, diagnostics });
  }
  complete = true;
} catch (error) {
  diagnostics.push({ fatal: error.message });
  throw error;
} finally {
  await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  save("comparison.json", { complete, plan, results, diagnostics });
  save("image-replacements.json", [...imageReplacements]);
  writeReport();
}
console.log(JSON.stringify({ output, pairs: results.length, exact: results.filter(item => item.pixel.differentPixels === 0).length,
  different: results.filter(item => item.pixel.differentPixels !== 0).length, diagnostics: diagnostics.length }));
if (!complete || diagnostics.length || results.some(item => item.pixel.differentPixels !== 0 || !item.geometryEqual)) process.exitCode = 1;

async function serve(extensionDir, adapter) {
  const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (fixtureAssets.has(pathname)) {
      response.writeHead(200, { "content-type": types[extname(pathname)], "cache-control": "no-store" });
      const bytes = adapter.source(pathname, fixtureAssets.get(pathname).toString());
      // Legacy Side Panel supplied these globals through HTML; the TS build
      // imports them. Omitting the old entry scripts would compare uninitialized UI.
      const legacyScripts = '<script src="/extension/vendor/marked/marked.min.js"></script><script src="/extension/vendor/highlight/highlight.min.js"></script>';
      response.end(extensionDir.includes(`${sep}baseline${sep}`) && pathname.endsWith(".html")
        ? bytes.replace("</head>", `${legacyScripts}</head>`) : bytes);
      return;
    }
    const isExtension = pathname.startsWith("/extension/");
    if (!isExtension && !pathname.startsWith("/tests/tool-timeline/") && !pathname.startsWith("/tests/plugin-renderers/")) { response.writeHead(403).end(); return; }
    const base = isExtension ? extensionDir : root;
    const path = resolve(base, `.${isExtension ? pathname.slice(10) : pathname}`);
    if (!path.startsWith(`${base}${sep}`) || !existsSync(path)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function settle(page) {
  await page.addStyleTag({ content: "*,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function compareCards(pages, profile, suite, selector, attribute) {
  const expected = await pages.before.locator(selector).evaluateAll((cards, attribute) => cards.map((card, index) => card.getAttribute(attribute) || String(index)), attribute);
  const actual = await pages.after.locator(selector).evaluateAll((cards, attribute) => cards.map((card, index) => card.getAttribute(attribute) || String(index)), attribute);
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual)) {
    save(`fixture-mismatch-${suite}.json`, { expected, actual });
    throw new Error(`Fixture mismatch: ${suite} (${expected.length} before, ${actual.length} after)`);
  }
  for (const [index, label] of expected.entries()) {
    const id = `${profile.width}-${profile.colorScheme}/${suite}/${String(index).padStart(2, "0")}-${label.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    mkdirSync(join(output, id), { recursive: true });
    const geometry = {};
    const features = {};
    for (const [revision, page] of Object.entries(pages)) {
      const card = page.locator(selector).nth(index);
      // Keep the real fixture parent and CSS, but avoid cumulative fractional
      // offsets and offscreen sticky headers from unrelated preceding cards.
      await card.evaluate(element => {
        for (const sibling of element.parentElement.children) sibling.style.display = sibling === element ? "" : "none";
        window.scrollTo(0, 0);
      });
      await page.mouse.move(0, 0);
      await card.evaluate(async element => {
        for (const image of element.querySelectorAll("img")) {
          image.loading = "eager";
          await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error("Image decode timed out")), 5000))]);
          if (!image.complete || image.naturalWidth <= 0) throw new Error("Image preview did not decode");
        }
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      geometry[revision] = await card.evaluate(element => {
        const box = element.getBoundingClientRect();
        return [...element.querySelectorAll('[class*="tool-"]')].filter(node => {
          const css = getComputedStyle(node);
          return css.display !== "contents" && css.display !== "none" && node.getBoundingClientRect().height > 0;
        }).map(node => {
          const rect = node.getBoundingClientRect();
          const css = getComputedStyle(node);
          return { class: node.className, x: +(rect.x - box.x).toFixed(2), y: +(rect.y - box.y).toFixed(2),
            width: +rect.width.toFixed(2), height: +rect.height.toFixed(2), margin: css.margin, padding: css.padding, gap: css.gap,
            font: css.font, overflow: css.overflow, grid: css.gridTemplateColumns };
        });
      });
      features[revision] = await card.evaluate(element => ({
        copyButtons: element.querySelectorAll(".tool-data-table-copy").length,
        imageSources: [...element.querySelectorAll(".tool-image-grid-source")].map(node => node.textContent),
        images: [...element.querySelectorAll("img")].map(image => ({ width: image.naturalWidth, height: image.naturalHeight })),
      }));
      await card.screenshot({ path: join(output, id, `${revision}.png`), animations: "disabled", caret: "hide" });
    }
    const pixel = comparePixels(join(output, id, "before.png"), join(output, id, "after.png"), join(output, id, "diff.png"));
    const geometryEqual = JSON.stringify(geometry.before) === JSON.stringify(geometry.after);
    let attribution;
    if (suite === "export" && features.before.copyButtons > 0 && features.after.copyButtons === 0) {
      // Preserve the untouched pair above. A separate counterfactual proves
      // whether removing the old offline copy control explains every pixel.
      const card = pages.before.locator(selector).nth(index);
      await card.evaluate(element => element.querySelectorAll(".tool-data-table-copy").forEach(button => button.remove()));
      await card.screenshot({ path: join(output, id, "before-without-copy-control.png"), animations: "disabled", caret: "hide" });
      attribution = { change: "Static table renderer omits the live clipboard control", pixel: comparePixels(
        join(output, id, "before-without-copy-control.png"), join(output, id, "after.png"), join(output, id, "copy-control-attribution-diff.png")) };
    }
    save(`${id}/geometry.json`, geometry);
    results.push({ id, label, suite, profile, pixel, geometryEqual, features, ...(attribution ? { attribution } : {}) });
  }
}

function writeReport() {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const rows = results.map(item => `<details${item.pixel.differentPixels !== 0 ? " open" : ""}><summary>${escape(item.id)} · ${item.pixel.differentPixels ?? item.pixel.reason} changed pixels · geometry ${item.geometryEqual ? "equal" : "different"}</summary><div>${["before", "after", "diff"].map(name => `<figure><figcaption>${name}</figcaption><img loading="lazy" src="${escape(item.id)}/${name}.png"></figure>`).join("")}</div></details>`).join("\n");
  writeFileSync(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>Renderer migration comparison</title><style>body{font:14px system-ui;margin:24px}details{border-bottom:1px solid #ddd;padding:10px}details>div{display:flex;align-items:flex-start;gap:12px}figure{margin:0;max-width:32%}img{max-width:100%}summary{cursor:pointer}</style><h1>Renderer migration comparison</h1><p>${complete ? "Complete" : "INCOMPLETE"}; baseline ${commit}; ${results.length} pairs; ${results.filter(item => item.pixel.differentPixels === 0).length} pixel-identical; ${diagnostics.length} diagnostics.</p>${rows}`);
}

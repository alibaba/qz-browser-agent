#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { installBenchmarkChromeStub } from "../browser/benchmark-chrome-stub.mjs";
import { prepareBenchmarkAssets } from "../support/benchmark-assets.mjs";
import { fixtureDirectories, createComparisonServer, stableCapture, compareCaptures } from "./comparison.mjs";
import { skipWithoutImageMagick } from "../support/imagemagick.mjs";

// Separate application roots preserve each revision's real DOM and compiled modules.
// With --fixture-dir both sides use the same app, retaining the CSS-only audit mode.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({ options: {
  "reference-dir": { type: "string" }, "candidate-dir": { type: "string" },
  "fixture-dir": { type: "string" }, "reference-fixture-dir": { type: "string" },
  "candidate-fixture-dir": { type: "string" }, output: { type: "string" },
  "reference-controls": { type: "string" }, "candidate-controls": { type: "string" },
  "full-raster": { type: "boolean", default: false },
  profiles: { type: "string", default: "360-light,360-dark,660-light,660-dark" },
} });
for (const key of ["reference-dir", "candidate-dir", "output"]) {
  if (!values[key]) throw new Error(`Missing --${key}; see docs/benchmarks.md#compare-css-and-markup`);
}
const fixtureDirs = fixtureDirectories(values);
skipWithoutImageMagick("CSS and markup comparison");
for (const [side, directory] of Object.entries(fixtureDirs)) {
  const build = JSON.parse(readFileSync(join(directory, ".qingzhou-build.json"), "utf8"));
  if (build.mode !== "development") throw new Error(`${side} fixture requires a development build with individual modules`);
}
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Refusing to overwrite audit evidence: ${output}`);
mkdirSync(output, { recursive: true });
const sides = ["reference", "candidate"];
const controls = Object.fromEntries(sides.map(side => {
  const path = resolve(values[`${side}-controls`] || join(root, "tests/button-system/smoke.html"));
  return [side, { path, html: readFileSync(path, "utf8") }];
}));
const stylePath = "sidepanel/sidepanel.css";
const css = Object.fromEntries(sides.map(name => [name,
  readFileSync(join(resolve(values[`${name}-dir`]), stylePath), "utf8")]));
const fixture = JSON.parse(readFileSync(join(root, "tests/benchmarks/conversation-render/fixtures/smoke.json"), "utf8"));
const profiles = values.profiles.split(",").map(id => {
  const match = /^(360|660)-(light|dark)$/.exec(id);
  if (!match) throw new Error(`Invalid profile ${id}`);
  return { id, width: Number(match[1]), colorScheme: match[2] };
});
if (new Set(profiles.map(item => item.id)).size !== profiles.length) throw new Error("Duplicate profiles");
const save = (file, value) => writeFileSync(join(output, file), `${JSON.stringify(value, null, 2)}\n`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixedTime = "2026-09-18T04:00:00.000Z";
const randomSeed = 20260919;
const browserArgs = values["full-raster"] ? ["--disable-partial-raster"] : [];
for (const [name, content] of Object.entries(css)) writeFileSync(join(output, `${name}.css`), content);
for (const [name, { html }] of Object.entries(controls)) writeFileSync(join(output, `${name}-controls.html`), html);
save("input.json", fixture);
const diagnostics = [], results = [], captures = new Map();
const plan = {
  profiles, fixedTime, randomSeed, fixtureDirs, browserArgs,
  referenceDir: resolve(values["reference-dir"]), candidateDir: resolve(values["candidate-dir"]),
  styleHashes: Object.fromEntries(Object.entries(css).map(([name, text]) => [name, hash(text)])),
  controls: Object.fromEntries(Object.entries(controls).map(([side, { path, html }]) => [side, { path, sha256: hash(html) }])),
  fixtureHashes: Object.fromEntries([
    "tests/benchmarks/conversation-render/fixtures/smoke.json",
    "tests/browser/benchmark-chrome-stub.mjs", "tests/design-system/compare-css.mjs",
    "tests/design-system/comparison.mjs", "tests/support/benchmark-assets.mjs",
    "tests/benchmarks/conversation-render/host.mjs",
  ].map(path => [path, hash(readFileSync(join(root, path)))])),
  runtimeHashes: Object.fromEntries(sides.map(side => [side,
    Object.fromEntries(files(fixtureDirs[side]).map(file => [relative(fixtureDirs[side], file), hash(readFileSync(file))]))])),
  comparison: "Unmasked ImageMagick AE; zero differing pixels and identical visible-element geometry required. Missing cases and browser errors fail.",
  application: fixtureDirs.reference === fixtureDirs.candidate
    ? "CSS-only: both skins run against the same frozen application in isolated contexts."
    : "CSS and markup: each skin runs its own frozen application, real DOM and export implementation; synthetic state and browser are identical.",
};
const servers = {};
let browser;
let complete = false;
try {
  for (const side of sides) {
    await prepareBenchmarkAssets(fixtureDirs[side]);
    servers[side] = await createComparisonServer({ fixtureDir: fixtureDirs[side], stylesheet: css[side], controlsHtml: controls[side].html, root });
  }
  browser = await chromium.launch({ args: browserArgs });
  plan.browserVersion = browser.version();
  save("plan.json", plan);
  for (const profile of profiles) {
    for (const side of sides) {
      const { origin } = servers[side];
      const context = await browser.newContext({ viewport: { width: profile.width, height: 900 },
        colorScheme: profile.colorScheme, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 });
      await context.route("**/*", route => {
        if (route.request().url().startsWith(origin) || /^(data|blob):/.test(route.request().url())) return route.continue();
        diagnostics.push({ side, profile: profile.id, unexpectedNetwork: route.request().url() });
        return route.abort();
      });
      await context.addInitScript(({ fixedTime, randomSeed }) => {
        const OriginalDate = Date;
        globalThis.Date = class extends OriginalDate {
          constructor(...args) { super(...(args.length ? args : [fixedTime])); }
          static now() { return new OriginalDate(fixedTime).getTime(); }
        };
        // Fix random inputs before startup; keep each revision's real welcome DOM and text rendering.
        let randomState = randomSeed;
        Math.random = () => ((randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0) / 2 ** 32);
      }, { fixedTime, randomSeed });
      await context.addInitScript(installBenchmarkChromeStub, { config: {
        provider: "custom", apiKey: "synthetic-key", model: "css-audit", contextWindow: 128000,
        customProtocol: "openai", customEndpoint: "https://example.invalid/v1/chat/completions", presets: [],
      } });
      await context.addInitScript(() => {
        chrome.runtime.getURL = path => `${location.origin}/extension/${path}`;
        chrome.runtime.getManifest = () => ({ version: "0.7.0" });
        const connect = chrome.runtime.connect;
        chrome.runtime.connect = (...args) => {
          const port = connect(...args), post = port.postMessage;
          port.postMessage = message => {
            post(message);
            if (message.type === "list_skill_settings") queueMicrotask(() => window.__qzEmitPortMessage({
              type: "skill_settings", requestId: message.requestId, settings: [{
                id: "css-example::example", pluginId: "example", skillName: "css-example",
                skillDisplayName: "设计系统示例", title: "设计系统示例", configured: true,
                fields: [
                  { key: "endpoint", type: "url", label: "Endpoint", required: true, value: "https://example.invalid/api" },
                  { key: "token", type: "secret", label: "Token", hasValue: true, value: "synthetic-value" },
                  { key: "enabled", type: "boolean", label: "启用示例", value: true },
                ],
              }],
            }));
          };
          return port;
        };
      });
      const page = await context.newPage();
      page.on("pageerror", error => diagnostics.push({ side, profile: profile.id, pageError: error.message }));
      page.on("console", message => {
        if (message.type() === "error") diagnostics.push({ side, profile: profile.id, consoleError: message.text() });
      });
      page.on("response", response => {
        if (response.status() >= 400) diagnostics.push({ side, profile: profile.id, status: response.status(), url: response.url() });
      });
      page.on("requestfailed", request => diagnostics.push({ side, profile: profile.id, requestFailed: request.url(), reason: request.failure()?.errorText }));
      try {
        await page.goto(`${origin}/tests/button-system/smoke.html`);
        const smoke = await page.evaluate(() => window.__buttonSystemSmoke);
        if (!smoke || smoke.failures.length) throw new Error(`Control fixture failed: ${JSON.stringify(smoke)}`);
        const scenes = await page.locator("[data-scene]").evaluateAll(items => items.map(item => item.dataset.scene));
        if (scenes.length !== 16) throw new Error(`Expected 16 control scenes, found ${scenes.length}`);
        for (const scene of scenes) {
          await page.evaluate(scene => {
            document.querySelector(".visual-page-title").hidden = true;
            document.querySelectorAll("[data-scene]").forEach(element => { element.style.display = element.dataset.scene === scene ? "block" : "none"; });
            document.querySelector(".visual-grid").style.display = "block";
          }, scene);
          await capture(page, side, profile, `controls-${scene}`, `[data-scene="${scene}"]`);
          if (scene === "forms") {
            await page.locator("#form-field").focus();
            await capture(page, side, profile, "controls-field-focus", '[data-scene="forms"]');
            await page.locator("#form-checkbox").focus();
            await capture(page, side, profile, "controls-checkbox-focus", '[data-scene="forms"]');
            await page.locator("#form-checkbox").evaluate(element => element.blur());
          }
          if (scene === "tokens") {
            await page.locator("#primary").hover();
            await capture(page, side, profile, "controls-button-hover", '[data-scene="tokens"]');
            await page.mouse.move(0, 0);
          }
        }

        await page.goto(`${origin}/extension/sidepanel/sidepanel.html`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.qingzhouConversationBenchmark && !document.querySelector("#app").hasAttribute("data-workspace-booting"));
        await capture(page, side, profile, "app-welcome");
        await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input, { debug: false }), fixture);
        await capture(page, side, profile, "app-transcript");
        await page.locator(".tool-summary").first().click();
        await capture(page, side, profile, "app-tool-expanded");
        await page.locator("#btn-settings").click();
        await page.locator("#cfg-provider-trigger, #cfg-provider:not([hidden])").waitFor({ state: "visible" });
        await capture(page, side, profile, "app-settings-model");
        await page.locator("#settings-tab-skills").click();
        await capture(page, side, profile, "app-settings-skills");
        await page.locator("#btn-close-settings").click();
        await page.evaluate(async () => {
          const { insertDataRows } = await import("/extension/shared/data-store.js");
          await insertDataRows("设计系统示例", [
            { 名称: "轻舟", 状态: "可用", 数量: 12, 备注: "中文和 Latin text" },
            { 名称: "数据表", 状态: "进行中", 数量: 5, 备注: "多列内容保持既有密度" },
            { 名称: "Capability", 状态: "已完成", 数量: 30, 备注: "复用公共控件" },
          ]);
        });
        await page.locator('.tab-btn[data-tab="data"]').click();
        await page.locator("#data-detail").waitFor({ state: "visible" });
        await page.locator(".tabulator-row").first().waitFor({ state: "visible" });
        await capture(page, side, profile, "app-data-table");
        const nameCells = page.locator('.tabulator-cell[tabulator-field="名称"]');
        await nameCells.first().dblclick();
        await page.locator("input[data-data-grid-editor]").waitFor({ state: "visible" });
        await capture(page, side, profile, "app-data-editing");
        await page.keyboard.press("Escape");
        const from = await nameCells.nth(0).boundingBox(), to = await nameCells.nth(1).boundingBox();
        if (!from || !to) throw new Error("Data range endpoints must be visible");
        await page.mouse.move(from.x + 10, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, { steps: 8 });
        await page.mouse.up();
        await page.locator(".tabulator-range-selected").first().waitFor({ state: "visible" });
        await capture(page, side, profile, "app-data-range");
        await page.evaluate(() => {
          document.addEventListener("copy", event => {
            window.__cssAuditCopiedText = event.clipboardData?.getData("text/plain") || "";
          }, { once: true });
        });
        await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
        await page.locator(".data-grid-table.copy-confirmed").waitFor({ state: "visible" });
        await capture(page, side, profile, "app-data-copied");
        if (!await page.locator(".data-grid-table.copy-confirmed").count()
            || !await page.evaluate(() => window.__cssAuditCopiedText?.includes("轻舟"))) {
          throw new Error("Data copy feedback must remain active throughout the captured state");
        }
        await page.locator(".data-grid-table.copy-confirmed").waitFor({ state: "hidden" });
        await page.locator("#btn-data-columns").click();
        await capture(page, side, profile, "app-data-columns");
        await page.locator("#btn-data-columns").click();
        await page.locator('.tab-btn[data-tab="skills"]').click();
        await capture(page, side, profile, "app-skills");

        // Each revision exports through its own production API. Only the skin is
        // replaced; export-specific rules and real revision markup stay intact.

        const exported = await page.evaluate(input => window.qingzhouConversationBenchmark.renderSessionDocument({
          session: { id: input.sessionId, title: input.title }, transcript: input.transcript,
        }), fixture);
        writeFileSync(join(output, `${profile.id}-${side}-export.html`), exported.html);
        await page.setContent(exported.html);
        await page.locator("#messages .msg-tool").first().waitFor();
        await capture(page, side, profile, "export-collapsed", "body", true);
        await page.locator(".tool-summary").first().click();
        await capture(page, side, profile, "export-expanded", "body", true);
      } finally { await context.close(); }
    }
    const incomplete = [...captures].filter(([key, value]) => key.startsWith(`${profile.id}/`) && sides.some(side => !value[side]));
    if (incomplete.length) throw new Error(`Missing comparison cases: ${incomplete.map(([key]) => key).join(", ")}`);
    const count = results.filter(item => item.profile === profile.id).length;
    if (count !== 32) throw new Error(`Expected 32 comparison pairs for ${profile.id}, received ${count}`);
    save("comparison.json", { complete: false, plan, results, diagnostics });
    console.log(`Compared ${profile.id}: ${results.length} pairs`);
  }
  complete = true;
} catch (error) {
  diagnostics.push({ fatal: error.stack || String(error) });
  console.error(error.message);
} finally {
  await browser?.close();
  await Promise.all(Object.values(servers).map(server => server.close()));
  const missingCases = [...captures].filter(([, value]) => sides.some(side => !value[side])).map(([key]) => key);
  const summary = { complete, pairs: results.length, exact: results.filter(item => item.exact).length,
    different: results.filter(item => !item.exact).length, diagnostics: diagnostics.length, missingCases };
  save("comparison.json", { ...summary, plan, results, diagnostics });
  writeFileSync(join(output, "REPORT.md"), `# CSS and markup visual comparison\n\n${JSON.stringify(summary)}\n\n`
    + "| Profile / case | Pixels changed | Geometry |\n| --- | ---: | --- |\n"
    + results.map(item => `| ${item.profile} / ${item.name} | ${item.pixel.differentPixels ?? item.pixel.reason} | ${item.geometryEqual ? "identical" : "different"} |`).join("\n") + "\n");
  console.log(JSON.stringify({ output, ...summary }));
  if (!complete || diagnostics.length || missingCases.length || results.some(item => !item.exact)) process.exitCode = 1;
}

async function capture(page, side, profile, name, selector = "body", exported = false) {
  if (exported) {
    await page.evaluate(stylesheet => {
      const style = document.querySelector("style");
      if (!style) throw new Error("Export has no embedded stylesheet");
      style.textContent = stylesheet;
    }, css[side]);
  }
  await settle(page);
  const key = `${profile.id}/${name}`;
  const directory = join(output, profile.id, name); mkdirSync(directory, { recursive: true });
  const pair = captures.get(key) || {};
  if (pair[side]) throw new Error(`Duplicate capture: ${side}/${key}`);
  pair[side] = await stableCapture(page.locator(selector), join(directory, `${side}.png`));
  captures.set(key, pair);
  if (sides.every(side => pair[side])) {
    results.push({ profile: profile.id, name, ...compareCaptures(pair.reference, pair.candidate, join(directory, "diff.png")) });
  }
}

async function settle(page) {
  await page.evaluate(async () => {
    if (!document.querySelector("#css-audit-motion")) {
      const style = document.createElement("style"); style.id = "css-audit-motion";
      style.textContent = "*,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
      document.head.append(style);
    }
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.complete && image.naturalWidth ? Promise.resolve() : image.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]).sort();
}

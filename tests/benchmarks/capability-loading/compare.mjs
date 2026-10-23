#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { installBenchmarkChromeStub } from "../../browser/benchmark-chrome-stub.mjs";
import { comparePixels } from "../conversation-render/compare-revisions.mjs";
import { skipWithoutImageMagick } from "../../support/imagemagick.mjs";

const { values } = parseArgs({ options: {
  reference: { type: "string" }, candidate: { type: "string" }, fixture: { type: "string" },
  output: { type: "string" }, rounds: { type: "string", default: "7" },
} });
for (const key of ["reference", "candidate", "fixture", "output"]) assert.ok(values[key], `Missing --${key}`);
const directories = { reference: resolve(values.reference), candidate: resolve(values.candidate), fixture: resolve(values.fixture) };
const output = resolve(values.output), rounds = Number(values.rounds);
assert.ok(Number.isInteger(rounds) && rounds > 0);
assert.ok(!existsSync(output), `Refusing to overwrite ${output}`);
skipWithoutImageMagick("capability loading comparison");
mkdirSync(output, { recursive: true });
const save = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
let active = "reference";
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (pathname === "/empty") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>Fixture preparation</title>"); return; }
  const prefix = pathname.startsWith("/extension/") ? "/extension/" : "/fixture/";
  const root = prefix === "/extension/" ? directories[active] : directories.fixture;
  const file = resolve(root, pathname.slice(prefix.length));
  if (!pathname.startsWith(prefix) || relative(root, file).startsWith("..") || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404); response.end("Not found"); return;
  }
  const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2" };
  response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(response);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const samples = [], diagnostics = [], visuals = [];
const plan = {
  directories, rounds, browser: browser.version(), viewport: { width: 430, height: 900 },
  mode: "Production sidepanel over loopback HTTP, Chrome APIs replaced by existing deterministic stub; no background worker, network provider, CPU throttle or concurrent browser workload.",
  timings: "Same browser process, alternating A/B and B/A, fresh contexts, HTTP cache disabled; one warmup pair excluded. Ready means boot completed, composer accepts input and enables Send, then next animation frame. Feature durations include first-load work and next animation frame. CDP ScriptDuration and TaskDuration are per-phase deltas. Times are not real extension or background cold-start measurements.",
  visuals: "Separate light/dark scenarios, fixed wall clock, animations disabled for screenshots, unmasked exact pixel and visible-element geometry comparison.",
  inputs: Object.fromEntries(["reference", "candidate"].map(name => [name, Object.fromEntries(["sidepanel/sidepanel.html", "sidepanel/sidepanel.js", "sidepanel/sidepanel.css"].map(file => [file, createHash("sha256").update(readFileSync(join(directories[name], file))).digest("hex")]))])),
};
save("plan.json", plan);
try {
  for (let round = -1; round < rounds; round++) {
    for (const name of round % 2 ? ["candidate", "reference"] : ["reference", "candidate"]) {
      const sample = await run(name, "light", false);
      if (round >= 0) samples.push({ round, ...sample });
      save("samples.json", samples);
      console.log(`${round < 0 ? "warmup" : round} ${name}: ${JSON.stringify(sample.phases)}`);
    }
  }
  for (const scheme of ["light", "dark"]) {
    const pair = {};
    for (const name of ["reference", "candidate"]) pair[name] = await run(name, scheme, true);
    for (const stage of ["startup", "formula", "data"]) {
      const pixel = comparePixels(join(output, `${scheme}-reference-${stage}.png`), join(output, `${scheme}-candidate-${stage}.png`), join(output, `${scheme}-${stage}-diff.png`));
      const geometryEqual = JSON.stringify(pair.reference.geometry[stage]) === JSON.stringify(pair.candidate.geometry[stage]);
      visuals.push({ scheme, stage, pixel, geometryEqual, exact: pixel.differentPixels === 0 && geometryEqual });
    }
  }
} catch (error) { diagnostics.push({ fatal: error.stack || String(error) }); }
finally {
  await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  const medians = Object.fromEntries(["reference", "candidate"].map(name => [name, Object.fromEntries(["startup", "formula", "data", "excel"].map(stage => [stage,
    Object.fromEntries(["durationMs", "scriptMs", "taskMs"].map(metric => [metric, median(samples.filter(s => s.name === name).map(s => s.phases[stage][metric]))])),
  ]))]));
  const result = { plan, complete: samples.length === rounds * 2 && visuals.length === 6 && !diagnostics.length, medians, visuals, diagnostics, samples };
  save("result.json", result);
  console.log(JSON.stringify({ output, complete: result.complete, medians, visuals, diagnostics }));
  if (!result.complete || visuals.some(item => !item.exact)) process.exitCode = 1;
}

async function run(name, colorScheme, visual) {
  active = name;
  const context = await browser.newContext({ viewport: plan.viewport, colorScheme, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 });
  await context.route("**/*", route => route.request().url().startsWith(origin) || /^(blob|data):/.test(route.request().url()) ? route.continue() : route.abort());
  await context.addInitScript(installBenchmarkChromeStub, { benchmark: false, config: { provider: "custom", apiKey: "synthetic-key", model: "loading-audit", customProtocol: "openai", customEndpoint: "https://example.invalid/v1/chat/completions" } });
  await context.addInitScript(() => {
    chrome.runtime.getURL = path => `${location.origin}/extension/${path}`;
    chrome.runtime.getManifest = () => ({ version: "0.7.0" });
    const connect = chrome.runtime.connect;
    chrome.runtime.connect = (...args) => {
      const port = connect(...args), post = port.postMessage;
      port.postMessage = message => {
        post(message);
        if (message.type === "create_ui_session") queueMicrotask(() => window.__qzEmitPortMessage({
          type: "create_ui_session_result", requestId: message.requestId,
          session: { id: message.id, title: "公式显示示例", parentSessionId: "root" },
        }));
      };
      return port;
    };
    window.__auditDownloads = [];
    chrome.downloads.download = async input => { const bytes = new Uint8Array(await (await fetch(input.url)).arrayBuffer()); window.__auditDownloads.push({ filename: input.filename, bytes: bytes.length, header: Array.from(bytes.slice(0, 4)) }); return 1; };
    window.__auditReady = new Promise(resolve => {
      const inspect = () => {
        const app = document.querySelector("#app"), input = document.querySelector("#input"), send = document.querySelector("#btn-send");
        if (!app || app.hasAttribute("data-workspace-booting") || !input?.getBoundingClientRect().height || !send) return requestAnimationFrame(inspect);
        if (app.hasAttribute("data-workspace-boot-fallback")) throw new Error("Workspace boot fallback is visible");
        input.value = "响应检查"; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        if (send.disabled) return requestAnimationFrame(inspect);
        input.value = ""; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        requestAnimationFrame(() => { window.__auditReadyAt = performance.now(); resolve(window.__auditReadyAt); });
      }; requestAnimationFrame(inspect);
    });
  });
  if (visual) await context.addInitScript(() => {
    const Original = Date; globalThis.Date = class extends Original { constructor(...args) { super(...(args.length ? args : ["2026-09-18T04:00:00.000Z"])); } static now() { return new Original("2026-09-18T04:00:00.000Z").getTime(); } };
    let seed = 12345; Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style"); style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"; document.head.append(style);
    }, { once: true });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [], phases = {}, resources = {}, geometry = {};
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); await cdp.send("Performance.enable");
  try {
    // Seed through the frozen Store API in a separate document; no product module is preloaded into the measured document.
    await page.goto(`${origin}/empty`);
    await page.evaluate(async () => {
      const { insertDataRows } = await import("/fixture/shared/data-store.js");
      await insertDataRows("按需加载示例", Array.from({ length: 30 }, (_, index) => ({ 名称: `项目 ${index + 1}`, 数量: index + 1, 状态: index % 2 ? "进行中" : "完成" })));
    });
    const before = await metrics(cdp);
    await page.goto(`${origin}/extension/sidepanel/sidepanel.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Number.isFinite(window.__auditReadyAt));
    const ready = await page.evaluate(() => window.__auditReadyAt);
    phases.startup = { durationMs: ready, ...delta(before, await metrics(cdp)) };
    await capture("startup");

    await page.locator("#input").fill("公式显示示例");
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => window.__qzPostedMessages.some(item => item.type === "prompt"));
    await phase("formula", async () => {
      await page.evaluate(() => {
        const sessionId = [...window.__qzPostedMessages].reverse().find(item => item.sessionId)?.sessionId;
        if (!sessionId) throw new Error("No active session identity");
        window.__auditPhaseStarted = performance.now();
        window.__qzEmitPortMessage({ type: "messages", sessionId, transcript: [{ type: "assistant", content: "勾股定理：$a^2+b^2=c^2$\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$", timestamp: "2026-09-18 12:00:00" }] });
      });
      await page.locator("#messages mjx-container svg").first().waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#messages mjx-container svg").length === 2);
    });
    await capture("formula");
    await phase("data", async () => {
      await page.locator('[data-tab="data"]').click();
      await page.locator("#data-detail .tabulator-cell").filter({ hasText: "项目 1" }).first().waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#data-loading")?.offsetHeight);
    });
    await capture("data");
    await page.locator("#btn-data-table-actions").click();
    await phase("excel", async () => {
      await page.locator("#btn-export-data").click();
      await page.waitForFunction(() => window.__auditDownloads.length === 1);
    });
    await capture("excel");
    const download = await page.evaluate(() => window.__auditDownloads[0]);
    assert.ok(download.filename.endsWith(".xlsx") && download.bytes > 100 && download.header[0] === 80 && download.header[1] === 75, "Excel export must produce a workbook ZIP");
    assert.deepEqual(errors, [], `Browser errors (${name})`);
    return { name, phases, resources, geometry, download };
  } finally { await context.close(); }

  async function phase(stage, execute) {
    const previous = await metrics(cdp);
    await page.evaluate(stage => {
      window.__auditPhaseStarted = null;
      window.__auditPhaseDuration = undefined;
      const selector = { data: '[data-tab="data"]', excel: "#btn-export-data" }[stage];
      if (selector) document.querySelector(selector).addEventListener("click", () => { window.__auditPhaseStarted = performance.now(); }, { once: true, capture: true });
      window.__auditPhase = new Promise(resolve => {
        const inspect = () => {
          const ready = stage === "formula" ? document.querySelectorAll("#messages mjx-container svg").length === 2
            : stage === "data" ? document.querySelector("#data-detail .tabulator-cell")?.getBoundingClientRect().height && !document.querySelector("#data-loading")?.offsetHeight
            : window.__auditDownloads.length === 1;
          if (window.__auditPhaseStarted !== null && ready) requestAnimationFrame(() => { window.__auditPhaseDuration = performance.now() - window.__auditPhaseStarted; resolve(window.__auditPhaseDuration); });
          else requestAnimationFrame(inspect);
        }; requestAnimationFrame(inspect);
      });
    }, stage);
    await execute();
    await page.waitForFunction(() => Number.isFinite(window.__auditPhaseDuration));
    const durationMs = await page.evaluate(() => window.__auditPhase);
    phases[stage] = { durationMs, ...delta(previous, await metrics(cdp)) };
  }
  async function capture(stage) {
    resources[stage] = await page.evaluate(() => ({ scripts: performance.getEntriesByType("resource").filter(item => /\.(?:m?js)(?:[?#]|$)/.test(item.name)).map(item => ({ path: new URL(item.name).pathname, bytes: item.decodedBodySize })), mathReady: Boolean(globalThis.MathJax?.typesetPromise), legacySheetJsGlobal: Boolean(globalThis.XLSX?.read) }));
    if (!visual || stage === "excel") return;
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    await page.mouse.move(0, 0);
    const screenshot = join(output, `${colorScheme}-${name}-${stage}.png`);
    let previous;
    for (let attempt = 0; attempt < 8; attempt++) {
      const bytes = await page.screenshot({ animations: "disabled", caret: "hide" });
      const layout = await page.locator(stage === "data" ? "#data-panel" : "#app").evaluateAll(roots => [...roots[0].querySelectorAll("*")].filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height).map(element => { const box = element.getBoundingClientRect(); return [element.tagName, element.id, ...[box.x, box.y, box.width, box.height].map(value => Math.round(value * 100) / 100)]; }));
      const signature = `${createHash("sha256").update(bytes).digest("hex")}:${JSON.stringify(layout)}`;
      if (previous === signature) { writeFileSync(screenshot, bytes); geometry[stage] = layout; break; }
      previous = signature;
    }
    assert.ok(existsSync(screenshot), `Screenshot did not settle: ${screenshot}`);
    save(`${colorScheme}-${name}-${stage}.geometry.json`, geometry[stage]);
  }
}
async function metrics(cdp) { return Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value])); }
function delta(a, b) { return { scriptMs: (b.ScriptDuration - a.ScriptDuration) * 1000, taskMs: (b.TaskDuration - a.TaskDuration) * 1000 }; }
function median(values) { const sorted = values.sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; }

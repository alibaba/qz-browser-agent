import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { assertPublicReleasePackage } from "./public-package.mjs";
import { verifyStaticEngines } from "./static-engines.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { checkDependencyAssets } from "../../scripts/vendor/assets.mjs";
import "../support/typescript-loader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
console.log("browser=chromium package=chrome-release-zip suite=release-chrome-smoke");
const executablePath = findChromeExecutable(chromium.executablePath());
if (!executablePath) {
  throw new Error("Release Chrome smoke requires Chromium; run npx playwright install chromium or set CHROME_EXECUTABLE.");
}

const work = mkdtempSync(join(tmpdir(), "qingzhou-release-chrome-"));
const output = join(work, "release");
const extracted = join(work, "extracted");
const profile = join(work, "profile");
const version = "0.0.0.943";
let context;

try {
  execFileSync("python3", [
    join(ROOT, "scripts/publish-release.py"),
    "--version", version,
    "--source", "worktree",
    "--target", "webstore",
    "--output-dir", output,
  ], { cwd: ROOT, stdio: "pipe" });
  const zipPath = join(output, version, "webstore", `qz-browser-agent-extension-${version}.webstore.zip`);
  assertPublicReleasePackage(zipPath);
  execFileSync("python3", [
    "-c",
    "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zipPath,
    extracted,
  ]);
  let extensionPath = extracted;
  await checkDependencyAssets({ extensionDir: extensionPath });

  context = await launchExtension(extensionPath);

  const worker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"))
    || await context.waitForEvent("serviceworker", {
      predicate: item => item.url().startsWith("chrome-extension://"),
      timeout: 10_000,
    });
  assert.match(worker.url(), /\/background\/service-worker\.js$/);
  const extensionId = new URL(worker.url()).host;
  const workerVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(workerVersion, version);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().key), undefined);

  const page = await context.newPage();
  const pageErrors = [];
  const scripts = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await acceptDataDisclosure(page);
  await page.waitForSelector("#input", { state: "attached" });
  await page.waitForFunction(() => document.activeElement?.id === "input", null, { timeout: 10_000 });

  await page.locator('[data-tab="sessions"]').click();
  await page.waitForFunction(() => !document.querySelector("#sessions-panel")?.classList.contains("hidden"));
  await page.locator('[data-tab="chat"]').click();
  await page.waitForFunction(() => document.querySelector('[data-tab="chat"]')?.classList.contains("active"));

  const globals = await page.evaluate(() => ({
    marked: typeof globalThis.marked?.parse === "function",
    mathjax: Boolean(globalThis.MathJax),
    tabulator: typeof globalThis.Tabulator === "function",
  }));
  assert.deepEqual(globals, { marked: false, mathjax: true, tabulator: false });
  assert.equal(scripts.some(url => /\/vendor\/mathjax\/|chunk-data-grid-vendor-|chunk-xlsx/u.test(url)), false,
    "the readable panel must not load heavy features during ordinary navigation");
  // SheetJS mini also publishes a compatibility global; the application must use its module import.
  await page.evaluate(() => { delete globalThis.XLSX; });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ name: "release-excel-probe", score: 42 }]), "probe");
  await page.locator('[data-tab="data"]').click();
  await page.locator('#btn-import-data').click();
  await page.locator('#data-import-table').fill('release-probe');
  await page.locator('#data-import-file').setInputFiles({
    name: 'probe.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }),
  });
  await page.locator('.tabulator-cell').filter({ hasText: 'release-excel-probe' }).waitFor();
  assert.equal(scripts.filter(url => /chunk-xlsx/u.test(url)).length, 1);
  assert.equal(scripts.filter(url => /chunk-data-grid-vendor-/u.test(url)).length, 1);
  await page.waitForTimeout(300);
  assert.deepEqual(pageErrors, []);
  const staticEngines = await verifyStaticEngines({ context, page, worker });
  assert.deepEqual(pageErrors, []);

  await context.close();
  context = null;
  const backgroundE2eOutput = execFileSync(process.execPath, [
    join(ROOT, "tests/background/extension-e2e.mjs"),
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, QINGZHOU_EXTENSION_PATH: extensionPath },
  });
  const backgroundE2e = JSON.parse(backgroundE2eOutput.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(backgroundE2e.ok, true);

  execFileSync("python3", [
    join(ROOT, "scripts/publish-release.py"),
    "--version", version, "--source", "worktree", "--target", "manual", "--output-dir", output,
  ], { cwd: ROOT, stdio: "pipe" });
  execFileSync("python3", [
    "-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    join(output, version, `qz-browser-agent-extension-${version}.zip`), join(work, "manual"),
  ]);
  extensionPath = join(work, "manual", "qz-browser-agent-extension");
  context = await launchExtension(extensionPath);
  const manualWorker = context.serviceWorkers().find(item => item.url().endsWith("/background/service-worker.js"))
    || await context.waitForEvent("serviceworker", { timeout: 10_000 });
  const manualExtensionId = new URL(manualWorker.url()).host;
  assert.equal(await manualWorker.evaluate(() => chrome.runtime.getManifest().key),
    JSON.parse(readFileSync(join(ROOT, "src/manifest.json"), "utf8")).key);
  await manualWorker.evaluate(() => chrome.storage.local.set({ __qzIdentityProbe: "relocated" }));
  await context.close();
  context = null;
  const relocatedPath = join(work, "relocated extension 开源");
  renameSync(extensionPath, relocatedPath);
  extensionPath = relocatedPath;
  context = await launchExtension(extensionPath);
  const relocatedWorker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"))
    || await context.waitForEvent("serviceworker", {
      predicate: item => item.url().startsWith("chrome-extension://"),
      timeout: 10_000,
    });
  assert.equal(new URL(relocatedWorker.url()).host, manualExtensionId, "moving the installation preserves its identity");
  assert.deepEqual(await relocatedWorker.evaluate(() => chrome.storage.local.get("__qzIdentityProbe")),
    { __qzIdentityProbe: "relocated" }, "moving the installation preserves its stored data");
  await context.close();
  context = null;
  console.log(JSON.stringify({
    ok: true,
    version,
    extensionId,
    manualExtensionId,
    relocationPreservesIdentityAndStorage: true,
    serviceWorker: true,
    sidepanel: true,
    dependencyGlobals: globals,
    excelImportAndGrid: true,
    staticEngines,
    backgroundScenarios: backgroundE2e.scenarios,
  }));
} finally {
  await context?.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}

function launchExtension(extensionPath) {
  return chromium.launchPersistentContext(profile, {
    locale: "zh-CN",
    headless: true,
    executablePath,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 980, height: 860 },
    args: [
      "--lang=zh-CN",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

function findChromeExecutable(bundled = "") {
  return [
    process.env.CHROME_EXECUTABLE,
    bundled,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find(existsSync) || "";
}

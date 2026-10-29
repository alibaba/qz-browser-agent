import { defineConfig } from "@playwright/test";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChromiumChannel } from "../support/browser-package.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import "../support/typescript-loader.mjs";

const chromiumChannel = assertChromiumChannel();

if (!process.argv.includes("--list") && !process.argv.includes("--help")) {
  process.env.QINGZHOU_TEST_EXTENSION_DIR = await ensureTestExtension();
  console.log(`browser=chromium package=dist/extension dir=${process.env.QINGZHOU_TEST_EXTENSION_DIR}`);
} else {
  console.log("browser=chromium package=dist/extension config=tests/config/playwright.config.mjs");
}

const testsRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.QINGZHOU_TEST_PORT || 4173);
const defaultWorkers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 3)));
const workers = clampNumber(process.env.QINGZHOU_PLAYWRIGHT_WORKERS, 1, 16, defaultWorkers);
const viewportFuzzPattern = /viewport-stability-fuzz\.spec\.mjs/;
// Local reports and exported source snapshots must never become test inputs.
const ignoredArtifacts = ["**/results/**"];

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

export default defineConfig({
  // One TS transform keeps Node and Playwright coverage offsets compatible.
  build: { external: ["**/src/**"] },
  testDir: testsRoot,
  testIgnore: ignoredArtifacts,
  testMatch: ["browser/**/*.spec.mjs"],
  outputDir: resolve(testsRoot, "results/playwright"),
  fullyParallel: true,
  workers,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ["line"],
    ["html", { outputFolder: resolve(testsRoot, "results/playwright-report"), open: "never" }],
  ],
  use: {
    locale: "zh-CN",
    baseURL: `http://127.0.0.1:${port}`,
    channel: chromiumChannel || "chromium",
    headless: process.env.QINGZHOU_TEST_HEADED !== "1",
    // API traces retain failure diagnostics; DOM snapshots are opt-in for visual debugging.
    trace: process.env.QINGZHOU_TEST_TRACE_SNAPSHOTS === "1" ? "retain-on-failure"
      : { mode: "retain-on-failure", snapshots: false, screenshots: false, sources: false },
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chrome-fuzz", testMatch: viewportFuzzPattern },
    { name: "chrome", testIgnore: [...ignoredArtifacts, viewportFuzzPattern] },
  ],
  webServer: {
    command: `node tests/support/static-server.mjs --port ${port} --watch-stdin`,
    url: `http://127.0.0.1:${port}/__test_health`,
    cwd: resolve(testsRoot, ".."),
    reuseExistingServer: false,
    timeout: 10_000,
  },
});

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

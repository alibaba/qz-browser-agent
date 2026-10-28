import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workers = clampNumber(process.env.QINGZHOU_FIREFOX_PLAYWRIGHT_WORKERS, 1, 4, 1);

console.log("browser=firefox package=dist/extension-firefox config=tests/config/playwright.firefox.config.mjs");

export default defineConfig({
  testDir: resolve(testsRoot, "firefox"),
  testMatch: ["**/*.spec.mjs"],
  outputDir: resolve(testsRoot, "results/playwright-firefox"),
  fullyParallel: false,
  workers,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["line"],
    ["html", { outputFolder: resolve(testsRoot, "results/playwright-firefox-report"), open: "never" }],
  ],
  projects: [
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        channel: "moz-firefox",
        headless: process.env.QINGZHOU_FIREFOX_HEADED !== "1",
      },
    },
  ],
});

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

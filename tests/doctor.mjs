#!/usr/bin/env node
import { assertChromiumChannel } from "./support/browser-package.mjs";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const failures = [];
const details = [];

const nodeMajor = Number(process.versions.node.split(".")[0]);
check(nodeMajor >= 24, `Node ${process.versions.node}`, "Node >= 24 is required (24 LTS recommended)");

for (const packageName of ["@playwright/test", "playwright", "c8", "esbuild", "typescript", "tsx", "@types/chrome", "terser"]) {
  try {
    const packageJson = require(`${packageName}/package.json`);
    details.push(`${packageName} ${packageJson.version}`);
  } catch (_error) {
    failures.push(`${packageName} is missing; run npm ci`);
  }
}

const uvEnv = { ...process.env };
delete uvEnv.VIRTUAL_ENV;
delete uvEnv.UV_INDEX_URL;
delete uvEnv.UV_EXTRA_INDEX_URL;
const uv = spawnSync("uv", ["--version"], { cwd: root, env: uvEnv, encoding: "utf8" });
if (uv.status === 0) details.push(uv.stdout.trim());
else failures.push("uv is missing or not executable");

for (const path of [
  "package-lock.json",
  "tests/python/uv.lock",
]) {
  check(existsSync(join(root, path)), path, `missing lock file: ${path}`);
}

checkManifestPaths();
await checkChrome();

if (failures.length) {
  console.error("Qingzhou test environment is not ready:");
  failures.forEach(item => console.error(`  - ${item}`));
  process.exit(1);
}

console.log("Qingzhou test environment ready");
details.forEach(item => console.log(`  ${item}`));

function check(condition, success, failure) {
  if (condition) details.push(success);
  else failures.push(failure);
}

function checkManifestPaths() {
  const manifestPath = join(root, "src/manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`invalid src/manifest.json: ${error.message}`);
    return;
  }

  const paths = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.action?.default_icon || {}),
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(item => [...(item.js || []), ...(item.css || [])]),
    ...(manifest.web_accessible_resources || []).flatMap(item => item.resources || []),
  ].filter(path => path && !String(path).includes("*"));

  const missing = paths.filter(path => !existsSync(join(root, "src", path))
    && !(path.endsWith(".js") && existsSync(join(root, "src", path.replace(/\.js$/, ".ts")))));
  check(!missing.length, `manifest paths ${paths.length}/${paths.length}`, `manifest paths missing: ${missing.join(", ")}`);
}

async function checkChrome() {
  try {
    const { chromium } = await import("playwright");
    const bundledPath = chromium.executablePath();
    check(
      existsSync(bundledPath),
      "Playwright Chromium installed",
      "Playwright Chromium is missing; run npx playwright install chromium",
    );
    const channel = assertChromiumChannel();
    const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
    const version = browser.version();
    await browser.close();
    details.push(`Browser ${channel || "locked Chromium"} (${version})`);
  } catch (error) {
    failures.push(`Chrome channel is unavailable: ${error.message}`);
  }
}

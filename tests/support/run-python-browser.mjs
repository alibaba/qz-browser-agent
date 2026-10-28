#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChromiumChannel } from "./browser-package.mjs";
import { ensureTestExtension } from "./extension-build.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scriptArgs = process.argv.slice(2);
if (!scriptArgs.length) {
  console.error("Usage: node tests/support/run-python-browser.mjs <script.py> [...args]");
  process.exit(2);
}

assertChromiumChannel();
const env = { ...process.env };
env.QINGZHOU_TEST_EXTENSION_DIR = await ensureTestExtension();
console.log(`browser=chromium package=dist/extension dir=${env.QINGZHOU_TEST_EXTENSION_DIR}`);
env.PYTHONPATH = [join(root, "tests/support"), env.PYTHONPATH].filter(Boolean).join(delimiter);
delete env.VIRTUAL_ENV;
delete env.UV_INDEX_URL;
delete env.UV_EXTRA_INDEX_URL;

const result = spawnSync("uv", [
  "run",
  "--project",
  "tests/python",
  "--default-index",
  "https://pypi.org/simple",
  "--locked",
  "python",
  ...scriptArgs,
], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

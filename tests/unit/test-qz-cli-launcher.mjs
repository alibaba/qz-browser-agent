import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const launcher = new URL("../../services/mcp-bridge/src/bin.mjs", import.meta.url);
const sourceCli = new URL("../../services/mcp-bridge/src/cli.mjs", import.meta.url);
const metadata = JSON.parse(readFileSync(new URL("../../services/mcp-bridge/package.json", import.meta.url), "utf8"));

test("launcher rejects unsupported Node before resolving runtime modules", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qz-node-guard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const isolatedLauncher = join(directory, "bin.mjs");
  await copyFile(launcher, isolatedLauncher);
  // Deliberately omit cli.mjs and all dependencies: only the guard can run here.
  for (const version of ["18.20.8", "20.20.1", "22.15.0", "23.11.0"]) {
    const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`)}`;
    for (const json of [false, true]) {
      const result = spawnSync(process.execPath, ["--import", preload, isolatedLauncher, "--version", ...(json ? ["--json"] : [])], { encoding: "utf8" });
      assert.equal(result.status, 1);
      if (json) {
        assert.equal(result.stderr, "");
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, "unsupported_node_version");
        assert.match(payload.error.message, /requires Node\.js 24 or later/);
        assert.ok(payload.error.message.includes(version));
        assert.match(payload.error.hint, /Install Node\.js 24/);
      } else {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /requires Node\.js 24 or later/);
        assert.ok(result.stderr.includes(version));
      }
      assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find|SyntaxError/);
    }
  }
});

test("importing the launcher does not execute CLI or resolve its runtime", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qz-bin-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const isolatedLauncher = join(directory, "bin.mjs");
  await copyFile(launcher, isolatedLauncher);
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(isolatedLauncher).href)});`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("launcher and direct source entry print versions without writing service state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qz-version-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const entry of [launcher, sourceCli]) {
    for (const flags of [["--version"], ["-v"], ["--json", "--version"]]) {
      const result = spawnSync(process.execPath, [fileURLToPath(entry), ...flags], {
        encoding: "utf8", env: { ...process.env, QZ_STATE_DIR: directory },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      if (flags.includes("--json")) assert.deepEqual(JSON.parse(result.stdout), {
        ok: true, result: { name: metadata.name, version: metadata.version },
      });
      else assert.equal(result.stdout, `qz ${metadata.version}\n`);
    }
  }
  assert.deepEqual(await readdir(directory), []);
});

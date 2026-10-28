import assert from "node:assert/strict";
import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileInnerWorker } from "../../scripts/build-extension.mjs";
import { checkStore } from "../../scripts/check-store.mjs";

const root = await mkdtemp(join(tmpdir(), "qz-storecheck-"));
try {
  await mkdir(join(root, "icons"));
  await copyFile("src/icons/icon128.png", join(root, "icons/icon128.png"));
  const actual = JSON.parse(await readFile("src/manifest.json", "utf8"));
  const manifest = { manifest_version: 3, name: "Store gate regression fixture",
    version: "0.1.5", description: "Synthetic local fixture for validating the Chrome Web Store release gate.",
    icons: { 128: "icons/icon128.png" }, permissions: ["debugger"], host_permissions: ["<all_urls>"],
    content_security_policy: actual.content_security_policy, sandbox: actual.sandbox };
  const saveManifest = () => writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await saveManifest();
  await copyFile("src/runner-sandbox.html", join(root, "runner-sandbox.html"));
  const worker = await compileInnerWorker({ mode: "production" });
  const built = await build({ absWorkingDir: resolve("src"), entryPoints: ["runner-sandbox.ts"], bundle: true,
    write: false, platform: "browser", format: "iife", target: "chrome114",
    define: { INNER_WORKER_SOURCE: JSON.stringify(worker) },
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } } });
  const sandbox = built.outputFiles[0].text;
  await writeFile(join(root, "runner-sandbox.js"), sandbox);
  const accepted = await checkStore(root);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.rawCliExitCode, 1, "never pretend the upstream CLI ignored the sandbox");
  assert.equal(accepted.exceptions.length, 1);
  assert.equal(accepted.effective.summary.errors, 0);
  assert.ok(accepted.effective.findings.some(finding => finding.ruleId === "permissions/high-risk-permissions"));
  assert.equal(accepted.effective.rulesRun, 24);

  await writeFile(join(root, "unrelated.js"), 'eval("untrusted");\n');
  assert.equal((await checkStore(root)).ok, false, "another file is never exempt");
  await rm(join(root, "unrelated.js"));
  await writeFile(join(root, "runner-sandbox.js"), `${sandbox}\nnew Function("extra code");\n`);
  assert.equal((await checkStore(root)).ok, false, "changed sandbox bytes revoke the exact exception");
  await writeFile(join(root, "runner-sandbox.js"), sandbox);
  delete manifest.sandbox;
  await saveManifest();
  assert.equal((await checkStore(root)).ok, false, "an unisolated runner is never exempt");
  manifest.sandbox = actual.sandbox;
  await saveManifest();
  await writeFile(join(root, "large.js"), "var one=1;".repeat(3000));
  const minified = await checkStore(root);
  assert.equal(minified.ok, false, "Red Titanium warnings also block, even with severity=error CLI");
  assert.ok(minified.blocking.some(finding => finding.ruleId === "code/minified-without-source"));
} finally { await rm(root, { recursive: true, force: true }); }
console.log("storecheck gate: exact sandbox exception, mutation and unrelated error rejection passed");

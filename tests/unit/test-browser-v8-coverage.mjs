import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, transform } from "esbuild";
import { capabilityBuildProfile } from "../../scripts/capability-catalog.mjs";
import { playwrightDomSources } from "../../scripts/vendor/playwright-dom.mjs";

import { createBrowserV8CoverageCollector } from "../support/browser-v8-coverage.mjs";

const compiledIdentity = await transform(readFileSync(
  new URL("../../src/shared/tools/tool-identity.ts", import.meta.url), "utf8",
), { loader: "ts", sourcefile: new URL("../../src/shared/tools/tool-identity.ts", import.meta.url).href, sourcemap: "external" });
const toolIdentitySource = compiledIdentity.code;

test("browser V8 coverage keeps local production scripts and merges worker ranges", async t => {
  const coverageDir = mkdtempSync(join(tmpdir(), "qingzhou-browser-coverage-"));
  t.after(() => rmSync(coverageDir, { recursive: true, force: true }));
  const extensionDir = join(coverageDir, "extension");
  mkdirSync(join(extensionDir, "shared/tools"), { recursive: true });
  writeFileSync(join(extensionDir, "shared/tools/tool-identity.js"), toolIdentitySource);
  writeFileSync(join(extensionDir, "shared/tools/tool-identity.js.map"), compiledIdentity.map);
  const collector = createBrowserV8CoverageCollector({ coverageDir: join(coverageDir, "v8"), extensionDir, workerIndex: 3 });
  assert.equal(collector.enabled, true);

  collector.merge([
    coverageEntry("http://127.0.0.1:4173/extension/shared/tools/tool-identity.js", 1, toolIdentitySource),
    coverageEntry("http://127.0.0.1:4173/extension/shared/tools/tool-identity.js", 2, toolIdentitySource),
    coverageEntry("http://127.0.0.1:4173/extension/shared/tools/tool-identity.js", 100),
    coverageEntry("http://127.0.0.1:4173/extension/shared/tools/tool-identity.js", 100, "rewritten test source"),
    coverageEntry("http://127.0.0.1:4173/extension/vendor/ignored.js", 9),
    coverageEntry("http://127.0.0.1:4173/tests/ignored.mjs", 9),
  ]);
  await collector.flush();

  const files = readdirSync(join(coverageDir, "v8"));
  assert.equal(files.length, 1);
  const report = JSON.parse(readFileSync(join(coverageDir, "v8", files[0]), "utf8"));
  assert.equal(report.result.length, 1);
  assert.match(report.result[0].url, /\/extension\/shared\/tools\/tool-identity\.js$/);
  assert.equal(report.result[0].functions[0].ranges[0].count, 3);
  assert.equal(Object.hasOwn(report.result[0], "functionKeys"), false);
});

test("browser V8 coverage stays inactive outside a c8 run", async () => {
  const collector = createBrowserV8CoverageCollector({ coverageDir: "" });
  assert.equal(collector.enabled, false);
  collector.merge([coverageEntry("http://127.0.0.1:4173/extension/shared/tools/tool-identity.js", 1)]);
  await collector.flush();
});

test("compiled browser coverage remaps through c8 to the TypeScript source", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qingzhou-ts-coverage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = resolve("src/capabilities/sessions/goal-tools.ts");
  const extensionDir = join(directory, "extension");
  const generated = join(extensionDir, "capabilities/sessions/goal-tools.js");
  const compiled = await transform(readFileSync(original, "utf8"), {
    loader: "ts", sourcefile: pathToFileURL(original).href, sourcemap: "external", sourcesContent: true,
  });
  mkdirSync(dirname(generated), { recursive: true });
  writeFileSync(generated, compiled.code);
  writeFileSync(`${generated}.map`, compiled.map);
  const coverageDir = join(directory, "v8");
  const collector = createBrowserV8CoverageCollector({ coverageDir, extensionDir });
  collector.merge([{
    url: "http://127.0.0.1:4173/extension/capabilities/sessions/goal-tools.js",
    source: compiled.code,
    functions: [{ functionName: "", isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: compiled.code.length, count: 1 }] }],
  }]);
  await collector.flush();
  const reportDir = join(directory, "report");
  execFileSync(process.execPath, ["node_modules/c8/bin/c8.js", "report", "--all=false",
    "--exclude-after-remap", "--include=src/capabilities/sessions/goal-tools.ts",
    "--temp-directory", coverageDir, "--reports-dir", reportDir, "--reporter=json-summary"], { stdio: "pipe" });
  const report = JSON.parse(readFileSync(join(reportDir, "coverage-summary.json"), "utf8"));
  assert.ok(report[original]?.lines.covered > 0, "generated offsets must count against the TS source");
  assert.equal(Object.keys(report).some(key => key.endsWith("goal-tools.js")), false);
});

test("classic entry coverage keeps first-party sources beside bundled npm code", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qingzhou-content-coverage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const extensionDir = join(directory, "extension");
  const generated = join(extensionDir, "content/content-script.js");
  const compiled = await build({ entryPoints: ["src/content/content-script.ts"], bundle: true,
    format: "iife", platform: "browser", outfile: generated, write: false, sourcemap: "external", sourcesContent: true,
    plugins: [capabilityBuildProfile(resolve("src")).plugin, playwrightDomSources()] });
  mkdirSync(join(extensionDir, "content"), { recursive: true });
  for (const output of compiled.outputFiles) writeFileSync(output.path, output.contents);
  const source = readFileSync(generated, "utf8");
  const coverageDir = join(directory, "v8");
  const collector = createBrowserV8CoverageCollector({ coverageDir, extensionDir });
  collector.merge([{ url: "http://127.0.0.1:4173/extension/content/content-script.js", source,
    functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }] }]);
  await collector.flush();
  const reportDir = join(directory, "report");
  execFileSync(process.execPath, ["node_modules/c8/bin/c8.js", "report", "--all=false",
    "--exclude-after-remap", "--include=src/content/content-script.ts", "--temp-directory", coverageDir,
    "--reports-dir", reportDir, "--reporter=json-summary"], { stdio: "pipe" });
  const report = JSON.parse(readFileSync(join(reportDir, "coverage-summary.json"), "utf8"));
  assert.ok(report[resolve("src/content/content-script.ts")]?.lines.covered > 0);
  assert.equal(Object.keys(report).some(key => key.includes("node_modules")), false);
});

function coverageEntry(url, count, source) {
  return {
    url,
    ...(source === undefined ? {} : { source }),
    functions: [{
      functionName: "probe",
      isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: 20, count }],
    }],
  };
}

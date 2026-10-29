import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTENSION_ENTRIES, extensionOutputDirectory } from "../../scripts/build-extension.mjs";
import { firefoxManifest } from "../../scripts/firefox-manifest.mjs";

const CLI = fileURLToPath(new URL("../../scripts/build-extension.mjs", import.meta.url));
const TYPECHECK = new URL("../../scripts/typecheck.mjs", import.meta.url).href;

test("build help is side-effect free, including npm's production/typecheck defaults", async t => {
  const fixture = await workspace(t);
  const env = await typecheckFixture(fixture, "process.exitCode = 23;");
  for (const help of ["--help", "-h"]) {
    const result = run(["--mode", "production", "--typecheck", "--watch", help,
      "--source-dir", join(fixture.work, "missing"), "--output-dir", fixture.output], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: npm run dev/);
    assert.match(result.stdout, /npm run build/);
    assert.match(result.stdout, /dist\/extension\//);
    assert.match(result.stdout, /--browser <chrome\|firefox>/);
    assert.match(result.stdout, /dist\/extension-firefox\//);
    assert.match(result.stdout, /npm run build:firefox/);
    assert.match(result.stdout, /npm run dev:firefox/);
    assert.equal(existsSync(fixture.output), false);
    assert.equal(existsSync(fixture.checked), false);
  }
});

test("build rejects invalid arguments before typechecking or creating output", async t => {
  const fixture = await workspace(t);
  const env = await typecheckFixture(fixture, "process.exitCode = 23;");
  for (const args of [["--unknown"], ["unexpected"], ["--output-dir"], ["--mode"],
    ["--mode", "--watch"], ["--mode=staging"], ["--product=unknown"], ["--source-dir="],
    ["--browser"], ["--browser="], ["--browser=safari"]]) {
    const result = run(["--typecheck", "--output-dir", fixture.output, ...args], { env });
    assert.equal(result.status, 1, args.join(" "));
    assert.ok(result.stderr.trim(), "invalid arguments explain the failure");
    assert.equal(result.stdout, "");
    assert.equal(existsSync(fixture.output), false);
    assert.equal(existsSync(fixture.checked), false);
  }
});

test("a failed or interrupted typecheck preserves the last successful output", async t => {
  const fixture = await workspace(t);
  await mkdir(fixture.output);
  const previous = join(fixture.output, "previous-build.txt");
  await writeFile(previous, "last successful extension");
  for (const [source, status, message] of [
    ['console.error("fixture type error"); process.exitCode = 23;', 23, /fixture type error/],
    ['process.kill(process.pid, "SIGTERM");', 1, /Typecheck interrupted \(SIGTERM\)/],
  ]) {
    const env = await typecheckFixture(fixture, source);
    const result = run(["--typecheck", "--source-dir", join(fixture.work, "missing"),
      "--output-dir", fixture.output], { env });
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(previous, "utf8"), "last successful extension");
    assert.equal(existsSync(join(fixture.output, ".qingzhou-build.json")), false);
    assert.equal(existsSync(fixture.checked), true);
  }
});

test("build prints a concise summary and forwards production and product options", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const result = run(["--source-dir", fixture.source, "--output-dir", fixture.output,
    "--mode=production", "--product=public", "--no-bundle", "--debug-maps"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Built \d+ files \(production, public, chrome\) in /);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const manifest = JSON.parse(await readFile(join(fixture.output, ".qingzhou-build.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest, "browser"), false);
  assert.equal(manifest.mode, "production");
  assert.equal(manifest.product, "public");
  assert.equal(manifest.debugMaps, true);
  assert.equal(manifest.bundling.enabled, false);
  assert.ok(manifest.files.includes("background/service-worker.js"));
});

test("JSON build output remains parseable when the typecheck gate prints progress", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const env = await typecheckFixture(fixture, 'console.log("Typecheck fixture passed");');
  const result = run(["--source-dir", fixture.source, "--output-dir", fixture.output, "--typecheck", "--json"], { env });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.browser, "chrome");
  assert.equal(summary.mode, "development");
  assert.equal(summary.outputDir, fixture.output);
  const packaged = JSON.parse(await readFile(join(fixture.output, ".qingzhou-build.json"), "utf8"));
  assert.equal(Object.hasOwn(packaged, "browser"), false);
  assert.equal(summary.formatVersion, 1);
  assert.ok(summary.files.includes("background/service-worker.js"));
  assert.match(result.stderr, /Typecheck fixture passed/);
  assert.equal(existsSync(fixture.checked), true);
});

test("firefox packaging rewrites only the firefox output manifest", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const chromeDir = join(fixture.work, "chrome");
  const firefoxDir = join(fixture.work, "firefox");
  const chrome = run(["--source-dir", fixture.source, "--output-dir", chromeDir, "--no-bundle"]);
  assert.equal(chrome.status, 0, chrome.stderr);
  const firefox = run(["--source-dir", fixture.source, "--output-dir", firefoxDir, "--browser", "firefox", "--no-bundle"]);
  assert.equal(firefox.status, 0, firefox.stderr);
  const source = JSON.parse(await readFile(join(fixture.source, "manifest.json"), "utf8"));
  const chromeManifest = JSON.parse(await readFile(join(chromeDir, "manifest.json"), "utf8"));
  const firefoxBuilt = JSON.parse(await readFile(join(firefoxDir, "manifest.json"), "utf8"));
  assert.deepEqual(chromeManifest, source);
  assert.deepEqual(firefoxBuilt, firefoxManifest(source));
  assert.equal(firefoxBuilt.sidebar_action.default_panel, "sidepanel/sidepanel.html");
  assert.deepEqual(firefoxBuilt.background.scripts, ["background/firefox-boot.js"]);
  assert.equal(chromeManifest.sidebar_action, undefined);
  assert.equal(chromeManifest.background.scripts, undefined);
  assert.equal(extensionOutputDirectory("chrome").endsWith(`${join("dist", "extension")}`), true);
  assert.equal(extensionOutputDirectory("firefox").endsWith(join("dist", "extension-firefox")), true);
  assert.throws(() => extensionOutputDirectory("safari"), /unknown browser: safari/);
});

test("a shared import of a Firefox-only module fails the Chrome build and passes the Firefox build", async t => {
  const fixture = await workspace(t);
  await extensionFixture(fixture.source);
  const worker = join(fixture.source, "background/service-worker.js");
  await writeFile(worker, `import "./firefox/host.js";\n${await readFile(worker, "utf8")}`);
  await mkdir(join(fixture.source, "background/firefox"), { recursive: true });
  await writeFile(join(fixture.source, "background/firefox/host.ts"), "export const firefoxHost = true;\n");
  const chromeDir = join(fixture.work, "chrome-fence");
  const firefoxDir = join(fixture.work, "firefox-fence");
  const chrome = run(["--source-dir", fixture.source, "--output-dir", chromeDir, "--no-bundle"]);
  assert.equal(chrome.status, 1);
  assert.match(chrome.stderr, /Chrome package cannot import Firefox-only source background\/firefox\/host\.js from background\/service-worker\.js/);
  assert.equal(existsSync(chromeDir), false);
  const firefox = run(["--source-dir", fixture.source, "--output-dir", firefoxDir, "--browser", "firefox", "--no-bundle", "--json"]);
  assert.equal(firefox.status, 0, firefox.stderr);
  const summary = JSON.parse(firefox.stdout);
  assert.equal(summary.browser, "firefox");
  const packaged = JSON.parse(await readFile(join(firefoxDir, ".qingzhou-build.json"), "utf8"));
  assert.equal(Object.hasOwn(packaged, "browser"), false);
  assert.ok(packaged.files.includes("background/firefox/host.js"));
});

test("firefox npm scripts target the firefox package and chrome scripts stay chrome", () => {
  const scripts = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")).scripts;
  assert.equal(scripts.build, "node scripts/build-extension.mjs --mode production --typecheck");
  assert.equal(scripts.dev, "node scripts/build-extension.mjs --watch");
  assert.equal(scripts["build:firefox"], "node scripts/build-extension.mjs --mode production --typecheck --browser firefox");
  assert.equal(scripts["dev:firefox"], "node scripts/build-extension.mjs --watch --browser firefox");
  assert.equal(scripts.release, "python3 scripts/publish-release.py");
  assert.equal(scripts["release:firefox"], "python3 scripts/publish-release.py --target firefox");
  assert.equal(scripts.verify, "npm run typecheck && npm test -- unit contracts services");
  assert.equal(scripts["verify:chrome"], "npm test -- browser e2e release visual");
  assert.equal(scripts["verify:firefox"], "npm run typecheck && npm test -- firefox");
  assert.equal(scripts["verify:coverage"], "npm run typecheck && npm test -- --all --coverage");
  assert.equal(scripts["verify:quick"], undefined);
});

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 30_000, ...options });
}

async function workspace(t) {
  const work = await realpath(await mkdtemp(join(tmpdir(), "qingzhou-build-cli-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  return { work, source: join(work, "src"), output: join(work, "output"), checked: join(work, "typecheck-ran") };
}

async function typecheckFixture(fixture, source) {
  const hook = join(fixture.work, "typecheck-fixture.mjs");
  const checker = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(fixture.checked)}, 'yes'); ${source}`;
  await writeFile(hook, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  if (url === ${JSON.stringify(TYPECHECK)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(checker)} };
  return next(url, context);
} });\n`);
  return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(pathToFileURL(hook).href)}` };
}

async function extensionFixture(root) {
  const files = {
    "manifest.json": JSON.stringify({ manifest_version: 3,
      background: { service_worker: "background/service-worker.js", type: "module" },
      side_panel: { default_path: "sidepanel/sidepanel.html" },
      content_scripts: [{ js: EXTENSION_ENTRIES.filter(entry => entry.path.startsWith("content/")).map(entry => entry.path) }],
      sandbox: { pages: ["runner-sandbox.html"] }, declarative_net_request: { rule_resources: [] } }),
    "products/manifest.json": JSON.stringify({ version: 1, defaultProduct: "public", ports: [] }),
    "sidepanel/sidepanel.html": '<script type="module" src="sidepanel.js"></script>',
    "offscreen.html": '<script type="module" src="offscreen.js"></script>',
    "runner-sandbox.html": '<script src="runner-sandbox.js"></script>',
    ...Object.fromEntries(EXTENSION_ENTRIES.map(entry => [entry.path, "globalThis.fixture = true;\n"])),
  };
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

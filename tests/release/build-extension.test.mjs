import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { SourceMap } from "node:module";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { minify } from "terser";
import { buildExtension, compileEmbeddedScript, EXTENSION_ENTRIES, watchExtension } from "../../scripts/build-extension.mjs";
import { acquireBuildOutput, isBuildProcessRunning } from "../../scripts/build-output-lock.mjs";
import { bundleExtension, stableDebugSourceMap } from "../../scripts/build-extension-bundles.mjs";
import { capabilityUiAssets } from "../../scripts/capability-catalog.mjs";
import { capabilityLocaleAssets } from "../../scripts/capability-locales.mjs";
import { readProductProfile } from "../../scripts/product-profile.mjs";
import { checkDependencyAssets } from "../../scripts/vendor/assets.mjs";
import { runInnerWorker, sandboxFixture } from "../support/inner-runner-fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Windows-style Git checkout preserves upstream license hashes", async t => {
  const work = await workspace(t);
  const git = (...args) => promisify(execFile)("git", args, { cwd: work });
  await git("init", "-q");
  await cp(join(ROOT, ".gitattributes"), join(work, ".gitattributes"));
  await cp(join(ROOT, "scripts/vendor/licenses"), join(work, "scripts/vendor/licenses"), { recursive: true });
  await writeFile(join(work, "probe.txt"), "checkout\n");
  await git("-c", "core.autocrlf=false", "add", ".");
  await rm(join(work, "scripts"), { recursive: true });
  await rm(join(work, "probe.txt"));
  await git("-c", "core.autocrlf=true", "checkout-index", "--all", "--force");
  assert.equal(await readFile(join(work, "probe.txt"), "utf8"), "checkout\r\n");
  const supplements = JSON.parse(await readFile(join(work, "scripts/vendor/licenses/supplements.json"), "utf8"));
  for (const supplement of Object.values(supplements)) {
    const bytes = await readFile(join(work, "scripts/vendor/licenses", supplement.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), supplement.sha256);
  }
});

test("development build preserves application modules and generates locked runtime assets deterministically", async t => {
  const work = await workspace(t);
  const sourceDir = join(work, "source");
  await cp(join(ROOT, "src"), sourceDir, { recursive: true });
  const first = await buildExtension({ sourceDir, outputDir: join(work, "first") });
  const second = await buildExtension({ sourceDir, outputDir: join(work, "second") });
  assert.deepEqual(first.files, second.files);
  assert.equal(await treeDigest(first.outputDir), await treeDigest(second.outputDir));
  assert.equal(first.bundling.enabled, false);
  assert.equal(first.files.includes("products/manifest.json"), false);
  assert.ok(first.files.length > 250);
  await checkDependencyAssets({ extensionDir: first.outputDir });
  assert.match(await readFile(join(first.outputDir, "vendor/pdf.mjs"), "utf8"), /Local PDF worker is not registered/);
  assert.doesNotMatch(await readFile(join(first.outputDir, "vendor/mathjax/startup.js"), "utf8"), /__webpack_require__|MathJax\.config\.loader/);
  const canonicalSource = await realpath(sourceDir);
  const uiAssets = await capabilityUiAssets(canonicalSource);
  const localeAssets = capabilityLocaleAssets(canonicalSource, { includes: (await readProductProfile(canonicalSource)).includes });
  for (const path of first.files) {
    if (path.startsWith("vendor/") || path.startsWith("deps/")) continue;
    const typedSource = join(sourceDir, path.replace(/\.js(?:\.map)?$/, ".ts"));
    if (/\.js(?:\.map)?$/.test(path) && await access(typedSource).then(() => true, () => false)) continue;
    if (!path.startsWith("vendor/") && (path.endsWith(".js.map") || first.files.includes(`${path}.map`))) continue;
    if (path === "rules/provider-headers.json") continue; // Product rule fragments are merged structurally.
    const transformed = uiAssets.overrides.get(join(canonicalSource, path)) ?? localeAssets.assets.get(join(canonicalSource, path));
    const expected = transformed === undefined ? await readFile(join(sourceDir, path)) : Buffer.from(transformed);
    // Buffer diff formatting can consume gigabytes for a changed stylesheet; equality remains byte-exact.
    assert.ok((await readFile(join(first.outputDir, path))).equals(expected), `${path} preserves its copied or assembled asset bytes`);
  }
  const inventory = await readFile(join(first.outputDir, ".qingzhou-build.json"), "utf8");
  assert.equal(inventory.includes(work), false);
  assert.equal(first.files.some(path => !path.startsWith("vendor/") && /(?:README\.md|_metadata|^local\/|\.d\.ts$)/.test(path)), false);
});

test("development and production assemble capability UI resources without emitting duplicate fragments", async t => {
  const { sourceDir, work } = await fixture(t);
  const shell = '<head><link id="qingzhou-sidepanel-skin" rel="stylesheet" href="sidepanel.css"></head><body><!-- capability-ui --><script type="module" src="sidepanel.js"></script></body>';
  const fragment = '<section id="parallel-page">Parallel capability</section>';
  await put(sourceDir, "sidepanel/sidepanel.html", shell);
  await put(sourceDir, "sidepanel/sidepanel.css", ".core { color: red; }");
  await put(sourceDir, "capabilities/parallel/index.ts", "export { default as ui } from './ui.js';\n");
  await put(sourceDir, "capabilities/parallel/ui.ts", "export default {};\n");
  await put(sourceDir, "capabilities/parallel/ui.html", fragment);
  await put(sourceDir, "capabilities/parallel/ui.css", '.parallel { background-image: url("./badge.svg"); }');
  await put(sourceDir, "capabilities/parallel/badge.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const before = await treeDigest(sourceDir);
  for (const mode of ["development", "production"]) {
    const result = await buildExtension({ sourceDir, outputDir: join(work, mode), mode });
    assert.equal(await readFile(join(result.outputDir, "sidepanel/sidepanel.html"), "utf8"), shell.replace("<!-- capability-ui -->", fragment));
    const css = await readFile(join(result.outputDir, "sidepanel/sidepanel.css"), "utf8");
    assert.match(css, /\.core\s*\{\s*color: red;\s*\}/);
    assert.match(css, /\.parallel\s*\{\s*background-image: url\(["']?\.\.\/capabilities\/parallel\/badge\.svg["']?\);\s*\}/);
    assert.equal(result.files.filter(path => /capabilities\/.*\/ui\.(?:css|html)$/.test(path)).length, 0);
    assert.equal(await readFile(join(result.outputDir, "capabilities/parallel/badge.svg"), "utf8"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
  assert.equal(await treeDigest(sourceDir), before, "build never rewrites source UI assets");
});

test("language assets stay outside bundles and rebuilds remove unloaded packages without stale catalogs", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(sourceDir, "_locales/en/messages.json", '{"extensionName":{"message":"Qingzhou"}}');
  await put(sourceDir, "shared/definition.ts", "export const defineMessages = (namespace: string, messages: object) => ({ namespace, messages });");
  await put(sourceDir, "shared/copy.ts", 'import { defineMessages } from "./definition.js"; export default defineMessages("core", {save: {en:"Save {name}", "zh-CN":"保存 {name}"}});');
  await put(sourceDir, "capabilities/languages/index.ts", 'export { default as locales } from "./locales.js";');
  await put(sourceDir, "capabilities/languages/locales.ts", 'export default [{language:"en",chromeLocale:"en",name:"English"},{language:"ja",chromeLocale:"ja",name:"日本語",catalog:"./ja"}];');
  await put(sourceDir, "capabilities/languages/ja/core.json", '{"core.save":"{name} を保存する"}');
  await put(sourceDir, "background/service-worker.ts", 'import languages from "#capabilities/locales"; export {default as fallback} from "../shared/copy.js"; export const registered = languages.flat().map(item => item.language);');
  await put(sourceDir, "content/content-script.ts", 'import languages from "#capabilities/locales"; globalThis.knownLanguages = languages.flat().map(item => item.language);');
  const before = await treeDigest(sourceDir);
  for (const mode of ["development", "production"]) {
    const result = await buildExtension({ sourceDir, outputDir: mode === "development" ? outputDir : join(work, mode), mode });
    const nativeMessages = await readFile(join(result.outputDir, "_locales/ja/messages.json"), "utf8");
    assert.match(nativeMessages, /\{name\} を保存する/);
    assert.equal(JSON.parse(nativeMessages).qz_language.message, "ja");
    assert.ok(!result.files.includes("capabilities/languages/ja/core.json"));
    const contentState = {};
    runInNewContext(await readFile(join(result.outputDir, "content/content-script.js"), "utf8"), contentState);
    assert.equal(JSON.stringify(contentState.knownLanguages), '["en","ja"]', "classic scripts inline descriptor imports without runtime require calls");
    for (const file of result.files.filter(path => path.endsWith(".js"))) {
      assert.ok(!(await readFile(join(result.outputDir, file), "utf8")).includes("を保存する"), `${file} does not embed the language catalog`);
    }
  }
  const embeddedState = {};
  runInNewContext(await compileEmbeddedScript({ sourceDir, entry: "content/content-script.ts", mode: "production" }), embeddedState);
  assert.equal(JSON.stringify(embeddedState.knownLanguages), '["en","ja"]', "independently compiled embedded scripts use the same self-contained catalog resolution");
  assert.equal(await treeDigest(sourceDir), before);
  await rm(join(sourceDir, "capabilities/languages"), { recursive: true });
  const rebuilt = await buildExtension({ sourceDir, outputDir });
  assert.ok(!rebuilt.files.includes("_locales/ja/messages.json"));
  await assert.rejects(access(join(outputDir, "_locales/ja/messages.json")));
  assert.equal(JSON.parse(await readFile(join(outputDir, "_locales/en/messages.json"), "utf8")).extensionName.message, "Qingzhou");
  assert.match(await readFile(join(outputDir, "shared/copy.js"), "utf8"), /Save \{name\}/);
});

test("TS emits .js imports, maps and standalone classic scripts; production retains offscreen dependencies", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(sourceDir, "shared/type-only.ts", "export interface Only { value: number }\n");
  await put(sourceDir, "examples/unused.ts", "export const unused = 1;\n");
  await put(sourceDir, "examples/registered.ts", "export const registered = 2;\n");
  await put(sourceDir, "offscreen.js", 'import { value } from "./shared/value.js"; import { registered } from "./examples/registered.js"; globalThis.offscreenValue = value + registered;\n');
  const development = await buildExtension({ sourceDir, outputDir });
  assert.equal(development.files.some(path => path.endsWith(".ts")), false);
  assert.ok(development.files.includes("shared/value.js.map"));
  assert.ok(development.files.includes("shared/type-only.js"));
  assert.ok(development.files.includes("examples/unused.js"));
  const esm = await readFile(join(outputDir, "background/service-worker.js"), "utf8");
  assert.match(esm, /from "\.\.\/shared\/value\.js"/);
  const map = JSON.parse(await readFile(join(outputDir, "shared/value.js.map"), "utf8"));
  assert.match(map.sourcesContent[0], /value: number = 42/);
  assert.equal(resolve(outputDir, "shared", map.sources[0]), join(sourceDir, "shared/value.ts"));
  const classic = await readFile(join(outputDir, "content/content-script.js"), "utf8");
  new Script(classic);
  const globals = {};
  runInNewContext(classic, globals);
  assert.equal(globals.answer, 42);
  assert.match(classic, /sourceMappingURL=content-script\.js\.map/);

  const production = await buildExtension({ sourceDir, outputDir: join(work, "production"), mode: "production" });
  assert.equal(production.bundling.outputFiles, 2);
  assert.equal(production.files.some(path => !path.startsWith("vendor/") && /\.(?:ts|map)$/.test(path)), false);
  assert.ok(production.files.includes("shared/value.js"), "offscreen still imports this module after background bundling");
  assert.ok(production.files.includes("examples/registered.js"), "an example explicitly registered into a runtime is a real dependency");
  assert.equal(production.files.includes("examples/unused.js"), false);
  assert.equal(production.files.includes("shared/type-only.js"), false);
  assert.match(await readFile(join(production.outputDir, "offscreen.js"), "utf8"), /shared\/value\.js/);
});


test("bare npm imports resolve in dev, classic contexts and the production runtime graph", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(sourceDir, "shared/pdf-loader.ts", 'export { getDocument } from "pdfjs-dist/build/pdf.mjs";');
  await put(sourceDir, "background/service-worker.ts", 'import { parse } from "partial-json"; import { load } from "js-yaml"; export const result = [parse(\'{"name":"open\'), load("count: 2")];');
  await put(sourceDir, "offscreen.js", 'import { parse } from "partial-json"; export const value = parse(\'{"ready":true}\');');
  await put(sourceDir, "content/content-script.ts", 'import { parse } from "partial-json"; globalThis.answer = parse(\'{"answer":42}\').answer;');
  await put(sourceDir, "sidepanel/sidepanel.js", 'import * as XLSX from "xlsx"; export const rows = XLSX.utils.sheet_to_json(XLSX.utils.aoa_to_sheet([["name"], ["A"]]));');
  const dev = await buildExtension({ sourceDir, outputDir });
  assert.ok(dev.files.some(path => path.startsWith("deps/chunks/")), "shared npm code is emitted once");
  const pdfLoader = await readFile(join(outputDir, "shared/pdf-loader.js"), "utf8");
  assert.match(pdfLoader, /from "\.\.\/vendor\/pdf\.mjs"/);
  assert.equal(pdfLoader.includes(work), false, "runtime imports cannot retain a temporary build directory");
  const generated = await import(pathToFileURL(join(outputDir, "background/service-worker.js")));
  assert.deepEqual(generated.result, [{ name: "open" }, { count: 2 }]);
  assert.deepEqual((await import(pathToFileURL(join(outputDir, "sidepanel/sidepanel.js")))).rows, [{ name: "A" }]);
  const classicGlobals = {};
  runInNewContext(await readFile(join(outputDir, "content/content-script.js"), "utf8"), classicGlobals);
  assert.equal(classicGlobals.answer, 42);
  const prod = await buildExtension({ sourceDir, outputDir: join(work, "production"), mode: "production", debugMaps: true });
  assert.deepEqual((await import(pathToFileURL(join(prod.outputDir, "background/service-worker.js")))).result, generated.result);
  assert.equal((await import(pathToFileURL(join(prod.outputDir, "offscreen.js")))).value.ready, true);
  assert.deepEqual((await import(pathToFileURL(join(prod.outputDir, "sidepanel/sidepanel.js")))).rows, [{ name: "A" }]);
  assert.ok(prod.files.some(path => path.startsWith("deps/")), "offscreen retains its independently loaded npm graph");
  const unbundled = await buildExtension({ sourceDir, outputDir: join(work, "standalone"), mode: "production", bundle: false });
  const standalone = await bundleExtension({ extensionDir: unbundled.outputDir });
  assert.ok(standalone.preservedFiles > 0);
  assert.equal((await import(pathToFileURL(join(unbundled.outputDir, "offscreen.js")))).value.ready, true, "standalone bundling must preserve offscreen's npm dependencies");
  await checkDependencyAssets({ extensionDir: unbundled.outputDir });
  const manifest = await checkDependencyAssets({ extensionDir: prod.outputDir });
  assert.ok(manifest.assets["background/service-worker.js"].components.includes("partial-json"));
  assert.ok(manifest.assets["content/content-script.js"].components.includes("partial-json"));
  assert.equal(manifest.components["partial-json"].version, "0.1.7");
  const moved = join(work, "nested/check-out");
  await cp(sourceDir, moved, { recursive: true });
  const rebuilt = await buildExtension({ sourceDir: moved, outputDir: join(work, "rebuilt"), mode: "production", debugMaps: true });
  assert.equal(await treeDigest(rebuilt.outputDir), await treeDigest(prod.outputDir), "npm debug artifacts remain deterministic across source locations");
});

test("debug source map URLs decode once before checking source boundaries", () => {
  const sourceRoot = join(tmpdir(), "checkout 开发 100%", "src");
  const mapDirectory = join(sourceRoot, "background");
  const source = "shared/文件 %2e%2e #.ts";
  const encoded = source.split("/").map(encodeURIComponent).join("/");
  const normalize = (path, sourceMapRoot = "") => JSON.parse(stableDebugSourceMap(
    JSON.stringify({ version: 3, sources: [path], sourceRoot: sourceMapRoot, mappings: "" }), sourceRoot, mapDirectory,
  ));
  assert.deepEqual(normalize(encoded, "..").sources, [`qingzhou://extension/${encoded}`]);
  assert.deepEqual(normalize("%E6%96%87%E4%BB%B6.ts", "../%E7%9B%AE%E5%BD%95").sources,
    ["qingzhou://extension/%E7%9B%AE%E5%BD%95/%E6%96%87%E4%BB%B6.ts"]);
  assert.deepEqual(normalize("npm:marked/src/defaults.ts").sources, ["qingzhou://npm/marked/src/defaults.ts"]);
  for (const path of ["../../outside.ts", "%2e%2e/%2e%2e/outside.ts", "npm:%2e%2e/outside.ts"]) {
    assert.throws(() => normalize(path), /debug source escaped extension root/);
  }
  assert.throws(() => normalize("bad%escape.ts"), URIError);
});

test("production debug maps chain TS through bundles and Terser with stable source locations", async t => {
  const { sourceDir, work } = await fixture(t);
  const original = 'export function fail(value: number): never {\n  throw new Error("debug-map-marker:" + value);\n}\n';
  await put(sourceDir, "shared/trace-helper.ts", original);
  await put(sourceDir, "shared/type-only.ts", "export interface Removed { value: number }\n");
  await put(sourceDir, "examples/unused.ts", "export const unused = true;\n");
  await put(sourceDir, "background/service-worker.ts", 'import { fail } from "../shared/trace-helper.js";\nexport function run() { fail(7); }\n');
  const first = await buildExtension({ sourceDir, outputDir: join(work, "first"), mode: "production", debugMaps: true });
  const relocated = join(work, "different-checkout 开发 100% #");
  await cp(sourceDir, relocated, { recursive: true });
  const second = await buildExtension({ sourceDir: relocated, outputDir: join(work, "second"), mode: "production", debugMaps: true });
  assert.equal(await treeDigest(first.outputDir), await treeDigest(second.outputDir), "debug artifacts must not depend on checkout or staging paths");
  assert.equal(first.debugMaps, true);
  assert.equal(first.bundling.debugMaps, true);
  for (const path of ["shared/trace-helper.js", "shared/type-only.js", "examples/unused.js"]) {
    assert.equal(first.files.includes(path), false, path);
    assert.equal(first.files.includes(`${path}.map`), false, `${path}.map`);
  }
  for (const path of first.files.filter(path => !path.startsWith('vendor/') && path.endsWith('.map'))) {
    assert.ok(first.files.includes(path.slice(0, -4)), `orphaned map ${path}`);
    const text = await readFile(join(first.outputDir, path), 'utf8');
    const map = JSON.parse(text);
    assert.ok(map.sources.every(source => source.startsWith('qingzhou://extension/')), path);
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert.equal(text.includes(work), false, path);
  }
  const entry = 'background/service-worker.js';
  const code = await readFile(join(first.outputDir, entry), 'utf8');
  const map = JSON.parse(await readFile(join(first.outputDir, `${entry}.map`), 'utf8'));
  assert.match(code, /sourceMappingURL=service-worker\.js\.map/);
  assert.equal(map.sourcesContent[map.sources.indexOf('qingzhou://extension/shared/trace-helper.ts')], original);
  assertOriginalMarker(code, map, 'debug-map-marker:', 'qingzhou://extension/shared/trace-helper.ts', 1);
  const minified = await minify({ [entry]: code }, { module: true, compress: { passes: 2 }, mangle: true,
    sourceMap: { content: map, filename: entry, url: 'service-worker.js.map', includeSources: true } });
  assertOriginalMarker(minified.code, JSON.parse(minified.map), 'debug-map-marker:', 'qingzhou://extension/shared/trace-helper.ts', 1);
  const minifiedDir = join(work, 'minified');
  await put(minifiedDir, 'package.json', '{"type":"module"}');
  await put(minifiedDir, entry, minified.code);
  await put(minifiedDir, `${entry}.map`, minified.map);
  const { run } = await import(pathToFileURL(join(minifiedDir, entry)));
  assert.throws(run, /debug-map-marker:7/);
  const classicCode = await readFile(join(first.outputDir, 'content/content-script.js'), 'utf8');
  const classicMap = JSON.parse(await readFile(join(first.outputDir, 'content/content-script.js.map'), 'utf8'));
  assertOriginalMarker(classicCode, classicMap, 'globalThis.answer', 'qingzhou://extension/content/content-script.ts', 1);
  assert.ok(first.files.includes('shared/value.js.map'), 'offscreen dependencies retain their adjacent source maps');
  const ordinary = await buildExtension({ sourceDir, outputDir: first.outputDir, mode: 'production' });
  assert.equal(ordinary.files.some(path => !path.startsWith('vendor/') && (path.endsWith('.map') || path.startsWith('.qingzhou-debug/'))), false);
});

test("Side Panel chunks defer evaluation and retain maps, vendor paths and dependency provenance", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(sourceDir, "sidepanel/sidepanel.js", 'export const load = () => import("./heavy.js"); export const pdf = () => import("./pdf.js");');
  await put(sourceDir, "sidepanel/heavy.ts", 'import { parse } from "partial-json";\nglobalThis.__lazyChunkExecutions = (globalThis.__lazyChunkExecutions || 0) + 1;\nexport function run(): unknown { return parse(\'{"marker":"lazy-chunk-marker"}\'); }\n');
  await put(sourceDir, "sidepanel/pdf.ts", 'export { version } from "pdfjs-dist/build/pdf.mjs";');
  const first = await buildExtension({ sourceDir, outputDir, mode: "production", debugMaps: true });
  assert.deepEqual(first.bundling.entries.map(entry => entry.output), ["background/service-worker.js", "sidepanel/sidepanel.js"]);
  assert.ok(first.bundling.chunks.length >= 2);
  assert.equal(first.bundling.outputFiles, 2 + first.bundling.chunks.length);
  const entry = await readFile(join(outputDir, "sidepanel/sidepanel.js"), "utf8");
  assert.doesNotMatch(entry, /lazy-chunk-marker|__lazyChunkExecutions|partial-json/u);
  assert.match(entry, /import\("\.\/chunk-/u);
  const chunk = first.bundling.chunks.find(item => item.inputs.includes("sidepanel/heavy.js"));
  assert.ok(chunk, "the deferred implementation has its own emitted output");
  const source = await readFile(join(outputDir, chunk.output), "utf8");
  const map = JSON.parse(await readFile(join(outputDir, `${chunk.output}.map`), "utf8"));
  assertOriginalMarker(source, map, "lazy-chunk-marker", "qingzhou://extension/sidepanel/heavy.ts", 2);
  const compressed = await minify(source, { module: true, compress: { passes: 2 }, mangle: true,
    sourceMap: { content: map, includeSources: true } });
  assertOriginalMarker(compressed.code, JSON.parse(compressed.map), "lazy-chunk-marker", "qingzhou://extension/sidepanel/heavy.ts", 2);
  const vendorChunk = first.bundling.chunks.find(item => item.inputs.includes("sidepanel/pdf.js"));
  assert.match(await readFile(join(outputDir, vendorChunk.output), "utf8"), /from "\.\.\/vendor\/pdf\.mjs"/u);
  const provenance = await checkDependencyAssets({ extensionDir: outputDir });
  assert.ok(provenance.assets[chunk.output].components.includes("partial-json"));
  assert.ok(provenance.assets[`${chunk.output}.map`].components.includes("partial-json"));
  delete globalThis.__lazyChunkExecutions;
  t.after(() => { delete globalThis.__lazyChunkExecutions; });
  const panel = await import(pathToFileURL(join(outputDir, "sidepanel/sidepanel.js")));
  assert.equal(globalThis.__lazyChunkExecutions, undefined, "entry loading must not evaluate deferred code");
  const [left, right] = await Promise.all([panel.load(), panel.load()]);
  assert.equal(left, right);
  assert.equal(globalThis.__lazyChunkExecutions, 1);
  assert.deepEqual(left.run(), { marker: "lazy-chunk-marker" });

  const relocated = join(work, "relocated-source");
  await cp(sourceDir, relocated, { recursive: true });
  const repeated = await buildExtension({ sourceDir: relocated, outputDir: join(work, "repeated"), mode: "production", debugMaps: true });
  assert.equal(await treeDigest(repeated.outputDir), await treeDigest(outputDir), "chunk names, bytes and maps are independent of source location");
  const rebundled = await bundleExtension({ extensionDir: outputDir, debugMaps: true });
  const rebundledProvenance = await checkDependencyAssets({ extensionDir: outputDir });
  assert.ok(rebundled.chunks.some(item => rebundledProvenance.assets[item.output]?.components.includes("partial-json")));
  const currentChunks = new Set(rebundled.chunks.flatMap(item => [item.output, `${item.output}.map`]));
  for (const name of await readdir(join(outputDir, "sidepanel"))) {
    if (name.startsWith("chunk-")) assert.ok(currentChunks.has(`sidepanel/${name}`), "standalone rebundling removes obsolete chunk hashes and maps");
  }
  await put(sourceDir, "sidepanel/sidepanel.js", "export const ready = true;");
  await rm(join(sourceDir, "sidepanel/heavy.ts"));
  await rm(join(sourceDir, "sidepanel/pdf.ts"));
  const removed = await buildExtension({ sourceDir, outputDir, mode: "production" });
  assert.deepEqual(removed.bundling.chunks, []);
  assert.equal(removed.files.some(file => file.startsWith("sidepanel/chunk-")), false, "rebuilding removes old chunks and maps");
});

test("production debug maps are available through the CLI without requiring bundles", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [join(ROOT, 'scripts/build-extension.mjs'),
    '--source-dir', sourceDir, '--output-dir', outputDir, '--mode', 'production', '--no-bundle', '--debug-maps', '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.debugMaps, true);
  assert.equal(result.bundling.enabled, false);
  assert.ok(result.files.includes('background/service-worker.js.map'));
  assert.ok(result.files.includes('shared/value.js.map'));
});

function assertOriginalMarker(code, map, marker, source, line) {
  const offset = code.indexOf(marker);
  assert.notEqual(offset, -1, `missing generated marker ${marker}`);
  const lines = code.slice(0, offset).split('\n');
  const entry = new SourceMap(map).findEntry(lines.length - 1, lines.at(-1).length);
  assert.equal(entry.originalSource, source);
  assert.equal(entry.originalLine, line);
}

test("public composition resolves ESM and classic entries and rejects invalid profiles without replacing output", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(sourceDir, "products/manifest.json", JSON.stringify({ version: 1, defaultProduct: "public", rules: [
    { path: "rules/fixture.json", entry: "rules/fixture.json" },
  ], ports: [
    { facade: "shared/product/value.ts", entry: "shared/value.ts" },
  ] }));
  await put(sourceDir, "shared/product/value.ts", 'export * from "../../products/public/shared/value.js";');
  await put(sourceDir, "products/public/shared/value.ts", 'export const value: string = "public contribution";');
  await put(sourceDir, "products/other/shared/value.ts", 'export const value: string = "unselected contribution";');
  await put(sourceDir, "rules/fixture.json", JSON.stringify([{ id: 2, source: "shared" }]));
  await put(sourceDir, "products/public/rules/fixture.json", JSON.stringify([{ id: 1, source: "public" }]));
  await put(sourceDir, "shared/value.ts", 'export { value } from "./product/value.js";');
  const publicBuild = await buildExtension({ sourceDir, outputDir, mode: "production", bundle: false });
  assert.equal(publicBuild.product, "public");
  assert.equal(publicBuild.files.some(path => path.startsWith("products/other/")), false);
  const publicGlobals = {};
  runInNewContext(await readFile(join(outputDir, "content/content-script.js"), "utf8"), publicGlobals);
  assert.equal(publicGlobals.answer, "public contribution");
  assert.deepEqual(JSON.parse(await readFile(join(outputDir, "rules/fixture.json"))), [{ id: 1, source: "public" }, { id: 2, source: "shared" }]);
  assert.equal(publicBuild.files.includes("products/public/rules/fixture.json"), false);
  assert.match(await readFile(join(outputDir, "shared/product/value.js"), "utf8"), /products\/public/);
  assert.equal(publicBuild.files.includes("products/manifest.json"), false);
  await assert.rejects(access(join(outputDir, "products/manifest.json")), { code: "ENOENT" });
  const before = await treeDigest(outputDir);
  await put(sourceDir, "content/content-script.ts", 'import { value } from "../products/other/shared/value.js"; globalThis.answer = value;');
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /inactive product import/);
  assert.equal(await treeDigest(outputDir), before);
  await put(sourceDir, "products/public/rules/fixture.json", JSON.stringify([{ id: 2, source: "duplicate" }]));
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /unique positive integers/);
  assert.equal(await treeDigest(outputDir), before);
  await assert.rejects(buildExtension({ sourceDir, outputDir: join(work, "other"), product: "unknown" }), /invalid product/);
});

test("JavaScript classic entries can import composition modules and still load without module syntax", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await rm(join(sourceDir, "content/content-script.ts"));
  await put(sourceDir, "content/content-script.js", 'import { value } from "../shared/value.js"; globalThis.answer = value;');
  const result = await buildExtension({ sourceDir, outputDir });
  const globals = {};
  runInNewContext(await readFile(join(outputDir, "content/content-script.js"), "utf8"), globals);
  assert.equal(globals.answer, 42);
  assert.ok(result.files.includes("content/content-script.js.map"));
});

test("public provider composition keeps standard providers and their browser rules", async t => {
  const work = await workspace(t);
  const build = await buildExtension({ product: "public", outputDir: join(work, "public") });
  const catalog = await import(pathToFileURL(join(build.outputDir, "background/llm/provider-catalog.js")));
  const contribution = await import(pathToFileURL(join(build.outputDir, "background/product/providers.js")));
  const { withLanguage } = await import(pathToFileURL(join(build.outputDir, "shared/i18n/index.js")));
  for (const [language, provider] of [["zh-CN", "deepseek"], ["zh-TW", "deepseek"], ["en", "openrouter"], ["ja", "openrouter"]]) {
    assert.equal(withLanguage(language, () => catalog.normalizeProvider()), provider);
  }
  assert.deepEqual(Object.keys(contribution.PRODUCT_PROVIDERS), []);
  assert.deepEqual(await contribution.getProductProviderAuthStatus(), {});
  const ids = catalog.listProviderSummaries().map(provider => provider.id);
  for (const id of ["custom", "deepseek", "openaicodex", "bailian"]) assert.ok(ids.includes(id));
  const rules = JSON.parse(await readFile(join(build.outputDir, "rules/provider-headers.json")));
  assert.equal(rules.some(rule => rule.id === 1), false);
  assert.equal(rules.some(rule => rule.id === 4), true);
  const manifest = JSON.parse(await readFile(join(build.outputDir, "manifest.json")));
  assert.equal(manifest.declarative_net_request, undefined, "provider rules must be scoped to the installed extension at runtime");
});

test("models.dev uses one licensed local asset and keeps the SDK in Background", async t => {
  const work = await workspace(t);
  const build = await buildExtension({ outputDir: join(work, "catalog"), mode: "production" });
  const provenance = await checkDependencyAssets({ extensionDir: build.outputDir });
  assert.ok(provenance.components["@opencode-ai/models"]);
  assert.ok(provenance.assets["vendor/models-dev/providers.json"].components.includes("@opencode-ai/models"));
  assert.ok(provenance.assets["background/service-worker.js"].components.includes("@opencode-ai/models"));
  for (const [path, asset] of Object.entries(provenance.assets)) {
    if (path.startsWith("sidepanel/")) assert.ok(!asset.components.includes("@opencode-ai/models"), `${path} must not parse a duplicate catalog`);
  }
  assert.equal(build.files.filter(path => path.startsWith("deps/") && /opencode/u.test(path)).length, 0, "bundled SDK leaves no duplicate dependency files");
});

test("syntax and missing-import failures preserve the previous build, then recovery prunes stale output", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await put(sourceDir, "unused.js", "globalThis.unused = true;\n");
  await buildExtension({ sourceDir, outputDir });
  const before = await treeDigest(outputDir);
  await put(sourceDir, "shared/value.ts", "export const value: number = ;");
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /Unexpected/);
  assert.equal(await treeDigest(outputDir), before);
  await rm(join(sourceDir, "shared/value.ts"));
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /Could not resolve/);
  assert.equal(await treeDigest(outputDir), before);
  await put(sourceDir, "shared/value.ts", "export const value: number = 43;\n");
  await rm(join(sourceDir, "unused.js"));
  await buildExtension({ sourceDir, outputDir });
  await assert.rejects(readFile(join(outputDir, "unused.js")), { code: "ENOENT" });
  assert.notEqual(await treeDigest(outputDir), before);
  assert.equal((await readdir(dirname(outputDir))).some(path => path.startsWith(".output-build-")), false);
});

test("build rejects source/output overlap, source symlinks, collisions and unowned output", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await assert.rejects(buildExtension({ sourceDir, outputDir: sourceDir }), /must not overlap/);
  await assert.rejects(buildExtension({ sourceDir, outputDir: work }), /must not overlap/);
  await symlink(sourceDir, join(work, "source-link"), "dir");
  await assert.rejects(buildExtension({ sourceDir, outputDir: join(work, "source-link/nested") }), /must not overlap/);
  await mkdir(outputDir);
  await put(outputDir, "keep.txt", "unrelated user file");
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /not owned by this build/);
  assert.equal(await readFile(join(outputDir, "keep.txt"), "utf8"), "unrelated user file");
  await rm(outputDir, { recursive: true });
  await put(sourceDir, "shared/value.js", "export const value = 1;");
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /duplicate output shared\/value.js/);
  await rm(join(sourceDir, "shared/value.js"));
  await symlink(join(sourceDir, "shared/value.ts"), join(sourceDir, "linked.ts"));
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /must not be symlinks/);
});

test("build rejects undeclared runtime entries and missing resources before replacing output", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await buildExtension({ sourceDir, outputDir });
  const before = await treeDigest(outputDir);
  await put(sourceDir, "sidepanel/sidepanel.html", '<script type="module" src="sidepanel.js"></script><script src="surprise.js"></script>');
  await put(sourceDir, "sidepanel/surprise.js", "globalThis.surprise = true;");
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /declare the iife entry/);
  assert.equal(await treeDigest(outputDir), before);
  await put(sourceDir, "sidepanel/sidepanel.html", '<script type="module" src="sidepanel.js"></script><link rel="stylesheet" href="missing.css">');
  await assert.rejects(buildExtension({ sourceDir, outputDir }), { code: "ENOENT" });
  assert.equal(await treeDigest(outputDir), before);
});

test("embedded runtime and Worker execute after production host minification", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await rm(join(sourceDir, "runner-sandbox.js"));
  for (const path of ["runner-sandbox.ts", "workers/inner-runner.ts", "shared/script-runtime.ts"]) await put(sourceDir, path, await readFile(join(ROOT, "src", path), "utf8"));
  await put(sourceDir, "capabilities/script/index.ts", "export { default as tools } from './tools.js';\n");
  await put(sourceDir, "capabilities/script/tools.ts", `declare const SCRIPT_RUNTIME_SOURCE: string;
export default () => {};\nexport function expression() { return SCRIPT_RUNTIME_SOURCE + ';QZ_SCRIPT_RUNTIME.safeValueForMessage(new Uint8Array([4, 5]), "page");'; }`);
  const result = await buildExtension({ sourceDir, outputDir, mode: "production" });
  assert.deepEqual(result.embeddedScripts, [
    { entry: "shared/script-runtime.ts", host: "capabilities/script/tools.js" },
    { entry: "workers/inner-runner.ts", host: "runner-sandbox.js" },
  ]);
  assert.equal(result.files.some(path => !path.startsWith("vendor/") && /inner-runner|shared\/script-runtime|\.(?:ts|map)$/.test(path)), false);
  const pageHost = await minify(await readFile(join(outputDir, "capabilities/script/tools.js"), "utf8"), { module: true, compress: { passes: 2 }, mangle: true });
  const { expression } = await import(`data:text/javascript;base64,${Buffer.from(pageHost.code).toString("base64")}`);
  const value = runInNewContext(expression());
  assert.equal(value.__qz_type, "Uint8Array");
  assert.deepEqual(Array.from(value.sample), [4, 5]);
  const host = await minify(await readFile(join(outputDir, "runner-sandbox.js"), "utf8"), { ecma: 2020, compress: { passes: 2 }, mangle: true, format: { comments: false } });
  const sandbox = sandboxFixture(host.code);
  sandbox.send({ type: "execute", requestId: "compiled", scriptSource: 'return "轻舟 ✅";' });
  const worker = sandbox.workers[0];
  assert.doesNotMatch(worker.source, /sourceMappingURL|interface WorkerExecute/);
  assert.equal((await runInnerWorker(worker.source, worker.sent[0].source)).result.result, "轻舟 ✅");
  const before = await treeDigest(outputDir);
  await put(sourceDir, "workers/inner-runner.ts", "const broken: = ;");
  await assert.rejects(buildExtension({ sourceDir, outputDir, mode: "production" }), /Unexpected/);
  assert.equal(await treeDigest(outputDir), before);
});

test("embedded debug sidecars retain exact executable fragments without leaking maps into runtime strings", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await rm(join(sourceDir, "runner-sandbox.js"));
  for (const path of ["runner-sandbox.ts", "workers/inner-runner.ts", "shared/script-runtime.ts"]) {
    await put(sourceDir, path, await readFile(join(ROOT, "src", path), "utf8"));
  }
  await put(sourceDir, "content/page-scripts/element.ts", 'export function selector(element: {id: string}) { return "#" + element.id; }');
  await put(sourceDir, "background/tools/page-scripts.ts", 'declare const ELEMENT_PAGE_SCRIPT_SOURCE: string; export const fragment = ELEMENT_PAGE_SCRIPT_SOURCE;');
  await put(sourceDir, "capabilities/script/index.ts", "export { default as tools } from './tools.js';\n");
  await put(sourceDir, "capabilities/script/tools.ts", 'declare const SCRIPT_RUNTIME_SOURCE: string; export default () => {}; export const fragment = SCRIPT_RUNTIME_SOURCE;');
  const result = await buildExtension({ sourceDir, outputDir, mode: "production", debugMaps: true });
  assert.equal(result.embeddedDebugScripts.length, 3);
  const sandbox = sandboxFixture(await readFile(join(outputDir, 'runner-sandbox.js'), 'utf8'));
  sandbox.send({ type: 'execute', requestId: 'debug-worker', scriptSource: 'return 42;' });
  for (const item of result.embeddedDebugScripts) {
    assert.ok(item.artifact.startsWith('.qingzhou-debug/embedded/'));
    assert.equal(item.map, `${item.artifact}.map`);
    const fragment = await readFile(join(outputDir, item.artifact), 'utf8');
    const map = JSON.parse(await readFile(join(outputDir, item.map), 'utf8'));
    assert.doesNotMatch(fragment, /sourceMappingURL/, 'runtime strings must not contain debug source maps');
    assert.ok(map.sources.includes(`qingzhou://extension/${item.entry}`));
    assert.ok(map.sourcesContent.every(source => typeof source === 'string'));
    if (item.symbol === 'INNER_WORKER_SOURCE') {
      assert.equal(fragment, sandbox.workers[0].source);
      assert.equal((await runInnerWorker(fragment, 'return 42;')).result.result, 42);
    } else {
      const host = await minify(await readFile(join(outputDir, item.host), 'utf8'), { module: true, compress: true, mangle: true });
      const exported = await import(`data:text/javascript;base64,${Buffer.from(host.code).toString('base64')}`);
      assert.equal(fragment, exported.fragment, 'debug fragment must remain byte-identical after the host is minified');
    }
    if (item.symbol === 'ELEMENT_PAGE_SCRIPT_SOURCE') {
      assertOriginalMarker(fragment, map, '"#"', 'qingzhou://extension/content/page-scripts/element.ts', 0);
    }
  }
  const ordinary = await buildExtension({ sourceDir, outputDir, mode: 'production' });
  assert.equal(ordinary.embeddedDebugScripts.length, 0);
  assert.equal(ordinary.files.some(path => path.startsWith('.qingzhou-debug/')), false);
});

test("embedded page functions retain their named exports after production minification", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await put(sourceDir, "content/page-scripts/element.ts", 'export function selector(element: {id: string}) { return "#" + element.id; }');
  await put(sourceDir, "background/tools/page-scripts.ts", `declare const ELEMENT_PAGE_SCRIPT_SOURCE: string;
export function declaration() { return 'function(){' + ELEMENT_PAGE_SCRIPT_SOURCE + ';return QZ_ELEMENT_PAGE_SCRIPTS.selector(this);}' }`);
  const result = await buildExtension({ sourceDir, outputDir, mode: "production" });
  assert.equal(result.files.includes("content/page-scripts/element.js"), false);
  const host = await minify(await readFile(join(outputDir, "background/tools/page-scripts.js"), "utf8"), {module: true, compress: {passes: 2}, mangle: true});
  const { declaration } = await import(`data:text/javascript;base64,${Buffer.from(host.code).toString("base64")}`);
  const pageFunction = runInNewContext(`(${declaration()})`);
  assert.equal(pageFunction.call({id: "actual-element"}), "#actual-element");
});

test("watch reports a failed rebuild, retains usable output and recovers without forcing a reload", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const results = [];
  const errors = [];
  const watcher = await watchExtension({ sourceDir, outputDir }, {
    debounceMs: 10,
    onBuild: async () => results.push(await readFile(join(outputDir, "shared/value.js"), "utf8")),
    onError: error => errors.push(error),
  });
  try {
    assert.ok(results.length >= 1);
    const before = await treeDigest(outputDir);
    await assert.rejects(buildExtension({ sourceDir, outputDir, mode: "production" }), /Build output is locked/);
    await put(sourceDir, "shared/value.ts", "export const value = ;");
    await until(() => errors.length > 0);
    assert.equal(await treeDigest(outputDir), before);
    await put(sourceDir, "shared/value.ts", "export const value: number = 77;");
    await until(() => results.some(source => source.includes("77")));
    assert.notEqual(await treeDigest(outputDir), before);
  } finally {
    // Stop all writers before workspace(t)'s cleanup, including failed assertions.
    await watcher.close();
  }
});

test("watch preserves the last valid skin after an invalid utility and cleans old CSS on recovery", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await cp(join(ROOT, "src/themes/default"), join(sourceDir, "themes/default"), { recursive: true });
  await put(sourceDir, "sidepanel/sidepanel.css", '@import "../themes/default/index.css";');
  await put(sourceDir, "capabilities/cards/index.ts", 'export { default as renderers } from "./render.js";');
  await put(sourceDir, "capabilities/cards/render.ts", 'export default () => "qz:w-[181px]";');
  await put(sourceDir, "capabilities/cards/ui.css", ".watch-card { @apply qz:text-secondary; }");
  const skins = [];
  const errors = [];
  const watcher = await watchExtension({ sourceDir, outputDir }, {
    debounceMs: 10,
    onBuild: async () => skins.push(await readFile(join(outputDir, "sidepanel/sidepanel.css"), "utf8")),
    onError: error => errors.push(error),
  });
  try {
    assert.match(skins.at(-1), /width:\s*181px;/u);
    assert.match(skins.at(-1), /\.watch-card\s*\{\s*color:\s*var\(--text-secondary\);/u);
    const before = await treeDigest(outputDir);
    await put(sourceDir, "capabilities/cards/ui.css", ".watch-card { @apply qz:not-a-real-utility; }");
    await until(() => errors.length > 0);
    assert.match(errors[0].message, /(?:unknown utility|not-a-real-utility)/iu);
    assert.equal(await treeDigest(outputDir), before, "a CSS error cannot replace the usable extension with partial output");
    await put(sourceDir, "capabilities/cards/render.ts", 'export default () => "qz:w-[193px]";');
    await put(sourceDir, "capabilities/cards/ui.css", ".watch-card { @apply qz:p-5; }");
    await until(() => /width:\s*193px;/u.test(skins.at(-1)) && /\.watch-card\s*\{\s*padding:/u.test(skins.at(-1)));
    assert.doesNotMatch(skins.at(-1), /181px/u, "removed utility candidates cannot survive a successful rebuild");
    assert.doesNotMatch(skins.at(-1), /\.watch-card\s*\{[^}]*color:/u, "the repaired CSS replaces the previous declarations");
    assert.notEqual(await treeDigest(outputDir), before);
  } finally {
    await watcher.close();
  }
});

test("one declaration keeps DOM code out of the emitted Background module graph", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(work, "package.json", '{"type":"module"}');
  await put(sourceDir, "capabilities/parallel/index.ts", "export { default as tools } from './commands/execute.js'; export { default as ui } from './panels/view.js';");
  await put(sourceDir, "capabilities/parallel/commands/execute.ts", 'export default () => "background-ready";');
  await put(sourceDir, "capabilities/parallel/panels/view.ts", 'document.createElement("section"); throw new Error("UI must never execute in Background"); export default () => {};');
  const built = await buildExtension({ sourceDir, outputDir });
  assert.equal(built.files.includes("capabilities/parallel/index.js"), false, "the declaration is not executable output");
  const code = `import entries from ${JSON.stringify(pathToFileURL(join(outputDir, "capability-catalogs/tools.js")).href)}; process.stdout.write(entries[0].id + ":" + entries[0].setup());`;
  assert.equal((await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])).stdout, "parallel:background-ready");
  const catalog = await readFile(join(outputDir, "capability-catalogs/tools.js"), "utf8");
  assert.match(catalog, /commands\/execute\.js/);
  assert.doesNotMatch(catalog, /index\.js|panels|import\s*\(/);
});

test("watch discovers added and removed capability files without touching the host", async t => {
  const { sourceDir, outputDir, work } = await fixture(t);
  await put(work, "package.json", '{"type":"module"}\n');
  const host = 'import tools from "#capabilities/tools"; export const count = tools.length;\n';
  await put(sourceDir, "background/service-worker.ts", host);
  const catalogs = [];
  const errors = [];
  const watcher = await watchExtension({ sourceDir, outputDir }, {
    debounceMs: 10,
    onBuild: async () => catalogs.push(await readFile(join(outputDir, "capability-catalogs/tools.js"), "utf8")),
    onError: error => errors.push(error),
  });
  try {
    await put(work, "added/tools.ts", "export default () => {};\n");
    await put(work, "added/index.ts", "export { default as tools } from './tools.js';\n");
    await mkdir(join(sourceDir, "capabilities"), { recursive: true });
    renameSync(join(work, "added"), join(sourceDir, "capabilities/parallel"));
    await until(() => catalogs.some(source => source.includes("parallel/tools.js")));
    assert.equal(await contributionCount(), "1");
    await put(work, "changed/replacement.ts", "export default () => {};\n");
    await put(work, "changed/index.ts", "export { default as tools } from './replacement.js';\n");
    // Publish a complete package; a half-written declaration is intentionally invalid.
    renameSync(join(sourceDir, "capabilities/parallel"), join(work, "previous"));
    renameSync(join(work, "changed"), join(sourceDir, "capabilities/parallel"));
    await until(() => catalogs.at(-1).includes("parallel/replacement.js"));
    assert.equal(await contributionCount(), "1");
    await assert.rejects(access(join(outputDir, "capabilities/parallel/tools.js")), { code: "ENOENT" });
    await put(sourceDir, "capabilities/parallel/replacement.ts", 'export default () => "edited replacement";\n');
    await until(async () => /edited replacement/.test(await readFile(join(outputDir, "capabilities/parallel/replacement.js"), "utf8")));
    const buildsBeforeRemoval = catalogs.length;
    renameSync(join(sourceDir, "capabilities/parallel"), join(work, "removed"));
    await until(() => catalogs.length > buildsBeforeRemoval && !catalogs.at(-1).includes("parallel/"));
    assert.equal(await contributionCount(), "0");
    await assert.rejects(access(join(outputDir, "capabilities/parallel/replacement.js")), { code: "ENOENT" });
    assert.equal(await readFile(join(sourceDir, "background/service-worker.ts"), "utf8"), host);
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
  }
  async function contributionCount() {
    // Each reload owns a new module graph, as an extension reload does.
    const code = `import entries from ${JSON.stringify(pathToFileURL(join(outputDir, "capability-catalogs/tools.js")).href)}; process.stdout.write(String(entries.length));`;
    return (await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code])).stdout;
  }
});

test("one output has one writer; failed or aborted builds release their ownership", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const concurrent = await Promise.allSettled([
    buildExtension({ sourceDir, outputDir }), buildExtension({ sourceDir, outputDir, mode: "production" }),
  ]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  assert.match(concurrent.find(result => result.status === "rejected").reason.message, /Build output is locked/);
  const before = await treeDigest(outputDir);
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(buildExtension({ sourceDir, outputDir, signal: controller.signal }), /fixture cancellation/);
  assert.equal(await treeDigest(outputDir), before);
  await put(sourceDir, "shared/value.ts", "export const value = ;");
  await assert.rejects(buildExtension({ sourceDir, outputDir }));
  assert.equal(await treeDigest(outputDir), before);
  await put(sourceDir, "shared/value.ts", "export const value: number = 81;");
  await buildExtension({ sourceDir, outputDir });
  assert.match(await readFile(join(outputDir, "shared/value.js"), "utf8"), /81/);
});

test("a real watch process retains ownership between builds and releases it on SIGTERM", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const child = spawn(process.execPath, [join(ROOT, "scripts/build-extension.mjs"), "--watch", "--source-dir", sourceDir, "--output-dir", outputDir], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit").catch(error => [null, error]);
  try {
    await waitForWatchStartup(child);
    const before = await treeDigest(outputDir);
    const duplicate = await promisify(execFile)(process.execPath, [join(ROOT, "scripts/build-extension.mjs"), "--watch", "--source-dir", sourceDir, "--output-dir", outputDir]);
    assert.match(duplicate.stdout, new RegExp(`Dev watcher already running \\(PID ${child.pid}\\)`));
    assert.equal(duplicate.stderr, "");
    const duplicateJson = await promisify(execFile)(process.execPath, [join(ROOT, "scripts/build-extension.mjs"), "--watch", "--json", "--source-dir", sourceDir, "--output-dir", outputDir]);
    assert.deepEqual(JSON.parse(duplicateJson.stdout), { alreadyRunning: true, pid: child.pid, outputDir: await realpath(outputDir) });
    await assert.rejects(promisify(execFile)(process.execPath, [join(ROOT, "scripts/build-extension.mjs"), "--watch", "--source-dir", sourceDir, "--output-dir", outputDir, "--mode", "production"]), error => {
      assert.match(error.stderr, new RegExp(`locked by PID ${child.pid}`));
      return true;
    });
    await assert.rejects(promisify(execFile)(process.execPath, [join(ROOT, "scripts/build-extension.mjs"), "--source-dir", sourceDir, "--output-dir", outputDir, "--mode", "production"]), error => {
      assert.match(error.stderr, new RegExp(`locked by PID ${child.pid}`));
      return true;
    });
    assert.equal(await treeDigest(outputDir), before);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    await buildExtension({ sourceDir, outputDir, mode: "production" });
    const manifest = JSON.parse(await readFile(join(outputDir, ".qingzhou-build.json"), "utf8"));
    assert.equal(manifest.mode, "production");
    assert.equal(manifest.bundling.enabled, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("an abandoned legacy output lock is recovered and a failed rebuild preserves the last output", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  await buildExtension({ sourceDir, outputDir });
  const before = await treeDigest(outputDir);
  const lock = join(dirname(outputDir), ".output.qingzhou-build-lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "abandoned-fixture" }));
  await put(sourceDir, "shared/value.ts", "export const value = ;");
  await assert.rejects(buildExtension({ sourceDir, outputDir }), /Build failed/);
  assert.equal(await treeDigest(outputDir), before);
  await assert.rejects(access(lock), { code: "ENOENT" });
  await put(sourceDir, "shared/value.ts", "export const value = 83;");
  await buildExtension({ sourceDir, outputDir });
  assert.match(await readFile(join(outputDir, "shared/value.js"), "utf8"), /83/);
});

test("dev restarts after SIGKILL and continues rebuilding without manual lock cleanup", async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const args = [join(ROOT, "scripts/build-extension.mjs"), "--watch", "--source-dir", sourceDir, "--output-dir", outputDir];
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    try {
      await waitForWatchStartup(child);
      if (index === 1) {
        await put(sourceDir, "shared/value.ts", "export const value = 97;");
        await until(async () => /97/.test(await readFile(join(outputDir, "shared/value.js"), "utf8")));
      }
      child.kill(index === 0 ? "SIGKILL" : "SIGTERM");
      assert.deepEqual(await exited, index === 0 ? [null, "SIGKILL"] : [0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
});

test("killing npm stops its watcher and an immediate npm restart owns the output", { timeout: 30_000 }, async t => {
  const { sourceDir, outputDir } = await fixture(t);
  const lock = join(dirname(outputDir), ".output.qingzhou-build-lock");
  const args = ["run", "dev", "--", "--source-dir", sourceDir, "--output-dir", outputDir];
  const children = [];
  const watcherPids = [];
  const start = () => {
    const child = spawn("npm", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    children.push({ child, exited });
    return { child, exited };
  };
  const ownerPid = async () => {
    const [file] = await readdir(lock);
    const owner = JSON.parse(await readFile(join(lock, file), "utf8"));
    watcherPids.push(owner.pid);
    return owner.pid;
  };
  try {
    let running = start();
    await waitForWatchStartup(running.child);
    let previousPid = await ownerPid();
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      running.child.kill(signal);
      await running.exited;
      // Do not wait for the old lock here: this is the user's immediate restart.
      running = start();
      await waitForWatchStartup(running.child);
      const nextPid = await ownerPid();
      assert.notEqual(nextPid, previousPid);
      await until(() => !isBuildProcessRunning(previousPid));
      // Exited owners include unreaped Linux zombies: their abandoned lock is recoverable.
      await put(dirname(outputDir), ".abandoned.qingzhou-build-lock/owner.json", JSON.stringify({ pid: previousPid }));
      const release = await acquireBuildOutput({ sourceDir, outputDir: join(dirname(outputDir), "abandoned") });
      await release();
      previousPid = nextPid;
    }
    await put(sourceDir, "shared/value.ts", "export const value = 109;");
    await until(async () => /109/.test(await readFile(join(outputDir, "shared/value.js"), "utf8")));
    running.child.kill("SIGTERM");
    await running.exited;
    await until(async () => access(lock).then(() => false, error => { if (error.code === "ENOENT") return true; throw error; }));
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const pid of watcherPids) {
      try { process.kill(pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await Promise.all(children.map(({ exited }) => exited));
  }
});

async function fixture(t) {
  const work = await workspace(t);
  const sourceDir = join(work, "source");
  const outputDir = join(work, "output");
  await mkdir(sourceDir);
  const manifest = {
    manifest_version: 3,
    background: { service_worker: "background/service-worker.js", type: "module" },
    side_panel: { default_path: "sidepanel/sidepanel.html" },
    content_scripts: [{ js: EXTENSION_ENTRIES.filter(entry => entry.path.startsWith("content/")).map(entry => entry.path) }],
    sandbox: { pages: ["runner-sandbox.html"] },
    declarative_net_request: { rule_resources: [] },
  };
  await put(sourceDir, "manifest.json", JSON.stringify(manifest));
  for (const entry of EXTENSION_ENTRIES) await put(sourceDir, entry.path, "globalThis.fixture = true;\n");
  await put(sourceDir, "sidepanel/sidepanel.html", '<script src="../shared/mathjax-config.js"></script><script type="module" src="sidepanel.js"></script>');
  await put(sourceDir, "offscreen.html", '<script type="module" src="offscreen.js"></script>');
  await put(sourceDir, "runner-sandbox.html", '<script src="runner-sandbox.js"></script>');
  await rm(join(sourceDir, "background/service-worker.js"));
  await put(sourceDir, "background/service-worker.ts", 'import { value } from "../shared/value.js";\nexport const answer: number = value;\n');
  await put(sourceDir, "shared/value.ts", "export const value: number = 42;\n");
  await put(sourceDir, "offscreen.js", 'import { value } from "./shared/value.js";\nglobalThis.offscreenValue = value;\n');
  await rm(join(sourceDir, "content/content-script.js"));
  await put(sourceDir, "content/content-script.ts", 'import { value } from "../shared/value.js";\nglobalThis.answer = value;\n');
  return { sourceDir, outputDir, work };
}

async function workspace(t) {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-build-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  return work;
}

async function put(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else hash.update(relative(root, path)).update("\0").update(await readFile(path)).update("\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    try { if (await predicate()) return; }
    catch (error) {
      // Publishing swaps directories; a reader can land between the two renames.
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("watch did not report the expected build result");
}

function waitForWatchStartup(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const finish = message => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (message) reject(new Error(`${message}\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`));
      else resolve();
    };
    const onStdout = data => { stdout += data; if (stdout.includes("Reload the extension")) finish(); };
    const onStderr = data => { stderr += data; if (stderr.includes("Build failed;")) finish("Watch initial build failed"); };
    const onError = error => finish(`Watch process failed to start: ${error.message}`);
    const onExit = (code, signal) => finish(`Watch exited before readiness: ${signal || `code ${code}`}`);
    const timer = setTimeout(() => finish("Watch did not finish its initial build within 30 seconds"), 30_000);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

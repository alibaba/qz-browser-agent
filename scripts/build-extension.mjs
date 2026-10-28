#!/usr/bin/env node

import { build, formatMessages, transform, version as esbuildVersion } from "esbuild";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Script } from "node:vm";
import { generateModelsDevIndex, modelsDevIndexPlugin } from "./models-dev-assets.mjs";
import { bundleExtension, readRuntimeModuleGraph, stableDebugSourceMap } from "./build-extension-bundles.mjs";
import { acquireBuildOutput, BuildOutputLockedError, getBuildProcessParentPid, isBuildProcessRunning } from "./build-output-lock.mjs";
import { readProductProfile } from "./product-profile.mjs";
import { capabilityBuildProfile, capabilityUiAssets, generateCapabilityCatalogs } from "./capability-catalog.mjs";
import { capabilityLocaleAssets } from "./capability-locales.mjs";
import { firefoxManifest, isFirefoxOnlySource, rewriteFirefoxLocaleFiles, rewriteFirefoxSidepanelHtml, writeFirefoxSidebarSkin } from "./firefox-manifest.mjs";
import { copyRuntimeAssets, createDependencyGraph, encodeSourceMapPath, originalInputPath, originalSourceMapPath, packageAssets, recordDependencyBuild, stablePackagePaths, writeDependencyProvenance } from "./vendor/assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_EXTENSION_OUTPUT = resolve(ROOT, "dist/extension");
export const DEFAULT_FIREFOX_EXTENSION_OUTPUT = resolve(ROOT, "dist/extension-firefox");
const BUILD_MANIFEST = ".qingzhou-build.json";
const SCRIPT_EXTENSIONS = /\.(?:js|mjs|ts)$/;
const ASSET_EXTENSIONS = /\.(?:html|css|json|png|svg|jpg|jpeg|gif|webp|ico|woff2?|ttf|wasm|txt)$/;

// These are browser loading boundaries, not a list of every imported module.
export const EXTENSION_ENTRIES = Object.freeze([
  { path: "background/service-worker.js", format: "esm" },
  { path: "sidepanel/sidepanel.js", format: "esm" },
  { path: "offscreen.js", format: "esm" },
  { path: "content/session-export-bridge.js", format: "iife" },
  { path: "content/mcp-connect-bridge.js", format: "iife" },
  { path: "content/article-extractor.js", format: "iife" },
  { path: "content/run-script-tool-bridge.js", format: "iife" },
  { path: "content/content-script.js", format: "iife" },
  { path: "runner-sandbox.js", format: "iife" },
  { path: "shared/mathjax-config.js", format: "iife" },
].map(Object.freeze));
const CLASSIC_ENTRIES = new Set(EXTENSION_ENTRIES.filter(entry => entry.format === "iife").map(entry => entry.path));
const EMBEDDED_WORKER = "workers/inner-runner.ts";
const EMBEDDED_SCRIPTS = [
  { entry: "shared/script-runtime.ts", host: "capabilities/script/tools.js", symbol: "SCRIPT_RUNTIME_SOURCE", globalName: "QZ_SCRIPT_RUNTIME" },
  { entry: "content/page-scripts/element.ts", host: "background/tools/page-scripts.js", symbol: "ELEMENT_PAGE_SCRIPT_SOURCE", globalName: "QZ_ELEMENT_PAGE_SCRIPTS" },
  { entry: EMBEDDED_WORKER, host: "runner-sandbox.js", symbol: "INNER_WORKER_SOURCE", debugMap: true },
  { entry: "sidepanel/features/export/session-export-runtime.ts", host: "sidepanel/features/export/session-export-feature.js", symbol: "SESSION_EXPORT_RUNTIME_SOURCE" },
];

export function extensionOutputDirectory(browser = "chrome") {
  if (browser === "firefox") return DEFAULT_FIREFOX_EXTENSION_OUTPUT;
  if (browser === "chrome") return DEFAULT_EXTENSION_OUTPUT;
  throw new Error(`unknown browser: ${browser}`);
}

async function prepareBuild(options) {
  const browser = options.browser || "chrome";
  if (!["chrome", "firefox"].includes(browser)) throw new Error(`unknown browser: ${browser}`);
  const sourceDir = await realpath(resolve(options.sourceDir || resolve(ROOT, "src")));
  const outputDir = await canonicalPath(resolve(options.outputDir || extensionOutputDirectory(browser)));
  const mode = options.mode || "development";
  if (!["development", "production"].includes(mode)) throw new Error(`unknown build mode: ${mode}`);
  if (isInside(sourceDir, outputDir) || isInside(outputDir, sourceDir)) throw new Error("source and output directories must not overlap");
  await assertOwnedOutput(outputDir);
  return { ...options, browser, sourceDir, outputDir, mode };
}

/** Compile a complete extension, publishing it only after every check succeeds. */
export async function buildExtension(options = {}) {
  options = await prepareBuild(options);
  const release = await acquireBuildOutput(options);
  try { return await compileExtension(options); }
  finally { await release(); }
}

async function compileExtension({ sourceDir: source, outputDir: output, mode, bundle = mode === "production", product, debugMaps = false, browser = "chrome", signal }) {
  signal?.throwIfAborted();
  const profile = await readProductProfile(source, product);
  if (source === resolve(ROOT, "src")) generateCapabilityCatalogs(ROOT);
  generateModelsDevIndex(ROOT);
  const capabilities = capabilityBuildProfile(source);
  const uiAssets = await capabilityUiAssets(source, { includes: profile.includes });
  const localeAssets = capabilityLocaleAssets(source, { entries: capabilities.entries.locales, includes: profile.includes });
  for (const [path, contents] of uiAssets.overrides) profile.overrides.set(path, contents);
  for (const [path, contents] of localeAssets.assets) profile.overrides.set(path, contents);
  profile.plugins.unshift(capabilities.plugin, modelsDevIndexPlugin(source));
  const paths = [...(await sourceFiles(source)).filter(path => profile.includes(path)
    && (browser === "firefox" || !isFirefoxOnlySource(path))
    && !uiAssets.resources.has(resolve(source, path)) && !localeAssets.resources.has(resolve(source, path))
    && !capabilities.declarations.has(resolve(source, path))), ...capabilities.paths,
    ...[...localeAssets.assets.keys()].map(path => posix(relative(source, path)))];
  const outputs = new Map();
  for (const path of paths) {
    const emitted = path.replace(/\.ts$/, ".js");
    if (outputs.has(emitted)) throw new Error(`duplicate output ${emitted}: ${outputs.get(emitted)} and ${path}`);
    outputs.set(emitted, path);
  }

  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(resolve(dirname(output), `.${basename(output)}-build-`));
  const compiled = resolve(staging, "extension");
  await mkdir(compiled);
  try {
    const dependencyGraph = createDependencyGraph();
    await copyRuntimeAssets(compiled, dependencyGraph);
    const embedded = new Map();
    const embeddedDebugScripts = [];
    for (const script of EMBEDDED_SCRIPTS.filter(script => paths.includes(script.entry))) {
      const result = await buildEmbeddedScript({ sourceDir: source, mode, ...script, profile, debugMaps, browser });
      embedded.set(script.host, { [script.symbol]: JSON.stringify(result.code) });
      if (result.map) {
        // This is the exact injected fragment, not a map for its enclosing dynamic wrapper.
        const artifact = `.qingzhou-debug/embedded/${script.entry.replace(/\.ts$/, ".js")}`;
        const map = `${artifact}.map`;
        await mkdir(dirname(resolve(compiled, artifact)), { recursive: true });
        await writeFile(resolve(compiled, artifact), result.code);
        await writeFile(resolve(compiled, map), result.map);
        embeddedDebugScripts.push({ entry: script.entry, host: script.host, symbol: script.symbol, artifact, map });
      }
    }
    const modules = new Map();
    for (const [emitted, path] of outputs) {
      if (EMBEDDED_SCRIPTS.some(script => script.entry === path)) continue; // Included once, as compiled source in its host.
      const destination = resolve(compiled, emitted);
      await mkdir(dirname(destination), { recursive: true });
      if (!path.startsWith("vendor/") && SCRIPT_EXTENSIONS.test(path)) {
        if (CLASSIC_ENTRIES.has(emitted)) await compileScript({ source, compiled, output, path, emitted, mode, debugMaps, define: embedded.get(emitted) || {}, profile, dependencyGraph, browser });
        else modules.set(emitted, path);
      } else if (profile.overrides.has(resolve(source, path))) {
        await writeFile(destination, profile.overrides.get(resolve(source, path)));
      } else {
        await copyFile(resolve(source, path), destination);
      }
    }
    await compileModules({ source, compiled, output, modules, embedded, mode, debugMaps, profile, dependencyGraph, browser });
    await validateRuntimeEntries(compiled);
    const { preservedInputs, runtimeInputs } = await validateModuleGraphs(compiled);
    if (mode === "production") {
      for (const [emitted, path] of outputs) {
        if (runtimeInputs.has(emitted) || CLASSIC_ENTRIES.has(emitted) || !SCRIPT_EXTENSIONS.test(emitted)) continue;
        const destination = resolve(compiled, emitted);
        if (path.startsWith("examples/") || (path.endsWith(".ts") && !EMBEDDED_SCRIPTS.some(script => script.entry === path)
          && !(await readFile(destination, "utf8")).replace(/\/\/# sourceMappingURL=[^\r\n]*\s*$/, "").trim())) {
          await rm(destination);
          await rm(`${destination}.map`, { force: true });
        }
      }
    }
    const bundling = bundle ? await bundleExtension({ extensionDir: compiled, preservedInputs, debugMaps }) : { enabled: false };
    if (browser === "firefox") await assertFirefoxBootImports(compiled);
    await writeDependencyProvenance(compiled, dependencyGraph, bundling);
    if (browser === "firefox") {
      const manifestPath = resolve(compiled, "manifest.json");
      const manifest = firefoxManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const icons = [manifest.action?.default_icon, manifest.sidebar_action.default_icon]
        .flatMap(icon => typeof icon === "string" ? [icon] : Object.values(icon || {}));
      for (const icon of new Set(icons)) {
        if (!(await isPackageFile(compiled, icon))) throw new Error(`Firefox manifest icon is not in the package: ${icon}`);
      }
      const panelPath = resolve(compiled, "sidepanel/sidepanel.html");
      await writeFile(panelPath, rewriteFirefoxSidepanelHtml(await readFile(panelPath, "utf8")));
      await writeFirefoxSidebarSkin(compiled);
      await rewriteFirefoxLocaleFiles(compiled, source);
    }
    const files = (await allFiles(compiled)).map(path => posix(relative(compiled, path)));
    const summary = {
      formatVersion: 1,
      tool: `qingzhou-build/esbuild@${esbuildVersion}`,
      mode,
      debugMaps,
      embeddedDebugScripts,
      product: profile.name,
      entries: EXTENSION_ENTRIES,
      embeddedScripts: EMBEDDED_SCRIPTS.filter(script => paths.includes(script.entry)).map(({ entry, host }) => ({ entry, host })),
      files,
      bundling,
    };
    await writeFile(resolve(compiled, BUILD_MANIFEST), `${JSON.stringify(summary, null, 2)}\n`);
    signal?.throwIfAborted();
    await publishOutput(compiled, output, resolve(staging, "previous"), signal);
    // `browser` stays off the packaged manifest so a Firefox-only edit cannot move the Chrome hash.
    return { ...summary, browser, outputDir: output };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** A separate Worker graph: no DOM imports or serialization of runtime function bodies. */
export function compileInnerWorker(options = {}) {
  return compileEmbeddedScript({ ...options, entry: EMBEDDED_WORKER, debugMap: true });
}

export async function compileEmbeddedScript(options = {}) {
  return (await buildEmbeddedScript(options)).code;
}

async function buildEmbeddedScript({ sourceDir = resolve(ROOT, "src"), entry, mode = "development", debugMap = false, debugMaps = false, globalName, profile, browser = "chrome" } = {}) {
  sourceDir = resolve(sourceDir);
  profile ??= await readProductProfile(sourceDir);
  if (!profile.plugins.some(plugin => plugin.name === "capability-catalogs")) profile.plugins.unshift(capabilityBuildProfile(sourceDir).plugin);
  if (!entry || !isInside(sourceDir, resolve(sourceDir, entry))) throw new Error("embedded script must be inside the extension");
  const result = await build({
    absWorkingDir: sourceDir, entryPoints: [entry], bundle: true, write: false, metafile: true,
    platform: "browser", format: "iife", globalName, target: "chrome114", minify: mode === "production",
    sourcemap: debugMaps ? "external" : debugMap && mode === "development" ? "inline" : false,
    ...(debugMaps ? { outfile: entry.replace(/\.ts$/, ".js"), sourcesContent: true } : {}),
    logLevel: "silent", tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    plugins: profile.plugins,
  });
  if (browser === "chrome") rejectFirefoxOnlyInputs(result.metafile, sourceDir);
  if (result.warnings.length) throw new Error((await formatMessages(result.warnings, { kind: "warning", color: false })).join("\n"));
  if (Object.keys(result.metafile.inputs).some(path => !isInside(sourceDir, resolve(sourceDir, path)))
    || Object.values(result.metafile.outputs).some(output => output.imports.length)) {
    throw new Error("embedded script must be self-contained within the extension");
  }
  const javascript = result.outputFiles.find(file => !file.path.endsWith(".map"));
  const map = result.outputFiles.find(file => file.path.endsWith(".map"));
  return { code: javascript.text, map: map ? stableDebugSourceMap(map.text, sourceDir, dirname(map.path)) : null };
}

/** Multi-entry splitting preserves public module paths and lets esbuild own npm CJS/ESM interop. */
async function compileModules({ source, compiled, output, modules, embedded, mode, debugMaps, profile, dependencyGraph, browser = "chrome" }) {
  const result = await build({
    absWorkingDir: source,
    entryPoints: Object.fromEntries([...modules].map(([emitted, path]) => [emitted.replace(/\.(?:js|mjs)$/, ""), path])),
    outdir: compiled, bundle: true, splitting: true, write: false, metafile: true,
    platform: "browser", format: "esm", target: "chrome114", charset: "utf8", legalComments: "none",
    chunkNames: "deps/chunks/[name]-[hash]", nodePaths: [resolve(ROOT, "node_modules")],
    sourcemap: mode === "development" || debugMaps ? "linked" : false, sourcesContent: true,
    define: Object.assign({}, ...embedded.values()),
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
    logLevel: "silent", plugins: [...profile.plugins, { name: "application-module-boundaries", setup(context) {
      context.onResolve({ filter: /^\./ }, args => {
        if (!args.importer || !isInside(source, args.importer)) return null;
        const resolved = resolve(args.resolveDir, args.path);
        if (!isInside(source, resolved)) throw new Error(`application import escaped extension: ${args.path}`);
        if (browser === "chrome") rejectFirefoxOnlyImport(source, resolved, args.importer);
        return { path: args.path, external: true };
      });
    } }, { name: "static-package-resources", setup(context) {
      context.onResolve({ filter: /^(?:pdfjs-dist\/|#mcp-sdk$)/ }, args => {
        const asset = packageAssets.get(args.path);
        if (!asset) return null;
        const importer = relative(source, args.importer);
        if (!isInside(source, args.importer)) throw new Error(`static package resource requires an application importer: ${args.path}`);
        const path = posix(relative(dirname(importer), asset));
        return { path: path.startsWith(".") ? path : `./${path}`, external: true };
      });
    } }, stablePackagePaths()],
  });
  if (browser === "chrome") rejectFirefoxOnlyInputs(result.metafile, source);
  if (result.warnings.length) throw new Error((await formatMessages(result.warnings, { kind: "warning", color: false })).join("\n"));
  for (const path of Object.keys(result.metafile.inputs)) {
    const input = originalInputPath(path, source);
    if (!isInside(source, input) && !isInside(resolve(ROOT, "node_modules"), input)) throw new Error(`module input escaped extension and installed dependencies: ${path}`);
  }
  recordDependencyBuild(dependencyGraph, result.metafile, source, compiled);
  for (const file of result.outputFiles) {
    const path = relative(compiled, file.path);
    const contents = file.path.endsWith(".map")
      ? debugMaps ? stableDebugSourceMap(file.text, source, dirname(file.path))
        : remapSources(file.text, dirname(file.path), dirname(resolve(output, path)))
      : file.contents;
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, contents);
  }
}

async function compileScript({ source, compiled, output, path, emitted, mode, debugMaps, define, profile, dependencyGraph, browser = "chrome" }) {
  const contents = profile.overrides.get(resolve(source, path)) ?? await readFile(resolve(source, path), "utf8");
  const typed = path.endsWith(".ts");
  const classic = CLASSIC_ENTRIES.has(emitted);
  let bundleClassic = typed;
  if (classic && !typed) {
    try { new Script(contents, { filename: path }); }
    catch (_error) { bundleClassic = true; } // Module syntax needs a self-contained classic entry.
  }
  const sourceMap = debugMaps || (typed || (classic && bundleClassic)) && mode === "development";
  const embedded = EMBEDDED_SCRIPTS.find(script => script.host === emitted);
  if (typed && embedded && !define[embedded.symbol]) throw new Error(`${emitted} requires ${embedded.entry}`);
  let result;
  if (!classic || bundleClassic) {
    result = await build({
      absWorkingDir: source,
      entryPoints: [path],
      outfile: emitted,
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      format: classic ? "iife" : "esm",
      target: "chrome114",
      define,
      plugins: [...profile.plugins, stablePackagePaths()],
      nodePaths: [resolve(ROOT, "node_modules")],
      sourcemap: sourceMap ? "external" : false,
      sourcesContent: true,
      logLevel: "silent",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
    });
    if (browser === "chrome") rejectFirefoxOnlyInputs(result.metafile, source);
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!isInside(source, originalInputPath(input, source)) && !isInside(resolve(ROOT, "node_modules"), originalInputPath(input, source))) throw new Error(`entry input escaped extension and installed dependencies: ${input}`);
    }
    if (classic && Object.values(result.metafile.outputs).some(output => output.imports.some(item => item.external))) {
      throw new Error(`classic entry must be self-contained: ${path}`);
    }
    recordDependencyBuild(dependencyGraph, result.metafile, source, source);
    for (const file of result.outputFiles) {
      const outputPath = relative(source, file.path);
      const contents = file.path.endsWith(".map")
        ? debugMaps ? stableDebugSourceMap(file.text, source, dirname(file.path))
          : remapSources(file.text, dirname(file.path), dirname(resolve(output, outputPath)))
        : file.contents;
      await writeFile(resolve(compiled, outputPath), contents);
    }
    if (sourceMap) await writeFile(resolve(compiled, emitted), `${result.outputFiles.find(file => file.path.endsWith(".js")).text}\n//# sourceMappingURL=${basename(emitted)}.map\n`);
  } else {
    result = await transform(contents, {
      define,
      loader: typed ? "ts" : "js",
      sourcefile: basename(path),
      target: typed ? "chrome114" : "esnext",
      sourcemap: sourceMap ? "external" : false,
      sourcesContent: true,
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
    });
    // A plain classic script deliberately owns globals; preserve that loading boundary.
    const code = typed || debugMaps || Object.keys(define).length ? result.code : contents;
    await writeFile(resolve(compiled, emitted), sourceMap ? `${code}\n//# sourceMappingURL=${basename(emitted)}.map\n` : code);
    if (sourceMap) await writeFile(resolve(compiled, `${emitted}.map`), debugMaps
      ? stableDebugSourceMap(result.map, source, dirname(resolve(source, path)))
      : remapSources(result.map, dirname(resolve(source, path)), dirname(resolve(output, emitted))));
  }
  if (result.warnings.length) {
    const messages = await formatMessages(result.warnings, { kind: "warning", color: false });
    throw new Error(`esbuild warnings for ${path}:\n${messages.join("\n")}`);
  }
}

/** Chrome entries keep Firefox adapters out of the package. The Firefox build loads those files from its boot modules. */
function rejectFirefoxOnlyImport(source, resolved, importer) {
  const rel = firefoxOnlyRelative(source, resolved);
  if (!rel) return;
  const from = importer && isInside(source, importer) ? ` from ${posix(relative(source, importer))}` : "";
  throw new Error(`Chrome package cannot import Firefox-only source ${rel}${from}. Load it from background/firefox-boot.ts or sidepanel/firefox-boot.ts, which only the Firefox package includes.`);
}

function rejectFirefoxOnlyInputs(metafile, source) {
  for (const input of Object.keys(metafile?.inputs || {})) {
    const path = originalInputPath(input, source);
    if (isInside(source, path)) rejectFirefoxOnlyImport(source, path);
  }
}

function firefoxOnlyRelative(source, file) {
  const rel = posix(relative(source, file));
  if (rel.startsWith("../") || isAbsolute(rel)) return "";
  if (isFirefoxOnlySource(rel)) return rel;
  if (rel.endsWith(".js")) {
    const typed = `${rel.slice(0, -3)}.ts`;
    if (isFirefoxOnlySource(typed)) return typed;
  }
  return "";
}

function remapSources(contents, sourceMapDirectory, outputMapDirectory) {
  const map = JSON.parse(contents);
  map.sources = map.sources.map(path => encodeSourceMapPath(relative(outputMapDirectory, originalSourceMapPath(path, sourceMapDirectory, map.sourceRoot || ""))));
  delete map.sourceRoot;
  return `${JSON.stringify(map)}\n`;
}

async function sourceFiles(root) {
  const files = await allFiles(root, true);
  return files.map(path => posix(relative(root, path))).filter(path => {
    if (path.startsWith("vendor/")) return false; // Installed packages own generated vendor assets.
    if (/\.d\.ts$/.test(path)) return false;
    return SCRIPT_EXTENSIONS.test(path) || ASSET_EXTENSIONS.test(path);
  });
}

async function allFiles(root, source = false) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (source && (entry.name.startsWith(".") || ["_metadata", "node_modules", "local", "__pycache__"].includes(entry.name))) continue;
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`extension files must not be symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await allFiles(path, source));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function validateRuntimeEntries(root) {
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || manifest.background?.type !== "module") throw new Error("expected a Manifest V3 module service worker");
  if (manifest.background.service_worker !== EXTENSION_ENTRIES[0].path) throw new Error("unexpected background entry");
  const references = new Set([
    ...EXTENSION_ENTRIES.map(entry => entry.path),
    manifest.side_panel?.default_path,
    ...manifest.content_scripts.flatMap(item => item.js || []),
    ...manifest.content_scripts.flatMap(item => item.css || []),
    ...manifest.sandbox.pages,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.declarative_net_request?.rule_resources || []).map(item => item.path),
  ]);
  for (const path of manifest.content_scripts.flatMap(item => item.js || [])) {
    if (!path.startsWith("vendor/") && !CLASSIC_ENTRIES.has(path)) throw new Error(`declare the classic entry in EXTENSION_ENTRIES: ${path}`);
  }
  for (const html of ["sidepanel/sidepanel.html", "offscreen.html", "runner-sandbox.html"]) {
    references.add(html);
    const contents = await readFile(resolve(root, html), "utf8");
    for (const match of contents.matchAll(/<(script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
      if (match[1].toLowerCase() === "link" && match[2].startsWith("data:")) continue;
      if (/^(?:[a-z]+:|\/\/)/i.test(match[2])) throw new Error(`external entry resource in ${html}: ${match[2]}`);
      const path = posix(relative(root, resolve(root, dirname(html), match[2].split(/[?#]/)[0])));
      references.add(path);
      if (match[1].toLowerCase() === "script" && !path.startsWith("vendor/")) {
        const format = /\btype=["']module["']/i.test(match[0]) ? "esm" : "iife";
        if (!EXTENSION_ENTRIES.some(entry => entry.path === path && entry.format === format)) {
          throw new Error(`declare the ${format} entry in EXTENSION_ENTRIES: ${path}`);
        }
      }
    }
  }
  for (const reference of references) {
    if (!reference || !isInside(root, resolve(root, reference))) throw new Error(`invalid runtime resource: ${reference}`);
    const info = await lstat(resolve(root, reference));
    if (!info.isFile()) throw new Error(`runtime resource is not a file: ${reference}`);
  }
}

const BUNDLED_RUNTIME_ENTRIES = new Set(["background/service-worker.js", "sidepanel/sidepanel.js"]);
const FIREFOX_BOOT_ENTRIES = ["background/firefox-boot.js", "sidepanel/firefox-boot.js"];

async function validateModuleGraphs(root) {
  const preservedInputs = new Set();
  const runtimeInputs = new Set();
  for (const entry of EXTENSION_ENTRIES.filter(entry => entry.format === "esm")) {
    const inputs = await readRuntimeModuleGraph(root, entry.path);
    for (const input of inputs) runtimeInputs.add(input);
    if (!BUNDLED_RUNTIME_ENTRIES.has(entry.path)) {
      for (const path of inputs) preservedInputs.add(path);
    }
  }
  // Firefox boot files stay outside the service-worker and sidepanel bundles. Their static
  // imports must remain on disk or the event page fails before the host installs.
  for (const path of await firefoxBootPreservedInputs(root)) preservedInputs.add(path);
  return { preservedInputs: [...preservedInputs], runtimeInputs };
}

/** Modules the Firefox boot graph loads beside the bundled service worker and side panel. */
export async function firefoxBootPreservedInputs(root) {
  const preserved = new Set();
  const seen = new Set();
  for (const boot of FIREFOX_BOOT_ENTRIES) {
    if (await isPackageFile(root, boot)) await walkFirefoxBoot(root, boot, seen, preserved);
  }
  return [...preserved];
}

/** Fail the Firefox package when a boot import was bundled away or never emitted. */
export async function assertFirefoxBootImports(root) {
  const missing = [];
  const seen = new Set();
  for (const boot of FIREFOX_BOOT_ENTRIES) {
    if (!(await isPackageFile(root, boot))) continue;
    await visitFirefoxBoot(root, boot, seen, missing);
  }
  if (missing.length) throw new Error(`Firefox boot graph is missing a module:\n${missing.join("\n")}`);
}

async function walkFirefoxBoot(root, path, seen, preserved) {
  if (seen.has(path) || BUNDLED_RUNTIME_ENTRIES.has(path)) return;
  seen.add(path);
  preserved.add(path);
  for (const specifier of staticRelativeImports(await readFile(resolve(root, path), "utf8"))) {
    const target = packageRelative(root, path, specifier);
    if (target && await isPackageFile(root, target)) await walkFirefoxBoot(root, target, seen, preserved);
  }
}

async function visitFirefoxBoot(root, path, seen, missing) {
  if (seen.has(path)) return;
  seen.add(path);
  if (BUNDLED_RUNTIME_ENTRIES.has(path)) {
    if (!(await isPackageFile(root, path))) missing.push(path);
    return;
  }
  if (!(await isPackageFile(root, path))) {
    missing.push(path);
    return;
  }
  for (const specifier of staticRelativeImports(await readFile(resolve(root, path), "utf8"))) {
    const target = packageRelative(root, path, specifier);
    if (!target) missing.push(`${path} imports ${specifier} outside the package`);
    else await visitFirefoxBoot(root, target, seen, missing);
  }
}

function staticRelativeImports(source) {
  const specs = [];
  const pattern = /(?:^|[;\n])[ \t]*(?:import|export)(?=\s)([\s\S]*?)\sfrom\s*["'](\.[^"']+)["']|(?:^|[;\n])[ \t]*import\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specs.push(match[2] || match[3]);
  return specs;
}

function packageRelative(root, from, specifier) {
  const target = posix(relative(root, resolve(root, dirname(from), specifier)));
  if (!target || target.startsWith("../") || isAbsolute(target)) return "";
  return target;
}

async function isPackageFile(root, path) {
  try { return (await lstat(resolve(root, path))).isFile(); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertOwnedOutput(output) {
  let entries;
  try { entries = await readdir(output); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!entries.length) return;
  let previous;
  try { previous = JSON.parse(await readFile(resolve(output, BUILD_MANIFEST), "utf8")); } catch { /* checked below */ }
  if (previous?.formatVersion !== 1 || !previous?.tool?.startsWith("qingzhou-build/")) {
    throw new Error(`refusing to replace a directory not owned by this build: ${output}`);
  }
}

async function publishOutput(compiled, output, previous, signal) {
  await assertOwnedOutput(output);
  signal?.throwIfAborted();
  let moved = false;
  try { await rename(output, previous); moved = true; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try { signal?.throwIfAborted(); await rename(compiled, output); } catch (error) {
    if (moved) await rename(previous, output);
    throw error;
  }
}

async function canonicalPath(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(await canonicalPath(dirname(path)), basename(path));
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function posix(path) { return path.split(sep).join("/"); }

/** Serial rebuilds; errors keep the last complete extension available for manual reload. */
export async function watchExtension(options = {}, { onBuild = () => {}, onError = console.error, debounceMs = 150 } = {}) {
  options = await prepareBuild(options);
  const release = await acquireBuildOutput(options, { watch: true });
  let timer;
  let active;
  let pending = false;
  let closed = false;
  let watcher;
  let refreshWatcher = false;
  let closing;
  async function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    options.signal?.removeEventListener("abort", interrupted);
    closing = (async () => { try { await active; } finally { await release(); } })();
    return closing;
  }
  const interrupted = () => { void close().catch(onError); };
  function watchSources() {
    const next = watch(options.sourceDir, { recursive: true }, event => {
      if (event === "rename") refreshWatcher = true;
      clearTimeout(timer);
      timer = setTimeout(rebuild, debounceMs);
    });
    next.on("error", onError);
    watcher?.close();
    watcher = next;
    refreshWatcher = false;
  }
  async function rebuild() {
    if (closed) return;
    if (active) { pending = true; return; }
    active = (async () => {
      // Recursive watches can retain the old directory's inode after an atomic replacement.
      // Reattach before rebuilding so later edits and removals reach the new directory too.
      if (refreshWatcher) watchSources();
      return compileExtension(options);
    })().then(onBuild, onError);
    try { await active; } finally {
      active = null;
      if (pending) { pending = false; await rebuild(); }
    }
  }
  try {
    options.signal?.throwIfAborted();
    watchSources();
    options.signal?.addEventListener("abort", interrupted, { once: true });
    await rebuild();
    return { close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const launcherPid = process.ppid;
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" },
    watch: { type: "boolean" },
    typecheck: { type: "boolean" },
    json: { type: "boolean" },
    "no-bundle": { type: "boolean" },
    "debug-maps": { type: "boolean" },
    "source-dir": { type: "string" },
    "output-dir": { type: "string" },
    mode: { type: "string" },
    product: { type: "string" },
    browser: { type: "string" },
  } });
  if (values.help) {
    console.log(`Usage: npm run dev -- [options]
       npm run build -- [options]

dev watches sources; build typechecks and creates a production bundle.
Chrome loads the generated extension from dist/extension/. npm run dev and npm run build do that.
Firefox temporary loading uses dist/extension-firefox/. npm run dev:firefox and npm run build:firefox
pass --browser firefox and leave the Chrome directory alone.

Options:
  --source-dir <path>          Source directory (default: src/)
  --output-dir <path>          Output directory (default: dist/extension/, or dist/extension-firefox/ with --browser firefox)
  --mode <development|production>
  --browser <chrome|firefox>   Package target (default: chrome)
  --product <public>  Override the source product manifest
  --watch                     Rebuild on source changes
  --typecheck                 Check repository TypeScript before building
  --no-bundle                 Compile without merging application entries
  --debug-maps                Include production debugging source maps
  --json                      Print build metadata as JSON
  -h, --help                  Show this help without building`);
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`--${name} requires a non-empty value`);
  }
  if (values.mode && !["development", "production"].includes(values.mode)) throw new Error(`unknown build mode: ${values.mode}`);
  if (values.browser && !["chrome", "firefox"].includes(values.browser)) throw new Error(`unknown browser: ${values.browser}`);
  if (values.product && !["public"].includes(values.product)) throw new Error(`invalid product: ${values.product}`);
  if (values.typecheck) {
    // Keep the build gate in this CLI so npm can forward every option, including --help.
    const check = spawnSync(process.execPath, [resolve(ROOT, "scripts/typecheck.mjs")], {
      cwd: ROOT, stdio: ["inherit", values.json ? 2 : 1, 2],
    });
    if (check.error) throw check.error;
    if (check.signal) throw new Error(`Typecheck interrupted (${check.signal})`);
    if (check.status !== 0) { process.exitCode = check.status ?? 1; return; }
  }
  const options = {
    sourceDir: values["source-dir"], outputDir: values["output-dir"], mode: values.mode, product: values.product,
    browser: values.browser,
    bundle: values["no-bundle"] ? false : undefined, debugMaps: values["debug-maps"] === true,
  };
  const report = result => console.log(values.json ? JSON.stringify(result)
    : `Built ${result.files.length} files (${result.mode}, ${result.product}, ${result.browser}) in ${result.outputDir}.${values.watch ? " Reload the extension when ready." : ""}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Build interrupted"));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let parentTimer;
  const cleanup = () => {
    clearInterval(parentTimer);
    for (const signal of signals) process.removeListener(signal, interrupt);
  };
  for (const signal of signals) process.once(signal, interrupt);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  options.signal = controller.signal;
  if (values.watch) {
    options.launcherPid = launcherPid;
    // npm's shell may survive npm's SIGKILL; retain its original parent, before reparenting.
    const launcherParentPid = process.env.npm_lifecycle_event ? getBuildProcessParentPid(launcherPid) : undefined;
    options.launcherParentPid = launcherParentPid;
    // Killing npm alone does not necessarily signal its child. The CLI watcher belongs
    // to its launcher, including when the terminal closes or npm is killed with SIGKILL.
    const checkParent = () => {
      const exited = process.ppid !== launcherPid || [launcherPid, launcherParentPid]
        .some(pid => Number.isSafeInteger(pid) && (pid <= 1 || !isBuildProcessRunning(pid)));
      if (exited) controller.abort(new Error("Dev launcher exited"));
    };
    parentTimer = setInterval(checkParent, 200).unref();
    checkParent();
  }
  if (!values.watch) {
    try { report(await buildExtension(options)); }
    finally { cleanup(); }
    return;
  }
  try {
    await watchExtension(options, {
      onBuild: report,
      onError: error => console.error(`Build failed; keeping the last successful output.\n${error.message || error}`),
    });
  } catch (error) {
    cleanup();
    if (!(error instanceof BuildOutputLockedError) || !error.alreadyWatching) throw error;
    console.log(values.json ? JSON.stringify({ alreadyRunning: true, pid: error.owner.pid, outputDir: error.outputDir })
      : `Dev watcher already running (PID ${error.owner.pid}) for ${error.outputDir}. Source changes are already being watched.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

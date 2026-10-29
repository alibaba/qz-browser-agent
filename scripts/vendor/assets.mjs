import { modelsDevAssetPath, modelsDevAsset } from "../models-dev-assets.mjs";
import { hardenPdfSource, pdfSourceHashes } from "./pdfjs.mjs";
import { hardenZodSource, zodSourceHashes } from "./zod.mjs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_MODULES = resolve(ROOT, "node_modules");
const hash = value => createHash("sha256").update(value).digest("hex");
const posix = value => value.split(sep).join("/");
export const packageAssets = new Map([
  ["#mcp-sdk", "vendor/mcp-sdk.mjs"],
  ["pdfjs-dist/build/pdf.mjs", "vendor/pdf.mjs"],
  ["pdfjs-dist/build/pdf.worker.mjs", "vendor/pdf.worker.mjs"],
]);
const copies = [
  // JavaScript engines are built below from readable sources, never copied from minified distributions.
  ["tabulator-tables/dist/css/tabulator.min.css", "vendor/tabulator/tabulator.min.css"],
  ["tabulator-tables/dist/css/tabulator.min.css.map", "vendor/tabulator/tabulator.min.css.map"],
];

let staticEnginesBuild;
function buildStaticEngines() {
  return staticEnginesBuild ||= Promise.all([
    ...Object.keys(pdfSourceHashes).map(filename => build({
      absWorkingDir: ROOT, entryPoints: [`node_modules/pdfjs-dist/build/${filename}`],
      outfile: `vendor/${filename}`, bundle: true, write: false, metafile: true,
      platform: "browser", format: "esm", target: "chrome114", minify: false, keepNames: true,
      sourcemap: "external", sourcesContent: true, legalComments: "inline",
      plugins: [{ name: "static-only-pdfjs", setup(context) {
        context.onLoad({ filter: /pdf(?:\.worker)?\.mjs$/ }, async args => ({
          contents: hardenPdfSource(await readFile(args.path, "utf8"), filename),
          loader: "js", resolveDir: dirname(args.path),
        }));
      } }],
    })),
    build({
      absWorkingDir: ROOT, entryPoints: ["scripts/vendor/mathjax-entry.mjs"],
      outfile: "vendor/mathjax/startup.js", bundle: true, write: false, metafile: true,
      platform: "browser", format: "iife", target: "chrome114", minify: false, keepNames: true,
      define: { global: "globalThis" }, sourcemap: "external", sourcesContent: true,
      // Match MathJax's upstream tsconfig: subclass type declarations must not reset base fields.
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
      legalComments: "inline", plugins: [stablePackagePaths()],
    }),
  ]).catch(error => { staticEnginesBuild = null; throw error; });
}

let mcpSdkBuild;
function buildMcpSdk() {
  // MV3 uses static imports. A factory defers SDK schema initialization until the first connection.
  return mcpSdkBuild ||= build({
    absWorkingDir: ROOT,
    stdin: { contents: `
      export { Client } from "@modelcontextprotocol/sdk/client/index.js";
      export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
      export { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
    `, resolveDir: ROOT, sourcefile: "mcp-sdk-entry.js" },
    outfile: "vendor/mcp-sdk.mjs", bundle: true, write: false, metafile: true,
    platform: "browser", format: "iife", globalName: "qzMcpSdk", target: "chrome114",
    banner: { js: "let cached;\nexport function getMcpSdk() {\nif (cached) return cached;" },
    footer: { js: "return cached = qzMcpSdk;\n}" },
    sourcemap: "linked", sourcesContent: true, legalComments: "none", plugins: [{
      name: "mcp-interpreted-schema-validator",
      setup(context) {
        // The SDK's default Ajv provider compiles schemas with Function, even when unused.
        // qz already selects CfWorker explicitly; make the SDK default use the same interpreter.
        context.onResolve({ filter: /\/validation\/ajv-provider\.js$/ }, () => ({ path: "mcp-validator", namespace: "qz" }));
        context.onLoad({ filter: /^mcp-validator$/, namespace: "qz" }, () => ({
          contents: 'export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";',
          resolveDir: ROOT, loader: "js",
        }));
      },
    }, stablePackagePaths()],
  }).catch(error => { mcpSdkBuild = null; throw error; });
}

/** Source-level tests consume the same SDK factory as the browser. */
export async function generateMcpSdkForTests() {
  const result = await buildMcpSdk();
  const destination = resolve(ROOT, "dist/generated");
  await mkdir(destination, { recursive: true });
  for (const file of result.outputFiles) {
    const target = resolve(destination, relative(resolve(ROOT, "vendor"), file.path));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, file.contents);
    await rename(temporary, target);
  }
}

/** Stable npm identities prevent checkout paths leaking into CJS names, chunk hashes and maps. */
export function stablePackagePaths() {
  return { name: "stable-npm-source-paths", setup(context) {
    context.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.stableNpmResolve || args.kind === "entry-point") return null;
      const result = await context.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir,
        importer: args.namespace === "npm" ? resolve(NODE_MODULES, args.importer) : args.importer,
        pluginData: { stableNpmResolve: true } });
      if (result.errors.length) return { errors: result.errors };
      if (!result.path.startsWith(`${NODE_MODULES}${sep}`)) return null;
      return { path: posix(relative(NODE_MODULES, result.path)), namespace: "npm", sideEffects: result.sideEffects };
    });
    context.onLoad({ filter: /.*/, namespace: "npm" }, async ({ path }) => {
      const file = resolve(NODE_MODULES, path);
      const extension = extname(file).slice(1);
      let contents = await readFile(file, "utf8");
      const zod = /^zod\/v4\/core\/(util|doc|schemas)\.js$/u.exec(path);
      if (zod) contents = hardenZodSource(contents, `${zod[1]}.js`);
      return { contents, loader: ["json", "ts", "tsx", "jsx", "css"].includes(extension) ? extension : "js", resolveDir: dirname(file) };
    });
  } };
}

export function originalInputPath(input, workingDirectory) {
  return input.startsWith("npm:") ? resolve(NODE_MODULES, input.slice(4)) : resolve(workingDirectory, input);
}

/** Source maps encode URL paths; metafile inputs above remain literal filesystem paths. */
export function originalSourceMapPath(input, mapDirectory, sourceRoot = "") {
  return originalInputPath(decodeURIComponent(input), resolve(mapDirectory, decodeURIComponent(sourceRoot)));
}

export function encodeSourceMapPath(path) {
  return posix(path).split("/").map(encodeURIComponent).join("/");
}

export function createDependencyGraph() { return { outputs: new Map(), packages: new Set() }; }

function packageDirectory(filename) {
  const path = posix(resolve(filename));
  const marker = "/node_modules/";
  const start = path.lastIndexOf(marker);
  if (start < 0) return null;
  const parts = path.slice(start + marker.length).split("/");
  const name = parts.slice(0, parts[0].startsWith("@") ? 2 : 1).join("/");
  return resolve(path.slice(0, start + marker.length), name);
}

export function recordDependencyBuild(graph, metafile, workingDirectory, outputDirectory) {
  for (const input of Object.keys(metafile.inputs)) {
    if (/\.min\.(?:m?js|cjs)$/iu.test(input)) throw new Error(`minified dependency input is forbidden: ${input}`);
  }
  for (const [output, details] of Object.entries(metafile.outputs)) {
    const packages = new Set();
    for (const input of Object.keys(details.inputs || {})) {
      const directory = packageDirectory(originalInputPath(input, workingDirectory));
      if (directory) { packages.add(directory); graph.packages.add(directory); }
    }
    const path = posix(relative(outputDirectory, resolve(workingDirectory, output)));
    if (!packages.size && path.startsWith("deps/") && !path.endsWith(".map")) {
      packages.add(resolve(NODE_MODULES, "esbuild")); // esbuild's shared CJS interop helper.
      graph.packages.add(resolve(NODE_MODULES, "esbuild"));
    }
    if (packages.size) graph.outputs.set(path, packages);
  }
  for (const output of Object.keys(metafile.outputs)) {
    const path = posix(relative(outputDirectory, resolve(workingDirectory, output)));
    if (path.endsWith(".map") && graph.outputs.has(path.slice(0, -4))) graph.outputs.set(path, graph.outputs.get(path.slice(0, -4)));
  }
}

export async function copyRuntimeAssets(outputDirectory, graph) {
  for (const result of [await buildMcpSdk(), ...await buildStaticEngines()]) {
    for (const file of result.outputFiles) {
      const destination = resolve(outputDirectory, relative(ROOT, file.path));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.contents);
    }
    recordDependencyBuild(graph, result.metafile, ROOT, ROOT);
  }
  const modelsDirectory = resolve(NODE_MODULES, "@opencode-ai/models");
  await mkdir(dirname(resolve(outputDirectory, modelsDevAssetPath)), { recursive: true });
  await writeFile(resolve(outputDirectory, modelsDevAssetPath), modelsDevAsset);
  graph.packages.add(modelsDirectory);
  graph.outputs.set(modelsDevAssetPath, new Set([modelsDirectory]));
  for (const [source, destination] of copies) {
    const origin = resolve(NODE_MODULES, source);
    const target = resolve(outputDirectory, destination);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(origin));
    const directory = packageDirectory(origin);
    graph.packages.add(directory);
    graph.outputs.set(destination, new Set([directory]));
  }
}

/** Attribution follows actual compiler inputs through fixed entries and deferred chunks. */
export async function writeDependencyProvenance(outputDirectory, graph, bundling) {
  const packageBytes = await readFile(resolve(ROOT, "package.json"));
  const lockBytes = await readFile(resolve(ROOT, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  const compiledOutputs = new Map(graph.outputs);
  for (const entry of [...(bundling.entries || []), ...(bundling.chunks || [])]) {
    const packages = new Set(entry.inputs.flatMap(path => [...(compiledOutputs.get(path) || [])]));
    if (packages.size) {
      graph.outputs.set(entry.output, packages);
      graph.outputs.set(`${entry.output}.map`, packages);
    } else {
      graph.outputs.delete(entry.output);
      graph.outputs.delete(`${entry.output}.map`);
    }
  }
  const manifest = { version: 2, esbuild: esbuildVersion, packageSha256: hash(packageBytes), lockSha256: hash(lockBytes),
    staticEngines: { pdfjs: { sources: pdfSourceHashes, transform: "scripts/vendor/pdfjs.mjs" },
      mathjax: { entry: "scripts/vendor/mathjax-entry.mjs", source: "mathjax-full/ts", minify: false },
      zod: { sources: zodSourceHashes, transform: "scripts/vendor/zod.mjs" },
      mcpValidator: "CfWorkerJsonSchemaValidator (interpreted, including the SDK default)" },
    components: {}, assets: {} };
  const keys = new Map();
  for (const directory of [...graph.packages].sort()) {
    const location = posix(relative(ROOT, directory));
    const pinned = lock.packages[location];
    const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    if (!pinned?.integrity || pkg.version !== pinned.version) throw new Error(`unlocked runtime dependency ${pkg.name}`);
    const key = location.replace(/^node_modules\//, "");
    keys.set(directory, key);
    const component = { name: pkg.name, version: pkg.version, license: pkg.license, source: pinned.resolved, integrity: pinned.integrity, licenseFiles: [] };
    manifest.components[key] = component;
    const notices = (await readdir(directory)).filter(name => /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(name)).sort();
    let supplement;
    if (!notices.length) {
      const supplements = JSON.parse(await readFile(resolve(ROOT, "scripts/vendor/licenses/supplements.json"), "utf8"));
      supplement = supplements[pkg.name];
      if (supplement?.version !== pkg.version) throw new Error(`no upstream license for ${pkg.name}`);
      const text = await readFile(resolve(ROOT, "scripts/vendor/licenses", supplement.file));
      if (hash(text) !== supplement.sha256) throw new Error(`upstream license supplement changed for ${pkg.name}`);
      component.licenseSource = supplement.source;
      notices.push(supplement.file);
    }
    for (const name of notices) {
      const destination = `vendor/licenses/${key.replaceAll("/", "--")}/${name}`;
      await mkdir(dirname(resolve(outputDirectory, destination)), { recursive: true });
      await writeFile(resolve(outputDirectory, destination), await readFile(supplement ? resolve(ROOT, "scripts/vendor/licenses", name) : resolve(directory, name)));
      graph.outputs.set(destination, new Set([directory]));
      component.licenseFiles.push(destination);
    }
  }
  for (const [path, dependencies] of [...graph.outputs].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    let bytes;
    try { bytes = await readFile(resolve(outputDirectory, path)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    manifest.assets[path] = { sha256: hash(bytes), bytes: bytes.length, components: [...dependencies].map(directory => keys.get(directory)).sort() };
  }
  await writeFile(resolve(outputDirectory, "vendor/provenance.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function validateAssetPath(path) {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`invalid dependency asset path: ${path}`);
}

async function assetBytes(root, path) {
  validateAssetPath(path);
  let file = root;
  for (const part of path.split("/")) {
    file = resolve(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`dependency symlink is not allowed: ${path}`);
  }
  return readFile(file);
}

async function readProvenance({ extensionDir, lockPath = resolve(ROOT, "package-lock.json"), packagePath = resolve(ROOT, "package.json") }) {
  const manifest = JSON.parse(await readFile(resolve(extensionDir, "vendor/provenance.json"), "utf8"));
  if (manifest.version !== 2) throw new Error("invalid runtime dependency provenance");
  if (manifest.lockSha256 !== hash(await readFile(lockPath))) throw new Error("runtime dependency lock changed");
  if (manifest.packageSha256 !== hash(await readFile(packagePath))) throw new Error("runtime dependency manifest changed");
  return manifest;
}

export async function checkDependencyAssets(options) {
  const manifest = await readProvenance(options);
  for (const [path, asset] of Object.entries(manifest.assets)) {
    const bytes = await assetBytes(options.extensionDir, path);
    if (hash(bytes) !== asset.sha256 || bytes.length !== asset.bytes) throw new Error(`dependency asset changed: ${path}`);
    if (!asset.components.length || asset.components.some(key => !manifest.components[key])) throw new Error(`missing attribution: ${path}`);
  }
  for (const [key, component] of Object.entries(manifest.components)) {
    if (!component.version || !component.license || !component.source?.startsWith("https://") || !component.integrity) throw new Error(`incomplete dependency source: ${key}`);
    if (!component.licenseFiles.length || component.licenseFiles.some(path => !manifest.assets[path])) throw new Error(`missing dependency license: ${key}`);
  }
  async function checkDirectory(path) {
    let entries;
    try { entries = await readdir(resolve(options.extensionDir, path), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const name = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`dependency symlink is not allowed: ${name}`);
      if (entry.isDirectory()) await checkDirectory(name);
      else if (name !== "vendor/provenance.json" && !manifest.assets[name]) throw new Error(`untracked dependency runtime: ${name}`);
    }
  }
  await checkDirectory("vendor");
  await checkDirectory("deps");
  return manifest;
}

/** Runtime distributions and licenses stay immutable; release may detach maps into local debug output. */
export async function refreshDependencyProvenance({ extensionDir, bundling, transform, ...options }) {
  let manifest;
  try { manifest = await readProvenance({ extensionDir, ...options }); }
  catch (error) { if (error.code === "ENOENT" && bundling && error.path === resolve(extensionDir, "vendor/provenance.json")) return null; throw error; }
  const compiledAssets = { ...manifest.assets };
  for (const entry of [...(bundling?.entries || []), ...(bundling?.chunks || [])]) {
    const components = [...new Set(entry.inputs.flatMap(path => compiledAssets[path]?.components || []))].sort();
    if (components.length) {
      manifest.assets[entry.output] = { components };
      if (bundling.debugMaps) manifest.assets[`${entry.output}.map`] = { components };
    } else {
      delete manifest.assets[entry.output];
      delete manifest.assets[`${entry.output}.map`];
    }
  }
  for (const [path, asset] of Object.entries(manifest.assets)) {
    let bytes;
    try { bytes = await assetBytes(extensionDir, path); }
    catch (error) {
      if (error.code === "ENOENT" && (!path.startsWith("vendor/") || path.endsWith(".map"))) { delete manifest.assets[path]; continue; }
      throw error;
    }
    if (path.startsWith("vendor/") || !/\.(?:m?js|map)$/.test(path)) {
      if (asset.sha256 !== hash(bytes) || asset.bytes !== bytes.length) throw new Error(`dependency asset changed: ${path}`);
    } else { asset.sha256 = hash(bytes); asset.bytes = bytes.length; }
  }
  if (transform) manifest.transforms = [...new Set([...(manifest.transforms || []), transform])];
  manifest.assets = Object.fromEntries(Object.entries(manifest.assets).sort(([a], [b]) => a.localeCompare(b, "en")));
  await writeFile(resolve(extensionDir, "vendor/provenance.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return checkDependencyAssets({ extensionDir, ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--refresh") {
    if (args[1] !== "--extension-dir" || !args[2] || args[3] !== "--transform" || !args[4] || args.length !== 5) throw new Error("expected --refresh --extension-dir <path> --transform <compiler@version>");
    await refreshDependencyProvenance({ extensionDir: resolve(args[2]), transform: args[4] });
    console.log("Runtime dependency provenance updated and verified.");
  } else {
    if (args.length !== 1 || args[0] !== "--check") throw new Error("expected --check");
    const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(resolve(ROOT, "package-lock.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies)) {
      const installed = JSON.parse(await readFile(resolve(NODE_MODULES, name, "package.json"), "utf8"));
      if (installed.version !== lock.packages[`node_modules/${name}`]?.version) throw new Error(`installed ${name} differs from the root lock; run npm ci`);
    }
    console.log(`Runtime dependency installation matches the root lock (${Object.keys(pkg.dependencies).length} packages).`);
  }
}

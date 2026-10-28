import { chromePackageError } from "./browser-package.mjs";
import { benchmarkAsset } from "./benchmark-assets.mjs";
import { build } from "esbuild";
import { globSync, mkdtempSync, rmSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let pending;
const capabilityBuilds = new Map();
let exampleAssets;
let pendingExampleAssets;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = join(ROOT, "tests/fixtures/capabilities/example");

/** Reuse the runner's build, or own one isolated build for this process. */
export async function ensureTestExtension({ extensionDir = process.env.QINGZHOU_TEST_EXTENSION_DIR } = {}) {
  if (extensionDir) {
    const directory = resolve(extensionDir);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    if (manifest.manifest_version !== 3) throw new Error(`Invalid test extension: ${directory}`);
    const packageError = chromePackageError(manifest);
    if (packageError) throw new Error(`${packageError} Directory: ${directory}`);
    await prepareExampleAssets();
    return directory;
  }
  if (!pending) {
    const directory = mkdtempSync(join(tmpdir(), "qingzhou-test-build-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    // Serving a supplied build should not load the compiler and its boundary parser.
    pending = import("../../scripts/build-extension.mjs")
      .then(({ buildExtension }) => buildExtension({ outputDir: join(directory, "extension"), mode: "development" }))
      .then(async result => {
        await prepareExampleAssets();
        process.env.QINGZHOU_TEST_EXTENSION_DIR = result.outputDir;
        return result.outputDir;
      })
      .catch(error => { pending = null; throw error; });
  }
  return pending;
}

/** Add one ordinary capability package to an isolated source tree, without host edits. */
export function ensureCapabilityExampleExtension() {
  return ensureCapabilityExtension({ example: true });
}

/** Build package additions/removals from a temporary source copy, never the developer's tree. */
export function ensureCapabilityExtension({ omit = [], example = false } = {}) {
  const omitted = [...new Set(omit)].sort();
  if (omitted.some(name => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error("Invalid capability package name");
  const key = JSON.stringify({ omitted, example });
  if (!capabilityBuilds.has(key)) {
    const directory = mkdtempSync(join(tmpdir(), "qingzhou-capability-variant-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const pendingBuild = (async () => {
      const sourceDir = join(directory, "src");
      await cp(join(ROOT, "src"), sourceDir, { recursive: true });
      for (const name of omitted) await rm(join(sourceDir, "capabilities", name), { recursive: true });
      if (example) await cp(EXAMPLE, join(sourceDir, "capabilities/example"), { recursive: true });
      const { buildExtension } = await import("../../scripts/build-extension.mjs");
      return (await buildExtension({ sourceDir, outputDir: join(directory, "extension"), mode: "development" })).outputDir;
    })().catch(error => { capabilityBuilds.delete(key); throw error; });
    capabilityBuilds.set(key, pendingBuild);
  }
  return capabilityBuilds.get(key);
}

/** Legacy fixture URLs are a test-server overlay; even a release ZIP stays byte-for-byte untouched. */
function prepareExampleAssets() {
  if (!pendingExampleAssets) {
    const directory = mkdtempSync(join(tmpdir(), "qingzhou-example-assets-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    pendingExampleAssets = build({
      absWorkingDir: EXAMPLE, entryPoints: globSync("**/*.ts", { cwd: EXAMPLE }).filter(path => path !== "index.ts" && !path.endsWith(".d.ts")),
      outdir: directory, outbase: EXAMPLE, bundle: true, splitting: true, format: "esm", target: "es2022",
      plugins: [{ name: "example-sdk-ports", setup(builder) {
        builder.onResolve({ filter: /^#sdk\// }, args => ({ path: `/extension/sdk/${args.path.slice("#sdk/".length)}.js`, external: true }));
      } }],
    }).then(() => { exampleAssets = directory; }).catch(error => { pendingExampleAssets = null; throw error; });
  }
  return pendingExampleAssets;
}

/** Keep fixture URLs stable while serving all extension assets from the build. */
export function resolveTestAsset(pathname, { root, extensionDir }) {
  const benchmark = benchmarkAsset(pathname, extensionDir);
  if (benchmark) return benchmark;
  if (exampleAssets && pathname.startsWith("/extension/examples/")) {
    const candidate = resolve(exampleAssets, pathname.slice("/extension/examples/".length));
    return candidate.startsWith(`${exampleAssets}${sep}`) ? candidate : null;
  }
  const extension = pathname === "/extension" || pathname.startsWith("/extension/");
  const base = resolve(extension ? extensionDir : root);
  const relative = extension ? pathname.slice("/extension".length) : pathname;
  const candidate = resolve(base, `.${relative || "/"}`);
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : null;
}

// Python standalone tests own their TemporaryDirectory and invoke this builder.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: extension-build.mjs --output <isolated-directory>");
  const { buildExtension } = await import("../../scripts/build-extension.mjs");
  await buildExtension({ outputDir: resolve(args[1]), mode: "development" });
}

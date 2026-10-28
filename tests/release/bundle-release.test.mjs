import { providers as modelsSnapshot } from "@opencode-ai/models/snapshot";
import { assertPublicReleasePackage } from "./public-package.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { SourceMap } from "node:module";
import { tokenizer } from "acorn";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("release validation accepts current and historical branding and rejects unrelated manifests or unsafe locale resources", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-localized-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('localized_release', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
root = pathlib.Path(sys.argv[2])
source = pathlib.Path(sys.argv[3])
assert module.load_manifest(source) == json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
for locale, name in [('en', 'qz'), ('en', 'Qingzhou'), ('zh_CN', '轻舟'), ('zh_TW', '輕舟'), ('ja', '軽舟')]:
    path = root / '_locales' / locale
    path.mkdir(parents=True, exist_ok=True)
    (path / 'messages.json').write_text(json.dumps({'extensionName': {'message': name}}), encoding='utf-8')
    manifest = {'manifest_version': 3, 'name': '__MSG_extensionName__', 'default_locale': locale}
    (root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    assert module.load_manifest(root) == manifest
for locale in ['missing', '../outside', '']:
    (root / 'manifest.json').write_text(json.dumps({'manifest_version': 3, 'name': '__MSG_extensionName__', 'default_locale': locale}), encoding='utf-8')
    try:
        module.load_manifest(root)
    except SystemExit:
        pass
    else:
        raise AssertionError('Accepted invalid locale: ' + locale)
for name in ['qz', 'Qingzhou', '轻舟 fixture']:
    manifest = {'manifest_version': 3, 'name': name}
    (root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    assert module.load_manifest(root) == manifest
for manifest in [
    {'manifest_version': 3, 'name': 'Another extension', 'description': 'FAQZone'},
    {'manifest_version': 3, 'name': 'QZip'},
    {'manifest_version': 2, 'name': 'qz'},
]:
    (root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    try:
        module.load_manifest(root)
    except SystemExit:
        pass
    else:
        raise AssertionError('Accepted unrelated or unsupported manifest: ' + str(manifest))
`;
  execFileSync("python3", ["-c", program, fileURLToPath(new URL("../../scripts/publish-release.py", import.meta.url)), directory,
    fileURLToPath(new URL("../../src/", import.meta.url))], { stdio: "pipe" });
});

import { checkDependencyAssets } from "../../scripts/vendor/assets.mjs";
import { bundleExtension } from "../../scripts/build-extension-bundles.mjs";
import { buildExtension } from "../../scripts/build-extension.mjs";
import {
  FIREFOX_ADDED_PERMISSIONS,
  FIREFOX_DATA_COLLECTION,
  FIREFOX_DROPPED_PERMISSIONS,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
} from "../../scripts/firefox-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_EXTENSION = join(ROOT, "src");
const RELEASE_NOTICES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];

test("release bundler is deterministic, preserves vendor, and keeps runtime entry contracts", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-bundle-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const first = join(work, "first");
  const second = join(work, "second");
  const sidepanelChanged = join(work, "sidepanel-changed");
  await Promise.all([
    buildExtension({ outputDir: first, mode: "production", bundle: false }),
    buildExtension({ outputDir: second, mode: "production", bundle: false }),
    buildExtension({ outputDir: sidepanelChanged, mode: "production", bundle: false }),
  ]);
  const changedEntry = join(sidepanelChanged, "sidepanel/sidepanel.js");
  await writeFile(changedEntry, `${await readFile(changedEntry, "utf8")}\nconsole.debug("bundle-boundary-probe");\n`);

  const vendorBefore = await treeDigest(join(first, "vendor"));
  const [firstSummary, secondSummary] = await Promise.all([
    bundleExtension({ extensionDir: first, metafilePath: join(work, "first-meta.json") }),
    bundleExtension({ extensionDir: second, metafilePath: join(work, "second-meta.json") }),
  ]);
  await bundleExtension({ extensionDir: sidepanelChanged });

  assert.equal(firstSummary.tool, "esbuild@0.28.1");
  assert.equal(firstSummary.entries.length, 2);
  assert.ok(firstSummary.chunks.length > 0, "Side Panel keeps deferred implementation chunks");
  assert.equal(firstSummary.outputFiles, 2 + firstSummary.chunks.length);
  assert.ok(firstSummary.inputFiles > 100, "the production graph should be bundled, not only the entry shims");
  assert.ok(firstSummary.preservedFiles > 0, "standalone bundles retain offscreen's shared graph");
  assert.equal(firstSummary.removedFiles, firstSummary.inputFiles - 2 - firstSummary.preservedFiles);
  assert.deepEqual(firstSummary, secondSummary);
  assert.equal(await treeDigest(join(first, "vendor")), vendorBefore, "vendor bytes must remain unchanged");
  assert.equal(await treeDigest(join(second, "vendor")), vendorBefore, "vendor bytes must be deterministic");

  const expectedEntries = ["background/service-worker.js", "sidepanel/sidepanel.js"];
  for (const entry of [...expectedEntries, ...firstSummary.chunks.map(item => item.output)]) {
    const firstSource = await readFile(join(first, entry), "utf8");
    const secondSource = await readFile(join(second, entry), "utf8");
    assert.equal(sha256(firstSource), sha256(secondSource), `${entry} must be byte-for-byte deterministic`);
    assertModuleSyntax(firstSource, entry);
  }
  assert.equal(
    await fileDigest(join(first, "background/service-worker.js")),
    await fileDigest(join(sidepanelChanged, "background/service-worker.js")),
    "a side-panel-only change must preserve the independent Background bundle",
  );
  assert.notEqual(
    await fileDigest(join(first, "sidepanel/sidepanel.js")),
    await fileDigest(join(sidepanelChanged, "sidepanel/sidepanel.js")),
    "a side-panel change must invalidate its own bundle",
  );

  await assert.rejects(stat(join(first, "background/agent/agent.js")), { code: "ENOENT" });
  await assert.rejects(stat(join(first, "sidepanel/app.js")), { code: "ENOENT" });
  await assert.rejects(stat(join(first, "shared/data-store.js")), { code: "ENOENT" });
  await assert.doesNotReject(stat(join(first, "shared/mathjax-config.js")));
  await assert.doesNotReject(stat(join(first, "content/content-script.js")));
  await assert.doesNotReject(stat(join(first, "offscreen.js")));
  await assert.doesNotReject(stat(join(first, "runner-sandbox.js")));

  const backgroundSource = await readFile(join(first, "background/service-worker.js"), "utf8");
  const sidepanelSource = await readFile(join(first, "sidepanel/sidepanel.js"), "utf8");
  assert.deepEqual(JSON.parse(await readFile(join(first, "vendor/models-dev/providers.json"), "utf8")), modelsSnapshot);
  assert.ok(!firstSummary.entries.find(entry => entry.name === "background").inputs.some(path => path.endsWith("snapshot.js")));
  assert.ok(!backgroundSource.includes(JSON.stringify(modelsSnapshot.openai)), "model records stay outside the startup script");
  assert.doesNotMatch(backgroundSource, /from ["'][^"']*deps\//);
  assert.match(backgroundSource, /from "\.\.\/vendor\/mcp-sdk\.mjs"/);
  assert.match(backgroundSource, /from "\.\.\/vendor\/pdf\.mjs"/);
  assert.doesNotMatch(sidepanelSource, /from ["'][^"']*(?:partial-json|js-yaml|deps\/)/);
  await assertRuntimeReferencesExist(first);
  await checkDependencyAssets({ extensionDir: first });

  const metadata = JSON.parse(await readFile(join(work, "first-meta.json"), "utf8"));
  assert.equal(metadata.summary.inputFiles, firstSummary.inputFiles);
  assert.equal(JSON.stringify(metadata).includes(work), false, "metafile must not leak staging paths");
});

test("public package audit checks bundled code, paths and resource credentials", async t => {
  const work = await mkdtemp(join(tmpdir(), "qz-package-audit-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const zip = join(work, "fixture.zip");
  const write = (path, source) => execFileSync("python3", ["-c",
    "import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1],'w'); archive.writestr(sys.argv[2],sys.argv[3]); archive.close()",
    zip, `qz-browser-agent-extension/${path}`, source]);
  write("background/service-worker.js", 'const feature = "normal local runtime";');
  assert.doesNotThrow(() => assertPublicReleasePackage(zip));
  for (const [path, source] of [
    ["background/service-worker.js", 'const host = "private.alibaba' + '-inc.com";'],
    ["background/service-worker.js", 'const config = "TELEMETRY_RELEASE_CONFIG";'],
    ["shared/telemetry.js", "export const enabled = false;"],
    ["config.json", JSON.stringify({ apiKey: "fixture".repeat(5) })],
    [".env.local", "MODEL=fixture"],
    ["credentials.json", "{}"],
    ["local-key.pem", "fixture"],
    ["../outside.txt", "fixture"],
    ["notes.txt", '-----BEGIN ' + 'PRIVATE KEY-----'],
  ]) {
    write(path, source);
    assert.throws(() => assertPublicReleasePackage(zip), `${path} must fail the installed-byte audit`);
  }
});

test("release publisher packages bundles and records auditable metadata", async t => {
  const output = await mkdtemp(join(tmpdir(), "qingzhou-release-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const version = "0.0.0.942";

  execFileSync("python3", [
    join(ROOT, "scripts/publish-release.py"),
    "--version", version,
    "--source", "worktree",
    "--output-dir", output,
    "--no-minify",
  ], { cwd: ROOT, stdio: "pipe" });

  const releaseDir = join(output, version);
  const metadata = JSON.parse(await readFile(join(releaseDir, "version.json"), "utf8"));
  assert.equal(metadata.package, `qz-browser-agent-extension-${version}.zip`);
  assert.equal(metadata.packageRoot, "qz-browser-agent-extension");
  assert.equal(metadata.bundling.enabled, true);
  assert.equal(metadata.bundling.entries.length, 2);
  assert.equal(metadata.bundling.outputFiles, 2 + metadata.bundling.chunks.length);
  assert.ok(metadata.bundling.chunks.length > 0);
  assert.ok(metadata.bundling.removedFiles > 100);
  const zipPath = join(releaseDir, `qz-browser-agent-extension-${version}.zip`);
  assertPublicReleasePackage(zipPath);
  const entries = zipEntries(zipPath);
  const runtimeFileCount = entries.filter(path => path.startsWith("qz-browser-agent-extension/") && !path.startsWith("qz-browser-agent-extension/vendor/licenses/")).length;
  assert.ok(runtimeFileCount < 85, `expected compact runtime resources, received ${runtimeFileCount} files excluding bundled dependency licenses`);
  assert.ok(entries.includes("qz-browser-agent-extension/background/service-worker.js"));
  assert.ok(entries.includes("qz-browser-agent-extension/sidepanel/sidepanel.js"));
  for (const chunk of metadata.bundling.chunks) assert.ok(entries.includes(`qz-browser-agent-extension/${chunk.output}`));
  assert.ok(entries.includes("qz-browser-agent-extension/vendor/pdf.mjs"));
  assert.ok(entries.includes("version.json"));
  assert.equal(entries.includes("qz-browser-agent-extension/background/agent/agent.js"), false);
  assert.equal(entries.includes("qz-browser-agent-extension/sidepanel/app.js"), false);
  assert.equal(entries.some(path => path.endsWith("/README.md")), false);
  for (const name of RELEASE_NOTICES) {
    assert.deepEqual(zipBytes(zipPath, `qz-browser-agent-extension/${name}`), await readFile(join(ROOT, name)));
  }

  const provenance = zipJson(zipPath, "qz-browser-agent-extension/vendor/provenance.json");
  for (const [path, asset] of Object.entries(provenance.assets)) {
    assert.equal(sha256(zipBytes(zipPath, `qz-browser-agent-extension/${path}`)), asset.sha256, `packaged dependency hash: ${path}`);
  }
  const innerMetadata = zipJson(zipPath, "version.json");
  assert.equal(innerMetadata.packageRoot, metadata.packageRoot);
  assert.equal(innerMetadata.bundling.tool, "esbuild@0.28.1");
  assert.equal(innerMetadata.fileCount, metadata.fileCount);
  const attributes = JSON.parse(execFileSync("python3", [
    "-c", "import json,sys,zipfile; print(json.dumps([[e.filename,e.date_time,e.external_attr>>16] for e in zipfile.ZipFile(sys.argv[1]).infolist()]))", zipPath,
  ], { encoding: "utf8" }));
  assert.deepEqual(attributes.map(entry => entry[0]), attributes.map(entry => entry[0]).sort());
  for (const [path, date, mode] of attributes) {
    assert.deepEqual(date, [1980, 1, 1, 0, 0, 0], path);
    assert.equal(mode, 0o100644, path);
  }
  execFileSync("python3", [
    join(ROOT, "scripts/publish-release.py"), "--version", version, "--source", "worktree",
    "--output-dir", output, "--no-minify",
  ], { cwd: ROOT, stdio: "pipe" });
  assert.equal(await fileDigest(zipPath), metadata.sha256, "full release ZIP must be reproducible");
});

test("publisher compiles TS even when bundling is disabled and requires locked Terser", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-compile-release-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, "source");
  await cp(SOURCE_EXTENSION, source, { recursive: true });
  await writeFile(join(source, "shared/release-typescript-probe.ts"), "export const releaseProbe: number = 42;\n");
  const args = [join(ROOT, "scripts/publish-release.py"), "--version", "0.0.0.943", "--source", "worktree",
    "--extension-dir", source, "--output-dir", work, "--no-bundle"];
  execFileSync("python3", [...args, "--no-minify"], { cwd: ROOT, stdio: "pipe" });
  const zipPath = join(work, "0.0.0.943/qz-browser-agent-extension-0.0.0.943.zip");
  const entries = zipEntries(zipPath);
  assert.ok(entries.includes("qz-browser-agent-extension/shared/release-typescript-probe.js"));
  assert.equal(entries.some(path => path.endsWith(".map") || (!path.includes("/vendor/") && path.endsWith(".ts"))), false);
  const mismatch = spawnSync("python3", [...args, "--terser-version", "0.0.0"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Terser must match package-lock.json/);
  await writeFile(join(work, "outside.js"), "globalThis.externalSource = true;");
  await symlink(join(work, "outside.js"), join(source, "shared/external-source.js"));
  const unsafe = spawnSync("python3", [...args, "--no-minify"], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /must not be symlinks/);
});

test("release debug maps trace minified bundles from Unicode and spaced checkouts", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-debug-release-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const repo = join(work, "checkout 开发 100% #");
  const source = join(repo, "src");
  await cp(SOURCE_EXTENSION, source, { recursive: true });
  for (const path of ["scripts", "config", "package.json", "package-lock.json", "tsconfig.json", ...RELEASE_NOTICES]) {
    await cp(join(ROOT, path), join(repo, path), { recursive: true });
  }
  // An independent dependency tree also exercises upstream maps resolved inside the checkout.
  execFileSync("npm", ["ci", "--offline", "--no-audit", "--no-fund"], {
    cwd: repo, stdio: "pipe", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "" },
  });
  const sourcePath = "background/service-worker.ts";
  const original = await readFile(join(source, sourcePath), "utf8");
  const probe = 'globalThis.__releaseMapProbe = function (): never { throw new Error("release-map-probe"); };\n';
  await writeFile(join(source, sourcePath), `${original}\n${probe}`);
  const sourceLine = original.split("\n").length + 1;
  const version = "0.0.0.946";
  execFileSync("python3", [join(repo, "scripts/publish-release.py"), "--version", version,
    "--source", "worktree", "--extension-dir", source, "--output-dir", work,
  ], { cwd: repo, stdio: "pipe", timeout: 120_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const zip = join(work, version, `qz-browser-agent-extension-${version}.zip`);
  const debug = join(work, version, `qz-browser-agent-extension-${version}.debug.zip`);
  const metadata = zipJson(debug, "manifest.json");
  assert.equal(metadata.localOnly, true);
  assert.equal(metadata.source, "worktree");
  assert.equal(metadata.gitCommit, "");
  assert.equal(metadata.package.sha256, await fileDigest(zip));
  const installed = zipEntries(zip);
  for (const name of RELEASE_NOTICES) {
    assert.deepEqual(zipBytes(zip, `qz-browser-agent-extension/${name}`), await readFile(join(repo, name)));
  }
  assert.equal(installed.some(path => path.endsWith(".map")), false);
  for (const [asset, upstream] of [
    ["vendor/pdf.mjs", "pdfjs-dist/legacy/build/pdf.mjs"],
    ["vendor/pdf.worker.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"],
    ["vendor/tabulator/tabulator.min.css", "tabulator-tables/dist/css/tabulator.min.css"],
  ]) {
    assert.deepEqual(zipBytes(zip, `qz-browser-agent-extension/${asset}`), await readFile(join(ROOT, "node_modules", upstream)));
    assert.deepEqual(zipBytes(debug, `maps/${asset}.map`), await readFile(join(ROOT, "node_modules", `${upstream}.map`)));
  }
  const provenance = zipJson(zip, "qz-browser-agent-extension/vendor/provenance.json");
  assert.equal(Object.keys(provenance.assets).some(path => path.endsWith(".map")), false);
  assert.equal(installed.some(path => /qingzhou-(?:debug|build)/.test(path)), false);
  const runtime = "background/service-worker.js";
  const readZip = (path, entry) => execFileSync("python3", ["-c",
    "import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", path, entry], { maxBuffer: 32 * 1024 * 1024 });
  const generated = readZip(zip, `qz-browser-agent-extension/${runtime}`).toString();
  assert.doesNotMatch(generated, /sourceMappingURL/);
  const index = generated.indexOf('"release-map-probe"');
  assert.ok(index >= 0);
  const before = generated.slice(0, index).split("\n");
  const map = zipJson(debug, `maps/${runtime}.map`);
  const entry = new SourceMap(map).findEntry(before.length - 1, before.at(-1).length);
  assert.equal(entry.originalSource, `qingzhou://extension/${sourcePath}`);
  assert.equal(entry.originalLine + 1, sourceLine, "Terser and bundle maps must retain the original TS line");
  assert.ok(map.sourcesContent.some(contents => contents?.includes(probe.trim())));
  const build = zipJson(debug, "build.json");
  const worker = build.embeddedDebugScripts.find(script => script.entry === "workers/inner-runner.ts");
  const workerCode = readZip(debug, `debug/${worker.artifact.replace(/^\.qingzhou-debug\//, "")}`).toString();
  const sandbox = readZip(zip, "qz-browser-agent-extension/runner-sandbox.js").toString();
  const strings = [...tokenizer(sandbox, { ecmaVersion: "latest", sourceType: "module" })]
    .filter(token => token.type.label === "string").map(token => token.value);
  assert.ok(strings.includes(workerCode), "embedded debug source must remain byte-for-byte identical to the running Worker");
  for (const file of metadata.files) {
    const bytes = readZip(debug, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    assert.equal(bytes.includes(Buffer.from(work)), false, "debug files must not leak staging paths");
    if (file.runtimePath) {
      assert.equal(sha256(readZip(zip, `qz-browser-agent-extension/${file.runtimePath}`)), file.runtimeSha256);
    }
  }
});

test("release packaging is local and keeps debug files outside the install archive", () => {
  execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,sys,tempfile,zipfile
path=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('release_local_fixture',path)
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary).resolve();module.REPO_DIR=root
    for name in ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']:
        (root/name).write_text('Synthetic distribution notice: '+name)
    extension=root/'src';extension.mkdir()
    (extension/'manifest.json').write_text(json.dumps({'manifest_version':3,'name':'qz fixture','version':'0.0.0.1','key':'fixture-public-key'}))
    (extension/'fixture.js').write_text('console.log(42);')
    (extension/'fixture.js.map').write_text('{}')
    scripts=root/'scripts';scripts.mkdir()
    (scripts/'check-no-remote-code.mjs').write_bytes(path.with_name('check-no-remote-code.mjs').read_bytes())
    module.compile_extension_sources=lambda source,**kwargs:(source,{'enabled':False})
    module.refresh_dependency_provenance=lambda *args:None
    original_run=module.subprocess.run
    def local_read(command,**kwargs):
        script=command[1] if len(command)>1 else ''
        assert command==['git','rev-parse','--is-inside-work-tree'] or str(script).endswith('check-no-remote-code.mjs'), command
        return original_run(command,**kwargs)
    module.subprocess.run=local_read
    sys.argv=[str(path),'--version','0.0.0.1','--prepared-package-source',str(root),'--prepared-commit','a'*40,
              '--origin-repo',str(root/'origin'),'--output-dir',str(root/'output'),'--no-minify']
    assert module.main()==0
    output=root/'output/0.0.0.1'
    assert sorted(item.name for item in output.iterdir())==[
        'README.md','qz-browser-agent-extension-0.0.0.1.debug.zip','qz-browser-agent-extension-0.0.0.1.zip','version.json']
    with zipfile.ZipFile(output/'qz-browser-agent-extension-0.0.0.1.zip') as archive:
        assert not any(name.endswith(('.map','.debug.zip')) for name in archive.namelist())
    with zipfile.ZipFile(output/'qz-browser-agent-extension-0.0.0.1.debug.zip') as archive:
        assert 'maps/fixture.js.map' in archive.namelist()
    metadata=json.loads((output/'version.json').read_text())
    assert metadata['gitCommit']=='a'*40
    assert metadata['target']=='manual'
    assert metadata['minification']['enabled'] is False
    assert metadata['sha256']==module.sha256_file(output/'qz-browser-agent-extension-0.0.0.1.zip')
    manual_sha=metadata['sha256']
    (extension/'fixture.js.map').write_text('{}')
    sys.argv.extend(['--target','webstore'])
    assert module.main()==0
    store=output/'webstore'
    metadata=json.loads((store/'version.json').read_text())
    assert metadata['target']=='webstore' and metadata['packageRoot']=='.'
    archive_path=store/metadata['package']
    assert metadata['sha256']==module.sha256_file(archive_path)
    with zipfile.ZipFile(output/'qz-browser-agent-extension-0.0.0.1.zip') as archive:
        manual={name.removeprefix('qz-browser-agent-extension/'):archive.read(name)
                for name in archive.namelist() if name!='version.json'}
    with zipfile.ZipFile(archive_path) as archive:
        store_files={name:archive.read(name) for name in archive.namelist()}
        manual_manifest=json.loads(manual.pop('manifest.json'))
        store_manifest=json.loads(store_files.pop('manifest.json'))
        assert manual_manifest.pop('key')=='fixture-public-key'
        assert store_manifest==manual_manifest
        assert store_files==manual
        assert sum(info.file_size for info in archive.infolist())==metadata['uncompressedSize']
        assert 'manifest.json' in archive.namelist() and 'version.json' not in archive.namelist()
    with zipfile.ZipFile(store/'qz-browser-agent-extension-0.0.0.1.webstore.debug.zip') as archive:
        assert 'maps/fixture.js.map' in archive.namelist()
        assert json.loads(archive.read('manifest.json'))['package']['sha256']==metadata['sha256']
    assert module.sha256_file(output/'qz-browser-agent-extension-0.0.0.1.zip')==manual_sha
    assert module.main()==0
    assert module.sha256_file(archive_path)==metadata['sha256'], 'Web Store ZIP must be reproducible'
    manifest=json.loads((extension/'manifest.json').read_text())
    manifest['background']={'service_worker':'missing.js'}
    (extension/'manifest.json').write_text(json.dumps(manifest))
    sys.argv.extend(['--output-dir',str(root/'invalid-output')])
    try: module.main()
    except ValueError as error: assert 'missing.js' in str(error)
    else: raise AssertionError('Missing runtime resource was accepted')
    assert not list((root/'invalid-output').rglob('*.zip'))
    assert not list((root/'invalid-output').rglob('version.json'))
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});

test("Web Store archive validation rejects invalid layouts, missing assets and development files", () => {
  execFileSync("python3", ["-c", String.raw`
import importlib.util,json,pathlib,sys,tempfile,zipfile,warnings
spec=importlib.util.spec_from_file_location('webstore_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
manifest={'manifest_version':3,'version':'0.1.0','default_locale':'en',
    'background':{'service_worker':'worker.js'},'side_panel':{'default_path':'panel.html'},
    'icons':{'128':'icon.png'},'action':{'default_icon':'icon.png'},'sandbox':{'pages':['sandbox.html']},
    'content_scripts':[{'js':['content.js'],'css':['content.css']}],
    'declarative_net_request':{'rule_resources':[{'path':'rules.json'}]}}
files={name:b'fixture' for name in ['worker.js','panel.html','icon.png','sandbox.html','content.js','content.css',
    'rules.json','_locales/en/messages.json',*module.RELEASE_NOTICES]}
files['manifest.json']=json.dumps(manifest).encode()
with tempfile.TemporaryDirectory() as temporary:
    path=pathlib.Path(temporary)/'upload.zip'
    def check(entries,valid=False):
        with zipfile.ZipFile(path,'w') as archive:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                for name,data in entries: archive.writestr(name,data)
        try: module.validate_webstore_package(path)
        except ValueError:
            if valid: raise
        else: assert valid, 'Invalid archive was accepted'
    check(files.items(),True)
    check([('qz-browser-agent-extension/'+name,data) for name,data in files.items()])
    for missing in files:
        check([(name,data) for name,data in files.items() if name!=missing])
    for name in ['products/manifest.json','nested/extension/manifest.json',
                 'worker.js.map','.qingzhou-debug/worker.js','.qingzhou-build.json','.env.local',
                 '../outside','/absolute','C:/drive','folder\\worker.js','worker.js']:
        check([*files.items(),(name,b'fixture')])
    for invalid in [[],{'manifest_version':2},{**manifest,'key':'fixture-public-key'},{**manifest,'key':''},
                    {'manifest_version':3,'version':'v0.1.0'},
                    {'manifest_version':3,'version':'0.0.0'}]:
        check({**files,'manifest.json':json.dumps(invalid).encode()}.items())
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});

test("Firefox archive validation requires a root manifest and keeps gecko settings", () => {
  execFileSync("python3", ["-c", String.raw`
import importlib.util,json,pathlib,sys,tempfile,zipfile
spec=importlib.util.spec_from_file_location('firefox_archive_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
manual=module.release_paths(pathlib.Path('releases'),'1.2.3')
assert manual.package.as_posix()=='releases/1.2.3/qz-browser-agent-extension-1.2.3.zip'
assert manual.debug.as_posix()=='releases/1.2.3/qz-browser-agent-extension-1.2.3.debug.zip'
store=module.release_paths(pathlib.Path('releases'),'1.2.3','webstore')
assert store.package.as_posix()=='releases/1.2.3/webstore/qz-browser-agent-extension-1.2.3.webstore.zip'
assert store.debug.name=='qz-browser-agent-extension-1.2.3.webstore.debug.zip'
firefox=module.release_paths(pathlib.Path('releases'),'1.2.3','firefox')
assert firefox.package.as_posix()=='releases/1.2.3/firefox/qz-browser-agent-firefox-1.2.3.xpi'
assert firefox.debug.as_posix()=='releases/1.2.3/firefox/qz-browser-agent-firefox-1.2.3.debug.zip'
assert module.archive_uses_root_manifest('manual') is False
assert module.archive_uses_root_manifest('webstore') is True
assert module.archive_uses_root_manifest('firefox') is True
manifest={'manifest_version':3,'version':'0.1.0','name':'qz',
    'permissions':['storage',*module.FIREFOX_KEPT_PERMISSIONS],
    'background':{'scripts':['background/firefox-boot.js'],'type':'module'},
    'browser_specific_settings':{'gecko':{
        'id':module.FIREFOX_GECKO_ID,'strict_min_version':'154.0',
        'data_collection_permissions':{'required':list(module.FIREFOX_DATA_COLLECTION_REQUIRED),
            'optional':['locationInfo','bookmarksInfo']}}}}
files={'manifest.json':json.dumps(manifest).encode(),'background/firefox-boot.js':b'fixture',
    **{name:b'notice' for name in module.RELEASE_NOTICES}}
with tempfile.TemporaryDirectory() as temporary:
    path=pathlib.Path(temporary)/'qz-browser-agent-firefox-0.1.0.xpi'
    def write(entries):
        path.unlink(missing_ok=True)
        with zipfile.ZipFile(path,'w') as archive:
            for name,data in entries: module.write_zip_entry(archive,name,data)
    def check(entries,valid=False):
        write(entries)
        try: module.validate_firefox_package(path)
        except ValueError:
            if valid: raise
        else: assert valid, 'Invalid Firefox archive was accepted'
    check(files.items(),True)
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist().count('manifest.json')==1
        assert 'version.json' not in archive.namelist()
        assert all(not name.startswith('META-INF/') for name in archive.namelist())
    check([('firefox/'+name,data) for name,data in files.items()])
    check([*files.items(),('META-INF/mozilla.sf',b'signature')])
    check([*files.items(),('META-INF/manifest.mf',b'signature')])
    check([*files.items(),('background/firefox-boot.js.map',b'{}')])
    check([*files.items(),('src/background/firefox-boot.ts',b'export {}')])
    missing_permission=json.loads(files['manifest.json'])
    missing_permission['permissions']=[item for item in missing_permission['permissions'] if item!='webRequestBlocking']
    check([(name, json.dumps(missing_permission).encode() if name=='manifest.json' else data) for name,data in files.items()])
    with_key=json.loads(files['manifest.json']); with_key['key']='fixture-public-key'
    check([(name, json.dumps(with_key).encode() if name=='manifest.json' else data) for name,data in files.items()])
    stripped=json.loads(files['manifest.json']); del stripped['browser_specific_settings']
    check([(name, json.dumps(stripped).encode() if name=='manifest.json' else data) for name,data in files.items()])
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});

test("firefox release target writes an unsigned root-manifest xpi", async t => {
  const output = await mkdtemp(join(tmpdir(), "qingzhou-firefox-release-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const version = "0.0.0.947";
  const args = [
    join(ROOT, "scripts/publish-release.py"),
    "--version", version,
    "--target", "firefox",
    "--source", "worktree",
    "--output-dir", output,
    "--no-minify",
  ];
  execFileSync("python3", args, { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
  const releaseDir = join(output, version, "firefox");
  const xpi = join(releaseDir, `qz-browser-agent-firefox-${version}.xpi`);
  const metadata = JSON.parse(await readFile(join(releaseDir, "version.json"), "utf8"));
  assert.equal(metadata.browser, "firefox");
  assert.equal(metadata.geckoId, FIREFOX_GECKO_ID);
  assert.equal(metadata.target, "firefox");
  assert.equal(metadata.packageRoot, ".");
  assert.equal(metadata.package, `qz-browser-agent-firefox-${version}.xpi`);
  assert.deepEqual(await readdir(join(output, version)), ["firefox"]);
  const entries = zipEntries(xpi);
  assert.equal(entries.includes("manifest.json"), true);
  assert.equal(entries.includes("version.json"), false);
  assert.equal(entries.some(name => name.endsWith("/manifest.json") || name.startsWith("META-INF/") || name.split("/").includes(".git")), false);
  assert.equal(entries.some(name => name.endsWith(".map") || name.endsWith(".ts")), false);
  const manifest = zipJson(xpi, "manifest.json");
  assert.equal(manifest.version, version);
  assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_GECKO_ID);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, FIREFOX_MIN_VERSION);
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, [...FIREFOX_DATA_COLLECTION.required]);
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.optional, [...FIREFOX_DATA_COLLECTION.optional]);
  for (const permission of FIREFOX_ADDED_PERMISSIONS) {
    assert.equal(manifest.permissions.includes(permission), true, permission);
  }
  for (const permission of FIREFOX_DROPPED_PERMISSIONS) {
    assert.equal(manifest.permissions.includes(permission), false, permission);
  }
  assert.equal(manifest.permissions.includes("storage"), true);
  assert.equal(Object.hasOwn(manifest, "key"), false);
  assert.equal(Object.hasOwn(manifest, "side_panel"), false);
  assert.deepEqual(manifest.background.scripts, ["background/firefox-boot.js"]);
  assert.equal(entries.includes("background/firefox-boot.js"), true);
  assert.equal(entries.includes(manifest.sidebar_action.default_panel), true);
  assert.equal(entries.includes(manifest.sidebar_action.default_icon), true);
  const debug = join(releaseDir, `qz-browser-agent-firefox-${version}.debug.zip`);
  const debugMetadata = zipJson(debug, "manifest.json");
  assert.equal(debugMetadata.localOnly, true);
  assert.equal(debugMetadata.package.name, metadata.package);
  assert.equal(debugMetadata.package.sha256, metadata.sha256);
  assertPublicReleasePackage(xpi);
  execFileSync("python3", args, { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
  assert.equal(await fileDigest(xpi), metadata.sha256, "Firefox XPI must be reproducible");
});

test("release versions reject invalid manifest values and output path traversal before building", () => {
  execFileSync("python3", ["-c", `
import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('release_version_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
for value in ['1','0.7.1','65535.65535.65535.65535','v1.2.3']:
    assert module.normalize_version(value)==value.lstrip('v')
for value in ['', '0', '0.0.0.0', '../outside', '/tmp/package', '1/../../outside', '1.2.3.4.5', '01.2', '-1', '65536', '1.0-beta']:
    try: module.normalize_version(value)
    except SystemExit: pass
    else: raise AssertionError('Accepted invalid version: '+value)
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});

test("Git packaging rejects the legacy publisher protocol before deployment", () => {
  execFileSync("python3", ["-c", `
import argparse,importlib.util,pathlib,subprocess,sys,tempfile
spec=importlib.util.spec_from_file_location('release_protocol_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    root=pathlib.Path(temporary);deployed=root/'deployment-marker'
    def export(commit,snapshot):
        script=snapshot/'scripts/publish-release.py';script.parent.mkdir()
        script.write_text("import argparse,pathlib\\nparser=argparse.ArgumentParser()\\n"
            +"for name in ['--version','--output-dir','--prepared-source','--prepared-commit','--origin-repo']: parser.add_argument(name)\\n"
            +"parser.parse_args()\\npathlib.Path("+repr(str(deployed))+").touch()\\n")
    module.export_release_from_git=export
    module.resolve_git_commit=lambda ref:'a'*40
    module.shutil.which=lambda name:'fixture-npm'
    original_run=module.subprocess.run
    def run(command,**kwargs):
        if command[0]=='fixture-npm': return subprocess.CompletedProcess(command,0,stdout='',stderr='')
        return original_run(command,**kwargs)
    module.subprocess.run=run
    sys.argv=['publish-release.py','--version','1.0.0']
    args=argparse.Namespace(git_ref='HEAD',output_dir=root/'output')
    assert module.run_commit_publisher(args)==2
    assert not deployed.exists()
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});

test("publisher rejects each missing or linked distribution notice before compiling or rewriting source", () => {
  execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,sys,tempfile
path=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('release_notices_fixture',path)
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
def unexpected_compile(*args,**kwargs):
    raise AssertionError('Compilation began without complete distribution notices')
module.compile_extension_sources=unexpected_compile
for missing in ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']:
    for linked in [False,True]:
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary).resolve();module.REPO_DIR=root
            source=root/'src';source.mkdir()
            original=json.dumps({'manifest_version':3,'name':'qz','version':'0.0.0.1'})
            manifest=source/'manifest.json';manifest.write_text(original)
            for name in ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']:
                if name!=missing: (root/name).write_text('Synthetic notice: '+name)
            if linked:
                target=root/'unrelated.txt';target.write_text('Unrelated notice')
                (root/missing).symlink_to(target)
            sys.argv=[str(path),'--version','0.0.0.2','--prepared-package-source',str(root),
                      '--prepared-commit','a'*40,'--origin-repo',str(root/'origin'),'--output-dir',str(root/'output')]
            try: module.main()
            except SystemExit as error: assert str(error)=='release source lacks regular file '+missing
            else: raise AssertionError('Incomplete notices were accepted')
            assert manifest.read_text()==original
            assert not (root/'output').exists()
`, join(ROOT, "scripts/publish-release.py")], { stdio: "pipe" });
});



test("private publisher re-entry cannot mutate a Git working tree or a directory inside it", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-release-prepared-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", work]);
  for (const repo of [work, join(work, "nested-export")]) {
    await mkdir(join(repo, "scripts"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    const publisher = join(repo, "scripts/publish-release.py");
    const manifest = join(repo, "src/manifest.json");
    const original = '{"manifest_version":3,"version":"0.0.0.1"}\n';
    await cp(join(ROOT, "scripts/publish-release.py"), publisher);
    await writeFile(manifest, original);
    const rejected = spawnSync("python3", [publisher, "--version", "0.0.0.945",
      "--prepared-package-source", repo, "--prepared-commit", "a".repeat(40), "--origin-repo", join(work, "other"),
      "--no-minify"], { cwd: repo, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /prepared release source must be an isolated export/);
    assert.equal(await readFile(manifest, "utf8"), original, "re-entry must reject before rewriting source files");
  }
});

test("Git releases execute the source, publisher, build scripts, lockfile and notices from the same commit", async t => {
  const work = await mkdtemp(join(tmpdir(), "qingzhou-release-provenance-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const repo = join(work, "repo");
  await cp(SOURCE_EXTENSION, join(repo, "src"), { recursive: true });
  await cp(join(ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
  await cp(join(ROOT, "config"), join(repo, "config"), { recursive: true });
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", ...RELEASE_NOTICES]) {
    await cp(join(ROOT, path), join(repo, path));
  }
  const committedNotices = new Map(await Promise.all(RELEASE_NOTICES.map(async name => [name, await readFile(join(repo, name))])));
  await writeFile(join(repo, ".gitignore"), "node_modules/\n__pycache__/\n");
  await writeFile(join(repo, "src/icons/release-provenance.txt"), "committed source");
  const publisherPath = join(repo, "scripts/publish-release.py");
  const publisher = await readFile(publisherPath, "utf8");
  await writeFile(publisherPath, publisher.replace('final_title = title.strip()', 'final_title = "committed publisher" or title.strip()'));
  const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "isolated release provenance fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  for (const name of RELEASE_NOTICES) await writeFile(join(repo, name), `uncommitted notice: ${name}`);
  await writeFile(join(repo, "src/icons/release-provenance.txt"), "working tree source");
  await writeFile(publisherPath, publisher.replace('final_title = title.strip()', 'final_title = "working tree publisher" or title.strip()'));
  await writeFile(join(repo, "scripts/build-extension.mjs"), 'throw new Error("working tree builder must not execute");\n');
  await writeFile(join(repo, "package.json"), '{"devDependencies":{"esbuild":"0.0.0"}}');
  const version = "0.0.0.944";
  execFileSync("python3", [publisherPath, "--version", version, "--output-dir", join(work, "output"),
    "--no-minify"], {
    cwd: repo, stdio: "pipe", timeout: 120_000,
    // The exported commit owns its Node toolchain. Host test preloads refer to another
    // node_modules tree and must not enter esbuild's workers; keep coverage inherited.
    env: { ...process.env, NODE_OPTIONS: "", npm_config_offline: "true" },
  });
  const metadata = JSON.parse(await readFile(join(work, `output/${version}/version.json`), "utf8"));
  assert.equal(metadata.gitCommit, commit);
  assert.equal(metadata.source, "git");
  const debugMetadata = zipJson(join(work, `output/${version}/qz-browser-agent-extension-${version}.debug.zip`), "manifest.json");
  assert.equal(debugMetadata.gitCommit, commit);
  assert.equal(debugMetadata.package.sha256, metadata.sha256);
  assert.match(await readFile(join(work, `output/${version}/README.md`), "utf8"), /committed publisher/);
  const zipPath = join(work, `output/${version}/qz-browser-agent-extension-${version}.zip`);
  for (const [name, contents] of committedNotices) {
    assert.deepEqual(zipBytes(zipPath, `qz-browser-agent-extension/${name}`), contents, `notice must come from the release commit: ${name}`);
  }
  const source = execFileSync("python3", ["-c", "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())", zipPath,
    "qz-browser-agent-extension/icons/release-provenance.txt"], { encoding: "utf8" });
  assert.equal(source.trim(), "committed source");
  assert.equal(git(["tag", "--list"]), "", "dry run must never tag the fixture repository");
  git(["rm", "-f", "LICENSE"]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture without distribution license"]);
  await writeFile(join(repo, "LICENSE"), "working tree license must not fill a missing committed license");
  const missingNotice = spawnSync("python3", [publisherPath, "--version", version, "--output-dir", join(work, "missing-notice")], { cwd: repo, encoding: "utf8" });
  assert.notEqual(missingNotice.status, 0);
  assert.match(missingNotice.stderr, /release commit lacks LICENSE/);
  await assert.rejects(stat(join(work, "missing-notice")), { code: "ENOENT" });
  git(["rm", "-f", "scripts/build-extension.mjs"]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture without unified builder"]);
  const rejected = spawnSync("python3", [publisherPath, "--version", version, "--output-dir", join(work, "rejected")], { cwd: repo, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /release commit lacks scripts\/build-extension.mjs/);
});

test("release bundler refuses to mutate the development source tree", async () => {
  await assert.rejects(
    bundleExtension({ extensionDir: SOURCE_EXTENSION }),
    /refusing to bundle the source extension in place/,
  );
});

async function assertRuntimeReferencesExist(extensionDir) {
  const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
  const referenced = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap(item => item.js || []),
    ...manifest.sandbox.pages,
  ];
  for (const path of referenced) await assert.doesNotReject(stat(join(extensionDir, path)), path);

  const sidepanelPath = join(extensionDir, manifest.side_panel.default_path);
  const sidepanelHtml = await readFile(sidepanelPath, "utf8");
  const scriptSources = [...sidepanelHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map(match => match[1])
    .filter(path => !/^[a-z]+:/i.test(path));
  for (const path of scriptSources) {
    await assert.doesNotReject(stat(resolve(dirname(sidepanelPath), path)), `missing sidepanel script ${path}`);
  }
}

function assertModuleSyntax(source, label) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${label} syntax failed: ${result.stderr}`);
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  for (const path of await listFiles(root)) {
    if (relative(root, path) === "provenance.json") continue; // Records the transformed runtime graph.
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(path) {
  return sha256(await readFile(path));
}

function zipEntries(zipPath) {
  return JSON.parse(execFileSync("python3", [
    "-c",
    "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
    zipPath,
  ], { encoding: "utf8" }));
}

function zipBytes(zipPath, entry) {
  return execFileSync("python3", ["-c", "import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", zipPath, entry],
    { maxBuffer: 32 * 1024 * 1024 });
}

function zipJson(zipPath, entry) {
  return JSON.parse(execFileSync("python3", [
    "-c",
    "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode('utf-8'))",
    zipPath,
    entry,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

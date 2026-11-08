import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'qz-dsh-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check with npm run check:package.');

function run(args, cwd = root) {
  const child = spawnSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return child.stdout;
}

try {
  const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', directory]));
  const files = new Set(packed.files.map(file => file.path));
  for (const name of ['src/index.mjs', 'src/cli.mjs', 'dist/client.js', 'cordis.patch.yml',
    'src/logo-day.png', 'locale/en.json', 'locale/zh.json', 'README.md', 'README.zh-CN.md', 'LICENSE']) {
    assert.ok(files.has(name), `Missing package entry: ${name}`);
  }
  assert.ok([...files].every(name => !/(?:^|\/)(?:node_modules|test|\.env)(?:\/|$)/.test(name)));

  const install = join(directory, 'install');
  await mkdir(install);
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    '--registry=https://registry.npmjs.org/', join(directory, packed.filename)], install);
  const packageDir = join(install, 'node_modules', 'dsh-browser-qz');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(!manifest.scripts?.install && !manifest.scripts?.postinstall);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const plugin = await import("dsh-browser-qz"); if (typeof plugin.apply !== "function") process.exit(1);'],
  { cwd: install, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(imported.error);
  assert.equal(imported.status, 0, imported.stderr);

  let client;
  runInNewContext(await readFile(join(packageDir, 'dist/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { client = module; } } },
  }, { timeout: 1000 });
  assert.equal(client.id, manifest.name);
  assert.equal(typeof client.factory, 'function');

  await mkdir(join(root, 'dist'), { recursive: true });
  await copyFile(join(directory, packed.filename), join(root, 'dist', packed.filename));
  console.log(JSON.stringify({ ok: true, package: packed.filename, files: files.size,
    packedBytes: packed.size, installedHost: true, clientLoader: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}

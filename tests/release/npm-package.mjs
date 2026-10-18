import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const { values: options, tokens } = parseArgs({ options: {
  tarball: { type: "string" }, output: { type: "string" }, help: { type: "boolean" },
}, tokens: true });
assert.equal(new Set(tokens.map(token => token.name)).size, tokens.length, "Options may only be supplied once.");
if (options.help) {
  console.log("Usage: node tests/release/npm-package.mjs [--tarball package.tgz] [--output verified-package.tgz]\n"
    + "Pack and install the npm package, then verify its CLI and MCP lifecycle outside the repository.\n"
    + "--tarball tests an existing artifact; --output keeps the exact verified artifact (never overwrites).\n"
    + "Requires npm and public registry access; uses no npm credentials or install scripts.");
  process.exit(0);
}
for (const key of ["tarball", "output"]) if (options[key] !== undefined) {
  assert.ok(options[key], `--${key} requires a nonempty path.`);
  options[key] = resolve(options[key]);
}
assert.ok(Number(process.versions.node.split(".")[0]) >= 22, "The npm package smoke test requires Node.js 22 or newer.");

// Invoke npm's JavaScript entry with this Node version on Windows, macOS and Linux.
// No shell-specific executable lookup is needed.
async function npmEntry() {
  const candidates = [process.env.npm_execpath];
  for (const directory of (process.env.PATH || process.env.Path || "").split(delimiter)) {
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"));
    const executable = await realpath(join(directory, "npm")).catch(() => "");
    if (executable.endsWith("npm-cli.js")) candidates.push(executable);
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.endsWith("npm-cli.js") && await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error("npm was not found. Run with npm, or add a Node.js installation containing npm to PATH.");
}

const npm = await npmEntry();
const work = await mkdtemp(join(tmpdir(), "qz-npm-smoke-"));
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("The npm package smoke test was interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let daemonChild;

// Exclude npm tokens, inherited npm configuration, NODE_OPTIONS and application settings.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TMP|TEMP|TMPDIR|LANG|LC_ALL)$/i.test(key)));
env.PATH = [dirname(process.execPath), env.PATH || env.Path || ""].join(delimiter);
delete env.Path;
Object.assign(env, {
  QZ_STATE_DIR: join(work, "state"),
  npm_config_userconfig: join(work, "user.npmrc"), npm_config_globalconfig: join(work, "global.npmrc"),
  npm_config_cache: join(work, "cache"), npm_config_registry: "https://registry.npmjs.org/",
  npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false",
  npm_config_fetch_retries: "1", npm_config_fetch_timeout: "60000", NO_COLOR: "1",
});

async function runNpm(args, cwd) {
  try {
    const result = await execute(process.execPath, [npm, ...args], {
      cwd, env, timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: controller.signal,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`npm ${args[0]} failed (public registry; credentials and install scripts disabled).\n${
      String(error.stderr || error.stdout || error.message).slice(-6000)}`, { cause: error });
  }
}

async function cli(directory, args) {
  return runNpm(["exec", "--offline", "--", "qz", ...args], directory);
}

async function result(directory, args) {
  const payload = JSON.parse(await cli(directory, [...args, "--json"]));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload.result;
}

function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
async function cleanupDaemon() {
  if (!Number.isInteger(daemonChild?.pid) || exited(daemonChild)) return;
  // Only this test's captured child can be killed; never discover a default service here.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    daemonChild.kill(signal);
    for (let attempt = 0; attempt < 100 && !exited(daemonChild); attempt += 1) await delay(20);
    if (exited(daemonChild)) return;
  }
  throw new Error(`Could not stop the isolated smoke-test daemon (PID ${daemonChild.pid}).`);
}

try {
  await writeFile(env.npm_config_userconfig, "");
  await writeFile(env.npm_config_globalconfig, "");
  let tarball = options.tarball;
  if (!tarball) {
    console.error("Packing the npm package with lifecycle scripts disabled…");
    const packed = JSON.parse(await runNpm([
      "pack", join(ROOT, "services/mcp-bridge"), "--ignore-scripts", "--json", "--pack-destination", work,
    ], work));
    assert.equal(packed.length, 1);
    tarball = join(work, packed[0].filename);
  }
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const installs = [join(work, "installation"), join(work, "another-cache-path")];
  const packages = installs.map(directory => join(directory, "node_modules/qz-browser-agent"));
  for (const directory of installs) {
    console.error(`Installing the tarball in ${directory}…`);
    await mkdir(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true }));
    await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], directory);
    await access(join(directory, "node_modules/.bin", process.platform === "win32" ? "qz.cmd" : "qz"));
  }
  const metadata = JSON.parse(await readFile(join(packages[0], "package.json"), "utf8"));
  assert.equal(metadata.name, "qz-browser-agent");
  assert.match(await cli(installs[0], ["--help"]), /qz/);
  assert.ok((await cli(installs[0], ["--version"])).split(/\s+/).includes(metadata.version), "Installed qz must report its package version.");
  assert.deepEqual(await result(installs[0], ["status"]), { running: false, connected: false });

  const [first, second] = await Promise.all(packages.map(directory => import(pathToFileURL(join(directory, "src/daemon.mjs")))));
  assert.deepEqual(first.buildIdentity(), second.buildIdentity(), "The same package must keep its identity across installation/cache paths.");
  console.error("Checking the installed CLI and MCP service on an isolated dynamic port…");
  const running = await first.ensureDaemon({
    stateDir: env.QZ_STATE_DIR, preferredPort: 0,
    spawnProcess(command, args, settings) {
      assert.equal(daemonChild, undefined, "Only one daemon may be created.");
      daemonChild = spawn(command, args, { ...settings, detached: false, env });
      return daemonChild;
    },
  });
  assert.equal(running.processId, daemonChild.pid);
  assert.notEqual(new URL(running.endpoint).port, "0");
  const fromSecond = await second.ensureDaemon({
    stateDir: env.QZ_STATE_DIR, preferredPort: 0,
    spawnProcess() { assert.fail("A second installation must reuse the running service."); },
  });
  assert.equal(fromSecond.instanceId, running.instanceId);
  assert.equal(fromSecond.processId, running.processId);
  const status = await result(installs[1], ["status"]);
  assert.equal(status.running, true);
  assert.equal(status.connected, false);
  assert.equal(status.endpoint, running.endpoint);
  assert.equal(status.updateAvailable, false);
  const mcp = await result(installs[1], ["mcp"]);
  assert.equal(mcp.url, `${running.endpoint}/mcp`);

  // Resolve the SDK from the installed tarball's dependency tree, never the repository.
  const requireInstalled = createRequire(join(packages[0], "package.json"));
  const { Client } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")));
  const { localFetch, resultValue } = await import(pathToFileURL(join(packages[0], "src/client.mjs")));
  const client = new Client({ name: "qz-package-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), { fetch: localFetch });
  try {
    await client.connect(transport, { timeout: 10_000, signal: controller.signal });
    assert.equal(client.getServerVersion().version, metadata.version);
    const catalog = await client.listTools({}, { timeout: 10_000, signal: controller.signal });
    assert.ok(catalog.tools.some(tool => tool.name === "qingzhou_bridge_status"));
    const called = await client.callTool({ name: "qingzhou_bridge_status", arguments: {} }, undefined,
      { timeout: 10_000, signal: controller.signal });
    assert.notEqual(called.isError, true);
    assert.equal(resultValue(called).connected, false);
    assert.equal(resultValue(called).endpoint, running.endpoint);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
  assert.equal((await result(installs[1], ["stop"])).stopped, true);
  assert.deepEqual(await result(installs[0], ["status"]), { running: false, connected: false });
  assert.equal((await result(installs[0], ["stop"])).stopped, false);
  assert.equal(exited(daemonChild), true, "The installed stop command must terminate its service.");

  if (options.output && options.output !== tarball) {
    await mkdir(dirname(options.output), { recursive: true });
    await copyFile(tarball, options.output, constants.COPYFILE_EXCL);
  }
  console.log(JSON.stringify({ ok: true, name: metadata.name, version: metadata.version, node: process.versions.node, sha256,
    ...(options.output || options.tarball ? { tarball: options.output || options.tarball } : {}),
    checks: ["npm-install", "installed-bin", "version", "cache-path-identity", "daemon-reuse", "mcp", "stop"],
  }));
} finally {
  try { await cleanupDaemon(); }
  finally {
    await rm(work, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

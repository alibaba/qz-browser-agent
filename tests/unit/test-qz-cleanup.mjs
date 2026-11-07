import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cleanupDaemons, daemonPaths, ensureDaemon, findDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";
import { readHealth } from "../../services/mcp-bridge/src/client.mjs";

const exec = promisify(execFile);
const bin = resolve("services/mcp-bridge/src/bin.mjs");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const deadPid = 2147483000;

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-cleanup-"));
  const scopes = [];
  t.after(async () => {
    for (const options of scopes) await stopDaemon(options).catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, scope() {
    const options = { stateDir, scopeId: randomBytes(12).toString("hex"), buildId: "cleanup-test", preferredPort: 0 };
    scopes.push(options);
    return { options, paths: daemonPaths(options) };
  }, cli: () => exec(process.execPath, [bin, "cleanup", "--json"], { env: { ...process.env, QZ_STATE_DIR: stateDir } }) };
}

test("cleanup CLI stops both installation scopes, preserves pairing and is idempotent", async t => {
  const fixtureState = await fixture(t);
  const left = fixtureState.scope(), right = fixtureState.scope();
  const running = await Promise.all([ensureDaemon(left.options), ensureDaemon(right.options)]);
  for (const { paths } of [left, right]) {
    await writeFile(paths.state.replace(/\.json$/, ".browsers.json"), '{"paired":"keep"}');
  }
  await writeFile(join(fixtureState.stateDir, "user-notes.json"), "keep notes");
  const output = JSON.parse((await fixtureState.cli()).stdout);
  assert.equal(output.ok, true);
  assert.equal(output.result.stopped, 2);
  assert.equal(output.result.skipped, 0);
  assert.deepEqual(output.result.services.map(item => item.processId).sort(), running.map(item => item.processId).sort());
  for (const { options, paths } of [left, right]) {
    assert.equal(await findDaemon(options), null);
    assert.equal(await exists(paths.state), false);
    assert.equal(await exists(paths.log), false);
    assert.equal(await exists(paths.lock), false);
    assert.equal(await readFile(paths.state.replace(/\.json$/, ".browsers.json"), "utf8"), '{"paired":"keep"}');
  }
  assert.equal(await readFile(join(fixtureState.stateDir, "user-notes.json"), "utf8"), "keep notes");
  assert.deepEqual(JSON.parse((await fixtureState.cli()).stdout).result, { stopped: 0, removedFiles: 0, skipped: 0, services: [] });
});

test("cleanup of a missing state directory never creates it or starts a service", async t => {
  const { stateDir } = await fixture(t);
  const missingDir = join(stateDir, "unused");
  const { stdout } = await exec(process.execPath, [bin, "cleanup", "--json"], { env: { ...process.env, QZ_STATE_DIR: missingDir } });
  assert.equal(JSON.parse(stdout).result.stopped, 0);
  assert.equal(await exists(missingDir), false);
});

test("cleanup removes dead runtime files while leaving active pending starters intact", async t => {
  const { stateDir, scope } = await fixture(t);
  const { options, paths } = scope();
  const record = { service: "qz-browser-agent", scopeId: options.scopeId, processId: deadPid, instanceId: randomUUID() };
  await writeFile(paths.state, JSON.stringify(record));
  await writeFile(paths.log, "old log");
  const temporary = `${paths.state}.${randomUUID()}.tmp`;
  await writeFile(temporary, "unfinished state");
  const pending = async (pid, old = false) => {
    const id = randomUUID(), path = `${paths.lock}.${id}.pending`;
    await mkdir(path);
    if (pid) await writeFile(join(path, `${pid}-${id}.json`), JSON.stringify({ processId: pid, id }));
    if (old) await utimes(path, new Date(0), new Date(0));
    return path;
  };
  const deadPending = await pending(deadPid), livePending = await pending(process.pid);
  const freshEmpty = await pending(), staleEmpty = await pending(undefined, true);
  await mkdir(paths.lock);
  await writeFile(join(paths.lock, `${deadPid}-${randomUUID()}.json`), JSON.stringify({ processId: deadPid }));
  let healthChecks = 0;
  const result = await cleanupDaemons({ stateDir, readHealth: async () => { healthChecks++; throw new Error("Service is offline"); } });
  assert.equal(healthChecks, 1, "verify the endpoint before treating its PID as dead");
  assert.equal(result.stopped, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual((await readdir(stateDir)).sort(), [livePending, freshEmpty].map(path => path.slice(stateDir.length + 1)).sort());
  assert.equal(await exists(deadPending), false);
  assert.equal(await exists(staleEmpty), false);
});

for (const failure of ["mismatched", "unreachable"]) test(`cleanup preserves an ${failure} live process and its record`, async t => {
  const { stateDir, scope } = await fixture(t);
  const { options, paths } = scope();
  const record = { service: "qz-browser-agent", scopeId: options.scopeId, buildId: "fixture", processId: process.pid,
    instanceId: randomUUID(), endpoint: "http://127.0.0.1:1" };
  await writeFile(paths.state, JSON.stringify(record));
  await writeFile(paths.log, "keep diagnostics");
  const result = await cleanupDaemons({ stateDir, readHealth: async () => {
    if (failure === "unreachable") throw new Error("offline");
    return { ...record, instanceId: "other-process" };
  } });
  assert.equal(result.stopped, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.services[0].status, "skipped");
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.equal(await readFile(paths.log, "utf8"), "keep diagnostics");
});

test("cleanup accepts an old protocol only after verifying the live identity", async t => {
  const { stateDir, scope } = await fixture(t);
  const { options } = scope();
  await ensureDaemon(options);
  const result = await cleanupDaemons({ stateDir, readHealth: async (endpoint, options) => {
    assert.equal(options.allowIncompatible, true);
    return { ...await readHealth(endpoint, options), protocolVersion: 0 };
  } });
  assert.equal(result.stopped, 1);
  assert.equal(result.skipped, 0);
});

test("cleanup reports a busy startup lock and leaves its owner untouched", async t => {
  const { stateDir, scope } = await fixture(t);
  const { paths } = scope();
  await mkdir(paths.lock);
  const owner = join(paths.lock, `${process.pid}-${randomUUID()}.json`);
  await writeFile(owner, JSON.stringify({ processId: process.pid }));
  const result = await cleanupDaemons({ stateDir, timeoutMs: 1 });
  assert.equal(result.skipped, 1);
  assert.equal(result.services[0].code, "CONNECTION_BUSY");
  assert.equal(await exists(owner), true);
  await rm(paths.lock, { recursive: true });
});

test("a waiting start runs after cleanup and its new record survives", async t => {
  const { stateDir, scope } = await fixture(t);
  const { options, paths } = scope();
  const first = await ensureDaemon(options);
  const entered = deferred(), release = deferred();
  const cleanup = cleanupDaemons({ stateDir, readHealth: async (...args) => {
    entered.resolve(); await release.promise; return readHealth(...args);
  } });
  await entered.promise;
  const next = ensureDaemon(options);
  release.resolve();
  assert.equal((await cleanup).stopped, 1);
  const replacement = await next;
  assert.notEqual(replacement.instanceId, first.instanceId);
  assert.equal((await findDaemon(options)).instanceId, replacement.instanceId);
  assert.equal(JSON.parse(await readFile(paths.state, "utf8")).instanceId, replacement.instanceId);
});

test("cancelling cleanup during health verification cannot signal the service", async t => {
  const { stateDir, scope } = await fixture(t);
  const { options, paths } = scope();
  const running = await ensureDaemon(options);
  const controller = new AbortController();
  await assert.rejects(cleanupDaemons({ stateDir, signal: controller.signal, readHealth: async (...args) => {
    const health = await readHealth(...args); controller.abort(); return health;
  } }), { name: "AbortError" });
  assert.equal((await findDaemon(options)).instanceId, running.instanceId);
  assert.equal(await exists(paths.log), true);
});

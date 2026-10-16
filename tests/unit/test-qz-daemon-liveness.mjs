import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemonPaths, ensureDaemon, findDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";

const fixturePid = 2147483000;
const procStatus = state => `Name:\tqz-fixture\nState:\t${state}\nPid:\t${fixturePid}\n`;
const osError = code => Object.assign(new Error(`Fixture ${code}`), { code });

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-process-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID(), buildId: "liveness-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  const record = { service: "qz-browser-agent", protocolVersion: 1, scopeId: options.scopeId,
    buildId: options.buildId, instanceId: randomUUID(), processId: fixturePid, endpoint: "http://127.0.0.1:12345" };
  await writeFile(paths.state, JSON.stringify(record));
  return { options, paths, record };
}

// Mock the OS boundary, so zombie tests work on every host without real processes or reaping.
function mockProcesses(t, entries, { platform = "linux", onSignal } = {}) {
  const processes = new Map(entries);
  const signals = [], reads = [];
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const readFileSync = fs.readFileSync;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.mock.method(process, "kill", (pid, signal) => {
    signals.push({ pid, signal });
    const entry = processes.get(pid);
    if (!entry) throw osError("ESRCH");
    if (entry.killError) throw osError(entry.killError);
    if (signal !== 0) {
      assert.ok(onSignal, "test must explicitly handle every process signal");
      onSignal(pid, signal, entry);
    }
    return true;
  });
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    const match = /^\/proc\/(\d+)\/status$/.exec(String(path));
    if (!match) return readFileSync(path, ...args);
    reads.push(String(path));
    const entry = processes.get(Number(match[1]));
    if (entry?.readError) throw osError(entry.readError);
    return entry?.status;
  });
  syncBuiltinESMExports();
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { processes, signals, reads };
}

for (const scenario of [
  { name: "Linux zombie", entry: { status: procStatus("Z (zombie)") }, alive: false, reads: 1 },
  { name: "Linux dead", entry: { status: procStatus("X (dead)") }, alive: false, reads: 1 },
  { name: "Linux sleeping", entry: { status: procStatus("S (sleeping)") }, alive: true, reads: 1 },
  { name: "Linux running", entry: { status: procStatus("R (running)") }, alive: true, reads: 1 },
  { name: "nonexistent PID", entry: { killError: "ESRCH" }, alive: false, reads: 0 },
  { name: "permission-denied PID", entry: { killError: "EPERM", status: procStatus("Z (zombie)") }, alive: true, reads: 0 },
  { name: "unavailable procfs", entry: { readError: "ENOENT" }, alive: true, reads: 1 },
  { name: "unreadable procfs", entry: { readError: "EACCES" }, alive: true, reads: 1 },
  { name: "missing process state", entry: { status: "Name:\tqz-fixture\n" }, alive: true, reads: 1 },
  { name: "malformed process state", entry: { status: "State:\tZombie\n" }, alive: true, reads: 1 },
  { name: "malformed state line", entry: { status: "State:\nZ\n" }, alive: true, reads: 1 },
  { name: "non-Linux process", platform: "darwin", entry: { status: procStatus("Z (zombie)") }, alive: true, reads: 0 },
]) {
  test(`daemon lookup handles ${scenario.name} conservatively`, async t => {
    const { options, record } = await fixture(t);
    const os = mockProcesses(t, [[fixturePid, scenario.entry]], { platform: scenario.platform });
    let healthChecks = 0;
    const running = await findDaemon({ ...options, readHealth: async endpoint => {
      healthChecks++;
      assert.equal(endpoint, record.endpoint);
      return record;
    } });
    assert.equal(running?.processId ?? null, scenario.alive ? fixturePid : null);
    assert.equal(healthChecks, scenario.alive ? 1 : 0);
    assert.equal(os.reads.length, scenario.reads);
    assert.deepEqual(os.signals, [{ pid: fixturePid, signal: 0 }]);
  });
}

test("connect replaces a zombie daemon and recovers only its dead lock owner", async t => {
  const { options, paths, record } = await fixture(t);
  const replacementPid = fixturePid - 1;
  const lockPid = fixturePid - 2;
  mockProcesses(t, [[fixturePid, { status: procStatus("Z (zombie)") }],
    [lockPid, { status: procStatus("X (dead)") }], [replacementPid, { status: procStatus("S (sleeping)") }]]);
  await mkdir(paths.lock);
  await writeFile(join(paths.lock, `${lockPid}-${randomUUID()}.json`), JSON.stringify({ processId: lockPid }));
  let starts = 0, replacement;
  const running = await ensureDaemon({ ...options,
    readHealth: async () => replacement || assert.fail("a zombie must not be health-checked"),
    spawnProcess: (_executable, args) => {
      starts++;
      replacement = { ...record, scopeId: args[3], buildId: args[5], instanceId: args[6], processId: replacementPid };
      const child = Object.assign(new EventEmitter(), {
        pid: replacementPid, exitCode: null, signalCode: null, unref() {},
        kill() { assert.fail("a successful replacement must not be killed"); },
      });
      void writeFile(args[2], JSON.stringify(replacement)).then(() => child.emit("spawn"), error => child.emit("error", error));
      return child;
    },
  });
  assert.equal(starts, 1);
  assert.equal(running.processId, replacementPid);
  assert.notEqual(running.instanceId, record.instanceId);
  assert.equal(running.scopeId, record.scopeId);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), replacement);
  await assert.rejects(readFile(paths.lock), error => error.code === "ENOENT");
});

test("stop succeeds when the signalled daemon becomes an unreaped zombie", async t => {
  const { options, record } = await fixture(t);
  const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)") }]], {
    onSignal(pid, signal, entry) {
      assert.equal(pid, fixturePid);
      assert.equal(signal, "SIGTERM");
      entry.status = procStatus("Z (zombie)");
    },
  });
  assert.deepEqual(await stopDaemon({ ...options, readHealth: async () => record }), { stopped: true, connected: false });
  assert.deepEqual(os.signals.filter(call => call.signal !== 0), [{ pid: fixturePid, signal: "SIGTERM" }]);
  assert.deepEqual(await stopDaemon({ ...options, readHealth: () => assert.fail("a stopped zombie has no health endpoint") }),
    { stopped: false, connected: false }, "stopping an already-exited process remains idempotent");
});

test("an unreachable live daemon is neither replaced nor signalled", async t => {
  const { options, paths, record } = await fixture(t);
  const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)") }]]);
  let healthChecks = 0;
  const lookup = { ...options,
    readHealth: async () => { healthChecks++; throw osError("ECONNREFUSED"); },
    spawnProcess: () => assert.fail("a live but unhealthy daemon must not be replaced"),
  };
  for (const operation of [ensureDaemon, stopDaemon]) {
    await assert.rejects(operation(lookup), error => error.code === "connection_unavailable" && error.details.processId === fixturePid);
  }
  assert.equal(healthChecks, 4, "each operation retries health once without replacing the service");
  assert.ok(os.signals.every(call => call.signal === 0));
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
});

test("a live lock owner is retained even if its proc status cannot be read", async t => {
  const { options, paths } = await fixture(t);
  mockProcesses(t, [[fixturePid, { readError: "EACCES" }]]);
  await mkdir(paths.lock);
  const owner = { processId: fixturePid, id: randomUUID() };
  const ownerFile = join(paths.lock, `${owner.processId}-${owner.id}.json`);
  await writeFile(ownerFile, JSON.stringify(owner));
  await assert.rejects(ensureDaemon({ ...options, timeoutMs: 1,
    spawnProcess: () => assert.fail("a live lock owner must not be displaced"),
  }), error => error.code === "connection_busy");
  assert.deepEqual(JSON.parse(await readFile(ownerFile, "utf8")), owner);
});

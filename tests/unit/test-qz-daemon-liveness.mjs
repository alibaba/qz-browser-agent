import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cleanupDaemons, daemonPaths, ensureDaemon, findDaemon, restartDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";

const fixturePid = 2147483000;
const procStatus = state => `Name:\tqz-fixture\nState:\t${state}\nPid:\t${fixturePid}\n`;
const osError = code => Object.assign(new Error(`Fixture ${code}`), { code });
const daemonCommand = (record, paths) => [process.execPath, resolve("services/mcp-bridge/src/daemon.mjs"),
  "--run", paths.state, record.scopeId, new URL(record.endpoint).port, record.buildId, record.instanceId, ""].join("\0");

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-process-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID().replaceAll("-", "").slice(0, 24), buildId: "liveness-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  const record = { service: "qz-browser-agent", protocolVersion: 1, scopeId: options.scopeId,
    buildId: options.buildId, instanceId: randomUUID(), processId: fixturePid, endpoint: "http://127.0.0.1:12345" };
  await writeFile(paths.state, JSON.stringify(record));
  return { options, paths, record };
}

// Mock the OS boundary, so zombie tests work on every host without real processes or reaping.
function mockProcesses(t, entries, { platform = "linux", namespace = "pid:[100]", onSignal } = {}) {
  const processes = new Map(entries);
  const signals = [], reads = [];
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const readFileSync = fs.readFileSync;
  const readlinkSync = fs.readlinkSync;
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
    const match = /^\/proc\/(\d+)\/(status|cmdline)$/.exec(String(path));
    if (!match) return readFileSync(path, ...args);
    reads.push(String(path));
    const entry = processes.get(Number(match[1]));
    if (!entry) throw osError("ENOENT");
    if (entry.readError) throw osError(entry.readError);
    if (match[2] === "cmdline" && !entry.cmdline) throw osError("ENOENT");
    return entry[match[2]];
  });
  t.mock.method(fs, "readlinkSync", (path, ...args) => String(path) === "/proc/self/ns/pid" ? namespace : readlinkSync(path, ...args));
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
  test(`unreachable daemon lookup handles ${scenario.name} conservatively`, async t => {
    const { options, record } = await fixture(t);
    const os = mockProcesses(t, [[fixturePid, scenario.entry]], { platform: scenario.platform });
    let healthChecks = 0;
    const lookup = findDaemon({ ...options, readHealth: async endpoint => {
      healthChecks++;
      assert.equal(endpoint, record.endpoint);
      throw osError("ECONNREFUSED");
    } });
    if (scenario.alive) await assert.rejects(lookup, error => error.code === "CONNECTION_UNAVAILABLE");
    else assert.equal(await lookup, null);
    const attempts = scenario.alive ? 2 : 1;
    assert.equal(healthChecks, attempts);
    assert.equal(os.reads.length, scenario.reads * attempts);
    assert.deepEqual(os.signals, Array.from({ length: attempts }, () => ({ pid: fixturePid, signal: 0 })));
  });
}

test("a responding daemon is reused even when its host PID is invisible locally", async t => {
  const { options, paths, record } = await fixture(t);
  const os = mockProcesses(t, []);
  const lookup = { ...options, readHealth: async () => record,
    spawnProcess: () => assert.fail("a verified host daemon must be reused"),
  };
  assert.equal((await findDaemon(lookup)).instanceId, record.instanceId);
  assert.equal((await ensureDaemon(lookup)).instanceId, record.instanceId);
  assert.deepEqual(os.signals, [], "ordinary service reuse does not interpret a foreign PID");
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.includes(".lock")), []);
});

test("a foreign daemon survives a transient health failure without starting a replacement", async t => {
  const { options, paths, record } = await fixture(t);
  record.pidNamespace = "pid:[200]";
  await writeFile(paths.state, JSON.stringify(record));
  const os = mockProcesses(t, []);
  let healthChecks = 0;
  const running = await ensureDaemon({ ...options,
    readHealth: async () => {
      if (++healthChecks === 1) throw osError("ECONNREFUSED");
      return record;
    },
    spawnProcess: () => assert.fail("a transient failure cannot replace a foreign daemon"),
  });
  assert.equal(healthChecks, 2);
  assert.equal(running.instanceId, record.instanceId);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual(os.signals, [], "a hidden host PID is not evidence that its service exited");
});

test("an unreachable foreign daemon is preserved by startup and cleanup", async t => {
  const { options, paths, record } = await fixture(t);
  record.pidNamespace = "pid:[200]";
  await writeFile(paths.state, JSON.stringify(record));
  await writeFile(paths.log, "keep unavailable host diagnostics");
  const os = mockProcesses(t, []);
  let healthChecks = 0;
  const lookup = { ...options,
    readHealth: async () => { healthChecks++; throw osError("ECONNREFUSED"); },
    spawnProcess: () => assert.fail("an unreachable foreign daemon cannot be assumed dead"),
  };
  await assert.rejects(ensureDaemon(lookup), error => error.code === "CONNECTION_UNAVAILABLE");
  const cleaned = await cleanupDaemons(lookup);
  assert.equal(healthChecks, 4, "both operations retry health before reporting the service unavailable");
  assert.equal(cleaned.stopped, 0);
  assert.equal(cleaned.removedFiles, 0);
  assert.equal(cleaned.skipped, 1);
  assert.equal(cleaned.services[0].code, "CONNECTION_UNAVAILABLE");
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.equal(await readFile(paths.log, "utf8"), "keep unavailable host diagnostics");
  assert.deepEqual(os.signals, []);
});

test("preferred-port recovery adopts a responding daemon without local PID visibility", async t => {
  const { options, paths, record } = await fixture(t);
  record.pidNamespace = "pid:[200]";
  const os = mockProcesses(t, []);
  await rm(paths.state);
  const running = await ensureDaemon({ ...options, preferredPort: Number(new URL(record.endpoint).port),
    readHealth: async endpoint => { assert.equal(endpoint, record.endpoint); return record; },
    spawnProcess: () => assert.fail("a responding service at the preferred port must not be duplicated"),
  });
  assert.equal(running.instanceId, record.instanceId);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual(os.signals, []);
});

for (const localProcess of ["invisible", "unrelated", "different instance", "different scope"]) {
  test(`cleanup preserves a responding host daemon when its PID is ${localProcess} locally`, async t => {
    const { options, paths, record } = await fixture(t);
    let entry;
    if (localProcess !== "invisible") {
      const changed = { ...record, ...(localProcess === "different instance" ? { instanceId: randomUUID() } : {}),
        ...(localProcess === "different scope" ? { scopeId: "other-scope" } : {}) };
      entry = { status: procStatus("S (sleeping)"), cmdline: localProcess === "unrelated"
        ? [process.execPath, "/tmp/unrelated-app.mjs", ""].join("\0") : daemonCommand(changed, paths) };
    }
    const os = mockProcesses(t, entry ? [[fixturePid, entry]] : []);
    await writeFile(paths.log, "keep host service diagnostics");
    const result = await cleanupDaemons({ stateDir: options.stateDir, readHealth: async () => record });
    assert.equal(result.stopped, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.services[0].code, "STOP_FAILED");
    assert.equal(result.removedFiles, 0);
    assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
    assert.equal(await readFile(paths.log, "utf8"), "keep host service diagnostics");
    assert.ok(os.signals.every(({ signal }) => signal === 0), "cleanup cannot signal an unverified local process");
  });
}

test("a startup lock from another PID namespace is not reclaimed by a missing local PID", async t => {
  const { options, paths } = await fixture(t);
  const os = mockProcesses(t, []);
  await rm(paths.state);
  await mkdir(paths.lock);
  const owner = { processId: fixturePid, id: randomUUID(), pidNamespace: "pid:[200]" };
  const ownerPath = join(paths.lock, `${owner.processId}-${owner.id}.json`);
  await writeFile(ownerPath, JSON.stringify(owner));
  await assert.rejects(ensureDaemon({ ...options, timeoutMs: 1,
    spawnProcess: () => assert.fail("a foreign startup lock must not be stolen"),
  }), error => error.code === "CONNECTION_BUSY");
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), owner);
  assert.deepEqual(os.signals, [], "foreign owner PIDs are not interpreted in this namespace");
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.endsWith(".pending")), []);
});

test("connect replaces a zombie daemon and recovers only its dead lock owner", async t => {
  const { options, paths, record } = await fixture(t);
  record.pidNamespace = "pid:[100]";
  await writeFile(paths.state, JSON.stringify(record));
  const replacementPid = fixturePid - 1;
  const lockPid = fixturePid - 2;
  mockProcesses(t, [[fixturePid, { status: procStatus("Z (zombie)") }],
    [lockPid, { status: procStatus("X (dead)") }], [replacementPid, { status: procStatus("S (sleeping)") }]]);
  await mkdir(paths.lock);
  await writeFile(join(paths.lock, `${lockPid}-${randomUUID()}.json`), JSON.stringify({ processId: lockPid }));
  let starts = 0, replacement;
  const running = await ensureDaemon({ ...options,
    readHealth: async () => { if (replacement) return replacement; throw osError("ECONNREFUSED"); },
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
  const { options, paths, record } = await fixture(t);
  const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)"), cmdline: daemonCommand(record, paths) }]], {
    onSignal(pid, signal, entry) {
      assert.equal(pid, fixturePid);
      assert.equal(signal, "SIGTERM");
      entry.status = procStatus("Z (zombie)");
    },
  });
  assert.deepEqual(await stopDaemon({ ...options, readHealth: async () => record }), { stopped: true, connected: false });
  assert.deepEqual(os.signals.filter(call => call.signal !== 0), [{ pid: fixturePid, signal: "SIGTERM" }]);
  assert.deepEqual(await stopDaemon({ ...options, readHealth: async () => { throw osError("ECONNREFUSED"); } }),
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
  for (const operation of [ensureDaemon, stopDaemon, restartDaemon]) {
    await assert.rejects(operation({ ...lookup, expected: record }), error => error.code === "CONNECTION_UNAVAILABLE" && error.details.processId === fixturePid);
  }
  assert.equal(healthChecks, 6, "each operation retries health once without replacing the service");
  assert.ok(os.signals.every(call => call.signal === 0));
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
});

test("a live lock owner is retained even if its proc status cannot be read", async t => {
  const { options, paths } = await fixture(t);
  mockProcesses(t, [[fixturePid, { readError: "EACCES" }]]);
  await rm(paths.state);
  await mkdir(paths.lock);
  const owner = { processId: fixturePid, id: randomUUID() };
  const ownerFile = join(paths.lock, `${owner.processId}-${owner.id}.json`);
  await writeFile(ownerFile, JSON.stringify(owner));
  await assert.rejects(ensureDaemon({ ...options, timeoutMs: 1,
    spawnProcess: () => assert.fail("a live lock owner must not be displaced"),
  }), error => error.code === "CONNECTION_BUSY");
  assert.deepEqual(JSON.parse(await readFile(ownerFile, "utf8")), owner);
});

test("cancellation during daemon health checks preserves the live process and startup state", async t => {
  const { options, paths, record } = await fixture(t);
  const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)") }]]);
  for (const operation of [ensureDaemon, restartDaemon]) {
    const controller = new AbortController(), reason = new Error("Cancelled during daemon health check");
    await assert.rejects(operation({ ...options, expected: record, signal: controller.signal,
      readHealth: async () => { controller.abort(reason); return record; },
      spawnProcess: () => assert.fail("cancelled health checks cannot start a replacement"),
    }), error => error === reason);
  }
  assert.ok(os.signals.every(call => call.signal === 0), "the running daemon receives no termination signal");
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.includes(".lock")), []);
});

test("a cancelled upgrade waiting for the startup lock cannot stop its owner after release", async t => {
  const { options, paths, record } = await fixture(t);
  const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)") }]]);
  const owner = { processId: fixturePid, id: randomUUID() };
  await mkdir(paths.lock);
  await writeFile(join(paths.lock, `${owner.processId}-${owner.id}.json`), JSON.stringify(owner));
  const controller = new AbortController(), reason = new Error("Cancelled while waiting for startup lock");
  const rejected = assert.rejects(restartDaemon({ ...options, expected: record, signal: controller.signal,
    readHealth: () => assert.fail("cancelled lock wait cannot inspect or restart the daemon"),
    spawnProcess: () => assert.fail("cancelled lock wait cannot start a service"),
  }), error => error === reason || error.name === "AbortError");
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await readdir(paths.directory)).some(name => name.endsWith(".pending"))) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok((await readdir(paths.directory)).some(name => name.endsWith(".pending")), "the upgrade actually queued behind the live owner");
  controller.abort(reason);
  await rm(paths.lock, { recursive: true });
  await rejected;
  assert.ok(os.signals.every(call => call.signal === 0));
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.includes(".lock")), []);
});

test("cancellation during the free-port startup probe prevents every child spawn", async t => {
  const { options, paths, record } = await fixture(t);
  mockProcesses(t, [[fixturePid, { status: procStatus("Z (zombie)") }]]);
  const controller = new AbortController(), reason = new Error("Cancelled during startup probe");
  await assert.rejects(ensureDaemon({ ...options, preferredPort: 18765, signal: controller.signal,
    readHealth: async endpoint => { if (endpoint !== record.endpoint) controller.abort(reason); throw osError("ECONNREFUSED"); },
    spawnProcess: () => assert.fail("cancelled startup cannot launch a daemon"),
  }), error => error === reason);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.includes(".lock")), []);
});


for (const boundary of ["expected", "health"]) for (const field of ["scopeId", "instanceId", "processId"]) {
  test(`restart refuses a changed ${boundary} ${field} without signalling any process`, async t => {
    const { options, paths, record } = await fixture(t);
    const os = mockProcesses(t, [[fixturePid, { status: procStatus("S (sleeping)") }]]);
    const changed = { ...record, [field]: field === "processId" ? fixturePid - 1 : `different-${field}` };
    await assert.rejects(restartDaemon({ ...options, expected: boundary === "expected" ? changed : record,
      readHealth: async () => boundary === "health" ? changed : record,
      spawnProcess: () => assert.fail("an identity mismatch must not start a replacement"),
    }), error => error.code === "CONNECTION_CHANGED");
    assert.ok(os.signals.every(call => call.signal === 0), "no mismatched process receives a signal");
    assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), record);
    await assert.rejects(readFile(paths.lock), error => error.code === "ENOENT");
  });
}

test("restart replaces only the expected instance and a repeated recovery cannot kill its replacement", async t => {
  const { options, paths, record } = await fixture(t);
  record.protocolVersion = 0;
  record.buildId = "previous-build";
  await writeFile(paths.state, JSON.stringify(record));
  const replacementPid = fixturePid - 1;
  const os = mockProcesses(t, [
    [fixturePid, { status: procStatus("S (sleeping)"), cmdline: daemonCommand(record, paths) }],
    [replacementPid, { status: procStatus("S (sleeping)") }],
  ], { onSignal(pid, signal, entry) {
    assert.equal(pid, fixturePid, "recovery may signal only the verified old daemon");
    assert.equal(signal, "SIGTERM");
    entry.status = procStatus("Z (zombie)");
  } });
  let starts = 0, replacement;
  const recovery = { ...options, expected: record,
    readHealth: async (_endpoint, healthOptions) => {
      if (!replacement && os.processes.get(fixturePid).status.includes("Z (zombie)")) throw osError("ECONNREFUSED");
      if (!replacement) assert.equal(healthOptions.allowIncompatible, true,
        "old protocol health must be readable before its process identity is trusted");
      return replacement || record;
    },
    spawnProcess: (_executable, args) => {
      starts++;
      replacement = { ...record, protocolVersion: 1, scopeId: args[3], buildId: args[5],
        instanceId: args[6], processId: replacementPid };
      const child = Object.assign(new EventEmitter(), {
        pid: replacementPid, exitCode: null, signalCode: null, unref() {},
        kill() { assert.fail("a successful replacement must not be killed"); },
      });
      void writeFile(args[2], JSON.stringify(replacement)).then(() => child.emit("spawn"), error => child.emit("error", error));
      return child;
    },
  };
  const running = await restartDaemon(recovery);
  assert.equal(running.instanceId, replacement.instanceId);
  assert.equal(running.processId, replacementPid);
  assert.equal(running.health.buildId, options.buildId);
  await assert.rejects(restartDaemon(recovery), error => error.code === "CONNECTION_CHANGED");
  assert.equal(starts, 1, "a stale recovery request cannot start another replacement");
  assert.deepEqual(os.signals.filter(call => call.signal !== 0), [{ pid: fixturePid, signal: "SIGTERM" }]);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), replacement);
  await assert.rejects(readFile(paths.lock), error => error.code === "ENOENT");
});

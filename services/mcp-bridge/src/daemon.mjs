import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION, QzError, SERVICE_NAME, readHealth } from "./client.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

export function buildIdentity(directory = packageDir) {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const digest = createHash("sha256").update(JSON.stringify(metadata));
  for (const name of readdirSync(join(directory, "src")).filter(name => /\.(mjs|json)$/.test(name)).sort()) {
    digest.update(name).update(readFileSync(join(directory, "src", name)));
  }
  const source = basename(dirname(directory)) === "services" ? `dev:${realpathSync(directory)}` : `package:${metadata.name}`;
  return { scopeId: createHash("sha256").update(source).digest("hex").slice(0, 24), buildId: digest.digest("hex") };
}

export function daemonPaths(options = {}) {
  const identity = options.scopeId && options.buildId ? options : buildIdentity();
  const scopeId = options.scopeId || identity.scopeId;
  return { scopeId, buildId: options.buildId || identity.buildId, ...scopePaths(stateDirectory(options), scopeId) };
}

function stateDirectory(options) {
  return resolve(options.stateDir || process.env.QZ_STATE_DIR || join(homedir(), ".qz-browser-agent", "run"));
}

function scopePaths(directory, scopeId) {
  return { directory, state: join(directory, `${scopeId}.json`), lock: join(directory, `${scopeId}.lock`), log: join(directory, `${scopeId}.log`) };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    // Unreaped processes still accept signal 0, but can no longer serve requests or own locks.
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const state = /^State:[ \t]+([A-Z])(?:[ \t]+\([^\r\n]*\))?[ \t]*$/m.exec(status)?.[1];
    return state !== "Z" && state !== "X";
  } catch {
    // Restricted or unavailable procfs must not turn a live process into a stale owner.
    return true;
  }
}

function pidNamespace() {
  if (process.platform !== "linux") return "";
  try { return readlinkSync("/proc/self/ns/pid"); } catch { return ""; }
}

function processMayExist(owner) {
  // A PID from another namespace cannot prove that its owner has exited.
  return Boolean(owner.pidNamespace && owner.pidNamespace !== pidNamespace()) || processExists(owner.processId);
}

export async function findDaemon(options = {}) {
  const paths = daemonPaths(options);
  const record = await readJson(paths.state);
  if (!record || record.scopeId !== paths.scopeId || !Number.isSafeInteger(record.processId) || record.processId <= 0) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const health = await (options.readHealth || readHealth)(record.endpoint, { timeoutMs: 1000, ...(options.allowIncompatible ? { allowIncompatible: true } : {}) });
      if (health.scopeId !== paths.scopeId || health.instanceId !== record.instanceId || health.processId !== record.processId) return null;
      return { ...record, health, compatible: health.protocolVersion === PROTOCOL_VERSION, updateAvailable: health.buildId !== paths.buildId };
    } catch (error) {
      if (!processMayExist(record) || ["INVALID_ENDPOINT", "INCOMPATIBLE_SERVICE"].includes(error.code)) return null;
      if (attempt === 0) await delay(100);
    }
  }
  throw new QzError("CONNECTION_UNAVAILABLE", "The qz local service is running but did not respond. Try qz status again shortly.", {
    endpoint: record.endpoint, processId: record.processId, log: paths.log,
  });
}

async function withLock(paths, operation, { timeoutMs = 15000, signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const namespace = pidNamespace();
  const owner = { processId: process.pid, id: randomUUID(), ...(namespace ? { pidNamespace: namespace } : {}) };
  const ownerFile = `${owner.processId}-${owner.id}.json`;
  const candidate = `${paths.lock}.${owner.id}.pending`;
  await mkdir(candidate, { mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let missingTargetPermissionError;
  try {
    signal?.throwIfAborted();
    await writeFile(join(candidate, ownerFile), JSON.stringify(owner), { mode: 0o600 });
    while (true) {
      signal?.throwIfAborted();
      try {
        // The lock becomes visible already containing its unique owner file.
        await rename(candidate, paths.lock);
        acquired = true;
        break;
      } catch (error) {
        const existing = await stat(paths.lock).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!existing) {
          if (process.platform === "win32" && error.code === "EPERM") {
            // Windows reports directory collisions as EPERM. The owner may have
            // released the lock before stat; try the same atomic publication once.
            // A persistent denial remains EPERM rather than becoming a busy lock.
            if (missingTargetPermissionError || Date.now() >= deadline) throw missingTargetPermissionError || error;
            missingTargetPermissionError = error;
            await delay(50, undefined, { signal });
            continue;
          }
          if (!["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error.code)) throw error;
          if (Date.now() >= deadline) throw new QzError("CONNECTION_BUSY", "Another qz command is starting the local service. Try qz status shortly.");
          continue;
        }
        missingTargetPermissionError = undefined;
        if (existing.isDirectory()) {
          for (const name of await readdir(paths.lock).catch(() => [])) {
            if (!/^\d+-[\da-f-]+\.json$/.test(name)) continue;
            const oldPath = join(paths.lock, name);
            const oldOwner = await readJson(oldPath);
            if (oldOwner ? !processMayExist(oldOwner) : Date.now() - existing.mtimeMs > 30000) await rm(oldPath, { force: true });
          }
          // A concurrent new owner keeps its directory non-empty and survives cleanup.
          await rmdir(paths.lock).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
        } else {
          // Recover the file-lock format used by earlier local development builds.
          const oldOwner = await readJson(paths.lock);
          if (oldOwner ? !processMayExist(oldOwner) : Date.now() - existing.mtimeMs > 30000) {
            await rm(paths.lock, { force: true }).catch(error => { if (!["EISDIR", "ERR_FS_EISDIR"].includes(error.code)) throw error; });
          }
        }
        if (Date.now() >= deadline) throw new QzError("CONNECTION_BUSY", "Another qz command is starting the local service. Try qz status shortly.");
        await delay(50, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    return await operation();
  } finally {
    if (acquired) {
      await rm(join(paths.lock, ownerFile), { force: true });
      await rmdir(paths.lock).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
    }
    await rm(candidate, { recursive: true, force: true });
  }
}

function recordFromHealth(endpoint, health) {
  return { service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION, endpoint, scopeId: health.scopeId,
    buildId: health.buildId, instanceId: health.instanceId, processId: health.processId,
    ...(health.pidNamespace ? { pidNamespace: health.pidNamespace } : {}) };
}

async function stopProcess(running) {
  if (running.processId === process.pid) throw new QzError("STOP_FAILED", "The service is running inside this process.");
  if (process.platform === "linux") {
    let args = [];
    try { args = readFileSync(`/proc/${running.processId}/cmdline`, "utf8").split("\0"); } catch {}
    const index = args.indexOf("--run");
    if (index < 1 || basename(args[index - 1]) !== "daemon.mjs"
      || args[index + 2] !== running.scopeId || args[index + 5] !== running.instanceId) {
      throw new QzError("STOP_FAILED", "The service process cannot be verified from this environment. Run qz cleanup from the terminal that started it.");
    }
  }
  try { process.kill(running.processId, "SIGTERM"); }
  catch (error) { if (error.code === "ESRCH") return { stopped: true, connected: false }; throw error; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!processExists(running.processId)) return { stopped: true, connected: false };
    await delay(50);
  }
  throw new QzError("STOP_FAILED", "The local service has not stopped yet. Check qz status.");
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const finish = exited => { clearTimeout(timer); child.off("exit", onExit); resolveExit(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function discardStartup(child, paths, instanceId) {
  if (!Number.isSafeInteger(child?.pid)) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (childExited(child)) break;
    child.kill(signal);
    if (await waitForChildExit(child, 1000)) break;
  }
  if (!childExited(child)) throw new QzError("START_FAILED", "The failed qz startup process has not stopped.", { processId: child.pid, log: paths.log });
  const record = await readJson(paths.state);
  if (record?.processId === child.pid && record.instanceId === instanceId) await rm(paths.state, { force: true });
}

export async function ensureDaemon(options = {}) {
  options.signal?.throwIfAborted();
  const paths = daemonPaths(options);
  // Reuse without writes, but honor an in-progress startup, cleanup or upgrade.
  if (!await lstat(paths.lock).catch(missing)) {
    const existing = await findDaemon({ ...options, stateDir: paths.directory, scopeId: paths.scopeId, buildId: paths.buildId });
    options.signal?.throwIfAborted();
    if (existing && !await lstat(paths.lock).catch(missing)) return existing;
  }
  return withLock(paths, () => ensureDaemonLocked(paths, options), options);
}

async function ensureDaemonLocked(paths, options) {
  options.signal?.throwIfAborted();
  const lookup = { ...options, stateDir: paths.directory, scopeId: paths.scopeId, buildId: paths.buildId };
    // Compatible services retain their loaded code across source edits or npx copies.
    const existing = await findDaemon(lookup);
    options.signal?.throwIfAborted();
    if (existing) return existing;
    const port = options.preferredPort ?? 18765;
    if (port) {
      const endpoint = `http://127.0.0.1:${port}`;
      const health = await (options.readHealth || readHealth)(endpoint, { timeoutMs: 500 }).catch(() => null);
      options.signal?.throwIfAborted();
      if (health?.scopeId === paths.scopeId && Number.isSafeInteger(health.processId) && health.processId > 0) {
        const record = recordFromHealth(endpoint, health);
        await atomicJson(paths.state, record);
        return { ...record, health, compatible: true, updateAvailable: health.buildId !== paths.buildId };
      }
    }
    const instanceId = randomUUID();
    let child;
    try {
      const log = openSync(paths.log, "a", 0o600);
      try {
        options.signal?.throwIfAborted();
        child = (options.spawnProcess || spawn)(process.execPath, [fileURLToPath(import.meta.url), "--run", paths.state, paths.scopeId, String(port), paths.buildId, instanceId], {
          detached: true, stdio: ["ignore", "ignore", log], windowsHide: true,
        });
        await new Promise((resolveSpawn, reject) => {
          child.once("spawn", resolveSpawn);
          child.once("error", reject);
        });
        options.signal?.throwIfAborted();
        child.unref();
      } finally { closeSync(log); }
      const deadline = Date.now() + (options.startTimeoutMs || 10000);
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        const running = await findDaemon(lookup);
        options.signal?.throwIfAborted();
        if (running) {
          if (running.instanceId !== instanceId || running.processId !== child.pid) {
            throw new QzError("START_FAILED", "Another qz service claimed the startup state. Check qz status.", { log: paths.log });
          }
          return running;
        }
        if (childExited(child) || !processExists(child.pid)) break;
        await delay(50, undefined, { signal: options.signal });
      }
      throw new QzError("START_FAILED", "The qz local service did not start.", { log: paths.log });
    } catch (error) {
      // Hold the startup lock until this invocation's child is gone. Otherwise a
      // delayed child could overwrite the state published by a concurrent retry.
      await discardStartup(child, paths, instanceId);
      throw error;
    }
}

/** Replace only the exact service inspected by the caller, under the same startup lock. */
export async function restartDaemon({ expected, ...options } = {}) {
  options.signal?.throwIfAborted();
  const paths = daemonPaths(options);
  return withLock(paths, async () => {
    const running = await findDaemon({ ...options, stateDir: paths.directory, scopeId: paths.scopeId, buildId: paths.buildId, allowIncompatible: true });
    options.signal?.throwIfAborted();
    if (!running || !expected || ["scopeId", "instanceId", "processId"].some(key => running[key] !== expected[key])) {
      throw new QzError("CONNECTION_CHANGED", "The local service changed before its upgrade. Retry the command.");
    }
    await stopProcess(running);
    options.signal?.throwIfAborted();
    return ensureDaemonLocked(paths, options);
  }, options);
}

export async function stopDaemon(options = {}) {
  const paths = daemonPaths(options);
  return withLock(paths, async () => {
    const running = await findDaemon(options);
    options.signal?.throwIfAborted();
    if (!running) return { stopped: false, connected: false };
    return stopProcess(running);
  }, options);
}

// Only daemon-owned runtime names participate; pairing registries and unrelated files stay intact.
const runtimeName = /^([a-f\d]{24})(?:\.json(?:\.[a-f\d-]{36}\.tmp)?|\.log|\.lock(?:\.[a-f\d-]{36}\.pending)?)$/;
const sameInstance = (left, right) => ["service", "scopeId", "instanceId", "processId", "endpoint"].every(key => left?.[key] === right?.[key]);
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };

/** Stop registered installations under their startup locks, without creating a service or browser. */
export async function cleanupDaemons(options = {}) {
  const directory = stateDirectory(options);
  options.signal?.throwIfAborted();
  const names = await readdir(directory).catch(error => missing(error) || []);
  const scopes = [...new Set(names.map(name => runtimeName.exec(name)?.[1]).filter(Boolean))].sort();
  const result = { stopped: 0, removedFiles: 0, skipped: 0, services: [] };
  for (const scopeId of scopes) {
    options.signal?.throwIfAborted();
    const paths = scopePaths(directory, scopeId);
    const item = { scopeId, status: "cleaned" };
    try {
      const lock = await lstat(paths.lock).catch(missing);
      if (lock?.isSymbolicLink()) throw new QzError("CLEANUP_UNVERIFIED", "The service lock is a symbolic link.");
      await withLock(paths, async () => {
        const state = await lstat(paths.state).catch(missing);
        if (state && !state.isFile()) throw new QzError("CLEANUP_UNVERIFIED", "The service record is not a regular file.");
        const record = state ? await readJson(paths.state) : null;
        if (state && (!record || record.service !== SERVICE_NAME || record.scopeId !== scopeId
          || !record.instanceId || !Number.isSafeInteger(record.processId) || record.processId <= 0)) {
          throw new QzError("CLEANUP_UNVERIFIED", "The service record is invalid; its process cannot be identified.");
        }
        if (record) {
          Object.assign(item, { processId: record.processId, endpoint: record.endpoint });
          const running = await findDaemon({ ...options, stateDir: directory, scopeId, buildId: record.buildId || "cleanup", allowIncompatible: true });
          options.signal?.throwIfAborted();
          if (running ? !sameInstance(record, running) || !sameInstance(record, await readJson(paths.state)) : processMayExist(record)) {
            throw new QzError("CLEANUP_UNVERIFIED", "The live process does not match its registered qz service.");
          }
          options.signal?.throwIfAborted();
          if (running) {
            await stopProcess(running);
            result.stopped++;
            item.status = "stopped";
          }
          const current = await readJson(paths.state);
          if (current && !sameInstance(record, current)) throw new QzError("CONNECTION_CHANGED", "The service record changed during cleanup.");
        }
        options.signal?.throwIfAborted();
        const remaining = await readdir(directory);
        for (const name of remaining) {
          if (runtimeName.exec(name)?.[1] !== scopeId || name === `${scopeId}.lock`) continue;
          const path = join(directory, name);
          const entry = await lstat(path).catch(missing);
          if (!entry) continue;
          if (entry.isFile()) {
            await rm(path, { force: true });
            result.removedFiles++;
          } else if (entry.isDirectory() && name.endsWith(".pending")) {
            // A pending starter may already be waiting on our lock. Only dead owners can be removed.
            let removedOwner = false;
            for (const ownerName of await readdir(path).catch(error => missing(error) || [])) {
              if (!/^\d+-[a-f\d-]{36}\.json$/.test(ownerName)) continue;
              const ownerPath = join(path, ownerName);
              const owner = await readJson(ownerPath);
              if (owner && Number.isSafeInteger(owner.processId) && owner.processId > 0 && !processMayExist(owner)) {
                await rm(ownerPath, { force: true });
                result.removedFiles++;
                removedOwner = true;
              }
            }
            // A starter publishes its owner just after mkdir; leave that fresh empty directory alone.
            if (removedOwner || Date.now() - entry.mtimeMs > 30000) {
              await rmdir(path).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
            }
          }
        }
      }, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      result.skipped++;
      Object.assign(item, { status: "skipped", code: error.code || "CLEANUP_FAILED", message: error.message });
    }
    result.services.push(item);
  }
  return result;
}

export async function startManagedBridge({ stateFile, scopeId, buildId = "", instanceId = randomUUID(), port = 18765, startBridge } = {}) {
  const start = startBridge || (await import("./server.mjs")).startBridge;
  const registryPath = stateFile.replace(/\.json$/, "") + ".browsers.json";
  const namespace = pidNamespace();
  const identity = { scopeId, instanceId, buildId, ...(namespace ? { pidNamespace: namespace } : {}) };
  let running;
  try { running = await start({ port, ...identity, registryPath }); }
  catch (error) {
    if (error.code !== "EADDRINUSE" || !port) throw error;
    running = await start({ port: 0, ...identity, registryPath });
  }
  const record = { service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION, endpoint: running.endpoint,
    processId: process.pid, ...identity };
  try { await atomicJson(stateFile, record); }
  catch (error) { await running.close(); throw error; }
  let closing;
  return { ...running, record, close() {
    return closing ||= (async () => {
      await running.close();
      if ((await readJson(stateFile))?.instanceId === instanceId) await rm(stateFile, { force: true });
    })();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, stateFile, scopeId, port, buildId, instanceId] = process.argv;
  if (mode !== "--run" || !stateFile || !scopeId) throw new Error("Internal qz service entry point");
  const running = await startManagedBridge({ stateFile, scopeId, buildId, instanceId, port: Number(port) });
  const shutdown = () => { void running.close().then(() => process.exit(0), () => process.exit(1)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

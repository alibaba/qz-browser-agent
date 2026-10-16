import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
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
  const directory = resolve(options.stateDir || process.env.QZ_STATE_DIR || join(homedir(), ".qz-browser-agent", "run"));
  return { scopeId, buildId: options.buildId || identity.buildId, directory, state: join(directory, `${scopeId}.json`), lock: join(directory, `${scopeId}.lock`), log: join(directory, `${scopeId}.log`) };
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
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function findDaemon(options = {}) {
  const paths = daemonPaths(options);
  const record = await readJson(paths.state);
  if (!record || record.scopeId !== paths.scopeId || !processExists(record.processId)) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const health = await (options.readHealth || readHealth)(record.endpoint, { timeoutMs: 1000 });
      if (health.scopeId !== paths.scopeId || health.instanceId !== record.instanceId || health.processId !== record.processId) return null;
      return { ...record, health, compatible: true, updateAvailable: health.buildId !== paths.buildId };
    } catch (error) {
      if (!processExists(record.processId) || ["invalid_endpoint", "incompatible_service"].includes(error.code)) return null;
      if (attempt === 0) await delay(100);
    }
  }
  throw new QzError("connection_unavailable", "The qz local service is running but did not respond. Try qz status again shortly.", {
    endpoint: record.endpoint, processId: record.processId, log: paths.log,
  });
}

async function withLock(paths, operation, { timeoutMs = 15000 } = {}) {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const owner = { processId: process.pid, id: randomUUID() };
  const ownerFile = `${owner.processId}-${owner.id}.json`;
  const candidate = `${paths.lock}.${owner.id}.pending`;
  await mkdir(candidate, { mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    await writeFile(join(candidate, ownerFile), JSON.stringify(owner), { mode: 0o600 });
    while (true) {
      try {
        // The lock becomes visible already containing its unique owner file.
        await rename(candidate, paths.lock);
        acquired = true;
        break;
      } catch (error) {
        const existing = await stat(paths.lock).catch(() => null);
        if (!existing) {
          if (!["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error.code)) throw error;
          if (Date.now() >= deadline) throw new QzError("connection_busy", "Another qz command is starting the local service. Try qz status shortly.");
          continue;
        }
        if (existing.isDirectory()) {
          for (const name of await readdir(paths.lock).catch(() => [])) {
            if (!/^\d+-[\da-f-]+\.json$/.test(name)) continue;
            const oldPath = join(paths.lock, name);
            const oldOwner = await readJson(oldPath);
            if (oldOwner ? !processExists(oldOwner.processId) : Date.now() - existing.mtimeMs > 30000) await rm(oldPath, { force: true });
          }
          // A concurrent new owner keeps its directory non-empty and survives cleanup.
          await rmdir(paths.lock).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
        } else {
          // Recover the file-lock format used by earlier local development builds.
          const oldOwner = await readJson(paths.lock);
          if (oldOwner ? !processExists(oldOwner.processId) : Date.now() - existing.mtimeMs > 30000) {
            await rm(paths.lock, { force: true }).catch(error => { if (!["EISDIR", "ERR_FS_EISDIR"].includes(error.code)) throw error; });
          }
        }
        if (Date.now() >= deadline) throw new QzError("connection_busy", "Another qz command is starting the local service. Try qz status shortly.");
        await delay(50);
      }
    }
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
    buildId: health.buildId, instanceId: health.instanceId, processId: health.processId };
}

async function stopProcess(running) {
  if (running.processId === process.pid) throw new QzError("stop_failed", "The service is running inside this process.");
  try { process.kill(running.processId, "SIGTERM"); }
  catch (error) { if (error.code === "ESRCH") return { stopped: true, connected: false }; throw error; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!processExists(running.processId)) return { stopped: true, connected: false };
    await delay(50);
  }
  throw new QzError("stop_failed", "The local service has not stopped yet. Check qz status.");
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
  if (!childExited(child)) throw new QzError("start_failed", "The failed qz startup process has not stopped.", { processId: child.pid, log: paths.log });
  const record = await readJson(paths.state);
  if (record?.processId === child.pid && record.instanceId === instanceId) await rm(paths.state, { force: true });
}

export async function ensureDaemon(options = {}) {
  const paths = daemonPaths(options);
  const lookup = { ...options, stateDir: paths.directory, scopeId: paths.scopeId, buildId: paths.buildId };
  return withLock(paths, async () => {
    // A running service keeps its loaded code until an explicit stop. Editing files or
    // invoking another npx cache copy must not interrupt browser tasks or MCP clients.
    const existing = await findDaemon(lookup);
    if (existing) return existing;
    const port = options.preferredPort ?? 18765;
    if (port) {
      const endpoint = `http://127.0.0.1:${port}`;
      const health = await (options.readHealth || readHealth)(endpoint, { timeoutMs: 500 }).catch(() => null);
      if (health?.scopeId === paths.scopeId && processExists(health.processId)) {
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
        child = (options.spawnProcess || spawn)(process.execPath, [fileURLToPath(import.meta.url), "--run", paths.state, paths.scopeId, String(port), paths.buildId, instanceId], {
          detached: true, stdio: ["ignore", "ignore", log], windowsHide: true,
        });
        await new Promise((resolveSpawn, reject) => {
          child.once("spawn", resolveSpawn);
          child.once("error", reject);
        });
        child.unref();
      } finally { closeSync(log); }
      const deadline = Date.now() + (options.startTimeoutMs || 10000);
      while (Date.now() < deadline) {
        const running = await findDaemon(lookup);
        if (running) {
          if (running.instanceId !== instanceId || running.processId !== child.pid) {
            throw new QzError("start_failed", "Another qz service claimed the startup state. Check qz status.", { log: paths.log });
          }
          return running;
        }
        if (childExited(child) || !processExists(child.pid)) break;
        await delay(50);
      }
      throw new QzError("start_failed", "The qz local service did not start.", { log: paths.log });
    } catch (error) {
      // Hold the startup lock until this invocation's child is gone. Otherwise a
      // delayed child could overwrite the state published by a concurrent retry.
      await discardStartup(child, paths, instanceId);
      throw error;
    }
  }, options);
}

export async function stopDaemon(options = {}) {
  const paths = daemonPaths(options);
  return withLock(paths, async () => {
    const running = await findDaemon(options);
    if (!running) return { stopped: false, connected: false };
    return stopProcess(running);
  }, options);
}

export async function startManagedBridge({ stateFile, scopeId, buildId = "", instanceId = randomUUID(), port = 18765, startBridge } = {}) {
  const start = startBridge || (await import("./server.mjs")).startBridge;
  let running;
  try { running = await start({ port, scopeId, instanceId, buildId }); }
  catch (error) {
    if (error.code !== "EADDRINUSE" || !port) throw error;
    running = await start({ port: 0, scopeId, instanceId, buildId });
  }
  const record = { service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION, endpoint: running.endpoint,
    processId: process.pid, scopeId, instanceId, buildId };
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

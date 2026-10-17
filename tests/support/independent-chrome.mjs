import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

export async function until(check, description, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

/** Chrome outlives the CDP client. Recovery assertions run with no debugger or extension page. */
export async function independentChrome({ profile, extensionPath, name, outputDirectory, headless = true }) {
  await mkdir(profile, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const logs = [], crashes = [], launches = [], requests = [];
  let child, browser, context, endpoint, extensionId, version, serial = 0;
  const detach = async () => {
    await browser?.close();
    browser = context = null;
    assert.equal(child.exitCode, null, "CDP detach must leave Chrome running");
  };
  const attach = async () => {
    if (context) return context;
    browser = await chromium.connectOverCDP(endpoint);
    context = browser.contexts()[0];
    const record = page => page.on("crash", () => crashes.push({ at: Date.now(), url: page.url() }));
    context.pages().forEach(record);
    context.on("page", record);
    context.on("request", request => {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(request.url())) {
        requests.push({ at: Date.now(), method: request.method(), url: request.url() });
      }
    });
    version = browser.version();
    return context;
  };
  const stop = async () => {
    await browser?.close().catch(() => {});
    browser = context = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exit, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exit, delay(2000)]);
      }
      assert.ok(child.exitCode !== null || child.signalCode !== null, "owned Chrome must terminate");
    }
  };
  const start = async ({ attachDebugger = true } = {}) => {
    await rm(join(profile, "DevToolsActivePort"), { force: true });
    const netLog = join(outputDirectory, `${name}-${++serial}-netlog.json`);
    const executable = process.env.CHROME_EXECUTABLE || chromium.executablePath();
    const noSandbox = process.platform === "linux" && (process.getuid?.() === 0 || process.env.QZ_TEST_NO_SANDBOX === "1");
    child = spawn(executable, [
      `--user-data-dir=${profile}`, ...(headless ? ["--headless=new"] : []), "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      `--log-net-log=${netLog}`, "--net-log-capture-mode=Default",
      ...(noSandbox ? ["--no-sandbox"] : []), "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => logs.push({ at: Date.now(), source: "stdout", text: chunk.toString() }));
    child.stderr.on("data", chunk => logs.push({ at: Date.now(), source: "stderr", text: chunk.toString() }));
    child.on("error", error => logs.push({ at: Date.now(), error: error.message }));
    launches.push({ at: Date.now(), pid: child.pid, executable, noSandbox, netLog });
    const active = await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chrome exited: ${JSON.stringify(logs.slice(-10))}`);
      return readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => false);
    }, `${name} Chrome debugging endpoint`);
    endpoint = `http://127.0.0.1:${active.trim().split("\n")[0]}`;
    if (attachDebugger) {
      await attach();
      const worker = context.serviceWorkers().find(item => item.url().endsWith("/background/service-worker.js"))
        || await context.waitForEvent("serviceworker", { predicate: item => item.url().endsWith("/background/service-worker.js") });
      extensionId = new URL(worker.url()).host;
    }
  };
  const panel = async () => {
    await attach();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    return page;
  };
  const closeExtensionPages = async () => {
    for (const page of context?.pages() || []) {
      if (page.url().startsWith("chrome-extension://") || page.url().includes("/qz-connect")) await page.close();
    }
  };
  try { await start(); } catch (error) { await stop(); throw error; }
  return { name, profile, logs, crashes, requests, launches, attach, detach, start, stop, panel, closeExtensionPages,
    get context() { return context; }, get endpoint() { return endpoint; }, get extensionId() { return extensionId; },
    get version() { return version; }, get child() { return child; } };
}

/** Uses a normal page target, closes its debugger immediately after the worker stop event. */
export async function stopExtensionWorker(chrome) {
  assert.equal(chrome.context, null, "detach the general CDP client before testing worker recovery");
  const targets = await (await fetch(`${chrome.endpoint}/json/list`)).json();
  const page = targets.find(target => target.type === "page" && !target.url.startsWith("chrome-extension://"));
  assert.ok(page?.webSocketDebuggerUrl);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(), versions = new Map();
  let serial = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
    }
    for (const value of message.method === "ServiceWorker.workerVersionUpdated" ? message.params.versions : []) {
      versions.set(value.versionId, { ...versions.get(value.versionId), ...value });
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP socket timed out")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    await command("ServiceWorker.enable");
    const worker = await until(() => [...versions.values()].find(value => value.scriptURL?.startsWith(`chrome-extension://${chrome.extensionId}/`)), "worker version", 5000);
    assert.equal(worker.runningStatus, "running");
    await command("ServiceWorker.stopWorker", { versionId: worker.versionId });
    await until(() => versions.get(worker.versionId)?.runningStatus === "stopped", "worker stopped", 5000);
    return { stopped: true, versionId: worker.versionId, debuggerTarget: "page", at: Date.now() };
  } finally {
    socket.close();
    for (const call of pending.values()) call.reject(new Error("CDP socket closed"));
  }
}

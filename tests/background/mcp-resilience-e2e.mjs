import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import { startManagedBridge } from "../../services/mcp-bridge/src/daemon.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { chromium } from "playwright";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { EXTENSION_PATH, PROJECT_ROOT } from "../support/isolated-extension-mcp.mjs";

const idleDurationMs = Number(process.env.QINGZHOU_MCP_IDLE_MS || 125000);
assert.ok(Number.isFinite(idleDurationMs) && idleDurationMs >= 120000,
  "QINGZHOU_MCP_IDLE_MS must be a finite duration of at least 120000 ms");
const fixture = await startFixture();
const directory = await mkdtemp(join(tmpdir(), "qz-mcp-resilience-"));
const report = { ok: false, idleDurationMs, idleWorkerConsoleCaptured: false, idleSamples: [] };
let environment, fallback, connectionPage;
try {
  environment = await launchEnvironment();
  report.bridgeConfig = await environment.page.evaluate(async () => {
    const { endpoint, enabled, name, retryCount, status, pollTimeoutMs } =
      (await chrome.storage.local.get("_qingzhou_mcp_bridge"))._qingzhou_mcp_bridge;
    return { endpoint, enabled, name, retryCount, status, pollTimeoutMs };
  });
  const browserPage = await environment.context.newPage();
  await browserPage.goto(fixture.url);
  await environment.page.close();
  await environment.connectionPage.close();
  assert.ok(environment.context.pages().every(page => !page.url().startsWith("chrome-extension://")
    && !page.url().includes("/qz-connect")), "idle observation must have no qz panel or connection page open");
  await environment.detach();
  assert.equal(environment.chrome.exitCode, null, "detaching Playwright must leave the independent Chrome process alive");
  const idleStartedAt = Date.now();
  const pollsBeforeIdle = environment.pollRequests.length;
  progress("idle-start", { pollTimeoutMs: report.bridgeConfig.pollTimeoutMs });
  // Health checks only reach Node. They do not wake the extension or dequeue a browser command.
  while (Date.now() - idleStartedAt < idleDurationMs) {
    await delay(Math.min(10000, idleDurationMs - (Date.now() - idleStartedAt)));
    if (!report.workerStop && Date.now() - idleStartedAt >= 45000) {
      report.workerStop = await stopExtensionWorker(environment);
      report.workerStop.elapsedMs = Date.now() - idleStartedAt;
      progress("worker-stopped", report.workerStop);
    }
    const health = await readHealth(environment.bridge.endpoint);
    const sample = { elapsedMs: Date.now() - idleStartedAt, connected: health.status.connected,
      clientCount: health.status.clientCount, ageSeconds: health.status.clients[0]?.ageSeconds ?? null,
      polls: environment.pollRequests.length - pollsBeforeIdle };
    report.idleSamples.push(sample);
    progress("idle", sample);
  }
  report.idlePolls = environment.pollRequests.length - pollsBeforeIdle;
  assert.ok(report.idleSamples.every(sample => sample.connected && sample.clientCount === 1),
    `connection expired while idle: ${JSON.stringify(report.idleSamples)}`);
  assert.ok(report.idlePolls >= 3, "the extension must renew multiple long polls without an open UI");
  assert.ok(report.workerStop?.stopped, "the test must stop the extension worker during idle observation");
  assert.ok(environment.pollRequests.some(request => request.at > idleStartedAt + report.workerStop.elapsedMs),
    "the extension must resume polling after its worker is stopped without opening the panel or connection page");

  const { runCli } = await import("../../services/mcp-bridge/src/cli.mjs");
  const cliConnection = await runCli(["connect", "--timeout", "10"], {
    ensureDaemon: async () => {
      const health = await readHealth(environment.bridge.endpoint);
      return { endpoint: environment.bridge.endpoint, instanceId: health.instanceId, health };
    },
    openBrowser: () => assert.fail("a live connection must confirm browser readiness without opening a page"),
  });
  assert.equal(cliConnection.result.connected, true);
  report.afterIdleCliConnect = true;

  const created = await call("qingzhou_create_session", { title: "Resilient browser task" });
  const sessionId = created.session.id;
  const opened = await execute("open_tab", { url: fixture.url }, sessionId);
  const tabId = opened.result.id;
  const article = await execute("read_article", { tabId, limit: 1000 }, sessionId);
  assert.match(article.result.text, /MCP resilience fixture/);
  report.afterIdleTool = true;

  const pending = execute("navigate", { tabId, url: `${fixture.url}mutation` }, sessionId)
    .then(result => ({ result }), error => ({ error }));
  await Promise.race([
    until(() => fixture.mutations === 1, "the synthetic navigation did not start"),
    pending.then(outcome => { throw new Error(`The mutation call settled before its observable effect: ${JSON.stringify(outcome)}`); }),
  ]);
  const disconnectedAt = Date.now();
  await environment.bridge.close();
  const interrupted = await pending;
  assert.ok(interrupted.error, "an in-flight call must report the stopped bridge instead of claiming success");
  assert.match(interrupted.error.message, /BRIDGE_CLOSED|stopped|closed|fetch|connect/i);
  assert.ok(Date.now() - disconnectedAt < 5000, "closing the bridge must promptly settle in-flight MCP calls");
  fixture.releaseMutation();
  await delay(250);
  await environment.bridge.restart();
  await until(async () => (await readHealth(environment.bridge.endpoint)).status.connected,
    "the saved endpoint did not reconnect after a brief service interruption", 75000);
  const afterRestart = await execute("read_article", { tabId, limit: 1000 }, sessionId);
  assert.match(afterRestart.result.text, /MCP resilience fixture/);
  assert.equal(fixture.mutations, 1, "reconnection must not replay the dispatched navigation");
  report.inflightDisconnect = { rejected: true, mutationCount: 1, samePortRecovery: true };
  progress("same-port-recovered", report.inflightDisconnect);

  // Count real HTTP failures before restarting, so recovery cannot pass on an unused fast retry.
  // The browser remains detached throughout; only the server receives health checks.
  environment.bridge.rejectPolls = true;
  // Retry attempts are persisted and spaced 30 seconds apart, including across Worker restarts.
  await until(() => environment.failedPollRequests.length >= 3,
    "the extension did not exhaust three failed polls", 110000);
  const exhaustedAt = Date.now();
  progress("retries-exhausted", { failedPolls: environment.failedPollRequests.length });
  await environment.bridge.close();
  await delay(1500);
  await environment.bridge.restart();
  const pollsAtPause = environment.pollRequests.length;
  await delay(35000);
  assert.equal(environment.pollRequests.length, pollsAtPause, "exhausted retries must stop localhost traffic");
  assert.equal((await readHealth(environment.bridge.endpoint)).status.connected, false);
  await environment.attach();
  connectionPage = await environment.context.newPage();
  await connect(environment.bridge.endpoint);
  const recoveredAt = Date.now();
  const afterExplicitConnect = await execute("read_article", { tabId, limit: 1000 }, sessionId);
  assert.match(afterExplicitConnect.result.text, /MCP resilience fixture/);
  assert.equal(fixture.mutations, 1, "explicit reconnection must not replay an interrupted navigation");
  report.boundedRecovery = { failedPolls: environment.failedPollRequests.length,
    exhaustedAt, recoveredAt, pausedWithoutTraffic: true, explicitConnectSucceeded: true };
  progress("bounded-recovery", report.boundedRecovery);

  // Occupy the preferred port with the original service and exercise the real fallback bind.
  await environment.attach();
  const previousEndpoint = environment.bridge.endpoint;
  fallback = await startManagedBridge({ stateFile: join(directory, "fallback.json"), scopeId: "isolated-resilience",
    port: Number(new URL(previousEndpoint).port), buildId: "fixture" });
  assert.notEqual(fallback.endpoint, previousEndpoint);
  await connect(fallback.endpoint);
  const fallbackArticle = await execute("read_article", { tabId, limit: 1000 }, sessionId, fallback.endpoint);
  assert.match(fallbackArticle.result.text, /MCP resilience fixture/);
  await environment.bridge.close();
  await connectionPage.close();
  await delay(1500);
  assert.equal((await readHealth(fallback.endpoint)).status.connected, true);
  assert.equal(fixture.mutations, 1);
  report.portFallback = { previousEndpoint, endpoint: fallback.endpoint, toolSucceeded: true };
  report.ok = true;
  progress("complete", report);
} catch (error) {
  report.error = error.stack || error.message || String(error);
  throw error;
} finally {
  try {
    const resultDirectory = join(PROJECT_ROOT, "tests/results/mcp-bridge");
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(join(resultDirectory, "resilience-e2e.json"), JSON.stringify({ ...report,
      pollRequests: environment?.pollRequests || [], failedPollRequests: environment?.failedPollRequests || [],
      chromeProcessLogs: environment?.bridge.logs || [] }, null, 2));
  } finally {
    fixture.releaseMutation();
    await fallback?.close().catch(() => undefined);
    await environment?.close().catch(() => undefined);
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function progress(stage, details = {}) { console.log(JSON.stringify({ stage, ...details })); }
function call(name, args, endpoint = environment.bridge.endpoint) {
  return callTool(endpoint, name, { ...args, timeoutSeconds: 30 }, { timeoutMs: 30000 });
}
function execute(name, args, sessionId, endpoint) {
  return call("qingzhou_execute_tool", { name, args, sessionId, wait: true }, endpoint);
}
async function connect(endpoint) {
  await connectionPage.goto(`${endpoint}/qz-connect`);
  await connectionPage.locator('[data-qz-connection-state="connected"]').waitFor();
  await until(async () => (await readHealth(endpoint)).status.connected, "extension did not reconnect");
}
async function until(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
async function startFixture() {
  let mutations = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/mutation") { mutations++; await gate; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>MCP resilience fixture</title><main><h1>MCP resilience fixture</h1><p>Deterministic local content.</p></main>");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, get mutations() { return mutations; },
    releaseMutation: release, close: () => new Promise(resolve => server.close(resolve)) };
}

async function launchEnvironment() {
  const profile = join(directory, "profile");
  await mkdir(profile);
  const logs = [], pollRequests = [], failedPollRequests = [];
  const registryPath = join(directory, "browsers.json");
  let node = await startBridge({ port: 0, registryPath, requestTimeoutSeconds: 30 });
  let rejectPolls = false;
  const capturePoll = request => { if (request.url === "/v1/qingzhou/poll") pollRequests.push({ at: Date.now(), url: `${node.endpoint}${request.url}` }); };
  const installFailureInjection = () => {
    const handlers = node.server.listeners("request");
    node.server.removeAllListeners("request");
    node.server.on("request", (request, response) => {
      capturePoll(request);
      if (rejectPolls && request.url === "/v1/qingzhou/poll") {
        failedPollRequests.push({ at: Date.now(), url: `${node.endpoint}${request.url}` });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Isolated resilience outage" }));
        return;
      }
      for (const handler of handlers) handler.call(node.server, request, response);
    });
  };
  installFailureInjection();
  const bridge = { get endpoint() { return node.endpoint; }, logs,
    set rejectPolls(value) { rejectPolls = value; },
    close: () => node.close(), async restart() {
      const port = Number(new URL(node.endpoint).port);
      await node.close();
      rejectPolls = false;
      node = await startBridge({ port, registryPath, requestTimeoutSeconds: 30 });
      installFailureInjection();
    } };
  const chrome = spawn(process.env.CHROME_EXECUTABLE || chromium.executablePath(), [
    `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check",
    ...(process.platform === "linux" && (process.getuid?.() === 0 || process.env.QZ_TEST_NO_SANDBOX === "1") ? ["--no-sandbox"] : []),
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stdout.on("data", chunk => logs.push(chunk.toString()));
  chrome.stderr.on("data", chunk => logs.push(chunk.toString()));
  let browser, context, debugEndpoint;
  const attach = async () => {
    const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    debugEndpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(debugEndpoint);
    context = browser.contexts()[0];
    return context;
  };
  const close = async () => {
    await browser?.close().catch(() => undefined);
    if (chrome.exitCode === null) {
      const exit = new Promise(resolve => chrome.once("exit", resolve));
      chrome.kill("SIGTERM");
      await Promise.race([exit, delay(2500)]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill("SIGKILL");
        await Promise.race([exit, delay(2500)]);
      }
    }
    await bridge.close();
  };
  try {
    await until(async () => {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited early: ${logs.join("")}`);
      return readFile(join(profile, "DevToolsActivePort")).then(() => true, () => false);
    }, "Chrome debugging endpoint did not start");
    await attach();
    await context.route("http://127.0.0.1:18765/**", route => route.abort());
    const isQzWorker = worker => worker.url().endsWith("/background/service-worker.js");
    const worker = context.serviceWorkers().find(isQzWorker) || await context.waitForEvent("serviceworker", { predicate: isQzWorker });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await acceptDataDisclosure(page, { disableBridge: false });
    await page.waitForFunction(() => !document.querySelector("#app")?.hasAttribute("data-workspace-booting"));
    const initialConnection = await context.newPage();
    await initialConnection.goto(`${bridge.endpoint}/qz-connect`);
    await initialConnection.locator('[data-qz-connection-state="connected"]').waitFor();
    await until(async () => (await readHealth(bridge.endpoint)).status.connected, "extension did not connect");
    return { bridge, get context() { return context; }, get debugEndpoint() { return debugEndpoint; }, extensionId,
      page, connectionPage: initialConnection,
      chrome, pollRequests, failedPollRequests, attach, detach: () => browser.close(), close };
  } catch (error) { await close(); throw error; }
}

/** Stop through a normal page's ServiceWorker domain; attaching a worker debugger would keep it alive. */
async function stopExtensionWorker(environment) {
  const targets = await (await fetch(`${environment.debugEndpoint}/json/list`)).json();
  const page = targets.find(target => target.type === "page" && target.url === fixture.url);
  assert.ok(page?.webSocketDebuggerUrl, "a normal browser page must remain available for the worker stop command");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const requests = new Map(), versions = new Map();
  let nextId = 0, stoppedVersionId = "";
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
    for (const version of message.method === "ServiceWorker.workerVersionUpdated" ? message.params.versions : []) {
      const next = { ...versions.get(version.versionId), ...version };
      versions.set(version.versionId, next);
      if (next.scriptURL?.startsWith(`chrome-extension://${environment.extensionId}/`) && next.runningStatus === "stopped") {
        stoppedVersionId = next.versionId;
      }
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
    requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Worker-control connection timed out")); }, 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    await command("ServiceWorker.enable");
    await until(() => [...versions.values()].some(version => version.scriptURL?.startsWith(`chrome-extension://${environment.extensionId}/`)),
      "qz worker version did not appear", 5000);
    const version = [...versions.values()].find(version => version.scriptURL?.startsWith(`chrome-extension://${environment.extensionId}/`));
    assert.equal(version.runningStatus, "running", "the resilience test must stop an actually running worker");
    stoppedVersionId = "";
    await command("ServiceWorker.stopWorker", { versionId: version.versionId });
    await until(() => stoppedVersionId === version.versionId, "Chrome did not report the qz worker stopped", 5000);
    return { versionId: version.versionId, stopped: true, debuggerTarget: "page" };
  } finally {
    socket.close();
    for (const pending of requests.values()) pending.reject(new Error("Worker-control connection closed"));
  }
}

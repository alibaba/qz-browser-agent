import { acceptDataDisclosure } from "./data-consent.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { ensureTestExtension } from "./extension-build.mjs";

export const TEST_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PROJECT_ROOT = dirname(TEST_ROOT);
export const EXTENSION_PATH = await ensureTestExtension();

export async function launchIsolatedExtensionMcp({
  profilePrefix = "qingzhou-mcp-e2e-",
  headless = true,
  requestTimeoutSeconds = 300,
  downloadDirectory,
} = {}) {
  const bridge = await startIsolatedMcpBridge({ requestTimeoutSeconds });
  const diagnostics = [];
  const profile = mkdtempSync(join(tmpdir(), profilePrefix));
  let context = null;
  let page = null;
  const pollRequests = [];
  try {
    const { chromium } = await import("playwright");
    const executablePath = findChromeExecutable(chromium.executablePath());
    if (!executablePath) throw new Error("Chrome executable not found");
    context = await chromium.launchPersistentContext(profile, {
      locale: "zh-CN",
      headless,
      executablePath,
      ...(downloadDirectory ? { downloadsPath: resolve(downloadDirectory) } : {}),
      ignoreDefaultArgs: ["--disable-extensions"],
      viewport: { width: 980, height: 860 },
      args: [
        "--lang=zh-CN",
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    // Keep the compatibility probe away from a developer's bridge on the default port.
    await context.route("http://127.0.0.1:18765/**", route => route.abort());
    attachWorkerDiagnostics(context, diagnostics);
    context.on("request", request => {
      if (new URL(request.url()).pathname === "/v1/qingzhou/poll") {
        pollRequests.push({ at: Date.now(), url: request.url() });
      }
    });
    const extensionId = await getExtensionId(context, profile);
    page = await context.newPage();
    page.on("pageerror", error => diagnostics.push(String(error)));
    page.on("console", message => {
      if (message.type() === "error") diagnostics.push(message.text());
    });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await page.locator("[data-consent-accept]").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(async () =>
      (await chrome.storage.local.get("_qingzhou_mcp_bridge"))._qingzhou_mcp_bridge), undefined,
    "a fresh browser must have no endpoint injected by the fixture");
    const connectionPage = await context.newPage();
    connectionPage.on("pageerror", error => diagnostics.push(String(error)));
    await connectionPage.goto(bridge.connectUrl);
    await connectionPage.locator('[data-qz-connection-code="DATA_CONSENT_REQUIRED"]').waitFor();
    const beforeConsent = await (await fetch(bridge.healthUrl)).json();
    assert.equal(beforeConsent.status.clientCount, 0, "bridge must stay disconnected until data consent");
    assert.equal(pollRequests.length, 0, "the extension must not poll or scan before consent");
    await acceptDataDisclosure(page, { disableBridge: false });
    await page.waitForFunction(() => !document.querySelector("#app")?.hasAttribute("data-workspace-booting"));
    const connect = async () => {
      await connectionPage.goto(bridge.connectUrl);
      await connectionPage.locator('[data-qz-connection-state="connected"]').waitFor();
      return waitForBridgeClient(bridge.healthUrl, 20_000);
    };
    const status = await connect();
    return {
      bridge,
      context,
      page,
      profile,
      extensionId,
      diagnostics,
      pollRequests,
      connectionPage,
      connect,
      bridgeStatus: status,
      waitForConnection: () => waitForBridgeClient(bridge.healthUrl, 20_000),
      async close() {
        await context?.close().catch(() => undefined);
        await bridge.close();
        rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await bridge.close();
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

export async function saveExtensionLlmConfig(page, config, timeoutMs = 45_000) {
  const response = await extensionRequest(page, "save_config", { config }, "config_saved", timeoutMs);
  if (["error", "request_failed", "transport_error"].includes(response.type)) throw new Error(response.message || "save_config failed");
  return response.config || {};
}

export function extensionRequest(page, type, payload = {}, responseType = "", timeoutMs = 30_000) {
  return page.evaluate(({ type, payload, responseType, timeoutMs }) => new Promise((resolvePromise, reject) => {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    const requestId = `isolated_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      port.disconnect();
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    const finish = result => {
      clearTimeout(timer);
      port.disconnect();
      resolvePromise(result);
    };
    port.onMessage.addListener(message => {
      if (message?.type === "dynamic_context_request") {
        port.postMessage({ type: "dynamic_context_response", requestId: message.requestId, context: {} });
        return;
      }
      if (message?.requestId !== requestId) return;
      if (["error", "request_failed", "transport_error"].includes(message.type) || !responseType || message.type === responseType) finish(message);
    });
    port.postMessage({ type, ...payload, requestId });
  }), { type, payload, responseType, timeoutMs });
}

export async function runBridgePython(script, args = [], options = {}) {
  const commandArgs = [
    "run",
    "--project", join(PROJECT_ROOT, "tests", "python"),
    "--default-index", "https://pypi.org/simple",
    "--locked",
    "python", script,
    ...args,
  ];
  return runCommand("uv", commandArgs, options);
}

export function assertNoUnexpectedDiagnostics(diagnostics = [], secrets = []) {
  const unexpected = diagnostics
    .filter(message => !/Receiving end does not exist|message port closed/iu.test(message))
    .map(message => redactSecrets(message, secrets));
  if (unexpected.length) {
    throw new Error(`isolated extension emitted errors:\n${unexpected.slice(-30).join("\n")}`);
  }
}

async function startIsolatedMcpBridge({ requestTimeoutSeconds }) {
  let port = await availablePort();
  let endpoint = `http://127.0.0.1:${port}`;
  const logs = [];
  let child;
  async function start() {
    child = spawn(process.execPath, [
      "--input-type=module", "--eval", `
        import { startBridge } from "./services/mcp-bridge/src/server.mjs";
        const bridge = await startBridge({ port: Number(process.argv[1]), requestTimeoutSeconds: Number(process.argv[2]) });
        for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await bridge.close(); process.exit(0); });
        console.log(JSON.stringify({ endpoint: bridge.endpoint }));
      `, "--", String(port), String(requestTimeoutSeconds),
    ], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => appendLog(logs, chunk));
    child.stderr.on("data", chunk => appendLog(logs, chunk));
    try {
      await waitForHealth(`${endpoint}/health`, child, logs, 20_000);
    } catch (error) {
      await stopChild(child);
      throw error;
    }
  }
  await start();
  return {
    get endpoint() { return endpoint; },
    get mcpUrl() { return `${endpoint}/mcp`; },
    get healthUrl() { return `${endpoint}/health`; },
    get connectUrl() { return `${endpoint}/qz-connect`; },
    logs,
    get process() { return child; },
    close: () => stopChild(child),
    async restart({ newPort = false } = {}) {
      await stopChild(child);
      if (newPort) {
        const previousPort = port;
        do { port = await availablePort(); } while (port === previousPort);
        endpoint = `http://127.0.0.1:${port}`;
      }
      await start();
    },
  };
}

async function waitForHealth(url, child, logs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`MCP Bridge exited early (${child.exitCode}):\n${logs.slice(-30).join("\n")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (_error) {}
    await sleep(100);
  }
  throw new Error(`MCP Bridge did not become healthy:\n${logs.slice(-30).join("\n")}`);
}

async function waitForBridgeClient(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = await response.json();
      if (Number(last?.status?.clientCount || 0) > 0) return last.status;
    } catch (_error) {}
    await sleep(100);
  }
  throw new Error(`isolated extension did not connect to MCP Bridge: ${JSON.stringify(last)}`);
}

async function runCommand(bin, args, { env = {}, stdio = "inherit" } = {}) {
  const child = spawn(bin, args, {
    cwd: PROJECT_ROOT,
    env: cleanUvEnvironment({ ...process.env, ...env }),
    stdio,
  });
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolvePromise(code));
  });
  if (exitCode !== 0) throw new Error(`${bin} ${args.join(" ")} exited with ${exitCode}`);
  return exitCode;
}

async function availablePort() {
  while (true) {
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = server.address().port;
    await new Promise(resolvePromise => server.close(resolvePromise));
    if (port !== 18765) return port;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  const exited = new Promise(resolvePromise => child.once("exit", resolvePromise));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(2500).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(1000)]);
}

async function getExtensionId(browserContext, userDataDir) {
  const existing = browserContext.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  if (existing) return new URL(existing.url()).host;
  try {
    const worker = await browserContext.waitForEvent("serviceworker", {
      predicate: item => item.url().startsWith("chrome-extension://"),
      timeout: 5000,
    });
    return new URL(worker.url()).host;
  } catch (_error) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      for (const candidate of [join(userDataDir, "Default", "Preferences"), join(userDataDir, "Preferences")]) {
        if (!existsSync(candidate)) continue;
        const settings = JSON.parse(readFileSync(candidate, "utf8"))?.extensions?.settings || {};
        const found = Object.entries(settings).find(([, record]) => {
          const path = String(record?.path || record?.manifest?.path || "");
          return path && resolve(path) === resolve(EXTENSION_PATH);
        });
        if (found?.[0]) return found[0];
      }
      await sleep(250);
    }
    throw new Error("Unable to resolve loaded extension id");
  }
}

function attachWorkerDiagnostics(browserContext, output) {
  const attach = worker => worker.on("console", message => {
    if (message.type() === "error") output.push(message.text());
  });
  browserContext.serviceWorkers().forEach(attach);
  browserContext.on("serviceworker", attach);
}

function findChromeExecutable(bundled = "") {
  return [
    process.env.CHROME_EXECUTABLE,
    bundled,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
  ].filter(Boolean).find(existsSync) || "";
}

function cleanUvEnvironment(source) {
  const env = { ...source };
  delete env.VIRTUAL_ENV;
  delete env.UV_INDEX_URL;
  delete env.UV_EXTRA_INDEX_URL;
  return env;
}

function appendLog(logs, chunk) {
  logs.push(...String(chunk || "").split(/\r?\n/u).filter(Boolean));
  if (logs.length > 300) logs.splice(0, logs.length - 300);
}

function redactSecrets(value, secrets) {
  return secrets.filter(Boolean).reduce(
    (text, secret) => text.split(String(secret)).join("[redacted]"),
    String(value || ""),
  );
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

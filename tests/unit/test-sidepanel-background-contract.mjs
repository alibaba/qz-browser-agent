import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createSidepanelChannel,
  SIDEPANEL_CHANNEL_MESSAGE_TYPES,
} from "../../src/background/transports/sidepanel-channel.js";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";
import { createPortClient, PortClientError } from "../../src/sidepanel/features/app/port-client.js";

const sidepanelRoot = "src/sidepanel";
const transportSource = readFileSync("src/background/transports/sidepanel.ts", "utf8");
const runtimeSource = readFileSync("src/background/transports/runtime-message.ts", "utf8");
const product = JSON.parse(readFileSync("src/products/manifest.json", "utf8")).defaultProduct;
const productSource = readFileSync(`src/products/${product}/background/runtime.ts`, "utf8");
const productHandledTypes = new Set([...productSource.matchAll(/case\s+["']([a-z_]+)["']\s*:/g)].map(match => match[1]));
const transportHandledTypes = new Set([...transportSource.matchAll(/case\s+["']([a-z_]+)["']\s*:/g)].map(match => match[1]));
for (const match of transportSource.matchAll(/if \(type === ["']([a-z_]+)["']\)/g)) transportHandledTypes.add(match[1]);
for (const match of transportSource.matchAll(/^    ([a-z_]+):\s*\{ method:/gm)) transportHandledTypes.add(match[1]);
const runtimeHandledTypes = [...runtimeSource.matchAll(/if \(type === ["']([a-z_]+)["']\)/g)].map(match => match[1]);
const handledTypes = new Set([...transportHandledTypes, ...runtimeHandledTypes, ...productHandledTypes, ...SIDEPANEL_CHANNEL_MESSAGE_TYPES]);
const frontendRequestTypes = new Set([sidepanelRoot, `src/products/${product}/sidepanel`].flatMap(root => [...collectFrontendRequestTypes(root)]));
const frontendOutboundTypes = new Set([sidepanelRoot, `src/products/${product}/sidepanel`].flatMap(root => [...collectFrontendOutboundTypes(root)]));

assert.ok(frontendRequestTypes.size > 10, "contract scan should find the Side Panel request surface");
assert.deepEqual(
  [...frontendOutboundTypes].filter(type => !handledTypes.has(type)),
  [],
  "every literal Side Panel message used by the UI must have a Background handler",
);

await everyDeclaredTransportRouteDispatches();
await everyFrontendRequestEchoesItsCorrelationId();
await loopbackClientPreservesSuccessAndFailureContracts();

console.log(`sidepanel/background contracts passed (${frontendOutboundTypes.size} UI messages, ${handledTypes.size} routes)`);

async function everyDeclaredTransportRouteDispatches() {
  const transport = createSidepanelTransport(createApiFixture(), { getWindowId: () => 7 });
  for (const type of [...transportHandledTypes].sort()) {
    const messages = [];
    const handled = await transport.dispatch({
      type,
      requestId: `route-${type}`,
      sessionId: "s1",
      automationId: "a1",
      packageId: "p1",
      loginId: "login-1",
      provider: "custom",
      apiKey: "test-only",
      config: {},
      payload: {},
      skill: {},
    }, { postMessage: message => messages.push(message) });
    assert.equal(handled, true, `declared Background route must dispatch: ${type}`);
  }
}

async function everyFrontendRequestEchoesItsCorrelationId() {
  const api = createApiFixture();
  const transport = createSidepanelTransport(api, { getWindowId: () => 7 });
  for (const type of [...frontendRequestTypes].sort()) {
    if (SIDEPANEL_CHANNEL_MESSAGE_TYPES.has(type)) continue;
    const messages = [];
    const requestId = `contract-${type}`;
    const handled = await transport.dispatch({
      type,
      requestId,
      sessionId: "s1",
      automationId: "a1",
      packageId: "p1",
      loginId: "login-1",
      provider: "custom",
      apiKey: "test-only",
      config: {},
      payload: {},
      skill: {},
    }, { postMessage: message => messages.push(message) });
    assert.equal(handled, true, `Background must handle UI request ${type}`);
    assert.equal(
      messages.some(message => message?.requestId === requestId),
      true,
      `${type} must answer with the originating requestId`,
    );
  }
}

async function loopbackClientPreservesSuccessAndFailureContracts() {
  const api = createApiFixture({
    "sessions.state": async sessionId => {
      if (sessionId === "fail") {
        const error = new Error("state unavailable");
        error.code = "STATE_FAILED";
        error.details = { retryable: true };
        throw error;
      }
      return { sessionId, status: "completed", runtime: { sessionId, status: "completed" } };
    },
  });
  const runtime = createRuntimePortLoopback();
  const channel = createSidepanelChannel({
    normalizeSessionId: value => String(value || "").trim(),
    getRuntime: sessionId => ({ sessionId, status: "completed" }),
  });
  const unregister = channel.register(runtime.backgroundRuntime, createSidepanelTransport(api).dispatch);
  let scheduledTimeouts = 0;
  const client = createPortClient({
    connect: runtime.connect,
    setTimeout(callback, delay) {
      scheduledTimeouts += 1;
      return setTimeout(callback, delay);
    },
    requestTimeoutMs: 500,
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 5,
    shouldKeepAlive: () => false,
  });
  try {
    const state = await client.request("get_state", { sessionId: "s1" });
    assert.equal(state.type, "state");
    assert.equal(state.sessionId, "s1");
    assert.match(state.requestId, /^ui_req_/);

    const timersBeforeUnboundedRequest = scheduledTimeouts;
    await client.request("get_state", { sessionId: "s1" }, null);
    assert.equal(scheduledTimeouts, timersBeforeUnboundedRequest, "a null deadline must not arm a request timeout");

    await assert.rejects(
      client.request("get_state", { sessionId: "fail" }),
      error => error instanceof PortClientError
        && error.code === "STATE_FAILED"
        && error.details.response?.details?.retryable === true,
    );
  } finally {
    client.stop("contract complete");
    unregister();
  }
}

function collectFrontendRequestTypes(root) {
  const types = new Set();
  for (const file of walkJavaScriptFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:options\.)?request\(\s*["']([a-z_]+)["']/g)) {
      types.add(match[1]);
    }
  }
  return types;
}

function collectFrontendOutboundTypes(root) {
  const types = collectFrontendRequestTypes(root);
  for (const file of walkJavaScriptFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:options\.)?(?:send|sendMessage)\(\s*\{\s*type\s*:\s*["']([a-z_]+)["']/g)) {
      types.add(match[1]);
    }
  }
  return types;
}

function walkJavaScriptFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...walkJavaScriptFiles(path));
    else if (/\.[jt]s$/.test(name)) files.push(path);
  }
  return files;
}

function createApiFixture(overrides = {}) {
  const resultFor = (path, args) => {
    if (path === "sessions.stop") {
      const sessionId = args[0] || "s1";
      return { sessionId, status: "aborted", runtime: { sessionId, status: "aborted", running: false } };
    }
    if (path === "sessions.state") {
      const sessionId = args[0] || "s1";
      return { sessionId, status: "idle", runtime: { sessionId, status: "idle" } };
    }
    if (path === "sessions.list") return { sessions: {} };
    if (path === "artifacts.list") return { data: [], files: [] };
    if (path === "config.get" || path === "config.save") return { provider: "custom", model: "test" };
    if (path === "skillSettings.list") return { settings: [] };
    if (path === "skillSettings.save" || path === "skillSettings.remove") return { setting: { id: "demo::plugin", configured: false } };
    if (path === "updates.list" || path === "updates.clear") return [];
    if (path === "trace.get") return [];
    return {};
  };
  const namespaces = [
    "system", "sessions", "artifacts", "attachments", "exchange", "ui", "config", "skillSettings", "auth", "skills",
    "product", "automations", "trace",
  ];
  return Object.fromEntries(namespaces.map(namespace => [namespace, new Proxy({}, {
    get(_target, method) {
      const path = `${namespace}.${String(method)}`;
      if (path === "system.ready") return async () => {};
      if (path === "product.dispatch") return async message => productHandledTypes.has(message.type)
        ? { type: `${message.type}_result`, payload: {} } : null;
      if (path === "sessions.submit") return overrides[path] || (async input => {
        await input.onMessageAccepted?.(
          { clientMessageId: input.clientMessageId || "" },
          { disposition: "started", duplicate: false },
        );
        return {
          accepted: true,
          sessionId: input.sessionId,
          disposition: "started",
          duplicate: false,
          promise: Promise.resolve(),
        };
      });
      return overrides[path] || (async (...args) => resultFor(path, args));
    },
  })]));
}

function createRuntimePortLoopback() {
  const onConnect = makeEvent();
  return {
    backgroundRuntime: { onConnect },
    connect({ name = "sidepanel" } = {}) {
      const client = createPort(name);
      const background = createPort(name);
      client.peer = background;
      background.peer = client;
      queueMicrotask(() => onConnect.emit(background));
      return client;
    },
  };
}

function createPort(name) {
  const onMessage = makeEvent();
  const onDisconnect = makeEvent();
  return {
    name,
    peer: null,
    onMessage,
    onDisconnect,
    postMessage(message) {
      const peer = this.peer;
      if (!peer) throw new Error("port disconnected");
      queueMicrotask(() => peer.onMessage.emit(structuredClone(message)));
    },
    disconnect() {
      const peer = this.peer;
      this.peer = null;
      if (peer) peer.peer = null;
      onDisconnect.emit();
      peer?.onDisconnect.emit();
    },
  };
}

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
  };
}

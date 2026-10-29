import { pairBrowser, browserId, pollBrowser, completeBrowser, resultPayload } from "../support/paired-bridge.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isExtensionBridgeOrigin, startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { BridgeState } from "../../services/mcp-bridge/src/state.mjs";
import { TOOL_CATALOG, executeMcpTool, resultToContent } from "../../services/mcp-bridge/src/tools.mjs";

const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const routingStub = { resolveClient: async id => ({ id, controller: new AbortController() }), signal: signal => signal || new AbortController().signal };
const unpack = result => JSON.parse(result.content[0].text);
async function post(bridge, path, body, headers = {}) {
  if (path.endsWith("/poll") && body?.client?.id) body = { ...body, client: await pairBrowser(bridge.state, body.client) };
  if (path.endsWith("/result") && body?.requestId) body = resultPayload(bridge.state, body.requestId, body);
  return fetch(`${bridge.endpoint}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
async function rawStatus(url, options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
}
async function withBridge(t, options = {}) {
  const bridge = await startBridge({ port: 0, connectWaitMs: 50, ...options });
  t.after(() => bridge.close());
  return bridge;
}
async function withClient(t, bridge) {
  const client = new Client({ name: "bridge-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`)));
  t.after(() => client.close());
  return client;
}
async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("condition timed out");
}

test("Node bridge exposes the existing catalog through a real MCP SDK client", async t => {
  const bridge = await withBridge(t, { instanceId: "instance-test", scopeId: "checkout-test", buildId: "build-test" });
  const health = await (await fetch(`${bridge.endpoint}/health`)).json();
  assert.equal(health.service, "qz-browser-agent");
  assert.equal(health.protocolVersion, 1);
  assert.equal(health.instanceId, "instance-test");
  assert.equal(health.scopeId, "checkout-test");
  assert.equal(health.buildId, "build-test");
  assert.equal(health.processId, process.pid);
  const client = await withClient(t, bridge);
  assert.equal(client.getServerVersion().version,
    JSON.parse(readFileSync(new URL("../../services/mcp-bridge/package.json", import.meta.url), "utf8")).version);
  const catalog = await client.listTools();
  assert.equal(catalog.tools.length, TOOL_CATALOG.length);
  assert.deepEqual(catalog.tools, TOOL_CATALOG);
  assert.equal(catalog.tools.some(tool => tool.name === "qingzhou_bridge_enable_snippet"), false);
  for (const name of ["qingzhou_get_user_input", "qingzhou_respond_to_user_input"]) {
    assert.ok(catalog.tools.some(tool => tool.name === name), `missing task input tool: ${name}`);
  }
  const status = unpack(await client.callTool({ name: "qingzhou_bridge_status", arguments: {} }));
  assert.equal(status.connected, false);
  assert.equal(status.endpoint, bridge.endpoint);
  const invalid = await client.callTool({ name: "qingzhou_send_message", arguments: {} });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid arguments/);
  assert.equal(bridge.state.pending.size, 0);
  const page = await (await fetch(`${bridge.endpoint}/qz-connect`)).text();
  assert.match(page, /data-qz-connection-status/);
  assert.match(page, /https:\/\/chromewebstore\.google\.com\/detail\/dknbdgkgoinlgjpfebapkklbmjjgdblm/);
});

test("token-free routes reject remote Host, browser Origin, and non-JSON requests", async t => {
  const bridge = await withBridge(t);
  for (const path of ["/health", "/qz-connect", "/v1/qingzhou/poll", "/v1/qingzhou/result", "/mcp"]) {
    const method = path === "/health" || path === "/qz-connect" ? "GET" : "POST";
    assert.equal(await rawStatus(`${bridge.endpoint}${path}`, { method, headers: { host: "evil.example" } }), 421);
    for (const origin of ["https://evil.example", "null", "http://127.0.0.1:9999", "chrome-extension://bad"]) {
      const response = await fetch(`${bridge.endpoint}${path}`, { method, headers: { origin } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  }
  for (const path of ["/mcp", "/v1/qingzhou/poll", "/v1/qingzhou/result"]) {
    assert.equal((await fetch(`${bridge.endpoint}${path}`, { method: "POST", body: "{}" })).status, 415);
  }
  assert.equal((await post(bridge, "/v1/qingzhou/result", [])).status, 400);
  assert.equal((await post(bridge, "/v1/qingzhou/result", {})).status, 400);
  const preflight = await fetch(`${bridge.endpoint}/v1/qingzhou/poll`, { method: "OPTIONS", headers: { origin: extensionOrigin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);
  const poll = await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 1 } }, { origin: extensionOrigin });
  assert.deepEqual(await poll.json(), { requests: [], ...bridge.state.connectionInfo(await pairBrowser(bridge.state, { id: "browser" })) });
  assert.equal(bridge.state.status().clientCount, 1);
  await assert.rejects(startBridge({ host: "0.0.0.0", port: 0 }), /loopback/);
});

test("a Firefox extension UUID origin can pair, and other origins stay rejected", async t => {
  const bridge = await withBridge(t);
  const firefoxOrigin = "moz-extension://12345678-1234-5678-9abc-123456789abc";
  const chromeOrigin = `chrome-extension://${"b".repeat(32)}`;
  assert.equal(isExtensionBridgeOrigin(chromeOrigin), true);
  assert.equal(isExtensionBridgeOrigin(firefoxOrigin), true);
  assert.equal(isExtensionBridgeOrigin(`chrome-extension://${"q".repeat(32)}`), false);
  const rejected = [
    "https://evil.example",
    "null",
    "http://127.0.0.1:9999",
    "chrome-extension://bad",
    `chrome-extension://${"q".repeat(32)}`,
    "moz-extension://not-a-uuid",
    "moz-extension://qz-browser-agent@heleifz.github.io",
    "moz-extension://12345678-1234-5678-9abc-123456789abc/sidepanel/sidepanel.html",
    "moz-extension://12345678-1234-5678-9ABC-123456789ABC",
    "MOZ-extension://12345678-1234-5678-9abc-123456789abc",
    "moz-extension://",
  ];
  for (const origin of rejected) {
    assert.equal(isExtensionBridgeOrigin(origin), false, origin);
    const response = await fetch(`${bridge.endpoint}/v1/qingzhou/pair`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
    assert.equal((await response.json()).error, "invalid bridge origin");
  }
  for (const origin of [chromeOrigin, firefoxOrigin]) {
    const mcp = await fetch(`${bridge.endpoint}/mcp`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(mcp.status, 403, origin);
    assert.equal(mcp.headers.get("access-control-allow-origin"), null, origin);
  }
  const health = await fetch(`${bridge.endpoint}/health`, { headers: { origin: firefoxOrigin } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), firefoxOrigin);
  const { instanceId } = await health.json();
  const clientId = randomUUID();
  const connectionId = randomUUID();
  const pairedResponse = await fetch(`${bridge.endpoint}/v1/qingzhou/pair`, {
    method: "POST",
    headers: { origin: firefoxOrigin, "content-type": "application/json" },
    body: JSON.stringify({ clientId, connectionId, instanceId }),
  });
  assert.equal(pairedResponse.status, 200);
  assert.equal(pairedResponse.headers.get("access-control-allow-origin"), firefoxOrigin);
  const paired = await pairedResponse.json();
  assert.equal(paired.clientId, clientId);
  assert.match(paired.pairingToken, /^[A-Za-z0-9_-]{43}$/);
  const denied = await fetch(`${bridge.endpoint}/v1/qingzhou/poll`, {
    method: "POST",
    headers: { origin: firefoxOrigin, "content-type": "application/json" },
    body: JSON.stringify({ client: {
      id: clientId, pairingToken: "wrong-token", pairingVersion: 1, instanceId, connectionId, pollTimeoutMs: 1,
    } }),
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "BRIDGE_PAIRING_REQUIRED");
  const poll = await fetch(`${bridge.endpoint}/v1/qingzhou/poll`, {
    method: "POST",
    headers: { origin: firefoxOrigin, "content-type": "application/json" },
    body: JSON.stringify({ client: {
      id: clientId, pairingToken: paired.pairingToken, pairingVersion: 1, instanceId, connectionId, pollTimeoutMs: 1,
    } }),
  });
  assert.equal(poll.status, 200);
  assert.deepEqual((await poll.json()).requests, []);
  const chromePoll = await post(bridge, "/v1/qingzhou/poll", { client: { id: "chrome-browser", pollTimeoutMs: 1 } }, { origin: chromeOrigin });
  assert.equal(chromePoll.status, 200);
  assert.equal(chromePoll.headers.get("access-control-allow-origin"), chromeOrigin);
  await assert.rejects(startBridge({ host: "0.0.0.0", port: 0 }), /loopback/);
});

test("MCP tools dispatch the original wire messages and preserve run/session identity", async t => {
  const bridge = await withBridge(t);
  const client = await withClient(t, bridge);
  const running = client.callTool({ name: "qingzhou_execute_tool", arguments: {
    name: "inspect_page", args: { tabId: 7 }, sessionId: "session-1", runId: "run-1", timeoutSeconds: 3,
  } });
  const poll = await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 1000 } });
  const [request] = (await poll.json()).requests;
  assert.equal(request.method, "execute_tool");
  assert.deepEqual(request.params, {
    name: "inspect_page", args: { tabId: 7 }, sessionId: "session-1", runId: "run-1", timeoutSeconds: 3,
  });
  assert.equal(request.timeoutMs, 3000);
  const wrongProfile = await post(bridge, "/v1/qingzhou/result", {
    requestId: request.id, clientId: "other-browser", ok: true, result: { heading: "wrong" },
  });
  assert.deepEqual(await wrongProfile.json(), { ok: false });
  assert.equal(bridge.state.inflight.size, 1);
  const response = await post(bridge, "/v1/qingzhou/result", { requestId: request.id, ok: true, result: { heading: "example" } });
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(unpack(await running), { heading: "example" });
  assert.equal(bridge.state.inflight.size, 0);
  assert.deepEqual(await (await post(bridge, "/v1/qingzhou/result", { requestId: request.id, ok: true })).json(), { ok: false });
});

test("missing extension fails promptly and cannot replay a mutation after connection", async t => {
  const bridge = await withBridge(t);
  const client = await withClient(t, bridge);
  const started = Date.now();
  const result = await client.callTool({ name: "qingzhou_create_session", arguments: { title: "not queued" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BRIDGE_NOT_CONNECTED/);
  assert.match(result.content[0].text, /chromewebstore\.google\.com\/detail\/dknbdgkgoinlgjpfebapkklbmjjgdblm/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(bridge.state.pending.size, 0);
  const poll = await post(bridge, "/v1/qingzhou/poll", { client: { id: "late-browser", pollTimeoutMs: 1 } });
  assert.deepEqual((await poll.json()).requests, []);
});

test("live-client leases include the advertised idle interval and require explicit ambiguous targets", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  await pairBrowser(state, { id: "browser-a", pollTimeoutMs: 1000, pollIntervalMs: 60000 });
  await pollBrowser(state, { id: "browser-a", pollIntervalMs: 60000 }, { timeoutMs: 1 });
  state.clients.get(browserId(state, "browser-a")).lastSeenAt -= 40;
  assert.equal(state.status().clientCount, 1);
  await pairBrowser(state, { id: "browser-b" });
  await assert.rejects(state.callExtension("create_session"), /BRIDGE_CLIENT_REQUIRED/);
  await assert.rejects(state.callExtension("create_session", {}, { clientId: "missing" }), /BRIDGE_CLIENT_NOT_FOUND/);
  const result = state.callExtension("ping", {}, { clientId: "browser-b" });
  assert.deepEqual(await pollBrowser(state, { id: "browser-a" }, { timeoutMs: 1 }), []);
  const [request] = await pollBrowser(state, { id: "browser-b" }, { timeoutMs: 1 });
  assert.ok(request);
  assert.equal(completeBrowser(state, request.id, { ok: true, result: "browser-b" }), true);
  assert.equal(await result, "browser-b");
  for (const item of state.clients.values()) item.lastSeenAt -= 200;
  assert.equal(state.status().clientCount, 0);
  state.close();
});

test("cancelled queued and in-flight requests cannot be replayed or completed late", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  await pairBrowser(state, { id: "browser" });
  const queuedAbort = new AbortController();
  const queued = state.callExtension("create_session", {}, { signal: queuedAbort.signal });
  const queuedRejected = assert.rejects(queued, /cancel queued/);
  await waitUntil(() => state.pending.size === 1);
  queuedAbort.abort(new Error("cancel queued"));
  await queuedRejected;
  assert.deepEqual(await pollBrowser(state, { id: "browser" }, { timeoutMs: 1 }), []);
  const inflightAbort = new AbortController();
  const inflight = state.callExtension("create_session", {}, { signal: inflightAbort.signal });
  const inflightRejected = assert.rejects(inflight, /cancel inflight/);
  const [request] = await pollBrowser(state, { id: "browser" }, { timeoutMs: 1 });
  inflightAbort.abort(new Error("cancel inflight"));
  await inflightRejected;
  assert.equal(completeBrowser(state, request.id, { ok: true, result: "late" }), false);
  assert.equal(state.pending.size, 0);
  assert.equal(state.inflight.size, 0);
  state.close();
});

test("async execute_tool jobs survive their initial MCP response and expose success/failure", async t => {
  const bridge = await withBridge(t);
  await pairBrowser(bridge.state, { id: "browser" });
  const client = await withClient(t, bridge);
  const job = unpack(await client.callTool({ name: "qingzhou_execute_tool", arguments: {
    name: "ask_user", args: { message: "choose" }, sessionId: "session-job", runId: "run-job", wait: false,
  } }));
  assert.equal(job.done, false);
  const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  assert.equal(request.params.sessionId, "session-job");
  assert.equal(request.params.runId, "run-job");
  completeBrowser(bridge.state, request.id, { ok: true, result: { selectedIds: ["one"] } });
  await waitUntil(() => bridge.state.getJob(job.jobId).done);
  const done = unpack(await client.callTool({ name: "qingzhou_get_tool_job", arguments: { jobId: job.jobId } }));
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, { selectedIds: ["one"] });
  assert.equal(Object.hasOwn(bridge.state.getJob(job.jobId, false), "result"), false);
  const failed = bridge.state.startExtensionJob("ping");
  const [second] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  completeBrowser(bridge.state, second.id, { ok: false, code: "TAB_MISSING", error: "The tab is gone" });
  await waitUntil(() => bridge.state.getJob(failed.jobId).done);
  assert.match(bridge.state.getJob(failed.jobId).error, /TAB_MISSING.*tab is gone/);
});

test("Skill wrappers dispatch current methods with default arguments and do not retry missing methods", async () => {
  const calls = [];
  const state = { ...routingStub, async callExtension(method, params, options) {
    calls.push({ method, params, clientId: options.clientId });
    return { content: "# Skill" };
  } };
  const result = await executeMcpTool(state, "qingzhou_get_skill", { name: "example", clientId: "browser" });
  assert.deepEqual(result, { content: "# Skill" });
  assert.deepEqual(calls, [
    { method: "get_skill", params: { name: "example", includeContent: true, includeResources: false, timeoutSeconds: null }, clientId: "browser" },
  ]);
  const failed = [];
  await assert.rejects(executeMcpTool({ ...routingStub, callExtension: async method => { failed.push(method); throw new Error("METHOD_NOT_FOUND"); } }, "qingzhou_get_skill", { name: "example" }), /METHOD_NOT_FOUND/);
  assert.deepEqual(failed, ["get_skill"]);
  calls.length = 0;
  await executeMcpTool(state, "qingzhou_send_message", { text: "hello" });
  assert.deepEqual(calls[0].params, { text: "hello", steer: false, sessionId: "default", wait: false, waitForStart: true, waitForStartMs: 2000, timeoutSeconds: null });
  calls.length = 0;
  await executeMcpTool(state, "qingzhou_abort_session", { sessionId: "session" });
  assert.equal(calls[0].method, "stop_session");
});

test("message steering preserves the selected task and rejects malformed flags before dispatch", async () => {
  const calls = [];
  const state = { ...routingStub, callExtension: async (method, params, options) => { calls.push({ method, params, options }); return { accepted: true }; } };
  await executeMcpTool(state, "qingzhou_send_message", { sessionId: "specific-task", text: "Use the official source.", steer: true, clientId: "browser-b" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "send_message");
  assert.equal(calls[0].params.sessionId, "specific-task");
  assert.equal(calls[0].params.steer, true);
  assert.equal(calls[0].options.clientId, "browser-b");
  for (const steer of ["true", 1, null, {}]) {
    await assert.rejects(executeMcpTool(state, "qingzhou_send_message", { sessionId: "specific-task", text: "Invalid", steer }), /Invalid arguments/);
  }
  assert.equal(calls.length, 1);
});

test("task input and response templates retain the explicitly selected browser without mutating extension results", async () => {
  const template = Object.freeze({ sessionId: "task", waitId: "wait", action: "submit", answers: { city: "<answer>" } });
  const input = Object.freeze({ sessionId: "task", waitId: "wait", waiting: true, kind: "form", responseTemplate: template });
  const cases = [
    ["qingzhou_get_user_input", { sessionId: "task" }, input],
    ...["qingzhou_get_session_snapshot", "qingzhou_get_session_state"].map(name => [name, { sessionId: "task" }, Object.freeze({ input })]),
    ["qingzhou_send_message", { sessionId: "task", text: "Continue" }, Object.freeze({ accepted: true, input })],
    ["qingzhou_respond_to_user_input", { sessionId: "task", waitId: "old", action: "submit", answers: {} }, Object.freeze({ accepted: false, code: "STALE_WAIT", input })],
    ["qingzhou_continue_task", { sessionId: "task", waitId: "wait" }, Object.freeze({ accepted: false, code: "ANSWERS_REQUIRED", input })],
    ["qingzhou_submit_wait_form", { sessionId: "task", waitId: "wait", answers: {} }, Object.freeze({ accepted: false, code: "INVALID_ANSWERS", input })],
    ["qingzhou_cancel_wait", { sessionId: "task", waitId: "old" }, Object.freeze({ accepted: false, code: "STALE_WAIT", input })],
  ];
  for (const [name, args, source] of cases) {
    const result = await executeMcpTool({ ...routingStub, async callExtension(method, params, options) {
      assert.equal(method, name.slice("qingzhou_".length));
      assert.equal(options.clientId, "browser-b");
      assert.equal(Object.hasOwn(params, "clientId"), false);
      return source;
    } }, name, { ...args, clientId: "browser-b" });
    const actual = name === "qingzhou_get_user_input" ? result : result.input;
    assert.equal(actual.clientId, "browser-b", name);
    assert.deepEqual(actual.responseTemplate, { ...template, clientId: "browser-b" }, name);
    assert.notEqual(actual, input, name);
    assert.notEqual(actual.responseTemplate, template, name);
    assert.notEqual(result, source, name);
    assert.equal(Object.hasOwn(input, "clientId"), false);
    assert.equal(Object.hasOwn(template, "clientId"), false);
  }
});

test("browser binding preserves native/manual input and does not decorate unrelated or unselected results", async () => {
  const native = Object.freeze({ sessionId: "task", waiting: true, kind: "browser_permission", requiresUserAction: true, responseTemplate: null });
  const get = (source, name, args) => executeMcpTool({ ...routingStub, async callExtension() { return source; } }, name, args);
  assert.deepEqual(await get(native, "qingzhou_get_user_input", { sessionId: "task", clientId: "browser-b" }), { ...native, clientId: "browser-b" });
  const idle = Object.freeze({ sessionId: "task", waiting: false });
  assert.deepEqual(await get(idle, "qingzhou_get_user_input", { sessionId: "task", clientId: "browser-b" }), { ...idle, clientId: "browser-b" });
  assert.equal(await get(native, "qingzhou_get_user_input", { sessionId: "task" }), native);
  assert.equal(await get(native, "qingzhou_get_user_input", { sessionId: "task", clientId: "  " }), native);
  const snapshot = Object.freeze({ input: native });
  assert.equal(await get(snapshot, "qingzhou_get_session_snapshot", { sessionId: "task" }), snapshot);
  assert.equal(await get(snapshot, "qingzhou_call", { method: "get_session_snapshot", clientId: "browser-b" }), snapshot);
  assert.equal(await get(snapshot, "qingzhou_get_config", { clientId: "browser-b" }), snapshot);
  assert.equal(await get(null, "qingzhou_get_user_input", { sessionId: "task", clientId: "browser-b" }), null);
  const completed = Object.freeze({ accepted: true, input: null });
  assert.deepEqual(await get(completed, "qingzhou_respond_to_user_input", { sessionId: "task", waitId: "wait", action: "reject", clientId: "browser-b" }), { ...completed, clientId: "browser-b" });
});

test("wait tools require a non-empty wait ID before dispatch", async () => {
  let calls = 0;
  const state = { ...routingStub, async callExtension(method, params) { calls++; return { method, waitId: params.waitId }; } };
  for (const name of ["qingzhou_continue_task", "qingzhou_submit_wait_form", "qingzhou_cancel_wait"]) {
    const definition = TOOL_CATALOG.find(tool => tool.name === name);
    assert.ok(definition.inputSchema.required.includes("waitId"));
    const args = { sessionId: "task", ...(name === "qingzhou_submit_wait_form" ? { answers: {} } : {}) };
    for (const missing of [args, { ...args, waitId: "" }]) {
      const before = calls;
      await assert.rejects(executeMcpTool(state, name, missing), /Invalid arguments/);
      assert.equal(calls, before);
    }
    assert.deepEqual(await executeMcpTool(state, name, { ...args, waitId: "wait" }), {
      method: name.slice("qingzhou_".length), waitId: "wait",
    });
  }
  assert.equal(calls, 3);
});

test("a returned MCP response template routes the reply to its browser when multiple profiles are connected", async t => {
  const bridge = await withBridge(t);
  for (const id of ["browser-a", "browser-b"]) await pairBrowser(bridge.state, { id });
  const client = await withClient(t, bridge);
  const reading = client.callTool({ name: "qingzhou_get_user_input", arguments: { sessionId: "task", clientId: "browser-b" } });
  const [request] = await pollBrowser(bridge.state, { id: "browser-b" }, { timeoutMs: 1000 });
  const input = { sessionId: "task", waitId: "wait", waiting: true, kind: "form",
    responseTemplate: { sessionId: "task", waitId: "wait", action: "submit", answers: { city: "<answer>" } } };
  completeBrowser(bridge.state, request.id, { ok: true, result: input });
  const received = unpack(await reading);
  assert.equal(received.clientId, browserId(bridge.state, "browser-b"));
  const responding = client.callTool({ name: "qingzhou_respond_to_user_input", arguments: {
    ...received.responseTemplate, answers: { city: "Hangzhou" },
  } });
  assert.deepEqual(await pollBrowser(bridge.state, { id: "browser-a" }, { timeoutMs: 1 }), []);
  const [reply] = await pollBrowser(bridge.state, { id: "browser-b" }, { timeoutMs: 1000 });
  assert.equal(reply.method, "respond_to_user_input");
  assert.equal(reply.params.sessionId, "task");
  assert.equal(reply.params.waitId, "wait");
  assert.deepEqual(reply.params.answers, { city: "Hangzhou" });
  completeBrowser(bridge.state, reply.id, { ok: true, result: { accepted: true, sessionId: "task", waitId: "wait" } });
  assert.equal(unpack(await responding).accepted, true);
});

test("shutdown rejects pending work and closes long polls", async () => {
  const bridge = await startBridge({ port: 0 });
  const polling = post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 30000 } });
  await waitUntil(() => bridge.state.status().clientCount === 1);
  const closing = bridge.close();
  await polling.catch(() => undefined);
  await closing;
  await assert.rejects(bridge.state.callExtension("create_session"), /BRIDGE_CLOSED/);
  assert.equal(bridge.server.listening, false);
});


test("MCP cancellation removes a queued operation before extension delivery", async t => {
  const bridge = await withBridge(t);
  await pairBrowser(bridge.state, { id: "browser" });
  const client = await withClient(t, bridge);
  const controller = new AbortController();
  const result = client.callTool({ name: "qingzhou_create_session", arguments: {} }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(result);
  await waitUntil(() => bridge.state.pending.size === 1);
  controller.abort(new Error("cancel MCP operation"));
  await rejected;
  await waitUntil(() => bridge.state.pending.size === 0);
  assert.deepEqual(await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1 }), []);
});

test("request timeout clears delivery state and rejects late completion", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  await pairBrowser(state, { id: "browser" });
  const waiting = state.callExtension("ping", {}, { timeoutSeconds: 1 });
  const rejected = assert.rejects(waiting, /BRIDGE_REQUEST_TIMEOUT/);
  const [request] = await pollBrowser(state, { id: "browser" }, { timeoutMs: 1 });
  await rejected;
  assert.equal(completeBrowser(state, request.id, { ok: true, result: "late" }), false);
  assert.equal(state.pending.size, 0);
  assert.equal(state.inflight.size, 0);
  state.close();
});


test("MCP result content retains FastMCP list/string/null serialization", () => {
  assert.deepEqual(resultToContent(null), []);
  assert.deepEqual(resultToContent(["plain", { value: 1 }, null]), [
    { type: "text", text: "plain" }, { type: "text", text: '{\n  "value": 1\n}' },
  ]);
});

test("MCP session deletion cancels pending work and invalidates the old session", async t => {
  const bridge = await withBridge(t);
  await pairBrowser(bridge.state, { id: "browser" });
  const client = new Client({ name: "session-cleanup-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());
  const sessionId = transport.sessionId;
  const pending = client.callTool({ name: "qingzhou_create_session", arguments: {} });
  const settled = pending.catch(error => error);
  await waitUntil(() => bridge.state.pending.size === 1);
  await transport.terminateSession();
  await client.close();
  await settled;
  await waitUntil(() => bridge.state.pending.size === 0);
  const stale = await fetch(`${bridge.endpoint}/mcp`, { headers: { "mcp-session-id": sessionId } });
  assert.equal(stale.status, 404);
  assert.equal(bridge.state.events.listenerCount("change"), 0);
});

test("stopping the bridge settles an in-flight MCP operation without replay", async t => {
  const bridge = await withBridge(t);
  await pairBrowser(bridge.state, { id: "browser" });
  const client = await withClient(t, bridge);
  const pending = client.callTool({ name: "qingzhou_create_session", arguments: {} }, undefined, { timeout: 2000 });
  const settled = pending.catch(error => error);
  const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  assert.ok(request);
  await bridge.close();
  const result = await settled;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BRIDGE_CLOSED/);
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
  assert.equal(completeBrowser(bridge.state, request.id, { ok: true, result: "late" }), false);
  assert.equal(bridge.state.events.listenerCount("change"), 0);
});

test("an abandoned MCP POST cancels only its operation and never replays it", async t => {
  const bridge = await withBridge(t);
  await (await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 100 } })).json();
  const client = new Client({ name: "disconnect-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());
  for (const phase of ["queued", "inflight"]) {
    const controller = new AbortController();
    const abandonedResponse = fetch(`${bridge.endpoint}/mcp`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": transport.sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: `abandon-${phase}`, method: "tools/call",
        params: { name: "qingzhou_create_session", arguments: { title: "abandoned", timeoutSeconds: 3 } } }),
    });
    const abandoned = abandonedResponse.then(response => response.text()).catch(error => error);
    const survivor = client.callTool({ name: "qingzhou_create_session", arguments: { title: "survivor", timeoutSeconds: 3 } });
    await waitUntil(() => bridge.state.pending.size === 2);
    let requests;
    if (phase === "inflight") {
      requests = (await (await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", maxBatch: 2 } })).json()).requests;
      assert.equal(requests.length, 2);
    }
    controller.abort();
    await abandoned;
    await waitUntil(() => bridge.state.pending.size + bridge.state.inflight.size === 1);
    if (phase === "queued") {
      requests = (await (await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 100 } })).json()).requests;
      assert.deepEqual(requests.map(request => request.params.title), ["survivor"]);
    } else {
      const late = requests.find(request => request.params.title === "abandoned");
      assert.deepEqual(await (await post(bridge, "/v1/qingzhou/result", {
        requestId: late.id, clientId: "browser", ok: true, result: "too late",
      })).json(), { ok: false });
    }
    const survivingRequest = requests.find(request => request.params.title === "survivor");
    await post(bridge, "/v1/qingzhou/result", { requestId: survivingRequest.id, clientId: "browser", ok: true, result: { phase } });
    assert.deepEqual(unpack(await survivor), { phase, clientId: browserId(bridge.state) });
    assert.equal((await client.listTools()).tools.length, TOOL_CATALOG.length);
  }
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
});

test("MCP idle expiry releases abandoned sessions while active GET and POST responses survive", async t => {
  const bridge = await withBridge(t, { mcpSessionIdleTimeoutMs: 100 });
  const client = new Client({ name: "session-expiry-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());
  const sessionId = transport.sessionId;
  await delay(180);
  assert.equal((await client.listTools()).tools.length, TOOL_CATALOG.length, "active GET SSE keeps the session alive");
  await client.close();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pendingResponse = fetch(`${bridge.endpoint}/mcp`, {
    method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: "long-post", method: "tools/call",
      params: { name: "qingzhou_create_session", arguments: { title: "active POST", timeoutSeconds: 3, clientId: "browser" } } }),
  });
  const poll = await post(bridge, "/v1/qingzhou/poll", { client: { id: "browser", pollTimeoutMs: 1000 } });
  const [request] = (await poll.json()).requests;
  assert.ok(request);
  await delay(180);
  assert.equal(bridge.state.inflight.size, 1, "active POST survives the idle deadline");
  await post(bridge, "/v1/qingzhou/result", { requestId: request.id, clientId: "browser", ok: true, result: { preserved: true } });
  assert.match(await (await pendingResponse).text(), /preserved/);
  await delay(180);
  const expired = await fetch(`${bridge.endpoint}/mcp`, { headers: { "mcp-session-id": sessionId, accept: "text/event-stream" } });
  assert.equal(expired.status, 404);
  await expired.text();
  assert.equal(bridge.state.events.listenerCount("change"), 0);
});

test("repeated real SDK calls and overlapping HTTP polls preserve isolation and settle cancellations", async t => {
  const bridge = await withBridge(t);
  const delivered = new Set();
  for (let round = 0; round < 6; round++) {
    const client = new Client({ name: `stress-${round}`, version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`));
    await client.connect(transport);
    try {
      for (const id of ["browser-a", "browser-b"]) {
        await (await post(bridge, "/v1/qingzhou/poll", { client: { id, pollTimeoutMs: 100 } })).json();
      }
      const cancellation = new AbortController();
      const cancelled = client.callTool({ name: "qingzhou_create_session", arguments: { title: "cancelled", clientId: "browser-a", timeoutSeconds: 3 } },
        undefined, { signal: cancellation.signal }).catch(error => error);
      const jobs = Array.from({ length: 8 }, (_, index) => {
        const target = index % 2 ? "browser-b" : "browser-a";
        return { index, target, result: client.callTool({ name: "qingzhou_call", arguments: {
          method: "ping", params: { round, index, target }, clientId: target, timeoutSeconds: 3,
        } }) };
      });
      await waitUntil(() => bridge.state.pending.size === 9);
      cancellation.abort(); await cancelled;
      await waitUntil(() => bridge.state.pending.size === 8);
      const polls = await Promise.all(["browser-a", "browser-a", "browser-b", "browser-b"].map(async id => {
        const response = await post(bridge, "/v1/qingzhou/poll", { client: { id, pollTimeoutMs: 500, maxBatch: 2 } });
        return { id, requests: (await response.json()).requests };
      }));
      assert.equal(polls.reduce((sum, poll) => sum + poll.requests.length, 0), 8);
      await Promise.all(polls.flatMap(({ id, requests }) => requests.map(async request => {
        assert.equal(request.params.target, id);
        assert.equal(delivered.has(request.id), false, "overlapping polls cannot duplicate delivery");
        delivered.add(request.id);
        const body = { requestId: request.id, clientId: id, ok: true, result: request.params };
        assert.deepEqual(await (await post(bridge, "/v1/qingzhou/result", body)).json(), { ok: true });
        assert.deepEqual(await (await post(bridge, "/v1/qingzhou/result", body)).json(), { ok: false });
      })));
      for (const job of jobs) assert.deepEqual(unpack(await job.result), { round, index: job.index, target: job.target });
      assert.equal(bridge.state.pending.size, 0);
      assert.equal(bridge.state.inflight.size, 0);
      const sessionId = transport.sessionId;
      await transport.terminateSession();
      const stale = await fetch(`${bridge.endpoint}/mcp`, { headers: { "mcp-session-id": sessionId } });
      assert.equal(stale.status, 404); await stale.text();
    } finally { await client.close(); }
  }
  assert.equal(delivered.size, 48);
  assert.equal(bridge.state.events.listenerCount("change"), 0);
});

test("aborted long polls release their listeners and a fresh HTTP poll receives new work", async t => {
  const bridge = await withBridge(t);
  const browser = await pairBrowser(bridge.state, { id: "restarted-browser", pollTimeoutMs: 30000 });
  for (let round = 0; round < 10; round++) {
    const controller = new AbortController();
    const response = fetch(`${bridge.endpoint}/v1/qingzhou/poll`, {
      method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: browser }),
    }).catch(error => error);
    await waitUntil(() => bridge.state.events.listenerCount("change") === 1);
    controller.abort();
    await response;
    await waitUntil(() => bridge.state.events.listenerCount("change") === 0);
  }
  assert.equal(bridge.state.status().clientCount, 1);
  const client = await withClient(t, bridge);
  const running = client.callTool({ name: "qingzhou_call", arguments: {
    method: "ping", clientId: "restarted-browser", params: { recovered: true }, timeoutSeconds: 3,
  } });
  const [request] = (await (await post(bridge, "/v1/qingzhou/poll", { client: { id: "restarted-browser", pollTimeoutMs: 1000 } })).json()).requests;
  assert.ok(request);
  await post(bridge, "/v1/qingzhou/result", { requestId: request.id, clientId: "restarted-browser", ok: true, result: request.params });
  assert.deepEqual(unpack(await running), { recovered: true });
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
  assert.equal(bridge.state.events.listenerCount("change"), 0);
});

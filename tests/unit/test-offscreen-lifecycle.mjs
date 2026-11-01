import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { createBackgroundApi } from "../../src/background/background-api.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { createSkillNetworkService } from "../../src/background/skills/skill-network.js";
import { encodeMessage, MESSAGE_FRAME_BYTES } from "../../src/shared/transport/message-codec.js";
import { requestRuntimeMessage, RUNTIME_REQUEST_PORT } from "../../src/shared/transport/runtime-request.js";
import { createFakeEvent } from "../sidepanel-rendering/fake-port.js";

// Run the real compiled entry against controlled browser messages and clocks.
const compiled = (await build({ entryPoints: ["src/offscreen.ts"], bundle: true, write: false,
  format: "iife", platform: "browser", target: "chrome114", logLevel: "silent" })).outputFiles[0].text;
const tick = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
function fixture({ connect, sendMessage } = {}) {
  let runtimeListener, messageListener, frame;
  const timers = new Map(), sent = [], posted = [], frames = [];
  let sequence = 0, tool = async () => ({ ok: true, result: "tool value" });
  const context = vm.createContext({ console, TextEncoder, TextDecoder, AbortController, btoa, atob, setInterval() {},
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`,
      connect,
      onMessage: { addListener: listener => { runtimeListener = listener; } },
      sendMessage: async message => { sent.push(message); return sendMessage ? sendMessage(message) : message.type === "run_script_tool_call" ? tool(message) : {}; },
    } },
    window: { addEventListener: (_type, listener) => { messageListener = listener; } },
    document: { createElement: () => {
      const item = { style: {}, contentWindow: { postMessage: message => posted.push(message) }, remove() { item.removed = true; } };
      frames.push(item); return item;
    }, body: { appendChild: item => { frame = item; } } },
  });
  vm.runInContext(compiled, context);
  return { sent, posted, frames, timers,
    setTool: fn => { tool = fn; },
    send(message) { let ack; runtimeListener(message, { id: "fixture" }, value => { ack = value; }); return ack; },
    sandbox(message, source = frame?.contentWindow) { messageListener({ source, data: { source: "qz-inner-runner-sandbox", ...message } }); },
    expire(delay = 3000) { for (const [id, timer] of [...timers]) { if (timer.delay === delay) { timers.delete(id); timer.fn(); } } },
  };
}
const execute = requestId => ({ type: "run_script_inner_execute", requestId, sessionId: "s", runId: "r", source: "return 1" });
const results = f => f.sent.filter(message => message.type === "run_script_inner_result");

test("concurrent sandbox startup shares one deadline and all callers recover after failure", async () => {
  const f = fixture();
  assert.equal(f.send(execute("one")).accepted, true);
  f.send(execute("two"));
  assert.equal(f.frames.length, 1);
  f.expire(); await tick();
  assert.deepEqual(results(f).map(message => [message.requestId, message.result.code]), [["one", "INNER_RUNNER_SANDBOX_NOT_READY"], ["two", "INNER_RUNNER_SANDBOX_NOT_READY"]]);
  assert.equal(f.frames[0].removed, true);
  f.send(execute("retry")); f.sandbox({ type: "ready" }); await tick();
  assert.equal(f.frames.length, 2);
  assert.deepEqual(f.posted.filter(message => message.type === "execute").map(message => message.requestId), ["retry"]);
  assert.equal(f.timers.size, 0, "successful readiness clears the shared deadline");
  f.sandbox({ type: "result", requestId: "retry", result: { ok: true, result: 1 } }); await tick();
  assert.equal(results(f).at(-1).result.result, 1);
});

test("cancelling before ready settles once and never starts the late script", async () => {
  const f = fixture(); f.send(execute("cancel"));
  f.send({ type: "run_script_inner_cancel", requestId: "cancel" });
  f.sandbox({ type: "ready" }); await tick();
  assert.equal(f.posted.some(message => message.type === "execute"), false);
  assert.equal(results(f).length, 1);
  assert.equal(results(f)[0].result.code, "OPERATION_ABORTED");
  f.sandbox({ type: "result", requestId: "cancel", result: { ok: true } }); await tick();
  assert.equal(results(f).length, 1);
});

test("tool relay preserves identity and drops responses after run cancellation", async () => {
  const f = fixture(); let release;
  f.setTool(() => new Promise(resolve => { release = resolve; }));
  f.send({ ...execute("tool"), parentCallId: "parent-call" }); f.sandbox({ type: "ready" }); await tick();
  f.sandbox({ type: "tool_call", requestId: "tool", callId: "call", toolName: "read", args: {} }); await tick();
  const call = f.sent.find(message => message.type === "run_script_tool_call");
  assert.equal(call.sessionId, "s"); assert.equal(call.runId, "r"); assert.equal(call.depth, 1);
  assert.equal(call.parentCallId, "parent-call");
  f.send({ type: "run_script_inner_cancel", requestId: "tool" });
  release({ ok: true, result: "late" }); await tick();
  assert.equal(f.posted.some(message => message.type === "tool_response"), false);
});

test("foreign windows cannot mark the owned sandbox ready or complete a run", async () => {
  const f = fixture(); f.send(execute("owned"));
  f.sandbox({ type: "ready" }, {}); await tick();
  assert.equal(f.posted.some(message => message.type === "execute"), false);
  f.sandbox({ type: "result", requestId: "owned", result: { ok: true } }, {}); await tick();
  assert.equal(results(f).length, 0);
  f.expire(); await tick();
  assert.equal(results(f)[0].result.code, "INNER_RUNNER_SANDBOX_NOT_READY");
});

test("native script results retain the original payload above the Port chunk threshold", async () => {
  const f = fixture();
  const content = "x".repeat(9 * 1024 * 1024);
  f.send(execute("large-result")); f.sandbox({ type: "ready" }); await tick();
  f.sandbox({ type: "result", requestId: "large-result", result: { ok: true, result: content } });
  await tick();
  assert.equal(results(f).length, 1);
  assert.equal(results(f)[0].result.result, content);
});

test("native tool arguments retain the original payload above the Port chunk threshold", async () => {
  const f = fixture();
  const content = "x".repeat(9 * 1024 * 1024);
  f.send(execute("large-tool")); f.sandbox({ type: "ready" }); await tick();
  f.sandbox({ type: "tool_call", requestId: "large-tool", callId: "large-call", toolName: "read", args: { text: content } });
  await tick();
  assert.equal(f.sent.find(message => message.type === "run_script_tool_call").args.text, content);
  assert.equal(f.posted.find(message => message.type === "tool_response").response.ok, true);
});

test("Skill inner fetch reassembles a legal 7 MiB response through the real runtime adapter", async t => {
  const body = Buffer.alloc(7 * 1024 * 1024);
  for (let index = 0; index < body.length; index++) body[index] = index % 251;
  const bridge = skillFetchBridge(t, { fetch: async () => new Response(body, { headers: { "x-fixture": "binary" } }) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "binary");
  f.sandbox(fetchCall("binary", "binary-call"));
  await waitFor(() => fetchResponses(f).length === 1);
  const response = fetchResponses(f)[0];
  assert.equal(response.requestId, "binary");
  assert.equal(response.callId, "binary-call");
  assert.equal(response.response.ok, true);
  assert.equal(response.response.result.status, 200);
  assert.deepEqual(Buffer.from(response.response.result.bodyBase64, "base64"), body);
  assert.deepEqual(bridge.calls.map(({ message, sender }) => [message.requestId, message.callId, sender]), [["binary", "binary-call", bridge.sender]]);
  assert.ok(bridge.frames.some(frame => frame.op === "chunk"), "the Base64 envelope must cross bounded chunks");
  assert.ok(bridge.frames.every(frame => encodeMessage(frame).bytes <= MESSAGE_FRAME_BYTES));
  assert.ok(bridge.connections.every(connection => connection.closed));
  assert.equal(f.sent.some(message => message.type === "run_script_inner_fetch"), false, "large fetch results must not use native sendMessage");
});

test("Skill response limits and original runtime sender authorization still apply through the fetch Port", async t => {
  let fetches = 0;
  const bridge = skillFetchBridge(t, { maxResponseBytes: 16, fetch: async () => { fetches++; return new Response("x".repeat(17)); } });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "bounded");
  f.sandbox(fetchCall("bounded", "too-large"));
  await waitFor(() => fetchResponses(f).length === 1);
  assert.equal(fetchResponses(f)[0].response.code, "SKILL_NETWORK_RESPONSE_TOO_LARGE");
  assert.equal(fetches, 1);
  assert.ok(JSON.stringify(fetchResponses(f)[0]).length < 2000);

  bridge.sender.url = "chrome-extension://fixture/sidepanel/sidepanel.html";
  f.sandbox(fetchCall("bounded", "untrusted"));
  await waitFor(() => fetchResponses(f).length === 2);
  assert.equal(fetchResponses(f)[1].response.code, "SKILL_NETWORK_CALLER_UNTRUSTED");
  assert.equal(fetches, 1, "the Port cannot promote an unauthorized sender to the offscreen identity");
  assert.ok(bridge.connections.every(connection => connection.closed));
});

test("Skill fetch cancellation aborts only the matching call and closes its runtime Port", async t => {
  const requests = [];
  const bridge = skillFetchBridge(t, { fetch: async (_url, { signal }) => new Promise((resolve, reject) => {
    requests.push({ signal, resolve });
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "cancel-fetch");
  f.sandbox(fetchCall("cancel-fetch", "cancelled-call"));
  f.sandbox(fetchCall("cancel-fetch", "retained-call"));
  await waitFor(() => requests.length === 2);
  f.sandbox({ type: "fetch_cancel", requestId: "cancel-fetch", callId: "cancelled-call" });
  await waitFor(() => fetchResponses(f).length === 1);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(fetchResponses(f)[0].callId, "cancelled-call");
  assert.equal(fetchResponses(f)[0].response.code, "OPERATION_ABORTED");
  requests[1].resolve(new Response("retained"));
  await waitFor(() => fetchResponses(f).length === 2);
  assert.equal(Buffer.from(fetchResponses(f)[1].response.result.bodyBase64, "base64").toString(), "retained");
  assert.ok(bridge.connections.every(connection => connection.closed));
});

test("cancelling the run during a large Skill fetch transfer discards every late chunk", async t => {
  let f, cancelled = false;
  const bridge = skillFetchBridge(t, { fetch: async () => new Response(Buffer.alloc(7 * 1024 * 1024)), observe(frame) {
    if (frame.op !== "chunk" || cancelled) return;
    cancelled = true;
    f.send({ type: "run_script_inner_cancel", requestId: "cancel-transfer" });
  } });
  f = fixture(bridge);
  await startFetchRun(f, bridge, "cancel-transfer");
  f.sandbox(fetchCall("cancel-transfer", "large-call"));
  await waitFor(() => cancelled && bridge.connections.every(connection => connection.closed));
  await tick();
  assert.equal(fetchResponses(f).length, 0, "an obsolete run must receive neither a partial result nor an error response");
  assert.equal(results(f).length, 1);
  assert.equal(results(f)[0].result.code, "OPERATION_ABORTED");
  assert.equal(f.timers.size, 0, "cancellation must dispose client transfer and request timers");
});

test("six Skill fetches start concurrently and complete once each", async t => {
  const requests = [];
  const bridge = skillFetchBridge(t, { fetch: async () => new Promise(resolve => requests.push(resolve)) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "parallel");
  for (let index = 0; index < 6; index++) f.sandbox(fetchCall("parallel", `call-${index}`));
  await waitFor(() => requests.length === 6);
  assert.equal(bridge.connections.filter(connection => !connection.closed).length, 6);
  for (let index = 0; index < 6; index++) {
    requests[index](new Response(`response-${index}`));
  }
  await waitFor(() => fetchResponses(f).length === 6);
  assert.deepEqual(fetchResponses(f).map(message => message.response.ok), Array(6).fill(true));
  assert.deepEqual(bridge.calls.map(({ message }) => message.callId).sort(), Array.from({ length: 6 }, (_, index) => `call-${index}`));
  assert.ok(bridge.connections.every(connection => connection.closed));
});

test("run cancellation aborts all concurrent Skill fetches without replay", async t => {
  const requests = [];
  const bridge = skillFetchBridge(t, { fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    requests.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "queued");
  for (let index = 0; index < 6; index++) f.sandbox(fetchCall("queued", `queued-${index}`));
  await waitFor(() => requests.length === 6);
  const started = requests.length;
  f.send({ type: "run_script_inner_cancel", requestId: "queued" });
  await waitFor(() => requests.every(signal => signal.aborted) && bridge.connections.every(connection => connection.closed));
  await tick();
  assert.equal(requests.length, started, "cancellation must never replay a call");
  assert.equal(fetchResponses(f).length, 0);
  assert.equal(f.timers.size, 0);
});

test("unrelated pending imports do not delay a Skill fetch", async t => {
  const imports = [];
  const bridge = skillFetchBridge(t, {
    importFromPage: () => new Promise(resolve => imports.push(resolve)),
    fetch: async () => new Response("once"),
  });
  const occupied = Array.from({ length: 4 }, () => requestRuntimeMessage({ type: "session_export_import_request" }, { connect: bridge.connect }));
  await waitFor(() => imports.length === 4);
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "wait-import");
  f.sandbox(fetchCall("wait-import", "waiting-call"));
  await waitFor(() => fetchResponses(f).length === 1);
  assert.equal(fetchResponses(f)[0].response.ok, true);
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].message.callId, "waiting-call");
  assert.equal(bridge.connections.filter(connection => !connection.closed).length, 4);
  imports.forEach(resolve => resolve({})); await Promise.all(occupied);
  assert.ok(bridge.connections.every(connection => connection.closed));
});

test("execution-owned Skill fetches survive the runtime 30 and 60 second request deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const bridge = skillFetchBridge(t, { fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "slow-fetch");
  f.sandbox(fetchCall("slow-fetch", "slow-call"));
  await waitFor(() => finish);
  f.expire(30_000);
  t.mock.timers.tick(61_000);
  await tick();
  assert.equal(fetchResponses(f).length, 0);
  assert.equal(bridge.connections.filter(connection => !connection.closed).length, 1);
  finish(new Response("completed after 61 seconds"));
  await waitFor(() => fetchResponses(f).length === 1);
  assert.equal(fetchResponses(f)[0].response.ok, true);
  assert.ok(bridge.connections.every(connection => connection.closed));
});

test("a rejected fetch caller that keeps its Port open is disconnected after the response deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = skillFetchBridge(t, { fetch: async () => { assert.fail("untrusted caller reached HTTP"); } });
  bridge.register("untrusted-port");
  bridge.sender.url = "chrome-extension://fixture/sidepanel/sidepanel.html";
  const port = bridge.connect({ name: RUNTIME_REQUEST_PORT });
  const responses = [];
  port.onMessage.addListener(message => responses.push(message));
  port.postMessage({ ...fetchCall("untrusted-port", "call"), type: "run_script_inner_fetch" });
  await waitFor(() => responses.length > 0);
  assert.equal(responses[0].code, "SKILL_NETWORK_CALLER_UNTRUSTED");
  assert.equal(bridge.connections[0].closed, false, "the response must remain available until the client receives it");
  t.mock.timers.tick(60_001);
  assert.equal(bridge.connections[0].closed, true);
});

test("a disconnected fetch is reported once without repeating the HTTP request", async t => {
  let finish;
  const bridge = skillFetchBridge(t, { fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const f = fixture(bridge);
  await startFetchRun(f, bridge, "disconnect");
  f.sandbox(fetchCall("disconnect", "once"));
  await waitFor(() => finish);
  bridge.connections[0].disconnect();
  await waitFor(() => fetchResponses(f).length === 1);
  assert.equal(fetchResponses(f)[0].response.code, "TRANSPORT_DISCONNECTED");
  finish(new Response("late response"));
  await tick();
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.connections.length, 1);
  assert.equal(fetchResponses(f).length, 1);
  assert.equal(f.timers.size, 0);
});

const fetchCall = (requestId, callId) => ({ type: "fetch_call", requestId, callId, request: { url: "https://skill.example.test/data", method: "GET", headers: [] } });
const fetchResponses = f => f.posted.filter(message => message.type === "fetch_response");
async function startFetchRun(f, bridge, requestId) {
  bridge.register(requestId);
  f.send(execute(requestId)); f.sandbox({ type: "ready" }); await tick();
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), "the asynchronous bridge did not settle");
}
function skillFetchBridge(t, { fetch, maxRequestBytes = 1024, maxResponseBytes = 8 * 1024 * 1024, observe, importFromPage = async () => ({}) } = {}) {
  const runtime = { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, onMessage: createFakeEvent(), onConnect: createFakeEvent() };
  const sender = { id: runtime.id, url: runtime.getURL("offscreen.html") };
  const network = createSkillNetworkService({ runtime, fetch, getSecurityGuardrails: async () => ({ rules: [] }) });
  const calls = [], frames = [], connections = [], executions = [];
  const host = createRuntimeMessageTransport(createBackgroundApi({ exchange: { importFromPage }, tools: {
    acceptRunScriptInnerMessage: () => null,
    executeInnerFetch(message, actualSender) { calls.push({ message, sender: actualSender }); return network.execute(message, actualSender); },
    cancelInnerFetch: (message, actualSender) => network.cancel(message, actualSender),
  } }));
  const unregister = host.register(runtime);
  t.after(() => { executions.forEach(dispose => dispose()); unregister(); connections.forEach(connection => connection.disconnect()); });
  return { sender, calls, frames, connections,
    register(requestId) { executions.push(network.registerExecution(requestId, { plugin: { id: "fixture", network: {
      allowedOrigins: [{ origin: "https://skill.example.test" }], allowedMethods: ["GET", "POST"], maxRequestBytes, maxResponseBytes,
    } } })); },
    sendMessage(message) {
      if (!["run_script_inner_fetch", "run_script_inner_fetch_cancel"].includes(message.type)) return {};
      return new Promise(resolve => host.listener(message, sender, resolve));
    },
    connect({ name }) {
      assert.equal(name, RUNTIME_REQUEST_PORT);
      let closed = false;
      const client = { name, onMessage: createFakeEvent(), onDisconnect: createFakeEvent() };
      const server = { name, sender, onMessage: createFakeEvent(), onDisconnect: createFakeEvent() };
      const disconnect = () => { if (closed) return; closed = true; client.onDisconnect.emit(); server.onDisconnect.emit(); };
      const post = peer => message => {
        if (closed) throw new Error("Port disconnected");
        frames.push(message);
        assert.ok(encodeMessage(message).bytes <= MESSAGE_FRAME_BYTES);
        observe?.(message);
        queueMicrotask(() => { if (!closed) peer.onMessage.emit(structuredClone(message)); });
      };
      Object.assign(client, { postMessage: post(server), disconnect });
      Object.assign(server, { postMessage: post(client), disconnect });
      connections.push({ disconnect, get closed() { return closed; } });
      runtime.onConnect.emit(server);
      return client;
    },
  };
}

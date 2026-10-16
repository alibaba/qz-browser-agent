import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { localFetch, readHealth, withToolClient } from "../../services/mcp-bridge/src/client.mjs";
import { main, runCli } from "../../services/mcp-bridge/src/cli.mjs";

async function fixture(t) {
  const bridge = await startBridge({ port: 0, connectWaitMs: 10 });
  t.after(() => bridge.close());
  const traffic = [];
  bridge.server.prependListener("request", request => {
    if (request.url !== "/mcp") return;
    const entry = { method: request.method, sessionId: request.headers["mcp-session-id"] };
    traffic.push(entry);
    const body = [];
    request.on("data", chunk => body.push(chunk));
    request.on("end", () => { if (body.length) entry.rpc = JSON.parse(Buffer.concat(body).toString()); });
  });
  const browser = { id: "scope-browser", pollTimeoutMs: 1000 };
  bridge.state.registerClient(browser);
  const running = { endpoint: bridge.endpoint, health: await readHealth(bridge.endpoint) };
  const deps = { findDaemon: async () => running };
  const requests = [];
  async function respond(method, result, { ok = true } = {}) {
    const batch = await bridge.state.poll(browser, { timeoutMs: 2000 });
    assert.equal(batch.length, 1);
    const [request] = batch;
    requests.push(request);
    assert.equal(request.method, method);
    assert.equal(bridge.state.complete(request.id, { clientId: browser.id, ok, ...(ok ? { result } : { error: result }) }), true);
    return request;
  }
  return { bridge, browser, running, traffic, deps, requests, respond };
}

function assertOneSession(traffic, toolCalls) {
  const initializations = traffic.filter(entry => entry.rpc?.method === "initialize");
  assert.equal(initializations.length, 1);
  const calls = traffic.filter(entry => entry.rpc?.method === "tools/call");
  const id = calls[0]?.sessionId;
  assert.ok(id);
  assert.equal(calls.length, toolCalls);
  assert.ok(calls.every(entry => entry.sessionId === id));
  assert.deepEqual(traffic.filter(entry => entry.method === "DELETE").map(entry => entry.sessionId), [id]);
}

const snapshot = status => ({ sessionId: "task", runId: "run", status, runtime: { status }, transcript: [] });

test("one lazy command scope shares initialization across concurrent and later requests", async t => {
  const { bridge, traffic } = await fixture(t);
  assert.equal(await withToolClient(() => 42), 42);
  assert.equal(traffic.length, 0);
  await withToolClient(async call => {
    const firstRequest = new AbortController();
    const initial = await Promise.all([1, 2].map(() => call(bridge.endpoint, "qingzhou_bridge_status", {}, { timeoutMs: 1000, signal: firstRequest.signal })));
    assert.ok(initial.every(value => value.connected));
    // The first request's signal does not own the lifetime of the command's connection.
    firstRequest.abort();
    await delay(20);
    assert.equal((await call(bridge.endpoint, "qingzhou_bridge_status", {}, { timeoutMs: 1000 })).connected, true);
    await assert.rejects(call("http://127.0.0.1:1", "qingzhou_bridge_status", {}), error => error.code === "connection_changed");
  });
  assertOneSession(traffic, 3);
});

test("read-only local commands and invalid arguments never initialize MCP", async t => {
  const { deps, traffic } = await fixture(t);
  for (const argv of [["status"], ["mcp"], ["help"]]) await runCli(argv, deps);
  await assert.rejects(runCli(["create"], deps), error => error.code === "invalid_arguments");
  assert.equal(traffic.length, 0);
});

test("runCli creation and streaming snapshots retain one connection through pending input", async t => {
  const { traffic, deps, respond, requests } = await fixture(t);
  const updates = [];
  const pending = runCli(["create", "Find useful sources.", "--stream"], { ...deps, onTaskUpdate: update => updates.push(update) });
  await respond("create_session", { sessionId: "task" });
  await respond("get_session_snapshot", { ...snapshot("waiting_user"), input: { waiting: true, waitId: "wait-1", kind: "form", title: "Choose a city", form: { fields: [] } } });
  await respond("get_session_snapshot", snapshot("running"));
  await respond("get_session_snapshot", { ...snapshot("completed"), transcript: [{ type: "assistant", runId: "run", content: "Found the sources." }] });
  assert.equal((await pending).result.snapshot.status, "completed");
  assert.equal(updates.filter(update => update.type === "input").length, 1);
  assert.equal(requests.filter(request => request.method === "create_session").length, 1);
  assert.ok(requests.every(request => request.params.timeoutSeconds > 0 && request.params.timeoutSeconds <= 180));
  assertOneSession(traffic, 4);
});

test("main reuses one connection for form lookup, submission, and continued observation", async t => {
  const { traffic, deps, respond } = await fixture(t);
  let output = "";
  const pending = main(["submit", "task", '{"city":"Hangzhou"}', "--stream", "--json"], {
    ...deps, stdout: { write: text => { output += text; } }, stderr: { write: () => assert.fail("unexpected CLI error") },
  });
  await respond("get_user_input", { waiting: true, waitId: "form-1", kind: "form", sessionId: "task" });
  const reply = await respond("respond_to_user_input", { accepted: true, sessionId: "task", runId: "run", waitId: "form-1" });
  assert.equal(reply.params.waitId, "form-1");
  assert.deepEqual(reply.params.answers, { city: "Hangzhou" });
  await respond("get_session_snapshot", snapshot("running"));
  await respond("get_session_snapshot", snapshot("completed"));
  assert.equal(await pending, 0);
  assert.equal(JSON.parse(output.trim()).result.snapshot.status, "completed");
  assertOneSession(traffic, 4);
});

test("cancelling an in-flight watch closes its session and preserves the browser task", async t => {
  const { bridge, browser, traffic, deps } = await fixture(t);
  const controller = new AbortController();
  let output = "";
  const pending = main(["watch", "task", "--json"], { ...deps, signal: controller.signal,
    stdout: { write: text => { output += text; } }, stderr: { write: () => assert.fail("unexpected stderr") },
  });
  const [request] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(request.method, "get_session_snapshot");
  controller.abort();
  assert.equal(await pending, 130);
  assert.equal(JSON.parse(output).error.code, "interrupted");
  assert.equal(bridge.state.inflight.size, 0);
  assert.equal(bridge.state.complete(request.id, { ok: true, result: snapshot("completed") }), false);
  assert.deepEqual(await bridge.state.poll(browser, { timeoutMs: 10 }), []);
  assertOneSession(traffic, 1);
});

test("tool errors and callback errors clean up without replaying successful mutations", async t => {
  const { bridge, browser, traffic, deps, respond } = await fixture(t);
  const rejected = assert.rejects(runCli(["create", "Work"], deps), error => error.code === "BRIDGE_TOOL_ERROR" && /fixture failure/.test(error.message));
  await respond("create_session", "fixture failure", { ok: false });
  await rejected;
  assertOneSession(traffic, 1);
  traffic.length = 0;
  const callbackFailure = assert.rejects(runCli(["create", "Work", "--wait"], { ...deps,
    onTaskCreated: () => { throw new Error("output consumer stopped"); },
  }), /output consumer stopped/);
  await respond("create_session", { sessionId: "task" });
  await callbackFailure;
  assertOneSession(traffic, 1);
  assert.deepEqual(await bridge.state.poll(browser, { timeoutMs: 10 }), []);
});

test("a service interruption fails the command without reconnecting or replaying its mutation", async t => {
  const { bridge, browser, traffic, deps } = await fixture(t);
  const rejected = assert.rejects(runCli(["create", "Work"], deps), error => error.code === "BRIDGE_CLOSED");
  const [request] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(request.method, "create_session");
  await bridge.close();
  await rejected;
  assert.equal(traffic.filter(entry => entry.rpc?.method === "initialize").length, 1);
  assert.equal(traffic.filter(entry => entry.rpc?.method === "tools/call").length, 1);
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
});

test("failed initialization is retained instead of reconnecting inside a command", async () => {
  let attempts = 0;
  const fetch = async () => { attempts++; return new Response("unavailable", { status: 503 }); };
  await withToolClient(async call => {
    for (let i = 0; i < 2; i++) await assert.rejects(call("http://127.0.0.1:1", "qingzhou_bridge_status", {}, { fetch }), error => error.code === "connection_error" && /unavailable/.test(error.message));
  });
  assert.equal(attempts, 1);
});

test("session termination has a bounded deadline and still closes transport", async t => {
  const { bridge, traffic } = await fixture(t);
  let cleanupAborted = false;
  const fetch = (input, init) => {
    if (init?.method !== "DELETE") return localFetch(input, init);
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => { cleanupAborted = true; reject(init.signal.reason); }, { once: true });
    });
  };
  const started = Date.now();
  await withToolClient(call => call(bridge.endpoint, "qingzhou_bridge_status", {}, { fetch }));
  assert.equal(cleanupAborted, true);
  assert.ok(Date.now() - started < 2000);
  assert.equal(traffic.filter(entry => entry.rpc?.method === "initialize").length, 1);
});


test("the whole MCP handshake is bounded when the initialized notification never completes", async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let initialized = 0, cleanupAborted = false;
    const fetch = async (_input, init) => {
      const request = init.body ? JSON.parse(init.body) : null;
      if (request?.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
      }), { headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" } });
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      if (request?.method === "notifications/initialized") {
        initialized++;
        if (cancelled) setTimeout(() => controller.abort(), 10);
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => { cleanupAborted = true; reject(init.signal.reason); }, { once: true });
        });
      }
      assert.fail("no tool call should run before initialization completes");
    };
    const started = Date.now();
    await assert.rejects(withToolClient(call => call("http://127.0.0.1:1", "qingzhou_bridge_status", {}, {
      fetch, signal: controller.signal, timeoutMs: cancelled ? 1000 : 50,
    })), error => error.code === "connection_error" && (cancelled ? error.name === "AbortError" : /handshake timed out/.test(error.message)));
    assert.equal(initialized, 1);
    assert.equal(cleanupAborted, true);
    assert.ok(Date.now() - started < 500);
  }
});

test("connect reports an initialization failure immediately without opening Chrome or retrying", async t => {
  let initializations = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      if (JSON.parse(Buffer.concat(chunks).toString()).method === "initialize") initializations++;
      response.writeHead(503); response.end("temporarily unavailable");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const started = Date.now();
  await assert.rejects(runCli(["connect"], {
    ensureDaemon: async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, health: { status: { clients: [{ clientId: "browser" }] } } }),
    openBrowser: () => assert.fail("a protocol failure must not open Chrome"),
  }), error => error.code === "connection_error");
  assert.equal(initializations, 1);
  assert.ok(Date.now() - started < 1000);
});

test("connect recovers a timed-out browser ping on the same MCP session", async t => {
  const { bridge, browser, running, traffic } = await fixture(t);
  let opens = 0;
  const pending = runCli(["connect"], { ensureDaemon: async () => ({ ...running, instanceId: bridge.instanceId }),
    openBrowser: async () => { opens++; },
  });
  const [first] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(first.method, "ping");
  bridge.state.complete(first.id, { clientId: browser.id, ok: false, code: "BRIDGE_REQUEST_TIMEOUT", error: "The old browser poll timed out." });
  const [second] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(second.method, "ping");
  bridge.state.complete(second.id, { clientId: browser.id, ok: true, result: { pong: true } });
  assert.equal((await pending).result.connected, true);
  assert.equal(opens, 1);
  assertOneSession(traffic, 2);
});

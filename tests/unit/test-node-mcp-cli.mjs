import { pairBrowser, completeBrowser } from "../support/paired-bridge.mjs";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runCli, main } from "../../services/mcp-bridge/src/cli.mjs";
import { buildIdentity, daemonPaths, ensureDaemon, findDaemon, startManagedBridge, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";
import { GUIDE_URL, INSTALL_URL, QzError, callTool, localFetch, localUrl, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import { openBrowser } from "../../services/mcp-bridge/src/open-browser.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";

const endpoint = "http://127.0.0.1:23456";
const health = { service: "qz-browser-agent", protocolVersion: 1, features: { browserPairing: 1 }, instanceId: "test", processId: process.pid,
  scopeId: "test", status: { connected: true, clients: [{ clientId: "browser-1" }] } };
const running = { endpoint, instanceId: "test", health };

test("CLI status and MCP URL are read-only; commands explain missing connections", async () => {
  const dependencies = { findDaemon: async () => null, ensureDaemon: () => assert.fail("read must not start service"), openBrowser: () => assert.fail("read must not open a browser") };
  assert.deepEqual(await runCli(["status"], dependencies), { result: { running: false, connected: false } });
  for (const args of [["mcp"], ["show", "one"], ["send", "one", "Continue"], ["tasks"]]) {
    await assert.rejects(runCli(args, dependencies), error => error.code === "not_connected");
  }
  assert.deepEqual(await runCli(["mcp"], { findDaemon: async () => running }), { text: `${endpoint}/mcp\n` });
  assert.deepEqual(await runCli(["mcp", "--json"], { findDaemon: async () => running }), { result: { url: `${endpoint}/mcp` } });
});

test("CLI maps task commands to current MCP methods", async () => {
  const calls = [];
  const dependencies = { findDaemon: async () => running,
    callTool: async (...values) => { calls.push(values); return { sessionId: "task-1" }; } };
  for (const [args, method, parameters] of [
    [["tasks"], "qingzhou_list_sessions", {}],
    [["create", "Read this page", "--title", "A"], "qingzhou_create_session", { title: "A", firstMessage: "Read this page" }],
    [["show", "task-1"], "qingzhou_get_session_snapshot", { sessionId: "task-1" }],
    [["cancel", "task-1"], "qingzhou_stop_session", { sessionId: "task-1" }],
  ]) {
    await runCli([...args, "--client", "browser-1"], dependencies);
    assert.equal(calls.at(-1)[1], method);
    for (const [key, value] of Object.entries(parameters)) assert.deepEqual(calls.at(-1)[2][key], value);
    assert.equal(calls.at(-1)[2].clientId, "browser-1");
  }
  assert.equal(calls.length, 4);
});

test("invalid arguments cannot open a connection or execute a tool", async () => {
  const dependencies = { findDaemon: () => assert.fail("must validate first") };
  for (const args of [["call", "navigate"], ["call", "navigate", "--session", "one", "[]"],
    ["call", "navigate", "--session", "one", "bad"], ["cancel"], ["status", "extra"], ["tools", "--timeout", "NaN"]]) {
    await assert.rejects(runCli(args, dependencies), error => error.code === "invalid_arguments");
  }
  let output = "";
  const code = await main(["create"], {
    ...dependencies, stdout: { write(value) { output += value; } },
  });
  assert.equal(code, 2);
  const error = JSON.parse(output).error;
  assert.equal(error.code, "invalid_arguments");
  assert.match(error.message, /prompt/i);
  assert.match(error.hint, /npm run qz --/);
  assert.equal(Object.hasOwn(error, "install"), false);
  assert.equal(Object.hasOwn(error, "guide"), false);
});

test("connect starts once and opens a browser only when needed; stop owns the shared service", async () => {
  let starts = 0, opens = 0, stops = 0;
  const dependencies = {
    ensureDaemon: async () => { starts += 1; return { ...running, health: { ...health, status: { connected: false } } }; },
    openBrowser: async url => { opens += 1; assert.equal(url, `${endpoint}/qz-connect`); },
    readHealth: async () => health,
    callTool: async (_endpoint, name, args) => { assert.equal(name, "qingzhou_call"); assert.equal(args.method, "ping"); },
    stopDaemon: async () => { stops += 1; return { stopped: true }; },
  };
  assert.equal((await runCli(["connect"], dependencies)).result.connected, true);
  assert.equal(starts, 1); assert.equal(opens, 1);
  dependencies.ensureDaemon = async () => running;
  await runCli(["connect"], dependencies);
  assert.equal(opens, 1);
  assert.deepEqual((await runCli(["stop"], dependencies)).result, { stopped: true });
  assert.equal(stops, 1);
});

test("connect verifies browser replies, recovers an idle poller, and respects an explicit profile", async () => {
  let opened = false;
  const probes = [];
  const dependencies = {
    ensureDaemon: async () => running,
    readHealth: async () => health,
    openBrowser: async url => { assert.equal(url, `${endpoint}/qz-connect`); opened = true; },
    callTool: async (_endpoint, name, args) => {
      assert.equal(name, "qingzhou_call");
      assert.equal(args.method, "ping");
      probes.push(args.clientId);
      if (!opened) throw new QzError("BRIDGE_REQUEST_TIMEOUT", "The browser lease remains, but its poller is idle");
    },
  };
  await assert.rejects(runCli(["connect", "--client", "browser-1"], dependencies), error => error.code === "client_offline");
  assert.equal(opened, false);
  probes.length = 0;
  assert.equal((await runCli(["connect"], dependencies)).result.connected, true);
  assert.equal(opened, true);
  assert.deepEqual(probes, ["browser-1", "browser-1"]);

  probes.length = 0;
  dependencies.ensureDaemon = async () => ({ ...running, health: { ...health, status: {
    connected: true, clients: [{ clientId: "other-browser" }, { clientId: "browser-1" }],
  } } });
  dependencies.openBrowser = () => assert.fail("the selected responsive browser needs no connection page");
  await runCli(["connect", "--client", "browser-1"], dependencies);
  assert.deepEqual(probes, ["browser-1"]);
});

test("connect never reports a stale lease as success and abort does not open a page", async () => {
  let opens = 0;
  const dependencies = {
    ensureDaemon: async () => running, readHealth: async () => health,
    openBrowser: async () => { opens++; },
    callTool: async () => { throw new QzError("BRIDGE_REQUEST_TIMEOUT", "browser did not reply"); },
  };
  await assert.rejects(runCli(["connect", "--timeout", "0.05"], dependencies), error => error.code === "connection_pending");
  assert.equal(opens, 1);
  const controller = new AbortController();
  dependencies.callTool = async () => { controller.abort(); throw controller.signal.reason; };
  await assert.rejects(runCli(["connect"], { ...dependencies, signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(opens, 1);
});

test("connect confirms a browser through the real MCP transport before reporting success", async t => {
  const server = await startBridge({ port: 0, scopeId: "connect-probe-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "test-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const connected = runCli(["connect"], {
    ensureDaemon: async () => ({ endpoint: server.endpoint, instanceId: server.instanceId, health: await readHealth(server.endpoint) }),
    openBrowser: () => assert.fail("a responsive browser should be reused"),
  });
  const [request] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(request.method, "ping");
  assert.deepEqual(request.params, {});
  completeBrowser(server.state, request.id, { clientId: client.id, ok: true, result: { pong: true } });
  assert.equal((await connected).result.connected, true);
  assert.equal(server.state.pending.size, 0);
  assert.equal(server.state.inflight.size, 0);
});

test("install opens the Chrome Web Store and failures always include URL and setup guide", async () => {
  const opened = [];
  const result = await runCli(["install"], { openBrowser: async url => { opened.push(url); return { url, opened: true }; } });
  assert.deepEqual(opened, [INSTALL_URL]);
  assert.equal(result.result.opened, true);
  let output = "";
  const code = await main(["install"], { stdout: { write(value) { output += value; } }, openBrowser: async url => { throw Object.assign(new Error("No browser"), { code: "browser_open_failed", details: { url } }); } });
  assert.equal(code, 1);
  const error = JSON.parse(output).error;
  assert.equal(error.url, INSTALL_URL);
  assert.equal(error.guide, GUIDE_URL);
  assert.match(error.hint, /qz install/);
  assert.doesNotMatch(error.hint, /qz install qz/);
});

test("browser launcher uses argument arrays and reports spawn failures", async () => {
  let launch;
  await openBrowser(INSTALL_URL, { platform: "darwin", spawnProcess: (command, args) => {
    launch = { command, args }; const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child;
  } });
  assert.deepEqual(launch, { command: "open", args: [INSTALL_URL] });
  await assert.rejects(openBrowser(INSTALL_URL, { spawnProcess: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("missing"))); return child;
  } }), error => error.code === "browser_open_failed" && error.details.url === INSTALL_URL);
});

test("local transport rejects remote endpoints and redirects", async t => {
  for (const url of ["https://localhost:1", "http://example.com", "http://user:password@localhost", "http://localhost:1?target=x"]) assert.throws(() => localUrl(url));
  const server = createServer((_req, res) => { res.writeHead(307, { location: "https://example.com" }); res.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(localFetch(`http://127.0.0.1:${server.address().port}/mcp`), error => error.code === "redirect_blocked");
});

for (const action of ["cancel", "abort"]) for (const phase of ["between chunks", "pending first read", "pending second read"]) {
  test(`local HTTP streaming releases the response after ${action} with ${phase}`, async t => {
    let response;
    const server = createServer((_req, res) => {
      response = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (phase !== "pending first read") res.write("data: first\n\n");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const controller = new AbortController();
    const stream = await localFetch(`http://127.0.0.1:${server.address().port}/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    if (phase !== "pending first read") {
      const first = await reader.read();
      assert.equal(first.done, false, "the response streams before its producer finishes");
      assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
    }
    let pending;
    if (phase !== "between chunks") {
      pending = reader.read().then(value => ({ value }), error => ({ error }));
      await new Promise(resolve => setImmediate(resolve));
    }
    const closed = once(response, "close", { signal: AbortSignal.timeout(2000) });
    if (action === "abort") {
      controller.abort();
      const failedRead = pending
        ? pending.then(result => assert.ok(result.error, "the pending read rejects on abort"))
        : assert.rejects(reader.read());
      await Promise.all([failedRead, closed]);
    } else {
      await Promise.all([reader.cancel(), closed]);
      if (pending) assert.deepEqual((await pending).value, { value: undefined, done: true });
    }
    assert.equal(response.destroyed, true, "stopping the reader releases the HTTP connection");
  });
}

test("real SDK CLI submits a task once and preserves failure without retry", async t => {
  const server = await startBridge({ port: 0, scopeId: "cli-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "test-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const record = { endpoint: server.endpoint, health: await readHealth(server.endpoint) };
  const dependencies = { findDaemon: async () => record };
  const call = runCli(["send", "task-a", "Visit the source."], dependencies);
  const [request] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(request.method, "send_message");
  assert.equal(request.params.sessionId, "task-a");
  completeBrowser(server.state, request.id, { clientId: client.id, ok: true, result: { accepted: true, sessionId: "task-a" } });
  assert.deepEqual((await call).result, { accepted: true, sessionId: "task-a", clientId: client.id });
  const failed = runCli(["send", "task-a", "Try the next source."], dependencies);
  const assertion = assert.rejects(failed, error => error.code === "BRIDGE_TOOL_ERROR" && /fixture failure/.test(error.message));
  const [second] = await server.state.poll(client, { timeoutMs: 2000 });
  completeBrowser(server.state, second.id, { clientId: client.id, ok: false, error: "fixture failure" });
  await assertion;
  assert.deepEqual(await server.state.poll(client, { timeoutMs: 10 }), []);
});

test("a timed-out task mutation is not submitted again", async t => {
  const server = await startBridge({ port: 0, scopeId: "timeout-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "test-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const record = { endpoint: server.endpoint, health: await readHealth(server.endpoint) };
  const assertion = assert.rejects(runCli(["send", "task-a", "Ask for a city.", "--timeout", "0.15"],
    { findDaemon: async () => record }), error => error.code === -32001 || error.code === "tool_error");
  const [request] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(request.method, "send_message");
  assert.equal(request.params.text, "Ask for a city.");
  await assertion;
  assert.deepEqual(await server.state.poll(client, { timeoutMs: 20 }), []);
});

test("task creation and snapshot lookup work through the real MCP transport", async t => {
  const server = await startBridge({ port: 0, scopeId: "tasks-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "test-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const record = { endpoint: server.endpoint, health: await readHealth(server.endpoint) };
  const dependencies = { findDaemon: async () => record };
  const creating = runCli(["create", "Read this page", "--title", "Research"], dependencies);
  const [create] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(create.method, "create_session");
  assert.equal(create.params.title, "Research");
  assert.equal(create.params.firstMessage, "Read this page");
  completeBrowser(server.state, create.id, { clientId: client.id, ok: true, result: { sessionId: "task-created" } });
  assert.equal((await creating).result.sessionId, "task-created");
  const showing = runCli(["show", "task-created"], dependencies);
  const [read] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(read.method, "get_session_snapshot");
  assert.equal(read.params.sessionId, "task-created");
  const snapshot = { sessionId: "task-created", status: "completed", transcript: [{ type: "assistant", content: "Sources checked." }] };
  completeBrowser(server.state, read.id, { clientId: client.id, ok: true, result: snapshot });
  assert.deepEqual((await showing).result, { ...snapshot, clientId: client.id });
});

test("real MCP CLI binds form replies to the displayed wait and follows the resumed task", async t => {
  const server = await startBridge({ port: 0, scopeId: "input-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "input-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const record = { endpoint: server.endpoint, health: await readHealth(server.endpoint) };
  const dependencies = { findDaemon: async () => record };
  const pending = { sessionId: "task-input", runId: "run-input", waitId: "wait-input", waiting: true, kind: "form",
    form: { fields: [{ id: "city", label: "City", type: "single_choice", required: true, options: [{ value: "hz", label: "Hangzhou" }] }] }, actions: ["submit", "reject"] };
  const input = runCli(["show", "task-input"], dependencies);
  const [get] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(get.method, "get_session_snapshot");
  completeBrowser(server.state, get.id, { clientId: client.id, ok: true, result: { sessionId: "task-input", status: "waiting_user", input: pending } });
  assert.deepEqual((await input).result.input, { ...pending, clientId: client.id });
  const submitting = runCli(["submit", "task-input", '{"city":"hz"}', "--wait", "--timeout", "5"], dependencies);
  const [read] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(read.method, "get_user_input");
  completeBrowser(server.state, read.id, { clientId: client.id, ok: true, result: pending });
  const [reply] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(reply.method, "respond_to_user_input");
  assert.equal(reply.params.action, "submit");
  assert.equal(reply.params.waitId, "wait-input");
  assert.deepEqual(reply.params.answers, { city: "hz" });
  completeBrowser(server.state, reply.id, { clientId: client.id, ok: true, result: { accepted: true, sessionId: "task-input", runId: "run-input", waitId: "wait-input" } });
  for (const status of ["waiting_user", "completed"]) {
    const [poll] = await server.state.poll(client, { timeoutMs: 2000 });
    assert.equal(poll.method, "get_session_snapshot");
    assert.equal(poll.params.sessionId, "task-input");
    completeBrowser(server.state, poll.id, { clientId: client.id, ok: true, result: { sessionId: "task-input", runId: "run-input", status,
      runtime: { status, ...(status === "waiting_user" ? { waitId: "wait-input" } : {}) }, transcript: [] } });
  }
  assert.equal((await submitting).result.snapshot.status, "completed");
  assert.deepEqual(await server.state.poll(client, { timeoutMs: 10 }), []);
});

test("real MCP preserves location consent versions and rejects malformed wait responses before dispatch", async t => {
  const server = await startBridge({ port: 0, scopeId: "consent-input-test" });
  t.after(() => server.close());
  const client = await pairBrowser(server.state, { id: "consent-browser", pollTimeoutMs: 1000 });
  await server.state.poll(client, { timeoutMs: 1 });
  const record = { endpoint: server.endpoint, health: await readHealth(server.endpoint) };
  const approval = runCli(["approve", "task-consent", "--wait-id", "location-1"], { findDaemon: async () => record });
  const [read] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(read.method, "get_user_input");
  completeBrowser(server.state, read.id, { clientId: client.id, ok: true, result: {
    sessionId: "task-consent", waitId: "location-1", waiting: true, kind: "location_consent", consentVersion: 2,
    title: "Location sharing", message: "Coordinates go to your chosen model provider.",
  } });
  const [respond] = await server.state.poll(client, { timeoutMs: 2000 });
  assert.equal(respond.method, "respond_to_user_input");
  assert.equal(respond.params.consentVersion, 2);
  assert.equal(respond.params.waitId, "location-1");
  assert.equal(respond.params.action, "approve");
  completeBrowser(server.state, respond.id, { clientId: client.id, ok: true, result: { accepted: true } });
  assert.equal((await approval).result.accepted, true);
  for (const args of [
    { sessionId: "task", action: "approve" },
    { sessionId: "task", waitId: "wait", action: "unknown" },
    { sessionId: "task", waitId: "wait", action: "approve", consentVersion: 1.5 },
    { sessionId: "task", waitId: "wait", action: "submit", answers: [] },
  ]) {
    await assert.rejects(callTool(server.endpoint, "qingzhou_respond_to_user_input", args), error => /Invalid arguments/.test(error.message));
  }
  assert.equal(server.state.pending.size, 0);
  assert.deepEqual(await server.state.poll(client, { timeoutMs: 10 }), []);
});

test("managed service falls back from an occupied port and removes only its own state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qz-managed-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const occupied = createServer((_req, res) => { res.end("another application"); });
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const stateFile = join(directory, "test.json");
  const managed = await startManagedBridge({ stateFile, scopeId: "managed-test", port });
  t.after(() => managed.close());
  assert.notEqual(new URL(managed.endpoint).port, String(port));
  assert.equal((await readHealth(managed.endpoint)).scopeId, "managed-test");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).instanceId, managed.record.instanceId);
  await writeFile(stateFile, JSON.stringify({ instanceId: "replacement" }));
  await managed.close();
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).instanceId, "replacement");
});

test("concurrent starts reuse one scoped process; stale lock and wrong identities are safe", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-daemon-test-"));
  const options = { stateDir, scopeId: `test-${randomUUID()}`, buildId: "original-build", preferredPort: 0 };
  t.after(async () => { await stopDaemon(options); await rm(stateDir, { recursive: true, force: true }); });
  const paths = daemonPaths(options);
  await writeFile(paths.lock, JSON.stringify({ processId: 2147483647, id: "dead-owner" }));
  const [first, second] = await Promise.all([ensureDaemon(options), ensureDaemon(options)]);
  assert.equal(first.processId, second.processId);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal((await findDaemon(options)).instanceId, first.instanceId);
  const browser = await localFetch(`${first.endpoint}/v1/qingzhou/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: randomUUID(), connectionId: randomUUID(), instanceId: first.instanceId, name: "existing-browser" }) }).then(response => response.json());
  assert.equal(browser.ok, true);
  await localFetch(`${first.endpoint}/v1/qingzhou/poll`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: { ...browser, id: browser.clientId, pairingVersion: 1, pollTimeoutMs: 1 } }) }).then(response => response.json());
  const nextBuild = { ...options, buildId: "new-build" };
  assert.equal((await findDaemon(nextBuild)).instanceId, first.instanceId, "status and stop can find the running build");
  assert.equal((await findDaemon(nextBuild)).compatible, true);
  assert.equal((await findDaemon(nextBuild)).updateAvailable, true);
  assert.equal(await findDaemon({ ...options, scopeId: "other-package" }), null);
  const record = JSON.parse(await readFile(paths.state, "utf8"));
  await writeFile(paths.state, JSON.stringify({ ...record, instanceId: "stale" }));
  assert.equal(await findDaemon(options), null);
  assert.deepEqual(await stopDaemon(options), { stopped: false, connected: false });
  await writeFile(paths.state, JSON.stringify(record));
  const [reused, alsoReused] = await Promise.all([ensureDaemon(nextBuild), ensureDaemon(nextBuild)]);
  assert.equal(reused.instanceId, first.instanceId, "connect preserves its healthy running build");
  assert.equal(reused.processId, first.processId, "editing files cannot stop the running process");
  assert.equal(alsoReused.instanceId, first.instanceId, "new clients cannot start duplicate daemons");
  assert.equal(reused.updateAvailable, true);
  assert.equal(reused.health.status.clients[0]?.clientId, browser.clientId, "connected browser state survives source changes");
  assert.equal((await stopDaemon(nextBuild)).stopped, true, "updates are applied after an explicit stop");
  const updated = await ensureDaemon(nextBuild);
  assert.notEqual(updated.instanceId, first.instanceId);
  assert.equal(updated.health.buildId, "new-build");
  assert.equal(updated.updateAvailable, false);
  assert.equal((await stopDaemon(options)).stopped, true, "stop can stop the previous/current package build");
  assert.equal(await findDaemon(options), null);
});

test("three independent CLI connect processes share one daemon and leave it running", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-concurrent-cli-"));
  const options = { stateDir, scopeId: `cli-${randomUUID()}`, preferredPort: 0 };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await stopDaemon(options);
    await rm(stateDir, { recursive: true, force: true });
  });
  const script = `
    import { runCli } from ${JSON.stringify(new URL("../../services/mcp-bridge/src/cli.mjs", import.meta.url).href)};
    import { ensureDaemon } from ${JSON.stringify(new URL("../../services/mcp-bridge/src/daemon.mjs", import.meta.url).href)};
    let running;
    try {
      await runCli(['connect', '--timeout', '0.1'], {
        ensureDaemon: async () => running = await ensureDaemon(${JSON.stringify(options)}),
        openBrowser: async () => {},
      });
    } catch (error) {
      if (error.code !== 'connection_pending') throw error;
    }
    console.log(JSON.stringify({ processId: running.processId, instanceId: running.instanceId, endpoint: running.endpoint }));
  `;
  const results = await Promise.all(Array.from({ length: 3 }, async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      const [code, signal] = await once(child, "exit");
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr);
      return JSON.parse(stdout);
    } finally { clearTimeout(timer); }
  }));
  assert.equal(new Set(children.map(child => child.pid)).size, 3);
  for (const result of results) assert.deepEqual(result, results[0]);
  const running = await findDaemon(options);
  assert.equal(running.instanceId, results[0].instanceId);
  assert.equal(running.processId, results[0].processId);
});

test("package identity survives npx cache changes while development checkouts stay isolated", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qz-package-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "cache-one", "node_modules", "qz-browser-agent");
  const second = join(directory, "cache-two", "node_modules", "qz-browser-agent");
  const dev = join(directory, "checkout", "services", "mcp-bridge");
  for (const path of [first, second, dev]) {
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name: "qz-browser-agent", version: "0.1.0" }));
    await writeFile(join(path, "src", "daemon.mjs"), "export const version = 1;\n");
  }
  const identity = buildIdentity(first);
  assert.deepEqual(buildIdentity(second), identity);
  assert.notEqual(buildIdentity(dev).scopeId, identity.scopeId);
  await writeFile(join(second, "src", "daemon.mjs"), "export const version = 2;\n");
  assert.equal(buildIdentity(second).scopeId, identity.scopeId);
  assert.notEqual(buildIdentity(second).buildId, identity.buildId);
});

test("missing state recovers a verified same-scope service without restarting its older build", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-state-recovery-"));
  const options = { stateDir, scopeId: `recovery-${randomUUID()}`, buildId: "next-build" };
  const paths = daemonPaths(options);
  const managed = await startManagedBridge({ stateFile: paths.state, scopeId: options.scopeId, buildId: "loaded-build", port: 0 });
  t.after(async () => { await managed.close(); await rm(stateDir, { recursive: true, force: true }); });
  await rm(paths.state);
  const recovered = await ensureDaemon({ ...options, preferredPort: Number(new URL(managed.endpoint).port),
    spawnProcess: () => assert.fail("recovery must reuse the existing process") });
  assert.equal(recovered.instanceId, managed.record.instanceId);
  assert.equal(recovered.processId, process.pid);
  assert.equal(recovered.updateAvailable, true);
  assert.equal((await findDaemon(options)).instanceId, managed.record.instanceId);
});

test("failed startup releases its lock and active lock owners are never displaced", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-recovery-"));
  const options = { stateDir, scopeId: `lock-${randomUUID()}`, buildId: "lock-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  t.after(async () => { await stopDaemon(options); await rm(stateDir, { recursive: true, force: true }); });
  await assert.rejects(ensureDaemon({ ...options, spawnProcess: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("fixture spawn failure"))); return child;
  } }), /fixture spawn failure/);
  await mkdir(paths.lock);
  const ownerFile = join(paths.lock, `${process.pid}-${randomUUID()}.json`);
  const owner = { processId: process.pid, id: "test-owner" };
  await writeFile(ownerFile, JSON.stringify(owner));
  await assert.rejects(ensureDaemon({ ...options, timeoutMs: 20 }), error => error.code === "connection_busy");
  await assert.rejects(stopDaemon({ ...options, timeoutMs: 20 }), error => error.code === "connection_busy");
  assert.deepEqual(JSON.parse(await readFile(ownerFile, "utf8")), owner);
  await rm(paths.lock, { recursive: true });
  const started = await ensureDaemon(options);
  assert.equal((await findDaemon(options)).instanceId, started.instanceId);
});

function mockLockFilesystem(t, methods, platform = "win32") {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  for (const [name, method] of Object.entries(methods)) t.mock.method(fs, name, method);
  syncBuiltinESMExports();
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("Windows lock publication recovers EPERM when the competing directory disappears", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-windows-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID(), buildId: "windows-lock-test" };
  const paths = daemonPaths(options), rename = fs.rename;
  let publications = 0;
  mockLockFilesystem(t, { async rename(source, target) {
    assert.equal(target, paths.lock);
    assert.match(source, /\.pending$/);
    const [ownerFile] = await fs.readdir(source);
    assert.equal(JSON.parse(await readFile(join(source, ownerFile), "utf8")).processId, process.pid,
      "the owner is fully written before its lock is published");
    if (++publications === 1) {
      // Windows rejects a directory collision with EPERM. Its owner releases
      // the directory before the contender can inspect the failed rename.
      await mkdir(target);
      await writeFile(join(target, "released-owner.json"), "{}");
      await rm(target, { recursive: true });
      throw Object.assign(new Error("Windows destination collision"), { code: "EPERM" });
    }
    return rename(source, target);
  } });
  assert.deepEqual(await stopDaemon(options), { stopped: false, connected: false });
  assert.equal(publications, 2);
  assert.deepEqual(await fs.readdir(stateDir), [], "both published and pending lock directories are cleaned up");
});

for (const { platform, code, attempts } of [
  { platform: "win32", code: "EPERM", attempts: 2 },
  { platform: "win32", code: "EACCES", attempts: 1 },
  { platform: "darwin", code: "EPERM", attempts: 1 },
  { platform: "linux", code: "EPERM", attempts: 1 },
]) {
  test(`${platform} lock publication preserves a persistent ${code} failure`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-permission-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const options = { stateDir, scopeId: randomUUID(), buildId: "permission-test" };
    const failure = Object.assign(new Error("fixture filesystem permission denial"), { code });
    let publications = 0;
    mockLockFilesystem(t, { async rename() { publications++; throw failure; } }, platform);
    await assert.rejects(stopDaemon(options), error => error === failure,
      "permission denial must not be converted to connection_busy");
    assert.equal(publications, attempts);
    assert.deepEqual(await fs.readdir(stateDir), []);
  });
}

test("Windows EPERM contention preserves a live lock owner", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-windows-owner-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID(), buildId: "owner-test", timeoutMs: 1 };
  const paths = daemonPaths(options), owner = { processId: process.pid, id: randomUUID() };
  const ownerFile = join(paths.lock, `${owner.processId}-${owner.id}.json`);
  await mkdir(paths.lock); await writeFile(ownerFile, JSON.stringify(owner));
  mockLockFilesystem(t, { async rename() {
    throw Object.assign(new Error("Windows destination collision"), { code: "EPERM" });
  } });
  await assert.rejects(stopDaemon(options), error => error.code === "connection_busy");
  assert.deepEqual(JSON.parse(await readFile(ownerFile, "utf8")), owner);
  assert.deepEqual(await fs.readdir(stateDir), [basename(paths.lock)]);
});

test("a lock stat permission failure is surfaced without touching its owner", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-stat-denied-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID(), buildId: "stat-test" };
  const paths = daemonPaths(options), stat = fs.stat;
  const failure = Object.assign(new Error("fixture lock stat denied"), { code: "EACCES" });
  const renameFailure = Object.assign(new Error("Windows destination collision"), { code: "EPERM" });
  await mkdir(paths.lock);
  const ownerFile = join(paths.lock, `${process.pid}-${randomUUID()}.json`);
  await writeFile(ownerFile, JSON.stringify({ processId: process.pid }));
  let publications = 0;
  mockLockFilesystem(t, {
    async rename() { publications++; throw renameFailure; },
    async stat(target, ...args) { if (target === paths.lock) throw failure; return stat(target, ...args); },
  });
  await assert.rejects(stopDaemon(options), error => error === failure);
  assert.equal(publications, 1);
  assert.equal(JSON.parse(await readFile(ownerFile, "utf8")).processId, process.pid);
});

test("an unreadable lock owner is never treated as an empty or stale lock", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-lock-owner-denied-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, scopeId: randomUUID(), buildId: "unreadable-owner-test" };
  const paths = daemonPaths(options), read = fs.readFile;
  const owner = { processId: process.pid, id: randomUUID() };
  const ownerFile = join(paths.lock, `${owner.processId}-${owner.id}.json`);
  const failure = Object.assign(new Error("fixture owner read denied"), { code: "EACCES" });
  await mkdir(paths.lock); await writeFile(ownerFile, JSON.stringify(owner));
  mockLockFilesystem(t, {
    async rename() { throw Object.assign(new Error("Windows destination collision"), { code: "EPERM" }); },
    async readFile(target, ...args) { if (target === ownerFile) throw failure; return read(target, ...args); },
  });
  await assert.rejects(stopDaemon(options), error => error === failure);
  assert.deepEqual(JSON.parse(await read(ownerFile, "utf8")), owner);
});

test("timed-out startup stops its delayed child before a retry can create another service", { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-slow-start-"));
  const options = { stateDir, scopeId: `slow-${randomUUID()}`, buildId: "slow-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  let child;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await stopDaemon(options);
    await rm(stateDir, { recursive: true, force: true });
  });
  await assert.rejects(ensureDaemon({ ...options, startTimeoutMs: 30, spawnProcess: (executable, args, spawnOptions) => {
    const code = `await new Promise(resolve => setTimeout(resolve, 350));
      const { startManagedBridge } = await import(${JSON.stringify(new URL("../../services/mcp-bridge/src/daemon.mjs", import.meta.url).href)});
      const running = await startManagedBridge(${JSON.stringify({ stateFile: paths.state, scopeId: options.scopeId, buildId: options.buildId, port: 0 })});
      process.once("SIGTERM", () => { void running.close().then(() => process.exit(0)); });`;
    child = spawn(executable, ["--input-type=module", "-e", code], spawnOptions);
    return child;
  } }), error => error.code === "start_failed");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "startup must reap its child before releasing the lock");
  const retry = await ensureDaemon(options);
  await delay(450);
  assert.equal((await findDaemon(options)).instanceId, retry.instanceId, "a late first child cannot overwrite retry state");
});

test("failed startup can force-stop its own unresponsive child and removes only its matching state", { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-owned-startup-"));
  const options = { stateDir, scopeId: `owned-${randomUUID()}`, buildId: "owned-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  let child;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await stopDaemon(options);
    await rm(stateDir, { recursive: true, force: true });
  });
  await assert.rejects(ensureDaemon({ ...options, readHealth: async endpoint => {
    await readHealth(endpoint);
    throw new Error("fixture health failure after the server starts");
  }, spawnProcess: (executable, args, spawnOptions) => {
    const code = `process.on("SIGTERM", () => {});
      const { startManagedBridge } = await import(${JSON.stringify(new URL("../../services/mcp-bridge/src/daemon.mjs", import.meta.url).href)});
      await startManagedBridge(${JSON.stringify({ stateFile: args[2], scopeId: args[3], buildId: args[5], instanceId: args[6], port: 0 })});`;
    child = spawn(executable, ["--input-type=module", "-e", code], spawnOptions);
    return child;
  } }), error => error.code === "connection_unavailable");
  // Windows terminates on SIGTERM even when the child installs a signal handler.
  assert.equal(child.signalCode, process.platform === "win32" ? "SIGTERM" : "SIGKILL",
    "only the owned failed-startup child can be force-stopped");
  await assert.rejects(readFile(paths.state), error => error.code === "ENOENT");
  const retry = await ensureDaemon(options);
  assert.equal((await findDaemon(options)).instanceId, retry.instanceId);
});

test("startup cleanup preserves a different live service and its state record", { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-startup-owner-"));
  const options = { stateDir, scopeId: `different-${randomUUID()}`, buildId: "owner-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  const managed = await startManagedBridge({ stateFile: paths.state, scopeId: options.scopeId, buildId: options.buildId, port: 0 });
  let child, restored;
  t.after(async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    await restored;
    await managed.close(); await rm(stateDir, { recursive: true, force: true });
  });
  await rm(paths.state);
  await assert.rejects(ensureDaemon({ ...options, spawnProcess: (executable, _args, spawnOptions) => {
    child = spawn(executable, ["-e", "setInterval(() => {}, 1000)"], spawnOptions);
    child.once("spawn", () => { restored = writeFile(paths.state, JSON.stringify(managed.record)); });
    return child;
  } }), error => error.code === "start_failed" && /claimed the startup state/.test(error.message));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal((await readHealth(managed.endpoint)).instanceId, managed.record.instanceId);
  assert.deepEqual(JSON.parse(await readFile(paths.state, "utf8")), managed.record);
});

test("npm package includes the runtime catalog and excludes development runtimes", () => {
  const directory = fileURLToPath(new URL("../../services/mcp-bridge", import.meta.url));
  const npmEntry = process.env.npm_execpath || (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : null);
  const [packed] = JSON.parse(execFileSync(npmEntry ? process.execPath : "npm",
    [...(npmEntry ? [npmEntry] : []), "pack", directory, "--dry-run", "--json"], { encoding: "utf8" }));
  const files = packed.files.map(file => file.path);
  for (const path of ["src/cli.mjs", "src/daemon.mjs", "src/server.mjs", "src/catalog.json", "LICENSE"]) assert.ok(files.includes(path), path);
  assert.ok(files.every(path => !/\.py$|node_modules|\.env|uv\.lock/.test(path)));
});

test("a transient health failure preserves the running service and cannot start a duplicate", async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-health-recovery-"));
  const options = { stateDir, scopeId: `health-${randomUUID()}`, buildId: "health-test", preferredPort: 0 };
  const paths = daemonPaths(options);
  const managed = await startManagedBridge({ stateFile: paths.state, scopeId: options.scopeId, buildId: options.buildId, port: 0 });
  t.after(async () => { await managed.close(); await rm(stateDir, { recursive: true, force: true }); });
  let attempts = 0;
  const recovered = await findDaemon({ ...options, readHealth: endpoint => {
    if (attempts++ === 0) throw new Error("injected temporary health failure");
    return readHealth(endpoint);
  } });
  assert.equal(recovered?.instanceId, managed.record.instanceId);
  assert.equal(attempts, 2);
  let starts = 0;
  await assert.rejects(ensureDaemon({ ...options,
    readHealth: async () => { throw new Error("injected unavailable health endpoint"); },
    spawnProcess: () => { starts += 1; assert.fail("a live unresponsive service must not be duplicated"); },
  }), error => error.code === "connection_unavailable" && error.details.processId === process.pid);
  assert.equal(starts, 0);
  assert.equal((await findDaemon(options)).instanceId, managed.record.instanceId);
});

test("the service survives launcher shutdown and reconnect recovers a crashed process", { timeout: 15000 }, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), "qz-launcher-lifecycle-"));
  const options = { stateDir, scopeId: `launcher-${randomUUID()}`, buildId: "launcher-test", preferredPort: 0 };
  const moduleUrl = new URL("../../services/mcp-bridge/src/daemon.mjs", import.meta.url).href;
  const code = `import { ensureDaemon } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await ensureDaemon(${JSON.stringify(options)}))); setInterval(() => {}, 1000);`;
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", code], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    await stopDaemon(options);
    await rm(stateDir, { recursive: true, force: true });
  });
  const started = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    launcher.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
    });
    launcher.stderr.on("data", chunk => { errors += chunk; });
    launcher.once("error", reject);
    launcher.once("exit", () => reject(new Error(`Launcher exited before startup: ${errors}`)));
  });
  const launcherExit = once(launcher, "exit");
  if (process.platform === "win32") launcher.kill();
  else process.kill(-launcher.pid, "SIGHUP");
  await launcherExit;
  assert.equal((await findDaemon(options))?.instanceId, started.instanceId, "terminal/launcher shutdown leaves its detached service alive");
  process.kill(started.processId, "SIGKILL");
  for (let attempt = 0; attempt < 100 && await findDaemon(options); attempt += 1) await delay(10);
  const recovered = await ensureDaemon(options);
  assert.notEqual(recovered.instanceId, started.instanceId);
  assert.notEqual(recovered.processId, started.processId);
  const stops = await Promise.all([stopDaemon(options), stopDaemon(options)]);
  assert.equal(stops.filter(result => result.stopped).length, 1);
  assert.equal(await findDaemon(options), null);
});

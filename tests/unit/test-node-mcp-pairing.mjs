import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import fs, { mkdir, mkdtemp, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { BrowserRegistry } from "../../services/mcp-bridge/src/browser-registry.mjs";
import { BridgeState } from "../../services/mcp-bridge/src/state.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { executeMcpTool } from "../../services/mcp-bridge/src/tools.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";

const code = expected => error => error.code === expected;
const identity = (state, name) => ({ clientId: randomUUID(), connectionId: randomUUID(), instanceId: state.instanceId, ...(name ? { name } : {}) });
const poll = (state, paired, options = {}) => state.poll({ id: paired.clientId, ...paired, pairingVersion: 1 }, { timeoutMs: 1, ...options });
const expire = (state, id) => { state.clients.get(id).lastSeenAt -= 180; };
async function storage(t) {
  const directory = await mkdtemp(join(tmpdir(), "qz-browser-registry-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return join(directory, "scope.browsers.json");
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("pairing persists names and private identity proofs, reconnects after daemon restart, and keeps status public", async t => {
  const path = await storage(t);
  const state = new BridgeState({ registry: await BrowserRegistry.open(path), connectWaitMs: 0 });
  t.after(() => state.close());
  const paired = await state.pair(identity(state));
  assert.equal(paired.name, "default");
  assert.equal((await state.pair(paired)).pairingToken, paired.pairingToken);
  assert.equal(state.status().browsers[0].online, true);
  assert.equal(JSON.stringify(state.status()).includes(paired.pairingToken), false);
  assert.equal(JSON.stringify(state.status()).includes("pairingToken"), false);
  assert.equal((await stat(path)).mode & 0o777, process.platform === "win32" ? (await stat(path)).mode & 0o777 : 0o600);
  const restarted = new BridgeState({ registry: await BrowserRegistry.open(path), connectWaitMs: 0 });
  t.after(() => restarted.close());
  assert.equal(restarted.status().browsers[0].online, false);
  await assert.rejects(restarted.pair(paired), code("BRIDGE_INSTANCE_CHANGED"));
  const resumed = await restarted.pair({ ...paired, instanceId: restarted.instanceId, connectionId: randomUUID() });
  assert.equal(resumed.pairingToken, paired.pairingToken);
  assert.equal(await restarted.resolveClient("default", 0, restarted.signal()), paired.clientId);
});

test("concurrent name claims commit once, UUID ownership requires its private token, and live workers cannot be replaced", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  const results = await Promise.allSettled([state.pair(identity(state, "work")), state.pair(identity(state, "work"))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "BRIDGE_NAME_IN_USE");
  const paired = results.find(result => result.status === "fulfilled").value;
  await assert.rejects(state.pair({ ...paired, connectionId: randomUUID() }), code("BRIDGE_CLIENT_IN_USE"));
  await assert.rejects(state.pair({ ...paired, pairingToken: "wrong" }), code("BRIDGE_PAIRING_REQUIRED"));
  expire(state, paired.clientId);
  await assert.rejects(state.pair({ ...paired, pairingToken: "wrong", connectionId: randomUUID() }), code("BRIDGE_PAIRING_REQUIRED"));
  assert.equal(state.registry.list().length, 1);
  state.close();
});

test("a live worker collision reports its remaining lease without extending it", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const state = new BridgeState();
  t.after(() => state.close());
  const paired = await state.pair(identity(state));
  const next = { ...paired, connectionId: randomUUID() };
  await assert.rejects(state.pair(next), error => error.code === "BRIDGE_CLIENT_IN_USE" && error.retryAfterMs === 46001);
  t.mock.timers.tick(12000);
  await assert.rejects(state.pair(next), error => error.code === "BRIDGE_CLIENT_IN_USE" && error.retryAfterMs === 34001);
  t.mock.timers.tick(34001);
  assert.equal((await state.pair(next)).connectionId, next.connectionId);
});

test("pair HTTP errors return only the public remaining lease field", async t => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  const paired = await bridge.state.pair(identity(bridge.state));
  const response = await fetch(`${bridge.state.endpoint}/v1/qingzhou/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...paired, connectionId: randomUUID() }),
  });
  assert.equal(response.status, 409);
  const error = await response.json();
  assert.equal(error.code, "BRIDGE_CLIENT_IN_USE");
  assert.ok(error.retryAfterMs > 0 && error.retryAfterMs <= 46001);
  assert.deepEqual(Object.keys(error).sort(), ["code", "error", "ok", "retryAfterMs"]);
});

test("rename preserves the active lease, rejects conflicts, and exposes a public canonical poll identity", async t => {
  const bridge = await startBridge({ port: 0 }); t.after(() => bridge.close());
  const state = bridge.state, first = await state.pair(identity(state, "first"));
  await state.pair(identity(state, "taken"));
  const client = state.clients.get(first.clientId), seenAt = client.lastSeenAt;
  await assert.rejects(state.rename({ ...first, name: "taken" }), code("BRIDGE_NAME_IN_USE"));
  const task = state.callExtension("ping", {}, { clientId: first.clientId });
  const [request] = await poll(state, first);
  const response = await fetch(`${bridge.endpoint}/v1/qingzhou/rename`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...first, name: "renamed" }),
  });
  assert.equal(response.status, 200);
  const canonical = await response.json();
  assert.deepEqual(canonical, { ok: true, clientId: first.clientId, name: "renamed", connectionId: first.connectionId, instanceId: state.instanceId });
  assert.equal(state.clients.get(first.clientId), client); assert.equal(client.controller.signal.aborted, false);
  assert.equal(state.complete(request.id, { ...first, ok: true, result: "still running" }), true); assert.equal(await task, "still running");
  const pollResponse = await fetch(`${bridge.endpoint}/v1/qingzhou/poll`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: { ...first, id: first.clientId, pairingVersion: 1, pollTimeoutMs: 1 } }),
  });
  const { ok, ...publicIdentity } = canonical;
  assert.deepEqual(await pollResponse.json(), { requests: [], ...publicIdentity });
  assert.equal(await state.resolveClient("renamed", 0, state.signal()), first.clientId);
  assert.ok(client.lastSeenAt >= seenAt);
});

test("rename requires its current live connection and cannot resurrect a disconnected worker", async t => {
  const state = new BridgeState(); t.after(() => state.close());
  const first = await state.pair(identity(state, "first"));
  await assert.rejects(state.rename({ ...first, name: "late", instanceId: randomUUID() }), code("BRIDGE_INSTANCE_CHANGED"));
  await assert.rejects(state.rename({ ...first, name: "late", connectionId: randomUUID() }), code("BRIDGE_PAIRING_REQUIRED"));
  expire(state, first.clientId);
  await assert.rejects(state.rename({ ...first, name: "late" }), code("BRIDGE_CLIENT_OFFLINE"));
  await state.disconnect(first);
  await assert.rejects(state.rename({ ...first, name: "late" }), code("BRIDGE_PAIRING_REQUIRED"));
  assert.equal(state.status().clientCount, 0); assert.equal(state.registry.get(first.clientId).name, "first");
});

test("replacement revokes old polls, queued and in-flight requests; stale results and disconnects cannot affect the new worker", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  const first = await state.pair(identity(state));
  const active = state.callExtension("ping", {}, { clientId: first.clientId }).catch(error => error);
  const [request] = await poll(state, first);
  const queued = state.callExtension("create_session", {}, { clientId: first.clientId }).catch(error => error);
  await settle();
  const oldPoll = poll(state, first, { timeoutMs: 5000 });
  // This poll consumes the queued operation; both requests must still lose authority.
  await oldPoll;
  const waitingPoll = poll(state, first, { timeoutMs: 5000 }).catch(error => error);
  await settle();
  expire(state, first.clientId);
  const second = await state.pair({ ...first, connectionId: randomUUID() });
  assert.equal((await active).code, "BRIDGE_CLIENT_DISCONNECTED");
  assert.equal((await queued).code, "BRIDGE_CLIENT_DISCONNECTED");
  assert.equal((await waitingPoll).code, "BRIDGE_CLIENT_DISCONNECTED");
  assert.equal(state.complete(request.id, { ...first, ok: true, result: "stale" }), false);
  await assert.rejects(state.disconnect(first), code("BRIDGE_PAIRING_REQUIRED"));
  await assert.rejects(poll(state, first), code("BRIDGE_PAIRING_REQUIRED"));
  const operation = state.callExtension("ping", {}, { clientId: "default" });
  const [fresh] = await poll(state, second);
  assert.ok(fresh);
  assert.equal(state.complete(fresh.id, { ok: true, result: "unpaired spoof" }), false);
  assert.equal(state.complete(fresh.id, { ...second, instanceId: "old-service", ok: true }), false);
  assert.equal(state.complete(fresh.id, { ...second, ok: true, result: "current" }), true);
  assert.equal(await operation, "current");
  state.close();
});

test("explicit disconnect cancels queued work and offline forget frees only that registration", async () => {
  const state = new BridgeState({ connectWaitMs: 0 });
  const a = await state.pair(identity(state)), b = await state.pair(identity(state, "personal"));
  const queued = state.callExtension("create_session", {}, { clientId: a.clientId }).catch(error => error);
  await settle();
  await assert.rejects(state.forgetBrowser("default"), code("BRIDGE_CLIENT_IN_USE"));
  await state.disconnect(a);
  assert.equal((await queued).code, "BRIDGE_CLIENT_DISCONNECTED");
  assert.equal(state.pending.size, 0);
  await assert.rejects(state.callExtension("ping", {}, { clientId: "default" }), code("BRIDGE_CLIENT_OFFLINE"));
  await state.forgetBrowser("default");
  assert.deepEqual(state.registry.list(), [{ clientId: b.clientId, name: "personal" }]);
  const c = await state.pair(identity(state, "default"));
  assert.notEqual(c.clientId, a.clientId);
  await assert.rejects(state.disconnect(a), code("BRIDGE_PAIRING_REQUIRED"));
  assert.equal(await state.resolveClient("default", 0, state.signal()), c.clientId);
  state.close();
});

test("registry failures do not acknowledge or partially apply pairing, renaming, or forgetting", async () => {
  let fail = true;
  const registry = new BrowserRegistry({ persist: async () => { if (fail) throw new Error("disk full"); } });
  const state = new BridgeState({ registry, connectWaitMs: 0 });
  const input = identity(state);
  await assert.rejects(state.pair(input), code("BRIDGE_REGISTRY_WRITE_FAILED"));
  assert.equal(state.registry.list().length, 0); assert.equal(state.status().clientCount, 0);
  fail = false;
  const paired = await state.pair(input);
  fail = true;
  await assert.rejects(state.rename({ ...paired, name: "new-name" }), code("BRIDGE_REGISTRY_WRITE_FAILED"));
  assert.equal(state.registry.get(input.clientId).name, "default");
  assert.equal(state.status().clients[0].name, "default");
  await state.disconnect(paired);
  await assert.rejects(state.forgetBrowser("default"), code("BRIDGE_REGISTRY_WRITE_FAILED"));
  assert.equal(state.registry.list().length, 1);
  state.close();
});

test("poll admission cannot race an offline forget or a persisted rename", async () => {
  let release;
  let block = false;
  const registry = new BrowserRegistry({ persist: async () => { if (block) await new Promise(resolve => { release = resolve; }); } });
  const state = new BridgeState({ registry });
  const paired = await state.pair(identity(state));
  expire(state, paired.clientId);
  block = true;
  const forgetting = state.forgetBrowser("default");
  await settle();
  assert.equal(typeof release, "function");
  const polling = poll(state, paired).catch(error => error);
  release();
  await forgetting;
  assert.equal((await polling).code, "BRIDGE_PAIRING_REQUIRED");
  assert.equal(state.status().clientCount, 0);
  state.close();
});

test("invalid or unreadable registries fail closed, leaving original bytes untouched", async t => {
  const path = await storage(t);
  for (const contents of ["not json", '{"version":2,"browsers":[]}', '{"version":1,"browsers":[{}]}']) {
    await writeFile(path, contents);
    await assert.rejects(BrowserRegistry.open(path), code("BRIDGE_REGISTRY_READ_FAILED"));
    assert.equal(await readFile(path, "utf8"), contents);
  }
  await assert.rejects(BrowserRegistry.open(join(path, "child")), code("BRIDGE_REGISTRY_READ_FAILED"));
});

test("a Windows ENOENT below a file cannot initialize an empty browser registry", async t => {
  const path = await storage(t);
  const contents = '{"version":1,"browsers":[]}';
  await writeFile(path, contents);
  // Windows reports ENOENT for paths below a regular file; Unix reports ENOTDIR.
  for (const method of ["readFile", "lstat"]) {
    const original = fs[method];
    t.mock.method(fs, method, async (target, ...args) => {
      if (String(target).startsWith(`${path}${sep}`)) throw Object.assign(new Error("Fixture Windows path not found"), { code: "ENOENT" });
      return original(target, ...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const target of [join(path, "child"), join(path, "missing", "scope.browsers.json")]) {
    await assert.rejects(BrowserRegistry.open(target), code("BRIDGE_REGISTRY_READ_FAILED"));
    assert.equal(await readFile(path, "utf8"), contents);
  }
});

test("a missing registry can create missing directories and persist its first browser", async t => {
  const path = join(dirname(await storage(t)), "missing", "nested", "scope.browsers.json");
  const registry = await BrowserRegistry.open(path);
  assert.deepEqual(registry.list(), []);
  await assert.rejects(stat(dirname(path)), code("ENOENT"));
  const browser = await registry.pair({ clientId: randomUUID() });
  assert.equal(browser.name, "default");
  assert.deepEqual((await BrowserRegistry.open(path)).list(), registry.list());
});

test("a registry can be initialized through a directory symlink or Windows junction", async t => {
  const directory = dirname(await storage(t));
  const target = join(directory, "target"), link = join(directory, "link");
  await mkdir(target);
  await symlink(target, link, "junction");
  const registry = await BrowserRegistry.open(join(link, "scope.browsers.json"));
  assert.deepEqual(registry.list(), []);
  await registry.pair({ clientId: randomUUID() });
  assert.deepEqual((await BrowserRegistry.open(join(target, "scope.browsers.json"))).list(), registry.list());
});

test("registry read failures and inaccessible parents stay closed without changing stored bytes", async t => {
  const path = await storage(t);
  const contents = '{"version":1,"browsers":[]}';
  await writeFile(path, contents);
  const originalReadFile = fs.readFile, originalLstat = fs.lstat;
  const missing = join(dirname(path), "missing.json");
  t.mock.method(fs, "readFile", async (target, ...args) => {
    if (target === path) throw Object.assign(new Error("Fixture access denied"), { code: "EACCES" });
    return originalReadFile(target, ...args);
  });
  t.mock.method(fs, "lstat", async (target, ...args) => {
    if (target === dirname(path)) throw Object.assign(new Error("Fixture access denied"), { code: "EACCES" });
    return originalLstat(target, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const target of [path, missing]) await assert.rejects(BrowserRegistry.open(target), code("BRIDGE_REGISTRY_READ_FAILED"));
  assert.equal(await originalReadFile(path, "utf8"), contents);
  await assert.rejects(stat(missing), code("ENOENT"));
});

test("unpaired polls and results cannot register or act as a browser", async t => {
  const state = new BridgeState({ connectWaitMs: 0 }); t.after(() => state.close());
  for (const client of [{ id: "unpaired" }, { id: randomUUID() }, { id: randomUUID(), pairingVersion: 2 }]) {
    await assert.rejects(state.poll(client, { timeoutMs: 1 }), code("BRIDGE_PAIRING_REQUIRED"));
  }
  assert.equal(state.clients.size, 0);
  assert.deepEqual(state.registry.list(), []);
  const paired = await state.pair(identity(state));
  const operation = state.callExtension("ping");
  const [request] = await poll(state, paired);
  for (const payload of [{}, { clientId: paired.clientId }, { ...paired, pairingToken: "invalid" }]) {
    assert.equal(state.complete(request.id, { ...payload, ok: true, result: "untrusted" }), false);
    assert.equal(state.inflight.size, 1);
  }
  assert.equal(state.complete(request.id, { ...paired, ok: true, result: "paired result" }), true);
  assert.equal(await operation, "paired result");
});

test("MCP create and observation resolve a name once and keep its UUID", async () => {
  const calls = [];
  let resolves = 0;
  const state = { signal: signal => signal || new AbortController().signal,
    resolveClient: async selector => { resolves++; assert.equal(selector, "work"); return { id: "fixed-profile", controller: new AbortController() }; },
    callExtension: async (method, params, options) => {
      calls.push(options.clientId);
      return method === "create_session" ? { session: { id: "task" } }
        : { sessionId: "task", status: "completed", runtime: { status: "completed" }, transcript: [] };
    } };
  await executeMcpTool(state, "qingzhou_create_session", { firstMessage: "Test", wait: true, clientId: "work" });
  assert.equal(resolves, 1); assert.deepEqual(calls, ["fixed-profile", "fixed-profile"]);
});

test("HTTP pairing reports typed errors with extension CORS and enforces instance fencing", async t => {
  const bridge = await startBridge({ port: 0 }); t.after(() => bridge.close());
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const post = (path, body) => fetch(`${bridge.endpoint}/v1/qingzhou/${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const health = await (await fetch(`${bridge.endpoint}/health`)).json();
  assert.deepEqual(health.features, { browserPairing: 1 });
  const paired = await (await post("pair", identity(bridge.state))).json();
  assert.equal(paired.ok, true);
  const denied = await post("pair", { ...paired, connectionId: randomUUID() });
  assert.equal(denied.status, 409); assert.equal(denied.headers.get("access-control-allow-origin"), origin);
  assert.equal((await denied.json()).code, "BRIDGE_CLIENT_IN_USE");
  const stale = await post("disconnect", { ...paired, instanceId: randomUUID() });
  assert.equal((await stale.json()).code, "BRIDGE_INSTANCE_CHANGED");
  assert.equal((await (await post("disconnect", paired)).json()).ok, true);
});

function cliFixture() {
  const clients = [{ clientId: randomUUID(), name: "default" }, { clientId: randomUUID(), name: "work" }];
  const health = { features: { browserPairing: 1 }, instanceId: "daemon", status: { connected: true, clients,
    browsers: [...clients.map(client => ({ ...client, online: true })), { clientId: randomUUID(), name: "offline", online: false }] } };
  const running = { endpoint: "http://127.0.0.1:18765", instanceId: "daemon", health };
  const calls = [];
  const dependencies = { findDaemon: async () => running, ensureDaemon: async () => running,
    openBrowser: () => assert.fail("strict selection must not open a browser"), stopDaemon: () => assert.fail("must not stop a working service"),
    callTool: async (_url, tool, args) => { calls.push({ tool, args }); return {}; } };
  return { clients, health, running, calls, dependencies };
}

test("CLI requires explicit multi-browser selection and resolves names to UUID for every command", async () => {
  const { clients, health, calls, dependencies } = cliFixture();
  for (const command of [["connect"], ["tasks"], ["settings"], ["create", "Test"]]) await assert.rejects(runCli(command, dependencies), code("selection_required"));
  for (const selector of ["missing", "offline"]) for (const command of [["connect"], ["create", "Test"]]) {
    await assert.rejects(runCli([...command, "--client", selector], dependencies), code(selector === "missing" ? "client_not_found" : "client_offline"));
  }
  assert.equal(calls.length, 0);
  await runCli(["create", "Test", "--client", "work"], dependencies);
  assert.equal(calls[0].args.clientId, clients[1].clientId);
  await runCli(["connect", "--client", clients[0].clientId], dependencies);
  assert.equal(calls[1].args.clientId, clients[0].clientId);
  assert.equal((await runCli(["browsers"], dependencies)).result.browsers.length, 3);
  await runCli(["browsers", "forget", "offline"], dependencies);
  assert.deepEqual(calls.at(-1), { tool: "qingzhou_forget_browser", args: { clientId: health.status.browsers[2].clientId } });
});

test("new CLI explains an older healthy daemon and never upgrades it by stopping it", async () => {
  const { health, dependencies, calls } = cliFixture(); delete health.features;
  for (const command of [["connect"], ["create", "Test"], ["browsers"]]) await assert.rejects(runCli(command, dependencies), error => error.code === "upgrade_required" && /stop/.test(error.details.hint) && /reload/.test(error.details.hint) && /all browsers/.test(error.details.hint));
  assert.equal(calls.length, 0);
  assert.equal((await runCli(["status"], dependencies)).result.running, true);
  assert.match((await runCli(["mcp"], dependencies)).text, /\/mcp/);
});

test("explicit connect ports preserve an existing daemon and report its address", async () => {
  const { dependencies, calls } = cliFixture();
  await assert.rejects(runCli(["connect", "--port", "18766"], dependencies), error => error.code === "port_mismatch" && /18765/.test(error.details.endpoint));
  for (const port of ["0", "65536", "NaN", "1.5"]) await assert.rejects(runCli(["connect", "--port", port], dependencies), code("invalid_arguments"));
  assert.equal(calls.length, 0);
});


test("a persisted first pairing proof survives a lost response and retries idempotently", async t => {
  const path = await storage(t);
  const state = new BridgeState({ registry: await BrowserRegistry.open(path) });
  t.after(() => state.close());
  const request = { ...identity(state), pairingToken: randomBytes(32).toString("base64url") };
  await state.pair(request); // The HTTP response is lost; the extension retains its pre-persisted proof.
  const retry = await state.pair(request);
  assert.equal(retry.pairingToken, request.pairingToken);
  assert.equal(state.registry.list().length, 1);
  assert.equal(state.status().clientCount, 1);
});

test("disconnect or replacement between target resolution and enqueue cannot transfer a request", async () => {
  for (const replace of [false, true]) {
    const state = new BridgeState({ connectWaitMs: 0 });
    const paired = await state.pair(identity(state));
    const original = state.resolveClient.bind(state);
    state.resolveClient = async (...args) => {
      const resolved = await original(...args);
      await state.disconnect(paired);
      if (replace) await state.pair({ ...paired, connectionId: randomUUID() });
      return resolved;
    };
    await assert.rejects(state.callExtension("create_session", {}, { clientId: paired.clientId }), code("BRIDGE_CLIENT_OFFLINE"));
    assert.equal(state.pending.size, 0);
    assert.equal(state.inflight.size, 0);
    state.close();
  }
});


test("browser names have one unambiguous CLI-safe grammar", async () => {
  const state = new BridgeState();
  for (const name of ["", "has space", "中文", "a.b", "-leading", "_leading", "a/b", "a\\b", "a\nname", "a".repeat(65), randomUUID()]) {
    if (name === "") continue; // An omitted initial name deliberately selects default.
    await assert.rejects(state.pair(identity(state, name)), code("BRIDGE_NAME_INVALID"));
  }
  for (const name of ["work", "Work-2", "a_b", "7", "a".repeat(64)]) assert.equal((await state.pair(identity(state, name))).name, name);
  state.close();
});


test("unpaired IDs cannot shadow paired names or change a pinned request target", async t => {
  const state = new BridgeState({ connectWaitMs: 0 }); t.after(() => state.close());
  await assert.rejects(state.poll({ id: "work" }, { timeoutMs: 1 }), code("BRIDGE_PAIRING_REQUIRED"));
  const paired = await state.pair(identity(state, "work"));
  assert.equal(await state.resolveClient("work", 0, state.signal()), paired.clientId);
  assert.equal(state.clients.size, 1);
});

test("one MCP operation cannot transfer observation to a replacement connection of the same UUID", async t => {
  const state = new BridgeState({ connectWaitMs: 0 }); t.after(() => state.close());
  const paired = await state.pair(identity(state));
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const pending = executeMcpTool(state, "qingzhou_create_session", { firstMessage: "Test", wait: true, clientId: "default" }, {
    onTaskUpdate: async event => { if (event.type === "created") { entered.resolve(); await resume.promise; } },
  });
  const rejected = assert.rejects(pending, code("BRIDGE_CLIENT_DISCONNECTED"));
  const [create] = await poll(state, paired, { timeoutMs: 1000 });
  assert.equal(create.method, "create_session");
  assert.equal(state.complete(create.id, { ...paired, ok: true, result: { session: { id: "task" } } }), true);
  await entered.promise;
  await state.disconnect(paired);
  const replacement = await state.pair({ ...paired, connectionId: randomUUID() });
  resume.resolve(); await rejected;
  assert.deepEqual(await poll(state, replacement), [], "the new connection receives no stale observation or repeated mutation");
  assert.equal(state.pending.size, 0); assert.equal(state.inflight.size, 0);
});

test("async tool jobs outlive their caller but cannot transfer to a replacement browser connection", async t => {
  for (const replace of [false, true]) {
    const state = new BridgeState({ connectWaitMs: 0 }); t.after(() => state.close());
    const paired = await state.pair(identity(state));
    const original = state.callExtension.bind(state), entered = Promise.withResolvers(), resume = Promise.withResolvers();
    state.callExtension = async (...args) => { entered.resolve(); await resume.promise; return original(...args); };
    const caller = new AbortController();
    const job = await executeMcpTool(state, "qingzhou_execute_tool", { sessionId: "task", name: "open_tab", args: { url: "https://example.test" }, wait: false }, { signal: caller.signal });
    await entered.promise; caller.abort(new Error("MCP response finished"));
    let target = paired;
    if (replace) {
      await state.disconnect(paired);
      target = await state.pair({ ...paired, connectionId: randomUUID() });
    }
    resume.resolve();
    if (!replace) {
      const [request] = await poll(state, target, { timeoutMs: 1000 });
      assert.equal(request.method, "execute_tool");
      state.complete(request.id, { ...target, ok: true, result: { accepted: true } });
    }
    for (let n = 0; n < 20 && !state.getJob(job.jobId).done; n++) await settle();
    const done = state.getJob(job.jobId);
    assert.equal(done.status, replace ? "failed" : "completed");
    if (replace) {
      assert.match(done.error, /BRIDGE_CLIENT_DISCONNECTED/);
      assert.deepEqual(await poll(state, target), []);
    } else assert.deepEqual(done.result, { accepted: true });
    assert.equal(state.pending.size, 0); assert.equal(state.inflight.size, 0);
  }
});

test("automatic browser names are unique across concurrent pairing and preserve registered identities", async t => {
  const state = new BridgeState({ connectWaitMs: 0 }); t.after(() => state.close());
  const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () => state.pair(identity(state))));
  assert.deepEqual([first.name, second.name, third.name], ["default", "browser-2", "browser-3"]);
  await state.disconnect(second);
  assert.equal((await state.pair(identity(state))).name, "browser-4", "offline names stay reserved");
  const same = await state.pair({ ...first, name: undefined });
  assert.equal(same.name, "default"); assert.equal(same.clientId, first.clientId);
  const renamed = await state.pair({ ...first, name: "work" });
  assert.equal(renamed.name, "work"); assert.equal(renamed.connectionId, first.connectionId);
  assert.equal((await state.pair({ ...first, name: undefined })).name, "work");
  const pending = state.callExtension("ping", {}, { clientId: "work" });
  const [request] = await poll(state, renamed);
  await assert.rejects(state.pair({ ...renamed, name: "browser-3" }), code("BRIDGE_NAME_IN_USE"));
  assert.equal(state.registry.get(first.clientId).name, "work");
  assert.equal(state.complete(request.id, { ...renamed, ok: true, result: "still connected" }), true);
  assert.equal(await pending, "still connected");
});

test("binding URL preparation does not select, probe or open a browser and supports explicit names", async () => {
  const { running, dependencies } = cliFixture();
  let opened;
  const deps = { ...dependencies, callTool: () => assert.fail("URL preparation does not probe a browser"),
    readHealth: () => assert.fail("URL preparation does not wait for a browser"),
    openBrowser: async url => { opened = url; return { opened: true }; } };
  for (const clients of [[], running.health.status.clients]) {
    const health = { ...running.health, status: { ...running.health.status, clients } };
    const prepared = await runCli(["connect", "--no-open", "--json"], { ...deps, ensureDaemon: async () => ({ ...running, health }) });
    assert.deepEqual(prepared.result, { endpoint: running.endpoint, url: `${running.endpoint}/qz-connect`, mcpUrl: `${running.endpoint}/mcp`, opened: false });
    assert.equal(opened, undefined);
  }
  const named = await runCli(["connect", "--no-open", "--name", "work-Chrome_2", "--json"], deps);
  assert.equal(named.result.url, `${running.endpoint}/qz-connect?name=work-Chrome_2`);
  assert.equal(named.result.opened, false); assert.equal(opened, undefined);
  const launched = await runCli(["connect", "--name", "work"], deps);
  assert.equal(opened, `${running.endpoint}/qz-connect?name=work`);
  assert.equal(launched.result.opened, true); assert.equal(Object.hasOwn(launched.result, "connected"), false);
  for (const args of [["--client", "missing", "--no-open"], ["--client", "work", "--name", "personal"],
    ["--name", ""], ["--name", "two words"], ["--name", randomUUID()]]) {
    await assert.rejects(runCli(["connect", ...args], { ensureDaemon: () => assert.fail("invalid flags have no effects") }), code("invalid_arguments"));
  }
});

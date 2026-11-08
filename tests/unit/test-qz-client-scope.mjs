import { pairBrowser, completeBrowser } from "../support/paired-bridge.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { localFetch, QzError, readHealth, withToolClient } from "../../services/mcp-bridge/src/client.mjs";
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
  const browser = await pairBrowser(bridge.state, { id: "scope-browser", pollTimeoutMs: 1000 });
  const running = { endpoint: bridge.endpoint, instanceId: bridge.instanceId, health: await readHealth(bridge.endpoint) };
  const deps = { findDaemon: async () => running,
    ensureDaemon: () => assert.fail("the isolated fixture service already exists"),
    restartDaemon: () => assert.fail("the isolated fixture service is compatible"),
    openConnectionBrowser: () => assert.fail("the isolated fixture browser must be reused"),
  };
  const requests = [];
  async function nextRequest() {
    while (true) {
      const batch = await bridge.state.poll(browser, { timeoutMs: 2000 });
      assert.equal(batch.length, 1);
      const [request] = batch;
      requests.push(request);
      if (request.method !== "ping" && request.method !== "get_drive_session") return request;
      assert.equal(completeBrowser(bridge.state, request.id, { clientId: browser.id, ok: true,
        result: request.method === "ping" ? { pong: true } : { sessionId: request.params.sessionId, title: "Existing drive task", status: "ready" } }), true);
    }
  }
  async function respond(method, result, { ok = true } = {}) {
    const request = await nextRequest();
    assert.equal(request.method, method);
    assert.equal(completeBrowser(bridge.state, request.id, { clientId: browser.id, ok, ...(ok ? { result } : { error: result }) }), true);
    return request;
  }
  return { bridge, browser, running, traffic, deps, requests, respond, nextRequest };
}

function assertOneSession(traffic, toolCalls) {
  const initializations = traffic.filter(entry => entry.rpc?.method === "initialize");
  assert.equal(initializations.length, 1);
  const calls = traffic.filter(entry => entry.rpc?.method === "tools/call");
  const id = calls[0]?.sessionId;
  assert.ok(id);
  const preparation = calls.filter(entry => entry.rpc.params.name === "qingzhou_get_drive_session"
    || entry.rpc.params.name === "qingzhou_call" && entry.rpc.params.arguments?.method === "ping");
  assert.equal(calls.length - preparation.length, toolCalls);
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
    await assert.rejects(call("http://127.0.0.1:1", "qingzhou_bridge_status", {}), error => error.code === "CONNECTION_CHANGED");
  });
  assertOneSession(traffic, 3);
});

test("read-only local commands and invalid arguments never initialize MCP", async t => {
  const { deps, traffic, running } = await fixture(t);
  for (const argv of [["status"], ["mcp"], ["help"]]) await runCli(argv, { ...deps, ensureDaemon: async () => running });
  await assert.rejects(runCli(["create"], deps), error => error.code === "INVALID_ARGUMENTS");
  assert.equal(traffic.length, 0);
});

test("new sessions use the first responsive browser while an explicit selector stays pinned", async t => {
  const { bridge, browser, running, deps, traffic } = await fixture(t);
  const other = await pairBrowser(bridge.state, { id: "second-profile" });
  running.health = await readHealth(bridge.endpoint);
  const browsers = [browser, other];
  const first = browsers.find(entry => entry.id === running.health.status.clients[0].clientId);
  const second = browsers.find(entry => entry.id !== first.id);
  for (const selector of [undefined, running.health.status.clients.find(entry => entry.clientId === second.id).name, second.id]) {
    const selected = selector ? second : first;
    const untouched = browsers.find(entry => entry.id !== selected.id);
    const start = traffic.length;
    const pending = runCli(["session", "create", "--title", "Pinned task", "--json", ...(selector ? ["--client", selector] : [])], {
      ...deps, openConnectionBrowser: () => assert.fail("a responsive authorized browser must be reused"),
      restartDaemon: () => assert.fail("compatible services must stay running"),
    });
    const [ping] = await bridge.state.poll(selected, { timeoutMs: 2000 });
    assert.equal(ping.method, "ping");
    assert.equal(completeBrowser(bridge.state, ping.id, { clientId: selected.id, ok: true, result: { pong: true } }), true);
    const [create] = await bridge.state.poll(selected, { timeoutMs: 2000 });
    assert.equal(create.method, "create_drive_session");
    assert.equal(create.params.title, "Pinned task");
    assert.equal(completeBrowser(bridge.state, create.id, { clientId: selected.id, ok: true,
      result: { sessionId: "pinned", title: "Pinned task", status: "ready" } }), true);
    assert.equal((await pending).result.sessionId, "pinned");
    assert.deepEqual(await bridge.state.poll(untouched, { timeoutMs: 10 }), [], "another browser receives no probe or mutation");
    const calls = traffic.slice(start).filter(entry => entry.rpc?.method === "tools/call");
    assert.ok(calls.every(entry => entry.rpc.params.arguments.clientId === selected.id));
    assert.equal(calls.filter(entry => entry.rpc.params.name === "qingzhou_create_drive_session").length, 1);
  }
});

test("an explicit offline or unknown browser never falls back to the other live profile", async t => {
  const { bridge, browser, running, deps, traffic } = await fixture(t);
  const offline = await pairBrowser(bridge.state, { id: "offline-profile" });
  await bridge.state.disconnect(offline);
  running.health = await readHealth(bridge.endpoint);
  for (const [selector, code] of [["offline-profile", "CLIENT_OFFLINE"], [offline.id, "CLIENT_OFFLINE"], ["unknown-profile", "CLIENT_NOT_FOUND"]]) {
    await assert.rejects(runCli(["session", "create", "--title", "No fallback", "--client", selector, "--timeout", "0.03"], {
      ...deps, ensureDaemon: () => assert.fail("the selected browser cannot authorize a second daemon"),
      openConnectionBrowser: () => assert.fail("an explicit browser cannot open a default profile"),
      restartDaemon: () => assert.fail("browser selection does not authorize a service upgrade"),
    }), error => {
      assert.equal(error.code, code);
      if (code === "CLIENT_OFFLINE") {
        assert.equal(error.details.stage, "browser-connection");
        assert.deepEqual(error.details.selectedBrowser, { clientId: offline.id, name: "offline-profile" });
        assert.deepEqual(error.details.attemptedBrowsers, []);
        assert.equal(error.details.operationSubmitted, false);
        assert.match(error.message, /No browser operation was submitted/);
        assert.match(error.details.hint, /qz connect uri/);
      } else assert.equal(error.details.selectedBrowser, undefined);
      return true;
    });
  }
  assert.equal(traffic.length, 0, "invalid explicit selection does not initialize or probe another connection");
  assert.deepEqual(await bridge.state.poll(browser, { timeoutMs: 10 }), []);
});

test("connection diagnostics survive public JSON and script output without submitting an operation", async t => {
  for (const scenario of ["selected", "default", "no-launch"]) await t.test(scenario, async t => {
    let now = 1000000, stdout = "";
    t.mock.method(Date, "now", () => now += 10);
    const selected = { clientId: "offline-uuid", name: "Work profile", privateData: "not diagnostic" };
    const health = { protocolVersion: 1, features: { browserPairing: 1, scriptApiVersion: 2 },
      status: { clients: [], browsers: [selected] } };
    const running = { endpoint: "http://127.0.0.1:18765", health };
    const attempted = [];
    const deps = {
      findDaemon: async () => running,
      callTool: () => assert.fail("no browser request may be submitted"),
      openConnectionBrowser: async () => {
        assert.equal(scenario, "default");
        assert.equal(attempted.length, 0, "connection preparation opens the default browser only once");
        attempted.push("System default browser");
        return { browser: "System default browser", opened: true };
      },
      readHealth: async () => { now += 100; return health; },
      readStdin: async () => "return 7;",
      stdout: { write: text => { stdout += text; } },
      stderr: { write: () => assert.fail("machine output stays on stdout") },
    };
    for (const script of [false, true]) {
      stdout = ""; attempted.length = 0;
      const args = script ? ["script", "--session", "existing"] : ["session", "create", "--title", "Not submitted"];
      args.push("--json", "--timeout", scenario === "no-launch" ? "0.001" : "0.5");
      if (scenario === "selected") args.push("--client", selected.name);
      assert.equal(await main(args, deps), 1);
      const output = JSON.parse(stdout), error = script ? output.result : output;
      assert.equal(error.code, scenario === "selected" ? "CLIENT_OFFLINE" : "CONNECTION_PENDING");
      assert.equal(error.details.stage, "browser-connection");
      assert.equal(error.details.operationSubmitted, false);
      assert.deepEqual(error.details.attemptedBrowsers, attempted);
      assert.deepEqual(attempted, scenario === "default" ? ["System default browser"] : []);
      assert.deepEqual(error.details.selectedBrowser, scenario === "selected" ? { clientId: selected.clientId, name: selected.name } : undefined);
      assert.match(error.message, /No browser operation was submitted/);
      assert.match(error.hint, /qz connect uri/);
      assert.equal(error.details.hint, undefined);
      assert.equal(error.details.url, `${running.endpoint}/qz-connect${scenario === "selected" ? "?name=Work+profile" : ""}`);
      assert.doesNotMatch(stdout, /privateData|not diagnostic/);
    }
  });
});

test("an explicit offline profile reconnects within its deadline without opening or using another browser", async t => {
  const { bridge, browser, running, deps, traffic } = await fixture(t);
  const selected = await pairBrowser(bridge.state, { id: "reconnecting-profile" });
  await bridge.state.disconnect(selected);
  running.health = await readHealth(bridge.endpoint);
  const reconnected = Promise.withResolvers();
  let healthReads = 0;
  const pending = runCli(["session", "create", "--title", "Recovered task", "--client", "reconnecting-profile", "--timeout", "2", "--json"], {
    ...deps,
    openConnectionBrowser: () => assert.fail("an explicit profile must not launch another browser"),
    readHealth: async endpoint => {
      if (++healthReads === 2) {
        await bridge.state.pair({ ...selected, clientId: selected.id });
        reconnected.resolve();
      }
      return readHealth(endpoint);
    },
  });
  await reconnected.promise;
  const [ping] = await bridge.state.poll(selected, { timeoutMs: 2000 });
  assert.equal(ping.method, "ping");
  assert.equal(completeBrowser(bridge.state, ping.id, { clientId: selected.id, ok: true, result: { pong: true } }), true);
  const [create] = await bridge.state.poll(selected, { timeoutMs: 2000 });
  assert.equal(create.method, "create_drive_session");
  assert.equal(completeBrowser(bridge.state, create.id, { clientId: selected.id, ok: true,
    result: { sessionId: "recovered", title: "Recovered task", status: "idle" } }), true);
  assert.equal((await pending).result.sessionId, "recovered");
  assert.deepEqual(await bridge.state.poll(browser, { timeoutMs: 10 }), []);
  const calls = traffic.filter(entry => entry.rpc?.method === "tools/call");
  assert.ok(calls.every(entry => entry.rpc.params.arguments.clientId === selected.id));
  assert.equal(calls.filter(entry => entry.rpc.params.name === "qingzhou_create_drive_session").length, 1);
});

test("stalled reconnect health reads respect cancellation and the remaining connection budget", async t => {
  const argv = timeout => ["session", "create", "--title", "Stalled health", "--client", "offline-profile", "--timeout", timeout];
  const stalled = endpoint => ({
    findDaemon: async () => ({ endpoint, instanceId: "stalled-service", health: { protocolVersion: 1, features: { browserPairing: 1 },
      status: { clients: [], browsers: [{ clientId: "offline-profile", name: "offline-profile" }] } } }),
    callTool: () => assert.fail("no browser operation may be submitted"),
    openConnectionBrowser: () => assert.fail("a pinned profile cannot launch a substitute"),
  });
  await t.test("caller cancellation", async t => {
    const controller = new AbortController(), reason = new Error("Cancelled during health read");
    let reads = 0;
    const server = createServer((_request, _response) => {
      reads++;
      controller.abort(reason);
      // Accept the real HTTP request but never send headers or a body.
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const started = performance.now();
    await assert.rejects(runCli(argv("2"), { ...stalled(`http://127.0.0.1:${server.address().port}`), signal: controller.signal }),
      error => error === reason);
    assert.equal(reads, 1);
    assert.ok(performance.now() - started < 900, "health polling must not consume its independent one-second timeout");
  });
  await t.test("deadline exhaustion", async () => {
    const timedOut = Object.assign(new Error("The operation was aborted"), { name: "AbortError",
      cause: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    const timeouts = [];
    await assert.rejects(runCli(argv("0.9"), { ...stalled("http://127.0.0.1:9"),
      // The read reports its own timeout while Date.now() is still before the command deadline.
      readHealth: async (_endpoint, { timeoutMs }) => { timeouts.push(timeoutMs); throw timedOut; },
    }), error => error.code === "CLIENT_OFFLINE");
    assert.equal(timeouts.length, 1);
    assert.ok(timeouts[0] <= 900, "the final health read is limited to the remaining connection budget");
  });
});

test("cancellation during service discovery prevents both startup and upgrade before any browser call", async t => {
  const { running, deps, traffic } = await fixture(t);
  for (const found of [null, { ...running, compatible: false }]) {
    const controller = new AbortController(), reason = new Error("Cancelled during discovery");
    await assert.rejects(runCli(["session", "create", "--title", "Cancelled task"], {
      ...deps, signal: controller.signal,
      findDaemon: async () => { controller.abort(reason); return found; },
      ensureDaemon: () => assert.fail("cancelled discovery cannot start a service"),
      restartDaemon: () => assert.fail("cancelled discovery cannot terminate the running service"),
    }), error => error === reason);
  }
  assert.equal(traffic.length, 0);
});

test("a closed browser reconnects in Chrome without fallback or duplicate task creation", async t => {
  const { bridge, browser, running, deps } = await fixture(t);
  const closed = new AbortController();
  const oldPoll = bridge.state.poll(browser, { timeoutMs: 20000, signal: closed.signal });
  const stopped = assert.rejects(oldPoll, /browser closed/);
  await delay(0);
  closed.abort(new Error("browser closed"));
  await stopped;
  running.health = await readHealth(bridge.endpoint);
  assert.equal(running.health.status.connected, false);

  const reopened = Promise.withResolvers(), opened = [], methods = [];
  const pending = runCli(["session", "create", "--title", "After restart", "--timeout", "2", "--json"], {
    ...deps,
    openConnectionBrowser: async () => {
      opened.push("Chrome");
      const paired = await bridge.state.pair({ ...browser, connectionId: randomUUID() });
      reopened.resolve({ ...paired, id: paired.clientId, pairingVersion: 1 });
      return { browser: "Chrome", opened: true };
    },
  });
  const resumed = await Promise.race([reopened.promise, pending.then(() => assert.fail("expected browser launch"))]);
  for (const method of ["ping", "create_drive_session"]) {
    const [request] = await bridge.state.poll(resumed, { timeoutMs: 2000 });
    assert.equal(request.method, method); methods.push(method);
    assert.equal(bridge.state.complete(request.id, { ...resumed, ok: true,
      result: method === "ping" ? { pong: true } : { sessionId: "restarted", title: "After restart", status: "idle" } }), true);
  }
  assert.equal((await pending).result.sessionId, "restarted");
  assert.deepEqual(opened, ["Chrome"]);
  assert.deepEqual(methods, ["ping", "create_drive_session"]);
  assert.equal(bridge.state.pending.size + bridge.state.inflight.size, 0);
});

test("an authenticated reconnect waits for Chrome's lease within the caller's timeout", async t => {
  for (const timeout of [45, 15]) await t.test(`${timeout}s budget`, async t => {
    let now = 100000;
    t.mock.method(Date, "now", () => now);
    const readyAt = now + 35750, retryUntil = readyAt + 5000;
    const browser = { clientId: "restarting-chrome", name: "work" };
    const health = { protocolVersion: 1, features: { browserPairing: 1 }, status: { clients: [], browsers: [browser] } };
    const running = { endpoint: "http://127.0.0.1:18765", health }, opened = [], methods = [];
    const pending = runCli(["session", "create", "--title", "After lease", "--timeout", String(timeout), "--json"], {
      findDaemon: async () => running,
      openConnectionBrowser: async () => {
        opened.push("Chrome"); return { browser: "Chrome", opened: true };
      },
      readHealth: async () => {
        now += 5000;
        return { ...health, status: { ...health.status, clients: now >= readyAt ? [browser] : [],
          connecting: now < readyAt ? [{ ...browser, retryAfterMs: retryUntil - now }] : [] } };
      },
      callTool: async (_endpoint, name, args) => {
        assert.equal(args.clientId, browser.clientId);
        methods.push(name);
        return name === "qingzhou_call" ? { pong: true } : { sessionId: "reconnected", title: "After lease", status: "idle" };
      },
    });
    if (timeout === 45) {
      assert.equal((await pending).result.sessionId, "reconnected");
      assert.deepEqual(methods, ["qingzhou_call", "qingzhou_create_drive_session"]);
    } else {
      await assert.rejects(pending, error => error.code === "CONNECTION_PENDING" && error.details.operationSubmitted === false);
      assert.deepEqual(methods, []);
      assert.equal(now, 115000, "a reconnect never extends the caller's deadline");
    }
    assert.deepEqual(opened, ["Chrome"]);
  });
});

test("automatic preparation waits for the default browser without launching a substitute", async t => {
  const { bridge, browser, running, deps } = await fixture(t);
  const connectedHealth = running.health;
  running.health = { ...connectedHealth, status: { ...connectedHealth.status, connected: false, clients: [] } };
  let opened = 0, healthReads = 0;
  const { value, requests } = await scriptedBrowsers(bridge, [browser], async request => {
    if (request.method === "ping") return { ok: true, result: { pong: true } };
    assert.equal(request.method, "create_drive_session");
    return { ok: true, result: { sessionId: "default-browser-task", title: "Default browser", status: "ready" } };
  }, () => runCli(["session", "create", "--title", "Default browser", "--timeout", "1", "--json"], {
    ...deps,
    readHealth: async () => ++healthReads >= 3 ? connectedHealth : running.health,
    openConnectionBrowser: async (uri, { signal, timeoutMs }) => {
      assert.equal(uri, `${bridge.endpoint}/qz-connect`);
      assert.equal(signal?.aborted ?? false, false);
      assert.ok(timeoutMs > 0 && timeoutMs <= 1000);
      assert.equal(++opened, 1, "an initializing extension does not authorize another browser launch");
      return { url: uri, opened: true, browser: "System default browser" };
    },
  }));
  assert.equal(opened, 1);
  assert.equal(healthReads, 3);
  assert.equal(value.result.sessionId, "default-browser-task");
  assert.equal(requests.filter(request => request.method === "create_drive_session").length, 1);
  assert.ok(requests.every(request => request.clientId === browser.id));
});

async function scriptedBrowsers(bridge, browsers, respond, operation) {
  const controller = new AbortController(), requests = [];
  const workers = browsers.map(async browser => {
    try {
      while (true) {
        const batch = await bridge.state.poll(browser, { timeoutMs: 100, signal: controller.signal });
        for (const request of batch) {
          requests.push({ ...request, clientId: browser.id });
          const payload = await respond(request, browser);
          assert.equal(completeBrowser(bridge.state, request.id, { clientId: browser.id, ...payload }), true);
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  });
  try { return { value: await Promise.race([operation(), ...workers]), requests }; }
  finally { controller.abort(); await Promise.all(workers); }
}

test("an existing session is found across authorized browsers before its script runs exactly once on its owner", async t => {
  const { bridge, browser, running, deps } = await fixture(t);
  const other = await pairBrowser(bridge.state, { id: "actual-owner" });
  running.health = await readHealth(bridge.endpoint);
  const owner = [browser, other].find(entry => entry.id !== running.health.status.clients[0].clientId);
  const { value, requests } = await scriptedBrowsers(bridge, [browser, other], async (request, target) => {
    if (request.method === "ping") return { ok: true, result: { pong: true } };
    if (request.method === "get_drive_session") return target.id === owner.id
      ? { ok: true, result: { sessionId: "existing", title: "Owner task", status: "ready" } }
      : { ok: false, error: { code: "DRIVE_SESSION_NOT_FOUND", message: "No such session." } };
    if (request.method === "get_session_snapshot") {
      assert.notEqual(target.id, owner.id);
      return { ok: true, result: { session: null } };
    }
    assert.equal(target.id, owner.id, "only the proven owner receives the script API preflight or script");
    if (request.method === "capabilities") return { ok: true, result: { scriptApiVersion: 2 } };
    assert.equal(request.method, "execute_tool");
    return { ok: true, result: { scriptApiVersion: 2, isError: false, result: { ok: true, result: { city: "Hangzhou" }, trace: ["Script started."] } } };
  }, () => runCli(["script", "--session", "existing"], {
    ...deps, readStdin: async () => 'return { city: "Hangzhou" };',
    openConnectionBrowser: () => assert.fail("a found task cannot be moved to a new browser"),
  }));
  assert.deepEqual(JSON.parse(value.text), { ok: true, result: { city: "Hangzhou" }, trace: ["Script started."] });
  assert.equal(requests.filter(request => request.method === "get_drive_session").length, 2);
  assert.equal(requests.filter(request => request.method === "execute_tool").length, 1);
});

test("uncertain or ambiguous session ownership fails before script dispatch", async t => {
  const { bridge, browser, running, deps } = await fixture(t);
  const other = await pairBrowser(bridge.state, { id: "another-owner" });
  running.health = await readHealth(bridge.endpoint);
  for (const ambiguity of ["duplicate", "unavailable"]) {
    const { requests } = await scriptedBrowsers(bridge, [browser, other], async (request, target) => {
      if (request.method === "ping") return { ok: true, result: { pong: true } };
      assert.equal(request.method, "get_drive_session", "ownership uncertainty cannot admit script execution");
      if (ambiguity === "unavailable" && target.id === other.id) return { ok: false, error: { code: "BRIDGE_REQUEST_TIMEOUT", message: "This profile did not respond." } };
      return { ok: true, result: { sessionId: "shared", title: "Task", status: "ready" } };
    }, () => assert.rejects(runCli(["script", "--session", "shared"], {
      ...deps, readStdin: async () => "return 7;",
      openConnectionBrowser: () => assert.fail("an uncertain task cannot be moved to another profile"),
      restartDaemon: () => assert.fail("ownership errors cannot restart a compatible service"),
    }), error => error.code === (ambiguity === "duplicate" ? "SELECTION_REQUIRED" : "BRIDGE_REQUEST_TIMEOUT")));
    assert.equal(requests.filter(request => request.method === "execute_tool").length, 0);
  }
});

test("script incompatibility after admission is reported without restart, reconnect or replay", async t => {
  const { bridge, browser, deps } = await fixture(t);
  for (const failureStage of ["api-preflight", "execute"]) {
    const { requests } = await scriptedBrowsers(bridge, [browser], async request => {
      if (request.method === "ping") return { ok: true, result: { pong: true } };
      if (request.method === "capabilities") return { ok: true, result: { scriptApiVersion: failureStage === "api-preflight" ? 1 : 2 } };
      assert.equal(request.method, "execute_tool");
      return { ok: false, error: { code: "UPGRADE_REQUIRED", message: "The operation may already have run." } };
    }, () => assert.rejects(runCli(["script", "--session", "existing", "--client", browser.id], {
      ...deps, readStdin: async () => "return 7;",
      restartDaemon: () => assert.fail("an operation failure cannot be treated as a service preflight upgrade"),
      openConnectionBrowser: () => assert.fail("an admitted script is never retried on another browser"),
    }), error => error.code === "UPGRADE_REQUIRED"));
    assert.equal(requests.filter(request => request.method === "execute_tool").length, failureStage === "api-preflight" ? 0 : 1);
    assert.equal(requests.filter(request => request.method === "capabilities").length, 1);
    assert.equal(requests.some(request => request.method === "get_drive_session"), false, "an explicit selector never searches other profiles");
  }
});

test("session cancellation reaches the browser while its script is awaiting a result", async t => {
  const { bridge, browser, deps, respond, nextRequest } = await fixture(t);
  const script = runCli(["script", "--session", "drive"], { ...deps, readStdin: async () => "async () => await tools.wait({seconds:30})" });
  await respond("capabilities", { scriptApiVersion: 2 });
  const pending = await nextRequest();
  assert.equal(pending.method, "execute_tool");
  assert.equal(pending.params.sessionId, "drive");
  const cancelled = runCli(["session", "cancel", "drive"], deps);
  const stop = await respond("stop_session", { sessionId: "drive", status: "ended" });
  assert.equal(stop.params.sessionId, "drive");
  assert.equal((await cancelled).result.status, "ended");
  assert.equal(completeBrowser(bridge.state, pending.id, { clientId: browser.id, ok: true,
    result: { scriptApiVersion: 2, isError: true, result: { ok: false, result: { code: "OPERATION_ABORTED", message: "Session ended." }, trace: [] } } }), true);
  assert.equal((await script).exitCode, 1);
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
  assert.ok(requests.filter(request => !["ping", "get_drive_session"].includes(request.method))
    .every(request => request.params.timeoutSeconds > 0 && request.params.timeoutSeconds <= 180));
  assert.ok(requests.every(request => request.timeoutMs > 0), "preparation and task requests each retain a bounded deadline");
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
  const { bridge, browser, traffic, deps, nextRequest } = await fixture(t);
  const controller = new AbortController();
  let output = "";
  const pending = main(["watch", "task", "--json"], { ...deps, signal: controller.signal,
    stdout: { write: text => { output += text; } }, stderr: { write: () => assert.fail("unexpected stderr") },
  });
  const request = await nextRequest();
  assert.equal(request.method, "get_session_snapshot");
  controller.abort();
  assert.equal(await pending, 130);
  assert.equal(JSON.parse(output).code, "INTERRUPTED");
  assert.equal(bridge.state.inflight.size, 0);
  assert.equal(completeBrowser(bridge.state, request.id, { ok: true, result: snapshot("completed") }), false);
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
  const { bridge, traffic, deps, nextRequest } = await fixture(t);
  const rejected = assert.rejects(runCli(["create", "Work"], deps), error => error.code === "BRIDGE_CLOSED");
  const request = await nextRequest();
  assert.equal(request.method, "create_session");
  await bridge.close();
  await rejected;
  assert.equal(traffic.filter(entry => entry.rpc?.method === "initialize").length, 1);
  assert.equal(traffic.filter(entry => entry.rpc?.method === "tools/call" && entry.rpc.params.name === "qingzhou_create_session").length, 1);
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
});

test("failed initialization is retained instead of reconnecting inside a command", async () => {
  let attempts = 0;
  const fetch = async () => { attempts++; return new Response("unavailable", { status: 503 }); };
  await withToolClient(async call => {
    for (let i = 0; i < 2; i++) await assert.rejects(call("http://127.0.0.1:1", "qingzhou_bridge_status", {}, { fetch }), error => error.code === "CONNECTION_ERROR" && /unavailable/.test(error.message));
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
    })), error => error.code === "CONNECTION_ERROR" && (cancelled ? error.name === "AbortError" : /handshake timed out/.test(error.message)));
    assert.equal(initialized, 1);
    assert.equal(cleanupAborted, true);
    assert.ok(Date.now() - started < 500);
  }
});

test("automatic preparation reports an initialization failure without opening another browser or retrying", async t => {
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
  await assert.rejects(runCli(["session", "create", "--title", "Initialization failure"], {
    findDaemon: async () => ({ endpoint: `http://127.0.0.1:${server.address().port}`, health: { features: { browserPairing: 1, scriptApiVersion: 2 }, status: { clients: [{ clientId: "browser" }] } } }),
    openConnectionBrowser: () => assert.fail("a protocol failure must not open another browser"),
    restartDaemon: () => assert.fail("failed MCP initialization cannot authorize a service restart"),
  }), error => error.code === "CONNECTION_ERROR");
  assert.equal(initializations, 1);
  assert.ok(Date.now() - started < 1000);
});

test("automatic preparation recovers a timed-out browser ping on the same MCP session", async t => {
  const { bridge, browser, running, traffic } = await fixture(t);
  let opens = 0;
  const pending = runCli(["session", "create", "--title", "Recovered browser", "--json"], { findDaemon: async () => running,
    readHealth: async () => running.health,
    openConnectionBrowser: async () => { opens++; return { opened: true }; },
  });
  const [first] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(first.method, "ping");
  completeBrowser(bridge.state, first.id, { clientId: browser.id, ok: false, code: "BRIDGE_REQUEST_TIMEOUT", error: "The old browser poll timed out." });
  const [second] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(second.method, "ping");
  completeBrowser(bridge.state, second.id, { clientId: browser.id, ok: true, result: { pong: true } });
  const [create] = await bridge.state.poll(browser, { timeoutMs: 2000 });
  assert.equal(create.method, "create_drive_session");
  completeBrowser(bridge.state, create.id, { clientId: browser.id, ok: true, result: { sessionId: "recovered", title: "Recovered browser", status: "ready" } });
  assert.equal((await pending).result.sessionId, "recovered");
  assert.equal(opens, 1);
  assertOneSession(traffic, 1);
});

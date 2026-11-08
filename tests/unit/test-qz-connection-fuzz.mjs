import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { main } from "../../services/mcp-bridge/src/cli.mjs";
import { prepareConnection } from "../../services/mcp-bridge/src/connection.mjs";
import { PROTOCOL_VERSION, QzError } from "../../services/mcp-bridge/src/client.mjs";

// Persisted replay corpus. Override with comma-separated uint32 seeds to reproduce
// or extend a run: QZ_CONNECTION_FUZZ_SEEDS=1,4294967295 node --test <this file>.
// This exercises real CLI admission/routing with a stateful *simulated* service
// and browser transport. It does not launch a daemon, MCP socket, or browser.
const seeds = (process.env.QZ_CONNECTION_FUZZ_SEEDS || "1,1592594996,3735928559,4294967295")
  .split(",").map(value => {
    const seed = Number(value);
    assert.ok(/^\d+$/.test(value) && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, "expected uint32 replay seed");
    return seed;
  });

function random(seed) {
  let state = seed;
  return max => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) % max;
  };
}

function shuffled(values, next) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = next(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

const failure = code => new QzError(code, `Simulated ${code}: inspect the selected profile before retrying.`, {
  hint: "Reconnect the same profile and inspect the session before retrying.",
});

class SimulatedService {
  constructor(seed, next) {
    this.next = next;
    this.generation = 0;
    this.serial = 0;
    this.browsers = Array.from({ length: 2 + next(3) }, (_, index) => ({
      clientId: `00000000-0000-4000-${index.toString(16).padStart(4, '0')}-${next(100000).toString(16).padStart(12, '0')}`,
      name: `profile-${index}-${next(100000)}`,
      online: true,
      sessions: new Map(),
    }));
    this.order = [...this.browsers];
    this.replace();
  }

  replace() {
    this.generation++;
    this.instanceId = `instance-${this.generation}`;
    this.endpoint = `http://127.0.0.1:${24000 + this.generation}`;
  }

  health() {
    const identity = browser => ({ clientId: browser.clientId, name: browser.name });
    return {
      instanceId: this.instanceId, protocolVersion: this.protocol,
      features: { browserPairing: this.pairing, scriptApiVersion: this.scriptApi },
      buildId: this.buildId,
      status: { connected: this.browsers.some(browser => browser.online),
        browsers: this.order.map(identity), clients: this.order.filter(browser => browser.online).map(identity) },
    };
  }

  record() {
    return { endpoint: this.endpoint, instanceId: this.instanceId,
      compatible: this.compatible, updateAvailable: this.buildId !== "current", health: this.health() };
  }

  begin() {
    this.protocol = PROTOCOL_VERSION;
    this.pairing = 1;
    this.scriptApi = 2;
    this.compatible = true;
    this.buildId = this.next(2) ? "current" : "old-compatible-build";
    this.browsers.forEach(browser => { browser.online = true; });
    this.order = shuffled(this.browsers, this.next);
    this.calls = [];
    this.events = [];
    this.restarts = 0;
    this.starts = 0;
    this.healthReads = 0;
    this.opens = 0;
    this.missing = false;
    this.reconnect = null;
    this.changeOnHealth = false;
    this.persistentUpgrade = false;
    this.upgradeRace = false;
    this.abortDiscovery = false;
    this.loseMutationReply = false;
    this.extensionUpgrade = false;
    this.unresponsive = null;
    this.cancelStart = false;
    this.cancelUpgrade = false;
    this.snapshotOwners = new Set();
    this.defaultBrowser = null;
    this.launchAttempts = [];
    this.clock = null;
    this.controller = new AbortController();
  }

  async tick() {
    // The seed determines async boundaries, not wall-clock races. Offline tests
    // use zero connection budget through prepareConnection, not fragile sleeps.
    const milliseconds = this.next(3);
    if (this.clock) this.clock.now += 10 + milliseconds;
    if (milliseconds) await delay(milliseconds);
    else await Promise.resolve();
  }

  dependencies() {
    return {
      signal: this.controller.signal,
      readStdin: async () => "return { ok: true };",
      findDaemon: async () => {
        this.events.push("find");
        await this.tick();
        if (this.abortDiscovery) this.controller.abort(failure("OPERATION_ABORTED"));
        return this.missing ? null : this.record();
      },
      ensureDaemon: async ({ signal }) => {
        this.events.push("start"); this.starts++;
        assert.equal(signal, this.controller.signal);
        await this.tick();
        this.missing = false;
        if (this.cancelStart) this.controller.abort(failure("OPERATION_ABORTED"));
        return this.record();
      },
      restartDaemon: async ({ expected, preferredPort, signal }) => {
        this.events.push("upgrade"); this.restarts++;
        assert.equal(expected.instanceId, this.instanceId);
        assert.equal(expected.endpoint, this.endpoint);
        assert.equal(preferredPort, Number(new URL(this.endpoint).port));
        assert.equal(signal, this.controller.signal);
        assert.equal(this.calls.length, 0, "upgrade must precede even browser probes");
        await this.tick();
        if (this.cancelUpgrade) this.controller.abort(failure("OPERATION_ABORTED"));
        if (this.upgradeRace) { this.replace(); throw failure("CONNECTION_CHANGED"); }
        this.replace();
        if (!this.persistentUpgrade) {
          this.protocol = PROTOCOL_VERSION; this.pairing = 1; this.scriptApi = 2; this.compatible = true;
        }
        return this.record();
      },
      readHealth: async endpoint => {
        assert.equal(endpoint, this.endpoint);
        this.healthReads++;
        await this.tick();
        if (this.changeOnHealth) this.replace();
        if (this.reconnect && this.healthReads >= this.reconnect.after) this.reconnect.browser.online = true;
        return this.health();
      },
      openConnectionBrowser: async (uri, { signal, timeoutMs, ...options }) => {
        this.opens++;
        assert.ok(this.defaultBrowser, "only launcher histories authorize opening a browser");
        assert.equal(this.opens, 1, "connection preparation must not open another browser");
        assert.equal(uri, `${this.endpoint}/qz-connect`);
        assert.equal(signal, this.controller.signal);
        assert.ok(timeoutMs > 0 && timeoutMs <= 300, "opening stays within the caller's connection budget");
        assert.deepEqual(options, {}, "the default browser opener does not receive a fallback list");
        await this.tick();
        this.launchAttempts.push(this.defaultBrowser.clientId);
        return { browser: "System default browser", opened: true, url: uri };
      },
      callTool: async (endpoint, name, args, options) => {
        this.events.push(name);
        this.calls.push({ endpoint, name, args: structuredClone(args) });
        assert.equal(endpoint, this.endpoint, "never dispatch on an obsolete service endpoint");
        assert.equal(options.signal, this.controller.signal);
        assert.ok(options.timeoutMs > 0 && Number.isFinite(options.timeoutMs));
        const browser = this.browsers.find(entry => entry.clientId === args.clientId);
        assert.ok(browser, "all calls carry a resolved UUID, never a name/default");
        await this.tick();
        if (!browser.online) throw failure("BRIDGE_CLIENT_DISCONNECTED");
        if (name === "qingzhou_call") {
          assert.equal(args.method, "ping");
          if (browser === this.unresponsive) throw failure("BRIDGE_REQUEST_TIMEOUT");
          return { pong: true };
        }
        if (name === "qingzhou_get_drive_session") {
          if (!browser.sessions.has(args.sessionId) || this.snapshotOwners.has(browser.clientId)) throw failure("DRIVE_SESSION_NOT_FOUND");
          return { sessionId: args.sessionId, status: "ready" };
        }
        if (name === "qingzhou_get_session_snapshot") {
          assert.equal(args.compact, true);
          assert.equal(args.tail, true);
          if (this.snapshotOwners.has(browser.clientId) && browser.sessions.has(args.sessionId)) {
            return { session: { sessionId: args.sessionId, status: "completed" } };
          }
          assert.equal(browser.sessions.has(args.sessionId), false);
          return { session: null };
        }
        if (name === "qingzhou_create_drive_session") {
          const sessionId = `session-${++this.serial}`;
          browser.sessions.set(sessionId, { executions: 0 });
          return { sessionId, title: args.title, status: "ready" };
        }
        assert.equal(name, "qingzhou_execute_tool");
        assert.equal(args.name, "run_script");
        const session = browser.sessions.get(args.sessionId);
        assert.ok(session, "a script cannot cross session ownership");
        session.executions++;
        if (this.extensionUpgrade) throw failure("UPGRADE_REQUIRED");
        if (this.loseMutationReply) {
          // The operation committed, then its response was lost. Reconnect is a
          // later command, never permission to replay this mutation.
          browser.online = false;
          throw failure("BRIDGE_CLIENT_DISCONNECTED");
        }
        return { scriptApiVersion: 2, isError: false, result: { ok: true, result: { sessionId: args.sessionId, clientId: browser.clientId }, trace: [] } };
      },
    };
  }
}

// Independent oracle: derive ownership from model data, not CLI probes/results.
// Explicit UUID/name pins exactly one identity. Unselected multi-profile script
// requests require a unique owner; creation chooses first online registration.
function expectedRoute(service, selector, sessionId) {
  if (selector) {
    const selected = service.browsers.find(browser => [browser.clientId, browser.name].includes(selector));
    return !selected ? { code: "CLIENT_NOT_FOUND" }
      : !selected.online ? { code: "CLIENT_OFFLINE" } : { clientId: selected.clientId };
  }
  const online = service.order.filter(browser => browser.online);
  if (!sessionId || online.length === 1) return { clientId: online[0]?.clientId };
  const owners = online.filter(browser => browser.sessions.has(sessionId));
  return owners.length === 1 ? { clientId: owners[0].clientId }
    : { code: owners.length ? "SELECTION_REQUIRED" : "DRIVE_SESSION_NOT_FOUND" };
}

export const connectionScenarioIds = Object.freeze(["create-auto", "create-pinned", "script-owner", "script-pinned", "unknown", "offline",
  "reconnect", "service-changed", "duplicate-owner", "missing-session", "upgrade", "upgrade-stuck",
  "upgrade-race", "startup", "cancel-discovery", "lost-reply", "extension-upgrade", "uncertain-owner",
  "launcher-connect", "launcher-pending", "reconnect-deadline", "cancel-startup", "cancel-upgrade",
  "snapshot-owner", "snapshot-conflict"]);
assert.equal(connectionScenarioIds.length, 25);
assert.equal(new Set(connectionScenarioIds).size, 25);

for (const seed of seeds) {
  test(`seeded simulated direct-drive lifecycle seed=${seed}`, { timeout: 30000 }, async t => {
    const next = random(seed), service = new SimulatedService(seed, next);
    const history = [];
    // Decks guarantee denied and admitted transitions for every persisted seed;
    // order, identities, owners, compatibility, delays and earlier state vary.
    for (const scenario of [...shuffled(connectionScenarioIds, next), ...shuffled(connectionScenarioIds, next)]) {
      service.begin();
      const target = service.browsers[next(service.browsers.length)];
      let selector, sessionId = "", code, expectedUpgrades = 0;
      let direct = false;
      const script = ["script-owner", "script-pinned", "duplicate-owner", "missing-session", "lost-reply", "extension-upgrade", "uncertain-owner"].includes(scenario)
        || scenario.startsWith("upgrade") || scenario.startsWith("snapshot-");
      if (script) {
        // Sometimes reuse a real session created by an earlier transition.
        sessionId = scenario.startsWith("snapshot-") ? `snapshot-${seed}-${history.length}`
          : [...target.sessions.keys()][next(Math.max(1, target.sessions.size))] || `task-${seed}-${history.length}`;
        target.sessions.set(sessionId, target.sessions.get(sessionId) || { executions: 0 });
      }
      if (["create-pinned", "script-pinned", "unknown", "offline", "reconnect", "service-changed", "lost-reply", "extension-upgrade", "reconnect-deadline"].includes(scenario)) {
        selector = next(2) ? target.name : target.clientId;
      }
      if (scenario === "unknown") selector = `unknown-${next(100000)}`;
      if (["offline", "reconnect", "service-changed"].includes(scenario)) target.online = false;
      if (scenario === "offline") direct = true;
      if (scenario === "reconnect") service.reconnect = { browser: target, after: 1 + next(2) };
      if (scenario === "service-changed") { service.changeOnHealth = true; code = "CONNECTION_CHANGED"; }
      if (scenario === "duplicate-owner") {
        service.browsers.find(browser => browser !== target).sessions.set(sessionId, { executions: 0 });
      }
      if (scenario === "missing-session") sessionId = `absent-${seed}-${history.length}`;
      if (scenario.startsWith("upgrade")) {
        // Vary the independently incompatible contract, not only build hashes.
        const variant = next(4);
        if (variant === 0) service.protocol = PROTOCOL_VERSION + 1;
        if (variant === 1) service.pairing = 0;
        if (variant === 2) service.scriptApi = 1;
        if (variant === 3) service.compatible = false;
        expectedUpgrades = 1;
        if (scenario === "upgrade-stuck") { service.persistentUpgrade = true; code = "UPGRADE_REQUIRED"; }
        if (scenario === "upgrade-race") { service.upgradeRace = true; code = "CONNECTION_CHANGED"; }
      }
      if (scenario === "startup") service.missing = true;
      if (scenario === "cancel-discovery") {
        service.abortDiscovery = true;
        service.missing = Boolean(next(2));
        service.compatible = false;
        code = "OPERATION_ABORTED";
      }
      if (scenario === "lost-reply") { service.loseMutationReply = true; code = "BRIDGE_CLIENT_DISCONNECTED"; }
      if (scenario === "extension-upgrade") { service.extensionUpgrade = true; code = "UPGRADE_REQUIRED"; }
      if (scenario === "uncertain-owner") {
        service.unresponsive = service.browsers[next(service.browsers.length)];
        code = "BRIDGE_REQUEST_TIMEOUT";
      }
      if (scenario === "cancel-startup") {
        service.missing = true;
        service.cancelStart = true;
        code = "OPERATION_ABORTED";
      }
      if (scenario === "cancel-upgrade") {
        service.compatible = false;
        service.cancelUpgrade = true;
        expectedUpgrades = 1;
        code = "OPERATION_ABORTED";
      }
      if (scenario.startsWith("snapshot-")) {
        service.snapshotOwners.add(target.clientId);
        if (scenario === "snapshot-conflict") {
          // A direct-drive record in one profile conflicts with a transcript-only
          // owner in another; the fallback must participate in ambiguity checks.
          service.browsers.find(browser => browser !== target).sessions.set(sessionId, { executions: 0 });
        }
      }
      if (scenario.startsWith("launcher-")) {
        service.browsers.forEach(browser => { browser.online = false; });
        service.defaultBrowser = target;
        if (scenario === "launcher-connect") service.reconnect = { browser: target, after: 2 + next(3) };
        else code = "CONNECTION_PENDING";
      }
      if (scenario === "reconnect-deadline") {
        target.online = false;
        code = "CLIENT_OFFLINE";
      }
      // A deterministic simulated clock controls launcher scheduling and the
      // reconnect cutoff. Async transport jitter is still generated by the seed.
      const clockMock = scenario.startsWith("launcher-") || scenario === "reconnect-deadline"
        ? t.mock.method(Date, "now", () => service.clock.now) : null;
      if (clockMock) service.clock = { now: 1000000 };
      const route = expectedRoute(service, selector, sessionId);
      if (scenario === "reconnect") route.clientId = target.clientId;
      else if (scenario === "launcher-connect") route.clientId = target.clientId;
      else code ||= route.code;
      const beforeExecutions = [...target.sessions.values()].reduce((sum, session) => sum + session.executions, 0);
      history.push({ scenario, selector, sessionId, order: service.order.map(browser => browser.clientId), code });
      try {
        if (direct) {
          await assert.rejects(prepareConnection({ options: { "client-id": selector }, timeoutSeconds: 0 }, service.dependencies()),
            error => {
              assert.equal(error.code, code);
              assert.ok(error.message);
              assert.equal(error.details.stage, "browser-connection");
              assert.equal(error.details.operationSubmitted, false);
              assert.match(error.details.hint, /qz connect uri/);
              return true;
            });
        } else {
          const argv = script ? ["script", "--session", sessionId] : ["session", "create", "--title", `history ${history.length}`];
          if (selector) argv.push("--client", selector);
          // Wait for the default browser within one budget; admission must
          // finish before, not one health read after, the simulated deadline.
          argv.push("--timeout", clockMock ? "0.3" : "2", "--json");
          let stdout = "", stderr = "";
          const exit = await main(argv, { ...service.dependencies(),
            stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
          });
          assert.equal(stderr, "");
          const output = JSON.parse(stdout);
          assert.equal(exit, code ? 1 : 0, stdout);
          if (code) {
            const error = script ? output.result : output;
            assert.equal(error.code, code);
            assert.ok(error.message.length > 10, "failure must explain what went wrong");
            if (scenario === "launcher-pending") {
              assert.match(error.hint, /qz connect uri/);
              assert.equal(error.details.operationSubmitted, false);
              assert.deepEqual(error.details.attemptedBrowsers, ["System default browser"]);
            }
          } else if (script) {
            assert.deepEqual(output.result, { sessionId, clientId: route.clientId });
          } else {
            assert.ok(service.browsers.find(browser => browser.clientId === route.clientId).sessions.has(output.result.sessionId));
          }
        }
        const mutations = service.calls.filter(call => ["qingzhou_execute_tool", "qingzhou_create_drive_session"].includes(call.name));
        assert.equal(mutations.length, !code || ["lost-reply", "extension-upgrade"].includes(scenario) ? 1 : 0, "no replay or mutation on denied admission");
        for (const call of mutations) {
          assert.equal(call.args.clientId, route.clientId);
          if (script) assert.equal(call.args.sessionId, sessionId);
        }
        if (selector && scenario !== "unknown") {
          assert.ok(service.calls.every(call => call.args.clientId === target.clientId), "explicit selection must not even probe another profile");
        }
        assert.equal(service.restarts, expectedUpgrades);
        assert.ok(service.restarts <= 1);
        assert.equal(service.starts, ["startup", "cancel-startup"].includes(scenario) ? 1 : 0);
        if (scenario.startsWith("launcher-")) {
          assert.deepEqual(service.launchAttempts, [target.clientId], "only the system default browser opens");
          assert.equal(service.opens, 1);
          assert.ok(service.healthReads > 0);
        } else assert.equal(service.opens, 0);
        if (["upgrade-stuck", "upgrade-race", "cancel-discovery", "cancel-startup", "cancel-upgrade", "unknown"].includes(scenario)) assert.equal(service.calls.length, 0);
        if (scenario.startsWith("snapshot-")) {
          assert.ok(service.calls.some(call => call.name === "qingzhou_get_session_snapshot" && call.args.clientId === target.clientId),
            "the transcript-only owner must be checked, not treated as missing");
          assert.equal(mutations.length, scenario === "snapshot-owner" ? 1 : 0);
        }
        if (scenario === "reconnect-deadline") {
          assert.ok(service.clock.now >= 1000000 + 300, "connection budget actually expired");
          assert.ok(service.healthReads > 1, "offline selection was polled, not immediately rejected");
          assert.equal(service.calls.length, 0, "other online browsers remain completely untouched");
          target.online = true;
          const recovered = await prepareConnection({ options: { "client-id": selector }, timeoutSeconds: 0 }, service.dependencies());
          assert.equal(recovered.clientId, target.clientId, "a fresh command admits the now-online identity");
          assert.equal(service.calls.length, 1, "recovery only pings, never replays the denied creation");
        }
        if (scenario === "lost-reply") {
          assert.equal([...target.sessions.values()].reduce((sum, session) => sum + session.executions, 0), beforeExecutions + 1);
          // A fresh command reconnects the same identity, but only prepares it.
          // The committed script must not be submitted again during recovery.
          service.reconnect = { browser: target, after: 1 };
          const recovered = await prepareConnection({ options: { "client-id": selector }, timeoutSeconds: 2, sessionId, script: true }, service.dependencies());
          assert.equal(recovered.clientId, target.clientId);
          assert.equal(service.calls.filter(call => call.name === "qingzhou_execute_tool").length, 1);
          assert.equal(service.restarts, 0);
        }
      } catch (error) {
        throw new Error(`${error.message}\nReplay: QZ_CONNECTION_FUZZ_SEEDS=${seed} node --test tests/unit/test-qz-connection-fuzz.mjs\nHistory: ${JSON.stringify(history)}\nCalls: ${JSON.stringify(service.calls)}`, { cause: error });
      } finally {
        clockMock?.mock.restore();
      }
    }
    t.diagnostic(`seed=${seed}; ${history.length} lifecycle transitions; simulated daemon/browser transport, no model`);
  });
}

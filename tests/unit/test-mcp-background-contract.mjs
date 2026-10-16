import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QINGZHOU_MCP_METHODS,
  createMcpTransport,
} from "../../src/background/transports/mcp.js";

const source = readFileSync("src/background/transports/mcp.ts", "utf8");
const switchMethods = [...source.matchAll(/case\s+["']([a-z_]+)["']\s*:/g)].map(match => match[1]);
assert.equal(new Set(QINGZHOU_MCP_METHODS).size, QINGZHOU_MCP_METHODS.length, "MCP capability methods must be unique");
assert.deepEqual(
  [...new Set(QINGZHOU_MCP_METHODS)].sort(),
  [...new Set(switchMethods)].sort(),
  "advertised MCP capabilities must exactly match dispatchable methods",
);

await everyAdvertisedMethodDispatches();
await readinessAndBusinessFailuresRemainObservable();

console.log(`MCP/background contracts passed (${QINGZHOU_MCP_METHODS.length} methods)`);

async function everyAdvertisedMethodDispatches() {
  const calls = [];
  const api = createApiFixture(calls);
  const transport = createMcpTransport(api, {
    bridge: {
      describe: () => ({ protocolVersion: 1, methods: QINGZHOU_MCP_METHODS }),
      getConfig: () => ({ enabled: true }),
      saveConfig: config => ({ ...config, saved: true }),
    },
  });
  for (const method of QINGZHOU_MCP_METHODS) {
    await transport.dispatch({
      method,
      params: {
        sessionId: "s1",
        automationId: "a1",
        name: "probe",
        config: {},
        message: {},
      },
    });
  }
  assert.equal(calls.filter(call => call === "system.ready").length, QINGZHOU_MCP_METHODS.length);
}

async function readinessAndBusinessFailuresRemainObservable() {
  let businessCalls = 0;
  const unavailable = new Error("runtime boot failed");
  unavailable.code = "BACKGROUND_NOT_READY";
  const transport = createMcpTransport(createApiFixture([], {
    "system.ready": async () => { throw unavailable; },
    "sessions.list": async () => { businessCalls += 1; },
  }));
  await assert.rejects(
    transport.dispatch({ method: "list_sessions" }),
    error => error === unavailable && error.code === "BACKGROUND_NOT_READY",
  );
  assert.equal(businessCalls, 0);

  const denied = new Error("session denied");
  denied.code = "SESSION_FORBIDDEN";
  const businessFailure = createMcpTransport(createApiFixture([], {
    "sessions.stop": async () => { throw denied; },
  }));
  await assert.rejects(
    businessFailure.dispatch({ method: "stop_session", params: { sessionId: "s1" } }),
    error => error === denied && error.code === "SESSION_FORBIDDEN",
  );
}

function createApiFixture(calls = [], overrides = {}) {
  const namespaces = ["system", "sessions", "tools", "data", "skills", "config", "settings", "automations", "trace"];
  return Object.fromEntries(namespaces.map(namespace => [namespace, new Proxy({}, {
    get(_target, method) {
      const path = `${namespace}.${String(method)}`;
      return overrides[path] || (async (...args) => {
        calls.push(path);
        if (path === "system.ping") return { pong: true };
        if (path === "trace.get") return [];
        if (path === "sessions.state") return { sessionId: args[0], status: "idle" };
        return {};
      });
    },
  })]));
}

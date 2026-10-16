import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpConnectPage } from "../../src/background/mcp/connect-page.js";
import { createBackgroundApi } from "../../src/background/background-api.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";

const sender = { id: "extension", frameId: 0, tab: { id: 12 }, url: "http://127.0.0.1:23001/qz-connect" };
function setup() {
  const state = { enabled: true, consent: true, url: sender.url, saved: [], wakes: 0, fetches: [] };
  const deps = {
    extensionId: "extension",
    assertConsent() { if (!state.consent) throw Object.assign(new Error("Consent required"), { code: "DATA_CONSENT_REQUIRED" }); },
    getConfig: async () => ({ enabled: state.enabled }),
    saveConfig: async patch => { state.saved.push(patch); },
    getTab: async () => ({ url: state.url }),
    wake() { state.wakes++; },
    fetch: async (url, options) => {
      state.fetches.push({ url, options });
      return new Response(JSON.stringify({ service: "qz-browser-agent", protocolVersion: 1, instanceId: "fixture" }));
    },
  };
  return { state, deps };
}

test("connection uses the sender's port and wakes an idle connection through the runtime transport", async () => {
  const { state, deps } = setup();
  const transport = createRuntimeMessageTransport(createBackgroundApi({ system: { connectMcp: createMcpConnectPage(deps) } }));
  const result = await new Promise(resolve => transport.listener({ type: "mcp_bridge_connect", endpoint: "http://evil.example" }, sender, resolve));
  assert.deepEqual(result, { ok: true, connected: true });
  assert.deepEqual(state.saved, [{ endpoint: "http://127.0.0.1:23001" }]);
  assert.equal(state.wakes, 1);
  assert.equal(state.fetches[0].url, "http://127.0.0.1:23001/health");
  assert.equal(state.fetches[0].options.redirect, "error");
});

test("connection rejects untrusted pages, subframes and extension senders without a tab", async () => {
  for (const invalid of [
    { ...sender, id: "other" }, { ...sender, frameId: 1 }, { ...sender, tab: undefined },
    { ...sender, url: "https://evil.example/qz-connect" },
    { ...sender, url: "http://127.0.0.1:23001/other" },
    { ...sender, url: "http://localhost.evil.example/qz-connect" },
    { ...sender, url: "http://user@localhost/qz-connect" },
  ]) {
    const { state, deps } = setup();
    await assert.rejects(createMcpConnectPage(deps)(invalid), { code: "MCP_CONNECTION_PAGE_REQUIRED" });
    assert.equal(state.fetches.length, 0);
    assert.equal(state.saved.length, 0);
  }
});

test("first-use consent and an explicitly disabled connection are respected", async () => {
  for (const [key, code] of [["consent", "DATA_CONSENT_REQUIRED"], ["enabled", "MCP_CONNECTION_DISABLED"]]) {
    const { state, deps } = setup();
    state[key] = false;
    await assert.rejects(createMcpConnectPage(deps)(sender), { code });
    assert.equal(state.fetches.length, 0);
    assert.equal(state.saved.length, 0);
  }
});

test("invalid health, navigation and disabling during health checks cannot change the endpoint", async () => {
  for (const variant of ["service", "version", "instance", "http", "network", "navigation", "disable", "consent"]) {
    const { state, deps } = setup();
    deps.fetch = async () => {
      if (variant === "network") throw new Error("network unavailable");
      if (variant === "navigation") state.url = "https://example.com";
      if (variant === "disable") state.enabled = false;
      if (variant === "consent") state.consent = false;
      return new Response(JSON.stringify({ service: variant === "service" ? "other" : "qz-browser-agent",
        protocolVersion: variant === "version" ? 2 : 1, instanceId: variant === "instance" ? "" : "fixture" }),
      { status: variant === "http" ? 503 : 200 });
    };
    await assert.rejects(createMcpConnectPage(deps)(sender));
    assert.equal(state.saved.length, 0, variant);
    assert.equal(state.wakes, 0, variant);
  }
});

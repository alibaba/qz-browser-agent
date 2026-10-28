import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpConnectPage, assertMcpSettingsSender } from "../../src/background/mcp/connect-page.js";
import { createBackgroundApi } from "../../src/background/background-api.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";

const sender = { id: "extension", frameId: 0, tab: { id: 12 }, url: "http://127.0.0.1:23001/qz-connect" };
const status = { state: "connected", clientId: "profile-uuid", name: "default", endpoint: "http://127.0.0.1:23001", retryCount: 0, retryLimit: 3 };
function setup() {
  const state = { consent: true, url: sender.url, connections: [] };
  const deps = {
    extensionId: "extension",
    assertConsent() { if (!state.consent) throw Object.assign(new Error("Consent required"), { code: "DATA_CONSENT_REQUIRED" }); },
    getTab: async () => ({ url: state.url }),
    connect: async (input, assertCurrent) => { await assertCurrent(); state.connections.push(input); return status; },
  };
  return { state, deps };
}

test("connection derives its port from the Chrome sender and explicitly enables through the connection owner", async () => {
  const { state, deps } = setup();
  const transport = createRuntimeMessageTransport(createBackgroundApi({ system: { connectMcp: createMcpConnectPage(deps) } }));
  const result = await new Promise(resolve => transport.listener({ type: "mcp_bridge_connect", endpoint: "http://evil.example" }, sender, resolve));
  assert.deepEqual(result, { ok: true, connected: true, status });
  assert.deepEqual(state.connections, [{ endpoint: "http://127.0.0.1:23001", name: "" }]);
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
    assert.equal(state.connections.length, 0);
  }
});

test("first-use consent and tab navigation are checked again during asynchronous pairing", async () => {
  for (const variant of ["initial-consent", "navigation", "late-consent"]) {
    const { state, deps } = setup();
    if (variant === "initial-consent") state.consent = false;
    deps.connect = async (_input, assertCurrent) => {
      if (variant === "navigation") state.url = "https://example.com";
      else state.consent = false;
      await assertCurrent(); state.connections.push("should not happen"); return status;
    };
    await assert.rejects(createMcpConnectPage(deps)(sender), { code: variant === "navigation" ? "MCP_CONNECTION_PAGE_CHANGED" : "DATA_CONSENT_REQUIRED" });
    assert.equal(state.connections.length, 0);
  }
});

test("a paused or retrying connection never reports connected to the CLI page", async () => {
  const { deps } = setup();
  for (const state of ["paused", "reconnecting"]) {
    deps.connect = async () => ({ ...status, state, lastError: { code: "BRIDGE_NAME_IN_USE", message: "Choose another browser name." } });
    await assert.rejects(createMcpConnectPage(deps)(sender), { code: "BRIDGE_NAME_IN_USE" });
  }
});

test("a closed connection tab returns a permanent source-change error", async () => {
  const { deps } = setup(); deps.getTab = async () => { throw new Error("No tab with id"); };
  await assert.rejects(createMcpConnectPage(deps)(sender), { code: "MCP_CONNECTION_PAGE_CHANGED" });
});

test("Settings messages use local status/connect/disconnect routes with validated extension identity", async () => {
  const seen = [], source = { id: "extension", url: "chrome-extension://extension/sidepanel.html" };
  const api = createBackgroundApi({ system: Object.fromEntries(["mcpConnectionStatus", "connectMcpFromSettings", "disconnectMcp"].map(name => [name, (sender, input) => { assertMcpSettingsSender(sender, "extension"); seen.push({ name, input }); return status; }])) });
  const transport = createRuntimeMessageTransport(api);
  for (const type of ["mcp_connection_status", "mcp_connection_connect", "mcp_connection_disconnect"]) {
    const response = await new Promise(resolve => transport.listener({ type, name: "personal", endpoint: "http://localhost:7" }, source, resolve));
    assert.deepEqual(response, { ok: true, result: status });
  }
  assert.deepEqual(seen.map(x => x.name), ["mcpConnectionStatus", "connectMcpFromSettings", "disconnectMcp"]);
  const rejected = await new Promise(resolve => transport.listener({ type: "mcp_connection_connect" }, sender, resolve));
  assert.equal(rejected.code, "MCP_CONNECTION_PAGE_REQUIRED");
  for (const invalid of [{ ...source, id: "other" }, { ...source, url: "chrome-extension://extension.evil/settings" }, { ...source, url: undefined }]) assert.throws(() => assertMcpSettingsSender(invalid, "extension"));
  const firefoxPage = { id: "extension", url: "moz-extension://7588e7cb-5098-45b0-89ae-e96209ae9f67/sidepanel/sidepanel.html" };
  assertMcpSettingsSender(firefoxPage, "extension");
  assert.throws(() => assertMcpSettingsSender({ ...firefoxPage, id: "other" }, "extension"));
  assert.throws(() => assertMcpSettingsSender({ id: "extension", url: "moz-extension://sidepanel.html" }, "extension"));
  assert.throws(() => assertMcpSettingsSender({ id: "extension", url: "https://example.com/sidepanel.html" }, "extension"));
});

test("Settings port requests preserve sender validation and the result envelope", async () => {
  const seen = [], source = { id: "extension", url: "chrome-extension://extension/sidepanel.html" };
  const api = createBackgroundApi({ system: { ready() {}, ...Object.fromEntries(["mcpConnectionStatus", "connectMcpFromSettings", "disconnectMcp"].map(name => [name, (sender, input) => { assertMcpSettingsSender(sender, "extension"); seen.push({ name, input }); return status; }])) } });
  const transport = createSidepanelTransport(api), messages = [], port = { sender: source, postMessage: message => messages.push(message) };
  for (const type of ["mcp_connection_status", "mcp_connection_connect", "mcp_connection_disconnect"]) {
    await transport.dispatch({ type, requestId: type, name: "personal", endpoint: "http://localhost:7" }, port);
    assert.deepEqual(messages.at(-1).result, status);
  }
  assert.deepEqual(seen.map(x => x.name), ["mcpConnectionStatus", "connectMcpFromSettings", "disconnectMcp"]);
  await assert.rejects(transport.dispatch({ type: "mcp_connection_connect" }, { postMessage() {}, sender }), { code: "MCP_CONNECTION_PAGE_REQUIRED" });
});


test("binding URLs accept one encoded name and preserve the trusted endpoint", async () => {
  const { state, deps } = setup();
  const source = { ...sender, url: `${sender.url}?name=work%2DChrome_2&endpoint=http%3A%2F%2Fevil.example` };
  state.url = source.url;
  await createMcpConnectPage(deps)(source);
  assert.deepEqual(state.connections, [{ endpoint: "http://127.0.0.1:23001", name: "work-Chrome_2" }]);
});

test("binding URLs reject empty, duplicate and malformed names before connecting", async () => {
  for (const query of ["name=", "name=work&name=other", "name=two%20words", "name=%20work", "name=%E4%B8%AD%E6%96%87", "name=-work", "name=a%2Fb", "name=0a4d8fbe-7ac7-4ada-9f1e-48263996a709"]) {
    const { state, deps } = setup(), source = { ...sender, url: `${sender.url}?${query}` };
    state.url = source.url;
    await assert.rejects(createMcpConnectPage(deps)(source), { code: "BRIDGE_NAME_INVALID" });
    assert.equal(state.connections.length, 0);
  }
});

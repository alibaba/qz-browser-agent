import { pairBrowser, pollBrowser, completeBrowser } from "../support/paired-bridge.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { callTool } from "../../services/mcp-bridge/src/client.mjs";

async function bridgeFixture(t) {
  const bridge = await startBridge({ port: 0, connectWaitMs: 0 });
  t.after(() => bridge.close());
  await pairBrowser(bridge.state, { id: "browser" });
  return bridge;
}

test("typed extension errors keep recovery metadata through a real MCP client without replay", async t => {
  const bridge = await bridgeFixture(t);
  const pending = callTool(bridge.endpoint, "qingzhou_export_data_table", { table: "results" });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, "DOWNLOAD_INTERRUPTED");
    assert.match(error.message, /interrupted/);
    assert.deepEqual(error.details, { downloadId: 42, filename: "results.xlsx", reason: "USER_CANCELED" });
    assert.equal(JSON.stringify(error).includes("secret-api-key"), false);
    return true;
  });
  const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  assert.equal(request.method, "export_data_table");
  completeBrowser(bridge.state, request.id, {
    ok: false, code: "DOWNLOAD_INTERRUPTED", error: "Download interrupted.",
    details: { downloadId: 42, filename: "results.xlsx", reason: "USER_CANCELED", apiKey: "secret-api-key", request: { authorization: "secret-api-key" } },
  });
  await rejected;
  assert.equal(bridge.state.pending.size, 0);
  assert.equal(bridge.state.inflight.size, 0);
});

test("MCP typed errors have an explicit JSON envelope and omit arbitrary provider details", async t => {
  const bridge = await bridgeFixture(t);
  const client = new Client({ name: "errors-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`)));
  t.after(() => client.close());
  const pending = client.callTool({ name: "qingzhou_update_settings", arguments: { config: { language: "en" } } });
  const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  completeBrowser(bridge.state, request.id, {
    ok: false, code: "SETTINGS_PARTIALLY_UPDATED", error: "Model settings were saved; language failed.",
    details: { request: { apiKey: "private" } },
  });
  const result = await pending;
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    code: "SETTINGS_PARTIALLY_UPDATED", message: "SETTINGS_PARTIALLY_UPDATED: Model settings were saved; language failed.",
  });
});

test("Skill missing-resource results become actionable MCP errors while generic tool results stay data", async t => {
  const bridge = await bridgeFixture(t);
  for (const [name, args, result, details] of [
    ["qingzhou_get_skill", { name: "missing" }, { error: "Skill not found", code: "SKILL_NOT_FOUND", details: { name: "missing" }, available: ["existing"] }, { name: "missing", available: ["existing"] }],
    ["qingzhou_get_skill_resource", { name: "existing", path: "missing.txt" }, { error: "Resource not found", code: "SKILL_RESOURCE_NOT_FOUND", details: { name: "existing", path: "missing.txt" }, resources: [{ path: "scripts/run.js" }] }, { name: "existing", path: "missing.txt", available: ["scripts/run.js"] }],
  ]) {
    const pending = callTool(bridge.endpoint, name, args);
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, result.code);
      assert.deepEqual(error.details, details);
      return true;
    });
    const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
    completeBrowser(bridge.state, request.id, { ok: true, result });
    await rejected;
  }
  const result = { error: "Data column named error", code: "DATA" };
  const pending = callTool(bridge.endpoint, "qingzhou_execute_tool", { name: "inspect_page", sessionId: "task" });
  const [request] = await pollBrowser(bridge.state, { id: "browser" }, { timeoutMs: 1000 });
  completeBrowser(bridge.state, request.id, { ok: true, result });
  assert.deepEqual(await pending, result);
});

test("untyped tool errors preserve their message", async t => {
  const bridge = await bridgeFixture(t);
  bridge.state.callExtension = async () => { throw new Error("Tool execution failed"); };
  await assert.rejects(callTool(bridge.endpoint, "qingzhou_get_settings", {}), error => {
    assert.equal(error.code, "tool_error");
    assert.equal(error.message, "Tool execution failed");
    assert.deepEqual(error.details, { result: "Tool execution failed" });
    return true;
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_CATALOG, executeMcpTool, validateMcpToolInput } from "../../services/mcp-bridge/src/tools.mjs";

test("advertised MCP schemas reject unknown top-level arguments before dispatch", async () => {
  for (const tool of TOOL_CATALOG) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  const state = { callExtension: () => assert.fail("malformed requests must not reach Chrome") };
  for (const [name, input] of [
    ["qingzhou_create_session", { firstMesage: "Do this task." }],
    ["qingzhou_create_session", { firstMessage: "Do this task.", clienId: "selected-browser" }],
    ["qingzhou_respond_to_user_input", { sessionId: "task", waitId: "wait", action: "submit", answer: {} }],
    ["qingzhou_update_settings", { config: { debugMode: true }, apikey: "synthetic-secret" }],
  ]) {
    await assert.rejects(executeMcpTool(state, name, input), error => {
      assert.equal(error.code, "invalid_arguments");
      assert.match(error.message, /additional propert/i);
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return true;
    });
  }
});

test("nested tool arguments, answers, settings patches and raw method params remain extensible", () => {
  for (const [name, input, field] of [
    ["qingzhou_execute_tool", { name: "custom_tool", args: { customField: { nested: [1, "two"] } } }, "args"],
    ["qingzhou_respond_to_user_input", { sessionId: "task", waitId: "wait", action: "submit", answers: { city: "杭州", choices: ["a"] } }, "answers"],
    ["qingzhou_update_settings", { config: { language: "zh-CN", providerKeys: { custom: "synthetic-secret" } } }, "config"],
    ["qingzhou_call", { method: "new_method", params: { futureField: true } }, "params"],
  ]) assert.deepEqual(validateMcpToolInput(name, input)[field], input[field]);
  const args = validateMcpToolInput("qingzhou_create_session", { firstMessage: "Do this task.", clientId: "selected-browser" });
  assert.equal(args.clientId, "selected-browser");
  assert.equal(args.firstMessage, "Do this task.");
  assert.equal(args.title, "");
});

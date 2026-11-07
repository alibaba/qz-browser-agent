import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Page" }; } },
};
const tools = await import("../../src/background/tools/runtime.js");
const parameters = { type: "object", properties: {} };
const schemaNames = profile => tools.getToolSchemas({ runProfile: profile }).map(schema => schema.function.name);
const context = { sessionId: "current", runId: "active" };

test("new tool declarations own image and root-session requirements without a central name list", async () => {
  let calls = 0, authorityChecks = 0;
  const runtime = tools.createToolRuntime({ sessions: { async canManageSessions(id) {
    authorityChecks++; assert.equal(id, context.sessionId); return false;
  } } });
  tools.defineTool({ name: "__custom_image", description: "test", parameters, requires: { images: true }, execute: () => { calls++; } });
  tools.defineTool({ name: "__custom_root", description: "test", parameters,
    requires: { rootSession: { code: "SESSION_TOOL_FORBIDDEN", message: "Only root sessions may use this tool." } }, execute: () => { calls++; } });
  const noImages = { features: { imageInput: false } };
  assert.equal(schemaNames(noImages).includes("__custom_image"), false);
  assert.equal(schemaNames({ session: { canManageSessions: false } }).includes("__custom_root"), false);
  await assert.rejects(runtime.execute("__custom_image", {}, undefined, { ...context, runProfile: noImages }), { code: "TOOL_FORBIDDEN_BY_RUN_PROFILE" });
  await assert.rejects(runtime.execute("__custom_root", {}, undefined, context), { code: "SESSION_TOOL_FORBIDDEN" });
  assert.equal(authorityChecks, 1);
  assert.equal(calls, 0);
  assert.equal(schemaNames({}).includes("__custom_image"), true);
  await runtime.execute("__custom_image", {}, undefined, context);
  assert.equal(calls, 1);
});

test("disabled prerequisites propagate across registration order and retain explicit tool overrides", async () => {
  tools.defineTool({ name: "__dependent_two", description: "test", parameters, requires: { tools: ["__dependent_one"] }, execute: () => ({}) });
  tools.defineTool({ name: "__dependent_one", description: "test", parameters, requires: { tools: ["__dependency"] }, execute: () => ({}) });
  tools.defineTool({ name: "__dependency", description: "test", parameters, execute: () => ({}) });
  const runProfile = { tools: { disabled: ["__dependency"] } };
  assert.equal(schemaNames(runProfile).includes("__dependent_two"), false);
  await assert.rejects(tools.executeTool("__dependent_two", {}, undefined, { ...context, runProfile }), { code: "TOOL_FORBIDDEN_BY_RUN_PROFILE" });
  assert.equal(schemaNames({ tools: { disabled: ["__dependent_two"] } }).includes("__dependency"), true);
});

test("a custom tool's no-image schema is projected without mutating its normal definition", () => {
  const parameters = { type: "object", properties: { capture: { type: "boolean" }, text: { type: "string" } }, required: ["text"] };
  tools.defineTool({ name: "__custom_optional_image", description: "With an optional picture", parameters,
    model: { noImages: { description: "Text only", omitParameters: ["capture"] } }, execute: () => ({}) });
  const projected = tools.getToolSchemas({ runProfile: { features: { imageInput: false } } }).find(schema => schema.function.name === "__custom_optional_image").function;
  assert.equal(projected.description, "Text only");
  assert.equal(projected.parameters.properties.capture, undefined);
  assert.deepEqual(projected.parameters.required, ["text"]);
  const normal = tools.getToolSchemas().find(schema => schema.function.name === "__custom_optional_image").function;
  assert.equal(normal.description, "With an optional picture");
  assert.deepEqual(normal.parameters.properties.capture, { type: "boolean" });
  assert.throws(() => tools.defineTool({ name: "__invalid_optional_image", description: "test", parameters,
    model: { noImages: { omitParameters: ["text"] } }, execute: () => ({}) }), /only omit optional/);
});

test("trusted tab roles apply to new names; result fields cannot grant a claim", async () => {
  const updates = [], cleared = [];
  const runtime = tools.createToolRuntime({ sessions: {
    updateWorkingTab: async input => { updates.push(input); },
    clearWorkingTab: async input => { cleared.push(input); },
  } });
  for (const role of ["created", "claim", "clear", "ordinary"]) {
    tools.defineTool({ name: `__custom_tab_${role}`, description: "test", parameters: { type: "object", properties: { tabId: { type: "number" } } },
      ...(role === "ordinary" ? {} : { tabLifecycle: role }),
      execute: () => role === "created" ? { id: 12 } : { tabId: 12, claim: true, createdTab: true },
    });
    await runtime.execute(`__custom_tab_${role}`, ["claim", "clear"].includes(role) ? { tabId: 12 } : {}, undefined, context);
  }
  assert.deepEqual(updates.map(({ createdTab, claim, tab }) => [createdTab, claim, tab.id]), [[true, false, 12], [false, true, 12]],
    'an ordinary result cannot select a page by returning tabId, claim or createdTab business keys');
  await runtime.execute('__custom_tab_ordinary', { tabId: 12 }, undefined, context);
  assert.deepEqual(updates.map(({ createdTab, claim, tab }) => [createdTab, claim, tab.id]), [[true, false, 12], [false, true, 12], [false, false, 12]],
    'an explicit page can still be observed without granting a claim');
  assert.deepEqual(cleared.map(({ sessionId, runId, tabId }) => [sessionId, runId, tabId]), [["current", "active", 12]]);
});

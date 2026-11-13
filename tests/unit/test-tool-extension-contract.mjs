import assert from "node:assert/strict";
import { assertTableToolExample } from "../examples/tool-contract.mjs";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { validateToolSchema } from "../../src/background/tools/arguments.js";

let storageReads = 0;
globalThis.chrome = {
  storage: { local: { async get() { storageReads++; return {}; } } },
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Test" }; } },
};
const tools = await import("../../src/background/tools/runtime.js");
await assertTableToolExample(tools);

const isolated = createToolRegistry();
const definition = { name: "unique", description: "test", parameters: { type: "object", properties: {} }, execute: () => ({}) };
isolated.defineTool(definition);
assert.throws(() => isolated.defineTool(definition), /Duplicate tool definition/);
assert.throws(() => isolated.defineTool({ ...definition, name: "" }), TypeError);
assert.equal(tools.resolveToolDefinition("unique"), null, "an isolated registry must not mutate production registrations");

const owners = [];
const runtime = tools.createToolRuntime({ sessions: {
  async resolveTargetTab(input) {
    owners.push(input);
    return input.readOnly ? { ok: true, tabId: input.tabId, readOnlyAccess: true, ownedByCurrentTask: false }
      : { ok: false, code: "SESSION_TAB_FOREIGN", ownerSessionId: "other" };
  },
} });
const common = { type: "object", properties: {
  tabId: { type: "number" }, readOnly: { type: "boolean" }, mode: { type: "string", enum: ["read", "write"] },
}, required: ["mode"] };
let executions = 0;
tools.defineTool({ name: "__extension_page", description: "test", parameters: common,
  page: args => args.mode === "read" ? "readOnly" : "owned",
  execute: args => { executions++; return { value: args.mode }; },
});
const context = { sessionId: "current", runId: "run", workingTabId: 9 };
const beforeInvalid = storageReads;
await assert.rejects(runtime.execute("__extension_page", { mode: "invalid", tabRef: 9 }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.mode");
assert.equal(storageReads, beforeInvalid);
assert.equal(owners.length, 0, "invalid enum must fail before tab authority checks");
await runtime.execute("__extension_page", { mode: "read", tabRef: 9 }, undefined, context);
assert.equal(owners.at(-1).readOnly, true);
await assert.rejects(runtime.execute("__extension_page", { mode: "write", readOnly: true, tabRef: 9 }, undefined, context),
  error => error.code === "SESSION_TAB_FOREIGN");
assert.equal(owners.at(-1).readOnly, false, "input cannot claim read-only privileges reserved for the definition");
assert.equal(executions, 1);

for (const value of ["text", { key: "value" }, [1, 2], 1, true]) {
  validateToolSchema("json", value, { type: ["string", "object", "array", "number", "boolean"] });
}
assert.throws(() => validateToolSchema("json", null, { type: ["string", "object"] }), error => error.code === "INVALID_ARGUMENTS");
const closed = { type: "object", properties: { roles: { type: "array", items: { type: "string" } } }, additionalProperties: false };
assert.throws(() => validateToolSchema("query", { role: "link" }, closed), error =>
  error.code === "INVALID_ARGUMENTS" && error.details.invalidFields[0] === "role"
    && error.details.allowedFields[0] === "roles");
assert.throws(() => validateToolSchema("query", { filters: { role: "link" } }, {
  type: "object", properties: { filters: closed },
}), error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.filters");
assert.throws(() => validateToolSchema("empty", { extra: true }, { type: "object", additionalProperties: false }),
  error => error.code === "INVALID_ARGUMENTS" && error.details.allowedFields.length === 0);
validateToolSchema("open", { roles: ["link"], extensionOption: true }, { ...closed, additionalProperties: true });
assert.throws(() => validateToolSchema("closed-default", { extensionOption: true }, { type: "object", properties: {} }),
  error => error.code === "INVALID_ARGUMENTS" && error.details.invalidFields[0] === "extensionOption");
validateToolSchema("free-form", { extensionOption: true }, { type: "object" });
const patterned = { ...closed, patternProperties: { "^x-": { type: "string" } } };
validateToolSchema("patterned", { roles: ["link"], "x-filter": "active" }, patterned);
assert.throws(() => validateToolSchema("patterned", { "x-filter": 1 }, patterned),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.x-filter");
assert.throws(() => validateToolSchema("patterned", { unrelated: "active" }, patterned),
  error => error.code === "INVALID_ARGUMENTS" && error.details.invalidFields[0] === "unrelated");
tools.defineTool({ name: "__business_timeout", description: "Business fields are not compatibility controls",
  parameters: { type: "object", properties: { timeoutMs: { type: "string" } }, additionalProperties: false },
  execute: args => ({ value: args.timeoutMs }),
});
assert.deepEqual(await runtime.execute("__business_timeout", { timeoutMs: "business-value" }, undefined, context),
  { value: "business-value" });
await assert.rejects(runtime.execute("__business_timeout", { timeoutMs: 500 }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.timeoutMs");
tools.defineTool({ name: "__legacy_timeout", description: "Declared compatibility control", legacyTimeoutMs: true,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: args => ({ timeout: args.timeout, timeoutMs: args.timeoutMs }),
});
assert.deepEqual(await runtime.execute("__legacy_timeout", { timeoutMs: 1500 }, undefined, context),
  { timeout: 1.5, timeoutMs: 1500 });
assert.deepEqual(await runtime.execute("__legacy_timeout", { timeout: 3, timeoutMs: 1500 }, undefined, context),
  { timeout: 3, timeoutMs: 1500 }, "validation must retain legacy execution arguments and their precedence");
await assert.rejects(runtime.execute("__legacy_timeout", { timeoutMs: 1500, typo: true }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.invalidFields[0] === "typo");
let nestedExecutions = 0;
tools.defineTool({ name: "__nested_schema", description: "Nested JSON values", parameters: {
  type: "object", properties: {
    label: { type: "string" },
    payload: { type: "object", properties: {
      rows: { type: "array", items: { type: "number" } },
      text: { type: "string" },
      note: { type: ["string", "null"] },
    }, required: ["rows", "text", "note"] },
  }, required: ["label", "payload"],
}, execute: args => { nestedExecutions++; return args; } });
const nestedInput = { label: "required", payload: { rows: [], text: "", note: null } };
for (const key of ["rows", "text", "note"]) {
  const payload = { ...nestedInput.payload };
  delete payload[key];
  await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, payload }, undefined, context),
    error => error.code === "MISSING_REQUIRED_ARGUMENTS" && error.details.path === "$.payload"
      && error.details.missing.includes(key));
}
await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, label: "" }, undefined, context),
  error => error.code === "MISSING_REQUIRED_ARGUMENTS", "top-level business fields retain the existing non-empty rule");
await assert.rejects(runtime.execute("__nested_schema", { ...nestedInput, payload: { ...nestedInput.payload, text: null } }, undefined, context),
  error => error.code === "INVALID_ARGUMENTS" && error.details.path === "$.payload.text");
assert.equal(nestedExecutions, 0, "invalid nested values must never reach the handler");
assert.deepEqual(await runtime.execute("__nested_schema", nestedInput, undefined, context), nestedInput,
  "present nested empty arrays, empty strings, and declared nullable values remain valid after failures");
assert.equal(nestedExecutions, 1);
console.log("tool extension registration, schema, identity and page authority tests passed");

const loaded = await tools.executeTool("load_skill", { name: "skill-workbench" }, undefined, context);
assert.deepEqual(tools.consumeToolEffects(loaded, { sessionId: "other", runId: "run" }), []);
assert.deepEqual(tools.consumeToolEffects(loaded, { ...context, runId: "old-run" }), []);
assert.deepEqual(tools.consumeToolEffects(JSON.parse(JSON.stringify(loaded)), context), [], "serializable result fields cannot forge a trusted effect");
assert.deepEqual(tools.consumeToolEffects(loaded, context), [{
  type: "skill.loaded", name: "skill-workbench", displayName: loaded.displayName, hasPluginManifest: true,
}]);
assert.deepEqual(tools.consumeToolEffects(loaded, context), [], "effects are consumed once");
tools.defineTool({ name: "__forged_effect", description: "test", parameters: { type: "object", properties: {} },
  execute: () => ({ effects: [{ type: "skills.changed" }], _effects: [{ type: "skill.loaded", name: "forged" }] }),
});
assert.deepEqual(tools.consumeToolEffects(await tools.executeTool("__forged_effect", {}, undefined, context), context), []);

// Presentation policies remain independent of page authority grants.
const pageTools = new Set([
  'close_tab', 'navigate', 'set_page_mode', 'screenshot', 'act_on_screen', 'list_images', 'collect_images',
  'read_image', 'get_ax_tree', 'read_article', 'read_dom', 'find_elements', 'inspect_element',
  'act_on_element', 'scroll_page', 'wait_for_navigation', 'wait_for_element', 'wait_for_user',
  'evaluate', 'network_watch', 'network_recent', 'network_body', 'read_console_messages',
  'wait_for_response', 'wait_for_network_idle', 'wait_for_load', 'wait_for_url', 'wait_for_function', 'wait_for_popup',
]);
for (const { function: schema } of tools.getToolSchemas()) {
  if (schema.name.startsWith('__') || schema.name.startsWith('example_')) continue;
  assert.equal(Boolean(runtime.getModelPolicy(schema.name)?.pageContext), pageTools.has(schema.name), schema.name);
}
assert.equal(runtime.getModelPolicy('close_tab').pageContext, 'explicit');
assert.equal(runtime.getModelPolicy('navigate').pageUrlArgument, 'url');
assert.deepEqual(runtime.getModelPolicy('open_tab').omitArguments, ['active']);
assert.equal(runtime.getModelPolicy('load_skill').preserveResult, true);
assert.equal(runtime.getModelPolicy('read_image').imagePrompt, runtime.getModelPolicy('read_image_asset').imagePrompt);
assert.equal(runtime.getModelPolicy('get_ax_tree').projectResult, undefined,
  'AX observations are constructed by the binding before model delivery');
const siteEffect = [{ type: 'context.siteChanged' }];
for (const name of ['open_tab', 'close_tab', 'navigate', 'wait_for_navigation']) {
  assert.deepEqual(tools.resolveToolDefinition(name).effects({}, {}), siteEffect, name);
}
assert.equal(tools.resolveToolDefinition('run_script').effects, undefined, 'orchestration effects come from its actual nested tools');
assert.deepEqual(tools.resolveToolDefinition('evaluate').effects({}, {}), siteEffect, 'page evaluation can change page state');
for (const name of ['run_skill_script']) {
  const effect = tools.resolveToolDefinition(name).effects;
  for (const mutatesPage of [undefined, false, 1, 'true']) assert.deepEqual(effect({ mutatesPage }, {}), []);
  assert.deepEqual(effect({ mutatesPage: true }, {}), siteEffect);
}
const elementEffects = tools.resolveToolDefinition('act_on_element').effects;
for (const result of [{}, { navigated: false }, { navigated: 'true' }, { href: '/next' }, { url: '/next' }]) assert.deepEqual(elementEffects({}, result), []);
for (const result of [{ navigated: true }, { navigated: true, url: '/next' }]) assert.deepEqual(elementEffects({}, result), siteEffect);
const screenEffects = tools.resolveToolDefinition('act_on_screen').effects;
for (const urlChanged of [undefined, false, 1, 'true']) assert.deepEqual(screenEffects({}, { urlChanged }), []);
assert.deepEqual(screenEffects({}, { urlChanged: true }), siteEffect);
const goalEffects = tools.resolveToolDefinition('manage_goal').effects;
assert.deepEqual(goalEffects({ action: 'update' }, { action: 'get' }), [{ type: 'context.goalRefresh', action: 'get' }], 'goal action comes from the successful command result');
assert.deepEqual(goalEffects({}, { action: 'checkpoint' }), [{ type: 'context.goalRefresh', action: 'checkpoint' }]);
console.log('core model policies and exact site/goal effect predicates passed');

let issued = 0;
tools.defineTool({ name: '__effect_failure_gate', description: 'test', parameters: {
  type: 'object', properties: { fail: { type: 'boolean' } },
}, effects: () => { issued++; return [{ type: 'context.siteChanged' }]; },
execute: ({ fail }) => fail ? { error: 'failed', code: 'TEST_FAILURE' } : { ok: true },
});
const failedEffect = await runtime.execute('__effect_failure_gate', { fail: true }, undefined, context);
assert.deepEqual(runtime.consumeEffects(failedEffect, context), []);
assert.equal(issued, 0, 'failure must never invoke the trusted effect producer');
const controller = new AbortController();
controller.abort();
await assert.rejects(runtime.execute('__effect_failure_gate', {}, controller.signal, context));
assert.equal(issued, 0, 'a cancelled invocation cannot issue effects');
const recoveredEffect = await runtime.execute('__effect_failure_gate', {}, undefined, context);
assert.deepEqual(runtime.consumeEffects(recoveredEffect, context), siteEffect);
assert.equal(issued, 1);

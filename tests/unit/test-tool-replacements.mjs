import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { getLanguage } from "../../src/shared/i18n/index.js";

const base = { name: "replacement_probe", description: "Original", parameters: { type: "object", properties: {} },
  execute: () => "original", page: "owned", hidden: true, rendererId: "original.renderer" };
const replacement = { name: base.name, replaces: `original/${base.name}`,
  get description() { return `Replacement ${getLanguage()}`; },
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  rendererId: "custom.renderer", execute: args => args.value };

for (const reversed of [false, true]) test(`explicit replacement resolves independently of discovery order (${reversed})`, () => {
  const registry = createToolRegistry();
  const entries = [["original", base], ["custom", replacement]];
  for (const [owner, tool] of reversed ? entries.reverse() : entries) registry.forCapability(owner)(tool);
  registry.validate();
  const snapshot = registry.snapshot("en");
  const tool = snapshot.get(base.name);
  assert.equal([...snapshot.entries()].length, 1);
  assert.equal(tool.execute({ value: "new" }), "new");
  assert.equal(tool.schema.function.description, "Replacement en");
  assert.deepEqual(tool.schema.function.parameters.required, ["value"]);
  assert.equal(tool.rendererId, "custom.renderer");
  assert.equal(tool.hidden, false);
  assert.equal(tool.page, undefined, "a full replacement does not accidentally inherit the old policy");
  assert.equal(registry.snapshot("zh-CN").get(base.name).description, "Replacement zh-CN");
  assert.equal(tool.description, "Replacement en", "another language cannot change an existing run");
  assert.ok(Object.isFrozen(tool.parameters));
});

test("registration conflicts identify both owners and cannot overwrite the accepted declaration", () => {
  const registry = createToolRegistry();
  registry.forCapability("original")(base);
  for (const owner of ["original", "other"]) assert.throws(() => registry.forCapability(owner)(base),
    new RegExp(`Duplicate tool definition:.*original/${base.name}.*${owner}/${base.name}`));
  registry.forCapability("custom")(replacement);
  assert.throws(() => registry.forCapability("competitor")(replacement), /Conflicting tool replacements:.*custom\/.*competitor\//);
  assert.equal(registry.get(base.name).execute({ value: "accepted" }), "accepted");
});

test("missing, wrong and chained targets fail before a snapshot can be used; adding the missing base recovers", () => {
  const registry = createToolRegistry();
  registry.forCapability("custom")(replacement);
  assert.throws(() => registry.validate(), /replacement target original\/replacement_probe not found/);
  assert.throws(() => registry.snapshot(), /replacement target.*not found/);
  registry.forCapability("original")(base);
  registry.validate();
  assert.equal(registry.get(base.name).execute({ value: "recovered" }), "recovered");
  const wrong = createToolRegistry();
  wrong.forCapability("other")(base);
  wrong.forCapability("custom")(replacement);
  assert.throws(() => wrong.validate(), /original\/replacement_probe not found.*other\/replacement_probe/);
  assert.throws(() => registry.forCapability("third")({ ...replacement, replaces: `custom/${base.name}` }), /Conflicting tool replacements/);
});

test("malformed, renamed and self replacements are rejected without registering anything", () => {
  const registry = createToolRegistry();
  for (const replaces of [null, true, "", "original", "/replacement_probe", "original/another", "original/x/replacement_probe",
    " original/replacement_probe", "original\\x/replacement_probe", "custom/replacement_probe"]) {
    assert.throws(() => registry.forCapability("custom")({ ...replacement, replaces }), TypeError);
  }
  assert.equal([...registry.entries()].length, 0);
});

test("captured runs keep their original implementation after a replacement is registered", () => {
  const registry = createToolRegistry();
  registry.forCapability("original")(base);
  const oldRun = registry.snapshot("en");
  const authored = { ...replacement, parameters: structuredClone(replacement.parameters) };
  registry.forCapability("custom")(authored);
  authored.execute = () => "mutated";
  authored.parameters.required.push("late");
  const newRun = registry.snapshot("en");
  assert.equal(oldRun.get(base.name).execute(), "original");
  assert.equal(newRun.get(base.name).execute({ value: "new" }), "new");
  assert.deepEqual(newRun.get(base.name).parameters.required, ["value"]);
});

test("replacement schema, execution, ownership, cancellation and effects use the real tool runtime", async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({}) } },
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    tabs: { get: async id => ({ id, url: "https://example.test/", title: "Example" }) } };
  const { createToolRuntime, getToolSchemas } = await import("../../src/background/tools/runtime.js");
  const registry = createToolRegistry();
  let executions = 0, resolutions = 0;
  registry.forCapability("original")(base);
  registry.forCapability("custom")({ ...replacement, get description() { return replacement.description; },
    page: "owned", effects: () => [{ type: "context.siteChanged" }],
    execute: (args, signal, context) => { executions++; assert.ok(signal); return { value: args.value, session: context.sessionId }; } });
  const context = { sessionId: "own", runId: "run", workingTabId: 7, toolRegistrySnapshot: registry.snapshot("en") };
  const runtime = createToolRuntime({ sessions: { resolveTargetTab: async input => {
    resolutions++;
    return input.sessionId === "own" ? { ok: true, tabId: 7, ownedByCurrentTask: true }
      : { ok: false, code: "SESSION_TAB_FOREIGN" };
  } } });
  const schemas = getToolSchemas(context).filter(tool => tool.function.name === base.name);
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].function.description, "Replacement en");
  await assert.rejects(runtime.execute(base.name, { tabRef: 7 }, undefined, context), error => error.code === "MISSING_REQUIRED_ARGUMENTS");
  await assert.rejects(runtime.execute(base.name, { tabRef: 7, value: 42 }, undefined, context), error => error.code === "INVALID_ARGUMENTS");
  assert.equal(resolutions, 0);
  await assert.rejects(runtime.execute(base.name, { tabRef: 7, value: "x" }, undefined, { ...context, sessionId: "foreign" }),
    error => error.code === "SESSION_TAB_FOREIGN");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.execute(base.name, { tabRef: 7, value: "x" }, abort.signal, context));
  assert.equal(executions, 0);
  const result = await runtime.execute(base.name, { tabRef: 7, value: "success" }, undefined, context);
  assert.equal(result.value, "success");
  assert.equal(result.session, "own");
  assert.equal(executions, 1);
  assert.deepEqual(runtime.consumeEffects(result, context), [{ type: "context.siteChanged" }]);
  assert.deepEqual(runtime.consumeEffects(result, context), [], "effect tickets remain single-use");
});

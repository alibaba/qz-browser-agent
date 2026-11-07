import assert from "node:assert/strict";
import test from "node:test";
import { registerAnalysisSkillsTools } from "../../src/capabilities/skills/tools.js";
import { registerAlertsSettingsTools } from "../../src/capabilities/settings/tools.js";
import { createAssistantProviderState, isReplayableProviderState } from "../../src/sdk/background/providers.js";

function host(overrides = {}) {
  const definitions = new Map();
  return { definitions, registerTool: tool => definitions.set(tool.name, tool),
    ToolExecutionError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    getToolRuntimeDependencies: () => ({}), clampNumber: Number, clampLimit: Number, secondsToMs: Number,
    skills: {}, models: {}, ...overrides };
}

test("a nested analysis uses the injected model service and preserves cancellation and run identity", async () => {
  const controller = new AbortController();
  let request;
  const qz = host({ models: { chat: async (...args) => { request = args; return { message: { content: "answer" } }; } } });
  registerAnalysisSkillsTools(qz);
  const execute = qz.definitions.get("ask_llm").execute;
  assert.equal(await execute({ prompt: "summarize", system: "brief", data: "rows" }, controller.signal,
    { sessionId: "parent-task", runId: "run-7" }), "answer");
  assert.deepEqual(request, [[{ role: "system", content: "brief" }, { role: "user", content: "summarize\n\n---\nrows" }], [],
    controller.signal, { sessionId: "parent-task", runId: "run-7" }]);
  const cancelled = host({ models: { chat: (_messages, _tools, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) } });
  registerAnalysisSkillsTools(cancelled);
  const pending = cancelled.definitions.get("ask_llm").execute({ prompt: "wait" }, controller.signal, {});
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
});

test("Skill lookup uses the supplied repository without a global storage dependency", async () => {
  const calls = [];
  const qz = host({ skills: { load: async name => { calls.push(name); return null; }, list: async () => [{ name: "injected-skill" }] } });
  registerAnalysisSkillsTools(qz);
  const result = await qz.definitions.get("load_skill").execute({ name: "missing" });
  assert.deepEqual(calls, ["missing"]);
  assert.equal(result.code, "SKILL_NOT_FOUND");
  assert.deepEqual(result.details.available, ["injected-skill"]);
  assert.deepEqual(Object.keys(result).sort(), ["code", "details", "hint", "message"]);
});

test("settings mutations call the supplied model service and publish its resulting snapshot", async t => {
  const previousChrome = globalThis.chrome;
  t.after(() => { if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome; });
  globalThis.chrome = { storage: { local: { get: async key => { assert.equal(key, "securityGuardrails"); return {}; } } } };
  const changes = [], events = [];
  const config = { provider: "extension-provider", model: "test-model", modelParameters: {}, presets: [] };
  const qz = host({ models: { applyPreset: async id => { changes.push(id); return config; } },
    getToolRuntimeDependencies: () => ({ emit: event => events.push(event) }) });
  registerAlertsSettingsTools(qz);
  const result = await qz.definitions.get("manage_settings").execute({ action: "apply_preset", presetId: "custom-preset" }, undefined,
    { sessionId: "session", runId: "run" });
  assert.deepEqual(changes, ["custom-preset"]);
  assert.equal(result.config.provider, "extension-provider");
  assert.equal(result.config.model, "test-model");
  assert.equal(events[0].type, "config");
  assert.equal(events[0].config.model, "test-model");
});

test("Provider replay state uses an injected provider definition without requiring a preset registration", () => {
  const config = { provider: "Outside-Vendor", model: "reasoning-model" };
  const definition = { api: "external-api", protocol: "external-protocol", resolveEndpoint: () => "https://extension.test/chat" };
  const state = createAssistantProviderState(config, definition, { reasoning: "state" });
  assert.equal(state.provider, "outside-vendor");
  assert.equal(state.endpoint, "https://extension.test/chat");
  assert.equal(isReplayableProviderState(state, config, definition), true);
  assert.equal(isReplayableProviderState(state, { ...config, provider: "other-vendor" }, definition), false);
  assert.equal(isReplayableProviderState(state, config, { ...definition, resolveEndpoint: () => "https://other.test/chat" }), false);
});

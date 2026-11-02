import assert from "node:assert/strict";

globalThis.chrome ||= {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { id: "test", getManifest: () => ({ version: "0" }) },
};

const { Agent } = await import("../../src/background/agent/agent.ts");

function agentWith(model) {
  return Object.assign(Object.create(Agent.prototype), { _runProfile: { model }, _runtimeConfig: {} });
}

// Compaction must leave room for the max_tokens the request will ask for, or a strict
// OpenAI-compatible server rejects input + max_tokens > context window.
for (const model of [
  { contextWindow: 131072, maxOutputTokens: 32768 }, // custom model: default output limit
  { contextWindow: 200000, maxOutputTokens: 64000 },
  { contextWindow: 128000, maxOutputTokens: 8192 },
]) {
  const threshold = agentWith(model)._compactThreshold();
  assert.ok(threshold + model.maxOutputTokens <= model.contextWindow,
    `compaction threshold ${threshold} + max output ${model.maxOutputTokens} exceeds window ${model.contextWindow}`);
}

// Small output limits keep the existing 16,000-token floor.
assert.equal(agentWith({ contextWindow: 128000, maxOutputTokens: 8192 })._compactThreshold(), 128000 - 16000);

console.log("compaction reserve tests passed");

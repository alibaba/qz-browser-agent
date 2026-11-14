import assert from "node:assert/strict";

let storageReads = 0;
globalThis.chrome = {
  storage: { local: { async get() { storageReads += 1; return {}; } } },
  runtime: { getURL: path => `chrome-extension://test/${path}` },
};
const { createToolRuntime, resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const calls = [];
const runtime = createToolRuntime({
  sessions: {
    canManageSessions: async sessionId => sessionId !== "child",
    updateGoal: async input => { calls.push(input); return { action: input.action, saved: true }; },
    resolveTargetTab: () => assert.fail("goal tools must never claim a browser tab"),
  },
});
const context = { sessionId: "parent", runId: "run-1", toolCallId: "tool-1" };
const definition = resolveToolDefinition("manage_goal");
assert.equal(runtime.getSchemas({ canManageSessions: false }).some(schema => schema.function.name === "manage_goal"), false);
assert.equal(runtime.getSchemas({ canManageSessions: true }).some(schema => schema.function.name === "manage_goal"), true);
assert.deepEqual(definition.parameters.required, ["action"]);
assert.deepEqual(definition.parameters.properties.action.enum,
  ["create", "checkpoint", "update", "block", "complete", "pause", "resume", "clear", "get"]);
assert.equal(typeof definition.validateArgs, "function");
assert.equal(definition.pageContext, false);
assert.equal(definition.source, "core");

const beforeInvalid = storageReads;
for (const [input, missing] of [
  [{ action: "create" }, ["objective", "criteria"]],
  [{ action: "create", objective: "Collect", criteria: "  " }, ["criteria"]],
  [{ action: "block", progress: null, next: "" }, ["progress", "next"]],
  [{ action: "create", objective: [], criteria: "Saved" }, ["objective"]],
  [{ action: " block ", progress: "Saved" }, ["next"]],
]) {
  await assert.rejects(runtime.execute("manage_goal", input, undefined, context), error => {
    assert.equal(error.code, "MISSING_REQUIRED_ARGUMENTS");
    assert.deepEqual(error.details.missing, missing);
    assert.equal(error.details.requiredWhen, `action=${input.action.trim()}`);
    assert.equal(error.details.name, "manage_goal");
    return true;
  });
}
for (const input of [
  { action: "create", objective: 7, criteria: "Saved" },
  { action: "block", progress: { unexpected: true }, next: "Saved" },
  { action: " block ", progress: "Saved", next: "Done" },
]) {
  await assert.rejects(runtime.execute("manage_goal", input, undefined, context),
    error => error.code === "INVALID_ARGUMENTS");
}
assert.equal(storageReads, beforeInvalid, "invalid arguments must fail before security/storage work");
assert.equal(calls.length, 0);

await assert.rejects(runtime.execute("manage_goal", { action: "get" }, undefined,
  { ...context, sessionId: "child" }), error => error.code === "GOAL_SESSION_FORBIDDEN");
await assert.rejects(runtime.execute("manage_goal", { action: "get" }, undefined,
  { runId: "run-1" }), error => error.code === "MISSING_SESSION_ID");
await assert.rejects(createToolRuntime().execute("manage_goal", { action: "get" }, undefined,
  context), error => error.code === "GOAL_RUNTIME_UNAVAILABLE");
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(runtime.execute("manage_goal", { action: "get" }, cancelled.signal,
  context), error => error.code === "OPERATION_ABORTED");
assert.equal(calls.length, 0, "permission failures and prior cancellation must not mutate a goal");

for (const action of definition.parameters.properties.action.enum) {
  const input = { action, objective: "Collect", criteria: "Rows saved", progress: "Page 1 saved", next: "Page 2" };
  assert.deepEqual(await runtime.execute("manage_goal", input, undefined, context), { action, saved: true });
  assert.deepEqual(calls.at(-1), { ...input, sessionId: "parent", runId: "run-1", signal: calls.at(-1).signal });
}
const before = calls.length;
await assert.rejects(runtime.execute("manage_goal", { action: "get", sessionId: "injected", runId: "injected" }, undefined,
  { ...context, sessionId: "sibling", runId: "run-2" }), error => error.code === "INVALID_ARGUMENTS"
  && error.details?.mayHaveTakenEffect === false, "arguments cannot override the caller's session or run");
assert.equal(calls.length, before);

let failOnce = true;
const recovering = createToolRuntime({ sessions: { async updateGoal() {
  if (failOnce) { failOnce = false; throw Object.assign(new Error("write failed"), { code: "TEST_WRITE_FAILED" }); }
  return { saved: true };
} } });
await assert.rejects(recovering.execute("manage_goal", { action: "checkpoint" }, undefined, context),
  error => error.code === "TEST_WRITE_FAILED");
assert.deepEqual(await recovering.execute("manage_goal", { action: "checkpoint" }, undefined, context), { saved: true });

console.log("goal tool registration, validation, authority and recovery tests passed");

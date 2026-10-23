import assert from "node:assert/strict";

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: undefined };
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, undefined]));
        return key && typeof key === "object" ? { ...key } : {};
      },
      async set() {},
      async remove() {},
    },
  },
  runtime: { getURL: path => `chrome-extension://test/${path}`, lastError: null },
};

const tools = await import("../../src/background/tools/runtime.js");

tools.defineTool({
  name: "__observed_page_metadata", description: "Test-only observed page metadata.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ tabId: 7, pageAfter: { url: "https://example.test/observed", title: "" },
    _pageUrl: "https://example.test/observed", _pageTitle: "" }),
});
chrome.tabs = { async get() { return { id: 7, url: "https://example.test/later", title: "Later title" }; } };
const observedMetadata = await tools.createToolRuntime().execute("__observed_page_metadata", {});
assert.equal(observedMetadata._pageUrl, observedMetadata.pageAfter.url);
assert.equal(observedMetadata._pageTitle, observedMetadata.pageAfter.title, "an observed empty title must not be replaced by a later title");
delete chrome.tabs;

const pending = new Map();
const callsA = [];
const callsB = [];
const eventsA = [];
const eventsB = [];

tools.defineTool(
  { name: "__tool_runtime_isolation_probe",
description: "Test-only explicit runtime dependency probe.",
parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
execute: async ({ value }, _signal, context) => {
    const dependencies = tools.getToolRuntimeDependencies(context);
    const result = await dependencies.sessions.probe(value);
    dependencies.emit?.({
      type: "runtime_probe",
      sessionId: context.sessionId,
      value,
      result,
    });
    return { result };
  } },
);

tools.defineTool(
  { name: "__tool_runtime_quick_probe",
description: "Test-only immediate runtime probe.",
parameters: { type: "object", properties: {} },
execute: async () => ({ ok: true }) },
);

let abortProbeExecutions = 0;
let abortProbeStarted = null;
tools.defineTool(
  { name: "__tool_runtime_abort_probe",
description: "Test-only abort runtime probe.",
parameters: { type: "object", properties: {} },
execute: async (_args, signal) => {
    abortProbeExecutions += 1;
    abortProbeStarted?.();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  } },
);

const providerFacingSchemas = tools.getToolSchemas();
assert.ok(providerFacingSchemas.some(schema => schema.function?.name === "read_image"), "provider schema audit must include read_image");
assert.ok(providerFacingSchemas.some(schema => schema.function?.name === "act_on_screen"), "visual run schemas must include screen actions");
const screenActionSchema = providerFacingSchemas.find(schema => schema.function?.name === "act_on_screen");
assert.deepEqual(
  screenActionSchema?.function?.parameters?.required,
  ["action", "returnScreenshot"],
  "screen actions must force the model to choose whether post-action capture is worth its cost",
);
assert.equal(
  screenActionSchema?.function?.parameters?.properties?.returnScreenshot?.type,
  "boolean",
  "the screenshot-return decision should stay provider-safe and flat",
);
assert.deepEqual(
  {
    type: screenActionSchema?.function?.parameters?.properties?.repeat?.type,
    minimum: screenActionSchema?.function?.parameters?.properties?.repeat?.minimum,
    maximum: screenActionSchema?.function?.parameters?.properties?.repeat?.maximum,
  },
  { type: "number", minimum: 1, maximum: 20 },
  "screen scroll should expose one bounded repeat count without a second wheel tool",
);
assert.equal(
  tools.getToolSchemas({ runProfile: { features: { screenshots: false, imageInput: false }, tools: { disabled: [] } } })
    .some(schema => schema.function?.name === "act_on_screen"),
  false,
  "text-only run schemas must hide screen actions",
);
assert.deepEqual(
  schemaKeywordPaths({ properties: { nested: { anyOf: [] } } }, "anyOf"),
  ["$.properties.nested.anyOf"],
  "provider schema audit must detect nested unions",
);
for (const schema of providerFacingSchemas) {
  const name = String(schema.function?.name || "unknown");
  const parameters = schema.function?.parameters || {};
  assert.equal(parameters.type, "object", `${name} must expose an object parameter schema`);
  assert.deepEqual(
    schemaKeywordPaths(parameters, "anyOf"),
    [],
    `${name} must not expose provider-fragile anyOf schemas`,
  );
}

function deferred(label) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  pending.set(label, resolve);
  return promise;
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function createSessions(label, calls) {
  return {
    async probe(value) {
      calls.push(value);
      await deferred(`${label}:${value}`);
      return `${label}:${value}`;
    },
    async resolveTargetTab({ tabId }) {
      return { ok: true, tabId };
    },
  };
}

const runtimeA = tools.createToolRuntime({
  sessions: createSessions("A", callsA),
  emit: event => eventsA.push(event),
});
const runtimeB = tools.createToolRuntime({
  sessions: createSessions("B", callsB),
  emit: event => eventsB.push(event),
});

assert.equal(Object.isFrozen(runtimeA), true, "runtime facade should be immutable");
assert.equal(typeof tools.setSessionRuntimeController, "undefined");
assert.equal(typeof tools.setToolEventSink, "undefined");

const contextA = { source: "test", sessionId: "session-a", runId: "run-a" };
const contextB = { source: "test", sessionId: "session-b", runId: "run-b" };
const executionA = runtimeA.execute("__tool_runtime_isolation_probe", { value: "one" }, null, contextA);
const executionB = runtimeB.execute("__tool_runtime_isolation_probe", { value: "two" }, null, contextB);

await waitUntil(() => callsA.length === 1 && callsB.length === 1, "both runtimes should reach their own controller");
assert.deepEqual(callsA, ["one"]);
assert.deepEqual(callsB, ["two"]);

pending.get("B:two")();
assert.deepEqual(await executionB, { result: "B:two" });
pending.get("A:one")();
assert.deepEqual(await executionA, { result: "A:one" });

assert.deepEqual(eventsA, [{
  type: "runtime_probe",
  sessionId: "session-a",
  value: "one",
  result: "A:one",
}]);
assert.deepEqual(eventsB, [{
  type: "runtime_probe",
  sessionId: "session-b",
  value: "two",
  result: "B:two",
}]);
assert.deepEqual(contextA, { source: "test", sessionId: "session-a", runId: "run-a" }, "runtime injection must not mutate caller context");
assert.deepEqual(contextB, { source: "test", sessionId: "session-b", runId: "run-b" }, "runtime injection must not mutate caller context");

await assert.rejects(
  runtimeA.execute("__missing_runtime_tool", {}, null, contextA),
  error => error?.code === "UNKNOWN_TOOL",
);
await assert.rejects(
  runtimeA.execute("__tool_runtime_isolation_probe", {}, null, contextA),
  error => error?.code === "MISSING_REQUIRED_ARGUMENTS" && error?.details?.missing?.includes("value"),
);
await assert.rejects(
  runtimeA.execute("act_on_screen", {
    action: "type",
    text: "UI 可视化测试",
    replace: true,
    returnScreenshot: true,
    tabId: 123,
  }, null, contextA),
  error => error?.code === "CDP_RUN_RELEASED"
    && !error?.details?.missing?.includes("x")
    && !error?.details?.missing?.includes("y"),
  "coordinate-free type must reach the debugger's run check without requiring a screenshot",
);
await assert.rejects(
  runtimeA.execute("__tool_runtime_quick_probe", {}, null, {
    ...contextA,
    runProfile: { tools: { disabled: ["__tool_runtime_quick_probe"] } },
  }),
  error => error?.code === "TOOL_FORBIDDEN_BY_RUN_PROFILE",
);

const abortedBeforeStart = new AbortController();
abortedBeforeStart.abort();
await assert.rejects(
  runtimeA.execute("__tool_runtime_abort_probe", {}, abortedBeforeStart.signal, contextA),
  error => error?.code === "OPERATION_ABORTED",
);
assert.equal(abortProbeExecutions, 0, "an already-aborted run must not enter tool code");

let unlimitedExecutions = 0;
tools.defineTool({ name: "__unlimited_abort_probe", description: "test", parameters: { type: "object", properties: {} },
  timeout: 0, execute: (_args, signal) => { unlimitedExecutions++; return { aborted: signal?.aborted === true }; },
});
await assert.rejects(runtimeA.execute("__unlimited_abort_probe", {}, abortedBeforeStart.signal, contextA),
  error => error?.code === "OPERATION_ABORTED");
assert.equal(unlimitedExecutions, 0, "unlimited timeout must not disable the initial cancellation guard");
assert.deepEqual(await runtimeA.execute("__unlimited_abort_probe", {}, new AbortController().signal, contextA), { aborted: false });
assert.equal(unlimitedExecutions, 1, "a later valid call must recover after cancellation");

const started = new Promise(resolve => { abortProbeStarted = resolve; });
const abortDuringRun = new AbortController();
const runningAbort = runtimeA.execute("__tool_runtime_abort_probe", {}, abortDuringRun.signal, contextA);
await started;
abortDuringRun.abort();
await assert.rejects(runningAbort, error => error?.code === "OPERATION_ABORTED");
assert.equal(abortProbeExecutions, 1);

const sinkFailureRuntime = tools.createToolRuntime({
  emit: () => { throw new Error("event sink failed"); },
});
assert.deepEqual(await sinkFailureRuntime.execute("__tool_runtime_quick_probe", {}), { ok: true });

console.log("tool runtime isolation tests passed");

function schemaKeywordPaths(value, keyword, path = "$") {
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === keyword) paths.push(childPath);
    paths.push(...schemaKeywordPaths(child, keyword, childPath));
  }
  return paths;
}

const policySessions = [];
const sessionLists = [];
const policyRuntime = tools.createToolRuntime({ sessions: {
  async canManageSessions(sessionId) { policySessions.push(sessionId); return sessionId === "root"; },
  async listSessions(input) { sessionLists.push(input); return { sessions: [] }; },
} });
await assert.rejects(
  policyRuntime.execute("manage_sessions", { action: "list" }, undefined, { sessionId: "child" }),
  error => error.code === "SESSION_TOOL_FORBIDDEN",
);
await assert.rejects(
  policyRuntime.execute("manage_goal", { action: "get" }, undefined, { sessionId: "child" }),
  error => error.code === "GOAL_SESSION_FORBIDDEN",
);
assert.equal(sessionLists.length, 0, "denied child runs must not reach session persistence");
await policyRuntime.execute("manage_sessions", { action: "list" }, undefined, { sessionId: "root" });
assert.deepEqual(policySessions, ["child", "child", "root"], "policy receives the actual session id");
assert.equal(sessionLists.length, 1, "a permitted root session still runs normally");

import assert from "node:assert/strict";
import test from "node:test";
import contributions from "#capabilities/context";
import sessionContext from "../../src/capabilities/sessions/context.js";
import { pageModeStates } from "../../src/capabilities/tabs/page-mode.js";
import { createContextSources } from "../../src/background/context-sources.js";

const request = { sessionId: "session-a", runId: "run-a", epoch: 4, reason: "snapshot" };
function fixture(overrides = {}) {
  const reads = [];
  const runtime = {
    visitedTaskSites: [{ id: 7, url: "https://example.test/" }],
    tracker: { id: "tracker-a", title: "Read pages", total: 3, current: 1 },
    goal: { status: "active", objective: "Read the relevant pages" },
  };
  const host = {
    getSessionRuntime(id) { reads.push(["session", id]); return runtime; },
    async canUseSessionGoal(id) { reads.push(["goal", id]); return true; },
    async requestLocation() { reads.push(["location"]); return { city: "Test city" }; },
    async getWorkingTabContext(id) { reads.push(["tab", id]); return { id: 7, url: "https://example.test/", title: "Example" }; },
    async getSecurityGuardrails() { return { rules: [{ id: "blocked", type: "domain", action: "block", value: "example.test" }] }; },
    ...overrides,
  };
  return { host, reads, runtime, collect: createContextSources(contributions.flatMap(contribute => contribute(host))) };
}

test("discovered Session context keeps structured values private and preserves built-in order", async () => {
  assert.ok(contributions.includes(sessionContext), "the real source catalog must discover the built-in capability");
  const { host, collect, runtime, reads } = fixture();
  const definitions = sessionContext(host);
  assert.deepEqual(definitions.map(source => source.id), ["session", "workingTab"]);
  assert.ok(definitions.every(source => source.title === undefined));
  const result = await collect(request);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "page-mode");
  assert.deepEqual(JSON.parse(result.sources[0].text), { tabId: 7, pageMode: "desktop" });
  assert.deepEqual(result.contextDiagnostics, []);
  const session = result.values.get("session");
  assert.equal(session.tracker.id, "tracker-a");
  assert.equal(session.goal.objective, "Read the relevant pages");
  assert.equal(result.values.has("location"), false);
  assert.equal(reads.some(([kind]) => kind === "location"), false, "context collection must leave location access to the explicit tool");
  assert.equal(result.values.get("workingTab").securityGuardrailBlocked, true);
  runtime.visitedTaskSites[0].id = 8;
  assert.equal(session.taskSiteTabs[0].id, 7, "the host must not retain mutable runtime results");
});

test("reason filtering retains site evidence without reading location or goal; tools read only the tab", async () => {
  const { collect, reads } = fixture();
  const preview = await collect({ ...request, reason: "site-skills" });
  assert.deepEqual([...preview.values.keys()], ["session", "workingTab"]);
  assert.deepEqual(Object.keys(preview.values.get("session")), ["taskSiteTabs"]);
  assert.deepEqual(reads, [["session", "session-a"], ["tab", "session-a"]]);
  reads.length = 0;
  const tool = await collect({ ...request, reason: "tool" });
  assert.deepEqual([...tool.values.keys()], ["workingTab"]);
  assert.deepEqual(reads, [["tab", "session-a"]]);
});

test("goals require Session permission and completed goals stay out of context", async () => {
  const denied = fixture({ canUseSessionGoal: async () => false });
  assert.equal((await denied.collect(request)).values.get("session").goal, undefined);
  const complete = fixture();
  complete.runtime.goal.status = "complete";
  assert.equal((await complete.collect(request)).values.get("session").goal, undefined);
});

test("page mode context reports the live connection and explains restoration only to its owner", async () => {
  let connection = 1;
  pageModeStates.set(7, { sessionId: "session-a", applied: "mobile", connectionId: 1, connection: () => connection });
  const { collect } = fixture();
  const mode = async input => JSON.parse((await collect(input)).sources.find(source => source.id === "page-mode").text);
  try {
    assert.deepEqual(await mode(request), { tabId: 7, pageMode: "mobile" });
    connection = null;
    const released = await mode(request);
    assert.equal(released.pageMode, "desktop");
    assert.ok(released.note, "a continued task must know to observe again before interacting");
    assert.deepEqual(await mode({ ...request, sessionId: "other" }), { tabId: 7, pageMode: "desktop" });
    connection = 1;
    pageModeStates.get(7).applied = null;
    const switching = await mode(request);
    assert.equal(switching.pageMode, undefined);
    assert.ok(switching.note);
  } finally { pageModeStates.clear(); }
});

test("optional guardrail read failure keeps tab metadata; missing tabs do not trigger guardrail reads", async () => {
  const failed = fixture({ getSecurityGuardrails: async () => { throw new Error("unavailable"); } });
  const result = await failed.collect(request);
  assert.equal(result.values.get("workingTab").id, 7);
  assert.deepEqual(result.contextDiagnostics, []);
  let guardrailReads = 0;
  const missing = fixture({ getWorkingTabContext: async () => null, getSecurityGuardrails: async () => { guardrailReads++; return {}; } });
  assert.equal((await missing.collect(request)).values.has("workingTab"), false);
  assert.equal(guardrailReads, 0);
});

test("required Session read failure blocks model context without exposing the underlying error", async () => {
  let fail = true;
  const { collect } = fixture({ canUseSessionGoal: async () => {
    if (fail) throw new Error("private provider detail");
    return true;
  } });
  await assert.rejects(collect(request), error => error.code === "CONTEXT_SOURCE_REQUIRED"
    && error.sourceId === "session" && !error.message.includes("private"));
  fail = false;
  assert.equal((await collect(request)).values.get("session").goal.status, "active");
});

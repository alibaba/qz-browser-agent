import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRuntimeState } from "../../src/background/session/runtime-state.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { OWNED_TAB_SCHEMA_VERSION } from "../../src/background/session/tabs.js";
import { createSessionState } from "../../src/sidepanel/features/sessions/session-state.js";

const runtimes = new Map();
const writes = [];
const removals = [];
const groupSyncs = [];
const completions = [];
const readyEntries = [];
let nowTick = 0;
const supervisor = {
  replaceRuntimes(values) {
    runtimes.clear();
    for (const [id, value] of Object.entries(values || {})) runtimes.set(id, value);
  },
  runtimeEntries: () => [...runtimes.entries()],
  getRuntime: id => runtimes.get(id) || null,
  setRuntime(id, value) {
    runtimes.set(id, value);
    return value;
  },
  deleteRuntime: id => runtimes.delete(id),
};
const repository = {
  async migrateLegacyRuntime() {},
  async readRuntimeBatch() {
    return {
      s1: {
        sessionId: "s1",
        status: "running",
        running: true,
        ownedTabSchemaVersion: OWNED_TAB_SCHEMA_VERSION,
        ownedTabIds: [8, 8],
        sessionTabIds: [8],
        visitedTaskSites: [{ id: 8, url: "https://example.test/" }, { id: 8, url: "https://example.test/" }],
        loadedPluginSkillNames: ["Research", "research"],
        pendingFollowUpMessages: [
          { role: "user", content: [{ type: "text", text: "continue" }, { type: "image_url", image_url: { url: "x" } }] },
          { role: "assistant", content: "ignore" },
        ],
        pendingSteeringMessages: [
          { role: "user", content: "guide next", clientMessageId: "steering-1" },
          { role: "assistant", content: "ignore" },
        ],
      },
    };
  },
  async writeRuntime(id, value, options) {
    writes.push({ id, value: structuredClone(value), options });
  },
  async deleteRuntime(id) {
    removals.push(id);
  },
};
const state = createSessionRuntimeState({
  supervisor,
  repository,
  getSessions: async () => ({ s1: { id: "s1" } }),
  getAgentEntry(id) {
    const entry = { ready: Promise.resolve() };
    readyEntries.push(id);
    return entry;
  },
  normalizeSessionId: value => String(value || "default").trim() || "default",
  scheduleTabGroupSync: id => groupSyncs.push(id),
  onCompleted: async id => completions.push(id),
  now: () => `2026-07-12 12:00:${String(++nowTick).padStart(2, "0")}`,
});

await state.hydrate();
const hydrated = runtimes.get("s1");
assert.equal(hydrated.status, "interrupted");
assert.equal(hydrated.running, false);
assert.equal(hydrated.reason, "service_worker_restarted");
assert.deepEqual(hydrated.ownedTabIds, [8]);
assert.deepEqual(hydrated.loadedPluginSkillNames, ["research"]);
assert.equal(hydrated.pendingFollowUpMessages.length, 1);
assert.deepEqual(hydrated.pendingFollowUps, [{ clientMessageId: "", text: "continue", imageCount: 1, index: 0 }]);
assert.deepEqual(hydrated.pendingSteerings, [{
  clientMessageId: "steering-1",
  text: "guide next",
  imageCount: 0,
  index: 0,
}]);
assert.ok(writes.some(item => item.id === "s1" && item.options.terminal === true));

state.set("s1", {
  status: "running",
  running: true,
  currentTool: { name: "read_dom", toolCallId: "call-1", rateLimit: { waitMs: 20 } },
  ownedTabIds: [9, 9, 10],
});
await Promise.resolve();
assert.deepEqual(runtimes.get("s1").ownedTabIds, [9, 10]);
assert.equal(runtimes.get("s1").currentTool.toolCallId, "call-1");
assert.deepEqual(runtimes.get("s1").currentTool.rateLimit, { waitMs: 20 });
assert.deepEqual(groupSyncs, ["s1"]);

state.recordEvent("s1", {
  type: "tool_execution_update",
  runId: "run-2",
  toolCallId: "call-1",
  name: "read_dom",
  statusText: "Reading",
});
assert.equal(runtimes.get("s1").currentTool.statusText, "Reading");
state.recordEvent("s1", { type: "tool_execution_end", runId: "run-2", toolCallId: "call-1" });
assert.equal(runtimes.get("s1").currentTool, null);

state.set("s1", { status: "completed", running: false });
await Promise.resolve();
assert.deepEqual(completions, ["s1"]);
state.set("s1", { status: "completed", running: false });
await Promise.resolve();
assert.deepEqual(completions, ["s1"], "completion notification must fire only on the transition");
assert.equal(state.isTerminalForRun(runtimes.get("s1"), "run-2"), true);

state.set("s1", { contextWindow: 1000, inputTokensEstimate: 500, contextBoundaryId: "ctx-1" });
await state.clearContextUsage();
assert.equal(runtimes.get("s1").contextWindow, 0);
assert.equal(runtimes.get("s1").inputTokensEstimate, 0);
assert.equal(runtimes.get("s1").contextBoundaryId, "");

state.set("s1", {
  loadedPluginSkillNames: ["Research"],
  pendingFollowUpMessages: [],
  pendingSteeringMessages: [{ role: "user", content: "resume steering", clientMessageId: "resume-steering" }],
});
assert.deepEqual(state.loadedSkillNames("s1", ["Extra", "research"]), ["research", "extra"]);
assert.deepEqual(runtimes.get("s1").pendingFollowUps, []);
assert.deepEqual(runtimes.get("s1").pendingSteerings.map(item => item.clientMessageId), ["resume-steering"]);
assert.deepEqual(await state.resumeFollowUps("test"), ["s1"]);
assert.deepEqual(readyEntries, ["s1"]);

state.remove("s1");
await Promise.resolve();
assert.equal(runtimes.has("s1"), false);
assert.ok(removals.includes("s1"));
assert.deepEqual(groupSyncs, ["s1", "s1"]);

console.log("session runtime state tests passed");

test("overlapping tool events isolate progress and project the surviving call through reconnects", () => {
  const id = "parallel-tools", client = createSessionState();
  const emit = (type, toolCallId, fields = {}) => {
    const event = { type, sessionId: id, runId: "parallel-run", toolCallId, ...fields };
    state.recordEvent(id, event);
    client.applyEvent({ ...event, runtime: structuredClone(runtimes.get(id)) });
    assert.deepEqual(client.getRuntime(id).currentTool, runtimes.get(id).currentTool);
    return runtimes.get(id).currentTool;
  };
  emit("agent_start");
  emit("tool_execution_start", "a", { toolName: "open_tab", toolTitle: "Open A" });
  const a = emit("tool_execution_update", "a", { phase: "queued", statusText: "A queued", rateLimit: { waitMs: 1000 } });
  const b = emit("tool_execution_start", "b", { toolName: "read_article", toolTitle: "Read B", toolRendererId: "article" });
  assert.equal(b.phase, "running");
  assert.equal(b.statusText, "");
  assert.equal(b.rateLimit, null);
  assert.equal(b.title, "Read B");
  assert.equal(b.rendererId, "article");
  assert.notEqual(b.startedAt, a.startedAt);
  assert.deepEqual(emit("tool_execution_end", "a"), b, "ending an older tool preserves the current one");
  emit("tool_execution_start", "c", { toolName: "open_tab" });
  const c = emit("tool_execution_update", "c", { phase: "queued", statusText: "C queued", rateLimit: { waitMs: 500 } });
  const resumedB = emit("tool_execution_update", "b", { statusText: "B reading" });
  assert.equal(resumedB.startedAt, b.startedAt);
  assert.equal(resumedB.phase, "running");
  assert.equal(resumedB.rateLimit, null);
  assert.equal(resumedB.rendererId, "article");
  const reconnected = createSessionState();
  reconnected.applyEvent({ type: "state", sessionId: id, runtime: structuredClone(runtimes.get(id)) });
  assert.deepEqual(reconnected.getRuntime(id).currentTool, resumedB);
  assert.deepEqual(emit("tool_execution_end", "b"), c, "ending the selected tool restores another active tool");
  assert.equal(emit("tool_execution_end", "c"), null);
  emit("tool_execution_start", "old", { toolName: "open_tab" });
  emit("agent_start", undefined, { runId: "replacement" });
  emit("tool_execution_update", "old", { statusText: "stale" });
  assert.equal(runtimes.get(id).currentTool, null, "stale runs cannot restore old progress");
  emit("tool_execution_start", "new", { runId: "replacement", toolName: "read_article" });
  assert.equal(emit("tool_execution_end", "new", { runId: "replacement" }), null, "run restart clears all old active tools");
  state.remove(id);
});

for (const failingStep of ["migration", "read", "write"]) {
  test(`runtime hydration recovers after ${failingStep} failure without restoring legacy tab ownership`, async () => {
    const failure = new Error(`${failingStep} storage unavailable`);
    const warnings = [], persisted = [];
    let unavailable = true;
    const checkpoint = {
      sessionId: "restored", status: "running", running: true,
      ownedTabIds: [71], sessionTabIds: [71],
      pendingFollowUpMessages: [{ role: "user", content: "continue", clientMessageId: "queued" }],
    };
    const owner = createSessionSupervisor({ createAgent() { throw new Error("hydration must not start an Agent"); } });
    owner.setRuntime("stale", { status: "running", running: true });
    const checkStorage = step => { if (unavailable && failingStep === step) throw failure; };
    const recovery = createSessionRuntimeState({
      supervisor: owner,
      repository: {
        async migrateLegacyRuntime() { checkStorage("migration"); },
        async readRuntimeBatch(ids) {
          assert.deepEqual(ids, ["restored"]);
          checkStorage("read");
          return { restored: structuredClone(checkpoint) };
        },
        async writeRuntime(id, value, options) {
          checkStorage("write");
          persisted.push({ id, value: structuredClone(value), options });
        },
        async deleteRuntime() { assert.fail("hydration must not delete persisted checkpoints"); },
      },
      getSessions: async () => ({ restored: { id: "restored" } }),
      getAgentEntry: id => owner.getEntry(id),
      normalizeSessionId: value => String(value || "").trim(),
      logger: { warn: (...args) => warnings.push(args), debug() {} },
    });
    await recovery.hydrate();
    assert.deepEqual(owner.runtimeEntries(), [], "failed hydration cannot leave stale or partially restored runtimes active");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], failure);
    assert.deepEqual(persisted, []);

    unavailable = false;
    await recovery.hydrate();
    const restored = owner.getRuntime("restored");
    assert.equal(restored.status, "interrupted");
    assert.equal(restored.running, false);
    assert.equal(restored.reason, "service_worker_restarted");
    assert.deepEqual(restored.ownedTabIds, [], "a pre-ownership checkpoint cannot claim a browser tab after restart");
    assert.deepEqual(restored.sessionTabIds, []);
    assert.equal(restored.ownedTabSchemaVersion, OWNED_TAB_SCHEMA_VERSION);
    assert.equal(restored.pendingFollowUpMessages[0].clientMessageId, "queued");
    assert.equal(owner.peekEntry("restored").agent, null);
    assert.deepEqual(persisted, [{ id: "restored", value: restored, options: { terminal: true } }]);
    assert.equal(checkpoint.status, "running", "normalization must not mutate the storage input");
    assert.equal(warnings.length, 1, "a recovered read does not repeat the earlier failure");
  });
}

test("queue recovery isolates a failed Agent and skips a Session deleted while another is initializing", async () => {
  const owner = createSessionSupervisor({ createAgent: () => ({}) });
  const entered = Promise.withResolvers(), ready = Promise.withResolvers();
  const attempts = [], warnings = [];
  const failure = new Error("Agent initialization failed");
  let firstAttempt = true;
  const queued = id => ({ role: "user", content: `continue ${id}`, clientMessageId: id });
  for (const id of ["failed", "waiting", "deleted"]) {
    owner.setRuntime(id, { status: "interrupted", pendingFollowUpMessages: [queued(id)] });
  }
  owner.setRuntime("steering", { status: "interrupted", pendingSteeringMessages: [queued("steering")] });
  owner.setRuntime("empty", { status: "idle" });
  const recovery = createSessionRuntimeState({
    supervisor: owner, repository, getSessions: async () => ({}),
    normalizeSessionId: value => String(value || "").trim(),
    logger: { warn: (...args) => warnings.push(args), debug() {} },
    getAgentEntry(id) {
      attempts.push(id);
      if (id === "failed" && firstAttempt) return { ready: Promise.reject(failure) };
      if (id === "waiting") { entered.resolve(); return { ready: ready.promise }; }
      return { ready: Promise.resolve() };
    },
  });
  const resuming = recovery.resumeFollowUps("restart");
  await entered.promise;
  owner.deleteRuntime("deleted");
  ready.resolve();
  assert.deepEqual(await resuming, ["waiting", "steering"]);
  assert.deepEqual(attempts, ["failed", "waiting", "steering"]);
  assert.equal(owner.getRuntime("deleted"), null, "a deleted candidate must not be recreated");
  assert.equal(owner.peekEntry("deleted"), null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], failure);
  assert.equal(owner.getRuntime("failed").pendingFollowUpMessages[0].clientMessageId, "failed");

  firstAttempt = false;
  owner.setRuntime("waiting", { pendingFollowUpMessages: [] });
  owner.setRuntime("steering", { pendingSteeringMessages: [] });
  assert.deepEqual(await recovery.resumeFollowUps("retry"), ["failed"]);
  assert.deepEqual(attempts, ["failed", "waiting", "steering", "failed"]);
  assert.equal(warnings.length, 1, "retry should succeed without losing or duplicating the queued message");
});

test("legacy queue summary patches retain message payloads and normalize both delivery modes equally", () => {
  const followUp = [{ role: "user", content: "full follow-up", clientMessageId: "follow-up" }];
  const steering = [{ role: "user", content: "full steering", clientMessageId: "steering" }];
  state.set("legacy", { pendingFollowUpMessages: followUp, pendingSteeringMessages: steering });
  const summaries = [
    { clientMessageId: " queued ", text: "preview", imageCount: -1, attachmentCount: "2", index: 99 },
    null,
    { clientMessageId: "picture", imageCount: "3", attachmentCount: -1 },
  ];
  const expected = [
    { clientMessageId: "queued", text: "preview", imageCount: 0, attachmentCount: 2, index: 0 },
    { clientMessageId: "", text: "", imageCount: 0, index: 1 },
    { clientMessageId: "picture", text: "", imageCount: 3, index: 2 },
  ];
  for (const [input, result] of [[summaries, expected], [null, []], [{}, []]]) {
    const runtime = state.set("legacy", { pendingFollowUps: input, pendingSteerings: input });
    assert.deepEqual(runtime.pendingFollowUps, result);
    assert.deepEqual(runtime.pendingSteerings, result);
    assert.equal(runtime.pendingFollowUpMessages[0].content, "full follow-up");
    assert.equal(runtime.pendingSteeringMessages[0].content, "full steering");
  }
  assert.equal(summaries[0].index, 99, "summary projection must not modify the caller's data");
  state.remove("legacy");
});

import assert from "node:assert/strict";
import test from "node:test";
import { closeCompletedTaskTabs } from "../support/mcp-soak-tab-cleanup.mjs";

function fixture(t, runtimes, { beforeRead = () => {}, failRemoval = null } = {}) {
  const stored = Object.fromEntries(runtimes.map(runtime => [`_session_runtime_${runtime.sessionId}`, {
    status: "completed", running: false, runId: "run-1", ...runtime,
  }]));
  stored._session_history = { transcript: [{ type: "assistant", content: "Keep this result." }] };
  const originalHistory = structuredClone(stored._session_history);
  const tabs = new Set([101, 102, 103, 104, 999]);
  const calls = [];
  let reads = 0;
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: { get: async () => { beforeRead(++reads, stored); return structuredClone(stored); } } },
    tabs: { remove: async tabId => {
      if (tabId === failRemoval) throw new Error("Tab removal failed");
      assert.ok(tabs.delete(tabId));
    } },
  };
  t.after(() => { globalThis.chrome = previous; assert.deepEqual(stored._session_history, originalHistory); });
  const mcp = async (name, { sessionId }) => {
    calls.push({ name, sessionId });
    assert.equal(name, "qingzhou_get_session_snapshot", "native cleanup never invokes drive execution or stops a task");
    const runtime = stored[`_session_runtime_${sessionId}`];
    return { sessionId, status: runtime.status, runId: runtime.runId, runtime: structuredClone(runtime) };
  };
  const page = { evaluate: (fn, args) => fn(structuredClone(args)) };
  return { mcp, page, calls, tabs, stored };
}

test("completed native cleanup closes only its owned tabs and preserves history and other owners", async t => {
  const f = fixture(t, [
    { sessionId: "done", ownedTabIds: [101, 102] },
    { sessionId: "active", status: "running", running: true, ownedTabIds: [103] },
    { sessionId: "other", ownedTabIds: [104] },
  ]);
  const report = await closeCompletedTaskTabs({ ...f, sessionIds: ["done", "done", "active"], activeSessionIds: ["active"] });
  assert.deepEqual(report.closed, [{ sessionId: "done", tabId: 101 }, { sessionId: "done", tabId: 102 }]);
  assert.deepEqual([...f.tabs], [103, 104, 999]);
  assert.deepEqual(f.calls, [{ name: "qingzhou_get_session_snapshot", sessionId: "done" }]);
  assert.deepEqual(report.errors, []);
});

test("a running native task is excluded even when the caller omits activeSessionIds", async t => {
  const f = fixture(t, [{ sessionId: "active", status: "running", running: true, ownedTabIds: [101] }]);
  const report = await closeCompletedTaskTabs({ ...f, sessionIds: ["active"] });
  assert.deepEqual(report.closed, []);
  assert.deepEqual(report.skipped, [{ sessionId: "active", status: "running" }]);
  assert.ok(f.tabs.has(101));
});

test("cleanup rechecks ownership and run state before each tab removal", async t => {
  const f = fixture(t, [
    { sessionId: "done", ownedTabIds: [101, 102, 103] },
    { sessionId: "other", status: "running", running: true, ownedTabIds: [104] },
  ], { beforeRead(reads, stored) {
    if (reads === 3) stored._session_runtime_other.ownedTabIds.push(102);
    if (reads === 4) Object.assign(stored._session_runtime_done, { status: "running", running: true, runId: "run-2" });
  } });
  const report = await closeCompletedTaskTabs({ ...f, sessionIds: ["done"] });
  assert.deepEqual(report.closed, [{ sessionId: "done", tabId: 101 }]);
  assert.deepEqual(report.skipped.map(item => item.tabId), [102, 103]);
  assert.deepEqual([...f.tabs], [102, 103, 104, 999]);
});

test("pending follow-ups and a completed replacement run preserve task tabs", async t => {
  const f = fixture(t, [
    { sessionId: "queued", ownedTabIds: [101], pendingFollowUps: ["next"] },
    { sessionId: "replaced", ownedTabIds: [102] },
  ], { beforeRead(reads, stored) {
    if (reads === 4) stored._session_runtime_replaced.runId = "run-2";
  } });
  const report = await closeCompletedTaskTabs({ ...f, sessionIds: ["queued", "replaced"] });
  assert.deepEqual(report.closed, []);
  assert.deepEqual(report.skipped.map(item => item.tabId), [101, 102]);
  assert.ok(f.tabs.has(101) && f.tabs.has(102));
});

test("individual removal failures remain visible without blocking other completed tasks", async t => {
  const f = fixture(t, [
    { sessionId: "failed-close", ownedTabIds: [101] },
    { sessionId: "done", status: "error", ownedTabIds: [102] },
  ], { failRemoval: 101 });
  const report = await closeCompletedTaskTabs({ ...f, sessionIds: ["failed-close", "done"] });
  assert.deepEqual(report.errors, [{ sessionId: "failed-close", tabId: 101, message: "Tab removal failed" }]);
  assert.deepEqual(report.closed, [{ sessionId: "done", tabId: 102 }]);
  assert.ok(f.tabs.has(101));
});

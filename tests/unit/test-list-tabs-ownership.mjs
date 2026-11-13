import assert from "node:assert/strict";
import { createMemoryStorage } from "../support/memory-storage.mjs";

const tabs = [
  { id: 1, windowId: 1, title: "Owned", url: "https://owned.example/", active: false },
  { id: 2, windowId: 1, title: "Foreign", url: "https://foreign.example/", active: false },
  { id: 3, windowId: 1, title: "User page", url: "https://user.example/", active: true },
  { id: 4, windowId: 1, title: "New Tab", url: "chrome://newtab/", active: false },
  { id: 5, windowId: 1, title: "Other user page", url: "https://other.example/", active: false },
];
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://qz/${path}` },
  storage: { local: createMemoryStorage() },
  tabs: {
    async get(id) {
      const tab = tabs.find(item => item.id === Number(id));
      if (!tab) throw new Error(`missing tab ${id}`);
      return { ...tab };
    },
    async query() { return tabs.map(tab => ({ ...tab })); },
    onUpdated: { addListener() {}, removeListener() {} },
  },
};

const { createSessionTabs } = await import("../../src/background/session/tabs.js");
const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
const { createToolRegistry } = await import("../../src/background/tools/registry.js");
const { runDriveCalls } = await import("../../src/background/mcp/external-drive.js");

const runtimes = {
  a: { ownedTabIds: [1], tabAliases: { page: 1 } },
  b: { ownedTabIds: [2] },
};
const staleRuns = new Set();
const supervisor = {
  getRuntime: id => runtimes[id] || null,
  runtimeEntries: () => Object.entries(runtimes),
  setRuntime: (id, patch) => Object.assign(runtimes[id] ||= {}, patch),
  isRunCurrent: (_id, runId) => !staleRuns.has(runId),
};
const sessions = createSessionTabs({ supervisor, tabsApi: chrome.tabs, storage: chrome.storage.local,
  setRuntime: supervisor.setRuntime, persistRuntime: async () => {} });
const runtime = createToolRuntime({ sessions: { ...sessions, isRunCurrent: supervisor.isRunCurrent } });

const executed = [];
const registry = createToolRegistry();
const probe = registry.forCapability("probe");
const parameters = { type: "object", properties: { tabRef: { type: ["integer", "string"] } }, required: ["tabRef"] };
probe({ name: "change_page", page: "owned", parameters, execute: args => (executed.push(["change_page", args.tabId]), { ok: true }) });
// Mirrors evaluate and act_on_element, which run staged in agent batches, drive batches, and scripts.
probe({ name: "staged_change_page", page: "owned", behavior: { parallelTab: true }, parameters,
  execute: args => (executed.push(["staged_change_page", args.tabId]), { ok: true }) });
probe({ name: "read_page", page: "readOnly", parameters, execute: args => (executed.push(["read_page", args.tabId]), { ok: true }) });
const probes = registry.snapshot();
const signal = () => new AbortController().signal;
const owned = id => runtimes[id].ownedTabIds;

async function listTabs(sessionId, args = {}) {
  return runtime.execute("list_tabs", args, signal(), { sessionId, runId: `${sessionId}-run` });
}

async function stagedBatch(sessionId, name, tabRef, runId = `${sessionId}-run`) {
  const context = { sessionId, runId, externalDrive: true, toolRegistrySnapshot: probes };
  const batch = await runDriveCalls([{ id: "call", name, args: { tabRef } }], {
    aliases: runtime.getTabAliases(sessionId), context, signal: signal(),
    getBatchTabPolicy: (toolName, args) => runtime.getBatchTabPolicy(toolName, args, context),
    execute: (toolName, args, callSignal, callContext) => runtime.execute(toolName, args, callSignal, callContext),
    commitToolResult: runtime.commitToolResult, discardToolResult: runtime.discardToolResult,
  });
  return batch.results[0];
}

// The default scope lists owned and unclaimed web tabs, marks ownership, and claims nothing.
const listed = await listTabs("a");
assert.deepEqual(listed, {
  tabs: [
    { tabRef: "page", url: "https://owned.example/", title: "Owned", active: false, ownership: "owned" },
    { tabRef: 3, url: "https://user.example/", title: "User page", active: true, ownership: "unclaimed" },
    { tabRef: 5, url: "https://other.example/", title: "Other user page", active: false, ownership: "unclaimed" },
  ],
  count: 3,
  foreign: 1,
});
for (const row of listed.tabs) {
  assert.deepEqual(Object.keys(row).sort(), ["active", "ownership", "tabRef", "title", "url"],
    "each row carries one tabRef and no internal identity");
}
assert.deepEqual(owned("a"), [1], "listing never claims");
assert.deepEqual(owned("b"), [2], "listing never moves another session's tab");
assert.equal(listed.tabs.some(row => row.title === "Foreign"), false, "the default omits tabs held by another session");
assert.equal(listed.tabs.some(row => row.title === "New Tab"), false, "non-web tabs stay excluded");

assert.deepEqual(await listTabs("a", { scope: "owned" }), {
  tabs: [{ tabRef: "page", url: "https://owned.example/", title: "Owned", active: false, ownership: "owned" }],
  count: 1,
  foreign: 1,
});

const all = await listTabs("a", { scope: "all" });
assert.deepEqual(all.tabs.map(row => [row.tabRef, row.ownership, row.active]), [
  ["page", "owned", false],
  [2, "foreign", false],
  [3, "unclaimed", true],
  [5, "unclaimed", false],
]);
assert.equal(all.count, 4);
assert.deepEqual(owned("a"), [1], "scope all never claims");

// Read-only tools inspect an unclaimed tab without claiming it.
executed.length = 0;
await runtime.execute("read_page", { tabRef: 3 }, signal(), { sessionId: "a", runId: "a-run", toolRegistrySnapshot: probes });
assert.deepEqual(executed, [["read_page", 3]]);
assert.deepEqual(owned("a"), [1], "a read leaves the listed tab unclaimed");

// The first mutating use of a listed unclaimed tabRef claims it.
const userTab = listed.tabs.find(row => row.active).tabRef;
executed.length = 0;
await runtime.execute("change_page", { tabRef: userTab }, signal(), { sessionId: "a", runId: "a-run", toolRegistrySnapshot: probes });
assert.deepEqual(executed, [["change_page", 3]]);
assert.deepEqual(owned("a"), [1, 3], "claim-on-use claims the listed tab");
assert.equal((await listTabs("a", { scope: "owned" })).tabs.find(row => row.tabRef === 3)?.ownership, "owned");
assert.equal((await listTabs("b")).tabs.some(row => row.tabRef === 3), false, "a claimed tab leaves other sessions' default list");

// Staged calls claim too, and only on the run that still holds write authority.
staleRuns.add("a-stale");
const stale = await stagedBatch("a", "staged_change_page", 5, "a-stale");
assert.equal(stale.isError, true);
assert.deepEqual(owned("a"), [1, 3], "an obsolete run cannot claim");
executed.length = 0;
const staged = await stagedBatch("a", "staged_change_page", 5);
assert.equal(staged.isError, false, JSON.stringify(staged.result));
assert.deepEqual(executed, [["staged_change_page", 5]]);
assert.deepEqual(owned("a"), [1, 3, 5], "a staged first use claims an unclaimed tab");

// Foreign tabs stay out of reach for writes, staged or not, and keep their owner.
executed.length = 0;
await assert.rejects(
  runtime.execute("change_page", { tabRef: 2 }, signal(), { sessionId: "a", runId: "a-run", toolRegistrySnapshot: probes }),
  { code: "SESSION_TAB_FOREIGN" },
);
const stagedForeign = await stagedBatch("a", "staged_change_page", 2);
assert.equal(stagedForeign.isError, true);
assert.equal(stagedForeign.result.code, "SESSION_TAB_FOREIGN");
assert.deepEqual(executed, [], "a foreign tab never executes a write");
assert.deepEqual(owned("b"), [2]);
assert.equal(owned("a").includes(2), false, "a foreign tab cannot be claimed");

console.log("list_tabs ownership tests passed");

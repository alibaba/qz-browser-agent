import assert from "node:assert/strict";
import {
  createSessionTabs,
  getOwnedTabIds,
  normalizeVisitedTaskSites,
  normalizeWorkingTab,
} from "../../src/background/session/tabs.js";

const runtimes = new Map([
  ["a", { sessionId: "a", ownedTabIds: [1], workingTabId: 1 }],
  ["b", { sessionId: "b", ownedTabIds: [2], workingTabId: 2 }],
  ["child", { sessionId: "child", ownedTabIds: [3], workingTabId: 3 }],
]);
const tabs = new Map([
  [1, webTab(1, "https://a.example/page")],
  [2, webTab(2, "https://b.example/page")],
  [3, webTab(3, "https://child.example/page")],
  [4, webTab(4, "https://free.example/page")],
]);
const broadcasts = [];
const persisted = [];
const removed = [];
const created = [];
let guardrails = {};
let failPersist = false;
let clock = 0;
let nextTabId = 6;

const supervisor = {
  getRuntime(sessionId) {
    return runtimes.get(sessionId) || null;
  },
  setRuntime(sessionId, runtime) {
    runtimes.set(sessionId, runtime);
    return runtime;
  },
  runtimeEntries() {
    return [...runtimes.entries()];
  },
};

const sessionTabs = createSessionTabs({
  supervisor,
  tabsApi: {
    async get(tabId) {
      const tab = tabs.get(Number(tabId));
      if (!tab) throw new Error(`missing tab ${tabId}`);
      return { ...tab };
    },
    async create({ windowId, url, active }) {
      const tab = webTab(nextTabId++, url);
      tab.windowId = windowId;
      tab.active = active;
      tab.status = "loading";
      tabs.set(tab.id, tab);
      created.push({ windowId, url, active, tabId: tab.id });
      return { ...tab };
    },
    async query({ active = false, windowId } = {}) {
      return [...tabs.values()].filter(tab => (!active || tab.active) && (windowId == null || tab.windowId === windowId));
    },
    async update(tabId, patch) {
      const next = { ...tabs.get(Number(tabId)), ...patch };
      tabs.set(Number(tabId), next);
      return { ...next };
    },
    async remove(tabId) {
      tabs.delete(Number(tabId));
      removed.push(Number(tabId));
    },
    async ungroup() {},
  },
  tabGroupsApi: { async get() { return {}; } },
  windowsApi: { async update() {} },
  windowTarget: { async resolveForNewTab() { return 7; } },
  storage: createMemoryStorage(),
  ready: async () => {},
  getSessions: async () => ({
    a: { id: "a", parentSessionId: "0" },
    b: { id: "b", parentSessionId: "0" },
    child: { id: "child", parentSessionId: "a" },
  }),
  isAutomationSessionFamily: () => false,
  setRuntime(sessionId, patch) {
    const next = { ...(runtimes.get(sessionId) || {}), ...patch };
    if (Object.hasOwn(patch, "ownedTabIds")) {
      next.ownedTabIds = getOwnedTabIds(patch);
      next.sessionTabIds = next.ownedTabIds;
    }
    runtimes.set(sessionId, next);
    return next;
  },
  async persistRuntime(sessionId = "") {
    if (failPersist) throw new Error("runtime persistence failed");
    persisted.push(sessionId);
  },
  broadcast(event) {
    broadcasts.push(event);
  },
  now: () => `t${++clock}`,
  ensureTabGroupForWindow: async tabIds => ({ groupId: 9, tabIds }),
  loadSecurityGuardrails: async () => guardrails,
  logger: { debug() {}, warn() {} },
  normalizeSessionId: value => String(value || "default"),
  rootSessionId: "0",
});

assert.equal(sessionTabs.owns("a", 1), true);
assert.equal(sessionTabs.owns("a", 2), false);
assert.equal(sessionTabs.findOwner(2)?.sessionId, "b");

const foreign = await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 2 });
assert.equal(foreign.ok, false);
assert.equal(foreign.code, "SESSION_TAB_FOREIGN");
assert.equal(runtimes.get("a").workingTabId, 1);

const readOnlyForeign = await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 2, readOnly: true });
assert.equal(readOnlyForeign.ok, true);
assert.equal(readOnlyForeign.readOnlyAccess, true);
assert.equal(readOnlyForeign.ownerSessionId, "b");

const checkOnlyFree = await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 4, checkOnly: true });
assert.equal(checkOnlyFree.claimRequired, true);
assert.equal(sessionTabs.findOwner(4), null);

const claimed = await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 4 });
assert.equal(claimed.claimed, true);
assert.deepEqual(getOwnedTabIds(runtimes.get("a")), [1, 4]);
assert.equal(runtimes.get("a").workingTabId, 4);
assert.equal(runtimes.get("a").visitedTaskSites[0].url, "https://free.example/page");

tabs.set(10, { id: 10, url: "about:blank", title: "", windowId: 1, active: false, pinned: false, groupId: -1 });
tabs.set(11, { id: 11, url: "about:blank", title: "", windowId: 1, active: false, pinned: false, groupId: -1 });
tabs.set(12, { id: 12, url: "chrome://settings", title: "Settings", windowId: 1, active: false, pinned: false, groupId: -1 });
runtimes.set("blank-owner", { sessionId: "blank-owner", ownedTabIds: [10, 12], workingTabId: 10 });

const ordinaryBlank = await sessionTabs.resolveTargetTab({
  sessionId: "blank-owner",
  tabId: 10,
  checkOnly: true,
});
assert.equal(ordinaryBlank.ok, false);
assert.equal(ordinaryBlank.code, "SESSION_TAB_NOT_WEB");

const ownedPreNavigationBlank = await sessionTabs.resolveTargetTab({
  sessionId: "blank-owner",
  tabId: 10,
  checkOnly: true,
  allowPreNavigationBlank: true,
});
assert.equal(ownedPreNavigationBlank.ok, true);
assert.equal(ownedPreNavigationBlank.ownedByCurrentTask, true);

const unownedPreNavigationBlank = await sessionTabs.resolveTargetTab({
  sessionId: "blank-owner",
  tabId: 11,
  checkOnly: true,
  allowPreNavigationBlank: true,
});
assert.equal(unownedPreNavigationBlank.ok, false);
assert.equal(unownedPreNavigationBlank.code, "SESSION_TAB_NOT_WEB");

const foreignPreNavigationBlank = await sessionTabs.resolveTargetTab({
  sessionId: "a",
  tabId: 10,
  checkOnly: true,
  allowPreNavigationBlank: true,
});
assert.equal(foreignPreNavigationBlank.ok, false);

const nonBlankInternalPage = await sessionTabs.resolveTargetTab({
  sessionId: "blank-owner",
  tabId: 12,
  checkOnly: true,
  allowPreNavigationBlank: true,
});
assert.equal(nonBlankInternalPage.ok, false);
assert.equal(nonBlankInternalPage.code, "SESSION_TAB_NOT_WEB");

// Readiness admission is limited to owned loading blanks and never replaces the
// working page. Strict resolution still rejects them before document commit.
const beforeLoadingAdmission = structuredClone(runtimes.get("blank-owner"));
for (const url of ["", "about:blank"]) {
  tabs.set(10, { ...tabs.get(10), url, status: "loading" });
  for (const readOnly of [false, true]) {
    const loading = await sessionTabs.resolveTargetTab({
      sessionId: "blank-owner", tabId: 10, readOnly, allowLoadingBlank: true,
    });
    assert.equal(loading.ok, true);
    assert.equal(loading.ownedByCurrentTask, true);
    assert.deepEqual(runtimes.get("blank-owner"), beforeLoadingAdmission);
    assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "blank-owner", tabId: 10, readOnly })).code, "SESSION_TAB_NOT_WEB");
    assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 10, readOnly, allowLoadingBlank: true })).code, "SESSION_TAB_NOT_WEB");
    tabs.set(11, { ...tabs.get(11), url, status: "loading" });
    assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "blank-owner", tabId: 11, readOnly, allowLoadingBlank: true })).code, "SESSION_TAB_NOT_WEB");
  }
}
tabs.set(10, { ...tabs.get(10), url: "about:blank", status: "complete" });
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "blank-owner", tabId: 10, allowLoadingBlank: true })).code, "SESSION_TAB_NOT_WEB");
tabs.set(12, { ...tabs.get(12), status: "loading" });
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "blank-owner", tabId: 12, allowLoadingBlank: true })).code, "SESSION_TAB_NOT_WEB");

tabs.set(13, {
  id: 13,
  url: "about:blank",
  pendingUrl: "https://pending.example/start",
  title: "",
  windowId: 1,
  active: false,
  pinned: false,
  groupId: -1,
});
await sessionTabs.updateWorkingTab({
  sessionId: "pending-owner",
  tab: { ...tabs.get(13), url: "https://pending.example/start" },
  source: "tool:open_tab:created",
  toolName: "open_tab",
  createdTab: true,
  claim: true,
});
await sessionTabs.syncGroup("pending-owner");
assert.equal(sessionTabs.owns("pending-owner", 13), true, "group reconciliation must retain a tab navigating away from about:blank");
const pendingWorking = await sessionTabs.getWorkingTabContext("pending-owner");
assert.equal(pendingWorking?.id, 13);
assert.equal(pendingWorking?.url, "https://pending.example/start");
const implicitPendingTarget = await sessionTabs.resolveTargetTab({ sessionId: "pending-owner" });
assert.equal(implicitPendingTarget.ok, true, "an omitted tabId must still resolve to the navigating working tab");
assert.equal(implicitPendingTarget.tabId, 13);

runtimes.delete("blank-owner");
runtimes.delete("pending-owner");
tabs.delete(10);
tabs.delete(11);
tabs.delete(12);
tabs.delete(13);

await sessionTabs.handleTabRemoved(4);
assert.equal(runtimes.get("a").workingTabId, null);
assert.deepEqual(getOwnedTabIds(runtimes.get("a")), [1]);
assert.equal(broadcasts.at(-1).action, "working_tab");
assert.equal(persisted.length > 0, true);

tabs.set(400, webTab(400, "https://screen-action.example/page"));
await sessionTabs.updateWorkingTab({
  sessionId: "a",
  tab: tabs.get(400),
  source: "tool:act_on_screen",
  toolName: "act_on_screen",
});
assert.equal(sessionTabs.owns("a", 400), true, "screen actions should claim a mutated tab for the current task");
await sessionTabs.handleTabRemoved(400);

tabs.set(5, webTab(5, "https://contended.example/page"));
const contended = await Promise.all([
  sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 5 }),
  sessionTabs.resolveTargetTab({ sessionId: "b", tabId: 5 }),
]);
assert.equal(contended.filter(result => result.ok && result.claimed).length, 1);
assert.equal(contended.filter(result => !result.ok && result.code === "SESSION_TAB_FOREIGN").length, 1);
const contendedOwners = ["a", "b"].filter(sessionId => getOwnedTabIds(runtimes.get(sessionId)).includes(5));
assert.equal(contendedOwners.length, 1, "a contended tab must have exactly one linearized owner");
await sessionTabs.handleTabRemoved(5);

const createdBeforeRestore = created.length;
const restored = await sessionTabs.restoreOwnedTabs({
  sessionId: "imported",
  tabs: [
    { title: "Search", url: "https://restore.example/search?q=work", working: false },
    { title: "Imported workspace", url: "https://restore.example/work#state", working: true },
    { title: "Second copy", url: "https://restore.example/search?q=work", working: false },
  ],
});
assert.equal(restored.restored, true);
assert.equal(restored.restoredCount, 3);
assert.equal(restored.failedCount, 0);
assert.equal(restored.workingTabRestored, true);
assert.ok(restored.tabs.every(tab => tab.url), "restore should finish from created tab ids without waiting for page load");
assert.deepEqual(
  created.slice(createdBeforeRestore).map(item => ({ windowId: item.windowId, url: item.url, active: item.active })),
  [
    { windowId: 7, url: "https://restore.example/search?q=work", active: false },
    { windowId: 7, url: "https://restore.example/work#state", active: false },
    { windowId: 7, url: "https://restore.example/search?q=work", active: false },
  ],
  "all owned tabs, including duplicate URLs, should be reopened as inactive tabs",
);
assert.equal(runtimes.get("imported").workingTabId, restored.tabs[1].id);
assert.deepEqual(getOwnedTabIds(runtimes.get("imported")), restored.tabs.map(tab => tab.id));
assert.equal(runtimes.get("imported").workingUrl, "https://restore.example/work#state");

const createdBeforeCappedRestore = created.length;
const cappedRestore = await sessionTabs.restoreOwnedTabs({
  sessionId: "capped-import",
  tabs: Array.from({ length: 35 }, (_item, index) => ({
    title: `Page ${index + 1}`,
    url: `https://capped.example/page/${index + 1}`,
    working: index === 34,
  })),
});
assert.equal(cappedRestore.restored, true);
assert.equal(cappedRestore.requested, 30);
assert.equal(cappedRestore.restoredCount, 30);
assert.equal(created.length - createdBeforeCappedRestore, 30, "restore must create at most 30 browser tabs");
assert.equal(runtimes.get("capped-import").workingUrl, "https://capped.example/page/35");
await sessionTabs.closeOwnedTabs("capped-import", { source: "test_cleanup" });

const tabCountBeforeBlockedRestore = tabs.size;
guardrails = {
  rules: [{
    id: "block-private",
    action: "block",
    type: "domain",
    value: "blocked.example",
  }],
};
const blockedRestore = await sessionTabs.restoreOwnedTabs({
  sessionId: "blocked-import",
  tabs: [{ title: "Blocked", url: "https://blocked.example/private", working: true }],
});
assert.equal(blockedRestore.restored, false);
assert.equal(blockedRestore.code, "SECURITY_GUARDRAIL_BLOCKED");
assert.equal(tabs.size, tabCountBeforeBlockedRestore);
assert.equal(runtimes.has("blocked-import"), false);

const partialRestore = await sessionTabs.restoreOwnedTabs({
  sessionId: "partial-import",
  tabs: [
    { title: "Blocked working page", url: "https://blocked.example/work", working: true },
    { title: "Safe page", url: "https://safe.example/reference", working: false },
  ],
});
assert.equal(partialRestore.restored, true);
assert.equal(partialRestore.restoredCount, 1);
assert.equal(partialRestore.failedCount, 1);
assert.equal(partialRestore.workingTabRestored, false);
assert.deepEqual(getOwnedTabIds(runtimes.get("partial-import")), [partialRestore.tabs[0].id]);
assert.equal(runtimes.get("partial-import").workingTabId, undefined);

guardrails = {};
failPersist = true;
const tabCountBeforeFailedCommit = tabs.size;
const failedCommit = await sessionTabs.restoreOwnedTabs({
  sessionId: "failed-import",
  tabs: [
    { title: "Rollback one", url: "https://rollback.example/work", working: true },
    { title: "Rollback two", url: "https://rollback.example/reference", working: false },
  ],
});
failPersist = false;
assert.equal(failedCommit.restored, false);
assert.equal(failedCommit.code, "SESSION_OWNED_TABS_RESTORE_FAILED");
assert.equal(tabs.size, tabCountBeforeFailedCommit, "tabs opened before a failed ownership commit must be closed");
assert.equal(runtimes.get("failed-import").workingTabId, null);
assert.deepEqual(getOwnedTabIds(runtimes.get("failed-import")), []);

const rootClose = await sessionTabs.closeOwnedTabsAfterTerminal("a");
assert.deepEqual(rootClose, { closed: [], skipped: true });
const childClose = await sessionTabs.closeOwnedTabsAfterTerminal("child");
assert.equal(childClose.skipped, false);
assert.deepEqual(childClose.closed, [3]);
assert.equal(removed.at(-1), 3);
assert.deepEqual(getOwnedTabIds(runtimes.get("child")), []);

assert.equal(normalizeWorkingTab({ id: 0, url: "https://invalid.example" }), null);
assert.equal(normalizeWorkingTab({ id: 5, url: "chrome://settings" }), null);
assert.deepEqual(
  normalizeVisitedTaskSites([
    { id: 1, url: "https://example.com/a#one" },
    { id: 2, url: "https://example.com/a#two" },
  ]).map(item => item.url),
  ["https://example.com/a"],
);

console.log("session tabs ownership tests passed");

function webTab(id, url) {
  return { id, url, title: `Tab ${id}`, windowId: 1, active: id === 1, pinned: false, groupId: -1 };
}

function createMemoryStorage() {
  const values = {};
  return {
    async get(key) {
      if (typeof key === "string") return { [key]: values[key] };
      return { ...values };
    },
    async set(patch) {
      Object.assign(values, patch);
    },
    async remove(key) {
      delete values[key];
    },
  };
}

// File content needs Chrome's toggle; tab management only needs task ownership.
const localUrl = "file:///tmp/local%20report.html";
tabs.set(80, webTab(80, localUrl));
runtimes.set("local", { sessionId: "local", workingTabId: 80, ownedTabIds: [80] });
let fileAllowed = false;
globalThis.chrome = { extension: { isAllowedFileSchemeAccess: async () => fileAllowed } };
assert.equal(normalizeWorkingTab(tabs.get(80)).url, localUrl);
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "local", tabId: 80 })).code, "FILE_ACCESS_REQUIRED");
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "local", tabId: 80, tabOnly: true })).ok, true);
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 80, tabOnly: true })).code, "SESSION_TAB_FOREIGN");
fileAllowed = true;
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "local", tabId: 80 })).ok, true);
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 80 })).code, "SESSION_TAB_FOREIGN");
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "a", tabId: 80, readOnly: true })).ok, true);
chrome.extension.isAllowedFileSchemeAccess = async () => { throw new Error("unavailable"); };
assert.equal((await sessionTabs.resolveTargetTab({ sessionId: "local", tabId: 80 })).code, "FILE_ACCESS_REQUIRED");

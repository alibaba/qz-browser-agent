import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionTabs } from "../../src/background/session/tabs.js";
import { navigationDocuments } from "../support/navigation-documents.mjs";

const navigation = navigationDocuments();

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { resolve, promise }; };
const tab = { id: 7, url: "https://example.test/", title: "Page", windowId: 1 };
let readTab = async () => tab;
globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return readTab(id); },
    onUpdated: { addListener() {}, removeListener() {} },
    async update(id, { url }) { navigation.commit(id); return { id, url }; } },
  scripting: { async executeScript({ target }) { return navigation.result(target.tabId); } },
};
const tools = await import("../../src/background/tools/runtime.js");
tools.defineTool({ name: "__working_tab_authority", description: "test", parameters: { type: "object", properties: { tabId: { type: "number" } } },
  execute: () => ({ tabId: tab.id }),
});

function fixture({ ready } = {}) {
  let subscriber;
  const supervisor = createSessionSupervisor({ createAgent: () => ({
    subscribe(listener) { subscriber = listener; return () => {}; }, abort() {}, exportSession: () => [],
  }) });
  let writes = 0;
  const tabs = createSessionTabs({ supervisor, tabsApi: globalThis.chrome.tabs, ready,
    storage: globalThis.chrome.storage.local, getSessions: async () => ({}), isAutomationSessionFamily: () => false,
    setRuntime(id, patch) { writes++; return supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }); },
    persistRuntime: async () => {}, ensureTabGroupForWindow: async () => null,
  });
  const runtime = tools.createToolRuntime({
    sessions: { resolveTargetTab: tabs.resolveTargetTab, isRunCurrent: supervisor.isRunCurrent, updateWorkingTab: tabs.updateWorkingTab, clearWorkingTab: tabs.clearWorkingTab },
    windowTarget: { resolveForNewTab: async () => 1 },
  });
  async function start(runId, ownedTabIds = [tab.id]) {
    const entry = supervisor.getEntry("s"); await entry.ready;
    subscriber({ type: "agent_start", runId });
    supervisor.setRuntime("s", { status: "running", runId, ownedTabIds });
  }
  return { supervisor, tabs, runtime, start, writes: () => writes };
}

for (const terminal of ["stop", "delete"]) {
  test(`${terminal} during the final tab read prevents a late working-tab write; a new run recovers`, async () => {
    const f = fixture(); await f.start("old");
    const entered = deferred(), release = deferred(); let reads = 0;
    readTab = async () => { if (++reads === 2) { entered.resolve(); await release.promise; } return tab; };
    const pending = f.runtime.execute("__working_tab_authority", { tabId: tab.id }, undefined, { sessionId: "s", runId: "old" });
    await entered.promise;
    // Use Supervisor authority without aborting a caller signal: stale run identity alone must deny the write.
    if (terminal === "delete") await f.supervisor.remove("s");
    else {
      await f.supervisor.revoke("s");
      f.supervisor.setRuntime("s", { status: "stopped", runId: "old" });
    }
    release.resolve(); await pending;
    assert.equal(f.writes(), 0);
    if (terminal === "delete") assert.equal(f.supervisor.peekEntry("s"), null, "a tool cannot recreate a deleted Session handle");
    else assert.deepEqual(f.supervisor.getRuntime("s"), { status: "stopped", runId: "old" });
    await f.start("new"); readTab = async () => tab;
    await f.runtime.execute("__working_tab_authority", { tabId: tab.id }, undefined, { sessionId: "s", runId: "new" });
    assert.equal(f.writes(), 1);
    assert.equal(f.supervisor.getRuntime("s").workingTabId, tab.id);
    await f.tabs.clearWorkingTab({ sessionId: "s", runId: "old", tabId: tab.id });
    assert.equal(f.writes(), 1, "an old run cannot clear a new run's tab");
    await f.tabs.clearWorkingTab({ sessionId: "s", tabId: tab.id });
    assert.equal(f.supervisor.getRuntime("s").workingTabId, null, "explicit UI cleanup still works without a run");
  });
}

for (const terminal of ["stop", "delete"]) {
  test(`${terminal} while Chrome creates a tab cannot claim it or revive Session state`, async () => {
    const f = fixture(); await f.start("old");
    const entered = deferred(), release = deferred();
    const created = { id: 8, url: "https://example.test/created", title: "Created", windowId: 1 };
    const removed = [];
    globalThis.chrome.tabs.create = async () => { entered.resolve(); await release.promise; return created; };
    globalThis.chrome.tabs.remove = async id => { removed.push(id); };
    readTab = async id => id === created.id ? created : tab;
    const pending = f.runtime.execute("open_tab", { url: created.url }, undefined, { sessionId: "s", runId: "old" });
    const rejected = assert.rejects(pending, error => error.code === "OPERATION_ABORTED");
    await entered.promise;
    if (terminal === "delete") await f.supervisor.remove("s");
    else {
      await f.supervisor.revoke("s");
      f.supervisor.setRuntime("s", { status: "stopped", runId: "old" });
    }
    release.resolve(); await rejected;
    assert.equal(f.writes(), 0, "late creation must not reach a Session write");
    assert.deepEqual(removed, [created.id], "the newly created unclaimed tab is cleaned up");
    if (terminal === "delete") assert.equal(f.supervisor.peekEntry("s"), null);
    else assert.deepEqual(f.supervisor.getRuntime("s"), { status: "stopped", runId: "old" });
    await f.start("new");
    await f.runtime.execute("open_tab", { url: created.url }, undefined, { sessionId: "s", runId: "new" });
    assert.equal(f.supervisor.getRuntime("s").workingTabId, created.id);
    assert.ok(f.supervisor.getRuntime("s").ownedTabIds.includes(created.id));
  });
}

let ownedExecutions = 0;
tools.defineTool({ name: "__owned_page_authority", description: "test", parameters: {
  type: "object", properties: { tabId: { type: "number" } },
}, page: "owned", execute: ({ tabId }) => { ownedExecutions++; return { tabId }; } });

for (const phase of ["ready", "tab-read"]) {
  for (const terminal of ["stop", "delete", "abort"]) {
    for (const owned of [false, true]) {
      test(`${terminal} during ${phase} cannot resolve a ${owned ? "owned" : "unowned"} page target`, async () => {
        const entered = deferred(), release = deferred();
        const f = fixture({ ready: async () => { if (phase === "ready") { entered.resolve(); await release.promise; } } });
        await f.start("old", owned ? [tab.id] : []);
        readTab = async () => { if (phase === "tab-read") { entered.resolve(); await release.promise; } return tab; };
        const executionsBefore = ownedExecutions;
        const controller = new AbortController();
        const pending = f.runtime.execute("__owned_page_authority", { tabId: tab.id }, controller.signal, { sessionId: "s", runId: "old" });
        const rejected = assert.rejects(pending, error => error.code === "OPERATION_ABORTED");
        await entered.promise;
        if (terminal === "delete") await f.supervisor.remove("s");
        else if (terminal === "abort") controller.abort();
        else {
          await f.supervisor.revoke("s");
          f.supervisor.setRuntime("s", { status: "stopped", runId: "old" });
        }
        const terminalRuntime = f.supervisor.getRuntime("s");
        release.resolve(); await rejected;
        assert.equal(f.writes(), 0, "resolution must not claim a tab or write its metadata after authority is lost");
        assert.equal(ownedExecutions, executionsBefore, "a stale resolved target cannot reach the tool handler");
        assert.deepEqual(f.supervisor.getRuntime("s"), terminalRuntime);
        if (terminal === "delete") assert.equal(f.supervisor.peekEntry("s"), null);
        if (terminal === "abort") await f.supervisor.revoke("s");
        await f.start("new", owned ? [tab.id] : []);
        readTab = async () => tab;
        await f.runtime.execute("__owned_page_authority", { tabId: tab.id }, undefined, { sessionId: "s", runId: "new" });
        assert.equal(ownedExecutions, executionsBefore + 1);
        assert.equal(f.supervisor.getRuntime("s").workingTabId, tab.id);
        assert.ok(f.supervisor.getRuntime("s").ownedTabIds.includes(tab.id));
      });
    }
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionTabs } from "../../src/background/session/tabs.js";

const tabA = { id: 7, url: "https://example.test/a", title: "A", windowId: 1 };
const tabB = { id: 8, url: "https://example.test/b", title: "B", windowId: 1 };
const tabsById = new Map([[tabA.id, tabA], [tabB.id, tabB]]);
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

globalThis.chrome = {
  runtime: { getURL: path => path, id: "test" },
  storage: { local: { async get() { return {}; }, async set() {} } },
  tabs: {
    async get(id) { return tabsById.get(id); },
    async sendMessage(tabId, message) {
      if (message?.action === "ping") return { ok: true };
      if (message?.action === "listImageElements") {
        const tab = tabsById.get(tabId);
        return {
          ok: true, count: 1, scanned: 1, pageUrl: tab.url, pageTitle: tab.title,
          images: [{
            index: 0, selector: "img.only", src: "https://example.test/b.png",
            currentSrc: "https://example.test/b.png", alt: "Bee", title: "",
            naturalWidth: 8, naturalHeight: 8, visible: true,
          }],
        };
      }
      if (message?.action === "readImageElement") {
        return {
          ok: true, selector: "img.only", src: "https://example.test/b.png",
          currentSrc: "https://example.test/b.png", alt: "Bee", dataUrl: png,
          mimeType: "image/png", width: 1, height: 1, method: "canvas",
        };
      }
      return { ok: true };
    },
  },
  scripting: { async executeScript() { return [{ result: null }]; } },
};

const tools = await import("../../src/background/tools/runtime.js");

function fixture() {
  let subscriber;
  const supervisor = createSessionSupervisor({ createAgent: () => ({
    subscribe(listener) { subscriber = listener; return () => {}; }, abort() {}, exportSession: () => [],
  }) });
  const sessionTabs = createSessionTabs({
    supervisor, tabsApi: globalThis.chrome.tabs, storage: globalThis.chrome.storage.local,
    getSessions: async () => ({}), isAutomationSessionFamily: () => false,
    setRuntime(id, patch) { return supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }); },
    persistRuntime: async () => {}, ensureTabGroupForWindow: async () => null,
  });
  const runtime = tools.createToolRuntime({
    sessions: {
      resolveTargetTab: sessionTabs.resolveTargetTab,
      isRunCurrent: supervisor.isRunCurrent,
      updateWorkingTab: sessionTabs.updateWorkingTab,
      clearWorkingTab: sessionTabs.clearWorkingTab,
      listOwnedTabIds(sessionId) {
        const ids = supervisor.getRuntime(sessionId)?.ownedTabIds;
        return Array.isArray(ids) ? ids : [];
      },
    },
    windowTarget: { resolveForNewTab: async () => 1 },
  });
  return { supervisor, sessionTabs, runtime, start(runId, ownedTabIds) {
    subscriber({ type: "agent_start", runId });
    supervisor.setRuntime("s", { status: "running", runId, ownedTabIds });
  } };
}

test("read_image on an unclaimed tab leaves the working tab in place", async () => {
  const f = fixture();
  await f.supervisor.getEntry("s").ready;
  f.start("run", [tabA.id]);
  await f.sessionTabs.updateWorkingTab({
    sessionId: "s", runId: "run",
    tab: { id: tabA.id, url: tabA.url, title: tabA.title },
    source: "test",
  });
  const listed = await f.runtime.execute("list_images", { tabId: tabB.id }, undefined, { sessionId: "s", runId: "run" });
  assert.equal(listed.code, undefined, JSON.stringify(listed));
  assert.equal(f.supervisor.getRuntime("s").workingTabId, tabA.id, "listing an unclaimed tab stays on A");
  const read = await f.runtime.execute("read_image", { target: listed.images[0].target }, undefined, { sessionId: "s", runId: "run" });
  assert.equal(read.code, undefined, JSON.stringify({ code: read.code, error: read.error, message: read.message }));
  assert.equal(read.tabId, tabB.id);
  assert.equal(f.supervisor.getRuntime("s").workingTabId, tabA.id, "a read-only uid on unclaimed tab B must leave the working tab on A");

  const current = f.supervisor.getRuntime("s");
  f.supervisor.setRuntime("s", { ...current, ownedTabIds: [tabA.id, tabB.id], workingTabId: tabA.id });
  const owned = await f.runtime.execute("read_image", { target: listed.images[0].target }, undefined, { sessionId: "s", runId: "run" });
  assert.equal(owned.code, undefined, JSON.stringify({ code: owned.code, error: owned.error, message: owned.message }));
  assert.equal(f.supervisor.getRuntime("s").workingTabId, tabB.id, "a claimed tab still becomes the working tab");
});

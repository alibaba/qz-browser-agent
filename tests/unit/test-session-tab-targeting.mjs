import assert from "node:assert/strict";
import { navigationDocuments } from "../support/navigation-documents.mjs";

const navigation = navigationDocuments();

const storageData = {};
const state = {
  queryCalls: [],
  sendMessages: [],
  resolveCalls: [],
  scriptInjections: [],
  tabUpdates: [],
  events: [],
  workingTabUpdates: [],
  rejectedRunIds: new Set(),
  tabs: [
    { id: 1, windowId: 1, title: "Owned", url: "https://owned.example/a", active: false, pinned: false },
    { id: 2, windowId: 1, title: "Foreign Active", url: "https://foreign.example/a", active: true, pinned: false },
    { id: 3, windowId: 1, title: "Unowned", url: "https://unowned.example/a", active: false, pinned: false },
  ],
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(
            Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]),
          );
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach(item => delete storageData[item]);
      },
    },
  },
  tabs: {
    async query(query = {}) {
      state.queryCalls.push({ ...query });
      let tabs = [...state.tabs];
      if (query.active) tabs = tabs.filter(tab => tab.active);
      if (query.currentWindow) tabs = tabs.filter(tab => tab.currentWindow !== false);
      if (query.windowId != null) tabs = tabs.filter(tab => Number(tab.windowId) === Number(query.windowId));
      return tabs.map(tab => ({ ...tab }));
    },
    async get(tabId) {
      const tab = state.tabs.find(item => Number(item.id) === Number(tabId));
      if (!tab) throw new Error(`missing tab ${tabId}`);
      return { ...tab };
    },
    async update(tabId, patch = {}) {
      const tab = state.tabs.find(item => Number(item.id) === Number(tabId));
      if (!tab) throw new Error(`missing tab ${tabId}`);
      Object.assign(tab, patch);
      state.tabUpdates.push({ tabId: Number(tabId), patch: { ...patch } });
      state.events.push({ type: "tabs.update", tabId: Number(tabId), patch: { ...patch } });
      if (patch.url) { delete tab.pendingUrl; navigation.commit(tabId); }
      return { ...tab };
    },
    async create(props = {}) {
      const nextId = Math.max(...state.tabs.map(tab => tab.id)) + 1;
      const tab = {
        id: nextId,
        windowId: props.windowId || 1,
        title: props.url === "about:blank" ? "about:blank" : "",
        url: props.url || "",
        pendingUrl: props.url || "",
        active: props.active === true,
        pinned: false,
      };
      state.tabs.push(tab);
      state.events.push({ type: "tabs.create", tabId: nextId, props: { ...props } });
      return { ...tab };
    },
    async remove(tabId) {
      const index = state.tabs.findIndex(item => Number(item.id) === Number(tabId));
      if (index >= 0) state.tabs.splice(index, 1);
    },
    async captureVisibleTab() {
      return "data:image/jpeg;base64,c2NyZWVuc2hvdA==";
    },
    async sendMessage(tabId, message = {}, options = {}) {
      state.sendMessages.push({
        tabId: Number(tabId),
        message: { ...message },
        frameId: Number.isInteger(options.frameId) ? options.frameId : null,
      });
      if (message.action === "ping") return { ok: true };
      if (message.action === "readArticle") {
        const tab = state.tabs.find(item => Number(item.id) === Number(tabId));
        return {
          ok: true,
          title: tab?.title || "",
          url: tab?.url || "",
          text: `article:${tabId}`,
          outline: [],
          links: [],
        };
      }
      return { ok: true, action: message.action };
    },
  },
  scripting: {
    async executeScript(details = {}) {
      state.scriptInjections.push(details);
      return details.injectImmediately ? navigation.result(details.target.tabId) : [];
    },
  },
  runtime: {
    onMessage: { addListener() {} },
    sendMessage() {},
  },
  debugger: {
    attach(target = {}) {
      state.events.push({ type: "debugger.attach", tabId: Number(target.tabId) });
    },
    detach() {},
    sendCommand(target = {}, command = "", params = {}) {
      state.events.push({ type: "debugger.sendCommand", tabId: Number(target.tabId), command, params: { ...params } });
      return {};
    },
  },
  bookmarks: {},
  history: {},
  downloads: {},
  windows: { async update() {} },
};

const toolsModule = await import("../../src/background/tools/runtime.js");

const tabOwners = new Map([
  [1, "session-a"],
  [2, "session-b"],
]);

const sessionRuntimeCommands = {
  isRunCurrent(sessionId, runId) {
    const id = String(runId || "").trim();
    return Boolean(String(sessionId || "").trim() && id && !state.rejectedRunIds.has(id));
  },
  async resolveTargetTab({
    sessionId,
    tabId,
    source = "",
    checkOnly = false,
    readOnly = false,
    allowPreNavigationBlank = false,
  }) {
    const targetTabId = Number(tabId);
    state.resolveCalls.push({
      sessionId,
      tabId: targetTabId,
      source,
      checkOnly,
      readOnly,
      allowPreNavigationBlank,
    });
    const owner = tabOwners.get(targetTabId);
    const tab = await chrome.tabs.get(targetTabId);
    const tabUrl = String(tab.url || tab.pendingUrl || "");
    const isOwnedPreNavigationBlank = allowPreNavigationBlank === true
      && tabUrl === "about:blank"
      && owner === sessionId;
    if (!/^https?:\/\//i.test(tabUrl) && !isOwnedPreNavigationBlank) {
      return {
        ok: false,
        code: "SESSION_TAB_NOT_WEB",
        reason: "test_not_web",
        tabId: targetTabId,
        tab,
      };
    }
    if (!owner) {
      if (readOnly) {
        return {
          ok: true,
          reason: "test_readonly_unowned",
          tabId: targetTabId,
          tab: await chrome.tabs.get(targetTabId),
          ownedByCurrentTask: false,
          readOnlyAccess: true,
          claimRequired: true,
        };
      }
      if (checkOnly) {
        return {
          ok: true,
          reason: "test_claimable_unowned",
          tabId: targetTabId,
          tab: await chrome.tabs.get(targetTabId),
          ownedByCurrentTask: false,
          claimRequired: true,
        };
      }
      tabOwners.set(targetTabId, sessionId);
      return {
        ok: true,
        reason: "test_claimed_unowned",
        tabId: targetTabId,
        tab: await chrome.tabs.get(targetTabId),
        ownedByCurrentTask: true,
        claimed: true,
      };
    }
    if (owner !== sessionId) {
      if (readOnly) {
        return {
          ok: true,
          reason: "test_readonly_foreign",
          ownerSessionId: owner,
          tabId: targetTabId,
          tab: await chrome.tabs.get(targetTabId),
          ownedByCurrentTask: false,
          readOnlyAccess: true,
        };
      }
      return {
        ok: false,
        code: "SESSION_TAB_FOREIGN",
        reason: "test_foreign",
        ownerSessionId: owner,
        tabId: targetTabId,
      };
    }
    return {
      ok: true,
      tabId: targetTabId,
      tab: await chrome.tabs.get(targetTabId),
    };
  },
  async updateWorkingTab(update) {
    state.workingTabUpdates.push(update);
    const tabId = Number(update?.tab?.id);
    if (update?.claim === true && Number.isInteger(tabId) && tabId > 0) {
      tabOwners.set(tabId, update.sessionId);
      state.events.push({ type: "session.claim", tabId });
    }
  },
  async clearWorkingTab() {},
};
const newTabWindowRequests = [];
const toolRuntime = toolsModule.createToolRuntime({
  sessions: sessionRuntimeCommands,
  windowTarget: {
    async resolveForNewTab(input) {
      newTabWindowRequests.push({ ...input });
      return 1;
    },
  },
});
const tools = Object.freeze({ ...toolsModule, executeTool: toolRuntime.execute });

function resetCalls() {
  state.queryCalls = [];
  state.sendMessages = [];
  state.resolveCalls = [];
  state.scriptInjections = [];
  state.tabUpdates = [];
  state.events = [];
  state.workingTabUpdates = [];
}

async function assertRejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, expectedCode, err?.stack || err?.message || String(err));
    return true;
  });
}

function sessionA(extra = {}) {
  return { sessionId: "session-a", runId: "run-a", workingTabId: 1, ...extra };
}

resetCalls();
await assertRejectsWithCode(tools.executeTool("read_article", { limit: 4000 }), "SESSION_TAB_TARGET_REQUIRED");
assert.deepEqual(state.queryCalls, [], "missing target must not query active browser tab");
assert.deepEqual(state.sendMessages, [], "missing target must not touch content scripts");

resetCalls();
const foreignArticle = await tools.executeTool("read_article", { tabId: 2, limit: 4000 }, null, sessionA());
assert.equal(foreignArticle.text, "article:2");
assert.equal(foreignArticle._tabId, 2);
assert.deepEqual(
  state.sendMessages.map(item => [item.tabId, item.message.action]),
  [[2, "ping"], [2, "readArticle"]],
  "read-only tools may inspect a foreign tab without claiming it",
);
assert.deepEqual(state.workingTabUpdates, [], "read-only foreign access must not change the session working tab");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("screenshot", { tabId: 2 }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);
assert.equal(state.resolveCalls[0]?.readOnly, false, "screenshots require task ownership because they acquire CDP");
assert.equal(state.events.some(event => event.type === "debugger.attach"), false, "a foreign screenshot must fail before CDP access");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("screenshot", { tabId: 2, actionable: true }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);
assert.equal(state.resolveCalls[0]?.readOnly, false, "actionable screenshots must require task ownership up front");
assert.equal(state.events.some(event => event.type === "debugger.attach"), false, "a foreign actionable screenshot must fail before CDP access");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("get_ax_tree", { tabId: 2 }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);
assert.equal(state.resolveCalls[0]?.readOnly, false, "AX snapshots require task ownership because they acquire CDP");
assert.equal(state.events.some(event => event.type === "debugger.attach"), false);

resetCalls();
state.rejectedRunIds.add("stale-run");
try {
  await assertRejectsWithCode(
    tools.executeTool("screenshot", { tabId: 1 }, null, sessionA({ runId: "stale-run" })),
    "CDP_RUN_RELEASED",
  );
} finally {
  state.rejectedRunIds.delete("stale-run");
}
assert.equal(state.events.some(event => event.type === "debugger.attach"), false, "a stale run must fail before CDP attach");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("screenshot", { tabId: 3, target: "css:body", actionable: true }, null, sessionA()),
  "SCREENSHOT_COORDINATES_UNAVAILABLE",
);
assert.deepEqual(state.resolveCalls, [], "invalid screenshot arguments must fail before target resolution");
assert.equal(tabOwners.has(3), false);
assert.equal(state.events.some(event => event.type === "debugger.attach"), false);

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("act_on_screen", { tabId: 3, action: "click", returnScreenshot: false }, null, sessionA()),
  "MISSING_REQUIRED_ARGUMENTS",
);
assert.deepEqual(state.resolveCalls, [], "action-scoped arguments must fail before target resolution");
assert.equal(tabOwners.has(3), false);
assert.equal(state.events.some(event => event.type === "debugger.attach"), false);

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("act_on_screen", {
    tabId: 3,
    action: "press",
    key: "Hyper+A",
    returnScreenshot: false,
  }, null, sessionA()),
  "INVALID_ARGUMENTS",
);
assert.deepEqual(state.resolveCalls, [], "tool-specific pure validation must run before target resolution");
assert.equal(tabOwners.has(3), false);

resetCalls();
const listedBeforeClaim = await tools.executeTool("list_tabs", {}, null, sessionA());
assert.deepEqual(listedBeforeClaim.map(tab => tab.id), [1, 2, 3]);
assert.deepEqual(listedBeforeClaim.map(tab => tab.usable), [true, false, true]);
assert.deepEqual(listedBeforeClaim.map(tab => tab.readOnlyUsable), [true, true, true]);
assert.deepEqual(listedBeforeClaim.map(tab => tab.ownedByCurrentTask), [true, false, false]);
assert.equal(listedBeforeClaim[0].isWorkingTab, true);
assert.equal(listedBeforeClaim[1].unusableCode, "SESSION_TAB_FOREIGN");
assert.equal(listedBeforeClaim[2].claimRequired, true);
assert.equal(listedBeforeClaim[1].active, true, "list_tabs should still reveal the user's visible page");
assert.deepEqual(state.queryCalls, [{}], "list_tabs may inspect all tabs but must label usability");
assert.deepEqual(
  state.resolveCalls.map(item => [item.tabId, item.checkOnly, item.readOnly]),
  [[1, true, false], [2, true, false], [3, true, false]],
  "list_tabs should use read-only ownership checks",
);
assert.deepEqual(state.workingTabUpdates, [], "list_tabs must not change the session working tab");

resetCalls();
const article = await tools.executeTool("read_article", { limit: 4000 }, null, sessionA());
assert.equal(article.text, "article:1");
assert.equal(article._tabId, 1);
assert.deepEqual(
  state.sendMessages.map(item => [item.tabId, item.message.action]),
  [[1, "ping"], [1, "readArticle"]],
  "owned working tab should be the only page messaging target",
);
assert.ok(state.sendMessages.every(item => item.frameId === 0), "page messages stay on the main frame");
assert.deepEqual(state.queryCalls, [], "owned working tab path should not query active browser tab");

resetCalls();
const current = await tools.executeTool("get_working_tab", {}, null, sessionA());
assert.equal(current.hasWorkingTab, true);
assert.equal(current.id, 1);
assert.equal(current.title, "Owned");
assert.deepEqual(state.queryCalls, [], "get_working_tab means session working tab, not browser active tab");

resetCalls();
const missingWorking = await tools.executeTool("get_working_tab", {}, null, sessionA({ workingTabId: null }));
assert.deepEqual(missingWorking, { hasWorkingTab: false });
assert.deepEqual(state.queryCalls, [], "missing working tab is a normal getter result and must not query the active browser tab");
assert.deepEqual(state.resolveCalls, [], "missing working tab should not enter tab ownership resolution");

resetCalls();
const unownedArticle = await tools.executeTool("read_article", { tabId: 3, limit: 4000 }, null, sessionA());
assert.equal(unownedArticle.text, "article:3");
assert.deepEqual(
  state.sendMessages.map(item => [item.tabId, item.message.action]),
  [[3, "ping"], [3, "readArticle"]],
  "read-only tools may inspect an unowned tab without claiming it",
);
assert.equal(tabOwners.get(3), undefined);
assert.deepEqual(state.workingTabUpdates, [], "read-only unowned access must not change the session working tab");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("use_tab", { tabId: 2 }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);
assert.deepEqual(state.tabUpdates, [], "use_tab must not activate or otherwise mutate a foreign visible tab");
assert.deepEqual(state.workingTabUpdates, [], "use_tab must not transfer a tab owned by another session");

resetCalls();
const switched = await tools.executeTool("use_tab", { tabId: 3 }, null, sessionA());
assert.equal(switched.tabId, 3);
assert.equal(switched.active, false);
assert.equal(switched.visibleChanged, false);
assert.deepEqual(
  state.resolveCalls.map(item => [item.tabId, item.checkOnly, item.readOnly]),
  [[3, false, false]],
  "use_tab should resolve ownership through the central tab gate",
);
assert.deepEqual(state.tabUpdates, [], "use_tab should not activate or otherwise mutate the user's visible tab");
assert.equal(tabOwners.get(3), "session-a");
assert.equal(state.workingTabUpdates[0]?.sessionId, "session-a");
assert.equal(state.workingTabUpdates[0]?.toolName, "use_tab");
assert.equal(state.workingTabUpdates[0]?.claim, true);

resetCalls();
const openedWithWatch = await tools.executeTool("open_tab", {
  url: "https://fresh.example/start",
  watchNetwork: true,
  networkMaxRecords: 50,
}, null, sessionA());
assert.equal(openedWithWatch.url, "https://fresh.example/start");
assert.equal(openedWithWatch._pageUrl, "https://fresh.example/start");
assert.notEqual(openedWithWatch._pageTitle, "about:blank");
assert.equal(openedWithWatch.networkWatch?.startedBeforeNavigation, true);
assert.equal(openedWithWatch.networkWatch?.maxRecords, 50);
assert.equal(
  state.resolveCalls.find(call => call.source === "cdp:run")?.allowPreNavigationBlank,
  true,
  "open_tab pre-navigation Network setup should authorize only its owned temporary about:blank tab",
);
assert.deepEqual(newTabWindowRequests.at(-1), { anchorTabId: 1, sourceWindowId: undefined });
assert.equal(state.events.find(item => item.type === "tabs.create")?.props?.windowId, 1);
assert.deepEqual(
  state.events.map(item => item.type === "debugger.sendCommand" ? `${item.type}:${item.command}` : `${item.type}:${item.props?.url || item.patch?.url || ""}`),
  [
    "tabs.create:about:blank",
    "session.claim:",
    "debugger.attach:",
    "debugger.sendCommand:Network.enable",
    "tabs.update:https://fresh.example/start",
  ],
  "open_tab watchNetwork should enable Network before navigating the new tab",
);

resetCalls();
const tabIdsBeforeFailedClaim = state.tabs.map(tab => tab.id);
const updateWorkingTab = sessionRuntimeCommands.updateWorkingTab;
sessionRuntimeCommands.updateWorkingTab = async () => { throw new Error("claim failed"); };
try {
  await assert.rejects(
    tools.executeTool("open_tab", { url: "https://claim-failure.example/" }, null, sessionA()),
  );
} finally {
  sessionRuntimeCommands.updateWorkingTab = updateWorkingTab;
}
assert.deepEqual(
  state.tabs.map(tab => tab.id),
  tabIdsBeforeFailedClaim,
  "a newly created tab must be closed if Session ownership cannot be established",
);

resetCalls();
const nav = await tools.executeTool("navigate", { url: "https://owned.example/b" }, null, sessionA());
assert.equal(nav.tabId, 1);
assert.equal(state.tabs.find(tab => tab.id === 1).url, "https://owned.example/b");
assert.deepEqual(state.tabUpdates, [{ tabId: 1, patch: { url: "https://owned.example/b" } }]);
assert.equal(state.workingTabUpdates[0]?.sessionId, "session-a");
assert.equal(state.workingTabUpdates[0]?.toolName, "navigate");

resetCalls();
const watchedNav = await tools.executeTool("navigate", {
  url: "https://owned.example/c",
  watchNetwork: true,
  resetNetwork: true,
  networkMaxRecords: 60,
}, null, sessionA());
assert.equal(watchedNav.tabId, 1);
assert.equal(watchedNav.url, "https://owned.example/c");
assert.equal(watchedNav.networkWatch?.startedBeforeNavigation, true);
assert.equal(watchedNav.networkWatch?.maxRecords, 60);
assert.equal(
  state.resolveCalls.find(call => call.source === "cdp:run")?.allowPreNavigationBlank,
  false,
  "ordinary navigate Network setup should keep the standard web-tab authorization",
);
assert.deepEqual(
  state.events.map(item => item.type === "debugger.sendCommand" ? `${item.type}:${item.command}` : `${item.type}:${item.patch?.url || ""}`),
  [
    "debugger.attach:",
    "debugger.sendCommand:Network.enable",
    "tabs.update:https://owned.example/c",
  ],
  "navigate watchNetwork should enable Network before updating the tab URL",
);

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("run_skill_script", { skill: "demo", script: "scripts/demo.js", timeout: 0 }),
  "SESSION_TAB_TARGET_REQUIRED",
);
assert.deepEqual(state.queryCalls, [], "plugin skill script target fallback must not use active browser tab");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("run_skill_script", { skill: "demo", script: "scripts/demo.js", tabId: 2, timeout: 0 }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);

resetCalls();
const frameRuns = [];
const sendMessage = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (tabId, message = {}, options = {}) => {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : null;
  state.sendMessages.push({ tabId: Number(tabId), message: { ...message }, frameId });
  if (message.action === "ping") return { ok: true };
  // Child frames also have the content script. An unscoped message would run there.
  if (frameId !== 0) {
    frameRuns.push("child");
    return { ok: true, frame: "child", selector: message.selector || "" };
  }
  frameRuns.push("main");
  return { ok: true, frame: "main", selector: message.selector || "", action: message.action };
};
try {
  const inspected = await toolsModule.sendToContent(1, "inspectElement", { selector: "button.hit", index: 0 });
  assert.equal(inspected.frame, "main");
  assert.equal(inspected.selector, "button.hit");
  assert.deepEqual(frameRuns, ["main"], "a css target runs in the main frame when child frames also have the script");
  assert.ok(state.sendMessages.every(item => item.frameId === 0));
  assert.equal(state.sendMessages.some(item => item.message.selector === "button.hit"), true);
} finally {
  chrome.tabs.sendMessage = sendMessage;
}

console.log("session tab targeting behavior tests passed");

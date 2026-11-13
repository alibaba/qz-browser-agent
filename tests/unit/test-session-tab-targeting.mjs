import assert from "node:assert/strict";
import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import { navigationDocuments } from "../support/navigation-documents.mjs";
import { createSessionTabs } from "../../src/background/session/tabs.js";

const navigation = navigationDocuments();
globalThis.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { drawImage() {} }; }
  async convertToBlob({ type }) { return new Blob(['fixture-image'], { type }); }
};

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
    onUpdated: { addListener() {}, removeListener() {} },
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
      if (message.action === "ping") return { ok: true, contentType: "text/html", elementRefs: 1 };
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
      if (details.func?.name === 'documentReadiness') return [{ result: true }];
      if (details.args?.length === 1 && typeof details.args[0] === 'boolean') return [{ result: { width: 800, height: 600, scale: 1 } }];
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
      if (command === 'Runtime.evaluate' && params.expression === 'navigator.userAgent') return { result: { value: 'Chrome/149.0.0.0' } };
      if (command === 'Page.captureScreenshot') return { data: 'c2NyZWVuc2hvdA==' };
      if (command === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1 } };
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'fixture-document' } } };
      if (command === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'root', ignored: false,
        role: { value: 'RootWebArea' }, name: { value: 'Foreign Active' }, backendDOMNodeId: 10, childIds: [] }] };
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
await assertRejectsWithCode(tools.executeTool("read_article", { limit: 4000 }), "TAB_REF_REQUIRED");
assert.deepEqual(state.queryCalls, [], "missing target must not query active browser tab");
assert.deepEqual(state.sendMessages, [], "missing target must not touch content scripts");
for (const externalDrive of [false, true]) {
  resetCalls();
  await assertRejectsWithCode(
    tools.executeTool("read_article", { limit: 4000 }, null, sessionA({ externalDrive })),
    "TAB_REF_REQUIRED",
  );
  assert.deepEqual(state.queryCalls, [], "a legacy working tab or active tab cannot supply the missing tabRef");
  assert.deepEqual(state.sendMessages, []);
  assert.deepEqual(state.resolveCalls, [], "missing explicit identity fails before ownership resolution");
}

resetCalls();
const foreignArticle = await tools.executeTool("read_article", { tabRef: 2, limit: 4000 }, null, sessionA());
assert.equal(foreignArticle.text, "article:2");
assert.equal(foreignArticle._tabId, undefined, "page observations do not expose private browser IDs");
assert.deepEqual(
  state.sendMessages.map(item => [item.tabId, item.message.action]),
  [[2, "ping"], [2, "readArticle"]],
  "read-only tools may inspect a foreign tab without claiming it",
);
assert.deepEqual(state.workingTabUpdates, [], "read-only foreign access must not change the session working tab");

resetCalls();
const foreignScreenshot = await tools.executeTool("screenshot", { tabRef: 2 }, null, sessionA());
assert.match(foreignScreenshot._image, /^data:image\//);
assert.equal(state.resolveCalls[0]?.readOnly, true, "screenshots use the same read-only foreign permission as other page readers");
assert.deepEqual(state.workingTabUpdates, []);
assert.equal(tabOwners.get(2), "session-b");

resetCalls();
const foreignActionable = await tools.executeTool("screenshot", { tabRef: 2, actionable: true }, null, sessionA());
assert.match(foreignActionable._image, /^data:image\//);
assert.equal(state.resolveCalls[0]?.readOnly, true);
assert.deepEqual(state.workingTabUpdates, []);
assert.equal(tabOwners.get(2), "session-b", "a coordinate observation does not grant write ownership");
await assertRejectsWithCode(tools.executeTool("act_on_screen", {
  tabRef: 2, action: "press", key: "Escape", returnScreenshot: false, _readOnlyTabAccess: true,
}, null, sessionA()), "SESSION_TAB_FOREIGN");

resetCalls();
const foreignTree = await tools.executeTool("get_ax_tree", { tabRef: 2 }, null, sessionA());
assert.match(foreignTree.snapshot, /Foreign Active/);
assert.equal(state.resolveCalls[0]?.readOnly, true);
assert.deepEqual(state.workingTabUpdates, []);
assert.equal(tabOwners.get(2), "session-b");

resetCalls();
state.rejectedRunIds.add("stale-run");
try {
  await assertRejectsWithCode(
    tools.executeTool("screenshot", { tabRef: 1 }, null, sessionA({ runId: "stale-run" })),
    "CDP_RUN_RELEASED",
  );
} finally {
  state.rejectedRunIds.delete("stale-run");
}
assert.equal(state.events.some(event => event.type === "debugger.attach"), false, "a stale run must fail before CDP attach");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("screenshot", { tabRef: 3, target: "css:body", actionable: true }, null, sessionA()),
  "SCREENSHOT_COORDINATES_UNAVAILABLE",
);
assert.deepEqual(state.resolveCalls, [], "invalid screenshot arguments must fail before target resolution");
assert.equal(tabOwners.has(3), false);
assert.equal(state.events.some(event => event.type === "debugger.attach"), false);

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("act_on_screen", { tabRef: 3, action: "click", returnScreenshot: false }, null, sessionA()),
  "MISSING_REQUIRED_ARGUMENTS",
);
assert.deepEqual(state.resolveCalls, [], "action-scoped arguments must fail before target resolution");
assert.equal(tabOwners.has(3), false);
assert.equal(state.events.some(event => event.type === "debugger.attach"), false);

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("act_on_screen", {
    tabRef: 3,
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
assert.deepEqual(listedBeforeClaim, {
  tabs: [
    { tabRef: 1, url: "https://owned.example/a", title: "Owned", active: false, ownership: "owned" },
    { tabRef: 3, url: "https://unowned.example/a", title: "Unowned", active: false, ownership: "unclaimed" },
  ],
  count: 2, foreign: 1,
});
assert.deepEqual(state.queryCalls, [{}], "the default scope inspects browser tabs without exposing foreign rows");
assert.deepEqual(
  state.resolveCalls.map(item => [item.tabId, item.checkOnly, item.readOnly]),
  [[1, true, false], [2, true, false], [3, true, false]],
  "list_tabs checks ownership without claiming tabs",
);
assert.deepEqual(state.workingTabUpdates, [], "list_tabs must not change session tab authority");
assert.equal(tabOwners.has(3), false, "listing an unclaimed tab leaves it unclaimed");

resetCalls();
assert.deepEqual(await tools.executeTool("list_tabs", { scope: "owned" }, null, sessionA()), {
  tabs: [{ tabRef: 1, url: "https://owned.example/a", title: "Owned", active: false, ownership: "owned" }],
  count: 1, foreign: 1,
});

resetCalls();
const allTabs = await tools.executeTool("list_tabs", { scope: "all" }, null, sessionA());
assert.deepEqual(allTabs, {
  tabs: state.tabs.map(({ id, url, title, active }) => ({ tabRef: id, url, title, active,
    ownership: ({ 1: "owned", 2: "foreign", 3: "unclaimed" })[id] })),
  count: 3, foreign: 1,
});
assert.equal(allTabs.tabs[1].active, true, "active describes the user's visible page, including a foreign tab");
assert.deepEqual(state.workingTabUpdates, [], "all scope must not claim or select a tab");

resetCalls();
const article = await tools.executeTool("read_article", { tabRef: 1, limit: 4000 }, null, sessionA());
assert.equal(article.text, "article:1");
assert.equal(article._tabId, undefined);
assert.equal(article.tabRef, undefined, "ordinary page observations do not echo page identity");
assert.deepEqual(
  state.sendMessages.map(item => [item.tabId, item.message.action]),
  [[1, "ping"], [1, "readArticle"]],
  "the explicit tabRef is the only page messaging target",
);
assert.ok(state.sendMessages.every(item => item.frameId === 0), "page messages stay on the main frame");
assert.deepEqual(state.queryCalls, [], "an explicit page never requires an active-tab query");

for (const name of ["get_working_tab", "use_tab"]) {
  resetCalls();
  await assertRejectsWithCode(tools.executeTool(name, { tabRef: 3 }, null, sessionA()), "UNKNOWN_TOOL");
  assert.equal(toolsModule.getToolSchemas().some(tool => tool.function.name === name), false);
  assert.deepEqual(state.queryCalls, []);
  assert.deepEqual(state.resolveCalls, [], "removed tools cannot enter ownership resolution");
  assert.deepEqual(state.tabUpdates, []);
  assert.deepEqual(state.workingTabUpdates, []);
}

resetCalls();
const unownedArticle = await tools.executeTool("read_article", { tabRef: 3, limit: 4000 }, null, sessionA());
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
  tools.executeTool("navigate", { tabRef: 2, url: "https://foreign.example/b" }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);
assert.deepEqual(state.tabUpdates, [], "an explicit foreign target must fail before navigation or activation");
assert.deepEqual(state.workingTabUpdates, [], "a page action must not transfer another session's tab");

resetCalls();
const claimed = await tools.executeTool("navigate", { tabRef: 3, url: "https://unowned.example/b" }, null, sessionA());
assert.equal(claimed.tabRef, undefined);
assert.deepEqual(
  state.resolveCalls.map(item => [item.tabId, item.checkOnly, item.readOnly]),
  [[3, false, false]],
  "an explicit unowned target resolves ownership through the central tab gate",
);
assert.deepEqual(state.tabUpdates, [{ tabId: 3, patch: { url: "https://unowned.example/b" } }]);
assert.equal(state.tabs.find(tab => tab.id === 2).active, true, "claiming a page keeps the user's visible tab unchanged");
assert.equal(tabOwners.get(3), "session-a");
assert.equal(state.workingTabUpdates[0]?.sessionId, "session-a");
assert.equal(state.workingTabUpdates[0]?.toolName, "navigate");

resetCalls();
const openedWithWatch = await tools.executeTool("open_tab", {
  url: "https://fresh.example/start",
  watchNetwork: true,
  networkMaxRecords: 50,
}, null, sessionA());
assert.equal(openedWithWatch.url, "https://fresh.example/start");
assert.equal(getToolResultPresentation(openedWithWatch)._pageUrl, "https://fresh.example/start");
assert.equal(getToolResultPresentation(openedWithWatch)._pageTitle, openedWithWatch.title, "sidebar metadata uses the observed tab title");
assert.deepEqual(Object.keys(openedWithWatch).sort(), ["active", "tabRef", "title", "url"]);
assert.equal(openedWithWatch.active, false);
assert.equal(state.tabs.find(tab => tab.id === 2).active, true, "opening a page keeps the user's visible tab unchanged");
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
const nav = await tools.executeTool("navigate", { tabRef: 1, url: "https://owned.example/b" }, null, sessionA());
assert.equal(nav.tabRef, undefined);
assert.equal(state.tabs.find(tab => tab.id === 1).url, "https://owned.example/b");
assert.deepEqual(state.tabUpdates, [{ tabId: 1, patch: { url: "https://owned.example/b" } }]);
assert.equal(state.workingTabUpdates[0]?.sessionId, "session-a");
assert.equal(state.workingTabUpdates[0]?.toolName, "navigate");

resetCalls();
const watchedNav = await tools.executeTool("navigate", {
  tabRef: 1,
  url: "https://owned.example/c",
  watchNetwork: true,
  resetNetwork: true,
  networkMaxRecords: 60,
}, null, sessionA());
assert.equal(watchedNav.tabRef, undefined);
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
  "TAB_REF_REQUIRED",
);
assert.deepEqual(state.queryCalls, [], "plugin skill script target fallback must not use active browser tab");

resetCalls();
await assertRejectsWithCode(
  tools.executeTool("run_skill_script", { skill: "demo", script: "scripts/demo.js", tabRef: 2, timeout: 0 }, null, sessionA()),
  "SESSION_TAB_FOREIGN",
);

resetCalls();
const frameRuns = [];
const sendMessage = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (tabId, message = {}, options = {}) => {
  const frameId = Number.isInteger(options.frameId) ? options.frameId : null;
  state.sendMessages.push({ tabId: Number(tabId), message: { ...message }, frameId });
  if (message.action === "ping") return { ok: true, contentType: "text/html", elementRefs: 1 };
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

// Use the real reservation gate: a permissive ownership mock misses run authority
// lost between a deferred open_tab and its pre-navigation CDP setup.
for (const mode of ['desktop', 'mobile']) for (const watchNetwork of [false, true]) {
  const runtimeState = { sessionId: 'first-open', ownedTabIds: [], workingTabId: null };
  const controller = new AbortController();
  const context = { sessionId: 'first-open', runId: 'first-run', deferToolCommit: true, deferCreatedTabSelection: true };
  const isRunCurrent = (sessionId, runId) => sessionId === context.sessionId && runId === context.runId;
  const setRuntime = (_id, patch) => Object.assign(runtimeState, patch);
  const sessions = createSessionTabs({
    supervisor: { getRuntime: id => id === context.sessionId ? runtimeState : null,
      runtimeEntries: () => [[context.sessionId, runtimeState]], setRuntime, isRunCurrent },
    tabsApi: chrome.tabs, storage: chrome.storage.local, setRuntime, persistRuntime: async () => {},
  });
  const cdpChecks = [];
  let cancelAuthorization = false;
  const runtime = toolsModule.createToolRuntime({
    windowTarget: { resolveForNewTab: async () => 1 },
    sessions: { ...sessions, isRunCurrent, async resolveTargetTab(input) {
      if (input.source === 'cdp:run') {
        cdpChecks.push(input);
        if (cancelAuthorization) controller.abort();
      }
      return sessions.resolveTargetTab(input);
    } },
  });
  resetCalls();
  const result = await runtime.execute('open_tab', { url: 'https://first.example/article', mode, watchNetwork }, controller.signal, context);
  assert.deepEqual(Object.keys(result).sort(), ['active', 'tabRef', 'title', 'url']);
  assert.deepEqual(runtimeState.ownedTabIds, [], 'CDP setup must not publish provisional ownership');
  assert.equal(runtimeState.workingTabId, null);
  assert.equal(state.tabs.find(tab => tab.id === result.tabRef)?.url, 'https://first.example/article');
  if (watchNetwork || mode === 'mobile') {
    assert.equal(cdpChecks.length, 1, 'first CDP attachment uses the real Session authorization gate');
    assert.equal(cdpChecks[0].runId, context.runId);
    assert.ok(cdpChecks[0].signal instanceof AbortSignal);
    for (const patch of [{ createdTabReservation: {} }, { runId: 'another-run' }, { sessionId: 'another-session' }]) {
      const denied = await sessions.resolveTargetTab({ ...cdpChecks[0], ...patch });
      assert.equal(denied.ok, false, 'run and private reservation checks remain enforced');
    }
  }
  const navigationIndex = state.events.findIndex(event => event.type === 'tabs.update');
  for (const command of [watchNetwork && 'Network.enable', mode === 'mobile' && 'Emulation.setDeviceMetricsOverride'].filter(Boolean)) {
    const index = state.events.findIndex(event => event.command === command);
    assert.ok(index >= 0 && index < navigationIndex, `${command} must run before navigation`);
  }
  await runtime.commitToolResult(result, controller.signal, context);
  assert.deepEqual(runtimeState.ownedTabIds, [result.tabRef]);
  assert.equal(runtimeState.workingTabId, result.tabRef);

  // Cancellation while the asynchronous tab gate is entered must prevent attach,
  // navigation and ownership publication, even before the run ID is retired.
  resetCalls();
  cancelAuthorization = true;
  const tabsBefore = state.tabs.map(tab => tab.id);
  await assertRejectsWithCode(runtime.execute('open_tab', { url: 'https://first.example/cancel', watchNetwork: true }, controller.signal, context), 'OPERATION_ABORTED');
  assert.deepEqual(state.tabs.map(tab => tab.id), tabsBefore, 'cancelled provisional tab is removed');
  assert.equal(state.events.some(event => event.type === 'debugger.attach' || event.type === 'tabs.update'), false);
  assert.deepEqual(runtimeState.ownedTabIds, [result.tabRef]);
  assert.equal(runtimeState.workingTabId, result.tabRef);
}

console.log("session tab targeting behavior tests passed");

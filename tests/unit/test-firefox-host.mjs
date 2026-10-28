import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installFirefoxDebugger } from "../../src/background/firefox/debugger-host.js";
import { ISOLATED_CONTENT_INVOKE, ISOLATED_CONTENT_PROBE } from "../../src/background/tools/isolated-page-calls.js";
import { installInitiatorRewrite } from "../../src/background/firefox/dnr-initiator.js";
import { installFirefoxHost } from "../../src/background/firefox/host.js";
import { createNetworkWatch } from "../../src/background/firefox/network-watch.js";
import { installNotificationRenewal } from "../../src/background/firefox/notifications.js";
import { installOffscreenHost } from "../../src/background/firefox/offscreen-host.js";
import { jpegsToPdf, jpegSize } from "../../src/background/firefox/pdf-raster.js";
import { stitchTiles } from "../../src/background/firefox/screenshot-image.js";
import { installWorkspacePanel } from "../../src/background/firefox/workspace-panel.js";
import { createChromeNotificationService, createSessionCompletionNotifier } from "../../src/background/services/chrome-notifications.js";
import { createSessionExchangeBridge } from "../../src/background/services/session-exchange-bridge.js";
import { productText } from "../../src/shared/product-text.js";
import { serializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { installSidepanelFirefoxHost } from "../../src/sidepanel/firefox/host.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the firefox boot modules load the host before the shared entries", () => {
  const background = readFileSync(join(repoRoot, "src/background/firefox-boot.ts"), "utf8");
  const panel = readFileSync(join(repoRoot, "src/sidepanel/firefox-boot.ts"), "utf8");
  assert.match(background, /import "\.\/firefox\/host\.js";\s*import "\.\/service-worker\.js";/);
  assert.match(panel, /import "\.\/firefox\/host\.js";\s*import "\.\/sidepanel\.js";/);
});

test("sidebarAction.open runs inside the user-gesture turn", async () => {
  const calls = [];
  const panels = [];
  let updateCalled = false;
  const browser = {
    runtime: { getURL: path => `moz-extension://uuid/${path}` },
    sidebarAction: {
      open() { calls.push("open"); return Promise.resolve(); },
      toggle() { calls.push("toggle"); return Promise.resolve(); },
      setPanel(details) { panels.push(details); return Promise.resolve(); },
    },
    action: { onClicked: { addListener(listener) { browser.clicked = listener; } } },
    windows: { update() { updateCalled = true; return new Promise(() => {}); } },
  };
  installWorkspacePanel(browser, {});
  await browser.sidePanel.open({ windowId: 4, tabId: 9 });
  assert.deepEqual(calls, ["open"]);
  assert.deepEqual(panels, [{ tabId: 9, panel: "moz-extension://uuid/sidepanel/sidepanel.html" }]);
  assert.equal(updateCalled, false);
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.clicked();
  assert.deepEqual(calls, ["open", "toggle"]);
});

test("sidebar open outside a user gesture explains the failure and does not retry", async () => {
  const calls = [];
  const host = {};
  const browser = {
    sidebarAction: {
      open(options) {
        calls.push(options || {});
        return Promise.reject(new Error("sidebarAction.open may only be called from a user input handler"));
      },
    },
    action: { onClicked: { addListener(listener) { browser.clicked = listener; } } },
  };
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    await assert.rejects(
      browser.sidePanel.open({ windowId: 4, tabId: 9 }),
      /Firefox opens the sidebar only from the toolbar button, the sidebar shortcut, or a menu item/,
    );
    assert.deepEqual(calls, [{}]);
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    browser.clicked();
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
  } finally {
    errors.restore();
  }
  assert.match(errors.lines[0], /firefox sidebarAction failed \(api\): sidebarAction\.open may only be called from a user input handler/);
  assert.match(errors.lines[1], /firefox sidebarAction failed \(toolbar\): sidebarAction\.open may only be called from a user input handler/);
  assert.equal(host.qzFirefoxSidebar.attempts, 2);
  assert.equal(host.qzFirefoxSidebar.refused, 2);
  assert.equal(host.qzFirefoxSidebar.lastSource, "toolbar");
});

test("an import outside a user gesture points at the toolbar icon and keeps the imported session", async () => {
  const prompt = sidebarPromptBrowser({ language: "en-US" });
  const { browser, badges, titles, notes, opens, createdTabs, host } = prompt;
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    const bridge = createSessionExchangeBridge({
      sidePanel: browser.sidePanel,
      importSessionExchange: async () => ({ session: { id: "imported", title: "Imported" } }),
      channel: { hasPorts: () => false, broadcast() {}, remember() {} },
      logger: { debug() {} },
      consentAccepted: () => true,
    });
    const payload = createSessionExchangePayload({
      session: { id: "source", title: "Imported" },
      conversation: serializeConversation([{ role: "user", content: "import me" }]),
      transcript: [],
      exportedAt: "2026-07-12 12:00:00",
    });
    const result = await bridge.importFromPage({ payload }, {
      tab: { url: "http://127.0.0.1/export.html", id: 3, windowId: 4 },
    });
    assert.equal(result.session.id, "imported");
    await settle();
    assert.deepEqual(createdTabs, []);
    assert.deepEqual(opens, [0]);
    assert.deepEqual(badges, ["!"]);
    assert.deepEqual(titles, ["qz: click to open the sidebar"]);
    assert.equal(notes[0].id, "qz-open-sidebar");
    assert.equal(Object.hasOwn(notes[0].options, "requireInteraction"), false);
    assert.equal(notes[0].options.message, "Click the qz icon in the toolbar to view.");
    assert.equal(/notification/i.test(notes[0].options.message), false);
    assert.equal(notes[0].options.iconUrl, "moz-extension://uuid/icons/icon128.png");

    bridge.revealForImport({ tab: { id: 3, windowId: 4, url: "http://127.0.0.1/export.html" } });
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    assert.equal(notes.filter(item => item.id).length, 1);

    prompt.click("qz-open-sidebar");
    await settle();
    assert.deepEqual(opens, [0, 0, 0]);
    assert.equal(notes.filter(item => item.id).length, 1, "a notification click never raises another notification");
    assert.equal(notes.at(-1).clear, "qz-open-sidebar");
    assert.equal(badges.at(-1), "!", "the badge stays until the sidebar opens");
    assert.deepEqual(prompt.focused, [4]);
    assert.equal(host.qzFirefoxSidebar.notificationClicks, 1);
    assert.equal(host.qzFirefoxSidebar.lastSource, "notification");
    assert.equal(host.qzFirefoxSidebar.lastError, "sidebarAction.open may only be called from a user input handler");
    assert.match(errors.lines.at(-1), /firefox sidebarAction failed \(notification\): sidebarAction\.open may only be called from a user input handler/);

    prompt.allowOpen = true;
    browser.sidePanel.setPanelBehavior({});
    browser.toolbar();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(opens.at(-1), "toggle");
    assert.equal(badges.at(-1), "");
    assert.equal(titles.at(-1), null);
  } finally {
    errors.restore();
  }
});

test("a sidebar open inside a notification click logs the real error and raises no second notification", async () => {
  const prompt = sidebarPromptBrowser({ language: "en-US" });
  const { browser, badges, titles, notes, host } = prompt;
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    browser.notifications.onClicked.addListener(() => {
      void browser.sidePanel.open({ windowId: 4 }).catch(() => {});
    });
    prompt.click("qz_completed_root_run-1");
    await settle();
    assert.deepEqual(notes, []);
    assert.deepEqual(badges, ["!"]);
    assert.deepEqual(titles, ["qz: click to open the sidebar"]);
    assert.equal(host.qzFirefoxSidebar.refused, 1);
    assert.equal(host.qzFirefoxSidebar.lastSource, "notification");
    assert.equal(host.qzFirefoxSidebar.prompts, 1);
    assert.equal(host.qzFirefoxSidebar.notified, 0);
    assert.match(errors.lines[0], /\(notification\): sidebarAction\.open may only be called from a user input handler/);

    await assert.rejects(browser.sidePanel.open({ windowId: 4 }), /toolbar button/);
    await settle();
    assert.deepEqual(notes, [], "the same prompt is not raised twice");
  } finally {
    errors.restore();
  }
});

test("opening the sidebar by any route clears the badge and lets a later import prompt again", async () => {
  const prompt = sidebarPromptBrowser({ language: "en-US" });
  const { browser, badges, titles, notes, host } = prompt;
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    await assert.rejects(browser.sidePanel.open({ windowId: 4 }), /toolbar button/);
    await settle();
    assert.deepEqual(badges, ["!"]);
    prompt.connect({ name: "sidepanel", sender: { url: "moz-extension://uuid/sidepanel/sidepanel.html", tab: { id: 1 } } });
    prompt.connect({ name: "runtime-request", sender: { url: "moz-extension://uuid/sidepanel/sidepanel.html" } });
    prompt.connect({ name: "sidepanel", sender: { url: "moz-extension://other/sidepanel/sidepanel.html" } });
    assert.deepEqual(badges, ["!"]);
    prompt.connect({ name: "sidepanel", sender: { url: "moz-extension://uuid/sidepanel/sidepanel.html?embedded=1" } });
    assert.deepEqual(badges, ["!", ""]);
    assert.deepEqual(titles, ["qz: click to open the sidebar", null]);
    assert.equal(notes.at(-1).clear, "qz-open-sidebar");

    await assert.rejects(browser.sidePanel.open({ windowId: 4 }), /toolbar button/);
    await settle();
    assert.equal(notes.filter(item => item.id).length, 2);
    assert.equal(badges.at(-1), "!");
    assert.equal(host.qzFirefoxSidebar.prompts, 2);
    assert.equal(host.qzFirefoxSidebar.notified, 2);
  } finally {
    errors.restore();
  }
});

test("a refused open while the sidebar is already showing leaves no badge or notification", async () => {
  const prompt = sidebarPromptBrowser({ language: "en-US" });
  const { browser, badges, notes, host } = prompt;
  prompt.showing = true;
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    await assert.rejects(browser.sidePanel.open({ windowId: 4 }), /toolbar button/);
    prompt.click("qz_completed_root_run-1");
    await settle();
  } finally {
    errors.restore();
  }
  assert.deepEqual(badges, []);
  assert.deepEqual(notes, []);
  assert.equal(host.qzFirefoxSidebar.refused, 1);
  assert.equal(host.qzFirefoxSidebar.prompts, 0);
  assert.equal(host.qzFirefoxSidebar.notificationClicks, 1);
  assert.match(errors.lines[0], /\(api\): sidebarAction\.open may only be called from a user input handler/);
});

test("the sidebar prompt uses Chinese when the Firefox UI language is Chinese", async () => {
  const { browser, notes, titles, host } = sidebarPromptBrowser({ language: "zh-CN" });
  const errors = captureErrors();
  try {
    installWorkspacePanel(browser, host);
    await assert.rejects(browser.sidePanel.open({ windowId: 1 }), /toolbar button/);
    await settle();
  } finally {
    errors.restore();
  }
  assert.equal(notes[0].options.title, "轻舟");
  assert.equal(notes[0].options.message, "点击工具栏中的轻舟图标查看。");
  assert.deepEqual(titles, ["轻舟：点击打开侧边栏"]);
});

function sidebarPromptBrowser({ language = "en-US" } = {}) {
  const state = {
    badges: [],
    titles: [],
    notes: [],
    opens: [],
    createdTabs: [],
    focused: [],
    host: {},
    allowOpen: false,
    showing: false,
    clickListeners: [],
    connectListeners: [],
    click(id) { for (const listener of state.clickListeners) listener(id); },
    connect(port) { for (const listener of state.connectListeners) listener(port); },
  };
  const browser = {
    runtime: {
      getURL: path => `moz-extension://uuid/${path}`,
      onConnect: { addListener(listener) { state.connectListeners.push(listener); } },
    },
    i18n: { getUILanguage: () => language },
    sidebarAction: {
      open() {
        state.opens.push(arguments.length);
        if (!state.allowOpen) return Promise.reject(new Error("sidebarAction.open may only be called from a user input handler"));
        return Promise.resolve();
      },
      toggle() {
        state.opens.push("toggle");
        return Promise.resolve();
      },
      isOpen() { return Promise.resolve(state.showing); },
    },
    action: {
      onClicked: { addListener(listener) { browser.toolbar = listener; } },
      setBadgeText(details) { state.badges.push(details.text); return Promise.resolve(); },
      setTitle(details) { state.titles.push(details.title); return Promise.resolve(); },
    },
    notifications: {
      create(id, options) {
        state.notes.push({ id, options });
        return Promise.resolve(id);
      },
      clear(id) { state.notes.push({ clear: id }); return Promise.resolve(true); },
      onClicked: { addListener(listener) { state.clickListeners.push(listener); } },
    },
    tabs: { create(properties) { state.createdTabs.push(properties); return Promise.resolve({ id: 1 }); } },
    windows: {
      create(properties) { state.createdTabs.push(properties); return Promise.resolve({ id: 2 }); },
      getLastFocused() { return Promise.resolve({ id: 4 }); },
      update(windowId, info) { if (info.focused) state.focused.push(windowId); return Promise.resolve({ id: windowId }); },
    },
  };
  state.browser = browser;
  return state;
}

function settle() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function captureErrors() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore() { console.error = original; } };
}

test("initiatorDomains use the moz-extension host on Firefox and stay unchanged on Chrome", async () => {
  const seen = [];
  const firefox = rulesChrome("qz-browser-agent@heleifz.github.io", "moz-extension://uuid/", seen);
  installInitiatorRewrite(firefox);
  await firefox.declarativeNetRequest.updateSessionRules({ addRules: [{ id: 1, condition: { initiatorDomains: [firefox.runtime.id] } }] });
  assert.deepEqual(seen[0].addRules[0].condition.initiatorDomains, ["uuid"]);
  await firefox.declarativeNetRequest.updateSessionRules({ removeRuleIds: [7] });
  assert.deepEqual(seen[1], { removeRuleIds: [7] });
  assert.equal("addRules" in seen[1], false);
  await firefox.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [3],
    addRules: [{ id: 4, condition: { initiatorDomains: [firefox.runtime.id, "example.test"] } }],
  });
  assert.deepEqual(seen[2].removeRuleIds, [3]);
  assert.deepEqual(seen[2].addRules[0].condition.initiatorDomains, ["uuid", "example.test"]);
  const chrome = rulesChrome("abcdefghijklmnopabcdefghijklmnop", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/", seen);
  installInitiatorRewrite(chrome);
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 2, condition: { initiatorDomains: [chrome.runtime.id] } }] });
  assert.deepEqual(seen[3].addRules[0].condition.initiatorDomains, [chrome.runtime.id]);
});

test("requireInteraction renews a notification until the user closes it", async () => {
  let created = 0;
  let fail = false;
  const seen = [];
  const browser = {
    notifications: {
      async create(id, options) {
        if (options && Object.hasOwn(options, "requireInteraction")) {
          throw new Error('Unexpected property "requireInteraction"');
        }
        seen.push(options || {});
        created += 1;
        if (fail) throw new Error("notifications are unavailable");
        return id;
      },
      onClosed: { addListener(listener) { browser.closed = listener; } },
      onClicked: { addListener(listener) { browser.clicked = listener; } },
    },
  };
  installNotificationRenewal(browser);
  await browser.notifications.create("done", { requireInteraction: true, priority: 2, title: "done" });
  assert.equal(seen[0].requireInteraction, undefined);
  assert.equal(seen[0].priority, 2);
  assert.equal(seen[0].title, "done");
  browser.closed("done", false);
  await Promise.resolve();
  assert.equal(created, 2);
  assert.equal(seen[1].requireInteraction, undefined);
  assert.equal(seen[1].priority, 2);
  browser.closed("done", true);
  await Promise.resolve();
  assert.equal(created, 2);
  browser.clicked("done");
  browser.closed("done", false);
  await Promise.resolve();
  assert.equal(created, 2);
  await browser.notifications.create("again", { requireInteraction: true });
  fail = true;
  browser.closed("again", false);
  await Promise.resolve();
  await Promise.resolve();
  const before = created;
  browser.closed("again", false);
  await Promise.resolve();
  assert.equal(created, before);
});

test("an inherited requireInteraction is removed before Firefox validates the options", async () => {
  const seen = [];
  const browser = {
    notifications: {
      async create(id, options) {
        if (options && "requireInteraction" in options) throw new Error('Unexpected property "requireInteraction"');
        seen.push(options || {});
        return id;
      },
      onClosed: { addListener(listener) { browser.closed = listener; } },
      onClicked: { addListener() {} },
    },
  };
  installNotificationRenewal(browser);
  const options = Object.create({ requireInteraction: true });
  options.type = "basic";
  options.title = "inherited";
  options.priority = 1;
  await browser.notifications.create("inherited", options);
  assert.equal("requireInteraction" in seen[0], false);
  assert.equal(seen[0].type, "basic");
  assert.equal(seen[0].title, "inherited");
  assert.equal(seen[0].priority, 1);
  browser.closed("inherited", false);
  await Promise.resolve();
  assert.equal(seen.length, 2);
  assert.equal("requireInteraction" in seen[1], false);
});

test("a completion notification is created without requireInteraction and its click calls sidebarAction.open in the click turn", async () => {
  const seen = [];
  const opens = [];
  const browser = {
    runtime: { getURL: path => `moz-extension://uuid/${path}` },
    sidebarAction: {
      open() {
        opens.push(arguments.length);
        return Promise.resolve();
      },
    },
    action: { onClicked: { addListener() {} } },
    notifications: {
      create(id, options, callback) {
        if (options && Object.hasOwn(options, "requireInteraction")) {
          throw new Error('Unexpected property "requireInteraction"');
        }
        seen.push(options);
        if (callback) callback(id);
        return Promise.resolve(id);
      },
      clear(_id, callback) {
        if (callback) callback(true);
        return Promise.resolve(true);
      },
      onClosed: { addListener() {} },
      onClicked: { addListener() {} },
    },
    windows: {
      async getLastFocused() { return { id: 4, type: "normal", focused: false }; },
      async getAll() { return [{ id: 4, type: "normal", focused: false }]; },
    },
  };
  installWorkspacePanel(browser, {});
  installNotificationRenewal(browser);
  const notifications = createChromeNotificationService({
    notifications: browser.notifications,
    runtime: {},
    windows: browser.windows,
  });
  const notifier = createSessionCompletionNotifier({
    notifications,
    iconUrl: "moz-extension://uuid/icons/icon128.png",
    getRuntime: () => ({ status: "completed", running: false, runId: "run-1" }),
    getRuntimeCheckpoint: () => ({}),
    getSessions: async () => ({ root: { id: "root", title: "Trip", parentSessionId: "0" } }),
    getTranscript: async () => [],
    getLastToolName: () => "",
    setRuntime: () => {},
    activateWorkingTab: async () => ({ activated: false }),
    openSession: () => {
      browser.sidePanel.open({ windowId: 4 });
      return true;
    },
    now: () => "2026-07-12 12:00:00",
  });
  assert.equal(await notifier.notifyCompleted("root"), true);
  assert.equal(seen[0].requireInteraction, undefined);
  assert.equal(seen[0].priority, 2);
  assert.equal(seen[0].title.length > 0, true);
  assert.equal(seen[0].message, "Trip");
  const click = notifier.handleClick("qz_completed_root_run-1");
  assert.deepEqual(opens, [0], "the notification click calls sidebarAction.open with no arguments");
  assert.equal(await click, true);
});

test("the offscreen host loads the shared document in a hidden frame", async () => {
  let frame;
  const doc = {
    documentElement: { appendChild(node) { node.isConnected = true; node.listeners?.load?.(); } },
    createElement() {
      frame = { src: "", hidden: false, style: {}, isConnected: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
      return frame;
    },
  };
  const browser = { runtime: { getURL: path => `moz-extension://uuid/${path}` } };
  installOffscreenHost(browser, doc);
  await browser.offscreen.createDocument({ url: "offscreen.html" });
  assert.equal(frame.src, "moz-extension://uuid/offscreen.html");
  assert.equal(frame.hidden, true);
  assert.equal(await browser.offscreen.hasDocument(), true);
});

test("the offscreen host waits for one load and retries after a failure", async () => {
  const frames = [];
  const doc = {
    documentElement: {
      appendChild(node) { node.isConnected = true; },
      removeChild(node) { node.isConnected = false; },
    },
    createElement() {
      const frame = {
        src: "", hidden: false, style: {}, isConnected: false, href: "", listeners: {},
        contentDocument: { get URL() { return frame.href; } },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        removeEventListener(type) { delete this.listeners[type]; },
        remove() { this.isConnected = false; doc.documentElement.removeChild(this); },
      };
      frames.push(frame);
      return frame;
    },
  };
  const browser = { runtime: { getURL: path => `moz-extension://uuid/${path}` } };
  installOffscreenHost(browser, doc);
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  const first = browser.offscreen.createDocument();
  const second = browser.offscreen.createDocument();
  await settle();
  assert.equal(frames.length, 1);
  assert.equal(await browser.offscreen.hasDocument(), false);
  frames[0].href = "about:blank";
  frames[0].listeners.load();
  assert.equal(await browser.offscreen.hasDocument(), false);
  frames[0].href = "moz-extension://uuid/offscreen.html";
  frames[0].listeners.load();
  await first;
  await second;
  assert.equal(frames.length, 1);
  assert.equal(await browser.offscreen.hasDocument(), true);

  frames[0].remove();
  assert.equal(await browser.offscreen.hasDocument(), false);
  const failed = browser.offscreen.createDocument();
  await settle();
  frames[1].listeners.error();
  await assert.rejects(failed, /failed to load/);
  assert.equal(frames[1].isConnected, false);
  assert.equal(await browser.offscreen.hasDocument(), false);

  const retried = browser.offscreen.createDocument();
  await settle();
  frames[2].href = "moz-extension://uuid/offscreen.html";
  frames[2].listeners.load();
  await retried;
  assert.equal(await browser.offscreen.hasDocument(), true);
});

test("the offscreen popup fallback requires a real window id", async () => {
  let created = 0;
  const browser = {
    runtime: { getURL: path => `moz-extension://uuid/${path}` },
    windows: {
      async create() { created += 1; return {}; },
      async get() { return { id: 4 }; },
    },
  };
  installOffscreenHost(browser, { documentElement: null });
  await assert.rejects(browser.offscreen.createDocument(), /was not created/);
  assert.equal(await browser.offscreen.hasDocument(), false);
  browser.windows.create = async () => { created += 1; return { id: 4 }; };
  await browser.offscreen.createDocument();
  await browser.offscreen.createDocument();
  assert.equal(created, 2);
  assert.equal(await browser.offscreen.hasDocument(), true);
});

test("a loading event page waits for a document instead of opening a window", async () => {
  let created = 0;
  let frame;
  const doc = {
    readyState: "loading",
    documentElement: null,
    addEventListener(_type, listener) { doc.ready = listener; },
    createElement() {
      frame = {
        src: "", hidden: false, style: {}, isConnected: false, listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
      };
      return frame;
    },
  };
  const browser = {
    runtime: { getURL: path => `moz-extension://uuid/${path}` },
    windows: { async create() { created += 1; return { id: 1 }; }, async get() { return { id: 1 }; } },
  };
  installOffscreenHost(browser, doc);
  const opening = browser.offscreen.createDocument();
  await Promise.resolve();
  assert.equal(created, 0);
  assert.equal(frame, undefined);
  doc.documentElement = { appendChild(node) { node.isConnected = true; node.listeners.load(); } };
  doc.ready();
  await opening;
  assert.equal(created, 0);
  assert.equal(frame.hidden, true);
  assert.equal(await browser.offscreen.hasDocument(), true);
});

test("sidebar links and case recording use Firefox equivalents", async () => {
  let stopped = false;
  const stream = { getAudioTracks: () => [{ stop() { stopped = true; } }] };
  const media = {
    getDisplayMedia: async () => stream,
    async getUserMedia() { throw new Error("desktop constraints are not supported"); },
  };
  const browser = {
    tabs: { async create(properties) { return properties; } },
    permissions: { async request() { return false; } },
  };
  installSidepanelFirefoxHost(browser, media);
  assert.equal((await browser.tabs.create({ url: "chrome://extensions/shortcuts" })).url, "about:addons");
  assert.equal((await browser.tabs.create({ url: "chrome://downloads" })).url, "about:downloads");
  assert.equal((await browser.tabs.create({ url: "https://example.test/" })).url, "https://example.test/");
  assert.equal(await browser.permissions.request({ permissions: ["desktopCapture"] }), true);
  assert.equal(await browser.permissions.request({ permissions: ["history"] }), false);
  const chosen = await new Promise(resolve => browser.desktopCapture.chooseDesktopMedia(["screen", "audio"], resolve));
  assert.equal(chosen, "firefox-display");
  const recorded = await media.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: chosen } } });
  assert.equal(recorded, stream);
  assert.equal(stopped, true);
});

test("display capture does not reopen the picker after a dismissal", async () => {
  let calls = 0;
  const browser = { permissions: { async request() { return false; } } };
  const denied = {
    async getDisplayMedia() {
      calls += 1;
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    },
  };
  installSidepanelFirefoxHost(browser, denied);
  const dismissed = await new Promise(resolve => browser.desktopCapture.chooseDesktopMedia(["screen", "audio"], resolve));
  assert.equal(dismissed, "");
  assert.equal(calls, 1);

  const first = { getTracks: () => [{ stop() { first.stopped = true; } }], getAudioTracks: () => [] };
  const second = { getAudioTracks: () => [{ stop() {} }], getTracks: () => [] };
  let attempt = 0;
  const media = {
    async getDisplayMedia(constraints) {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("no audio"), { name: "NotSupportedError" });
      assert.equal(constraints.audio, false);
      return attempt === 2 ? first : second;
    },
  };
  const again = {};
  installSidepanelFirefoxHost(again, media);
  const chosen = await new Promise(resolve => again.desktopCapture.chooseDesktopMedia(["screen", "audio"], resolve));
  assert.equal(chosen, "firefox-display");
  await new Promise(resolve => again.desktopCapture.chooseDesktopMedia(["screen"], resolve));
  assert.equal(first.stopped, true);
  assert.equal(attempt, 3);
});

test("jpeg pages become a pdf", () => {
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xd9,
  ]);
  assert.deepEqual(jpegSize(jpeg), { width: 3, height: 2 });
  const pdf = new TextDecoder().decode(jpegsToPdf([jpeg]));
  assert.match(pdf, /^%PDF-1\.4/);
  assert.match(pdf, /\/Width 3/);
  assert.match(pdf, /\/Height 2/);
  assert.match(pdf, /%%EOF/);
  const noted = new TextDecoder().decode(jpegsToPdf([jpeg], "Firefox kept 8 of 9 viewport pages. Content below that was omitted."));
  assert.match(noted, /Firefox kept 8 of 9 viewport pages/);
  assert.match(noted, /\/Count 2/);
});

test("the debugger shim reports frames, isolated contexts, clicks, and network bodies", async () => {
  const events = [];
  const element = {
    nodeName: "BUTTON", nodeType: 1, textContent: "Go", childNodes: [{ nodeType: 3, nodeValue: "Go" }],
    attributes: {}, events: [],
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    hasAttribute() { return false; },
    getBoundingClientRect() { return { x: 4, y: 5, width: 6, height: 7, left: 4, top: 5, right: 10, bottom: 12 }; },
    dispatchEvent(event) { this.events.push(event.type); return true; },
  };
  const document = {
    nodeType: 9, nodeName: "#document", title: "Example", documentElement: element, body: element, activeElement: element,
    scrollingElement: { scrollLeft: 0, scrollTop: 0, scrollWidth: 100, scrollHeight: 100, clientWidth: 50, clientHeight: 40 },
    querySelectorAll: selector => selector === "button" ? [element] : [],
    elementFromPoint: () => element,
    execCommand() { return true; },
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 50, innerHeight: 40, getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
  };
  const networkListeners = {};
  const browser = {
    runtime: { id: "qz-browser-agent@heleifz.github.io", onMessage: { addListener() {} } },
    tabs: { onRemoved: { addListener(listener) { browser.removed = listener; } }, async get() { return { windowId: 1, url: "https://example.test/" }; } },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0, parentFrameId: -1, url: "https://example.test/" }, { frameId: 7, parentFrameId: 0, url: "https://other.test/frame" }]; },
      onCommitted: { addListener() {} },
    },
    scripting: { async executeScript({ func, args }) {
      if (func.name !== "firefoxPageCommand") return [{ result: undefined }];
      return [{ result: await func(...(args || [])) }];
    } },
    webRequest: {
      onBeforeRequest: { addListener(listener) { networkListeners.before = listener; } },
      onBeforeSendHeaders: { addListener(listener) { networkListeners.headers = listener; } },
      onHeadersReceived: { addListener(listener) { networkListeners.response = listener; } },
      onCompleted: { addListener(listener) { networkListeners.completed = listener; } },
      onErrorOccurred: { addListener() {} },
      filterResponseData() { throw new Error("unavailable"); },
    },
  };
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    browser.debugger.onEvent.addListener((source, method, params) => events.push({ source, method, params }));
    browser.debugger.onDetach.addListener((_source, reason) => events.push({ reason }));
    await browser.debugger.attach({ tabId: 3 }, "1.3");
    const tree = await browser.debugger.sendCommand({ tabId: 3 }, "Page.getFrameTree");
    assert.equal(tree.frameTree.frame.id, "0");
    assert.deepEqual(tree.frameTree.childFrames, []);
    await browser.debugger.sendCommand({ tabId: 3 }, "Target.setAutoAttach", { autoAttach: true, flatten: true });
    const attached = events.find(event => event.method === "Target.attachedToTarget");
    assert.equal(attached.params.sessionId, "ff-3-7");
    assert.equal(attached.params.targetInfo.parentFrameId, "0");
    assert.equal(attached.source.sessionId, undefined);
    await browser.debugger.sendCommand({ tabId: 3 }, "Runtime.enable");
    const isolated = events.find(event => event.method === "Runtime.executionContextCreated" && event.params.context.auxData.type === "isolated");
    assert.equal(isolated.params.context.origin, "chrome-extension://qz-browser-agent@heleifz.github.io");
    const agent = await browser.debugger.sendCommand({ tabId: 3 }, "Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
    assert.match(agent.result.value, /Chrome\/131\.0\.0\.0/);
    const root = await browser.debugger.sendCommand({ tabId: 3 }, "DOM.getDocument", { depth: 0 });
    const queried = await browser.debugger.sendCommand({ tabId: 3 }, "DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: "button" });
    const described = await browser.debugger.sendCommand({ tabId: 3 }, "DOM.describeNode", { nodeId: queried.nodeIds[0] });
    assert.equal(described.node.nodeName, "BUTTON");
    await browser.debugger.sendCommand({ tabId: 3 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 4, y: 5, button: "left", clickCount: 1 });
    await browser.debugger.sendCommand({ tabId: 3 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 4, y: 5, button: "left", clickCount: 1 });
    assert.ok(element.events.includes("click"));
    const ax = await browser.debugger.sendCommand({ tabId: 3 }, "Accessibility.getFullAXTree", {});
    assert.equal(ax.nodes[0].role.value, "RootWebArea");
    assert.ok(ax.nodes.some(node => node.role.value === "button" && node.backendDOMNodeId === described.node.backendNodeId));
    await browser.debugger.sendCommand({ tabId: 3 }, "Network.enable");
    networkListeners.headers({ requestId: "20", tabId: 3, url: "https://example.test/a", method: "GET", type: "xmlhttprequest", timeStamp: 1_700_000_000_000, requestHeaders: [{ name: "Accept", value: "application/json" }] });
    networkListeners.completed({ requestId: "20", tabId: 3, url: "https://example.test/a", type: "xmlhttprequest", timeStamp: 1_700_000_000_500, responseHeaders: [{ name: "content-length", value: "4" }] });
    const started = events.find(event => event.method === "Network.requestWillBeSent");
    assert.equal(started.params.request.url, "https://example.test/a");
    assert.equal(started.params.timestamp, 1_700_000_000);
    assert.equal(started.source.sessionId, undefined);
    await assert.rejects(() => browser.debugger.sendCommand({ tabId: 3 }, "Network.getResponseBody", { requestId: "20" }), /No data found/);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      headers: { forEach(fn) { fn("text/plain", "content-type"); } },
      async arrayBuffer() { return new TextEncoder().encode("hi").buffer; },
    });
    try {
      const loaded = await browser.debugger.sendCommand({ tabId: 3 }, "Network.loadNetworkResource", {
        url: "https://example.test/archive.zip",
        options: { disableCache: true, includeCredentials: true },
      });
      assert.equal(loaded.resource.success, true);
      assert.equal(loaded.resource.httpStatusCode, 200);
      assert.equal(loaded.resource.headers[0].name, "content-type");
      const read = await browser.debugger.sendCommand({ tabId: 3 }, "IO.read", { handle: loaded.resource.stream, size: 1 });
      assert.equal(read.base64Encoded, true);
      assert.equal(read.eof, false);
      const rest = await browser.debugger.sendCommand({ tabId: 3 }, "IO.read", { handle: loaded.resource.stream });
      assert.equal(rest.eof, true);
      await browser.debugger.sendCommand({ tabId: 3 }, "IO.close", { handle: loaded.resource.stream });
      await assert.rejects(() => browser.debugger.sendCommand({ tabId: 3 }, "IO.read", { handle: loaded.resource.stream }), /IO.read stream is closed/);
      const bad = await browser.debugger.sendCommand({ tabId: 3 }, "Network.loadNetworkResource", { url: "file:///tmp/a" });
      assert.equal(bad.resource.netErrorName, "ERR_INVALID_URL");
      assert.equal(bad.resource.success, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await browser.debugger.detach({ tabId: 3 });
    assert.equal(events.some(event => event.reason), false);
    browser.removed(3);
    assert.equal(events.some(event => event.reason === "target_closed"), false);
    await browser.debugger.attach({ tabId: 3 }, "1.3");
    browser.removed(3);
    assert.equal(events.some(event => event.reason === "target_closed"), true);
  });
});

test("overflow screenshots scroll across and down, then restore", async () => {
  const moves = [];
  let pendingX = 0;
  const scroller = {
    scrollWidth: 4000, scrollHeight: 4000, clientWidth: 400, clientHeight: 300,
    _x: 0, _y: 0,
  };
  Object.defineProperty(scroller, "scrollLeft", {
    get() { return scroller._x; },
    set(value) {
      pendingX = Number(value);
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller._x = Math.max(0, Math.min(pendingX, max));
    },
  });
  Object.defineProperty(scroller, "scrollTop", {
    get() { return scroller._y; },
    set(value) {
      const requested = Number(value);
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller._y = Math.max(0, Math.min(requested, max));
      moves.push([pendingX, requested]);
    },
  });
  const document = {
    nodeType: 9,
    documentElement: {},
    scrollingElement: scroller,
    defaultView: {
      get scrollX() { return scroller.scrollLeft; },
      get scrollY() { return scroller.scrollTop; },
      innerWidth: 400,
      innerHeight: 300,
    },
  };
  const browser = debuggerBrowser(async options => {
    if (options?.rect) throw new Error("rect too large");
    return "data:image/png;base64,aaaa";
  });
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 4 }, "1.3");
    await browser.debugger.sendCommand({ tabId: 4 }, "Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 100, y: 50, width: 500, height: 800, scale: 1 },
    });
    assert.deepEqual(moves, [
      [100, 50], [500, 50], [100, 350], [500, 350], [100, 650], [500, 650], [0, 0],
    ]);
    moves.length = 0;
    scroller.scrollWidth = 400;
    scroller.scrollHeight = 300;
    await browser.debugger.sendCommand({ tabId: 4 }, "Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 100, y: 50, width: 500, height: 800, scale: 1 },
    });
    assert.deepEqual(moves, [[100, 50], [400, 50], [100, 300], [0, 0]]);
    moves.length = 0;
    scroller.scrollWidth = 4000;
    scroller.scrollHeight = 4000;
    await browser.debugger.sendCommand({ tabId: 4 }, "Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 10, y: 12, width: 20, height: 24, scale: 1 },
    });
    assert.deepEqual(moves, []);
  });
});

test("duplicate iframe src values follow the sibling index", async () => {
  const iframe = (src, childUrl) => ({
    nodeName: "IFRAME",
    nodeType: 1,
    getAttribute(name) { return name === "src" ? src : null; },
    contentWindow: childUrl
      ? { location: { href: childUrl } }
      : { get location() { throw new Error("cross-origin"); } },
  });
  const frames = [
    iframe("https://other.test/widget"),
    iframe("https://other.test/widget"),
    iframe("https://unique.test/only"),
    iframe("https://decoy.test/a", "https://real.test/doc"),
  ];
  const document = {
    nodeType: 9,
    querySelectorAll: selector => String(selector).includes("iframe") ? frames : [],
    documentElement: {},
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 },
  };
  let listed = [
    { frameId: 0, parentFrameId: -1, url: "https://example.test/" },
    { frameId: 4, parentFrameId: 0, url: "https://other.test/widget" },
    { frameId: 5, parentFrameId: 0, url: "https://other.test/widget" },
    { frameId: 6, parentFrameId: 0, url: "https://unique.test/only" },
    { frameId: 7, parentFrameId: 0, url: "https://real.test/doc" },
  ];
  const browser = debuggerBrowser();
  browser.webNavigation = { async getAllFrames() { return listed; }, onCommitted: { addListener() {} } };
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 8 }, "1.3");
    const owner = async frameId => browser.debugger.sendCommand({ tabId: 8 }, "DOM.getFrameOwner", { frameId });
    assert.equal((await owner("4")).backendNodeId, 1);
    assert.equal((await owner("5")).backendNodeId, 2);
    assert.equal((await owner("6")).backendNodeId, 3);
    assert.equal((await owner("7")).backendNodeId, 4);
    delete globalThis.__qzFirefoxPage;
    frames.splice(0, frames.length, iframe("https://unique.test/only"), iframe("https://other.test/widget"), iframe("https://other.test/widget"));
    listed = [
      { frameId: 0, parentFrameId: -1, url: "https://example.test/" },
      { frameId: 4, parentFrameId: 0, url: "https://other.test/widget" },
      { frameId: 5, parentFrameId: 0, url: "https://other.test/widget" },
      { frameId: 6, parentFrameId: 0, url: "https://unique.test/only" },
    ];
    assert.equal((await owner("6")).backendNodeId, 1);
  });
});

test("auto-attach announces a cross-origin frame once and detaches it when it leaves", async () => {
  const events = [];
  let frames = [
    { frameId: 0, parentFrameId: -1, url: "https://example.test/" },
    { frameId: 2, parentFrameId: 0, url: "https://example.test/same" },
    { frameId: 7, parentFrameId: 0, url: "https://other.test/frame" },
    { frameId: 9, parentFrameId: 7, url: "https://nested.test/deep" },
  ];
  const browser = debuggerBrowser();
  let committed;
  browser.webNavigation = {
    async getAllFrames() { return frames; },
    onCommitted: { addListener(listener) { committed = listener; } },
  };
  installFirefoxDebugger(browser);
  browser.debugger.onEvent.addListener((_source, method) => events.push(method));
  await browser.debugger.attach({ tabId: 3 }, "1.3");
  await browser.debugger.sendCommand({ tabId: 3 }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await browser.debugger.sendCommand({ tabId: 3 }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  assert.deepEqual(events.filter(method => method === "Target.attachedToTarget"), ["Target.attachedToTarget", "Target.attachedToTarget"]);
  assert.equal(events.includes("Target.detachedFromTarget"), false);
  frames = frames.filter(frame => frame.frameId !== 9);
  await committed({ tabId: 3, frameId: 0, url: "https://example.test/" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.filter(method => method === "Target.detachedFromTarget").length, 1);
  frames = frames.filter(frame => frame.frameId !== 7);
  await committed({ tabId: 3, frameId: 0, url: "https://example.test/" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(events.filter(method => method === "Target.detachedFromTarget").length, 2);
});

test("network listeners fall back when Firefox rejects extraInfoSpec", async () => {
  const events = [];
  let beforeAdds = 0;
  let headerAdds = 0;
  const listeners = {};
  const watch = createNetworkWatch({
    webRequest: {
      onBeforeRequest: { addListener(listener, _filter, extra) {
        beforeAdds += 1;
        if (extra?.includes("blocking")) throw new Error("blocking is unavailable");
        listeners.before = listener;
      } },
      onBeforeSendHeaders: { addListener(listener, _filter, extra) {
        headerAdds += 1;
        if (extra) throw new Error("requestHeaders is unavailable");
        listeners.headers = listener;
      } },
      onHeadersReceived: { addListener(listener) { listeners.response = listener; } },
      onCompleted: { addListener(listener) { listeners.completed = listener; } },
      onErrorOccurred: { addListener() {} },
      filterResponseData(requestId) {
        const filter = { ondata: null, onstop: null, onerror: null, write() {}, disconnect() {} };
        queueMicrotask(() => {
          const bytes = new Uint8Array((1024 * 1024) + 32);
          bytes.fill(97);
          filter.ondata?.({ data: bytes.buffer });
          filter.onstop?.();
        });
        return filter;
      },
    },
  }, (tabId, method, params) => events.push({ tabId, method, params }));
  watch.enable(5);
  watch.enable(5);
  assert.equal(beforeAdds, 2);
  assert.equal(headerAdds, 2);
  assert.equal(typeof listeners.headers, "function");
  listeners.before({ requestId: "9", tabId: 5, url: "https://example.test/body", method: "GET", type: "xmlhttprequest", timeStamp: 10 });
  listeners.headers({ requestId: "9", tabId: 5, url: "https://example.test/body", method: "GET", type: "xmlhttprequest", timeStamp: 10, requestHeaders: [{ name: "Accept", value: "text/plain" }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const body = watch.body(5, "9");
  assert.equal(body.base64Encoded, false);
  assert.equal(body.body.length, 1024 * 1024);
  assert.equal(events.filter(event => event.method === "Network.requestWillBeSent").length, 1);
});

test("a screenshot grid without a canvas returns the first tile", async () => {
  assert.equal(await stitchTiles([["aaa", "bbb"], ["ccc"]], 1, "png"), "aaa");
  assert.equal(await stitchTiles([["only"]], 1, "png"), "only");
});

test("click, press, and paste failures name the missing target", async () => {
  const input = {
    nodeName: "INPUT", nodeType: 1, value: "hi", selectionStart: 2, selectionEnd: 2, readOnly: false, disabled: false,
    dispatchEvent(event) { input.events.push(event.type); return true; },
    focus() { input.focused = true; },
    events: [],
  };
  const body = { nodeName: "BODY", nodeType: 1, dispatchEvent(event) { body.events.push(event.type); return true; }, events: [] };
  const document = {
    nodeType: 9, title: "Example", documentElement: body, body, activeElement: body,
    execCommand(command) { return command === "selectAll"; },
    createTextNode(text) { return { nodeType: 3, nodeValue: text }; },
    elementFromPoint() { return input; },
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 },
  };
  const browser = debuggerBrowser();
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 6 }, "1.3");
    await browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 8, y: 9, button: "left", clickCount: 1 });
    assert.equal(input.focused, true);
    assert.ok(input.events.includes("mousedown"));
    document.activeElement = input;
    await browser.debugger.sendCommand({ tabId: 6 }, "Input.insertText", { text: "!" });
    assert.equal(input.value, "hi!");
    document.activeElement = body;
    await browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r" });
    assert.ok(body.events.includes("keydown"));
    await assert.rejects(
      browser.debugger.sendCommand({ tabId: 6 }, "Input.insertText", { text: "x" }),
      /Firefox could not insert text/,
    );
    await assert.rejects(
      browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "v", code: "KeyV", modifiers: 2, commands: ["paste"] }),
      /Firefox could not paste/,
    );
    document.documentElement = null;
    document.body = null;
    document.activeElement = null;
    document.elementFromPoint = () => null;
    await assert.rejects(
      browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 }),
      /Firefox could not dispatch mousedown: the page has no element at \(1, 2\)/,
    );
    await assert.rejects(
      browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA" }),
      /Firefox could not press a: the page has no focused element/,
    );
  });
});

test("the accessibility walk names shadow and nested-frame boundaries", async () => {
  const inner = {
    nodeName: "BUTTON", nodeType: 1, textContent: "Inner",
    children: [], childNodes: [{ nodeType: 3, nodeValue: "Inner" }],
    getAttribute() { return null; },
  };
  const host = {
    nodeName: "DIV", nodeType: 1, shadowRoot: { nodeType: 11, children: [inner], childNodes: [inner] }, children: [], childNodes: [],
    getAttribute() { return null; }, textContent: "",
  };
  const closed = {
    nodeName: "DIV", nodeType: 1, children: [], childNodes: [],
    getAttribute() { return null; }, textContent: "",
    get shadowRoot() { throw new Error("closed"); },
  };
  const frame = {
    nodeName: "IFRAME", nodeType: 1, children: [], childNodes: [],
    getAttribute() { return null; }, textContent: "",
    get contentDocument() { throw new Error("blocked"); },
  };
  const nested = {
    nodeName: "IFRAME", nodeType: 1, children: [], childNodes: [],
    getAttribute() { return null; }, textContent: "", contentDocument: { nodeType: 9 },
  };
  const linked = {
    nodeName: "A", nodeType: 1, textContent: "In",
    children: [], childNodes: [{ nodeType: 3, nodeValue: "In" }],
    getAttribute(name) { return name === "href" ? "https://in.test/" : null; },
    hasAttribute(name) { return name === "href"; },
  };
  const readable = {
    nodeName: "IFRAME", nodeType: 1, children: [], childNodes: [],
    getAttribute() { return null; }, textContent: "",
    contentDocument: { nodeType: 9, documentElement: linked },
  };
  const root = {
    nodeName: "HTML", nodeType: 1, children: [host, closed, frame, nested, readable], childNodes: [host, closed, frame, nested, readable],
    getAttribute() { return null; }, textContent: "",
  };
  const document = { nodeType: 9, title: "Example", documentElement: root, defaultView: { getComputedStyle: () => ({}) } };
  const browser = debuggerBrowser();
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 6 }, "1.3");
    const tree = await browser.debugger.sendCommand({ tabId: 6 }, "Accessibility.getFullAXTree", {});
    const values = node => (node.properties || []).map(property => property.value.value);
    assert.ok(tree.nodes.some(node => node.role.value === "button" && node.name?.value === "Inner"));
    assert.equal(tree.nodes.some(node => values(node).includes("open shadow tree is not included")), false);
    assert.ok(tree.nodes.some(node => values(node).includes("shadow root could not be read: closed")));
    assert.ok(tree.nodes.some(node => values(node).includes("cross-origin nested frame is not included")));
    assert.ok(tree.nodes.some(node => values(node).includes("nested frame has no document")));
    assert.equal(tree.nodes.some(node => values(node).includes("nested frame document is not included")), false);
    assert.ok(tree.nodes.some(node => node.role.value === "link"));
    delete globalThis.__qzFirefoxPage;
    const button = {
      nodeName: "BUTTON", nodeType: 1, textContent: "Go",
      children: [{ nodeName: "SPAN", nodeType: 1, children: [], childNodes: [], getAttribute() { return null; }, textContent: "Go" }],
      childNodes: [],
      getAttribute() { return null; },
    };
    document.documentElement = button;
    const limited = await browser.debugger.sendCommand({ tabId: 6 }, "Accessibility.getFullAXTree", { depth: 1 });
    const bounded = limited.nodes.find(node => values(node).includes("children below this depth were omitted"));
    assert.equal(bounded.role.value, "button");
  });
});

test("Runtime.disable leaves the session hook enabled", async () => {
  const events = [];
  let onMessage;
  const browser = debuggerBrowser();
  browser.runtime.onMessage = { addListener(listener) { onMessage = listener; } };
  installFirefoxDebugger(browser);
  browser.debugger.onEvent.addListener((_source, method, params) => events.push({ method, params }));
  await browser.debugger.attach({ tabId: 3 }, "1.3");
  await browser.debugger.sendCommand({ tabId: 3 }, "Runtime.enable");
  assert.deepEqual(await browser.debugger.sendCommand({ tabId: 3 }, "Runtime.disable"), {});
  const agent = await browser.debugger.sendCommand({ tabId: 3 }, "Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
  assert.match(agent.result.value, /Chrome\/131\.0\.0\.0/);
  onMessage({ type: "qz-firefox-console", record: { kind: "console", type: "log", args: ["still"] } }, { tab: { id: 3 } });
  assert.equal(events.filter(event => event.method === "Runtime.consoleAPICalled").length, 1);
});

test("a screenshot that exceeds the tile budget says what was omitted", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  const scroller = { scrollWidth: 20000, scrollHeight: 20000, clientWidth: 400, clientHeight: 300, scrollLeft: 0, scrollTop: 0 };
  const document = {
    nodeType: 9,
    documentElement: {},
    scrollingElement: scroller,
    defaultView: {
      get scrollX() { return scroller.scrollLeft; },
      get scrollY() { return scroller.scrollTop; },
      innerWidth: 400,
      innerHeight: 300,
    },
  };
  const browser = debuggerBrowser(async options => {
    if (options?.rect) throw new Error("rect too large");
    return "data:image/jpeg;base64,aaaa";
  });
  try {
    await withPage(document, async () => {
      installFirefoxDebugger(browser);
      await browser.debugger.attach({ tabId: 4 }, "1.3");
      await browser.debugger.sendCommand({ tabId: 4 }, "Page.captureScreenshot", {
        format: "jpeg", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 10000, height: 10000, scale: 1 },
      });
    });
  } finally {
    console.warn = original;
  }
  assert.match(warnings[0], /firefox screenshot kept 8 viewport pieces; the rest of the clip was omitted/);
});

test("installing the host is idempotent and leaves a real debugger in place", () => {
  const real = { async sendCommand() { return { real: true }; }, async attach() {}, async detach() {} };
  const browser = { debugger: real, sidebarAction: { open() { return Promise.resolve(); } } };
  installFirefoxHost(browser);
  installFirefoxHost(browser);
  assert.equal(browser.debugger, real);
});

test("a beyond-viewport screenshot uses one captureTab rect before scrolling", async () => {
  const shots = [];
  const scroller = { scrollWidth: 4000, scrollHeight: 4000, clientWidth: 400, clientHeight: 300, scrollLeft: 0, scrollTop: 0 };
  const document = {
    nodeType: 9,
    documentElement: {},
    scrollingElement: scroller,
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 400, innerHeight: 300 },
  };
  const browser = debuggerBrowser(async options => {
    shots.push(options);
    return "data:image/png;base64,aaaa";
  });
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 4 }, "1.3");
    const shot = await browser.debugger.sendCommand({ tabId: 4 }, "Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 100, y: 50, width: 500, height: 800, scale: 1 },
    });
    assert.equal(shot.data, "aaaa");
    assert.equal(scroller.scrollLeft, 0);
    assert.equal(scroller.scrollTop, 0);
    assert.equal(shots.length, 1);
    assert.deepEqual(shots[0].rect, { x: 100, y: 50, width: 500, height: 800 });
    assert.equal(shots[0].scale, 1);
  });
});

test("a full-document capture becomes one pdf page", async () => {
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xd9,
  ]);
  const shots = [];
  let scrolled = 0;
  const scroller = { scrollWidth: 300, scrollHeight: 2000, clientWidth: 300, clientHeight: 400, scrollLeft: 0, scrollTop: 0 };
  Object.defineProperty(scroller, "scrollTop", { get() { return 0; }, set() { scrolled += 1; } });
  const document = {
    nodeType: 9,
    documentElement: {},
    scrollingElement: scroller,
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 300, innerHeight: 400 },
  };
  const browser = debuggerBrowser(async options => {
    shots.push(options);
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  });
  await withPage(document, async () => {
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 4 }, "1.3");
    const pdf = await browser.debugger.sendCommand({ tabId: 4 }, "Page.printToPDF", {});
    const text = Buffer.from(pdf.data, "base64").toString("latin1");
    assert.match(text, /^%PDF-1\.4/);
    assert.match(text, /\/Width 3/);
    assert.match(text, /\/Height 2/);
    assert.equal(text.includes("viewport pages"), false);
    assert.equal(scrolled, 0);
    assert.deepEqual(shots[0].rect, { x: 0, y: 0, width: 300, height: 2000 });
    assert.equal(shots[0].scale, 1);
  });
});

test("a click follows a link and skips a cancelled click", async () => {
  const assigned = [];
  const submitted = [];
  const link = {
    nodeName: "A", nodeType: 1, href: "https://example.test/next",
    getAttribute(name) { return name === "href" ? link.href : null; },
    dispatchEvent() { return link.allow; },
    closest() { return link; },
    focus() {},
    allow: true,
  };
  const button = {
    nodeName: "BUTTON", nodeType: 1, textContent: "Go",
    getAttribute() { return null; },
    dispatchEvent() { return true; },
    closest(selector) { return selector === "form" ? button.form : null; },
    form: { requestSubmit(target) { submitted.push(target); } },
    focus() {},
  };
  let target = link;
  const document = {
    nodeType: 9, title: "Example", documentElement: link, body: link, activeElement: link,
    elementFromPoint() { return target; },
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 },
  };
  const browser = debuggerBrowser();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true, writable: true, value: { assign(url) { assigned.push(url); } },
  });
  try {
    await withPage(document, async () => {
      installFirefoxDebugger(browser);
      await browser.debugger.attach({ tabId: 6 }, "1.3");
      const click = async () => {
        await browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 });
        await browser.debugger.sendCommand({ tabId: 6 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 });
      };
      await click();
      assert.deepEqual(assigned, ["https://example.test/next"]);
      assigned.length = 0;
      link.allow = false;
      await click();
      assert.deepEqual(assigned, []);
      link.href = "javascript:alert(1)";
      link.allow = true;
      await click();
      assert.deepEqual(assigned, []);
      target = button;
      await click();
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0], button);
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete globalThis.location;
  }
});

test("product text stays on the Chrome sentence outside a Firefox extension page", () => {
  const previous = globalThis.chrome;
  try {
    delete globalThis.chrome;
    assert.equal(productText("Chrome side panel", "Firefox sidebar"), "Chrome side panel");
    globalThis.chrome = { runtime: { getURL: () => "chrome-extension://id/" } };
    assert.equal(productText("Chrome side panel", "Firefox sidebar"), "Chrome side panel");
    globalThis.chrome = { runtime: { getURL: () => "moz-extension://uuid/" } };
    assert.equal(productText("Chrome side panel", "Firefox sidebar"), "Firefox sidebar");
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});

test("isolated content calls run without compiling a function", async () => {
  const nativeFunction = globalThis.Function;
  let compiled = 0;
  const document = {
    nodeType: 9, nodeName: "#document", title: "Probe",
    documentElement: { nodeType: 1, nodeName: "HTML" },
    defaultView: {},
  };
  const previousChrome = globalThis.chrome;
  globalThis.Function = function (...args) {
    compiled += 1;
    return nativeFunction(...args);
  };
  globalThis.chrome = { runtime: { id: "qz-browser-agent@heleifz.github.io" } };
  globalThis.__qzInvoke = (node, payload) => ({
    ok: true,
    action: payload && payload.action,
    nodeName: node && node.nodeName,
  });
  try {
    await withPage(document, async () => {
      const browser = debuggerBrowser();
      installFirefoxDebugger(browser);
      let isolatedId = 0;
      browser.debugger.onEvent.addListener((_source, method, params) => {
        if (method === "Runtime.executionContextCreated" && params?.context?.auxData?.type === "isolated") {
          isolatedId = params.context.id;
        }
      });
      await browser.debugger.attach({ tabId: 8 }, "1.3");
      await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.enable");
      assert.ok(isolatedId > 0);
      const probe = await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.evaluate", {
        expression: ISOLATED_CONTENT_PROBE,
        contextId: isolatedId,
        returnByValue: true,
      });
      assert.equal(probe.result.value.extensionId, "qz-browser-agent@heleifz.github.io");
      assert.equal(probe.result.value.bridge, true);
      assert.equal(compiled, 0, "the isolated probe does not compile a function");
      const blocked = await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.evaluate", {
        expression: "1+1",
        contextId: isolatedId,
        returnByValue: true,
      });
      assert.match(blocked.exceptionDetails.text, /cannot compile/);
      assert.equal(compiled, 0);
      const root = await browser.debugger.sendCommand({ tabId: 8 }, "DOM.getDocument");
      const resolved = await browser.debugger.sendCommand({ tabId: 8 }, "DOM.resolveNode", {
        backendNodeId: root.root.backendNodeId,
      });
      const invoked = await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: ISOLATED_CONTENT_INVOKE,
        arguments: [{ value: { action: "ping" } }],
        awaitPromise: true,
      });
      assert.equal(invoked.result.value.action, "ping");
      assert.equal(invoked.result.value.nodeName, "#document");
      assert.equal(compiled, 0);
      const unknown = await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: "function(){ return 1 }",
      });
      assert.match(unknown.exceptionDetails.text, /cannot compile/);
      assert.equal(compiled, 0);
      const main = await browser.debugger.sendCommand({ tabId: 8 }, "Runtime.evaluate", {
        expression: "1+2",
        returnByValue: true,
      });
      assert.equal(main.result.value, 3);
      assert.equal(compiled, 1, "a main-world expression still compiles");
    });
  } finally {
    globalThis.Function = nativeFunction;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    delete globalThis.__qzInvoke;
  }
});

test("firefox clicks mark extension events and toggle a checkbox the page left unchanged", async () => {
  const events = [];
  const box = {
    nodeType: 1,
    nodeName: "INPUT",
    disabled: false,
    checked: false,
    getAttribute(name) { return name === "type" ? "checkbox" : null; },
    focus() {},
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const document = {
    nodeType: 9, title: "Check", documentElement: box, body: box, activeElement: box,
    elementFromPoint() { return box; },
    defaultView: { scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600 },
  };
  await withPage(document, async () => {
    const browser = debuggerBrowser();
    installFirefoxDebugger(browser);
    await browser.debugger.attach({ tabId: 9 }, "1.3");
    const click = async () => {
      await browser.debugger.sendCommand({ tabId: 9 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 4, y: 4, button: "left", clickCount: 1 });
      await browser.debugger.sendCommand({ tabId: 9 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 4, y: 4, button: "left", clickCount: 1 });
    };
    await click();
    assert.equal(box.checked, true);
    const clickEvent = events.find(event => event.type === "click");
    assert.ok(clickEvent);
    assert.equal(globalThis.__qzExtensionInputEvents.has(clickEvent), true);
    assert.ok(events.some(event => event.type === "change"));
    const before = events.length;
    box.checked = false;
    box.dispatchEvent = event => {
      events.push(event);
      if (event.type === "click") box.checked = !box.checked;
      return true;
    };
    await click();
    assert.equal(box.checked, true);
    assert.equal(events.slice(before).filter(event => event.type === "change").length, 0);
  });
});

function debuggerBrowser(capture) {
  return {
    runtime: { id: "qz-browser-agent@heleifz.github.io", onMessage: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      async get() { return { windowId: 1, url: "https://example.test/" }; },
      async captureTab(_id, options) { return capture ? capture(options) : "data:image/png;base64,aaaa"; },
    },
    webNavigation: { async getAllFrames() { return []; }, onCommitted: { addListener() {} } },
    scripting: { async executeScript({ func, args }) {
      if (func.name !== "firefoxPageCommand") return [{ result: undefined }];
      return [{ result: await func(...(args || [])) }];
    } },
  };
}

let pageLock = Promise.resolve();
async function withPage(document, fn) {
  const wait = pageLock;
  let release;
  pageLock = new Promise(resolve => { release = resolve; });
  await wait;
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    delete globalThis.__qzFirefoxPage;
    delete globalThis.__qzInvoke;
    delete globalThis.__qzExtensionInputEvents;
    release();
  }
}

function rulesChrome(id, url, seen) {
  return {
    runtime: { id, getURL: () => url },
    declarativeNetRequest: {
      updateSessionRules: async update => { seen.push(update); },
      updateDynamicRules: async update => { seen.push(update); },
    },
  };
}

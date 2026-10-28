import { FIREFOX_EXTENSION_UUID, widgetId } from "./launch.mjs";

const SIDEBAR_URL = `moz-extension://${FIREFOX_EXTENSION_UUID}/sidepanel/sidepanel.html`;

export function sidebarCommandId(extensionId) {
  return `${widgetId(extensionId)}-sidebar-action`;
}

export function shortcutKeyId(extensionId) {
  return `ext-key-id-${widgetId(extensionId)}-sidebar-action`;
}

/**
 * A chrome-scope expression over `win` that holds once the extension's sidebar is selected and laid out.
 * A hidden sidebar keeps its panel browser and URL, so the URL alone does not show that it opened.
 */
function sidebarShown(extensionId) {
  return `(() => {
    const box = win.document.getElementById("sidebar-box");
    const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
    return win.SidebarController.currentID === ${JSON.stringify(sidebarCommandId(extensionId))}
      && !!box && !box.hidden && box.getBoundingClientRect().width > 0
      && panel?.currentURI?.spec === ${JSON.stringify(SIDEBAR_URL)};
  })()`;
}

/** Read the focused window's sidebar browser and every tab URL. */
export function readSidebar(session) {
  const command = sidebarCommandId(session.geckoId);
  return session.chrome(`
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
    const tabs = [];
    for (const browserWin of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of browserWin.gBrowser.tabs) tabs.push(tab.linkedBrowser.currentURI.spec);
    }
    return {
      current: win.SidebarController?.currentID || "",
      panel: panel?.currentURI?.spec || "",
      tabs,
      command: ${JSON.stringify(command)},
    };
  `);
}

export async function hideSidebars(session) {
  await session.chrome(`
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      try { win.SidebarController.hide(); } catch { /* A closed sidebar is the state this reset wants. */ }
    }
    const started = Date.now();
    while (Date.now() - started < 2000) {
      const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
      if (!win.SidebarController?.currentID) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
  `);
}

/** The navbar button calls browserAction.triggerAction, which runs the extension click handler. */
export async function openFromToolbar(session) {
  await hideSidebars(session);
  return session.chrome(`
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const policy = WebExtensionPolicy.getByID(${JSON.stringify(session.geckoId)});
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    const button = win.document.getElementById(${JSON.stringify(`${widgetId(session.geckoId)}-browser-action`)});
    ExtensionParent.apiManager.global.browserActionFor(policy.extension).triggerAction(win);
    const started = Date.now();
    let snap = null;
    while (Date.now() - started < 5000) {
      const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
      snap = { current: win.SidebarController.currentID || "", panel: panel?.currentURI?.spec || "", button: !!button };
      if (${sidebarShown(session.geckoId)}) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const tabs = [];
    for (const browserWin of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of browserWin.gBrowser.tabs) tabs.push(tab.linkedBrowser.currentURI.spec);
    }
    snap.tabs = tabs;
    return snap;
  `);
}

/** The manifest shortcut is _execute_sidebar_action. Firefox toggles the sidebar from that key. */
export async function openFromShortcut(session) {
  await hideSidebars(session);
  const keyId = shortcutKeyId(session.geckoId);
  return session.chrome(`
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    const key = win.document.getElementById(${JSON.stringify(keyId)});
    if (!key) throw new Error("Firefox did not register the sidebar shortcut");
    key.doCommand();
    const started = Date.now();
    let snap = null;
    while (Date.now() - started < 5000) {
      const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
      snap = {
        current: win.SidebarController.currentID || "",
        panel: panel?.currentURI?.spec || "",
        key: key.getAttribute("key"),
        modifiers: key.getAttribute("modifiers"),
      };
      if (${sidebarShown(session.geckoId)}) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const tabs = [];
    for (const browserWin of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of browserWin.gBrowser.tabs) tabs.push(tab.linkedBrowser.currentURI.spec);
    }
    snap.tabs = tabs;
    return snap;
  `);
}

export function extensionManifest(session) {
  return session.extension("background", `
    const manifest = view.chrome.runtime.getManifest();
    return {
      id: view.chrome.runtime.id,
      url: view.chrome.runtime.getURL(""),
      commands: Object.keys(manifest.commands || {}),
      sidebar: manifest.sidebar_action && manifest.sidebar_action.default_panel,
      scripts: manifest.background && manifest.background.scripts || [],
      serviceWorker: manifest.background && "service_worker" in manifest.background ? manifest.background.service_worker : null,
      gecko: manifest.browser_specific_settings && manifest.browser_specific_settings.gecko && manifest.browser_specific_settings.gecko.id || "",
      themeKey: manifest.theme || null,
      permissions: manifest.permissions || [],
    };
  `);
}

export function createNotification(session, id, options) {
  return session.extension("background", `
    const api = extensionApi();
    const marked = !!(api.notifications && api.notifications.create && api.notifications.create.qzFirefoxRenewal);
    let created = "";
    let error = "";
    try {
      // The options object has to live in the extension page. The wrapper's
      // JSON clone drops fields from a frame-script object.
      const payload = Cu.cloneInto(${JSON.stringify(options)}, content);
      created = await api.notifications.create(${JSON.stringify(id)}, payload);
    } catch (failure) {
      error = String(failure && failure.message || failure);
    }
    return { created, error, marked };
    function extensionApi() {
      const chromeApi = view.chrome || view.browser;
      const browserApi = view.browser || view.chrome;
      return chromeApi.notifications && chromeApi.notifications.create && chromeApi.notifications.create.qzFirefoxRenewal ? chromeApi : browserApi;
    }
  `);
}

/** A dark window theme with a light popup, so popover text has to follow popup_text. */
export const TEST_THEME = Object.freeze({
  frame: "#2a2148",
  tab_background_text: "#fbfbfe",
  toolbar: "#3b2f63",
  toolbar_text: "#fbfbfe",
  sidebar: "#2a2148",
  sidebar_text: "#ece8ff",
  sidebar_border: "rgba(236, 232, 255, 0.2)",
  sidebar_highlight: "#b9a5ff",
  sidebar_highlight_text: "#15141a",
  focus_outline: "#7cf0d0",
  toolbar_field: "#3b2f63",
  toolbar_field_text: "#ece8ff",
  toolbar_field_border: "#5b5285",
  popup: "#f6f3ff",
  popup_text: "#1c1b22",
  popup_border: "#c6bddc",
});

const PANEL_SCRIPT = `
  const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
  const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
`;

/** The sidebar switcher and View menu call SidebarController.show with the extension's command id. */
export async function openFromSwitcher(session) {
  await hideSidebars(session);
  return session.chrome(`
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    await win.SidebarController.show(${JSON.stringify(sidebarCommandId(session.geckoId))});
    const started = Date.now();
    let current = "";
    while (Date.now() - started < 5000) {
      const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
      current = panel?.currentURI?.spec || "";
      if (${sidebarShown(session.geckoId)}) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { current: win.SidebarController.currentID || "", panel: current };
  `);
}

/** Force prefers-color-scheme on the sidebar browser: "light", "dark", or "none". */
export async function setColorScheme(session, name) {
  await session.chrome(`
    ${PANEL_SCRIPT}
    if (!panel?.browsingContext) throw new Error("Firefox sidebar has no browsing context");
    panel.browsingContext.prefersColorSchemeOverride = ${JSON.stringify(name)};
    return true;
  `);
  await new Promise(resolve => setTimeout(resolve, 250));
}

/** Resize the sidebar box the way dragging its splitter does and return the panel's width. */
export async function setSidebarWidth(session, width) {
  return session.chrome(`
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    const box = win.document.getElementById("sidebar-box");
    box.style.width = ${JSON.stringify(`${width}px`)};
    const panel = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
    const started = Date.now();
    while (Date.now() - started < 3000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (Math.abs(panel.getBoundingClientRect().width - ${width}) <= 4) break;
    }
    return Math.round(panel.getBoundingClientRect().width);
  `);
}

/**
 * Override the system accent the way macOS reports it; null restores the platform color.
 * Content pages stand in for native colors until that pref is off, and the override is read
 * on the look-and-feel notification.
 */
export function setAccentColor(session, accent, text = "#ffffff") {
  return session.chrome(accent
    ? `Services.prefs.setBoolPref("ui.use_standins_for_native_colors", false); Services.prefs.setStringPref("ui.accentcolor", ${JSON.stringify(accent)}); Services.prefs.setStringPref("ui.accentcolortext", ${JSON.stringify(text)}); Services.obs.notifyObservers(null, "look-and-feel-changed"); return true;`
    : `Services.prefs.clearUserPref("ui.accentcolor"); Services.prefs.clearUserPref("ui.accentcolortext"); Services.prefs.setBoolPref("ui.use_standins_for_native_colors", true); Services.obs.notifyObservers(null, "look-and-feel-changed"); return true;`);
}

/** Install a static theme from `directory` as a temporary add-on and return its id. */
export function installTheme(session, directory) {
  return session.chrome(`
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    const addon = await AddonManager.installTemporaryAddon(new FileUtils.File(${JSON.stringify(directory)}));
    if (!addon.isActive) await addon.enable();
    await new Promise(resolve => setTimeout(resolve, 500));
    return addon.id;
  `);
}

export function uninstallTheme(session, id) {
  return session.chrome(`
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID(${JSON.stringify(id)});
    if (addon) await addon.uninstall();
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;
  `);
}

/** Read the theme overrides and palette the sidebar wrote on its root. */
export function readSidebarRoot(session) {
  return session.extension("sidebar", `
    const root = content.document.documentElement;
    const style = content.getComputedStyle(root);
    const inline = {};
    for (let index = 0; index < root.style.length; index += 1) {
      const name = root.style.item(index);
      inline[name] = root.style.getPropertyValue(name).trim();
    }
    return {
      inline,
      colorScheme: style.colorScheme,
      sheets: [...content.document.querySelectorAll("link[rel=stylesheet]")].map(link => link.getAttribute("href")),
    };
  `);
}

/** Measure a popover's text on its own surface while it is shown. */
export function readPopover(session) {
  return session.extension("sidebar", `
    const popover = content.document.querySelector("#chat-text-size-popover");
    if (!popover) return { missing: true };
    const hidden = popover.classList.contains("hidden");
    popover.classList.remove("hidden");
    const style = content.getComputedStyle(popover);
    const label = popover.querySelector("output, span, button") || popover;
    const result = { color: style.color, labelColor: content.getComputedStyle(label).color, background: style.backgroundColor };
    if (hidden) popover.classList.add("hidden");
    return result;
  `);
}

/** The background's sidebar diagnostics, toolbar badge and tooltip, and live notifications. */
export function sidebarState(session) {
  return session.extension("background", `
    const api = view.chrome;
    const diagnostics = view.qzFirefoxSidebar ? JSON.parse(JSON.stringify(view.qzFirefoxSidebar)) : null;
    const badge = await api.action.getBadgeText(Cu.cloneInto({}, content));
    const title = await api.action.getTitle(Cu.cloneInto({}, content));
    const notifications = Object.keys(await api.notifications.getAll());
    return { diagnostics, badge, title, notifications, errors: [...(view.__qzTestErrors || [])] };
  `);
}

/** Record background console.error lines in view.__qzTestErrors. */
export function captureBackgroundErrors(session) {
  return session.extension("background", `
    if (!view.__qzTestErrors) {
      view.__qzTestErrors = Cu.cloneInto([], view);
      const original = view.console.error;
      view.console.error = Cu.exportFunction(function(...args) {
        view.__qzTestErrors.push(args.map(String).join(" "));
        return original.call(view.console, ...args);
      }, view);
    }
    return true;
  `);
}

/** Poll sidebarState until `predicate(state)` holds or the timeout passes, and return the last state. */
export async function waitForSidebarState(session, predicate, timeout = 4000) {
  const started = Date.now();
  let state = await sidebarState(session);
  while (!predicate(state) && Date.now() - started < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await sidebarState(session);
  }
  return state;
}

/**
 * Call sidePanel.open from the background outside any user input, as an import does, and
 * capture the hint notification the wrapper creates.
 */
export function refuseSidebarOpen(session) {
  return session.extension("background", `
    const api = view.chrome;
    const original = api.notifications.create;
    let captured = null;
    api.notifications.create = Cu.exportFunction(function(notificationId, options) {
      const value = Cu.waiveXrays(options) || options || {};
      if (notificationId === "qz-open-sidebar") {
        captured = {
          message: value.message || "",
          title: value.title || "",
          requireInteraction: Object.prototype.hasOwnProperty.call(value, "requireInteraction"),
        };
      }
      return original.call(this, notificationId, options);
    }, view);
    let openError = "";
    try {
      await api.sidePanel.open(Cu.cloneInto({}, content));
      openError = "opened";
    } catch (error) {
      openError = String(error && error.message || error);
    }
    const started = Date.now();
    while (!captured && Date.now() - started < 1500) await new Promise(resolve => content.setTimeout(resolve, 50));
    api.notifications.create = original;
    return {
      openError,
      message: captured ? captured.message : "",
      title: captured ? captured.title : "",
      requireInteraction: captured ? captured.requireInteraction : false,
    };
  `);
}

/** Register a notification click listener that opens the sidebar in the click turn, like a completion notification. */
export function addNotificationOpener(session, notificationId) {
  return session.extension("background", `
    const api = view.chrome;
    view.__qzTestOpens = Cu.cloneInto([], view);
    api.notifications.onClicked.addListener(Cu.exportFunction(function(id) {
      if (id !== ${JSON.stringify(notificationId)}) return;
      api.sidePanel.open(Cu.cloneInto({}, view)).then(
        Cu.exportFunction(() => { view.__qzTestOpens.push("opened"); }, view),
        Cu.exportFunction(error => { view.__qzTestOpens.push(String(error && error.message || error)); }, view),
      );
    }, view));
    await api.notifications.create(${JSON.stringify(notificationId)}, Cu.cloneInto({ type: "basic", title: "qz", message: "done" }, content));
    return true;
  `);
}

export function notificationOpens(session) {
  return session.extension("background", `return [...(view.__qzTestOpens || [])];`);
}

/**
 * Headless Linux has no notification server, so the system backend closes each alert at once.
 * Firefox's own alert window keeps it open until it is clicked or cleared.
 */
export function keepNotifications(session) {
  return session.chrome(`Services.prefs.setBoolPref("alerts.useSystemBackend", false); return true;`);
}

/** Click a notification through the alert observer Firefox calls when the user clicks it. */
export function clickNotification(session, notificationId) {
  return session.chrome(`
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const policy = WebExtensionPolicy.getByID(${JSON.stringify(session.geckoId)});
    const api = ExtensionParent.apiManager.getAPI("notifications", policy.extension, "addon_parent");
    const notification = api.notificationsMap.get(${JSON.stringify(notificationId)});
    if (!notification) return { clicked: false, ids: [...api.notificationsMap.keys()] };
    notification.observe(null, "alertclickcallback");
    return { clicked: true };
  `);
}

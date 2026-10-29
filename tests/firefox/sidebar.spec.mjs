import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixture.mjs";
import { FIREFOX_EXTENSION_UUID } from "./launch.mjs";
import {
  TEST_THEME,
  addNotificationOpener,
  captureBackgroundErrors,
  clickNotification,
  createNotification,
  extensionManifest,
  hideSidebars,
  installTheme,
  keepNotifications,
  notificationOpens,
  openFromShortcut,
  openFromSwitcher,
  openFromToolbar,
  readPopover,
  readSidebar,
  readSidebarRoot,
  refuseSidebarOpen,
  setAccentColor,
  setColorScheme,
  setSidebarWidth,
  sidebarCommandId,
  sidebarState,
  uninstallTheme,
  waitForSidebarState,
} from "./driver.mjs";
import { auditSkin, contrast, measureSamples, parseColor, readOverflow } from "./skin-audit.mjs";

const HINT_MESSAGES = ["Click the qz icon in the toolbar to view.", "点击工具栏中的轻舟图标查看。"];
const HINT_TOOLTIPS = ["qz: click to open the sidebar", "轻舟：点击打开侧边栏"];
const GESTURE_ERROR = /may only be called from a user input handler/;

test.describe.configure({ mode: "serial" });

test("a temporary add-on opens the sidebar from the toolbar, not a tab", async ({ firefoxSidebar }) => {
  expect(firefoxSidebar.browserName).toBe("firefox");
  expect(firefoxSidebar.packageLabel).toBe("dist/extension-firefox");
  expect(firefoxSidebar.browserVersion).toMatch(/^Mozilla Firefox \d+\./);
  const closed = await readSidebar(firefoxSidebar);
  expect(closed.panel).not.toBe(firefoxSidebar.sidebarUrl);
  expect(closed.tabs.some(url => url.includes("/sidepanel/sidepanel.html"))).toBe(false);

  const opened = await openFromToolbar(firefoxSidebar);
  expectSidebar(opened, firefoxSidebar);
  expect(opened.button).toBe(true);

  const identity = await extensionManifest(firefoxSidebar);
  expect(identity.id).toBe(firefoxSidebar.geckoId);
  expect(identity.url.startsWith("moz-extension:")).toBe(true);
  expect(identity.url.startsWith("chrome-extension:")).toBe(false);
  expect(identity.commands).toContain("_execute_sidebar_action");
  expect(identity.commands).not.toContain("_execute_action");
  expect(identity.sidebar).toBe(firefoxManifestPath("sidepanel/sidepanel.html"));
  expect(identity.scripts).toEqual([firefoxManifestPath("background/firefox-boot.js")]);
  expect(identity.serviceWorker).toBeNull();
  expect(identity.gecko).toBe(firefoxSidebar.geckoId);
  expect(identity.themeKey).toBeNull();
  expect(identity.permissions).not.toContain("theme");

  const booted = await firefoxSidebar.extension("sidebar", `
    const doc = content.document;
    const ready = app => !!app && !app.hasAttribute("data-workspace-booting") && !app.hasAttribute("data-consent-pending");
    const started = Date.now();
    let accepted = false;
    while (Date.now() - started < 12000 && !ready(doc.querySelector("#app"))) {
      const accept = doc.querySelector("[data-consent-accept]");
      if (accept && !accepted) {
        accept.click();
        accepted = true;
      }
      await new Promise(resolve => content.setTimeout(resolve, 100));
    }
    const app = doc.querySelector("#app");
    return {
      booted: ready(app) && !!doc.querySelector("#input"),
      accepted,
      pending: app ? app.getAttribute("data-consent-pending") : "missing",
    };
  `);
  expect(booted.booted, JSON.stringify(booted)).toBe(true);
});

test("the sidebar shortcut opens the real sidebar", async ({ firefoxSidebar }) => {
  const opened = await openFromShortcut(firefoxSidebar);
  expectSidebar(opened, firefoxSidebar);
  expect(opened.key).toBe("K");
  expect(opened.modifiers).toBe("accel,shift");
});

test("text keeps 4.5:1, icons and focus rings 3:1, and disabled controls stand apart in light and dark", async ({ firefoxSidebar }) => {
  await openFromToolbar(firefoxSidebar);
  const root = await readSidebarRoot(firefoxSidebar);
  expect(root.colorScheme).toBe("light dark");
  expect(root.sheets).toContain("firefox-sidebar.css");
  const sidebars = new Set();
  try {
    for (const scheme of ["light", "dark"]) {
      await setColorScheme(firefoxSidebar, scheme);
      const audit = await auditSkin(firefoxSidebar);
      expect(audit.dark, scheme).toBe(scheme === "dark");
      sidebars.add(audit.sidebar);
      expectSkin(audit, scheme);
    }
  } finally {
    await setColorScheme(firefoxSidebar, "none");
  }
  expect(sidebars.size, "light and dark paint different sidebars").toBe(2);
});

test("the default theme keeps Firefox's own surfaces and violet accent over a macOS system accent", async ({ firefoxSidebar }) => {
  await setAccentColor(firefoxSidebar, "#007aff");
  try {
    await openFromToolbar(firefoxSidebar);
    const defaults = {
      light: { sidebar: "rgb(255, 255, 255)", primary: "rgb(118, 78, 221)" },
      dark: { sidebar: "rgb(28, 27, 34)", primary: "rgb(184, 156, 255)" },
    };
    for (const scheme of ["light", "dark"]) {
      await setColorScheme(firefoxSidebar, scheme);
      const audit = await auditSkin(firefoxSidebar);
      expect(audit.accent, "the system accent is set").toBe("rgb(0, 122, 255)");
      expect(audit.sidebar).toBe(defaults[scheme].sidebar);
      expect(audit.palette["--qz-ff-primary"]).toBe(defaults[scheme].primary);
      expectSkin(audit, `default ${scheme}`);
    }
  } finally {
    await setColorScheme(firefoxSidebar, "none");
    await setAccentColor(firefoxSidebar, null);
    await openFromToolbar(firefoxSidebar);
  }
});

test("a window theme recolors the sidebar, its popups, and the primary fill", async ({ firefoxSidebar }) => {
  const directory = mkdtempSync(join(tmpdir(), "qz-firefox-theme-"));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 2,
    name: "qz test theme",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "qz-test-theme@example.test" } },
    theme: { colors: TEST_THEME },
  }));
  await openFromToolbar(firefoxSidebar);
  const id = await installTheme(firefoxSidebar, directory);
  try {
    let root = await readSidebarRoot(firefoxSidebar);
    const started = Date.now();
    while (!root.inline["--qz-ff-sidebar"] && Date.now() - started < 4000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      root = await readSidebarRoot(firefoxSidebar);
    }
    expect(root.inline["--qz-ff-sidebar"]).toBe("rgb(42, 33, 72)");
    expect(root.inline["--qz-ff-sidebar-text"]).toBe("rgb(236, 232, 255)");
    expect(root.inline["--qz-ff-accent"]).toBe("rgb(185, 165, 255)");
    expect(root.inline["--qz-ff-focus"]).toBe("rgb(124, 240, 208)");
    expect(root.inline["--qz-ff-popup"]).toBe("rgb(246, 243, 255)");
    expect(root.inline["--qz-ff-primary-text"]).toBe("rgb(21, 20, 26)");
    expect(root.colorScheme).toBe("dark");

    const audit = await auditSkin(firefoxSidebar);
    expect(audit.sidebar).toBe("rgb(42, 33, 72)");
    expectSkin(audit, "theme");
    const popover = await readPopover(firefoxSidebar);
    expect(popover.missing).toBeUndefined();
    const surface = parseColor(popover.background).slice(0, 3);
    expect(surface).toEqual([246, 243, 255]);
    for (const color of [popover.color, popover.labelColor]) {
      const ratio = contrast(parseColor(color), surface);
      expect(ratio, `popover text ${color} on ${popover.background} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    await uninstallTheme(firefoxSidebar, id);
  }
  const cleared = await readSidebarRoot(firefoxSidebar);
  expect(cleared.inline["--qz-ff-sidebar"]).toBeUndefined();
});

test("a light-only theme in a dark sidebar follows the dark block Firefox paints, live", async ({ firefoxSidebar }) => {
  const directory = mkdtempSync(join(tmpdir(), "qz-firefox-light-theme-"));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    manifest_version: 2,
    name: "qz light test theme",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "qz-light-test-theme@example.test" } },
    theme: { colors: {
      frame: "#f8f0ec", toolbar: "rgba(255, 255, 255, 0.4)", toolbar_text: "#250e0b", tab_background_text: "#250e0b",
      toolbar_field: "#ffffff", toolbar_field_text: "#250e0b", sidebar: "#ffffff", sidebar_text: "#250e0b", sidebar_border: "#febd99",
    } },
  }));
  await openFromToolbar(firefoxSidebar);
  const id = await installTheme(firefoxSidebar, directory);
  const settle = async (expected) => {
    let root = await readSidebarRoot(firefoxSidebar);
    const started = Date.now();
    while (root.inline["--qz-ff-sidebar"] !== expected && Date.now() - started < 4000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      root = await readSidebarRoot(firefoxSidebar);
    }
    return root;
  };
  try {
    await setColorScheme(firefoxSidebar, "light");
    let root = await settle("rgb(255, 255, 255)");
    expect(root.inline["--qz-ff-sidebar"]).toBe("rgb(255, 255, 255)");
    expect(root.inline["--qz-ff-sidebar-text"]).toBe("rgb(37, 14, 11)");
    expect(root.colorScheme).toBe("light");
    expectSkin(await auditSkin(firefoxSidebar), "light-only theme light");

    await setColorScheme(firefoxSidebar, "dark");
    root = await settle("rgb(37, 14, 11)");
    expect(root.inline["--qz-ff-sidebar"], "the dark sidebar is the theme's ink").toBe("rgb(37, 14, 11)");
    expect(root.inline["--qz-ff-sidebar-text"], "the dark text is the theme's frame").toBe("rgb(248, 240, 236)");
    expect(root.inline["--qz-ff-field"]).toBeUndefined();
    expect(root.colorScheme).toBe("dark");
    const audit = await auditSkin(firefoxSidebar);
    expect(audit.sidebar).toBe("rgb(37, 14, 11)");
    expectSkin(audit, "light-only theme dark");
    const link = await firefoxSidebar.extension("sidebar", `
      const doc = content.document;
      const anchor = doc.createElement("a");
      anchor.href = "https://example.test/";
      anchor.textContent = "link";
      doc.body.append(anchor);
      const color = content.getComputedStyle(anchor).color;
      anchor.remove();
      return { color, ink: doc.documentElement.style.getPropertyValue("--qz-ff-accent-ink").trim() };
    `);
    expect(link.color, "an unstyled link takes the accent ink").toBe(link.ink);
    expect(contrast(parseColor(link.color), [37, 14, 11])).toBeGreaterThanOrEqual(4.5);
  } finally {
    await setColorScheme(firefoxSidebar, "none");
    await uninstallTheme(firefoxSidebar, id);
  }
});

test("a scrolling chat keeps message text clear of the scrollbar at 320 and 400 pixels", async ({ firefoxSidebar }) => {
  await openFromToolbar(firefoxSidebar);
  for (const width of [320, 400]) {
    const panel = await setSidebarWidth(firefoxSidebar, width);
    expect(Math.abs(panel - width), `sidebar is ${panel}px`).toBeLessThanOrEqual(4);
    const metrics = await firefoxSidebar.extension("sidebar", `
      const doc = content.document;
      const messages = doc.querySelector("#messages");
      const previous = { state: messages.dataset.chatState || "", html: messages.innerHTML, titleHidden: doc.querySelector("#session-title-bar")?.classList.contains("hidden") };
      messages.dataset.chatState = "conversation";
      const title = doc.querySelector("#session-title-bar");
      title?.classList.remove("hidden");
      messages.replaceChildren();
      for (let index = 0; index < 12; index += 1) {
        const tool = doc.createElement("div");
        tool.className = "msg msg-tool";
        const summary = doc.createElement("div");
        summary.className = "tool-summary";
        summary.textContent = "Tool row " + index + " stays clear of the scrollbar";
        tool.append(summary);
        const note = doc.createElement("div");
        note.className = "msg msg-assistant";
        const content = doc.createElement("div");
        content.className = "msg-content";
        content.textContent = "Message " + index + " wraps along the stream inset and must not meet the scrollbar.";
        note.append(content);
        messages.append(tool, note);
      }
      const style = content.getComputedStyle(messages);
      const box = messages.getBoundingClientRect();
      const rows = [...messages.querySelectorAll(".tool-summary, .msg-assistant .msg-content")];
      const gaps = rows.map(node => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left - (box.left + messages.clientLeft),
          right: box.left + messages.clientLeft + messages.clientWidth - rect.right,
        };
      });
      const result = {
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        gutter: style.scrollbarGutter,
        scrolling: messages.scrollHeight > messages.clientHeight + 1,
        minLeft: Math.min(...gaps.map(gap => gap.left)),
        minRight: Math.min(...gaps.map(gap => gap.right)),
      };
      messages.innerHTML = previous.html;
      if (previous.state) messages.dataset.chatState = previous.state;
      else delete messages.dataset.chatState;
      if (previous.titleHidden) title?.classList.add("hidden");
      return result;
    `);
    const label = `${width}px ${JSON.stringify(metrics)}`;
    expect(metrics.scrolling, label).toBe(true);
    expect(metrics.paddingLeft, label).toBe("14px");
    expect(metrics.paddingRight, label).toBe("14px");
    expect(metrics.gutter, label).toBe("stable both-edges");
    expect(metrics.minLeft, label).toBeGreaterThanOrEqual(13);
    expect(metrics.minRight, label).toBeGreaterThanOrEqual(13);
  }
});

test("the sidebar has no horizontal overflow at 320 and 400 pixels", async ({ firefoxSidebar }) => {
  await openFromToolbar(firefoxSidebar);
  for (const width of [320, 400]) {
    const panel = await setSidebarWidth(firefoxSidebar, width);
    expect(Math.abs(panel - width), `sidebar is ${panel}px`).toBeLessThanOrEqual(4);
    for (const settings of [false, true]) {
      const layout = await readOverflow(firefoxSidebar, { settings });
      const label = `${width}px ${settings ? "settings" : "chat"}: ${JSON.stringify(layout)}`;
      expect(layout.settings, label).toBe(settings);
      expect(layout.scrollWidth, label).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.bodyScrollWidth, label).toBeLessThanOrEqual(layout.width);
      expect(layout.offenders, label).toEqual([]);
    }
  }
  await readOverflow(firefoxSidebar, { settings: false });
});

test("creating a notification without requireInteraction does not throw", async ({ firefoxSidebar }) => {
  const plain = await createNotification(firefoxSidebar, "qz-firefox-plain", {
    type: "basic",
    title: "qz",
    message: "plain",
  });
  expect(plain.error || "", JSON.stringify(plain)).toBe("");
  expect(plain.marked).toBe(true);
  expect(plain.created).toBe("qz-firefox-plain");

  const sticky = await createNotification(firefoxSidebar, "qz-firefox-sticky", {
    type: "basic",
    title: "qz",
    message: "sticky",
    requireInteraction: true,
    priority: 1,
  });
  // Firefox rejects requireInteraction before showAlert. A returned id means the wrapper removed it.
  expect(sticky.error || "", JSON.stringify(sticky)).toBe("");
  expect(sticky.marked).toBe(true);
  expect(sticky.created).toBe("qz-firefox-sticky");
});

test("a refused sidebar open sets the badge, the toolbar hint, and the real error", async ({ firefoxSidebar }) => {
  await keepNotifications(firefoxSidebar);
  await captureBackgroundErrors(firefoxSidebar);
  await hideSidebars(firefoxSidebar);
  const before = await sidebarState(firefoxSidebar);
  const prompt = await refuseSidebarOpen(firefoxSidebar);
  expect(prompt.openError).toMatch(/only from the toolbar button, the sidebar shortcut, or a menu item/);
  expect(prompt.openError).toMatch(GESTURE_ERROR);
  expect(prompt.requireInteraction).toBe(false);
  expect(HINT_MESSAGES).toContain(prompt.message);
  expect(["qz", "轻舟"]).toContain(prompt.title);
  const state = await waitForSidebarState(firefoxSidebar, next => next.badge === "!");
  expect(state.badge).toBe("!");
  expect(HINT_TOOLTIPS).toContain(state.title);
  expect(state.notifications).toContain("qz-open-sidebar");
  expect(state.diagnostics.refused).toBe(before.diagnostics.refused + 1);
  expect(state.diagnostics.notified).toBe(before.diagnostics.notified + 1);
  expect(state.diagnostics.lastSource).toBe("api");
  expect(state.diagnostics.lastError).toMatch(GESTURE_ERROR);
  expect(state.errors.at(-1)).toMatch(/firefox sidebarAction failed \(api\):.*may only be called from a user input handler/);
});

test("clicking the hint notification logs Firefox's error and raises no second notification", async ({ firefoxSidebar }) => {
  const before = await sidebarState(firefoxSidebar);
  expect(before.notifications).toContain("qz-open-sidebar");
  const clicked = await clickNotification(firefoxSidebar, "qz-open-sidebar");
  expect(clicked.clicked, JSON.stringify(clicked)).toBe(true);
  const state = await waitForSidebarState(firefoxSidebar, next => next.diagnostics.notificationClicks > before.diagnostics.notificationClicks
    && next.diagnostics.refused > before.diagnostics.refused);
  expect(state.diagnostics.notificationClicks).toBe(before.diagnostics.notificationClicks + 1);
  expect(state.diagnostics.lastSource).toBe("notification");
  expect(state.diagnostics.lastError).toMatch(GESTURE_ERROR);
  expect(state.diagnostics.opened).toBe(before.diagnostics.opened);
  expect(state.diagnostics.notified).toBe(before.diagnostics.notified);
  expect(state.notifications).not.toContain("qz-open-sidebar");
  expect(state.badge, "the badge keeps pointing at the toolbar button").toBe("!");
  expect(state.errors.at(-1)).toMatch(/firefox sidebarAction failed \(notification\):.*may only be called from a user input handler/);
  const sidebar = await readSidebar(firefoxSidebar);
  expect(sidebar.panel).not.toBe(firefoxSidebar.sidebarUrl);
});

test("a completion notification click that tries to open the sidebar raises no notification", async ({ firefoxSidebar }) => {
  await keepNotifications(firefoxSidebar);
  await addNotificationOpener(firefoxSidebar, "qz-test-done");
  const before = await sidebarState(firefoxSidebar);
  const clicked = await clickNotification(firefoxSidebar, "qz-test-done");
  expect(clicked.clicked, JSON.stringify(clicked)).toBe(true);
  const state = await waitForSidebarState(firefoxSidebar, next => next.diagnostics.refused > before.diagnostics.refused);
  await new Promise(resolve => setTimeout(resolve, 500));
  const settled = await sidebarState(firefoxSidebar);
  expect(state.diagnostics.lastSource).toBe("notification");
  expect(settled.diagnostics.notified).toBe(before.diagnostics.notified);
  expect(settled.notifications).not.toContain("qz-open-sidebar");
  expect((await notificationOpens(firefoxSidebar)).at(-1)).toMatch(/only from the toolbar button/);
});

test("opening the sidebar by shortcut, switcher, or toolbar clears the badge and re-arms the hint", async ({ firefoxSidebar }) => {
  await keepNotifications(firefoxSidebar);
  const openers = [["shortcut", openFromShortcut], ["switcher", openFromSwitcher], ["toolbar", openFromToolbar]];
  for (const [route, open] of openers) {
    await hideSidebars(firefoxSidebar);
    const before = await sidebarState(firefoxSidebar);
    if (before.badge !== "!") {
      await refuseSidebarOpen(firefoxSidebar);
      const prompted = await waitForSidebarState(firefoxSidebar, next => next.badge === "!");
      expect(prompted.badge, `${route} prompt`).toBe("!");
      expect(prompted.diagnostics.notified, `${route} re-arms the hint`).toBe(before.diagnostics.notified + 1);
    }
    const opened = await open(firefoxSidebar);
    expect(opened.panel, route).toBe(firefoxSidebar.sidebarUrl);
    const cleared = await waitForSidebarState(firefoxSidebar, next => next.badge === "");
    expect(cleared.badge, `${route} clears the badge`).toBe("");
    expect(HINT_TOOLTIPS, `${route} restores the tooltip`).not.toContain(cleared.title);
    expect(cleared.notifications).not.toContain("qz-open-sidebar");
  }
});

test("a refused open while the sidebar is showing leaves no badge", async ({ firefoxSidebar }) => {
  await openFromToolbar(firefoxSidebar);
  const before = await sidebarState(firefoxSidebar);
  expect(before.badge).toBe("");
  const prompt = await refuseSidebarOpen(firefoxSidebar);
  expect(prompt.openError).toMatch(GESTURE_ERROR);
  await new Promise(resolve => setTimeout(resolve, 500));
  const state = await sidebarState(firefoxSidebar);
  expect(state.diagnostics.refused).toBe(before.diagnostics.refused + 1);
  expect(state.badge).toBe("");
  expect(state.diagnostics.notified).toBe(before.diagnostics.notified);
});

function expectSidebar(snapshot, session) {
  expect(snapshot.panel).toBe(session.sidebarUrl);
  expect(snapshot.current).toBe(sidebarCommandId(session.geckoId));
  expect(snapshot.tabs).not.toContain(session.sidebarUrl);
  expect(snapshot.tabs.some(url => String(url).includes("/sidepanel/sidepanel.html"))).toBe(false);
}

function expectSkin(audit, label) {
  const missing = audit.samples.filter(sample => sample.missing).map(sample => sample.name);
  expect(missing, `${label} missing samples`).toEqual([]);
  const measured = measureSamples(audit);
  const find = (name, state = "rest") => measured.find(sample => sample.name === name && sample.state === state);
  for (const sample of measured) {
    const floor = sample.kind === "icon" ? 3 : 4.5;
    const detail = `${label} ${sample.name} ${sample.state}: ${sample.ratio.toFixed(2)}:1 for ${sample.ink} on ${sample.background}`;
    expect(sample.ratio, detail).toBeGreaterThanOrEqual(floor);
    if (sample.state === ":focus-visible") expect(sample.ring, `${label} ${sample.name} focus ring ${sample.ring}`).toBeGreaterThanOrEqual(3);
  }
  for (const state of ["rest", ":hover", ":active"]) {
    expect(find("primary", state).ratio, `${label} primary ${state}`).toBeGreaterThanOrEqual(4.5);
    expect(find("send", state).ratio, `${label} send ${state}`).toBeGreaterThanOrEqual(4.5);
  }
  for (const [enabled, disabled] of [["primary", "primary disabled"], ["send", "send disabled"]]) {
    const on = find(enabled);
    const off = find(disabled);
    expect(off.cursor, `${label} ${disabled} cursor`).toBe("not-allowed");
    expect(distance(on.background, off.background), `${label} ${disabled} surface ${off.background} vs ${on.background}`).toBeGreaterThan(60);
    expect(chroma(off.background), `${label} ${disabled} surface is neutral`).toBeLessThanOrEqual(chroma(parseColor(audit.sidebar)) + 12);
  }
  expect(find("send disabled").ratio, `${label} send disabled mark`).toBeGreaterThanOrEqual(4.5);
  expect(find("primary disabled").ratio, `${label} primary disabled label`).toBeGreaterThanOrEqual(4.5);
}

function distance(first, second) {
  return Math.hypot(...first.map((channel, index) => channel - second[index]));
}

function chroma(rgb) {
  const channels = rgb.slice(0, 3);
  return Math.max(...channels) - Math.min(...channels);
}

function firefoxManifestPath(path) {
  return `moz-extension://${FIREFOX_EXTENSION_UUID}/${path}`;
}

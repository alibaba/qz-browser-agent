import { test, expect } from "./fixture.mjs";
import { hideSidebars, sidebarCommandId } from "./driver.mjs";
import { widgetId } from "./launch.mjs";
import { FIREFOX_TOOLBAR_ICON } from "../../scripts/firefox-manifest.mjs";

const THEMES = [
  { name: "light", id: "firefox-compact-light@mozilla.org" },
  { name: "dark", id: "firefox-compact-dark@mozilla.org" },
];

test("the toolbar button and sidebar switcher draw the glyph in the light or dark theme ink", async ({ firefoxSidebar }) => {
  const toolbarId = `${widgetId(firefoxSidebar.geckoId)}-browser-action`;
  const commandId = sidebarCommandId(firefoxSidebar.geckoId);
  try {
    for (const theme of THEMES) {
      const drawn = await firefoxSidebar.chrome(`
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        // Firefox 151 keeps the launcher strip off until revamp is set, then hides it until a panel is shown.
        if (!Services.prefs.getBoolPref("sidebar.revamp")) Services.prefs.setBoolPref("sidebar.revamp", true);
        const revampReady = Date.now();
        while (Date.now() - revampReady < 2000 && Services.prefs.getStringPref("sidebar.visibility", "") !== "hide-sidebar") {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await (await AddonManager.getAddonByID(${JSON.stringify(theme.id)})).enable();
        const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
        win.SidebarController.show("viewCustomizeSidebar");
        const find = (root, selector) => {
          if (!root) return null;
          for (const el of root.querySelectorAll("*")) {
            if (el.matches(selector)) return el;
            const inner = el.shadowRoot && find(el.shadowRoot, selector);
            if (inner) return inner;
          }
          return null;
        };
        const ink = el => {
          const rect = el.getBoundingClientRect();
          const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
          canvas.width = Math.ceil(rect.width);
          canvas.height = Math.ceil(rect.height);
          const context = canvas.getContext("2d");
          context.drawWindow(win, rect.left, rect.top, rect.width, rect.height, "rgb(127,127,127)");
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const lums = [];
          for (let i = 0; i < data.length; i += 4) lums.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
          const background = lums[0];
          return { min: Math.min(...lums), max: Math.max(...lums), coverage: lums.filter(lum => Math.abs(lum - background) > 60).length / lums.length };
        };
        const started = Date.now();
        let launcher = null;
        while (Date.now() - started < 5000) {
          launcher = find(win.document.querySelector("sidebar-main")?.shadowRoot, ${JSON.stringify(`moz-button[view="${commandId}"]`)});
          if (launcher?.getBoundingClientRect().width) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        const toolbarIcon = win.document.getElementById(${JSON.stringify(toolbarId)}).querySelector(".toolbarbutton-icon");
        return {
          dark: win.matchMedia("(prefers-color-scheme: dark)").matches,
          toolbarImage: win.getComputedStyle(toolbarIcon).listStyleImage,
          launcherIcon: launcher?.iconSrc || "",
          toolbar: ink(toolbarIcon),
          launcher: ink(launcher.shadowRoot.querySelector("img")),
        };
      `);
      expect(drawn.dark, theme.name).toBe(theme.name === "dark");
      expect(drawn.toolbarImage).toContain(FIREFOX_TOOLBAR_ICON);
      expect(drawn.launcherIcon).toContain(FIREFOX_TOOLBAR_ICON);
      for (const surface of [drawn.toolbar, drawn.launcher]) {
        if (theme.name === "light") expect(surface.min, `${theme.name} ink`).toBeLessThan(60);
        else expect(surface.max, `${theme.name} ink`).toBeGreaterThan(220);
        expect(surface.coverage, `${theme.name} glyph, not a filled tile`).toBeGreaterThan(0.1);
        expect(surface.coverage, `${theme.name} glyph, not a filled tile`).toBeLessThan(0.7);
      }
    }
  } finally {
    await firefoxSidebar.chrome(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID("default-theme@mozilla.org")).enable();
      Services.prefs.clearUserPref("sidebar.revamp");
      Services.prefs.clearUserPref("sidebar.visibility");
      return true;
    `);
    await hideSidebars(firefoxSidebar);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIREFOX_THEME_PROPERTIES,
  FIREFOX_TEXT_TIERS,
  applyFirefoxPalette,
  applyFirefoxTheme,
  deriveFirefoxSidebarTheme,
  firefoxThemeColor,
  firefoxThemeIsDark,
  installFirefoxTheme,
  parseFirefoxThemeColor,
} from "../../src/sidepanel/firefox/theme.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const PALETTE_PROPERTIES = [
  "--qz-ff-primary", "--qz-ff-primary-hover", "--qz-ff-primary-active", "--qz-ff-primary-text", "--qz-ff-accent-ink",
  ...FIREFOX_TEXT_TIERS.map(([property]) => property),
];

function styleRoot() {
  const props = new Map();
  return {
    style: {
      setProperty(name, value) { props.set(name, value); },
      removeProperty(name) { props.delete(name); },
    },
    get(name) { return props.get(name); },
  };
}

/** Sidebar, popup, and field share one surface and text; the accent and its label are separate. */
function sourceColors(sidebar, text, accent, accentText = "rgb(255, 255, 255)") {
  return {
    "--qz-ff-accent": accent,
    "--qz-ff-accent-text": accentText,
    "--qz-ff-sidebar": sidebar,
    "--qz-ff-sidebar-text": text,
    "--qz-ff-popup": sidebar,
    "--qz-ff-popup-text": text,
    "--qz-ff-field": sidebar,
    "--qz-ff-field-text": text,
  };
}

/** A sidebar root whose probe resolves var(--name) from `colors`, the way Firefox computes the skin variables. */
function paletteRoot(colors, scheme = { matches: false }) {
  const root = styleRoot();
  const listeners = { load: [], focus: [], change: [] };
  const view = {
    getComputedStyle(element) {
      if (element === root) return { color: "", getPropertyValue: name => (name === "--qz-ff-accent" && colors["--qz-ff-accent"] ? "AccentColor" : "") };
      const name = /^var\((--[\w-]+)\)$/.exec(element.style.color)?.[1];
      return { color: colors[name] ?? "", getPropertyValue: () => "" };
    },
    matchMedia: () => Object.assign(scheme, { addEventListener: (type, listener) => listeners.change.push(listener) }),
    addEventListener: (type, listener) => listeners[type].push(listener),
  };
  root.probes = 0;
  root.ownerDocument = {
    defaultView: view,
    createElement() { return { style: { cssText: "", color: "" }, remove() { root.probes -= 1; } }; },
  };
  root.appendChild = () => { root.probes += 1; };
  root.listeners = listeners;
  return root;
}

test("firefox theme colors accept hex, functions, names, and rgb arrays", () => {
  assert.equal(firefoxThemeColor("  #00ddff "), "#00ddff");
  assert.equal(firefoxThemeColor("#abc"), "#abc");
  assert.equal(firefoxThemeColor("rgb(1, 2, 3)"), "rgb(1, 2, 3)");
  assert.equal(firefoxThemeColor("hsl(200 80% 40%)"), "hsl(200 80% 40%)");
  assert.equal(firefoxThemeColor("rebeccapurple"), "rebeccapurple");
  assert.equal(firefoxThemeColor([10, 20, 30]), "rgb(10, 20, 30)");
  assert.equal(firefoxThemeColor([10, 20, 30, 0.5]), "rgba(10, 20, 30, 0.5)");
  assert.equal(firefoxThemeColor("red;background:url(https://evil)"), undefined);
  assert.equal(firefoxThemeColor("url(#fff)"), undefined);
  assert.equal(firefoxThemeColor("#12"), undefined);
  assert.equal(firefoxThemeColor([1, 2]), undefined);
  assert.equal(firefoxThemeColor([1, 2, 3, 2]), undefined);
  assert.equal(firefoxThemeColor([1.5, 2, 3]), undefined);
});

test("theme colors parse hex, rgb, and hsl into sRGB channels", () => {
  assert.deepEqual(parseFirefoxThemeColor("#0af"), [0, 170, 255, 1]);
  assert.deepEqual(parseFirefoxThemeColor("#0061e080"), [0, 97, 224, 128 / 255]);
  assert.deepEqual(parseFirefoxThemeColor("rgb(0, 122, 255)"), [0, 122, 255, 1]);
  assert.deepEqual(parseFirefoxThemeColor("rgba(0 122 255 / 50%)"), [0, 122, 255, 0.5]);
  assert.deepEqual(parseFirefoxThemeColor("rgb(100%, 0%, 50%)"), [255, 0, 128, 1]);
  assert.deepEqual(parseFirefoxThemeColor("hsl(0, 100%, 50%)"), [255, 0, 0, 1]);
  assert.deepEqual(parseFirefoxThemeColor("color(srgb 0.28 0.28 0.28)"), [71, 71, 71, 1]);
  assert.deepEqual(parseFirefoxThemeColor("color(srgb 0 0 0 / 0.14)"), [0, 0, 0, 0.14]);
  assert.equal(parseFirefoxThemeColor("color(display-p3 0 0 0)"), undefined);
  assert.equal(parseFirefoxThemeColor("rebeccapurple"), undefined);
  assert.equal(parseFirefoxThemeColor("rgb(1, 2)"), undefined);
  assert.equal(parseFirefoxThemeColor("hsl(10, 20, 30)"), undefined);
});

test("an empty firefox theme removes color overrides", () => {
  const root = styleRoot();
  applyFirefoxTheme(root, { colors: { sidebar: "#112233", sidebar_highlight: "#00ddff" } });
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(17, 34, 51)");
  assert.equal(root.get("--qz-ff-accent-text"), "rgb(21, 20, 26)");
  assert.equal(root.get("color-scheme"), "dark");
  const builtIn = [{ colors: null, images: null, properties: null }, { colors: null, properties: { color_scheme: "dark" } }];
  for (const theme of [undefined, null, {}, { colors: null }, { colors: {} }, { images: {} }, { colors: { frame: "url(x)" } }, ...builtIn]) {
    assert.equal(applyFirefoxTheme(root, theme, { dark: true }), false);
    for (const property of FIREFOX_THEME_PROPERTIES) assert.equal(root.get(property), undefined, `${JSON.stringify(theme)} keeps the stylesheet's Firefox defaults`);
    assert.equal(root.get("color-scheme"), undefined);
  }
});

test("a theme palette maps the sidebar, focus, field, and popup keys like Firefox's sidebar", () => {
  const root = styleRoot();
  const colors = {
    frame: "#3b2f63",
    toolbar: [42, 33, 72],
    sidebar: [42, 33, 72, 0.4],
    sidebar_text: "#fbfbfe",
    sidebar_border: "rgba(255, 255, 255, 0.2)",
    sidebar_highlight: "#b9a5ff",
    focus_outline: "#00ddff",
    toolbar_field: "#423a66",
    toolbar_field_text: "white",
    toolbar_field_border: "#5b5285",
    popup: "#f6f3ff",
    popup_border: "#c6bddc",
  };
  const named = { white: [255, 255, 255, 1] };
  assert.equal(applyFirefoxTheme(root, { colors }, { resolve: color => parseFirefoxThemeColor(color) ?? named[color] }), true);
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(42, 33, 72)", "Firefox paints the sidebar opaque");
  assert.equal(root.get("--qz-ff-sidebar-text"), "rgb(251, 251, 254)");
  assert.equal(root.get("--qz-ff-sidebar-border"), "rgba(255, 255, 255, 0.2)");
  assert.equal(root.get("--qz-ff-accent"), "rgb(185, 165, 255)");
  assert.equal(root.get("--qz-ff-accent-text"), "rgb(21, 20, 26)");
  assert.equal(root.get("--qz-ff-focus"), "rgb(0, 221, 255)");
  assert.equal(root.get("--qz-ff-field"), "rgb(66, 58, 102)");
  assert.equal(root.get("--qz-ff-field-text"), "rgb(255, 255, 255)", "named colors resolve through the page");
  assert.equal(root.get("--qz-ff-field-border"), "rgb(91, 82, 133)");
  assert.equal(root.get("--qz-ff-popup"), "rgb(246, 243, 255)");
  assert.equal(root.get("--qz-ff-popup-text"), "rgb(21, 20, 26)");
  assert.equal(root.get("--qz-ff-popup-border"), "rgb(198, 189, 220)");
  assert.equal(root.get("--qz-ff-frame"), undefined);
  assert.equal(root.get("--qz-ff-toolbar"), undefined);
  assert.equal(root.get("color-scheme"), "dark");

  applyFirefoxTheme(root, { theme: { colors: { sidebar_highlight: "#0061e0", sidebar_text: "#15141a" } } });
  assert.equal(root.get("--qz-ff-accent"), "rgb(0, 97, 224)");
  assert.equal(root.get("--qz-ff-accent-text"), "rgb(251, 251, 254)");
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(255, 255, 255)", "a theme without a surface keeps Firefox's light sidebar");
  assert.equal(root.get("--qz-ff-sidebar-text"), "rgb(21, 20, 26)");
  assert.equal(root.get("--qz-ff-focus"), undefined, "the focus ring stays Firefox's accent");
  assert.equal(root.get("color-scheme"), "light");

  applyFirefoxTheme(root, { colors: { sidebar: "#f9f9fb" } });
  assert.equal(root.get("color-scheme"), "light");
  assert.equal(root.get("--qz-ff-accent"), undefined, "the accent stays Firefox's violet");
});

/** Firefox 158's Spark theme: theme.getCurrent() returns this light block, never its dark_theme. */
const SPARK_LIGHT = {
  frame: [248, 240, 236], toolbar: [255, 255, 255, 0.4], toolbar_text: [37, 14, 11], icons: [112, 28, 7],
  tab_selected: [255, 255, 255], tab_text: [37, 14, 11], tab_background_text: [37, 14, 11], tab_line: [255, 149, 101],
  toolbar_field: [255, 255, 255], toolbar_field_text: [37, 14, 11], toolbar_field_border: [0, 0, 0, 0.14],
  popup_highlight: [244, 104, 44], sidebar: [255, 255, 255], sidebar_text: [37, 14, 11], sidebar_border: [254, 189, 153],
};

test("a dark sidebar with a light theme block derives the dark block Firefox paints", () => {
  assert.equal(firefoxThemeIsDark(parsed(SPARK_LIGHT)), false, "a translucent toolbar defers to the dark toolbar text");
  const root = styleRoot();
  applyFirefoxTheme(root, { colors: SPARK_LIGHT }, { dark: true });
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(37, 14, 11)", "Spark's dark sidebar is its light ink");
  assert.equal(root.get("--qz-ff-sidebar-text"), "rgb(248, 240, 236)", "Spark's dark text is its light frame");
  assert.equal(root.get("color-scheme"), "dark");
  for (const property of ["--qz-ff-sidebar-border", "--qz-ff-field", "--qz-ff-field-text", "--qz-ff-field-border", "--qz-ff-popup", "--qz-ff-accent", "--qz-ff-focus"]) {
    assert.equal(root.get(property), undefined, `${property} is derived by the stylesheet from the dark surface`);
  }

  applyFirefoxTheme(root, { colors: SPARK_LIGHT }, { dark: false });
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(255, 255, 255)");
  assert.equal(root.get("--qz-ff-sidebar-text"), "rgb(37, 14, 11)");
  assert.equal(root.get("--qz-ff-sidebar-border"), "rgb(254, 189, 153)");
  assert.equal(root.get("--qz-ff-field"), "rgb(255, 255, 255)");
  assert.equal(root.get("--qz-ff-field-border"), "rgba(0, 0, 0, 0.14)");
  assert.equal(root.get("--qz-ff-accent"), undefined, "Spark sets no sidebar_highlight, so Firefox's accent stays");
  assert.equal(root.get("color-scheme"), "light");

  const alpenglow = deriveFirefoxSidebarTheme(parsed({ frame: "#ffc999", toolbar: "hsla(0, 0%, 100%, .76)", toolbar_text: "hsla(258, 66%, 48%, 1)", sidebar: "rgb(255, 255, 255)", sidebar_text: "hsla(261, 53%, 15%, 1)", sidebar_highlight: "hsla(265, 100%, 72%, 1)", focus_outline: "hsla(258, 65%, 48%, 1)" }), { dark: true });
  assert.equal(alpenglow.derived, true);
  assert.equal(alpenglow.properties["--qz-ff-sidebar"], "rgb(32, 18, 59)");
  const surface = parseFirefoxThemeColor(alpenglow.properties["--qz-ff-sidebar"]);
  const text = parseFirefoxThemeColor(alpenglow.properties["--qz-ff-sidebar-text"]);
  assert.ok(luminance(text) >= 0.8, "a saturated frame is lifted toward white before it becomes text");
  assert.ok(contrast(text, surface) >= 4.5);
  assert.ok(contrast(parseFirefoxThemeColor(alpenglow.properties["--qz-ff-focus"]), surface) >= 3, "a light block's focus outline is lifted for the dark surface");
  assert.equal(alpenglow.properties["--qz-ff-accent"], "rgb(172, 112, 255)");

  assert.equal(deriveFirefoxSidebarTheme(parsed({ tab_line: "#ff0000" }), { dark: true }).properties["--qz-ff-sidebar"], "rgb(28, 27, 34)", "no ink falls back to Firefox's dark sidebar");
  const declared = deriveFirefoxSidebarTheme(parsed(SPARK_LIGHT), { dark: true, colorScheme: "dark" });
  assert.equal(declared.derived, false, "a theme that declares a dark scheme is painted as given");
});

test("a theme without sidebar keys derives the sidebar from its toolbar, tabs, and frame", () => {
  const night = deriveFirefoxSidebarTheme(parsed({ frame: "#0b1e2d", tab_background_text: "#9ff7e6", toolbar: "#12324a", toolbar_text: "#c8fff4", toolbar_field: "#0e2a3e", toolbar_field_text: "#e6fffa", tab_line: "#2ef2c4", popup: "#0e2a3e", popup_text: "#e6fffa" }), { dark: true });
  assert.deepEqual(night, {
    scheme: "dark",
    derived: false,
    properties: {
      "--qz-ff-sidebar": "rgb(18, 50, 74)",
      "--qz-ff-sidebar-text": "rgb(200, 255, 244)",
      "--qz-ff-field": "rgb(14, 42, 62)",
      "--qz-ff-field-text": "rgb(230, 255, 250)",
      "--qz-ff-popup": "rgb(14, 42, 62)",
      "--qz-ff-popup-text": "rgb(230, 255, 250)",
    },
  });
  const paper = deriveFirefoxSidebarTheme(parsed({ frame: "#f6e7a8", tab_background_text: "#3a2a00", toolbar: "rgba(255, 255, 255, 0.5)", toolbar_text: "#4a3500" }));
  assert.equal(paper.scheme, "light");
  assert.equal(paper.properties["--qz-ff-sidebar"], "rgb(251, 243, 212)", "a translucent toolbar is composited over the frame");
  assert.equal(paper.properties["--qz-ff-sidebar-text"], "rgb(74, 53, 0)");
  assert.equal(deriveFirefoxSidebarTheme(parsed({ frame: "#2b2a33", tab_selected: "#42414d", tab_text: "#fbfbfe" })).properties["--qz-ff-sidebar"], "rgb(66, 65, 77)");
  assert.equal(deriveFirefoxSidebarTheme(parsed({ frame: "#203040", tab_background_text: "#ffffff" })).properties["--qz-ff-sidebar"], "rgb(32, 48, 64)");
  assert.equal(deriveFirefoxSidebarTheme(parsed({ frame: "#203040", tab_background_text: "#ffffff" })).scheme, "dark");
});

test("low-contrast theme colors are raised to 4.5:1 text and 3:1 focus rings", () => {
  const samples = [
    { sidebar: "#777777", sidebar_text: "#888888", toolbar_field: "#808080", toolbar_field_text: "#8a8a8a", popup: "#f0f0f0", popup_text: "#e0e0e0", focus_outline: "#7a7a7a" },
    { sidebar: "#1a1a2e", sidebar_text: "#2a2a40", toolbar_field: "rgba(255, 255, 255, 0.05)", toolbar_field_text: "#333344", focus_outline: "#20203a" },
    { sidebar: "#fffbe0", sidebar_text: "#fff0a0", popup: "#202020", popup_text: "#303030", focus_outline: "#fff8c0" },
    { frame: "#ff9900", toolbar_text: "#ffaa33" },
  ];
  for (const colors of samples) {
    for (const dark of [false, true]) {
      const { properties } = deriveFirefoxSidebarTheme(parsed(colors), { dark });
      const surface = parseFirefoxThemeColor(properties["--qz-ff-sidebar"]);
      const label = `${JSON.stringify(colors)} dark=${dark}`;
      assert.ok(contrast(parseFirefoxThemeColor(properties["--qz-ff-sidebar-text"]), surface) >= 4.5, `${label} body text`);
      if (properties["--qz-ff-field"]) {
        const field = parseFirefoxThemeColor(properties["--qz-ff-field"]);
        const flat = [0, 1, 2].map(index => Math.round(field[index] * field[3] + surface[index] * (1 - field[3])));
        assert.ok(contrast(parseFirefoxThemeColor(properties["--qz-ff-field-text"]), flat) >= 4.5, `${label} field text`);
      }
      if (properties["--qz-ff-popup"]) {
        assert.ok(contrast(parseFirefoxThemeColor(properties["--qz-ff-popup-text"]), parseFirefoxThemeColor(properties["--qz-ff-popup"])) >= 4.5, `${label} popup text`);
      }
      if (properties["--qz-ff-focus"]) assert.ok(contrast(parseFirefoxThemeColor(properties["--qz-ff-focus"]), surface) >= 3, `${label} focus ring`);
    }
  }
});

test("a color-scheme flip repaints the window theme without a reload", async () => {
  const scheme = { matches: false };
  const root = paletteRoot(sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", "rgb(118, 78, 221)"), scheme);
  installFirefoxTheme({
    windows: { async getCurrent() { return { id: 2 }; } },
    theme: { getCurrent: () => ({ colors: SPARK_LIGHT }), onUpdated: { addListener() {} } },
  }, root);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(255, 255, 255)");
  scheme.matches = true;
  root.listeners.change[0]();
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(37, 14, 11)");
  assert.equal(root.get("color-scheme"), "dark");
  scheme.matches = false;
  root.listeners.change[0]();
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(255, 255, 255)");
});

test("the palette is written from the resolved colors and cleared when the accent is unknown", () => {
  const root = paletteRoot(sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", "rgb(0, 122, 255)"));
  assert.equal(applyFirefoxPalette(root), true);
  assert.equal(root.probes, 0, "the probe element is removed");
  assert.equal(root.get("--qz-ff-primary"), "rgb(0, 112, 235)");
  assert.equal(root.get("--qz-ff-primary-text"), "rgb(255, 255, 255)");
  assert.equal(root.get("--qz-ff-primary-hover"), "rgb(0, 99, 207)");
  assert.equal(root.get("--qz-ff-primary-active"), "rgb(0, 87, 183)");
  assert.equal(root.get("--qz-ff-accent-ink"), "rgb(0, 105, 219)");
  assert.equal(root.get("--qz-ff-text-deemphasized"), "rgb(71, 71, 71)", "system colors keep the stylesheet's 72% share");
  assert.equal(root.get("--qz-ff-text-muted"), "rgb(97, 97, 97)", "a share above 60% keeps the active fill readable");
  assert.equal(root.get("--qz-ff-field-text-deemphasized"), "rgb(71, 71, 71)");
  assert.equal(root.get("--qz-ff-field-placeholder"), "rgb(102, 102, 102)");

  const unknown = paletteRoot(sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", ""));
  for (const property of PALETTE_PROPERTIES) unknown.style.setProperty(property, "red");
  assert.equal(applyFirefoxPalette(unknown), false);
  for (const property of PALETTE_PROPERTIES) assert.equal(unknown.get(property), undefined, `${property} falls back to the stylesheet`);

  const unparsed = paletteRoot(sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", "color(display-p3 0 0.5 1)"));
  assert.equal(applyFirefoxPalette(unparsed), false);
  assert.equal(unparsed.probes, 0);
  for (const property of PALETTE_PROPERTIES) assert.equal(unparsed.get(property), undefined);

  assert.equal(applyFirefoxPalette(styleRoot()), false, "a root without a document keeps the stylesheet fallback");
});

test("a low-contrast theme raises each text tier until it keeps 4.5:1", () => {
  const colors = {
    ...sourceColors("rgb(244, 236, 216)", "rgb(60, 47, 30)", "rgb(185, 165, 255)", "rgb(21, 20, 26)"),
    "--qz-ff-popup": "rgb(28, 27, 34)",
    "--qz-ff-popup-text": "rgb(251, 251, 254)",
    "--qz-ff-field": "rgba(255, 255, 255, 0.5)",
  };
  const root = paletteRoot(colors);
  assert.equal(applyFirefoxPalette(root), true);
  assert.equal(root.get("--qz-ff-primary"), "rgb(185, 165, 255)");
  assert.equal(root.get("--qz-ff-primary-text"), "rgb(21, 20, 26)");
  assert.equal(root.get("--qz-ff-text-deemphasized"), "rgb(99, 87, 69)");
  assert.equal(root.get("--qz-ff-text-muted"), "rgb(102, 90, 73)");
  assert.equal(root.get("--qz-ff-popup-text-deemphasized"), "rgb(189, 188, 192)", "popups use their own surface and text");
  assert.equal(root.get("--qz-ff-popup-text-muted"), "rgb(162, 161, 166)");
  assert.equal(root.get("--qz-ff-field-text-deemphasized"), "rgb(104, 93, 77)");
  assert.equal(root.get("--qz-ff-field-placeholder"), "rgb(119, 109, 94)", "a translucent field is composited over the sidebar");

  const computed = paletteRoot({
    ...sourceColors("color(srgb 0.11 0.105 0.133)", "color(srgb 0.984 0.984 0.996)", "rgb(0, 96, 223)"),
    "--qz-ff-field": "color(srgb 0.17 0.165 0.19 / 0.9)",
  });
  assert.equal(applyFirefoxPalette(computed), true, "computed color(srgb) values parse");
  assert.equal(computed.get("--qz-ff-text-muted"), "rgb(162, 161, 166)");
  assert.equal(computed.get("--qz-ff-field-placeholder"), "rgb(167, 167, 171)");
});

test("the palette follows theme updates, color-scheme changes, and window focus", async () => {
  const colors = sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", "rgb(0, 96, 223)");
  const root = paletteRoot(colors);
  let listener;
  installFirefoxTheme({
    windows: { async getCurrent() { return { id: 1 }; } },
    theme: { getCurrent: () => ({}), onUpdated: { addListener(fn) { listener = fn; } } },
  }, root);
  assert.equal(root.get("--qz-ff-primary"), "rgb(0, 96, 223)");
  assert.equal(root.listeners.load.length, 0, "a resolved stylesheet needs no load listener");
  assert.equal(root.listeners.change.length, 1);
  assert.equal(root.listeners.focus.length, 1);
  await new Promise(resolve => setTimeout(resolve, 0));

  colors["--qz-ff-accent"] = "rgb(185, 165, 255)";
  listener({ theme: { colors: { sidebar_highlight: "#b9a5ff" } }, windowId: 1 });
  assert.equal(root.get("--qz-ff-accent"), "rgb(185, 165, 255)");
  assert.equal(root.get("--qz-ff-primary-text"), "rgb(21, 20, 26)");

  Object.assign(colors, sourceColors("rgb(28, 27, 34)", "rgb(251, 251, 254)", "rgb(10, 132, 255)"));
  root.listeners.change[0]();
  assert.equal(root.get("--qz-ff-primary"), "rgb(9, 115, 222)");
  assert.equal(root.get("--qz-ff-accent-ink"), "rgb(35, 144, 255)");
  assert.equal(root.get("--qz-ff-text-muted"), "rgb(162, 161, 166)");
  colors["--qz-ff-accent"] = "rgb(0, 122, 255)";
  root.listeners.focus[0]();
  assert.equal(root.get("--qz-ff-primary"), "rgb(0, 112, 235)");
});

test("the palette waits for the stylesheet before reading the accent", () => {
  const colors = sourceColors("rgb(255, 255, 255)", "rgb(0, 0, 0)", "");
  const root = paletteRoot(colors);
  installFirefoxTheme({}, root);
  assert.equal(root.get("--qz-ff-primary"), undefined);
  assert.equal(root.listeners.load.length, 1);
  colors["--qz-ff-accent"] = "rgb(0, 96, 223)";
  root.listeners.load[0]();
  assert.equal(root.get("--qz-ff-primary"), "rgb(0, 96, 223)");
});

test("the sidebar follows its window theme and never writes a theme", async () => {
  const root = styleRoot();
  const calls = [];
  let listener;
  let resolveWindow;
  let resolveTheme;
  let writes = 0;
  const api = {
    windows: { getCurrent: () => new Promise(resolve => { resolveWindow = resolve; }) },
    theme: {
      getCurrent(windowId) {
        calls.push(windowId);
        return new Promise(resolve => { resolveTheme = resolve; });
      },
      onUpdated: { addListener(fn) { listener = fn; } },
      update() { writes += 1; },
      reset() { writes += 1; },
    },
  };
  installFirefoxTheme(api, root);
  assert.equal(typeof listener, "function");
  listener({ theme: { colors: { sidebar: "#abcdef" } }, windowId: 7 });
  assert.equal(root.get("--qz-ff-sidebar"), undefined);
  resolveWindow({ id: 7 });
  await Promise.resolve();
  assert.deepEqual(calls, [7]);
  listener({ theme: { colors: { sidebar: [10, 20, 30] } }, windowId: 7 });
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(10, 20, 30)");
  resolveTheme({ colors: { popup: "#123456", popup_text: "#ffffff" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(10, 20, 30)", "a stale initial read does not replace a newer update");
  assert.equal(root.get("--qz-ff-popup"), undefined);
  listener({ theme: { colors: { sidebar: "#aabbcc" } }, windowId: 3 });
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(10, 20, 30)", "another window's theme is ignored");
  listener({ theme: { colors: { popup: "#eeeeee", focus_outline: "#123456" } } });
  assert.equal(root.get("--qz-ff-popup"), "rgb(238, 238, 238)");
  assert.equal(root.get("--qz-ff-focus"), "rgb(18, 52, 86)");
  listener({ theme: {} });
  assert.equal(root.get("--qz-ff-popup"), undefined);
  assert.equal(root.get("--qz-ff-focus"), undefined);
  assert.equal(writes, 0);
});

test("the initial theme read paints the sidebar window", async () => {
  const root = styleRoot();
  const calls = [];
  installFirefoxTheme({
    windows: { async getCurrent() { return { id: 4 }; } },
    theme: {
      getCurrent(windowId) {
        calls.push(windowId);
        return { colors: { sidebar: "#123456", sidebar_text: "#ffffff", sidebar_highlight: [0, 97, 224] } };
      },
      onUpdated: { addListener() {} },
    },
  }, root);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [4]);
  assert.equal(root.get("--qz-ff-sidebar"), "rgb(18, 52, 86)");
  assert.equal(root.get("--qz-ff-sidebar-text"), "rgb(255, 255, 255)");
  assert.equal(root.get("--qz-ff-accent"), "rgb(0, 97, 224)");
  assert.equal(root.get("--qz-ff-accent-text"), "rgb(251, 251, 254)");
  assert.equal(root.get("color-scheme"), "dark");
});

test("a missing theme api and a failed read leave the stylesheet base", async () => {
  const root = styleRoot();
  installFirefoxTheme({}, root);
  installFirefoxTheme({ theme: { getCurrent() { return {}; } } }, root);
  const calls = [];
  installFirefoxTheme({
    windows: { getCurrent() { return Promise.reject(new Error("no window")); } },
    theme: {
      getCurrent(windowId) {
        calls.push(windowId);
        return Promise.reject(new Error("no theme"));
      },
      onUpdated: { addListener() {} },
    },
  }, root);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [undefined]);
  for (const property of FIREFOX_THEME_PROPERTIES) assert.equal(root.get(property), undefined);
});

test("the theme reader does not call theme.update", () => {
  const theme = readFileSync(join(repoRoot, "src/sidepanel/firefox/theme.ts"), "utf8");
  const host = readFileSync(join(repoRoot, "src/sidepanel/firefox/host.ts"), "utf8");
  assert.equal(theme.includes(".update("), false);
  assert.equal(theme.includes(".reset("), false);
  assert.match(host, /installFirefoxTheme\(chromeApi, document\.documentElement\)/);
  assert.equal(host.includes(".update("), false);
});

function parsed(colors) {
  return Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, parseFirefoxThemeColor(firefoxThemeColor(value))]));
}

function contrast(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(rgb) {
  const [red, green, blue] = rgb.slice(0, 3).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

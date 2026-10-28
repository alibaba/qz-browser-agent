import assert from "node:assert/strict";
import test from "node:test";
import { firefoxSidebarCss } from "../../scripts/firefox-manifest.mjs";
import {
  FIREFOX_TEXT_TIERS,
  firefoxAccentInk,
  firefoxPrimaryPalette,
  firefoxTextTier,
  parseFirefoxThemeColor,
} from "../../src/sidepanel/firefox/theme.js";

const WHITE = [255, 255, 255, 1];
const FIREFOX_DARK_INK = [21, 20, 26, 1];
/** Sidebar surface and text: Firefox light and dark, macOS system colors, and two window themes. */
const SIDEBARS = [
  { name: "firefox light", sidebar: [255, 255, 255], text: [21, 20, 26] },
  { name: "system light", sidebar: [255, 255, 255], text: [0, 0, 0] },
  { name: "firefox dark", sidebar: [28, 27, 34], text: [251, 251, 254] },
  { name: "system dark", sidebar: [30, 30, 30], text: [255, 255, 255] },
  { name: "purple theme", sidebar: [42, 33, 72], text: [251, 251, 254] },
  { name: "mint theme", sidebar: [234, 248, 240], text: [17, 40, 30] },
  { name: "sepia theme", sidebar: [244, 236, 216], text: [60, 47, 30] },
  { name: "slate theme", sidebar: [56, 56, 61], text: [230, 230, 235] },
];

test("the primary palette keeps a 4.5:1 label at rest, hover, and active for any accent", () => {
  const accents = [];
  for (let hue = 0; hue < 360; hue += 15) {
    for (const saturation of [30, 60, 100]) {
      for (const lightness of [15, 30, 45, 55, 65, 80, 95]) accents.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`);
    }
  }
  accents.push("#007aff", "#0a84ff", "#0060df", "#00ddff", "#ffcc00", "#ffffff", "#000000", "#8f8f9d");
  for (const value of accents) {
    const accent = parseFirefoxThemeColor(value);
    for (const preferred of [undefined, WHITE, FIREFOX_DARK_INK, accent]) {
      const palette = firefoxPrimaryPalette(accent, preferred);
      for (const state of ["fill", "hover", "active"]) {
        const ratio = contrast(palette.ink, palette[state]);
        assert.ok(ratio >= 4.5, `${value} ${state} label is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("the macOS accent darkens only as far as the label needs and Firefox's accent stays as is", () => {
  const mac = firefoxPrimaryPalette(parseFirefoxThemeColor("#007aff"), WHITE);
  assert.deepEqual(mac.ink, WHITE);
  assert.ok(contrast(WHITE, mac.fill) >= 4.5 && contrast(WHITE, mac.fill) < 4.8, `macOS fill is ${contrast(WHITE, mac.fill).toFixed(2)}:1`);
  assert.ok(contrast(WHITE, parseFirefoxThemeColor("#007aff")) < 4.5, "the system accent alone is below 4.5:1");
  assert.ok(contrast(WHITE, mac.hover) > contrast(WHITE, mac.fill), "hover darkens the fill instead of washing it out");
  assert.ok(contrast(WHITE, mac.active) > contrast(WHITE, mac.hover));
  const firefox = firefoxPrimaryPalette(parseFirefoxThemeColor("#0060df"), WHITE);
  assert.deepEqual(firefox.fill, [0, 96, 223, 1]);
  const cyan = firefoxPrimaryPalette(parseFirefoxThemeColor("#00ddff"), WHITE);
  assert.deepEqual(cyan.fill, [0, 221, 255, 1], "a light accent keeps its fill and takes the dark label");
  assert.deepEqual(cyan.ink, FIREFOX_DARK_INK);
});

test("the stylesheet fallback is Firefox's primary button and passes in both schemes", () => {
  const skin = firefoxSidebarCss();
  const pair = name => {
    const match = new RegExp(`--qz-ff-${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\);`).exec(skin);
    assert.ok(match, name);
    return [parseFirefoxThemeColor(match[1]), parseFirefoxThemeColor(match[2])];
  };
  const text = pair("primary-text");
  for (const state of ["primary", "primary-hover", "primary-active"]) {
    const fill = pair(state);
    for (const scheme of [0, 1]) {
      const ratio = contrast(text[scheme], fill[scheme]);
      assert.ok(ratio >= 4.5, `${state} ${scheme ? "dark" : "light"} is ${ratio.toFixed(2)}:1`);
    }
  }
  const ink = pair("accent-ink");
  assert.ok(contrast(ink[0], WHITE) >= 4.5);
  assert.ok(contrast(ink[1], [28, 27, 34]) >= 4.5);
});

test("the accent ink for links and focus rings reads on every sidebar", () => {
  for (const value of ["#007aff", "#0a84ff", "#0060df", "#00ddff", "#ffcc00", "#34c759", "#af52de", "#ff3b30", "#8f8f9d", "#ffffff", "#000000"]) {
    for (const sample of SIDEBARS) {
      const surface = [...sample.sidebar, 1];
      const box = [...mix(sample.text, 0.05, sample.sidebar), 1];
      const ink = firefoxAccentInk(parseFirefoxThemeColor(value), [surface, box]);
      for (const ground of [surface, box]) {
        const ratio = contrast(ink, ground);
        assert.ok(ratio >= 4.5, `${value} on ${sample.name} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("the stylesheet declares the text tier shares the palette starts from", () => {
  const skin = firefoxSidebarCss();
  const sources = { sidebar: ["--qz-ff-sidebar-text", "var\\(--qz-ff-sidebar\\)"], popup: ["--qz-ff-popup-text", "var\\(--qz-ff-popup\\)"], field: ["--qz-ff-field-text", "transparent"] };
  for (const [property, source, share] of FIREFOX_TEXT_TIERS) {
    const [text, surface] = sources[source];
    const pattern = new RegExp(`${property}: color-mix\\(in srgb, var\\(${text}\\) ${Math.round(share * 100)}%, ${surface}\\);`);
    assert.match(skin, pattern, property);
  }
  assert.match(skin, /--field-placeholder: var\(--qz-ff-field-placeholder\)/);
  assert.match(skin, /#input::placeholder \{\n\s*color: var\(--qz-ff-field-placeholder\);/);
  assert.match(skin, /\.qz-popover,\n\s*\.msg-user-edit-btn::before \{\n\s*--text-primary: var\(--qz-ff-popup-text\);\n\s*--text-secondary: var\(--qz-ff-popup-text-deemphasized\);\n\s*--text-muted: var\(--qz-ff-popup-text-muted\);/);
});

test("text tiers, secondary and disabled controls, and status colors keep 4.5:1 on every sidebar", () => {
  const skin = firefoxSidebarCss();
  const share = name => {
    const match = new RegExp(`--qz-ff-${name}: color-mix\\(in srgb, var\\(--qz-ff-sidebar-text\\) (\\d+)%, transparent\\);`).exec(skin);
    assert.ok(match, name);
    return Number(match[1]) / 100;
  };
  const fills = { fill: share("fill"), hover: share("fill-hover"), active: share("fill-active"), row: share("row-hover"), selected: share("selected") };
  const tier = name => FIREFOX_TEXT_TIERS.find(([property]) => property === name);
  const [, , deemphasizedShare, deemphasizedFill] = tier("--qz-ff-text-deemphasized");
  const [, , mutedShare, mutedFill] = tier("--qz-ff-text-muted");
  const [, , fieldShare, fieldFill] = tier("--qz-ff-field-text-deemphasized");
  assert.ok(deemphasizedFill >= fills.hover, "the deemphasized tier is checked on the darkest fill it sits on");
  assert.match(skin, /\.qz-btn:disabled \{\n\s*--qz-control-color: var\(--qz-ff-text-deemphasized\);/);
  assert.match(skin, /--send-standby-mark: var\(--qz-ff-field-text-deemphasized\)/);
  const standby = /--send-standby-bg: color-mix\(in srgb, var\(--qz-ff-field-text\) (\d+)%, transparent\);/.exec(skin);
  assert.ok(standby, "the send standby fill tints the field");
  assert.equal(Number(standby[1]) / 100, fieldFill, "the field tier is checked on the send standby fill");
  assert.match(skin, /--control-disabled-opacity: 1;/);
  for (const { name, sidebar, text } of SIDEBARS) {
    const on = amount => mix(text, amount, sidebar);
    const field = darkField(sidebar);
    const check = (label, ink, surface) => {
      const ratio = contrast(ink, surface);
      assert.ok(ratio >= 4.5, `${name} ${label} is ${ratio.toFixed(2)}:1`);
    };
    const deemphasized = firefoxTextTier([...text, 1], [...sidebar, 1], deemphasizedShare, deemphasizedFill);
    const muted = firefoxTextTier([...text, 1], [...sidebar, 1], mutedShare, mutedFill);
    check("muted text", muted, sidebar);
    check("muted text on a fill", muted, on(mutedFill));
    check("deemphasized tab", deemphasized, sidebar);
    check("deemphasized tab on hover", deemphasized, on(fills.row));
    check("selected tab", text, on(fills.selected));
    for (const state of ["fill", "hover", "active"]) check(`secondary button ${state}`, text, on(fills[state]));
    check("disabled button label", deemphasized, on(fills.fill));
    const fieldDeemphasized = firefoxTextTier([...text, 1], [...field, 1], fieldShare, fieldFill);
    check("disabled send mark", fieldDeemphasized, mix(text, fieldFill, field));
    const chroma = rgb => Math.max(...rgb) - Math.min(...rgb);
    assert.ok(chroma(on(fills.fill)) <= chroma(sidebar) + 4, `${name} disabled fill carries no accent`);
  }
  for (const { name, sidebar, text } of SIDEBARS.slice(0, 4)) {
    assert.ok(contrast(mix(text, mutedShare, sidebar), sidebar) >= 4.5, `${name} passes on the stylesheet share before the palette runs`);
    assert.ok(contrast(mix(text, deemphasizedShare, sidebar), mix(text, deemphasizedFill, sidebar)) >= 4.5, `${name} deemphasized stylesheet share`);
    const field = darkField(sidebar);
    assert.ok(contrast(mix(text, fieldShare, field), mix(text, fieldFill, field)) >= 4.5, `${name} send standby stylesheet share`);
  }
  for (const status of ["success", "warning", "critical"]) {
    const match = new RegExp(`--qz-ff-${status}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\);`).exec(skin);
    assert.ok(match, status);
    for (const { name, sidebar } of SIDEBARS.slice(0, 4)) {
      const dark = luminance(sidebar) < 0.18;
      const ink = parseFirefoxThemeColor(match[dark ? 2 : 1]).slice(0, 3);
      for (const [label, surface] of [["sidebar", sidebar], ["12% tint", mix(ink, 0.12, sidebar)]]) {
        const ratio = contrast(ink, surface);
        assert.ok(ratio >= 4.5, `${status} on ${name} ${label} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

function darkField(sidebar) {
  const skin = firefoxSidebarCss();
  const match = /--qz-ff-field: light-dark\(var\(--qz-ff-sidebar\), color-mix\(in srgb, black (\d+)%, var\(--qz-ff-sidebar\)\)\);/.exec(skin);
  assert.ok(match, "the dark field darkens the sidebar");
  return luminance(sidebar) < 0.18 ? mix([0, 0, 0], Number(match[1]) / 100, sidebar) : sidebar;
}

function mix(top, alpha, bottom) {
  return [0, 1, 2].map(index => Math.round(top[index] * alpha + bottom[index] * (1 - alpha)));
}

function contrast(a, b) {
  const left = luminance(a);
  const right = luminance(b);
  const [hi, lo] = left > right ? [left, right] : [right, left];
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(rgb) {
  const linear = rgb.slice(0, 3).map(channel => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

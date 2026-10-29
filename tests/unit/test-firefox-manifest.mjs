import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FILE_ACCESS_MESSAGE_KEY,
  FIREFOX_ADDED_PERMISSIONS,
  FIREFOX_BACKGROUND_SCRIPT,
  FIREFOX_DATA_COLLECTION,
  FIREFOX_DROPPED_PERMISSIONS,
  FIREFOX_GECKO_ID,
  FIREFOX_MIN_VERSION,
  FIREFOX_TOOLBAR_ICON,
  firefoxFallbackSupplements,
  firefoxFileAccessMessageId,
  firefoxManifest,
  firefoxSidebarCss,
  firefoxUserText,
  isFirefoxOnlySource,
  rewriteFirefoxMessages,
  rewriteFirefoxSidepanelHtml,
} from "../../scripts/firefox-manifest.mjs";
import { readTranslationVariants } from "../../scripts/capability-locales.mjs";
import { chromeMessageId, HISTORICAL_LABELS_MESSAGE_ID } from "../../src/shared/i18n/definition.js";
import { FIREFOX_THEME_PROPERTIES } from "../../src/sidepanel/firefox/theme.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const source = JSON.parse(readFileSync(join(repoRoot, "src/manifest.json"), "utf8"));

test("the firefox manifest drops rejected permissions and keeps the shared entries", () => {
  const snapshot = structuredClone(source);
  const firefox = firefoxManifest(source);
  assert.deepEqual(source, snapshot, "the Chrome manifest source is left unchanged");
  assert.equal(firefox.manifest_version, 3);
  assert.equal(firefox.key, undefined);
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, [FIREFOX_BACKGROUND_SCRIPT]);
  assert.equal(firefox.background.type, "module");
  assert.equal(firefox.sidebar_action.default_panel, source.side_panel.default_path);
  assert.equal(firefox.sidebar_action.default_title, source.action.default_title);
  assert.equal(firefox.sidebar_action.open_at_install, false);
  assert.equal(firefox.sidebar_action.default_icon, FIREFOX_TOOLBAR_ICON);
  assert.equal(firefox.action.default_icon, FIREFOX_TOOLBAR_ICON);
  assert.deepEqual(firefox.icons, source.icons, "about:addons keeps the brand icons");
  assert.equal(firefox.browser_specific_settings.gecko.id, FIREFOX_GECKO_ID);
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, FIREFOX_MIN_VERSION);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, [...FIREFOX_DATA_COLLECTION.required]);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.optional, [...FIREFOX_DATA_COLLECTION.optional]);
  assert.equal(firefox.browser_specific_settings.gecko.data_collection_permissions.required.includes("none"), false);
  for (const permission of FIREFOX_DROPPED_PERMISSIONS) {
    assert.equal(firefox.permissions.includes(permission), false, permission);
    assert.equal(firefox.optional_permissions.includes(permission), false, permission);
  }
  for (const permission of [
    "activeTab", "alarms", "tabs", "tabGroups", "scripting", "storage", "downloads",
    "geolocation", "clipboardWrite", "notifications", "declarativeNetRequest", "unlimitedStorage",
    ...FIREFOX_ADDED_PERMISSIONS,
  ]) {
    assert.equal(firefox.permissions.includes(permission), true, permission);
  }
  for (const permission of ["history", "bookmarks", "downloads.open"]) {
    assert.equal(firefox.optional_permissions.includes(permission), true, permission);
  }
  assert.deepEqual(firefox.content_scripts, source.content_scripts);
  assert.deepEqual(firefox.sandbox, source.sandbox);
  assert.equal(firefox.content_security_policy.extension_pages, source.content_security_policy.extension_pages);
  assert.equal(firefox.content_security_policy.sandbox, source.content_security_policy.sandbox);
  const commands = structuredClone(source.commands);
  const suggested = commands._execute_action.suggested_key;
  delete commands._execute_action;
  commands._execute_sidebar_action = { description: source.action.default_title, suggested_key: suggested };
  assert.deepEqual(firefox.commands, commands);
  assert.equal(firefox.action.default_area, "navbar");
  assert.equal(source.action.default_area, undefined);
  assert.equal(firefox.update_url, undefined);
  assert.equal(firefox.permissions.includes("menus"), false);
  assert.equal(firefox.permissions.includes("theme"), false);
  assert.equal(firefox.theme, undefined);
  assert.deepEqual(firefox.host_permissions, source.host_permissions);
});

test("the firefox manifest refuses a background that is not the shared module worker", () => {
  assert.throws(() => firefoxManifest({ manifest_version: 3, background: { scripts: ["background.js"] } }), /module service worker/);
  assert.throws(() => firefoxManifest({
    manifest_version: 3,
    background: { service_worker: "background/service-worker.js", type: "module" },
  }), /side_panel/);
});

test("firefox-only sources stay out of the chrome compilation", () => {
  assert.equal(isFirefoxOnlySource("background/firefox-boot.ts"), true);
  assert.equal(isFirefoxOnlySource("background/firefox/host.ts"), true);
  assert.equal(isFirefoxOnlySource("sidepanel/firefox/host.ts"), true);
  assert.equal(isFirefoxOnlySource("sidepanel/firefox/theme.ts"), true);
  assert.equal(isFirefoxOnlySource(FIREFOX_TOOLBAR_ICON), true);
  assert.equal(isFirefoxOnlySource("background/service-worker.ts"), false);
  assert.equal(isFirefoxOnlySource("sidepanel/sidepanel.ts"), false);
  assert.equal(isFirefoxOnlySource("icons/icon16.png"), false);
});

test("the firefox toolbar glyph is the 16px send mark that follows the light or dark theme", () => {
  const svg = readFileSync(join(repoRoot, "src", FIREFOX_TOOLBAR_ICON), "utf8");
  const sendMark = readFileSync(join(repoRoot, "src", "sidepanel", "sidepanel.html"), "utf8").match(/class="send-mark"[\s\S]*?<path d="([^"]+)"/)[1];
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.equal(svg.match(/<path [^>]*d="([^"]+)"/)[1], sendMark);
  assert.match(svg, /fill: context-fill #15141a;/);
  assert.match(svg, /fill-opacity: context-fill-opacity;/);
  assert.match(svg, /@media \(prefers-color-scheme: dark\) \{\s*path \{ fill: context-fill #fbfbfe; \}/);
  assert.doesNotMatch(svg, /<(?:image|linearGradient|radialGradient|rect)\b|href=/, "no raster, gradient, or background tile");
});

test("firefox copy and the sidebar boot stay out of the chrome files", () => {
  assert.equal(firefoxFileAccessMessageId(), chromeMessageId(FILE_ACCESS_MESSAGE_KEY));
  const id = firefoxFileAccessMessageId();
  const rewritten = rewriteFirefoxMessages("en", { [id]: { message: "Open qz Details in chrome://extensions, enable Allow access to file URLs, then retry." }, other: { message: "keep" } });
  assert.match(rewritten[id].message, /about:addons/);
  assert.equal(rewritten[id].message.includes("chrome://extensions"), false);
  assert.equal(rewritten.other.message, "keep");
  const inserted = rewriteFirefoxMessages("zh_CN", { qz_language: { message: "zh-CN" } });
  assert.match(inserted[id].message, /about:addons/);
  assert.equal(rewriteFirefoxMessages("en", { other: { message: "keep" } }).other.message, "keep");
  assert.equal(Object.hasOwn(rewriteFirefoxMessages("en", { other: { message: "keep" } }), id), false);
  const moduleScript = rewriteFirefoxSidepanelHtml('<head>\n</head>\n<script type="module" src="sidepanel.js"></script>');
  assert.match(moduleScript, /src="firefox-boot\.js"/);
  assert.ok(moduleScript.indexOf('href="firefox-sidebar.css"') < moduleScript.indexOf("</head>"));
  assert.match(rewriteFirefoxSidepanelHtml('<script src="sidepanel.js" type="module"></script>'), /src="firefox-boot\.js"/);
  assert.match(rewriteFirefoxSidepanelHtml('<script src="../shared/mathjax-config.js"></script>'), /mathjax-config\.js/);
  const skin = firefoxSidebarCss();
  assert.match(skin, /color-scheme: light dark/);
  assert.doesNotMatch(skin, /font:\s*message-box/);
  assert.doesNotMatch(skin, /theme\.update/);
  for (const token of ["Canvas", "CanvasText", "AccentColor", "AccentColorText"]) {
    assert.doesNotMatch(skin, new RegExp(`\\b${token}\\b`), `${token} is the system color, not Firefox's sidebar`);
  }
  assert.match(skin, /--qz-ff-sidebar: light-dark\(#ffffff, #1c1b22\);/);
  assert.match(skin, /--qz-ff-sidebar-text: light-dark\(#15141a, #f9f9fa\);/);
  assert.match(skin, /--qz-ff-accent: light-dark\(#764edd, #b89cff\);/, "the default accent is Firefox's violet");
  assert.match(skin, /--qz-ff-field: light-dark\(var\(--qz-ff-sidebar\), color-mix\(in srgb, black 18%, var\(--qz-ff-sidebar\)\)\);/);
  for (const property of FIREFOX_THEME_PROPERTIES) assert.match(skin, new RegExp(`^  ${property}:`, "m"));
  assert.match(skin, /:where\(a:any-link\) \{\n\s*color: var\(--qz-ff-accent-ink\);/, "an unstyled link takes the theme's accent, not the browser's blue");
  assert.match(skin, /^@layer components \{$/m);
  assert.doesNotMatch(skin, /color-mix\([^;]*--qz-ff-(?:accent|primary)\b/, "the accent never tints a surface");
  for (const radius of skin.matchAll(/(?:border-radius|--radius-\w+|--control-radius|--popover-radius|--block-radius):\s*([^;]+);/g)) {
    for (const value of radius[1].split(/\s+/)) assert.ok(["0", "4px", "6px", "8px"].includes(value), `radius ${radius[0]}`);
  }
  assert.match(skin, /--qz-ff-success: light-dark\(#00713e, #8adf8d\)/);
  assert.match(skin, /--qz-ff-primary: light-dark\(#764edd, #b89cff\)/);
  assert.match(skin, /--control-primary-surface: var\(--qz-ff-primary\)/);
  assert.match(skin, /\.qz-btn--primary:disabled \{\n\s*--qz-control-bg: var\(--qz-ff-fill\);\n\s*cursor: not-allowed;/);
  assert.match(skin, /--send-standby-bg: color-mix\(in srgb, var\(--qz-ff-field-text\) \d+%, transparent\)/);
  assert.match(skin, /#messages:not\(\[data-chat-state="landing"\]\) \{\n    padding-inline: 14px;\n    scrollbar-gutter: stable both-edges;\n  \}/);
  const sharedStream = readFileSync(join(repoRoot, "src/sidepanel/features/chat/transcript/viewport.css"), "utf8");
  assert.match(sharedStream, /padding:\s*0 10px var\(--chat-tail-safe-bottom\)/);
  assert.match(sharedStream, /scrollbar-gutter:\s*stable both-edges/);
  assert.equal(
    firefoxUserText("ChromeOS uses Chrome, chrome://extensions/shortcuts, chrome://downloads, the side panel, and the Chrome Web Store."),
    "ChromeOS uses Firefox, about:addons, about:downloads, the sidebar, and the Add-ons Manager.",
  );
  assert.equal(firefoxUserText("chrome-extension://abc and Android Chrome and Chrome DevTools MCP"), "moz-extension://abc and an Android layout and a browser snapshot");
  assert.equal(firefoxUserText("The chrome.debugger API and Die chrome.debugger-API"), "The debugger API and Die debugger-API");
  const accessId = firefoxFileAccessMessageId();
  const kept = rewriteFirefoxMessages("en", { qz_language: { message: "en" } }, { [accessId]: { message: "should not replace" } });
  assert.match(kept[accessId].message, /about:addons/);
  assert.equal(kept[accessId].message.includes("should not replace"), false);
  const catalogs = rewriteFirefoxMessages("en", {
    qz_language: { message: "en" },
    [HISTORICAL_LABELS_MESSAGE_ID]: { message: "Chrome" },
    qz_example: { message: "Use Chrome and chrome://downloads" },
  });
  assert.equal(catalogs[HISTORICAL_LABELS_MESSAGE_ID].message, "Chrome");
  assert.equal(catalogs.qz_language.message, "en");
  assert.equal(catalogs.qz_example.message, "Use Firefox and about:downloads");
});

test("english and simplified chinese catalogs receive firefox wording the bundle would show", () => {
  const variants = readTranslationVariants(join(repoRoot, "src"));
  const english = firefoxFallbackSupplements("en", variants);
  const chinese = firefoxFallbackSupplements("zh_CN", variants);
  assert.equal(Object.keys(firefoxFallbackSupplements("fr", variants)).length, 0);
  const startup = chromeMessageId("core.startupFailed");
  const pdf = chromeMessageId("documents.temporaryPdfRenderingRequiresTheChromeDebuggerRuntime");
  const unavailable = chromeMessageId("backend.toolError.DEBUGGER_UNAVAILABLE.message");
  assert.equal(english[startup].message, "Could not start qz. Reopen the sidebar.");
  assert.equal(chinese[startup], undefined);
  assert.equal(english[pdf].message, "Creating the PDF requires access to the Firefox debugger.");
  assert.equal(chinese[pdf].message, "临时 PDF 渲染需要 Firefox 调试服务。");
  assert.equal(english[unavailable].message, "The debugger API is unavailable in this environment.");
  assert.equal(chinese[unavailable].message, "当前环境不可用 debugger API。");
  const merged = rewriteFirefoxMessages("de", {
    qz_language: { message: "de" },
    [unavailable]: { message: "Die chrome.debugger-API ist in dieser Umgebung nicht verfügbar." },
  });
  assert.equal(merged[unavailable].message, "Die debugger-API ist in dieser Umgebung nicht verfügbar.");
  for (const pack of [english, chinese]) {
    for (const value of Object.values(pack)) {
      assert.equal(value.message.includes("chrome://"), false, value.message);
      assert.equal(value.message.includes("chrome.debugger"), false, value.message);
      assert.equal(value.message.includes("side panel"), false, value.message);
      assert.equal(value.message.includes("Side Panel"), false, value.message);
      assert.equal(/\bChrome\b/.test(value.message), false, value.message);
    }
  }
});

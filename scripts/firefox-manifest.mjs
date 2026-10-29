// Firefox rejects permission names it does not implement. This rewrites a built copy.
// src/manifest.json and the Chrome output stay on the Chrome manifest.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromeMessageId, decodeChromeMessage, encodeChromeMessage, HISTORICAL_LABELS_MESSAGE_ID } from "../src/shared/i18n/definition.ts";
import { readTranslationVariants } from "./capability-locales.mjs";

export const FIREFOX_GECKO_ID = "qz-browser-agent@heleifz.github.io";
export const FIREFOX_MIN_VERSION = "154.0";
export const FIREFOX_BACKGROUND_SCRIPT = "background/firefox-boot.js";
export const FIREFOX_PANEL_SCRIPT = "sidepanel/firefox-boot.js";
export const FIREFOX_DROPPED_PERMISSIONS = Object.freeze([
  "debugger",
  "desktopCapture",
  "offscreen",
  "sidePanel",
]);
export const FIREFOX_ADDED_PERMISSIONS = Object.freeze([
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
]);
export const FIREFOX_DATA_COLLECTION = Object.freeze({
  required: Object.freeze(["websiteContent", "browsingActivity"]),
  optional: Object.freeze(["locationInfo", "bookmarksInfo"]),
});
export const FILE_ACCESS_MESSAGE_KEY = "backend.toolError.FILE_ACCESS_REQUIRED.message";
export const FIREFOX_SIDEBAR_STYLESHEET = "sidepanel/firefox-sidebar.css";
export const FIREFOX_TOOLBAR_ICON = "icons/firefox/qz-glyph.svg";

const droppedPermissions = new Set(FIREFOX_DROPPED_PERMISSIONS);
const FILE_ACCESS_TEXT = Object.freeze({
  en: "Open qz in about:addons, open Permissions, enable Access local files on your computer, then retry.",
  zh_CN: "请在 about:addons 中打开轻舟，进入权限页，开启“访问您计算机上的本地文件”，然后重试。",
  zh_TW: "請在 about:addons 中開啟輕舟，進入權限頁，開啟「存取您電腦上的本機檔案」，然後重試。",
  ja: "about:addons で軽舟を開き、権限ページで「コンピューター上のローカルファイルへのアクセス」を有効にしてから再試行してください。",
  ko: "about:addons에서 qz를 열고 권한 페이지에서 컴퓨터의 로컬 파일 액세스를 켠 다음 다시 시도하세요.",
  de: "Öffnen Sie qz unter about:addons, öffnen Sie die Berechtigungen, aktivieren Sie den Zugriff auf lokale Dateien auf Ihrem Computer und versuchen Sie es erneut.",
  es: "Abra qz en about:addons, abra Permisos, active el acceso a los archivos locales del equipo y vuelva a intentarlo.",
  fr: "Ouvrez qz dans about:addons, ouvrez Autorisations, activez l’accès aux fichiers locaux de votre ordinateur, puis réessayez.",
  pt_BR: "Abra o qz em about:addons, abra Permissões, ative o acesso a arquivos locais no computador e tente novamente.",
  ru: "Откройте qz на странице about:addons, откройте разрешения, включите доступ к локальным файлам на компьютере и повторите попытку.",
  ar: "افتح qz في about:addons، ثم افتح الأذونات، وفعّل الوصول إلى الملفات المحلية على جهاز الكمبيوتر، ثم أعد المحاولة.",
  hi: "about:addons में qz खोलें, अनुमतियाँ खोलें, अपने कंप्यूटर पर स्थानीय फ़ाइलों की पहुँच चालू करें और फिर से कोशिश करें।",
});

/** True for sources that exist only in the Firefox package. */
export function isFirefoxOnlySource(path) {
  return /^(?:(?:background|sidepanel)\/firefox(?:-boot\.ts|\/)|icons\/firefox\/)/.test(String(path || "").replaceAll("\\", "/"));
}

/** Return a Manifest V3 document Firefox can load as a temporary add-on. */
export function firefoxManifest(manifest) {
  if (!manifest || manifest.manifest_version !== 3) {
    throw new Error("Firefox manifest requires Manifest V3");
  }
  const worker = manifest.background?.service_worker;
  if (!worker || manifest.background.type !== "module") {
    throw new Error("Firefox background expects the module service worker entry");
  }
  const panel = manifest.side_panel?.default_path;
  if (!panel) throw new Error("Firefox sidebar requires side_panel.default_path");

  const next = structuredClone(manifest);
  delete next.key;
  delete next.side_panel;
  if (Array.isArray(next.permissions)) {
    next.permissions = next.permissions.filter(permission => !droppedPermissions.has(permission));
    for (const permission of FIREFOX_ADDED_PERMISSIONS) {
      if (!next.permissions.includes(permission)) next.permissions.push(permission);
    }
  }
  if (Array.isArray(next.optional_permissions)) {
    next.optional_permissions = next.optional_permissions.filter(permission => !droppedPermissions.has(permission));
    if (!next.optional_permissions.length) delete next.optional_permissions;
  }
  // Firefox starts background.scripts and ignores background.service_worker.
  // Omit the unused key so web-ext does not warn BACKGROUND_SERVICE_WORKER_IGNORED.
  // The boot module patches Firefox APIs, then loads the shared service worker.
  next.background = {
    scripts: [FIREFOX_BACKGROUND_SCRIPT],
    type: "module",
  };
  if (next.action) {
    next.action.default_area = "navbar";
    // The toolbar and sidebar switcher draw a theme-colored glyph; about:addons keeps the brand `icons`.
    if (next.action.default_icon) next.action.default_icon = FIREFOX_TOOLBAR_ICON;
  }
  if (next.commands?._execute_action) {
    const suggested = next.commands._execute_action.suggested_key;
    delete next.commands._execute_action;
    // Firefox toggles a sidebar_action from this reserved command. It does not use _execute_action.
    next.commands._execute_sidebar_action = {
      description: next.action?.default_title || next.name,
      ...(suggested ? { suggested_key: suggested } : {}),
    };
  }
  const sidebarAction = {
    default_panel: panel,
    open_at_install: false,
  };
  const sidebarTitle = next.action?.default_title || next.name;
  const sidebarIcon = next.action?.default_icon || next.icons;
  if (sidebarTitle) sidebarAction.default_title = sidebarTitle;
  if (sidebarIcon) sidebarAction.default_icon = sidebarIcon;
  next.sidebar_action = sidebarAction;
  next.browser_specific_settings = {
    gecko: {
      id: FIREFOX_GECKO_ID,
      strict_min_version: FIREFOX_MIN_VERSION,
      data_collection_permissions: {
        required: [...FIREFOX_DATA_COLLECTION.required],
        optional: [...FIREFOX_DATA_COLLECTION.optional],
      },
    },
  };
  return next;
}

/** Point the sidebar document at the Firefox boot module and the sidebar skin. The Chrome file is unchanged. */
export function rewriteFirefoxSidepanelHtml(html) {
  let next = stripFirefoxSessionAutomationMarkup(html);
  next = next.replace(/(<script\b[^>]*\bsrc=["'])sidepanel\.js(["'])/i, `$1${FIREFOX_PANEL_SCRIPT.split("/").pop()}$2`);
  if (!next.includes("firefox-sidebar.css")) {
    const link = `  <link rel="stylesheet" href="firefox-sidebar.css">\n`;
    next = next.includes("</head>") ? next.replace("</head>", `${link}</head>`) : `${next}\n${link}`;
  }
  return next;
}

/** Remove the automations tab, the new-automation button, and the editor from the Firefox sidebar. */
export function stripFirefoxSessionAutomationMarkup(html) {
  return [
    tag => /\bdata-sessions-mode=(["'])automation\1/.test(tag),
    tag => /\bid=(["'])btn-new-automation\1/.test(tag),
    tag => /\bid=(["'])automations-panel\1/.test(tag),
  ].reduce((current, matches) => removeBalancedElements(current, matches), String(html));
}

function removeBalancedElements(html, matchesOpenTag) {
  let source = html;
  for (;;) {
    const open = findOpeningTag(source, matchesOpenTag);
    if (!open) return source;
    const end = matchingCloseEnd(source, open);
    if (end < 0) return source;
    source = `${source.slice(0, open.index)}${source.slice(end)}`;
  }
}

function findOpeningTag(html, matchesOpenTag) {
  const re = /<([A-Za-z][\w:-]*)\b[^>]*>/g;
  let match;
  while ((match = re.exec(html))) {
    if (match[0].endsWith("/>")) continue;
    if (matchesOpenTag(match[0])) return { index: match.index, name: match[1] };
  }
  return null;
}

function matchingCloseEnd(html, open) {
  const name = open.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = open.index;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match[0].endsWith("/>")) continue;
    if (match[1] !== "/") depth += 1;
    else {
      depth -= 1;
      if (depth === 0) return re.lastIndex;
    }
  }
  return -1;
}

/**
 * Firefox-only sidebar skin, loaded after the shared theme.
 *
 * The base palette is Firefox's default sidebar: its light and dark surface and text, its
 * darker search field in dark mode, and its own violet accent rather than the system accent.
 * Neutral fills mix the text color over transparent, the way Firefox mixes currentColor, so a
 * window theme only replaces the sources. sidepanel/firefox/theme.ts derives those sources
 * from the active theme, including a dark variant when Firefox paints a dark block that
 * theme.getCurrent() does not return. A theme without colors leaves this base.
 *
 * Token overrides are unlayered and replace the shared theme layer. Component
 * rules join the shared components layer. They win ties by source order, and
 * higher-specificity state rules such as recording or error keep their own
 * declarations.
 *
 * The accent fills only primary controls and is never mixed into a surface.
 * sidepanel/firefox/theme.ts reads the resolved accent and writes the --qz-ff-primary
 * fill, hover, active, and label, and the --qz-ff-accent-ink for rings and links,
 * each at least 4.5:1. Until it runs, Firefox's own primary button colors apply.
 * Disabled primary controls drop to the neutral fill with deemphasized text and a
 * not-allowed cursor instead of fading.
 */
export function firefoxSidebarCss() {
  return `/* Firefox sidebar skin: Firefox's default sidebar tokens, recolored by the window theme. */
:root {
  color-scheme: light dark;

  --qz-ff-sidebar: light-dark(#ffffff, #1c1b22);
  --qz-ff-sidebar-text: light-dark(#15141a, #f9f9fa);
  --qz-ff-sidebar-border: var(--qz-ff-hairline);
  --qz-ff-accent: light-dark(#764edd, #b89cff);
  --qz-ff-accent-text: light-dark(#ffffff, #252428);
  --qz-ff-focus: var(--qz-ff-accent-ink);
  --qz-ff-field: light-dark(var(--qz-ff-sidebar), color-mix(in srgb, black 18%, var(--qz-ff-sidebar)));
  --qz-ff-field-text: var(--qz-ff-sidebar-text);
  --qz-ff-field-border: var(--qz-ff-border);
  --qz-ff-popup: light-dark(var(--qz-ff-sidebar), color-mix(in srgb, var(--qz-ff-sidebar-text) 9%, var(--qz-ff-sidebar)));
  --qz-ff-popup-text: var(--qz-ff-sidebar-text);
  --qz-ff-popup-border: var(--qz-ff-hairline);

  --qz-ff-text-deemphasized: color-mix(in srgb, var(--qz-ff-sidebar-text) 72%, var(--qz-ff-sidebar));
  --qz-ff-text-muted: color-mix(in srgb, var(--qz-ff-sidebar-text) 60%, var(--qz-ff-sidebar));
  --qz-ff-popup-text-deemphasized: color-mix(in srgb, var(--qz-ff-popup-text) 72%, var(--qz-ff-popup));
  --qz-ff-popup-text-muted: color-mix(in srgb, var(--qz-ff-popup-text) 60%, var(--qz-ff-popup));
  --qz-ff-field-text-deemphasized: color-mix(in srgb, var(--qz-ff-field-text) 72%, transparent);
  --qz-ff-field-placeholder: color-mix(in srgb, var(--qz-ff-field-text) 60%, transparent);
  --qz-ff-hairline: color-mix(in srgb, var(--qz-ff-sidebar-text) 12%, transparent);
  --qz-ff-border: color-mix(in srgb, var(--qz-ff-sidebar-text) 24%, transparent);
  --qz-ff-border-hover: color-mix(in srgb, var(--qz-ff-sidebar-text) 40%, transparent);
  --qz-ff-border-strong: color-mix(in srgb, var(--qz-ff-sidebar-text) 55%, var(--qz-ff-sidebar));
  --qz-ff-box: light-dark(color-mix(in srgb, var(--qz-ff-sidebar-text) 3%, var(--qz-ff-sidebar)), color-mix(in srgb, var(--qz-ff-sidebar-text) 5%, var(--qz-ff-sidebar)));
  --qz-ff-box-hover: color-mix(in srgb, var(--qz-ff-sidebar-text) 8%, var(--qz-ff-sidebar));
  --qz-ff-box-active: color-mix(in srgb, var(--qz-ff-sidebar-text) 12%, var(--qz-ff-sidebar));
  --qz-ff-row-hover: color-mix(in srgb, var(--qz-ff-sidebar-text) 6%, transparent);
  --qz-ff-fill: color-mix(in srgb, var(--qz-ff-sidebar-text) 7%, transparent);
  --qz-ff-selected: color-mix(in srgb, var(--qz-ff-sidebar-text) 11%, transparent);
  --qz-ff-fill-hover: color-mix(in srgb, var(--qz-ff-sidebar-text) 14%, transparent);
  --qz-ff-fill-active: color-mix(in srgb, var(--qz-ff-sidebar-text) 21%, transparent);
  --qz-ff-primary: light-dark(#764edd, #b89cff);
  --qz-ff-primary-hover: light-dark(#5939a8, #d4c1ff);
  --qz-ff-primary-active: light-dark(#3e2976, #eaddff);
  --qz-ff-primary-text: light-dark(#ffffff, #252428);
  --qz-ff-accent-ink: light-dark(#764edd, #b89cff);
  /* Text-safe on the sidebar and on a 12% tint of themselves in both schemes. */
  --qz-ff-success: light-dark(#00713e, #8adf8d);
  --qz-ff-warning: light-dark(#905300, #f5cc58);
  --qz-ff-critical: light-dark(#b20037, #ffa0aa);

  --font-sans: system-ui, sans-serif;
  --font-mono: ui-monospace, Menlo, Consolas, monospace;
  --bg-primary: var(--qz-ff-sidebar);
  --bg-secondary: var(--qz-ff-sidebar);
  --bg-tertiary: color-mix(in srgb, var(--qz-ff-sidebar-text) 8%, var(--qz-ff-sidebar));
  --bg-elevated: var(--qz-ff-box);
  --bg-glass: var(--qz-ff-sidebar);
  --text-primary: var(--qz-ff-sidebar-text);
  --text-secondary: var(--qz-ff-text-deemphasized);
  --text-muted: var(--qz-ff-text-muted);
  --text-faint: var(--qz-ff-text-muted);
  --border: var(--qz-ff-hairline);
  --border-focus: var(--qz-ff-border);
  --accent: var(--qz-ff-sidebar-text);
  --accent-strong: var(--qz-ff-sidebar-text);
  --accent-glow: var(--qz-ff-fill);
  --accent-subtle: var(--qz-ff-row-hover);
  --selection-bg: Highlight;

  --control-track: transparent;
  --control-hover-fill: var(--qz-ff-row-hover);
  --control-active-fill: var(--qz-ff-selected);
  --control-active-border: transparent;
  --control-radius: 6px;
  --control-border: transparent;
  --control-border-hover: transparent;
  --control-surface: transparent;
  --control-surface-hover: var(--qz-ff-fill-hover);
  --control-surface-pressed: var(--qz-ff-fill-active);
  --control-text: var(--qz-ff-sidebar-text);
  --control-text-hover: var(--qz-ff-sidebar-text);
  --control-primary-surface: var(--qz-ff-primary);
  --control-primary-surface-hover: var(--qz-ff-primary-hover);
  --control-primary-text: var(--qz-ff-primary-text);
  --control-danger-text: var(--qz-ff-critical);
  --control-danger-surface-hover: color-mix(in srgb, var(--qz-ff-critical) 12%, transparent);
  --control-danger-border-hover: transparent;
  --control-focus-ring: 0 0 0 2px var(--qz-ff-sidebar), 0 0 0 4px var(--qz-ff-focus);
  --control-disabled-opacity: 1;
  --field-surface: var(--qz-ff-field);
  --field-surface-disabled: var(--qz-ff-box);
  --field-text: var(--qz-ff-field-text);
  --field-border: var(--qz-ff-field-border);
  --field-border-hover: var(--qz-ff-border-hover);
  --field-border-focus: var(--qz-ff-focus);
  --field-placeholder: var(--qz-ff-field-placeholder);
  --field-focus-ring: 0 0 0 1px var(--qz-ff-focus);
  --choice-border: var(--qz-ff-border-strong);
  --choice-border-hover: var(--qz-ff-sidebar-text);
  --qz-choice-checked-surface: var(--qz-ff-primary);
  --qz-choice-mark: var(--qz-ff-primary-text);

  --popover-surface: var(--qz-ff-popup);
  --popover-border: var(--qz-ff-popup-border);
  --popover-radius: 8px;
  --popover-shadow: 0 1px 4px rgb(0 0 0 / 0.16);
  --modal-backdrop: light-dark(rgb(0 0 0 / 0.2), rgb(0 0 0 / 0.5));
  --modal-surface: var(--qz-ff-sidebar);
  --modal-muted-surface: var(--qz-ff-box);
  --modal-card-surface: var(--qz-ff-sidebar);
  --modal-card-border: var(--qz-ff-sidebar-border);
  --modal-card-shadow: none;
  --surface-porcelain: var(--qz-ff-box);
  --surface-porcelain-border: var(--qz-ff-hairline);
  --surface-porcelain-shadow: none;

  --user-bubble-bg: color-mix(in srgb, var(--qz-ff-sidebar-text) 8%, var(--qz-ff-sidebar));
  --user-bubble-text: var(--qz-ff-sidebar-text);
  --user-bubble-selection-bg: Highlight;
  --user-bubble-selection-text: HighlightText;
  --block-fill: color-mix(in srgb, var(--qz-ff-sidebar-text) 4%, transparent);
  --block-fill-hover: var(--qz-ff-fill);
  --block-radius: 6px;
  --code-bg: var(--qz-ff-box);
  --code-inline-bg: var(--qz-ff-fill);
  --code-border: transparent;
  --code-accent: var(--qz-ff-accent-ink);
  --green: var(--qz-ff-success);
  --orange: var(--qz-ff-warning);
  --red: var(--qz-ff-critical);
  --danger-subtle: color-mix(in srgb, var(--qz-ff-critical) 12%, transparent);
  --success-border: color-mix(in srgb, var(--qz-ff-success) 40%, transparent);
  --send-standby-bg: color-mix(in srgb, var(--qz-ff-field-text) 14%, transparent);
  --send-standby-mark: var(--qz-ff-field-text-deemphasized);
  --shadow-sm: none;
  --shadow-md: var(--popover-shadow);
  --shadow-lg: var(--popover-shadow);
  --qz-scrollbar-thumb: color-mix(in srgb, var(--qz-ff-sidebar-text) 32%, transparent);
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 8px;

  accent-color: var(--qz-ff-primary);
  scrollbar-color: var(--qz-scrollbar-thumb) transparent;
}

@layer components {
  ::selection {
    background-color: Highlight;
    color: HighlightText;
  }

  .qz-popover,
  .msg-user-edit-btn::before {
    --text-primary: var(--qz-ff-popup-text);
    --text-secondary: var(--qz-ff-popup-text-deemphasized);
    --text-muted: var(--qz-ff-popup-text-muted);
    --text-faint: var(--qz-ff-popup-text-muted);
    --control-text: var(--qz-ff-popup-text);
    --control-text-hover: var(--qz-ff-popup-text);
    --control-hover-fill: color-mix(in srgb, var(--qz-ff-popup-text) 6%, transparent);
    --control-active-fill: color-mix(in srgb, var(--qz-ff-popup-text) 11%, transparent);
    --border: color-mix(in srgb, var(--qz-ff-popup-text) 12%, transparent);
  }

  .qz-popover {
    color: var(--qz-ff-popup-text);
  }

  .header-tabs,
  .settings-tabs {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
  }

  .tab-btn,
  .settings-tab,
  .qz-list-toolbar-tab {
    border-radius: 4px;
    background: transparent;
    color: var(--qz-ff-text-deemphasized);
    box-shadow: none;
  }

  .tab-btn:hover,
  .settings-tab:hover,
  .qz-list-toolbar-tab:hover {
    background: var(--qz-ff-row-hover);
    color: var(--qz-ff-sidebar-text);
    transform: none;
  }

  .tab-btn:active,
  .settings-tab:active,
  .qz-list-toolbar-tab:active {
    background: var(--qz-ff-fill-hover);
  }

  .tab-btn.active,
  .settings-tab.active,
  .qz-list-toolbar-tab.active {
    background: var(--qz-ff-selected);
    color: var(--qz-ff-sidebar-text);
    box-shadow: none;
  }

  .qz-icon-btn,
  .icon-btn {
    border-radius: 4px;
  }

  .qz-icon-btn:disabled {
    color: var(--qz-ff-text-muted);
  }

  .qz-btn:not(.qz-btn--primary, .qz-btn--ghost, .qz-btn--inline, .qz-btn--danger) {
    --qz-control-bg: var(--qz-ff-fill);
    --qz-control-bg-hover: var(--qz-ff-fill-hover);
    --qz-control-bg-pressed: var(--qz-ff-fill-active);
  }

  .qz-btn--primary {
    --qz-control-bg-pressed: var(--qz-ff-primary-active);
  }

  .qz-btn--danger {
    --qz-control-bg-pressed: color-mix(in srgb, var(--qz-ff-critical) 20%, transparent);
  }

  .qz-btn:disabled {
    --qz-control-color: var(--qz-ff-text-deemphasized);
  }

  .qz-btn--primary:disabled {
    --qz-control-bg: var(--qz-ff-fill);
    cursor: not-allowed;
  }

  .settings-preset-row .qz-btn:disabled {
    opacity: 1;
  }

  .qz-btn:focus-visible,
  .qz-icon-btn:focus-visible,
  .send-btn:focus-visible,
  .onboarding-action:focus-visible,
  .qz-checkbox:focus-visible,
  .qz-radio:focus-visible,
  .qz-switch:focus-visible {
    outline: 2px solid var(--qz-ff-focus);
    outline-offset: 2px;
    box-shadow: none;
  }

  .tab-btn:focus-visible,
  .settings-tab:focus-visible,
  .qz-list-toolbar-tab:focus-visible,
  .tool-timeline-step:focus-visible,
  .thinking-group-summary:focus-visible,
  .tool-summary:focus-visible {
    outline: 2px solid var(--qz-ff-focus);
    outline-offset: -2px;
    box-shadow: none;
  }

  .qz-field:disabled,
  .qz-field[readonly] {
    opacity: 1;
  }

  .qz-switch {
    border-color: var(--qz-ff-border-strong);
    background: transparent;
  }

  .qz-switch::before {
    background: var(--qz-ff-border-strong);
  }

  .qz-switch:checked {
    border-color: var(--qz-ff-primary);
    background: var(--qz-ff-primary);
  }

  .qz-switch:checked::before {
    background: var(--qz-ff-primary-text);
  }

  .input-wrapper {
    border-color: var(--qz-ff-field-border);
    border-radius: 8px;
    background: var(--qz-ff-field);
  }

  .input-wrapper:hover {
    border-color: var(--qz-ff-border-hover);
  }

  .input-wrapper:focus-within,
  .input-wrapper.is-file-dragover {
    border-color: var(--qz-ff-focus);
    box-shadow: 0 0 0 1px var(--qz-ff-focus);
  }

  #input {
    color: var(--qz-ff-field-text);
  }

  #input::placeholder {
    color: var(--qz-ff-field-placeholder);
  }

  .input-hint {
    opacity: 1;
  }

  .input-hint kbd {
    border-radius: 4px;
    background: var(--qz-ff-fill);
  }

  .send-btn {
    border-radius: 6px;
    background: var(--qz-ff-primary);
    color: var(--qz-ff-primary-text);
  }

  .send-btn:not(:disabled):hover {
    background: var(--qz-ff-primary-hover);
    box-shadow: none;
    transform: none;
  }

  .send-btn:not(:disabled):active {
    background: var(--qz-ff-primary-active);
    transform: none;
  }

  .send-btn:disabled {
    background: var(--send-standby-bg);
    color: var(--send-standby-mark);
  }

  @keyframes send-button-disable {
    0%,
    38% {
      background-color: var(--qz-ff-primary);
      color: var(--qz-ff-primary-text);
    }
    38.01% {
      background-color: var(--qz-ff-primary);
      color: var(--send-standby-mark);
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    90%,
    100% {
      background-color: var(--send-standby-bg);
      color: var(--send-standby-mark);
    }
  }

  .code-copy-btn {
    --qz-control-border: transparent;
    --qz-control-border-hover: transparent;
    --qz-control-border-focus: transparent;
    --qz-control-bg: transparent;
    --qz-control-bg-hover: var(--qz-ff-fill-hover);
    backdrop-filter: none;
  }

  .msg-user .msg-content {
    border-radius: 8px;
  }

  :is(.msg-assistant .msg-content, .qz-markdown) a {
    color: var(--qz-ff-accent-ink);
  }

  /* Zero specificity: only links no other rule colors leave the browser's default blue. */
  :where(a:any-link) {
    color: var(--qz-ff-accent-ink);
  }

  .thinking-group-summary,
  .tool-summary {
    border-color: transparent;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
  }

  .thinking-group-summary:hover,
  .thinking-group-summary:focus-visible,
  .tool-summary:hover {
    border-color: transparent;
    background: var(--qz-ff-row-hover);
  }

  .msg-thinking-group.thinking-group-expanded,
  .msg-tool-timeline.tool-timeline-expanded,
  .msg-tool.tool-expanded {
    border-radius: 8px;
    background: var(--qz-ff-box);
    box-shadow: 0 0 0 1px var(--qz-ff-hairline);
  }

  .msg-thinking-group.thinking-group-expanded > .thinking-group-summary,
  .msg-tool-timeline.tool-timeline-expanded > .tool-timeline-summary,
  .msg-tool.tool-expanded > .tool-summary,
  .msg-tool-timeline.tool-timeline-expanded .tool-timeline-nav-area {
    border-radius: 8px 8px 0 0;
    background: var(--qz-ff-box);
    backdrop-filter: none;
  }

  .msg-tool-timeline.tool-timeline-expanded .tool-timeline-nav-area {
    border-radius: 0;
  }

  .msg-thinking-group.thinking-group-expanded > .thinking-group-summary:hover,
  .msg-thinking-group.thinking-group-expanded > .thinking-group-summary:focus-visible,
  .msg-tool-timeline.tool-timeline-expanded > .tool-timeline-summary:hover,
  .msg-tool.tool-expanded > .tool-summary:hover {
    background: var(--qz-ff-box-hover);
  }

  .tool-timeline-step {
    border-color: transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--qz-ff-text-deemphasized);
    box-shadow: none;
  }

  .tool-timeline-step:is(.running, .waiting, .error, .aborted) {
    border-color: transparent;
    background: transparent;
  }

  .tool-timeline-step:hover,
  .tool-timeline-step:focus-visible {
    border-color: transparent;
    background: var(--qz-ff-row-hover);
    color: var(--qz-ff-sidebar-text);
  }

  .tool-timeline-step.active {
    border-color: transparent;
    background: var(--qz-ff-selected);
    color: var(--qz-ff-sidebar-text);
    box-shadow: none;
  }

  .tool-timeline-step .mini-dot,
  .tool-timeline-step:is(.running, .waiting, .error, .aborted) .mini-dot,
  .tool-family-row .mini-dot,
  .tool-summary .dot,
  .thinking-dot {
    box-shadow: none;
  }

  .tool-compact-meta span,
  .tool-slim-meta span,
  .tool-chip {
    border-color: transparent;
    border-radius: 4px;
    background: var(--qz-ff-fill);
    color: var(--qz-ff-text-deemphasized);
  }

  .tool-error-code {
    border-color: transparent;
    background: color-mix(in srgb, var(--qz-ff-critical) 12%, transparent);
    color: var(--qz-ff-critical);
  }

  .onboarding-status {
    border-color: transparent;
    border-radius: 8px;
    background: var(--qz-ff-box);
    color: var(--qz-ff-sidebar-text);
  }

  .onboarding-status[data-state="needs_setup"] {
    border-color: color-mix(in srgb, var(--qz-ff-warning) 24%, transparent);
    background: color-mix(in srgb, var(--qz-ff-warning) 10%, var(--qz-ff-sidebar));
  }

  .onboarding-status[data-state="ready"] {
    border-color: color-mix(in srgb, var(--qz-ff-success) 24%, transparent);
    background: color-mix(in srgb, var(--qz-ff-success) 10%, var(--qz-ff-sidebar));
  }

  .onboarding-action {
    border-color: transparent;
    border-radius: 8px;
    background: var(--qz-ff-box);
  }

  .onboarding-action:hover,
  .onboarding-action:focus-visible {
    border-color: transparent;
    background: var(--qz-ff-box-hover);
  }

  .onboarding-action:active {
    background: var(--qz-ff-box-active);
    transform: none;
  }

  .settings-body {
    scrollbar-color: var(--qz-scrollbar-thumb) transparent;
  }

  /* The shared stream inset is 10px. Firefox's scrollbar sits in that inset and
     crowds the text. 14px matches the header and the landing stream. The gutter
     stays on both edges so the scrollbar does not cover the extra inset. */
  #messages:not([data-chat-state="landing"]) {
    padding-inline: 14px;
    scrollbar-gutter: stable both-edges;
  }
}
`;
}

const FALLBACK_LOCALE_LANGUAGE = Object.freeze({
  en: "en",
  zh_CN: "zh-CN",
});

/** Rewrite catalog sentences that name Chrome, its URLs, a side panel, or chrome.debugger. */
export function firefoxUserText(text) {
  let next = String(text);
  next = next.replaceAll("ChromeOS", "\u0000OS");
  next = next.replaceAll("chrome-extension://", "moz-extension://");
  next = next.replaceAll("chrome.debugger", "debugger");
  next = next.replaceAll("chrome://extensions/shortcuts", "about:addons");
  next = next.replaceAll("chrome://extensions", "about:addons");
  next = next.replaceAll("chrome://downloads", "about:downloads");
  next = next.replaceAll("chrome://", "about:");
  next = next.replaceAll("Chrome Web Store", "Add-ons Manager");
  next = next.replaceAll("Android Chrome", "an Android layout");
  next = next.replaceAll("Chrome DevTools MCP", "a browser snapshot");
  next = next.replaceAll(/\bChrome\b/g, "Firefox");
  next = next.replaceAll("\u0000OS", "ChromeOS");
  next = next.replaceAll("the extension store", "Add-ons");
  next = next.replaceAll("Side Panel", "Sidebar");
  next = next.replaceAll("side panel", "sidebar");
  return next;
}

/**
 * English and zh-CN catalogs omit most authored sentences, so the loader falls back to the
 * shared bundle. Add the sentences whose Firefox wording differs. Other locales already ship
 * a full catalog and are rewritten in place.
 */
export function firefoxFallbackSupplements(locale, variants) {
  const language = FALLBACK_LOCALE_LANGUAGE[locale];
  if (!language || !variants) return {};
  const supplements = {};
  for (const [qualified, value] of variants) {
    if (!value || typeof value !== "object") continue;
    const authored = typeof value[language] === "string" ? value[language] : value.en;
    if (typeof authored !== "string") continue;
    const updated = firefoxUserText(authored);
    if (updated === authored) continue;
    const manifestMessage = String(qualified).startsWith("manifest.");
    const name = manifestMessage ? String(qualified).slice("manifest.".length) : chromeMessageId(qualified);
    if (!name || name === "qz_language" || name === HISTORICAL_LABELS_MESSAGE_ID) continue;
    supplements[name] = encodeChromeMessage(updated, { substitutions: !manifestMessage });
  }
  return supplements;
}

export function firefoxFileAccessMessageId() {
  return chromeMessageId(FILE_ACCESS_MESSAGE_KEY);
}

export function rewriteFirefoxMessages(locale, messages, supplements = {}) {
  const id = firefoxFileAccessMessageId();
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) return messages;
  // English and zh-CN keep the Chrome sentence in the shared bundle. Their catalogs omit the key,
  // so the Firefox package adds it and the loader prefers the catalog over that sentence.
  let next = messages;
  if (messages[id] || messages.qz_language) {
    const text = FILE_ACCESS_TEXT[locale] || FILE_ACCESS_TEXT.en;
    next = { ...messages, [id]: { message: text } };
  }
  let changed = next !== messages;
  const rewritten = { ...next };
  for (const [key, value] of Object.entries(supplements || {})) {
    if (key === "qz_language" || key === HISTORICAL_LABELS_MESSAGE_ID || rewritten[key]) continue;
    rewritten[key] = value;
    changed = true;
  }
  for (const [key, value] of Object.entries(rewritten)) {
    if (key === "qz_language" || key === HISTORICAL_LABELS_MESSAGE_ID) continue;
    const text = decodeChromeMessage(value);
    if (text === undefined) continue;
    const updated = firefoxUserText(text);
    if (updated === text) continue;
    const manifestMessage = !key.startsWith("qz_");
    rewritten[key] = encodeChromeMessage(updated, { substitutions: !manifestMessage });
    changed = true;
  }
  return changed ? rewritten : messages;
}

/** Write the Firefox-only sidebar skin next to the rewritten panel document. */
export async function writeFirefoxSidebarSkin(root) {
  const path = resolve(root, FIREFOX_SIDEBAR_STYLESHEET);
  await writeFile(path, firefoxSidebarCss());
}

/** Rewrite generated locale catalogs in a Firefox build output. */
export async function rewriteFirefoxLocaleFiles(root, sourceDir) {
  const variants = sourceDir ? readTranslationVariants(sourceDir) : null;
  const locales = resolve(root, "_locales");
  let names = [];
  try { names = await readdir(locales); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const locale of names) {
    const path = resolve(locales, locale, "messages.json");
    let messages;
    try { messages = JSON.parse(await readFile(path, "utf8")); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const supplements = variants ? firefoxFallbackSupplements(locale, variants) : {};
    const rewritten = rewriteFirefoxMessages(locale, messages, supplements);
    if (rewritten === messages) continue;
    await writeFile(path, `${JSON.stringify(rewritten, null, 2)}\n`);
  }
}

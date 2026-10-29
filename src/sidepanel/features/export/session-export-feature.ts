import { t, tHtml } from "../../i18n/index.js";
import { getLanguage, getTextDirection } from "../../../shared/i18n/index.js";
import { optionalSessionId as normalizeSessionIdValue } from "../sessions/session-id.js";
import {
  createSessionExchangePayload,
  normalizeSessionExchangePayload,
  renderSessionExchangeScript,
} from "../../../shared/session/session-exchange.js";
import type { TranscriptEntry } from "../../tools/renderer-input.js";
import { escapeHtml, safeFilename } from "../../ui/ui-utils.js";
import { renderToolEvent, toolEventLaneMode } from "../../tools/tool-renderer.js";
import {
  createThinkingTimelineGroupElement,
  createToolTimelineGroupElement,
  ensureToolTimelineActiveSlot,
  groupConsecutiveToolTranscriptEntries,
  renderThinkingTimelineActiveSlot,
  thinkingTimelineGroupEntries,
  timelineGroupTools,
} from "../../tools/tool-timeline-renderer.js";
import { loadActiveSidepanelSkin, resolveActiveSidepanelSkin } from "../../ui/skin-runtime.js";
import { mathExportStylesheet, renderMathSvg, withMathRuntime } from "../chat/math-runtime.js";

interface ExportSession { id?: unknown; title?: string }

interface StaticTranscriptContext {
  sessionId: string;
  index: number;
  lastUserIndex: number;
  assistantActionIndexes: Set<number>;
}
interface StaticTranscriptHost {
  normalizeSessionId: (value: unknown) => string | null;
  projectTranscript: (entries: TranscriptEntry[]) => TranscriptEntry[];
  renderTranscriptElement: (entry: TranscriptEntry, context: StaticTranscriptContext) => HTMLElement | null;
}
interface BrandAssets { day: string; night: string; favicon: string }
interface ExportOptions extends Partial<StaticTranscriptHost> {
  root?: Document;
  runtime?: Pick<typeof chrome.runtime, "getURL" | "getManifest">;
  downloads?: Pick<typeof chrome.downloads, "download">;
  request?: (type: string, payload: { sessionId: string }, timeout: number) => Promise<{ payload?: unknown }>;
  renderChatHtml?: (session: ExportSession, transcript: TranscriptEntry[]) => string | Promise<string>;
  getCurrentSessionId?: () => unknown;
  getAppVersion?: () => string;
  flashAction?: (button: HTMLButtonElement | null, label: string) => void;
  fetchStylesheet?: typeof fetch;
}
type SessionSnapshot = NonNullable<Parameters<typeof createSessionExchangePayload>[0]>;
interface ExportHtmlOptions {
  chatHtml?: string;
  stylesheet?: string;
  mathStylesheet?: string;
  skin?: { name?: string; path?: string };
  brandAssets?: Partial<BrandAssets>;
}

declare const SESSION_EXPORT_RUNTIME_SOURCE: string;

function renderSessionExportRuntime() {
  const keys = ["imagePreview", "images", "close", "importQingzhou", "importing", "imported", "retryImport", "importFailedRetry"] as const;
  const messages = JSON.stringify(Object.fromEntries(keys.map(key => [key, t(key)]))).replace(/</g, "\\u003c");
  return `<script type="application/json" id="qingzhou-export-messages">${messages}</script><script>${SESSION_EXPORT_RUNTIME_SOURCE.replace(/<\/script/giu, "<\\/script")}</script>`;
}

export function createSessionExportFeature(options: ExportOptions = {}) {
  if (typeof options.request !== "function") throw new Error("session export request adapter is required");
  if (typeof options.renderChatHtml !== "function" && typeof options.renderTranscriptElement !== "function") {
    throw new Error("session export transcript renderer is required");
  }

  const root = options.root || document;
  const runtime = options.runtime || globalThis.chrome?.runtime;
  const downloads = options.downloads || globalThis.chrome?.downloads;
  const request = options.request;
  const normalizeSessionId = options.normalizeSessionId || normalizeSessionIdValue;
  const projectTranscript = options.projectTranscript || (transcript => Array.isArray(transcript) ? transcript : []);
  const renderTranscriptElement = options.renderTranscriptElement!;
  const renderChatHtml = options.renderChatHtml || ((session: ExportSession, transcript: TranscriptEntry[]) => buildStaticSessionChatHtml(
    session,
    transcript,
    { normalizeSessionId, projectTranscript, renderTranscriptElement },
  ));
  const getCurrentSessionId = options.getCurrentSessionId || (() => "");
  const getAppVersion = options.getAppVersion || (() => runtime?.getManifest?.().version || "");
  const flashAction = options.flashAction || (() => {});
  const fetchStylesheet = options.fetchStylesheet || globalThis.fetch;
  const currentButton = root.querySelector<HTMLButtonElement>("#btn-export-session");
  const preparingSessionExportIds = new Set<string>();
  const sessionExportStylesheetPromises = new Map<string, Promise<string>>();
  let sessionExportBrandAssetsPromise: Promise<BrandAssets> | null = null;

  const onCurrentButtonClick = () => {
    void exportCurrentSession();
  };
  currentButton?.addEventListener("click", onCurrentButtonClick);

  return {
    exportSession: exportSessionHtml,
    createDocument: createSessionExportDocument,
    createDocumentFromSnapshot: createSessionExportDocumentFromSnapshot,
    isPreparing: (sessionId: unknown) => preparingSessionExportIds.has(normalizeSessionId(sessionId) || ""),
    syncCurrentControl: syncCurrentSessionExportControl,
    dispose,
  };

  async function exportCurrentSession() {
    const sessionId = normalizeSessionId(getCurrentSessionId());
    if (!sessionId) {
      flashAction(currentButton, t("cannotExport"));
      return false;
    }
    try {
      const exported = await exportSessionHtml(sessionId);
      if (exported && normalizeSessionId(getCurrentSessionId()) === sessionId) {
        flashAction(currentButton, t("exported"));
      }
      return exported;
    } catch (_error) {
      if (normalizeSessionId(getCurrentSessionId()) === sessionId) {
        flashAction(currentButton, t("exportFailed"));
      }
      return false;
    }
  }

  function dispose() {
    currentButton?.removeEventListener("click", onCurrentButtonClick);
  }

  async function exportSessionHtml(id: unknown) {
    const sessionId = normalizeSessionId(id);
    if (!sessionId) throw new Error(t("exportMissingSession"));
    if (preparingSessionExportIds.has(sessionId)) return false;

    setSessionExportPreparing(sessionId, true);
    try {
      await waitForSessionExportIndicatorPaint();
      const { html, filename } = await createSessionExportDocument(sessionId);
      setSessionExportPreparing(sessionId, false);
      await downloadSessionExportDocument({ html, filename });
      return true;
    } finally {
      setSessionExportPreparing(sessionId, false);
    }
  }

  async function downloadSessionExportDocument({ html, filename }: { html: string; filename: string }) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      await downloads.download({ url, filename, saveAs: true });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function setSessionExportPreparing(sessionId: unknown, preparing: boolean) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    if (preparing) preparingSessionExportIds.add(id);
    else preparingSessionExportIds.delete(id);

    for (const button of root.querySelectorAll<HTMLButtonElement>(".session-export-btn[data-id]")) {
      if (normalizeSessionId(button.dataset.id) === id) {
        syncSessionExportControl(button, preparingSessionExportIds.has(id));
      }
    }
    syncCurrentSessionExportControl();
  }

  function syncCurrentSessionExportControl() {
    const id = normalizeSessionId(getCurrentSessionId());
    syncSessionExportControl(currentButton, Boolean(id && preparingSessionExportIds.has(id)));
  }

  function syncSessionExportControl(button: HTMLButtonElement | null, preparing: boolean) {
    if (!button) return;
    const label = preparing ? t("preparingExport") : t("exportHtml");
    button.classList.toggle("is-preparing", preparing);
    button.disabled = preparing;
    if (preparing) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function waitForSessionExportIndicatorPaint() {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  async function createSessionExportDocument(id: unknown) {
    const sessionId = normalizeSessionId(id);
    if (!sessionId) throw new Error(t("exportMissingSession"));
    const result = await request("export_session_exchange", { sessionId }, 60000);
    return createSessionExportDocumentFromPayload(result.payload, sessionId);
  }

  async function createSessionExportDocumentFromSnapshot(snapshot: SessionSnapshot = {}) {
    const payload = createSessionExchangePayload({
      session: snapshot.session,
      conversation: snapshot.conversation,
      transcript: snapshot.transcript,
      runtime: snapshot.runtime,
      appVersion: snapshot.appVersion || getAppVersion(),
      exportedAt: snapshot.exportedAt,
    });
    return createSessionExportDocumentFromPayload(payload, payload.source.sessionId);
  }

  async function createSessionExportDocumentFromPayload(value: unknown, fallbackSessionId = "") {
    const payload = normalizeSessionExchangePayload(value);
    const session = {
      ...payload.session,
      id: payload.source.sessionId || normalizeSessionId(fallbackSessionId) || "exported-session",
    };
    const transcript = payload.session.transcript;

    if (!transcript.length) {
      throw new Error(t("exportEmptySession"));
    }

    const [chatHtml, skin, brandAssets] = await Promise.all([
      Promise.resolve(renderChatHtml(session, transcript)),
      loadSessionExportStylesheet(),
      loadSessionExportBrandAssets(),
    ]);
    // Load MathJax output rules only when the rendered chat contains a formula element.
    const mathStylesheet = /\bclass="[^"]*\bmath-formula\b/u.test(String(chatHtml || ""))
      ? mathExportStylesheet().catch(() => "")
      : Promise.resolve("");
    const html = buildSessionExportHtml(session, payload, {
      chatHtml: await inlineSessionExportMath(chatHtml),
      stylesheet: skin.css,
      mathStylesheet: await mathStylesheet,
      skin,
      brandAssets,
    });
    const filename = `${safeFilename(session.title || "session")}.html`;
    return { html, filename, payload };
  }

  function loadSessionExportStylesheet() {
    const active = resolveActiveSidepanelSkin({ root, runtime });
    if (!sessionExportStylesheetPromises.has(active.href)) {
      const loading = loadActiveSidepanelSkin({ root, runtime, fetchStylesheet })
        .then(loaded => loaded.css)
        .catch(() => "");
      sessionExportStylesheetPromises.set(active.href, loading);
    }
    return sessionExportStylesheetPromises.get(active.href)!.then(css => ({ ...active, css }));
  }

  function loadSessionExportBrandAssets() {
    if (!sessionExportBrandAssetsPromise) {
      sessionExportBrandAssetsPromise = Promise.all([
        loadSessionExportDataUrl("icons/logo-day.png"),
        loadSessionExportDataUrl("icons/logo-night.png"),
        loadSessionExportDataUrl("icons/icon32.png"),
      ])
        .then(([day, night, favicon]) => ({ day, night, favicon }))
        .catch(() => ({ day: "", night: "", favicon: "" }));
    }
    return sessionExportBrandAssetsPromise;
  }

  async function loadSessionExportDataUrl(path: string) {
    const response = await fetch(runtime.getURL(path));
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("asset read failed"));
      reader.readAsDataURL(blob);
    });
  }
}

export function buildStaticSessionChatHtml(session: ExportSession, transcript: TranscriptEntry[], host: StaticTranscriptHost) {
  const sessionId = host.normalizeSessionId(session?.id) || "exported-session";
  const history: TranscriptEntry[] = groupConsecutiveToolTranscriptEntries(host.projectTranscript(transcript));
  const lastUserIndex = findLastIndex(history, item => item?.type === "user");
  const assistantActionIndexes = new Set<number>();
  const container = document.createElement("div");

  history.forEach((entry, index) => {
    const element = createStaticTranscriptElement(entry, {
      ...host,
      sessionId,
      index,
      lastUserIndex,
      assistantActionIndexes,
    });
    if (!element) return;
    element.dataset.transcriptType = entry.type || "";
    stripStaticTranscriptActions(element);
    container.appendChild(element);
  });
  return container.innerHTML;
}

function createStaticTranscriptElement(entry: TranscriptEntry, context: StaticTranscriptContext & StaticTranscriptHost) {
  if (entry.type === "tool") {
    const element = renderToolEvent(entry, { expanded: false, lazyDetails: false, static: true });
    element.dataset.staticCollapsedLane = "summary";
    element.dataset.staticExpandedLane = toolEventLaneMode(entry, true);
    element.dataset.chatLane = "summary";
    return element;
  }
  if (entry.type === "tool-group") return createStaticToolTimelineGroup(entry);
  if (entry.type === "thinking-group") return createStaticThinkingTimelineGroup(entry);
  return context.renderTranscriptElement(entry, context);
}

function createStaticToolTimelineGroup(entry: TranscriptEntry) {
  const tools: TranscriptEntry[] = timelineGroupTools(entry);
  const element = createToolTimelineGroupElement(entry, { expanded: true, static: true });
  const expandedLane = element.dataset.chatLane || "detail";
  const details = element.querySelector<HTMLElement>(":scope > .tool-timeline-details");
  const summary = element.querySelector<HTMLElement>(":scope > .tool-timeline-summary");
  const initialIndex = Math.max(0, Number(details?.dataset.activeToolIndex ?? tools.length - 1) || 0);
  const initialTitle = summary?.querySelector<HTMLElement>(".tool-name")?.textContent || "";
  const initialPreview = summary?.querySelector<HTMLElement>(".tool-args-preview")?.textContent || "";
  tools.forEach((_tool, toolIndex) => {
    ensureToolTimelineActiveSlot(element, toolIndex);
    const template = document.createElement("template");
    template.className = "static-transcript-template";
    template.dataset.staticToolIndex = String(toolIndex);
    template.dataset.staticToolFamilyId = element.querySelector<HTMLElement>(".tool-family-row.active")?.dataset.toolFamilyId || "";
    template.dataset.staticToolFamilyNavHtml = element.querySelector<HTMLElement>(".tool-family-panel-nav")?.innerHTML || "";
    template.dataset.staticToolFamilyPanelHtml = element.querySelector<HTMLElement>(".tool-family-panel.active")?.innerHTML || "";
    template.dataset.staticToolTitle = summary?.querySelector<HTMLElement>(".tool-name")?.textContent || "";
    template.dataset.staticToolPreview = summary?.querySelector<HTMLElement>(".tool-args-preview")?.textContent || "";
    template.innerHTML = element.querySelector<HTMLElement>(".tool-timeline-slot")?.innerHTML || "";
    element.appendChild(template);
  });
  ensureToolTimelineActiveSlot(element, initialIndex);
  if (summary) {
    summary.setAttribute("aria-expanded", "false");
    const name = summary.querySelector<HTMLElement>(".tool-name");
    const preview = summary.querySelector<HTMLElement>(".tool-args-preview");
    const caret = summary.querySelector<HTMLElement>(".tool-caret");
    if (name) name.textContent = initialTitle;
    if (preview) preview.textContent = initialPreview;
    if (caret) caret.textContent = "▸";
  }
  details?.classList.add("hidden");
  element.classList.remove("tool-timeline-expanded");
  element.dataset.staticCollapsedLane = "summary";
  element.dataset.staticExpandedLane = expandedLane;
  element.dataset.chatLane = "summary";
  return element;
}

function createStaticThinkingTimelineGroup(entry: TranscriptEntry) {
  const thoughts: TranscriptEntry[] = thinkingTimelineGroupEntries(entry);
  const element = createThinkingTimelineGroupElement(entry, { expanded: true });
  const expandedLane = element.dataset.chatLane || "detail";
  const details = element.querySelector<HTMLElement>(":scope > .thinking-group-details");
  const summary = element.querySelector<HTMLElement>(":scope > .thinking-group-summary");
  const initialIndex = Math.max(0, Number(details?.dataset.activeThinkingIndex ?? thoughts.length - 1) || 0);
  const initialPreview = summary?.querySelector<HTMLElement>(".thinking-group-preview")?.innerHTML || "";
  thoughts.forEach((_thought, thoughtIndex) => {
    renderThinkingTimelineActiveSlot(element, thoughtIndex);
    const template = document.createElement("template");
    template.className = "static-transcript-template";
    template.dataset.staticThinkingIndex = String(thoughtIndex);
    template.innerHTML = element.querySelector<HTMLElement>(".thinking-group-slot")?.innerHTML || "";
    element.appendChild(template);
  });
  renderThinkingTimelineActiveSlot(element, initialIndex);
  if (summary) {
    summary.setAttribute("aria-expanded", "false");
    const preview = summary.querySelector<HTMLElement>(".thinking-group-preview");
    const caret = summary.querySelector<HTMLElement>(".thinking-caret");
    if (preview) preview.innerHTML = initialPreview;
    if (caret) caret.textContent = "▸";
  }
  details?.classList.add("hidden");
  element.classList.remove("thinking-group-expanded");
  element.dataset.staticCollapsedLane = "summary";
  element.dataset.staticExpandedLane = expandedLane;
  element.dataset.chatLane = "summary";
  return element;
}

function stripStaticTranscriptActions(element: HTMLElement) {
  element.querySelectorAll(".msg-actions, .msg-user-actions, .waiting-actions, .artifact-strip-open, .recovery-actions")
    .forEach(node => node.remove());
  element.classList.remove("is-editable", "is-resending");
  for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.target = "_blank";
    link.rel = "noreferrer noopener";
  }
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}

export function buildSessionExportHtml(session: ExportSession, exchangePayload: unknown, {
  chatHtml = "",
  stylesheet = "",
  mathStylesheet = "",
  skin = {},
  brandAssets = {},
}: ExportHtmlOptions = {}) {
  const title = session.title || t("qingzhouConversation");
  const dayLogo = String(brandAssets.day || "");
  const nightLogo = String(brandAssets.night || dayLogo);
  const favicon = String(brandAssets.favicon || "");
  const safeStylesheet = portableExportStylesheet(String(stylesheet || ""), {
    day: dayLogo,
    night: nightLogo,
    favicon,
  });
  const safeMathStylesheet = String(mathStylesheet || "").replace(/<\/style/giu, "<\\/style");
  const logoHtml = dayLogo
    ? `<div class="session-export-logo" aria-hidden="true">
        <img class="session-export-logo-day" src="${escapeHtml(dayLogo)}" alt="">
        <img class="session-export-logo-night" src="${escapeHtml(nightLogo)}" alt="">
      </div>`
    : "";
  const skinName = String(skin.name || "default");
  const skinPath = String(skin.path || "");
  const documentHtml = `<!doctype html>
<html lang="${getLanguage()}" dir="${getTextDirection()}" data-qingzhou-skin="${escapeHtml(skinName)}"${skinPath ? ` data-qingzhou-skin-path="${escapeHtml(skinPath)}"` : ""}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${favicon ? `<link rel="icon" type="image/png" href="${escapeHtml(favicon)}">` : ""}
  <style>${safeStylesheet}</style>
  <style>
    html, body { height: auto; min-height: 100%; overflow: visible; }
    body { background: var(--bg-primary); }
    .session-export-shell {
      --session-export-title-height: 30px;
      --chat-sticky-offset: var(--session-export-title-height);
      position: relative;
      width: min(var(--lane-detail-width), calc(100vw - 48px));
      min-height: 100vh;
      margin: 0 auto;
      padding: 0 0 44px;
    }
    #app {
      width: 100%;
      min-height: 100vh;
      height: auto;
      overflow: visible;
      z-index: 1;
      background: transparent;
    }
    #messages {
      flex: none;
      width: 100%;
      min-height: calc(100vh - 32px);
      overflow: visible;
      padding-bottom: 42px;
      align-items: flex-start;
    }
    #messages::before { height: 18px; }
    .session-title-bar {
      display: flex;
      align-items: center;
      height: var(--session-export-title-height);
      min-height: var(--session-export-title-height);
      padding: 0 8px 0 10px;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .session-title-bar > #current-session-title {
      flex: 1 1 auto;
      min-width: 0;
    }
    .session-export-logo {
      position: absolute;
      top: 50px;
      right: 92px;
      z-index: 0;
      display: block;
      width: 220px;
      height: 220px;
      opacity: 0.038;
      pointer-events: none;
    }
    .session-export-logo img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .session-export-logo-night { display: none !important; }
    .session-export-continuation {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 7px;
      height: 100%;
      margin-left: auto;
      color: var(--text-muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .session-export-cta {
      flex: 0 0 auto;
    }
    .session-export-cta[hidden] { display: none; }
    .msg-actions,
    .msg-user-actions,
    .waiting-actions,
    .artifact-strip-open,
    .recovery-actions,
    .tool-timeline-raw-btn,
    .tool-timeline-raw-panel,
    .tool-timeline-collapse-btn,
    .tool-event-raw-btn,
    .tool-event-raw-panel,
    .tool-event-collapse-btn { display: none !important; }
    .static-transcript-template { display: none !important; }
    @media (max-width: 920px) {
      .session-export-shell { width: min(calc(100vw - 44px), var(--lane-detail-width)); }
    }
    @media (max-width: 640px) {
      #messages { padding-inline: 12px; }
      .session-export-logo {
        top: 58px;
        right: 20px;
        width: 180px;
        height: 180px;
      }
    }
    @media (max-width: 420px) {
      .session-export-shell { width: min(calc(100vw - 40px), var(--lane-detail-width)); }
      .session-export-continuation { font-size: 10px; }
    }
    @media (prefers-color-scheme: dark) {
      .session-export-logo { opacity: 0.075; }
      .session-export-logo-day { display: none !important; }
      .session-export-logo-night { display: block !important; }
    }
    /* qingzhou-math-styles */
  </style>
</head>
<body>
  <div class="session-export-shell">
    ${logoHtml}
    <div id="app" class="qz:flex qz:flex-col qz:relative qz:rounded-none">
      <div id="session-title-bar" class="session-title-bar qz:flex-none qz:gap-2">
        <span id="current-session-title" class="qz:block qz:min-w-0 qz:max-w-full qz:truncate">${escapeHtml(title)}</span>
        <span class="session-export-continuation">
          <button id="qingzhou-session-cta" class="qz-btn qz-btn--primary qz-btn--xs session-export-cta" hidden type="button"></button>
        </span>
      </div>
      ${renderSessionExchangeScript(exchangePayload)}
      ${renderSessionExportRuntime()}
      <main id="messages">${chatHtml}</main>
    </div>
  </div>
</body>
</html>`;
  return documentHtml.replace("/* qingzhou-math-styles */", safeMathStylesheet);
}

const EXPORT_EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Keep skin rules inline and replace extension-relative assets with data URIs. */
function portableExportStylesheet(css: string, assets: { day?: string; night?: string; favicon?: string }) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gu, (match, _quote, raw) => {
    const value = String(raw).trim();
    if (!value || value.startsWith("data:") || value.startsWith("#")) return match;
    const embedded = value.includes("logo-night.png") ? assets.night
      : value.includes("logo-day.png") ? assets.day
      : value.includes("icon32.png") ? assets.favicon
      : "";
    return `url("${embedded || EXPORT_EMPTY_IMAGE}")`;
  }).replace(/<\/style/giu, "<\\/style");
}

type ExportMathRenderer = (tex: string, display: boolean) => Promise<string>;

/** Replace formula source with one self-contained SVG. Pending formulas stay as text. */
export async function inlineSessionExportMath(chatHtml = "", render: ExportMathRenderer = renderMathSvg) {
  const html = String(chatHtml || "");
  if (!/\bclass="[^"]*\bmath-formula\b/u.test(html) || typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const formulas = collectExportMathFormulas(template.content);
  if (render === renderMathSvg && formulas.some(node => node.dataset.mathPending !== "true")) {
    try {
      // tex2svgPromise keeps labels across calls. One reset per export lets \label and \ref resolve together.
      await withMathRuntime(async runtime => { runtime.texReset?.(); });
    } catch {
      // MathJax is unavailable; each formula below keeps its source text.
    }
  }
  for (const node of formulas) {
    if (node.dataset.mathPending === "true") continue;
    const display = node.classList.contains("math-display");
    const tex = exportMathTex(node, display);
    if (!tex) continue;
    let markup = "";
    try {
      markup = await render(tex, display);
    } catch {
      continue;
    }
    const parsed = document.createElement("template");
    parsed.innerHTML = markup;
    const svg = parsed.content.querySelector("svg");
    if (svg) node.replaceChildren(svg);
  }
  return template.innerHTML;
}

/** querySelectorAll does not look inside a template's content, where later thinking and tool steps live. */
function collectExportMathFormulas(root: ParentNode) {
  const formulas: HTMLElement[] = [];
  const visit = (parent: ParentNode) => {
    for (const node of parent.querySelectorAll(".math-formula")) {
      if (node instanceof HTMLElement) formulas.push(node);
    }
    for (const nested of parent.querySelectorAll("template")) {
      if (nested instanceof HTMLTemplateElement) visit(nested.content);
    }
  };
  visit(root);
  return formulas;
}

function exportMathTex(node: HTMLElement, display: boolean) {
  const text = (node.textContent || "").trim();
  const wrapped = (display ? /^\\\[([\s\S]*)\\\]$/u : /^\\\(([\s\S]*)\\\)$/u).exec(text);
  if (wrapped?.[1]?.trim()) return wrapped[1].trim();
  const fallback = (node.dataset.mathFallback || "").trim();
  if (text && !node.querySelector("svg, mjx-container")) return text;
  return fallback || text;
}

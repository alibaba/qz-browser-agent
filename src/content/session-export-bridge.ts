import { requestRuntimeMessage } from "../shared/transport/runtime-request.js";
import { readSessionImportLabels, sessionImportButtonText, type SessionImportLabels } from "../shared/session/session-import-copy.js";
import { refreshContentLanguage, t } from "./i18n.js";
import { isAllowedSessionExchangeLocation } from "../shared/session/session-exchange-source.js";
declare global {
  interface Window { __QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION?: string }
}
export {};

/**
 * Session export bridge.
 *
 * This intentionally runs at document_start without the page-reading vendor stack so an
 * exported conversation can detect Qingzhou before deferred render dependencies finish.
 */

(() => {
  const BRIDGE_VERSION = "2026-07-16-session-export-import";
  const QINGZHOU_SESSION_EXPORT_PROBE = "qingzhou:session-export:probe";
  const QINGZHOU_SESSION_EXPORT_RESULT = "qingzhou:session-export:result";
  const QINGZHOU_SESSION_EXCHANGE_SCRIPT_ID = "qingzhou-session-exchange";
  let importPending = false;
  let importLabels: SessionImportLabels | null = null;
  let loadedLanguage: string | null = null;
  let loading: Promise<SessionImportLabels | null> | null = null;
  let loadingLanguage = "";
  let languageWatching = false;
  let buttonWatching = false;

  if (window.__QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION === BRIDGE_VERSION) return;
  window.__QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION = BRIDGE_VERSION;

  window.addEventListener("message", handleProbeMessage);
  document.addEventListener("click", handleImportClick, true);
  announceBridge();
  armImportCopy();

  function handleProbeMessage(event: MessageEvent<unknown>) {
    if (event.source !== window || !isRecord(event.data) || event.data.type !== QINGZHOU_SESSION_EXPORT_PROBE) return;
    if (!getPayloadScript()) return;
    startImportCopy();
    postBridgeResult("probe", probeDetail(String(event.data?.requestId || "")));
  }

  function announceBridge() {
    if (!getPayloadScript()) return;
    startImportCopy();
    postBridgeResult("probe", probeDetail(""));
  }

  function pageLanguage() {
    return document.documentElement?.lang?.trim() || "";
  }

  function probeDetail(requestId: string) {
    return {
      ...(requestId ? { requestId } : {}),
      installed: true,
      name: chrome.runtime.getManifest?.().name || t("brand"),
      version: chrome.runtime.getManifest?.().version || "",
      bridgeVersion: BRIDGE_VERSION,
      ...(importLabels && loadedLanguage === pageLanguage() ? { labels: importLabels } : {}),
    };
  }

  function armImportCopy() {
    if (getPayloadScript()) startImportCopy();
    const root = document.documentElement;
    if (!root || getPayloadScript()) return;
    const arm = new MutationObserver(() => {
      if (!getPayloadScript()) return;
      arm.disconnect();
      startImportCopy();
    });
    arm.observe(root, { childList: true, subtree: true });
  }

  function startImportCopy() {
    if (!getPayloadScript()) return;
    watchImportButton();
    if (languageWatching) return;
    languageWatching = true;
    const root = document.documentElement;
    if (root) {
      new MutationObserver(() => { void refreshImportCopy(); }).observe(root, { attributes: true, attributeFilter: ["lang"] });
    }
    void refreshImportCopy();
  }

  function watchImportButton() {
    if (buttonWatching) return;
    const button = document.getElementById("qingzhou-session-cta");
    const parent = button?.parentElement;
    if (!parent) return;
    buttonWatching = true;
    new MutationObserver(() => applyImportButton()).observe(parent, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["aria-busy", "title", "data-qingzhou-imported-session-id", "data-qingzhou-session-import", "disabled"],
    });
  }

  function loadImportLabels(): Promise<SessionImportLabels | null> {
    const language = pageLanguage();
    if (loadedLanguage === language) return Promise.resolve(importLabels);
    if (loading && loadingLanguage === language) return loading;
    loadingLanguage = language;
    const pending: Promise<SessionImportLabels | null> = requestImportLabels(language).then((next): Promise<SessionImportLabels | null> | SessionImportLabels | null => {
      if (pageLanguage() !== language) return loadImportLabels();
      importLabels = next;
      loadedLanguage = language;
      return next;
    }).finally(() => {
      if (loadingLanguage === language) loading = null;
    });
    loading = pending;
    return pending;
  }

  async function requestImportLabels(language: string): Promise<SessionImportLabels | null> {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: "session_export_import_labels", language });
      if (!isRecord(response) || response.ok !== true) return null;
      return readSessionImportLabels(response.labels);
    } catch {
      return null;
    }
  }

  async function refreshImportCopy() {
    const language = pageLanguage();
    const previous = loadedLanguage === language ? importLabels : null;
    const next = await loadImportLabels();
    if (pageLanguage() !== language || !next) return;
    const changed = JSON.stringify(next) !== JSON.stringify(previous);
    watchImportButton();
    applyImportButton();
    if (changed && getPayloadScript()) postBridgeResult("probe", probeDetail(""));
  }

  function applyImportButton() {
    if (!importLabels) return;
    const button = document.getElementById("qingzhou-session-cta");
    if (!(button instanceof HTMLButtonElement) || !button.hasAttribute("data-qingzhou-session-import")) return;
    const text = sessionImportButtonText({
      busy: button.getAttribute("aria-busy") === "true",
      imported: Boolean(button.getAttribute("data-qingzhou-imported-session-id")),
      titled: Boolean(button.title),
    }, importLabels);
    if (button.textContent !== text) button.textContent = text;
  }

  async function handleImportClick(event: MouseEvent) {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const button = target?.closest?.("[data-qingzhou-session-import]");
    if (!button || !document.contains(button)) return;
    const script = getPayloadScript();
    if (!script) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (importPending) return;

    importPending = true;
    let reveal: unknown;
    try {
      reveal = await chrome.runtime.sendMessage({ type: "session_export_reveal_consent" });
    } catch {
      importPending = false;
      return;
    }
    // Without disclosure consent this click only opens the side panel. The next click imports.
    if (!isRecord(reveal) || reveal.ok !== true || reveal.needsConsent !== false) {
      importPending = false;
      return;
    }

    postBridgeResult("import", { status: "working", ok: false });
    try {
      await refreshContentLanguage();
      const payload = JSON.parse(String(script.textContent || ""));
      const result: unknown = await requestRuntimeMessage({
        type: "session_export_import_request",
        payload,
      });
      if (!isRecord(result) || !result.ok) throw new Error(isRecord(result) ? String(result.error || t("importFailed")) : t("importFailed"));
      postBridgeResult("import", {
        status: "done",
        ok: true,
        sessionId: String((isRecord(result.session) ? result.session.id : "") || result.sessionId || ""),
      });
    } catch (err) {
      postBridgeResult("import", {
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      importPending = false;
    }
  }

  function getPayloadScript() {
    if (!isAllowedLocation()) return null;
    const script = document.getElementById(QINGZHOU_SESSION_EXCHANGE_SCRIPT_ID);
    if (!(script instanceof HTMLScriptElement) || script.type !== "application/json") return null;
    const header = String(script.textContent || "").slice(0, 256);
    if (!/"format"\s*:\s*"qingzhou\.session"/u.test(header)) return null;
    if (!/"version"\s*:\s*1(?:\D|$)/u.test(header)) return null;
    return script;
  }

  function isAllowedLocation() {
    return isAllowedSessionExchangeLocation(location);
  }

  function postBridgeResult(action: "probe" | "import", detail: Record<string, unknown> = {}) {
    const targetOrigin = location.protocol === "file:" || location.origin === "null"
      ? "*"
      : location.origin;
    window.postMessage({
      type: QINGZHOU_SESSION_EXPORT_RESULT,
      action,
      ...detail,
    }, targetOrigin);
  }
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

import { t } from "../../shared/i18n/backend.js";
import { isAllowedSessionExchangeLocation } from "../../shared/session/session-exchange-source.js";
import { normalizeSessionExchangePayload } from "../../shared/session/session-exchange.js";

type Fields = Record<string, unknown>;
interface SessionExchangeBridgeOptions {
  sidePanel?: Pick<typeof chrome.sidePanel, "open">;
  importSessionExchange(payload: ReturnType<typeof normalizeSessionExchangePayload>, options: { sourceWindowId?: number }): Promise<{ session?: Fields | null; ownedTabsRestore?: unknown; [key: string]: unknown }>;
  channel: {
    hasPorts(): boolean;
    broadcast(event: Fields): unknown;
    remember(key: string, event: Fields, ttlMs?: number, options?: { windowId?: number | null }): unknown;
    sendToWindow?(windowId: unknown, event: Fields): Promise<boolean> | boolean;
  };
  logger?: Pick<Console, "debug">;
  /** False opens the consent page and leaves this click on the button. Omitted is not accepted. */
  consentAccepted?: () => boolean;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error;

export function createSessionExchangeBridge({
  sidePanel = globalThis.chrome?.sidePanel,
  importSessionExchange,
  channel,
  logger = console,
  consentAccepted = () => false,
}: SessionExchangeBridgeOptions) {
  async function importFromPage(message: Fields = {}, sender: chrome.runtime.MessageSender = {}) {
    if (!isAllowedSessionExportSource(sender?.tab?.url)) {
      const error = Object.assign(new Error(t("exchange.sourceDenied")), { code: "SESSION_EXPORT_SOURCE_NOT_ALLOWED" });
      throw error;
    }
    const payload = normalizeSessionExchangePayload(message.payload);
    const windowId = sender?.tab?.windowId;
    openSidePanel(sender?.tab?.windowId).catch(error => {
      logger.debug?.("[轻舟] open side panel for exported session failed:", errorMessage(error));
    });
    const result = await importSessionExchange(payload, {
      sourceWindowId: windowId,
    });
    const event = {
      type: "session_imported_from_export",
      sessionId: String(result.session?.id || ""),
      session: result.session,
      ownedTabsRestore: result.ownedTabsRestore || null,
      sourceTabId: Number(sender?.tab?.id) || null,
    };
    await deliverImportedSession(windowId, event);
    return result;
  }

  function revealForImport(sender: chrome.runtime.MessageSender = {}) {
    // sidePanel.open has to start on this message turn so the click stays a user gesture.
    openSidePanel(sender?.tab?.windowId).catch(error => {
      logger.debug?.("[轻舟] open side panel for session import failed:", errorMessage(error));
    });
    return { needsConsent: !consentAccepted() };
  }

  async function deliverImportedSession(windowId: unknown, event: Fields) {
    const target = normalizeImportWindowId(windowId);
    if (typeof channel.sendToWindow === "function") {
      if (await channel.sendToWindow(target, event)) return;
      channel.remember("session_export_import", event, 15_000, { windowId: target });
      return;
    }
    if (channel.hasPorts()) channel.broadcast(event);
    else channel.remember("session_export_import", event);
  }

  async function openSidePanel(windowId: unknown) {
    const id = normalizeImportWindowId(windowId);
    if (id === null || !sidePanel?.open) return false;
    await sidePanel.open({ windowId: id });
    return true;
  }

  return Object.freeze({
    importFromPage,
    revealForImport,
    openSidePanel,
  });
}

function normalizeImportWindowId(windowId: unknown) {
  const id = Number(windowId);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

export function isAllowedSessionExportSource(value: unknown) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    return false;
  }
  return isAllowedSessionExchangeLocation(url);
}

import { DATA_CONSENT_KEY, DATA_CONSENT_VERSION, hasDataConsent } from "../../shared/data-consent.js";
import { t } from "../../shared/i18n/backend.js";

export function createDataConsentService(storage: Pick<chrome.storage.StorageArea, "get" | "set">) {
  let accepted = false;
  let release: () => void;
  const whenAccepted = new Promise<void>(resolve => { release = resolve; });
  function markAccepted() { accepted = true; release(); }
  const ready = storage.get(DATA_CONSENT_KEY).then(data => {
    if (hasDataConsent(data[DATA_CONSENT_KEY])) markAccepted();
  }).catch(() => { /* A failed read keeps data use blocked; the panel can retry acceptance. */ });

  function assertAccepted() {
    if (!accepted) throw Object.assign(new Error(t("dataConsentRequired")), { code: "DATA_CONSENT_REQUIRED" });
  }
  async function accept(version: unknown, sender: chrome.runtime.MessageSender) {
    assertSidePanelSender(sender);
    if (version !== DATA_CONSENT_VERSION) throw new Error("Data disclosure has changed. Reopen the side panel.");
    await ready;
    if (!accepted) {
      await storage.set({ [DATA_CONSENT_KEY]: { version: DATA_CONSENT_VERSION, acceptedAt: Date.now() } });
      markAccepted();
    }
    return { accepted: true };
  }
  return { ready, whenAccepted, assertAccepted, accept };
}

export function assertSidePanelSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel/sidepanel.html")) {
    throw new Error("Data consent must be given in the side panel");
  }
}

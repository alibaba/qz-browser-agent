import { DATA_CONSENT_KEY, DATA_CONSENT_VERSION, hasDataConsent } from "../../../shared/data-consent.js";
import { t } from "../../i18n/index.js";
import { localizeDocument } from "../../i18n/dom.js";

/** Defer workspace initialization, including context collection, until consent is stored. */
export async function ensureDataConsent({ onPrompt }: { onPrompt?: () => void } = {}): Promise<void> {
  const data = await chrome.storage.local.get(DATA_CONSENT_KEY);
  if (hasDataConsent(data[DATA_CONSENT_KEY])) return;
  onPrompt?.();
  const app = document.querySelector<HTMLElement>("#app")!;
  const template = document.querySelector<HTMLTemplateElement>("#data-consent-template")!;
  const card = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  localizeDocument(card);
  card.querySelector("h1")!.textContent = t("dataConsentTitle", { brand: t("brand") });
  app.inert = true;
  app.setAttribute("data-consent-pending", "");
  document.body.append(card);
  const accept = card.querySelector<HTMLButtonElement>("[data-consent-accept]")!;
  const later = card.querySelector<HTMLButtonElement>("[data-consent-later]")!;
  const error = card.querySelector<HTMLElement>("[role=alert]")!;
  const events = new AbortController();
  await new Promise<void>(resolve => {
    function finish() {
      if (events.signal.aborted) return;
      events.abort();
      chrome.storage.onChanged.removeListener(changed);
      card.remove();
      app.inert = false;
      app.removeAttribute("data-consent-pending");
      resolve();
    }
    function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) {
      if (area === "local" && hasDataConsent(changes[DATA_CONSENT_KEY]?.newValue)) finish();
    }
    chrome.storage.onChanged.addListener(changed);
    window.addEventListener("pagehide", () => {
      events.abort();
      chrome.storage.onChanged.removeListener(changed);
    }, { once: true, signal: events.signal });
    later.addEventListener("click", () => window.close(), { signal: events.signal });
    accept.addEventListener("click", async () => {
      accept.disabled = later.disabled = true;
      accept.textContent = t("saving");
      error.textContent = "";
      try {
        const response = await chrome.runtime.sendMessage({ type: "accept_data_consent", version: DATA_CONSENT_VERSION });
        if (!response?.ok || response.accepted !== true) throw new Error("Consent was not saved");
        finish();
      } catch {
        if (events.signal.aborted) return;
        error.textContent = t("dataConsentSaveFailed");
        accept.disabled = later.disabled = false;
        accept.textContent = t("dataConsentAccept");
      }
    }, { signal: events.signal });
    accept.focus();
    // Another panel may have accepted between the initial read and listener registration.
    void chrome.storage.local.get(DATA_CONSENT_KEY).then(current => {
      if (hasDataConsent(current[DATA_CONSENT_KEY])) finish();
    }).catch(() => {});
  });
}

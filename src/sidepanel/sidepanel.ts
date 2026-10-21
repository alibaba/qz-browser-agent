import { t } from "./i18n/index.js";
import { initializeLanguage, getLanguage, getTextDirection } from "../shared/i18n/index.js";
export {};
const WORKSPACE_BOOT_TIMEOUT_MS = 6000;
const app = document.querySelector("#app");
const fallback = document.querySelector("#workspace-boot-fallback");

function revealFallback(message: string, reason: string) {
  if (fallback) {
    fallback.textContent = message;
    fallback.classList.remove("hidden");
  }
  app?.setAttribute("data-workspace-boot-fallback", reason);
  app?.removeAttribute("data-workspace-booting");
}

let timeout: ReturnType<typeof setTimeout> | undefined;
function startBootTimer() {
  clearTimeout(timeout);
  timeout = setTimeout(() => revealFallback(t("startupSlow"), "timeout"), WORKSPACE_BOOT_TIMEOUT_MS);
}
startBootTimer();

try {
  const [, { localizeDocument }] = await Promise.all([initializeLanguage(), import("./i18n/dom.js")]);
  document.documentElement.lang = getLanguage();
  document.documentElement.dir = getTextDirection();
  localizeDocument(document);
  fallback?.classList.add("hidden");
  app?.setAttribute("data-workspace-booting", "");
  startBootTimer();
  const { ensureDataConsent } = await import("./features/app/data-consent.js");
  await ensureDataConsent({ onPrompt: () => clearTimeout(timeout) });
  startBootTimer();
  await import("./app.js");
  fallback?.classList.add("hidden");
  app?.removeAttribute("data-workspace-boot-fallback");
} catch (error) {
  console.error("[轻舟] side panel startup failed", error);
  revealFallback(t("startupFailed"), "error");
} finally {
  clearTimeout(timeout);
  app?.removeAttribute("data-workspace-booting");
}

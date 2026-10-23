import coreMessages from "../../sidepanel/i18n/messages.js";
import { createTranslator, getLanguage, resolveLanguage, withLanguage } from "../../shared/i18n/index.js";
import { languageRuntime } from "../../shared/i18n/runtime.js";
import { sessionImportLabelKeys, type SessionImportLabels } from "../../shared/session/session-import-copy.js";

/**
 * Page `lang` wins. An empty page language uses the extension language.
 * A page language whose catalog is not available returns null so baked page copy stays put.
 */
export async function createSessionImportLabels(pageLanguage?: string): Promise<SessionImportLabels | null> {
  const requested = pageLanguage?.trim() || "";
  const resolved = resolveLanguage(requested || getLanguage());
  await languageRuntime.ensureLanguage(resolved);
  const labels = withLanguage(resolved, () => {
    const t = createTranslator(coreMessages);
    return Object.fromEntries(sessionImportLabelKeys.map(key => [key, t(key)])) as SessionImportLabels;
  });
  const authored = resolved === "en" || resolved === "zh-CN" ? coreMessages.messages.importQingzhou[resolved] : undefined;
  if (requested && !authored && resolved !== "en" && labels.importQingzhou === coreMessages.messages.importQingzhou.en) return null;
  return labels;
}

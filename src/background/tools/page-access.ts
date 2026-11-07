import { chromePdfViewerDocumentUrl, isChromePdfViewerUrl, isLocalFileUrl, isPageTabUrl } from "../../shared/tab-utils.js";
import { t } from "../../shared/i18n/backend.js";
import { ToolExecutionError } from "./arguments.js";

/** PDF viewers expose browser UI, not an HTML document body. */
export function assertHtmlPage(url: unknown, contentType: unknown = "") {
  if (!isChromePdfViewerUrl(url) && String(contentType).split(";")[0].trim().toLowerCase() !== "application/pdf") return;
  throw new ToolExecutionError("PDF_PAGE_UNSUPPORTED", t("toolError.PDF_PAGE_UNSUPPORTED.message"), {
    url: chromePdfViewerDocumentUrl(url) || String(url || ""),
  });
}

/** Chrome's file URL toggle is separate from optional browser permissions. */
export async function assertPageUrlAccessible(url: string) {
  if (!isPageTabUrl(url)) {
    throw new ToolExecutionError("UNSUPPORTED_URL", "Only HTTP, HTTPS, and permitted file URLs are supported", { url });
  }
  if (!isLocalFileUrl(url)) return;
  let allowed = false;
  try { allowed = await chrome.extension?.isAllowedFileSchemeAccess?.() === true; } catch (_error) {}
  if (!allowed) {
    throw new ToolExecutionError("FILE_ACCESS_REQUIRED",
      "Local file access is disabled. Enable Allow access to file URLs in the extension details before reading or operating local files.", { url });
  }
}

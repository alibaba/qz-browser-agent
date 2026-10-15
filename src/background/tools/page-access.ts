import { isLocalFileUrl, isPageTabUrl } from "../../shared/tab-utils.js";
import { ToolExecutionError } from "./arguments.js";

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

import type { OptionalBrowserPermission } from "../../shared/browser-permissions.js";
import { firefoxExtension } from "../../shared/product-text.js";
export { permissionT } from "../../shared/browser-permissions.js";

/** Invoke directly from a user gesture, before any asynchronous work. Chrome reuses existing grants. */
export function requestBrowserPermission(permission: OptionalBrowserPermission): Promise<boolean> {
  const request: chrome.permissions.Permissions & { data_collection?: string[] } = { permissions: [permission] };
  // Firefox optional data collection must be requested with the matching API permission.
  if (firefoxExtension() && permission === "bookmarks") request.data_collection = ["bookmarksInfo"];
  return chrome.permissions.request(request);
}

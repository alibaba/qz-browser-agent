import type { OptionalBrowserPermission } from "../../shared/browser-permissions.js";
export { permissionT } from "../../shared/browser-permissions.js";

/** Invoke directly from a user gesture, before any asynchronous work. Chrome reuses existing grants. */
export function requestBrowserPermission(permission: OptionalBrowserPermission): Promise<boolean> {
  return chrome.permissions.request({ permissions: [permission] });
}

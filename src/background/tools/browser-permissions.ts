import type { ToolContext } from "../../sdk/background.js";
import type { ToolRuntimeDependencies } from "../../sdk/background/services.js";
import { permissionT, type ToolBrowserPermission } from "../../shared/browser-permissions.js";
import { withLanguage, getLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "./arguments.js";

/** Human approval is outside the tool deadline and remains owned by the current Session run. */
export async function ensureToolBrowserPermission(
  permission: ToolBrowserPermission, context: ToolContext, signal: AbortSignal | undefined,
  { sessions, emit }: ToolRuntimeDependencies,
) {
  const { sessionId = "", runId = "" } = context;
  const message = (key: "required" | "denied" | "title" | ToolBrowserPermission) =>
    withLanguage(context.language || getLanguage(), () => permissionT(key, { permission: permissionT(`name.${permission}`) }));
  const assertActive = () => {
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while requesting permission");
    if (sessionId && runId && sessions && sessions.isRunCurrent?.(sessionId, runId) === false) {
      throw new ToolExecutionError("STALE_RUN", "The task run ended while requesting permission");
    }
  };
  assertActive();
  const granted = await chrome.permissions.contains({ permissions: [permission] });
  assertActive();
  if (granted) return;
  if (!sessionId || !runId || !sessions?.beginUserWait || !sessions.isWaitingForUser || !emit || sessions.isWaitingForUser(sessionId)) {
    throw new ToolExecutionError("BROWSER_PERMISSION_REQUIRED", message("required"), { permission });
  }
  const waitId = `permission_${crypto.randomUUID()}`;
  const pending = sessions.beginUserWait(sessionId, {
    waitId, runId, signal,
    onSettled: reason => emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason }),
  });
  emit({ type: "waiting_for_user", sessionId, runId, waitId,
    message: message(permission), form: { title: message("title"), browserPermission: permission } });
  await pending;
  assertActive();
  // A continue command confirms user intent; Chrome remains the authority for access.
  const allowed = await chrome.permissions.contains({ permissions: [permission] });
  assertActive();
  if (!allowed) throw new ToolExecutionError("BROWSER_PERMISSION_DENIED", message("denied"), { permission });
}

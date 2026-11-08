import type { ToolContext } from "../../sdk/background.js";
import type { ToolRuntimeDependencies } from "../../sdk/background/services.js";
import { permissionT, type ToolBrowserPermission } from "../../shared/browser-permissions.js";
import { withLanguage, getLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "./arguments.js";

interface PendingPermission {
  runId: string;
  permission: ToolBrowserPermission;
  controller: AbortController;
  promise: Promise<unknown>;
  waiters: number;
}
const pendingPermissions = new WeakMap<object, Map<string, PendingPermission>>();
const aborted = () => new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while requesting permission");

async function joinPermissionWait(pending: PendingPermission, signal?: AbortSignal) {
  pending.waiters++;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await pending.promise;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(aborted());
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([pending.promise, cancelled]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (--pending.waiters === 0) pending.controller.abort();
  }
}

/** Human approval is outside the tool deadline and remains owned by the current Session run. */
export async function ensureToolBrowserPermission(
  permission: ToolBrowserPermission, context: ToolContext, signal: AbortSignal | undefined,
  { sessions, emit }: ToolRuntimeDependencies,
) {
  const { sessionId = "", runId = "" } = context;
  const message = (key: "required" | "denied" | "title" | ToolBrowserPermission) =>
    withLanguage(context.language || getLanguage(), () => permissionT(key, { permission: permissionT(`name.${permission}`) }));
  const assertActive = () => {
    if (signal?.aborted) throw aborted();
    if (sessionId && runId && sessions && sessions.isRunCurrent?.(sessionId, runId) === false) {
      throw new ToolExecutionError("STALE_RUN", "The task run ended while requesting permission");
    }
  };
  assertActive();
  const granted = await chrome.permissions.contains({ permissions: [permission] });
  assertActive();
  if (granted) return;
  if (!sessionId || !runId || !sessions?.beginUserWait || !sessions.isWaitingForUser || !emit) {
    throw new ToolExecutionError("BROWSER_PERMISSION_REQUIRED", message("required"), { permission });
  }
  // Per-call Session facades change object identity; this supervisor closure retains its owner.
  const owner = sessions.beginUserWait;
  const requests = pendingPermissions.get(owner) || new Map<string, PendingPermission>();
  pendingPermissions.set(owner, requests);
  let pending = requests.get(sessionId);
  if (!pending || pending.controller.signal.aborted || pending.runId !== runId || pending.permission !== permission) {
    if (sessions.isWaitingForUser(sessionId)) {
      throw new ToolExecutionError("BROWSER_PERMISSION_REQUIRED", message("required"), { permission });
    }
    const waitId = `permission_${crypto.randomUUID()}`;
    const controller = new AbortController();
    pending = { runId, permission, controller, waiters: 0,
      promise: sessions.beginUserWait(sessionId, {
        waitId, runId, signal: controller.signal,
        onSettled: reason => emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason }),
      }),
    };
    const owned = pending;
    pending.promise = pending.promise.finally(() => {
      if (requests.get(sessionId) === owned) requests.delete(sessionId);
    });
    requests.set(sessionId, pending);
    try {
      emit({ type: "waiting_for_user", sessionId, runId, waitId,
        message: message(permission), form: { title: message("title"), browserPermission: permission } });
    } catch (error) {
      controller.abort();
      await pending.promise.catch(() => {});
      throw error;
    }
  }
  await joinPermissionWait(pending, signal);
  assertActive();
  // A continue command confirms user intent; Chrome remains the authority for access.
  const allowed = await chrome.permissions.contains({ permissions: [permission] });
  assertActive();
  if (!allowed) throw new ToolExecutionError("BROWSER_PERMISSION_DENIED", message("denied"), { permission });
}

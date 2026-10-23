import type { ToolContext } from "../../sdk/background.js";
import type { ToolRuntimeDependencies } from "../../sdk/background/services.js";
import { debuggerDetachT } from "../../shared/debugger-detach.js";
import { withLanguage, getLanguage } from "../../shared/i18n/index.js";

/** A dismissed debugging bar pauses the run until the user chooses to continue or stop. */
export async function confirmDebuggerReattach(
  { sessionId, runId, context, signal = null }: { tabId: number; sessionId: string; runId: string; context: ToolContext; signal?: AbortSignal | null },
  { sessions, emit }: ToolRuntimeDependencies,
): Promise<boolean> {
  if (!sessionId || !runId || typeof sessions?.beginUserWait !== "function" || typeof emit !== "function"
    || sessions.isWaitingForUser?.(sessionId)) {
    return true;
  }
  const text = (key: "title" | "message") => withLanguage(context.language || getLanguage(), () => debuggerDetachT(key));
  const waitId = `debugger_reattach_${crypto.randomUUID()}`;
  const pending = sessions.beginUserWait(sessionId, {
    waitId, runId, signal: signal ?? undefined,
    onSettled: reason => emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason }),
  });
  emit({
    type: "waiting_for_user", sessionId, runId, waitId,
    message: text("message"), form: { title: text("title"), debuggerDetached: true },
  });
  try {
    await pending;
    return true;
  } catch (error) {
    if (String((error as { code?: unknown })?.code || "") === "USER_CANCELLED_WAIT") {
      // Stop ends the run so no later tool call can silently re-attach. source "ui" records
      // the same stopped_by_user reason as the panel's stop button.
      await sessions.stopSession?.(sessionId, { source: "ui", requestedBy: "user" })?.catch(() => {});
    }
    return false;
  }
}

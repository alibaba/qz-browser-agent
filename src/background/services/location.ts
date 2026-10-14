import type { ToolContext } from "../../sdk/background.js";
import type { UserWaitRuntime, ToolEvent } from "../../sdk/background/services.js";
import { hasDataConsent, DATA_CONSENT_VERSION, LOCATION_CONSENT_KEY } from "../../shared/data-consent.js";
import { t } from "../../shared/i18n/backend.js";
import { withLanguage, getLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "../tools/arguments.js";
import { assertSidePanelSender } from "./data-consent.js";

type Approval = { context: ToolContext; signal?: AbortSignal };
interface LocationHost {
  storage: Pick<chrome.storage.StorageArea, "get" | "set">;
  sessions: Pick<UserWaitRuntime, "beginUserWait" | "isWaitingForUser"> & { isRunCurrent(sessionId: string, runId: string): boolean };
  emit(event: ToolEvent): unknown;
  locate(options: { windowId?: number | null; signal?: AbortSignal }): Promise<Record<string, unknown> | null>;
}

/** Location consent is granted by a panel click, independently of continuing a task. */
export function createLocationService({ storage, sessions, emit, locate }: LocationHost) {
  const approvals = new Map<string, Approval>();
  const message = (context: ToolContext, key: "locationDisclosure" | "locationTitle" | "locationRequired" | "locationUnavailable") =>
    withLanguage(context.language || getLanguage(), () => t(key));
  function assertActive({ context, signal }: Approval) {
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Location request aborted");
    if (!context.sessionId || !context.runId || !sessions.isRunCurrent(context.sessionId, context.runId)) {
      throw new ToolExecutionError("STALE_RUN", "The location request no longer belongs to an active run");
    }
  }
  async function accepted() { return hasDataConsent((await storage.get(LOCATION_CONSENT_KEY))[LOCATION_CONSENT_KEY]); }
  async function request(context: ToolContext, signal?: AbortSignal) {
    const approval = { context, signal };
    assertActive(approval);
    if (!await accepted()) {
      assertActive(approval);
      const sessionId = String(context.sessionId), runId = String(context.runId);
      if (sessions.isWaitingForUser(sessionId)) throw new ToolExecutionError("LOCATION_CONSENT_REQUIRED", message(context, "locationRequired"));
      const waitId = `location_${crypto.randomUUID()}`;
      approvals.set(waitId, approval);
      try {
        const pending = sessions.beginUserWait(sessionId, { waitId, runId, signal,
          onSettled: reason => { approvals.delete(waitId); emit({ type: "user_wait_resolved", sessionId, runId, waitId, reason }); },
        });
        emit({ type: "waiting_for_user", sessionId, runId, waitId,
          message: message(context, "locationDisclosure"), form: { title: message(context, "locationTitle"), locationConsent: true } });
        await pending;
      } finally { approvals.delete(waitId); }
      assertActive(approval);
      if (!await accepted()) throw new ToolExecutionError("LOCATION_CONSENT_REQUIRED", message(context, "locationRequired"));
    }
    assertActive(approval);
    const location = await locate({ windowId: context.sourceWindowId, signal });
    assertActive(approval);
    if (!location) throw new ToolExecutionError("LOCATION_UNAVAILABLE", message(context, "locationUnavailable"));
    return location;
  }
  async function accept(waitId: string, sessionId: string, sender: chrome.runtime.MessageSender) {
    assertSidePanelSender(sender);
    const approval = approvals.get(waitId);
    if (!approval || approval.context.sessionId !== sessionId) throw new ToolExecutionError("STALE_RUN", "Location approval has expired");
    assertActive(approval);
    await storage.set({ [LOCATION_CONSENT_KEY]: { version: DATA_CONSENT_VERSION, acceptedAt: Date.now() } });
    return { accepted: true };
  }
  return { request, accept };
}

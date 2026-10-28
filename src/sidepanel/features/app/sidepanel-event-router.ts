import { t } from "../../i18n/index.js";
import { sessionIdText as normalizeSessionId } from "../sessions/session-id.js";
import type { SessionState, SessionViewEvent } from "../sessions/session-state.js";
import type { SessionMetadata } from "../../../shared/session/session-store.js";
import type { TranscriptEntry } from "../../../shared/contracts/session.js";
import type { createChatRunController } from "../chat/chat-run-controller.js";
import type { createQueuedFollowupsFeature, OutgoingBatch } from "../chat/queued-followups-feature.js";
import type { createGoalStripFeature } from "../chat/goal-strip-feature.js";
import type { createTranscriptReconcileFeature } from "../chat/transcript/recovery.js";
import type { createSessionNavigationFeature } from "../sessions/session-navigation-feature.js";
import type { PortMessage } from "./port-client.js";
import { record } from "../../tools/renderer-input.js";
interface RouterEvent extends SessionViewEvent {
  firstMessage?: string; delayMs?: number; maxRetries?: number; logs?: unknown[]; hasHistory?: boolean;
  action?: string; save?: boolean; fields?: string[]; requestId?: string;
}
type Navigation = ReturnType<typeof createSessionNavigationFeature>;
interface RouterOptions extends Partial<Pick<Navigation, "isCurrentSession" | "applyConversationSnapshot" | "requestConversationSnapshot" |
  "setCurrentSessionTitle" | "refreshCurrentSessionTitle" | "saveCurrentSession" | "transitionToSession">> {
  switchToSession: Navigation["switchToSession"]; sessionState: SessionState;
  runController: ReturnType<typeof createChatRunController>;
  queuedFollowups: ReturnType<typeof createQueuedFollowupsFeature>; goalStrip: ReturnType<typeof createGoalStripFeature>;
  transcriptReconcile: Pick<ReturnType<typeof createTranscriptReconcileFeature>, "handleEvent" | "clear">;
  transcriptRenderer: {
    scheduleRender(id: string, options: { delay: number }): void;
    setTranscript(id: string, transcript: TranscriptEntry[]): void; seedCreated(session: Partial<SessionMetadata>, firstMessage?: string): void;
    markChanged(id: string): void; getTranscript(id: string): TranscriptEntry[];
    armOutgoingEntry?(id: string, clientMessageId: unknown, outgoingBatch: OutgoingBatch | null): void;
    hideAssistantActions(): void; forgetSession(id: string): void;
  };
  onTransportError?(event: PortMessage): void;
  onEvent?(event: PortMessage): void;
  onUiEvent?(event: PortMessage): void;
  runStates: ReturnType<typeof createChatRunController>["states"];
  getCurrentTab?(): string; getCurrentSessionId?(): string | null;
  replaceTranscript?: Navigation["replaceTranscriptFromRuntime"];
  emitStreamTrace?(phase: string, event: RouterEvent, fields: PortMessage): void;
  handleDynamicContextRequest?(event: RouterEvent): unknown;
  send?(message: PortMessage): unknown;
  resetUi?(): void; syncKeepAlive?(): void; ensureAcceptedUserMessageVisible?(): void; forgetComposerSession?(id: string): void;
}

import { getToolDisplayName } from "../../tools/tool-model.js";

const SESSION_SCOPED_EVENT_TYPES = new Set([
  "state",
  "message_start",
  "thinking_update",
  "llm_retry",
  "llm_rate_wait",
  "message_update",
  "message_end",
  "tool_call_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "context_compaction_start",
  "context_compaction_end",
  "context_compaction_failed",
  "turn_start",
  "session_pending",
  "agent_start",
  "agent_end",
  "aborted",
  "error",
  "warning",
  "context_usage",
  "queue_update",
  "tracker_update",
  "goal_update",
  "waiting_for_user",
  "user_wait_resolved",
  "reset",
  "session_restored",
  "messages",
  "transcript_replace",
  "session_resources_changed",
]);

export function createSidepanelEventRouter(options: RouterOptions) {
  if (typeof options.switchToSession !== "function") {
    throw new TypeError("sidepanel event router requires switchToSession");
  }
  const deletedSessionIds = new Set<string>();
  const {
    sessionState,
    runController,
    transcriptRenderer,
    transcriptReconcile,
    queuedFollowups,
    goalStrip,
  } = options;

  function isCurrentSessionEvent(event: Partial<SessionViewEvent>) {
    const sessionId = normalizeSessionId(event?.sessionId);
    if (!sessionId) return true;
    return options.isCurrentSession?.(sessionId) === true;
  }

  function isDeletedSession(sessionId: unknown) {
    return deletedSessionIds.has(normalizeSessionId(sessionId));
  }

  function routeBackgroundSessionEvent(event: RouterEvent) {
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId || options.isCurrentSession?.(sessionId)) return false;

    if (event.type === "messages") {
      options.applyConversationSnapshot?.({
        conversation: event.session ?? event.messages,
        sessionId,
        transcript: event.transcript,
        persist: event.save !== false,
      });
      return true;
    }
    if (event.type === "transcript_replace") {
      options.replaceTranscript?.(sessionId, event.transcript);
      return true;
    }
    if (event.type === "session_resources_changed") {
      return true;
    }
    if (event.type === "agent_end" && !isDeletedSession(sessionId)) {
      options.requestConversationSnapshot?.(sessionId, { persist: true });
      return true;
    }
    return SESSION_SCOPED_EVENT_TYPES.has(event.type);
  }

  function handle(input: unknown) {
    if (!input || typeof input !== "object" || typeof record(input).type !== "string") return;
    const event = input as RouterEvent;
    options.emitStreamTrace?.("ui_receive", event, {
      current: isCurrentSessionEvent(event),
      tab: options.getCurrentTab?.(),
    });
    if (event?.type === "session_reveal_requested") {
      const sessionId = normalizeSessionId(event.sessionId);
      if (sessionId) options.switchToSession(sessionId, { source: "notification" });
      return;
    }
    if (event.type === "request_failed" || event.type === "transport_error") {
      options.onTransportError?.(event);
      return;
    }
    // A deletion is a barrier, not an ordinary projection update. Publish it only
    // after revoking the old view; late run events must not re-create that view.
    if (event.type === "session_deleted") {
      handleSessionDeleted(event);
      options.onEvent?.(event);
      return;
    }
    if (event.type === "session_created" && event.session?.id) reviveSession(event.session.id);
    // Project all sessions first; capabilities observe accepted facts before the
    // active-chat filter, including terminal events from background sessions.
    if (trackBackgroundRun(event) === false) return;
    options.onEvent?.(event);
    if (routeBackgroundSessionEvent(event)) return;
    if (SESSION_SCOPED_EVENT_TYPES.has(event.type) && !isCurrentSessionEvent(event)) return;

    const currentSessionId = normalizeSessionId(options.getCurrentSessionId?.());
    switch (event.type) {
      case "state":
        if (event.hasHistory && runController.hasVisibleConversation()) runController.hideWelcome();
        runController.handleRuntimeContextUsage(event.runtime);
        runController.applySnapshot(event);
        break;
      case "message_start":
        runController.makeLive(event);
        if (record(event.message).role === "user") {
          runController.hideWelcome();
        }
        break;
      case "thinking_update":
        runController.makeLive(event);
        runController.showStatus(t("thinking"));
        break;
      case "llm_retry": {
        runController.makeLive(event);
        const delaySeconds = Number.isInteger(event.maxRetries) && typeof event.delayMs === "number" && Number.isFinite(event.delayMs) && event.delayMs > 0
          ? Math.max(1, Math.ceil(event.delayMs / 1000))
          : 0;
        runController.showStatus(delaySeconds > 0
          ? t("modelRetry", { seconds: delaySeconds })
          : t("retrying"), { immediate: true });
        break;
      }
      case "llm_rate_wait":
        runController.makeLive(event);
        runController.showStatus(t("modelQueued"), { immediate: true });
        break;
      case "message_update":
        runController.makeLive(event);
        runController.showStatus(t("generating"));
        break;
      case "tool_call_update":
        runController.makeLive(event);
        runController.showStatus(event.toolName ? t("preparingTool", { tool: getToolDisplayName(event.toolName) }) : t("preparingArguments"));
        break;
      case "message_end":
        break;
      case "tool_execution_start":
        runController.makeLive(event);
        runController.showStatus(t("callingTool", { tool: getToolDisplayName(event.toolName) }));
        break;
      case "tool_execution_update":
        runController.makeLive(event);
        runController.showStatus(event.statusText || t("callingTool", { tool: getToolDisplayName(event.toolName) }));
        break;
      case "tool_execution_end": {
        const tool = sessionState.getRuntime(event.sessionId).currentTool;
        if (tool) runController.showStatus(tool.statusText || t("callingTool", { tool: getToolDisplayName(tool.name) }));
        break;
      }
      case "turn_start":
        runController.makeLive(event);
        if (!runController.accept(event)) break;
        runController.ensureActive(event.runId, event.sessionId, {
          requireConversation: false,
          startedAt: event.runtime?.startedAt,
        });
        runController.showStatus(t("thinking"));
        break;
      case "session_pending":
      case "agent_start":
        if (!runController.isRestoring() && !runController.areEventsSuppressed() && !runController.isBlocked(event.runId)) {
          runController.start(event.runId, {
            sessionId: event.sessionId || currentSessionId,
            requireConversation: false,
            startedAt: event.runtime?.startedAt,
          });
          runController.showStatus(t("thinking"));
        }
        break;
      case "agent_end":
        if (runController.acceptTerminal(event)) {
          runController.finish();
          options.saveCurrentSession?.();
        } else if (isCurrentSessionEvent(event) && currentSessionId && !isDeletedSession(currentSessionId)) {
          options.saveCurrentSession?.();
        }
        break;
      case "aborted":
      case "error":
        if (runController.acceptTerminal(event)) {
          runController.finish();
        }
        break;
      case "warning":
      case "context_compaction_start":
      case "context_compaction_end":
      case "context_compaction_failed":
        break;
      case "context_usage":
        runController.handleContextUsage(event);
        break;
      case "dynamic_context_request":
        options.handleDynamicContextRequest?.(event);
        break;
      case "waiting_for_user":
        if (!runController.areEventsSuppressed() && !runController.isRestoring() && isCurrentSessionEvent(event)) {
          if (event.runId && !runController.isBlocked(event.runId)) {
            runController.start(event.runId, { sessionId: event.sessionId || currentSessionId, requireConversation: false });
          }
          runController.enterState(options.runStates.WAITING_USER);
          transcriptRenderer.scheduleRender(event.sessionId || currentSessionId, { delay: 0 });
        }
        break;
      case "user_wait_resolved":
        if (runController.getStatus() === options.runStates.WAITING_USER) {
          runController.enterState(options.runStates.RUNNING);
          runController.showStatus(t("thinking"));
        }
        break;
      case "reset":
        if (currentSessionId) transcriptRenderer.setTranscript(currentSessionId, []);
        runController.finish();
        options.resetUi?.();
        runController.setSuppressEvents(false);
        break;
      case "session_restored":
        runController.finishRestore();
        if (currentSessionId) options.send?.({ type: "get_state", sessionId: currentSessionId });
        break;
      case "messages":
        options.applyConversationSnapshot?.({
          conversation: event.session ?? event.messages,
          sessionId: event.sessionId,
          transcript: event.transcript,
          persist: event.save !== false,
        });
        break;
      case "transcript_replace":
        options.replaceTranscript?.(event.sessionId || currentSessionId, event.transcript);
        break;
      case "session_created":
        if (event.session?.id) {
          deletedSessionIds.delete(event.session.id);
          transcriptRenderer.seedCreated(event.session, event.firstMessage);
          if (options.isCurrentSession?.(event.session.id)) {
            options.setCurrentSessionTitle?.(event.session.title || event.firstMessage || "");
          }
        }
        options.onUiEvent?.({ type: "ui_sessions_refresh"});
        break;
      case "sessions_changed":
        if (!event.sessionId || options.isCurrentSession?.(event.sessionId)) {
          options.refreshCurrentSessionTitle?.(event.session);
        }
        options.onUiEvent?.({ type: "ui_sessions_refresh"});
        break;
      case "config":
        runController.requestCurrentState();
        break;
      case "config_saved":
        // Matching requests are consumed by port-client; this can only be a late reply.
        if (event.requestId) break;
        runController.requestCurrentState();
        break;
      default:
        break;
    }
  }

  function trackBackgroundRun(event: RouterEvent) {
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId) return true;
    if (isDeletedSession(sessionId)) return false;
    const previousRuntime = sessionState.getRuntime(sessionId);
    const previousQueueSignature = queuedFollowups.itemsSignature(
      previousRuntime.pendingFollowUps,
      previousRuntime.pendingSteerings,
    );
    const ignoreTranscript = runController.shouldIgnoreBlocked(event);
    const change = sessionState.applyEvent({ ...event, sessionId }, { transcript: !ignoreTranscript });
    if (!change.accepted) return false;
    if (!ignoreTranscript) applyTranscriptUiSideEffects(sessionId, event);
    if (change.transcriptChanged) transcriptRenderer.markChanged(sessionId);
    options.emitStreamTrace?.("ui_transcript_recorded", event, {
      changed: change.runtimeChanged,
      transcriptChanged: change.transcriptChanged,
      transcriptCount: transcriptRenderer.getTranscript(sessionId).length,
    });
    const changed = change.runtimeChanged || change.transcriptChanged || change.recordChanged || change.artifactsChanged;
    if (changed) {
      options.syncKeepAlive?.();
      options.onUiEvent?.({ type: "ui_sessions_refresh", delay: 120 });
      const nextRuntime = sessionState.getRuntime(sessionId);
      const queueChanged = previousQueueSignature !== queuedFollowups.itemsSignature(
        nextRuntime.pendingFollowUps,
        nextRuntime.pendingSteerings,
      );
      if (queueChanged && options.isCurrentSession?.(sessionId)) queuedFollowups.render();
      if (change.runtimeChanged && options.isCurrentSession?.(sessionId)) goalStrip.renderCurrent();
      runController.renderStatusVisibility();
      if (change.transcriptChanged) {
        options.emitStreamTrace?.("ui_render_schedule", event, { delay: 0 });
        transcriptRenderer.scheduleRender(sessionId, { delay: 0 });
      }
    }
    if (changed || event.type === "state") transcriptReconcile.handleEvent(sessionId, event);
    return true;
  }

  function updateRuntime(sessionId: unknown, event: RouterEvent) {
    const id = normalizeSessionId(sessionId);
    if (!id || isDeletedSession(id)) return false;
    const change = sessionState.applyEvent({ ...event, sessionId: id }, {
      transcript: false,
      record: false,
      artifacts: false,
    });
    return change.accepted && change.runtimeChanged;
  }

  function applyTranscriptUiSideEffects(sessionId: string, event: RouterEvent) {
    if (!options.isCurrentSession?.(sessionId)) return;
    if (event.type !== "message_start" || record(event.message).role !== "user") return;
    if (record(event.message)._origin && record(event.message)._origin !== "user") return;
    const clientMessageId = event.clientMessageId || record(event.message).clientMessageId;
    const settled = queuedFollowups.settleAccepted(clientMessageId);
    if (settled) {
      options.ensureAcceptedUserMessageVisible?.();
      transcriptRenderer.armOutgoingEntry?.(sessionId, clientMessageId, settled.outgoingBatch);
    }
    transcriptRenderer.hideAssistantActions();
    options.onUiEvent?.({ type: "ui_chat_submitted", sessionId, clientMessageId });
  }

  function handleSessionDeleted(event: RouterEvent) {
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId) return;
    deletedSessionIds.add(sessionId);
    goalStrip.forget(sessionId);
    sessionState.remove(sessionId);
    runController.forgetSession(sessionId);
    transcriptRenderer.forgetSession(sessionId);
    transcriptReconcile.clear(sessionId);
    options.forgetComposerSession?.(sessionId);
    options.syncKeepAlive?.();
    runController.renderStatusVisibility();

    if (options.isCurrentSession?.(sessionId)) {
      runController.setSuppressEvents(true);
      runController.finish();
      void Promise.resolve(options.transitionToSession?.(null, { reload: true })).then(transitioned => {
        if (transitioned !== false) options.resetUi?.();
      });
    }
    options.onUiEvent?.({ type: "ui_sessions_refresh", immediate: true });
  }

  function reviveSession(sessionId: unknown) {
    deletedSessionIds.delete(normalizeSessionId(sessionId));
  }

  function reset() {
    deletedSessionIds.clear();
  }

  return {
    handle,
    trackBackgroundRun,
    updateRuntime,
    isCurrentSessionEvent,
    isDeletedSession,
    reviveSession,
    reset,
  };
}

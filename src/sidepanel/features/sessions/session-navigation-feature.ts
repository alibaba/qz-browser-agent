import { t } from "../../i18n/index.js";
import { clipText, formatLiveElapsedMs, formatWholeSecondElapsed } from "./session-format.js";
export { clipText, formatLiveElapsedMs, formatWholeSecondElapsed } from "./session-format.js";
import { sessionIdText as normalizeSessionId } from "./session-id.js";
import type { TranscriptEntry } from "../../../shared/contracts/session.js";
import type { SessionMetadata } from "../../../shared/session/session-store.js";
import type { ClientRuntime } from "./session-state.js";
import type { ComposerDraftState, createComposerFeature } from "../chat/composer-feature.js";
import type { createChatRunController } from "../chat/chat-run-controller.js";
import type { createChatScrollFeature } from "../chat/chat-scroll-feature.js";
import type { createChatSearchFeature } from "../chat/chat-search-feature.js";
import type { createGoalStripFeature } from "../chat/goal-strip-feature.js";
import type { createSessionExportFeature } from "../export/session-export-feature.js";
import type { createPerfTrace } from "../dev/perf-trace.js";
import type { PortMessage } from "../app/port-client.js";
import { record as fields } from "../../tools/renderer-input.js";
export interface ConversationSnapshot {
  conversation?: unknown; sessionId?: unknown; transcript?: TranscriptEntry[] | null; persist?: boolean;
}
interface NavigationOptions {
  getSessionSwitchEpoch?(): number; incrementSessionSwitchEpoch?(): number;
  getCurrentSessionId?(): string | null; setCurrentSessionIdValue?(id: string | null): void;
  getCurrentTab?(): string; chatTab?: string; onStableViewChange?(): void;
  composer?: Pick<ReturnType<typeof createComposerFeature>, "handleSessionChanged" | "prepareSession" | "adoptSession" | "snapshotDraft">;
  chatSearch?: Pick<ReturnType<typeof createChatSearchFeature>, "close">;
  sessionExport?: Pick<ReturnType<typeof createSessionExportFeature>, "syncCurrentControl">;
  goalStrip?: Pick<ReturnType<typeof createGoalStripFeature>, "renderCurrent">;
  runController: Pick<ReturnType<typeof createChatRunController>, "syncCurrentRuntimeView" | "setSuppressEvents" | "finish" | "beginRestore">;
  chatScroll: Pick<ReturnType<typeof createChatScrollFeature>, "requestLatest">;
  transcriptRenderer: {
    setTranscript(id: string, entries: TranscriptEntry[]): unknown;
    applyRuntimeSnapshot(id: string, entries: TranscriptEntry[], options?: { preserveLocalState: boolean }): boolean;
    seedFromStorage(id: string, entries: TranscriptEntry[]): boolean; maybeRenderUpdated(id: string, changed: boolean): void;
    clearPartial(id: string): void; render(id: string, options?: { force: boolean }): void;
    renderCurrent(options: { intent: string }): void; hasTranscript(id: string): boolean;
  };
  onUiEvent?(event: PortMessage): void;
  sessionTitleBar?: HTMLElement | null; currentSessionTitle?: HTMLElement | null;
  sessionTitleEditButton?: HTMLButtonElement | null; sessionTitleInput?: HTMLInputElement | null;
  showToast?(message: string, options: { tone: string; anchorEl?: Element | null }): void;
  request(type: string, payload: PortMessage): Promise<PortMessage>; send?(message: PortMessage): unknown;
  isDeletedSession?(id: string): boolean; resetUi?(): void; switchToChatTab?(options?: { refresh: boolean }): unknown;
  startPerfTrace?: ReturnType<typeof createPerfTrace>["start"];
  perfTrace: ReturnType<typeof createPerfTrace>["measure"]; perfTraceAsync: ReturnType<typeof createPerfTrace>["measureAsync"];
  getRuntime?(id: string): ClientRuntime; isRuntimeRunning?(runtime: ClientRuntime | undefined): boolean;
  storage: { local: { get(key: string | string[]): Promise<PortMessage> } };
}

import { isSessionFormatError } from "../../../shared/session/session-format.js";
import {
  createSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  transcriptFromConversation,
} from "../../../shared/session/session-codec.js";
import { readSessionSnapshot } from "../../../shared/session/session-recovery.js";
import {
  ACTIVE_CONVERSATION_PREFIX,
  genSessionId,
  getSessions,
  ROOT_SESSION_ID,
  storedSessionKey,
} from "../../../shared/session/session-store.js";

export function createSessionNavigationFeature(options: NavigationOptions) {
  let pendingSessionRevealId: string | null = null;
  let titleEditSessionId = "";
  let titleEditEpoch = 0;
  let titleSavePending = false;

  installSessionTitleEditor();

  function isLatestSwitch(epoch: number | undefined, sessionId: unknown) {
    return epoch === options.getSessionSwitchEpoch?.() && isCurrentSession(sessionId);
  }

  function beginSessionTransition() {
    return options.incrementSessionSwitchEpoch?.() ?? options.getSessionSwitchEpoch?.();
  }

  function setCurrentSessionId(sessionId: unknown, { composerDraft = null }: { composerDraft?: ComposerDraftState | null } = {}) {
    const previous = normalizeSessionId(options.getCurrentSessionId?.());
    const next = normalizeSessionId(sessionId);
    if (previous !== next) closeSessionTitleEditor();
    options.composer?.handleSessionChanged(previous, next, composerDraft);
    options.setCurrentSessionIdValue?.(next || null);
    if (previous !== next) options.onUiEvent?.({ type: "ui_session_changed", sessionId: next || null });
    if (previous !== next && pendingSessionRevealId !== next) pendingSessionRevealId = null;
    if (previous !== next) options.chatSearch?.close({ restoreFocus: false });
    options.sessionExport?.syncCurrentControl();
    refreshCurrentSessionTitle();
    options.goalStrip?.renderCurrent();
    if (previous !== next && next) requestRuntimeState(next);
    if (previous !== next) options.onStableViewChange?.();
  }

  async function transitionToSession(sessionId: unknown, { reload = false, epoch = null, signal }: { reload?: boolean; epoch?: number | null; signal?: AbortSignal } = {}) {
    if (signal?.aborted) return false;
    const previous = normalizeSessionId(options.getCurrentSessionId?.());
    const next = normalizeSessionId(sessionId);
    if (previous === next && !reload) {
      if (pendingSessionRevealId !== next) beginSessionTransition();
      return true;
    }
    const transitionEpoch = epoch ?? beginSessionTransition();
    const composerDraft = await options.composer?.prepareSession(next);
    if (signal?.aborted || transitionEpoch !== options.getSessionSwitchEpoch?.()) return false;
    setCurrentSessionId(next, { composerDraft });
    return true;
  }

  function isCurrentSession(sessionId: unknown) {
    const current = normalizeSessionId(options.getCurrentSessionId?.());
    const id = normalizeSessionId(sessionId);
    return Boolean(current && id && id === current);
  }

  function setCurrentSessionTitle(title: unknown) {
    const raw = String(title || "").trim();
    const text = raw ? createSessionTitle(raw).trim() : "";
    const sessionTitleBar = options.sessionTitleBar;
    const currentSessionTitle = options.currentSessionTitle;
    if (!sessionTitleBar || !currentSessionTitle) return;
    if (!options.getCurrentSessionId?.() || !text || options.getCurrentTab?.() !== options.chatTab) {
      closeSessionTitleEditor();
      currentSessionTitle.textContent = "";
      currentSessionTitle.removeAttribute("title");
      sessionTitleBar.classList.add("hidden");
      return;
    }
    currentSessionTitle.textContent = text;
    currentSessionTitle.title = text;
    sessionTitleBar.classList.remove("hidden");
  }

  function installSessionTitleEditor() {
    if (options.sessionTitleInput) options.sessionTitleInput.maxLength = SESSION_TITLE_MAX_LENGTH;
    options.sessionTitleEditButton?.addEventListener("click", beginSessionTitleEdit);
    options.sessionTitleInput?.addEventListener("keydown", handleSessionTitleKeydown);
    options.sessionTitleInput?.addEventListener("blur", () => {
      if (titleEditSessionId && !titleSavePending) void commitSessionTitleEdit({ fromBlur: true });
    });
  }

  function beginSessionTitleEdit() {
    const sessionId = normalizeSessionId(options.getCurrentSessionId?.());
    const title = String(options.currentSessionTitle?.textContent || "").trim();
    const input = options.sessionTitleInput;
    if (!sessionId || !title || !input || options.getCurrentTab?.() !== options.chatTab) return;
    titleEditEpoch += 1;
    titleEditSessionId = sessionId;
    titleSavePending = false;
    input.value = title;
    input.disabled = false;
    options.sessionTitleBar?.classList.add("is-editing");
    options.sessionTitleEditButton?.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
  }

  function handleSessionTitleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void commitSessionTitleEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSessionTitleEditor({ restoreFocus: true });
    }
  }

  async function commitSessionTitleEdit({ fromBlur = false } = {}) {
    const sessionId = titleEditSessionId;
    const input = options.sessionTitleInput;
    if (!sessionId || !input || titleSavePending) return;
    const rawTitle = String(input.value || "").replace(/\s+/gu, " ").trim();
    if (!rawTitle) {
      if (fromBlur) {
        closeSessionTitleEditor();
      } else {
        options.showToast?.(t("titleRequired"), { tone: "error", anchorEl: input });
        input.focus();
      }
      return;
    }

    const epoch = titleEditEpoch;
    titleSavePending = true;
    input.disabled = true;
    try {
      const result = await options.request("rename_session", {
        sessionId,
        title: rawTitle,
      });
      if (epoch !== titleEditEpoch) return;
      if (isCurrentSession(sessionId)) {
        setCurrentSessionTitle(fields(result?.session).title || rawTitle);
      }
      closeSessionTitleEditor();
    } catch (error) {
      if (epoch !== titleEditEpoch) return;
      closeSessionTitleEditor();
      options.showToast?.(t("renameFailed", { error: String(fields(error).message || t("tryAgainLater")) }), {
        tone: "error",
        anchorEl: options.sessionTitleEditButton,
      });
    }
  }

  function closeSessionTitleEditor({ restoreFocus = false } = {}) {
    const wasEditing = Boolean(titleEditSessionId);
    titleEditEpoch += 1;
    titleEditSessionId = "";
    titleSavePending = false;
    options.sessionTitleInput?.removeAttribute("disabled");
    if (options.sessionTitleInput) options.sessionTitleInput.value = "";
    options.sessionTitleBar?.classList.remove("is-editing");
    options.sessionTitleEditButton?.setAttribute("aria-expanded", "false");
    if (restoreFocus && wasEditing) options.sessionTitleEditButton?.focus();
  }

  async function refreshCurrentSessionTitle(sessionSnapshot: Partial<SessionMetadata> | null = null) {
    const id = normalizeSessionId(options.getCurrentSessionId?.());
    if (!id || options.getCurrentTab?.() !== options.chatTab) {
      setCurrentSessionTitle("");
      return;
    }
    if (sessionSnapshot && normalizeSessionId(sessionSnapshot.id) === id) {
      setCurrentSessionTitle(sessionSnapshot.title || "");
      return;
    }
    const sessions = await getSessions();
    if (!isCurrentSession(id) || options.getCurrentTab?.() !== options.chatTab) return;
    setCurrentSessionTitle(sessions[id]?.title || "");
  }

  async function hasStoredSession(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    const sessions = await getSessions();
    return Boolean(sessions[id]);
  }

  async function createSession(firstMessage: string, draft?: ComposerDraftState) {
    const sessionId = genSessionId();
    const composerDraft = draft ? options.composer?.adoptSession(sessionId, draft) : null;
    options.setCurrentSessionIdValue?.(sessionId);
    options.onStableViewChange?.();
    let result;
    try {
      result = await options.request?.("create_ui_session", {
        id: sessionId,
        title: firstMessage || t("newSession"),
        firstMessage,
        parentSessionId: ROOT_SESSION_ID,
        composerDraft: composerDraft ? options.composer?.snapshotDraft?.(composerDraft) : null,
      });
    } catch (error) {
      if (isCurrentSession(sessionId)) {
        if (composerDraft) options.composer?.adoptSession(null, composerDraft);
        options.setCurrentSessionIdValue?.(null);
        options.onStableViewChange?.();
      }
      throw error;
    }
    const rawSession = fields(result?.session);
    const session = { id: normalizeSessionId(rawSession.id), title: String(rawSession.title || "") };
    if (!session?.id) throw new Error("create_ui_session returned no session");
    if (composerDraft && session.id !== sessionId) options.composer?.adoptSession(session.id, composerDraft);
    if (!isCurrentSession(sessionId) && !isCurrentSession(session.id)) return;
    // The draft was adopted before the request. Re-activating it here can revive
    // a draft that was submitted while Session creation was in flight.
    setCurrentSessionId(session.id);
    setCurrentSessionTitle(session.title || firstMessage || "");
    options.transcriptRenderer.setTranscript(session.id, []);
    options.onUiEvent?.({ type: "ui_sessions_refresh", immediate: true });
  }

  function saveCurrentSession() {
    const sessionId = normalizeSessionId(options.getCurrentSessionId?.());
    if (sessionId) requestConversationSnapshot(sessionId, { persist: true });
  }

  function requestConversationSnapshot(sessionId: unknown, { persist = false } = {}) {
    const id = normalizeSessionId(sessionId);
    if (id) options.send?.({ type: "get_messages", sessionId: id, save: persist !== false });
  }

  function applyConversationSnapshot({
    conversation,
    sessionId = options.getCurrentSessionId?.(),
    transcript: transcriptSnapshot = null,
    persist = false,
  }: ConversationSnapshot = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id || options.isDeletedSession?.(id)) return;
    const hasRuntimeSnapshot = Array.isArray(transcriptSnapshot);
    const transcript = hasRuntimeSnapshot ? transcriptSnapshot : transcriptFromConversation(conversation);
    const changed = hasRuntimeSnapshot
      ? options.transcriptRenderer.applyRuntimeSnapshot(id, transcript)
      : options.transcriptRenderer.seedFromStorage(id, transcript);
    options.transcriptRenderer.maybeRenderUpdated(id, changed);
    if (persist) {
      options.send?.({ type: "save_session_record", sessionId: id, session: conversation });
    }
    options.onUiEvent?.({ type: "ui_sessions_refresh" });
  }

  function replaceTranscriptFromRuntime(sessionId: unknown, transcriptSnapshot: TranscriptEntry[] = []) {
    const id = normalizeSessionId(sessionId);
    if (!id || !Array.isArray(transcriptSnapshot)) return;
    const changed = options.transcriptRenderer.applyRuntimeSnapshot(id, transcriptSnapshot, {
      preserveLocalState: false,
    });
    options.onUiEvent?.({ type: "ui_transcript_replaced", sessionId: id });
    if (changed && isCurrentSession(id)) {
      options.transcriptRenderer.clearPartial(id);
      options.transcriptRenderer.render(id, { force: true });
    }
    options.onUiEvent?.({ type: "ui_sessions_refresh" });
  }

  function requestRuntimeState(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (id) options.send?.({ type: "get_state", sessionId: id });
  }

  function revealSessionChat(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id || !isCurrentSession(id)) return false;
    options.resetUi?.();
    options.chatScroll.requestLatest(id);
    const wasChatTab = options.getCurrentTab?.() === options.chatTab;
    options.perfTrace?.("session.switch.switchTab", { sessionId: id, wasChatTab }, () => {
      options.switchToChatTab?.({ refresh: false });
    });
    refreshCurrentSessionTitle();
    options.perfTrace?.("session.switch.transcriptRenderer.renderCurrent", { sessionId: id }, () => {
      options.transcriptRenderer.renderCurrent({ intent: "opening" });
    });
    return true;
  }

  async function switchToSession(id: unknown, { source = "user", signal }: { source?: string; signal?: AbortSignal } = {}) {
    if (signal?.aborted) return;
    const targetId = normalizeSessionId(id);
    if (!targetId) return;
    const wasCurrentSession = isCurrentSession(targetId);
    if (wasCurrentSession) requestRuntimeState(targetId);
    const switchEpoch = wasCurrentSession && pendingSessionRevealId === targetId
      ? options.getSessionSwitchEpoch?.()
      : beginSessionTransition();
    const endSwitchTrace = options.startPerfTrace?.("session.switchToSession", {
      sessionId: targetId,
      source,
      sameSession: wasCurrentSession,
    });
    let switchTraceError = "";

    try {
      if (wasCurrentSession) {
        if (pendingSessionRevealId === targetId) return;
        options.chatScroll.requestLatest(targetId);
        const wasChatTab = options.getCurrentTab?.() === options.chatTab;
        options.perfTrace?.("session.switch.same.switchTab", { sessionId: targetId }, () => {
          options.switchToChatTab?.();
        });
        if (wasChatTab) {
          options.perfTrace?.("session.switch.same.render", { sessionId: targetId }, () => {
            options.transcriptRenderer.render(targetId);
          });
        }
        options.runController.syncCurrentRuntimeView();
        if (options.isRuntimeRunning?.(options.getRuntime?.(targetId))) {
          requestConversationSnapshot(targetId, { persist: false });
        }
        return;
      }

      options.runController.setSuppressEvents(false);
      if (!await transitionToSession(targetId, { epoch: switchEpoch, signal })) return;
      const targetRuntime = options.getRuntime?.(targetId);
      const wasObservingRunningSession = options.isRuntimeRunning?.(targetRuntime);
      const hasCachedTranscript = options.transcriptRenderer.hasTranscript(targetId);
      if (wasObservingRunningSession) options.runController.syncCurrentRuntimeView();
      else options.runController.finish({ render: false });
      pendingSessionRevealId = hasCachedTranscript ? null : targetId;
      if (hasCachedTranscript) revealSessionChat(targetId);
      if (source !== "restore") {
        options.send?.({ type: "activate_session_working_tab", sessionId: targetId });
      }
      if (wasObservingRunningSession) {
        requestConversationSnapshot(targetId, { persist: false });
      }

      const key = storedSessionKey(targetId);
      const activeKey = `${ACTIVE_CONVERSATION_PREFIX}${targetId}`;
      const savedRecord = await options.perfTraceAsync?.("session.switch.storageRecord", { sessionId: targetId }, () => {
        return options.storage.local.get([key, activeKey]);
      });
      if (signal?.aborted || !isLatestSwitch(switchEpoch, targetId)) return;
      const saved = savedRecord?.[key];
      let record;
      const endReadRecord = options.startPerfTrace?.("session.switch.readRecord", {
        sessionId: targetId,
        hasRecord: Boolean(saved),
      });
      try {
        record = readSessionSnapshot(saved, savedRecord?.[activeKey]);
      } finally {
        endReadRecord?.({
          hasConversation: Boolean(record?.conversation),
          transcript: record?.transcript?.length || 0,
        });
      }
      const { conversation, transcript } = record;
      options.perfTrace?.("session.switch.hydrateTranscript", {
        sessionId: targetId,
        transcript: transcript.length,
      }, () => {
        const changed = options.transcriptRenderer.seedFromStorage(targetId, transcript);
        if (hasCachedTranscript) options.transcriptRenderer.maybeRenderUpdated(targetId, changed);
      });
      if (!hasCachedTranscript) {
        if (pendingSessionRevealId === targetId) pendingSessionRevealId = null;
        revealSessionChat(targetId);
      }

      const isObservingRunningSession = options.isRuntimeRunning?.(options.getRuntime?.(targetId));
      if (isObservingRunningSession) {
        options.runController.syncCurrentRuntimeView();
        if (!wasObservingRunningSession) {
          requestConversationSnapshot(targetId, { persist: false });
        }
      } else {
        options.runController.finish({ render: false });
        if (conversation) {
          options.runController.beginRestore();
          options.send?.({ type: "restore_session", sessionId: targetId, session: conversation });
        }
      }
    } catch (error) {
      if (signal?.aborted || !isLatestSwitch(switchEpoch, targetId)) return;
      switchTraceError = String(fields(error).message || error);
      if (isSessionFormatError(error)) {
        options.transcriptRenderer.setTranscript?.(targetId, [{ type: "error", text: switchTraceError }]);
        if (pendingSessionRevealId === targetId) pendingSessionRevealId = null;
        revealSessionChat(targetId);
        options.runController.finish({ render: false });
        return false;
      }
      if (pendingSessionRevealId === targetId) {
        pendingSessionRevealId = null;
        revealSessionChat(targetId);
      }
      throw error;
    } finally {
      if (signal?.aborted && isLatestSwitch(switchEpoch, targetId) && pendingSessionRevealId === targetId) pendingSessionRevealId = null;
      endSwitchTrace?.({ error: switchTraceError || undefined });
    }
  }

  return {
    setCurrentSessionId,
    transitionToSession,
    isCurrentSession,
    setCurrentSessionTitle,
    refreshCurrentSessionTitle,
    hasStoredSession,
    createSession,
    saveCurrentSession,
    requestConversationSnapshot,
    applyConversationSnapshot,
    replaceTranscriptFromRuntime,
    switchToSession,
  };
}


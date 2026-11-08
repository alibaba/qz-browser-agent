import { t } from "../../i18n/index.js";
import { formatContextUsageText, formatTokenCount } from "../../ui/ui-utils.js";
import { optionalSessionId as normalizeSessionId } from "../sessions/session-id.js";
import type { ClientRuntime, SessionViewEvent } from "../sessions/session-state.js";
import type { TranscriptEntry } from "../../../shared/contracts/session.js";
import type { PortMessage } from "../app/port-client.js";

type RunState = (typeof CHAT_RUN_STATES)[keyof typeof CHAT_RUN_STATES];
type RuntimeView = Partial<ClientRuntime>;
type RunEvent = Partial<SessionViewEvent>;
interface StartOptions { sessionId?: string | null; requireConversation?: boolean; startedAt?: unknown }
interface RunOptions {
  messagesEl: HTMLElement; statusBar: HTMLElement; statusText: HTMLElement;
  contextUsageEl?: HTMLElement | null; chatDock?: HTMLElement | null; abortButton?: HTMLElement | null;
  transcript: {
    getCurrentTranscript(): TranscriptEntry[]; syncWaiting(id: string): boolean;
    scheduleRender(id: string | null, options: { delay: number }): void;
    render(id: string | null, options: { force: boolean }): void;
    hideAssistantActions(): void;
  };
  onUiEvent?(event: PortMessage): void;
  scroll: {
    settleAfterDockLayout(): void; updateSafeArea(): void; shouldFollowTail(): boolean; isLocked(): boolean;
    scrollToBottom(options: { immediate: boolean; settle: boolean; instant: boolean; force: boolean }): void;
  };
  queue: { render(): void };
  getSessionId?(): string | null; isCurrentSession?(id: string): boolean; isCurrentSessionEvent?(event: RunEvent): boolean;
  isChatActive?(): boolean; getRuntime?(id: string): RuntimeView; isRuntimeRunning?(runtime: RuntimeView): boolean;
  trackBackgroundRun?(event: SessionViewEvent): boolean;
  scheduleTranscriptReconcile?(id: string, options: { delay: number; force: boolean }): void;
  onTerminal?(id: string | null): void;
  send?(message: PortMessage): unknown; request?(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
  syncKeepAlive?(): void; nowTimestamp?(): string; formatLiveElapsedMs?(ms: number): string; liveElapsedTickMs?: number;
}

import {
  isTerminalSessionRuntimeStatus,
  normalizeSessionRuntimeStatus,
} from "../../../shared/session/session-runtime-status.js";
import { parseBeijingDateTime } from "../../../shared/time-utils.js";

export const CHAT_RUN_STATES = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  WAITING_USER: "waiting_user",
});

const STATUS_PHASE_SETTLE_MS = 250;

export function createChatRunController(options: RunOptions) {
  const messagesEl = options.messagesEl;
  const statusBar = options.statusBar;
  const statusText = options.statusText;
  const contextUsageEl = options.contextUsageEl || null;
  const chatDock = options.chatDock || null;
  const abortButton = options.abortButton || null;
  const transcript = options.transcript;
  const onUiEvent = options.onUiEvent || (() => {});
  const scroll = options.scroll;
  const queue = options.queue;
  const getSessionId = options.getSessionId || (() => null);
  const isCurrentSession = options.isCurrentSession || (() => false);
  const isCurrentSessionEvent = options.isCurrentSessionEvent || (() => false);
  const isChatActive = options.isChatActive || (() => false);
  const getRuntime: NonNullable<RunOptions["getRuntime"]> = options.getRuntime || (() => ({}));
  const isRuntimeRunning = options.isRuntimeRunning || (() => false);
  const trackBackgroundRun = options.trackBackgroundRun || (() => false);
  const scheduleTranscriptReconcile = options.scheduleTranscriptReconcile || (() => {});
  const onTerminal = options.onTerminal || (() => {});
  const send = options.send || (() => {});
  const request: NonNullable<RunOptions["request"]> = options.request || (async () => ({}));
  const syncKeepAlive = options.syncKeepAlive || (() => {});
  const nowTimestamp = options.nowTimestamp || (() => new Date().toISOString());
  const formatLiveElapsedMs = options.formatLiveElapsedMs || (value => String(value || 0));
  const liveElapsedTickMs = Math.max(50, Number(options.liveElapsedTickMs) || 100);
  if (!messagesEl || !transcript || !scroll || !queue) {
    throw new Error("chat run controller dependencies are required");
  }

  let runStatus: RunState = CHAT_RUN_STATES.IDLE;
  let activeRunId: string | null = null;
  let activeRunSessionId: string | null = null;
  const blockedRunIds = new Set<string>();
  const transcriptLiveRunIdBySessionId = new Map<string, string>();
  let suppressRunEvents = false;
  let isRestoringSession = false;
  let restoreSessionTimer: ReturnType<typeof setTimeout> | null = null;
  let isStreaming = false;
  let _turnStartTime = 0;
  let _statusTimer: ReturnType<typeof setInterval> | null = null;
  let _statusPhase = t("thinking");
  let _pendingStatusPhase: { phase: string; since: number; sessionId: string | null; runId: string | null } | null = null;
  let _lastStatePollAt = 0;

function makeLiveRunActive(event: RunEvent) {
  if (!event?.runId) return;
  if (!isCurrentSessionEvent(event)) return;
  if (suppressRunEvents || isRestoringSession || blockedRunIds.has(event.runId)) return;
  if (activeRunId !== event.runId || activeRunSessionId !== getSessionId() || runStatus === CHAT_RUN_STATES.IDLE) {
    startRun(event.runId, {
      sessionId: event.sessionId || getSessionId(),
      requireConversation: false,
    });
  }
}

function observeCurrentSessionRuntime() {
  const sessionId = normalizeSessionId(getSessionId());
  if (!sessionId) {
    finishRun();
    return false;
  }
  const runtime = getRuntime(sessionId);
  if (!isRuntimeRunning(runtime)) {
    finishRun();
    return false;
  }
  const runId = runtime.runId || activeRunId || `pending:${sessionId}`;
  startRun(runId, { sessionId, requireConversation: false, startedAt: runtime.startedAt });
  if (runtime.status === "waiting_user") {
    enterRunState(CHAT_RUN_STATES.WAITING_USER);
    if (transcript.syncWaiting(sessionId)) {
      transcript.scheduleRender(sessionId, { delay: 0 });
    }
  }
  return true;
}

function syncCurrentSessionRuntimeView() {
  if (!observeCurrentSessionRuntime()) renderStatusVisibility();
}

function applyRunSnapshot(snapshot: RunEvent) {
  const snapshotSessionId = normalizeSessionId(snapshot.sessionId);
  if (snapshotSessionId && snapshotSessionId !== getSessionId()) return;
  if (snapshot.runId && blockedRunIds.has(snapshot.runId)) {
    const terminalSessionId = snapshotSessionId || getSessionId();
    finishRun();
    if (isRunTerminalEvent(snapshot)) {
      onTerminal(terminalSessionId);
    }
    return;
  }
  if (!snapshot.isStreaming) {
    const terminalSessionId = snapshotSessionId || getSessionId();
    if (!snapshot.runId || snapshot.runId === activeRunId) finishRun();
    onTerminal(terminalSessionId);
    return;
  }
  if (isRestoringSession) {
    finishRun();
    return;
  }
  if (suppressRunEvents) {
    finishRun();
    return;
  }
  if (snapshot.runId) {
    startRun(snapshot.runId, {
      sessionId: snapshotSessionId || getSessionId(),
      requireConversation: false,
      startedAt: snapshot.runtime?.startedAt,
    });
    renderStatusVisibility();
    return;
  }
  finishRun();
}

function startRun(runId: string | null | undefined, { sessionId = getSessionId(), requireConversation = true, startedAt = "" }: StartOptions = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || id !== getSessionId()) return;
  if (requireConversation && !hasVisibleConversation()) return;
  const previousRunId = activeRunId;
  const previousSessionId = activeRunSessionId;
  const nextRunId = runId || activeRunId || `local_${Date.now()}`;
  const sameRun = previousRunId === nextRunId && previousSessionId === id;
  if (!sameRun) {
    _pendingStatusPhase = null;
    _statusPhase = t("thinking");
  }
  activeRunId = nextRunId;
  activeRunSessionId = id;
  transcriptLiveRunIdBySessionId.set(id, nextRunId);
  _turnStartTime = resolveRunStartTime(id, nextRunId, { startedAt, sameRun });
  _lastStatePollAt = sameRun ? _lastStatePollAt : 0;
  enterRunState(CHAT_RUN_STATES.RUNNING);
}

function ensureRunActive(runId: string | null | undefined, sessionId = getSessionId(), options: StartOptions = {}) {
  if (runStatus === CHAT_RUN_STATES.IDLE) startRun(runId, { sessionId, ...options });
}

function finishRun(options: { render?: boolean } = {}) {
  if (activeRunSessionId) transcriptLiveRunIdBySessionId.delete(activeRunSessionId);
  activeRunId = null;
  activeRunSessionId = null;
  enterRunState(CHAT_RUN_STATES.IDLE, options);
}

function acceptRunEvent(event: RunEvent) {
  const eventSessionId = normalizeSessionId(event.sessionId);
  if (eventSessionId && eventSessionId !== getSessionId()) return false;
  if (activeRunSessionId && activeRunSessionId !== getSessionId()) return false;
  const isActiveEvent = event.runId && event.runId === activeRunId;
  if (!hasVisibleConversation() && !isActiveEvent) return false;
  if (event.runId && blockedRunIds.has(event.runId)) return false;
  if (suppressRunEvents) return false;
  if (isRestoringSession) return false;
  if (event.runId) return event.runId === activeRunId;
  return runStatus !== CHAT_RUN_STATES.IDLE;
}

function acceptTerminalRunEvent(event: RunEvent) {
  const eventSessionId = normalizeSessionId(event.sessionId);
  if (eventSessionId && eventSessionId !== getSessionId()) return false;
  if (isBlockedRunTerminalEvent(event)) return true;
  if (isRestoringSession) return false;
  return activeRunSessionId === getSessionId()
    && (runStatus !== CHAT_RUN_STATES.IDLE || (event.runId && event.runId === activeRunId));
}

function shouldIgnoreBlockedRunEvent(event: RunEvent) {
  return Boolean(event?.runId && blockedRunIds.has(event.runId) && !isRunTerminalEvent(event));
}

function isBlockedRunTerminalEvent(event: RunEvent) {
  return Boolean(event?.runId && blockedRunIds.has(event.runId) && isRunTerminalEvent(event));
}

function isRunTerminalEvent(event: RunEvent) {
  if (!event?.type) return false;
  if (["agent_end", "aborted", "error"].includes(event.type)) return true;
  if (event.type !== "state") return false;
  const status = normalizeSessionRuntimeStatus(event.status || event.runtime?.status);
  return isTerminalSessionRuntimeStatus(status);
}

function hasVisibleConversation() {
  return transcript.getCurrentTranscript().some(entry => ["user", "assistant", "tool", "thinking", "run-status"].includes(entry.type));
}

function stopCurrentRun() {
  const sessionId = normalizeSessionId(getSessionId());
  if (!canStopCurrentRun(sessionId)) return false;
  markCurrentSessionAbortRequested(sessionId);
  if (sessionId) {
    requestStopSessionRuntimeState(sessionId).catch((err) => {
      console.warn("[轻舟] stop session request failed:", err?.message || err);
      scheduleTranscriptReconcile(sessionId, { delay: 250, force: true });
    });
  }
  finishRun();
  return true;
}

function canStopCurrentRun(sessionId = getSessionId()) {
  const id = normalizeSessionId(sessionId);
  if (!id) return false;
  const runtime = getRuntime(id);
  if (isRuntimeRunning(runtime)) return true;
  if (id !== getSessionId()) return false;
  if (activeRunSessionId && activeRunSessionId !== id) return false;
  return Boolean(isStreaming && runStatus !== CHAT_RUN_STATES.IDLE);
}

function markCurrentSessionAbortRequested(sessionId = getSessionId()) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  const previous = getRuntime(id);
  const runId = activeRunId || previous.runId || "";
  if (runId) blockedRunIds.add(runId);
  const timestamp = nowTimestamp();
  const runtime = {
    ...previous,
    status: "aborted",
    running: false,
    runId,
    waitId: "",
    waitMessage: "",
    waitTitle: "",
    waitForm: null,
    currentToolName: "",
    currentToolStartedAt: "",
    tracker: null,
    endedAt: timestamp,
    updatedAt: timestamp,
  };
  trackBackgroundRun({
    type: "state",
    sessionId: id,
    isStreaming: false,
    runId,
    status: "aborted",
    runtime,
    hasHistory: true,
  });
}

async function requestStopSessionRuntimeState(sessionId: string) {
  const event = await request("stop_session", { sessionId, source: "ui" }, 8000);
  applyStopSessionRuntimeStateResponse(event, sessionId);
}

function applyStopSessionRuntimeStateResponse(event: RunEvent, fallbackSessionId = "") {
  const sessionId = normalizeSessionId(event?.sessionId || fallbackSessionId);
  if (!sessionId) return;
  const runtime = event?.runtime || getRuntime(sessionId);
  const status = String(event?.status || runtime?.status || "").trim() || "aborted";
  const stateEvent = {
    ...event,
    type: "state",
    sessionId,
    isStreaming: typeof event?.isStreaming === "boolean" ? event.isStreaming : Boolean(runtime?.running),
    runId: String(event?.runId || runtime?.runId || ""),
    status,
    runtime,
  };
  trackBackgroundRun(stateEvent);
  if (isCurrentSession(sessionId)) {
    applyRunSnapshot(stateEvent);
  }
}

function beginSessionRestore() {
  isRestoringSession = true;
  if (restoreSessionTimer) clearTimeout(restoreSessionTimer);
  restoreSessionTimer = setTimeout(finishSessionRestore, 5000);
  finishRun({ render: false });
}

function finishSessionRestore() {
  isRestoringSession = false;
  if (restoreSessionTimer) clearTimeout(restoreSessionTimer);
  restoreSessionTimer = null;
  finishRun({ render: false });
}

function enterRunState(state: RunState, options: { render?: boolean } = {}) {
  if (!Object.values(CHAT_RUN_STATES).includes(state)) return;
  const renderOnIdle = options.render !== false;
  runStatus = state;
  isStreaming = state !== CHAT_RUN_STATES.IDLE;

  if (state !== CHAT_RUN_STATES.IDLE || renderOnIdle) {
    syncAssistantActionsForRunState(state);
  }

  if (state === CHAT_RUN_STATES.IDLE) {
    onUiEvent({ type: "ui_notice_hide" });
    hideStatus();
    _turnStartTime = 0;
    _lastStatePollAt = 0;
    if (renderOnIdle && getSessionId()) transcript.scheduleRender(getSessionId(), { delay: 0 });
    syncKeepAlive();
  } else if (state === CHAT_RUN_STATES.WAITING_USER) {
    onUiEvent({ type: "ui_notice_hide" });
    hideStatus();
    syncKeepAlive();
  } else {
    onUiEvent({ type: "ui_chat_dock" });
    renderStatusVisibility();
    syncKeepAlive();
  }
}

function syncAssistantActionsForRunState(state: RunState) {
  if (state !== CHAT_RUN_STATES.IDLE) {
    transcript.hideAssistantActions();
    if (getSessionId()) transcript.scheduleRender(getSessionId(), { delay: 0 });
    return;
  }
  if (getSessionId() && isChatActive()) {
    transcript.render(getSessionId(), { force: true });
  }
}

function shouldShowStatusBar() {
  return isChatActive()
    && runStatus === CHAT_RUN_STATES.RUNNING
    && activeRunSessionId === getSessionId();
}

function renderStatusVisibility() {
  if (!statusBar) return;
  const wasHidden = statusBar.classList.contains("hidden");
  if (shouldShowStatusBar()) {
    statusBar.classList.remove("hidden");
    chatDock?.classList.add("has-status");
    startStatusTimer();
    updateStatusText();
    if (wasHidden) scroll.settleAfterDockLayout();
  } else {
    statusBar.classList.add("hidden");
    chatDock?.classList.remove("has-status");
    stopStatusTimer();
    _pendingStatusPhase = null;
    if (!wasHidden) scroll.settleAfterDockLayout();
  }
  scroll.updateSafeArea();
}

function renderChatDockState() {
  queue.render();
  renderStatusVisibility();
}

function setWelcomeVisible(visible: boolean) {
  const el = messagesEl.querySelector<HTMLElement>("#welcome");
  if (el) el.style.display = visible ? "" : "none";
  messagesEl.dataset.chatState = visible && el ? "landing" : "conversation";
  return Boolean(el);
}

function hideWelcome() {
  return setWelcomeVisible(false);
}

function showWelcome() {
  return setWelcomeVisible(true);
}

function showStatus(text: unknown, { immediate = false } = {}) {
  if (!shouldShowStatusBar()) return;
  const phase = normalizeStatusPhase(text);
  if (immediate || phase === _statusPhase) {
    _pendingStatusPhase = null;
    _statusPhase = phase;
  } else if (_pendingStatusPhase?.phase !== phase) {
    _pendingStatusPhase = {
      phase,
      since: Date.now(),
      sessionId: activeRunSessionId,
      runId: activeRunId,
    };
  }
  if (!_turnStartTime) _turnStartTime = resolveRunStartTime(activeRunSessionId, activeRunId, { sameRun: true });
  renderStatusVisibility();
}

function hideStatus() {
  const wasHidden = statusBar.classList.contains("hidden");
  statusBar.classList.add("hidden");
  chatDock?.classList.remove("has-status");
  stopStatusTimer();
  _pendingStatusPhase = null;
  _statusPhase = t("thinking");
  scroll.updateSafeArea();
  if (!wasHidden && scroll.shouldFollowTail()) {
    scroll.scrollToBottom({ immediate: true, settle: true, instant: true, force: scroll.isLocked() });
  }
}

function normalizeStatusPhase(text: unknown) {
  return String(text || t("thinking"))
    .replace(/\s+(?:(?:\d+h\s+)?(?:\d+m\s+)?\d{1,2}(?:\.\d)?s|\d+(?:\.\d)?s)$/u, "")
    .trim() || t("thinking");
}

function startStatusTimer() {
  if (_statusTimer) return;
  _statusTimer = setInterval(tickStatus, liveElapsedTickMs);
}

function stopStatusTimer() {
  if (_statusTimer) clearInterval(_statusTimer);
  _statusTimer = null;
}

function resolveRunStartTime(sessionId: string | null, runId: string | null, { startedAt = "", sameRun = false }: { startedAt?: unknown; sameRun?: boolean } = {}) {
  return getRuntimeRunStartTime(sessionId, runId, startedAt)
    || (sameRun ? _turnStartTime : 0)
    || Date.now();
}

function getRuntimeRunStartTime(sessionId: string | null, runId: string | null, explicitStartedAt: unknown = "") {
  const explicitStart = parseRuntimeTimestamp(explicitStartedAt);
  if (explicitStart) return explicitStart;

  const id = normalizeSessionId(sessionId);
  if (!id) return 0;
  const runtime = getRuntime(id);
  if (runtime?.runId && runId && runtime.runId !== runId) return 0;
  return parseRuntimeTimestamp(runtime?.startedAt);
}

function parseRuntimeTimestamp(value: unknown = "") {
  const parsed = parseBeijingDateTime(value);
  return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function tickStatus() {
  if (!shouldShowStatusBar()) {
    hideStatus();
    return;
  }
  updateStatusText();

  const now = Date.now();
  if (activeRunSessionId && activeRunSessionId === getSessionId() && now - _lastStatePollAt >= 5000) {
    _lastStatePollAt = now;
    send({ type: "get_state", sessionId: activeRunSessionId });
  }
}

function updateStatusText() {
  if (_pendingStatusPhase
    && _pendingStatusPhase.sessionId === activeRunSessionId
    && _pendingStatusPhase.runId === activeRunId
    && Date.now() - _pendingStatusPhase.since >= STATUS_PHASE_SETTLE_MS) {
    _statusPhase = _pendingStatusPhase.phase;
    _pendingStatusPhase = null;
  }
  const runtimeStartTime = getRuntimeRunStartTime(activeRunSessionId, activeRunId);
  if (runtimeStartTime) _turnStartTime = runtimeStartTime;
  const elapsed = formatLiveElapsedMs(Date.now() - (_turnStartTime || Date.now()));
  statusText.textContent = `${_statusPhase} ${elapsed}`;
}

function handleContextUsage(event: PortMessage) {
  if (!contextUsageEl) return;
  contextUsageEl.textContent = shouldShowContextUsage() ? formatContextUsageText(event.inputTokensEstimate, event.contextWindow) : "";
}

function handleRuntimeContextUsage(runtime: Record<string, unknown> | null = {}) {
  if (!contextUsageEl) return;
  contextUsageEl.textContent = shouldShowContextUsage() ? formatContextUsageText(runtime?.inputTokensEstimate, runtime?.contextWindow) : "";
}

function shouldShowContextUsage() {
  let userMessages = 0;
  for (const entry of transcript.getCurrentTranscript()) {
    if (entry?.type === "user" && ++userMessages > 1) return true;
  }
  return false;
}


function requestCurrentSessionState() {
  const sessionId = normalizeSessionId(getSessionId());
  if (!sessionId) return;
  send({ type: "get_state", sessionId });
}


  function setSuppressEvents(value: unknown) {
    suppressRunEvents = Boolean(value);
  }

  function forgetSession(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    transcriptLiveRunIdBySessionId.delete(id);
    if (activeRunSessionId === id) finishRun({ render: false });
  }

  function resetState({ render = false } = {}) {
    if (restoreSessionTimer) clearTimeout(restoreSessionTimer);
    restoreSessionTimer = null;
    isRestoringSession = false;
    suppressRunEvents = false;
    blockedRunIds.clear();
    transcriptLiveRunIdBySessionId.clear();
    finishRun({ render });
  }

  abortButton?.addEventListener("click", stopCurrentRun);

  return {
    states: CHAT_RUN_STATES,
    getStatus: () => runStatus,
    getActiveRunId: () => activeRunId,
    getActiveSessionId: () => activeRunSessionId,
    isStreaming: () => isStreaming,
    isRestoring: () => isRestoringSession,
    areEventsSuppressed: () => suppressRunEvents,
    isBlocked: (runId: string | null | undefined) => Boolean(runId && blockedRunIds.has(runId)),
    clearBlocked: () => blockedRunIds.clear(),
    setSuppressEvents,
    forgetSession,
    resetState,
    makeLive: makeLiveRunActive,
    observeCurrentRuntime: observeCurrentSessionRuntime,
    syncCurrentRuntimeView: syncCurrentSessionRuntimeView,
    applySnapshot: applyRunSnapshot,
    start: startRun,
    ensureActive: ensureRunActive,
    finish: finishRun,
    accept: acceptRunEvent,
    acceptTerminal: acceptTerminalRunEvent,
    shouldIgnoreBlocked: shouldIgnoreBlockedRunEvent,
    isBlockedTerminal: isBlockedRunTerminalEvent,
    isTerminalEvent: isRunTerminalEvent,
    hasVisibleConversation,
    stop: stopCurrentRun,
    canStop: canStopCurrentRun,
    markAbortRequested: markCurrentSessionAbortRequested,
    requestStop: requestStopSessionRuntimeState,
    applyStopResponse: applyStopSessionRuntimeStateResponse,
    beginRestore: beginSessionRestore,
    finishRestore: finishSessionRestore,
    enterState: enterRunState,
    renderStatusVisibility,
    renderDock: renderChatDockState,
    hideWelcome,
    showWelcome,
    showStatus,
    hideStatus,
    handleContextUsage,
    handleRuntimeContextUsage,
    formatContextUsageText,
    requestCurrentState: requestCurrentSessionState,
    formatTokenCount,
  };
}

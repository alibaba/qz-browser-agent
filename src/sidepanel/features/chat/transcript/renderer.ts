import { t, tHtml } from "../../../i18n/index.js";
import { formatFileSize as formatDocumentSize, escapeHtml, hashText, safeFilename } from "../../../ui/ui-utils.js";
import { optionalSessionId as normalizeSessionId } from "../../sessions/session-id.js";
import type { TranscriptEntry, ToolEvent, ToolPresentation } from "../../../tools/renderer-input.js";
import { record } from "../../../tools/renderer-input.js";
import type { TranscriptEntry as StoredEntry, TranscriptImage } from "../../../../shared/contracts/session.js";
import type { MessageDocument } from "../../../../shared/documents/document-attachments.js";
import type { SessionMetadata } from "../../../../shared/session/session-store.js";
import type { createSessionState, ClientRuntime } from "../../sessions/session-state.js";
import type { createTranscriptProjection } from "./projection.js";
import type { createChatScrollFeature } from "../chat-scroll-feature.js";
import type { createComposerFeature } from "../composer-feature.js";
import type { createMathFeature } from "../math-feature.js";
import type { createPerfTrace } from "../../dev/perf-trace.js";
import type { WorkspaceExtensions } from "../../app/workspace-extensions.js";
import type { PortMessage } from "../../app/port-client.js";
type Fields = Record<string, unknown>;
type SessionEntry = StoredEntry & { _uiKey?: string };
interface TranscriptOptions {
  messagesEl: HTMLElement; workspaceRoot?: HTMLElement | null; welcomeHTML?: string; contextUsageEl?: HTMLElement | null;
  sessionState: ReturnType<typeof createSessionState>; projection: ReturnType<typeof createTranscriptProjection>;
  scroll: ReturnType<typeof createChatScrollFeature>; composer: ReturnType<typeof createComposerFeature>; math: ReturnType<typeof createMathFeature>;
  getSessionId?(): string | null; isCurrentSession?(id: unknown): boolean; isChatActive?(): boolean;
  getRunStatus?(): string; getActiveRunSessionId?(): string | null; getRuntime?(id: unknown): Partial<ClientRuntime>;
  isRuntimeRunning?(runtime: Partial<ClientRuntime>): boolean; getTraceId?(id: string): string;
  emitTrace?(name: string, identity: Fields, meta: Fields): void;
  perfTrace?: ReturnType<typeof createPerfTrace>["measure"]; startPerfTrace?: ReturnType<typeof createPerfTrace>["start"];
  syncSearchAfterRender?(id: string): void; hideWelcome?(): void; showWelcome?(): void; showStatus?(text: string): void;
  applyBranding?(): void; renderDock?(): void; renderGoal?(): void; send?(message: PortMessage): unknown;
  request?(type: string, payload?: PortMessage, timeout?: number | null): Promise<PortMessage>;
  nowTimestamp?(): string; formatTokenCount?(value: number): string; runStatusText?(value: unknown): string;
  getSessionTitle?(): string;
  extensions?: WorkspaceExtensions;
}
interface RenderPlan { history: TranscriptEntry[]; prefiltered: boolean; partial: boolean }
interface PlaybackState { target: string; units: string[]; visibleCount: number; carry: number; lastTs: number; lastRenderTs: number; raf: number; finishing: boolean }
import { adoptRendererTree, prepareRendererTree } from "../../../tools/renderer-host.js";
import { mergeTranscriptSnapshotWithLocalState, updateTranscriptWithAgentEvent } from "../../../../shared/session/session-codec.js";
import { editUserTranscriptAndTruncate } from "../../../../shared/session/conversation-edit.js";
import { findElementReferenceTokens } from "../../../../shared/element-reference.js";
import { replaceLoneSurrogates } from "../../../../shared/unicode-utils.js";
import {
  createThinkingTimelineGroupElement,
  createToolTimelineGroupElement,
  patchThinkingTimelineGroupElement,
  patchToolTimelineGroupElement,
  thinkingTimelineGroupEntries,
  timelineGroupTools,
} from "../../../tools/tool-timeline-renderer.js";
import { disposeRendererTree, patchToolEvent, renderToolEvent, toolRendererRegistry } from "../../../tools/tool-renderer.js";
import { createToolPresentationState } from "./presentation-state.js";
import {
  hasActiveSelectionInsideNode,
  morphChildren,
  moveNodePreservingScrollState,
} from "../../../ui/dom-morph.js";
import {
  INNER_SCROLL_TARGET_SELECTOR,
  installTailTracker,
  scrollToTail,
  setFollowTail,
  shouldFollowTail,
} from "../../../ui/scroll-tail-controller.js";
import {
  isAssistantFailureText,
  renderAssistantContentHtml,
  renderChatErrorCardInto,
  renderMarkdown,
  setAssistantFailureClass,
} from "../markdown-feature.js";
import { createTranscriptScheduler } from "./scheduler.js";
import { createMessageActions } from "./message-actions.js";
import { createWaitingCards, isWaitingTranscriptActive } from "./waiting-card.js";
import { createStoreReviewTranscriptCard } from "./store-review-card.js";

const CODE_BLOCK_TAIL_RESUME_PX = 28;
const TRANSCRIPT_CACHE_RENDER_INTERVAL_MS = 120;
const TRANSCRIPT_LIVE_RENDER_INTERVAL_MS = 48;
const TRANSCRIPT_TAIL_FIRST_THRESHOLD = 96;
const TRANSCRIPT_TAIL_FIRST_COUNT = 48;
const TRANSCRIPT_BACKFILL_BATCH_SIZE = 16;
const TRANSCRIPT_BACKFILL_LIVE_DELAY_MS = 1000;
const runStates = Object.freeze({ IDLE: "idle", RUNNING: "running", WAITING_USER: "waiting_user" });

export function createTranscriptRenderer(options: TranscriptOptions) {
  const messagesEl = options.messagesEl;
  const workspaceRoot = options.workspaceRoot || null;
  const welcomeHTML = options.welcomeHTML || "";
  const contextUsageEl = options.contextUsageEl || null;
  const sessionState = options.sessionState;
  const projection = options.projection;
  const scroll = options.scroll;
  const composer = options.composer;
  const mathRenderer = options.math;
  const getSessionId = options.getSessionId || (() => null);
  const isCurrentSession = options.isCurrentSession || (() => false);
  const isChatActive = options.isChatActive || (() => false);
  const getRunStatus = options.getRunStatus || (() => runStates.IDLE);
  const getActiveRunSessionId = options.getActiveRunSessionId || (() => null);
  const getRuntime = options.getRuntime || ((): Partial<ClientRuntime> => ({}));
  const isRuntimeRunning = options.isRuntimeRunning || (() => false);
  const getTraceId = options.getTraceId || (() => "");
  const emitTrace = options.emitTrace || (() => {});
  const perfTrace = options.perfTrace || ((_name, _meta, fn) => fn());
  const startPerfTrace = options.startPerfTrace || (() => null);
  const syncSearchAfterRender = options.syncSearchAfterRender || (() => {});
  const hideWelcome = options.hideWelcome || (() => {});
  const showWelcome = options.showWelcome || (() => {});
  const showStatus = options.showStatus || (() => {});
  const applyBranding = options.applyBranding || (() => {});
  const renderDock = options.renderDock || (() => {});
  const renderGoal = options.renderGoal || (() => {});
  const send = options.send || (() => {});
  const request = options.request || (async () => ({}));
  const nowTimestamp = options.nowTimestamp || (() => new Date().toISOString());
  const formatTokenCount = options.formatTokenCount || (value => String(value || 0));
  const runStatusText = options.runStatusText || (value => String(value || ""));
  const getSessionTitle = options.getSessionTitle || (() => "");
  const extensions = options.extensions;
  if (!messagesEl || !sessionState || !projection || !scroll || !composer || !mathRenderer) {
    throw new Error("transcript renderer dependencies are required");
  }

  const pendingToolCalls = new Map<string, ToolEvent>();
  const transcriptPartialRenderBySessionId = new Map<string, { start: number; end: number; total: number }>();
  const transcriptLastChangedAtBySessionId = new Map<string, number>();
  const scheduler = createTranscriptScheduler({
    workspaceRoot,
    isActive: id => isCurrentSession(id) && isChatActive(),
    render: renderChatTranscript,
    backfill(id) {
      try {
        backfillPartialTranscript(id);
      } catch (error) {
        clearPartialTranscriptRender(id);
        console.warn("[轻舟] transcript backfill failed; scheduling snapshot recovery", error);
        scheduleTranscriptCacheRender(id, { delay: 0 });
      }
    },
    backfillDelay(id) {
      if (isLiveTranscriptActive(id, sessionTranscript(id))) return TRANSCRIPT_BACKFILL_LIVE_DELAY_MS;
      return scroll.isUserScrolling() ? scroll.userScrollIdleMs : null;
    },
    trace(event, id, meta) {
      emitTrace(event, { sessionId: id, streamTraceId: getTraceId(id) || "" },
        event === "ui_render_timer_set" ? { ...meta, live: isLiveTranscriptActive(id, sessionTranscript(id)) } : meta);
    },
  });
  const waitingCards = createWaitingCards({ send: command => request(command.type, command), isCurrentSession });
  const storeReview = createStoreReviewTranscriptCard({
    messagesEl,
    getSessionId: () => normalizeSessionId(getSessionId()) || "",
    hasTranscript: () => currentTranscript().length > 0,
    onPlaced() {
      if (scroll.shouldFollowTail()) scroll.scrollToBottom();
    },
  });
  const toolPresentationState = createToolPresentationState();
  const assistantHighlightScopes = new WeakMap<HTMLElement, object>();
  const messageActions = createMessageActions({
    root: messagesEl,
    downloadFilename: () => `${safeFilename(getSessionTitle() || "assistant-message")}-${safeFilename(nowTimestamp())}.md`,
  });

function scopedToolKey(sessionId: unknown, toolCallId: unknown, runId: unknown = "") {
  const sid = normalizeSessionId(sessionId);
  const tid = String(toolCallId || "").trim();
  const rid = String(runId || "").trim();
  return sid && tid ? `${sid}::${rid || "run"}::${tid}` : "";
}

function toolDomId(sessionId: unknown, entry: TranscriptEntry) {
  const key = scopedToolKey(sessionId, entry?.toolCallId, entry?.runId);
  return key ? `tool-${encodeDomIdPart(key)}` : "";
}

function encodeDomIdPart(value: unknown) {
  return encodeURIComponent(String(value || ""))
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_");
}

function sessionTranscript(sessionId: unknown): SessionEntry[] {
  const id = normalizeSessionId(sessionId);
  return id ? sessionState.getTranscriptView(id) : [];
}

function currentTranscript() {
  return sessionTranscript(getSessionId());
}

function hasSessionTranscript(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  return Boolean(id && sessionState.hasTranscript(id));
}

function setSessionTranscript(sessionId: unknown, history: SessionEntry[]) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const next = Array.isArray(history) ? history.slice() : [];
  sessionState.replaceTranscript(id, next, { preserveLocal: false, assumeChanged: true });
  markSessionTranscriptChanged(id);
  clearPartialTranscriptRender(id);
  return next;
}

function markSessionTranscriptChanged(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  transcriptLastChangedAtBySessionId.set(id, Date.now());
}

function scheduleTranscriptCacheRender(sessionId: unknown, { delay = null }: { delay?: number | null } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || !isCurrentSession(id) || !isChatActive()) return;
  const requestedDelay = delay == null
    ? (isLiveTranscriptActive(id, sessionTranscript(id)) ? TRANSCRIPT_LIVE_RENDER_INTERVAL_MS : TRANSCRIPT_CACHE_RENDER_INTERVAL_MS)
    : Math.max(0, Number(delay) || 0);
  scheduler.requestRender(id, requestedDelay);
}

function cancelTranscriptCacheRender(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (id) scheduler.cancel(id, "render");
}

function clearTranscriptCacheRenders() {
  scheduler.cancel(undefined, "render");
}

function renderChatTranscript(sessionId: unknown, { force = false, intent = "" } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || !isCurrentSession(id) || (!force && !isChatActive())) return;
  cancelTranscriptCacheRender(id);
  const renderTraceEvent = {
    sessionId: id,
    streamTraceId: getTraceId(id) || "",
  };
  const renderTraceStartedAt = Date.now();
  emitTrace("ui_render_start", renderTraceEvent, { force, intent: intent || "" });

  perfTrace("chat.renderTranscript", { sessionId: id, force, requestedIntent: intent || "" }, () => {
    syncWaitingTranscriptFromRuntime(id);
    const history = currentTranscript();
    const renderIntent = resolveTranscriptRenderIntent(id, history, { force, intent });
    const plan = perfTrace("chat.renderTranscript.plan", {
      sessionId: id,
      sourceCount: history.length,
      intent: renderIntent,
    }, () => createTranscriptRenderPlan(id, history, { intent: renderIntent }));
    if (history.length) hideWelcome();
    else showWelcome();

    const renderedHistory = plan.history;
    const patched = !plan.partial
      && renderIntent === "tail"
      && patchLiveTranscriptDomTail(id, renderedHistory);
    if (!patched) perfTrace("chat.renderTranscript.reconcile", {
      sessionId: id,
      count: plan.history.length,
      total: history.length,
      partial: plan.partial,
    }, () => {
      reconcileChatTranscriptDom(id, renderedHistory, { prefiltered: plan.prefiltered });
    });

    if (plan.partial) schedulePartialTranscriptBackfill(id);
    scroll.consumeLatestIntent(id, history);
    syncSearchAfterRender(id);
    emitTrace("ui_render_done", renderTraceEvent, {
      ms: Date.now() - renderTraceStartedAt,
      sourceCount: history.length,
      renderedCount: renderedHistory.length,
      intent: renderIntent,
      patched,
      partial: plan.partial,
    });
  });
}

function resolveTranscriptRenderIntent(sessionId: unknown, history: TranscriptEntry[], { force = false, intent = "" } = {}) {
  if (intent) return normalizeTranscriptRenderIntent(intent);
  if (force && isWorkspaceBooting()) return "opening";
  if (force) return "snapshot";
  return isLiveTranscriptActive(sessionId, history) ? "tail" : "snapshot";
}

function isWorkspaceBooting() {
  return workspaceRoot?.hasAttribute("data-workspace-booting") === true;
}

function normalizeTranscriptRenderIntent(value = "") {
  if (value === "tail" || value === "opening") return value;
  return "snapshot";
}

function createTranscriptRenderPlan(sessionId: unknown, history: TranscriptEntry[], { intent = "snapshot" } = {}): RenderPlan {
  const id = normalizeSessionId(sessionId);
  const renderIntent = normalizeTranscriptRenderIntent(intent);
  if (renderIntent === "tail") {
    clearPartialTranscriptRender(id);
    projection.assignKeys(id, history);
    return { history: projection.uiHistory(history, { sessionId: id || "" }), prefiltered: true, partial: false };
  }

  projection.assignKeys(id, history);
  const visibleHistory = projection.uiHistory(history, { sessionId: id || "" });
  if (renderIntent === "snapshot") {
    clearPartialTranscriptRender(id);
    return { history: visibleHistory, prefiltered: true, partial: false };
  }
  const existingPartial = transcriptPartialRenderBySessionId.get(id || "");
  if (existingPartial && existingPartial.total === visibleHistory.length && existingPartial.start > 0) {
    return {
      history: visibleHistory.slice(existingPartial.start),
      prefiltered: true,
      partial: true,
    };
  }

  if (shouldTailFirstRenderTranscript(id, visibleHistory)) {
    const start = Math.max(0, visibleHistory.length - TRANSCRIPT_TAIL_FIRST_COUNT);
    transcriptPartialRenderBySessionId.set(id || "", {
      start,
      end: visibleHistory.length,
      total: visibleHistory.length,
    });
    return {
      history: visibleHistory.slice(start),
      prefiltered: true,
      partial: true,
    };
  }

  clearPartialTranscriptRender(id);
  return { history: visibleHistory, prefiltered: true, partial: false };
}

function shouldTailFirstRenderTranscript(sessionId: unknown, visibleHistory: TranscriptEntry[]) {
  const id = normalizeSessionId(sessionId);
  if (!id || visibleHistory.length <= TRANSCRIPT_TAIL_FIRST_THRESHOLD) return false;
  if (!scroll.hasLatestIntent(id)) return false;
  if (messagesEl.querySelector<HTMLElement>("[data-transcript-key]")) return false;
  if (getRunStatus() !== runStates.IDLE || isRuntimeRunning(getRuntime(id))) return false;
  return true;
}

function clearSessionPendingToolState(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  const prefix = `${id}::`;
  for (const key of pendingToolCalls.keys()) {
    if (key.startsWith(prefix)) pendingToolCalls.delete(key);
  }
}

function isLiveTranscriptActive(sessionId: unknown, history: TranscriptEntry[]) {
  if (getRunStatus() !== runStates.IDLE) return true;
  if (isRuntimeRunning(getRuntime(sessionId))) return true;
  return history.some(projection.isLiveEntry);
}

function reconcileChatTranscriptDom(sessionId: unknown, history: TranscriptEntry[], { prefiltered = false } = {}) {
  const id = normalizeSessionId(sessionId);
  const endTrace = startPerfTrace("chat.reconcileTranscriptDom", {
    sessionId: id,
    count: Array.isArray(history) ? history.length : 0,
    prefiltered,
  });
  let visibleCount = 0;
  let existingCount = 0;
  let touchedCount = 0;
  let movedCount = 0;
  let removedCount = 0;
  let traceError = "";

  try {
  const shouldStick = scroll.shouldFollowTail();
  const viewportAnchor = shouldStick ? null : capturePinnedTranscriptViewportAnchor();
  const desiredKeys = new Set<string>();
  const endCollect = startPerfTrace("chat.reconcile.collectDom", { sessionId: id });
  const existingByKey = collectTranscriptDomByKey();
  existingCount = existingByKey.size;
  endCollect?.({ existing: existingCount });

  const endPrepare = startPerfTrace("chat.reconcile.prepare", {
    sessionId: id,
    count: Array.isArray(history) ? history.length : 0,
  });
  const visibleHistory = prefiltered ? (Array.isArray(history) ? history : []) : projection.uiHistory(history, { sessionId: id || "" });
  visibleCount = visibleHistory.length;
  const lastUserIndex = findLastIndex(visibleHistory, item => item?.type === "user");
  const assistantActionIndexes = projection.findRoundFinalAssistantIndexes(visibleHistory, {
    canShowActions: getRunStatus() === runStates.IDLE,
  });
  endPrepare?.({ visible: visibleCount });

  clearSessionPendingToolState(id);

  let cursor = messagesEl.querySelector<HTMLElement>("#welcome") || null;
  const endLoop = startPerfTrace("chat.reconcile.patchLoop", { sessionId: id, visible: visibleCount });
  visibleHistory.forEach((entry, index) => {
    if (!entry?._uiKey) return;
    desiredKeys.add(entry._uiKey);
    let el = existingByKey.get(entry._uiKey) || null;
    const next = reconcileTranscriptElement(el, entry, id, index, lastUserIndex, assistantActionIndexes);
    if (!next) return;
    touchedCount += 1;
    el = next;
    syncTranscriptDomMetadata(el, entry);

    const expectedNext = cursor ? cursor.nextSibling : messagesEl.firstChild;
    if (el !== expectedNext) {
      movedCount += 1;
      moveNodePreservingScrollState(messagesEl, el, expectedNext, {
        scrollSelector: INNER_SCROLL_TARGET_SELECTOR,
      });
    }
    adoptRendererTree(messagesEl, el);
    cursor = el;
  });
  endLoop?.({ touched: touchedCount, moved: movedCount });

  const endRemove = startPerfTrace("chat.reconcile.removeStale", { sessionId: id });
  for (const el of Array.from(messagesEl.querySelectorAll<HTMLElement>("[data-transcript-key]"))) {
    if (!desiredKeys.has(el.dataset.transcriptKey || "")) {
      removedCount += 1;
      retireTranscriptElement(el);
    }
  }
  endRemove?.({ removed: removedCount });

  storeReview.sync();
  if (shouldStick) scroll.scrollToBottom();
  else if (viewportAnchor) scroll.restoreAnchor(viewportAnchor);
  } catch (err) {
    traceError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    endTrace?.({
      visible: visibleCount,
      existing: existingCount,
      touched: touchedCount,
      moved: movedCount,
      removed: removedCount,
      error: traceError || undefined,
    });
  }
}

function retireTranscriptElement(el: HTMLElement) {
  if (!el) return;
  waitingCards.dispose(el);
  messageActions.dispose(el);
  if (extensions?.retireTranscriptElement(el)) return;
  disposeRendererTree(el);
  el.remove();
}

function collectTranscriptDomByKey() {
  const out = new Map<string, HTMLElement>();
  for (const el of messagesEl.querySelectorAll<HTMLElement>("[data-transcript-key]")) {
    if (el.dataset.transcriptKey) out.set(el.dataset.transcriptKey, el);
  }
  return out;
}

function capturePinnedTranscriptViewportAnchor() {
  if (scroll.shouldFollowTail()) return null;
  const activeAnchor = scroll.captureActiveAnchor?.();
  if (activeAnchor) return activeAnchor;
  const viewport = messagesEl.getBoundingClientRect();
  const visible = Array.from(messagesEl.children).filter(element => {
    if (!(element instanceof Element) || !element.getAttribute("data-transcript-key")) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top + 4 && rect.top < viewport.bottom - 4;
  });
  const stable = visible.filter(element => (
    element.getAttribute("data-transcript-live") !== "true"
    && !element.classList.contains("msg-waiting")
  ));
  const expanded = visible.find(element => element.querySelector<HTMLElement>(":scope > [aria-expanded='true']"));
  const candidates = stable.length ? stable : visible;
  const anchor = expanded
    || candidates.find(element => element.getBoundingClientRect().top >= viewport.top + 4)
    || candidates[0]
    || null;
  if (!anchor) return null;
  const transcriptKey = anchor.getAttribute("data-transcript-key");
  const expandedHeader = expanded?.querySelector?.<HTMLElement>(":scope > .tool-summary[aria-expanded='true'], :scope > .tool-timeline-summary[aria-expanded='true'], :scope > .thinking-group-summary[aria-expanded='true']") || null;
  return scroll.captureAnchorForElement(expandedHeader || anchor, {
    resolveElement: () => {
      const liveAnchor = Array.from(messagesEl.children).find(element => (
        element.getAttribute("data-transcript-key") === transcriptKey
      )) || null;
      if (!expandedHeader) return liveAnchor;
      return liveAnchor?.querySelector?.<HTMLElement>(":scope > .tool-summary, :scope > .tool-timeline-summary, :scope > .thinking-group-summary") || liveAnchor;
    },
  });
}

function syncTranscriptDomMetadata(el: HTMLElement, entry: TranscriptEntry) {
  if (!el || !entry) return;
  el.dataset.transcriptKey = entry._uiKey || "";
  el.dataset.transcriptType = entry.type || "";
  el.dataset.transcriptLive = isLiveVisibleTranscriptEntry(entry) ? "true" : "false";
}

function patchLiveTranscriptDomTail(sessionId: unknown, visibleHistory: TranscriptEntry[]) {
  const id = normalizeSessionId(sessionId);
  const history = Array.isArray(visibleHistory) ? visibleHistory : [];
  const endTrace = startPerfTrace("chat.livePatchTail", {
    sessionId: id,
    visible: history.length,
  });
  const firstLive = history.findIndex(isLiveVisibleTranscriptEntry);
  let patchStart = -1;
  let previouslyLive = -1;
  let touchedCount = 0;
  let movedCount = 0;
  let patched = false;
  let fallbackReason = "";
  try {
    if (!id) {
      fallbackReason = "missing-session";
      return false;
    }
    if (!history.length) {
      fallbackReason = "empty-history";
      return false;
    }
    const existingByKey = collectTranscriptDomByKey();
    if (!existingByKey.size) {
      fallbackReason = "no-existing-dom";
      return false;
    }

    previouslyLive = history.findIndex(entry => (
      entry?._uiKey && existingByKey.get(entry._uiKey)?.dataset.transcriptLive === "true"
    ));
    patchStart = firstLive >= 0
      ? Math.max(0, firstLive - 1)
      : history.length - 1;
    if (previouslyLive >= 0) patchStart = Math.min(patchStart, previouslyLive);
    let rewoundToFindAnchor = false;
    while (patchStart > 0 && !existingByKey.has(history[patchStart - 1]?._uiKey || "")) {
      patchStart -= 1;
      rewoundToFindAnchor = true;
    }
    if (!isLivePatchDomCompatible(history, patchStart, existingByKey)) {
      fallbackReason = "projection-mismatch";
      return false;
    }
    if (rewoundToFindAnchor && patchStart === 0) {
      fallbackReason = "missing-anchor";
      return false;
    }
    const anchor = patchStart > 0
      ? existingByKey.get(history[patchStart - 1]?._uiKey || "") || null
      : (messagesEl.querySelector<HTMLElement>("#welcome") || null);
    if (patchStart > 0 && !anchor) {
      fallbackReason = "missing-anchor";
      return false;
    }

    const shouldStick = scroll.shouldFollowTail();
    const viewportAnchor = shouldStick ? null : capturePinnedTranscriptViewportAnchor();
    const lastUserIndex = findLastIndex(history, item => item?.type === "user");
    const assistantActionIndexes = projection.findRoundFinalAssistantIndexes(history, {
      canShowActions: getRunStatus() === runStates.IDLE,
    });
    let cursor = anchor || null;
    for (let index = patchStart; index < history.length; index += 1) {
      const entry = history[index];
      if (!entry?._uiKey) continue;
      let el = existingByKey.get(entry._uiKey) || null;
      const next = reconcileTranscriptElement(el, entry, id, index, lastUserIndex, assistantActionIndexes);
      if (!next) continue;
      touchedCount += 1;
      el = next;
      syncTranscriptDomMetadata(el, entry);
      const expectedNext = cursor ? cursor.nextSibling : messagesEl.firstChild;
      if (el !== expectedNext) {
        movedCount += 1;
        moveNodePreservingScrollState(messagesEl, el, expectedNext, {
          scrollSelector: INNER_SCROLL_TARGET_SELECTOR,
        });
      }
      cursor = el;
    }
    storeReview.sync();
    if (shouldStick) scroll.scrollToBottom();
    else if (viewportAnchor) scroll.restoreAnchor(viewportAnchor);
    patched = true;
    return true;
  } finally {
    endTrace?.({
      patched,
      fallbackReason,
      firstLive,
      previouslyLive,
      patchStart,
      touched: touchedCount,
      moved: movedCount,
    });
  }
}

function isLivePatchDomCompatible(history: TranscriptEntry[], patchStart: number, existingByKey: Map<string, HTMLElement>) {
  const desiredKeys = (Array.isArray(history) ? history : []).map(entry => entry?._uiKey || "").filter(Boolean);
  const existingKeys = Array.from(messagesEl.querySelectorAll<HTMLElement>("[data-transcript-key]"), el => el.dataset.transcriptKey || "").filter(Boolean);
  if (existingKeys.length !== existingByKey?.size || new Set(existingKeys).size !== existingKeys.length) return false;

  const start = Math.max(0, Math.min(desiredKeys.length, Number(patchStart) || 0));
  for (let index = 0; index < start; index += 1) {
    if (existingKeys[index] !== desiredKeys[index]) return false;
  }
  const desiredTail = new Set(desiredKeys.slice(start));
  return existingKeys.slice(start).every(key => desiredTail.has(key));
}

function isLiveVisibleTranscriptEntry(entry: TranscriptEntry = {}) {
  if (projection.isLiveEntry(entry)) return true;
  if (entry.type === "thinking-group") return thinkingTimelineGroupEntries(entry).some(projection.isLiveEntry);
  if (entry.type === "tool-group") return timelineGroupTools(entry).some(projection.isLiveEntry);
  return false;
}

function schedulePartialTranscriptBackfill(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  const state = transcriptPartialRenderBySessionId.get(id || "");
  if (id && state && state.start > 0) scheduler.requestBackfill(id);
}

function backfillPartialTranscript(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  const state = transcriptPartialRenderBySessionId.get(id || "");
  if (!id || !state || state.start <= 0) return;
  if (!isCurrentSession(id) || !isChatActive()) return;
  if (scroll.isUserScrolling() || isLiveTranscriptActive(id, sessionTranscript(id))) {
    schedulePartialTranscriptBackfill(id);
    return;
  }

  perfTrace("chat.partialBackfill", { sessionId: id, start: state.start, total: state.total }, () => {
    const history = currentTranscript();
    projection.assignKeys(id, history);
    const visibleHistory = projection.uiHistory(history, { sessionId: id || "" });
    if (visibleHistory.length !== state.total) {
      clearPartialTranscriptRender(id);
      renderChatTranscript(id, { force: true });
      return;
    }

    const nextStart = Math.max(0, state.start - TRANSCRIPT_BACKFILL_BATCH_SIZE);
    const anchor = messagesEl.querySelector<HTMLElement>("[data-transcript-key]");
    const existingByKey = collectTranscriptDomByKey();
    const fragment = document.createDocumentFragment();
    const lastUserIndex = findLastIndex(visibleHistory, item => item?.type === "user");
    const assistantActionIndexes = projection.findRoundFinalAssistantIndexes(visibleHistory, {
      canShowActions: getRunStatus() === runStates.IDLE,
    });
    const previousHeight = messagesEl.scrollHeight;
    const wasFollowingTail = scroll.shouldFollowTail();

    for (let index = nextStart; index < state.start; index += 1) {
      const entry = visibleHistory[index];
      if (!entry?._uiKey || existingByKey.has(entry._uiKey)) continue;
      const el = reconcileTranscriptElement(null, entry, id, index, lastUserIndex, assistantActionIndexes);
      if (!el) continue;
      syncTranscriptDomMetadata(el, entry);
      fragment.appendChild(el);
    }

    if (fragment.childNodes.length) {
      messagesEl.insertBefore(fragment, anchor);
      const delta = messagesEl.scrollHeight - previousHeight;
      if (wasFollowingTail) {
        scroll.scrollToBottom({ immediate: true, instant: true, force: true });
      } else if (delta > 0) {
        scroll.adjustScrollTop(delta);
      }
    }

    state.start = nextStart;
    if (state.start <= 0) {
      clearPartialTranscriptRender(id);
      return;
    }
    schedulePartialTranscriptBackfill(id);
  });
}

function clearPartialTranscriptRender(sessionId: unknown = null) {
  const id = normalizeSessionId(sessionId);
  if (id) {
    transcriptPartialRenderBySessionId.delete(id);
    cancelTranscriptBackfill(id);
    return;
  }
  transcriptPartialRenderBySessionId.clear();
  cancelTranscriptBackfill();
}

function cancelTranscriptBackfill(sessionId: unknown = null) {
  const id = normalizeSessionId(sessionId);
  scheduler.cancel(id || undefined, "backfill");
}

function reconcileTranscriptElement(existing: HTMLElement | null, entry: TranscriptEntry, sessionId: unknown, index: number, lastUserIndex: number, assistantActionIndexes: Set<number>) {
  if (!existing) {
    return createTranscriptElement(entry, sessionId, index, lastUserIndex, assistantActionIndexes);
  }

  const patched = existing.dataset.transcriptType === entry.type
    && patchTranscriptElement(existing, entry, sessionId, index, lastUserIndex, assistantActionIndexes);
  if (patched) return existing;

  const next = createTranscriptElement(entry, sessionId, index, lastUserIndex, assistantActionIndexes);
  waitingCards.dispose(existing);
  messageActions.dispose(existing);
  disposeRendererTree(existing);
  if (next) existing.replaceWith(next);
  else existing.remove();
  return next;
}

function createTranscriptElement(entry: TranscriptEntry, sessionId: unknown, index: number, lastUserIndex: number, assistantActionIndexes: Set<number>) {
  return prepareRendererTree(() => {
  switch (entry.type) {
    case "user":
      return createUserTranscriptElement(entry, sessionId, index, lastUserIndex);
    case "thinking-group":
      return createThinkingTimelineGroupElement(entry);
    case "assistant":
      return createAssistantTranscriptElement(entry, assistantActionIndexes.has(index));
    case "tool":
      return createToolTranscriptElement(entry, sessionId);
    case "tool-group":
      return createToolTimelineGroupTranscriptElement(entry, sessionId);
    case "compact":
      return createCompactTranscriptElement(entry);
    case "wait":
      return waitingCards.create(entry, normalizeSessionId(sessionId));
    case "note":
      return createNoteTranscriptElement(entry);
    case "run-status":
      return createRunStatusTranscriptElement(entry);
    case "error":
      return createErrorTranscriptElement(entry);
    default:
      return extensions?.createTranscriptElement(entry) || null;
  }
  });
}

function patchTranscriptElement(el: HTMLElement, entry: TranscriptEntry, sessionId: unknown, index: number, lastUserIndex: number, assistantActionIndexes: Set<number>) {
  switch (entry.type) {
    case "user":
      return patchUserTranscriptElement(el, entry, sessionId, index, lastUserIndex);
    case "thinking-group":
      return patchThinkingTimelineGroupElement(el, entry);
    case "assistant":
      return patchAssistantTranscriptElement(el, entry, assistantActionIndexes.has(index));
    case "tool":
      return patchToolTranscriptElement(el, entry, sessionId);
    case "tool-group":
      return patchToolTimelineGroupTranscriptElement(el, entry, sessionId);
    case "compact":
      return patchCompactTranscriptElement(el, entry);
    case "wait":
      return waitingCards.patch(el, entry, normalizeSessionId(sessionId));
    case "note":
      return patchNoteTranscriptElement(el, entry);
    case "run-status":
      return patchRunStatusTranscriptElement(el, entry);
    case "error":
      return patchErrorTranscriptElement(el, entry);
    default:
      return extensions?.patchTranscriptElement(el, entry) === true;
  }
}

function createUserTranscriptElement(entry: TranscriptEntry, sessionId: unknown, index: number, lastUserIndex: number) {
  const div = document.createElement("div");
  div.className = "msg msg-user";
  div.dataset.clientMessageId = normalizeClientMessageIdValue(entry.clientMessageId);
  div.innerHTML = `
    <div class="msg-user-row">
      <div class="msg-content user-selectable">
        ${entry.text ? `<div class="user-text"></div>` : ""}
        ${renderUserImages(entry.images || [])}
        ${renderUserDocuments(entry.documents || [])}
      </div>
    </div>
  `;
  if (entry.text) div.querySelector<HTMLElement>(".user-text")!.innerHTML = renderUserTextWithResourcePills(entry.text);
  syncUserMessageDelivery(div, entry);
  syncUserMessageActions(div, entry, canEditUserTranscriptEntry(entry, index, lastUserIndex, sessionId));
  const outgoingEntry = composer.consumeOutgoingEntry(sessionId, entry.clientMessageId);
  if (outgoingEntry) composer.playOutgoingEntry(div, outgoingEntry);
  return div;
}

function patchUserTranscriptElement(el: HTMLElement, entry: TranscriptEntry, sessionId: unknown, index: number, lastUserIndex: number) {
  if (el.classList.contains("is-editing")) return true;
  const hasEditShell = Boolean(el.querySelector<HTMLElement>(".msg-user-edit-shell"));
  if (!hasEditShell && !el.classList.contains("is-resending") && hasActiveSelectionInsideNode(el)) return true;
  el.classList.remove("is-resending");
  el.dataset.clientMessageId = normalizeClientMessageIdValue(entry.clientMessageId);
  const row = ensureUserMessageRow(el);
  const content = row.querySelector<HTMLElement>(".msg-content") || el.querySelector<HTMLElement>(".msg-content");
  if (!content) return false;
  if (hasEditShell) {
    content.innerHTML = "";
    content.classList.add("user-selectable");
  }

  let textEl = content.querySelector<HTMLElement>(".user-text");
  const text = entry.text || "";
  if (text) {
    if (!textEl) {
      textEl = document.createElement("div");
      textEl.className = "user-text";
      content.prepend(textEl);
    }
    patchHtmlContent(textEl, renderUserTextWithResourcePills(text));
  } else if (textEl) {
    textEl.remove();
  }

  const imagesHtml = renderUserImages(entry.images || []);
  const currentImages = content.querySelector<HTMLElement>(".msg-images");
  if (imagesHtml) {
    if (currentImages) {
      const nextWrap = document.createElement("div");
      nextWrap.innerHTML = imagesHtml;
      patchElementHtmlIfChanged(currentImages, nextWrap.firstElementChild);
    } else {
      content.insertAdjacentHTML("beforeend", imagesHtml);
    }
  } else if (currentImages) {
    currentImages.remove();
  }

  const documentsHtml = renderUserDocuments(entry.documents || []);
  const currentDocuments = content.querySelector<HTMLElement>(".msg-documents");
  if (documentsHtml) {
    if (currentDocuments) {
      const nextWrap = document.createElement("div");
      nextWrap.innerHTML = documentsHtml;
      patchElementHtmlIfChanged(currentDocuments, nextWrap.firstElementChild);
    } else {
      content.insertAdjacentHTML("beforeend", documentsHtml);
    }
  } else if (currentDocuments) {
    currentDocuments.remove();
  }

  syncUserMessageDelivery(el, entry);
  syncUserMessageActions(el, entry, canEditUserTranscriptEntry(entry, index, lastUserIndex, sessionId));
  return true;
}

function canEditUserTranscriptEntry(entry: TranscriptEntry, index: number, lastUserIndex: number, sessionId: unknown = getSessionId()) {
  if (!entry || entry.type !== "user") return false;
  if (normalizeDeliveryStatusValue(entry.deliveryStatus) === "failed") return false;
  if (getRunStatus() !== runStates.IDLE) return false;
  if (isRuntimeRunning(getRuntime(sessionId))) return false;
  if (normalizeClientMessageIdValue(entry.clientMessageId)) return true;
  if (index !== lastUserIndex) return false;
  return true;
}

function syncUserMessageDelivery(el: HTMLElement, entry: TranscriptEntry) {
  const failed = normalizeDeliveryStatusValue(entry?.deliveryStatus) === "failed";
  const existing = el?.querySelector?.<HTMLElement>(".msg-user-delivery");
  el?.classList?.toggle("is-delivery-failed", failed);
  if (!failed) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const status = document.createElement("div");
  status.className = "msg-user-delivery";
  status.setAttribute("role", "status");
  status.innerHTML = `<span>${tHtml("notSent")}</span><span aria-hidden="true">·</span><button class="qz-btn qz-btn--inline msg-user-retry" type="button" data-action="retry-user-message">${tHtml("resend")}</button>`;
  el.appendChild(status);
}

function syncUserMessageActions(el: HTMLElement, entry: TranscriptEntry, canEdit: boolean) {
  if (!el) return;
  const existing = el.querySelector<HTMLElement>(".msg-user-actions");
  if (!canEdit || el.classList.contains("is-editing")) {
    existing?.remove();
    el.classList.toggle("is-editable", false);
    return;
  }
  el.classList.toggle("is-editable", true);
  if (existing) return;
  const host = ensureUserMessageRow(el);
  const content = el.querySelector<HTMLElement>(".msg-content");
  const actions = document.createElement("div");
  actions.className = "msg-user-actions";
  actions.innerHTML = `
    <button class="qz-icon-btn qz-icon-btn--sm msg-action-btn msg-user-edit-btn" type="button" data-action="edit-user-message" data-tooltip="${tHtml("edit")}" title="${tHtml("edit")}" aria-label="${tHtml("edit")}">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15.2 5.2 3.6 3.6"/><path d="M4 20l4.2-1 11-11a2.55 2.55 0 0 0-3.6-3.6l-11 11Z"/></svg>
    </button>
  `;
  if (content && content.parentElement === host) host.insertBefore(actions, content);
  else host.prepend(actions);
}

function ensureUserMessageRow(el: HTMLElement) {
  const directRow = Array.from(el.children || []).find(child => child?.classList?.contains("msg-user-row"));
  if (directRow) return directRow;
  const content = el.querySelector<HTMLElement>(".msg-content");
  if (!content) return el;
  const row = document.createElement("div");
  row.className = "msg-user-row";
  const existingActions = el.querySelector<HTMLElement>(".msg-user-actions");
  el.insertBefore(row, content);
  if (existingActions) row.appendChild(existingActions);
  row.appendChild(content);
  return row;
}

function handleUserMessageActionClick(event: Event) {
  const target = event.target instanceof Element ? event.target : null;
  const retryBtn = target?.closest?.<HTMLButtonElement>("[data-action='retry-user-message']");
  if (retryBtn && messagesEl.contains(retryBtn)) {
    event.preventDefault();
    event.stopPropagation();
    retryBtn.disabled = true;
    void composer.retryUserMessage(findUserTranscriptEntryForElement(retryBtn.closest<HTMLElement>(".msg-user")) || {});
    return;
  }
  const editBtn = target?.closest?.<HTMLButtonElement>("[data-action='edit-user-message']");
  if (editBtn && messagesEl.contains(editBtn)) {
    event.preventDefault();
    event.stopPropagation();
    startUserMessageEdit(editBtn.closest<HTMLElement>(".msg-user"));
    return;
  }

  const cancelBtn = target?.closest?.<HTMLButtonElement>("[data-action='cancel-user-edit']");
  if (cancelBtn && messagesEl.contains(cancelBtn)) {
    event.preventDefault();
    event.stopPropagation();
    cancelUserMessageEdit(cancelBtn.closest<HTMLElement>(".msg-user"));
    return;
  }

  const submitBtn = target?.closest?.<HTMLButtonElement>("[data-action='submit-user-edit']");
  if (submitBtn && messagesEl.contains(submitBtn)) {
    event.preventDefault();
    event.stopPropagation();
    submitUserMessageEdit(submitBtn.closest<HTMLElement>(".msg-user"));
  }
}

function handleUserMessageEditInput(event: Event) {
  const textarea = event.target instanceof Element ? event.target.closest<HTMLTextAreaElement>(".msg-user-edit-input") : null;
  if (!textarea || !messagesEl.contains(textarea)) return;
  scroll.preserveViewportDuringContentLayout(() => {
    autoResizeUserMessageEdit(textarea);
  });
}

function handleUserMessageEditKeydown(event: KeyboardEvent) {
  const textarea = event.target instanceof Element ? event.target.closest<HTMLTextAreaElement>(".msg-user-edit-input") : null;
  if (!textarea || !messagesEl.contains(textarea)) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelUserMessageEdit(textarea.closest<HTMLElement>(".msg-user"));
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    submitUserMessageEdit(textarea.closest<HTMLElement>(".msg-user"));
  }
}

function startUserMessageEdit(el: HTMLElement | null) {
  const entry = findUserTranscriptEntryForElement(el);
  if (!el || !entry || !canEditUserMessageElement(el, entry)) return;
  const content = el.querySelector<HTMLElement>(".msg-content");
  if (!content) return;
  scroll.preserveViewportDuringContentLayout(() => {
    hideAssistantMessageActions();
    el.classList.add("is-editing");
    el.querySelector<HTMLElement>(".msg-user-actions")?.remove();
    content.classList.remove("user-selectable");
    content.innerHTML = `
      <div class="msg-user-edit-shell">
        <textarea class="qz-field qz-field--bare msg-user-edit-input" spellcheck="false" rows="1" aria-label="${tHtml("editRequest")}">${escapeHtml(entry.text || "")}</textarea>
        ${renderUserImages(entry.images || [])}
        ${renderUserDocuments(entry.documents || [])}
        <div class="msg-user-edit-actions">
          <button class="qz-btn qz-btn--ghost qz-btn--sm msg-user-edit-cancel" type="button" data-action="cancel-user-edit">${tHtml("cancel")}</button>
          <button class="qz-btn qz-btn--primary qz-btn--sm msg-user-edit-submit" type="button" data-action="submit-user-edit">${tHtml("send")}</button>
        </div>
      </div>
    `;
    const textarea = content.querySelector<HTMLTextAreaElement>(".msg-user-edit-input");
    if (textarea) autoResizeUserMessageEdit(textarea);
  });
  const textarea = content.querySelector<HTMLTextAreaElement>(".msg-user-edit-input");
  if (textarea) {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
}

function cancelUserMessageEdit(el: HTMLElement | null) {
  const textarea = el?.querySelector?.<HTMLTextAreaElement>(".msg-user-edit-input") || null;
  if (!el) return;
  const fallbackText = String(textarea?.value || "");
  const entry = findUserTranscriptEntryForElement(el);
  scroll.preserveViewportDuringContentLayout(() => {
    textarea?.blur?.();
    settleUserMessageActionsAfterEdit(el);
    el.classList.remove("is-editing", "is-resending");
    if (entry) restoreUserMessageElement(el, entry);
    else restoreUserMessageElementFromEditShell(el, fallbackText);
  });
}

function settleUserMessageActionsAfterEdit(el: HTMLElement) {
  if (!el) return;
  el.classList.add("is-settling-edit");
  requestAnimationFrame(() => el.classList.remove("is-settling-edit"));
}

function restoreUserMessageElement(el: HTMLElement, entry: TranscriptEntry) {
  if (!el || !entry) return;
  const visibleHistory = projection.uiHistory(currentTranscript(), { sessionId: getSessionId() || "" });
  const index = findUserTranscriptEntryIndex(visibleHistory, entry, el);
  const lastUserIndex = findLastIndex(visibleHistory, item => item?.type === "user");
  patchUserTranscriptElement(el, entry, getSessionId(), index, lastUserIndex);
}

function findUserTranscriptEntryIndex(history: TranscriptEntry[] = [], entry: TranscriptEntry, el: HTMLElement) {
  if (!entry) return -1;
  const key = entry._uiKey || el?.dataset?.transcriptKey || "";
  if (key) {
    const byKey = history.findIndex(item => item?.type === "user" && item._uiKey === key);
    if (byKey >= 0) return byKey;
  }
  const clientMessageId = normalizeClientMessageIdValue(entry.clientMessageId || el?.dataset?.clientMessageId);
  if (clientMessageId) {
    const byId = history.findIndex(item => (
      item?.type === "user"
      && normalizeClientMessageIdValue(item.clientMessageId) === clientMessageId
    ));
    if (byId >= 0) return byId;
  }
  return history.indexOf(entry);
}

function restoreUserMessageElementFromEditShell(el: HTMLElement, text = "") {
  const content = el?.querySelector?.<HTMLElement>(".msg-content");
  if (!content) return;
  content.classList.add("user-selectable");
  content.innerHTML = text ? '<div class="user-text"></div>' : "";
  if (text) content.querySelector<HTMLElement>(".user-text")!.innerHTML = renderUserTextWithResourcePills(text);
  syncUserMessageActions(el, { type: "user", text }, false);
}

function submitUserMessageEdit(el: HTMLElement | null) {
  const entry = findUserTranscriptEntryForElement(el);
  const textarea = el?.querySelector?.<HTMLTextAreaElement>(".msg-user-edit-input");
  if (!el || !entry || !textarea || !getSessionId()) return;
  const text = replaceLoneSurrogates(String(textarea.value || "").trim());
  const images = Array.isArray(entry.images) ? entry.images : [];
  const documents = Array.isArray(entry.documents) ? entry.documents : [];
  if (!text && images.length === 0 && documents.length === 0) return;

  textarea.blur();
  el.classList.remove("is-editing");
  el.classList.add("is-resending");
  el.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea").forEach(control => {
    control.disabled = true;
  });

  const clientMessageId = normalizeClientMessageIdValue(entry.clientMessageId);
  scroll.lockForSubmittedAction();
  applyLocalEditedUserMessage(getSessionId(), { clientMessageId, text, images, documents });
  extensions?.notify({ type: "ui_chat_submitted", sessionId: getSessionId(), clientMessageId });
  showStatus(t("resending"));
  send({
    type: "resend_prompt",
    sessionId: getSessionId(),
    clientMessageId,
    text,
    images: images.map(img => ({
      dataUrl: img.dataUrl,
      type: img.type || "",
      name: img.name || "",
    })),
    documents,
  });
}

function autoResizeUserMessageEdit(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function findUserTranscriptEntryForElement(el: HTMLElement | null) {
  if (!el) return null;
  const key = el.dataset.transcriptKey || "";
  const clientMessageId = normalizeClientMessageIdValue(el.dataset.clientMessageId);
  const history = currentTranscript();
  if (key) {
    const byKey = history.find(entry => entry?.type === "user" && entry._uiKey === key);
    if (byKey) return byKey;
  }
  if (clientMessageId) {
    const byId = history.find(entry => (
      entry?.type === "user"
      && normalizeClientMessageIdValue(entry.clientMessageId) === clientMessageId
    ));
    if (byId) return byId;
  }
  return history[findLastIndex(history, entry => entry?.type === "user")] || null;
}

function canEditUserMessageElement(el: HTMLElement, entry: TranscriptEntry) {
  if (!entry || entry.type !== "user") return false;
  const history = currentTranscript();
  const visibleHistory = projection.uiHistory(history, { sessionId: getSessionId() || "" });
  const index = findUserTranscriptEntryIndex(visibleHistory, entry, el);
  const lastUserIndex = findLastIndex(visibleHistory, item => item?.type === "user");
  return canEditUserTranscriptEntry(entry, index, lastUserIndex, getSessionId());
}

function applyLocalEditedUserMessage(sessionId: unknown, { clientMessageId = "", text = "", images = [], documents = [] }: { clientMessageId?: string; text?: string; images?: TranscriptImage[]; documents?: MessageDocument[] } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  const result = editUserTranscriptAndTruncate(sessionTranscript(id), {
    clientMessageId,
    text,
    images,
    documents,
    now: nowTimestamp,
  });
  if (!result.changed) return;
  setSessionTranscript(id, result.transcript);
  clearPartialTranscriptRender(id);
  extensions?.notify({ type: "ui_transcript_replaced", sessionId: id });
  if (isCurrentSession(id)) renderChatTranscript(id, { force: true });
}

function createAssistantTranscriptElement(entry: TranscriptEntry, showActions: boolean) {
  const div = document.createElement("div");
  div.className = "msg msg-assistant";
  const content = document.createElement("div");
  content.className = "msg-content";
  div.appendChild(content);
  const streamTraceId = entry.streamTraceId || entry.spanId || "";
  if (streamTraceId) div.dataset.streamTraceId = streamTraceId;
  const traceEvent = {
    sessionId: getSessionId(),
    runId: entry.runId || "",
    spanId: entry.spanId || "",
    streamTraceId,
  };
  if (entry.streaming) {
    div.dataset.content = "";
    emitTrace("ui_assistant_create_streaming", traceEvent, { chars: String(entry.content || "").length });
    assistantPlayback.setTarget(div, entry.content || "");
  } else {
    emitTrace("ui_assistant_create_final", traceEvent, { chars: String(entry.content || "").length });
    setAssistantFailureClass(div, String(entry.content || ""));
    content.innerHTML = renderAssistantContentHtml(String(entry.content || ""));
    mathRenderer.schedule(content);
    div.dataset.content = String(entry.content || "");
    div.dataset.finalContent = String(entry.content || "");
    syncAssistantMessageActions(div, showActions, entry);
  }
  return div;
}

function patchAssistantTranscriptElement(el: HTMLElement, entry: TranscriptEntry, showActions: boolean) {
  const content = el.querySelector<HTMLElement>(".msg-content");
  if (!content) return false;
  const nextContent = String(entry.content || "");
  const streamTraceId = entry.streamTraceId || entry.spanId || el.dataset.streamTraceId || "";
  if (streamTraceId) el.dataset.streamTraceId = streamTraceId;
  const traceEvent = {
    sessionId: getSessionId(),
    runId: entry.runId || "",
    spanId: entry.spanId || "",
    streamTraceId,
  };
  if (entry.streaming) {
    syncAssistantMessageActions(el, false, entry);
    emitTrace("ui_assistant_patch_streaming", traceEvent, { chars: nextContent.length });
    assistantPlayback.setTarget(el, nextContent);
    return true;
  }
  emitTrace("ui_assistant_patch_final", traceEvent, {
    chars: nextContent.length,
    hadPlaybackState: assistantPlayback.hasState(el),
  });
  assistantPlayback.finish(el, nextContent);
  setAssistantFailureClass(el, nextContent);
  el.dataset.finalContent = nextContent;
  syncAssistantMessageActions(el, showActions, entry);
  return true;
}

function syncAssistantMessageActions(el: HTMLElement, showActions: boolean, entry: TranscriptEntry = {}) {
  messageActions.sync(el, showActions);
}

function hideAssistantMessageActions() {
  messageActions.hideAll();
}

const assistantPlayback = (() => {
  const states = new WeakMap<HTMLElement, PlaybackState>();
  let activeEl: HTMLElement | null = null;
  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : null;
  const FRAME_RENDER_MS = 34;

  function setTarget(el: HTMLElement, target: unknown) {
    if (!el) return;
    if (activeEl && activeEl !== el) flush(activeEl);
    activeEl = el;
    const text = String(target || "");
    let state = states.get(el);
    if (!state) {
      const visible = el.dataset.content || "";
      state = {
        target: "",
        units: [],
        visibleCount: splitGraphemes(visible).length,
        carry: 0,
        lastTs: 0,
        lastRenderTs: 0,
        raf: 0,
        finishing: false,
      };
      states.set(el, state);
    }
    if (state.target !== text) {
      state.target = text;
      state.units = splitGraphemes(text);
      if (state.visibleCount > state.units.length) state.visibleCount = state.units.length;
    }
    state.finishing = false;
    ensureLoop(el, state);
  }

  function finish(el: HTMLElement, target: unknown) {
    if (!el) return;
    const text = String(target || "");
    const state = states.get(el);
    if (!state) {
      renderAssistantPlaybackContent(el, text, { math: true });
      if (activeEl === el) activeEl = null;
      return;
    }
    if (state.target !== text) {
      state.target = text;
      state.units = splitGraphemes(text);
      if (state.visibleCount > state.units.length) state.visibleCount = state.units.length;
    }
    if (activeEl && activeEl !== el) {
      flush(el);
      return;
    }
    activeEl = el;
    state.finishing = true;
    ensureLoop(el, state);
  }

  function cancel(el: HTMLElement) {
    const state = states.get(el);
    if (!state) {
      if (activeEl === el) activeEl = null;
      return;
    }
    if (state.raf) cancelAnimationFrame(state.raf);
    states.delete(el);
    if (activeEl === el) activeEl = null;
  }

  function cancelActive() {
    if (activeEl) cancel(activeEl);
  }

  function flush(el: HTMLElement) {
    const state = states.get(el);
    if (state?.raf) cancelAnimationFrame(state.raf);
    if (state && el?.isConnected) {
      renderAssistantPlaybackContent(el, state.target, { math: true, followCodeBlocks: true });
    }
    if (state) states.delete(el);
    if (activeEl === el) activeEl = null;
  }

  function hasState(el: HTMLElement) {
    return states.has(el);
  }

  function ensureLoop(el: HTMLElement, state: PlaybackState) {
    if (state.raf) return;
    state.raf = requestAnimationFrame(ts => tick(el, ts));
  }

  function tick(el: HTMLElement, ts: number) {
    const state = states.get(el);
    if (!state) return;
    state.raf = 0;
    if (!el.isConnected) {
      states.delete(el);
      if (activeEl === el) activeEl = null;
      return;
    }

    const content = el.querySelector<HTMLElement>(".msg-content");
    if (!content) {
      states.delete(el);
      if (activeEl === el) activeEl = null;
      return;
    }

    if (hasActiveSelectionInsideNode(content)) {
      ensureLoop(el, state);
      return;
    }

    const dt = state.lastTs ? Math.min(80, Math.max(8, ts - state.lastTs)) : 16;
    state.lastTs = ts;

    const remaining = state.units.length - state.visibleCount;
    if (remaining <= 0) {
      renderAssistantPlaybackContent(el, state.target, {
        math: state.finishing ? true : "stream",
        followCodeBlocks: true,
      });
      states.delete(el);
      if (activeEl === el) activeEl = null;
      return;
    }

    const cps = playbackCharsPerSecond(remaining, state.finishing);
    const exactStep = (cps * dt / 1000) + state.carry;
    const step = Math.max(1, Math.floor(exactStep));
    state.carry = exactStep - step;
    state.visibleCount = Math.min(state.units.length, state.visibleCount + step);

    const shouldRender = state.finishing
      || ts - state.lastRenderTs >= FRAME_RENDER_MS
      || state.visibleCount >= state.units.length;
    if (shouldRender) {
      const visible = state.units.slice(0, state.visibleCount).join("");
      renderAssistantPlaybackContent(el, visible, {
        math: state.finishing && state.visibleCount >= state.units.length ? true : "stream",
        followCodeBlocks: true,
      });
      state.lastRenderTs = ts;
    }

    if (state.visibleCount < state.units.length) {
      ensureLoop(el, state);
    } else {
      renderAssistantPlaybackContent(el, state.target, {
        math: state.finishing ? true : "stream",
        followCodeBlocks: true,
      });
      states.delete(el);
      if (activeEl === el) activeEl = null;
    }
  }

  function playbackCharsPerSecond(remaining: number, finishing: boolean) {
    if (finishing) return remaining > 600 ? 1600 : remaining > 180 ? 900 : 420;
    if (remaining > 900) return 900;
    if (remaining > 360) return 520;
    if (remaining > 120) return 260;
    return 72;
  }

  function splitGraphemes(text: unknown) {
    const source = String(text || "");
    if (!source) return [];
    if (!segmenter) return Array.from(source);
    return Array.from(segmenter.segment(source), item => item.segment);
  }

  return { setTarget, finish, cancel, cancelActive, hasState };
})();


function renderAssistantPlaybackContent(el: HTMLElement, text: unknown, { math = true, followCodeBlocks = false }: { math?: boolean | "stream"; followCodeBlocks?: boolean } = {}) {
  const content = el.querySelector<HTMLElement>(".msg-content");
  if (!content) return;
  if (hasActiveSelectionInsideNode(content)) return;
  const shouldStick = scroll.shouldFollowTail();
  const next = String(text || "");
  const markdownMode = math === "stream" ? "stream" : "complete";
  if (el.dataset.content !== next || (el.dataset.markdownMode || "complete") !== markdownMode) {
    const codeBlockScrollState = captureMarkdownCodeBlockScrollState(content);
    setAssistantFailureClass(el, next);
    patchHtmlContent(content, renderAssistantContentHtml(next, {
      math,
      highlightScope: assistantHighlightScope(el),
    }), {
      preserveSubtree: preserveRenderedMathSubtree,
      beforeReplace: mathRenderer.clearRemovedNode,
      beforeRemove: mathRenderer.clearRemovedNode,
    });
    restoreMarkdownCodeBlockScrollState(content, codeBlockScrollState, {
      followNewBlocks: followCodeBlocks,
    });
    el.dataset.content = next;
    el.dataset.markdownMode = markdownMode;
    if (math && !isAssistantFailureText(next)) mathRenderer.schedule(content);
  }
  if (shouldStick) scroll.scrollToBottom({ immediate: true, instant: true, force: true });
}

function assistantHighlightScope(el: HTMLElement) {
  let scope = assistantHighlightScopes.get(el);
  if (!scope) {
    scope = {};
    assistantHighlightScopes.set(el, scope);
  }
  return scope;
}

function preserveRenderedMathSubtree(current: Element, next: Element) {
  if (!(current instanceof Element) || !(next instanceof Element)) return false;
  if (!current.classList.contains("math-formula") || !next.classList.contains("math-formula")) return false;
  const key = current.getAttribute("data-math-key") || "";
  return Boolean(key && key === next.getAttribute("data-math-key") && (
    current.getAttribute("data-math-rendered") === "true" || current.getAttribute("data-math-rendering") === "true"
  ));
}

function captureMarkdownCodeBlockScrollState(root: HTMLElement | null) {
  return markdownCodeBlockScrollTargets(root).map((pre, index) => ({
    index,
    top: pre.scrollTop || 0,
    left: pre.scrollLeft || 0,
    followTail: shouldFollowTail(pre, { threshold: CODE_BLOCK_TAIL_RESUME_PX }),
  }));
}

function restoreMarkdownCodeBlockScrollState(root: HTMLElement | null, state: ReturnType<typeof captureMarkdownCodeBlockScrollState>, { followNewBlocks = false } = {}) {
  const targets = markdownCodeBlockScrollTargets(root);
  targets.forEach((pre, index) => {
    installMarkdownCodeBlockScrollTracker(pre);
    const item = state[index];
    const followTail = item ? item.followTail : Boolean(followNewBlocks);
    setFollowTail(pre, followTail);
    if (item) pre.scrollLeft = item.left;
    if (followTail) {
      scrollToTail(pre);
    } else if (item) {
      pre.scrollTop = Math.min(item.top, Math.max(0, pre.scrollHeight - pre.clientHeight));
    }
  });
}

function markdownCodeBlockScrollTargets(root: HTMLElement | null) {
  return Array.from(root?.querySelectorAll?.<HTMLElement>(".markdown-code-block > pre") || []);
}

function installMarkdownCodeBlockScrollTracker(pre: HTMLElement) {
  installTailTracker(pre, { threshold: CODE_BLOCK_TAIL_RESUME_PX });
}

function createToolTimelineGroupTranscriptElement(entry: TranscriptEntry, sessionId: unknown) {
  const tools = timelineGroupTools(entry);
  for (const tool of tools) updatePendingToolState(sessionId, tool);
  return createToolTimelineGroupElement(entry, toolPresentationOptions(sessionId, entry));
}

function patchToolTimelineGroupTranscriptElement(el: HTMLElement, entry: TranscriptEntry, sessionId: unknown) {
  const tools = timelineGroupTools(entry);
  for (const tool of tools) updatePendingToolState(sessionId, tool);
  return withToolTimelineViewportAnchor(el, () => (
    patchToolTimelineGroupElement(el, entry, toolPresentationOptions(sessionId, entry))
  ));
}

function withToolTimelineViewportAnchor<T>(el: HTMLElement, patch: () => T) {
  const details = el?.querySelector?.<HTMLElement>(":scope > .tool-timeline-details");
  const navigation = details?.querySelector?.<HTMLElement>(".tool-timeline-slot-nav");
  if (!navigation || !details || details.dataset.userToggled !== "true" || scroll.shouldFollowTail()) return patch();
  const anchor = scroll.captureAnchorForElement(navigation, {
    resolveElement: () => el.querySelector<HTMLElement>(".tool-timeline-slot-nav"),
  });
  try {
    return patch();
  } finally {
    if (anchor) scroll.restoreAnchor(anchor);
  }
}

function createToolTranscriptElement(entry: TranscriptEntry, sessionId: unknown) {
  return perfTrace("tool.createTranscriptElement", {
    sessionId,
    name: entry?.name || "",
    running: Boolean(entry?.isRunning),
  }, () => {
    const el = renderToolEvent(entry, toolPresentationOptions(sessionId, entry));
    if (entry.toolCallId) el.id = toolDomId(sessionId, entry);
    rememberToolTranscriptRenderState(el, entry);
    updatePendingToolState(sessionId, entry);
    return el;
  });
}

function patchToolTranscriptElement(el: HTMLElement, entry: TranscriptEntry, sessionId: unknown) {
  if (entry.toolCallId) el.id = toolDomId(sessionId, entry);
  updatePendingToolState(sessionId, entry);
  const meta = {
    sessionId,
    name: entry?.name || "",
    running: Boolean(entry?.isRunning),
  };
  const previousSignature = el.dataset.toolRenderSignature || "";
  const nextSignature = toolTranscriptRenderSignature(entry);
  const same = perfTrace("tool.patchTranscript.signature", meta, () => previousSignature === nextSignature);
  if (same) return true;
  const patched = perfTrace("tool.patchTranscript.patchEvent", meta, () => (
    patchToolEvent(el, entry, toolPresentationOptions(sessionId, entry))
  ));
  if (patched) rememberToolTranscriptRenderState(el, entry, nextSignature);
  return patched;
}

function rememberToolTranscriptRenderState(el: HTMLElement, entry: TranscriptEntry, signature = toolTranscriptRenderSignature(entry)) {
  if (!el) return;
  el.dataset.toolRenderSignature = signature;
}

function toolTranscriptRenderSignature(entry: TranscriptEntry = {}) {
  const payload = {
    rendererId: entry.rendererId || "",
    rendererRevision: toolRendererRegistry.revision,
    toolCallId: entry.toolCallId || "",
    runId: entry.runId || "",
    name: entry.name || "",
    capabilityId: entry.capabilityId || "",
    title: entry.title || "",
    familyId: entry.familyId || "",
    familyTitle: entry.familyTitle || "",
    args: entry.args ?? null,
    argsText: entry.argsText || "",
    argsIncomplete: Boolean(entry.argsIncomplete),
    phase: entry.phase || "",
    statusText: entry.statusText || "",
    rateLimit: entry.rateLimit ?? null,
    result: entry.result ?? null,
    isError: Boolean(entry.isError),
    isRunning: Boolean(entry.isRunning),
    image: entry.image ? hashText(entry.image) : "",
  };
  try {
    return hashText(JSON.stringify(payload));
  } catch(_e) {
    return hashText(String(entry.toolCallId || "") + String(entry.name || "") + String(entry.isRunning || ""));
  }
}

function updatePendingToolState(sessionId: unknown, entry: TranscriptEntry) {
  if (!entry.toolCallId) return;
  const key = scopedToolKey(sessionId, entry.toolCallId, entry.runId);
  if (!key) return;
  if (entry.isRunning) {
    pendingToolCalls.set(key, {
      name: entry.name || "tool",
      capabilityId: entry.capabilityId || "",
      title: entry.title || "",
      familyId: entry.familyId || "",
      familyTitle: entry.familyTitle || "",
      args: entry.args ?? {},
      argsText: entry.argsText || "",
      argsIncomplete: Boolean(entry.argsIncomplete),
      phase: entry.phase || (entry.argsIncomplete ? "preparing" : "running"),
      statusText: entry.statusText || "",
      rateLimit: entry.rateLimit || null,
    });
  } else {
    pendingToolCalls.delete(key);
  }
}

function toolPresentationOptions(sessionId: unknown, entry: TranscriptEntry) {
  const presentationState = toolPresentationState.resolve(sessionId, entry);
  return {
    presentationState,
    onPresentationChange: (patch: ToolPresentation) => toolPresentationState.update(sessionId, entry, patch),
  };
}

function createNoteTranscriptElement(entry: TranscriptEntry) {
  const div = document.createElement("div");
  div.className = "msg msg-tool msg-note";
  div.dataset.chatLane = "summary";
  div.innerHTML = `<div class="tool-badge note-badge"></div>`;
  div.querySelector<HTMLElement>(".note-badge")!.textContent = entry.text || "";
  return div;
}

function createCompactTranscriptElement(entry: TranscriptEntry) {
  const div = document.createElement("div");
  div.className = "msg msg-compact";
  div.dataset.chatLane = "detail";
  div.innerHTML = `
    <div class="compact-node">
      <div class="compact-node-head">
        <span class="compact-node-dot" aria-hidden="true"></span>
        <span class="compact-node-title"></span>
        <span class="compact-node-meta"></span>
      </div>
      <div class="compact-node-summary"></div>
    </div>
  `;
  patchCompactTranscriptElement(div, entry);
  return div;
}

function createRunStatusTranscriptElement(entry: TranscriptEntry) {
  const div = document.createElement("div");
  div.className = `msg msg-run-status msg-run-status-${escapeClassToken(entry.status || "state")}`;
  div.dataset.chatLane = "summary";
  div.innerHTML = `<div class="run-status-badge"></div>`;
  div.querySelector<HTMLElement>(".run-status-badge")!.textContent = entry.text || runStatusText(entry.status);
  return div;
}

function createErrorTranscriptElement(entry: TranscriptEntry) {
  const div = document.createElement("div");
  div.className = "msg msg-error";
  div.dataset.chatLane = "detail";
  div.innerHTML = `<div class="chat-error-card"></div>`;
  renderChatErrorCardInto(div.querySelector<HTMLElement>(".chat-error-card"), entry.text || "", { compact: true });
  return div;
}

function patchNoteTranscriptElement(el: HTMLElement, entry: TranscriptEntry) {
  el.classList.toggle("msg-note", true);
  el.dataset.chatLane = "summary";
  if (!patchTextOnlyTranscriptElement(el, ".note-badge, .tool-badge", entry.text || "")) return false;
  clearTranscriptInlineActions(el);
  return true;
}

function patchCompactTranscriptElement(el: HTMLElement, entry: TranscriptEntry) {
  el.dataset.chatLane = "detail";
  const node = el.querySelector<HTMLElement>(".compact-node");
  const title = el.querySelector<HTMLElement>(".compact-node-title");
  const meta = el.querySelector<HTMLElement>(".compact-node-meta");
  const summary = el.querySelector<HTMLElement>(".compact-node-summary");
  if (!node || !title || !meta || !summary) return false;
  const status = String(entry.status || "done");
  node.dataset.status = status;
  patchTextNode(title, compactNodeTitle(entry));
  patchTextNode(meta, compactNodeMeta(entry));
  patchCompactMarkdownSummary(summary, compactNodeSummary(entry));
  clearTranscriptInlineActions(el);
  return true;
}

function patchCompactMarkdownSummary(summaryEl: HTMLElement, markdown: string) {
  if (!summaryEl || hasActiveSelectionInsideNode(summaryEl)) return;
  const source = String(markdown || "");
  if (summaryEl.dataset.markdownSource === source) return;
  patchHtmlContent(summaryEl, renderMarkdown(source, { math: true }), {
    preserveSubtree: preserveRenderedMathSubtree,
    beforeReplace: mathRenderer.clearRemovedNode,
    beforeRemove: mathRenderer.clearRemovedNode,
  });
  summaryEl.dataset.markdownSource = source;
  mathRenderer.schedule(summaryEl);
}

function compactNodeTitle(entry: TranscriptEntry = {}) {
  const status = String(entry.status || "");
  if (status === "running") return t("compactingContext");
  if (status === "failed" || status === "error") return t("contextCompactFailed");
  if (status === "aborted") return t("contextCompactCancelled");
  return t("contextCompacted");
}

function compactNodeMeta(entry: TranscriptEntry = {}) {
  const before = Number(entry.inputTokensBefore || 0);
  const after = Number(entry.inputTokensAfter || 0);
  if (before > 0 && after > 0) return `${formatTokenCount(before)} -> ${formatTokenCount(after)}`;
  if (before > 0) return `${formatTokenCount(before)} tokens`;
  return "";
}

function compactNodeSummary(entry: TranscriptEntry = {}) {
  if (entry.status === "running") {
    return t("compactingHistory");
  }
  const summary = String(entry.summary || "").trim();
  if (summary) return summary;
  if (entry.status === "failed" || entry.status === "error") return t("compactionIncomplete");
  if (entry.status === "aborted") return t("compactionCancelledDetail");
  return t("historyCompacted");
}

function patchRunStatusTranscriptElement(el: HTMLElement, entry: TranscriptEntry) {
  el.className = `msg msg-run-status msg-run-status-${escapeClassToken(entry.status || "state")}`;
  el.dataset.chatLane = "summary";
  if (!patchTextOnlyTranscriptElement(el, ".run-status-badge", entry.text || runStatusText(entry.status))) return false;
  clearTranscriptInlineActions(el);
  return true;
}

function escapeClassToken(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "state";
}

function patchErrorTranscriptElement(el: HTMLElement, entry: TranscriptEntry) {
  el.className = "msg msg-error";
  el.dataset.chatLane = "detail";
  const card = el.querySelector<HTMLElement>(".chat-error-card");
  if (!card) return false;
  renderChatErrorCardInto(card, entry.text || "", { compact: true });
  clearTranscriptInlineActions(el);
  return true;
}

function clearTranscriptInlineActions(el: HTMLElement) {
  const existing = el.querySelector<HTMLElement>(":scope > .recovery-actions");
  if (existing) existing.remove();
  el.classList.remove("has-recovery-action");
}

function patchTextOnlyTranscriptElement(el: HTMLElement, selector: string, text: unknown) {
  const target = el.querySelector<HTMLElement>(selector);
  if (!target) return false;
  if (!hasActiveSelectionInsideNode(target)) patchTextNode(target, text);
  return true;
}

function patchTextNode(el: HTMLElement, text: unknown) {
  const next = String(text ?? "");
  if (el.textContent !== next) el.textContent = next;
}

function patchElementHtmlIfChanged(current: Element | null, next: Element | null) {
  if (!current || !next) return false;
  if (current.outerHTML === next.outerHTML) return true;
  current.replaceWith(next);
  return true;
}

function patchHtmlContent(el: HTMLElement, html: unknown, options: Parameters<typeof morphChildren>[2] = {}) {
  const next = String(html || "");
  if (el.innerHTML === next) return;
  const template = document.createElement("template");
  template.innerHTML = next;
  morphChildren(el, template.content, options);
}

function cssEscapeValue(value: unknown) {
  if (typeof window.CSS?.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function syncWaitingTranscriptFromRuntime(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id || getRunStatus() !== runStates.WAITING_USER || getActiveRunSessionId() !== id) {
    return false;
  }
  const runtime = getRuntime(id);
  if (!runtime.waitId) return false;
  return upsertWaitTranscriptEvent(id, {
    type: "wait",
    waitId: runtime.waitId,
    runId: runtime.runId,
    title: runtime.waitTitle,
    message: runtime.waitMessage || t("waitingForAction"),
    form: runtime.waitForm || null,
    status: "waiting",
    source: "runtime",
  });
}

function upsertWaitTranscriptEvent(sessionId: unknown, waitEntry: Partial<StoredEntry> & { source?: string } = {}) {
  const id = normalizeSessionId(sessionId);
  const waitId = String(waitEntry.waitId || "").trim();
  if (!id || !waitId) return false;
  let changed = false;
  mutateSessionTranscript(id, (history) => {
    const idx = findWaitTranscriptIndex(history, waitId, { includeResolved: true });
    const existing = idx >= 0 ? history[idx] : null;
    const next = {
      ...existing,
      type: "wait",
      waitId,
      runId: waitEntry.runId || existing?.runId || "",
      eventSeq: existing?.eventSeq ?? waitEntry.eventSeq,
      title: String(waitEntry.title || existing?.title || "").trim(),
      message: String(waitEntry.message || existing?.message || "").trim(),
      form: waitEntry.form ?? existing?.form ?? null,
      status: waitEntry.status || existing?.status || "waiting",
      reason: waitEntry.reason || existing?.reason || "",
      timestamp: existing?.timestamp || waitEntry.timestamp || nowTimestamp(),
      endedAt: waitEntry.endedAt || existing?.endedAt || "",
    };
    if (existing && sameWaitTranscriptEntry(existing, next)) return;
    if (idx >= 0) history[idx] = next;
    else history.push(next);
    changed = true;
  });
  return changed;
}

function findWaitTranscriptIndex(history: TranscriptEntry[] = [], waitId = "", { includeResolved = false, runId = "" } = {}) {
  const targetWaitId = String(waitId || "").trim();
  const targetRunId = String(runId || "").trim();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.type !== "wait") continue;
    if (targetWaitId && entry.waitId !== targetWaitId) continue;
    if (targetRunId && entry.runId !== targetRunId) continue;
    if (!includeResolved && !isWaitingTranscriptActive(entry)) continue;
    return i;
  }
  return -1;
}

function sameWaitTranscriptEntry(a: Partial<StoredEntry> = {}, b: Partial<StoredEntry> = {}) {
  return (a.waitId || "") === (b.waitId || "")
    && (a.runId || "") === (b.runId || "")
    && (a.eventSeq ?? "") === (b.eventSeq ?? "")
    && (a.title || "") === (b.title || "")
    && (a.message || "") === (b.message || "")
    && JSON.stringify(a.form || null) === JSON.stringify(b.form || null)
    && (a.status || "") === (b.status || "")
    && (a.reason || "") === (b.reason || "")
    && (a.timestamp || "") === (b.timestamp || "")
    && (a.endedAt || "") === (b.endedAt || "");
}

function seedCreatedSessionTranscript(session: Partial<SessionMetadata>, firstMessage: unknown) {
  const sessionId = normalizeSessionId(session?.id);
  const text = String(firstMessage || "").trim();
  if (!sessionId || !text || hasSessionTranscript(sessionId)) return;
  setSessionTranscript(sessionId, [{
    type: "user",
    text,
    images: [],
    timestamp: session.createdAt || nowTimestamp(),
  }]);
}

function mutateSessionTranscript(sessionId: unknown, mutate: (history: SessionEntry[]) => unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const history = sessionState.getTranscript(id);
  mutate(history);
  sessionState.replaceTranscript(id, history, { preserveLocal: false, assumeChanged: true });
  markSessionTranscriptChanged(id);
  return history;
}

function uiPush(entry: SessionEntry) {
  if (!getSessionId()) return;
  const stamped = stampTranscriptEvent(entry);
  mutateSessionTranscript(getSessionId(), history => history.push(stamped));
  scheduleTranscriptCacheRender(getSessionId(), { delay: 0 });
}

function renderCurrentTranscript({ intent = "" } = {}) {
  renderChatTranscript(getSessionId(), { force: true, intent });
}

function seedSessionTranscriptFromStorage(sessionId: unknown, incoming: SessionEntry[]) {
  const id = normalizeSessionId(sessionId);
  const next = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  if (!id || next.length === 0 || hasSessionTranscript(id)) return false;
  // Apply a status received before hydration to the full stored history as well.
  const settled = updateTranscriptWithAgentEvent(next, { type: "state", runtime: sessionState.getRuntime(id) });
  setSessionTranscript(id, settled.transcript);
  return true;
}

function applyRuntimeTranscriptSnapshot(sessionId: unknown, incoming: SessionEntry[], { preserveLocalState = true } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || !Array.isArray(incoming)) return false;
  const existing = sessionTranscript(id);
  const snapshot = incoming.filter(Boolean);
  const next = preserveLocalState
    ? mergeTranscriptSnapshotWithLocalState(existing, snapshot)
    : snapshot.map(entry => ({ ...entry }));
  if (
    preserveLocalState
    && existing.length > 0
    && transcriptCompletenessScore(next) <= transcriptCompletenessScore(existing)
  ) return false;
  if (sameTranscriptSnapshot(existing, next)) return false;
  setSessionTranscript(id, next);
  return true;
}

function transcriptCompletenessScore(history: TranscriptEntry[] = []) {
  return history.reduce((score, item) => {
    if (!item || typeof item !== "object") return score;
    const weight = item.type === "tool" ? 8
      : item.type === "assistant" ? 6
      : item.type === "thinking" ? 4
      : item.type === "user" ? 3
      : item.type === "run-status" ? 2
      : 1;
    const text = item.text ?? item.content ?? item.argsText ?? (item.result == null ? "" : JSON.stringify(item.result));
    const contentScore = Math.min(20, String(text || "").length / 300);
    const stateScore = item.streaming ? 0.5 : 1;
    return score + weight + contentScore + stateScore;
  }, 0);
}

function sameTranscriptSnapshot(left: TranscriptEntry[] = [], right: TranscriptEntry[] = []) {
  if (left.length !== right.length) return false;
  try {
    const omitUiKey = (key: string, value: unknown) => key === "_uiKey" ? undefined : value;
    return JSON.stringify(left, omitUiKey) === JSON.stringify(right, omitUiKey);
  } catch (_err) {
    return false;
  }
}

function maybeRenderUpdatedTranscript(sessionId: unknown, changed: boolean) {
  if (!changed || !isCurrentSession(sessionId)) return;
  renderChatTranscript(sessionId, { force: true });
}

function stampTranscriptEvent(entry: SessionEntry) {
  return {
    ...entry,
    clientMessageId: normalizeClientMessageIdValue(entry?.clientMessageId),
    deliveryStatus: normalizeDeliveryStatusValue(entry?.deliveryStatus),
    timestamp: entry?.timestamp || nowTimestamp(),
  };
}

function normalizeDeliveryStatusValue(value: unknown) {
  const status = String(value || "").trim();
  return ["pending", "accepted", "committed", "failed"].includes(status) ? status : "";
}

function findLastIndex<T>(items: T[], predicate: (item: T, index: number) => boolean) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

function appendUserMessage(text: string, images: TranscriptImage[] = [], clientMessageId = "", documents: MessageDocument[] = []) {
  scroll.setFollowing(true);
  extensions?.notify({ type: "ui_chat_submitted", sessionId: getSessionId(), clientMessageId });
  uiPush({
    type: "user",
    text,
    images,
    documents,
    clientMessageId: normalizeClientMessageIdValue(clientMessageId),
    deliveryStatus: "pending",
  });
}

function setUserMessageDeliveryStatus(sessionId: unknown, clientMessageId: unknown, deliveryStatus: unknown, { moveToTail = false } = {}) {
  const id = normalizeSessionId(sessionId);
  const messageId = normalizeClientMessageIdValue(clientMessageId);
  const status = normalizeDeliveryStatusValue(deliveryStatus);
  if (!id || !messageId || !status) return false;
  const history = sessionState.getTranscript(id);
  const index = history.findIndex(entry => (
    entry?.type === "user"
    && normalizeClientMessageIdValue(entry.clientMessageId) === messageId
  ));
  if (index < 0) return false;
  const [entry] = history.splice(index, 1);
  const next = { ...entry, deliveryStatus: status };
  if (moveToTail) history.push(next);
  else history.splice(index, 0, next);
  sessionState.replaceTranscript(id, history, { preserveLocal: false, assumeChanged: true });
  markSessionTranscriptChanged(id);
  if (isCurrentSession(id)) scheduleTranscriptCacheRender(id, { delay: 0 });
  return true;
}

function removePendingUserMessage(sessionId: unknown, clientMessageId: unknown) {
  const id = normalizeSessionId(sessionId);
  const messageId = normalizeClientMessageIdValue(clientMessageId);
  if (!id || !messageId) return false;
  const history = sessionState.getTranscript(id);
  const index = history.findIndex(entry => (
    entry?.type === "user"
    && normalizeDeliveryStatusValue(entry.deliveryStatus) === "pending"
    && normalizeClientMessageIdValue(entry.clientMessageId) === messageId
  ));
  if (index < 0) return false;
  history.splice(index, 1);
  sessionState.replaceTranscript(id, history, { preserveLocal: false, assumeChanged: true });
  markSessionTranscriptChanged(id);
  if (isCurrentSession(id)) scheduleTranscriptCacheRender(id, { delay: 0 });
  return true;
}

function renderUserImages(images: (TranscriptImage | string)[] = []) {
  if (!images.length) return "";
  return `<div class="msg-images">${images.map(img =>
    `<img src="${escapeHtml(typeof img === "string" ? img : img.dataUrl)}" alt="${escapeHtml(typeof img === "string" ? "image" : img.name || "image")}" title="${tHtml("clickToEnlarge")}">`
  ).join("")}</div>`;
}

function renderUserDocuments(documents: MessageDocument[] = []) {
  if (!documents.length) return "";
  return `<div class="msg-documents">${documents.map(document => `
    <div class="document-attachment-card qz:box-border qz:flex qz:h-13 qz:min-w-0 qz:items-stretch qz:overflow-hidden" title="${escapeHtml(document.filename || "document")}">
      <span class="document-attachment-type qz:grid qz:flex-[0_0_44px] qz:place-items-center" aria-hidden="true">${escapeHtml(documentTypeLabel(document))}</span>
      <span class="document-attachment-body qz:flex qz:min-w-0 qz:flex-auto qz:flex-col qz:justify-center qz:px-2 qz:py-0">
        <span class="document-attachment-name qz:block qz:min-w-0 qz:truncate">${escapeHtml(document.filename || "document")}</span>
        <span class="document-attachment-meta qz:block qz:min-w-0 qz:truncate">${tHtml("parsedFilename", { filename: formatDocumentSize(document.size) })}</span>
      </span>
    </div>
  `).join("")}</div>`;
}

function documentTypeLabel(document: Partial<MessageDocument> = {}) {
  const filename = String(document.filename || "");
  const extension = filename.includes(".") ? filename.split(".").pop() : document.format || "FILE";
  return String(extension || "FILE").toUpperCase().slice(0, 5);
}


function renderUserTextWithResourcePills(text: unknown) {
  const source = String(text || "");
  const tokens: { kind: string; start: number; end: number; raw?: string; selector?: string; name?: string }[] = findElementReferenceTokens(source);
  const sources = new Map(extensions?.referenceSources().map(source => [source.id, source]) || []);
  const pattern = /\[([a-z][a-z0-9_-]*):\s*([^\]]+?)\]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!sources.has(match[1])) continue;
    tokens.push({
      kind: match[1],
      name: match[2].trim(),
      start: match.index,
      end: pattern.lastIndex,
    });
  }
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);

  let lastIndex = 0;
  let html = "";
  for (const token of tokens) {
    if (token.start < lastIndex) continue;
    html += escapeHtml(source.slice(lastIndex, token.start)).replace(/\n/g, "<br>");
    if (token.kind === "element") {
      html += `<span class="resource-ref-pill element" title="${escapeHtml(token.raw)}">`
        + `<span class="resource-ref-kind">${tHtml("selectedElement")}</span>`
        + `<span class="element-ref-selector">${escapeHtml(truncateElementReferenceSelector(token.selector))}</span>`
        + "</span>";
    } else {
      const reference = sources.get(token.kind);
      const label = reference?.label || token.kind;
      const className = escapeHtml(reference?.className || token.kind);
      html += `<span class="resource-ref-pill ${className}">`
        + `<span class="resource-ref-kind">${label}</span>`
        + `<span class="resource-ref-name">${escapeHtml(token.name)}</span>`
        + "</span>";
    }
    lastIndex = token.end;
  }
  html += escapeHtml(source.slice(lastIndex)).replace(/\n/g, "<br>");
  return html;
}

function truncateElementReferenceSelector(value: unknown, maxLength = 5) {
  const units = Array.from(String(value || ""));
  return units.length > maxLength ? `${units.slice(0, maxLength).join("")}…` : units.join("");
}

function appendError(message: string) {
  if (!getSessionId()) {
    const div = document.createElement("div");
    div.className = "msg msg-assistant";
    div.innerHTML = `<div class="msg-content" style="border-color: rgba(224,108,117,0.3); color: var(--red);">${escapeHtml(message)}</div>`;
    messagesEl.appendChild(div);
    scroll.scrollToBottom();
    return;
  }
  uiPush({ type: "error", text: message });
}

function appendSystemNote(message: string) {
  if (!getSessionId()) {
    const div = document.createElement("div");
    div.className = "msg msg-tool";
    div.innerHTML = `<div class="tool-badge" style="color: var(--orange);">${escapeHtml(message)}</div>`;
    messagesEl.appendChild(div);
    scroll.scrollToBottom();
    return;
  }
  uiPush({ type: "note", text: message });
}

  function forgetSession(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    scheduler.cancel(id);
    waitingCards.forgetSession(id);
    if (isCurrentSession(id)) {
      messageActions.reset();
      storeReview.clear();
    }
    transcriptPartialRenderBySessionId.delete(id);
    clearSessionPendingToolState(id);
    transcriptLastChangedAtBySessionId.delete(id);
    toolPresentationState.forgetSession(id);
  }

  function resetUi() {
    assistantPlayback.cancelActive();
    scroll.cancelScheduledScroll();
    scroll.clearLatestIntent();
    scheduler.cancel();
    waitingCards.reset();
    messageActions.reset();
    transcriptPartialRenderBySessionId.clear();
    extensions?.notify({ type: "ui_close_transient" });
    scroll.setFollowing(true);
    disposeRendererTree(messagesEl);
    storeReview.clear();
    messagesEl.innerHTML = welcomeHTML;
    showWelcome();
    scroll.syncScrollPosition();
    applyBranding();
    if (contextUsageEl) contextUsageEl.textContent = "";
    pendingToolCalls.clear();
    renderDock();
    renderGoal();
  }

  function resetState() {
    assistantPlayback.cancelActive();
    scheduler.cancel();
    waitingCards.reset();
    messageActions.reset();
    storeReview.clear();
    transcriptPartialRenderBySessionId.clear();
    pendingToolCalls.clear();
    transcriptLastChangedAtBySessionId.clear();
    toolPresentationState.reset();
  }

  return {
    getTranscript: sessionTranscript,
    getCurrentTranscript: currentTranscript,
    hasTranscript: hasSessionTranscript,
    setTranscript: setSessionTranscript,
    markChanged: markSessionTranscriptChanged,
    lastChangedAt: (sessionId: unknown) => transcriptLastChangedAtBySessionId.get(normalizeSessionId(sessionId) || "") || 0,
    scheduleRender: scheduleTranscriptCacheRender,
    cancelRender: cancelTranscriptCacheRender,
    clearRenderSchedules: clearTranscriptCacheRenders,
    render: renderChatTranscript,
    clearPartial: clearPartialTranscriptRender,
    cancelBackfill: cancelTranscriptBackfill,
    hasPartial: (sessionId: unknown) => transcriptPartialRenderBySessionId.has(normalizeSessionId(sessionId) || ""),
    forgetSession,
    createElement: createTranscriptElement,
    handleUserMessageActionClick,
    handleUserMessageEditInput,
    handleUserMessageEditKeydown,
    armOutgoingEntry: composer.armOutgoingEntry,
    hideAssistantActions: hideAssistantMessageActions,
    flashAction: messageActions.flash,
    handleCodeBlockCopyClick: messageActions.handleCodeBlockCopyClick,
    cancelPlayback: assistantPlayback.cancelActive,
    hasPlaybackState: assistantPlayback.hasState,
    compactNodeTitle,
    compactNodeMeta,
    compactNodeSummary,
    clearInlineActions: clearTranscriptInlineActions,
    cssEscapeValue,
    syncWaiting: syncWaitingTranscriptFromRuntime,
    seedCreated: seedCreatedSessionTranscript,
    renderCurrent: renderCurrentTranscript,
    seedFromStorage: seedSessionTranscriptFromStorage,
    applyRuntimeSnapshot: applyRuntimeTranscriptSnapshot,
    maybeRenderUpdated: maybeRenderUpdatedTranscript,
    appendUserMessage,
    setUserMessageDeliveryStatus,
    removePendingUserMessage,
    appendError,
    appendSystemNote,
    resetUi,
    resetState,
  };
}

export function normalizeClientMessageIdValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

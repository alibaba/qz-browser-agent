import { optionalSessionId as normalizeSessionId } from "../sessions/session-id.js";
import type { TimelineElement } from "../../tools/tool-timeline-renderer.js";
type ElementResolver = () => Element | null;
interface ElementAnchor { anchorElement: Element; resolveElement: ElementResolver | null }
export interface ViewportAnchor extends ElementAnchor { top: number; scrollTop: number }
interface CenterAnchor extends ElementAnchor { pointRatio: number; viewportRatio: number; fallback: CenterAnchor | null }
interface ViewportLease {
  anchor: ViewportAnchor; frame: number; settling: boolean; stableFrames: number;
  lastTop: number | null; lastScrollHeight: number | null; startedAt: number;
}
interface ResizeLease { anchor: CenterAnchor; frame: number; lastWidthChangeAt: number }
interface DockTransaction { scrollTop: number; fallbackFrame: number }
interface AnchorOptions { resolveElement?: ElementResolver | null }
interface InteractionAnchor { element: Element | null; resolveElement?: ElementResolver | null }
interface ScrollOptions {
  messagesEl: HTMLElement; chatDock?: HTMLElement | null; isActive?(): boolean;
  findTranscriptElement?(key: string): HTMLElement | null;
}

import {
  canScrollInDirection,
  INNER_SCROLL_TARGET_SELECTOR,
  pauseDescendantTailTargets,
  resolveWheelScrollOwner,
  setFollowTail,
} from "../../ui/scroll-tail-controller.js";
import { timelineGroupTools } from "../../tools/tool-timeline-renderer.js";

const SESSION_SWITCH_SCROLL_INTENT_MS = 3000;
const CHAT_TAIL_RESUME_PX = 28;
const CHAT_SCROLL_INTENT_PX = 2;
const CHAT_TOUCH_SCROLL_INTENT_PX = 6;
const CHAT_PROGRAMMATIC_SCROLL_GRACE_MS = 180;
const CHAT_TAIL_SAFE_BOTTOM_PX = 18;
const CHAT_TAIL_LOCK_MS = 1200;
const CHAT_USER_SCROLL_IDLE_MS = 320;
const CHAT_SCROLLBAR_HIT_AREA_PX = 10;
const VIEWPORT_ANCHOR_STABLE_FRAMES = 3;
const VIEWPORT_ANCHOR_MIN_SETTLE_MS = 180;
const VIEWPORT_ANCHOR_MAX_SETTLE_MS = 900;
const VIEWPORT_RESIZE_WIDTH_EPSILON_PX = 0.5;
const VIEWPORT_RESIZE_SETTLE_MS = 140;

export function createChatScrollFeature(options: ScrollOptions) {
  const messagesEl = options.messagesEl;
  const chatDock = options.chatDock;
  const isActive = options.isActive || (() => false);
  const findTranscriptElement = options.findTranscriptElement || (() => null);
  if (!messagesEl) throw new Error("chat scroll messages element is required");

  let scrollToLatestSessionId: string | null = null;
  let scrollToLatestUntil = 0;
  let chatTailFollowing = true;
  let chatLastScrollTop = messagesEl.scrollTop || 0;
  let chatProgrammaticScroll: { top: number | null; expiresAt: number } | null = null;
  let chatTailLockUntil = 0;
  let chatUserScrollUntil = 0;
  let chatScrollbarPointerId: number | null = null;
  let chatTouchLastY: number | null = null;
  let chatTouchTarget: Element | null = null;
  let chatTailScrollFrame = 0;
  let pendingChatTailScroll: { instant: boolean; force: boolean; frames: number } | null = null;
  let viewportLease: ViewportLease | null = null;
  let viewportAnchorBeforePx = 0;
  let viewportAnchorAfterPx = 0;
  let dockLayoutTransaction: DockTransaction | null = null;
  let viewportCenterAnchor: CenterAnchor | null = null;
  let viewportCenterCaptureFrame = 0;
  let viewportResizeLease: ResizeLease | null = null;
  let observedMessagesWidth = messagesEl.getBoundingClientRect().width;

function updateChatTailSafeArea() {
  if (!messagesEl) return 0;
  messagesEl.style.setProperty("--chat-tail-safe-bottom", `${CHAT_TAIL_SAFE_BOTTOM_PX}px`);
  return CHAT_TAIL_SAFE_BOTTOM_PX;
}

function settleChatTailAfterDockLayout() {
  endDockLayoutTransaction();
  updateChatTailSafeArea();
  if (!shouldFollowChatTail()) return;
  scrollToBottom({ immediate: true, settle: true, instant: true, force: isChatTailLocked() });
}

function preserveViewportDuringDockLayout(update: () => void) {
  if (typeof update !== "function") return;
  const previousDockHeight = chatDock?.getBoundingClientRect?.().height ?? null;
  const previousMessagesHeight = messagesEl.getBoundingClientRect().height;
  const activeTransaction = dockLayoutTransaction;
  const previousScrollTop = activeTransaction?.scrollTop ?? (messagesEl.scrollTop || 0);
  update();
  const nextDockHeight = chatDock?.getBoundingClientRect?.().height ?? null;
  const nextMessagesHeight = messagesEl.getBoundingClientRect().height;
  const dockChanged = previousDockHeight !== null && nextDockHeight !== null && Number.isFinite(previousDockHeight)
    && Number.isFinite(nextDockHeight)
    && Math.abs(nextDockHeight - previousDockHeight) >= 0.5;
  const viewportChanged = Math.abs(nextMessagesHeight - previousMessagesHeight) >= 0.5;
  // `height: auto` can briefly enlarge the message viewport and clamp its
  // scrollTop even when the composer's final height is unchanged.
  const transientScrollChanged = Math.abs((messagesEl.scrollTop || 0) - previousScrollTop) >= 0.5;
  if (!dockChanged && !viewportChanged && !transientScrollChanged) return;
  cancelScheduledChatTailScroll();
  if (!dockChanged && !viewportChanged) {
    if (activeTransaction) restoreDockLayoutTransaction(activeTransaction);
    else restoreDockScrollTop(previousScrollTop);
    return;
  }
  const transaction = {
    scrollTop: previousScrollTop,
    fallbackFrame: 0,
  };
  endDockLayoutTransaction();
  dockLayoutTransaction = transaction;
  restoreDockLayoutTransaction(transaction);
  scheduleDockLayoutTransactionFallback(transaction);
}

function preserveViewportDuringContentLayout(update: () => void) {
  if (typeof update !== "function") return;
  const following = shouldFollowChatTail();
  const anchor = following ? null : (captureActiveViewportAnchor() || captureVisibleViewportAnchor());
  const fallbackScrollTop = messagesEl.scrollTop || 0;
  cancelScheduledChatTailScroll();
  update();

  const settle = () => {
    if (following) {
      scrollToBottom({ immediate: true, settle: false, instant: true });
    } else if (anchor) {
      restoreViewportAnchor(anchor);
    } else {
      restoreDockScrollTop(fallbackScrollTop);
    }
    syncScrollPosition();
  };
  settle();
  requestAnimationFrame(settle);
}

function restoreDockScrollTop(scrollTop: number) {
  const max = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  const nextTop = Math.max(0, Math.min(max, scrollTop));
  performProgrammaticChatScroll(() => {
    messagesEl.scrollTop = nextTop;
  });
  return messagesEl.scrollTop || 0;
}

function restoreDockLayoutTransaction(transaction = dockLayoutTransaction) {
  if (!transaction || dockLayoutTransaction !== transaction) return;
  transaction.scrollTop = restoreDockScrollTop(transaction.scrollTop);
}

function scheduleDockLayoutTransactionFallback(transaction: DockTransaction | null) {
  if (!transaction || dockLayoutTransaction !== transaction || transaction.fallbackFrame) return;
  transaction.fallbackFrame = requestAnimationFrame(() => {
    if (dockLayoutTransaction !== transaction) return;
    transaction.fallbackFrame = 0;
    restoreDockLayoutTransaction(transaction);
    endDockLayoutTransaction(transaction);
  });
}

function endDockLayoutTransaction(transaction = dockLayoutTransaction) {
  if (!transaction || dockLayoutTransaction !== transaction) return;
  if (transaction.fallbackFrame) cancelAnimationFrame(transaction.fallbackFrame);
  transaction.fallbackFrame = 0;
  dockLayoutTransaction = null;
}

function shouldFollowChatTail() {
  return chatTailFollowing || isChatTailLocked();
}

function setChatTailFollowing(following: boolean) {
  chatTailFollowing = Boolean(following);
  if (!chatTailFollowing) {
    chatTailLockUntil = 0;
    scheduleViewportCenterAnchorCapture();
    return;
  }
  releaseViewportResizeLease({ capture: false });
  cancelViewportCenterAnchorCapture();
  viewportCenterAnchor = null;
  releaseViewportLease();
}

function isChatTailLocked() {
  return Date.now() <= chatTailLockUntil;
}

function lockChatTailForSubmittedAction() {
  endDockLayoutTransaction();
  chatUserScrollUntil = 0;
  chatScrollbarPointerId = null;
  chatTailLockUntil = Date.now() + CHAT_TAIL_LOCK_MS;
  setChatTailFollowing(true);
  scrollToBottom({ immediate: true, settle: true, instant: true, force: true });
}

function handleViewportAnchorClick(event: MouseEvent) {
  const anchor = captureInteractionViewportAnchor(event.target);
  if (!anchor) return;
  setChatTailFollowing(false);
  cancelScheduledChatTailScroll();
  markChatUserScrollActive();
  acquireViewportLease(anchor);
  queueMicrotask(() => restoreViewportAnchor(anchor));
}

function scheduleViewportLeaseFrame(lease: ViewportLease | null) {
  if (!lease || lease.frame) return;
  lease.frame = requestAnimationFrame(() => {
    if (viewportLease !== lease) return;
    lease.frame = 0;
    maintainViewportLease();
  });
}

function cancelViewportLeaseFrame(lease: ViewportLease | null) {
  if (!lease?.frame) return;
  cancelAnimationFrame(lease.frame);
  lease.frame = 0;
}

function releaseViewportLease() {
  cancelViewportLeaseFrame(viewportLease);
  viewportLease = null;
  setViewportAnchorBeforeSpace(0);
  setViewportAnchorAfterSpace(0);
  chatLastScrollTop = messagesEl.scrollTop || 0;
}

function acquireViewportLease(anchor: ViewportAnchor) {
  releaseViewportLease();
  viewportLease = {
    anchor,
    frame: 0,
    settling: true,
    stableFrames: 0,
    lastTop: null,
    lastScrollHeight: null,
    startedAt: Date.now(),
  };
  scheduleViewportLeaseFrame(viewportLease);
}

function maintainViewportLease() {
  const lease = viewportLease;
  if (!lease?.settling) return;
  const anchorElement = resolveViewportAnchorElement(lease.anchor);
  const elapsed = Date.now() - lease.startedAt;
  if (!anchorElement || !messagesEl.contains(anchorElement)) {
    if (elapsed > VIEWPORT_ANCHOR_MAX_SETTLE_MS) releaseViewportLease();
    else scheduleViewportLeaseFrame(lease);
    return;
  }

  restoreViewportAnchor(lease.anchor);
  const top = anchorElement.getBoundingClientRect().top;
  const scrollHeight = messagesEl.scrollHeight;
  const stable = lease.lastTop !== null && lease.lastScrollHeight !== null && Number.isFinite(lease.lastTop)
    && Math.abs(top - lease.lastTop) < 0.5
    && Math.abs(scrollHeight - lease.lastScrollHeight) < 0.5;
  lease.stableFrames = stable ? lease.stableFrames + 1 : 0;
  lease.lastTop = top;
  lease.lastScrollHeight = scrollHeight;
  if (
    lease.stableFrames >= VIEWPORT_ANCHOR_STABLE_FRAMES
    && elapsed >= VIEWPORT_ANCHOR_MIN_SETTLE_MS
  ) {
    stopViewportLeaseSettling();
    return;
  }
  if (elapsed > VIEWPORT_ANCHOR_MAX_SETTLE_MS) stopViewportLeaseSettling();
  else scheduleViewportLeaseFrame(lease);
}

function stopViewportLeaseSettling() {
  const lease = viewportLease;
  cancelViewportLeaseFrame(lease);
  if (lease) lease.settling = false;
}

function captureActiveViewportAnchor() {
  const lease = viewportLease;
  if (!lease) return null;
  const element = resolveViewportAnchorElement(lease.anchor);
  if (!element || !messagesEl.contains(element)) {
    releaseViewportLease();
    return null;
  }
  const rect = element.getBoundingClientRect();
  const viewport = messagesEl.getBoundingClientRect();
  if (rect.bottom <= viewport.top + 2 || rect.top >= viewport.bottom - 2) {
    releaseViewportLease();
    return null;
  }
  return captureViewportAnchorForElement(element, {
    resolveElement: lease.anchor.resolveElement,
  });
}

function captureVisibleViewportAnchor() {
  const viewport = messagesEl.getBoundingClientRect();
  const element = Array.from(messagesEl.children).find(child => {
    if (!(child instanceof Element) || !child.getAttribute("data-transcript-key")) return false;
    const rect = child.getBoundingClientRect();
    return rect.bottom > viewport.top + 2 && rect.top < viewport.bottom - 2;
  });
  if (!element) return null;
  const transcriptKey = element.getAttribute("data-transcript-key") || "";
  return captureViewportAnchorForElement(element, {
    resolveElement: transcriptKey ? () => findTranscriptElement(transcriptKey) : null,
  });
}

function scheduleViewportCenterAnchorCapture() {
  if (viewportCenterCaptureFrame || viewportResizeLease || shouldFollowChatTail()) return;
  viewportCenterCaptureFrame = requestAnimationFrame(() => {
    viewportCenterCaptureFrame = 0;
    if (viewportResizeLease || shouldFollowChatTail() || !isActive()) return;
    viewportCenterAnchor = captureViewportCenterAnchor() || viewportCenterAnchor;
  });
}

function cancelViewportCenterAnchorCapture() {
  if (viewportCenterCaptureFrame) cancelAnimationFrame(viewportCenterCaptureFrame);
  viewportCenterCaptureFrame = 0;
}

function captureViewportCenterAnchor() {
  const viewport = messagesEl.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const centerX = viewport.left + (viewport.width / 2);
  const centerY = viewport.top + (viewport.height / 2);
  const hit = document.elementFromPoint(centerX, centerY);
  let anchorElement = hit instanceof Element && messagesEl.contains(hit) && hit !== messagesEl
    ? hit
    : null;
  while (anchorElement && anchorElement !== messagesEl) {
    const rect = anchorElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) break;
    anchorElement = anchorElement.parentElement;
  }
  if (!anchorElement || anchorElement === messagesEl) {
    anchorElement = Array.from(messagesEl.children)
      .filter(child => child instanceof Element && child.getAttribute("data-transcript-key"))
      .map(child => ({ child, rect: child.getBoundingClientRect() }))
      .filter(item => item.rect.width > 0 && item.rect.height > 0)
      .sort((left, right) => (
        Math.abs(((left.rect.top + left.rect.bottom) / 2) - centerY)
        - Math.abs(((right.rect.top + right.rect.bottom) / 2) - centerY)
      ))[0]?.child || null;
  }
  if (!anchorElement) return null;
  const transcriptRoot = anchorElement.closest<HTMLElement>("[data-transcript-key]");
  const transcriptKey = transcriptRoot?.dataset.transcriptKey || "";
  const fallback = transcriptRoot && transcriptRoot !== anchorElement
    ? captureViewportCenterAnchorForElement(transcriptRoot, centerY, {
        resolveElement: transcriptKey ? () => findTranscriptElement(transcriptKey) : null,
      })
    : null;
  return captureViewportCenterAnchorForElement(anchorElement, centerY, { fallback });
}

function captureViewportCenterAnchorForElement(anchorElement: Element, centerY: number, options: AnchorOptions & { fallback?: CenterAnchor | null } = {}): CenterAnchor | null {
  const rect = anchorElement?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    anchorElement,
    pointRatio: Math.max(0, Math.min(1, (centerY - rect.top) / rect.height)),
    viewportRatio: 0.5,
    resolveElement: typeof options.resolveElement === "function" ? options.resolveElement : null,
    fallback: options.fallback || null,
  };
}

function restoreViewportCenterAnchor(anchor: CenterAnchor | null): boolean {
  const anchorElement = resolveViewportAnchorElement(anchor);
  if (!anchor || !anchorElement || !messagesEl.contains(anchorElement)) {
    return anchor?.fallback ? restoreViewportCenterAnchor(anchor.fallback) : false;
  }
  const rect = anchorElement.getBoundingClientRect();
  const viewport = messagesEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || viewport.height <= 0) {
    return anchor?.fallback ? restoreViewportCenterAnchor(anchor.fallback) : false;
  }
  const pointY = rect.top + (rect.height * Math.max(0, Math.min(1, Number(anchor.pointRatio) || 0)));
  const targetY = viewport.top + (viewport.height * Math.max(0, Math.min(1, Number(anchor.viewportRatio) || 0.5)));
  const currentTop = messagesEl.scrollTop || 0;
  const rawNextTop = currentTop + (pointY - targetY);
  if (Math.abs(rawNextTop - currentTop) < 0.5) return true;
  const nextTop = Math.max(0, Math.min(naturalChatMaxScrollTop(), rawNextTop));
  performProgrammaticChatScroll(() => {
    messagesEl.scrollTop = nextTop;
  });
  return true;
}

function beginViewportResizeLease() {
  const anchor = viewportResizeLease?.anchor || viewportCenterAnchor || captureViewportCenterAnchor();
  if (!anchor) return false;
  if (viewportLease) releaseViewportLease();
  if (naturalChatMaxScrollTop() < CHAT_SCROLL_INTENT_PX) return false;
  cancelViewportCenterAnchorCapture();
  if (!viewportResizeLease) {
    viewportResizeLease = {
      anchor,
      frame: 0,
      lastWidthChangeAt: Date.now(),
    };
  } else {
    viewportResizeLease.lastWidthChangeAt = Date.now();
  }
  cancelScheduledChatTailScroll();
  restoreViewportCenterAnchor(viewportResizeLease.anchor);
  scheduleViewportResizeLeaseFrame(viewportResizeLease);
  return true;
}

function naturalChatMaxScrollTop() {
  const naturalScrollHeight = Math.max(
    0,
    messagesEl.scrollHeight - viewportAnchorBeforePx - viewportAnchorAfterPx,
  );
  return Math.max(0, naturalScrollHeight - messagesEl.clientHeight);
}

function scheduleViewportResizeLeaseFrame(lease: ResizeLease | null) {
  if (!lease || viewportResizeLease !== lease || lease.frame) return;
  lease.frame = requestAnimationFrame(() => {
    if (viewportResizeLease !== lease) return;
    lease.frame = 0;
    maintainViewportResizeLease();
  });
}

function maintainViewportResizeLease() {
  const lease = viewportResizeLease;
  if (!lease) return;
  restoreViewportCenterAnchor(lease.anchor);
  if (Date.now() - lease.lastWidthChangeAt >= VIEWPORT_RESIZE_SETTLE_MS) {
    releaseViewportResizeLease();
    return;
  }
  scheduleViewportResizeLeaseFrame(lease);
}

function releaseViewportResizeLease({ capture = true } = {}) {
  const lease = viewportResizeLease;
  if (lease?.frame) cancelAnimationFrame(lease.frame);
  if (capture && lease?.anchor && !shouldFollowChatTail()) {
    restoreViewportCenterAnchor(lease.anchor);
  }
  viewportResizeLease = null;
  if (capture && !shouldFollowChatTail()) {
    viewportCenterAnchor = captureViewportCenterAnchor() || viewportCenterAnchor;
    scheduleViewportCenterAnchorCapture();
  }
}

function setViewportAnchorBeforeSpace(value: number) {
  const next = Math.max(0, Number(value) || 0);
  if (Math.abs(next - viewportAnchorBeforePx) < 0.01) return;
  viewportAnchorBeforePx = next;
  if (next > 0) messagesEl.style.setProperty("--viewport-anchor-before-space", `${next}px`);
  else messagesEl.style.removeProperty("--viewport-anchor-before-space");
}

function setViewportAnchorAfterSpace(value: number) {
  const next = Math.max(0, Math.ceil(Number(value) || 0));
  if (next === viewportAnchorAfterPx) return;
  viewportAnchorAfterPx = next;
  if (next > 0) messagesEl.style.setProperty("--viewport-anchor-after-space", `${next}px`);
  else messagesEl.style.removeProperty("--viewport-anchor-after-space");
}

function collectViewportAnchorState() {
  const lease = viewportLease;
  const anchorElement = resolveViewportAnchorElement(lease?.anchor);
  const rect = anchorElement?.getBoundingClientRect?.();
  return {
    active: Boolean(lease),
    connected: Boolean(anchorElement && messagesEl.contains(anchorElement)),
    targetTop: lease && Number.isFinite(lease.anchor.top) ? lease.anchor.top : null,
    actualTop: rect && Number.isFinite(rect.top) ? rect.top : null,
    settling: Boolean(lease?.settling),
    frameScheduled: Boolean(lease?.frame),
    beforeSpacePx: viewportAnchorBeforePx,
    afterSpacePx: viewportAnchorAfterPx,
    resizeAnchored: Boolean(viewportResizeLease),
  };
}

function captureInteractionViewportAnchor(target: EventTarget | null) {
  const targetEl = target instanceof Element ? target : null;
  if (!targetEl) return null;
  const anchor = resolveInteractionViewportAnchor(targetEl);
  const anchorElement = anchor?.element;
  if (!anchorElement) return null;
  return captureViewportAnchorForElement(anchorElement, {
    resolveElement: anchor?.resolveElement,
  });
}

function captureViewportAnchorForElement(anchorElement: Element, options: AnchorOptions = {}): ViewportAnchor | null {
  const rect = anchorElement.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return null;
  return {
    anchorElement,
    top: rect.top,
    scrollTop: messagesEl.scrollTop || 0,
    resolveElement: typeof options.resolveElement === "function" ? options.resolveElement : null,
  };
}

function resolveInteractionViewportAnchor(target: Element): InteractionAnchor | null {
  const userEditControl = target.closest?.([
    ".msg-user [data-action='edit-user-message']",
    ".msg-user .msg-user-edit-shell",
  ].join(", "));
  if (userEditControl && messagesEl.contains(userEditControl)) {
    const message = userEditControl.closest<HTMLElement>(".msg-user");
    const transcriptKey = message?.dataset.transcriptKey || "";
    return {
      element: message,
      resolveElement: transcriptKey ? () => findTranscriptElement(transcriptKey) : null,
    };
  }

  const timelineNavigation = target.closest?.(".tool-timeline-slot-nav");
  if (timelineNavigation && messagesEl.contains(timelineNavigation)) {
    const card = timelineNavigation.closest<TimelineElement>(".msg-tool-timeline");
    if (card) {
      const transcriptKey = card.dataset.transcriptKey || "";
      const activeToolKey = card.querySelector<HTMLElement>(":scope > .tool-timeline-details")?.dataset.activeToolKey || "";
      return {
        element: timelineNavigation,
        resolveElement: () => {
          let liveCard = transcriptKey ? findTranscriptElement(transcriptKey) : card;
          if (!liveCard && activeToolKey) {
            liveCard = Array.from(messagesEl.querySelectorAll<TimelineElement>(".msg-tool-timeline")).find(candidate => (
              timelineGroupTools(candidate.__toolTimelineGroupEntry).some(tool => (
                String(tool?._uiKey || tool?.toolCallId || "") === activeToolKey
              ))
            )) || null;
          }
          return liveCard?.querySelector(".tool-timeline-slot-nav") || null;
        },
      };
    }
  }

  const timelineControl = target.closest?.([
    ".tool-timeline-step",
    ".tool-family-row",
    ".tool-family-batch",
  ].join(", "));
  if (timelineControl && messagesEl.contains(timelineControl)) {
    const card = timelineControl.closest<TimelineElement>(".msg-tool-timeline");
    const navArea = card?.querySelector?.(":scope > .tool-timeline-details .tool-timeline-nav-area");
    if (navArea && messagesEl.contains(navArea)) return { element: navArea };
    const timelineSummary = card?.querySelector?.(":scope > .tool-timeline-summary");
    if (timelineSummary && messagesEl.contains(timelineSummary)) return { element: timelineSummary };
  }

  const summary = target.closest?.([
    ".msg-tool > .tool-summary",
    ".msg-tool-timeline > .tool-timeline-summary",
    ".msg-thinking-group > .thinking-group-summary",
  ].join(", "));
  if (summary && messagesEl.contains(summary)) {
    const card = summary.closest<HTMLElement>("[data-transcript-key]");
    const transcriptKey = card?.dataset.transcriptKey || "";
    const summarySelector = summary.classList.contains("tool-timeline-summary")
      ? ":scope > .tool-timeline-summary"
      : summary.classList.contains("thinking-group-summary")
        ? ":scope > .thinking-group-summary"
        : ":scope > .tool-summary";
    return {
      element: summary,
      resolveElement: transcriptKey
        ? () => findTranscriptElement(transcriptKey)?.querySelector?.(summarySelector) || null
        : null,
    };
  }

  const collapseButton = target.closest?.(".tool-event-collapse-btn, .tool-timeline-collapse-btn");
  if (!collapseButton || !messagesEl.contains(collapseButton)) return null;
  const card = collapseButton.closest(".msg-tool, .msg-tool-timeline, .msg-thinking-group");
  return { element: card?.querySelector?.(":scope > .tool-summary, :scope > .tool-timeline-summary, :scope > .thinking-group-summary") || null };
}

function resolveViewportAnchorElement(anchor: ElementAnchor | null | undefined) {
  const resolvedElement = typeof anchor?.resolveElement === "function" ? anchor.resolveElement() : null;
  return resolvedElement || anchor?.anchorElement || null;
}

function restoreViewportAnchor(anchor: ViewportAnchor | null | undefined) {
  const anchorElement = resolveViewportAnchorElement(anchor);
  if (!anchor || !anchorElement || !messagesEl.contains(anchorElement)) return;
  const nextRect = anchorElement.getBoundingClientRect();
  if (nextRect.height <= 0 || nextRect.width <= 0) return;
  // A collapsed transcript that fits should return to normal flow. Keeping a
  // formerly sticky summary pinned would hide earlier messages behind a spacer.
  if (naturalChatMaxScrollTop() < 0.5) {
    setViewportAnchorBeforeSpace(0);
    setViewportAnchorAfterSpace(0);
    performProgrammaticChatScroll(() => { messagesEl.scrollTop = 0; });
    anchor.top = anchorElement.getBoundingClientRect().top;
    anchor.scrollTop = 0;
    return;
  }
  const currentTop = messagesEl.scrollTop || 0;
  const expectedScrollTop = Math.max(0, Number(anchor.scrollTop) || 0);
  let elementDelta = nextRect.top - anchor.top;
  let rawNextTop = Math.abs(elementDelta) < 0.5
    ? expectedScrollTop
    : currentTop + elementDelta;
  if (Math.abs(rawNextTop - currentTop) < 0.5) return;
  if (rawNextTop < 0) {
    setViewportAnchorBeforeSpace(viewportAnchorBeforePx - rawNextTop);
    elementDelta = anchorElement.getBoundingClientRect().top - anchor.top;
    rawNextTop = currentTop + elementDelta;
  }
  const nextTop = Math.max(0, rawNextTop);
  ensureViewportAnchorScrollRange(nextTop);
  performProgrammaticChatScroll(() => {
    messagesEl.scrollTop = nextTop;
  });
  anchor.scrollTop = messagesEl.scrollTop || 0;
}

function ensureViewportAnchorScrollRange(nextTop: number) {
  const baseScrollHeight = Math.max(0, messagesEl.scrollHeight - viewportAnchorAfterPx);
  const baseMaxTop = Math.max(0, baseScrollHeight - messagesEl.clientHeight);
  const required = Math.max(0, nextTop - baseMaxTop + 1);
  setViewportAnchorAfterSpace(required);
  const actualMaxTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  const missing = nextTop - actualMaxTop;
  if (missing > 0.5) {
    setViewportAnchorAfterSpace(Math.max(
      viewportAnchorAfterPx + missing + 1,
      messagesEl.clientHeight,
    ));
  }
}

function installChatTailLayoutObservers() {
  updateChatTailSafeArea();
  if (typeof ResizeObserver !== "function") return;
  const observer = new ResizeObserver(entries => {
    if (!isActive()) return;
    const nextMessagesWidth = messagesEl.getBoundingClientRect().width;
    const messagesWidthChanged = Math.abs(nextMessagesWidth - observedMessagesWidth) >= VIEWPORT_RESIZE_WIDTH_EPSILON_PX;
    observedMessagesWidth = nextMessagesWidth;
    if (messagesWidthChanged && !shouldFollowChatTail() && beginViewportResizeLease()) return;
    if (viewportResizeLease) {
      restoreViewportCenterAnchor(viewportResizeLease.anchor);
      scheduleViewportResizeLeaseFrame(viewportResizeLease);
      return;
    }
    if (dockLayoutTransaction) {
      const transaction = dockLayoutTransaction;
      const transcriptChanged = entries.some(entry => (
        entry.target !== chatDock && entry.target !== messagesEl
      ));
      if (!transcriptChanged) {
        restoreDockLayoutTransaction(transaction);
        endDockLayoutTransaction(transaction);
        return;
      }
      endDockLayoutTransaction(transaction);
    }
    if (viewportLease?.settling) {
      restoreViewportAnchor(viewportLease.anchor);
      scheduleViewportLeaseFrame(viewportLease);
      return;
    }
    if (!shouldFollowChatTail()) {
      scheduleViewportCenterAnchorCapture();
      return;
    }
    scrollToBottom({ immediate: true, settle: true, instant: true, force: isChatTailLocked() });
  });
  if (chatDock) observer.observe(chatDock);
  observer.observe(messagesEl);
  for (const child of messagesEl.children) observer.observe(child);

  if (typeof MutationObserver !== "function") return;
  const childObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node instanceof Element) observer.unobserve(node);
      }
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.parentElement === messagesEl) observer.observe(node);
      }
    }
  });
  childObserver.observe(messagesEl, { childList: true });
}

function chatBottomDistance(el = messagesEl) {
  if (!el) return 0;
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

function isScrolledNearBottom(el: HTMLElement, threshold = CHAT_TAIL_RESUME_PX) {
  return chatBottomDistance(el) <= threshold;
}

function performProgrammaticChatScroll(update: () => void) {
  chatProgrammaticScroll = { top: null, expiresAt: Date.now() + CHAT_PROGRAMMATIC_SCROLL_GRACE_MS };
  update();
  syncScrollPosition();
}

function consumeExpectedProgrammaticChatScroll(top: number) {
  const expected = chatProgrammaticScroll;
  chatProgrammaticScroll = null;
  return Boolean(
    expected
    && Date.now() <= expected.expiresAt
    && expected.top !== null && Number.isFinite(expected.top)
    && Math.abs(top - expected.top) < CHAT_SCROLL_INTENT_PX
  );
}

function markChatUserScrollActive() {
  chatUserScrollUntil = Date.now() + CHAT_USER_SCROLL_IDLE_MS;
}

function isChatUserScrolling() {
  return Date.now() < chatUserScrollUntil;
}

function beginChatUserScroll() {
  endDockLayoutTransaction();
  chatProgrammaticScroll = null;
  releaseViewportResizeLease({ capture: false });
  releaseViewportLease();
  chatLastScrollTop = messagesEl.scrollTop || 0;
  markChatUserScrollActive();
}

function hasExplicitChatScrollIntent() {
  return chatScrollbarPointerId !== null || isChatUserScrolling();
}

function handleMessagesPointerDown(event: PointerEvent) {
  if (!isActive() || event.button !== 0 || event.pointerType === "touch") return;
  if (messagesEl.scrollHeight <= messagesEl.clientHeight + CHAT_SCROLL_INTENT_PX) return;
  const rect = messagesEl.getBoundingClientRect();
  const nativeScrollbarWidth = Math.max(0, messagesEl.offsetWidth - messagesEl.clientWidth);
  const hitArea = Math.max(CHAT_SCROLLBAR_HIT_AREA_PX, nativeScrollbarWidth + 4);
  if (event.clientX < rect.right - hitArea || event.clientX > rect.right) return;
  chatScrollbarPointerId = event.pointerId;
  beginChatUserScroll();
}

function handleScrollbarPointerEnd(event: PointerEvent) {
  if (chatScrollbarPointerId === null || event.pointerId !== chatScrollbarPointerId) return;
  chatScrollbarPointerId = null;
  markChatUserScrollActive();
}

function handleMessagesScroll() {
  if (dockLayoutTransaction) {
    restoreDockLayoutTransaction();
    return;
  }
  const top = messagesEl.scrollTop || 0;
  const delta = top - chatLastScrollTop;
  chatLastScrollTop = top;

  if (consumeExpectedProgrammaticChatScroll(top)) return;
  if (Math.abs(delta) < CHAT_SCROLL_INTENT_PX) return;
  if (!hasExplicitChatScrollIntent()) {
    if (shouldFollowChatTail()) {
      scrollToBottom({ immediate: true, settle: true, instant: true, force: isChatTailLocked() });
    }
    return;
  }
  beginChatUserScroll();

  if (delta < 0) {
    setChatTailFollowing(false);
    return;
  }
  if (isScrolledNearBottom(messagesEl)) setChatTailFollowing(true);
}

function handleMessagesWheel(event: WheelEvent) {
  if (!isActive()) return;
  const delta = Number(event.deltaY) || 0;
  if (Math.abs(delta) < CHAT_SCROLL_INTENT_PX) return;
  const wheelOwner = resolveWheelScrollOwner(event.target, delta, {
    boundary: messagesEl,
    innerSelector: INNER_SCROLL_TARGET_SELECTOR,
  });
  if (wheelOwner.ownerIsInner) {
    markChatUserScrollActive();
    if (delta < 0) {
      if (wheelOwner.owner instanceof HTMLElement) setFollowTail(wheelOwner.owner, false);
      setChatTailFollowing(false);
    }
    return;
  }
  beginChatUserScroll();
  if (wheelOwner.innerCandidate && handOffWheelFromInnerBoundary(delta)) event.preventDefault();
  if (delta < 0) pauseInnerTailTargetsForOuterHistoryScroll(event.target);
  handleChatScrollIntent(delta < 0 ? "up" : "down");
}

function handOffWheelFromInnerBoundary(delta: number) {
  if (!canScrollInDirection(messagesEl, delta, 0)) return false;
  const current = messagesEl.scrollTop || 0;
  const max = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
  const next = Math.max(0, Math.min(max, current + delta));
  if (Math.abs(next - current) < 0.5) return false;
  messagesEl.scrollTop = next;
  chatLastScrollTop = messagesEl.scrollTop || 0;
  return true;
}

function pauseInnerTailTargetsForOuterHistoryScroll(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  const scope = el?.closest?.(".msg-tool, .msg-tool-timeline, .msg-thinking-group, .msg-assistant") || messagesEl;
  pauseDescendantTailTargets(scope, { selector: INNER_SCROLL_TARGET_SELECTOR });
}

function handleMessagesTouchStart(event: TouchEvent) {
  chatTouchLastY = event.touches?.[0]?.clientY ?? null;
  chatTouchTarget = event.target instanceof Element ? event.target : null;
}

function handleMessagesTouchMove(event: TouchEvent) {
  if (!isActive()) return;
  const y = event.touches?.[0]?.clientY;
  if (typeof y !== "number" || chatTouchLastY === null || !Number.isFinite(y) || !Number.isFinite(chatTouchLastY)) {
    chatTouchLastY = typeof y === "number" && Number.isFinite(y) ? y : null;
    return;
  }
  const delta = y - chatTouchLastY;
  chatTouchLastY = y;
  if (Math.abs(delta) < CHAT_TOUCH_SCROLL_INTENT_PX) return;
  const scrollDelta = -delta;
  const touchOwner = resolveWheelScrollOwner(chatTouchTarget, scrollDelta, {
    boundary: messagesEl,
    innerSelector: INNER_SCROLL_TARGET_SELECTOR,
  });
  if (touchOwner.ownerIsInner) {
    markChatUserScrollActive();
    if (scrollDelta < 0) {
      if (touchOwner.owner instanceof HTMLElement) setFollowTail(touchOwner.owner, false);
      setChatTailFollowing(false);
    }
    return;
  }
  beginChatUserScroll();
  handleChatScrollIntent(delta > 0 ? "up" : "down");
}

function handleMessagesTouchEnd() {
  chatTouchLastY = null;
  chatTouchTarget = null;
}

function handleChatScrollKeydown(event: KeyboardEvent) {
  if (!isActive() || isEditableEventTarget(event.target)) return;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;
  if (key === "ArrowUp" || key === "PageUp" || key === "Home" || (key === " " && event.shiftKey)) {
    beginChatUserScroll();
    handleChatScrollIntent("up");
  } else if (key === "ArrowDown" || key === "PageDown" || key === "End" || key === " ") {
    beginChatUserScroll();
    handleChatScrollIntent("down");
  }
}

function handleChatScrollIntent(direction: "up" | "down") {
  if (direction === "up") {
    if (canScrollChatHistory()) setChatTailFollowing(false);
    return;
  }
  if (direction === "down" && isScrolledNearBottom(messagesEl)) {
    setChatTailFollowing(true);
  }
}

function canScrollChatHistory() {
  return messagesEl.scrollHeight > messagesEl.clientHeight + CHAT_SCROLL_INTENT_PX;
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function requestScrollToLatest(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  scrollToLatestSessionId = id;
  scrollToLatestUntil = Date.now() + SESSION_SWITCH_SCROLL_INTENT_MS;
}

function hasActiveScrollToLatestIntent(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  return Boolean(id && id === scrollToLatestSessionId && Date.now() <= scrollToLatestUntil);
}

function clearScrollToLatestIntent(sessionId: unknown = null) {
  const id = normalizeSessionId(sessionId);
  if (!id || id === scrollToLatestSessionId) {
    scrollToLatestSessionId = null;
    scrollToLatestUntil = 0;
  }
}

function consumeScrollToLatestIntent(sessionId: unknown, history: readonly unknown[]) {
  const id = normalizeSessionId(sessionId);
  if (!id || id !== scrollToLatestSessionId) return;
  if (Date.now() > scrollToLatestUntil) {
    clearScrollToLatestIntent(id);
    return;
  }
  if (!isActive()) return;
  if (!Array.isArray(history) || history.length === 0) return;
  setChatTailFollowing(true);
  scrollToBottom({ immediate: true, settle: true, instant: true });
  clearScrollToLatestIntent(id);
}

function withInstantMessageScroll(fn: () => void) {
  const previous = messagesEl.style.scrollBehavior;
  messagesEl.style.scrollBehavior = "auto";
  try {
    fn();
  } finally {
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = previous;
    });
  }
}

function applyChatTailScroll({ instant = false, force = false } = {}) {
  const apply = () => {
    if (!force && !shouldFollowChatTail()) return;
    updateChatTailSafeArea();
    performProgrammaticChatScroll(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  };
  if (instant) withInstantMessageScroll(apply);
  else apply();
}

function scheduleChatTailScroll(options: { instant?: boolean; force?: boolean }, frames = 1) {
  const nextFrames = Math.max(1, Math.round(Number(frames) || 1));
  pendingChatTailScroll = {
    instant: Boolean(options?.instant || pendingChatTailScroll?.instant),
    force: Boolean(options?.force || pendingChatTailScroll?.force),
    frames: Math.max(nextFrames, pendingChatTailScroll?.frames || 0),
  };
  if (!chatTailScrollFrame) chatTailScrollFrame = requestAnimationFrame(flushScheduledChatTailScroll);
}

function flushScheduledChatTailScroll() {
  chatTailScrollFrame = 0;
  const state = pendingChatTailScroll;
  if (!state) return;
  applyChatTailScroll(state);
  state.frames -= 1;
  if (state.frames > 0) chatTailScrollFrame = requestAnimationFrame(flushScheduledChatTailScroll);
  else pendingChatTailScroll = null;
}

function cancelScheduledChatTailScroll() {
  if (chatTailScrollFrame) cancelAnimationFrame(chatTailScrollFrame);
  chatTailScrollFrame = 0;
  pendingChatTailScroll = null;
}

function scrollToBottom({ immediate = false, settle = false, instant = false, force = false } = {}) {
  endDockLayoutTransaction();
  const options = { instant, force };
  if (immediate) applyChatTailScroll(options);
  const queuedFrames = settle ? (immediate ? 2 : 3) : (immediate ? 0 : 1);
  if (queuedFrames > 0) scheduleChatTailScroll(options, queuedFrames);
}

  messagesEl.addEventListener("scroll", handleMessagesScroll, { passive: true });
  messagesEl.addEventListener("scroll", scheduleViewportCenterAnchorCapture, { passive: true });
  messagesEl.addEventListener("wheel", handleMessagesWheel, { passive: false });
  messagesEl.addEventListener("pointerdown", handleMessagesPointerDown, { passive: true });
  messagesEl.addEventListener("touchstart", handleMessagesTouchStart, { passive: true });
  messagesEl.addEventListener("touchmove", handleMessagesTouchMove, { passive: true });
  messagesEl.addEventListener("touchend", handleMessagesTouchEnd, { passive: true });
  messagesEl.addEventListener("touchcancel", handleMessagesTouchEnd, { passive: true });
  messagesEl.addEventListener("click", handleViewportAnchorClick, { capture: true });
  document.addEventListener("pointerup", handleScrollbarPointerEnd, { passive: true });
  document.addEventListener("pointercancel", handleScrollbarPointerEnd, { passive: true });
  document.addEventListener("keydown", handleChatScrollKeydown, { capture: true });
  installChatTailLayoutObservers();

  function scrollToTarget(target: Element | null, { block = "center", inline = "nearest" }: ScrollIntoViewOptions = {}) {
    if (!target?.scrollIntoView) return;
    endDockLayoutTransaction();
    releaseViewportResizeLease({ capture: false });
    releaseViewportLease();
    setChatTailFollowing(false);
    performProgrammaticChatScroll(() => {
      target.scrollIntoView({ block, inline });
    });
  }

  function syncScrollPosition() {
    chatLastScrollTop = messagesEl.scrollTop || 0;
    if (chatProgrammaticScroll) chatProgrammaticScroll.top = chatLastScrollTop;
    if (viewportLease?.anchor) viewportLease.anchor.scrollTop = chatLastScrollTop;
    scheduleViewportCenterAnchorCapture();
  }

  function adjustScrollTop(delta: number) {
    const amount = Number(delta) || 0;
    if (Math.abs(amount) < 0.5) return;
    performProgrammaticChatScroll(() => {
      messagesEl.scrollTop += amount;
    });
  }

  function reset() {
    endDockLayoutTransaction();
    releaseViewportResizeLease({ capture: false });
    cancelViewportCenterAnchorCapture();
    viewportCenterAnchor = null;
    releaseViewportLease();
    clearScrollToLatestIntent();
    cancelScheduledChatTailScroll();
    chatTailFollowing = true;
    chatLastScrollTop = messagesEl.scrollTop || 0;
    chatProgrammaticScroll = null;
    chatTailLockUntil = 0;
    chatUserScrollUntil = 0;
    chatScrollbarPointerId = null;
    chatTouchLastY = null;
    chatTouchTarget = null;
  }

  return {
    shouldFollowTail: shouldFollowChatTail,
    setFollowing: setChatTailFollowing,
    isLocked: isChatTailLocked,
    lockForSubmittedAction: lockChatTailForSubmittedAction,
    cancelScheduledScroll: cancelScheduledChatTailScroll,
    collectViewportAnchorState,
    captureAnchorForElement: captureViewportAnchorForElement,
    captureActiveAnchor: captureActiveViewportAnchor,
    restoreAnchor: restoreViewportAnchor,
    adjustScrollTop,
    syncScrollPosition,
    isUserScrolling: isChatUserScrolling,
    requestLatest: requestScrollToLatest,
    hasLatestIntent: hasActiveScrollToLatestIntent,
    clearLatestIntent: clearScrollToLatestIntent,
    consumeLatestIntent: consumeScrollToLatestIntent,
    scrollToBottom,
    updateSafeArea: updateChatTailSafeArea,
    settleAfterDockLayout: settleChatTailAfterDockLayout,
    preserveViewportDuringDockLayout,
    preserveViewportDuringContentLayout,
    scrollToTarget,
    scrollToMatch: scrollToTarget,
    userScrollIdleMs: CHAT_USER_SCROLL_IDLE_MS,
    reset,
  };
}


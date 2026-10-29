import { sessionAutomationsEnabled } from "#sdk/shared/session-automations";
import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "./i18n.js";
import { formatSessionListSummaryText } from "#sdk/shared/sessions";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import type { UiSessionPort } from "#sdk/sidepanel";
import { stringSessionId as normalizeSessionId } from "#sdk/sidepanel/sessions";
import { createListLayoutMotion, createListExitTransition } from "#sdk/sidepanel/dom";
import type { SessionMetadata } from "#sdk/shared/sessions";
import type { ClientRuntime, TrackerView } from "#sdk/sidepanel/sessions";
import { normalizeSessionGoal, normalizeSessionTracker, normalizeSessionTaskSites } from "#sdk/sidepanel/sessions";
import type { createArtifactsFeature } from "./artifacts/artifacts-feature.js";
import type { UiEvent as PortMessage } from "#sdk/sidepanel";
type Fields = Record<string, unknown>;
type Runtime = Partial<ClientRuntime>;
type Session = SessionMetadata & { runtimeUpdatedAt?: string } & Runtime;
type TreeNode = ReturnType<typeof buildTreeNodes<Session>>["nodes"][number];
type TreeRow = TreeNode & { session: Session };
type RefreshOptions = { immediate?: boolean; delay?: number | null };
interface SessionsOptions {
  signal?: AbortSignal;
  root?: Document; initialMode?: string; automationsEnabled?: boolean; liveElapsedTickMs?: number; onStableViewChange?(): void;
  request(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>; send?(message: PortMessage): unknown;
  sessionState: Pick<UiSessionPort, "mergeRuntime" | "mergeRecords">;
  artifactsFeature: Pick<ReturnType<typeof createArtifactsFeature>, "scheduleSummaryBackfill" | "scheduleListHydration" | "openPanel" | "getSummaryFromRecord" | "renderSessionChip">;
  sessionExportFeature: { exportSession: UiSessionPort["export"]; isPreparing: UiSessionPort["isExporting"] };
  getRuntime?(id: string): Runtime; isRuntimeRunning?(runtime: Runtime): boolean;
  normalizeGoal?: typeof normalizeSessionGoal; normalizeTracker?: typeof normalizeSessionTracker; normalizeTaskSites?: typeof normalizeSessionTaskSites;
  goalStatusClass?(status: string): string; trackerModeTitle?(mode: string): string; trackerModeUnit?(mode: string): string;
  formatLiveElapsedMs?(ms: number): string; clipText?(value: unknown, limit: number): string; cssEscapeValue?(value: unknown): string;
  getCurrentSessionId?(): string | null; isCurrentSession?(id: string): boolean; isActive?(): boolean;
  isDeletedSession?(id: string): boolean; isGoalClearPending?(id: string): boolean;
  switchToSession?(id: string, options?: { source: string }): Promise<unknown>;
  scheduleAutomationsRefresh?(options: RefreshOptions): void; setAutomationsVisible?(visible: boolean): void; closeAutomationsEditor?(): void;
  showToast?: UiExtensionAPI["showToast"]; flashAction?(element: HTMLElement, text: string): void;
  renderCurrentGoalStrip?(): void;
  runStatusText?(runtime: Runtime): string; isChatActive?(): boolean; syncKeepAlive?(): void;
}
const fields = (input: unknown): Fields => input && typeof input === "object" && !Array.isArray(input) ? input as Fields : {};
const errorMessage = (error: unknown, fallback = String(error)) => String(fields(error).message || fallback);

import { extractSessionExchangePayload } from "#sdk/shared/sessions";
import { createSessionTitle } from "#sdk/shared/sessions";
import {
  getSessions,
  normalizeParentSessionId,
  ROOT_SESSION_ID,
} from "#sdk/shared/sessions";
import {
  normalizeSessionListSummary,
  sessionListSummarySearchText,
} from "#sdk/shared/sessions";
import { isActiveSessionRuntimeStatus } from "#sdk/shared/sessions";
import {
  compareBeijingDateTimeDesc,
  formatDisplayDateTime,
  parseBeijingDateTime,
} from "#sdk/shared/format";
import { buildTreeNodes } from "#sdk/sidepanel/sessions";
import { patchAttributes } from "#sdk/sidepanel/dom";
import { getToolDisplayName } from "#sdk/sidepanel/presentation";
import { escapeHtml, hashText } from "#sdk/sidepanel/dom";
import { resolveStableSiblingOrders } from "./session-order.js";

const SESSION_STATE_REQUEST_INTERVAL_MS = 5000;
const SESSION_LIST_SORT_THROTTLE_MS = 1800;
const SESSION_LIST_INTERACTION_HOLD_MS = 900;
const SESSION_LIST_SCROLL_HOLD_MS = 650;
const SESSION_LIST_DELETE_HOLD_MS = 420;
const SESSION_LIST_LAYOUT_MOVE_MS = 260;
const SESSION_LIST_SNAPSHOT_SOFT_TIMEOUT_MS = 1200;

export function isSessionListSnapshotSoftTimeout(error: unknown) {
  const code = String(fields(error).code || "");
  const type = String(fields(fields(error).details).type || "");
  const timeoutMs = Number(fields(fields(error).details).timeoutMs || 0);
  if (code === "PORT_REQUEST_TIMEOUT") {
    return (!type || type === "list_sessions")
      && (!timeoutMs || timeoutMs === SESSION_LIST_SNAPSHOT_SOFT_TIMEOUT_MS);
  }
  return !code && /^list_sessions timed out$/i.test(String(fields(error).message || "").trim());
}

export function createSessionsFeature(options: SessionsOptions) {
  const root = options.root || document;
  const lifetime = options.signal;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const request = options.request;
  const send = options.send || (() => {});
  const sessionState = options.sessionState;
  const artifactsFeature = options.artifactsFeature;
  const sessionExportFeature = options.sessionExportFeature;
  const getSessionRuntime: (id: string) => Runtime = options.getRuntime || (() => ({}));
  const isSessionRuntimeRunning = options.isRuntimeRunning || (() => false);
  const normalizeRuntimeGoal = options.normalizeGoal || normalizeSessionGoal;
  const normalizeRuntimeTracker = options.normalizeTracker || normalizeSessionTracker;
  const normalizeRuntimeTaskSites = options.normalizeTaskSites || normalizeSessionTaskSites;
  const goalStatusClass = options.goalStatusClass || (() => "active");
  const trackerModeTitle = options.trackerModeTitle || (() => "");
  const trackerModeUnit = options.trackerModeUnit || (() => "");
  const formatLiveElapsedMs = options.formatLiveElapsedMs || (() => "");
  const clipText = options.clipText || ((value, limit) => String(value || "").slice(0, limit));
  const cssEscapeValue = options.cssEscapeValue || (value => String(value || ""));
  const getCurrentSessionId = options.getCurrentSessionId || (() => "");
  const isCurrentSessionId = options.isCurrentSession || (() => false);
  const isActive = options.isActive || (() => false);
  const isDeletedSession = options.isDeletedSession || (() => false);
  const isGoalClearPending = options.isGoalClearPending || (() => false);
  const switchToSession = options.switchToSession || (async () => {});
  const scheduleAutomationsRefresh = options.scheduleAutomationsRefresh || (() => {});
  const setAutomationsVisible = options.setAutomationsVisible || (() => {});
  const closeAutomationsEditor = options.closeAutomationsEditor || (() => {});
  const showCaseToast = options.showToast || (() => {});
  const flashMessageAction = options.flashAction || (() => {});
  const renderCurrentGoalStrip = options.renderCurrentGoalStrip || (() => {});
  const liveElapsedTickMs = Math.max(100, Number(options.liveElapsedTickMs) || 1000);

  if (typeof request !== "function") throw new Error("sessions request adapter is required");
  if (!sessionState) throw new Error("sessions session state is required");
  if (!artifactsFeature) throw new Error("sessions artifacts feature is required");

  const panel = $("#sessions-panel");
  const sessionsModeBtns = Array.from(root.querySelectorAll<HTMLElement>(".sessions-mode-btn"));
  const sessionsSearch = $<HTMLInputElement>("#sessions-search");
  const btnImportSession = $<HTMLButtonElement>("#btn-import-session");
  const sessionImportFile = $<HTMLInputElement>("#session-import-file");
  const sessionsList = $("#sessions-list");
  sessionsList?.setAttribute("role", "tree");
  sessionsList?.setAttribute("aria-label", t("tasksLabel"));

  const SESSION_LIST_RENDER_INTERVAL_MS = liveElapsedTickMs;
  let sessionsListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionsListRenderInFlight = false;
  let sessionsListRenderPending = false;
  let sessionsListRenderPendingFreshState = false;
  let sessionsListLastRenderAt = 0;
  let sessionsListLastHtml = "";
  let sessionsListRefreshDueAt = 0;
  let sessionsListRenderedSearchQuery = "";
  let sessionListVisibleOrderByParent = new Map<string, string[]>();
  let sessionListRenderRankById = new Map<string, number>();
  let sessionListLastSortAppliedAt = 0;
  let sessionListDeferredSortTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionListDeferredSortDueAt = 0;
  let sessionListPointerInside = false;
  let sessionListFocusInside = false;
  let sessionListInteractionHoldUntil = 0;
  const layoutMotion = createListLayoutMotion({
    root: () => sessionsList, selector: ".session-card[data-id]", key: card => card.dataset.id || "",
    reduceMotion: shouldReduceSessionListMotion, duration: SESSION_LIST_LAYOUT_MOVE_MS,
  });
  const listExit = createListExitTransition({
    className: "session-tree-node-final-exit", keyframes: [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 100% 0)" }],
    duration: SESSION_LIST_LAYOUT_MOVE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });
  const automationsEnabled = options.automationsEnabled ?? sessionAutomationsEnabled();
  let sessionsViewMode = automationsEnabled && options.initialMode === "automation" ? "automation" : "manual";
  const sessionStateRequestedAt = new Map<string, number>();
  const expandedSessionIds = new Set<string>();
  const collapsedSessionIds = new Set<string>();
  const pendingSessionDeleteIds = new Set<string>();
function refreshSessionsPanel({ requestFreshState = false } = {}) {
  syncSessionsViewModeUi();
  if (sessionsViewMode === "automation") {
    scheduleAutomationsRefresh({ immediate: true });
  } else {
    renderSessionsListNow({ requestFreshState });
  }
}

function syncSessionsViewModeUi() {
  sessionsModeBtns.forEach((btn) => {
    const active = btn.dataset.sessionsMode === sessionsViewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  const automationMode = sessionsViewMode === "automation";
  sessionsList?.classList.toggle("hidden", automationMode);
  setAutomationsVisible(automationMode);
  if (sessionsSearch) {
    sessionsSearch.placeholder = automationMode ? t("searchAutomations") : t("searchTasks");
  }
  btnImportSession?.classList.toggle("hidden", automationMode);
}

function scheduleSessionsListRefresh({ immediate = false, delay = null }: RefreshOptions = {}) {
  if (!isActive()) return;
  if (sessionsViewMode === "automation") {
    scheduleAutomationsRefresh({ immediate, delay });
    return;
  }
  if (immediate) {
    renderSessionsListNow();
    return;
  }
  const elapsed = Date.now() - sessionsListLastRenderAt;
  const interval = Number.isFinite(delay) ? Math.max(0, delay ?? 0) : SESSION_LIST_RENDER_INTERVAL_MS;
  const waitMs = Math.max(0, interval - elapsed);
  const dueAt = Date.now() + waitMs;
  if (sessionsListRefreshTimer) {
    if (!sessionsListRefreshDueAt || dueAt >= sessionsListRefreshDueAt) return;
    clearTimeout(sessionsListRefreshTimer);
  }
  sessionsListRefreshDueAt = dueAt;
  sessionsListRefreshTimer = setTimeout(() => {
    sessionsListRefreshTimer = null;
    sessionsListRefreshDueAt = 0;
    renderSessionsListNow();
  }, waitMs);
}

async function renderSessionsListNow({ requestFreshState = false } = {}) {
  if (!isActive()) return;
  syncSessionsViewModeUi();
  if (sessionsViewMode !== "manual") return;
  if (sessionsListRefreshTimer) {
    clearTimeout(sessionsListRefreshTimer);
    sessionsListRefreshTimer = null;
    sessionsListRefreshDueAt = 0;
  }
  if (sessionsListRenderInFlight) {
    sessionsListRenderPending = true;
    sessionsListRenderPendingFreshState ||= Boolean(requestFreshState);
    return;
  }
  sessionsListRenderInFlight = true;
  sessionsListLastRenderAt = Date.now();
  try {
    await loadSessionsList({ requestFreshState });
  } finally {
    sessionsListRenderInFlight = false;
    if (sessionsListRenderPending) {
      const pendingFreshState = sessionsListRenderPendingFreshState;
      sessionsListRenderPending = false;
      sessionsListRenderPendingFreshState = false;
      if (pendingFreshState) renderSessionsListNow({ requestFreshState: true });
      else scheduleSessionsListRefresh();
    }
  }
}

function markSessionListInteractionHold(durationMs = SESSION_LIST_INTERACTION_HOLD_MS) {
  const duration = Math.max(0, Number(durationMs) || 0);
  sessionListInteractionHoldUntil = Math.max(sessionListInteractionHoldUntil, Date.now() + duration);
}

function releaseSessionListInteractionAfter(durationMs = SESSION_LIST_INTERACTION_HOLD_MS) {
  markSessionListInteractionHold(durationMs);
  scheduleDeferredSessionListSortRefresh(durationMs);
}

function clearSessionListInteractionHold() {
  sessionListPointerInside = false;
  sessionListFocusInside = false;
  sessionListInteractionHoldUntil = 0;
}

function getSessionListReorderHoldRemainingMs(now = Date.now()) {
  if (sessionListPointerInside || sessionListFocusInside) return SESSION_LIST_INTERACTION_HOLD_MS;
  return Math.max(0, sessionListInteractionHoldUntil - now);
}

function scheduleDeferredSessionListSortRefresh(delayMs: number) {
  if (!isActive() || sessionsViewMode !== "manual") return;
  const duration = Number.isFinite(delayMs) ? delayMs : SESSION_LIST_INTERACTION_HOLD_MS;
  const waitMs = Math.max(80, Math.ceil(duration));
  const dueAt = Date.now() + waitMs;
  if (sessionListDeferredSortTimer) {
    if (!sessionListDeferredSortDueAt || dueAt >= sessionListDeferredSortDueAt) return;
    clearTimeout(sessionListDeferredSortTimer);
  }
  sessionListDeferredSortDueAt = dueAt;
  sessionListDeferredSortTimer = setTimeout(() => {
    sessionListDeferredSortTimer = null;
    sessionListDeferredSortDueAt = 0;
    scheduleSessionsListRefresh({ immediate: true });
  }, waitMs);
}

function clearDeferredSessionListSortRefresh() {
  if (!sessionListDeferredSortTimer) return;
  clearTimeout(sessionListDeferredSortTimer);
  sessionListDeferredSortTimer = null;
  sessionListDeferredSortDueAt = 0;
}

function commitSessionsListSearchHtml(html: string, searchQuery: string) {
  const query = String(searchQuery || "");
  const animate = query === sessionsListRenderedSearchQuery;
  sessionsListRenderedSearchQuery = query;
  commitSessionsListHtml(html, { animate });
}

function commitSessionsListHtml(html: string, { animate = true } = {}) {
  const markup = String(html || "");
  if (!sessionsList) return;
  if (!animate) settleSessionListMotion();
  if (sessionsListLastHtml === markup) return;
  const scrollTop = sessionsList.scrollTop;
  if (animate && shouldStageSessionsEmptyTransition(markup)) {
    transitionSessionsListToEmpty(markup, scrollTop);
    return;
  }
  listExit.cancel();
  const previousRects = animate ? captureSessionListCardRects(sessionsList) : new Map();
  morphSessionsListHtml(sessionsList, markup, { animateRemovals: animate });
  sessionsList.scrollTop = scrollTop;
  sessionsListLastHtml = markup;
  if (animate) animateSessionListLayout(previousRects);
}

function shouldStageSessionsEmptyTransition(markup: string) {
  return Boolean(
    sessionsList
    && !shouldReduceSessionListMotion()
    && /class="sessions-empty"/.test(String(markup || ""))
    && sessionsList.querySelector(".session-card[data-id]")
    && !sessionsList.querySelector(".sessions-empty")
  );
}

function transitionSessionsListToEmpty(markup: string, scrollTop = 0) {
  if (!sessionsList) return;
  sessionsListLastHtml = markup;
  listExit.start(Array.from(sessionsList.children), () => {
    sessionsList.innerHTML = markup;
    sessionsList.scrollTop = scrollTop;
    const empty = sessionsList.querySelector(".sessions-empty");
    if (!empty) return;
    empty.classList.add("sessions-empty-enter");
    requestAnimationFrame(() => {
      if (empty.isConnected) empty.classList.add("is-visible");
    });
  });
}

function settleSessionListMotion() {
  if (!sessionsList) return;
  layoutMotion.settle();
  sessionsList.querySelectorAll<HTMLElement>(":scope > .session-removal-ghost").forEach(ghost => ghost.remove());
}

function morphSessionsListHtml(container: HTMLElement, html: string, { animateRemovals = true } = {}) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "").trim();
  morphSessionChildren(container, template.content, { animateRemovals });
}

function morphSessionChildren(currentParent: Element | DocumentFragment, nextParent: Element | DocumentFragment, { animateRemovals = true } = {}) {
  const nextChildren = Array.from(nextParent.children);
  const nextKeys = new Set(nextChildren.map(sessionDomKey).filter(Boolean));
  for (const child of Array.from(currentParent.children)) {
    const key = sessionDomKey(child);
    if (key && !nextKeys.has(key)) {
      if (animateRemovals) removeSessionChildWithAnimation(child);
      else child.remove();
    }
  }

  const keyed = new Map<string, Element>();
  const used = new Set<Node>();
  for (const child of Array.from(currentParent.children)) {
    if (isSessionListRemovingNode(child)) continue;
    const key = sessionDomKey(child);
    if (key) keyed.set(key, child);
  }

  let cursor: ChildNode | null = null;
  for (const nextChild of nextChildren) {
    const key = sessionDomKey(nextChild);
    let currentChild: ChildNode | null | undefined = key ? keyed.get(key) : null;
    if (!currentChild) {
      currentChild = findReusableSessionChild(currentParent, nextChild, cursor);
    }
    if (currentChild) {
      morphSessionNode(currentChild, nextChild, { animateRemovals });
    } else {
      currentChild = nextChild.cloneNode(true) as ChildNode;
    }
    used.add(currentChild);

    const expected: ChildNode | null = cursor ? cursor.nextSibling : currentParent.firstChild;
    if (currentChild !== expected) currentParent.insertBefore(currentChild, expected);
    cursor = currentChild;
  }

  for (const child of Array.from(currentParent.children)) {
    if (!used.has(child)) {
      if (animateRemovals) removeSessionChildWithAnimation(child);
      else child.remove();
    }
  }
}

function morphSessionNode(current: ChildNode, next: Element, { animateRemovals = true } = {}) {
  if (!current || !next) return false;
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    current.replaceWith(next.cloneNode(true));
    return true;
  }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.nodeValue !== next.nodeValue) {
      current.nodeValue = next.nodeValue;
    }
    return true;
  }
  if (!(current instanceof Element)) return true;
  if (shouldPreserveSessionRenderSubtree(current, next)) return true;

  patchAttributes(current, next);
  const currentHasElementChildren = current.children.length > 0;
  const nextHasElementChildren = next.children.length > 0;
  if (!currentHasElementChildren && !nextHasElementChildren) {
    if (current.textContent !== next.textContent) current.textContent = next.textContent;
  } else if (!currentHasElementChildren || !nextHasElementChildren) {
    current.replaceChildren(...Array.from(next.childNodes, child => child.cloneNode(true)));
  } else {
    morphSessionChildren(current, next, { animateRemovals });
  }
  return true;
}

function shouldPreserveSessionRenderSubtree(current: Element, next: Element) {
  const signature = current.getAttribute("data-render-signature") || "";
  return Boolean(
    signature
    && signature === (next.getAttribute("data-render-signature") || "")
    && sessionDomKey(current)
    && sessionDomKey(current) === sessionDomKey(next)
  );
}

function findReusableSessionChild(parent: Element | DocumentFragment, nextChild: Element, cursor: ChildNode | null) {
  let child = cursor ? cursor.nextSibling : parent.firstChild;
  while (child) {
    if (isSessionListRemovingNode(child)) {
      child = child.nextSibling;
      continue;
    }
    if (!sessionDomKey(child) && child.nodeName === nextChild.nodeName) return child;
    child = child.nextSibling;
  }
  return null;
}

function sessionDomKey(node: Node | null) {
  if (!(node instanceof HTMLElement)) return "";
  if (isSessionListRemovingNode(node)) return "";
  if (node.dataset?.nodeId) return `node:${node.dataset.nodeId}`;
  if (node.classList?.contains("session-card") && node.dataset?.id) return `card:${node.dataset.id}`;
  const automationKey = automationListItemKey(node);
  if (automationKey) return automationKey;
  return "";
}

function automationListItemKey(node: Node | null) {
  if (!(node instanceof HTMLElement)) return "";
  if (node.classList?.contains("automation-card") && node.dataset?.automationId) {
    return `automation:${node.dataset.automationId}`;
  }
  const automationId = node.closest<HTMLElement>(".automation-card[data-automation-id]")?.dataset?.automationId || "";
  if (node.classList?.contains("automation-run") && node.dataset?.runId) {
    return `automation-run:${automationId}:${node.dataset.runId}`;
  }
  if (node.classList?.contains("automation-artifact-shelf") && node.dataset?.runId) {
    return `automation-shelf:${automationId}:${node.dataset.runId}`;
  }
  return "";
}

function isSessionListRemovingNode(node: Node | null) {
  return Boolean(node instanceof HTMLElement && node.dataset?.sessionRemoving === "true");
}

function shouldReduceSessionListMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function prepareListRemovalLayer() {
  if (shouldReduceSessionListMotion()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function captureSessionListCardRects(root: HTMLElement | null) { return layoutMotion.capture(root); }
function animateSessionListLayout(previousRects: Map<string, DOMRect>) { layoutMotion.animate(previousRects); }

function removeSessionChildWithAnimation(node: Element) {
  if (!node.isConnected) return;
  // SVG paths/rects are replaced during icon updates; they are not HTML cards
  // that can participate in the list's removal animation.
  if (!(node instanceof HTMLElement)) {
    node.remove();
    return;
  }
  if (isSessionListRemovingNode(node)) return;
  if (node.closest("#automations-list") && !automationListItemKey(node)) {
    node.remove();
    return;
  }
  if (shouldReduceSessionListMotion()) {
    node.remove();
    return;
  }

  node.dataset.sessionRemoving = "true";
  const ghost = createSessionRemovalGhost(node);
  node.remove();
  if (ghost) playSessionRemovalGhost(ghost);
}

function createSessionRemovalGhost(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const layer = node.closest(".sessions-list, .automations-list");
  if (!layer) return null;
  const layerRect = layer.getBoundingClientRect();
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.dataset.sessionRemoving = "true";
  ghost.classList.add("session-removal-ghost");
  ghost.querySelectorAll<HTMLElement>("[id]").forEach(el => el.removeAttribute("id"));
  ghost.querySelectorAll<HTMLElement>("button, [tabindex]").forEach((el) => {
    if ("disabled" in el) el.disabled = true;
    el.setAttribute("tabindex", "-1");
  });
  let left = rect.left - layerRect.left + layer.scrollLeft;
  let top = rect.top - layerRect.top + layer.scrollTop;
  ghost.style.left = `${left}px`;
  ghost.style.top = `${top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = "0";
  ghost.style.opacity = "1";
  ghost.style.transform = "none";
  ghost.style.setProperty("--session-delete-collapse-ms", `${SESSION_LIST_LAYOUT_MOVE_MS}ms`);
  layer.appendChild(ghost);

  // Resolve padding and border offsets synchronously before the first paint.
  const placed = ghost.getBoundingClientRect();
  left += rect.left - placed.left;
  top += rect.top - placed.top;
  ghost.style.left = `${left}px`;
  ghost.style.top = `${top}px`;
  return ghost;
}

function playSessionRemovalGhost(ghost: HTMLElement) {
  const cleanup = () => ghost.remove();
  if (typeof ghost.animate !== "function") {
    ghost.classList.add("is-exiting");
    window.setTimeout(cleanup, SESSION_LIST_LAYOUT_MOVE_MS + 120);
    return;
  }
  const animation = ghost.animate([
    { clipPath: "inset(0 0 0 0)" },
    { clipPath: "inset(0 0 100% 0)" },
  ], {
    duration: SESSION_LIST_LAYOUT_MOVE_MS,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    fill: "forwards",
  });
  animation.finished.catch(() => {}).finally(cleanup);
  window.setTimeout(cleanup, SESSION_LIST_LAYOUT_MOVE_MS + 120);
}

function requestSessionStatesForList(list: Session[], { force = false } = {}) {
  const now = Date.now();
  for (const session of list) {
    const id = normalizeSessionId(session?.id);
    if (!id) continue;
    const lastAt = sessionStateRequestedAt.get(id) || 0;
    if (!force && now - lastAt < SESSION_STATE_REQUEST_INTERVAL_MS) continue;
    sessionStateRequestedAt.set(id, now);
    send({ type: "get_state", sessionId: id });
  }
}

function hydrateSessionRuntimeFromListRecord(input: unknown) {
  const session = fields(input);
  const id = normalizeSessionId(session?.id);
  if (!id) return;
  const previous = getSessionRuntime(id);
  const hasTracker = Object.prototype.hasOwnProperty.call(session || {}, "tracker");
  const hasGoal = Object.prototype.hasOwnProperty.call(session || {}, "goal");
  const nextGoal = isGoalClearPending(id)
    ? null
    : (hasGoal ? normalizeRuntimeGoal(session.goal) : (previous.goal || null));
  sessionState.mergeRuntime(id, {
    ...previous,
    status: session.status || previous.status,
    running: session.running === true || isActiveSessionRuntimeStatus(session.status),
    runId: session.runId || previous.runId || null,
    waitId: session.waitId || previous.waitId || "",
    interrupted: session.interrupted === true || previous.interrupted === true,
    updatedAt: session.runtimeUpdatedAt || session.updatedAt || previous.updatedAt || "",
    tracker: hasTracker ? normalizeRuntimeTracker(session.tracker) : (previous.tracker || null),
    goal: nextGoal,
    workingTab: session.workingTab || previous.workingTab || null,
    visitedTaskSites: Array.isArray(session.visitedTaskSites)
      ? normalizeRuntimeTaskSites(session.visitedTaskSites)
      : (previous.visitedTaskSites || []),
  });
  if (isCurrentSessionId(id)) renderCurrentGoalStrip();
}

function sessionGoalStatusText(goal: unknown = null) {
  const normalized = normalizeRuntimeGoal(goal);
  if (!normalized) return "";
  return normalized.objective || t("currentGoal");
}

function buildSessionGoalChip(runtime: Runtime = {}, sessionId = "") {
  const goal = normalizeRuntimeGoal(runtime.goal);
  if (!goal) return "";
  const id = normalizeSessionId(sessionId);
  const statusClass = goalStatusClass(goal.status);
  const tooltip = sessionGoalStatusText(goal);
  return `
    <button class="qz-pill session-artifact-chip session-goal-chip ${statusClass}" type="button" data-session-action="goal-status" data-id="${escapeHtmlAttribute(id)}" title="${escapeHtmlAttribute(tooltip)}" aria-label="${escapeHtmlAttribute(t("viewGoal", { goal: String(tooltip) }))}">
      <span class="session-goal-dot" aria-hidden="true"></span>
      <span>${escapeHtml(t("goal"))}</span>
    </button>
  `;
}

function buildSessionRuntimeMeta(session: Session, runtime: Runtime) {
  const parts = [];
  if (isSessionRuntimeRunning(runtime)) {
    const elapsed = formatRuntimeElapsed(runtime.startedAt || runtime.updatedAt);
    if (elapsed) parts.push(t("run", { count: String(elapsed) }));
    if (runtime.currentToolName) {
      const toolLabel = runtime.currentTool?.statusText || getToolDisplayName(runtime.currentTool || runtime.currentToolName);
      const toolText = runtime.currentToolStartedAt
        ? `${toolLabel} ${formatRuntimeElapsed(runtime.currentToolStartedAt)}`
        : toolLabel;
      parts.push(toolText);
    }
    if (runtime.contextUsageText) parts.push(runtime.contextUsageText);
  } else {
    parts.push(formatDisplayDateTime(session.updatedAt));
  }
  return parts.filter(Boolean).join(" · ");
}

function buildSessionTrackerProgress(runtime: Runtime) {
  const tracker = normalizeRuntimeTracker(runtime?.tracker);
  if (!tracker) return "";
  const value = getTrackerProgressValue(tracker);
  const total = tracker.total || 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((value / total) * 100))) : 100;
  const label = getTrackerProgressLabel(tracker);
  const count = getTrackerProgressCount(tracker, value, total);
  const indeterminate = total <= 0 ? " indeterminate" : "";
  return `
    <div class="session-tracker${indeterminate}" style="--tracker-progress:${percent}%">
      <div class="session-tracker-row">
        <span class="session-tracker-label" title="${escapeHtmlAttribute(label)}">${escapeHtml(label)}</span>
        <span class="session-tracker-count">${escapeHtml(count)}</span>
      </div>
      <div class="session-tracker-bar" aria-hidden="true"><span class="session-tracker-fill"></span></div>
    </div>
  `;
}

function getTrackerProgressValue(tracker: TrackerView) {
  if (tracker.mode === "pagination") return tracker.current || tracker.completed || 0;
  if (tracker.mode === "steps") return tracker.completed || Math.max(0, (tracker.currentStep || 1) - 1);
  return tracker.current || tracker.completed || 0;
}

function getTrackerProgressLabel(tracker: TrackerView) {
  const activeStep = tracker.steps?.find(step => step.status === "active");
  return tracker.note || activeStep?.label || tracker.title || trackerModeTitle(tracker.mode);
}

function getTrackerProgressCount(tracker: TrackerView, value: number, total: number) {
  const unit = tracker.unit || trackerModeUnit(tracker.mode);
  if (total > 0) {
    const key = tracker.mode === "pagination" && value > 0 ? "step" : "progressCount";
    return t(key, { value, total, unit }).trimEnd();
  }
  if (value > 0) return t("progressValue", { value, unit }).trimEnd();
  return t("inProgress");
}

function buildSessionWorkingTabLine(runtime: Runtime) {
  const tab = runtime.workingTab || null;
  const title = tab?.title || runtime.workingTitle || "";
  const url = tab?.url || runtime.workingUrl || "";
  if (!title && !url) return null;
  const label = title || url;
  return {
    text: t("tab", { title: String(clipText(label, 70)) }),
    title: url && title ? `${title}\n${url}` : (url || title),
  };
}

function buildSessionRecentLine(session: Partial<SessionMetadata> = {}) {
  const summary = normalizeSessionListSummary(session?.listSummary);
  return summary.lastText ? t("latestSummary", { summary: String(clipText(formatSessionListSummaryText(summary), 90)) }) : "";
}

function formatRuntimeElapsed(startedAt: unknown) {
  const start = parseBeijingDateTime(startedAt);
  if (!start) return "";
  return formatLiveElapsedMs(Date.now() - start);
}

function getSessionSearchQuery() {
  return String(sessionsSearch?.value || "").trim();
}

function tokenizeSessionSearch(query: string) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function fuzzySessionTextMatches(text: string, token: string) {
  const haystack = String(text || "").toLowerCase();
  if (!token) return true;
  if (haystack.includes(token)) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === token[index]) index += 1;
    if (index >= token.length) return true;
  }
  return false;
}

function buildSessionSearchText(session: Session) {
  const runtime = getSessionRuntime(session.id);
  const workingTab = buildSessionWorkingTabLine(runtime);
  const recentLine = buildSessionRecentLine(session);
  const listSummary = normalizeSessionListSummary(session.listSummary);
  const goal = normalizeRuntimeGoal(runtime.goal);
  return [
    session.title,
    session.id,
    session.createdAt,
    session.updatedAt,
    workingTab?.text,
    workingTab?.title,
    recentLine,
    goal?.objective,
    goal?.criteria,
    goal?.progress,
    goal?.next,
    goal?.checkpoint,
    sessionListSummarySearchText(listSummary),
  ].filter(Boolean).join(" ");
}

function sessionMatchesSearch(session: Session, tokens: string[]) {
  const searchText = buildSessionSearchText(session);
  return tokens.every(token => fuzzySessionTextMatches(searchText, token));
}

function filterSessionsForSearch(list: Session[], query: string) {
  const tokens = tokenizeSessionSearch(query);
  if (!tokens.length) {
    return {
      list,
      searchActive: false,
      expandedIds: expandedSessionIds,
    };
  }

  const byId = new Map(list.map(session => [session.id, session]));
  const keptIds = new Set<string>();
  const searchExpandedIds = new Set(expandedSessionIds);

  for (const session of list) {
    if (!sessionMatchesSearch(session, tokens)) continue;
    keptIds.add(session.id);

    let parentId = normalizeParentSessionId(session.parentSessionId);
    while (parentId && parentId !== ROOT_SESSION_ID) {
      keptIds.add(parentId);
      searchExpandedIds.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      parentId = normalizeParentSessionId(parent.parentSessionId);
    }
  }

  return {
    list: list.filter(session => keptIds.has(session.id)),
    searchActive: true,
    expandedIds: searchExpandedIds,
  };
}

async function loadSessionListSource({ requestFreshState = false } = {}) {
  if (!requestFreshState) {
    const localSessions = await getSessions();
    return { sessions: localSessions, hydratedFromSnapshot: false };
  }

  const localSessionsPromise = getSessions();
  try {
    const [localSessions, result] = await Promise.all([
      localSessionsPromise,
      request("list_sessions", { limit: 500 }, SESSION_LIST_SNAPSHOT_SOFT_TIMEOUT_MS),
    ]);
    const remoteSessions = Array.isArray(result?.sessions) ? result.sessions : [];
    remoteSessions.forEach(hydrateSessionRuntimeFromListRecord);
    markSessionStatesRequested(remoteSessions);
    return {
      sessions: mergeSessionListRecords(localSessions, remoteSessions),
      hydratedFromSnapshot: true,
    };
  } catch (err) {
    if (!isSessionListSnapshotSoftTimeout(err)) {
      console.warn("[轻舟] refresh session runtime snapshot failed", err);
    }
    const localSessions = await localSessionsPromise.catch(() => ({}));
    return { sessions: localSessions, hydratedFromSnapshot: false };
  }
}

function markSessionStatesRequested(sessions: unknown[] = [], requestedAt = Date.now()) {
  for (const session of sessions) {
    const id = normalizeSessionId(fields(session).id);
    if (id) sessionStateRequestedAt.set(id, requestedAt);
  }
}

function mergeSessionListRecords(localSessions: Record<string, Session> = {}, remoteSessions: unknown[] = []) {
  const merged = { ...localSessions };
  for (const input of remoteSessions) {
    const remote = fields(input);
    const id = normalizeSessionId(remote?.id);
    if (!id) continue;
    const local = merged[id];
    merged[id] = {
      ...remote,
      ...local,
      id,
      title: String(local?.title || remote.title || ""),
      createdAt: String(local?.createdAt || remote.createdAt || ""),
      updatedAt: String(remote.updatedAt || local?.updatedAt || ""),
    };
  }
  return merged;
}

function compareSessionListDefaultOrder(a: Session, b: Session) {
  const updatedCompare = compareBeijingDateTimeDesc(a?.updatedAt || "", b?.updatedAt || "");
  if (updatedCompare) return updatedCompare;
  const createdCompare = compareBeijingDateTimeDesc(a?.createdAt || "", b?.createdAt || "");
  if (createdCompare) return createdCompare;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function compareSessionListRenderOrder(a: Session, b: Session) {
  const rankA = sessionListRenderRankById.get(normalizeSessionId(a?.id));
  const rankB = sessionListRenderRankById.get(normalizeSessionId(b?.id));
  if (Number.isFinite(rankA) && Number.isFinite(rankB) && rankA !== rankB) {
    return Number(rankA) - Number(rankB);
  }
  return compareSessionListDefaultOrder(a, b);
}

function setSessionListVisibleOrders(orders: Map<string, string[]>) {
  const cleanOrders = new Map<string, string[]>();
  const rankById = new Map<string, number>();
  for (const [parentId, ids] of orders.entries()) {
    const cleanIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map(normalizeSessionId).filter(Boolean)));
    if (!cleanIds.length) continue;
    cleanOrders.set(parentId, cleanIds);
    cleanIds.forEach((id, index) => rankById.set(id, index));
  }
  sessionListVisibleOrderByParent = cleanOrders;
  sessionListRenderRankById = rankById;
}

function resetSessionListRenderOrder() {
  clearDeferredSessionListSortRefresh();
  sessionListVisibleOrderByParent = new Map();
  sessionListRenderRankById = new Map();
  sessionListLastSortAppliedAt = 0;
}

function resolveSessionListRenderOrder(list: Session[] = []) {
  const now = Date.now();
  const holdRemainingMs = getSessionListReorderHoldRemainingMs(now);
  const result = resolveStableSiblingOrders({
    records: Array.isArray(list) ? list : [],
    previousOrders: sessionListVisibleOrderByParent,
    now,
    holdUntil: now + holdRemainingMs,
    lastAppliedAt: sessionListLastSortAppliedAt,
    throttleMs: SESSION_LIST_SORT_THROTTLE_MS,
    rootId: ROOT_SESSION_ID,
    compare: compareSessionListDefaultOrder,
  });

  if (!result.orders.size) {
    resetSessionListRenderOrder();
    return result.orders;
  }
  sessionListLastSortAppliedAt = result.appliedAt;
  setSessionListVisibleOrders(result.orders);
  if (result.deferredUntil > now) {
    scheduleDeferredSessionListSortRefresh(result.deferredUntil - now);
  } else {
    clearDeferredSessionListSortRefresh();
  }
  return result.orders;
}

async function loadSessionsList({ requestFreshState = false } = {}) {
  const { sessions, hydratedFromSnapshot } = await loadSessionListSource({ requestFreshState });
  if (lifetime?.aborted) return;
  const searchQuery = getSessionSearchQuery();
  const list = Object.values(sessions).filter((session) => {
    const id = normalizeSessionId(session?.id);
    return session?.source !== "automation" && !isDeletedSession(id);
  }).map((session) => {
    const cleanParentId = normalizeParentSessionId(session.parentSessionId);
    const safeParentId = cleanParentId === session.id ? ROOT_SESSION_ID : cleanParentId;
    return {
      ...session,
      title: createSessionTitle(session.title),
      parentSessionId: safeParentId,
    };
  });
  rememberSessionListRecords(list);

  if (list.length === 0) {
    resetSessionListRenderOrder();
    commitSessionsListSearchHtml(`
      <div class="sessions-empty">
        <div class="sessions-empty-icon"></div>
        <p>${escapeHtml(t("noConversationsYet"))}</p>
      </div>
    `, searchQuery);
    return;
  }

  artifactsFeature.scheduleSummaryBackfill(list);

  const searchState = filterSessionsForSearch(list, searchQuery);
  if (searchState.searchActive && searchState.list.length === 0) {
    resetSessionListRenderOrder();
    commitSessionsListSearchHtml(`
      <div class="sessions-empty">
        <div class="sessions-empty-icon"></div>
        <p>${escapeHtml(t("noMatchingTasks"))}</p>
      </div>
    `, searchQuery);
    return;
  }

  resolveSessionListRenderOrder(searchState.list);
  const { nodes, rows } = buildSessionTreeModel(searchState.list, {
    expandedIds: searchState.expandedIds,
  });
  const focusSessionId = rows.some(row => row.id === getCurrentSessionId())
    ? getCurrentSessionId()
    : rows[0]?.id;

  const html = nodes.map(node => renderSessionTreeNode(node, focusSessionId)).join("");

  commitSessionsListSearchHtml(html, searchQuery);
  artifactsFeature.scheduleListHydration(rows.map(row => row.session).filter(Boolean));

  if (!hydratedFromSnapshot) {
    requestSessionStatesForList(searchState.list, { force: requestFreshState });
  }
  if (hasRunningSessionInList(searchState.list)) {
    scheduleSessionsListRefresh({ delay: liveElapsedTickMs });
  }
}

function rememberSessionListRecords(list: Session[] = []) {
  sessionState.mergeRecords(Array.isArray(list) ? list : []);
}

function hasRunningSessionInList(list: Session[] = []) {
  return Array.isArray(list)
    && list.some(session => isSessionRuntimeRunning(getSessionRuntime(session?.id)));
}

sessionsSearch?.addEventListener("input", () => {
  scheduleSessionsListRefresh({ immediate: true });
}, { signal: lifetime });

btnImportSession?.addEventListener("click", () => {
  if (!sessionImportFile) return;
  sessionImportFile.value = "";
  sessionImportFile.click();
}, { signal: lifetime });

sessionImportFile?.addEventListener("change", async () => {
  const file = sessionImportFile.files?.[0];
  if (!file) return;
  if (btnImportSession) btnImportSession.disabled = true;
  try {
    const payload = extractSessionExchangePayload(await file.text());
    const result = await request("import_session_exchange", { payload }, 60000);
    const sessionId = normalizeSessionId(fields(result.session).id);
    if (!sessionId) throw new Error(t("conversationImportedButNoTaskIdWasReturned"));
    await switchToSession(sessionId, { source: "import" });
    showOwnedTabsRestoreNotice(result.ownedTabsRestore);
  } catch (err) {
    showCaseToast(errorMessage(err, t("couldNotImportConversation")), { tone: "error", durationMs: 5000 });
  } finally {
    if (btnImportSession) btnImportSession.disabled = false;
    sessionImportFile.value = "";
  }
}, { signal: lifetime });

function handleSessionImportedFromExport(event: Fields = {}) {
  const sessionId = normalizeSessionId(event.sessionId || fields(event.session).id);
  if (!sessionId) return;
  switchToSession(sessionId, { source: "export_import" })
    .then(() => showOwnedTabsRestoreNotice(event.ownedTabsRestore))
    .catch((err) => showCaseToast(errorMessage(err, t("conversationImportedButItCannotBeOpenedRightNow")), {
      tone: "error",
      durationMs: 5000,
    }));
}

function showOwnedTabsRestoreNotice(input: unknown) {
  const result = fields(input);
  if (!result || !(Number(result.failedCount) > 0)) return;
  const restoredCount = Math.max(0, Number(result.restoredCount) || 0);
  const failedCount = Math.max(0, Number(result.failedCount) || 0);
  showCaseToast(
    restoredCount
      ? t("conversationImportedPagesOpenedNotOpened", { opened: String(restoredCount), failed: String(failedCount) })
      : t("conversationImportedPagesCouldNotBeOpened", { count: String(failedCount) }),
    {
      ...(restoredCount ? {} : { tone: "error" }),
      durationMs: 5000,
    },
  );
}

async function deleteSessionFromList(sessionId: string, anchorEl: HTMLElement | null = null) {
  const id = normalizeSessionId(sessionId);
  if (!id || pendingSessionDeleteIds.has(id) || isDeletedSession(id)) return;
  pendingSessionDeleteIds.add(id);
  markSessionListInteractionHold(SESSION_LIST_DELETE_HOLD_MS);
  syncSessionDeleteVisualState(id, true);
  try {
    await request("delete_session", { sessionId: id }, 10000);
  } catch (err) {
    pendingSessionDeleteIds.delete(id);
    syncSessionDeleteVisualState(id, false);
    scheduleSessionsListRefresh({ immediate: true });
    showCaseToast(t("couldNotDeleteTask", { reason: String(errorMessage(err)) }), {
      tone: "error",
      anchorEl: anchorEl?.isConnected ? anchorEl : null,
      durationMs: 5000,
    });
  }
}

function syncSessionDeleteVisualState(sessionId: string, deleting: boolean) {
  const id = normalizeSessionId(sessionId);
  if (!id || !sessionsList) return;
  const card = sessionsList.querySelector(`.session-card[data-id="${cssEscapeValue(id)}"]`);
  if (!card) return;
  card.classList.toggle("is-deleting", Boolean(deleting));
  card.setAttribute("aria-busy", deleting ? "true" : "false");
  card.closest(".session-tree-node")?.classList.toggle("session-tree-node-delete-pending", Boolean(deleting));
  const button = card.querySelector<HTMLButtonElement>('.session-delete-btn[data-session-action="delete"]');
  if (!button) return;
  button.disabled = Boolean(deleting);
  button.toggleAttribute("aria-busy", Boolean(deleting));
  const label = deleting ? t("deleting") : t("delete");
  button.title = label;
  button.setAttribute("aria-label", label);
}

sessionsModeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.sessionsMode === "automation" ? "automation" : "manual";
    setSessionsViewMode(mode, { track: true, refresh: true });
  }, { signal: lifetime });
});

function setSessionsViewMode(mode: string, { track = false, refresh = false } = {}) {
  const next = automationsEnabled && mode === "automation" ? "automation" : "manual";
  if (sessionsViewMode === next) return false;
  sessionsViewMode = next;
  if (track) {
  }
  closeAutomationsEditor();
  syncSessionsViewModeUi();
  if (refresh) refreshSessionsPanel({ requestFreshState: true });
  options.onStableViewChange?.();
  return true;
}

sessionsList?.addEventListener("pointerenter", () => {
  sessionListPointerInside = true;
}, { signal: lifetime });

sessionsList?.addEventListener("pointerleave", () => {
  sessionListPointerInside = false;
  releaseSessionListInteractionAfter();
}, { signal: lifetime });

sessionsList?.addEventListener("focusin", () => {
  sessionListFocusInside = true;
}, { signal: lifetime });

sessionsList?.addEventListener("focusout", () => {
  requestAnimationFrame(() => {
    sessionListFocusInside = Boolean(sessionsList?.contains(document.activeElement));
    if (!sessionListFocusInside) releaseSessionListInteractionAfter();
  });
}, { signal: lifetime });

sessionsList?.addEventListener("scroll", () => {
  markSessionListInteractionHold(SESSION_LIST_SCROLL_HOLD_MS);
}, { ...({ passive: true }), signal: lifetime });

sessionsList?.addEventListener("click", async (e) => {
  const actionEl = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>("[data-session-action]");
  if (actionEl) {
    e.stopPropagation();
    const id = normalizeSessionId(actionEl.dataset.id);
    if (!id) return;
    const action = actionEl.dataset.sessionAction;
    if (action === "toggle") {
      toggleSessionTreeNode(id);
      await renderSessionsListNow();
      focusSessionTreeItem(id);
    } else if (action === "stop") {
      send({ type: "stop_session", sessionId: id });
    } else if (action === "artifacts") {
      await artifactsFeature.openPanel(id);
    } else if (action === "goal-status") {
      const goalText = sessionGoalStatusText(getSessionRuntime(id).goal);
      if (goalText) {
        showCaseToast(goalText, {
          anchorEl: actionEl,
          durationMs: 8000,
          key: `session-goal:${id}`,
          toggle: true,
          variant: "goal-status",
        });
      }
    } else if (action === "export") {
      try {
        await sessionExportFeature.exportSession(id);
      } catch (_err) {
        if (actionEl.isConnected) flashMessageAction(actionEl, t("exportFailed"));
      }
    } else if (action === "delete") {
      deleteSessionFromList(id, actionEl);
    }
    return;
  }

  const card = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(".session-card[data-id]");
  const id = normalizeSessionId(card?.dataset.id);
  if (id) switchToSession(id);
}, { signal: lifetime });

sessionsList?.addEventListener("keydown", async (e) => {
  const card = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(".session-card[data-id]");
  if (!card) return;
  const id = normalizeSessionId(card.dataset.id);
  if (!id) return;

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusAdjacentSessionTreeItem(card, e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    focusEdgeSessionTreeItem(e.key === "Home" ? "first" : "last");
    return;
  }
  if (e.key === "ArrowRight") {
    if (card.dataset.hasChildren === "true" && card.dataset.expanded !== "true") {
      e.preventDefault();
      toggleSessionTreeNode(id);
      await renderSessionsListNow();
      focusSessionTreeItem(id);
    }
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (card.dataset.hasChildren === "true" && card.dataset.expanded === "true") {
      toggleSessionTreeNode(id);
      await renderSessionsListNow();
      focusSessionTreeItem(id);
    } else {
      focusSessionTreeItem(card.dataset.parentId);
    }
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    switchToSession(id);
  }
}, { signal: lifetime });

function toggleSessionTreeNode(id: string) {
  if (expandedSessionIds.has(id)) {
    expandedSessionIds.delete(id);
    collapsedSessionIds.add(id);
  } else {
    expandedSessionIds.add(id);
    collapsedSessionIds.delete(id);
  }
}

function focusSessionTreeItem(id: unknown) {
  const normalized = normalizeSessionId(id);
  if (!normalized || normalized === ROOT_SESSION_ID || !sessionsList) return;
  const target = visibleSessionTreeItems().find(item => item.dataset.id === normalized);
  if (!target) return;
  updateSessionTreeTabStops(target);
  target.focus({ preventScroll: true });
}

function focusAdjacentSessionTreeItem(current: HTMLElement, delta: number) {
  const items = visibleSessionTreeItems();
  const index = items.indexOf(current);
  if (index < 0) return;
  const next = items[Math.max(0, Math.min(items.length - 1, index + delta))];
  if (!next || next === current) return;
  updateSessionTreeTabStops(next);
  next.focus({ preventScroll: true });
}

function focusEdgeSessionTreeItem(edge: "first" | "last") {
  const items = visibleSessionTreeItems();
  const target = edge === "last" ? items[items.length - 1] : items[0];
  if (!target) return;
  updateSessionTreeTabStops(target);
  target.focus({ preventScroll: true });
}

function visibleSessionTreeItems() {
  return sessionsList ? Array.from(sessionsList.querySelectorAll<HTMLElement>(".session-card[data-id]:not(.is-removing)")) : [];
}

function updateSessionTreeTabStops(activeItem: HTMLElement) {
  for (const item of visibleSessionTreeItems()) {
    item.tabIndex = item === activeItem ? 0 : -1;
  }
}

function buildSessionTreeModel(list: Session[], { expandedIds = expandedSessionIds } = {}) {
  const tree = buildTreeNodes(list, {
    rootId: ROOT_SESSION_ID,
    expandedIds,
    getId: session => session.id,
    getParentId: session => normalizeParentSessionId(session.parentSessionId),
    compare: compareSessionListRenderOrder,
  });
  const rows: TreeRow[] = [];
  collectSessionTreeRows(tree.nodes, rows);
  return {
    ...tree,
    rows,
  };
}

function collectSessionTreeRows(nodes: TreeNode[], rows: TreeRow[]) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    rows.push({ ...node, session: node.item });
    collectSessionTreeRows(node.children, rows);
  }
}

function renderSessionTreeNode(node: TreeNode, focusSessionId: string | null | undefined): string {
  if (!node?.item) return "";
  const childrenHtml = node.expanded && node.children?.length
    ? `<div class="session-tree-children" role="group">${node.children.map(child => renderSessionTreeNode(child, focusSessionId)).join("")}</div>`
    : "";
  const cardHtml = renderSessionTreeCard(node, focusSessionId);
  const signature = hashText([
    node.id,
    node.parentId,
    node.depth,
    node.expanded ? "expanded" : "collapsed",
    cardHtml,
    childrenHtml,
  ].join("\n"));
  const pendingDeleteClass = pendingSessionDeleteIds.has(node.id) ? " session-tree-node-delete-pending" : "";
  return `
    <div class="session-tree-node${pendingDeleteClass}" role="none" data-node-id="${escapeHtmlAttribute(node.id)}" data-depth="${Math.max(0, node.depth)}" data-render-signature="${signature}">
      ${cardHtml}
      ${childrenHtml}
    </div>
  `;
}

function renderSessionTreeCard(node: TreeNode, focusSessionId: string | null | undefined) {
  const s = node.item;
  const id = node.id;
  const parentId = node.parentId;
  const depth = Math.max(0, node.depth);
  const runtime = getSessionRuntime(s.id);
  const runtimeStatus = runtime.status || "idle";
  const running = isSessionRuntimeRunning(runtime);
  const statusText = getSessionStatusText(runtimeStatus);
  const statusClass = getSessionStatusClass(runtimeStatus);
  const runtimeMeta = buildSessionRuntimeMeta(s, runtime);
  const trackerProgress = buildSessionTrackerProgress(runtime);
  const goalChipHtml = buildSessionGoalChip(runtime, s.id);
  const workingTab = buildSessionWorkingTabLine(runtime);
  const recentLine = buildSessionRecentLine(s);
  const artifactSummary = artifactsFeature.getSummaryFromRecord(s);
  const hasArtifacts = Boolean(artifactSummary?.total);
  const exportPreparing = sessionExportFeature.isPreparing(id);
  const exportTitle = exportPreparing ? t("preparingExport") : t("exportConversationAsHtml");
  const deleting = pendingSessionDeleteIds.has(id);
  const selected = s.id === getCurrentSessionId();
  const expandedAttr = node.hasChildren ? ` aria-expanded="${String(node.expanded)}"` : "";
  const artifactsTitle = hasArtifacts ? t("openTaskArtifacts", { count: String(artifactSummary?.total) }) : t("openTaskArtifactsAction");
  const className = `session-card ${selected ? 'active' : ''} ${running ? 'running' : ''} ${hasArtifacts ? 'has-artifacts' : ''} ${deleting ? 'is-deleting' : ''}`;
  const treeToggleHtml = node.hasChildren ? `
        <button class="qz-tree-toggle session-tree-toggle" type="button" data-session-action="toggle" data-id="${escapeHtmlAttribute(s.id)}" aria-label="${escapeHtmlAttribute(node.expanded ? t("collapse") : t("expand"))}" aria-expanded="${String(node.expanded)}" title="${escapeHtmlAttribute(node.expanded ? t("collapse") : t("expand"))}">
          ${node.expanded ? '-' : '+'}
        </button>
      ` : `<span class="session-tree-leaf ${depth > 0 ? 'child' : ''}" aria-hidden="true"></span>`;
  const artifactChipHtml = hasArtifacts ? artifactsFeature.renderSessionChip(artifactSummary || {}) : "";
  const finalActionButtonHtml = running ? `
        <button class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger session-stop-btn session-action-btn" type="button" data-session-action="stop" data-id="${escapeHtmlAttribute(s.id)}" title="${escapeHtmlAttribute(t("stopRun"))}" aria-label="${escapeHtmlAttribute(t("stopRun"))}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor"/></svg>
        </button>
      ` : `
        <button class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger session-delete-btn session-action-btn" data-session-action="delete" data-id="${escapeHtmlAttribute(s.id)}" title="${escapeHtmlAttribute(deleting ? t("deleting") : t("delete"))}" aria-label="${escapeHtmlAttribute(deleting ? t("deleting") : t("delete"))}"${deleting ? ' aria-busy="true" disabled' : ''}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      `;
  const cardInnerHtml = `
      ${treeToggleHtml}
      <div class="session-card-body">
        <div class="session-card-title-row">
          <div class="session-card-title" title="${escapeHtmlAttribute(s.title)}">${escapeHtml(s.title)}</div>
          ${artifactChipHtml}
          ${goalChipHtml}
          <div class="session-card-actions" aria-label="${escapeHtmlAttribute(t("taskActions"))}">
            <button class="qz-icon-btn qz-icon-btn--xs session-export-btn session-action-btn ${exportPreparing ? 'is-preparing' : ''}" data-session-action="export" data-id="${escapeHtmlAttribute(s.id)}" title="${exportTitle}" aria-label="${exportTitle}"${exportPreparing ? ' aria-busy="true" disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2Z"/><path d="M14 2v6h6M12 12v6m0 0 3-3m-3 3-3-3"/></svg>
            </button>
            <button class="qz-icon-btn qz-icon-btn--xs session-artifact-action-btn session-action-btn ${hasArtifacts ? 'has-artifacts' : ''}" data-session-action="artifacts" data-id="${escapeHtmlAttribute(s.id)}" title="${escapeHtmlAttribute(artifactsTitle)}" aria-label="${escapeHtmlAttribute(artifactsTitle)}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/></svg>
            </button>
            ${finalActionButtonHtml}
          </div>
        </div>
        <div class="session-card-meta">
          <span class="session-status ${statusClass}">${escapeHtml(statusText)}</span>
          ${runtimeMeta ? `<span class="session-meta-sep"> · </span><span>${escapeHtml(runtimeMeta)}</span>` : ""}
        </div>
        ${trackerProgress}
        ${workingTab ? `<div class="session-card-subline" title="${escapeHtmlAttribute(workingTab.title)}">${escapeHtml(workingTab.text)}</div>` : ""}
        ${recentLine ? `<div class="session-card-subline muted" title="${escapeHtmlAttribute(recentLine)}">${escapeHtml(recentLine)}</div>` : ""}
      </div>
    `;
  const cardSignature = hashText([
    className,
    id === focusSessionId ? "focus" : "",
    node.ariaLevel,
    node.ariaPosInSet,
    node.ariaSetSize,
    parentId,
    depth,
    node.hasChildren ? "children" : "leaf",
    node.expanded ? "expanded" : "collapsed",
    cardInnerHtml,
  ].join("\n"));
  return `
    <div class="${className}"
      role="treeitem"
      tabindex="${id === focusSessionId ? '0' : '-1'}"
      aria-level="${node.ariaLevel}"
      aria-posinset="${node.ariaPosInSet}"
      aria-setsize="${node.ariaSetSize}"
      aria-selected="${String(selected)}"${expandedAttr}
      data-id="${escapeHtmlAttribute(s.id)}"
      data-parent-id="${escapeHtmlAttribute(parentId)}"
      data-depth="${depth}"
      data-has-children="${String(node.hasChildren)}"
      data-expanded="${String(node.expanded)}"
      data-render-signature="${cardSignature}">
      ${cardInnerHtml}
    </div>
  `;
}

function getSessionStatusText(status: string) {
  switch (status) {
    case "pending": return t("pending");
    case "running": return t("running");
    case "waiting_user": return t("waitingForYou");
    case "completed": return t("completed");
    case "interrupted": return t("interrupted");
    case "aborted": return t("canceled");
    case "error": return t("error");
    default: return t("idle");
  }
}

function getSessionStatusClass(status: string) {
  switch (status) {
    case "pending":
    case "running":
      return "session-status-running";
    case "waiting_user":
      return "session-status-waiting";
    case "interrupted":
    case "aborted":
      return "session-status-interrupted";
    case "error":
      return "session-status-error";
    default:
      return "session-status-idle";
  }
}

  function markCreated(session: Partial<SessionMetadata> | null = null) {
    const id = normalizeSessionId(session?.id);
    if (id) pendingSessionDeleteIds.delete(id);
    const parentId = normalizeParentSessionId(session?.parentSessionId);
    if (parentId !== ROOT_SESSION_ID && !collapsedSessionIds.has(parentId)) expandedSessionIds.add(parentId);
  }

  function remove(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    pendingSessionDeleteIds.delete(id);
    sessionStateRequestedAt.delete(id);
    expandedSessionIds.delete(id);
    collapsedSessionIds.delete(id);
  }

  function reset() {
    if (sessionsListRefreshTimer) clearTimeout(sessionsListRefreshTimer);
    if (sessionListDeferredSortTimer) clearTimeout(sessionListDeferredSortTimer);
    sessionsListRefreshTimer = null;
    sessionListDeferredSortTimer = null;
    sessionsListRenderInFlight = false;
    sessionsListRenderPending = false;
    sessionsListRenderPendingFreshState = false;
    sessionsListLastRenderAt = 0;
    sessionsListLastHtml = "";
    sessionsListRefreshDueAt = 0;
    sessionListVisibleOrderByParent = new Map();
    sessionListRenderRankById = new Map();
    sessionListLastSortAppliedAt = 0;
    sessionListInteractionHoldUntil = 0;
    listExit.cancel();
    sessionsViewMode = "manual";
    sessionStateRequestedAt.clear();
    expandedSessionIds.clear();
    collapsedSessionIds.clear();
    pendingSessionDeleteIds.clear();
    syncSessionsViewModeUi();
  }

  return {
    panel,
    refresh: refreshSessionsPanel,
    scheduleRefresh: scheduleSessionsListRefresh,
    renderNow: renderSessionsListNow,
    syncModeUi: syncSessionsViewModeUi,
    getMode: () => sessionsViewMode,
    setMode: setSessionsViewMode,
    getSearchQuery: getSessionSearchQuery,
    clearInteractionHold: clearSessionListInteractionHold,
    morphListHtml: morphSessionsListHtml,
    listItemKey: automationListItemKey,
    shouldReduceMotion: shouldReduceSessionListMotion,
    prepareRemovalLayer: prepareListRemovalLayer,
    handleImported: handleSessionImportedFromExport,
    markCreated,
    remove,
    reset,
  };
}

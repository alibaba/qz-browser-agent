import { t, tHtml } from "../../i18n/index.js";
import { optionalSessionId as normalizeSessionId } from "../sessions/session-id.js";
import type { ClientRuntime } from "../sessions/session-state.js";
import type { PortMessage } from "../app/port-client.js";
interface QueueItem {
  clientMessageId?: unknown; text?: unknown; imageCount?: unknown; attachmentCount?: unknown; index?: number;
  queueKind?: string; submitting?: boolean;
}
interface QueuePatch { followUps?: unknown; steerings?: unknown }
interface QueueOptions {
  container?: HTMLElement | null; getSessionId?(): string | null; isVisible?(): boolean;
  getRuntime?(id: string | null): Partial<ClientRuntime>;
  mergeRuntime?(id: string, runtime: unknown): unknown;
  normalizePendingFollowUps?(items: unknown): QueueItem[]; normalizePendingSteerings?(items: unknown): QueueItem[];
  settleAfterDockLayout?(): void; send?(message: PortMessage): unknown;
  request?(type: string, payload: PortMessage): Promise<PortMessage>;
  restoreQueuedMessage?(sessionId: string, messageId: string, kind: string): Promise<PortMessage>;
  showToast?(message: string, options: { tone?: string; anchorEl: Element }): void; now?(): string;
}
interface RowSnapshot { id: string; rect: DOMRect; node: HTMLElement }
interface QueueSnapshots { rows: Map<string, RowSnapshot>; containerHeight?: number }
interface RemovedRow { id: string; item: QueueItem; snapshot?: RowSnapshot }
export interface OutgoingBatch { id: string; index: number; size: number }

import { escapeHtml } from "../../ui/ui-utils.js";

const QUEUED_FOLLOWUP_GHOST_MS = 120;
const QUEUED_FOLLOWUP_MOVE_MS = 220;

export function createQueuedFollowupsFeature(options: QueueOptions = {}) {
  // Presentation only: Background remains the sole owner of accepted queues.
  const submissions = new Map<string, Map<string, QueueItem>>();
  const container = options.container || null;
  const getSessionId = options.getSessionId || (() => null);
  const isVisible = options.isVisible || (() => false);
  const getRuntime: NonNullable<QueueOptions["getRuntime"]> = options.getRuntime || (() => ({}));
  const mergeRuntime = options.mergeRuntime || (() => {});
  const normalizePendingFollowUps: NonNullable<QueueOptions["normalizePendingFollowUps"]> = options.normalizePendingFollowUps || (items => Array.isArray(items) ? items : []);
  const normalizePendingSteerings = options.normalizePendingSteerings || normalizePendingFollowUps;
  const settleAfterDockLayout = options.settleAfterDockLayout || (() => {});
  const send = options.send || (() => {});
  const request: NonNullable<QueueOptions["request"]> = options.request || (async () => ({}));
  const showToast = options.showToast || (() => {});
  const now = options.now || (() => new Date().toISOString());
  const restoring = new Set<string>();

  let queuedFollowupDragId = "";
  let queuedFollowupDropTargetId = "";
  let queuedFollowupDropPosition = "";
  const queuedFollowupKnownItemsById = new Map<string, QueueItem>();
  const queuedFollowupSeenIds = new Set<string>();
  const queuedFollowupExitGhosts = new Set<HTMLElement>();
  const queuedFollowupOutgoingBatchById = new Map<string, OutgoingBatch>();
  let queuedFollowupOutgoingBatchSequence = 0;
  let queuedFollowupDrainTimer: ReturnType<typeof setTimeout> | null = null;
  let queuedFollowupAnimationSessionId: string | null = "";
  let queuedFollowupSuppressNextMove = false;
  let queuedFollowupLocalMutationReason = "";
  let queuedFollowupTopDrainState: { id: string; targetItems: QueueItem[] } | null = null;
  let queuedFollowupRenderedSignature = "";

function queuedFollowupLabel(item: QueueItem = {}) {
  const text = String(item.text || "").trim();
  const imageCount = Math.max(0, Number(item.imageCount) || 0);
  const attachmentCount = Math.max(0, Number(item.attachmentCount) || 0);
  const suffix = [imageCount ? t("imageCount", { count: imageCount }) : "", attachmentCount ? t("fileCount", { count: attachmentCount }) : ""]
    .filter(Boolean)
    .join(" · ");
  if (text && suffix) return `${text} · ${suffix}`;
  if (text) return text;
  if (suffix) return suffix;
  return t("followup");
}

function queuedFollowupId(item: QueueItem = {}, index = 0) {
  return normalizeClientMessageId(item.clientMessageId) || `queued-${index}`;
}

function queuedFollowupDomId(id = "") {
  const normalized = normalizeClientMessageId(id);
  return normalized ? `queued-followup-${encodeDomIdPart(normalized)}` : "";
}

function queuedItems(followUps: unknown = [], steerings: unknown = []) {
  return [
    ...normalizePendingSteerings(steerings).map(item => ({ ...item, queueKind: "steering" })),
    ...normalizePendingFollowUps(followUps).map(item => ({ ...item, queueKind: "followup" })),
  ];
}

function queuedItemsFromRuntime(runtime: Partial<ClientRuntime> = {}) {
  return queuedItems(runtime.pendingFollowUps, runtime.pendingSteerings);
}

function isSubmitting(sessionId: unknown, clientMessageId: unknown) {
  return submissions.get(normalizeSessionId(sessionId) || "")?.has(normalizeClientMessageId(clientMessageId)) === true;
}

function stageSubmission(sessionId: string, message: QueueItem) {
  const id = normalizeClientMessageId(message.clientMessageId);
  if (!sessionId || !id) return;
  const pending = submissions.get(sessionId) || new Map<string, QueueItem>();
  pending.set(id, { ...message, clientMessageId: id, queueKind: "followup", submitting: true });
  submissions.set(sessionId, pending);
  if (sessionId === normalizeSessionId(getSessionId())) renderQueuedFollowups();
}

function settleSubmission(sessionId: string | null, clientMessageId: unknown) {
  const session = normalizeSessionId(sessionId), id = normalizeClientMessageId(clientMessageId);
  const pending = session ? submissions.get(session) : undefined;
  if (!session || !pending?.delete(id)) return;
  if (!pending.size) submissions.delete(session);
  if (session === normalizeSessionId(getSessionId())) {
    queuedFollowupLocalMutationReason = "submission";
    renderQueuedFollowups();
  }
}

function displayedQueueItems(sessionId: string | null, runtime: Partial<ClientRuntime>) {
  const items: QueueItem[] = queuedItemsFromRuntime(runtime);
  for (const item of submissions.get(sessionId || "")?.values() || []) {
    const found = items.findIndex(existing => existing.clientMessageId === item.clientMessageId);
    if (found >= 0) items[found] = { ...items[found], submitting: true };
    else items.push(item);
  }
  return items;
}

function queuedFollowupItemsSignature(followUps: unknown = [], steerings: unknown = []) {
  return queueItemsSignature(queuedItems(followUps, steerings));
}

function queuedFollowupRenderSignature(sessionId: string | null = "", items: QueueItem[] = []) {
  const tabKey = isVisible() ? "chat" : "hidden";
  const signature = queueItemsSignature(items);
  return `${tabKey}\u001d${normalizeSessionId(sessionId)}\u001d${signature}`;
}

function clearQueuedFollowupAnimationState() {
  queuedFollowupKnownItemsById.clear();
  queuedFollowupSeenIds.clear();
  queuedFollowupOutgoingBatchById.clear();
  queuedFollowupExitGhosts.forEach(ghost => ghost?.remove?.());
  queuedFollowupExitGhosts.clear();
  queuedFollowupSuppressNextMove = false;
  queuedFollowupTopDrainState = null;
  if (queuedFollowupDrainTimer) {
    clearTimeout(queuedFollowupDrainTimer);
    queuedFollowupDrainTimer = null;
  }
  container?.classList.remove("is-draining");
  container?.style?.removeProperty("--queued-followups-drain-height");
  queuedFollowupRenderedSignature = "";
}

function captureQueuedFollowupSnapshots() {
  const rows = new Map<string, RowSnapshot>();
  if (!container || container.classList.contains("hidden")) {
    return { rows, containerHeight: 0 };
  }
  const containerRect = container.getBoundingClientRect?.();
  container.querySelectorAll<HTMLElement>(".queued-followup").forEach(row => {
    const id = normalizeClientMessageId(row.dataset.clientMessageId);
    if (!id) return;
    const rect = row.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    rows.set(id, { id, rect, node: row.cloneNode(true) as HTMLElement });
  });
  return {
    rows,
    containerHeight: containerRect && containerRect.height > 0 ? containerRect.height : 0,
  };
}

function prepareQueuedFollowupExitNode(node: HTMLElement) {
  node.classList.remove(
    "is-entering",
    "is-dragging",
    "is-drop-before",
    "is-drop-after",
    "is-sending",
    "is-steering-request",
  );
  node.removeAttribute("id");
  node.removeAttribute("draggable");
  node.querySelectorAll("[draggable]").forEach(el => el.removeAttribute("draggable"));
  node.querySelectorAll("button").forEach(button => {
    button.disabled = true;
    button.tabIndex = -1;
  });
  return node;
}

function scheduleQueuedFollowupExitGhostRemoval(ghost: HTMLElement) {
  if (!ghost) return;
  queuedFollowupExitGhosts.add(ghost);
  setTimeout(() => {
    queuedFollowupExitGhosts.delete(ghost);
    ghost.remove();
  }, QUEUED_FOLLOWUP_GHOST_MS + 40);
}

function spawnQueuedFollowupExitGhost(snapshot: RowSnapshot | undefined) {
  if (!snapshot?.node || !snapshot?.rect) return false;
  const ghost = prepareQueuedFollowupExitNode(snapshot.node);
  ghost.classList.add("queued-followup-exit-ghost");
  Object.assign(ghost.style, {
    left: `${Math.round(snapshot.rect.left)}px`,
    top: `${Math.round(snapshot.rect.top)}px`,
    width: `${Math.round(snapshot.rect.width)}px`,
    height: `${Math.round(snapshot.rect.height)}px`,
  });
  document.body.appendChild(ghost);
  scheduleQueuedFollowupExitGhostRemoval(ghost);
  return true;
}

function spawnQueuedFollowupBatchExitGhost(removed: RemovedRow[] = []) {
  const visible = removed.filter((entry): entry is RemovedRow & { snapshot: RowSnapshot } => Boolean(entry?.snapshot?.node && entry?.snapshot?.rect));
  if (visible.length < 2) return false;
  const left = Math.min(...visible.map(entry => entry.snapshot.rect.left));
  const top = Math.min(...visible.map(entry => entry.snapshot.rect.top));
  const right = Math.max(...visible.map(entry => entry.snapshot.rect.right));
  const bottom = Math.max(...visible.map(entry => entry.snapshot.rect.bottom));
  const ghost = document.createElement("div");
  ghost.className = "queued-followup-batch-exit-ghost";
  ghost.dataset.batchSize = String(visible.length);
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(right - left)}px`,
    height: `${Math.round(bottom - top)}px`,
  });
  visible.forEach(({ snapshot }) => {
    const row = prepareQueuedFollowupExitNode(snapshot.node);
    row.classList.add("queued-followup-batch-exit-row");
    Object.assign(row.style, {
      left: `${Math.round(snapshot.rect.left - left)}px`,
      top: `${Math.round(snapshot.rect.top - top)}px`,
      width: `${Math.round(snapshot.rect.width)}px`,
      height: `${Math.round(snapshot.rect.height)}px`,
    });
    ghost.appendChild(row);
  });
  document.body.appendChild(ghost);
  scheduleQueuedFollowupExitGhostRemoval(ghost);
  return true;
}

function rememberQueuedFollowupOutgoingBatch(removed: RemovedRow[] = []) {
  const entries = removed.filter(entry => normalizeClientMessageId(entry?.id));
  if (entries.length < 2) return null;
  const id = `steering-batch-${++queuedFollowupOutgoingBatchSequence}`;
  const size = entries.length;
  entries.forEach((entry, index) => {
    queuedFollowupOutgoingBatchById.set(normalizeClientMessageId(entry.id), { id, index, size });
  });
  return { id, size };
}

function spawnQueuedFollowupExitGhosts(items: QueueItem[] = [], snapshots: QueueSnapshots = { rows: new Map() }) {
  const currentIds = new Set(items.map((item, index) => queuedFollowupId(item, index)));
  const removed = [];
  for (const [id, item] of queuedFollowupKnownItemsById.entries()) {
    if (currentIds.has(id)) continue;
    removed.push({ id, item, snapshot: snapshots.rows.get(id) });
  }
  const isSteeringBatch = removed.length > 1
    && removed.every(entry => entry.item?.queueKind === "steering");
  if (isSteeringBatch) {
    rememberQueuedFollowupOutgoingBatch(removed);
    if (spawnQueuedFollowupBatchExitGhost(removed)) return 1;
  }
  let count = 0;
  for (const entry of removed) {
    if (spawnQueuedFollowupExitGhost(entry.snapshot)) count += 1;
  }
  return count;
}

function rememberQueuedFollowupItems(items: QueueItem[] = []) {
  queuedFollowupKnownItemsById.clear();
  items.forEach((item, index) => {
    queuedFollowupKnownItemsById.set(queuedFollowupId(item, index), item);
  });
}

function queuedFollowupTopDrainInfo(items: QueueItem[] = []) {
  const previousIds = Array.from(queuedFollowupKnownItemsById.keys());
  if (!previousIds.length) return { isTopDrain: false, removedId: "" };
  const currentIds = new Set(items.map((item, index) => queuedFollowupId(item, index)));
  const removedIds = previousIds.filter(id => !currentIds.has(id));
  const removedId = removedIds.length === 1 ? removedIds[0] : "";
  return {
    isTopDrain: Boolean(removedId && removedId === previousIds[0]),
    removedId,
  };
}

function startQueuedFollowupTopDrain(items: QueueItem[] = [], removedId = "") {
  const id = normalizeClientMessageId(removedId);
  if (!container || !id) return false;
  if (queuedFollowupTopDrainState?.id === id) {
    queuedFollowupTopDrainState.targetItems = Array.isArray(items) ? items.map(item => ({ ...item })) : [];
    return true;
  }
  const row = container.querySelector<HTMLElement>(`.queued-followup[data-client-message-id="${cssEscapeValue(id)}"]`);
  if (!row) return false;
  row.classList.remove("is-entering", "is-dragging", "is-drop-before", "is-drop-after");
  row.classList.add("is-sending");
  row.querySelectorAll("[draggable]").forEach(el => el.removeAttribute("draggable"));
  row.querySelectorAll("button").forEach(button => {
    button.disabled = true;
    button.tabIndex = -1;
  });
  queuedFollowupTopDrainState = {
    id,
    targetItems: Array.isArray(items) ? items.map(item => ({ ...item })) : [],
  };
  if (queuedFollowupDrainTimer) clearTimeout(queuedFollowupDrainTimer);
  queuedFollowupDrainTimer = setTimeout(() => {
    queuedFollowupDrainTimer = null;
    const state = queuedFollowupTopDrainState;
    queuedFollowupTopDrainState = null;
    queuedFollowupSuppressNextMove = true;
    rememberQueuedFollowupItems(state?.targetItems || []);
    renderQueuedFollowups();
    settleAfterDockLayout();
  }, QUEUED_FOLLOWUP_GHOST_MS + 24);
  return true;
}

function scheduleQueuedFollowupDrainEnd() {
  if (queuedFollowupDrainTimer) clearTimeout(queuedFollowupDrainTimer);
  queuedFollowupDrainTimer = setTimeout(() => {
    queuedFollowupDrainTimer = null;
    if (!container) return;
    const runtime = getRuntime(getSessionId());
    const hasItems = queuedItemsFromRuntime(runtime).length > 0;
    queuedFollowupSuppressNextMove = true;
    container.classList.remove("is-draining", "is-reserving");
    container.style.removeProperty("--queued-followups-drain-height");
    if (isVisible() && hasItems) {
      renderQueuedFollowups();
      settleAfterDockLayout();
      return;
    }
    if (isVisible() && !hasItems) {
      container.classList.add("hidden");
      container.innerHTML = "";
    }
    settleAfterDockLayout();
  }, QUEUED_FOLLOWUP_GHOST_MS + 24);
}

function animateQueuedFollowupRowsFrom(snapshots: QueueSnapshots = { rows: new Map() }) {
  if (!container) return;
  container.querySelectorAll<HTMLElement>(".queued-followup").forEach(row => {
    const id = normalizeClientMessageId(row.dataset.clientMessageId);
    const previous = id ? snapshots.rows.get(id) : null;
    if (!previous || row.classList.contains("is-entering")) return;
    const rect = row.getBoundingClientRect();
    const dx = previous.rect.left - rect.left;
    const dy = previous.rect.top - rect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    row.style.transition = "none";
    row.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`;
    row.getBoundingClientRect();
    window.requestAnimationFrame?.(() => {
      row.style.transition = `transform ${QUEUED_FOLLOWUP_MOVE_MS}ms var(--ease-emphasized), opacity ${QUEUED_FOLLOWUP_MOVE_MS}ms var(--ease-standard)`;
      row.style.transform = "";
    });
    setTimeout(() => {
      row.style.transition = "";
      row.style.transform = "";
    }, QUEUED_FOLLOWUP_MOVE_MS + 40);
  });
}

function setSessionPendingQueues(sessionId: string | null, {
  followUps,
  steerings,
}: QueuePatch = {}, { reason = "" } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  const isCurrentSession = id === normalizeSessionId(getSessionId());
  if (isCurrentSession) queuedFollowupLocalMutationReason = String(reason || "");
  const previous = getRuntime(id);
  mergeRuntime(id, {
    ...previous,
    ...(followUps !== undefined ? { pendingFollowUps: normalizePendingFollowUps(followUps) } : {}),
    ...(steerings !== undefined ? { pendingSteerings: normalizePendingSteerings(steerings) } : {}),
    updatedAt: now(),
  });
  if (isCurrentSession) renderQueuedFollowups();
}

function setCurrentSessionPendingFollowUps(items: unknown = [], { reason = "" } = {}) {
  setSessionPendingQueues(getSessionId(), { followUps: items }, { reason });
}

function settleQueuedFollowupForAcceptedUserMessage(clientMessageId: unknown = "") {
  const id = normalizeClientMessageId(clientMessageId);
  const sessionId = normalizeSessionId(getSessionId());
  if (!id || !sessionId) return false;
  const pending = submissions.get(sessionId);
  pending?.delete(id);
  if (pending && !pending.size) submissions.delete(sessionId);
  const runtime = getRuntime(sessionId);
  const followUps = normalizePendingFollowUps(runtime.pendingFollowUps);
  const steerings = normalizePendingSteerings(runtime.pendingSteerings);
  const knownQueued = Boolean(
    queuedFollowupKnownItemsById.has(id)
      || queuedFollowupSeenIds.has(id)
      || queuedFollowupTopDrainState?.id === id
      || container?.querySelector?.(`.queued-followup[data-client-message-id="${cssEscapeValue(id)}"]`)
  );
  const nextFollowUps = followUps.filter((item, index) => queuedFollowupId(item, index) !== id);
  const nextSteerings = steerings.filter((item, index) => queuedFollowupId(item, index) !== id);
  if (
    !knownQueued
    && nextFollowUps.length === followUps.length
    && nextSteerings.length === steerings.length
  ) return false;

  const outgoingBatch = queuedFollowupOutgoingBatchById.get(id) || null;
  queuedFollowupOutgoingBatchById.delete(id);
  queuedFollowupSeenIds.delete(id);
  mergeRuntime(sessionId, {
    ...runtime,
    pendingFollowUps: nextFollowUps,
    pendingSteerings: nextSteerings,
    updatedAt: now(),
  });
  if (queuedFollowupDrainTimer) {
    clearTimeout(queuedFollowupDrainTimer);
    queuedFollowupDrainTimer = null;
  }
  queuedFollowupTopDrainState = null;
  queuedFollowupSuppressNextMove = true;
  queuedFollowupRenderedSignature = "";
  rememberQueuedFollowupItems(queuedItems(nextFollowUps, nextSteerings));
  renderQueuedFollowups();
  settleAfterDockLayout();
  return { accepted: true, outgoingBatch };
}

function renderQueuedFollowups() {
  if (!container) return;
  const sessionId = normalizeSessionId(getSessionId());
  if (queuedFollowupAnimationSessionId && queuedFollowupAnimationSessionId !== sessionId) {
    clearQueuedFollowupAnimationState();
  }
  queuedFollowupAnimationSessionId = sessionId;
  const runtime = getRuntime(getSessionId());
  const items = displayedQueueItems(sessionId, runtime);
  const nextSignature = queuedFollowupRenderSignature(sessionId, items);
  const localMutationReason = queuedFollowupLocalMutationReason;
  queuedFollowupLocalMutationReason = "";
  const hasPendingQueueAnimation = Boolean(queuedFollowupTopDrainState || queuedFollowupDrainTimer);
  const hiddenStateMatches = !isVisible()
    ? container.classList.contains("hidden")
    : (items.length > 0 ? !container.classList.contains("hidden") : container.classList.contains("hidden"));
  if (
    queuedFollowupRenderedSignature === nextSignature
    && hiddenStateMatches
    && !localMutationReason
    && !hasPendingQueueAnimation
  ) {
    return;
  }

  const snapshots = captureQueuedFollowupSnapshots();
  const drainInfo = queuedFollowupTopDrainInfo(items);
  const isTopDrain = drainInfo.isTopDrain && !localMutationReason
    && !restoring.has(`${sessionId}:${drainInfo.removedId}`);
  const wasHidden = container.classList.contains("hidden");
  const previousCount = Number(container.dataset.count || 0);
  if (!isVisible()) {
    container.classList.add("hidden");
    container.dataset.count = "0";
    container.innerHTML = "";
    clearQueuedFollowupAnimationState();
    queuedFollowupRenderedSignature = nextSignature;
    if (!wasHidden || previousCount) settleAfterDockLayout();
    return;
  }
  if (isTopDrain && startQueuedFollowupTopDrain(items, drainInfo.removedId)) return;
  const exitingGhostCount = spawnQueuedFollowupExitGhosts(items, snapshots);
  if (!items.length) {
    rememberQueuedFollowupItems(items);
    if (exitingGhostCount > 0 && snapshots.containerHeight > 0) {
      container.classList.remove("hidden");
      container.classList.add("is-draining");
      container.style.setProperty("--queued-followups-drain-height", `${Math.ceil(snapshots.containerHeight)}px`);
      container.dataset.count = "0";
      container.innerHTML = "";
      scheduleQueuedFollowupDrainEnd();
      return;
    }
    container.classList.remove("is-draining");
    container.style.removeProperty("--queued-followups-drain-height");
    container.classList.add("hidden");
    container.dataset.count = "0";
    container.innerHTML = "";
    queuedFollowupRenderedSignature = nextSignature;
    if (!wasHidden || previousCount) settleAfterDockLayout();
    return;
  }
  if (queuedFollowupDrainTimer) {
    clearTimeout(queuedFollowupDrainTimer);
    queuedFollowupDrainTimer = null;
  }
  container.classList.remove("is-draining", "is-reserving");
  container.style.removeProperty("--queued-followups-drain-height");
  container.classList.remove("hidden");
  container.dataset.count = String(items.length);
  const followUps = items.filter(item => item.queueKind === "followup");
  const followUpIndexById = new Map(followUps.map((item, index) => [queuedFollowupId(item, index), index]));
  container.innerHTML = items.map((item, index) => {
    const id = queuedFollowupId(item, index);
    const label = queuedFollowupLabel(item);
    const isSteering = item.queueKind === "steering";
    const followUpIndex = followUpIndexById.get(id) ?? -1;
    const meta = isSteering
      ? t("steer")
      : String(followUpIndex + 1).padStart(2, "0");
    const classes = [
      "queued-followup",
      isSteering ? "is-steering" : "is-followup",
      !queuedFollowupSeenIds.has(id) ? "is-entering" : "",
    ].filter(Boolean).join(" ");
    const domId = queuedFollowupDomId(id);
    return `
      <div class="${classes}"${domId ? ` id="${escapeHtml(domId)}"` : ""} data-client-message-id="${escapeHtml(id)}" data-queue-kind="${item.queueKind}"${item.submitting ? ' data-submitting="true"' : ""}>
        ${isSteering
          ? `<span class="queued-followup-steering-mark" aria-hidden="true">${steeringMarkIcon()}</span>`
          : `<span class="queued-followup-drag" draggable="${!item.submitting}" aria-hidden="true">${dragGripIcon()}</span>`}
        <span class="queued-followup-copy">
          <span class="queued-followup-text" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          ${isSteering ? "" : `<span class="queued-followup-meta">${escapeHtml(meta)}</span>`}
        </span>
        <span class="queued-followup-actions">
          ${isSteering
            ? `<span class="queued-followup-steering-state"><span class="queued-followup-meta">${escapeHtml(meta)}</span></span>`
            : `
            <button class="qz-btn qz-btn--ghost qz-btn--xs queued-followup-steer" type="button" data-steer-follow-up="${escapeHtml(id)}" title="${tHtml("convertToSteering")}" aria-label="${tHtml("convertToSteering")}"${item.submitting ? " disabled" : ""}>${steerActionIcon()}<span>${tHtml("steer")}</span></button>
          `}
          <button class="qz-icon-btn qz-icon-btn--xs queued-followup-delete" type="button" ${isSteering ? `data-delete-steering="${escapeHtml(id)}"` : `data-delete-follow-up="${escapeHtml(id)}"`} title="${tHtml("edit")}" aria-label="${tHtml("edit")}"${item.submitting ? " disabled" : ""}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5" />
            </svg>
          </button>
        </span>
      </div>
    `;
  }).join("");
  if (!isTopDrain && !queuedFollowupSuppressNextMove) animateQueuedFollowupRowsFrom(snapshots);
  queuedFollowupSuppressNextMove = false;
  const shouldReserveOldQueueHeight = exitingGhostCount > 0 && snapshots.containerHeight > 0;
  if (shouldReserveOldQueueHeight) {
    container.classList.add("is-reserving");
    container.style.setProperty("--queued-followups-drain-height", `${Math.ceil(snapshots.containerHeight)}px`);
    scheduleQueuedFollowupDrainEnd();
  } else {
    container.classList.remove("is-reserving");
  }
  rememberQueuedFollowupItems(items);
  for (const item of items) queuedFollowupSeenIds.add(queuedFollowupId(item));
  queuedFollowupRenderedSignature = nextSignature;
  if (!shouldReserveOldQueueHeight && (wasHidden || previousCount !== items.length)) settleAfterDockLayout();
}

function moveQueuedFollowup(items: QueueItem[], draggedId: string, targetId: string, position = "before") {
  const sourceId = normalizeClientMessageId(draggedId);
  const destId = normalizeClientMessageId(targetId);
  if (!sourceId) return items;
  if (sourceId && destId && sourceId === destId) return items;
  const next = items.filter(item => item.clientMessageId !== sourceId);
  const dragged = items.find(item => item.clientMessageId === sourceId);
  if (!dragged) return items;
  const targetIndex = destId ? next.findIndex(item => item.clientMessageId === destId) : -1;
  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  if (targetIndex >= 0) next.splice(insertIndex, 0, dragged);
  else next.push(dragged);
  return next.map((item, index) => ({ ...item, index }));
}

function clearQueuedFollowupDropState() {
  queuedFollowupDropTargetId = "";
  queuedFollowupDropPosition = "";
  container?.classList.remove("is-reordering");
  container?.querySelectorAll(".queued-followup.is-drop-before, .queued-followup.is-drop-after").forEach(row => {
    row.classList.remove("is-drop-before", "is-drop-after");
  });
}

function queuedFollowupDropPositionForEvent(event: DragEvent, row: HTMLElement | null | undefined) {
  const rect = row?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.height)) return "before";
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function updateQueuedFollowupDropState(row: HTMLElement | null, position: string) {
  if (!container) return;
  const targetId = normalizeClientMessageId(row?.dataset?.clientMessageId);
  if (!row || !targetId || targetId === queuedFollowupDragId) {
    clearQueuedFollowupDropState();
    if (queuedFollowupDragId) container.classList.add("is-reordering");
    return;
  }
  if (targetId === queuedFollowupDropTargetId && position === queuedFollowupDropPosition) return;
  container.classList.add("is-reordering");
  container.querySelectorAll(".queued-followup.is-drop-before, .queued-followup.is-drop-after").forEach(el => {
    if (el !== row) el.classList.remove("is-drop-before", "is-drop-after");
  });
  row.classList.toggle("is-drop-before", position === "before");
  row.classList.toggle("is-drop-after", position === "after");
  queuedFollowupDropTargetId = targetId;
  queuedFollowupDropPosition = position;
}

container?.addEventListener("click", async (event) => {
  const steerButton = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("[data-steer-follow-up]");
  if (steerButton) {
    const sessionId = normalizeSessionId(getSessionId());
    const clientMessageId = normalizeClientMessageId(steerButton.dataset.steerFollowUp);
    if (!sessionId || !clientMessageId || steerButton.disabled) return;
    steerButton.disabled = true;
    steerButton.closest(".queued-followup")?.classList.add("is-steering-request");
    try {
      const result = await request("steer_follow_up", { sessionId, clientMessageId });
      const latest = getRuntime(sessionId);
      const pendingFollowUps = Array.isArray(result?.pendingFollowUps)
        ? normalizePendingFollowUps(result.pendingFollowUps)
        : normalizePendingFollowUps(latest.pendingFollowUps);
      const pendingSteerings = Array.isArray(result?.pendingSteerings)
        ? normalizePendingSteerings(result.pendingSteerings)
        : normalizePendingSteerings(latest.pendingSteerings);
      if (result?.moved) {
        const existing = normalizePendingFollowUps(latest.pendingFollowUps)
          .find(item => item.clientMessageId === clientMessageId);
        const alreadySteering = pendingSteerings.some(item => item.clientMessageId === clientMessageId);
        setSessionPendingQueues(sessionId, {
          followUps: pendingFollowUps.filter(item => item.clientMessageId !== clientMessageId),
          steerings: existing && !alreadySteering ? [...pendingSteerings, existing] : pendingSteerings,
        }, { reason: "steer" });
      } else {
        if (Array.isArray(result?.pendingFollowUps) || Array.isArray(result?.pendingSteerings)) {
          setSessionPendingQueues(sessionId, {
            followUps: pendingFollowUps,
            steerings: pendingSteerings,
          }, { reason: "sync" });
        } else {
          steerButton.disabled = false;
          steerButton.closest(".queued-followup")?.classList.remove("is-steering-request");
        }
        showToast(t("requestAlreadyStarted"), { anchorEl: steerButton });
      }
    } catch (error) {
      steerButton.disabled = false;
      steerButton.closest(".queued-followup")?.classList.remove("is-steering-request");
      showToast(error instanceof Error ? error.message : t("steerFailed"), { tone: "error", anchorEl: steerButton });
    }
    return;
  }

  const followUpDeleteButton = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("[data-delete-follow-up]");
  const steeringDeleteButton = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>("[data-delete-steering]");
  const button = followUpDeleteButton || steeringDeleteButton;
  if (!button || button.disabled) return;
  const sessionId = normalizeSessionId(getSessionId());
  const clientMessageId = normalizeClientMessageId(
    followUpDeleteButton ? button.dataset.deleteFollowUp : button.dataset.deleteSteering,
  );
  const key = `${sessionId}:${clientMessageId}`;
  if (!clientMessageId || !sessionId || restoring.has(key) || !options.restoreQueuedMessage) return;
  restoring.add(key);
  button.disabled = true;
  try {
    const result = await options.restoreQueuedMessage(sessionId, clientMessageId, followUpDeleteButton ? "followup" : "steering");
    if (result.restored) {
      const runtime = getRuntime(sessionId);
      setSessionPendingQueues(sessionId, followUpDeleteButton ? {
        followUps: normalizePendingFollowUps(runtime.pendingFollowUps).filter(item => item.clientMessageId !== clientMessageId),
      } : {
        steerings: normalizePendingSteerings(runtime.pendingSteerings).filter(item => item.clientMessageId !== clientMessageId),
      }, { reason: "delete" });
    } else if (!result.busy && sessionId === normalizeSessionId(getSessionId())) {
      showToast(t("requestAlreadyStarted"), { anchorEl: button });
    }
  } catch (error) {
    if (sessionId === normalizeSessionId(getSessionId())) showToast(String(error instanceof Error ? error.message : error), { tone: "error", anchorEl: button });
  } finally {
    restoring.delete(key);
    button.disabled = false;
  }
});

container?.addEventListener("dragstart", (event) => {
  const handle = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".queued-followup-drag");
  const row = handle?.closest<HTMLElement>(".queued-followup");
  if (!row || row.dataset.queueKind !== "followup" || row.dataset.submitting === "true") return;
  queuedFollowupDragId = normalizeClientMessageId(row.dataset.clientMessageId);
  container.classList.add("is-reordering");
  row.classList.add("is-dragging");
  event.dataTransfer?.setData("text/plain", queuedFollowupDragId);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    const rect = row.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const offsetY = Math.max(0, Math.min(event.clientY - rect.top, rect.height));
    event.dataTransfer.setDragImage?.(row, offsetX, offsetY);
  }
});

container?.addEventListener("dragover", (event) => {
  if (!queuedFollowupDragId) return;
  event.preventDefault();
  const row = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".queued-followup");
  if (!row || row.dataset.queueKind !== "followup") {
    clearQueuedFollowupDropState();
    container.classList.add("is-reordering");
    return;
  }
  updateQueuedFollowupDropState(row, queuedFollowupDropPositionForEvent(event, row));
});

container?.addEventListener("drop", (event) => {
  if (!queuedFollowupDragId || !getSessionId()) return;
  event.preventDefault();
  const row = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".queued-followup");
  const targetId = row?.dataset.queueKind === "followup"
    ? normalizeClientMessageId(row.dataset.clientMessageId)
    : "";
  const runtime = getRuntime(getSessionId());
  const position = queuedFollowupDropPosition || queuedFollowupDropPositionForEvent(event, row);
  const next = moveQueuedFollowup(normalizePendingFollowUps(runtime.pendingFollowUps), queuedFollowupDragId, targetId, position);
  const previousIds = normalizePendingFollowUps(runtime.pendingFollowUps).map(item => item.clientMessageId).join("\n");
  const nextIds = next.map(item => item.clientMessageId).join("\n");
  clearQueuedFollowupDropState();
  queuedFollowupDragId = "";
  if (previousIds === nextIds) {
    renderQueuedFollowups();
    return;
  }
  setCurrentSessionPendingFollowUps(next, { reason: "reorder" });
  send({
    type: "reorder_follow_ups",
    sessionId: getSessionId(),
    clientMessageIds: next.map(item => item.clientMessageId).filter(Boolean),
  });
});

container?.addEventListener("dragend", () => {
  queuedFollowupDragId = "";
  clearQueuedFollowupDropState();
  container.querySelectorAll<HTMLElement>(".queued-followup").forEach(row => {
    row.classList.remove("is-dragging");
  });
});

  return {
    stageSubmission, settleSubmission, isSubmitting,
    forgetSession: (sessionId: string) => { submissions.delete(sessionId); },
    itemsSignature: queuedFollowupItemsSignature,
    render: renderQueuedFollowups,
    set: setCurrentSessionPendingFollowUps,
    setQueues: ({ followUps, steerings }: QueuePatch = {}, options: { reason?: string } = {}) => (
      setSessionPendingQueues(getSessionId(), { followUps, steerings }, options)
    ),
    settleAccepted: settleQueuedFollowupForAcceptedUserMessage,
    clearAnimationState: clearQueuedFollowupAnimationState,
  };
}

function steeringMarkIcon() {
  return `
    <svg viewBox="0 0 16 16">
      <path d="M3.25 3.25v4.2c0 2.05 1.55 3.55 3.6 3.55h5.75" />
      <path d="m10.15 8.55 2.45 2.45-2.45 2.45" />
    </svg>
  `;
}

function dragGripIcon() {
  return `
    <svg viewBox="0 0 16 16">
      <circle cx="5.2" cy="4.25" r="1" />
      <circle cx="10.8" cy="4.25" r="1" />
      <circle cx="5.2" cy="8" r="1" />
      <circle cx="10.8" cy="8" r="1" />
      <circle cx="5.2" cy="11.75" r="1" />
      <circle cx="10.8" cy="11.75" r="1" />
    </svg>
  `;
}

function steerActionIcon() {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 4.25v3.1c0 2 1.55 3.45 3.55 3.45h6.3" />
      <path d="m10.35 8.55 2.25 2.25-2.25 2.25" />
    </svg>
  `;
}


function normalizeClientMessageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function encodeDomIdPart(value: unknown) {
  return encodeURIComponent(String(value || ""))
    .replace(/%/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_");
}

function cssEscapeValue(value: unknown) {
  if (typeof window.CSS?.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function queueItemsSignature(items: QueueItem[]) {
  return items.map(item => [
    item.queueKind,
    normalizeClientMessageId(item.clientMessageId),
    String(item.text || ""),
    Math.max(0, Number(item.imageCount) || 0),
    Math.max(0, Number(item.attachmentCount) || 0),
    Boolean(item.submitting),
  ].join("\u001f")).join("\u001e");
}

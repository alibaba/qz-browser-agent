import { requestBrowserPermission, permissionT } from "#sdk/sidepanel/browser-permissions";
import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import type { UiSessionPort } from "#sdk/sidepanel";
import { stringSessionId as normalizeSessionId } from "#sdk/sidepanel/sessions";
import type { ArtifactItem, ArtifactSummary } from "./artifact-model.js";
import type { SessionMetadata } from "#sdk/shared/sessions";
import type { SessionListSummary } from "#sdk/shared/sessions";
import type { TranscriptEntry } from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ClientRuntime } from "#sdk/sidepanel/sessions";
import type { UiEvent as PortMessage } from "#sdk/sidepanel";
interface HydrationState { marker: string; loaded: boolean; refreshing: boolean; summary: ArtifactSummary | null; signature: string; total: number }
type Summary = Partial<ArtifactSummary>;
export interface ArtifactTranscriptEntry extends Omit<TranscriptEntry, "summary"> { type: "artifacts"; sessionId: string; summary: Summary }
type Session = Partial<SessionMetadata>;
type Schedule = (options?: { delay?: number; immediate?: boolean }) => void;
interface ArtifactOptions {
  signal?: AbortSignal;
  root?: Document;
  request(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
  send?(message: PortMessage): unknown;
  sessionState: Pick<UiSessionPort, "getRecord" | "mergeRecord">;
  getTranscript?(id: string): TranscriptEntry[];
  hasTranscript?(id: string): boolean;
  getRuntime?(id: string): Partial<ClientRuntime>;
  isRuntimeRunning?(runtime: Partial<ClientRuntime>): boolean;
  isCurrentSession?(id: string): boolean;
  isCurrentRunActive?(): boolean; isChatActive?(): boolean; isSessionsActive?(): boolean;
  isManualSessionsMode?(): boolean; isAutomationSessionsMode?(): boolean; isDeletedSession?(id: string): boolean;
  getCurrentSessionId?(): string | null; getCurrentSessionTitle?(): string;
  renderChat?(id: string, options: { force: boolean }): void;
  scheduleTranscriptRender?(id: string, options: { delay: number }): void;
  scheduleSessionsRefresh?: Schedule; scheduleAutomationsRefresh?: Schedule;
  clearTranscriptInlineActions?(element: HTMLElement): void;
  showToast?: UiExtensionAPI["showToast"];
  appendSystemNote?(message: string): void;
  openTable(name: string, options: { anchorEl: HTMLElement | null }): unknown;
}
import { readStoredTranscript } from "#sdk/shared/sessions";
import {
  getSessions,
} from "#sdk/shared/sessions";
import {
  normalizeSessionListSummary,
  SESSION_LIST_SUMMARY_VERSION,
} from "#sdk/shared/sessions";
import { escapeHtml, hashText } from "#sdk/sidepanel/dom";
import { createArtifactModel } from "./artifact-model.js";

const ARTIFACT_TRANSCRIPT_EXIT_MS = 220;

export function createArtifactsFeature(options: ArtifactOptions) {
  const root = options.root || document;
  const lifetime = options.signal;
  const $ = (selector: string) => root.querySelector<HTMLElement>(selector);
  const request = options.request;
  const send = options.send || (() => {});
  const sessionState = options.sessionState;
  const sessionTranscript = options.getTranscript || (() => []);
  const hasSessionTranscript = options.hasTranscript || (() => false);
  const getSessionRuntime = options.getRuntime || (() => ({}));
  const isSessionRuntimeRunning = options.isRuntimeRunning || (() => false);
  const isCurrentSessionId = options.isCurrentSession || (() => false);
  const isCurrentRunActive = options.isCurrentRunActive || (() => false);
  const isChatActive = options.isChatActive || (() => false);
  const isSessionsActive = options.isSessionsActive || (() => false);
  const isManualSessionsMode = options.isManualSessionsMode || (() => false);
  const isAutomationSessionsMode = options.isAutomationSessionsMode || (() => false);
  const isDeletedSession = options.isDeletedSession || (() => false);
  const getCurrentSessionId = options.getCurrentSessionId || (() => "");
  const getCurrentSessionTitle = options.getCurrentSessionTitle || (() => "");
  const renderChatTranscript = options.renderChat || (() => {});
  const scheduleTranscriptCacheRender = options.scheduleTranscriptRender || (() => {});
  const scheduleSessionsListRefresh = options.scheduleSessionsRefresh || (() => {});
  const scheduleAutomationsRefresh = options.scheduleAutomationsRefresh || (() => {});
  const clearTranscriptInlineActions = options.clearTranscriptInlineActions || (() => {});
  const showCaseToast = options.showToast || (() => {});
  const appendSystemNote = options.appendSystemNote || (() => {});
  const openTable = options.openTable;

  if (typeof request !== "function") throw new Error("artifacts request adapter is required");
  if (!sessionState) throw new Error("artifacts session state is required");

  const artifactsPanel = $("#artifacts-panel");
  const artifactsSessionTitleEl = $("#artifacts-session-title");
  const artifactsBodyEl = $("#artifacts-body");
  const btnCloseArtifacts = $("#btn-close-artifacts");
  let artifactsPanelSessionId = "";
  let artifactsPanelRenderSeq = 0;
  const artifactCardSuppressedBySessionId = new Map<string, { marker: string; updatedAt: number }>();
  const sessionListArtifactHydrationStateBySessionId = new Map<string, HydrationState>();
  const sessionListArtifactHydrationQueue = new Map<string, { id: string; marker: string }>();
  const sessionListArtifactHydratingIds = new Set<string>();
  let sessionListArtifactHydrationTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionListSummaryBackfillQueue = new Map<string, string>();
  const sessionListSummaryBackfillingIds = new Set<string>();
  let sessionListSummaryBackfillTimer: ReturnType<typeof setTimeout> | null = null;

  const model = createArtifactModel({ getTranscript: sessionTranscript, request });

function settleArtifactTailForTerminalSession(sessionId: unknown = "", { renderCurrent = true } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || lifetime?.aborted || isDeletedSession(id)) return;
  releaseArtifactCardSuppression(id);
  handleSessionResourcesChanged(id, { renderCurrent });
  if (renderCurrent && isCurrentSessionId(id)) {
    if (isChatActive()) renderChatTranscript(id, { force: true });
    else scheduleTranscriptCacheRender(id, { delay: 0 });
  }
  renderArtifactsPanelIfOpen(id);
  scheduleSessionsListRefresh({ delay: 0 });
}

function handleSessionResourcesChanged(sessionId = "", { renderCurrent = true } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || lifetime?.aborted || isDeletedSession(id)) return;
  markSessionListArtifactSummaryRefreshing(id);
  requestSessionArtifactHydration(id, { renderCurrent, refresh: true });
}

function markSessionListArtifactSummaryRefreshing(sessionId = "", { marker = "" } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || lifetime?.aborted || isDeletedSession(id)) return;
  const previous = sessionListArtifactHydrationStateBySessionId.get(id);
  sessionListArtifactHydrationStateBySessionId.set(id, {
    marker: String(marker || previous?.marker || ""),
    loaded: Boolean(previous?.loaded || previous?.summary),
    refreshing: true,
    summary: previous?.summary || null,
    signature: previous?.signature || "",
    total: Number(previous?.total || previous?.summary?.total || 0),
  });
}

function requestSessionArtifactHydration(sessionId = "", { renderCurrent = true, refresh = true } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || lifetime?.aborted || isDeletedSession(id)) return;
  if (!refresh && sessionListArtifactHydrationStateBySessionId.get(id)?.loaded) return;
  if (sessionListArtifactHydratingIds.has(id)) return;
  const previous = sessionListArtifactHydrationStateBySessionId.get(id);
  sessionListArtifactHydratingIds.add(id);
  hydrateSessionArtifactSummary(id, { refresh }).then((summary) => {
    if (lifetime?.aborted || isDeletedSession(id)) return;
    const next = sessionListArtifactHydrationStateBySessionId.get(id);
    const changed = (previous?.signature || "") !== (next?.signature || "")
      || Number(previous?.total || 0) !== Number(next?.total || 0)
      || Boolean(previous?.refreshing);
    if (!changed && !summary?.total) return;
    if (renderCurrent && isCurrentSessionId(id) && isChatActive() && (summary?.total || previous?.total)) {
      renderChatTranscript(id, { force: true });
    }
    renderArtifactsPanelIfOpen(id);
    scheduleSessionsListRefresh({ delay: 80 });
    if (isAutomationSessionsMode()) scheduleAutomationsRefresh({ delay: 80 });
  }).catch(() => {}).finally(() => {
    sessionListArtifactHydratingIds.delete(id);
  });
}

function withArtifactsTranscriptEntry(history: TranscriptEntry[], sessionId = "") {
  const id = normalizeSessionId(sessionId);
  const base = Array.isArray(history) ? history : [];
  if (!id) return base;
  if (!isArtifactRoundComplete(id)) return base;
  const localSummary = model.collectSessionArtifacts(id, base);
  const hydration = sessionListArtifactHydrationStateBySessionId.get(id);
  if (!hydration?.loaded) {
    if (!localSummary.total) return base;
    return [...base, createArtifactsTranscriptEntry(id, localSummary)];
  }
  const summary = getMergedSessionArtifactSummary(id, localSummary);
  if (!summary?.total) return base;
  return [...base, createArtifactsTranscriptEntry(id, summary)];
}

function createArtifactsTranscriptEntry(sessionId = "", summary: Summary = {}): ArtifactTranscriptEntry {
  const id = normalizeSessionId(sessionId);
  return {
    type: "artifacts",
    sessionId: id,
    summary,
    _uiKey: `${id}:artifacts`,
  };
}

function scheduleMissingSessionArtifactHydration(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id || !isArtifactRoundComplete(id)) return;
  if (sessionListArtifactHydrationStateBySessionId.get(id)?.loaded) return;
  if (sessionListArtifactHydratingIds.has(id)) return;
  requestSessionArtifactHydration(id, { renderCurrent: true });
}

function isArtifactRoundComplete(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id) return false;
  if (isArtifactCardSuppressed(id)) return false;
  if (isCurrentSessionId(id) && isCurrentRunActive()) return false;
  return !isSessionRuntimeRunning(getSessionRuntime(id));
}

function suppressArtifactCardUntilRunSettles(sessionId: unknown = "", marker = "") {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  artifactCardSuppressedBySessionId.set(id, {
    marker: String(marker || ""),
    updatedAt: Date.now(),
  });
}

function releaseArtifactCardSuppression(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id) return;
  artifactCardSuppressedBySessionId.delete(id);
}

function isArtifactCardSuppressed(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  return Boolean(id && artifactCardSuppressedBySessionId.has(id));
}

function showArtifactToast(message = "", anchorEl: Element | null = null) {
  showCaseToast(String(message || t("thisArtifactWasDeletedOrIsCurrentlyUnavailable")).trim(), { tone: "warning", anchorEl });
}

function retireArtifactsTranscriptElement(el: HTMLElement | null) {
  if (!el || el.dataset.artifactExiting === "true") return;
  el.dataset.artifactExiting = "true";
  el.classList.add("msg-artifacts-exiting");
  const remove = () => {
    if (el.dataset.artifactExiting === "true") el.remove();
  };
  el.addEventListener("transitionend", remove, { once: true, signal: lifetime });
  setTimeout(remove, ARTIFACT_TRANSCRIPT_EXIT_MS + 80);
}

function normalizeArtifactSummary(value: unknown): Summary {
  const input = record(value);
  return {
    sessionId: String(input.sessionId || ""), signature: String(input.signature || ""), total: Number(input.total || 0),
    data: (Array.isArray(input.data) ? input.data : []).map(model.normalizeArtifactSummaryDataItem).filter((item): item is ArtifactItem => item !== null),
    files: (Array.isArray(input.files) ? input.files : []).map(model.normalizeArtifactSummaryFileItem).filter((item): item is ArtifactItem => item !== null),
  };
}

function createArtifactsTranscriptElement(entry: TranscriptEntry) {
  const summary = normalizeArtifactSummary(entry.summary);
  const div = document.createElement("div");
  div.className = "msg msg-artifacts";
  div.dataset.chatLane = "summary";
  delete div.dataset.artifactExiting;
  div.dataset.artifactsSignature = summary.signature || "";
  div.innerHTML = renderArtifactsTranscriptHtml(summary);
  return div;
}

function patchArtifactsTranscriptElement(el: HTMLElement, entry: TranscriptEntry) {
  const summary = normalizeArtifactSummary(entry.summary);
  const signature = summary.signature || "";
  el.className = "msg msg-artifacts";
  el.dataset.chatLane = "summary";
  delete el.dataset.artifactExiting;
  if (el.dataset.artifactsSignature === signature) return true;
  el.dataset.artifactsSignature = signature;
  el.innerHTML = renderArtifactsTranscriptHtml(summary);
  clearTranscriptInlineActions(el);
  return true;
}

function renderArtifactsTranscriptHtml(summary: Summary = {}) {
  const items = artifactCompactItems(summary).slice(0, 3);
  const itemRows = items.map(item => {
    const actionAttrs = artifactStripItemActionAttributes(item, summary);
    const clickable = Boolean(actionAttrs);
    return `
    <div class="artifact-strip-item ${clickable ? "clickable" : ""}"${clickable ? ` role="button" tabindex="0"${actionAttrs}` : ""}>
        <span class="artifact-strip-kind">${escapeHtml(artifactTypeLabel(item.type, item))}</span>
        <span class="artifact-strip-name" title="${escapeHtmlAttribute(item.title)}">
          <span>${escapeHtml(item.title)}</span>
        <small>${escapeHtml(model.artifactMetaWithTime(item))}</small>
      </span>
    </div>
  `;
  }).join("");
  const preview = artifactPreviewText(summary);
  return `
    <section class="artifact-strip" aria-label="${escapeHtmlAttribute(t("taskArtifacts"))}">
      <div class="artifact-strip-main">
        <div class="artifact-strip-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none"><path d="M4 2.8h5.2L12 5.6v7.6H4V2.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 3v3h3M6 8h4M6 10.5h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="artifact-strip-copy">
          <div class="artifact-strip-title-row">
            <span class="artifact-strip-title">${escapeHtml(t("artifacts"))}</span>
            <span class="artifact-strip-count">${Number(summary.total || 0)}</span>
          </div>
          <div class="artifact-strip-preview" title="${escapeHtmlAttribute(preview)}">${escapeHtml(preview)}</div>
        </div>
        <button class="qz-icon-btn qz-icon-btn--xs artifact-strip-open" type="button" data-artifact-action="open-panel" data-session-id="${escapeHtmlAttribute(summary.sessionId || "")}" title="${escapeHtmlAttribute(t("openTaskArtifactsAction"))}" aria-label="${escapeHtmlAttribute(t("openTaskArtifactsAction"))}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      ${itemRows ? `<div class="artifact-strip-items">${itemRows}</div>` : ""}
      <div class="artifact-strip-actions">
        <button class="qz-btn qz-btn--ghost qz-btn--inline artifact-solid-btn" type="button" data-artifact-action="open-panel" data-session-id="${escapeHtmlAttribute(summary.sessionId || "")}">${escapeHtml(t("openArtifact"))}</button>
      </div>
    </section>
  `;
}

function artifactStripItemActionAttributes(item: Partial<ArtifactItem> = {}, summary: Summary = {}) {
  const sessionId = summary.sessionId || "";
  if (item.type === "data" && canOpenDataArtifact(item)) return dataArtifactActionAttributes(item, sessionId);
  if (item.type === "file" && canOpenFileArtifact(item)) return fileArtifactActionAttributes(item, sessionId);
  return "";
}

function artifactCompactItems(summary: Summary = {}) {
  return [
    ...(Array.isArray(summary.data) ? summary.data : []),
    ...(Array.isArray(summary.files) ? summary.files : []),
  ].sort(model.compareArtifactItems);
}

function artifactPreviewText(summary: unknown = {}) {
  const names = artifactCompactItems(normalizeArtifactSummary(summary))
    .map(item => item.title)
    .filter(Boolean)
    .slice(0, 4);
  return names.join(" · ") || t("archived");
}

function getSessionListArtifactSummary(sessionId: unknown) {
  const id = normalizeSessionId(sessionId);
  if (!id) return null;
  const hydration = sessionListArtifactHydrationStateBySessionId.get(id);
  if (!hydration?.loaded) {
    requestSessionArtifactHydration(id, { renderCurrent: false });
    const stale = hydration?.summary ? getMergedSessionArtifactSummary(id, model.collectSessionArtifacts(id)) : null;
    return stale?.total ? stale : null;
  }
  const summary = getMergedSessionArtifactSummary(id, model.collectSessionArtifacts(id));
  return summary?.total ? summary : null;
}

function getMergedSessionArtifactSummary(sessionId = "", localSummary: ArtifactSummary | null = null) {
  const id = normalizeSessionId(sessionId);
  if (!id) return null;
  const cached = sessionListArtifactHydrationStateBySessionId.get(id)?.summary || null;
  return model.mergeArtifactSummaries(id, localSummary || model.collectSessionArtifacts(id), cached);
}

function sessionListArtifactStatsText(summary: Summary = {}) {
  const parts = [
    summary.data?.length ? t("tables", { count: String(summary.data.length) }) : "",
    summary.files?.length ? t("files", { count: String(summary.files.length) }) : "",
  ].filter(Boolean);
  return parts.join(" · ") || t("items", { count: String(Number(summary.total || 0)) });
}

function renderSessionArtifactChip(summary: Summary = {}) {
  const count = Number(summary.total || 0);
  if (!count) return "";
  return `
    <button class="qz-pill session-artifact-chip" type="button" data-session-action="artifacts" data-id="${escapeHtmlAttribute(summary.sessionId || "")}" title="${escapeHtmlAttribute(t("openTaskArtifactsAction"))}" aria-label="${escapeHtmlAttribute(t("openTaskArtifactCount", { count }))}">
      <span>${escapeHtml(t("artifacts"))}</span>
      <span class="session-artifact-chip-count">${count}</span>
    </button>
  `;
}

function sessionArtifactHydrationMarker(session: Session = {}) {
  return String(session.updatedAt || session.createdAt || "");
}

function scheduleSessionListSummaryBackfill(list: Session[] = []) {
  if (!isSessionsActive() || !isManualSessionsMode()) return;
  const sessions = Array.isArray(list) ? list : [];
  for (const session of sessions.slice(0, 80)) {
    const id = normalizeSessionId(session?.id);
    if (!id || isDeletedSession(id)) continue;
    if (!isSessionListSummaryStale(session?.listSummary)) continue;
    if (sessionListSummaryBackfillingIds.has(id)) continue;
    sessionListSummaryBackfillQueue.set(id, id);
  }
  if (!sessionListSummaryBackfillQueue.size || sessionListSummaryBackfillTimer) return;
  sessionListSummaryBackfillTimer = setTimeout(() => {
    sessionListSummaryBackfillTimer = null;
    hydrateQueuedSessionListSummaries();
  }, 180);
}

async function hydrateQueuedSessionListSummaries() {
  if (lifetime?.aborted || !sessionListSummaryBackfillQueue.size) return;
  const ids = Array.from(sessionListSummaryBackfillQueue.values()).slice(0, 24);
  for (const id of ids) {
    sessionListSummaryBackfillQueue.delete(id);
    sessionListSummaryBackfillingIds.add(id);
  }
  try {
    await request("hydrate_session_list_summaries", {
      sessionIds: ids,
      limit: ids.length,
    }, 12000);
  } catch (_err) {
    // Backfill is best-effort; the list can render from base session metadata.
  } finally {
    for (const id of ids) sessionListSummaryBackfillingIds.delete(id);
  }
  if (sessionListSummaryBackfillQueue.size && isSessionsActive() && isManualSessionsMode()) {
    sessionListSummaryBackfillTimer = setTimeout(() => {
      sessionListSummaryBackfillTimer = null;
      hydrateQueuedSessionListSummaries();
    }, 260);
  }
}

function isSessionListSummaryStale(value: unknown = {}) {
  const summary = record(value);
  const normalized = normalizeSessionListSummary(summary);
  if (summary?.version !== SESSION_LIST_SUMMARY_VERSION || !normalized.updatedAt) return true;
  return hasRepeatedArtifactPreviewTokens(normalized);
}

function hasRepeatedArtifactPreviewTokens(summary: Partial<SessionListSummary> = {}) {
  const count = Number(summary.artifactCount || 0);
  if (count <= 1) return false;
  const tokens = String(summary.artifactPreview || "")
    .split("·")
    .map(token => token.trim())
    .filter(Boolean);
  return tokens.length > 1 && new Set(tokens).size < tokens.length;
}

function scheduleSessionListArtifactHydration(list: Session[] = []) {
  if (!isSessionsActive()) return;
  const sessions = Array.isArray(list) ? list : [];
  for (const session of sessions.slice(0, 80)) {
    const id = normalizeSessionId(session?.id);
    if (!id || isDeletedSession(id)) continue;
    if (isSessionRuntimeRunning(getSessionRuntime(id))) continue;
    const marker = sessionArtifactHydrationMarker(session);
    const state = sessionListArtifactHydrationStateBySessionId.get(id);
    if (sessionListArtifactHydratingIds.has(id)) continue;
    if (state?.loaded && state.marker === marker) continue;
    sessionListArtifactHydrationQueue.set(id, { id, marker });
  }
  if (!sessionListArtifactHydrationQueue.size || sessionListArtifactHydrationTimer) return;
  sessionListArtifactHydrationTimer = setTimeout(() => {
    sessionListArtifactHydrationTimer = null;
    hydrateQueuedSessionListArtifacts();
  }, 60);
}

async function hydrateQueuedSessionListArtifacts() {
  if (lifetime?.aborted || !sessionListArtifactHydrationQueue.size) return;
  const batch = Array.from(sessionListArtifactHydrationQueue.values()).slice(0, 16);
  for (const item of batch) {
    sessionListArtifactHydrationQueue.delete(item.id);
    sessionListArtifactHydratingIds.add(item.id);
  }

  let shouldRefresh = false;
  await Promise.all(batch.map(async ({ id, marker }) => {
    const previous = sessionListArtifactHydrationStateBySessionId.get(id);
    try {
      const summary = await hydrateSessionArtifactSummary(id, { marker, refresh: true });
      if (lifetime?.aborted || isDeletedSession(id)) return;
      const next = sessionListArtifactHydrationStateBySessionId.get(id) || {
        marker,
        loaded: true,
        refreshing: false,
        summary: summary?.total ? summary : null,
        signature: summary?.total ? summary.signature : "",
        total: summary?.total || 0,
      };
      next.loaded = true;
      next.refreshing = false;
      sessionListArtifactHydrationStateBySessionId.set(id, next);
      shouldRefresh ||= (previous?.signature || "") !== next.signature || Number(previous?.total || 0) !== next.total;
    } catch (_err) {
      if (lifetime?.aborted || isDeletedSession(id)) return;
      sessionListArtifactHydrationStateBySessionId.set(id, {
        marker,
        loaded: true,
        refreshing: false,
        summary: previous?.summary || null,
        signature: previous?.signature || "",
        total: previous?.total || 0,
      });
    } finally {
      sessionListArtifactHydratingIds.delete(id);
    }
  }));

  if (shouldRefresh && isSessionsActive()) {
    if (isAutomationSessionsMode()) scheduleAutomationsRefresh({ delay: 80 });
    else scheduleSessionsListRefresh({ delay: 80 });
  }
  if (!lifetime?.aborted && sessionListArtifactHydrationQueue.size) {
    sessionListArtifactHydrationTimer = setTimeout(() => {
      sessionListArtifactHydrationTimer = null;
      hydrateQueuedSessionListArtifacts();
    }, 120);
  }
}

async function hydrateSessionArtifactSummary(sessionId: unknown, { marker = "", refresh = false } = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id) return null;
  const normalizedMarker = String(marker || "");
  const previous = sessionListArtifactHydrationStateBySessionId.get(id);
  if (!refresh && previous?.loaded && previous.marker === normalizedMarker) return previous.summary || null;
  if (sessionListArtifactHydratingIds.has(id) && !refresh) return previous?.summary || null;

  const transcript = hasSessionTranscript(id) ? [] : await readStoredSessionTranscriptForArtifacts(id);
  const source = sessionTranscript(id).length ? sessionTranscript(id) : transcript;
  const summary = await model.collectSessionArtifactsWithRuntime(id, source);
  if (lifetime?.aborted || isDeletedSession(id)) return null;
  const next = {
    marker: normalizedMarker,
    loaded: true,
    refreshing: false,
    summary: summary.total ? summary : null,
    signature: summary.total ? summary.signature : "",
    total: summary.total || 0,
  };
  sessionListArtifactHydrationStateBySessionId.set(id, next);
  syncSessionArtifactListSummary(id, summary);
  return next.summary;
}

function syncSessionArtifactListSummary(sessionId = "", summary: Summary = {}) {
  const id = normalizeSessionId(sessionId);
  if (!id || !summary) return;
  send({
    type: "sync_session_artifact_list_summary",
    sessionId: id,
    action: "summary_reconcile",
    artifacts: {
      total: summary.total || 0,
      signature: summary.signature || "",
      data: Array.isArray(summary.data) ? summary.data : [],
      files: Array.isArray(summary.files) ? summary.files : [],
    },
  });
}

async function readStoredSessionTranscriptForArtifacts(sessionId: unknown) {
  return readStoredTranscript(sessionId, lifetime);
}

function artifactTypeLabel(type = "", item: Partial<ArtifactItem> = {}) {
  if (type === "data") return model.dataArtifactKindLabel(item);
  if (type === "file") return t("file");
  return t("artifacts");
}

function getSessionListArtifactSummaryFromSession(session: Session = {}) {
  const id = normalizeSessionId(session?.id);
  if (!id) return null;
  const summary = normalizeSessionListSummary(session?.listSummary);
  if (isSessionListSummaryStale(session?.listSummary)) {
    return getSessionListArtifactSummary(id);
  }
  if (!summary.artifactCount) return getSessionListArtifactSummary(id);
  return {
    sessionId: id,
    total: summary.artifactCount,
    data: Array.from({ length: summary.dataCount }, (_, index) => ({ id: `data:${index}`, type: "data" })),
    files: Array.from({ length: summary.fileCount }, (_, index) => ({ id: `file:${index}`, type: "file" })),
    preview: summary.artifactPreview,
    signature: summary.artifactSignature,
  };
}

function renderArtifactsPanelIfOpen(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id || artifactsPanel?.classList.contains("hidden") || artifactsPanelSessionId !== id) return;
  const renderSeq = ++artifactsPanelRenderSeq;
  renderArtifactsPanel(id, { renderSeq });
}

async function openArtifactsPanel(sessionId = "") {
  const id = normalizeSessionId(sessionId || getCurrentSessionId());
  if (!id || !artifactsPanel) return;
  artifactsPanelSessionId = id;
  const renderSeq = ++artifactsPanelRenderSeq;
  renderArtifactsPanelShell(id);
  artifactsPanel.classList.remove("hidden");
  renderArtifactsPanel(id, { renderSeq });
}

function closeArtifactsPanel() {
  artifactsPanelSessionId = "";
  artifactsPanelRenderSeq += 1;
  artifactsPanel?.classList.add("hidden");
}

function renderArtifactsPanelShell(sessionId = "") {
  const id = normalizeSessionId(sessionId || artifactsPanelSessionId);
  if (!id || !artifactsBodyEl) return;
  const session: Session = sessionState.getRecord(id) || {};
  if (artifactsSessionTitleEl) {
    artifactsSessionTitleEl.textContent = session.title || (isCurrentSessionId(id) ? getCurrentSessionTitle() : "") || t("qingzhouTask");
  }
  const cachedSummary = getArtifactsPanelCachedSummary(id);
  if (cachedSummary?.total) {
    commitArtifactsPanelHtml(renderArtifactsPanelHtml(cachedSummary), artifactsPanelRenderSignature(cachedSummary));
    return;
  }
  const listSummary = isSessionListSummaryStale(session.listSummary)
    ? normalizeSessionListSummary(null)
    : normalizeSessionListSummary(session.listSummary);
  commitArtifactsPanelHtml(renderArtifactsPanelLoadingHtml(id, listSummary), `loading:${id}:${listSummary.artifactCount}:${listSummary.artifactSignature || ""}`);
}

function getArtifactsPanelCachedSummary(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id) return null;
  const cached = sessionListArtifactHydrationStateBySessionId.get(id)?.summary || null;
  const local = model.collectSessionArtifacts(id);
  const summary = cached ? model.mergeArtifactSummaries(id, local, cached) : local;
  return summary?.total ? summary : null;
}

async function renderArtifactsPanel(sessionId = "", { renderSeq = artifactsPanelRenderSeq } = {}) {
  const id = normalizeSessionId(sessionId || artifactsPanelSessionId);
  if (!id || !artifactsBodyEl) return;
  const [sessions, summary] = await Promise.all([
    getSessions().catch((): Record<string, SessionMetadata> => ({})),
    model.collectSessionArtifactsWithRuntime(id),
  ]);
  if (lifetime?.aborted || isDeletedSession(id) || renderSeq !== artifactsPanelRenderSeq || artifactsPanelSessionId !== id || artifactsPanel?.classList.contains("hidden")) return;
  const session = sessions[id] || {};
  if (session.id) sessionState.mergeRecord(session);
  if (artifactsSessionTitleEl) {
    artifactsSessionTitleEl.textContent = session.title || t("qingzhouTask");
  }

  commitArtifactsPanelHtml(renderArtifactsPanelHtml(summary), artifactsPanelRenderSignature(summary));
  sessionListArtifactHydrationStateBySessionId.set(id, {
    marker: sessionArtifactHydrationMarker(session),
    loaded: true,
    refreshing: false,
    summary: summary.total ? summary : null,
    signature: summary.total ? summary.signature : "",
    total: summary.total || 0,
  });
  syncSessionArtifactListSummary(id, summary);
}

function commitArtifactsPanelHtml(html = "", signature = "") {
  if (!artifactsBodyEl) return;
  const nextSignature = String(signature || hashText(html));
  if (artifactsBodyEl.dataset.renderSignature === nextSignature) return;
  const previousSignature = String(artifactsBodyEl.dataset.renderSignature || "");
  const settling = previousSignature.startsWith("loading:") && !nextSignature.startsWith("loading:");
  artifactsBodyEl.classList.remove("artifacts-body-settling");
  artifactsBodyEl.innerHTML = String(html || "");
  artifactsBodyEl.dataset.renderSignature = nextSignature;
  if (settling) {
    void artifactsBodyEl.offsetHeight;
    artifactsBodyEl.classList.add("artifacts-body-settling");
  }
}

function artifactsPanelRenderSignature(summary: Summary = {}) {
  return [
    summary.sessionId || "",
    summary.signature || "",
    Number(summary.total || 0),
    summary.data?.length || 0,
    summary.files?.length || 0,
  ].join(":");
}

function renderArtifactsPanelLoadingHtml(sessionId = "", listSummary: unknown = {}) {
  const summary = normalizeSessionListSummary(listSummary);
  const count = Number(summary.artifactCount || 0);
  const stats = [
    summary.dataCount ? t("tables", { count: String(summary.dataCount) }) : "",
    summary.fileCount ? t("files", { count: String(summary.fileCount) }) : "",
  ].filter(Boolean).join(" · ") || (count ? t("loadingArtifactList") : t("checkingTaskArtifacts"));
  const title = count ? t("artifactCount", { count: String(count) }) : t("taskArtifacts");
  const preview = summary.artifactPreview ? `<div class="artifacts-loading-preview">${escapeHtml(summary.artifactPreview)}</div>` : "";
  return `
    <div class="artifacts-summary" aria-label="${escapeHtmlAttribute(t("artifactOverview"))}">
      <div>
        <div class="artifacts-summary-title">${escapeHtml(title)}</div>
        <div class="artifacts-summary-meta">${escapeHtml(stats)}</div>
      </div>
    </div>
    <div class="artifacts-empty loading" data-session-id="${escapeHtmlAttribute(sessionId)}">
      <span class="artifacts-loading-dot" aria-hidden="true"></span>
      <span>${count ? t("loadingArtifactList") : t("checkingTaskArtifacts")}</span>
      ${preview}
    </div>
  `;
}

function renderArtifactsPanelHtml(summary: Summary = {}) {
  const items = artifactCompactItems(summary);
  const stats = [
    summary.data?.length ? t("tables", { count: String(summary.data.length) }) : "",
    summary.files?.length ? t("files", { count: String(summary.files.length) }) : "",
  ].filter(Boolean).join(" · ") || t("tablesImageCollectionsAndDownloadedFilesAppearHere");
  return `
    <div class="artifacts-summary" aria-label="${escapeHtmlAttribute(t("artifactOverview"))}">
      <div>
        <div class="artifacts-summary-title">${escapeHtml(t("artifactCount", { count: Number(summary.total || 0) }))}</div>
        <div class="artifacts-summary-meta">${escapeHtml(stats)}</div>
      </div>
    </div>
    ${items.length ? `
      <div class="artifacts-list" aria-label="${escapeHtmlAttribute(t("artifactList"))}">
        ${items.map(item => renderArtifactPanelRow(item, summary.sessionId || "")).join("")}
      </div>
    ` : `<div class="artifacts-empty">${escapeHtml(t("noArtifacts"))}</div>`}
  `;
}

function renderArtifactPanelRow(item: Partial<ArtifactItem> = {}, sessionId = "") {
  if (item.type !== "data" && item.type !== "file") return "";
  const isData = item.type === "data";
  const canOpen = isData ? canOpenDataArtifact(item) : model.isDownloadableFileArtifact(item);
  const attributes = isData ? dataArtifactActionAttributes : fileArtifactActionAttributes;
  const actionAttrs = canOpen ? attributes(item, sessionId) : "";
  const kindLabel = artifactTypeLabel(item.type, item);
  return `
    <div class="artifacts-row ${canOpen ? "clickable" : ""}"${canOpen ? ` role="button" tabindex="0"${actionAttrs}` : ""}>
      <div class="artifacts-row-kind">${escapeHtml(kindLabel)}</div>
      <div class="artifacts-row-main">
        <div class="artifacts-row-title" title="${escapeHtmlAttribute(item.title || "")}">${escapeHtml(item.title || "")}</div>
        <div class="artifacts-row-meta">${escapeHtml(model.artifactMetaWithTime(item, { full: true }) || (isData ? t("referenced") : t("file")))}</div>
      </div>
      ${canOpen ? `<span class="artifact-row-action" aria-hidden="true">${escapeHtml(t("open"))}</span>` : ""}
    </div>
  `;
}

const canOpenFileArtifact = model.isDownloadableFileArtifact;

function canOpenDataArtifact(item: Partial<ArtifactItem> = {}) {
  return Boolean(String(item?.table || item?.title || item?.id || "").trim());
}

function dataArtifactActionAttributes(item: Partial<ArtifactItem> = {}, sessionId = "") {
  const sessionAttr = sessionId ? ` data-session-id="${escapeHtmlAttribute(sessionId)}"` : "";
  return ` data-artifact-action="open-data" data-table="${escapeHtmlAttribute(item.table || item.title || item.id || "")}"${sessionAttr}`;
}

function fileArtifactActionAttributes(item: Partial<ArtifactItem> = {}, sessionId = "") {
  const sessionAttr = sessionId ? ` data-session-id="${escapeHtmlAttribute(sessionId)}"` : "";
  return ` data-artifact-action="open-file" data-download-id="${escapeHtmlAttribute(model.fileArtifactDownloadId(item))}" data-url="${escapeHtmlAttribute(model.fileArtifactUrl(item))}" data-filename="${escapeHtmlAttribute(item.title || "")}"${sessionAttr}`;
}

async function handleArtifactAction(actionEl: HTMLElement) {
  const action = actionEl?.dataset?.artifactAction || "";
  const sessionId = normalizeSessionId(actionEl?.dataset?.sessionId || artifactsPanelSessionId || getCurrentSessionId());
  if (action === "open-panel") {
    await openArtifactsPanel(sessionId);
    return;
  }
  if (action === "open-data") {
    await openArtifactDataTable(actionEl.dataset.table || "", { anchorEl: actionEl });
    return;
  }
  if (action === "open-file") {
    await openArtifactFile(actionEl);
  }
}

async function getDownloadItem(downloadId = 0) {
  const id = Number(downloadId || 0);
  if (!Number.isFinite(id) || id <= 0 || !chrome.downloads?.search) return null;
  try {
    const result = chrome.downloads.search({ id });
    const items = result && typeof result.then === "function" ? await result : result;
    return Array.isArray(items) ? (items[0] || null) : null;
  } catch (_err) {
    return null;
  }
}

async function openArtifactFile(actionEl: HTMLElement) {
  const downloadId = Number(actionEl?.dataset?.downloadId || 0);
  if (Number.isFinite(downloadId) && downloadId > 0) {
    try {
      const allowed = await requestBrowserPermission("downloads.open");
      if (lifetime?.aborted) return;
      if (!allowed) {
        showArtifactToast(permissionT("denied", { permission: permissionT("name.downloads.open") }), actionEl);
        return;
      }
    } catch (error) {
      if (!lifetime?.aborted) showArtifactToast(error instanceof Error ? error.message : String(error), actionEl);
      return;
    }
    const downloadItem = await getDownloadItem(downloadId);
    if (lifetime?.aborted) return;
    if (downloadItem && downloadItem.exists === false) {
      const fallbackUrl = String(actionEl?.dataset?.url || downloadItem.finalUrl || downloadItem.url || "").trim();
      if (fallbackUrl) {
        await downloadArtifactFileFromUrl(actionEl, fallbackUrl, { recovered: true });
        return;
      }
      showArtifactToast(t("thisFileSLocalCopyWasDeletedAndNo"), actionEl);
      return;
    }
    if (chrome.downloads?.open) {
      try {
        await chrome.downloads.open(downloadId);
        return;
      } catch (_err) {}
    }
    if (chrome.downloads?.show) {
      try {
        await chrome.downloads.show(downloadId);
        return;
      } catch (_err) {}
    }
  }

  const url = String(actionEl?.dataset?.url || "").trim();
  if (url) {
    await downloadArtifactFileFromUrl(actionEl, url, { recovered: Boolean(downloadId) });
    return;
  }

  showArtifactToast(t("thisFileHasNoDownloadRecordAvailableToOpen"), actionEl);
}

async function downloadArtifactFileFromUrl(actionEl: HTMLElement, url = "", { recovered = false } = {}) {
  const filename = String(actionEl?.dataset?.filename || "").trim();
  try {
    await chrome.downloads.download({
      url,
      filename: filename || undefined,
      saveAs: false,
    });
    showCaseToast(recovered ? t("theOriginalFileIsUnavailableDownloadedItAgain") : t("fileDownloadStarted"), { anchorEl: actionEl });
  } catch (_err) {
    showArtifactToast(recovered ? t("theOriginalFileIsUnavailableAndDownloadingItAgain") : t("thisFileCannotBeDownloadedRightNow"), actionEl);
  }
}

async function openArtifactDataTable(tableName = "", { anchorEl = null }: { anchorEl?: HTMLElement | null } = {}) {
  return openTable(tableName, { anchorEl });
}

btnCloseArtifacts?.addEventListener("click", closeArtifactsPanel, { signal: lifetime });
$(".artifacts-backdrop")?.addEventListener("click", closeArtifactsPanel, { signal: lifetime });
document.addEventListener("click", (event) => {
  const actionEl = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-artifact-action]") : null;
  if (!actionEl) return;
  event.preventDefault();
  handleArtifactAction(actionEl).catch(err => appendSystemNote(String(record(err).message || t("artifactOperationFailed"))));
}, { signal: lifetime });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const actionEl = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-artifact-action]") : null;
  if (!actionEl || actionEl.tagName === "BUTTON" || actionEl.tagName === "A") return;
  event.preventDefault();
  handleArtifactAction(actionEl).catch(err => appendSystemNote(String(record(err).message || t("artifactOperationFailed"))));
}, { signal: lifetime });

  function remove(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    artifactCardSuppressedBySessionId.delete(id);
    sessionListArtifactHydrationStateBySessionId.delete(id);
    sessionListArtifactHydrationQueue.delete(id);
    sessionListArtifactHydratingIds.delete(id);
    sessionListSummaryBackfillQueue.delete(id);
    sessionListSummaryBackfillingIds.delete(id);
    if (artifactsPanelSessionId === id) closeArtifactsPanel();
  }

  function reset() {
    if (sessionListArtifactHydrationTimer) clearTimeout(sessionListArtifactHydrationTimer);
    if (sessionListSummaryBackfillTimer) clearTimeout(sessionListSummaryBackfillTimer);
    sessionListArtifactHydrationTimer = null;
    sessionListSummaryBackfillTimer = null;
    artifactCardSuppressedBySessionId.clear();
    sessionListArtifactHydrationStateBySessionId.clear();
    sessionListArtifactHydrationQueue.clear();
    sessionListArtifactHydratingIds.clear();
    sessionListSummaryBackfillQueue.clear();
    sessionListSummaryBackfillingIds.clear();
    closeArtifactsPanel();
  }

  function hasBlockingOverlay() {
    return Boolean(artifactsPanel && !artifactsPanel.classList.contains("hidden"));
  }

  return {
    panel: artifactsPanel,
    model,
    projectTranscript: withArtifactsTranscriptEntry,
    settleTerminal: settleArtifactTailForTerminalSession,
    handleResourcesChanged: handleSessionResourcesChanged,
    requestHydration: requestSessionArtifactHydration,
    scheduleListHydration: scheduleSessionListArtifactHydration,
    scheduleSummaryBackfill: scheduleSessionListSummaryBackfill,
    isSummaryStale: isSessionListSummaryStale,
    getSessionSummary: getSessionListArtifactSummary,
    getSummaryFromRecord: getSessionListArtifactSummaryFromSession,
    renderSessionChip: renderSessionArtifactChip,
    statsText: sessionListArtifactStatsText,
    compactItems: artifactCompactItems,
    previewText: artifactPreviewText,
    typeLabel: artifactTypeLabel,
    canOpenData: canOpenDataArtifact,
    canOpenFile: canOpenFileArtifact,
    dataActionAttributes: dataArtifactActionAttributes,
    fileActionAttributes: fileArtifactActionAttributes,
    createTranscriptElement: createArtifactsTranscriptElement,
    patchTranscriptElement: patchArtifactsTranscriptElement,
    retireTranscriptElement: retireArtifactsTranscriptElement,
    suppressCard: suppressArtifactCardUntilRunSettles,
    releaseCardSuppression: releaseArtifactCardSuppression,
    scheduleMissingHydration: scheduleMissingSessionArtifactHydration,
    renderPanelIfOpen: renderArtifactsPanelIfOpen,
    openPanel: openArtifactsPanel,
    closePanel: closeArtifactsPanel,
    showToast: showArtifactToast,
    hasBlockingOverlay,
    remove,
    reset,
  };
}

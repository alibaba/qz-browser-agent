import { t } from "../../i18n/index.js";
import { formatContextUsageText } from "../../ui/ui-utils.js";
import { stringSessionId as normalizeSessionId } from "./session-id.js";
import type { SessionRuntime, SessionGoal, SessionTracker } from "../../../shared/contracts/session-runtime.js";
import type { TranscriptEntry, TranscriptAgentEvent } from "../../../shared/contracts/session.js";
import type { SessionMetadata } from "../../../shared/session/session-store.js";
import { record as fields } from "../../tools/renderer-input.js";

type Fields = Record<string, unknown>;
export type GoalView = Omit<SessionGoal, "updatedByRunId">;
export type TrackerView = Omit<SessionTracker, "status" | "startedAt" | "steps" | "stats"> & {
  steps: { id: string; label: string; status: string }[]; stats: Fields | null;
};
/** UI clips descriptive text and normalizes legacy nested wire payloads; Background remains authoritative. */
export interface ClientRuntime extends Pick<SessionRuntime, "status" | "running" | "pendingStart" | "runId" | "waitForm" | "contextUsage">, Fields {
  waitId: string; waitMessage: string; waitTitle: string;
  currentTool: ReturnType<typeof normalizeSessionCurrentTool>; currentToolName: string; currentToolStartedAt: string;
  contextUsageText: string; contextWindow: number; inputTokensEstimate: number;
  tracker: TrackerView | null; goal: GoalView | null;
  workingTab: ReturnType<typeof normalizeSessionWorkingTab>; workingTabId: number | null; workingUrl: string; workingTitle: string;
  visitedTaskSites: ReturnType<typeof normalizeSessionTaskSites>;
  pendingSteerings: ReturnType<typeof normalizeRuntimePendingFollowUps>; pendingFollowUps: ReturnType<typeof normalizeRuntimePendingFollowUps>;
  startedAt: string; endedAt: string; updatedAt: string;
}
export interface SessionViewEvent extends Omit<TranscriptAgentEvent, "runtime">, Fields {
  type: string; sessionId?: string; session?: Partial<SessionMetadata>; runtime?: Fields;
  transcript?: TranscriptEntry[]; isStreaming?: boolean;
}
interface StateOptions { now?(): string; onInvalidEvent?(event: unknown, reason: string): void }
interface Entry {
  sessionId: string; record: SessionMetadata | null; runtime: ClientRuntime; transcript: TranscriptEntry[];
  transcriptLoaded: boolean; artifactSummary: ReturnType<typeof artifactSummaryFromListSummary>; artifactsDirty: boolean;
  revision: ReturnType<typeof emptyRevision>; causality: { currentRunId: string; lastEventSeqByScope: Map<string, number> };
}
interface ChangePatch {
  eventType?: string; runtimeChanged?: boolean; transcriptChanged?: boolean; recordChanged?: boolean;
  artifactsChanged?: boolean; terminal?: boolean; sessionId?: string; stale?: boolean; snapshot?: ReturnType<typeof snapshotEntry>;
}
import {
  mergeTranscriptSnapshotWithLocalState,
  transcriptFromConversation,
  updateTranscriptWithAgentEvent,
} from "../../../shared/session/session-codec.js";
import {
  SESSION_RUNTIME_STATUS,
  isActiveSessionRuntimeStatus,
  isSettledSessionRuntimeStatus,
  isTerminalSessionRuntimeStatus,
  normalizeSessionRuntimeStatus,
} from "../../../shared/session/session-runtime-status.js";
import {
  createSessionArtifactListSummary,
  createSessionListSummaryFromAgentEvent,
  mergeSessionListSummary,
  normalizeSessionListSummary,
  sessionListSummarySignature,
} from "../../../shared/session/session-list-summary.js";
import { nowBeijingDateTime } from "../../../shared/time-utils.js";
import { normalizeToolIdentitySnapshot } from "../../../shared/tools/tool-identity.js";

const NON_CAUSAL_EVENT_TYPES = new Set([
  "messages",
  "transcript_replace",
  "session_resources_changed",
  "session_restored",
  "sessions_changed",
]);

const NO_TRANSCRIPT_REDUCER_EVENT_TYPES = new Set([
  "messages",
  "transcript_replace",
  "queue_update",
  "session_resources_changed",
  "session_restored",
  "sessions_changed",
  "session_created",
  "session_deleted",
]);

export class SessionState {
  private _entries: Map<string, Entry>;
  private _now: () => string;
  private _onInvalidEvent: StateOptions["onInvalidEvent"] | null;
  constructor(options: StateOptions = {}) {
    this._entries = new Map();
    this._now = typeof options.now === "function" ? options.now : nowBeijingDateTime;
    this._onInvalidEvent = typeof options.onInvalidEvent === "function" ? options.onInvalidEvent : null;
  }

  ensure(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return null;
    let entry = this._entries.get(id);
    if (!entry) {
      entry = createEntry(id);
      this._entries.set(id, entry);
    }
    return entry;
  }

  has(sessionId: unknown) {
    return this._entries.has(normalizeSessionId(sessionId));
  }

  get(sessionId: unknown) {
    const entry = this._entries.get(normalizeSessionId(sessionId));
    return entry ? snapshotEntry(entry, { deepTranscript: true }) : null;
  }

  getRuntime(sessionId: unknown) {
    const entry = this._entries.get(normalizeSessionId(sessionId));
    return entry ? cloneObject(entry.runtime) : createDefaultRuntime();
  }

  getRecord(sessionId: unknown) {
    const entry = this._entries.get(normalizeSessionId(sessionId));
    return entry?.record ? cloneObject(entry.record) : null;
  }

  getTranscript(sessionId: unknown) {
    const entry = this._entries.get(normalizeSessionId(sessionId));
    return entry ? cloneArray(entry.transcript) : [];
  }

  // Stable references let renderers attach `_ui*` hints without cloning every stream update.
  // These hints are not task facts; domain changes must pass through this projection's reducers.
  getTranscriptView(sessionId: unknown) {
    return this._entries.get(normalizeSessionId(sessionId))?.transcript || [];
  }

  hasTranscript(sessionId: unknown) {
    return this._entries.get(normalizeSessionId(sessionId))?.transcriptLoaded === true;
  }

  someRuntime(predicate: (runtime: ClientRuntime, sessionId: string) => boolean) {
    if (typeof predicate !== "function") return false;
    for (const entry of this._entries.values()) {
      if (predicate(entry.runtime, entry.sessionId)) return true;
    }
    return false;
  }

  list(options: { includeTranscript?: boolean } = {}) {
    const includeTranscript = options.includeTranscript === true;
    return [...this._entries.values()].map(entry => snapshotEntry(entry, {
      deepTranscript: includeTranscript,
      includeTranscript,
    }));
  }

  mergeRecords(records: unknown) {
    const input = Array.isArray(records)
      ? records
      : records && typeof records === "object"
        ? Object.values(records)
        : [];
    const changes = [];
    for (const record of input) {
      const change = this.mergeRecord(record);
      if (change.accepted && change.recordChanged) changes.push(change);
    }
    return changes;
  }

  mergeRecord(record: unknown) {
    const source = fields(record);
    const id = normalizeSessionId(source.id);
    if (!id) return rejectedChange("missing_session_id");
    const entry = this.ensure(id)!;
    const normalized = normalizeRecord(record, entry.record);
    const previousSignature = recordSignature(entry.record);
    const nextSignature = recordSignature(normalized);
    let recordChanged = false;
    let artifactsChanged = false;

    if (previousSignature !== nextSignature) {
      const previousArtifactSignature = stableJson(artifactSummaryFromListSummary(entry.record?.listSummary));
      const nextArtifactSignature = stableJson(artifactSummaryFromListSummary(normalized.listSummary));
      entry.record = normalized;
      entry.revision.record += 1;
      recordChanged = true;
      if (previousArtifactSignature !== nextArtifactSignature) {
        entry.artifactSummary = artifactSummaryFromListSummary(normalized.listSummary);
        entry.revision.artifacts += 1;
        artifactsChanged = true;
      }
    }

    return this._change(entry, { recordChanged, artifactsChanged });
  }

  mergeRuntime(sessionId: unknown, runtime: unknown, options: { resetCausality?: boolean } = {}) {
    const entry = this.ensure(sessionId);
    if (!entry) return rejectedChange("missing_session_id");
    const next = normalizeRuntime(runtime, entry.runtime);
    if (runtimeSignature(next) === runtimeSignature(entry.runtime)) {
      return this._change(entry, {});
    }
    entry.runtime = next;
    entry.revision.runtime += 1;
    if (options.resetCausality === true) resetCausality(entry, next.runId);
    return this._change(entry, { runtimeChanged: true, terminal: isTerminalRuntime(next) });
  }

  replaceTranscript(sessionId: unknown, transcript: TranscriptEntry[], options: { preserveLocal?: boolean; assumeChanged?: boolean } = {}) {
    const entry = this.ensure(sessionId);
    if (!entry) return rejectedChange("missing_session_id");
    const incoming = Array.isArray(transcript) ? transcript : [];
    const next = options.preserveLocal === false
      ? cloneTranscriptProjection(incoming)
      : mergeTranscriptSnapshotWithLocalState(entry.transcript, incoming);
    const loadedChanged = !entry.transcriptLoaded;
    entry.transcriptLoaded = true;
    if (!loadedChanged && options.assumeChanged !== true && transcriptSignature(next) === transcriptSignature(entry.transcript)) {
      return this._change(entry, {});
    }
    entry.transcript = next;
    entry.revision.transcript += 1;
    return this._change(entry, { transcriptChanged: true });
  }

  mergeArtifactSummary(sessionId: unknown, artifactsOrSummary: unknown, options: { updatedAt?: string } = {}) {
    const entry = this.ensure(sessionId);
    if (!entry) return rejectedChange("missing_session_id");
    const at = options.updatedAt || this._now();
    const summaryPatch = looksLikeArtifactCollections(artifactsOrSummary)
      ? createSessionArtifactListSummary(fields(artifactsOrSummary), at)
      : normalizeArtifactSummaryPatch(artifactsOrSummary);
    const previousListSummary = normalizeSessionListSummary(entry.record?.listSummary);
    const nextListSummary = mergeSessionListSummary(previousListSummary, summaryPatch);
    if (sessionListSummarySignature(previousListSummary) === sessionListSummarySignature(nextListSummary)) {
      return this._change(entry, {});
    }

    entry.record = normalizeRecord({
      ...(entry.record || { id: entry.sessionId }),
      listSummary: nextListSummary,
    }, entry.record);
    entry.artifactSummary = artifactSummaryFromListSummary(nextListSummary);
    entry.artifactsDirty = false;
    entry.revision.record += 1;
    entry.revision.artifacts += 1;
    return this._change(entry, { recordChanged: true, artifactsChanged: true });
  }

  applyEvent(event: SessionViewEvent, options: { runtime?: boolean; transcript?: boolean; record?: boolean; artifacts?: boolean } = {}) {
    if (!event || typeof event !== "object" || !String(event.type || "").trim()) {
      this._onInvalidEvent?.(event, "invalid_event");
      return rejectedChange("invalid_event");
    }

    const type = String(event.type);
    const sessionId = normalizeSessionId(event.sessionId || event.session?.id);
    if (type === "session_deleted") return this.remove(sessionId);
    if (!sessionId) return rejectedChange("missing_session_id", { eventType: type });

    const entry = this.ensure(sessionId)!;
    const causality = acceptCausalEvent(entry, event);
    if (!causality.accepted) {
      return rejectedChange(causality.reason, {
        sessionId,
        eventType: type,
        stale: true,
        snapshot: snapshotEntry(entry),
      });
    }

    let runtimeChanged = false;
    let transcriptChanged = false;
    let recordChanged = false;
    let artifactsChanged = false;

    if (type === "session_created" || type === "sessions_changed") {
      if (event.session) {
        const recordChange = this.mergeRecord(event.session);
        recordChanged ||= recordChange.recordChanged;
        artifactsChanged ||= recordChange.artifactsChanged;
      }
    }

    if (options.runtime !== false && (event.runtime || runtimeEventMayChangeState(event))) {
      const nextRuntime = reduceRuntime(entry.runtime, event, this._now());
      if (runtimeSignature(nextRuntime) !== runtimeSignature(entry.runtime)) {
        entry.runtime = nextRuntime;
        entry.revision.runtime += 1;
        runtimeChanged = true;
      }
    }

    if (options.transcript !== false && type === "messages") {
      const snapshot = Array.isArray(event.transcript)
        ? event.transcript
        : transcriptFromConversation(event.session ?? event.messages);
      const next = mergeTranscriptSnapshotWithLocalState(entry.transcript, snapshot);
      entry.transcriptLoaded = true;
      if (transcriptSignature(next) !== transcriptSignature(entry.transcript)) {
        entry.transcript = next;
        entry.revision.transcript += 1;
        transcriptChanged = true;
      }
    } else if (options.transcript !== false && type === "transcript_replace") {
      const next = mergeTranscriptSnapshotWithLocalState(entry.transcript, event.transcript || []);
      entry.transcriptLoaded = true;
      if (transcriptSignature(next) !== transcriptSignature(entry.transcript)) {
        entry.transcript = next;
        entry.revision.transcript += 1;
        transcriptChanged = true;
      }
    } else if (options.transcript !== false && !NO_TRANSCRIPT_REDUCER_EVENT_TYPES.has(type)) {
      const result = updateTranscriptWithAgentEvent(entry.transcript, event);
      if (result.changed) {
        // A status snapshot can add a terminal pill before stored history arrives.
        if (type !== "state") entry.transcriptLoaded = true;
        entry.transcript = result.transcript;
        entry.revision.transcript += 1;
        transcriptChanged = true;
      }
    }

    const summaryPatch = options.record === false ? null : createSessionListSummaryFromAgentEvent(event);
    if (summaryPatch) {
      const previousRecord = entry.record || { id: sessionId, listSummary: normalizeSessionListSummary() };
      const nextSummary = mergeSessionListSummary(previousRecord.listSummary, summaryPatch);
      if (sessionListSummarySignature(previousRecord.listSummary) !== sessionListSummarySignature(nextSummary)) {
        entry.record = normalizeRecord({ ...previousRecord, listSummary: nextSummary }, previousRecord);
        entry.revision.record += 1;
        recordChanged = true;
      }
    }

    if (options.artifacts !== false && type === "session_resources_changed") {
      entry.artifactsDirty = true;
      entry.revision.artifacts += 1;
      artifactsChanged = true;
    }

    commitCausality(entry, event);
    const terminal = isTerminalEvent(event) || isTerminalRuntime(entry.runtime);
    return this._change(entry, {
      eventType: type,
      runtimeChanged,
      transcriptChanged,
      recordChanged,
      artifactsChanged,
      terminal,
    });
  }

  remove(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return rejectedChange("missing_session_id");
    const previous = this._entries.get(id);
    const deleted = this._entries.delete(id);
    return {
      accepted: true,
      sessionId: id,
      removed: deleted,
      previous: previous ? snapshotEntry(previous) : null,
      runtimeChanged: deleted,
      transcriptChanged: deleted,
      recordChanged: deleted,
      artifactsChanged: deleted,
      terminal: true,
      revision: previous ? { ...previous.revision } : emptyRevision(),
      snapshot: null,
    };
  }

  reset() {
    const count = this._entries.size;
    this._entries.clear();
    return { reset: true, count };
  }

  _change(entry: Entry, patch: ChangePatch = {}) {
    return {
      accepted: true,
      sessionId: entry.sessionId,
      eventType: patch.eventType || "",
      removed: false,
      runtimeChanged: patch.runtimeChanged === true,
      transcriptChanged: patch.transcriptChanged === true,
      recordChanged: patch.recordChanged === true,
      artifactsChanged: patch.artifactsChanged === true,
      terminal: patch.terminal === true,
      revision: { ...entry.revision },
      snapshot: snapshotEntry(entry, { deepTranscript: false }),
    };
  }
}

export function createSessionState(options: StateOptions = {}) {
  return new SessionState(options);
}

function createEntry(sessionId: string): Entry {
  return {
    sessionId,
    record: null,
    runtime: createDefaultRuntime(),
    transcript: [],
    transcriptLoaded: false,
    artifactSummary: artifactSummaryFromListSummary(),
    artifactsDirty: false,
    revision: emptyRevision(),
    causality: {
      currentRunId: "",
      lastEventSeqByScope: new Map(),
    },
  };
}

function snapshotEntry(entry: Entry, options: { includeTranscript?: boolean; deepTranscript?: boolean } = {}) {
  const includeTranscript = options.includeTranscript !== false;
  return {
    sessionId: entry.sessionId,
    record: entry.record ? cloneObject(entry.record) : null,
    runtime: cloneObject(entry.runtime),
    transcript: includeTranscript
      ? (options.deepTranscript === true ? cloneArray(entry.transcript) : entry.transcript.slice())
      : [],
    transcriptLoaded: entry.transcriptLoaded === true,
    artifactSummary: cloneObject(entry.artifactSummary),
    artifactsDirty: entry.artifactsDirty === true,
    revision: { ...entry.revision },
  };
}

function emptyRevision() {
  return { record: 0, runtime: 0, transcript: 0, artifacts: 0 };
}

function normalizeRecord(record: unknown, previous: Partial<SessionMetadata> | null = null): SessionMetadata {
  const source = fields(record);
  const id = normalizeSessionId(source.id || previous?.id);
  return {
    ...(previous && typeof previous === "object" ? previous : {}),
    ...source,
    id,
    title: String(source.title ?? previous?.title ?? t("newSession")),
    parentSessionId: String(source.parentSessionId ?? previous?.parentSessionId ?? "0") || "0",
    listSummary: normalizeSessionListSummary(source.listSummary ?? previous?.listSummary),
  };
}

function normalizeRuntime(runtime: unknown, previous: ClientRuntime = createDefaultRuntime()): ClientRuntime {
  const source = fields(runtime);
  const merged = { ...createDefaultRuntime(), ...previous, ...source };
  const status = normalizeRuntimeStatus(merged.status);
  const running = typeof source.running === "boolean" ? source.running : isActiveSessionRuntimeStatus(status);
  return {
    ...merged,
    status,
    running,
    pendingStart: Boolean(merged.pendingStart && running),
    runId: normalizeOptionalString(merged.runId) || null,
    waitId: normalizeOptionalString(merged.waitId),
    waitMessage: String(merged.waitMessage || ""),
    waitTitle: String(merged.waitTitle || ""),
    waitForm: normalizeObjectOrNull(merged.waitForm),
    currentTool: normalizeSessionCurrentTool(merged.currentTool),
    currentToolName: String(merged.currentToolName || merged.currentTool?.name || ""),
    currentToolStartedAt: String(merged.currentToolStartedAt || merged.currentTool?.startedAt || ""),
    contextUsage: normalizeObjectOrNull(merged.contextUsage),
    contextUsageText: String(merged.contextUsageText || ""),
    contextWindow: nonNegativeNumber(merged.contextWindow),
    inputTokensEstimate: nonNegativeNumber(merged.inputTokensEstimate),
    tracker: normalizeSessionTracker(merged.tracker),
    goal: normalizeSessionGoal(merged.goal),
    workingTab: normalizeSessionWorkingTab(merged.workingTab),
    workingTabId: finiteId(merged.workingTabId ?? merged.workingTab?.id),
    workingUrl: String(merged.workingUrl || merged.workingTab?.url || ""),
    workingTitle: String(merged.workingTitle || merged.workingTab?.title || ""),
    visitedTaskSites: normalizeSessionTaskSites(merged.visitedTaskSites),
    pendingSteerings: normalizeRuntimePendingSteerings(merged.pendingSteerings),
    pendingFollowUps: normalizeRuntimePendingFollowUps(merged.pendingFollowUps),
    startedAt: String(merged.startedAt || ""),
    endedAt: String(merged.endedAt || ""),
    updatedAt: String(merged.updatedAt || ""),
  };
}

function reduceRuntime(previous: ClientRuntime, event: SessionViewEvent, now: string) {
  if (event.type === "reset") return { ...createDefaultRuntime(), updatedAt: now };
  const source = event.runtime && typeof event.runtime === "object" ? event.runtime : {};
  let status = String(event.status || source.status || derivedStatus(event.type) || previous.status || "idle");
  if (event.type === "agent_end" && isTerminalSessionRuntimeStatus(previous.status)) {
    status = previous.status;
  }
  if (event.type === "state" && event.isStreaming && !isActiveSessionRuntimeStatus(status)) {
    status = SESSION_RUNTIME_STATUS.RUNNING;
  }
  status = normalizeRuntimeStatus(status);
  const terminal = isTerminalSessionRuntimeStatus(status);
  const running = deriveSessionRunning(event, status, previous.running);
  const pendingFollowUps = Object.prototype.hasOwnProperty.call(event, "pendingFollowUps")
    ? event.pendingFollowUps
    : source.pendingFollowUps;
  const pendingSteerings = Object.prototype.hasOwnProperty.call(event, "pendingSteerings")
    ? event.pendingSteerings
    : source.pendingSteerings;
  const goal = deriveRuntimeGoal(event, source, previous);
  const tracker = deriveRuntimeTracker(event, source, previous, running);
  const contextUsage = deriveRuntimeContextUsage(event, source, previous);
  const next = normalizeRuntime({
    ...previous,
    ...source,
    status,
    running,
    pendingStart: running && status === "pending",
    runId: running
      ? (event.runId || source.runId || previous.runId)
      : (event.runId || source.runId || null),
    ...(pendingSteerings !== undefined ? { pendingSteerings } : {}),
    ...(pendingFollowUps !== undefined ? { pendingFollowUps } : {}),
    goal,
    tracker,
    ...contextUsage,
    startedAt: source.startedAt || previous.startedAt || (isRunStartEvent(event) ? now : ""),
    endedAt: source.endedAt || (running ? "" : previous.endedAt),
    updatedAt: source.updatedAt || (event.type === "state" ? previous.updatedAt : now),
  }, previous);

  if (event.type === "waiting_for_user") {
    next.status = "waiting_user";
    next.running = true;
    next.waitId = String(event.waitId || source.waitId || "");
    next.waitMessage = String(event.message || source.waitMessage || "");
    next.waitTitle = String(fields(event.form).title || event.title || source.waitTitle || "");
    next.waitForm = normalizeObjectOrNull(event.form ?? source.waitForm);
  } else if (event.type === "user_wait_resolved") {
    next.status = next.running ? "running" : next.status;
    next.waitId = "";
    next.waitMessage = "";
    next.waitTitle = "";
    next.waitForm = null;
  }

  const executionEvent = ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type);
  if (isRunStartEvent(event) || terminal || !next.running) {
    next.currentTool = null;
  } else if (executionEvent && Object.prototype.hasOwnProperty.call(source, "currentTool")) {
    // Background owns the active calls and selects the surviving tool after an ordered end.
    next.currentTool = normalizeSessionCurrentTool(source.currentTool);
  } else if (event.type === "tool_call_update" || event.type === "tool_execution_start" || event.type === "tool_execution_update") {
    const sameTool = event.toolCallId ? event.toolCallId === previous.currentTool?.toolCallId
      : event.spanId ? event.spanId === previous.currentTool?.spanId
      : event.toolName && event.toolName === previous.currentTool?.name;
    const previousTool = event.type !== "tool_execution_start" && sameTool ? previous.currentTool : null;
    const identity = normalizeToolIdentitySnapshot(event, previousTool || { name: "tool" });
    next.currentTool = normalizeSessionCurrentTool({
      ...(previousTool || {}),
      ...identity,
      name: identity.name || "tool",
      toolCallId: event.toolCallId || previousTool?.toolCallId || "",
      spanId: event.spanId || previousTool?.spanId || "",
      phase: event.phase || previousTool?.phase || (event.type === "tool_call_update" ? "preparing" : "running"),
      statusText: event.statusText ?? previousTool?.statusText ?? "",
      statusDetail: event.statusDetail ?? previousTool?.statusDetail ?? "",
      startedAt: previousTool?.startedAt || now,
      updatedAt: now,
      rateLimit: event.rateLimit !== undefined ? event.rateLimit : previousTool?.rateLimit || null,
    });
  } else if (event.type === "tool_execution_end"
    && (!event.toolCallId || event.toolCallId === previous.currentTool?.toolCallId)) {
    next.currentTool = null;
  }
  next.currentToolName = next.currentTool?.name || "";
  next.currentToolStartedAt = next.currentTool?.startedAt || "";

  if (terminal || !next.running) {
    next.running = false;
    next.pendingStart = false;
    next.waitId = "";
    next.waitMessage = "";
    next.waitTitle = "";
    next.waitForm = null;
    next.endedAt = String(source.endedAt || next.endedAt || now);
  }
  return next;
}

function isRunStartEvent(event: SessionViewEvent) {
  return event.type === "session_pending" || event.type === "agent_start";
}

function acceptCausalEvent(entry: Entry, event: SessionViewEvent): { accepted: true } | { accepted: false; reason: string } {
  // Reject stale delivery before changing any projection; this is not Background write authority.
  const runId = normalizeOptionalString(event.runId || event.runtime?.runId);
  const currentRunId = normalizeOptionalString(entry.runtime.runId || entry.causality.currentRunId);
  if (runId && currentRunId && runId !== currentRunId && !isRunStartEvent(event)) {
    if (!(event.type === "state" && !entry.runtime.running) && !NON_CAUSAL_EVENT_TYPES.has(event.type)) {
      return { accepted: false, reason: "stale_run" };
    }
  }

  const eventSeq = finiteEventSeq(event.eventSeq);
  if (eventSeq != null) {
    const key = causalSequenceKey(event, runId, currentRunId);
    const previousSeq = entry.causality.lastEventSeqByScope.get(key) || 0;
    if (eventSeq <= previousSeq) return { accepted: false, reason: "stale_event_seq" };
  }
  return { accepted: true };
}

function commitCausality(entry: Entry, event: SessionViewEvent) {
  const runId = normalizeOptionalString(event.runId || event.runtime?.runId);
  if (isRunStartEvent(event) && runId) {
    entry.causality.currentRunId = runId;
  } else if (runId && !entry.causality.currentRunId) {
    entry.causality.currentRunId = runId;
  }
  const eventSeq = finiteEventSeq(event.eventSeq);
  if (eventSeq != null) {
    const key = causalSequenceKey(event, runId, entry.causality.currentRunId);
    entry.causality.lastEventSeqByScope.set(key, eventSeq);
  }
  if (isTerminalEvent(event)) entry.causality.currentRunId = runId || entry.causality.currentRunId;
}

function causalSequenceKey(event: Partial<SessionViewEvent> = {}, runId = "", currentRunId = "") {
  const compactId = normalizeOptionalString(event.compactId);
  if (!runId && compactId && String(event.type || "").startsWith("context_compaction_")) {
    return `compact:${compactId}`;
  }
  return runId || currentRunId || "unscoped";
}

function resetCausality(entry: Entry, runId: string | null = "") {
  entry.causality.currentRunId = normalizeOptionalString(runId);
  entry.causality.lastEventSeqByScope.clear();
}

function createDefaultRuntime(): ClientRuntime {
  return {
    status: "idle",
    running: false,
    pendingStart: false,
    runId: null,
    waitId: "",
    waitMessage: "",
    waitTitle: "",
    waitForm: null,
    currentTool: null,
    currentToolName: "",
    currentToolStartedAt: "",
    contextUsage: null,
    contextUsageText: "",
    contextWindow: 0,
    inputTokensEstimate: 0,
    tracker: null,
    goal: null,
    workingTab: null,
    workingTabId: null,
    workingUrl: "",
    workingTitle: "",
    visitedTaskSites: [],
    pendingSteerings: [],
    pendingFollowUps: [],
    startedAt: "",
    endedAt: "",
    updatedAt: "",
  };
}

function runtimeEventMayChangeState(event: SessionViewEvent) {
  return [
    "state",
    "turn_start",
    "session_pending",
    "agent_start",
    "agent_end",
    "aborted",
    "error",
    "reset",
    "waiting_for_user",
    "user_wait_resolved",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "tool_call_update",
    "context_usage",
    "queue_update",
    "tracker_update",
    "goal_update",
    "skill_loaded",
  ].includes(event.type);
}

function derivedStatus(type: string) {
  if (type === "session_pending") return "pending";
  if (type === "turn_start") return "running";
  if (type === "agent_start") return "running";
  if (type === "waiting_for_user") return "waiting_user";
  if (type === "user_wait_resolved") return "running";
  if (type === "agent_end") return "completed";
  if (type === "aborted") return "aborted";
  if (type === "error") return "error";
  if (type === "reset") return "idle";
  return "";
}

function normalizeRuntimeStatus(status: unknown) {
  return normalizeSessionRuntimeStatus(status, SESSION_RUNTIME_STATUS.IDLE);
}

export function normalizeRuntimePendingFollowUps(items: unknown) {
  return (Array.isArray(items) ? items : [])
    .map(fields).map((item, index) => ({
      clientMessageId: normalizeClientMessageId(item?.clientMessageId),
      text: String(item?.text || "").trim(),
      imageCount: Math.max(0, Number(item?.imageCount) || 0),
      attachmentCount: Math.max(0, Number(item?.attachmentCount) || 0),
      index,
    }))
    .filter(item => item.clientMessageId || item.text || item.imageCount > 0 || item.attachmentCount > 0);
}

export function normalizeRuntimePendingSteerings(items: unknown) {
  return normalizeRuntimePendingFollowUps(items);
}

export function normalizeSessionCurrentTool(input: unknown = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tool = fields(input);
  const identity = normalizeToolIdentitySnapshot(tool);
  const name = identity.name;
  const toolCallId = String(tool.toolCallId || "").trim();
  const spanId = String(tool.spanId || "").trim();
  if (!name && !toolCallId && !spanId) return null;
  return {
    name: name || "tool",
    capabilityId: identity.capabilityId,
    title: identity.title,
    familyId: identity.familyId,
    familyTitle: identity.familyTitle,
    ...(identity.rendererId ? { rendererId: identity.rendererId } : {}),
    toolCallId,
    spanId,
    phase: String(tool.phase || "running").trim() || "running",
    statusText: String(tool.statusText || "").trim(),
    statusDetail: String(tool.statusDetail || "").trim(),
    startedAt: String(tool.startedAt || "").trim(),
    updatedAt: String(tool.updatedAt || "").trim(),
    rateLimit: normalizeObjectOrNull(tool.rateLimit),
  };
}

export function normalizeSessionWorkingTab(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tab = fields(input);
  return {
    id: finiteId(tab.id),
    title: String(tab.title || ""),
    url: String(tab.url || ""),
  };
}

export function normalizeSessionTaskSites(sites: unknown = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(sites) ? sites : []) {
    const item = fields(value);
    const site = normalizeSessionWorkingTab(value);
    const url = normalizeHttpUrl(String(site?.url || item?.url || ""));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      ...site,
      url,
      host: String(item?.host || safeUrlHost(url) || ""),
      visitedAt: String(item?.visitedAt || item?.updatedAt || ""),
    });
  }
  return out;
}

export function normalizeSessionGoal(input: unknown): GoalView | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const goal = fields(input);
  const status = goal.status === "blocked" || goal.status === "paused" || goal.status === "complete" ? goal.status : "active";
  const objective = clipText(String(goal.objective || "").trim(), 240);
  const criteria = clipText(String(goal.criteria || "").trim(), 360);
  const progress = clipText(String(goal.progress || "").trim(), 360);
  const next = clipText(String(goal.next || "").trim(), 240);
  const checkpoint = clipText(String(goal.checkpoint || "").trim(), 500);
  if (!objective && !criteria && !progress && !next && !checkpoint && status !== "complete") return null;
  return {
    status,
    objective,
    criteria,
    progress,
    next,
    checkpoint,
    version: Math.max(0, Math.floor(Number(goal.version) || 0)),
    createdAt: String(goal.createdAt || ""),
    updatedAt: String(goal.updatedAt || ""),
  };
}

export function normalizeSessionTracker(input: unknown): TrackerView | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tracker = fields(input);
  const steps = Array.isArray(tracker.steps)
    ? tracker.steps.map((step: unknown, index) => {
        const value = fields(step);
        const label = String(value.label || step || "").trim();
        if (!label) return null;
        return {
          id: String(value.id || `step_${index + 1}`),
          label: clipText(label, 80),
          status: String(value.status || ""),
        };
      }).filter((step): step is NonNullable<typeof step> => step !== null).slice(0, 50)
    : [];
  const mode = tracker.mode === "steps" || tracker.mode === "pagination" || tracker.mode === "generic"
    ? tracker.mode
    : (steps.length ? "steps" : "generic");
  const total = normalizeTrackerNumber(tracker.total, steps.length || 0);
  const current = normalizeTrackerNumber(tracker.current, 0);
  const completed = normalizeTrackerNumber(tracker.completed, current);
  const currentStep = normalizeTrackerNumber(
    tracker.currentStep,
    steps.length ? Math.min(steps.length, Math.max(1, completed + 1)) : 0,
  );
  return {
    id: String(tracker.id || ""),
    mode,
    title: clipText(String(tracker.title || trackerModeTitle(mode)), 80),
    steps,
    total,
    current: total > 0 ? Math.min(total, current) : current,
    completed: total > 0 ? Math.min(total, completed) : completed,
    currentStep: steps.length ? Math.max(1, Math.min(steps.length, currentStep || 1)) : 0,
    unit: clipText(String(tracker.unit || trackerModeUnit(mode)).trim(), 12),
    note: clipText(String(tracker.note || "").trim(), 120),
    stats: normalizeObjectOrNull(tracker.stats),
    updatedAt: String(tracker.updatedAt || ""),
  };
}

export function trackerModeTitle(mode = "") {
  if (mode === "pagination") return t("pagination");
  if (mode === "steps") return t("taskSteps");
  return t("taskProgress");
}

export function trackerModeUnit(mode = "") {
  if (mode === "pagination") return t("pagesUnit");
  if (mode === "steps") return t("stepsUnit");
  return "";
}

export function isSessionRuntimeActive(runtime: Partial<ClientRuntime> | null | undefined) {
  return Boolean(runtime?.running || isActiveSessionRuntimeStatus(runtime?.status));
}

function deriveRuntimeTracker(event: SessionViewEvent, source: Fields, previous: ClientRuntime, running: boolean) {
  if (event.type === "tracker_update") return normalizeSessionTracker(event.tracker);
  if (Object.prototype.hasOwnProperty.call(source, "tracker")) return normalizeSessionTracker(source.tracker);
  if (isRunStartEvent(event) || ["agent_end", "aborted", "error", "reset"].includes(event.type)) return null;
  return running ? normalizeSessionTracker(previous.tracker) : null;
}

function deriveRuntimeGoal(event: SessionViewEvent, source: Fields, previous: ClientRuntime) {
  if (event.type === "goal_update") return normalizeSessionGoal(event.goal);
  if (Object.prototype.hasOwnProperty.call(source, "goal")) return normalizeSessionGoal(source.goal);
  if (event.type === "reset") return null;
  return normalizeSessionGoal(previous.goal);
}

function deriveRuntimeContextUsage(event: SessionViewEvent, source: Fields, previous: ClientRuntime) {
  const hasRuntimeUsage = ["contextUsage", "contextUsageText", "contextWindow", "inputTokensEstimate"]
    .some(key => Object.prototype.hasOwnProperty.call(source, key));
  if (event.type !== "context_usage" && !hasRuntimeUsage) {
    return {
      contextUsage: previous.contextUsage,
      contextUsageText: previous.contextUsageText,
      contextWindow: previous.contextWindow,
      inputTokensEstimate: previous.inputTokensEstimate,
    };
  }
  const usage = normalizeObjectOrNull(event.usage ?? source.contextUsage);
  const inputTokensEstimate = nonNegativeNumber(
    event.inputTokensEstimate
      ?? source.inputTokensEstimate
      ?? usage?.inputTokensEstimate
      ?? usage?.input_tokens,
  );
  const contextWindow = nonNegativeNumber(event.contextWindow ?? source.contextWindow ?? usage?.contextWindow);
  return {
    contextUsage: usage,
    contextUsageText: String(source.contextUsageText || formatContextUsageText(inputTokensEstimate, contextWindow)),
    contextWindow,
    inputTokensEstimate,
  };
}



function deriveSessionRunning(event: SessionViewEvent, status: string, previousRunning = false) {
  const source = event.runtime && typeof event.runtime === "object" ? event.runtime : {};
  if (event.type === "state") {
    return Boolean(event.isStreaming || source.running || isActiveSessionRuntimeStatus(status));
  }
  if (event.type === "agent_start" || event.type === "waiting_for_user") return true;
  if (event.type === "user_wait_resolved" && event.reason === "stale") {
    return Boolean(source.running || isActiveSessionRuntimeStatus(source.status));
  }
  if (event.type === "user_wait_resolved") return true;
  if (["agent_end", "aborted", "error", "reset"].includes(event.type)) return false;
  if (typeof source.running === "boolean") return source.running;
  return Boolean(previousRunning || isActiveSessionRuntimeStatus(status));
}

function normalizeClientMessageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function normalizeTrackerNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Math.floor(Number(fallback) || 0));
  return Math.max(0, Math.floor(number));
}

function normalizeHttpUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch (_err) {
    return "";
  }
}

function safeUrlHost(value = "") {
  try {
    return new URL(String(value || "")).hostname.toLowerCase();
  } catch (_err) {
    return "";
  }
}

function clipText(text: unknown, maxChars: number) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function artifactSummaryFromListSummary(summary: unknown = {}) {
  const normalized = normalizeSessionListSummary(summary);
  return {
    artifactCount: normalized.artifactCount,
    artifactPreview: normalized.artifactPreview,
    dataCount: normalized.dataCount,
    fileCount: normalized.fileCount,
    artifactSignature: normalized.artifactSignature,
    artifactUpdatedAt: normalized.artifactUpdatedAt,
  };
}

function normalizeArtifactSummaryPatch(value: unknown = {}) {
  const input = fields(value);
  return {
    ...(Object.prototype.hasOwnProperty.call(input, "artifactCount") ? { artifactCount: input.artifactCount } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "artifactPreview") ? { artifactPreview: input.artifactPreview } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "dataCount") ? { dataCount: input.dataCount } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "fileCount") ? { fileCount: input.fileCount } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "artifactSignature") ? { artifactSignature: input.artifactSignature } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "artifactUpdatedAt") ? { artifactUpdatedAt: input.artifactUpdatedAt } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "updatedAt") ? { updatedAt: input.updatedAt } : {}),
  };
}

function looksLikeArtifactCollections(value: unknown) {
  return Boolean(value && typeof value === "object" && (
    Array.isArray(fields(value).items)
    || Array.isArray(fields(value).imageCollections)
    || Array.isArray(fields(value).dataTables)
    || Array.isArray(fields(value).files)
  ));
}

function rejectedChange(reason: string, patch: ChangePatch = {}) {
  return {
    accepted: false,
    reason,
    sessionId: patch.sessionId || "",
    eventType: patch.eventType || "",
    stale: patch.stale === true,
    runtimeChanged: false,
    transcriptChanged: false,
    recordChanged: false,
    artifactsChanged: false,
    terminal: false,
    revision: emptyRevision(),
    snapshot: patch.snapshot || null,
  };
}


function normalizeOptionalString(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function normalizeObjectOrNull(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? cloneObject(fields(value)) : null;
}

function finiteId(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function finiteEventSeq(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isTerminalEvent(event: Partial<SessionViewEvent>) {
  return ["agent_end", "aborted", "error", "reset"].includes(event.type || "");
}

function isTerminalRuntime(runtime: Partial<ClientRuntime>) {
  return !runtime?.running && isSettledSessionRuntimeStatus(runtime?.status);
}

function recordSignature(record: unknown) {
  return stableJson(record || null);
}

function runtimeSignature(runtime: unknown) {
  return stableJson(runtime || null);
}

function transcriptSignature(transcript: unknown) {
  return stableJson(Array.isArray(transcript) ? transcript : []);
}

function stableJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function cloneObject<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch (_err) {
    return JSON.parse(JSON.stringify(value));
  }
}

function cloneArray<T>(value: readonly T[]): T[] {
  return Array.isArray(value) ? value.map(cloneObject) : [];
}

function cloneTranscriptProjection(value: TranscriptEntry[]): TranscriptEntry[] {
  return Array.isArray(value)
    ? value.map(entry => (entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry } : entry))
    : [];
}

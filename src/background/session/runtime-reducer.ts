import {
  SESSION_RUNTIME_STATUS,
  isActiveSessionRuntimeStatus,
  isTerminalSessionRuntimeStatus,
  normalizeSessionRuntimeStatus,
} from "../../shared/session/session-runtime-status.js";

type Fields = Record<string, unknown>;
import type { SessionRuntime } from "../../shared/contracts/session-runtime.js";
export type { SessionRuntime } from "../../shared/contracts/session-runtime.js";
interface ReduceOptions { now?: string; currentTool?: Fields | null }
const record = (value: unknown): Fields => isPlainObject(value) ? value : {};

export const SESSION_RUNTIME_SCHEMA_VERSION = 3;

export const SESSION_STATUS = SESSION_RUNTIME_STATUS;

export function isActiveSessionStatus(status: unknown) {
  return isActiveSessionRuntimeStatus(status);
}

export function isTerminalSessionStatus(status: unknown) {
  return isTerminalSessionRuntimeStatus(status);
}

export function createInitialSessionRuntime(sessionId: unknown, now: string | number = ""): SessionRuntime {
  return {
    schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
    sessionId: normalizeId(sessionId),
    status: SESSION_STATUS.IDLE,
    running: false,
    pendingStart: false,
    interrupted: false,
    runId: null,
    updatedAt: now,
    startedAt: "",
    endedAt: "",
    reason: "",
    currentToolName: "",
    currentToolStartedAt: "",
    currentTool: null,
    contextUsage: null,
    tracker: null,
    goal: null,
    waitId: "",
    waitMessage: "",
    waitTitle: "",
    waitForm: null,
    pendingFollowUps: [],
    pendingFollowUpMessages: [],
    composerDrafts: {},
    pendingSteerings: [],
    pendingSteeringMessages: [],
    loadedPluginSkillNames: [],
    workingTab: null,
    workingTabId: null,
    workingUrl: "",
    workingTitle: "",
    ownedTabIds: [],
    visitedTaskSites: [],
  };
}

export function normalizeSessionRuntime(input: unknown, sessionId: unknown = "", now: string | number = ""): SessionRuntime {
  const source = isPlainObject(input) ? clonePlain(input) : {};
  const status = normalizeStatus(source.status) || SESSION_STATUS.IDLE;
  const running = source.running === true || (source.running !== false && isActiveSessionStatus(status));
  return {
    ...createInitialSessionRuntime(sessionId || source.sessionId, now),
    ...source,
    schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
    sessionId: normalizeId(sessionId || source.sessionId),
    status,
    running,
    pendingStart: running && (source.pendingStart === true || status === SESSION_STATUS.PENDING),
    interrupted: status === SESSION_STATUS.INTERRUPTED || source.interrupted === true,
    runId: normalizeNullableId(source.runId),
    updatedAt: source.updatedAt || now,
    currentTool: isPlainObject(source.currentTool) ? clonePlain(source.currentTool) : null,
    contextUsage: isPlainObject(source.contextUsage) ? clonePlain(source.contextUsage) : null,
    tracker: isPlainObject(source.tracker) ? clonePlain(source.tracker) : null,
    goal: isPlainObject(source.goal) ? clonePlain(source.goal) : null,
    waitForm: isPlainObject(source.waitForm) ? clonePlain(source.waitForm) : null,
    pendingFollowUps: cloneArray(source.pendingFollowUps),
    pendingFollowUpMessages: cloneArray(source.pendingFollowUpMessages),
    composerDrafts: isPlainObject(source.composerDrafts) ? clonePlain(source.composerDrafts) : {},
    pendingSteerings: cloneArray(source.pendingSteerings),
    pendingSteeringMessages: cloneArray(source.pendingSteeringMessages),
    loadedPluginSkillNames: uniqueStrings(source.loadedPluginSkillNames),
    ownedTabIds: uniqueTabIds(source.ownedTabIds || source.sessionTabIds),
    visitedTaskSites: cloneArray(source.visitedTaskSites),
  };
}

export function reduceSessionRuntime(previous: unknown, event: Fields = {}, options: ReduceOptions = {}) {
  const now = options.now || String(record(previous).updatedAt || "");
  const current = normalizeSessionRuntime(previous, record(previous).sessionId || event.sessionId, now);
  const patch = reduceSessionRuntimePatch(current, event, { ...options, now });
  return patch ? normalizeSessionRuntime({ ...current, ...patch }, current.sessionId, now) : current;
}

export function reduceSessionRuntimePatch(previous: Partial<SessionRuntime> = {}, event: Fields = {}, { now = "", currentTool = undefined }: ReduceOptions = {}): Fields | null {
  const type = String(event.type || "");
  const runId = event.runId || previous.runId || null;
  switch (type) {
    case "session_pending":
      return {
        status: SESSION_STATUS.PENDING,
        running: true,
        pendingStart: true,
        interrupted: false,
        runId: event.runId || null,
        startedAt: event.startedAt || now,
        endedAt: "",
        reason: "",
        tracker: null,
      };
    case "agent_start":
      return {
        status: SESSION_STATUS.RUNNING,
        running: true,
        pendingStart: false,
        interrupted: false,
        runId,
        startedAt: event.startedAt || now,
        endedAt: "",
        reason: "",
        currentToolName: "",
        currentToolStartedAt: "",
        currentTool: null,
        tracker: null,
      };
    case "tool_execution_start":
    case "tool_execution_update": {
      const tool = currentTool === undefined ? event.currentTool : currentTool;
      const toolFields = record(tool);
      return {
        currentToolName: toolFields.name || event.toolName || "tool",
        currentToolStartedAt: toolFields.startedAt || previous.currentToolStartedAt || now,
        currentTool: isPlainObject(tool) ? clonePlain(tool) : null,
      };
    }
    case "tool_execution_end": {
      const tool = currentTool === undefined
        ? (event.toolCallId && record(previous.currentTool).toolCallId !== event.toolCallId ? previous.currentTool : null)
        : currentTool;
      return {
        currentToolName: record(tool).name || "",
        currentToolStartedAt: record(tool).startedAt || "",
        currentTool: isPlainObject(tool) ? clonePlain(tool) : null,
      };
    }
    case "context_usage":
      return {
        contextUsage: event.usage || previous.contextUsage || {},
        contextWindow: event.contextWindow || previous.contextWindow || 0,
        inputTokensEstimate: event.inputTokensEstimate || previous.inputTokensEstimate || 0,
        contextEstimateSource: event.contextEstimateSource || previous.contextEstimateSource || "",
        usageAnchorTokens: event.usageAnchorTokens || previous.usageAnchorTokens || 0,
        estimatedTrailingTokens: event.estimatedTrailingTokens || previous.estimatedTrailingTokens || 0,
        toolSchemaTokens: event.toolSchemaTokens || previous.toolSchemaTokens || 0,
        messageTokensEstimate: event.messageTokensEstimate || previous.messageTokensEstimate || 0,
        contextBoundaryId: event.contextBoundaryId || previous.contextBoundaryId || "",
        usageAnchorMessageIndex: Number.isFinite(Number(event.usageAnchorMessageIndex))
          ? Number(event.usageAnchorMessageIndex)
          : previous.usageAnchorMessageIndex,
      };
    case "skill_loaded":
      return {
        loadedPluginSkillNames: uniqueStrings([
          ...(previous.loadedPluginSkillNames || []),
          event.name,
          event.displayName,
          ...(Array.isArray(event.loadedPluginSkillNames) ? event.loadedPluginSkillNames : []),
        ]),
      };
    case "queue_update": {
      const patch = {
        pendingFollowUpMessages: cloneArray(event.pendingFollowUpMessages),
        pendingSteeringMessages: cloneArray(event.pendingSteeringMessages),
      };
      if ((previous.status === SESSION_STATUS.COMPLETED || (event.resume === true && !isActiveSessionStatus(previous.status)))
        && (patch.pendingFollowUpMessages.length || patch.pendingSteeringMessages.length)) {
        return { ...patch, status: SESSION_STATUS.PENDING, running: true, pendingStart: true, runId: null, endedAt: "", reason: "" };
      }
      // Removing the last queued message can finish an otherwise idle handoff. An active
      // initialization/terminal commit still owns that decision until its occupancy is released.
      return previous.status === SESSION_STATUS.PENDING && event.isRunning === false
        && !patch.pendingFollowUpMessages.length && !patch.pendingSteeringMessages.length
        ? { ...patch, ...terminalPatch({ status: SESSION_STATUS.COMPLETED, reason: "" }, now) }
        : patch;
    }
    case "waiting_for_user":
      return {
        status: SESSION_STATUS.WAITING_USER,
        running: true,
        pendingStart: false,
        waitId: String(event.waitId || ""),
        waitMessage: String(event.message || ""),
        waitTitle: String(record(event.form).title || event.title || ""),
        waitForm: isPlainObject(event.form) ? clonePlain(event.form) : null,
        runId,
        reason: "waiting_for_user",
      };
    case "user_wait_resolved":
      return {
        status: SESSION_STATUS.RUNNING,
        running: true,
        pendingStart: false,
        waitId: "",
        waitMessage: "",
        waitTitle: "",
        waitForm: null,
        reason: String(event.reason || ""),
      };
    case "agent_end": {
      const previousStatus = normalizeStatus(previous.status);
      const preserve = isTerminalSessionStatus(previousStatus) && previousStatus !== SESSION_STATUS.COMPLETED;
      const patch = terminalPatch({
        status: preserve ? previous.status : SESSION_STATUS.COMPLETED,
        runId,
        reason: preserve ? (previous.reason || previous.status) : "",
      }, now);
      // Completion is a task-level observation: a successful run with accepted work still
      // queued hands off to pending, without an intermediate completed snapshot.
      return !preserve && (previous.pendingFollowUpMessages?.length || previous.pendingSteeringMessages?.length)
        ? { ...patch, status: SESSION_STATUS.PENDING, running: true, pendingStart: true, runId: null, endedAt: "" }
        : patch;
    }
    case "aborted":
    case "session_aborted":
      return terminalPatch({
        status: SESSION_STATUS.ABORTED,
        runId,
        reason: String(event.reason || "aborted"),
      }, now);
    case "error":
    case "session_error":
      return terminalPatch({
        status: SESSION_STATUS.ERROR,
        runId,
        reason: String(event.message || record(event.error).message || event.error || "error"),
      }, now);
    case "reset":
      return terminalPatch({
        status: SESSION_STATUS.IDLE,
        runId: null,
        reason: "reset",
        pendingFollowUpMessages: [],
        pendingFollowUps: [],
        pendingSteeringMessages: [],
        pendingSteerings: [],
        goal: null,
      }, now);
    default:
      return null;
  }
}

export function recoverPersistedRuntime(runtime: unknown, now = "") {
  const current = normalizeSessionRuntime(runtime, record(runtime).sessionId, now);
  if (!isActiveSessionStatus(current.status)) return current;
  return normalizeSessionRuntime({
    ...current,
    ...terminalPatch({
      status: SESSION_STATUS.INTERRUPTED,
      runId: current.runId,
      reason: "service_worker_restarted",
      interrupted: true,
    }, now),
  }, current.sessionId, now);
}

function terminalPatch(patch: Fields, now: string) {
  return {
    ...patch,
    running: false,
    pendingStart: false,
    waitId: "",
    waitMessage: "",
    waitTitle: "",
    waitForm: null,
    endedAt: now,
    currentToolName: "",
    currentToolStartedAt: "",
    currentTool: null,
    tracker: null,
  };
}

function normalizeStatus(value: unknown) {
  return normalizeSessionRuntimeStatus(value);
}

function normalizeNullableId(value: unknown) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function normalizeId(value: unknown) {
  return String(value || "").trim();
}

function isPlainObject(value: unknown): value is Fields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(clonePlain) : [];
}

function clonePlain<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePlain(item)])) as T;
}

function uniqueStrings(values: unknown) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))];
}

function uniqueTabIds(values: unknown) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 0))];
}

import { normalizeToolIdentitySnapshot } from "../../shared/tools/tool-identity.js";
import {
  isActiveSessionRuntimeStatus,
  isSettledSessionRuntimeStatus,
} from "../../shared/session/session-runtime-status.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { reduceSessionRuntimePatch } from "./runtime-reducer.js";
import {
  getOwnedTabIds,
  hasOwnedTabPatch,
  normalizeSessionTabIds,
  normalizeVisitedTaskSites,
  OWNED_TAB_SCHEMA_VERSION,
} from "./tabs.js";
import { normalizeSessionGoal } from "./task-state.js";
import { normalizeMessageDocuments } from "../../shared/documents/document-attachments.js";

import type { createSessionSupervisor, SupervisorAgent } from "./supervisor.js";
import type { createSessionRepository } from "./repository.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
type Fields = Record<string, unknown>;
type RuntimeSupervisor = ReturnType<typeof createSessionSupervisor<SupervisorAgent>>;
interface RuntimeStateOptions {
  supervisor: Pick<RuntimeSupervisor, "replaceRuntimes" | "getRuntime" | "setRuntime" | "runtimeEntries" | "deleteRuntime">;
  repository: Pick<ReturnType<typeof createSessionRepository>, "migrateLegacyRuntime" | "readRuntimeBatch" | "writeRuntime" | "deleteRuntime">;
  getSessions(): Promise<Record<string, SessionMetadata>>;
  getAgentEntry(sessionId: string): { ready: Promise<unknown> | null };
  normalizeSessionId(value: unknown): string;
  scheduleTabGroupSync?(sessionId: string): unknown;
  onCompleted?(sessionId: string): Promise<unknown>;
  onTaskCompleted?(sessionId: string, runtime: Fields): unknown;
  logger?: Pick<Console, "warn" | "debug">;
  now?(): string;
}
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error;

const FOLLOW_UP_RESUME_DELAY_MS = 250;

/** Persistent Session runtime projection owned by SessionSupervisor. */
export function createSessionRuntimeState({
  supervisor,
  repository,
  getSessions,
  getAgentEntry,
  normalizeSessionId,
  scheduleTabGroupSync = () => {},
  onCompleted = async () => {},
  onTaskCompleted = () => {},
  logger = console,
  now = nowBeijingDateTime,
}: RuntimeStateOptions) {
  if (!supervisor) throw new TypeError("supervisor is required");
  if (!repository) throw new TypeError("repository is required");
  if (typeof getSessions !== "function") throw new TypeError("getSessions is required");
  if (typeof getAgentEntry !== "function") throw new TypeError("getAgentEntry is required");
  if (typeof normalizeSessionId !== "function") throw new TypeError("normalizeSessionId is required");

  let followUpResumeTimer: ReturnType<typeof setTimeout> | null = null;
  // Execution events can overlap; only the selected tool is persisted and projected to clients.
  const activeTools = new Map<string, Map<string, NonNullable<ReturnType<typeof normalizeCurrentTool>>>>();
  const toolKey = (tool: Fields) => String(tool.toolCallId || tool.spanId || tool.toolName || tool.name || "tool");

  async function hydrate() {
    activeTools.clear();
    try {
      await repository.migrateLegacyRuntime();
      const sessions = await getSessions();
      const stored = await repository.readRuntimeBatch(Object.keys(sessions));
      const runtimes = Object.fromEntries(
        Object.entries(stored).filter((entry): entry is [string, NonNullable<typeof entry[1]>] => !!entry[1] && typeof entry[1] === "object"),
      );
      const currentTime = now();
      let changed = false;
      for (const [sessionId, original] of Object.entries(runtimes)) {
        let runtime = original;
        if (isActiveSessionRuntimeStatus(runtime.status)) {
          runtime = {
            ...runtime,
            sessionId,
            status: "interrupted",
            running: false,
            pendingStart: false,
            interrupted: true,
            reason: "service_worker_restarted",
            endedAt: currentTime,
            updatedAt: currentTime,
            tracker: null,
          };
          changed = true;
        }
        if (runtime.ownedTabSchemaVersion !== OWNED_TAB_SCHEMA_VERSION) {
          runtime = {
            ...runtime,
            ownedTabIds: [],
            sessionTabIds: [],
            ownedTabSchemaVersion: OWNED_TAB_SCHEMA_VERSION,
          };
          changed = true;
        }
        const ownedTabIds = getOwnedTabIds(runtime);
        if (!sameJson(runtime.ownedTabIds || [], ownedTabIds) || !sameJson(runtime.sessionTabIds || [], ownedTabIds)) {
          runtime = {
            ...runtime,
            ownedTabIds,
            sessionTabIds: ownedTabIds,
            ownedTabSchemaVersion: OWNED_TAB_SCHEMA_VERSION,
          };
          changed = true;
        }
        const visitedTaskSites = normalizeVisitedTaskSites(runtime.visitedTaskSites);
        if (!sameJson(runtime.visitedTaskSites || [], visitedTaskSites)) {
          runtime = { ...runtime, visitedTaskSites };
          changed = true;
        }
        const loadedPluginSkillNames = normalizeLoadedSkillNames(runtime.loadedPluginSkillNames);
        if (!sameJson(runtime.loadedPluginSkillNames || [], loadedPluginSkillNames)) {
          runtime = { ...runtime, loadedPluginSkillNames };
          changed = true;
        }
        const pendingFollowUpMessages = normalizePendingFollowUps(runtime.pendingFollowUpMessages);
        const pendingFollowUps = summarizePendingFollowUps(pendingFollowUpMessages);
        const pendingSteeringMessages = normalizePendingFollowUps(runtime.pendingSteeringMessages);
        const pendingSteerings = summarizePendingFollowUps(pendingSteeringMessages);
        if (
          !sameJson(runtime.pendingFollowUpMessages || [], pendingFollowUpMessages)
          || !sameJson(runtime.pendingFollowUps || [], pendingFollowUps)
          || !sameJson(runtime.pendingSteeringMessages || [], pendingSteeringMessages)
          || !sameJson(runtime.pendingSteerings || [], pendingSteerings)
        ) {
          runtime = {
            ...runtime,
            pendingFollowUpMessages,
            pendingFollowUps,
            pendingSteeringMessages,
            pendingSteerings,
          };
          changed = true;
        }
        runtimes[sessionId] = runtime;
      }
      supervisor.replaceRuntimes(runtimes);
      if (changed) await persist();
    } catch (error) {
      logger?.warn?.("[轻舟] hydrate session runtime failed:", error);
      supervisor.replaceRuntimes({});
    }
  }

  function persist(sessionId = "", { terminal = false } = {}) {
    const id = normalizeSessionId(sessionId);
    if (sessionId) {
      const runtime = supervisor.getRuntime(id);
      return runtime
        ? repository.writeRuntime(id, runtime, { terminal })
        : repository.deleteRuntime(id);
    }
    return Promise.all(supervisor.runtimeEntries().map(([runtimeSessionId, runtime]) => (
      repository.writeRuntime(runtimeSessionId, runtime, {
        terminal: terminal || isSettledSessionRuntimeStatus(runtime?.status),
      })
    )));
  }

  function set(sessionId: string, patch: Fields = {}) {
    const id = normalizeSessionId(sessionId);
    const previous = supervisor.getRuntime(id) || {};
    const normalizedPatch = normalizePatch(patch);
    if (patch.currentTool === null || patch.running === false
      || (Object.prototype.hasOwnProperty.call(patch, "runId") && patch.runId !== previous.runId)) {
      activeTools.delete(id);
    }
    const next = supervisor.setRuntime(id, {
      ...previous,
      sessionId: id,
      ...normalizedPatch,
      updatedAt: now(),
    });
    persist(id, { terminal: isSettledSessionRuntimeStatus(next?.status) })
      .catch(error => logger?.warn?.("[轻舟] persist session runtime failed:", error));
    if (hasOwnedTabPatch(patch)) scheduleTabGroupSync(id);
    if (shouldNotifyCompleted(previous, next, patch)) {
      onCompleted(id).catch(error => {
        logger?.debug?.("[轻舟] completion notification failed:", errorMessage(error));
      });
      // Same transition the completion notification uses. Repeats stay quiet; the review store keeps root sessions.
      Promise.resolve(onTaskCompleted(id, next || {})).catch(error => {
        logger?.debug?.("[轻舟] completed task count failed:", errorMessage(error));
      });
    }
    return next;
  }

  function remove(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    activeTools.delete(id);
    supervisor.deleteRuntime(id);
    repository.deleteRuntime(id).catch(error => logger?.warn?.("[轻舟] remove session runtime failed:", error));
    scheduleTabGroupSync(id);
  }

  function recordEvent(sessionId: string, event: Fields = {}) {
    const id = normalizeSessionId(sessionId);
    const previous = supervisor.getRuntime(id) || {};
    let currentTool: ReturnType<typeof normalizeCurrentTool> | undefined;
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) {
      if (event.runId && previous.runId && event.runId !== previous.runId) return;
      let tools = activeTools.get(id);
      if (!tools) {
        tools = new Map();
        const restored = normalizeCurrentTool(previous.currentTool);
        if (restored) tools.set(toolKey(restored), restored);
        activeTools.set(id, tools);
      }
      const key = toolKey(event);
      const previousTool = tools.get(key);
      tools.delete(key);
      if (event.type !== "tool_execution_end") {
        const tool = currentToolFromEvent(event, event.type === "tool_execution_start" ? null : previousTool);
        if (tool) tools.set(key, tool);
      }
      currentTool = [...tools.values()].at(-1) || null;
    }
    const patch = reduceSessionRuntimePatch(previous, event, { now: now(), currentTool });
    if (patch) set(id, patch);
  }

  function isTerminalForRun(runtime: Fields = {}, runId = "") {
    const status = String(runtime?.status || "").trim().toLowerCase();
    if (runtime?.running || isActiveSessionRuntimeStatus(status)) return false;
    if (runId && runtime?.runId && runtime.runId !== runId) return true;
    return isSettledSessionRuntimeStatus(status);
  }

  async function clearContextUsage() {
    let changed = false;
    for (const [sessionId, runtime] of supervisor.runtimeEntries()) {
      if (!hasContextUsage(runtime)) continue;
      supervisor.setRuntime(sessionId, {
        ...runtime,
        contextUsage: null,
        contextWindow: 0,
        inputTokensEstimate: 0,
        contextEstimateSource: "",
        usageAnchorTokens: 0,
        estimatedTrailingTokens: 0,
        toolSchemaTokens: 0,
        messageTokensEstimate: 0,
        contextBoundaryId: "",
        usageAnchorMessageIndex: -1,
      });
      changed = true;
    }
    if (changed) await persist();
    return changed;
  }

  function loadedSkillNames(sessionId = "", extra: unknown = []) {
    const id = normalizeSessionId(sessionId);
    return mergeLoadedSkillNames(supervisor.getRuntime(id)?.loadedPluginSkillNames || [], extra);
  }

  function recordLoadedSkillNames(sessionId = "", names: unknown = []) {
    const merged = loadedSkillNames(sessionId, names);
    set(sessionId, { loadedPluginSkillNames: merged });
    return merged;
  }

  function queueFollowUpResume(reason = "startup") {
    if (followUpResumeTimer) clearTimeout(followUpResumeTimer);
    followUpResumeTimer = setTimeout(() => {
      followUpResumeTimer = null;
      resumeFollowUps(reason).catch(error => {
        logger?.warn?.("[轻舟] resume persisted follow-ups failed:", error);
      });
    }, FOLLOW_UP_RESUME_DELAY_MS);
  }

  async function resumeFollowUps(reason = "startup") {
    const resumed = [];
    const candidates = supervisor.runtimeEntries()
      .filter(([, runtime]) => (
        normalizePendingFollowUps(runtime?.pendingFollowUpMessages).length > 0
        || normalizePendingFollowUps(runtime?.pendingSteeringMessages).length > 0
      ))
      .map(([sessionId]) => normalizeSessionId(sessionId));
    for (const sessionId of candidates) {
      try {
        const pending = normalizePendingFollowUps(supervisor.getRuntime(sessionId)?.pendingFollowUpMessages);
        const steering = normalizePendingFollowUps(supervisor.getRuntime(sessionId)?.pendingSteeringMessages);
        if (!pending.length && !steering.length) continue;
        const entry = getAgentEntry(sessionId);
        await entry.ready;
        resumed.push(sessionId);
      } catch (error) {
        logger?.warn?.(`[轻舟] resume persisted follow-up failed: session=${sessionId}`, error);
      }
    }
    if (resumed.length) logger?.debug?.("[轻舟] resumed persisted follow-up queues", { reason, sessions: resumed });
    return resumed;
  }

  function normalizePatch(patch: Fields = {}) {
    const next = { ...patch };
    if (Object.prototype.hasOwnProperty.call(next, "currentTool")) next.currentTool = normalizeCurrentTool(next.currentTool);
    if (hasOwnedTabPatch(next)) {
      const ids = normalizeSessionTabIds(
        Object.prototype.hasOwnProperty.call(next, "ownedTabIds") ? next.ownedTabIds : next.sessionTabIds,
      );
      next.ownedTabIds = ids;
      next.sessionTabIds = ids;
      next.ownedTabSchemaVersion = OWNED_TAB_SCHEMA_VERSION;
    }
    if (Object.prototype.hasOwnProperty.call(next, "visitedTaskSites")) {
      next.visitedTaskSites = normalizeVisitedTaskSites(next.visitedTaskSites);
    }
    if (Object.prototype.hasOwnProperty.call(next, "loadedPluginSkillNames")) {
      next.loadedPluginSkillNames = normalizeLoadedSkillNames(next.loadedPluginSkillNames);
    }
    if (Object.prototype.hasOwnProperty.call(next, "goal")) next.goal = normalizeSessionGoal(next.goal);
    if (Object.prototype.hasOwnProperty.call(next, "pendingFollowUpMessages")) {
      next.pendingFollowUpMessages = normalizePendingFollowUps(next.pendingFollowUpMessages);
      next.pendingFollowUps = summarizePendingFollowUps(next.pendingFollowUpMessages);
    } else if (Object.prototype.hasOwnProperty.call(next, "pendingFollowUps")) {
      next.pendingFollowUps = normalizePendingSummaries(next.pendingFollowUps);
    }
    if (Object.prototype.hasOwnProperty.call(next, "pendingSteeringMessages")) {
      next.pendingSteeringMessages = normalizePendingFollowUps(next.pendingSteeringMessages);
      next.pendingSteerings = summarizePendingFollowUps(next.pendingSteeringMessages);
    } else if (Object.prototype.hasOwnProperty.call(next, "pendingSteerings")) {
      next.pendingSteerings = normalizePendingSummaries(next.pendingSteerings);
    }
    return next;
  }

  function currentToolFromEvent(event: Fields, previous: unknown) {
    const currentTime = now();
    const previousTool = normalizeCurrentTool(previous);
    const identity = normalizeToolIdentitySnapshot(event, previousTool || { name: "tool" });
    return normalizeCurrentTool({
      ...identity,
      name: identity.name || "tool",
      toolCallId: event.toolCallId || previousTool?.toolCallId || "",
      spanId: event.spanId || previousTool?.spanId || "",
      phase: event.phase || previousTool?.phase || "running",
      statusText: event.statusText != null ? event.statusText : (previousTool?.statusText || ""),
      statusDetail: event.statusDetail != null ? event.statusDetail : (previousTool?.statusDetail || ""),
      startedAt: previousTool?.startedAt || currentTime,
      updatedAt: currentTime,
      rateLimit: event.rateLimit !== undefined ? event.rateLimit : previousTool?.rateLimit || null,
    });
  }

  function normalizeCurrentTool(value: unknown = null) {
    const tool = record(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const identity = normalizeToolIdentitySnapshot(tool);
    const toolCallId = String(tool.toolCallId || "").trim();
    const spanId = String(tool.spanId || "").trim();
    if (!identity.name && !toolCallId && !spanId) return null;
    return {
      name: identity.name || "tool",
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
      updatedAt: String(tool.updatedAt || now()).trim(),
      rateLimit: tool.rateLimit && typeof tool.rateLimit === "object" && !Array.isArray(tool.rateLimit)
        ? JSON.parse(JSON.stringify(tool.rateLimit)) as Fields
        : null,
    };
  }

  return Object.freeze({
    hydrate,
    persist,
    set,
    remove,
    recordEvent,
    isTerminalForRun,
    normalizeCurrentTool,
    clearContextUsage,
    loadedSkillNames,
    recordLoadedSkillNames,
    queueFollowUpResume,
    resumeFollowUps,
    normalizePendingFollowUps,
    summarizePendingFollowUps,
    normalizePendingSteerings: normalizePendingFollowUps,
    summarizePendingSteerings: summarizePendingFollowUps,
    normalizeLoadedSkillNames,
  });
}

function normalizePendingSummaries(items: unknown = []) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    clientMessageId: String(item?.clientMessageId || "").trim(),
    text: String(item?.text || ""),
    imageCount: Math.max(0, Number(item?.imageCount) || 0),
    ...(Number(item?.attachmentCount) > 0
      ? { attachmentCount: Math.max(0, Number(item.attachmentCount) || 0) }
      : {}),
    index,
  }));
}

function normalizePendingFollowUps(messages: unknown = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && typeof message === "object" && message.role === "user")
    .map(message => ({
      role: "user",
      content: Array.isArray(message.content) ? message.content.map((part: unknown) => ({ ...record(part) })) : String(message.content || ""),
      clientMessageId: String(message.clientMessageId || "").trim(),
      _origin: message._origin || "user",
      documents: normalizeMessageDocuments(message.documents),
    }));
}

function summarizePendingFollowUps(messages: unknown = []) {
  return normalizePendingFollowUps(messages).map((message, index) => ({
    clientMessageId: message.clientMessageId,
    text: queuedMessageText(message),
    imageCount: queuedMessageImageCount(message),
    ...(normalizeMessageDocuments(message.documents).length
      ? { attachmentCount: normalizeMessageDocuments(message.documents).length }
      : {}),
    index,
  }));
}

function normalizeLoadedSkillNames(value: unknown = []) {
  const raw = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.keys(value).filter(key => record(value)[key])
        : [];
  return [...new Set(raw.map(item => String(item || "").trim().toLowerCase()).filter(Boolean))];
}

function mergeLoadedSkillNames(...values: unknown[]) {
  return normalizeLoadedSkillNames(values.flatMap(value => normalizeLoadedSkillNames(value)));
}

function queuedMessageText(message: { content?: unknown } = {}) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(part => part?.type === "text").map(part => String(part.text || "")).join("\n").trim();
}

function queuedMessageImageCount(message: { content?: unknown } = {}) {
  return Array.isArray(message.content) ? message.content.filter(part => part?.type === "image_url").length : 0;
}

function hasContextUsage(runtime: Fields = {}) {
  return Boolean(
    runtime?.contextUsage
    || runtime?.contextWindow
    || runtime?.inputTokensEstimate
    || runtime?.contextEstimateSource
    || runtime?.usageAnchorTokens
    || runtime?.estimatedTrailingTokens
    || runtime?.toolSchemaTokens
    || runtime?.messageTokensEstimate
    || runtime?.contextBoundaryId
    || Number(runtime?.usageAnchorMessageIndex) >= 0
  );
}

function shouldNotifyCompleted(previous: Fields = {}, next: Fields | null = {}, patch: Fields = {}) {
  return patch.status === "completed"
    && previous.status !== "completed"
    && next?.status === "completed"
    && !next.running;
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

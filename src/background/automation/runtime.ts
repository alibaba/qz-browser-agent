import { createDisabledAutomationRuntime } from "./disabled-runtime.js";
import { promptT } from "./prompt-messages.js";
import { AUTOMATION_SCHEDULER_ALARM } from "../../shared/automation-scheduler-alarm.js";
import { sessionAutomationsEnabled } from "../../shared/session-automations.js";
import { t } from "../../shared/i18n/backend.js";
import type { Automation, AutomationRun } from "../../shared/automation-store.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { createAutomationRepository } from "./repository.js";
type Fields = Record<string, unknown>;
interface AutomationSessionPort {
  create(input: { automation: Automation; run: AutomationRun; prompt: string; signal?: AbortSignal }): Promise<{ id: string }>;
  launch(id: string, prompt: string, signal?: AbortSignal): boolean | Promise<boolean>;
  remove(id: string, options: { source: string }): Promise<unknown>;
  getRuntime(id: string): Fields;
  getMetadata?(id: string): Promise<SessionMetadata | null>;
  listRecords?(): Promise<Record<string, SessionMetadata>>;
  getConversation(id: string): Promise<unknown>;
  getTranscript(id: string, conversation: unknown): Promise<unknown>;
  activateWorkingTab?(id: string, options: { focusWindow: boolean }): Promise<unknown>;
  shouldSuppressNotification?(id: string): Promise<boolean>;
}
interface AutomationRuntimeOptions {
  repository: ReturnType<typeof createAutomationRepository>;
  sessions: AutomationSessionPort;
  alarms?: Pick<typeof chrome.alarms, "get" | "create"> | null;
  notifications?: { iconUrl: string; create(id: string, options: chrome.notifications.NotificationCreateOptions): Promise<string>; clear?(id: string): Promise<unknown> } | null;
  emit?: ((event: Fields) => unknown) | null;
  ready?(): Promise<unknown>; clock?(): number; logger?: Pick<Console, "warn" | "debug">;
}
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
import {
  AUTOMATION_MISSED_POLICY,
  AUTOMATION_NOTIFY_POLICY,
  AUTOMATION_RUN_STATUS,
  computeNextRunAt,
  describeAutomationSchedule,
  isActiveAutomationRunStatus,
} from "../../shared/automation-store.js";
import { normalizeSessionListSummary } from "../../shared/session/session-list-summary.js";
import {
  isActiveSessionRuntimeStatus,
  normalizeSessionRuntimeStatus,
  SESSION_RUNTIME_STATUS,
} from "../../shared/session/session-runtime-status.js";
import { nowBeijingDateTime, parseBeijingDateTime } from "../../shared/time-utils.js";
import { createSerialQueue } from "../internal/serial-queue.js";

export { AUTOMATION_SCHEDULER_ALARM };
const AUTOMATION_SCHEDULER_PERIOD_MINUTES = 1;
const AUTOMATION_SCHEDULER_GRACE_MS = AUTOMATION_SCHEDULER_PERIOD_MINUTES * 60_000;
const AUTOMATION_NOTIFICATION_PREFIX = "qz_auto";

export function createAutomationRuntime({
  repository,
  sessions,
  alarms = null,
  notifications = null,
  emit = null,
  ready = async () => {},
  clock = () => Date.now(),
  logger = console,
}: AutomationRuntimeOptions) {
  // Firefox boot sets the flag before this module runs. `never` keeps the Chrome return type.
  if (!sessionAutomationsEnabled()) return createDisabledAutomationRuntime() as never;
  if (!repository || !sessions) throw new TypeError("automation repository and session commands are required");
  const operations = createSerialQueue();
  const notificationSessions = new Map<string, string>();

  async function start() {
    if (!alarms?.create) return false;
    await ready();
    const existing = await alarms.get?.(AUTOMATION_SCHEDULER_ALARM).catch(() => null);
    if (!existing) await createSchedulerAlarm();
    queueScheduler("boot").catch((error) => logger?.warn?.("[轻舟] automation scheduler boot failed:", error));
    return true;
  }

  function handleAlarm(alarm: { name?: string }) {
    if (alarm?.name !== AUTOMATION_SCHEDULER_ALARM) return false;
    queueScheduler("alarm").catch((error) => logger?.warn?.("[轻舟] automation scheduler tick failed:", error));
    return true;
  }

  function queueScheduler(reason = "tick") {
    return operations.run(() => runScheduler(reason));
  }

  async function runScheduler(reason = "tick") {
    await ready();
    const automations = await repository.listDefinitions();
    let activeAutomationRunning = false;
    for (const automation of automations) {
      if (await reconcileRunState(automation)) activeAutomationRunning = true;
    }
    if (activeAutomationRunning) return { started: false, reason: "automation_running" };

    const nowMs = clock();
    for (const automation of automations) {
      if (!automation.enabled || automation.runningRunId || !automation.instruction) continue;
      let nextRunAt = automation.nextRunAt;
      if (!nextRunAt) {
        nextRunAt = computeNextRunAt(automation.schedule, nowMs);
        await repository.patchDefinition(automation.id, { nextRunAt });
        continue;
      }
      const dueMs = parseBeijingDateTime(nextRunAt);
      if (!dueMs || dueMs > nowMs) continue;
      const delayed = dueMs + AUTOMATION_SCHEDULER_GRACE_MS < nowMs;
      if (automation.missedPolicy === AUTOMATION_MISSED_POLICY.SKIP && delayed && reason !== "manual") {
        const skippedAt = nowBeijingDateTime();
        const skippedRun = await repository.createRun({
          automationId: automation.id,
          status: AUTOMATION_RUN_STATUS.SKIPPED,
          triggerType: "catchup",
          plannedAt: nextRunAt,
          startedAt: skippedAt,
          endedAt: skippedAt,
          delayed: true,
          delayReason: "missed_policy_skip",
        });
        await repository.patchDefinition(automation.id, {
          ...nextPatchAfterScheduledRun(automation.schedule, nowMs),
          lastRunId: skippedRun.id,
          lastRunStatus: AUTOMATION_RUN_STATUS.SKIPPED,
          lastRunAt: skippedAt,
        });
        broadcastChanged({ action: "skip", automationId: automation.id });
        continue;
      }
      await startRun(automation, {
        triggerType: delayed ? "catchup" : "schedule",
        plannedAt: nextRunAt,
        delayed,
        delayReason: delayed ? "local_runtime_resumed" : "",
      });
      return { started: true, automationId: automation.id };
    }
    return { started: false, reason: "no_due_automation" };
  }

  async function list({ limit = 100, runLimit = 5 } = {}) {
    await ready();
    const max = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const maxRuns = Math.max(0, Math.min(50, Math.floor(Number(runLimit) || 0)));
    const automations = (await repository.listDefinitions()).slice(0, max);
    const runs: Record<string, (AutomationRun & { lastMessage?: string })[]> = {};
    if (maxRuns > 0) {
      const sessionRecords = await readSessionRecordsForRunList();
      for (let index = 0; index < automations.length; index += 1) {
        const automation = automations[index];
        const listedRuns = await repository.listRuns(automation.id, { limit: maxRuns });
        const reconciledRuns = [];
        let latestAutomation = automation;
        for (const run of listedRuns) {
          const reconciled = await reconcileRunSessionOutcome(run);
          reconciledRuns.push(withRunLastMessage(reconciled.run, sessionRecords));
          if (reconciled.automation) latestAutomation = reconciled.automation;
        }
        automations[index] = latestAutomation;
        runs[automation.id] = reconciledRuns;
      }
    }
    return { automations, runs };
  }

  async function save({ automation = {}, sourceSessionId = "" }: { automation?: Fields; sourceSessionId?: string } = {}) {
    await ready();
    const payload = automation && typeof automation === "object" && !Array.isArray(automation)
      ? { ...automation }
      : {};
    if (sourceSessionId && !payload.sourceSessionId) payload.sourceSessionId = sourceSessionId;
    const saved = await repository.saveDefinition(payload);
    await start();
    broadcastChanged({ action: "save", automationId: saved.id });
    return { automation: saved };
  }

  async function toggle({ automationId = "", enabled = true, nextRunAt = "" } = {}) {
    const id = requireId(automationId, "automationId");
    const active = enabled !== false;
    const current = (await repository.listDefinitions()).find(item => item.id === id);
    const automation = await repository.patchDefinition(id, {
      enabled: active,
      nextRunAt: active ? (nextRunAt || computeNextRunAt(current?.schedule, clock())) : "",
    });
    await start();
    broadcastChanged({ action: active ? "enable" : "pause", automationId: id });
    return automation;
  }

  async function remove(automationId = "") {
    const deletion = await operations.run(async () => {
      await ready();
      const id = requireId(automationId, "automationId");
      const automation = (await repository.listDefinitions()).find(item => item.id === id);
      const runs = await repository.listRuns(id, { limit: 1000 });
      const sessionIds = [...new Set([
        automation?.runningSessionId,
        ...runs.map(run => run.sessionId),
      ].filter((id): id is string => typeof id === "string" && Boolean(id)))];
      const result = await repository.deleteDefinition(id);
      broadcastChanged({ action: "delete", automationId: id });
      return { result, sessionIds };
    });

    for (const sessionId of deletion.sessionIds) {
      await sessions.remove(sessionId, { source: "automation_delete" }).catch((error) => {
        logger?.warn?.("[轻舟] automation session cleanup failed:", error);
      });
    }
    return deletion.result;
  }

  function run(automationId = "", signal?: AbortSignal) {
    return operations.run(async () => {
      signal?.throwIfAborted();
      await ready();
      signal?.throwIfAborted();
      const id = requireId(automationId, "automationId");
      const automation = (await repository.listDefinitions()).find(item => item.id === id);
      if (!automation) throw new Error("automation not found");
      const started = await startRun(automation, {
        triggerType: "manual",
        plannedAt: nowBeijingDateTime(),
        signal,
      });
      if (!started) throw new Error(t("automation.alreadyRunning"));
      return { run: started };
    });
  }

  async function listRuns({ automationId = "", limit = 20 } = {}) {
    await ready();
    const id = requireId(automationId, "automationId");
    const [listedRuns, sessionRecords] = await Promise.all([
      repository.listRuns(id, { limit }),
      readSessionRecordsForRunList(),
    ]);
    return {
      automationId: id,
      runs: listedRuns.map(run => withRunLastMessage(run, sessionRecords)),
    };
  }

  async function readSessionRecordsForRunList() {
    if (typeof sessions.listRecords !== "function") return {};
    try {
      const records = await sessions.listRecords();
      return records && typeof records === "object" && !Array.isArray(records) ? records : {};
    } catch (error) {
      logger?.debug?.("[轻舟] automation run message summaries unavailable:", errorMessage(error));
      return {};
    }
  }

  function withRunLastMessage(run: AutomationRun, sessionRecords: Record<string, SessionMetadata> = {}) {
    if (!run?.sessionId) return run;
    const lastMessage = normalizeSessionListSummary(sessionRecords[run.sessionId]?.listSummary).lastText;
    return lastMessage ? { ...run, lastMessage } : run;
  }

  async function syncSessionOutcome(sessionId: string) {
    const session = await sessions.getMetadata?.(sessionId);
    const runId = String(session?.automationRunId || "").trim();
    if (!runId) return false;
    return operations.run(async () => {
      const run = await repository.getRun(runId);
      if (
        !run
        || run.sessionId !== sessionId
        || !isActiveAutomationRunStatus(run.status)
      ) return false;
      return settleRunFromSession(run);
    });
  }

  function consumeNotificationSession(notificationId: string) {
    const sessionId = notificationSessions.get(notificationId) || parseNotificationSessionId(notificationId);
    if (!sessionId) return "";
    notificationSessions.delete(notificationId);
    return sessionId;
  }

  async function handleNotificationClick(notificationId: string) {
    const sessionId = consumeNotificationSession(notificationId);
    if (!sessionId) return false;
    await notifications?.clear?.(notificationId).catch(() => {});
    await sessions.activateWorkingTab?.(sessionId, { focusWindow: true });
    return true;
  }

  async function createSchedulerAlarm() {
    if (!alarms) return;
    const base = {
      delayInMinutes: AUTOMATION_SCHEDULER_PERIOD_MINUTES,
      periodInMinutes: AUTOMATION_SCHEDULER_PERIOD_MINUTES,
    };
    try {
      const persistent = { ...base, persistAcrossSessions: true };
      await alarms.create(AUTOMATION_SCHEDULER_ALARM, persistent);
    } catch (error) {
      logger?.debug?.("[轻舟] automation alarm persistence flag unavailable:", errorMessage(error));
      await alarms.create(AUTOMATION_SCHEDULER_ALARM, base);
    }
  }

  async function reconcileRunState(automation: Automation) {
    const runId = String(automation?.runningRunId || "").trim();
    if (!runId) return false;
    const run = await repository.getRun(runId);
    if (!run) {
      await repository.patchDefinition(automation.id, {
        runningRunId: "",
        runningSessionId: "",
        lastRunStatus: AUTOMATION_RUN_STATUS.INTERRUPTED,
        lastRunAt: nowBeijingDateTime(),
      });
      broadcastChanged({ action: "reconcile", automationId: automation.id });
      return false;
    }
    if (!isActiveAutomationRunStatus(run.status)) return false;

    const settled = await settleRunFromSession(run);
    return !settled;
  }

  async function settleRunFromSession(run: AutomationRun) {
    const runtime = run?.sessionId ? sessions.getRuntime(run.sessionId) : {};
    const sessionStatus = normalizeSessionRuntimeStatus(runtime?.status);
    if (runtime?.running || isActiveSessionRuntimeStatus(sessionStatus)) return false;

    let status;
    if (sessionStatus === SESSION_RUNTIME_STATUS.COMPLETED) {
      status = AUTOMATION_RUN_STATUS.COMPLETED;
    } else if (sessionStatus === SESSION_RUNTIME_STATUS.ERROR) {
      status = AUTOMATION_RUN_STATUS.ERROR;
    } else if (
      sessionStatus === SESSION_RUNTIME_STATUS.ABORTED
      || sessionStatus === SESSION_RUNTIME_STATUS.CANCELLED
    ) {
      status = AUTOMATION_RUN_STATUS.ABORTED;
    } else {
      status = AUTOMATION_RUN_STATUS.INTERRUPTED;
    }

    let error = String(runtime?.reason || "").trim();
    if (status === AUTOMATION_RUN_STATUS.COMPLETED) {
      const inferredFailure = await inferSessionFailure(run.sessionId);
      if (inferredFailure) {
        status = AUTOMATION_RUN_STATUS.ERROR;
        error = inferredFailure;
      }
    } else if (status === AUTOMATION_RUN_STATUS.INTERRUPTED && !error) {
      error = t("automation.interrupted");
    }
    await finalizeRun(run, { status, error });
    return true;
  }

  async function startRun(automation: Automation, {
    triggerType = "schedule",
    plannedAt = "",
    delayed = false,
    delayReason = "",
    signal,
  }: { triggerType?: string; plannedAt?: string; delayed?: boolean; delayReason?: string; signal?: AbortSignal } = {}) {
    await ready();
    signal?.throwIfAborted();
    const current = (await repository.listDefinitions()).find(item => item.id === automation.id);
    if (!current || current.runningRunId) return null;
    if (!current.enabled && triggerType !== "manual") return null;
    if (await hasActiveRun(current.id)) return null;
    signal?.throwIfAborted();

    const startedAt = nowBeijingDateTime();
    let run = await repository.createRun({
      automationId: current.id,
      status: AUTOMATION_RUN_STATUS.PENDING,
      triggerType,
      plannedAt,
      startedAt,
      delayed,
      delayReason,
    }, signal);

    let createdSessionId = "";
    try {
      signal?.throwIfAborted();
      const prompt = buildPrompt(current, run);
      const session = await sessions.create({ automation: current, run, prompt, signal });
      createdSessionId = session.id;
      signal?.throwIfAborted();
      run = await repository.patchRun(run.id, {
        sessionId: session.id,
        status: AUTOMATION_RUN_STATUS.RUNNING,
        startedAt,
      });
      signal?.throwIfAborted();
      const nextPatch = triggerType === "manual" ? {} : nextPatchAfterScheduledRun(current.schedule, clock());
      await repository.patchDefinition(current.id, {
        ...nextPatch,
        runningRunId: run.id,
        runningSessionId: session.id,
        lastRunId: run.id,
        lastRunStatus: AUTOMATION_RUN_STATUS.RUNNING,
        lastRunAt: startedAt,
      });
      signal?.throwIfAborted();
      if (!await sessions.launch(session.id, prompt, signal)) throw new Error("automation prompt is empty");
      broadcastChanged({ action: "run_start", automationId: current.id, runId: run.id, sessionId: session.id });
      return run;
    } catch (error) {
      await finalizeRun(run, { status: signal?.aborted ? AUTOMATION_RUN_STATUS.ABORTED : AUTOMATION_RUN_STATUS.ERROR, error: errorMessage(error) });
      if (signal?.aborted && createdSessionId) {
        // Session deletion can reconcile Automation state through this same operation queue.
        void sessions.remove(createdSessionId, { source: "automation_start_cancelled" }).catch(cleanupError => {
          logger?.warn?.("[轻舟] cancelled automation session cleanup failed:", cleanupError);
        });
      }
      if (triggerType === "manual") throw error;
      return null;
    }
  }

  async function hasActiveRun(excludeAutomationId = "") {
    for (const automation of await repository.listDefinitions()) {
      if (automation.id === excludeAutomationId || !automation.runningRunId) continue;
      const run = await repository.getRun(automation.runningRunId);
      if (!run || !isActiveAutomationRunStatus(run.status)) continue;
      const runtime = run.sessionId ? sessions.getRuntime(run.sessionId) : {};
      if (runtime.running || isActiveSessionRuntimeStatus(runtime.status)) return true;
    }
    return false;
  }

  async function reconcileRunSessionOutcome(run: AutomationRun) {
    if (!run || run.status !== AUTOMATION_RUN_STATUS.COMPLETED || !run.sessionId) {
      return { run, automation: null };
    }
    const inferredFailure = await inferSessionFailure(run.sessionId);
    if (!inferredFailure) return { run, automation: null };
    const updatedRun = await repository.patchRun(run.id, {
      status: AUTOMATION_RUN_STATUS.ERROR,
      error: inferredFailure,
    });
    let updatedAutomation = null;
    const automation = (await repository.listDefinitions()).find(item => item.id === run.automationId);
    if (automation?.lastRunId === run.id) {
      updatedAutomation = await repository.patchDefinition(automation.id, {
        lastRunStatus: AUTOMATION_RUN_STATUS.ERROR,
        lastRunAt: updatedRun.endedAt || updatedRun.updatedAt,
      });
    }
    return { run: updatedRun, automation: updatedAutomation };
  }

  async function inferSessionFailure(sessionId: string) {
    try {
      const conversation = await sessions.getConversation(sessionId).catch(() => null);
      const transcript = await sessions.getTranscript(sessionId, conversation).catch(() => []);
      return extractFailureFromTranscript(transcript) || extractFailureFromConversation(conversation);
    } catch (_error) {
      return "";
    }
  }

  async function finalizeRun(run: AutomationRun, { status, error = "" }: { status?: string; error?: string } = {}) {
    const finalStatus = status || AUTOMATION_RUN_STATUS.COMPLETED;
    const endedAt = nowBeijingDateTime();
    let updatedRun;
    try {
      updatedRun = await repository.patchRun(run.id, { status: finalStatus, error, endedAt });
    } catch (patchError) {
      if (/not found/i.test(String(errorMessage(patchError)))) return null;
      throw patchError;
    }
    const automation = (await repository.listDefinitions()).find(item => item.id === run.automationId);
    if (automation) {
      await repository.patchDefinition(automation.id, {
        runningRunId: automation.runningRunId === run.id ? "" : automation.runningRunId,
        runningSessionId: automation.runningRunId === run.id ? "" : automation.runningSessionId,
        lastRunId: run.id,
        lastRunStatus: finalStatus,
        lastRunAt: endedAt,
      });
    }
    broadcastChanged({ action: "run_end", automationId: run.automationId, runId: run.id, status: finalStatus });
    queueScheduler("run_end");
    if (automation) {
      void notifyRun(automation, updatedRun).catch(error => {
        logger?.debug?.("[轻舟] automation notification failed:", errorMessage(error));
      });
    }
    return updatedRun;
  }

  async function notifyRun(automation: Automation, run: AutomationRun) {
    if (!notifications?.create || automation.notifyPolicy === AUTOMATION_NOTIFY_POLICY.SILENT) return;
    const failed = new Set<string>([
      AUTOMATION_RUN_STATUS.ERROR,
      AUTOMATION_RUN_STATUS.ABORTED,
      AUTOMATION_RUN_STATUS.INTERRUPTED,
    ]).has(run.status);
    if (automation.notifyPolicy === AUTOMATION_NOTIFY_POLICY.FAILURE && !failed) return;
    if (!failed && run.sessionId && await sessions.shouldSuppressNotification?.(run.sessionId)) return;

    const notificationId = `${AUTOMATION_NOTIFICATION_PREFIX}_${run.sessionId || run.id}_${run.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 240);
    const createdId = await notifications.create(notificationId, {
      type: "basic",
      iconUrl: notifications.iconUrl,
      title: failed ? t("automation.attention") : t("automation.completed"),
      message: `${automation.title} · ${runStatusText(run.status)}`,
      contextMessage: run.error || describeAutomationSchedule(automation.schedule),
      priority: failed ? 2 : 1,
      requireInteraction: failed,
    });
    if (run.sessionId) notificationSessions.set(createdId, run.sessionId);
  }

  function broadcastChanged(payload: Fields = {}) {
    emit?.({ type: "automations_changed", ...payload });
  }

  return Object.freeze({
    start,
    handleAlarm,
    queueScheduler,
    list,
    save,
    toggle,
    remove,
    run,
    listRuns,
    syncSessionOutcome,
    consumeNotificationSession,
    handleNotificationClick,
    flush: () => operations.onIdle(),
    inspect: () => ({ notificationSessionCount: notificationSessions.size }),
  });
}

export function isAutomationSessionFamily(sessionId: unknown, sessions: Record<string, Partial<SessionMetadata>> = {}, rootSessionId = "default") {
  let id = String(sessionId || "").trim();
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const session = sessions[id];
    if (!session) return false;
    if (session.source === "automation" || session.automationId || session.automationRunId) return true;
    const parentId = String(session.parentSessionId || rootSessionId).trim() || rootSessionId;
    if (parentId === rootSessionId || parentId === id) return false;
    id = parentId;
  }
  return false;
}

function nextPatchAfterScheduledRun(schedule: unknown = {}, fromMs = Date.now()) {
  return object(schedule).type === "once"
    ? { enabled: false, nextRunAt: "" }
    : { nextRunAt: computeNextRunAt(schedule, fromMs) };
}

function buildPrompt(automation: Automation, run: AutomationRun) {
  const triggerText = run.triggerType === "manual"
    ? promptT("manual")
    : run.triggerType === "catchup"
      ? promptT("catchup")
      : promptT("scheduled");
  return [
    promptT("introduction"),
    "",
    promptT("title", { value: automation.title }),
    promptT("trigger", { value: triggerText }),
    promptT("planned", { value: run.plannedAt || promptT("unknown") }),
    promptT("started", { value: run.startedAt || nowBeijingDateTime() }),
    promptT("schedule", { value: describeAutomationSchedule(automation.schedule) }),
    run.delayed ? promptT("delayed") : "",
    "",
    promptT("requirements"),
    promptT("start"),
    promptT("restricted"),
    promptT("data"),
    promptT("blocked"),
    promptT("finish"),
    "",
    promptT("user"),
    automation.instruction,
  ].filter(Boolean).join("\n");
}

function extractFailureFromTranscript(transcript: unknown = []) {
  const entries = Array.isArray(transcript) ? transcript : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "error" && entry.text) return cleanFailureMessage(entry.text);
    if (entry.type === "assistant" && isLlmFailureText(entry.content)) return cleanFailureMessage(entry.content);
  }
  return "";
}

function extractFailureFromConversation(conversation: unknown = []) {
  const messages = Array.isArray(conversation) ? conversation : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && isLlmFailureText(message.content)) return cleanFailureMessage(message.content);
  }
  return "";
}

function isLlmFailureText(value: unknown = "") {
  return /(?:LLM\s*(?:调用失败|响应超时|流式响应中断|API\s*\d+)|Model (?:request failed|response timed out|stream interrupted))/i.test(String(value || ""));
}

function cleanFailureMessage(value: unknown = "") {
  const text = String(value || "").replace(/^❌\s*/u, "").trim();
  return clipText(text, 1200) || t("agent.llmFailed");
}

function clipText(value: unknown, maxChars: number) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function runStatusText(status: unknown) {
  switch (status) {
    case AUTOMATION_RUN_STATUS.COMPLETED: return t("status.success");
    case AUTOMATION_RUN_STATUS.ERROR: return t("status.failed");
    case AUTOMATION_RUN_STATUS.ABORTED: return t("status.stopped");
    case AUTOMATION_RUN_STATUS.INTERRUPTED: return t("status.interrupted");
    case AUTOMATION_RUN_STATUS.RUNNING: return t("status.running");
    case AUTOMATION_RUN_STATUS.SKIPPED: return t("status.skipped");
    default: return t("status.pending");
  }
}

function parseNotificationSessionId(notificationId: unknown) {
  const match = String(notificationId || "").match(/^qz_auto_([^_]+)_/);
  return match ? match[1] : "";
}

function requireId(value: unknown, name: string) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${name} is required`);
  return id;
}

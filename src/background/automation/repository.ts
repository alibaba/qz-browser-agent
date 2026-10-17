import type { StorageAdapter } from "../internal/storage.js";
import type { Automation, AutomationRun } from "../../shared/automation-store.js";
type Fields = Record<string, unknown>;
type AutomationRepository = ReturnType<typeof createAutomationRepository>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
import {
  AUTOMATIONS_KEY,
  AUTOMATION_RUNS_KEY,
  AUTOMATION_RUN_STATUS,
  computeNextRunAt,
  genAutomationId,
  genAutomationRunId,
  isActiveAutomationRunStatus,
  normalizeAutomation,
  normalizeAutomationRun,
} from "../../shared/automation-store.js";
import { nowBeijingDateTime, parseBeijingDateTime } from "../../shared/time-utils.js";
import { createSerialQueue } from "../internal/serial-queue.js";
import { requireStorage } from "../internal/storage.js";

let defaultRepository: AutomationRepository | null = null;
let defaultStorage: StorageAdapter | null | undefined = null;

export function createAutomationRepository({ storage }: { storage?: StorageAdapter } = {}) {
  const storageArea = requireStorage(storage);
  const definitionsQueue = createSerialQueue();
  const runsQueue = createSerialQueue();

  async function getDefinitions(): Promise<Record<string, Automation>> {
    const { [AUTOMATIONS_KEY]: stored = {} } = await storageArea.get(AUTOMATIONS_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const result: Record<string, Automation> = {};
    for (const [id, rawValue] of Object.entries(stored)) {
      const value = object(rawValue);
      const normalized = normalizeAutomation({ ...value, id: value?.id || id });
      if (normalized) result[normalized.id] = normalized;
    }
    return result;
  }

  async function listDefinitions() {
    return Object.values(await getDefinitions()).sort(compareDefinitions);
  }

  function saveDefinition(input: Fields = {}) {
    return definitionsQueue.run(async () => {
      validateSchedule(input.schedule);
      const definitions = await getDefinitions();
      const id = String(input.id || "").trim() || genAutomationId();
      const current = definitions[id];
      const now = nowBeijingDateTime();
      const next = normalizeAutomation({
        ...current,
        ...input,
        id,
        createdAt: current?.createdAt || now,
        updatedAt: now,
      });
      if (!next) throw new Error("invalid automation");
      if (next.enabled && (!next.nextRunAt || input.schedule)) {
        next.nextRunAt = computeNextRunAt(next.schedule, Date.now());
      }
      if (!next) throw new Error("invalid automation");
      definitions[id] = next;
      await storageArea.set({ [AUTOMATIONS_KEY]: definitions });
      return next;
    });
  }

  function patchDefinition(automationId: unknown, patch: Fields = {}) {
    const id = requireId(automationId, "automationId");
    return definitionsQueue.run(async () => {
      const definitions = await getDefinitions();
      const current = definitions[id];
      if (!current) throw new Error(`automation not found: ${id}`);
      const next = normalizeAutomation({
        ...current,
        ...patch,
        id,
        createdAt: current.createdAt,
        updatedAt: nowBeijingDateTime(),
      });
      if (!next) throw new Error("invalid automation");
      definitions[id] = next;
      await storageArea.set({ [AUTOMATIONS_KEY]: definitions });
      return next;
    });
  }

  function deleteDefinition(automationId: unknown) {
    const id = requireId(automationId, "automationId");
    return definitionsQueue.run(async () => {
      const definitions = await getDefinitions();
      const existed = Boolean(definitions[id]);
      delete definitions[id];
      await storageArea.set({ [AUTOMATIONS_KEY]: definitions });
      await deleteRuns(id);
      return { id, deleted: existed };
    });
  }

  async function getRuns(): Promise<Record<string, AutomationRun>> {
    const { [AUTOMATION_RUNS_KEY]: stored = {} } = await storageArea.get(AUTOMATION_RUNS_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const result: Record<string, AutomationRun> = {};
    for (const [id, rawValue] of Object.entries(stored)) {
      const value = object(rawValue);
      const normalized = normalizeAutomationRun({ ...value, id: value?.id || id });
      if (normalized) result[normalized.id] = normalized;
    }
    return result;
  }

  async function listRuns(automationId = "", { limit = 20 } = {}) {
    const id = String(automationId || "").trim();
    const max = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 20)));
    return Object.values(await getRuns())
      .filter((run) => !id || run.automationId === id)
      .sort((a, b) => timestamp(b.startedAt || b.createdAt) - timestamp(a.startedAt || a.createdAt))
      .slice(0, max);
  }

  async function getRun(runId: unknown) {
    const id = requireId(runId, "runId");
    return (await getRuns())[id] || null;
  }

  async function findActiveRunBySession(sessionId: unknown) {
    const id = requireId(sessionId, "sessionId");
    return Object.values(await getRuns()).find((run) => (
      run.sessionId === id && isActiveAutomationRunStatus(run.status)
    )) || null;
  }

  function createRun(input: Fields = {}, signal?: AbortSignal) {
    return runsQueue.run(async () => {
      signal?.throwIfAborted();
      const runs = await getRuns();
      signal?.throwIfAborted();
      const now = nowBeijingDateTime();
      const run = normalizeAutomationRun({
        ...input,
        id: input.id || genAutomationRunId(),
        status: input.status || AUTOMATION_RUN_STATUS.PENDING,
        createdAt: input.createdAt || now,
        updatedAt: now,
      });
      if (!run) throw new Error("invalid automation run");
      runs[run.id] = run;
      await storageArea.set({ [AUTOMATION_RUNS_KEY]: runs });
      return run;
    });
  }

  function patchRun(runId: unknown, patch: Fields = {}) {
    const id = requireId(runId, "runId");
    return runsQueue.run(async () => {
      const runs = await getRuns();
      const current = runs[id];
      if (!current) throw new Error(`automation run not found: ${id}`);
      const next = normalizeAutomationRun({
        ...current,
        ...patch,
        id,
        createdAt: current.createdAt,
        updatedAt: nowBeijingDateTime(),
      });
      if (!next) throw new Error("invalid automation run");
      runs[id] = next;
      await storageArea.set({ [AUTOMATION_RUNS_KEY]: runs });
      return next;
    });
  }

  function deleteRuns(automationId: unknown) {
    const id = requireId(automationId, "automationId");
    return runsQueue.run(async () => {
      const runs = await getRuns();
      let deleted = 0;
      for (const [runId, run] of Object.entries(runs)) {
        if (run.automationId !== id) continue;
        delete runs[runId];
        deleted += 1;
      }
      await storageArea.set({ [AUTOMATION_RUNS_KEY]: runs });
      return { automationId: id, deleted };
    });
  }

  return Object.freeze({
    getDefinitions,
    listDefinitions,
    saveDefinition,
    patchDefinition,
    deleteDefinition,
    getRuns,
    listRuns,
    getRun,
    findActiveRunBySession,
    createRun,
    patchRun,
    deleteRuns,
    flush: () => Promise.all([definitionsQueue.onIdle(), runsQueue.onIdle()]),
  });
}

export function getAutomationRepository() {
  const storage = globalThis.chrome?.storage?.local;
  if (!defaultRepository || defaultStorage !== storage) {
    defaultRepository = createAutomationRepository({ storage });
    defaultStorage = storage;
  }
  return defaultRepository;
}

export const getAutomations = (...args: Parameters<AutomationRepository["getDefinitions"]>) => getAutomationRepository().getDefinitions(...args);
export const listAutomations = (...args: Parameters<AutomationRepository["listDefinitions"]>) => getAutomationRepository().listDefinitions(...args);
export const saveAutomation = (...args: Parameters<AutomationRepository["saveDefinition"]>) => getAutomationRepository().saveDefinition(...args);
export const patchAutomation = (...args: Parameters<AutomationRepository["patchDefinition"]>) => getAutomationRepository().patchDefinition(...args);
export const deleteAutomation = (...args: Parameters<AutomationRepository["deleteDefinition"]>) => getAutomationRepository().deleteDefinition(...args);
export const getAutomationRuns = (...args: Parameters<AutomationRepository["getRuns"]>) => getAutomationRepository().getRuns(...args);
export const listAutomationRuns = (...args: Parameters<AutomationRepository["listRuns"]>) => getAutomationRepository().listRuns(...args);
export const getAutomationRun = (...args: Parameters<AutomationRepository["getRun"]>) => getAutomationRepository().getRun(...args);
export const getAutomationRunBySessionId = (...args: Parameters<AutomationRepository["findActiveRunBySession"]>) => getAutomationRepository().findActiveRunBySession(...args);
export const createAutomationRun = (...args: Parameters<AutomationRepository["createRun"]>) => getAutomationRepository().createRun(...args);
export const patchAutomationRun = (...args: Parameters<AutomationRepository["patchRun"]>) => getAutomationRepository().patchRun(...args);
export const deleteAutomationRuns = (...args: Parameters<AutomationRepository["deleteRuns"]>) => getAutomationRepository().deleteRuns(...args);

function validateSchedule(value: unknown) {
  const schedule = object(value);
  if (!schedule || schedule.type !== "once") return;
  const next = computeNextRunAt(schedule, Date.now());
  if (!next) throw new Error("once automation requires a valid runAt");
}

function compareDefinitions(a: Automation, b: Automation) {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const next = timestamp(a.nextRunAt) - timestamp(b.nextRunAt);
  return Number.isFinite(next) && next !== 0 ? next : timestamp(b.updatedAt) - timestamp(a.updatedAt);
}

function timestamp(value: unknown) {
  return parseBeijingDateTime(value) || 0;
}

function requireId(value: unknown, name: string) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${name} is required`);
  return id;
}

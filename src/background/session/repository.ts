import { t } from "../../shared/i18n/backend.js";
import type { StorageAdapter } from "../internal/storage.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { SessionListSummary } from "../../shared/session/session-list-summary.js";
import type { TranscriptEntry, TranscriptSnapshot } from "../../shared/contracts/session.js";
import type { AgentLease } from "./supervisor.js";
type Fields = Record<string, unknown>;
type RuntimeCheckpoint = Fields & { schemaVersion: number; sessionId: string };
type Lease = Pick<AgentLease, "sessionId" | "isActive">;
type MetadataMutator = Fields | ((current: SessionMetadata) => Fields | null | Promise<Fields | null>);
interface RepositoryOptions {
  storage?: StorageAdapter;
  clock?(): number;
  normalizeRuntime?(input: unknown, sessionId: string, now: number): RuntimeCheckpoint;
}
interface PendingRuntime {
  runtime: RuntimeCheckpoint;
  waiters: { resolve(value: RuntimeCheckpoint | null): void; reject(error: unknown): void }[];
  timer: ReturnType<typeof setTimeout> | null;
}
interface TranscriptCheckpoint {
  version: 2;
  baseRevision: string;
  transcript: TranscriptEntry[];
}
interface TranscriptCheckpointBase {
  history: readonly TranscriptEntry[];
  transcript: TranscriptEntry[];
  revision: string;
  persisted: boolean;
}
interface PendingTranscriptCheckpoint {
  base: TranscriptCheckpointBase;
  lease: Lease;
  checkpoint: TranscriptCheckpoint;
  promise: Promise<void>;
}
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

import { assertSessionRecordReadable, assertConversationReadable } from "../../shared/session/session-format.js";
import { readCheckpointRecord } from "../../shared/session/session-recovery.js";
import {
  ACTIVE_CONVERSATION_PREFIX,
  ROOT_SESSION_ID,
  SESSIONS_KEY,
  SESSION_RECORD_PREFIX,
  transcriptCheckpointKey,
  genSessionId,
  normalizeParentSessionId,
  normalizeSessionId,
} from "../../shared/session/session-store.js";
import { createSessionRecord, createSessionTitle, normalizeTranscript, serializeConversation } from "../../shared/session/session-codec.js";
import { persistSessionImages, resolveSessionImages } from "../../shared/session/session-image-assets.js";
import {
  createSessionListSummaryFromFirstMessage,
  normalizeSessionListSummary,
} from "../../shared/session/session-list-summary.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { createKeyedSerialQueue, createSerialQueue } from "../internal/serial-queue.js";
import { requireStorage } from "../internal/storage.js";
import { sessionImagePersistence } from "./image-persistence.js";
import {
  SESSION_RUNTIME_SCHEMA_VERSION,
  normalizeSessionRuntime,
} from "./runtime-reducer.js";

export const LEGACY_SESSION_RUNTIME_KEY = "_session_runtime";
export const SESSION_RUNTIME_PREFIX = "_session_runtime_";
export const SESSION_RUNTIME_MIGRATION_KEY = "_session_runtime_schema_version";
export { SESSION_TRANSCRIPT_CHECKPOINT_PREFIX } from "../../shared/session/session-store.js";

export class StaleSessionLeaseError extends Error {
  code: string;
  sessionId: string;
  constructor(sessionId: string) {
    super(`session lease is stale: ${sessionId}`);
    this.name = "StaleSessionLeaseError";
    this.code = "STALE_SESSION_LEASE";
    this.sessionId = sessionId;
  }
}

export class DeletedSessionWriteError extends Error {
  code: string;
  sessionId: string;
  constructor(sessionId: string) {
    super(`session was deleted: ${sessionId}`);
    this.name = "DeletedSessionWriteError";
    this.code = "SESSION_DELETED";
    this.sessionId = sessionId;
  }
}

let defaultRepository: ReturnType<typeof createSessionRepository> | null = null;
let defaultStorage: StorageAdapter | null | undefined = null;

export function createSessionRepository({
  storage,
  clock = () => Date.now(),
  normalizeRuntime = normalizeRuntimeCheckpoint,
}: RepositoryOptions = {}) {
  const storageArea = requireStorage(storage);
  const imagePersistence = sessionImagePersistence(storageArea);
  const metadataQueue = createSerialQueue();
  const recordQueues = createKeyedSerialQueue();
  const conversationQueues = createKeyedSerialQueue();
  const runtimeQueues = createKeyedSerialQueue();
  const runtimePending = new Map<string, PendingRuntime>();
  const transcriptBases = new Map<string, TranscriptCheckpointBase>();
  const transcriptPending = new Map<string, PendingTranscriptCheckpoint>();
  const deletedSessionIds = new Set<string>();

  async function listMetadata() {
    const { [SESSIONS_KEY]: stored = {} } = await storageArea.get(SESSIONS_KEY);
    return normalizeMetadataMap(stored);
  }

  async function getMetadata(sessionId: string) {
    const id = requireSessionId(sessionId);
    return (await listMetadata())[id] || null;
  }

  function hydrateListSummaries({ sessionIds = [], limit = 24, force = false }: { sessionIds?: string[]; limit?: number; force?: boolean } = {}) {
    const requested = [...new Set(sessionIds.map(normalizeSessionId).filter(Boolean))].slice(0, Math.max(1, Number(limit) || 24));
    return metadataQueue.run(async () => {
      const sessions = await listMetadata();
      const ids = requested.length ? requested : Object.keys(sessions).slice(0, Math.max(1, Number(limit) || 24));
      let changed = false;
      const hydrated = [];
      for (const id of ids) {
        const session = sessions[id];
        if (!session) continue;
        const current = normalizeSessionListSummary(session.listSummary);
        if (!force && hasListSummary(current)) {
          hydrated.push(session);
          continue;
        }
        const record = await readRecord(id);
        const firstMessage = extractFirstUserText(record);
        session.listSummary = normalizeSessionListSummary(createSessionListSummaryFromFirstMessage(firstMessage, session.updatedAt || nowBeijingDateTime()));
        hydrated.push(session);
        changed = true;
      }
      if (changed) await storageArea.set({ [SESSIONS_KEY]: sessions });
      return { sessions: hydrated, hydrated: hydrated.length, changed };
    });
  }

  function createMetadata(input: Fields = {}) {
    return metadataQueue.run(async () => {
      const sessions = await listMetadata();
      const id = normalizeSessionId(input.id) || genSessionId();
      const existing = sessions[id];
      const now = nowBeijingDateTime();
      const requestedParent = normalizeParentSessionId(input.parentSessionId);
      const parentSessionId = existing?.parentSessionId
        ?? (requestedParent === id ? ROOT_SESSION_ID : requestedParent);
      const session = cleanMetadata({
        ...existing,
        id,
        title: createSessionTitle(input.title || input.firstMessage || existing?.title || t("session.new")),
        titleSource: existing?.titleSource || normalizeTitleSource(input.titleSource, parentSessionId),
        parentSessionId,
        source: normalizeSessionSource(input.source || existing?.source),
        automationId: normalizeSessionId(input.automationId || existing?.automationId),
        automationRunId: normalizeSessionId(input.automationRunId || existing?.automationRunId),
        listSummary: normalizeSessionListSummary(
          existing?.listSummary || createSessionListSummaryFromFirstMessage(input.firstMessage, now),
        ),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });
      sessions[id] = session;
      await storageArea.set({ [SESSIONS_KEY]: sessions });
      deletedSessionIds.delete(id);
      return session;
    });
  }

  function patchMetadata(sessionId: string, mutator: MetadataMutator) {
    const id = requireSessionId(sessionId);
    if (typeof mutator !== "function" && (!mutator || typeof mutator !== "object")) {
      throw new TypeError("metadata patch must be an object or mutator");
    }
    return updateMetadata(id, mutator).then((result) => result.session);
  }

  function updateMetadata(sessionId: string, mutator: MetadataMutator) {
    const id = requireSessionId(sessionId);
    if (typeof mutator !== "function" && (!mutator || typeof mutator !== "object")) {
      throw new TypeError("metadata patch must be an object or mutator");
    }
    return metadataQueue.run(async () => {
      const sessions = await listMetadata();
      const current = sessions[id];
      if (!current) throw new Error(`session not found: ${id}`);
      const draft = typeof mutator === "function" ? await mutator(clone(current)) : { ...current, ...mutator };
      if (draft == null) return { changed: false, session: current };
      if (!draft || typeof draft !== "object") throw new TypeError("metadata mutator must return an object");
      const candidate = cleanMetadata({
        ...current,
        ...draft,
        id,
        parentSessionId: normalizeParentSessionId(draft.parentSessionId ?? current.parentSessionId),
        listSummary: normalizeSessionListSummary(draft.listSummary ?? current.listSummary),
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      });
      if (candidate.parentSessionId === id) candidate.parentSessionId = ROOT_SESSION_ID;
      if (JSON.stringify(candidate) === JSON.stringify(current)) {
        return { changed: false, session: current };
      }
      const next = { ...candidate, updatedAt: String(draft.updatedAt || nowBeijingDateTime()) };
      sessions[id] = next;
      await storageArea.set({ [SESSIONS_KEY]: sessions });
      return { changed: true, session: next };
    });
  }

  function deleteSession(sessionId: string) {
    const id = requireSessionId(sessionId);
    deletedSessionIds.add(id);
    transcriptBases.delete(id);
    transcriptPending.delete(id);
    return metadataQueue.run(async () => {
      // A create queued before this delete may have cleared the eager tombstone.
      // Reassert it at the serialized deletion boundary so late writes stay rejected.
      deletedSessionIds.add(id);
      const sessions = await listMetadata();
      const existed = Boolean(sessions[id]);
      const parentId = normalizeParentSessionId(sessions[id]?.parentSessionId);
      delete sessions[id];
      for (const session of Object.values(sessions)) {
        if (normalizeParentSessionId(session.parentSessionId) === id) session.parentSessionId = parentId;
      }
      await storageArea.set({ [SESSIONS_KEY]: sessions });
      await recordQueues.run(id, () => storageArea.remove([
        recordKey(id),
        transcriptCheckpointKey(id),
        `_session_import_dedup_${id}`, // Obsolete cache from older builds.
      ])).catch(error => console.warn("[轻舟] deleted Session record cleanup failed", error));
      await conversationQueues.run(id, () => storageArea.remove(activeConversationKey(id))).catch(error => console.warn("[轻舟] deleted Session conversation cleanup failed", error));
      await deleteRuntime(id).catch(error => console.warn("[轻舟] deleted Session runtime cleanup failed", error));
      imagePersistence.forgetSession(id);
      await imagePersistence.sweep().catch(error => console.warn("[轻舟] deleted Session image cleanup failed", error));
      return { sessionId: id, deleted: true, existed };
    }).catch(error => {
      deletedSessionIds.delete(id);
      throw error;
    });
  }

  async function readRecord(sessionId: string) {
    const id = requireSessionId(sessionId);
    const key = recordKey(id);
    const values = await storageArea.get([key, transcriptCheckpointKey(id)]);
    return resolveSessionImages(readCheckpointRecord(values[key], values[transcriptCheckpointKey(id)]));
  }

  function writeRecord(sessionId: string, input: unknown, lease?: Lease, savedHistory?: readonly TranscriptEntry[]) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    if (lease !== undefined) assertLease(id, lease);
    if (savedHistory !== undefined && (!Array.isArray(savedHistory) || !Array.isArray(record(input).transcript))) {
      throw new TypeError("savedHistory requires a complete transcript record");
    }
    const revision = crypto.randomUUID();
    // Explicit commits capture their completed history now. Checkpoints queued
    // after this write can reuse its revision without rewriting the history.
    const base = savedHistory === undefined ? null : {
      history: savedHistory, transcript: record(input).transcript as TranscriptEntry[], revision, persisted: false,
    };
    // This queued full write is a barrier: older checkpoint slots stay before
    // it, while later checkpoints capture a new baseline and cannot merge back.
    if (base) transcriptBases.set(id, base);
    else transcriptBases.delete(id);
    transcriptPending.delete(id);
    return recordQueues.run(id, () => imagePersistence.write(async () => {
      assertSessionWritable(id);
      if (lease !== undefined) assertLease(id, lease);
      assertSessionRecordReadable(input);
      await readCompatibleStorage(id);
      assertSessionWritable(id);
      if (lease !== undefined) assertLease(id, lease);
      const stored = await persistSessionImages(input);
      assertSessionWritable(id);
      if (lease !== undefined) assertLease(id, lease);
      await storageArea.set({
        [recordKey(id)]: stored == null ? stored : {
          ...clone(record(stored)), transcriptRevision: revision,
        },
      });
      if (base) {
        base.persisted = true;
        base.transcript = [];
      }
      assertSessionWritable(id);
      if (lease !== undefined) assertLease(id, lease);
      // The new revision already invalidates the old current snapshot if cleanup fails.
      await storageArea.remove(transcriptCheckpointKey(id));
    }));
  }

  function writeTranscriptCheckpoint(sessionId: string, snapshot: TranscriptSnapshot, lease: Lease) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    assertLease(id, lease);
    let base = transcriptBases.get(id);
    if (!base || base.history !== snapshot.history) {
      base = {
        history: snapshot.history, transcript: snapshot.history.slice(),
        revision: crypto.randomUUID(), persisted: false,
      };
      transcriptBases.set(id, base);
    }
    const checkpoint: TranscriptCheckpoint = {
      version: 2, baseRevision: base.revision,
      transcript: snapshot.current.slice(),
    };
    const existing = transcriptPending.get(id);
    if (existing?.base === base && existing.lease === lease) {
      existing.checkpoint = checkpoint;
      return existing.promise;
    }
    const queued: PendingTranscriptCheckpoint = {
      base, lease, checkpoint,
      promise: recordQueues.run(id, () => imagePersistence.write(async () => {
        if (transcriptPending.get(id) === queued) transcriptPending.delete(id);
        assertSessionWritable(id);
        assertLease(id, queued.lease);
        if (!queued.base.persisted) {
          const values = await readCompatibleStorage(id);
          assertSessionWritable(id);
          assertLease(id, queued.lease);
          const saved = values[recordKey(id)] ?? createSessionRecord(values[activeConversationKey(id)] ?? [], []);
          // One key contains a complete history and current snapshot. Later
          // writes replace only current, so even the first checkpoint is complete.
          const stored = await persistSessionImages({
            ...record(saved), transcript: queued.base.transcript,
            currentTranscript: queued.checkpoint.transcript, transcriptRevision: queued.base.revision,
          });
          assertSessionWritable(id);
          assertLease(id, queued.lease);
          await storageArea.set({
            [recordKey(id)]: {
              ...stored, transcript: normalizeTranscript(stored.transcript),
              currentTranscript: normalizeTranscript(stored.currentTranscript),
            },
          });
          queued.base.persisted = true;
          queued.base.transcript = [];
          assertSessionWritable(id);
          assertLease(id, queued.lease);
          return;
        }
        const stored = await persistSessionImages(queued.checkpoint);
        assertSessionWritable(id);
        assertLease(id, queued.lease);
        await storageArea.set({
          [transcriptCheckpointKey(id)]: { ...stored, transcript: normalizeTranscript(stored.transcript) },
        });
        assertSessionWritable(id);
        assertLease(id, queued.lease);
      })),
    };
    transcriptPending.set(id, queued);
    return queued.promise;
  }

  async function readActiveConversation(sessionId: string) {
    const id = requireSessionId(sessionId);
    return resolveSessionImages((await readCompatibleStorage(id))[activeConversationKey(id)] ?? null);
  }

  async function readCompatibleStorage(id: string) {
    const values = await storageArea.get([
      recordKey(id),
      activeConversationKey(id),
      transcriptCheckpointKey(id),
    ]);
    assertSessionRecordReadable(values[recordKey(id)]);
    assertConversationReadable(values[activeConversationKey(id)]);
    readCheckpointRecord(values[recordKey(id)], values[transcriptCheckpointKey(id)]);
    return values;
  }

  function writeActiveConversation(sessionId: string, conversation: unknown, lease: Lease, { immediate = false } = {}) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    assertLease(id, lease);
    return conversationQueues.run(id, () => imagePersistence.write(async () => {
      assertSessionWritable(id);
      assertLease(id, lease);
      assertConversationReadable(conversation);
      await readCompatibleStorage(id);
      assertSessionWritable(id);
      assertLease(id, lease);
      const stored = await persistSessionImages(conversation);
      assertSessionWritable(id);
      assertLease(id, lease);
      await storageArea.set({ [activeConversationKey(id)]: clone(stored) });
      return { sessionId: id, immediate: Boolean(immediate) };
    }));
  }

  function clearActiveConversation(sessionId: string, lease: Lease) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    assertLease(id, lease);
    return conversationQueues.run(id, async () => {
      assertSessionWritable(id);
      assertLease(id, lease);
      await readCompatibleStorage(id);
      assertSessionWritable(id);
      assertLease(id, lease);
      await storageArea.remove(activeConversationKey(id));
    });
  }

  async function readRuntime(sessionId: string, { legacyFallback = true } = {}) {
    const id = requireSessionId(sessionId);
    const key = runtimeKey(id);
    const values = await storageArea.get(legacyFallback ? [key, LEGACY_SESSION_RUNTIME_KEY] : key);
    const direct = values[key];
    if (direct && typeof direct === "object") return normalizeRuntime(direct, id, clock());
    const legacy = values[LEGACY_SESSION_RUNTIME_KEY];
    const fallback = record(legacy)[id] || null;
    return fallback ? normalizeRuntime(fallback, id, clock()) : null;
  }

  function writeRuntime(sessionId: string, runtime: unknown, { terminal = false } = {}) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    const normalized = normalizeRuntime(runtime, id, clock());
    let pending = runtimePending.get(id);
    if (!pending) {
      pending = { runtime: normalized, waiters: [], timer: null };
      runtimePending.set(id, pending);
    } else {
      pending.runtime = normalized;
    }

    const active = pending;
    const promise = new Promise<RuntimeCheckpoint | null>((resolve, reject) => active.waiters.push({ resolve, reject }));
    if (terminal) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      void flushRuntime(id);
    } else if (!pending.timer) {
      pending.timer = setTimeout(() => void flushRuntime(id), 0);
    }
    return promise;
  }

  async function flushRuntime(sessionId: string) {
    const id = requireSessionId(sessionId);
    const pending = runtimePending.get(id);
    if (!pending) return;
    runtimePending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    try {
      await runtimeQueues.run(id, () => storageArea.set({ [runtimeKey(id)]: pending.runtime }));
      for (const waiter of pending.waiters) waiter.resolve(pending.runtime);
    } catch (error) {
      for (const waiter of pending.waiters) waiter.reject(error);
    }
    if (runtimePending.has(id)) await flushRuntime(id);
  }

  function deleteRuntime(sessionId: string) {
    const id = requireSessionId(sessionId);
    const pending = runtimePending.get(id);
    runtimePending.delete(id);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      for (const waiter of pending.waiters) waiter.resolve(null);
    }
    return runtimeQueues.run(id, () => storageArea.remove(runtimeKey(id)));
  }

  async function migrateLegacyRuntime() {
    const values = await storageArea.get([LEGACY_SESSION_RUNTIME_KEY, SESSION_RUNTIME_MIGRATION_KEY]);
    const legacy = values[LEGACY_SESSION_RUNTIME_KEY];
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return { migrated: 0, skipped: 0, schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION };
    }
    let migrated = 0;
    let skipped = 0;
    for (const [rawId, runtime] of Object.entries(legacy)) {
      const id = normalizeSessionId(rawId || record(runtime).sessionId);
      if (!id || !runtime || typeof runtime !== "object") continue;
      const key = runtimeKey(id);
      const existing = (await storageArea.get(key))[key];
      if (existing) {
        skipped += 1;
        continue;
      }
      await runtimeQueues.run(id, () => storageArea.set({
        [key]: normalizeRuntime(runtime, id, clock()),
      }));
      migrated += 1;
    }
    await storageArea.set({ [SESSION_RUNTIME_MIGRATION_KEY]: SESSION_RUNTIME_SCHEMA_VERSION });
    return { migrated, skipped, schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION };
  }

  async function readRuntimeBatch(sessionIds: readonly string[]) {
    const ids = [...new Set((sessionIds || []).map(normalizeSessionId).filter(Boolean))];
    if (!ids.length) return {};
    const keys = ids.map(runtimeKey);
    const values = await storageArea.get([...keys, LEGACY_SESSION_RUNTIME_KEY]);
    const legacy = values[LEGACY_SESSION_RUNTIME_KEY];
    return Object.fromEntries(ids.map((id) => {
      const value = values[runtimeKey(id)] || record(legacy)[id];
      return [id, value ? normalizeRuntime(value, id, clock()) : null];
    }));
  }

  return Object.freeze({
    listMetadata,
    getMetadata,
    hydrateListSummaries,
    createMetadata,
    patchMetadata,
    updateMetadata,
    deleteSession,
    readRecord,
    writeRecord,
    writeTranscriptCheckpoint,
    readActiveConversation,
    async prepareConversation(sessionId: string, messages: unknown, lease: Lease) {
      const id = requireSessionId(sessionId);
      assertSessionWritable(id);
      assertLease(id, lease);
      return imagePersistence.write(async () => {
        const stored = await persistSessionImages(messages);
        assertSessionWritable(id);
        assertLease(id, lease);
        const conversation = serializeConversation(stored);
        imagePersistence.pinPrepared(id, conversation);
        return conversation;
      });
    },
    writeActiveConversation,
    clearActiveConversation,
    replaceActiveConversation,
    removeActiveConversation,
    readRuntime,
    readRuntimeBatch,
    writeRuntime,
    deleteRuntime,
    isWriteBlocked: (sessionId: string) => deletedSessionIds.has(requireSessionId(sessionId)),
    migrateLegacyRuntime,
    flush: () => Promise.all([
      metadataQueue.onIdle(),
      recordQueues.onIdle(),
      conversationQueues.onIdle(),
      runtimeQueues.onIdle(),
      ...[...runtimePending.keys()].map(flushRuntime),
    ]),
  });

  function replaceActiveConversation(sessionId: string, conversation: unknown) {
    const id = requireSessionId(sessionId);
    assertSessionWritable(id);
    return conversationQueues.run(id, () => imagePersistence.write(async () => {
      assertSessionWritable(id);
      const stored = await persistSessionImages(conversation);
      assertSessionWritable(id);
      await storageArea.set({ [activeConversationKey(id)]: clone(stored) });
      return resolveSessionImages(stored);
    }));
  }

  function removeActiveConversation(sessionId: string) {
    const id = requireSessionId(sessionId);
    return conversationQueues.run(id, () => storageArea.remove(activeConversationKey(id)));
  }

  function assertSessionWritable(sessionId: string) {
    if (deletedSessionIds.has(sessionId)) throw new DeletedSessionWriteError(sessionId);
  }
}

export function getSessionRepository() {
  const storage = globalThis.chrome?.storage?.local;
  if (!defaultRepository || defaultStorage !== storage) {
    defaultRepository = createSessionRepository({
      storage,
      normalizeRuntime: normalizeRuntimeCheckpoint,
    });
    defaultStorage = storage;
  }
  return defaultRepository;
}

export const getSessions = () => getSessionRepository().listMetadata();
export const createStoredSession = (...args: Parameters<ReturnType<typeof createSessionRepository>["createMetadata"]>) => getSessionRepository().createMetadata(...args);
export const deleteStoredSession = (...args: Parameters<ReturnType<typeof createSessionRepository>["deleteSession"]>) => getSessionRepository().deleteSession(...args);

export function normalizeRuntimeCheckpoint(input: unknown, sessionId = "", now = Date.now()): RuntimeCheckpoint {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return normalizeSessionRuntime(input, sessionId, now);
  }
  return {
    ...clone(input),
    schemaVersion: SESSION_RUNTIME_SCHEMA_VERSION,
    sessionId: requireSessionId(sessionId || record(input).sessionId),
  };
}

export function runtimeKey(sessionId: string) {
  return `${SESSION_RUNTIME_PREFIX}${requireSessionId(sessionId)}`;
}

function recordKey(sessionId: string) {
  return `${SESSION_RECORD_PREFIX}${sessionId}`;
}

function activeConversationKey(sessionId: string) {
  return `${ACTIVE_CONVERSATION_PREFIX}${sessionId}`;
}

function normalizeMetadataMap(value: unknown): Record<string, SessionMetadata> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Fields)
    .filter(([, session]) => session && typeof session === "object" && !Array.isArray(session))
    .map(([key, raw]) => {
      const session = record(raw);
      const id = normalizeSessionId(session.id) || key;
      const parentSessionId = normalizeParentSessionId(session.parentSessionId);
      return [id, cleanMetadata({
        ...session,
        id,
        parentSessionId: parentSessionId === id ? ROOT_SESSION_ID : parentSessionId,
        listSummary: normalizeSessionListSummary(session.listSummary),
      })];
    }));
}

function cleanMetadata<T extends Fields>(session: T): T {
  const next = { ...session };
  if (!next.source) delete next.source;
  if (!next.automationId) delete next.automationId;
  if (!next.automationRunId) delete next.automationRunId;
  return next;
}

function normalizeTitleSource(value: unknown, parentSessionId: unknown) {
  const source = String(value || "").trim();
  if (["generated", "fixed", "first_message", "manual"].includes(source)) return source;
  return normalizeParentSessionId(parentSessionId) === ROOT_SESSION_ID ? "first_message" : "fixed";
}

function normalizeSessionSource(value: unknown) {
  return String(value || "").trim() === "automation" ? "automation" : "";
}

function hasListSummary(summary: SessionListSummary | null | undefined) {
  if (!summary || typeof summary !== "object") return false;
  return Boolean(
    summary.lastText
    || summary.lastType
    || summary.lastAt
    || summary.messageCount
    || summary.artifactCount
    || summary.artifactPreview
    || summary.updatedAt,
  );
}

function extractFirstUserText(value: unknown) {
  const saved = record(value);
  const messages = saved.messages || record(saved.conversation).messages || saved.conversation || [];
  const message = Array.isArray(messages) ? messages.find((item) => item?.role === "user") : null;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n");
  return "";
}

function assertLease(sessionId: string, lease: Lease | null | undefined) {
  const valid = lease
    && normalizeSessionId(lease.sessionId) === sessionId
    && typeof lease.isActive === "function"
    && lease.isActive();
  if (!valid) throw new StaleSessionLeaseError(sessionId);
}

function requireSessionId(value: unknown) {
  const id = normalizeSessionId(value);
  if (!id) throw new TypeError("sessionId is required");
  return id;
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

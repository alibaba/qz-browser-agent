import { readSessionRecord } from "../../shared/session/session-codec.js";
import { readCheckpointRecord } from "../../shared/session/session-recovery.js";
import {
  hashSessionExchangeContent,
  hasSessionExchangeImportCapsule,
} from "../../shared/session/session-exchange.js";

/** Per-session legacy content identity. Metadata fields remain the source-id index. */
export const SESSION_IMPORT_DEDUP_PREFIX = "_session_import_dedup_";
export const SESSION_IMPORT_DEDUP_VERSION = 1;

export interface SessionImportDedupEntry {
  schemaVersion: typeof SESSION_IMPORT_DEDUP_VERSION;
  /** Null means the saved conversation was examined and has no import capsule. */
  contentHash: string | null;
}

interface ImportIdentityFields {
  id: string;
  exchangeSourceSessionId?: unknown;
  exchangeContentHash?: unknown;
}

export function sessionImportDedupKey(sessionId: string) {
  return `${SESSION_IMPORT_DEDUP_PREFIX}${sessionId}`;
}

export function normalizeSessionImportDedupEntry(value: unknown): SessionImportDedupEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== SESSION_IMPORT_DEDUP_VERSION) return null;
  if (raw.contentHash === null) return { schemaVersion: SESSION_IMPORT_DEDUP_VERSION, contentHash: null };
  if (typeof raw.contentHash !== "string" || !raw.contentHash) return null;
  return { schemaVersion: SESSION_IMPORT_DEDUP_VERSION, contentHash: raw.contentHash };
}

/**
 * Source id wins over content hash. Sessions with neither stored field are the
 * legacy copies whose hash still comes from the saved conversation.
 */
export function groupSessionsByImportIdentity<T extends ImportIdentityFields>(sessions: readonly T[]) {
  const bySourceId = new Map<string, T[]>();
  const byContentHash = new Map<string, T[]>();
  const unmarked: T[] = [];
  for (const session of sessions) {
    const sourceId = String(session.exchangeSourceSessionId || "");
    const contentHash = String(session.exchangeContentHash || "");
    if (sourceId) pushGroup(bySourceId, sourceId, session);
    if (contentHash) pushGroup(byContentHash, contentHash, session);
    if (!sourceId && !contentHash) unmarked.push(session);
  }
  return { bySourceId, byContentHash, unmarked };
}

/** Hash the saved conversation. Null means the record cannot be classified yet. */
export async function sessionImportDedupEntryFromRecord(recordInput: unknown): Promise<SessionImportDedupEntry | null> {
  try {
    const conversation = readSessionRecord(readCheckpointRecord(recordInput)).conversation;
    if (!hasSessionExchangeImportCapsule(conversation)) {
      return { schemaVersion: SESSION_IMPORT_DEDUP_VERSION, contentHash: null };
    }
    return {
      schemaVersion: SESSION_IMPORT_DEDUP_VERSION,
      contentHash: await hashSessionExchangeContent(conversation),
    };
  } catch {
    return null;
  }
}

/**
 * Keep ordinary record writes unchanged until a capsule or an existing entry
 * needs a new hash. Callers merge the returned patch into the record write.
 */
export function sessionImportDedupWritePatch(
  sessionId: string,
  existing: unknown,
  next: SessionImportDedupEntry | null,
): Record<string, SessionImportDedupEntry> {
  if (!next) return {};
  const current = normalizeSessionImportDedupEntry(existing);
  if (!current && next.contentHash === null) return {};
  if (current && current.contentHash === next.contentHash) return {};
  return { [sessionImportDedupKey(sessionId)]: next };
}

function pushGroup<T>(groups: Map<string, T[]>, key: string, session: T) {
  const list = groups.get(key);
  if (list) list.push(session);
  else groups.set(key, [session]);
}

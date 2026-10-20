import type { SessionListSummary } from "./session-list-summary.js";
/** Metadata keeps unknown extension fields; legacy records may omit display fields. */
export interface SessionMetadata {
  id: string;
  parentSessionId: string;
  listSummary: SessionListSummary;
  title?: string;
  titleSource?: string;
  source?: string;
  automationId?: string;
  automationRunId?: string;
  createdAt?: string;
  updatedAt?: string;
  [field: string]: unknown;
}

import { normalizeSessionListSummary } from "./session-list-summary.js";

export const SESSIONS_KEY = "_sessions";
export const SESSION_RECORD_PREFIX = "_session_";
export const ACTIVE_CONVERSATION_PREFIX = "_active_conversation_";
export const SESSION_TRANSCRIPT_CHECKPOINT_PREFIX = "_session_transcript_checkpoint_";
export const ROOT_SESSION_ID = "0";

export function genSessionId() {
  return crypto.randomUUID().replaceAll("-", "");
}

export function normalizeSessionId(sessionId: unknown) {
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "";
}

export function normalizeParentSessionId(parentSessionId: unknown) {
  if (parentSessionId === 0 || parentSessionId === "0") return ROOT_SESSION_ID;
  const id = normalizeSessionId(parentSessionId);
  return id || ROOT_SESSION_ID;
}

export async function getSessions(): Promise<Record<string, SessionMetadata>> {
  const { [SESSIONS_KEY]: sessions = {} } = await chrome.storage.local.get(SESSIONS_KEY);
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return {};
  return Object.fromEntries(
    Object.entries(sessions as Record<string, Partial<SessionMetadata>>)
      .filter(([, session]) => session && typeof session === "object" && !Array.isArray(session))
      .map(([id, session]) => {
        const sessionId = normalizeSessionId(session.id) || id;
        const parentSessionId = normalizeParentSessionId(session.parentSessionId);
        return [
          id,
          {
            ...session,
            id: sessionId,
            parentSessionId: parentSessionId === sessionId ? ROOT_SESSION_ID : parentSessionId,
            listSummary: normalizeSessionListSummary(session.listSummary),
          },
        ];
      }),
  );
}

export function storedSessionKey(sessionId: string) {
  return `${SESSION_RECORD_PREFIX}${sessionId}`;
}

export function activeConversationKey(sessionId: string) {
  return `${ACTIVE_CONVERSATION_PREFIX}${sessionId}`;
}

export function transcriptCheckpointKey(sessionId: string) {
  return `${SESSION_TRANSCRIPT_CHECKPOINT_PREFIX}${sessionId}`;
}


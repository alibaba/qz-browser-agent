import type { TranscriptEntry } from "../contracts/session.js";
import { readSessionSnapshot } from "./session-recovery.js";
import { activeConversationKey, normalizeSessionId, storedSessionKey, transcriptCheckpointKey } from "./session-store.js";

/** Read-only history boundary. Storage keys and legacy conversation fallback stay internal. */
export async function readStoredTranscript(sessionId: unknown, signal?: AbortSignal): Promise<TranscriptEntry[]> {
  signal?.throwIfAborted();
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const key = storedSessionKey(id);
  const activeKey = activeConversationKey(id);
  const checkpointKey = transcriptCheckpointKey(id);
  const saved = await chrome.storage.local.get([key, activeKey, checkpointKey]);
  signal?.throwIfAborted();
  return readSessionSnapshot(saved[key], saved[activeKey], saved[checkpointKey]).transcript;
}

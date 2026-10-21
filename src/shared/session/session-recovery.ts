import { normalizeConversationSnapshot, readSessionRecord, transcriptFromConversation } from "./session-codec.js";
import type { Conversation, TranscriptEntry } from "../contracts/session.js";
import { assertSessionRecordReadable, SessionFormatError } from "./session-format.js";

/** Restore committed history and the latest complete current display snapshot. */
export function readCheckpointRecord(recordInput: unknown, checkpointInput: unknown = null): Record<string, unknown> | null {
  assertSessionRecordReadable(recordInput);
  const stored = recordInput as Record<string, unknown> | null | undefined;
  const { transcriptRevision, currentTranscript, ...saved } = stored || {};
  if (currentTranscript !== undefined && !Array.isArray(currentTranscript)) throw new SessionFormatError("invalid");
  let current = currentTranscript;
  if (checkpointInput != null) {
    if (typeof checkpointInput !== "object" || Array.isArray(checkpointInput)) throw new SessionFormatError("invalid");
    const checkpoint = checkpointInput as Record<string, unknown>;
    if (checkpoint.version !== 2) throw new SessionFormatError("record", checkpoint.version);
    if (typeof checkpoint.baseRevision !== "string" || !checkpoint.baseRevision
        || !Array.isArray(checkpoint.transcript)) throw new SessionFormatError("invalid");
    // A completed save, edit or replacement establishes a new revision.
    if (stored && transcriptRevision === checkpoint.baseRevision) current = checkpoint.transcript;
  }
  if (!stored) return null;
  if (current === undefined) return saved;
  if (!Array.isArray(saved.transcript)) throw new SessionFormatError("invalid");
  return { ...saved, transcript: saved.transcript.concat(current) };
}

/** Restore the saved display snapshot; model history is a separate execution checkpoint. */
export function readSessionSnapshot(recordInput: unknown, activeConversation: unknown = null, checkpointInput: unknown = null): {
  conversation: Conversation | null;
  transcript: TranscriptEntry[];
} {
  const record = readCheckpointRecord(recordInput, checkpointInput);
  const saved = readSessionRecord(record, { repairTools: false });
  const conversation = activeConversation == null ? saved.conversation : normalizeConversationSnapshot(activeConversation);
  const hasTranscript = Boolean(record && Array.isArray(record.transcript));
  return { conversation, transcript: hasTranscript ? saved.transcript : transcriptFromConversation(conversation) };
}

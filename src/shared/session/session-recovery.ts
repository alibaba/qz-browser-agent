import { normalizeConversationSnapshot, readSessionRecord, transcriptFromConversation } from "./session-codec.js";
import type { Conversation, TranscriptEntry } from "../contracts/session.js";

/** Restore the saved display snapshot; model history is a separate execution checkpoint. */
export function readSessionSnapshot(recordInput: unknown, activeConversation: unknown = null): {
  conversation: Conversation | null;
  transcript: TranscriptEntry[];
} {
  const saved = readSessionRecord(recordInput, { repairTools: false });
  const conversation = activeConversation == null ? saved.conversation : normalizeConversationSnapshot(activeConversation);
  const hasTranscript = Boolean(recordInput && typeof recordInput === "object"
    && "transcript" in recordInput && Array.isArray(recordInput.transcript));
  return { conversation, transcript: hasTranscript ? saved.transcript : transcriptFromConversation(conversation) };
}

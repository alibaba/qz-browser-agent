import {
  normalizeConversationSnapshot,
  readSessionRecord,
  transcriptFromConversation,
} from "./session-codec.js";
import type { Conversation, TranscriptEntry } from "../contracts/session.js";

/** Recover persisted content without replaying execution or rewriting either snapshot. */
export function readSessionSnapshot(recordInput: unknown, activeConversation: unknown = null): {
  conversation: Conversation | null;
  transcript: TranscriptEntry[];
} {
  const saved = readSessionRecord(recordInput);
  if (activeConversation == null) return {
    conversation: saved.conversation,
    transcript: saved.transcript.length ? saved.transcript : transcriptFromConversation(saved.conversation),
  };

  const conversation = normalizeConversationSnapshot(activeConversation);
  const canonical = transcriptFromConversation(conversation);
  const previous = transcriptFromConversation(saved.conversation);
  const oldBody = previous.filter(isBody);
  const newBody = canonical.filter(isBody);
  let retained = 0;
  // Compaction inserts markers into retained history. Edits truncate it, even when
  // they reuse a clientMessageId; neither entry count nor positional IDs prove age.
  while (retained < oldBody.length && retained < newBody.length
    && sameBody(oldBody[retained], newBody[retained])) retained++;

  const overlays: { before: TranscriptEntry[]; entry: TranscriptEntry }[] = [];
  let decorations: TranscriptEntry[] = [];
  let richPrefix = true;
  for (const entry of saved.transcript) {
    if (entry.type === "compact") {
      // Failed/in-progress compaction has no conversation marker. Preserve that
      // event like a note, but never resurrect a marker removed by an edit.
      if (![...previous, ...canonical].some(item => item.type === "compact" && item.compactId === entry.compactId)) {
        decorations.push(entry);
      }
      continue;
    }
    if (!isBody(entry)) {
      decorations.push(entry);
      continue;
    }
    const old = oldBody[overlays.length];
    if (overlays.length >= retained || !old || !matchesRichEntry(old, entry)) {
      richPrefix = false;
      break;
    }
    overlays.push({ before: decorations, entry });
    decorations = [];
  }
  // Unanchored decorations after a changed/truncated message belong to the old
  // branch. Keep a trailing decoration only when the entire old body survived.
  const trailing = richPrefix && retained === oldBody.length && overlays.length === oldBody.length
    && oldBody.length > 0 ? decorations : [];
  const oldCompacts = previous.filter(entry => entry.type === "compact");
  const richCompacts = saved.transcript.filter(entry => entry.type === "compact");
  const transcript: TranscriptEntry[] = [];
  let bodyIndex = 0;
  for (const entry of canonical) {
    if (entry.type === "compact") {
      const oldIndex = oldCompacts.findIndex(old => sameCompact(old, entry));
      if (oldIndex >= 0) {
        oldCompacts.splice(oldIndex, 1);
        const richIndex = richCompacts.findIndex(rich => rich.compactId && rich.compactId === entry.compactId);
        if (richIndex >= 0) {
          const [rich] = richCompacts.splice(richIndex, 1);
          // The codec represents absent compaction metrics as zero.
          const fields = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== 0));
          transcript.push({ ...rich, ...fields, timestamp: rich.timestamp || entry.timestamp });
          continue;
        }
      }
      transcript.push(entry);
      continue;
    }
    const overlay = overlays[bodyIndex++];
    if (overlay) transcript.push(...overlay.before, enrichEntry(entry, overlay.entry));
    else transcript.push(entry);
    if (bodyIndex === oldBody.length) transcript.push(...trailing);
  }
  return { conversation, transcript };
}

function isBody(entry: TranscriptEntry) {
  return entry.type === "user" || entry.type === "assistant" || entry.type === "tool";
}

function sameIdentity(a: string | undefined, b: string | undefined) {
  return !a || !b || a === b;
}

function sameBody(a: TranscriptEntry, b: TranscriptEntry): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "user") return sameIdentity(a.clientMessageId, b.clientMessageId)
    && a.text === b.text
    && sameJson(a.images?.map(image => image.dataUrl), b.images?.map(image => image.dataUrl))
    && sameJson(a.documents, b.documents);
  if (a.type === "assistant") return a.content === b.content;
  return sameIdentity(a.toolCallId, b.toolCallId) && a.name === b.name
    && sameJson(a.args, b.args) && sameJson(a.result, b.result);
}

function matchesRichEntry(canonical: TranscriptEntry, rich: TranscriptEntry) {
  if (canonical.type !== rich.type) return false;
  if (canonical.type === "tool") return sameIdentity(canonical.toolCallId, rich.toolCallId)
    && canonical.name === rich.name
    && (rich.argsIncomplete || rich.argsGenerating || sameJson(canonical.args, rich.args));
  if (canonical.type === "assistant") return typeof rich.content === "string"
    && typeof canonical.content === "string" && canonical.content.startsWith(rich.content);
  return sameBody(canonical, rich);
}

function sameCompact(a: TranscriptEntry, b: TranscriptEntry) {
  return a.compactId === b.compactId && a.summary === b.summary;
}

function enrichEntry(canonical: TranscriptEntry, rich: TranscriptEntry): TranscriptEntry {
  if (canonical.type === "user") return {
    ...canonical, ...rich, text: canonical.text, documents: canonical.documents,
    clientMessageId: canonical.clientMessageId || rich.clientMessageId,
  };
  if (canonical.type === "assistant") return { ...canonical, ...rich, content: canonical.content };
  const unfinished = rich.isRunning || rich.argsIncomplete || rich.argsGenerating
    || ["preparing", "running"].includes(rich.phase || "")
    || ["generating", "ready", "executing"].includes(rich.argsState || "");
  return {
    ...canonical, ...rich, name: canonical.name, args: canonical.args,
    toolCallId: canonical.toolCallId || rich.toolCallId,
    result: rich.result ?? canonical.result,
    endedAt: rich.endedAt || canonical.endedAt,
    ...(unfinished ? {
      result: canonical.result, isError: canonical.isError,
      isRunning: false, argsIncomplete: false, argsGenerating: false,
      argsState: Object.keys(canonical.args || {}).length ? "final" : "final_empty",
      phase: "done", statusText: "", rateLimit: null,
    } : {}),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
}

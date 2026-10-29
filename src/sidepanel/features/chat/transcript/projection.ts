import { optionalSessionId as normalizeSessionId } from "../../sessions/session-id.js";
import type { TranscriptEntry } from "../../../tools/renderer-input.js";
interface ProjectionOptions {
  projectArtifacts?(entries: TranscriptEntry[], sessionId: string): TranscriptEntry[];
  isQueuedSubmission?(sessionId: string, clientMessageId: unknown): boolean;
}

import { groupConsecutiveToolTranscriptEntries } from "../../../tools/tool-timeline-renderer.js";
import { hashText } from "../../../ui/ui-utils.js";
import { normalizeFailureTextForCompare } from "../markdown-feature.js";

export function createTranscriptProjection(options: ProjectionOptions = {}) {
  const projectArtifacts = options.projectArtifacts || ((entries: TranscriptEntry[]) => entries);

function visibleTranscriptHistory(history: TranscriptEntry[]) {
  return dedupeDuplicateAssistantFailureErrors(
    (Array.isArray(history) ? history : []).filter((entry) => !isCaseRecordingTranscriptNote(entry)),
  );
}

function dedupeDuplicateAssistantFailureErrors(history: TranscriptEntry[] = []) {
  const entries = Array.isArray(history) ? history : [];
  return entries.filter((entry, index) => {
    if (entry?.type !== "error" || !entry.text) return true;
    const current = normalizeFailureTextForCompare(entry.text);
    if (!current) return true;
    for (let i = index - 1; i >= 0 && i >= index - 4; i -= 1) {
      const prev = entries[i];
      if (!prev || ["thinking", "run-status", "note"].includes(prev.type || "")) continue;
      if (prev.type !== "assistant") break;
      const previous = normalizeFailureTextForCompare(String(prev.content || ""));
      if (previous && (previous === current || previous.includes(current) || current.includes(previous))) {
        return false;
      }
      break;
    }
    return true;
  });
}

function transcriptUiHistory(history: TranscriptEntry[], { sessionId = "" } = {}) {
  // Retain optimistic delivery evidence in the transcript store, but show pending
  // submissions to a busy Session in the queue until Background decides admission.
  const visible = visibleTranscriptHistory(history).filter(entry => !(entry.type === "user"
    && entry.deliveryStatus === "pending" && options.isQueuedSubmission?.(sessionId, entry.clientMessageId)));
  return projectArtifacts(
    groupConsecutiveToolTranscriptEntries(visible),
    sessionId,
  );
}

function assignTranscriptUiKeys(sessionId: unknown, history: TranscriptEntry[]) {
  // Keys survive stream growth and regrouping; DOM position cannot identify a tool or user choice.
  const id = normalizeSessionId(sessionId);
  if (!id || !Array.isArray(history)) return;
  const seen = new Set();
  history.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const existingKey = isLegacyGeneratedTranscriptKey(id, entry._uiKey) ? "" : entry._uiKey;
    const baseKey = existingKey
      || stableTranscriptUiKey(id, entry)
      || fallbackTranscriptUiKey(id, entry);
    let key = baseKey;
    let duplicate = 1;
    while (seen.has(key)) {
      duplicate += 1;
      key = `${baseKey}:duplicate:${duplicate}`;
    }
    entry._uiKey = key;
    seen.add(key);
  });
}

function fallbackTranscriptUiKey(sessionId: string, entry: TranscriptEntry) {
  const type = String(entry?.type || "entry").trim() || "entry";
  return `${sessionId}:${type}:legacy:${hashText(canonicalTranscriptUiValue(entry))}`;
}

function canonicalTranscriptUiValue(value: unknown) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(normalize(value));
  } catch (_err) {
    return String(value || "");
  }

  function normalize(input: unknown): unknown {
    if (input == null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (key === "_uiKey" || key === "_toolPresentationAnchor") continue;
      out[key] = normalize(value);
    }
    return out;
  }
}

function isLegacyGeneratedTranscriptKey(sessionId: string, value: unknown) {
  const key = String(value || "");
  if (!key.startsWith(`${sessionId}:entry:`)) return false;
  return /^\d+$/.test(key.slice(`${sessionId}:entry:`.length));
}

function stableTranscriptUiKey(sessionId: string, entry: TranscriptEntry) {
  if (entry.type === "user" && entry.clientMessageId) {
    return `${sessionId}:user:${entry.clientMessageId}`;
  }
  if (entry.type === "tool" && entry.toolCallId) {
    return `${sessionId}:tool:${entry.runId || "run"}:${entry.toolCallId}`;
  }
  if (entry.type === "wait" && entry.waitId) {
    return `${sessionId}:wait:${entry.runId || "run"}:${entry.waitId}`;
  }
  if (entry.type === "compact" && entry.compactId) {
    return `${sessionId}:compact:${entry.runId || "run"}:${entry.compactId}`;
  }
  if (entry.type === "run-status" && entry.runId) {
    return `${sessionId}:run-status:${entry.runId}:${entry.status || "state"}`;
  }
  if (entry.type === "artifacts") {
    return `${sessionId}:artifacts`;
  }
  if ((entry.type === "assistant" || entry.type === "thinking") && entry.spanId) {
    return `${sessionId}:${entry.type}:${entry.runId || "run"}:${entry.spanId}`;
  }
  if (entry.spanId) {
    return `${sessionId}:${entry.type || "entry"}:${entry.runId || "run"}:${entry.spanId}`;
  }
  if (entry.runId && Number.isFinite(Number(entry.eventSeq))) {
    return `${sessionId}:${entry.type || "entry"}:${entry.runId}:event:${Number(entry.eventSeq)}`;
  }
  if (entry.type === "user" && entry.timestamp) {
    return `${sessionId}:user:${entry.timestamp}:${hashText(entry.text || "")}`;
  }
  if ((entry.type === "assistant" || entry.type === "thinking") && entry.timestamp) {
    return `${sessionId}:${entry.type}:${entry.timestamp}`;
  }
  if (entry.type === "compact" && entry.timestamp) {
    return `${sessionId}:compact:${entry.timestamp}`;
  }
  if ((entry.type === "note" || entry.type === "error") && entry.timestamp) {
    return `${sessionId}:${entry.type}:${entry.timestamp}:${hashText(entry.text || "")}`;
  }
  if (entry.type === "run-status" && entry.timestamp) {
    return `${sessionId}:run-status:${entry.timestamp}:${entry.status || "state"}`;
  }
  return "";
}

function isLiveTranscriptEntry(entry: TranscriptEntry | null | undefined) {
  return Boolean(
    entry?.streaming
    || entry?.isRunning
    || entry?.argsIncomplete
    || entry?.argsGenerating
    || entry?.argsState === "generating"
    || entry?.argsState === "ready"
    || entry?.argsState === "executing"
    || entry?.phase === "preparing"
    || entry?.phase === "running"
  );
}

function isCaseRecordingTranscriptNote(entry: TranscriptEntry | null | undefined) {
  if (entry?.type !== "note") return false;
  const text = String(entry.text || "");
  return /^case 录制(?:已开始|已保存|已停止)/u.test(text)
    || /^Recording (?:started|saved|stopped)(?:$|:)/u.test(text)
    || text === "已取消 case 录制" || text === "Recording cancelled";
}

function findRoundFinalAssistantIndexes(history: TranscriptEntry[], { canShowActions = true } = {}) {
  const indexes = new Set<number>();
  if (!canShowActions || !Array.isArray(history) || history.length === 0) return indexes;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (isCaseRecordingTranscriptNote(entry)) continue;
    if (entry?.type === "artifacts") continue;
    if (entry?.type === "assistant" && !entry.streaming && String(entry.content || "").trim()) {
      indexes.add(i);
    }
    break;
  }

  return indexes;
}

  return {
    visibleHistory: visibleTranscriptHistory,
    uiHistory: transcriptUiHistory,
    assignKeys: assignTranscriptUiKeys,
    stableKey: stableTranscriptUiKey,
    isLiveEntry: isLiveTranscriptEntry,
    isCaseRecordingNote: isCaseRecordingTranscriptNote,
    findRoundFinalAssistantIndexes,
  };
}

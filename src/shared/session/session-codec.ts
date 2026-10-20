import { t } from "../i18n/backend.js";
import { CURRENT_SESSION_VERSION, CURRENT_SESSION_RECORD_VERSION, SESSION_RECORD_TYPE, assertSessionRecordReadable, assertConversationReadable } from "./session-format.js";
import { isBeijingDateTime, nowBeijingDateTime } from "../time-utils.js";
import {
  SESSION_RUNTIME_STATUS,
  normalizeSessionRuntimeStatus,
} from "./session-runtime-status.js";
import { repairToolMessageSequence } from "../tools/tool-message-protocol.js";
import { toolIdentityMetaFromEvent } from "../tools/tool-identity.js";
import {
  MESSAGE_ORIGIN_TOOL_IMAGE,
  USER_MESSAGE_KINDS,
  USER_MESSAGE_ORIGINS,
  isHiddenContextUserMessage,
} from "../message-blocks.js";
import { normalizeMessageDocuments } from "../documents/document-attachments.js";

import type { ModelToolCall } from '../contracts/model-message.js';
import type { CompactMeta, Conversation, ConversationEntry, SessionMessage,
  TranscriptAgentEvent, TranscriptEntry, TranscriptImage, TranscriptMeta } from '../contracts/session.js';
export type { Conversation, ConversationEntry, SessionMessage, TranscriptEntry } from '../contracts/session.js';

type EntryFields = Partial<TranscriptEntry>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const MAX_TOOL_RESULT_CHARS = 20000;
export const SESSION_TITLE_MAX_LENGTH = 120;

export function createSessionRecord(conversation: unknown, transcript: unknown) {
  return {
    type: SESSION_RECORD_TYPE,
    version: CURRENT_SESSION_RECORD_VERSION,
    conversation: normalizeConversationSnapshot(conversation),
    transcript: normalizeTranscript(transcript),
    savedAt: nowBeijingDateTime(),
  };
}

export function readSessionRecord(input: unknown) {
  const saved = record(input);
  assertSessionRecordReadable(input);
  if (!input) {
    return { conversation: null, transcript: [] };
  }
  const conversation = normalizeConversationSnapshot(saved.conversation);
  const transcript = normalizeTranscript(saved.transcript);
  return {
    conversation,
    transcript: repairTranscriptToolResults(transcript, conversation),
  };
}

export function mergeTranscriptSnapshotWithLocalState(existing: readonly TranscriptEntry[] = [], snapshot: readonly TranscriptEntry[] = []) {
  const merged = (Array.isArray(snapshot) ? snapshot : []).map(entry => ({ ...entry }));
  const localHistory = Array.isArray(existing) ? existing : [];
  for (const local of localHistory) {
    if (isProtectedLocalUser(local)) upsertLocalUserEvidence(merged, local, localHistory);
    else if (isProtectedLocalTool(local)) upsertLocalToolEvidence(merged, local, localHistory);
  }
  return merged;
}

export function serializeConversation(messages: unknown): Conversation {
  const entries: ConversationEntry[] = [];
  let parentId: string | null = null;

  for (const msg of Array.isArray(messages) ? messages : []) {
    const normalized = normalizeMessage(msg);
    if (!normalized || normalized.role === "system") continue;

    const id = genEntryId(entries.length);
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: nowBeijingDateTime(),
      message: normalized,
    });
    parentId = id;
  }

  return {
    type: "conversation",
    version: CURRENT_SESSION_VERSION,
    entries,
  };
}

export function deserializeConversation(saved: unknown, systemPrompt: string) {
  return deserializeConversationWithRepair(saved, systemPrompt).messages;
}

export function deserializeConversationWithRepair(saved: unknown, systemPrompt: string) {
  const entries = readEntries(saved);
  const messages: SessionMessage[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];

  for (const entry of entries) {
    const msg = normalizeMessage(entry.message ?? entry);
    if (!msg || msg.role === "system") continue;
    messages.push(msg);
  }

  const repaired = repairToolMessageSequence(messages, {
    interruptedReason: t("session.historicalToolInterrupted"),
  });
  return {
    messages: repaired.messages,
    repaired: repaired.changed,
    inserted: repaired.inserted,
    dropped: repaired.dropped,
  };
}

export function getConversationPreview(saved: unknown) {
  const entries = readEntries(saved);
  for (const entry of entries) {
    const msg = normalizeMessage(entry.message ?? entry);
    if (msg?.role !== "user") continue;
    if (isHiddenContextUserMessage(msg)) continue;
    const text = cleanTitleText(contentToText(msg.content));
    if (text) return text;
  }
  return t("session.new");
}

export function transcriptFromConversation(saved: unknown) {
  const transcript: TranscriptEntry[] = [];
  const pendingToolCalls: { id: string; name: string; args: Record<string, unknown>; timestamp?: string }[] = [];

  for (const entry of readEntries(saved)) {
    const msg = normalizeMessage(entry.message ?? entry);
    if (!msg || msg.role === "system") continue;

    if (msg.role === "user") {
      if (msg._kind === "compaction") {
        const summary = compactSummaryText(msg.content);
        transcript.push({
          type: "compact",
          status: msg._compact?.status || "done",
          summary,
          ...normalizeCompactMeta(msg._compact),
          ...normalizeTranscriptMeta(msg),
          ...normalizeTranscriptTiming(entry),
        });
        continue;
      }
      if (msg._origin === MESSAGE_ORIGIN_TOOL_IMAGE || isHiddenContextUserMessage(msg)) continue;
      const text = contentToText(msg.content);
      const images = contentToImages(msg.content);
      const documents = normalizeMessageDocuments(msg.documents);
      if (text || images.length || documents.length) {
        transcript.push({ type: "user", text, images, documents, ...normalizeTranscriptMeta(msg), ...normalizeTranscriptTiming(entry) });
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.content) transcript.push({ type: "assistant", content: msg.content, ...normalizeTranscriptTiming(entry) });
      for (const toolCall of msg.tool_calls || []) {
        pendingToolCalls.push({
          id: toolCall.id,
          name: toolCall.function?.name || "tool",
          args: parseToolArguments(toolCall.function?.arguments),
          timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      const callIndex = pendingToolCalls.findIndex(call => call.id === msg.tool_call_id);
      const [call] = callIndex >= 0 ? pendingToolCalls.splice(callIndex, 1) : [null];
      const result = parseToolResult(msg.content);
      transcript.push({
        type: "tool",
        ...(call?.id ? { toolCallId: call.id } : {}),
        name: call?.name || "tool",
        args: call?.args || {},
        result,
        isError: Boolean(result && typeof result === "object" && record(result).error),
        image: null,
        ...normalizeTranscriptTiming({
          timestamp: call?.timestamp || entry.timestamp,
          endedAt: entry.timestamp,
        }),
      });
    }
  }

  return normalizeTranscript(transcript);
}

export function getLastTranscriptToolName(transcript: readonly TranscriptEntry[], { completedOnly = true } = {}) {
  const items = Array.isArray(transcript) ? transcript : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const entry = items[i];
    if (entry?.type !== "tool") continue;
    if (completedOnly && (
      entry.isRunning
      || entry.argsIncomplete
      || entry.argsGenerating
      || entry.argsState === "generating"
      || entry.argsState === "ready"
      || entry.argsState === "executing"
      || entry.phase === "preparing"
      || entry.phase === "running"
    )) {
      continue;
    }
    return String(entry.name || "").trim();
  }
  return "";
}

export function updateTranscriptWithAgentEvent(transcript: readonly TranscriptEntry[], event: TranscriptAgentEvent) {
  const history: TranscriptEntry[] = Array.isArray(transcript) ? transcript.slice() : [];
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    return { transcript: history, changed: false };
  }

  const message = typeof event.message === "object" ? event.message : undefined;
  const messageText = typeof event.message === "string" ? event.message : "";
  switch (event.type) {
    case "agent_start": {
      const clientMessageId = normalizeClientMessageId(event.clientMessageId);
      const runId = eventRunId(event);
      const index = clientMessageId ? findTranscriptEntryIndex(history, "user", { clientMessageId }) : -1;
      if (index < 0 || !runId) return { transcript: history, changed: false };
      // Admission precedes run allocation; bind only the explicitly identified initiating message.
      history[index] = { ...history[index], runId, eventSeq: event.eventSeq };
      return { transcript: history, changed: true };
    }

    case "state": {
      const phase = terminalToolPhaseFromRuntimeStatus(event);
      if (!phase) return { transcript: history, changed: false };
      const streamingChanged = finalizeAllStreamingTranscriptEntries(history, phase === "not_executed" ? "completed" : phase);
      const toolChanged = finalizeToolTranscriptEntries(history, event, phase);
      const statusChanged = phase === "aborted" ? upsertRunStatusTranscriptEntry(history, event, "aborted") : false;
      const changed = streamingChanged || toolChanged || statusChanged;
      return { transcript: history, changed };
    }

    case "message_start":
      if (message?.role === "user" && (!message._origin || message._origin === "user")) {
        const text = contentToText(message.content);
        const images = contentToImages(message.content);
        const documents = normalizeMessageDocuments(message.documents);
        if (text || images.length || documents.length) {
          upsertTranscriptEntry(history, "user", eventMeta(event, { type: "user", text, images, documents }));
          return { transcript: history, changed: true };
        }
      }
      if (message?.role === "assistant") {
        upsertTranscriptEntry(history, "assistant", eventMeta(event, {
          type: "assistant",
          content: contentToText(message.content || ""),
        }), "streaming");
        return { transcript: history, changed: true };
      }
      return { transcript: history, changed: false };

    case "thinking_update": {
      const idx = findTranscriptEntryIndex(history, "thinking", event);
      const existing = idx >= 0 ? history[idx] : null;
      const text = event.thinking ?? `${existing?.text || ""}${event.delta || ""}`;
      upsertTranscriptEntry(history, "thinking", eventMeta(event, { type: "thinking", text }), "streaming");
      return { transcript: history, changed: true };
    }

    case "context_compaction_start":
    case "context_compaction_end":
    case "context_compaction_failed": {
      const starting = event.type === "context_compaction_start";
      const failed = event.type === "context_compaction_failed";
      const entry: TranscriptEntry = {
        type: "compact",
        compactId: String(event.compactId || ""),
        status: starting ? "running" : failed ? "failed" : String(event.status || "done"),
        summary: starting ? "" : failed
          ? String(event.message || t("agent.compactionFailed"))
          : String(event.summary || compactSummaryText(event.content) || ""),
        inputTokensBefore: Number(event.inputTokensBefore || 0),
        contextWindow: Number(event.contextWindow || 0),
        threshold: Number(event.threshold || 0),
        sourceMessageCount: Number(event.sourceMessageCount || 0),
        retainedMessageCount: Number(event.retainedMessageCount || 0),
      };
      if (!starting) {
        if (!failed) entry.inputTokensAfter = Number(event.inputTokensAfter || 0);
        entry.endedAt = nowBeijingDateTime();
      }
      upsertTranscriptEntry(history, "compact", eventMeta(event, entry), starting ? "streaming" : "final");
      return { transcript: history, changed: true };
    }

    case "message_update":
      finalizeTranscriptEntry(history, "thinking", event.spanId);
      upsertTranscriptEntry(history, "assistant", eventMeta(event, {
        type: "assistant",
        content: event.content || "",
      }), "streaming");
      return { transcript: history, changed: true };

    case "message_end":
      if (message?.role === "assistant" && message.content) {
        upsertTranscriptEntry(history, "assistant", eventMeta(event, {
          type: "assistant",
          content: message.content,
        }), "final");
        return { transcript: history, changed: true };
      }
      return { transcript: history, changed: false };

    case "tool_call_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const toolCallId = normalizeEventToolCallId(event);
      if (!toolCallId) return { transcript: history, changed: false };
      const entry: TranscriptEntry = {
        type: "tool",
        spanId: event.spanId || `tool:${toolCallId}`,
        toolCallId,
        name: event.toolName || "tool",
        ...toolIdentityMetaFromEvent(event),
        args: event.args ?? {},
        argsText: "",
        argsIncomplete: false,
        argsGenerating: false,
        argsState: "executing",
        phase: "running",
        result: null,
        isError: false,
        isRunning: true,
        image: null,
      };
      if (event.type === "tool_call_update") {
        const argsComplete = event.argsComplete === true;
        finalizeTranscriptEntry(history, "thinking", event.parentSpanId);
        entry.args = {};
        entry.argsText = toolArgsTextFromEvent(event);
        entry.argsIncomplete = !argsComplete;
        entry.argsGenerating = !argsComplete;
        entry.argsState = argsComplete ? "ready" : "generating";
        entry.phase = event.phase || "preparing";
      } else if (event.type === "tool_execution_start") {
        finalizeTranscriptEntry(history, "thinking");
      } else if (event.type === "tool_execution_update") {
        const idx = findToolTranscriptIndex(history, { toolCallId, runId: eventRunId(event) });
        const existing: EntryFields = idx >= 0 ? history[idx] : {};
        entry.spanId = event.spanId || existing.spanId || entry.spanId;
        entry.name = event.toolName || existing.name || "tool";
        entry.args = event.args ?? existing.args ?? {};
        entry.argsText = existing.argsText || "";
        entry.argsState = event.argsState || existing.argsState || "executing";
        entry.phase = event.phase || existing.phase || "running";
        entry.statusText = String(event.statusText || "");
        entry.rateLimit = event.rateLimit && typeof event.rateLimit === "object" ? cloneJsonValue(event.rateLimit) : existing.rateLimit || null;
        entry.result = existing.result ?? null;
        entry.image = existing.image || null;
      } else {
        const image = record(event.result)._image;
        const hasImage = !event.isError && typeof image === "string" && Boolean(image);
        entry.argsState = finalToolArgsState(entry.args);
        entry.phase = "done";
        entry.statusText = "";
        entry.result = hasImage ? stripInlineImageFromToolResult(event.result) : event.result ?? null;
        entry.isError = !!event.isError;
        entry.isRunning = false;
        entry.image = hasImage ? image : null;
        entry.endedAt = eventEndTime(event);
      }
      upsertTranscriptEntry(history, "tool", eventMeta(event, entry));
      return { transcript: history, changed: true };
    }

    case "waiting_for_user":
      upsertTranscriptEntry(history, "wait", eventMeta(event, {
        type: "wait",
        waitId: event.waitId,
        title: String(record(event.form).title || event.title || ""),
        message: messageText,
        form: event.form || null,
        status: "waiting",
      }));
      return { transcript: history, changed: true };

    case "user_wait_resolved":
      resolveWaitTranscriptEntry(history, event);
      return { transcript: history, changed: true };

    case "warning":
      if (event.message) {
        history.push(eventMeta(event, { type: "note", text: messageText }));
        return { transcript: history, changed: true };
      }
      return { transcript: history, changed: false };

    case "aborted":
      {
        const streamingChanged = finalizeAllStreamingTranscriptEntries(history, "aborted");
        const toolChanged = finalizeToolTranscriptEntries(history, event, "aborted");
        const statusChanged = upsertRunStatusTranscriptEntry(history, event, "aborted");
        return { transcript: history, changed: streamingChanged || toolChanged || statusChanged };
      }

    case "error":
      finalizeAllStreamingTranscriptEntries(history, "error");
      finalizeToolTranscriptEntries(history, event, "error");
      if (isDuplicateTerminalError(history, event.message)) {
        return { transcript: history, changed: true };
      }
      history.push(eventMeta(event, { type: "error", text: messageText || t("status.runFailed") }));
      return { transcript: history, changed: true };

    case "agent_end":
      {
        const streamingChanged = finalizeAllStreamingTranscriptEntries(history, "completed");
        const toolChanged = finalizeToolTranscriptEntries(history, event, "not_executed");
        return { transcript: history, changed: streamingChanged || toolChanged };
      }

    case "reset":
      return { transcript: [], changed: true };

    default:
      return { transcript: history, changed: false };
  }
}

function eventMeta(event: TranscriptAgentEvent, entry: TranscriptEntry): TranscriptEntry {
  const timing = normalizeTranscriptTiming(event);
  const out: TranscriptEntry = {
    ...entry,
    timestamp: entry.timestamp || timing.timestamp || nowBeijingDateTime(),
  };
  for (const key of ["spanId", "parentSpanId", "streamTraceId", "provider", "model"] as const) {
    if (event[key] != null && event[key] !== "") out[key] = event[key];
  }
  if (event.eventSeq != null) out.eventSeq = event.eventSeq;
  const runId = eventRunId(event);
  if (runId) out.runId = runId;
  const clientMessageId = normalizeClientMessageId(event.clientMessageId || record(event.message).clientMessageId);
  if (clientMessageId) out.clientMessageId = clientMessageId;
  const deliveryStatus = normalizeDeliveryStatus(event.deliveryStatus);
  if (deliveryStatus) out.deliveryStatus = deliveryStatus;
  if (entry.endedAt || timing.endedAt) out.endedAt = entry.endedAt || timing.endedAt;
  return out;
}

function eventEndTime(event: TranscriptAgentEvent = {}) {
  const timing = normalizeTranscriptTiming(event);
  return timing.endedAt || timing.timestamp || nowBeijingDateTime();
}

function upsertTranscriptEntry(history: TranscriptEntry[], type: string, entry: TranscriptEntry, mode: "update" | "streaming" | "final" = "update") {
  const idx = findTranscriptEntryIndex(history, type, entry);
  const existing = idx >= 0 ? history[idx] : null;
  const next: TranscriptEntry = {
    ...existing,
    ...entry,
    eventSeq: existing?.eventSeq ?? entry.eventSeq,
    timestamp: existing?.timestamp || entry.timestamp || nowBeijingDateTime(),
  };
  if (mode === "streaming") next.streaming = true;
  if (mode === "final") {
    next.endedAt = entry.endedAt || existing?.endedAt || nowBeijingDateTime();
    delete next.streaming;
  }
  if (idx >= 0) history[idx] = next;
  else if (mode !== "final" || hasTranscriptContent(next)) insertTranscriptEntryByEventSeq(history, next);
}

function findTranscriptEntryIndex(history: readonly TranscriptEntry[], type: string, entry: Omit<EntryFields, "message" | "status"> = {}) {
  if (type === "user" && entry?.clientMessageId) {
    const idx = findLastIndex(history, item => (
      item?.type === "user"
      && item.clientMessageId === entry.clientMessageId
    ));
    return idx >= 0 ? idx : -1;
  }
  if (entry?.toolCallId) {
    const idx = findLastIndex(history, item => sameTranscriptScopedId(item, type, entry, "toolCallId"));
    return idx >= 0 ? idx : -1;
  }
  if (entry?.waitId) {
    const idx = findLastIndex(history, item => sameTranscriptScopedId(item, type, entry, "waitId"));
    return idx >= 0 ? idx : -1;
  }
  if (type === "compact" && entry?.compactId) {
    const idx = findLastIndex(history, item => sameTranscriptScopedId(item, type, entry, "compactId"));
    return idx >= 0 ? idx : -1;
  }
  if (entry?.spanId) {
    const idx = findLastIndex(history, item => (
      item?.type === type
      && item.spanId === entry.spanId
      && (!entry.runId || item.runId === entry.runId)
    ));
    return idx >= 0 ? idx : -1;
  }
  if (type === "user") {
    const idx = findLastIndex(history, item => (
      item?.type === "user"
      && item.text === entry.text
      && sameTranscriptImagesLoose(item.images || [], entry.images || [])
    ));
    if (idx >= 0) return idx;
  }
  if (type === "tool") return -1;
  return findLastIndex(history, item => item?.type === type && item.streaming);
}

function sameTranscriptScopedId(item: TranscriptEntry, type: string, entry: Omit<EntryFields, "message" | "status">, idField: "toolCallId" | "waitId" | "compactId") {
  if (!item || item.type !== type || !entry?.[idField]) return false;
  if (item[idField] !== entry[idField]) return false;
  return entry.runId ? item.runId === entry.runId : true;
}

function sameTranscriptImagesLoose(a: readonly TranscriptImage[] = [], b: readonly TranscriptImage[] = []) {
  if (a.length !== b.length) return false;
  return a.every((image, index) => {
    const other = b[index];
    return (image.dataUrl || image.url || "") === (other?.dataUrl || other?.url || "");
  });
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T, index: number) => unknown) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}

function insertTranscriptEntryByEventSeq(history: TranscriptEntry[], entry: TranscriptEntry) {
  const seq = Number(entry?.eventSeq);
  const runId = String(entry?.runId || "");
  if (!Number.isFinite(seq) || !runId) {
    history.push(entry);
    return;
  }
  const idx = history.findIndex(item => {
    const itemSeq = Number(item?.eventSeq);
    return item?.runId === runId && Number.isFinite(itemSeq) && itemSeq > seq;
  });
  if (idx >= 0) history.splice(idx, 0, entry);
  else history.push(entry);
}

function upsertLocalUserEvidence(history: TranscriptEntry[], local: TranscriptEntry, localHistory: readonly TranscriptEntry[] = []) {
  const idx = findUserTranscriptIndex(history, local);
  if (idx >= 0) {
    history[idx] = {
      ...local,
      ...history[idx],
      clientMessageId: normalizeClientMessageId(local.clientMessageId) || history[idx].clientMessageId,
      deliveryStatus: normalizeDeliveryStatus(history[idx].deliveryStatus) || local.deliveryStatus,
      timestamp: history[idx].timestamp || local.timestamp,
    };
    return;
  }
  insertTranscriptEntryByLocalOrder(history, { ...local }, local, localHistory);
}

function upsertLocalToolEvidence(history: TranscriptEntry[], local: TranscriptEntry, localHistory: readonly TranscriptEntry[] = []) {
  const idx = findToolTranscriptIndex(history, local);
  if (idx < 0) {
    insertTranscriptEntryByLocalOrder(history, { ...local }, local, localHistory);
    return;
  }
  if (isFinalExecutedToolTranscript(history[idx])) return;
  history[idx] = mergeLocalToolEvidence(history[idx], local);
}

function insertTranscriptEntryByLocalOrder(history: TranscriptEntry[], entry: TranscriptEntry, local: TranscriptEntry, localHistory: readonly TranscriptEntry[] = []) {
  const localIndex = Array.isArray(localHistory) ? localHistory.indexOf(local) : -1;
  if (localIndex >= 0) {
    for (let index = localIndex - 1; index >= 0; index -= 1) {
      const anchorIndex = findSnapshotTranscriptIndex(history, localHistory[index]);
      if (anchorIndex >= 0) {
        history.splice(anchorIndex + 1, 0, entry);
        return;
      }
    }
    for (let index = localIndex + 1; index < localHistory.length; index += 1) {
      const anchorIndex = findSnapshotTranscriptIndex(history, localHistory[index]);
      if (anchorIndex >= 0) {
        history.splice(anchorIndex, 0, entry);
        return;
      }
    }
  }
  insertTranscriptEntryByEventSeq(history, entry);
}

function mergeLocalToolEvidence(snapshotEntry: TranscriptEntry, local: TranscriptEntry) {
  return {
    ...snapshotEntry,
    ...local,
    spanId: local.spanId || snapshotEntry.spanId,
    parentSpanId: local.parentSpanId || snapshotEntry.parentSpanId,
    runId: local.runId || snapshotEntry.runId,
    timestamp: snapshotEntry.timestamp || local.timestamp,
    eventSeq: snapshotEntry.eventSeq ?? local.eventSeq,
    args: toolArgsAreEmpty(local.args) ? (snapshotEntry.args ?? {}) : local.args,
    argsText: longerString(snapshotEntry.argsText, local.argsText),
    result: local.result ?? snapshotEntry.result ?? null,
    image: local.image ?? snapshotEntry.image ?? null,
    endedAt: local.endedAt || snapshotEntry.endedAt,
  };
}

function isProtectedLocalUser(entry: TranscriptEntry) {
  if (entry?.type !== "user") return false;
  if (!normalizeClientMessageId(entry.clientMessageId)) return false;
  const status = normalizeDeliveryStatus(entry.deliveryStatus) || "pending";
  return status === "pending" || status === "accepted" || status === "failed";
}

function isProtectedLocalTool(entry: TranscriptEntry) {
  return entry?.type === "tool" && (isUnfinishedToolTranscriptEntry(entry) || isInterruptedToolTranscript(entry));
}

function isFinalExecutedToolTranscript(entry: EntryFields = {}) {
  if (entry?.type !== "tool" || isUnfinishedToolTranscriptEntry(entry)) return false;
  if (entry.result == null || entry.result === "") return false;
  return !isInterruptedToolTranscript(entry);
}

const INTERRUPTED_TOOL_RESULT_CODES = new Set([
  "TOOL_NOT_EXECUTED",
  "TOOL_ABORTED",
  "TOOL_INTERRUPTED",
  "ABORTED",
]);

function isInterruptedToolTranscript(entry: EntryFields = {}) {
  const code = String(record(entry.result).code || "").toUpperCase();
  return entry.phase === "not_executed"
    || INTERRUPTED_TOOL_RESULT_CODES.has(code)
    || (record(entry.result).interrupted === true && (code === "" || INTERRUPTED_TOOL_RESULT_CODES.has(code)));
}

function findSnapshotTranscriptIndex(history: readonly TranscriptEntry[] = [], target: EntryFields = {}) {
  if (!target || typeof target !== "object") return -1;
  if (target.type === "user") return findUserTranscriptIndex(history, target);
  if (target.type === "tool") return findToolTranscriptIndex(history, target);
  if ((target.type === "assistant" || target.type === "thinking") && target.spanId) {
    return history.findIndex(entry => (
      entry?.type === target.type
      && entry.spanId === target.spanId
      && (!target.runId || !entry.runId || entry.runId === target.runId)
    ));
  }
  return -1;
}

function findToolTranscriptIndex(history: readonly TranscriptEntry[] = [], target: EntryFields = {}) {
  if (!target?.toolCallId) return -1;
  return history.findIndex(entry => (
    entry?.type === "tool"
    && entry.toolCallId === target.toolCallId
    && (!target.runId || !entry.runId || entry.runId === target.runId)
  ));
}

function findUserTranscriptIndex(history: readonly TranscriptEntry[] = [], target: EntryFields = {}) {
  const targetId = normalizeClientMessageId(target.clientMessageId);
  if (targetId) {
    const byId = history.findIndex(entry => entry?.type === "user" && entry.clientMessageId === targetId);
    if (byId >= 0) return byId;
  }
  return history.findIndex(entry => (
    entry?.type === "user"
    && entry.text === target.text
    && sameTranscriptImagesLoose(entry.images || [], target.images || [])
  ));
}

function longerString(a: unknown, b: unknown) {
  const left = typeof a === "string" ? a : "";
  const right = typeof b === "string" ? b : "";
  return right.length > left.length ? right : left;
}

function finalizeTranscriptEntry(history: TranscriptEntry[], type: string, spanId = "") {
  const idx = spanId
    ? findLastIndex(history, item => item?.type === type && item.spanId === spanId)
    : findLastIndex(history, item => item?.type === type && item.streaming);
  if (idx < 0) return false;
  history[idx] = {
    ...history[idx],
    endedAt: history[idx].endedAt || nowBeijingDateTime(),
  };
  delete history[idx].streaming;
  return true;
}

function finalizeAllStreamingTranscriptEntries(history: TranscriptEntry[], phase = "") {
  const endedAt = nowBeijingDateTime();
  let changed = false;
  for (const entry of history) {
    if (!entry?.streaming) continue;
    entry.endedAt = entry.endedAt || endedAt;
    delete entry.streaming;
    if (entry.type === "tool") {
      entry.isRunning = false;
      entry.argsGenerating = false;
      if (phase) entry.phase = phase;
      entry.argsState = normalizeToolArgsState(entry);
    }
    if (entry.type === "thinking" && (phase === "aborted" || phase === "error")) {
      entry.phase = phase;
    }
    if (entry.type === "compact") {
      if (phase === "aborted" || phase === "error") entry.status = phase;
    }
    changed = true;
  }
  return changed;
}

function finalizeToolTranscriptEntries(history: TranscriptEntry[], event: TranscriptAgentEvent, phase: string) {
  const runId = eventRunId(event);
  const endedAt = nowBeijingDateTime();
  let changed = false;
  for (const entry of history) {
    if (!isUnfinishedToolTranscriptEntry(entry)) continue;
    if (runId && entry.runId && entry.runId !== runId) continue;
    const hadIncompleteArgs = entry.argsIncomplete === true
      || entry.argsGenerating === true
      || entry.argsState === "generating"
      || entry.phase === "preparing";
    entry.isRunning = false;
    entry.argsIncomplete = false;
    entry.argsGenerating = false;
    entry.phase = phase;
    entry.argsState = phase === "interrupted" ? "aborted" : phase;
    entry.isError = true;
    entry.endedAt = entry.endedAt || endedAt;
    delete entry.streaming;
    if (entry.result == null || entry.result === "") {
      entry.result = phase === "not_executed"
        ? unexecutedToolResult(hadIncompleteArgs)
        : interruptedToolResult(phase, event);
    }
    changed = true;
  }
  return changed;
}

function isUnfinishedToolTranscriptEntry(entry: EntryFields) {
  return entry?.type === "tool"
    && Boolean(
      entry.isRunning
      || entry.argsIncomplete
      || entry.argsGenerating
      || entry.streaming
      || entry.argsState === "generating"
      || entry.argsState === "ready"
      || entry.argsState === "executing"
      || entry.phase === "preparing"
      || entry.phase === "running"
    );
}

function interruptedToolResult(phase: string, event: TranscriptAgentEvent = {}) {
  if (phase === "error") {
    return {
      error: event.message || t("session.failedToolIncomplete"),
      code: "TOOL_INTERRUPTED",
      interrupted: true,
    };
  }
  if (phase === "interrupted") {
    return {
      error: t("session.interruptedToolIncomplete"),
      code: "TOOL_INTERRUPTED",
      interrupted: true,
    };
  }
  return {
    error: t("toolError.TOOL_ABORTED.message"),
    code: "TOOL_ABORTED",
    interrupted: true,
  };
}

function unexecutedToolResult(hadIncompleteArgs = false) {
  return {
    error: hadIncompleteArgs
      ? t("session.argumentsIncomplete")
      : t("session.toolNeverRan"),
    code: "TOOL_NOT_EXECUTED",
    interrupted: true,
  };
}

function terminalToolPhaseFromRuntimeStatus(event: TranscriptAgentEvent = {}) {
  const status = normalizeSessionRuntimeStatus(event.status || event.runtime?.status);
  if (status === SESSION_RUNTIME_STATUS.ABORTED || status === SESSION_RUNTIME_STATUS.CANCELLED) return "aborted";
  if (status === SESSION_RUNTIME_STATUS.ERROR) return "error";
  if (status === SESSION_RUNTIME_STATUS.INTERRUPTED) return "interrupted";
  if (status === SESSION_RUNTIME_STATUS.COMPLETED) return "not_executed";
  return "";
}

function upsertRunStatusTranscriptEntry(history: TranscriptEntry[], event: TranscriptAgentEvent = {}, status = "") {
  const normalizedStatus = normalizeRunStatus(status || event.status || event.runtime?.status);
  if (!normalizedStatus) return false;
  const runId = eventRunId(event);
  const idx = runId
    ? findLastIndex(history, entry => entry?.type === "run-status" && entry.runId === runId)
    : findLastIndex(history, entry => entry?.type === "run-status" && !entry.runId && entry.status === normalizedStatus);
  const next = eventMeta(event, {
    type: "run-status",
    status: normalizedStatus,
    reason: normalizeRunStatusReason(event.reason || event.runtime?.reason),
    text: runStatusText(normalizedStatus),
  });
  if (idx >= 0) {
    const existing = history[idx] || {};
    const merged = {
      ...existing,
      ...next,
      timestamp: existing.timestamp || next.timestamp,
      endedAt: next.endedAt || existing.endedAt || next.timestamp,
    };
    if (JSON.stringify(existing) === JSON.stringify(merged)) return false;
    history[idx] = merged;
    return true;
  }
  history.push({ ...next, endedAt: next.endedAt || next.timestamp });
  return true;
}

function normalizeRunStatus(status: unknown = "") {
  const value = String(status || "").trim().toLowerCase();
  if (["aborted", "cancelled", "canceled"].includes(value)) return "aborted";
  if (["error", "completed"].includes(value)) return value;
  return "";
}

function normalizeThinkingPhase(phase: unknown = "") {
  const value = String(phase || "").trim().toLowerCase();
  if (["aborted", "cancelled", "canceled"].includes(value)) return "aborted";
  if (value === "error") return "error";
  return "";
}

function normalizeRunStatusReason(reason: unknown = "") {
  return String(reason || "").trim().slice(0, 120);
}

function runStatusText(status: unknown = "") {
  if (status === "aborted") return t("status.cancelled");
  if (status === "error") return t("status.runFailed");
  if (status === "completed") return t("status.completed");
  return t("status.updated");
}

function resolveWaitTranscriptEntry(history: TranscriptEntry[], event: TranscriptAgentEvent) {
  const waitId = String(event.waitId || "").trim();
  const runId = eventRunId(event);
  const idx = waitId
    ? findLastIndex(history, item => (
        item?.type === "wait"
        && item.waitId === waitId
        && (!runId || item.runId === runId)
      ))
    : findLastIndex(history, item => item?.type === "wait" && item.status === "waiting");
  if (idx < 0) return false;
  history[idx] = {
    ...history[idx],
    status: waitStatusFromReason(event.reason),
    reason: event.reason || "",
    endedAt: nowBeijingDateTime(),
  };
  return true;
}

function eventRunId(event: TranscriptAgentEvent = {}) {
  return String(event?.runId || event?.runtime?.runId || "").trim();
}

function waitStatusFromReason(reason: unknown = "") {
  const value = String(reason || "").trim();
  if (["cancelled", "aborted", "superseded", "stale"].includes(value)) return value;
  return "resolved";
}

function normalizeEventToolCallId(event: TranscriptAgentEvent) {
  return String(event.toolCallId || event.tool_call_id || event.toolCall?.id || "").trim();
}

const TOOL_ARGS_STATES = new Set([
  "generating",
  "ready",
  "executing",
  "final",
  "final_empty",
  "aborted",
  "error",
  "not_executed",
]);

function toolArgsTextFromEvent(event: TranscriptAgentEvent = {}) {
  if (typeof event.argsText === "string") return event.argsText;
  if (typeof event.arguments === "string") return event.arguments;
  return "";
}

function toolArgsAreEmpty(args: unknown) {
  if (args == null) return true;
  if (typeof args === "string") return args.trim().length === 0;
  if (Array.isArray(args)) return args.length === 0;
  if (typeof args === "object") return Object.keys(args).length === 0;
  return false;
}

function finalToolArgsState(args: unknown) {
  return toolArgsAreEmpty(args) ? "final_empty" : "final";
}

function normalizeToolArgsState(input: unknown = {}) {
  const event = record(input);
  const explicit = typeof event.argsState === "string" ? event.argsState : "";
  if (TOOL_ARGS_STATES.has(explicit)) return explicit;
  const phase = typeof event.phase === "string" ? event.phase : "";
  if (["aborted", "cancelled", "interrupted", "superseded", "stale"].includes(phase)) return "aborted";
  if (phase === "error") return "error";
  if (phase === "not_executed") return "not_executed";
  if (event.argsGenerating === true || event.argsIncomplete === true || phase === "preparing") return "generating";
  if (phase === "running") return "executing";
  if (phase === "done" || phase === "completed" || event.isRunning === false) return finalToolArgsState(event.args);
  return "";
}

function hasTranscriptContent(entry: EntryFields) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.type === "thinking") return String(entry.text || "").length > 0;
  if (entry.type === "assistant") return String(entry.content || "").length > 0;
  if (entry.type === "tool") return Boolean(entry.toolCallId || entry.name || entry.result != null);
  if (entry.type === "wait") return Boolean(entry.waitId || entry.message || entry.form);
  if (entry.type === "user") return Boolean(entry.text || entry.images?.length || entry.documents?.length);
  if (entry.type === "compact") return Boolean(entry.compactId || entry.summary || entry.status);
  if (entry.type === "run-status") return Boolean(entry.status || entry.text);
  if (entry.type === "note" || entry.type === "error") return Boolean(entry.text);
  return true;
}

export function createSessionTitle(text: unknown) {
  return cleanTitleText(text) || t("session.new");
}

function cleanTitleText(text: unknown) {
  const title = String(text ?? "")
    .replace(/\n\n\[当前浏览器标签页\][\s\S]*$/u, "")
    .replace(/\n\n\[当前页面\][\s\S]*$/u, "")
    .replace(/\s*\[当前浏览器标签页\][\s\S]*$/u, "")
    .replace(/\s*\[当前页面\][\s\S]*$/u, "")
    .replace(/\s*\[[0-9]{5,}\]\s*$/u, "")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (title.length <= SESSION_TITLE_MAX_LENGTH) return title;

  let end = 0;
  for (const { index, segment } of new Intl.Segmenter("en", { granularity: "word" }).segment(title)) {
    if (index + segment.length > SESSION_TITLE_MAX_LENGTH) break;
    end = index + segment.length;
  }
  // An oversized single word still needs a bound, without splitting a Unicode character.
  if (end === 0) {
    for (const { index, segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(title)) {
      if (index + segment.length > SESSION_TITLE_MAX_LENGTH) break;
      end = index + segment.length;
    }
  }
  return title.slice(0, end).trimEnd();
}

export function normalizeConversationSnapshot(input: unknown): Conversation {
  const conversation = record(input);
  assertConversationReadable(input);
  if (conversation?.type === "conversation" && Array.isArray(conversation.entries)) {
    return {
      type: "conversation",
      version: CURRENT_SESSION_VERSION,
      entries: conversation.entries
        .map((raw, index): ConversationEntry | null => {
          const entry = record(raw);
          const msg = normalizeMessage(entry.message);
          if (!msg) return null;
          const parentId =
            typeof entry.parentId === "string" || entry.parentId === null
              ? entry.parentId
              : index > 0 ? genEntryId(index - 1) : null;
          return {
            type: "message",
            id: typeof entry.id === "string" ? entry.id : genEntryId(index),
            parentId,
            timestamp: isBeijingDateTime(entry.timestamp) ? entry.timestamp : nowBeijingDateTime(),
            message: msg,
          };
        })
        .filter((entry): entry is ConversationEntry => entry !== null),
    };
  }
  return serializeConversation(readEntries(input).map(entry => entry.message ?? entry));
}

function normalizeTranscript(transcript: unknown): TranscriptEntry[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.map(normalizeTranscriptEvent).filter((entry): entry is TranscriptEntry => entry !== null);
}

function normalizeTranscriptEvent(input: unknown): TranscriptEntry | null {
  const event = record(input);
  if (typeof event.type !== "string") return null;
  const timing = normalizeTranscriptTiming(event);
  const meta = normalizeTranscriptMeta(event);

  if (event.type === "user") {
    const text = String(event.text ?? "");
    const images = normalizeTranscriptImages(event.images);
    const documents = normalizeMessageDocuments(event.documents);
    return text || images.length || documents.length
      ? { type: "user", text, images, documents, ...meta, ...timing }
      : null;
  }

  if (event.type === "thinking") {
    const text = String(event.text ?? "");
    const phase = normalizeThinkingPhase(event.phase || event.status);
    return text ? { type: "thinking", text, ...(phase ? { phase } : {}), ...meta, ...timing } : null;
  }

  if (event.type === "assistant") {
    const content = String(event.content ?? "");
    return content ? { type: "assistant", content, ...meta, ...timing } : null;
  }

  if (event.type === "compact") {
    return {
      type: "compact",
      compactId: String(event.compactId || ""),
      status: normalizeCompactStatus(event.status),
      summary: String(event.summary || ""),
      inputTokensBefore: finiteNumber(event.inputTokensBefore),
      inputTokensAfter: finiteNumber(event.inputTokensAfter),
      contextWindow: finiteNumber(event.contextWindow),
      threshold: finiteNumber(event.threshold),
      sourceMessageCount: finiteNumber(event.sourceMessageCount),
      retainedMessageCount: finiteNumber(event.retainedMessageCount),
      ...meta,
      ...timing,
    };
  }

  if (event.type === "tool") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    const args = cloneJson(event.args ?? {});
    const argsText = typeof event.argsText === "string" ? event.argsText : "";
    const argsIncomplete = event.argsIncomplete === true;
    const phase = typeof event.phase === "string" ? event.phase : "";
    const isRunning = !!event.isRunning;
    const argsState = normalizeToolArgsState({
      args,
      argsIncomplete,
      argsGenerating: event.argsGenerating === true,
      argsState: event.argsState,
      phase,
      isRunning,
    });
    return {
      type: "tool",
      ...(toolCallId ? { toolCallId } : {}),
      name: String(event.name ?? "tool"),
      ...toolIdentityMetaFromEvent(event),
      args,
      argsText,
      argsIncomplete,
      argsGenerating: argsState === "generating",
      argsState,
      phase,
      statusText: typeof event.statusText === "string" ? event.statusText : "",
      rateLimit: event.rateLimit == null ? null : cloneJsonValue(event.rateLimit),
      result: event.result == null ? null : cloneJsonValue(event.result),
      isError: !!event.isError,
      isRunning,
      image: typeof event.image === "string" ? event.image : null,
      ...meta,
      ...timing,
    };
  }

  if (event.type === "wait") {
    const waitId = typeof event.waitId === "string" ? event.waitId : "";
    const message = String(event.message ?? "");
    const form = event.form == null ? null : cloneJsonValue(event.form);
    if (!waitId && !message && !form) return null;
    return {
      type: "wait",
      ...(waitId ? { waitId } : {}),
      title: String(event.title ?? ""),
      message,
      form,
      status: String(event.status || "waiting"),
      reason: String(event.reason || ""),
      ...meta,
      ...timing,
    };
  }

  if (event.type === "note" || event.type === "error") {
    const text = String(event.text ?? "");
    return text ? { type: event.type, text, ...meta, ...timing } : null;
  }

  if (event.type === "run-status") {
    const status = normalizeRunStatus(event.status);
    if (!status) return null;
    const text = String(event.text || runStatusText(status));
    return {
      type: "run-status",
      status,
      reason: normalizeRunStatusReason(event.reason),
      text,
      ...meta,
      ...timing,
    };
  }

  return null;
}

function normalizeTranscriptMeta(event: Record<string, unknown>): TranscriptMeta {
  const meta: TranscriptMeta = {};
  for (const key of ["spanId", "parentSpanId", "runId", "provider", "model"] as const) {
    if (typeof event[key] === "string" && event[key]) meta[key] = event[key];
  }
  const clientMessageId = normalizeClientMessageId(event.clientMessageId);
  if (clientMessageId) meta.clientMessageId = clientMessageId;
  const deliveryStatus = normalizeDeliveryStatus(event.deliveryStatus);
  if (deliveryStatus) meta.deliveryStatus = deliveryStatus;
  if (Number.isFinite(Number(event.eventSeq))) meta.eventSeq = Number(event.eventSeq);
  return meta;
}

function normalizeCompactMeta(input: unknown): CompactMeta {
  if (!input || typeof input !== "object") return {};
  const meta = record(input);
  const out: CompactMeta = {};
  const id = typeof meta.id === "string" && meta.id
    ? meta.id
    : (typeof meta.compactId === "string" && meta.compactId ? meta.compactId : "");
  if (id) {
    out.id = id;
    out.compactId = id;
  }
  if (typeof meta.status === "string" && meta.status) out.status = normalizeCompactStatus(meta.status);
  for (const key of [
    "sourceMessageCount",
    "retainedMessageCount",
    "inputTokensBefore",
    "inputTokensAfter",
    "contextWindow",
    "threshold",
    "keepBudget",
    "sourceStartIndex",
    "sourceEndIndex",
  ] as const) {
    const value = finiteNumber(meta[key]);
    if (value) out[key] = value;
  }
  if (isBeijingDateTime(meta.createdAt)) out.timestamp = meta.createdAt;
  return out;
}

function normalizeCompactStatus(status: unknown = "") {
  const value = String(status || "").trim().toLowerCase();
  if (["running", "done", "failed", "aborted", "error"].includes(value)) return value;
  return "done";
}

function finiteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function compactSummaryText(content: unknown = "") {
  return contentToText(content).replace(/^\[之前的对话摘要\]\s*/u, "").trim();
}

function normalizeClientMessageId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

function normalizeDeliveryStatus(value: unknown) {
  const status = String(value || "").trim();
  return ["pending", "accepted", "committed", "failed"].includes(status) ? status : "";
}

function normalizeTranscriptTiming(event: { timestamp?: unknown; endedAt?: unknown }): Pick<TranscriptMeta, "timestamp" | "endedAt"> {
  const timing: Pick<TranscriptMeta, "timestamp" | "endedAt"> = {};
  if (isBeijingDateTime(event.timestamp)) {
    timing.timestamp = event.timestamp;
  }
  if (isBeijingDateTime(event.endedAt)) {
    timing.endedAt = event.endedAt;
  }
  return timing;
}

function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch(_e) {
    return {};
  }
}

function cloneJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch(_e) {
    return String(value);
  }
}

function normalizeTranscriptImages(images: unknown): TranscriptImage[] {
  if (!Array.isArray(images)) return [];
  return images
    .map((input): TranscriptImage | null => {
      const image = typeof input === "string" ? input : record(input);
      if (typeof image === "string") return { dataUrl: image, name: "image", type: "" };
      if (!image || typeof image !== "object") return null;
      const dataUrl = image.dataUrl || image.url;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
      return {
        dataUrl,
        name: String(image.name || "image"),
        type: String(image.type || ""),
        size: typeof image.size === "number" && Number.isFinite(image.size) ? image.size : null,
      };
    })
    .filter((image): image is TranscriptImage => image !== null);
}

function repairTranscriptToolResults(transcript: TranscriptEntry[], conversation: Conversation | null) {
  const toolContents: string[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  for (const entry of conversation?.entries || []) {
    const msg = entry?.message;
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        toolCalls.push({
          name: toolCall?.function?.name,
          args: parseToolArguments(toolCall?.function?.arguments),
        });
      }
    }
    if (msg?.role === "tool" && typeof msg.content === "string") {
      toolContents.push(msg.content);
    }
  }
  if (toolContents.length === 0 && toolCalls.length === 0) return transcript;

  let toolIndex = 0;
  let callIndex = 0;
  return transcript.map((event) => {
    if (event?.type !== "tool") return event;
    let repaired = event;

    const fallbackCall = toolCalls[callIndex++];
    if (fallbackCall && shouldUseFallbackToolArgs(event.args, fallbackCall.args)) {
      repaired = {
        ...repaired,
        name: repaired.name || fallbackCall.name || "tool",
        args: fallbackCall.args,
      };
    }

    const fallback = toolContents[toolIndex++];
    if (fallback && shouldUseFallbackToolResult(repaired.result, fallback)) {
      repaired = { ...repaired, result: fallback };
    }
    return repaired;
  });
}

function shouldUseFallbackToolArgs(current: unknown, fallback: unknown) {
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return false;
  if (Object.keys(fallback).length === 0) return false;
  return !current || typeof current !== "object" || Array.isArray(current) || Object.keys(current).length === 0;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch(_e) {
    return {};
  }
}

function shouldUseFallbackToolResult(current: unknown, fallback: string) {
  if (current == null || current === "") return true;
  if (typeof current !== "string") return false;
  if (current.includes("[truncated")) return false;
  if (isLikelyIncompleteJson(current) && !isLikelyIncompleteJson(fallback)) return true;
  return fallback.length > current.length && current.length < 2000;
}

function isLikelyIncompleteJson(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^[\[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return false;
  } catch(_e) {
    return true;
  }
}

function readEntries(input: unknown): Record<string, unknown>[] {
  const saved = record(input);
  assertConversationReadable(input);
  if (!saved) return [];
  if (Array.isArray(input)) {
    return input.map((message, index) => ({
      type: "message",
      id: genEntryId(index),
      parentId: index > 0 ? genEntryId(index - 1) : null,
      message,
    }));
  }
  if (Array.isArray(saved.entries)) return saved.entries;
  if (Array.isArray(saved.messages)) {
    return saved.messages.map((message, index) => ({
      type: "message",
      id: genEntryId(index),
      parentId: index > 0 ? genEntryId(index - 1) : null,
      message,
    }));
  }
  return [];
}

function normalizeMessage(input: unknown): SessionMessage | null {
  const msg = record(input);
  if (typeof msg.role !== "string") return null;

  if (msg.role === "system") {
    return { role: "system", content: contentToText(msg.content) };
  }

  if (msg.role === "user") {
    const out: SessionMessage = { role: "user", content: normalizeContent(msg.content) };
    if (typeof msg._origin === "string" && USER_MESSAGE_ORIGINS.has(msg._origin)) out._origin = msg._origin;
    if (typeof msg._kind === "string" && USER_MESSAGE_KINDS.has(msg._kind)) out._kind = msg._kind;
    if (msg._compact && typeof msg._compact === "object") out._compact = normalizeCompactMeta(msg._compact);
    if (msg._contextCapsule && typeof msg._contextCapsule === "object") {
      out._contextCapsule = normalizeContextCapsuleMeta(msg._contextCapsule);
    }
    if (msg._contextEvent && typeof msg._contextEvent === "object") {
      out._contextEvent = normalizeContextEventMeta(msg._contextEvent);
    }
    const clientMessageId = normalizeClientMessageId(msg.clientMessageId);
    if (clientMessageId) out.clientMessageId = clientMessageId;
    const documents = normalizeMessageDocuments(msg.documents);
    if (documents.length) out.documents = documents;
    if (typeof msg.trim === "boolean") out.trim = msg.trim;
    return out;
  }

  if (msg.role === "assistant") {
    const out: SessionMessage = {
      role: "assistant",
      content: typeof msg.content === "string" && msg.content.length > 0 ? msg.content : null,
    };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      out.tool_calls = msg.tool_calls
        .map(normalizeToolCall)
        .filter((call): call is ModelToolCall => call !== null);
    }
    const usage = normalizeProviderUsage(msg._usage);
    if (usage) out._usage = usage;
    const providerState = normalizeProviderState(msg._providerState);
    if (providerState) out._providerState = providerState;
    const usageContextBoundaryId = normalizeUsageContextMarker(msg._usageContextBoundaryId);
    if (usageContextBoundaryId) out._usageContextBoundaryId = usageContextBoundaryId;
    const usageContextFingerprint = normalizeUsageContextMarker(msg._usageContextFingerprint);
    if (usageContextFingerprint) out._usageContextFingerprint = usageContextFingerprint;
    if (typeof msg.trim === "boolean") out.trim = msg.trim;
    if (!out.content && !out.tool_calls?.length && !out._providerState) return null;
    return out;
  }

  if (msg.role === "tool") {
    const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    if (!toolCallId) return null;
    const out: SessionMessage = {
      role: "tool",
      tool_call_id: toolCallId,
      content: truncate(contentToText(msg.content), MAX_TOOL_RESULT_CHARS),
    };
    if (typeof msg.trim === "boolean") out.trim = msg.trim;
    return out;
  }

  return null;
}

function normalizeContextCapsuleMeta(input: unknown = {}): NonNullable<SessionMessage["_contextCapsule"]> {
  const meta = record(input);
  const out: NonNullable<SessionMessage["_contextCapsule"]> = {};
  const reason = String(meta.reason || "").trim();
  if (reason) out.reason = reason.slice(0, 80);
  const createdAt = isBeijingDateTime(meta.createdAt) ? meta.createdAt : "";
  if (createdAt) out.createdAt = createdAt;
  const signature = String(meta.signature || "").trim();
  if (signature) out.signature = signature.slice(0, 2000);
  return out;
}

function normalizeContextEventMeta(input: unknown = {}): NonNullable<SessionMessage["_contextEvent"]> {
  const meta = record(input);
  const out: NonNullable<SessionMessage["_contextEvent"]> = {};
  const kind = String(meta.kind || "").trim();
  if (kind) out.kind = kind.slice(0, 80);
  const toolName = String(meta.toolName || "").trim();
  if (toolName) out.toolName = toolName.slice(0, 160);
  const createdAt = isBeijingDateTime(meta.createdAt) ? meta.createdAt : "";
  if (createdAt) out.createdAt = createdAt;
  if (Array.isArray(meta.added)) out.added = meta.added.map(value => String(value || "").trim()).filter(Boolean).slice(0, 20);
  if (Array.isArray(meta.removed)) out.removed = meta.removed.map(value => String(value || "").trim()).filter(Boolean).slice(0, 20);
  return out;
}

function normalizeProviderState(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  return cloneJsonValue(state);
}

function normalizeContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part.type === "image_url") {
      const url = part.image_url?.url;
      if (typeof url === "string" && url) {
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: part.image_url?.detail || "auto",
          },
        });
      }
    }
  }

  if (parts.length === 0) return "";
  if (parts.every(part => part.type === "text")) {
    return parts.map(part => part.text).filter(Boolean).join("\n");
  }
  return parts;
}

function contentToText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part?.type === "text") return String(part.text ?? "");
    return "";
  }).filter(Boolean).join("\n");
}

function stripInlineImageFromToolResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result ?? null;
  const { _image, ...rest } = record(result);
  return Object.keys(rest).length ? rest : null;
}

function contentToImages(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(part => part?.type === "image_url" && typeof part.image_url?.url === "string")
    .map((part, index) => ({
      dataUrl: part.image_url.url,
      name: `image-${index + 1}`,
      type: "",
      size: null,
    }))
    .filter(image => image.dataUrl.startsWith("data:image/"));
}

function parseToolResult(value: unknown): unknown {
  const text = String(value ?? "");
  if (!text.trim()) return "";
  try {
    return JSON.parse(text);
  } catch(_e) {
    return text;
  }
}

function normalizeToolCall(input: unknown): ModelToolCall | null {
  if (!input || typeof input !== "object") return null;
  const tc = record(input);
  const fn = record(tc.function);
  if (!fn || typeof fn.name !== "string") return null;
  let args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
  if (!isJsonObjectString(args)) args = "{}";
  return {
    id: typeof tc.id === "string" && tc.id ? tc.id : `call_${Math.random().toString(36).slice(2, 10)}`,
    type: "function",
    function: {
      name: fn.name,
      arguments: args,
    },
  };
}

function normalizeProviderUsage(input: unknown): Record<string, number> | null {
  if (!input || typeof input !== "object") return null;
  const usage = record(input);
  const out: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_prompt_tokens",
    "total_completion_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cached_tokens",
  ]) {
    const value = finiteUsageNumber(usage[key]);
    if (value != null) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeUsageContextMarker(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 180) : "";
}

function finiteUsageNumber(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.ceil(number);
}

function isJsonObjectString(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch(_e) {
    return false;
  }
}

function isDuplicateTerminalError(history: readonly TranscriptEntry[], message: unknown = "") {
  const text = normalizeFailureText(message);
  if (!text) return false;
  const last = [...history].reverse().find((entry) => entry?.type !== "thinking");
  if (!last || last.type !== "assistant") return false;
  return normalizeFailureText(last.content) === text;
}

function normalizeFailureText(value: unknown = "") {
  const text = String(value || "")
    .replace(/^❌\s*/u, "")
    .trim();
  if (!/(?:LLM\s*(?:调用失败|响应超时|流式响应中断|API\s*\d+)|Model (?:request failed|response timed out|stream interrupted))/i.test(text)) return "";
  return text.replace(/\s+/gu, " ");
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

function genEntryId(index: number) {
  return `m_${String(index + 1).padStart(6, "0")}`;
}

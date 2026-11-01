import { t as promptT } from "./prompts/messages.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { normalizeMessageDocuments } from "../../shared/documents/document-attachments.js";
import { isHiddenContextUserMessage } from "../../shared/message-blocks.js";
import {
  contextTokensFromUsage,
  estimateTokens,
} from "../llm/token-accounting.js";

export {
  contextTokensFromUsage,
  estimateToolSchemaTokens,
  estimateTokens,
} from "../llm/token-accounting.js";

import type { ModelMessage } from '../../shared/contracts/model-message.js';
interface EstimateOptions {boundaryId?: unknown; toolSchemas?: object[]; contextKey?: string}
interface Fingerprint {first: number; second: number; length: number}
interface PlanFields {
  reason?: string; threshold: number; inputTokens: number; boundary?: number; minIndex?: number; cutIndex?: number;
  keepBudget?: number; retainedTokens?: number; sourceMessages?: ModelMessage[]; retainedMessages?: ModelMessage[];
  sourceMessageCount?: number; retainedMessageCount?: number;
}
export type CompactionPlan = PlanFields & ({shouldCompact: false} | {shouldCompact: true; cutIndex: number; sourceMessages: ModelMessage[]; retainedMessages: ModelMessage[]; sourceMessageCount: number; retainedMessageCount: number});
interface PlanInput {messages?: ModelMessage[]; messageTokens?: number[]; inputTokens?: number; contextWindow?: number; reserveTokens?: number; maxKeepTokens?: number; force?: boolean; retainLatestRound?: boolean}
interface Cut {cutIndex: number; retainedTokens: number; reason: string}

export const COMPACT_MESSAGE_KIND = "compaction";
export const COMPACT_MESSAGE_ORIGIN = "compaction";
export const DEFAULT_CONTEXT_RESERVE_TOKENS = 16000;
export const DEFAULT_KEEP_RECENT_TOKENS = 40000;
export const MIN_KEEP_RECENT_TOKENS = 4000;
export const COMPACT_TARGET_RATIO = 0.55;
export const ROOT_CONTEXT_BOUNDARY_ID = "root";

export function normalizeContextBoundaryId(value: unknown = "") {
  const id = String(value || "").trim();
  return id || ROOT_CONTEXT_BOUNDARY_ID;
}

function inspectAssistantUsage(messages: ModelMessage[], {
  boundaryId = ROOT_CONTEXT_BOUNDARY_ID,
  toolSchemas = [],
  contextKey = "",
}: EstimateOptions = {}) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const expectedBoundary = normalizeContextBoundaryId(boundaryId);
  const fingerprint = createFingerprintState(toolSchemas, contextKey);
  let usageInfo: {index: number; usage: ModelMessage["_usage"]; tokens: number} | null = null;
  for (let index = 0; index < normalizedMessages.length; index += 1) {
    const msg = normalizedMessages[index];
    if (msg?.role === "assistant"
      && !["aborted", "error"].includes(String(msg._stopReason || "").toLowerCase())
      && normalizeContextBoundaryId(msg._usageContextBoundaryId) === expectedBoundary
      && String(msg._usageContextFingerprint || "") === finishFingerprint(fingerprint)) {
      const tokens = contextTokensFromUsage(msg._usage);
      if (tokens > 0) usageInfo = { index, usage: msg._usage, tokens };
    }
    appendFingerprintMessage(fingerprint, msg);
  }
  return { usageInfo, requestFingerprint: finishFingerprint(fingerprint) };
}

export function estimateContextTokens(messages: ModelMessage[], {
  boundaryId = ROOT_CONTEXT_BOUNDARY_ID,
  toolSchemas = [],
  contextKey = "",
}: EstimateOptions = {}) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const { usageInfo, requestFingerprint } = inspectAssistantUsage(normalizedMessages, { boundaryId, toolSchemas, contextKey });
  if (!usageInfo) {
    const tokens = estimateTokens(normalizedMessages);
    return {
      source: "estimate",
      tokens,
      usageTokens: 0,
      trailingTokens: tokens,
      lastUsageIndex: -1,
      messageCount: normalizedMessages.length,
      requestFingerprint,
    };
  }

  const trailingMessages = normalizedMessages.slice(usageInfo.index + 1);
  const trailingTokens = estimateTokens(trailingMessages);
  return {
    source: "usage_anchor",
    tokens: usageInfo.tokens + trailingTokens,
    usageTokens: usageInfo.tokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
    messageCount: normalizedMessages.length,
    requestFingerprint,
  };
}

function createFingerprintState(toolSchemas: object[], contextKey: string) {
  const state = { first: 2166136261, second: 2246822519, length: 0 };
  appendFingerprintText(state, String(contextKey || ""));
  appendFingerprintText(state, safeJson(toolSchemas));
  return state;
}

function appendFingerprintMessage(state: Fingerprint, message: ModelMessage) {
  if (!message || typeof message !== "object") return;
  appendFingerprintText(state, safeJson({
    role: message.role,
    content: message.content,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
    ...(message._providerState && typeof message._providerState === "object"
      ? { _providerState: message._providerState }
      : {}),
  }));
}

function appendFingerprintText(state: Fingerprint, value: unknown) {
  const text = String(value || "");
  state.length += text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    state.first = Math.imul(state.first ^ code, 16777619) >>> 0;
    state.second = Math.imul(state.second ^ code, 3266489917) >>> 0;
  }
  state.first = Math.imul(state.first ^ 31, 16777619) >>> 0;
  state.second = Math.imul(state.second ^ 127, 3266489917) >>> 0;
}

function finishFingerprint(state: Fingerprint) {
  return `ctx_${state.length.toString(36)}_${state.first.toString(36)}${state.second.toString(36)}`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) || "";
  } catch (_err) {
    return "[unserializable]";
  }
}

export function compactThreshold(contextWindow: unknown, reserveTokens = DEFAULT_CONTEXT_RESERVE_TOKENS) {
  const window = Math.max(1, Number(contextWindow) || 0);
  const reserve = Math.max(0, Number(reserveTokens) || 0);
  return Math.max(1, window - reserve);
}

export function compactKeepRecentBudget({
  contextWindow,
  reserveTokens = DEFAULT_CONTEXT_RESERVE_TOKENS,
  maxKeepTokens = DEFAULT_KEEP_RECENT_TOKENS,
  minKeepTokens = MIN_KEEP_RECENT_TOKENS,
  targetRatio = COMPACT_TARGET_RATIO,
}: {contextWindow?: number; reserveTokens?: number; maxKeepTokens?: number; minKeepTokens?: number; targetRatio?: number} = {}) {
  const threshold = compactThreshold(contextWindow, reserveTokens);
  const adaptive = Math.floor(threshold * targetRatio);
  return Math.max(
    Math.max(1, Number(minKeepTokens) || 1),
    Math.min(Math.max(1, Number(maxKeepTokens) || DEFAULT_KEEP_RECENT_TOKENS), adaptive),
  );
}

export function isCompactMessage(msg: ModelMessage | null | undefined) {
  return Boolean(msg && msg._kind === COMPACT_MESSAGE_KIND);
}

export function latestCompactIndex(messages: ModelMessage[] = []) {
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    if (isCompactMessage(messages[i])) return i;
  }
  return -1;
}

export function buildCompactionPlan({
  messages = [],
  messageTokens = [],
  inputTokens = 0,
  contextWindow = 0,
  reserveTokens = DEFAULT_CONTEXT_RESERVE_TOKENS,
  maxKeepTokens = DEFAULT_KEEP_RECENT_TOKENS,
  force = false,
  retainLatestRound = false,
}: PlanInput = {}): CompactionPlan {
  const threshold = compactThreshold(contextWindow, reserveTokens);
  const estimatedInputTokens = Math.max(0, Number(inputTokens) || 0);
  if (!force && estimatedInputTokens < threshold) {
    return { shouldCompact: false, reason: "below_threshold", threshold, inputTokens: estimatedInputTokens };
  }

  const boundary = latestCompactIndex(messages);
  const minIndex = Math.max(1, boundary + 1);
  const keepBudget = compactKeepRecentBudget({ contextWindow, reserveTokens, maxKeepTokens });
  const cut = chooseCompactionCut({
    messages,
    messageTokens,
    minIndex,
    keepBudget,
    threshold,
    retainLatestRound,
  });

  if (!cut) {
    return {
      shouldCompact: false,
      reason: "no_compactable_segment",
      threshold,
      inputTokens: estimatedInputTokens,
      boundary,
      minIndex,
      cutIndex: messages.length,
      keepBudget,
      retainedTokens: sumTokens(messageTokens, minIndex, messages.length),
    };
  }

  const sourceMessages = [
    ...(boundary >= 1 ? [messages[boundary]] : []),
    ...messages.slice(minIndex, cut.cutIndex),
  ]
    .filter(msg => !isHiddenContextUserMessage(msg));
  const retainedMessages = messages.slice(cut.cutIndex);
  return {
    shouldCompact: true,
    ...(cut.reason ? { reason: cut.reason } : {}),
    threshold,
    inputTokens: estimatedInputTokens,
    boundary,
    minIndex,
    cutIndex: cut.cutIndex,
    keepBudget,
    retainedTokens: cut.retainedTokens,
    sourceMessages,
    retainedMessages,
    sourceMessageCount: sourceMessages.length,
    retainedMessageCount: retainedMessages.length,
  };
}

export function isRoundStartMessage(msg: ModelMessage | null | undefined) {
  return msg?.role === "user" && (!msg._origin || msg._origin === "user" || msg._origin === COMPACT_MESSAGE_ORIGIN);
}

export function findFallbackCompactionCutIndex(messages: ModelMessage[] = [], minIndex = 1) {
  return chooseCompactionCut({ messages, messageTokens: [], minIndex, keepBudget: Infinity, threshold: Infinity })?.cutIndex ?? -1;
}

function chooseCompactionCut({
  messages = [],
  messageTokens = [],
  minIndex = 1,
  keepBudget = DEFAULT_KEEP_RECENT_TOKENS,
  threshold = 0,
  retainLatestRound = false,
}: {messages?: ModelMessage[]; messageTokens?: number[]; minIndex?: number; keepBudget?: number; threshold?: number; retainLatestRound?: boolean} = {}): Cut | null {
  const start = Math.max(1, Number(minIndex) || 1);
  let hasSource = false;
  let sourceHasTool = false;
  let sourceTokens = 0;
  let firstRoundFit = null;
  let latestRoundFit = null;
  let firstToolFit = null;
  let firstToolUnderBudget = null;
  for (let i = start + 1; i <= messages.length; i += 1) {
    const previous = messages[i - 1];
    hasSource = hasSource || isMeaningfulCompactionMessage(previous);
    sourceHasTool = sourceHasTool || isToolLikeMessage(previous);
    if (!isHiddenContextUserMessage(previous)) {
      sourceTokens += Math.max(0, Number(messageTokens[i - 1]) || 0);
    }
    if (!hasSource) continue;

    const next = messages[i];
    let reason = null;
    if (i === messages.length) reason = isClosedToolResultSuffix(messages.slice(start)) ? "closed_tool_chain" : null;
    else if (isRoundStartMessage(next)) reason = "";
    else if (sourceHasTool && next?.role === "assistant") reason = "fallback_structure_boundary";
    if (reason === null) continue;

    const retainedTokens = sumTokens(messageTokens, i, messages.length);
    const candidate = { cutIndex: i, retainedTokens, reason };
    const fitsWindow = retainedTokens + Math.min(sourceTokens, 1200) < threshold;
    if (reason === "") {
      if (fitsWindow) {
        if (!firstRoundFit) firstRoundFit = candidate;
        latestRoundFit = candidate;
      }
      if (!retainLatestRound && retainedTokens <= keepBudget) return candidate;
    } else {
      if (!firstToolFit && fitsWindow) firstToolFit = candidate;
      if (!firstToolUnderBudget && retainedTokens <= keepBudget) firstToolUnderBudget = candidate;
    }
  }
  return (retainLatestRound && latestRoundFit) || firstRoundFit || firstToolUnderBudget || firstToolFit;
}

function isMeaningfulCompactionMessage(msg: ModelMessage | undefined) {
  if (!msg || msg.role === "system") return false;
  if (isHiddenContextUserMessage(msg)) return false;
  if (isToolLikeMessage(msg)) return true;
  if (msg.role === "user") return !msg._origin || msg._origin === "user";
  return msg.role === "assistant" && String(msg.content || "").trim() !== "";
}

function isToolLikeMessage(msg: ModelMessage | undefined) {
  return msg?.role === "tool" || (msg?.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
}

function isClosedToolResultSuffix(messages: ModelMessage[] = []) {
  if (!Array.isArray(messages) || messages.length < 3) return false;
  const first = messages.find(isMeaningfulCompactionMessage);
  const last = messages[messages.length - 1];
  if (!isRoundStartMessage(first) && first?.role !== "assistant") return false;
  return last?.role === "tool" && messages.some(isToolLikeMessage);
}

export function sumTokens(tokens: number[] = [], startIndex = 0, endIndex = tokens.length) {
  let total = 0;
  const start = Math.max(0, Number(startIndex) || 0);
  const end = Math.min(tokens.length, Math.max(start, Number(endIndex) || 0));
  for (let i = start; i < end; i += 1) total += Math.max(0, Number(tokens[i]) || 0);
  return total;
}

export function serializeMessagesForCompaction(messages: ModelMessage[] = [], { currentGoal = "" } = {}) {
  const goal = String(currentGoal || "").trim();
  const parts = [];
  if (goal) parts.push(`[Current goal state]\n${goal.slice(0, 2000)}`);
  parts.push(...(Array.isArray(messages) ? messages : [])
    .map(serializeMessageForCompaction)
    .filter(Boolean));
  return parts.join("\n");
}

export function serializeMessageForCompaction(msg: ModelMessage) {
  if (!msg || typeof msg !== "object" || typeof msg.role !== "string") return "";
  if (isHiddenContextUserMessage(msg)) return "";
  if (isCompactMessage(msg)) return `[Previous checkpoint]: ${extractCompactSummary(msg.content)}`;
  if (msg.role === "user") {
    const text = typeof msg.content === "string" ? msg.content : contentToText(msg.content) || "[multimodal]";
    const documents = normalizeMessageDocuments(msg.documents)
      .map(item => `${item.filename} (docModelId=${item.docModelId}, fileId=${item.fileId}, format=${item.format || "unknown"})`);
    return `[User]: ${text.slice(0, 500)}${documents.length ? `\n[Documents]: ${documents.join("; ")}` : ""}`;
  }
  if (msg.role === "assistant") {
    const parts = [];
    if (msg.content) parts.push(String(msg.content).slice(0, 300));
    if (msg.tool_calls) {
      const calls = msg.tool_calls.map((tc) => {
        const name = tc.function?.name || "tool";
        const args = String(tc.function?.arguments ?? "").slice(0, 100);
        return `${name}(${args})`;
      });
      parts.push(`[Tool calls]: ${calls.join("; ")}`);
    }
    return `[Assistant]: ${parts.join("\n")}`;
  }
  if (msg.role === "tool") {
    const content = contentToText(msg.content);
    return `[Tool result]: ${content.slice(0, 500)}${content.length > 500 ? `... (${content.length} chars truncated)` : ""}`;
  }
  return "";
}

export function createCompactMessage({
  compactId = "",
  summary = "",
  plan = {},
  contextWindow = 0,
  inputTokensBefore = 0,
  inputTokensAfter = 0,
  usage = null,
}: {compactId?: string; summary?: string; plan?: Partial<PlanFields>; contextWindow?: number; inputTokensBefore?: number; inputTokensAfter?: number; usage?: Record<string, unknown> | null} = {}) {
  const cleanSummary = String(summary || "").trim() || "[compact failed]";
  const id = String(compactId || "").trim();
  const recordedUsage = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : null;
  return {
    role: "user",
    content: formatCompactContent(cleanSummary),
    _kind: COMPACT_MESSAGE_KIND,
    _origin: COMPACT_MESSAGE_ORIGIN,
    trim: false,
    ...(recordedUsage ? { _usage: recordedUsage } : {}),
    _compact: {
      id,
      compactId: id,
      status: "done",
      createdAt: nowBeijingDateTime(),
      sourceMessageCount: Number(plan.sourceMessageCount || plan.sourceMessages?.length || 0),
      retainedMessageCount: Number(plan.retainedMessageCount || plan.retainedMessages?.length || 0),
      sourceStartIndex: Number(plan.minIndex || 0),
      sourceEndIndex: Number(plan.cutIndex || 0),
      inputTokensBefore: Math.max(0, Number(inputTokensBefore) || 0),
      inputTokensAfter: Math.max(0, Number(inputTokensAfter) || 0),
      contextWindow: Math.max(0, Number(contextWindow) || 0),
      threshold: Math.max(0, Number(plan.threshold) || 0),
      keepBudget: Math.max(0, Number(plan.keepBudget) || 0),
    },
  };
}

export function formatCompactContent(summary = "") {
  return `${promptT("summaryHeader")}\n${String(summary || "").trim()}`;
}

export function extractCompactSummary(content: unknown = "") {
  return String(content || "").replace(/^\[(?:之前的对话摘要|Previous conversation summary)\]\s*/u, "").trim();
}

function contentToText(content: unknown) {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content ?? "");
  } catch (_err) {
    return String(content ?? "");
  }
}

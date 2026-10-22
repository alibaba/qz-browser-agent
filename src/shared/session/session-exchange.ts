import { t } from "../i18n/backend.js";
import {
  createSessionRecord,
  readSessionRecord,
  transcriptFromConversation,
} from "./session-codec.js";
import {
  MESSAGE_KIND_CONTEXT_CAPSULE,
  MESSAGE_ORIGIN_CONTEXT_CAPSULE,
} from "../message-blocks.js";
import { nowBeijingDateTime } from "../time-utils.js";

import type { Conversation, TranscriptEntry } from '../contracts/session.js';

export interface SessionExchangeSnapshot {
  session?: { id?: unknown; parentSessionId?: unknown; title?: unknown; createdAt?: unknown; updatedAt?: unknown };
  conversation?: unknown; transcript?: unknown; appVersion?: string; exportedAt?: string;
  runtime?: { status?: unknown; goal?: unknown; ownedTabs?: unknown; workingTab?: unknown;
    workingUrl?: unknown; workingTitle?: unknown; loadedPluginSkillNames?: unknown; exchangeDependencies?: unknown };
}
export type SessionExchangePayload = ReturnType<typeof normalizeSessionExchangePayload>;
export interface PortableSessionTab { url: string; title: string; working: boolean }
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export const SESSION_EXCHANGE_FORMAT = "qingzhou.session";
export const SESSION_EXCHANGE_VERSION = 1;
export const SESSION_EXCHANGE_SCRIPT_ID = "qingzhou-session-exchange";
export const SESSION_EXCHANGE_IMPORT_CAPSULE_REASON = "session_exchange_import";

const SESSION_EXCHANGE_TAB_URL_LIMIT = 64 * 1024;
const SESSION_EXCHANGE_OWNED_TAB_LIMIT = 30;
const SESSION_EXCHANGE_EXPLICIT_NAVIGATION_TOOLS = new Set([
  "navigate",
  "open_tab",
  "use_tab",
]);

const SESSION_EXCHANGE_IMPORT_CAPSULE_TEXT = [
  "[外部会话 capsule]",
  "本对话由外部导出的轻舟会话加载。原环境中的技能、工具、数据表、图集、文件、下载记录和浏览器页面可能在当前环境中不存在或已经变化。继续任务时请以当前可用能力和实际资源为准；遇到缺失时灵活调整方案，不要假设历史资源仍可访问。",
].join("\n");

export function createSessionExchangePayload({
  session = {},
  conversation = null,
  transcript = [],
  runtime = {},
  appVersion = "",
  exportedAt = nowBeijingDateTime(),
}: SessionExchangeSnapshot = {}) {
  const record = createSessionRecord(stripSessionExchangeImportCapsules(conversation), transcript);
  const normalized = readSessionRecord(record);
  const resolvedTranscript = normalized.transcript.length
    ? normalized.transcript
    : transcriptFromConversation(normalized.conversation);
  const exchangeDependencies = asRecord(runtime?.exchangeDependencies);
  const toolNames = [...new Set(
    [
      ...resolvedTranscript
        .filter(item => item?.type === "tool")
        .map(item => String(item.name || "").trim()),
      ...normalizeStringList(exchangeDependencies.tools),
    ].filter(Boolean),
  )].sort();
  const skillNames = [...new Set(
    [
      ...(Array.isArray(runtime?.loadedPluginSkillNames) ? runtime.loadedPluginSkillNames : []),
      ...normalizeStringList(exchangeDependencies.skills),
    ]
      .map(value => String(value || "").trim())
      .filter(Boolean),
  )].sort();

  return {
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    exportedAt: String(exportedAt || nowBeijingDateTime()),
    app: {
      name: "轻舟",
      version: String(appVersion || ""),
    },
    source: {
      sessionId: String(session?.id || ""),
      parentSessionId: String(session?.parentSessionId || ""),
    },
    session: {
      title: normalizeTitle(session?.title),
      createdAt: String(session?.createdAt || ""),
      updatedAt: String(session?.updatedAt || ""),
      conversation: normalized.conversation,
      transcript: resolvedTranscript,
    },
    runtime: {
      status: normalizePortableStatus(runtime?.status),
      goal: normalizePortableGoal(runtime?.goal),
      ownedTabs: selectSessionExchangeOwnedTabs(
        runtime?.ownedTabs,
        runtime?.workingTab || {
          url: runtime?.workingUrl,
          title: runtime?.workingTitle,
        },
        resolvedTranscript,
      ),
    },
    dependencies: {
      skills: skillNames,
      tools: toolNames,
    },
  };
}

export function normalizeSessionExchangePayload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw exchangeError(t("exchange.noConversation"), "INVALID_SESSION_EXCHANGE");
  }
  const value = asRecord(input);
  if (value.format !== SESSION_EXCHANGE_FORMAT) {
    throw exchangeError(t("exchange.unsupportedFormat"), "UNSUPPORTED_SESSION_EXCHANGE_FORMAT");
  }
  if (Number(value.version) !== SESSION_EXCHANGE_VERSION) {
    throw exchangeError(t("exchange.unsupportedVersion"), "UNSUPPORTED_SESSION_EXCHANGE_VERSION");
  }

  const sourceSession = asRecord(value.session);
  const record = createSessionRecord(
    stripSessionExchangeImportCapsules(sourceSession.conversation),
    sourceSession.transcript,
  );
  const normalized = readSessionRecord(record);
  const transcript = normalized.transcript.length
    ? normalized.transcript
    : transcriptFromConversation(normalized.conversation);
  if (!hasConversationEntries(normalized.conversation) && transcript.length === 0) {
    throw exchangeError(t("exchange.empty"), "EMPTY_SESSION_EXCHANGE");
  }

  return {
    format: SESSION_EXCHANGE_FORMAT,
    version: SESSION_EXCHANGE_VERSION,
    exportedAt: String(value.exportedAt || ""),
    app: {
      name: "轻舟",
      version: String(asRecord(value.app).version || ""),
    },
    source: {
      sessionId: String(asRecord(value.source).sessionId || ""),
      parentSessionId: String(asRecord(value.source).parentSessionId || ""),
    },
    session: {
      title: normalizeTitle(sourceSession.title),
      createdAt: String(sourceSession.createdAt || ""),
      updatedAt: String(sourceSession.updatedAt || ""),
      conversation: normalized.conversation,
      transcript,
    },
    runtime: {
      status: normalizePortableStatus(asRecord(value.runtime).status),
      goal: normalizePortableGoal(asRecord(value.runtime).goal),
      ownedTabs: normalizePortableSessionOwnedTabs(
        asRecord(value.runtime).ownedTabs,
        asRecord(value.runtime).workingTab,
      ),
    },
    dependencies: {
      skills: normalizeStringList(asRecord(value.dependencies).skills),
      tools: normalizeStringList(asRecord(value.dependencies).tools),
    },
  };
}

export function renderSessionExchangeScript(payload: unknown) {
  const normalized = normalizeSessionExchangePayload(payload);
  const json = JSON.stringify(normalized)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  return `<script id="${SESSION_EXCHANGE_SCRIPT_ID}" type="application/json">${json}</script>`;
}

export function extractSessionExchangePayload(html: unknown) {
  const source = String(html || "");
  const pattern = new RegExp(
    `<script\\s+id=["']${SESSION_EXCHANGE_SCRIPT_ID}["']\\s+type=["']application/json["']>([\\s\\S]*?)<\\/script>`,
    "iu",
  );
  const match = source.match(pattern);
  if (!match) {
    throw exchangeError(t("exchange.missingPayload"), "MISSING_SESSION_EXCHANGE_PAYLOAD");
  }
  try {
    return normalizeSessionExchangePayload(JSON.parse(match[1]));
  } catch (err) {
    if (asRecord(err).code) throw err;
    throw exchangeError(t("exchange.corrupted"), "INVALID_SESSION_EXCHANGE_PAYLOAD");
  }
}

export function appendSessionExchangeImportCapsule(conversation: unknown, createdAt = nowBeijingDateTime()) {
  const cleanConversation = stripSessionExchangeImportCapsules(conversation);
  const normalized = createSessionRecord(cleanConversation, []).conversation;
  const entries = Array.isArray(normalized?.entries) ? normalized.entries.slice() : [];
  const timestamp = String(createdAt || nowBeijingDateTime());
  const existingIds = new Set(entries.map(entry => String(entry?.id || "")).filter(Boolean));
  let id = `exchange_import_${entries.length}`;
  for (let suffix = 1; existingIds.has(id); suffix += 1) id = `exchange_import_${entries.length}_${suffix}`;
  entries.push({
    type: "message",
    id,
    parentId: entries.at(-1)?.id || null,
    timestamp,
    message: {
      role: "user",
      _origin: MESSAGE_ORIGIN_CONTEXT_CAPSULE,
      _kind: MESSAGE_KIND_CONTEXT_CAPSULE,
      _contextCapsule: {
        reason: SESSION_EXCHANGE_IMPORT_CAPSULE_REASON,
        createdAt: timestamp,
        signature: SESSION_EXCHANGE_IMPORT_CAPSULE_REASON,
      },
      content: SESSION_EXCHANGE_IMPORT_CAPSULE_TEXT,
    },
  });
  return { ...normalized, entries };
}

export function hasSessionExchangeImportCapsule(input: unknown) {
  if (!input || typeof input !== "object") return false;
  if (Array.isArray(input)) return input.some(message => isSessionExchangeImportCapsule(message));
  const conversation = asRecord(input);
  if (Array.isArray(conversation.messages)) {
    return conversation.messages.some(message => isSessionExchangeImportCapsule(message));
  }
  if (!Array.isArray(conversation.entries)) return false;
  return conversation.entries.some(raw => {
    const entry = asRecord(raw);
    return isSessionExchangeImportCapsule(entry.message ?? entry);
  });
}

/** Stable identity for an exported conversation, ignoring import capsules and entry ids. */
export async function hashSessionExchangeContent(conversation: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalSessionExchangeMessages(conversation)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalSessionExchangeMessages(conversation: unknown) {
  const stripped = stripSessionExchangeImportCapsules(conversation);
  const normalized = readSessionRecord(createSessionRecord(stripped, [])).conversation;
  const entries = Array.isArray(normalized?.entries) ? normalized.entries : [];
  return entries
    .filter(entry => !isSessionExchangeImportCapsule(entry?.message))
    .map(entry => {
      const message = asRecord(entry?.message);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call => {
        const toolCall = asRecord(call);
        const fn = asRecord(toolCall.function);
        return {
          id: String(toolCall.id || ""),
          name: String(fn.name || toolCall.name || ""),
          arguments: fn.arguments ?? toolCall.arguments ?? null,
        };
      }) : [];
      return {
        role: String(message.role || ""),
        content: message.content ?? null,
        toolCalls,
        toolCallId: String(message.tool_call_id || ""),
      };
    });
}

export function stripSessionExchangeImportCapsules(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.filter(message => !isSessionExchangeImportCapsule(message));
  }
  const conversation = asRecord(input);
  if (Array.isArray(conversation.messages)) {
    return {
      ...conversation,
      messages: conversation.messages.filter(message => !isSessionExchangeImportCapsule(message)),
    };
  }
  if (!Array.isArray(conversation.entries)) return conversation;

  const removedParents = new Map<unknown, unknown>();
  const entries: unknown[] = [];
  for (const raw of conversation.entries as unknown[]) {
    const entry = asRecord(raw);
    if (isSessionExchangeImportCapsule(entry?.message ?? entry)) {
      if (entry?.id) removedParents.set(entry.id, entry.parentId ?? null);
      continue;
    }
    entries.push(raw);
  }
  if (entries.length === conversation.entries.length) return conversation;

  const resolveParent = (parentId: unknown) => {
    let resolved = parentId;
    const seen = new Set();
    while (resolved && removedParents.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = removedParents.get(resolved) ?? null;
    }
    return resolved;
  };
  return {
    ...conversation,
    entries: entries.map(entry => ({
      ...asRecord(entry),
      parentId: resolveParent(asRecord(entry).parentId ?? null),
    })),
  };
}

export function settleImportedTranscript(transcript: readonly TranscriptEntry[], endedAt = nowBeijingDateTime()): TranscriptEntry[] {
  return (Array.isArray(transcript) ? transcript : []).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.type === "tool" && isUnfinishedTool(entry)) {
      const next = {
        ...entry,
        argsIncomplete: false,
        argsGenerating: false,
        argsState: "aborted",
        phase: "aborted",
        statusText: "",
        isRunning: false,
        isError: true,
        result: entry.result ?? {
          error: t("exchange.incompleteTool"),
          code: "IMPORTED_TOOL_INTERRUPTED",
          interrupted: true,
        },
        endedAt: entry.endedAt || endedAt,
      };
      delete next.streaming;
      return next;
    }
    if (entry.type === "wait" && entry.status === "waiting") {
      return {
        ...entry,
        status: "interrupted",
        reason: entry.reason || "imported",
        endedAt: entry.endedAt || endedAt,
      };
    }
    if (entry.streaming || (entry.type === "compact" && entry.status === "running")) {
      const next = {
        ...entry,
        endedAt: entry.endedAt || endedAt,
      };
      delete next.streaming;
      if (entry.type === "thinking") next.phase = "aborted";
      if (entry.type === "compact") next.status = "aborted";
      return next;
    }
    return entry;
  });
}

export function normalizePortableSessionOwnedTab(input: unknown): PortableSessionTab | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = asRecord(input);
  const rawUrl = String(value.url || "").trim();
  if (!rawUrl || rawUrl.length > SESSION_EXCHANGE_TAB_URL_LIMIT) return null;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const normalizedUrl = url.href;
    if (normalizedUrl.length > SESSION_EXCHANGE_TAB_URL_LIMIT) return null;
    return {
      url: normalizedUrl,
      title: String(value.title || "").trim().slice(0, 120),
      working: value.working === true,
    };
  } catch (_error) {
    return null;
  }
}

export function normalizePortableSessionOwnedTabs(values: unknown, legacyWorkingTab: unknown = null) {
  const tabs: PortableSessionTab[] = [];
  let hasWorkingTab = false;
  for (const value of Array.isArray(values) ? values : []) {
    const tab = normalizePortableSessionOwnedTab(value);
    if (!tab) continue;
    if (tab.working && hasWorkingTab) tab.working = false;
    if (tab.working) hasWorkingTab = true;
    if (tabs.length < SESSION_EXCHANGE_OWNED_TAB_LIMIT) {
      tabs.push(tab);
    } else if (tab.working) {
      tabs[tabs.length - 1] = tab;
    }
  }
  if (tabs.length) return tabs;

  const legacy = normalizePortableSessionOwnedTab(legacyWorkingTab);
  return legacy ? [{ ...legacy, working: true }] : [];
}

function selectSessionExchangeOwnedTabs(values: unknown, legacyWorkingTab: unknown, transcript: readonly TranscriptEntry[]) {
  const allowedHosts = collectSessionExchangeTranscriptHosts(transcript);
  if (!allowedHosts.size) return [];
  const eligible = (Array.isArray(values) ? values : [])
    .filter(tab => allowedHosts.has(httpUrlHost(tab?.url)));
  const eligibleLegacy = allowedHosts.has(httpUrlHost(asRecord(legacyWorkingTab).url))
    ? legacyWorkingTab
    : null;
  return normalizePortableSessionOwnedTabs(eligible, eligibleLegacy);
}

function collectSessionExchangeTranscriptHosts(transcript: readonly TranscriptEntry[]) {
  const hosts = new Set<string>();
  const add = (value: unknown) => {
    const host = httpUrlHost(value);
    if (host) hosts.add(host);
  };
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    if (!isSuccessfulSessionExchangeToolEntry(entry)) continue;
    add(asRecord(entry.args)._pageUrl);
    add(asRecord(entry.result)._pageUrl);
    const capabilityId = String(entry.capabilityId || entry.name || "").trim();
    if (!SESSION_EXCHANGE_EXPLICIT_NAVIGATION_TOOLS.has(capabilityId)) continue;
    add(asRecord(entry.args).url);
    add(asRecord(entry.result).url);
    add(asRecord(asRecord(entry.result).tab).url);
  }
  return hosts;
}

function isSuccessfulSessionExchangeToolEntry(entry: TranscriptEntry) {
  if (!entry || entry.type !== "tool" || entry.isError || entry.isRunning) return false;
  if (entry.argsIncomplete || entry.argsGenerating) return false;
  if (asRecord(entry.result).error) return false;
  return !["aborted", "error", "not_executed", "preparing", "running"].includes(
    String(entry.phase || "").trim().toLowerCase(),
  );
}

function httpUrlHost(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.hostname.toLowerCase().replace(/\.$/u, "");
  } catch (_error) {
    return "";
  }
}

function normalizePortableGoal(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const goal = asRecord(input);
  const status = ["active", "blocked", "paused", "complete"].includes(String(goal.status || ""))
    ? String(goal.status)
    : "active";
  const normalized = {
    status,
    objective: clipText(goal.objective, 240),
    criteria: clipText(goal.criteria, 360),
    progress: clipText(goal.progress, 360),
    next: clipText(goal.next, 240),
    checkpoint: clipText(goal.checkpoint, 500),
    version: Math.max(0, Math.floor(Number(goal.version) || 0)),
    createdAt: String(goal.createdAt || ""),
    updatedAt: String(goal.updatedAt || ""),
  };
  return [normalized.objective, normalized.criteria, normalized.progress, normalized.next, normalized.checkpoint]
    .some(value => value.trim())
    ? normalized
    : null;
}

function normalizePortableStatus(value: unknown) {
  const status = String(value || "").trim().toLowerCase();
  if (["completed", "error", "aborted", "interrupted", "idle"].includes(status)) return status;
  if (["pending", "running", "waiting_user"].includes(status)) return "interrupted";
  return "idle";
}

function normalizeStringList(values: unknown) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || "").trim())
      .filter(Boolean),
  )].sort();
}

function normalizeTitle(value: unknown) {
  return String(value || t("exchange.defaultTitle")).replace(/\s+/gu, " ").trim().slice(0, 120) || t("exchange.defaultTitle");
}

function clipText(value: unknown, limit: number) {
  return String(value || "").trim().slice(0, limit);
}

function hasConversationEntries(conversation: Conversation | null) {
  return Array.isArray(conversation?.entries) && conversation.entries.length > 0;
}

function isUnfinishedTool(entry: TranscriptEntry) {
  return Boolean(
    entry.isRunning
    || entry.argsIncomplete
    || entry.argsGenerating
    || entry.streaming
    || ["generating", "ready", "executing"].includes(entry.argsState || "")
    || ["preparing", "running"].includes(entry.phase || ""),
  );
}

function isSessionExchangeImportCapsule(input: unknown) {
  const message = asRecord(input);
  return message._origin === MESSAGE_ORIGIN_CONTEXT_CAPSULE
    && message._kind === MESSAGE_KIND_CONTEXT_CAPSULE
    && asRecord(message._contextCapsule).reason === SESSION_EXCHANGE_IMPORT_CAPSULE_REASON;
}

function exchangeError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

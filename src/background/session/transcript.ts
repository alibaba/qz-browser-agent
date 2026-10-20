import {
  readSessionRecord,
  transcriptFromConversation,
  updateTranscriptWithAgentEvent,
} from "../../shared/session/session-codec.js";
import { readSessionSnapshot } from "../../shared/session/session-recovery.js";
import { createSessionListSummaryFromAgentEvent } from "../../shared/session/session-list-summary.js";

import type { TranscriptEntry, TranscriptAgentEvent } from "../../shared/contracts/session.js";
import type { ToolIdentity } from "../../shared/tools/tool-identity.js";
interface RestoredTranscriptEntry extends TranscriptEntry { tools?: RestoredTranscriptEntry[]; items?: RestoredTranscriptEntry[]; displayName?: string }
interface LiveEntry { agent: { exportSession(): unknown } }
interface TranscriptOptions {
  repository: { readRecord(sessionId: string): Promise<unknown>; readActiveConversation(sessionId: string): Promise<unknown> };
  supervisor: {
    peekEntry(sessionId: string): { agent?: LiveEntry["agent"] | null } | null;
    getRuntime(sessionId: string): { status?: string; runId?: string | null; reason?: unknown; endedAt?: unknown } | null | undefined;
  };
  getLiveAgentEntry(sessionId: string): Promise<LiveEntry | null>;
  normalizeSessionId(value: unknown): string;
  resolveToolDefinition(name: string): unknown;
  getToolIdentity(name: string): Partial<ToolIdentity>;
  scheduleListSummaryPatch?(sessionId: string, summary: NonNullable<ReturnType<typeof createSessionListSummaryFromAgentEvent>>, options: { action: string; touchSession: boolean; delay: number }): unknown;
}

/** Owns the in-memory transcript projection and its Repository-backed hydration. */
export function createSessionTranscript({
  repository,
  supervisor,
  getLiveAgentEntry,
  normalizeSessionId,
  resolveToolDefinition,
  getToolIdentity,
  scheduleListSummaryPatch = () => {},
}: TranscriptOptions) {
  if (!repository) throw new TypeError("repository is required");
  if (!supervisor) throw new TypeError("supervisor is required");
  if (typeof getLiveAgentEntry !== "function") throw new TypeError("getLiveAgentEntry is required");
  if (typeof normalizeSessionId !== "function") throw new TypeError("normalizeSessionId is required");
  if (typeof resolveToolDefinition !== "function") throw new TypeError("resolveToolDefinition is required");
  if (typeof getToolIdentity !== "function") throw new TypeError("getToolIdentity is required");

  const cache = new Map<string, RestoredTranscriptEntry[]>();

  function recordEvent(sessionId: string, event: TranscriptAgentEvent & Record<string, unknown> = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    const fallback = cache.has(id) ? null : supervisor.peekEntry(id)?.agent?.exportSession?.() || null;
    const current = getCached(id, fallback);
    const result = updateTranscriptWithAgentEvent(current, event);
    if (result.changed) cache.set(id, result.transcript);
    const summaryPatch = createSessionListSummaryFromAgentEvent(event);
    if (result.changed && summaryPatch) {
      scheduleListSummaryPatch(id, summaryPatch, {
        action: "summary",
        touchSession: true,
        delay: event.type === "tool_execution_end" ? 360 : 160,
      });
    }
    return result.changed;
  }

  function getCached(sessionId: string, fallbackConversation: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return [];
    if (!cache.has(id)) cache.set(id, resolveIdentities(transcriptFromConversation(fallbackConversation)));
    return cache.get(id) || [];
  }

  async function hydrate(sessionId: string, fallbackConversation: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return [];
    if (cache.has(id)) return cache.get(id) || [];
    const [saved, conversation] = await Promise.all([
      repository.readRecord(id),
      fallbackConversation ?? repository.readActiveConversation(id),
    ]);
    if (cache.has(id)) return cache.get(id) || [];
    let transcript = resolveIdentities(readSessionSnapshot(saved, conversation).transcript);
    const runtime = supervisor.getRuntime(id);
    if (runtime?.status === "interrupted") {
      transcript = updateTranscriptWithAgentEvent(transcript, {
        type: "state", status: runtime.status, runId: runtime.runId,
        reason: String(runtime.reason || ""), timestamp: String(runtime.endedAt || ""),
      }).transcript;
    }
    cache.set(id, transcript);
    return transcript;
  }

  async function get(sessionId: string, fallbackConversation: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return [];
    return cache.has(id) ? (cache.get(id) || []) : hydrate(id, fallbackConversation);
  }

  async function getConversation(sessionId: string, provided: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return provided || [];
    if (provided) return provided;
    const entry = await getLiveAgentEntry(id);
    if (entry) return entry.agent.exportSession();
    const active = await repository.readActiveConversation(id);
    if (active) return active;
    return readSessionRecord(await repository.readRecord(id)).conversation || [];
  }

  function set(sessionId: string, transcript: RestoredTranscriptEntry[] = []) {
    const id = normalizeSessionId(sessionId);
    const next = resolveIdentities(transcript);
    cache.set(id, next);
    return next;
  }

  function remove(sessionId: string) {
    return cache.delete(normalizeSessionId(sessionId));
  }

  function resolveIdentities(transcript: RestoredTranscriptEntry[] = []) {
    return (Array.isArray(transcript) ? transcript : []).map(entry => {
      if (!entry || typeof entry !== "object") return entry;
      if (entry.type === "tool") return resolveIdentity(entry);
      if (entry.type !== "tool-group") return entry;
      const key = Array.isArray(entry.tools) ? "tools" : (Array.isArray(entry.items) ? "items" : "");
      return key ? { ...entry, [key]: entry[key]!.map(resolveIdentity) } : entry;
    });
  }

  function resolveIdentity(tool: RestoredTranscriptEntry) {
    if (!tool || typeof tool !== "object" || !resolveToolDefinition(tool.name || "")) return tool;
    const identity = getToolIdentity(tool.name || "");
    return {
      ...tool,
      capabilityId: tool.capabilityId || identity.capabilityId,
      title: tool.title || tool.displayName || identity.title,
      familyId: tool.familyId || identity.familyId,
      familyTitle: tool.familyTitle || identity.familyTitle,
    };
  }

  return Object.freeze({
    recordEvent,
    getCached,
    hydrate,
    get,
    getConversation,
    set,
    remove,
    resolveIdentities,
  });
}

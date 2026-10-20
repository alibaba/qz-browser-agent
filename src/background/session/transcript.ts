import {
  readSessionRecord,
  transcriptFromConversation,
  updateTranscriptWithAgentEvent,
} from "../../shared/session/session-codec.js";
import { readSessionSnapshot } from "../../shared/session/session-recovery.js";
import { createSessionListSummaryFromAgentEvent } from "../../shared/session/session-list-summary.js";

import type { TranscriptEntry, TranscriptAgentEvent, TranscriptSnapshot } from "../../shared/contracts/session.js";
import type { ToolIdentity } from "../../shared/tools/tool-identity.js";
interface RestoredTranscriptEntry extends TranscriptEntry { tools?: RestoredTranscriptEntry[]; items?: RestoredTranscriptEntry[]; displayName?: string }
interface DisplayState extends TranscriptSnapshot { transcript: RestoredTranscriptEntry[] }
interface CheckpointLease { sessionId: string; isActive(): boolean }
interface LiveEntry { agent: { exportSession(): unknown } }
interface TranscriptOptions {
  repository: {
    readRecord(sessionId: string): Promise<unknown>;
    readActiveConversation(sessionId: string): Promise<unknown>;
    writeTranscriptCheckpoint?(sessionId: string, snapshot: TranscriptSnapshot, lease: CheckpointLease): Promise<unknown>;
  };
  supervisor: {
    peekEntry(sessionId: string): { agent?: LiveEntry["agent"] | null; lease?: CheckpointLease | null } | null;
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

  const cache = new Map<string, DisplayState>();
  const checkpoints = new Map<string, ReturnType<typeof setTimeout>>();
  const streamingEvents = new Set(["message_update", "thinking_update", "tool_call_update", "tool_execution_update"]);

  function cancelCheckpoint(id: string) {
    clearTimeout(checkpoints.get(id));
    checkpoints.delete(id);
  }

  function checkpoint(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    cancelCheckpoint(id);
    const entry = supervisor.peekEntry(id);
    if (!repository.writeTranscriptCheckpoint || !entry?.agent || !entry.lease?.isActive() || !cache.has(id)) return null;
    return repository.writeTranscriptCheckpoint(id, snapshot(id), entry.lease);
  }

  function scheduleWrite(id: string) {
    try {
      void checkpoint(id)?.catch(reportCheckpointFailure);
    } catch (error) { reportCheckpointFailure(error); }
  }

  function reportCheckpointFailure(error: unknown) {
    if (["STALE_SESSION_LEASE", "SESSION_DELETED"].includes(String((error as { code?: unknown })?.code))) return;
    console.warn("[轻舟] persist transcript checkpoint failed:", error);
  }

  function scheduleCheckpoint(id: string, event: TranscriptAgentEvent) {
    if (!repository.writeTranscriptCheckpoint || !supervisor.peekEntry(id)?.lease?.isActive()) return;
    if (!streamingEvents.has(event.type || "")) scheduleWrite(id);
    // A fixed deadline bounds scheduling delay during a stream; each delta must
    // not postpone the pending snapshot. The callback captures the latest cache.
    else if (!checkpoints.has(id)) checkpoints.set(id, setTimeout(() => scheduleWrite(id), 1000));
  }

  function recordEvent(sessionId: string, event: TranscriptAgentEvent & Record<string, unknown> = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) return false;
    const fallback = cache.has(id) ? null : supervisor.peekEntry(id)?.agent?.exportSession?.() || null;
    getCached(id, fallback);
    const state = cache.get(id)!;
    const result = updateTranscriptWithAgentEvent(state.current, event);
    if (event.type === "agent_end") cancelCheckpoint(id);
    if (result.changed) {
      cache.set(id, displayState(event.type === "reset" ? [] : state.history, result.transcript));
      if (event.type !== "agent_end") scheduleCheckpoint(id, event);
    }
    if (event.type === "agent_end") finish(id);
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
    if (!cache.has(id)) {
      // Without an explicit hydration boundary, keep the fallback editable.
      cache.set(id, displayState([], resolveIdentities(transcriptFromConversation(fallbackConversation))));
    }
    return cache.get(id)!.transcript;
  }

  async function hydrate(sessionId: string, fallbackConversation: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return [];
    if (cache.has(id)) return cache.get(id)!.transcript;
    const [saved, conversation] = await Promise.all([
      repository.readRecord(id),
      fallbackConversation ?? repository.readActiveConversation(id),
    ]);
    if (cache.has(id)) return cache.get(id)!.transcript;
    let transcript = resolveIdentities(readSessionSnapshot(saved, conversation).transcript);
    const runtime = supervisor.getRuntime(id);
    if (runtime?.status === "interrupted") {
      transcript = updateTranscriptWithAgentEvent(transcript, {
        type: "state", status: runtime.status, runId: runtime.runId,
        reason: String(runtime.reason || ""), timestamp: String(runtime.endedAt || ""),
      }).transcript;
    }
    cache.set(id, displayState(transcript));
    return transcript;
  }

  async function get(sessionId: string, fallbackConversation: unknown = null) {
    const id = normalizeSessionId(sessionId);
    if (!id) return [];
    return cache.has(id) ? cache.get(id)!.transcript : hydrate(id, fallbackConversation);
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

  function set(sessionId: string, history: RestoredTranscriptEntry[] = [], current: RestoredTranscriptEntry[] = []) {
    const id = normalizeSessionId(sessionId);
    cancelCheckpoint(id);
    const next = displayState(resolveIdentities(history), resolveIdentities(current));
    cache.set(id, next);
    return next.transcript;
  }

  function snapshot(sessionId: string): TranscriptSnapshot {
    const state = cache.get(normalizeSessionId(sessionId));
    return state ? { history: state.history, current: state.current } : { history: [], current: [] };
  }

  function finish(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    cancelCheckpoint(id);
    const state = cache.get(id);
    if (state?.current.length) cache.set(id, displayState(state.transcript));
  }

  function displayState(history: readonly RestoredTranscriptEntry[], current: readonly RestoredTranscriptEntry[] = []): DisplayState {
    return { history, current, transcript: current.length ? [...history, ...current] : history as RestoredTranscriptEntry[] };
  }

  function remove(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    cancelCheckpoint(id);
    return cache.delete(id);
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
    snapshot,
    checkpoint,
    finish,
    remove,
    resolveIdentities,
  });
}

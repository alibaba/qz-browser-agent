import { sessionIdText as normalizeSessionId } from "../../sessions/session-id.js";
import type { TranscriptEntry } from "../../../tools/renderer-input.js";
import { collectSessionImageReferences, resolveSessionImages } from "../../../../shared/session/session-image-assets.js";
interface ReconcileEvent {
  type?: string; hasHistory?: boolean; isStreaming?: boolean;
  status?: unknown; runtime?: { status?: unknown };
}
interface ReconcileOptions<Runtime> {
  minIntervalMs?: number; watchdogStaleMs?: number; watchdogMinIntervalMs?: number; userScrollIdleMs?: number;
  activeConversationPrefix?: string;
  storage?: { onChanged?: Pick<typeof chrome.storage.onChanged, "addListener" | "removeListener"> };
  getCurrentSessionId?(): unknown;
  isUserScrolling?(): boolean;
  isChatActive?(): boolean;
  getRuntime?(id: string): Runtime;
  isRuntimeRunning?(runtime: Runtime | undefined): boolean;
  getTranscriptLastChangedAt?(id: string): number;
  getCurrentTranscriptCount?(): number;
  isDeletedSession?(id: string): boolean;
  requestSnapshot?(id: string, options: { persist: false }): unknown;
  getTranscriptCount?(id: string): number;
  transcriptFromConversation?(conversation: unknown): TranscriptEntry[];
  seedTranscript?(id: string, transcript: TranscriptEntry[]): boolean;
  renderUpdatedTranscript?(id: string, changed: boolean): void;
  scheduleSessionsRefresh?(): void;
}

export function createTranscriptReconcileFeature<Runtime>(options: ReconcileOptions<Runtime> = {}) {
  const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconcileLastAt = new Map<string, number>();
  const watchdogLastAt = new Map<string, number>();
  const storageHydrations = new Map<string, object>();
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 2500);
  const watchdogStaleMs = Math.max(0, Number(options.watchdogStaleMs) || 1600);
  const watchdogMinIntervalMs = Math.max(0, Number(options.watchdogMinIntervalMs) || 1800);
  let started = false;

  function start() {
    if (started) return;
    started = true;
    options.storage?.onChanged?.addListener?.(handleStorageChange);
  }

  function stop() {
    if (!started) return;
    started = false;
    options.storage?.onChanged?.removeListener?.(handleStorageChange);
    reset();
  }

  function handleEvent(sessionId: unknown, event: ReconcileEvent) {
    scheduleForCurrentSession(sessionId, event);
    reconcileStaleStream(sessionId, event);
  }

  function scheduleForCurrentSession(sessionId: unknown, event: ReconcileEvent) {
    const id = normalizeSessionId(sessionId);
    if (!id || id !== normalizeSessionId(options.getCurrentSessionId?.()) || !shouldReconcile(event)) return;
    const terminal = ["agent_end", "aborted", "error"].includes(event.type || "");
    schedule(id, {
      force: terminal,
      delay: terminal ? 0 : (options.isUserScrolling?.() ? Number(options.userScrollIdleMs) || 400 : 400),
    });
  }

  function reconcileStaleStream(sessionId: unknown, event: ReconcileEvent) {
    const id = normalizeSessionId(sessionId);
    if (!id || id !== normalizeSessionId(options.getCurrentSessionId?.()) || options.isChatActive?.() !== true) return;
    if (event?.type !== "context_usage") return;
    if (options.isRuntimeRunning?.(options.getRuntime?.(id)) !== true) return;

    const now = Date.now();
    const lastChangedAt = Number(options.getTranscriptLastChangedAt?.(id)) || 0;
    if (lastChangedAt && now - lastChangedAt < watchdogStaleMs) return;
    const lastWatchdogAt = watchdogLastAt.get(id) || 0;
    if (now - lastWatchdogAt < watchdogMinIntervalMs) return;

    watchdogLastAt.set(id, now);
    schedule(id, { delay: 0, force: true });
  }

  function shouldReconcile(event: ReconcileEvent) {
    if (!event?.type) return false;
    if (event.type === "state") {
      const interrupted = (event.status || event.runtime?.status) === "interrupted";
      return Boolean(event.hasHistory && (event.isStreaming || interrupted || options.getCurrentTranscriptCount?.() === 0));
    }
    return [
      "agent_start",
      "context_usage",
      "message_end",
      "tool_execution_end",
      "agent_end",
      "aborted",
      "error",
    ].includes(event.type || "");
  }

  function schedule(sessionId: unknown, { delay = 400, force = false } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id || options.isDeletedSession?.(id)) return false;
    const now = Date.now();
    const lastAt = reconcileLastAt.get(id) || 0;
    if (!force && now - lastAt < minIntervalMs) return false;
    if (reconcileTimers.has(id)) {
      if (!force) return false;
      clearTimeout(reconcileTimers.get(id));
      reconcileTimers.delete(id);
    }
    const timer = setTimeout(() => {
      reconcileTimers.delete(id);
      reconcileLastAt.set(id, Date.now());
      options.requestSnapshot?.(id, { persist: false });
    }, Math.max(0, Number(delay) || 0));
    reconcileTimers.set(id, timer);
    return true;
  }

  function clear(sessionId: unknown) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const timer = reconcileTimers.get(id);
    if (timer) clearTimeout(timer);
    reconcileTimers.delete(id);
    reconcileLastAt.delete(id);
    watchdogLastAt.delete(id);
    storageHydrations.delete(id);
  }

  function reset() {
    for (const timer of reconcileTimers.values()) clearTimeout(timer);
    reconcileTimers.clear();
    reconcileLastAt.clear();
    watchdogLastAt.clear();
    storageHydrations.clear();
  }

  function handleStorageChange(changes: Record<string, chrome.storage.StorageChange>, areaName: string) {
    if (areaName !== "local") return;
    const prefix = String(options.activeConversationPrefix || "");
    for (const [key, change] of Object.entries(changes || {})) {
      if (!prefix || !key.startsWith(prefix)) continue;
      const sessionId = normalizeSessionId(key.slice(prefix.length));
      if (!sessionId || options.isDeletedSession?.(sessionId)) continue;
      void Promise.resolve(hydrateFromActiveConversation(sessionId, change.newValue))
        .catch(() => { if (started) schedule(sessionId, { force: true, delay: 0 }); });
    }
  }

  function hydrateFromActiveConversation(sessionId: string, conversation: unknown) {
    const authority = {};
    storageHydrations.set(sessionId, authority);
    const commit = (resolved: unknown) => {
      if (storageHydrations.get(sessionId) !== authority) return false;
      storageHydrations.delete(sessionId);
      if (options.isDeletedSession?.(sessionId) || options.getTranscriptCount?.(sessionId)) return false;
      const transcript = options.transcriptFromConversation?.(resolved) || [];
      const changed = options.seedTranscript?.(sessionId, transcript) === true;
      options.renderUpdatedTranscript?.(sessionId, changed);
      if (changed) options.scheduleSessionsRefresh?.();
      return changed;
    };
    if (options.getTranscriptCount?.(sessionId)) { storageHydrations.delete(sessionId); return false; }
    return collectSessionImageReferences(conversation).size
      ? resolveSessionImages(conversation).then(commit, error => {
          if (storageHydrations.get(sessionId) === authority) throw error;
          return false;
        }).finally(() => {
          if (storageHydrations.get(sessionId) === authority) storageHydrations.delete(sessionId);
        })
      : commit(conversation);
  }

  return {
    start,
    stop,
    handleEvent,
    schedule,
    clear,
    reset,
    shouldReconcile,
    hydrateFromActiveConversation,
  };
}


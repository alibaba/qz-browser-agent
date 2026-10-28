import { Agent } from "../agent/agent.js";
import { readSessionRecord } from "../../shared/session/session-codec.js";
import { getSecurityGuardrails } from "../../shared/security-guardrails.js";
import contextCapabilities from "#capabilities/context";
import { createContextSources } from "../context-sources.js";
import { createLifecycleObservers } from "../lifecycle-observers.js";

import type { AgentOptions, DynamicContext } from "../agent/agent.js";
import type { AgentLease, SessionHandle, createSessionSupervisor } from "./supervisor.js";
import type { createSessionRepository } from "./repository.js";
import type { ContextRequest, ContextSource, ContextCapabilityHost } from "../../sdk/background/context.js";
import type { TabReference } from "../../shared/tab-utils.js";
import type { SessionEvent } from "../../shared/contracts/session.js";
type Fields = Record<string, unknown>;
type HostSupervisor = ReturnType<typeof createSessionSupervisor<Agent>>;
interface HostCommands {
  canUseSessionGoal(sessionId: string): Promise<boolean>;
  canManageSessionTools(sessionId: string): Promise<boolean>;
  commitSessionRecordRuntime(input: { sessionId: string; conversation: unknown }): Promise<unknown>;
}
interface AgentHostOptions {
  repository: Pick<ReturnType<typeof createSessionRepository>, "readRecord" | "readActiveConversation" | "writeActiveConversation" | "clearActiveConversation" | "isWriteBlocked">
    & Partial<Pick<ReturnType<typeof createSessionRepository>, "prepareConversation">>;
  normalizeSessionId(value: unknown): string;
  llm: AgentOptions["llm"]; agentServices?: AgentOptions["services"]; browserContext?: AgentOptions["browserContext"];
  ensureSkillToolRegistryReady?: AgentOptions["ensureSkillToolRegistryReady"];
  getToolRuntime(): AgentOptions["tools"];
  getSupervisor(): HostSupervisor;
  getCommands(): HostCommands;
  getWorkingTabContext(sessionId: string): Promise<TabReference | null>;
  recordTranscriptEvent(sessionId: string, event: SessionEvent): unknown;
  recordRuntimeEvent(sessionId: string, event: SessionEvent): unknown;
  persistRuntime?(sessionId: string, options: { terminal: boolean }): Promise<unknown>;
  recordResourceEvent(sessionId: string, event: SessionEvent): unknown;
  hydrateTranscript(sessionId: string, conversation: unknown): Promise<unknown>;
  releaseRunResources?(context: { sessionId: string; runId: string; eventType: string }): Promise<unknown>;
  closeOwnedTabs(sessionId: string, reason: string): Promise<unknown>;
  contextSources?: readonly ContextSource[];
  lifecycle?: Pick<ReturnType<typeof createLifecycleObservers>, "emit">;
  getAutomationRuntime(): { syncSessionOutcome?(sessionId: string): unknown } | null;
  broadcast(event: SessionEvent & { sessionId: string }): unknown;
  logger?: Pick<Console, "warn" | "debug">;
  terminalWriteAttempts?: number;
  terminalRetryDelay?(attempt: number, error: unknown): number;
}
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error;

/** Owns the Agent lease boundary and translates Agent events into Session projections. */
export function createSessionAgentHost({
  repository,
  normalizeSessionId,
  llm,
  agentServices,
  browserContext,
  ensureSkillToolRegistryReady,
  getToolRuntime,
  getSupervisor,
  getCommands,
  getWorkingTabContext,
  recordTranscriptEvent,
  recordRuntimeEvent,
  persistRuntime,
  recordResourceEvent,
  hydrateTranscript,
  releaseRunResources = async () => ({ released: 0 }),
  closeOwnedTabs,
  contextSources = [],
  lifecycle = createLifecycleObservers([]),
  getAutomationRuntime,
  broadcast,
  logger = console,
  terminalWriteAttempts = 3,
  terminalRetryDelay = attempt => [25, 100][Math.max(0, attempt - 1)] || 100,
}: AgentHostOptions) {
  const contextHost: ContextCapabilityHost = Object.freeze({
    getSessionRuntime(sessionId: string) {
      const runtime = getSupervisor().getRuntime(sessionId);
      return runtime ? { visitedTaskSites: runtime.visitedTaskSites, tracker: runtime.tracker, goal: runtime.goal } : null;
    },
    canUseSessionGoal: (sessionId: string) => getCommands().canUseSessionGoal(sessionId),
    getWorkingTabContext, getSecurityGuardrails,
  });
  const collectContext = createContextSources([
    ...contextCapabilities.flatMap(contribute => contribute(contextHost)),
    // Preserve the older explicit host-injection API; discovered sources declare text titles themselves.
    ...contextSources.map(source => ({ ...source, title: source.title ?? source.id })),
  ]);

  function createAgent(lease: AgentLease) {
    const id = normalizeSessionId(lease?.sessionId);
    const agent = new Agent(id, {
      conversationRepository: repository,
      conversationLease: lease,
      llm,
      services: agentServices,
      tools: getToolRuntime(),
      browserContext,
      ensureSkillToolRegistryReady,
      // Initial task admission owns context collection before Agent.prompt acquires its run.
      // Queue timers must not overtake that existing supervisor reservation.
      canStartQueuedRun: async () => {
        await getSupervisor().waitForTaskRelease(id);
        return true;
      },
      sessionPolicy: {
        canManageSessions: sessionId => getCommands().canManageSessionTools(sessionId),
      },
    });
    agent.setDynamicContextProvider(request => collectDynamicContext(id, { ...request, epoch: lease?.epoch }));
    return agent;
  }

  async function initializeAgent(agent: Agent, sessionId: string) {
    const id = normalizeSessionId(sessionId);
    const supervisor = getSupervisor();
    await agent.hydrateFromStore();
    await hydrateTranscript(id, agent.messages.length > 1 ? agent.exportSession() : null);
    const runtime = supervisor.getRuntime(id) || {};
    agent.restoreLoadedSkillToolNames(runtime.loadedPluginSkillNames || []);
    agent.restorePendingQueues({
      followUps: runtime.pendingFollowUpMessages || [],
      steerings: runtime.pendingSteeringMessages || [],
    });
  }

  function handleEvent(sessionId: string, event: SessionEvent) {
    const terminal = event?.type === "agent_end";
    if (repository.isWriteBlocked?.(sessionId)) {
      if (!terminal) return false;
      return releaseTerminalRunResources(sessionId, event).then(() => false);
    }
    try {
      recordTranscriptEvent(sessionId, event);
      recordRuntimeEvent(sessionId, event);
      recordResourceEvent(sessionId, event);
    } catch (error) {
      if (isRetiredSessionEventError(error)) return false;
      throw error;
    }
    const observedEvent = { ...event, epoch: getSupervisor().peekEntry(sessionId)?.epoch };
    lifecycle.emit(sessionId, observedEvent);
    if (!terminal) {
      if (repository.isWriteBlocked?.(sessionId)) return false;
      broadcast({ ...event, sessionId });
      return undefined;
    }
    return commitTerminalEvent(sessionId, event, observedEvent);
  }

  async function commitTerminalEvent(sessionId: string, event: SessionEvent, observedEvent: SessionEvent & { epoch?: number }) {
    await releaseTerminalRunResources(sessionId, event);
    const writes: [string, () => Promise<unknown>][] = [
      ...(typeof persistRuntime === "function"
        ? [["runtime", () => persistRuntime(sessionId, { terminal: true })] as [string, () => Promise<unknown>]]
        : []),
      ["record", () => persistRecord(sessionId)],
    ];
    const results = await Promise.allSettled(writes.map(([, operation]) => retryTerminalOperation(operation)));
    let retired = repository.isWriteBlocked?.(sessionId) === true;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") {
        if (isRetiredSessionEventError(result.reason)) {
          retired = true;
          continue;
        }
        logger.warn?.(`[轻舟] persist terminal ${writes[index][0]} boundary failed:`, result.reason);
      }
    }
    if (retired) return false;
    if (results.every(result => result.status === "fulfilled" && record(result.value).saved !== false)) lifecycle.emit(sessionId, observedEvent, "committed");
    broadcast({ ...event, sessionId });
    syncAutomationOutcome(sessionId);
    closeOwnedTabs(sessionId, `agent_${event.type}`).catch(error => {
      logger.debug?.("[轻舟] close terminal owned tabs failed:", errorMessage(error));
    });
  }

  function syncAutomationOutcome(sessionId: string) {
    void Promise.resolve()
      .then(() => getAutomationRuntime()?.syncSessionOutcome?.(sessionId))
      .catch(error => {
        logger.warn?.("[轻舟] automation run outcome sync failed:", error);
      });
  }

  async function releaseTerminalRunResources(sessionId: string, event: SessionEvent) {
    const runId = String(event?.runId || "").trim();
    if (!runId) return;
    try {
      await releaseRunResources({ sessionId, runId, eventType: event.type });
    } catch (error) {
      // Terminal persistence and tab cleanup must still proceed. The CDP
      // runtime retires its cache even when Chrome reports detach failure.
      logger.warn?.("[轻舟] release terminal run resources failed:", error);
    }
  }

  async function retryTerminalOperation(operation: () => Promise<unknown>) {
    const attempts = Math.max(1, Math.min(5, Math.floor(Number(terminalWriteAttempts) || 1)));
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isRetryableTerminalWriteError(error)) break;
        const delayMs = Math.max(0, Number(terminalRetryDelay(attempt, error)) || 0);
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  async function persistRecord(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    const entry = await getLiveEntry(id);
    if (!entry) return { saved: false, reason: "missing_agent", sessionId: id };
    const conversation = entry.agent!.exportSession();
    return getCommands().commitSessionRecordRuntime({ sessionId: id, conversation });
  }

  async function ensureConversationForHistoryMutation(sessionId: string, agent: Agent | null) {
    const id = normalizeSessionId(sessionId);
    if (!id || !agent) return false;
    if (agent.isStreaming || agent.messages?.length > 1) return true;
    const record = readSessionRecord(await repository.readRecord(id));
    if (!record.conversation) return false;
    await agent.restoreSession(record.conversation);
    agent.restoreLoadedSkillToolNames(getSupervisor().getRuntime(id)?.loadedPluginSkillNames || []);
    return true;
  }

  function getEntry(sessionId: string) {
    return getSupervisor().getEntry(normalizeSessionId(sessionId));
  }

  async function getLiveEntry(sessionId: string): Promise<(SessionHandle<Agent> & { agent: Agent }) | null> {
    const id = normalizeSessionId(sessionId);
    const supervisor = getSupervisor();
    const entry = supervisor.peekEntry(id);
    if (!entry) return null;
    try {
      await entry.ready;
    } catch (_error) {
      return null;
    }
    return supervisor.peekEntry(id) === entry && entry.agent ? entry as SessionHandle<Agent> & { agent: Agent } : null;
  }

  function getAgent(sessionId: string) {
    return getSupervisor().getAgent(normalizeSessionId(sessionId));
  }

  async function collectDynamicContext(sessionId: string, request: Partial<Omit<ContextRequest, "sessionId">> = {}): Promise<DynamicContext> {
    const { values, sources, contextDiagnostics } = await collectContext({ reason: "snapshot", runId: "", ...request, sessionId });
    return { ...record(values.get("session")),
      ...(values.has("location") ? { location: record(values.get("location")) } : {}),
      ...(values.has("workingTab") ? { workingTab: record(values.get("workingTab")) } : {}),
      sources, contextDiagnostics };
  }

  return Object.freeze({
    createAgent,
    initializeAgent,
    handleEvent,
    persistRecord,
    ensureConversationForHistoryMutation,
    getEntry,
    getLiveEntry,
    getAgent,
  });
}

function isRetryableTerminalWriteError(error: unknown) {
  return !["SESSION_DELETED", "STALE_SESSION_LEASE"].includes(String(record(error).code || ""));
}

function isRetiredSessionEventError(error: unknown) {
  return ["SESSION_DELETED", "STALE_SESSION_LEASE"].includes(String(record(error).code || ""));
}

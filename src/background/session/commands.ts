import { t } from "../../shared/i18n/backend.js";
import type { Agent, AgentEvent, DynamicContext } from "../agent/agent.js";
import type { createSessionSupervisor, SessionTask } from "./supervisor.js";
import type { createSessionRepository } from "./repository.js";
import type { createSessionRuntimeState } from "./runtime-state.js";
import type { createSessionTranscript } from "./transcript.js";
import type { createSessionArtifacts } from "./artifacts.js";
import type { createSessionTabs } from "./tabs.js";
import type { createSessionAgentHost } from "./agent-host.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { TranscriptEntry } from "../../shared/contracts/session.js";
import type { ModelMessage } from "../../shared/contracts/model-message.js";
import type { chat as llmChat } from "../llm/index.js";
import type { getCurrentRuntimeConfig } from "../runtime-config.js";
import type { normalizeSessionRuntimeStatus } from "../../shared/session/session-runtime-status.js";
import type { createChatDocumentAttachmentService } from "../services/chat-document-attachments.js";
type Fields = Record<string, unknown>;
type Runtime = ReturnType<typeof createSessionRuntimeState>;
type Transcript = ReturnType<typeof createSessionTranscript>;
type Artifacts = ReturnType<typeof createSessionArtifacts>;
type Tabs = ReturnType<typeof createSessionTabs>;
type Host = ReturnType<typeof createSessionAgentHost>;
type Repository = ReturnType<typeof createSessionRepository>;
type Documents = ReturnType<typeof createChatDocumentAttachmentService>;
type PromptHook = ((message: unknown, admission: Fields) => unknown) | null;
interface PromptInput extends Fields {
  sessionId?: unknown; text?: string; images?: unknown[]; documents?: unknown;
  sourceWindowId?: number | null; clientMessageId?: string; onMessageAccepted?: PromptHook;
  swallowErrors?: boolean; deliveryMode?: string;
}
interface TaskContext { agent: Agent; task: SessionTask; sessionId: string; session: SessionMetadata | null }
interface TaskInput {
  sessionId?: unknown; operation?: (context: TaskContext) => Promise<{ status?: string; reason?: unknown } | null | void>;
  operationName?: string; swallowErrors?: boolean;
  admissionSignal?: AbortSignal;
}
interface SessionCommandsDependencies {
  assertDataConsent?(): void;
  runtime: Readonly<
    Pick<Runtime, "normalizeCurrentTool" | "set" | "persist" | "normalizePendingFollowUps"
      | "normalizeLoadedSkillNames" | "loadedSkillNames" | "remove">
    & Partial<Pick<Runtime, "queueFollowUpResume">>
  >;
  agents: Readonly<Pick<Host,
    "getLiveEntry" | "getAgent" | "ensureConversationForHistoryMutation" | "handleEvent"
  >>;
  transcript: Readonly<Pick<Transcript,
    "get" | "getConversation" | "set" | "resolveIdentities" | "recordEvent" | "remove"
    | "snapshot" | "checkpoint" | "finish" | "dropUnstartedUserMessage"
  >>;
  artifacts: Readonly<Pick<Artifacts,
    "clearListSummaryPatch" | "clearSummaryRefresh" | "buildListSummary" | "collect" | "empty"
  >>;
  tabs: Readonly<Pick<Tabs, "getOwnedTabContexts" | "closeOwnedTabsAfterTerminal">
    & Partial<Pick<Tabs, "restoreOwnedTabs">>>;
  sessionRuntimeReady: Promise<unknown>;
  sessionSupervisor: ReturnType<typeof createSessionSupervisor<Agent>>;
  sessionRepository: Repository;
  normalizeSessionId(value: unknown): string;
  requireExplicitSessionId(value: unknown, operation: string): string;
  normalizeRuntimeStatus: typeof normalizeSessionRuntimeStatus;
  getSessions: Repository["listMetadata"];
  isAutomationSessionTree(id: string, sessions: Record<string, SessionMetadata>, rootId: string): boolean;
  broadcast(event: Fields): unknown;
  getCurrentRuntimeConfig: typeof getCurrentRuntimeConfig;
  llmChat: typeof llmChat;
  buildSessionTitleMessages(text: string): ModelMessage[];
  collectBrowserContext(id: string, options: { sourceWindowId?: number | null }): Promise<DynamicContext>;
  releaseRunResources?(context: { sessionId: string; runId: string; eventType: string }): Promise<unknown>;
  removeChatMessageDocuments?: Documents["removeMessageDocuments"] | null;
  removeChatSessionDocuments?(id: string): Promise<unknown>;
  removeSessionObservations?(id: string): Promise<unknown>;
  blockChatDocumentParsing?(id: string): Promise<(() => void) | void>;
  observeAgentEvent?: ((id: string, event: AgentEvent) => unknown) | null;
  getAutomationRuntime(): { syncSessionOutcome(id: string): unknown };
  getAppVersion?(): string;
}
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
import type { ComposerDraft } from "../../shared/contracts/composer-draft.js";
import { isSessionFormatError } from "../../shared/session/session-format.js";
import {
  createSessionRecord,
  normalizeTranscript,
  createSessionTitle,
  getConversationPreview,
  readSessionRecord,
  transcriptFromConversation,
} from "../../shared/session/session-codec.js";
import {
  appendSessionExchangeImportCapsule,
  createSessionExchangePayload,
  hashSessionExchangeContent,
  normalizeSessionExchangePayload,
  settleImportedTranscript,
} from "../../shared/session/session-exchange.js";
import { mergeSessionListSummary } from "../../shared/session/session-list-summary.js";
import { isActiveSessionRuntimeStatus } from "../../shared/session/session-runtime-status.js";
import { normalizeParentSessionId, ROOT_SESSION_ID } from "../../shared/session/session-store.js";
import {
  groupSessionsByImportIdentity,
  sessionImportDedupEntryFromRecord,
  type SessionImportDedupEntry,
} from "./import-dedup-index.js";
import { compareBeijingDateTimeDesc, nowBeijingDateTime } from "../../shared/time-utils.js";
import { localizeToolFailurePayload } from "../../shared/tools/tool-error-localization.js";
import { assertMessageDocumentOwnership } from "../../shared/documents/document-attachments.js";
import { createKeyedSerialQueue } from "../internal/serial-queue.js";
import { formatTraceFields, trace } from "../trace.js";
import { getOwnedTabIds, normalizeVisitedTaskSites, normalizeWorkingTab } from "./tabs.js";
import {
  buildNextSessionGoal,
  buildNextSessionTracker,
  normalizeGoalAction,
  normalizeSessionGoal,
  normalizeSessionTracker,
  normalizeTrackerAction,
  summarizeSessionGoal,
  summarizeSessionTracker,
} from "./task-state.js";

const SESSION_WAIT_INFINITE_TIMEOUT_MS = 0;
const SESSION_WAIT_DEFAULT_TIMEOUT_MS = SESSION_WAIT_INFINITE_TIMEOUT_MS;
const SESSION_WAIT_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function traceMessageDelivery(phase: string, sessionId: string, clientMessageId: string, fields: Fields = {}) {
  trace(`message_delivery_trace${formatTraceFields({
    phase,
    session: sessionId,
    message: clientMessageId,
    ...fields,
  })}`);
}

export function createSessionCommands(deps: SessionCommandsDependencies) {
  const {
    assertDataConsent = () => {},
    sessionRuntimeReady,
    sessionSupervisor,
    sessionRepository,
    normalizeSessionId,
    requireExplicitSessionId,
    normalizeRuntimeStatus,
    getSessions,
    isAutomationSessionTree,
    broadcast,
    getCurrentRuntimeConfig,
    llmChat,
    buildSessionTitleMessages,
    collectBrowserContext,
    releaseRunResources = async () => ({ released: 0 }),
    removeChatMessageDocuments = null,
    removeChatSessionDocuments = async () => {},
    removeSessionObservations = async () => {},
    blockChatDocumentParsing = async () => {},
    observeAgentEvent = null,
    getAutomationRuntime,
    getAppVersion = () => "",
  } = deps;
  // Capture method references once, including hosts supplied by tests or other compositions.
  const runtimeState = Object.freeze({ ...deps.runtime });
  const agentHost = Object.freeze({ ...deps.agents });
  const sessionTranscript = Object.freeze({ ...deps.transcript });
  const sessionArtifacts = Object.freeze({ ...deps.artifacts });
  const sessionTabs = Object.freeze({ ...deps.tabs });
  const { queueFollowUpResume = () => {} } = runtimeState;
  const { restoreOwnedTabs = async () => ({
    restored: false,
    code: "SESSION_OWNED_TABS_RESTORE_UNAVAILABLE",
    reason: "restore_unavailable",
  }) } = sessionTabs;

  const createStoredSession = (input: Parameters<Repository["createMetadata"]>[0]) => sessionRepository.createMetadata(input);
  const deleteStoredSession = (sessionId: string) => sessionRepository.deleteSession(sessionId);
  const composerDraftMutations = createKeyedSerialQueue();
  const automationRuntime = {
    syncSessionOutcome: (id: string) => getAutomationRuntime().syncSessionOutcome(id),
  };

async function canManageSessionTools(sessionId = "") {
  await sessionRuntimeReady;
  const id = normalizeCanManageSessionId(sessionId);
  if (!id) return true;
  const sessions = await getSessions();
  const session = sessions[id];
  if (!session) return true;
  if (isAutomationSessionTree(id, sessions, ROOT_SESSION_ID)) return false;
  return normalizeParentSessionId(session.parentSessionId) === ROOT_SESSION_ID;
}

async function canUseSessionGoal(sessionId = "") {
  return await canManageSessionTools(sessionId);
}

function canExposeSessionGoal(session: Partial<SessionMetadata> | null = null) {
  if (!session) return true;
  if (session.source === "automation") return false;
  return normalizeParentSessionId(session.parentSessionId) === ROOT_SESSION_ID;
}

function normalizeCanManageSessionId(value: unknown = "") {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return String(object(value).sessionId || "").trim();
  }
  return "";
}


async function listSessionsRuntime({ limit = 100, excludeSessionId = "" } = {}) {
  await sessionRuntimeReady;
  const max = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const excluded = typeof excludeSessionId === "string" ? excludeSessionId.trim() : "";
  const sessions = Object.values(await getSessions())
    .filter((session) => session?.source !== "automation")
    .filter((session) => !excluded || session.id !== excluded)
    .sort((a, b) => compareBeijingDateTimeDesc(a.updatedAt, b.updatedAt))
    .slice(0, max)
    .map((session) => formatSessionRuntimeRecord(session));
  return { sessions };
}


async function createSessionRuntime({ title = "", firstMessage = "", parentSessionId = ROOT_SESSION_ID }: Fields = {}, signal?: AbortSignal) {
  await sessionRuntimeReady;
  signal?.throwIfAborted();
  const message = String(firstMessage || "").trim();
  const normalizedParentId = normalizeParentSessionId(parentSessionId);
  const session = await createStoredSession({
    title,
    firstMessage: message,
    parentSessionId: normalizedParentId,
    titleSource: normalizedParentId === ROOT_SESSION_ID
      ? (String(title || "").trim() ? "manual" : "first_message") : "fixed",
  });
  signal?.throwIfAborted();
  broadcast({ type: "session_created", session, firstMessage: message });
  broadcast({ type: "sessions_changed", action: "create", sessionId: session.id, session });
  const started = launchSessionPrompt(session.id, message, signal);
  return { session, started };
}

async function createSessionMetadataRuntime({
  id = "",
  title = "",
  firstMessage = "",
  parentSessionId = ROOT_SESSION_ID,
  titleSource = "",
  source = "",
  automationId = "",
  automationRunId = "",
  composerDraft = null,
  windowId = null,
}: Fields = {}, signal?: AbortSignal) {
  const text = String(firstMessage || "").trim();
  const normalizedParentId = normalizeParentSessionId(parentSessionId);
  const initialDraft = normalizeComposerDraft(composerDraft, "");
  const draftWindowKey = composerDraftHasContent(initialDraft) ? composerWindowKey(windowId) : "";
  const create = async () => {
    await sessionRuntimeReady;
    signal?.throwIfAborted();
    const session = await createStoredSession({
      id,
      title: title || text,
      firstMessage: "",
      parentSessionId: normalizedParentId,
      titleSource: titleSource || (normalizedParentId === ROOT_SESSION_ID ? "first_message" : "fixed"),
      source,
      automationId,
      automationRunId,
    });
    signal?.throwIfAborted();
    if (draftWindowKey) {
      runtimeState.set(session.id, {
        composerDrafts: {
          ...object(sessionSupervisor.getRuntime(session.id)?.composerDrafts),
          [draftWindowKey]: normalizeComposerDraft(initialDraft, session.id),
        },
      });
      await runtimeState.persist(session.id);
    }
    broadcast({ type: "session_created", session, firstMessage: text });
    broadcast({ type: "sessions_changed", action: "create", sessionId: session.id, session });
    return { session };
  };
  const requestedId = String(id || "").trim();
  return draftWindowKey && requestedId ? composerDraftMutations.run(requestedId, create) : create();
}

async function renameSessionRuntime({ sessionId, title }: Fields = {}) {
  await sessionRuntimeReady;
  const id = requireExplicitSessionId(sessionId, "rename_session");
  const rawTitle = String(title ?? "").replace(/\s+/gu, " ").trim();
  if (!rawTitle) {
    const error = new Error(t("session.titleRequired"));
    Object.assign(error, { code: "SESSION_TITLE_REQUIRED" });
    throw error;
  }

  let result;
  try {
    result = await sessionRepository.updateMetadata(id, (session) => ({
      ...session,
      title: createSessionTitle(rawTitle),
      titleSource: "manual",
    }));
  } catch (error) {
    if (/^session not found:/u.test(String(errorMessage(error)))) {
      const missing = new Error(t("session.renameMissing"));
      Object.assign(missing, { code: "SESSION_NOT_FOUND" });
      throw missing;
    }
    throw error;
  }

  if (result.changed) {
    broadcast({
      type: "sessions_changed",
      action: "title",
      sessionId: id,
      session: result.session,
    });
  }
  return {
    renamed: result.changed,
    sessionId: id,
    session: result.session,
  };
}

function scheduleRootSessionTitleGeneration(session: SessionMetadata | null, firstMessage: unknown) {
  const sessionId = typeof session?.id === "string" && session.id.trim() ? session.id.trim() : "";
  const promptText = String(firstMessage || "").trim();
  if (!sessionId || !promptText || promptText === "[图片]") return;
  if (normalizeParentSessionId(session?.parentSessionId) !== ROOT_SESSION_ID) return;
  if (session?.titleSource && session.titleSource !== "first_message") return;

  const initialTitle = String(session?.title || "");
  Promise.resolve()
    .then(() => generateSessionTitleFromFirstMessage(promptText, sessionId))
    .then((generatedTitle) => applyGeneratedSessionTitle({
      sessionId,
      generatedTitle,
      initialTitle,
    }))
    .catch((err) => {
      console.warn("[轻舟] generate session title failed", err);
    });
}

async function generateSessionTitleFromFirstMessage(firstMessage: unknown, sessionId: string) {
  const text = String(firstMessage || "").trim().slice(0, 2000);
  const runtimeConfig = await getCurrentRuntimeConfig();
  const { message } = await llmChat(buildSessionTitleMessages(text), [], undefined, {
    sessionId: `${sessionId}:title`,
    config: runtimeConfig,
    rateLimit: false,
  });
  return cleanGeneratedSessionTitle(message?.content);
}

async function applyGeneratedSessionTitle({ sessionId, generatedTitle, initialTitle }: { sessionId: string; generatedTitle: unknown; initialTitle: string }) {
  const title = cleanGeneratedSessionTitle(generatedTitle);
  if (!title) return null;
  const result = await sessionRepository.updateMetadata(sessionId, (session) => {
    if (normalizeParentSessionId(session.parentSessionId) !== ROOT_SESSION_ID) return null;
    if (session.titleSource && session.titleSource !== "first_message") return null;
    if (initialTitle && String(session?.title || "") !== initialTitle) return null;
    return {
      ...session,
      title,
      titleSource: "generated",
      titleGeneratedAt: nowBeijingDateTime(),
    };
  });
  const updated = result.changed ? result.session : null;
  if (updated) {
    broadcast({ type: "sessions_changed", action: "title", sessionId, session: updated });
  }
  return updated;
}

function cleanGeneratedSessionTitle(text: unknown) {
  const raw = String(text || "")
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean) || "";
  const cleaned = raw
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "")
    .replace(/^(标题|title)\s*[:：]\s*/iu, "")
    .replace(/^[\-\d.、)\s]+/u, "")
    .replace(/[。！？!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return createSessionTitle(cleaned);
}

async function saveSessionRecordRuntime({ sessionId, conversation, transcript }: Fields = {}) {
  return persistSessionRecord({ sessionId, conversation, transcript }, false);
}

async function commitSessionRecordRuntime({ sessionId, conversation }: Fields = {}) {
  return persistSessionRecord({ sessionId, conversation }, true);
}

async function persistSessionRecord({ sessionId, conversation, transcript }: Fields, commit: boolean) {
  await sessionRuntimeReady;
  const id = normalizeSessionId(sessionId);
  if (!id) return { saved: false, reason: "missing_session_id" };
  sessionArtifacts.clearListSummaryPatch(id);

  const session = await sessionRepository.getMetadata(id);
  if (!session) return { saved: false, reason: "missing_session", sessionId: id };

  const resolvedConversation = await sessionTranscript.getConversation(id, conversation);
  const replacement = Array.isArray(transcript) ? sessionTranscript.resolveIdentities(transcript) : null;
  if (!replacement) await sessionTranscript.get(id, resolvedConversation);
  const snapshot = replacement ? { history: replacement, current: [] } : sessionTranscript.snapshot(id);

  const record = {
    ...createSessionRecord(resolvedConversation, sessionTranscript.resolveIdentities([...snapshot.history])),
    currentTranscript: normalizeTranscript(sessionTranscript.resolveIdentities([...snapshot.current])),
  };
  const now = nowBeijingDateTime();
  const checkpoint = !commit && !replacement ? sessionTranscript.checkpoint(id) : null;
  if (checkpoint) await checkpoint;
  else await sessionRepository.writeRecord(id, record, undefined, replacement ? undefined : snapshot.history);
  if (replacement) sessionTranscript.set(id, replacement);
  const result = await sessionRepository.updateMetadata(id, async (current) => {
    const listSummary = mergeSessionListSummary(
      current.listSummary,
      await sessionArtifacts.buildListSummary(id, [...record.transcript, ...record.currentTranscript], now),
    );
    return {
      ...current,
      updatedAt: now,
      title: current.title || createSessionTitle(getConversationPreview(record.conversation)),
      listSummary,
    };
  });
  broadcast({ type: "sessions_changed", action: "save", sessionId: id, session: result.session });
  return { saved: true, sessionId: id };
}

async function exportSessionExchangeRuntime(sessionId: string) {
  await sessionRuntimeReady;
  const id = requireExplicitSessionId(sessionId, "export_session_exchange");
  const sessions = await getSessions();
  const session = sessions[id];
  if (!session) {
    const err = new Error(t("session.exportMissing"));
    Object.assign(err, { code: "SESSION_NOT_FOUND" });
    throw err;
  }

  const conversation = await sessionTranscript.getConversation(id);
  const transcript = await sessionTranscript.get(id, conversation);
  const snapshot = await getSessionRuntimeStateForOutput(id);
  let ownedTabs: Fields[] = [];
  const workingTabId = Number(snapshot.workingTabId || snapshot.workingTab?.id);
  try {
    ownedTabs = (await sessionTabs.getOwnedTabContexts(id, null, { titleLimit: 120 })).map(tab => ({
      ...tab,
      title: tab.title || (
        Number(tab?.id) === workingTabId
          ? snapshot.workingTitle || snapshot.workingTab?.title || ""
          : ""
      ),
      working: Number(tab?.id) === workingTabId,
    }));
  } catch (_error) {
    // Workspace continuity is optional; a transient Chrome tab lookup failure
    // must not prevent the conversation itself from being exported.
  }
  const runtime = {
    ...snapshot,
    ownedTabs,
    workingTab: null,
    workingTabId: null,
    workingUrl: "",
    workingTitle: "",
    loadedPluginSkillNames: runtimeState.normalizeLoadedSkillNames(sessionSupervisor.getRuntime(id)?.loadedPluginSkillNames),
    exchangeDependencies: sessionSupervisor.getRuntime(id)?.exchangeDependencies || null,
  };
  return createSessionExchangePayload({
    session,
    conversation,
    transcript,
    runtime,
    appVersion: getAppVersion(),
  });
}

async function importSessionExchangeRuntime(value: unknown, { sourceWindowId = null }: { sourceWindowId?: number | null } = {}) {
  await sessionRuntimeReady;
  const payload = normalizeSessionExchangePayload(value);
  const contentHash = await hashSessionExchangeContent(payload.session.conversation);
  const existing = await findReusableImportedSession(payload.source.sessionId, contentHash);
  if (existing) {
    await rememberImportedExchangeIdentity(existing.id, payload.source.sessionId, contentHash);
    const session = (await getSessions())[existing.id] || existing;
    return {
      imported: true,
      session,
      dependencies: payload.dependencies,
      ownedTabsRestore: null,
    };
  }

  const session = await createStoredSession({
    title: payload.session.title,
    firstMessage: "",
    parentSessionId: ROOT_SESSION_ID,
    titleSource: "fixed",
  });

  const saved = await saveSessionRecordRuntime({
    sessionId: session.id,
    conversation: appendSessionExchangeImportCapsule(payload.session.conversation),
    transcript: settleImportedTranscript(payload.session.transcript),
  });
  if (!saved.saved) {
    await deleteStoredSession(session.id).catch(() => null);
    const err = new Error(t("session.writeFailed"));
    Object.assign(err, { code: "SESSION_IMPORT_SAVE_FAILED" });
    throw err;
  }

  runtimeState.set(session.id, {
    status: payload.runtime.status,
    running: false,
    pendingStart: false,
    interrupted: false,
    runId: null,
    waitId: "",
    waitMessage: "",
    waitTitle: "",
    waitForm: null,
    reason: "",
    currentTool: null,
    tracker: null,
    goal: payload.runtime.goal,
    workingTab: null,
    workingTabId: null,
    workingUrl: "",
    workingTitle: "",
    ownedTabIds: [],
    visitedTaskSites: [],
    pendingFollowUpMessages: [],
    pendingSteeringMessages: [],
    loadedPluginSkillNames: payload.dependencies.skills,
    exchangeDependencies: payload.dependencies,
  });
  await runtimeState.persist();

  let ownedTabsRestore = null;
  if (payload.runtime.ownedTabs.length) {
    const failedRestore = {
      restored: false,
      requested: payload.runtime.ownedTabs.length,
      restoredCount: 0,
      failedCount: payload.runtime.ownedTabs.length,
      workingTabRestored: false,
    };
    try {
      ownedTabsRestore = {
        ...failedRestore,
        ...await restoreOwnedTabs({
          sessionId: session.id,
          tabs: payload.runtime.ownedTabs,
          source: "session_import",
          sourceWindowId,
        }),
      };
    } catch (error) {
      ownedTabsRestore = {
        ...failedRestore,
        code: object(error).code || "SESSION_OWNED_TABS_RESTORE_FAILED",
        reason: "restore_failed",
      };
    }
  }

  await rememberImportedExchangeIdentity(session.id, payload.source.sessionId, contentHash);
  const importedSessions = await getSessions();
  const imported = importedSessions[session.id] || null;
  if (!imported) {
    return {
      imported: false,
      session: null,
      dependencies: payload.dependencies,
      ownedTabsRestore,
      reason: "session_deleted",
    };
  }
  broadcast({ type: "session_created", session: imported, firstMessage: "" });
  broadcast({ type: "sessions_changed", action: "import", sessionId: session.id, session: imported });
  return {
    imported: true,
    session: imported,
    dependencies: payload.dependencies,
    ownedTabsRestore,
  };
}

async function findReusableImportedSession(sourceSessionId: string, contentHash: string) {
  const sourceId = String(sourceSessionId || "").trim();
  const sessions = Object.values(await getSessions());
  const indexed = groupSessionsByImportIdentity(sessions);
  if (sourceId) {
    const tagged = latestSession(indexed.bySourceId.get(sourceId) || []);
    if (tagged) return tagged;
  }
  const hashed = latestSession(indexed.byContentHash.get(contentHash) || []);
  if (hashed) return hashed;

  // Copies imported before the source id was stored still carry the import capsule.
  // The session that was exported does not, so the first import keeps its own id.
  return findLegacyImportedSession(indexed.unmarked, contentHash);
}

async function findLegacyImportedSession(unmarked: SessionMetadata[], contentHash: string) {
  if (!unmarked.length) return null;
  let entries: Record<string, SessionImportDedupEntry | null> | null = null;
  try {
    entries = await sessionRepository.readImportDedupEntries(unmarked.map(session => session.id));
  } catch (error) {
    console.warn("[轻舟] import dedup index update failed", error);
  }
  const legacy: SessionMetadata[] = [];
  const discovered: Record<string, SessionImportDedupEntry> = {};
  for (const session of unmarked) {
    const cached = entries?.[session.id] ?? null;
    if (cached) {
      if (cached.contentHash === contentHash) legacy.push(session);
      continue;
    }
    const observation = await observeUnmarkedImportSession(session);
    if (!observation) continue;
    discovered[session.id] = observation;
    if (observation.contentHash === contentHash) legacy.push(session);
  }
  if (Object.keys(discovered).length) {
    try {
      await sessionRepository.rememberImportDedupEntries(discovered);
    } catch (error) {
      console.warn("[轻舟] import dedup index update failed", error);
    }
  }
  return latestSession(legacy);
}

async function observeUnmarkedImportSession(session: SessionMetadata) {
  try {
    return await sessionImportDedupEntryFromRecord(await sessionRepository.readRecord(session.id));
  } catch {
    return null;
  }
}

async function rememberImportedExchangeIdentity(sessionId: string, sourceSessionId: string, contentHash: string) {
  const sourceId = String(sourceSessionId || "").trim();
  await sessionRepository.patchMetadata(sessionId, current => ({
    ...current,
    exchangeContentHash: contentHash,
    ...(sourceId ? { exchangeSourceSessionId: sourceId } : {}),
  }));
}

function latestSession(sessions: SessionMetadata[]) {
  return [...sessions].sort((left, right) => {
    const byTime = compareBeijingDateTimeDesc(left.updatedAt, right.updatedAt);
    if (byTime) return byTime;
    return String(right.id).localeCompare(String(left.id));
  })[0] || null;
}

async function startSessionAgentTask({
  sessionId,
  operation,
  operationName = "prompt",
  swallowErrors = false,
  admissionSignal,
}: TaskInput = {}) {
  const spec = createSessionAgentTaskSpec({ sessionId, operation, operationName, swallowErrors, admissionSignal });
  return sessionSupervisor.startTask(spec.sessionId, spec.executor, spec.options);
}

function createSessionAgentTaskSpec({
  sessionId,
  operation,
  operationName = "prompt",
  swallowErrors = false,
  admissionSignal,
}: TaskInput = {}) {
  admissionSignal?.throwIfAborted();
  assertDataConsent();
  const id = requireExplicitSessionId(sessionId, operationName);
  if (typeof operation !== "function") throw new TypeError(`${operationName} requires an operation`);
  const startedAt = nowBeijingDateTime();
  let session: SessionMetadata | null = null;
  const executor = async ({ agent, task }: { agent: Agent; task: SessionTask }) => {
    let terminal: { status?: string; reason?: unknown } | null | void = null;
    const scheduleEpoch = agent.queueScheduleEpoch;
    try {
      if (task.cancelled) return;
      terminal = await operation({ agent, task, sessionId: id, session });
    } catch (err) {
      if (agent.queueScheduleEpoch === scheduleEpoch) {
        terminal = { status: "error", reason: errorMessage(err) };
      }
      if (terminal && !task.cancelled && sessionSupervisor.getTask(id) === task) {
        if (swallowErrors) agentHost.handleEvent(id, { type: "error", message: errorMessage(err) });
      }
      if (!swallowErrors) throw err;
    } finally {
      if (sessionSupervisor.getTask(id) === task) {
        const runtime = sessionSupervisor.getRuntime(id);
        if (runtime?.status === "pending"
          && (terminal?.status === "error" || (!agent.isRunning && !agent.hasPendingUserInput()))) {
          const failed = terminal?.status === "error";
          const settledRuntime = runtimeState.set(id, {
            status: task.cancelled ? "cancelled" : failed ? "error" : "completed",
            running: false,
            pendingStart: false,
            endedAt: nowBeijingDateTime(),
            reason: task.cancelled ? "cancelled_before_start" : failed ? String(terminal?.reason || "error") : "",
          });
          await runtimeState.persist(id, { terminal: true });
          broadcast({
            type: "state",
            sessionId: id,
            isStreaming: false,
            runId: settledRuntime?.runId || null,
            hasHistory: Boolean(agent.messages?.length > 1),
            status: settledRuntime?.status,
            runtime: settledRuntime,
          });
        }
        broadcast({ type: "sessions_changed", action: "run_state", sessionId: id });
      }
    }
  };
  const onStart = async () => {
    admissionSignal?.throwIfAborted();
    session = await sessionRepository.getMetadata(id);
    admissionSignal?.throwIfAborted();
    if (!session) {
      const error = new Error(`session not found: ${id}`);
      Object.assign(error, { code: "SESSION_NOT_FOUND" });
      throw error;
    }
    runtimeState.set(id, {
      status: "pending",
      running: true,
      pendingStart: true,
      interrupted: false,
      runId: null,
      waitId: "",
      startedAt,
      endedAt: "",
      reason: "",
      tracker: null,
    });
    broadcast({ type: "sessions_changed", action: "run_state", sessionId: id });
  };
  return {
    sessionId: id,
    executor,
    options: {
      startedAt,
      onStart,
    },
  };
}

async function startSessionPromptTask(params: PromptInput = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const prompt = prepareSessionPrompt(params);
  const existing = await sessionSupervisor.withAgent(prompt.sessionId, agent => (
    agent.findAcceptedUserMessage?.(prompt.clientMessageId) || null
  ));
  signal?.throwIfAborted();
  if (existing) {
    traceMessageDelivery("session.duplicate_accepted", prompt.sessionId, prompt.clientMessageId);
    void notifyMessageAccepted(prompt.onMessageAccepted, existing, {
      disposition: "started",
      duplicate: true,
    });
    return {
      sessionId: prompt.sessionId,
      duplicate: true,
      cancelled: false,
      promise: Promise.resolve({ status: "accepted", duplicate: true }),
    };
  }
  return startSessionAgentTask({
    sessionId: prompt.sessionId,
    operationName: "prompt",
    swallowErrors: prompt.swallowErrors,
    operation: prompt.operation,
    admissionSignal: signal,
  });
}

async function submitSessionMessageRuntime(params: PromptInput = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const deliveryMode = params.deliveryMode || "follow_up";
  if (!["follow_up", "steer"].includes(deliveryMode)) throw new Error("Invalid message deliveryMode");
  let resolveAcceptance: (message: unknown) => void = () => {};
  const acceptance = new Promise<unknown>(resolve => { resolveAcceptance = resolve; });
  const prompt = prepareSessionPrompt({
    ...params,
    onMessageAccepted: async (message, admission) => {
      resolveAcceptance(message);
      await params.onMessageAccepted?.(message, admission);
    },
  });
  const spec = createSessionAgentTaskSpec({
    sessionId: prompt.sessionId,
    operationName: "submit_message",
    swallowErrors: prompt.swallowErrors,
    operation: prompt.operation,
    admissionSignal: signal,
  });
  const admission = await sessionSupervisor.submitMessage(prompt.sessionId, {
    executor: spec.executor,
    ...spec.options,
    messageId: prompt.clientMessageId,
    acceptance,
    findExisting: ({ agent }) => {
      signal?.throwIfAborted();
      const accepted = agent.findAcceptedUserMessage?.(prompt.clientMessageId) || null;
      if (accepted) return {
        disposition: "started",
        message: accepted,
      };
      const queued = agent.findPendingUserMessage?.(prompt.clientMessageId) || null;
      if (!queued) return null;
      return {
        disposition: "queued",
        message: queued,
      };
    },
    enqueue: async ({ agent }) => {
      signal?.throwIfAborted();
      await agent.followUp(
        prompt.text,
        prompt.images,
        prompt.clientMessageId,
        prompt.documents,
        () => runtimeState.persist(prompt.sessionId),
        deliveryMode,
      );
      return {
        message: agent.findPendingUserMessage?.(prompt.clientMessageId) || null,
      };
    },
  });
  if (admission.duplicate && admission.disposition === "started" && !admission.message) {
    admission.message = await waitForTaskMessageAcceptance(admission.task);
  }
  if (admission.duplicate) {
    traceMessageDelivery("session.duplicate_accepted", prompt.sessionId, prompt.clientMessageId, {
      disposition: admission.disposition,
    });
  }
  if (admission.disposition === "queued" || admission.duplicate) {
    if (admission.disposition === "queued") await runtimeState.persist(prompt.sessionId);
    await notifyMessageAccepted(prompt.onMessageAccepted, admission.message, admission);
  }
  return {
    accepted: true,
    sessionId: prompt.sessionId,
    disposition: admission.disposition,
    duplicate: admission.duplicate,
    cancelled: admission.task?.cancelled === true,
    promise: admission.task?.promise || Promise.resolve({ status: admission.disposition }),
  };
}

function waitForTaskMessageAcceptance(task: SessionTask | null | undefined) {
  if (!task?.messageAcceptance || !task?.promise) {
    throw sessionError("MESSAGE_ADMISSION_LOST", t("session.admissionLost"));
  }
  return Promise.race([
    task.messageAcceptance,
    task.promise.then(() => {
      throw sessionError("MESSAGE_NOT_ACCEPTED", t("session.notAccepted"));
    }),
  ]);
}

function prepareSessionPrompt({
  sessionId,
  text,
  images = [],
  documents = [],
  sourceWindowId = null,
  clientMessageId = "",
  onMessageAccepted = null,
  swallowErrors = false,
}: PromptInput = {}) {
  const id = requireExplicitSessionId(sessionId, "prompt");
  const promptText = String(text || "").trim();
  const promptImages = Array.isArray(images) ? images : [];
  const promptDocuments = assertMessageDocumentOwnership(documents, { sessionId: id, messageId: clientMessageId });
  if (!promptText && !promptImages.length && !promptDocuments.length) throw new Error("prompt requires text or attachments");
  const titleSeed = promptText
    || String(promptDocuments[0]?.filename || "").trim()
    || String(object(promptImages[0]).name || "").trim()
    || (promptImages.length ? "[图片]" : "");
  return {
    sessionId: id,
    clientMessageId,
    text: promptText,
    images: promptImages,
    documents: promptDocuments,
    onMessageAccepted,
    swallowErrors,
    operation: async ({ agent, task, session }: TaskContext) => {
      const contextStartedAt = Date.now();
      traceMessageDelivery("context.started", id, clientMessageId);
      let context;
      try {
        context = await collectBrowserContext(id, { sourceWindowId });
      } catch (error) {
        traceMessageDelivery("context.failed", id, clientMessageId, {
          code: object(error).code || object(error).name || "ERROR",
          error: errorMessage(error),
          elapsedMs: Date.now() - contextStartedAt,
        });
        throw error;
      }
      traceMessageDelivery("context.collected", id, clientMessageId, {
        elapsedMs: Date.now() - contextStartedAt,
      });
      if (task.cancelled) {
        traceMessageDelivery("session.cancelled_before_agent", id, clientMessageId);
        return;
      }
      await agent.prompt(
        promptText,
        context,
        promptImages,
        clientMessageId,
        promptDocuments,
        async message => {
          void scheduleTitleForFirstAcceptedPrompt(id, session, titleSeed)
            .catch(error => console.warn("[轻舟] accepted title generation failed", error));
          await notifyMessageAccepted(onMessageAccepted, message, {
            disposition: "started",
            duplicate: false,
          });
        },
      );
    },
  };
}

function notifyMessageAccepted(callback: PromptHook | undefined, message: unknown, admission: Fields = {}) {
  return Promise.resolve()
    .then(() => callback?.(message, admission))
    .catch(error => console.warn("[轻舟] accepted message side effect failed", error));
}

async function scheduleTitleForFirstAcceptedPrompt(sessionId: string, session: SessionMetadata | null, titleSeed: string) {
  const seed = String(titleSeed || "").trim();
  if (!seed || seed === "[图片]") return false;
  if (normalizeParentSessionId(session?.parentSessionId) !== ROOT_SESSION_ID) return false;
  if (session?.titleSource && session.titleSource !== "first_message") return false;
  const transcript = await sessionTranscript.get(sessionId);
  if (transcript.filter(entry => entry?.type === "user" || object(entry).role === "user").length > 1) return false;
  scheduleRootSessionTitleGeneration(session, seed);
  return true;
}

function launchSessionPrompt(sessionId: string, firstMessage: unknown, signal?: AbortSignal) {
  const text = String(firstMessage || "").trim();
  if (!text) return false;
  startSessionPromptTask({ sessionId, text, swallowErrors: true }, signal)
    .then(task => task.promise)
    .catch((err) => console.warn("[轻舟] launch session prompt failed:", err));
  return true;
}

function createSessionFromApi(params: Fields = {}, signal?: AbortSignal) {
  return createSessionRuntime({
    title: params.title || "",
    firstMessage: params.firstMessage || params.text || "",
    parentSessionId: params.parentSessionId || ROOT_SESSION_ID,
  }, signal);
}

function createUiSessionFromApi(params: Fields = {}) {
  return createSessionMetadataRuntime({
    id: params.id,
    title: params.title || params.firstMessage || "",
    firstMessage: params.firstMessage || "",
    parentSessionId: params.parentSessionId || ROOT_SESSION_ID,
    composerDraft: params.composerDraft,
    windowId: params.windowId,
  });
}

async function followUpSessionRuntime(params: PromptInput = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sessionId = requireExplicitSessionId(params.sessionId, "follow_up");
  const documents = assertMessageDocumentOwnership(params.documents, {
    sessionId,
    messageId: params.clientMessageId,
  });
  if (!String(params.text || "").trim() && !(params.images || []).length && !documents.length) {
    throw new Error("follow_up requires text or attachments");
  }
  await sessionSupervisor.withAgent(sessionId, agent => {
    signal?.throwIfAborted();
    return agent.followUp(
      params.text || "", params.images || [], params.clientMessageId || "", documents,
      () => runtimeState.persist(sessionId),
    );
  });
  await runtimeState.persist(sessionId);
  return { accepted: true, sessionId };
}

async function getSessionComposerDraftRuntime(params: Fields = {}) {
  const sessionId = requireExplicitSessionId(params.sessionId, "get_composer_draft");
  const windowKey = composerWindowKey(params.windowId);
  return composerDraftMutations.run(sessionId, async () => {
    await sessionRuntimeReady;
    return {
      sessionId,
      draft: normalizeComposerDraft(object(sessionSupervisor.getRuntime(sessionId)?.composerDrafts)[windowKey], sessionId),
    };
  });
}

async function saveSessionComposerDraftRuntime(params: Fields = {}) {
  const sessionId = requireExplicitSessionId(params.sessionId, "sync_composer_draft");
  const windowKey = composerWindowKey(params.windowId);
  const draft = normalizeComposerDraft(params.draft || {}, sessionId);
  return composerDraftMutations.run(sessionId, async () => {
    await sessionRuntimeReady;
    if (!await sessionRepository.getMetadata(sessionId)) throw sessionError(
      "SESSION_NOT_FOUND",
      `session not found: ${sessionId}`,
    );
    const drafts = { ...object(sessionSupervisor.getRuntime(sessionId)?.composerDrafts) };
    const current = normalizeComposerDraft(drafts[windowKey], sessionId);
    if (current && draft && current.updatedAt > draft.updatedAt) return { sessionId, draft: current };
    if (composerDraftHasContent(draft)) drafts[windowKey] = draft;
    else delete drafts[windowKey];
    runtimeState.set(sessionId, { composerDrafts: drafts });
    await runtimeState.persist(sessionId);
    return { sessionId, draft: drafts[windowKey] || null };
  });
}

async function consumeSessionComposerDraftRuntime(params: Fields = {}) {
  const sessionId = requireExplicitSessionId(params.sessionId, "consume_composer_draft");
  const windowKey = composerWindowKey(params.windowId);
  const messageId = String(params.messageId || "").trim();
  return composerDraftMutations.run(sessionId, async () => {
    await sessionRuntimeReady;
    const current = normalizeComposerDraft(object(sessionSupervisor.getRuntime(sessionId)?.composerDrafts)[windowKey], sessionId);
    if (!current || current.messageId !== messageId) return false;
    const drafts = { ...object(sessionSupervisor.getRuntime(sessionId)?.composerDrafts) };
    delete drafts[windowKey];
    runtimeState.set(sessionId, { composerDrafts: drafts });
    await runtimeState.persist(sessionId);
    return true;
  });
}

async function steerSessionFollowUpRuntime(params: Fields = {}) {
  const sessionId = requireExplicitSessionId(params.sessionId, "steer_follow_up");
  const clientMessageId = String(params.clientMessageId || "").trim();
  const result = await sessionSupervisor.withAgent(sessionId, agent => {
    const removal = agent.steerFollowUp(clientMessageId);
    return {
      moved: Boolean(removal),
      pendingFollowUps: agent.getPendingFollowUps(),
      pendingSteerings: agent.getPendingSteerings(),
    };
  });
  await runtimeState.persist(sessionId);
  return { sessionId, ...result };
}

async function resendSessionMessageRuntime(params: PromptInput = {}) {
  const sessionId = requireExplicitSessionId(params.sessionId, "resend_prompt");
  const documents = assertMessageDocumentOwnership(params.documents, {
    sessionId,
    messageId: params.clientMessageId,
  });
  const task = await startSessionAgentTask({
    sessionId,
    operationName: "resend_prompt",
    operation: async ({ agent, task: activeTask }) => {
      const context = await collectBrowserContext(sessionId, {
        sourceWindowId: params.sourceWindowId,
      });
      if (activeTask.cancelled) return;
      await agent.editUserMessageAndRerun({
        clientMessageId: params.clientMessageId || "",
        text: params.text || "",
        images: params.images || [],
        documents,
        context,
        onReplaced: async ({ conversation }) => {
          const transcript = transcriptFromConversation(conversation);
          // The replacement user is already accepted; agent_start will bind it.
          sessionTranscript.set(sessionId, transcript.slice(0, -1), transcript.slice(-1));
          await commitSessionRecordRuntime({ sessionId, conversation });
          broadcast({ type: "transcript_replace", sessionId, transcript });
        },
      });
    },
  });
  await task.promise;
  return { sessionId, replaced: true };
}

async function deleteSessionFollowUpRuntime(sessionId: string, clientMessageId = "") {
  return deleteQueuedSessionMessageRuntime({
    sessionId,
    clientMessageId,
    operationName: "delete_follow_up",
    remove: (agent, beforeCommit) => agent.removeFollowUp(clientMessageId, beforeCommit),
  });
}

async function deleteSessionSteeringRuntime(sessionId: string, clientMessageId = "") {
  return deleteQueuedSessionMessageRuntime({
    sessionId,
    clientMessageId,
    operationName: "delete_steering",
    remove: (agent, beforeCommit) => agent.removeSteering(clientMessageId, beforeCommit),
  });
}

async function deleteQueuedSessionMessageRuntime({
  sessionId,
  clientMessageId = "",
  operationName,
  remove,
}: { sessionId: string; clientMessageId?: string; operationName: string; remove(agent: Agent, beforeCommit: Parameters<Agent["removeFollowUp"]>[1]): ReturnType<Agent["removeFollowUp"]> }) {
  const id = requireExplicitSessionId(sessionId, operationName);
  const removal = await sessionSupervisor.withAgent(id, agent => remove(agent, async message => {
    const messageId = String(message?.clientMessageId || "").trim();
    const documents = assertMessageDocumentOwnership(message?.documents, { sessionId: id, messageId });
    if (!documents.length) {
      return { attachmentCount: 0, deletedFileCount: 0, deletedModelCount: 0 };
    }
    if (typeof removeChatMessageDocuments !== "function") {
      const error = new Error("queued document attachment cleanup is unavailable");
      Object.assign(error, { code: "DOCUMENT_ATTACHMENT_CLEANUP_UNAVAILABLE" });
      throw error;
    }
    return removeChatMessageDocuments({ sessionId: id, messageId, documents });
  }));
  await runtimeState.persist(id);
  const cleanup = object(removal?.cleanup);
  return {
    sessionId: id,
    deleted: Boolean(removal),
    removedAttachmentCount: Math.max(0, Number(cleanup.attachmentCount) || 0),
    deletedFileCount: Math.max(0, Number(cleanup.deletedFileCount) || 0),
    deletedModelCount: Math.max(0, Number(cleanup.deletedModelCount) || 0),
  };
}

async function reorderSessionFollowUpsRuntime(sessionId: string, clientMessageIds: string[] = []) {
  const id = normalizeSessionId(sessionId);
  const changed = await sessionSupervisor.withAgent(id, agent => agent.reorderFollowUps(clientMessageIds));
  return { sessionId: id, changed };
}

async function resetSessionRuntime(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  await stopSingleSessionRuntime(id, { source: "reset" });
  await sessionSupervisor.withAgent(id, async agent => {
    await agent.reset();
    const conversation = agent.exportSession();
    await sessionRepository.replaceActiveConversation(id, conversation);
    await saveSessionRecordRuntime({ sessionId: id, conversation, transcript: [] });
    agentHost.handleEvent(id, { type: "reset" });
    await runtimeState.persist(id, { terminal: true });
  });
  return { sessionId: id, reset: true };
}

async function compactSessionContextRuntime(params: Fields = {}) {
  await sessionRuntimeReady;
  const id = requireExplicitSessionId(params.sessionId, "compact_context");
  const session = await sessionRepository.getMetadata(id);
  if (!session) {
    const error = new Error(t("session.compactMissing"));
    Object.assign(error, { code: "SESSION_NOT_FOUND" });
    throw error;
  }
  const instruction = String(params.instruction || "").replace(/\u0000/gu, "").trim();
  const compaction: { result: Awaited<ReturnType<Agent["compactContext"]>> | null } = { result: null };
  let task;
  try {
    task = await startSessionAgentTask({
      sessionId: id,
      operationName: "compact_context",
      operation: async ({ agent, task }) => {
        compaction.result = await agent.compactContext(null, {
          trigger: "slash_command",
          instruction,
        });
        if (task.cancelled) return;
        if (compaction.result?.compacted || compaction.result?.failed) {
          sessionTranscript.finish(id);
          const conversation = agent.exportSession();
          await commitSessionRecordRuntime({ sessionId: id, conversation });
        }
        return compaction.result?.failed
          ? { status: "error", reason: object(compaction.result.error).message || t("agent.compactionFailed") }
          : null;
      },
    });
  } catch (error) {
    if (object(error).code !== "SESSION_ALREADY_RUNNING") throw error;
    const localized = new Error(t("session.compactRunning"));
    Object.assign(localized, { code: object(error).code });
    throw localized;
  }
  await task.promise;
  if (task.cancelled) {
    const error = new Error(t("session.compactStopped"));
    Object.assign(error, { code: "OPERATION_ABORTED" });
    throw error;
  }
  if (compaction.result?.failed) {
    const error = new Error(t("session.compactRetry"));
    Object.assign(error, { code: "CONTEXT_COMPACTION_FAILED" });
    throw error;
  }
  return {
    sessionId: id,
    compacted: compaction.result?.compacted === true,
    reason: String(compaction.result?.plan?.reason || ""),
    inputTokensBefore: Math.max(0, Number(compaction.result?.plan?.inputTokens) || 0),
    inputTokensAfter: Math.max(0, Number(compaction.result?.inputTokensEstimate) || 0),
    sourceMessageCount: Math.max(0, Number(compaction.result?.plan?.sourceMessageCount) || 0),
    retainedMessageCount: Math.max(0, Number(compaction.result?.plan?.retainedMessageCount) || 0),
    instructionApplied: Boolean(instruction),
  };
}

async function getSessionHistoryRuntime(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  const agent = await agentHost.getAgent(id);
  return {
    sessionId: id,
    messages: agent.messages.filter(message => message.role !== "system"),
  };
}

function clearSessionGoalFromApi(sessionId: string, source = "api", signal?: AbortSignal) {
  return clearSessionGoalRuntime({ sessionId, source, signal });
}

async function restoreSessionFromApi(sessionId: string, conversation: unknown) {
  const id = normalizeSessionId(sessionId);
  const agent = await agentHost.getAgent(id);
  if (!agent.isStreaming && agent.messages.length <= 1) {
    await agent.restoreSession(conversation);
    agent.restoreLoadedSkillToolNames(sessionSupervisor.getRuntime(id)?.loadedPluginSkillNames || []);
  }
  return { sessionId: id };
}

async function getLastMessagesRuntime({ sessionId, num = 5 }: { sessionId?: unknown; num?: unknown } = {}) {
  await sessionRuntimeReady;
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("getLastMessages requires sessionId");
  const count = Math.max(1, Math.min(50, Math.floor(Number(num) || 5)));
  const sessions = await getSessions();
  const entry = await agentHost.getLiveEntry(id);
  let source = "";
  let transcript: TranscriptEntry[] = [];

  if (entry) {
    transcript = await sessionTranscript.get(id, entry.agent.exportSession());
    source = "runtime";
  }

  if (transcript.length === 0) {
    transcript = await sessionTranscript.get(id);
    if (transcript.length > 0) source = source || "saved_session";
  }

  if (transcript.length === 0) {
    const activeConversation = await sessionRepository.readActiveConversation(id);
    if (activeConversation) {
      transcript = transcriptFromConversation(activeConversation);
      source = "active_conversation";
    }
  }

  if (transcript.length === 0) {
    const record = readSessionRecord(await sessionRepository.readRecord(id));
    transcript = record.transcript || [];
    source = source || "saved_session";
  }

  const runtime = getSessionRuntimeState(id);
  const tail = transcript.slice(-count).map(compactTranscriptEvent);
  const artifacts = await sessionArtifacts.collect(id, transcript);
  return {
    sessionId: id,
    session: sessions[id] || null,
    running: runtime.running,
    pendingStart: runtime.pendingStart,
    runId: runtime.runId,
    source,
    count: tail.length,
    messages: tail,
    artifactCount: artifacts.total,
    ...(artifacts.total > 0 ? { artifacts } : {}),
  };
}

async function resolveSessionArtifactTranscript(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const entry = await agentHost.getLiveEntry(id);
  if (entry) {
    const transcript = await sessionTranscript.get(id, entry.agent.exportSession()).catch(error => { if (isSessionFormatError(error)) throw error; return []; });
    if (transcript.length) return transcript;
  }

  let transcript = await sessionTranscript.get(id).catch(error => { if (isSessionFormatError(error)) throw error; return []; });
  if (transcript.length) return transcript;

  try {
    const activeConversation = await sessionRepository.readActiveConversation(id);
    if (activeConversation) {
      transcript = transcriptFromConversation(activeConversation);
      if (transcript.length) return transcript;
    }
  } catch(_err) {
    if (isSessionFormatError(_err)) throw _err;
    // Active conversation is best-effort; stored session fallback below is enough.
  }

  try {
    const record = readSessionRecord(await sessionRepository.readRecord(id));
    transcript = record.transcript || [];
    return transcript;
  } catch(_err) {
    if (isSessionFormatError(_err)) throw _err;
    return [];
  }
}

async function waitSessionsRuntime({
  sessionIds,
  waitFor = "all",
  timeoutMs = SESSION_WAIT_DEFAULT_TIMEOUT_MS,
  num = 3,
  excludeSessionId = "",
  signal,
}: { sessionIds?: unknown; waitFor?: string; timeoutMs?: number; num?: number; excludeSessionId?: string; signal?: AbortSignal } = {}) {
  await sessionRuntimeReady;
  const ids = normalizeWaitSessionIds(sessionIds);
  const caller = typeof excludeSessionId === "string" ? excludeSessionId.trim() : "";
  if (ids.length === 0) {
    return localizeToolFailurePayload({
      error: "manage_sessions wait requires sessionIds",
      code: "MISSING_SESSION_IDS",
      details: { action: "wait" },
    }, { toolName: "manage_sessions" });
  }
  if (caller && ids.includes(caller)) {
    return localizeToolFailurePayload({
      error: "Cannot wait for the session currently executing this tool",
      code: "CANNOT_WAIT_CALLER_SESSION",
      details: { sessionId: caller, sessionIds: ids },
    }, { toolName: "manage_sessions" });
  }

  const mode = waitFor === "any" ? "any" : "all";
  const timeout = resolveSessionWaitTimeoutMs(timeoutMs);
  const messageCount = Math.max(0, Math.min(20, Math.floor(Number(num) || 3)));
  const sessions = await getSessions();
  const missingIds = ids.filter((id) => !sessions[id] && !sessionSupervisor.has(id));
  if (missingIds.length > 0) {
    return localizeToolFailurePayload({
      error: "Some sessions do not exist",
      code: "SESSION_NOT_FOUND",
      details: { sessionIds: ids, missingIds },
    }, { toolName: "manage_sessions" });
  }

  const startedAt = nowBeijingDateTime();
  let initial = await collectWaitSessionSummaries(ids, messageCount);
  const initiallyCompleted = initial.filter((item) => !item.running).map((item) => item.sessionId);
  const initialRunning = initial.filter((item) => item.running).map((item) => item.sessionId);
  let outcome;

  if (mode === "any" && initiallyCompleted.length > 0) {
    outcome = { kind: "already_completed", sessionIds: initiallyCompleted };
  } else if (initialRunning.length === 0) {
    outcome = { kind: "already_completed", sessionIds: ids };
  } else {
    const waitPromise = mode === "any"
      ? Promise.race(initialRunning.map((id) => waitForSessionIdle(id).then(() => [id])))
      : Promise.all(initialRunning.map((id) => waitForSessionIdle(id).then(() => id)));
    outcome = await waitWithTimeout(waitPromise, timeout, signal);
  }

  const finishedAt = nowBeijingDateTime();
  const summaries = await collectWaitSessionSummaries(ids, messageCount);
  const completedIds = summaries.filter((item) => !item.running).map((item) => item.sessionId);
  const pendingIds = summaries.filter((item) => item.running).map((item) => item.sessionId);
  return {
    waited: outcome.kind !== "already_completed",
    waitFor: mode,
    timedOut: outcome.kind === "timeout",
    aborted: outcome.kind === "aborted",
    timeoutMs: timeout,
    startedAt,
    finishedAt,
    targetIds: ids,
    triggeredIds: Array.isArray(outcome.sessionIds) ? outcome.sessionIds : [],
    completedIds,
    pendingIds,
    sessions: summaries,
  };
}

function resolveSessionWaitTimeoutMs(timeoutMs = SESSION_WAIT_DEFAULT_TIMEOUT_MS) {
  const n = Number(timeoutMs);
  if (Number.isFinite(n) && n <= 0) return SESSION_WAIT_INFINITE_TIMEOUT_MS;
  const value = Number.isFinite(n) ? n : SESSION_WAIT_DEFAULT_TIMEOUT_MS;
  if (value <= 0) return SESSION_WAIT_INFINITE_TIMEOUT_MS;
  return Math.max(1000, Math.min(SESSION_WAIT_MAX_TIMEOUT_MS, Math.floor(value)));
}

async function updateSessionTracker(input: Fields = {}) {
  await sessionRuntimeReady;
  const id = normalizeSessionId(input.sessionId);
  const action = normalizeTrackerAction(input.action);
  const previous = normalizeSessionTracker(sessionSupervisor.getRuntime(id)?.tracker);
  const tracker = buildNextSessionTracker(action, input, previous);
  const runtime = runtimeState.set(id, { tracker });
  broadcast({
    type: "tracker_update",
    sessionId: id,
    action,
    tracker,
    runtime: getSessionRuntimeState(id),
  });
  broadcast({ type: "sessions_changed", action: "tracker", sessionId: id });
  return {
    action,
    active: Boolean(tracker),
    tracker,
    previous: previous ? summarizeSessionTracker(previous) : null,
    cleared: !tracker,
    runtimeUpdatedAt: runtime?.updatedAt,
  };
}

async function updateSessionGoal(input: Fields & { signal?: AbortSignal; runId?: string | null } = {}) {
  await sessionRuntimeReady;
  const id = normalizeSessionId(input.sessionId);
  return sessionSupervisor.withRuntime(id, async () => {
    const action = normalizeGoalAction(input.action);
    if (!(await canUseSessionGoal(id))) {
      const err = new Error("manage_goal is only available in user-created root sessions");
      Object.assign(err, { code: "GOAL_SESSION_FORBIDDEN" });
      Object.assign(err, { details: { sessionId: id, action } });
      throw err;
    }
    if (input.signal?.aborted) throw Object.assign(new Error(t("session.goalCancelled")), { name: "AbortError", code: "OPERATION_ABORTED" });
    if (sessionRepository.isWriteBlocked?.(id)) throw Object.assign(new Error(t("session.deleted")), { code: "SESSION_DELETED" });
    if (input.runId && !sessionSupervisor.isRunCurrent(id, input.runId)) {
      throw Object.assign(new Error(t("session.goalRunEnded")), { code: "STALE_RUN" });
    }
    const previous = normalizeSessionGoal(sessionSupervisor.getRuntime(id)?.goal);
    if (action === "get") {
      return {
        action,
        active: Boolean(previous && ["active", "blocked", "paused"].includes(previous.status)),
        goal: previous,
        previous: null,
        cleared: !previous,
        runtimeUpdatedAt: getSessionRuntimeState(id).updatedAt,
      };
    }
    const goal = buildNextSessionGoal(action, input, previous);
    const runtime = runtimeState.set(id, { goal });
    broadcast({
      type: "goal_update",
      sessionId: id,
      action,
      goal,
      runtime: getSessionRuntimeState(id),
    });
    broadcast({ type: "sessions_changed", action: "goal", sessionId: id });
    return {
      action,
      active: Boolean(goal && ["active", "blocked", "paused"].includes(goal.status)),
      goal,
      previous: previous ? summarizeSessionGoal(previous) : null,
      cleared: !goal,
      runtimeUpdatedAt: runtime?.updatedAt,
    };
  });
}

async function clearSessionGoalRuntime(input: Fields & { signal?: AbortSignal; runId?: string | null } = {}) {
  await sessionRuntimeReady;
  const id = normalizeSessionId(input.sessionId);
  if (!(await canUseSessionGoal(id))) {
    const err = new Error("goal clearing is only available in user-created root sessions");
    Object.assign(err, { code: "GOAL_SESSION_FORBIDDEN" });
    Object.assign(err, { details: { sessionId: id, action: "clear" } });
    throw err;
  }
  const previous = normalizeSessionGoal(sessionSupervisor.getRuntime(id)?.goal);
  const result = await updateSessionGoal({ ...input, sessionId: id, action: "clear" });
  let eventAppended = false;
  let eventDeferred = false;
  if (previous) {
    const agent = await agentHost.getAgent(id);
    const historyReady = await agentHost.ensureConversationForHistoryMutation(id, agent);
    if (historyReady) {
      const appendResult = await agent.appendGoalDeletedEvent(previous);
      eventDeferred = appendResult === "deferred";
      eventAppended = appendResult === true;
      if (eventAppended) {
        const conversation = agent.exportSession();
        await commitSessionRecordRuntime({ sessionId: id, conversation });
      }
    }
  }
  return {
    ...result,
    sessionId: id,
    cleared: Boolean(previous),
    previous: previous ? summarizeSessionGoal(previous) : null,
    goal: null,
    runtime: getSessionRuntimeState(id),
    eventAppended,
    eventDeferred,
  };
}

function normalizeWaitSessionIds(sessionIds: unknown) {
  const raw = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function getSessionRuntimeState(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  const persisted = sessionSupervisor.getRuntime(id) || {};
  const workingTab = normalizeWorkingTab(persisted.workingTab) || (
    persisted.workingUrl
      ? normalizeWorkingTab({
          id: persisted.workingTabId,
          title: persisted.workingTitle,
          url: persisted.workingUrl,
        })
      : null
  );
  const status = normalizeRuntimeStatus(persisted.status) || "idle";
  const running = isActiveSessionRuntimeStatus(status) && persisted.running !== false;
  return {
    status,
    running,
    pendingStart: running && status === "pending",
    runId: typeof persisted.runId === "string" && persisted.runId ? persisted.runId : null,
    waitId: String(persisted.waitId || ""),
    waitMessage: String(persisted.waitMessage || ""),
    waitTitle: String(persisted.waitTitle || ""),
    waitForm: persisted.waitForm || null,
    interrupted: status === "interrupted" || !!persisted.interrupted,
    updatedAt: persisted.updatedAt || "",
    startedAt: persisted.startedAt || "",
    endedAt: persisted.endedAt || "",
    reason: String(persisted.reason || ""),
    currentToolName: String(persisted.currentToolName || ""),
    currentToolStartedAt: persisted.currentToolStartedAt || "",
    currentTool: runtimeState.normalizeCurrentTool(persisted.currentTool),
    contextUsage: persisted.contextUsage || null,
    contextWindow: persisted.contextWindow || 0,
    inputTokensEstimate: persisted.inputTokensEstimate || 0,
    contextEstimateSource: String(persisted.contextEstimateSource || ""),
    usageAnchorTokens: persisted.usageAnchorTokens || 0,
    estimatedTrailingTokens: persisted.estimatedTrailingTokens || 0,
    toolSchemaTokens: persisted.toolSchemaTokens || 0,
    messageTokensEstimate: persisted.messageTokensEstimate || 0,
    contextBoundaryId: String(persisted.contextBoundaryId || ""),
    usageAnchorMessageIndex: Number.isFinite(Number(persisted.usageAnchorMessageIndex)) ? Number(persisted.usageAnchorMessageIndex) : -1,
    tracker: normalizeSessionTracker(persisted.tracker),
    goal: normalizeSessionGoal(persisted.goal),
    workingTab,
    workingTabId: workingTab?.id || null,
    workingUrl: workingTab?.url || "",
    workingTitle: workingTab?.title || "",
    workingTabSource: String(persisted.workingTabSource || ""),
    workingTabConflictSessionId: String(persisted.workingTabConflictSessionId || ""),
    workingTabClaimedFromTabId: persisted.workingTabClaimedFromTabId || null,
    workingTabUpdatedAt: persisted.workingTabUpdatedAt || "",
    ownedTabIds: getOwnedTabIds(persisted),
    sessionTabIds: getOwnedTabIds(persisted),
    visitedTaskSites: normalizeVisitedTaskSites(persisted.visitedTaskSites),
    pendingSteerings: Array.isArray(persisted.pendingSteerings) ? persisted.pendingSteerings : [],
    pendingSteeringMessages: runtimeState.normalizePendingFollowUps(persisted.pendingSteeringMessages),
    pendingFollowUps: Array.isArray(persisted.pendingFollowUps) ? persisted.pendingFollowUps : [],
    pendingFollowUpMessages: runtimeState.normalizePendingFollowUps(persisted.pendingFollowUpMessages),
  };
}

type RuntimeOutput = ReturnType<typeof getSessionRuntimeState>;
function getSessionRuntimeStateForOutput(sessionId: string): Promise<RuntimeOutput>;
function getSessionRuntimeStateForOutput<T>(sessionId: string, project: (runtime: RuntimeOutput) => T extends PromiseLike<unknown> ? never : T): Promise<T>;
async function getSessionRuntimeStateForOutput<T>(sessionId: string, project?: (runtime: RuntimeOutput) => T): Promise<RuntimeOutput | T> {
  const id = normalizeSessionId(sessionId);
  let exposeGoal = true;
  try {
    const sessions = await getSessions();
    exposeGoal = canExposeSessionGoal(sessions[id]);
  } catch (_err) { /* Preserve the current runtime if metadata is temporarily unavailable. */ }
  // Sample related live state in the same synchronous turn, after metadata I/O.
  const current = getSessionRuntimeState(id);
  const runtime = exposeGoal ? current : { ...current, goal: null };
  if (!project) return runtime;
  const result = project(runtime);
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new TypeError("Runtime output projection must be synchronous");
  }
  return result;
}

async function buildSkillUiContext(sessionId: string) {
  const id = normalizeSessionId(sessionId);
  const runtime = getSessionRuntimeState(id);
  const context: Fields = {
    workingTab: runtime.workingTab || null,
    pageUrl: runtime.workingUrl || runtime.workingTab?.url || "",
    taskSiteTabs: runtime.visitedTaskSites || [],
    loadedPluginSkillNames: runtimeState.loadedSkillNames(id),
  };
  try {
    const tabs = await sessionTabs.getOwnedTabContexts(sessionId, null, { titleLimit: 80 });
    if (tabs.length) context.tabs = tabs;
  } catch (_err) {
    // Skill UI context is best-effort; descriptor listing should still work.
  }
  return context;
}

function formatSessionRuntimeRecord(session: Partial<SessionMetadata> & { id: string }, { compact = false } = {}) {
  const runtime = getSessionRuntimeState(session.id);
  const base = compact
    ? {
        id: session.id,
        title: session.title || t("session.new"),
        updatedAt: session.updatedAt || session.createdAt || "",
      }
    : { ...session };
  return {
    ...base,
    status: runtime.status,
    running: runtime.running,
    pendingStart: runtime.pendingStart,
    runId: runtime.runId,
    waitId: runtime.waitId,
    interrupted: runtime.interrupted,
    runtimeUpdatedAt: runtime?.updatedAt,
    runtimeReason: runtime.reason,
    tracker: runtime.tracker,
    goal: canExposeSessionGoal(session) ? runtime.goal : null,
    workingTab: runtime.workingTab,
    visitedTaskSites: runtime.visitedTaskSites,
    pendingSteerings: runtime.pendingSteerings,
    pendingFollowUps: runtime.pendingFollowUps,
  };
}

async function waitForSessionIdle(sessionId: string) {
  return sessionSupervisor.waitForIdle(normalizeSessionId(sessionId));
}

async function waitForSessionRunObserved(sessionId: string, taskInfo: unknown, timeoutMs = 2000) {
  const id = normalizeSessionId(sessionId);
  const deadline = Date.now() + Math.max(0, Math.min(10000, Number(timeoutMs) || 0));
  while (Date.now() <= deadline) {
    const runtime = getSessionRuntimeState(id);
    if (
      runtime.runId
      || runtime.pendingStart
      || runtime.running
      || runtime.status !== "idle"
      || (taskInfo && sessionSupervisor.getTask(id) !== taskInfo)
    ) {
      return runtime;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return getSessionRuntimeState(id);
}

async function waitWithTimeout(promise: Promise<string[]>, timeoutMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return { kind: "aborted", sessionIds: [] };
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const timeout = Math.floor(Number(timeoutMs) || 0);
  const races: Promise<{ kind: string; sessionIds: string[] }>[] = [
    Promise.resolve(promise).then((sessionIds) => ({
      kind: "completed",
      sessionIds: Array.isArray(sessionIds) ? sessionIds : [sessionIds].filter(Boolean),
    })),
  ];
  try {
    if (timeout > 0) {
      races.push(new Promise((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ kind: "timeout", sessionIds: [] }), timeout);
      }));
    }
    if (signal) {
      races.push(new Promise((resolve) => {
        abortHandler = () => resolve({ kind: "aborted", sessionIds: [] });
        signal.addEventListener("abort", abortHandler, { once: true });
      }));
    }
    return await Promise.race(races);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

async function collectWaitSessionSummaries(sessionIds: string[], num: number) {
  await sessionRuntimeReady;
  const summaries = [];
  const sessions = await getSessions();
  for (const id of sessionIds) {
    let tail = null;
    let artifacts = null;
    let artifactsResolved = false;
    if (num > 0) {
      try {
        tail = await getLastMessagesRuntime({ sessionId: id, num });
        artifacts = tail?.artifacts || sessionArtifacts.empty();
        artifactsResolved = true;
      } catch (err) {
        tail = { error: errorMessage(err), messages: [] };
      }
    }
    if (!artifactsResolved) {
      artifacts = await sessionArtifacts.collect(id).catch((err) => {
        console.debug("[轻舟] collect wait session artifacts failed:", errorMessage(err));
        return sessionArtifacts.empty();
      });
    }
    const session = sessions[id] || { id, title: tail?.session?.title || "", updatedAt: "" };
    const runtimeRecord = formatSessionRuntimeRecord(session, { compact: true });
    summaries.push({
      sessionId: id,
      title: runtimeRecord.title,
      status: runtimeRecord.status,
      running: runtimeRecord.running,
      pendingStart: runtimeRecord.pendingStart,
      runId: runtimeRecord.runId,
      updatedAt: runtimeRecord.updatedAt,
      lastMessages: tail?.messages || [],
      lastMessagesSource: tail?.source || "",
      artifactCount: artifacts?.total || 0,
      ...((artifacts?.total || 0) > 0 ? { artifacts } : {}),
    });
  }
  return summaries;
}

const SESSION_TAIL_TEXT_LIMIT = 6000;

function compactTranscriptEvent(event: TranscriptEntry) {
  if (!event || typeof event !== "object") return { type: "unknown" };
  if (event.type === "user") {
    return {
      type: "user",
      text: clipText(event.text || "", SESSION_TAIL_TEXT_LIMIT),
      images: Array.isArray(event.images) ? event.images.length : 0,
      documents: Array.isArray(event.documents) ? event.documents.length : 0,
    };
  }
  if (event.type === "assistant") {
    return { type: "assistant", content: clipText(event.content || "", SESSION_TAIL_TEXT_LIMIT) };
  }
  if (event.type === "thinking") {
    return { type: "thinking", text: clipText(event.text || "", SESSION_TAIL_TEXT_LIMIT) };
  }
  if (event.type === "tool") {
    const argsState = event.argsState || (event.argsIncomplete ? "generating" : "");
    const argsGenerating = event.argsGenerating === true || argsState === "generating" || event.argsIncomplete === true;
    return {
      type: "tool",
      name: event.name || "tool",
      args: compactValue(event.args),
      argsText: clipText(event.argsText || "", SESSION_TAIL_TEXT_LIMIT),
      argsIncomplete: !!event.argsIncomplete,
      argsGenerating,
      argsState,
      phase: event.phase || "",
      result: compactValue(event.result),
      isError: !!event.isError,
      isRunning: !!event.isRunning,
      image: event.image ? "[image omitted]" : null,
    };
  }
  if (event.type === "wait") {
    return {
      type: "wait",
      title: clipText(event.title || "", SESSION_TAIL_TEXT_LIMIT),
      message: clipText(event.message || "", SESSION_TAIL_TEXT_LIMIT),
      status: event.status || "",
      reason: event.reason || "",
    };
  }
  if (event.type === "note" || event.type === "error") {
    return { type: event.type, text: clipText(event.text || "", SESSION_TAIL_TEXT_LIMIT) };
  }
  return { type: event.type || "unknown" };
}

function compactValue(value: unknown) {
  if (value == null) return null;
  if (typeof value === "string") return clipText(value, SESSION_TAIL_TEXT_LIMIT);
  try {
    return clipText(JSON.stringify(value, null, 2), SESSION_TAIL_TEXT_LIMIT);
  } catch(_e) {
    return clipText(String(value), SESSION_TAIL_TEXT_LIMIT);
  }
}

function clipText(value: unknown, maxChars: number) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} chars omitted]`;
}

async function deleteSessionRuntime(sessionId: string, meta: Fields = {}, signal?: AbortSignal) {
  await sessionRuntimeReady;
  signal?.throwIfAborted();
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("deleteSession requires sessionId");

  let stored: Awaited<ReturnType<Repository["deleteSession"]>> | null = null;
  const snapshot = await sessionSupervisor.remove(id, {
    admissionSignal: signal,
    reason: "delete_session",
    beforeRelease: async (revoked) => {
      await releaseTerminalRunResources(
        id,
        revoked?.activeRunId || revoked?.liveState?.runId,
        "delete_session",
      );
      const releaseDocumentParsing = await blockChatDocumentParsing(id);
      try {
        stored = await deleteStoredSession(id);
        await removeChatSessionDocuments(id).catch(error => console.warn("[轻舟] deleted Session document cleanup failed", error));
        await removeSessionObservations(id).catch(error => console.warn("[轻舟] deleted Session observation cleanup failed", error));
      } finally {
        releaseDocumentParsing?.();
      }
    },
  });
  const stopped = Boolean(snapshot.hadTask || object(snapshot.liveState).isStreaming);
  const hadRuntime = Boolean(snapshot.hadAgent || snapshot.hadTask);

  await sessionTabs.closeOwnedTabsAfterTerminal(id, "delete_session").catch((err) => {
    console.debug("[轻舟] close deleted session owned tabs failed:", errorMessage(err));
  });
  sessionArtifacts.clearListSummaryPatch(id);
  sessionArtifacts.clearSummaryRefresh(id);
  sessionTranscript.remove(id);
  runtimeState.remove(id);
  const result = {
    ...object(stored),
    stopped,
    hadRuntime,
    requestedBy: meta.requestedBy || "",
    source: meta.source || "",
  };
  broadcast({ type: "session_deleted", ...result });
  broadcast({ type: "sessions_changed", action: "delete", sessionId: id });
  return result;
}

async function stopSessionRuntime(sessionId: string, meta: Fields = {}, signal?: AbortSignal) {
  await sessionRuntimeReady;
  signal?.throwIfAborted();
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("stopSession requires sessionId");

  const result = await stopSingleSessionRuntime(id, meta, signal);
  const cascade = meta.cascade !== false;
  const childResults = [];
  if (cascade) {
    const sessions = await getSessions();
    const childIds = collectDescendantSessionIds(id, sessions)
      .filter((childId) => isSessionRuntimeActiveForStop(childId));
    for (const childId of childIds) {
      childResults.push(await stopSingleSessionRuntime(childId, {
        ...meta,
        cascade: false,
        parentStopped: true,
        parentSessionId: id,
      }));
    }
  }

  return {
    ...result,
    stoppedChildren: childResults,
    stoppedChildCount: childResults.length,
  };
}

async function stopSingleSessionRuntime(sessionId: string, meta: Fields = {}, signal?: AbortSignal) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("stopSession requires sessionId");

  const before = getSessionRuntimeState(id);
  let hadRuntime = false;
  let runId = before.runId || null;
  let runtime = before;
  let hasHistory = false;
  let pendingFollowUpMessages = runtimeState.normalizePendingFollowUps(before.pendingFollowUpMessages);
  let pendingSteeringMessages = runtimeState.normalizePendingFollowUps(before.pendingSteeringMessages);

  await sessionSupervisor.revoke(id, {
    admissionSignal: signal,
    reason: meta.parentStopped ? "stopped_by_parent" : "stopped",
    beforeRelease: async (snapshot) => {
      const liveState = snapshot.liveState || {};
      const checkpoint = sessionSupervisor.getRuntime(id) || before;
      pendingFollowUpMessages = runtimeState.normalizePendingFollowUps(checkpoint.pendingFollowUpMessages);
      pendingSteeringMessages = runtimeState.normalizePendingFollowUps(checkpoint.pendingSteeringMessages);
      hadRuntime = Boolean(
        snapshot.hadTask
        || checkpoint.running
        || isActiveSessionRuntimeStatus(checkpoint.status)
        || checkpoint.waitId
        || liveState.isStreaming
      );
      runId = String(liveState.runId || snapshot.activeRunId || checkpoint.runId || runId || "") || null;
      hasHistory = snapshot.hasHistory;
      await releaseTerminalRunResources(id, runId, "aborted");
      if (!hadRuntime) return;

      if (checkpoint.waitId) sessionSupervisor.rejectUserWait({ sessionId: id, waitId: String(checkpoint.waitId) });
      runtimeState.set(id, {
        status: "aborted",
        running: false,
        pendingStart: false,
        runId,
        waitId: "",
        waitMessage: "",
        pendingFollowUpMessages,
        pendingSteeringMessages,
        interrupted: false,
        tracker: null,
        endedAt: nowBeijingDateTime(),
        reason: meta.parentStopped
          ? "stopped_by_parent"
          : meta.source === "ui"
            ? "stopped_by_user"
            : "stopped",
      });
      runtime = getSessionRuntimeState(id);
      sessionTranscript.recordEvent(id, {
        type: "state",
        sessionId: id,
        isStreaming: false,
        runId,
        status: runtime.status,
        runtime,
      });
      sessionTranscript.finish(id);

      const discardedId = String(snapshot.discardedPrompt?.clientMessageId || "").trim();
      if (discardedId) sessionTranscript.dropUnstartedUserMessage(id, discardedId);
      if (snapshot.conversation) {
        await sessionRepository.replaceActiveConversation(id, snapshot.conversation);
        await commitSessionRecordRuntime({ sessionId: id, conversation: snapshot.conversation });
      }
      await runtimeState.persist(id, { terminal: true });
      // The supervisor detaches the agent listener before aborting the run, so
      // the agent's own "aborted" emit never reaches the event host. Observe it
      // here without retaining the Session command queue.
      void Promise.resolve()
        .then(() => observeAgentEvent?.(id, { type: "aborted", runId }))
        .catch(() => {});
      void Promise.resolve()
        .then(() => automationRuntime.syncSessionOutcome(id))
        .catch((err) => {
          console.warn("[轻舟] automation stop outcome sync failed:", err);
        });
    },
  });

  if (pendingSteeringMessages.length > 0 || pendingFollowUpMessages.length > 0) {
    queueFollowUpResume("stop");
  }

  if (!hadRuntime) {
    return {
      sessionId: id,
      stopped: false,
      hadRuntime: false,
      runId,
      status: before.status || "idle",
      runtime: before,
      source: meta.source || "",
      parentSessionId: meta.parentSessionId || "",
    };
  }

  sessionTabs.closeOwnedTabsAfterTerminal(id, "stop_session").catch((err) => {
    console.debug("[轻舟] close stopped session owned tabs failed:", errorMessage(err));
  });
  const stateEvent = {
    type: "state",
    sessionId: id,
    isStreaming: false,
    runId,
    hasHistory,
    status: runtime.status,
    runtime,
  };
  broadcast(stateEvent);
  broadcast({ type: "sessions_changed", action: "run_state", sessionId: id });

  return {
    sessionId: id,
    stopped: true,
    hadRuntime,
    runId,
    status: runtime.status,
    runtime,
    source: meta.source || "",
    parentSessionId: meta.parentSessionId || "",
  };
}

async function releaseTerminalRunResources(sessionId: string, runId: unknown, eventType: string) {
  const id = normalizeSessionId(sessionId);
  const rid = String(runId || "").trim();
  if (!id || (!rid && eventType !== "delete_session")) return;
  try {
    await releaseRunResources({ sessionId: id, runId: rid, eventType });
  } catch (error) {
    console.warn("[轻舟] release terminal run resources failed:", error);
  }
}

function collectDescendantSessionIds(sessionId: string, sessions: Record<string, SessionMetadata> = {}) {
  const rootId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!rootId) return [];
  const childrenByParent = new Map<string, string[]>();
  for (const session of Object.values(sessions || {})) {
    const childId = typeof session?.id === "string" ? session.id.trim() : "";
    if (!childId || childId === rootId) continue;
    const parentId = normalizeParentSessionId(session.parentSessionId);
    if (!parentId || parentId === ROOT_SESSION_ID) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId)!.push(childId);
  }

  const descendants = [];
  const seen = new Set([rootId]);
  const queue = [...(childrenByParent.get(rootId) || [])];
  while (queue.length > 0) {
    const childId = queue.shift();
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    descendants.push(childId);
    queue.push(...(childrenByParent.get(childId) || []));
  }
  return descendants;
}

function isSessionRuntimeActiveForStop(sessionId: string) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return false;
  const state = getSessionRuntimeState(id);
  return state.running || isActiveSessionRuntimeStatus(state.status);
}

function composerWindowKey(value: unknown) {
  const raw = value == null ? "" : String(value).trim();
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id < 0) throw sessionError(
    "COMPOSER_DRAFT_WINDOW_REQUIRED",
    "composer draft requires a browser window",
  );
  return String(id);
}

function normalizeComposerDraft(value: unknown, sessionId: string): ComposerDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const draft = object(value);
  return {
    sessionId,
    messageId: String(draft.messageId || "").trim().slice(0, 160),
    text: String(draft.text || ""),
    images: Array.isArray(draft.images)
      ? draft.images.filter(item => item && typeof item === "object").map(item => ({ ...object(item) }))
      : [],
    documents: Array.isArray(draft.documents)
      ? draft.documents.filter(item => item && typeof item === "object").map(item => ({ ...object(item) }))
      : [],
    updatedAt: Math.max(0, Number(draft.updatedAt) || 0),
  };
}

function composerDraftHasContent(draft: ComposerDraft | null) {
  return Boolean(draft && (draft.text || draft.images.length || draft.documents.length));
}

function sessionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}


  return Object.freeze({
    canManageSessionTools,
    canUseSessionGoal,
    listSessionsRuntime,
    createSessionRuntime,
    createSessionMetadataRuntime,
    renameSessionRuntime,
    saveSessionRecordRuntime,
    commitSessionRecordRuntime,
    exportSessionExchangeRuntime,
    importSessionExchangeRuntime,
    startSessionAgentTask,
    startSessionPromptTask,
    submitSessionMessageRuntime,
    launchSessionPrompt,
    createSessionFromApi,
    createUiSessionFromApi,
    followUpSessionRuntime,
    getSessionComposerDraftRuntime,
    saveSessionComposerDraftRuntime,
    consumeSessionComposerDraftRuntime,
    steerSessionFollowUpRuntime,
    resendSessionMessageRuntime,
    deleteSessionFollowUpRuntime,
    deleteSessionSteeringRuntime,
    reorderSessionFollowUpsRuntime,
    resetSessionRuntime,
    compactSessionContextRuntime,
    getSessionHistoryRuntime,
    clearSessionGoalFromApi,
    restoreSessionFromApi,
    getLastMessagesRuntime,
    resolveSessionArtifactTranscript,
    waitSessionsRuntime,
    updateSessionTracker,
    updateSessionGoal,
    clearSessionGoalRuntime,
    getSessionRuntimeState,
    getSessionRuntimeStateForOutput,
    buildSkillUiContext,
    formatSessionRuntimeRecord,
    waitForSessionIdle,
    waitForSessionRunObserved,
    compactTranscriptEvent,
    deleteSessionRuntime,
    stopSessionRuntime,
  });
}

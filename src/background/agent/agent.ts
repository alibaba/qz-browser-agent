import { t as promptT } from "./prompts/messages.js";
import { t } from "../../shared/i18n/backend.js";
import { getLanguage, whenLanguageReady, withLanguage } from "../../shared/i18n/index.js";
import { MessageQueue, summarizeQueuedUserMessage } from "./message-queue.js";
import {
  buildContextCapsuleMessage, buildDocumentCapsuleMessage, buildGoalSnapshotCapsuleMessage,
  buildGoalDeletedContextEventMessage, buildSiteSkillContextEventMessage, formatGoalForCompaction,
  formatDynamicContext, shouldExposeGoalContext, isGoalSnapshotCapsuleMessage,
  collectDynamicContext, collectSiteSkillPreviewContext, collectToolRuntimeContext,
  collectSiteSkillCandidateUrls, siteSkillSignature, normalizeDynamicContext,
} from "./context.js";
import type { DynamicContext, DynamicContextProvider, GoalContext, GoalDeletedSnapshot, SiteSkill } from "./context.js";
export type { DynamicContext, DynamicContextProvider } from "./context.js";
import { getToolCallArgumentsValue, normalizeToolCallName } from "../llm/protocol-shared.js";
import { isSessionFormatError } from "../../shared/session/session-format.js";
/**
 * One Agent owns one Session's messages, run loop and compaction barrier.
 * Finish every tool result in a turn before consuming steering; follow-up starts
 * a new run through the Session host. The host's lease, not this object, grants write authority.
 */

import { agentService } from "./services.js";
import { buildCompactUserPrompt, getAgentPrompts, sessionAutomationPromptSuffix } from "./prompts.js";
import { buildRunProfile, buildRunProfilePromptSection } from "./run-profile.js";
import {
  buildCompactionPlan,
  compactThreshold,
  createCompactMessage,
  estimateContextTokens,
  estimateToolSchemaTokens,
  estimateTokens,
  latestCompactIndex,
  normalizeContextBoundaryId,
  ROOT_CONTEXT_BOUNDARY_ID,
  serializeMessagesForCompaction,
} from "./compaction.js";
import { deserializeConversationWithRepair, serializeConversation } from "../../shared/session/session-codec.js";
import { repairToolMessageSequence } from "../../shared/tools/tool-message-protocol.js";
import {
  extractUserMessageImages,
  findEditableUserMessageIndex,
  normalizeUserImageInputs,
} from "../../shared/session/conversation-edit.js";
import {
  MESSAGE_ORIGIN_USER,
  isHiddenContextUserMessage,
} from "../../shared/message-blocks.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import {
  buildSecurityGuardrailPromptSection,
} from "../../shared/security-guardrails.js";
import { formatTab } from "../../shared/tab-utils.js";
import { toolIdentityEventFields } from "../../shared/tools/tool-identity.js";
import { normalizeMessageDocuments } from "../../shared/documents/document-attachments.js";
import {
  llmFailureFacts,
  normalizeLlmFailure,
} from "../llm/provider-errors.js";
import { createLlmRetryPolicy, waitForAbortableDelay } from "../llm/transport.js";
import { projectMessage, IMAGE_PLACEHOLDER } from "../llm/message-projection.js";
import { createStreamAttempt } from "../llm/stream-attempt.js";

import type { AgentServices } from './services.js';
import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { RunProfile } from './run-profile.js';
import type { ModelMessage, ModelToolCall } from '../../shared/contracts/model-message.js';
import type { ModelOptions, ModelEvent } from '../llm/protocol-registry.js';
import type { StreamedTool } from '../llm/stream-attempt.js';
import type { TabReference } from '../../shared/tab-utils.js';
import type { ToolEffect, ToolModelPolicy } from '../../shared/contracts/tool.js';
import type { MessageDocument } from '../../shared/documents/document-attachments.js';

import type { AgentEvent, AgentRetryDetails, ContextUsageSnapshot, ContextUsageDetails } from '../../shared/contracts/agent-event.js';
export type { AgentEvent } from '../../shared/contracts/agent-event.js';

type Facts = Record<string, unknown>;
interface AgentMessage extends ModelMessage {
  clientMessageId?: string; documents?: MessageDocument[]; _accepting?: boolean; _refreshDynamicContext?: boolean;
  _compact?: Facts; _contextCapsule?: Facts; _contextEvent?: Facts;
}
interface AgentToolPort {
  snapshot?(language?: string): unknown;
  getSchemas(context: Facts): object[];
  getIdentity(name: string, context: Facts): object;
  getModelPolicy?(name: string, context: Facts): Readonly<ToolModelPolicy> | undefined;
  execute(name: string, args: unknown, signal: AbortSignal, context: Facts): Promise<unknown>;
  consumeEffects?(result: unknown, context: {sessionId: string; runId?: string | null}): readonly ToolEffect[];
}
interface ConversationLease {sessionId: string; isActive(): boolean}
interface ConversationRepository {
  readActiveConversation(sessionId: string): Promise<unknown>;
  writeActiveConversation(sessionId: string, conversation: unknown, lease: ConversationLease): Promise<unknown>;
  clearActiveConversation(sessionId: string, lease: ConversationLease): Promise<unknown>;
}
interface AgentLlmPort {
  chat(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions): Promise<{message: ModelMessage; usage?: Facts}>;
  chatStream(messages: ModelMessage[], tools: object[], signal: AbortSignal | undefined, options: ModelOptions): AsyncIterable<ModelEvent>;
}
export interface AgentOptions {
  services?: Partial<AgentServices> | null; conversationRepository?: ConversationRepository | null; conversationLease?: ConversationLease | null;
  llm?: AgentLlmPort | null; tools?: AgentToolPort | null;
  browserContext?: {readSelectedText?(tabId?: number): Promise<string>; getTab?(tabId: number): Promise<TabReference | null>} | null;
  sessionPolicy?: {canManageSessions(sessionId: string): Promise<boolean>} | null;
  ensureSkillToolRegistryReady?: ((reason: string) => Promise<unknown>) | null;
  canStartQueuedRun?: (() => boolean | Promise<boolean>) | null;
}
type ContextEstimate = ReturnType<Agent['_estimateSendWindowContext']>;
type CompactionPlan = ReturnType<typeof buildCompactionPlan> & {trigger: string};
interface CompactionResult {compacted: boolean; failed?: boolean; error?: unknown; inputTokensEstimate: number; contextEstimate: ContextEstimate; plan: CompactionPlan}
interface CompactionOptions {force?: boolean; trigger?: string; instruction?: string; dynamicContext?: DynamicContext | null; toolSchemas?: object[]}
interface RecoveryState {used?: boolean; contextOverflowUsed?: boolean; disableTransportRetry?: boolean; providerRetryAttempts?: number; llmCallId: string}
type Preparation = {runProfile: RunProfile; toolSchemas?: object[] | null; dynamicContext?: DynamicContext | null; window?: Awaited<ReturnType<Agent['_prepareSendWindowOrBlock']>> | null};
type MessageHook = ((message: AgentMessage) => unknown) | null;

const DEFAULT_AGENT_BROWSER_CONTEXT = Object.freeze({
  readSelectedText: async () => "",
  getTab: async () => null,
});
const DEFAULT_AGENT_SESSION_POLICY = Object.freeze({
  canManageSessions: async () => true,
});
const DEFAULT_AGENT_SKILL_TOOL_REGISTRY_READY = async () => {};
const MAX_EMPTY_LLM_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Token estimation and compaction
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 262000;
const RESERVE_TOKENS = 16000;      // Reserved for the response
const KEEP_RECENT_TOKENS = 40000;  // Recent tokens retained during compaction
const TOOL_RESULT_RECENT_ROUNDS = 2;
const IMAGE_MESSAGE_RECENT_LIMIT = 8;
const TOOL_RESULT_PROTECT_RATIO = 0.2;
const TOOL_RESULT_PRUNE_BATCH_RATIO = 0.5;
const FOLLOW_UP_RUN_HANDOFF_DELAY_MS = 160;
const GOAL_CONTEXT_REFRESH_AFTER_ASSISTANTS = 5;

const TIMELINE_EVENT_TYPES = new Set([
  "message_start",
  "message_update",
  "message_end",
  "thinking_update",
  "tool_call_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "context_compaction_start",
  "context_compaction_end",
  "context_compaction_failed",
  "waiting_for_user",
  "user_wait_resolved",
  "warning",
  "aborted",
  "error",
]);

function shouldStampTimelineEvent(event: AgentEvent) {
  return event && TIMELINE_EVENT_TYPES.has(event.type);
}

function createRunId(sessionId = "default", seq = 0) {
  const time = Date.now().toString(36);
  const serial = Math.max(0, Number(seq) || 0).toString(36);
  return `run_${safeIdPart(sessionId, 12)}_${time}_${serial}_${randomIdPart()}`;
}

function normalizeClientMessageMeta(clientMessageId = "") {
  const id = typeof clientMessageId === "string" ? clientMessageId.trim() : "";
  return id ? { clientMessageId: id } : {};
}

function randomIdPart() {
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(36).padStart(2, "0")).join("");
  } catch(_e) {
    return Math.random().toString(36).slice(2, 12) || "random";
  }
}

function safeIdPart(value: unknown, maxLength = 32) {
  const clean = String(value || "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, Math.max(1, maxLength));
  return clean || "default";
}

function safeTraceJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return "{}";
  }
}

function streamTraceFields(fields: Facts = {}) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}=${streamTraceValue(value)}`)
    .join("");
}

function streamTraceValue(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : safeTraceJson(value);
  return String(text || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w:./|@=-]/g, "_")
    .slice(0, 160);
}

function traceMessageDelivery(trace: (message: string) => void, fields: Facts = {}) {
  trace(`message_delivery_trace${streamTraceFields(fields)}`);
}

function parseToolCallArguments(value: unknown): unknown {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return value ?? {};
  const raw = value.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return raw;
  }
}

function sanitizeToolResultForLLM(result: unknown, policy: Readonly<ToolModelPolicy>): unknown {
  const projected = policy.projectResult ? policy.projectResult(result) : result;
  if (projected == null || typeof projected !== "object" || Array.isArray(projected)) return projected;
  const { _display, _debug, _rawCdp, ...out } = record(projected);
  return out;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

function buildSystemPrompt({ canManageSessions = true, runProfile = null, language = getLanguage() }: {canManageSessions?: boolean; runProfile?: RunProfile | null; language?: string} = {}) {
  return withLanguage(language, () => {
    const prompts = getAgentPrompts(language);
    const profileCanManageSessions = runProfile?.session?.canManageSessions;
    const allowSessionTools = profileCanManageSessions == null ? canManageSessions : profileCanManageSessions !== false;
    let prompt = prompts.SYSTEM_PROMPT;

    if (runProfile?.features?.imageInput === false) {
      prompt = prompt
        .replace(prompts.MULTIMODAL_CAPABILITY_PROMPT, prompts.TEXT_ONLY_CAPABILITY_PROMPT)
        .replace(prompts.READING_CAPABILITY_PROTOCOL, prompts.TEXT_ONLY_READING_CAPABILITY_PROTOCOL)
        .replace(prompts.VISUAL_TARGET_TOOL_PROTOCOL, prompts.TEXT_ONLY_TARGET_TOOL_PROTOCOL)
        .replace(prompts.VISUAL_IMAGE_ASSET_PROTOCOL, prompts.TEXT_ONLY_IMAGE_ASSET_PROTOCOL);
    }

    if (!allowSessionTools) {
      prompt = prompt.replace(prompts.GOAL_DRIVEN_RULE, prompts.RESTRICTED_GOAL_RULE);
      prompt += promptT("sessionRestriction");
    }
    return prompt + buildRunProfilePromptSection(runProfile) + sessionAutomationPromptSuffix(language);
  });
}

const MODEL_PROVENANCE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "error",
  "aborted",
]);

export class Agent {
  messages: AgentMessage[] = [];
  isStreaming = false;
  _abortCtrl: AbortController | null = null;
  _activeRun: Promise<void> | null = null;
  _runSeq = 0;
  _currentRunId: string | null = null;
  _timelineSeq = 0;
  _llmCallSeq = 0;
  _compactionPromise: Promise<CompactionResult> | null = null;
  _compactionState: Facts | null = null;
  _contextUsageSeq = 0;
  _lastContextUsageSnapshot: ContextUsageSnapshot | null = null;

  steeringQueue = new MessageQueue<AgentMessage>("all");
  followUpQueue = new MessageQueue<AgentMessage>("one-at-a-time");

  _listeners = new Set<(event: AgentEvent) => unknown>();
  _dynamicContextProvider: DynamicContextProvider | null = null;
  _dynamicContextSnapshot: DynamicContext | null = null;
  _dynamicContextSnapshotReason = "";
  _dynamicContextSnapshotAt = "";
  _runProfile: RunProfile | null = null;
  _runProfileConfigVersion = -1;
  _runtimeConfig: RuntimeConfig | null = null;
  private _runLanguage = getLanguage();
  private _toolRegistrySnapshot: unknown = null;
  _skillToolRegistrySnapshot: ReturnType<AgentServices['getSkillToolRegistrySnapshot']> | null = null;
  _loadedSkillToolNames = new Set<string>();
  _pendingContextEvents: AgentMessage[] = [];
  _followUpRunTimer: ReturnType<typeof setTimeout> | null = null;
  _unstartedPrompt: { checkpoint: number; clientMessageId: string } | null = null;
  _queueScheduleEpoch = 0;
  _pendingQueueWrites = new Set<Promise<unknown>>();
  readonly sessionId: string;
  private _services: Partial<AgentServices> | null;
  private _conversationRepository: ConversationRepository | null;
  private _conversationLease: ConversationLease;
  private _llm: AgentLlmPort | null;
  private _tools: AgentToolPort | null;
  private _browserContext: NonNullable<AgentOptions['browserContext']>;
  private _sessionPolicy: NonNullable<AgentOptions['sessionPolicy']>;
  private _ensureSkillToolRegistryReady: (reason: string) => Promise<unknown>;
  private _canStartQueuedRun: () => boolean | Promise<boolean>;


  constructor(sessionId = "default", {
    services = null,
    conversationRepository = null,
    conversationLease = null,
    llm = null,
    tools = null,
    browserContext = null,
    sessionPolicy = null,
    ensureSkillToolRegistryReady = null,
    canStartQueuedRun = null,
  }: AgentOptions = {}) {
    this.sessionId = sessionId;
    this._services = services;
    this._conversationRepository = conversationRepository;
    this._conversationLease = conversationLease || Object.freeze({
      sessionId: this.sessionId,
      isActive: () => true,
    });
    this._llm = llm;
    this._tools = tools;
    this._browserContext = browserContext || DEFAULT_AGENT_BROWSER_CONTEXT;
    this._sessionPolicy = sessionPolicy || DEFAULT_AGENT_SESSION_POLICY;
    this._ensureSkillToolRegistryReady = typeof ensureSkillToolRegistryReady === "function"
      ? ensureSkillToolRegistryReady
      : DEFAULT_AGENT_SKILL_TOOL_REGISTRY_READY;
    this._canStartQueuedRun = canStartQueuedRun || (() => true);
    this.messages = [{ role: "system", content: getAgentPrompts(this._runLanguage).SYSTEM_PROMPT }];
  }

  private get _toolRuntime() { return requiredDependency(this._tools, 'tools'); }
  private get _modelGateway() { return requiredDependency(this._llm, 'llm'); }
  private get _conversationStore() { return requiredDependency(this._conversationRepository, 'conversationRepository'); }

  _trace = (message: string) => this._services?.trace?.(message);

  _service<K extends keyof AgentServices>(name: K): AgentServices[K] { return agentService(this._services, name); }

  // -- Events ------------------------------------------------------------------

  /** Subscribe to events and return an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => unknown) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  setDynamicContextProvider(provider: DynamicContextProvider | null) {
    this._dynamicContextProvider = typeof provider === "function" ? provider : null;
  }

  _emit(event: AgentEvent) {
    const provider = String(this._runProfile?.model?.provider || "").trim();
    const model = String(this._runProfile?.model?.id || "").trim();
    if (
      this._currentRunId
      && MODEL_PROVENANCE_EVENT_TYPES.has(event.type)
      && provider
      && !event.provider
    ) {
      event = {
        ...event,
        provider,
        ...(model ? { model } : {}),
      };
    }
    if (this._currentRunId && !event.runId) event = { ...event, runId: this._currentRunId };
    if (shouldStampTimelineEvent(event) && event.eventSeq == null) {
      event = { ...event, eventSeq: ++this._timelineSeq };
    }
    const pending = [];
    for (const listener of this._listeners) {
      try {
        const result = listener(event);
        if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
          pending.push(Promise.resolve(result).catch(() => undefined));
        }
      } catch(_e) { /* Isolate listener failures from the agent. */ }
    }
    return pending.length ? Promise.all(pending) : null;
  }

  getPendingFollowUpMessages() {
    return this.followUpQueue
      .peekAll()
      .filter(msg => msg?.role === "user")
      .map(msg => this._stripRuntimeMessageFlags(msg));
  }

  getPendingSteeringMessages() {
    return this.steeringQueue
      .peekAll()
      .filter(msg => msg?.role === "user")
      .map(msg => this._stripRuntimeMessageFlags(msg));
  }

  _emitQueueUpdate({ resume = false } = {}) {
    this._emit({
      type: "queue_update",
      isRunning: this.isRunning,
      ...(resume ? { resume: true } : {}),
      pendingFollowUps: this.getPendingFollowUps(),
      pendingFollowUpMessages: this.getPendingFollowUpMessages(),
      pendingSteerings: this.getPendingSteerings(),
      pendingSteeringMessages: this.getPendingSteeringMessages(),
    });
  }

  // -- Controls ----------------------------------------------------------------

  async hydrateFromStore() {
    try {
      const saved = await this._conversationStore.readActiveConversation(this.sessionId);
      if (saved) {
        const hydrated = deserializeConversationWithRepair(saved, getAgentPrompts(this._runLanguage).SYSTEM_PROMPT);
        this.messages = hydrated.messages;
        if (hydrated.repaired) await this._persistConversation();
        this._trace(`agent hydrated: session=${this.sessionId}, msgs=${this.messages.length}`);
      }
    } catch (err) {
      if (isSessionFormatError(err)) throw err;
      this._trace(`agent hydrate failed: session=${this.sessionId}, ${record(err).message}`);
    }
  }

  async persist() {
    await this._persistConversation();
  }

  abort() {
    this._abortCtrl?.abort();
  }

  /** Includes initialization and terminal persistence, unlike model streaming. */
  get isRunning() {
    return this._activeRun !== null;
  }

  get queueScheduleEpoch() {
    return this._queueScheduleEpoch;
  }

  async waitForIdle() {
    return this._activeRun ?? Promise.resolve();
  }

  async reset() {
    this._clearScheduledFollowUpRun();
    this.messages = [{ role: "system", content: getAgentPrompts(this._runLanguage).SYSTEM_PROMPT }];
    this.steeringQueue.clear();
    this.followUpQueue.clear();
    this._emitQueueUpdate();
    this._currentRunId = null;
    this._clearDynamicContextSnapshot();
    this._runProfile = null;
    this._runtimeConfig = null;
    this._skillToolRegistrySnapshot = null;
    this._toolRegistrySnapshot = null;
    this._loadedSkillToolNames.clear();
    this._pendingContextEvents = [];
    await this._clearPersistedConversation();
  }

  exportSession() {
    return serializeConversation(this.messages);
  }

  /** Drop a prompt that was stored before agent_start. A started run keeps its messages. */
  discardUnstartedPrompt(): { clientMessageId: string } | null {
    const pending = this._unstartedPrompt;
    if (!pending || this.isStreaming || this._currentRunId) return null;
    this.messages.length = pending.checkpoint;
    this._unstartedPrompt = null;
    return { clientMessageId: pending.clientMessageId };
  }

  getPendingFollowUps() {
    return this.followUpQueue
      .peekAll()
      .filter(msg => msg?.role === "user")
      .map((msg, index) => summarizeQueuedUserMessage(msg, index));
  }

  getPendingSteerings() {
    return this.steeringQueue
      .peekAll()
      .filter(msg => msg?.role === "user")
      .map((msg, index) => summarizeQueuedUserMessage(msg, index));
  }

  restorePendingFollowUps(messages: unknown = []) {
    this.followUpQueue.setAll(this._normalizeRestoredQueuedMessages(messages));
    this._emitQueueUpdate();
    if (this.followUpQueue.hasItems()) this._scheduleNextFollowUpRun();
  }

  restorePendingSteerings(messages: unknown = []) {
    this.steeringQueue.setAll(this._normalizeRestoredQueuedMessages(messages));
    this._emitQueueUpdate();
    if (this.steeringQueue.hasItems()) this._scheduleNextFollowUpRun();
  }

  restorePendingQueues({ followUps = [], steerings = [] }: {followUps?: unknown; steerings?: unknown} = {}) {
    const seenClientMessageIds = this._deliveredUserMessageIds();
    const restoredSteerings = this._normalizeRestoredQueuedMessages(steerings, seenClientMessageIds);
    for (const message of restoredSteerings) {
      const id = String(message?.clientMessageId || "").trim();
      if (id) seenClientMessageIds.add(id);
    }
    this.steeringQueue.setAll(restoredSteerings);
    this.followUpQueue.setAll(this._normalizeRestoredQueuedMessages(followUps, seenClientMessageIds));
    this._emitQueueUpdate();
    if (this.steeringQueue.hasItems() || this.followUpQueue.hasItems()) this._scheduleNextFollowUpRun();
  }

  _deliveredUserMessageIds() {
    return new Set(this.messages
      .filter(message => message?.role === "user")
      .map(message => String(message?.clientMessageId || "").trim())
      .filter(Boolean));
  }

  findAcceptedUserMessage(clientMessageId = "") {
    const id = String(clientMessageId || "").trim();
    if (!id) return null;
    return this.messages.find(message => (
      message?.role === "user"
      && message._accepting !== true
      && String(message.clientMessageId || "").trim() === id
    )) || null;
  }

  findPendingUserMessage(clientMessageId = "") {
    const id = String(clientMessageId || "").trim();
    if (!id) return null;
    return [...this.steeringQueue.peekAll(), ...this.followUpQueue.peekAll()].find(message => (
      message?.role === "user"
      && String(message.clientMessageId || "").trim() === id
    )) || null;
  }

  hasPendingUserInput() {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  _normalizeRestoredQueuedMessages(messages: unknown = [], seenClientMessageIds = this._deliveredUserMessageIds()) {
    const seen = seenClientMessageIds instanceof Set ? seenClientMessageIds : new Set();
    return (Array.isArray(messages) ? messages : [])
      .map(record)
      .filter(msg => {
        if (msg?.role !== "user") return false;
        const id = String(msg?.clientMessageId || "").trim();
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map(msg => this._markRuntimeContextRefresh(this._markUserMessage({
        ...msg,
        role: "user",
        ...normalizeClientMessageMeta(String(msg.clientMessageId || "")),
      })));
  }

  async restoreSession(saved: unknown) {
    this._clearScheduledFollowUpRun();
    this.messages = deserializeConversationWithRepair(saved, getAgentPrompts(this._runLanguage).SYSTEM_PROMPT).messages;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
    this._emitQueueUpdate();
    this._currentRunId = null;
    this._clearDynamicContextSnapshot();
    this._runProfile = null;
    this._runtimeConfig = null;
    this._skillToolRegistrySnapshot = null;
    this._toolRegistrySnapshot = null;
    this._loadedSkillToolNames.clear();
    this._pendingContextEvents = [];
    await this._persistConversation();
  }

  restoreLoadedSkillToolNames(names: unknown = []) {
    this._loadedSkillToolNames = new Set(
      (Array.isArray(names) ? names : [])
        .map(name => String(name || "").trim().toLowerCase())
        .filter(Boolean),
    );
    return [...this._loadedSkillToolNames];
  }

  _repairToolLedger(reason = t("agent.toolInterrupted")) {
    const repaired = repairToolMessageSequence(this.messages, { interruptedReason: reason });
    if (!repaired.changed) return false;
    this.messages = repaired.messages;
    this._trace(`repaired tool ledger: inserted=${repaired.inserted}, dropped=${repaired.dropped}, session=${this.sessionId}`);
    return true;
  }

  async _persistIfToolLedgerRepaired(reason = t("agent.toolInterrupted")) {
    if (!this._repairToolLedger(reason)) return false;
    await this._persistConversation();
    return true;
  }

  async _persistIfInterruptedTurnRepaired(reason = t("agent.turnInterrupted")) {
    const toolLedgerChanged = this._repairToolLedger(reason);
    const lastVisible = [...this.messages].reverse().find(msg => (
      msg?.role !== "system" && !this._isHiddenContextMessage(msg)
    ));
    const dangling = lastVisible?.role === "user" || lastVisible?.role === "tool";
    if (dangling) {
      this.messages.push({ role: "assistant", content: reason, _kind: "interrupted" });
    }
    if (!toolLedgerChanged && !dangling) return false;
    await this._persistConversation();
    return true;
  }

  getRunState() {
    return {
      isRunning: this.isRunning,
      isStreaming: this.isStreaming,
      isCompacting: Boolean(this._compactionPromise),
      compaction: this._compactionState || null,
      runId: this._currentRunId,
      hasHistory: this.messages.length > 1,
      pendingFollowUps: this.getPendingFollowUps(),
      pendingSteerings: this.getPendingSteerings(),
    };
  }

  getRunToolContext(runId = "") {
    const expectedRunId = String(runId || "").trim();
    if (!this.isStreaming || !this._currentRunId || (expectedRunId && expectedRunId !== this._currentRunId)) return null;
    return {
      runId: this._currentRunId,
      dynamicContext: this._dynamicContextSnapshot,
      loadedPluginSkillNames: [...this._loadedSkillToolNames],
      runProfile: this._runProfile,
      skillToolRegistrySnapshot: this._skillToolRegistrySnapshot,
      toolRegistrySnapshot: this._toolRegistrySnapshot,
      language: this._runLanguage,
    };
  }

  async applyNestedToolResult({ runId = "", toolName = "", result = null, isError = false }: {runId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean} = {}) {
    if (!this.getRunToolContext(runId) || !String(toolName || "").trim()) return false;
    const contextEvents = await this._applyToolResultEffects(toolName, result, isError);
    for (const event of contextEvents) this._enqueueContextEvent(event);
    return true;
  }

  async getContextUsageState() {
    if (this.messages.length <= 1) return {};
    try {
      const runProfile = this.isStreaming && this._runProfile
        ? this._runProfile
        : await this._buildRunProfile();
      this._runProfile = runProfile;
      const dynamicContext = this._dynamicContextSnapshot || await this._ensureDynamicContextSnapshot(null, "usage");
      await this._ensureSkillToolRegistryReady("context_usage_tools").catch((err) => {
        this._trace(`Skill tool registry usage init failed: ${record(err).message || err}`);
      });
      const toolSchemas = this._toolRuntime.getSchemas({
        runProfile,
        dynamicContext,
        skillToolRegistrySnapshot: this.isStreaming ? this._skillToolRegistrySnapshot : null,
        toolRegistrySnapshot: this.isStreaming ? this._toolRegistrySnapshot : null,
        language: this.isStreaming ? this._runLanguage : getLanguage(),
        loadedPluginSkillNames: this._loadedSkillToolNames,
      });
      const estimate = this._estimateSendWindowContext(dynamicContext, toolSchemas);
      if (!estimate.tokens) return {};
      return {
        contextUsage: null,
        contextWindow: this._contextWindow(runProfile),
        inputTokensEstimate: estimate.tokens,
        contextEstimateSource: estimate.source,
        usageAnchorTokens: estimate.usageTokens,
        estimatedTrailingTokens: estimate.trailingTokens,
        toolSchemaTokens: estimate.toolSchemaTokens,
        messageTokensEstimate: estimate.messageTokens,
        usageAnchorMessageIndex: estimate.lastUsageIndex,
        contextBoundaryId: estimate.boundaryId,
      };
    } catch (err) {
      this._trace(`context usage state failed: ${record(err).message || err}`);
      return {};
    }
  }

  getAbortSignal() {
    return this._abortCtrl?.signal || null;
  }

  /** Process pending work after the agent has fully stopped. */
  followUp(text: string, images: unknown[] = [], clientMessageId = "", documents: unknown[] = [], beforeRun: (() => unknown) | null = null, deliveryMode = "follow_up") {
    const scheduleEpoch = this._queueScheduleEpoch;
    const userMsg = this._markRuntimeContextRefresh(this._markUserMessage(
      this._buildUserMessage(text, images, clientMessageId, documents),
    ));
    const queue = deliveryMode === "steer" ? this.steeringQueue : this.followUpQueue;
    queue.enqueue(userMsg);
    this._emitQueueUpdate({ resume: typeof beforeRun !== "function" });
    if (typeof beforeRun !== "function") return this._scheduleNextFollowUpRun(scheduleEpoch);
    this._clearScheduledFollowUpRun();
    const write = Promise.resolve().then(beforeRun).then(() => {
      this._emitQueueUpdate({ resume: scheduleEpoch === this._queueScheduleEpoch });
    }).catch(error => {
      queue.removeByClientMessageId(clientMessageId, userMsg);
      this._emitQueueUpdate();
      throw error;
    }).finally(() => {
      this._pendingQueueWrites.delete(write);
      this._scheduleNextFollowUpRun(scheduleEpoch);
    });
    this._pendingQueueWrites.add(write);
    return write;
  }

  steerFollowUp(clientMessageId = "") {
    const scheduleEpoch = this._queueScheduleEpoch;
    const removed = this.followUpQueue.removeByClientMessageId(clientMessageId);
    if (!removed) return null;
    this._clearScheduledFollowUpRun();
    this.steeringQueue.enqueue(removed.message);
    this._emitQueueUpdate();
    this._scheduleNextFollowUpRun(scheduleEpoch);
    return { message: this._stripRuntimeMessageFlags(removed.message) };
  }

  _clearScheduledFollowUpRun() {
    if (!this._followUpRunTimer) return;
    clearTimeout(this._followUpRunTimer);
    this._followUpRunTimer = null;
  }

  _scheduleNextFollowUpRun(scheduleEpoch = this._queueScheduleEpoch) {
    if (
      !this._hasActiveLease()
      || scheduleEpoch !== this._queueScheduleEpoch
      || this._followUpRunTimer
      || this._compactionPromise
      || (!this.steeringQueue.hasItems() && !this.followUpQueue.hasItems())
    ) return;
    if (this._pendingQueueWrites.size) {
      void Promise.allSettled([...this._pendingQueueWrites]).then(() => this._scheduleNextFollowUpRun(scheduleEpoch));
      return;
    }
    // Wait through terminal persistence; the epoch rejects callbacks from a failed handoff.
    if (this._activeRun) {
      void this._activeRun.then(() => this._scheduleNextFollowUpRun(scheduleEpoch));
      return;
    }
    this._followUpRunTimer = setTimeout(() => {
      this._followUpRunTimer = null;
      this._runNextFollowUpRun(scheduleEpoch).catch((err) => {
        this._trace(`follow-up run failed: session=${this.sessionId}, ${record(err).message || err}`);
      });
    }, FOLLOW_UP_RUN_HANDOFF_DELAY_MS);
  }

  async _runNextFollowUpRun(scheduleEpoch = this._queueScheduleEpoch) {
    if (!await this._canStartQueuedRun()) return false;
    if (
      !this._hasActiveLease()
      || scheduleEpoch !== this._queueScheduleEpoch
      || this._activeRun
      || this._compactionPromise
      || this._pendingQueueWrites.size
      || (!this.steeringQueue.hasItems() && !this.followUpQueue.hasItems())
    ) return false;
    // Both queues remain visible until initialization completes; steering takes priority.
    await this._runWithLifecycle([], this.steeringQueue.hasItems()
      ? { requireSteeringHandoff: true }
      : { requireFollowUpHandoff: true });
    return true;
  }

  async removeFollowUp(clientMessageId = "", beforeCommit: MessageHook = null) {
    return this._removeQueuedMessage(this.followUpQueue, clientMessageId, beforeCommit);
  }

  async removeSteering(clientMessageId = "", beforeCommit: MessageHook = null) {
    return this._removeQueuedMessage(this.steeringQueue, clientMessageId, beforeCommit);
  }

  async _removeQueuedMessage(queue: MessageQueue<AgentMessage>, clientMessageId: string, beforeCommit: MessageHook) {
    const scheduleEpoch = this._queueScheduleEpoch;
    const queued = queue.peekAll().find(message => message.clientMessageId === clientMessageId);
    if (!queued) return null;

    this._clearScheduledFollowUpRun();
    const message = this._stripRuntimeMessageFlags(queued);
    // Keep accepted work visible until cleanup succeeds; a failed deletion never exposes
    // a transient empty queue. Existing queue-write admission also pauses steering handoff.
    const write = Promise.resolve().then(async () => {
      const cleanup = typeof beforeCommit === "function" ? await beforeCommit(message) : null;
      queue.removeByClientMessageId(clientMessageId, queued);
      this._emitQueueUpdate();
      return { message, cleanup };
    }).finally(() => {
      this._pendingQueueWrites.delete(write);
      this._scheduleNextFollowUpRun(scheduleEpoch);
    });
    this._pendingQueueWrites.add(write);
    return write;
  }

  reorderFollowUps(clientMessageIds: string[] = []) {
    const changed = this.followUpQueue.reorderByClientMessageIds(clientMessageIds);
    if (changed) this._emitQueueUpdate();
    return changed;
  }

  // -- Main loop ---------------------------------------------------------------

  /**
   * Send a user message and run the agent loop.
   * @param {string} text
   * @param {{pageTitle?: string, pageUrl?: string}} [context]
   * @param {{dataUrl:string, type?:string, name?:string}[]} [images]
   */
  async prompt(text: string, context?: DynamicContext | null, images: unknown[] = [], clientMessageId = "", documents: unknown[] = [], onAccepted: MessageHook = null) {
    traceMessageDelivery(this._trace, {
      phase: "agent.received",
      session: this.sessionId,
      message: clientMessageId,
    });
    if (this._activeRun) {
      const error = new Error(`session is already running: ${this.sessionId}`);
      Object.assign(error, { code: "AGENT_ALREADY_RUNNING" });
      throw error;
    }

    this._assertActiveLease();
    const dynamicContext = await this._refreshDynamicContextSnapshot(context, "prompt");
    this._assertActiveLease();
    await this._persistIfInterruptedTurnRepaired();
    this._assertActiveLease();
    const messageCheckpoint = this.messages.length;
    const unstartedPrompt = { checkpoint: messageCheckpoint, clientMessageId: String(clientMessageId || "").trim() };
    this._unstartedPrompt = unstartedPrompt;
    try {
      const contextCapsule = this._buildContextCapsuleMessage(dynamicContext, "prompt");
      if (contextCapsule) this.messages.push(contextCapsule);
      const goalCapsule = this._buildGoalSnapshotCapsuleMessage(dynamicContext, "user_message");
      if (goalCapsule) this.messages.push(goalCapsule);
      const normalizedDocuments = normalizeMessageDocuments(documents);
      if (!String(text || "").trim() && !normalizeUserImageInputs(images).length && !normalizedDocuments.length) {
        this.messages.length = messageCheckpoint;
        throw new Error(t("agent.emptyRequest"));
      }
      const documentCapsule = this._buildDocumentCapsuleMessage(normalizedDocuments, clientMessageId);
      if (documentCapsule) this.messages.push(documentCapsule);
      const userMsg: AgentMessage = {
        ...this._markUserMessage(this._buildUserMessage(text, images, clientMessageId, normalizedDocuments)),
        _accepting: true,
      };
      this.messages.push(userMsg);
      await this._persistConversation({
        rethrow: true,
        retryOnce: true,
        deliveryMessageId: clientMessageId,
      }).catch(error => {
        this.messages.length = messageCheckpoint;
        throw error;
      });
      delete userMsg._accepting;
      this._assertActiveLease();
      traceMessageDelivery(this._trace, {
        phase: "agent.accepted",
        session: this.sessionId,
        message: clientMessageId,
      });
      this._emitUserMessageAccepted(userMsg);
      void Promise.resolve().then(() => onAccepted?.(userMsg)).catch(error => this._trace(`agent accepted hook failed: ${error?.message || error}`));

      await this._runWithLifecycle([], { clientMessageId });
    } finally {
      if (this._unstartedPrompt === unstartedPrompt) this._unstartedPrompt = null;
    }
  }

  async editUserMessageAndRerun({ clientMessageId = "", text = "", images = [], documents = [], context = null, onReplaced = null }: {clientMessageId?: string; text?: string; images?: unknown[]; documents?: unknown[]; context?: DynamicContext | null; onReplaced?: ((replacement: {conversation: unknown; message: AgentMessage; targetIndex: number}) => unknown) | null} = {}) {
    if (this._activeRun) {
      throw new Error(t("agent.editWhileRunning"));
    }
    this._assertActiveLease();

    const normalizedClientMessageId = String(clientMessageId || "").trim();
    const targetIndex = findEditableUserMessageIndex(this.messages, normalizedClientMessageId);
    const pendingPrevious = targetIndex < 0
      ? this._findPendingUserMessage(normalizedClientMessageId)
      : null;
    const previous = targetIndex >= 0 ? this.messages[targetIndex] : pendingPrevious;
    const preservedImages = previous ? extractUserMessageImages(previous) : normalizeUserImageInputs(images);
    const preservedDocuments = previous
      ? normalizeMessageDocuments(previous.documents)
      : normalizeMessageDocuments(documents);
    const nextText = String(text || "").trim();
    if (!nextText && preservedImages.length === 0 && preservedDocuments.length === 0) throw new Error(t("agent.emptyRequest"));

    const dynamicContext = await this._refreshDynamicContextSnapshot(context, "prompt_edit");
    this._assertActiveLease();
    const contextCapsule = this._buildContextCapsuleMessage(dynamicContext, "prompt_edit");
    const goalCapsule = this._buildGoalSnapshotCapsuleMessage(dynamicContext, "user_message");
    const replacement = this._markUserMessage(this._buildUserMessage(
      nextText,
      preservedImages,
      previous?.clientMessageId || normalizedClientMessageId,
      preservedDocuments,
    ));
    const documentCapsule = this._buildDocumentCapsuleMessage(
      preservedDocuments,
      previous?.clientMessageId || normalizedClientMessageId,
    );
    let replaced;
    if (targetIndex >= 0) {
      let prefix = this.messages.slice(0, targetIndex);
      while (this._isHiddenContextMessage(prefix[prefix.length - 1])) {
        prefix = prefix.slice(0, -1);
      }
      this.messages = [
        ...prefix,
        ...(contextCapsule ? [contextCapsule] : []),
        ...(goalCapsule ? [goalCapsule] : []),
        ...(documentCapsule ? [documentCapsule] : []),
        replacement,
      ];
      replaced = {
        messages: this.messages,
        previous,
        targetIndex: this.messages.length - 1,
      };
    } else {
      await this._persistIfToolLedgerRepaired(t("agent.editStartedNew"));
      if (contextCapsule) this.messages.push(contextCapsule);
      if (goalCapsule) this.messages.push(goalCapsule);
      if (documentCapsule) this.messages.push(documentCapsule);
      this.messages.push(replacement);
      replaced = {
        messages: this.messages,
        previous: pendingPrevious,
        targetIndex: this.messages.length - 1,
        appended: true,
      };
    }
    this.steeringQueue.clear();
    this.followUpQueue.clear();
    this._emitQueueUpdate();
    await this._persistConversation();
    this._assertActiveLease();
    await onReplaced?.({
      conversation: this.exportSession(),
      message: replacement,
      targetIndex: replaced.targetIndex,
    });
    this._assertActiveLease();

    await this._runWithLifecycle([], { clientMessageId: replacement.clientMessageId || "" });
  }

  _findPendingUserMessage(clientMessageId = "") {
    const id = String(clientMessageId || "").trim();
    const pending = this.followUpQueue.peekAll().filter(msg => msg?.role === "user");
    if (!pending.length) return null;
    if (!id) return pending[pending.length - 1] || null;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (String(pending[i]?.clientMessageId || "").trim() === id) return pending[i];
    }
    return null;
  }

  _buildUserMessage(text: string, images: unknown[] = [], clientMessageId = "", documents: unknown[] = []): AgentMessage {
    const content = text;
    const normalizedDocuments = normalizeMessageDocuments(documents);

    const imageParts = (Array.isArray(images) ? images : [])
      .filter((img): img is {dataUrl: string} => typeof record(img).dataUrl === "string" && String(record(img).dataUrl).startsWith("data:image/"))
      .map(img => ({
        type: "image_url",
        image_url: { url: img.dataUrl, detail: "auto" },
      }));
    const userMsg = {
      role: "user",
      content: imageParts.length > 0
        ? [{ type: "text", text: content || promptT("viewImage") }, ...imageParts]
        : content,
      ...normalizeClientMessageMeta(clientMessageId),
      ...(normalizedDocuments.length ? { documents: normalizedDocuments } : {}),
    };
    return userMsg;
  }

  _emitUserMessageAccepted(message: AgentMessage) {
    this._emit({
      type: "message_start",
      message,
      clientMessageId: message?.clientMessageId,
      deliveryStatus: "accepted",
    });
  }

  _markUserMessage(msg: AgentMessage): AgentMessage {
    return { ...msg, _origin: MESSAGE_ORIGIN_USER };
  }

  _markRuntimeContextRefresh(msg: AgentMessage): AgentMessage {
    return { ...msg, _refreshDynamicContext: true };
  }

  _stripRuntimeMessageFlags(msg: AgentMessage): AgentMessage {
    if (!msg || typeof msg !== "object") return msg;
    const { _refreshDynamicContext, ...clean } = msg;
    return clean;
  }

  async _runWithLifecycle(initialPendingMessages: AgentMessage[] = [], {
    requireSteeringHandoff = false, requireFollowUpHandoff = false, clientMessageId = "",
  } = {}) {
    if (this._activeRun) throw new Error("Already running");
    this._assertActiveLease();
    this._clearScheduledFollowUpRun();

    // Claim synchronously, before initialization can yield or a queue can lose its last item.
    // This one promise owns startup, execution and terminal commit; cleanup compares its identity.
    let resolve: () => void = () => {};
    const activeRun = new Promise<void>((r) => { resolve = r; });
    this._activeRun = activeRun;
    const scheduleEpoch = this._queueScheduleEpoch;
    const controller = new AbortController();
    this._abortCtrl = controller;
    const { signal } = controller;
    const runId = createRunId(this.sessionId, ++this._runSeq);
    this._timelineSeq = 0;
    let started = false;
    let succeeded = false;
    let handoffConsumed = !requireSteeringHandoff && !requireFollowUpHandoff;
    const invalidateHandoff = () => {
      if (this._queueScheduleEpoch !== scheduleEpoch) return;
      this._queueScheduleEpoch += 1;
      this._clearScheduledFollowUpRun();
    };
    try {
      this._emit({ type: "session_pending", runId });
      this._assertRunCanStart(signal);
      await whenLanguageReady();
      this._runLanguage = getLanguage();
      await this._ensureSkillToolRegistryReady("agent_run_start").catch((err) => {
        this._trace(`Skill tool registry run start initialization failed: ${record(err).message || err}`);
      });
      this._assertRunCanStart(signal);
      this._skillToolRegistrySnapshot = this._service("getSkillToolRegistrySnapshot")(this._runLanguage);
      this._toolRegistrySnapshot = this._toolRuntime.snapshot?.(this._runLanguage) || null;
      this._runProfile = await this._buildRunProfile();
      this._assertRunCanStart(signal);

      this.isStreaming = true;
      this._llmCallSeq = 0;
      this._contextUsageSeq = 0;
      this._lastContextUsageSnapshot = null;
      this._currentRunId = runId;
      started = true;
      this._unstartedPrompt = null;
      this._emit({ type: "agent_start", runId,
        ...(clientMessageId ? { clientMessageId, eventSeq: ++this._timelineSeq } : {}),
      });
      await this._runLoop(signal, initialPendingMessages, {
        requireSteeringHandoff, requireFollowUpHandoff,
        onInitialHandoff: () => { handoffConsumed = true; },
      });
      succeeded = !signal.aborted;
      if (signal.aborted) {
        if (!handoffConsumed) invalidateHandoff();
        await this._emit({ type: "aborted", runId });
      }
    } catch (err) {
      if (this._activeRun === activeRun) {
        // Retain an unconsumed queued message without endlessly retrying its preparation.
        // Once handed off, execution failures keep the existing next-message behavior.
        if (!started || !handoffConsumed) invalidateHandoff();
        if (record(err).name === "AbortError") {
          await this._emit({ type: "aborted", runId });
        } else {
          await this._emit({
            type: "error",
            message: String(record(err).message || err),
            code: String(record(err).code || "AGENT_RUN_FAILED"),
            ...(record(err).kind ? { kind: String(record(err).kind) } : {}),
            ...(record(err).status ? { status: Number(record(err).status) } : {}),
            ...(record(err).requestId ? { requestId: String(record(err).requestId) } : {}),
            runId,
          });
        }
      }
      if (!started) throw err;
    } finally {
      try {
        if (this._activeRun === activeRun) {
          try {
            if (started && this._hasActiveLease()) {
              await this._persistIfToolLedgerRepaired(t("agent.toolStopped"));
              await this._flushPendingContextEvents();
              try {
                await this._pruneOldToolResultsIfNeeded();
              } catch (err) {
                this._trace(`old tool result prune failed: session=${this.sessionId}, ${record(err).message || err}`);
              }
            }
          } catch (err) {
            invalidateHandoff();
            await this._emit({ type: "error", runId, message: String(record(err).message || err), code: "AGENT_FINALIZATION_FAILED" });
          }
          this.isStreaming = false;
          const provider = String(this._runProfile?.model?.provider || "").trim();
          const model = String(this._runProfile?.model?.id || "").trim();
          this._currentRunId = null;
          await this._emit({ type: "agent_end", runId,
            ...(provider ? { provider } : {}), ...(model ? { model } : {}),
          });
        }
      } catch (err) {
        invalidateHandoff();
        throw err;
      } finally {
        if (this._activeRun === activeRun) {
          this.isStreaming = false;
          this._activeRun = null;
          if (this._abortCtrl === controller) this._abortCtrl = null;
          this._currentRunId = null;
          this._clearDynamicContextSnapshot();
          this._runProfile = null;
          this._runtimeConfig = null;
          this._skillToolRegistrySnapshot = null;
          this._toolRegistrySnapshot = null;
          // A user may remove the final queued message while terminal persistence is pending.
          this._emitQueueUpdate();
          if (started && (succeeded || handoffConsumed)) {
            this._scheduleNextFollowUpRun(scheduleEpoch);
          }
        }
        resolve();
      }
    }
  }

  /** Core agent loop: nested loops process messages and tool calls. */
  async _runLoop(signal: AbortSignal, initialPendingMessages: AgentMessage[] = [], {
    requireSteeringHandoff = false, requireFollowUpHandoff = false, onInitialHandoff = () => {},
  } = {}) {
    let turnCount = 0;
    let awaitingInitialHandoff = requireSteeringHandoff || requireFollowUpHandoff;
    let awaitingFollowUp = requireFollowUpHandoff;

    let pendingMessages = Array.isArray(initialPendingMessages) ? [...initialPendingMessages] : [];

    // Drain steering at complete turn boundaries; consume follow-ups in a new run after agent_end.
    outer: while (true) {
      let hasMoreToolCalls = true;

      // Process initial and steering messages, then their tool calls.
      while (hasMoreToolCalls || pendingMessages.length > 0 || this.steeringQueue.hasItems()) {
        if (signal.aborted) break outer;
        while (this._pendingQueueWrites?.size) await Promise.allSettled([...this._pendingQueueWrites]);
        if (signal.aborted) break outer;
        if (!hasMoreToolCalls && !pendingMessages.length && !this.steeringQueue.hasItems()) break;
        if (awaitingInitialHandoff && pendingMessages.length === 0 && !this.steeringQueue.hasItems()
          && !(awaitingFollowUp && this.followUpQueue.hasItems())) {
          break outer;
        }
        turnCount++;

        this._emit({ type: "turn_start", turnIndex: turnCount });

        // Prepare context first; queued messages remain visible until the run can accept them.
        // Drain once at handoff, persist, then broadcast dequeue and message events together.
        const steeringCandidates = this.steeringQueue.peekAll();
        const followUpCandidates = awaitingFollowUp ? this.followUpQueue.peekAll().slice(0, 1) : [];
        const pendingCandidates = [...pendingMessages, ...followUpCandidates, ...steeringCandidates];
        let pendingContextCapsule = null;
        let pendingGoalCapsule = null;
        if (pendingCandidates.some(msg => msg?._refreshDynamicContext)) {
          const dynamicContext = await this._refreshDynamicContextSnapshot(null, "queued_user_message");
          pendingContextCapsule = this._buildContextCapsuleMessage(dynamicContext, "queued_user_message");
          pendingGoalCapsule = this._buildGoalSnapshotCapsuleMessage(dynamicContext, "user_message");
        }
        if (pendingCandidates.length > 0) {
          await this._persistIfInterruptedTurnRepaired();
        }
        if (signal.aborted) break outer;

        while (this._pendingQueueWrites?.size) await Promise.allSettled([...this._pendingQueueWrites]);
        if (signal.aborted) break outer;
        const drainedFollowUps = awaitingFollowUp ? this.followUpQueue.drain() : [];
        awaitingFollowUp = false;
        pendingMessages.push(...drainedFollowUps);
        const drainedSteeringMessages = this.steeringQueue.drain();
        if (drainedSteeringMessages.length > 0) {
          pendingMessages.push(...drainedSteeringMessages);
        }

        const acceptedUserMessages = [];
        if (pendingMessages.length > 0 && pendingContextCapsule) this.messages.push(pendingContextCapsule);
        if (pendingMessages.length > 0 && pendingGoalCapsule) this.messages.push(pendingGoalCapsule);
        for (const msg of pendingMessages) {
          const cleanMsg = this._stripRuntimeMessageFlags(msg);
          const documentCapsule = this._buildDocumentCapsuleMessage(cleanMsg.documents, cleanMsg.clientMessageId);
          if (documentCapsule) this.messages.push(documentCapsule);
          this.messages.push(cleanMsg);
          acceptedUserMessages.push(cleanMsg);
        }
        if (acceptedUserMessages.length > 0) {
          if (awaitingInitialHandoff) onInitialHandoff();
          await this._persistConversation();
          if (drainedFollowUps.length > 0 || drainedSteeringMessages.length > 0) this._emitQueueUpdate();
        }
        for (const cleanMsg of acceptedUserMessages) {
          this._emit({ type: "message_start", message: cleanMsg });
          this._emit({ type: "message_end", message: cleanMsg });
        }
        pendingMessages = [];
        if (acceptedUserMessages.length > 0) {
          awaitingInitialHandoff = false;
        } else if (awaitingInitialHandoff) {
          this._emit({ type: "turn_end", turnIndex: turnCount });
          break outer;
        }

        // Repair tool history first; the send window decides whether to compact before the request.
        await this._persistIfToolLedgerRepaired(t("agent.toolInterrupted"));
        await this._flushPendingContextEvents();

        // Call the model.
        const assistantMsg = await this._callLLMWithEmptyRetry(signal);
        // _thinking, _stopReason and _spanId are runtime fields; replay only provider-approved _providerState.
        // _error records run diagnostics; _usage preserves actual token counts in history. _toSendMessage strips both.
        const {
          _thinking,
          _stopReason,
          _error,
          _spanId,
          _streamTraceId,
          ...cleanMsg
        } = assistantMsg;
        if (_stopReason !== "error") {
          this.messages.push(cleanMsg);
          await this._persistConversation();
        }

        // Text response
        if (assistantMsg.content) {
          const spanId = typeof _spanId === "string" ? _spanId : undefined;
          const streamTraceId = typeof _streamTraceId === "string" && _streamTraceId || spanId;
          this._emit({
            type: "message_end",
            spanId,
            streamTraceId,
            message: assistantMsg,
          });
        }

        // Stop on errors.
        if (_stopReason === "error" || _stopReason === "aborted") {
          if (_stopReason === "aborted") {
            this._emit({ type: "aborted", runId: this._currentRunId });
          }
          this._emit({ type: "turn_end", turnIndex: turnCount });
          if (_stopReason === "error") {
            const failure = new Error(String(assistantMsg.content || t("agent.llmFailed")).replace(/^❌\s*/u, ""));
            Object.assign(failure, _error || { code: "LLM_CALL_FAILED" });
            throw failure;
          }
          break outer;
        }

        // Extract tool calls.
        const toolCalls = assistantMsg.tool_calls ?? [];
        hasMoreToolCalls = false;

        if (toolCalls.length > 0) {
          const toolResults = await this._executeToolCalls(toolCalls, signal);

          // Append tool results to message history.
          for (const tr of toolResults) {
            this.messages.push(tr);
          }
          this._repairToolLedger(signal.aborted ? t("agent.toolStopped") : t("agent.toolInterrupted"));
          await this._persistConversation();

          hasMoreToolCalls = true; // Continue so the model can read the tool results.
        }

        this._emit({ type: "turn_end", turnIndex: turnCount });

        pendingMessages = [];
      }

      break; // End the run.
    }
  }

  // -- System prompt and dynamic Skill injection --------------------------------

  async _canManageSessions() {
    try {
      return await this._sessionPolicy.canManageSessions(this.sessionId) !== false;
    } catch(_e) {
      return false;
    }
  }

  async _buildRunProfile() {
    const canManageSessions = await this._canManageSessions();
    const [runtimeConfig, platformInfo] = await Promise.all([
      this._service("getRuntimeConfig")(),
      this._service("getPlatformInfo")(),
    ]);
    const runtimeConfigVersion = this._service("getRuntimeConfigVersion")();
    this._runtimeConfig = runtimeConfig;
    const profile = await buildRunProfile({
      sessionId: this.sessionId,
      canManageSessions,
      config: runtimeConfig,
      platformInfo,
    });
    this._runProfileConfigVersion = runtimeConfigVersion;
    return profile;
  }

  async _ensureFreshRunProfile() {
    if (this.isStreaming && this._runProfile) return this._runProfile;
    const currentConfigVersion = this._service("getRuntimeConfigVersion")();
    if (this._runProfile && this._runProfileConfigVersion === currentConfigVersion) {
      return this._runProfile;
    }
    this._runProfile = await this._buildRunProfile();
    return this._runProfile;
  }

  async _refreshSystemPrompt(runProfile: RunProfile | null = null) {
    const [skillSection, guardrails] = await Promise.all([
      this._service("buildSkillPromptSection")(this._runLanguage),
      this._service("getSecurityGuardrails")().catch(() => ({ blockedDomains: [], blockedPatterns: [] })),
    ]);
    const profile = runProfile || this._runProfile || await this._buildRunProfile();
    const fileAccessRestriction = this._dynamicContextSnapshot?.fileAccessAllowed === false
      ? withLanguage(this._runLanguage, () => `\n\n${promptT("fileAccessDisabled")}`) : "";
    const systemMessage = {
      role: "system",
      content: withLanguage(this._runLanguage, () => buildSystemPrompt({ runProfile: profile, language: this._runLanguage }) + buildSecurityGuardrailPromptSection(guardrails)) + skillSection + fileAccessRestriction,
    };
    if (this.messages[0]?.role === "system") {
      this.messages[0] = systemMessage;
    } else {
      this.messages.unshift(systemMessage);
    }
  }

  // -- Compaction ---------------------------------------------------------------

  async _compactIfNeeded(signal: AbortSignal | null | undefined, dynamicContext = this._dynamicContextSnapshot, toolSchemas: object[] = []) {
    return this._runContextCompaction(signal, dynamicContext, toolSchemas, {
      force: false,
      trigger: "threshold",
    });
  }

  async compactContext(signal?: AbortSignal | null, options: CompactionOptions = {}) {
    this._assertActiveLease();
    const scheduleEpoch = this._queueScheduleEpoch;
    if (this._activeRun && !this._currentRunId) {
      const error = new Error(`session is already running: ${this.sessionId}`);
      Object.assign(error, { code: "AGENT_ALREADY_RUNNING" });
      throw error;
    }
    const standalone = !this._activeRun;
    let resolveStandalone: () => void = () => {};
    const standaloneRun = standalone ? new Promise<void>(resolve => { resolveStandalone = resolve; }) : null;
    if (standalone) this._activeRun = standaloneRun;
    const ownedAbortController = !signal && !this._abortCtrl ? new AbortController() : null;
    if (ownedAbortController) this._abortCtrl = ownedAbortController;
    const compactSignal = signal || this._abortCtrl?.signal || null;
    try {
      const runProfile = await this._ensureFreshRunProfile();
      compactSignal?.throwIfAborted?.();
      this._assertActiveLease();
      const dynamicContext = Object.prototype.hasOwnProperty.call(options, "dynamicContext")
        ? options.dynamicContext ?? null
        : await this._ensureDynamicContextSnapshot(null, "compact");
      compactSignal?.throwIfAborted?.();
      this._assertActiveLease();
      await this._ensureSkillToolRegistryReady("context_compaction_tools").catch((err) => {
        this._trace(`Skill tool registry compact tool schema init failed: ${record(err).message || err}`);
      });
      const toolSchemas = Array.isArray(options.toolSchemas)
        ? options.toolSchemas
        : this._toolRuntime.getSchemas({
          runProfile,
          dynamicContext,
          skillToolRegistrySnapshot: this.isStreaming ? this._skillToolRegistrySnapshot : null,
        toolRegistrySnapshot: this.isStreaming ? this._toolRegistrySnapshot : null,
        language: this.isStreaming ? this._runLanguage : getLanguage(),
          loadedPluginSkillNames: this._loadedSkillToolNames,
        });
      return await this._runContextCompaction(compactSignal, dynamicContext, toolSchemas, {
        force: true,
        trigger: String(options.trigger || "manual"),
        instruction: String(options.instruction || "").trim(),
      });
    } finally {
      if (ownedAbortController && this._abortCtrl === ownedAbortController) this._abortCtrl = null;
      if (standalone && this._activeRun === standaloneRun) {
        this._activeRun = null;
        resolveStandalone?.();
        this._scheduleNextFollowUpRun(scheduleEpoch);
      }
    }
  }

  async _runContextCompaction(signal: AbortSignal | null | undefined, dynamicContext: DynamicContext | null, toolSchemas: object[], options: CompactionOptions): Promise<CompactionResult> {
    const scheduleEpoch = this._queueScheduleEpoch;
    if (this._compactionPromise) {
      this._trace(`compact wait: run=${this._currentRunId || ""}`);
      await this._compactionPromise.catch(() => null);
    }
    const promise = this._compactContextOnce(signal, dynamicContext, toolSchemas, options);
    this._compactionPromise = promise;
    try {
      return await promise;
    } finally {
      if (this._compactionPromise === promise) {
        this._compactionPromise = null;
        this._compactionState = null;
        this._scheduleNextFollowUpRun(scheduleEpoch);
      }
    }
  }

  async _compactContextOnce(signal: AbortSignal | null | undefined, dynamicContext = this._dynamicContextSnapshot, toolSchemas: object[] = [], options: CompactionOptions = {}): Promise<CompactionResult> {
    const contextEstimate = this._estimateSendWindowContext(dynamicContext, toolSchemas);
    const tokens = contextEstimate.tokens;
    const messageTokens = this.messages.map(msg => this._estimateStoredMessageTokens(msg));
    const force = options.force === true;
    const trigger = String(options.trigger || (force ? "manual" : "threshold"));
    const instruction = String(options.instruction || "").trim();
    const plan = {
      ...buildCompactionPlan({
        messages: this.messages,
        messageTokens,
        inputTokens: tokens,
        contextWindow: this._contextWindow(),
        reserveTokens: RESERVE_TOKENS,
        maxKeepTokens: KEEP_RECENT_TOKENS,
        force,
        retainLatestRound: trigger === "manual" || trigger === "slash_command",
      }),
      trigger,
    };
    this._traceContextEstimate("compact_check", contextEstimate, {
      compactThreshold: plan.threshold,
      contextWindow: this._contextWindow(),
      reserveTokens: RESERVE_TOKENS,
      toolSchemaCount: Array.isArray(toolSchemas) ? toolSchemas.length : 0,
      storedMessageCount: this.messages.length,
      sendMessageCount: contextEstimate.messageCount,
      boundaryId: this._currentContextBoundaryId(),
      compactActive: Boolean(this._compactionPromise),
      compactTrigger: trigger,
      compactInstructionChars: instruction.length,
    });
    this._traceCompactPlan(plan, messageTokens);
    if (!plan.shouldCompact) return { compacted: false, inputTokensEstimate: tokens, contextEstimate, plan };

    const compactId = this._makeSpanId("compact", `${Date.now().toString(36)}_${randomIdPart()}`);
    this._compactionState = {
      compactId,
      status: "running",
      inputTokensBefore: tokens,
      threshold: plan.threshold,
      sourceMessageCount: plan.sourceMessageCount,
      retainedMessageCount: plan.retainedMessageCount,
      trigger,
    };
    this._trace(`compact triggered: trigger=${trigger}, tokens=${tokens}, threshold=${plan.threshold}`);
    this._emit({
      type: "context_compaction_start",
      compactId,
      inputTokensBefore: tokens,
      contextWindow: this._contextWindow(),
      threshold: plan.threshold,
      sourceMessageCount: plan.sourceMessageCount,
      retainedMessageCount: plan.retainedMessageCount,
      trigger,
    });

    const serialized = serializeMessagesForCompaction(plan.sourceMessages, {
      currentGoal: this._formatGoalForCompaction(dynamicContext?.goal),
    });

    let messagesBeforeCommit = null;
    let conversationCommitted = false;

    // Ask the model to summarize.
    try {
      const compactLlmStart = Date.now();
      this._trace(`compact llm start: sourceMsgs=${plan.sourceMessageCount}, serialized=${serialized.length}c, tools=0`);
      const { message: summaryMsg, usage } = await this._modelGateway.chat(
        [
          { role: "system", content: getAgentPrompts(this._runLanguage).COMPACT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `<conversation>\n${serialized}\n</conversation>\n\n${buildCompactUserPrompt(instruction, this._runLanguage)}`,
          },
        ],
        [], // no tools
        signal || undefined,
        {
          ...this._llmOptions(),
          spanId: compactId,
        },
      );

      const summary = typeof summaryMsg.content === "string" && summaryMsg.content ? summaryMsg.content : "[compact failed]";
      this._trace(`compact llm done: ${Date.now() - compactLlmStart}ms, summary=${summary.length}c, usage=${safeTraceJson(usage || summaryMsg._usage || {})}`);
      this._trace(`compact done: ${plan.sourceMessageCount} msgs → ${summary.length} chars, keeping ${plan.retainedMessageCount} msgs`);

      // Preserve full history and insert a compaction boundary before the retained window.
      const compactMessage = createCompactMessage({
        compactId,
        summary,
        plan,
        contextWindow: this._contextWindow(),
        inputTokensBefore: tokens,
      });
      const compactDocuments = normalizeMessageDocuments(
        this.messages.slice(1, plan.cutIndex).flatMap(message => message?.documents || []),
      );
      const documentCapsule = this._buildDocumentCapsuleMessage(compactDocuments, compactId);
      messagesBeforeCommit = this.messages.slice();
      this.messages.splice(plan.cutIndex, 0, compactMessage, ...(documentCapsule ? [documentCapsule] : []));
      const postCompactGoal = this._buildGoalSnapshotCapsuleMessage(dynamicContext, "compact_end");
      if (postCompactGoal) this.messages.push(postCompactGoal);
      const updatedEstimate = this._estimateSendWindowContext(dynamicContext, toolSchemas);
      const updatedTokens = updatedEstimate.tokens;
      const compactMsg = this.messages[plan.cutIndex];
      if (compactMsg?._compact) compactMsg._compact.inputTokensAfter = updatedTokens;
      this._compactionState = {
        ...this._compactionState,
        status: "done",
        inputTokensAfter: updatedTokens,
      };
      await this._persistConversation();
      conversationCommitted = true;
      this._traceContextEstimate("compact_after", updatedEstimate, {
        compactThreshold: this._compactThreshold(),
        contextWindow: this._contextWindow(),
        reserveTokens: RESERVE_TOKENS,
        toolSchemaCount: Array.isArray(toolSchemas) ? toolSchemas.length : 0,
        storedMessageCount: this.messages.length,
        boundaryId: this._currentContextBoundaryId(),
      });

      this._emit({
        type: "context_compaction_end",
        compactId,
        status: "done",
        summary,
        content: compactMsg?.content || "",
        inputTokensBefore: tokens,
        inputTokensAfter: updatedTokens,
        contextWindow: this._contextWindow(),
        threshold: plan.threshold,
        sourceMessageCount: plan.sourceMessageCount,
        retainedMessageCount: plan.retainedMessageCount,
        trigger,
      });
      return { compacted: true, inputTokensEstimate: updatedTokens, contextEstimate: updatedEstimate, plan };
    } catch (err) {
      if (messagesBeforeCommit && !conversationCommitted) this.messages = messagesBeforeCommit;
      this._trace(`compact failed: ${record(err).message}`);
      this._compactionState = {
        ...this._compactionState,
        status: signal?.aborted ? "aborted" : "failed",
        message: record(err).message || "",
      };
      if (!signal?.aborted) {
        this._emit({
          type: "context_compaction_failed",
          compactId,
          status: "failed",
          message: String(record(err).message || t("agent.compactionFailed")),
          inputTokensBefore: tokens,
          contextWindow: this._contextWindow(),
          threshold: plan.threshold,
          sourceMessageCount: plan.sourceMessageCount,
          retainedMessageCount: plan.retainedMessageCount,
          trigger,
        });
      }
      return { compacted: false, failed: true, error: err, inputTokensEstimate: tokens, contextEstimate, plan };
    }
  }

  _buildPreparedSendWindow(dynamicContext: DynamicContext | null = null, toolSchemas: object[] = []) {
    const sendBoundaryId = this._currentContextBoundaryId();
    const sendMessages = this._buildSendMessages(dynamicContext);
    const contextEstimate = this._estimateSendWindowContext(dynamicContext, toolSchemas);
    const sendUsageContextFingerprint = contextEstimate.requestFingerprint;
    return {
      sendBoundaryId,
      sendUsageContextFingerprint,
      sendMessages,
      contextEstimate,
    };
  }

  _isWithinInputBudget(contextEstimate: Partial<ContextEstimate> = {}) {
    const tokens = Math.ceil(Number(contextEstimate.tokens) || 0);
    const threshold = Math.ceil(Number(contextEstimate.threshold) || this._compactThreshold());
    return tokens < threshold;
  }

  async _prepareSendWindowOrBlock(signal: AbortSignal | null | undefined, { dynamicContext = null, toolSchemas = [], phase = "stream" }: {dynamicContext?: DynamicContext | null; toolSchemas?: object[]; phase?: string} = {}) {
    let prepared = this._buildPreparedSendWindow(dynamicContext, toolSchemas);
    if (this._isWithinInputBudget(prepared.contextEstimate)) {
      return { ...prepared, ok: true as const, status: "within_budget", compacted: false, phase };
    }

    const beforeContextEstimate = prepared.contextEstimate;
    const compaction = await this._compactIfNeeded(signal, dynamicContext, toolSchemas);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    prepared = this._buildPreparedSendWindow(dynamicContext, toolSchemas);
    if (this._isWithinInputBudget(prepared.contextEstimate)) {
      return {
        ...prepared,
        ok: true as const,
        status: compaction?.compacted === true ? "compacted_within_budget" : "within_budget",
        compacted: compaction?.compacted === true,
        compaction,
        beforeContextEstimate,
        phase,
      };
    }

    const status = this._contextBudgetBlockStatus(compaction);
    return {
      ...prepared,
      ok: false as const,
      status,
      compacted: compaction?.compacted === true,
      compaction,
      beforeContextEstimate,
      phase,
      message: this._formatContextBudgetBlockedMessage(status, prepared.contextEstimate),
    };
  }

  _contextBudgetBlockStatus(compaction: CompactionResult | null = null) {
    if (compaction?.failed) return "blocked_compact_failed";
    if (compaction?.plan?.reason === "no_compactable_segment") return "blocked_no_compactable_segment";
    if (compaction?.compacted === true) return "blocked_still_over_budget";
    return "blocked_over_budget";
  }

  _formatContextBudgetBlockedMessage(status: string, contextEstimate: Partial<ContextEstimate> = {}) {
    const tokens = Math.ceil(Number(contextEstimate.tokens) || 0);
    const threshold = Math.ceil(Number(contextEstimate.threshold) || this._compactThreshold());
    const reasons: Record<string, string> = {
      blocked_compact_failed: t("agent.compactionFailedShort"),
      blocked_no_compactable_segment: t("agent.noCompactableHistory"),
      blocked_still_over_budget: t("agent.compactionStillOverBudget"),
      blocked_over_budget: t("agent.overBudget"),
    };
    const reason = reasons[status] || t("agent.overBudget");
    return t("agent.contextBudgetExceeded", { reason: String(reason), tokens: String(tokens), threshold: String(threshold) });
  }

  async _persistConversation({ rethrow = false, retryOnce = false, deliveryMessageId = "" } = {}) {
    let lastError = null;
    const attempts = retryOnce ? 2 : 1;
    let conversation = null;
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (deliveryMessageId) traceMessageDelivery(this._trace, {
        phase: "conversation.persist_started",
        session: this.sessionId,
        message: deliveryMessageId,
        attempt: `${attempt}/${attempts}`,
      });
      try {
        conversation ||= serializeConversation(this.messages);
        await this._conversationStore.writeActiveConversation(
          this.sessionId,
          conversation,
          this._conversationLease,
        );
        if (deliveryMessageId) traceMessageDelivery(this._trace, {
          phase: "conversation.persisted",
          session: this.sessionId,
          message: deliveryMessageId,
          attempt: `${attempt}/${attempts}`,
          elapsedMs: Date.now() - startedAt,
        });
        return true;
      } catch (err) {
        lastError = err;
        this._trace(`agent persist failed: session=${this.sessionId}, attempt=${attempt}/${attempts}, ${record(err).message}`);
        if (deliveryMessageId) traceMessageDelivery(this._trace, {
          phase: "conversation.persist_failed",
          session: this.sessionId,
          message: deliveryMessageId,
          attempt: `${attempt}/${attempts}`,
          code: record(err).code || record(err).name || "ERROR",
          error: record(err).message || String(err),
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    if (rethrow) {
      const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
      if (!record(failure).code) Object.assign(failure, { code: "SESSION_PERSIST_FAILED" });
      throw failure;
    }
    return false;
  }

  _assertActiveLease() {
    if (this._hasActiveLease()) return;
    const error = new Error(`session agent lease was revoked: ${this.sessionId}`);
    error.name = "AbortError";
    Object.assign(error, { code: "STALE_AGENT_LEASE" });
    throw error;
  }

  _hasActiveLease() {
    try {
      return this._conversationLease?.isActive?.() === true;
    } catch (_error) {
      return false;
    }
  }

  _assertRunCanStart(signal: AbortSignal | null | undefined) {
    if (signal?.aborted) {
      const error = new Error(`session run was aborted before start: ${this.sessionId}`);
      error.name = "AbortError";
      Object.assign(error, { code: "RUN_ABORTED_BEFORE_START" });
      throw error;
    }
    this._assertActiveLease();
  }

  async _clearPersistedConversation() {
    try {
      await this._conversationStore.clearActiveConversation(this.sessionId, this._conversationLease);
    } catch (err) {
      this._trace(`agent clear persisted failed: session=${this.sessionId}, ${record(err).message}`);
    }
  }

  _lastCompactionIndex() {
    return latestCompactIndex(this.messages);
  }

  _currentContextBoundaryId() {
    const index = this._lastCompactionIndex();
    if (index < 0) return normalizeContextBoundaryId("");
    const compact = this.messages[index]?._compact || {};
    return normalizeContextBoundaryId(compact.compactId || compact.id);
  }

  async _pruneOldToolResultsIfNeeded() {
    if (!this._trimOldToolResultsEnabled()) return false;

    const start = Math.max(1, this._lastCompactionIndex());
    const messages = this.messages.slice(start);
    const toolNames = new Map();
    for (const msg of messages) {
      if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
      for (const toolCall of msg.tool_calls) {
        const id = String(toolCall?.id || "").trim();
        const name = normalizeToolCallName(toolCall);
        if (id && name) toolNames.set(id, name);
      }
    }

    const protectTokens = Math.max(1, Math.floor(this._compactThreshold() * TOOL_RESULT_PROTECT_RATIO));
    const pruneMinimum = Math.max(1, Math.floor(protectTokens * TOOL_RESULT_PRUNE_BATCH_RATIO));
    const toolCandidates = [];
    const imageCandidates = [];
    let recentRounds = 0;
    let toolTokens = 0;
    let reclaimableTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const startsRound = this._startsUserRound(msg);
      if (startsRound) {
        recentRounds++;
        if (recentRounds <= TOOL_RESULT_RECENT_ROUNDS) continue;
      } else if (recentRounds < TOOL_RESULT_RECENT_ROUNDS) {
        continue;
      }
      if (msg?.trim === true) continue;

      if (countMessageImages(msg) > 0) {
        imageCandidates.push(msg);
        continue;
      }
      if (msg?.role !== "tool") continue;
      const toolName = toolNames.get(String(msg.tool_call_id || "")) || "";
      if (this._toolModelPolicy(toolName).preserveResult) continue;

      const tokens = Math.max(0, Math.ceil(this._estimateStoredMessageTokens(msg)));
      if (!tokens) continue;
      toolTokens += tokens;
      if (toolTokens <= protectTokens) continue;
      reclaimableTokens += tokens;
      toolCandidates.push(msg);
    }

    const pruneTools = reclaimableTokens >= pruneMinimum;
    if (!pruneTools && imageCandidates.length === 0) return false;
    if (pruneTools) {
      for (const msg of toolCandidates) msg.trim = true;
    }
    for (const msg of imageCandidates) msg.trim = true;
    await this._persistConversation();
    return true;
  }

  _buildSendMessages(dynamicContext: DynamicContext | null = null) {
    return this._buildSendWindowMessages(dynamicContext, { includeUsage: false });
  }

  _buildContextEstimateMessages(dynamicContext: DynamicContext | null = null) {
    return this._buildSendWindowMessages(dynamicContext, { includeUsage: true });
  }

  /** Apply both policies to model copies; image recency also advances within a single run. */
  _sendWindowPruning(messages: AgentMessage[]) {
    const pruned = new Set<AgentMessage>();
    if (!this._trimOldToolResultsEnabled()) return pruned;
    let imageMessages = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const hasImages = countMessageImages(message) > 0;
      if (hasImages) imageMessages++;
      if (message?.trim === true || (hasImages && imageMessages > IMAGE_MESSAGE_RECENT_LIMIT)) pruned.add(message);
    }
    return pruned;
  }

  _buildSendWindowMessages(dynamicContext: DynamicContext | null = null, { includeUsage = false } = {}) {
    const start = Math.max(1, this._lastCompactionIndex());
    const windowMessages = this.messages.slice(start);
    const boundaryId = this._currentContextBoundaryId();
    const pruned = this._sendWindowPruning(windowMessages);
    const systemMessage = this.messages[0]?.role === "system"
      ? this.messages[0]
      : { role: "system", content: getAgentPrompts(this._runLanguage).SYSTEM_PROMPT };
    const sendMessages: (ModelMessage | null)[] = [systemMessage];

    for (let i = 0; i < windowMessages.length; i++) {
      const msg = windowMessages[i];
      if (!msg || typeof msg !== "object" || typeof msg.role !== "string") continue;
      if (msg.role === "system") continue;
      const trim = pruned.has(msg);
      sendMessages.push(includeUsage ? this._toContextEstimateMessage(msg, trim, boundaryId) : this._toSendMessage(msg, trim));
    }

    return sendMessages.filter((message): message is ModelMessage => message !== null);
  }

  _estimateSendWindowContext(dynamicContext: DynamicContext | null = null, toolSchemas: object[] = []) {
    const estimateMessages = this._buildContextEstimateMessages(dynamicContext);
    const boundaryId = this._currentContextBoundaryId();
    const contextKey = this._usageContextKey();
    const estimate = estimateContextTokens(estimateMessages, { boundaryId, toolSchemas, contextKey });
    const toolSchemaTokens = estimate.source === "usage_anchor" ? 0 : estimateToolSchemaTokens(toolSchemas);
    const messageTokens = Math.max(0, Math.ceil(Number(estimate.tokens) || 0));
    const totalInputTokens = messageTokens + toolSchemaTokens;
    return {
      ...estimate,
      tokens: totalInputTokens,
      messageTokens,
      toolSchemaTokens,
      totalInputTokens,
      threshold: this._compactThreshold(),
      messageCount: estimateMessages.length,
      boundaryId,
    };
  }

  _estimateStoredMessageTokens(msg: ModelMessage) {
    const sendMessage = this._toSendMessage(msg, false);
    return estimateTokens(sendMessage ? [sendMessage] : []);
  }

  _traceContextEstimate(label: string, estimate: Partial<ContextEstimate> = {}, extra: Facts = {}) {
    this._trace(`ctx_estimate ${safeTraceJson({
      label,
      source: estimate.source || "",
      tokens: Math.ceil(Number(estimate.tokens) || 0),
      messageTokens: Math.ceil(Number(estimate.messageTokens) || 0),
      usageAnchorTokens: Math.ceil(Number(estimate.usageTokens) || 0),
      estimatedTrailingTokens: Math.ceil(Number(estimate.trailingTokens) || 0),
      toolSchemaTokens: Math.ceil(Number(estimate.toolSchemaTokens) || 0),
      lastUsageIndex: Number.isFinite(Number(estimate.lastUsageIndex)) ? Number(estimate.lastUsageIndex) : -1,
      messageCount: Math.max(0, Number(estimate.messageCount) || 0),
      boundaryId: estimate.boundaryId || "",
      ...extra,
    })}`);
  }

  _traceCompactPlan(plan: Partial<CompactionPlan> = {}, messageTokens: number[] = []) {
    this._trace(`compact_plan ${safeTraceJson({
      shouldCompact: plan.shouldCompact === true,
      reason: plan.reason || "",
      inputTokens: Math.ceil(Number(plan.inputTokens) || 0),
      threshold: Math.ceil(Number(plan.threshold) || 0),
      boundary: Number.isFinite(Number(plan.boundary)) ? Number(plan.boundary) : -1,
      minIndex: Number.isFinite(Number(plan.minIndex)) ? Number(plan.minIndex) : -1,
      cutIndex: Number.isFinite(Number(plan.cutIndex)) ? Number(plan.cutIndex) : -1,
      keepBudget: Math.ceil(Number(plan.keepBudget) || 0),
      retainedTokens: Math.ceil(Number(plan.retainedTokens) || 0),
      sourceMessageCount: Math.max(0, Number(plan.sourceMessageCount || plan.sourceMessages?.length) || 0),
      retainedMessageCount: Math.max(0, Number(plan.retainedMessageCount || plan.retainedMessages?.length) || 0),
      storedTail: this.messages.slice(-8).map((msg, offset) => {
        const index = this.messages.length - Math.min(this.messages.length, 8) + offset;
        return {
          index,
          role: msg?.role || "",
          origin: msg?._origin || "",
          kind: msg?._kind || "",
          tokens: Math.ceil(Number(messageTokens[index]) || 0),
          hasUsage: Boolean(msg?._usage),
          trim: msg?.trim === true,
        };
      }),
    })}`);
  }

  _traceSendWindow(sendMessages: ModelMessage[], label: string) {
    const entries = sendMessages.slice(1);
    const boundary = this._lastCompactionIndex();
    const storedRounds = this.messages.filter(msg => this._startsUserRound(msg)).length;
    const sentUserMessages = entries.filter(msg => msg.role === "user").length;
    const tail = entries.slice(-12).map((msg, index) => {
      const absoluteIndex = entries.length - Math.min(entries.length, 12) + index + 1;
      const parts = [`#${absoluteIndex}`, msg.role];
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        parts.push(`tools=${msg.tool_calls.map(tc => tc.function?.name || "tool").join(",")}`);
      }
      if (msg.role === "tool") parts.push(`tool_call_id=${msg.tool_call_id}`);
      parts.push(`content=${this._messagePreview(msg.content)}`);
      return parts.join(" ");
    }).join(" | ");
    this._trace(`send window ${label}: total=${sendMessages.length}, stored=${this.messages.length}, compactionBoundary=${boundary}, storedRounds=${storedRounds}, sentUserMessages=${sentUserMessages}, tail=${tail}`);
  }

  _messagePreview(content: unknown) {
    if (typeof content === "string") return JSON.stringify(content.slice(0, 160));
    if (!Array.isArray(content)) return "null";
    return content.map(part => {
      if (part?.type === "text") return `text:${JSON.stringify(String(part.text ?? "").slice(0, 120))}`;
      if (part?.type === "image_url") return "image";
      return String(part?.type || "part");
    }).join("+");
  }

  _startsUserRound(msg: ModelMessage | undefined) {
    return msg?.role === "user" && (!msg._origin || msg._origin === "user");
  }

  _isHiddenContextMessage(msg: ModelMessage | undefined) {
    return isHiddenContextUserMessage(msg);
  }

  _toSendMessage(msg: ModelMessage, trim: boolean) {
    return projectMessage(msg, trim, this._runProfile?.features?.imageInput !== false);
  }

  _toContextEstimateMessage(msg: ModelMessage, trim: boolean, boundaryId = this._currentContextBoundaryId()) {
    const out = this._toSendMessage(msg, trim);
    if (out && msg?.role === "assistant" && this._assistantUsageMatchesBoundary(msg, boundaryId)) {
      out._usage = msg._usage;
      out._usageContextBoundaryId = normalizeContextBoundaryId(msg._usageContextBoundaryId);
      out._usageContextFingerprint = String(msg._usageContextFingerprint || "");
    }
    return out;
  }

  _assistantUsageMatchesBoundary(msg: ModelMessage, boundaryId = this._currentContextBoundaryId()) {
    if (!msg || msg.role !== "assistant" || !msg._usage || typeof msg._usage !== "object") return false;
    return normalizeContextBoundaryId(msg._usageContextBoundaryId) === normalizeContextBoundaryId(boundaryId);
  }

  _usageContextKey() {
    const model = this._runProfile?.model;
    return [model?.provider, this._runtimeConfig?.customProtocol, model?.id, model?.endpoint]
      .map(value => String(value || ""))
      .join("\n");
  }

  _stampAssistantUsageContext(msg: ModelMessage, boundaryId: string, fingerprint: string) {
    if (!msg || msg.role !== "assistant" || !msg._usage || typeof msg._usage !== "object"
      || ["aborted", "error"].includes(String(msg._stopReason || "").toLowerCase())) return msg;
    msg._usageContextBoundaryId = normalizeContextBoundaryId(boundaryId);
    msg._usageContextFingerprint = String(fingerprint || "");
    return msg;
  }

  _buildContextCapsuleMessage(dynamicContext: DynamicContext | null, reason = "prompt") {
    return buildContextCapsuleMessage(dynamicContext, reason);
  }

  _buildDocumentCapsuleMessage(documents: unknown[] = [], clientMessageId = "") {
    return buildDocumentCapsuleMessage(documents, clientMessageId);
  }

  _buildGoalSnapshotCapsuleMessage(dynamicContext: DynamicContext | null = null, reason = "goal_snapshot") {
    return buildGoalSnapshotCapsuleMessage(dynamicContext, reason);
  }

  async _appendGoalSnapshotIfDue(dynamicContext: DynamicContext | null = null, reason = "periodic") {
    if (!shouldExposeGoalContext(dynamicContext?.goal)) return false;
    const lastIndex = this._lastGoalSnapshotIndex();
    const assistantCount = this._assistantMessageCountSince(lastIndex);
    if (lastIndex >= 0 && assistantCount < GOAL_CONTEXT_REFRESH_AFTER_ASSISTANTS) return false;
    const capsule = this._buildGoalSnapshotCapsuleMessage(dynamicContext, reason);
    if (!capsule) return false;
    this.messages.push(capsule);
    await this._persistConversation();
    return true;
  }

  async appendGoalDeletedEvent(goal: GoalDeletedSnapshot | null = null) {
    const message = this._buildGoalDeletedContextEventMessage(goal);
    if (!message) return false;
    this._dropGoalFromDynamicContextSnapshot();
    if (this._activeRun) {
      this._enqueueContextEvent(message);
      return "deferred";
    }
    this.messages.push(message);
    await this._persistConversation();
    return true;
  }

  _enqueueContextEvent(message: AgentMessage | null = null) {
    if (!message || typeof message !== "object") return false;
    this._pendingContextEvents.push(message);
    return true;
  }

  async _flushPendingContextEvents() {
    if (!this._pendingContextEvents.length) return false;
    const events = this._pendingContextEvents.splice(0);
    for (const event of events) {
      this.messages.push(event);
    }
    await this._persistConversation();
    return true;
  }

  _dropGoalFromDynamicContextSnapshot() {
    if (!this._dynamicContextSnapshot || !Object.prototype.hasOwnProperty.call(this._dynamicContextSnapshot, "goal")) return false;
    const { goal: _goal, ...rest } = this._dynamicContextSnapshot;
    this._dynamicContextSnapshot = rest;
    return true;
  }

  _buildGoalDeletedContextEventMessage(goal: GoalDeletedSnapshot | null = null) {
    return buildGoalDeletedContextEventMessage(goal);
  }

  _lastGoalSnapshotIndex() {
    for (let i = this.messages.length - 1; i >= 1; i -= 1) {
      if (isGoalSnapshotCapsuleMessage(this.messages[i])) return i;
    }
    return -1;
  }

  _assistantMessageCountSince(index = -1) {
    const start = Math.max(1, Number(index) + 1 || 1);
    let count = 0;
    for (let i = start; i < this.messages.length; i += 1) {
      if (this.messages[i]?.role === "assistant") count++;
    }
    return count;
  }

  _formatGoalForCompaction(goal: GoalContext | null = null) {
    return formatGoalForCompaction(goal);
  }

  async _refreshDynamicContextSnapshot(seedContext: DynamicContext | null | undefined = null, reason = "prompt") {
    const runId = this._currentRunId;
    const signal = this._abortCtrl?.signal;
    const liveContext = await this._collectDynamicContext();
    signal?.throwIfAborted();
    this._assertActiveLease();
    if (runId !== this._currentRunId) throw new DOMException("Context belongs to a retired run", "AbortError");
    const sourceWindowValue = seedContext?.sourceWindowId ?? this._dynamicContextSnapshot?.sourceWindowId;
    const sourceWindowId = sourceWindowValue === null || sourceWindowValue === undefined || sourceWindowValue === ""
      ? NaN
      : Number(sourceWindowValue);
    const stableSeed = Number.isInteger(sourceWindowId) && sourceWindowId >= 0
      ? { ...(seedContext && typeof seedContext === "object" ? seedContext : {}), sourceWindowId }
      : seedContext;
    const snapshot = this._mergeDynamicContext(stableSeed, liveContext);
    this._dynamicContextSnapshot = snapshot;
    this._dynamicContextSnapshotReason = reason;
    this._dynamicContextSnapshotAt = nowBeijingDateTime();
    return snapshot;
  }

  async _ensureDynamicContextSnapshot(seedContext: DynamicContext | null = null, reason = "lazy") {
    if (this._dynamicContextSnapshot) return this._dynamicContextSnapshot;
    return this._refreshDynamicContextSnapshot(seedContext, reason);
  }

  _clearDynamicContextSnapshot() {
    this._dynamicContextSnapshot = null;
    this._dynamicContextSnapshotReason = "";
    this._dynamicContextSnapshotAt = "";
  }

  _mergeDynamicContext(seedContext: DynamicContext | null | undefined, liveContext: DynamicContext | null): DynamicContext {
    const seed = seedContext && typeof seedContext === "object" ? seedContext : {};
    const live = liveContext && typeof liveContext === "object" ? liveContext : {};
    return normalizeDynamicContext({ ...seed, ...live });
  }

  _formatDynamicContext(context: DynamicContext | null) {
    return formatDynamicContext(context);
  }

  async _collectDynamicContext(): Promise<DynamicContext> {
    return collectDynamicContext(this._dynamicContextProvider, {
      reason: "snapshot", signal: this._abortCtrl?.signal, runId: this._currentRunId || "",
    }, {
      getSecurityGuardrails: () => this._service("getSecurityGuardrails")(),
      matchSiteSkillsForUrls: (urls, options) => this._service("matchSiteSkillsForUrls")(urls, { ...options, language: this._runLanguage }),
      readSelectedText: async tabId => String(await this._browserContext.readSelectedText?.(tabId) || ""),
    });
  }

  _emitContextUsage(extra: Partial<ContextUsageSnapshot> & ContextUsageDetails = {}) {
    const estimate = Number(extra.inputTokensEstimate);
    const hasEstimate = Number.isFinite(estimate) && estimate > 0;
    const contextWindow = this._contextWindow();
    let snapshot = this._lastContextUsageSnapshot;

    if (hasEstimate) {
      snapshot = {
        contextUsageId: this._makeSpanId("ctx", ++this._contextUsageSeq),
        contextWindow,
        reserveTokens: RESERVE_TOKENS,
        threshold: this._compactThreshold(),
        inputTokensEstimate: Math.ceil(estimate),
        messageCount: Math.max(0, Number(extra.messageCount) || 0),
        contextEstimateSource: extra.contextEstimateSource || "",
        usageAnchorTokens: Math.ceil(Number(extra.usageAnchorTokens) || 0),
        estimatedTrailingTokens: Math.ceil(Number(extra.estimatedTrailingTokens) || 0),
        toolSchemaTokens: Math.ceil(Number(extra.toolSchemaTokens) || 0),
        messageTokensEstimate: Math.ceil(Number(extra.messageTokensEstimate) || 0),
        usageAnchorMessageIndex: Number.isFinite(Number(extra.usageAnchorMessageIndex)) ? Number(extra.usageAnchorMessageIndex) : -1,
        contextBoundaryId: extra.contextBoundaryId || "",
      };
      this._lastContextUsageSnapshot = snapshot;
    } else if (!snapshot) {
      return;
    }

    this._emit({
      type: "context_usage",
      sessionId: this.sessionId,
      ...snapshot,
      source: extra.source || (hasEstimate ? "send_window" : "provider_usage"),
      ...extra,
    });
  }

  _emitSendWindowContextUsage(sendMessages: ModelMessage[], extra: ContextUsageDetails & {contextEstimate?: ContextEstimate; dynamicContext?: DynamicContext | null} = {}) {
    const { contextEstimate, dynamicContext, ...eventExtra } = extra;
    const estimate = contextEstimate || this._estimateSendWindowContext(dynamicContext ?? this._dynamicContextSnapshot, extra.toolSchemas || []);
    this._traceContextEstimate("emit_context_usage", estimate, {
      phase: eventExtra.phase || "",
      compacted: eventExtra.compacted === true,
      contextWindow: this._contextWindow(),
      compactThreshold: this._compactThreshold(),
    });
    this._emitContextUsage({
      ...eventExtra,
      source: eventExtra.source || "send_window",
      inputTokensEstimate: estimate.tokens,
      messageCount: estimate.messageCount || sendMessages.length,
      contextEstimateSource: estimate.source,
      usageAnchorTokens: estimate.usageTokens,
      estimatedTrailingTokens: estimate.trailingTokens,
      toolSchemaTokens: estimate.toolSchemaTokens,
      messageTokensEstimate: estimate.messageTokens,
      usageAnchorMessageIndex: estimate.lastUsageIndex,
      contextBoundaryId: estimate.boundaryId,
    });
  }

  _emitProviderContextUsage(usage: unknown) {
    if (!usage || typeof usage !== "object") return;
    this._emitContextUsage({ source: "provider_usage", usage });
  }

  _contextWindow(runProfile = this._runProfile) {
    const configured = Number(runProfile?.model?.contextWindow);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const current = Number(this._runtimeConfig?.contextWindow);
    return Number.isFinite(current) && current > 0 ? current : DEFAULT_CONTEXT_WINDOW;
  }

  _trimOldToolResultsEnabled(runProfile = this._runProfile) {
    return runProfile?.model?.trimOldToolResults !== false;
  }

  _compactThreshold(runProfile = this._runProfile) {
    return compactThreshold(this._contextWindow(runProfile), RESERVE_TOKENS);
  }

  _makeSpanId(kind: string, id: unknown) {
    const runId = this._currentRunId || "run_pending";
    return `${runId}:${safeIdPart(kind, 24)}:${safeIdPart(id, 64)}`;
  }

  _makeToolSpanId(toolCallId: unknown) {
    return this._makeSpanId("tool", toolCallId || "unknown");
  }

  // -- Model requests ----------------------------------------------------------

  async _callLLM(signal: AbortSignal) {
    const runProfile = await this._ensureFreshRunProfile();
    await this._ensureDynamicContextSnapshot(null, "llm");
    await this._refreshSystemPrompt(runProfile);
    return this._attemptLLM(signal, { runProfile });
  }

  async _attemptLLM(signal: AbortSignal, preparation: Preparation, recoveryState: RecoveryState | null = null): Promise<ModelMessage> {
    const recovery = recoveryState && typeof recoveryState === "object"
      ? recoveryState
      : { used: false, contextOverflowUsed: false, disableTransportRetry: false, providerRetryAttempts: 0, llmCallId: "" };
    const { runProfile } = preparation;

    let toolSchemas = preparation.toolSchemas || null;
    let preparedWindow = preparation.window || null;
    let dynamicContext = preparation.dynamicContext || null;
    let transportRetryAttempts = 0;
    const llmCallId = recovery.llmCallId || this._makeSpanId("llm", ++this._llmCallSeq);
    const traceAgentStream = (stage: string, fields: Facts = {}) => {
      const traceId = stream.state.traceId || llmCallId;
      this._trace(`stream_trace stage=${stage} traceId=${traceId} session=${this.sessionId} run=${this._currentRunId || ""} span=${llmCallId}${streamTraceFields(fields)}`);
    };
    const stream = createStreamAttempt({
      callId: llmCallId,
      emit: event => this._emit(event),
      trace: traceAgentStream,
      toolIdentity: name => this._toolRuntime.getIdentity(name, { skillToolRegistrySnapshot: this._skillToolRegistrySnapshot, toolRegistrySnapshot: this._toolRegistrySnapshot, language: this._runLanguage }),
      toolSpanId: id => this._makeToolSpanId(id),
      indexedToolSpanId: index => this._makeSpanId("tool_index", index),
      usage: usage => this._emitProviderContextUsage(usage),
    });
    const emitLlmRetry = (event: AgentRetryDetails, { transport = true } = {}) => {
      if (transport) transportRetryAttempts += 1;
      this._emit({
        ...event,
        type: "llm_retry",
        spanId: llmCallId,
        runId: this._currentRunId,
      });
    };
    const emitLlmRateWait = ({ waitMs = 0, waitedMs = 0, availableAt = 0 } = {}) => {
      this._emit({
        type: "llm_rate_wait",
        spanId: llmCallId,
        runId: this._currentRunId,
        waitMs,
        waitedMs,
        availableAt,
      });
    };
    const llmOptions = ({ disableTransportRetry = recovery.disableTransportRetry === true } = {}) => {
      const base = this._llmOptions();
      return {
        ...base,
        ...(disableTransportRetry ? { retry: { ...(base.retry || {}), maxRetries: 0 } } : {}),
        spanId: llmCallId,
        inputTokensEstimate: preparedWindow?.contextEstimate?.totalInputTokens,
        onRetry: emitLlmRetry,
        onRateWait: emitLlmRateWait,
      };
    };
    const failureResult = (error: unknown) => {
      const failure = normalizeLlmFailure(error);
      const facts = llmFailureFacts(failure);
      const providerMessage = String(failure.providerMessage || failure.message || record(failure.cause).message || "").replace(/\s+/g, " ").trim().slice(0, 600);
      this._trace(`llm_failure ${safeTraceJson({
        ...facts,
        ...(providerMessage ? { message: providerMessage } : {}),
        sessionId: this.sessionId,
        runId: this._currentRunId || "",
        spanId: llmCallId,
      })}`);
      return {
        role: "assistant",
        content: t("agent.modelFailure", { message: String(failure.message) }),
        _stopReason: "error",
        _error: facts,
        _spanId: llmCallId,
        _streamTraceId: stream.state.traceId || llmCallId,
      };
    };

    try {
      const llmStart = Date.now();
      if (!preparedWindow) {
        await this._persistIfToolLedgerRepaired(t("agent.toolInterrupted"));
        dynamicContext = await this._ensureDynamicContextSnapshot(null, "llm");
        await this._appendGoalSnapshotIfDue(dynamicContext, "periodic");
        await this._ensureSkillToolRegistryReady("agent_tool_schemas").catch((err) => {
          this._trace(`Skill tool registry tool schema init failed: ${record(err).message || err}`);
        });
        toolSchemas = this._toolRuntime.getSchemas({
          runProfile,
          dynamicContext,
          skillToolRegistrySnapshot: this._skillToolRegistrySnapshot,
          toolRegistrySnapshot: this._toolRegistrySnapshot,
          language: this._runLanguage,
          loadedPluginSkillNames: this._loadedSkillToolNames,
        });
        preparedWindow = await this._prepareSendWindowOrBlock(signal, { dynamicContext, toolSchemas, phase: "stream" });
        Object.assign(preparation, { window: preparedWindow, dynamicContext, toolSchemas });
      }
      this._emitSendWindowContextUsage(preparedWindow.sendMessages, {
        phase: "stream",
        compacted: preparedWindow.compacted === true,
        contextEstimate: preparedWindow.contextEstimate,
        budgetStatus: preparedWindow.status,
      });
      if (!preparedWindow.ok) {
        return {
          role: "assistant",
          content: preparedWindow.message,
          _stopReason: "error",
          _spanId: llmCallId,
          _streamTraceId: stream.state.traceId || llmCallId,
        };
      }
      const { sendBoundaryId, sendUsageContextFingerprint, sendMessages } = preparedWindow;
      if (!toolSchemas) throw new Error("Prepared model request has no tool schema snapshot");
      this._traceSendWindow(sendMessages, "stream");
      this._trace(`callLLM start, storedMsgs=${this.messages.length}, sendMsgs=${sendMessages.length}, boundary=${sendBoundaryId}, budget=${preparedWindow.status}`);
      traceAgentStream("agent_call_start", {
        storedMsgs: this.messages.length,
        sendMsgs: sendMessages.length,
        tools: toolSchemas.length,
        budget: preparedWindow.status,
      });

      await stream.consume(this._modelGateway.chatStream(sendMessages, toolSchemas, signal, llmOptions()));

      if (stream.state.message) {
        this._stampAssistantUsageContext(stream.state.message, sendBoundaryId, sendUsageContextFingerprint);
        stream.state.message._spanId = llmCallId;
        stream.state.message._streamTraceId = stream.state.traceId || llmCallId;
        return stream.state.message;
      }

      return { role: "assistant", content: stream.state.content || null, _spanId: llmCallId, _streamTraceId: stream.state.traceId || llmCallId };
    } catch (err) {
      // AbortError can indicate caller cancellation or an internal timeout.
      if (signal?.aborted) {
        if (stream.state.content.length > 0) {
          this._trace(`callLLM aborted with partial content, content=${stream.state.content.length}c, thinking=${stream.state.thinking.length}c`);
          return {
            role: "assistant",
            content: stream.state.content,
            _thinking: stream.state.thinking || undefined,
            _stopReason: "aborted",
            _spanId: llmCallId,
            _streamTraceId: stream.state.traceId || llmCallId,
          };
        }
        throw new DOMException("Aborted", "AbortError");
      }
      if (record(err).name === "AbortError") {
        const idle = String(record(err).message || "").includes("idle timeout");
        return {
          role: "assistant",
          content: idle
            ? t("agent.streamTimeout")
            : t("agent.responseTimeout"),
          _stopReason: "error",
          _streamTraceId: stream.state.traceId || llmCallId,
        };
      }

      const failure = normalizeLlmFailure(err, { phase: "stream" });
      const providerRecovery = failure.recovery;
      const previousProviderRetryAttempts = Math.max(0, Number(recovery.providerRetryAttempts) || 0);
      const providerRetryAttempts = previousProviderRetryAttempts + transportRetryAttempts;

      if (
        providerRecovery?.strategy === "capacity"
        && !stream.state.replaySensitive
        && (recovery.used !== true || previousProviderRetryAttempts > 0)
      ) {
        const retry = createLlmRetryPolicy(this._llmOptions());
        if (providerRetryAttempts >= retry.maxRetries) return failureResult(failure);
        const delayMs = retry.delayMs(providerRetryAttempts);
        emitLlmRetry({
          attempt: providerRetryAttempts + 1,
          maxRetries: retry.maxRetries,
          reason: providerRecovery.reason,
          message: providerRecovery.message,
          delayMs,
        }, { transport: false });
        await waitForAbortableDelay(delayMs, signal);
        return this._attemptLLM(signal, preparation, {
          ...recovery,
          used: true,
          disableTransportRetry: true,
          providerRetryAttempts: providerRetryAttempts + 1,
          llmCallId,
        });
      }

      // Semantic recovery belongs to the same model call. Roll back provisional text
      // from the failed stream before inserting the replacement response.
      if (stream.state.content) {
        stream.state.content = "";
        this._emit({
          type: "message_update",
          spanId: llmCallId,
          streamTraceId: stream.state.traceId || llmCallId,
          delta: "",
          content: "",
        });
      }

      if (providerRecovery?.strategy === "same_protocol") {
        const delayMs = Math.max(0, Math.min(30000, Number(providerRecovery.delayMs) || 0));
        if (recovery.used === true) return failureResult(failure);
        this._emit({
          type: "llm_retry",
          spanId: llmCallId,
          runId: this._currentRunId,
          attempt: 2,
          maxAttempts: 2,
          reason: providerRecovery.reason,
          message: providerRecovery.message,
          delayMs,
        });
        await waitForAbortableDelay(delayMs, signal);
        return this._attemptLLM(signal, preparation, {
          used: true,
          disableTransportRetry: true,
          llmCallId,
        });
      }

      if (failure.kind === "context_overflow") {
        if (recovery.used === true || recovery.contextOverflowUsed === true) {
          return failureResult(failure);
        }
        const compaction = await this.compactContext(signal, {
          dynamicContext,
          toolSchemas: toolSchemas || [],
          trigger: "provider_context_overflow",
        });
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (compaction?.compacted !== true) return failureResult(failure);
        preparation.window = null;
        this._emit({
          type: "llm_retry",
          spanId: llmCallId,
          runId: this._currentRunId,
          attempt: 2,
          maxAttempts: 2,
          reason: "context_overflow",
          message: t("agent.compactedRetry"),
        });
        return this._attemptLLM(signal, preparation, {
          used: true,
          contextOverflowUsed: true,
          disableTransportRetry: true,
          llmCallId,
        });
      }

      const canFallback = recovery.used !== true
        && (failure.kind === "stream_protocol" || (failure.kind === "transient" && stream.state.yields > 0));
      if (!canFallback) return failureResult(failure);
      this._emit({
        type: "llm_retry",
        spanId: llmCallId,
        runId: this._currentRunId,
        attempt: 2,
        maxAttempts: 2,
        reason: failure.kind,
        message: t("agent.streamRetry"),
      });

      // Fall back to a non-streaming request after a stream failure.
      try {
        dynamicContext = await this._ensureDynamicContextSnapshot(null, "llm_fallback");
        await this._ensureSkillToolRegistryReady("agent_fallback_tool_schemas").catch((registryErr) => {
          this._trace(`Skill tool registry fallback tool schema init failed: ${record(registryErr).message || registryErr}`);
        });
        if (!toolSchemas) {
          toolSchemas = this._toolRuntime.getSchemas({
            runProfile,
            dynamicContext,
            skillToolRegistrySnapshot: this._skillToolRegistrySnapshot,
            toolRegistrySnapshot: this._toolRegistrySnapshot,
            language: this._runLanguage,
            loadedPluginSkillNames: this._loadedSkillToolNames,
          });
        }
        if (!preparedWindow) {
          preparedWindow = await this._prepareSendWindowOrBlock(signal, { dynamicContext, toolSchemas, phase: "fallback" });
        }
        this._emitSendWindowContextUsage(preparedWindow.sendMessages, {
          phase: "fallback",
          compacted: preparedWindow.compacted === true,
          contextEstimate: preparedWindow.contextEstimate,
          budgetStatus: preparedWindow.status,
        });
        if (!preparedWindow.ok) {
          return {
            role: "assistant",
            content: preparedWindow.message,
            _stopReason: "error",
            _spanId: llmCallId,
            _streamTraceId: stream.state.traceId || llmCallId,
          };
        }
        const { sendBoundaryId, sendUsageContextFingerprint, sendMessages } = preparedWindow;
        this._traceSendWindow(sendMessages, "fallback");
        const { message, usage } = await this._modelGateway.chat(
          sendMessages,
          toolSchemas,
          signal,
          llmOptions({ disableTransportRetry: true }),
        );
        const alignedMessage = alignFallbackToolCallIds(message, stream.state.tools, this._trace);
        alignedMessage._spanId = llmCallId;
        alignedMessage._streamTraceId = stream.state.traceId || llmCallId;
        if (usage && !alignedMessage._usage) alignedMessage._usage = usage;
        this._stampAssistantUsageContext(alignedMessage, sendBoundaryId, sendUsageContextFingerprint);
        this._emitProviderContextUsage(usage);
        if (alignedMessage.content) {
          stream.start();
          this._emit({ type: "message_update", spanId: llmCallId, streamTraceId: stream.state.traceId || llmCallId, delta: alignedMessage.content, content: alignedMessage.content });
        }
        return alignedMessage;
      } catch (err2) {
        if (signal?.aborted) {
          if (stream.state.content.length > 0) {
            this._trace(`callLLM fallback aborted with partial stream content, content=${stream.state.content.length}c`);
            return {
              role: "assistant",
              content: stream.state.content,
              _thinking: stream.state.thinking || undefined,
              _stopReason: "aborted",
              _spanId: llmCallId,
              _streamTraceId: stream.state.traceId || llmCallId,
            };
          }
          throw new DOMException("Aborted", "AbortError");
        }
        const finalFailure = normalizeLlmFailure(err2, { phase: "fallback" });
        this._trace(`llm_recovery_failed ${safeTraceJson({
          initial: llmFailureFacts(failure),
          final: llmFailureFacts(finalFailure),
          sessionId: this.sessionId,
          runId: this._currentRunId || "",
          spanId: llmCallId,
        })}`);
        return failureResult(finalFailure);
      }
    }
  }

  _llmOptions(): ModelOptions {
    return {
      sessionId: this.sessionId,
      runId: this._currentRunId || "",
      maxTokens: this._runProfile?.model?.maxOutputTokens,
      config: this._runtimeConfig || null,
    };
  }

  async _callLLMWithEmptyRetry(signal: AbortSignal) {
    for (let attempt = 1; attempt <= MAX_EMPTY_LLM_ATTEMPTS; attempt += 1) {
      const message = await this._callLLM(signal);
      if (!isEmptyAssistantResponse(message)) return message;
      if (attempt < MAX_EMPTY_LLM_ATTEMPTS) {
        this._emit({
          type: "llm_retry",
          spanId: typeof message?._spanId === "string" ? message._spanId : undefined,
          runId: this._currentRunId,
          attempt,
          maxAttempts: MAX_EMPTY_LLM_ATTEMPTS,
          reason: "empty_response",
          message: t("agent.emptyRetry"),
        });
        continue;
      }
      const error = new Error(t("agent.emptyRepeated"));
      Object.assign(error, { code: "EMPTY_LLM_RESPONSE" });
      Object.assign(error, { details: { attempts: MAX_EMPTY_LLM_ATTEMPTS } });
      throw error;
    }
    throw new Error("unreachable empty response retry state");
  }

  // -- Tool execution: prepare, execute, finalize -------------------------------
  //
  // A tool result with { _image: "data:image/..." } becomes a multimodal result
  // so the model can inspect the screenshot.

  async _executeToolCalls(toolCalls: ModelToolCall[], signal: AbortSignal) {
    const toolMessages = [];
    const followUpMessages = [];

    for (const tc of toolCalls) {
      if (signal.aborted) break;

      const { id } = tc;
      const toolName = normalizeToolCallName(tc);
      let args = parseToolCallArguments(getToolCallArgumentsValue(tc));
      args = this._normalizeToolCallArgs(toolName, args);
      const toolRuntimeContext = await this._collectToolRuntimeContext();
      args = await this._enrichToolCallArgsWithPageContext(toolName, args, toolRuntimeContext);
      const toolIdentity = this._toolRuntime.getIdentity(toolName, {
        skillToolRegistrySnapshot: this._skillToolRegistrySnapshot,
        toolRegistrySnapshot: this._toolRegistrySnapshot,
        language: this._runLanguage,
      });

      this._emit({
        type: "tool_execution_start",
        spanId: this._makeToolSpanId(id),
        toolCallId: id,
        toolName,
        ...toolIdentityEventFields(toolIdentity),
        args,
      });

      let result;
      let isError = false;
      try {
        result = await this._toolRuntime.execute(toolName, args, signal, {
          sessionId: this.sessionId,
          runId: this._currentRunId,
          spanId: this._makeToolSpanId(id),
          toolCallId: id,
          workingTabId: toolRuntimeContext.workingTabId || null,
          workingTab: toolRuntimeContext.workingTab || null,
          sourceWindowId: this._dynamicContextSnapshot?.sourceWindowId ?? null,
          dynamicContext: this._dynamicContextSnapshot,
          loadedPluginSkillNames: this._loadedSkillToolNames,
          runProfile: this._runProfile,
          skillToolRegistrySnapshot: this._skillToolRegistrySnapshot,
          toolRegistrySnapshot: this._toolRegistrySnapshot,
          language: this._runLanguage,
        });
        if (result && typeof result === "object" && record(result).error) {
          isError = true;
        }
        followUpMessages.push(...await this._applyToolResultEffects(toolName, result, isError));
      } catch (err) {
        const details = record(record(err).details);
        const code = record(err).code || "TOOL_EXECUTION_FAILED";
        result = {
          error: record(err).message,
          code,
          ...(record(err).codeLabel ? { codeLabel: record(err).codeLabel } : {}),
          details,
          ...(details._tabId != null ? { _tabId: details._tabId } : {}),
          ...(details._pageTitle ? { _pageTitle: details._pageTitle } : {}),
          ...(details._pageUrl ? { _pageUrl: details._pageUrl } : {}),
        };
        isError = true;
      }

      this._emit({
        type: "tool_execution_end",
        spanId: this._makeToolSpanId(id),
        toolCallId: id,
        toolName,
        ...toolIdentityEventFields(toolIdentity),
        args,
        result,
        isError,
      });

      // Build tool result messages.
      // An _image produces a text tool result and a user message containing the image.
      const toolMsgs = this._buildToolResultMessages(id, result, isError, toolName);
      for (const msg of toolMsgs) {
        if (msg?.role === "tool") toolMessages.push(msg);
        else followUpMessages.push(msg);
      }
    }

    return [...toolMessages, ...followUpMessages];
  }

  async _applyToolResultEffects(toolName: string, result: unknown, isError: boolean) {
    const messages = [];
    if (!isError) {
      const effects = this._toolRuntime.consumeEffects?.(result, { sessionId: this.sessionId, runId: this._currentRunId }) || [];
      for (const effect of effects) {
        if (effect.type === "skill.loaded") {
          const name = effect.name.trim().toLowerCase();
          if (!name) continue;
          this._loadedSkillToolNames.add(name);
          if (effect.displayName) this._loadedSkillToolNames.add(effect.displayName.trim().toLowerCase());
          this._emit({
            type: "skill_loaded", name, displayName: effect.displayName,
            hasPluginManifest: effect.hasPluginManifest,
            loadedPluginSkillNames: [...this._loadedSkillToolNames],
          });
          this._trace(`Skill activated: session=${this.sessionId} skill=${name} manifest=${effect.hasPluginManifest ? 1 : 0}`);
        } else if (effect.type === "skills.changed") {
          const beforeVersion = this._skillToolRegistrySnapshot?.version || 0;
          this._skillToolRegistrySnapshot = this._service("getSkillToolRegistrySnapshot")(this._runLanguage);
          this._trace(`Skill tool registry adopted: session=${this.sessionId} registry=${beforeVersion}->${this._skillToolRegistrySnapshot?.version || 0}`);
        }
      }
      if (effects.some(effect => effect.type === "context.siteChanged")) {
        const event = await this._maybeRefreshDynamicContextForSiteSkills(toolName);
        if (event) messages.push(event);
      }
      for (const effect of effects) {
        if (effect.type !== "context.goalRefresh") continue;
        const context = await this._refreshDynamicContextSnapshot(null, `goal_context:${toolName}`);
        if (effect.action.trim() !== "get") {
          const snapshot = this._buildGoalSnapshotCapsuleMessage(context, `${toolName}:${effect.action}`);
          if (snapshot) messages.push(snapshot);
        }
      }
    }
    return messages;
  }

  _toolModelPolicy(toolName: string): Readonly<ToolModelPolicy> {
    return this._toolRuntime.getModelPolicy?.(toolName, { skillToolRegistrySnapshot: this._skillToolRegistrySnapshot, toolRegistrySnapshot: this._toolRegistrySnapshot, language: this._runLanguage }) || {};
  }

  _normalizeToolCallArgs(toolName: string, args: unknown) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const input = { ...record(args) };
    for (const key of this._toolModelPolicy(toolName).omitArguments || []) delete input[key];
    return input;
  }

  async _maybeRefreshDynamicContextForSiteSkills(toolName: string) {
    if (!this._dynamicContextSnapshot) return null;
    const previousSkills = Array.isArray(this._dynamicContextSnapshot.siteSkills)
      ? this._dynamicContextSnapshot.siteSkills
      : [];
    const previousSignature = siteSkillSignature(previousSkills);
    const previewContext = await this._collectSiteSkillPreviewContext();
    if (!previewContext) return null;
    const urls = collectSiteSkillCandidateUrls(previewContext);
    const nextSkills = urls.length ? await this._service("matchSiteSkillsForUrls")(urls, { limit: 5, language: this._runLanguage }) : [];
    const nextSignature = siteSkillSignature(nextSkills);
    if (nextSignature === previousSignature) return null;
    const snapshot = await this._refreshDynamicContextSnapshot(null, `site_skill_context:${toolName}`);
    this._trace(`dynamic context refreshed for site skills: session=${this.sessionId} tool=${toolName} before=${previousSignature || "-"} after=${nextSignature || "-"}`);
    return this._buildSiteSkillContextEventMessage(previousSkills, snapshot.siteSkills || nextSkills, toolName);
  }

  _buildSiteSkillContextEventMessage(previousSkills: SiteSkill[] = [], nextSkills: SiteSkill[] = [], toolName = "") {
    return buildSiteSkillContextEventMessage(previousSkills, nextSkills, toolName);
  }

  async _collectSiteSkillPreviewContext(): Promise<DynamicContext | null> {
    return collectSiteSkillPreviewContext(this._dynamicContextProvider, {
      reason: "site-skills", signal: this._abortCtrl?.signal, runId: this._currentRunId || "",
    });
  }

  async _collectToolRuntimeContext() {
    return collectToolRuntimeContext(this._dynamicContextProvider, {
      reason: "tool", signal: this._abortCtrl?.signal, runId: this._currentRunId || "",
    }, this._dynamicContextSnapshot?.workingTab || null);
  }

  async _enrichToolCallArgsWithPageContext(toolName: string, args: unknown = {}, toolRuntimeContext: Awaited<ReturnType<Agent["_collectToolRuntimeContext"]>> | null = null) {
    const policy = this._toolModelPolicy(toolName);
    if (!policy.pageContext) return args;
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const input = { ...record(args) };
    const working = toolRuntimeContext?.workingTab || this._dynamicContextSnapshot?.workingTab || null;
    const explicitTabId = Number(input.tabId);
    const workingTabId = Number(toolRuntimeContext?.workingTabId || working?.id);
    const tabId = Number.isFinite(explicitTabId) && explicitTabId > 0
      ? explicitTabId
      : (Number.isFinite(workingTabId) && workingTabId > 0 && policy.pageContext !== "explicit" ? workingTabId : null);

    if (tabId) {
      input.tabId = tabId;
      input._tabId = input._tabId ?? tabId;
      try {
        const tab = await this._browserContext.getTab?.(tabId);
        const formattedTab = tab ? formatTab(tab, { titleLimit: 120 }) : { title: "", url: "" };
        if (formattedTab.title && !input._pageTitle) input._pageTitle = formattedTab.title;
        const tabUrl = formattedTab.url;
        if (!input._pageUrl) input._pageUrl = tabUrl;
      } catch (_err) {
        if (Number(working?.id) === tabId) {
          if (working?.title && !input._pageTitle) input._pageTitle = working.title;
          if (working?.url && !input._pageUrl) input._pageUrl = working.url;
        }
      }
    } else if (policy.pageUrlArgument && input[policy.pageUrlArgument] && !input._pageUrl) {
      input._pageUrl = input[policy.pageUrlArgument];
    }

    return input;
  }

  /**
   * Build one or two tool result messages. OpenAI tool messages require text content;
   * send an image in an additional user message.
   */
  _buildToolResultMessages(toolCallId: string, result: unknown, isError: boolean, toolName = "") {
    const messages = [];
    const policy = this._toolModelPolicy(toolName);

    if (!isError && result && record(result)._image) {
      const imageDataUrl = record(result)._image;
      const { _image, _imageDetail, ...rest } = record(result);
      const sanitizedRest = sanitizeToolResultForLLM(rest, policy);
      const textPart = Object.keys(record(sanitizedRest)).length > 0 ? JSON.stringify(sanitizedRest) : promptT("imageReceived");
      const allowImages = this._runProfile?.features?.imageInput !== false;
      const imageDetail = ["low", "auto", "high"].includes(String(_imageDetail || "").toLowerCase())
        ? String(_imageDetail).toLowerCase()
        : "low";

      // 1. tool result (text only)
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: allowImages
          ? textPart
          : `${textPart}\n${IMAGE_PLACEHOLDER} ${promptT("imageUnavailable")}`,
      });
      if (!allowImages) return messages;

      // 2. User message containing the screenshot
      messages.push({
        role: "user",
        _origin: "tool_image",
        content: [
          {
            type: "text",
            text: policy.imagePrompt || promptT("toolImage"),
          },
          { type: "image_url", image_url: { url: imageDataUrl, detail: imageDetail } },
        ],
      });
    } else {
      const sanitized = sanitizeToolResultForLLM(result, policy);
      messages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized),
      });
    }

    return messages;
  }
}

function countMessageImages(message: ModelMessage | undefined): number {
  if (message?.role !== "user" || !Array.isArray(message.content)) return 0;
  return message.content.reduce((count: number, part) => count + (part?.type === "image_url" ? 1 : 0), 0);
}

function isEmptyAssistantResponse(message: Partial<ModelMessage> = {}) {
  if (!message || typeof message !== "object") return true;
  if (["error", "aborted"].includes(String(message._stopReason || ""))) return false;
  const hasText = typeof message.content === "string"
    ? Boolean(message.content.trim())
    : Array.isArray(message.content) && message.content.length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return !hasText && !hasTools;
}


function alignFallbackToolCallIds(message: ModelMessage, streamedToolCalls: Map<number, StreamedTool>, trace: (message: string) => void) {
  if (!message || !Array.isArray(message.tool_calls) || streamedToolCalls.size === 0) {
    return message;
  }

  let changed = false;
  const toolCalls = message.tool_calls.map((toolCall, index) => {
    const streamed = findMatchingStreamedToolCall(streamedToolCalls, toolCall, index);
    if (!streamed?.id || streamed.id === toolCall?.id) return toolCall;
    changed = true;
    return { ...toolCall, id: streamed.id };
  });
  if (!changed) return message;

  trace(`aligned fallback tool call ids: ${toolCalls.map(tc => tc.id).join(",")}`);
  return { ...message, tool_calls: toolCalls };
}

function findMatchingStreamedToolCall(streamedToolCalls: Map<number, StreamedTool>, toolCall: ModelToolCall, index: number) {
  const name = String(toolCall?.function?.name || "");
  const byIndex = streamedToolCalls.get(index);
  if (byIndex?.id) return byIndex;
  for (const item of streamedToolCalls.values()) {
    if (item?.id && item.name && item.name === name) return item;
  }
  return null;
}

function record(value: unknown): Facts {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Facts : {};
}

function requiredDependency<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Agent host dependency is missing: ${name}`);
  return value;
}

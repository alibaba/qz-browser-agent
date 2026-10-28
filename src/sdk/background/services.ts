import type { SettingsConfig, ProviderSummary } from "../../shared/contracts/settings.js";
import type { ModelMessage } from "../../shared/contracts/model-message.js";
import type { ProviderModelOptionEntry } from "../../background/llm/provider-types.js";
import type { SkillRecord, SkillResource } from "../../shared/skills/skill-utils.js";
import type { SkillSetting as ToolSkillSetting } from "../../shared/contracts/settings.js";
import type { TabReference } from '../../shared/tab-utils.js';
import type { ToolContext } from '../background.js';
import type { Automation } from '../../shared/automation-store.js';
import type { SessionGoal } from '../../shared/contracts/session-runtime.js';

export type UserWaitTarget = { sessionId: string; waitId: string };

export interface UserWaitRuntime {
  beginUserWait(sessionId: string, options: { waitId: string; runId: string; signal?: AbortSignal; onSettled(reason: string): void }): Promise<unknown>;
  resolveUserWait(input: UserWaitTarget & { payload?: unknown }): unknown;
  rejectUserWait(input: UserWaitTarget): unknown;
  isWaitingForUser(sessionId: string): boolean;
}

export interface ToolEvent { type: string; sessionId?: string; [field: string]: unknown }
export interface TargetTabResult {
  ok: boolean;
  tabId?: number | null;
  tab?: TabReference;
  code?: string;
  reason?: string;
  error?: string;
  ownerSessionId?: string;
  ownedByCurrentTask?: boolean;
  claimRequired?: boolean;
  readOnlyAccess?: boolean;
}

/** Editable schedule fields; legacy date spellings retain the host's existing normalization. */
export type AutomationScheduleInput = {
  type?: 'once' | 'hourly' | 'daily' | 'weekly';
  runAt?: string; time?: string; weekday?: number; intervalMinutes?: number; intervalHours?: number;
  date?: string; datetime?: string; dateTime?: string;
};
/** Existing definitions accept partial edits; new definitions require their task content. */
export type AutomationSaveInput = {
  id?: string; title?: string; instruction?: string; enabled?: boolean;
  schedule?: AutomationScheduleInput;
  missedPolicy?: Automation['missedPolicy'];
  notifyPolicy?: Automation['notifyPolicy'];
} & ({ id: string } | { title: string; instruction: string });

/** Goal content is caller-owned; identity, run authority and persistence remain with the host. */
export type GoalUpdateInput = Partial<Pick<SessionGoal, 'objective' | 'criteria' | 'progress' | 'next' | 'checkpoint'>> & {
  sessionId: string; runId: string; signal?: AbortSignal;
  action: 'create' | 'checkpoint' | 'update' | 'block' | 'complete' | 'pause' | 'resume' | 'clear' | 'get';
};

/** Finite caller-owned port. Session commands retain all persistence and run authority. */
export interface ToolSessionCommands extends UserWaitRuntime {
  isRunCurrent(sessionId: string, runId: string): boolean;
  listSessions(input: { limit: number; excludeSessionId: string }): Promise<unknown>;
  createSession(input: { title: string; firstMessage: string; parentSessionId: string }): Promise<object>;
  stopSession(id: string, input: { source: string; requestedBy: string }): Promise<unknown>;
  sendMessage(input: { sessionId: string; text: string; deliveryMode: 'follow_up' | 'steer'; clientMessageId: string; swallowErrors: boolean }): Promise<unknown>;
  deleteSession(id: string, input: { source: string; requestedBy: string }): Promise<unknown>;
  getLastMessages(input: { sessionId: string; num: number }): Promise<unknown>;
  waitSessions(input: { sessionIds: string[]; waitFor: 'any' | 'all'; timeoutMs: number; num: number; excludeSessionId: string; signal?: AbortSignal }): Promise<unknown>;
  listAutomations(input: { limit: number; runLimit: number }): Promise<unknown>;
  saveAutomation(input: { automation: AutomationSaveInput; sourceSessionId: string }): Promise<object>;
  deleteAutomation(id: string): Promise<unknown>;
  runAutomation(id: string): Promise<unknown>;
  listAutomationRuns(input: { automationId: string; limit: number }): Promise<unknown>;
  updateGoal(input: GoalUpdateInput): Promise<unknown>;
  resolveTargetTab(input: { sessionId: string; runId?: string | null; signal?: AbortSignal; tabId: number; source: string; checkOnly?: boolean; readOnly?: boolean; tabOnly?: boolean; allowPreNavigationBlank?: boolean; createdTabReservation?: object }): Promise<TargetTabResult>;
  listOwnedTabIds?(sessionId: string): readonly number[];
  /** Execution-only permit: no Session ownership or working-tab publication until commit. */
  reserveCreatedTab?(input: { sessionId: string; runId?: string | null; signal?: AbortSignal; tab: TabReference }): Promise<{ ok: boolean; code?: string; reservation?: object }>;
  commitCreatedTab?(input: { sessionId: string; runId?: string | null; signal?: AbortSignal; reservation: object }): Promise<{ ok: boolean; code?: string }>;
  discardCreatedTab?(reservation: object): Promise<void>;
  updateWorkingTab(input: { sessionId: string; runId?: string | null; signal?: AbortSignal; tab: TabReference; source: string; toolName: string; action?: string; createdTab?: boolean; claim?: boolean }): Promise<unknown>;
  clearWorkingTab(input: { sessionId: string; tabId?: number; source?: string; runId?: string | null; signal?: AbortSignal }): Promise<unknown>;
  canManageSessions(sessionId: string): Promise<boolean>;
}
export type { SkillSetting as ToolSkillSetting } from "../../shared/contracts/settings.js";
export interface ToolGitPublishTarget extends Record<string, unknown> { available: boolean; reason?: string }
export interface ToolSkillsRuntime {
  refreshRegistry?(reason: string, details: Record<string, unknown>): Promise<unknown>;
  loadDocumentResource?(input: { skill: SkillRecord; resource: SkillResource; path: string; displayName: string }, runtime: { signal?: AbortSignal; context: ToolContext }): Promise<unknown>;
  importPageZip?(input: { url: string; tabId: number; overwrite?: boolean }, runtime: { signal?: AbortSignal; context: ToolContext }): Promise<unknown>;
  bindGitSource?(input: { repositoryUrl: string; tabId: number; overwrite?: boolean }, runtime: { signal?: AbortSignal; context: ToolContext }): Promise<unknown>;
  inspectGitPublishTarget?(input: { tabId: number; waitForReady: boolean }, runtime: { signal?: AbortSignal; context: ToolContext }): Promise<ToolGitPublishTarget>;
  publishToGit?(input: { skill: SkillRecord; target: ToolGitPublishTarget; commitMessage: string }, runtime: { signal?: AbortSignal; context: ToolContext }): Promise<unknown>;
}
export interface ToolRuntimeDependencies {
  requestLocation?(context: ToolContext, signal?: AbortSignal): Promise<Record<string, unknown>>;
  skills?: ToolSkillsRuntime | null;
  skillNetwork?: { registerExecution(requestId: unknown, descriptor?: { plugin?: { id?: string; skillName?: string; network?: { allowedMethods?: readonly string[]; allowedOrigins?: readonly { setting?: string; origin?: string }[]; browserManagedHeaders?: readonly string[]; maxRequestBytes?: number; maxResponseBytes?: number } }; config?: Record<string, unknown>; signal?: AbortSignal | null }): () => void } | null;
  skillSettings?: {
    list(): Promise<{ settings: ToolSkillSetting[] }>;
    getExecutionConfig?(plugin: import("../../shared/skills/skill-manifest.js").SkillManifest, options: { includeSecrets: boolean }): Promise<Record<string, unknown>>;
    save?(input: { pluginId: string; skillName: string; values: Record<string, unknown> }): Promise<{ setting: ToolSkillSetting }>;
  } | null;
  sessions?: Partial<ToolSessionCommands> | null;
  windowTarget?: { resolveForNewTab(input: { anchorTabId?: number | null; sourceWindowId?: number | null }): Promise<number> } | null;
  emit?: ((event: ToolEvent) => void) | null;
}
export type GetToolRuntimeDependencies = (context: ToolContext) => ToolRuntimeDependencies;

/** Request identity only; provider configuration and transport policy belong to the host. */
export interface ModelRequestOptions {
  readonly sessionId?: string;
  readonly runId?: string;
}

/** Mutations honor cancellation before committing, then sync the host's runtime snapshot. */
export interface ModelService {
  getConfig(): Promise<SettingsConfig>;
  saveConfig(input: Record<string, unknown>, signal?: AbortSignal): Promise<SettingsConfig>;
  applyPreset(id: unknown, signal?: AbortSignal): Promise<SettingsConfig>;
  deletePreset(id: unknown, signal?: AbortSignal): Promise<SettingsConfig>;
  listModels(input?: Record<string, unknown>): Promise<{ provider: string; providerLabel: string; models: ProviderModelOptionEntry[] }>;
  listProviders(): readonly ProviderSummary[];
  chat(messages: ModelMessage[], tools: object[], signal?: AbortSignal, options?: ModelRequestOptions): Promise<{ message: ModelMessage; usage?: Record<string, unknown> }>;
}
/** Package storage mutations remain serialized by the host repository. */
export interface SkillService {
  list(language?: string): Promise<SkillRecord[]>;
  load(name?: string, language?: string): Promise<SkillRecord | null>;
  save(name: string | undefined, description: string, content: string, metadata?: Record<string, unknown>): Promise<SkillRecord>;
  update(name?: string, patch?: Record<string, unknown>): Promise<{ skill: SkillRecord; changes: Record<string, unknown>[]; diagnostics: Record<string, unknown>[]; updated: boolean } | null>;
  delete(name?: string): Promise<boolean>;
  loadScript(name: string, path: string, language?: string): Promise<string | null>;
  loadResource(name: string, path: string, language?: string): Promise<{ skill: SkillRecord; resource: SkillResource | null; path: string } | null>;
}

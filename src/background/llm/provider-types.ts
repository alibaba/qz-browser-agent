import type { ProviderAuthStatus, ProviderDeviceLogin, ProviderLoginPoll, ProviderAuthPresentation, ProviderGroup, ProviderModelOption } from '../../shared/contracts/settings.js';
import type { RuntimeConfig } from "../../sdk/background/providers.js";
import type { ProviderRecovery } from './provider-recovery.js';

export interface ProviderAuth extends ProviderAuthPresentation {
  /** Existing wire status fields can be projected during migration without UI branches. */
  legacyStatusKey?: string;
  status(signal?: AbortSignal): Promise<ProviderAuthStatus>;
  start(signal?: AbortSignal): Promise<ProviderDeviceLogin>;
  poll(loginId: string, signal?: AbortSignal): Promise<ProviderLoginPoll>;
  clear(): Promise<ProviderAuthStatus>;
}
export interface ProviderModelOptionEntry { contextWindow?: number; maxOutputTokens?: number; vision?: boolean; id: string; label: string; ownedBy: string; priority: number | null; releaseDate: string }
export interface ProviderModelDiscovery {
  provider: string; definition: ProviderDefinition; apiKey: string; signal?: AbortSignal;
  normalize(input: unknown): ProviderModelOptionEntry[];
  read(endpoint: string, headers: Record<string, string>): Promise<{ response: Response; text: string }>;
}

export interface ProviderDefinition {
  label: string;
  group?: ProviderGroup;
  auth?: ProviderAuth;
  modelOptions?: readonly ProviderModelOption[];
  resolveEndpoint?(definition: Partial<ProviderDefinition>): string;
  listModels?(context: ProviderModelDiscovery): Promise<unknown>;
  compareModels?(a: ProviderModelOptionEntry, b: ProviderModelOptionEntry, definition: Partial<ProviderDefinition>): number;
  api: string;
  protocol: string;
  endpoint?: string;
  /** Hide the settings preview without changing request routing or saved configuration. */
  hideEndpoint?: boolean;
  /** Default editable API URL, stored in customEndpoint with a fixed protocol. */
  editableEndpoint?: string;
  /** Model discovery returns authoritative capability metadata. */
  modelsIncludeCapabilities?: boolean;
  baseUrl?: string;
  modelsEndpoint?: string;
  staticModelCount?: number;
  staticModels?: (string | { id: string; label?: string; ownedBy?: string; priority?: number })[];
  defaultContextWindow?: number;
  requestDefaults?: Record<string, unknown>;
  /** Static service headers; authentication remains owned by the protocol adapter. */
  requestHeaders?: Readonly<Record<string, string>>;
  anthropicRequestDefaults?: Record<string, unknown>;
  /** A named routing header uses the conversation identity. `true` retains legacy Fireworks affinity. */
  sessionAffinityHeader?: boolean | string;
  modelIdField?: string;
  outputTokenParam?: string;
  modelsAuth?: boolean;
  contentThinkTags?: boolean;
  modelsAuthHeader?: string;
  anthropicVersion?: string;
  manualModelInput?: boolean;
  requiresApiKey?: boolean;
  supportsVision?: boolean;
  excludedModelIds?: string[];
  modelsSort?: string;
  custom?: boolean;
}
/** One explicit patch may specialize an existing provider without depending on catalog order. */
export type ProviderPresetOverride = Partial<ProviderDefinition> & { override: true };
export type ProviderPreset = ProviderDefinition | ProviderPresetOverride;

/** Product contributions are hooks; the public core owns settings persistence and attempt budgets. */
export interface ProviderContribution {
  definition: ProviderDefinition;
  summary?: Readonly<Record<string, unknown>>;
  resolveRequestConfig?(config: RuntimeConfig): Promise<RuntimeConfig>;
  validateConfig?(config: RuntimeConfig): Promise<RuntimeConfig>;
  listModels?(): Promise<unknown[]>;
  recovery?(failure: {kind?: string; code?: string}): ProviderRecovery | null;
  unwrapHttpFailure?(body: unknown, parse: (value: unknown) => Record<string, unknown>): Record<string, unknown> | null;
}

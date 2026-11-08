import type { SkillSettingField, SkillSettings } from "../skills/skill-settings.js";
import type { SecurityGuardrails } from "../security-guardrails.js";

/** Model configuration crossing Background and Side Panel; secrets stay within extension messaging. */
export interface ModelConfiguration extends Record<string, unknown> {
  provider: string; apiKey: string; model: string; modelLabel: string;
  modelParameters: Record<string, unknown>;
  customProtocol: string; customEndpoint: string; customPresetName: string;
  maxOutputTokens?: number;
  contextWindow?: number; trimOldToolResults: boolean; vision: boolean;
}
export interface ModelPreset extends ModelConfiguration { id: string; name: string; updatedAt: string }
export interface PresetUsage { selections: Record<string, number>; transitions: Record<string, Record<string, number>> }
export interface ProviderAuthStatus {
  loggedIn: boolean; accountId?: string; expiresAt?: number; expired?: boolean; hasRefreshToken?: boolean; refreshError?: string;
}
export interface ProviderDeviceLogin { loginId: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresAt: number }
export interface ProviderLoginPoll {
  status: string; message?: string; authStatus?: ProviderAuthStatus; accountId?: string; intervalSeconds?: number;
}
export interface CustomProviderProtocol { id: string; label: string }
export interface SettingsConfig extends ModelConfiguration {
  activePresetId: string; presets: ModelPreset[]; presetUsage: PresetUsage; providerApiKeys: Record<string, string>;
  providerAuth?: Record<string, ProviderAuthStatus>; providers?: readonly ProviderSummary[]; requestRateLimit: boolean; debugMode: boolean;
  securityGuardrails?: SecurityGuardrails; endpoint?: string; providerLabel?: string;
  customProtocols?: readonly CustomProviderProtocol[];
  [productField: string]: unknown;
}
export interface SkillSetting extends Omit<SkillSettings, "fields"> {
  id: string; pluginId: string; pluginName: string; skillName: string; skillDisplayName: string;
  configured: boolean; missing: string[]; updatedAt: string;
  fields: (SkillSettingField & { value?: unknown; hasValue?: boolean })[];
}

/** Declarative settings only; executable authentication ports remain in Background. */
export interface ProviderModelOption {
  key: string; label: string; defaultValue: string;
  options: readonly { value: string; label: string }[];
}
export interface ProviderAuthPresentation { label: string; hint?: string }
/** Stable group identity; labels are localized when Background creates a config snapshot. */
export interface ProviderGroup {
  id: string;
  label: string;
  /** Higher values appear first. Omitted priorities are 0; ties sort by display name. */
  priority?: number;
}
export interface ProviderSummary {
  id: string; label: string; requiresApiKey: boolean; auth?: ProviderAuthPresentation;
  /** Resolved model request URL; custom forms derive theirs from the editable draft. */
  endpoint?: string;
  /** Presentation only; the request URL remains available to Background and configuration tools. */
  hideEndpoint?: boolean;
  editableEndpoint?: string;
  protocol?: string;
  modelsIncludeCapabilities?: boolean;
  group?: ProviderGroup;
  modelOptions?: readonly ProviderModelOption[];
}
// Historical wire aliases remain readable while consumers move to provider-neutral contracts.
export type CodexAuthStatus = ProviderAuthStatus;
export type CodexDeviceLogin = ProviderDeviceLogin;
export type CodexLoginPoll = ProviderLoginPoll;

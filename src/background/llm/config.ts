import { t } from "../../shared/i18n/backend.js";
import { listProviderModels, validateProviderApiKey } from "./model-directory.js";
import { PROVIDERS, normalizeProvider, getProviderDef, isCustomProvider, normalizeCustomProtocol, normalizeCustomEndpoint, providerRequiresApiKey, getProviderEndpoint } from "./provider-catalog.js";
export { listProviderSummaries, formatProviderModelName, normalizeProvider, getProviderDef, providerRequiresApiKey, getProviderEndpoint, buildProviderBaseHeaders } from "./provider-catalog.js";
import { normalizeModelParameters } from "../../shared/models/model-parameters.js";
import { nowBeijingDateTime } from "../../shared/time-utils.js";
import { getProviderAuthState } from "./provider-auth.js";
import { normalizeProviderModelOptions } from "../../shared/models/provider-options.js";
import { listProviderSummaries } from "./provider-catalog.js";
import { PRODUCT_PROVIDERS, getProductProviderAuthStatus, isRetiredProductCredential } from '../product/providers.js';

import type { ModelPreset, PresetUsage, SettingsConfig } from "../../shared/contracts/settings.js";
import type { RuntimeConfig } from "../../sdk/background/providers.js";
type ConfigInput = Record<string, unknown>;
interface ModelIdentity { provider: string; model: string }
type ModelChangeObserver = (previous: ModelIdentity, next: ModelIdentity) => unknown;
type ConnectionSnapshot = ReturnType<typeof getModelConnectionSnapshot>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  apiKey: "",
  model: "",
  modelLabel: "",
  modelParameters: {},
  customProtocol: "openai",
  customEndpoint: "",
  customPresetName: "",
  trimOldToolResults: true,
  vision: false,
  requestRateLimit: false,
  debugMode: false,
};
const CONFIG_KEY = "llmConfig";
const LEGACY_BUILTIN_MODEL = "accounts/fireworks/models/kimi-k2p6";

let modelChangeObserver: ModelChangeObserver | null = null;

/**
 * Registers the single observer fired after the persisted provider/model
 * actually changes (settings save, preset apply, manage_settings tool — every
 * write flows through this module). Product observers own any reporting policy.
 */
export function setModelChangeObserver(observer: ModelChangeObserver | null) {
  modelChangeObserver = typeof observer === "function" ? observer : null;
}

function notifyModelChange(previousModel: ModelIdentity, nextConfig: ConfigInput) {
  if (!modelChangeObserver) return;
  const nextModel = modelIdentityOf(nextConfig);
  if (!nextModel.provider || !nextModel.model) return;
  if (
    previousModel.provider === nextModel.provider
    && previousModel.model === nextModel.model
  ) return;
  try {
    Promise.resolve(modelChangeObserver(previousModel, nextModel)).catch(() => {});
  } catch (_error) {}
}

function modelIdentityOf(config: ConfigInput = {}) {
  return {
    provider: normalizeProvider(config.provider),
    model: String(config.model || "").trim(),
  };
}

export async function getConfig(): Promise<SettingsConfig> {
  const raw = await readRawConfig();
  const providerApiKeys = getStoredProviderApiKeys(raw);
  const presets = normalizePresets(raw.presets);
  const activePresetId = presets.some(p => p.id === raw.activePresetId) ? normalizePresetId(raw.activePresetId) : "";
  const presetUsage = normalizePresetUsage(raw.presetUsage, presets);
  const [providerAuthState, productAuthStatus] = await Promise.all([
    getProviderAuthState(),
    getProductProviderAuthStatus(),
  ]);
  const provider = normalizeProvider(raw.provider);
  const providerDef = getProviderDef({ ...raw, provider });
  const fallbackApiKey = providerRequiresApiKey(providerDef) ? providerApiKeys[provider] || "" : "";
  const config = {
    ...normalizeConfig({ ...DEFAULT_CONFIG, ...raw, apiKey: raw.apiKey || fallbackApiKey }),
    activePresetId,
    presets,
    presetUsage,
    providerApiKeys,
    ...providerAuthState,
    providers: listProviderSummaries(),
    ...productAuthStatus,
  };
  return config;
}

export function saveConfig(config: ConfigInput, signal?: AbortSignal) { return saveConfiguration(config, false, signal); }
export function saveModelPreset(preset: ConfigInput, signal?: AbortSignal) { return saveConfiguration(preset, true, signal); }

async function saveConfiguration(config: ConfigInput, preserveRuntime: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const raw = await readRawConfig();
  signal?.throwIfAborted();
  const fields = Object.keys(config);
  if (!preserveRuntime && fields.length && fields.every(key => key === "debugMode" || key === "requestRateLimit")) {
    for (const key of fields) {
      if (typeof config[key] !== "boolean") throw new TypeError(`${key} requires a boolean.`);
    }
    // These preferences also apply before a model has been configured.
    await writeRawConfig({ ...raw, ...config }, signal);
    return getConfig();
  }
  const providerApiKeys = getStoredProviderApiKeys(raw);
  const presets = normalizePresets(raw.presets);
  const current = normalizeStoredConfigForConnection(raw, providerApiKeys);
  const previousModel = modelIdentityOf({ ...DEFAULT_CONFIG, ...raw });
  validateProvidedContextWindow(config);
  validateProvidedModelParameters(config);
  const candidate = { ...DEFAULT_CONFIG, ...raw, ...config };
  if (
    Object.prototype.hasOwnProperty.call(config || {}, "model")
    && !Object.prototype.hasOwnProperty.call(config || {}, "modelLabel")
  ) {
    candidate.modelLabel = "";
  }
  const normalized = normalizeConfig(candidate);
  const validated = await validateConfigBeforeSave(normalized, {
    signal,
    validateConnection: !modelConnectionSnapshotsEqual(
      getModelConnectionSnapshot(normalized),
      getModelConnectionSnapshot(current),
    ),
  });
  const nextProviderApiKeys = rememberProviderApiKey(providerApiKeys, validated);
  const presetResult = upsertPresetForConfig(presets, validated);
  await writeRawConfig({
    ...validated,
    ...(preserveRuntime ? { requestRateLimit: raw.requestRateLimit === true, debugMode: raw.debugMode === true } : {}),
    activePresetId: presetResult.activePresetId,
    presets: presetResult.presets,
    presetUsage: raw.presetUsage,
    providerApiKeys: nextProviderApiKeys,
  }, signal);
  const next = await getConfig();
  if (!preserveRuntime) notifyModelChange(previousModel, next);
  return next;
}

export async function applyModelPreset(presetId: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const raw = await readRawConfig();
  signal?.throwIfAborted();
  const presets = normalizePresets(raw.presets);
  const id = normalizePresetId(presetId);
  const preset = presets.find(p => p.id === id);
  if (!preset) throw new Error("Preset not found");
  const previousPresetId = presets.some(p => p.id === raw.activePresetId) ? normalizePresetId(raw.activePresetId) : "";
  if (previousPresetId === preset.id) return getConfig();
  const previousModel = modelIdentityOf({ ...DEFAULT_CONFIG, ...raw });
  const presetUsage = recordPresetSwitch(raw.presetUsage, presets, previousPresetId, preset.id);
  await writeRawConfig({
    ...preset,
    apiKey: getPresetApiKeyForApply(preset, raw),
    requestRateLimit: raw.requestRateLimit === true,
    debugMode: raw.debugMode === true,
    activePresetId: preset.id,
    presets,
    presetUsage,
    providerApiKeys: raw.providerApiKeys,
  }, signal);
  const next = await getConfig();
  notifyModelChange(previousModel, next);
  return next;
}

export async function deleteModelPreset(presetId: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const raw = await readRawConfig();
  signal?.throwIfAborted();
  const id = normalizePresetId(presetId);
  const presets = normalizePresets(raw.presets).filter(p => p.id !== id);
  await writeRawConfig({
    ...raw,
    activePresetId: raw.activePresetId === id ? "" : raw.activePresetId,
    presets,
    providerApiKeys: raw.providerApiKeys,
  }, signal);
  return getConfig();
}

export async function listModels(options: ConfigInput = {}) {
  const baseConfig = await getConfig();
  const provider = normalizeProvider(options.provider || baseConfig.provider);
  const providerDef = getProviderDef({ ...baseConfig, ...options, provider });
  const apiKey = providerRequiresApiKey(providerDef)
    ? sanitizeApiKey(options.apiKey ?? baseConfig.apiKey ?? "")
    : "";

  return listProviderModels(provider, providerDef, apiKey, options.signal instanceof AbortSignal ? options.signal : undefined);
}

async function readRawConfig() {
  const { [CONFIG_KEY]: stored = {} } = await chrome.storage.local.get(CONFIG_KEY);
  return isPlainObject(stored) ? stored : {};
}

async function writeRawConfig(config: ConfigInput, signal?: AbortSignal) {
  const normalized = normalizeConfig({ ...DEFAULT_CONFIG, ...config });
  const presets = normalizePresets(config.presets);
  const activePresetId = presets.some(p => p.id === config.activePresetId) ? config.activePresetId : "";
  const presetUsage = normalizePresetUsage(config.presetUsage, presets);
  const providerApiKeys = normalizeProviderApiKeys(config.providerApiKeys);
  // Lookup and validation can outlive a cancelled tool; check at the commit boundary.
  signal?.throwIfAborted();
  await chrome.storage.local.set({
    [CONFIG_KEY]: {
      ...storedModelConfiguration(normalized),
      requestRateLimit: normalized.requestRateLimit,
      debugMode: normalized.debugMode,
      activePresetId,
      presets,
      presetUsage,
      providerApiKeys,
    },
  });
}

export function normalizeConfig(config: ConfigInput = {}) {
  const provider = normalizeProvider(config.provider);
  const providerDef = getProviderDef({ ...config, provider });
  const rawApiKey = String(config.apiKey || "").trim();
  const hasLegacyBuiltinKey = isRetiredProductCredential(rawApiKey);
  const rawModel = String(config.model || "").trim();
  const customProvider = isCustomProvider(provider);
  return {
    provider,
    providerLabel: providerDef.label,
    endpoint: getProviderEndpoint(providerDef),
    apiKey: !providerRequiresApiKey(providerDef) || hasLegacyBuiltinKey ? "" : rawApiKey,
    model: hasLegacyBuiltinKey && rawModel === LEGACY_BUILTIN_MODEL ? "" : rawModel,
    modelLabel: String(config.modelLabel || "").trim(),
    modelParameters: normalizeModelParameters(config.modelParameters),
    ...normalizeModelOptions(config, providerDef),
    customProtocol: customProvider ? normalizeCustomProtocol(config.customProtocol) : "",
    customEndpoint: customProvider
      ? normalizeCustomEndpoint(config.customEndpoint || config.endpoint, config.customProtocol)
      : "",
    customPresetName: customProvider ? normalizeCustomPresetName(config.customPresetName) : "",
    contextWindow: parseContextWindow(config.contextWindow, providerDef.defaultContextWindow),
    trimOldToolResults: config.trimOldToolResults !== false,
    vision: providerDef.supportsVision === false ? false : config.vision === true,
    requestRateLimit: config.requestRateLimit === true,
    debugMode: config.debugMode === true,
  };
}

export async function resolveRequestConfig(options: { config?: RuntimeConfig | null } = {}) {
  let config = options.config && typeof options.config === "object"
    ? normalizeConfig({ ...DEFAULT_CONFIG, ...options.config })
    : await getConfig();
  return PRODUCT_PROVIDERS[config.provider]?.resolveRequestConfig?.(config) ?? config;
}

function sanitizeApiKey(value: unknown) {
  const apiKey = String(value || "").trim();
  return isRetiredProductCredential(apiKey) ? "" : apiKey;
}

function normalizeStoredConfigForConnection(raw: ConfigInput = {}, providerApiKeys = getStoredProviderApiKeys(raw)) {
  const provider = normalizeProvider(raw.provider);
  const providerDef = getProviderDef({ ...raw, provider });
  const fallbackApiKey = providerRequiresApiKey(providerDef) ? providerApiKeys[provider] || "" : "";
  return normalizeConfig({ ...DEFAULT_CONFIG, ...raw, apiKey: raw.apiKey || fallbackApiKey });
}

function getModelConnectionSnapshot(config: ConfigInput = {}) {
  const provider = normalizeProvider(config.provider);
  return {
    provider,
    apiKey: sanitizeApiKey(config.apiKey),
    model: String(config.model || "").trim(),
    customProtocol: isCustomProvider(provider) ? normalizeCustomProtocol(config.customProtocol) : "",
    customEndpoint: isCustomProvider(provider)
      ? normalizeCustomEndpoint(config.customEndpoint, config.customProtocol)
      : "",
  };
}

function modelConnectionSnapshotsEqual(a: ConnectionSnapshot, b: ConnectionSnapshot) {
  return a.provider === b.provider
    && a.apiKey === b.apiKey
    && a.model === b.model
    && a.customProtocol === b.customProtocol
    && a.customEndpoint === b.customEndpoint;
}

async function validateConfigBeforeSave(config: ReturnType<typeof normalizeConfig>, { validateConnection = true, signal }: { validateConnection?: boolean; signal?: AbortSignal } = {}) {
  const providerDef = getProviderDef(config);
  if (providerDef.custom) {
    const endpoint = normalizeCustomEndpoint(config.customEndpoint, config.customProtocol);
    if (!endpoint) {
      throw new Error(t("settings.endpointRequired"));
    }
    if (!isHttpEndpoint(endpoint)) {
      throw new Error(t("settings.endpointHttp"));
    }
  }
  const productValidation = PRODUCT_PROVIDERS[config.provider]?.validateConfig;
  if (productValidation) return productValidation(config);
  const model = String(config.model || "").trim();
  if (!model) {
    throw new Error(t("settings.modelRequired"));
  }
  if (!providerRequiresApiKey(providerDef)) return config;

  const apiKey = sanitizeApiKey(config.apiKey);
  if (!apiKey) {
    throw new Error(t("settings.providerKeyRequired", { provider: String(providerDef.label) }));
  }
  if (!validateConnection) return config;
  if (providerDef.modelsAuth === false || !providerDef.modelsEndpoint) return config;
  await validateProviderApiKey(providerDef, apiKey, signal);
  return config;
}

function getStoredProviderApiKeys(raw: ConfigInput = {}) {
  const providerApiKeys = normalizeProviderApiKeys(raw.providerApiKeys);
  const provider = normalizeProvider(raw.provider);
  const providerDef = getProviderDef({ ...raw, provider });
  const apiKey = sanitizeApiKey(raw.apiKey);
  if (apiKey && !providerApiKeys[provider] && providerRequiresApiKey(providerDef)) {
    providerApiKeys[provider] = apiKey;
  }
  return providerApiKeys;
}

function normalizeProviderApiKeys(value: unknown = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const keys: Record<string, string> = {};
  Object.entries(raw).forEach(([providerValue, apiKeyValue]) => {
    const provider = String(providerValue || "").trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) return;
    if (!providerRequiresApiKey(getProviderDef({ provider }))) return;
    const apiKey = sanitizeApiKey(apiKeyValue);
    if (apiKey) keys[provider] = apiKey;
  });
  return keys;
}

function rememberProviderApiKey(providerApiKeys: unknown, config: RuntimeConfig) {
  const next = normalizeProviderApiKeys(providerApiKeys);
  const providerDef = getProviderDef(config);
  if (!providerRequiresApiKey(providerDef)) return next;
  const apiKey = sanitizeApiKey(config.apiKey);
  if (apiKey) next[normalizeProvider(config.provider)] = apiKey;
  return next;
}

function upsertPresetForConfig(presets: ModelPreset[], config: RuntimeConfig) {
  const key = presetConfigKey(config);
  if (!key) throw new Error(t("settings.modelRequired"));
  const existing = presets.find(preset => presetConfigKey(preset) === key);
  const id = existing?.id || makePresetId();
  const preset = normalizePreset({
    ...config,
    id,
    name: defaultPresetName(config),
    updatedAt: nowBeijingDateTime(),
  });
  const nextPresets = presets.filter(item => {
    return item.id !== id && presetConfigKey(item) !== key;
  });
  nextPresets.push(preset);
  return {
    activePresetId: id,
    presets: sortPresets(nextPresets),
  };
}

function getPresetApiKeyForApply(preset: ModelPreset, raw: ConfigInput) {
  const provider = normalizeProvider(preset.provider);
  const providerDef = getProviderDef(preset);
  if (!providerRequiresApiKey(providerDef)) return "";
  if (providerDef.custom) return sanitizeApiKey(preset.apiKey) || getStoredProviderApiKeys(raw)[provider] || "";
  return getStoredProviderApiKeys(raw)[provider] || sanitizeApiKey(preset.apiKey);
}

function presetConfigKey(config: ConfigInput | ModelPreset = {}) {
  const model = String(config.model || "").trim().toLowerCase();
  if (!model) return "";
  const provider = normalizeProvider(config.provider);
  if (isCustomProvider(provider)) {
    const protocol = normalizeCustomProtocol(config.customProtocol);
    const endpoint = normalizeCustomEndpoint(config.customEndpoint, protocol).toLowerCase();
    return `${provider}::${protocol}::${endpoint}::${model}`;
  }
  return `${provider}::${model}`;
}

function normalizePresets(presets: unknown = []): ModelPreset[] {
  if (!Array.isArray(presets)) return [];
  const seen = new Set();
  const normalized: ModelPreset[] = [];
  for (const value of presets as unknown[]) {
    if (!isPlainObject(value)) continue;
    const preset = value;
    const id = normalizePresetId(preset?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(normalizePreset({ ...preset, id }));
  }
  return sortPresets(normalized);
}

function normalizePreset(preset: ConfigInput = {}): ModelPreset {
  const config = normalizeConfig(preset);
  const id = normalizePresetId(preset.id) || makePresetId();
  const rawName = String(preset.name || "").trim();
  const name = !rawName
    ? defaultPresetName(config)
    : rawName;
  return {
    ...storedModelConfiguration(config),
    id,
    name,
    updatedAt: String(preset.updatedAt || nowBeijingDateTime()),
  };
}

function sortPresets(presets: ModelPreset[]) {
  return presets.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
}

function normalizePresetId(value: unknown) {
  return String(value || "").trim();
}

function normalizePresetUsage(value: unknown, presets: ModelPreset[]): PresetUsage {
  const usage = isPlainObject(value) ? value : {};
  const selections = isPlainObject(usage.selections) ? usage.selections : {};
  const transitions = isPlainObject(usage.transitions) ? usage.transitions : {};
  const validIds = new Set(presets.map(preset => preset.id));
  const normalizedSelections: [string, number][] = [];
  const normalizedTransitions: [string, Record<string, number>][] = [];

  for (const presetId of validIds) {
    const count = normalizePresetUsageCount(selections[presetId]);
    if (count > 0) normalizedSelections.push([presetId, count]);

    const targetValue = transitions[presetId];
    const targets = isPlainObject(targetValue) ? targetValue : {};
    const normalizedTargets: [string, number][] = [];
    for (const targetId of validIds) {
      if (targetId === presetId) continue;
      const transitionCount = normalizePresetUsageCount(targets[targetId]);
      if (transitionCount > 0) normalizedTargets.push([targetId, transitionCount]);
    }
    if (normalizedTargets.length) {
      normalizedTransitions.push([presetId, Object.fromEntries(normalizedTargets)]);
    }
  }

  return {
    selections: Object.fromEntries(normalizedSelections),
    transitions: Object.fromEntries(normalizedTransitions),
  };
}

function recordPresetSwitch(value: unknown, presets: ModelPreset[], previousPresetId: string, nextPresetId: string) {
  const usage = normalizePresetUsage(value, presets);
  if (!nextPresetId || previousPresetId === nextPresetId) return usage;

  usage.selections[nextPresetId] = incrementPresetUsageCount(usage.selections[nextPresetId]);
  if (previousPresetId) {
    const targets = usage.transitions[previousPresetId] || {};
    targets[nextPresetId] = incrementPresetUsageCount(targets[nextPresetId]);
    usage.transitions[previousPresetId] = targets;
  }
  return usage;
}

function normalizePresetUsageCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), Number.MAX_SAFE_INTEGER);
}

function incrementPresetUsageCount(value: unknown) {
  return Math.min(normalizePresetUsageCount(value) + 1, Number.MAX_SAFE_INTEGER);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function makePresetId() {
  return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultPresetName(config: ConfigInput) {
  const customPresetName = isCustomProvider(normalizeProvider(config.provider)) ? normalizeCustomPresetName(config.customPresetName) : "";
  if (customPresetName) return customPresetName;
  const provider = getProviderDef(config).label || String(config.provider || "Model");
  const model = String(config.modelLabel || config.model || "").trim();
  return model ? `${provider} · ${model}` : provider;
}

function normalizeCustomPresetName(value: unknown) {
  return String(value || "").trim();
}

function isHttpEndpoint(value: unknown) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

function parseContextWindow(value: unknown, fallback: number | undefined) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  const raw = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  if (!raw) return fallback;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!match) return fallback;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return fallback;
  const unit = match[2];
  const multiplier = unit === "m" ? 1000000 : unit === "k" ? 1000 : 1;
  return Math.round(base * multiplier);
}

function validateProvidedContextWindow(config: ConfigInput = {}) {
  if (!Object.prototype.hasOwnProperty.call(config, "contextWindow")) return;
  const raw = String(config.contextWindow ?? "").trim();
  if (!raw) {
    throw new Error(t("settings.contextRequired"));
  }
  if (!parseContextWindow(config.contextWindow, 0)) {
    throw new Error(t("settings.contextInvalid"));
  }
}

function validateProvidedModelParameters(config: ConfigInput = {}) {
  if (!Object.prototype.hasOwnProperty.call(config, "modelParameters")) return;
  normalizeModelParameters(config.modelParameters, { strict: true });
}

function normalizeModelOptions(config: ConfigInput, selected = getProviderDef(config)) {
  const inactive = Object.fromEntries(Object.values(PROVIDERS).flatMap(provider => (provider.modelOptions || []).map(option => [option.key, ""])));
  return { ...inactive, ...normalizeProviderModelOptions(config, selected.modelOptions) };
}

/** Storage and presets share one projection; derived endpoint/UI labels never persist. */
function storedModelConfiguration(config: ReturnType<typeof normalizeConfig>) {
  const { providerLabel: _label, endpoint: _endpoint, requestRateLimit: _rate, debugMode: _debug, ...model } = config;
  return model;
}

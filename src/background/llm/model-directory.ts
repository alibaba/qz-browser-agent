import { t } from "../../shared/i18n/backend.js";
import { buildProviderBaseHeaders, getProviderDef, type ProviderDefinition } from './provider-catalog.js';
import { matchConfiguredModelCapabilities } from '../../shared/models/model-capabilities.js';
import type { ModelCapabilityMatch } from '../../shared/contracts/model-capabilities.js';
import type { ProviderModelOptionEntry } from './provider-types.js';
import { PRODUCT_PROVIDERS } from '../product/providers.js';
import { withTimeout } from './transport.js';

type ModelOption = ProviderModelOptionEntry;
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

export async function listProviderModels(provider: string, providerDef: ProviderDefinition, apiKey: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (providerDef.listModels) {
    const result = await providerDef.listModels({ provider, definition: providerDef, apiKey, signal, normalize: input => normalizeModelList(input, providerDef), read: (endpoint, headers) => readModelResponse(endpoint, headers, signal) });
    signal?.throwIfAborted();
    return { provider, providerLabel: providerDef.label, models: normalizeModelList(result, providerDef) };
  }
  const productModels = PRODUCT_PROVIDERS[provider]?.listModels;
  if (productModels) return { provider, providerLabel: providerDef.label, models: normalizeModelList(await productModels(), providerDef) };
  if (providerDef.manualModelInput === true) {
    return {
      provider,
      providerLabel: providerDef.label,
      models: [],
      manualInputOnly: true,
    };
  }
  if (providerDef.custom) {
    return { provider, providerLabel: providerDef.label, models: [] };
  }
  if (Array.isArray(providerDef.staticModels) && providerDef.staticModels.length > 0) {
    return {
      provider,
      providerLabel: providerDef.label,
      models: normalizeModelList(providerDef.staticModels, providerDef),
    };
  }
  if (providerDef.modelsAuth !== false && !apiKey) {
    throw new Error(t("settings.providerKeyForModels", { provider: String(providerDef.label) }));
  }
  if (!providerDef.modelsEndpoint) {
    throw new Error(t("settings.modelsEndpointMissing", { provider: String(providerDef.label) }));
  }

  const { response, text } = await readModelResponse(providerDef.modelsEndpoint, buildModelListHeaders(providerDef, apiKey), signal);
  if (!response.ok) throw new Error(`${providerDef.label} Models API ${response.status}: ${text.slice(0, 300)}`);
  return { provider, providerLabel: providerDef.label, models: normalizeModelList(parseModelResponse(text, providerDef.label), providerDef) };
}

export async function matchProviderModelCapabilities(config: { provider?: string; model?: string; customEndpoint?: string; apiKey?: string } = {}, signal?: AbortSignal): Promise<ModelCapabilityMatch> {
  const definition = getProviderDef(config);
  if (!definition.modelsIncludeCapabilities || !config.model) return matchConfiguredModelCapabilities(config, signal);
  const { models } = await listProviderModels(config.provider || "", definition, config.apiKey || "", signal);
  const model = models.find(entry => entry.id === config.model);
  return {
    matched: !!model && (model.contextWindow !== undefined || model.maxOutputTokens !== undefined || model.vision !== undefined),
    model: config.model || "", matchedId: model?.id || "",
    contextWindow: model?.contextWindow ?? null, maxOutputTokens: model?.maxOutputTokens ?? null, vision: model?.vision ?? null,
    source: definition.label, providerId: config.provider || "", providerLabel: definition.label,
  };
}

function normalizedCapabilities(item: Record<string, unknown>) {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return {
    ...(positive(item.contextWindow) ? { contextWindow: item.contextWindow } : {}),
    ...(positive(item.maxOutputTokens) ? { maxOutputTokens: item.maxOutputTokens } : {}),
    ...(typeof item.vision === "boolean" ? { vision: item.vision } : {}),
  };
}

export async function validateProviderApiKey(providerDef: ProviderDefinition, apiKey: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const { response, text } = await readModelResponse(providerDef.modelsEndpoint || "", buildModelListHeaders(providerDef, apiKey), signal);
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(t("settings.modelsApiRejected", { provider: String(providerDef.label), status: String(response.status), details: String(text ? `：${text.slice(0, 300)}` : "") }));
    }
  } catch (err) {
    signal?.throwIfAborted();
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(t("settings.accessKeyInvalid"))) throw err;
    throw new Error(t("settings.modelsKeyInvalid", { provider: String(providerDef.label), message: String(message) }));
  }
}

async function readModelResponse(endpoint: string, headers: Record<string, string>, parentSignal?: AbortSignal) {
  const { signal, cleanup } = withTimeout(parentSignal, 30000);
  try {
    const response = await fetch(endpoint, { method: "GET", headers, signal });
    return { response, text: await response.text() };
  } finally { cleanup(); }
}

function parseModelResponse(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error(t("settings.modelsNotJson", { provider: String(label) })); }
}

function normalizeModelList(input: unknown, providerDef: Partial<ProviderDefinition> = {}) {
  const data = asRecord(input);
  const rawModels = Array.isArray(input)
    ? input
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];
  const seen = new Set();
  const excludedModelIds = new Set(
    (Array.isArray(providerDef.excludedModelIds) ? providerDef.excludedModelIds : [])
      .map(id => String(id || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const models: ModelOption[] = [];
  for (const value of rawModels) {
    const item = typeof value === "string" ? value : asRecord(value);
    const id = typeof item === "string" ? item.trim() : getModelListId(item, providerDef);
    if (!id || excludedModelIds.has(id.toLowerCase()) || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof item === "object" && item
      ? String(item.owned_by || item.ownedBy || item.owner || "").trim()
      : "";
    const label = typeof item === "object" && item
      ? String(item.label || item.name || id).trim()
      : id;
    const priority = typeof item === "object" && item && typeof item.priority === "number"
      ? item.priority
      : null;
    const releaseDate = typeof item === "object" && item
      ? String(item.release_date || item.releaseDate || "").trim()
      : "";
    models.push({
      id,
      label: label || id,
      ownedBy,
      priority,
      releaseDate,
      ...(typeof item === "object" ? normalizedCapabilities(item) : {}),
    });
  }
  if (providerDef.compareModels) return models.sort((a, b) => providerDef.compareModels!(a, b, providerDef));
  if (providerDef.modelsSort === "priority" || models.some(model => model.priority != null)) {
    return models.sort((a, b) => {
      const pa = a.priority == null ? -Infinity : a.priority;
      const pb = b.priority == null ? -Infinity : b.priority;
      if (pb !== pa) return pb - pa;
      if (b.releaseDate !== a.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
      return a.id.localeCompare(b.id);
    });
  }
  if (providerDef.modelsSort === "source") return models;
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function getModelListId(item: Record<string, unknown>, providerDef: Partial<ProviderDefinition> = {}) {
  if (!item || typeof item !== "object") return "";
  if (providerDef.modelIdField === "name") {
    return String(item.name || item.id || item.model || item.slug || "").trim();
  }
  return String(item.id || item.name || item.model || item.slug || "").trim();
}

function buildModelListHeaders(providerDef: ProviderDefinition, apiKey: string) {
  const headers: Record<string, string> = buildProviderBaseHeaders(providerDef);
  if (providerDef.modelsAuth === false) return headers;
  if (providerDef.modelsAuthHeader === "x-api-key") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = providerDef.anthropicVersion || "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

import { getProviderEndpoint } from "./provider-endpoint.js";
export { getProviderEndpoint } from "./provider-endpoint.js";
import contributions from "#capabilities/presets";
import { resolveProviderPresets } from "./provider-presets.js";
import { completeCustomProviderEndpoint, normalizeCustomProtocol } from "../../shared/models/custom-provider-endpoint.js";
export { normalizeCustomProtocol } from "../../shared/models/custom-provider-endpoint.js";
import { PRODUCT_PROVIDERS, getProductDefaultProvider } from "../product/providers.js";

import type { ProviderDefinition } from './provider-types.js';
export type { ProviderDefinition } from './provider-types.js';
type ProviderInput = { provider?: unknown; customProtocol?: unknown; customEndpoint?: unknown; endpoint?: unknown };
const PROVIDER_BASE_HEADERS = { "x-app": "cli" };
const CUSTOM_PROVIDER_ID = "custom";
// Explicit policy patches preserve live labels and executable handler identity.
export const PROVIDERS = resolveProviderPresets([...contributions, Object.fromEntries(
  Object.entries(PRODUCT_PROVIDERS).map(([id, contribution]) => [id, contribution.definition]),
)]);

export function listProviderSummaries() {
  return Object.entries(PROVIDERS).map(([id, providerDef]) => {
    const staticModelCount = Array.isArray(providerDef.staticModels) ? providerDef.staticModels.length : providerDef.staticModelCount || 0;
    return {
      id,
      label: providerDef.label || id,
      ...(providerDef.group ? { group: { ...providerDef.group } } : {}),
      api: providerDef.api || "",
      protocol: providerDef.protocol || "",
      endpoint: getProviderEndpoint(providerDef),
      ...(providerDef.hideEndpoint ? { hideEndpoint: true } : {}),
      custom: providerDef.custom === true,
      ...(providerDef.auth ? { auth: { label: providerDef.auth.label, hint: providerDef.auth.hint } } : {}),
      modelOptions: providerDef.modelOptions || [],
      ...PRODUCT_PROVIDERS[id]?.summary,
      requiresApiKey: providerRequiresApiKey(providerDef),
      defaultContextWindow: Number(providerDef.defaultContextWindow) || 0,
      models: {
        staticCount: staticModelCount,
        hasStaticModels: staticModelCount > 0,
        hasModelsEndpoint: Boolean(providerDef.modelsEndpoint),
        manualInputOnly: providerDef.manualModelInput === true,
        modelsDevId: "",
        modelsDevPreferred: false,
        modelsAuth: providerDef.modelsAuth !== false,
      },
    };
  });
}

export function formatProviderModelName(provider: unknown, model: unknown) {
  const providerId = String(provider || "").trim().toLowerCase();
  const providerLabel = String(PROVIDERS[providerId]?.label || provider || "").trim();
  const modelName = String(model || "").trim();
  if (!providerLabel) return modelName;
  if (!modelName) return providerLabel;

  const lowerModel = modelName.toLowerCase();
  const lowerLabel = providerLabel.toLowerCase();
  if (lowerModel.startsWith(`${lowerLabel}/`)) {
    return `${providerLabel}/${modelName.slice(providerLabel.length + 1)}`;
  }
  if (providerId && lowerModel.startsWith(`${providerId}/`)) {
    return `${providerLabel}/${modelName.slice(providerId.length + 1)}`;
  }
  return `${providerLabel}/${modelName}`;
}

export function normalizeProvider(value: unknown) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!provider) return getProductDefaultProvider();
  // Unknown saved providers must retain their endpoint instead of sending credentials to a default service.
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider) ? provider : CUSTOM_PROVIDER_ID;
}

export function getProviderDef(configOrProvider: ProviderInput | string = {}): ProviderDefinition {
  const config = configOrProvider && typeof configOrProvider === "object"
    ? configOrProvider
    : { provider: configOrProvider };
  const provider = normalizeProvider(config.provider);
  const providerDef = PROVIDERS[provider] || PROVIDERS.fireworks;
  if (!isCustomProvider(provider)) return providerDef;
  const protocol = normalizeCustomProtocol(config.customProtocol);
  return {
    ...providerDef,
    api: ({ anthropic: "anthropic-messages", openai: "openai-chat-completions" } as Record<string, string>)[protocol] || protocol,
    protocol,
    endpoint: normalizeCustomEndpoint(config.customEndpoint || config.endpoint, protocol),
    baseUrl: "",
    modelsEndpoint: "",
    modelsAuth: false,
    modelsAuthHeader: protocol === "anthropic" ? "x-api-key" : "",
  };
}

export function isCustomProvider(provider = "") {
  return normalizeProvider(provider) === CUSTOM_PROVIDER_ID;
}

export function normalizeCustomEndpoint(value: unknown, protocol: unknown = "openai") {
  return completeCustomProviderEndpoint(value, protocol);
}

export function providerRequiresApiKey(providerDef: Partial<ProviderDefinition> = {}) {
  return providerDef.requiresApiKey !== false && !providerDef.auth;
}


export function buildProviderBaseHeaders(providerDef: Partial<ProviderDefinition> = {}, request?: { sessionId?: string }) {
  const headers: Record<string, string> = { ...PROVIDER_BASE_HEADERS, ...providerDef.requestHeaders };
  if (request && typeof providerDef.sessionAffinityHeader === "string") {
    // Resolve once per model call, before transport retries. Standalone SDK calls must
    // not share a process-wide fallback identity with unrelated conversations.
    const sessionId = String(request.sessionId || "").trim();
    headers[providerDef.sessionAffinityHeader] = sessionId ? encodeURIComponent(sessionId) : crypto.randomUUID();
  }
  return headers;
}

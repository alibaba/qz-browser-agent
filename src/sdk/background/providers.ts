/** Optional runtime model settings; configured providers may carry additional request fields. */
export interface RuntimeConfig {
  provider?: string;
  providerLabel?: string;
  model?: string;
  modelLabel?: string;
  endpoint?: string;
  apiKey?: string;
  customProtocol?: string;
  customEndpoint?: string;
  customPresetName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  toolCalling?: boolean;
  trimOldToolResults?: boolean;
  requestRateLimit?: boolean;
  debugMode?: boolean;
  modelParameters?: Readonly<Record<string, unknown>>;
  /** Keys declared by a provider's modelOptions remain extensible and are normalized by that provider. */
  [key: string]: unknown;
}
export type { ModelEvent, ModelMessage, ModelOptions, ProviderAdapter, RawModelExchange } from "../../background/llm/protocol-registry.js";
export { PROVIDER_STATE_ANTHROPIC_THINKING, PROVIDER_STATE_OPENAI_REASONING, PROVIDER_STATE_OPENAI_RESPONSES_REASONING, contentToPlainText, createAssistantProviderState, formatOutputTruncatedError, getToolCallArgumentsValue, isOutputTruncatedFinishReason, isReplayableProviderState, normalizeHeaderToken, normalizeJsonArgumentString, normalizeToolCallName, parseToolArguments, resolveRequestMaxOutputTokens } from "../../background/llm/protocol-shared.js";
export { normalizeLlmFailure } from "../../background/llm/provider-errors.js";
export { providerRecoveryHint } from "../../background/llm/provider-recovery.js";
export type { ProviderAuth, ProviderContribution, ProviderDefinition, ProviderPreset, ProviderPresetOverride, ProviderModelDiscovery, ProviderModelOptionEntry } from "../../background/llm/provider-types.js";
export { REQUEST_TIMEOUT, fetchLlmEndpointWithRetry, readSseFrames, readWithIdleTimeout, withTimeout } from "../../background/llm/transport.js";
export type { ProviderAuthStatus, ProviderDeviceLogin, ProviderLoginPoll, ProviderAuthPresentation, ProviderGroup } from "../../shared/contracts/settings.js";

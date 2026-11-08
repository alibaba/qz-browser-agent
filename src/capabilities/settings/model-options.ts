import {
  filterModelOptions,
  normalizeModelOptions,
  type ModelOption, type ModelOptionInput,
} from "#sdk/shared/settings";

export interface ModelOptionsInput {
  provider?: string; endpoint?: string; customEndpoint?: string; customProtocol?: string; credentialVersion?: string;
  apiKey?: string; refresh?: boolean;
}
type ModelList = readonly (string | ModelOptionInput)[];
interface ModelEntry { provider: string; providerLabel: string; models: ModelOption[]; loadedAt: number; sequence: number }
interface ModelOptionsControllerOptions {
  cacheLimit?: number;
  loadModels(input: ModelOptionsInput): Promise<ModelList | { models: ModelList; provider?: string; providerLabel?: string }>;
}

export function createModelOptionsController(options: ModelOptionsControllerOptions) {
  if (typeof options.loadModels !== "function") throw new Error("loadModels is required");
  const cache = new Map<string, ModelEntry>();
  const cacheLimit = Math.max(1, Number(options.cacheLimit) || 24);
  let requestSequence = 0;

  return {
    load,
    peek,
    filter,
    invalidate,
    cancel,
    getSnapshot,
  };

  async function load(input: ModelOptionsInput = {}) {
    const key = cacheKey(input);
    const sequence = ++requestSequence;
    if (!input.refresh && cache.has(key)) return { ...cache.get(key), cached: true, stale: false, sequence };
    let result;
    try {
      result = await options.loadModels(input);
    } catch (error) {
      if (sequence !== requestSequence) return { models: [], stale: true, cached: false, sequence };
      throw error;
    }
    if (sequence !== requestSequence) return { models: [], stale: true, cached: false, sequence };
    const info = "models" in result ? result : { models: result };
    const models = normalizeModelOptions(info.models);
    const entry = {
      provider: String(info.provider || input.provider || ""),
      providerLabel: String(info.providerLabel || ""),
      models,
      loadedAt: Date.now(),
      sequence,
    };
    cache.set(key, entry);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value!);
    return { ...entry, cached: false, stale: false };
  }

  function peek(input: ModelOptionsInput = {}) {
    const entry = cache.get(cacheKey(input));
    return entry ? { ...entry, cached: true, stale: false } : null;
  }

  function filter(models: ModelList, query: string) {
    return filterModelOptions(String(query || ""), normalizeModelOptions(models || []));
  }

  function invalidate(predicate: ((value: ModelEntry, key: string) => boolean) | null = null) {
    if (typeof predicate !== "function") {
      cache.clear();
      return;
    }
    for (const [key, value] of cache.entries()) if (predicate(value, key)) cache.delete(key);
  }

  function cancel() {
    requestSequence += 1;
  }

  function getSnapshot() {
    return { requestSequence, cacheSize: cache.size };
  }
}

function cacheKey(input: ModelOptionsInput) {
  return [
    String(input.provider || ""),
    String(input.customProtocol || ""),
    String(input.endpoint || input.customEndpoint || ""),
    String(input.credentialVersion || (input.apiKey ? "key" : "no-key")),
  ].join("\u001d");
}

import type { ProviderSummary } from "./contracts/settings.js";

/** Menu projection only: no provider IDs or geography policies belong in the host. */
export function groupProviderChoices(providers: readonly ProviderSummary[], locale: string) {
  type Group = { id: string; label: string; priority: number; providers: ProviderSummary[] };
  const groups = new Map<string, Group>();
  const compare = (a: { label: string; id: string }, b: { label: string; id: string }) =>
    a.label.localeCompare(b.label, locale) || a.id.localeCompare(b.id, "en");
  for (const provider of providers) {
    const id = provider.group?.id || "";
    const priority = provider.group?.priority;
    const declaration = {
      id, label: provider.group?.label || id,
      priority: typeof priority === "number" && Number.isFinite(priority) ? priority : 0,
    };
    let group = groups.get(id);
    if (!group) {
      group = { ...declaration, providers: [] };
      groups.set(id, group);
    } else if (declaration.priority > group.priority || (declaration.priority === group.priority && compare(declaration, group) < 0)) {
      // Independent packages can join a group; explicit higher-priority metadata wins deterministically.
      Object.assign(group, declaration);
    }
    group.providers.push(provider);
  }
  return [...groups.values()]
    .sort((a, b) => b.priority - a.priority || compare(a, b))
    .map(group => ({ ...group, providers: group.providers.sort(compare) }));
}

export interface ModelOptionInput {
  id?: unknown; label?: unknown; name?: unknown; ownedBy?: unknown; meta?: unknown;
  contextWindow?: unknown; maxOutputTokens?: unknown; vision?: unknown;
}
export interface ModelOption {
  id: string; label: string; meta: string; index: number; search: string; compactSearch: string;
  contextWindow?: number; maxOutputTokens?: number; vision?: boolean;
}

export function normalizeModelOptions(models: readonly (string | ModelOptionInput)[] = []) {
  const seen = new Set();
  const options: ModelOption[] = [];
  const rawOptions = Array.isArray(models) ? models : [];
  rawOptions.forEach((model, index) => {
    const id = typeof model === "string" ? model : model?.id;
    const modelId = String(id || "").trim();
    const key = modelId.toLowerCase();
    if (!modelId || seen.has(key)) return;
    seen.add(key);
    const label = typeof model === "object" && model
      ? String(model.label || model.name || modelId).trim()
      : modelId;
    const meta = typeof model === "object" && model
      ? String(model.ownedBy || model.meta || "").trim()
      : "";
    const metadata: ModelOptionInput = typeof model === "object" && model ? model : {};
    options.push({
      id: modelId,
      label: label || modelId,
      meta: meta === modelId ? "" : meta,
      ...(positiveTokenLimit(metadata.contextWindow) ? { contextWindow: metadata.contextWindow } : {}),
      ...(positiveTokenLimit(metadata.maxOutputTokens) ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
      ...(typeof metadata.vision === "boolean" ? { vision: metadata.vision } : {}),
      index,
      search: modelSearchText(`${modelId} ${label} ${meta}`),
      compactSearch: compactModelSearchText(`${modelId} ${label} ${meta}`),
    });
  });
  return options;
}

function positiveTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function computeModelSuggestionState({
  query = "",
  options = [],
  limit = 8,
  showAllOnExactMatch = false,
}: { query?: string; options?: readonly ModelOption[]; limit?: number; showAllOnExactMatch?: boolean } = {}) {
  const normalizedOptions = Array.isArray(options) ? options : [];
  const matchedOptions = filterModelOptions(query, normalizedOptions);
  const exactMatch = shouldHideUniqueExactModelSuggestion(query, matchedOptions);
  const useAllOptions = showAllOnExactMatch && exactMatch;
  const hidden = !useAllOptions && exactMatch;
  const visibleOptions = hidden
    ? []
    : (useAllOptions ? normalizedOptions : matchedOptions).slice(0, limit);
  return {
    hidden,
    exactMatch,
    useAllOptions,
    matchedOptions,
    visibleOptions,
  };
}

export function filterModelOptions(query: unknown, options: readonly ModelOption[]) {
  const q = modelSearchText(query);
  const compact = compactModelSearchText(query);
  if (!q && !compact) return Array.isArray(options) ? options.slice() : [];
  return (Array.isArray(options) ? options : [])
    .map((option) => {
      const idText = modelSearchText(option.id);
      const compactId = compactModelSearchText(option.id);
      const labelText = modelSearchText(option.label);
      const compactLabel = compactModelSearchText(option.label);
      let score = Infinity;
      if (
        idText === q
        || labelText === q
        || (compact && (compactId === compact || compactLabel === compact))
      ) score = 0;
      else if (
        idText.startsWith(q)
        || labelText.startsWith(q)
        || (compact && (compactId.startsWith(compact) || compactLabel.startsWith(compact)))
      ) score = 1;
      else if (
        idText.includes(q)
        || labelText.includes(q)
        || (compact && (compactId.includes(compact) || compactLabel.includes(compact)))
      ) score = 2;
      else if (option.search.includes(q) || (compact && option.compactSearch.includes(compact))) score = 3;
      return { option, score };
    })
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.option.index - b.option.index)
    .map(item => item.option);
}

export function shouldHideUniqueExactModelSuggestion(query: unknown, matches: readonly ModelOption[]) {
  const normalizedQuery = modelSearchText(query);
  return Array.isArray(matches)
    && matches.length === 1
    && (
      normalizedQuery === modelSearchText(matches[0]?.id)
      || normalizedQuery === modelSearchText(matches[0]?.label)
    );
}

export function modelSearchText(value: unknown = "") {
  return String(value || "").trim().toLowerCase();
}

export function compactModelSearchText(value: unknown = "") {
  return modelSearchText(value).replace(/[._\-/\s]+/g, "");
}

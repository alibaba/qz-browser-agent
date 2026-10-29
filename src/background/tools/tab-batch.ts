import type { ToolBatchTabPolicy } from "../../shared/contracts/tool.js";
import type { ToolDependencies } from "./tool-scheduler.js";
import { getLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "./arguments.js";
import { isTabAlias, tabReferenceId } from "../../shared/tab-reference.js";
import { tabReferenceError, resolveTabReference } from "./tab-reference.js";

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

/** Pin existing aliases when admitting the batch; new aliases keep private execution edges until publication. */
export function planTabBatch<T>(items: readonly T[], describe: (item: T) => {
  args: unknown; policy?: ToolBatchTabPolicy | null;
}, language = getLanguage(), aliases: Readonly<Record<string, number>> = {}) {
  const error = (reason: string, reference?: unknown) => tabReferenceError(reason, reference, language);
  const entries = items.map((item, index) => {
    const { args, policy } = describe(item);
    return { item, index, originalArgs: args, args: record(args), policy, error: null as ToolExecutionError | null };
  });
  type Entry = typeof entries[number];
  const byItem = new Map(entries.map(entry => [entry.item, entry]));
  const creators = new Map<string, Entry>(), duplicates = new Set<string>();
  const executed = new Map<Entry, { id: number; result: unknown }>(), published = new Map<Entry, number>();
  const committedCreators = new Set<Entry>();
  const creatorCount = entries.filter(entry => entry.policy?.kind === "create").length;
  for (const entry of entries) {
    const alias = entry.args.tabAlias;
    if (alias == null) continue;
    if (entry.policy?.kind !== "create" || !isTabAlias(alias)) { entry.error = error("invalid_alias", alias); continue; }
    const previous = creators.get(alias);
    if (previous) { duplicates.add(alias); previous.error = entry.error = error("duplicate_alias", alias); }
    else creators.set(alias, entry);
  }
  const parents = new Map<Entry, Entry>();
  const targets = new Map<Entry, number>();
  for (const entry of entries) {
    const ref = entry.args.tabRef;
    if (Object.hasOwn(entry.args, "tabRef")) {
      if (entry.policy?.kind !== "target") { entry.error = error("invalid_reference", ref); continue; }
      // Existing bindings win over an attempted duplicate open; its failure must not redirect readers.
      const producer = tabReferenceId(ref) === null && !Object.hasOwn(aliases, String(ref)) ? creators.get(String(ref)) : undefined;
      if (producer) {
        if (duplicates.has(String(ref))) entry.error = error("duplicate_alias", ref);
        else if (producer.index >= entry.index) entry.error = error("forward_reference", ref);
        else parents.set(entry, producer);
      } else {
        try { targets.set(entry, resolveTabReference(ref, aliases, language)); }
        catch (failure) { entry.error = failure as ToolExecutionError; }
      }
    } else if (creatorCount > 1 && entry.policy?.kind === "target" && entry.policy.implicit) entry.error = error("ambiguous_target");
    const target = targets.get(entry);
    if (target != null && (entry.args.tabId != null && entry.args.tabId !== target
      || entry.policy?.kind === "target" && entry.policy.tabId != null && entry.policy.tabId !== target)) {
      entry.error = error("conflicting_target", ref);
    }
  }
  const independent = (entry: Entry) => !entry.error && (entry.policy?.kind === "create"
    ? entry.policy.parallel === true
    : entry.policy?.kind === "target" && (entry.policy.observation || entry.policy.parallel === true)
      && (entry.args.tabRef != null || !entry.policy.implicit));
  const edges = new Map<T, ToolDependencies<T>>(), lanes = new Map<unknown, T>();
  let barrier: T | undefined, windowAnchor: T | undefined;
  for (const entry of entries) {
    const producer = parents.get(entry);
    // A uid-targeted policy carries its registered tab; everything else uses the requested tab.
    const policyTab = entry.policy?.kind === "target" ? entry.policy.tabId : undefined;
    const lane = entry.policy?.kind === "create" ? entry : producer || policyTab || targets.get(entry) || entry.args.tabId;
    const local = independent(entry);
    edges.set(entry.item, {
      execution: local && lanes.has(lane) ? [lanes.get(lane)!] : [],
      commit: !local ? items.slice(0, entry.index) : [
        ...(barrier === undefined ? [] : [barrier]),
        // An earlier numeric or uid target can select a different window. New sibling aliases share its anchor.
        ...(entry.policy?.kind === "create" && windowAnchor !== undefined ? [windowAnchor] : []),
        // Speculative observations can use a private permit; actions need published ownership.
        ...(producer && entry.policy?.kind === "target" && !entry.policy.observation ? [producer.item] : []),
      ],
    });
    if (!local) barrier = entry.item;
    else lanes.set(lane, entry.item);
    if (entry.policy?.kind === "target" && (policyTab != null || targets.has(entry) || entry.args.tabId != null)) windowAnchor = entry.item;
  }
  const parent = (entry: Entry) => parents.get(entry);
  const validResult = (entry: Entry, result: unknown, isError: boolean) => {
    const value = record(result), id = value.tabId ?? value.id;
    return entry.policy?.kind === "create" && !entry.error && !isError && !value.error
      && value.ok !== false && value.isError !== true && typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  };
  return {
    ordered: items,
    independent: (item: T) => independent(byItem.get(item)!),
    observation: (item: T) => {
      const policy = byItem.get(item)!.policy;
      return policy?.kind === "target" && policy.observation;
    },
    dependencies: (item: T) => edges.get(item)!,
    parallelCreate: (item: T) => byItem.get(item)!.policy?.kind === "create" && independent(byItem.get(item)!),
    executionParent: (item: T) => executed.get(parent(byItem.get(item)!)!)?.result,
    args(item: T): unknown {
      const entry = byItem.get(item)!;
      if (entry.error) throw entry.error;
      if (entry.args.tabRef == null) return entry.originalArgs;
      const producer = parent(entry)!;
      if (committedCreators.has(producer) && !published.has(producer)) throw error("dependency_failed", entry.args.tabRef);
      const tabId = targets.get(entry) ?? executed.get(producer)?.id;
      if (!tabId) throw error("dependency_failed", entry.args.tabRef);
      if (entry.args.tabId != null && entry.args.tabId !== tabId
        || entry.policy?.kind === "target" && entry.policy.tabId != null && entry.policy.tabId !== tabId) throw error("conflicting_target", entry.args.tabRef);
      const { tabRef: _ref, ...args } = entry.args;
      return { ...args, tabId };
    },
    complete(item: T, result: unknown, isError: boolean) {
      const entry = byItem.get(item)!, id = validResult(entry, result, isError);
      if (id) executed.set(entry, { id, result });
    },
    assertDependenciesCommitted(item: T) {
      const entry = byItem.get(item)!;
      if (!entry.error && parent(entry) && !published.has(parent(entry)!)) throw error("dependency_failed", entry.args.tabRef);
    },
    settle(item: T, result: unknown, isError: boolean) {
      const entry = byItem.get(item)!, id = validResult(entry, result, isError);
      if (entry.policy?.kind === "create") committedCreators.add(entry);
      if (id) published.set(entry, id);
    },
  };
}

import type { ToolBatchTabPolicy } from "../../shared/contracts/tool.js";
import type { ToolDependencies } from "./tool-scheduler.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { ToolExecutionError } from "./arguments.js";
import { t } from "./messages.js";

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const validAlias = (value: unknown): value is string => typeof value === "string" && /^[\p{L}\p{N}_-]{1,64}$/u.test(value);

const REFERENCE_MESSAGE_KEYS: Readonly<Record<string, Parameters<typeof t>[0]>> = {
  invalid_alias: "batchTabReferenceInvalidAlias",
  duplicate_alias: "batchTabReferenceDuplicateAlias",
  invalid_reference: "batchTabReferenceInvalidReference",
  unknown_reference: "batchTabReferenceUnknownReference",
  forward_reference: "batchTabReferenceForwardReference",
  ambiguous_target: "batchTabReferenceAmbiguousTarget",
};

/** Private execution edges are separate from published bindings. Neither survives this message. */
export function planTabBatch<T>(items: readonly T[], describe: (item: T) => {
  args: unknown; policy?: ToolBatchTabPolicy | null;
}, language = getLanguage()) {
  const error = (reason: string, reference?: unknown) => {
    const dependency = reason === "dependency_failed";
    const key = dependency ? "batchTabDependencyFailed" : REFERENCE_MESSAGE_KEYS[reason] || "batchTabReferenceError";
    return new ToolExecutionError(
      dependency ? "BATCH_TAB_DEPENDENCY_FAILED" : "BATCH_TAB_REFERENCE_ERROR",
      withLanguage(language, () => t(key, { tabRef: reference == null ? (language === "zh-CN" ? "（未知）" : "unknown") : String(reference) })),
      { reason, ...(reference == null ? {} : { tabRef: reference }) },
    );
  };
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
    if (entry.policy?.kind !== "create" || !validAlias(alias)) { entry.error = error("invalid_alias", alias); continue; }
    const previous = creators.get(alias);
    if (previous) { duplicates.add(alias); previous.error = entry.error = error("duplicate_alias", alias); }
    else creators.set(alias, entry);
  }
  for (const entry of entries) {
    const ref = entry.args.tabRef;
    if (ref != null) {
      if (entry.policy?.kind !== "target" || !entry.policy.implicit || !validAlias(ref)) entry.error = error("invalid_reference", ref);
      else if (duplicates.has(ref)) entry.error = error("duplicate_alias", ref);
      else if (!creators.has(ref)) entry.error = error("unknown_reference", ref);
      // Ordered publication cannot depend on a later commit. Require producers before consumers.
      else if (creators.get(ref)!.index >= entry.index) entry.error = error("forward_reference", ref);
    } else if (creatorCount > 1 && entry.policy?.kind === "target" && entry.policy.implicit) entry.error = error("ambiguous_target");
  }
  const independent = (entry: Entry) => !entry.error && (entry.policy?.kind === "create"
    ? entry.policy.parallel === true
    : entry.policy?.kind === "target" && (entry.policy.observation || entry.policy.parallel === true)
      && (entry.args.tabRef != null || !entry.policy.implicit));
  const edges = new Map<T, ToolDependencies<T>>(), lanes = new Map<unknown, T>();
  let barrier: T | undefined, windowAnchor: T | undefined;
  for (const entry of entries) {
    const producer = creators.get(String(entry.args.tabRef));
    // A uid-targeted policy carries its registered tab; everything else uses the requested tab.
    const policyTab = entry.policy?.kind === "target" ? entry.policy.tabId : undefined;
    const lane = entry.policy?.kind === "create" ? entry : producer || policyTab || entry.args.tabId;
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
    if (entry.policy?.kind === "target" && (policyTab != null || entry.args.tabId != null)) windowAnchor = entry.item;
  }
  const parent = (entry: Entry) => creators.get(String(entry.args.tabRef));
  const validResult = (entry: Entry, result: unknown, isError: boolean) => {
    const value = record(result), id = value.tabId ?? value.id;
    return entry.policy?.kind === "create" && !entry.error && !isError && !value.error && !value.incomplete
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
      const tabId = executed.get(producer)?.id;
      if (!tabId) throw error("dependency_failed", entry.args.tabRef);
      const { tabRef: _ref, ...args } = entry.args;
      return { ...args, tabId };
    },
    complete(item: T, result: unknown, isError: boolean) {
      const entry = byItem.get(item)!, id = validResult(entry, result, isError);
      if (id) executed.set(entry, { id, result });
    },
    assertDependenciesCommitted(item: T) {
      const entry = byItem.get(item)!;
      if (!entry.error && entry.args.tabRef != null && !published.has(parent(entry)!)) throw error("dependency_failed", entry.args.tabRef);
    },
    settle(item: T, result: unknown, isError: boolean) {
      const entry = byItem.get(item)!, id = validResult(entry, result, isError);
      if (entry.policy?.kind === "create") committedCreators.add(entry);
      if (id) published.set(entry, id);
    },
  };
}

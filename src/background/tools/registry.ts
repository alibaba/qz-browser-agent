import { getCoreToolMetadata, toolIdentity } from "../../shared/tools/tool-metadata.js";
import type { ToolDefinition, ToolSchema } from "../../shared/contracts/tool.js";
import type { RegisterTool, ToolContext } from "../../sdk/background.js";
import { t } from "./messages.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { materializeContribution as materialize } from "../../shared/capabilities.js";

type RuntimeDefinition = ToolDefinition<ToolSchema, unknown, ToolContext, AbortSignal>;
export type RegisteredTool = RuntimeDefinition & ReturnType<typeof toolIdentity> & {
  source: "core";
  runtime: "core";
  profileFamily: string;
  resultFamily: string;
  labelerId: string;
  pageContext: boolean;
  detailLayout: string;
  mediaPresentation: string;
  schema: { type: "function"; function: { name: string; description: string; parameters: ToolSchema } };
};

export function withCommonToolParameters(parameters: ToolSchema): ToolSchema {
  const next: ToolSchema & { properties: Record<string, import("../../shared/contracts/tool.js").ToolParameter> } = { ...parameters, properties: { ...parameters.properties } };
  if (next["x-disableCommonTimeout"] === true) delete next["x-disableCommonTimeout"];
  else if (!next.properties.timeout) next.properties.timeout = { type: "number", description: t("timeout") };
  return next;
}

export interface CoreToolSnapshot {
  readonly language: string;
  get(name: string): RegisteredTool | undefined;
  entries(): IterableIterator<[string, RegisteredTool]>;
}
const trustedSnapshots = new WeakSet<object>();
export function isCoreToolSnapshot(value: unknown): value is CoreToolSnapshot {
  return Boolean(value && typeof value === "object" && trustedSnapshots.has(value));
}

/** Capture static policy and handler references now, leaving only authored getters unevaluated. */
function captureDeclaration<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => captureDeclaration(item))) as T;
  if (!value || typeof value !== "object") return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) descriptor.value = captureDeclaration(descriptor.value);
  }
  return Object.freeze(Object.create(Object.getPrototypeOf(value), descriptors)) as T;
}

/** Handlers register once; language-scoped snapshots contain only materialized declarations. */
export function createToolRegistry() {
  type Declaration = { owner: string; replaces?: string; definition: RuntimeDefinition };
  const definitions = new Map<string, { original?: Declaration; replacement?: Declaration }>();
  const snapshots = new Map<string, CoreToolSnapshot>();
  const forCapability = (owner: string): RegisterTool => {
    if (!owner || owner.trim() !== owner || /[\s/\\]/.test(owner)) throw new TypeError(`Invalid tool owner: ${owner}`);
    return definition => {
      const { name, parameters, execute } = definition;
      if (typeof name !== "string" || !name.trim() || name.trim() !== name || /[\s/\\]/.test(name) || typeof execute !== "function" || parameters?.type !== "object") {
        throw new TypeError("Tool definitions require a name, object schema, and executable handler");
      }
      const replaces = definition.replaces;
      if (replaces !== undefined && (typeof replaces !== "string" ||
          !/^[^\s/\\]+\/[^\s/\\]+$/.test(replaces) || replaces.split("/")[1] !== name || replaces === `${owner}/${name}`)) {
        throw new TypeError(`Tool ${owner}/${name}: replaces must target another capability's same tool name`);
      }
      const slot = replaces === undefined ? "original" : "replacement";
      const candidates = definitions.get(name) || {};
      const previous = candidates[slot];
      if (previous) throw new Error(`${slot === "original" ? "Duplicate tool definition" : "Conflicting tool replacements"}: ${name} (${previous.owner}/${name}, ${owner}/${name})`);
      if (definition.model?.noImages?.omitParameters?.some(field => parameters.required?.includes(field))) {
        throw new TypeError(`Tool ${name}: noImages may only omit optional parameters`);
      }
      // Keep getters until a run selects its language. No capability setup is replayed.
      candidates[slot] = { owner, replaces, definition: captureDeclaration(definition) as RuntimeDefinition };
      definitions.set(name, candidates);
      snapshots.clear();
    };
  };
  // Resolve only after collecting declarations: discovery order never selects a winner.
  const resolveDefinitions = () => new Map([...definitions].map(([name, { original, replacement }]) => {
    if (replacement && (!original || replacement.replaces !== `${original.owner}/${name}`)) {
      throw new Error(`Tool ${replacement.owner}/${name}: replacement target ${replacement.replaces} not found${original ? ` (available: ${original.owner}/${name})` : ""}`);
    }
    const selected = replacement || original;
    if (!selected) throw new Error(`Missing tool definition: ${name}`);
    return [name, selected.definition];
  }));
  const defineTool = forCapability("<host>");
  const snapshot = (language = getLanguage()): CoreToolSnapshot => {
    const previous = snapshots.get(language);
    if (previous) return previous;
    const localized = withLanguage(language, () => new Map([...resolveDefinitions()].map(([name, definition]) => {
        const runtime = materialize(definition);
        const { description, parameters } = runtime;
        const normalizedParameters = withCommonToolParameters(parameters);
        if (runtime.model?.noImages?.omitParameters?.some(field => normalizedParameters.required?.includes(field))) {
          throw new TypeError(`Tool ${name}: noImages may only omit optional parameters`);
        }
        // The host resolves tabRef before strict numeric runtime validation. Legacy tabId stays input-compatible.
        const modelParameters = runtime.page && parameters.properties.tabId
          ? { ...normalizedParameters,
            properties: { ...Object.fromEntries(Object.entries(normalizedParameters.properties).filter(([key]) => key !== "tabId")),
              tabRef: { type: ["integer", "string"] as const, description: t("tabRef") } },
            ...(normalizedParameters.required ? { required: normalizedParameters.required.map(field => field === "tabId" ? "tabRef" : field) } : {}) }
          : normalizedParameters;
        const identity = toolIdentity({ name, title: runtime.title, familyId: runtime.familyId, rendererId: runtime.rendererId });
        const presentation = getCoreToolMetadata(identity.capabilityId);
        return [name, materialize({
          ...runtime,
          model: Object.freeze({ pageContext: presentation?.pageContext ? "working" : false, ...runtime.model }),
          behavior: runtime.behavior ? Object.freeze({ ...runtime.behavior }) : undefined,
          ...identity,
          profileFamily: presentation?.profileFamily || "",
          resultFamily: presentation?.resultFamily || "generic",
          labelerId: presentation?.labelerId || "static",
          pageContext: Boolean(presentation?.pageContext),
          detailLayout: presentation?.detailLayout || "detail",
          mediaPresentation: presentation?.mediaPresentation || "",
          source: "core",
          runtime: "core",
          hidden: definition.hidden === true,
          parameters: normalizedParameters,
          schema: { type: "function", function: { name, description: runtime.page && parameters.properties.tabId
            ? description.replace(/\btabId\b/g, "tabRef") : description, parameters: modelParameters } },
        } satisfies RegisteredTool)];
    })));
    const result: CoreToolSnapshot = Object.freeze({ language, get: (name: string) => localized.get(name), entries: () => localized.entries() });
    trustedSnapshots.add(result);
    snapshots.set(language, result);
    return result;
  };
  return Object.freeze({ defineTool, forCapability, validate: () => { resolveDefinitions(); }, snapshot,
    get: (name: string) => snapshot().get(name), entries: () => snapshot().entries() });
}

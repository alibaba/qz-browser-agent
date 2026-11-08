import { isToolFailure } from "../contracts/tool-error.js";
import contributions from "#capabilities/artifacts";
import { mergeCapabilityRecords } from "../capabilities.js";
import { explicitArtifactCandidates, type ToolArtifactAdapter } from "./artifact-projection.js";

type Fields = Record<string, unknown>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const adapters = mergeCapabilityRecords(contributions);

/** Pure result projection: artifacts describe resources, never authorize access to them. */
export function createToolArtifactProjector(entries: Readonly<Record<string, ToolArtifactAdapter>>) {
  const registry = Object.freeze(Object.fromEntries(Object.entries(entries).map(([id, entry]) => {
    if (entry.project !== undefined && typeof entry.project !== "function") throw new TypeError(`Invalid artifact projection: ${id}`);
    if (entry.normalize !== undefined && typeof entry.normalize !== "function") throw new TypeError(`Invalid artifact normalizer: ${id}`);
    return [id, Object.freeze({ ...entry })];
  })));
  const isIntermediate = (item: Fields, resolveIdentity: (name: string) => string = name => name) => {
    const source = resolveIdentity(String(item.sourceTool || item.toolName || ""));
    return item.stage === "intermediate" || registry[source]?.intermediate === true;
  };
  return {
    isIntermediate,
    project(name: string, args: unknown, result: unknown, consumer: "resource" | "context" | "display" = "context"): Fields[] {
      const output = record(result);
      if (isToolFailure(output)) return [];
      const explicit = explicitArtifactCandidates(output, { includeSingle: consumer === "context" })
        .map(item => {
          try { return { ...item, ...registry[name]?.normalize?.({ ...item }) }; }
          catch { return item; }
        })
        .filter(item => ["id", "artifactId", "fileId", "downloadId", "table", "filename", "title", "url", "fileUrl", "finalUrl"].some(key => item[key]) && !isIntermediate(item));
      // An explicit resource envelope is authoritative; legacy adapters only fill the missing envelope.
      if (consumer === "resource" && explicit.length) return explicit;
      let legacy: readonly Fields[] = [];
      try { legacy = registry[name]?.project?.(record(args), output, consumer) || []; }
      catch { /* A broken compatibility adapter must not discard explicit artifacts or the tool result. */ }
      return [...explicit, ...(Array.isArray(legacy) ? legacy : [])]
        .filter(item => item && typeof item === "object" && !Array.isArray(item) && !isIntermediate(item));
    },
  };
}

const projector = createToolArtifactProjector(adapters);
export const projectToolArtifacts = projector.project;
export const isIntermediateArtifact = projector.isIntermediate;

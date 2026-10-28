import type { ToolBrowserPermission } from "../browser-permissions.js";

/** Cross-context schema and capability types; executable definitions bind only in their owning runtime. */
type ParameterType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
export interface ToolParameter {
  type?: ParameterType | readonly ParameterType[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  properties?: Readonly<Record<string, ToolParameter>>;
  items?: ToolParameter;
  required?: readonly string[];
  [annotation: string]: unknown;
}

export interface ToolSchema extends ToolParameter {
  type: "object";
  properties: Readonly<Record<string, ToolParameter>>;
}

type RequiredKeys<S> = S extends { required: readonly (infer K)[] } ? K : never;
type ParameterValue<S extends ToolParameter> =
  S extends { enum: readonly (infer V)[] } ? V :
  ValueForType<S["type"] extends readonly ParameterType[] ? S["type"][number] : S["type"], S>;
type ValueForType<T, S extends ToolParameter> =
  T extends "string" ? string :
  T extends "number" | "integer" ? number :
  T extends "boolean" ? boolean :
  T extends "null" ? null :
  T extends "array" ? S extends { items: infer I extends ToolParameter } ? ParameterValue<I>[] : unknown[] :
  T extends "object" ? S extends ToolSchema ? ToolArguments<S> : Record<string, unknown> : unknown;

export type ToolArguments<S extends ToolSchema> = {
  [K in keyof S["properties"]]?: ParameterValue<S["properties"][K]>;
} & {
  [K in Extract<RequiredKeys<S>, keyof S["properties"]>]-?: ParameterValue<S["properties"][K]>;
};

/** `tab` manages an owned tab without reading its document. */
export type ToolPageAccess = false | "owned" | "readOnly" | "tab";
export interface ToolTimeoutProfile { defaultMs: number; maxMs: number; graceMs?: number }
export type ToolTimeout = number | ToolTimeoutProfile;

export type ToolEffect =
  | { type: "skill.loaded"; name: string; displayName: string; hasPluginManifest: boolean }
  | { type: "skills.changed" }
  | { type: "context.siteChanged" }
  | { type: "context.goalRefresh"; action: string };

/** Trusted model-facing projection; never accepted from a Skill manifest or result payload. */
export interface ToolModelPolicy {
  noImages?: { description?: string; omitParameters?: readonly string[] };
  pageContext?: false | "working" | "explicit";
  pageUrlArgument?: string;
  omitArguments?: readonly string[];
  preserveResult?: boolean;
  imagePrompt?: string;
  projectResult?(result: unknown): unknown;
}

/** Derived from a trusted registration for one model response's tab dependency plan. */
export type ToolBatchTabPolicy =
  | { kind: "create"; parallel?: boolean }
  /** `tabId` is the resolved lane for uid-targeted calls: the tab the referenced elements belong to. */
  | { kind: "target"; implicit: boolean; observation: boolean; parallel?: boolean; tabId?: number }
  | { kind: "barrier" };

/** Build-time behavior only. External manifests and tool results cannot grant these roles. */
export interface ToolBehavior {
  /** Evaluated once during batch planning. True (or a thrown predicate) overrides parallel roles and waits for preceding commits. */
  barrier?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Pure observations eligible for bounded execution on distinct explicit tabs. */
  parallelRead?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Provisional creation; Session state is published at ordered Agent settlement. */
  parallelOpen?: boolean;
  /** Tab-local actions can overlap other lanes; implicit/global targets remain barriers. */
  parallelTab?: boolean;
  /**
   * Arguments that may carry element uid references beyond the singular `target`/`selector`/`root`
   * fields. A uid pins its registered tab: the runtime must not substitute the working tab for it,
   * and the batch planner schedules the call on the uids' shared tab. Return non-uid targets too
   * so mixed calls remain serialized. A throwing extractor falls back to the singular fields.
   */
  uidTargets?: (args: Readonly<Record<string, unknown>>) => readonly unknown[];
  /** Trusted hard-timeout fallback; the runtime owns cancellation and revalidation. */
  timeoutResult?: { kind: "read" | "action" | "navigation"; pending: string };
  /** Reject actions that may unload the page hosting a nested script. */
  mayUnloadPage?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Promote the tool's image into the enclosing script's latest observation. */
  nestedObservation?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Optional diagnostic channel; the runtime owns timeout fields and cancellation. */
  timeoutTrace?: string;
}

export interface ToolDefinition<S extends ToolSchema, Result, Context, Signal> {
  name: string;
  /** Explicit full replacement of <capability directory>/<same tool name>; resolved after registration. */
  replaces?: `${string}/${string}`;
  description: string;
  parameters: S;
  execute(args: ToolArguments<S> & { timeoutMs?: number }, signal: Signal | undefined, context: Context): Result | Promise<Result>;
  model?: Readonly<ToolModelPolicy>;
  behavior?: Readonly<ToolBehavior>;
  requires?: { browserPermission?: ToolBrowserPermission; images?: boolean; rootSession?: { code: string; message: string }; tools?: readonly string[] };
  /** Trusted tab lifecycle role; ordinary result payloads cannot grant ownership. */
  workingTab?: "created" | "clear" | "claim" | ((args: ToolArguments<S>) => "update" | "claim");
  effects?(args: ToolArguments<S>, result: Result): readonly ToolEffect[];
  /** Pure boundary checks may preserve domain-specific errors before schema validation. */
  validateArgs?(args: Record<string, unknown>): undefined;
  page?: ToolPageAccess | ((args: Record<string, unknown>) => ToolPageAccess);
  timeout?: ToolTimeout | ((args: ToolArguments<S>, name: string) => ToolTimeout);
  /** Compatibility for an established millisecond input alias; model schemas remain in seconds. */
  legacyTimeoutMs?: boolean | ((args: Record<string, unknown>) => boolean);
  /** Presentation identity travels with tool events; omitted values use shared metadata. */
  title?: string;
  familyId?: string;
  rendererId?: string;
  hidden?: boolean;
  /** Provider still requests these fields; their established runtime fallback is retained. */
  defaultableFields?: readonly (keyof S["properties"])[];
}

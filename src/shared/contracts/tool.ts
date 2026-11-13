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
  pageContext?: false | "explicit";
  pageUrlArgument?: string;
  omitArguments?: readonly string[];
  preserveResult?: boolean;
  /** Script-to-model receipt; internal callers retain the tool's existing return contract. */
  scriptResult?: 'value' | 'receipt';
  imagePrompt?: string;
  projectResult?(result: unknown): unknown;
}

/** Derived from a trusted registration for one model response's tab dependency plan. */
export type ToolBatchTabPolicy =
  | { kind: "create"; parallel?: boolean; targeted?: boolean; passive?: boolean; orchestration?: boolean }
  /** Passive event observation does not occupy the page's action lane. */
  | { kind: "observe" }
  /** Page-independent orchestration; its descendants acquire their own resource lanes. */
  | { kind: "script" }
  /** `tabId` is the resolved lane for uid-targeted calls: the tab the referenced elements belong to. */
  | { kind: "target"; implicit: boolean; observation: boolean; parallel?: boolean; tabId?: number; orchestration?: boolean }
  | { kind: "barrier" };

export interface ToolTimeoutResult { kind: "read" | "action" | "navigation"; pending: string }

/** Build-time behavior only. External manifests and tool results cannot grant these roles. */
export interface ToolBehavior {
  /** Host-selected script execution. Arguments are business data; child tools own resource access. */
  orchestration?: boolean;
  /** Retain page ordering while child tools own execution locks; the wrapper must not mutate pages. */
  delegatesExecution?: boolean;
  /** A passive event listener may overlap the action whose outcome it observes. */
  passiveWait?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Evaluated once during batch planning. True (or a thrown predicate) overrides parallel roles and waits for preceding commits. */
  barrier?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Prepare CSS targets using this lookup before execution; tools owning readiness leave it unset. */
  targetLookup?: "light" | "openShadow";
  /** Pure observations eligible for bounded execution on distinct explicit tabs. */
  parallelRead?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Provisional creation; Session state is published at ordered Agent settlement. */
  parallelOpen?: boolean;
  /** Tab-local actions can overlap other lanes; implicit/global targets remain barriers. */
  parallelTab?: boolean;
  /**
   * Arguments that may carry element uid references beyond the singular `target`/`selector`/`root`
   * fields. A uid pins its registered tab: the explicit page reference must agree with it,
   * and the batch planner schedules the call on the uids' shared tab. Return non-uid targets too
   * so mixed calls remain serialized. A throwing extractor falls back to the singular fields.
   */
  uidTargets?: (args: Readonly<Record<string, unknown>>) => readonly unknown[];
  /** Trusted hard-timeout fallback; the runtime owns cancellation and revalidation. */
  timeoutResult?: ToolTimeoutResult | ((args: Readonly<Record<string, unknown>>) => ToolTimeoutResult | undefined);
  /** The handler reports its dispatch and acknowledgement through context.operation. */
  reportsExecution?: boolean;
  /** Reject actions that may unload the page hosting a nested script. */
  mayUnloadPage?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
  /** Opens child pages while retaining the parent's execution context. */
  mayOpenPopup?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
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
  execute(args: ToolArguments<S> & { timeoutMs?: number } & ("tabRef" extends RequiredKeys<S> ? { tabId: number } : { tabId?: number }), signal: Signal | undefined, context: Context): Result | Promise<Result>;
  model?: Readonly<ToolModelPolicy>;
  behavior?: Readonly<ToolBehavior>;
  requires?: {
    browserPermission?: ToolBrowserPermission;
    /** Executes caller-supplied page code; the host obtains browser-specific permission before the deadline. */
    pageScript?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean);
    images?: boolean; rootSession?: { code: string; message: string }; tools?: readonly string[];
  };
  /** Trusted tab lifecycle role; ordinary result payloads cannot grant ownership. */
  tabLifecycle?: "created" | "clear" | "claim" | ((args: ToolArguments<S>) => "update" | "claim");
  effects?(args: ToolArguments<S>, result: Result): readonly ToolEffect[];
  /** Pure boundary checks may preserve domain-specific errors before schema validation. */
  validateArgs?(args: Record<string, unknown>): undefined;
  /** Input-only aliases; canonical fields win and only canonical names appear in the schema. */
  argumentAliases?: Readonly<Record<string, string>>;
  /** Hidden compatibility for retired enum values, normalized before validation. */
  argumentValueAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Hidden compatibility for retired argument shapes, rewritten to canonical fields after aliases. */
  compatArgs?(args: Record<string, unknown>): Record<string, unknown>;
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

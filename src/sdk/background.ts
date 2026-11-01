/** Background extension API. Runtime services are supplied by the owning host. */
import type { SkillActivationContext } from "../shared/skills/skill-manifest.js";
import type { ToolDefinition, ToolSchema } from "../shared/contracts/tool.js";
export type { ToolSchema, ToolArguments, ToolParameter } from "../shared/contracts/tool.js";

export type ToolExecutionPhase = "injection" | "readiness" | "extraction" | "cdp" | "measurement" | "normalization" | "postprocess";

export interface ToolContext extends SkillActivationContext {
  dynamicContext?: SkillActivationContext | null;
  skillExecution?: { plugin: import("../shared/skills/skill-manifest.js").SkillManifest; config?: Record<string, unknown> };
  sessionId?: string;
  runId?: string | null;
  /** Call-scoped cancellation, including the tool deadline. */
  signal?: AbortSignal;
  /** Observation execution preserves the working tab; ordered commit may select the observed tab. */
  preserveWorkingTab?: boolean;
  /** Trusted batch creators publish ownership and working-tab state only at ordered settlement. */
  deferCreatedTabSelection?: boolean;
  /** Stage tool-owned Session changes for the Agent's ordered commit cursor. */
  deferToolCommit?: boolean;
  /** Private parent result identity; a JSON copy carries no execution authority. */
  createdTabResult?: unknown;
  onToolUpdate?(event: Record<string, unknown>): void;
  /** Host-only execution permit for a new tab; never serialized into a tool result. */
  prepareCreatedTab?(tab: import("../shared/tab-utils.js").TabReference): Promise<ToolContext>;
  /** Publish an immutable completed stage for this call's existing hard deadline. */
  reportPartial?(result: Record<string, unknown>, pending: string): void;
  /** Opaque live invocation identity carried only by nested script transports. */
  toolExecutionId?: string;
  /** Call-local diagnostic accumulator. End the measurement in a finally block. */
  measurePhase?(phase: ToolExecutionPhase): () => void;
  /** Captured by the run. Registry references are in-memory capabilities, never wire data. */
  language?: string;
  toolRegistrySnapshot?: unknown;
  toolCallId?: string;
  workingTabId?: number | null;
  sourceWindowId?: number | null;
  runProfile?: ToolRunProfile | null;
  profile?: ToolRunProfile | null;
  [field: string]: unknown;
}

export interface RegisterTool {
  <const S extends ToolSchema, R>(definition: ToolDefinition<S, R, ToolContext, AbortSignal>): void;
}

export type ToolErrorConstructor = new (code: string, message: string, details?: Record<string, unknown>) => Error & { code: string; details: Record<string, unknown> };

export interface ToolRunProfile {
  platform?: { os?: string } | null; features?: { imageInput?: boolean; toolImages?: boolean; screenshots?: boolean };
  tools?: { disabled?: readonly string[] }; session?: { canManageSessions?: boolean; kind?: string }; model?: { id?: string };
}

import type { GetToolRuntimeDependencies, ToolSkillsRuntime, ModelService, SkillService } from "./background/services.js";
import type { PageNavigationHost, PreparedNavigation } from "../background/tools/page-navigation.js";
import type { PageState, Screenshot, ScreenshotOptions } from "../background/tools/page-observation.js";
import type { ElementReply, PagePoint } from "../shared/contracts/page-content.js";
import type { SecurityGuardrails, GuardrailDecision } from "../shared/security-guardrails.js";
import type { BrowserDebugger, CdpCommand, ElementAccess } from "./background/browser.js";
export type { PreparedNavigation } from "../background/tools/page-navigation.js";
export type { GetToolRuntimeDependencies, ToolRuntimeDependencies, ToolSkillsRuntime, ToolSkillSetting, ToolEvent, UserWaitRuntime } from "./background/services.js";
export type { ModelService, ModelRequestOptions } from "./background/services.js";
export type { ToolSessionCommands, UserWaitTarget, AutomationScheduleInput, AutomationSaveInput, GoalUpdateInput } from "./background/services.js";

type Fields = Record<string, unknown>;

export interface NetworkWatchOptions { networkMaxRecords?: number; resetNetwork?: boolean; allowPreNavigationBlank?: boolean }

/** Trusted capability ports. Run identity and mutable Session services remain caller-owned. */
export interface ToolExtensionAPI extends Omit<PageNavigationHost, "commitObservedPageNavigation"> {
  readonly registerTool: RegisterTool;
  readonly models: Readonly<ModelService>;
  readonly skills: Readonly<SkillService>;
  readonly ToolExecutionError: ToolErrorConstructor;
  readonly getToolRuntimeDependencies: GetToolRuntimeDependencies;
  readonly element: ElementAccess;
  getBookmarks(): typeof chrome.bookmarks;
  getHistory(): typeof chrome.history;
  readonly getSecurityGuardrails: () => Promise<SecurityGuardrails>;
  readonly matchBlockedUrl: (url?: unknown, guardrails?: unknown) => GuardrailDecision | null;
  readonly sendCdp: BrowserDebugger["sendCdp"];
  readonly withDebugger: BrowserDebugger["withDebugger"];
  /** Current package-provided page metadata; reads state without attaching or navigating. */
  readonly getPageContext: (tabId: number) => Readonly<Record<string, string | number | boolean>>;
  /** Inspect connection identity without attaching; release only this run's lease after failed setup. */
  readonly getDebuggerConnectionId: (tabId: number) => number | null;
  /** Current run owning an attached connection; null while retained without an active run. */
  readonly getDebuggerRun: (tabId: number) => { sessionId: string; runId: string; connectionId: number } | null;
  /** Retain configuration across runs; optional restore replays it after target loss, never after user detach. */
  readonly setDebuggerRetention: (tabId: number, retained: boolean, context: ToolContext,
    restore?: (send: CdpCommand) => Promise<void>) => void;
  readonly releaseDebugger: (tabId: number, context: ToolContext) => Promise<void>;
  readonly withTemporaryDebugger: BrowserDebugger["withTemporaryDebugger"];
  readonly evaluateCdpScript: BrowserDebugger["evaluateCdpScript"];
  readonly inspectServer: (server?: Record<string, unknown>, options?: { refresh?: boolean; signal?: AbortSignal | null; includeResources?: boolean; includePrompts?: boolean; limit?: number }) => Promise<Record<string, unknown> & { server: Record<string, unknown>; tools: { name: string }[] }>;
  readonly callServerTool: (server?: Record<string, unknown>, name?: string, args?: unknown, options?: { signal?: AbortSignal | null }) => Promise<Record<string, unknown>>;
  readonly listSkillMcpServers: (context?: ToolContext, options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  readonly listSkillMcpTools: (context?: ToolContext, options?: Record<string, unknown>) => Promise<{ tools: Record<string, unknown>[]; count: number; errors: Record<string, unknown>[] }>;
  clampLimit(value: unknown, min: number, max: number): number;
  clampNumber(value: unknown, min: number, max: number, fallback: number): number;
  secondsToMs(value?: unknown, fallback?: number): number;
  makeSessionTabTargetError(code: string, details: Fields): Error;
  assertTabAllowed(tabId: number, details: Fields): Promise<unknown>;
  assertPageUrlAccessible(url: string): Promise<void>;
  assertUrlAllowed(url: string, guardrails: SecurityGuardrails, details: Fields): void;
  sendToContent(tabId: number | undefined, action: string, args: Fields, context?: ToolContext): Promise<unknown>;
  getTabPageState(tabId: unknown): Promise<{ url: string; title: string }>;
  commitObservedPageNavigation(input: { pageBefore?: PageState; pageAfter?: PageState; prepared?: PreparedNavigation | null;
    guardrails?: Partial<SecurityGuardrails>; toolName?: string; tabId?: unknown }): object | null;
  clickPointReady(inspection: ElementReply): inspection is ElementReply & { clickablePoint: PagePoint };
  clickNotReadyResult(input: { target: string; selector: string; index: number; inspection: ElementReply;
    originalInspection: ElementReply; resolved: ElementReply | null }): unknown;
  captureTabScreenshot(tabId: number, options?: ScreenshotOptions, context?: ToolContext): Promise<Screenshot>;
  enablePreNavigationNetworkWatch(tabId: number, options: NetworkWatchOptions, context: ToolContext): Promise<unknown>;
  publishSkillRegistryChange(reason: string, details: Fields, refresh: NonNullable<ToolSkillsRuntime["refreshRegistry"]>): Promise<unknown>;
  summarizeToolArgsForTrace(value: unknown): string;
}

/** Optional host bridges have one provider; release callbacks run for every capability. */
export interface ToolExtensionRuntime {
  /** Called inside the tool's timeout, after target/guardrail checks, only for task-owned page access. */
  preparePage?(tabId: number, toolName: string, signal: AbortSignal | undefined, context: ToolContext): Promise<void>;
  /** Read-only live page metadata, also available on page-tool results. Must not perform IO. */
  describePage?(tabId: number): Readonly<Record<string, string | number | boolean>>;
  captureTabScreenshot?(tabId: number, options?: ScreenshotOptions, context?: ToolContext): Promise<Screenshot>;
  handleRuntimeMessage?(message: Fields): { ok: boolean; handled: boolean } | null;
  enablePreNavigationNetworkWatch?(tabId: number, options: Omit<NetworkWatchOptions, "allowPreNavigationBlank">, context: ToolContext): Promise<unknown>;
  releaseRun?(sessionId: string, runId: string): void;
}
export type ToolExtension = (host: ToolExtensionAPI) => ToolExtensionRuntime | void;

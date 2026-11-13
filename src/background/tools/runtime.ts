import { waitForPageCommit } from "./document-readiness.js";
import { firefoxExtension } from "../../shared/product-text.js";
import { createdTabResultId } from "../../shared/contracts/page-observation.js";
import { bindToolResultPresentation, getToolResultPresentation, toolFailurePresentation } from "../../shared/contracts/tool-result-presentation.js";
import { toolError, isToolFailure, pageErrorDetails, operationErrorDetails } from "../../shared/contracts/tool-error.js";
import { resolveTabReference, tabReferenceError } from "./tab-reference.js";
import { isTabAlias } from "../../shared/tab-reference.js";
import { t } from "../../shared/i18n/backend.js";
import { t as toolT } from "./messages.js";
import { runToolWithTimeout, type ToolPartialResult } from "./tool-timeout.js";
import { createToolOperation, withToolOperationFailure } from "./tool-operation.js";
import { readPartialPageState } from "./partial-page-state.js";
import { createToolPhaseTiming } from "./phase-timing.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { chat, getConfig, saveConfig, applyModelPreset, deleteModelPreset, listModels, listProviderSummaries } from "../llm/index.js";
import { createCapabilityChat } from "../llm/capability-chat.js";
import { setCurrentRuntimeConfig } from "../runtime-config.js";
import { listSkills, loadSkill, loadSkillByIdentity, saveSkill, updateSkill, deleteSkill, loadSkillResource, loadSkillScript } from "../skills/runtime.js";
import type { ToolContext } from "../../sdk/background.js";
import type { ToolRuntimeDependencies } from "../../sdk/background/services.js";
import type { ToolDefinition, ToolSchema, ToolParameter, ToolModelPolicy, ToolBatchTabPolicy, ToolTimeoutResult } from "../../shared/contracts/tool.js";
import type { RegisteredTool } from "./registry.js";
import type { SkillTool, SkillManifest } from "../../shared/skills/skill-manifest.js";
import { validateSkillOutput } from "../../shared/skills/skill-output-contract.js";
import { skillToolT } from "../skills/tool-messages.js";
import type { SkillRenderer } from "../../shared/skills/skill-renderers.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";
import type { CdpCommand } from "./cdp-runtime.js";
import type { ScreenshotOptions, PageState } from "./page-observation.js";
import type { ToolExtensionAPI, ToolExtensionRuntime, NetworkWatchOptions, PreparedNavigation } from "../../sdk/background.js";
import { withToolCallLifecycle } from "./call-lifecycle.js";
import contributions from "#capabilities/tools";
import type { ElementReply, PagePoint } from "../../shared/contracts/page-content.js";
type Fields = Record<string, unknown>;
type RuntimeTool = ToolDefinition<ToolSchema, unknown, ToolContext, AbortSignal> & ReturnType<typeof normalizeToolIdentity> & { source: "core" | "plugin"; plugin?: SkillManifest; selectionRenderer?: SkillRenderer; outputSchema?: SkillTool["outputSchema"] };
type ToolOptions = NonNullable<Parameters<typeof getSkillToolDefinition>[1]>;
type RuntimeContext = ToolContext & { [TOOL_RUNTIME_CONTEXT]?: ToolRuntimeDependencies };
const READ_ONLY_PAGE_ACCESS = Symbol("readOnlyPageAccess");
type PageReadAuthority = ToolRuntimeDependencies & { [READ_ONLY_PAGE_ACCESS]?: { tabId: number; executionId: string } };
type ToolPolicy = ReturnType<typeof normalizeToolPolicy>;
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(record(error).message || error);
const isRecord = (value: unknown): value is Fields => Boolean(value && typeof value === "object" && !Array.isArray(value));
import { consumeToolEffects, copyToolEffects, issueToolEffects } from "./effects.js";
export { consumeToolEffects } from "./effects.js";
import { summarizeToolArgsForTrace } from "./trace-summary.js";
import { createToolRegistry, isCoreToolSnapshot, withCommonToolParameters } from "./registry.js";
import { ensureToolBrowserPermission } from "./browser-permissions.js";
import { selectSkillResults } from "../skills/skill-selection.js";
import { assertHtmlPage, assertPageUrlAccessible } from "./page-access.js";
import { assertScriptPageLifecycle, toolBehaviorEnabled } from "./behavior.js";
import { toolSignature, isDriveToolDiscoverable } from "../mcp/external-drive.js";
/**
 * Definitions declare capabilities; this runtime owns permission, cancellation and effects.
 * Core, Skill and script bridges share this boundary instead of invoking raw handlers.
 */

import { ToolExecutionError, isMissingRequiredValue, validateToolSchema } from "./arguments.js";
import { DEFAULT_TOOL_TIMEOUT, documentHostTimeout, orchestrationTimeout, resolveTimeout, scriptTimeout } from "./timing.js";
import { formatTab, getEffectiveTabUrl, isPageTab, isPageTabUrl, isLocalFileUrl } from "../../shared/tab-utils.js";
import { getSecurityGuardrails, matchBlockedUrl } from "../../shared/security-guardrails.js";
import {
  enforceSiteOpenRateLimitForTool,
  enforceSiteOpenRateLimitForUrl,
  recordSiteOpenRateLimitForUrl,
  resolveUrlNavigationOpenRateLimit,
} from "../security-guardrails-runtime.js";
import {
  localizeToolFailureError,
  localizeToolFailurePayload,
} from "../../shared/tools/tool-error-localization.js";
import {
  toolIdentity as normalizeToolIdentity,
} from "../../shared/tools/tool-metadata.js";
import { toolIdentityEventFields } from "../../shared/tools/tool-identity.js";
import {
  diagnosticTrace,
  formatTraceFields,
  trace as toolTrace,
} from "../trace.js";
import {
  executeSkillTool,
  getActiveSkillToolSchemasSync,
  getSkillToolDefinition,
  getSkillToolParameters,
  getHostCoreToolTarget,
  isDocumentHostTool,
  isSkillPageTool,
  isSkillToolActive,
  listSkillMcpServers,
  listSkillMcpTools,
} from "../skills/skill-tool-runtime.js";
import { createCdpRuntime } from "./cdp-runtime.js";
import { confirmDebuggerReattach } from "./debugger-reattach.js";
import { createElementRuntime } from "./element-runtime.js";
import { callMcpServerTool, inspectMcpServer } from "../mcp/mcp-client.js";

// ---------------------------------------------------------------------------
// Content script messaging
// Ordinary reads install only the main frame. UID recovery retains all-frame
// initialization and validates its selected document again in element-runtime.
// ---------------------------------------------------------------------------

async function contentDeadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "Content initialization timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function withContentSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason || new ToolExecutionError("OPERATION_ABORTED", "Content initialization was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function ensureContentScript(tabId: number, force = false, context: ToolContext = {}) {
  const signal = context.signal;
  const finishPhase = context.measurePhase?.("injection");
  try {
    if (!force) {
      try {
        const response = record(await contentDeadline(chrome.tabs.sendMessage<Fields, unknown>(tabId, { action: "ping" }, { frameId: 0 }), 150));
        if (response?.ok === true && typeof response.contentType === "string" && response.elementRefs === 1) return response;
      } catch(_e) {
        // Inject the content script when it is missing.
      }
    }
    signal?.throwIfAborted();
    try {
      await withContentSignal(chrome.scripting.executeScript({
        target: force ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
        world: "ISOLATED",
        files: ["content/article-extractor.js", "content/content-script.js"],
        injectImmediately: true,
      }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (/cannot access|cannot be scripted|extensions gallery|missing host permission/i.test(errorMessage(error))) {
        throw new ToolExecutionError("PAGE_CONTENT_UNAVAILABLE", t("toolError.PAGE_CONTENT_UNAVAILABLE.message"));
      }
      throw error;
    }
    signal?.throwIfAborted();
    const response = record(await withContentSignal(chrome.tabs.sendMessage<Fields, unknown>(tabId, { action: "ping" }, { frameId: 0 }), signal));
    if (response?.ok !== true) {
      throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "Content script did not acknowledge ping", { tabRef: context.requestedTabRef });
    }
    return response;
  } finally {
    finishPhase?.();
  }
}

export async function sendToContent(tabId: number | undefined, action: string, params: Fields = {}, context: ToolContext = {}): Promise<unknown> {
  if (!tabId) {
    throw makeSessionTabTargetError("TAB_REF_REQUIRED", { toolName: action }, context);
  }
  await assertTabAllowedBySecurityGuardrails(tabId, { tabRef: context.requestedTabRef });
  assertHtmlPage((await getAvailableTab(tabId, context)).url);
  const presence = await ensureContentScript(tabId, false, context);
  assertHtmlPage(presence.url, presence.contentType);
  context.signal?.throwIfAborted();
  await assertTabAllowedBySecurityGuardrails(tabId, { tabRef: context.requestedTabRef });
  context.signal?.throwIfAborted();
  const finishPhase = context.measurePhase?.("extraction");
  try {
    const response = await withContentSignal(chrome.tabs.sendMessage<Fields, unknown>(tabId, { action, ...params }, { frameId: 0 }), context.signal);
    context.signal?.throwIfAborted();
    if (response == null) {
      throw new ToolExecutionError("EMPTY_CONTENT_RESPONSE", `Content script returned empty response for ${action}`, {
        action,
        tabRef: context.requestedTabRef,
      });
    }
    return response;
  } catch (err) {
    if (err instanceof ToolExecutionError) throw err;
    if (/no tab with id|invalid tab id|tab not found|tab was closed/i.test(errorMessage(err))) throw unavailableTabError(context);
    throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", `Content script ${action} failed: ${errorMessage(err)}`, {
      action,
      tabRef: context.requestedTabRef,
    });
  } finally {
    finishPhase?.();
  }
}

function unavailableTabError(context: ToolContext) {
  return Object.assign(new ToolExecutionError("SESSION_TAB_UNAVAILABLE", "The requested tab is no longer available.", {
    ...(context.requestedTabRef == null ? {} : { tabRef: context.requestedTabRef }),
  }), { hint: "Use list_tabs to choose an available tabRef, then retry." });
}

async function getAvailableTab(tabId: number, context: ToolContext) {
  try { return await chrome.tabs.get(tabId); }
  catch { throw unavailableTabError(context); }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const coreToolDefinitions = createToolRegistry();
export const defineTool = coreToolDefinitions.defineTool;
const TOOL_RUNTIME_CONTEXT = Symbol("qingzhou.toolRuntime");
const EMPTY_TOOL_RUNTIME_DEPENDENCIES: ToolRuntimeDependencies = Object.freeze({
  sessions: null,
  skills: null,
  skillSettings: null,
  skillNetwork: null,
  windowTarget: null,
  emit: null,
});

const URL_ARGUMENT_KEYS = new Set([
  "url",
  "urls",
  "href",
  "src",
  "sourceUrl",
  "targetUrl",
  "downloadUrl",
  "imageUrl",
  "pageUrl",
  "_pageUrl",
]);
const capabilityBridges: Omit<ToolExtensionRuntime, "releaseRun"> = {};
const capabilityRunCleanup: NonNullable<ToolExtensionRuntime["releaseRun"]>[] = [];

export function handleRunScriptInnerRuntimeMessage(message: Fields = {}) {
  return capabilityBridges.handleRuntimeMessage?.(message) || null;
}

export async function captureTabScreenshot(tabId: number, options: ScreenshotOptions = {}, context: ToolContext = {}) {
  if (!capabilityBridges.captureTabScreenshot) {
    throw new ToolExecutionError("MEDIA_RUNTIME_NOT_READY", "Media runtime is not initialized", { tabRef: context.requestedTabRef });
  }
  return await capabilityBridges.captureTabScreenshot(tabId, options, context);
}

interface DeferredToolState {
  toolName: string;
  context: ToolContext;
  authority: ToolRuntimeDependencies;
  tabId?: number;
  reservation?: object;
  settling?: boolean;
  commit(signal: AbortSignal): Promise<void>;
  discard(): Promise<void>;
}
const deferredToolStates = new WeakMap<object, DeferredToolState>();
/** Sidebar metadata travels separately from the model's business result. */
export function getToolResultPageContext(result: unknown): Fields {
  return { ...getToolResultPresentation(result) };
}

function deferredState(result: unknown, context: ToolContext) {
  const ticket = isRecord(result) ? deferredToolStates.get(result) : undefined;
  return ticket && ticket.context.sessionId === context.sessionId && ticket.context.runId === context.runId
    && ticket.authority === getToolRuntimeDependencies(context) ? ticket : undefined;
}
async function settleToolState(result: unknown, context: ToolContext, signal?: AbortSignal) {
  const ticket = deferredState(result, context);
  if (!ticket || ticket.settling || !isRecord(result)) return;
  ticket.settling = true;
  try {
    if (signal) {
      const runId = String(context.runId || "");
      if (signal.aborted || (runId && ticket.authority.sessions?.isRunCurrent?.(context.sessionId || "", runId) === false))
        throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before ordered commit");
      await ticket.commit(signal);
    }
  } catch (error) {
    throw withLanguage(ticket.context.language || getLanguage(), () => localizeToolFailureError(error, { toolName: ticket.toolName }));
  } finally { deferredToolStates.delete(result); await ticket.discard(); }
}
function withExecutionAuthority(context: ToolContext, authority: ToolRuntimeDependencies, reservation?: object, tabId?: number) {
  if (!authority.sessions?.resolveTargetTab) return withToolRuntimeContext(context, authority);
  const resolve = authority.sessions.resolveTargetTab.bind(authority.sessions);
  return withToolRuntimeContext(context, { ...authority, sessions: { ...authority.sessions,
    resolveTargetTab: async input => {
      const target = { ...input, ...(reservation && Number(input.tabId) === tabId ? { createdTabReservation: reservation } : {}) };
      if (!context.deferToolCommit) return resolve(target);
      const checked = await resolve({ ...target, checkOnly: true });
      // Staged calls publish at commit. Claim-on-use of an unclaimed target is the only preflight write,
      // matching unstaged calls; an owned target's page state still waits for the ordered commit.
      return input.checkOnly === false && checked?.ok && checked.claimRequired && !checked.readOnlyAccess
        ? resolve({ ...target, checkOnly: false }) : checked;
    },
  } });
}

export function createToolRuntime({
  invokeNestedTool,
  sessions = null,
  skills = null,
  skillSettings = null,
  skillNetwork = null,
  requestLocation,
  windowTarget = null,
  emit = null,
}: ToolRuntimeDependencies = {}) {
  const dependencies = Object.freeze({
    invokeNestedTool,
    requestLocation,
    sessions: sessions && typeof sessions === "object" ? sessions : null,
    skills: skills && typeof skills === "object" ? skills : null,
    skillSettings: skillSettings && typeof skillSettings === "object" ? skillSettings : null,
    skillNetwork: skillNetwork && typeof skillNetwork === "object" ? skillNetwork : null,
    windowTarget: windowTarget && typeof windowTarget === "object" ? windowTarget : null,
    emit: typeof emit === "function" ? emit : null,
  });
  return Object.freeze({
    snapshot: coreToolDefinitions.snapshot,
    getSchemas: getToolSchemas,
    getIdentity: getToolIdentity,
    getToolResultPageContext,
    getModelPolicy: (name: string, options: ToolOptions = {}) => resolveToolDefinition(name, options)?.model,
    hasUidElementTargets,
    element: elementRuntime,
    getParallelReadTab,
    getTabAliases: (sessionId: string) => sessions?.getTabAliases?.(sessionId) || {},
    getBatchTabPolicy(name: string, args: unknown, options: ToolOptions = {}) {
      const policy = getBatchTabPolicy(name, args, options);
      return policy?.kind === "create" && !policy.targeted && policy.parallel && (!sessions?.reserveCreatedTab || !sessions.commitCreatedTab || !sessions.discardCreatedTab || !sessions.resolveTargetTab)
        ? { ...policy, parallel: false } : policy;
    },
    commitToolResult: (result: unknown, signal: AbortSignal, context: ToolContext) =>
      settleToolState(result, withToolRuntimeContext(context, dependencies), signal),
    discardToolResult: (result: unknown, context: ToolContext) =>
      settleToolState(result, withToolRuntimeContext(context, dependencies)),
    consumeEffects: consumeToolEffects,
    resolveDefinition: resolveToolDefinition,
    execute(name: string, args: unknown, signal?: AbortSignal, context: ToolContext = {}) {
      return executeTool(name, args, signal, withToolRuntimeContext(context, dependencies));
    },
    sendToContent,
    handleRunScriptInnerRuntimeMessage,
  });
}

export function getToolRuntimeDependencies(context: RuntimeContext = {}): ToolRuntimeDependencies {
  return context?.[TOOL_RUNTIME_CONTEXT] || EMPTY_TOOL_RUNTIME_DEPENDENCIES;
}

function withToolRuntimeContext(context: RuntimeContext = {}, dependencies: ToolRuntimeDependencies = EMPTY_TOOL_RUNTIME_DEPENDENCIES) {
  if (context?.[TOOL_RUNTIME_CONTEXT] === dependencies) return context;
  const next = context && typeof context === "object" && !Array.isArray(context) ? { ...context } : {};
  Object.defineProperty(next, TOOL_RUNTIME_CONTEXT, {
    value: dependencies,
    enumerable: false,
    configurable: false,
  });
  return next;
}

function definitionExecutionContext(context: ToolContext, definition: RuntimeTool, args: Fields, dependencies: ToolRuntimeDependencies) {
  const tabId = Number(args.tabId);
  const authority: PageReadAuthority = { ...dependencies };
  if (resolvePageAccess(definition, args) === "readOnly" && Number.isInteger(tabId) && tabId > 0 && context.toolExecutionId) {
    authority[READ_ONLY_PAGE_ACCESS] = { tabId, executionId: context.toolExecutionId };
  }
  return withToolRuntimeContext(context, authority);
}

function hasReadOnlyPageAccess(tabId: number, context: ToolContext) {
  const grant = (getToolRuntimeDependencies(context) as PageReadAuthority)[READ_ONLY_PAGE_ACCESS];
  return grant?.tabId === tabId && grant.executionId === context.toolExecutionId;
}

export function resolveToolDefinition(name: string, options: ToolOptions = {}): RuntimeTool | null {
  const snapshot = isCoreToolSnapshot(options.toolRegistrySnapshot) ? options.toolRegistrySnapshot : coreToolDefinitions.snapshot(options.language);
  return withLanguage(snapshot.language, () => resolveLocalizedToolDefinition(name, options, snapshot));
}

function resolveLocalizedToolDefinition(name: string, options: ToolOptions, snapshot: ReturnType<typeof coreToolDefinitions.snapshot>): RuntimeTool | null {
  const runtimeName = String(name || "").trim();
  const coreTool = snapshot.get(runtimeName);
  if (coreTool) return coreTool;
  const entry = getSkillToolDefinition(runtimeName, options);
  if (!entry) return null;
  const hostDefinition = snapshot.get(getHostCoreToolTarget(entry.plugin, entry.tool));
  const scriptDefinition = entry.tool.runtime === "script" ? snapshot.get("run_script") : undefined;
  const renderer = entry.tool.renderer || entry.plugin.renderers.tools[entry.tool.name];
  const identity = normalizeToolIdentity({
    name: entry.tool.name,
    capabilityId: entry.tool.capabilityId,
    title: entry.tool.title,
    familyId: entry.tool.familyId,
    familyTitle: entry.tool.familyTitle,
    rendererId: entry.tool.rendererId,
  });
  return {
    ...entry.tool,
    ...identity,
    parameters: getSkillToolParameters(entry.tool),
    page: isSkillPageTool(entry.tool) ? "owned" : undefined,
    requires: { ...hostDefinition?.requires, ...(isSkillPageScriptTool(entry.tool) ? { pageScript: true } : {}) },
    model: entry.tool.runtime === "script" || entry.tool.runtime === "inner" || entry.tool.runtime === "page"
      ? { preserveResult: true, scriptResult: "receipt" } : hostDefinition?.model,
    // Only the host-selected script runner grants orchestration; old/privileged Skills retain their barrier.
    behavior: scriptDefinition?.behavior || { ...hostDefinition?.behavior, barrier: true },
    source: "plugin",
    plugin: entry.plugin,
    ...(renderer?.type === "selection" ? { selectionRenderer: renderer } : {}),
    validateArgs: args => {
      if (isDocumentHostTool(entry.tool)) documentHostTimeout(args, runtimeName);
      else if (scriptDefinition) orchestrationTimeout(args, runtimeName);
      else if (isSkillScriptTool(entry.tool)) (entry.tool.runtime === "host" ? scriptTimeout : orchestrationTimeout)(args, runtimeName);
      return hostDefinition?.validateArgs?.(args);
    },
    timeout: scriptDefinition ? orchestrationTimeout : isSkillPageScriptTool(entry.tool) ? 0 : isDocumentHostTool(entry.tool) ? documentHostTimeout : isSkillScriptTool(entry.tool) ? (entry.tool.runtime === "host" ? scriptTimeout : orchestrationTimeout) : DEFAULT_TOOL_TIMEOUT,
    legacyTimeoutMs: !isSkillScriptTool(entry.tool),
    execute: (args, signal, context) => executeSkillTool(name, args, signal, context,
      (nestedName, nestedArgs, nestedSignal, nestedContext = {}) => executeTool(
        nestedName, nestedArgs, nestedSignal,
        withToolRuntimeContext({ ...nestedContext, operation: undefined }, getToolRuntimeDependencies(context)),
      ),
      { skillSettings: getToolRuntimeDependencies(context).skillSettings },
    ),
  };
}

function isToolBarrier(definition: RuntimeTool, args: Fields): boolean {
  try {
    const policy = definition.behavior?.barrier;
    return typeof policy === "function" ? policy(args) !== false : policy === true;
  } catch { return true; }
}

export function getParallelReadTab(name: string, args: unknown, options: ToolOptions = {}): number | null {
  const definition = resolveToolDefinition(name, options), input = record(args);
  return !definition || isToolBarrier(definition, input) ? null : parallelReadTab(definition, input);
}

function canonicalToolArgs(definition: RuntimeTool, input: Fields): Fields {
  if (!definition.argumentAliases && !definition.argumentValueAliases) return input;
  const next = { ...input };
  for (const [alias, canonical] of Object.entries(definition.argumentAliases || {})) {
    if (!Object.hasOwn(next, canonical) && Object.hasOwn(next, alias)) next[canonical] = next[alias];
    delete next[alias];
  }
  for (const [field, aliases] of Object.entries(definition.argumentValueAliases || {})) {
    const value = next[field];
    if (typeof value === "string" && Object.hasOwn(aliases, value)) next[field] = aliases[value];
  }
  return next;
}

/** Keep non-uid targets too: mixed calls cannot safely use a single uid's tab lane. */
function elementTargetsOf(definition: RuntimeTool, input: Fields): unknown[] {
  if (definition.behavior?.orchestration) return [];
  input = canonicalToolArgs(definition, input);
  const values = ["target", "selector", "root"]
    .filter(key => definition.parameters.properties[key])
    .map(key => input[key])
    .filter(value => value != null && value !== "");
  try {
    const declared = definition.behavior?.uidTargets?.(input);
    if (Array.isArray(declared)) values.push(...declared);
  } catch { /* Singular fields remain available if a capability extractor fails. */ }
  return values.flat();
}

/** Whether a tool call's arguments reference an element uid in any declared target field. */
export function hasUidElementTargets(name: string, args: unknown, options: ToolOptions = {}): boolean {
  const definition = resolveToolDefinition(name, options);
  return Boolean(definition && elementTargetsOf(definition, record(args)).some(isUidElementTarget));
}

function isParallelReadGranted(definition: RuntimeTool, input: Fields): boolean {
  const policy = definition.behavior?.parallelRead;
  return (typeof policy === "function" ? policy(input) : policy) === true;
}

function parallelReadTab(definition: RuntimeTool, input: Fields): number | null {
  const tab = input.tabId;
  if (typeof tab !== "number" || !Number.isInteger(tab) || tab <= 0) return null;
  if (elementTargetsOf(definition, input).some(isUidElementTarget)) return null;
  return isParallelReadGranted(definition, input) ? tab : null;
}

export function getBatchTabPolicy(name: string, args: unknown, options: ToolOptions = {}): ToolBatchTabPolicy | null {
  const definition = resolveToolDefinition(name, options);
  if (!definition) return null;
  const input = canonicalToolArgs(definition, record(args)), barrier = isToolBarrier(definition, input);
  if (!barrier && definition.behavior?.orchestration) return { kind: "script" };
  const pageAccess = resolvePageAccess(definition, input);
  const passive = !barrier && toolBehaviorEnabled(definition.behavior?.passiveWait, input);
  const delegation = !barrier && !passive && definition.behavior?.delegatesExecution ? { orchestration: true } : {};
  if (definition.tabLifecycle === "created") return { kind: "create",
    ...(definition.behavior?.parallelOpen || pageAccess && definition.behavior?.parallelTab ? { parallel: !barrier } : {}),
    ...(pageAccess ? { targeted: true } : {}), ...(passive ? { passive: true } : {}), ...delegation };
  if (passive) return { kind: "observe" };
  const targets = pageAccess ? elementTargetsOf(definition, input) : [];
  if (targets.some(isUidElementTarget)) {
    // A uid pins its registered tab; the explicit page reference must agree with it.
    // Unknown or cross-tab uid sets keep the conservative commit barrier.
    const lane = elementRuntime.elementUidTabId(targets);
    if (lane == null) return { kind: "target", implicit: false, observation: false };
    return { kind: "target", implicit: false,
      observation: !barrier && isParallelReadGranted(definition, input),
      ...(definition.behavior?.parallelTab ? { parallel: !barrier } : {}),
      tabId: lane, ...delegation };
  }
  if (!(definition.parameters.properties.tabRef || definition.parameters.properties.tabId) || !pageAccess) {
    return barrier ? { kind: "barrier" } : null;
  }
  // Retain targeting metadata for tabRef even when the declaration disables parallel execution.
  return { kind: "target", implicit: input.tabId == null && !Object.hasOwn(input, "tabRef"),
    observation: !barrier && parallelReadTab(definition, { ...input, tabId: 1 }) !== null,
    ...(definition.behavior?.parallelTab ? { parallel: !barrier } : {}), ...delegation };
}

export function getToolIdentity(name: string, options: ToolOptions = {}) {
  const definition = resolveToolDefinition(name, options);
  return definition
    ? normalizeToolIdentity(definition)
    : normalizeToolIdentity({ name: String(name || "").trim() });
}

/** Return tool schemas for model requests. */
export function getToolSchemas(options: ToolOptions = {}) {
  const snapshot = isCoreToolSnapshot(options.toolRegistrySnapshot) ? options.toolRegistrySnapshot : coreToolDefinitions.snapshot(options.language);
  return withLanguage(snapshot.language, () => getLocalizedToolSchemas({ ...options, language: snapshot.language }, snapshot));
}

function listContextTools(context: ToolContext, names?: readonly string[], options?: { skillName: string }): { tools: Fields[] } {
  // Preview this load's activation without changing the caller's Session state.
  if (options) context = { ...context, loadedPluginSkillNames: [options.skillName] };
  const allowed = getToolSchemas(context).filter(schema => context.externalDrive !== true
    || isDriveToolDiscoverable(schema.function.name)).filter(schema => !options
      || getSkillToolDefinition(schema.function.name, context)?.plugin.skillName === options.skillName);
  if (names || options) {
    const index = new Map(allowed.map(schema => [schema.function.name, schema.function]));
    const requested = [...new Set(names ?? index.keys())];
    for (const name of requested) if (!index.has(name)) throw new ToolExecutionError("UNKNOWN_TOOL", `Unknown or unavailable tool: ${name}`, { name });
    return { tools: requested.map(name => {
      const outputSchema = getSkillToolDefinition(name, context)?.tool.outputSchema;
      return { ...index.get(name)!, ...(outputSchema !== undefined ? { outputSchema } : {}) };
    }) };
  }
  return { tools: allowed.map(schema => toolSignature(schema.function)) };
}

function getLocalizedToolSchemas(options: ToolOptions, snapshot: ReturnType<typeof coreToolDefinitions.snapshot>) {
  const policy = normalizeToolPolicy(options);
  const builtinSchemas = [...snapshot.entries()]
    .filter(([, tool]) => !tool.hidden)
    .filter(([name]) => isToolAllowedByPolicy(name, policy))
    .map(([, tool]) => adaptToolSchemaForPolicy(tool.model, tool.schema, policy));
  const skillSchemas = isToolAllowedByPolicy("run_script", policy)
    ? getActiveSkillToolSchemasSync(options)
      .filter(schema => schema?.function?.name && isToolAllowedByPolicy(schema.function.name, policy))
      .map(schema => adaptToolSchemaForPolicy(resolveToolDefinition(schema.function.name, options)?.model, {
        ...schema,
        function: {
          ...schema.function,
          parameters: withCommonToolParameters(schema.function.parameters || { type: "object", properties: {} }),
        },
      }, policy))
    : [];
  return [...builtinSchemas, ...skillSchemas];
}

/** The execution ABI uses numeric tabId after resolving the author/model's tabRef. */
function resolvedPageParameters(definition: RuntimeTool): ToolSchema {
  const parameters = definition.parameters;
  if (!definition.page || !parameters.properties.tabRef) return parameters;
  const { tabRef, ...properties } = parameters.properties;
  return {
    ...parameters,
    properties: { ...properties, tabId: { ...tabRef, type: "integer" } },
    ...(parameters.required ? { required: parameters.required.map(field => field === "tabRef" ? "tabId" : field) } : {}),
  };
}

/**
 * Validate before resolving targets: invalid input must not claim tabs or consume site limits.
 * Frozen definitions and the current run authorize execution; result fields cannot grant authority.
 */
export async function executeTool(name: string, args: unknown, signal?: AbortSignal, context: ToolContext = {}) {
  const startedAtMs = Date.now();
  const ownsOperation = !context.operation;
  const operation = context.operation ?? createToolOperation();
  const authority = getToolRuntimeDependencies(context);
  const parent = deferredState(context.createdTabResult, context);
  if (context.deferToolCommit || parent?.reservation) context = withExecutionAuthority(context, authority, parent?.reservation, parent?.tabId);
  let pending: { tabId: number; reservation: object } | undefined;
  let transferred = false;
  let aliasReservation: object | undefined;
  const discard = async () => {
    try { if (pending) await authority.sessions?.discardCreatedTab?.(pending.reservation); }
    finally { if (aliasReservation) authority.sessions?.discardTabAlias?.(aliasReservation); }
  };
  const commitAlias = (tabId: number, commitSignal?: AbortSignal) => {
    if (aliasReservation) authority.sessions!.commitTabAlias!({ sessionId: context.sessionId || "", runId: context.runId,
      signal: commitSignal, reservation: aliasReservation, tabId });
  };
  const timing = createToolPhaseTiming(name, context);
  const requestedTabRef = record(args).tabRef;
  const language = isCoreToolSnapshot(context.toolRegistrySnapshot) ? context.toolRegistrySnapshot.language : context.language || getLanguage();
  context = withToolRuntimeContext({ ...context, language, operation, measurePhase: timing.start,
    requestedTabRef: typeof requestedTabRef === "string" || typeof requestedTabRef === "number" ? requestedTabRef : undefined,
  }, getToolRuntimeDependencies(context));
  let effectiveArgs = record(args);
  let definition: RuntimeTool | null = null;
  let parameters: ToolSchema = { type: "object", properties: {} };
  const traceTool = shouldTraceDiagnosticTool(name);
  if (traceTool) {
    toolTrace(`[tool] start name=${name} source=${context?.source || "agent"} session=${context?.sessionId || ""} run=${context?.runId || ""} args=${summarizeToolArgsForTrace(args)}`);
  }
  try {
    const skillLookupOptions = { skillToolRegistrySnapshot: context.skillToolRegistrySnapshot, toolRegistrySnapshot: context.toolRegistrySnapshot, language: context.language };
    definition = resolveToolDefinition(name, skillLookupOptions);
    if (!definition && traceTool && context.skillToolRegistrySnapshot) {
      toolTrace(`[tool] plugin lookup miss name=${name}; frozen registry version=${record(context.skillToolRegistrySnapshot).version || 0}`);
    }
    if (!definition) throw new ToolExecutionError("UNKNOWN_TOOL", `Unknown tool: ${name}`, { name });
    if (definition.source === "plugin" && !isSkillToolActive(name, {
      context,
      dynamicContext: context.dynamicContext,
      loadedPluginSkillNames: context.loadedPluginSkillNames,
      skillToolRegistrySnapshot: context.skillToolRegistrySnapshot,
    })) {
      throw new ToolExecutionError("UNKNOWN_TOOL", `Unknown tool: ${name}`, { name });
    }
    assertToolAllowedByPolicy(name, normalizeToolPolicy(context));
    if (isRecord(args)) args = canonicalToolArgs(definition, args);
    if (!isRecord(args)) throw new ToolExecutionError("INVALID_ARGUMENTS", `Invalid arguments for ${name}: expected an object`);
    if (resolveTimeoutResult(definition, args)?.kind === "action") {
      operation.prepare({ ...operationErrorDetails(context, args), tool: name });
    }
    if (resolvePageAccess(definition, args) && !Object.hasOwn(args, "tabRef") && args.tabId == null) {
      throw makeSessionTabTargetError("TAB_REF_REQUIRED", { toolName: name }, context);
    }
    parameters = resolvedPageParameters(definition);
    if (!definition.behavior?.orchestration && Object.hasOwn(record(args), "tabRef")) {
      const { tabRef, ...input } = record(args);
      const tabId = parent?.reservation && parent.tabId === input.tabId && record(context.createdTabResult).tabRef === tabRef
        ? parent.tabId : resolveTabReference(tabRef, authority.sessions?.getTabAliases?.(context.sessionId || "") || {}, language);
      if (input.tabId != null && input.tabId !== tabId) throw tabReferenceError("conflicting_target", tabRef, language);
      // A reference is valid independently of whether this call uses a page.
      args = resolvePageAccess(definition, { ...input, tabId }) ? { ...input, tabId } : input;
    }
    const uidTargets = elementTargetsOf(definition, record(args)).filter(isUidElementTarget);
    uidTargets.forEach(target => elementRuntime.assertKnownElementUid(target));
    if (record(args).tabId != null && uidTargets.some(target => {
      const tabId = elementRuntime.elementUidTabId([target]);
      return tabId != null && tabId !== record(args).tabId;
    })) {
      throw tabReferenceError("conflicting_target", context.requestedTabRef, language);
    }
    if (!definition.behavior?.orchestration && record(args).tabAlias != null && (definition.tabLifecycle !== "created" || !isTabAlias(record(args).tabAlias))) {
      throw tabReferenceError("invalid_alias", record(args).tabAlias, language);
    }
    effectiveArgs = record(args);
    const acceptsTimeoutAlias = typeof definition.legacyTimeoutMs === "function"
      ? definition.legacyTimeoutMs(effectiveArgs) : definition.legacyTimeoutMs;
    effectiveArgs = record(withTimeoutAliases(effectiveArgs, acceptsTimeoutAlias));
    const { tabId: resolvedTabId, ...publicArgs } = effectiveArgs;
    let validationArgs = !definition.behavior?.orchestration && definition.parameters.properties.tabRef && resolvedTabId != null
      ? { ...publicArgs, tabRef: requestedTabRef ?? resolvedTabId } : effectiveArgs;
    if (acceptsTimeoutAlias && !definition.parameters.properties.timeoutMs) {
      const { timeoutMs, ...canonicalArgs } = validationArgs;
      validationArgs = canonicalArgs;
    }
    validateToolArgs(name, validationArgs, definition.parameters, definition.defaultableFields);
    const validateArgs = definition.validateArgs;
    if (validateArgs) withLanguage(language, () => validateArgs(effectiveArgs));
    validateToolSchema(name, validationArgs, definition.parameters);
    await assertToolAllowedForSession(definition, context);
    const executionArgs = await withSessionOwnedTarget(definition, effectiveArgs, parameters, context, signal,
      needsCommittedPage(definition, effectiveArgs));
    effectiveArgs = executionArgs;
    assertScriptPageLifecycle(definition, executionArgs, context);
    const securityGuardrails = await getSecurityGuardrails();
    await assertToolTargetAllowedBySecurityGuardrails(definition, executionArgs, context, securityGuardrails);
    if (definition.tabLifecycle === "created" && executionArgs.tabAlias != null) {
      if (!authority.sessions?.reserveTabAlias || !authority.sessions.commitTabAlias || !authority.sessions.discardTabAlias) {
        throw makeSessionTabTargetError("CDP_SESSION_RUNTIME_UNAVAILABLE", { toolName: name }, context);
      }
      aliasReservation = await authority.sessions.reserveTabAlias({ sessionId: context.sessionId || "", runId: context.runId,
        signal, alias: String(executionArgs.tabAlias) });
    }
    await enforceSiteOpenRateLimitForTool({
      name,
      args: executionArgs,
      guardrails: securityGuardrails,
      context,
      signal,
      emitUpdate: update => emitToolExecutionUpdate(name, executionArgs, update, context),
    });
    if (definition.requires?.browserPermission) {
      await ensureToolBrowserPermission(definition.requires.browserPermission, context, signal, getToolRuntimeDependencies(context));
    }
    if (firefoxExtension() && toolBehaviorEnabled(definition.requires?.pageScript, executionArgs)) {
      await ensureToolBrowserPermission("userScripts", context, signal, getToolRuntimeDependencies(context));
    }
    // A dismissed debugging bar pauses the run here, outside the tool timeout.
    await confirmRunReattach({ sessionId: String(context.sessionId || ""), runId: String(context.runId || ""), context, signal });
    const timeoutMs = resolveToolTimeoutMs(definition, executionArgs);
    if (traceTool) {
      toolTrace(`[tool] resolved name=${name} kind=${definition.source} capability=${definition.capabilityId} timeoutMs=${timeoutMs} executionArgs=${summarizeToolArgsForTrace(executionArgs)}`);
    }
    let result;
    const selectedDefinition = definition;
    const timeoutResult = resolveTimeoutResult(definition, executionArgs);
    try {
      result = await runToolWithTimeout(
        name,
        async (signal, reportPartial, deadlineAt) => {
          const args = executionArgs;
          const callContext = withToolRuntimeContext({ ...context, signal, reportPartial,
            deadlineAt: Math.min(deadlineAt, context.deadlineAt ?? Infinity),
            resultPresentation: context.resultPresentation ?? {} }, getToolRuntimeDependencies(context));
          const releaseDebuggerExecution = beginDebuggerExecution(callContext);
          try {
            if (context.deferCreatedTabSelection && selectedDefinition.source === "core" && selectedDefinition.behavior?.parallelOpen) {
              callContext.prepareCreatedTab = async tab => {
                const reserved = await authority.sessions?.reserveCreatedTab?.({ sessionId: context.sessionId || "", runId: context.runId, signal, tab });
                if (!reserved?.ok || !reserved.reservation) throw makeSessionTabTargetError(reserved?.code || "SESSION_TAB_UNAVAILABLE", {}, context);
                pending = { tabId: Number(tab.id), reservation: reserved.reservation };
                if (signal.aborted) { await discard(); throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted during tab creation"); }
                return withExecutionAuthority(callContext, authority, reserved.reservation, Number(tab.id));
              };
            }
            const pageAccess = resolvePageAccess(selectedDefinition, args);
            if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before tool execution");
            const policy = timeoutResult;
            if (policy?.kind === "action") reportPartial({}, policy.pending);
            if (policy?.kind === "read" && Number(args.tabId) > 0
              && !elementTargetsOf(selectedDefinition, args).some(isUidElementTarget)) {
              const tabId = Number(args.tabId);
              reportPartial({}, policy.pending);
            }
            if (needsCommittedPage(selectedDefinition, args) && !toolBehaviorEnabled(selectedDefinition.behavior?.passiveWait, args) && Number(args.tabId) > 0) {
              await waitForPageCommit(Number(args.tabId), callContext);
              // Firefox can report complete before its committed document finishes parsing.
              if (selectedDefinition.behavior?.targetLookup) {
                await elementRuntime.prepareCssTargets(Number(args.tabId), elementTargetsOf(selectedDefinition, args), {
                  index: parameters.properties.index ? Number(args.index) || 0 : 0,
                  includeShadow: selectedDefinition.behavior?.targetLookup === "openShadow",
                }, callContext);
              }
              // Revalidate even if the blank finished between admission and this wait.
              // It may have become a restricted page or lost its task ownership.
              Object.assign(args, await withSessionOwnedTarget(selectedDefinition, args, parameters, context, signal));
              await assertToolTargetAllowedBySecurityGuardrails(selectedDefinition, args, context);
            }
            if (pageAccess && pageAccess !== "tab" && args._readOnlyTabAccess !== true && Number(args.tabId) > 0) {
              await capabilityBridges.preparePage?.(Number(args.tabId), name, signal, callContext);
            }
            if (signal.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before tool execution");
            return await withToolCallLifecycle(callContext, async scoped => {
              const owned = authority.sessions?.listOwnedTabIds?.(String(scoped.sessionId || ""));
              const capture = (toolBehaviorEnabled(selectedDefinition.behavior?.mayUnloadPage, args)
                || toolBehaviorEnabled(selectedDefinition.behavior?.mayOpenPopup, args))
                && Number(args.tabId) > 0 && owned?.includes(Number(args.tabId))
                ? authority.sessions?.beginPopupCapture?.({ sessionId: String(scoped.sessionId || ""), runId: scoped.runId,
                  signal: scoped.signal, openerTabId: Number(args.tabId) }) : undefined;
              scoped.invokeTool = authority.invokeNestedTool
                ? (name, args, options) => authority.invokeNestedTool!({ ...scoped, operation: options?.operation }, name, args, options?.signal) : undefined;
              scoped.listTools = (names, options) => listContextTools(scoped, names, options);
              scoped.observedPopups = capture?.observed;
              try {
                if (policy?.kind === "action" && !selectedDefinition.behavior?.reportsExecution) operation.dispatch();
                return await selectedDefinition.execute(args, scoped.signal,
                definitionExecutionContext(scoped, selectedDefinition, args, getToolRuntimeDependencies(callContext))); }
              finally { capture?.dispose(); }
            });
          } finally { releaseDebuggerExecution(); }
        },
        signal,
        timeoutMs,
        async (partial, timeoutError) => {
          try { return await finishTimedOutTool(timeoutResult, partial, signal, language, timeoutError, context, inferToolPageId(selectedDefinition, executionArgs) || undefined); }
          catch (error) {
            if (selectedDefinition.tabLifecycle === "created" && Number(createdTabResultId(partial.result) ?? partial.result.tabRef ?? partial.result.tabId) > 0) {
              try { await chrome.tabs.remove(Number(createdTabResultId(partial.result) ?? partial.result.tabRef ?? partial.result.tabId)); } catch { /* Already closed. */ }
            }
            throw error;
          }
        },
        context,
        definition.behavior?.timeoutTrace,
        executionArgs,
      );
    } catch (err) {
      await rememberToolPageContext(definition, executionArgs, err);
      throw err;
    }
    if (definition.selectionRenderer) {
      result = await selectSkillResults(definition.selectionRenderer, result, signal, context,
        (nestedName, nestedArgs, nestedSignal, nestedContext) => executeTool(nestedName, nestedArgs, nestedSignal,
          withToolRuntimeContext({ ...nestedContext, operation: undefined }, getToolRuntimeDependencies(context))));
    }
    if (definition.outputSchema !== undefined && !isToolFailure(result)) {
      // Validate the final caller value, including any completed human selection.
      const value = definition.model?.scriptResult === "receipt" ? record(result).result ?? null : result;
      const issues = validateSkillOutput(definition.outputSchema, value);
      if (issues.length) {
        operation.confirm();
        const presentation = toolFailurePresentation(result, context.resultPresentation);
        if (context.resultPresentation) Object.assign(context.resultPresentation, presentation);
        result = bindToolResultPresentation(toolError("SKILL_OUTPUT_INVALID",
          withLanguage(language, () => skillToolT("outputMismatch", { name })), {
            details: { tool: name, issues, executed: true, automaticReplay: false },
          }), presentation);
      }
    }
    const finishPostprocess = context.measurePhase?.("postprocess");
    try {
      const localizedResult = copyToolEffects(result, withLanguage(language, () => {
        const localized = localizeToolFailurePayload(result, { toolName: name });
        return isToolFailure(localized) ? withToolOperationFailure(localized, operation) : localized;
      }));
      await rememberToolPageContext(definition, executionArgs, localizedResult);
      if (!signal?.aborted && !isToolFailure(localizedResult)) {
        issueToolEffects(localizedResult, definition.effects?.(executionArgs, localizedResult) || [], context);
        if (context.deferToolCommit && definition.source === "core" && isRecord(localizedResult)) {
          const selected = definition;
          deferredToolStates.set(localizedResult, { toolName: name, context, authority, ...pending, discard,
            async commit(commitSignal) {
              if (pending) {
                await assertTabAllowedBySecurityGuardrails(pending.tabId, { tabRef: context.requestedTabRef });
                const committed = await authority.sessions?.commitCreatedTab?.({ sessionId: context.sessionId || "", runId: context.runId,
                  signal: commitSignal, reservation: pending.reservation });
                if (!committed?.ok) throw makeSessionTabTargetError(committed?.code || "SESSION_TAB_UNAVAILABLE", { toolName: name }, context);
              } else await recordToolPage(selected, executionArgs, localizedResult,
                withToolRuntimeContext({ ...context, preserveWorkingTab: false }, authority), commitSignal);
              commitAlias(Number(createdTabResultId(localizedResult) ?? record(localizedResult).tabRef ?? record(localizedResult).tabId ?? record(localizedResult).id), commitSignal);
            },
          });
          transferred = true;
        } else {
          await recordToolPage(definition, executionArgs, localizedResult, context, signal);
          commitAlias(Number(createdTabResultId(localizedResult) ?? record(localizedResult).tabRef ?? record(localizedResult).tabId ?? record(localizedResult).id), signal);
        }
      }
      if (traceTool) {
        const ok = !isToolFailure(localizedResult);
        toolTrace(`[tool] done name=${name} ok=${ok ? 1 : 0} durationMs=${Date.now() - startedAtMs} result=${summarizeToolArgsForTrace(localizedResult)}`);
      }
      return localizedResult;
    } finally { finishPostprocess?.(); }
  } catch (err) {
    attachToolRetryContext(err, definition?.parameters || parameters, { ...effectiveArgs, tabRef: context.requestedTabRef });
    const localized = withToolOperationFailure(withLanguage(language, () => localizeToolFailureError(err, { toolName: name })), operation);
    if (traceTool) {
      toolTrace(`[tool] error name=${name} code=${record(localized).code || record(err).code || ""} label=${record(localized).codeLabel || ""} message=${record(localized).message || record(err).message || err} durationMs=${Date.now() - startedAtMs} details=${summarizeToolArgsForTrace(record(localized).details || record(err).details || {})}`);
    }
    throw localized;
  } finally {
    if (ownsOperation) operation.close();
    try { if (!transferred) await discard(); } finally { timing.finish(); }
  }
}

function emitToolExecutionUpdate(name: string, args: unknown = {}, update: Fields = {}, context: ToolContext = {}) {
  const sink = typeof context.onToolUpdate === "function" ? context.onToolUpdate as (event: Fields) => void : getToolRuntimeDependencies(context).emit;
  if (typeof sink !== "function") return false;
  const toolCallId = String(context?.toolCallId || "").trim();
  const spanId = String(context?.spanId || "").trim();
  if (!toolCallId || !spanId) return false;
  const identity = getToolIdentity(name, { skillToolRegistrySnapshot: context.skillToolRegistrySnapshot, toolRegistrySnapshot: context.toolRegistrySnapshot, language: context.language });
  const rateLimit = update?.match && typeof update.match === "object"
    ? {
        host: record(update.match).host || update.host || "",
        type: record(update.match).type || record(update.match).matchType || "",
        value: record(update.match).value || "",
        domain: record(update.match).domain || undefined,
        pattern: record(update.match).pattern || undefined,
        minOpenIntervalMs: Number(update.minOpenIntervalMs || record(update.match).minOpenIntervalMs || 0),
        waitMs: Number(update.waitMs || 0),
        nextIntervalMs: Number(update.nextIntervalMs || 0),
        activeSessions: Number(update.activeSessions || 0),
        queuedRequests: Number(update.queuedRequests || 0),
      }
    : {
        host: update.host || "",
        minOpenIntervalMs: Number(update.minOpenIntervalMs || 0),
        waitMs: Number(update.waitMs || 0),
        nextIntervalMs: Number(update.nextIntervalMs || 0),
      };
  try {
    sink({
      type: "tool_execution_update",
      sessionId: context.sessionId || "",
      runId: context.runId || "",
      spanId,
      toolCallId,
      toolName: name,
      ...toolIdentityEventFields(identity),
      args,
      phase: update.phase || "running",
      statusText: update.statusText || "",
      rateLimit,
    });
    return true;
  } catch (_err) {
    return false;
  }
}

async function publishSkillRegistryChange(reason: string, details: Fields, refreshRegistry: NonNullable<NonNullable<ToolRuntimeDependencies["skills"]>["refreshRegistry"]>) {
  const startedAt = Date.now();
  toolTrace(`[skill] registry publish start reason=${reason} details=${summarizeToolArgsForTrace(details)}`);
  try {
    const skillToolRegistry = await refreshRegistry(reason, details);
    toolTrace(`[skill] registry publish done reason=${reason} version=${record(skillToolRegistry).version || ""} durationMs=${Date.now() - startedAt}`);
    return skillToolRegistry;
  } catch (err) {
    toolTrace(`[skill] registry publish error reason=${reason} code=${record(err).code || ""} message=${record(err).message || err} durationMs=${Date.now() - startedAt}`);
    throw err;
  }
}


function shouldTraceDiagnosticTool(name = "") {
  const value = String(name || "");
  return value === "manage_skill"
    || value === "load_skill"
    || value === "load_skill_resource"
    || value.includes("skill")
    || value.includes("plugin")
    || value.includes("qingzhou_skill_author");
}

function normalizeToolPolicy(options: ToolContext = {}) {
  const profile = options.runProfile || options.profile || null;
  const disabled = new Set(Array.isArray(profile?.tools?.disabled) ? profile.tools.disabled : []);
  const restrictedSession = profile?.session?.canManageSessions === false || options?.canManageSessions === false;
  const imagesUnavailable = profile?.features?.screenshots === false || profile?.features?.imageInput === false;
  for (const [name, tool] of coreToolDefinitions.entries()) {
    if ((restrictedSession && tool.requires?.rootSession) || (imagesUnavailable && tool.requires?.images)) disabled.add(name);
  }
  // Disabled prerequisites propagate independent of registrar ordering.
  let previousSize;
  do {
    previousSize = disabled.size;
    for (const [name, tool] of coreToolDefinitions.entries()) {
      if (tool.requires?.tools?.some(dependency => disabled.has(dependency))) disabled.add(name);
    }
  } while (disabled.size !== previousSize);
  return {
    profile,
    disabled,
    vision: profile?.features?.imageInput !== false,
  };
}

function isToolAllowedByPolicy(name: string, policy: ToolPolicy) {
  return !policy.disabled.has(name);
}

function assertToolAllowedByPolicy(name: string, policy: ToolPolicy) {
  if (isToolAllowedByPolicy(name, policy)) return;
  throw new ToolExecutionError(
    "TOOL_FORBIDDEN_BY_RUN_PROFILE",
    `${name} is not available in the current run profile`,
    {
      tool: name,
      disabledTools: [...policy.disabled],
      model: policy.profile?.model?.id || "",
      sessionKind: policy.profile?.session?.kind || "",
      imageInput: policy.profile?.features?.imageInput,
    },
  );
}

function adaptToolSchemaForPolicy(model: ToolModelPolicy | undefined, schema: RegisteredTool["schema"], policy: ToolPolicy) {
  const noImages = model?.noImages;
  if (!noImages || policy.vision !== false) return schema;
  const cloned = structuredCloneSafe(schema);
  const params = cloned.function?.parameters;
  if (params?.properties && noImages.omitParameters?.length) {
    params.properties = Object.fromEntries(Object.entries(params.properties).filter(([key]) => !noImages.omitParameters!.includes(key)));
  }
  if (noImages.description) cloned.function.description = noImages.description;
  return cloned;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

async function assertToolTargetAllowedBySecurityGuardrails(definition: RuntimeTool, args: Fields = {}, context: ToolContext = {}, guardrails: SecurityGuardrails | null = null) {
  const name = definition.name;
  guardrails = guardrails || await getSecurityGuardrails();
  if (!hasSecurityGuardrailRules(guardrails)) return;

  for (const url of collectGuardrailCandidateUrls(args)) {
    assertUrlAllowedBySecurityGuardrails(url, guardrails, { tabRef: context.requestedTabRef });
  }

  if (!resolvePageAccess(definition, args) || resolvePageAccess(definition, args) === "tab") return;
  if (!shouldResolveSessionTabTarget(definition, args)) return;

  const tabIds = Array.isArray(args?.tabIds) ? args.tabIds : [];
  for (const item of tabIds) {
    const tabId = Number(item);
    if (Number.isFinite(tabId) && tabId > 0) {
      await assertTabAllowedBySecurityGuardrails(tabId, { tool: name, source: "tabIds" }, guardrails);
    }
  }

  const tabId = resolveGuardrailTargetTabId(args, context);
  if (tabId) await assertTabAllowedBySecurityGuardrails(tabId, { tool: name, source: "tab", tabRef: context.requestedTabRef }, guardrails);
}

function resolveGuardrailTargetTabId(args: Fields = {}, context: ToolContext = {}) {
  const explicit = Number(args?.tabId ?? args?._tabId);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return null;
}

function collectGuardrailCandidateUrls(value: unknown, key = "", out: string[] = [], depth = 0): string[] {
  if (depth > 4 || value == null) return out;
  if (typeof value === "string") {
    if (URL_ARGUMENT_KEYS.has(key) && /^https?:\/\//i.test(value.trim())) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectGuardrailCandidateUrls(item, key, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      collectGuardrailCandidateUrls(childValue, childKey, out, depth + 1);
    });
  }
  return out;
}

async function assertTabAllowedBySecurityGuardrails(tabId: number, details: Fields = {}, guardrails: SecurityGuardrails | null = null) {
  const rules = guardrails || await getSecurityGuardrails();
  let tab = null;
  try {
    tab = await chrome.tabs.get(Number(tabId));
  } catch (_err) {
    return null;
  }
  const url = getEffectiveTabUrl(tab);
  if (isLocalFileUrl(url)) await assertPageUrlAccessible(url);
  return assertUrlAllowedBySecurityGuardrails(url, rules, details);
}

function assertUrlAllowedBySecurityGuardrails(url: string, guardrails: unknown, details: Fields = {}) {
  const match = matchBlockedUrl(url, guardrails);
  if (!match) return null;
  throw makeSecurityGuardrailBlockedError(match, details);
}

function hasSecurityGuardrailRules(guardrails: Partial<SecurityGuardrails> = {}) {
  return Boolean(guardrails?.rules?.length || guardrails?.blockedDomains?.length || guardrails?.blockedPatterns?.length);
}

function makeSecurityGuardrailBlockedError(match: NonNullable<ReturnType<typeof matchBlockedUrl>>, details: Fields = {}) {
  const label = match.type === "pattern"
    ? t("security.matchPattern", { pattern: String(match.pattern) })
    : t("security.domainAndSubdomains", { domain: String(match.domain) });
  return new ToolExecutionError(
    "SECURITY_GUARDRAIL_BLOCKED",
    t("security.blockedLabel", { label: String(label) }),
    {
      ...(details.tabRef != null ? { tabRef: details.tabRef } : {}),
      blockedType: match.type || "domain",
      blockedDomain: match.domain || undefined,
      blockedPattern: match.pattern || undefined,
      host: match.host,
    },
  );
}

function withTimeoutAliases(args: unknown, acceptsAlias: boolean | undefined) {
  const input = isRecord(args) ? { ...args } : args;
  if (!isRecord(input)) return input;
  if (acceptsAlias && input.timeout == null && input.timeoutMs != null) input.timeout = Number(input.timeoutMs) / 1000;
  return input;
}

async function finishTimedOutTool(policy: ToolTimeoutResult | undefined, partial: ToolPartialResult, signal: AbortSignal | undefined, language: string, timeoutError: ToolExecutionError, context: ToolContext, selectedTabId?: number) {
  let result = partial.result;
  let pending = partial.pending;
  const kind = policy?.kind;
  if (kind === "action") return toolError(timeoutError.code, timeoutError.message, {
    details: { ...timeoutError.details, pending, ...context.operation?.snapshot(),
      ...(Array.isArray(result.trace) ? { trace: result.trace } : {}) },
  });
  const tabId = Number(selectedTabId || createdTabResultId(result) || result.tabRef || result.tabId || result.id);
  if (tabId > 0) {
    await assertTabAllowedBySecurityGuardrails(tabId, { tabRef: context.requestedTabRef });
    const before = record(result.pageState);
    const pageState = await readPartialPageState(tabId, before, context);
    await assertTabAllowedBySecurityGuardrails(tabId, { tabRef: context.requestedTabRef });
    const oldDocument = result.documentId || before.documentId;
    const changed = (oldDocument && pageState.documentId && oldDocument !== pageState.documentId)
      || (before.url && before.url !== pageState.url);
    if (changed && kind === "read") {
      result = {};
      pending = "current document content";
    }
    result = { ...result, pageState: { readyState: pageState.readyState, url: pageState.url, title: pageState.title, status: pageState.status, loading: pageState.loading, pendingUrl: pageState.pendingUrl } };
    if (kind === "navigation") result = { ...result, url: pageState.url, status: pageState.status, loading: pageState.loading };
  }
  if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while collecting timeout result");
  if (kind === "read") throw Object.assign(new ToolExecutionError(timeoutError.code, timeoutError.message, {
    ...timeoutError.details, ...pageErrorDetails(context), pending, pageState: result.pageState,
    ...(Array.isArray(partial.result.trace) ? { trace: partial.result.trace } : {}),
  }), { hint: withLanguage(language, () => toolT("readTimeout")) });
  // Only a fully validated successful screenshot can grant coordinates.
  if (result._image) {
    const { screenshotId: _id, coordinateSpace: _coordinates, ...observation } = result;
    result = { ...observation, actionable: false };
  }
  return copyToolEffects(partial.result, { ...result, incomplete: { reason: "timeout", pending } });
}

function resolveTimeoutResult(definition: RuntimeTool, args: Fields): ToolTimeoutResult | undefined {
  const policy = definition.behavior?.timeoutResult;
  return typeof policy === "function" ? policy(args) : policy;
}

function resolveToolTimeoutMs(definition: RuntimeTool, args: Fields = {}) {
  const policy = typeof definition.timeout === "function" ? definition.timeout(args, definition.name) : definition.timeout ?? DEFAULT_TOOL_TIMEOUT;
  return resolveTimeout(policy, args);
}

function isSkillPageScriptTool(pluginTool: SkillTool) {
  if (!isSkillScriptTool(pluginTool)) return false;
  const tool = pluginTool;
  const runtime = tool.runtime || "page";
  return runtime === "page" && tool.needsPage !== false;
}

function isSkillScriptTool(pluginTool: SkillTool) {
  const tool = pluginTool;
  if (!tool) return false;
  const runtime = tool.runtime || "page";
  return Boolean(tool.script) && runtime !== "mcp";
}

function secondsToMs(value: unknown, fallbackMs = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallbackMs;
  return Math.max(0, Math.floor(n * 1000));
}





async function assertToolAllowedForSession(definition: RuntimeTool, context: ToolContext = {}) {
  const restriction = definition.requires?.rootSession;
  if (!restriction) return;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (!sessionId || typeof sessions?.canManageSessions !== "function") return;
  const allowed = await sessions.canManageSessions(sessionId);
  if (allowed === false) {
    throw new ToolExecutionError(restriction.code, restriction.message);
  }
}

function resolvePageAccess(definition: RuntimeTool, args: Fields) {
  return typeof definition.page === "function" ? definition.page(args) : definition.page || false;
}

function needsCommittedPage(definition: RuntimeTool, args: Fields) {
  const access = resolvePageAccess(definition, args);
  return shouldResolveSessionTabTarget(definition, args)
    && (access === "readOnly" || (access === "owned" && (resolveTimeoutResult(definition, args)?.kind === "read"
      || (Boolean(definition.behavior?.targetLookup) && elementTargetsOf(definition, args).some(target => !isUidElementTarget(target))))));
}

function shouldResolveSessionTabTarget(definition: RuntimeTool, args: Fields = {}) {
  const targets = elementTargetsOf(definition, args);
  // UID resolution validates each registered element. Mixed calls also validate
  // the explicitly requested page for their CSS targets.
  return Boolean(resolvePageAccess(definition, args))
    && (!targets.some(isUidElementTarget) || targets.some(target => !isUidElementTarget(target)));
}

async function withSessionOwnedTarget(definition: RuntimeTool, args: Fields, _parameters: ToolSchema, context: ToolContext = {}, signal?: AbortSignal, allowLoadingBlank = false): Promise<Fields> {
  const toolName = definition.name;
  const input = { ...args };
  if (!shouldResolveSessionTabTarget(definition, input)) return input;

  const hasUidTargets = elementTargetsOf(definition, input).some(isUidElementTarget);
  const explicitTabId = Number(input.tabId ?? (hasUidTargets ? undefined : input._tabId));
  const targetTabId = Number.isFinite(explicitTabId) && explicitTabId > 0
    ? explicitTabId
    : NaN;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  if (!sessionId || !Number.isFinite(targetTabId) || targetTabId <= 0) {
    throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName }, context);
  }

  const sessions = getToolRuntimeDependencies(context).sessions;
  const target = {
    sessionId,
    runId: context.runId,
    signal,
    tabId: targetTabId,
    source: `tool:${toolName}:preflight`,
    checkOnly: context.preserveWorkingTab === true || context.deferToolCommit === true,
    readOnly: resolvePageAccess(definition, input) === "readOnly",
    tabOnly: resolvePageAccess(definition, input) === "tab",
    allowLoadingBlank,
  };
  let resolved = await sessions?.resolveTargetTab?.(target);
  if (resolved?.ok && resolved.claimRequired && !resolved.readOnlyAccess) {
    resolved = await sessions?.resolveTargetTab?.({ ...target, checkOnly: false });
  }
  if (!resolved?.ok) {
    throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
      toolName,
      message: resolved?.error || "",
    }, context);
  }
  if ((context.preserveWorkingTab || context.deferToolCommit) && resolved.claimRequired && !resolved.readOnlyAccess) {
    throw makeSessionTabTargetError("SESSION_TAB_UNOWNED", { toolName }, context);
  }
  if (!hasUidTargets) input.tabId = Number(resolved.tabId || targetTabId);
  if (resolved.readOnlyAccess === true && resolved.ownedByCurrentTask === false) {
    input._readOnlyTabAccess = true;
    if (resolved.ownerSessionId) input._readOnlyOwnerSessionId = resolved.ownerSessionId;
  }
  return input;
}

function makeSessionTabTargetError(code: string, details: Fields = {}, context: ToolContext = {}) {
  const toolName = details.toolName || "tool";
  const publicCode = code === "SESSION_TAB_TARGET_REQUIRED" ? "TAB_REF_REQUIRED" : code;
  const message = publicCode === "TAB_REF_REQUIRED" ? t("toolError.TAB_REF_REQUIRED.message")
    : details.message || (code === "SESSION_TAB_FOREIGN" ? t("browser.foreignTab") : t("browser.tabUnowned"));
  const error = new ToolExecutionError(publicCode, `${toolName}: ${message}`, {
    ...(details.target ? { target: details.target } : {}),
    ...(context.requestedTabRef != null ? { tabRef: context.requestedTabRef } : {}),
  });
  if (publicCode === "TAB_REF_REQUIRED") error.hint = t("toolError.TAB_REF_REQUIRED.hint");
  if (publicCode === "SESSION_TAB_UNAVAILABLE") error.hint = "Use list_tabs to choose an available tabRef, then retry.";
  return error;
}

async function recordToolPage(definition: RuntimeTool, args: Fields = {}, result: unknown = {}, context: ToolContext = {}, signal?: AbortSignal) {
  const toolName = definition.name;
  const role = typeof definition.tabLifecycle === "function" ? definition.tabLifecycle(args) : definition.tabLifecycle;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (!sessionId || !sessions) return;
  if (args?._readOnlyTabAccess === true || context.preserveWorkingTab === true) return;

  if (role === "clear" && Number.isFinite(Number(args.tabId))) {
    await sessions.clearWorkingTab?.({
      sessionId,
      runId: context.runId,
      signal,
      tabId: Number(args.tabId),
      source: `tool:${toolName}`,
    });
    return;
  }

  const tabId = inferToolPageId(definition, args, result);
  if (!tabId) return;
  // Read-only observation must not claim a page outside this task.
  if (elementTargetsOf(definition, args).some(isUidElementTarget)
    && resolvePageAccess(definition, args) === "readOnly"
    && !elementRuntime.taskTabIds(context).includes(tabId)) return;

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch(_e) {
    tab = null;
  }

  const fallback = record(result);
  const formattedTab = tab && isPageTab(tab) ? formatTab(tab, { titleLimit: 120 }) : null;
  const workingTab = {
    id: tabId,
    title: String(fallback._pageTitle || fallback.title || formattedTab?.title || ""),
    url: String(fallback._pageUrl || fallback.url || formattedTab?.url || ""),
    active: !!formattedTab?.active,
    pinned: !!formattedTab?.pinned,
    windowId: Number.isFinite(Number(formattedTab?.windowId)) ? Number(formattedTab?.windowId) : null,
  };
  if (!isPageTabUrl(workingTab.url)) return;

  await sessions.updateWorkingTab?.({
    sessionId,
    runId: context.runId,
    signal,
    tab: workingTab,
    source: `tool:${toolName}`,
    toolName,
    action: String(args?.action || ""),
    createdTab: role === "created",
    claim: role === "claim",
  });
}

function inferToolPageId(definition: RuntimeTool, args: Fields = {}, result: unknown = {}) {
  if (result && typeof result === "object") {
    const resultTabId = Number(createdTabResultId(result));
    if (Number.isFinite(resultTabId) && resultTabId > 0) return resultTabId;
    if (definition.tabLifecycle === "created") {
      const openedId = Number(record(result).tabRef ?? record(result).tabId ?? record(result).id);
      if (Number.isFinite(openedId) && openedId > 0) return openedId;
    }
  }

  const argTabId = Number(args?.tabId);
  if (Number.isFinite(argTabId) && argTabId > 0) return argTabId;
  return elementRuntime.elementUidTabId(elementTargetsOf(definition, args).filter(isUidElementTarget));
}

async function rememberToolPageContext(definition: RuntimeTool, args: Fields, result: unknown) {
  if (!result || typeof result !== "object") return;
  const page = await resolveToolPageContext(definition, args, record(result));
  if (page) bindToolResultPresentation(result, { _pageTitle: page.title, _pageUrl: page.url,
    ...(capabilityBridges.describePage ? { _pageContext: capabilityBridges.describePage(page.tabId) } : {}),
    ...getToolResultPresentation(result) });
}

async function getTabPageState(tabId: unknown) {
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return {
      url: getEffectiveTabUrl(tab),
      title: String(tab?.title || ""),
    };
  } catch(_err) {
    return { url: "", title: "" };
  }
}

function pageStateDelta(before: PageState = {}, after: PageState = {}) {
  const beforeUrl = String(before.url || "");
  const afterUrl = String(after.url || "");
  const beforeTitle = String(before.title || "");
  const afterTitle = String(after.title || "");
  return {
    pageBefore: { url: beforeUrl, title: beforeTitle },
    pageAfter: { url: afterUrl, title: afterTitle },
    urlChanged: isMeaningfulNavigationChange(beforeUrl, afterUrl),
    titleChanged: !!beforeTitle && !!afterTitle && beforeTitle !== afterTitle,
  };
}

function normalizePageNavigationUrl(rawUrl: unknown = "", baseUrl = "") {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return ["http:", "https:", "file:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_err) {
    return "";
  }
}

function stripUrlHash(url: unknown = "") {
  const normalized = normalizePageNavigationUrl(url);
  return normalized ? normalized.split("#")[0] : "";
}

function isMeaningfulNavigationChange(beforeUrl: unknown = "", afterUrl: unknown = "") {
  const before = stripUrlHash(beforeUrl);
  const after = stripUrlHash(afterUrl);
  return !!before && !!after && before !== after;
}

function isMeaningfulKnownNavigationTarget(beforeUrl: unknown = "", targetUrl: unknown = "") {
  const target = stripUrlHash(targetUrl);
  if (!target) return false;
  const before = stripUrlHash(beforeUrl);
  return !before || before !== target;
}

async function prepareKnownPageNavigation({
  url = "",
  baseUrl = "",
  pageBefore = {},
  guardrails = {},
  context = {},
  signal = null,
  toolName = "",
  toolArgs = {},
  tabId = null,
  source = "navigation_target",
}: { url?: string; baseUrl?: string; pageBefore?: PageState; guardrails?: Partial<SecurityGuardrails>; context?: ToolContext; signal?: AbortSignal | null; toolName?: string; toolArgs?: Fields; tabId?: number | null; source?: string } = {}) {
  const targetUrl = normalizePageNavigationUrl(url, baseUrl || pageBefore?.url || "");
  if (!targetUrl || !isMeaningfulKnownNavigationTarget(pageBefore?.url || "", targetUrl)) return null;
  await assertPageUrlAccessible(targetUrl);
  assertUrlAllowedBySecurityGuardrails(targetUrl, guardrails, { tool: toolName, source, tabRef: context.requestedTabRef });
  const rateLimitMatch = resolveUrlNavigationOpenRateLimit(targetUrl, guardrails);
  const rateLimit = await enforceSiteOpenRateLimitForUrl({
    url: targetUrl,
    guardrails,
    context,
    signal,
    emitUpdate: update => emitToolExecutionUpdate(toolName, toolArgs, update, context),
  });
  return {
    url: targetUrl,
    rateLimitMatch: rateLimit?.match || rateLimitMatch || null,
    rateLimit: rateLimit || null,
  };
}

function commitObservedPageNavigation({
  pageBefore = {},
  pageAfter = {},
  prepared = null,
  guardrails = {},
  toolName = "",
  tabId = null,
}: { pageBefore?: PageState; pageAfter?: PageState; prepared?: PreparedNavigation | null; guardrails?: Partial<SecurityGuardrails>; toolName?: string; tabId?: unknown } = {}) {
  const afterUrl = normalizePageNavigationUrl(pageAfter?.url || "");
  if (!afterUrl || !isMeaningfulNavigationChange(pageBefore?.url || "", afterUrl)) return null;
  assertUrlAllowedBySecurityGuardrails(afterUrl, guardrails, { tool: toolName, source: "page_after" });
  const afterMatch = resolveUrlNavigationOpenRateLimit(afterUrl, guardrails);
  if (!afterMatch || sameRateLimitMatch(prepared?.rateLimitMatch, afterMatch)) {
    return { url: afterUrl };
  }
  const recorded = recordSiteOpenRateLimitForUrl({ url: afterUrl, guardrails });
  return {
    url: afterUrl,
    rateLimit: recorded
      ? {
          host: recorded.host,
          minOpenIntervalMs: recorded.minOpenIntervalMs,
          nextIntervalMs: recorded.nextIntervalMs,
          nextAllowedAt: recorded.nextAllowedAt,
          type: recorded.match?.type || "",
          value: recorded.match?.value || "",
          domain: recorded.match?.domain || undefined,
          pattern: recorded.match?.pattern || undefined,
        }
      : null,
  };
}

function sameRateLimitMatch(input: unknown = null, next: unknown = null) {
  if (!input || !next) return false;
  const a = record(input), b = record(next);
  if (a.ruleId && b.ruleId) return a.ruleId === b.ruleId;
  return String(a.type || a.matchType || "") === String(b.type || b.matchType || "")
    && String(a.value || "") === String(b.value || "")
    && String(a.host || "") === String(b.host || "");
}

function clickPointReady(inspection: ElementReply = {}): inspection is ElementReply & { clickablePoint: PagePoint } {
  if (inspection.error) return false;
  if (!inspection.clickablePoint) return false;
  if (inspection.visible === false || inspection.disabled === true) return false;
  const state = inspection.state || {};
  if (state.inViewport === false) return false;
  if (state.clickablePointInViewport === false) return false;
  if (state.obscuredAtCenter === true) return false;
  return true;
}

function clickNotReadyResult({ target, inspection }: { target: string; selector: string; index: number; inspection: ElementReply; originalInspection: ElementReply; resolved: ElementReply | null }) {
  const state = inspection?.state || {};
  const code = inspection?.disabled
    ? "ELEMENT_DISABLED"
    : !inspection?.visible
      ? "ELEMENT_NOT_VISIBLE"
      : state.obscuredAtCenter
        ? "ELEMENT_OBSCURED"
        : "CLICK_POINT_OUT_OF_VIEWPORT";
  return toolError(code, `Element is not ready for click: ${target}`, {
    details: { target },
    hint: "Refresh candidates with find_elements or inspect_element. If the element is offscreen, retry after scroll or use a visible link/button target.",
  });
}

async function resolveToolPageContext(definition: RuntimeTool, args: Fields = {}, result: Fields = {}) {
  const tabId = inferToolPageId(definition, args, result);
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const resultUrl = String(result?.url || args?.url || "").trim();
    const formattedTab = formatTab(tab, { titleLimit: 120 });
    return {
      tabId,
      title: String(result?.title ?? formattedTab.title ?? ""),
      url: isPageTab(tab) ? formattedTab.url : (resultUrl || formattedTab.url),
    };
  } catch (_err) {
    if (!result?.title && !result?.url && !args?.url) return { tabId, title: "", url: "" };
    return {
      tabId,
      title: String(result?.title || ""),
      url: String(result?.url || args?.url || ""),
    };
  }
}

function validateToolArgs(name: string, args: unknown, parameters: ToolSchema, defaultableFields: readonly string[] = []): asserts args is Fields {
  if (!isRecord(args)) throw new ToolExecutionError("INVALID_ARGUMENTS", `Invalid arguments for ${name}: expected an object`);
  const details = { ...(args.tabRef != null ? { tabRef: args.tabRef } : {}), ...(args.target ? { target: args.target } : {}) };
  const missing = (parameters.required || []).filter(key => isMissingRequiredValue(args[key]) && !defaultableFields.includes(key));
  if (missing.length) throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Invalid arguments for ${name}: missing required field(s): ${missing.join(", ")}`, {
    ...details, missing, expected: Object.fromEntries(missing.filter(key => parameters.properties[key]).map(key => [key, parameters.properties[key]])),
  });
  const alternatives = requiredAnyOfGroups(parameters.anyOf);
  if (alternatives.length && !alternatives.some(group => group.every(key => !isMissingRequiredValue(args[key])))) {
    throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Invalid arguments for ${name}: expected one of required field groups: ${alternatives.map(group => group.join(" + ")).join(" or ")}`, details);
  }
}

function attachToolRetryContext(input: unknown, parameters: ToolParameter = {}, args: unknown = {}) {
  if (!input || typeof input !== "object") return;
  const err = record(input);
  const details = record(err.details);
  const existing = isRecord(details.retry) ? details.retry : null;
  if (err.code !== "MISSING_REQUIRED_ARGUMENTS" && !existing && !details.expectedSchema) return;

  const requiredFields = Array.isArray(parameters?.required) ? parameters.required.filter(Boolean) : [];
  const missingFields = Array.isArray(details.missing) ? details.missing.filter(Boolean) : [];
  const preservedArgs = {
    ...record(existing?.preservedArgs),
  };
  if (isRecord(args)) {
    for (const key of requiredFields) {
      const value = args[key];
      if (isMissingRequiredValue(value)) continue;
      if (isRetrySafeToolArg(value, parameters?.properties?.[key])) {
        preservedArgs[key] = value;
      }
    }
  }
  try {
    err.details = {
      ...details,
      retry: {
        ...(existing || {}),
        requiredFields,
        ...(missingFields.length ? { missingFields } : {}),
        preservedArgs,
      },
    };
  } catch (_error) {}
}

function isRetrySafeToolArg(value: unknown, schema: ToolParameter = {}) {
  if (!["string", "number", "boolean"].includes(typeof value)) return false;
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  if (typeof value === "string" && value.length > 500) return false;
  if (schema?.type && schema.type !== typeof value) return false;
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return false;
  return true;
}


function requiredAnyOfGroups(anyOf: unknown = []): string[][] {
  return (Array.isArray(anyOf) ? anyOf : [])
    .map(option => Array.isArray(record(option).required) ? option.required.filter(Boolean) : [])
    .filter(group => group.length > 0);
}

function clampLimit(value: unknown, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const {
  beginDebuggerExecution,
  retainDebugger,
  onDebuggerDetached,
  sendCdp,
  evaluateCdpScript,
  withDebugger,
  withTemporaryDebugger,
  getDebuggerConnectionId,
  getDebuggerRun,
  setDebuggerRetention,
  releaseDebugger,
  confirmRunReattach,
  releaseRun: releaseRunDebuggerConnections,
  releaseSession: releaseSessionCdp,
  releaseTab: releaseTabCdp,
} = createCdpRuntime({
  ToolExecutionError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  isRunCurrent: isCdpRunCurrent,
  authorizeRunTab: authorizeRunCdpTab,
  isReadOnlyAccess: hasReadOnlyPageAccess,
  confirmUserReattach: access => confirmDebuggerReattach(access, getToolRuntimeDependencies(access.context)),
});

function isCdpRunCurrent({ sessionId, runId, context = {} }: { sessionId: string; runId: string; context?: ToolContext }) {
  return getToolRuntimeDependencies(context).sessions?.isRunCurrent?.(sessionId, runId) === true;
}

async function authorizeRunCdpTab({ tabId, sessionId, context = {} }: { tabId: number; sessionId: string; context?: ToolContext }) {
  const sessions = getToolRuntimeDependencies(context).sessions;
  const runId = String(context?.runId || "").trim();
  if (typeof sessions?.resolveTargetTab !== "function") {
    throw new ToolExecutionError(
      "CDP_SESSION_RUNTIME_UNAVAILABLE",
      "CDP page access requires the current Session tab runtime",
      { tabRef: context.requestedTabRef },
    );
  }
  const resolved = await sessions.resolveTargetTab({
    sessionId,
    runId,
    signal: context.signal,
    tabId,
    source: "cdp:run",
    checkOnly: true,
    readOnly: hasReadOnlyPageAccess(tabId, context),
    allowPreNavigationBlank: context?.allowPreNavigationBlank === true,
  });
  if (!resolved?.ok) {
    throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
      toolName: "CDP",
      message: resolved?.error || "",
    }, context);
  }
  if ((resolved.ownedByCurrentTask === false || resolved.claimRequired === true)
    && !(resolved.readOnlyAccess && hasReadOnlyPageAccess(tabId, context))) {
    throw makeSessionTabTargetError(
      resolved.ownerSessionId ? "SESSION_TAB_FOREIGN" : "SESSION_TAB_UNOWNED",
      {
        toolName: "CDP",
      },
      context,
    );
  }
  return resolved;
}

export async function releaseRunCdp(sessionId: string, runId: string) {
  for (const [index, release] of capabilityRunCleanup.entries()) {
    try { release(sessionId, runId); }
    catch (error) {
      // A faulty extension cannot retain another extension's state or the host's CDP lease.
      try {
        diagnosticTrace(`[tool] run cleanup failed${formatTraceFields({ sessionId, runId, cleanup: index, error: errorMessage(error).slice(0, 500) })}`);
      } catch { /* Diagnostics must not interrupt terminal cleanup. */ }
    }
  }
  return await releaseRunDebuggerConnections(sessionId, runId);
}

export { releaseSessionCdp, releaseTabCdp };

export async function withRunCdp<T>(tabId: number, context: ToolContext, fn: (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>) {
  return await withDebugger(tabId, fn, context);
}

export async function withTemporaryCdp<T>(tabId: number, fn: (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>, label = "temporary") {
  return await withTemporaryDebugger(tabId, fn, label);
}

const elementRuntime = createElementRuntime({
  isReadOnlyAccess: hasReadOnlyPageAccess,
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  withDebugger,
  sendToContent,
  initializeContentScript: async (tabId, context) => {
    await assertTabAllowedBySecurityGuardrails(tabId, { tool: "content_script", action: "initialize" });
    await ensureContentScript(tabId, true, context);
  },
});
const { isUidElementTarget } = elementRuntime;

async function enablePreNavigationNetworkWatch(tabId: number, options: NetworkWatchOptions = {}, context: ToolContext = {}) {
  if (!capabilityBridges.enablePreNavigationNetworkWatch) {
    throw new ToolExecutionError("DIAGNOSTICS_RUNTIME_NOT_READY", "Diagnostics runtime is not initialized");
  }
  const { allowPreNavigationBlank = false, ...networkOptions } = options;
  const networkContext = allowPreNavigationBlank === true
    ? withToolRuntimeContext({ ...context, allowPreNavigationBlank: true }, getToolRuntimeDependencies(context))
    : context;
  return capabilityBridges.enablePreNavigationNetworkWatch(tabId, networkOptions, networkContext);
}

async function updateModelRuntime(operation: () => ReturnType<typeof getConfig>) {
  const config = await operation();
  setCurrentRuntimeConfig(config);
  return config;
}

// File discovery supplies trusted definitions; permission and run ownership stay in this host.
const capabilityHost: ToolExtensionAPI = Object.freeze({
  getPageContext: (tabId: number) => capabilityBridges.describePage?.(tabId) || {},
  registerTool: defineTool,
  models: Object.freeze({
    getConfig, saveConfig: (input: Record<string, unknown>, signal?: AbortSignal) => updateModelRuntime(() => saveConfig(input, signal)),
    applyPreset: (id: unknown, signal?: AbortSignal) => updateModelRuntime(() => applyModelPreset(id, signal)),
    deletePreset: (id: unknown, signal?: AbortSignal) => updateModelRuntime(() => deleteModelPreset(id, signal)),
    listModels, listProviders: listProviderSummaries, chat: createCapabilityChat(chat),
  }),
  skills: Object.freeze({ list: listSkills, load: loadSkill, loadByIdentity: loadSkillByIdentity, save: saveSkill, update: updateSkill,
    delete: deleteSkill, loadResource: loadSkillResource, loadScript: loadSkillScript }), ToolExecutionError, getToolRuntimeDependencies, element: elementRuntime,
  clampLimit, clampNumber, secondsToMs, makeSessionTabTargetError,
  getBookmarks: () => chrome.bookmarks, getHistory: () => chrome.history, getSecurityGuardrails, matchBlockedUrl,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  assertUrlAllowed: assertUrlAllowedBySecurityGuardrails,
  assertPageUrlAccessible,
  sendToContent, sendCdp, withDebugger,
  getDebuggerConnectionId, getDebuggerRun, retainDebugger, onDebuggerDetached, setDebuggerRetention, releaseDebugger, withTemporaryDebugger, evaluateCdpScript,
  getTabPageState, pageStateDelta, prepareKnownPageNavigation, commitObservedPageNavigation,
  clickPointReady, clickNotReadyResult, captureTabScreenshot, enablePreNavigationNetworkWatch,
  publishSkillRegistryChange, summarizeToolArgsForTrace,
  inspectServer: inspectMcpServer, callServerTool: callMcpServerTool,
  listSkillMcpServers: listSkillMcpServers, listSkillMcpTools: listSkillMcpTools,
});
for (const { id, setup } of contributions) {
  const { releaseRun, ...bridges } = setup(Object.freeze({
    ...capabilityHost, registerTool: coreToolDefinitions.forCapability(id),
  })) || {};
  for (const name of Object.keys(bridges)) {
    if (name in capabilityBridges) throw new Error(`Duplicate tool runtime bridge: ${name}`);
  }
  Object.assign(capabilityBridges, bridges);
  if (releaseRun) capabilityRunCleanup.push(releaseRun);
}
coreToolDefinitions.validate();

export type ToolRuntime = ReturnType<typeof createToolRuntime>;

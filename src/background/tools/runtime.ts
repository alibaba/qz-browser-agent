import { t } from "../../shared/i18n/backend.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { chat, getConfig, saveConfig, applyModelPreset, deleteModelPreset, listModels, listProviderSummaries } from "../llm/index.js";
import { createCapabilityChat } from "../llm/capability-chat.js";
import { setCurrentRuntimeConfig } from "../runtime-config.js";
import { listSkills, loadSkill, saveSkill, updateSkill, deleteSkill, loadSkillResource, loadSkillScript } from "../skills/runtime.js";
import type { ToolContext } from "../../sdk/background.js";
import type { ToolRuntimeDependencies } from "../../sdk/background/services.js";
import type { ToolDefinition, ToolSchema, ToolParameter, ToolModelPolicy } from "../../shared/contracts/tool.js";
import type { RegisteredTool } from "./registry.js";
import type { SkillTool, SkillManifest } from "../../shared/skills/skill-manifest.js";
import type { SkillRenderer } from "../../shared/skills/skill-renderers.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";
import type { CdpCommand } from "./cdp-runtime.js";
import type { ScreenshotOptions, PageState } from "./page-observation.js";
import type { ToolExtensionAPI, ToolExtensionRuntime, NetworkWatchOptions, PreparedNavigation } from "../../sdk/background.js";
import contributions from "#capabilities/tools";
import type { ElementReply, PagePoint } from "../../shared/contracts/page-content.js";
type Fields = Record<string, unknown>;
type RuntimeTool = ToolDefinition<ToolSchema, unknown, ToolContext, AbortSignal> & ReturnType<typeof normalizeToolIdentity> & { source: "core" | "plugin"; plugin?: SkillManifest; selectionRenderer?: SkillRenderer };
type ToolOptions = NonNullable<Parameters<typeof getSkillToolDefinition>[1]>;
type RuntimeContext = ToolContext & { [TOOL_RUNTIME_CONTEXT]?: ToolRuntimeDependencies };
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
import { assertPageUrlAccessible } from "./page-access.js";
import { assertScriptPageLifecycle } from "./behavior.js";
/**
 * Definitions declare capabilities; this runtime owns permission, cancellation and effects.
 * Core, Skill and script bridges share this boundary instead of invoking raw handlers.
 */

import { ToolExecutionError, isMissingRequiredValue, validateToolSchema } from "./arguments.js";
import { DEFAULT_TOOL_TIMEOUT, resolveTimeout, scriptTimeout } from "./timing.js";
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
  isSkillToolActive,
  listSkillMcpServers,
  listSkillMcpTools,
} from "../skills/skill-tool-runtime.js";
import { createCdpRuntime } from "./cdp-runtime.js";
import { createElementRuntime } from "./element-runtime.js";
import { callMcpServerTool, inspectMcpServer } from "../mcp/mcp-client.js";

// ---------------------------------------------------------------------------
// Content script messaging
// One injection covers every frame. Messages stay on the main frame; without
// a frame id, Chrome accepts whichever frame answers first.
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId: number, force = false) {
  if (!force) {
    try {
      const response = record(await chrome.tabs.sendMessage<Fields, unknown>(tabId, { action: "ping" }, { frameId: 0 }));
      if (response?.ok === true) return;
    } catch(_e) {
      // Inject the content script when it is missing.
    }
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "ISOLATED",
    files: ["content/article-extractor.js", "content/content-script.js"],
    injectImmediately: true,
  });
  const response = record(await chrome.tabs.sendMessage<Fields, unknown>(tabId, { action: "ping" }, { frameId: 0 }));
  if (response?.ok !== true) {
    throw new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "Content script did not acknowledge ping", {
      tabId,
      response,
    });
  }
}

// Script injection already waits for document_idle, but cannot target the initial
// about:blank document. This wait runs inside the caller's deadline and signal.
async function waitForInitialPage(tabId: number, signal?: AbortSignal) {
  let waited = false;
  while (true) {
    if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting for the page", { tabId });
    const tab = await chrome.tabs.get(tabId);
    if ((tab.url && tab.url !== "about:blank") || !isPageTabUrl(tab.pendingUrl)) return waited;
    waited = true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function sendToContent(tabId: number | undefined, action: string, params: Fields = {}): Promise<unknown> {
  if (!tabId) {
    throw new ToolExecutionError("SESSION_TAB_TARGET_REQUIRED", "Content script calls require the current session workingTabId or an explicit owned tabId", { action });
  }
  await assertTabAllowedBySecurityGuardrails(tabId, { tool: "content_script", action });
  await ensureContentScript(tabId);
  try {
    const response = await chrome.tabs.sendMessage<Fields, unknown>(tabId, { action, ...params }, { frameId: 0 });
    if (response == null) {
      throw new ToolExecutionError("EMPTY_CONTENT_RESPONSE", `Content script returned empty response for ${action}`, {
        action,
        tabId,
      });
    }
    return response;
  } catch (err) {
    if (err instanceof ToolExecutionError) throw err;
    throw new ToolExecutionError("CONTENT_SCRIPT_MESSAGE_FAILED", `Content script ${action} failed: ${errorMessage(err)}`, {
      action,
      tabId,
    });
  }
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
    throw new ToolExecutionError("MEDIA_RUNTIME_NOT_READY", "Media runtime is not initialized", { tabId });
  }
  return await capabilityBridges.captureTabScreenshot(tabId, options, context);
}

export function createToolRuntime({
  sessions = null,
  skills = null,
  skillSettings = null,
  skillNetwork = null,
  requestLocation,
  windowTarget = null,
  emit = null,
}: ToolRuntimeDependencies = {}) {
  const dependencies = Object.freeze({
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
    getModelPolicy: (name: string, options: ToolOptions = {}) => resolveToolDefinition(name, options)?.model,
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
    model: hostDefinition?.model,
    behavior: hostDefinition?.behavior,
    source: "plugin",
    plugin: entry.plugin,
    ...(renderer?.type === "selection" ? { selectionRenderer: renderer } : {}),
    validateArgs: args => {
      if (isSkillScriptTool(entry.tool)) scriptTimeout(args, runtimeName);
      return hostDefinition?.validateArgs?.(args);
    },
    timeout: isSkillPageScriptTool(entry.tool) ? 0 : isSkillScriptTool(entry.tool) ? scriptTimeout : DEFAULT_TOOL_TIMEOUT,
    legacyTimeoutMs: !isSkillScriptTool(entry.tool),
    execute: (args, signal, context) => executeSkillTool(name, args, signal, context,
      (nestedName, nestedArgs, nestedSignal, nestedContext = {}) => executeTool(
        nestedName, nestedArgs, nestedSignal,
        withToolRuntimeContext(nestedContext, getToolRuntimeDependencies(context)),
      ),
      { skillSettings: getToolRuntimeDependencies(context).skillSettings },
    ),
  };
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

/**
 * Validate before resolving targets: invalid input must not claim tabs or consume site limits.
 * Frozen definitions and the current run authorize execution; result fields cannot grant authority.
 */
export async function executeTool(name: string, args: unknown, signal?: AbortSignal, context: ToolContext = {}) {
  const startedAtMs = Date.now();
  const language = isCoreToolSnapshot(context.toolRegistrySnapshot) ? context.toolRegistrySnapshot.language : context.language || getLanguage();
  let effectiveArgs = args;
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
    parameters = definition.parameters || parameters;
    effectiveArgs = withWorkingTabDefault(definition, args, parameters, context);
    effectiveArgs = withTimeoutAliases(effectiveArgs, definition);
    validateToolArgs(name, effectiveArgs, parameters, definition.defaultableFields);
    if (typeof definition.validateArgs === "function") definition.validateArgs(effectiveArgs);
    validateToolSchema(name, effectiveArgs, parameters);
    await assertToolAllowedForSession(definition, context);
    const executionArgs = await withSessionOwnedTarget(definition, effectiveArgs, parameters, context, signal);
    effectiveArgs = executionArgs;
    assertScriptPageLifecycle(definition, executionArgs, context);
    const securityGuardrails = await getSecurityGuardrails();
    await assertToolTargetAllowedBySecurityGuardrails(definition, executionArgs, context, securityGuardrails);
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
    const timeoutMs = resolveToolTimeoutMs(definition, executionArgs);
    if (traceTool) {
      toolTrace(`[tool] resolved name=${name} kind=${definition.source} capability=${definition.capabilityId} timeoutMs=${timeoutMs} executionArgs=${summarizeToolArgsForTrace(executionArgs)}`);
    }
    let result;
    const selectedDefinition = definition;
    try {
      result = await runToolWithTimeout(
        name,
        async (args, signal, context) => {
          const pageAccess = resolvePageAccess(selectedDefinition, args);
          if (pageAccess && pageAccess !== "tab" && args._readOnlyTabAccess !== true && Number(args.tabId) > 0) {
            await capabilityBridges.preparePage?.(Number(args.tabId), name, signal, context);
          }
          if (pageAccess === "readOnly" && Number(args.tabId) > 0
            && await waitForInitialPage(Number(args.tabId), signal)) {
            await withSessionOwnedTarget(selectedDefinition, args, parameters, context, signal);
            await assertToolTargetAllowedBySecurityGuardrails(selectedDefinition, args, context);
          }
          if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Operation aborted before tool execution");
          return selectedDefinition.execute(args, signal, context);
        },
        executionArgs,
        signal,
        context,
        timeoutMs,
        definition.behavior?.timeoutTrace,
      );
    } catch (err) {
      await attachPageContextToToolError(definition, executionArgs, err);
      throw err;
    }
    if (definition.selectionRenderer) {
      result = await selectSkillResults(definition.selectionRenderer, result, signal, context,
        (nestedName, nestedArgs, nestedSignal, nestedContext) => executeTool(nestedName, nestedArgs, nestedSignal,
          withToolRuntimeContext(nestedContext, getToolRuntimeDependencies(context))));
    }
    const enrichedResult = await attachPageContextToToolResult(definition, executionArgs, result);
    const localizedResult = copyToolEffects(result, withLanguage(language, () => localizeToolFailurePayload(enrichedResult, { toolName: name })));
    if (!signal?.aborted && !(record(localizedResult).error || record(localizedResult).ok === false || record(localizedResult).isError === true)) {
      issueToolEffects(localizedResult, definition.effects?.(executionArgs, localizedResult) || [], context);
    }
    await recordWorkingTabFromTool(definition, executionArgs, localizedResult, context, signal);
    if (traceTool) {
      const ok = !(localizedResult && typeof localizedResult === "object" && record(localizedResult).error);
      toolTrace(`[tool] done name=${name} ok=${ok ? 1 : 0} durationMs=${Date.now() - startedAtMs} result=${summarizeToolArgsForTrace(localizedResult)}`);
    }
    return localizedResult;
  } catch (err) {
    attachToolRetryContext(err, parameters, effectiveArgs);
    const localized = withLanguage(language, () => localizeToolFailureError(err, { toolName: name }));
    if (traceTool) {
      toolTrace(`[tool] error name=${name} code=${record(localized).code || record(err).code || ""} label=${record(localized).codeLabel || ""} message=${record(localized).message || record(err).message || err} durationMs=${Date.now() - startedAtMs} details=${summarizeToolArgsForTrace(record(localized).details || record(err).details || {})}`);
    }
    throw localized;
  }
}

function emitToolExecutionUpdate(name: string, args: unknown = {}, update: Fields = {}, context: ToolContext = {}) {
  const sink = getToolRuntimeDependencies(context).emit;
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
    assertUrlAllowedBySecurityGuardrails(url, guardrails, { tool: name, source: "args" });
  }

  if (!resolvePageAccess(definition, args) || resolvePageAccess(definition, args) === "tab") return;
  if (isUidElementTarget(args?.target) || isUidElementTarget(args?.selector)) return;

  const tabIds = Array.isArray(args?.tabIds) ? args.tabIds : [];
  for (const item of tabIds) {
    const tabId = Number(item);
    if (Number.isFinite(tabId) && tabId > 0) {
      await assertTabAllowedBySecurityGuardrails(tabId, { tool: name, source: "tabIds" }, guardrails);
    }
  }

  const tabId = resolveGuardrailTargetTabId(args, context);
  if (tabId) await assertTabAllowedBySecurityGuardrails(tabId, { tool: name, source: "tab" }, guardrails);
}

function resolveGuardrailTargetTabId(args: Fields = {}, context: ToolContext = {}) {
  const explicit = Number(args?.tabId ?? args?._tabId);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const working = Number(context?.workingTabId);
  if (Number.isFinite(working) && working > 0) return working;
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
  return assertUrlAllowedBySecurityGuardrails(url, rules, { ...details, tabId: Number(tabId) });
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
      ...details,
      blockedType: match.type || "domain",
      blockedDomain: match.domain || undefined,
      blockedPattern: match.pattern || undefined,
      host: match.host,
    },
  );
}

function withTimeoutAliases(args: unknown, definition: RuntimeTool) {
  const input = isRecord(args) ? { ...args } : args;
  if (!isRecord(input)) return input;
  const acceptsAlias = typeof definition.legacyTimeoutMs === "function"
    ? definition.legacyTimeoutMs(input) : definition.legacyTimeoutMs;
  if (acceptsAlias && input.timeout == null && input.timeoutMs != null) input.timeout = Number(input.timeoutMs) / 1000;
  return input;
}

async function runToolWithTimeout(name: string, execute: RuntimeTool["execute"], args: Fields, parentSignal: AbortSignal | undefined, context: ToolContext, timeoutMs: number, timeoutTrace?: string): Promise<unknown> {
  if (parentSignal?.aborted) {
    throw new ToolExecutionError("OPERATION_ABORTED", `Operation aborted before running ${name}`, { name });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return execute(args, parentSignal, context);
  }

  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | null = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      if (timeoutTrace) {
        diagnosticTrace(`${timeoutTrace}${formatTraceFields({
          phase: "tool.timeout",
          session: context?.sessionId || "",
          run: context?.runId || "",
          call: context?.toolCallId || context?.callId || "",
          tab: Number(args?.tabId) || 0,
          action: args?.action || "",
          timeoutMs,
        })}`);
      }
      if (shouldTraceDiagnosticTool(name)) {
        toolTrace(`[tool] timeout name=${name} timeoutMs=${timeoutMs} source=${context?.source || "agent"} args=${summarizeToolArgsForTrace(args)}`);
      }
      reject(new ToolExecutionError(
        "TOOL_TIMEOUT",
        `${name} timed out after ${timeoutMs}ms`,
        { name, timeout: timeoutMs },
      ));
    }, timeoutMs);
  });
  const abortPromise = new Promise((_, reject) => {
    if (!parentSignal) return;
    abortHandler = () => {
      controller.abort();
      reject(new ToolExecutionError("OPERATION_ABORTED", `Operation aborted while running ${name}`, { name }));
    };
    parentSignal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve(execute(args, controller.signal, context)),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    clearTimeout(timeoutTimer);
    if (parentSignal && abortHandler) parentSignal.removeEventListener("abort", abortHandler);
  }
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
    throw new ToolExecutionError(restriction.code, restriction.message, { sessionId });
  }
}

function resolvePageAccess(definition: RuntimeTool, args: Fields) {
  return typeof definition.page === "function" ? definition.page(args) : definition.page || false;
}

function shouldResolveSessionTabTarget(definition: RuntimeTool, args: Fields = {}) {
  return Boolean(resolvePageAccess(definition, args)) && !isUidElementTarget(args?.target) && !isUidElementTarget(args?.selector);
}

async function withSessionOwnedTarget(definition: RuntimeTool, args: Fields, _parameters: ToolSchema, context: ToolContext = {}, signal?: AbortSignal): Promise<Fields> {
  const toolName = definition.name;
  const input = { ...args };
  if (!shouldResolveSessionTabTarget(definition, input)) return input;

  const explicitTabId = Number(input.tabId ?? input._tabId);
  const targetTabId = Number.isFinite(explicitTabId) && explicitTabId > 0
    ? explicitTabId
    : Number(context.workingTabId);
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  if (!sessionId || !Number.isFinite(targetTabId) || targetTabId <= 0) {
    throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", {
      toolName,
      sessionId,
      tabId: Number.isFinite(targetTabId) && targetTabId > 0 ? targetTabId : null,
      workingTabId: Number(context.workingTabId) || null,
    });
  }

  const resolved = await getToolRuntimeDependencies(context).sessions?.resolveTargetTab?.({
    sessionId,
    runId: context.runId,
    signal,
    tabId: targetTabId,
    source: `tool:${toolName}:preflight`,
    readOnly: resolvePageAccess(definition, input) === "readOnly",
    tabOnly: resolvePageAccess(definition, input) === "tab",
  });
  if (!resolved?.ok) {
    throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
      toolName,
      sessionId,
      tabId: targetTabId,
      ownerSessionId: resolved?.ownerSessionId || "",
      reason: resolved?.reason || "",
      message: resolved?.error || "",
    });
  }
  input.tabId = Number(resolved.tabId || targetTabId);
  if (resolved.readOnlyAccess === true && resolved.ownedByCurrentTask === false) {
    input._readOnlyTabAccess = true;
    if (resolved.ownerSessionId) input._readOnlyOwnerSessionId = resolved.ownerSessionId;
  }
  return input;
}

function makeSessionTabTargetError(code: string, details: Fields = {}) {
  const toolName = details.toolName || "tool";
  const message = details.message || (
    code === "SESSION_TAB_FOREIGN"
      ? t("browser.foreignTab")
      : code === "SESSION_TAB_UNOWNED"
        ? t("browser.tabUnowned")
        : t("browser.noUsableWorkingTab")
  );
  return new ToolExecutionError(code, `${toolName}: ${message}`, details);
}

function withWorkingTabDefault(definition: RuntimeTool, args: unknown, parameters: ToolSchema, context: ToolContext = {}) {
  const input = isRecord(args) ? { ...args } : args;
  if (!isRecord(input)) return input;
  if (!resolvePageAccess(definition, input)) return input;
  if (!parameters?.properties?.tabId || input.tabId != null) return input;
  if (isUidElementTarget(input.target) || isUidElementTarget(input.selector)) return input;
  const workingTabId = Number(context.workingTabId);
  if (Number.isFinite(workingTabId) && workingTabId > 0) {
    input.tabId = workingTabId;
  }
  return input;
}

async function recordWorkingTabFromTool(definition: RuntimeTool, args: Fields = {}, result: unknown = {}, context: ToolContext = {}, signal?: AbortSignal) {
  const toolName = definition.name;
  const role = typeof definition.workingTab === "function" ? definition.workingTab(args) : definition.workingTab;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId.trim() : "";
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (!sessionId || !sessions) return;
  if (args?._readOnlyTabAccess === true) return;

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

  const tabId = inferWorkingTabId(definition, args, result);
  if (!tabId) return;
  // A uid has no explicit tabId, so a read-only look at an unclaimed tab never
  // sets _readOnlyTabAccess. That look must not become the working tab.
  if ((isUidElementTarget(args?.target) || isUidElementTarget(args?.selector))
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

function inferWorkingTabId(definition: RuntimeTool, args: Fields = {}, result: unknown = {}) {
  if (result && typeof result === "object") {
    const resultTabId = Number(record(result).tabId);
    if (Number.isFinite(resultTabId) && resultTabId > 0) return resultTabId;
    if (definition.workingTab === "created") {
      const openedId = Number(record(result).id);
      if (Number.isFinite(openedId) && openedId > 0) return openedId;
    }
  }

  const argTabId = Number(args?.tabId);
  if (Number.isFinite(argTabId) && argTabId > 0) return argTabId;
  return null;
}

async function attachPageContextToToolResult(definition: RuntimeTool, args: Fields = {}, result: unknown = {}) {
  if (!isRecord(result)) return result;
  const page = await resolveToolPageContext(definition, args, result);
  if (!page) return result;
  return {
    ...result,
    _tabId: page.tabId,
    _pageTitle: result._pageTitle || page.title,
    _pageUrl: result._pageUrl || page.url,
    ...(capabilityBridges.describePage ? { _pageContext: capabilityBridges.describePage(page.tabId) } : {}),
  };
}

async function attachPageContextToToolError(definition: RuntimeTool, args: Fields = {}, input: unknown) {
  if (!input || typeof input !== "object") return;
  const err = record(input);
  const details = record(err.details);
  const page = await resolveToolPageContext(definition, args, details);
  if (!page) return;
  err.details = {
    ...details,
    _tabId: page.tabId,
    _pageTitle: details._pageTitle || page.title,
    _pageUrl: details._pageUrl || page.url,
    ...(capabilityBridges.describePage ? { _pageContext: capabilityBridges.describePage(page.tabId) } : {}),
  };
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
  assertUrlAllowedBySecurityGuardrails(targetUrl, guardrails, { tool: toolName, source, tabId });
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
  assertUrlAllowedBySecurityGuardrails(afterUrl, guardrails, { tool: toolName, source: "page_after", tabId });
  const afterMatch = resolveUrlNavigationOpenRateLimit(afterUrl, guardrails);
  if (!afterMatch || sameRateLimitMatch(prepared?.rateLimitMatch, afterMatch)) {
    return { url: afterUrl, rateLimitRecorded: false };
  }
  const recorded = recordSiteOpenRateLimitForUrl({ url: afterUrl, guardrails });
  return {
    url: afterUrl,
    rateLimitRecorded: Boolean(recorded),
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

function clickNotReadyResult({ target, selector, index, inspection, originalInspection, resolved }: { target: string; selector: string; index: number; inspection: ElementReply; originalInspection: ElementReply; resolved: ElementReply | null }) {
  const state = inspection?.state || {};
  const code = inspection?.disabled
    ? "ELEMENT_DISABLED"
    : !inspection?.visible
      ? "ELEMENT_NOT_VISIBLE"
      : state.obscuredAtCenter
        ? "ELEMENT_OBSCURED"
        : "CLICK_POINT_OUT_OF_VIEWPORT";
  return {
    error: `Element is not ready for click: ${selector}[${index}]`,
    code,
    details: {
      target,
      selector,
      index,
      rect: inspection?.rect,
      state,
      resolved,
      originalRect: originalInspection?.rect,
      originalState: originalInspection?.state,
    },
    element: inspection,
    originalElement: originalInspection && originalInspection !== inspection ? originalInspection : undefined,
    hint: "Refresh candidates with find_elements or inspect_element. If the element is offscreen, retry after scroll or use a visible link/button target.",
  };
}

async function resolveToolPageContext(definition: RuntimeTool, args: Fields = {}, result: Fields = {}) {
  const tabId = inferWorkingTabId(definition, args, result);
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const resultUrl = String(result?.url || args?.url || "").trim();
    const formattedTab = formatTab(tab, { titleLimit: 120 });
    return {
      tabId,
      title: String(formattedTab.title || result?.title || ""),
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
  if (!isRecord(args)) {
    throw new ToolExecutionError("INVALID_ARGUMENTS", `Invalid arguments for ${name}: expected an object`, {
      name,
      ...compactToolArgShape(args),
    });
  }

  const missing = (parameters.required || []).filter((key) => (
    isMissingRequiredValue(args[key]) && !defaultableFields.includes(key)
  ));
  if (missing.length > 0) {
    throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Invalid arguments for ${name}: missing required field(s): ${missing.join(", ")}`, {
      name,
      missing,
      expected: compactMissingToolArgSchemas(parameters, missing),
      ...compactToolArgShape(args),
    });
  }

  const requiredAlternatives = requiredAnyOfGroups(parameters.anyOf);
  if (requiredAlternatives.length && !requiredAlternatives.some(group => group.every(key => !isMissingRequiredValue(args[key])))) {
    throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Invalid arguments for ${name}: expected one of required field groups: ${requiredAlternatives.map(group => group.join(" + ")).join(" or ")}`, {
      name,
      missingAnyOf: requiredAlternatives,
      ...compactToolArgShape(args),
    });
  }
}

function compactMissingToolArgSchemas(parameters: ToolParameter = {}, missing: readonly string[] = []) {
  const properties = parameters?.properties && typeof parameters.properties === "object"
    ? parameters.properties
    : {};
  return Object.fromEntries(missing
    .filter(key => properties[key] && typeof properties[key] === "object")
    .map(key => [key, compactToolArgSchema(properties[key])]));
}

function compactToolArgSchema(schema: ToolParameter = {}): Fields {
  const out: Fields = {};
  for (const key of ["type", "enum", "description", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] === undefined) continue;
    out[key] = key === "description" ? String(schema[key]).slice(0, 500) : schema[key];
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice(0, 30);
  if (schema.items && typeof schema.items === "object") {
    out.items = compactToolArgSchema(schema.items);
  }
  return out;
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

function compactToolArgShape(args: unknown) {
  if (isRecord(args)) {
    return {
      providedKeys: Object.keys(args).slice(0, 50),
      argSummary: summarizeToolArgsForTrace(args),
    };
  }
  if (typeof args === "string") {
    return {
      argType: "string",
      argChars: args.length,
      argPreview: args.length > 200 ? `${args.slice(0, 200)}…` : args,
    };
  }
  if (Array.isArray(args)) return { argType: "array", itemCount: args.length };
  return { argType: args == null ? String(args) : typeof args };
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
  sendCdp,
  evaluateCdpScript,
  withDebugger,
  withTemporaryDebugger,
  getDebuggerConnectionId,
  setDebuggerRetention,
  releaseDebugger,
  releaseRun: releaseRunDebuggerConnections,
  releaseSession: releaseSessionCdp,
} = createCdpRuntime({
  ToolExecutionError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  isRunCurrent: isCdpRunCurrent,
  authorizeRunTab: authorizeRunCdpTab,
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
      { tabId, sessionId, runId },
    );
  }
  const resolved = await sessions.resolveTargetTab({
    sessionId,
    tabId,
    source: "cdp:run",
    checkOnly: true,
    allowPreNavigationBlank: context?.allowPreNavigationBlank === true,
  });
  if (!resolved?.ok) {
    throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
      toolName: "CDP",
      sessionId,
      tabId,
      ownerSessionId: resolved?.ownerSessionId || "",
      reason: resolved?.reason || "",
      message: resolved?.error || "",
    });
  }
  if (resolved.ownedByCurrentTask === false || resolved.claimRequired === true) {
    throw makeSessionTabTargetError(
      resolved.ownerSessionId ? "SESSION_TAB_FOREIGN" : "SESSION_TAB_UNOWNED",
      {
        toolName: "CDP",
        sessionId,
        tabId,
        ownerSessionId: resolved.ownerSessionId || "",
        reason: resolved.reason || "tab_not_owned_by_current_session",
      },
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

export { releaseSessionCdp };

export async function withRunCdp<T>(tabId: number, context: ToolContext, fn: (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>) {
  return await withDebugger(tabId, fn, context);
}

export async function withTemporaryCdp<T>(tabId: number, fn: (target: chrome.debugger.Debuggee, send: CdpCommand) => T | Promise<T>, label = "temporary") {
  return await withTemporaryDebugger(tabId, fn, label);
}

const elementRuntime = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  withDebugger,
  sendToContent,
  initializeContentScript: async tabId => {
    await assertTabAllowedBySecurityGuardrails(tabId, { tool: "content_script", action: "initialize" });
    await ensureContentScript(tabId, true);
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
  skills: Object.freeze({ list: listSkills, load: loadSkill, save: saveSkill, update: updateSkill,
    delete: deleteSkill, loadResource: loadSkillResource, loadScript: loadSkillScript }), ToolExecutionError, getToolRuntimeDependencies, element: elementRuntime,
  clampLimit, clampNumber, secondsToMs, makeSessionTabTargetError,
  getBookmarks: () => chrome.bookmarks, getHistory: () => chrome.history, getSecurityGuardrails, matchBlockedUrl,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  assertUrlAllowed: assertUrlAllowedBySecurityGuardrails,
  assertPageUrlAccessible,
  sendToContent, sendCdp, withDebugger, getDebuggerConnectionId, setDebuggerRetention, releaseDebugger, withTemporaryDebugger, evaluateCdpScript,
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

import { skillToolT } from "./tool-messages.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";
import { findBuiltinSkill } from "../../shared/skills/builtin-skills.js";
import { materializeContribution } from "../../shared/capabilities.js";
import { ToolExecutionError } from "../tools/arguments.js";
import { withTabReferenceParameters } from "../tools/registry.js";
import type { ToolContext } from "../../sdk/background.js";
import type { ToolSchema, ToolParameter } from "../../shared/contracts/tool.js";
import type { SkillManifest, SkillTool, SkillMcpServer, SkillActivationContext } from "../../shared/skills/skill-manifest.js";
import type { SkillDiagnostic } from "../../shared/skills/skill-settings.js";
// Registry snapshots retain their serialized `plugins` shape for existing clients and sessions.
type Fields = Record<string, unknown>;
type RegistryDiagnostic = SkillDiagnostic & { toolName?: string };
type RegisteredSkillTool = SkillTool & { disabled?: boolean; collision?: { toolName: string; ownerPluginId: string; ownerSkillName: string } };
type RegisteredSkillManifest = SkillManifest & { tools: RegisteredSkillTool[] };
export interface SkillToolRegistryCandidate { plugins: RegisteredSkillManifest[]; diagnostics: RegistryDiagnostic[]; toolIndex: Map<string, { plugin: RegisteredSkillManifest; tool: RegisteredSkillTool }> }
export interface SkillToolRegistrySnapshot extends SkillToolRegistryCandidate { version: number; refreshedAt: number }
interface SkillToolOptions extends ToolContext {
  context?: ToolContext; dynamicContext?: SkillActivationContext | null; loadedPluginSkillNames?: unknown;
  skillToolRegistrySnapshot?: unknown; includeInactive?: boolean; server?: string; query?: string; limit?: number;
  refresh?: boolean; signal?: AbortSignal;
}
export type SkillBuiltinExecutor = (name: string, args: Fields, signal: AbortSignal | undefined, context: ToolContext) => Promise<unknown>;
interface SkillToolRuntime { skillSettings?: { getExecutionConfig?(plugin: SkillManifest, options: { includeSecrets: boolean }): Promise<Fields> } | null }
type HostCallTool = (name: string, args?: Fields) => Promise<unknown>;
import { resolveSkillHostBinding } from "./skill-host-registry.js";
import { copySkillManifestTrust, isTrustedSkillManifest } from "../../shared/skills/skill-provenance.js";
import { copyToolEffects } from "../tools/effects.js";
import { summarizeSkillArgsForTrace } from "../tools/trace-summary.js";
import { listSkills } from "./runtime.js";
import { trace as runtimeTrace } from "../trace.js";
import {
  discoverSkillManifests,
  skillMatchesContext,
} from "../../shared/skills/skill-manifest.js";
import {
  buildSkillRendererReturnContract,
} from "../../shared/skills/skill-renderers.js";
import {
  callMcpServerTool,
  listMcpServerTools,
  mcpServerResult,
} from "../mcp/mcp-client.js";

let skillToolRegistry: SkillToolRegistrySnapshot = {
  plugins: [],
  diagnostics: [],
  toolIndex: new Map(),
  version: 0,
  refreshedAt: 0,
};
const skillToolRegistryListeners = new Set<(event: Fields) => unknown>();
const localizedRegistries = new Map<string, SkillToolRegistrySnapshot>();

const SKILL_TOOL_TIMEOUT_SECONDS_PROPERTY = {
  type: "number",
  get description() { return skillToolT("toolTimeout"); },
} as const;
const SKILL_SCRIPT_TOOL_TIMEOUT_SECONDS_PROPERTY = {
  type: "number",
  get description() { return skillToolT("scriptTimeout"); },
} as const;
const SKILL_TOOL_TAB_ID_PROPERTY = {
  type: "number",
  get description() { return skillToolT("tabId"); },
} as const;

export function subscribeSkillToolRegistry(listener: (event: Fields) => unknown) {
  if (typeof listener !== "function") throw new TypeError("Skill tool registry listener must be a function");
  skillToolRegistryListeners.add(listener);
  return () => skillToolRegistryListeners.delete(listener);
}

export async function prepareSkillToolRegistryFromStorage() {
  return prepareSkillToolRegistryFromSkills(await listSkills());
}

export function prepareSkillToolRegistryFromSkills(skills: unknown = []) {
  const discovered = discoverSkillManifests(skills);
  const { plugins, diagnostics, toolIndex } = buildSkillToolRegistry(discovered.plugins, discovered.diagnostics);
  return { plugins, diagnostics, toolIndex };
}

export function commitSkillToolRegistryCandidate(candidate: SkillToolRegistryCandidate, options: unknown = {}) {
  const meta = normalizeSkillRefreshOptions(options);
  if (!Array.isArray(candidate.plugins) || !Array.isArray(candidate.diagnostics) || !(candidate.toolIndex instanceof Map)) {
    throw new TypeError("invalid Skill tool registry candidate");
  }
  skillToolRegistry = {
    plugins: candidate.plugins,
    diagnostics: candidate.diagnostics,
    toolIndex: candidate.toolIndex,
    version: skillToolRegistry.version + 1,
    refreshedAt: Date.now(),
  };
  localizedRegistries.clear();
  const snapshot = getSkillToolRegistrySnapshot();
  runtimeTrace(`[skill] registry commit reason=${meta.reason} version=${snapshot.version} plugins=${snapshot.plugins.length} tools=${countSkillTools(snapshot)} diagnostics=${snapshot.diagnostics.length}`);
  return snapshot;
}

/** A language projection never mutates the committed registry or an active run's references. */
function localizedRegistry(language: string): SkillToolRegistrySnapshot {
  const cached = localizedRegistries.get(language);
  if (cached) return cached;
  const projected = withLanguage(language, () => {
    const plugins = skillToolRegistry.plugins.map(plugin => {
      if (!isTrustedSkillManifest(plugin)) return plugin;
      const skill = findBuiltinSkill(plugin.skillName, language);
      const localized = skill && discoverSkillManifests([skill]).plugins.find(item => item.id === plugin.id);
      if (!localized) return plugin;
      // Keep committed activation/collision decisions; only trusted authored declarations vary.
      const result = { ...localized, activation: plugin.activation, tools: (plugin.tools as RegisteredSkillTool[]).map(tool => {
        const translated = localized.tools.find(item => item.name === tool.name);
        return translated ? { ...tool, ...translated, hidden: tool.hidden, disabled: tool.disabled, collision: tool.collision } : tool;
      }) };
      copySkillManifestTrust(plugin, result);
      return result;
    });
    return { ...buildSkillToolRegistry(plugins, skillToolRegistry.diagnostics), version: skillToolRegistry.version, refreshedAt: skillToolRegistry.refreshedAt };
  });
  localizedRegistries.set(language, projected);
  return projected;
}

export function getSkillToolRegistrySnapshot(language = getLanguage()) {
  const registry = localizedRegistry(language);
  return {
    plugins: registry.plugins,
    diagnostics: registry.diagnostics,
    version: registry.version,
    refreshedAt: registry.refreshedAt,
  };
}

export function getSkillToolRegistryExecutionSnapshot(language = getLanguage()) {
  const registry = localizedRegistry(language);
  return {
    plugins: registry.plugins,
    diagnostics: registry.diagnostics,
    toolIndex: new Map(registry.toolIndex),
    version: registry.version,
    refreshedAt: registry.refreshedAt,
  };
}

export function getActiveSkillToolSchemasSync(options: SkillToolOptions = {}) {
  return withLanguage(options.language || getLanguage(), () => buildActiveSkillToolSchemas(options));
}

function buildActiveSkillToolSchemas(options: SkillToolOptions) {
  const context = resolveSkillActivationContext(options);
  const registry = skillToolRegistryFromOptions(options);
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(
    options.loadedPluginSkillNames ?? context.loadedPluginSkillNames,
  );
  const schemas = [];
  for (const plugin of registry.plugins) {
    if (!skillMatchesContext(plugin, context, { loadedPluginSkillNames })) continue;
    for (const tool of plugin.tools || []) {
      if (tool.hidden) continue;
      const parameters = getSkillToolParameters(tool);
      schemas.push({
        type: "function" as const,
        function: {
          name: tool.name,
          description: buildSkillToolDescription(plugin, tool),
          parameters: isSkillPageTool(tool) ? withTabReferenceParameters(parameters) : parameters,
        },
        _qingzhouPlugin: {
          pluginId: plugin.id,
          skillName: plugin.skillName,
          localName: tool.localName,
        },
      });
    }
  }
  return schemas;
}

/** Runtime parameter contract, before model-facing tabRef projection. */
export function getSkillToolParameters(tool: Partial<SkillTool> = {}) {
  return withSkillToolControlParameters(tool.parameters || { type: "object", properties: {} }, tool);
}

export function isSkillToolActive(name: string, options: SkillToolOptions = {}) {
  const registry = skillToolRegistryFromOptions(options);
  const entry = registry.toolIndex.get(String(name || ""));
  if (!entry || entry.tool?.hidden) return false;
  const context = resolveSkillActivationContext(options);
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(
    options.loadedPluginSkillNames ?? context.loadedPluginSkillNames,
  );
  return skillMatchesContext(entry.plugin, context, { loadedPluginSkillNames });
}

export function getSkillToolDefinition(name: string, options: SkillToolOptions = {}) {
  const registry = skillToolRegistryFromOptions(options);
  const entry = registry.toolIndex.get(String(name || ""));
  return entry ? { plugin: entry.plugin, tool: entry.tool } : null;
}

export async function executeSkillTool(name: string, args: unknown = {}, signal: AbortSignal | undefined, context: ToolContext = {}, executeBuiltinTool: SkillBuiltinExecutor, runtime: SkillToolRuntime = {}) {
  const startedAt = Date.now();
  runtimeTrace(`[skill] execute start tool=${name} source=${context?.source || "agent"} session=${context?.sessionId || ""} args=${summarizeSkillArgsForTrace(args)}`);
  const entry = getSkillToolDefinition(name, { language: context.language, skillToolRegistrySnapshot: context.skillToolRegistrySnapshot });
  if (!entry) {
    runtimeTrace(`[skill] execute missing tool=${name} registryVersion=${skillToolRegistry.version} plugins=${skillToolRegistry.plugins.length} tools=${skillToolRegistry.toolIndex.size}`);
    const err = new ToolExecutionError("UNKNOWN_PLUGIN_TOOL", `Unknown Skill tool: ${name}`);
    throw err;
  }
  const { plugin, tool } = entry;
  const inputArgs = record(args);
  try {
    const result = tool.runtime === "mcp"
      ? await executeMcpSkillTool(plugin, tool, inputArgs, signal)
      : await executeScriptSkillTool(plugin, tool, inputArgs, signal, context, executeBuiltinTool, runtime);
    const normalized = normalizeSkillToolResult(plugin, tool, result);
    runtimeTrace(`[skill] execute done tool=${name} runtime=${tool.runtime || "page"} plugin=${plugin.id} skill=${plugin.skillName} durationMs=${Date.now() - startedAt} result=${summarizeSkillArgsForTrace(normalized)}`);
    return normalized;
  } catch (err) {
    runtimeTrace(`[skill] execute error tool=${name} runtime=${tool.runtime || "page"} plugin=${plugin.id} skill=${plugin.skillName} code=${record(err).code || ""} message=${err instanceof Error ? err.message : err} durationMs=${Date.now() - startedAt}`);
    throw err;
  }
}

async function executeScriptSkillTool(plugin: SkillManifest, tool: SkillTool, inputArgs: Fields, signal: AbortSignal | undefined, context: ToolContext, executeBuiltinTool: SkillBuiltinExecutor, runtime: SkillToolRuntime) {
  assertSkillExecutionActive(signal);
  const name = tool.name;
  if (typeof executeBuiltinTool !== "function") {
    const err = new ToolExecutionError("PLUGIN_DISPATCHER_UNAVAILABLE", "Skill tool execution requires a builtin tool dispatcher");
    throw err;
  }
  if (!tool.script) {
    const err = new ToolExecutionError("PLUGIN_TOOL_SCRIPT_MISSING", `Skill tool ${name} has no executable script`, { pluginId: plugin.id, skillName: plugin.skillName, tool: tool.rawName });
    throw err;
  }
  const controlArgs = isSkillScriptTool(tool)
    ? pickRequiredScriptSkillToolControlArgs(inputArgs, name)
    : pickSkillToolControlArgs(inputArgs);
  const skillConfig = await resolveSkillExecutionConfig(plugin, tool, runtime.skillSettings);
  assertSkillExecutionActive(signal);
  const scriptArgs = {
    ...(tool.args || {}),
    ...omitSkillToolControlArgs(inputArgs),
    $plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      skillName: plugin.skillName,
      config: skillConfig,
      tool: {
        name: tool.name,
        localName: tool.localName,
        rawName: tool.rawName,
      },
    },
  };
  if (tool.runtime === "host") return executeHostSkillScript(plugin, tool, scriptArgs, signal, context, executeBuiltinTool);
  const innerRuntime = tool.runtime === "inner";
  const tabId = Number(inputArgs.tabId || context.workingTabId);
  const runSkillScriptArgs = {
    ...(innerRuntime ? { target: "inner" } : {}),
    ...(!innerRuntime && Number.isFinite(tabId) && tabId > 0 ? { tabId } : {}),
    skill: plugin.skillName,
    script: tool.script,
    args: scriptArgs,
    ...(controlArgs.timeout != null ? { timeout: controlArgs.timeout } : {}),
    mutatesPage: inputArgs.mutatesPage === true,
  };
  return executeBuiltinTool("run_skill_script", runSkillScriptArgs, signal, {
    ...context,
    source: "plugin_tool",
    pluginId: plugin.id,
    skillToolName: tool.name,
    ...(innerRuntime ? {
      skillExecution: {
        plugin,
        config: skillConfig,
      },
    } : {}),
  });
}

function assertSkillExecutionActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Skill execution aborted");
}

async function resolveSkillExecutionConfig(plugin: SkillManifest, tool: SkillTool, skillSettings: SkillToolRuntime["skillSettings"] = null) {
  if (!plugin.settings?.fields?.length) return {};
  if (typeof skillSettings?.getExecutionConfig !== "function") {
    const error = new ToolExecutionError("SKILL_SETTINGS_UNAVAILABLE", "Skill settings runtime is unavailable", { pluginId: plugin.id, skillName: plugin.skillName });
    throw error;
  }
  const includeSecrets = tool.runtime === "inner" || tool.runtime === "host";
  return await skillSettings.getExecutionConfig(plugin, { includeSecrets });
}

function skillToolRegistryFromOptions(options: SkillToolOptions = {}): SkillToolRegistrySnapshot {
  const snapshot = options?.skillToolRegistrySnapshot;
  if (isRegistrySnapshot(snapshot)) return snapshot;
  return localizedRegistry(options.language || getLanguage());
}

function resolveSkillActivationContext(options: SkillToolOptions = {}): ToolContext {
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const dynamicContext = options.dynamicContext && typeof options.dynamicContext === "object"
    ? options.dynamicContext
    : context.dynamicContext && typeof context.dynamicContext === "object"
      ? context.dynamicContext
      : {};
  return { ...dynamicContext, ...context };
}

function normalizeLoadedSkillToolNamesOption(value: unknown): Set<string> {
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(item => String(item || "").trim().toLowerCase()).filter(Boolean));
  if (value && typeof value === "object") {
    return new Set(Object.keys(value).filter(key => record(value)[key]).map(key => String(key || "").trim().toLowerCase()).filter(Boolean));
  }
  return new Set();
}

function getMcpRegistryForContext(context: ToolContext = {}, options: SkillToolOptions = {}) {
  const snapshot = options.skillToolRegistrySnapshot || context.skillToolRegistrySnapshot;
  if (isRegistrySnapshot(snapshot)) return snapshot;
  return skillToolRegistry;
}

function collectMcpSkillServers(registry: SkillToolRegistrySnapshot = skillToolRegistry, context: ToolContext = {}, options: SkillToolOptions = {}) {
  const activationContext = resolveSkillActivationContext({ context });
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(
    options.loadedPluginSkillNames ?? activationContext.loadedPluginSkillNames,
  );
  const out = [];
  for (const plugin of Array.isArray(registry.plugins) ? registry.plugins : []) {
    const active = skillMatchesContext(plugin, activationContext, { loadedPluginSkillNames });
    if (!options.includeInactive && !active) continue;
    for (const server of Array.isArray(plugin.mcpServers) ? plugin.mcpServers : []) {
      out.push({
        plugin,
        server: {
          ...server,
          pluginId: plugin.id,
          pluginName: plugin.name,
          skillName: plugin.skillName,
        },
      });
    }
  }
  return out;
}

function resolveSkillMcpServer(plugin: SkillManifest, target = "") {
  const raw = String(target || "").trim();
  const servers = Array.isArray(plugin.mcpServers) ? plugin.mcpServers : [];
  if (!raw && servers.length === 1) return servers[0];
  return servers.find(server => mcpServerMatches(plugin, server, raw)) || null;
}

function mcpServerRef(plugin: Partial<SkillManifest>, server: Partial<SkillMcpServer> = {}) {
  return `${plugin.id || server.pluginId || "plugin"}:${server.id || server.rawId || "default"}`;
}

function mcpServerMatches(plugin: SkillManifest, server: SkillMcpServer, target = "") {
  const raw = String(target || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const slug = lower.replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const candidates = [
    server.id,
    server.rawId,
    server.name,
    mcpServerRef(plugin, server),
    `${plugin.rawId || plugin.id}:${server.rawId || server.id}`,
    `${plugin.id}:${server.rawId || server.id}`,
    `${plugin.skillName || ""}:${server.id || ""}`,
    `${plugin.skillName || ""}:${server.rawId || ""}`,
  ].map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
  return candidates.includes(lower) || (slug && candidates.includes(slug));
}

function listSkillMcpBoundTools(plugin: SkillManifest, server: SkillMcpServer) {
  return (Array.isArray(plugin.tools) ? plugin.tools : [])
    .filter(tool => tool.runtime === "mcp" && tool.mcp && mcpServerMatches(plugin, server, tool.mcp.server))
    .filter(tool => !tool.hidden)
    .map(tool => ({
      name: tool.name,
      localName: tool.localName,
      title: tool.title,
      mcpTool: tool.mcp!.tool,
    }));
}

function listSkillMcpConnectionSummaries(plugin: SkillManifest) {
  return (Array.isArray(plugin.mcpServers) ? plugin.mcpServers : []).map(server => ({
    ...mcpServerResult(server),
    ref: mcpServerRef(plugin, server),
    boundTools: listSkillMcpBoundTools(plugin, server),
  }));
}

function mcpToolMatchesQuery(tool: { name?: string; title?: string; description?: string; server?: string; pluginName?: string; skillName?: string }, query = "") {
  const haystack = [
    tool.name,
    tool.title,
    tool.description,
    tool.server,
    tool.pluginName,
    tool.skillName,
  ].join("\n").toLowerCase();
  return haystack.includes(query);
}

async function executeHostSkillScript(plugin: SkillManifest, tool: SkillTool, scriptArgs: Fields = {}, signal: AbortSignal | undefined, context: ToolContext = {}, executeBuiltinTool: SkillBuiltinExecutor) {
  const startedAt = Date.now();
  runtimeTrace(`[skill] host start plugin=${plugin.id} skill=${plugin.skillName} tool=${tool.name} script=${tool.script}`);
  const binding = resolveSkillHostBinding(plugin, tool, context.language);
  const target = binding?.target;
  const handler = binding?.execute;
  if (!target && typeof handler !== "function") {
    const err = new ToolExecutionError("PLUGIN_HOST_ACTION_UNAVAILABLE", `Skill host action is not registered: ${plugin.id}/${tool.localName || tool.rawName || tool.name}`, {
      pluginId: plugin.id,
      skillName: plugin.skillName,
      tool: tool.name,
      localName: tool.localName,
      script: tool.script,
    });
    runtimeTrace(`[skill] host unavailable plugin=${plugin.id} skill=${plugin.skillName} tool=${tool.name} durationMs=${Date.now() - startedAt}`);
    throw err;
  }
  const traceRows: { time: string; level: string; message: string }[] = [];
  const trace = (...items: unknown[]) => {
    traceRows.push({
      time: new Date().toISOString(),
      level: "trace",
      message: items.map(item => {
        try {
          return typeof item === "string" ? item : JSON.stringify(item);
        } catch (_err) {
          return String(item);
        }
      }).join(" "),
    });
    if (traceRows.length > 80) traceRows.splice(0, traceRows.length - 80);
  };
  const callTool: HostCallTool = async (toolName, toolArgs = {}) => {
    const targetName = String(toolName || "").trim();
    const toolStartedAt = Date.now();
    if (!targetName) throw new Error("Skill host tool call requires a tool name");
    assertSkillExecutionActive(signal);
    trace("tool.start", { tool: targetName, args: copySkillTraceValue(toolArgs || {}) });
    runtimeTrace(`[skill] host tool.start plugin=${plugin.id} hostTool=${tool.name} target=${targetName} args=${summarizeSkillArgsForTrace(toolArgs)}`);
    try {
      const result = await executeBuiltinTool(targetName, toolArgs && typeof toolArgs === "object" ? toolArgs : {}, signal, {
        ...context,
        source: "plugin_host",
        pluginId: plugin.id,
        skillToolName: tool.name,
      });
      trace("tool.end", { tool: targetName, result: copySkillTraceValue(result) });
      runtimeTrace(`[skill] host tool.end plugin=${plugin.id} hostTool=${tool.name} target=${targetName} durationMs=${Date.now() - toolStartedAt} result=${summarizeSkillArgsForTrace(result)}`);
      return result;
    } catch (err) {
      runtimeTrace(`[skill] host tool.error plugin=${plugin.id} hostTool=${tool.name} target=${targetName} code=${record(err).code || ""} message=${err instanceof Error ? err.message : err} durationMs=${Date.now() - toolStartedAt}`);
      throw err;
    }
  };
  try {
    const result = target
      ? await callTool(target, omitHostControlArgs(scriptArgs))
      : await handler!(omitHostControlArgs(scriptArgs), { callTool, tool, signal, context });
    if (tool.includeTrace !== false && result && typeof result === "object" && !Array.isArray(result) && traceRows.length && !record(result).trace) {
      const withTrace = copyToolEffects(result, { ...result, trace: traceRows });
      runtimeTrace(`[skill] host done plugin=${plugin.id} skill=${plugin.skillName} tool=${tool.name} durationMs=${Date.now() - startedAt} result=${summarizeSkillArgsForTrace(withTrace)}`);
      return withTrace;
    }
    runtimeTrace(`[skill] host done plugin=${plugin.id} skill=${plugin.skillName} tool=${tool.name} durationMs=${Date.now() - startedAt} result=${summarizeSkillArgsForTrace(result)}`);
    return result;
  } catch (cause) {
    const err = cause && typeof cause === "object" ? cause as Fields : new ToolExecutionError("PLUGIN_HOST_SCRIPT_FAILED", String(cause));
    if (!err.code) err.code = "PLUGIN_HOST_SCRIPT_FAILED";
    err.details = {
      ...(err.details && typeof err.details === "object" ? err.details : {}),
      pluginId: plugin.id,
      skillName: plugin.skillName,
      tool: tool.name,
      script: tool.script,
      trace: traceRows,
      originalMessage: record(err.details).originalMessage || err.message || String(err),
    };
    runtimeTrace(`[skill] host error plugin=${plugin.id} skill=${plugin.skillName} tool=${tool.name} code=${record(err).code || ""} message=${err instanceof Error ? err.message : err} durationMs=${Date.now() - startedAt}`);
    throw err;
  }
}

async function executeMcpSkillTool(plugin: SkillManifest, tool: SkillTool, inputArgs: Fields = {}, signal?: AbortSignal) {
  const server = resolveSkillMcpServer(plugin, tool.mcp?.server);
  if (!server) {
    const err = new ToolExecutionError("PLUGIN_MCP_SERVER_UNAVAILABLE", `Skill MCP server is unavailable: ${plugin.id}/${tool.localName || tool.rawName || tool.name}`, { pluginId: plugin.id, skillName: plugin.skillName, tool: tool.rawName, server: tool.mcp?.server || "" });
    throw err;
  }
  if (server.enabled === false) {
    const err = new ToolExecutionError("PLUGIN_MCP_SERVER_DISABLED", `Skill MCP server is disabled: ${plugin.id}/${server.id}`, { pluginId: plugin.id, skillName: plugin.skillName, server: server.id });
    throw err;
  }
  const controlArgs = pickSkillToolControlArgs(inputArgs);
  const callServer = {
    ...server,
    ...(controlArgs.timeout != null ? { callTimeoutMs: controlArgs.timeout } : {}),
  };
  const mcpArgs = {
    ...(tool.args || {}),
    ...omitSkillToolControlArgs(inputArgs),
  };
  return await callMcpServerTool(callServer, tool.mcp?.tool, mcpArgs, { signal });
}

/** Used by tool-policy inheritance; handlers with argument transformations stay explicit. */
export function getHostCoreToolTarget(plugin: Partial<SkillManifest> = {}, tool: Partial<SkillTool> = {}) {
  return resolveSkillHostBinding(plugin, tool)?.target || "";
}

function omitHostControlArgs(args: Fields) {
  const { $plugin, timeout, timeoutMs, ...payload } = args;
  return payload;
}

export async function listSkillContributions(context: SkillToolOptions = {}) {
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(context.loadedPluginSkillNames);
  const plugins = skillToolRegistry.plugins.map((plugin) => {
    const active = skillMatchesContext(plugin, context, { loadedPluginSkillNames });
    return {
      id: plugin.id,
      name: plugin.name,
      displayName: plugin.displayName || plugin.name,
      category: plugin.category,
      version: plugin.version,
      description: plugin.description,
      skillName: plugin.skillName,
      activation: plugin.activation,
      active,
      connections: listSkillMcpConnectionSummaries(plugin),
      tools: (plugin.tools || []).filter(tool => !tool.hidden).map(tool => ({
        name: tool.name,
        ...skillToolPresentation(plugin, tool),
        description: tool.description,
        needsPage: tool.needsPage,
      })),
    };
  });
  return {
    plugins,
    diagnostics: skillToolRegistry.diagnostics,
    version: skillToolRegistry.version,
  };
}

export async function listSkillMcpServers(context: ToolContext = {}, options: SkillToolOptions = {}) {
  const registry = getMcpRegistryForContext(context, options);
  const activationContext = resolveSkillActivationContext({ context });
  const includeInactive = options.includeInactive !== false;
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(
    options.loadedPluginSkillNames ?? activationContext.loadedPluginSkillNames,
  );
  return collectMcpSkillServers(registry, activationContext, { includeInactive, loadedPluginSkillNames })
    .map(({ plugin, server }) => ({
      ...mcpServerResult(server),
      ref: mcpServerRef(plugin, server),
      pluginId: plugin.id,
      pluginName: plugin.name,
      skillName: plugin.skillName,
      active: skillMatchesContext(plugin, activationContext, { loadedPluginSkillNames }),
      boundTools: listSkillMcpBoundTools(plugin, server),
    }));
}

export async function listSkillMcpTools(context: ToolContext = {}, options: SkillToolOptions = {}) {
  const registry = getMcpRegistryForContext(context, options);
  const activationContext = resolveSkillActivationContext({ context });
  const serverFilter = String(options.server || "").trim();
  const query = String(options.query || "").trim().toLowerCase();
  const limit = finitePositiveInteger(options.limit) || 50;
  const includeInactive = options.includeInactive !== false;
  const loadedPluginSkillNames = normalizeLoadedSkillToolNamesOption(
    options.loadedPluginSkillNames ?? activationContext.loadedPluginSkillNames,
  );
  const servers = collectMcpSkillServers(registry, activationContext, { includeInactive, loadedPluginSkillNames })
    .filter(entry => !serverFilter || mcpServerMatches(entry.plugin, entry.server, serverFilter));
  const out = [];
  const errors = [];
  for (const { plugin, server } of servers) {
    if (server.enabled === false) continue;
    try {
      const tools = await listMcpServerTools(server, { refresh: options.refresh === true, signal: options.signal || null });
      for (const tool of tools) {
        const boundTool = findMcpSkillToolForRemoteCall(plugin, server, tool.name);
        const item = {
          server: mcpServerRef(plugin, server),
          serverId: server.id,
          pluginId: plugin.id,
          pluginName: plugin.name,
          skillName: plugin.skillName,
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations || {},
          pluginTool: boundTool ? {
            name: boundTool.name,
            localName: boundTool.localName,
            title: boundTool.title,
          } : null,
          renderer: boundTool ? resolveSkillToolRenderer(plugin, boundTool) : null,
        };
        if (query && !mcpToolMatchesQuery(item, query)) continue;
        out.push(item);
        if (out.length >= limit) break;
      }
    } catch (err) {
      errors.push({
        server: mcpServerRef(plugin, server),
        pluginId: plugin.id,
        skillName: plugin.skillName,
        code: record(err).code || "",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (out.length >= limit) break;
  }
  return { tools: out, count: out.length, errors };
}

function findMcpSkillToolForRemoteCall(plugin: SkillManifest, server: SkillMcpServer, remoteToolName = "") {
  const name = String(remoteToolName || "").trim();
  if (!name) return null;
  return (Array.isArray(plugin.tools) ? plugin.tools : []).find(tool => (
    tool.runtime === "mcp"
    && tool.mcp
    && String(tool.mcp.tool || "").trim() === name
    && mcpServerMatches(plugin, server, tool.mcp.server)
  )) || null;
}

function buildSkillToolRegistry(plugins: SkillManifest[] = [], diagnostics: SkillDiagnostic[] = []): SkillToolRegistryCandidate {
  const registryDiagnostics: RegistryDiagnostic[] = Array.isArray(diagnostics) ? [...diagnostics] : [];
  const toolIndex: SkillToolRegistryCandidate["toolIndex"] = new Map();
  const toolOwners = new Map<string, { pluginId: string; skillName: string }>();
  const normalizedSkills: RegisteredSkillManifest[] = (Array.isArray(plugins) ? plugins : []).map(plugin => ({ ...plugin, tools: [] }));

  for (let skillIndex = 0; skillIndex < normalizedSkills.length; skillIndex += 1) {
    const sourceSkill = plugins[skillIndex];
    const plugin = normalizedSkills[skillIndex];
    const tools: RegisteredSkillTool[] = [];
    for (const sourceTool of Array.isArray(sourceSkill.tools) ? sourceSkill.tools : []) {
      const tool = { ...sourceTool };
      if (!tool.hidden) {
        const owner = toolOwners.get(tool.name);
        if (owner) {
          registryDiagnostics.push({
            level: "warning",
            pluginId: plugin.id,
            skillName: plugin.skillName,
            toolName: tool.name,
            message: `Skill tool ignored because runtime name collides with ${owner.pluginId}: ${tool.name}`,
          });
          tools.push({
            ...tool,
            hidden: true,
            disabled: true,
            collision: {
              toolName: tool.name,
              ownerPluginId: owner.pluginId,
              ownerSkillName: owner.skillName,
            },
          });
          continue;
        }
        toolOwners.set(tool.name, { pluginId: plugin.id, skillName: plugin.skillName });
        toolIndex.set(tool.name, { plugin, tool });
      }
      tools.push(tool);
    }
    plugin.tools = tools;
    copySkillManifestTrust(sourceSkill, plugin);
  }

  const snapshots = new Map(normalizedSkills.map(plugin => {
    const snapshot = materializeContribution(plugin);
    copySkillManifestTrust(plugin, snapshot);
    return [plugin, snapshot];
  }));
  for (const [name, entry] of toolIndex) {
    const plugin = snapshots.get(entry.plugin)!;
    toolIndex.set(name, { plugin, tool: plugin.tools.find(tool => tool.name === name)! });
  }
  return { plugins: Object.freeze([...snapshots.values()]) as RegisteredSkillManifest[], diagnostics: materializeContribution(registryDiagnostics), toolIndex };
}

function normalizeSkillRefreshOptions(options: unknown = {}) {
  if (typeof options === "string") {
    return { reason: options || "refresh" };
  }
  const raw = record(options);
  return {
    reason: String(raw.reason || "refresh"),
  };
}

export function publishSkillToolRegistryUpdate(reason: string, snapshot = getSkillToolRegistrySnapshot(), extra: Fields = {}) {
  if (!skillToolRegistryListeners.size) return false;
  const event = {
    type: "plugin_registry_update",
    reason,
    snapshot,
    version: snapshot.version,
    refreshedAt: snapshot.refreshedAt,
    diagnostics: snapshot.diagnostics,
    ...extra,
  };
  runtimeTrace(`[skill] registry broadcast start reason=${reason} version=${snapshot.version} plugins=${snapshot.plugins?.length || 0} tools=${countSkillTools(snapshot)}`);
  let delivered = false;
  for (const listener of skillToolRegistryListeners) {
    try {
      listener(event);
      delivered = true;
    } catch (_err) {
      runtimeTrace(`[skill] registry broadcast error reason=${reason} message=${_err instanceof Error ? _err.message : _err}`);
    }
  }
  runtimeTrace(`[skill] registry broadcast done reason=${reason} version=${snapshot.version}`);
  return delivered;
}

function countSkillTools(snapshot: { plugins?: SkillManifest[] } = {}) {
  return (snapshot.plugins || []).reduce((sum, plugin) => sum + (plugin.tools?.filter(tool => !tool.hidden).length || 0), 0);
}

function copySkillTraceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== "object") return value;
  if (depth >= 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => copySkillTraceValue(item, depth + 1, seen));
  }
  const out: Fields = {};
  for (const [key, raw] of Object.entries(value).slice(0, 50)) {
    out[key] = copySkillTraceValue(raw, depth + 1, seen);
  }
  return out;
}

function buildSkillToolDescription(plugin: SkillManifest, tool: SkillTool) {
  const renderer = resolveSkillToolRenderer(plugin, tool);
  const pageTool = isSkillPageTool(tool);
  const scriptTool = isSkillScriptTool(tool);
  const parts = [
    tool.description || tool.title || tool.rawName,
    skillToolT("source", { name: plugin.name }),
    plugin.category?.label ? skillToolT("category", { label: plugin.category.label }) : "",
    plugin.skillName ? `Skill: ${plugin.skillName}` : "",
    plugin.skillName ? skillToolT("loadInstructions", { name: JSON.stringify(plugin.skillName) }) : "",
    tool.runtime === "mcp" && tool.mcp ? skillToolT("mcpRuntime", { server: mcpServerRef(plugin, resolveSkillMcpServer(plugin, tool.mcp.server) || { id: tool.mcp.server }), tool: tool.mcp.tool }) : "",
    tool.runtime === "inner" ? skillToolT("innerRuntime") : "",
    pageTool ? skillToolT("pageTarget") : "",
    scriptTool
      ? skillToolT("requiredTimeout")
      : skillToolT("optionalTimeout"),
    renderer ? buildSkillRendererReturnContract(renderer) : "",
  ].filter(Boolean);
  const description = parts.join("\n");
  return pageTool ? description.replace(/\btabId\b/g, "tabRef") : description;
}

function withSkillToolControlParameters(parameters: ToolSchema, tool: Partial<SkillTool> = {}): ToolSchema {
  const input = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? parameters
    : { type: "object", properties: {} };
  const next: ToolSchema & { properties: Record<string, ToolParameter> } = {
    ...input,
    type: "object",
    properties: {
      ...(input.properties && typeof input.properties === "object" && !Array.isArray(input.properties)
        ? input.properties
        : {}),
    },
  };
  if (isSkillScriptTool(tool)) {
    const { timeout: _timeout, ...restProperties } = next.properties;
    next.properties = {
      timeout: { ...SKILL_SCRIPT_TOOL_TIMEOUT_SECONDS_PROPERTY },
      ...restProperties,
    };
    next.required = uniqueRequired(["timeout", ...(Array.isArray(next.required) ? next.required : [])]);
    if (isSkillPageTool(tool)) {
      next.properties.tabId = normalizeSkillToolTabIdProperty(next.properties.tabId);
    }
  } else if (!next.properties.timeout) {
    next.properties.timeout = { ...SKILL_TOOL_TIMEOUT_SECONDS_PROPERTY };
  }
  return next;
}

function isSkillScriptTool(tool: Partial<SkillTool> = {}) {
  return Boolean(tool?.script) && (tool.runtime || "page") !== "mcp";
}

export function isSkillPageTool(tool: Partial<SkillTool> = {}) {
  return (tool.runtime || "page") === "page" && tool.needsPage !== false;
}

function normalizeSkillToolTabIdProperty(property?: ToolParameter): ToolParameter {
  const input = property && typeof property === "object" && !Array.isArray(property)
    ? property
    : SKILL_TOOL_TAB_ID_PROPERTY;
  const currentDescription = String(input.description || "").trim();
  const description = currentDescription && currentDescription.includes("当前任务已拥有")
    ? currentDescription
    : [currentDescription, SKILL_TOOL_TAB_ID_PROPERTY.description].filter(Boolean).join(" ");
  return {
    ...input,
    type: input.type || "number",
    description,
  };
}

function pickSkillToolControlArgs(args: Fields = {}) {
  const timeout = args?.timeoutMs != null
    ? finitePositiveInteger(args.timeoutMs)
    : secondsToMs(args?.timeout);
  return {
    ...(timeout != null ? { timeout } : {}),
  };
}

function pickRequiredScriptSkillToolControlArgs(args: Fields = {}, name = "") {
  if (!Object.prototype.hasOwnProperty.call(args || {}, "timeout")) {
    const err = new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", `Skill script tool ${name} requires timeout in seconds`, { name, missing: ["timeout"], unit: "seconds" });
    throw err;
  }
  const timeout = finiteNumber(args.timeout);
  if (timeout == null) {
    const err = new ToolExecutionError("INVALID_TIMEOUT", `Skill script tool ${name} timeout must be a number of seconds`, { name, unit: "seconds", value: args.timeout });
    throw err;
  }
  return { timeout };
}

function omitSkillToolControlArgs(args: Fields = {}) {
  const out = { ...(args && typeof args === "object" && !Array.isArray(args) ? args : {}) };
  delete out.timeout;
  delete out.timeoutMs;
  return out;
}

function uniqueRequired(items: readonly string[] = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

function finiteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function secondsToMs(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n * 1000)) : null;
}

function finitePositiveInteger(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function skillToolPresentation(plugin: SkillManifest, tool: SkillTool) {
  return {
    capabilityId: tool.capabilityId,
    ...(tool.rendererId ? { rendererId: tool.rendererId } : {}),
    localName: tool.localName,
    title: tool.title,
    familyId: tool.familyId,
    familyTitle: tool.familyTitle,
    profileFamily: tool.profileFamily,
    resultFamily: tool.resultFamily,
    labelerId: tool.labelerId,
    pageContext: tool.pageContext,
    detailLayout: tool.detailLayout,
    mediaPresentation: tool.mediaPresentation,
    script: tool.script || "",
    runtime: tool.runtime || "page",
    mcp: tool.mcp || null,
    renderer: resolveSkillToolRenderer(plugin, tool),
  };
}

function normalizeSkillToolResult(plugin: SkillManifest, tool: SkillTool, result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const meta = {
    id: plugin.id,
    name: plugin.name,
    displayName: plugin.displayName || plugin.name,
    category: plugin.category,
    skillName: plugin.skillName,
    tool: tool.name,
    ...skillToolPresentation(plugin, tool),
  };
  const next: Fields = {
    ...record(result),
    _plugin: meta,
  };
  const nestedResult = record(result).result;
  if (nestedResult && typeof nestedResult === "object" && !Array.isArray(nestedResult)) {
    next.result = {
      ...nestedResult,
      _plugin: meta,
    };
  }
  return copyToolEffects(result, next);
}

function resolveSkillToolRenderer(plugin: SkillManifest, tool: SkillTool) {
  return tool.renderer
    || plugin.renderers?.tools?.[tool.name]
    || plugin.renderers?.tools?.[tool.localName]
    || plugin.renderers?.tools?.[tool.rawName]
    || null;
}

function record(value: unknown): Fields { return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {}; }
function isRegistrySnapshot(value: unknown): value is SkillToolRegistrySnapshot {
  const snapshot = record(value);
  return snapshot.toolIndex instanceof Map && Array.isArray(snapshot.plugins);
}

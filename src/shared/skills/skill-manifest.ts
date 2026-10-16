import { t } from "../i18n/backend.js";
import {
  getSkillDisplayName,
  isModernSkillRecord,
  normalizeSkill,
  normalizeStringList as normalizeSkillStringList,
} from "./skill-utils.js";
import {
  SKILL_LAYOUT_COMPONENT_TYPES,
  SKILL_RENDERER_SOURCES,
  SKILL_RENDERER_TYPES,
} from "./skill-renderers.js";
import {
  getCoreToolMetadata,
  getToolFamilyMetadata,
} from "../tools/tool-metadata.js";
import {
  normalizeSkillNetwork,
  normalizeSkillSettings,
} from "./skill-settings.js";

import type { ToolSchema } from '../contracts/tool.js';
import type { ToolMetadata } from '../tools/tool-metadata.js';
import type { JsonValue } from '../contracts/json.js';
import type { SkillRenderer, SkillRendererField, SkillRendererLayout } from './skill-renderers.js';
import type { SkillSettings, SkillNetworkPolicy, SkillDiagnostic, SkillDiagnosticContext } from './skill-settings.js';

type Data = Record<string, unknown>;
interface SkillActivation { mode: string; domains: string[]; urlPatterns: string[]; excludePatterns?: string[] }
interface SkillManifestIdentity {
  id: string; name: string; displayName: string; skillName: string; skillBuiltin: boolean;
  skillReadOnly: boolean; skillSource: string; category: { id: string; label: string };
}
/** A tool declared by an installed Skill; pluginId is its legacy manifest namespace on the wire. */
export interface SkillTool extends Omit<ToolMetadata, 'sets'> {
  rendererId?: string;
  id: string; pluginId: string; skillName: string; name: string; capabilityId: string; source: string;
  localName: string; rawName: string; description: string; parameters: ToolSchema; familyTitle: string;
  script: string; runtime: 'page' | 'inner' | 'host' | 'mcp'; mcp: { server: string; rawServer: string; tool: string } | null;
  needsPage: boolean; hidden: boolean; includeTrace: boolean; args: Data; renderer: SkillRenderer | null;
}
export interface SkillManifest extends SkillManifestIdentity {
  rawId: string; format: string; schemaVersion: number; rawName: string; version: string; description: string;
  skillDisplayName: string; skillDescription: string; skillScope: string; skillDomains: string[]; skillUrlPatterns: string[];
  status: string; activation: SkillActivation; permissions: string[];
  settings: SkillSettings; network: SkillNetworkPolicy; mcpServers: SkillMcpServer[]; tools: SkillTool[];
  ui: { layout: SkillRendererLayout }; renderers: { tools: Record<string, SkillRenderer> }; diagnostics: SkillDiagnostic[];
}
export type SkillMcpServer = NonNullable<ReturnType<typeof normalizeSkillMcpServer>>;
export interface SkillActivationContext {
  loadedPluginSkillNames?: unknown; pageUrl?: string; workingTab?: { url?: string } | null;
  taskSiteTabs?: readonly { url?: string }[];
}
type SkillRef = ReturnType<typeof normalizeSkillManifestOwner>;

import { SKILL_MANIFEST_PATH, SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "./skill-format.js";
export { SKILL_MANIFEST_PATH, SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from "./skill-format.js";
import { isTrustedEmbeddedSkill, trustSkillManifest } from "./skill-provenance.js";

const TOOL_NAME_MAX = 64;

export function discoverSkillManifests(skills: unknown = []) {
  const plugins = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!isModernSkillRecord(skill)) continue;
    const normalizedSkill = normalizeSkillManifestOwner(skill);
    if (!normalizedSkill.name || normalizedSkill.status === "disabled") continue;
    const manifestResource = findSkillManifestResource(normalizedSkill.resources);
    if (!manifestResource) continue;
    const parsed = parseSkillManifest(manifestResource.content, skill);
    if (parsed.plugin) plugins.push(parsed.plugin);
    diagnostics.push(...parsed.diagnostics);
  }
  return { plugins, diagnostics };
}

export function findSkillManifestResource(resources: readonly { path?: unknown; content?: unknown }[] = []) {
  return (Array.isArray(resources) ? resources : []).find((resource) => {
    const path = normalizeSkillPath(resource?.path);
    return path === SKILL_MANIFEST_PATH;
  }) || null;
}

export function parseSkillManifest(content: unknown = "", skill: Data = {}): { plugin: SkillManifest | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  let manifest = null;
  try {
    manifest = JSON.parse(String(content || "{}"));
  } catch (err) {
    return {
      plugin: null,
      diagnostics: [{
        level: "error",
        skillName: String(skill.name || ""),
        path: SKILL_MANIFEST_PATH,
        message: `Invalid qingzhou Skill manifest JSON: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }
  if (!isModernSkillManifest(manifest)) {
    diagnostics.push({
      level: "warning",
      skillName: String(skill.name || ""),
      path: SKILL_MANIFEST_PATH,
      message: `Ignored Skill manifest: expected format "${SKILL_MANIFEST_FORMAT}" and schemaVersion ${SKILL_MANIFEST_SCHEMA_VERSION}.`,
    });
    return { plugin: null, diagnostics };
  }
  const plugin = normalizeSkillManifest(manifest, skill, diagnostics);
  return { plugin, diagnostics };
}

export function isModernSkillManifest(input: unknown = {}): input is Data {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const manifest = input as Data;
  return String(manifest.format || "").trim() === SKILL_MANIFEST_FORMAT
    && Number(manifest.schemaVersion) === SKILL_MANIFEST_SCHEMA_VERSION;
}

export function normalizeSkillManifest(manifest: Data = {}, skill: Data = {}, diagnostics: SkillDiagnostic[] = []): SkillManifest | null {
  const skillRef = normalizeSkillManifestOwner(skill);
  const rawId = String(manifest.id || "").trim();
  const id = slugIdentifier(rawId || "plugin");
  if (!rawId || !id) {
    diagnostics.push({
      level: "error",
      skillName: skillRef.name,
      path: SKILL_MANIFEST_PATH,
      message: "Skill manifest ignored: id is required.",
    });
    return null;
  }
  const displayName = normalizeSkillDisplayName(manifest, rawId, id);
  const category = normalizeSkillCategory(manifest);
  const plugin: SkillManifest = {
    id,
    rawId,
    format: SKILL_MANIFEST_FORMAT,
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    name: displayName,
    displayName,
    rawName: displayName,
    category,
    version: String(manifest.version || "").trim(),
    description: String(manifest.description || "").trim(),
    skillName: skillRef.name,
    skillDisplayName: skillRef.displayName,
    skillDescription: skillRef.description,
    skillScope: skillRef.scope,
    skillSource: skillRef.source,
    skillBuiltin: skillRef.builtin,
    skillReadOnly: skillRef.readOnly,
    skillDomains: skillRef.domains,
    skillUrlPatterns: skillRef.urlPatterns,
    status: normalizeSkillStatus(manifest.status || skillRef.status),
    activation: normalizeSkillActivation(manifest.activation, skillRef),
    permissions: normalizeSkillStringList(manifest.permissions),
    settings: { title: "", description: "", fields: [], layout: { sections: [] } },
    network: normalizeSkillNetwork(),
    mcpServers: [],
    tools: [],
    ui: {
      layout: { type: "stack", blocks: [] },
    },
    renderers: { tools: {} },
    diagnostics,
  };

  plugin.settings = normalizeSkillSettings(manifest.settings, diagnostics, {
    pluginId: plugin.id,
    skillName: plugin.skillName,
  });
  plugin.network = normalizeSkillNetwork(manifest.network, diagnostics, {
    pluginId: plugin.id,
    skillName: plugin.skillName,
  });
  plugin.network.allowedOrigins = plugin.network.allowedOrigins.filter(declaration => {
    if (!declaration.setting) return true;
    const field = plugin.settings.fields.find(item => item.key === declaration.setting);
    if (field?.type === "url") return true;
    diagnostics.push({
      level: "warning",
      pluginId: plugin.id,
      skillName: plugin.skillName,
      message: t("skill.networkSettingReference", { setting: String(declaration.setting) }),
    });
    return false;
  });
  plugin.mcpServers = normalizeSkillMcpServers(manifest, plugin, diagnostics);
  const resource = findSkillManifestResource(skillRef.resources);
  const trusted = isTrustedEmbeddedSkill(skill) && resource
    && JSON.stringify(manifest) === JSON.stringify(JSON.parse(String(resource.content)));
  plugin.tools = normalizeSkillTools(manifest.tools, plugin, diagnostics, Boolean(trusted));
  plugin.renderers = normalizeSkillRenderers(manifest.renderers, plugin, diagnostics);
  plugin.ui.layout = normalizeSkillUILayout(objectOrNull(manifest.ui)?.layout, diagnostics, { pluginId: plugin.id, scope: "ui.layout" });
  return trusted ? trustSkillManifest(plugin) : plugin;
}

export function normalizeSkillToolName(pluginId: unknown = "", localName: unknown = "") {
  const prefix = slugIdentifier(pluginId || "plugin").replace(/-/g, "_");
  const name = slugIdentifier(localName || "tool").replace(/-/g, "_");
  const joined = `${prefix}__${name}`;
  return joined.slice(0, TOOL_NAME_MAX).replace(/_+$/g, "") || "plugin_tool";
}

export function normalizeSkillPath(path: unknown = "") {
  return String(path || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export { normalizeSkillStringList };

export function skillMatchesContext(plugin: Partial<SkillManifest> = {}, context: SkillActivationContext = {}, options: { loadedPluginSkillNames?: unknown } = {}) {
  if (!plugin || plugin.status === "disabled") return false;
  if (isResidentSkill(plugin)) return true;

  const loadedSkillNames = normalizeLoadedSkillToolNames(options.loadedPluginSkillNames ?? context.loadedPluginSkillNames);
  if (loadedSkillNames.has(normalizeSkillNameForActivation(plugin.skillName))
    || loadedSkillNames.has(normalizeSkillNameForActivation(plugin.skillDisplayName))) {
    return true;
  }

  if (plugin.skillScope !== "site") return false;
  const urls = collectSkillContextUrls(context);
  if (!urls.length) return false;
  return urls.some((url) => skillActivationMatchesUrl(plugin.activation || {}, url));
}

function isResidentSkill(plugin: Partial<SkillManifest> = {}) {
  return String(plugin.skillScope || "").trim().toLowerCase() === "resident";
}

function normalizeLoadedSkillToolNames(value: unknown) {
  const raw = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : value && typeof value === "object"
        ? Object.keys(value).filter(key => (value as Data)[key])
        : [];
  return new Set(raw.map(normalizeSkillNameForActivation).filter(Boolean));
}

function normalizeSkillNameForActivation(value: unknown = "") {
  return String(value || "").trim().toLowerCase();
}

export function collectSkillContextUrls(context: SkillActivationContext = {}) {
  const urls: string[] = [];
  const push = (value: unknown) => {
    const text = String(value || "").trim();
    if (text) urls.push(text);
  };
  push(context.pageUrl);
  push(context.workingTab?.url);
  for (const tab of Array.isArray(context.taskSiteTabs) ? context.taskSiteTabs : []) push(tab?.url);
  return [...new Set(urls)];
}

export function skillActivationMatchesUrl(activation: Partial<SkillActivation> = {}, rawUrl = "") {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (_err) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const href = url.href;
  const path = `${url.pathname || "/"}${url.search || ""}`;
  const domains = normalizeSkillStringList(activation.domains);
  const domainMatched = domains.length
    ? domains.some((domain) => {
      const clean = String(domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return clean && (host === clean || host.endsWith(`.${clean}`));
    })
    : true;
  if (!domainMatched) return false;
  if (normalizeSkillStringList(activation.excludePatterns).some(pattern => skillPatternMatches(pattern, href, path))) return false;
  const patterns = normalizeSkillStringList(activation.urlPatterns);
  if (!patterns.length) return true;
  return patterns.some((pattern) => skillPatternMatches(pattern, href, path));
}

function normalizeSkillManifestOwner(skill: Data = {}) {
  const normalized = normalizeSkill(skill);
  return {
    name: String(normalized.name || "").trim(),
    displayName: getSkillDisplayName(normalized),
    description: String(normalized.description || "").trim(),
    status: String(normalized.status || "active").trim().toLowerCase() || "active",
    scope: String(normalized.scope || "global").trim().toLowerCase() || "global",
    source: String(normalized.source || "").trim().toLowerCase(),
    builtin: normalized.builtin === true,
    readOnly: normalized.readOnly === true,
    domains: normalizeSkillStringList(normalized.domains),
    urlPatterns: normalizeSkillStringList(normalized.urlPatterns),
    excludePatterns: normalizeSkillStringList(normalized.excludePatterns),
    resources: Array.isArray(normalized.resources) ? normalized.resources : [],
  };
}

function normalizeSkillStatus(status: unknown = "") {
  const value = String(status || "active").trim().toLowerCase();
  return value === "disabled" ? "disabled" : "active";
}

function normalizeSkillActivation(value: unknown, skill: SkillRef): SkillActivation {
  const input = objectOrNull(value) || {};
  const inferredSite = skill.scope === "site" && (skill.domains.length || skill.urlPatterns.length);
  return {
    mode: inferredSite ? "site" : "global",
    domains: normalizeSkillStringList(Array.isArray(input.domains) ? input.domains : skill.domains),
    urlPatterns: normalizeSkillStringList(Array.isArray(input.urlPatterns) ? input.urlPatterns : skill.urlPatterns),
    ...(skill.excludePatterns.length ? { excludePatterns: skill.excludePatterns } : {}),
  };
}

function normalizeSkillDisplayName(manifest: Data = {}, rawId = "", id = "") {
  return String(
    manifest.displayName
      || rawId
      || id,
  ).trim() || id;
}

function normalizeSkillCategory(manifest: Data = {}) {
  const input = objectOrNull(manifest.category);
  const rawId = String(input?.id || input?.name || "extension").trim();
  const id = slugIdentifier(rawId || "extension");
  const label = String(
    input?.label
      || input?.title
      || input?.displayName
      || rawId
      || t("common.extension"),
  ).trim() || t("common.extension");
  return { id, label: id === "extension" && label === "extension" ? t("common.extension") : label };
}

function normalizeSkillMcpServers(manifest: Data, plugin: SkillManifestIdentity, diagnostics: SkillDiagnostic[]): SkillMcpServer[] {
  const entries: [unknown, Data][] = [];
  const pushServer = (id: unknown, value: unknown) => {
    const input = objectOrNull(value);
    if (!input) return;
    entries.push([id, input]);
  };

  const rawServers = manifest.mcpServers ?? objectOrNull(manifest.connections)?.mcpServers;
  if (Array.isArray(rawServers)) {
    rawServers.forEach((server, index) => pushServer(server?.id || server?.name || `server_${index + 1}`, server));
  } else if (objectOrNull(rawServers)) {
    for (const [id, server] of Object.entries(objectOrNull(rawServers) || {})) pushServer(id, server);
  }

  const runtime = objectOrNull(manifest.runtime);
  if (runtime && String(runtime.type || "").trim().toLowerCase() === "mcp") {
    const server = objectOrNull(runtime.server) || runtime;
    pushServer(server?.id || server?.name || runtime?.serverId || "default", server);
  }

  const seen = new Set();
  const out = [];
  for (const [rawKey, value] of entries) {
    const server = normalizeSkillMcpServer(rawKey, value, plugin, diagnostics);
    if (!server) continue;
    const key = server.id;
    if (seen.has(key)) {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Duplicate MCP server ignored: ${rawKey}` });
      continue;
    }
    seen.add(key);
    out.push(server);
  }
  return out;
}

function normalizeSkillMcpServer(rawKey: unknown, value: unknown, plugin: SkillManifestIdentity, diagnostics: SkillDiagnostic[]) {
  const input = objectOrNull(value);
  if (!input) return null;
  const rawId = String(input.id || input.name || rawKey || "default").trim() || "default";
  const id = slugIdentifier(rawId);
  const url = normalizeMcpHttpUrl(input.url || input.endpoint || input.baseUrl);
  if (!url) {
    diagnostics.push({ level: "warning", pluginId: plugin.id, message: `MCP server ignored because url is required and must be http(s): ${rawId}` });
    return null;
  }
  const type = String(input.type || input.transport || "remote").trim().toLowerCase();
  if (type && !["remote", "http", "https", "mcp"].includes(type)) {
    diagnostics.push({ level: "warning", pluginId: plugin.id, message: `MCP server ignored because only remote HTTP transport is supported: ${rawId}` });
    return null;
  }
  return {
    id,
    rawId,
    pluginId: plugin.id,
    pluginName: plugin.name,
    skillName: plugin.skillName,
    name: String(input.displayName || input.name || rawId).trim() || rawId,
    type: "remote",
    transport: "http",
    url,
    enabled: input.enabled !== false,
    headers: normalizeMcpHeaders(input.headers),
    timeoutMs: normalizeMcpTimeout(input.timeoutMs ?? input.timeout),
    callTimeoutMs: normalizeMcpTimeout(input.callTimeoutMs),
  };
}

function normalizeMcpHttpUrl(value: unknown = "") {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch (_err) {
    return "";
  }
}

export function normalizeMcpHeaders(headers: unknown = {}) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key || "").trim();
    if (!name || /[\r\n:]/.test(name)) continue;
    if (value == null) continue;
    out[name] = String(value);
  }
  return out;
}

function normalizeMcpTimeout(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function normalizeSkillUILayout(layout: unknown = null, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillRendererLayout {
  const input = objectOrNull(layout);
  if (!input) return { type: "stack", blocks: [] };
  const type = String(input.type || "stack").trim();
  return {
    type: type === "stack" ? "stack" : (SKILL_LAYOUT_COMPONENT_TYPES.has(type) ? type : "stack"),
    title: cleanString(input.title),
    subtitle: cleanString(input.subtitle),
    blocks: Array.isArray(input.blocks)
      ? input.blocks.map(block => normalizeSkillLayoutBlock(block, diagnostics, context)).filter((block): block is SkillRenderer => block !== null)
      : [],
  };
}

function normalizeSkillLayoutBlock(block: unknown = {}, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillRenderer | null {
  const input = objectOrNull(block);
  if (!input) return null;
  const rawType = String(input.type || "").trim();
  if (rawType === "selection") {
    diagnostics.push({ level: "error", pluginId: context.pluginId, message: "Selection must be a top-level tool renderer." });
    return null;
  }
  if (rawType && !SKILL_RENDERER_TYPES.has(rawType)) {
    diagnostics.push({
      level: "warning",
      pluginId: context.pluginId,
      message: `Skill layout block ignored because renderer type is unknown: ${rawType}`,
    });
    return null;
  }
  const type = rawType || "summary";
  return normalizeSkillToolRenderer({
    ...input,
    type,
    sourcePath: input.sourcePath,
  }, diagnostics, context);
}

function normalizeSkillTools(tools: unknown, plugin: SkillManifest, diagnostics: SkillDiagnostic[], trusted = false): SkillTool[] {
  const seen = new Set();
  const out: SkillTool[] = [];
  for (const raw of Array.isArray(tools) ? tools : []) {
    const item = objectOrNull(raw) || {};
    const rawName = String(item?.name || "").trim();
    if (!rawName) continue;
    const localName = slugIdentifier(rawName);
    if (!localName) {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Skill tool ignored because name is not a valid identifier: ${rawName}` });
      continue;
    }
    const runtimeName = normalizeSkillToolName(plugin.id, rawName);
    if (seen.has(runtimeName)) {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Duplicate Skill tool ignored: ${rawName}` });
      continue;
    }
    seen.add(runtimeName);
    const runtime = normalizeSkillToolRuntime(item.runtime, item);
    const mcp = normalizeSkillToolMcpBinding(item, plugin, diagnostics, rawName);
    const script = normalizeSkillPath(item.script || "");
    if (!script && runtime !== "mcp") {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Skill tool ignored because script is required: ${rawName}` });
      continue;
    }
    if (runtime === "mcp" && !mcp) {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Skill MCP tool ignored because mcp.server and mcp.tool are required: ${rawName}` });
      continue;
    }
    const parameters = normalizeToolParameters(item.parameters);
    const capabilityId = normalizeSkillToolCapabilityId(item.capabilityId, runtimeName, plugin, diagnostics, rawName, trusted);
    const capabilityMeta = getCoreToolMetadata(capabilityId);
    const needsPage = runtime === "page" ? item.needsPage !== false : false;
    const family = resolveSkillToolFamily(plugin, runtime, capabilityMeta);
    out.push({
      id: `${plugin.id}:${localName}`,
      pluginId: plugin.id,
      skillName: plugin.skillName,
      name: runtimeName,
      capabilityId,
      ...(typeof item.rendererId === "string" && item.rendererId.trim() ? { rendererId: item.rendererId.trim() } : {}),
      source: "plugin",
      localName,
      rawName,
      title: capabilityMeta?.title || String(item.title || rawName).trim() || rawName,
      description: String(item.description || item.title || rawName).trim(),
      parameters,
      familyId: family.id,
      familyTitle: family.title,
      profileFamily: capabilityMeta?.profileFamily || "",
      resultFamily: capabilityMeta?.resultFamily || "generic",
      labelerId: capabilityMeta?.labelerId || "static",
      pageContext: capabilityMeta ? capabilityMeta.pageContext : needsPage,
      detailLayout: capabilityMeta?.detailLayout || "detail",
      mediaPresentation: capabilityMeta?.mediaPresentation || "",
      script,
      runtime,
      mcp: runtime === "mcp" ? mcp : null,
      needsPage,
      hidden: item.hidden === true,
      includeTrace: item.includeTrace !== false,
      args: { ...(objectOrNull(item.args) || {}) },
      renderer: normalizeSkillToolRenderer(item.renderer, diagnostics, { pluginId: plugin.id, toolName: rawName }),
    });
  }
  return out;
}

function resolveSkillToolFamily(plugin: SkillManifestIdentity, runtime = "page", capabilityMeta: ToolMetadata | null = null) {
  if (capabilityMeta) {
    return { id: capabilityMeta.familyId || "other", title: "" };
  }
  const categoryId = String(plugin.category?.id || plugin.id || "extension").trim() || "extension";
  const categoryTitle = String(plugin.category?.label || plugin.displayName || plugin.name || t("common.extension")).trim() || t("common.extension");
  const defaultCategory = categoryId === "extension" && ["", "extension", "扩展"].includes(categoryTitle.toLowerCase());
  if (runtime === "mcp" && defaultCategory) {
    const family = getToolFamilyMetadata("mcp");
    return { id: family.id, title: family.title };
  }
  return { id: `plugin:${categoryId}`, title: categoryTitle };
}

function normalizeSkillToolCapabilityId(value: unknown, runtimeName: string, plugin: SkillManifestIdentity, diagnostics: SkillDiagnostic[], rawName = "", trustedBuiltin = false) {
  const requested = String(value || "").trim();
  if (!requested) return runtimeName;
  if (!trustedBuiltin) {
    diagnostics.push({
      level: "warning",
      pluginId: plugin.id,
      message: `Skill tool capabilityId ignored because it is reserved for built-in tools: ${rawName}`,
    });
    return runtimeName;
  }
  // Registered source identity authorizes aliases; display metadata is optional.
  return requested;
}

function normalizeSkillToolRuntime(value: unknown = "", item: Data = {}): SkillTool["runtime"] {
  const input = objectOrNull(value);
  const raw = String(input?.type || value || "").trim().toLowerCase();
  if (raw === "mcp" || item?.mcp || item?.mcpTool) return "mcp";
  if (raw === "host") return "host";
  if (raw === "inner") return "inner";
  return "page";
}

function normalizeSkillToolMcpBinding(item: Data, plugin: SkillManifest, diagnostics: SkillDiagnostic[], rawName = "") {
  const runtime = objectOrNull(item.runtime);
  const input = objectOrNull(item.mcp) || {};
  const defaultServer = plugin.mcpServers?.[0]?.id || "";
  const rawServer = String(input.server || input.serverId || runtime?.server || runtime?.serverId || item.mcpServer || defaultServer).trim();
  const rawTool = String(input.tool || input.name || runtime?.tool || runtime?.toolName || item.mcpTool || "").trim();
  if (!rawServer && !rawTool && !item.mcp && !item.mcpTool) return null;
  const tool = rawTool;
  if (!rawServer || !tool) return null;
  const server = slugIdentifier(rawServer);
  if (Array.isArray(plugin.mcpServers) && plugin.mcpServers.length && !plugin.mcpServers.some(item => item.id === server || item.rawId === rawServer)) {
    diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Skill MCP tool references an unknown server "${rawServer}": ${rawName}` });
  }
  return {
    server,
    rawServer,
    tool,
  };
}

function normalizeToolParameters(value: unknown = {}): ToolSchema {
  const parameters = objectOrNull(value);
  if (!parameters) {
    return { type: "object", properties: {} };
  }
  const type = "object";
  return {
    ...parameters,
    type,
    properties: parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
      ? { ...parameters.properties } as ToolSchema["properties"]
      : {},
  };
}

function resolveSkillToolReference(plugin: SkillManifest, toolName = "") {
  const raw = String(toolName || "").trim();
  if (!raw) return "";
  const found = (plugin.tools || []).find(tool => tool.rawName === raw || tool.localName === slugIdentifier(raw) || tool.name === raw);
  return found?.name || normalizeSkillToolName(plugin.id, raw);
}

function normalizeSkillRenderers(value: unknown, plugin: SkillManifest, diagnostics: SkillDiagnostic[]): SkillManifest["renderers"] {
  const renderers = objectOrNull(value);
  if (!renderers) return { tools: {} };
  const toolRenderers: Record<string, SkillRenderer> = {};
  const source = objectOrNull(renderers.tools);
  if (!source) return { tools: {} };
  for (const [key, value] of Object.entries(source)) {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) continue;
    const toolName = resolveSkillToolReference(plugin, cleanKey);
    const tool = (plugin.tools || []).find(item => item.name === toolName);
    if (!tool) {
      diagnostics.push({ level: "warning", pluginId: plugin.id, message: `Skill renderer ignored for unknown tool: ${cleanKey}` });
      continue;
    }
    const renderer = normalizeSkillToolRenderer(value, diagnostics, { pluginId: plugin.id, toolName: cleanKey });
    if (renderer) toolRenderers[tool.name] = renderer;
  }
  return { tools: toolRenderers };
}

function normalizeSkillToolRenderer(renderer: unknown = null, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillRenderer | null {
  const input = objectOrNull(renderer);
  if (!input) return null;
  const requestedType = String(input.type || "").trim();
  if (requestedType && !SKILL_RENDERER_TYPES.has(requestedType)) {
    diagnostics.push({
      level: "warning",
      pluginId: context.pluginId,
      message: `Skill renderer ignored because type is unknown: ${requestedType}`,
    });
    return null;
  }
  const type = requestedType || "summary";
  const requestedSource = cleanString(input.source);
  if (type === "selection" && (requestedSource === "args" || objectOrNull(input.layout))) {
    diagnostics.push({ level: "error", pluginId: context.pluginId, message: "Selection requires the tool result and a top-level renderer without layout blocks." });
    return null;
  }
  if (type === "selection" && input.selectionMode != null && !["single", "multiple"].includes(String(input.selectionMode))) {
    diagnostics.push({ level: "error", pluginId: context.pluginId, message: "Selection mode must be single or multiple." });
    return null;
  }
  if (requestedSource && !SKILL_RENDERER_SOURCES.has(requestedSource)) {
    diagnostics.push({
      level: "warning",
      pluginId: context.pluginId,
      message: `Skill renderer source ignored because it is unknown: ${requestedSource}`,
    });
  }
  const layout = normalizeSkillUILayout(input.layout, diagnostics, context);
  const normalized: SkillRenderer = {
    type,
    source: SKILL_RENDERER_SOURCES.has(requestedSource) ? requestedSource : "",
    action: type === "skill" ? normalizeSkillResourceRendererAction(input.action) : "",
    title: cleanString(input.title),
    subtitle: cleanString(input.subtitle),
    titlePath: cleanString(input.titlePath),
    subtitlePath: cleanString(input.subtitlePath),
    titleFormat: cleanString(input.titleFormat),
    subtitleFormat: cleanString(input.subtitleFormat),
    sourcePath: cleanString(input.sourcePath),
    empty: cleanString(input.empty),
    valuePath: cleanString(input.valuePath),
    format: cleanString(input.format),
    fields: normalizeSkillRendererFields(input.fields, diagnostics, context),
    columns: normalizeSkillRendererFields(input.columns, diagnostics, context),
    itemsPath: cleanString(input.itemsPath),
    totalPath: cleanString(input.totalPath),
    truncatedPath: cleanString(input.truncatedPath),
    itemTitlePath: cleanString(input.itemTitlePath || "title"),
    itemSubtitlePath: cleanString(input.itemSubtitlePath || "url"),
    itemMeta: normalizeSkillRendererFields(input.itemMeta, diagnostics, context),
    authorPath: cleanString(input.authorPath),
    timePath: cleanString(input.timePath),
    sourceNamePath: cleanString(input.sourceNamePath || input.articleSourcePath),
    urlPath: cleanString(input.urlPath),
    bodyPath: cleanString(input.bodyPath),
    bodyFormat: cleanString(input.bodyFormat),
    metaFields: normalizeSkillRendererFields(input.metaFields, diagnostics, context),
    commentsPath: cleanString(input.commentsPath),
    commentsTitle: cleanString(input.commentsTitle),
    commentTitlePath: cleanString(input.commentTitlePath),
    commentAuthorPath: cleanString(input.commentAuthorPath),
    commentBodyPath: cleanString(input.commentBodyPath),
    commentTimePath: cleanString(input.commentTimePath),
    commentMeta: normalizeSkillRendererFields(input.commentMeta, diagnostics, context),
    maxBodyChars: normalizePositiveInteger(input.maxBodyChars),
    maxComments: normalizePositiveInteger(input.maxComments),
    language: cleanString(input.language),
    languagePath: cleanString(input.languagePath),
    filenamePath: cleanString(input.filenamePath),
    maxItems: normalizePositiveInteger(input.maxItems),
    states: normalizeSkillRendererStates(input.states, diagnostics, context),
    layout,
    ...(type === "selection" ? {
      itemIdPath: cleanString(input.itemIdPath || "id"),
      itemImagePath: cleanString(input.itemImagePath),
      itemSubtitlePath: cleanString(input.itemSubtitlePath || "description"),
      selectionMode: input.selectionMode === "single" ? "single" as const : "multiple" as const,
      submitLabel: cleanString(input.submitLabel),
      required: input.required !== false,
    } : {}),
  };
  if (!normalized.source) delete normalized.source;
  if (!normalized.action) delete normalized.action;
  if (normalized.maxItems === undefined) delete normalized.maxItems;
  if (normalized.maxBodyChars === undefined) delete normalized.maxBodyChars;
  if (normalized.maxComments === undefined) delete normalized.maxComments;
  if (!Object.keys(normalized.states || {}).length) delete normalized.states;
  if (!normalized.layout?.blocks.length) delete normalized.layout;
  return normalized;
}

function normalizeSkillRendererFields(fields: unknown = [], diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): SkillRendererField[] {
  return (Array.isArray(fields) ? fields : []).map((item): SkillRendererField | null => {
    if (typeof item === "string") return { label: item, path: item };
    const input = objectOrNull(item);
    if (!input) return null;
    let path = cleanString(input.path);
    const hasLiteral = Object.prototype.hasOwnProperty.call(input, "value") && input.value !== undefined && input.value !== null;
    const value = hasLiteral ? normalizeSkillRendererLiteral(input.value) : undefined;
    const hasJsonLiteral = value !== undefined;
    if (!path && !hasJsonLiteral) return null;
    if (path && hasJsonLiteral) {
      diagnostics.push({
        level: "warning",
        pluginId: context.pluginId,
        message: `Skill renderer field cannot use both path and value; literal value wins${context.toolName ? `: ${context.toolName}` : ""}`,
      });
      path = "";
    }
    return {
      label: cleanString(input.label || path),
      ...(hasJsonLiteral ? { value } : { path }),
      ...(cleanString(input.format) ? { format: cleanString(input.format) } : {}),
    };
  }).filter((field): field is SkillRendererField => field !== null);
}

function normalizeSkillRendererLiteral(value: unknown): JsonValue | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch (_err) {
    return undefined;
  }
}

function normalizeSkillResourceRendererAction(value: unknown = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "create") return "create";
  if (raw === "edit_resource") return "edit_resource";
  if (raw === "update") return "update";
  if (raw === "delete") return "delete";
  return "";
}

function normalizeSkillRendererStates(value: unknown = {}, diagnostics: SkillDiagnostic[] = [], context: SkillDiagnosticContext = {}): NonNullable<SkillRenderer["states"]> {
  const input = objectOrNull(value);
  if (!input) return {};
  const out: NonNullable<SkillRenderer["states"]> = {};
  for (const [key, state] of Object.entries(input)) {
    const stateKey = normalizeSkillRendererStateKey(key);
    if (!stateKey) continue;
    const stateInput = objectOrNull(state);
    if (!stateInput) continue;
    out[stateKey] = {
      title: cleanString(stateInput.title),
      subtitle: cleanString(stateInput.subtitle),
      empty: cleanString(stateInput.empty),
      fields: normalizeSkillRendererFields(stateInput.fields, diagnostics, context),
    };
  }
  return out;
}

function normalizePositiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function normalizeSkillRendererStateKey(value: unknown = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "preparing") return "preparing";
  if (raw === "running") return "running";
  if (raw === "completed") return "completed";
  if (raw === "error") return "error";
  return "";
}

function objectOrNull(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
}

function cleanString(value: unknown = "") {
  return String(value ?? "").trim();
}

function skillPatternMatches(pattern = "", href = "", path = "") {
  const text = String(pattern || "").trim();
  if (!text) return false;
  if (text.startsWith("regex:")) {
    try {
      return new RegExp(text.slice("regex:".length)).test(href);
    } catch (_err) {
      return false;
    }
  }
  if (text.includes("*")) {
    const escaped = text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`).test(href) || new RegExp(escaped).test(path);
    } catch (_err) {
      return false;
    }
  }
  return href.includes(text) || path.includes(text);
}

function slugIdentifier(value: unknown = "") {
  const raw = String(value || "").trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || `p_${hashString(raw || "plugin")}`;
}

function hashString(value = "") {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

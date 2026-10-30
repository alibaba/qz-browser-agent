import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
  toAgentSkillName,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import { SKILL_SETTING_FIELD_TYPES } from "../../src/shared/skills/skill-settings.js";
import { wrapRunScriptSource } from "../../src/shared/run-script-source.js";

assert.equal(
  wrapRunScriptSource("async () => ({ ok: true })"),
  "return await (async () => ({ ok: true }))();",
);
assert.equal(
  wrapRunScriptSource("return { ok: true };"),
  "return { ok: true }",
);

const manifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "xhs-booster",
  name: "小红书增强",
  displayName: "小红书增强",
  version: "0.2.0",
  description: "增强小红书采集能力",
  category: { id: "collector", label: "采集" },
  tools: [{
    name: "collect_notes",
    title: "采集笔记",
    description: "采集当前页面上的小红书笔记",
    script: "scripts/collect.js",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        tabRef: { type: ["integer", "string"] },
      },
    },
  }],
  renderers: {
    tools: {
      collect_notes: {
        type: "list",
        title: "采集结果",
        itemsPath: "items",
        itemTitlePath: "title",
        itemSubtitlePath: "url",
        itemMeta: [
          { label: "状态", path: "status" },
          { label: "图片", path: "imageCount" },
        ],
      },
    },
  },
};

const storage = {
  _skills: {
    "小红书增强": {
      name: "小红书增强",
      description: "小红书站点技能",
      scope: "site",
      format: QINGZHOU_SKILL_FORMAT,
      schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
      domains: ["xiaohongshu.com"],
      urlPatterns: ["*://*.xiaohongshu.com/*"],
      resources: [
        {
          path: "plugin.json",
          type: "json",
          content: JSON.stringify(manifest),
        },
        {
          path: "scripts/collect.js",
          type: "script",
          content: "async () => ({ ok: true });",
        },
      ],
    },
    "旧插件技能": {
      name: "旧插件技能",
      description: "旧格式插件不应被发现",
      scope: "global",
      resources: [
        {
          path: "plugin.json",
          type: "json",
          content: JSON.stringify({ id: "legacy-plugin", tools: [{ name: "legacy", script: "scripts/legacy.js" }] }),
        },
      ],
    },
    "普通脚本资源技能": {
      name: "普通脚本资源技能",
      description: "没有 plugin.json 的脚本资源不应被工具化",
      scope: "global",
      format: QINGZHOU_SKILL_FORMAT,
      schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
      resources: [
        {
          path: "scripts/local-helper.js",
          type: "script",
          content: "return { ok: true };",
        },
      ],
    },
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(item => [item, storage[item]]));
        }
        if (typeof key === "string") return { [key]: storage[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [
            item,
            Object.prototype.hasOwnProperty.call(storage, item) ? storage[item] : fallback,
          ]));
        }
        return { ...storage };
      },
      async set(value) {
        Object.assign(storage, value);
      },
    },
  },
};

const shared = await import("../../src/shared/skills/skill-manifest.js");
const skills = await import("../../src/background/skills/runtime.js");
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const mcpClient = await import("../../src/background/mcp/mcp-client.js");
const tools = await import("../../src/background/tools/runtime.js");

async function reloadPluginRegistry(options = {}) {
  const candidate = await runtime.prepareSkillToolRegistryFromStorage();
  return runtime.commitSkillToolRegistryCandidate(candidate, options);
}

function replacePluginRegistryFromSkills(pluginSkills, options = {}) {
  const candidate = runtime.prepareSkillToolRegistryFromSkills(pluginSkills);
  return runtime.commitSkillToolRegistryCandidate(candidate, options);
}

let skillRegistryCommitCount = 0;
const skillMutationToolRuntime = tools.createToolRuntime({
  skills: {
    async refreshRegistry(reason) {
      skillRegistryCommitCount += 1;
      return reloadPluginRegistry({ reason });
    },
  },
});
const toolModel = await import("../../src/sidepanel/tools/tool-model.js");
const pluginUiRegistry = await import("../../src/sidepanel/tools/skill-tool-ui-registry.js");
const pluginRenderers = await import("../../src/shared/skills/skill-renderers.js");
const removedPluginGroupField = "chat" + "Group";
const agentSource = readSource("../../src/background/agent/agent.ts");
const serviceWorkerSource = readSource("../../src/background/service-worker.js");
const mcpRuntimeSource = readSource("../../src/background/mcp/mcp-runtime.js");
const runtimeReducerSource = readSource("../../src/background/session/runtime-reducer.js");
const toolsSource = readSource("../../src/background/tools/runtime.js");
const mcpToolsSource = readSource("../../src/capabilities/mcp/tools.ts");
const analysisSkillsToolsSource = readSource("../../src/capabilities/skills/tools.js");
const sidepanelSource = readSource("../../src/capabilities/skills/workspace/skills-feature.js");
const toolRendererSource = [
  "../../src/sidepanel/tools/tool-renderer.ts",
  "../../src/capabilities/mcp/profile.ts",
  "../../src/capabilities/ui/skill-tool-profile.ts",
  "../../src/sidepanel/tools/primitives/skill-result-data.ts",
  "../../src/capabilities/skills/profile.ts",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const sidepanelHtml = readSource("../../src/capabilities/skills/ui.html");

assert.doesNotMatch(
  agentSource,
  /agent_load_skill|skillMutationResultMayAffectPluginRegistry|qingzhou_skill_author__/,
  "Agent consumes trusted runtime effects instead of inferring authority from tool names or result fields",
);
assert.match(
  agentSource,
  /getRunToolContext\(runId = ""\)[\s\S]*skillToolRegistrySnapshot: this\._skillToolRegistrySnapshot/,
  "nested script tools should reuse the active Agent registry snapshot",
);
assert.match(
  agentSource,
  /applyNestedToolResult[\s\S]*this\._applyToolResultEffects/,
  "nested script tool results should update the same Agent skill state as direct calls",
);
assert.match(
  agentSource,
  /type:\s*"skill_loaded"[\s\S]*loadedPluginSkillNames:\s*\[\.\.\.this\._loadedSkillToolNames\]/,
  "load_skill activation should emit loaded skill names for the current session runtime",
);
assert.match(
  runtimeReducerSource,
  /case "skill_loaded":[\s\S]*loadedPluginSkillNames:\s*uniqueStrings/,
  "the session runtime reducer should persist loaded skill names from agent load_skill events",
);
assert.match(
  mcpRuntimeSource,
  /async function listTools[\s\S]*tools\.loadedSkillNames\(sessionId,\s*params\.loadedPluginSkillNames \|\| \[\]\)[\s\S]*loadedPluginSkillNames/,
  "MCP bridge list_tools should include tools from skills loaded in the session",
);
assert.doesNotMatch(
  mcpRuntimeSource,
  /tools\.refreshRegistry/,
  "MCP bridge calls should reuse the committed registry instead of rereading Skill storage",
);
assert.match(
  mcpRuntimeSource,
  /async function executeTool[\s\S]*await waitForToolsReady\("mcp_execute_tool"\)/,
  "MCP bridge execute_tool should wait for the committed registry before direct execution",
);
assert.match(
  mcpRuntimeSource,
  /async function executeTool[\s\S]*tools\.loadedSkillNames\(sessionId,\s*params\.loadedPluginSkillNames \|\| \[\]\)[\s\S]*loadedPluginSkillNames/,
  "MCP bridge execute_tool should allow tools from skills loaded in the session",
);
assert.match(
  mcpRuntimeSource,
  /name === "load_skill"[\s\S]*tools\.recordLoadedSkillNames\(sessionId,\s*\[plainObject\(result\)\.name,\s*plainObject\(result\)\.displayName\]\)/,
  "MCP bridge execute_tool(load_skill) should activate plugin tools for later calls",
);
assert.match(
  mcpRuntimeSource,
  /async function getSkill[\s\S]*tools\.recordLoadedSkillNames\(sessions\.normalizeId\(params\.sessionId\),\s*\[skill\.name,\s*skills\.getDisplayName\(skill\)\]\)/,
  "MCP bridge get_skill should activate plugin tools for later calls",
);
assert.match(
  mcpRuntimeSource,
  /dynamicContext\.pageUrl = runtime\.workingUrl \|\| "";/,
  "MCP execute_tool should pass the session page URL for site plugin activation",
);
assert.match(
  mcpRuntimeSource,
  /dynamicContext\.taskSiteTabs = runtime\.visitedTaskSites \|\| \[\];/,
  "MCP execute_tool should pass visited task sites for site plugin activation",
);
assert.match(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_list_tools"/, "system tools should include MCP tool listing");
assert.match(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_search_tools"/, "system tools should include MCP tool search");
assert.match(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_call_tool"/, "system tools should include unregistered MCP direct calls");
assert.match(
  sidepanelSource,
  /await request\("save_workspace_skill", \{ name: previousName, skill: updatedSkill, expected \}, 60000\)/,
  "skill save must use the Background mutation and its original snapshot",
);
assert.match(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_inspect_server"/, "system tools should include unregistered MCP inspection");
assert.doesNotMatch(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_call_tool_directly"/, "obsolete MCP direct-call alias should be removed");
assert.doesNotMatch(mcpToolsSource, /registerTool\(\{\s*name:\s*"mcp_call_server_tool"/, "legacy MCP direct-call alias should be removed");
const toolSchemas = tools.getToolSchemas();
const publicToolNames = toolSchemas.map(schema => schema.function.name);
assert.equal(publicToolNames.includes("list_tabs"), true);
assert.equal(publicToolNames.includes("get_working_tab"), true);
assert.equal(publicToolNames.includes("get_active_tab"), false);
assert.equal(publicToolNames.includes("search_tabs"), false);
assert.equal(publicToolNames.includes("mcp_inspect_server"), false);
assert.equal(publicToolNames.includes("mcp_list_tools"), false);
assert.equal(publicToolNames.includes("mcp_search_tools"), false);
assert.equal(publicToolNames.includes("mcp_call_tool"), false);
assert.equal(publicToolNames.includes("mcp_call_tool_directly"), false);
assert.equal(publicToolNames.includes("mcp_call_server_tool"), false);
const listTabsSchema = toolSchemas.find(schema => schema.function.name === "list_tabs");
assert.equal(Object.prototype.hasOwnProperty.call(listTabsSchema.function.parameters.properties, "query"), false);
const openTabSchema = toolSchemas.find(schema => schema.function.name === "open_tab");
assert.match(openTabSchema.function.description, /导航前开启 Network 监听/);
assert.match(openTabSchema.function.description, /后续交互/);
assert.match(openTabSchema.function.description, /network_watch/);
assert.match(openTabSchema.function.parameters.properties.watchNetwork.description, /页面已打开后的交互监听请用 network_watch/);
const navigateSchema = toolSchemas.find(schema => schema.function.name === "navigate");
assert.match(navigateSchema.function.description, /本次导航请求/);
assert.match(navigateSchema.function.description, /后续交互的?请求/);
assert.match(navigateSchema.function.description, /network_watch/);
assert.match(navigateSchema.function.parameters.properties.watchNetwork.description, /页面已加载后的交互监听请用 network_watch/);
const networkWatchSchema = toolSchemas.find(schema => schema.function.name === "network_watch");
assert.match(networkWatchSchema.function.description, /后置监听/);
assert.match(networkWatchSchema.function.description, /调用之后发生的请求/);
assert.match(networkWatchSchema.function.description, /watchNetwork:true/);
const mcpCallToolDefinition = tools.resolveToolDefinition("mcp_call_tool");
const mcpCallToolSchema = mcpCallToolDefinition.schema;
assert.equal(mcpCallToolDefinition.hidden, true);
assert.match(mcpCallToolSchema.function.description, /按 URL 调用/);
assert.match(mcpCallToolSchema.function.description, /Skill 工具名/);
assert.equal(Object.prototype.hasOwnProperty.call(mcpCallToolSchema.function.parameters.properties, "server"), false);
assert.match(analysisSkillsToolsSource, /mcpServerCount[\s\S]*mcpToolCount[\s\S]*mcpServers/, "skill tool results should expose MCP summaries");
assert.match(toolRendererSource, /appendSkillMcpSummary/, "create/load skill tool UI should render MCP summaries");
assert.match(toolRendererSource, /appendMcpProfile/, "MCP system tools should have readable UI profiles");
assert.match(toolRendererSource, /normalizeMcpRendererData/, "MCP plugin results should be normalized for plugin renderers");
assert.match(sidepanelHtml, /id="skill-tab-resources"/, "skill workbench should expose the resources tab");
assert.match(sidepanelHtml, /id="skill-tab-mcp"/, "skill workbench should expose the MCP tab");
assert.match(sidepanelSource, /validate_skill_mcp/, "skill editor should validate MCP before save");
assert.match(sidepanelHtml, /id="skill-mcp-editor"/, "skill editor should expose MCP editing");
const legacyMcpSectionIdPattern = new RegExp(["skill-detail", "connections"].join("-"));
assert.doesNotMatch(sidepanelHtml, legacyMcpSectionIdPattern, "skill detail should not render a separate MCP section");

const discovered = shared.discoverSkillManifests(Object.values(storage._skills));
assert.equal(discovered.diagnostics.length, 0);
assert.equal(discovered.plugins.length, 1);
assert.equal(discovered.plugins.some(plugin => plugin.id === "legacy-plugin"), false);
assert.equal(discovered.plugins.some(plugin => plugin.skillName === "普通脚本资源技能"), false);
const parsedLegacyManifest = shared.parseSkillManifest(
  JSON.stringify({ id: "legacy-plugin", tools: [{ name: "legacy", script: "scripts/legacy.js" }] }),
  { name: "现代容器" },
);
assert.equal(parsedLegacyManifest.plugin, null);
assert.equal(parsedLegacyManifest.diagnostics.length, 1);
assert.match(parsedLegacyManifest.diagnostics[0].message, /Ignored Skill manifest/);
const parsedDefaultCategoryManifest = shared.parseSkillManifest(
  JSON.stringify({
    format: SKILL_MANIFEST_FORMAT,
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    id: "default-category-plugin",
    displayName: "默认分类插件",
    tools: [{ name: "inspect", script: "scripts/inspect.js" }],
  }),
  { name: "默认分类技能" },
);
assert.equal(parsedDefaultCategoryManifest.plugin.category.id, "extension");
assert.equal(parsedDefaultCategoryManifest.plugin.category.label, "扩展");
assert.equal(discovered.plugins[0].id, "xhs-booster");
assert.equal(discovered.plugins[0].displayName, "小红书增强");
assert.deepEqual(discovered.plugins[0].category, { id: "collector", label: "采集" });
assert.equal(Object.prototype.hasOwnProperty.call(discovered.plugins[0], removedPluginGroupField), false);
assert.equal(discovered.plugins[0].tools[0].name, "xhs_booster__collect_notes");
assert.equal(discovered.plugins[0].renderers.tools.xhs_booster__collect_notes.type, "list");
assert.equal(Object.prototype.hasOwnProperty.call(discovered.plugins[0].ui, "slashCommands"), false);
assert.equal(toolModel.isSkillToolRuntimeName("xhs_booster__collect_notes"), true);
assert.equal(toolModel.getToolDisplayName("xhs_booster__collect_notes"), "扩展工具");
assert.equal(toolModel.getToolDisplayName("get_working_tab"), "查看工作页");
assert.equal(toolModel.isToolInSet("get_working_tab", "tab"), true);
assert.equal(toolModel.isToolInSet("get_working_tab", "navigation"), false);
assert.equal(toolModel.isToolInSet("mcp_inspect_server", "mcp"), true);
assert.equal(toolModel.getToolDisplayName("mcp_inspect_server"), "探测 MCP");
assert.equal(toolModel.isToolInSet("mcp_call_tool", "mcp"), true);
assert.equal(toolModel.getToolDisplayName("mcp_call_tool"), "直调 MCP");
assert.equal(toolModel.isToolInSet("mcp_call_tool_directly", "mcp"), false);
assert.equal(toolModel.getToolResultFamily("mcp_call_tool"), "mcp");
assert.equal(toolModel.getToolTimelineFamilyInfo("mcp_call_tool").id, "mcp");
assert.equal(toolModel.isPageContextToolName("run_script"), true);
assert.equal(toolModel.getToolProfileFamily("list_tabs"), "tabs");

assert.equal(
  shared.skillMatchesContext(discovered.plugins[0], { pageUrl: "https://www.xiaohongshu.com/explore/abc" }),
  true,
);
assert.equal(
  shared.skillMatchesContext(discovered.plugins[0], { pageUrl: "https://www.baidu.com/s?wd=xhs" }),
  false,
);

await reloadPluginRegistry();
const loadedSkillWorkbenchNames = ["skill-workbench"];
const inactiveSiteSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
});
const inactiveSiteSchemaNames = inactiveSiteSchemas.map(schema => schema.function.name);
assert.equal(inactiveSiteSchemaNames.includes("xhs_booster__collect_notes"), false);
assert.equal(inactiveSiteSchemaNames.includes("qingzhou_skill_author__create_skill"), false);
assert.equal(inactiveSiteSchemaNames.includes("qingzhou_skill_author__edit_skill_resource"), false);

const activeSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { taskSiteTabs: [{ url: "https://www.xiaohongshu.com/explore/abc" }] },
});
const activeSchemaNames = activeSchemas.map(schema => schema.function.name);
assert.equal(activeSchemaNames.includes("xhs_booster__collect_notes"), true);
assert.equal(activeSchemaNames.includes("qingzhou_skill_author__create_skill"), false);
assert.equal(activeSchemaNames.includes("qingzhou_skill_author__edit_skill_resource"), false);
const activeXhsToolSchema = activeSchemas.find(schema => schema.function.name === "xhs_booster__collect_notes");
assert.equal(activeXhsToolSchema.function.parameters.properties.timeout.type, "number");
assert.deepEqual(activeXhsToolSchema.function.parameters.required, ["timeout"]);
assert.deepEqual(activeXhsToolSchema.function.parameters.properties.tabRef.type, ["integer", "string"]);
assert.equal(activeXhsToolSchema.function.parameters.properties.tabId, undefined);
assert.deepEqual(runtime.getSkillToolParameters(manifest.tools[0]), activeXhsToolSchema.function.parameters);
assert.equal(activeXhsToolSchema.function.parameters.required.includes("tabRef"), false, "plugin page tools should default to the current working tab");
assert.match(
  toolsSource,
  /resolveToolTimeoutMs\(definition, executionArgs\)/,
  "executeTool should resolve plugin page tool timeout from the same registry lookup used for execution",
);
assert.match(
  toolsSource,
  /export function resolveToolDefinition[\s\S]*source: "plugin"/,
  "core and plugin tools should be exposed through one definition resolver",
);
assert.match(
  toolsSource,
  /function isSkillScriptTool\(pluginTool: SkillTool\)[\s\S]*return Boolean\(tool\.script\) && runtime !== "mcp";/,
  "all plugin script tools should use the unified script timeout path",
);
assert.match(
  toolsSource,
  /function isSkillPageScriptTool\(pluginTool: SkillTool\)[\s\S]*if \(!isSkillScriptTool\(pluginTool\)\) return false;[\s\S]*return runtime === "page" && tool\.needsPage !== false;/,
  "page plugin scripts should not add an outer timeout around run_skill_script",
);
const loadedSkillWorkbenchSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
  loadedPluginSkillNames: loadedSkillWorkbenchNames,
});
const skillAuthorCreateSchema = loadedSkillWorkbenchSchemas.find(schema => schema.function.name === "qingzhou_skill_author__create_skill");
const skillAuthorEditResourceSchema = loadedSkillWorkbenchSchemas.find(schema => schema.function.name === "qingzhou_skill_author__edit_skill_resource");
assert.equal(Boolean(skillAuthorCreateSchema), true);
assert.equal(Boolean(skillAuthorEditResourceSchema), true);
assert.equal(Object.prototype.hasOwnProperty.call(skillAuthorCreateSchema.function.parameters.properties, "tabId"), false);
assert.equal(Object.prototype.hasOwnProperty.call(skillAuthorEditResourceSchema.function.parameters.properties, "tabId"), false);
assert.equal(skillAuthorCreateSchema.function.parameters.properties.timeout.type, "number");
assert.match(skillAuthorCreateSchema.function.parameters.properties.timeout.description, /单位秒/);
assert.ok(skillAuthorCreateSchema.function.parameters.required.includes("timeout"));
assert.ok(skillAuthorEditResourceSchema.function.parameters.required.includes("timeout"));
assert.match(skillAuthorCreateSchema.function.description, /必须传入 timeout（秒）/);
const editResourceContentDescription = skillAuthorEditResourceSchema.function.parameters.properties.content.description;
const exposedSettingFieldTypes = editResourceContentDescription.match(/settings\.fields\[\]\.type 只支持 ([^，]+)/)?.[1].split("|") || [];
assert.deepEqual(new Set(exposedSettingFieldTypes), SKILL_SETTING_FIELD_TYPES, "active edit_skill_resource schema should expose every supported setting UI field type");
assert.match(editResourceContentDescription, /width 只支持 full\|half[\s\S]*settings\.layout\.sections/);

const globalManifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "global-helper",
  displayName: "全局助手",
  tools: [{ name: "lookup", title: "全局查询", script: "scripts/lookup.js" }],
};
const residentManifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "resident-helper",
  displayName: "常驻助手",
  tools: [{ name: "ping", title: "常驻检查", script: "scripts/ping.js" }],
};
storage._skills["全局插件技能"] = {
  name: "全局插件技能",
  description: "全局按需加载插件技能",
  scope: "global",
  format: QINGZHOU_SKILL_FORMAT,
  schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(globalManifest) },
    { path: "scripts/lookup.js", type: "script", content: "async () => ({ ok: true });" },
  ],
};
storage._skills["常驻插件技能"] = {
  name: "常驻插件技能",
  description: "常驻插件技能",
  scope: "resident",
  format: QINGZHOU_SKILL_FORMAT,
  schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(residentManifest) },
    { path: "scripts/ping.js", type: "script", content: "async () => ({ ok: true });" },
  ],
};
await reloadPluginRegistry({ reason: "test_skill_scope_activation" });
const scopedInactiveSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
});
const scopedInactiveNames = scopedInactiveSchemas.map(schema => schema.function.name);
assert.equal(scopedInactiveNames.includes("global_helper__lookup"), false);
assert.equal(scopedInactiveNames.includes("xhs_booster__collect_notes"), false);
assert.equal(scopedInactiveNames.includes("resident_helper__ping"), true);
assert.equal(scopedInactiveNames.includes("qingzhou_skill_author__create_skill"), false);
assert.equal(scopedInactiveNames.includes("qingzhou_skill_author__edit_skill_resource"), false);

const loadedGlobalSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
  loadedPluginSkillNames: ["全局插件技能"],
});
assert.equal(loadedGlobalSchemas.some(schema => schema.function.name === "global_helper__lookup"), true);
assert.equal(loadedGlobalSchemas.some(schema => schema.function.name === "qingzhou_skill_author__create_skill"), false);
const loadedBuiltinGlobalSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
  loadedPluginSkillNames: loadedSkillWorkbenchNames,
});
assert.equal(loadedBuiltinGlobalSchemas.some(schema => schema.function.name === "qingzhou_skill_author__create_skill"), true);
assert.equal(loadedBuiltinGlobalSchemas.some(schema => schema.function.name === "global_helper__lookup"), false);
const loadedGlobalContextSchemas = runtime.getActiveSkillToolSchemasSync({
  context: { pageUrl: "https://www.baidu.com/", loadedPluginSkillNames: ["全局插件技能"] },
});
assert.equal(loadedGlobalContextSchemas.some(schema => schema.function.name === "global_helper__lookup"), true);

const loadedSiteSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
  loadedPluginSkillNames: ["小红书增强"],
});
assert.equal(loadedSiteSchemas.some(schema => schema.function.name === "xhs_booster__collect_notes"), true);
assert.equal(shared.skillMatchesContext(runtime.getSkillToolDefinition("global_helper__lookup").plugin, {}), false);
assert.equal(
  shared.skillMatchesContext(
    runtime.getSkillToolDefinition("global_helper__lookup").plugin,
    {},
    { loadedPluginSkillNames: ["全局插件技能"] },
  ),
  true,
);

const frozenRegistry = runtime.getSkillToolRegistryExecutionSnapshot();

const registryEvents = [];
const unsubscribeRegistry = runtime.subscribeSkillToolRegistry(event => registryEvents.push(event));
const liveRegistry = await reloadPluginRegistry({ reason: "test_live_refresh" });
runtime.publishSkillToolRegistryUpdate("test_live_refresh", liveRegistry);
assert.equal(registryEvents.length, 1);
assert.equal(registryEvents[0].type, "plugin_registry_update");
assert.equal(registryEvents[0].reason, "test_live_refresh");
assert.equal(registryEvents[0].snapshot.plugins.some(plugin => plugin.id === "xhs-booster"), true);
assert.equal(registryEvents[0].snapshot.plugins.some(plugin => plugin.id === "qingzhou-skill-author"), true);
unsubscribeRegistry();

let contributions = await runtime.listSkillContributions({ pageUrl: "https://www.xiaohongshu.com/explore/abc" });
const xhsContribution = contributions.plugins.find(plugin => plugin.id === "xhs-booster");
const skillAuthorContribution = contributions.plugins.find(plugin => plugin.id === "qingzhou-skill-author");
assert.equal(Boolean(xhsContribution), true);
assert.equal(Boolean(skillAuthorContribution), true);
assert.equal(xhsContribution.active, true);
assert.equal(Object.prototype.hasOwnProperty.call(xhsContribution, "slashCommands"), false);
assert.equal(Object.prototype.hasOwnProperty.call(xhsContribution, "settings"), false);
assert.equal(Object.prototype.hasOwnProperty.call(xhsContribution, "config"), false);
pluginUiRegistry.setSkillToolUiCatalog(contributions);
const xhsUiMeta = pluginUiRegistry.getSkillToolUiMeta("xhs_booster__collect_notes");
assert.equal(xhsUiMeta.plugin.category.label, "采集");
assert.equal(Object.prototype.hasOwnProperty.call(xhsUiMeta.plugin, removedPluginGroupField), false);
assert.equal(xhsUiMeta.tool.title, "采集笔记");
assert.equal(xhsUiMeta.renderer.type, "list");

let dispatched = null;
const result = await runtime.executeSkillTool(
  "xhs_booster__collect_notes",
  { keyword: "装修", tabId: 123, timeout: 45 },
  null,
  { workingTabId: 99 },
  async (name, args, signal, context) => {
    dispatched = { name, args, signal, context };
    return {
      ok: true,
      count: 3,
      items: [
        { title: "样例笔记", url: "https://www.xiaohongshu.com/explore/1", status: "ready", imageCount: 4 },
      ],
    };
  },
);

assert.equal(dispatched.name, "run_skill_script");
assert.equal(dispatched.args.skill, toAgentSkillName("小红书增强"));
assert.equal(dispatched.args.script, "scripts/collect.js");
assert.equal(dispatched.args.tabId, 123);
assert.equal(dispatched.args.timeout, 45);
assert.equal(dispatched.args.args.keyword, "装修");
assert.equal(Object.prototype.hasOwnProperty.call(dispatched.args.args, "timeout"), false);
assert.equal(Object.prototype.hasOwnProperty.call(dispatched.args.args, "timeoutMs"), false);
assert.equal(dispatched.args.args.$plugin.id, "xhs-booster");
assert.deepEqual(dispatched.args.args.$plugin.config, {});
assert.equal(dispatched.context.source, "plugin_tool");
assert.equal(result.ok, true);
assert.equal(result._plugin.id, "xhs-booster");
assert.equal(result._plugin.displayName, "小红书增强");
assert.equal(result._plugin.category.label, "采集");
await assert.rejects(
  () => runtime.executeSkillTool(
    "xhs_booster__collect_notes",
    { keyword: "装修", tabId: 123, timeoutMs: 45000 },
    null,
    { workingTabId: 99 },
    async () => ({ ok: true }),
  ),
  err => err?.code === "MISSING_REQUIRED_ARGUMENTS" && err?.details?.missing?.includes("timeout"),
);
assert.equal(Object.prototype.hasOwnProperty.call(result._plugin, removedPluginGroupField), false);
assert.equal(result._plugin.tool, "xhs_booster__collect_notes");
assert.equal(result._plugin.title, "采集笔记");
assert.equal(result._plugin.script, "scripts/collect.js");
assert.equal(result._plugin.renderer.type, "list");
assert.equal(result._plugin.renderer.itemsPath, "items");

const mcpManifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "mcp-docs",
  displayName: "MCP 文档",
  description: "通过远程 MCP 查询文档",
  mcpServers: {
    context7: {
      type: "remote",
      url: "https://mcp.example.com/mcp",
      enabled: true,
      headers: { "Context7-API-Key": "secret-value" },
    },
  },
  tools: [{
    name: "query_docs",
    title: "查询文档",
    description: "查询远程文档索引",
    runtime: "mcp",
    mcp: { server: "context7", tool: "resolve-library-id" },
    parameters: {
      type: "object",
      properties: {
        libraryName: { type: "string" },
      },
      required: ["libraryName"],
    },
    renderer: {
      type: "text",
      title: "文档结果",
      valuePath: "text",
    },
  }],
};
storage._skills["MCP 文档"] = {
  name: "MCP 文档",
  description: "MCP 测试技能",
  scope: "global",
  format: QINGZHOU_SKILL_FORMAT,
  schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: "plugin.json", type: "json", content: JSON.stringify(mcpManifest) },
  ],
};
const loadedMcpSkillViaTool = await tools.executeTool("load_skill", { name: "MCP 文档" }, null, {});
assert.equal(loadedMcpSkillViaTool.mcpServerCount, 1);
assert.equal(loadedMcpSkillViaTool.mcpToolCount, 1);
assert.equal(loadedMcpSkillViaTool.mcpServers[0].ref, "mcp-docs:context7");
assert.deepEqual(loadedMcpSkillViaTool.mcpServers[0].headerNames, ["Context7-API-Key"]);
assert.deepEqual(loadedMcpSkillViaTool.mcpServers[0].headers, { "Context7-API-Key": "secret-value" });
assert.equal(loadedMcpSkillViaTool.mcpServers[0].tools[0].mcpTool, "resolve-library-id");
await reloadPluginRegistry({ reason: "test_mcp_plugin" });
const mcpSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { pageUrl: "https://www.baidu.com/" },
  loadedPluginSkillNames: ["MCP 文档"],
});
const mcpSchema = mcpSchemas.find(schema => schema.function.name === "mcp_docs__query_docs");
assert.equal(Boolean(mcpSchema), true);
assert.equal(Object.prototype.hasOwnProperty.call(mcpSchema.function.parameters.properties, "tabId"), false);
assert.equal(mcpSchema.function.parameters.properties.timeout.type, "number");
assert.match(mcpSchema.function.description, /MCP:/);
assert.match(mcpSchema.function.description, /不需要网页 tab/);
const mcpDefinition = runtime.getSkillToolDefinition("mcp_docs__query_docs");
assert.equal(mcpDefinition.tool.runtime, "mcp");
assert.equal(mcpDefinition.tool.needsPage, false);
assert.equal(mcpDefinition.tool.familyId, "mcp");
assert.equal(mcpDefinition.tool.familyTitle, "MCP");
assert.equal(mcpDefinition.tool.script, "");
assert.equal(mcpDefinition.tool.renderer.type, "text");
assert.deepEqual(mcpDefinition.plugin.mcpServers[0].headers, { "Context7-API-Key": "secret-value" });

const mcpServers = await runtime.listSkillMcpServers({});
assert.equal(mcpServers.length, 1);
assert.equal(mcpServers[0].ref, "mcp-docs:context7");
assert.deepEqual(mcpServers[0].headerNames, ["Context7-API-Key"]);
assert.deepEqual(mcpServers[0].headers, { "Context7-API-Key": "secret-value" });
assert.equal(mcpServers[0].boundTools[0].mcpTool, "resolve-library-id");
const activeOnlyMcpServers = await runtime.listSkillMcpServers({}, { includeInactive: false });
assert.equal(activeOnlyMcpServers.length, 0);

const mcpContributions = await runtime.listSkillContributions({ loadedPluginSkillNames: ["MCP 文档"] });
const mcpContribution = mcpContributions.plugins.find(plugin => plugin.id === "mcp-docs");
assert.equal(Boolean(mcpContribution), true);
assert.equal(mcpContribution.connections[0].ref, "mcp-docs:context7");
assert.deepEqual(mcpContribution.connections[0].headerNames, ["Context7-API-Key"]);
assert.deepEqual(mcpContribution.connections[0].headers, { "Context7-API-Key": "secret-value" });
assert.equal(mcpContribution.tools[0].runtime, "mcp");
assert.equal(mcpContribution.tools[0].familyId, "mcp");

const originalFetch = globalThis.fetch;
const mcpFetchCalls = [];
const mockMcpFetch = async (_url, init = {}) => {
  const requestUrl = String(_url || "");
  const body = JSON.parse(String(init.body || "{}"));
  mcpFetchCalls.push({ body, headers: init.headers || {} });
  const headers = { "content-type": "application/json", "mcp-session-id": "mock-session" };
  if (body.method === "initialize") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } },
    }), { status: 200, headers });
  }
  if (body.method === "notifications/initialized") {
    return new Response("", { status: 200, headers });
  }
  if (body.method === "tools/list") {
    if (/bad-mcp/.test(requestUrl)) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: "bad MCP tools/list" },
      }), { status: 200, headers });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{
          name: "resolve-library-id",
          title: "Resolve Library",
          description: "Resolve docs library",
          inputSchema: { type: "object", properties: { libraryName: { type: "string" } } },
        }],
      },
    }), { status: 200, headers });
  }
  if (body.method === "tools/call") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: `resolved:${body.params?.arguments?.libraryName || ""}` }] },
    }), { status: 200, headers });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } }), { status: 200, headers });
};
globalThis.fetch = mockMcpFetch;
try {
  const listedMcpTools = await runtime.listSkillMcpTools({}, { refresh: true });
  assert.equal(listedMcpTools.count, 1, JSON.stringify(listedMcpTools.errors));
  assert.equal(listedMcpTools.tools[0].server, "mcp-docs:context7");
  assert.equal(listedMcpTools.tools[0].name, "resolve-library-id");
  assert.equal(listedMcpTools.tools[0].pluginTool.name, "mcp_docs__query_docs");
  assert.equal(listedMcpTools.tools[0].renderer.type, "text");
  const metadataCache = storage._qingzhou_mcp_metadata_cache_v1;
  assert.equal(metadataCache.version, 1);
  const metadataEntries = Object.values(metadataCache.entries || {});
  assert.equal(metadataEntries.length, 1);
  assert.equal(metadataEntries[0].tools[0].name, "resolve-library-id");

  const listedViaTool = await tools.executeTool(
    "mcp_list_tools",
    { server: "mcp-docs:context7", refresh: true },
    null,
    {},
  );
  assert.equal(listedViaTool.ok, true);
  assert.equal(listedViaTool.count, 1);
  assert.equal(listedViaTool.servers[0].ref, "mcp-docs:context7");
  assert.deepEqual(listedViaTool.servers[0].headers, { "Context7-API-Key": "secret-value" });
  assert.equal(listedViaTool.tools[0].name, "resolve-library-id");

  const searchedViaTool = await tools.executeTool(
    "mcp_search_tools",
    { query: "resolve", server: "mcp-docs:context7" },
    null,
    {},
  );
  assert.equal(searchedViaTool.ok, true);
  assert.equal(searchedViaTool.count, 1);
  assert.equal(searchedViaTool.tools[0].name, "resolve-library-id");

  const inspectedAdhocServer = await mcpClient.inspectMcpServer(
    {
      id: "adhoc-docs",
      name: "adhoc-docs",
      url: "https://mcp.example.com/mcp",
      headers: { "Context7-API-Key": "secret-value" },
    },
    { refresh: true },
  );
  assert.equal(inspectedAdhocServer.ok, true);
  assert.equal(inspectedAdhocServer.toolCount, 1);
  assert.equal(inspectedAdhocServer.tools[0].name, "resolve-library-id");
  assert.deepEqual(inspectedAdhocServer.server.headerNames, ["Context7-API-Key"]);
  assert.deepEqual(inspectedAdhocServer.server.headers, { "Context7-API-Key": "secret-value" });
  const inspectedViaTool = await tools.executeTool(
    "mcp_inspect_server",
    {
      url: "https://mcp.example.com/mcp",
      name: "adhoc-docs",
      headers: { "Context7-API-Key": "secret-value" },
      refresh: true,
    },
    null,
    {},
  );
  assert.equal(inspectedViaTool.ok, true);
  assert.equal(inspectedViaTool.toolCount, 1);
  assert.equal(inspectedViaTool.tools[0].name, "resolve-library-id");
  assert.deepEqual(inspectedViaTool.server.headers, { "Context7-API-Key": "secret-value" });
  const adhocCallResult = await mcpClient.callMcpServerTool(
    {
      id: "adhoc-docs",
      name: "adhoc-docs",
      url: "https://mcp.example.com/mcp",
      headers: { "Context7-API-Key": "secret-value" },
    },
    "resolve-library-id",
    { libraryName: "svelte" },
  );
  assert.equal(adhocCallResult.ok, true);
  assert.equal(adhocCallResult.text, "resolved:svelte");
  assert.equal(adhocCallResult.server, "adhoc-docs");
  const publicDirectMcpResult = await tools.executeTool(
    "mcp_call_tool",
    {
      url: "https://mcp.example.com/mcp",
      name: "adhoc-docs",
      tool: "resolve-library-id",
      args: { libraryName: "direct-public" },
    },
    null,
    {},
  );
  assert.equal(publicDirectMcpResult.ok, true);
  assert.equal(publicDirectMcpResult.text, "resolved:direct-public");
  await assert.rejects(
    () => tools.executeTool(
      "mcp_call_tool_directly",
      {
        url: "https://mcp.example.com/mcp",
        tool: "resolve-library-id",
        args: { libraryName: "obsolete" },
      },
      null,
      {},
    ),
    err => err?.code === "UNKNOWN_TOOL",
  );
  await assert.rejects(
    () => tools.executeTool(
      "mcp_call_server_tool",
      {
        url: "https://mcp.example.com/mcp",
        tool: "resolve-library-id",
        args: { libraryName: "legacy" },
      },
      null,
      {},
    ),
    err => err?.code === "UNKNOWN_TOOL",
  );
  const savedValidMcpSkill = await skills.saveSkill("MCP 校验通过", "保存时校验 MCP", "正文", {
    resources: [{ path: "plugin.json", type: "json", content: JSON.stringify(mcpManifest) }],
  });
  assert.equal(savedValidMcpSkill.description, "保存时校验 MCP");
  assert.equal(savedValidMcpSkill.resources.some(resource => resource.path === "plugin.json"), true);
  const createdMcpToolResult = await runtime.executeSkillTool(
    "qingzhou_skill_author__create_skill",
    {
      timeout: 30,
      name: "MCP 工具摘要",
      description: "保存工具结果应显示 MCP 摘要",
      content: "正文",
    },
    null,
    { loadedPluginSkillNames: loadedSkillWorkbenchNames },
    (name, args, signal, context) => skillMutationToolRuntime.execute(name, args, signal, context),
  );
  assert.equal(createdMcpToolResult.saved, true);
  assert.equal(skillRegistryCommitCount, 1, "one Skill mutation should commit the registry exactly once");
  const savedMcpToolResult = await runtime.executeSkillTool(
    "qingzhou_skill_author__edit_skill_resource",
    {
      timeout: 30,
      name: "MCP 工具摘要",
      path: "plugin.json",
      action: "set",
      type: "json",
      content: JSON.stringify(mcpManifest),
    },
    null,
    { loadedPluginSkillNames: loadedSkillWorkbenchNames },
    (name, args, signal, context) => skillMutationToolRuntime.execute(name, args, signal, context),
  );
  assert.equal(savedMcpToolResult.mcpServerCount, 1);
  assert.equal(savedMcpToolResult.mcpToolCount, 1);
  assert.deepEqual(savedMcpToolResult.mcpServers[0].headerNames, ["Context7-API-Key"]);
  assert.deepEqual(savedMcpToolResult.mcpServers[0].headers, { "Context7-API-Key": "secret-value" });
  assert.equal(
    mcpFetchCalls.some(call => call.body.method === "tools/list"),
    true,
  );
  await assert.rejects(
    () => skills.saveSkill("MCP 校验失败", "保存时校验 MCP", "正文", {
      resources: [{
        path: "plugin.json",
        type: "json",
        content: JSON.stringify({
          ...mcpManifest,
          id: "bad-mcp-docs",
          mcpServers: {
            bad: {
              type: "remote",
              url: "https://bad-mcp.example.com/mcp",
            },
          },
          tools: [],
        }),
      }],
    }),
    err => err?.code === "SKILL_MCP_VALIDATE_FAILED" && /bad MCP tools\/list/.test(err.message),
  );
  await skills.deleteSkill(savedValidMcpSkill.name);
  await skills.deleteSkill(savedMcpToolResult.name);
  await reloadPluginRegistry({ reason: "test_cleanup_valid_mcp_skill" });

  mcpClient.resetMcpServerState(mcpDefinition.plugin.mcpServers[0]);
  globalThis.fetch = async () => {
    throw new Error("persistent MCP metadata cache should avoid remote tools/list");
  };
  const cachedMcpTools = await runtime.listSkillMcpTools({}, { refresh: false });
  assert.equal(cachedMcpTools.count, 1, JSON.stringify(cachedMcpTools.errors));
  assert.equal(cachedMcpTools.tools[0].name, "resolve-library-id");
  globalThis.fetch = mockMcpFetch;

  const mcpResult = await runtime.executeSkillTool(
    "mcp_docs__query_docs",
    { libraryName: "react", timeout: 30 },
    null,
    { loadedPluginSkillNames: ["MCP 文档"] },
    null,
  );
  assert.equal(mcpResult.ok, true);
  assert.equal(mcpResult.text, "resolved:react");
  assert.equal(mcpResult._plugin.runtime, "mcp");
  assert.equal(mcpResult._plugin.mcp.tool, "resolve-library-id");
  assert.equal(mcpResult._plugin.renderer.type, "text");
  assert.equal(mcpFetchCalls.some(call => call.body.method === "tools/call" && call.body.params.arguments.libraryName === "react"), true);
  assert.equal(mcpFetchCalls.some(call => getHeaderValue(call.headers, "mcp-session-id") === "mock-session"), true);
  const registeredMcpToolResult = await tools.executeTool(
    "mcp_docs__query_docs",
    { libraryName: "solid", timeout: 30 },
    null,
    { loadedPluginSkillNames: ["MCP 文档"] },
  );
  assert.equal(registeredMcpToolResult.ok, true);
  assert.equal(registeredMcpToolResult.text, "resolved:solid");
  assert.equal(registeredMcpToolResult._plugin.runtime, "mcp");
} finally {
  globalThis.fetch = originalFetch;
}

function getHeaderValue(headers, name) {
  if (headers?.get) return headers.get(name);
  return headers?.[name] || headers?.[String(name || "").toLowerCase()] || "";
}

contributions = await runtime.listSkillContributions({ pageUrl: "https://www.xiaohongshu.com/explore/abc" });
const updatedXhsContribution = contributions.plugins.find(plugin => plugin.id === "xhs-booster");
assert.equal(Object.prototype.hasOwnProperty.call(updatedXhsContribution, "config"), false);
assert.equal(updatedXhsContribution.displayName, "小红书增强");
assert.equal(updatedXhsContribution.category.label, "采集");
assert.equal(updatedXhsContribution.tools[0].renderer.type, "list");

const noRendererManifest = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "plain-plugin",
  name: "普通脚本插件",
  tools: [{ name: "plain_run", title: "普通脚本", script: "scripts/plain.js" }],
};
replacePluginRegistryFromSkills([
  {
    name: "普通脚本插件",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{ path: "plugin.json", type: "json", content: JSON.stringify(noRendererManifest) }],
  },
]);
const frozenSchemasAfterRefresh = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: { taskSiteTabs: [{ url: "https://www.xiaohongshu.com/explore/abc" }] },
  skillToolRegistrySnapshot: frozenRegistry,
});
assert.equal(frozenSchemasAfterRefresh.some(schema => schema.function.name === "xhs_booster__collect_notes"), true);
assert.equal(frozenSchemasAfterRefresh.some(schema => schema.function.name === "plain_plugin__plain_run"), false);
assert.equal(
  runtime.getSkillToolDefinition("xhs_booster__collect_notes", { skillToolRegistrySnapshot: frozenRegistry }).plugin.id,
  "xhs-booster",
);
const frozenIdentity = tools.getToolIdentity("xhs_booster__collect_notes", { skillToolRegistrySnapshot: frozenRegistry });
assert.equal(frozenIdentity.title, "采集笔记");
assert.equal(frozenIdentity.familyId, "plugin:collector");
assert.equal(runtime.getSkillToolDefinition("plain_plugin__plain_run", { skillToolRegistrySnapshot: frozenRegistry }), null);
const plainResult = await runtime.executeSkillTool(
  "plain_plugin__plain_run",
  { timeout: 0 },
  null,
  { workingTabId: 7 },
  async () => ({
    ok: true,
    hasResult: true,
    resultType: "object",
    result: { value: 1 },
  }),
);
assert.equal(plainResult._plugin.renderer, null);
assert.equal(plainResult._plugin.script, "scripts/plain.js");
assert.equal(plainResult.result._plugin.script, "scripts/plain.js");

const collisionManifestA = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "same-plugin",
  name: "插件 A",
  tools: [{ name: "do_work", title: "执行 A", script: "scripts/a.js" }],
};
const collisionManifestB = {
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "same-plugin",
  name: "插件 B",
  tools: [{ name: "do_work", title: "执行 B", script: "scripts/b.js" }],
};
const collisionSnapshot = replacePluginRegistryFromSkills([
  {
    name: "插件 A",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{ path: "plugin.json", type: "json", content: JSON.stringify(collisionManifestA) }],
  },
  {
    name: "插件 B",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{ path: "plugin.json", type: "json", content: JSON.stringify(collisionManifestB) }],
  },
]);
const collisionSchemas = runtime.getActiveSkillToolSchemasSync({
  dynamicContext: {},
  loadedPluginSkillNames: [toAgentSkillName("插件 A")],
});
assert.equal(collisionSchemas.filter(item => item.function.name === "same_plugin__do_work").length, 1);
assert.equal(runtime.getSkillToolDefinition("same_plugin__do_work").plugin.skillName, toAgentSkillName("插件 A"));
assert.equal(collisionSnapshot.diagnostics.some(item => item.toolName === "same_plugin__do_work"), true);

const layoutSnapshot = replacePluginRegistryFromSkills([
  {
    name: "组合渲染插件",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{
      path: "plugin.json",
      type: "json",
      content: JSON.stringify({
        format: SKILL_MANIFEST_FORMAT,
        schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
        id: "layout-plugin",
        displayName: "组合渲染",
        tools: [{ name: "render_mix", title: "组合展示", script: "scripts/render.js" }],
        renderers: {
          tools: {
            render_mix: {
              type: "summary",
              layout: {
                type: "stack",
                blocks: [
                  { type: "summary", sourcePath: "summary", fields: [{ label: "数量", path: "count" }] },
                  { type: "table", sourcePath: "videos", columns: [{ label: "标题", path: "title" }] },
                  { type: "image_grid", sourcePath: "covers", maxItems: 6 },
                  { type: "markdown", sourcePath: "notes" },
                ],
              },
            },
          },
        },
      }),
    }],
  },
]);
const layoutRenderer = layoutSnapshot.plugins[0].renderers.tools.layout_plugin__render_mix;
assert.equal(layoutRenderer.layout.blocks.length, 4);
assert.equal(layoutRenderer.layout.blocks[0].sourcePath, "summary");
assert.equal(layoutRenderer.layout.blocks[1].type, "table");
assert.equal(layoutRenderer.layout.blocks[1].sourcePath, "videos");
assert.equal(layoutRenderer.layout.blocks[2].type, "image_grid");
assert.equal(layoutRenderer.layout.blocks[2].sourcePath, "covers");
assert.equal(layoutRenderer.layout.blocks[2].maxItems, 6);
assert.equal(layoutRenderer.layout.blocks[3].type, "markdown");
assert.equal(layoutRenderer.layout.blocks[3].sourcePath, "notes");
const layoutContract = pluginRenderers.buildSkillRendererReturnContract(layoutRenderer);
assert.match(layoutContract, /组合 UI renderer/);
assert.match(layoutContract, /字段 videos/);
assert.match(layoutContract, /rows/);
assert.match(layoutContract, /字段 covers/);
assert.match(layoutContract, /images/);
const availableRendererTypes = pluginRenderers.listSkillRendererDefinitions().map(renderer => renderer.type);
assert.equal(availableRendererTypes.includes("image_grid"), true);
assert.equal(availableRendererTypes.includes("code"), true);
assert.equal(availableRendererTypes.includes("diff"), true);

const invalidRendererSnapshot = replacePluginRegistryFromSkills([
  {
    name: "非法渲染插件",
    format: QINGZHOU_SKILL_FORMAT,
    schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{
      path: "plugin.json",
      type: "json",
      content: JSON.stringify({
        format: SKILL_MANIFEST_FORMAT,
        schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
        id: "invalid-renderer-plugin",
        tools: [{ name: "show", script: "scripts/show.js", renderer: { type: "imageGrid" } }],
        renderers: {
          tools: {
            show: {
              type: "summary",
              layout: {
                blocks: [{ type: "keyValue", sourcePath: "summary" }],
              },
            },
          },
        },
      }),
    }],
  },
]);
const invalidRendererTool = invalidRendererSnapshot.plugins[0].tools[0];
assert.equal(invalidRendererTool.renderer, null);
const invalidRenderer = invalidRendererSnapshot.plugins[0].renderers.tools.invalid_renderer_plugin__show;
assert.equal(invalidRenderer.type, "summary");
assert.equal(Object.prototype.hasOwnProperty.call(invalidRenderer, "layout"), false);
assert.equal(invalidRendererSnapshot.diagnostics.some(item => /imageGrid/.test(item.message)), true);
assert.equal(invalidRendererSnapshot.diagnostics.some(item => /keyValue/.test(item.message)), true);

console.log("qingzhou plugin tests passed");

function readSource(relative) {
  const path = new URL(relative, import.meta.url);
  const sourcePath = existsSync(path) ? path : new URL(relative.replace(/\.js$/, ".ts"), import.meta.url);
  return readFileSync(sourcePath, "utf8");
}

import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storageData = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storageData[item]]));
        if (typeof key === "string") return { [key]: storageData[key] };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [item, storageData[item] ?? fallback]));
        }
        return { ...storageData };
      },
      async set(values) {
        Object.assign(storageData, values);
      },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
      },
    },
  },
};

const tools = await import("../../src/background/tools/runtime.js");
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
const skills = await import("../../src/background/skills/runtime.js");
const prompts = await import("../../src/background/agent/prompts.js");
const mcpSkill = await import("../../src/capabilities/mcp/embedded-skill.js");
const contract = await import("../../src/capabilities/mcp/skill-contract.js");
const toolModel = await import("../../src/sidepanel/tools/tool-model.js");
const pluginUi = await import("../../src/sidepanel/tools/skill-tool-ui-registry.js");

const loadedContext = Object.freeze({
  source: "test",
  sessionId: "session_mcp_test",
  runId: "run_mcp_test",
  loadedPluginSkillNames: [mcpSkill.BUILTIN_QINGZHOU_MCP_SKILL_NAME],
});

await runtime.commitSkillToolRegistryCandidate(
  await runtime.prepareSkillToolRegistryFromStorage(),
  { reason: "test_qingzhou_mcp_skill" },
);
pluginUi.setSkillToolUiCatalog(await runtime.listSkillContributions(loadedContext));

const initialNames = tools.getToolSchemas().map(item => item.function?.name);
for (const coreName of contract.MCP_TOOL_CORE_NAMES) {
  const pluginName = contract.getMcpSkillToolName(coreName);
  assert.equal(initialNames.includes(coreName), false, `${coreName} should not stay resident`);
  assert.equal(initialNames.includes(pluginName), false, `${pluginName} should be absent before load_skill`);
}

await assert.rejects(
  () => tools.executeTool(contract.getMcpSkillToolName("mcp_list_tools"), {}, null, { source: "test" }),
  err => err?.code === "UNKNOWN_TOOL",
  "MCP plugin tools should not execute before the skill is loaded",
);

const loadedSkill = await skills.loadSkill(mcpSkill.BUILTIN_QINGZHOU_MCP_SKILL_NAME);
assert.equal(loadedSkill.name, "qingzhou-mcp");
assert.equal(loadedSkill.metadata.displayName, "MCP 接入");
assert.equal(loadedSkill.scope, "global");
assert.equal(loadedSkill.builtin, true);
assert.equal(loadedSkill.readOnly, true);
assert.match(loadedSkill.content, /已写入某个 skill 的 MCP[\s\S]*虚拟全局 registry/);
assert.match(loadedSkill.content, /qingzhou_mcp__mcp_inspect_server/);
assert.match(loadedSkill.content, /qingzhou_mcp__mcp_call_tool/);
assert.match(loadedSkill.content, /不要为了探测创建临时 skill/);
assert.match(loadedSkill.content, /加载 `skill-workbench`/);
assert.match(loadedSkill.content, /真实返回结构选择轻舟标准 renderer/);
assert.match(loadedSkill.content, /不要把原本只有自然语言的 MCP 文本臆测成表格/);
assert.match(loadedSkill.content, /最后通过该 Skill 工具做正式调用并确认结果 UI/);

const manifest = JSON.parse(loadedSkill.resources.find(resource => resource.path === "plugin.json")?.content || "{}");
assert.equal(manifest.id, contract.QINGZHOU_MCP_SKILL_ID);
assert.deepEqual(manifest.tools.map(tool => tool.name), contract.MCP_TOOL_CORE_NAMES);
assert.ok(manifest.tools.every(tool => tool.runtime === "host" && tool.needsPage === false));
assert.ok(manifest.tools.every(tool => tool.includeTrace === false));
assert.ok(manifest.tools.every(tool => !Object.hasOwn(tool, "title")), "MCP tool titles should inherit shared capability metadata");
assert.equal(loadedSkill.resources.filter(resource => resource.type === "script").length, contract.MCP_TOOL_CORE_NAMES.length);

const catalog = await skills.buildSkillPromptSection();
assert.match(catalog, /qingzhou-mcp（MCP 接入）/);
assert.match(catalog, /发现已注册的 MCP 能力/);
await assert.rejects(
  () => skills.updateSkill("qingzhou-mcp", { description: "x" }),
  err => err?.code === "SKILL_READ_ONLY",
);

const loadedSchemas = tools.getToolSchemas(loadedContext);
const loadedNames = loadedSchemas.map(item => item.function?.name);
for (const coreName of contract.MCP_TOOL_CORE_NAMES) {
  const pluginName = contract.getMcpSkillToolName(coreName);
  assert.equal(loadedNames.includes(coreName), false, `${coreName} should remain hidden after load_skill`);
  const schema = loadedSchemas.find(item => item.function?.name === pluginName)?.function;
  assert.ok(schema, `${pluginName} should be exposed after load_skill`);
  assert.ok(schema.description.startsWith(contract.QINGZHOU_MCP_TOOL_SPECS[coreName].description));
  assert.ok(Object.prototype.hasOwnProperty.call(schema.parameters.properties, "timeout"), `${pluginName} should receive common timeout control`);
}

const forwardingCases = {
  mcp_inspect_server: { url: "https://mcp.example.com/mcp", name: "docs", headers: { Authorization: "Bearer secret" }, refresh: true },
  mcp_list_tools: { server: "docs:main", activeOnly: false, limit: 12 },
  mcp_search_tools: { query: "library", server: "docs:main", activeOnly: true, limit: 8 },
  mcp_call_tool: { url: "https://mcp.example.com/mcp", name: "docs", tool: "resolve-library", args: { name: "svelte" }, validate: true },
};

for (const [coreName, input] of Object.entries(forwardingCases)) {
  const calls = [];
  const result = await runtime.executeSkillTool(
    contract.getMcpSkillToolName(coreName),
    { ...input, timeout: 45 },
    null,
    loadedContext,
    async (name, args, _signal, context) => {
      calls.push({ name, args, context });
      return { ok: true, coreName: name, echoed: args };
    },
  );
  assert.equal(calls.length, 1, `${coreName} should dispatch exactly once`);
  assert.equal(calls[0].name, coreName);
  assert.deepEqual(calls[0].args, input, `${coreName} should forward business args unchanged`);
  assert.equal(calls[0].context.source, "plugin_host");
  assert.equal(calls[0].context.sessionId, loadedContext.sessionId);
  assert.equal(calls[0].context.runId, loadedContext.runId);
  assert.equal(result.coreName, coreName);
  assert.equal(getToolResultPresentation(result)._plugin.id, contract.QINGZHOU_MCP_SKILL_ID);
  assert.equal(getToolResultPresentation(result)._plugin.runtime, "host");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "trace"), false, `${coreName} should not duplicate its result into host trace`);
}

assert.match(prompts.SYSTEM_PROMPT, /先加载当前可用的 MCP 接入技能/, "kernel should route MCP workflows through the on-demand skill");
assert.doesNotMatch(prompts.SYSTEM_PROMPT, /mcp_inspect_server|mcp_list_tools|mcp_search_tools|mcp_call_tool/, "kernel should not duplicate the MCP tool SOP");
const agentSource = readFileSync(new URL("../../src/background/agent/agent.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  agentSource,
  /toolCallMayContainWriteOnlySecrets|sanitizeToolArgsForStorage|sensitiveToolArgText/,
  "MCP arguments should not use a separate persistence path based on their field names",
);

for (const coreName of contract.MCP_TOOL_CORE_NAMES) {
  const pluginName = contract.getMcpSkillToolName(coreName);
  const definition = tools.resolveToolDefinition(pluginName);
  const identity = pluginUi.enrichSkillToolIdentity({ name: pluginName });
  assert.equal(definition.capabilityId, coreName);
  assert.equal(identity.capabilityId, coreName);
  assert.equal(toolModel.getToolDisplayName(identity), toolModel.getToolDisplayName(coreName));
  assert.equal(toolModel.getToolProfileFamily(identity), toolModel.getToolProfileFamily(coreName));
  assert.equal(toolModel.getToolResultFamily(identity), toolModel.getToolResultFamily(coreName));
  assert.equal(toolModel.getToolTimelineFamilyInfo(identity).id, "mcp");
}

console.log("qingzhou MCP skill tests passed");

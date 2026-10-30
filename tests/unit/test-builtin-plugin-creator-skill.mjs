import assert from "node:assert/strict";
import { getBuiltinSkillWorkbenchDisplayName, BUILTIN_SKILL_WORKBENCH_NAME } from "../../src/capabilities/skills/workbench.js";
import { getBuiltinSiteSkillAuthorDisplayName, BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME } from "../../src/capabilities/skills/site-author.js";

import {
  findBuiltinSkill,
  isBuiltinSkill,
  mergeBuiltinSkills,
} from "../../src/shared/skills/builtin-skills.js";
import { SYSTEM_PROMPT } from "../../src/background/agent/prompts.js";
import {
  getSkillDisplayName,
  QINGZHOU_SKILL_FORMAT,
  QINGZHOU_SKILL_SCHEMA_VERSION,
  skillMatchesName,
  toAgentSkillName,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";
import { SKILL_SETTING_FIELD_TYPES } from "../../src/shared/skills/skill-settings.js";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { modelT } from "../../src/capabilities/skills/model-messages.js";

const storage = {
  _skills: {
    "旧技能": {
      name: "旧技能",
      description: "旧格式技能",
      content: "旧格式正文",
      scope: "global",
      updatedAt: "2026-06-01 09:00:00",
    },
    "用户技能": {
      name: "用户技能",
      description: "普通用户技能",
      content: "用户技能正文",
      scope: "global",
      format: QINGZHOU_SKILL_FORMAT,
      schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
      updatedAt: "2026-06-01 10:00:00",
    },
    "用户系统提示": {
      name: "用户系统提示",
      description: "用户自定义常驻系统说明",
      content: "每次回答都要先确认关键假设。",
      scope: "resident",
      format: QINGZHOU_SKILL_FORMAT,
      schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
      updatedAt: "2026-06-01 10:30:00",
    },
    [BUILTIN_SKILL_WORKBENCH_NAME]: {
      name: BUILTIN_SKILL_WORKBENCH_NAME,
      description: "不应该覆盖内置技能",
      content: "shadow",
      scope: "global",
      updatedAt: "2026-06-01 11:00:00",
    },
    [BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME]: {
      name: BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME,
      description: "不应该覆盖内置站点技能生成器",
      content: "site author shadow",
      scope: "global",
      updatedAt: "2026-06-01 11:05:00",
    },
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(value) {
        Object.assign(storage, value);
      },
    },
  },
};

const skills = await import("../../src/background/skills/runtime.js");
const runtime = await import("../../src/background/skills/skill-tool-runtime.js");
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
const loadedSkillWorkbenchContext = Object.freeze({
  loadedPluginSkillNames: [BUILTIN_SKILL_WORKBENCH_NAME],
});

function executeSkillWorkbenchTool(name, args, signal = null, context = {}) {
  return skillMutationToolRuntime.execute(name, args, signal, {
    ...context,
    loadedPluginSkillNames: loadedSkillWorkbenchContext.loadedPluginSkillNames,
  });
}

function findStoredSkill(name) {
  return Object.values(storage._skills || {}).find(skill => skillMatchesName(skill, name)) || null;
}

function storedSkill(name) {
  const skill = findStoredSkill(name);
  assert.ok(skill, `expected stored skill ${name}`);
  return skill;
}

function hasSkill(list, name) {
  return list.some(skill => skillMatchesName(skill, name));
}

for (const language of ['en', 'zh-CN']) {
  const workbench = findBuiltinSkill(BUILTIN_SKILL_WORKBENCH_NAME, language);
  const examples = [...workbench.content.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const pageTool = examples.find(example => example.id === 'page-inspector').tools[0];
  assert.deepEqual(pageTool.parameters.properties.tabRef.type, ['integer', 'string']);
  assert.equal(pageTool.parameters.properties.tabId, undefined);
  assert.match(workbench.content, /tabRef/);
  // The one remaining mention explains the host-resolved script runtime value, not call arguments.
  assert.equal((workbench.content.match(/\btabId\b/g) || []).length, 1);
  for (const resource of workbench.resources.filter(resource => resource.type === 'script')) {
    assert.doesNotMatch(resource.content, /\btabId\b/, `${language}: ${resource.path}`);
  }
  const guidance = withLanguage(language, () => modelT('runtimeGuidance'));
  assert.match(guidance, /tabRef/);
  assert.equal((guidance.match(/\btabId\b/g) || []).length, 1);
  assert.doesNotMatch(findBuiltinSkill(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME, language).content, /\btabId\b/);
}

const builtin = findBuiltinSkill(BUILTIN_SKILL_WORKBENCH_NAME);
const removedLegacyBuiltinName = `轻舟${getBuiltinSkillWorkbenchDisplayName()}`;
assert.equal(Boolean(builtin), true);
assert.equal(findBuiltinSkill(removedLegacyBuiltinName), null);
assert.equal(builtin.name, BUILTIN_SKILL_WORKBENCH_NAME);
assert.equal(getSkillDisplayName(builtin), getBuiltinSkillWorkbenchDisplayName());
assert.equal(builtin.readOnly, true);
assert.equal(builtin.builtin, true);
assert.equal(isBuiltinSkill(builtin), true);
assert.match(builtin.description, /通用轻舟 skill 管理工作台/);
assert.match(builtin.description, /创建、更新、删除某个 skill/);
assert.match(builtin.description, /编辑某个 skill 的 content、plugin\.json、scripts、resources/);
assert.match(builtin.description, /探测并导入 Git Skill 仓库/);
assert.match(builtin.description, /本地 Skill 安装到 Git/);
assert.match(builtin.description, /给具体网站生成站点能力时使用 site-skill-author/);
assert.match(builtin.content, /系统指令调整、长久记忆信息/);
assert.match(builtin.content, /`scope: "resident"` 的常驻技能/);
assert.match(builtin.content, /根目录 `plugin\.json`/);
assert.match(builtin.content, /`scripts\/\*\.js`/);
assert.match(builtin.content, /Skill 工具曝光由 skill 的 `scope` 决定/);
assert.match(builtin.content, /`scope:"global"` 只在当前会话 `load_skill` 后曝光/);
assert.match(builtin.content, /`builtin`、`readOnly` 和 `source` 只描述来源与权限，不改变加载策略/);
assert.match(builtin.content, /MCP 接入 SOP/);
assert.match(builtin.content, /load_skill\("qingzhou-mcp"\)/);
assert.doesNotMatch(builtin.content, /mcp_inspect_server|mcp_call_tool/);
assert.doesNotMatch(builtin.content, /mcp_call_tool_directly/);
assert.match(builtin.content, /runtime:"mcp"/);
assert.match(builtin.content, /按用户任务场景选择稳定业务分类/);
assert.match(builtin.content, /真实返回 shape[\s\S]*读取可用渲染器/);
assert.match(builtin.content, /为选中的工具配置[^\n]*匹配返回结构的 `renderer`/);
assert.match(builtin.content, /"runtime": "mcp"[\s\S]*"renderer": \{[\s\S]*"type": "text"/);
assert.match(builtin.content, /"displayName": "文档 MCP"[\s\S]*"category": \{ "id": "research", "label": "研究" \}[\s\S]*"mcpServers"/);
assert.doesNotMatch(builtin.content, /activation\.mode/);
assert.match(builtin.content, /列出技能/);
assert.match(builtin.content, /导入页面 Zip/);
assert.match(builtin.content, /不扫描 DOM、Network 或猜测 URL/);
assert.match(builtin.content, /探测并导入 Git 仓库/);
assert.match(builtin.content, /安装 Skill 到 Git/);
const settingsDslSection = builtin.content.match(/## Skill 设置 DSL 与 inner 网络([\s\S]*?)## 脚本约定/)?.[1] || "";
assert.ok(settingsDslSection, "workbench should contain a dedicated Skill settings DSL section");
for (const fieldType of SKILL_SETTING_FIELD_TYPES) {
  assert.ok(settingsDslSection.includes("`" + fieldType + "`"), `workbench should document the ${fieldType} setting field type`);
}
assert.match(settingsDslSection, /`width` 只支持 `full`（默认，整行）或 `half`/, "workbench should document every setting field width");
assert.match(settingsDslSection, /settings\.layout\.sections/, "workbench should document the generic Skill settings grouping DSL");
assert.match(settingsDslSection, /每组支持 `title`、可选 `description` 和字段 key 数组 `fields`/, "workbench should document the complete settings section shape");
assert.match(settingsDslSection, /布尔开关使用 `boolean`/, "workbench should specify the supported switch field type");
assert.match(settingsDslSection, /`text` 可声明正则字符串 `pattern`/);
assert.match(settingsDslSection, /`secret` 可声明 `reenterWhen`/);
assert.match(settingsDslSection, /`number` 可声明 `min`、`max`、`step`/);
assert.match(settingsDslSection, /`select` 必须声明非空 `options`/);
assert.match(builtin.content, /实际读写配置值时加载 `qingzhou-management`/, "workbench should separate manifest schema authoring from user setting values");
assert.match(builtin.content, /secret 不在 manifest 声明 default/, "workbench should route secrets through the settings service");
const settingsExampleSource = settingsDslSection.match(/```json\n([\s\S]*?)\n```/)?.[1] || "";
const settingsExample = JSON.parse(settingsExampleSource);
assert.deepEqual(new Set(settingsExample.settings.fields.map(field => field.type)), SKILL_SETTING_FIELD_TYPES, "settings example should cover every supported field type");
assert.equal(settingsExample.settings.fields.filter(field => field.width === "half").length, 4);
assert.match(builtin.content, /source:"args"[\s\S]*不要求脚本把输入复制进 return/, "workbench should document args-backed renderer blocks");
assert.match(builtin.content, /totalPath[\s\S]*truncatedPath/, "workbench should document complete and truncated table metadata");
assert.equal(builtin.resources.some(resource => resource.path === "plugin.json"), true);
const workbenchPluginManifest = JSON.parse(builtin.resources.find(resource => resource.path === "plugin.json").content);
assert.match(workbenchPluginManifest.description, /通用轻舟 skill 的创建、更新、删除、列出、包导入和 Git 分发工具/);
assert.match(workbenchPluginManifest.description, /创建、修改、删除某个已指定的 skill/);
assert.match(workbenchPluginManifest.description, /给具体网站生成站点 skill、Skill 工具、采集工具或网页操作能力时使用 site-skill-author/);
const editSkillResourceTool = workbenchPluginManifest.tools.find(tool => tool.name === "edit_skill_resource");
const editSkillResourceContentDescription = editSkillResourceTool?.parameters?.properties?.content?.description || "";
const editSkillResourceFieldTypes = editSkillResourceContentDescription.match(/settings\.fields\[\]\.type 只支持 ([^，]+)/)?.[1].split("|") || [];
assert.deepEqual(new Set(editSkillResourceFieldTypes), SKILL_SETTING_FIELD_TYPES, "edit_skill_resource should expose every supported setting field type");
assert.match(editSkillResourceContentDescription, /width 只支持 full\|half/);
assert.match(editSkillResourceContentDescription, /settings\.layout\.sections/);
assert.match(editSkillResourceContentDescription, /完整约束见已加载 skill-workbench/);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/create-skill.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/edit-skill-resource.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/update-skill.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/delete-skill.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/list-skills.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/load-available-renderers.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/import-page-zip.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/import-git-repository.js"), true);
assert.equal(builtin.resources.some(resource => resource.path === "scripts/install-skill-to-git.js"), true);

const siteSkillAuthorBuiltin = findBuiltinSkill(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME);
assert.equal(Boolean(siteSkillAuthorBuiltin), true);
assert.equal(siteSkillAuthorBuiltin.name, BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME);
assert.equal(getSkillDisplayName(siteSkillAuthorBuiltin), getBuiltinSiteSkillAuthorDisplayName());
assert.equal(siteSkillAuthorBuiltin.scope, "global");
assert.equal(siteSkillAuthorBuiltin.readOnly, true);
assert.equal(siteSkillAuthorBuiltin.builtin, true);
assert.equal(isBuiltinSkill(siteSkillAuthorBuiltin), true);
assert.match(siteSkillAuthorBuiltin.description, /面向具体网站、网页或域名的站点能力生成器/);
assert.match(siteSkillAuthorBuiltin.description, /让轻舟学会某个站点/);
assert.match(siteSkillAuthorBuiltin.description, /为该站点创建 site skill、Skill 工具、采集工具、网页操作能力/);
assert.match(siteSkillAuthorBuiltin.description, /从网站需求出发设计站点专用能力/);
assert.match(siteSkillAuthorBuiltin.description, /创建、更新、删除某个已指定的 skill/);
assert.match(siteSkillAuthorBuiltin.description, /编辑其 content、plugin\.json、scripts、resources，用 skill-workbench/);
assert.match(siteSkillAuthorBuiltin.content, /^# 站点 Skill 生成器/);
assert.match(siteSkillAuthorBuiltin.content, /先调用 `load_skill\(\{ name: "skill-workbench" \}\)`/);
assert.match(siteSkillAuthorBuiltin.content, /### 3\.2 Preflight Gate/);
assert.match(siteSkillAuthorBuiltin.content, /#### 3\.4\.1 执行域验证/);
assert.match(siteSkillAuthorBuiltin.content, /#### 3\.4\.2 功能地图与候选工具菜单/);
assert.match(siteSkillAuthorBuiltin.content, /#### 3\.4\.3 用户共同设计 gate/);
assert.match(siteSkillAuthorBuiltin.content, /#### 3\.7\.3 最终报告门/);
assert.match(siteSkillAuthorBuiltin.content, /表单是给用户看的[\s\S]*不要外露内部流程词/);
assert.match(siteSkillAuthorBuiltin.content, /首次创建带工具的站点 Skill[\s\S]*qingzhou_skill_author__create_skill/);
assert.match(siteSkillAuthorBuiltin.content, /qingzhou_skill_author__edit_skill_resource/);
assert.match(siteSkillAuthorBuiltin.content, /一次调用只改一个资源/);
assert.doesNotMatch(siteSkillAuthorBuiltin.content, /resourceEdits:\[\{ action:"set"/);
assert.match(siteSkillAuthorBuiltin.content, /runtime tool 的正式 smoke 必须在 skill 的 `domains` 和 `urlPatterns` 匹配到的真实执行域完成/);
assert.deepEqual(siteSkillAuthorBuiltin.resources, []);

assert.match(SYSTEM_PROMPT, /Durable 产物协议/);
assert.match(SYSTEM_PROMPT, /涉及创建、更新、删除 skill[\s\S]*先从当前可用技能中选择技能管理能力[\s\S]*load_skill/);
assert.match(SYSTEM_PROMPT, /只能直接执行 JavaScript[\s\S]*依据当前可用的技能管理指南[\s\S]*不得承诺完整兼容/);
assert.match(SYSTEM_PROMPT, /create_skill[\s\S]*edit_skill_resource[\s\S]*每次调用只编辑一个资源、执行一个 action/);
assert.match(SYSTEM_PROMPT, /为具体网站、网页或域名生成站点 skill、Skill 工具、采集工具或网页操作能力[\s\S]*先从当前可用技能中选择站点技能生成能力[\s\S]*load_skill/);
assert.match(SYSTEM_PROMPT, /探测、搜索、试调用或接入 MCP[\s\S]*先加载当前可用的 MCP 接入技能/);
assert.doesNotMatch(SYSTEM_PROMPT, /mcp_inspect_server|mcp_list_tools|mcp_search_tools|mcp_call_tool/);
assert.doesNotMatch(SYSTEM_PROMPT, /Skill 是浏览器操作 SOP|脚本运行在页面上下文/, "kernel prompt must not describe every Skill as page-only");
assert.match(SYSTEM_PROMPT, /runtime:"page"[\s\S]*runtime:"inner"[\s\S]*\$plugin\.config[\s\S]*network\.allowedOrigins/, "kernel prompt should distinguish page and inner Plugin runtimes");

const merged = mergeBuiltinSkills(Object.values(storage._skills));
assert.equal(merged.filter(skill => skill.name === BUILTIN_SKILL_WORKBENCH_NAME).length, 1);
assert.equal(merged.find(skill => skill.name === BUILTIN_SKILL_WORKBENCH_NAME).content, builtin.content);
assert.equal(merged.filter(skill => skill.name === BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME).length, 1);
assert.equal(merged.find(skill => skill.name === BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME).content, siteSkillAuthorBuiltin.content);
assert.equal(hasSkill(merged, "用户技能"), true);
assert.equal(hasSkill(merged, "用户系统提示"), true);
assert.equal(hasSkill(merged, "旧技能"), false);

const listed = await skills.listSkills();
assert.equal(listed[0].name, BUILTIN_SKILL_WORKBENCH_NAME);
assert.equal(listed.filter(skill => skill.name === BUILTIN_SKILL_WORKBENCH_NAME).length, 1);
assert.equal(listed.filter(skill => skill.name === BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME).length, 1);
assert.equal(hasSkill(listed, "用户技能"), true);
assert.equal(hasSkill(listed, "用户系统提示"), true);
assert.equal(hasSkill(listed, "旧技能"), true);
assert.equal(storedSkill("旧技能").format, QINGZHOU_SKILL_FORMAT);
assert.equal(storedSkill("旧技能").schemaVersion, QINGZHOU_SKILL_SCHEMA_VERSION);
assert.deepEqual(storedSkill("旧技能").resources, []);

const promptSection = await skills.buildSkillPromptSection();
assert.match(promptSection, new RegExp(BUILTIN_SKILL_WORKBENCH_NAME));
assert.match(promptSection, /通用轻舟 skill 管理工作台/);
assert.match(promptSection, /给具体网站生成站点能力时使用 site-skill-author/);
assert.match(promptSection, /Resident Skills/);
assert.match(promptSection, /每次回答都要先确认关键假设。/);

const loadedBuiltin = await skills.loadSkill(BUILTIN_SKILL_WORKBENCH_NAME);
assert.equal(loadedBuiltin.name, BUILTIN_SKILL_WORKBENCH_NAME);
assert.equal(getSkillDisplayName(loadedBuiltin), getBuiltinSkillWorkbenchDisplayName());
assert.notEqual(loadedBuiltin.content, "shadow");
assert.equal(loadedBuiltin.readOnly, true);

const loadedSiteSkillAuthor = await skills.loadSkill(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME);
assert.equal(loadedSiteSkillAuthor.name, BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME);
assert.equal(getSkillDisplayName(loadedSiteSkillAuthor), getBuiltinSiteSkillAuthorDisplayName());
assert.notEqual(loadedSiteSkillAuthor.content, "site author shadow");
assert.match(loadedSiteSkillAuthor.content, /用户共同设计 gate/);
assert.match(loadedSiteSkillAuthor.content, /get_ax_tree\(\{ root:"root" \}\)/);
assert.match(loadedSiteSkillAuthor.content, /read_article[\s\S]*显式传 `limit`/);
assert.match(loadedSiteSkillAuthor.content, /outline[\s\S]*offset\/endOffset\/charCount/);
assert.match(loadedSiteSkillAuthor.content, /sourceSelector[\s\S]*read_dom/);
assert.match(loadedSiteSkillAuthor.content, /lineRange[\s\S]*read_dom/);
assert.doesNotMatch(loadedSiteSkillAuthor.content, /includeLinks|includeHtml|context_store|read_dom\([^)]*depth/);
assert.equal(loadedSiteSkillAuthor.readOnly, true);

const loadedUser = await skills.loadSkill("用户技能");
assert.equal(loadedUser.content, "用户技能正文");
assert.equal(loadedUser.name, toAgentSkillName("用户技能"));
assert.equal(getSkillDisplayName(loadedUser), "用户技能");
assert.equal((await skills.loadSkill("旧技能")).content, "旧格式正文");

await assert.rejects(
  () => skills.saveSkill(BUILTIN_SKILL_WORKBENCH_NAME, "x", "y"),
  err => err?.code === "SKILL_READ_ONLY",
);
await assert.rejects(
  () => skills.updateSkill(BUILTIN_SKILL_WORKBENCH_NAME, { description: "x" }),
  err => err?.code === "SKILL_READ_ONLY",
);
await assert.rejects(
  () => skills.updateSkill("用户技能", { renameTo: BUILTIN_SKILL_WORKBENCH_NAME }),
  err => err?.code === "SKILL_READ_ONLY",
);
await assert.rejects(
  () => skills.deleteSkill(BUILTIN_SKILL_WORKBENCH_NAME),
  err => err?.code === "SKILL_READ_ONLY",
);
await assert.rejects(
  () => skills.updateSkill(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME, { description: "x" }),
  err => err?.code === "SKILL_READ_ONLY",
);
await assert.rejects(
  () => skills.deleteSkill(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME),
  err => err?.code === "SKILL_READ_ONLY",
);

const saved = await skills.saveSkill("插件样例", "插件样例", "content", {
  resources: [{
    path: "plugin.json",
    type: "json",
    content: JSON.stringify({
      format: SKILL_MANIFEST_FORMAT,
      schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
      id: "sample",
      displayName: "样例插件",
    }),
  }],
});
assert.equal(saved.name, toAgentSkillName("插件样例"));
assert.equal(getSkillDisplayName(saved), "插件样例");
assert.equal(storedSkill("插件样例").resources[0].path, "plugin.json");
assert.equal(storedSkill("插件样例").format, QINGZHOU_SKILL_FORMAT);
assert.equal(storedSkill("插件样例").schemaVersion, QINGZHOU_SKILL_SCHEMA_VERSION);

const overwrittenLegacy = await skills.saveSkill("旧技能", "新格式覆盖旧格式", "modern content");
assert.equal(overwrittenLegacy.content, "modern content");
assert.equal(storedSkill("旧技能").format, QINGZHOU_SKILL_FORMAT);
assert.equal((await skills.loadSkill("旧技能")).content, "modern content");

await reloadPluginRegistry();
const unloadedSchemas = tools.getToolSchemas({});
const unloadedSchemaNames = unloadedSchemas.map(schema => schema.function?.name).filter(Boolean);
assert.equal(unloadedSchemaNames.includes("qingzhou_skill_author__create_skill"), false);
assert.equal(unloadedSchemaNames.includes("qingzhou_skill_author__edit_skill_resource"), false);
await assert.rejects(
  () => tools.executeTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "all" }, null, {}),
  err => err?.code === "UNKNOWN_TOOL",
);

const schemas = tools.getToolSchemas(loadedSkillWorkbenchContext);
const schemaNames = schemas.map(schema => schema.function?.name).filter(Boolean);
assert.equal(schemaNames.includes("update_skill"), false);
assert.equal(schemaNames.includes("delete_skill"), false);
assert.equal(schemaNames.includes("manage_skill"), false);
assert.equal(schemaNames.includes("qingzhou_skill_author__create_skill"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__edit_skill_resource"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__update_skill"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__delete_skill"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__list_skills"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__load_available_renderers"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__import_page_zip"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__import_git_repository"), true);
assert.equal(schemaNames.includes("qingzhou_skill_author__install_skill_to_git"), true);

const contributions = await runtime.listSkillContributions({});
const authorPlugin = contributions.plugins.find(plugin => plugin.id === "qingzhou-skill-author");
assert.equal(Boolean(authorPlugin), true);
assert.equal(authorPlugin.active, false);
const loadedContributions = await runtime.listSkillContributions(loadedSkillWorkbenchContext);
assert.equal(loadedContributions.plugins.find(plugin => plugin.id === "qingzhou-skill-author")?.active, true);
assert.equal(authorPlugin.tools.find(tool => tool.localName === "create_skill").renderer.type, "skill");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "create_skill").renderer.action, "create");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "edit_skill_resource").renderer.type, "skill");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "edit_skill_resource").renderer.action, "edit_resource");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "update_skill").renderer.action, "update");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "delete_skill").renderer.action, "delete");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "list_skills").renderer.type, "table");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "load_available_renderers").renderer.type, "table");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "import_page_zip").renderer.type, "summary");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "import_git_repository").renderer.type, "summary");
assert.equal(authorPlugin.tools.find(tool => tool.localName === "install_skill_to_git").renderer.type, "summary");
// Portable exports must pass the same selected arguments as the trusted host adapter.
for (const localName of ["create_skill", "update_skill", "delete_skill", "edit_skill_resource"]) {
  const input = {
    name: "portable-example", description: "Example", content: "正文", path: "references/note.md", action: "set",
    newPath: "references/renamed.md", type: "markdown", title: "Note", oldText: "a", newText: "b",
    appendText: "c", prependText: "d", extra: "retained only by whole-skill updates", timeout: 30, timeoutMs: 30000,
  };
  const calls = [];
  const toolName = `qingzhou_skill_author__${localName}`;
  await runtime.executeSkillTool(toolName, input, null, loadedSkillWorkbenchContext, async (name, args) => {
    calls.push({ name, args });
    return { ok: true };
  });
  const script = builtin.resources.find(resource => resource.path === `scripts/${localName.replaceAll("_", "-")}.js`);
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction("args", "tools", script.content)(
    { ...input, $plugin: { id: "qingzhou-skill-author" } },
    { async manage_skill(args) { calls.push({ name: "manage_skill", args }); return { ok: true }; } },
  );
  assert.deepEqual(calls[1], calls[0], `${localName} portable and host arguments must agree`);
  assert.equal(Object.hasOwn(calls[0].args, "timeout"), false);
  assert.equal(Object.hasOwn(calls[0].args, "$plugin"), false);
  if (localName === "edit_skill_resource") {
    assert.equal(Object.hasOwn(calls[0].args.resourceEdits[0], "extra"), false);
    assert.equal(Object.hasOwn(calls[0].args.resourceEdits[0], "name"), false);
  }
}
const updateSkillSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__update_skill");
const createSkillSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__create_skill");
const editResourceSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__edit_skill_resource");
const listSkillsSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__list_skills");
const importPageZipSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__import_page_zip");
const importGitRepositorySchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__import_git_repository");
const installSkillToGitSchema = schemas.find(schema => schema.function?.name === "qingzhou_skill_author__install_skill_to_git");
assert.match(createSkillSchema.function.parameters.properties.name.description, /英文小写 id/);
assert.match(createSkillSchema.function.parameters.properties.displayName.description, /中文显示名/);
assert.equal(Object.prototype.hasOwnProperty.call(createSkillSchema.function.parameters.properties, "resources"), false);
assert.equal(createSkillSchema.function.parameters.properties.timeout.type, "number");
assert.match(createSkillSchema.function.parameters.properties.timeout.description, /单位秒/);
assert.ok(createSkillSchema.function.parameters.required.includes("timeout"));
assert.ok(updateSkillSchema.function.parameters.required.includes("timeout"));
assert.ok(listSkillsSchema.function.parameters.required.includes("timeout"));
assert.deepEqual(importPageZipSchema.function.parameters.required, ["timeout", "url"]);
assert.match(importPageZipSchema.function.description, /不探测或猜测 URL/);
assert.equal(Object.hasOwn(importPageZipSchema.function.parameters.properties, "tabId"), false);
assert.deepEqual(importGitRepositorySchema.function.parameters.required, ["timeout", "repositoryUrl"]);
assert.deepEqual(installSkillToGitSchema.function.parameters.required, ["timeout", "name", "repositoryUrl"]);
{
  const saveResourcePropertyOrder = Object.keys(editResourceSchema.function.parameters.properties);
  assert.ok(
    saveResourcePropertyOrder.indexOf("path") >= 0
      && saveResourcePropertyOrder.indexOf("content") >= 0
      && saveResourcePropertyOrder.indexOf("path") < saveResourcePropertyOrder.indexOf("content"),
    "edit_skill_resource should ask models for the filename before long script content",
  );
  assert.match(editResourceSchema.function.parameters.properties.path.description, /必须先填写/);
  assert.match(editResourceSchema.function.parameters.properties.oldText.description, /原样复制/);
  assert.match(editResourceSchema.function.parameters.properties.content.description, /一次调用只改一个资源/);
  assert.equal(Object.prototype.hasOwnProperty.call(editResourceSchema.function.parameters.properties, "edits"), false);
  assert.deepEqual(editResourceSchema.function.parameters.required, ["timeout", "name", "path", "action"]);
  assert.deepEqual(editResourceSchema.function.parameters.properties.action.enum, ["set", "replace", "append", "prepend", "rename", "delete"]);
}
assert.deepEqual(listSkillsSchema.function.parameters.properties.scope.enum, ["all", "global", "site", "resident"]);
assert.match(updateSkillSchema.function.parameters.properties.displayName.description, /中文显示名/);
assert.match(updateSkillSchema.function.parameters.properties.oldText.description, /只改正文/);
assert.equal(Object.prototype.hasOwnProperty.call(updateSkillSchema.function.parameters.properties, "resourceEdits"), false);
assert.equal(Object.prototype.hasOwnProperty.call(updateSkillSchema.function.parameters.properties, "contentEdits"), false);

const availableRenderers = await executeSkillWorkbenchTool("qingzhou_skill_author__load_available_renderers", { timeout: 30 });
assert.equal(availableRenderers.ok, true);
assert.equal(availableRenderers._plugin.runtime, "host");
assert.equal(availableRenderers.renderers.some(renderer => renderer.type === "table"), true);
assert.equal(availableRenderers.renderers.some(renderer => renderer.type === "summary"), true);

const pageZipImports = [];
const boundGitSources = [];
const publishedGitSkills = [];
const distributionToolRuntime = tools.createToolRuntime({
  sessions: {
    async resolveTargetTab({ tabId }) {
      return { ok: true, tabId, ownedByCurrentTask: true };
    },
  },
  skills: {
    async importPageZip(input) {
      pageZipImports.push(input);
      return { ok: true, action: "imported", count: 1, names: ["page-imported"] };
    },
    async bindGitSource(input) {
      boundGitSources.push(input);
      return { ok: true, action: "bound", count: 1 };
    },
    async inspectGitPublishTarget(input) {
      assert.deepEqual(input, { tabId: 74, waitForReady: true });
      return { available: true, tabId: 74, repositoryUrl: "https://gitlab.example.com/example/skills", ref: "main", subpath: "skills", projectId: "42" };
    },
    async publishToGit(input) {
      publishedGitSkills.push(input);
      return { ok: true, action: "published", skillName: input.skill.name, shortId: "abc123" };
    },
  },
});
const importedPageZip = await distributionToolRuntime.execute(
  "qingzhou_skill_author__import_page_zip",
  { timeout: 30, url: "https://skills.example/private.zip" },
  null,
  {
    sessionId: "session-skill-import",
    workingTabId: 73,
    loadedPluginSkillNames: loadedSkillWorkbenchContext.loadedPluginSkillNames,
  },
);
assert.equal(importedPageZip.ok, true);
assert.deepEqual(pageZipImports, [{
  url: "https://skills.example/private.zip",
  tabId: 73,
  overwrite: false,
}]);
const internalHostContext = {
  source: "plugin_host",
  pluginId: "qingzhou-skill-author",
  sessionId: "session-skill-import",
};
const boundGitSource = await distributionToolRuntime.execute(
  "import_git_skill_repository",
  { repositoryUrl: "https://github.com/example/skills", tabId: 74, overwrite: false },
  null,
  internalHostContext,
);
assert.equal(boundGitSource.action, "bound");
assert.deepEqual(boundGitSources, [{ repositoryUrl: "https://github.com/example/skills", tabId: 74, overwrite: false }]);
const publishedGitSkill = await distributionToolRuntime.execute(
  "install_skill_to_git",
  { name: "用户技能", tabId: 74, commitMessage: "feat: publish user skill" },
  null,
  internalHostContext,
);
assert.equal(publishedGitSkill.shortId, "abc123");
assert.equal(publishedGitSkills[0].skill.name, toAgentSkillName("用户技能"));
assert.equal(publishedGitSkills[0].commitMessage, "feat: publish user skill");

const gitImportCalls = [];
const importedGitRepository = await runtime.executeSkillTool(
  "qingzhou_skill_author__import_git_repository",
  { timeout: 120, repositoryUrl: "https://github.com/example/skills/tree/main/packages", overwrite: false },
  null,
  loadedSkillWorkbenchContext,
  async (name, args) => {
    gitImportCalls.push({ name, args });
    if (name === "open_tab") return { id: 81 };
    if (name === "import_git_skill_repository") return { ok: true, action: "bound", count: 2 };
    assert.fail(`unexpected Git import tool ${name}`);
  },
);
assert.equal(importedGitRepository.action, "bound");
assert.deepEqual(gitImportCalls, [
  { name: "open_tab", args: { url: "https://github.com/example/skills/tree/main/packages" } },
  {
    name: "import_git_skill_repository",
    args: {
      repositoryUrl: "https://github.com/example/skills/tree/main/packages",
      tabId: 81,
      overwrite: false,
    },
  },
]);

const gitInstallCalls = [];
const installedToGit = await runtime.executeSkillTool(
  "qingzhou_skill_author__install_skill_to_git",
  {
    timeout: 120,
    name: "用户技能",
    repositoryUrl: "https://gitlab.example.com/example/skills/tree/main/packages",
    commitMessage: "feat: install user skill",
  },
  null,
  loadedSkillWorkbenchContext,
  async (name, args) => {
    gitInstallCalls.push({ name, args });
    if (name === "open_tab") return { id: 82 };
    if (name === "use_tab") return { id: 82 };
    if (name === "install_skill_to_git") return { ok: true, skillName: "user-skill", shortId: "abc123" };
    assert.fail(`unexpected Git install tool ${name}`);
  },
);
assert.equal(installedToGit.shortId, "abc123");
assert.deepEqual(gitInstallCalls, [
  { name: "open_tab", args: { url: "https://gitlab.example.com/example/skills/tree/main/packages" } },
  { name: "use_tab", args: { tabId: 82 } },
  {
    name: "install_skill_to_git",
    args: { name: "用户技能", tabId: 82, commitMessage: "feat: install user skill" },
  },
]);

const allSkillNames = await executeSkillWorkbenchTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "all" });
assert.equal(allSkillNames.action, "list_skills");
assert.equal(allSkillNames.scope, "all");
assert.equal(Array.isArray(allSkillNames.names), true);
assert.equal(allSkillNames.names.includes(BUILTIN_SKILL_WORKBENCH_NAME), true);
assert.equal(allSkillNames.names.includes(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME), true);
assert.equal(allSkillNames.names.includes(toAgentSkillName("用户技能")), true);
assert.equal(allSkillNames.items.every(item => typeof item.name === "string"), true);
assert.equal(allSkillNames._plugin.runtime, "host");

const residentSkillNames = await executeSkillWorkbenchTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "resident" });
assert.deepEqual(residentSkillNames.names, [toAgentSkillName("用户系统提示")]);
const globalSkillNames = await executeSkillWorkbenchTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "global" });
assert.equal(globalSkillNames.names.includes(BUILTIN_SKILL_WORKBENCH_NAME), true);
assert.equal(globalSkillNames.names.includes(BUILTIN_SITE_SKILL_AUTHOR_SKILL_NAME), true);
assert.equal(globalSkillNames.names.includes(toAgentSkillName("用户系统提示")), false);
await assert.rejects(
  () => executeSkillWorkbenchTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "redident" }),
  err => err?.code === "INVALID_ARGUMENTS" && /all, global, site, or resident/.test(err.details?.originalMessage || err.message),
);

const loadedUserViaTool = await tools.executeTool("load_skill", { name: "用户技能", includeResources: true }, null, {});
assert.equal(loadedUserViaTool.content, "用户技能正文");
assert.deepEqual(loadedUserViaTool.resources, []);

await assert.rejects(
  () => runtime.executeSkillTool(
    "qingzhou_skill_author__create_skill",
    {
      timeout: 30,
      name: "缺少注册表事务",
      description: "没有内核提交入口时不应落盘",
      content: "## 步骤\n- 不应写入。",
    },
    null,
    loadedSkillWorkbenchContext,
    (name, args, signal, context) => tools.executeTool(name, args, signal, context),
  ),
  err => err?.code === "SKILL_REGISTRY_RUNTIME_UNAVAILABLE",
);
assert.equal(findStoredSkill("缺少注册表事务"), null, "a missing registry commit runtime must fail before storage mutation");

let hostToolCall = null;
const createdByHost = await runtime.executeSkillTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "Host 插件技能",
    description: "通过 meta-skill host 插件创建",
    content: "## 步骤\n- 通过技能工作台创建。",
  },
  null,
  loadedSkillWorkbenchContext,
  async (name, args, signal, context) => {
    hostToolCall = { name, args, signal, context };
    return skillMutationToolRuntime.execute(name, args, signal, context);
  },
);
assert.equal(hostToolCall.name, "manage_skill");
assert.equal(hostToolCall.context.source, "plugin_host");
assert.equal(createdByHost.saved, true);
assert.equal(createdByHost.name, toAgentSkillName("Host 插件技能"));
assert.equal(createdByHost.displayName, "Host 插件技能");
assert.equal(createdByHost._plugin.runtime, "host");
const duplicateCreateByHost = await runtime.executeSkillTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "Host 插件技能",
    description: "重复创建不应覆盖",
    content: "duplicate",
  },
  null,
  loadedSkillWorkbenchContext,
  async (name, args, signal, context) => skillMutationToolRuntime.execute(name, args, signal, context),
);
assert.equal(duplicateCreateByHost.code, "SKILL_ALREADY_EXISTS");
assert.equal(storedSkill("Host 插件技能").content, "## 步骤\n- 通过技能工作台创建。");
const createdByHostResource = await runtime.executeSkillTool(
  "qingzhou_skill_author__edit_skill_resource",
  { timeout: 30, name: "Host 插件技能", path: "references/readme.md", action: "set", type: "markdown", content: "hello" },
  null,
  loadedSkillWorkbenchContext,
  async (name, args, signal, context) => skillMutationToolRuntime.execute(name, args, signal, context),
);
assert.equal(createdByHostResource.updated, true);
assert.equal(storedSkill("Host 插件技能").resources[0].path, "references/readme.md");
assert.equal(storedSkill("Host 插件技能").format, QINGZHOU_SKILL_FORMAT);

const commitCountBeforeCreate = skillRegistryCommitCount;
const createdViaToolDispatcher = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "Dispatcher 插件技能",
    description: "通过 LLM 工具入口创建",
    content: "## 步骤\n- 通过工具调度器进入插件 host runtime。",
  },
  null,
  {},
);
assert.equal(createdViaToolDispatcher.saved, true);
assert.equal(createdViaToolDispatcher.name, toAgentSkillName("Dispatcher 插件技能"));
assert.equal(createdViaToolDispatcher.displayName, "Dispatcher 插件技能");
assert.equal(createdViaToolDispatcher._plugin.runtime, "host");
assert.equal(
  skillRegistryCommitCount,
  commitCountBeforeCreate + 1,
  "one authoring mutation should refresh the registry exactly once",
);
assert.deepEqual(tools.consumeToolEffects(JSON.parse(JSON.stringify(createdViaToolDispatcher)), {}), [], "cloning a host result must not copy execution authority");
assert.deepEqual(tools.consumeToolEffects(createdViaToolDispatcher, {}), [{ type: "skills.changed" }], "trusted host adapters must retain the committed core mutation effect");
assert.deepEqual(tools.consumeToolEffects(createdViaToolDispatcher, {}), [], "wrapped core effects are one-shot");
const dispatcherResource = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__edit_skill_resource",
  {
    timeout: 30,
    name: "Dispatcher 插件技能",
    path: "plugin.json",
    action: "set",
    type: "json",
    content: {
      format: SKILL_MANIFEST_FORMAT,
      schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
      id: "dispatcher-sample",
    },
  },
  null,
  {},
);
assert.equal(dispatcherResource.updated, true);
assert.equal(storedSkill("Dispatcher 插件技能").resources[0].path, "plugin.json");
assert.equal(storedSkill("Dispatcher 插件技能").resources[0].content, JSON.stringify({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "dispatcher-sample",
}, null, 2));
assert.equal(storedSkill("Dispatcher 插件技能").format, QINGZHOU_SKILL_FORMAT);

const createdWithExplicitDisplayName = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "browser-video-search",
    displayName: "浏览器视频搜索",
    description: "用标准 name 和中文 displayName 创建技能。",
    content: "## 步骤\n- 使用英文标准名，中文名保存在 displayName。",
  },
  null,
  {},
);
assert.equal(createdWithExplicitDisplayName.saved, true);
assert.equal(createdWithExplicitDisplayName.name, "browser-video-search");
assert.equal(createdWithExplicitDisplayName.displayName, "浏览器视频搜索");
assert.equal(storedSkill("browser-video-search").metadata.displayName, "浏览器视频搜索");
assert.equal(storedSkill("browser-video-search").metadata.qingzhou?.displayName, undefined);

const createdFromNonCanonicalName = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "当前会话原始名称",
    displayName: "另一个展示名称",
    description: "验证创建后仍可用创建请求中的名称立即加载。",
    content: "## 步骤\n- 在当前会话中创建后立即加载。",
  },
  null,
  {},
);
assert.equal(createdFromNonCanonicalName.name, toAgentSkillName("当前会话原始名称"));
const loadedFromCreateRequestName = await tools.executeTool(
  "load_skill",
  { name: "当前会话原始名称" },
  null,
  {},
);
assert.equal(loadedFromCreateRequestName.name, createdFromNonCanonicalName.name);

const displayNameOnlyUpdate = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__update_skill",
  {
    timeout: 30,
    name: "browser-video-search",
    displayName: "视频搜索助手",
  },
  null,
  {},
);
assert.equal(displayNameOnlyUpdate.updated, true);
assert.equal(displayNameOnlyUpdate.name, "browser-video-search");
assert.equal(displayNameOnlyUpdate.displayName, "视频搜索助手");
assert.equal(displayNameOnlyUpdate.changes.some(change => change.field === "displayName"), true);
assert.equal(storedSkill("browser-video-search").metadata.displayName, "视频搜索助手");
assert.equal(storedSkill("browser-video-search").metadata.qingzhou?.displayName, undefined);

replacePluginRegistryFromSkills([], { reason: "test_cold_registry" });
await assert.rejects(
  () => executeSkillWorkbenchTool(
    "qingzhou_skill_author__create_skill",
    {
      timeout: 30,
      name: "冷启动插件技能",
      description: "验证执行入口不会自行刷新插件注册表。",
      content: "## 步骤\n- 工具执行只读取 composition root 已提交的快照。",
    },
    null,
    {},
  ),
  error => error?.code === "UNKNOWN_TOOL",
  "tool execution must not bypass the registry lifecycle when the committed snapshot is empty",
);
await reloadPluginRegistry({ reason: "test_cold_registry_recovery" });
const createdAfterRegistryReady = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__create_skill",
  {
    timeout: 30,
    name: "冷启动插件技能",
    description: "验证 composition root 提交后工具恢复可用。",
    content: "## 步骤\n- 使用统一注册表生命周期提交。",
  },
  null,
  {},
);
assert.equal(createdAfterRegistryReady.saved, true);
assert.equal(createdAfterRegistryReady.name, toAgentSkillName("冷启动插件技能"));
assert.equal(createdAfterRegistryReady.displayName, "冷启动插件技能");
const lazyRegistryResource = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__edit_skill_resource",
  {
    timeout: 30,
    name: "冷启动插件技能",
    path: "plugin.json",
    action: "set",
    type: "json",
    content: {
      format: SKILL_MANIFEST_FORMAT,
      schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
      id: "lazy-registry-sample",
    },
  },
  null,
  {},
);
assert.equal(lazyRegistryResource.updated, true);
assert.equal(storedSkill("冷启动插件技能").resources[0].content, JSON.stringify({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "lazy-registry-sample",
}, null, 2));

await reloadPluginRegistry({ reason: "test_bilibili_payload" });
const bilibiliPayload = {
  name: "B站视频搜索",
  description: "在B站搜索关键词并提取视频列表（标题、UP主、播放量、链接、封面等）。",
  content: [
    "# B站视频搜索",
    "",
    "在B站（bilibili.com）根据关键词搜索视频，并结构化提取搜索结果中的视频列表信息。",
    "",
    "## 执行流程",
    "",
    "1. 确认当前页面是 B 站搜索页。如不是，使用 navigate 打开目标搜索 URL。",
    "2. 等待 `.video-list .bili-video-card` 渲染完成。",
    "3. 调用 `search_bilibili_videos` 工具提取视频列表。",
  ].join("\n"),
  scope: "site",
  domains: ["bilibili.com", "search.bilibili.com", "www.bilibili.com"],
  urlPatterns: ["*://search.bilibili.com/all*"],
};
const bilibiliManifestContent = JSON.stringify({
  format: SKILL_MANIFEST_FORMAT,
  schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: "bilibili-video-search",
  displayName: "B站视频搜索",
  version: "0.1.0",
  description: "在B站搜索关键词并提取视频列表信息",
  category: { id: "research", label: "研究" },
  tools: [{
    name: "search_bilibili_videos",
    title: "搜索B站视频列表",
    description: "在B站当前搜索页提取视频列表，包括标题、UP主、播放量、时长、链接、封面等",
    script: "scripts/search-bilibili-videos.js",
    needsPage: true,
    parameters: {
      type: "object",
      properties: {
        tabRef: { type: ["integer", "string"], description: "目标标签页别名或正整数 ID" },
        limit: { type: "integer", description: "最多返回多少条视频，默认 20，最大 200" },
      },
    },
  }],
  renderers: {
    tools: {
      search_bilibili_videos: {
        type: "table",
        columns: [
          { label: "标题", path: "title" },
          { label: "UP主", path: "author" },
          { label: "播放量", path: "playCount" },
        ],
      },
    },
  },
}, null, 2);
const bilibiliScriptContent = [
  "async () => {",
  "  const limit = Math.min(Number(args.limit || 20), 200);",
  "  const cards = document.querySelectorAll('.video-list .bili-video-card');",
  "  return { totalOnPage: cards.length, returned: Math.min(cards.length, limit), videos: [] };",
  "}",
].join("\n");
const bilibiliCreated = await executeSkillWorkbenchTool("qingzhou_skill_author__create_skill", { timeout: 30, ...bilibiliPayload });
assert.equal(bilibiliCreated.saved, true);
assert.equal(bilibiliCreated.name, toAgentSkillName("B站视频搜索"));
assert.equal(bilibiliCreated.displayName, "B站视频搜索");
assert.equal(storedSkill("B站视频搜索").scope, "site");
await executeSkillWorkbenchTool("qingzhou_skill_author__edit_skill_resource", {
  timeout: 30,
  name: "B站视频搜索",
  path: "plugin.json",
  action: "set",
  type: "json",
  title: "B站视频搜索插件声明",
  content: bilibiliManifestContent,
}, null, {});
await executeSkillWorkbenchTool("qingzhou_skill_author__edit_skill_resource", {
  timeout: 30,
  name: "B站视频搜索",
  path: "scripts/search-bilibili-videos.js",
  action: "set",
  type: "script",
  title: "搜索B站视频列表脚本",
  content: bilibiliScriptContent,
}, null, {});
assert.equal(storedSkill("B站视频搜索").resources.length, 2);
assert.equal(storedSkill("B站视频搜索").resources[0].content.includes('"slashCommands"'), false);
const siteSkillNames = await executeSkillWorkbenchTool("qingzhou_skill_author__list_skills", { timeout: 30, scope: "site" });
assert.equal(siteSkillNames.scope, "site");
assert.equal(siteSkillNames.names.includes(toAgentSkillName("B站视频搜索")), true);
const bilibiliSetUpdate = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__edit_skill_resource",
  {
    timeout: 30,
    name: "B站视频搜索",
    path: "scripts/search-bilibili-videos.js",
    action: "set",
    type: "script",
    content: [
      "async () => {",
      "  const limit = Math.min(Number(args.limit || 20), 200);",
      "  return { totalOnPage: 0, returned: 0, videos: [] };",
      "}",
    ].join("\n"),
  },
  null,
  {},
);
assert.equal(bilibiliSetUpdate.updated, true);
assert.match(
  storedSkill("B站视频搜索").resources.find(resource => resource.path === "scripts/search-bilibili-videos.js").content,
  /totalOnPage: 0/,
);
const bilibiliReplaceUpdate = await executeSkillWorkbenchTool(
  "qingzhou_skill_author__edit_skill_resource",
  {
    timeout: 30,
    name: "B站视频搜索",
    path: "scripts/search-bilibili-videos.js",
    action: "replace",
    oldText: "return { totalOnPage: 0, returned: 0, videos: [] };",
    newText: "return { totalOnPage: 1, returned: 1, videos: [{ title: 'sample' }] };",
  },
  null,
  {},
);
assert.equal(bilibiliReplaceUpdate.updated, true);
assert.match(
  storedSkill("B站视频搜索").resources.find(resource => resource.path === "scripts/search-bilibili-videos.js").content,
  /sample/,
);
await reloadPluginRegistry({ reason: "test_bilibili_registered" });
const bilibiliSchemas = tools.getToolSchemas({
  dynamicContext: {
    workingTab: { url: "https://search.bilibili.com/all?keyword=AI%20Agent" },
  },
});
assert.equal(bilibiliSchemas.some(schema => schema.function?.name === "bilibili_video_search__search_bilibili_videos"), true);

await skills.saveSkill("坏 Host 插件", "用于验证 host 插件错误传播", "content", {
  resources: [
    {
      path: "plugin.json",
      type: "json",
      content: {
        format: SKILL_MANIFEST_FORMAT,
        schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
        id: "broken-host",
        tools: [{ name: "bad", script: "scripts/bad.js", runtime: "host" }],
      },
    },
    {
      path: "scripts/bad.js",
      type: "script",
      content: "throw new Error('boom from host plugin');",
    },
  ],
});
await reloadPluginRegistry();
await assert.rejects(
  () => tools.executeTool("broken_host__bad", {}, null, {}),
  err => err?.code === "UNKNOWN_TOOL",
);
await assert.rejects(
  () => tools.executeTool(
    "broken_host__bad",
    { timeout: 30 },
    null,
    { loadedPluginSkillNames: [toAgentSkillName("坏 Host 插件")] },
  ),
  err => err?.code === "PLUGIN_HOST_ACTION_UNAVAILABLE"
    && /Skill 后台动作未注册/.test(err.message)
    && err.details?.skillName === toAgentSkillName("坏 Host 插件")
    && err.details?.localName === "bad",
);

console.log("builtin plugin creator skill tests passed");

// A fresh realm mirrors Chrome startup: modules and registrations share one UI language.
import { discoverCapabilities } from '../../../scripts/capability-catalog.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const nativeMessages = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};

globalThis.chrome = {
  i18n: {
    getUILanguage: () => process.argv[2] || 'en-US',
    getMessage: key => nativeMessages[key]?.message.replaceAll('$$', '$') || '',
  },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  runtime: { getURL: path => `chrome-extension://test/${path}`, lastError: null },
};
// stdout is the JSON protocol; browser-only dependencies may emit Node compatibility diagnostics.
console.log = console.error.bind(console);
const tools = await import('../../../src/background/tools/runtime.js');
const { listBuiltinSkills, findBuiltinSkill } = await import('../../../src/shared/skills/builtin-skills.js');
const { prepareSkillToolRegistryFromSkills } = await import('../../../src/background/skills/skill-tool-runtime.js');
const { normalizeModernSkill } = await import('../../../src/shared/skills/skill-utils.js');
const skills = listBuiltinSkills();
// Foreign descriptions deliberately stay Chinese even in an English runtime.
const foreign = normalizeModernSkill({ name: 'foreign-guide', description: '用户的说明', content: '# 用户的内容',
  scope: 'global', resources: [{ path: 'plugin.json', type: 'json', content: JSON.stringify({
    format: 'qingzhou.plugin', schemaVersion: 1, id: 'foreign-guide', tools: [{ name: 'echo',
      title: '用户工具', description: '用户定义的工具说明', script: 'scripts/echo.js',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '用户的参数说明' } }, required: ['text'] },
    }],
  }) }, { path: 'scripts/echo.js', type: 'script', content: 'async () => args.text' }],
});
const options = { loadedPluginSkillNames: [...skills.map(skill => skill.name), foreign.name],
  skillToolRegistrySnapshot: prepareSkillToolRegistryFromSkills([...skills, foreign]) };
const names = [];
for (const file of discoverCapabilities(fileURLToPath(new URL('../../../src/', import.meta.url))).tools) {
  const { default: register } = await import(pathToFileURL(file));
  register({ skills: {}, models: {}, registerTool: definition => names.push(definition.name) });
}
const registered = names.map(name => {
  const tool = tools.resolveToolDefinition(name);
  return { name, title: tool.title, description: tool.description, parameters: tool.parameters,
    noImages: tool.model?.noImages, imagePrompt: tool.model?.imagePrompt };
});
const aliases = ['技能工作台', 'Skill workbench', '文档处理', 'Document processing', '轻舟管理', 'Qingzhou settings', 'qz settings', 'MCP 接入', 'MCP integration', '站点技能生成器', 'Site Skill Builder'];
process.stdout.write(JSON.stringify({
  registered,
  schemas: tools.getToolSchemas(options),
  textOnlySchemas: tools.getToolSchemas({ ...options, runProfile: { features: { imageInput: false, screenshots: false }, tools: { disabled: [] } } }),
  restrictedSchemas: tools.getToolSchemas({ ...options, runProfile: { session: { canManageSessions: false }, tools: { disabled: [] } } }),
  skills: skills.map(({ name, displayName, description, content, resources }) => ({ name, displayName, description, content, resources })),
  aliases: Object.fromEntries(aliases.map(name => [name, findBuiltinSkill(name)?.name || null])),
}));

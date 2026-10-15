import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

export const promptT = createTranslator(defineMessages("skill-prompts", {
  residents: {
    "zh-CN": "\n## Resident Skills（完整注入）\n以下是用户和系统设定的常驻说明。它们代表长期偏好、用户自定义 sys prompt、领域规范或交付标准；执行所有任务时主动遵守。若与 Kernel Prompt 或安全护栏冲突，以 Kernel Prompt 和安全护栏为准。\n\n{skills}\n",
    en: "\n## Resident Skills (included in full)\nThese persistent instructions are set by the user and system. They express long-term preferences, user-defined system instructions, domain rules, or delivery standards. Follow them throughout every task. If they conflict with the Kernel Prompt or security guardrails, the Kernel Prompt and guardrails take precedence.\n\n{skills}\n",
  },
  globals: {
    "zh-CN": "以下是你积累的全局操作经验。当任务匹配某个 skill 时，先调用 load_skill 加载完整指令再执行。\n\n{skills}",
    en: "The following skills contain reusable workflows. When a task matches a skill, call load_skill for its full instructions before acting.\n\n{skills}",
  },
  noGlobals: { "zh-CN": "暂无全局 skills。", en: "No global skills are available." },
  sites: {
    "zh-CN": "\n\n另有 {count} 个站点级 skills，会按当前任务访问过的站点匹配后注入动态上下文；需要完整流程时调用 load_skill(name)。",
    en: "\n\nThere are also {count} site skills. They are added to dynamic context when they match sites visited by this task. Call load_skill(name) for the full workflow.",
  },
  available: { "zh-CN": "## 可用 Skills（经验库）", en: "## Available Skills (workflow library)" },
  description: { "zh-CN": "描述：{text}", en: "Description: {text}" },
  resources: { "zh-CN": "\n\n资源清单（仅作引用坐标；需要内容时调用 load_skill_resource）：\n{resources}", en: "\n\nResources (references only; call load_skill_resource to read their contents):\n{resources}" },
  empty: { "zh-CN": "（空）", en: "(empty)" },
  label: { "zh-CN": "{name}（{displayName}）", en: "{name} ({displayName})" },
  resourceTitle: { "zh-CN": "：{title}", en: ": {title}" },
}));

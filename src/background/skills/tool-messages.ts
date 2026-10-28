import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Host-authored instructions wrap Skill content without rewriting the installed package. */
const messages = defineMessages("skill-tools", {
  "toolTimeout": {
    "zh-CN": "本次 Skill 工具超时，单位秒；省略时使用默认超时。",
    "en": "Timeout in seconds for this Skill tool call. Uses the default timeout if omitted."
  },
  "scriptTimeout": {
    "zh-CN": "必填。Skill 脚本超时，单位秒；<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    "en": "Required. Skill script timeout in seconds: <= 0 means no time limit; > 0 sets the maximum duration."
  },
  "tabId": {
    "zh-CN": "本次调用的目标网页标签页 ID；省略时使用当前任务 workingTabId。",
    "en": "Target web tab ID for this call. Defaults to the current task's workingTabId."
  },
  "source": {
    "zh-CN": "来源扩展: {name}",
    "en": "Source Skill: {name}"
  },
  "category": {
    "zh-CN": "分类: {label}",
    "en": "Category: {label}"
  },
  "loadInstructions": {
    "zh-CN": "若任务需前置导航或多步流程，先调用 load_skill({name:{name}}) 读取完整 SOP。",
    "en": "If the task requires prior navigation or multiple steps, call load_skill({name:{name}}) for the full workflow first."
  },
  "mcpRuntime": {
    "zh-CN": "MCP: {server} / {tool}（通过远程 HTTP MCP 执行，不需要网页 tab）。",
    "en": "MCP: {server} / {tool} (runs via remote HTTP MCP; no web tab needed)."
  },
  "innerRuntime": {
    "zh-CN": "运行在内部 Worker（不需要网页 tab），可读 $plugin.config 并向 manifest 允许的来源调用 fetch。",
    "en": "Runs in the internal Worker (no web tab needed); can read $plugin.config and fetch origins allowed by the manifest."
  },
  "pageTarget": {
    "zh-CN": "页面目标: 使用显式传入的当前任务拥有 tabId，或当前任务 workingTabId。",
    "en": "Page target: uses an explicit tabId owned by the current task, or the current task's workingTabId."
  },
  "requiredTimeout": {
    "zh-CN": "必须传入 timeout（秒）：<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    "en": "Required timeout in seconds: <= 0 means no time limit; > 0 sets the maximum duration."
  },
  "optionalTimeout": {
    "zh-CN": "可选传入 timeout（秒）控制本次调用超时。",
    "en": "Optional timeout in seconds for this call."
  }
});

export const skillToolT = createTranslator(messages);

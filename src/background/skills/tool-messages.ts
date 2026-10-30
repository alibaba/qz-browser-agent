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
  "tabRef": {
    "zh-CN": "本次调用的目标网页：当前任务的标签页别名或正整数标签页 ID（也可用数字字符串）；省略时使用当前任务工作标签页。",
    "en": "Target web page: a current-task tab alias or positive integer tab ID (numeric strings also work). Defaults to the current task's working tab."
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
    "zh-CN": "页面目标: 用 tabRef 指定当前任务拥有的标签页别名或正整数 ID；省略时使用当前任务工作标签页。",
    "en": "Page target: pass tabRef as an alias or positive integer ID of a tab owned by the current task; omit it to use the current task's working tab."
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

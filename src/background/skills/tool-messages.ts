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
  "defaultScriptTimeout": {
    "zh-CN": "timeout 单位为秒，默认 120；0 不设单次时限，仍受父调用取消和期限约束。",
    "en": "timeout in seconds (default 120; 0 disables the per-call deadline while retaining parent cancellation and deadlines)."
  },
  "tabRef": {
    "zh-CN": "必填 tabRef：当前任务拥有的标签页别名，或 open_tab、list_tabs 返回的页面引用。",
    "en": "Required tabRef: a task-owned tab alias or the page reference returned by open_tab or list_tabs."
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
    "zh-CN": "脚本在页面外执行，可调用工具、读取 Skill 设置并访问其声明允许的网络来源；页面操作须显式传 tabRef，页面内 DOM 求值使用 tools.evaluate。",
    "en": "Runs outside web pages with access to tools, Skill settings, and declared network origins; pass tabRef explicitly to page tools and use tools.evaluate for in-page DOM execution."
  },
  "pageTarget": {
    "zh-CN": "页面目标：必须传 tabRef，指定当前任务拥有的标签页别名或 open_tab、list_tabs 返回的引用。",
    "en": "Page target: pass tabRef using a task-owned tab alias or the reference returned by open_tab or list_tabs."
  },
  "documentHostTimeout": {
    "zh-CN": "可选。文档工具超时秒数；省略时默认 120 秒。",
    "en": "Optional document-tool timeout in seconds. Defaults to 120 seconds."
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

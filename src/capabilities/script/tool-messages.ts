import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("script-tools", {
  pageContextRecovery: { "zh-CN": "先检查当前页面状态，必要时刷新或重新打开后重试；不要盲目重放结果尚不确定的操作。", en: "Inspect the current page first, then refresh or reopen it if needed before retrying. Do not blindly replay actions with uncertain outcomes." },
  scriptContextRecovery: { "zh-CN": "重新加载扩展并连接浏览器；重试任何操作前先检查页面当前状态。", en: "Reload the extension and reconnect. Inspect the current browser state before retrying any action." },
  toolAccessRecovery: { "zh-CN": "请在 run_script 中通过 qz SDK 操作浏览器；传给 page.evaluate 的页面函数须保持自包含。", en: "Use the qz SDK in run_script for browser operations; keep page.evaluate functions self-contained." },
  runScriptDescription: {"zh-CN": "在页面外执行 JavaScript 编排（支持顶层 await 和 return，页面导航或重载不会销毁外层脚本）。通过 args 读取入参；使用 qz SDK：qz.openTab({url,tabAlias}) 打开页面，qz.tab(tabRef) 绑定明确页面，page.locator(target或查询).click()/fill(value) 定位并操作元素，page.read() 读取正文，page.evaluate(code,args) 执行页面内自包含函数。定位器默认要求唯一匹配，动作前自动等待可操作；locator.wait({state:\"visible\"}) 等待状态，locator.wait({count:3}) 等待数量，locator.count() 读取当前数量。用 qz.listTools({names}) 查询扩展工具参数，qz.call(name,args) 调用已加载 Skill 等工具；await 成功返回业务值，失败抛错。有依赖的步骤用 await，可自行处理结果的独立页面流程用 Promise.all（同页操作自动串行，首错拒绝但不取消其他分支；需保留全部结果用 Promise.allSettled）。模型在脚本返回后看到结果。返回前须 await 所有工具调用，脚本退出会取消未完成调用，已完成动作不会回滚。仅 return 后续所需的精简业务值；模型收到 {ok,result,trace} 回执（undefined 映射为 null，失败时 result 为错误，trace 仅按序记录报错与脚本显式输出的 trace()/console；建议在关键阶段用 trace() 打点以便失败恢复）。timeout 单位为秒，默认 120；0 不设单次时限，仍受父调用取消和期限约束。", "en": "Run JavaScript orchestration outside web pages (supports top-level await and return; survives page navigation and reloads). Read inputs from args and use the qz SDK: qz.openTab({url,tabAlias}) opens a page; qz.tab(tabRef) binds an explicit page; page.locator(targetOrQuery).click()/fill(value) locates and acts; page.read() reads text; page.evaluate(code,args) runs a self-contained page function. Locators require a unique match by default and actions wait for usability; locator.wait({state:\"visible\"}) waits for state, locator.wait({count:3}) waits for count, and locator.count() reads the current count. Discover extension tool schemas with qz.listTools({names}) and invoke loaded Skill tools with qz.call(name,args). Awaited calls return business values directly and throw on failure. Use await for dependencies, Promise.all when independent page branches can process their own results (same-page actions serialize; first rejection does not cancel siblings), and Promise.allSettled to retain every outcome. The model sees results after the script returns. Await all tool calls before returning: script exit cancels unfinished calls without rolling back completed actions. Return only the compact business value needed; the model receives {ok,result,trace} (undefined becomes null, failed result is an error, and trace contains only errors and explicit trace()/console output in order—use trace() at key checkpoints to aid recovery). timeout is in seconds (default 120; 0 disables this call deadline while retaining parent cancellation and deadlines)."},
  evaluateDescription: {"zh-CN": "在 tabRef 指定的页面内执行自包含函数并返回其可 JSON 序列化的业务值。函数可访问 document/window 与页面登录态，但不能调用 qz SDK 或捕获外层变量；外部参数统一通过 args 传入并由函数形参接收。脚本中 code 可直接传函数，JSON 调用传函数源码字符串。仅返回所需的 JSON 值；从框架 state 中选取相关字段，DOM 节点和函数不能跨页面边界返回。点击、填表与导航请使用外层工具；默认等待当前文档 DOMContentLoaded 后执行（早期观察传 waitUntil:\"commit\"），动态内容请配合具体等待条件。页面卸载可能中断本次 evaluate，代码不会自动重放。", "en": "Evaluate a self-contained function inside the page identified by tabRef and return its JSON-serializable value. The function can access document/window and page login state, but cannot call the qz SDK or capture outer variables—pass external values through args as the function parameter. Scripts can pass a function as code; JSON callers pass its source string. Return compact JSON values, selecting the needed fields from framework state; DOM nodes and functions cannot cross the page boundary. Perform clicks, form inputs, and navigation through outer tools. Waits for DOMContentLoaded in the current document by default (use waitUntil:\"commit\" for early observation); wait for specific conditions when reading dynamic content. Unloading the page may interrupt this evaluation; code is never replayed automatically."},
  evaluateCode: {"zh-CN": "自包含的普通函数、箭头函数或 async 函数表达式（脚本中可直接传函数，JSON 调用传函数字符串）。", "en": "A self-contained ordinary, arrow, or async function expression (pass a function in scripts or its source string in JSON calls)."},
  evaluateWaitUntil: {"zh-CN": "执行前的文档就绪状态：domcontentloaded（默认，等待 HTML 解析与延迟脚本完成）或 commit（导航提交后即可执行，适合早期观察）；均不等待图片或网络空闲。", "en": "Document readiness before execution: domcontentloaded (default; waits for HTML parsing and deferred scripts) or commit (allows early observation after navigation commits). Neither waits for images or network idle."},
  evaluateArgs: {"zh-CN": "作为函数唯一参数传入的 JSON 值。", "en": "A JSON value passed as the function's single argument."},
  listToolsDescription: {"zh-CN": "查询当前会话可用工具。省略 names 返回所有可发现工具的紧凑签名；传入 names 返回指定工具定义的完整参数 schema。", "en": "Inspect tools available in this session. Omit names for compact signatures of all discoverable tools; pass names for the complete parameter schemas of specific tools."},
  runSkillScriptDescription: {
    "zh-CN": "内部工具：执行已加载 Skill 包内的脚本资源（模型不直接调用）。page 必须使用当前任务已拥有的网页 tab；inner 运行在轻舟内部 Worker，不需要网页 tab。",
    en: "Internal tool: execute a script resource from a loaded Skill package (not called directly by the model). page requires a web tab owned by the current task; inner runs in qz's internal Worker without a web tab.",
  },
  runSkillScriptTarget: {
    "zh-CN": "执行目标：省略或 page=当前任务网页；inner=内部 Worker。",
    en: "Execution target: omitted or page for the current task's web page; inner for the internal Worker.",
  },
  runSkillScriptTabId: {
    "zh-CN": "本次调用的目标标签页 tabRef：别名或 open_tab/list_tabs 返回的 id。",
    en: "Target tabRef for this call: an alias or the id returned by open_tab/list_tabs.",
  },
  runSkillScriptSkill: {
    "zh-CN": "Skill 名称。",
    en: "Skill name.",
  },
  runSkillScriptScript: {
    "zh-CN": "Skill 包内脚本相对路径，如 scripts/collect-feed.js。",
    en: "Relative script path in the Skill package, such as scripts/collect-feed.js.",
  },
  runSkillScriptArgs: {
    "zh-CN": "传给脚本的参数对象（脚本内通过 args 读取）。",
    en: "Arguments object passed to the script (read via args).",
  },
  runSkillScriptMutatesPage: {
    "zh-CN": "脚本是否会修改页面 DOM、表单或状态，默认 false。",
    en: "Whether the script modifies page DOM, forms, or state. Default: false.",
  },
  runScriptArgs: {"zh-CN": "作为 args 传入外层脚本的 JSON 值。", "en": "A JSON value exposed as args in the outer script."},
  runScriptCode: {"zh-CN": "页面外执行的 JavaScript 编排代码，支持顶层 await 和 return。", "en": "Outer JavaScript orchestration code with top-level await and return."},
  scriptTimeout: {
    "zh-CN": "脚本超时秒数，默认 120；0 表示不设单次时限，仍受任务取消和调用方期限约束。",
    en: "Script timeout in seconds (default 120). Zero removes the per-call limit while retaining task cancellation and caller deadlines.",
  },
});

export const toolT = createTranslator(messages);

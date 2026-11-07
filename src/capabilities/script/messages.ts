import { defineMessages } from "#sdk/shared/i18n-definition";

/** Package-owned interface text. Identifiers and user content remain untranslated. */
export default defineMessages("script", {
  "currentPage": { "zh-CN": "当前页面", en: "Current page" },
  "script": { "zh-CN": "脚本", en: "Script" },
  "executeInternalCode": { "zh-CN": "执行内部代码", en: "Run internal code" },
  "executeInternalScript": { "zh-CN": "执行内部脚本", en: "Run internal script" },
  "executeCode": { "zh-CN": "执行代码", en: "Run code" },
  "executePageScript": { "zh-CN": "执行页面脚本", en: "Run page script" },
  "executeScript": { "zh-CN": "执行脚本", en: "Run script" },
  "listTools": { "zh-CN": "列出工具", en: "List tools" },
  "scriptToolAccessUnavailable": { "zh-CN": "本次调用未启用工具访问，且没有自动重跑。", en: "This invocation has no tool access and was not automatically replayed." },
  "thePageJavascriptContextIsUnavailableRunScriptRuns": { "zh-CN": "页面 JavaScript 上下文不可用；run_script 只在真实页面上下文执行，脚本没有降级到 isolated world。", en: "The page JavaScript context is unavailable. run_script runs only in the real page context; it did not fall back to an isolated world." },
  "theScriptClickedSubmittedNavigatedOrClosedTheCurrent": { "zh-CN": "脚本里触发了当前 tab 的点击、提交、导航或关闭，页面可能卸载，run_script 会主动拦截。", en: "The script clicked, submitted, navigated, or closed the current tab and may unload the page. run_script blocks these actions." },
  "theScriptPageWaitOrNestedToolCallTimed": { "zh-CN": "脚本、页面等待或内部工具调用超时，检查无界等待、未完成请求或不存在的目标。", en: "The script, page wait, or nested tool call timed out. Check for unbounded waits, pending requests, or missing targets." },
  "theScriptHasAnUnsupportedShapeOrInvalidSyntax": { "zh-CN": "脚本形态或语法不稳定，常见于函数外 return、IIFE、top-level await/表达式包装边界。", en: "The script has an unsupported shape or invalid syntax. Check for return outside a function, IIFEs, or top-level await/expression boundaries." },
  "theExecutionEnvironmentDoesNotMatchTheScriptPage": { "zh-CN": "脚本运行环境不匹配：使用浏览器 JavaScript 和 document/window。", en: "The script does not match the execution environment. Use browser JavaScript and document/window." },
  "theTargetDomIsEmptyOrThePageHas": { "zh-CN": "目标 DOM 为空或页面还没渲染完成，请验证 target、虚拟列表、懒加载和时序。", en: "The target DOM is empty or the page has not finished rendering. Check target, virtual lists, lazy loading, and timing." },
  "aToolsCallInsideRunScriptFailedCheckBridge": { "zh-CN": "run_script 内部调用 tools.* 失败，可能是桥接超时、嵌套深度、工具参数或页面生命周期问题。", en: "A tools.* call inside run_script failed. Check bridge timeouts, nesting depth, arguments, and page lifecycle." },
  "theBrowserBlocksScriptInjectionOnThisPageThis": { "zh-CN": "浏览器限制当前页面注入脚本，常见于 chrome://、扩展商店、特殊内置页或权限不足页面。", en: "The browser blocks script injection on this page. This can happen on chrome:// pages, the extension store, built-in pages, or pages without the required permissions." },
  "scriptExecutionFailedUseTheErrorAndTraceTo": { "zh-CN": "脚本运行失败，需要根据 error 和 trace 定位最后成功阶段。", en: "Script execution failed. Use the error and trace to locate the last successful stage." },
  "useTargetPageWithAWorkingTabForPage": { "zh-CN": "脚本在 tabRef 指定的页面运行，使用浏览器 JavaScript、input/args 和 tools/tool。", en: "Run the script on the page specified by tabRef, using browser JavaScript, input/args, and tools/tool." },
  "inspectDiagnosticLasttraceAndTheErrorAddStageTrace": { "zh-CN": "先看 diagnostic.lastTrace 和 error，补充 stage/trace 后缩小脚本重试。", en: "Inspect diagnostic.lastTrace and the error, add stage/trace markers, then retry a smaller script." },
  "callOpenTabForTheTargetUrlFirstThen": { "zh-CN": "先调用 open_tab 打开目标 URL，再用返回的 tabRef 作为 run_script.tabRef。", en: "Call open_tab for the target URL first, then pass the returned tabRef as run_script.tabRef." },
  "ifTheTargetPageIsKnownPassTabidTo": { "zh-CN": "已经知道目标页时，在 run_script 参数里传 tabRef。", en: "If the target page is known, pass tabRef to run_script." },
  "useListTabsToInspectActiveIsworkingtabUsableThen": { "zh-CN": "用 list_tabs 查找目标网页，再显式传该页的 tabRef。", en: "Find the target page with list_tabs, then pass its tabRef explicitly." },
  "forDataStoreProcessingFileGenerationOrPureJs": { "zh-CN": "通过 tools/tool 调用 data_store、文件生成和其他工具，最终返回小摘要。", en: "Call data_store, file generation, and other tools through tools/tool, then return a compact summary." },
  "noReturnValue": { "zh-CN": "无返回值", en: "No return value" },
  "theScriptRanWithoutAReturnValueOrReturned": { "zh-CN": "脚本已执行，但没有 return / 返回 undefined。", en: "The script ran without a return value, or returned undefined." },
  "runCode": { "zh-CN": "运行代码", en: "Run code" },
}, { historicalLabels: [
  "executeScript", "executePageScript", "listTools",
] });

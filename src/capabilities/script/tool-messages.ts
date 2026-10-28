import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("script-tools", {
  runScriptDescription: {
    "zh-CN": "执行临时 JavaScript 代码，支持 top-level await。只接收内联 code；Skill 包内脚本请直接调用对应 Skill 工具。脚本可访问 input/args、tools/tool、trace/log；页面模式还可访问 tabId/document/window。tools 是当前运行配置下可用工具的动态代理（如 await tools.find_elements({...})、await tools.data_store({...})）；不要用 Object.keys(tools) 判断能力，诊断时使用 await tools.$list()。\n\n运行目标：\n- target 不填或 target:\"page\" 表示页面模式，使用显式的当前任务拥有 tabId，或当前任务 workingTabId（只读查看其他任务 tab 请直接用只读页面工具传 tabId，不要用 run_script）。\n- target:\"inner\" 表示轻舟内部 offscreen 运行环境，仅用于与页面无关的纯 JS、data_store 批处理、save_file/document_*、ask_llm 等编排，没有 document/window/DOM/tabId。\n\n编写规范：\n- 必填 timeout（秒）：<= 0 表示无限等待（适合长采集/批量落库），> 0 表示最多等待对应秒数。\n- 不能用 getEventListeners、$0、copy、monitorEvents 等 DevTools Console helper，也不能用 Node.js/fs/path/process/require/import/shell。\n- 默认把 code 写成单个 async () => { ... } 函数表达式（不要写 IIFE、main() 或函数外 return）；脚本开始处用一行注释简明说明：这个脚本在什么页面做什么事情，达到什么目的。\n- 复杂脚本维护 stage 并在关键节点调用 trace(...)；动态内容使用有限超时的 waitFor(fn,label,timeout)。失败后根据 diagnostic + trace 修正重试。\n- 视觉序列先由主 Agent 单步观察；仅当效果符合预期、后续坐标可预测且 viewportChange 表明浏览器视口稳定时，才串行 await tools.act_on_screen（中间步 returnScreenshot:false，每步检查 coordinateBasisReady；需要观察时调用 screenshot 或让末步传 returnScreenshot:true，按执行顺序返回最后一张此类图片）。调用 run_script 时设 mutatesPage:true。\n- 大批数据在脚本内分批 await tools.data_store(...) 落库，最终只返回小摘要：{ok, stage, count, inserted, updated, totalRows, table, sample, errors}（sample 最多 1–3 条）；run_script 会自动提升内部最后一次 screenshot 或 act_on_screen(returnScreenshot:true) 的图片。\n\n推荐骨架：\nasync () => {\n  // 在当前列表页采集条目文本，形成 rows 摘要用于验证页面解析并支持后续落库。\n  let stage = \"init\";\n  const wait = (ms) => new Promise(r => setTimeout(r, ms));\n  async function waitFor(fn, label, timeout = 8000) {\n    const start = Date.now();\n    while (Date.now() - start < timeout) {\n      const value = fn();\n      if (value) return value;\n      await wait(200);\n    }\n    throw new Error(\"timeout waiting \" + label);\n  }\n  try {\n    trace(\"start\", { target: \"page\", url: location.href, title: document.title });\n    stage = \"select\";\n    const items = [...document.querySelectorAll(\".item\")];\n    trace(\"items\", items.length);\n    stage = \"parse\";\n    const rows = items.map((el, i) => ({ i, text: el.textContent.trim() }));\n    return { ok: true, stage, count: rows.length, sample: rows.slice(0, 3) };\n  } catch (e) {\n    trace(\"fail\", { stage, message: e.message, stack: e.stack });\n    return { ok: false, stage, error: e.message };\n  }\n}",
    en: "Execute temporary JavaScript with top-level await support. Accepts inline code only; invoke scripts packaged in a Skill through that Skill's tool. Scripts can access input/args, tools/tool, and trace/log; page mode also provides tabId/document/window. tools is a dynamic proxy for tools enabled in the current run configuration (e.g. await tools.find_elements({...}), await tools.data_store({...})); do not use Object.keys(tools) to inspect capabilities—call await tools.$list() instead.\n\nExecution targets:\n- Omitting target or setting target:\"page\" runs in page mode on an explicit task-owned tabId or the current task's workingTabId (for read-only tabs owned by another task, pass tabId directly to a read-only page tool rather than run_script).\n- target:\"inner\" runs in qz's internal offscreen Worker without document/window/DOM/tabId; use it only for page-independent JS, data_store batch processing, save_file/document_*, and ask_llm orchestration.\n\nRequirements:\n- Required timeout in seconds: <= 0 means no time limit (for long collection/batch storage); > 0 sets the maximum duration.\n- DevTools Console helpers (getEventListeners, $0, copy, monitorEvents) and Node.js/fs/path/process/require/import/shell APIs are unavailable.\n- Write code as a single async () => { ... } function expression (no IIFE, main(), or return outside a function), starting with a one-line comment stating which page it runs on, what it does, and why.\n- Track stage and call trace(...) at key steps in complex scripts; use a bounded waitFor(fn,label,timeout) for dynamic DOM. On failure, inspect diagnostic + trace before retrying.\n- Observe visual sequences one step at a time first; only when effects match expectations, subsequent coordinates are predictable, and viewportChange confirms a stable browser viewport may a script call await tools.act_on_screen serially (pass returnScreenshot:false on intermediate steps, check coordinateBasisReady after each step, and call screenshot or set returnScreenshot:true on the final step; the last such image in execution order is returned). Set mutatesPage:true when modifying the page.\n- Write large datasets in batches inside the script via await tools.data_store(...), returning only a compact summary: {ok, stage, count, inserted, updated, totalRows, table, sample, errors} (1–3 sample items); run_script automatically promotes the image from its last screenshot or act_on_screen(returnScreenshot:true) call.\n\nSuggested structure:\nasync () => {\n  // Extract item text from the current list page to verify parsing and support later storage.\n  let stage = \"init\";\n  const wait = (ms) => new Promise(r => setTimeout(r, ms));\n  async function waitFor(fn, label, timeout = 8000) {\n    const start = Date.now();\n    while (Date.now() - start < timeout) {\n      const value = fn();\n      if (value) return value;\n      await wait(200);\n    }\n    throw new Error(\"timeout waiting \" + label);\n  }\n  try {\n    trace(\"start\", { target: \"page\", url: location.href, title: document.title });\n    stage = \"select\";\n    const items = [...document.querySelectorAll(\".item\")];\n    trace(\"items\", items.length);\n    stage = \"parse\";\n    const rows = items.map((el, i) => ({ i, text: el.textContent.trim() }));\n    return { ok: true, stage, count: rows.length, sample: rows.slice(0, 3) };\n  } catch (e) {\n    trace(\"fail\", { stage, message: e.message, stack: e.stack });\n    return { ok: false, stage, error: e.message };\n  }\n}",
  },
  runSkillScriptDescription: {
    "zh-CN": "内部工具：执行已加载 Skill 包内的脚本资源（模型不直接调用）。page 必须使用当前任务已拥有的网页 tab；inner 运行在轻舟内部 Worker，不需要网页 tab。",
    en: "Internal tool: execute a script resource from a loaded Skill package (not called directly by the model). page requires a web tab owned by the current task; inner runs in qz's internal Worker without a web tab.",
  },
  runSkillScriptTarget: {
    "zh-CN": "执行目标：省略或 page=当前任务网页；inner=内部 Worker。",
    en: "Execution target: omitted or page for the current task's web page; inner for the internal Worker.",
  },
  runSkillScriptTabId: {
    "zh-CN": "本次调用的目标标签页 ID；省略时使用当前任务 workingTabId。",
    en: "Target tab ID for this call. Defaults to the current task’s workingTabId.",
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
    "zh-CN": "传给脚本的参数对象（脚本内通过 input 或 args 读取）。",
    en: "Arguments object passed to the script (read via input or args).",
  },
  runSkillScriptMutatesPage: {
    "zh-CN": "脚本是否会修改页面 DOM、表单或状态，默认 false。",
    en: "Whether the script modifies page DOM, forms, or state. Default: false.",
  },
  runScriptTarget: {
    "zh-CN": "执行目标：省略或 page=当前任务网页上下文；inner=内部 offscreen Worker（仅用于与页面无关的纯 JS/data_store/save_file/document/ask_llm 批处理）。",
    en: "Execution target: omitted or page for the current task's web page context; inner for the internal offscreen Worker (only for page-independent JS/data_store/save_file/document/ask_llm batches).",
  },
  runScriptArgs: {
    "zh-CN": "传给代码的参数对象（脚本内通过 input 或 args 读取）。",
    en: "Arguments object passed to the code (read via input or args).",
  },
  runScriptCode: {
    "zh-CN": "内联 JavaScript 代码（推荐单个 async () => { ... } 函数表达式，可用 return 返回结果，用 trace/log 记录诊断轨迹）。该字段可能较长，先填 timeout/target/tabId/args/mutatesPage，最后填写 code。",
    en: "Inline JavaScript code (prefer a single async () => { ... } function expression; use return for results and trace/log for diagnostics). This field may be long: supply timeout/target/tabId/args/mutatesPage first and code last.",
  },
  scriptTimeout: {
    "zh-CN": "必填。脚本超时秒数；<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    en: "Required script timeout in seconds: <= 0 means no time limit; > 0 sets the maximum duration.",
  },
  scriptShapeRecovery: {
    "zh-CN": "改成单个 async () => { let stage='init'; try { ... return {ok:true, stage}; } catch(e) { trace('fail',{stage,message:e.message}); return {ok:false, stage, error:e.message}; } }。",
    en: "Use a single async () => { let stage='init'; try { ... return {ok:true, stage}; } catch(e) { trace('fail',{stage,message:e.message}); return {ok:false, stage, error:e.message}; } } function expression.",
  },
  workingTabRecovery: {
    "zh-CN": "页面脚本先打开或选定目标网页，让当前任务产生 workingTabId；与页面无关的数据处理请显式传 target:\"inner\"。",
    en: "For page scripts, first open or select a target page to establish the current task’s workingTabId. For page-independent data processing, explicitly pass target:\"inner\".",
  },
});

export const toolT = createTranslator(messages);

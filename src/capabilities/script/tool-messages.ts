import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("script-tools", {
  runScriptDescription: {
    "zh-CN": "执行临时 JavaScript 代码，支持 top-level await。只接收 code；skill/plugin 包内脚本必须通过对应 Skill 工具调用。脚本中可访问 input/args、tools/tool、trace/log；页面模式还可访问 tabId/document/window。tools 是当前运行配置下可用工具的动态代理，可直接调用 await tools.find_elements({...})、await tools.act_on_screen({...})、await tools.data_store({...}) 等；不要用 Object.keys(tools) 判断能力，诊断时使用 await tools.$list()。\n\n运行目标协议：\n- target 不填或 target:\"page\" 表示页面模式，使用显式的当前任务拥有 tabId，或当前任务 workingTabId。\n- target:\"inner\" 表示轻舟内部 offscreen 运行环境，只用于与页面无关的纯 JS、data_store 批处理、save_file/document_*、ask_llm 等内部工具编排；不会读取目标网页 DOM，也不会自动使用浏览器当前激活标签页。\n- open_tab 创建新的工作标签页；list_tabs 返回网页标签页状态；use_tab 设置工作标签页。\n- 页面模式不能操作其他任务拥有的 tab；只读查看其他任务 tab 时用只读页面工具显式传 tabId，不要用 run_script。\n\n可靠性协议：\n- 每次调用必须填写 timeout，单位秒；timeout <= 0 表示无限等待，timeout > 0 表示最多等待对应秒数。轻量读取可选几十秒；明确长采集、翻页遍历、批量落库任务可选 0，由用户停止。\n- 页面模式语义固定为网页 JavaScript 上下文；CDP/页面上下文不可用时返回 page_context_unavailable。inner 模式是 Worker 环境，没有 document/window/DOM。\n- 不能用 getEventListeners、$0、copy、monitorEvents 等 DevTools Console helper；页面模式用标准 document/window/Web APIs 和轻舟 tools；inner 模式用标准 JS/Web Worker APIs 和轻舟 tools。\n- 默认把 code 写成单个 async () => { ... } 函数表达式；run_script 会自动调用它。不要写 IIFE、main();、函数外 return。\n- 脚本开始处用一行注释简明说明：这个脚本在什么页面做什么事情，达到什么目的。\n- 复杂脚本必须维护 stage，并在 start、选择器命中数、分支、循环进度、catch 里 trace(...)；失败后根据 diagnostic + trace 修正脚本再重试。\n- run_script 页面模式适合读取页面、批量解析、批量落库、局部 DOM 调试、内部 ask_llm 子分析和已验证的页面批量交互。视觉序列先由主 Agent 单步观察；仅当效果符合预期、后续坐标可预测且 viewportChange 表明浏览器视口稳定时，才串行 await tools.act_on_screen，中间动作传 returnScreenshot:false，每步检查 coordinateBasisReady。需要观察时调用 screenshot，或让对应 act_on_screen 传 returnScreenshot:true；run_script 会按执行顺序返回最后一张此类图片。条件不再成立就立即返回。调用 run_script 时设 mutatesPage:true。\n- 动态页面/懒加载/虚拟列表要写有限 waitFor(fn,label,timeout)；不要直接链式读取可能为空的元素。\n- 图片或视觉素材采集先用 await tools.list_images(...) 获得候选，再把选中候选的 target 或 URL 交给 await tools.collect_images(...) 建本地图集；run_script 可用于滚动和整理候选元信息。需要保存页面区域/视口截图时调用 screenshot 并传 destination=图集表名。\n- 脚本内调用 tools.data_store / tools.collect_images / tools.save_file / tools.download_url / document_* 生成的表和文件会自动进入任务产物。\n- 脚本最终只返回小摘要：{ok, stage, count, inserted, updated, totalRows, table, sample, errors}；sample 最多 1-3 条，大批量数据在脚本内分批 await tools.data_store(...)。run_script 会自动提升内部最后一次 screenshot 或 act_on_screen(returnScreenshot:true) 的图片。\n\n推荐骨架：\nasync () => {\n  // 在当前列表页采集条目文本，形成 rows 摘要用于验证页面解析并支持后续落库。\n  let stage = \"init\";\n  const wait = (ms) => new Promise(r => setTimeout(r, ms));\n  async function waitFor(fn, label, timeout = 8000) {\n    const start = Date.now();\n    while (Date.now() - start < timeout) {\n      const value = fn();\n      if (value) return value;\n      await wait(200);\n    }\n    throw new Error(\"timeout waiting \" + label);\n  }\n  try {\n    trace(\"start\", { target: \"page\", url: location.href, title: document.title });\n    stage = \"select\";\n    const items = [...document.querySelectorAll(\".item\")];\n    trace(\"items\", items.length);\n    stage = \"parse\";\n    const rows = items.map((el, i) => ({ i, text: el.textContent.trim() }));\n    return { ok: true, stage, count: rows.length, sample: rows.slice(0, 3) };\n  } catch (e) {\n    trace(\"fail\", { stage, message: e.message, stack: e.stack });\n    return { ok: false, stage, error: e.message };\n  }\n}",
    en: "Execute temporary JavaScript with top-level await support. Accepts inline code only; scripts packaged in a Skill must be invoked through that Skill’s tool. Scripts can access input/args, tools/tool, and trace/log; page mode also provides tabId/document/window. tools is a dynamic proxy for tools available in the current run configuration. Call await tools.find_elements({...}), await tools.act_on_screen({...}), await tools.data_store({...}), and so on directly. Do not use Object.keys(tools) to discover capabilities; use await tools.$list() for diagnostics.\n\nExecution targets:\n- Omitting target or using target:\"page\" runs in page mode, using an explicit tabId owned by the current task or its workingTabId.\n- target:\"inner\" runs in qz’s internal offscreen environment. Use only for page-independent JavaScript, data_store batches, save_file/document_* operations, ask_llm, and other internal tool orchestration. It does not read the target page’s DOM or automatically use the browser’s active tab.\n- open_tab creates a new working tab; list_tabs reports web tab state; use_tab sets the working tab.\n- Page mode cannot interact with tabs owned by other tasks. For read-only access to another task’s tab, pass tabId explicitly to a read-only page tool, not run_script.\n\nReliability requirements:\n- Every call must include timeout in seconds. timeout <= 0 means no time limit; timeout > 0 sets the maximum duration. Use a few dozen seconds for lightweight reads. For explicitly long collection, pagination, or bulk-storage tasks, 0 allows the user to stop execution.\n- Page mode always runs in the web page’s JavaScript context. If CDP or the page context is unavailable, returns page_context_unavailable. inner mode runs in a Worker without document/window/DOM.\n- getEventListeners, $0, copy, monitorEvents, and other DevTools Console helpers are unavailable. In page mode use standard document/window/Web APIs and qz tools; in inner mode use standard JavaScript/Web Worker APIs and qz tools.\n- By default, write code as one async () => { ... } function expression; run_script invokes it automatically. Do not use an IIFE, main();, or a return outside a function.\n- Begin the script with a one-line comment explaining which page it works on, what it does, and why.\n- Complex scripts must track stage and call trace(...) at start, for selector match counts, at branches, during loop progress, and in catch. On failure, use diagnostic + trace to correct the script before retrying.\n- Page mode is suitable for reading pages, batch parsing and storage, local DOM debugging, internal ask_llm analysis, and verified batches of page interactions. The main agent must first observe visual sequences one step at a time. Only when effects match expectations, subsequent coordinates are predictable, and viewportChange confirms a stable browser viewport may a script call await tools.act_on_screen sequentially. Use returnScreenshot:false for intermediate actions and check coordinateBasisReady after every step. To observe, call screenshot or pass returnScreenshot:true to the relevant act_on_screen call; run_script returns the last such image in execution order. Return immediately when these conditions no longer hold. Set mutatesPage:true when calling run_script.\n- For dynamic pages, lazy loading, and virtual lists, use a bounded waitFor(fn,label,timeout). Do not chain property reads on elements that may be null.\n- To collect images or visual assets, first use await tools.list_images(...) to discover candidates, then pass selected targets or URLs to await tools.collect_images(...) to create a local collection. Use run_script for scrolling and organizing candidate metadata. To save a page region or viewport capture, call screenshot with destination set to the image collection table name.\n- Tables and files created through tools.data_store / tools.collect_images / tools.save_file / tools.download_url / document_* automatically become task artifacts.\n- Return only a small summary: {ok, stage, count, inserted, updated, totalRows, table, sample, errors}. Limit sample to 1–3 entries; write large datasets in batches within the script using await tools.data_store(...). run_script automatically surfaces the image from the last nested screenshot or act_on_screen(returnScreenshot:true) call.\n\nSuggested structure:\nasync () => {\n  // Extract item text from the current list page to verify parsing and support later storage.\n  let stage = \"init\";\n  const wait = (ms) => new Promise(r => setTimeout(r, ms));\n  async function waitFor(fn, label, timeout = 8000) {\n    const start = Date.now();\n    while (Date.now() - start < timeout) {\n      const value = fn();\n      if (value) return value;\n      await wait(200);\n    }\n    throw new Error(\"timeout waiting \" + label);\n  }\n  try {\n    trace(\"start\", { target: \"page\", url: location.href, title: document.title });\n    stage = \"select\";\n    const items = [...document.querySelectorAll(\".item\")];\n    trace(\"items\", items.length);\n    stage = \"parse\";\n    const rows = items.map((el, i) => ({ i, text: el.textContent.trim() }));\n    return { ok: true, stage, count: rows.length, sample: rows.slice(0, 3) };\n  } catch (e) {\n    trace(\"fail\", { stage, message: e.message, stack: e.stack });\n    return { ok: false, stage, error: e.message };\n  }\n}",
  },
  runSkillScriptDescription: {
    "zh-CN": "内部工具：执行已加载 skill/plugin 包内的脚本资源。不要直接暴露给模型；Skill 工具通过该工具复用 run_script 的 page/inner 执行桥接能力。page 必须使用当前任务已拥有的网页 tab；inner 运行在轻舟内部 Worker，不需要网页 tab。",
    en: "Internal tool: execute a script resource from a loaded Skill package. Do not expose directly to the model. Skill tools use this tool to reuse run_script’s page/inner execution bridge. page requires a web tab already owned by the current task; inner runs in qz’s internal Worker and needs no web tab.",
  },
  runSkillScriptTarget: {
    "zh-CN": "执行目标。不填或 page=当前任务网页；inner=轻舟内部 Worker。",
    en: "Execution target. Omitted or page: the current task’s web page. inner: qz’s internal Worker.",
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
    "zh-CN": "Skill 包中的脚本路径，例如 scripts/collect-feed.js。",
    en: "Script path within the Skill package, such as scripts/collect-feed.js.",
  },
  runSkillScriptArgs: {
    "zh-CN": "传给脚本的参数对象，脚本中通过 input 或 args 读取。",
    en: "Arguments passed to the script, available as input or args.",
  },
  runSkillScriptMutatesPage: {
    "zh-CN": "脚本是否会修改页面 DOM、表单或页面状态。默认 false；仅当确实修改页面时设为 true。",
    en: "Whether the script modifies the page DOM, forms, or page state. Default: false. Set true only when it actually modifies the page.",
  },
  runScriptTarget: {
    "zh-CN": "执行目标。不填或 page=当前任务网页上下文；inner=轻舟内部 offscreen Worker，只用于与页面无关的纯 JS/data_store/save_file/document/ask_llm 批处理。",
    en: "Execution target. Omitted or page: the current task’s web page context. inner: qz’s internal offscreen Worker, only for page-independent JavaScript/data_store/save_file/document/ask_llm batch operations.",
  },
  runScriptArgs: {
    "zh-CN": "传给临时代码的参数对象，脚本中通过 input 或 args 读取。",
    en: "Arguments passed to the temporary code, available as input or args.",
  },
  runScriptCode: {
    "zh-CN": "临时 JavaScript 代码；最后一个表达式会作为 result，函数体风格可显式 return。可调用 trace(...items) / log(...items) 输出调试轨迹到结果 trace。skill/plugin 包内脚本请调用对应 Skill 工具。该字段可能很长，填写 target/tabId/args/mutatesPage 后最后填写 code。",
    en: "Temporary JavaScript code. The last expression becomes result; a function body may use an explicit return. Call trace(...items) / log(...items) to append diagnostic entries to the result’s trace. Invoke scripts packaged in a Skill through the corresponding Skill tool. This field may be long: fill target/tabId/args/mutatesPage first and code last.",
  },
  scriptTimeout: {
    "zh-CN": "必填。脚本硬超时，单位秒；<= 0 表示无限等待，> 0 表示最多等待对应秒数。",
    en: "Required script timeout in seconds. <= 0 means no time limit; > 0 sets the maximum duration.",
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

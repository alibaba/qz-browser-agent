import { patchToolEvent, renderToolEvent } from "/extension/sidepanel/tools/tool-renderer.js";
import { getToolDisplayName } from "/extension/sidepanel/tools/tool-model.js";
import { getToolMetadataCatalog } from "/extension/shared/tools/tool-metadata.js";

const toolMetadata = getToolMetadataCatalog().tools;
import {
  createThinkingTimelineGroupElement,
  createToolTimelineGroupElement,
  groupConsecutiveToolTranscriptEntries,
  patchThinkingTimelineGroupElement,
  patchToolTimelineGroupElement,
} from "/extension/sidepanel/tools/tool-timeline-renderer.js";
import {
  INNER_SCROLL_TARGET_SELECTOR,
  pauseDescendantTailTargets,
  resolveWheelScrollOwner,
  setFollowTail,
} from "/extension/sidepanel/ui/scroll-tail-controller.js";
import { escapeHtml } from "/extension/sidepanel/ui/ui-utils.js";
import { enrichSkillToolIdentity, setSkillToolUiCatalog } from "/extension/sidepanel/tools/skill-tool-ui-registry.js";
import { createToolPresentationState } from "/extension/sidepanel/features/chat/transcript/presentation-state.js";
import { createChatScrollFeature } from "/extension/sidepanel/features/chat/chat-scroll-feature.js";

const messagesEl = document.querySelector("#messages");
const scenarioButtonsEl = document.querySelector("#scenario-buttons");
const assertionsEl = document.querySelector("#assertions");
const debugJsonEl = document.querySelector("#debug-json");
const deviceEl = document.querySelector("#visual-device");
const deviceTitleEl = document.querySelector("#device-title");
const deviceMetaEl = document.querySelector("#device-meta");
const conversationFlowInputEl = document.querySelector("#conversation-flow-input");
const operationFlowInputEl = document.querySelector("#operation-flow-input");
const flowStatusEl = document.querySelector("#flow-status");

const state = {
  scenarioId: "mixed",
  renderedGroups: [],
  currentEntries: [],
  customTitle: "",
};
const visualToolPresentationState = createToolPresentationState();
const VISUAL_PRESENTATION_SESSION_ID = "tool-timeline-visual";

function visualToolPresentationOptions(entry) {
  return {
    presentationState: visualToolPresentationState.resolve(VISUAL_PRESENTATION_SESSION_ID, entry),
    onPresentationChange: patch => visualToolPresentationState.update(VISUAL_PRESENTATION_SESSION_ID, entry, patch),
  };
}

function controlledVisualToolPresentationOptions(entry, options = {}) {
  if (options.presentationState) return options;
  const hasSetup = ["expanded", "userToggled", "activeToolKey"]
    .some(key => Object.prototype.hasOwnProperty.call(options, key));
  if (hasSetup) {
    const patch = {
      userToggled: options.userToggled !== false,
      expanded: Boolean(options.expanded),
    };
    if (Object.prototype.hasOwnProperty.call(options, "activeToolKey")) {
      patch.activeToolKey = options.activeToolKey;
    }
    visualToolPresentationState.update(VISUAL_PRESENTATION_SESSION_ID, entry, patch);
  }
  const {
    expanded: _expanded,
    userToggled: _userToggled,
    activeToolKey: _activeToolKey,
    ...rest
  } = options;
  return { ...visualToolPresentationOptions(entry), ...rest };
}

function resetVisualToolPresentationState() {
  visualToolPresentationState.reset();
}

const BUILTIN_WRAPPED_TOOL_GROUPS = [
  {
    id: "qingzhou-management",
    displayName: "轻舟管理",
    category: { id: "meta", label: "系统" },
    tools: [
      wrappedTool("qingzhou_management__manage_settings", "manage_settings", getToolDisplayName("manage_settings")),
      wrappedTool("qingzhou_management__manage_guardrails", "manage_guardrails", getToolDisplayName("manage_guardrails")),
    ],
  },
  {
    id: "qingzhou-documents",
    displayName: "文档处理",
    category: { id: "documents", label: "文档" },
    tools: [
      "document_fetch",
      "document_parse",
      "document_read_chunk",
      "document_create",
      "document_download",
      "document_list_artifacts",
    ].map(capabilityId => wrappedTool(`qingzhou_documents__${capabilityId}`, capabilityId, getToolDisplayName(capabilityId))),
  },
  {
    id: "qingzhou-mcp",
    displayName: "MCP 接入",
    category: { id: "mcp", label: "MCP" },
    tools: [
      "mcp_inspect_server",
      "mcp_list_tools",
      "mcp_search_tools",
      "mcp_call_tool",
    ].map(capabilityId => wrappedTool(`qingzhou_mcp__${capabilityId}`, capabilityId, getToolDisplayName(capabilityId))),
  },
];
const ALL_TOOL_NAMES = [
  ...Object.keys(toolMetadata),
  ...BUILTIN_WRAPPED_TOOL_GROUPS.flatMap(plugin => plugin.tools.map(tool => tool.name)),
];

function wrappedTool(name, capabilityId, title) {
  const meta = toolMetadata[capabilityId] || {};
  return {
    name,
    capabilityId,
    localName: capabilityId,
    title,
    runtime: "host",
    profileFamily: meta.profileFamily || "",
    resultFamily: meta.resultFamily || "generic",
    familyId: meta.familyId || "other",
    labelerId: meta.labelerId || "static",
  };
}

setSkillToolUiCatalog({ plugins: BUILTIN_WRAPPED_TOOL_GROUPS });
const SAMPLE_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180' viewBox='0 0 320 180'%3E%3Crect width='320' height='180' fill='%23f7f7f5'/%3E%3Crect x='20' y='24' width='280' height='132' rx='12' fill='%23ffffff' stroke='%23d9d9d6'/%3E%3Ccircle cx='64' cy='70' r='22' fill='%2324845d' opacity='.9'/%3E%3Cpath d='M104 64h132M104 88h96M40 128h240' stroke='%238b8f94' stroke-width='8' stroke-linecap='round' opacity='.75'/%3E%3C/svg%3E";
const SAMPLE_PAGE_CONTEXT = { tabId: 17, _pageTitle: "发布编辑页", _pageUrl: "https://www.xiaohongshu.com/publish" };

const rows = [
  { name: "西湖民宿", status: "新增", owner: "运营 A", url: "https://example.com/a" },
  { name: "露营咖啡", status: "更新", owner: "运营 B", url: "https://example.com/b" },
  { name: "亲子乐园", status: "新增", owner: "运营 C", url: "https://example.com/c" },
  { name: "夜游路线", status: "新增", owner: "运营 A", url: "https://example.com/d" },
  { name: "手作市集", status: "更新", owner: "运营 D", url: "https://example.com/e" },
  { name: "博物馆讲解", status: "新增", owner: "运营 E", url: "https://example.com/f" },
];

function renderVisualToolEvent(tool, options = {}) {
  return renderToolEvent(tool, {
    lazyDetails: false,
    ...controlledVisualToolPresentationOptions(tool, options),
  });
}

function patchVisualToolEvent(el, tool, options = {}) {
  return patchToolEvent(el, tool, controlledVisualToolPresentationOptions(tool, options));
}

function createVisualToolTimelineGroupElement(entry, options = {}) {
  return createToolTimelineGroupElement(entry, controlledVisualToolPresentationOptions(entry, options));
}

function patchVisualToolTimelineGroupElement(el, entry, options = {}) {
  return patchToolTimelineGroupElement(el, entry, controlledVisualToolPresentationOptions(entry, options));
}

const scenarios = [
  {
    id: "mixed",
    title: "完整对话流",
    description: "用户、助手、两组连续工具和最终回复混排。",
    entries: () => [
      user("帮我抓竞品页面，写入表格，发布前要确认。", "u1"),
      assistant("我会先读取页面和接口证据，再把结构化结果写入数据表。涉及提交动作时会停下来等你确认。", "a1"),
      tool("navigate", { url: "https://example.com/brand/list" }, { ok: true, title: "竞品列表" }, "t1"),
      tool("read_dom", { selector: ".brand-list" }, sampleDomResult("竞品列表", ".brand-list"), "t2"),
      tool("run_script", { code: sampleScript() }, { ok: true, hasResult: true, resultType: "array", result: rows.slice(0, 6), engine: "isolated-world" }, "t3"),
      tool("data_store", { action: "upsert", table: "brand_leads", dedupField: "url", rows }, { table: "brand_leads", inserted: 4, updated: 2, totalRows: 6, rows }, "t4"),
      assistant("表格已更新。我准备把摘要提交到目标页面，先等你确认。", "a2"),
      tool("document_create", { title: "竞品摘要", format: "md" }, { title: "竞品摘要", format: "markdown", blockCount: 8, artifactId: "doc_8421" }, "t5"),
      tool("ask_user", {
        title: "发布确认",
        message: "即将把摘要提交到目标页面。这个动作会影响现实世界，请确认是否继续。",
        submitLabel: "批准并继续",
        fields: [
          { id: "decision", label: "是否继续", type: "choice", required: true, options: [{ label: "批准", value: "approve" }, { label: "取消", value: "cancel" }] },
          { id: "note", label: "备注", type: "text", required: false, placeholder: "可选" },
        ],
      }, null, "t6", { isRunning: true, phase: "preparing" }),
    ],
  },
  {
    id: "thinking",
    title: "思考与工具分离",
    description: "思考从第一帧进入固定思考组，工具进入独立工具组。",
    entries: () => [
      user("帮我查一下城西房价趋势，过程不用太占地方。", "thu1"),
      thinking("先判断任务边界：用户要趋势信息，不是立即提交或发送消息，因此只需要搜索、读取和整理证据。", "th1"),
      tool("open_tab", { url: "https://www.google.com/search?q=城西房价趋势" }, { title: "搜索结果", url: "https://www.google.com/search?q=城西房价趋势", tabId: 1887129190 }, "tht1"),
      thinking("搜索结果已经给出关键词，需要进一步读取更稳定的详情页，避免只根据标题下结论。", "th2"),
      tool("wait_for_navigation", { tabId: 1887129190, timeout: 10 }, { message: "已导航到目标页", elapsedMs: 730, _tabId: 1887129190, _pageTitle: "城西房价趋势搜索结果", _pageUrl: "https://example.com/housing" }, "tht2"),
      tool("read_article", { source: "auto", tabId: 1887129190, limit: 8000 }, { title: "城西板块成交走势", url: "https://example.com/housing", text: longArticleText(2), sourceSelector: "main article", linkCount: 3, _tabId: 1887129190, _pageTitle: "城西板块成交走势", _pageUrl: "https://example.com/housing" }, "tht3"),
      thinking("正文证据足够：价格趋势、成交量和区域供需都出现了，可以整理成谨慎结论，并标注数据来源。", "th3", { streaming: true }),
      assistant("搜索和正文证据都已读取，我会把趋势拆成价格、成交和供需三部分说明。", "tha1"),
    ],
  },
  {
    id: "data",
    title: "upsert 表格证据",
    description: "时间线默认选择 data_store，直接露出写入表格。",
    entries: () => [
      user("把候选门店写入表。", "du1"),
      tool("navigate", { url: "https://example.com/store" }, { ok: true }, "dt1"),
      tool("read_dom", { selector: ".store-card" }, sampleDomResult("候选门店", ".store-card"), "dt2"),
      tool("run_script", { code: sampleScript() }, { ok: true, hasResult: true, resultType: "array", result: rows.slice(0, 3) }, "dt3"),
      tool("data_store", { action: "upsert", table: "store_candidates", dedupField: "url", rows }, { table: "store_candidates", inserted: 4, updated: 2, totalRows: 6, rows }, "dt4"),
    ],
  },
  {
    id: "code",
    title: "代码与日志",
    description: "运行中代码块、接口响应和 console 结果。",
    entries: () => [
      user("看下为什么接口没刷出来。", "cu1"),
      tool("network_recent", { filter: "/api/search" }, { requests: [{ method: "POST", status: 200, url: "https://example.com/api/search" }] }, "ct1"),
      tool("run_script", { code: sampleScript() }, null, "ct2", { isRunning: true, argsIncomplete: true, phase: "preparing", argsText: sampleScript() }),
      tool("read_console_messages", { level: "warning" }, {
        messages: [
          { level: "warning", text: "slow response: /api/search 1280ms", url: "https://example.com/app.js", lineNumber: 118 },
          { level: "error", text: "retry exhausted for /api/detail", url: "https://example.com/api.js", lineNumber: 42 },
        ],
      }, "ct3"),
    ],
  },
  {
    id: "permission",
    title: "用户确认",
    description: "现实世界影响动作前，停在 ask_user。",
    entries: () => [
      user("可以帮我发布吗？", "pu1"),
      assistant("发布会影响外部页面，我会先准备内容，然后等你确认。", "pa1"),
      tool("document_create", { title: "发布稿", format: "html" }, { title: "发布稿", format: "html", blockCount: 5, artifactId: "doc_publish" }, "pt1"),
      tool("ask_user", {
        title: "发布前确认",
        message: "将把正文提交到小红书最终编辑页。是否继续？",
        submitLabel: "批准发布",
        fields: [
          { id: "approve", label: "是否批准", type: "choice", required: true, options: [{ label: "批准", value: "yes" }, { label: "取消", value: "no" }] },
        ],
      }, null, "pt2", { isRunning: true, phase: "preparing" }),
    ],
  },
  {
    id: "error",
    title: "错误与恢复",
    description: "错误态时间线自动展开，并选中出错步骤。",
    entries: () => [
      user("点一下保存按钮。", "eu1"),
      tool("read_dom", { target: "button" }, sampleDomResult("按钮片段", "button"), "et1"),
      tool("act_on_element", { target: "uid:btn-save", action: "click" }, { code: "STALE_ELEMENT_UID", message: "Element target is stale or unknown.", hint: "Take a fresh get_ax_tree snapshot, then retry.", details: { target: "uid:btn-save" } }, "et2", { isError: true }),
      tool("screenshot", { fullPage: false }, { method: "viewport", width: 1280, height: 720, note: "保存按钮已重新渲染", ...SAMPLE_PAGE_CONTEXT }, "et3"),
      assistant("按钮在点击前重新渲染了，需要重新定位后再操作。", "ea1"),
    ],
  },
  {
    id: "long",
    title: "长流程聚合",
    description: "67 步工具调用按工具族聚合，避免 pill 墙。",
    entries: () => [
      user("批量打开页面、读取正文和页面结构，最后整理证据。", "lu1"),
      assistant("我会把重复动作聚合展示，只保留关键证据和每族最新进展。", "la1"),
      ...longTraceTools(),
    ],
  },
  {
    id: "all-tools",
    title: "全部工具组件",
    description: "逐个独立渲染生产工具卡片，测试可展开控件。",
    componentMatrix: true,
  },
];

const DEFAULT_OPERATION_FLOW = [
  { action: "expandAll", label: "展开全部", delay: 360 },
  { action: "clickStep", group: 0, step: 1, label: "查看 DOM", delay: 420 },
  { action: "clickStep", group: 0, step: 3, label: "查看表格", delay: 520 },
  { action: "toggleGroup", group: 0, label: "折叠数据时间线", delay: 420 },
  { action: "toggleGroup", group: 0, label: "重新展开数据时间线", delay: 420 },
  { action: "clickStep", group: 1, step: 1, label: "查看确认步骤", delay: 520 },
  { action: "patch", group: 1, label: "模拟用户批准", delay: 520 },
];

function user(text, key) {
  return { type: "user", _uiKey: key, text, timestamp: "2026-06-13 10:00:00" };
}

function assistant(content, key) {
  return { type: "assistant", _uiKey: key, content, timestamp: "2026-06-13 10:00:01" };
}

function thinking(text, key, overrides = {}) {
  return {
    type: "thinking",
    _uiKey: key,
    text,
    streaming: false,
    timestamp: "2026-06-13 10:00:01",
    ...overrides,
  };
}

function tool(name, args, result, key, overrides = {}) {
  return {
    type: "tool",
    _uiKey: key,
    toolCallId: key,
    runId: "visual-run",
    name,
    args,
    result,
    timestamp: "2026-06-13 10:00:02",
    endedAt: overrides.isRunning ? "" : "2026-06-13 10:00:10",
    ...overrides,
  };
}

function sampleScript() {
  return `const rows = await page.evaluate(() => {
  return [...document.querySelectorAll('.item')].map(node => ({
    title: node.querySelector('h3')?.textContent?.trim(),
    price: node.querySelector('.price')?.textContent?.trim(),
    city: node.querySelector('[data-city]')?.dataset.city
  }));
});
console.table(rows.slice(0, 5));
return rows;`;
}

function longTraceTools() {
  const pattern = [
    "open_tab", "wait_for_navigation", "read_article", "read_dom", "find_elements", "open_tab", "wait_for_navigation",
    "read_article", "read_article", "open_tab", "wait_for_navigation", "wait_for_navigation", "read_dom",
    "act_on_element", "wait", "read_dom", "act_on_element", "read_dom", "find_elements", "act_on_element",
    "wait", "read_dom", "act_on_element", "wait", "read_dom", "act_on_element", "act_on_element",
    "run_script", "run_script", "wait", "read_dom", "run_script", "act_on_element", "data_store",
  ];
  const names = [...pattern, ...pattern.slice(0, 33)];
  return names.slice(0, 67).map((name, index) => {
    const sample = sampleForTool(name);
    const result = name === "read_article"
      ? { ...sample.result, title: `正文样本 ${index + 1}`, _pageTitle: `正文样本 ${index + 1}`, text: longArticleText(index) }
      : sample.result;
    return tool(name, sample.args, result, `long-${index + 1}-${name}`, sample.overrides || {});
  });
}

function longArticleText(seed = 0) {
  const paragraphs = Array.from({ length: 46 }, (_, index) => {
    return `第 ${index + 1} 段：这是长正文样例 ${seed + 1}，用于验证读取正文工具展开后不会把聊天流撑成一整屏。这里保留段落换行、链接 https://example.com/article/${seed}-${index} 和一些运营需要核对的文本证据。`;
  });
  return paragraphs.join("\n\n");
}

function init() {
  renderScenarioButtons();
  bindToolbar();
  bindFlowEditor();
  bindHarnessCodeCopy();
  renderScenario(state.scenarioId);
}

function renderScenarioButtons() {
  scenarioButtonsEl.innerHTML = scenarios.map(item => `
    <button class="visual-btn ${item.id === state.scenarioId ? "active" : ""}" data-scenario="${escapeHtml(item.id)}">
      <b>${escapeHtml(item.title)}</b><br>
      <span>${escapeHtml(item.description)}</span>
    </button>
  `).join("");
  scenarioButtonsEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-scenario]");
    if (!button) return;
    renderScenario(button.dataset.scenario);
  });
}

function bindToolbar() {
  document.querySelectorAll("[data-width]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-width]").forEach(item => item.classList.toggle("active", item === button));
      const width = Number(button.dataset.width) || 420;
      deviceEl.style.setProperty("--visual-width", `${width}px`);
      deviceMetaEl.textContent = `${width}px`;
      runAssertions();
    });
  });

  document.querySelector("#expand-all").addEventListener("click", () => {
    setAllTimelineGroupsExpanded(true);
    runAssertions();
  });
  document.querySelector("#collapse-all").addEventListener("click", () => {
    setAllTimelineGroupsExpanded(false);
    runAssertions();
  });
  document.querySelector("#patch-running").addEventListener("click", () => {
    patchFirstTimelineGroup();
    runAssertions();
  });
}

function bindFlowEditor() {
  document.querySelector("#render-flow").addEventListener("click", () => {
    try {
      renderConversationFlow(parseConversationFlow(conversationFlowInputEl.value));
      setFlowStatus("已渲染自定义对话流");
    } catch (err) {
      setFlowStatus(`对话流错误：${err.message || err}`, true);
    }
  });

  document.querySelector("#run-flow").addEventListener("click", async () => {
    try {
      const operations = parseOperationFlow(operationFlowInputEl.value);
      await runOperationFlow(operations, { status: true });
      setFlowStatus(`已运行 ${operations.length} 个操作`);
    } catch (err) {
      setFlowStatus(`操作流错误：${err.message || err}`, true);
    }
  });
}

function bindHarnessCodeCopy() {
  messagesEl.addEventListener("click", (event) => {
    const button = event.target.closest?.(".code-copy-btn");
    if (!button || !messagesEl.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();

    const block = button.closest(".copyable-code-block");
    const pre = block?.querySelector("pre");
    const code = block?.dataset.copyText || pre?.innerText || pre?.textContent || "";
    window.__lastCopiedText = code;
    button.classList.add("is-confirmed");
    block?.classList.add("copy-confirmed");
    button.title = code.trim() ? "已复制" : "无内容";
    button.setAttribute("aria-label", button.title);
    window.clearTimeout(button.__visualCopyTimer);
    button.__visualCopyTimer = window.setTimeout(() => {
      button.classList.remove("is-confirmed");
      block?.classList.remove("copy-confirmed");
      button.title = "复制代码";
      button.setAttribute("aria-label", "复制代码");
    }, 1200);
  });
}

function renderScenario(id) {
  state.scenarioId = scenarios.some(item => item.id === id) ? id : scenarios[0].id;
  state.renderedGroups = [];
  const scenario = scenarios.find(item => item.id === state.scenarioId);
  if (scenario.componentMatrix) {
    renderAllToolComponents();
    return;
  }
  state.currentEntries = scenario.entries();
  state.customTitle = "";
  deviceTitleEl.textContent = scenario.title;
  scenarioButtonsEl.querySelectorAll("[data-scenario]").forEach(button => {
    button.classList.toggle("active", button.dataset.scenario === state.scenarioId);
  });
  syncFlowInputs({
    title: scenario.title,
    entries: state.currentEntries,
  }, scenario.id);

  renderEntries(state.currentEntries);
  runAssertions();
}

function syncFlowInputs(flow, scenarioId = state.scenarioId) {
  conversationFlowInputEl.value = JSON.stringify(flow, null, 2);
  operationFlowInputEl.value = JSON.stringify(defaultOperationsForScenario(scenarioId), null, 2);
  setFlowStatus("");
}

function defaultOperationsForScenario(scenarioId) {
  if (scenarioId === "thinking") {
    return [
      { action: "expandThinking", label: "展开思考过程", delay: 360 },
      { action: "clickThinkingNav", direction: -1, label: "回看上一段思考", delay: 420 },
      { action: "clickThinkingNav", direction: 1, label: "回到最近思考", delay: 420 },
      { action: "expandAll", label: "展开工具时间线", delay: 360 },
      { action: "clickStep", group: 0, step: 1, label: "查看导航等待", delay: 420 },
    ];
  }
  return DEFAULT_OPERATION_FLOW;
}

function renderConversationFlow(flow) {
  state.scenarioId = "custom";
  state.customTitle = flow.title || "自定义对话流";
  state.currentEntries = normalizeConversationEntries(flow.entries);
  deviceTitleEl.textContent = state.customTitle;
  scenarioButtonsEl.querySelectorAll("[data-scenario]").forEach(button => {
    button.classList.remove("active");
  });
  renderEntries(state.currentEntries);
  runAssertions();
}

function renderAllToolComponents({ expanded = true } = {}) {
  setSkillToolUiCatalog({ plugins: BUILTIN_WRAPPED_TOOL_GROUPS });
  state.scenarioId = "all-tools";
  state.renderedGroups = [];
  state.currentEntries = [];
  state.customTitle = "全部工具组件";
  deviceTitleEl.textContent = state.customTitle;
  scenarioButtonsEl.querySelectorAll("[data-scenario]").forEach(button => {
    button.classList.toggle("active", button.dataset.scenario === state.scenarioId);
  });
  conversationFlowInputEl.value = JSON.stringify({
    title: state.customTitle,
    mode: "all-tools",
    tools: ALL_TOOL_NAMES,
  }, null, 2);
  operationFlowInputEl.value = JSON.stringify([
    { action: "allTools", label: "渲染全部工具", delay: 260 },
    { action: "expandTool", name: "run_script", label: "展开代码工具", delay: 360 },
    { action: "clickCopy", name: "run_script", label: "复制代码", delay: 420 },
    { action: "clickTreeToggle", name: "get_ax_tree", label: "折叠页面树", delay: 420 },
    { action: "toggleRaw", name: "data_store", label: "展开原始数据", delay: 420 },
    { action: "collapseTool", name: "ask_user", label: "折叠确认工具", delay: 360 },
  ], null, 2);
  setFlowStatus("");

  messagesEl.innerHTML = "";
  const matrix = document.createElement("div");
  matrix.className = "visual-tool-components";
  ALL_TOOL_NAMES.forEach((name, index) => {
    const card = document.createElement("section");
    card.className = "visual-tool-component";
    card.dataset.toolName = name;
    card.innerHTML = `
      <div class="visual-tool-component-label">
        <span>${escapeHtml(String(index + 1).padStart(2, "0"))}</span>
        <b>${escapeHtml(getToolDisplayName(enrichSkillToolIdentity({ name })))}</b>
      </div>
    `;
    const event = renderVisualToolEvent(sampleToolEvent(name, index));
    event.dataset.toolName = name;
    card.appendChild(event);
    matrix.appendChild(card);
  });
  messagesEl.appendChild(matrix);
  if (expanded) setAllToolCardsExpanded(true);
  runAssertions();
}

function sampleToolEvent(name, index = 0) {
  const sample = sampleForTool(name);
  return tool(name, sample.args, sample.result, `all-${index}-${name}`, sample.overrides || {});
}

function sampleForTool(name) {
  const documentToolName = enrichSkillToolIdentity({ name }).capabilityId || name;
  const tabs = sampleTabs();
  const elements = sampleElements();
  const requests = sampleRequests();
  const downloads = sampleDownloads();
  const skill = {
    name: "xiaohongshu-note-publisher",
    scope: "project",
    status: "active",
    description: "发布前校验正文格式和安全确认。",
    updatedAt: "2026-06-13 10:20:00",
    resources: [
      { path: "SKILL.md", type: "markdown", description: "指令正文", size: 4915, hasContent: true },
      { path: "scripts/publish.js", type: "script", description: "页面脚本", size: 9420, hasContent: true },
    ],
  };

  if (name === "list_tabs" || name === "group_tabs") {
    return {
      args: name === "group_tabs" ? { tabIds: tabs.map(tab => tab.id), color: "green" } : { windowId: 1 },
      result: name === "group_tabs" ? { groupId: 12, tabIds: tabs.map(tab => tab.id), title: "轻舟任务", color: "green", tabs } : { tabs },
    };
  }
  if (name === "get_working_tab") return { args: {}, result: tabs[0] };
  if (name === "open_tab") return { args: { url: tabs[1].url, active: false }, result: { ...tabs[1], focusedWindow: false } };
  if (name === "close_tab") return { args: { tabId: 18 }, result: { closed: true, tabId: 18, title: "旧版落地页", url: "https://example.com/old" } };
  if (name === "use_tab") return { args: { tabId: 17 }, result: { tabId: 17, title: "竞品详情", url: tabs[0].url, visibleChanged: false } };
  if (name === "navigate") return { args: { url: "https://example.com/brand/list" }, result: { title: "竞品列表", url: "https://example.com/brand/list", tabId: 17 } };

  if (name === "manage_sessions") {
    return {
      args: {
        action: "create",
        title: "竞品抓取子任务",
        prompt: "请打开 3 个竞品页面，读取价格、城市、卖点和联系方式。只做信息采集，不要提交表单或发送消息；遇到需要现实世界影响的动作必须等待用户确认。",
      },
      result: { status: "created", sessionId: "session_003", title: "竞品抓取子任务", message: "已创建后台任务" },
    };
  }
  if (name === "manage_settings" || name === "qingzhou_management__manage_settings") {
    const readsCurrentConfig = name === "qingzhou_management__manage_settings";
    return {
      args: {
        action: readsCurrentConfig ? "get" : "update_config",
        provider: "kimicode",
        model: "kimi-k2-coder",
        contextWindow: 262000,
        vision: false,
        debugMode: true,
      },
      result: {
        ok: true,
        action: readsCurrentConfig ? "get" : "update_config",
        saved: !readsCurrentConfig,
        config: {
          provider: "kimicode",
          providerLabel: "KimiCode",
          model: "kimi-k2-coder",
          endpoint: "https://api.kimi.com/coding/v1/messages",
          contextWindow: 262000,
          vision: false,
          trimOldToolResults: true,
          debugMode: true,
          hasApiKey: true,
          apiKey: "sk-visual-key",
          providerApiKeys: { kimicode: "sk-visual-key" },
          activePresetId: "preset_kimi",
        },
        providers: readsCurrentConfig ? [
          { id: "kimicode", label: "KimiCode", requiresApiKey: true, defaultContextWindow: 262000 },
          { id: "openai", label: "OpenAI", requiresApiKey: true, defaultContextWindow: 128000 },
        ] : undefined,
      },
    };
  }
  if (name === "manage_guardrails" || name === "qingzhou_management__manage_guardrails") {
    return {
      args: { action: "get" },
      result: {
        ok: true,
        action: "get",
        securityGuardrails: {
          rules: [
            { id: "rule_1", action: "deny", type: "domain", value: "example.com", createdAt: "2026-07-11 09:30" },
            { id: "rule_2", action: "allow", type: "pattern", value: "https://example.com/help/*", createdAt: "2026-07-11 09:31" },
          ],
          siteOpenRateLimits: [
            { id: "limit_1", type: "domain", value: "news.example.com", minOpenIntervalMs: 5000, enabled: true },
          ],
        },
      },
    };
  }
  if (name === "data_store") {
    return {
      args: { action: "upsert", table: "brand_leads", dedupField: "url", rows },
      result: { table: "brand_leads", inserted: 4, updated: 2, totalRows: 6, rows },
    };
  }
  if (name === "manage_bookmarks") {
    return {
      args: { action: "search", query: "运营" },
      result: { items: [
        { id: "bm_1", title: "竞品素材库", url: "https://example.com/bookmark/a", parentId: "调研" },
        { id: "bm_2", title: "发布检查表", url: "https://example.com/bookmark/b", parentId: "流程" },
      ] },
    };
  }
  if (name === "browse_history") {
    return {
      args: { query: "小红书", limit: 5 },
      result: { items: [
        { title: "小红书最终编辑页", url: "https://www.xiaohongshu.com/publish", visitCount: 6 },
        { title: "正文排版参考", url: "https://example.com/xhs-format", visitCount: 2 },
      ] },
    };
  }
  if (name === "read_article") {
    return {
      args: { source: "auto", tabId: 1887129424, limit: 8000, url: "https://example.com/article/format" },
      result: {
        title: "小红书正文排版指南",
        url: "https://example.com/article/format",
        _tabId: 1887129424,
        _pageTitle: "小红书正文排版指南",
        _pageUrl: "https://example.com/article/format",
        source: "example.com",
        sourceSelector: "main article",
        text: longArticleText(0),
        outline: [
          { index: 1, level: 2, title: "正文结构", text: "正文结构", offset: 0, endOffset: 1420, charCount: 1420 },
          { index: 2, level: 2, title: "发布前检查", text: "发布前检查", offset: 1420, endOffset: 2840, charCount: 1420 },
        ],
        linkCount: 1,
      },
    };
  }
  if (name === "read_dom") {
    return {
      args: { selector: ".editor", offset: 12, limit: 8 },
      result: sampleDomResult("编辑器 HTML", ".editor"),
    };
  }
  if (name === "get_ax_tree") {
    return {
      args: { root: "root", depth: 3 },
      result: sampleTreeResult("页面结构"),
    };
  }
  if (name === "find_elements") {
    return { args: { selector: "button, textarea", query: "发布" }, result: { elements } };
  }
  if (name === "select_element") return { args: { selector: "button.publish" }, result: { selected: "发布", selector: "button.publish", index: 0, element: elements[0] } };
  if (name === "inspect_element") return { args: { target: "uid:btn-publish" }, result: elements[0] };
  if (name === "act_on_element") return { args: { target: "uid:btn-save", action: "click" }, result: { action: "click", target: "uid:btn-save", clicked: "保存草稿", selector: "button[data-action='save']", index: 2, method: "cdp", navigated: false, newTabOpened: false, element: elements[2] } };
  if (name === "click_element") return { args: { selector: "button.preview" }, result: { action: "click", clicked: "预览", selector: "button.preview", index: 3, method: "cdp", navigated: false, newTabOpened: false } };
  if (name === "fill_input") return {
    args: { selector: ".ProseMirror", value: "第一段：结论\n\n第二段：证据\n\n第三段：行动建议" },
    result: {
      action: "fill",
      filled: "正文编辑区",
      selector: ".ProseMirror",
      index: 1,
      submitted: false,
      method: "content",
      fill: {
        ok: true,
        multiline: true,
        method: "paste",
        richText: {
          method: "paste",
          structure: {
            paragraphCount: 4,
            brCount: 0,
            blockCount: 4,
            lineBreakCount: 5,
            innerTextLength: 1582,
            htmlSample: "<p>第一段：结论</p><p><br></p><p>第二段：证据</p><p>第三段：行动建议</p>",
          },
        },
      },
      element: elements[1],
    },
  };
  if (name === "scroll_page") return { args: { direction: "down", amount: 720 }, result: { message: "已滚动页面", selector: "window", index: 1 } };
  if (name === "highlight_elements") return { args: { selector: ".publish-button" }, result: { elements } };

  if (name === "screenshot") {
    return {
      args: { fullPage: false },
      result: { method: "viewport", width: 1280, height: 720, note: "页面首屏截图", ...SAMPLE_PAGE_CONTEXT },
      overrides: { image: SAMPLE_IMAGE },
    };
  }
  if (name === "read_image") {
    return {
      args: { target: "css:img.cover", detail: "high" },
      result: { _imageDetail: { src: "https://example.com/cover.jpg", alt: "露营咖啡封面", naturalWidth: 1280, naturalHeight: 720, mimeType: "image/jpeg", bytes: 184320 }, index: 0 },
      overrides: { image: SAMPLE_IMAGE },
    };
  }
  if (name === "run_script") {
    return {
      args: { code: sampleScript() },
      result: { ok: true, hasResult: true, resultType: "array", engine: "isolated-world", result: rows.slice(0, 4), trace: [{ level: "log", message: "console.table 输出 4 行", time: "2026-06-13T10:13:30.000Z" }], ...SAMPLE_PAGE_CONTEXT },
    };
  }
  if (name === "inject_css") return { args: { css: ".ProseMirror p { margin: 0 0 12px; white-space: pre-wrap; }" }, result: { injected: true, length: 60, message: "样式已注入", ...SAMPLE_PAGE_CONTEXT } };
  if (name === "modify_dom") return {
    args: {
      operations: [
        { selector: ".preview", action: "setHTML", value: "<p>正文预览</p>" },
        { selector: ".card", action: "addClass", value: "highlighted", all: true },
        { selector: "button[disabled]", action: "removeAttr", name: "disabled", all: true },
      ],
    },
    result: {
      operations: 3,
      ...SAMPLE_PAGE_CONTEXT,
      results: [
        { selector: ".preview", action: "setHTML", count: 3 },
        { selector: ".card", action: "addClass", count: 11 },
        { selector: "button[disabled]", action: "removeAttr", count: 0 },
      ],
    },
  };
  if (["save_file", "list_downloads", "download_url"].includes(name)) {
    if (name === "save_file") {
      const content = longSaveFileContent(72, "组件矩阵");
      return {
        args: { filename: "GRPO原理详解.html", content, mimeType: "text/html" },
        result: { downloadId: 42, filename: "GRPO原理详解.html", size: content.length },
      };
    }
    return {
      args: name === "download_url" ? { url: "https://example.com/report.csv", filename: "report.csv" } : { filename: "report.csv" },
      result: { downloads },
    };
  }

  if (documentToolName === "document_fetch") {
    return { args: { url: "https://example.com/report.docx" }, result: { filename: "竞品报告.docx", sourceUrl: "https://example.com/report.docx", fileId: "file_8421", size: 245760, blockCount: 18, outline: [{ level: 1, text: "摘要" }, { level: 2, text: "候选品牌" }] } };
  }
  if (documentToolName === "document_parse") {
    return { args: { fileId: "file_8421" }, result: { title: "竞品报告", docModelId: "doc_8421", sheetCount: 1, sheets: [{ name: "候选品牌", rowCount: 6, columns: ["name", "status", "owner", "url"] }], outline: [{ level: 1, text: "结论" }] } };
  }
  if (documentToolName === "document_read_chunk") {
    return {
      args: { docModelId: "doc_8421", chunkIndex: 2, limit: 1200 },
      result: {
        title: "竞品报告",
        docModelId: "doc_8421",
        type: "text",
        chunkIndex: 2,
        chunkCount: 8,
        text: "本块覆盖候选品牌的定位、价格带和渠道状态。A 品牌在线下渠道更强，B 品牌的内容种草效率更高，C 品牌适合继续观察其新品节奏。建议后续把表格数据与社媒互动表现合并，优先关注高复购与高毛利的组合。",
      },
    };
  }
  if (documentToolName === "document_create") {
    return { args: { title: "竞品摘要", format: "markdown" }, result: { title: "竞品摘要", format: "markdown", artifactId: "doc_new_01", blockCount: 8, downloaded: { filename: "竞品摘要.md", url: "https://example.com/download/summary.md", state: "complete" } } };
  }
  if (documentToolName === "document_download") {
    return { args: { artifactId: "doc_new_01", filename: "竞品摘要.md" }, result: { filename: "竞品摘要.md", url: "https://example.com/download/summary.md", state: "complete", downloadId: "dl_7788" } };
  }
  if (documentToolName === "document_list_artifacts") {
    return { args: { limit: 5 }, result: { artifacts: [
      { title: "竞品摘要", artifactId: "doc_new_01", format: "markdown", blockCount: 8, updatedAt: "2026-06-13 10:11:00" },
      { title: "候选品牌表", artifactId: "sheet_2102", format: "xlsx", sheetCount: 1, updatedAt: "2026-06-13 10:09:10" },
    ] } };
  }

  if (name === "network_watch" || name === "network_recent" || name === "network_body") {
    if (name === "network_body") {
      return {
        args: { requestId: "req_42", maxBytes: 24000 },
        result: {
          ...SAMPLE_PAGE_CONTEXT,
          requestId: "req_42",
          method: "POST",
          url: "https://example.com/api/search",
          status: 200,
          mimeType: "application/json",
          durationMs: 1280,
          encodedDataLength: 24576,
          size: 246,
          truncated: false,
          body: JSON.stringify({ ok: true, items: rows.slice(0, 2) }, null, 2),
        },
      };
    }
    return {
      args: { filter: "/api/search", limit: 8 },
      result: { requests, ...SAMPLE_PAGE_CONTEXT },
    };
  }
  if (name === "read_console_messages") {
    return {
      args: { level: "warning", textPattern: "response" },
      result: { ...SAMPLE_PAGE_CONTEXT, messages: [
        { level: "warning", text: "slow response: /api/search 1280ms", url: "https://example.com/app.js", lineNumber: 118, timestamp: "2026-06-13T10:12:00Z" },
        { level: "error", text: "retry exhausted for /api/detail", url: "https://example.com/api.js", lineNumber: 42, timestamp: "2026-06-13T10:12:04Z" },
      ], totalBuffered: 18 },
    };
  }
  if (name === "wait_for_response") return { args: { urlPattern: "/api/search", timeout: 5 }, result: { message: "已等到响应", url: "https://example.com/api/search", elapsedMs: 860, ...SAMPLE_PAGE_CONTEXT } };
  if (name === "wait_for_network_idle") return { args: { timeout: 3, idleSeconds: 0.8 }, result: { message: "网络已空闲", elapsedMs: 1240, ...SAMPLE_PAGE_CONTEXT } };
  if (name === "wait_for_user") return { args: { message: "完成手机号验证", tabId: 1887, timeout: 60 }, result: { continued: true, reason: "user", tabId: 1887, elapsedMs: 18000, _pageTitle: "登录验证页", _pageUrl: "https://example.com/login" } };
  if (name === "send_alert") return { args: { title: "杭州天气提醒", message: "杭州当前天气：25°C，阴，体感25°C，东北风4级；今日22~33°C，中雨转小雨，出门记得带伞。", level: "info" }, result: { ok: true, sent: true, suppressed: false, title: "杭州天气提醒", message: "杭州当前天气：25°C，阴，体感25°C，东北风4级；今日22~33°C，中雨转小雨，出门记得带伞。", level: "info", notificationId: "qz_alert_sample", policy: { maxPerWindow: 3 } } };
  if (name === "ask_user") {
    return {
      args: {
        title: "发布前确认",
        message: "将把正文提交到小红书最终编辑页。这个动作会影响现实世界，请确认是否继续。",
        submitLabel: "批准发布",
        fields: [
          { id: "decision", label: "是否批准", type: "choice", required: true, options: [{ label: "批准", value: "yes" }, { label: "取消", value: "no" }] },
          { id: "note", label: "备注", type: "text", required: false, placeholder: "可选" },
        ],
      },
      result: { submitted: false, reason: "waiting" },
    };
  }
  if (name === "wait_for_navigation") return { args: { timeout: 10 }, result: { message: "已导航到目标页", url: "https://example.com/done", elapsedMs: 920, ...SAMPLE_PAGE_CONTEXT } };
  if (name === "wait_for_element") return { args: { selector: ".publish-button", timeout: 8 }, result: { message: "元素已出现", selector: ".publish-button", elapsedMs: 320, ...SAMPLE_PAGE_CONTEXT } };
  if (name === "wait") return { args: { seconds: 1 }, result: { message: "已等待 1s", elapsedMs: 1002 } };

  if (name === "ask_llm") return { args: { prompt: "提取页面中最重要的 3 个卖点" }, result: "1. 城市特色明确\n2. 价格区间清晰\n3. 发布前需要保留正文换行" };
  if (name === "load_skill") return { args: { name: skill.name }, result: skill };
  if (name === "load_skill_resource") {
    const content = [
      "# 发布检查清单",
      "",
      "- 检查正文换行是否保留。",
      "- 检查图片数量是否满足平台要求。",
      "- 检查提交前是否需要用户确认。",
      "",
      "```js",
      "return { ok: true, checked: ['body', 'images'] };",
      "```",
    ].join("\n");
    return {
      args: { name: skill.name, path: "references/publish-checklist.md" },
      result: {
        name: skill.name,
        path: "references/publish-checklist.md",
        type: "markdown",
        title: "publish-checklist.md",
        description: "发布检查参考资料",
        size: content.length,
        start: 0,
        end: content.length,
        truncated: false,
        content,
      },
    };
  }
  if (name === "create_skill") {
    const content = [
      "# 发布检查",
      "",
      "发布前检查正文段落、图片数量和安全确认。",
      "",
      "## 即时反馈",
      "",
      "- 保存中展示正文预览。",
      "- 正文过长时只在预览区内部滚动。",
      "- 用户上滑后不强制追尾。",
    ].join("\n");
    return {
      args: {
        name: skill.name,
        content,
      },
      result: {
        saved: true,
        name: skill.name,
        scope: skill.scope,
        updatedAt: skill.updatedAt,
      },
    };
  }
  if (name === "edit_skill_resource") {
    const content = "// Check the page text, image count, and submit button state.\nreturn { ok: true };";
    return {
      args: {
        name: skill.name,
        path: "scripts/check-publish.js",
        action: "set",
        type: "script",
        title: "发布检查脚本",
        content,
      },
      result: {
        updated: true,
        name: skill.name,
        path: "scripts/check-publish.js",
        type: "script",
        size: content.length,
        updatedAt: skill.updatedAt,
      },
    };
  }
  if (name === "update_skill") {
    return {
      args: {
        name: skill.name,
        appendContent: "## 2026-06-13 补充：文字配图\n\n- 发布前检查图片数量和正文段落。\n- 富文本正文必须通过粘贴或段落 HTML 保留换行。",
        edit: {
          path: "SKILL.md",
          find: "使用普通 fill 填正文",
          replace: "使用富文本粘贴保留段落，并读取 DOM 验证 p/br",
        },
        resourceEdits: [
          {
            path: "scripts/check-publish.js",
            action: "edit",
            oldText: "return { ok: true };",
            newText: "return { ok: true, checked: ['body', 'images'] };",
          },
        ],
      },
      result: {
        skill,
        changes: [
          { action: "append", path: "SKILL.md", content: "## 2026-06-13 补充：文字配图\n\n- 发布前检查图片数量和正文段落。\n- 富文本正文必须通过粘贴或段落 HTML 保留换行。" },
          { action: "edit", path: "SKILL.md", before: "使用普通 fill 填正文", after: "使用富文本粘贴保留段落，并读取 DOM 验证 p/br" },
        ],
      },
    };
  }
  if (name === "delete_skill") return { args: { name: skill.name }, result: { deleted: true, name: skill.name, scope: skill.scope, resources: skill.resources, updatedAt: skill.updatedAt } };

  return { args: { name, sample: true }, result: { ok: true, message: `${getToolDisplayName(name)} 已完成`, count: 1 } };
}

function sampleTabs() {
  return [
    { id: 17, windowId: 1, active: true, title: "竞品详情", url: "https://example.com/brand/detail" },
    { id: 18, windowId: 1, active: false, title: "发布编辑页", url: "https://www.xiaohongshu.com/publish" },
    { id: 19, windowId: 1, active: false, title: "素材表", url: "https://example.com/sheet" },
  ];
}

function sampleElements() {
  return [
    {
	      uid: "btn-publish",
	      target: "uid:btn-publish",
      role: "button",
      name: "发布",
      selector: "button.publish",
      index: 0,
      line: 42,
      visible: true,
      disabled: false,
      inViewport: true,
      obscuredAtCenter: false,
      rect: { x: 598, y: 104, width: 96, height: 36, top: 104 },
      clickablePoint: { x: 643, y: 122 },
      form: { selector: "#publish-form", method: "POST" },
      nearbyText: "标题、正文、发布、保存草稿。按钮右侧无遮挡层。",
    },
    {
	      uid: "editor-body",
	      target: "uid:editor-body",
      role: "textbox",
      name: "正文",
      selector: ".ProseMirror",
      index: 1,
      line: 58,
      visible: true,
      disabled: false,
      inViewport: true,
      rect: { x: 120, y: 180, width: 720, height: 360, top: 180 },
    },
    {
	      uid: "btn-save",
	      target: "uid:btn-save",
      role: "button",
      name: "保存草稿",
      selector: "button.save",
      index: 2,
      line: 71,
      visible: true,
      disabled: false,
      inViewport: true,
    },
  ];
}

function sampleRequests() {
  return [
    { method: "POST", status: 200, url: "https://example.com/api/search", type: "fetch", duration: 1280, size: 24576 },
    { method: "GET", status: 304, url: "https://example.com/api/config", type: "xhr", duration: 74, size: 980 },
    { method: "POST", status: 500, url: "https://example.com/api/detail", type: "fetch", duration: 2300, size: 512 },
  ];
}

function sampleDownloads() {
  return [
    { id: "dl_1", filename: "report.csv", url: "https://example.com/report.csv", state: "complete", bytesReceived: 49152, totalBytes: 49152, endTime: "2026-06-13 10:09:00" },
    { id: "dl_2", filename: "cover.png", url: "https://example.com/cover.png", state: "in_progress", bytesReceived: 32768, totalBytes: 98304, startTime: "2026-06-13 10:10:12" },
  ];
}

function sampleDomResult(title, selector = "body") {
  const lines = [
    `12: <section class="${selector.replace(/^[.#]/, "") || "content"}" data-source="visual-test">`,
    "13:   <article id=\"long-article\">",
    "14:     <h1>正文结构</h1>",
    "15:     <p>第一段：明确结论。</p>",
    "16:     <p>第二段：证据和注意事项。<br>保留换行。</p>",
    "17:     <input type=\"hidden\" name=\"draftId\" value=\"draft_42\">",
    "18:   </article>",
    "19: </section>",
  ];
  return {
    title,
    url: "https://example.com/publish/editor?from=qingzhou",
    totalLines: 42,
    showing: "12-19",
    hasMore: true,
    content: lines.join("\n"),
  };
}

function sampleTreeResult(title) {
  return {
    title,
    url: "https://clogin.ke.com/login?service=https%3A%2F%2Fwww.ke.com%2Fuser%2FcheckLogin%3Fredirect%3Dhttps%25253A%25252F%25252Fexample.com%25252Fpublish%25252Feditor%25253Ffrom%25253Dqingzhou%252526trace%25253Dvery-long-value",
    depth: 16,
    totalLines: 18,
    nodeCount: 42,
    semanticNodeCount: 9,
    returnedNodeCount: 8,
    _display: {
      tree: [
        {
          role: "main",
          name: "发布编辑页",
	          uid: "main",
	          target: "uid:main",
          children: [
            {
              role: "textbox",
              name: "正文编辑区",
	              uid: "editor-body",
	              target: "uid:editor-body",
              selector: ".ProseMirror",
              children: [
	                { role: "paragraph", name: "第一段：明确结论", uid: "p1", target: "uid:p1" },
	                { role: "paragraph", name: "第二段：证据和注意事项", uid: "p2", target: "uid:p2" },
              ],
            },
	            { role: "button", name: "发布", uid: "btn-publish", target: "uid:btn-publish", selector: "button.publish" },
          ],
        },
      ],
    },
    actions: [
      { target: "uid:editor-body", role: "textbox", name: "正文编辑区", editable: true, inViewport: true },
      { target: "uid:btn-publish", role: "button", name: "发布", inViewport: true },
      { target: "uid:btn-save", role: "button", name: "保存草稿", inViewport: false },
    ],
  };
}

function renderEntries(entries) {
  state.renderedGroups = [];
  const grouped = groupConsecutiveToolTranscriptEntries(entries);
  messagesEl.innerHTML = "";
  for (const entry of grouped) {
    if (entry.type === "assistant" && messagesEl.lastElementChild?.classList.contains("msg-tool-timeline")) {
      messagesEl.appendChild(sectionLabel("assistant response"));
    }
    const el = renderTranscriptEntry(entry);
    if (el) messagesEl.appendChild(el);
  }
}

function parseConversationFlow(text) {
  const value = parseJson(text, "conversation flow");
  if (Array.isArray(value)) return { title: "自定义对话流", entries: value };
  if (value && typeof value === "object" && Array.isArray(value.entries)) {
    return { title: value.title || "自定义对话流", entries: value.entries };
  }
  throw new Error("conversation flow 必须是数组，或包含 entries 数组的对象");
}

function parseOperationFlow(text) {
  const value = parseJson(text, "operation flow");
  if (!Array.isArray(value)) throw new Error("operation flow 必须是数组");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 个操作必须是对象`);
    }
    if (!item.action) throw new Error(`第 ${index + 1} 个操作缺少 action`);
    return item;
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch (err) {
    throw new Error(`${label} JSON 解析失败：${err.message}`);
  }
}

function normalizeConversationEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeConversationEntry(entry, index))
    .filter(Boolean);
}

function debugGroupedTranscriptEntries(entries) {
  return groupConsecutiveToolTranscriptEntries(normalizeConversationEntries(entries)).map(entry => ({
    type: entry.type,
    key: entry._uiKey || "",
    entries: Array.isArray(entry.entries)
      ? entry.entries.map(item => ({
          type: item.type,
          key: item._uiKey || "",
          name: item.name || "",
          streaming: Boolean(item.streaming),
          text: item.text || item.content || "",
        }))
      : [],
  }));
}

function debugPluginToolFamilyGrouping() {
  setSkillToolUiCatalog({
    plugins: [
      {
        id: "bilibili-search-assistant",
        displayName: "B站搜索助手",
        category: { id: "research", label: "研究" },
        tools: [
          { name: "bilibili_search__set_query", localName: "set_query", title: "设置B站搜索关键词", familyId: "plugin:research", familyTitle: "研究", script: "scripts/set-query.js" },
          { name: "bilibili_search__extract_results", localName: "extract_results", title: "抽取B站搜索结果", familyId: "plugin:research", familyTitle: "研究", script: "scripts/extract-results.js" },
        ],
      },
      {
        id: "dataset-exporter",
        displayName: "数据导出助手",
        category: { id: "artifact", label: "生成产物" },
        tools: [
          { name: "dataset_exporter__write_csv", localName: "write_csv", title: "写出 CSV", familyId: "plugin:artifact", familyTitle: "生成产物", script: "scripts/write-csv.js" },
        ],
      },
    ],
  });
  renderConversationFlow({
    title: "插件工具聚合",
    entries: [
      user("用 B站搜索助手检索视频并导出结果。", "plugin-u1"),
      tool("bilibili_search__set_query", { keyword: "轻舟 agent" }, { ok: true, keyword: "轻舟 agent" }, "plugin-t1"),
      ...Array.from({ length: 11 }, (_, index) => tool(
        "bilibili_search__extract_results",
        { limit: 20, page: index + 1 },
        { ok: true, rows: [{ title: `视频 ${index + 1}` }] },
        `plugin-t${index + 2}`,
      )),
      tool("dataset_exporter__write_csv", { filename: "bilibili.tsv" }, { ok: true, filename: "bilibili.tsv" }, "plugin-t13"),
    ],
  });
  const timeline = document.querySelector(".msg-tool-timeline");
  timeline?.querySelector(":scope > .tool-timeline-summary")?.click();
  const rows = [...document.querySelectorAll(".tool-family-row")].map(row => ({
    id: row.dataset.toolFamilyId || "",
    text: row.textContent.replace(/\s+/g, " ").trim(),
  }));
  const batches = [...document.querySelectorAll(".tool-family-batch")].map(batch => ({
    id: batch.dataset.toolFamilyId || "",
    text: batch.textContent.replace(/\s+/g, " ").trim(),
  }));
  return {
    timelineCount: document.querySelectorAll(".msg-tool-timeline").length,
    familyRows: rows,
    batches,
    rawStepCount: document.querySelectorAll(".tool-timeline-step").length,
    summaryText: document.querySelector(".msg-tool-timeline .tool-timeline-summary")?.textContent?.replace(/\s+/g, " ").trim() || "",
  };
}

function debugMcpPluginToolFamilyGrouping() {
  setSkillToolUiCatalog({
    plugins: [
      {
        id: "maps-mcp",
        displayName: "地图 MCP",
        tools: [
          { name: "maps_mcp__search_around", localName: "search_around", title: "周边搜索", familyId: "mcp", familyTitle: "MCP", runtime: "mcp" },
          { name: "maps_mcp__reverse_geocode", localName: "reverse_geocode", title: "逆地理编码", familyId: "mcp", familyTitle: "MCP", runtime: "mcp" },
          { name: "maps_mcp__current_date", localName: "current_date", title: "获取当前日期", familyId: "mcp", familyTitle: "MCP", runtime: "mcp" },
        ],
      },
    ],
  });
  renderConversationFlow({
    title: "MCP 插件工具聚合",
    entries: [
      user("调用地图 MCP 查询出行信息。", "mcp-u1"),
      ...Array.from({ length: 5 }, (_, index) => tool(
        "maps_mcp__search_around",
        { keyword: "咖啡", index },
        { ok: true, items: [{ name: `咖啡店 ${index + 1}` }] },
        `mcp-t-search-${index}`,
      )),
      ...Array.from({ length: 4 }, (_, index) => tool(
        "maps_mcp__reverse_geocode",
        { location: `${30 + index},${120 + index}` },
        { ok: true, address: `地址 ${index + 1}` },
        `mcp-t-geo-${index}`,
      )),
      ...Array.from({ length: 4 }, (_, index) => tool(
        "maps_mcp__current_date",
        {},
        { ok: true, date: `2026-07-0${index + 1}` },
        `mcp-t-date-${index}`,
      )),
    ],
  });
  const timeline = document.querySelector(".msg-tool-timeline");
  timeline?.querySelector(":scope > .tool-timeline-summary")?.click();
  const rows = [...document.querySelectorAll(".tool-family-row")].map(row => ({
    id: row.dataset.toolFamilyId || "",
    text: row.textContent.replace(/\s+/g, " ").trim(),
  }));
  return {
    timelineCount: document.querySelectorAll(".msg-tool-timeline").length,
    familyRows: rows,
    summaryText: document.querySelector(".msg-tool-timeline .tool-timeline-summary")?.textContent?.replace(/\s+/g, " ").trim() || "",
  };
}

function debugPatchSingleToolCollapse() {
  const before = sampleToolEvent("run_script", 0);
  const after = {
    ...before,
    args: { code: `${before.args.code}\nreturn { ok: true };` },
    result: { ok: true, message: "页面信息采集完成" },
    isRunning: false,
    phase: "done",
  };
  messagesEl.innerHTML = "";
  const el = renderVisualToolEvent(before);
  messagesEl.appendChild(el);
  const summary = el.querySelector(":scope > .tool-summary");
  const details = el.querySelector(":scope > .tool-details");
  summary?.click();
  patchVisualToolEvent(el, after);
  const collapse = el.querySelector(".tool-event-collapse-btn");
  collapse?.click();
  return {
    hasCollapse: Boolean(collapse),
    hidden: details?.classList.contains("hidden") || false,
    expanded: summary?.getAttribute("aria-expanded") || "",
    rootClass: el.className,
  };
}

async function debugPatchThinkingPreviewScroller() {
  const makeEntry = (text) => ({
    type: "thinking-group",
    entries: [
      {
        type: "thinking",
        _uiKey: "debug-thinking-buffer",
        text,
        streaming: true,
        timestamp: "2026-06-13 10:00:01",
      },
    ],
  });
  messagesEl.innerHTML = "";
  const baseText = "开头标记 " + "中段 ".repeat(26);
  const el = createThinkingTimelineGroupElement(makeEntry(`${baseText}尾部一`));
  messagesEl.appendChild(el);
  await sleep(120);
  const preview = el.querySelector(".thinking-group-preview");
  const track = preview?.querySelector(".thinking-group-preview-track");
  const sameNode = [];
  const sameTrack = [];
  const scrollTrace = [thinkingPreviewVirtualScroll(track)];

  patchThinkingTimelineGroupElement(el, makeEntry(`${baseText}新增内容 尾部二`));
  await sleep(280);
  const secondPreview = el.querySelector(".thinking-group-preview");
  const secondTrack = secondPreview?.querySelector(".thinking-group-preview-track");
  sameNode.push(secondPreview === preview);
  sameTrack.push(secondTrack === track);
  scrollTrace.push(thinkingPreviewVirtualScroll(secondTrack));

  patchThinkingTimelineGroupElement(el, makeEntry(`${baseText}新增内容 更多 尾部三`));
  await sleep(900);
  const thirdPreview = el.querySelector(".thinking-group-preview");
  const thirdTrack = thirdPreview?.querySelector(".thinking-group-preview-track");
  sameNode.push(thirdPreview === preview);
  sameTrack.push(thirdTrack === track);
  scrollTrace.push(thinkingPreviewVirtualScroll(thirdTrack));

  return {
    sameNode,
    sameTrack,
    bufferCount: el.querySelectorAll(".thinking-group-preview-buffer").length,
    trackCount: el.querySelectorAll(".thinking-group-preview-track").length,
    scrollTrace,
    text: thirdPreview?.textContent || "",
  };
}

function debugThinkingOpenSurvivesReplacement() {
  const makeEntry = (text) => ({
    type: "thinking-group",
    _uiKey: "debug-thinking-open-replace-group",
    entries: [
      {
        type: "thinking",
        _uiKey: "debug-thinking-open-replace-thought",
        text,
        streaming: true,
        timestamp: "2026-06-13 10:00:01",
      },
    ],
  });
  const pickState = (el) => {
    const summary = el.querySelector(":scope > .thinking-group-summary");
    const details = el.querySelector(":scope > .thinking-group-details");
    return {
      expanded: summary?.getAttribute("aria-expanded") === "true" && !details?.classList.contains("hidden"),
      userToggled: details?.dataset.userToggled === "true",
      body: el.querySelector(".thinking-group-body")?.textContent || "",
      rootClass: el.className,
    };
  };

  messagesEl.innerHTML = "";
  const first = createThinkingTimelineGroupElement(makeEntry("用户刚点开的思考内容"));
  messagesEl.appendChild(first);
  first.querySelector(":scope > .thinking-group-summary")?.click();
  const afterClick = pickState(first);

  const replacement = createThinkingTimelineGroupElement(makeEntry("节点重建后的 streaming 内容"));
  first.replaceWith(replacement);
  const afterReplace = pickState(replacement);

  patchThinkingTimelineGroupElement(replacement, makeEntry("patch 更新后的 streaming 内容"));
  const afterPatch = pickState(replacement);
  return { afterClick, afterReplace, afterPatch };
}

function debugMotionAndViewState() {
  const singleRunning = {
    ...sampleToolEvent("run_script", 0),
    result: null,
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  };
  const singleDone = {
    ...singleRunning,
    result: { ok: true, rows: rows.slice(0, 2), message: "done" },
    isRunning: false,
    argsIncomplete: false,
    phase: "",
    endedAt: "2026-06-13 10:00:18",
  };
  const singleSettleEl = renderVisualToolEvent(singleRunning);
  patchVisualToolEvent(singleSettleEl, singleDone);

  const singleRawBefore = sampleToolEvent("run_script", 0);
  const singleRawAfter = {
    ...singleRawBefore,
    result: { ok: true, rows: rows.slice(0, 3), message: "patched raw result" },
  };
  const singleRawEl = renderVisualToolEvent(singleRawBefore);
  singleRawEl.querySelector(":scope > .tool-summary")?.click();
  singleRawEl.querySelector(".tool-event-raw-btn:not(.hidden)")?.click();
  patchVisualToolEvent(singleRawEl, singleRawAfter);

  const timelineRunningEntry = {
    type: "tool-group",
    entries: [
      tool("open_tab", { url: "https://example.com/start" }, { title: "Start", url: "https://example.com/start" }, "motion-t1"),
      {
        ...tool("run_script", { code: "return rows;" }, null, "motion-t2"),
        isRunning: true,
        argsIncomplete: true,
        phase: "preparing",
      },
    ],
  };
  const timelineDoneEntry = {
    ...timelineRunningEntry,
    entries: timelineRunningEntry.entries.map(entry => entry.toolCallId === "motion-t2"
      ? {
          ...entry,
          isRunning: false,
          argsIncomplete: false,
          phase: "",
          endedAt: "2026-06-13 10:00:18",
          result: { ok: true, result: rows.slice(0, 2), patched: true },
        }
      : entry),
  };
  const timelineSettleEl = createVisualToolTimelineGroupElement(timelineRunningEntry);
  patchVisualToolTimelineGroupElement(timelineSettleEl, timelineDoneEntry);

  const timelineRawEntry = {
    type: "tool-group",
    entries: [
      tool("open_tab", { url: "https://example.com/a" }, { title: "页面 A", url: "https://example.com/a" }, "raw-t1"),
      sampleToolEvent("run_script", 1),
    ],
  };
  timelineRawEntry.entries[1]._uiKey = "raw-t2";
  timelineRawEntry.entries[1].toolCallId = "raw-t2";
  const timelineRawAfter = {
    ...timelineRawEntry,
    entries: timelineRawEntry.entries.map(entry => entry.toolCallId === "raw-t2"
      ? { ...entry, result: { ok: true, result: rows.slice(0, 4), patched: true } }
      : entry),
  };
  visualToolPresentationState.update(VISUAL_PRESENTATION_SESSION_ID, timelineRawEntry, {
    userToggled: true,
    expanded: true,
    activeToolKey: "raw-t2",
  });
  const timelineRawEl = createVisualToolTimelineGroupElement(
    timelineRawEntry,
  );
  timelineRawEl.querySelector(".tool-timeline-raw-btn:not(.hidden)")?.click();
  patchVisualToolTimelineGroupElement(
    timelineRawEl,
    timelineRawAfter,
  );

  const thinkingBefore = {
    type: "thinking-group",
    entries: [
      thinking("已经完成的上一段思考。", "motion-th1"),
    ],
  };
  const thinkingAfter = {
    ...thinkingBefore,
    entries: [
      ...thinkingBefore.entries,
      thinking("新的 thinking 刚开始，应该轻触发左边缘。", "motion-th2", { streaming: true }),
    ],
  };
  const thinkingEl = createThinkingTimelineGroupElement(thinkingBefore);
  patchThinkingTimelineGroupElement(thinkingEl, thinkingAfter);
  const thinkingSummary = thinkingEl.querySelector(":scope > .thinking-group-summary");
  patchThinkingTimelineGroupElement(thinkingEl, {
    ...thinkingAfter,
    entries: thinkingAfter.entries.map(entry => entry._uiKey === "motion-th2"
      ? { ...entry, text: `${entry.text} 持续补充内容。` }
      : entry),
  });

  const singleRawPanel = singleRawEl.querySelector(".tool-event-raw-panel");
  const timelineRawPanel = timelineRawEl.querySelector(".tool-timeline-raw-panel");
  return {
    singleSettleClass: singleSettleEl.querySelector(":scope > .tool-summary")?.classList.contains("tool-summary-settled") || false,
    timelineSettleClass: timelineSettleEl.querySelector(":scope > .tool-timeline-summary")?.classList.contains("tool-summary-settled") || false,
    singleRawOpenAfterPatch: Boolean(singleRawPanel && !singleRawPanel.classList.contains("hidden")),
    singleRawButtonExpanded: singleRawEl.querySelector(".tool-event-raw-btn")?.getAttribute("aria-expanded") || "",
    timelineRawOpenAfterPatch: Boolean(timelineRawPanel && !timelineRawPanel.classList.contains("hidden")),
    timelineRawButtonExpanded: timelineRawEl.querySelector(".tool-timeline-raw-btn")?.getAttribute("aria-expanded") || "",
    thinkingFreshClass: thinkingSummary?.classList.contains("thinking-group-summary-fresh") || false,
    thinkingTitle: thinkingSummary?.textContent?.trim() || "",
  };
}

async function debugChipheadToggleScrollStability(options = {}) {
  const cycles = Math.max(2, Math.round(Number(options.cycles) || 8));
  const targetOffset = 96;
  messagesEl.classList.add("visual-collapsible-motion-test");
  Object.assign(messagesEl.style, {
    height: "420px",
    minHeight: "0",
    overflowX: "hidden",
    overflowY: "auto",
    padding: "14px 12px 18px",
  });
  messagesEl.scrollIntoView({ block: "center", inline: "nearest" });
  await nextAnimationFrame();

  const scrollFeature = createChatScrollFeature({
    messagesEl,
    isActive: () => true,
    findTranscriptElement: () => null,
  });
  scrollFeature.setFollowing(false);
  scrollFeature.cancelScheduledScroll();

  const cases = [
    {
      id: "tool",
      summarySelector: ":scope > .tool-summary",
      create: () => renderVisualToolEvent(sampleToolEvent("run_script", 801)),
    },
    {
      id: "timeline",
      summarySelector: ":scope > .tool-timeline-summary",
      create: () => createVisualToolTimelineGroupElement({
        type: "tool-group",
        _uiKey: "chiphead-scroll-timeline",
        runId: "chiphead-scroll-run",
        entries: [
          sampleToolEvent("open_tab", 802),
          sampleToolEvent("run_script", 803),
          sampleToolEvent("data_store", 804),
        ],
      }),
    },
    {
      id: "thinking",
      summarySelector: ":scope > .thinking-group-summary",
      create: () => createThinkingTimelineGroupElement({
        type: "thinking-group",
        _uiKey: "chiphead-scroll-thinking",
        runId: "chiphead-scroll-run",
        entries: [
          thinking(longArticleText(10), "chiphead-thinking-1"),
          thinking(longArticleText(11), "chiphead-thinking-2"),
        ],
      }),
    },
  ];

  const results = [];
  for (const item of cases) {
    const topSpacer = document.createElement("div");
    const tailSpacer = document.createElement("div");
    topSpacer.style.height = "520px";
    tailSpacer.style.height = "520px";
    const card = item.create();
    messagesEl.replaceChildren(topSpacer, card, tailSpacer);
    await sleep(260);

    const summary = card.querySelector(item.summarySelector);
    messagesEl.scrollTop = 0;
    await nextAnimationFrame();
    const messagesTop = messagesEl.getBoundingClientRect().top;
    messagesEl.scrollTop = Math.max(0, summary.getBoundingClientRect().top - messagesTop - targetOffset);
    scrollFeature.syncScrollPosition();
    await nextAnimationFrame();

    const baselineTop = summary.getBoundingClientRect().top;
    const baselineScrollTop = messagesEl.scrollTop;
    const baselineFlowTop = topSpacer.getBoundingClientRect().top;
    const samples = [];
    for (let index = 0; index < cycles; index += 1) {
      summary.click();
      await Promise.resolve();
      await nextAnimationFrame();
      const frameTop = summary.getBoundingClientRect().top;
      const frameFlowTop = topSpacer.getBoundingClientRect().top;
      await sleep(220);
      const settledTop = summary.getBoundingClientRect().top;
      const settledFlowTop = topSpacer.getBoundingClientRect().top;
      const cardStyle = getComputedStyle(card);
      const summaryStyle = getComputedStyle(summary);
      samples.push({
        index,
        expanded: summary.getAttribute("aria-expanded") === "true",
        frameDrift: frameTop - baselineTop,
        settledDrift: settledTop - baselineTop,
        frameFlowDrift: frameFlowTop - baselineFlowTop,
        settledFlowDrift: settledFlowTop - baselineFlowTop,
        scrollTop: messagesEl.scrollTop,
        scrollDrift: messagesEl.scrollTop - baselineScrollTop,
        cardBorderTopWidth: Number.parseFloat(cardStyle.borderTopWidth) || 0,
        cardBoxShadow: cardStyle.boxShadow,
        summaryBorderBottomWidth: Number.parseFloat(summaryStyle.borderBottomWidth) || 0,
        summaryBoxShadow: summaryStyle.boxShadow,
        cardTopLeftRadius: cardStyle.borderTopLeftRadius,
        cardTopRightRadius: cardStyle.borderTopRightRadius,
        summaryTopLeftRadius: summaryStyle.borderTopLeftRadius,
        summaryTopRightRadius: summaryStyle.borderTopRightRadius,
      });
    }

    results.push({
      id: item.id,
      cycles,
      baselineTop,
      baselineScrollTop,
      baselineFlowTop,
      endTopDrift: summary.getBoundingClientRect().top - baselineTop,
      endScrollDrift: messagesEl.scrollTop - baselineScrollTop,
      maxFrameDrift: Math.max(...samples.map(sample => Math.abs(sample.frameDrift))),
      maxSettledDrift: Math.max(...samples.map(sample => Math.abs(sample.settledDrift))),
      maxFrameFlowDrift: Math.max(...samples.map(sample => Math.abs(sample.frameFlowDrift))),
      maxSettledFlowDrift: Math.max(...samples.map(sample => Math.abs(sample.settledFlowDrift))),
      maxScrollDrift: Math.max(...samples.map(sample => Math.abs(sample.scrollDrift))),
      samples,
    });
  }
  return results;
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function thinkingPreviewVirtualScroll(track) {
  const textEl = track?.querySelector(".thinking-group-preview-text");
  const rawOffset = textEl?.style?.getPropertyValue("--thinking-preview-offset") || "0";
  const offset = Number.parseFloat(rawOffset);
  const left = Math.max(0, -(Number.isFinite(offset) ? offset : 0));
  const max = Math.max(0, (textEl?.scrollWidth || track?.scrollWidth || 0) - (track?.clientWidth || 0));
  return {
    left: Math.round(left),
    max: Math.round(max),
    tailDistance: Math.round(Math.max(0, max - left)),
  };
}

function debugToolVariantCase(name, variant = "empty-result") {
  const base = sampleToolEvent(name, 0);
  const event = {
    ...base,
    _uiKey: `edge-${variant}-${name}`,
    toolCallId: `edge-${variant}-${name}`,
    endedAt: "2026-06-13 10:00:10",
  };
  if (variant === "empty-result") {
    event.result = null;
    event.isRunning = false;
    event.isError = false;
    event.phase = "done";
  } else if (variant === "error-result") {
    event.result = {
      code: "edge-case-error",
      message: `${getToolDisplayName(name)} edge case failure`,
      retryable: false,
    };
    event.isRunning = false;
    event.isError = true;
    event.phase = "error";
  } else if (variant === "running") {
    event.result = null;
    event.isRunning = true;
    event.isError = false;
    event.phase = "preparing";
    event.endedAt = "";
  }

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.dataset.toolName = name;
  host.style.width = "420px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(event);
  host.appendChild(el);
  messagesEl.appendChild(host);

  const summary = el.querySelector(":scope > .tool-summary");
  const details = el.querySelector(":scope > .tool-details");
  summary?.click();
  const rawButton = el.querySelector(".tool-event-raw-btn:not(.hidden)");
  if (rawButton) rawButton.click();
  const rawPanel = el.querySelector(".tool-event-raw-panel");
  const rawPre = rawPanel?.querySelector(".copyable-code-block pre");
  const rootRect = el.getBoundingClientRect();
  const summaryRect = summary?.getBoundingClientRect();
  const footerItems = [...el.querySelectorAll(".tool-event-raw-btn:not(.hidden), .tool-event-collapse-btn")];
  const footerHeights = footerItems.map(item => Math.round(item.getBoundingClientRect().height));
  const rawMetrics = rawPre ? {
    clientHeight: rawPre.clientHeight,
    scrollHeight: rawPre.scrollHeight,
    overflowY: getComputedStyle(rawPre).overflowY,
    overscrollBehaviorY: getComputedStyle(rawPre).overscrollBehaviorY,
  } : null;

  return {
    name,
    variant,
    hasRoot: Boolean(el),
    hasSummary: Boolean(summary),
    summaryText: summary?.textContent?.trim() || "",
    hasDetails: Boolean(details),
    detailsOpen: Boolean(details && !details.classList.contains("hidden")),
    rootExpanded: el.classList.contains("tool-expanded"),
    rawButtonVisible: Boolean(rawButton),
    rawPanelOpen: rawButton ? Boolean(rawPanel && !rawPanel.classList.contains("hidden")) : true,
    rawMetrics,
    footerHeights,
    summaryHeight: Math.round(summaryRect?.height || 0),
    rootWidth: Math.round(rootRect.width || 0),
    hostWidth: Math.round(host.getBoundingClientRect().width || 0),
    hasHorizontalOverflow: el.scrollWidth > el.clientWidth + 1 || host.scrollWidth > host.clientWidth + 1,
    hasErrorText: el.textContent.includes("edge-case-error") || el.textContent.includes("edge case failure"),
  };
}

function debugToolSummaryText(toolEvent) {
  const event = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-summary-tool",
    toolCallId: "debug-summary-tool",
    runId: "debug-summary-run",
    ...(toolEvent || {}),
  }, 0);
  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  const el = renderVisualToolEvent(event);
  host.appendChild(el);
  messagesEl.appendChild(host);
  return el.querySelector(":scope > .tool-summary")?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function debugNetworkBodyTypeState() {
  const makeEvent = (bodyType, body) => normalizeConversationEntry({
    type: "tool",
    _uiKey: `debug-network-body-${bodyType}`,
    toolCallId: `debug-network-body-${bodyType}`,
    runId: "debug-network-body-run",
    name: "network_body",
    args: { requestId: "req_direction", bodyType },
    result: {
      requestId: "req_direction",
      bodyType,
      method: "POST",
      url: "https://example.com/api/search",
      status: 200,
      requestContentType: "application/json",
      mimeType: "application/json",
      size: body.length,
      truncated: false,
      body,
    },
  }, 0);
  const render = event => {
    const el = renderVisualToolEvent(event, { expanded: true });
    return el.textContent?.replace(/\s+/g, " ").trim() || "";
  };

  return {
    requestText: render(makeEvent("request", JSON.stringify({ query: "轻舟工具" }, null, 2))),
    responseText: render(makeEvent("response", JSON.stringify({ ok: true }, null, 2))),
  };
}

async function debugSaveFileContentScrollState() {
  const first = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-save-file-tool",
    toolCallId: "debug-save-file-tool",
    runId: "debug-save-file-run",
    name: "save_file",
    args: { filename: "stream.html", content: longSaveFileContent(34, "初始") },
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  }, 0);
  const second = {
    ...first,
    args: { filename: "stream.html", content: longSaveFileContent(96, "追尾") },
  };
  const third = {
    ...first,
    args: { filename: "stream.html", content: longSaveFileContent(128, "用户上滑") },
  };

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.style.width = "520px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(first);
  host.appendChild(el);
  messagesEl.appendChild(host);
  el.querySelector(":scope > .tool-summary")?.click();
  await sleep(50);

  let pre = el.querySelector(".tool-file-content-block");
  if (!pre) return { hasBlock: false };
  pre.scrollTop = pre.scrollHeight;
  pre.dataset.followTail = "true";
  patchVisualToolEvent(el, second);
  await sleep(80);
  pre = el.querySelector(".tool-file-content-block");
  const followsTail = isNearElementTail(pre, 3);
  const cappedHeight = pre.clientHeight <= 380;
  const scrollable = pre.scrollHeight > pre.clientHeight + 8;
  const overflowY = getComputedStyle(pre).overflowY;

  pre.scrollTop = 0;
  pre.dataset.followTail = "false";
  patchVisualToolEvent(el, third);
  await sleep(80);
  pre = el.querySelector(".tool-file-content-block");
  const staysAfterUserScrollUp = pre.scrollTop <= 3;

  return {
    hasBlock: true,
    followsTail,
    staysAfterUserScrollUp,
    cappedHeight,
    scrollable,
    overflowY,
    clientHeight: pre.clientHeight,
    scrollHeight: pre.scrollHeight,
    copyTextLength: pre.closest(".copyable-code-block")?.dataset.copyText?.length || 0,
  };
}

async function debugCreateSkillContentScrollState() {
  const first = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-create-skill-tool",
    toolCallId: "debug-create-skill-tool",
    runId: "debug-create-skill-run",
    name: "create_skill",
    args: { name: "publish-check", content: longSkillContent(34, "初始") },
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  }, 0);
  const second = {
    ...first,
    args: { name: "publish-check", content: longSkillContent(96, "追尾") },
  };
  const third = {
    ...first,
    args: { name: "publish-check", content: longSkillContent(128, "用户上滑") },
  };

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.style.width = "520px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(first);
  host.appendChild(el);
  messagesEl.appendChild(host);
  el.querySelector(":scope > .tool-summary")?.click();
  await sleep(50);

  let preview = el.querySelector(".tool-skill-content-preview");
  if (!preview) return { hasBlock: false };
  preview.scrollTop = preview.scrollHeight;
  preview.dataset.followTail = "true";
  patchVisualToolEvent(el, second);
  await sleep(80);
  preview = el.querySelector(".tool-skill-content-preview");
  const followsTail = isNearElementTail(preview, 3);
  const cappedHeight = preview.clientHeight <= 380;
  const scrollable = preview.scrollHeight > preview.clientHeight + 8;
  const overflowY = getComputedStyle(preview).overflowY;

  preview.scrollTop = 0;
  preview.dataset.followTail = "false";
  patchVisualToolEvent(el, third);
  await sleep(80);
  preview = el.querySelector(".tool-skill-content-preview");
  const staysAfterUserScrollUp = preview.scrollTop <= 3;

  return {
    hasBlock: true,
    followsTail,
    staysAfterUserScrollUp,
    cappedHeight,
    scrollable,
    overflowY,
    clientHeight: preview.clientHeight,
    scrollHeight: preview.scrollHeight,
  };
}

async function debugUpdateSkillDiffScrollState() {
  const first = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-update-skill-tool",
    toolCallId: "debug-update-skill-tool",
    runId: "debug-update-skill-run",
    name: "update_skill",
    args: { name: "publish-check", appendContent: longSkillContent(42, "初始") },
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  }, 0);
  const second = {
    ...first,
    args: { name: "publish-check", appendContent: longSkillContent(110, "追尾") },
  };
  const third = {
    ...first,
    args: { name: "publish-check", appendContent: longSkillContent(140, "用户上滑") },
  };

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.style.width = "520px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(first);
  host.appendChild(el);
  messagesEl.appendChild(host);
  el.querySelector(":scope > .tool-summary")?.click();
  await sleep(50);

  let block = el.querySelector(".tool-diff-block");
  if (!block) return { hasBlock: false };
  block.scrollTop = block.scrollHeight;
  block.dataset.followTail = "true";
  patchVisualToolEvent(el, second);
  await sleep(80);
  block = el.querySelector(".tool-diff-block");
  const followsTail = isNearElementTail(block, 3);
  const cappedHeight = block.clientHeight <= 260;
  const scrollable = block.scrollHeight > block.clientHeight + 8;
  const overflowY = getComputedStyle(block).overflowY;

  block.scrollTop = 0;
  block.dataset.followTail = "false";
  patchVisualToolEvent(el, third);
  await sleep(80);
  block = el.querySelector(".tool-diff-block");
  const staysAfterUserScrollUp = block.scrollTop <= 3;

  return {
    hasBlock: true,
    followsTail,
    staysAfterUserScrollUp,
    cappedHeight,
    scrollable,
    overflowY,
    clientHeight: block.clientHeight,
    scrollHeight: block.scrollHeight,
  };
}

async function debugNestedScrollOwnershipState() {
  const event = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-nested-scroll-tool",
    toolCallId: "debug-nested-scroll-tool",
    runId: "debug-nested-scroll-run",
    name: "create_skill",
    args: { name: "publish-check", content: longSkillContent(96, "滚动仲裁") },
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  }, 0);

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.style.width = "520px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(event);
  host.appendChild(el);
  messagesEl.appendChild(host);
  el.querySelector(":scope > .tool-summary")?.click();
  await sleep(50);

  const preview = el.querySelector(".tool-skill-content-preview");
  const outsidePreview = el.querySelector(".tool-compact-line") || el;
  if (!preview) return { hasBlock: false };

  preview.scrollTop = 0;
  setFollowTail(preview, true);
  const innerOwner = resolveWheelScrollOwner(preview, 80, {
    boundary: messagesEl,
    innerSelector: INNER_SCROLL_TARGET_SELECTOR,
  });

  setFollowTail(preview, true);
  pauseDescendantTailTargets(host, { selector: INNER_SCROLL_TARGET_SELECTOR });
  const outerPausedInner = preview.dataset.followTail === "false"
    && preview.dataset.userPinned === "true";

  setFollowTail(preview, true);
  preview.scrollTop = 0;
  const boundaryOwner = resolveWheelScrollOwner(preview, -80, {
    boundary: messagesEl,
    innerSelector: INNER_SCROLL_TARGET_SELECTOR,
  });
  const outerOwner = resolveWheelScrollOwner(outsidePreview, -80, {
    boundary: messagesEl,
    innerSelector: INNER_SCROLL_TARGET_SELECTOR,
  });

  return {
    hasBlock: true,
    innerConsumesWheel: innerOwner.owner === preview && innerOwner.ownerIsInner,
    outerPausedInner,
    boundaryReleasesInner: !boundaryOwner.ownerIsInner,
    outsideDoesNotChooseInner: !outerOwner.ownerIsInner,
    scrollable: preview.scrollHeight > preview.clientHeight + 8,
  };
}

async function debugEditSkillResourceContentScrollState() {
  const first = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-edit-skill-resource-tool",
    toolCallId: "debug-edit-skill-resource-tool",
    runId: "debug-edit-skill-resource-run",
    name: "edit_skill_resource",
    args: {
      name: "css-vibe-check",
      path: "scripts/extract-tokens.js",
      action: "set",
      type: "script",
      title: "CSS Token 提取脚本",
      content: longResourceScript(20, "初始"),
    },
    isRunning: true,
    argsIncomplete: true,
    phase: "preparing",
  }, 0);
  const second = {
    ...first,
    args: {
      ...first.args,
      content: longResourceScript(160, "增长"),
    },
  };

  messagesEl.innerHTML = "";
  const host = document.createElement("div");
  host.className = "visual-tool-component";
  host.style.width = "520px";
  host.style.maxWidth = "100%";
  const el = renderVisualToolEvent(first);
  host.appendChild(el);
  messagesEl.appendChild(host);
  el.querySelector(":scope > .tool-summary")?.click();
  await sleep(50);

  let details = el.querySelector(".tool-details");
  let block = el.querySelector(".tool-skill-resource-code");
  if (!details || !block) return { hasBlock: false };
  const beforeRootTop = details.scrollTop;
  const beforeBlockHeight = Math.round(block.getBoundingClientRect().height);

  patchVisualToolEvent(el, second);
  await sleep(80);

  details = el.querySelector(".tool-details");
  block = el.querySelector(".tool-skill-resource-code");
  const style = getComputedStyle(details);
  const blockStyle = getComputedStyle(block);
  const afterBlockHeight = Math.round(block.getBoundingClientRect().height);
  const resourceText = el.textContent || "";

  return {
    hasBlock: true,
    rootScrollTopStable: beforeRootTop <= 1 && details.scrollTop <= 1,
    rootOverflowVisible: style.overflowY === "visible",
    rootNotInternallyCapped: details.scrollHeight <= details.clientHeight + 2 || style.overflowY === "visible",
    blockHeightStable: Math.abs(afterBlockHeight - beforeBlockHeight) <= 1,
    blockScrollable: block.scrollHeight > block.clientHeight + 8,
    blockOverflowScroll: blockStyle.overflowY === "auto" || blockStyle.overflowY === "scroll",
    resourcePathVisible: resourceText.includes("scripts/extract-tokens.js"),
  };
}

function debugTimelineSkillResourceCodeScrollState() {
  const open = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-timeline-resource-open",
    toolCallId: "debug-timeline-resource-open",
    runId: "debug-timeline-resource-run",
    name: "open_tab",
    args: { url: "https://news.ycombinator.com/user?id=pg" },
    result: { title: "Hacker News User", url: "https://news.ycombinator.com/user?id=pg" },
  }, 0);
  const edit = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-timeline-resource-edit",
    toolCallId: "debug-timeline-resource-edit",
    runId: "debug-timeline-resource-run",
    name: "edit_skill_resource",
    args: {
      name: "hacker-news-tools",
      path: "scripts/get-user.js",
      action: "set",
      type: "script",
      content: longResourceScript(180, "时间线资源代码"),
    },
    result: {
      updated: true,
      name: "hacker-news-tools",
      path: "scripts/get-user.js",
      type: "script",
      size: longResourceScript(180, "时间线资源代码").length,
    },
  }, 1);
  const group = {
    type: "tool-group",
    _uiKey: "debug-timeline-resource-group",
    entries: [open, edit],
    runId: "debug-timeline-resource-run",
  };

  messagesEl.innerHTML = "";
  const el = createVisualToolTimelineGroupElement(group, {
    expanded: true,
    activeToolKey: edit._uiKey,
  });
  messagesEl.appendChild(el);
  const block = el.querySelector(".tool-timeline-slot-body .tool-skill-resource-code");
  if (!block) return { hasBlock: false };
  const style = getComputedStyle(block);
  return {
    hasBlock: true,
    slotBodyClasses: el.querySelector(".tool-timeline-slot-body")?.className || "",
    clientHeight: block.clientHeight,
    scrollHeight: block.scrollHeight,
    cappedHeight: block.clientHeight <= 430,
    scrollable: block.scrollHeight > block.clientHeight + 8,
    overflowY: style.overflowY,
    pathVisible: (el.textContent || "").includes("scripts/get-user.js"),
  };
}

async function debugTimelineEditSkillStreamingTailState() {
  const runId = "debug-timeline-edit-stream-run";
  const open = normalizeConversationEntry({
    type: "tool",
    _uiKey: "debug-timeline-edit-stream-open",
    toolCallId: "debug-timeline-edit-stream-open",
    runId,
    name: "open_tab",
    args: { url: "https://example.com/skills/editor" },
    result: { title: "Skill editor", url: "https://example.com/skills/editor" },
  }, 0);
  const makeEdit = (lineCount, marker) => {
    const args = {
      name: "stream-edit",
      path: "scripts/stream.js",
      action: "replace",
      oldText: longResourceScript(24, "旧内容"),
      newText: longResourceScript(lineCount, marker),
    };
    return normalizeConversationEntry({
      type: "tool",
      _uiKey: "debug-timeline-edit-stream-tool",
      toolCallId: "debug-timeline-edit-stream-tool",
      runId,
      name: "edit_skill_resource",
      args: {},
      argsText: JSON.stringify(args).slice(0, -2),
      argsIncomplete: true,
      phase: "preparing",
      isRunning: true,
    }, 1);
  };
  const makeGroup = edit => ({
    type: "tool-group",
    _uiKey: "debug-timeline-edit-stream-group",
    entries: [open, edit],
    runId,
  });

  const first = makeEdit(48, "初始流式内容");
  messagesEl.innerHTML = "";
  const el = createVisualToolTimelineGroupElement(makeGroup(first), {
    expanded: true,
    activeToolKey: first._uiKey,
  });
  messagesEl.appendChild(el);
  const details = el.querySelector(":scope > .tool-timeline-details");
  if (details) details.dataset.userToggled = "true";
  await sleep(50);

  let block = el.querySelector(".tool-timeline-slot-body .tool-diff-block");
  if (!block) return { hasBlock: false };
  block.scrollTop = block.scrollHeight;
  setFollowTail(block, true);

  patchVisualToolTimelineGroupElement(el, makeGroup(makeEdit(110, "继续流式内容")));
  await sleep(80);
  block = el.querySelector(".tool-timeline-slot-body .tool-diff-block");
  const followsTail = isNearElementTail(block, 3);
  const scrollable = block.scrollHeight > block.clientHeight + 8;

  block.scrollTop = 0;
  block.dispatchEvent(new Event("scroll"));
  const pinnedAfterUserScroll = block.dataset.followTail === "false"
    && block.dataset.userPinned === "true";
  patchVisualToolTimelineGroupElement(el, makeGroup(makeEdit(150, "用户上滑后的内容")));
  await sleep(80);
  block = el.querySelector(".tool-timeline-slot-body .tool-diff-block");

  return {
    hasBlock: true,
    scrollable,
    followsTail,
    pinnedAfterUserScroll,
    staysAfterUserScrollUp: block.scrollTop <= 3,
    followTail: block.dataset.followTail || "",
    userPinned: block.dataset.userPinned || "",
  };
}

function debugToolTimelineNavPatchStability() {
  const makeTools = (marker) => [
    ...Array.from({ length: 5 }, (_, index) => normalizeConversationEntry({
      type: "tool",
      _uiKey: `nav-stable-open-${index}`,
      toolCallId: `nav-stable-open-${index}`,
      name: "open_tab",
      args: { url: `https://example.com/page-${index}` },
      result: { title: `页面 ${index}`, url: `https://example.com/page-${index}` },
    }, index)),
    ...Array.from({ length: 5 }, (_, index) => normalizeConversationEntry({
      type: "tool",
      _uiKey: `nav-stable-read-${index}`,
      toolCallId: `nav-stable-read-${index}`,
      name: "read_article",
      args: { source: "auto", url: `https://example.com/article-${index}` },
      result: { title: `正文 ${index}`, text: `正文样本 ${index}` },
    }, index + 5)),
    ...Array.from({ length: 2 }, (_, index) => normalizeConversationEntry({
      type: "tool",
      _uiKey: `nav-stable-data-${index}`,
      toolCallId: `nav-stable-data-${index}`,
      name: "data_store",
      args: { table: `rows_${index}`, rows: [{ id: index }] },
      result: { action: "insert", table: `rows_${index}`, totalRows: 1 },
    }, index + 10)),
    normalizeConversationEntry({
      type: "tool",
      _uiKey: "nav-stable-stream",
      toolCallId: "nav-stable-stream",
      name: "run_script",
      args: { code: `return ${JSON.stringify(marker)};` },
      isRunning: true,
      argsIncomplete: true,
      phase: "preparing",
    }, 12),
  ];
  const first = {
    type: "tool-group",
    _uiKey: "nav-stable-group",
    entries: makeTools("first"),
    runId: "nav-stable-run",
  };
  const second = {
    ...first,
    entries: makeTools("second"),
  };

  messagesEl.innerHTML = "";
  const el = createVisualToolTimelineGroupElement(first, { expanded: true });
  messagesEl.appendChild(el);

  const navBefore = el.querySelector(".tool-timeline-nav-area");
  const rowBefore = el.querySelector(".tool-family-row");
  const batchBefore = el.querySelector(".tool-family-panel.active .tool-family-batch");
  const targetRow = Array.from(el.querySelectorAll(".tool-family-row")).find(row => !row.classList.contains("active"));
  const targetFamilyId = targetRow?.dataset.toolFamilyId || "";

  patchVisualToolTimelineGroupElement(el, second);

  const navAfter = el.querySelector(".tool-timeline-nav-area");
  const rowAfter = el.querySelector(".tool-family-row");
  const batchAfter = el.querySelector(".tool-family-panel.active .tool-family-batch");
  targetRow?.click();
  const activePanel = targetFamilyId
    ? el.querySelector(`.tool-family-panel[data-tool-family-id="${cssEscape(targetFamilyId)}"]`)
    : null;

  return {
    hasFamilyRows: el.querySelectorAll(".tool-family-row").length >= 3,
    navSameNode: navBefore === navAfter,
    rowSameNode: rowBefore === rowAfter,
    batchSameNode: batchBefore === batchAfter,
    clickedPreservedRow: Boolean(targetRow?.isConnected),
    targetFamilyActive: Boolean(activePanel?.classList.contains("active")),
    activeToolIndex: Number(el.dataset.activeToolIndex || -1),
  };
}

async function debugToolTimelineStickyChromeCoversTables() {
  const tableRows = Array.from({ length: 28 }, (_, index) => ({
    renderer: `renderer_${index + 1}`,
    label: index % 2 ? "记录卡片" : "表格",
    schema: `{ rows: Array<object>, field_${index + 1}: string, note: "长字段用于触发表格内部滚动与横向滚动" }`,
  }));
  const tools = [
    ...Array.from({ length: 8 }, (_, index) => normalizeConversationEntry({
      type: "tool",
      _uiKey: `sticky-open-${index}`,
      toolCallId: `sticky-open-${index}`,
      name: "open_tab",
      args: { url: `https://example.com/${index}` },
      result: { title: `页面 ${index + 1}`, url: `https://example.com/${index}` },
    }, index)),
    ...Array.from({ length: 4 }, (_, index) => normalizeConversationEntry({
      type: "tool",
      _uiKey: `sticky-script-${index}`,
      toolCallId: `sticky-script-${index}`,
      name: "run_script",
      args: { code: `return ${index};` },
      result: { ok: true, result: index },
    }, index + 8)),
    normalizeConversationEntry({
      type: "tool",
      _uiKey: "sticky-table-tool",
      toolCallId: "sticky-table-tool",
      name: "data_store",
      args: { action: "upsert", table: "renderer_catalog", rows: tableRows },
      result: { table: "renderer_catalog", inserted: 28, updated: 0, totalRows: 28, rows: tableRows },
    }, 12),
  ];
  const group = {
    type: "tool-group",
    _uiKey: "sticky-table-group",
    entries: tools,
    runId: "sticky-table-run",
  };

  messagesEl.innerHTML = "";
  const spacer = document.createElement("div");
  spacer.style.height = "190px";
  spacer.style.flex = "0 0 auto";
  messagesEl.appendChild(spacer);
  const el = createVisualToolTimelineGroupElement(group, {
    expanded: true,
    activeToolKey: "sticky-table-tool",
  });
  messagesEl.appendChild(el);
  const tailSpacer = document.createElement("div");
  tailSpacer.style.height = "520px";
  tailSpacer.style.flex = "0 0 auto";
  messagesEl.appendChild(tailSpacer);

  messagesEl.scrollTop = spacer.offsetHeight + 70;
  await sleep(80);

  const summary = el.querySelector(":scope > .tool-timeline-summary");
  const navArea = el.querySelector(".tool-timeline-nav-area");
  const table = el.querySelector(".tool-data-table");
  const tableWrap = el.querySelector(".tool-data-table-wrap");
  const topElementAt = (node) => {
    const rect = node?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.min(rect.right - 8, rect.left + 52);
    const y = rect.top + Math.max(6, Math.min(rect.height - 6, rect.height / 2));
    return document.elementFromPoint(x, y);
  };
  const summaryTop = topElementAt(summary);
  const navTop = topElementAt(navArea);
  const classPath = (node) => {
    const parts = [];
    let current = node;
    while (current && current !== document.body && parts.length < 4) {
      const classes = current.className && typeof current.className === "string"
        ? `.${current.className.trim().replace(/\s+/g, ".")}`
        : "";
      parts.push(`${current.tagName?.toLowerCase() || "node"}${classes}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };

  return {
    hasTable: Boolean(table),
    summaryTopInsideSummary: Boolean(summary && summaryTop && summary.contains(summaryTop)),
    navTopInsideNav: Boolean(navArea && navTop && navArea.contains(navTop)),
    summaryTopIsTable: Boolean(summaryTop?.closest?.(".tool-data-table")),
    navTopIsTable: Boolean(navTop?.closest?.(".tool-data-table")),
    summaryZ: getComputedStyle(summary).zIndex,
    navZ: getComputedStyle(navArea).zIndex,
    tableHeadZ: table ? getComputedStyle(table.querySelector("th")).zIndex : "",
    tableWrapScrollable: Boolean(tableWrap && tableWrap.scrollHeight > tableWrap.clientHeight + 8),
    summaryTopPath: classPath(summaryTop),
    navTopPath: classPath(navTop),
  };
}

function longSaveFileContent(lines = 80, marker = "") {
  const body = Array.from({ length: lines }, (_, index) => {
    return `<section data-line="${index + 1}"><h2>${marker} ${index + 1}</h2><p>保存文件内容滚动测试 ${index + 1}，长内容不应该撑开整个工具卡片。</p></section>`;
  }).join("\n");
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>${marker || "保存文件"}</title></head>\n<body>\n${body}\n</body>\n</html>`;
}

function longSkillContent(lines = 80, marker = "") {
  return Array.from({ length: lines }, (_, index) => {
    return `- ${marker} skill 内容行 ${index + 1}：保存或更新时应在预览区内部滚动，并在用户上滑后停止追尾。`;
  }).join("\n");
}

function longResourceScript(lines = 80, marker = "") {
  return [
    "async () => {",
    `  // ${marker}: Keep the outer tool panel stable while the resource script is collapsed.`,
    ...Array.from({ length: lines }, (_, index) => `  function step${index + 1}() { return ${index + 1}; }`),
    "  return { ok: true };",
    "}",
  ].join("\n");
}

function isNearElementTail(el, threshold = 4) {
  if (!el) return false;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function normalizeConversationEntry(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const type = String(entry.type || "").trim();
  const key = entry._uiKey || entry.id || entry.toolCallId || `${type || "entry"}-${index + 1}`;
  if (type === "user") {
    return {
      type,
      _uiKey: key,
      text: entry.text ?? entry.content ?? entry.message ?? "",
      timestamp: entry.timestamp || "2026-06-13 10:00:00",
    };
  }
  if (type === "assistant") {
    return {
      type,
      _uiKey: key,
      content: entry.content ?? entry.text ?? entry.message ?? "",
      timestamp: entry.timestamp || "2026-06-13 10:00:01",
    };
  }
  if (type === "thinking") {
    return {
      type,
      _uiKey: key,
      text: entry.text ?? entry.content ?? entry.message ?? "",
      streaming: Boolean(entry.streaming),
      phase: entry.phase || "",
      status: entry.status || "",
      isError: Boolean(entry.isError),
      runId: entry.runId || "visual-custom-run",
      timestamp: entry.timestamp || "2026-06-13 10:00:01",
      endedAt: entry.endedAt || (entry.streaming ? "" : "2026-06-13 10:00:04"),
    };
  }
  if (type === "tool") {
    return {
      type,
      _uiKey: key,
      toolCallId: entry.toolCallId || key,
      runId: entry.runId || "visual-custom-run",
      name: entry.name || entry.toolName || "tool",
      args: entry.args ?? {},
      argsText: entry.argsText || "",
      argsIncomplete: Boolean(entry.argsIncomplete),
      phase: entry.phase || "",
      result: Object.prototype.hasOwnProperty.call(entry, "result") ? entry.result : null,
      image: entry.image || "",
      isRunning: Boolean(entry.isRunning),
      isError: Boolean(entry.isError),
      timestamp: entry.timestamp || "2026-06-13 10:00:02",
      endedAt: entry.endedAt || (entry.isRunning ? "" : "2026-06-13 10:00:10"),
    };
  }
  if (type === "run-status") {
    const status = entry.status || "aborted";
    return {
      ...entry,
      _uiKey: key,
      type,
      status,
      text: entry.text || (status === "aborted" ? "已取消" : "状态已更新"),
      timestamp: entry.timestamp || "2026-06-13 10:00:05",
    };
  }
  if (type === "wait" || type === "note" || type === "error") {
    return { ...entry, _uiKey: key, type };
  }
  return null;
}

async function runOperationFlow(operations, { status = false, captureFrame = null } = {}) {
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (status) setFlowStatus(`运行 ${index + 1}/${operations.length}: ${operation.label || operation.action}`);
    await runOperation(operation);
    runAssertions();
    if (captureFrame) await captureFrame(operation, index);
    await sleep(Number(operation.delay ?? 220));
  }
}

async function runOperation(operation) {
  const action = String(operation.action || "").trim();
  if (action === "scenario") {
    renderScenario(operation.id || operation.scenario || "mixed");
    return;
  }
  if (action === "allTools") {
    renderAllToolComponents({ expanded: operation.expanded !== false });
    return;
  }
  if (action === "render") {
    renderConversationFlow({
      title: operation.title || "操作流对话",
      entries: operation.entries || [],
    });
    return;
  }
  if (action === "setWidth") {
    setDeviceWidth(operation.width);
    return;
  }
  if (action === "expandAll") {
    setAllTimelineGroupsExpanded(true);
    return;
  }
  if (action === "collapseAll") {
    setAllTimelineGroupsExpanded(false);
    return;
  }
  if (action === "toggleGroup") {
    clickGroupSummary(operation.group ?? 0);
    return;
  }
  if (action === "expandGroup") {
    setGroupExpanded(operation.group ?? 0, true);
    return;
  }
  if (action === "collapseGroup") {
    setGroupExpanded(operation.group ?? 0, false);
    return;
  }
  if (action === "toggleThinking") {
    clickThinkingSummary(operation.group ?? 0);
    return;
  }
  if (action === "expandThinking") {
    setThinkingGroupExpanded(operation.group ?? 0, true);
    return;
  }
  if (action === "collapseThinking") {
    setThinkingGroupExpanded(operation.group ?? 0, false);
    return;
  }
  if (action === "clickThinkingNav") {
    clickThinkingNav(operation.group ?? 0, operation.direction ?? -1);
    return;
  }
  if (action === "clickStep") {
    clickTimelineStep(operation.group ?? 0, operation.step ?? operation.name ?? 0);
    return;
  }
  if (action === "patch") {
    patchTimelineGroup(operation.group ?? 0);
    return;
  }
  if (action === "expandTool") {
    setToolCardExpanded(operation.name, true);
    return;
  }
  if (action === "collapseTool") {
    setToolCardExpanded(operation.name, false);
    return;
  }
  if (action === "toggleTool") {
    clickToolSummary(operation.name);
    return;
  }
  if (action === "clickTreeToggle") {
    clickToolTreeToggle(operation.name, operation.index ?? 0);
    return;
  }
  if (action === "toggleRaw") {
    toggleToolRawDetails(operation.name, operation.index ?? 0);
    return;
  }
  if (action === "clickCopy") {
    clickToolCopyButton(operation.name, operation.index ?? 0);
    return;
  }
  if (action === "wait") {
    await sleep(Number(operation.ms ?? operation.delay ?? 300));
    return;
  }
  throw new Error(`未知操作 action: ${action}`);
}

function setDeviceWidth(width) {
  const value = Number(width) || 420;
  deviceEl.style.setProperty("--visual-width", `${value}px`);
  deviceMetaEl.textContent = `${value}px`;
  document.querySelectorAll("[data-width]").forEach(button => {
    button.classList.toggle("active", Number(button.dataset.width) === value);
  });
}

function getTimelineGroup(index) {
  const groups = Array.from(document.querySelectorAll(".msg-tool-timeline"));
  const group = groups[Number(index) || 0];
  if (!group) throw new Error(`找不到第 ${index} 个时间线组`);
  return group;
}

function clickGroupSummary(groupIndex) {
  const group = getTimelineGroup(groupIndex);
  const details = group.querySelector(":scope > .tool-timeline-details");
  if (details && !details.classList.contains("hidden")) {
    const collapse = group.querySelector(":scope .tool-timeline-collapse-btn");
    if (collapse) {
      collapse.click();
      return;
    }
  }
  const summary = group.querySelector(":scope > .tool-timeline-summary");
  if (!summary) throw new Error(`第 ${groupIndex} 个时间线组没有 summary`);
  summary.click();
}

function setGroupExpanded(groupIndex, expanded) {
  const group = getTimelineGroup(groupIndex);
  const details = group.querySelector(":scope > .tool-timeline-details");
  const summary = group.querySelector(":scope > .tool-timeline-summary");
  if (!details || !summary) throw new Error(`第 ${groupIndex} 个时间线组结构不完整`);
  const isExpanded = !details.classList.contains("hidden");
  if (isExpanded === expanded) return;
  if (!expanded) {
    const collapse = group.querySelector(":scope .tool-timeline-collapse-btn");
    if (collapse) collapse.click();
    else applyTimelineGroupExpanded(group, false);
    return;
  }
  summary.click();
}

function getThinkingGroup(index) {
  const groups = Array.from(document.querySelectorAll(".msg-thinking-group"));
  const group = groups[Number(index) || 0];
  if (!group) throw new Error(`找不到第 ${index} 个思考组`);
  return group;
}

function clickThinkingSummary(groupIndex) {
  const summary = getThinkingGroup(groupIndex).querySelector(":scope > .thinking-group-summary");
  if (!summary) throw new Error(`第 ${groupIndex} 个思考组没有 summary`);
  summary.click();
}

function setThinkingGroupExpanded(groupIndex, expanded) {
  const group = getThinkingGroup(groupIndex);
  const summary = group.querySelector(":scope > .thinking-group-summary");
  const details = group.querySelector(":scope > .thinking-group-details");
  if (!summary || !details) throw new Error(`第 ${groupIndex} 个思考组结构不完整`);
  const isExpanded = !details.classList.contains("hidden");
  if (isExpanded !== expanded) summary.click();
}

function clickThinkingNav(groupIndex, direction = -1) {
  setThinkingGroupExpanded(groupIndex, true);
  const group = getThinkingGroup(groupIndex);
  const button = group.querySelector(`.thinking-group-nav-btn[data-thinking-nav-direction="${Number(direction) < 0 ? "-1" : "1"}"]`);
  if (!button) throw new Error(`第 ${groupIndex} 个思考组没有导航按钮`);
  button.click();
}

function clickTimelineStep(groupIndex, stepRef) {
  setGroupExpanded(groupIndex, true);
  const group = getTimelineGroup(groupIndex);
  const steps = Array.from(group.querySelectorAll(".tool-timeline-step, .tool-family-row, .tool-family-batch"));
  let step = null;
  if (typeof stepRef === "number") {
    step = steps[stepRef];
  } else {
    const needle = String(stepRef || "").trim();
    step = steps.find(item => item.textContent.trim().includes(needle) || item.title === needle);
  }
  if (!step) throw new Error(`找不到时间线组 ${groupIndex} 的步骤 ${stepRef}`);
  step.click();
}

function getToolComponent(name) {
  const card = document.querySelector(`.visual-tool-component[data-tool-name="${cssEscape(name)}"]`);
  if (!card) throw new Error(`找不到工具组件 ${name}`);
  return card;
}

function clickToolSummary(name) {
  const summary = getToolComponent(name).querySelector(".tool-summary");
  if (!summary) throw new Error(`工具组件 ${name} 没有 summary`);
  summary.click();
}

function setToolCardExpanded(name, expanded) {
  const card = getToolComponent(name);
  const summary = card.querySelector(".tool-summary");
  const details = card.querySelector(".tool-details");
  if (!summary || !details) return;
  const isExpanded = !details.classList.contains("hidden");
  if (isExpanded === expanded) return;
  if (!expanded) {
    const collapse = card.querySelector(".tool-event-collapse-btn");
    if (collapse) collapse.click();
    else summary.click();
    return;
  }
  summary.click();
}

function setAllToolCardsExpanded(expanded) {
  document.querySelectorAll(".visual-tool-component").forEach(card => {
    const summary = card.querySelector(".tool-summary");
    const details = card.querySelector(".tool-details");
    if (!summary || !details) return;
    const isExpanded = !details.classList.contains("hidden");
    if (isExpanded === expanded) return;
    if (!expanded) {
      const collapse = card.querySelector(".tool-event-collapse-btn");
      if (collapse) collapse.click();
      else summary.click();
      return;
    }
    summary.click();
  });
}

function clickToolTreeToggle(name, index = 0) {
  setToolCardExpanded(name, true);
  const toggle = getToolComponent(name).querySelectorAll(".tool-tree-toggle")[Number(index) || 0];
  if (!toggle) throw new Error(`工具组件 ${name} 没有 tree toggle`);
  toggle.click();
}

function toggleToolRawDetails(name, index = 0) {
  setToolCardExpanded(name, true);
  const summary = getToolComponent(name).querySelectorAll(".tool-raw-details > summary")[Number(index) || 0];
  if (!summary) throw new Error(`工具组件 ${name} 没有原始数据 details`);
  summary.click();
}

function clickToolCopyButton(name, index = 0) {
  setToolCardExpanded(name, true);
  const button = getToolComponent(name).querySelectorAll(".code-copy-btn")[Number(index) || 0];
  if (!button) throw new Error(`工具组件 ${name} 没有复制按钮`);
  button.click();
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function renderTranscriptEntry(entry) {
  if (entry.type === "user") {
    const div = document.createElement("div");
    div.className = "msg msg-user";
    div.innerHTML = `<div class="msg-content">${escapeHtml(entry.text || "")}</div>`;
    return div;
  }
  if (entry.type === "assistant") {
    const div = document.createElement("div");
    div.className = "msg msg-assistant";
    div.innerHTML = `<div class="msg-content"><p>${escapeHtml(entry.content || "")}</p></div>`;
    return div;
  }
  if (entry.type === "tool") return renderVisualToolEvent(entry);
  if (entry.type === "tool-group") {
    const div = createVisualToolTimelineGroupElement(entry);
    state.renderedGroups.push({ el: div, entry });
    return div;
  }
  if (entry.type === "thinking-group") {
    return createThinkingTimelineGroupElement(entry);
  }
  if (entry.type === "run-status") {
    const div = document.createElement("div");
    div.className = `msg msg-run-status msg-run-status-${String(entry.status || "state").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "state"}`;
    div.innerHTML = `<div class="run-status-badge"></div>`;
    div.querySelector(".run-status-badge").textContent = entry.text || (entry.status === "aborted" ? "已取消" : "状态已更新");
    return div;
  }
  return null;
}

function sectionLabel(text) {
  const div = document.createElement("div");
  div.className = "visual-section-label";
  div.textContent = text;
  return div;
}

function setAllTimelineGroupsExpanded(expanded) {
  document.querySelectorAll(".msg-tool-timeline").forEach(group => {
    applyTimelineGroupExpanded(group, expanded);
  });
  setAllThinkingGroupsExpanded(expanded);
}

function applyTimelineGroupExpanded(group, expanded) {
  const summary = group.querySelector(":scope > .tool-timeline-summary");
  const details = group.querySelector(":scope > .tool-timeline-details");
  if (!summary || !details) return;
  details.dataset.userToggled = "true";
  details.classList.toggle("hidden", !expanded);
  summary.setAttribute("aria-expanded", expanded ? "true" : "false");
  group.classList.toggle("tool-timeline-expanded", Boolean(expanded));
  group.__toolTimelinePresentationOptions?.onPresentationChange?.({
    userToggled: true,
    expanded: Boolean(expanded),
    activeToolKey: details.dataset.activeToolKey || group.dataset.activeToolKey || "",
  });
}

function setAllThinkingGroupsExpanded(expanded) {
  document.querySelectorAll(".msg-thinking-group").forEach(group => {
    const summary = group.querySelector(":scope > .thinking-group-summary");
    const details = group.querySelector(":scope > .thinking-group-details");
    if (!summary || !details) return;
    details.dataset.userToggled = "true";
    details.classList.toggle("hidden", !expanded);
    summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    group.classList.toggle("thinking-group-expanded", Boolean(expanded));
  });
}

function patchFirstTimelineGroup() {
  patchTimelineGroup(0);
}

function patchTimelineGroup(groupIndex = 0) {
  const item = state.renderedGroups[Number(groupIndex) || 0];
  if (!item) return;
  const next = {
    ...item.entry,
    entries: item.entry.entries.map((entry) => {
      if (entry.name === "ask_user") {
        return {
          ...entry,
          isRunning: false,
          phase: "",
          endedAt: "2026-06-13 10:00:18",
          result: { submitted: true, answers: { decision: "approve", note: "测试批准" } },
        };
      }
      if (entry.isRunning || entry.argsIncomplete || entry.phase === "preparing") {
        return {
          ...entry,
          isRunning: false,
          argsIncomplete: false,
          phase: "",
          endedAt: "2026-06-13 10:00:18",
          result: { ok: true, hasResult: true, resultType: "object", result: { patched: true, rows: rows.slice(0, 2) }, engine: "visual-test" },
        };
      }
      return entry;
    }),
  };
  patchVisualToolTimelineGroupElement(item.el, next);
  item.entry = next;
}

function setFlowStatus(message, error = false) {
  flowStatusEl.textContent = message || "";
  flowStatusEl.style.color = error ? "var(--red)" : "var(--text-muted)";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function runAssertions() {
  const timelineGroups = [...document.querySelectorAll(".msg-tool-timeline")];
  const toolComponents = [...document.querySelectorAll(".visual-tool-component")];
  const isComponentMatrix = state.scenarioId === "all-tools";
  const isLongTrace = state.scenarioId === "long";
  const isThinkingTrace = state.scenarioId === "thinking";
  const hasFamilyTrace = Boolean(document.querySelector(".tool-family-trace"));
  const thinkingStateOk = !isThinkingTrace || isThinkingLaneStateConsistent();
  const assertions = [
    [isComponentMatrix ? "全部工具组件已渲染" : "连续工具压缩为时间线", isComponentMatrix ? toolComponents.length === ALL_TOOL_NAMES.length : timelineGroups.length >= 1],
    [isComponentMatrix ? "每个工具都有 summary" : "时间线 summary 无箭头", isComponentMatrix ? toolComponents.every(card => Boolean(card.querySelector(".tool-summary"))) : !document.querySelector(".msg-tool-timeline .tool-caret")],
    [isComponentMatrix ? "组件详情可展开" : isLongTrace ? "长流程水平工具族聚合" : "至少一个 pill 可点击", isComponentMatrix ? Boolean(document.querySelector(".visual-tool-component .tool-details")) : isLongTrace ? hasFamilyTrace && Boolean(document.querySelector(".tool-family-tabs")) && document.querySelectorAll(".tool-family-row").length >= 3 && document.querySelectorAll(".tool-family-panel.active").length === 1 : Boolean(document.querySelector(".tool-timeline-step"))],
    ["展开态直达工具列表", isComponentMatrix || !document.querySelector(".tool-timeline-head")],
    ["原始长步骤入口已移除", !isLongTrace || !document.querySelector(".tool-timeline-raw-audit")],
    ["关键表格直接进入预览", isComponentMatrix || state.scenarioId === "data" || state.scenarioId === "mixed" ? Boolean(document.querySelector(".tool-data-table")) : true],
    ["代码块保留高亮", isComponentMatrix || state.scenarioId === "code" || state.scenarioId === "mixed" ? Boolean(document.querySelector(".code-block .hljs-keyword, .code-block .hljs-title, .code-block .hljs-string, .json-block .hljs-attr")) : true],
    ["思考流进入固定组", !isThinkingTrace || (document.querySelectorAll(".msg-thinking-group").length === 1 && !document.querySelector(".msg-thinking .thinking-card"))],
    ["思考收展状态正确", thinkingStateOk],
    ["文字与上下 chip 间距一致", state.scenarioId !== "mixed" || assistantChipSpacingIsBalanced()],
    ["长流程调用序号按工具分类显示", !isLongTrace || isToolSlotNavFamilyScoped()],
    ["采集正文显示页面标题", !isLongTrace || isReadArticleTargetTitleBased()],
    ["页面工具批次隐藏裸 tabId", !isLongTrace || pageScopedBatchesAvoidTabIds()],
    [isComponentMatrix ? "DOM 树可见" : "等待用户有等待态", isComponentMatrix ? Boolean(document.querySelector(".tool-tree-toggle")) : (state.scenarioId !== "permission" && state.scenarioId !== "mixed" ? true : Boolean(document.querySelector(".tool-timeline-summary-waiting, .tool-timeline-step.waiting")))],
    [isComponentMatrix ? "代码复制按钮可见" : "错误状态可见", isComponentMatrix ? Boolean(document.querySelector(".code-copy-btn")) : (state.scenarioId !== "error" ? true : Boolean(document.querySelector(".tool-timeline-step.error")))],
    ["窄宽无水平页面溢出", document.documentElement.scrollWidth <= window.innerWidth + 1],
  ];
  assertionsEl.innerHTML = assertions.map(([label, pass]) => `
    <div class="visual-assertion ${pass ? "pass" : "fail"}">
      <span class="visual-assertion-dot"></span>
      <span><b>${pass ? "PASS" : "FAIL"}</b> ${escapeHtml(label)}</span>
    </div>
  `).join("");
  debugJsonEl.textContent = JSON.stringify({
    scenario: state.scenarioId,
    timelineGroups: timelineGroups.length,
    thinkingGroups: document.querySelectorAll(".msg-thinking-group").length,
    toolComponents: toolComponents.length,
    familyRows: document.querySelectorAll(".tool-family-row").length,
    activeFamilyPanels: document.querySelectorAll(".tool-family-panel.active").length,
    navButtons: document.querySelectorAll(".tool-timeline-nav-btn").length,
    activeSteps: document.querySelectorAll(".tool-timeline-step.active").length,
    tables: document.querySelectorAll(".tool-data-table").length,
    codeBlocks: document.querySelectorAll(".js-code-block, .json-block").length,
    treeToggles: document.querySelectorAll(".tool-tree-toggle").length,
    copyButtons: document.querySelectorAll(".code-copy-btn").length,
    width: Math.round(deviceEl.getBoundingClientRect().width),
  }, null, 2);
}

function assistantChipSpacingIsBalanced() {
  const fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;left:-10000px;top:0;width:420px;visibility:hidden;";
  fixture.innerHTML = `
    <div class="msg msg-tool"><button class="tool-summary" type="button">tool</button></div>
    <div class="msg msg-assistant"><div class="msg-content"><p>assistant</p></div></div>
    <div class="msg msg-thinking-group"><button class="thinking-group-summary" type="button">thinking</button></div>
  `;
  document.body.appendChild(fixture);
  const [before, assistant, after] = fixture.children;
  const beforeRect = before.getBoundingClientRect();
  const assistantRect = assistant.getBoundingClientRect();
  const afterRect = after.getBoundingClientRect();
  const beforeGap = assistantRect.top - beforeRect.bottom;
  const afterGap = afterRect.top - assistantRect.bottom;
  fixture.remove();
  return Math.abs(beforeGap - afterGap) <= 0.75 && Math.abs(beforeGap - 8) <= 0.75;
}

function isThinkingLaneStateConsistent() {
  const group = document.querySelector(".msg-thinking-group");
  if (!group) return false;
  const summary = group.querySelector(":scope > .thinking-group-summary");
  const details = group.querySelector(":scope > .thinking-group-details");
  const preview = group.querySelector(".thinking-group-preview");
  if (!summary || !details || !preview) return false;
  const expanded = group.classList.contains("thinking-group-expanded");
  const detailsHidden = details.classList.contains("hidden");
  const previewHidden = getComputedStyle(preview).display === "none";
  return expanded
    ? summary.getAttribute("aria-expanded") === "true" && !detailsHidden && previewHidden
    : summary.getAttribute("aria-expanded") === "false" && detailsHidden && !previewHidden;
}

function isToolSlotNavFamilyScoped() {
  const nav = document.querySelector(".tool-timeline-slot-nav span");
  const navText = nav?.textContent?.trim() || "";
  const match = navText.match(/^(\d+)\/(\d+)$/);
  if (!match || nav?.dataset?.positionScope !== "family") return false;
  const activeFamilyId = document.querySelector(".tool-family-row.active")?.dataset?.toolFamilyId || "";
  if (!activeFamilyId) return false;
  const activeFamilyCount = Number(document.querySelector(`.tool-family-row[data-tool-family-id="${cssEscape(activeFamilyId)}"] .tool-family-count`)?.textContent?.trim());
  const current = Number(match[1]);
  const total = Number(match[2]);
  return Number.isFinite(activeFamilyCount)
    && activeFamilyCount > 0
    && total === activeFamilyCount
    && current >= 1
    && current <= total;
}

function isReadArticleTargetTitleBased() {
  const batches = [...document.querySelectorAll('.tool-family-batch[data-tool-family-id="collect"]')]
    .filter(node => node.textContent.includes("采集正文"));
  return batches.length > 0
    && batches.some(node => node.textContent.includes("正文样本"))
    && batches.every(node => !/标签页\s+\d+/.test(node.textContent));
}

function pageScopedBatchesAvoidTabIds() {
  const labels = [
    "新开页面",
    "页面跳转",
    "等待加载",
    "采集正文",
    "读取 HTML",
    "解析页面树",
    "查找元素",
    "操作元素",
    "页面截图",
    "执行脚本",
    "注入样式",
    "修改 DOM",
    "查看 Console",
    "监听网络",
    "查看网络请求",
  ];
  const batches = [...document.querySelectorAll(".tool-family-batch")].filter(node => {
    const text = node.textContent || "";
    return labels.some(label => text.includes(label));
  });
  return batches.length > 0 && batches.every(node => !/标签页\s+\d+/.test(node.textContent || ""));
}

window.visualTimelineTest = {
  allToolNames: () => [...ALL_TOOL_NAMES],
  renderScenario,
  renderAllToolComponents,
  sampleToolEvent,
  renderConversationFlow,
  debugGroupedTranscriptEntries,
  debugPluginToolFamilyGrouping,
  debugMcpPluginToolFamilyGrouping,
  debugToolSummaryText,
  debugNetworkBodyTypeState,
  debugSaveFileContentScrollState,
  debugCreateSkillContentScrollState,
  debugUpdateSkillDiffScrollState,
  debugNestedScrollOwnershipState,
  debugEditSkillResourceContentScrollState,
  debugTimelineSkillResourceCodeScrollState,
  debugTimelineEditSkillStreamingTailState,
  debugToolTimelineNavPatchStability,
  debugToolTimelineStickyChromeCoversTables,
  debugThinkingOpenSurvivesReplacement,
  debugPatchSingleToolCollapse,
  debugPatchThinkingPreviewScroller,
  debugMotionAndViewState,
  debugChipheadToggleScrollStability,
  debugToolVariantCase,
  parseConversationFlow,
  parseOperationFlow,
  runOperationFlow,
  setAllTimelineGroupsExpanded,
  setAllToolCardsExpanded,
  setDeviceWidth,
  clickThinkingNav,
  setThinkingGroupExpanded,
  clickTimelineStep,
  setToolCardExpanded,
  clickToolTreeToggle,
  toggleToolRawDetails,
  clickToolCopyButton,
  runAssertions,
  patchFirstTimelineGroup,
  patchTimelineGroup,
  resetPresentationState: resetVisualToolPresentationState,
};

init();

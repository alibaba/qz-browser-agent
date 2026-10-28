import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Shared model-facing documentation stays out of the panel's UI catalog. */
const messages = defineMessages("tool-runtime", {
  tabRef: {
    "zh-CN": "当前 assistant 消息的 tool_calls 数组中对应 open_tab 的 tabAlias。将 open_tab 和此调用一起发出，open_tab 放在前面；后续消息使用数字 tabId。每次选择 tabRef 或 tabId。",
    en: "The tabAlias of an open_tab in the current assistant message's tool_calls array. Send the opening before this call in the same array. Later messages use numeric tabId. Choose tabRef or tabId.",
  },
  batchTabReferenceError: {
    "zh-CN": "本批标签页引用无法解析。请为 open_tab 设置唯一 tabAlias，并在页面调用中提供对应 tabRef 或明确的 tabId；将依赖的打开调用放在页面操作之前。",
    en: "The batch tab reference could not be resolved. Give each open_tab a unique tabAlias and provide the matching tabRef or an explicit tabId in page calls. Place the required opening call before page actions.",
  },
  batchTabReferenceUnknownReference: {
    "zh-CN": "本批没有 tabAlias「{tabRef}」对应的 open_tab。请先添加对应的 open_tab，或改用已返回的 tabId。",
    en: "No open_tab in this batch has tabAlias \"{tabRef}\". Add that open_tab first, or use an already returned tabId.",
  },
  batchTabReferenceDuplicateAlias: {
    "zh-CN": "tabAlias「{tabRef}」被多个 open_tab 重复使用。请为每个 open_tab 设置唯一的 tabAlias。",
    en: "tabAlias \"{tabRef}\" is used by more than one open_tab. Give each open_tab a unique tabAlias.",
  },
  batchTabReferenceForwardReference: {
    "zh-CN": "tabAlias「{tabRef}」的 open_tab 必须排在引用它的页面调用之前。请调整本批中的调用顺序。",
    en: "The open_tab for tabAlias \"{tabRef}\" must come before the page call that references it. Reorder the calls in this batch.",
  },
  batchTabReferenceInvalidAlias: {
    "zh-CN": "tabAlias「{tabRef}」格式无效。请使用 1–64 个字母、数字、下划线或连字符。",
    en: "tabAlias \"{tabRef}\" has an invalid format. Use 1–64 letters, digits, underscores, or hyphens.",
  },
  batchTabReferenceInvalidReference: {
    "zh-CN": "tabRef「{tabRef}」无效或不适用于该调用。请填写 open_tab 设置的 tabAlias，或改用明确的 tabId。",
    en: "tabRef \"{tabRef}\" is invalid or not allowed on this call. Pass a tabAlias set by open_tab, or an explicit tabId.",
  },
  batchTabReferenceAmbiguousTarget: {
    "zh-CN": "本批包含多个 open_tab，无法确定目标页面。请在页面调用中通过 tabRef 或 tabId 明确指定。",
    en: "This batch contains more than one open_tab, so the target page is ambiguous. Specify it with tabRef or tabId in the page call.",
  },
  batchTabReferenceOutsideBatch: {
    "zh-CN": "tabRef「{tabRef}」只能与对应的 open_tab 在同一批调用中使用。请改用 open_tab 返回的数字 tabId。",
    en: "tabRef \"{tabRef}\" only works in the same batch of calls as its open_tab. Use the numeric tabId returned by open_tab instead.",
  },
  batchTabDependencyFailed: {
    "zh-CN": "tabAlias「{tabRef}」对应的 open_tab 没有成功，已跳过这次页面调用。请先看该 open_tab 的报错，再用返回的 tabId 重试。",
    en: "open_tab for tabAlias \"{tabRef}\" did not succeed, so this page call was skipped. Check that open_tab error, then retry with the returned tabId.",
  },
  actionTimeout: {
    "zh-CN": "操作可能已生效，最终状态尚待确认。系统保留本次尝试，请读取页面状态确认结果。",
    en: "The action may have taken effect; its final state is unconfirmed. The system preserves this attempt. Read the page state to confirm the outcome.",
  },
  timeout: {
    "zh-CN": "超时秒数；省略时用默认超时。",
    en: "Timeout in seconds; defaults to the tool default.",
  },
  elementReference: {
    "zh-CN": "元素引用（{grammar}）。element_uid 取自 get_ax_tree/find_elements/list_images 的 uid；css_selector 须能被 querySelector/querySelectorAll 匹配（例：{examples}）。禁止传按钮文案、标题、URL 或自然语言。",
    en: "Element reference ({grammar}). element_uid comes from get_ax_tree/find_elements/list_images; css_selector must match via querySelector/querySelectorAll (e.g. {examples}). Never pass button text, titles, URLs, or natural language.",
  },
  nextPageSelector: { "zh-CN": "下一页", en: "Next page" },
  commentSelector: { "zh-CN": "评论", en: "Comment" },
});

export const t = createTranslator(messages);

import { defineMessages } from "../../shared/i18n/definition.js";
import { createTranslator } from "../../shared/i18n/index.js";

/** Shared model-facing documentation stays out of the panel's UI catalog. */
const messages = defineMessages("tool-runtime", {
  tabRef: {
    "zh-CN": "目标页面：浏览器数字 tabId（也接受数字字符串），或当前任务中由 open_tab 的 tabAlias 设置的别名。别名可跨轮复用，关闭页面后失效。新页面同批引用时将 open_tab 放在前面；同时传元素 UID 时必须指向同一页。",
    en: "Target page: a numeric browser tabId (numeric strings also accepted), or a tabAlias assigned by open_tab in this Session. Aliases persist across turns until the tab closes. In one tool_calls array, place a new opening before its consumers. If an element UID is also supplied, both must target the same tab.",
  },
  batchTabReferenceError: {
    "zh-CN": "标签页引用无法解析。请用 tabRef 指定已返回的浏览器数字 ID 或当前任务的页面别名；新页面的 open_tab 应放在引用它的调用之前。",
    en: "The tab reference could not be resolved. Set tabRef to a returned browser ID or a page alias in this Session; place a new open_tab before its consumers.",
  },
  batchTabReferenceUnknownReference: {
    "zh-CN": "当前任务没有已打开或本批待创建的别名「{tabRef}」。请检查名称，或在 tabRef 中使用已返回的浏览器数字 ID。",
    en: "No open or newly planned tab in this Session has alias \"{tabRef}\". Check the name, or put a returned browser ID in tabRef.",
  },
  batchTabReferenceDuplicateAlias: {
    "zh-CN": "tabAlias「{tabRef}」已被打开或正在创建的页面占用。请复用该页面，或为新页面选用其他名称。",
    en: "tabAlias \"{tabRef}\" is already used by an open or pending tab. Reuse that page, or choose another name for the new page.",
  },
  batchTabReferenceForwardReference: {
    "zh-CN": "tabAlias「{tabRef}」的 open_tab 必须排在引用它的页面调用之前。请调整本批中的调用顺序。",
    en: "The open_tab for tabAlias \"{tabRef}\" must come before the page call that references it. Reorder the calls in this batch.",
  },
  batchTabReferenceInvalidAlias: {
    "zh-CN": "tabAlias「{tabRef}」格式无效。请使用 1–64 个字母、数字、下划线或连字符，不能全部为数字。",
    en: "tabAlias \"{tabRef}\" has an invalid format. Use 1\u201364 letters, digits, underscores, or hyphens; aliases cannot be entirely numeric.",
  },
  batchTabReferenceInvalidReference: {
    "zh-CN": "tabRef「{tabRef}」无效或不适用于该调用。请使用浏览器正整数 ID 或当前任务的有效页面别名。",
    en: "tabRef \"{tabRef}\" is invalid or not allowed on this call. Use a positive integer browser ID or a valid page alias in this Session.",
  },
  batchTabReferenceAmbiguousTarget: {
    "zh-CN": "本批包含多个 open_tab，无法确定目标页面。请在页面调用中通过 tabRef 明确指定。",
    en: "This batch contains more than one open_tab, so the target page is ambiguous. Specify tabRef in the page call.",
  },
  tabReferenceConflict: {
    "zh-CN": "tabRef「{tabRef}」与同时提供的 tabId 或元素 UID 指向不同页面。请只指定一个目标，或让两者指向同一页。",
    en: "tabRef \"{tabRef}\" conflicts with the supplied tabId or element UID. Select one target, or make both refer to the same page.",
  },
  batchTabReferenceOutsideBatch: {
    "zh-CN": "tabRef「{tabRef}」只能与对应的 open_tab 在同一批调用中使用。请改用 open_tab 返回的数字 tabId。",
    en: "tabRef \"{tabRef}\" only works in the same batch of calls as its open_tab. Use the numeric tabId returned by open_tab instead.",
  },
  batchTabDependencyFailed: {
    "zh-CN": "tabAlias「{tabRef}」对应的 open_tab 未能建立有效页面，已跳过此次调用。请先处理该 open_tab 的错误，再重试。",
    en: "open_tab for alias \"{tabRef}\" did not establish a valid tab, so this call was skipped. Resolve that opening error before retrying.",
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

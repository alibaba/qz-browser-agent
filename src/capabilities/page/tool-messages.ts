import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("page-tools", {
  readArticleDescription: {
    "zh-CN": "读取 tabRef 指定页面的正文 Markdown（保留标题、列表、链接、代码和表格，也支持纯文本或 JSON 页面），用于阅读正文，不用于定位控件。返回 {text,totalChars,hasMore,nextOffset,target,linkCount,outline}；text 为 offset/limit 指定的片段，续读传 nextOffset。outline 提供章节 offset/endOffset/charCount；需原始 DOM 时把 tabRef 和 target 传给 read_dom。source=target 可传 target 或 locator，locator 只读取当前唯一匹配，不等待业务状态。limit 必填，建议 4000–8000，范围 1000–20000。",
    en: "Read cleaned main content from tabRef as Markdown, preserving headings, lists, links, code, and tables; also supports plain text and raw JSON. Use for reading, not locating controls. Returns {text,totalChars,hasMore,nextOffset,target,linkCount,outline}: text is the offset/limit segment; pass nextOffset to continue. outline gives section offset/endOffset/charCount. Pass tabRef and target to read_dom for raw DOM evidence. For source=target, pass target or locator; a locator reads its current unique match without waiting for business state. limit is required (recommended 4000–8000, range 1000–20000).",
  },
  readArticleTabId: {
    "zh-CN": "目标标签页 tabRef：别名或 open_tab/list_tabs 返回的 tabRef。",
    en: "Target tabRef: an alias or the tabRef returned by open_tab/list_tabs.",
  },
  readArticleSource: {
    "zh-CN": "读取来源，默认 auto（依次尝试 selection、article、target、body）。",
    en: "Content source. Default: auto (tries selection, article, target, then body).",
  },
  readArticleSelector: {
    "zh-CN": "读取范围（source=target 时传 target 或 locator），优先 uid:，css: 兜底；auto 指定 target 时只读此范围。",
    en: "Scope for source=target (pass target or locator): prefer uid:, with css: as fallback; auto reads this scope when target is supplied.",
  },
  readArticleOffset: {
    "zh-CN": "起始字符 offset，默认 0；续读传 nextOffset，读章节传 outline 的 offset。",
    en: "Starting character offset. Default: 0. Pass nextOffset to continue or an outline offset for a section.",
  },
  readArticleLimit: {
    "zh-CN": "必填。返回字符数，建议 4000–8000，范围 1000–20000。",
    en: "Required character count to return. Recommended: 4000–8000; range: 1000–20000.",
  },
  readDomDescription: {
    "zh-CN": "按行分页读取 tabRef 指定页面的实时 DOM HTML（剔除 script/style/noscript/svg），返回带 1-indexed 行号的 content、totalLines 和 hasMore。用于读取 find_elements 的 lineRange、read_article 的 target，或验证隐藏字段、form/action、id/class/data-testid、p/br 等 DOM 结构。",
    en: "Read live DOM HTML by line from the page specified by tabRef (script/style/noscript/svg removed), returning 1-indexed numbered content, totalLines, and hasMore. Use to inspect lineRange from find_elements, target from read_article, or DOM structure such as hidden fields, form/action, id/class/data-testid, and p/br.",
  },
  readDomOffset: {
    "zh-CN": "起始行号（1-indexed），默认 1。",
    en: "Starting line number (1-indexed). Default: 1.",
  },
  readDomLimit: {
    "zh-CN": "读取行数，默认 200。",
    en: "Number of lines to read. Default: 200.",
  },
  readDomSelector: {
    "zh-CN": "要读取的元素 target，优先 uid:，css: 兜底；也可改传 locator。默认 css:body。",
    en: "Element to read: prefer uid:, with css: as fallback, or pass locator instead. Defaults to css:body.",
  },
  findElementsDescription: {
    "zh-CN": "在 tabRef 指定页面按 within 范围、语义属性和可选文本匹配查找元素候选。role、name、text、exact 与 locator 查询的匹配规则相同；pattern 是 name/text 的正则替代，不能与 name/text/exact 同时使用。结果顺序与同一查询的 locator nth 相同：按文档顺序，但 exact:false 或 pattern 时 name/text 完全匹配在前，其次是前缀匹配，然后是其余匹配。不传 name、text 或 pattern 时会列出 within/role/roles/tag/tags/type/types 命中的候选。返回 results、total 与 truncated；每项含可直接用于 inspect_element/act_on_element 的 target，以及 role/name/text/rect/actionable/inViewport/lineRange 等摘要；需原始 HTML 时将 tabRef 和 lineRange 传给 read_dom。",
    en: "Find candidate elements on the page specified by tabRef within an optional container, by semantic filters, and optional text matching. role, name, text, and exact match as in a locator query; pattern is the regex alternative to name/text and cannot be combined with name/text/exact. Results are in the same order as locator nth for the same query: document order, except that exact:false or pattern lists whole name/text matches first, then prefix matches, then the rest. Without name, text, or pattern, lists candidates matching within/role/roles/tag/tags/type/types. Returns results, total, and truncated; each result has a target usable directly with inspect_element/act_on_element, plus role/name/text/rect/actionable/inViewport/lineRange summaries; pass tabRef and lineRange to read_dom for raw HTML.",
  },
  findElementsPattern: {
    "zh-CN": "可选正则，匹配 name、aria-label、placeholder、value、id、name/title/data-testid、href、text、role、tag、class。与 name/text/exact 二选一。",
    en: "Optional regex matched against name, aria-label, placeholder, value, id, name/title/data-testid, href, text, role, tag, and class. Use instead of name/text/exact, not with them.",
  },
  findElementsMatchConflict: {
    "zh-CN": "name/text/exact 用于字面匹配，pattern/flags 用于正则匹配；请只使用其中一种。",
    en: "Use name/text/exact for literal matching or pattern/flags for a regular expression; pass only one kind.",
  },
  findAllElementsLimit: {
    "zh-CN": "limit 必须是正整数；省略 limit 则返回全部匹配。",
    en: "limit must be a positive integer; omit limit to return every match.",
  },
  findElementsEmptyQuery: {
    "zh-CN": "{field} 必须是非空字符串。",
    en: "{field} must be a non-empty string.",
  },
  findElementsFlags: {
    "zh-CN": "RegExp flags，默认 i。",
    en: "RegExp flags. Default: i.",
  },
  findElementsWithin: {
    "zh-CN": "只在此容器元素内查找（与 locator.within 相同；穿透 open Shadow DOM），优先 uid:，css: 兜底，默认整页。",
    en: "Search only inside this container element, the same as locator.within: prefer uid:, with css: as fallback; pierces open Shadow DOM and defaults to the whole page.",
  },
  findElementsRole: {
    "zh-CN": "按单个 ARIA role 过滤（含显式与隐式 role），如 link。与 roles 二选一。",
    en: "Filter by one ARIA role (explicit or implicit), such as link. Use either role or roles.",
  },
  findElementsRoles: {
    "zh-CN": "匹配任意一个给定的 ARIA role（含显式与隐式 role），如 [\"button\",\"link\"]。与 role 二选一。",
    en: "Match any of the given ARIA roles (explicit or implicit), such as [\"button\",\"link\"]. Use either role or roles.",
  },
  findElementsFilterConflict: {
    "zh-CN": "{single} 用于单选，{plural} 用于多选；请只传其中一个。",
    en: "Use {single} for one value or {plural} for multiple values; pass only one of these fields.",
  },
  findElementsLocatorConflict: {
    "zh-CN": "请使用 locator 或查找过滤条件，不能同时传入。",
    en: "Pass locator or discovery filters, not both.",
  },
  findElementsTag: {
    "zh-CN": "按单个 HTML tag 过滤，如 input。与 tags 二选一。",
    en: "Filter by one HTML tag, such as input. Use either tag or tags.",
  },
  findElementsTags: {
    "zh-CN": "匹配任意一个给定的 HTML tag，如 [\"button\",\"input\"]。与 tag 二选一。",
    en: "Match any of the given HTML tags, such as [\"button\",\"input\"]. Use either tag or tags.",
  },
  findElementsType: {
    "zh-CN": "按单个 type 属性过滤，如 search。与 types 二选一。",
    en: "Filter by one type attribute, such as search. Use either type or types.",
  },
  findElementsTypes: {
    "zh-CN": "匹配任意一个给定的 type 属性，如 [\"text\",\"search\"]。与 type 二选一。",
    en: "Match any of the given type attributes, such as [\"text\",\"search\"]. Use either type or types.",
  },
  findElementsLimit: {
    "zh-CN": "最多返回数量，默认 20，范围 1–100。",
    en: "Maximum results. Default: 20; range: 1–100.",
  },
  findElementsIncludeHidden: {
    "zh-CN": "是否包含不可见元素，默认 false。",
    en: "Include hidden elements. Default: false.",
  },
  findElementsWaitForMatch: {
    "zh-CN": "true 时等待至少一个匹配，超时报错；默认 false，返回当前匹配（允许空列表）。不保证动态列表已加载完整。",
    en: "true waits for at least one match and throws on timeout; default false returns current matches, including an empty list. It does not guarantee a complete dynamic list.",
  },
  findElementsTimeout: {
    "zh-CN": "调用时限（秒，大于 0，最大 300）。等待匹配默认 10 秒，普通查询默认 30 秒。",
    en: "Call timeout in seconds (>0, maximum 300). Default: 10 when waiting for a match, otherwise 30.",
  },
  findElementsInvalidRegex: {
    "zh-CN": "元素查找的正则表达式或 flags 无效。",
    en: "Invalid element search regular expression or flags.",
  },
  findElementsInvalidRegexHint: {
    "zh-CN": "修正 pattern 或 flags 后重试查找。",
    en: "Correct pattern or flags, then retry the search.",
  },
  inspectElementDescription: {
    "zh-CN": "检查 tabRef 指定页面内单个元素的完整可操作画像：匹配数、文本/aria/attrs、可见性、disabled、rect、clickablePoint、state、form、附近文本及行号。使用 target 时先从 get_ax_tree 或 find_elements 获取引用。可传 target 或 locator；locator 读取当前唯一匹配，不等待。{targetGrammar}。",
    en: "Inspect an element's interaction profile on the page specified by tabRef: match count, text/aria/attrs, visibility, disabled state, rect, clickablePoint, state, form, nearby text, and line numbers. For target, obtain a reference from get_ax_tree or find_elements first. Pass target or locator; a locator reads its current unique match without waiting. {targetGrammar}.",
  },
  actOnElementDescription: {
    "zh-CN": "对 tabRef 指定页面内的元素执行高层动作：click=点击按钮/链接/控件（移动模式自动用触摸）；double_click=双击；hover=悬停；drag=拖到同页 destination.target 或 destination.locator；fill=把 value 填入 input/textarea/contenteditable（必须传 value，空字符串清空；contenteditable 多行文本按段落插入）；press=按 key（如 Enter）；select=按 value 选择原生 <select> 选项（优先精确匹配 option.value，否则匹配忽略首尾空白的可见 label）；check/uncheck=切换原生 checkbox/radio（radio 不可 uncheck）；scroll=滚到该元素。传 target 或 locator；locator 在整次调用期限内等待唯一匹配和就绪，target 默认最多等待就绪 5 秒；timeout 设置整次调用时限（秒，默认 20，最大 120），显式设置时也用于就绪等待；已派发动作不自动重放。成功返回 {}，观察到新标签时附带 popups，发生导航时附带 navigated/url，仍在导航时附带 navigationPending；confirmationRequired 为 true 时，先确认编辑器已保存内容再继续。需要核对页面结果时，读取相关局部状态。使用 target 时先从 get_ax_tree 或 find_elements 获取引用。本地文件选择通过 wait_for_user 交给用户完成。原生 alert、confirm、prompt 和 beforeunload 由用户在浏览器原生对话框中处理，助手无法代点。{targetGrammar}。",
    en: "Perform a high-level action on an element in the page specified by tabRef: click clicks a button/link/control (uses touch in mobile mode); double_click double-clicks; hover moves the pointer over the element; drag moves it to destination.target or destination.locator on the same page; fill enters value into an input/textarea/contenteditable (value is required; \"\" clears; multiline contenteditable text inserts paragraphs); press sends key (e.g. Enter); select chooses a native <select> option by value: exact option.value first, or by visible label (surrounding whitespace ignored) if no value matches (exact value takes priority); check/uncheck toggles a native checkbox/radio (radio cannot be unchecked); scroll scrolls the element into view. Pass target or locator. Locators wait for a unique ready match within the whole-call deadline; target readiness defaults to 5 seconds. timeout sets the whole-call limit in seconds (default 20, maximum 120); an explicit value also sets the readiness limit. Dispatched actions are never automatically replayed. Success returns {}, with popups for observed new tabs, navigated/url when navigation occurs and navigationPending while it is pending. If confirmationRequired is true, verify the editor saved the value before continuing; use a focused observation to check the resulting page state when needed. For target, obtain a reference from get_ax_tree or find_elements first. Use wait_for_user for local file selection. The user answers native alert, confirm, prompt, and beforeunload dialogs in the browser. The agent cannot click them. {targetGrammar}.",
  },
  actOnElementDestination: {
    "zh-CN": "drag 的同页目标元素；传入 destination.target 或 destination.locator。",
    en: "Destination element on the same page for drag; pass destination.target or destination.locator.",
  },
  actOnElementValue: {
    "zh-CN": "fill 和 select 必填：fill 文本（\"\" 清空），或 select 的 option.value / 可见 label（精确 value 优先）。",
    en: "Required for fill and select: text for fill (\"\" clears), or option.value / visible label for select (exact value takes priority).",
  },
  actOnElementKey: {
    "zh-CN": "press 必填的按键名，如 Enter/Escape/Tab/ArrowDown。",
    en: "Required key for press, such as Enter/Escape/Tab/ArrowDown.",
  },
  actOnElementMissingField: {
    "zh-CN": "{action} 需要 {field}。",
    en: "{action} requires {field}.",
  },
  actOnElementSubmit: {
    "zh-CN": "fill 后是否紧接发送 Enter，默认 false。",
    en: "Press Enter after fill completes. Default: false.",
  },
  scrollPageDescription: {
    "zh-CN": "滚动 tabRef 指定的页面。传 target 或 locator 时将该元素滚入视口中央；都不传时按 direction（up/down/top/bottom，默认 down）和 pixels（默认 500，仅 up/down 生效）滚动窗口。",
    en: "Scroll the page specified by tabRef. Pass target or locator to scroll that element into the center of the viewport; omit both to scroll the window by direction (up/down/top/bottom, default down) and pixels (default 500, used for up/down).",
  },
  scrollPagePixels: {
    "zh-CN": "up/down 滚动像素数，默认 500。",
    en: "Scroll distance in pixels for up/down. Default: 500.",
  },
  scrollPageTarget: {
    "zh-CN": "滚到指定元素时使用。{targetDescription}",
    en: "Element target to scroll into view. {targetDescription}",
  },
});

export const toolT = createTranslator(messages);

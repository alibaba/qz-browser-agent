import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("page-tools", {
  readArticleDescription: {
    "zh-CN": "读取目标页面整理后的正文 Markdown（保留标题、列表、链接、代码和表格，也支持纯文本或原始 JSON 页面）。读正文优先使用本工具，不要用于寻找可操作控件。返回 offset/limit 指定的正文片段及 totalChars/hasMore/nextOffset/sourceSelector/linkCount；长文用 nextOffset 续读。outline 为带 offset/endOffset/charCount 的目录，可按 offset 和 limit 读指定章节；需原始 DOM 证据时把 sourceSelector 传给 read_dom。limit 必填，建议 4000–8000，范围 1000–20000。",
    en: "Read cleaned main content from the target page as Markdown (preserving headings, lists, links, code, and tables; also works on plain-text or raw JSON pages). Prefer this tool for reading body text, not for finding interactive controls. Returns the offset/limit text segment plus totalChars/hasMore/nextOffset/sourceSelector/linkCount; pass nextOffset to continue reading. outline lists sections with offset/endOffset/charCount; pass sourceSelector to read_dom when raw DOM evidence is needed. limit is required (recommended 4000–8000, range 1000–20000).",
  },
  readArticleTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID. Defaults to the current task's working tab.",
  },
  readArticleSource: {
    "zh-CN": "读取来源，默认 auto（依次尝试 selection、article、selector、body）。",
    en: "Content source. Default: auto (tries selection, article, selector, then body).",
  },
  readArticleSelector: {
    "zh-CN": "source=selector 必填（auto 可选）的范围；支持原始 CSS 或 target 格式 css:... / uid:...。",
    en: "Scope for source=selector (optional for auto). Accepts raw CSS or a target in css:... / uid:... format.",
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
    "zh-CN": "按行分页读取目标页面的实时 DOM HTML（剔除 script/style/noscript/svg），返回带 1-indexed 行号的 content、totalLines 和 hasMore。用于读取 find_elements 的 lineRange、read_article 的 sourceSelector，或验证隐藏字段、form/action、id/class/data-testid、p/br 等 DOM 结构。",
    en: "Read paginated live DOM HTML by line (script/style/noscript/svg removed), returning 1-indexed numbered content, totalLines, and hasMore. Use to inspect lineRange from find_elements, sourceSelector from read_article, or DOM structure such as hidden fields, form/action, id/class/data-testid, and p/br.",
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
    "zh-CN": "读取范围，默认 body；支持原始 CSS 或 target 格式 css:... / uid:...。",
    en: "Scope to read. Default: body. Accepts raw CSS or a target in css:... / uid:... format.",
  },
  findElementsDescription: {
    "zh-CN": "按范围、语义属性和可选正则查找页面元素候选（优先排序可操作、视口内、匹配更明确的元素）。pattern 是可选过滤条件：不传 pattern 时会列出 selector/tags/roles/types 命中的候选。返回可直接用于 inspect_element/act_on_element 的 target，以及 selector、role/name/text/rect/actionable/inViewport/lineRange 等摘要；需原始 HTML 时将 lineRange 传给 read_dom。",
    en: "Find candidate page elements by scope, semantic filters, and an optional regex (prioritizing actionable, in-viewport, and specific matches). pattern is an optional filter: when omitted, lists candidates matching selector/tags/roles/types. Returns a target usable directly with inspect_element/act_on_element, plus selector, role/name/text/rect/actionable/inViewport/lineRange summaries; pass lineRange to read_dom for raw HTML.",
  },
  findElementsPattern: {
    "zh-CN": "可选正则，匹配 name、aria-label、placeholder、value、id、name/title/data-testid、href、text、role、tag、class。",
    en: "Optional regex matched against name, aria-label, placeholder, value, id, name/title/data-testid, href, text, role, tag, and class.",
  },
  findElementsFlags: {
    "zh-CN": "RegExp flags，默认 i。",
    en: "RegExp flags. Default: i.",
  },
  findElementsSelector: {
    "zh-CN": "查找范围（穿透 open Shadow DOM），默认 body；支持原始 CSS 或 target 格式 css:... / uid:...。",
    en: "Search scope (pierces open Shadow DOM). Default: body. Accepts raw CSS or a target in css:... / uid:... format.",
  },
  findElementsRoles: {
    "zh-CN": "可选 ARIA role 过滤（含显式与隐式 role），如 button/link/textbox/checkbox。",
    en: "Optional ARIA role filter (explicit and implicit), such as button/link/textbox/checkbox.",
  },
  findElementsTags: {
    "zh-CN": "可选 tag 过滤，如 button/a/input/div。",
    en: "Optional HTML tag filter, such as button/a/input/div.",
  },
  findElementsTypes: {
    "zh-CN": "可选 type 属性过滤，如 text/search/submit/file。",
    en: "Optional type attribute filter, such as text/search/submit/file.",
  },
  findElementsLimit: {
    "zh-CN": "最多返回数量，默认 20，范围 1–100。",
    en: "Maximum results. Default: 20; range: 1–100.",
  },
  findElementsIncludeHidden: {
    "zh-CN": "是否包含不可见元素，默认 false。",
    en: "Include hidden elements. Default: false.",
  },
  inspectElementDescription: {
    "zh-CN": "检查单个元素的完整可操作画像：匹配数、文本/aria/attrs、可见性、disabled、rect、clickablePoint、state、form、附近文本及行号。先从 get_ax_tree 或 find_elements 获取 target。{targetGrammar}。",
    en: "Inspect an element's interaction profile: match count, text/aria/attrs, visibility, disabled state, rect, clickablePoint, state, form, nearby text, and line numbers. Obtain target from get_ax_tree or find_elements first. {targetGrammar}.",
  },
  inspectElementIndex: {
    "zh-CN": "css:... 匹配多个时的 0-based 序号，默认 0。",
    en: "0-based match index when css:... matches multiple elements. Default: 0.",
  },
  actOnElementDescription: {
    "zh-CN": "对页面元素执行高层动作：click=点击按钮/链接/控件（移动模式自动用触摸）；fill=填写 input/textarea/contenteditable（空字符串清空；contenteditable 多行文本按段落插入并返回 p/br/block 结构）；press=按键（如 Enter；无修饰键的 Enter 也返回与 fill(submit:true) 相同的导航字段）；select=选择原生 <select> 选项（优先精确匹配 option.value，否则匹配忽略首尾空白的可见 label）；check/uncheck=切换原生 checkbox/radio（radio 不可 uncheck）；scroll=滚到该元素。先从 get_ax_tree 或 find_elements 获取 target。本地文件选择通过 wait_for_user 交给用户完成。原生 alert、confirm、prompt 和 beforeunload 由用户在浏览器原生对话框中处理，助手无法代点。{targetGrammar}。",
    en: "Perform a high-level action on a page element: click clicks a button/link/control (uses touch in mobile mode); fill enters text into an input/textarea/contenteditable (\"\" clears; multiline contenteditable text inserts paragraphs and returns p/br/block structure); press sends a key (e.g. Enter; unmodified Enter also returns the same navigation fields as fill with submit:true); select chooses a native <select> option by exact option.value first, or by visible label (surrounding whitespace ignored) if no value matches (exact value takes priority); check/uncheck toggles a native checkbox/radio (radio cannot be unchecked); scroll scrolls the element into view. Obtain target from get_ax_tree or find_elements first. Use wait_for_user for local file selection. The user answers native alert, confirm, prompt, and beforeunload dialogs in the browser. The agent cannot click them. {targetGrammar}.",
  },
  actOnElementValue: {
    "zh-CN": "fill 文本（\"\" 清空），或 select 的 option.value / 可见 label（精确 value 优先）；press 缺省 key 时也作按键名。",
    en: "Text for fill (\"\" clears), or option.value / visible label for select (exact value takes priority); also used as the key for press if key is omitted.",
  },
  actOnElementKey: {
    "zh-CN": "press 按键名，如 Enter/Escape/Tab/ArrowDown（press 时 key 或 value 必填）。",
    en: "Key for press, such as Enter/Escape/Tab/ArrowDown (press requires key or value).",
  },
  actOnElementSubmit: {
    "zh-CN": "fill 后是否紧接发送 Enter，默认 false。",
    en: "Press Enter after fill completes. Default: false.",
  },
  scrollPageDescription: {
    "zh-CN": "滚动页面。传 target 时将该元素滚入视口中央；不传 target 时按 direction（up/down/top/bottom，默认 down）和 pixels（默认 500，仅 up/down 生效）滚动窗口。",
    en: "Scroll the page. Pass target to scroll that element into the center of the viewport; omit target to scroll the window by direction (up/down/top/bottom, default down) and pixels (default 500, used for up/down).",
  },
  scrollPagePixels: {
    "zh-CN": "up/down 滚动像素数，默认 500。",
    en: "Scroll distance in pixels for up/down. Default: 500.",
  },
  scrollPageTarget: {
    "zh-CN": "滚到指定元素时使用。{targetDescription}",
    en: "Element target to scroll into view. {targetDescription}",
  },
  scrollPageIndex: {
    "zh-CN": "css:... 匹配多个时的 0-based 序号，默认 0。",
    en: "0-based match index when css:... matches multiple elements. Default: 0.",
  },
});

export const toolT = createTranslator(messages);

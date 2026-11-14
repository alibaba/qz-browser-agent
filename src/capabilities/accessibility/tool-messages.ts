import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("accessibility-tools", {
  getAxTreeDescription: {
    "zh-CN": "获取 tabRef 指定页面的语义快照。返回类似 Chrome DevTools MCP 的紧凑 snapshot 文本，每行一个节点，包含 target、role、name、url 等字段。省略 target 查看整页；改传 uid:/css: target 或 locator 时只展开该元素的子树。scope 只能是 viewport 或 full。省略 target 时默认 scope:\"viewport\"：返回纵向视口内的细节、结构祖先和有限的屏外结构，横向溢出和几何未知的节点保留；视口上下方省略的 AX 节点和区块内折叠的内容以 ↑/↓ 标记给出数量和读取方式（scope:\"full\"，或把树中 target 传给 target），计数覆盖已加载内容；list 行的 items=N 为直接列表项数。limit 使用 BFS 分配节点预算，优先覆盖更多同层分支，输出仍按树形顺序排列；节点行尾的 (truncated, N more) 表示其下还有 N 行未展开。还会返回 target 范围内尺寸较大的可见 canvases(name/rect/inViewport/bitmapSize)，忽略小型 Canvas；其中 rect 只是页面 CSS 位置提示，视觉操作坐标必须以 screenshot({tabRef,actionable:true}) 返回的原始图片为准。理解页面后，优先把 tabRef 和行中的 target（形如 uid:...）原样传给 act_on_element（click、fill 等）、inspect_element、screenshot 或 read_image；需要精确的 CSS 定位时再用 find_elements/inspect_element。{targetGrammar}。",
    en: "Get a semantic snapshot of the page specified by tabRef. Returns compact snapshot text similar to Chrome DevTools MCP, one node per line, with fields such as target, role, name, and url. Omit target for the whole page, or pass a uid:/css: target or a locator to expand only that element's subtree. scope is only viewport or full. When target is omitted, the default is scope:\"viewport\": vertical viewport detail, structural ancestors and bounded off-screen structure, keeping horizontally overflowing nodes and nodes with unknown geometry; AX nodes omitted above or below the viewport and content folded inside a block appear as ↑/↓ markers with counts and a read path (scope:\"full\", or a tree target passed as target), and counts cover loaded content; items=N on a list line counts its direct list items. limit allocates the node budget breadth-first to cover more sibling branches first, while output stays in tree order; a trailing (truncated, N more) means N more lines under that node were not expanded. Also returns larger visible canvases(name/rect/inViewport/bitmapSize) under that root and ignores small canvases; rect is only a CSS position hint, and visual action coordinates must come from the original image returned by screenshot({tabRef,actionable:true}). Once you understand the page, pass tabRef together with a line's unchanged target (such as uid:...) to act_on_element (click, fill, etc.), inspect_element, screenshot, or read_image; use find_elements/inspect_element when precise CSS targeting is needed. {targetGrammar}.",
  },
  getAxTreeTabId: {
    "zh-CN": "目标标签页 tabRef：别名或 open_tab/list_tabs 返回的 tabRef。",
    en: "Target tabRef: an alias or the tabRef returned by open_tab/list_tabs.",
  },
  getAxTreeRoot: {
    "zh-CN": "省略 target 查看整页；传 uid:... 或 css:...（或改传 locator）只展开某个元素子树。scope 只能是 viewport 或 full。",
    en: "Omit target for the whole page, or use uid:... / css:... (or locator) to expand an element subtree. scope is only viewport or full.",
  },
  getAxTreeScope: {
    "zh-CN": "只能是 viewport 或 full。viewport：视口细节与有限屏外结构；full：整份文档或当前子树。省略 scope 时，未传 target 用 viewport，uid: 或 css: 根用 full。",
    en: "Only viewport or full. viewport: viewport detail and bounded off-screen structure. full: the whole document or the current subtree. When scope is omitted, an omitted target uses viewport, and a uid: or css: target uses full.",
  },
  getAxTreeDepth: {
    "zh-CN": "AX tree 深度，默认 16，范围 1-40",
    en: "AX tree depth. Default: 16; range: 1–40.",
  },
  getAxTreeLimit: {
    "zh-CN": "snapshot 最多返回节点行数，默认 120，范围 20-300。",
    en: "Maximum snapshot node lines. Default: 120; range: 20–300.",
  },
  getAxTreeActionsLimit: {
    "zh-CN": "可操作元素最多返回数量，默认 40，范围 5-80",
    en: "Maximum number of actionable elements. Default: 40; range: 5–80.",
  },
  aboveViewport: {
    "zh-CN": "↑ 视口上方省略 {count} 个 AX 节点；保持 tabRef，用 scope:\"full\" 或树中 target 传给 target 读取",
    en: "↑ {count} AX nodes omitted above viewport; read with the same tabRef and scope:\"full\" or a tree target passed as target",
  },
  belowViewport: {
    "zh-CN": "↓ 视口下方省略 {count} 个 AX 节点；保持 tabRef，用 scope:\"full\" 或树中 target 传给 target 读取",
    en: "↓ {count} AX nodes omitted below viewport; read with the same tabRef and scope:\"full\" or a tree target passed as target",
  },
  readViewportRoot: {
    "zh-CN": "保持 tabRef，用 target=\"{target}\" 或 scope:\"full\" 读取",
    en: "read with the same tabRef and target=\"{target}\" or scope:\"full\"",
  },
  foldedAbove: {
    "zh-CN": "↑ 此区块上方省略 {count} 项内容；{capability}",
    en: "↑ This block omits {count} content items above; {capability}",
  },
  foldedBelow: {
    "zh-CN": "↓ 此区块下方省略 {count} 项内容；{capability}",
    en: "↓ This block omits {count} content items below; {capability}",
  },
  unmeasuredViewport: {
    "zh-CN": "几何信息缺失：{count} 个节点。",
    en: "Geometry unavailable: {count} nodes.",
  },
});

export const toolT = createTranslator(messages);

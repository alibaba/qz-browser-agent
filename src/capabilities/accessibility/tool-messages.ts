import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("accessibility-tools", {
  getAxTreeDescription: {
    "zh-CN": "获取当前任务所拥有页面的语义快照。返回类似 Chrome DevTools MCP 的紧凑 snapshot 文本：每行带 target、role、name、url；同时返回 actions(target/role/type/name/text/value/placeholder/href/state/rect)，文件输入还会带 accept/multiple/selectedFileCount。默认还返回当前范围内尺寸较大的可见 canvases(name/rect/inViewport/bitmapSize)，小型 Canvas 会忽略；这里的 rect 是页面 CSS 位置提示，视觉操作坐标必须以 screenshot({actionable:true}) 返回的原始图片为准。root=\"root\" 查看整页；root 传 uid:/css: target 时展开该元素子树。limit 使用 BFS 分配节点预算以覆盖更多同层分支，输出仍保持树形顺序；节点行尾的 (truncated) 表示该节点在当前 depth 内还有子树因 limit 未展示。理解页面后，优先把 actions 或 snapshot 中的 target 原样传给 act_on_element/inspect_element/screenshot/read_image；需要精确 CSS 定位时再用 find_elements/inspect_element。{targetGrammar}。",
    en: "Get a semantic snapshot of a page owned by the current task. Returns compact snapshot text similar to Chrome DevTools MCP: each line includes target, role, name, and url. Also returns actions(target/role/type/name/text/value/placeholder/href/state/rect), with accept/multiple/selectedFileCount for file inputs. By default, includes larger visible canvases(name/rect/inViewport/bitmapSize) in the current scope and omits small canvases. These rect values are CSS page-position hints; visual action coordinates must come from the original image returned by screenshot({actionable:true}). Use root=\"root\" for the whole page, or a uid:/css: target to expand an element subtree. limit allocates the node budget breadth-first to cover more sibling branches, while output retains tree order. A trailing (truncated) means a node has descendants within depth that were omitted because of limit. Once you understand the page, pass targets from actions or snapshot unchanged to act_on_element/inspect_element/screenshot/read_image. Use find_elements/inspect_element when precise CSS targeting is needed. {targetGrammar}.",
  },
  getAxTreeTabId: {
    "zh-CN": "当前任务拥有的目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "ID of a target tab owned by the current task. Defaults to the current task’s working tab.",
  },
  getAxTreeRoot: {
    "zh-CN": "展开根节点。传 \"root\" 查看整页；也可传 uid:... 或 css:... 只展开某个元素子树。默认 root。",
    en: "Root to expand. Use \"root\" for the whole page, or uid:... / css:... to expand an element subtree. Default: root.",
  },
  getAxTreeDepth: {
    "zh-CN": "AX tree 深度，默认 16，范围 1-40",
    en: "AX tree depth. Default: 16; range: 1–40.",
  },
  getAxTreeLimit: {
    "zh-CN": "snapshot 最多返回节点行数，默认 120，范围 20-300；按 BFS 分配预算，输出仍为树形顺序，截断分支标记 (truncated)",
    en: "Maximum number of snapshot node lines. Default: 120; range: 20–300. Allocates the budget breadth-first, retains tree order, and marks omitted branches with (truncated).",
  },
  getAxTreeActionsLimit: {
    "zh-CN": "可操作元素最多返回数量，默认 40，范围 5-80",
    en: "Maximum number of actionable elements. Default: 40; range: 5–80.",
  },
});

export const toolT = createTranslator(messages);

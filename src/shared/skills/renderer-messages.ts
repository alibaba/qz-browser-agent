import { defineMessages } from "../i18n/definition.js";
import { createTranslator } from "../i18n/index.js";

/** Authored renderer documentation; result paths and user-provided labels remain literal. */
const messages = defineMessages("skill-renderers", {
  "selectionTitle": { "zh-CN": "选择结果", "en": "Choose results" },
  "selectionDescription": { "zh-CN": "将候选结果显示为可选择卡片，等待用户确认后返回所选内容。", "en": "Show candidates as selectable cards and return the user's confirmed selection." },
  "selectionReturn": { "zh-CN": "- 返回最多 50 个候选对象，每项具有唯一、非空的字符串 ID 和标题。仅用于顶层结果 renderer。用户确认后，工具返回 selectedIds、selectedItems 和 totalItems；等待用户不计入脚本超时。", "en": "- Return up to 50 candidate objects with unique nonempty string IDs and titles. Use as a top-level result renderer. After confirmation, the tool returns selectedIds, selectedItems and totalItems; user waiting time is outside the script timeout." },
  "selectionCompleted": { "zh-CN": "已选择 {count} / {total} 项", "en": "Selected {count} of {total}" },
  "metadataSeparator": {
    "zh-CN": "；",
    "en": "; "
  },
  "collectionTruncated": {
    "zh-CN": "{path} 表示当前 rows 是否被截断",
    "en": "{path} indicates whether the current rows are truncated"
  },
  "collectionTotal": {
    "zh-CN": "{path} 表示完整结果行数",
    "en": "{path} is the total result row count"
  },
  "collectionMetadata": {
    "zh-CN": "- 集合元数据：{total}{separator}{truncated}。",
    "en": "- Collection metadata: {total}{separator}{truncated}."
  },
  "configuredPathLine": {
    "zh-CN": "- {label}：{paths}。",
    "en": "- {label}: {paths}."
  },
  "inputBlock": {
    "zh-CN": "- 工具输入 {target}: renderer={type}，{description}",
    "en": "- Tool input {target}: renderer={type}; {description}"
  },
  "layoutInputBlock": {
    "zh-CN": "- 工具输入 {target}: renderer={type}，由调用参数提供，不属于脚本 return 契约。",
    "en": "- Tool input {target}: renderer={type}; supplied by call arguments, outside the script return contract."
  },
  "suggestedFields": {
    "zh-CN": "  建议字段：{fields}。",
    "en": "  Suggested fields: {fields}."
  },
  "layoutResultBlock": {
    "zh-CN": "- {target}: renderer={type}，{description}，期望 {shape}。",
    "en": "- {target}: renderer={type}; {description} Expected shape: {shape}."
  },
  "fieldTarget": {
    "zh-CN": "字段 {path}",
    "en": "Field {path}"
  },
  "codePath": {
    "zh-CN": "- return 一个对象，并在 {path} 字段放代码字符串；可提供 language/filename。",
    "en": "- Return an object with a code string at {path}; language/filename are optional."
  },
  "jsonPath": {
    "zh-CN": "- return 一个对象，并在 {path} 字段放可序列化数据。",
    "en": "- Return an object with serializable data at {path}."
  },
  "markdownPath": {
    "zh-CN": "- return 一个对象，并在 {path} 字段放 Markdown 字符串。",
    "en": "- Return an object with a Markdown string at {path}."
  },
  "textPath": {
    "zh-CN": "- return 一个对象，并在 {path} 字段放纯文本字符串。",
    "en": "- Return an object with a plain-text string at {path}."
  },
  "notePath": {
    "zh-CN": "- return 一个对象，并在 {path} 字段放短提示文本。",
    "en": "- Return an object with a short note at {path}."
  },
  "textTitle": {
    "zh-CN": "文本",
    "en": "Text"
  },
  "summaryTitle": {
    "zh-CN": "摘要",
    "en": "Summary"
  },
  "summaryDescription": {
    "zh-CN": "展示一个对象的主标题、副标题和少量指标字段。",
    "en": "Show an object's main title, subtitle, and a few metric fields."
  },
  "compactTitle": {
    "zh-CN": "紧凑摘要",
    "en": "Compact summary"
  },
  "compactDescription": {
    "zh-CN": "与 summary 使用同一返回契约，用更凝练的方式展示。",
    "en": "Use the summary return contract in a more compact presentation."
  },
  "metricsTitle": {
    "zh-CN": "指标",
    "en": "Metrics"
  },
  "metricsDescription": {
    "zh-CN": "展示一组关键数字或短字段。",
    "en": "Show key numbers or short fields."
  },
  "fieldsTitle": {
    "zh-CN": "字段",
    "en": "Fields"
  },
  "fieldsDescription": {
    "zh-CN": "展示一组 label/value 字段，适合对象详情或配置项。",
    "en": "Show label/value fields for object details or settings."
  },
  "chipsTitle": {
    "zh-CN": "标签行",
    "en": "Chips"
  },
  "chipsDescription": {
    "zh-CN": "展示一组短标签，适合状态、分类、过滤条件或能力摘要。",
    "en": "Show short labels for statuses, categories, filters, or capability summaries."
  },
  "chipsReturn": {
    "zh-CN": "- 默认 return { chips: [...] }；如果 renderer 配置了 itemsPath/valuePath，则该路径必须是短值数组。",
    "en": "- Return { chips: [...] } by default. If itemsPath/valuePath is configured, that path must contain an array of short values."
  },
  "noteTitle": {
    "zh-CN": "提示",
    "en": "Note"
  },
  "noteDescription": {
    "zh-CN": "展示一段轻量提示、错误说明、边界说明或下一步提醒。",
    "en": "Show a brief note, error, limitation, or next-step reminder."
  },
  "noteReturn": {
    "zh-CN": "- 默认 return { note: string }，也可用 message/error 字段。",
    "en": "- Return { note: string } by default. message/error fields are also supported."
  },
  "textDescription": {
    "zh-CN": "展示一段纯文本预览，适合正文片段、摘要、日志片段。",
    "en": "Show a plain-text preview, such as an excerpt, summary, or log fragment."
  },
  "textReturn": {
    "zh-CN": "- 默认 return { text: string }，也可用 content/body 字段。",
    "en": "- Return { text: string } by default. content/body fields are also supported."
  },
  "articleTitle": {
    "zh-CN": "文章",
    "en": "Article"
  },
  "articleDescription": {
    "zh-CN": "展示标题、作者、时间、正文与评论/回答区，适合知乎答案、论坛帖子、影评等长内容。",
    "en": "Show a title, author, time, body, and comments/answers for long content such as answers, forum posts, or reviews."
  },
  "articleReturn": {
    "zh-CN": "- 默认 return { title, author, publishedAt, body, meta:[...], comments:[{ author, time, body, meta:[...] }] }；字段也可用 text/content/markdown 作为正文，用 replies/answers/reviews 作为评论或回答区。",
    "en": "- Return { title, author, publishedAt, body, meta:[...], comments:[{ author, time, body, meta:[...] }] } by default. text/content/markdown may provide the body; replies/answers/reviews may provide comments or answers."
  },
  "articleMetadata": {
    "zh-CN": "- meta 完全由返回数据的 meta 数组或 renderer.metaFields/commentMeta 配置决定；renderer 不内置点赞、评分、楼层等场景字段。",
    "en": "- Metadata comes entirely from the returned meta array or renderer.metaFields/commentMeta. The renderer does not assume domain-specific fields such as likes, ratings, or post numbers."
  },
  "configuredPathsLabel": {
    "zh-CN": "配置路径会优先读取",
    "en": "Configured paths take precedence"
  },
  "listTitle": {
    "zh-CN": "列表",
    "en": "List"
  },
  "listDescription": {
    "zh-CN": "展示轻量列表，每项有标题、副标题和少量 meta。",
    "en": "Show a lightweight list with a title, subtitle, and a few metadata fields per item."
  },
  "listReturn": {
    "zh-CN": "- 默认 return { items: [...] }；如果 renderer 配置了 itemsPath，则该路径必须是数组。",
    "en": "- Return { items: [...] } by default. If itemsPath is configured, that path must contain an array."
  },
  "listFieldsLabel": {
    "zh-CN": "items 每项建议包含字段",
    "en": "Suggested fields for each items entry"
  },
  "tableTitle": {
    "zh-CN": "表格",
    "en": "Table"
  },
  "tableDescription": {
    "zh-CN": "展示结构化行列数据。",
    "en": "Show structured rows and columns."
  },
  "tableReturn": {
    "zh-CN": "- 默认 return { rows: [...] }；如果 renderer 配置了 itemsPath/valuePath，则该路径必须是数组。",
    "en": "- Return { rows: [...] } by default. If itemsPath/valuePath is configured, that path must contain an array."
  },
  "tableFieldsLabel": {
    "zh-CN": "rows 每项至少包含字段",
    "en": "Minimum fields for each rows entry"
  },
  "recordsTitle": {
    "zh-CN": "记录卡片",
    "en": "Record cards"
  },
  "recordsDescription": {
    "zh-CN": "展示结构较松散的对象数组，每项以紧凑卡片呈现。",
    "en": "Show a loosely structured array of objects as compact cards."
  },
  "recordsReturn": {
    "zh-CN": "- 默认 return { records: [...] }；如果 renderer 配置了 itemsPath/valuePath，则该路径必须是对象数组。",
    "en": "- Return { records: [...] } by default. If itemsPath/valuePath is configured, that path must contain an array of objects."
  },
  "imageGridTitle": {
    "zh-CN": "图片网格",
    "en": "Image grid"
  },
  "imageGridDescription": {
    "zh-CN": "展示密集图片缩略图网格，适合图集、截图、素材候选。",
    "en": "Show a dense thumbnail grid for image collections, screenshots, or candidate assets."
  },
  "imageGridReturn": {
    "zh-CN": "- 默认 return { images: [...] }，每项建议包含 url/src/imageUrl/title/width/height；如果配置 itemsPath/valuePath，则该路径必须是图片对象数组。",
    "en": "- Return { images: [...] } by default. Suggested item fields: url/src/imageUrl/title/width/height. If itemsPath/valuePath is configured, that path must contain an array of image objects."
  },
  "treeTitle": {
    "zh-CN": "树结构",
    "en": "Tree"
  },
  "treeDescription": {
    "zh-CN": "展示层级结构，适合 DOM、AX Tree、目录、导航树。",
    "en": "Show a hierarchy such as a DOM, accessibility tree, directory, or navigation tree."
  },
  "treeShape": {
    "zh-CN": "{ title?: string, url?: string, nodes?: Array<object> } 或 { lines: Array<string | object> }",
    "en": "{ title?: string, url?: string, nodes?: Array<object> } or { lines: Array<string | object> }"
  },
  "treeReturn": {
    "zh-CN": "- 默认 return { title?, url?, nodes:[...] } 或 { lines:[...] }；node 建议包含 depth/role/name/text/meta/url/selector。",
    "en": "- Return { title?, url?, nodes:[...] } or { lines:[...] } by default. Suggested node fields: depth/role/name/text/meta/url/selector."
  },
  "diffTitle": {
    "zh-CN": "变更",
    "en": "Changes"
  },
  "diffDescription": {
    "zh-CN": "展示 patch/diff 文本或多段文件变更。",
    "en": "Show patch/diff text or changes across multiple files."
  },
  "diffShape": {
    "zh-CN": "{ patch?: string, diff?: string } 或 { changes: Array<{ path?: string, preview: string }> }",
    "en": "{ patch?: string, diff?: string } or { changes: Array<{ path?: string, preview: string }> }"
  },
  "diffReturn": {
    "zh-CN": "- 默认 return { patch: string } 或 { diff: string }；多文件变更可 return { changes:[{ path, preview }] }。",
    "en": "- Return { patch: string } or { diff: string } by default. For multiple files, return { changes:[{ path, preview }] }."
  },
  "markdownDescription": {
    "zh-CN": "展示短 Markdown 内容。",
    "en": "Show a short Markdown document."
  },
  "markdownReturn": {
    "zh-CN": "- 默认 return { markdown: string }，也可用 content/text 字段。",
    "en": "- Return { markdown: string } by default. content/text fields are also supported."
  },
  "jsonDescription": {
    "zh-CN": "展示可序列化 JSON 对象。",
    "en": "Show a serializable JSON object."
  },
  "jsonReturn": {
    "zh-CN": "- return 任意可序列化 JSON 对象。",
    "en": "- Return any serializable JSON object."
  },
  "codeTitle": {
    "zh-CN": "代码",
    "en": "Code"
  },
  "codeDescription": {
    "zh-CN": "展示带高亮和复制按钮的代码或文件内容。",
    "en": "Show code or file content with syntax highlighting and a copy button."
  },
  "codeReturn": {
    "zh-CN": "- 默认 return { code: string, language?: string, filename?: string }。",
    "en": "- Return { code: string, language?: string, filename?: string } by default."
  },
  "skillTitle": {
    "zh-CN": "技能变更",
    "en": "Skill changes"
  },
  "skillDescription": {
    "zh-CN": "展示创建、资源编辑、更新、删除 skill 的专用状态。",
    "en": "Show the status of Skill creation, resource edits, updates, or deletion."
  },
  "skillReturn": {
    "zh-CN": "- return manage_skill 风格结果对象，包含 action/name/saved 或 updated/deleted 等状态字段。",
    "en": "- Return a manage_skill-style result with status fields such as action/name/saved or updated/deleted."
  },
  "returnContract": {
    "zh-CN": "返回格式契约：该工具配置了 UI renderer，脚本最终 return 必须匹配以下 JSON 形状，不要把主要数据包在 result 字段里。",
    "en": "Return contract: this tool has a UI renderer. The script's final return value must match the following JSON shape. Do not wrap the main data in a result field."
  },
  "layoutReturnContract": {
    "zh-CN": "返回格式契约：该工具配置了组合 UI renderer，脚本最终 return 必须是一个对象，按 result block 的 sourcePath 提供数据；不要把主要数据包在 result 字段里。",
    "en": "Return contract: this tool has a composite UI renderer. Return an object with data at each result block's sourcePath. Do not wrap the main data in a result field."
  },
  "layoutInputContract": {
    "zh-CN": "返回格式契约：该组合 UI renderer 仅读取工具调用参数，不要求脚本把输入复制到 return。脚本仍应 return 简洁、可序列化的执行结果。",
    "en": "Return contract: this composite UI renderer reads only tool arguments. Do not copy inputs into the return value. Still return a concise, serializable execution result."
  },
  "rootObject": {
    "zh-CN": "顶层对象",
    "en": "Top-level object"
  },
  "layoutExample": {
    "zh-CN": "- 组合示例：{ summary: {...}, videos: { rows: [...] }, notes: { markdown: \"...\" } }。",
    "en": "- Composite example: { summary: {...}, videos: { rows: [...] }, notes: { markdown: \"...\" } }."
  },
  "inputContract": {
    "zh-CN": "展示数据源契约：该 UI renderer 读取工具调用参数，不要求脚本把输入复制到 return。",
    "en": "Data source contract: this UI renderer reads tool arguments. Do not copy inputs into the return value."
  },
  "inputReturn": {
    "zh-CN": "- 脚本仍应 return 简洁、可序列化的执行结果；不要 return 大段 raw JSON 字符串。",
    "en": "- Still return a concise, serializable execution result; do not return large raw JSON strings."
  },
  "defaultReturnContract": {
    "zh-CN": "返回格式契约：脚本最终 return 必须匹配 renderer JSON 形状。",
    "en": "Return contract: the script's final return value must match the renderer's JSON shape."
  },
  "avoidRawJson": {
    "zh-CN": "- 不要 return 大段 raw JSON 字符串；需要调试信息放 trace 或少量 debug 字段。",
    "en": "- Do not return large raw JSON strings. Put diagnostics in trace or a few small debug fields."
  },
  "summaryFieldsLabel": {
    "zh-CN": "return 一个对象，顶层或对应路径包含字段",
    "en": "Return an object with these fields at the top level or configured paths"
  },
  "summaryReturn": {
    "zh-CN": "- return 一个简洁对象，字段值应为字符串、数字、布尔值或短数组。",
    "en": "- Return a concise object with strings, numbers, booleans, or short arrays as field values."
  }
});

export const rendererT = createTranslator(messages);

import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("documents-model", {
  saveFile: {
    "zh-CN": "保存内容到用户下载目录。支持文本、JSON、CSV、HTML、Markdown 等任意格式。用于保存采集结果、导出数据等。filename 可选；缺省时会根据内容和 MIME 自动生成文件名。",
    en: "Save content to the user's Downloads folder in text, JSON, CSV, HTML, Markdown, or other formats. Use for collected results and data exports. filename is optional: if omitted, a name is generated from the content and MIME type.",
  },
  saveFilename: {
    "zh-CN": "可选文件名，如 results.md、data.json、report.csv；不填时自动生成 qingzhou-output-时间戳.*。",
    en: "Optional filename, such as results.md, data.json, or report.csv. If omitted, generates qingzhou-output-<timestamp>.*.",
  },
  saveMimeType: {
    "zh-CN": "MIME 类型，默认根据扩展名自动推断",
    en: "MIME type. Inferred from the filename extension by default.",
  },
  saveContent: {
    "zh-CN": "文件内容。该字段可能很长，填写 filename/mimeType 后最后填写 content。",
    en: "File content. This field may be long; provide it last, after filename/mimeType.",
  },
  listDownloads: {
    "zh-CN": "查看最近的下载列表及状态。保存或下载后，用返回的 downloadId 作为 id 精确查询。已完成且仍存在的文件会返回真实 fileUrl；预览时使用此地址，不要猜测本地路径。文件名只用于人工搜索。",
    en: "List recent downloads and their status. After saving or downloading, pass the returned downloadId as id to check that exact download. A completed file that still exists includes its actual fileUrl; use that URL for preview instead of guessing a local path. Filename search is only for manual lookup.",
  },
  downloadId: {
    "zh-CN": "Chrome 下载 ID；使用保存或下载工具返回的 downloadId。",
    en: "Chrome download ID returned by a save or download tool.",
  },
  downloadLimit: {
    "zh-CN": "返回数量，默认 10",
    en: "Maximum results to return. Default: 10.",
  },
  downloadQuery: {
    "zh-CN": "按 Chrome 实际保存路径过滤；已知 downloadId 时优先传 id",
    en: "Filter by the path Chrome actually saved. Prefer id when downloadId is known.",
  },
  downloadUrl: {
    "zh-CN": "下载指定 URL 的文件（图片、PDF 等）到用户下载目录，并登记为当前任务的文件产物。",
    en: "Download a file (such as an image or PDF) from a URL to the user's Downloads folder and register it as a file artifact for the current task.",
  },
  fileUrl: {
    "zh-CN": "文件 URL",
    en: "File URL.",
  },
  fileDownloadName: {
    "zh-CN": "保存文件名（可选）",
    en: "Optional download filename.",
  },
  fileFetched: {
    "zh-CN": "已保存到本地文档文件库。下一步通常解析为 docModel；如果只需转换格式，可基于解析结果直接生成新文件。",
    en: "Saved to the local document library. Usually, parse it into a docModel next. For format conversion, generate a new file directly from the parsed model.",
  },
  fileParsed: {
    "zh-CN": "已生成 docModelId。长文档请按块读取；如果只需转换格式，可直接基于 docModel 生成新文件。",
    en: "Created docModelId. Read long documents in chunks. For format conversion, generate a new file directly from the docModel.",
  },
  documentFetch: {
    "zh-CN": "将网页中的 Word、Excel、PDF、HTML、CSV、TXT、Markdown、代码、配置或日志附件拉取到轻舟本地文档库，返回 fileId。后续通常调用 qingzhou_documents__document_parse；如果只需原样下载，不要使用本工具，改用 download_url。",
    en: "Fetch a Word, Excel, PDF, HTML, CSV, TXT, Markdown, code, configuration, or log attachment into qz's local document library and return fileId. Usually followed by qingzhou_documents__document_parse. For downloading the original file unchanged, use download_url instead.",
  },
  documentUrl: {
    "zh-CN": "附件 URL，支持 docx/xlsx/pdf/html/csv/txt/md 以及常见代码、配置和日志文件。",
    en: "Attachment URL. Supports docx/xlsx/pdf/html/csv/txt/md and common code, configuration, and log files.",
  },
  documentFilename: {
    "zh-CN": "本地文档库文件名；不填时从响应头或 URL 推断。",
    en: "Filename in the local document library. If omitted, inferred from response headers or the URL.",
  },
  documentMimeType: {
    "zh-CN": "MIME 类型；不填时从响应头推断。",
    en: "MIME type. If omitted, inferred from response headers.",
  },
  documentParse: {
    "zh-CN": "将已拉取的本地文件解析为结构化 docModel，支持 Office、PDF、HTML、CSV、文本、Markdown、代码、配置和日志。不要把整份长文档塞进上下文；拿到 docModelId 后按需调用 qingzhou_documents__document_read_chunk，或直接用 qingzhou_documents__document_create 转换格式。",
    en: "Parse a fetched local file into a structured docModel. Supports Office, PDF, HTML, CSV, text, Markdown, code, configuration, and logs. Do not put an entire long document in context. After obtaining docModelId, read selected chunks with qingzhou_documents__document_read_chunk or convert formats directly with qingzhou_documents__document_create.",
  },
  documentFileId: {
    "zh-CN": "qingzhou_documents__document_fetch 返回的 fileId。",
    en: "fileId returned by qingzhou_documents__document_fetch.",
  },
  documentChunkSize: {
    "zh-CN": "每个文本块的目标字符数，默认 6000。",
    en: "Target characters per text chunk. Default: 6000.",
  },
  documentReadChunk: {
    "zh-CN": "小块读取 docModel，避免长文档挤占上下文。正文按 chunkIndex 返回 Markdown；表格按返回的 tableId（Excel 也兼容 sheetName）配合 offset、limit 分页读取结构化行。继续读取时保留 docModelId，并从结果中的 next 继续。",
    en: "Read small portions of a docModel to preserve context space. Text is returned as Markdown by chunkIndex. Read structured table rows using the returned tableId (sheetName is also supported for Excel), offset, and limit. Keep docModelId and continue from next in the result.",
  },
  documentModelId: {
    "zh-CN": "qingzhou_documents__document_parse 返回的 docModelId。",
    en: "docModelId returned by qingzhou_documents__document_parse.",
  },
  documentChunkIndex: {
    "zh-CN": "文本块序号，从 0 开始；默认 0。",
    en: "Zero-based text chunk index. Default: 0.",
  },
  documentTableId: {
    "zh-CN": "正文读取结果中 tables 返回的稳定表格标识；传入后按表格行读取。",
    en: "Stable table ID from tables in a text-reading result. When provided, reads table rows.",
  },
  documentSheetName: {
    "zh-CN": "Excel/CSV sheet 名称；为兼容入口，优先使用返回的 tableId。",
    en: "Excel/CSV sheet name, supported for compatibility. Prefer the returned tableId.",
  },
  documentOffset: {
    "zh-CN": "表格起始行，默认 0。",
    en: "Starting table row. Default: 0.",
  },
  documentLimit: {
    "zh-CN": "表格读取行数，默认 50，最多 200。",
    en: "Table rows to read. Default: 50; maximum: 200.",
  },
  documentOutputFilename: {
    "zh-CN": "输出文件名，例如 result.pdf。",
    en: "Output filename, for example result.pdf.",
  },
  documentTitle: {
    "zh-CN": "文档元数据标题，也用于未填写 filename 时生成默认文件名；不会自动写入正文。需要可见标题时，在 blocks 中传 {type:'heading', level:1, text:'标题'}。",
    en: "Document metadata title, also used to generate a default filename when filename is omitted. It is not inserted into the document body. For a visible title, add {type:'heading', level:1, text:'Title'} to blocks.",
  },
  documentSourceModel: {
    "zh-CN": "qingzhou_documents__document_parse 返回的 docModelId；大文档优先使用。",
    en: "docModelId returned by qingzhou_documents__document_parse. Prefer this for large documents.",
  },
  documentAutoDownload: {
    "zh-CN": "创建后是否立即加入下载列表，默认 true。",
    en: "Add the file to Chrome downloads immediately after creation. Default: true.",
  },
  documentSaveAs: {
    "zh-CN": "下载时是否弹出另存为，默认 false。",
    en: "Show a Save As dialog when downloading. Default: false.",
  },
  documentBlocks: {
    "zh-CN": "少量文档块。每项必须使用 {type:'heading', text:'标题', level:1}、{type:'paragraph', text:'正文'}、{type:'list', items:['事项']} 或 {type:'table', columns:['列名'], rows:[['值']]} 等规范结构；不接受 {heading:...}/{table:true}/{list:[...]} 简写。不要传超大数组；先填写 format/filename/docModelId/download/saveAs，最后填写本字段。",
    en: "A small array of document blocks. Each item must use a supported shape, such as {type:'heading', text:'Title', level:1}, {type:'paragraph', text:'Body'}, {type:'list', items:['Item']}, or {type:'table', columns:['Column'], rows:[['Value']]}. Shorthand such as {heading:...}, {table:true}, or {list:[...]} is not accepted. Avoid large arrays. Provide this field last, after format/filename/docModelId/download/saveAs.",
  },
  documentSheets: {
    "zh-CN": "少量 Excel sheets：{name, columns, rows}。rows 的每个元素就是一行：对象行使用 rows:[{\"公司\":\"A\"},{\"公司\":\"B\"}]，数组行使用 rows:[[\"A\"],[\"B\"]]，不要写成 rows:[[{\"公司\":\"A\"},{\"公司\":\"B\"}]]。单张表内不可混用行结构。大表格先写入 data_store 或使用 docModelId；先填写定位参数，最后填写本字段。",
    en: "A small array of Excel sheets: {name, columns, rows}. Each rows element is one row. Use rows:[{\"Company\":\"A\"},{\"Company\":\"B\"}] for object rows or rows:[[\"A\"],[\"B\"]] for array rows, never rows:[[{\"Company\":\"A\"},{\"Company\":\"B\"}]]. Do not mix row shapes within a sheet. Store large tables with data_store or use docModelId. Provide identifying parameters first and this field last.",
  },
  documentDownload: {
    "zh-CN": "将 qingzhou_documents__document_create 已生成但尚未下载的 artifact，或任务中已有的文档 artifact，加入 Chrome 下载列表。",
    en: "Add an artifact created by qingzhou_documents__document_create but not yet downloaded, or an existing document artifact in this task, to Chrome downloads.",
  },
  documentArtifactId: {
    "zh-CN": "qingzhou_documents__document_create 或 qingzhou_documents__document_list_artifacts 返回的 artifactId。",
    en: "artifactId returned by qingzhou_documents__document_create or qingzhou_documents__document_list_artifacts.",
  },
  documentDownloadFilename: {
    "zh-CN": "下载文件名，可不填。",
    en: "Optional download filename.",
  },
  documentDownloadSaveAs: {
    "zh-CN": "是否弹出另存为，默认 false。",
    en: "Show a Save As dialog. Default: false.",
  },
  documentListArtifacts: {
    "zh-CN": "列出当前任务最近生成的文档产物，便于查找 artifactId 或重新下载。",
    en: "List document artifacts recently generated in this task to find artifactId values or download files again.",
  },
  documentArtifactLimit: {
    "zh-CN": "返回数量，默认 20，最多 100。",
    en: "Maximum results to return. Default: 20; maximum: 100.",
  },
  builtinContent: {
    "zh-CN": `# 文档处理

处理网页附件、Office、PDF、HTML、CSV、文本、Markdown、代码、配置和日志文件。此 skill 的工具只在加载后出现；调用下面列出的命名空间工具，不要猜测或调用隐藏的 core 工具名。

## 先选路径

- 只把远程文件原样下载到用户设备：使用常驻的 \`download_url\`，不进入文档解析链路。
- 只保存少量已生成文本：使用常驻的 \`save_file\`。
- 需要读取、提取、转换或基于附件生成新文件：使用本 skill。
- DOCX、XLSX、PDF 来自其他 Skill 的资源时，先调用 \`load_skill_resource(name,path)\`；它会直接完成文件注册与解析并返回 \`docModelId\`，无需再调用 \`{FETCH}\` / \`{PARSE}\`。
- 需要从少量结构化内容直接生成文件：可以从 \`{CREATE}\` 开始；大文档、大表格不要重写成长参数，先形成 docModel 或 data_store。

## 标准流程

1. 远程附件先调用 \`{FETCH}\`，保存到当前任务的文档库并取得 \`fileId\`。
2. 调用 \`{PARSE}\` 得到 \`docModelId\`、目录、块数和 sheet 摘要。不要把全文重新输出到主对话。
3. 需要阅读内容时调用 \`{READ_CHUNK}\`：正文按 \`chunkIndex\` 返回 Markdown；遇到正文中的表格引用，按结果给出的 \`tableId + offset + limit\` 分页读取结构化行。Excel/CSV 默认读取首个 sheet，也兼容用 \`sheetName\` 定位。继续读取时保留 \`docModelId\` 并沿用结果中的 \`next\`，只读完成任务所需范围。
4. 只做格式转换时无需逐块读取，直接把 \`docModelId\` 交给 \`{CREATE}\`。大文档必须通过 \`docModelId\` 传入；生成新内容时，只有少量 \`blocks/sheets\` 可以直接传入。每次调用和重试都必须显式填写 \`format\`，可选值仅为 {CREATE_FORMAT_VALUES}。用户明确指定目标格式时必须传对应值并直接生成，不要创建其他中间格式；先填写 format、filename、docModelId、download、saveAs，最后填写长数组。
5. \`{CREATE}\` 默认 \`download:true\`，会同时生成 artifact 并加入 Chrome 下载列表。用户明确不要立即下载时传 \`download:false\`。
6. 需要稍后下载或重新下载时，先用 \`{LIST_ARTIFACTS}\` 找到当前任务的 \`artifactId\`，再调用 \`{DOWNLOAD}\`。

## 内容与格式

- 支持输入：docx、xlsx、pdf、html、csv、txt、md，以及常见代码、配置和日志文件。
- 支持输出：docx、xlsx、pdf、html、txt、csv。
- \`title\` 只作为文档元数据和未填写 filename 时的默认文件名，不会自动写入正文；需要可见标题时使用 \`{type:"heading",level:1,text:"标题"}\` block。
- 直接传 blocks 时每项都必须显式填写 type，例如 \`{type:"heading",text:"标题",level:1}\`、\`{type:"paragraph",text:"正文"}\`、\`{type:"list",items:["事项"]}\`、\`{type:"table",columns:["列名"],rows:[["值"]]}\`。不要使用 \`{heading:...}\`、\`{table:true}\`、\`{list:[...]}\` 简写。
- Word/PDF 的普通编号清单使用 list 或 paragraph；heading 只用于真实章节，避免污染目录。
- Excel 的 columns 使用稳定原始表头；rows 的每个元素就是一行：对象行写成 \`rows:[{"公司":"A"},{"公司":"B"}]\`，数组行写成 \`rows:[["A"],["B"]]\`，不要写成 \`rows:[[{"公司":"A"},{"公司":"B"}]]\`，同一张表不要混用两种行结构。CSV 只支持一个 table/sheet。大表优先通过 data_store 或解析后的 docModel 处理。
- 长文档必须分块读取。正文结果已经是整理后的 Markdown，不需要再处理 blocks；不要为了总结而把全部 chunk 或大表复制进上下文。

## 边界与验证

- fileId、docModelId、artifactId 都属于创建它们的 session；不要跨任务复用。
- 生成前确认目标格式、文件名和是否立即下载；这些定位参数必须先于大段内容确定。
- 完成后核对返回的 filename、format、size、artifactId 和 downloaded 状态。最终回复只给摘要、文件名和必要限制，不复制整份文档正文。`,
    en: `# Document processing

Process web attachments, Office, PDF, HTML, CSV, text, Markdown, code, configuration, and log files. These tools become available only after loading this Skill. Use the namespaced tools listed below; do not guess or call hidden core tool names.

## Choose the workflow

- To download a remote file unchanged to the user's device, use the always-available \`download_url\`; do not parse the document.
- To save a small amount of generated text, use the always-available \`save_file\`.
- Use this Skill to read, extract, convert, or generate a new file from an attachment.
- For DOCX, XLSX, or PDF resources from another Skill, first call \`load_skill_resource(name,path)\`. It registers and parses the file, returning \`docModelId\`; do not call \`{FETCH}\` / \`{PARSE}\` again.
- To generate a file from a small amount of structured content, start with \`{CREATE}\`. For large documents or tables, create a docModel or use data_store instead of writing long tool arguments.

## Standard workflow

1. Fetch a remote attachment with \`{FETCH}\` to the current task's document library and obtain \`fileId\`.
2. Call \`{PARSE}\` to obtain \`docModelId\`, an outline, chunk count, and sheet summaries. Do not reproduce the entire text in the main conversation.
3. Read content with \`{READ_CHUNK}\`. Text is returned as Markdown by \`chunkIndex\`. For a table reference in the text, use the returned \`tableId + offset + limit\` to page through structured rows. Excel/CSV defaults to the first sheet; \`sheetName\` is also supported. Keep \`docModelId\`, follow \`next\` in the result, and read only the ranges needed for the task.
4. For format conversion alone, pass \`docModelId\` directly to \`{CREATE}\` without reading every chunk. Large documents must use \`docModelId\`; only small \`blocks/sheets\` arrays may be supplied directly for new content. Every call and retry must specify \`format\`, choosing only from {CREATE_FORMAT_VALUES}. If the user requests a format, generate it directly without intermediate formats. Supply format, filename, docModelId, download, and saveAs before long arrays.
5. \`{CREATE}\` defaults to \`download:true\`, creating an artifact and adding it to Chrome downloads. Set \`download:false\` only when the user explicitly does not want an immediate download.
6. To download later or again, find the current task's \`artifactId\` with \`{LIST_ARTIFACTS}\`, then call \`{DOWNLOAD}\`.

## Content and formats

- Supported inputs: docx, xlsx, pdf, html, csv, txt, md, and common code, configuration, and log files.
- Supported outputs: docx, xlsx, pdf, html, txt, csv.
- \`title\` is document metadata and the default filename when filename is omitted. It is not inserted into the body. For a visible title, add a \`{type:"heading",level:1,text:"Title"}\` block.
- Every directly supplied block must specify type, for example \`{type:"heading",text:"Title",level:1}\`, \`{type:"paragraph",text:"Body"}\`, \`{type:"list",items:["Item"]}\`, or \`{type:"table",columns:["Column"],rows:[["Value"]]}\`. Do not use shorthand such as \`{heading:...}\`, \`{table:true}\`, or \`{list:[...]}\`.
- Use list or paragraph for ordinary numbered items in Word/PDF. Reserve heading for actual sections to avoid cluttering the table of contents.
- For Excel, preserve stable original headers in columns. Each rows element is one row: use \`rows:[{"Company":"A"},{"Company":"B"}]\` for object rows or \`rows:[["A"],["B"]]\` for array rows, never \`rows:[[{"Company":"A"},{"Company":"B"}]]\`. Do not mix the two row shapes in a sheet. CSV supports one table/sheet. Prefer data_store or a parsed docModel for large tables.
- Read long documents in chunks. Text results are already normalized Markdown; no further blocks processing is needed. Do not copy every chunk or a large table into context just to summarize it.

## Boundaries and verification

- fileId, docModelId, and artifactId belong to the session that created them. Do not reuse them across tasks.
- Determine the target format, filename, and whether to download immediately before generating large amounts of content.
- After generation, verify filename, format, size, artifactId, and downloaded. The final response should contain a summary, filename, and material limitations, not the entire document body.`,
  },
  documentsDisplayName: {
    "zh-CN": "文档处理",
    en: "Document processing",
  },
  documentsDescription: {
    "zh-CN": "拉取、解析、分块阅读、转换和生成 PDF、Word、Excel、CSV、HTML 或文本文件。用户要求处理网页附件、阅读长文档、转换文件格式或生成正式文档产物时加载；原样下载 URL 或保存少量文本文件无需加载。",
    en: "Fetch, parse, read in chunks, convert, and generate PDF, Word, Excel, CSV, HTML, or text files. Load when the user needs to process web attachments, read long documents, convert formats, or generate document artifacts. Not needed to download a URL unchanged or save a small text file.",
  },
  documentsCategory: {
    "zh-CN": "文档",
    en: "Documents",
  },
  documentsManifestTitle: {
    "zh-CN": "文档处理 Skill 工具清单",
    en: "Document processing Skill tool manifest",
  },
  documentsManifestDescription: {
    "zh-CN": "声明按需加载的文档处理 host 工具。",
    en: "Declares on-demand document processing host tools.",
  },
  documentsScriptDescription: {
    "zh-CN": "文档处理 host runtime 转发脚本。",
    en: "Document processing host runtime forwarding script.",
  },
  documentCreate: {
    "zh-CN": "根据 docModelId 或少量 blocks/sheets 生成本地产物。format 必填且只能是 {DOCUMENT_OUTPUT_FORMAT_LITERALS}；用户明确指定目标格式时必须传对应值并直接生成，不要创建其他中间格式。每次重试仍须显式传 format；直接传 blocks 时每个 block 都必须显式传 type。大文档必须传 docModelId，不要让模型重新输出整份 blocks；download 默认 true，会直接加入 Chrome 下载列表。",
    en: "Generate a local artifact from docModelId or a small blocks/sheets array. format is required and must be one of {DOCUMENT_OUTPUT_FORMAT_LITERALS}. If the user specifies a target format, generate that format directly without intermediates. Explicitly supply format on every retry. Every directly supplied block must have type. Large documents must use docModelId; do not regenerate the entire blocks array. download defaults to true and adds the artifact to Chrome downloads.",
  },
  documentFormat: {
    "zh-CN": "必填，只能是 {DOCUMENT_OUTPUT_FORMAT_LITERALS}。必须与用户要求的目标格式一致；重试时也必须再次传入。",
    en: "Required. Must be one of {DOCUMENT_OUTPUT_FORMAT_LITERALS} and match the format requested by the user. Supply it again on every retry.",
  },
  formatSeparator: { "zh-CN": "、", en: ", " },
});

export const modelT = createTranslator(messages);

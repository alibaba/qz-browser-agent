import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("documents-model", {
  saveFile: {
    "zh-CN": "将文本内容（文本、JSON、CSV、HTML、Markdown、SVG 等）保存到用户下载目录，返回 downloadId、filename、mimeType 和 size。filename 省略时根据内容和 MIME 自动生成文件名。",
    en: "Save text content (plain text, JSON, CSV, HTML, Markdown, SVG, etc.) to the user's Downloads folder, returning downloadId, filename, mimeType, and size. Automatically generates a filename from content and MIME type when filename is omitted.",
  },
  saveFilename: {
    "zh-CN": "可选保存文件名（如 results.md、data.json、report.csv）；省略时自动生成 qingzhou-output-时间戳.*。",
    en: "Optional filename (e.g. results.md, data.json, report.csv); defaults to qingzhou-output-<timestamp>.*.",
  },
  saveMimeType: {
    "zh-CN": "可选 MIME 类型；省略时按扩展名或内容自动推断。",
    en: "Optional MIME type; inferred from the extension or content when omitted.",
  },
  saveContent: {
    "zh-CN": "必填。要保存的文本内容（可能较长，先填 filename/mimeType，最后填 content）。",
    en: "Required text content to save (supply filename/mimeType first and content last).",
  },
  listDownloads: {
    "zh-CN": "查询最近的浏览器下载项及状态（按开始时间倒序）。传入保存或下载工具返回的 downloadId 作为 id 可精确核验；当传入 id 且文件已完成并存在时，额外返回真实 fileUrl。",
    en: "List recent browser downloads and their status (newest first). Pass a returned downloadId as id to check that exact item; when id is specified and the file is complete and present on disk, returns its fileUrl.",
  },
  downloadId: {
    "zh-CN": "save_file、download_url 或 document_create/document_download 返回的 downloadId。",
    en: "downloadId returned by save_file, download_url, or document_create/document_download.",
  },
  downloadLimit: {
    "zh-CN": "最多返回条数，默认 10。",
    en: "Maximum items to return. Default: 10.",
  },
  downloadQuery: {
    "zh-CN": "匹配本地保存路径的正则表达式（已知 downloadId 时优先传 id）。",
    en: "Regular expression matched against the local saved path (prefer id when downloadId is known).",
  },
  downloadUrl: {
    "zh-CN": "将远程 URL 文件原样下载到用户下载目录并登记为当前任务文件产物，返回 downloadId。",
    en: "Download a remote URL unchanged to the user's Downloads folder and register it as a file artifact for the current task, returning downloadId.",
  },
  fileUrl: {
    "zh-CN": "必填。要下载的远程文件 URL。",
    en: "Required remote file URL to download.",
  },
  fileDownloadName: {
    "zh-CN": "可选保存文件名。",
    en: "Optional target filename.",
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
    "zh-CN": "将远程文档附件（docx/xlsx/pdf/html/csv/txt/md 及常见代码/配置/日志）拉取到当前任务文档库并返回 fileId，供后续 qingzhou_documents__document_parse 解析。仅需原样下载文件时请用 download_url。",
    en: "Fetch a remote document attachment (docx/xlsx/pdf/html/csv/txt/md or code/config/log file) into the current task's document library and return fileId for qingzhou_documents__document_parse. Use download_url instead to download a file unchanged.",
  },
  documentUrl: {
    "zh-CN": "必填。远程文档 HTTP(S) URL。",
    en: "Required HTTP(S) URL of the remote document.",
  },
  documentFilename: {
    "zh-CN": "可选文档库文件名；省略时从响应头或 URL 推断。",
    en: "Optional filename in the document library; inferred from response headers or URL if omitted.",
  },
  documentMimeType: {
    "zh-CN": "可选 MIME 类型；省略时从响应头或文件名推断。",
    en: "Optional MIME type; inferred from response headers or filename if omitted.",
  },
  documentParse: {
    "zh-CN": "将 fileId 对应的本地文件解析为结构化 docModel，返回 docModelId、目录、分块数与表格摘要。随后用 qingzhou_documents__document_read_chunk 按需分块读取，或用 qingzhou_documents__document_create 转换格式。",
    en: "Parse a fetched local file (fileId) into a structured docModel, returning docModelId, outline, chunk count, and table summaries. Read chunks with qingzhou_documents__document_read_chunk or convert formats with qingzhou_documents__document_create.",
  },
  documentFileId: {
    "zh-CN": "必填。qingzhou_documents__document_fetch 返回的 fileId。",
    en: "Required fileId returned by qingzhou_documents__document_fetch.",
  },
  documentChunkSize: {
    "zh-CN": "每个文本块的目标字符数，默认 6000。",
    en: "Target characters per text chunk. Default: 6000.",
  },
  documentReadChunk: {
    "zh-CN": "按块或按表分页读取 docModel：不传 tableId/sheetName 时按 chunkIndex 返回正文 Markdown；传 tableId（或 Excel/CSV 的 sheetName）配合 offset/limit 分页读取表格行。沿用返回结果中的 next 继续读取。",
    en: "Read a docModel by text chunk or table page: omit tableId/sheetName to read Markdown text by chunkIndex; pass tableId (or sheetName for Excel/CSV) with offset/limit to page through table rows. Follow next in the result to continue.",
  },
  documentModelId: {
    "zh-CN": "必填。qingzhou_documents__document_parse 或 load_skill_resource 返回的 docModelId。",
    en: "Required docModelId returned by qingzhou_documents__document_parse or load_skill_resource.",
  },
  documentChunkIndex: {
    "zh-CN": "正文块序号（0-based），默认 0。",
    en: "0-based text chunk index. Default: 0.",
  },
  documentTableId: {
    "zh-CN": "要读取的稳定表格标识（来自解析结果或正文块中的 tables）。",
    en: "Stable table ID to read (from parse results or tables in a text chunk).",
  },
  documentSheetName: {
    "zh-CN": "Excel/CSV 工作表名称（优先使用 tableId）。",
    en: "Excel/CSV sheet name (prefer tableId when available).",
  },
  documentOffset: {
    "zh-CN": "表格读取起始行偏移，默认 0。",
    en: "Starting row offset for table reads. Default: 0.",
  },
  documentLimit: {
    "zh-CN": "表格单次读取行数，默认 50，范围 1–200。",
    en: "Number of table rows to read. Default: 50; range: 1–200.",
  },
  documentOutputFilename: {
    "zh-CN": "输出文件名，如 result.pdf。",
    en: "Output filename, such as result.pdf.",
  },
  documentTitle: {
    "zh-CN": "文档元数据标题，未填 filename 时也作默认文件名，不会自动写入正文；需要可见标题时在 blocks 中传 {type:'heading', level:1, text:'标题'}。",
    en: "Document metadata title, also used as the default filename when filename is omitted and not inserted into body text; add {type:'heading', level:1, text:'Title'} to blocks for a visible heading.",
  },
  documentSourceModel: {
    "zh-CN": "来源 docModelId（不可与 blocks/sheets 同时传入；长文档转换优先使用）。",
    en: "Source docModelId (cannot be combined with blocks/sheets; preferred for large documents).",
  },
  documentAutoDownload: {
    "zh-CN": "生成后是否立即加入浏览器下载列表，默认 true。",
    en: "Add the generated file to browser downloads immediately. Default: true.",
  },
  documentSaveAs: {
    "zh-CN": "下载时是否弹出另存为对话框，默认 false。",
    en: "Show a Save As dialog when downloading. Default: false.",
  },
  documentBlocks: {
    "zh-CN": "直接传入的少量内容块数组（JSON 序列化不超过 200,000 字符；不可与 docModelId 同用）。每项必须含显式 type（如 {type:'heading', level:1, text:'...'}、{type:'paragraph', text:'...'}、{type:'list', items:['...']}、{type:'table', columns:['...'], rows:[['...']]}，禁止 {heading:...} 等简写；xlsx/csv 仅允许 table 块）。先填 format/filename/title/download/saveAs，最后填本字段。",
    en: "Small array of content blocks (at most 200,000 JSON chars; cannot be combined with docModelId). Each block must specify type (e.g. {type:'heading', level:1, text:'...'}, {type:'paragraph', text:'...'}, {type:'list', items:['...']}, {type:'table', columns:['...'], rows:[['...']]}; shorthand like {heading:...} is rejected; xlsx/csv accepts table blocks only). Supply this field last.",
  },
  documentSheets: {
    "zh-CN": "直接传入的少量工作表数组 {name, columns, rows, header}（不可与 docModelId 或 table blocks 同用；csv 仅支持单张表）。rows 的每个元素就是一行：对象行 rows:[{\"公司\":\"A\"},{\"公司\":\"B\"}] 或数组行 rows:[[\"A\"],[\"B\"]]，不要写成 rows:[[{\"公司\":\"A\"},{\"公司\":\"B\"}]]，单表内不可混用。先填控制参数，最后填本字段。",
    en: "Small array of worksheets {name, columns, rows, header} (cannot be combined with docModelId or table blocks; csv supports one sheet only). Each rows element is one row: object rows rows:[{\"Company\":\"A\"},{\"Company\":\"B\"}] or array rows rows:[[\"A\"],[\"B\"]], never rows:[[{\"Company\":\"A\"},{\"Company\":\"B\"}]], without mixing in a sheet. Supply control arguments first and this field last.",
  },
  documentDownload: {
    "zh-CN": "将当前任务已生成的文档产物（artifactId）加入浏览器下载列表。",
    en: "Add a generated document artifact (artifactId) from the current task to browser downloads.",
  },
  documentArtifactId: {
    "zh-CN": "必填。qingzhou_documents__document_create 或 document_list_artifacts 返回的 artifactId。",
    en: "Required artifactId from qingzhou_documents__document_create or document_list_artifacts.",
  },
  documentDownloadFilename: {
    "zh-CN": "可选下载文件名。",
    en: "Optional download filename.",
  },
  documentDownloadSaveAs: {
    "zh-CN": "是否弹出另存为对话框，默认 false。",
    en: "Show a Save As dialog. Default: false.",
  },
  documentListArtifacts: {
    "zh-CN": "列出当前任务已生成的文档产物摘要及 artifactId。",
    en: "List document artifacts generated in the current task with their artifactIds.",
  },
  documentArtifactLimit: {
    "zh-CN": "最多返回数量，默认 20，范围 1–100。",
    en: "Maximum artifacts to return. Default: 20; range: 1–100.",
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
    "zh-CN": "根据 docModelId 或少量 blocks/sheets 生成文档产物（默认 download:true 直接加入下载列表）。format 必填且只能是 {DOCUMENT_OUTPUT_FORMAT_LITERALS}；用户明确指定目标格式时必须传对应值并直接生成，不要建中间格式，每次调用与重试均须显式传 format。大文档必须传 docModelId；直接传 blocks 时每项须显式指定 type。",
    en: "Generate a document artifact from docModelId or a small blocks/sheets array (download defaults to true and adds to browser downloads). format is required and must be one of {DOCUMENT_OUTPUT_FORMAT_LITERALS} (supply explicitly on every call and retry, generating the requested format directly without intermediates). Large documents must use docModelId; every direct block must specify type.",
  },
  documentFormat: {
    "zh-CN": "必填，只能是 {DOCUMENT_OUTPUT_FORMAT_LITERALS}；每次调用及重试均须显式传入。",
    en: "Required. Must be one of {DOCUMENT_OUTPUT_FORMAT_LITERALS}; supply explicitly on every call and retry.",
  },
  formatSeparator: { "zh-CN": "、", en: ", " },
});

export const modelT = createTranslator(messages);

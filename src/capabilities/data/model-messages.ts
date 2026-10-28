import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model documentation is separate from the eager UI translation catalog. */
const messages = defineMessages("data-model", {
  dataStore: {
    "zh-CN": "读写浏览器本地结构化 Data 表（文本、链接、商品、文章等；图片资产请用 list_images + collect_images 写入图集表 kind=image_collection，读取图集行仍用 action=list，行内 assetId 可传给 read_image_asset）。需要先建空表头时，用 create_table + table + columns；写数据时用 insert/upsert（采集任务优先用 upsert + rows + dedupField；超过 20 行的批量写入在 run_script 内部分批调用 await tools.data_store）。list/get 返回的是行对象 {rowId, order, data, createdAt, updatedAt, revision}，table 在外层返回；业务字段在 data 内（如 row.data[\"标题\"]，不要用 row[\"标题\"]），写入 row/rows/data 时只传业务字段对象。rowId 是不透明值（系统分配，insert/upsert 不传 rowId；row.id 只是普通业务字段，可作 dedupField），后续 get/update/replace/delete 只能原样复制最近一次 list/get 返回的 rowId。update 修改单个字段需传 rowId、field、value、expectedValue（旧字段不存在时省略 expectedValue）；replace 整行替换需传 rowId、revision、data；delete 只支持按单条 rowId 删除（不支持批量或清空表）；改表结构用 add_column/rename_column/delete_column。时间字段统一用北京时间 yyyy-mm-dd HH:MM:SS。",
    en: "Read and write browser-local structured Data tables (text, links, products, articles; for images, use list_images + collect_images to create an image_collection table, read its rows with action=list, and pass assetId to read_image_asset). To create empty headers, call create_table with table + columns; write records with insert/upsert (prefer upsert + rows + dedupField for collection tasks; for batches over 20 rows, call await tools.data_store in batches inside run_script). list/get returns row objects {rowId, order, data, createdAt, updatedAt, revision} with table at the outer level; business fields live inside data (e.g. row.data[\"title\"], not row[\"title\"]), and row/rows/data writes accept business fields only. rowId is a system-assigned opaque handle (do not pass rowId to insert/upsert; row.id is an ordinary business field and may be used as dedupField)—copy rowId verbatim from the latest list/get result for get/update/replace/delete. update modifies one field using rowId, field, value, and expectedValue (omit expectedValue only if the field did not exist); replace overwrites a whole row using rowId, revision, and data; delete removes one row by rowId (bulk delete and clear are unsupported); modify columns with add_column/rename_column/delete_column. Format timestamps as Beijing time yyyy-mm-dd HH:MM:SS.",
  },
  dataAction: {
    "zh-CN": "操作类型。必填项：create_table 需 table + columns；insert/upsert 需 table + (rows 或 row)；list/schema 需 table（schema 只返回当前字段顺序）；get/delete 需 rowId；update 需 rowId + field + value；replace 需 rowId + revision + data；add_column/delete_column 需 table + column；rename_column 需 table + column + newColumn；tables 无需参数。",
    en: "Action. Required fields: create_table needs table + columns; insert/upsert needs table + (rows or row); list/schema needs table (schema returns current column order only); get/delete needs rowId; update needs rowId + field + value; replace needs rowId + revision + data; add_column/delete_column needs table + column; rename_column needs table + column + newColumn; tables needs no arguments.",
  },
  dataTable: {
    "zh-CN": "逻辑表名（create_table/insert/upsert/list/schema/add_column/rename_column/delete_column 必填，先于 row/rows/data 填写；delete 可选用于归属校验）。",
    en: "Logical table name (required for create_table/insert/upsert/list/schema/add_column/rename_column/delete_column, supplied before row/rows/data; optional for delete to verify ownership).",
  },
  dataRowId: {
    "zh-CN": "不透明内部行句柄。get/update/replace/delete 时原样复制最近一次 list/get 返回的 rowId，禁止拼接、解析、URL 编解码或推导；insert/upsert 不传 rowId。",
    en: "Opaque internal row handle. Copy rowId verbatim from the latest list/get result for get/update/replace/delete (never construct, parse, URL-encode/decode, or derive it); do not pass rowId for insert/upsert.",
  },
  dataField: {
    "zh-CN": "update 要修改的单个业务字段名。",
    en: "Single business field name to modify with update.",
  },
  dataValue: {
    "zh-CN": "update 写入的新字段值（支持 string/number/boolean/null/object/array，传 null 清空；长内容放最后填写）。",
    en: "New field value for update (string/number/boolean/null/object/array; pass null to clear; supply long values last).",
  },
  dataExpectedValue: {
    "zh-CN": "update 的并发校验旧值（填 list/get 读取到的 row.data[field]；仅旧字段不存在时省略）。",
    en: "Concurrency check for update: pass the previous row.data[field] value from list/get (omit only if the field did not exist).",
  },
  dataRevision: {
    "zh-CN": "replace 的并发校验版本号（填 list/get 返回的 row.revision）。",
    en: "Concurrency check revision for replace (pass row.revision from list/get).",
  },
  dataColumn: {
    "zh-CN": "字段名（用于 add_column/delete_column，或 rename_column 的原字段名）。",
    en: "Column name for add_column/delete_column, or the old column name for rename_column.",
  },
  dataNewColumn: {
    "zh-CN": "rename_column 的新字段名（保持原列顺序不变）。",
    en: "New column name for rename_column (preserves column position).",
  },
  dataDedupField: {
    "zh-CN": "upsert 的表内去重业务字段名（如 url、id；禁止传 rowId；省略时等价于 insert）。",
    en: "Business field name for within-table upsert deduplication (e.g. url, id; never rowId; omitting inserts new rows).",
  },
  dataColumns: {
    "zh-CN": "字段顺序数组（create_table 必填且非空；insert/upsert 可选，省略时按首次出现顺序追加）。",
    en: "Column order array (required and non-empty for create_table; optional for insert/upsert, otherwise appended in first-seen order).",
  },
  dataFilter: {
    "zh-CN": "list 的精确匹配过滤对象，如 {\"status\":\"open\"}。",
    en: "Exact-match filter object for list, such as {\"status\":\"open\"}.",
  },
  dataLimit: {
    "zh-CN": "list 最大返回行数，默认 100，范围 1–1000。",
    en: "Maximum rows returned by list. Default: 100; range: 1–1000.",
  },
  dataOffset: {
    "zh-CN": "list 起始行偏移，默认 0。",
    en: "Row offset for list. Default: 0.",
  },
  dataRow: {
    "zh-CN": "单条写入的业务字段对象（仅用于单条记录；采集任务请用 rows；放最后填写）。",
    en: "Single business-fields object to write (for single-record writes only; use rows for collection tasks; supply last).",
  },
  dataRows: {
    "zh-CN": "批量写入的业务字段对象数组（非空；建空表头用 create_table；先填 action/table/dedupField/columns，最后填 rows）。",
    en: "Non-empty array of business-field objects for batch writes (use create_table for empty headers; supply last after action/table/dedupField/columns).",
  },
  dataReplacement: {
    "zh-CN": "replace 的完整行业务字段对象（整行覆盖，不含 rowId/revision/createdAt/updatedAt；最后填写）。",
    en: "Complete row business-fields object for replace (full-row overwrite, excluding rowId/revision/createdAt/updatedAt; supply last).",
  },
  tableSchemaCreated: {
    "zh-CN": "表结构已创建或更新。后续写入数据请使用 upsert + rows + dedupField，或 insert + rows。",
    en: "Table schema created or updated. Write data with upsert + rows + dedupField, or insert + rows.",
  },
  upsertCompleted: {
    "zh-CN": "批量 upsert 完成。rowId 由系统自动分配；只有非 rowId 的 dedupField 命中记录才会更新，用 totalRows 和 list/schema 验证结果。",
    en: "Batch upsert completed. The system assigned rowId values. Only matches on a non-rowId dedupField update existing rows. Verify the result with totalRows and list/schema.",
  },
  rowDeleted: {
    "zh-CN": "已删除 1 条记录。图集行同样按 rowId 删除；若该图片没有其他图集引用，本地图片文件仍由图集管理界面清理。",
    en: "Deleted 1 record. Collection rows also use rowId for deletion. If no other collection references the image, its local file is still cleaned up through the collection management interface.",
  },
});

export const modelT = createTranslator(messages);

import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("bookmarks-tools", {
  manageBookmarksDescription: {
    "zh-CN": "管理浏览器书签/收藏夹。支持 search/create/update/move/delete/list；update 只改 title/url，move 才能移动 parentId/index；删除文件夹时需 recursive:true。",
    en: "Manage browser bookmarks and folders. Supports search/create/update/move/delete/list. update changes only title/url; use move to change parentId/index. Deleting a folder requires recursive:true.",
  },
  manageBookmarksAction: {
    "zh-CN": "操作类型。分支必填：search 需 query；create 需 title 或 url；update 需 id + title/url；move 需 id + parentId/index；delete 需 id。",
    en: "Action. Required fields: search needs query; create needs title or url; update needs id and title/url; move needs id and parentId/index; delete needs id.",
  },
  manageBookmarksQuery: {
    "zh-CN": "search 时匹配标题或 URL 的关键词",
    en: "Keyword to match against bookmark titles or URLs when searching.",
  },
  manageBookmarksId: {
    "zh-CN": "update/move/delete/list 指定的书签或文件夹 ID",
    en: "Bookmark or folder ID for update/move/delete/list.",
  },
  manageBookmarksParentId: {
    "zh-CN": "create/list/move 的父文件夹 ID；不填 list 返回顶层文件夹",
    en: "Parent folder ID for create/list/move. If omitted, list returns top-level folders.",
  },
  manageBookmarksTitle: {
    "zh-CN": "create/update 的标题；创建文件夹时只传 title 不传 url",
    en: "Title for create/update. To create a folder, provide title without url.",
  },
  manageBookmarksUrl: {
    "zh-CN": "create/update 的 URL；不传 url 则创建文件夹",
    en: "URL for create/update. Omitting url creates a folder.",
  },
  manageBookmarksIndex: {
    "zh-CN": "create/move 时插入到父文件夹的位置",
    en: "Position within the parent folder for create/move.",
  },
  manageBookmarksRecursive: {
    "zh-CN": "list 是否递归；delete 删除文件夹时必须为 true",
    en: "Whether list includes descendants. Must be true when deleting a folder.",
  },
  manageBookmarksLimit: {
    "zh-CN": "最多返回条数，默认 50",
    en: "Maximum number of results. Default: 50.",
  },
  browseHistoryDescription: {
    "zh-CN": "查询浏览器历史记录。支持 search/recent，只返回历史条目摘要。任务要求确认页面已进入历史时必须用本工具读取验证，不能用 open_tab 成功代替。",
    en: "Query browser history. Supports search/recent and returns entry summaries. If a task requires confirming that a page appears in history, verify it with this tool; a successful open_tab call is not sufficient.",
  },
  browseHistoryAction: {
    "zh-CN": "search 按关键词搜索，需 query；recent 返回最近访问，无需 query。",
    en: "search finds entries by keyword and requires query; recent returns recent visits without query.",
  },
  browseHistoryQuery: {
    "zh-CN": "search 的关键词；recent 可不填",
    en: "Search keyword. Optional for recent.",
  },
  browseHistoryStartTime: {
    "zh-CN": "起始 Unix 秒时间戳；不填默认最近 30 天",
    en: "Start time as a Unix timestamp in seconds. Defaults to 30 days ago.",
  },
  browseHistoryEndTime: {
    "zh-CN": "结束 Unix 秒时间戳；不填默认当前时间",
    en: "End time as a Unix timestamp in seconds. Defaults to now.",
  },
});

export const toolT = createTranslator(messages);

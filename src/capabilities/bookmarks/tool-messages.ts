import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("bookmarks-tools", {
  manageBookmarksDescription: {
    "zh-CN": "管理浏览器书签与文件夹（search/list/create/update/move/delete）。update 只修改 title/url；调整所在文件夹或位置用 move；删除文件夹须传 recursive:true。",
    en: "Manage browser bookmarks and folders (search/list/create/update/move/delete). update changes title/url only; use move to change parentId/index; deleting a folder requires recursive:true.",
  },
  manageBookmarksAction: {
    "zh-CN": "操作类型：search 需 query；create 需 title 或 url；update 需 id + title/url；move 需 id + parentId/index；delete 需 id。",
    en: "Action: search needs query; create needs title or url; update needs id + title/url; move needs id + parentId/index; delete needs id.",
  },
  manageBookmarksQuery: {
    "zh-CN": "search 匹配标题或 URL 的非空关键词。",
    en: "Non-empty keyword matched against titles or URLs for search.",
  },
  manageBookmarksId: {
    "zh-CN": "update/move/delete/list 的书签或文件夹 ID。",
    en: "Bookmark or folder ID for update/move/delete/list.",
  },
  manageBookmarksParentId: {
    "zh-CN": "create/move/list 的父文件夹 ID；list 省略时返回顶层。",
    en: "Parent folder ID for create/move/list; list returns top-level folders if omitted.",
  },
  manageBookmarksTitle: {
    "zh-CN": "create/update 的标题；create 不传 url 时创建文件夹。",
    en: "Title for create/update; omitting url in create creates a folder.",
  },
  manageBookmarksUrl: {
    "zh-CN": "create/update 的 URL；create 省略 url 时创建文件夹。",
    en: "URL for create/update; omitting url in create creates a folder.",
  },
  manageBookmarksIndex: {
    "zh-CN": "create/move 在父文件夹中的 0-based 位置。",
    en: "0-based position within the parent folder for create/move.",
  },
  manageBookmarksRecursive: {
    "zh-CN": "list 是否递归；delete 删除文件夹时必须为 true。",
    en: "Include descendants in list; must be true when deleting a folder.",
  },
  manageBookmarksLimit: {
    "zh-CN": "最多返回条数，默认 50，范围 1–200。",
    en: "Maximum results. Default: 50; range: 1–200.",
  },
  browseHistoryDescription: {
    "zh-CN": "查询浏览器访问历史（search 按关键词查询，recent 查看最近访问）。当任务要求确认某页面已进入浏览历史时，必须调用本工具验证，不能用 open_tab 成功代替。",
    en: "Query browser history (search by keyword, or recent for latest visits). When a task requires verifying that a page is in browsing history, check with this tool—a successful open_tab call is not sufficient.",
  },
  browseHistoryAction: {
    "zh-CN": "操作类型：search 需非空 query；recent 返回最近访问记录。",
    en: "Action: search requires a non-empty query; recent returns recent visits.",
  },
  browseHistoryQuery: {
    "zh-CN": "search 的搜索关键词（recent 无需填写）。",
    en: "Search keyword for search (not used by recent).",
  },
  browseHistoryStartTime: {
    "zh-CN": "起始时间（Unix 秒时间戳）；省略时默认最近 30 天。",
    en: "Start time as a Unix timestamp in seconds. Defaults to 30 days ago.",
  },
  browseHistoryEndTime: {
    "zh-CN": "结束时间（Unix 秒时间戳）；省略时默认当前时间。",
    en: "End time as a Unix timestamp in seconds. Defaults to now.",
  },
});

export const toolT = createTranslator(messages);

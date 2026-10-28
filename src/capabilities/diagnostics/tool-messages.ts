import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("diagnostics-tools", {
  readConsoleMessagesDescription: {
    "zh-CN": "读取目标标签页最近的 console 日志与 JS 异常（按时间倒序）。用于排查前端报错与点击后异常。",
    en: "Read recent console messages and JavaScript exceptions from the target tab (newest first) to diagnose frontend errors and post-action exceptions.",
  },
  readConsoleMessagesTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID. Defaults to the current task's working tab.",
  },
  readConsoleMessagesReset: {
    "zh-CN": "是否清空已有 console 记录并重新监听，默认 false。",
    en: "Clear buffered console records before reading. Default: false.",
  },
  readConsoleMessagesLimit: {
    "zh-CN": "最多返回条数，默认 50，范围 1–200。",
    en: "Maximum records to return. Default: 50; range: 1–200.",
  },
  readConsoleMessagesMaxRecords: {
    "zh-CN": "缓冲区最多保留记录数，默认 200，范围 20–1000。",
    en: "Maximum buffered records. Default: 200; range: 20–1000.",
  },
  readConsoleMessagesLevel: {
    "zh-CN": "按级别过滤（info/warning/error/debug）。",
    en: "Filter by level (info/warning/error/debug).",
  },
  readConsoleMessagesType: {
    "zh-CN": "按 CDP console type 过滤，如 log/warn/error/exception。",
    en: "Filter by CDP console type, such as log/warn/error/exception.",
  },
  readConsoleMessagesTextPattern: {
    "zh-CN": "日志文本正则过滤。",
    en: "Regex to match log text.",
  },
  readConsoleMessagesUrlPattern: {
    "zh-CN": "来源 URL 正则过滤。",
    en: "Regex to match source URL.",
  },
  readConsoleMessagesFlags: {
    "zh-CN": "正则 flags，默认 i。",
    en: "Regex flags. Default: i.",
  },
  networkWatchDescription: {
    "zh-CN": "在已打开标签页上开启或重置 Network 后置监听，只记录调用之后发生的请求摘要（适合点击、搜索、提交、翻页前调用；响应体按需用 network_body 读取）。抓首屏或重定向请求请在 open_tab/navigate 中传 watchNetwork:true。",
    en: "Start or reset post-load network monitoring on an open tab to record summaries of requests made after this call (call before clicking, searching, submitting, or paging; read bodies with network_body). Pass watchNetwork:true to open_tab/navigate for initial load or redirect requests.",
  },
  networkWatchReset: {
    "zh-CN": "是否清空已有记录，默认 true。",
    en: "Clear existing records. Default: true.",
  },
  networkWatchMaxRecords: {
    "zh-CN": "最多保留请求数，默认 200，范围 20–1000。",
    en: "Maximum buffered requests. Default: 200; range: 20–1000.",
  },
  networkRecentDescription: {
    "zh-CN": "查看目标标签页最近的 Network 请求摘要（按时间倒序返回 requestId、method、url、status、mimeType、resourceType 等）。大型接口采样或排查 SPA 数据源、鉴权与限频时配合 network_body 使用。",
    en: "View recent network request summaries for the target tab (newest first, returning requestId, method, url, status, mimeType, resourceType, etc.). Pair with network_body to sample large APIs or diagnose SPA data sources, auth, and rate limits.",
  },
  networkRecentLimit: {
    "zh-CN": "最多返回条数，默认 20，范围 1–100。",
    en: "Maximum results. Default: 20; range: 1–100.",
  },
  networkRecentUrlPattern: {
    "zh-CN": "请求 URL 正则过滤。",
    en: "Regex to match request URLs.",
  },
  networkRecentFlags: {
    "zh-CN": "URL 正则 flags，默认 i。",
    en: "URL regex flags. Default: i.",
  },
  networkRecentMethod: {
    "zh-CN": "HTTP 方法过滤，如 GET/POST。",
    en: "HTTP method filter, such as GET/POST.",
  },
  networkRecentStatus: {
    "zh-CN": "精确状态码过滤，如 200/401/429。",
    en: "Exact HTTP status code filter, such as 200/401/429.",
  },
  networkRecentFailed: {
    "zh-CN": "过滤失败（true）或成功（false）请求。",
    en: "Filter failed (true) or successful (false) requests.",
  },
  networkRecentResourceType: {
    "zh-CN": "CDP resourceType 过滤，如 XHR/Fetch/Document/Image。",
    en: "CDP resourceType filter, such as XHR/Fetch/Document/Image.",
  },
  networkRecentMimePattern: {
    "zh-CN": "响应 mimeType 正则过滤（如 json）。",
    en: "Regex to match response mimeType (e.g. json).",
  },
  networkBodyDescription: {
    "zh-CN": "按 requestId 读取 Network 响应体（requestId 来自 network_recent 或 wait_for_response）。",
    en: "Read a network response body by requestId (from network_recent or wait_for_response).",
  },
  networkBodyRequestId: {
    "zh-CN": "来自 network_recent 或 wait_for_response 的 requestId。",
    en: "requestId from network_recent or wait_for_response.",
  },
  networkBodyMaxBytes: {
    "zh-CN": "最多返回字符数，默认 120000，范围 1000–1000000。",
    en: "Maximum characters to return. Default: 120000; range: 1000–1000000.",
  },
  waitForResponseDescription: {
    "zh-CN": "等待匹配 URL/method/status/mimeType 的 Network 响应（已缓冲匹配项则立即返回），可选附带响应体。",
    en: "Wait for a network response matching URL, method, status, or mimeType (returns immediately if already buffered), optionally including the body.",
  },
  waitForResponseUrlPattern: {
    "zh-CN": "必填。请求 URL 正则。",
    en: "Required regex to match the request URL.",
  },
  waitForResponseStatus: {
    "zh-CN": "精确 HTTP 状态码。",
    en: "Exact HTTP status code.",
  },
  waitForResponseMimePattern: {
    "zh-CN": "响应 mimeType 正则。",
    en: "Regex to match response mimeType.",
  },
  waitForResponseTimeout: {
    "zh-CN": "超时秒数，默认 10，最大 120。",
    en: "Timeout in seconds. Default: 10; maximum: 120.",
  },
  waitForResponseIncludeBody: {
    "zh-CN": "是否等待加载完成并返回 body，默认 false。",
    en: "Wait for completion and return the response body. Default: false.",
  },
  waitForResponseMaxBytes: {
    "zh-CN": "body 最大字符数，默认 120000，范围 1000–1000000。",
    en: "Maximum body characters. Default: 120000; range: 1000–1000000.",
  },
  waitForNetworkIdleDescription: {
    "zh-CN": "等待目标标签页在途网络请求归零并连续空闲，适合点击、搜索或翻页后替代固定等待。",
    en: "Wait for in-flight network requests in the target tab to stay idle; use after clicking, searching, or paging instead of a fixed delay.",
  },
  waitForNetworkIdleIdleSeconds: {
    "zh-CN": "连续空闲秒数，默认 0.8，范围 0.1–10。",
    en: "Continuous idle seconds required. Default: 0.8; range: 0.1–10.",
  },
  waitForNetworkIdleTimeout: {
    "zh-CN": "总超时秒数，默认 10，最大 120。",
    en: "Overall timeout in seconds. Default: 10; maximum: 120.",
  },
  waitForNetworkIdleUrlPattern: {
    "zh-CN": "仅统计匹配该正则的请求 URL。",
    en: "Count only requests matching this URL regex.",
  },
  networkWatchingBeforeNavigation: {
    "zh-CN": "已在导航前开启 Network 监听；页面加载后可用 network_recent 查看首屏请求。",
    en: "Network monitoring started before navigation. After the page loads, use network_recent to inspect initial requests.",
  },
});

export const toolT = createTranslator(messages);

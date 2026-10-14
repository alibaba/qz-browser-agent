import { defineMessages } from "./i18n/definition.js";
import { createTranslator } from "./i18n/index.js";

export type ToolBrowserPermission = "bookmarks" | "history";
export type OptionalBrowserPermission = ToolBrowserPermission | "desktopCapture" | "downloads.open";

export function isToolBrowserPermission(value: unknown): value is ToolBrowserPermission {
  return value === "bookmarks" || value === "history";
}

export const browserPermissionMessages = defineMessages("browser-permissions", {
  title: { "zh-CN": "需要浏览器权限", en: "Browser permission required" },
  allow: { "zh-CN": "授权并继续", en: "Allow and continue" },
  hint: { "zh-CN": "点击后由 Chrome 请求授权，允许后继续操作。", en: "Chrome will ask for permission. Allow access to continue." },
  bookmarks: { "zh-CN": "此操作需要读取或管理你的书签。任务使用的书签信息会发送至你配置的模型服务。", en: "This action needs access to read or manage your bookmarks. Bookmark details used by the task are sent to your configured model service." },
  history: { "zh-CN": "此操作需要读取你的浏览历史。任务使用的历史记录会发送至你配置的模型服务。", en: "This action needs access to your browsing history. History entries used by the task are sent to your configured model service." },
  "name.bookmarks": { "zh-CN": "书签", en: "bookmarks" },
  "name.history": { "zh-CN": "浏览历史", en: "browsing history" },
  "name.desktopCapture": { "zh-CN": "屏幕录制", en: "screen recording" },
  "name.downloads.open": { "zh-CN": "打开下载文件", en: "opening downloaded files" },
  required: { "zh-CN": "请在轻舟侧边栏中授权 {permission} 后重试。", en: "Allow {permission} in the qz side panel, then retry." },
  denied: { "zh-CN": "未获得 {permission} 权限，操作已取消。需要时可重试并授权。", en: "Permission for {permission} was not granted. The action was cancelled. Retry to allow access." },
});

export const permissionT = createTranslator(browserPermissionMessages);

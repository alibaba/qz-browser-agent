import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("tabs-tools", {
  pageMode: {
    "zh-CN": "desktop（桌面端，默认）或 mobile（Android Chrome，412×915，支持触摸）。",
    en: "desktop (default) or mobile (Android Chrome, 412×915, touch enabled).",
  },
  setPageModeDescription: {
    "zh-CN": "切换当前任务拥有的页面的桌面/移动模式。实际变化会自动刷新页面，相同模式不刷新。刷新后重新观察页面；旧元素引用和截图坐标不可继续使用。不要在未保存表单时切换。移动模式在本轮任务完成或停止后保持，直到切回桌面、关闭标签页或删除任务。导航导致调试目标丢失时自动尝试无刷新恢复；若恢复失败或用户主动断开，下一次页面操作会恢复移动模式并刷新，请先重新观察。",
    en: "Switch a task-owned page between desktop and mobile mode. A change automatically reloads the page; the same mode does not reload. Observe the page again afterward; old element references and screenshot coordinates are stale. Avoid switching with unsaved form input. Mobile mode persists after a run completes or stops, until switching to desktop, closing the tab, or deleting the task. Navigation-related target loss triggers an automatic restore without reloading. If it fails or the user disconnects the debugger, the next page tool restores mobile mode and reloads; observe again first.",
  },
  modeContextTitle: { "zh-CN": "页面模式", en: "Page mode" },
  modeResume: { "zh-CN": "下一次任务内页面操作会恢复移动模式并刷新。请先重新观察页面，再操作。", en: "The next owned-page tool restores mobile mode and reloads. Observe the page again before interacting." },
  modeChanging: { "zh-CN": "页面模式正在切换，请等待完成后重新观察。", en: "Page mode is changing. Wait, then observe the page again." },
  listTabsDescription: {
    "zh-CN": "列出所有打开的网页标签页及其页面角色和可用性；pageMode 为当前实际 desktop/mobile 模式。active=true 表示用户可见标签页，isWorkingTab=true 表示当前任务工作标签页，ownedByCurrentTask=true 表示当前任务拥有该标签页；claimRequired=true 表示 use_tab 会将该无人认领标签页归属当前任务，readOnlyUsable=true 表示只读页面工具可显式传 tabId 查看。忽略 chrome://、chrome-extension://、devtools://、新标签页等非网页 tab。命中安全策略的标签页仍返回标题、URL、tabId 等元信息，并标记 contentAccess=blocked。",
    en: "List all open web tabs with their roles and availability; pageMode reports the current desktop/mobile mode. active=true marks the tab visible to the user; isWorkingTab=true marks the current task’s working tab; ownedByCurrentTask=true means the current task owns the tab. claimRequired=true means use_tab will assign the unclaimed tab to the current task. readOnlyUsable=true means read-only page tools may inspect it by passing tabId explicitly. Excludes non-web tabs such as chrome://, chrome-extension://, devtools://, and new-tab pages. Tabs blocked by a security policy still return metadata such as title, URL, and tabId, with contentAccess=blocked.",
  },
  getWorkingTabDescription: {
    "zh-CN": "读取当前任务已存在的工作标签页。没有工作标签页时返回 hasWorkingTab=false；存在时返回 hasWorkingTab=true、pageMode（当前实际 desktop/mobile 模式）及页面元信息。若命中安全策略，仍返回标题、URL、tabId，并标记 contentAccess=blocked；后续不要读取页面内容。",
    en: "Read the current task’s existing working tab. Returns hasWorkingTab=false if none exists, or hasWorkingTab=true with page metadata and the current desktop/mobile pageMode if it does. A tab blocked by a security policy still returns title, URL, and tabId with contentAccess=blocked; do not subsequently read its page content.",
  },
  openTabDescription: {
    "zh-CN": "打开新标签页，等待目标文档的导航提交后返回。将 open_tab({url,tabAlias:\"source1\"}) 和 read_article({tabRef:\"source1\",limit:4000}) 一起放入当前 assistant 消息的 tool_calls 数组并一次发出；将每个打开调用放在依赖它的读取之前。多个页面分别使用唯一 tabAlias 和对应 tabRef；别名在当前任务中跨轮有效，也可用 tabRef 传浏览器数字 ID。资源和动态内容可继续加载，读取工具确认文档解析完成后提取内容。若需要捕获新页面首屏、重定向或加载期接口，传 watchNetwork:true；工具会先创建空白页并在导航前开启 Network 监听，再跳到目标 URL，之后可直接用 network_recent 查看首屏请求。监听已打开页面中点击、搜索、提交等后续交互的请求时，使用 network_watch。",
    en: "Open a new tab and wait for the destination document's navigation to commit. Return open_tab({url,tabAlias:\"source1\"}) together with read_article({tabRef:\"source1\",limit:4000}) in the current assistant message's tool_calls array, sending both calls together; place each opening before its readers. Give each new page a unique tabAlias and use its tabRef across turns in this Session; tabRef also accepts a numeric browser ID. Resources and dynamic content can continue loading; readers extract after document parsing completes. To capture requests made during the initial page load or redirects, including API calls, pass watchNetwork:true. The tool creates a blank tab, starts network monitoring before navigation, then opens the target URL. Use network_recent afterward to inspect initial requests. Use network_watch to capture requests from later interactions on an open page, such as clicking, searching, or submitting.",
  },
  openTabAlias: {
    "zh-CN": "当前任务中唯一的页面别名，1–64 个字母、数字、下划线或连字符，不能为纯数字，例如 source1。与已打开或待创建页面重名会报错且不会新开页面。后续用 tabRef:source1 访问，关闭页面后可复用名称。",
    en: "A page alias unique within this Session: 1–64 letters, digits, underscores or hyphens, not entirely numeric, e.g. source1. A duplicate open or pending alias fails before opening a tab. Use tabRef:source1 in later calls; closing the tab releases the name.",
  },
  openTabUrl: {
    "zh-CN": "要打开的 HTTP/HTTPS 或已获文件网址访问权限的 file:// URL；需要移动网页时同时设置 mode:mobile，首次请求即使用移动模式。",
    en: "HTTP/HTTPS URL or a file:// URL permitted by Chrome file access. For a mobile page, also set mode:mobile so the very first request uses mobile mode.",
  },
  openTabWatchNetwork: {
    "zh-CN": "打开新标签页时是否在真正导航前开启 Network 监听；用于抓首屏、重定向、页面加载期请求。页面已打开后的交互监听请用 network_watch。",
    en: "Whether to start network monitoring before navigating the new tab, to capture requests made during the initial page load or redirects. Use network_watch for interactions on an already open page.",
  },
  openTabResetNetwork: {
    "zh-CN": "watchNetwork=true 时是否清空该 tab 的已有记录，默认 true",
    en: "Whether to clear existing records for this tab when watchNetwork=true. Default: true.",
  },
  openTabNetworkMaxRecords: {
    "zh-CN": "watchNetwork=true 时最多保留请求数，默认 200，范围 20-1000",
    en: "Maximum number of requests to retain when watchNetwork=true. Default: 200; range: 20–1000.",
  },
  closeTabDescription: {
    "zh-CN": "关闭标签页",
    en: "Close a tab.",
  },
  closeTabTabId: {
    "zh-CN": "标签页 ID",
    en: "Tab ID.",
  },
  useTabDescription: {
    "zh-CN": "将指定网页标签页设为当前任务工作标签页，用户可见标签页保持不变。适用于当前任务已拥有或无人认领的网页标签页；归属其他任务的标签页可由只读页面工具显式传 tabId 查看。",
    en: "Set the specified web tab as the current task’s working tab, without changing the tab visible to the user. Accepts tabs already owned by the current task or unclaimed tabs. To inspect a tab owned by another task, pass tabId explicitly to a read-only page tool.",
  },
  navigateDescription: {
    "zh-CN": "在当前任务的工作标签页或当前任务拥有的指定标签页中导航到新 URL，等待本次导航提交后返回，避免后续读取旧页面；不等待所有资源或动态内容加载完成。若需要捕获这次跳转的首屏、重定向或加载期接口，传 watchNetwork:true；工具会先在原 tab 上开启 Network 监听，再执行导航，之后可直接用 network_recent 查看本次导航请求。监听当前页面中点击、搜索、提交等后续交互的请求时，使用 network_watch。",
    en: "Navigate to a new URL in the current task’s working tab or a specified tab it owns. Waits for this navigation to commit so subsequent tools do not read the old page; resources and dynamic content may still be loading. To capture requests made during the initial page load or redirects, including API calls, pass watchNetwork:true. The tool starts network monitoring on the existing tab before navigating; use network_recent afterward to inspect this navigation’s requests. Use network_watch to capture requests from later interactions on the current page, such as clicking, searching, or submitting.",
  },
  navigateUrl: {
    "zh-CN": "目标 HTTP/HTTPS 或已获文件网址访问权限的 file:// URL",
    en: "Destination HTTP/HTTPS URL or a file:// URL permitted by Chrome file access.",
  },
  navigateTabId: {
    "zh-CN": "本次调用的目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID for this call. Defaults to the current task’s working tab.",
  },
  navigateWatchNetwork: {
    "zh-CN": "本次导航前是否开启 Network 监听；用于抓跳转首屏、重定向、加载期请求。页面已加载后的交互监听请用 network_watch。",
    en: "Whether to start network monitoring before this navigation, to capture requests made during the initial page load or redirects. Use network_watch for interactions after the page has loaded.",
  },
  workingTabSelected: {
    "zh-CN": "已设为当前任务工作标签页；用户可见标签页保持不变。",
    en: "Set as the current task’s working tab. The tab visible to the user is unchanged.",
  },
});

export const toolT = createTranslator(messages);

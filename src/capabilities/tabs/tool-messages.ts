import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("tabs-tools", {
  pageMode: {
    "zh-CN": "desktop（桌面端，默认）或 mobile（Android Chrome，412×915，支持触摸）。",
    en: "desktop (default) or mobile (Android Chrome, 412×915, touch enabled).",
  },
  setPageModeDescription: {
    "zh-CN": "切换 tabRef 指定页面的桌面/移动模式（未占用的页面由当前任务占用）。实际变化会自动刷新页面，相同模式不刷新。刷新后重新观察页面；旧元素引用和截图坐标不可继续使用。不要在未保存表单时切换。移动模式在本轮任务完成或停止后保持，直到切回桌面、关闭标签页或删除任务。导航导致调试目标丢失时自动尝试无刷新恢复；若恢复失败或用户主动断开，下一次页面操作会恢复移动模式并刷新，请先重新观察。",
    en: "Switch the page specified by tabRef between desktop and mobile mode; an unclaimed tab is claimed for this task. A change automatically reloads the page; the same mode does not reload. Observe the page again afterward; old element references and screenshot coordinates are stale. Avoid switching with unsaved form input. Mobile mode persists after a run completes or stops, until switching to desktop, closing the tab, or deleting the task. Navigation-related target loss triggers an automatic restore without reloading. If it fails or the user disconnects the debugger, the next page tool restores mobile mode and reloads; observe again first.",
  },
  modeContextTitle: { "zh-CN": "页面模式", en: "Page mode" },
  modeResume: { "zh-CN": "下一次任务内页面操作会恢复移动模式并刷新。请先重新观察页面，再操作。", en: "The next owned-page tool restores mobile mode and reloads. Observe the page again before interacting." },
  modeChanging: { "zh-CN": "页面模式正在切换，请等待完成后重新观察。", en: "Page mode is changing. Wait, then observe the page again." },
  listTabsScope: {
    "zh-CN": "省略时列出当前任务拥有的页面和未被任何任务占用的页面；owned 只列出当前任务的页面；all 另外列出其他任务拥有的页面，仅供只读查看。",
    en: "Omit to list this task’s tabs and unclaimed tabs. owned lists only this task’s tabs; all adds tabs owned by other tasks, for read-only inspection.",
  },
  listTabsDescription: {
    "zh-CN": "列出当前任务可以使用的网页标签页：当前任务拥有的页面，以及未被任何任务占用的页面（包括用户正在看的未占用页面）。每行返回 tabRef、url、title、active 和 ownership。tabRef 是当前任务的页面别名或数字引用，原样传给页面工具的 tabRef。active=true 表示用户正在看的标签页。ownership 为 owned（当前任务）、unclaimed（未占用）或 foreign（其他任务）。列出页面不会占用页面；对 unclaimed 页面首次执行操作、导航或 evaluate 时由当前任务占用，只读工具不改变归属；foreign 页面只能只读查看。忽略 chrome://、chrome-extension://、devtools://、新标签页等非网页标签页。",
    en: "List web tabs this task can use: tabs it owns and unclaimed tabs that no task owns, including the tab the user is viewing when it is unclaimed. Each row has tabRef, url, title, active, and ownership. tabRef is the tab’s alias in this task or its numeric reference; pass it unchanged as a page tool’s tabRef. active=true marks the tab visible to the user. ownership is owned (this task), unclaimed, or foreign (another task). Listing never claims a tab. The first action, navigation, or evaluate on an unclaimed tab claims it for this task; read-only tools leave ownership unchanged. Foreign tabs are read-only. Excludes non-web tabs such as chrome://, chrome-extension://, devtools://, and new-tab pages.",
  },
  openTabDescription: {
    "zh-CN": "打开新标签页，等待目标文档的导航提交后返回。先用 open_tab({url,tabAlias:\"source1\"}) 打开页面，再用 read_article({tabRef:\"source1\",limit:4000}) 读取；每个打开调用都先于依赖它的读取，独立页面可并行处理。可为多个页面分别设置唯一 tabAlias，并使用对应 tabRef；别名在当前任务中跨轮有效，也可用 tabRef 传 open_tab/list_tabs 返回的 tabRef。资源和动态内容可继续加载，读取工具确认文档解析完成后提取内容。若需要捕获新页面首屏、重定向或加载期接口，传 watchNetwork:true；工具会先创建空白页并在导航前开启 Network 监听，再跳到目标 URL，之后可直接用 network_recent 查看首屏请求。监听已打开页面中点击、搜索、提交等后续交互的请求时，使用 network_watch。",
    en: "Open a new tab and wait for the destination document's navigation to commit. Open each page before calling its readers, for example open_tab({url,tabAlias:\"source1\"}) followed by read_article({tabRef:\"source1\",limit:4000}); independent pages may be processed concurrently. Optionally give each new page a unique tabAlias and use it as tabRef across turns in this task; tabRef also accepts the tabRef returned by open_tab/list_tabs. Resources and dynamic content can continue loading; readers extract after document parsing completes. To capture requests made during the initial page load or redirects, including API calls, pass watchNetwork:true. The tool creates a blank tab, starts network monitoring before navigation, then opens the target URL. Use network_recent afterward to inspect initial requests. Use network_watch to capture requests from later interactions on an open page, such as clicking, searching, or submitting.",
  },
  openTabAlias: {
    "zh-CN": "可选的当前任务内唯一页面别名，1–64 个字母、数字、下划线或连字符，不能为纯数字，例如 source1。与已打开或待创建页面重名会报错且不会新开页面。后续用 tabRef:source1 访问，关闭页面后可复用名称。",
    en: "An optional page alias unique within this task: 1–64 letters, digits, underscores or hyphens, not entirely numeric, e.g. source1. A duplicate open or pending alias fails before opening a tab. Use tabRef:source1 in later calls; closing the tab releases the name.",
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
    "zh-CN": "本次调用的目标标签页 tabRef：别名或 open_tab/list_tabs 返回的 tabRef。",
    en: "Target tabRef for this call: an alias or the tabRef returned by open_tab/list_tabs.",
  },
  navigateDescription: {
    "zh-CN": "在 tabRef 指定的标签页中导航到新 URL（未占用的页面由当前任务占用），等待本次导航提交后返回，避免后续读取旧页面；不等待所有资源或动态内容加载完成。若需要捕获这次跳转的首屏、重定向或加载期接口，传 watchNetwork:true；工具会先在原 tab 上开启 Network 监听，再执行导航，之后可直接用 network_recent 查看本次导航请求。监听当前页面中点击、搜索、提交等后续交互的请求时，使用 network_watch。",
    en: "Navigate to a new URL in the tab specified by tabRef; an unclaimed tab is claimed for this task. Waits for this navigation to commit so subsequent tools do not read the old page; resources and dynamic content may still be loading. To capture requests made during the initial page load or redirects, including API calls, pass watchNetwork:true. The tool starts network monitoring on the existing tab before navigating; use network_recent afterward to inspect this navigation’s requests. Use network_watch to capture requests from later interactions on the current page, such as clicking, searching, or submitting.",
  },
  navigateUrl: {
    "zh-CN": "目标 HTTP/HTTPS 或已获文件网址访问权限的 file:// URL",
    en: "Destination HTTP/HTTPS URL or a file:// URL permitted by Chrome file access.",
  },
  navigateTabId: {
    "zh-CN": "本次调用的目标标签页 tabRef：别名或 open_tab/list_tabs 返回的 tabRef。",
    en: "Target tabRef for this call: an alias or the tabRef returned by open_tab/list_tabs.",
  },
  navigateWatchNetwork: {
    "zh-CN": "本次导航前是否开启 Network 监听；用于抓跳转首屏、重定向、加载期请求。页面已加载后的交互监听请用 network_watch。",
    en: "Whether to start network monitoring before this navigation, to capture requests made during the initial page load or redirects. Use network_watch for interactions after the page has loaded.",
  },
});

export const toolT = createTranslator(messages);

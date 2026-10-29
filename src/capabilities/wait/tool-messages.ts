import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("wait-tools", {
  waitForUserDescription: {
    "zh-CN": "暂停并等待用户完成登录、验证码、授权、付款、本地文件选择等必须亲自操作的步骤。侧边栏显示提示，用户点击[继续]后自动恢复。",
    en: "Pause for the user to complete a step requiring direct page interaction, such as signing in, solving a CAPTCHA, authorizing access, paying, or selecting a local file. Resumes when the user clicks [Continue].",
  },
  waitForUserMessage: {
    "zh-CN": "展示给用户的提示，说明需要用户在页面完成什么操作。",
    en: "Instructions shown to the user explaining what to do on the page.",
  },
  waitForUserTabId: {
    "zh-CN": "恢复后观测的标签页 ID；省略时使用当前任务工作标签页。",
    en: "Tab ID to observe after resuming. Defaults to the current task's working tab.",
  },
  askUserDescription: {
    "zh-CN": "向用户展示结构化表单并返回提交的 answers。用于澄清需求、提供选项、收集字段，或在向外部系统执行发送/提交/发布/创建/修改/删除动作前请求确认。",
    en: "Show a structured form to the user and return submitted answers. Use to clarify requirements, offer choices, collect fields, or confirm before sending, submitting, publishing, creating, modifying, or deleting external data.",
  },
  askUserTitle: {
    "zh-CN": "表单标题，默认“帮我补充信息”。",
    en: "Form title. Default: “Provide more information”.",
  },
  askUserMessage: {
    "zh-CN": "简短说明为什么需要这些信息或确认。",
    en: "Brief explanation of why this information or confirmation is needed.",
  },
  askUserSubmitLabel: {
    "zh-CN": "提交按钮文案，默认“提交”。",
    en: "Submit button label. Default: “Submit”.",
  },
  askUserFields: {
    "zh-CN": "表单字段数组（最多 8 个），支持 text、textarea、single_choice、multi_choice。",
    en: "Up to 8 form fields; supports text, textarea, single_choice, and multi_choice.",
  },
  askUserId: {
    "zh-CN": "字段 ID（作为返回 answers 的 key）。",
    en: "Field ID (used as the key in returned answers).",
  },
  askUserLabel: {
    "zh-CN": "字段标题。",
    en: "Field label.",
  },
  askUserType: {
    "zh-CN": "字段类型，默认 text。",
    en: "Field type. Default: text.",
  },
  askUserPresentation: {
    "zh-CN": "选择题可设为 cards 以卡片展示（最多 50 项）。",
    en: "Set to cards on choice fields for card selection (up to 50 options).",
  },
  askUserPlaceholder: {
    "zh-CN": "输入占位提示。",
    en: "Input placeholder.",
  },
  askUserHelp: {
    "zh-CN": "字段补充说明。",
    en: "Additional help text.",
  },
  askUserDefaultValue: {
    "zh-CN": "text/textarea/single_choice 的默认字符串值。",
    en: "Default string value for text/textarea/single_choice.",
  },
  askUserDefaultValues: {
    "zh-CN": "multi_choice 的默认勾选值数组。",
    en: "Default selected values array for multi_choice.",
  },
  askUserRequired: {
    "zh-CN": "是否必填，默认 true。",
    en: "Whether required. Default: true.",
  },
  askUserOptions: {
    "zh-CN": "选择题选项数组 {label, value, description}（value 省略时同 label）。",
    en: "Choice options array {label, value, description} (value defaults to label).",
  },
  askUserOptionMeta: {
    "zh-CN": "卡片短标签（最多 6 个，每个最多 80 字符）。",
    en: "Card metadata tags (up to 6 tags, 80 chars each).",
  },
  askUserOptionImageUrl: {
    "zh-CN": "卡片缩略图 HTTP(S) URL。",
    en: "Card thumbnail HTTP(S) URL.",
  },
  askUserOptionUrl: {
    "zh-CN": "卡片来源 HTTP(S) URL。",
    en: "Card source HTTP(S) URL.",
  },
  waitForNavigationNoImages: {
    "zh-CN": "等待标签页加载完成，返回 status、url、title。already_complete 只表示调用时页面已完成加载，不证明上一动作成功或失败。当前模型不支持图片，加载后用 get_ax_tree/read_article/find_elements 确认状态。",
    en: "Wait for a tab to finish loading, returning status, url, and title. already_complete means the page was already loaded when called; it does not prove the preceding action succeeded or failed. The current model does not support images; verify state with get_ax_tree/read_article/find_elements.",
  },
  waitForNavigationDescription: {
    "zh-CN": "等待标签页加载完成，返回 status、url、title。already_complete 只表示调用时页面已完成加载，不证明上一动作成功或失败。仅需视觉确认弹窗或验证码时传 screenshot:true。",
    en: "Wait for a tab to finish loading, returning status, url, and title. already_complete means the page was already loaded when called; it does not prove the preceding action succeeded or failed. Pass screenshot:true only for visual checks such as dialogs or CAPTCHAs.",
  },
  waitForNavigationTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID. Defaults to the current task's working tab.",
  },
  waitForNavigationTimeout: {
    "zh-CN": "超时秒数，默认 10。",
    en: "Timeout in seconds. Default: 10.",
  },
  waitForNavigationScreenshot: {
    "zh-CN": "加载完成后是否截图，默认 false。",
    en: "Capture a screenshot after loading. Default: false.",
  },
  waitForNavigationFromUrl: {
    "zh-CN": "可选：动作前 URL，用于计算 urlChanged。",
    en: "Optional pre-action URL to compute urlChanged.",
  },
  waitForNavigationFromTitle: {
    "zh-CN": "可选：动作前标题，用于计算 titleChanged。",
    en: "Optional pre-action title to compute titleChanged.",
  },
  waitForElementDescription: {
    "zh-CN": "等待页面出现指定元素（或 absent:true 等待其消失）。",
    en: "Wait for a matching element to appear on the page (or disappear when absent:true).",
  },
  waitForElementTabId: {
    "zh-CN": "目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID. Defaults to the current task's working tab.",
  },
  waitForElementSelector: {
    "zh-CN": "目标 CSS 选择器（支持原始 CSS 或 css:...，不支持 uid:... 快照引用）。",
    en: "Target CSS selector (accepts raw CSS or css:...; uid:... is not supported).",
  },
  waitForElementAbsent: {
    "zh-CN": "是否等待元素消失，默认 false。",
    en: "Wait for the element to disappear. Default: false.",
  },
  waitForElementIntervalSeconds: {
    "zh-CN": "轮询间隔秒数，默认 0.5。",
    en: "Polling interval in seconds. Default: 0.5.",
  },
  waitDescription: {
    "zh-CN": "等待指定秒数（等待网络或元素时优先用 wait_for_network_idle / wait_for_element）。",
    en: "Wait for the specified seconds (prefer wait_for_network_idle or wait_for_element for network or DOM state).",
  },
  waitSeconds: {
    "zh-CN": "等待秒数。",
    en: "Seconds to wait.",
  },
  waitUntilDescription: {
    "zh-CN": "等到指定日期时间再继续（已过时立即返回 pastDue:true）。适合定时任务提前启动准备后等待正式执行时间；最长等待 2 小时，更久请用定时任务。",
    en: "Wait until a specified date and time before continuing (returns immediately with pastDue:true if past). Useful when a scheduled task starts early to prepare; maximum wait: 2 hours (use automations for longer delays).",
  },
  waitUntilUntil: {
    "zh-CN": "目标日期时间（最长 2 小时）。推荐带时区的 ISO 8601（如 2026-07-17T12:00:00+08:00），也兼容按北京时间解释的 YYYY-MM-DD HH:mm:ss。",
    en: "Target date and time (max 2 hours). Prefer ISO 8601 with time zone (e.g. 2026-07-17T12:00:00+08:00); also accepts YYYY-MM-DD HH:mm:ss in Beijing time.",
  },
  userContinuedNoImages: {
    "zh-CN": "用户已继续。当前模型不支持图片输入，请确认当前页面状态后继续任务。",
    en: "The user continued. The current model does not support image input. Check the current page state before continuing the task.",
  },
  userContinuedWithImage: {
    "zh-CN": "用户已继续，这是当前页面状态截图，请确认并继续任务。",
    en: "The user continued. Check this screenshot of the current page, then continue the task.",
  },
  userContinued: {
    "zh-CN": "用户已继续，请确认当前页面状态后继续任务。",
    en: "The user continued. Check the current page state before continuing the task.",
  },
  navigationScreenshotFailed: {
    "zh-CN": "加载完成但截图失败，请手动 screenshot 确认页面状态",
    en: "Loading finished, but the screenshot failed. Call screenshot to check the page state.",
  },
});

export const toolT = createTranslator(messages);

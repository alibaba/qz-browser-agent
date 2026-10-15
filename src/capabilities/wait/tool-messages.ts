import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("wait-tools", {
  waitForUserDescription: {
    "zh-CN": "暂停并等待用户完成登录、验证码、授权、本地文件选择等必须亲自操作的步骤。侧边栏会显示提示，用户完成操作后点击[继续]，Agent 自动恢复。",
    en: "Pause for the user to complete a step requiring direct interaction, such as signing in, solving a CAPTCHA, granting permission, or selecting a local file. The side panel displays the instructions; the user clicks [Continue] when finished, and the agent resumes automatically.",
  },
  waitForUserMessage: {
    "zh-CN": "展示给用户的提示信息，说明需要用户做什么",
    en: "Instructions shown to the user explaining what they need to do.",
  },
  waitForUserTabId: {
    "zh-CN": "等待完成后要观测的标签页 ID；不填则用当前 session 的工作标签页",
    en: "ID of the tab to observe after the wait. Defaults to the current session’s working tab.",
  },
  askUserDescription: {
    "zh-CN": "向用户展示一个简洁的结构化表单，帮助澄清需求后再继续。适合在需求不明确、需要用户在多个选项中选择、或需要补充少量字段时使用。提交后返回用户填写的 answers。",
    en: "Show a concise structured form to clarify the user’s request before continuing. Use when requirements are unclear, the user needs to choose between options, or a few details are missing. Returns the user’s answers after submission.",
  },
  askUserTitle: {
    "zh-CN": "表单标题，默认“帮我补充信息”",
    en: "Form title. Default: “Provide more information”.",
  },
  askUserMessage: {
    "zh-CN": "给用户的简短说明，说明为什么需要这些信息",
    en: "Brief explanation of why this information is needed.",
  },
  askUserSubmitLabel: {
    "zh-CN": "提交按钮文案，默认“提交”",
    en: "Submit button label. Default: “Submit”.",
  },
  askUserFields: {
    "zh-CN": "表单字段，最多 8 个。支持 text、textarea、single_choice、multi_choice。",
    en: "Up to 8 form fields. Supports text, textarea, single_choice, and multi_choice.",
  },
  askUserId: {
    "zh-CN": "字段 ID，用于返回 answers 的 key",
    en: "Field ID, used as the key in the returned answers.",
  },
  askUserLabel: {
    "zh-CN": "字段标题",
    en: "Field label.",
  },
  askUserType: {
    "zh-CN": "字段类型",
    en: "Field type.",
  },
  askUserPlaceholder: {
    "zh-CN": "输入提示",
    en: "Input placeholder.",
  },
  askUserHelp: {
    "zh-CN": "补充说明，小字显示",
    en: "Additional help text, displayed in smaller text.",
  },
  askUserDefaultValue: {
    "zh-CN": "建议值/默认值。text/textarea/single_choice 传字符串。用户可直接提交或修改。",
    en: "Suggested/default value. Use a string for text/textarea/single_choice. The user can accept or edit it.",
  },
  askUserDefaultValues: {
    "zh-CN": "multi_choice 的默认勾选值数组。用户可直接提交或修改。",
    en: "Array of initially selected values for multi_choice. The user can accept or edit it.",
  },
  askUserRequired: {
    "zh-CN": "是否必填，默认 true",
    en: "Whether the field is required. Default: true.",
  },
  askUserOptions: {
    "zh-CN": "选择题选项。每项为 {label,value,description}；value 不填时可与 label 相同。",
    en: "Choice options. Each entry is {label,value,description}; if omitted, value may be the same as label.",
  },
  waitForNavigationNoImages: {
    "zh-CN": "等待标签页加载完成。在 click/navigate 后调用。默认只返回加载状态、URL、标题；already_complete 只表示调用时页面已完成加载，不证明上一动作成功或失败。当前模型不支持图片，加载后请用 get_ax_tree/read_article/find_elements 确认状态。",
    en: "Wait for a tab to finish loading. Use after click/navigate. By default returns only loading status, URL, and title. already_complete means the page was already loaded when called; it does not prove the preceding action succeeded or failed. The current model does not support images. Use get_ax_tree/read_article/find_elements to verify the state after loading.",
  },
  waitForNavigationDescription: {
    "zh-CN": "等待标签页加载完成。在 click/navigate 后调用。默认只返回加载状态、URL、标题；already_complete 只表示调用时页面已完成加载，不证明上一动作成功或失败。只有需要视觉确认、弹窗/验证码判断时才传 screenshot:true。",
    en: "Wait for a tab to finish loading. Use after click/navigate. By default returns only loading status, URL, and title. already_complete means the page was already loaded when called; it does not prove the preceding action succeeded or failed. Pass screenshot:true only when visual confirmation is needed, such as checking a dialog or CAPTCHA.",
  },
  waitForNavigationTabId: {
    "zh-CN": "标签页 ID；不填时使用当前任务工作标签页",
    en: "Tab ID. Defaults to the current task’s working tab.",
  },
  waitForNavigationTimeout: {
    "zh-CN": "超时秒数，默认 10",
    en: "Timeout in seconds. Default: 10.",
  },
  waitForNavigationScreenshot: {
    "zh-CN": "是否在加载完成后截图，默认 false。需要视觉确认时设为 true。",
    en: "Whether to take a screenshot after loading. Default: false. Enable for visual confirmation.",
  },
  waitForNavigationFromUrl: {
    "zh-CN": "可选：上一动作前的 URL，用于判断当前 URL 是否已变化",
    en: "Optional URL from before the preceding action, used to check whether the URL has changed.",
  },
  waitForNavigationFromTitle: {
    "zh-CN": "可选：上一动作前的标题，用于判断当前标题是否已变化",
    en: "Optional title from before the preceding action, used to check whether the title has changed.",
  },
  waitForElementDescription: {
    "zh-CN": "等待页面上出现指定元素。适合等待动态加载内容、弹窗消失、搜索结果渲染等场景。",
    en: "Wait for a specified element to appear on the page. Useful for dynamic content, dismissing dialogs, and search-result rendering.",
  },
  waitForElementTabId: {
    "zh-CN": "标签页 ID",
    en: "Tab ID.",
  },
  waitForElementSelector: {
    "zh-CN": "等待出现的元素 CSS 选择器；可传原始 CSS 或 css:...。不支持 uid:...，因为 uid 是快照引用，不适合等待未来 DOM 状态。",
    en: "CSS selector for the element to wait for. Accepts raw CSS or css:.... Does not support uid:... because a uid is a snapshot reference, unsuitable for waiting on future DOM state.",
  },
  waitForElementAbsent: {
    "zh-CN": "反转：等待元素消失，默认 false",
    en: "Invert the condition: wait for the element to disappear. Default: false.",
  },
  waitForElementIntervalSeconds: {
    "zh-CN": "轮询间隔秒数，默认 0.5",
    en: "Polling interval in seconds. Default: 0.5.",
  },
  waitDescription: {
    "zh-CN": "等待指定秒数。用于页面动画、延迟加载等场景。",
    en: "Wait for the specified number of seconds. Useful for page animations, delayed loading, and similar situations.",
  },
  waitSeconds: {
    "zh-CN": "等待秒数",
    en: "Number of seconds to wait.",
  },
  waitUntilDescription: {
    "zh-CN": "等到指定的日期和时间再继续。适合让定时任务提前启动并先做准备，然后等到正式执行时间。最长等待 2 小时；更久请创建或调整定时任务。指定时间已过时立即继续。until 推荐使用带时区的 ISO 8601；也兼容 YYYY-MM-DD HH:mm:ss（按北京时间解释）。",
    en: "Wait until a specified date and time before continuing. Useful when an automation starts early to prepare, then waits for its execution time. Maximum wait: 2 hours; for longer delays, create or adjust an automation. Continues immediately if the time has already passed. Prefer ISO 8601 with a time zone for until. Also accepts YYYY-MM-DD HH:mm:ss, interpreted as Beijing time.",
  },
  waitUntilUntil: {
    "zh-CN": "要等到的日期和时间。推荐带时区的 ISO 8601，例如 2026-07-17T12:00:00+08:00；也可传 YYYY-MM-DD HH:mm:ss，此格式固定按北京时间解释。最长等待 2 小时。",
    en: "Date and time to wait until. Prefer ISO 8601 with a time zone, such as 2026-07-17T12:00:00+08:00. Also accepts YYYY-MM-DD HH:mm:ss, always interpreted as Beijing time. Maximum wait: 2 hours.",
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

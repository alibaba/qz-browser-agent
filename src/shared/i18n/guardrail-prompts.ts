import { defineMessages } from "./definition.js";
import { createTranslator } from "./index.js";

export const promptT = createTranslator(defineMessages("guardrail-prompts", {
  heading: { "zh-CN": "## 用户配置的安全护栏（强制）", en: "## User-configured security guardrails (mandatory)" },
  policy: {
    "zh-CN": "以下规则由用户在设置页配置。访问规则按列表顺序第一条命中生效；若未被禁止，打开页面流控按列表顺序第一条命中生效。禁止规则命中时不要打开、导航、读取、截图、运行脚本或从网络/历史/书签/下载记录中获取该 URL。已打开标签页的标题、URL、tabId 等元信息可以用于判断当前状态，但不要读取其页面内容。请提前避开受限目标。",
    en: "The user configured these rules in Settings. The first matching access rule in list order applies; if access is not blocked, the first matching page-opening rate limit applies. For a blocked URL, do not open, navigate to, read, screenshot, run scripts on, or retrieve it through network/history/bookmark/download records. You may use metadata from open tabs (title, URL, tabId) to understand current state, but must not read their page content. Avoid prohibited targets in advance.",
  },
  pattern: { "zh-CN": "模糊匹配", en: "URL pattern" },
  domain: { "zh-CN": "域名", en: "Domain" },
  subdomains: { "zh-CN": "（包含所有子域名）", en: " (including all subdomains)" },
  rateLimit: { "zh-CN": "- 流控 / {type}: {value}{suffix}，打开/跳转最小间隔 {interval}。", en: "- Rate limit / {type}: {value}{suffix}; minimum interval between opening/navigating: {interval}." },
  allow: { "zh-CN": "允许访问", en: "Allow access" },
  block: { "zh-CN": "禁止访问", en: "Block access" },
  remaining: { "zh-CN": "- 另有 {count} 条护栏规则未展示，仍按顺序强制生效。", en: "- {count} additional rules are not shown here and still apply in order." },
  minutes: { "zh-CN": "{value} 分钟", en: "{value} min" },
  seconds: { "zh-CN": "{value} 秒", en: "{value} s" },
}));

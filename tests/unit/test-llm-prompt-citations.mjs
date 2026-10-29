import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MULTIMODAL_CAPABILITY_PROMPT,
  READING_CAPABILITY_PROTOCOL,
  SYSTEM_PROMPT,
  TEXT_ONLY_CAPABILITY_PROMPT,
  TEXT_ONLY_IMAGE_ASSET_PROTOCOL,
  TEXT_ONLY_READING_CAPABILITY_PROTOCOL,
  TEXT_ONLY_TARGET_TOOL_PROTOCOL,
  VISUAL_IMAGE_ASSET_PROTOCOL,
  VISUAL_SCREEN_ACTION_RULE,
  VISUAL_TARGET_TOOL_PROTOCOL,
} from "../../src/background/agent/prompts.js";
import { buildRunProfile, buildRunProfilePromptSection } from "../../src/background/agent/run-profile.js";
import { formatDynamicContext } from "../../src/background/agent/context.js";

const citationSection = sectionBetween(SYSTEM_PROMPT, "## 9. 引用、搜索与事实协议", "## 10. 安全、确认与暂停协议");

assert.doesNotMatch(SYSTEM_PROMPT, /qingzhou-documents|qingzhou-management|qingzhou-mcp|skill-workbench|site-skill-author/,
  "kernel should select capabilities from available Skills instead of requiring bundled package names");

assert.match(citationSection, /关键 claim 默认引用已读取或验证过的原始网页 URL/, "citation prompt should keep the lightweight verified-source rule");
assert.match(citationSection, /引用统一使用 Markdown footnote 格式/, "citation prompt should require the unified footnote format");
assert.match(citationSection, /正文使用 `\[\^1\]`、`\[\^2\]`/, "citation prompt should show inline footnote references");
assert.match(citationSection, /`\[\^1\]: \[页面标题\]\(URL\)`/, "citation prompt should show the footnote definition format");
assert.match(citationSection, /每个 footnote 定义必须是可点击 Markdown 链接/, "citation prompt should require clickable footnote definitions");
assert.match(citationSection, /如果没有可链接 URL，不要创建 footnote/, "citation prompt should avoid footnotes without URLs");
assert.match(citationSection, /data_store、文件产物和工具日志不是网页 footnote 来源/, "citation prompt should reject non-web artifact footnote sources");
assert.match(citationSection, /搜索引擎 AI 答案只能当线索/, "citation prompt should still require original-source verification");
assert.doesNotMatch(citationSection, /参考来源|Sources/, "citation prompt should not force a separate sources heading");
assert.doesNotMatch(citationSection, /未取得可链接来源/, "citation prompt should not prescribe a no-link limitation phrase");
assert.doesNotMatch(citationSection, /#:~:text=|Text Fragment|highlight|高亮文本/, "citation prompt should not force Chrome text-fragment anchors");
assert.doesNotMatch(citationSection, /每条 footnote 必须|同一个来源网页.*不同 highlight|证据文本/, "citation prompt should stay light rather than over-specifying provenance");

assert.match(
  SYSTEM_PROMPT,
  /当前任务工作标签页：当前 Session 的默认页面目标；页面工具省略 tabRef 时使用它。/,
  "kernel should define the session working tab as the default page target",
);
assert.match(
  SYSTEM_PROMPT,
  /用户可见标签页：本轮开始时浏览器当前窗口的 active 网页。/,
  "kernel should define the user-visible tab as a run-start fact",
);
assert.match(
  SYSTEM_PROMPT,
  /Session 类型为 user-created root session 时，用户消息中的「当前页面」「我正在看的页面」指用户可见标签页。/,
  "kernel should bind root-user page language to the user-visible tab",
);
assert.doesNotMatch(
  SYSTEM_PROMPT,
  /用户通常指当前工作标签页|浏览器当前激活标签页.*不要依赖 active tab/,
  "kernel should not retain the ambiguous legacy current-page rule",
);

assert.match(READING_CAPABILITY_PROTOCOL, /^### 视觉读取协议\n- 需要分析页面中的某张图片时/m, "visual reading protocol should include its title");
assert.match(VISUAL_SCREEN_ACTION_RULE, /1\. 首次观察目标页面：当前任务拥有的页面用 get_ax_tree\(\{root:"root"\}\)；属于其他任务且可只读的页面，用 read_article、find_elements 或 list_images 显式传 tabRef。/, "visual actions should select observation tools by tab ownership");
assert.match(VISUAL_SCREEN_ACTION_RULE, /2\. 有可靠 target 时，使用 act_on_element。/, "visual actions should route reliable targets to element actions");
assert.match(VISUAL_SCREEN_ACTION_RULE, /3\. 目标位于 Canvas 或没有可靠 target 时，调用 screenshot/, "visual actions should reserve screenshots for the screen-action branch");
assert.match(VISUAL_SCREEN_ACTION_RULE, /页面结构发生变化或 target 失效时，重新从第 1 步开始/, "visual actions should restart discovery after structural changes");
assert.match(VISUAL_SCREEN_ACTION_RULE, /screenshot\(\{actionable:true\}\)/, "visual screen actions should start from an actionable screenshot");
assert.match(VISUAL_SCREEN_ACTION_RULE, /返回图片上的原始像素坐标/, "visual screen actions should use coordinates directly from the returned image");
assert.match(VISUAL_SCREEN_ACTION_RULE, /coordinateSpace\.width\/height/, "visual screen actions should expose the current image bounds");
assert.match(VISUAL_SCREEN_ACTION_RULE, /每次 act_on_screen 都必须显式填写 returnScreenshot/, "visual screen actions should require an explicit feedback choice");
assert.match(VISUAL_SCREEN_ACTION_RULE, /视觉动作序列遵循“验证后批量”/, "visual actions should use one general verify-then-batch principle");
assert.match(VISUAL_SCREEN_ACTION_RULE, /效果符合预期、后续坐标可预测且浏览器视口稳定/, "visual batches should require observable semantic and coordinate stability");
assert.match(VISUAL_SCREEN_ACTION_RULE, /viewportChange 只记录浏览器视口是否变化/, "visual actions should distinguish viewport facts from application effects");
assert.match(VISUAL_SCREEN_ACTION_RULE, /只有 true 才产生观察截图；false 在坐标空间仍有效时沿用原依据/, "visual actions should make observation capture explicit");
assert.match(VISUAL_SCREEN_ACTION_RULE, /run_script 会返回内部最后一次 screenshot 或 act_on_screen\(returnScreenshot:true\) 的图片/, "visual batches should return the last explicit observation");
assert.doesNotMatch(VISUAL_SCREEN_ACTION_RULE, /会滚动、缩放、改尺寸.*主 Agent 逐步执行/, "the prompt should not blanket-ban action kinds whose effects depend on the page");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /^### 文本读取协议\n- 当前模型不能看图/m, "text-only reading protocol should include its title");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /1\. 首次观察目标页面：当前任务拥有的页面用 get_ax_tree\(\{root:"root"\}\)；属于其他任务且可只读的页面，用 read_article、find_elements 或 list_images 显式传 tabRef。/, "text-only actions should select observation tools by tab ownership");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /2\. 有可靠 target 时，使用 act_on_element。/, "text-only actions should use element actions for reliable targets");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /3\. 没有可靠 target 时，使用 find_elements、inspect_element 或页面读取工具继续定位/, "text-only actions should keep locating without visual tools");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /仍无法定位就说明限制，不进行视觉猜测操作/, "text-only actions should fail clearly instead of guessing visually");
assert.match(SYSTEM_PROMPT, /### 视觉读取协议\n- 需要分析页面中的某张图片时/, "system prompt should embed the visual reading protocol as one unit");
assert.doesNotMatch(SYSTEM_PROMPT, /### 文本读取协议/, "default system prompt should stay multimodal");
const textOnlyPrompt = SYSTEM_PROMPT.replace(READING_CAPABILITY_PROTOCOL, TEXT_ONLY_READING_CAPABILITY_PROTOCOL);
assert.match(textOnlyPrompt, /### 文本读取协议\n- 当前模型不能看图/, "text-only replacement should swap the protocol title and body");
assert.doesNotMatch(textOnlyPrompt, /### 视觉读取协议/, "text-only replacement should remove the visual protocol title");
assert.match(SYSTEM_PROMPT, /属于其他任务且动态上下文标为可只读的页面，用 read_article、find_elements 或 list_images 显式传 tabRef/, "kernel should route foreign tabs to the explicit read-only tool set");
assert.doesNotMatch(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /\b(?:screenshot|read_image|read_image_asset)\b/, "text-only reading protocol should not name hidden vision tools");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /先通过 list_images 返回的 alt\/title、context、URL 和尺寸等元信息发现候选/, "visual image protocol should define one positive candidate-selection workflow");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /用 read_image\(\{target\}\) 查看必要候选/, "visual image protocol should inspect visual candidates before saving");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /以当前 tab 为一个工作单元/, "visual image protocol should scope discovery and collection to one tab at a time");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /候选一经确认，就在离开、跳转或切换当前 tab 之前调用 collect_images 采集/, "visual image protocol should collect accepted candidates before changing page context");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /数量不足再进入下一个 tab，并继续写入同一个图集/, "visual image protocol should continue incrementally across tabs");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /target 是当前页面候选在工具间传递的机器引用/, "visual image protocol should make target the page-local cross-tool reference");
assert.match(VISUAL_IMAGE_ASSET_PROTOCOL, /URL 按发现它的当前 tab 和来源域及时采集/, "visual image protocol should keep URL collection local to its discovery context");
assert.doesNotMatch(VISUAL_IMAGE_ASSET_PROTOCOL, /全量|整页图片|大容器|indexes|精确 selector/, "visual image protocol should expose one selection workflow without a bulk branch");
assert.match(TEXT_ONLY_IMAGE_ASSET_PROTOCOL, /context 中的可访问名称、说明、附近标题与正文、链接语义/, "text-only image protocol should use candidate semantic context");
assert.match(TEXT_ONLY_IMAGE_ASSET_PROTOCOL, /以当前 tab 为一个工作单元/, "text-only image protocol should use the same tab-local collection workflow");
assert.match(TEXT_ONLY_IMAGE_ASSET_PROTOCOL, /离开、跳转或切换当前 tab 之前调用 collect_images 采集/, "text-only image protocol should collect accepted metadata candidates before changing context");
assert.match(TEXT_ONLY_IMAGE_ASSET_PROTOCOL, /文本证据不足以完成选择时，向用户说明已确认的候选元信息并请求选择/, "text-only image protocol should request a choice when evidence is insufficient");
assert.doesNotMatch(TEXT_ONLY_IMAGE_ASSET_PROTOCOL, /全量|整页图片|大容器|indexes|精确 selector/, "text-only image protocol should expose one selection workflow without a bulk branch");
assert.match(TEXT_ONLY_READING_CAPABILITY_PROTOCOL, /图片采集只能依据 URL\/meta 和页面文本证据，不能声称已筛选视觉质量或看到了图片内容/, "text-only reading protocol should retain the visual-evidence boundary");

const fullTextOnlyPrompt = SYSTEM_PROMPT
  .replace(MULTIMODAL_CAPABILITY_PROMPT, TEXT_ONLY_CAPABILITY_PROMPT)
  .replace(READING_CAPABILITY_PROTOCOL, TEXT_ONLY_READING_CAPABILITY_PROTOCOL)
  .replace(VISUAL_TARGET_TOOL_PROTOCOL, TEXT_ONLY_TARGET_TOOL_PROTOCOL)
  .replace(VISUAL_IMAGE_ASSET_PROTOCOL, TEXT_ONLY_IMAGE_ASSET_PROTOCOL);
assert.match(fullTextOnlyPrompt, /### 文本读取协议/, "full text-only prompt should include the text reading protocol");
assert.match(fullTextOnlyPrompt, /### 图片资料/, "full text-only prompt should include text-only image material guidance");
assert.match(fullTextOnlyPrompt, /图片采集以当前 tab 为一个工作单元/, "full text-only prompt should define the tab-local candidate-selection workflow");
assert.doesNotMatch(fullTextOnlyPrompt, /\b(?:screenshot|act_on_screen|read_image|read_image_asset)\b/, "full text-only prompt should not mention hidden vision tools");

const textOnlyRunProfileSection = buildRunProfilePromptSection({
  session: { kind: "user", canManageSessions: true },
  model: { provider: "test", id: "text-only", trimOldToolResults: true },
  features: { imageInput: false },
});
assert.match(textOnlyRunProfileSection, /单模态策略: 页面观察优先使用/, "text-only run profile should keep a positive observation strategy");
assert.doesNotMatch(textOnlyRunProfileSection, /\b(?:screenshot|act_on_screen|read_image|read_image_asset)\b/, "text-only run profile should not mention hidden vision tools");

const textOnlyRunProfile = await buildRunProfile({
  sessionId: "session_text_only",
  config: {
    provider: "test",
    model: "text-only",
    vision: false,
    toolCalling: true,
    contextWindow: 128000,
    trimOldToolResults: true,
  },
});
assert.deepEqual(
  textOnlyRunProfile.tools.disabled.filter((name) => ["screenshot", "act_on_screen", "read_image"].includes(name)).sort(),
  ["act_on_screen", "read_image", "screenshot"],
  "text-only run profile should disable every core vision tool",
);
assert.equal(textOnlyRunProfile.features.imageInput, false, "text-only run profile should reject image input");
assert.equal(textOnlyRunProfile.features.screenshots, false, "text-only run profile should reject screenshot results");
assert.equal(textOnlyRunProfile.features.toolImages, false, "text-only run profile should reject tool image results");

const visualRunProfile = await buildRunProfile({
  sessionId: "session_visual",
  config: {
    provider: "test",
    model: "visual",
    vision: true,
    toolCalling: true,
    contextWindow: 128000,
    trimOldToolResults: true,
  },
});
assert.equal(visualRunProfile.features.imageInput, true, "visual run profile should accept image input");
assert.equal(visualRunProfile.features.screenshots, true, "visual run profile should accept screenshot results");
assert.equal(visualRunProfile.features.toolImages, true, "visual run profile should accept tool image results");
assert.equal(visualRunProfile.tools.disabled.includes("screenshot"), false, "visual run profile should expose screenshot");
assert.equal(visualRunProfile.tools.disabled.includes("act_on_screen"), false, "visual run profile should expose screen actions");
assert.equal(visualRunProfile.tools.disabled.includes("read_image"), false, "visual run profile should expose read_image");

const agentSource = readFileSync(new URL("../../src/background/agent/agent.ts", import.meta.url), "utf8");
assert.match(agentSource, /READING_CAPABILITY_PROTOCOL/, "agent should replace the complete reading protocol");
assert.match(agentSource, /TEXT_ONLY_READING_CAPABILITY_PROTOCOL/, "agent should replace the complete reading protocol for text-only models");
const foreignTabContext = formatDynamicContext({
  workingTab: { id: 1, url: "https://owned.test/" },
  userVisibleTab: { id: 2, url: "https://other.test/", ownerSessionId: "other-session", ownedByCurrentTask: false },
});
assert.match(foreignTabContext, /可用 read_article、find_elements 或 list_images 显式传 tabRef 查看/, "dynamic context should name the cross-session read tools instead of relying on an ambiguous read-only label");
assert.doesNotMatch(foreignTabContext, /可用 use_tab/, "foreign visible pages must not invite ownership transfer");
assert.match(agentSource, /VISUAL_TARGET_TOOL_PROTOCOL[\s\S]*TEXT_ONLY_TARGET_TOOL_PROTOCOL/, "agent should replace visual target guidance");
assert.match(agentSource, /VISUAL_IMAGE_ASSET_PROTOCOL[\s\S]*TEXT_ONLY_IMAGE_ASSET_PROTOCOL/, "agent should replace visual image asset guidance");
assert.doesNotMatch(agentSource, /VISION_READING_RULE|TEXT_ONLY_READING_RULE/, "agent should not replace only the reading rule body");

console.log("llm prompt citation contract tests passed");

function sectionBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

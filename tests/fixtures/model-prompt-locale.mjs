import assert from "node:assert/strict";
import { createTestAgentOptions, createTestAgentServices } from "../support/agent-services.mjs";

// Set the browser language before importing any runtime modules. Each invocation is a fresh
// extension-like process, so constant prompts and lazily formatted envelopes agree.
const language = process.argv[2];
globalThis.chrome = { i18n: { getUILanguage: () => language } };
const { Agent } = await import("../../src/background/agent/agent.ts");
const prompts = await import("../../src/background/agent/prompts.ts");
const context = await import("../../src/background/agent/context.ts");
const { formatCompactContent, extractCompactSummary } = await import("../../src/background/agent/compaction.ts");
const { buildSecurityGuardrailPromptSection } = await import("../../src/shared/security-guardrails.ts");
const { promptT: skillPrompt } = await import("../../src/background/skills/prompt-messages.ts");
const en = language === "en";
const requestText = "保留这条用户请求 {name} <script>literal</script>";
const referenceText = "保留页面文本 {count}";
const residentText = "Keep this resident instruction unchanged: 中文 {skills}";
const skillSection = skillPrompt("residents", { skills: residentText })
  + skillPrompt("available") + "\n" + skillPrompt("noGlobals") + skillPrompt("sites", { count: 2 });
const guardrails = { blockedDomains: ["blocked.example"], blockedPatterns: ["*://example.com/private/*"] };
const requests = [];

for (const vision of [true, false]) for (const canManageSessions of [true, false]) {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  let imageMessages;
  const agent = new Agent(`prompt-${vision}-${canManageSessions}`, createTestAgentOptions({
    services: createTestAgentServices({
      getRuntimeConfig: async () => ({ provider: "test", model: "test-model", contextWindow: 262000, vision }),
      buildSkillPromptSection: async () => skillSection,
      getSecurityGuardrails: async () => guardrails,
    }),
    sessionPolicy: { canManageSessions: async () => canManageSessions },
    llm: {
      async *chatStream(messages) {
        requests.push(structuredClone(messages));
        imageMessages = agent._buildToolResultMessages("image-call", { _image: image }, false);
        yield { type: "done", message: { role: "assistant", content: "done" } };
      },
      async chat() { throw new Error("Unexpected fallback"); },
    },
  }));
  await agent.prompt(requestText, { sources: [{ id: "ref", title: "Reference", text: referenceText }] });
  const request = requests.at(-1);
  const system = request[0].content;
  assert.ok(system.includes(residentText), "Resident instruction is not translated or interpolated again");
  assert.ok(request.some(item => item.content === requestText), "User request is unchanged");
  assert.ok(request.some(item => String(item.content).includes(referenceText)), "Source content is unchanged");
  const localizedSystem = system.replace(residentText, "");
  if (en) {
    assert.doesNotMatch(localizedSystem, /\p{Script=Han}/u, "English model instructions contain no Chinese copy");
    assert.match(system, /Prefer the language of the user's current request/);
    assert.match(system, /first matching access rule/);
    assert.match(system, /not new user instructions/);
  } else {
    assert.match(system, /回复优先使用用户本轮请求的语言/);
    assert.match(system, /访问规则按列表顺序第一条命中生效/);
  }
  assert.ok(system.includes(vision ? prompts.READING_CAPABILITY_PROTOCOL : prompts.TEXT_ONLY_READING_CAPABILITY_PROTOCOL));
  assert.equal(system.includes(prompts.VISUAL_IMAGE_ASSET_PROTOCOL), vision);
  assert.equal(system.includes(prompts.GOAL_DRIVEN_RULE), canManageSessions);
  assert.equal(system.includes(prompts.RESTRICTED_GOAL_RULE), !canManageSessions);
  const sessionRestriction = en
    ? /do not create, manage, wait for, or delete other sessions\/scheduled tasks/gi
    : /(?:不要|不能)创建、管理、等待或删除其他 session\/定时任务/g;
  assert.equal(system.match(sessionRestriction)?.length || 0, canManageSessions ? 0 : 1,
    "Session restrictions appear once in the actual model request");
  if (!canManageSessions) assert.equal(system.match(/\bmanage_goal\b/g)?.length, 1,
    "Restricted sessions receive one goal prohibition without root goal instructions");
  assert.ok(system.includes('target = "uid:" <element_uid> | "css:" <css_selector>'));
  assert.ok(system.includes('schedule.type="once"'));
  assert.ok(system.includes('runtime:"inner"'));
  assert.ok(system.includes('network.allowedOrigins'));
  assert.equal(imageMessages.length, vision ? 2 : 1);
  if (en) assert.doesNotMatch(JSON.stringify(imageMessages), /\p{Script=Han}/u);
  if (vision) assert.equal(imageMessages[1].content[1].image_url.url, image);
  else assert.match(imageMessages[0].content, /get_ax_tree\/read_article\/find_elements\/inspect_element/);
}

assert.equal(prompts.SYSTEM_PROMPT, prompts.getAgentPrompts(language).SYSTEM_PROMPT);
assert.equal(prompts.buildCompactUserPrompt(), prompts.COMPACT_USER_PROMPT);
const custom = "保留这个要求 {value}";
assert.ok(prompts.buildCompactUserPrompt(custom).endsWith(custom));
const titleMessages = prompts.buildSessionTitleMessages(requestText);
assert.deepEqual(JSON.parse(titleMessages[1].content), { source_text: requestText });
assert.match(titleMessages[0].content, en ? /read-only material/ : /只读/);
const summary = formatCompactContent(requestText);
assert.equal(extractCompactSummary(summary), requestText);
for (const header of ["[之前的对话摘要]", "[Previous conversation summary]"]) {
  assert.equal(extractCompactSummary(`${header}\n${requestText}`), requestText, "History remains readable after a language change");
}

const synthetic = {
  now: "2026-09-19 09:00:00",
  workingTab: { id: 1, title: "Page", url: "https://example.com", securityGuardrailBlocked: true },
  userVisibleTab: { id: 2, title: "Other page", url: "https://other.example", ownerSessionId: "other" },
  sessions: [{ id: "other", title: "Task", running: true }],
  tracker: { title: "Progress", total: 2, current: 1, mode: "steps", currentStep: 1, steps: ["Check"], stats: { total: 2 }, note: "Working" },
  siteSkills: [{ name: "site-skill", displayName: "Site skill", description: "Read this site", matchedDomain: "example.com" }],
  location: { latitude: 1, longitude: 2, accuracy: 10, timestamp: "2026-09-19" },
  goal: { status: "blocked", objective: "Collect records", progress: "One saved", criteria: "Two records", next: "Resume", checkpoint: "table-a", version: 1 },
};
const rendered = [
  context.buildContextCapsuleMessage(synthetic).content,
  context.buildGoalSnapshotCapsuleMessage(synthetic).content,
  context.buildGoalDeletedContextEventMessage(synthetic.goal).content[0].text,
  context.formatGoalForCompaction(synthetic.goal),
  context.buildSiteSkillContextEventMessage([], synthetic.siteSkills).content[0].text,
  context.buildDocumentCapsuleMessage([{
    sessionId: "session", messageId: "message", attachmentId: "attachment", fileId: "file", docModelId: "document-model",
    filename: "report.pdf", mimeType: "application/pdf", format: "pdf", size: 123,
  }]).content,
  buildSecurityGuardrailPromptSection(guardrails),
  prompts.COMPACT_SYSTEM_PROMPT, prompts.COMPACT_USER_PROMPT, titleMessages[0].content,
].join("\n");
if (en) assert.doesNotMatch(rendered, /\p{Script=Han}/u);
else assert.match(rendered, /当前任务工作标签页/);

assert.ok(context.formatDynamicContext({ tracker: { mode: "pagination", current: 3, total: 5, unit: "pages" } })
  .includes(en ? "Progress: 3/5 pages" : "进度: 3/5pages"));
assert.ok(context.formatDynamicContext({ tracker: { mode: "generic", current: 3, unit: "用户单位" } })
  .includes(en ? "Processed: 3 用户单位" : "已处理: 3用户单位"), "Spacing is localized; user-defined units are preserved");

const { createAutomationRepository } = await import("../../src/background/automation/repository.ts");
const { createAutomationRuntime } = await import("../../src/background/automation/runtime.ts");
const stored = {};
const repository = createAutomationRepository({ storage: {
  async get() { return structuredClone(stored); },
  async set(patch) { Object.assign(stored, structuredClone(patch)); },
  async remove(key) { delete stored[key]; },
} });
let automationPrompt = "";
const automation = await repository.saveDefinition({
  title: "Daily check", instruction: requestText, schedule: { type: "daily", time: "09:00" }, enabled: true,
});
const automationRuntime = createAutomationRuntime({
  repository,
  sessions: {
    async create({ prompt }) { automationPrompt = prompt; return { id: "automation-session" }; },
    launch() { return true; },
    getRuntime() { return { status: "running", running: true }; },
    async remove() {}, async getConversation() { return []; }, async getTranscript() { return []; },
  },
});
await automationRuntime.run(automation.id);
assert.ok(automationPrompt.endsWith(requestText));
if (en) {
  assert.doesNotMatch(automationPrompt.replace(requestText, ""), /\p{Script=Han}/u);
  assert.match(automationPrompt, /Do not ask whether to start/);
} else assert.match(automationPrompt, /不要询问是否开始/);

const { normalizeModernSkill } = await import("../../src/shared/skills/skill-utils.ts");
const installedDescription = "用户自己的中文说明 {text}";
const installedName = "用户技能";
const installed = normalizeModernSkill({
  name: "user-resident", displayName: installedName, description: installedDescription,
  content: residentText, scope: "resident", status: "active",
  resources: [{ path: "references/notes.md", type: "markdown", title: "用户资料", content: "用户文档" }],
});
const skillStorage = { _skills: { [installed.name]: installed } };
globalThis.chrome.storage = { local: {
  async get() { return structuredClone(skillStorage); },
  async set(patch) { Object.assign(skillStorage, structuredClone(patch)); },
} };
const { buildSkillPromptSection } = await import("../../src/background/skills/runtime.ts");
const installedSection = await buildSkillPromptSection();
assert.ok(installedSection.includes(residentText));
assert.ok(installedSection.includes(installedDescription));
assert.ok(installedSection.includes(installedName));
assert.ok(installedSection.includes("references/notes.md"));
assert.match(installedSection, en ? /Resident Skills \(included in full\)/ : /Resident Skills（完整注入）/);
assert.match(installedSection, en ? /Resources \(references only/ : /资源清单（仅作引用坐标/);
assert.ok(installedSection.includes(`${en ? "Description: " : "描述："}${installedDescription}`));

console.log(`Verified ${language}: ${requests.length} actual Agent requests, capability/restriction policies, context, compaction, titles, Skills, guardrails, automation, and unchanged user content.`);

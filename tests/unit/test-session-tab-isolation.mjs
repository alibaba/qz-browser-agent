import { createTestAgentServices } from "../support/agent-services.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

globalThis.chrome = {
  bookmarks: {},
  debugger: {
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  history: {},
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

const { Agent } = await import("../../src/background/agent/agent.js?session-tab-isolation");

const root = new URL("../../", import.meta.url);

function readProjectFile(relativePath) {
  let sourceUrl = new URL(relativePath, root);
  if (!existsSync(sourceUrl) && relativePath.endsWith(".js")) sourceUrl = new URL(relativePath.replace(/\.js$/, ".ts"), root);
  const source = readFileSync(sourceUrl, "utf8");
  return sourceUrl.pathname.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
}

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing block start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing block end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const serviceWorker = readProjectFile("src/background/service-worker.js");
const sessionCommands = readProjectFile("src/background/session/commands.js");
const sessionTabs = readProjectFile("src/background/session/tabs.js");
const browserContext = readProjectFile("src/background/session/browser-context.js");
const tools = readProjectFile("src/background/tools/runtime.js");
const elementRuntime = readProjectFile("src/background/tools/element-runtime.js");
const agent = readProjectFile("src/background/agent/agent.ts");
const dynamicContext = readProjectFile("src/background/agent/context.ts");
const qingzhouPlugin = readProjectFile("src/shared/skills/skill-manifest.js");

assert.doesNotMatch(
  `${serviceWorker}\n${sessionTabs}`,
  /findActiveWorkingTabOwner|cloneWorkingTab|ensureExclusiveWorkingTab|releaseOwnedTabFromOtherSessions|ownership_transferred/,
  "session runtime should not silently clone, transfer, or steal active working tabs",
);
assert.match(
  serviceWorker,
  /resolveTargetTab:\s*sessionTabs\.resolveTargetTab/,
  "tools should have one session-owned target resolver",
);
assert.match(
  sessionTabs,
  /code:\s*"SESSION_TAB_FOREIGN"/,
  "foreign tab access should be a first-class denied state",
);
assert.match(
  sessionTabs,
  /function owns\(sessionId\s*, tabId\s*\)/,
  "working tab context should be guarded by owned tab membership",
);

const collectBrowserContext = sliceBetween(
  browserContext,
  "async function collect(",
  "return Object.freeze({ collect });",
);
assert.match(
  collectBrowserContext,
  /getOwnedTabContexts/,
  "browser context should expose only session-owned tabs",
);
assert.match(
  collectBrowserContext,
  /userVisibleTab/,
  "browser context should expose the user-visible page as read-only intent context",
);
assert.doesNotMatch(
  collectBrowserContext,
  /activeTab|initial_active_tab/,
  "browser context must not derive executable page target from legacy activeTab state",
);

const pluginUiContext = sliceBetween(
  sessionCommands,
  "async function buildSkillUiContext",
  "function formatSessionRuntimeRecord",
);
assert.match(
  pluginUiContext,
  /sessionTabs\.getOwnedTabContexts/,
  "plugin UI context should receive session-owned tabs",
);
assert.doesNotMatch(
  pluginUiContext,
  /chrome\.tabs\.query|activeTab|currentWindow/,
  "plugin UI context must not scan global active tabs",
);

assert.doesNotMatch(
  `${agent}\n${dynamicContext}`,
  /context\.activeTab|当前浏览器标签页|chrome\.tabs\.query/,
  "agent dynamic context should not contain legacy activeTab state or query tabs itself",
);
const contextAgent = new Agent("context-contract", {
    services: createTestAgentServices(),
  conversationRepository: {
    readActiveConversation: async () => null,
    writeActiveConversation: async () => true,
    clearActiveConversation: async () => true,
  },
});
const foreignVisibleContext = contextAgent._formatDynamicContext({
  workingTab: { id: 11, title: "Working", url: "https://working.test/" },
  tabs: [{ id: 11, title: "Working", url: "https://working.test/" }],
  userVisibleTab: {
    id: 22,
    title: "Visible",
    url: "https://visible.test/",
    ownerSessionId: "other-session",
    ownedByCurrentTask: false,
  },
});
assert.match(foreignVisibleContext, /当前任务最近访问的标签页: \[tabRef=11\] Working/, "recent page context is informational");
assert.match(foreignVisibleContext, /用户可见标签页.*\[tabRef=22\] Visible.*属于其他任务 other-session/, "a foreign visible page is an ownership-qualified fact");
assert.match(foreignVisibleContext, /当前任务标签页:[\s\S]*\[tabRef=11\]/, "task pages expose an explicit reference");
assert.doesNotMatch(foreignVisibleContext, /页面工具默认目标|→/, "neither recent nor visible pages become implicit tool targets");
assert.doesNotMatch(contextAgent._formatDynamicContext({ userVisibleTab: { id: 22 } }), /最近访问|默认目标/, "visible context does not invent a recent or default page");
assert.doesNotMatch(foreignVisibleContext, /可先 use_tab 接管|canTakeOver/, "foreign visible pages do not imply transfer permission");
for (const toolName of ["read_article", "find_elements", "list_images"]) {
  assert.match(foreignVisibleContext, new RegExp(`\\b${toolName}\\b`), `foreign visible tabs should advertise ${toolName}`);
}
assert.doesNotMatch(
  foreignVisibleContext,
  /\buse_tab\b/,
  "foreign visible-tab context should not suggest ownership transfer",
);
assert.doesNotMatch(
  foreignVisibleContext,
  /工作标签页\(session\)|用户可见标签页\(只读提示\)/,
  "agent dynamic context should not retain ambiguous legacy page labels",
);
assert.doesNotMatch(
  agent,
  /_refreshDynamicContextSnapshot\(null, `tool:\$\{toolName\}`\)/,
  "tool execution should not refresh the LLM dynamic-context snapshot inside a run",
);
assert.match(
  agent,
  /async _maybeRefreshDynamicContextForSiteSkills\(/,
  "agent should have a narrow in-run refresh path for site skill activation",
);
assert.match(
  agent,
  /const previousSkills = Array\.isArray\(this\._dynamicContextSnapshot\.siteSkills\)[\s\S]*const previousSignature = siteSkillSignature\(previousSkills\);/,
  "site skill refresh should compare the previous matched skill set",
);
assert.match(
  agent,
  /if \(nextSignature === previousSignature\) return null;/,
  "site skill refresh should skip rebuilding dynamic context when matched skills do not change",
);
assert.match(
  agent,
  /_buildSiteSkillContextEventMessage\(previousSkills,\s*snapshot\.siteSkills \|\| nextSkills,\s*toolName\)/,
  "site skill refresh should emit a hidden context event after the skill set changes",
);
assert.doesNotMatch(
  agent,
  /_collectToolRuntimeContext|_enrichToolCallArgsWithPageContext/,
  "Agent forwards explicit page arguments without a context-derived default",
);

assert.doesNotMatch(
  qingzhouPlugin,
  /context\.activeTab|context\.tabs/,
  "site plugin activation should not use global active tab or all browser tabs",
);
assert.match(
  qingzhouPlugin,
  /context\.workingTab\?\.url/,
  "site plugin activation should still use the session working tab",
);
assert.match(
  qingzhouPlugin,
  /context\.taskSiteTabs/,
  "site plugin activation should include task site history",
);

assert.doesNotMatch(
  tools,
  /getActiveTabId|withExclusiveWorkingTab|ensureExclusiveWorkingTab/,
  "tool execution should not fall back to active tab or clone-based exclusivity",
);
assert.match(
  tools,
  /const executionArgs = await withSessionOwnedTarget/,
  "tool execution should resolve page targets before execution",
);
assert.match(
  tools,
  /sessions\?\.resolveTargetTab\?\./,
  "tools should call the central session target resolver",
);
assert.match(
  elementRuntime,
  /source:\s*"element_uid_reference"/,
  "UID-based element operations should also verify session tab ownership",
);

const sendToContent = sliceBetween(
  tools,
  "export async function sendToContent",
  "const coreToolDefinitions = createToolRegistry();",
);
assert.match(
  sendToContent,
  /TAB_REF_REQUIRED/,
  "content script calls should require an explicit session-owned tab",
);
assert.doesNotMatch(
  sendToContent,
  /chrome\.tabs\.query|activeTab/,
  "content script calls must not infer browser active tab",
);

const resolveGuardrailTargetTabId = sliceBetween(
  tools,
  "function resolveGuardrailTargetTabId",
  "function collectGuardrailCandidateUrls",
);
assert.doesNotMatch(
  resolveGuardrailTargetTabId,
  /chrome\.tabs\.query|activeTab/,
  "guardrail checks should use resolved explicit tool arguments",
);

console.log("session tab isolation tests passed");

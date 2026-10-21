import { getAgentPrompts } from "../../src/background/agent/prompts.js";
import { registerGoalTools } from "../../src/capabilities/sessions/goal-tools.js";
import { shouldExposeGoalContext, buildGoalSnapshotCapsuleMessage, buildGoalDeletedContextEventMessage } from "../../src/background/agent/context.js";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import * as taskStateRuntime from "../../src/background/session/task-state.js";
import { transformSync } from "esbuild";
import { stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getCoreToolMetadata } from "../../src/shared/tools/tool-metadata.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function readProjectFile(relativePath) {
  const candidate = join(root, relativePath);
  const path = !existsSync(candidate) && candidate.endsWith(".js") ? candidate.replace(/\.js$/, ".ts") : candidate;
  const source = readFileSync(path, "utf8");
  return path.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
}

function blockBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing block start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing block end after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  if (source.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated signature for ${name}`);
  const braceStart = source.indexOf("{", parenEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const tools = readProjectFile("src/background/tools/runtime.js");
const agent = transformSync(readProjectFile("src/background/agent/agent.ts"), { loader: "ts", target: "esnext", format: "esm", charset: "utf8" }).code;
const serviceWorker = readProjectFile("src/background/service-worker.js");
const sessionCommands = stripTypeScriptTypes(readProjectFile("src/background/session/commands.ts"));
const sessionAgentHost = stripTypeScriptTypes(readProjectFile("src/background/session/agent-host.ts"));
const sessionContext = readProjectFile("src/capabilities/sessions/context.ts");
const runtimeReducer = stripTypeScriptTypes(readProjectFile("src/background/session/runtime-reducer.ts"));
const taskState = stripTypeScriptTypes(readProjectFile("src/background/session/task-state.ts"));
const sidepanelTransport = readProjectFile("src/background/transports/sidepanel.js");
const prompts = getAgentPrompts("zh-CN");
const runProfile = readProjectFile("src/background/agent/run-profile.ts");
const sessionState = readProjectFile("src/sidepanel/features/sessions/session-state.ts");
const eventRouter = stripTypeScriptTypes(readProjectFile("src/sidepanel/features/app/sidepanel-event-router.ts"), { mode: "transform" });
const appShell = stripTypeScriptTypes(readProjectFile("src/sidepanel/features/app/app-shell-feature.ts"), { mode: "transform" });
const chatWorkspace = readProjectFile("src/sidepanel/features/chat/chat-workspace-feature.js");
const goalStripFeature = stripTypeScriptTypes(readProjectFile("src/sidepanel/features/chat/goal-strip-feature.ts"));
const sessionsFeature = readProjectFile("src/capabilities/sessions/sessions-feature.js");
const toastFeature = readProjectFile("src/sidepanel/ui/toast-feature.ts");
const sidepanel = [sessionState, eventRouter, appShell, chatWorkspace, goalStripFeature, sessionsFeature, toastFeature].join("\n");
const sidepanelHtml = readProjectFile("src/sidepanel/sidepanel.html");
const sidepanelCss = ["src/sidepanel/sidepanel.css", "src/capabilities/sessions/ui.css"].map(path => readStylesheetSource(join(root, path))).join("\n");

const goalDefinitions = new Map();
const goalCalls = [];
registerGoalTools({
  registerTool: definition => goalDefinitions.set(definition.name, definition),
  ToolExecutionError: class extends Error {},
  getToolRuntimeDependencies: context => ({ sessions: {
    updateGoal: input => { goalCalls.push({ context, input }); return { active: false }; },
  } }),
});
const manageGoal = goalDefinitions.get("manage_goal");
assert.deepEqual(manageGoal.parameters.properties.action.enum, ["create", "checkpoint", "update", "block", "complete", "pause", "resume", "clear", "get"], "manage_goal should expose the compact action set");
assert.equal(manageGoal.parameters.properties.status, undefined, "manage_goal input should not duplicate state with a status field");
const goalContext = { sessionId: "goal-contract", runId: "run-contract" };
const goalSignal = new AbortController().signal;
assert.deepEqual(await manageGoal.execute({ action: "get" }, goalSignal, goalContext), { active: false });
assert.deepEqual(goalCalls, [{ context: goalContext, input: { action: "get", sessionId: "goal-contract", runId: "run-contract", signal: goalSignal } }], "manage_goal should delegate through the explicit tool runtime");
assert.match(manageGoal.description, /已经写入 data_store、图集或文件等 durable 进展后/, "manage_goal should document durable checkpoint timing");

assert.match(sessionCommands, /function updateSessionGoal\(/, "session commands should own goal runtime updates");
assert.match(sessionCommands, /function clearSessionGoalRuntime\(/, "UI goal deletion should have a dedicated runtime operation");
assert.match(sessionAgentHost, /function ensureConversationForHistoryMutation\(/, "goal deletion should restore stored history before appending hidden events");
assert.match(sessionCommands, /if \(action === "get"\)[\s\S]*runtimeUpdatedAt: getSessionRuntimeState\(id\)\.updatedAt/, "manage_goal get should be read-only");
assert.match(taskState, /export function normalizeSessionGoal\(/, "task state should normalize compact goal state");
assert.match(sessionCommands, /normalizeSessionGoal[\s\S]*from "\.\/task-state\.js"/, "session commands should consume the shared task state rules");
assert.match(serviceWorker, /updateGoal: sessionCommands\.updateSessionGoal/, "tools should reach goal updates through the runtime controller");
assert.match(sessionCommands, /function canUseSessionGoal\(/, "session commands should gate goal access by session kind");
assert.match(sessionContext, /if \(await host\.canUseSessionGoal\(sessionId\)\) \{\s*const goal = normalizeSessionGoal\(runtime\.goal\);\s*if \(goal && goal\.status !== "complete"\) context\.goal = goal;/, "session capability should expose normalized, authorized unfinished goals");
assert.match(sessionAgentHost, /contextCapabilities\.flatMap\(contribute => contribute\(contextHost\)\)/, "session host should register the discovered context capabilities");
assert.match(sessionAgentHost, /return \{ \.\.\.record\(values\.get\("session"\)\)/, "session capability values should enter dynamic context");
assert.match(sessionCommands, /goal: normalizeSessionGoal\(persisted\.goal\)/, "runtime snapshots should include normalized goal state");
assert.match(sessionCommands, /goal: canExposeSessionGoal\(session\) \? runtime\.goal : null/, "session list records should hide goals outside root sessions");
assert.match(sidepanelTransport, /clear_goal:\s*\{\s*method:\s*"sessions\.clearGoal"/, "sidepanel should clear goals through the Background API");
assert.match(sessionCommands, /const agent = await agentHost\.getAgent\(id\)[\s\S]*const historyReady = await agentHost\.ensureConversationForHistoryMutation\(id, agent\)[\s\S]*if \(historyReady\)[\s\S]*const appendResult = await agent\.appendGoalDeletedEvent\(previous\)[\s\S]*eventDeferred = appendResult === "deferred"/, "goal deletion events should be delegated to the agent-safe context event queue after stored history is loaded");
const resetRuntimeBlock = extractFunction(runtimeReducer, "reduceSessionRuntimePatch");
assert.match(resetRuntimeBlock, /case "reset":[\s\S]*goal:\s*null/, "reset should clear goal state in the runtime reducer");

assert.match(agent, /prompt\.replace\(prompts\.GOAL_DRIVEN_RULE, prompts\.RESTRICTED_GOAL_RULE\)/, "restricted sessions should not receive root goal instructions");
assert.match(agent, /_buildGoalSnapshotCapsuleMessage\(dynamicContext, "user_message"\)/, "real user messages should carry a fresh goal snapshot when a goal is active");
assert.match(agent, /await this\._appendGoalSnapshotIfDue\(dynamicContext, "periodic"\)/, "long tool loops should refresh goal snapshots periodically");
assert.match(agent, /effect.type !== "context.goalRefresh"[\s\S]*_refreshDynamicContextSnapshot\(null, `goal_context:\$\{toolName\}`\)[\s\S]*effect.action.trim\(\) !== "get"/, "trusted goal effects refresh context; get does not append a goal capsule");
assert.match(agent, /serializeMessagesForCompaction\(plan\.sourceMessages,\s*\{\s*currentGoal: this\._formatGoalForCompaction\(dynamicContext\?\.goal\)/, "compaction should receive the latest goal separately from hidden history messages");
assert.match(agent, /const postCompactGoal = this\._buildGoalSnapshotCapsuleMessage\(dynamicContext, "compact_end"\)/, "compaction should append a fresh goal snapshot after the compact boundary");
assert.match(agent, /_pendingContextEvents = \[\]/, "agent should own a queue for safe internal context events");
assert.match(agent, /async appendGoalDeletedEvent\(goal = null\)[\s\S]*this\._activeRun[\s\S]*this\._enqueueContextEvent\(message\)[\s\S]*return "deferred"/, "goal deletion events should not be inserted into the middle of an active tool ledger");
assert.match(agent, /await this\._persistIfToolLedgerRepaired\(t\("agent\.toolInterrupted"\)\);\s*await this\._flushPendingContextEvents\(\);/, "pending context events should flush before the next LLM request");
assert.match(agent, /await this\._persistIfToolLedgerRepaired\(t\("agent\.toolStopped"\)\);\s*await this\._flushPendingContextEvents\(\);/, "pending context events should flush before run teardown");
assert.doesNotMatch(agent, /_buildGoalContextSendMessage/, "goal context should no longer be injected as a mutable system-prefix-adjacent message");

assert.match(prompts.SYSTEM_PROMPT, /开始前用 manage_goal create/, "system prompt should tell agents when to create a goal");
assert.match(prompts.SYSTEM_PROMPT, /明显需要跨多轮保持目标和完备性/, "system prompt should define goal tracking as a method for long, complete tasks");
assert.match(prompts.SYSTEM_PROMPT, /明确规模目标（如 N 页、N 个、多个关键词\/站点\/文件）/, "system prompt should mention obvious scale signals");
assert.match(prompts.SYSTEM_PROMPT, /穷尽遍历某类对象/, "system prompt should cover exhaustive traversal tasks");
assert.match(prompts.SYSTEM_PROMPT, /不要为单步问答、一次性页面读取、少量明确操作创建 goal/, "system prompt should prevent overusing goal tracking");
assert.match(prompts.SYSTEM_PROMPT, /用 manage_goal block 在 progress 写明原因/, "system prompt should define blocker updates without status fields");
assert.match(prompts.SYSTEM_PROMPT, /验证完成标准，再 manage_goal complete/, "system prompt should define completion verification");
assert.match(prompts.RESTRICTED_GOAL_RULE, /不使用目标追踪机制/, "restricted prompt should say goal tracking is absent");
assert.match(runProfile, /disabledTools\.push\("manage_sessions", "manage_goal"\)/, "restricted run profiles should hide manage_goal");
assert.match(runProfile, /goalTracking:\s*!!canManageSessions/, "run profile should expose goal tracking capability");
// test-goal-tools exercises real schema visibility and runtime root-session
// authorization; those policies now belong to the definition.

assert.equal(getCoreToolMetadata("manage_goal")?.title, "目标追踪", "UI metadata should localize manage_goal");
assert.match(eventRouter, /"goal_update"/, "sidepanel should subscribe to goal update events");
assert.match(sessionState, /function deriveRuntimeGoal\(/, "SessionState should derive live runtime goal state");
assert.match(goalStripFeature, /const pendingClearSessionIds = new Set\s*\(\)/, "goal strip should own optimistic goal clears");
assert.match(sessionsFeature, /const nextGoal = isGoalClearPending\(id\)[\s\S]*\? null[\s\S]*hasGoal \? normalizeRuntimeGoal\(session\.goal\)/, "session list hydration should not resurrect a goal while UI clear is pending");
assert.match(goalStripFeature, /function applyLocalClear\([\s\S]*pendingClearSessionIds\.add\(id\)[\s\S]*options\.renderSessions\?\.\(\{ requestFreshState: false \}\)/, "optimistic goal clear should render from local runtime before requesting fresh state");
const handleSessionDeletedBody = extractFunction(eventRouter, "handleSessionDeleted");
assert.match(handleSessionDeletedBody, /goalStrip\.forget\(sessionId\)[\s\S]*sessionState\.remove\(sessionId\)/, "deleted sessions should clear pending goal and runtime state together");
assert.match(sessionsFeature, /goal\?\.objective[\s\S]*goal\?\.criteria[\s\S]*goal\?\.progress[\s\S]*goal\?\.next[\s\S]*goal\?\.checkpoint/, "session search text should include visible goal fields");
assert.match(chatWorkspace, /const goalStrip = select\("#goal-strip"\)/, "chat UI should mount a goal strip");
assert.match(goalStripFeature, /function renderCurrent\(\)[\s\S]*render\(options\.getCurrentSessionId\?\.\(\)\)/, "chat UI should render the active goal from runtime");
assert.match(goalStripFeature, /data-goal-action="clear"/, "chat goal strip should expose a delete button");
assert.match(goalStripFeature, /class="goal-icon"/, "chat goal strip should use a dedicated target icon instead of the queued-message icon");
assert.match(sessionsFeature, /function buildSessionGoalChip\(/, "session list should render goals as a compact title-row chip");
assert.match(sessionsFeature, /session-artifact-chip session-goal-chip/, "session goal chip should reuse the artifact pill visual language");
assert.match(sessionsFeature, /data-session-action="goal-status"/, "session goal chip should be clickable");
assert.match(sessionsFeature, /function sessionGoalStatusText\(/, "session goal chip should expose compact goal text");
assert.match(sessionsFeature, /return normalized\.objective \|\| t\("currentGoal"\)/, "session goal chip should only expose the goal objective");
assert.doesNotMatch(sessionsFeature, /normalized\.objective \? `目标 \$\{normalized\.objective\}`/, "session goal status should not duplicate the goal noun before objective");
assert.match(sessionsFeature, /variant:\s*"goal-status"/, "session goal click should use the squared goal-status toast variant");
assert.match(toastFeature, /function hide\(/, "sidepanel should expose a shared toast hide operation");
const switchTabBody = extractFunction(appShell, "switchTab");
const renderTabBody = extractFunction(appShell, "renderTab");
assert.match(switchTabBody, /if \(tab === currentTab\) return false;[\s\S]*options\.toast\?\.hide\(\)[\s\S]*renderTab\(tab,\s*\{\s*refresh\s*\}\)/, "switching tabs should dismiss visible goal status before changing panels");
assert.match(renderTabBody, /options\.setCurrentTab\?\.\(tab\)/, "the shared tab renderer should commit the selected panel");
assert.doesNotMatch(sessionsFeature, /data-session-action="clear-goal"/, "session list goal chip should not expose destructive deletion");
const reduceRuntimeBody = extractFunction(sessionState, "reduceRuntime");
assert.match(reduceRuntimeBody, /const goal = deriveRuntimeGoal\(event, source, previous\)[\s\S]*goal,/, "runtime reduction should include goal state in every accepted snapshot");
assert.match(sidepanelHtml, /id="goal-strip"/, "sidepanel markup should include the goal strip");
assert.match(sidepanelHtml, /id="goal-strip"[\s\S]*class="input-composer-frame(?:\s[^"]*)?"[\s\S]*id="queued-followups"[\s\S]*class="input-wrapper(?:\s[^"]*)?"/, "goal strip should live above the shared queue/composer surface");
const goalTitleClasses = goalStripFeature.match(/class="goal-title\s([^"]*)"/)?.[1].split(/\s+/) || [];
assert.ok(goalTitleClasses.includes("qz:min-w-0") && goalTitleClasses.includes("qz:truncate"), "long goal titles should retain bounded one-line layout");
assert.match(sidepanelCss, /\.goal-pill/, "goal strip should have dedicated styling");
assert.match(sidepanelCss, /\.session-goal-chip/, "session list should have compact goal pill styling");
assert.match(sidepanelCss, /\.session-goal-dot/, "session list goal pill should include a colored status dot");
assert.doesNotMatch(sidepanelCss, /\.session-goal-line/, "session list goal should not take a dedicated row");


const runtimeContext = {
  ...taskStateRuntime,
  assert,
  sessionRuntimeCache: {},
  events: [],
  savedRecords: [],
  deletedGoalEvents: [],
  restoredConversations: [],
  restoredLoadedPluginSkillNames: [],
  storedRecord: null,
  agentStub: null,
  blockedGoalSessions: new Set(["goal-child-test"]),
  nowTick: 0,
};

assert.equal(
  shouldExposeGoalContext({ status: "active", objective: "采集 3 页" }),
  true,
  "active goals should be inserted as goal capsules",
);
assert.equal(
  shouldExposeGoalContext({ status: "blocked", objective: "等待登录" }),
  true,
  "blocked goals should stay visible so the agent can resume after user help",
);
assert.equal(
  shouldExposeGoalContext({ status: "paused", objective: "暂停采集" }),
  true,
  "paused goals should stay visible until resumed or cleared",
);
assert.equal(
  shouldExposeGoalContext({ status: "complete", objective: "已完成采集" }),
  false,
  "completed goals should stop inserting goal capsules until a new goal is created",
);

assert.equal(shouldExposeGoalContext({ status: "invalid" }), false);
const goalCapsule = buildGoalSnapshotCapsuleMessage({ goal: { status: "active", objective: "采集 3 页" } });
assert.equal(goalCapsule._origin, "context_capsule");
assert.equal(goalCapsule._contextCapsule.reason, "goal_snapshot");
assert.match(goalCapsule.content, /durable 写入 data_store\/图集\/文件后再 manage_goal checkpoint/);
assert.match(buildGoalDeletedContextEventMessage({ objective: "采集 3 页" }).content[0].text, /当前目标「采集 3 页」已删除/);

vm.runInNewContext(`
  const sessionRuntimeCache = globalThis.sessionRuntimeCache;
  const events = globalThis.events;
  const blockedGoalSessions = globalThis.blockedGoalSessions;
  const sessionRuntimeReady = Promise.resolve();
  function normalizeSessionId(sessionId) {
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";
  }
  const sessionSupervisor = {
    withRuntime: (_id, operation) => operation(),
    isRunCurrent: () => true,
    getRuntime(sessionId) {
      return sessionRuntimeCache[normalizeSessionId(sessionId)] || null;
    },
  };
  function nowBeijingDateTime() {
    globalThis.nowTick = (globalThis.nowTick || 0) + 1;
    return "2026-07-05 19:00:" + String(globalThis.nowTick).padStart(2, "0");
  }
  function setSessionRuntime(sessionId, patch = {}) {
    const id = normalizeSessionId(sessionId);
    const previous = sessionRuntimeCache[id] || {};
    const next = { ...previous, ...patch, updatedAt: nowBeijingDateTime() };
    sessionRuntimeCache[id] = next;
    return next;
  }
  function getSessionRuntimeState(sessionId) {
    const id = normalizeSessionId(sessionId);
    const persisted = sessionRuntimeCache[id] || {};
    return { ...persisted, goal: normalizeSessionGoal(persisted.goal), updatedAt: persisted.updatedAt || "" };
  }
  function broadcast(event) {
    events.push(event);
  }
  const agentStub = {
    isStreaming: false,
    messages: [{ role: "system", content: "system" }, { role: "user", content: "history" }],
    appendGoalDeletedEvent: async (goal) => {
      globalThis.deletedGoalEvents.push(goal);
      if (globalThis.agentStub.isStreaming) return "deferred";
      globalThis.agentStub.messages.push({ role: "user", content: "[目标追踪事件] " + (goal.objective || "") });
      return true;
    },
    exportSession: () => globalThis.agentStub.messages,
    restoreSession: async (conversation) => {
      globalThis.restoredConversations.push(conversation);
      globalThis.agentStub.messages = Array.isArray(conversation)
        ? conversation.map((message) => ({ ...message }))
        : [];
    },
    restoreLoadedSkillToolNames: (names = []) => {
      globalThis.restoredLoadedPluginSkillNames.push(Array.isArray(names) ? [...names] : []);
      return Array.isArray(names) ? [...names] : [];
    },
  };
  globalThis.agentStub = agentStub;
  function storedSessionKey(id) {
    return "session:" + id;
  }
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: globalThis.storedRecord || null };
        },
      },
    },
  };
  const sessionRepository = {
    async readRecord(_sessionId) {
      return globalThis.storedRecord || null;
    },
  };
  const repository = sessionRepository;
  function getSupervisor() {
    return sessionSupervisor;
  }
  function readSessionRecord(saved) {
    return saved && typeof saved === "object" ? saved : {};
  }
  async function getSessionAgent(_sessionId) {
    return globalThis.agentStub;
  }
  async function getSessionTranscriptRuntime(_sessionId, _conversation) {
    return [];
  }
async function commitSessionRecordRuntime(payload) {
    globalThis.savedRecords.push(payload);
    return { saved: true, sessionId: payload.sessionId };
  }
  const console = { warn() {} };
  async function canManageSessionTools(sessionId = "") {
    return !blockedGoalSessions.has(String(sessionId || ""));
  }
  ${extractFunction(taskState, "clipText")}
  ${extractFunction(sessionCommands, "canUseSessionGoal")}
  ${extractFunction(sessionCommands, "updateSessionGoal")}
  ${extractFunction(sessionAgentHost, "ensureConversationForHistoryMutation")}
  const runtimeState = { set: setSessionRuntime };
  const agentHost = { getAgent: getSessionAgent, ensureConversationForHistoryMutation };
  const sessionTranscript = { get: getSessionTranscriptRuntime };
  ${extractFunction(sessionCommands, "clearSessionGoalRuntime")}
`, runtimeContext);

async function updateGoal(input) {
  return await vm.runInNewContext(`updateSessionGoal(${JSON.stringify(input)})`, runtimeContext);
}

const created = await updateGoal({
  sessionId: "goal-state-test",
  runId: "run_1",
  action: "create",
  objective: "采集三页帖子",
  criteria: "写入 posts 表并验证行数",
  next: "打开第一页",
});
assert.equal(created.active, true, "created goal should be active");
assert.equal(created.goal.status, "active", "create should produce an active goal");
assert.equal(created.goal.version, 1, "create should advance version to one");
assert.equal(runtimeContext.events.filter((event) => event.type === "goal_update").length, 1, "create should emit a goal update event");

const checkpoint = await updateGoal({
  sessionId: "goal-state-test",
  runId: "run_1",
  action: "checkpoint",
  progress: "第一页已落库，30 条",
  checkpoint: "page=1; table=posts; rows=30",
  next: "打开第二页",
});
assert.equal(checkpoint.goal.version, 2, "checkpoint should increment goal version");
assert.equal(checkpoint.goal.checkpoint, "page=1; table=posts; rows=30", "checkpoint should preserve compact recovery state");
const eventCountBeforeGet = runtimeContext.events.length;
const runtimeUpdatedAtBeforeGet = checkpoint.runtimeUpdatedAt;
const readOnly = await updateGoal({ sessionId: "goal-state-test", action: "get" });
assert.equal(runtimeContext.events.length, eventCountBeforeGet, "get should not broadcast or mutate runtime");
assert.equal(readOnly.runtimeUpdatedAt, runtimeUpdatedAtBeforeGet, "get should not update runtime timestamp");
assert.equal(readOnly.goal.version, 2, "get should return the current goal version");

const blocked = await updateGoal({
  sessionId: "goal-state-test",
  action: "block",
  progress: "目标页需要登录",
  next: "等待用户登录后继续",
});
assert.equal(blocked.goal.status, "blocked", "block action should mark the goal blocked");
assert.equal(blocked.goal.progress, "目标页需要登录", "block action should keep the blocker reason in progress");
const resumed = await updateGoal({ sessionId: "goal-state-test", action: "resume", next: "继续第二页" });
assert.equal(resumed.goal.status, "active", "resume should reactivate the goal");
const completed = await updateGoal({
  sessionId: "goal-state-test",
  action: "complete",
  progress: "已验证 posts 表 90 条",
  checkpoint: "done; table=posts; rows=90",
});
assert.equal(completed.active, false, "complete should no longer be active context");
assert.equal(completed.goal.status, "complete", "complete should mark terminal goal state");
const cleared = await updateGoal({ sessionId: "goal-state-test", action: "clear" });
assert.equal(cleared.goal, null, "clear should remove goal state");

const uiGoal = await updateGoal({
  sessionId: "goal-ui-clear-test",
  action: "create",
  objective: "采集页面列表",
  progress: "第一页已写入",
});
assert.equal(uiGoal.active, true, "fixture goal should be active before UI clear");
const uiCleared = await vm.runInNewContext(
  `clearSessionGoalRuntime(${JSON.stringify({ sessionId: "goal-ui-clear-test", source: "ui" })})`,
  runtimeContext,
);
assert.equal(uiCleared.cleared, true, "UI clear should report an existing goal was removed");
assert.equal(uiCleared.goal, null, "UI clear should return null goal");
assert.equal(runtimeContext.sessionRuntimeCache["goal-ui-clear-test"].goal, null, "UI clear should remove runtime goal");
assert.equal(runtimeContext.deletedGoalEvents.length, 1, "UI clear should append a hidden deletion event");
assert.equal(runtimeContext.deletedGoalEvents[0].objective, "采集页面列表", "deletion event should keep the deleted objective");
assert.equal(runtimeContext.savedRecords.length, 1, "non-streaming UI clear should persist the session record");

await updateGoal({
  sessionId: "goal-ui-defer-test",
  action: "create",
  objective: "运行中删除目标",
});
runtimeContext.agentStub.isStreaming = true;
const deferredClear = await vm.runInNewContext(
  `clearSessionGoalRuntime(${JSON.stringify({ sessionId: "goal-ui-defer-test", source: "ui" })})`,
  runtimeContext,
);
assert.equal(deferredClear.eventDeferred, true, "streaming UI clear should defer the hidden event append");
assert.equal(runtimeContext.savedRecords.length, 1, "streaming UI clear should leave record persistence to the active run teardown");
runtimeContext.agentStub.isStreaming = false;

runtimeContext.agentStub.messages = [{ role: "system", content: "system" }];
runtimeContext.sessionRuntimeCache["goal-ui-restore-history-test"] = {
  ...(runtimeContext.sessionRuntimeCache["goal-ui-restore-history-test"] || {}),
  loadedPluginSkillNames: ["browser", "sites"],
};
runtimeContext.storedRecord = {
  conversation: [{ role: "system", content: "system" }, { role: "user", content: "stored history" }],
};
const restoredGoal = await updateGoal({
  sessionId: "goal-ui-restore-history-test",
  action: "create",
  objective: "删除目标前恢复历史",
});
assert.equal(restoredGoal.active, true, "restore-history fixture goal should be active");
const restoredClear = await vm.runInNewContext(
  `clearSessionGoalRuntime(${JSON.stringify({ sessionId: "goal-ui-restore-history-test", source: "ui" })})`,
  runtimeContext,
);
assert.equal(restoredClear.eventAppended, true, "UI clear should append deletion event after restoring stored history");
assert.equal(runtimeContext.restoredConversations.length, 1, "UI clear should restore saved conversation before appending hidden event");
assert.equal(
  JSON.stringify(runtimeContext.restoredLoadedPluginSkillNames[0]),
  JSON.stringify(["browser", "sites"]),
  "UI clear should restore loaded plugin skill names after history hydration",
);
assert.equal(runtimeContext.savedRecords.length, 2, "UI clear with restored history should persist the updated session record");
assert.deepEqual(
  JSON.parse(JSON.stringify(runtimeContext.savedRecords[1].conversation.slice(0, 2))),
  JSON.parse(JSON.stringify(runtimeContext.storedRecord.conversation)),
  "restored history should be preserved when persisting the deletion event",
);
assert.equal(runtimeContext.savedRecords[1].conversation.length, 3, "deletion event should be appended after restored history");
assert.match(runtimeContext.savedRecords[1].conversation[2].content, /删除目标前恢复历史/, "deletion event should mention the deleted objective");

runtimeContext.agentStub.messages = [{ role: "system", content: "system" }];
runtimeContext.storedRecord = null;
const emptyHistoryGoal = await updateGoal({
  sessionId: "goal-ui-no-history-test",
  action: "create",
  objective: "没有历史时删除目标",
});
assert.equal(emptyHistoryGoal.active, true, "no-history fixture goal should be active");
const noHistoryClear = await vm.runInNewContext(
  `clearSessionGoalRuntime(${JSON.stringify({ sessionId: "goal-ui-no-history-test", source: "ui" })})`,
  runtimeContext,
);
assert.equal(noHistoryClear.cleared, true, "UI clear should still remove runtime goal even without stored history");
assert.equal(noHistoryClear.eventAppended, false, "UI clear should not append a deletion event without any conversation history");
assert.equal(runtimeContext.savedRecords.length, 2, "UI clear without history should not create a record containing only an internal event");

await assert.rejects(
  () => updateGoal({ sessionId: "goal-state-test-missing", action: "complete" }),
  (error) => error?.code === "MISSING_GOAL",
  "complete without a goal should fail explicitly",
);

await assert.rejects(
  () => updateGoal({ sessionId: "goal-child-test", action: "create", objective: "子任务不应创建 goal" }),
  (error) => error?.code === "GOAL_SESSION_FORBIDDEN",
  "child or automation sessions should not be able to create goals",
);

console.log("goal-driven contract tests passed");

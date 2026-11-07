import assert from "node:assert/strict";
import { localizeToolFailureError } from "../../src/shared/tools/tool-error-localization.js";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { createMcpRuntime } from "../../src/background/mcp/mcp-runtime.js";
import { markToolValue } from "../../src/shared/contracts/tool-error.js";
import { getToolResultTraces } from "../../src/shared/contracts/tool-result-presentation.js";

const executed = [];
const toolReadinessReasons = [];
const loadedNames = [];
const loadedDocumentResources = [];
const promptTasks = [];
const admissionSignals = [];
let messageDisposition = "started";
let activeRunId = "run-1";
const waits = new Map([["wait-1", true], ["wait-2", true]]);
const runtimeState = {
  sessionId: "s1",
  status: "completed",
  waitId: "wait-1",
  runId: "run-1",
  workingTabId: 8,
  workingUrl: "https://example.test/page",
  workingTab: { id: 8, url: "https://example.test/page" },
  visitedTaskSites: [{ id: 7, url: "https://docs.test/" }],
};
const transcript = [{ type: "assistant", content: "done" }];
const conversation = [{ role: "system", content: "system" }, { role: "assistant", content: "done" }];
const skillItems = [{
  name: "research",
  metadata: { displayName: "Research" },
  description: "Web research workflow",
  scope: "global",
  content: "Use tools carefully.",
  resources: [
    { path: "references/guide.md", type: "reference", title: "Guide", content: "abcdefghij" },
    { path: "references/template.xlsx", type: "asset", encoding: "base64", size: 4, content: "UEsDBA==" },
  ],
}];

const metadata = { s1: { id: "s1", title: "Session", parentSessionId: "0", titleSource: "manual" } };
const sessions = {
  normalizeId: value => String(value || "").trim(),
  requireId(value, operation) {
    const id = String(value || "").trim();
    if (!id) throw new Error(`${operation} requires sessionId`);
    return id;
  },
  supervisor: {
    getUserWait: sessionId => sessionId === "s1" && waits.has(runtimeState.waitId) ? { sessionId, waitId: runtimeState.waitId, runId: activeRunId } : null,
    isRunCurrent(sessionId, runId) {
      return sessionId === "s1" && runId === activeRunId || runId === `opaque-${sessionId}`;
    },
    mintDriveRunId(sessionId) { return `opaque-${sessionId}`; },
    takeDriveRunForRelease() { return ""; },
    clearDriveRunId() {},
    resolveUserWait({ waitId }) {
      if (!waits.has(waitId)) return false;
      waits.delete(waitId);
      return true;
    },
    rejectUserWait({ waitId }) {
      if (!waits.has(waitId)) return false;
      waits.delete(waitId);
      return true;
    },
  },
  async submitMessage(input, signal) {
    promptTasks.push(input);
    admissionSignals.push(signal);
    return { promise: Promise.resolve(), runId: "run-2", disposition: messageDisposition };
  },
  waitForRunObserved: async () => true,
  getRuntimeOutput: async (_id, project = value => value) => project({ ...runtimeState }),
  getLiveAgentEntry: async () => null,
  setRuntime() {},
  getLastMessages: async ({ sessionId, num }) => ({ sessionId, num, messages: transcript.slice(-num) }),
  getAgent: async () => ({ exportSession: () => conversation }),
  getTranscript: async () => transcript,
  listMetadata: async () => ({ ...metadata }),
  createMetadata: async (input) => {
    metadata[input.id] = { id: input.id, title: input.title || input.id, source: input.source || "external-drive" };
    return metadata[input.id];
  },
  getConversation: async () => conversation,
  compactTranscriptEvent: event => ({ ...event, compact: true }),
  getRuntime: () => ({ ...runtimeState }),
};

const driveToolNames = ["open_tab", "list_skills", "read_dom", "browse_history"];
const blockedToolNames = [
  "manage_bookmarks", "manage_sessions", "wait_for_user", "ask_user",
  "qingzhou_skill_author__delete_skill", "mcp_call_tool",
];
function toolSchema(name) {
  return { type: "function", function: { name, description: name, parameters: { type: "object" } } };
}
const runProfiles = [];
const toolRuntime = {
  getSchemas: () => [...driveToolNames, ...blockedToolNames].map(toolSchema),
  getBatchTabPolicy: (name) => name === "open_tab"
    ? { kind: "create" }
    : ["get_ax_tree", "screenshot", "read_dom", "navigate"].includes(name)
      ? { kind: "target", implicit: false }
      : null,
  async execute(name, args, signal, context) {
    executed.push({ name, args, signal, context });
    if (name === "load_skill") return { name: "research", displayName: "Research" };
    return { ok: true };
  },
};
const tools = {
  ready: async reason => { toolReadinessReasons.push(reason); },
  canManageSessions: async () => true,
  buildRunProfile: async (input) => {
    runProfiles.push(input);
    return { sessionId: input.sessionId };
  },
  runtime: toolRuntime,
  loadedSkillNames: (_sessionId, extra) => ["existing", ...extra],
  recordLoadedSkillNames: (...args) => loadedNames.push(args),
};
const skills = {
  list: async () => skillItems,
  load: async name => skillItems.find(skill => skill.name === name) || null,
  getDisplayName: skill => skill.metadata?.displayName || skill.name,
  normalizeResourcePath: value => String(value || "").replace(/^\/+/, ""),
  async loadDocumentResource(input, runtime) {
    loadedDocumentResources.push({ input, runtime });
    return {
      name: input.skill.name,
      path: input.path,
      format: "xlsx",
      document: { docModelId: "model_skill_test" },
      rows: [{ value: 1 }],
    };
  },
};
let runtimeMessageSignal;
const runtime = createMcpRuntime({
  sessions,
  userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } } },
  tools,
  skills,
  artifacts: {
    empty: () => ({ total: 0, items: [], dataTables: [], imageCollections: [], files: [] }),
    collect: async () => ({ total: 1, items: [{ type: "file" }] }),
  },
  trace: { get: async () => ["s1 trace", "other trace"] },
  async dispatchSidepanel(message, port) {
    runtimeMessageSignal = port.signal;
    port.postMessage({ type: "first", requestId: message.requestId });
    port.postMessage({ type: "second", requestId: message.requestId });
  },
  storageKey: () => "_mcp_config",
});

assert.equal(runtime.describe().storageKey, "_mcp_config");
assert.equal(runtime.describe().scriptApiVersion, 2);
assert.ok(runtime.describe().methods.includes("execute_tool"));

const dispatched = await runtime.dispatchRuntimeMessage({ type: "test", requestId: "req-1" }, { expectedType: "first" });
assert.equal(dispatched.response.type, "first");
assert.equal(dispatched.responses.length, 2);
const runtimeMessageController = new AbortController();
await runtime.dispatchRuntimeMessage({ type: "test" }, {}, runtimeMessageController.signal);
assert.equal(runtimeMessageSignal, runtimeMessageController.signal);

assert.deepEqual(await runtime.continueUserWait({ sessionId: "s1", waitId: "wait-1" }), {
  accepted: true,
  sessionId: "s1",
  waitId: "wait-1",
  runId: "run-1",
  submitted: false,
  reason: "continued",
});
assert.equal((await runtime.cancelUserWait({ sessionId: "s1", waitId: "missing" })).stale, true);
runtimeState.waitId = "wait-2";
runtimeState.waitForm = { fields: [{ id: "choice", type: "text" }] };
const pending = await runtime.getSnapshot("s1");
assert.deepEqual(pending.session, { sessionId: "s1", title: "Session", status: runtimeState.status });
assert.equal(metadata.s1.titleSource, "manual", "public Session observations leave stored metadata unchanged");
assert.deepEqual(pending.input, runtime.getUserInput({ sessionId: "s1" }));
assert.equal(pending.input.responseTemplate.answers.choice, "<text>");
assert.deepEqual((await runtime.getState("s1")).input, pending.input);
assert.deepEqual((await runtime.sendMessage({ sessionId: "s1", text: "pending" })).input, pending.input);
promptTasks.length = 0;
assert.equal((await runtime.submitWaitForm({ sessionId: "s1", waitId: "wait-2", answers: { choice: "a" } })).submitted, true);
assert.deepEqual((await runtime.getSnapshot("s1")).input, { sessionId: "s1", waiting: false });

await assert.rejects(() => runtime.sendMessage({ text: "missing id" }), /requires sessionId/);
await assert.rejects(() => runtime.sendMessage({ sessionId: "s1", text: "  " }), /requires text/);
const onMessageAccepted = () => {};
const sent = await runtime.sendMessage({
  sessionId: "s1", text: "go", wait: true, onMessageAccepted,
});
assert.equal(sent.accepted, true);
assert.equal(sent.wait, true);
assert.equal(sent.disposition, "started");
assert.equal(sent.deliveryMode, "follow_up");
assert.ok(sent.clientMessageId);
assert.equal(sent.clientMessageId, promptTasks[0].clientMessageId);
assert.equal(promptTasks.length, 1);
assert.equal(promptTasks[0].onMessageAccepted, onMessageAccepted);
assert.equal(promptTasks[0].swallowErrors, true);
assert.equal(promptTasks[0].deliveryMode, "follow_up");
await runtime.sendMessage({ sessionId: "s1", text: "surface acceptance errors", swallowErrors: false });
assert.equal(promptTasks.at(-1).swallowErrors, false);
messageDisposition = "queued";
const queued = await runtime.sendMessage({ sessionId: "s1", text: "next task", clientMessageId: "follow-up-1", wait: true });
assert.equal(queued.disposition, "queued");
assert.equal(queued.wait, false, "a queued message acknowledges admission rather than claiming its future run completed");
assert.equal(queued.clientMessageId, "follow-up-1");
assert.equal(promptTasks.at(-1).clientMessageId, "follow-up-1");
assert.equal(queued.deliveryMode, "follow_up");
const steering = await runtime.sendMessage({ sessionId: "s2", text: "Change course", steer: true, clientMessageId: "steering-1" });
assert.equal(steering.sessionId, "s2");
assert.equal(steering.deliveryMode, "steer");
assert.equal(steering.disposition, "queued");
assert.equal(promptTasks.at(-1).deliveryMode, "steer");
assert.equal(promptTasks.at(-1).sessionId, "s2");
assert.equal(promptTasks.at(-1).clientMessageId, "steering-1");
await runtime.sendMessage({ sessionId: "s1", text: "Follow up", steer: false });
assert.equal(promptTasks.at(-1).deliveryMode, "follow_up");
const callsBeforeInvalidSteering = promptTasks.length;
for (const steer of ["true", 1, null, {}]) {
  await assert.rejects(() => runtime.sendMessage({ sessionId: "s1", text: "Invalid mode", steer }), { code: "INVALID_ARGUMENTS" });
}
assert.equal(promptTasks.length, callsBeforeInvalidSteering, "malformed steering flags must fail before message admission");
messageDisposition = "started";

const state = await runtime.getState("s1");
assert.equal(state.status, "completed");
assert.equal(state.isStreaming, false);
assert.deepEqual(await runtime.getMessages("s1"), { sessionId: "s1", session: conversation, transcript });
assert.equal((await runtime.getMessages("s1", { tail: true, num: 1 })).num, 1);

const listedTools = await runtime.listTools({ sessionId: "s1", loadedPluginSkillNames: ["extra"] });
assert.deepEqual(listedTools.tools.map(tool => tool.name), [...driveToolNames, ...blockedToolNames]);
assert.equal(runProfiles.at(-1).externalDrive, false);
const blankTools = await runtime.listTools();
assert.equal(runProfiles.at(-1).externalDrive, true);
assert.deepEqual(blankTools.tools.map(tool => tool.name), driveToolNames);
await assert.rejects(runtime.listTools({ sessionId: "not-created" }), { code: "DRIVE_SESSION_NOT_FOUND" });
assert.equal(Object.hasOwn(metadata, "not-created"), false);
metadata["drive-listed"] = { id: "drive-listed", source: "external-drive" };
const driveTools = await runtime.listTools({ sessionId: "drive-listed" });
assert.equal(runProfiles.at(-1).externalDrive, true);
assert.deepEqual(driveTools.tools.map(tool => tool.name), driveToolNames);
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools", "mcp_list_tools", "mcp_list_tools", "mcp_list_tools"]);
const inputContext = { marker: true };
const occupiedBefore = executed.length;
await assert.rejects(
  runtime.executeTool({ sessionId: "s1", name: "read_dom", args: { selector: "main" }, dynamicContext: inputContext }),
  error => error.code === "DRIVE_SESSION_OCCUPIED",
);
assert.deepEqual(inputContext, { marker: true }, "a rejected drive call must not mutate caller-owned context");
assert.equal(executed.length, occupiedBefore);
await assert.rejects(
  runtime.executeTool({ sessionId: "s1", calls: [{ id: "dom", name: "read_dom", args: {} }] }),
  error => error.code === "DRIVE_SESSION_OCCUPIED",
);
await assert.rejects(runtime.createDriveSession({ sessionId: "missing-title" }), { code: "SESSION_TITLE_REQUIRED" });
assert.deepEqual(await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-s" }), {
  sessionId: "drive-s", title: "Inspect example page", status: "completed",
  qz_skills: [{ name: "research", displayName: "Research", description: "Web research workflow", scope: "global" }],
});
assert.deepEqual(await runtime.getDriveSession({ sessionId: "drive-s" }), {
  sessionId: "drive-s", title: "Inspect example page", status: "completed",
});
metadata["drive-hidden"] = { id: "drive-hidden", source: "external-drive", driveRetentionPending: true };
metadata["drive-newest"] = { id: "drive-newest", title: "Latest task", source: "external-drive",
  createdAt: "2099-01-01T00:00:00Z", workingTabId: 88, owner: "private" };
const listedDrive = await runtime.listDriveSessions();
assert.deepEqual(listedDrive.sessions[0], { sessionId: "drive-newest", title: "Latest task", status: "completed" });
assert.ok(listedDrive.sessions.some(session => session.sessionId === "drive-s"));
assert.equal(listedDrive.sessions.some(session => ["s1", "drive-hidden"].includes(session.sessionId)), false);
for (const session of listedDrive.sessions) assert.deepEqual(Object.keys(session).sort(), ["sessionId", "status", "title"]);
assert.deepEqual((await runtime.listDriveSessions({ limit: 1 })).sessions, [listedDrive.sessions[0]]);
for (const sessionId of ["missing", "s1", "drive-hidden"]) {
  await assert.rejects(runtime.getDriveSession({ sessionId }), { code: "DRIVE_SESSION_NOT_FOUND" });
}
delete metadata["drive-hidden"];
delete metadata["drive-newest"];

const driveTool = await runtime.executeTool({ sessionId: "drive-s", name: "read_dom", args: { tabRef: "page" }, runId: "public-run" });
assert.equal(executed.at(-1).context.source, "mcp_bridge");
assert.equal(executed.at(-1).context.externalDrive, true, "trusted Session metadata determines mode even when its runId is opaque");
assert.equal(executed.at(-1).context.runId, "opaque-drive-s", "a client runId is not the drive execution identity");
assert.equal(driveTool.runId, "opaque-drive-s");
assert.notEqual(driveTool.runId, "public-run");
const loadedBeforeDrive = loadedNames.length;
await assert.rejects(
  runtime.executeTool({ sessionId: "s1", name: "load_skill", args: { name: "research" } }),
  error => error.code === "DRIVE_SESSION_OCCUPIED",
);
assert.equal(loadedNames.length, loadedBeforeDrive, "a built-in session rejects direct drive before recording a skill");
assert.equal(executed.at(-1).name, "read_dom");
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools", "mcp_list_tools", "mcp_list_tools", "mcp_list_tools", "mcp_execute_tool"]);
assert.equal((await runtime.getTool({ sessionId: "s1", name: "manage_bookmarks" })).name, "manage_bookmarks");
assert.equal((await runtime.getTool({ sessionId: "drive-listed", name: "browse_history" })).name, "browse_history");
assert.equal(await runtime.getTool({ sessionId: "drive-listed", name: "not_a_tool" }), null);
for (const name of ["manage_bookmarks", "manage_sessions", "wait_for_user", "ask_user", "use_tab", "get_working_tab", "qingzhou_skill_author__delete_skill", "mcp_call_tool"])  {
  await assert.rejects(
    () => runtime.getTool({ sessionId: "drive-listed", name }),
    error => error.code === "DRIVE_TOOL_FORBIDDEN" && /tabRef/.test(error.message),
  );
}
await assert.rejects(
  () => runtime.getTool({ name: "ask_user" }),
  error => error.code === "DRIVE_TOOL_FORBIDDEN",
);

const driveNotes = [];
const persistedDriveSessions = [];
sessions.recordToolEvent = event => { driveNotes.push(event); };
sessions.persistTranscript = async sessionId => { persistedDriveSessions.push(sessionId); };
{
  const notedBefore = driveNotes.length;
  const executedBefore = executed.length;
  await assert.rejects(runtime.executeTool({ sessionId: "", name: "read_dom", args: { selector: "main", tabRef: "page" } }),
    { code: "DRIVE_SESSION_REQUIRED" });
  assert.equal(driveNotes.length, notedBefore, "an empty session does not execute or record a drive transcript");
  assert.equal(executed.length, executedBefore, "session rejection must not start another execution");
}
const batchNotes = await runtime.executeTool({
  sessionId: "drive-s",
  calls: [
    { id: "tree", name: "get_ax_tree", args: { tabRef: 3 } },
    { id: "shot", name: "screenshot", args: { tabRef: 3 } },
  ],
});
assert.equal(batchNotes.results.length, 2);
assert.deepEqual(driveNotes.map(event => [event.toolName, event.isError, event.type]), [
  ["get_ax_tree", false, "tool_execution_end"],
  ["screenshot", false, "tool_execution_end"],
]);
assert.equal(new Set(driveNotes.map(event => event.toolCallId)).size, 2);
assert.ok(driveNotes.every(event => !["tree", "shot"].includes(event.toolCallId)));
assert.equal(driveNotes.every(event => event.runId === "opaque-drive-s" && event.spanId === `tool:${event.toolCallId}`), true);
assert.deepEqual(executed.slice(-2).map(call => call.context.toolCallId), driveNotes.map(event => event.toolCallId),
  "host call identities connect nested evidence to the actual parent card");
assert.deepEqual(persistedDriveSessions, ["drive-s"]);
{
  const previous = toolRuntime.execute;
  let executionContext;
  toolRuntime.execute = async (_name, _args, _signal, context) => {
    executionContext = context;
    return { ok: true, _image: "data:image/png;base64,aaaa", _debug: "business-debug" };
  };
  try {
    driveNotes.length = 0;
    const shot = await runtime.executeTool({ sessionId: "drive-s", name: "screenshot", args: { tabRef: 4 } });
    assert.equal(Object.hasOwn(shot.result, "_image"), false);
    assert.equal(shot.result._debug, "business-debug");
    assert.equal(driveNotes[0].result._image, "data:image/png;base64,aaaa");
    assert.equal(driveNotes[0].result._debug, "business-debug");
    assert.equal(executionContext.toolCallId, driveNotes[0].toolCallId, "the host owns one stable invocation identity");
  } finally {
    toolRuntime.execute = previous;
  }
}
{
  const previous = toolRuntime.execute;
  const failure = Object.assign(new Error("drive boom"), { code: "TOOL_FAILED" });
  const full = Array.from({ length: 8 }, (_, index) => ({ level: "trace", message: `host-${index}` }));
  toolRuntime.execute = async (_name, _args, _signal, context) => {
    context.resultPresentation._display = { script: { valueOnly: true, trace: full } };
    throw failure;
  };
  try {
    driveNotes.length = 0;
    persistedDriveSessions.length = 0;
    await assert.rejects(
      runtime.executeTool({ sessionId: "drive-s", name: "read_dom", args: { selector: "x", tabRef: "page" } }),
      error => error === failure,
    );
    assert.equal(driveNotes.length, 1);
    assert.equal(driveNotes[0].isError, true);
    assert.equal(driveNotes[0].result.code, "TOOL_FAILED");
    assert.deepEqual(getToolResultTraces(failure), full.map(row => row.message), "the original thrown object retains the holder for the outer bridge error channel");
    assert.equal(driveNotes[0].result._display.script.valueOnly, undefined);
    assert.deepEqual(driveNotes[0].result._display.script.trace, full);
    assert.deepEqual(persistedDriveSessions, ["drive-s"]);
  } finally {
    toolRuntime.execute = previous;
  }
}

{
  const previous = toolRuntime.execute;
  try {
    for (const language of ["en", "zh-CN"]) for (const name of ["Error", "AbortError", "TimeoutError"]) {
      const failure = Object.assign(new Error("Injected lost touchEnd response"), { name });
      toolRuntime.execute = async () => { throw withLanguage(language, () => localizeToolFailureError(failure)); };
      driveNotes.length = 0;
      await assert.rejects(runtime.executeTool({ sessionId: "drive-s", name: "read_dom", args: { tabRef: "page" } }), error => error === failure);
      assert.equal(driveNotes.length, 1, "each failure produces exactly one card");
      assert.deepEqual(driveNotes[0].result, {
        code: name === "Error" ? "TOOL_EXECUTION_FAILED" : "OPERATION_ABORTED",
        message: "Injected lost touchEnd response",
      }, "MCP keeps the concrete Error message and recognizes cancellation by native name");
    }
  } finally {
    toolRuntime.execute = previous;
  }
}

const listedSkills = await runtime.listSkills({ scope: "global", query: "guide" });
assert.equal(listedSkills.count, 1);
assert.equal(listedSkills.items[0].content, undefined);
const loadedSkill = await runtime.getSkill({ sessionId: "s1", name: "research" });
assert.equal(loadedSkill.content, "Use tools carefully.");
assert.match(loadedSkill.runtime, /Chrome 浏览器扩展/);
const chunk = await runtime.getSkillResource({ name: "research", path: "/references/guide.md", start: 2, maxChars: 4 });
assert.deepEqual({ content: chunk.content, start: chunk.start, end: chunk.end, truncated: chunk.truncated }, {
  content: "cdef",
  start: 2,
  end: 6,
  truncated: true,
});
const documentResource = await runtime.getSkillResource({ sessionId: "s1", runId: "run-1", name: "research", path: "references/template.xlsx" });
assert.equal(documentResource.document.docModelId, "model_skill_test");
assert.equal(loadedDocumentResources[0].input.resource.encoding, "base64");
assert.equal(loadedDocumentResources[0].runtime.context.sessionId, "s1");
assert.equal(loadedDocumentResources[0].runtime.context.source, "mcp_bridge");
{
  const { loadSkill } = await import("../../src/background/skills/runtime.js");
  const { normalizeModernSkill } = await import("../../src/shared/skills/skill-utils.js");
  const { createMemoryStorage } = await import("../support/memory-storage.mjs");
  const rows = ["rt1", "rt2"].map(name => normalizeModernSkill({ name, displayName: "Shared title", content: name }));
  const storage = createMemoryStorage({ _skills: Object.fromEntries(rows.map(row => [row.name, row])) });
  const previousChrome = globalThis.chrome, previousLoad = skills.load;
  const loadedCount = loadedNames.length;
  try {
    globalThis.chrome = { storage: { local: storage } };
    skills.load = loadSkill;
    for (const operation of [
      () => runtime.getSkill({ name: "Shared title" }),
      () => runtime.getSkillResource({ name: "Shared title", path: "notes.md" }),
    ]) await assert.rejects(operation, error => {
      assert.equal(error.code, "SKILL_NAME_AMBIGUOUS");
      assert.deepEqual(error.details, { name: "Shared title", candidates: rows.map(({ name, displayName }) => ({ name, displayName })) });
      return true;
    });
    assert.equal(loadedNames.length, loadedCount, "ambiguous loads record no loaded skill");
    assert.equal((await runtime.getSkill({ name: "rt2" })).name, "rt2");
  } finally {
    globalThis.chrome = previousChrome;
    skills.load = previousLoad;
  }
}
assert.equal((await runtime.getSkill({ name: "missing" })).code, "SKILL_NOT_FOUND");
assert.equal((await runtime.getSkillResource({ name: "research", path: "missing.md" })).code, "SKILL_RESOURCE_NOT_FOUND");

const snapshot = await runtime.getSnapshot("s1", {
  includeArtifacts: false,
  includeTools: true,
  includeTrace: true,
  traceLimit: 5,
});
assert.deepEqual(snapshot.session, { sessionId: "s1", title: "Session", status: snapshot.status });
assert.equal(snapshot.artifacts.total, 0);
assert.deepEqual(snapshot.usage, {
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0,
  modelCalls: 0, toolCalls: 0, screenshots: 0, contextCompressions: 0,
});
assert.equal(snapshot.toolCount, driveToolNames.length + blockedToolNames.length);
assert.deepEqual(snapshot.trace, ["s1 trace"]);
assert.equal(snapshot.tail[0].compact, true);

await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-abort" });
await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-lease" });
for (const stage of ["ready", "canManageSessions", "buildRunProfile"]) {
  const original = tools[stage], controller = new AbortController();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  tools[stage] = async () => { entered(); return gate; };
  const count = executed.length;
  const pending = runtime.executeTool({ sessionId: "drive-abort", name: "read_dom" }, controller.signal);
  await started; controller.abort(new Error("connection revoked")); release(true);
  await assert.rejects(pending, /connection revoked/);
  assert.equal(executed.length, count, `revoked ${stage} work must not execute a tool`);
  tools[stage] = original;
}
const linked = new AbortController();
await runtime.executeTool({ sessionId: "drive-abort", name: "read_dom", args: { tabRef: "page" } }, linked.signal);
const seenSignal = executed.at(-1).signal;
linked.abort();
assert.equal(seenSignal.aborted, true, "the drive call follows the connection signal");
const toolController = new AbortController();
const oldExecute = toolRuntime.execute, loadedCount = loadedNames.length;
toolRuntime.execute = async (_name, _args, signal) => { toolController.abort(new Error("late disconnect")); assert.equal(signal.aborted, true); return { name: "research" }; };
await assert.rejects(runtime.executeTool({ sessionId: "drive-abort", name: "read_dom", args: { tabRef: "page" } }, toolController.signal), /late disconnect/);
assert.equal(loadedNames.length, loadedCount, "revoked tool results cannot update loaded Skill state");
toolRuntime.execute = oldExecute;

{
  const hung = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const previous = toolRuntime.execute;
  toolRuntime.execute = async () => { entered(); return new Promise(() => {}); };
  const pending = runtime.executeTool({ sessionId: "drive-lease", name: "read_dom", args: { tabRef: "page" } }, hung.signal);
  await started;
  hung.abort(new Error("bridge timeout"));
  await assert.rejects(pending, /bridge timeout/);
  toolRuntime.execute = previous;
  const released = await runtime.executeTool({ sessionId: "drive-lease", name: "read_dom", args: { tabRef: "page" } });
  assert.equal(released.result.ok, true, "aborting a hung drive call releases DRIVE_SESSION_BUSY");
}

const admissionController = new AbortController();
await runtime.sendMessage({ sessionId: "s1", text: "retain admission authority", waitForStart: false }, admissionController.signal);
assert.equal(admissionSignals.at(-1), admissionController.signal);

for (const stage of ["context", "metadata"]) {
  for (const transition of ["same-run", "same-agent-new-run", "replaced-agent", "revoked-agent"]) {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers();
    let current = { runId: "run-first", status: "running", running: true, inputTokensEstimate: 11, contextWindow: 128000, goal: null };
    let agentRunId = "run-first";
    const agent = {
      getRunState: () => ({ runId: agentRunId, isStreaming: true, hasHistory: true }),
      getContextUsageState: async () => {
        if (stage === "context") { entered.resolve(); await gate.promise; }
        return { inputTokensEstimate: 7, contextWindow: 64000 };
      },
    };
    const handle = { agent }, writes = [];
    const observer = createMcpRuntime({
      sessions: {
        normalizeId: value => String(value),
        getRuntime: () => ({ ...current }),
        getLiveAgentEntry: async () => handle.agent ? handle : null,
        getRuntimeOutput: async (_id, project) => {
          if (stage === "metadata") { entered.resolve(); await gate.promise; }
          return project({ ...current });
        },
        setRuntime(_id, patch) { writes.push(patch); current = { ...current, ...patch }; },
        supervisor: { getUserWait: () => null },
      },
      tools: {}, skills: {}, artifacts: {}, trace: {}, dispatchSidepanel() {},
      userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: {} },
    });
    const pending = observer.getState("context-race");
    await entered.promise;
    if (transition !== "same-run") {
      current = { ...current, inputTokensEstimate: 99, contextWindow: 200000 };
      if (transition === "revoked-agent") {
        handle.agent = null;
        current = { ...current, status: "aborted", running: false };
      } else {
        current = { ...current, runId: "run-second" };
        if (transition === "same-agent-new-run") agentRunId = "run-second";
        else handle.agent = { getRunState: () => ({ runId: "run-second", isStreaming: true, hasHistory: true }) };
      }
    }
    gate.resolve();
    const result = await pending;
    const unchanged = transition === "same-run";
    assert.equal(writes.length, unchanged ? 1 : 0, `${stage}/${transition}: stale context cannot write Session runtime`);
    assert.equal(current.inputTokensEstimate, unchanged ? 7 : 99);
    assert.equal(result.runtime.inputTokensEstimate, unchanged ? 7 : 99);
    assert.equal(result.runtime.contextWindow, unchanged ? 64000 : 200000);
    assert.equal(result.runtime.runId, current.runId);
    assert.equal(result.runtime.goal, null, "context projection must preserve the filtered goal");
    assert.equal(result.isStreaming, transition !== "revoked-agent");
  }
}

{
  const previousExecute = toolRuntime.execute, previousPolicy = toolRuntime.getModelPolicy;
  const authored = { _display: { authored: true }, _image: 'authored image', result: 'business' };
  const values = [undefined, 'primitive', authored];
  const holders = [];
  toolRuntime.getModelPolicy = () => ({ preserveResult: true, scriptResult: "value" });
  toolRuntime.execute = async (_name, { index }, _signal, context) => {
    assert.deepEqual(context.resultPresentation, {});
    holders.push(context.resultPresentation);
    Object.assign(context.resultPresentation, { _display: { script: { valueOnly: true, trace: [{ index }] } },
      ...(index === 1 ? { _images: [{ mimeType: 'image/png', data: 'aGk=' }] } : {}) });
    return markToolValue(values[index]);
  };
  try {
    for (const version of [undefined, 1, 3]) for (const batch of [false, true]) {
      const call = { name: 'run_script', args: { code: 'return 1;' } };
      await assert.rejects(runtime.executeTool({ sessionId: 'drive-s', scriptApiVersion: version,
        ...(batch ? { calls: [{ id: 'incompatible', ...call }] } : call) }), { code: 'UPGRADE_REQUIRED' });
      assert.equal(holders.length, 0, 'incompatible clients are rejected before any script starts');
    }
    for (const mode of ['single', 'batch']) {
      driveNotes.length = 0;
      const calls = values.map((_, index) => ({ id: String(index), name: 'run_script', args: { index, code: 'async () => null' } }));
      const results = mode === 'batch' ? (await runtime.executeTool({ sessionId: 'drive-s', calls, scriptApiVersion: 2 })).results : [];
      if (mode === 'single') for (const call of calls) {
        results.push(await runtime.executeTool({ sessionId: 'drive-s', name: call.name, args: call.args, scriptApiVersion: 2 }));
      }
      assert.deepEqual(results.map(item => item.result), values.map(value => ({ok:true,result:value ?? null,trace:[],
        ...(mode === 'single' ? { context: { qz_skills: [{ name: 'research', displayName: 'Research',
          description: 'Web research workflow', scope: 'global' }] } } : {}),
      })));
      assert.ok(results.every(item => item.scriptApiVersion === 2));
      assert.deepEqual(results[1].images, [{ mimeType: 'image/png', data: 'aGk=' }]);
      assert.equal(driveNotes.length, values.length);
      for (const [index, event] of driveNotes.entries()) {
        assert.deepEqual(event.result.result, values[index]);
        assert.deepEqual(event.result._display.script, { valueOnly: true, trace: [{ index }] });
        assert.equal(event.isError, false);
      }
    }
    assert.equal(new Set(holders).size, values.length * 2);
    assert.deepEqual(authored._display, { authored: true });
  } finally {
    toolRuntime.execute = previousExecute;
    toolRuntime.getModelPolicy = previousPolicy;
  }
}

{
  // Exercise the registered producer and the emitted Worker, rather than a
  // mocked result that already contains the transport's expected shape.
  const [{ compileScriptRuntime }, { compileInnerWorker }, { runInnerWorker }, { createMemoryStorage }] = await Promise.all([
    import('../support/script-runtime-fixture.mjs'), import('../../scripts/build-extension.mjs'),
    import('../support/inner-runner-fixture.mjs'), import('../support/memory-storage.mjs'),
  ]);
  const previousChrome = globalThis.chrome, previousSource = globalThis.SCRIPT_RUNTIME_SOURCE;
  const previousExecute = toolRuntime.execute, previousPolicy = toolRuntime.getModelPolicy, previousBatch = toolRuntime.getBatchTabPolicy;
  const worker = await compileInnerWorker({ mode: 'production' });
  globalThis.SCRIPT_RUNTIME_SOURCE = await compileScriptRuntime();
  let registered;
  globalThis.chrome = { storage: { local: createMemoryStorage() },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: { getURL: path => `chrome-extension://trace-test/${path}`, async sendMessage(message) {
      if (message.type === 'run_script_inner_ping') return { ok: true, ready: true };
      if (message.type === 'run_script_inner_execute') {
        void runInnerWorker(worker, message.source, { scriptArgs: message.scriptArgs, strictResult: message.strictResult })
          .then(({ result }) => registered.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_result', requestId: message.requestId, result }));
        return { ok: true, accepted: true };
      }
      return { ok: true };
    } },
  };
  try {
    const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
    registered = createToolRuntime();
    toolRuntime.execute = registered.execute;
    toolRuntime.getModelPolicy = registered.getModelPolicy;
    toolRuntime.getBatchTabPolicy = registered.getBatchTabPolicy;
    const business = { trace: ['business trace'], traces: ['business traces'],
      _display: { script: { trace: ['not a diagnostic'] } }, code: 'BUSINESS', message: 'authored', ok: false };
    for (const mode of ['single', 'batch']) {
      driveNotes.length = 0;
      const calls = [
        { id: 'primitive', name: 'run_script', args: { code: 'trace("first"); console.warn("second"); console.error("third"); return 7;' } },
        { id: 'business', name: 'run_script', args: { code: 'return input;', args: business } },
        { id: 'failure', name: 'run_script', args: { code: 'for (let i = 0; i < 8; i++) trace("line-" + i); throw new Error("after all logs");' } },
      ];
      const results = mode === 'batch' ? (await runtime.executeTool({ sessionId: 'drive-s', calls, scriptApiVersion: 2 })).results : [];
      if (mode === 'single') for (const call of calls) results.push(await runtime.executeTool({ sessionId: 'drive-s', name: call.name, args: call.args, scriptApiVersion: 2 }));
      assert.equal(results[0].result.result, 7);
      assert.deepEqual(results[0].result.trace.slice(-3), ['first', 'second', 'third']);
      assert.ok(results[0].result.trace.every(row => typeof row === 'string'));
      assert.equal(results[0].isError, false);
      assert.deepEqual(results[1].result.result, business);
      assert.equal(results[1].result.trace.includes('not a diagnostic'), false);
      assert.equal(results[1].isError, false, 'only producer status interprets an authored ok/code/message object');
      assert.equal(results[2].isError, true);
      assert.equal(results[2].result.trace.filter(row => row.startsWith('line-')).length, 8);
      assert.equal(results[2].result.ok, false);
      assert.equal(results[2].result.result.details?.trace, undefined);
      assert.ok(results.every(item => item.scriptApiVersion === 2));
      const failureCard = driveNotes.find(event => event.isError);
      assert.equal(failureCard.result._display.script.valueOnly, undefined);
      assert.equal(failureCard.result._display.script.trace.filter(row => row.message.startsWith('line-')).length, 8);
    }
  } finally {
    toolRuntime.execute = previousExecute;
    toolRuntime.getModelPolicy = previousPolicy;
    toolRuntime.getBatchTabPolicy = previousBatch;
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
    if (previousSource === undefined) delete globalThis.SCRIPT_RUNTIME_SOURCE; else globalThis.SCRIPT_RUNTIME_SOURCE = previousSource;
  }
}

console.log("MCP runtime tests passed");

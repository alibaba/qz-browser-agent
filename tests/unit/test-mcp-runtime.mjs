import assert from "node:assert/strict";
import { createMcpRuntime } from "../../src/background/mcp/mcp-runtime.js";

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
      return sessionId === "s1" && runId === activeRunId;
    },
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
  listMetadata: async () => ({ s1: { id: "s1", title: "Session" } }),
  getConversation: async () => conversation,
  compactTranscriptEvent: event => ({ ...event, compact: true }),
  getRuntime: () => ({ ...runtimeState }),
};

const toolRuntime = {
  getSchemas: () => [{
    type: "function",
    function: { name: "read_dom", description: "Read", parameters: { type: "object" } },
  }],
  async execute(name, args, signal, context) {
    executed.push({ name, args, signal, context });
    if (name === "load_skill") return { name: "research", displayName: "Research" };
    return { ok: true };
  },
};
const tools = {
  ready: async reason => { toolReadinessReasons.push(reason); },
  canManageSessions: async () => true,
  buildRunProfile: async ({ sessionId }) => ({ sessionId }),
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
assert.deepEqual(listedTools.tools.map(tool => tool.name), ["read_dom"]);
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools"]);
const inputContext = { marker: true };
const activeRunTool = await runtime.executeTool({ sessionId: "s1", name: "read_dom", args: { selector: "main" }, dynamicContext: inputContext });
assert.deepEqual(inputContext, { marker: true }, "MCP execution must not mutate caller-owned context");
assert.equal(executed.at(-1).context.source, "mcp_bridge");
assert.equal(executed.at(-1).context.dynamicContext.pageUrl, runtimeState.workingUrl);
assert.equal(executed.at(-1).context.runId, "run-1", "MCP should inherit only the Session's live run");
assert.equal(activeRunTool.runId, "run-1");
const explicitRunTool = await runtime.executeTool({ sessionId: "s1", runId: "public-run", name: "read_dom", args: {} });
assert.equal(executed.at(-1).context.runId, "public-run", "the public MCP runId must reach tool execution unchanged");
assert.equal(explicitRunTool.runId, "public-run");
activeRunId = "";
await runtime.executeTool({ sessionId: "s1", name: "load_skill", args: { name: "research" } });
assert.equal(executed.at(-1).context.runId, "", "a completed runtime id must not be reused as a live run");
assert.deepEqual(loadedNames.at(-1), ["s1", ["research", "Research"]]);
assert.deepEqual(toolReadinessReasons, ["mcp_list_tools", "mcp_execute_tool", "mcp_execute_tool", "mcp_execute_tool"]);

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
assert.equal((await runtime.getSkill({ name: "missing" })).code, "SKILL_NOT_FOUND");
assert.equal((await runtime.getSkillResource({ name: "research", path: "missing.md" })).code, "SKILL_RESOURCE_NOT_FOUND");

const snapshot = await runtime.getSnapshot("s1", {
  includeArtifacts: false,
  includeTools: true,
  includeTrace: true,
  traceLimit: 5,
});
assert.equal(snapshot.artifacts.total, 0);
assert.deepEqual(snapshot.usage, {
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0,
  modelCalls: 0, toolCalls: 0, screenshots: 0, contextCompressions: 0,
});
assert.equal(snapshot.toolCount, 1);
assert.deepEqual(snapshot.trace, ["s1 trace"]);
assert.equal(snapshot.tail[0].compact, true);

for (const stage of ["ready", "canManageSessions", "buildRunProfile"]) {
  const original = tools[stage], controller = new AbortController();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  tools[stage] = async () => { entered(); return gate; };
  const count = executed.length;
  const pending = runtime.executeTool({ sessionId: "s1", name: "read_dom" }, controller.signal);
  await started; controller.abort(new Error("connection revoked")); release(true);
  await assert.rejects(pending, /connection revoked/);
  assert.equal(executed.length, count, `revoked ${stage} work must not execute a tool`);
  tools[stage] = original;
}
const toolController = new AbortController();
await runtime.executeTool({ sessionId: "s1", name: "read_dom" }, toolController.signal);
assert.equal(executed.at(-1).signal, toolController.signal, "tools receive the connection authority signal");
const oldExecute = toolRuntime.execute, loadedCount = loadedNames.length;
toolRuntime.execute = async (_name, _args, signal) => { toolController.abort(new Error("late disconnect")); assert.equal(signal.aborted, true); return { name: "research" }; };
await assert.rejects(runtime.executeTool({ sessionId: "s1", name: "load_skill" }, toolController.signal), /late disconnect/);
assert.equal(loadedNames.length, loadedCount, "revoked tool results cannot update loaded Skill state");
toolRuntime.execute = oldExecute;

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

console.log("MCP runtime tests passed");

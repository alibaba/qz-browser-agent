import assert from "node:assert/strict";
import { bindToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";
import { assertScriptPageLifecycle } from "../../src/background/tools/behavior.js";
import { withToolCallLifecycle } from "../../src/background/tools/call-lifecycle.js";
import { createToolOperation, withToolOperationFailure } from "../../src/background/tools/tool-operation.js";
import { registerMediaTools } from "../../src/capabilities/media/tools.js";
import {
  createRunScriptArtifactCollector,
  createRunScriptBridge,
} from "../../src/background/tools/run-script-bridge.js";

const appended = [];
const refreshes = [];
const executions = [];
const schemaContexts = [];
const nestedResults = [];
let readyCount = 0;
const controller = new AbortController();
const toolRegistrySnapshot = Object.freeze({ language: "en", marker: "frozen core declarations" });
const skillToolRegistrySnapshot = { version: 7, plugins: [], toolIndex: new Map() };
// Exercise the production declarations: a missing image observation flag must fail this test.
const mediaDefinitions = new Map();
registerMediaTools({ registerTool: definition => mediaDefinitions.set(definition.name, definition) });
const collector = createRunScriptArtifactCollector({
  getToolIdentity: name => ({ capabilityId: name === "store_alias" ? "data_store" : name }),
});
const supervisor = {
  isRunCurrent: (_sessionId, runId) => runId === "run-current",
  hasAgent: () => true,
  getAbortSignal: () => controller.signal,
};
const toolRuntime = {
  resolveDefinition(name) {
    return mediaDefinitions.get(name) || { name, behavior: { mayUnloadPage: name === "navigate" } };
  },
  getSchemas: context => {
    schemaContexts.push(context);
    return [{
      function: {
        name: "read_dom",
        description: "Read DOM",
        parameters: { type: "object" },
      },
    }];
  },
  async execute(name, args, _signal, context) {
    if (name === "list_tools") return { tools: this.getSchemas(context).map(schema => schema.function) };
    assertScriptPageLifecycle(this.resolveDefinition(name), args, context);
    executions.push({ name, args, context });
    if (name === "returns_error") return { ok: false, code: "EXPECTED_FAILURE", error: "failed" };
    if (name === "throws") throw Object.assign(new Error("exploded"), { code: "EXPLODED" });
    if (name === "store_alias") return { table: args.table, inserted: 2, totalRows: 2 };
    if (name === "act_on_screen") {
      return bindToolResultPresentation({
        feedbackAvailable: args.returnScreenshot === true,
        coordinateBasisReady: true,
        returnScreenshot: args.returnScreenshot,
        ...(args.returnScreenshot === true ? {
          _image: "data:image/jpeg;base64,YWN0aW9u",
          _imageDetail: "high",
        } : {}),
      }, {
        _display: {
          type: "imageWithAction",
          beforeImage: "data:image/jpeg;base64,YmVmb3Jl",
          afterImage: "data:image/jpeg;base64,YWZ0ZXI=",
        },
      });
    }
    if (name === "screenshot") {
      return {
        _image: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
        _imageDetail: "high",
        screenshotId: "screen-latest",
      };
    }
    if (name === "read_image" || name === "read_image_asset") {
      return {
        _image: "data:image/png;base64,cmVhZC1pbWFnZQ==",
        _imageDetail: "high",
        description: "image payload owned by " + name,
      };
    }
    return { value: 1 };
  },
};
const bridge = createRunScriptBridge({
  ready: async () => { readyCount += 1; },
  normalizeSessionId: value => String(value || "").trim(),
  supervisor,
  getRuntime: () => ({
    status: "running",
    workingTabId: 31,
    workingUrl: "https://example.test/current",
    workingTab: { id: 31, url: "https://example.test/current" },
    visitedTaskSites: [{ id: 31, url: "https://example.test/current" }],
  }),
  loadedSkillNames: () => ["runtime-skill"],
  isTerminalRuntimeForRun: runtime => runtime.status === "aborted",
  canManageSessions: async () => true,
  buildRunProfile: async input => ({ session: input }),
  getRunToolContext: async () => ({
    dynamicContext: { marker: "agent", pageUrl: "https://stale.test/" },
    loadedPluginSkillNames: ["agent-skill"],
    runProfile: { id: "frozen-profile" },
    skillToolRegistrySnapshot,
    toolRegistrySnapshot, language: "en",
  }),
  applyNestedToolResult: async value => {
    nestedResults.push(value);
    return true;
  },
  toolRuntime,
  collectArtifacts: collector,
  appendArtifacts: async value => appended.push(value),
  scheduleArtifactRefresh: (...args) => refreshes.push(args),
});

const missing = await bridge.handleToolCall({ sessionId: "s1", runId: "run-current" });
assert.equal(missing.ok, false);
assert.equal(missing.code, "MISSING_TOOL_NAME");

const listed = await bridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(listed.ok, true);
assert.deepEqual(listed.result.tools, [{
  name: "read_dom",
  description: "Read DOM",
  parameters: { type: "object" },
}]);
assert.equal(schemaContexts.at(-1).runProfile.id, "frozen-profile");
assert.equal(schemaContexts.at(-1).skillToolRegistrySnapshot, skillToolRegistrySnapshot);
assert.equal(schemaContexts.at(-1).toolRegistrySnapshot, toolRegistrySnapshot);
assert.equal(schemaContexts.at(-1).language, "en");
assert.equal(schemaContexts.at(-1).dynamicContext.pageUrl, "https://stale.test/");
assert.deepEqual(schemaContexts.at(-1).loadedPluginSkillNames, ["agent-skill", "runtime-skill"]);

const tooDeep = await bridge.handleToolCall({
  toolName: "read_dom",
  sessionId: "s1",
  runId: "run-current",
  depth: 4,
});
assert.equal(tooDeep.code, "RUN_SCRIPT_TOOL_DEPTH_EXCEEDED");

const unload = await bridge.handleToolCall({
  toolName: "navigate",
  sessionId: "s1",
  runId: "run-current",
  args: {},
}, { tab: { id: 31 } });
assert.equal(unload.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
assert.equal(executions.some(item => item.name === "navigate"), false);

const screenAction = await bridge.handleToolCall({
  toolName: "act_on_screen",
  sessionId: "s1",
  runId: "run-current",
  args: { tabId: 31, action: "click", returnScreenshot: true, x: 100, y: 100 },
}, { tab: { id: 31 } });
assert.equal(screenAction.ok, true, "fixed-layout screen actions should remain callable from run_script");
const screenActionExecution = executions.find(item => (
  item.name === "act_on_screen" && item.args.returnScreenshot === true
));
assert.ok(screenActionExecution, "run_script must preserve the explicit observation request");
assert.equal(screenActionExecution.context.toolRegistrySnapshot, toolRegistrySnapshot);
assert.equal(screenActionExecution.context.language, "en");
assert.equal(screenActionExecution.context.source, "run_script", "screen actions should receive the existing origin marker used to suppress child animation frames");
assert.equal(screenAction.result.returnScreenshot, true);
assert.equal(screenAction.result._display, undefined, "UI-only animation frames must not cross into page JavaScript");
assert.equal(screenAction.result._image, undefined, "observation bytes must not be exposed to page JavaScript");
assert.deepEqual(screenAction.observation, {
  _image: "data:image/jpeg;base64,YWN0aW9u",
  _imageDetail: "high",
}, "the bridge should carry the observation separately for last-write-wins promotion");
assert.equal(nestedResults.at(-1).args.returnScreenshot, true, "nested result bookkeeping should record the requested arguments");

const screenshot = await bridge.handleToolCall({
  toolName: "screenshot",
  sessionId: "s1",
  runId: "run-current",
  args: { tabId: 31 },
}, { tab: { id: 31 } });
assert.deepEqual(screenshot.observation, {
  _image: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
  _imageDetail: "high",
});
assert.equal(screenshot.result._image, undefined, "promoted screenshot bytes should cross the bridge only once");
assert.equal(screenshot.result.screenshotId, "screen-latest");

for (const name of ["read_image", "read_image_asset"]) {
  const readImage = await bridge.handleToolCall({
    toolName: name,
    sessionId: "s1",
    runId: "run-current",
    args: name === "read_image" ? { tabId: 31, target: "uid:image" } : { assetId: "image-1" },
  }, { tab: { id: 31 } });
  assert.deepEqual(readImage.observation, {
    _image: "data:image/png;base64,cmVhZC1pbWFnZQ==", _imageDetail: "high",
  }, `${name} must attach image bytes through the same channel as screenshots`);
  assert.deepEqual(readImage.result, { description: "image payload owned by " + name },
    `${name} must retain business metadata without serializing image bytes into script JSON`);
}

const stale = await bridge.handleToolCall({
  toolName: "read_dom",
  sessionId: "s1",
  runId: "run-stale",
});
assert.equal(stale.code, "RUN_STOPPED");

const returnedError = await bridge.handleToolCall({
  toolName: "returns_error",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(returnedError.ok, false);
assert.equal(returnedError.code, "EXPECTED_FAILURE");

const thrown = await bridge.handleToolCall({
  toolName: "throws",
  sessionId: "s1",
  runId: "run-current",
});
assert.equal(thrown.ok, false);
assert.equal(thrown.code, "EXPLODED");

const stored = await bridge.handleToolCall({
  toolName: "store_alias",
  sessionId: "s1",
  runId: "run-current",
  depth: 2,
  args: { action: "upsert", table: "rows", rows: [{ id: 1 }, { id: 2 }] },
}, { tab: { id: 9 } });
assert.equal(stored.ok, true);
assert.equal(stored.artifacts.length, 1);
assert.equal(stored.artifacts[0].table, "rows");
assert.equal(appended.length, 1);
assert.equal(appended[0].artifacts[0].totalRows, 2);
assert.deepEqual(refreshes[0], ["s1", { action: "artifacts", touchSession: true, delay: 400 }]);
assert.equal(executions.at(-1).context.workingTabId, undefined);
assert.equal(executions.at(-1).context.senderTabId, 9);
assert.equal(executions.at(-1).context.runScriptToolDepth, 2);
assert.equal(executions.at(-1).context.skillToolRegistrySnapshot, skillToolRegistrySnapshot);
assert.equal(executions.at(-1).context.dynamicContext.pageUrl, "https://stale.test/");
assert.deepEqual(executions.at(-1).context.loadedPluginSkillNames, ["agent-skill", "runtime-skill"]);
assert.equal(nestedResults.at(-1).toolName, "store_alias");
assert.equal(nestedResults.at(-1).runId, "run-current");
assert.equal(readyCount, 12);

assert.deepEqual(
  collector("download_url", { url: "https://example.test/report%20final.csv" }, {}),
  [{
    type: "file",
    sourceTool: "download_url",
    id: "download-url:report final.csv",
    filename: "report final.csv",
    title: "report final.csv",
    url: "https://example.test/report%20final.csv",
    format: "csv",
  }],
);
assert.deepEqual(collector("data_store", { action: "tables" }, { table: "ignored" }), []);
for (const [name, args, result, expected] of [
  ["save_file", {}, { filename: " result.csv ", downloadId: 9, size: 0 }, { id: "download:9", downloadId: 9, size: 0 }],
  ["save_file", { filename: "result.csv" }, {}, { id: "file:result.csv" }],
  ["document_create", {}, { filename: "result.csv", artifactId: "created", downloaded: { downloadId: 9 }, size: 20 },
    { id: "artifact:created", artifactId: "created", downloadId: 9, size: 20 }],
  ["document_create", { filename: "result.csv" }, { downloaded: { downloadId: 9 } },
    { id: "document:result.csv", downloadId: 9 }],
  ["document_download", { filename: "result.csv", artifactId: "saved" }, { downloadId: 9 },
    { id: "artifact:saved", artifactId: "saved", downloadId: 9 }],
  ["document_download", { filename: "result.csv" }, { downloadId: 9 }, { id: "download:9", downloadId: 9 }],
  ["document_download", { filename: "result.csv" }, {}, { id: "document-download:result.csv" }],
]) {
  assert.deepEqual(collector(name, args, result), [{
    type: "file", sourceTool: name, filename: "result.csv", title: "result.csv", format: "csv", ...expected,
  }], `${name} preserves its established ID priority and compact fields`);
}
assert.deepEqual(collector("document_create", {}, { filename: "result.csv", format: "tsv" })[0].format, "tsv");
assert.deepEqual(collector("save_file", {}, { error: "failed", filename: "result.csv" }), []);
assert.deepEqual(collector("document_download", {}, {}), []);

const activatedSkills = [];
const activationBridge = createRunScriptBridge({
  supervisor,
  getRuntime: () => ({ status: "running" }),
  isTerminalRuntimeForRun: () => false,
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  getRunToolContext: async () => ({ loadedPluginSkillNames: activatedSkills }),
  applyNestedToolResult: async ({ toolName, result, isError }) => {
    if (toolName === "load_skill" && !isError) activatedSkills.push(result.name);
  },
  toolRuntime: {
    resolveDefinition: () => null,
    getSchemas: context => [
      ...(context.loadedPluginSkillNames.includes("fresh-skill")
        ? [{ function: { name: "fresh_plugin__run", description: "Fresh", parameters: { type: "object" } } }]
        : []),
    ],
    async execute(name, _args, _signal, context) {
      if (name === "list_tools") return { tools: this.getSchemas(context).map(schema => schema.function) };
      if (name === "load_skill") return { name: "fresh-skill" };
      if (name === "fresh_plugin__run" && context.loadedPluginSkillNames.includes("fresh-skill")) return { ok: true };
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: "UNKNOWN_TOOL" });
    },
  },
  collectArtifacts: () => [],
});
assert.equal((await activationBridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
})).result.tools.length, 0);
assert.equal((await activationBridge.handleToolCall({
  toolName: "load_skill",
  args: { name: "fresh-skill" },
  sessionId: "s1",
  runId: "run-current",
})).ok, true);
assert.equal((await activationBridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "run-current",
})).result.tools[0].name, "fresh_plugin__run");
assert.equal((await activationBridge.handleToolCall({
  toolName: "fresh_plugin__run",
  sessionId: "s1",
  runId: "run-current",
})).ok, true);

const sessionSkills = [];
const sessionRecordBridge = createRunScriptBridge({
  supervisor,
  getRuntime: () => ({ status: "running" }),
  loadedSkillNames: () => sessionSkills,
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  getRunToolContext: async () => ({ externalDrive: true }),
  recordNestedTool: async ({ name, phase, result }) => {
    if (name === "load_skill" && phase === "end") sessionSkills.push(result.name);
  },
  toolRuntime: {
    resolveDefinition: () => null,
    getSchemas: () => [],
    async execute(name, _args, _signal, context) {
      return name === "load_skill" ? { name: "fresh-skill" } : { loaded: context.loadedPluginSkillNames };
    },
  },
  collectArtifacts: () => [],
});
const callSessionRecord = toolName => sessionRecordBridge.handleToolCall({ toolName, sessionId: "s1", runId: "run-current" });
await callSessionRecord("load_skill");
assert.deepEqual((await callSessionRecord("read_loaded")).result.loaded, ["fresh-skill"],
  "a run without a live Agent reads the Session's loaded Skills on its next nested call");

const driveExecutions = [];
const driveBridge = createRunScriptBridge({
  supervisor: {
    isRunCurrent: (_sessionId, runId) => ["run-current", "opaque-direct-run", "drive-native-looking-run"].includes(runId),
    hasAgent: () => false,
    getAbortSignal: () => controller.signal,
  },
  getRuntime: () => ({ status: "running" }),
  isTerminalRuntimeForRun: () => false,
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  getRunToolContext: async (_sessionId, runId) => ({ externalDrive: runId === "opaque-direct-run" }),
  toolRuntime: {
    resolveDefinition: () => ({ behavior: {} }),
    getSchemas: () => [
      { function: { name: "open_tab", description: "Open a tab\nsecond", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
      { function: { name: "read_dom", description: "Read", parameters: { type: "object" } } },
      { function: { name: "ask_llm", description: "Ask", parameters: { type: "object" } } },
    ],
    getTabAliases: () => ({ page: 7 }),
    async execute(name, args, _signal, context) {
      if (name === "list_tools") return { tools: [{ name: "open_tab", signature: "open_tab({url:string})", description: "Open a tab" }] };
      if (name === "get_ax_tree") {
        const error = new Error("built-in alias");
        error.code = "BATCH_TAB_REFERENCE_ERROR";
        error.details = { reason: "no_alias", tabRef: "page" };
        throw error;
      }
      driveExecutions.push(name);
      if (name === "list_tabs") {
        if (context.externalDrive === true && args.scope !== "all") return {
          tabs: [{ tabRef: "page", title: "Owned", url: "https://httpbin.org/html", active: false }], count: 1, foreign: 1,
        };
        return [
          { tabRef: "page", title: "Owned", url: "https://httpbin.org/html", active: false },
          { tabRef: 8, title: "Other", url: "https://httpbin.org/robots.txt", active: false },
        ];
      }
      return { ok: true };
    },
  },
  collectArtifacts: () => [],
});
const blockedAsk = await driveBridge.handleToolCall({
  toolName: "ask_llm",
  args: { prompt: "hi" },
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.equal(blockedAsk.ok, false);
assert.equal(blockedAsk.code, "DRIVE_TOOL_FORBIDDEN");
assert.deepEqual(driveExecutions, []);
const blockedUseTab = await driveBridge.handleToolCall({
  toolName: "use_tab", args: { tabRef: "page" }, sessionId: "s1", runId: "opaque-direct-run",
});
const outerOperation = createToolOperation();
outerOperation.prepare({ tool: "run_script" });
outerOperation.dispatch();
const blockedReceipt = withToolOperationFailure(blockedUseTab.result, outerOperation);
assert.equal(blockedReceipt.code, "DRIVE_TOOL_FORBIDDEN");
assert.deepEqual(blockedReceipt.details, { tool: "use_tab", status: "not_started", executed: false,
  mayHaveTakenEffect: false, automaticReplay: false });
assert.deepEqual(driveExecutions, [], "forbidden calls retain their identity without executing");
const driveList = await driveBridge.handleToolCall({
  toolName: "__list_tools__",
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.deepEqual(driveList.result.tools, [{ name: "open_tab", signature: "open_tab({url:string})", description: "Open a tab" }]);
const missingPage = await driveBridge.handleToolCall({
  toolName: "read_dom",
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.equal(missingPage.ok, false);
assert.equal(missingPage.code, "TAB_REF_REQUIRED");
assert.deepEqual(driveExecutions, []);
assert.equal((await driveBridge.handleToolCall({
  toolName: "read_dom",
  args: { tabRef: "page" },
  sessionId: "s1",
  runId: "opaque-direct-run",
})).ok, true);
assert.deepEqual(driveExecutions, ["read_dom"]);
const driveTabs = await driveBridge.handleToolCall({
  toolName: "list_tabs",
  args: {},
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.deepEqual(driveTabs.result, {
  tabs: [{ tabRef: "page", title: "Owned", url: "https://httpbin.org/html", active: false }],
  count: 1,
  foreign: 1,
});
assert.equal("width" in driveTabs.result, false);
const allTabs = await driveBridge.handleToolCall({
  toolName: "list_tabs",
  args: { scope: "all" },
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.equal(Array.isArray(allTabs.result), true);
assert.equal(allTabs.result.length, 2);
assert.equal(allTabs.result[0].tabRef, "page");
const plainTabs = await driveBridge.handleToolCall({
  toolName: "list_tabs",
  args: {},
  sessionId: "s1",
  runId: "drive-native-looking-run",
});
assert.equal(Array.isArray(plainTabs.result), true);
assert.equal(plainTabs.result[1].tabRef, 8);
const driveAlias = await driveBridge.handleToolCall({
  toolName: "get_ax_tree",
  args: { tabRef: "page" },
  sessionId: "s1",
  runId: "opaque-direct-run",
});
assert.equal(driveAlias.ok, false);
assert.equal(driveAlias.code, "BATCH_TAB_REFERENCE_ERROR");
assert.match(driveAlias.message, /list_tabs/);
assert.match(driveAlias.message, /list_tabs/);
assert.doesNotMatch(driveAlias.message, /省略 tabRef|omit tabRef/i);
const builtInAlias = await driveBridge.handleToolCall({
  toolName: "get_ax_tree",
  args: { tabRef: "page" },
  sessionId: "s1",
  runId: "drive-native-looking-run",
});
assert.equal(builtInAlias.code, "BATCH_TAB_REFERENCE_ERROR");
assert.doesNotMatch(builtInAlias.message, /省略 tabRef|omit tabRef/i);
assert.match(builtInAlias.message, /no page alias yet|还没有页面别名/);

{
  const recorded = [], holders = [], parentPresentation = { _display: { parent: true } };
  const values = [null, undefined, 'primitive'];
  const collectorBridge = createRunScriptBridge({
    supervisor, getRuntime: () => ({ status: 'running' }), canManageSessions: async () => true,
    buildRunProfile: async () => ({}),
    getRunToolContext: async () => ({ externalDrive: true, resultPresentation: parentPresentation }),
    recordNestedTool: async input => { if (input.phase === 'end') recorded.push(input); },
    toolRuntime: {
      resolveDefinition: () => ({ model: { preserveResult: true } }), getSchemas: () => [],
      async execute(_name, { index }, _signal, context) {
        assert.deepEqual(context.resultPresentation, {});
        holders.push(context.resultPresentation);
        Object.assign(context.resultPresentation, { _display: { script: { valueOnly: true, trace: [index] } } });
        return values[index];
      },
    },
    collectArtifacts: () => [],
  });
  for (const [index, value] of values.entries()) {
    const response = await collectorBridge.handleToolCall({ toolName: 'run_script', args: { index, code: 'async () => null' },
      sessionId: 's1', runId: 'run-current' });
    assert.equal(response.ok, true);
    assert.equal(response.result, value);
    assert.equal(recorded[index].result, value);
    assert.deepEqual(recorded[index].resultPresentation._display.script.trace, [index]);
  }
  assert.equal(new Set(holders).size, values.length);
  assert.deepEqual(parentPresentation, { _display: { parent: true } });
}

const parentDeadline = Date.now() + 5_000;
await withToolCallLifecycle({ sessionId: "s1", runId: "run-current", deadlineAt: parentDeadline }, async parent => {
  const child = await bridge.handleToolCall({ toolName: "read_dom", sessionId: "s1", runId: "run-current",
    parentCallId: parent.toolExecutionId, deadlineAt: parentDeadline + 60_000 });
  assert.equal(child.ok, true);
  assert.equal(executions.at(-1).context.deadlineAt, parentDeadline, "the child inherits the host deadline, never a message-supplied budget");
});
await bridge.handleToolCall({ toolName: "read_dom", sessionId: "s1", runId: "run-current", deadlineAt: parentDeadline });
assert.equal(executions.at(-1).context.deadlineAt, undefined, "an unrelated call must not inherit another parent's deadline");

const operation = createToolOperation();
operation.prepare({ tabRef: 'checkout', action: 'click' });
await withToolCallLifecycle({ sessionId: 's1', runId: 'run-current', operation }, async parent => {
  await bridge.invokeTool(parent, 'read_dom', {});
  assert.equal(executions.at(-1).context.operation, operation,
    'the host can explicitly pass one action record to its triggering child');

  const response = await bridge.handleToolCall({ toolName: 'read_dom', sessionId: 's1', runId: 'run-current',
    parentCallId: parent.toolExecutionId, operation });
  assert.equal(response.ok, true);
  assert.equal(executions.at(-1).context.operation, undefined,
    'ordinary script children cannot inherit or forge the parent action record');
});
await bridge.handleToolCall({ toolName: 'read_dom', sessionId: 's1', runId: 'run-current', operation });
assert.equal(executions.at(-1).context.operation, undefined, 'unrelated calls have no shared execution evidence');
assert.equal(operation.snapshot().executed, false);

console.log("run_script bridge tests passed");

import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry } from "../../src/background/tools/registry.js";
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { planTabBatch } from "../../src/background/tools/tab-batch.js";
import { scheduleToolCalls } from "../../src/background/tools/tool-scheduler.js";
import { findBuiltinSkill } from "../../src/shared/skills/builtin-skills.js";
import { parseSkillManifest, findSkillManifestResource } from "../../src/shared/skills/skill-manifest.js";
import { createRunScriptBridge } from "../../src/background/tools/run-script-bridge.js";
import { clearTraceLog, getTraceLog } from "../../src/background/trace.js";
import { bindToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";

globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Page" }; } },
};
const tools = await import("../../src/background/tools/runtime.js");
const context = { sessionId: "session", runId: "run", workingTabId: 31 };
const scriptContext = { ...context, source: "run_script", senderTabId: 31, runScriptToolDepth: 0 };
const controller = new AbortController();
let currentRun = true;
const targets = [];
const runtime = tools.createToolRuntime({ sessions: {
  async resolveTargetTab(input) {
    targets.push(input);
    return input.tabId === 99 ? { ok: false, code: "SESSION_TAB_FOREIGN" } : { ok: true, tabId: input.tabId };
  },
} });
const bridge = createRunScriptBridge({
  supervisor: { isRunCurrent: () => currentRun, hasAgent: () => true, getAbortSignal: () => controller.signal },
  getRuntime: () => ({ status: "running", workingTabId: 31 }),
  canManageSessions: async () => true,
  buildRunProfile: async () => ({}),
  toolRuntime: runtime,
  collectArtifacts: () => [],
});
const nested = (toolName, args = {}, tabId = 31) => bridge.handleToolCall({ ...context, toolName, args: { tabRef: args.tabId ?? tabId, ...args } }, { tab: { id: tabId } });

test("a newly named tool declares unload behavior once for direct script and forwarded host execution", async () => {
  let calls = 0;
  const behavior = { mayUnloadPage: args => args.action === "leave" };
  tools.defineTool({ name: "__custom_page_action", description: "Test", behavior, page: "owned", parameters: {
    type: "object", properties: { action: { type: "string", enum: ["stay", "leave"] }, tabId: { type: "number" } }, required: ["action"],
  }, execute: () => { calls++; return { value: calls }; } });
  behavior.mayUnloadPage = false;
  assert.ok(Object.isFrozen(runtime.resolveDefinition("__custom_page_action").behavior));
  const before = targets.length;
  assert.equal((await nested("__custom_page_action", { action: "invalid" })).code, "INVALID_ARGUMENTS");
  assert.equal(targets.length, before, "invalid arguments must fail before target ownership work");
  const denied = await nested("__custom_page_action", { action: "leave" });
  assert.equal(denied.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
  assert.deepEqual(denied.details, { action: "leave", submit: false });
  assert.equal(Object.hasOwn(denied.details, "targetTabId"), false);
  assert.equal(Object.hasOwn(denied.details, "sourceTabId"), false);
  assert.equal(calls, 0);
  await assert.rejects(runtime.execute("__custom_page_action", { action: "leave", tabRef: 31 }, undefined,
    { ...scriptContext, source: "plugin_host" }), { code: "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED" });
  assert.equal((await nested("__custom_page_action", { action: "leave", tabId: 99 })).code, "SESSION_TAB_FOREIGN");
  assert.equal(calls, 0, "lifecycle policy cannot grant ownership");
  assert.equal((await nested("__custom_page_action", { action: "stay" })).ok, true);
  assert.equal((await nested("__custom_page_action", { action: "leave", tabId: 32 })).ok, true);
  await runtime.execute("__custom_page_action", { action: "leave", tabRef: 31 }, undefined, { ...context, senderTabId: 31 });
  assert.equal(calls, 3, "ordinary calls and other owned tabs retain their established behavior");
});

test("built-in unload declarations retain navigation, closing, click, submit and key protection", async () => {
  runtime.element.registerElementRef({ uid: 'known', tabId: 31, sessionId: 'session', backendNodeId: 42 });
  for (const [name, args] of [
    ["navigate", { url: "https://example.test/next" }],
    ["close_tab", { tabId: 31 }],
    ["act_on_element", { target: "css:button", action: "click" }],
    ["act_on_element", { target: "uid:known", action: "click" }],
    ["act_on_element", { target: "css:input", action: "fill", value: "search", submit: true }],
    ...["Enter", "Return", "Space"].map(key => ["act_on_element", { target: "css:input", action: "press", key }]),
  ]) {
    const result = await nested(name, args);
    assert.equal(result.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED", `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(result.details, {
      ...(args.action ? { action: args.action } : {}),
      ...(args.key || args.value ? { key: args.key || args.value } : {}),
      submit: args.submit === true,
      ...(name === "act_on_element" ? {
        tool: name, tabRef: 31, target: args.target, status: "not_started",
        executed: false, mayHaveTakenEffect: false, automaticReplay: false,
      } : {}),
    });
    assert.equal(Object.hasOwn(result.details, "sourceTabId"), false);
    assert.equal(Object.hasOwn(result.details, "targetTabId"), false);
  }
  assert.equal((await nested('act_on_element', { target: 'uid:unknown', action: 'click' })).code, 'STALE_ELEMENT_UID');
  const policy = runtime.resolveDefinition("act_on_element").behavior.mayUnloadPage;
  assert.equal(policy({ action: "press", value: "Enter" }), true);
  for (const args of [{ action: "fill", submit: false }, { action: "press", key: "Tab" }, { action: "check" }, { action: "scroll" }]) {
    assert.equal(policy(args), false);
  }
});

test("new observation tools promote images only through trusted definitions and preserve cancellation", async () => {
  let calls = 0;
  const image = "data:image/png;base64,b2JzZXJ2YXRpb24=";
  const parameters = { type: "object", properties: { observe: { type: "boolean" } } };
  const execute = () => { calls++; return bindToolResultPresentation(
    { _image: image, _imageDetail: "high", _display: { label: "business value" }, behavior: { nestedObservation: true } },
    { _display: { image } }); };
  tools.defineTool({ name: "__custom_observe", description: "Test", parameters,
    behavior: { nestedObservation: args => args.observe === true }, execute });
  tools.defineTool({ name: "__ordinary_image", description: "Test", parameters, execute });
  const promoted = await nested("__custom_observe", { observe: true });
  assert.deepEqual(promoted.observation, { _image: image, _imageDetail: "high" });
  assert.equal(promoted.result._image, undefined);
  assert.deepEqual(promoted.result._display, { label: "business value" }, "business fields survive separately bound host presentation");
  for (const [name, args] of [["__custom_observe", { observe: false }], ["__ordinary_image", { observe: true }]]) {
    const result = await nested(name, args);
    assert.equal(result.observation, undefined, "an ordinary result cannot declare its own observation role");
    assert.equal(result.result._image, image);
    assert.deepEqual(result.result._display, { label: "business value" });
  }
  currentRun = false;
  assert.equal((await nested("__custom_observe", { observe: true })).code, "RUN_STOPPED");
  currentRun = true;
  controller.abort();
  assert.equal((await nested("__custom_observe", { observe: true })).code, "RUN_STOPPED");
  assert.equal(calls, 3, "stale and cancelled runs never invoke the tool");
});

test("external plugins cannot declare behavior, while trusted host aliases inherit their core target", () => {
  const registry = createToolRegistry(); let hostDecisions = 0;
  registry.defineTool({ ...tools.resolveToolDefinition("manage_settings"), tabLifecycle: 'created',
    behavior: { barrier: () => { hostDecisions++; return false; }, nestedObservation: true, mayUnloadPage: true, parallelRead: true },
  });
  const toolRegistrySnapshot = registry.snapshot();
  const core = toolRegistrySnapshot.get("manage_settings");
  assert.throws(() => { core.behavior = {}; }, TypeError, "registered behavior remains immutable");
  const skill = findBuiltinSkill("qingzhou-management");
  const plugin = parseSkillManifest(findSkillManifestResource(skill.resources).content, skill).plugin;
  const tool = plugin.tools.find(item => item.localName === "manage_settings");
  const resolve = plugin => runtime.resolveDefinition(tool.name, { toolRegistrySnapshot, skillToolRegistrySnapshot: {
    plugins: [plugin], toolIndex: new Map([[tool.name, { plugin, tool }]]),
  } });
  assert.deepEqual(resolve(plugin).behavior, { ...core.behavior, barrier: true });
  assert.equal(runtime.getParallelReadTab('manage_settings', { tabId: 12 }, { toolRegistrySnapshot }), 12);
  assert.deepEqual(runtime.getBatchTabPolicy('manage_settings', { tabAlias: 'a' }, { toolRegistrySnapshot }), { kind: 'create' });
  const beforePlugin = hostDecisions;
  for (const candidate of [plugin, structuredClone(plugin)]) {
    const claimedTool = { ...tool, source: 'core', behavior: { barrier: false, parallelRead: true, parallelOpen: true, parallelTab: true, delegatesExecution: true } };
    const options = { toolRegistrySnapshot, skillToolRegistrySnapshot: {
      plugins: [candidate], toolIndex: new Map([[tool.name, { plugin: candidate, tool: claimedTool }]]),
    } };
    assert.equal(runtime.resolveDefinition(tool.name, options).source, 'plugin');
    assert.equal(runtime.getParallelReadTab(tool.name, { tabId: 12, parallelRead: true }, options), null,
      'even a trusted host alias or a forged plugin source stays outside core scheduling authority');
    assert.deepEqual(runtime.getBatchTabPolicy(tool.name, { tabAlias: 'a', tabRef: 'b' }, options), { kind: 'barrier' },
      'plugin aliases also cannot create or resolve batch tab bindings');
  }
  assert.equal(hostDecisions, beforePlugin, 'a plugin overrides the host predicate with literal barrier:true');
  for (const untrusted of [structuredClone(plugin), { ...plugin, skillBuiltin: false }, { ...plugin, skillSource: "local" }, { ...plugin, id: "external-plugin" }]) {
    assert.deepEqual(resolve(untrusted).behavior, { barrier: true }, "plugin declarations must not cross the trusted behavior boundary");
  }
});

test('capability declarations alone place new tool names into the same graph, with barrier precedence', async () => {
  const registry = createToolRegistry(), qz = { registerTool: registry.forCapability('sample-capability') };
  const base = { description: 'Fixture', page: 'tab', parameters: { type: 'object', properties: { tabId: { type: 'number' } } }, execute: () => ({}) };
  qz.registerTool({ ...base, name: 'sample_local', behavior: { parallelTab: true } });
  qz.registerTool({ ...base, name: 'sample_read', behavior: { parallelRead: true } });
  qz.registerTool({ ...base, name: 'sample_barrier', behavior: { parallelTab: true, parallelRead: true, delegatesExecution: true, barrier: true } });
  qz.registerTool({ ...base, name: 'sample_creator', tabLifecycle: 'created', behavior: { parallelOpen: true, delegatesExecution: true, barrier: true } });
  qz.registerTool({ name: 'sample_global', description: 'Global', behavior: { barrier: true },
    parameters: { type: 'object', properties: {} }, execute: () => ({}) });
  const lookup = { toolRegistrySnapshot: registry.snapshot() };
  assert.equal(tools.getParallelReadTab('sample_read', { tabId: 4 }, lookup), 4);
  assert.equal(tools.getParallelReadTab('sample_barrier', { tabId: 3, barrier: false }, lookup), null);
  assert.equal(tools.getBatchTabPolicy('sample_barrier', { tabId: 3 }, lookup).orchestration, undefined);
  assert.deepEqual(tools.getBatchTabPolicy('sample_creator', {}, lookup), { kind: 'create', parallel: false, targeted: true });
  assert.deepEqual(tools.getBatchTabPolicy('sample_global', {}, lookup), { kind: 'barrier' });
  const input = [
    { name: 'sample_local', tabId: 1 }, { name: 'sample_local', tabId: 2 },
    { name: 'sample_barrier', tabId: 3 }, { name: 'sample_read', tabId: 4 },
  ];
  const plan = planTabBatch(input, item => ({ args: { tabId: item.tabId }, policy: tools.getBatchTabPolicy(item.name, item, lookup) }));
  const started = [], committed = [], releases = new Map(), tick = () => new Promise(resolve => setImmediate(resolve));
  const run = scheduleToolCalls(input, { signal: new AbortController().signal, tab: item => item.tabId,
    dependencies: plan.dependencies, independent: plan.independent,
    execute: async item => { started.push(item.tabId); await new Promise(resolve => releases.set(item.tabId, resolve)); return item; },
    commit: async item => { committed.push(item.tabId); },
  });
  await tick(); assert.deepEqual(started, [1, 2]);
  releases.get(2)(); await tick(); assert.deepEqual(committed, []); assert.deepEqual(started, [1, 2]);
  releases.get(1)(); await tick(); assert.deepEqual(committed, [1, 2]); assert.deepEqual(started, [1, 2, 3]);
  releases.get(3)(); await tick(); assert.deepEqual(committed, [1, 2, 3]); assert.deepEqual(started, [1, 2, 3, 4]);
  releases.get(4)(); await run; assert.deepEqual(committed, [1, 2, 3, 4]);
});

test('page evaluation occupies explicit lanes while outer scripts schedule their descendants', async () => {
  assert.equal(runtime.resolveDefinition('run_script').behavior.orchestration, true);
  assert.equal(runtime.resolveDefinition('run_skill_script').behavior.barrier, true);
  for (const name of ['evaluate', 'run_skill_script']) {
    for (const mutatesPage of [false, true]) for (const code of ['42', 'return input.value + args.extra', 'tools.$list()', 'eval(input.code)', 'async () => {', undefined]) {
      const args = { mutatesPage, tabRef: 'a', code, args: { value: 1, extra: 2 } };
      assert.deepEqual(runtime.getBatchTabPolicy(name, args),
        { kind: 'target', implicit: false, observation: false, ...(name === 'evaluate' ? { parallel: true } : {}) });
      assert.equal(runtime.getParallelReadTab(name, { ...args, tabId: 1 }), null);
    }
  }
  assert.deepEqual(runtime.getBatchTabPolicy('run_script', { code: 'return await tools.list_tabs();' }), { kind: 'script' });
  assert.deepEqual(runtime.getBatchTabPolicy('run_script', { tabRef: 'a', code: 'return 42;' }), { kind: 'script' }, 'business arguments cannot change the trusted scheduling role');
  await assert.rejects(runtime.execute('run_script', { tabRef: 'a', code: 'return 42;' }), { code: 'INVALID_RUN_SCRIPT_INPUT' });
  assert.deepEqual(runtime.getBatchTabPolicy('run_skill_script', { target: 'inner', code: 'return 42', tabRef: 'a' }), { kind: 'barrier' }, 'hidden worker compatibility retains its own scheduling boundary');
});

test('a barrier predicate is evaluated once per planned call; throwing predicates fail closed', async () => {
  const registry = createToolRegistry(); let decisions = 0;
  registry.forCapability('predicate-fixture')({ name: 'conditional_scope', description: 'Fixture', page: 'tab',
    parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
    behavior: { parallelRead: true, parallelTab: true, barrier: args => {
      decisions++; if (args.tabId === 3) throw new Error('unknown scope'); return args.tabId === 2;
    } }, execute: () => ({}),
  });
  const lookup = { toolRegistrySnapshot: registry.snapshot() }, contexts = [];
  const agent = new Agent('predicate', createTestAgentOptions({ tools: {
    getSchemas: () => [], getIdentity: () => ({}),
    getBatchTabPolicy: (name, args) => tools.getBatchTabPolicy(name, args, lookup),
    getParallelReadTab: () => { throw new Error('the planned decision must be reused'); },
    execute: async (_name, args, _signal, context) => { contexts.push(context); return { tabId: args.tabId }; },
  } }));
  await agent._executeToolCalls([1, 2, 3].map(tabId => ({ id: String(tabId), function: {
    name: 'conditional_scope', arguments: JSON.stringify({ tabId }),
  } })), new AbortController().signal);
  assert.equal(decisions, 3);
  assert.deepEqual(contexts.map(c => c.deferToolCommit), [true, false, false]);
  assert.deepEqual(contexts.map(c => c.preserveWorkingTab), [true, false, false]);
});

test('UID targets retain their batch lanes while runtime requires an agreeing explicit page', async () => {
  const registry = createToolRegistry(), qz = { registerTool: registry.forCapability('uid-fixture') };
  const parameters = { type: 'object', properties: {
    target: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, tabId: { type: 'number' },
  } };
  qz.registerTool({ name: 'uid_single', description: 'Fixture', page: 'owned', parameters,
    behavior: { parallelTab: true }, execute: () => ({}) });
  qz.registerTool({ name: 'uid_multi', description: 'Fixture', page: 'owned', parameters,
    behavior: { parallelTab: true, uidTargets: args => (Array.isArray(args.targets) ? args.targets : []) }, execute: () => ({}) });
  const lookup = { toolRegistrySnapshot: registry.snapshot() };
  for (const [uid, tabId] of [['t41.0000a1.1', 41], ['t41.0000a2.2', 41], ['t42.0000b1.1', 42]]) {
    runtime.element.registerElementRef({ uid, tabId, sessionId: 'session', pageUrl: `https://example.test/${tabId}` });
  }

  assert.equal(tools.hasUidElementTargets('uid_multi', { targets: ['uid:t41.0000a1.1'] }, lookup), true);
  assert.equal(tools.hasUidElementTargets('uid_multi', { targets: ['css:img'] }, lookup), false);
  assert.equal(tools.hasUidElementTargets('uid_single', { target: 'uid:t41.0000a1.1' }, lookup), true,
    'the singular target field is covered without a declared extractor');

  assert.deepEqual(tools.getBatchTabPolicy('uid_multi', { targets: ['uid:t41.0000a1.1', 'uid:t41.0000a2.2'] }, lookup),
    { kind: 'target', implicit: false, observation: false, parallel: true, tabId: 41 },
    'uids on one tab schedule on that tab, never the working tab');
  assert.deepEqual(tools.getBatchTabPolicy('uid_single', { target: 'uid:t42.0000b1.1' }, lookup),
    { kind: 'target', implicit: false, observation: false, parallel: true, tabId: 42 });
  assert.equal(tools.hasUidElementTargets('uid_multi', { target: 'uid:t41.0000a1.1' }, lookup), true,
    'a declared extractor extends rather than replaces singular fields');
  assert.equal(tools.hasUidElementTargets('uid_multi', { targets: ['css:img', 'uid:t41.0000a1.1'] }, lookup), true,
    'a uid later in a mixed array still suppresses working-tab enrichment');
  for (const args of [
    { targets: ['uid:t41.0000a1.1', 'uid:t42.0000b1.1'] },
    { target: 'uid:t42.0000b1.1', targets: ['uid:t41.0000a1.1'] },
    { targets: ['uid:t41.0000a1.1', 'css:img'] },
    { targets: ['css:img', 'uid:t41.0000a1.1'] },
    { targets: ['uid:t41.0000a1.1', 42, null] },
    { targets: ['uid:t99.0000c1.1'] },
  ]) {
    assert.deepEqual(tools.getBatchTabPolicy('uid_multi', args, lookup),
      { kind: 'target', implicit: false, observation: false },
      'cross-tab, mixed or unknown target sets keep conservative serialization');
  }

  const input = [
    { name: 'uid_multi', targets: ['uid:t41.0000a1.1'] },
    { name: 'uid_multi', targets: ['uid:t42.0000b1.1'] },
    { name: 'uid_multi', targets: ['uid:t41.0000a2.2'] },
  ];
  const plan = planTabBatch(input, item => ({ args: item, policy: tools.getBatchTabPolicy(item.name, item, lookup) }));
  const started = [], releases = new Map(), tick = () => new Promise(resolve => setImmediate(resolve));
  const run = scheduleToolCalls(input, { signal: new AbortController().signal, tab: () => null,
    dependencies: plan.dependencies, independent: plan.independent,
    execute: async item => { started.push(item.targets[0]); await new Promise(resolve => releases.set(item.targets[0], resolve)); return item; },
    commit: async () => {},
  });
  await tick();
  assert.deepEqual(started, ['uid:t41.0000a1.1', 'uid:t42.0000b1.1'], 'different uid tabs run in parallel');
  releases.get('uid:t42.0000b1.1')(); await tick();
  assert.deepEqual(started, ['uid:t41.0000a1.1', 'uid:t42.0000b1.1'], 'a same-tab uid call waits for its lane');
  releases.get('uid:t41.0000a1.1')(); await tick();
  assert.deepEqual(started, ['uid:t41.0000a1.1', 'uid:t42.0000b1.1', 'uid:t41.0000a2.2']);
  releases.get('uid:t41.0000a2.2')(); await run;

  let received = null;
  tools.defineTool({ name: '__uid_working_tab', description: 'Test', page: 'owned', parameters,
    behavior: { uidTargets: args => (Array.isArray(args.targets) ? args.targets : []) },
    execute: args => { received = args; return { ok: true }; } });
  const resolveCallsBefore = targets.length;
  await runtime.execute('__uid_working_tab', { tabRef: 41, targets: ['uid:t41.0000a1.1'] }, undefined, context);
  assert.equal(received.tabId, 41, 'explicit reference agrees with the registered UID page');
  assert.equal(targets.length, resolveCallsBefore, 'UID resolution does not claim an extra page upstream');
  await runtime.execute('__uid_working_tab', { tabRef: 31, targets: ['css:img'] }, undefined, context);
  assert.equal(received.tabId, 31, 'CSS uses the explicit caller page');
  await runtime.execute('__uid_working_tab', { tabRef: 41, targets: ['css:img', 'uid:t41.0000a1.1'] }, undefined, context);
  assert.equal(targets.at(-1).tabId, 41, 'mixed calls authorize the explicit page');
  assert.equal(received.tabId, 41);
  await assert.rejects(runtime.execute('__uid_working_tab', { targets: ['uid:t41.0000a1.1'] }, undefined, context),
    { code: 'TAB_REF_REQUIRED' }, 'even a registered UID does not replace the required page reference');
  await runtime.execute('__uid_working_tab', { target: 'uid:t41.0000a1.1', tabRef: 41 }, undefined, context);
  assert.equal(received.tabId, 41, 'an agreeing tabRef and UID resolve to the same browser tab');
  await assert.rejects(runtime.execute('__uid_working_tab', { target: 'uid:t41.0000a1.1', tabRef: 42 }, undefined, context),
    error => error.details.reason === 'conflicting_target');
  received = null;
  for (const args of [
    { targets: ['css:img', 'uid:t41.0000a1.1'], tabId: 99 },
    { targets: ['css:img', 'uid:t41.0000a1.1'], _tabId: 31 },
  ]) {
    await assert.rejects(runtime.execute('__uid_working_tab', args, undefined, { ...context, workingTabId: 99 }),
      { code: args.tabId != null ? 'BATCH_TAB_REFERENCE_ERROR' : 'TAB_REF_REQUIRED' }, 'a uid cannot smuggle a CSS read onto a foreign tab');
  }
  assert.equal(received, null);
});

test('undeclared uid-looking arguments cannot bypass page ownership', async () => {
  let calls = 0;
  for (const [name, additionalProperties, code] of [['__page_without_elements', undefined, 'INVALID_ARGUMENTS'],
    ['__open_page_without_elements', true, 'SESSION_TAB_FOREIGN']]) {
    tools.defineTool({ name, description: 'Fixture', page: 'owned',
      parameters: { type: 'object', properties: { tabId: { type: 'number' } }, ...(additionalProperties ? { additionalProperties } : {}) },
      execute: () => { calls++; return {}; },
    });
    for (const key of ['target', 'within', 'selector', 'root']) {
      const args = { tabId: 99, [key]: 'uid:t41.0000a1.1' };
      assert.equal(tools.hasUidElementTargets(name, args), false);
      await assert.rejects(runtime.execute(name, args, undefined, context), { code }, `${name} ${key}`);
    }
  }
  assert.equal(calls, 0, 'unconsumed uid-looking arguments must not skip the page:owned preflight');
});

test('a uid lane anchors later tab creation to its ordered working-tab selection', async () => {
  runtime.element.registerElementRef({ uid: 't41.0000a3.1', tabId: 41, sessionId: 'session' });
  const calls = [
    { name: 'act_on_element', target: 'uid:t41.0000a3.1', action: 'click' },
    { name: 'open_tab', url: 'https://example.test/new' },
  ];
  const plan = planTabBatch(calls, args => ({ args, policy: tools.getBatchTabPolicy(args.name, args) }));
  assert.ok(plan.dependencies(calls[1]).commit.includes(calls[0]),
    'an open must wait for a uid-selected tab in another window just as it waits for a numeric target');
});

test('Agent preserves explicit element and page references without adding a default page', async () => {
  const executed = [];
  const agent = new Agent('elements', createTestAgentOptions({ tools: {
    getSchemas: () => [], getIdentity: () => ({}),
    execute: async (_name, args) => { executed.push(args); return { text: 'observed' }; },
  }, browserContext: { getTab: async () => assert.fail('there is no implicit target to look up') } }));
  agent._dynamicContextSnapshot = { workingTab: { id: 31 }, userVisibleTab: { id: 32 } };
  const inputs = [
    ['read_image', { target: 'uid:t41.0000a1.1' }],
    ['act_on_element', { target: 'uid:t41.0000a1.1', action: 'click', tabRef: 41 }],
    ['read_dom', { target: 'css:body' }],
    ['get_ax_tree', {}],
    ['collect_images', { targets: ['uid:t41.0000a1.1', 'uid:t42.0000b1.1'] }],
  ];
  for (const [name, args] of inputs) await agent._executeToolCalls([{ id: name, function: {
    name, arguments: JSON.stringify(args),
  } }], new AbortController().signal);
  assert.deepEqual(executed, inputs.map(([, args]) => args));
});

test("custom timeout diagnostic declarations retain the runtime's abort signal and trace fields", async () => {
  let signal;
  await clearTraceLog();
  tools.defineTool({ name: "__custom_timeout", description: "Test", parameters: { type: "object", properties: {} }, timeout: 5,
    behavior: { timeoutTrace: "custom_action_trace" },
    execute: (_args, value) => { signal = value; return new Promise(() => {}); },
  });
  await assert.rejects(runtime.execute("__custom_timeout", {}, undefined, context), { code: "TOOL_TIMEOUT" });
  assert.equal(signal.aborted, true);
  assert.ok((await getTraceLog()).some(line => line.includes("custom_action_trace") && line.includes("phase=tool.timeout")
    && line.includes("session=session") && line.includes("run=run")));
});

test('popup-only behavior captures child pages without forbidding same-page nested execution', async () => {
  const order = [];
  tools.defineTool({ name: '__popup_only_action', description: 'Popup action', page: 'owned',
    behavior: { mayOpenPopup: true }, parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] } }, required: ['tabRef'] },
    async execute() { order.push('execute'); return { done: true }; },
  });
  const popupRuntime = tools.createToolRuntime({ sessions: {
    async resolveTargetTab({ tabId }) { return { ok: true, tabId, ownedByCurrentTask: true }; },
    listOwnedTabIds: () => [31],
    beginPopupCapture(input) {
      assert.equal(input.openerTabId, 31);
      assert.equal(input.runId, 'run');
      order.push('capture');
      return { dispose() { order.push('dispose'); } };
    },
  } });
  assert.deepEqual(await popupRuntime.execute('__popup_only_action', { tabRef: 31 }, undefined, scriptContext), { done: true });
  assert.deepEqual(order, ['capture', 'execute', 'dispose']);
  for (const name of ['evaluate', 'act_on_screen', 'run_skill_script']) {
    assert.equal(popupRuntime.resolveDefinition(name).behavior.mayOpenPopup, true, `${name} must retain popup lifecycle handling`);
  }
});

test('popup observations are call-local inputs, never injected into caller-authored business results', async () => {
  const popup = { tabRef: 32, title: 'Popup', url: 'https://example.test/popup', active: false };
  const business = { popups: ['user-owned value'], result: 'unchanged' };
  let childContext;
  tools.defineTool({ name: '__popup_business_value', description: 'Page script business result', page: 'owned',
    behavior: { mayOpenPopup: true }, parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] } }, required: ['tabRef'] },
    async execute(_args, _signal, scoped) { childContext = scoped; assert.deepEqual(await scoped.observedPopups(), [popup]); return business; },
  });
  tools.defineTool({ name: '__plain_business_value', description: 'Plain business result',
    parameters: { type: 'object', properties: {} },
    execute(_args, _signal, scoped) { assert.equal(scoped.observedPopups, undefined); return business; },
  });
  let active = true;
  const observed = async () => active ? [{ ...popup }] : [];
  const popupRuntime = tools.createToolRuntime({ sessions: {
    async resolveTargetTab({ tabId }) { return { ok: true, tabId, ownedByCurrentTask: true }; },
    listOwnedTabIds: () => [31],
    beginPopupCapture() { return { observed, dispose() { active = false; } }; },
  } });
  assert.deepEqual(await popupRuntime.execute('__popup_business_value', { tabRef: 31 }, undefined, scriptContext), business);
  assert.deepEqual(await childContext.observedPopups(), [], 'settled calls cannot reuse their popup capture');
  assert.deepEqual(await popupRuntime.execute('__plain_business_value', {}, undefined,
    { ...scriptContext, observedPopups: () => [popup] }), business, 'a child must not inherit its parent capture');
});

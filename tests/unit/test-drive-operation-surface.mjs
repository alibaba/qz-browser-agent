import assert from 'node:assert/strict';
import test from 'node:test';
import { createElementObservation } from '../../src/shared/contracts/element-observation.js';
import { pageReferenceForResult } from '../../src/shared/tab-reference.js';
import { projectDriveResult, isDriveToolDiscoverable, isDriveToolForbidden, driveToolSignature } from '../../src/background/mcp/external-drive.js';
import { createMcpTransport } from '../../src/background/transports/mcp.js';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';
import { registerTabsNavigationTools } from '../../src/capabilities/tabs/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';
import { createMemoryStorage } from '../support/memory-storage.mjs';

const privateKey = /^(?:uid|selector|sourceSelector|_elementRef|backendNodeId|backendDOMNodeId|documentId|frameId|loaderId|snapshotId|tabId)$/;
function assertPublic(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) { assert.ok(!privateKey.test(key), key); assertPublic(item); }
}

test('construct element observations from business fields and the registry handle, not by cleaning responses', () => {
  const candidate = { uid: 'private', selector: '#image', _elementRef: 'token', backendNodeId: 42, text: 'Image', rect: {x:1,y:2,w:30,h:40} };
  const observation = createElementObservation(candidate, 'uid:t5.000001.1');
  assert.deepEqual(observation, {target:'uid:t5.000001.1',text:'Image',rect:{x:1,y:2,width:30,height:40}});
  assertPublic(observation);
  assert.equal(candidate.selector, '#image');
  const authored = { attrs: { selector: 'attribute', uid: 'attribute' }, value: { source: 'selector', mode: 'selector' }, text: 'selector tabId inner' };
  const data = createElementObservation(authored, 'css:img');
  assert.deepEqual(data.attrs, authored.attrs); assert.deepEqual(data.value, authored.value);
  assert.equal(pageReferenceForResult('page', 5), 'page');
  assert.equal(pageReferenceForResult('005', 5), '005');
  assert.equal(pageReferenceForResult(5, 7), 5);
  assert.equal(pageReferenceForResult(undefined, 5), 5);
});

test('list_tabs constructs public discovery rows and preserves active independently of the native task default', async () => {
  globalThis.chrome = {storage:{local:{async get(){return {};}}},tabs:{async query(){return [{id:5,title:'Page',url:'https://example.test',active:true,windowId:9}];}}};
  const definitions = new Map();
  registerTabsNavigationTools({registerTool: d=>definitions.set(d.name,d),ToolExecutionError,
    getToolRuntimeDependencies:()=>({sessions:{resolveTargetTab:async()=>({ok:true,ownedByCurrentTask:true}),getTabAliases:()=>({page:5})}}),
    assertTabAllowed:async()=>{},assertUrlAllowed:()=>{},assertPageUrlAccessible:async()=>{},enablePreNavigationNetworkWatch:async()=>{},
    withDebugger:async()=>{},getDebuggerConnectionId:()=>null,setDebuggerRetention(){},releaseDebugger:async()=>{}});
  const context={sessionId:'surface',runId:'opaque-operation-run',externalDrive:true,workingTabId:5};
  const rows=await definitions.get('list_tabs').execute({},undefined,context);
  assertPublic(rows); assert.deepEqual(rows, {tabs:[{tabRef:'page',title:'Page',url:'https://example.test',active:true}],count:1,foreign:0});
  assert.equal(Object.hasOwn(rows.tabs[0],'isWorkingTab'),false);assert.equal(Object.hasOwn(rows.tabs[0],'windowId'),false);
  for(const args of [{},{scope:'all'},{verbose:true}]) {
    const {value}=projectDriveResult(rows);
    assert.doesNotMatch(JSON.stringify(value),/workingTab|isWorkingTab|tabId|windowId/);
    assert.equal((Array.isArray(value)?value:value.tabs)[0].active,true);
  }
  const native=await definitions.get('list_tabs').execute({},undefined,{...context,runId:'drive-native-looking-run',externalDrive:false});
  assert.deepEqual(native, rows, 'native and drive expose the same Tab observations');
  assert.equal(definitions.has('use_tab'), false);
  assert.equal(definitions.has('get_working_tab'), false);
  for(const name of ['use_tab','get_working_tab','run_skill_script']) {
    assert.equal(isDriveToolDiscoverable(name),false);assert.equal(isDriveToolForbidden(name),true);
    assert.throws(()=>driveToolSignature({name}),{code:'DRIVE_TOOL_FORBIDDEN'});
  }
});

test('MCP transport forwards the producer control receipt unchanged', async () => {
  const receipt={sessionId:'owned-test',stopped:true,status:'aborted'};
  const api={system:{ready:async()=>{}},sessions:{stop:async()=>receipt}};
  const result=await createMcpTransport(api).dispatch({method:'stop_session',params:{sessionId:'owned-test'}});
  assert.equal(result,receipt);assertPublic(result);
});

test('nested tools return their source DTO without a recursive field filter or a model size cap', async () => {
  const result={results:[createElementObservation({text:'Image'},'uid:t5.000001.1')],text:'x'.repeat(50000)};
  const bridge=createRunScriptBridge({supervisor:{isRunCurrent:()=>true,hasAgent:()=>true,getAbortSignal:()=>new AbortController().signal},
    getRuntime:()=>({status:'running'}),isTerminalRuntimeForRun:()=>false,canManageSessions:async()=>true,buildRunProfile:async()=>({}),
    toolRuntime:{resolveDefinition:()=>({behavior:{}}),getSchemas:()=>[],execute:async()=>result},collectArtifacts:()=>[]});
  const response=await bridge.handleToolCall({toolName:'find_elements',args:{tabRef:5},sessionId:'surface',runId:'drive-test'});
  assert.equal(response.ok,true);assertPublic(response.result);assert.equal(response.result.text.length,50000);
  const opaque=projectDriveResult({ok:true,result:{selector:'data',tabId:'data',mode:'selector'}});
  assert.deepEqual(opaque.value.result,{selector:'data',tabId:'data',mode:'selector'});
});

test('real allowed tool declarations publish references and public terms without catalog repair', async () => {
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: { async get() { return {}; } } } };
  const { getToolSchemas, resolveToolDefinition } = await import('../../src/background/tools/runtime.js');
  const forbidden = /\b(?:tabId|workingTab|workingTabId|isWorkingTab|use_tab|get_working_tab|inner|selector)\b/i;
  for (const language of ['zh-CN', 'en']) {
    const allowed = getToolSchemas({ language }).map(schema => schema.function).filter(tool => !isDriveToolForbidden(tool.name));
    assert.ok(allowed.length > 30);
    for (const tool of allowed) {
      assert.doesNotMatch(JSON.stringify(tool), forbidden, `${language}: ${tool.name}`);
      const declaration = resolveToolDefinition(tool.name, { language });
      assert.equal(declaration.parameters.properties.tabId, undefined, `${tool.name}: source schema`);
      assert.equal(declaration.parameters.properties.selector, undefined, `${tool.name}: source schema`);
      assert.doesNotMatch(JSON.stringify(driveToolSignature(tool)), forbidden, `${language}: ${tool.name}`);
      if (tool.name === 'run_script') {
        assert.equal(tool.parameters.properties.target, undefined);
        assert.equal(tool.parameters.properties.scope, undefined);
      }
    }
  }
});

test('real runtime and batch admission failures share ToolError and retain public recovery context', async () => {
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const { runDriveCalls } = await import('../../src/background/mcp/external-drive.js');
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, getTabAliases: () => ({ page: 5 }),
    resolveTargetTab: async ({ tabId }) => ({ ok: true, tabId, ownedByCurrentTask: true }),
  } });
  const context = { sessionId: 'surface', runId: 'opaque-surface-run', externalDrive: true };
  const calls = [
    { id: 'missing-page', name: 'read_dom', args: {} },
    { id: 'missing-alias', name: 'read_dom', args: { tabRef: 'missing' } },
    { id: 'stale-element', name: 'inspect_element', args: { tabRef: 'page', target: 'uid:t5.000000.999' } },
  ];
  const batch = await runDriveCalls(calls, {
    aliases: { page: 5 }, context, signal: new AbortController().signal,
    getBatchTabPolicy: (name, args) => runtime.getBatchTabPolicy(name, args, context),
    execute: (name, args, signal, current) => runtime.execute(name, args, signal, current),
  });
  assert.deepEqual(batch.results.map(row => row.result.code), ['TAB_REF_REQUIRED', 'BATCH_TAB_REFERENCE_ERROR', 'STALE_ELEMENT_UID']);
  for (const row of batch.results) {
    assert.equal(row.isError, true);
    assert.ok(Object.keys(row.result).every(key => ['code', 'message', 'hint', 'details'].includes(key)), JSON.stringify(row.result));
    assert.match(row.result.code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(typeof row.result.message, 'string');
    assertPublic(row.result);
  }
  assert.equal(batch.results[1].result.details.tabRef, 'missing');
  assert.equal(batch.results[2].result.details.target, 'uid:t5.000000.999');
  for (const externalDrive of [false, true]) for (const tabRef of [null, '  ']) {
    await assert.rejects(runtime.execute('read_dom', { tabRef }, undefined, { ...context, externalDrive }), error => {
      assert.equal(error.code, 'BATCH_TAB_REFERENCE_ERROR');
      assert.equal(error.details.reason, 'invalid_reference');
      assertPublic(error.details);
      return true;
    });
  }
  const invalidBatch = await runDriveCalls([null, '  '].map((tabRef, index) => ({ id: `invalid-${index}`, name: 'read_dom', args: { tabRef } })), {
    aliases: { page: 5 }, context, signal: new AbortController().signal,
    getBatchTabPolicy: (name, args) => runtime.getBatchTabPolicy(name, args, context),
    execute: (name, args, signal, current) => runtime.execute(name, args, signal, current),
  });
  assert.equal(invalidBatch.results.length, 2);
  assert.ok(invalidBatch.results.every(row => row.isError && row.result.code === 'BATCH_TAB_REFERENCE_ERROR'
    && row.result.details.reason === 'invalid_reference'));

});

test('page tools require a caller reference in every mode despite visible, previous, owned, or UID context', async () => {
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const { createToolRegistry } = await import('../../src/background/tools/registry.js');
  const resolved = [], executed = [];
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: createMemoryStorage() },
    tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Page', active: true }) } };
  const registry = createToolRegistry();
  registry.forCapability('explicit-reference')({ name: 'explicit_reference_probe', page: 'owned',
    parameters: { type: 'object', properties: {
      tabRef: { type: ['integer', 'string'] }, target: { type: 'string' },
    }, required: ['tabRef'] },
    execute: args => { executed.push(args); return { text: 'observed' }; },
  });
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, getTabAliases: () => ({ page: 5 }),
    resolveTargetTab: async input => { resolved.push(input); return { ok: true, tabId: input.tabId, ownedByCurrentTask: true }; },
  } });
  runtime.element.registerElementRef({ uid: 't5.000001.1', tabId: 5, sessionId: 'explicit-reference' });
  for (const externalDrive of [false, true]) {
    const context = { sessionId: 'explicit-reference', runId: externalDrive ? 'opaque-page-run' : 'drive-native-name', externalDrive,
      toolRegistrySnapshot: registry.snapshot(), workingTabId: 5,
      workingTab: { id: 5, url: 'https://previous.test/' }, activeTab: { id: 5 },
      dynamicContext: { userVisibleTab: { id: 5, active: true }, tabs: [{ id: 5, ownedByCurrentTask: true }] },
    };
    assert.deepEqual(await runtime.execute('explicit_reference_probe', { tabRef: 'page' }, undefined, context), { text: 'observed' });
    const count = resolved.length;
    for (const args of [{}, { target: 'css:body' }, { target: 'uid:t5.000001.1' }]) {
      await assert.rejects(runtime.execute('explicit_reference_probe', args, undefined, context), error => {
        assert.equal(error.code, 'TAB_REF_REQUIRED');
        assert.match(error.hint, /tabRef/);
        assertPublic(error.details);
        return true;
      });
    }
    assert.equal(resolved.length, count, 'missing references fail before ownership or content work');
  }
  assert.equal(executed.length, 2);
  assert.ok(executed.every(args => args.tabId === 5));
});

test('nested page tools require their own reference in native and drive execution', async () => {
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: createMemoryStorage() } };
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  let ownershipChecks = 0;
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, getTabAliases: () => ({ page: 5 }),
    resolveTargetTab: async () => { ownershipChecks++; assert.fail('missing nested targets fail before page access'); },
  } });
  for (const externalDrive of [false, true]) {
    const bridge = createRunScriptBridge({
      supervisor: { isRunCurrent: () => true, hasAgent: () => true, getAbortSignal: () => new AbortController().signal },
      getRuntime: () => ({ status: 'running', workingTabId: 5 }), isTerminalRuntimeForRun: () => false,
      getRunToolContext: async () => ({ externalDrive, workingTabId: 5, dynamicContext: { userVisibleTab: { id: 5 } } }),
      canManageSessions: async () => true, buildRunProfile: async () => ({}), toolRuntime: runtime, collectArtifacts: () => [],
    });
    const response = await bridge.handleToolCall({ sessionId: 'nested-ref', runId: 'opaque-nested-reference',
      toolName: 'read_dom', args: {} }, { tab: { id: 5 } });
    assert.equal(response.ok, false);
    assert.equal(response.isError, true);
    const result = response.result;
    assert.equal(result.code, 'TAB_REF_REQUIRED');
    assert.equal(typeof result.message, 'string');
    assert.match(result.hint, /tabRef/, JSON.stringify({ externalDrive, response }));
    assert.ok(Object.keys(result).every(key => ['code', 'message', 'hint', 'details'].includes(key)));
    assertPublic(result);
  }
  assert.equal(ownershipChecks, 0);
});

test('large ToolErrors retain their native contract instead of becoming truncation results', async () => {
  const { toolError } = await import('../../src/shared/contracts/tool-error.js');
  const failure = toolError('SCRIPT_EVALUATION_FAILED', 'Failure', {
    hint: 'Fix the script and retry.', details: { line: 2, trace: [{ message: 'x'.repeat(50000) }] },
  });
  assert.deepEqual(projectDriveResult(failure).value, failure);
});


test('real Skill discovery failures and URL image failures produce the same ToolError contract', async () => {
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: createMemoryStorage() } };
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const { runDriveCalls } = await import('../../src/background/mcp/external-drive.js');
  const runtime = createToolRuntime({ sessions: { isRunCurrent: () => true } });
  const context = { sessionId: 'skill-surface', runId: 'opaque-skill-surface-run', externalDrive: true };
  const cases = [
    ['load_skill', { name: 'missing-contract-skill' }, 'SKILL_NOT_FOUND'],
    ['load_skill_resource', { name: 'missing-contract-skill', path: 'missing.md' }, 'SKILL_NOT_FOUND'],
    ['load_skill_resource', { name: 'qingzhou-documents', path: 'missing-contract-resource.md' }, 'SKILL_RESOURCE_NOT_FOUND'],
  ];
  const assertFailure = failure => {
    assert.ok(Object.keys(failure).every(key => ['code', 'message', 'hint', 'details'].includes(key)), JSON.stringify(failure));
    assert.match(failure.code, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(typeof failure.message, 'string');
    assertPublic(failure);
  };
  for (const [name, args, code] of cases) {
    const failure = await runtime.execute(name, args, undefined, context);
    assertFailure(failure);
    assert.equal(failure.code, code);
    assert.match(failure.hint, code === 'SKILL_NOT_FOUND' ? /list_skills/ : /load_skill.*includeResources/);
    assert.equal(failure.details.name, args.name);
  }
  const calls = [
    { id: 'invalid-url', name: 'read_image', args: { url: 'not a URL' } },
    { id: 'unsupported-url', name: 'read_image', args: { url: 'ftp://example.org/image.png' } },
  ];
  const batch = await runDriveCalls(calls, {
    context, signal: new AbortController().signal,
    getBatchTabPolicy: (name, args) => runtime.getBatchTabPolicy(name, args, context),
    execute: (name, args, signal, current) => runtime.execute(name, args, signal, current),
  });
  assert.deepEqual(batch.results.map(row => row.result.code), ['INVALID_IMAGE_URL', 'UNSUPPORTED_IMAGE_URL_SCHEME']);
  for (const row of batch.results) { assert.equal(row.isError, true); assertFailure(row.result); }
});

test('business keys survive drive projection while owned presentation remains private', async () => {
  const { bindToolResultPresentation, getToolResultPresentation } = await import('../../src/shared/contracts/tool-result-presentation.js');
  const business = { nodes: [{ id: 1 }], snapshot: 'user snapshot', _display: 'user display', _debug: 'user debug',
    _rawCdp: 'user raw data', _plugin: { source: 'user' }, selector: 'inventory', tabId: 'business field' };
  const metadata = { _pageTitle: 'Observed page', _pageUrl: 'https://example.test/', _display: { type: 'native preview' } };
  const result = bindToolResultPresentation(structuredClone(business), metadata);
  assert.deepEqual(projectDriveResult(result).value, business);
  assert.deepEqual(getToolResultPresentation(result), metadata);
  assert.equal(Object.hasOwn(result, '_pageTitle'), false);
  assert.equal(Object.hasOwn(result, '_pageUrl'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), business);
});

test('nested mode comes from the trusted parent, and a host-rebuilt drive profile retains image tools', async () => {
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: createMemoryStorage() } };
  const { withToolCallLifecycle } = await import('../../src/background/tools/call-lifecycle.js');
  const { buildRunProfile } = await import('../../src/background/agent/run-profile.js');
  const { getToolSchemas } = await import('../../src/background/tools/runtime.js');
  const config = { provider: 'test', model: 'text-only', vision: false, toolCalling: true };
  const profileInputs = [], observed = [];
  let latestSkillSnapshot = { version: 1 };
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => true, getAbortSignal: () => new AbortController().signal },
    getRuntime: () => ({ status: 'running' }), isTerminalRuntimeForRun: () => false,
    canManageSessions: async () => false,
    // The trusted fallback disagrees with the drive parent; parent authority must win.
    getRunToolContext: async sessionId => ({ externalDrive: sessionId === 'metadata-drive', skillToolRegistrySnapshot: latestSkillSnapshot }),
    buildRunProfile: async input => {
      profileInputs.push(input);
      return buildRunProfile({ ...input, config, platformInfo: { os: 'linux' } });
    },
    toolRuntime: {
      resolveDefinition: () => ({ behavior: {} }),
      getSchemas: context => getToolSchemas({ runProfile: context.runProfile }),
      execute: async (name, args, _signal, context) => {
        observed.push({ name, args, context });
        if (name === 'list_tools') return { tools: getToolSchemas({ runProfile: context.runProfile }).map(schema => schema.function) };
        if (name === 'load_skill') { latestSkillSnapshot = { version: 2 }; return { name: 'newly-loaded' }; }
        return { accepted: true };
      },
    },
    collectArtifacts: () => [],
  });
  await withToolCallLifecycle({ sessionId: 'parent-drive', runId: 'opaque-parent-run', externalDrive: true, skillToolRegistrySnapshot: { version: 0 } }, async parent => {
    const base = { sessionId: parent.sessionId, runId: parent.runId, parentCallId: parent.toolExecutionId, externalDrive: false };
    const forbidden = await bridge.handleToolCall({ ...base, toolName: 'ask_llm', args: { prompt: 'no' } });
    assert.equal(forbidden.code, 'DRIVE_TOOL_FORBIDDEN');
    const missing = await bridge.handleToolCall({ ...base, toolName: 'read_dom', args: {} });
    assert.equal(missing.code, 'TAB_REF_REQUIRED');
    const accepted = await bridge.handleToolCall({ ...base, toolName: 'read_dom', args: { tabRef: 'page' } });
    assert.equal(accepted.ok, true);
    assert.equal(observed.at(-1).context.externalDrive, true);
    assert.equal(observed.at(-1).context.runId, 'opaque-parent-run');
    const loaded = await bridge.handleToolCall({ ...base, toolName: 'load_skill', args: { name: 'newly-loaded' } });
    assert.equal(loaded.ok, true);
    assert.equal(observed.at(-1).context.skillToolRegistrySnapshot.version, 1, 'live registry supersedes the parent snapshot');
    await bridge.handleToolCall({ ...base, toolName: 'read_dom', args: { tabRef: 'page' } });
    assert.equal(observed.at(-1).context.skillToolRegistrySnapshot.version, 2, 'the same parent sees a newly loaded Skill');
  });
  await withToolCallLifecycle({ sessionId: 'parent-native', runId: 'drive-native-looking-run', externalDrive: false }, async parent => {
    const accepted = await bridge.handleToolCall({ sessionId: parent.sessionId, runId: parent.runId,
      parentCallId: parent.toolExecutionId, externalDrive: true, toolName: 'ask_llm', args: { prompt: 'allowed natively' } });
    assert.equal(accepted.ok, true);
    assert.equal(observed.at(-1).context.externalDrive, false, 'page messages cannot manufacture drive authority');
  });
  const listed = await bridge.handleToolCall({ sessionId: 'metadata-drive', runId: 'another-opaque-run',
    externalDrive: false, toolName: '__list_tools__' });
  assert.equal(listed.ok, true);
  assert.equal(profileInputs.at(-1).externalDrive, true);
  assert.ok(listed.result.tools.some(tool => tool.name === 'screenshot'), 'trusted drive metadata keeps images with vision:false');
  const native = await bridge.handleToolCall({ sessionId: 'metadata-native', runId: 'drive-not-a-mode',
    externalDrive: true, toolName: '__list_tools__' });
  assert.equal(native.ok, true);
  assert.equal(profileInputs.at(-1).externalDrive, false);
  assert.ok(!native.result.tools.some(tool => tool.name === 'screenshot'));
});


test('trusted drive admission records one failure even if profile rebuilding fails', async () => {
  const cards = [];
  let executed = false;
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => false, getAbortSignal: () => new AbortController().signal },
    getRuntime: () => ({ status: 'running' }), isTerminalRuntimeForRun: () => false,
    canManageSessions: async () => false,
    getRunToolContext: async () => ({ externalDrive: true }),
    buildRunProfile: async () => { throw new Error('Cannot rebuild profile'); },
    recordNestedTool: async event => { if (event.phase === 'end') cards.push(event); },
    toolRuntime: { resolveDefinition: () => ({ behavior: {} }), getSchemas: () => [],
      execute: async () => { executed = true; throw new Error('must not execute'); } },
    collectArtifacts: () => [],
  });
  const result = await bridge.handleToolCall({ sessionId: 'drive-profile-failure', runId: 'opaque-profile-run',
    externalDrive: false, toolName: 'read_dom', args: { tabRef: 'page' } });
  assert.equal(result.code, 'RUN_SCRIPT_TOOL_CALL_FAILED');
  assert.ok(result.message);
  assert.equal(executed, false);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].isError, true);
  assert.equal(cards[0].runId, 'opaque-profile-run');
});

test('public error details preserve recovery data and authored payloads without execution internals', async () => {
  const { toolError } = await import('../../src/shared/contracts/tool-error.js');
  const value = { selector: 'business selector', tabId: 'business identifier', sessionId: 'business session' };
  const schema = { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'string' } } };
  const trace = [{ message: 'Business trace', value }];
  const publicDetails = { tabRef: 'shop', target: 'uid:t5.000001.1', line: 2, column: 4,
    requestId: 'request-1', table: 'inventory', value, schema, trace };
  const failure = toolError('recovery_needed', 'Choose the public reference', { hint: 'Refresh and retry.', details: {
    ...publicDetails, sessionId: 'private-session', refSessionId: 'private-owner', runId: 'private-run',
    tabId: 5, expectedTabRef: 9, method: 'DOM.resolveNode', engine: 'cdp',
    originalCode: 'private-code', originalMessage: 'private-message', unknown: 'not public', index: 'wrong type',
  } });
  assert.deepEqual(failure, { code: 'RECOVERY_NEEDED', message: 'Choose the public reference', hint: 'Refresh and retry.', details: publicDetails });
  assert.equal(failure.details.value, value);
  assert.equal(failure.details.schema, schema);
  assert.equal(failure.details.trace, trace);
});

test('runtime preserves the caller reference through real Content failures and omits an unknown reference', async () => {
  const { createToolRuntime, sendToContent } = await import('../../src/background/tools/runtime.js');
  const { createToolRegistry } = await import('../../src/background/tools/registry.js');
  globalThis.chrome = { runtime: { getURL: path => path }, storage: { local: createMemoryStorage() }, tabs: {
    get: async id => ({ id, url: 'https://example.test/', status: 'complete', title: 'Page' }),
    sendMessage: async (_tabId, message) => {
      if (message.action === 'ping') return { ok: true, url: 'https://example.test/', contentType: 'text/html', elementRefs: 1 };
      throw new Error('Content connection was lost');
    },
  } };
  const registry = createToolRegistry();
  const received = [];
  registry.forCapability('caller-reference')({ name: 'caller_reference_probe', page: 'tab',
    parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] } } },
    execute: async (args, _signal, context) => {
      received.push({ tabId: args.tabId, requestedTabRef: context.requestedTabRef });
      return sendToContent(args.tabId, 'probe', {}, context);
    },
  });
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, getTabAliases: () => ({ shop: 5, alternative: 5 }),
    resolveTargetTab: async ({ tabId }) => ({ ok: true, tabId, ownedByCurrentTask: true }),
  } });
  const context = { sessionId: 'caller-reference', runId: 'opaque-caller-run', externalDrive: true, toolRegistrySnapshot: registry.snapshot() };
  for (const requested of ['shop', 'alternative', '005', 5]) {
    await assert.rejects(runtime.execute('caller_reference_probe', { tabRef: requested }, undefined, context), error => {
      assert.equal(error.code, 'CONTENT_SCRIPT_MESSAGE_FAILED');
      assert.equal(error.details.tabRef, requested);
      assert.equal(Object.hasOwn(error.details, 'tabId'), false);
      return true;
    });
    assert.deepEqual(received.at(-1), { tabId: 5, requestedTabRef: requested });
  }
  await assert.rejects(runtime.execute('caller_reference_probe', { tabId: 5 }, undefined, context), error => {
    assert.equal(error.code, 'CONTENT_SCRIPT_MESSAGE_FAILED');
    assert.equal(Object.hasOwn(error.details, 'tabRef'), false, 'an internal id must not become a made-up public reference');
    return true;
  });
});

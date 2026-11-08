import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRuntime } from '../../src/background/mcp/mcp-runtime.js';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';
import { withToolCallLifecycle } from '../../src/background/tools/call-lifecycle.js';
import { createSessionTranscript } from '../../src/background/session/transcript.js';
import { createSessionRecord } from '../../src/shared/session/session-codec.js';
import { createSessionNavigationFeature } from '../../src/sidepanel/features/sessions/session-navigation-feature.js';
import { createSessionState } from '../../src/sidepanel/features/sessions/session-state.js';
import { createTranscriptProjection } from '../../src/sidepanel/features/chat/transcript/projection.js';
import { toolPresentationRegistry } from '../../src/sidepanel/tools/tool-presentation.js';
import { createToolArgsPreview } from '../../src/sidepanel/tools/tool-args-preview.js';

function fixture() {
  const metadata = {}, runtimes = {}, stored = {}, aliases = {}, pages = new Map(), events = [];
  const pageContexts = new WeakMap();
  const observed = (result, tabId) => { pageContexts.set(result, pages.get(tabId) || {}); return result; };
  let nextTab = 0, runtime, bridge;
  const supervisor = {
    peekEntry: () => null, getRuntime: id => runtimes[id], getAbortSignal: () => null, hasAgent: () => false,
    mintDriveRunId: () => 'opaque-stable-run', takeDriveRunForRelease: () => '',
    isRunCurrent: (_id, runId) => runId === 'opaque-stable-run',
  };
  const transcriptOptions = {
    repository: { readRecord: async id => stored[id], readActiveConversation: async () => null },
    supervisor, normalizeSessionId: String, getLiveAgentEntry: async () => null,
    resolveToolDefinition: () => null, getToolIdentity: () => ({}),
  };
  const transcript = createSessionTranscript(transcriptOptions);
  const toolRuntime = {
    getToolResultPageContext: result => pageContexts.get(result) || {},
    getSchemas: () => [], getTabAliases: () => aliases, resolveDefinition: () => ({ behavior: {} }),
    getModelPolicy: name => name === 'run_script' ? { preserveResult: true, scriptResult: 'value' } : null,
    getBatchTabPolicy: name => name === 'open_tab' ? { kind: 'create' }
      : name === 'run_script' ? { kind: 'script' } : name === 'read_article' ? { kind: 'target', implicit: false } : null,
    async execute(name, args, signal, context) {
      if (name === 'open_tab') {
        const tabId = ++nextTab;
        aliases[args.tabAlias] = tabId;
        pages.set(tabId, { _pageTitle: `Page ${args.tabAlias}`, _pageUrl: args.url });
        return observed({ tabRef: args.tabAlias || tabId, title: `Page ${args.tabAlias}`, url: args.url, active: false }, tabId);
      }
      if (name === 'wait') return { waited: true };
      const tabId = args.tabId || aliases[args.tabRef];
      if (name === 'run_script') return withToolCallLifecycle({ ...context, signal }, async parent => {
        for (const [toolName, nestedArgs] of args.steps || []) {
          await bridge.handleToolCall({ sessionId: context.sessionId, runId: context.runId,
            parentCallId: parent.toolExecutionId, toolName, args: nestedArgs });
        }
        context.resultPresentation._display = { script: { valueOnly: true, trace: [] } };
        return observed({ title: 'user data, not page title' }, aliases[args.steps?.[0]?.[1]?.tabRef]);
      });
      if (args.fail) throw Object.assign(new Error('synthetic failure'), { code: 'TEST_FAILURE' });
      return observed({ text: 'Article' }, tabId);
    },
  };
  runtime = createMcpRuntime({
    sessions: {
      supervisor, listMetadata: async () => metadata,
      createMetadata: async input => { metadata[input.id] = input; },
      setRuntime: (id, patch) => { runtimes[id] = { ...runtimes[id], ...patch }; }, getRuntime: id => runtimes[id] || {},
      recordToolEvent: event => { events.push(event); transcript.recordEvent(event.sessionId, event); },
      persistTranscript: async id => { stored[id] = structuredClone(createSessionRecord(null, await transcript.get(id))); },
    },
    tools: { runtime: toolRuntime, canManageSessions: async () => false, buildRunProfile: async () => ({}), loadedSkillNames: () => [], recordLoadedSkillNames() {} },
    skills: {}, artifacts: {}, trace: {}, userInputPermissions: {}, async dispatchSidepanel() {},
  });
  bridge = createRunScriptBridge({
    supervisor, getRuntime: id => runtimes[id], canManageSessions: async () => false, buildRunProfile: async () => ({}),
    getRunToolContext: async id => ({ externalDrive: metadata[id]?.source === 'external-drive' }),
    toolRuntime, collectArtifacts: () => [], recordNestedTool: input => runtime.recordNestedTool(input),
  });
  return { runtime, bridge, transcript, transcriptOptions, events };
}

test('single-call preflight failures each produce one persistent failed card', async () => {
  const f = fixture();
  const { sessionId } = await f.runtime.createDriveSession({ title: "Inspect example page" });
  for (const [name, args] of [['act_on_screen', { action: 'press', key: 'Escape', returnScreenshot: false }], ['collect_images', { table: 'test', targets: ['css:img'] }]]) {
    await assert.rejects(f.runtime.executeTool({ sessionId, name, args }), { code: 'TAB_REF_REQUIRED' });
  }
  const history = await f.transcript.get(sessionId);
  assert.deepEqual(history.map(row => row.name), ['act_on_screen', 'collect_images']);
  assert.ok(history.every(row => row.isError && row.result.code === 'TAB_REF_REQUIRED'));
  assert.equal(new Set(history.map(row => row.toolCallId)).size, 2);
  assert.equal((await createSessionTranscript(f.transcriptOptions).hydrate(sessionId)).length, 2);
});

test('drive cards preserve every call across batches, duplicate correlation IDs, nested calls and reload', async () => {
  const f = fixture();
  const { sessionId } = await f.runtime.createDriveSession({ title: "Inspect example page" });
  for (const alias of ['a', 'b', 'c']) {
    const result = await f.runtime.executeTool({ sessionId, calls: [
      { id: 'open', name: 'open_tab', args: { url: `https://example.test/${alias}`, tabAlias: alias } },
      { id: 'read', name: 'read_article', args: { tabRef: alias } },
    ] });
    assert.deepEqual(result.results.map(row => row.id), ['open', 'read'], 'response correlation stays unchanged');
  }
  await f.runtime.executeTool({ sessionId, calls: ['a', 'b'].map(tabRef => ({ id: 'same', name: 'read_article', args: { tabRef } })) });
  const script = await f.runtime.executeTool({ sessionId, name: 'run_script', scriptApiVersion: 2, args: { timeout: 10, code: 'async () => {}', steps: [
    ['read_article', { tabRef: 'a' }], ['read_article', { tabRef: 'b' }],
    ['wait', { seconds: 0 }], ['read_article', { tabRef: 'a', fail: true }],
    ['read_article', {}],
  ] } });
  assert.deepEqual(script.result, { ok: true, result: { title: 'user data, not page title' }, trace: [] }, 'UI metadata must not change the model response');
  const history = await f.transcript.get(sessionId);
  assert.equal(history.length, 14, '8 batch calls + 5 nested invocations + parent script');
  assert.equal(new Set(history.map(row => row.toolCallId)).size, 14);
  assert.ok(history.every(row => row.runId === 'opaque-stable-run'), 'do not rotate the execution run to fix display identity');
  assert.deepEqual(history.slice(0, 6).map(row => row.name), ['open_tab', 'read_article', 'open_tab', 'read_article', 'open_tab', 'read_article']);
  assert.equal(history.at(-3).isError, true);
  assert.equal(history.at(-2).isError, true);
  assert.equal(history.at(-1).result._pageTitle, 'Page a');
  assert.equal(history.at(-1).args.tabRef, undefined, 'outer scripts leave page references to their child calls');
  assert.equal(history[1].args.tabRef, 'a', 'batch display keeps the requested alias, not resolved internal arguments');
  const replay = f.events.at(-1);
  f.transcript.recordEvent(sessionId, replay);
  assert.equal((await f.transcript.get(sessionId)).length, 14, 'replaying one event must still deduplicate');
  const restored = await createSessionTranscript(f.transcriptOptions).hydrate(sessionId);
  assert.equal(restored.length, 14);
  assert.deepEqual(restored.map(row => row.toolCallId), history.map(row => row.toolCallId));

  const projection = createTranscriptProjection({ groupTools: () => false });
  const cards = projection.uiHistory(restored, { sessionId });
  projection.assignKeys(sessionId, cards);
  assert.equal(cards.length, 14, 'direct drive bypasses ordinary wait filtering as well as grouping');
  assert.ok(cards.every(card => card.type === 'tool'));
  assert.equal(new Set(cards.map(card => card._uiKey)).size, 14);
  const hidden = { type: 'tool', name: 'image_assets', toolCallId: 'legacy-hidden', runId: 'opaque-stable-run' };
  assert.equal(projection.uiHistory([...restored, hidden], { sessionId }).length, 15, 'even ordinary hidden entries stay visible in drive');
});

test('evaluate labels use host page metadata or explicit tabRef independently of run identity', () => {
  const preview = createToolArgsPreview({});
  for (const runId of ['opaque-script-run', 'drive-native-identifier']) {
    const tool = { name: 'evaluate', runId };
    assert.equal(toolPresentationRegistry.project('argsSummary', tool, { tabRef: 'a' }, { _pageTitle: 'Actual page', result: { title: 'Other' } }), '(Actual page)');
    assert.match(toolPresentationRegistry.project('argsSummary', tool, { tabRef: 'bdb' }, { ok: true, result: { title: 'Not a page', url: 'https://wrong.test/' } }), /bdb/);
    assert.equal(toolPresentationRegistry.project('argsSummary', tool, { tabRef: 'bdb' }, { _pageUrl: 'https://actual.test/', result: { title: 'Not a page' } }), '(https://actual.test/)');
    assert.match(toolPresentationRegistry.project('argsSummary', tool, { tabRef: 17 }, {}), /17/);
    assert.equal(toolPresentationRegistry.project('argsSummary', tool, {}, {}), '');
    assert.equal(toolPresentationRegistry.project('argsSummary', tool, {}, { details: { _pageTitle: 'Historical page' } }), '(Historical page)');
    assert.equal(toolPresentationRegistry.project('argsSummary', tool, {}, { title: 'User title', url: 'https://user-data.test/' }), '');
    assert.equal(toolPresentationRegistry.project('argsSummary', { name: 'run_script', runId }, {}, { _pageTitle: 'Nested page' }), '',
      'outer orchestration has no execution page label');
    for (const result of [null, { _pageTitle: 'Nested page' }]) {
      assert.equal(preview.format({ timeout: 10, code: 'return 42;' }, '', { name: 'run_script', runId }, result), '',
        'outer scripts suppress generic argument previews, including their source code');
    }
  }
});

test('restoring a drive session hydrates its source before chrome and transcript projection', async () => {
  const previousChrome = globalThis.chrome;
  const gate = Promise.withResolvers();
  globalThis.chrome = { storage: { local: { get: () => gate.promise } } };
  try {
    for (const cancelled of [false, true]) {
      const state = createSessionState();
      let current = null, epoch = 0, synced = 0;
      const navigation = createSessionNavigationFeature({
        getCurrentSessionId: () => current, setCurrentSessionIdValue: id => { current = id; },
        getSessionSwitchEpoch: () => epoch, incrementSessionSwitchEpoch: () => ++epoch,
        getCurrentTab: () => '', chatTab: 'chat', transcriptRenderer: {},
        mergeSessionRecord: record => state.mergeRecord(record),
        syncExternalDriveChrome: () => { assert.equal(state.getRecord(current).source, 'external-drive'); synced++; },
      });
      const pending = navigation.transitionToSession('drive');
      if (cancelled) epoch++;
      gate.resolve({ _sessions: { drive: { id: 'drive', source: 'external-drive' } } });
      assert.equal(await pending, !cancelled);
      assert.equal(synced, cancelled ? 0 : 1);
      assert.equal(Boolean(state.getRecord('drive')), !cancelled);
    }
  } finally { globalThis.chrome = previousChrome; }
});

test('settled script parents and stopped drive sessions cannot publish late nested cards', async () => {
  const f = fixture();
  const { sessionId } = await f.runtime.createDriveSession({ title: "Inspect example page" });
  let parentCallId;
  await withToolCallLifecycle({ sessionId, runId: 'opaque-stable-run', externalDrive: true }, parent => { parentCallId = parent.toolExecutionId; });
  const stale = await f.bridge.handleToolCall({ sessionId, runId: 'opaque-stable-run', parentCallId, toolName: 'wait', args: { seconds: 0 } });
  assert.equal(stale.code, 'RUN_STOPPED');
  f.runtime.drive.noteStopped(sessionId);
  await f.runtime.recordNestedTool({ sessionId, runId: 'opaque-stable-run', name: 'wait', args: {}, result: {}, isError: false });
  assert.equal(f.events.length, 0);
});

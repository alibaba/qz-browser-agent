import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { bindCreatedTabResult } from '../../src/shared/contracts/page-observation.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
globalThis.chrome = {};
const { getParallelReadTab, getBatchTabPolicy, createToolRuntime } = await import('../../src/background/tools/runtime.js');
const { t: toolT } = await import('../../src/background/tools/messages.js');
const { withLanguage } = await import('../../src/shared/i18n/index.js');
const namedIdentity = name => ({ name, title: { read_article: 'Read article', open_tab: 'Open tab' }[name] || name, familyId: 'tabs', familyTitle: 'Tabs' });
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const open = (id, tabAlias) => call(id, 'open_tab', { url: `https://${id}.test/`, ...(tabAlias == null ? {} : { tabAlias }) });
const read = (id, tabRef, extra = {}) => call(id, 'read_article', { limit: 3000, ...(tabRef == null ? {} : { tabRef }), ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(execute = null) {
  const calls = [], events = [];
  let nextTab = 100;
  const agent = new Agent('batch', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab, getBatchTabPolicy,
    async commitToolResult() {}, async discardToolResult() {},
    async execute(name, args, signal, context) {
      calls.push({ name, args, signal, context });
      if (execute) return execute(name, args, signal, context);
      if (name === 'open_tab') {
        const id = ++nextTab;
        return bindCreatedTabResult({ tabRef: args.tabAlias || id }, id);
      }
      return { text: `page ${args.tabId}` };
    },
  } }));
  agent._emit = event => events.push(event);
  return { agent, calls, events, run: (items, signal = new AbortController().signal) => agent._executeToolCalls(items, signal),
    ends: () => events.filter(event => event.type === 'tool_execution_end') };
}

test('direct runtime calls reject unresolved references and publish the unified model schema', async () => {
  const runtime = createToolRuntime();
  await assert.rejects(runtime.execute('read_article', { tabRef: 'a', limit: 3000 }), { code: 'BATCH_TAB_REFERENCE_ERROR' });
  for (const language of ['en', 'zh-CN']) {
    const schemas = runtime.getSchemas({ language });
    const open = schemas.find(schema => schema.function.name === 'open_tab').function;
    const read = schemas.find(schema => schema.function.name === 'read_article').function;
    assert.equal(open.parameters.properties.tabAlias.type, 'string');
    assert.deepEqual(read.parameters.properties.tabRef.type, ['integer', 'string']);
    assert.equal(read.parameters.properties.tabId, undefined);
    assert.match(open.description, /tabAlias/); assert.match(open.description, /tabRef/);
    assert.match(read.parameters.properties.tabRef.description, /alias|别名/);
    assert.doesNotMatch(read.parameters.properties.tabRef.description, /\btabId\b/);
    const close = schemas.find(schema => schema.function.name === 'close_tab').function;
    assert.equal(close.parameters.required.includes('tabId'), false);
    assert.equal(runtime.resolveDefinition('close_tab').parameters.required.includes('tabRef'), true);
  }
  assert.equal(getBatchTabPolicy('plugin_open', { tabAlias: 'a' }), null);
});

test('resolved targets, final events and messages retain original call order', async () => {
  const f = fixture(), input = [open('oa', 'a'), open('ob', 'b'), read('ra', 'a'), read('rb', 'b')];
  const messages = await f.run(input);
  assert.deepEqual(f.calls.map(c => c.context.toolCallId), input.map(c => c.id));
  assert.deepEqual(f.calls.slice(2).map(c => c.args.tabId), [101, 102]);
  assert.deepEqual(f.calls.slice(2).map(c => c.args.tabRef), ['a', 'b']);
  assert.deepEqual(messages.map(m => m.tool_call_id), input.map(c => c.id));
  assert.deepEqual(f.ends().map(e => e.toolCallId), input.map(c => c.id));
  for (const call of input) assert.deepEqual(f.events.filter(e => e.toolCallId === call.id).map(e => e.type),
    ['tool_execution_start', 'tool_execution_end']);
});

test('multiple new pages never supply an implicit target to a later page call', async () => {
  const runtime = createToolRuntime();
  let nextTab = 100;
  const f = fixture((name, args, signal, context) => {
    if (name === 'open_tab') {
      const id = ++nextTab;
      return bindCreatedTabResult({ tabRef: id, url: args.url, title: 'Page', active: false }, id);
    }
    return runtime.execute(name, args, signal, context);
  });
  await f.run([open('oa'), open('ob'), read('ra'), read('rb')]);
  assert.ok(f.ends().slice(2).every(event => event.isError && event.result.code === 'TAB_REF_REQUIRED'));
  assert.ok(f.ends().slice(2).every(event => !event.result.details?.tabRef));
});

for (const [name, input, reason] of [
  ['duplicate aliases', [open('oa', 'same'), open('ob', 'same'), read('r', 'same')], 'duplicate_alias'],
  ['unknown reference', [read('r', 'missing')], 'no_alias'],
  ['forward reference', [read('r', 'a'), open('o', 'a')], 'forward_reference'],
  ['conflicting tabId', [open('o', 'a'), read('r', 'a', { tabId: 99 })], 'conflicting_target'],
  ['invalid alias', [open('o', 'has spaces')], 'invalid_alias'],
  ['untrusted creator', [call('o', 'plugin_open', { tabAlias: 'a' })], 'invalid_alias'],
]) test(`${name} becomes a per-call error`, async () => {
  const f = fixture(); await f.run(input);
  const failed = f.ends().find(e => e.isError);
  assert.equal(failed.result.details.reason, reason);
  assert.equal(f.calls.filter(c => c.name === 'read_article').length, 0);
});

for (const outcome of ['failed', 'effects', 'error-flag', 'not-ok']) test(`a ${outcome} producer fails its dependent while independent pages proceed`, async () => {
  const f = fixture(async (name, args) => {
    if (name !== 'open_tab') return { tabId: args.tabId };
    if (args.tabAlias === 'good') return { id: 2 };
    if (outcome === 'failed') throw Object.assign(new Error('Navigation failed'), { code: 'NAVIGATION_FAILED' });
    return { id: 1, ...(outcome === 'incomplete' ? { incomplete: { reason: 'timeout' } } : {}),
      ...(outcome === 'error-flag' ? { isError: true } : {}), ...(outcome === 'not-ok' ? { ok: false } : {}) };
  });
  if (outcome === 'effects') f.agent._applyToolResultEffects = async (_name, result) => { if (result.id === 1) throw new Error('effects failed'); return []; };
  await f.run([open('bad', 'bad'), open('good', 'good'), read('rb', 'bad'), read('rg', 'good')]);
  if (outcome !== 'effects') assert.deepEqual(f.calls.filter(c => c.name === 'read_article').map(c => c.args.tabId), [2]);
  assert.equal(f.ends().find(e => e.toolCallId === 'rb').result.code, 'BATCH_TAB_DEPENDENCY_FAILED');
  assert.equal(f.ends().find(e => e.toolCallId === 'rg').isError, false);
});

test('creators wait for an earlier numeric target to publish their window anchor', async () => {
  let release;
  const f = fixture(async (name, args) => {
    if (name === 'read_article') { await new Promise(resolve => { release = resolve; }); return { tabId: args.tabId }; }
    return { id: args.tabAlias === 'a' ? 101 : 102 };
  });
  const pending = f.run([read('existing', undefined, { tabId: 9 }), open('oa', 'a'), open('ob', 'b')]);
  await tick(); assert.deepEqual(f.calls.map(c => c.name), ['read_article']);
  release(); await pending;
  assert.ok(f.calls.slice(1).every(c => !Object.hasOwn(c.context, 'workingTabId')));
});

test('bindings expire at the response boundary', async () => {
  const f = fixture(); await f.run([open('o', 'a')]); await f.run([read('r', 'a')]);
  assert.equal(f.ends().at(-1).result.details.reason, 'no_alias'); assert.equal(f.calls.length, 1);
});

for (const name of ['navigate', 'close_tab']) test(`a known dependency supplies a numeric target to ${name}`, async () => {
  const f = fixture(); await f.run([open('o', 'a'), call('n', name, { tabRef: 'a', url: 'https://next.test/' }), read('r', 'a')]);
  assert.deepEqual(f.calls.map(c => c.context.toolCallId), ['o', 'n', 'r']);
  assert.deepEqual(f.calls.slice(1).map(c => c.args.tabId), [101, 101]);
});

test('stop settles started producers without launching dependent reads', async () => {
  const controller = new AbortController();
  const f = fixture(async (_name, _args, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('stopped'), { code: 'OPERATION_ABORTED' });
  });
  const run = f.run([open('o', 'a'), open('next', 'b'), read('r', 'a')], controller.signal);
  await tick(); controller.abort(); const messages = await run;
  assert.deepEqual(f.calls.map(c => c.context.toolCallId), ['o', 'next']);
  assert.deepEqual(messages.map(m => m.tool_call_id), ['o', 'next', 'r']);
  assert.ok(f.ends().every(e => e.result.code === 'OPERATION_ABORTED'));
});

test('a dependency-skipped page call keeps its resolved tool identity in events', async () => {
  const f = fixture(async name => {
    if (name === 'open_tab') throw Object.assign(new Error('Navigation failed'), { code: 'NAVIGATION_FAILED' });
    return { tabId: 1 };
  });
  f.agent._tools.getIdentity = namedIdentity;
  await f.run([open('o', 'a'), read('r', 'a')]);
  const end = f.ends().find(e => e.toolCallId === 'r');
  assert.equal(end.result.code, 'BATCH_TAB_DEPENDENCY_FAILED');
  for (const event of f.events.filter(e => e.toolCallId === 'r')) {
    assert.equal(event.toolTitle, 'Read article');
    assert.equal(event.toolFamilyId, 'tabs');
    assert.equal(event.toolFamilyTitle, 'Tabs');
  }
});

test('an unresolved reference keeps its tool identity without executing', async () => {
  const f = fixture();
  f.agent._tools.getIdentity = namedIdentity;
  await f.run([read('r', 'missing')]);
  const end = f.ends().find(e => e.toolCallId === 'r');
  assert.equal(end.result.details.reason, 'no_alias');
  assert.equal(end.toolTitle, 'Read article');
  assert.equal(end.toolFamilyId, 'tabs');
  assert.equal(f.events.find(e => e.type === 'tool_execution_start' && e.toolCallId === 'r').toolTitle, 'Read article');
});

test('a call cancelled by stop keeps its tool identity', async () => {
  const controller = new AbortController();
  const f = fixture(async (_name, _args, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('stopped'), { code: 'OPERATION_ABORTED' });
  });
  f.agent._tools.getIdentity = namedIdentity;
  const run = f.run([open('o', 'a'), read('r', 'a')], controller.signal);
  await tick(); controller.abort(); await run;
  const end = f.ends().find(e => e.toolCallId === 'r');
  assert.equal(end.result.code, 'OPERATION_ABORTED');
  assert.equal(end.toolTitle, 'Read article');
  assert.equal(end.toolFamilyId, 'tabs');
});

test('dependency and reference failure messages name the tabRef', async () => {
  const f = fixture(async name => {
    if (name === 'open_tab') throw Object.assign(new Error('Navigation failed'), { code: 'NAVIGATION_FAILED' });
    return { tabId: 1 };
  });
  await f.run([open('o', 'a'), read('r', 'a'), read('u', 'missing')]);
  const dependency = f.ends().find(e => e.toolCallId === 'r');
  assert.equal(dependency.result.code, 'BATCH_TAB_DEPENDENCY_FAILED');
  assert.match(dependency.result.message, /「a」|"a"/);
  assert.ok(!dependency.result.message.includes('{tabRef}'));
  const reference = f.ends().find(e => e.toolCallId === 'u');
  assert.equal(reference.result.code, 'BATCH_TAB_REFERENCE_ERROR');
  assert.equal(reference.result.details.reason, 'no_alias');
  assert.match(reference.result.message, /还没有页面别名|no page alias yet/);
});

test('batch tab messages interpolate tabRef and differ by reference reason', () => {
  for (const language of ['en', 'zh-CN']) {
    const text = withLanguage(language, () => toolT('batchTabDependencyFailed', { tabRef: 'a' }));
    assert.ok(text.includes('a') && !text.includes('{tabRef}'), language);
  }
  const keys = ['batchTabReferenceUnknownReference', 'batchTabReferenceDuplicateAlias', 'batchTabReferenceForwardReference',
    'batchTabReferenceInvalidAlias', 'batchTabReferenceInvalidReference', 'batchTabReferenceAmbiguousTarget', 'batchTabReferenceOutsideBatch', 'batchTabReferenceNoAlias'];
  for (const language of ['en', 'zh-CN']) {
    const texts = keys.map(key => withLanguage(language, () => toolT(key, { tabRef: 'x' })));
    assert.equal(new Set(texts).size, keys.length, language);
    for (const text of texts) assert.ok(!text.includes('{tabRef}'), `${language}: ${text}`);
  }
  const noAlias = {
    'zh-CN': withLanguage('zh-CN', () => toolT('batchTabReferenceNoAlias', { tabRef: 'x' })),
    en: withLanguage('en', () => toolT('batchTabReferenceNoAlias', { tabRef: 'x' })),
  };
  assert.match(noAlias['zh-CN'], /还没有页面别名/);
  assert.match(noAlias.en, /no page alias yet/);
  assert.doesNotMatch(noAlias['zh-CN'], /省略 tabRef|--session/);
  assert.doesNotMatch(noAlias.en, /omit tabRef|--session/i);
});

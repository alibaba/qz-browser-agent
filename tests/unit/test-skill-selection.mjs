import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { selectSkillResults } from '../../src/background/skills/skill-selection.js';
import { parseSkillManifest } from '../../src/shared/skills/skill-manifest.js';
import { QINGZHOU_SKILL_SCHEMA_VERSION } from '../../src/shared/skills/skill-utils.js';
import { withLanguage } from '../../src/shared/i18n/index.js';
import { issueToolEffects, consumeToolEffects } from '../../src/background/tools/effects.js';

const renderer = { type: 'selection', title: 'Choose opportunities', itemsPath: 'jobs', itemIdPath: 'key',
  itemTitlePath: 'company', itemSubtitlePath: 'role', itemMeta: [{ label: 'Location', path: 'location' }],
  itemImagePath: 'image', urlPath: 'url', submitLabel: 'Research selected jobs' };
const jobs = [{ key: 'job-a', company: 'Northstar', role: 'Backend engineer', location: 'Remote · Europe',
  image: 'https://example.test/logo.png', url: 'https://example.test/jobs/a', stack: ['TypeScript'] },
{ key: 'job-b', company: 'Harbor', role: 'Platform engineer', location: 'London', url: 'javascript:alert(1)' }];
const context = { sessionId: 'selection-session', runId: 'selection-run', toolCallId: 'selection-call', language: 'en' };
const metadata = { id: 'selection-example', runtime: 'inner', renderer };
const result = () => ({ ok: true, hasResult: true, result: { jobs: structuredClone(jobs), _plugin: metadata }, _plugin: metadata });
const selected = ids => ({ submitted: true, answers: { selectedIds: ids } });

test('maps declared paths to cards, preserves provenance and effects, returns only chosen source rows', async () => {
  const input = result();
  const controller = new AbortController();
  issueToolEffects(input, [{ type: 'context.siteChanged' }], context);
  const output = await selectSkillResults(renderer, input, controller.signal, context, async (name, args, signal, passed) => {
    assert.equal(name, 'ask_user'); assert.equal(signal, controller.signal); assert.equal(passed, context);
    assert.equal(args.message, renderer.title); assert.equal(args.submitLabel, renderer.submitLabel);
    assert.deepEqual(args.fields, [{ id: 'selectedIds', label: renderer.title, type: 'multi_choice',
      presentation: 'cards', required: true, options: [
        { value: 'job-a', label: 'Northstar', description: 'Backend engineer', meta: ['Location: Remote · Europe'],
          imageUrl: 'https://example.test/logo.png', url: 'https://example.test/jobs/a' },
        { value: 'job-b', label: 'Harbor', description: 'Platform engineer', meta: ['Location: London'], imageUrl: '', url: '' },
      ] }]);
    return selected(['job-b']);
  });
  assert.deepEqual(output.result, { selectedIds: ['job-b'], selectedItems: [jobs[1]], totalItems: 2, _plugin: metadata });
  assert.equal(output._plugin, metadata); assert.equal(output.ok, true);
  assert.equal(Object.hasOwn(output.result, 'jobs'), false);
  assert.deepEqual(input.result.jobs, jobs, 'collecting a selection never mutates a tool result');
  assert.deepEqual(consumeToolEffects(output, context), [{ type: 'context.siteChanged' }]);
  assert.deepEqual(consumeToolEffects(input, context), [], 'effects are one receipt, not duplicated');
});

test('nested source paths, single choice, empty results, optional empty selection and MCP data', async () => {
  const nested = { _plugin: metadata, result: { payload: { jobs } } };
  const single = await selectSkillResults({ ...renderer, sourcePath: 'payload', selectionMode: 'single' }, nested, undefined, context,
    async (_name, args) => { assert.equal(args.fields[0].type, 'single_choice'); return selected('job-a'); });
  assert.deepEqual(single.result.selectedIds, ['job-a']);
  const empty = await selectSkillResults(renderer, { jobs: [] }, undefined, context, () => assert.fail('empty collection must not wait'));
  assert.deepEqual(empty, { selectedIds: [], selectedItems: [], totalItems: 0 });
  const none = await selectSkillResults({ ...renderer, required: false }, { jobs }, undefined, context, async () => selected([]));
  assert.deepEqual(none, { selectedIds: [], selectedItems: [], totalItems: 2 });
  for (const body of [{ structuredContent: { jobs } }, { content: [{ type: 'text', text: JSON.stringify({ jobs }) }] }]) {
    const mcp = await selectSkillResults(renderer, { ...body, _plugin: { runtime: 'mcp' } }, undefined, context, async () => selected(['job-a']));
    assert.deepEqual(mcp.selectedItems, [jobs[0]]);
    assert.equal(Object.hasOwn(mcp, 'structuredContent'), false);
    assert.equal(Object.hasOwn(mcp, 'content'), false);
  }
});

test('rejects malformed candidates and tampered answers before they can direct follow-up work', async () => {
  for (const bad of [undefined, {}, [jobs[0], jobs[0]], [{ ...jobs[0], key: '' }], [{ ...jobs[0], key: 1 }],
    [{ ...jobs[0], key: ' job-a ' }], [{ ...jobs[0], company: {} }], Array.from({ length: 51 }, (_, i) => ({ ...jobs[0], key: `job-${i}` }))]) {
    await assert.rejects(selectSkillResults(renderer, { jobs: bad }, undefined, context, () => assert.fail('invalid candidates must not wait')),
      { code: 'SKILL_SELECTION_INVALID_ITEMS' });
  }
  for (const answer of [{}, { submitted: false }, selected(['unknown']), selected(['job-a', 'job-a']), selected([]), selected([{}])]) {
    await assert.rejects(selectSkillResults(renderer, { jobs }, undefined, context, async () => answer), { code: 'SKILL_SELECTION_INVALID_ANSWER' });
  }
  await assert.rejects(selectSkillResults({ ...renderer, selectionMode: 'single' }, { jobs }, undefined, context, async () => selected(['job-a', 'job-b'])),
    { code: 'SKILL_SELECTION_INVALID_ANSWER' });
  const failed = { ok: false, error: 'Collection failed' };
  assert.equal(await selectSkillResults(renderer, failed, undefined, context, () => assert.fail('failed collection must not wait')), failed);
});

test('abort, stale completion and cancellation preserve the existing wait lifecycle', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectSkillResults(renderer, { jobs }, controller.signal, context, () => assert.fail('aborted call must not wait')),
    { code: 'OPERATION_ABORTED' });
  const late = new AbortController();
  await assert.rejects(selectSkillResults(renderer, { jobs }, late.signal, context, async () => {
    late.abort(); return selected(['job-a']);
  }), { code: 'OPERATION_ABORTED' });
  for (const code of ['USER_CANCELLED_WAIT', 'STALE_RUN', 'WAIT_SUPERSEDED']) {
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(selectSkillResults(renderer, { jobs }, undefined, context, async () => { throw error; }), actual => actual === error);
  }
});

test('default titles and errors retain the run language across human waiting', async () => {
  let pending;
  withLanguage('zh-CN', () => { pending = selectSkillResults({ type: 'selection' }, { items: [{ id: 'a', title: 'Role' }] }, undefined, context,
    async (_name, args) => { assert.equal(args.title, 'Choose results'); return selected(['a']); }); });
  await pending;
  withLanguage('zh-CN', () => { pending = selectSkillResults(renderer, { jobs }, undefined, context,
    async () => { await Promise.resolve(); return selected(['missing']); }); });
  await assert.rejects(pending,
  error => error.code === 'SKILL_SELECTION_INVALID_ANSWER' && error.message === 'Invalid selection. Run the tool again and choose from the current candidates.');
});

test('only top-level result selection is accepted and explicit contracts survive normalization', () => {
  const parse = candidate => parseSkillManifest(JSON.stringify({ format: 'qingzhou.plugin', schemaVersion: 1, id: 'selection',
    tools: [{ name: 'choose', runtime: 'inner', script: 'scripts/choose.js', renderer: candidate }] }), { name: 'selection' });
  const valid = parse({ ...renderer, selectionMode: 'single', required: false });
  assert.equal(valid.diagnostics.length, 0);
  const actual = valid.plugin.tools[0].renderer;
  for (const [key, value] of Object.entries(renderer)) assert.deepEqual(actual[key], value, key);
  assert.equal(actual.selectionMode, 'single'); assert.equal(actual.required, false);
  for (const invalid of [{ ...renderer, source: 'args' }, { ...renderer, layout: { blocks: [] } },
    { type: 'summary', layout: { blocks: [renderer] } }, { ...renderer, selectionMode: 'unknown' }]) {
    assert.ok(parse(invalid).diagnostics.some(item => item.level === 'error'));
  }
});

test('the copyable Skill example executes and produces a selectable return contract', async () => {
  const root = new URL('../fixtures/skills/result-selection/', import.meta.url);
  const manifest = parseSkillManifest(await readFile(new URL('plugin.json', root), 'utf8'), { name: 'result-selection-example' });
  assert.deepEqual(manifest.diagnostics, []);
  const tool = manifest.plugin.tools[0];
  const script = await readFile(new URL(tool.script, root), 'utf8');
  const data = JSON.parse(JSON.stringify(await vm.runInNewContext(`(${script})`)()));
  const result = await selectSkillResults(tool.renderer, data, undefined, context, async () => selected(['harbor-platform']));
  assert.deepEqual(result.selectedIds, ['harbor-platform']);
  assert.equal(result.selectedItems[0].company, 'Harbor');
  assert.equal(result.totalItems, 3);
});

test('real tool runtime stops collection timeout before human wait, isolates Sessions and rejects deleted waits', async t => {
  globalThis.chrome = { storage: { local: { async get() { return {}; }, async set() {} } }, runtime: { getURL: path => `chrome-extension://test/${path}` } };
  const waitModule = new URL('../../src/capabilities/wait/tools.ts', import.meta.url).href;
  const catalog = `data:text/javascript;base64,${Buffer.from(`
    import waits from ${JSON.stringify(waitModule)};
    export default [{id:'selection-fixture', setup:qz => {
      waits(qz);
      qz.registerTool({ name:'run_skill_script', parameters:{type:'object',properties:{}}, timeout:0,
        execute: async args => { if(args.args.slow) await new Promise(resolve=>setTimeout(resolve,200));
          return {ok:true,hasResult:true,result:{jobs:args.args.bad?[{}]:${JSON.stringify(jobs)}}}; }
      });
    }}];`).toString('base64')}`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === '#capabilities/tools' ? { url: catalog, shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const { createToolRuntime } = await import('../../src/background/tools/runtime.js');
  const { createSessionSupervisor } = await import('../../src/background/session/supervisor.js');
  const { prepareSkillToolRegistryFromSkills } = await import('../../src/background/skills/skill-tool-runtime.js');
  const snapshot = prepareSkillToolRegistryFromSkills([{ name: 'selection', scope: 'resident', format: 'qingzhou.skill', schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
    resources: [{ path: 'plugin.json', type: 'json', content: JSON.stringify({ format: 'qingzhou.plugin', schemaVersion: 1, id: 'selection',
      tools: [{ name: 'choose', runtime: 'inner', script: 'scripts/choose.js', parameters: { type: 'object', properties: { slow: { type: 'boolean' }, bad: { type: 'boolean' } } }, renderer }] }) },
    { path: 'scripts/choose.js', type: 'script', content: 'async () => ({})' }] }]);
  const supervisor = createSessionSupervisor({ createAgent: () => ({ getRunState: () => ({ runId: 'run' }), abort() {} }) });
  const events = [];
  const runtime = createToolRuntime({ sessions: supervisor, emit: event => events.push(event) });
  const run = async (id, args = {}) => {
    await supervisor.getAgent(id);
    return runtime.execute('selection__choose', { timeout: 0.1, ...args }, undefined,
      { sessionId: id, runId: 'run', language: 'en', skillToolRegistrySnapshot: snapshot });
  };
  const waitFor = async id => {
    for (let i = 0; i < 100 && !supervisor.isWaitingForUser(id); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(supervisor.isWaitingForUser(id), true);
    return events.findLast(event => event.sessionId === id && event.type === 'waiting_for_user');
  };
  const first = run('first'); const second = run('second');
  const [waitA, waitB] = await Promise.all([waitFor('first'), waitFor('second')]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(supervisor.isWaitingForUser('first'), true, 'human wait outlives the 100ms collection deadline');
  assert.equal(supervisor.resolveUserWait({ sessionId: 'second', waitId: waitA.waitId, payload: selected(['job-a']) }), false);
  assert.equal(supervisor.resolveUserWait({ sessionId: 'second', waitId: waitB.waitId, payload: selected(['job-b']) }), true);
  assert.deepEqual((await second).result.selectedIds, ['job-b']);
  assert.equal(supervisor.isWaitingForUser('first'), true);
  const rejected = assert.rejects(first, { code: 'USER_CANCELLED_WAIT' });
  supervisor.rejectUserWait({ sessionId: 'first', waitId: waitA.waitId });
  await rejected;
  const removed = run('removed'); const waitRemoved = await waitFor('removed');
  const removedRejected = assert.rejects(removed, error => ['SESSION_RELEASED', 'OPERATION_ABORTED', 'USER_CANCELLED_WAIT'].includes(error.code));
  await supervisor.remove('removed'); await removedRejected;
  assert.equal(supervisor.resolveUserWait({ sessionId: 'removed', waitId: waitRemoved.waitId, payload: selected(['job-a']) }), false);
  await assert.rejects(run('slow', { slow: true }), { code: 'TOOL_TIMEOUT' });
  assert.equal(supervisor.isWaitingForUser('slow'), false, 'collection failure never opens a chooser');
  await assert.rejects(run('invalid', { bad: true }), error => error.code === 'SKILL_SELECTION_INVALID_ITEMS'
    && error.codeLabel === 'Invalid candidates'
    && error.message === 'Invalid candidates. Return up to 50 items, each with a unique nonempty string ID and a title.');
  assert.equal(supervisor.isWaitingForUser('invalid'), false);
});

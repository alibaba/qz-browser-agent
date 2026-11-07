import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRuntime } from '../../src/background/mcp/mcp-runtime.js';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';
import { normalizeSkill } from '../../src/shared/skills/skill-utils.js';
import { toolError } from '../../src/shared/contracts/tool-error.js';

const skill = (name, scope = 'global', extra = {}) => normalizeSkill({
  name, scope, description: `Use ${name}.`, content: 'Private full instructions', ...extra,
});
const names = receipt => receipt.context?.qz_skills.map(item => item.name) || [];

function harness() {
  const states = new Map(['a', 'b'].map(id => [id, { status: 'idle', visitedTaskSites: [] }]));
  const writes = [];
  const runs = new Map();
  let serial = 0;
  const options = {
    sessions: {
      normalizeId: String, requireId: String,
      getRuntime: id => states.get(id),
      setRuntime: (id, patch) => { writes.push(patch); Object.assign(states.get(id), patch); },
      listMetadata: async () => ({ a: { source: 'external-drive' }, b: { source: 'external-drive' } }),
      supervisor: {
        mintDriveRunId(id) { const run = String(++serial); runs.set(id, run); return run; },
        isRunCurrent: (id, run) => runs.get(id) === run,
        takeDriveRunForRelease: () => '',
      },
    },
    tools: {
      canManageSessions: async () => false,
      buildRunProfile: () => ({}), loadedSkillNames: () => [], recordLoadedSkillNames() {},
      runtime: { getModelPolicy: () => ({ scriptResult: 'value', preserveResult: true }),
        execute: async () => ({ answer: 7 }),
      },
    },
    skills: { list: async () => [skill('research')] },
    artifacts: {}, trace: {}, dispatchSidepanel: async () => {},
    userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: {} },
  };
  const create = () => createMcpRuntime(options);
  let runtime = create();
  return { states, runs, options, writes, get runtime() { return runtime; },
    restart: () => { runtime = create(); }, abort: id => runtime.drive.abort(id),
    async execute(id = 'a', signal) {
      return (await runtime.executeTool({ sessionId: id, name: 'run_script',
        scriptApiVersion: 2, args: { code: 'return 7;' } }, signal)).result;
    },
    batch: () => runtime.executeTool({ sessionId: 'a', scriptApiVersion: 2,
      calls: [{ id: 'one', name: 'run_script', args: { code: 'return 7;' } }] }),
  };
}

test('every receipt reconstructs qz_skills after external compaction without changing authored values or trace', async () => {
  const h = harness();
  h.options.skills.list = async () => [skill('research'), skill('catalog', 'site', { domains: ['shop.test'] }),
    skill('disabled', 'global', { status: 'disabled' }), skill('built-in', 'global', { builtin: true })];
  const authored = { context: { qz_skills: [{ name: 'business-only' }] }, trace: ['business-only'] };
  h.options.tools.runtime.execute = async () => authored;
  const first = await h.execute();
  assert.deepEqual(names(first), ['research']);
  assert.deepEqual(first.result, authored);
  assert.deepEqual(first.trace, []);
  assert.equal(JSON.stringify(first.context).includes('Private full instructions'), false);
  assert.deepEqual((await h.execute()).context, first.context, 'external context compaction requires no notification to qz');
  h.states.get('a').visitedTaskSites = [{ url: 'https://shop.test/catalog' }];
  assert.deepEqual(names(await h.execute()), ['research', 'catalog']);
  h.restart();
  assert.deepEqual(names(await h.execute()), ['research', 'catalog'], 'restarting the runtime rebuilds the same catalog');
  assert.deepEqual(names(await h.execute('b')), ['research'], 'a second session does not inherit visited sites');
  assert.ok(h.writes.every(patch => Object.keys(patch).every(key => key === 'driveLastActivityAt')),
    'discovery has no notification or fingerprint state to persist');
});

test('current summaries reflect updates, disabling and re-enabling without a cached notification state', async () => {
  const h = harness();
  const catalog = skill('catalog', 'site', { domains: ['shop.test'] });
  h.options.skills.list = async () => [catalog];
  assert.deepEqual((await h.execute()).context, { qz_skills: [] });
  h.states.get('a').visitedTaskSites = [{ url: 'https://shop.test/' }];
  assert.deepEqual(names(await h.execute()), ['catalog']);
  catalog.description = 'Revised workflow';
  assert.equal((await h.execute()).context.qz_skills[0].description, 'Revised workflow');
  catalog.status = 'disabled';
  assert.deepEqual((await h.execute()).context, { qz_skills: [] }, 'an empty snapshot clears formerly available workflows');
  catalog.status = 'active';
  assert.deepEqual(names(await h.execute()), ['catalog']);
});

test('script failure retains discovery and its own error; discovery failure cannot fail an executed script', async t => {
  const h = harness();
  h.options.tools.runtime.execute = async () => { throw toolError('SCRIPT_EVALUATION_FAILED', 'Page read failed.'); };
  const failed = await h.execute();
  assert.equal(failed.ok, false);
  assert.equal(failed.result.message, 'Page read failed.');
  assert.deepEqual(names(failed), ['research']);
  h.options.tools.runtime.execute = async () => 7;
  h.options.skills.list = async () => { throw new Error('Storage unavailable'); };
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await h.execute('b'), { ok: true, result: 7, trace: [] });
  h.options.skills.list = async () => [skill('research')];
  assert.deepEqual(names(await h.execute('b')), ['research']);
});

for (const reason of ['cancelled', 'internal abort', 'obsolete']) test(`${reason} discovery cannot publish stale context`, async () => {
  const h = harness(), controller = new AbortController();
  let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.options.skills.list = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const result = h.execute('a', controller.signal);
  await waiting;
  if (reason === 'cancelled') controller.abort();
  else if (reason === 'internal abort') h.abort('a');
  else h.runs.delete('a');
  finish([skill('research')]);
  assert.equal((await result).context, undefined);
  h.options.skills.list = async () => [skill('research')];
  assert.deepEqual(names(await h.execute()), ['research']);
});

test('legacy multi-script batches share one discovery context outside business results', async () => {
  const h = harness();
  const result = await h.batch();
  assert.deepEqual(names(result), ['research']);
  assert.deepEqual(result.results[0].result, { ok: true, result: { answer: 7 }, trace: [] });
  assert.deepEqual(names(await h.execute()), ['research']);
});

test('session creation activates enabled user Global Skills and returns the first receipt catalog; creation survives unavailable discovery', async t => {
  const h = harness(), recorded = [];
  h.options.tools.recordLoadedSkillNames = (id, loaded) => recorded.push([id, loaded]);
  h.options.skills.list = async () => [skill('research'), skill('catalog', 'site', { domains: ['shop.test'] }),
    skill('rules', 'resident'), skill('disabled', 'global', { status: 'disabled' }), skill('built-in', 'global', { builtin: true })];
  const { qz_skills, ...created } = await h.runtime.createDriveSession({ title: 'Inspect', sessionId: 'a' });
  assert.deepEqual(created, { sessionId: 'a', title: 'Inspect', status: 'idle' });
  assert.deepEqual(names({ context: { qz_skills } }), ['research', 'rules']);
  assert.deepEqual(qz_skills, (await h.execute('a')).context.qz_skills, 'creation and the first script receipt show one catalog');
  assert.equal(JSON.stringify(qz_skills).includes('Private full instructions'), false);
  assert.deepEqual(recorded, [['a', ['research']]], 'Site Skills wait for a matching site; Resident Skills are always active');
  h.options.skills.list = async () => { throw new Error('Storage unavailable'); };
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await h.runtime.createDriveSession({ title: 'Inspect', sessionId: 'b' }),
    { sessionId: 'b', title: 'Inspect', status: 'idle' }, 'an unavailable catalog is omitted, never reported as empty');
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(recorded, [['a', ['research']]]);
});

test('load_skill activates its tools for later calls in the same drive script', async () => {
  const h = harness(), loaded = new Map();
  h.options.sessions.recordToolEvent = () => {};
  h.options.tools.loadedSkillNames = (id, extra = []) => [...new Set([...loaded.get(id) || [], ...extra])];
  h.options.tools.recordLoadedSkillNames = (id, names) => loaded.set(id,
    h.options.tools.loadedSkillNames(id, names.filter(Boolean).map(name => name.toLowerCase())));
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: (id, run) => h.runs.get(id) === run, hasAgent: () => false, getAbortSignal: () => undefined },
    getRuntime: id => h.states.get(id), loadedSkillNames: id => h.options.tools.loadedSkillNames(id),
    canManageSessions: async () => false, buildRunProfile: async () => ({}),
    getRunToolContext: async () => ({ externalDrive: true }),
    recordNestedTool: observation => h.runtime.recordNestedTool(observation),
    toolRuntime: {
      resolveDefinition: () => ({}),
      async execute(name, args, _signal, context) {
        const active = context.loadedPluginSkillNames.includes('weather');
        if (name === 'list_tools') return { tools: active ? [{ name: 'weather__forecast' }] : [] };
        if (name === 'load_skill') return { name: 'weather', displayName: 'Weather', tools: [{ name: 'weather__forecast' }] };
        if (name === 'weather__forecast' && active) return { city: args.city, high: 21 };
        throw toolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
      },
    },
    collectArtifacts: () => [],
  });
  h.options.tools.runtime.execute = async (_name, _args, _signal, { sessionId, runId }) => {
    const call = (toolName, args = {}) => bridge.handleToolCall({ toolName, args, sessionId, runId });
    const before = await call('list_tools'), early = await call('weather__forecast', { city: 'Paris' });
    await call('load_skill', { name: 'weather' });
    return { before: before.result.tools, early: early.result.code,
      after: (await call('list_tools')).result.tools, forecast: (await call('weather__forecast', { city: 'Paris' })).result };
  };
  assert.deepEqual((await h.execute('a')).result, { before: [], early: 'UNKNOWN_TOOL',
    after: [{ name: 'weather__forecast' }], forecast: { city: 'Paris', high: 21 } });
  assert.deepEqual(loaded.get('a'), ['weather']);
  assert.equal(loaded.has('b'), false, 'activation stays within its session');
});

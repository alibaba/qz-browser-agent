import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRuntime } from '../../src/background/mcp/mcp-runtime.js';
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
  return { states, runs, options, writes, restart: () => { runtime = create(); }, abort: id => runtime.drive.abort(id),
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

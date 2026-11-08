import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { createNestedToolScheduler, scheduleToolCalls } from '../../src/background/tools/tool-scheduler.js';
import { planTabBatch } from '../../src/background/tools/tab-batch.js';
globalThis.chrome = {};
const { getBatchTabPolicy, getParallelReadTab } = await import('../../src/background/tools/runtime.js');
import { createTestAgentOptions } from '../support/agent-services.mjs';

const call = (id, name, tabId) => ({ id, function: { name, arguments: JSON.stringify({ tabId, limit: 10 }) } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native script calls share the leaf budget and reach their own descendants without a batch barrier', async () => {
  const items = [1, 2].map(id => ({ id, args: { code: 'return await tools.evaluate(args);', args: { tabRef: id } } }));
  const plan = planTabBatch(items, item => ({ args: item.args, policy: getBatchTabPolicy('run_script', item.args) }));
  const nested = createNestedToolScheduler(), started = [], releases = new Map();
  const run = scheduleToolCalls(items, {
    tab: () => null, lane: plan.lane, independent: plan.independent, dependencies: plan.dependencies,
    signal: new AbortController().signal,
    execute: async (item, signal, _parallel, parent) => nested.run({ parent, group: 'children', lane: item.id,
      policy: { kind: 'target', implicit: false, parallel: true }, signal,
      execute: async () => { started.push(item.id); await new Promise(resolve => releases.set(item.id, resolve)); return item.id; },
    }),
    commit: async () => {},
  });
  await tick();
  assert.deepEqual(started, [1, 2]);
  releases.get(2)(); releases.get(1)();
  await run;
});

for (const tool of ['wait_for_navigation', 'wait_for_popup', 'wait_for_response']) test(`native ${tool} delegates child locks while preserving same-page ordering`, async t => {
  const stop = new AbortController(), nested = createNestedToolScheduler();
  const bothStarted = Promise.withResolvers(), events = [], parents = [];
  // Native popup creators retain their existing window-anchor dependency on earlier page calls.
  const items = [7, 8].map(tabRef => ({ name: tool === 'wait_for_popup' && tabRef === 8 ? 'wait_for_navigation' : tool,
    args: { tabRef, trigger: { name: 'run_script', args: { code: 'return await tools.list_tools();' } } } }));
  items.push(...[7, 8].map(tabRef => ({ name: 'evaluate', args: { tabRef, code: 'return 1;' } })));
  const plan = planTabBatch(items, item => ({ args: item.args, policy: getBatchTabPolicy(item.name, item.args) }));
  const run = scheduleToolCalls(items, {
    tab: item => item.args.tabRef, lane: plan.lane, independent: plan.independent, orchestration: plan.orchestration,
    observer: plan.passive, dependencies: plan.dependencies, signal: stop.signal,
    execute: async (item, signal, _parallel, parent) => {
      const tab = item.args.tabRef;
      if (item.name === 'evaluate') { events.push(`follow:${tab}`); return; }
      return nested.run({ parent, group: 'trigger', lane: null, policy: { kind: 'script' }, signal,
        execute: async script => {
          parents.push(tab);
          if (parents.length === 2) bothStarted.resolve();
          await bothStarted.promise;
          await nested.run({ parent: script, group: 'catalog', lane: null, policy: getBatchTabPolicy('list_tools', {}), signal,
            execute: async () => { events.push(`catalog:${tab}`); },
          });
          events.push(`wait:${tab}`);
        },
      });
    },
    commit: async () => {},
  });
  t.after(async () => { stop.abort(); bothStarted.resolve(); await run.catch(() => {}); });
  await tick();
  assert.deepEqual(parents, [7, 8]);
  assert.equal(events.length, 6, 'both waits and their following calls must finish without reaching a deadline');
  await run;
  for (const tab of [7, 8]) {
    assert.ok(events.indexOf(`catalog:${tab}`) < events.indexOf(`wait:${tab}`));
    assert.ok(events.indexOf(`wait:${tab}`) < events.indexOf(`follow:${tab}`));
  }
  assert.equal(nested.pending, 0);
});

for (const parallel of [true, false]) test(`nested page calls retain their ${parallel ? 'page lane' : 'global barrier'} after a child returns`, async t => {
  const stop = new AbortController(), nested = createNestedToolScheduler();
  const resumed = Promise.withResolvers(), finishPage = Promise.withResolvers(), started = [];
  const items = ['page-script', 'actions'];
  const plan = planTabBatch(items, () => ({ args: {}, policy: getBatchTabPolicy('run_script', {}) }));
  const action = (parent, signal, lane) => nested.run({ parent, group: 'actions', lane, signal,
    policy: { kind: 'target', implicit: false, parallel: true },
    execute: async () => { started.push(lane); return lane; },
  });
  const run = scheduleToolCalls(items, {
    tab: () => null, lane: plan.lane, independent: plan.independent, orchestration: plan.orchestration,
    dependencies: plan.dependencies, signal: stop.signal,
    execute: async (item, signal, _parallel, root) => {
      if (item === 'page-script') return nested.run({ parent: root, group: item, lane: 7, signal,
        policy: { kind: 'target', implicit: false, parallel },
        execute: async page => {
          // The page script can still access DOM after awaiting a nested tool.
          await action(page, signal, 7);
          resumed.resolve();
          await finishPage.promise;
          started.push('page-finished');
        },
      });
      await nested.run({ parent: root, group: item, lane: null, signal,
        policy: { kind: 'observe' }, execute: () => resumed.promise });
      return Promise.all([action(root, signal, 7), action(root, signal, 8)]);
    },
    commit: async () => {},
  });
  t.after(async () => { stop.abort(); finishPage.resolve(); await run.catch(() => {}); });
  await tick();
  assert.deepEqual(started, parallel ? [7, 8] : [7],
    'descendants can reach their parent page; siblings must respect its outstanding page access');
  finishPage.resolve();
  await run;
  assert.deepEqual(started, parallel ? [7, 8, 'page-finished', 7] : [7, 'page-finished', 7, 8]);
  assert.equal(nested.pending, 0);
});

test('native and nested ready results share one commit gate without holding it during execution', async () => {
  const nested = createNestedToolScheduler(), events = [];
  let releaseHead, releaseChild;
  const run = scheduleToolCalls(['head', 'parent'], {
    tab: item => item === 'head' ? 1 : 2,
    signal: new AbortController().signal,
    execute: async (item, signal, _parallel, parent) => {
      if (item === 'head') await new Promise(resolve => { releaseHead = resolve; });
      else await nested.run({ parent, group: 'child', lane: 2, policy: { kind: 'target', implicit: false, parallel: true }, signal,
        execute: async () => 'child',
        commit: async value => {
          events.push('child:commit');
          await new Promise(resolve => { releaseChild = resolve; });
          events.push('child:committed'); return value;
        },
      });
      return item;
    },
    commit: async item => { events.push(`${item}:committed`); },
  });
  await tick();
  assert.deepEqual(events, ['child:commit']);
  releaseHead(); await tick();
  assert.deepEqual(events, ['child:commit'], 'native publication cannot overlap a descendant state commit');
  releaseChild(); await run;
  assert.deepEqual(events, ['child:commit', 'child:committed', 'head:committed', 'parent:committed']);
  assert.equal(nested.pending, 0);
});

test('a blocked tool publishes its start and flow-control progress before completing', async () => {
  const events = [];
  let release, update, effects = 0;
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, _args, _signal, context) {
      update = context.onToolUpdate;
      update({ type: 'tool_execution_update', toolCallId: '1', phase: 'queued',
        statusText: 'Waiting for rate limit', rateLimit: { waitMs: 1000 } });
      await new Promise(resolve => { release = resolve; });
      return { value: 'done' };
    },
  } }));
  agent._emit = event => events.push(event);
  agent._applyToolResultEffects = async () => { effects++; return []; };
  const run = agent._executeToolCalls([call('1', 'read_article', 1)], new AbortController().signal);
  await tick();
  assert.deepEqual(events.map(event => event.type), ['tool_execution_start', 'tool_execution_update']);
  assert.equal(events[1].phase, 'queued');
  assert.equal(effects, 0);
  release();
  const messages = await run;
  assert.equal(effects, 1);
  assert.deepEqual(messages.map(message => message.tool_call_id), ['1']);
  assert.equal(events.at(-1).type, 'tool_execution_end');
  update({ type: 'tool_execution_update', toolCallId: '1', statusText: 'late' });
  assert.equal(events.length, 3, 'settled calls must reject late progress');
});

test('parallel progress is live while final events, effects and messages retain call order', async () => {
  const events = [], effects = [], releases = new Map(), updates = new Map();
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, _args, _signal, context) {
      const id = context.toolCallId;
      updates.set(id, context.onToolUpdate);
      context.onToolUpdate({ type: 'tool_execution_update', toolCallId: id, statusText: `reading ${id}` });
      await new Promise(resolve => releases.set(id, resolve));
      return { id };
    },
  } }));
  agent._emit = event => events.push(event);
  agent._applyToolResultEffects = async (_name, result) => { effects.push(result.id); return []; };
  const run = agent._executeToolCalls([call('1', 'read_article', 1), call('2', 'read_article', 2)], new AbortController().signal);
  await tick();
  for (const id of ['1', '2']) assert.deepEqual(events.filter(event => event.toolCallId === id).map(event => event.type),
    ['tool_execution_start', 'tool_execution_update']);
  releases.get('2')(); await tick();
  assert.deepEqual(effects, []);
  assert.equal(events.filter(event => event.type === 'tool_execution_end').length, 0);
  updates.get('2')({ type: 'tool_execution_update', toolCallId: '2', statusText: 'late before commit' });
  assert.equal(events.length, 4, 'completed execution cannot publish more progress while awaiting commit');
  releases.get('1')();
  const messages = await run;
  assert.deepEqual(effects, ['1', '2']);
  assert.deepEqual(events.filter(event => event.type === 'tool_execution_end').map(event => event.toolCallId), ['1', '2']);
  assert.deepEqual(messages.map(message => message.tool_call_id), ['1', '2']);
});

test('stop revokes progress immediately and preserves a paired ledger for skipped calls', async () => {
  const events = [], executed = [], controller = new AbortController();
  let update;
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, _args, signal, context) {
      executed.push(context.toolCallId);
      update = context.onToolUpdate;
      await new Promise(resolve => signal.addEventListener('abort', () => {
        update({ type: 'tool_execution_update', toolCallId: '1', statusText: 'late abort' });
        resolve();
      }, { once: true }));
      return { late: true };
    },
  } }));
  agent._emit = event => events.push(event);
  const input = [call('1', 'read_article', 1), call('2', 'navigate', 2)];
  const run = agent._executeToolCalls(input, controller.signal);
  await tick();
  assert.deepEqual(events.map(event => event.toolCallId), ['1']);
  controller.abort(); await run;
  assert.deepEqual(executed, ['1']);
  for (const call of input) assert.deepEqual(events.filter(event => event.toolCallId === call.id).map(event => event.type),
    ['tool_execution_start', 'tool_execution_end']);
  assert.ok(events.filter(event => event.type === 'tool_execution_end').every(event => event.result.code === 'OPERATION_ABORTED'));
});

test('trusted registrations select only explicit cross-tab observations', () => {
  for (const [name, field] of [
    ['read_article', 'target'], ['find_elements', 'target'], ['get_ax_tree', 'target'], ['screenshot', 'target'],
  ]) {
    assert.equal(getParallelReadTab(name, { tabId: 12 }), 12);
    assert.equal(getParallelReadTab(name, {}), null);
    assert.equal(getParallelReadTab(name, { tabId: 12, [field]: 'uid:t12.abcdef.1' }), null);
  }
  assert.equal(getParallelReadTab('screenshot', { tabId: 12, selector: 'uid:t99.abcdef.1' }), null,
    'the hidden legacy selector alias keeps UID targets on their registered tab lane');
  assert.equal(getParallelReadTab('screenshot', { tabId: 12, actionable: true }), null);
  assert.equal(getParallelReadTab('screenshot', { tabId: 12, destination: 'saved-images' }), null);
  assert.equal(getParallelReadTab('spoofed', { tabId: 12 }, { toolRegistrySnapshot: {
    get: () => ({ source: 'core', behavior: { parallelRead: true } }),
  } }), null, 'a runtime object cannot impersonate a trusted build-time snapshot');
  assert.equal(getParallelReadTab('open_tab', { tabId: 12, tabAlias: 'a', url: 'https://example.test/' }), null);
  assert.equal(getParallelReadTab('run_script', { tabId: 12, parallelRead: true }), null);
  assert.equal(getParallelReadTab('unknown', { tabId: 12, parallelRead: true }), null);
});

test('scheduler bounds execution at ten and refills slots before earlier calls commit', async () => {
  const started = [], committed = [], parallelCalls = [], releases = new Map();
  let active = 0, peak = 0;
  const run = scheduleToolCalls(Array.from({ length: 11 }, (_, i) => i + 1), {
    tab: id => id, signal: new AbortController().signal,
    execute: async (id, _signal, parallel) => {
      started.push(id); parallelCalls.push(parallel); peak = Math.max(peak, ++active);
      await new Promise(resolve => releases.set(id, resolve));
      active--; return id;
    },
    commit: async id => { committed.push(id); },
  });
  await tick();
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (let id = 10; id >= 2; id--) releases.get(id)();
  await tick(); assert.deepEqual(committed, []); assert.equal(started.length, 11);
  releases.get(1)(); await tick();
  assert.deepEqual(committed, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(started.at(-1), 11); releases.get(11)(); await run;
  assert.equal(peak, 10); assert.equal(active, 0);
  assert.deepEqual(committed, started);
  assert.deepEqual(parallelCalls, Array(11).fill(true));
});

test('finite batches arm ten passive observations without blocking their triggering action', async () => {
  const items = [...Array.from({ length: 10 }, (_, id) => ({ id, name: 'wait_for_navigation', args: { tabRef: 1 } })),
    { id: 10, name: 'act_on_element', args: { tabRef: 1, target: 'css:#go', action: 'click' } }];
  const plan = planTabBatch(items, item => ({ args: item.args, policy: getBatchTabPolicy(item.name, item.args) }));
  const stop = new AbortController(), started = [], commits = [], observers = new Set();
  const run = scheduleToolCalls(items, {
    tab: () => 1, lane: plan.lane, independent: plan.independent, observer: plan.passive,
    dependencies: plan.dependencies, signal: stop.signal, cancelled: item => item.id,
    execute: async (item, signal) => {
      started.push(item.id);
      if (item.name === 'act_on_element') for (const release of [...observers]) release();
      else await new Promise(resolve => {
        const release = () => { signal.removeEventListener('abort', release); observers.delete(release); resolve(); };
        observers.add(release); signal.addEventListener('abort', release, { once: true });
      });
      return item.id;
    },
    commit: async id => { commits.push(id); },
  });
  try {
    await tick();
    assert.deepEqual(started, items.map(item => item.id), 'the action must start while all ten observations are armed');
    await run;
    assert.deepEqual(commits, items.map(item => item.id), 'publication retains the original call order');
    assert.equal(observers.size, 0);
  } finally { stop.abort(); await run; }
});

test('finite containers yield a leaf slot before their own execution completes', async () => {
  const stop = new AbortController(), nested = createNestedToolScheduler();
  const items = Array.from({ length: 11 }, (_, i) => i + 1), started = [], commits = [], releases = new Map();
  let resumeParents, releaseAction, active = 0, peak = 0;
  const parents = new Promise(resolve => { resumeParents = resolve; });
  const holdLeaf = (id, signal) => new Promise(resolve => {
    const release = () => { signal.removeEventListener('abort', release); releases.delete(id); resolve(); };
    releases.set(id, release); signal.addEventListener('abort', release, { once: true });
  });
  const run = scheduleToolCalls(items, {
    tab: id => id, signal: stop.signal, cancelled: id => id, reject: id => id,
    execute: async (id, signal, _parallel, scope) => {
      if (id <= 10) {
        await nested.run({ parent: scope, group: 'children', lane: id, signal,
          policy: { kind: 'target', implicit: false, observation: false, parallel: true },
          execute: async () => {
            started.push(`child-${id}`); peak = Math.max(peak, ++active);
            try { await holdLeaf(id, signal); return id; } finally { active--; }
          },
        });
        await parents;
      } else {
        started.push('action'); peak = Math.max(peak, ++active);
        try { await new Promise(resolve => { releaseAction = resolve; }); } finally { active--; }
      }
      return id;
    },
    commit: async id => { commits.push(id); },
  });
  try {
    await tick();
    assert.equal(started.length, 10); assert.equal(active, 10);
    releases.get(1)();
    await tick();
    assert.equal(started.at(-1), 'action', 'a completed child frees capacity even while its parent remains suspended');
    assert.equal(active, 10); assert.equal(peak, 10);
    assert.deepEqual(commits, [], 'the suspended first parent still holds the publication cursor');
    for (const release of [...releases.values()]) release();
    resumeParents(); releaseAction();
    await run;
    assert.deepEqual(commits, items); assert.equal(active, 0); assert.equal(nested.pending, 0);
  } finally {
    stop.abort(); resumeParents(); releaseAction?.();
    await run;
  }
});

test('Agent serializes same-tab lanes without blocking independent reads and retains global barriers', async () => {
  const started = [], finished = [], committed = [], signals = [], releases = new Map();
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(name, args, signal, context) {
      started.push(context.toolCallId); signals.push(signal);
      assert.equal(context.preserveWorkingTab, ['1', '2', '3', '4', '5', '7', '8'].includes(context.toolCallId));
      await new Promise(resolve => releases.set(context.toolCallId, resolve));
      finished.push(context.toolCallId);
      if (context.toolCallId === '2') throw new Error('one failed read');
      return { value: context.toolCallId };
    },
  } }));
  agent._applyToolResultEffects = async (_name, result) => { committed.push(result.value || 'error'); return []; };
  const run = agent._executeToolCalls([
    call('1', 'read_article', 1), call('2', 'read_article', 2), call('3', 'read_article', 3),
    call('4', 'read_article', 3), call('5', 'read_article', 4), call('6', 'navigate', 5),
    call('7', 'read_article', 6), call('8', 'read_article', 7),
  ], new AbortController().signal);
  await tick(); assert.deepEqual(started, ['1', '2', '3', '5']);
  releases.get('3')(); releases.get('2')(); await tick(); assert.deepEqual(committed, []);
  assert.equal(started.at(-1), '4'); releases.get('4')(); releases.get('5')();
  releases.get('1')(); await tick(); assert.deepEqual(committed, ['1', 'error', '3', '4', '5']);
  assert.equal(started.at(-1), '6'); releases.get('6')(); await tick();
  assert.deepEqual(started.slice(-2), ['7', '8']);
  releases.get('8')(); releases.get('7')();
  const messages = await run;
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['1','2','3','4','5','6','7','8']);
  assert.deepEqual(finished.slice(0, 2), ['3', '2']);
  assert.equal(new Set(signals).size, 8);
});

test('one shared budget bounds mixed opens and ready readers at ten', async () => {
  const opens = Array.from({ length: 10 }, (_, i) => `o${i}`), reads = opens.map((_, i) => `r${i}`);
  const releases = new Map(), started = [], commits = [];
  let active = 0, peak = 0;
  const run = scheduleToolCalls([...opens, ...reads], {
    tab: () => null, signal: new AbortController().signal,
    dependencies: id => ({ execution: id[0] === 'r' ? [`o${id.slice(1)}`] : [], commit: [] }),
    execute: async id => { started.push(id); peak = Math.max(peak, ++active);
      await new Promise(resolve => releases.set(id, resolve)); active--; return id; },
    commit: async id => { commits.push(id); },
  });
  await tick(); assert.deepEqual(started, opens);
  releases.get('o0')(); await tick(); assert.equal(started.at(-1), 'r0');
  assert.equal(active, 10); assert.deepEqual(commits, ['o0']);
  for (const id of opens.slice(1)) releases.get(id)();
  await tick(); for (const id of reads) releases.get(id)();
  await run; assert.equal(peak, 10); assert.deepEqual(commits, [...opens, ...reads]);
});

test('an effect failure preserves sibling results and later barriers', async () => {
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, _args, _signal, context) { return { value: context.toolCallId }; },
  } }));
  agent._applyToolResultEffects = async (_name, result) => {
    if (result.value === '2') throw new Error('effect failed');
    return [];
  };
  const result = await agent._executeToolCalls([call('1','read_article',1),call('2','read_article',2),call('3','navigate',3)], new AbortController().signal);
  assert.deepEqual(result.map(message => message.tool_call_id), ['1','2','3']);
  assert.match(JSON.stringify(result[1]), /effect failed/);
  assert.match(JSON.stringify(result[2]), /value/);
});

test('stop cancels each running call and revokes pending effects and later barriers', async () => {
  const controller = new AbortController(), signals = [];
  let commits = 0;
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, _args, signal) {
      signals.push(signal);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { late: true };
    },
  } }));
  agent._applyToolResultEffects = async () => { commits++; return []; };
  const run = agent._executeToolCalls([
    ...Array.from({ length: 11 }, (_, i) => call(String(i + 1), 'read_article', i + 1)), call('mutation', 'navigate', 12),
  ], controller.signal);
  await tick(); controller.abort();
  const messages = await run;
  assert.equal(signals.length, 10); assert.ok(signals.every(signal => signal.aborted)); assert.equal(commits, 0);
  assert.equal(new Set(signals).size, 10);
  assert.deepEqual(messages.map(message => message.tool_call_id), [...Array.from({ length: 11 }, (_, i) => String(i + 1)), 'mutation']);
  assert.ok(messages.every(message => JSON.stringify(message).includes('OPERATION_ABORTED')));
});

test('stop retains an already completed result and the interrupted call in ledger order', async () => {
  const controller = new AbortController(), executed = [];
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, args, signal) {
      executed.push(args.tabId);
      if (args.tabId === 1) return { completed: true };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('stopped'), { code: 'OPERATION_ABORTED' });
    },
  } }));
  const run = agent._executeToolCalls([call('1','read_article',1),call('2','read_article',2),call('3','navigate',3)], controller.signal);
  await tick(); controller.abort();
  const messages = await run;
  assert.deepEqual(executed, [1, 2]);
  assert.deepEqual(messages.map(message => message.tool_call_id), ['1', '2', '3']);
  assert.match(JSON.stringify(messages[0]), /completed/);
  assert.match(JSON.stringify(messages[1]), /OPERATION_ABORTED/);
});

test('scheduler settles siblings before committing an unexpected execute rejection', async () => {
  for (const convert of [false, true]) {
    const committed = [], releases = new Map(), error = new Error('unexpected host failure');
    const run = scheduleToolCalls([1, 2, 3], {
      tab: item => item,
      signal: new AbortController().signal,
      execute: async item => {
        if (item === 2) throw error;
        await new Promise(resolve => releases.set(item, resolve));
        return item;
      },
      ...(convert ? { reject: (item, reason) => { assert.equal(reason, error); return `failed:${item}`; } } : {}),
      commit: async result => { committed.push(result); },
    });
    const settled = run.then(() => null, failure => failure);
    await tick(); assert.deepEqual(committed, []);
    releases.get(3)(); await tick(); assert.deepEqual(committed, []);
    releases.get(1)();
    assert.equal(await settled, convert ? null : error);
    assert.deepEqual(committed, convert ? [1, 'failed:2', 3] : [1, 3]);
  }
});

test('start events retain explicit arguments and execution failures preserve sibling results', async () => {
  const events = [], executed = [];
  const agent = new Agent('scheduler', createTestAgentOptions({ tools: {
    getIdentity: () => ({}), getSchemas: () => [], getParallelReadTab,
    async execute(_name, args) {
      executed.push(args.tabRef);
      if (args.tabRef === 2) throw new Error('execute failed');
      return { value: args.tabRef };
    },
  } }));
  agent._emit = event => events.push(event);
  agent._dynamicContextSnapshot = { workingTab: { id: 10 }, userVisibleTab: { id: 20 } };
  const messages = await agent._executeToolCalls([1, 2, 3].map(id => ({ id: String(id), function: {
    name: 'read_article', arguments: JSON.stringify({ tabRef: id, limit: 10 }),
  } })), new AbortController().signal);
  assert.deepEqual(executed, [1, 2, 3]);
  assert.deepEqual(messages.map(message => message.tool_call_id), ['1', '2', '3']);
  for (const id of ['1', '2', '3']) {
    const start = events.find(event => event.type === 'tool_execution_start' && event.toolCallId === id);
    assert.deepEqual(start.args, { tabRef: Number(id), limit: 10 });
  }
  const failed = events.find(event => event.type === 'tool_execution_end' && event.toolCallId === '2');
  assert.equal(failed.isError, true);
  assert.match(failed.result.message, /execute failed/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPageElementTools } from '../../src/capabilities/page/tools.js';
import { registerWaitTools } from '../../src/capabilities/wait/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

const query = { role: 'button', name: 'Continue' };
const binding = number => ({ tabId: 7, selector: '', index: 0, uid: `t7.000001.${number}`,
  target: `uid:t7.000001.${number}`, ref: { backendNodeId: number } });
const stale = target => new ToolExecutionError('STALE_ELEMENT_UID', 'The node was replaced.', { reason: 'node_unavailable', ...(target ? { target } : {}) });

function pageFixture(options = {}) {
  const definitions = new Map(), calls = [], scans = [], dispatched = [], deadlines = [];
  const context = { sessionId: 'task', requestedTabRef: 'page', deadlineAt: Date.now() + 1000 };
  const host = {
    registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    getElementTargetDescription: () => 'Element reference', elementTargetForSelector: selector => `css:${selector}`,
    async resolveLocatorTarget(tabId, locator, current) {
      assert.equal(tabId, 7); scans.push(locator); deadlines.push(current.deadlineAt);
      return options.locate ? options.locate(scans.length, locator) : binding(scans.length);
    },
    async resolveElementReference(tabId, { target }) { return { ...binding(10), tabId, target }; },
    async resolveElementInput(tabId, { target, locator }, current) {
      if (!locator) return host.resolveElementReference(tabId, { target }, current);
      const found = await host.resolveLocatorTarget(tabId, locator, current);
      if (!found) throw new ToolExecutionError('ELEMENT_NOT_FOUND', 'No element matches the locator.');
      return found;
    },
    async useElement(_id, ref, _context, run) {
      options.beforeUse?.(ref);
      return run(async (action, args) => {
        calls.push({ action, args, ref });
        if (action === 'readElementReadiness') return { visible: true, disabled: false };
        if (action === 'inspectElement') return { tag: 'select', role: 'combobox', text: 'Choice' };
        if (action === 'readArticle') return { text: `article:${ref.uid}`, totalChars: 10 };
        if (action === 'actOnElement') { dispatched.push(ref.target); options.dispatch?.(); return {}; }
        return {};
      });
    },
    async addElementTargetsToFindResult(value, _id, _context, ref) { return { ...value, target: `uid:t7.000001.${ref.backendNodeId}` }; },
    async sendToContent() { assert.fail('locator reads and actions must use their bound node'); },
  };
  registerPageElementTools(host);
  return { definitions, calls, scans, dispatched, deadlines, context,
    async run(name, input, extra = {}, signal) {
      const definition = definitions.get(name), args = { tabId: 7, ...input };
      definition.validateArgs?.(args);
      return definition.execute(args, signal, { ...context, ...extra });
    },
  };
}

test('locator inputs are exclusive and explicit references in both drag endpoints participate in authority checks', () => {
  const f = pageFixture(), act = f.definitions.get('act_on_element');
  assert.throws(() => act.validateArgs({ target: 'css:button', locator: query }), { code: 'INVALID_ELEMENT_TARGET' });
  assert.throws(() => act.validateArgs({ locator: query, nth: 0 }), { code: 'INVALID_ELEMENT_TARGET' });
  assert.throws(() => act.validateArgs({ locator: {}, action: 'click' }), { code: 'INVALID_ELEMENT_LOCATOR' });
  assert.deepEqual(act.behavior.uidTargets({ action: 'drag', locator: { within: 'uid:source', role: 'button' },
    destination: { locator: { target: 'uid:end', within: 'uid:frame' } } }).filter(Boolean), ['uid:source', 'uid:end', 'uid:frame']);
  assert.throws(() => f.definitions.get('read_article').validateArgs({ locator: query }), { code: 'INVALID_ELEMENT_LOCATOR' });
});

test('a locator action waits for a match and dispatches against that node within its original budget', async () => {
  const f = pageFixture({ locate: count => count === 1 ? null : binding(2) });
  assert.deepEqual(await f.run('act_on_element', { locator: query, action: 'select', value: 'choice' }), {});
  assert.equal(f.scans.length, 2);
  assert.deepEqual(f.dispatched, ['uid:t7.000001.2']);
  assert.ok(f.deadlines.every(value => value === f.context.deadlineAt));
  assert.equal(f.calls.filter(call => call.action === 'actOnElement').length, 1);
});

test('a query may resolve a replacement before input, while an explicit uid keeps its identity', async () => {
  for (const explicit of [false, true]) {
    const f = pageFixture({ beforeUse: ref => { if (ref.ref.backendNodeId === 1) throw stale(ref.target); } });
    const result = f.run('act_on_element', { locator: explicit ? { target: 'uid:original' } : query, action: 'select', value: 'choice' });
    if (explicit) { await assert.rejects(result, { code: 'STALE_ELEMENT_UID' }); assert.equal(f.scans.length, 1); }
    else { await result; assert.equal(f.scans.length, 2); assert.deepEqual(f.dispatched, ['uid:t7.000001.2']); }
  }
});

test('only an identified fresh query-node binding failure retries; pinned and unknown failures stop', async () => {
  const changed = pageFixture({ locate: count => {
    if (count === 1) throw new ToolExecutionError('STALE_ELEMENT_UID', 'Match changed during binding.', { reason: 'locator_match_changed' });
    return binding(count);
  } });
  await changed.run('act_on_element', { locator: query, action: 'select', value: 'choice' });
  assert.equal(changed.scans.length, 2); assert.equal(changed.dispatched.length, 1);
  const scoped = pageFixture({ locate: () => { throw stale('uid:scope'); } });
  await assert.rejects(scoped.run('act_on_element', { locator: { ...query, within: 'uid:scope' }, action: 'select', value: 'choice' }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(scoped.scans.length, 1);
  const unknown = pageFixture({ beforeUse: () => { throw stale(); } });
  await assert.rejects(unknown.run('act_on_element', { locator: query, action: 'select', value: 'choice' }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(unknown.scans.length, 1);
  const pinned = pageFixture({ beforeUse: ref => { throw stale(ref.target); } });
  await assert.rejects(pinned.run('act_on_element', { target: 'uid:source', action: 'drag', destination: { locator: query } }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(pinned.scans.length, 0, 'a dynamic destination cannot authorize retargeting the pinned source');
});

test('a lost response after input never re-resolves or replays a locator action', async () => {
  const f = pageFixture({ dispatch: () => { throw stale(); } });
  await assert.rejects(f.run('act_on_element', { locator: query, action: 'select', value: 'choice' }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(f.scans.length, 1); assert.equal(f.dispatched.length, 1);
});

test('an absent locator respects the parent deadline and cancellation before input', async () => {
  const f = pageFixture({ locate: () => null });
  await assert.rejects(f.run('act_on_element', { locator: query, action: 'select', value: 'choice', timeout: 120 },
    { deadlineAt: Date.now() + 20 }), { code: 'ELEMENT_NOT_READY' });
  assert.equal(f.dispatched.length, 0);
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(f.run('act_on_element', { locator: query, action: 'select', value: 'choice' }, {}, controller.signal), /stopped/);
  assert.equal(f.dispatched.length, 0);
});

test('locator reads resolve once and missing or ambiguous matches do not become waits', async () => {
  for (const name of ['inspect_element', 'read_article']) {
    const args = { locator: query, ...(name === 'read_article' ? { source: 'target', limit: 1000 } : {}) };
    const f = pageFixture();
    assert.equal(f.definitions.get(name).behavior.timeoutResult(args), undefined, 'locator reads must not publish an empty successful partial');
    const result = await f.run(name, args);
    assert.equal(f.scans.length, 1); assert.equal(result.target, 'uid:t7.000001.1');
    const absent = pageFixture({ locate: () => null });
    await assert.rejects(absent.run(name, args), { code: 'ELEMENT_NOT_FOUND' });
    assert.equal(absent.scans.length, 1);
    const ambiguous = pageFixture({ locate: () => { throw new ToolExecutionError('AMBIGUOUS_ELEMENT', 'Two matches.'); } });
    await assert.rejects(ambiguous.run(name, args), { code: 'AMBIGUOUS_ELEMENT' });
    assert.equal(ambiguous.scans.length, 1);
  }
});

function waitFixture(states) {
  const definitions = new Map(), located = []; let scans = 0, counts = 0, current;
  registerWaitTools({ registerTool: definition => definitions.set(definition.name, definition),
    element: {
      async resolveLocatorTarget(_tabId, locator) { located.push(locator); current = states[Math.min(scans++, states.length - 1)]; if (current?.error) throw current.error; return current?.attached ? binding(scans) : null; },
      async countLocatorMatches(_tabId, locator) { located.push(locator); return states[Math.min(counts++, states.length - 1)].count; },
      async callElement(_id, _ref, _action, args) { if (current.presenceError) throw current.presenceError; const found = current.attached && (!args.visibleOnly || current.visible); return { found, element: found ? { text: 'node' } : null }; },
      async addElementTargetsToFindResult(value, _id, _context, ref) { return { ...value, target: `uid:t7.000001.${ref.backendNodeId}` }; },
      elementTargetForSelector: value => `css:${value}`,
    },
  });
  return { definitions, located, scans: () => scans, counts: () => counts,
    run(input) {
      const definition = definitions.get('wait_for_element');
      definition.validateArgs(input);
      return definition.execute({ tabId: 7, timeout: 0.2, intervalSeconds: 0.001, ...input }, undefined, { requestedTabRef: 'page' });
    },
  };
}

test('state waits rescan locators and distinguish hidden nodes from detached nodes', async () => {
  const hidden = waitFixture([{ attached: true, visible: false }]);
  assert.equal((await hidden.run({ locator: query, state: 'hidden' })).state, 'hidden');
  assert.equal(hidden.scans(), 1);
  const detached = waitFixture([{ attached: true, visible: false }, { attached: false }]);
  assert.equal((await detached.run({ locator: query, state: 'detached' })).state, 'detached');
  assert.equal(detached.scans(), 2);
  const visible = waitFixture([{ attached: false }, { attached: true, visible: true }]);
  assert.equal((await visible.run({ locator: query })).target, 'uid:t7.000001.2');
  assert.equal(visible.scans(), 2);
  const loading = waitFixture([{ error: new ToolExecutionError('CONTENT_SCRIPT_NOT_READY', 'Loading.') }, { attached: true, visible: true }]);
  assert.equal((await loading.run({ locator: query })).found, true);
  assert.equal(loading.scans(), 2);
  const replaced = waitFixture([{ attached: true, presenceError: stale(binding(1).target) }, { attached: true, visible: true }]);
  assert.equal((await replaced.run({ locator: query })).target, 'uid:t7.000001.2');
  assert.equal(replaced.scans(), 2);
  const original = waitFixture([{ attached: true, presenceError: stale(binding(1).target) }]);
  assert.equal((await original.run({ locator: { target: 'uid:original' }, state: 'detached' })).found, false);
  assert.equal(original.scans(), 1, 'an explicit UID wait observes disappearance, without selecting a replacement');
});

test('attachment states query hidden nodes too, while visibility states and counts keep the locator as given', async () => {
  for (const [state, includeHidden] of [['attached', true], ['detached', true], ['visible', undefined], ['hidden', undefined]]) {
    const f = waitFixture([{ attached: state !== 'detached', visible: state !== 'hidden' }]);
    await f.run({ locator: query, state });
    assert.equal(f.located[0].includeHidden, includeHidden, state);
  }
  const explicit = waitFixture([{ attached: true, visible: true }]);
  await explicit.run({ locator: { ...query, includeHidden: false }, state: 'attached' });
  assert.equal(explicit.located[0].includeHidden, false, 'an explicit includeHidden wins');
  const counted = waitFixture([{ count: 1 }]);
  await counted.run({ locator: query, count: 1 });
  assert.equal(counted.located[0].includeHidden, undefined);
});

test('count waits include zero, use count-only queries and reject state/count ambiguity', async () => {
  const f = waitFixture([{ count: 2 }, { count: 0 }]);
  assert.deepEqual(await f.run({ locator: query, count: 0 }), { count: 0 });
  assert.equal(f.counts(), 2); assert.equal(f.scans(), 0);
  for (const input of [{ locator: query, count: 1, state: 'visible' }, { target: 'css:button', count: 1 }, { locator: query, count: -1 }]) {
    assert.throws(() => f.run(input), { code: 'INVALID_ELEMENT_WAIT' });
  }
});

test('locator waits retry a new-match binding race but preserve pinned and scope failures', async () => {
  const changed = new ToolExecutionError('STALE_ELEMENT_UID', 'The selected match changed.', { reason: 'locator_match_changed' });
  const dynamic = waitFixture([{ error: changed }, { attached: true, visible: true }]);
  assert.equal((await dynamic.run({ locator: query })).found, true);
  assert.equal(dynamic.scans(), 2);
  const pinned = waitFixture([{ error: changed }]);
  await assert.rejects(pinned.run({ locator: { target: 'uid:original' } }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(pinned.scans(), 1);
  const scoped = waitFixture([{ error: stale('uid:scope') }]);
  await assert.rejects(scoped.run({ locator: { ...query, within: 'uid:scope' } }), { code: 'STALE_ELEMENT_UID' });
  assert.equal(scoped.scans(), 1);
});

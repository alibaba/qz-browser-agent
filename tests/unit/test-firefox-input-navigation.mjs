import assert from 'node:assert/strict';
import test from 'node:test';
import { registerPageElementTools } from '../../src/capabilities/page/tools.js';
import { installFirefoxDebugger } from '../../src/background/firefox/debugger-host.js';
import { createCdpRuntime } from '../../src/background/tools/cdp-runtime.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

const MISSING = 'Missing host permission for the tab';
const BEFORE = 'http://127.0.0.1/form.html';
const AFTER = 'http://127.0.0.1/fast.html';
const faults = ['keydown-response', 'keyup-route', 'keyup-input'];
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => { for (const fn of listeners) fn(...args); } };
}

// Real page action, keyboard, CDP lease and Firefox adapter. Only browser APIs and
// Content replies are simulated; no Firefox 151 behavior substitutes for 158.
function fixture(t, { fault = '', navigation = true, sameUrl = false, interrupt = '',
  commitDelay = 0, errorKind = 'result-object', commitDuringPrepare = '', frameId = 0,
  commitFrameId = frameId, commitTabId = 7, key = 'Enter' } = {}) {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  const controller = new AbortController();
  const trace = [], submissions = [], keys = [], keyFrames = [], hostErrors = [];
  const original = errorKind === 'missing-string' ? MISSING : errorKind === 'reject-value' ? { reason: 'unloading' }
    : new Error(errorKind === 'world-error' ? 'ISOLATED world disappeared' : 'unrelated failure');
  let value = '', committed = false, scheduled = false, removed = false, current = true, execute, method = '', finishProbe;
  const timers = new Set();
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const revoke = () => {
    if (interrupt.startsWith('abort')) controller.abort(new ToolExecutionError('OPERATION_ABORTED', 'cancelled'));
    if (interrupt.startsWith('close')) { removed = true; api.tabs.onRemoved.emit(7); }
    if (interrupt.startsWith('run')) current = false;
  };
  const api = {
    runtime: { getURL: () => 'moz-extension://fixture/', onMessage: event() },
    storage: { local: { async get() { return {}; } } },
    tabs: { onUpdated: event(), onRemoved: event(), async get() {
      if (removed) throw new Error('No tab with id: 7');
      return { id: 7, url: committed && !sameUrl ? AFTER : BEFORE, title: committed ? 'After' : 'Before', status: 'complete' };
    } },
    webNavigation: { onCommitted: event(), async getAllFrames() {
      return [{ frameId: 0, parentFrameId: -1, url: (await api.tabs.get()).url },
        ...(frameId ? [{ frameId, parentFrameId: 0, url: BEFORE }] : [])];
    } },
    scripting: { async executeScript({ args, target }) {
      const command = args?.[0], op = command?.op, input = command?.input;
      const stage = op === 'inputFrame' && method === 'Input.dispatchKeyEvent' ? (keys.length ? 'keyup-route' : 'prepare')
        : op === 'input' && input?.kind === 'key' ? (input.type === 'keyUp' ? 'keyup-input' : 'keydown-response')
          : typeof command === 'string' && args[1] === false ? 'receipt' : !args ? 'observation' : op || 'other';
      trace.push(stage);
      if (op === 'input' && input?.kind === 'text') value = input.text;
      if (op === 'input' && input?.kind === 'key') {
        keys.push(input.type);
        keyFrames.push(target.frameIds[0]);
        if (input.type !== 'keyUp') {
          submissions.push(value);
          if (!['keyup-route', 'keyup-input'].includes(fault)) commit();
        }
      }
      if (stage === 'prepare' && commitDuringPrepare) {
        commit();
        if (commitDuringPrepare === 'failure') throw original;
      }
      if (stage === fault && (stage !== 'observation' || keys.length)) {
        if (interrupt === 'defer') return new Promise(resolve => { finishProbe = () => resolve([{ frameId: 0, result: {} }]); });
        if (keys.length) commit();
        if (interrupt.endsWith('-later')) later(revoke, 10); else revoke();
        if (errorKind.startsWith('result-')) return [{ frameId: target.frameIds[0],
          error: errorKind === 'result-object' ? { message: 'old document unloading' } : new Error('old document unloading') }];
        throw original;
      }
      const result = op === 'inputFrame' && frameId && target.frameIds[0] === 0 ? { backendNodeId: 42 }
        : op === 'owners' ? { frames: [{ backendNodeId: 42, url: BEFORE }] }
          : op ? {} : args ? (args[1] ? 0 : 1) : { width: 800, height: 600 };
      return [{ frameId: target.frameIds?.[0] ?? 0, documentId: committed ? 'after' : 'before', result }];
    } },
  };
  function commit() {
    if (!navigation || scheduled) return;
    scheduled = true;
    const publish = () => {
      committed = commitTabId === 7 && (commitFrameId === 0 || commitFrameId === frameId);
      api.webNavigation.onCommitted.emit({ tabId: commitTabId, frameId: commitFrameId, url: sameUrl ? BEFORE : AFTER });
      if (committed) api.tabs.onUpdated.emit(7, { status: 'complete', url: sameUrl ? BEFORE : AFTER });
    };
    if (commitDelay) later(publish, commitDelay); else publish();
  }
  globalThis.chrome = api;
  installFirefoxDebugger(api);
  for (const name of ['sendCommand', 'sendCommandWithScope']) {
    const originalSend = api.debugger[name].bind(api.debugger);
    api.debugger[name] = async (target, command, ...args) => {
      method = command;
      try { return await originalSend(target, command, ...args); }
      catch (error) { if (command === 'Input.dispatchKeyEvent') hostErrors.push(error); throw error; }
    };
  }
  const cdp = createCdpRuntime({ ToolExecutionError, debuggerApi: api.debugger, isRunCurrent: () => current });
  const context = { sessionId: 'owner', runId: 'run', signal: controller.signal, runProfile: { platform: { os: 'mac' } } };
  const inspect = () => ({ tag: 'input', type: 'text', editable: true, focused: true, visible: true, value,
    clickablePoint: { x: 10, y: 10 }, inViewport: true });
  const content = async (_tabId, action) => {
    return { ...inspect(), ...(action === 'prepareElementFill' ? { fillMode: 'text' } : {}) };
  };
  api.tabs.sendMessage = async () => ({});
  registerPageElementTools({
    ToolExecutionError,
    registerTool(definition) { if (definition.name === 'act_on_element') execute = definition.execute; },
    resolveElementReference: async (tabId, { target, index }) => ({ tabId, target, index, selector: '#q' }),
    elementTargetForSelector: selector => `css:${selector}`, getElementTargetDescription: () => 'fixture',
    sendToContent: content, getPageContext: () => ({ pageMode: 'desktop' }), clickPointReady: () => true,
    getTabPageState: async () => ({ url: BEFORE, title: 'Before' }),
    pageStateDelta: (before, after) => ({ pageBefore: before, pageAfter: after,
      urlChanged: before.url !== after.url, titleChanged: before.title !== after.title }),
    prepareKnownPageNavigation: async () => null, commitObservedPageNavigation: () => null,
    getDebuggerConnectionId: cdp.getDebuggerConnectionId, sendCdp: cdp.sendCdp, withDebugger: cdp.withDebugger,
  });
  t.after(() => cdp.releaseSession('owner'));
  return { trace, keys, keyFrames, submissions, original, hostErrors, get finishProbe() { return finishProbe; },
    abort: () => controller.abort(new ToolExecutionError('OPERATION_ABORTED', 'cancelled')),
    call: (action, value = 'one') => execute({ tabId: 7, target: 'css:#q', action, value, submit: true, key }, controller.signal, context) };
}

function oneSubmission(f, fault, navigated = true) {
  assert.equal(f.submissions.length, 1, 'never replay Enter');
  assert.deepEqual(f.keys, fault === 'keyup-input' || !navigated ? ['keyDown', 'keyUp'] : ['keyDown']);
  assert.equal(f.trace.filter(stage => stage === 'prepare').length, 1);
  assert.ok(f.trace.filter(stage => stage === 'keyup-route').length <= 1, 'no route retry');
}
function originalError(f, kind) {
  return error => {
    assert.equal(error, f.hostErrors[0], 'preserve the original host error');
    if (kind.startsWith('result-')) assert.equal(error.message, 'Firefox page command failed');
    else assert.equal(error, f.original, 'preserve non-Error rejection identity too');
    return true;
  };
}

const outcomes = [
  { name: 'commit within 1s succeeds once', commitDelay: 40, delivered: true, url: AFTER },
  { name: 'same-URL commit is delivery', sameUrl: true, delivered: true, url: BEFORE },
];
// Error and non-Error rejections are the two identities. Faults are columns of one row.
const errorIdentity = [
  { name: 'Error', errorKind: 'world-error' },
  { name: 'non-Error rejection', errorKind: 'reject-value' },
];

for (const action of ['fill', 'press']) {
  for (const row of outcomes) test(`Firefox ${action}: ${row.name}`, async t => {
    for (const fault of faults) {
      const f = fixture(t, { fault, errorKind: 'result-object', commitDelay: row.commitDelay, sameUrl: row.sameUrl });
      const result = await f.call(action);
      assert.equal(result.error, undefined, fault);
      assert.equal(result.navigated, true, fault);
      assert.equal(result.pageAfter.url, row.url, fault);
      assert.equal(action === 'fill' ? result.submitDispatched : result.pressed, true, fault);
      oneSubmission(f, fault);
    }
  });
  for (const identity of errorIdentity) test(`Firefox ${action}: no commit preserves ${identity.name}`, async t => {
    for (const fault of faults) {
      const f = fixture(t, { fault, errorKind: identity.errorKind, navigation: false });
      const start = Date.now();
      await assert.rejects(f.call(action), originalError(f, identity.errorKind));
      assert.ok(Date.now() - start >= 950, `${fault} allows one second for commit`);
      assert.ok(Date.now() - start < 1800, `${fault} uses one recovery window`);
      assert.equal(f.submissions.length, 1, fault);
      assert.equal(f.keys.filter(type => type === 'keyUp').length, fault === 'keyup-input' ? 1 : 0, fault);
      assert.equal(f.trace.filter(stage => stage === 'prepare').length, 1, fault);
      assert.equal(f.trace.filter(stage => stage === 'keyup-route').length, fault === 'keydown-response' ? 0 : 1, fault);
    }
  });
  for (const identity of errorIdentity) test(`Firefox ${action}: prepare / ${identity.name} fails once before input`, async t => {
    const f = fixture(t, { fault: 'prepare', errorKind: identity.errorKind });
    await assert.rejects(f.call(action), originalError(f, identity.errorKind));
    assert.deepEqual(f.keys, []);
    assert.equal(f.trace.filter(stage => stage === 'prepare').length, 1);
  });
  for (const commitDuringPrepare of ['success', 'failure']) for (const frameId of [0, 4]) {
    test(`Firefox ${action}: document ${frameId} changes during ${commitDuringPrepare} prepare, no dispatch`, async t => {
      const f = fixture(t, { commitDuringPrepare, frameId });
      await assert.rejects(f.call(action), commitDuringPrepare === 'failure' ? error => error === f.original : undefined);
      assert.deepEqual(f.keys, []);
      assert.ok(f.trace.filter(stage => stage === 'prepare').length <= (frameId ? 2 : 1), 'one route traversal only');
    });
  }
  for (const commitFrameId of [0, 4]) test(`Firefox ${action}: main/target frame ${commitFrameId} commit skips child keyUp`, async t => {
    const f = fixture(t, { fault: 'keydown-response', frameId: 4, commitFrameId, commitDelay: 40 });
    assert.equal((await f.call(action)).navigated, true);
    assert.deepEqual(f.keys, ['keyDown']);
    assert.deepEqual(f.keyFrames, [4]);
  });
  for (const unrelated of [{ commitFrameId: 9 }, { commitTabId: 8 }]) {
    test(`Firefox ${action}: unrelated commit ${JSON.stringify(unrelated)} cannot confirm input`, async t => {
      const f = fixture(t, { fault: 'keydown-response', ...unrelated });
      await assert.rejects(f.call(action), originalError(f, 'result-object'));
      assert.deepEqual(f.keys, ['keyDown']);
    });
  }
  test(`Firefox ${action}: commit after one second does not recover an error`, async t => {
    const f = fixture(t, { fault: 'keydown-response', commitDelay: 1200 });
    await assert.rejects(f.call(action), originalError(f, 'result-object'));
    assert.deepEqual(f.keys, ['keyDown']);
  });
  test(`Firefox ${action}: commit during successful keyUp probe skips dispatch`, async t => {
    const f = fixture(t, { fault: 'keyup-route', interrupt: 'defer' });
    const pending = f.call(action);
    await new Promise(setImmediate);
    // The probe is in flight; publish the commit before its successful reply.
    globalThis.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, url: AFTER });
    f.finishProbe();
    await pending;
    assert.deepEqual(f.keys, ['keyDown']);
  });
  for (const fault of action === 'fill' ? ['observation'] : ['observation', 'receipt']) test(`Firefox ${action}: ${fault} failure after input keeps navigation results`, async t => {
    const f = fixture(t, { fault });
    assert.equal((await f.call(action)).navigated, true);
    assert.equal(f.submissions.length, 1);
  });
  for (const interrupt of ['abort', 'close', 'run', 'abort-later', 'close-later', 'run-later']) {
    test(`Firefox ${action}: ${interrupt} revokes recovery`, async t => {
      for (const fault of faults) {
        const f = fixture(t, { fault, interrupt, commitDelay: interrupt.endsWith('-later') ? 40 : 0 });
        await assert.rejects(f.call(action));
        const count = f.trace.length;
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(f.trace.length, count, `${fault} sends no late probes or input after revocation`);
        assert.equal(f.submissions.length, 1, fault);
        assert.equal(f.keys.filter(type => type === 'keyUp').length, fault === 'keyup-input' ? 1 : 0, `${fault} sends no late keyUp`);
      }
    });
  }
  test(`Firefox ${action}: cancelling an in-flight frame probe prevents input after its late reply`, async t => {
    const f = fixture(t, { fault: 'prepare', interrupt: 'defer' });
    const pending = f.call(action);
    const rejected = assert.rejects(pending);
    await new Promise(setImmediate);
    f.abort();
    await rejected;
    const count = f.trace.length;
    f.finishProbe();
    await new Promise(setImmediate);
    assert.equal(f.trace.length, count);
    assert.deepEqual(f.keys, []);
  });
  test(`Firefox ${action}: no navigation, no error sends exactly one keyDown/keyUp`, async t => {
    const f = fixture(t, { navigation: false });
    assert.equal((await f.call(action)).navigated, false);
    oneSubmission(f, '', false);
  });
}

test('Firefox fill: 12 unique submits, two keyUp injections fail while the old document unloads', async t => {
  for (let i = 1; i <= 12; i++) await t.test(`submit ${i}`, async t => {
    const f = fixture(t, { fault: [4, 7].includes(i) ? 'keyup-input' : '', commitDelay: [4, 7].includes(i) ? 40 : 0 });
    const result = await f.call('fill', `unique-${i}`);
    assert.equal(result.submitDispatched, true);
    assert.equal(result.navigated, true);
    assert.deepEqual(f.submissions, [`unique-${i}`]);
    assert.ok(f.keys.filter(type => type === 'keyUp').length <= 1);
  });
});

test('Firefox modified Enter retains failure even with a navigation commit', async t => {
  const f = fixture(t, { fault: 'keydown-response', key: 'Shift+Enter' });
  await assert.rejects(f.call('press'), originalError(f, 'result-object'));
});

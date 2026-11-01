import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolCallParent, withToolCallLifecycle } from '../../src/background/tools/call-lifecycle.js';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';

for (const runId of [undefined, '', 'run-1']) {
  test(`parent identity stays session/run scoped with runId=${String(runId)}`, async () => {
    const controller = new AbortController();
    let scoped, parent;
    await withToolCallLifecycle({ sessionId: 'session-1', runId, signal: controller.signal }, async context => {
      scoped = context;
      parent = getToolCallParent(context.toolExecutionId, 'session-1', runId ?? '');
      assert.ok(parent);
      assert.equal(parent.signal.aborted, false);
      for (const otherRun of runId ? ['', 'run-2'] : ['run-1', 'run-2']) {
        assert.equal(getToolCallParent(context.toolExecutionId, 'session-1', otherRun), undefined);
      }
      assert.equal(getToolCallParent(context.toolExecutionId, 'session-2', runId ?? ''), undefined);
      assert.equal(getToolCallParent('unknown', 'session-1', runId ?? ''), undefined);
    });
    assert.equal(scoped.signal, controller.signal);
    assert.equal(scoped.signal.aborted, false, 'success must not abort the tool signal');
    assert.equal(parent.signal.aborted, true, 'success revokes descendant authority');
    assert.equal(getToolCallParent(scoped.toolExecutionId, 'session-1', runId ?? ''), undefined);
  });
}

test('parent failure revokes children without changing the tool signal', async () => {
  const controller = new AbortController();
  const failure = new Error('fixture failure');
  let parent;
  await assert.rejects(withToolCallLifecycle({ sessionId: 's', runId: 'r', signal: controller.signal }, async context => {
    parent = getToolCallParent(context.toolExecutionId, 's', 'r');
    throw failure;
  }), error => error === failure);
  assert.equal(controller.signal.aborted, false);
  assert.equal(parent.signal.aborted, true);
  assert.equal(getToolCallParent(parent.toolExecutionId, 's', 'r'), undefined);
});

test('cancellation revokes parent lookup and descendants before the handler settles', async () => {
  const controller = new AbortController();
  await withToolCallLifecycle({ sessionId: 's', runId: 'r', signal: controller.signal }, async context => {
    const parent = getToolCallParent(context.toolExecutionId, 's', 'r');
    controller.abort();
    assert.equal(context.signal.aborted, true);
    assert.equal(parent.signal.aborted, true);
    assert.equal(getToolCallParent(context.toolExecutionId, 's', 'r'), undefined);
  });
  await withToolCallLifecycle({ sessionId: 's', runId: 'r', signal: controller.signal }, async context => {
    assert.equal(getToolCallParent(context.toolExecutionId, 's', 'r'), undefined);
  });
});

for (const runId of [undefined, '']) test(`runless bridge accepts only a live exact parent: ${String(runId)}`, async () => {
  let calls = 0, childSignal, finishChild;
  const pending = new Promise(resolve => { finishChild = resolve; });
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => false, getAbortSignal: () => undefined },
    getRuntime: () => ({ status: 'idle' }), canManageSessions: async () => false,
    buildRunProfile: async () => ({}), collectArtifacts: () => [],
    toolRuntime: {
      getSchemas: () => [], resolveDefinition: () => ({}),
      execute: async (_name, _args, signal) => { calls++; childSignal = signal; return pending; },
    },
  });
  let message, child;
  await withToolCallLifecycle({ sessionId: 's', runId }, async context => {
    message = { sessionId: 's', runId: '', parentCallId: context.toolExecutionId, toolName: 'fixture' };
    for (const invalid of [{ sessionId: 'other' }, { runId: 'new-run' }, { parentCallId: '' }]) {
      assert.equal((await bridge.handleToolCall({ ...message, ...invalid })).code, 'RUN_STOPPED');
    }
    child = bridge.handleToolCall(message);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.equal(childSignal.aborted, false);
    assert.equal(context.signal, undefined, 'no synthetic tool cancellation signal');
  });
  assert.equal(childSignal.aborted, true);
  finishChild({ ok: true });
  assert.equal((await child).code, 'RUN_STOPPED', 'late success cannot publish after parent settlement');
  assert.equal((await bridge.handleToolCall(message)).code, 'RUN_STOPPED');
  assert.equal(calls, 1, 'late call does not execute');
});

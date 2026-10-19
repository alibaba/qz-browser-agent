import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { createSessionSupervisor } from '../../src/background/session/supervisor.js';
import { createInitialSessionRuntime, reduceSessionRuntime } from '../../src/background/session/runtime-reducer.js';
import { createTestAgentOptions, createTestAgentServices } from '../support/agent-services.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { config, onEvent, model } = {}) {
  const events = [];
  const snapshots = [];
  const calls = [];
  let runtime = createInitialSessionRuntime('lifecycle');
  const supervisor = createSessionSupervisor({
    createAgent: lease => new Agent('lifecycle', createTestAgentOptions({
      conversationLease: lease,
      canStartQueuedRun: async () => {
        await supervisor.waitForTaskRelease('lifecycle');
        return true;
      },
      services: createTestAgentServices(config ? { getRuntimeConfig: config } : {}),
      llm: {
        async *chatStream(messages) {
          calls.push(structuredClone(messages));
          await model?.(calls.length);
          yield { type: 'done', message: { role: 'assistant', content: `answer ${calls.length}` } };
        },
        async chat() { throw new Error('unexpected fallback'); },
      },
    })),
    onAgentEvent(_id, event) {
      events.push(event);
      runtime = reduceSessionRuntime(runtime, event);
      snapshots.push({ event: event.type, runtime: structuredClone(runtime) });
      return onEvent?.(event, runtime);
    },
  });
  const agent = await supervisor.getAgent('lifecycle');
  t.after(() => { agent._clearScheduledFollowUpRun(); agent.abort(); });
  return { agent, supervisor, events, snapshots, calls, runtime: () => runtime };
}

const runConfig = { provider: 'test', model: 'test-model', contextWindow: 262000, vision: true };

test('consecutive queued runs stay pending through slow initialization and accept each message once', async t => {
  const firstModel = deferred(), releaseFirst = deferred(), secondInit = deferred(), releaseInit = deferred(), finished = deferred();
  t.after(() => { releaseFirst.resolve(); releaseInit.resolve(); });
  let configurations = 0, ends = 0;
  const f = await fixture(t, {
    async config() {
      if (++configurations === 2) { secondInit.resolve(); await releaseInit.promise; }
      return runConfig;
    },
    async model(call) { if (call === 1) { firstModel.resolve(); await releaseFirst.promise; } },
    onEvent(event) { if (event.type === 'agent_end' && ++ends === 3) finished.resolve(); },
  });
  const first = f.agent.prompt('first', {}, [], 'first');
  await firstModel.promise;
  f.agent.followUp('second', [], 'second');
  f.agent.followUp('third', [], 'third');
  releaseFirst.resolve();
  await first;
  await secondInit.promise;
  assert.equal(f.runtime().status, 'pending');
  assert.equal(f.agent.isRunning, true);
  assert.equal(f.agent.isStreaming, false);
  assert.equal(f.agent.getRunState().runId, null, 'execution has not started during configuration');
  assert.deepEqual(f.agent.getPendingFollowUps().map(message => message.clientMessageId), ['second', 'third']);
  assert.equal(await f.agent._runNextFollowUpRun(), false, 'the existing occupancy rejects a second queue drain');
  releaseInit.resolve();
  await finished.promise;
  await f.agent.waitForIdle();
  assert.equal(f.runtime().status, 'completed');
  assert.equal(f.agent.isRunning, false);
  assert.deepEqual(f.agent.messages.filter(message => message.role === 'user' && message.clientMessageId).map(message => message.clientMessageId), ['first', 'second', 'third']);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.snapshots.filter(snapshot => snapshot.event === 'agent_end').map(snapshot => snapshot.runtime.status), ['pending', 'pending', 'completed']);
  assert.ok(f.snapshots.every(({ runtime }) => runtime.status !== 'completed'
    || (!runtime.pendingFollowUpMessages.length && !runtime.pendingSteeringMessages.length)));
});

test('queued admission waits for all writes and keeps steering visible through prioritized startup', async t => {
  const firstWrite = deferred(), secondWrite = deferred(), initializing = deferred(), releaseInit = deferred();
  t.after(() => { firstWrite.resolve(); secondWrite.resolve(); releaseInit.resolve(); });
  const f = await fixture(t, {
    async config() { initializing.resolve(); await releaseInit.promise; return runConfig; },
  });
  const first = f.agent.followUp('steering', [], 'steering', [], () => firstWrite.promise);
  const second = f.agent.followUp('follow-up', [], 'follow-up', [], () => secondWrite.promise);
  f.agent.steerFollowUp('steering');
  assert.equal(await f.agent._runNextFollowUpRun(), false);
  firstWrite.resolve();
  await first;
  assert.equal(await f.agent._runNextFollowUpRun(), false, 'the remaining write still blocks either queue');
  assert.equal(f.calls.length, 0);
  secondWrite.resolve();
  await second;
  f.agent._clearScheduledFollowUpRun();
  const run = f.agent._runNextFollowUpRun();
  await initializing.promise;
  assert.equal(f.runtime().status, 'pending');
  assert.deepEqual(f.agent.getPendingSteerings().map(message => message.clientMessageId), ['steering']);
  assert.deepEqual(f.agent.getPendingFollowUps().map(message => message.clientMessageId), ['follow-up']);
  assert.equal(f.calls.length, 0, 'neither queue is consumed before initialization completes');
  releaseInit.resolve();
  await run;
  assert.deepEqual(f.agent.messages.filter(message => message.clientMessageId).map(message => message.clientMessageId), ['steering']);
  assert.equal(f.runtime().status, 'pending', 'the ordinary follow-up remains for the next run');
  f.agent._clearScheduledFollowUpRun();
  await f.agent._runNextFollowUpRun();
  assert.equal(f.runtime().status, 'completed');
  assert.equal(f.calls.length, 2);
});

test('startup failures before handoff retain acknowledged input without retrying the same message', async t => {
  for (const [stage, deliveryMode] of ['configuration', 'context'].flatMap(stage => ['follow_up', 'steer'].map(mode => [stage, mode]))) {
    let fail = true;
    const f = await fixture(t, {
      async config() { if (fail && stage === 'configuration') throw new Error('configuration unavailable'); return runConfig; },
    });
    const refreshContext = f.agent._refreshDynamicContextSnapshot.bind(f.agent);
    f.agent._refreshDynamicContextSnapshot = async (...args) => {
      if (fail && stage === 'context') throw new Error('context unavailable');
      return refreshContext(...args);
    };
    await f.agent.followUp('accepted request', [], 'accepted', [], async () => {}, deliveryMode);
    f.agent._clearScheduledFollowUpRun();
    const failure = await f.agent._runNextFollowUpRun().catch(error => error);
    if (stage === 'configuration') assert.match(failure.message, /configuration unavailable/);
    assert.equal(f.runtime().status, 'error');
    assert.equal(f.runtime().reason, `${stage} unavailable`);
    assert.equal(f.agent.isRunning, false);
    assert.equal(f.agent.getAbortSignal(), null);
    assert.equal(f.agent._followUpRunTimer, null, 'failed initialization must not blindly retry accepted work');
    assert.ok(f.agent.findPendingUserMessage('accepted'));
    assert.equal(f.agent.findAcceptedUserMessage('accepted'), null);
    assert.equal(f.calls.length, 0);
    fail = false;
    await f.agent._runNextFollowUpRun();
    assert.equal(f.runtime().status, 'completed');
    assert.equal(f.agent.hasPendingUserInput(), false);
    assert.equal(f.agent.messages.filter(message => message.clientMessageId === 'accepted').length, 1);
    assert.equal(f.calls.length, 1);
  }
});

test('cancellation during initialization releases occupancy and preserves the accepted queue', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { async config() { entered.resolve(); await release.promise; return runConfig; } });
  f.agent.followUp('queued request', [], 'queued');
  f.agent._clearScheduledFollowUpRun();
  const run = f.agent._runNextFollowUpRun();
  await entered.promise;
  f.agent.abort();
  release.resolve();
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(f.runtime().status, 'aborted');
  assert.equal(f.agent.isRunning, false);
  assert.equal(f.agent.getAbortSignal(), null);
  assert.ok(f.agent.findPendingUserMessage('queued'));
  assert.equal(f.events.filter(event => event.type === 'agent_start').length, 0);
  assert.equal(f.agent._followUpRunTimer, null);
});

test('supervisor admission and waitForIdle honor initialization and terminal persistence occupancy', async t => {
  const init = deferred(), releaseInit = deferred(), terminal = deferred(), releaseTerminal = deferred();
  t.after(() => { releaseInit.resolve(); releaseTerminal.resolve(); });
  const f = await fixture(t, {
    async config() { init.resolve(); await releaseInit.promise; return runConfig; },
    onEvent(event) { if (event.type === 'agent_end') { terminal.resolve(); return releaseTerminal.promise; } },
  });
  const run = f.agent._runWithLifecycle();
  await init.promise;
  assert.equal(f.agent.hasPendingUserInput(), false);
  await assert.rejects(f.supervisor.startTask('lifecycle', async () => {}), { code: 'SESSION_ALREADY_RUNNING' });
  await assert.rejects(f.agent.compactContext(), { code: 'AGENT_ALREADY_RUNNING' });
  let idle = false;
  const waiting = f.supervisor.waitForIdle('lifecycle').then(() => { idle = true; });
  releaseInit.resolve();
  await terminal.promise;
  assert.equal(f.agent.isStreaming, false);
  assert.equal(f.agent.isRunning, true);
  assert.equal(idle, false);
  await assert.rejects(f.agent._runWithLifecycle(), /Already running/);
  await assert.rejects(f.supervisor.startTask('lifecycle', async () => {}), { code: 'SESSION_ALREADY_RUNNING' });
  releaseTerminal.resolve();
  await Promise.all([run, waiting]);
  assert.equal(f.agent.isRunning, false);
  assert.equal(idle, true);
});

for (const mode of ['follow_up', 'steer']) test(`removing the final ${mode} during terminal commit finishes the pending handoff`, async t => {
  const model = deferred(), releaseModel = deferred(), terminal = deferred(), releaseTerminal = deferred();
  t.after(() => { releaseModel.resolve(); releaseTerminal.resolve(); });
  const f = await fixture(t, {
    async model() { model.resolve(); await releaseModel.promise; },
    onEvent(event) { if (event.type === 'agent_end') { terminal.resolve(); return releaseTerminal.promise; } },
  });
  const run = f.agent.prompt('first', {}, [], 'first');
  await model.promise;
  f.agent.followUp('remove this', [], 'removed');
  releaseModel.resolve();
  await terminal.promise;
  assert.equal(f.runtime().status, 'pending');
  if (mode === 'steer') f.agent.steerFollowUp('removed');
  await f.agent[mode === 'steer' ? 'removeSteering' : 'removeFollowUp']('removed');
  assert.equal(f.runtime().status, 'pending', 'the terminal commit still owns the transition');
  releaseTerminal.resolve();
  await run;
  assert.equal(f.runtime().status, 'completed');
  assert.equal(f.agent.hasPendingUserInput(), false);
  assert.equal(f.calls.length, 1);
});

test('accepted follow-ups cannot overtake initial task preparation or lose a delayed release wakeup', async t => {
  const preparing = deferred(), releasePreparation = deferred(), model = deferred(), releaseModel = deferred();
  const queueHeld = deferred(), releaseQueue = deferred();
  t.after(() => { releasePreparation.resolve(); releaseModel.resolve(); releaseQueue.resolve(); });
  const f = await fixture(t, { async model(call) { if (call === 1) { model.resolve(); await releaseModel.promise; } } });
  const first = await f.supervisor.startTask('lifecycle', async ({ agent }) => {
    preparing.resolve();
    await releasePreparation.promise; // collectBrowserContext / prompt's pre-run persistence
    await agent.prompt('first', {}, [], 'first');
  });
  await preparing.promise;
  const queued = await f.supervisor.submitMessage('lifecycle', {
    executor() { assert.fail('the follow-up must queue behind initial task preparation'); },
    enqueue: ({ agent }) => { agent.followUp('second', [], 'second'); return {}; },
  });
  assert.equal(queued.disposition, 'queued');
  f.agent._clearScheduledFollowUpRun();
  const next = f.agent._runNextFollowUpRun();
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  releasePreparation.resolve();
  await model.promise;
  const blockingCommand = f.supervisor.withRuntime('lifecycle', async () => { queueHeld.resolve(); await releaseQueue.promise; });
  await queueHeld.promise;
  releaseModel.resolve();
  await first.promise;
  assert.equal(f.calls.length, 1);
  assert.ok(f.supervisor.getTask('lifecycle'), 'serialized cleanup remains blocked after task settlement');
  releaseQueue.resolve();
  await blockingCommand;
  assert.equal(await next, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.agent.messages.filter(message => message.clientMessageId).map(message => message.clientMessageId), ['first', 'second']);
});

test('a queue timer awaiting task release does not restart a failed initialization', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { async config() { entered.resolve(); await release.promise; throw new Error('startup failed'); } });
  const first = await f.supervisor.startTask('lifecycle', async ({ agent }) => { await agent.prompt('first', {}, [], 'first'); });
  await entered.promise;
  f.agent.followUp('second', [], 'second');
  f.agent._clearScheduledFollowUpRun();
  const next = f.agent._runNextFollowUpRun();
  release.resolve();
  await assert.rejects(first.promise, /startup failed/);
  assert.equal(await next, false);
  assert.equal(f.runtime().status, 'error');
  assert.ok(f.agent.findPendingUserMessage('second'));
  assert.equal(f.calls.length, 0);
});

for (const mode of ['follow_up', 'steer']) test(`failed ${mode} deletion during terminal commit keeps accepted work continuously visible`, async t => {
  const model = deferred(), releaseModel = deferred(), terminal = deferred(), releaseTerminal = deferred();
  const deleting = deferred(), releaseDeletion = deferred();
  t.after(() => { releaseModel.resolve(); releaseTerminal.resolve(); releaseDeletion.resolve(); });
  const f = await fixture(t, {
    async model() { model.resolve(); await releaseModel.promise; },
    onEvent(event) { if (event.type === 'agent_end') { terminal.resolve(); return releaseTerminal.promise; } },
  });
  const run = f.agent.prompt('first', {}, [], 'first');
  await model.promise;
  f.agent.followUp('retained', [], 'retained');
  releaseModel.resolve();
  await terminal.promise;
  if (mode === 'steer') f.agent.steerFollowUp('retained');
  const removal = f.agent[mode === 'steer' ? 'removeSteering' : 'removeFollowUp']('retained', async () => {
    deleting.resolve(); await releaseDeletion.promise; throw new Error('attachment cleanup failed');
  });
  await deleting.promise;
  releaseTerminal.resolve();
  await run;
  assert.equal(f.runtime().status, 'pending');
  assert.ok(f.agent.findPendingUserMessage('retained'));
  assert.equal(await f.agent._runNextFollowUpRun(), false, 'the queue transaction prevents consumption');
  releaseDeletion.resolve();
  await assert.rejects(removal, /attachment cleanup failed/);
  f.agent._clearScheduledFollowUpRun();
  assert.equal(f.runtime().status, 'pending');
  assert.deepEqual(f.runtime()[mode === 'steer' ? 'pendingSteeringMessages' : 'pendingFollowUpMessages'].map(message => message.clientMessageId), ['retained']);
  assert.equal(f.snapshots.some(snapshot => snapshot.runtime.status === 'completed'), false);
});

test('finalization failure emits a terminal error, releases occupancy and does not run queued work', async t => {
  const f = await fixture(t);
  f.agent._runLoop = async () => { f.agent.followUp('retained', [], 'retained'); };
  f.agent._flushPendingContextEvents = async () => { throw new Error('finalization write failed'); };
  await f.agent._runWithLifecycle();
  assert.equal(f.runtime().status, 'error');
  assert.equal(f.runtime().reason, 'finalization write failed');
  assert.equal(f.agent.isRunning, false);
  assert.equal(f.agent.getAbortSignal(), null);
  assert.equal(f.agent._followUpRunTimer, null);
  assert.ok(f.agent.findPendingUserMessage('retained'));
  assert.equal(f.events.filter(event => event.type === 'agent_end').length, 1);
});

for (const mode of ['follow_up', 'steer']) test(`a settled task cannot keep ${mode} deletion pending behind serialized cleanup`, async t => {
  const model = deferred(), releaseModel = deferred(), terminal = deferred(), releaseTerminal = deferred();
  const deleting = deferred(), releaseDeletion = deferred();
  t.after(() => { releaseModel.resolve(); releaseTerminal.resolve(); releaseDeletion.resolve(); });
  const f = await fixture(t, {
    async model() { model.resolve(); await releaseModel.promise; },
    onEvent(event) { if (event.type === 'agent_end') { terminal.resolve(); return releaseTerminal.promise; } },
  });
  const first = await f.supervisor.startTask('lifecycle', async ({ agent }) => { await agent.prompt('first', {}, [], 'first'); });
  await model.promise;
  f.agent.followUp('remove this', [], 'removed');
  releaseModel.resolve();
  await terminal.promise;
  if (mode === 'steer') f.agent.steerFollowUp('removed');
  const removing = f.supervisor.withAgent('lifecycle', agent => agent[mode === 'steer' ? 'removeSteering' : 'removeFollowUp']('removed', async () => {
    deleting.resolve(); await releaseDeletion.promise;
  }));
  await deleting.promise;
  releaseTerminal.resolve();
  await first.promise;
  assert.equal(first.settled, true);
  assert.equal(f.supervisor.getTask('lifecycle'), first);
  assert.equal(f.runtime().status, 'pending');
  releaseDeletion.resolve();
  await removing;
  await f.supervisor.waitForTaskRelease('lifecycle');
  assert.equal(f.runtime().status, 'completed');
});

for (const mode of ['follow_up', 'steer']) test(`old ${mode} deletion completion cannot restart failed queued initialization`, async t => {
  const init = deferred(), releaseInit = deferred(), deleting = deferred(), releaseDeletion = deferred();
  t.after(() => { releaseInit.resolve(); releaseDeletion.resolve(); });
  const f = await fixture(t, { async config() { init.resolve(); await releaseInit.promise; throw new Error('startup failed'); } });
  f.agent.followUp('retained', [], 'retained');
  f.agent.followUp('remove', [], 'removed', [], null, mode);
  f.agent._clearScheduledFollowUpRun();
  const run = f.agent._runNextFollowUpRun();
  await init.promise;
  const removal = f.agent[mode === 'steer' ? 'removeSteering' : 'removeFollowUp']('removed', async () => {
    deleting.resolve(); await releaseDeletion.promise;
  });
  await deleting.promise;
  releaseInit.resolve();
  await assert.rejects(run, /startup failed/);
  releaseDeletion.resolve();
  await removal;
  assert.equal(f.runtime().status, 'error');
  assert.equal(f.agent._followUpRunTimer, null);
  assert.ok(f.agent.findPendingUserMessage('retained'));
  assert.equal(f.calls.length, 0);
});

test('a message accepted during failed startup survives the old run cleanup', async t => {
  const terminal = deferred(), releaseTerminal = deferred();
  t.after(() => releaseTerminal.resolve());
  let configurations = 0, ends = 0;
  const f = await fixture(t, {
    async config() { if (++configurations === 1) throw new Error('startup failed'); return runConfig; },
    onEvent(event) { if (event.type === 'agent_end' && ++ends === 1) { terminal.resolve(); return releaseTerminal.promise; } },
  });
  f.agent.followUp('retained', [], 'retained');
  f.agent._clearScheduledFollowUpRun();
  const failed = f.agent._runNextFollowUpRun();
  await terminal.promise;
  assert.equal(f.runtime().status, 'error');
  await f.agent.followUp('new explicit instruction', [], 'new', [], async () => {});
  assert.equal(f.runtime().status, 'pending', 'accepted recovery must not expose the previous error to a new waiter');
  releaseTerminal.resolve();
  await assert.rejects(failed, /startup failed/);
  assert.ok(f.agent._followUpRunTimer, 'newly accepted input survives the old run releasing its occupancy');
  f.agent._clearScheduledFollowUpRun();
  await f.agent._runNextFollowUpRun();
  f.agent._clearScheduledFollowUpRun();
  await f.agent._runNextFollowUpRun();
  assert.equal(f.calls.length, 2);
  assert.equal(f.runtime().status, 'completed');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageQueue, summarizeQueuedUserMessage } from '../../src/background/agent/message-queue.js';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';

const message = id => ({ role: 'user', clientMessageId: id, content: id });
function pausedAgent(id) {
  const agent = new Agent(id, createTestAgentOptions());
  agent._activeRun = new Promise(() => {}); // Queue tests never start a model request.
  return agent;
}

test('steering drains together; follow-ups drain one at a time with isolated queue snapshots', () => {
  const steering = new MessageQueue('all');
  const followUps = new MessageQueue('one-at-a-time');
  const first = message('first');
  const second = message('second');
  steering.setAll([first, second]);
  followUps.setAll([first, second]);
  steering.peekAll().pop();
  assert.deepEqual(steering.drain(), [first, second]);
  assert.deepEqual(followUps.drain(), [first]);
  assert.deepEqual(followUps.drain(), [second]);
  assert.equal(steering.hasItems(), false);
});

test('queue reorder and remove preserve message identity and attachments', () => {
  const queue = new MessageQueue();
  const first = { ...message('first'), documents: [{ fileId: 'file' }] };
  const second = message('second');
  queue.setAll([first, second]);
  assert.equal(queue.reorderByClientMessageIds(['second', 'first']), true);
  assert.equal(queue.peekAll()[1], first);
  const removed = queue.removeByClientMessageId('first');
  queue.insertAt(removed.index, removed.message);
  assert.equal(queue.peekAll()[1], first);
  assert.deepEqual(first.documents, [{ fileId: 'file' }]);
  assert.equal(queue.removeByClientMessageId('missing'), null);
});

test('restored messages without ids keep reference identity and invalid reorder requests are inert', () => {
  const queue = new MessageQueue();
  const legacy = { role: 'user', content: 'restored before client ids existed' };
  const first = message('first');
  queue.setAll([legacy, first]);
  assert.equal(queue.reorderByClientMessageIds(), false);
  assert.equal(queue.reorderByClientMessageIds(['missing']), false);
  assert.equal(queue.reorderByClientMessageIds(['first', 'first']), false);
  assert.deepEqual(queue.peekAll(), [legacy, first]);
  assert.equal(queue.removeByClientMessageId('', { ...legacy }), null, 'unidentified messages require the exact object');
  const removed = queue.removeByClientMessageId('', legacy);
  assert.equal(removed.message, legacy);
  assert.equal(removed.index, 0);
  queue.insertAt(-1, legacy);
  queue.insertAt(99, message('last'));
  assert.deepEqual(queue.peekAll().map(item => item.content), [legacy.content, 'first', 'last']);
  queue.clear();
  assert.deepEqual(queue.drain(), []);
  queue.setAll();
  assert.equal(queue.hasItems(), false);
  assert.equal(queue.removeByClientMessageId(), null);
});

test('queued previews use display text and attachment counts without exposing raw parts', () => {
  const content = [null, 1, {}, { type: 'text', text: ' First ' }, { type: 'text' },
    { type: 'text', text: 'Second' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }];
  const preview = summarizeQueuedUserMessage({ clientMessageId: ' id ', content }, 2);
  assert.deepEqual(preview, { clientMessageId: 'id', text: 'First \n\nSecond', imageCount: 1, index: 2 });
  assert.deepEqual(summarizeQueuedUserMessage(), { clientMessageId: '', text: '', imageCount: 0, index: 0 });
  assert.equal(summarizeQueuedUserMessage({ content: { raw: true } }).text, '');
});

test('failed admission rolls back only its message and remains retryable', async () => {
  const left = pausedAgent('left');
  const right = pausedAgent('right');
  right.followUp('same id, another session', [], 'retry');
  await assert.rejects(left.followUp('first attempt', [], 'retry', [], async () => { throw new Error('persist failed'); }), /persist failed/);
  assert.equal(left.hasPendingUserInput(), false);
  assert.equal(left._pendingQueueWrites.size, 0);
  await left.followUp('second attempt', [], 'retry', [], async () => {});
  assert.equal(left.getPendingFollowUps()[0].text, 'second attempt');
  assert.equal(right.getPendingFollowUps()[0].text, 'same id, another session');
});

test('failed attachment cleanup restores queue order alongside concurrent appends', async () => {
  const agent = pausedAgent('session');
  agent.followUp('first', [], 'first');
  agent.followUp('second', [], 'second');
  const original = agent.findPendingUserMessage('second');
  let reject;
  const cleanup = new Promise((_, fail) => { reject = fail; });
  const removing = agent.removeFollowUp('second', () => cleanup);
  agent.followUp('third', [], 'third');
  reject(new Error('attachment cleanup failed'));
  await assert.rejects(removing, /attachment cleanup failed/);
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ['first', 'second', 'third']);
  assert.equal(agent.findPendingUserMessage('second'), original);
  assert.equal(agent._pendingQueueWrites.size, 0);
  assert.equal(agent.steerFollowUp('second').message.clientMessageId, 'second');
  assert.deepEqual(agent.getPendingFollowUps().map(item => item.clientMessageId), ['first', 'third']);
  assert.deepEqual(agent.getPendingSteerings().map(item => item.clientMessageId), ['second']);
});

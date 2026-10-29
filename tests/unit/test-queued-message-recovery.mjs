import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { createSessionCommands } from '../../src/background/session/commands.js';
import { createSessionSupervisor } from '../../src/background/session/supervisor.js';
import { reduceSessionRuntime } from '../../src/background/session/runtime-reducer.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';

for (const kind of ['followup', 'steering']) {
  test(`${kind}: 24 competing windows recover exactly one copy`, async t => {
    const f = await fixture(t, kind);
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => f.restore({ windowId: i + 1 })));
    assert.equal(results.filter(x => x.restored).length, 1);
    assert.equal(Object.keys(f.state().composerDrafts).length, 1);
    assert.equal(f.agent.findPendingUserMessage('queued'), null);
    assert.equal(f.copies.size, 0, 'an empty composer keeps the original document owner');
    const recovered = results.find(x => x.restored).draft;
    assert.equal(recovered.messageId, 'queued');
    assert.deepEqual(recovered.documents.map(x => x.fileId), ['original-file']);
    assert.equal(f.durable.composerDrafts[1].text, '待调整 🐳 café\n第二行');
  });

  test(`${kind}: a blocked durable write prevents Agent handoff`, async t => {
    const f = await fixture(t, kind);
    const entered = deferred(), release = deferred();
    f.persistHook = async () => { f.persistHook = null; entered.resolve(); await release.promise; };
    const restoring = f.restore();
    await entered.promise;
    assert.ok(f.agent.findPendingUserMessage('queued'), 'still visible until commit');
    assert.equal(f.agent._pendingQueueWrites.size, 1);
    f.canStart = true;
    assert.equal(await f.agent._runNextFollowUpRun(), false, 'the scheduler cannot admit a withdrawing message');
    assert.equal(f.llmCalls, 0);
    release.resolve();
    assert.equal((await restoring).restored, true);
    assert.equal(f.agent.hasPendingUserInput(), false);
    assert.equal(f.llmCalls, 0);
  });

  test(`${kind}: recovery reads wait for a recall still queued behind another Session command`, async t => {
    const f = await fixture(t, kind);
    const entered = deferred(), release = deferred();
    const blocker = f.supervisor.withAgent('session', async () => { entered.resolve(); await release.promise; });
    t.after(() => release.resolve());
    await entered.promise;
    const restoring = f.restore();
    let readSettled = false;
    const reading = f.commands.getSessionComposerDraftRuntime({ sessionId: 'session', windowId: 7, afterQueuedMutation: true })
      .then(result => { readSettled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readSettled, false, 'a read must not overtake the timed-out mutation in the supervisor queue');
    release.resolve();
    await blocker;
    const result = await restoring;
    assert.equal(result.restored, true);
    assert.deepEqual((await reading).draft, result.draft);
  });

  test(`${kind}: failed acknowledgement rolls back the durable snapshot before collecting copies`, async t => {
    const f = await fixture(t, kind);
    await f.saveExisting();
    const before = structuredClone(f.state());
    f.afterPersist = () => { f.afterPersist = null; throw new Error('write acknowledgement lost'); };
    await assert.rejects(f.restore({ draft: f.draft }), /write acknowledgement lost/);
    assert.ok(f.agent.findPendingUserMessage('queued'));
    for (const key of ['composerDrafts', 'pendingFollowUpMessages', 'pendingSteeringMessages']) {
      assert.deepEqual(f.state()[key], before[key]);
      assert.deepEqual(f.durable[key], before[key]);
    }
    assert.deepEqual(f.durable.pendingFollowUps, f.agent.getPendingFollowUps());
    assert.deepEqual(f.durable.pendingSteerings, f.agent.getPendingSteerings());
    assert.equal(f.copies.size, 0);
    assert.equal(f.originalPresent, true);
    assert.equal((await f.restore({ draft: f.draft })).restored, true);
  });

  test(`${kind}: failed rollback retains recoverable document copies for restart`, async t => {
    const f = await fixture(t, kind);
    await f.saveExisting();
    f.afterPersist = () => {
      f.afterPersist = null;
      f.persistHook = () => { throw new Error('rollback storage unavailable'); };
      throw new Error('write acknowledgement lost');
    };
    await assert.rejects(f.restore({ draft: f.draft }), /write acknowledgement lost/);
    assert.ok(f.agent.findPendingUserMessage('queued'));
    assert.equal(f.originalPresent, true);
    assert.equal(f.copies.size, 1, 'the committed snapshot must retain its copied document');
    const saved = structuredClone(f.durable);
    assert.equal(saved.composerDrafts[7].text, '待调整 🐳 café\n第二行\n\n已有草稿');
    assert.equal(saved[kind === 'steering' ? 'pendingSteeringMessages' : 'pendingFollowUpMessages'].length, 0);
    // Rehydrate the durable snapshot in a fresh production Supervisor and Agent.
    const restarted = await fixture(t, kind, saved);
    assert.equal(restarted.agent.hasPendingUserInput(), false);
    const { draft } = await restarted.commands.getSessionComposerDraftRuntime({ sessionId: 'session', windowId: 7 });
    assert.equal(draft.documents[0].messageId, 'draft');
    assert.ok(f.copies.has(draft.documents[0].fileId));
    assert.equal(draft.images[0].dataUrl, 'data:image/png;base64,AAAA');
  });

  test(`${kind}: failed original cleanup does not turn a committed restore into a failed one`, async t => {
    const f = await fixture(t, kind);
    await f.saveExisting();
    f.failOriginalCleanup = true;
    const result = await f.restore({ draft: f.draft });
    assert.equal(result.restored, true);
    assert.equal(f.agent.hasPendingUserInput(), false);
    assert.ok(f.copies.has(result.draft.documents[0].fileId));
    assert.equal(f.originalPresent, true, 'leftover originals can be collected later');
    assert.deepEqual(f.durable.composerDrafts[7], result.draft);
  });

  test(`${kind}: a newer draft revision rejects stale cancellation without copying or dequeuing`, async t => {
    const f = await fixture(t, kind);
    await f.saveExisting();
    const newer = { ...f.draft, updatedAt: f.draft.updatedAt + 100, text: '最新编辑' };
    await f.commands.saveSessionComposerDraftRuntime({ sessionId: 'session', windowId: 7, draft: newer });
    await assert.rejects(f.restore({ draft: f.draft }), error => error.code === 'COMPOSER_DRAFT_CHANGED');
    assert.equal(f.state().composerDrafts[7].text, '最新编辑');
    assert.ok(f.agent.findPendingUserMessage('queued'));
    assert.equal(f.copies.size, 0);
  });
}

test('recall and conversion to steering serialize in either arrival order', async t => {
  const first = await fixture(t, 'followup');
  const [restored, moved] = await Promise.all([
    first.restore(), first.commands.steerSessionFollowUpRuntime({ sessionId: 'session', clientMessageId: 'queued' }),
  ]);
  assert.equal(restored.restored, true);
  assert.equal(moved.moved, false);
  assert.equal(first.agent.hasPendingUserInput(), false);

  const second = await fixture(t, 'followup');
  const [steered, staleRecall] = await Promise.all([
    second.commands.steerSessionFollowUpRuntime({ sessionId: 'session', clientMessageId: 'queued' }), second.restore(),
  ]);
  assert.equal(steered.moved, true);
  assert.equal(staleRecall.restored, false);
  assert.equal(second.agent.getPendingSteerings().length, 1);
  assert.equal((await second.restore({ queueKind: 'steering' })).restored, true);
  assert.equal(second.agent.hasPendingUserInput(), false);
});

async function fixture(t, kind, restoredState) {
  const f = { copies: new Map(), originalPresent: true, canStart: false, llmCalls: 0, durable: null };
  const supervisor = createSessionSupervisor({
    createAgent: lease => new Agent(lease.sessionId, createTestAgentOptions({
      conversationLease: lease, canStartQueuedRun: () => f.canStart,
      llm: { async chat() { f.llmCalls++; throw new Error('unexpected model execution'); },
        async *chatStream() { f.llmCalls++; throw new Error('unexpected model execution'); } },
    })),
    onAgentEvent: (id, event) => supervisor.setRuntime(id, reduceSessionRuntime(supervisor.getRuntime(id), event)),
  });
  f.state = () => supervisor.getRuntime('session');
  f.supervisor = supervisor;
  f.agent = await supervisor.getAgent('session');
  t.after(() => { f.agent._clearScheduledFollowUpRun(); f.agent.abort(); });
  f.commands = createSessionCommands({
    runtime: {
      set: (id, patch) => supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }),
      persist: async () => {
        await f.persistHook?.();
        f.durable = structuredClone(f.state());
        await f.afterPersist?.();
      },
    },
    sessionSupervisor: supervisor, sessionRuntimeReady: Promise.resolve(),
    sessionRepository: { getMetadata: async id => ({ id }) },
    requireExplicitSessionId: id => { assert.ok(id); return id; },
    copyChatMessageDocuments: async ({ targetMessageId, documents }) => documents.map(document => {
      const id = `copy-${f.copies.size + 1}`;
      const copy = { ...document, messageId: targetMessageId, attachmentId: id, fileId: id, docModelId: `${id}-model` };
      f.copies.set(id, copy);
      return copy;
    }),
    removeChatMessageDocuments: async ({ messageId, documents }) => {
      if (messageId === 'queued') {
        if (f.failOriginalCleanup) throw new Error('cleanup unavailable');
        f.originalPresent = false;
      } else for (const document of documents) f.copies.delete(document.fileId);
    },
  });
  f.draft = { sessionId: 'session', messageId: 'draft', text: '已有草稿', images: [], documents: [], updatedAt: Date.now() };
  f.saveExisting = () => f.commands.saveSessionComposerDraftRuntime({ sessionId: 'session', windowId: 7, draft: f.draft });
  f.restore = (overrides = {}) => f.commands.restoreQueuedMessageRuntime({ sessionId: 'session', windowId: 7,
    queueKind: kind, clientMessageId: 'queued', ...overrides });
  if (restoredState) {
    supervisor.setRuntime('session', structuredClone(restoredState));
    f.agent.restorePendingQueues({ followUps: restoredState.pendingFollowUpMessages, steerings: restoredState.pendingSteeringMessages });
  } else {
    const document = { sessionId: 'session', messageId: 'queued', attachmentId: 'original', fileId: 'original-file',
      docModelId: 'original-model', filename: 'notes.txt', mimeType: 'text/plain', format: 'txt', size: 12 };
    await f.agent.followUp('待调整 🐳 café\n第二行', [{ dataUrl: 'data:image/png;base64,AAAA' }], 'queued', [document]);
    if (kind === 'steering') f.agent.steerFollowUp('queued');
  }
  return f;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

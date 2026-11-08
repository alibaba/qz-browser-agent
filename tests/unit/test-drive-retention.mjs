import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveSessionRetention } from '../../src/background/session/drive-retention.js';
import { createMcpRuntime } from '../../src/background/mcp/mcp-runtime.js';
import { createExternalDriveCoordinator } from '../../src/background/mcp/external-drive.js';
import { createSessionSupervisor } from '../../src/background/session/supervisor.js';
import { createSessionRepository } from '../../src/background/session/repository.js';
import { createMemoryStorage } from '../support/memory-storage.mjs';

function fixture(count = 205, { beforeGuard, fail } = {}) {
  const metadata = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const id = `drive-${String(i).padStart(3, '0')}`;
    return [id, { id, source: 'external-drive', createdAt: '2026-01-01 00:00:00', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString().slice(0, 19).replace('T', ' ') }];
  }));
  metadata.normal = { id: 'normal', source: '', updatedAt: '2000-01-01 00:00:00' };
  const supervisor = createSessionSupervisor({ createAgent: () => ({ isRunning: false }) });
  const removed = [], errors = [];
  const drive = createExternalDriveCoordinator({ getRuntime: supervisor.getRuntime });
  let fails = fail;
  const options = {
    listMetadata: async () => structuredClone(metadata),
    getRuntime: supervisor.getRuntime, isActive: supervisor.isActive,
    retire: drive.retireForRetention,
    async remove(id, canRemove) {
      await beforeGuard?.(id, { metadata, supervisor, drive });
      const snapshot = await supervisor.remove(id, { canRemove, async beforeRelease() {
        metadata[id].driveRetentionPending = true;
        if (fails) { fails = false; throw new Error('temporary storage failure'); }
        removed.push(id); delete metadata[id];
      } });
      return Boolean(snapshot);
    },
    retryMs: 60_000, logger: { warn: (...args) => errors.push(args) },
  };
  const retention = createDriveSessionRetention(options);
  return { metadata, supervisor, drive, removed, errors, options, retention };
}

test('retention keeps 200 newest drive records and never touches ordinary sessions', async t => {
  const f = fixture(); t.after(() => f.retention.dispose());
  await Promise.all([f.retention.request(), f.retention.request(), f.retention.request()]);
  assert.equal(Object.keys(f.metadata).length, 201);
  assert.deepEqual(new Set(f.removed), new Set(['drive-000', 'drive-001', 'drive-002', 'drive-003', 'drive-004']));
  assert.equal(f.metadata.normal.source, '');
  assert.equal(f.removed.length, 5, 'coalesced maintenance cannot delete an entry twice');
});

test('running state, live Agent work and admitted drive work survive pruning', async t => {
  const f = fixture(); t.after(() => f.retention.dispose());
  f.supervisor.setRuntime('drive-000', { status: 'running', running: true });
  f.supervisor.setRuntime('drive-001', { status: 'waiting_user' });
  const agent = await f.supervisor.getAgent('drive-002'); agent.isRunning = true;
  const release = f.drive.protect('drive-003');
  const lease = f.drive.begin('drive-004');
  await f.retention.request();
  assert.equal(f.removed.length, 0, 'active exceptions may temporarily exceed 200');
  f.supervisor.setRuntime('drive-000', { status: 'aborted' });
  f.supervisor.setRuntime('drive-001', { status: 'aborted' });
  agent.isRunning = false; release(); lease.release();
  await f.retention.request();
  assert.equal(f.removed.length, 5);
  assert.equal(Object.keys(f.metadata).length, 201);
});

test('a call admitted after candidate selection wins over cleanup', async t => {
  let release, first = true;
  const f = fixture(201, { beforeGuard(id, { drive }) {
    if (first) { first = false; release = drive.protect(id); }
  } });
  t.after(() => f.retention.dispose());
  await f.retention.request();
  assert.equal(f.removed.length, 0);
  release();
  await f.retention.request();
  assert.deepEqual(f.removed, ['drive-000']);
});

test('fresh activity invalidates an old selection; changed ordinary source is never removed', async t => {
  const f = fixture(202, { beforeGuard(id, { supervisor, metadata }) {
    if (id === 'drive-000') supervisor.setRuntime(id, { driveLastActivityAt: Date.UTC(2030, 0, 1) });
    if (id === 'drive-001') metadata[id].source = '';
  } });
  t.after(() => f.retention.dispose());
  await f.retention.request();
  assert.ok(f.metadata['drive-000']);
  assert.equal(f.metadata['drive-001'].source, '');
  assert.ok(!f.removed.includes('drive-000') && !f.removed.includes('drive-001'));
});

test('concurrent user deletion invalidates the old overflow snapshot', async t => {
  let changed = false;
  const f = fixture(205, { beforeGuard(_id, { metadata }) {
    if (changed) return;
    changed = true;
    for (let i = 195; i < 205; i++) delete metadata[`drive-${i}`];
  } });
  t.after(() => f.retention.dispose());
  await f.retention.request();
  assert.deepEqual(f.removed, [], 'do not keep deleting from a stale count after the list shrinks');
  assert.equal(Object.keys(f.metadata).length, 196);
});

test('a durable pending deletion retries after restart even when the list is below the cap', async t => {
  const f = fixture(201, { fail: true }); t.after(() => f.retention.dispose());
  await f.retention.request();
  assert.equal(f.metadata['drive-000'].driveRetentionPending, true);
  assert.equal(f.errors.length, 1);
  delete f.metadata['drive-001'];
  const restarted = createDriveSessionRetention(f.options); t.after(() => restarted.dispose());
  await restarted.request();
  assert.equal(f.metadata['drive-000'], undefined);
  assert.ok(f.metadata.normal);
});

test('concurrent explicit creation automatically converges to the cap after admissions settle', async t => {
  const repository = createSessionRepository({ storage: createMemoryStorage() });
  const supervisor = createSessionSupervisor({ createAgent: () => ({}) });
  let retention;
  const runtime = createMcpRuntime({
    sessions: { supervisor, listMetadata: repository.listMetadata, createMetadata: repository.createMetadata,
      getRuntime: id => supervisor.getRuntime(id) || {},
      setRuntime: (id, patch) => supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }) },
    tools: { recordLoadedSkillNames() {} }, skills: { list: async () => [] }, artifacts: {}, trace: {}, userInputPermissions: {}, async dispatchSidepanel() {},
    onDriveSettled: () => retention.request(),
  });
  retention = createDriveSessionRetention({
    listMetadata: repository.listMetadata, getRuntime: supervisor.getRuntime,
    isActive: supervisor.isActive, retire: runtime.drive.retireForRetention,
    async remove(id, canRemove) {
      const removed = await supervisor.remove(id, { canRemove, async beforeRelease() {
        await repository.patchMetadata(id, { driveRetentionPending: true });
        await repository.deleteSession(id, { strict: true });
      } });
      return Boolean(removed);
    },
  });
  t.after(() => retention.dispose());
  await Promise.all(Array.from({ length: 205 }, () => runtime.createDriveSession({ title: "Inspect example page" })));
  await retention.request();
  assert.equal(Object.keys(await repository.listMetadata()).length, 200);
});

test('strict repository deletion drains all per-session keys, retains normal data, and retries failures', async () => {
  const source = createMemoryStorage();
  let fail = true;
  const storage = { ...source, async remove(keys) {
    if (fail && (Array.isArray(keys) ? keys : [keys]).includes('_session_runtime_old')) throw new Error('runtime remove failed');
    await source.remove(keys);
  } };
  const repository = createSessionRepository({ storage });
  await repository.createMetadata({ id: 'old', source: 'external-drive' });
  await repository.createMetadata({ id: 'normal', source: '' });
  await repository.patchMetadata('old', { driveRetentionPending: true });
  await source.set({
    _session_old: { fixture: true }, _active_conversation_old: {}, _session_transcript_checkpoint_old: {},
    _session_runtime_old: { sessionId: 'old' }, _session_import_dedup_old: {},
    _session_runtime: { old: { sessionId: 'old' }, normal: { sessionId: 'normal' } },
    _session_normal: { preserved: true }, _session_runtime_normal: { preserved: true },
  });
  await assert.rejects(repository.deleteSession('old', { strict: true }), /runtime remove failed/);
  assert.equal((await repository.getMetadata('old')).driveRetentionPending, true, 'keep the retry owner until all stores are clean');
  assert.equal(repository.isWriteBlocked('old'), true);
  assert.throws(() => repository.writeRuntime('old', {}), { code: 'SESSION_DELETED' });
  await assert.rejects(repository.createMetadata({ id: 'old', source: 'external-drive' }), { code: 'SESSION_DELETED' });
  fail = false;
  await repository.deleteSession('old', { strict: true });
  const values = await source.get(null);
  for (const key of ['_session_old', '_active_conversation_old', '_session_transcript_checkpoint_old', '_session_runtime_old', '_session_import_dedup_old']) {
    assert.equal(Object.hasOwn(values, key), false, key);
  }
  assert.deepEqual(values._session_runtime, { normal: { sessionId: 'normal' } });
  assert.deepEqual(values._session_normal, { preserved: true });
  assert.deepEqual(values._session_runtime_normal, { preserved: true });
  assert.equal(await repository.getMetadata('old'), null);
  assert.ok(await repository.getMetadata('normal'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpRuntime } from '../../src/background/mcp/mcp-runtime.js';
import { createExternalDriveCoordinator } from '../../src/background/mcp/external-drive.js';

function fixture({ ready = Promise.resolve(), idleMs = 60_000, stored = {} } = {}) {
  const metadata = {}, calls = [], stops = [], profiles = [];
  const options = {
    driveIdleMs: idleMs,
    sessions: {
      supervisor: { mintDriveRunId: () => 'drive-run', takeDriveRunForRelease: () => 'drive-run' },
      listMetadata: async () => metadata,
      createMetadata: async input => { metadata[input.id] = { ...input }; },
      getRuntime: id => stored[id] || {}, getStoredRuntime: id => stored[id],
      setRuntime: (id, patch) => { stored[id] = { ...stored[id], ...patch }; },
      stop: async (id, meta) => { stops.push({ id, meta }); stored[id] = { ...stored[id], status: 'aborted', driveKeepTabs: meta.keepTabs }; },
    },
    tools: {
      ready, canManageSessions: async () => false,
      buildRunProfile: async input => { profiles.push(input); return {}; },
      loadedSkillNames: () => [], recordLoadedSkillNames() {},
      runtime: {
        getSchemas: () => [{ type: 'function', function: { name: 'list_tabs', parameters: {} } }],
        execute: async (...args) => { calls.push(args); return { ok: true }; },
      },
    },
    skills: {}, artifacts: {}, trace: {}, userInputPermissions: {}, async dispatchSidepanel() {},
  };
  return { options, runtime: createMcpRuntime(options), metadata, stored, calls, stops, profiles };
}

test('sessionless metadata reads do not create or touch sessions; explicit unknown IDs still fail', async () => {
  const f = fixture();
  assert.equal((await f.runtime.listTools()).tools[0].name, 'list_tabs');
  assert.equal((await f.runtime.getTool({ name: 'list_tabs' })).name, 'list_tabs');
  assert.ok(f.profiles.every(profile => profile.externalDrive && !profile.sessionId));
  assert.deepEqual(f.metadata, {}); assert.deepEqual(f.stored, {}); assert.deepEqual(f.calls, []);
  await assert.rejects(f.runtime.getTool({ name: 'list_tabs', sessionId: 'unknown' }), { code: 'DRIVE_SESSION_NOT_FOUND' });
  await assert.rejects(f.runtime.executeTool({ name: 'list_tabs' }), { code: 'DRIVE_SESSION_REQUIRED' });
});

test('cancel during asynchronous setup prevents execution, and cancelled IDs cannot be recreated', async () => {
  let release;
  const f = fixture({ ready: new Promise(resolve => { release = resolve; }) });
  const { sessionId } = await f.runtime.createDriveSession({ title: "Inspect example page" });
  const pending = f.runtime.executeTool({ sessionId, name: 'list_tabs' });
  await new Promise(resolve => setImmediate(resolve));
  f.runtime.drive.noteStopped(sessionId);
  release();
  await assert.rejects(pending, { code: 'DRIVE_SESSION_ENDED' });
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.runtime.executeTool({ sessionId, calls: [{ id: 'close', name: 'close_tab', args: { tabRef: 'old' } }] }),
    { code: 'DRIVE_SESSION_ENDED' });
  await assert.rejects(f.runtime.createDriveSession({ title: "Inspect example page", sessionId }), { code: 'DRIVE_SESSION_ENDED' });
});

test('restart restores remaining idle time, expires yesterday, and preserves explicit keep on stopped cleanup', async () => {
  const f = fixture({ idleMs: 35 });
  for (const id of ['yesterday', 'recent', 'kept', 'stopped']) f.metadata[id] = { source: 'external-drive' };
  f.stored.yesterday = { driveLastActivityAt: Date.now() - 86_400_000 };
  f.stored.recent = { driveLastActivityAt: Date.now() };
  f.stored.kept = { status: 'aborted', driveKeepTabs: true, createdTabIds: [1] };
  f.stored.stopped = { status: 'aborted', createdTabIds: [2] };
  await f.runtime.restoreDriveSessions();
  assert.deepEqual(f.stops.map(item => item.id), ['yesterday', 'kept', 'stopped']);
  assert.equal(f.stops.find(item => item.id === 'kept').meta.keepTabs, true);
  assert.equal(f.stops.find(item => item.id === 'yesterday').meta.keepTabs, false);
  await assert.rejects(f.runtime.executeTool({ sessionId: 'yesterday', name: 'list_tabs' }), { code: 'DRIVE_SESSION_ENDED' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.stops.filter(item => item.id === 'recent').length, 1);
  assert.equal(f.stops.find(item => item.id === 'recent').meta.keepTabs, false);
  const restarted = createMcpRuntime(f.options);
  await assert.rejects(restarted.executeTool({ sessionId: 'recent', name: 'list_tabs' }), { code: 'DRIVE_SESSION_ENDED' });
});

test('retention cannot retire a drive call during asynchronous tool admission', async () => {
  let release;
  const f = fixture({ ready: new Promise(resolve => { release = resolve; }) });
  const { sessionId } = await f.runtime.createDriveSession({ title: "Inspect example page" });
  const pending = f.runtime.executeTool({ sessionId, name: 'list_tabs' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.drive.retireForRetention(sessionId), false);
  release(); await pending;
  assert.equal(f.runtime.drive.retireForRetention(sessionId), true);
});

test('pending retention cleanup cannot be reopened or executed after a restart', async () => {
  const f = fixture();
  f.metadata.retired = { id: 'retired', source: 'external-drive', driveRetentionPending: true };
  await assert.rejects(f.runtime.executeTool({ sessionId: 'retired', name: 'list_tabs' }), { code: 'DRIVE_SESSION_ENDED' });
  await assert.rejects(f.runtime.createDriveSession({ title: "Inspect example page", sessionId: 'retired' }), { code: 'DRIVE_SESSION_ENDED' });
  await f.runtime.restoreDriveSessions();
  assert.equal(f.stored.retired, undefined);
  assert.deepEqual(f.calls, []);
});

test('idle deadline cannot be bypassed by admission before its timer runs', () => {
  const stops = [];
  const drive = createExternalDriveCoordinator({ idleMs: 10,
    getRuntime: () => ({ driveLastActivityAt: Date.now() - 20 }), stop: id => stops.push(id) });
  assert.throws(() => drive.begin('expired'), { code: 'DRIVE_SESSION_ENDED' });
  assert.deepEqual(stops, ['expired']);
});

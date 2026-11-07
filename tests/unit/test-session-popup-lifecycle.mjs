import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionTabs, getOwnedTabIds } from '../../src/background/session/tabs.js';
import { createdTabResultId } from '../../src/shared/contracts/page-observation.js';

function fixture() {
  const runtimes = new Map([
    ['a', { ownedTabIds: [1], createdTabIds: [1], workingTabId: 1, runId: 'run-a' }],
    ['b', { ownedTabIds: [2], createdTabIds: [2], workingTabId: 2, runId: 'run-b' }],
  ]);
  const current = new Map([['a', 'run-a'], ['b', 'run-b']]);
  const tabs = new Map([1, 2].map(id => [id, { id, url: `https://public.example/${id}`, title: `Tab ${id}`, windowId: 1, active: false }]));
  const removed = [];
  const storageWrites = [];
  const lookupFailures = new Set();
  const records = { a: { id: 'a', source: 'external-drive' }, b: { id: 'b', source: 'external-drive' } };
  let persist = async () => {};
  let query = async () => [...tabs.values()];
  const host = createSessionTabs({
    supervisor: {
      getRuntime: id => runtimes.get(id), runtimeEntries: () => [...runtimes],
      setRuntime: (id, value) => runtimes.set(id, value),
      isRunCurrent: (id, runId) => current.get(id) === runId,
    },
    tabsApi: {
      async get(id) {
        if (lookupFailures.has(id)) throw new Error('Temporary browser lookup failure');
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return tabs.get(id);
      },
      query: () => query(), async create() {}, async update() {}, async ungroup() {},
      async remove(id) { tabs.delete(id); removed.push(id); },
    },
    storage: { async get() { return {}; }, async set(value) { storageWrites.push(value); }, async remove() {} },
    getSessions: async () => records,
    isAutomationSessionFamily: () => false,
    setRuntime(id, patch) { const next = { ...runtimes.get(id), ...patch }; runtimes.set(id, next); return next; },
    persistRuntime: id => persist(id),
    ensureTabGroupForWindow: async () => null,
    logger: { debug() {}, warn() {} },
  });
  const scope = { sessionId: 'a', runId: 'run-a', openerTabId: 1 };
  const popup = id => { const tab = { id, openerTabId: 1, url: 'about:blank', title: '', active: false, windowId: 1 }; tabs.set(id, tab); return tab; };
  return { host, scope, popup, runtimes, current, tabs, removed, records, lookupFailures, storageWrites,
    persist: fn => { persist = fn; }, query: fn => { query = fn; } };
}

function arrive(f, tab) { return f.host.handlePopupCreated({ tabId: tab.id, sourceTabId: tab.openerTabId }); }

test('group lookup failures preserve published popup ownership until its removal event', async () => {
  const f = fixture(), capture = f.host.beginPopupCapture(f.scope);
  await arrive(f, f.popup(3));
  capture.dispose();
  f.runtimes.set('a', { ...f.runtimes.get('a'), tabAliases: { item: 3 }, driveHandoffTabIds: [3], workingTabId: 3 });
  const before = structuredClone(f.runtimes.get('a'));
  f.lookupFailures.add(3);
  await f.host.syncGroup();
  assert.deepEqual(f.runtimes.get('a'), before, 'a failed per-tab lookup cannot revoke ownership');
  const writesBeforeFailure = f.storageWrites.length;
  f.query(async () => { throw new Error('Temporary browser query failure'); });
  await assert.rejects(f.host.syncGroup(), /Temporary browser query failure/);
  assert.deepEqual(f.runtimes.get('a'), before, 'an incomplete inventory cannot identify closed tabs');
  assert.equal(f.storageWrites.length, writesBeforeFailure, 'failed inventory leaves group presentation intact');
  f.query(async () => [...f.tabs.values()]);
  f.tabs.delete(3);
  await f.host.handleTabRemoved(3);
  const after = f.runtimes.get('a');
  assert.deepEqual(getOwnedTabIds(after), [1]);
  assert.deepEqual(after.createdTabIds, [1]);
  assert.deepEqual(after.popupTabIds, []);
  assert.deepEqual(after.tabAliases, {});
  assert.deepEqual(after.driveHandoffTabIds, []);
  assert.equal(after.workingTabId, null);
  assert.deepEqual(f.removed, [], 'reconciliation never closes browser tabs');
});

test('startup group reconciliation cleans closed persisted tabs using the complete browser inventory', async () => {
  const f = fixture();
  f.runtimes.set('a', { ...f.runtimes.get('a'), ownedTabIds: [1, 3], createdTabIds: [1, 3],
    popupTabIds: [3], tabAliases: { item: 3 }, driveHandoffTabIds: [3], workingTabId: 3 });
  await f.host.syncGroup('startup');
  const after = f.runtimes.get('a');
  assert.deepEqual(getOwnedTabIds(after), [1]);
  assert.deepEqual(after.createdTabIds, [1]);
  assert.deepEqual(after.popupTabIds, []);
  assert.deepEqual(after.tabAliases, {});
  assert.deepEqual(after.driveHandoffTabIds, []);
  assert.equal(after.workingTabId, null);
  assert.deepEqual(f.removed, []);
});

test('a browser inventory cannot revoke a popup published after that inventory began', async () => {
  const f = fixture(), capture = f.host.beginPopupCapture(f.scope);
  let startQuery, finishQuery;
  const started = new Promise(resolve => { startQuery = resolve; });
  f.query(() => new Promise(resolve => {
    const snapshot = [...f.tabs.values()];
    finishQuery = () => resolve(snapshot);
    startQuery();
  }));
  const syncing = f.host.syncGroup();
  await started;
  await arrive(f, f.popup(3));
  const before = structuredClone(f.runtimes.get('a'));
  f.query(async () => [...f.tabs.values()]);
  finishQuery();
  await syncing;
  assert.deepEqual(f.runtimes.get('a'), before);
  assert.equal(f.host.owns('a', 3), true);
  assert.deepEqual(f.removed, []);
  capture.dispose();
});

test('task popups enter owned and created sets atomically before persistence, and cancel closes them', async () => {
  const f = fixture();
  const waiter = await f.host.observePopup(f.scope);
  const capture = f.host.beginPopupCapture(f.scope);
  let finishPersist;
  f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
  const arriving = arrive(f, f.popup(3));
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1, 3]);
  assert.deepEqual(f.runtimes.get('a').createdTabIds, [1, 3]);
  assert.equal(f.runtimes.get('a').workingTabId, 1);
  f.persist(async () => {});
  finishPersist();
  await arriving;
  const tab = await waiter.result;
  assert.deepEqual(tab, { tabRef: 3, title: '', url: 'about:blank', active: false });
  assert.equal(createdTabResultId(tab), 3);
  capture.dispose();
  await f.host.settleStoppedDriveTabs('a', { ownedTabIds: [1, 3], createdTabIds: [1, 3], runIds: ['run-a'] });
  assert.deepEqual(f.removed.sort(), [1, 3]);
  assert.equal(f.tabs.has(2), true);
});

test('passive popup waits and unrelated user tabs do not grant ownership', async () => {
  const f = fixture();
  const waiter = await f.host.observePopup(f.scope);
  await arrive(f, f.popup(3));
  const capture = f.host.beginPopupCapture(f.scope);
  await arrive(f, { ...f.popup(4), openerTabId: 2 });
  await arrive(f, { ...f.popup(5), openerTabId: undefined });
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1]);
  assert.deepEqual(f.removed, []);
  waiter.dispose(); capture.dispose();
});

test('navigation source identifies the task when background CDP gives the popup the active tab as opener', async () => {
  const f = fixture();
  const waiter = await f.host.observePopup(f.scope);
  const captureA = f.host.beginPopupCapture(f.scope);
  const captureB = f.host.beginPopupCapture({ sessionId: 'b', runId: 'run-b', openerTabId: 2 });
  const tab = f.popup(3);
  tab.openerTabId = 2;
  await f.host.handlePopupCreated({ tabId: tab.id, sourceTabId: 1 });
  assert.equal(f.host.findOwner(3).sessionId, 'a');
  assert.equal((await waiter.result).tabRef, 3);
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('b')), [2]);
  captureA.dispose(); captureB.dispose();
});

test('revoked dispatch authority closes a late popup without publishing it', async () => {
  const f = fixture();
  const capture = f.host.beginPopupCapture(f.scope);
  f.current.delete('a');
  await arrive(f, f.popup(3));
  assert.deepEqual(f.removed, [3]);
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1]);
  capture.dispose();
});

test('a user handoff preserves its late popup instead of reclaiming or closing it', async () => {
  const f = fixture();
  const capture = f.host.beginPopupCapture(f.scope);
  f.current.delete('a');
  f.runtimes.set('a', { ...f.runtimes.get('a'), driveHandoffTabIds: [1] });
  await arrive(f, f.popup(3));
  assert.deepEqual(f.removed, []);
  assert.equal(f.host.findOwner(3), null);
  capture.dispose();
});

test('cancellation during popup persistence removes the popup and rejects its observer', async () => {
  const f = fixture(), controller = new AbortController();
  const scope = { ...f.scope, signal: controller.signal };
  const waiter = await f.host.observePopup(scope);
  const rejected = assert.rejects(waiter.result, error => error.code === 'OPERATION_ABORTED');
  const capture = f.host.beginPopupCapture(scope);
  let finishPersist;
  f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
  const arriving = arrive(f, f.popup(3));
  f.persist(async () => {}); f.current.delete('a'); controller.abort();
  await f.host.settleStoppedDriveTabs('a', { ownedTabIds: [3], createdTabIds: [3], runIds: ['run-a'] });
  finishPersist();
  await arriving; await rejected;
  assert.deepEqual(f.removed, [3]);
  assert.equal(f.host.owns('a', 3), false);
  capture.dispose();
});

test('selectively kept popup survives late ownership persistence without retaining its siblings', async () => {
  for (const keepTabIds of [[3], [1]]) {
    const f = fixture(), controller = new AbortController();
    const scope = { ...f.scope, signal: controller.signal };
    const capture = f.host.beginPopupCapture(scope);
    let finishPersist;
    f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
    const arriving = arrive(f, f.popup(3));
    assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1, 3]);
    const snapshot = f.runtimes.get('a');
    f.runtimes.set('a', { ...snapshot, status: 'aborted', driveKeepTabIds: keepTabIds });
    f.current.delete('a'); controller.abort(); f.persist(async () => {});
    await f.host.settleStoppedDriveTabs('a', { ...snapshot, keepTabIds, runIds: ['run-a'] });
    finishPersist(); await arriving;
    assert.equal(f.tabs.has(3), keepTabIds.includes(3), 'retention applies to the popup itself, not its opener');
    assert.equal(f.host.findOwner(3), null, 'an explicitly kept popup stays handed back to the user');
    assert.deepEqual(await capture.observed(), [], 'a stopped action cannot publish the kept popup');
    await arrive(f, f.popup(4));
    assert.equal(f.tabs.has(4), false, 'a retained page cannot retain unselected late popups');
    capture.dispose();
  }
});

test('popup capture cannot steal a foreign tab or a new owner’s popup', async () => {
  const f = fixture();
  assert.throws(() => f.host.beginPopupCapture({ ...f.scope, openerTabId: 2 }), error => error.code === 'SESSION_TAB_FOREIGN');
  const capture = f.host.beginPopupCapture(f.scope);
  await arrive(f, { ...f.tabs.get(2), openerTabId: 1 });
  assert.equal(f.host.findOwner(2).sessionId, 'b');
  f.current.delete('a');
  f.runtimes.set('a', { ...f.runtimes.get('a'), ownedTabIds: [] });
  f.runtimes.set('b', { ...f.runtimes.get('b'), ownedTabIds: [1, 2] });
  await arrive(f, f.popup(3));
  assert.deepEqual(f.removed, []);
  assert.equal(f.host.findOwner(3), null);
  capture.dispose();
});

test('missing browser tabs return a public error message without raw numeric browser prose', async () => {
  const f = fixture();
  const result = await f.host.resolveTargetTab({ sessionId: 'a', runId: 'run-a', tabId: 8222 });
  assert.equal(result.code, 'SESSION_TAB_UNAVAILABLE');
  assert.doesNotMatch(result.error, /8222|No tab with id/);
});

test('native cancellation closes only the captured popups and preserves user tabs and later-run popups', async () => {
  const f = fixture(); f.records.a = { id: 'a', parentSessionId: '0' };
  const capture = f.host.beginPopupCapture(f.scope);
  await arrive(f, f.popup(3));
  const stoppedPopups = [...f.runtimes.get('a').popupTabIds];
  await arrive(f, f.popup(4));
  const stopped = await f.host.closeOwnedTabsAfterTerminal('a', 'stop_session', stoppedPopups);
  assert.deepEqual(stopped.closed, [3]);
  assert.equal(f.tabs.has(1), true);
  assert.equal(f.tabs.has(2), true);
  assert.equal(f.tabs.has(4), true);
  assert.deepEqual(f.runtimes.get('a').popupTabIds, [4]);
  capture.dispose();
});

test('action receipts contain only confirmed task popups and return independent public snapshots', async () => {
  const f = fixture(), capture = f.host.beginPopupCapture(f.scope);
  assert.deepEqual(await capture.observed(), []);
  let finishPersist;
  f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
  const arriving = arrive(f, { ...f.popup(3), openerTabId: 1 });
  let confirmed = false;
  const receipt = capture.observed().then(pages => { confirmed = true; return pages; });
  await new Promise(setImmediate);
  assert.equal(confirmed, false, 'ownership must finish persistence before entering a receipt');
  f.persist(async () => {}); finishPersist(); await arriving;
  await arrive(f, { ...f.popup(4), openerTabId: 2 });
  await arrive(f, f.tabs.get(3));
  const expected = [{ tabRef: 3, title: '', url: 'about:blank', active: false }];
  assert.deepEqual(await receipt, expected);
  assert.deepEqual(await capture.observed(), expected, 'foreign pages and duplicate browser events are excluded');
  (await capture.observed())[0].url = 'https://changed.invalid/';
  assert.deepEqual(await capture.observed(), expected);
  await f.host.handleTabRemoved(3);
  assert.deepEqual(await capture.observed(), [], 'closed or released pages are not actionable receipts');
  capture.dispose();
});

test('late popup confirmation does not leak into the next action receipt', async () => {
  const f = fixture(), first = f.host.beginPopupCapture(f.scope);
  let finishPersist;
  f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
  const arriving = arrive(f, f.popup(3));
  first.dispose();
  const second = f.host.beginPopupCapture(f.scope);
  f.persist(async () => {}); finishPersist(); await arriving;
  assert.equal(f.host.owns('a', 3), true, 'the page still belongs to its originating session');
  assert.deepEqual(await first.observed(), []);
  assert.deepEqual(await second.observed(), []);
  await arrive(f, f.popup(4));
  assert.deepEqual((await second.observed()).map(page => page.tabRef), [4]);
  f.current.delete('a');
  assert.deepEqual(await second.observed(), [], 'revoked runs cannot publish previously collected pages');
  second.dispose();
});

test('popup receipt confirmation stops with its call without waiting for stalled persistence', async () => {
  const f = fixture(), controller = new AbortController();
  const capture = f.host.beginPopupCapture({ ...f.scope, signal: controller.signal });
  let finishPersist;
  f.persist(() => new Promise(resolve => { finishPersist = resolve; }));
  const arriving = arrive(f, f.popup(3));
  const receipt = capture.observed();
  controller.abort();
  await assert.rejects(receipt, { code: 'OPERATION_ABORTED' });
  capture.dispose(); f.persist(async () => {}); finishPersist(); await arriving;
  assert.deepEqual(f.removed, [], 'cancelling a call does not cancel its owning session');
  assert.equal(f.host.owns('a', 3), true);
  assert.deepEqual(await capture.observed(), []);
});


test('published loading popups survive a run change while ownership confirmation is pending', async () => {
  const f = fixture(), capture = f.host.beginPopupCapture(f.scope);
  const confirmations = [];
  f.persist(() => new Promise(resolve => confirmations.push(resolve)));
  const arrivals = [3, 4, 5].map(id => arrive(f, f.popup(id)));
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1, 3, 4, 5]);
  capture.dispose();
  f.current.set('a', 'run-next');
  f.runtimes.set('a', { ...f.runtimes.get('a'), runId: 'run-next' });
  const next = f.host.beginPopupCapture({ ...f.scope, runId: 'run-next' });
  f.persist(async () => {});
  confirmations.forEach(resolve => resolve());
  await Promise.all(arrivals);
  assert.deepEqual(f.removed, [], 'completion of an old run must not close published session pages');
  assert.deepEqual(getOwnedTabIds(f.runtimes.get('a')), [1, 3, 4, 5]);
  assert.deepEqual(await next.observed(), [], 'old confirmations cannot enter the next run receipt');
  next.dispose();
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRunScriptBridge } from "../../src/background/tools/run-script-bridge.js";
import { markToolValue, isToolValue } from "../../src/shared/contracts/tool-error.js";
import { bindCreatedTabResult } from "../../src/shared/contracts/page-observation.js";
import { runDriveCalls } from "../../src/background/mcp/external-drive.js";
import { updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";
import { navigationDocuments } from "../support/navigation-documents.mjs";

for (const stage of ["context", "execute", "apply"]) {
  for (const stop of ["revoke", "abort"]) {
    test(`nested script ${stop} during ${stage} rejects late artifacts and observations; the next run recovers`, async () => {
      let reachBoundary, releaseBoundary;
      const reached = new Promise(resolve => { reachBoundary = resolve; });
      const blocked = new Promise(resolve => { releaseBoundary = resolve; });
      const runId = "current";
      let activeRun = runId;
      let controller = new AbortController();
      let shouldPause = true;
      const pause = async boundary => {
        if (boundary !== stage || !shouldPause) return;
        reachBoundary();
        await blocked;
      };
      let executions = 0, applies = 0, appends = 0, refreshes = 0;
      const bridge = createRunScriptBridge({
        supervisor: { isRunCurrent: (_id, run) => activeRun === run, hasAgent: () => true, getAbortSignal: () => controller.signal },
        getRuntime: () => ({ status: "running" }),
        canManageSessions: async () => true,
        buildRunProfile: async () => ({}),
        getRunToolContext: async () => { await pause("context"); return {}; },
        applyNestedToolResult: async () => { applies++; await pause("apply"); },
        toolRuntime: {
          getSchemas: () => [],
          resolveDefinition: () => ({ behavior: { nestedObservation: true } }),
          async execute() { executions++; await pause("execute"); return { _image: "data:image/png;base64,aW1hZ2U=" }; },
        },
        collectArtifacts: () => [{ type: "file", filename: "output.txt" }],
        appendArtifacts: async () => { appends++; },
        scheduleArtifactRefresh: () => { refreshes++; },
      });
      const pending = bridge.handleToolCall({ sessionId: "s1", runId, toolName: "custom_observation" });
      await reached;
      if (stop === "abort") controller.abort();
      else activeRun = "next";
      releaseBoundary();
      const stopped = await pending;
      assert.equal(stopped.code, "RUN_STOPPED");
      assert.equal(stopped.observation, undefined);
      assert.equal(appends, 0);
      assert.equal(refreshes, 0);
      assert.equal(executions, stage === "context" ? 0 : 1);
      assert.equal(applies, stage === "apply" ? 1 : 0, "revoked tool results must not reach the Agent");

      shouldPause = false;
      activeRun = "next";
      controller = new AbortController();
      const recovered = await bridge.handleToolCall({ sessionId: "s1", runId: "next", toolName: "custom_observation" });
      assert.equal(recovered.ok, true);
      assert.ok(recovered.observation?._image);
      assert.equal(appends, 1);
      assert.equal(refreshes, 1);
    });
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, status: 'complete', url: `https://example.test/${id}`, title: `Page ${id}` }; } },
};
const tools = await import('../../src/background/tools/runtime.js');
const probes = new Map();
let nextFixture = 0;
tools.defineTool({ name: '__nested_lane_probe', description: 'Controlled page operation.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' }, label: { type: 'string' } }, required: ['tabRef', 'fixture', 'label'] },
  execute: async ({ tabId, fixture, label }, signal) => {
    const state = probes.get(fixture);
    state.started.push(label);
    assert.ok(!state.pages.has(tabId), `page ${tabId} has overlapping actions`);
    state.pages.add(tabId);
    state.peak = Math.max(state.peak, ++state.active);
    try {
      if (state.hold) await new Promise(resolve => {
        const release = () => { state.release.delete(label); signal.removeEventListener('abort', release); resolve(); };
        state.release.set(label, release);
        signal.addEventListener('abort', release, { once: true });
      });
      if (label.endsWith(':execute-fail')) throw Object.assign(new Error('Injected execution failure'), { code: 'FIXTURE_EXECUTION_FAILED' });
      return { label, page: tabId };
    } finally { state.active--; state.pages.delete(tabId); }
  },
});
tools.defineTool({ name: '__nested_container', description: 'Await a descendant on the same page.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' } }, required: ['tabRef', 'fixture'] },
  execute: async ({ fixture }, _signal, context) => context.invokeTool('__nested_lane_probe', { tabRef: 'page', fixture, label: 'child' }),
});
tools.defineTool({ name: '__nested_create', description: 'Controlled tab creation.',
  tabLifecycle: 'created', behavior: { parallelOpen: true },
  parameters: { type: 'object', properties: { tabAlias: { type: 'string' }, fixture: { type: 'string' }, id: { type: 'integer' } }, required: ['tabAlias', 'fixture', 'id'] },
  execute: async ({ fixture, tabAlias, id }, signal, context) => {
    const state = probes.get(fixture);
    await context.prepareCreatedTab({ id, url: `https://example.test/${id}`, title: tabAlias });
    state.started.push(`open:${tabAlias}`);
    await new Promise(resolve => {
      const release = () => { state.release.delete(tabAlias); signal.removeEventListener('abort', release); resolve(); };
      state.release.set(tabAlias, release); signal.addEventListener('abort', release, { once: true });
    });
    return bindCreatedTabResult({ tabRef: tabAlias, url: `https://example.test/${id}`, title: tabAlias, active: false }, id);
  },
});
tools.defineTool({ name: '__nested_barrier', description: 'Outer orchestration can await page work.',
  behavior: { barrier: true },
  parameters: { type: 'object', properties: { fixture: { type: 'string' } }, required: ['fixture'] },
  execute: async ({ fixture }, _signal, context) => context.invokeTool('__nested_lane_probe', { tabRef: 'page', fixture, label: 'barrier-child' }),
});
tools.defineTool({ name: '__nested_fanout', description: 'Await parallel descendants on explicit pages.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' } }, required: ['tabRef', 'fixture'] },
  execute: ({ fixture }, _signal, context) => Promise.all(Array.from({ length: 12 }, (_, index) =>
    context.invokeTool('__nested_lane_probe', { tabRef: index + 20, fixture, label: `child-${index}` }))),
});
tools.defineTool({ name: '__nested_steps', description: 'Two dependent descendants on one page.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' }, label: { type: 'string' } }, required: ['tabRef', 'fixture', 'label'] },
  execute: async ({ tabId, fixture, label }, _signal, context) => {
    await context.invokeTool('__nested_lane_probe', { tabRef: tabId, fixture, label: `${label}:first` });
    return context.invokeTool('__nested_lane_probe', { tabRef: tabId, fixture, label });
  },
});
tools.defineTool({ name: '__script_steps', description: 'Outer script with business arguments and page descendants.',
  behavior: { orchestration: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' }, label: { type: 'string' } }, required: ['tabRef', 'fixture', 'label'] },
  execute: async ({ tabRef, fixture, label }, _signal, context) => {
    await context.invokeTool('__nested_lane_probe', { tabRef, fixture, label: `${label}:first` });
    return context.invokeTool('__nested_lane_probe', { tabRef, fixture, label });
  },
});
tools.defineTool({ name: '__nested_braid', description: 'Interleaved creation, pending aliases and nested actions.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' }, prefix: { type: 'string' }, base: { type: 'integer' } }, required: ['tabRef', 'fixture', 'prefix', 'base'] },
  execute: ({ fixture, prefix, base }, _signal, context) => Promise.allSettled(Array.from({ length: 4 }, async (_, branch) => {
    const tabAlias = `${prefix}-${branch}`;
    await Promise.all([
      context.invokeTool('__nested_create', { fixture, tabAlias, id: base + branch }),
      context.invokeTool('__nested_lane_probe', { fixture, tabRef: tabAlias, label: `${tabAlias}:read` }),
    ]);
    for (let step = 0; step < 3; step++) {
      const tabRef = step === 1 ? (branch % 2 ? 7 : 'page') : 20 + branch % 2;
      const suffix = step === 2 && branch === 1 ? ':execute-fail' : step === 2 && branch === 2 ? ':commit-fail' : '';
      await context.invokeTool('__nested_steps', { fixture, tabRef, label: `${tabAlias}:${step}${suffix}` });
    }
    return tabAlias;
  })),
});
tools.defineTool({ name: '__nested_business_value', description: 'Return caller-authored data.',
  model: { preserveResult: true }, parameters: { type: 'object', properties: { fixture: { type: 'string' } } },
  execute: () => markToolValue({ code: 'BUSINESS_CODE', message: 'Business text', ok: false, error: 'A data field',
    _plugin: { tabId: 'business' }, result: '{"type":"string"}' }),
});
tools.defineTool({ name: '__nested_popup_creator', description: 'A page action produces another tab.',
  page: 'owned', tabLifecycle: 'created', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, tabAlias: { type: 'string' }, fixture: { type: 'string' } }, required: ['tabRef', 'fixture'] },
  execute: async ({ fixture, tabAlias }, _signal, context) => {
    await context.invokeTool('__nested_lane_probe', { tabRef: 'page', fixture, label: 'opener-action' });
    return bindCreatedTabResult({ tabRef: tabAlias || 12, url: 'https://example.test/12', title: 'Popup', active: false }, 12);
  },
});
tools.defineTool({ name: '__nested_observer', description: 'Passive event observation.',
  page: 'owned', behavior: { passiveWait: true, parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' } }, required: ['tabRef', 'fixture'] },
  execute: async ({ fixture }, signal) => {
    const state = probes.get(fixture);
    state.started.push('observer');
    await new Promise(resolve => {
      const release = () => { signal.removeEventListener('abort', release); resolve(); };
      state.event = release; signal.addEventListener('abort', release, { once: true });
    });
    return { observed: true };
  },
});
tools.defineTool({ name: '__nested_signal_event', description: 'Trigger the controlled event.',
  page: 'owned', behavior: { parallelTab: true },
  parameters: { type: 'object', properties: { tabRef: { type: ['integer', 'string'] }, fixture: { type: 'string' } }, required: ['tabRef', 'fixture'] },
  execute: ({ fixture }) => { const state = probes.get(fixture); state.ready = true; state.event?.(); return { signalled: true }; },
});

tools.defineTool({ name: '__wait_trigger_script', description: 'A trigger script discovers tools before acting.',
  behavior: { orchestration: true },
  parameters: { type: 'object', properties: { fixture: { type: 'string' }, tabRef: { type: 'integer' } }, required: ['fixture', 'tabRef'] },
  execute: async ({ fixture, tabRef }, _signal, context) => {
    const state = probes.get(fixture);
    if (++state.triggers === state.waitCount) state.triggersReady.resolve();
    await state.triggersReady.promise;
    await context.invokeTool('list_tools', {});
    if (++state.catalogs === state.waitCount) state.catalogsReady.resolve();
    await state.catalogsReady.promise;
    await context.invokeTool('__nested_lane_probe', { fixture, tabRef, label: `trigger:${tabRef}` });
    state.navigate(tabRef);
    return { triggered: true };
  },
});

function waitFixture(externalDrive, count = 2) {
  const f = fixture(true, 10, externalDrive);
  const event = () => {
    const listeners = new Set();
    return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
      emit: value => { for (const listener of listeners) listener(value); }, get size() { return listeners.size; } };
  };
  const updated = event(), removed = event(), before = event(), committed = event(), history = event(), fragment = event(), failed = event();
  const documents = navigationDocuments();
  const frame = tabId => ({ url: `https://example.test/${tabId}`, documentId: documents.result(tabId)[0].documentId, errorOccurred: false });
  const previous = { onUpdated: chrome.tabs.onUpdated, onRemoved: chrome.tabs.onRemoved, webNavigation: chrome.webNavigation };
  chrome.tabs.onUpdated = updated; chrome.tabs.onRemoved = removed;
  chrome.webNavigation = { onBeforeNavigate: before, onCommitted: committed, onHistoryStateUpdated: history,
    onReferenceFragmentUpdated: fragment, onErrorOccurred: failed, getFrame: async ({ tabId }) => frame(tabId) };
  Object.assign(f.state, { waitCount: count, triggers: 0, catalogs: 0,
    triggersReady: Promise.withResolvers(), catalogsReady: Promise.withResolvers(),
    navigate: tabId => { documents.commit(tabId); committed.emit({ tabId, frameId: 0, ...frame(tabId) }); },
  });
  return { ...f, trigger: tabRef => ({ name: '__wait_trigger_script', args: { fixture: f.id, tabRef } }),
    listeners: () => [updated, removed, before, committed, history, fragment, failed].reduce((count, event) => count + event.size, 0),
    dispose() {
      f.controller.abort(); f.state.triggersReady.resolve(); f.state.catalogsReady.resolve();
      for (const release of [...f.state.release.values()]) release();
      chrome.tabs.onUpdated = previous.onUpdated; chrome.tabs.onRemoved = previous.onRemoved;
      chrome.webNavigation = previous.webNavigation;
    },
  };
}

function fixture(hold = true, budget = 10, externalDrive = true) {
  const id = String(++nextFixture), controller = new AbortController();
  const state = { hold, started: [], release: new Map(), pages: new Set(), cards: [], events: [], applied: [], owned: [], discarded: [], active: 0, peak: 0 };
  probes.set(id, state);
  const aliases = { page: 7 };
  let bridge;
  const runtime = tools.createToolRuntime({
    invokeNestedTool: (parent, name, args, signal) => bridge.invokeTool(parent, name, args, signal),
    sessions: {
      getTabAliases: () => aliases, isRunCurrent: () => !controller.signal.aborted,
      reserveTabAlias: async ({ alias }) => ({ alias }),
      commitTabAlias: ({ reservation, tabId }) => { aliases[reservation.alias] = tabId; },
      discardTabAlias: () => undefined,
      reserveCreatedTab: async ({ tab }) => ({ ok: true, reservation: tab }),
      commitCreatedTab: async ({ reservation }) => { state.owned.push(reservation.id); return { ok: true }; },
      discardCreatedTab: async reservation => { if (!state.owned.includes(reservation.id)) state.discarded.push(reservation.id); },
      resolveTargetTab: async ({ tabId }) => ({ ok: true, tabId, ownedByCurrentTask: true }),
      updateWorkingTab: async () => undefined,
      observePopup: input => state.observePopup(input),
    },
  });
  bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => !controller.signal.aborted, hasAgent: () => false, getAbortSignal: () => controller.signal },
    getRuntime: () => ({ status: controller.signal.aborted ? 'aborted' : 'running' }),
    getRunToolContext: async () => ({ externalDrive }),
    canManageSessions: async () => false, buildRunProfile: async () => ({}),
    toolRuntime: { ...runtime, maxInFlight: budget,
      execute: (name, args, signal, context) => name === 'evaluate' && state.evaluate
        ? state.evaluate(args, signal, context) : runtime.execute(name, args, signal, context),
    },
    recordNestedTool: async event => { state.events.push(event); if (event.phase === 'end') state.cards.push(event); },
    applyNestedToolResult: async event => { state.applied.push(event); await state.apply?.(event); },
    collectArtifacts: () => [],
  });
  return { id, state, controller, runtime, bridge, aliases,
    call: (name, args) => bridge.handleToolCall({ sessionId: id, runId: `run-${id}`, toolName: name, args: name.startsWith('__') ? { fixture: id, ...args } : args }),
  };
}

for (const externalDrive of [false, true]) test(`a fast ${externalDrive ? 'drive' : 'native'} branch continues while same-page calls and card identities remain ordered`, async () => {
  const f = fixture(true, 10, externalDrive);
  const a = f.call('__nested_lane_probe', { tabRef: 1, label: 'a' });
  const b = f.call('__nested_lane_probe', { tabRef: 2, label: 'b' }).then(async first => {
    assert.equal(first.ok, true);
    return f.call('__nested_lane_probe', { tabRef: 2, label: 'b-next' });
  });
  const c = f.call('__nested_lane_probe', { tabRef: 1, label: 'c' });
  await tick();
  assert.deepEqual(f.state.started, ['a', 'b']);
  f.state.release.get('b')(); await tick();
  assert.deepEqual(f.state.cards.map(card => card.result.label), ['b']);
  assert.deepEqual(f.state.started, ['a', 'b', 'b-next']);
  f.state.release.get('b-next')(); await tick();
  assert.equal((await b).ok, true);
  f.state.release.get('a')(); await tick();
  assert.deepEqual(f.state.started, ['a', 'b', 'b-next', 'c']);
  f.state.release.get('c')();
  assert.ok((await Promise.all([a, b, c])).every(result => result.ok));
  assert.deepEqual(f.state.cards.map(card => card.result.label), ['b', 'b-next', 'a', 'c']);
  assert.deepEqual(f.state.applied.map(event => event.result.label), ['b', 'b-next', 'a', 'c']);
  let transcript = [];
  for (const [eventSeq, event] of f.state.events.entries()) transcript = updateTranscriptWithAgentEvent(transcript, {
    ...event, eventSeq, type: `tool_execution_${event.phase}`, toolName: event.name,
  }).transcript;
  assert.deepEqual(transcript.map(row => row.args.label), ['a', 'b', 'b-next', 'c']);
  assert.ok(transcript.every(row => !row.isRunning && row.result.label === row.args.label));
  assert.equal(new Set(transcript.map(row => row.toolCallId)).size, 4);
});

test('nested runtime keeps the shared ten-leaf budget and publishes completed calls while refilling', async () => {
  const f = fixture();
  const calls = Array.from({ length: 12 }, (_, index) => f.call('__nested_lane_probe', { tabRef: index + 1, label: String(index) }));
  await tick(); assert.equal(f.state.started.length, 10);
  f.state.release.get('9')(); await tick();
  assert.equal(f.state.started.length, 11);
  assert.deepEqual(f.state.cards.map(card => card.result.label), ['9']);
  for (const release of [...f.state.release.values()]) release();
  await tick(); f.state.release.get('11')();
  assert.ok((await Promise.all(calls)).every(result => result.ok));
  assert.equal(f.state.cards.length, 12);
});

test('ready state commits serialize without waiting for an unrelated page execution', async t => {
  const f = fixture(); t.after(() => f.controller.abort());
  let releaseCommit;
  f.state.apply = event => event.result.label === 'fast'
    ? new Promise(resolve => { releaseCommit = resolve; }) : undefined;
  const slow = f.call('__nested_lane_probe', { tabRef: 1, label: 'slow' });
  let returned = false;
  const fast = f.call('__nested_lane_probe', { tabRef: 2, label: 'fast' }).then(value => { returned = true; return value; });
  const other = f.call('__nested_lane_probe', { tabRef: 3, label: 'other' });
  await tick();
  f.state.release.get('fast')(); await tick();
  f.state.release.get('other')(); await tick();
  assert.equal(returned, false, 'a successful Promise includes the state commit');
  assert.deepEqual(f.state.applied.map(event => event.result.label), ['fast']);
  releaseCommit();
  assert.ok((await Promise.all([fast, other])).every(result => result.ok));
  assert.deepEqual(f.state.cards.map(card => card.result.label), ['fast', 'other']);
  f.state.release.get('slow')();
  assert.equal((await slow).ok, true);
});

test('a fast creator publishes ownership and its alias before consumers enter the same physical lane', async t => {
  const f = fixture(); t.after(() => f.controller.abort());
  const slow = f.call('__nested_create', { tabAlias: 'slow', id: 11 });
  const fast = f.call('__nested_create', { tabAlias: 'fast', id: 12 });
  const read = f.call('__nested_lane_probe', { tabRef: 'fast', label: 'alias-reader' });
  await tick();
  assert.deepEqual(f.state.started, ['open:slow', 'open:fast']);
  assert.deepEqual(f.state.owned, []);
  f.state.release.get('fast')(); await tick();
  assert.deepEqual(f.state.owned, [12]);
  assert.equal((await fast).result.tabRef, 'fast');
  assert.equal(f.aliases.fast, 12);
  assert.equal(f.state.started.at(-1), 'alias-reader');
  const numeric = f.call('__nested_lane_probe', { tabRef: 12, label: 'numeric-reader' });
  await tick();
  assert.equal(f.state.started.at(-1), 'alias-reader', 'the pending alias must rebind to the actual page lane');
  f.state.release.get('alias-reader')(); await tick();
  assert.equal((await read).result.page, 12);
  assert.equal(f.state.started.at(-1), 'numeric-reader');
  f.state.release.get('numeric-reader')();
  assert.equal((await numeric).result.page, 12);
  f.state.release.get('slow')();
  assert.equal((await slow).result.tabRef, 'slow');
});

test('cancellation discards a late creator without undoing its completed sibling', async () => {
  const f = fixture(false);
  const slow = f.call('__nested_create', { tabAlias: 'slow', id: 11 });
  const fast = f.call('__nested_create', { tabAlias: 'fast', id: 12 });
  const queued = f.call('__nested_lane_probe', { tabRef: 'slow', label: 'never' });
  await tick(); f.state.release.get('fast')(); await tick();
  assert.equal((await fast).ok, true);
  f.controller.abort();
  assert.ok((await Promise.all([slow, queued])).every(result => result.code === 'RUN_STOPPED'));
  assert.deepEqual(f.state.owned, [12]);
  assert.deepEqual(f.state.discarded, [11]);
  assert.equal(f.aliases.slow, undefined);
  assert.equal(f.aliases.fast, 12);
  assert.deepEqual(f.state.started, ['open:slow', 'open:fast']);
});

test('seeded dynamic workflows keep physical lanes, finite budgets and exactly one result per call', async t => {
  for (const seed of [1, 7, 29, 83]) {
    const f = fixture(true, seed % 3 + 1, seed % 2 === 1); t.after(() => f.controller.abort());
    let random = seed;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const branches = Array.from({ length: 12 }, (_, branch) => (async () => {
      const tabRef = branch % 4 === 0 ? 'page' : 7 + branch % 3;
      for (let step = 0; step < 3; step++) {
        const result = await f.call('__nested_lane_probe', { tabRef, label: `${branch}:${step}` });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.result.page, f.aliases[tabRef] ?? tabRef);
      }
    })());
    const done = Promise.all(branches); void done.catch(() => {});
    for (let step = 0; step < 36; step++) {
      await tick();
      const available = [...f.state.release];
      assert.ok(available.length, `seed ${seed}, step ${step}: stalled dynamic workflow`);
      const [label, release] = available[next() % available.length];
      f.state.release.delete(label); release();
    }
    await done;
    assert.equal(f.state.cards.length, 36);
    assert.equal(new Set(f.state.cards.map(event => event.toolCallId)).size, 36);
    assert.equal(f.state.pages.size, 0);
    assert.ok(f.state.peak <= seed % 3 + 1);
  }
});

test('adversarial interleavings mix native batches, nested branches, aliases, events, failures and cancellation', { timeout: 60_000 }, async t => {
  let histories = 0, executions = 0, commits = 0;
  for (const budget of [1, 2, 10]) for (const seed of [1, 7, 19, 29, 43, 61, 83, 101]) for (const cancel of [false, true]) {
    const f = fixture(true, budget, seed % 3 === 1), settled = [], writes = [];
    let random = seed, finished = false, outcome, rejection, writing = 0, commitId = 0, stopped;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    f.state.apply = async event => {
      if (event.isError) return;
      assert.equal(++writing, 1, 'ready state commits cannot overlap across nesting groups');
      const key = `commit:${++commitId}`;
      try {
        await new Promise(resolve => {
          const release = () => { f.state.release.delete(key); f.controller.signal.removeEventListener('abort', release); resolve(); };
          f.state.release.set(key, release); f.controller.signal.addEventListener('abort', release, { once: true });
        });
        f.controller.signal.throwIfAborted();
        if (event.args.label?.endsWith(':commit-fail')) throw Object.assign(new Error('Injected commit failure'), { code: 'FIXTURE_COMMIT_FAILED' });
        writes.push(event.toolName);
      } finally { writing--; }
    };
    const items = [
      { id: 'watch', name: '__nested_observer', args: { tabRef: 'page' } },
      { id: 'a', name: '__nested_braid', args: { tabRef: 100, prefix: 'a', base: 200 } },
      { id: 'native-a', name: '__nested_lane_probe', args: { tabRef: 20, label: 'native-a' } },
      { id: 'b', name: '__nested_braid', args: { tabRef: 101, prefix: 'b', base: 300 } },
      { id: 'trigger', name: '__nested_signal_event', args: { tabRef: 7 } },
      { id: 'native-b', name: '__nested_lane_probe', args: { tabRef: 21, label: 'native-b' } },
      { id: 'barrier', name: '__nested_barrier', args: {} },
      { id: 'after', name: '__nested_lane_probe', args: { tabRef: 22, label: 'after' } },
    ].map(item => ({ ...item, args: { ...item.args, fixture: f.id } }));
    const pending = runDriveCalls(items, {
      maxInFlight: budget, signal: f.controller.signal, aliases: f.aliases,
      context: { sessionId: f.id, runId: `run-${f.id}`, externalDrive: seed % 3 === 1 },
      getBatchTabPolicy: f.runtime.getBatchTabPolicy,
      execute: f.runtime.execute, commitToolResult: f.runtime.commitToolResult, discardToolResult: f.runtime.discardToolResult,
      onSettled: event => settled.push(event),
    }).then(result => { finished = true; outcome = result; }, error => { finished = true; rejection = error; });
    try {
      for (let round = 0; round < 1000 && !finished; round++) {
        await tick();
        if (cancel && round === 5 + seed % 31) {
          stopped = { started: f.state.started.length, writes: writes.length, owned: [...f.state.owned] };
          f.controller.abort();
        }
        const available = [...f.state.release];
        if (available.length) available[next() % available.length][1]();
        else {
          await tick(); // Cancellation settles queued calls through Promise continuations.
          assert.ok(finished || f.state.release.size, `deadlock: budget=${budget}, seed=${seed}, cancel=${cancel}, round=${round}`);
        }
      }
      assert.ok(finished, `history did not settle: budget=${budget}, seed=${seed}`);
      await pending;
      assert.equal(rejection, undefined);
      assert.ok(f.state.peak <= budget);
      assert.equal(f.state.pages.size, 0);
      assert.equal(writing, 0);
      assert.deepEqual(settled.map(event => event.id), items.map(item => item.id));
      assert.equal(new Set(f.state.started).size, f.state.started.length, 'no leaf action is replayed');
      for (const event of f.state.cards) assert.equal(f.state.events.filter(start => start.phase === 'start' && start.toolCallId === event.toolCallId).length, 1);
      assert.equal(new Set(f.state.cards.map(event => event.toolCallId)).size, f.state.cards.length);
      if (cancel) {
        assert.ok(stopped);
        assert.equal(f.state.started.length, stopped.started);
        assert.equal(writes.length, stopped.writes);
        assert.deepEqual(f.state.owned, stopped.owned);
        assert.ok(outcome.results.some(result => result.isError));
      } else {
        assert.ok(outcome.results.every(result => !result.isError), JSON.stringify(outcome));
        for (const id of ['a', 'b']) {
          const rows = outcome.results.find(result => result.id === id).result;
          assert.deepEqual(rows.map(row => row.status), ['fulfilled', 'rejected', 'rejected', 'fulfilled']);
          assert.equal(rows[1].reason.code, 'FIXTURE_EXECUTION_FAILED');
          assert.equal(rows[2].reason.code, 'FIXTURE_COMMIT_FAILED');
        }
        assert.equal(f.state.owned.length, 8);
        assert.equal(f.state.started.at(-1), 'after');
      }
      histories++; executions += f.state.started.length; commits += writes.length;
    } finally {
      f.controller.abort(); f.state.event?.();
      for (const release of [...f.state.release.values()]) release();
    }
  }
  t.diagnostic(`${histories} deterministic histories; ${executions} executions; ${commits} successful nested commits`);
});

test('a live parent reenters its page lane while later conflicting siblings stay queued', async () => {
  const f = fixture(false, 1);
  const parent = f.call('__nested_container', { tabRef: 'page' });
  const later = f.call('__nested_lane_probe', { tabRef: 'page', label: 'later' });
  const result = await parent;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { label: 'child', page: 7 });
  assert.equal((await later).ok, true);
  assert.deepEqual(f.state.started, ['child', 'later']);
  assert.deepEqual(f.state.cards.map(card => card.name), ['__nested_lane_probe', '__nested_container', '__nested_lane_probe']);
  assert.equal(f.state.cards.length, 3, 'each actual child or parent invocation has exactly one card');
});

test('a nested orchestration barrier can await its own child at budget one', async () => {
  const f = fixture(false, 1);
  const parent = f.call('__nested_barrier', {});
  const later = f.call('__nested_lane_probe', { tabRef: 9, label: 'after-barrier' });
  assert.equal((await parent).ok, true);
  assert.equal((await later).ok, true);
  assert.deepEqual(f.state.started, ['barrier-child', 'after-barrier']);
});

test('a popup creator retains the opener lane and publishes its new alias before a concurrent reader', async () => {
  const f = fixture(false, 1);
  assert.deepEqual(f.runtime.getBatchTabPolicy('wait_for_popup', { tabRef: 'page' }),
    { kind: 'create', parallel: true, targeted: true, passive: true });
  assert.deepEqual(f.runtime.getBatchTabPolicy('wait_for_popup', { tabRef: 'page', trigger: { name: '__nested_lane_probe', args: {} } }),
    { kind: 'create', parallel: true, targeted: true, orchestration: true });
  const created = f.call('__nested_popup_creator', { tabRef: 'page', tabAlias: 'popup' });
  const reader = f.call('__nested_lane_probe', { tabRef: 'popup', label: 'popup-reader' });
  assert.equal((await created).result.tabRef, 'popup');
  assert.deepEqual((await reader).result, { label: 'popup-reader', page: 12 });
  assert.deepEqual(f.state.started, ['opener-action', 'popup-reader']);
});

for (const externalDrive of [false, true]) test(`triggered navigation waits allow global children while preserving ${externalDrive ? 'drive' : 'native'} page order`, async () => {
  const f = waitFixture(externalDrive);
  try {
    const waits = [7, 8].map(tabRef => f.call('wait_for_navigation', { tabRef, timeout: 2, trigger: f.trigger(tabRef) }));
    const later = f.call('__nested_lane_probe', { tabRef: 7, label: 'after-wait' });
    await tick();
    assert.equal(f.state.catalogs, 2, 'both global children must execute before either wait deadline');
    assert.deepEqual(new Set(f.state.started), new Set(['trigger:7', 'trigger:8']));
    assert.equal(f.state.peak, 2, 'trigger actions retain cross-page parallelism');
    f.state.release.get('trigger:7')();
    assert.equal((await waits[0]).result.status, 'navigated');
    await tick();
    assert.equal(f.state.started.at(-1), 'after-wait', 'the same-page sibling starts only after its wait settles');
    assert.ok(f.state.release.has('trigger:8'), 'an unrelated pending page does not block the successor');
    f.state.release.get('after-wait')(); f.state.release.get('trigger:8')();
    assert.equal((await later).ok, true); assert.equal((await waits[1]).result.status, 'navigated');
    assert.equal(f.listeners(), 0);
    assert.equal(f.state.cards.filter(card => card.name === 'wait_for_navigation').length, 2);
  } finally { f.dispose(); }
});

test('a triggered popup wait shares nested barriers and publishes its alias before a pending reader', async () => {
  const f = waitFixture(true);
  let popup, popupDisposed = 0;
  f.state.observePopup = () => ({ result: new Promise(resolve => { popup = resolve; }), dispose: () => { popupDisposed++; } });
  const navigate = f.state.navigate;
  f.state.navigate = tabId => tabId === 8
    ? popup(bindCreatedTabResult({ tabRef: 12, url: 'https://example.test/popup', title: 'Popup', active: false }, 12))
    : navigate(tabId);
  try {
    const navigation = f.call('wait_for_navigation', { tabRef: 7, timeout: 2, trigger: f.trigger(7) });
    const created = f.call('wait_for_popup', { tabRef: 8, timeout: 2, tabAlias: 'popup', trigger: f.trigger(8) });
    const reader = f.call('__nested_lane_probe', { tabRef: 'popup', label: 'popup-reader' });
    await tick();
    assert.equal(f.state.catalogs, 2);
    assert.deepEqual(new Set(f.state.started), new Set(['trigger:7', 'trigger:8']));
    assert.equal(f.aliases.popup, undefined);
    f.state.release.get('trigger:8')();
    assert.equal((await created).result.tabRef, 'popup');
    await tick();
    assert.equal(f.aliases.popup, 12);
    assert.equal(f.state.started.at(-1), 'popup-reader');
    f.state.release.get('popup-reader')(); f.state.release.get('trigger:7')();
    assert.equal((await reader).result.page, 12); assert.equal((await navigation).ok, true);
    assert.equal(popupDisposed, 1); assert.equal(f.listeners(), 0);
  } finally { f.dispose(); }
});

test('a timed-out triggered wait cancels its page child and the next call recovers', async () => {
  const f = waitFixture(true, 1);
  try {
    const waiting = f.call('wait_for_navigation', { tabRef: 7, timeout: 0.05, trigger: f.trigger(7) });
    await tick();
    assert.deepEqual(f.state.started, ['trigger:7']);
    assert.equal((await waiting).code, 'TOOL_TIMEOUT');
    assert.equal(f.listeners(), 0);
    f.state.hold = false;
    const next = await f.call('__nested_lane_probe', { tabRef: 7, label: 'recovered' });
    assert.equal(next.ok, true); assert.equal(f.state.active, 0);
    assert.deepEqual(f.state.started, ['trigger:7', 'recovered']);
  } finally { f.dispose(); }
});

test('the registered catalog shares policy and preserves raw successful business values through the bridge', async () => {
  const f = fixture(false);
  const listed = await f.call('list_tools', {});
  assert.equal(listed.ok, true);
  assert.ok(listed.result.tools.some(tool => tool.name === 'evaluate' && typeof tool.signature === 'string'));
  assert.ok(!listed.result.tools.some(tool => tool.name === 'ask_llm'));
  const full = await f.call('list_tools', { names: ['evaluate', 'read_dom'] });
  assert.equal(full.ok, true);
  assert.deepEqual(full.result.tools.map(tool => tool.name), ['evaluate', 'read_dom']);
  assert.deepEqual(full.result.tools[0].parameters.required, ['tabRef', 'code']);
  assert.ok(full.result.tools[1].parameters.properties.tabRef);
  assert.equal((await f.call('list_tools', { names: ['ask_llm'] })).code, 'UNKNOWN_TOOL');
  const native = await f.runtime.execute('list_tools', { names: ['evaluate', 'read_dom'] }, undefined,
    { sessionId: f.id, runId: `run-${f.id}`, externalDrive: false });
  assert.deepEqual(native.tools, full.result.tools, 'native and drive use the same tool declarations');
  const result = await f.call('__nested_business_value', {});
  assert.equal(result.ok, true);
  assert.equal(result.isError, false);
  assert.equal(isToolValue(result.result), true);
  assert.deepEqual(result.result, { code: 'BUSINESS_CODE', message: 'Business text', ok: false, error: 'A data field',
    _plugin: { tabId: 'business' }, result: '{"type":"string"}' });
  assert.equal(f.state.cards.at(-1).isError, false);
  assert.equal(f.state.cards.length, 4, 'catalog successes, a catalog failure and business return each record once');
});

test('drive discovery omits its script entry and storage tools while native discovery retains them', async () => {
  const f = fixture(false);
  const names = ['run_script', 'collect_images', 'read_image_asset', 'data_store'];
  const listed = await f.call('list_tools', {});
  assert.equal(listed.ok, true);
  for (const name of names) {
    assert.ok(!listed.result.tools.some(tool => tool.name === name));
    assert.equal((await f.call('list_tools', { names: [name] })).code, 'UNKNOWN_TOOL');
  }
  const native = await f.runtime.execute('list_tools', { names }, undefined,
    { sessionId: f.id, runId: `run-${f.id}`, externalDrive: false });
  assert.deepEqual(native.tools.map(tool => tool.name), names);
  assert.ok(native.tools.every(tool => tool.parameters.type === 'object'));
});

test('passive event observations permit a same-page action and cancellation never starts queued work', async () => {
  const f = fixture(false);
  const observer = f.call('__nested_observer', { tabRef: 'page' });
  await tick();
  const action = f.call('__nested_signal_event', { tabRef: 'page' });
  assert.ok((await Promise.all([observer, action])).every(result => result.ok));
  const stopped = fixture();
  const a = stopped.call('__nested_lane_probe', { tabRef: 'page', label: 'a' });
  const b = stopped.call('__nested_lane_probe', { tabRef: 'page', label: 'b' });
  await tick(); stopped.controller.abort();
  assert.ok((await Promise.all([a, b])).every(result => result.code === 'RUN_STOPPED'));
  assert.deepEqual(stopped.state.started, ['a']);
  assert.deepEqual(stopped.state.applied, []);
  assert.deepEqual(stopped.state.cards, []);
});

test('native batches and nested wait predicates share page conflict lanes', async () => {
  for (const actionTab of [7, 9]) {
    const f = fixture();
    f.state.evaluate = async () => {
      f.state.started.push('predicate');
      await new Promise(resolve => { f.state.release.set('predicate', resolve); });
      return true;
    };
    const pending = runDriveCalls([
      { id: 'wait', name: 'wait_for_function', args: { tabRef: 'page', code: '() => true', timeout: 5 } },
      { id: 'action', name: '__nested_lane_probe', args: { tabRef: actionTab, fixture: f.id, label: 'action' } },
    ], { signal: f.controller.signal, aliases: { page: 7 },
      context: { sessionId: f.id, runId: `run-${f.id}`, externalDrive: true },
      getBatchTabPolicy: f.runtime.getBatchTabPolicy,
      execute: f.runtime.execute, commitToolResult: f.runtime.commitToolResult, discardToolResult: f.runtime.discardToolResult,
    });
    await tick();
    if (actionTab === 7) {
      assert.deepEqual(f.state.started, ['action'], 'a nested predicate cannot overlap a top-level action on its page');
      f.state.release.get('action')(); await tick();
      assert.deepEqual(f.state.started, ['action', 'predicate']);
    } else {
      assert.deepEqual(new Set(f.state.started), new Set(['action', 'predicate']), 'different explicit pages retain concurrency');
      f.state.release.get('action')();
    }
    f.state.release.get('predicate')();
    assert.ok((await pending).results.every(result => !result.isError));
  }
});

test('one physical budget covers top-level actions and a concurrent descendant fanout', async () => {
  const f = fixture();
  const pending = runDriveCalls([
    { id: 'parent', name: '__nested_fanout', args: { tabRef: 'page', fixture: f.id } },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `action-${index}`, name: '__nested_lane_probe',
      args: { tabRef: index + 40, fixture: f.id, label: `action-${index}` } })),
  ], { signal: f.controller.signal, aliases: { page: 7 },
    context: { sessionId: f.id, runId: `run-${f.id}`, externalDrive: true },
    getBatchTabPolicy: f.runtime.getBatchTabPolicy,
    execute: f.runtime.execute, commitToolResult: f.runtime.commitToolResult, discardToolResult: f.runtime.discardToolResult,
  });
  await tick();
  assert.equal(f.state.active, 10);
  assert.equal(f.state.started.length, 10);
  for (let round = 0; round < 3; round++) {
    for (const release of f.state.release.values()) release();
    await tick();
  }
  const result = await pending;
  assert.ok(result.results.every(result => !result.isError));
  assert.equal(f.state.started.length, 21);
  assert.equal(f.state.peak, 10);
});

test('an armed state wait permits an awaited read before the action that satisfies it', async () => {
  const f = fixture(false);
  f.state.evaluate = async () => Boolean(f.state.ready);
  const waiting = f.call('wait_for_function', { tabRef: 'page', code: '() => true', timeout: 2 });
  await tick();
  const read = await f.call('__nested_lane_probe', { tabRef: 'page', label: 'intermediate-read' });
  assert.equal(read.ok, true);
  const action = await f.call('__nested_signal_event', { tabRef: 'page' });
  assert.equal(action.ok, true);
  assert.equal((await waiting).ok, true);
  assert.ok(f.state.cards.every(card => !card.isError));
  assert.equal(f.state.cards.filter(card => card.name === 'wait_for_function').length, 1);
});

test('native and direct descendants record one paired call identity and their trusted parent', async () => {
  for (const mode of [false, true]) {
    const f = fixture(false, 10, mode);
    const result = await f.call('__nested_container', { tabRef: 'page' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { label: 'child', page: 7 });
    assert.deepEqual(f.state.events.map(event => [event.name, event.phase]), [
      ['__nested_container', 'start'], ['__nested_lane_probe', 'start'],
      ['__nested_lane_probe', 'end'], ['__nested_container', 'end'],
    ]);
    const [parent, child, childEnd, parentEnd] = f.state.events;
    assert.notEqual(parent.toolCallId, child.toolCallId);
    assert.equal(parentEnd.toolCallId, parent.toolCallId);
    assert.equal(result.toolCallId, parent.toolCallId, 'Worker trace receives the authoritative sidebar identity');
    assert.equal(childEnd.toolCallId, child.toolCallId);
    assert.equal(child.parentCallId, parent.toolCallId);
    assert.equal(child.parentSpanId, `tool:${parent.toolCallId}`);
    assert.equal(childEnd.parentCallId, parent.toolCallId);
    assert.ok(f.state.events.every(event => event.externalDrive === mode));
    assert.equal(f.state.applied.length, 2, 'recording never applies effects a second time');
  }
});

test('script containers overlap across pages and serialize actual descendants on the same page', async () => {
  for (const budget of [1, 10]) {
    const f = fixture(true, budget);
    const promises = [f.call('__script_steps', { tabRef: 'page', label: 'slow' }),
      f.call('__script_steps', { tabRef: 8, label: 'fast' }),
      f.call('__script_steps', { tabRef: 7, label: 'same' })];
    await tick();
    assert.deepEqual(f.state.started, budget === 1 ? ['slow:first'] : ['slow:first', 'fast:first']);
    if (budget === 10) {
      f.state.release.get('fast:first')(); await tick();
      assert.ok(f.state.started.includes('fast'), 'a fast packaged workflow can continue before a slow sibling');
      f.state.release.get('fast')(); await tick();
      assert.ok(f.state.cards.some(card => card.name === '__script_steps' && card.args.label === 'fast'));
    }
    let complete = false;
    const all = Promise.all(promises).then(value => { complete = true; return value; });
    for (let i = 0; i < 100 && !complete; i++) {
      for (const release of [...f.state.release.values()]) release();
      await tick();
    }
    assert.equal(complete, true, 'containers must not consume the leaf budget or block their own descendants');
    assert.ok((await all).every(result => result.ok));
    assert.ok(f.state.peak <= budget);
    assert.equal(f.state.cards.length, 9);
    assert.equal(new Set(f.state.cards.map(card => card.toolCallId)).size, 9);
  }
});

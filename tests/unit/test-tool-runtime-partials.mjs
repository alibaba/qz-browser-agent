import assert from 'node:assert/strict';
import test from 'node:test';
import { runToolWithTimeout } from '../../src/background/tools/tool-timeout.js';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { localizeToolFailureCode } from '../../src/shared/tools/tool-error-localization.js';
import { withLanguage } from '../../src/shared/i18n/index.js';
import { clearTraceLog, getTraceLog } from '../../src/background/trace.js';
import { resolveToolState } from '../../src/sidepanel/tools/tool-model.js';

const never = () => new Promise(() => {});
const context = { sessionId: 'partials', runId: 'run', workingTabId: 1 };
const partialResult = async partial => ({ ...partial.result, incomplete: { reason: 'timeout', pending: partial.pending } });

test('deadline retains an immutable per-call partial and rejects late updates', async () => {
  let report, signal;
  const value = { rows: [1] };
  const result = await runToolWithTimeout('read', async (s, publish) => {
    signal = s; report = publish; publish(value, 'remaining rows'); value.rows.push(2); return never();
  }, undefined, 15, partialResult, context);
  assert.deepEqual(result, { rows: [1], incomplete: { reason: 'timeout', pending: 'remaining rows' } });
  assert.equal(signal.aborted, true); assert.equal(signal.reason.code, 'TOOL_TIMEOUT');
  report({ rows: [3] }, 'late'); assert.deepEqual(result.rows, [1]);
  await assert.rejects(runToolWithTimeout('other', never, undefined, 15, partialResult, context), { code: 'TOOL_TIMEOUT' });
});

test('cancellation and security failures retain their original errors despite a partial', async () => {
  for (const timeout of [0, 100]) {
    const controller = new AbortController();
    const run = runToolWithTimeout('read', async (_signal, publish) => {
      publish({ text: 'partial' }, 'rest'); controller.abort(); return never();
    }, controller.signal, timeout, partialResult, context);
    await assert.rejects(run, { code: 'OPERATION_ABORTED' });
  }
  await assert.rejects(runToolWithTimeout('read', async (_signal, publish) => {
    publish({ text: 'partial' }, 'rest'); throw Object.assign(new Error('blocked'), { code: 'SECURITY_GUARDRAIL_BLOCKED' });
  }, undefined, 100, partialResult, context), { code: 'SECURITY_GUARDRAIL_BLOCKED' });
});

let tabs = new Map(), created = 1, removed = [], updates = [], contentCalls = 0, redirectBlocked = false, probeBusy = false;
const listeners = new Set(), reservations = new Map();
function reset() {
  tabs = new Map([[1, { id: 1, windowId: 2, url: 'https://example.test/old', title: 'Article', status: 'loading' }]]);
  removed = []; updates = []; contentCalls = 0; redirectBlocked = false; probeBusy = false; reservations.clear();
}
reset();
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return { securityGuardrails: { blockedDomains: ['blocked.test'] } }; } } },
  tabs: {
    async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
    async create(options) { const tab = { id: ++created, windowId: 2, status: 'loading', title: '', ...options }; tabs.set(tab.id, tab); return tab; },
    async remove(id) { removed.push(id); tabs.delete(id); },
    async update(id, update) {
      const tab = tabs.get(id); if (!tab) throw new Error('No tab');
      if (update.url) { tab.pendingUrl = redirectBlocked ? 'https://blocked.test/' : update.url; tab.status = 'loading'; }
      return { ...tab };
    },
    onUpdated: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    async sendMessage(_id, message) {
      if (message.action === 'ping') return { ok: true };
      contentCalls++; return never();
    },
  },
  scripting: { async executeScript(options) {
    if (probeBusy) return never();
    const tab = tabs.get(options.target.tabId);
    return [{ documentId: 'doc', result: { readyState: 'interactive', title: tab.title, url: tab.url, observedAt: 1 } }];
  } },
};
const { createToolRuntime, defineTool } = await import('../../src/background/tools/runtime.js');
const runtime = createToolRuntime({
  windowTarget: { resolveForNewTab: async () => 2 },
  sessions: {
    isRunCurrent: () => true,
    async resolveTargetTab({ tabId }) { return tabs.has(tabId) ? { ok: true, tabId, ownedByCurrentTask: true } : { ok: false, code: 'SESSION_TAB_UNAVAILABLE' }; },
    async updateWorkingTab(value) { updates.push(value); return { ok: true }; },
    listOwnedTabIds: () => [...tabs.keys()],
    async reserveCreatedTab({ tab }) { const reservation = {}; reservations.set(reservation, tab.id); return { ok: true, reservation }; },
    async commitCreatedTab({ reservation }) {
      const id = reservations.get(reservation); if (!id || !tabs.has(id)) return { ok: false, code: 'SESSION_TAB_UNAVAILABLE' };
      updates.push({ tab: tabs.get(id) }); reservations.delete(reservation); return { ok: true };
    },
    async discardCreatedTab(reservation) { const id = reservations.get(reservation); if (id) { await chrome.tabs.remove(id); reservations.delete(reservation); } },
  },
});

test('normal reads never wait for or start a page-state probe', async () => {
  reset();
  const sendMessage = chrome.tabs.sendMessage, executeScript = chrome.scripting.executeScript;
  let probes = 0;
  chrome.tabs.sendMessage = async (_id, message) => message.action === 'ping' ? { ok: true } : { text: 'Ready', elements: [] };
  chrome.scripting.executeScript = () => { probes++; return never(); };
  try {
    for (const name of ['read_article', 'find_elements']) {
      await clearTraceLog();
      const result = await runtime.execute(name, { tabId: 1, limit: 100 }, undefined, { ...context, toolCallId: 'call' });
      const phases = (await getTraceLog()).filter(line => line.includes(' tool_phase '));
      assert.equal(phases.length, 1);
      assert.match(phases[0], /call=call /);
      assert.match(phases[0], /injectionCount=1 injectionMs=\d+ extractionCount=1 extractionMs=\d+/);
      assert.doesNotMatch(JSON.stringify(result), /tool_phase|injectionMs|extractionMs/);
      assert.equal(result.incomplete, undefined);
      assert.equal(result.error, undefined);
    }
    assert.equal(probes, 0, 'page-state sampling belongs only to the hard-timeout fallback');
  } finally { chrome.tabs.sendMessage = sendMessage; chrome.scripting.executeScript = executeScript; }
});

test('ten concurrent page readers isolate targets and cancellation without updating the working tab', async () => {
  reset();
  for (let id = 1; id <= 10; id++) tabs.set(id, { id, windowId: 2, url: `https://example.test/${id}`, title: `Page ${id}`, status: 'complete' });
  const sendMessage = chrome.tabs.sendMessage, releases = new Map();
  chrome.tabs.sendMessage = async (id, message) => message.action === 'ping' ? { ok: true, documentReady: true }
    : new Promise(resolve => releases.set(id, () => resolve({ text: `article ${id}` })));
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const pending = controllers.map((controller, index) => runtime.execute('read_article', { tabId: index + 1, limit: 100 }, controller.signal,
    { ...context, toolCallId: `read-${index + 1}`, preserveWorkingTab: true }).then(value => ({ value }), error => ({ error })));
  try {
    for (let i = 0; releases.size < 10 && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.size, 10);
    controllers[4].abort();
    assert.equal((await pending[4]).error.code, 'OPERATION_ABORTED');
    for (let id = 10; id >= 1; id--) releases.get(id)();
    const results = await Promise.all(pending);
    for (let i = 0; i < 10; i++) if (i !== 4) {
      assert.equal(results[i].error, undefined);
      assert.equal(results[i].value.text, `article ${i + 1}`);
      assert.equal(results[i].value._tabId, i + 1);
      assert.equal(results[i].value._pageUrl, `https://example.test/${i + 1}`);
    }
    assert.equal(updates.length, 0, 'completed and late cancelled observations keep working-tab authority unchanged');
    await assert.rejects(runtime.execute('read_article', { tabId: 99, limit: 100 }, undefined,
      { ...context, preserveWorkingTab: true }), { code: 'SESSION_TAB_UNAVAILABLE' });
    assert.equal(releases.has(99), false, 'parallel eligibility never grants access to an unowned page');
  } finally {
    controllers.forEach(controller => controller.abort());
    releases.forEach(release => release()); await Promise.all(pending);
    chrome.tabs.sendMessage = sendMessage; reset();
  }
});

test('read_article and find_elements retain actual page state when synchronous extraction stalls', async () => {
  for (const name of ['read_article', 'find_elements']) {
    reset();
    const result = await runtime.execute(name, { tabId: 1, limit: 100, timeout: 0.01 }, undefined, { ...context, preserveWorkingTab: true });
    assert.equal(result.incomplete.reason, 'timeout');
    assert.equal(result.pageState.readyState, 'interactive');
    assert.equal(resolveToolState({ name, result }), 'incomplete');
    assert.equal(result.pageState.url, 'https://example.test/old');
    assert.equal(result.pageState.title, 'Article');
    assert.equal(result.text, undefined); assert.equal(contentCalls, 1); assert.equal(updates.length, 0);
  }
});

test('open_tab and navigate retain a loading tab and its current URL on the existing timeout', async () => {
  for (const name of ['open_tab', 'navigate']) {
    reset();
    const result = await runtime.execute(name, { url: 'https://example.test/new', ...(name === 'navigate' ? { tabId: 1 } : {}), timeout: 0.01 }, undefined, context);
    assert.equal(resolveToolState({ name, result }), 'incomplete');
    assert.equal(result.incomplete.reason, 'timeout'); assert.equal(result.loading, true);
    assert.equal(result.url, name === 'open_tab' ? 'about:blank' : 'https://example.test/old');
    assert.equal(result.pageState.pendingUrl, 'https://example.test/new');
    assert.ok(tabs.has(result.tabId)); assert.deepEqual(removed, []); assert.equal(listeners.size, 0);
  }
});

test('a deferred navigation timeout retains the tab only when its original-order commit is authorized', async () => {
  for (const cancelled of [false, true]) {
    reset();
    const result = await runtime.execute('open_tab', { url: 'https://example.test/new', timeout: 0.01 }, undefined,
      { ...context, deferToolCommit: true, deferCreatedTabSelection: true });
    assert.equal(result.incomplete.reason, 'timeout'); assert.equal(updates.length, 0); assert.ok(tabs.has(result.tabId));
    const controller = new AbortController();
    if (cancelled) {
      controller.abort(); await assert.rejects(runtime.commitToolResult(result, controller.signal, context), { code: 'OPERATION_ABORTED' });
      assert.equal(tabs.has(result.tabId), false); assert.equal(updates.length, 0);
    } else {
      await runtime.commitToolResult(result, controller.signal, context);
      assert.equal(updates.length, 1); assert.ok(tabs.has(result.tabId));
    }
    assert.equal(reservations.size, 0);
  }
});

test('open_tab cancellation and blocked timeout redirects still remove the created tab', async () => {
  reset();
  const controller = new AbortController();
  const run = runtime.execute('open_tab', { url: 'https://example.test/new' }, controller.signal, context);
  while (tabs.size < 2 || !tabs.get(created)?.pendingUrl) await new Promise(resolve => setTimeout(resolve, 2));
  controller.abort(); await assert.rejects(run, { code: 'OPERATION_ABORTED' });
  assert.ok(removed.includes(created));
  reset(); redirectBlocked = true;
  await assert.rejects(runtime.execute('open_tab', { url: 'https://example.test/new', timeout: 0.01 }, undefined, context), { code: 'SECURITY_GUARDRAIL_BLOCKED' });
  assert.ok(removed.includes(created));
});

test('side-effect timeout reports an unconfirmed attempt without replay', async () => {
  reset();
  const result = await runtime.execute('act_on_element', { tabId: 1, target: 'css:button', action: 'click', timeout: 0.01 }, undefined, context);
  assert.equal(result.incomplete.reason, 'timeout'); assert.equal(result.status, 'unconfirmed');
  assert.equal(result.mayHaveTakenEffect, true); assert.equal(result.automaticReplay, false);
  assert.equal(contentCalls, 1);
  assert.ok(result.error);
  assert.equal(result.code, 'TOOL_TIMEOUT');
  assert.equal(updates.length, 0, 'an unconfirmed action must not update the working tab');
});

test('action timeout stays an error in Agent events and never issues effects', async () => {
  let attempts = 0, effectCalls = 0;
  defineTool({ name: '__partial_action', description: 'Synthetic action', timeout: 20,
    parameters: { type: 'object', properties: { tabId: { type: 'number' } } },
    behavior: { timeoutResult: { kind: 'action', pending: 'action outcome confirmation' } },
    effects: () => { effectCalls++; return [{ type: 'context.siteChanged' }]; },
    execute: async () => { attempts++; return never(); },
  });
  for (const language of ['zh-CN', 'en']) {
    reset();
    const before = attempts, events = [];
    const agent = new Agent(context.sessionId, createTestAgentOptions({ tools: runtime }));
    agent._currentRunId = context.runId;
    agent._runLanguage = language;
    agent._emit = event => events.push(event);
    const messages = await agent._executeToolCalls([{ id: 'action', function: {
      name: '__partial_action', arguments: JSON.stringify({ tabId: 1 }),
    } }], new AbortController().signal);
    const end = events.find(event => event.type === 'tool_execution_end');
    assert.equal(end.isError, true);
    assert.ok(end.result.error);
    assert.equal(end.result.code, 'TOOL_TIMEOUT');
    assert.equal(end.result.codeLabel, withLanguage(language, () => localizeToolFailureCode('TOOL_TIMEOUT')));
    assert.equal(end.result.details.timeout, 20);
    assert.match(end.result.note, language === 'en' ? /may have taken effect/ : /可能已生效/);
    assert.equal(end.result.mayHaveTakenEffect, true);
    assert.equal(end.result.automaticReplay, false);
    assert.match(JSON.stringify(messages), /TOOL_TIMEOUT/);
    assert.deepEqual(runtime.consumeEffects(end.result, context), []);
    assert.equal(effectCalls, 0);
    assert.equal(updates.length, 0);
    assert.equal(attempts - before, 1);
  }
});

defineTool({ name: '__partial_read', description: 'Synthetic staged read', parameters: { type: 'object', properties: {} },
  timeout: 20, behavior: { timeoutResult: { kind: 'read', pending: 'read' } },
  execute: async (_args, _signal, ctx) => {
    ctx.reportPartial({ tabId: 1, text: 'old content', pageState: { documentId: 'old', url: 'https://example.test/old' } }, 'child frames');
    return never();
  },
});
test('timeout rejects closed tabs and drops content from an obsolete document', async () => {
  reset();
  const result = await runtime.execute('__partial_read', {}, undefined, context);
  assert.equal(result.text, undefined); assert.equal(result.incomplete.pending, 'current document content');
  const run = runtime.execute('__partial_read', {}, undefined, context);
  await new Promise(resolve => setTimeout(resolve, 5)); tabs.delete(1);
  await assert.rejects(run, { code: 'SESSION_TAB_UNAVAILABLE' });
});

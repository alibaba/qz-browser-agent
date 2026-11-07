import assert from 'node:assert/strict';
import test from 'node:test';
import { createdTabResultId } from '../../src/shared/contracts/page-observation.js';
import { getToolResultPresentation } from '../../src/shared/contracts/tool-result-presentation.js';
import { runToolWithTimeout } from '../../src/background/tools/tool-timeout.js';
import { createToolOperation, withToolOperationFailure } from '../../src/background/tools/tool-operation.js';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { localizeToolFailureCode, localizeToolFailureError } from '../../src/shared/tools/tool-error-localization.js';
import { withLanguage } from '../../src/shared/i18n/index.js';
import { clearTraceLog, getTraceLog } from '../../src/background/trace.js';
import { resolveToolState } from '../../src/sidepanel/tools/tool-model.js';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker } from '../support/inner-runner-fixture.mjs';

const never = () => new Promise(() => {});
const context = { sessionId: 'partials', runId: 'run', workingTabId: 1 };
const partialResult = async partial => ({ ...partial.result, incomplete: { reason: 'timeout', pending: partial.pending } });

test('execution evidence preserves native DOMException identity without mutating the original error', () => {
  for (const name of ['NotAllowedError', 'AbortError', 'TimeoutError']) {
    const operation = createToolOperation();
    operation.prepare({ tool: 'evaluate', tabRef: 'page' });
    operation.dispatch();
    const original = Object.assign(new DOMException('Browser operation stopped', name), {
      details: { reason: 'browser refused' }, marker: { source: 'browser' },
    });
    const stack = original.stack;
    const originalDetails = original.details;
    const decorated = withToolOperationFailure(original, operation);
    assert.notEqual(decorated, original);
    assert.ok(decorated instanceof DOMException);
    assert.equal(decorated.name, name);
    assert.equal(decorated.message, original.message);
    assert.equal(decorated.code, original.code, 'native accessors retain a genuine DOMException receiver');
    assert.equal(decorated.stack, stack);
    assert.deepEqual(decorated.marker, original.marker);
    assert.equal(decorated.details.status, 'unconfirmed');
    assert.equal(decorated.details.reason, 'browser refused');
    const localized = withLanguage('en', () => localizeToolFailureError(decorated, { toolName: 'evaluate' }));
    assert.equal(localized, decorated);
    assert.equal(localized.code, original.code);
    assert.equal(localized.name, original.name);
    assert.equal(localized.message, original.message);
    assert.equal(original.details, originalDetails);
    assert.deepEqual(original.details, { reason: 'browser refused' });
    assert.equal(original.stack, stack);
  }
});

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

test('tool deadlines retain only the caller alias and public element operation identity', async () => {
  const locator = { role: 'button', name: 'Submit', nth: 2 };
  for (const query of [locator, { ...locator, backendNodeId: 17 }]) {
    await assert.rejects(runToolWithTimeout('act_on_element', never, undefined, 10, partialResult,
      { ...context, requestedTabRef: 'checkout' }, undefined,
      { tabId: 981, locator: query, action: 'fill', index: 0, value: 'secret input', code: 'secret source' }), error => {
      assert.equal(error.code, 'TOOL_TIMEOUT');
      assert.equal(error.details.tabRef, 'checkout');
      assert.deepEqual(error.details.locator, query === locator ? locator : undefined);
      assert.equal(error.details.action, 'fill'); assert.equal(error.details.index, 0);
      assert.doesNotMatch(JSON.stringify(error), /tabId|backendNodeId|secret/);
      return true;
    });
  }
});

test('a tool with no local timeout still observes its parent deadline and stops late work', async () => {
  let invoked = 0, signal;
  await assert.rejects(runToolWithTimeout('nested', async current => { invoked++; signal = current; return never(); },
    undefined, 0, partialResult, { ...context, deadlineAt: Date.now() + 20 }), { code: 'TOOL_TIMEOUT' });
  assert.equal(invoked, 1); assert.equal(signal.aborted, true);
  await assert.rejects(runToolWithTimeout('expired', async () => { invoked++; },
    undefined, 1000, partialResult, { ...context, deadlineAt: Date.now() - 1 }), { code: 'TOOL_TIMEOUT' });
  assert.equal(invoked, 1, 'an expired parent budget must not dispatch another tool');
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
      if (message.action === 'ping') return { ok: true, contentType: 'text/html', elementRefs: 1 };
      contentCalls++; return never();
    },
  },
  scripting: { async executeScript(options) {
    if (probeBusy) return never();
    if (options.func?.name === "documentReadiness") return [{ documentId: "doc", result: true }];
    const tab = tabs.get(options.target.tabId);
    return [{ documentId: 'doc', result: { readyState: 'interactive', title: tab.title, url: tab.url, observedAt: 1 } }];
  } },
};
const { createToolRuntime, defineTool } = await import('../../src/background/tools/runtime.js');
const runtime = createToolRuntime({
  windowTarget: { resolveForNewTab: async () => 2 },
  sessions: {
    isRunCurrent: () => true,
    getTabAliases: () => ({ checkout: 1 }),
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

test('normal reads prepare DOM without collecting full page-state diagnostics', async () => {
  reset();
  const sendMessage = chrome.tabs.sendMessage, executeScript = chrome.scripting.executeScript;
  let probes = 0, readiness = 0;
  chrome.tabs.sendMessage = async (_id, message) => message.action === 'ping' ? { ok: true, contentType: 'text/html', elementRefs: 1 } : { text: 'Ready', elements: [] };
  chrome.scripting.executeScript = options => {
    if (options.func?.name === "documentReadiness") { readiness++; return Promise.resolve([{ result: true, documentId: "doc" }]); }
    probes++; return never();
  };
  try {
    for (const name of ['read_article', 'find_elements']) {
      await clearTraceLog();
      const result = await runtime.execute(name, { tabRef: 1, limit: 100 }, undefined, { ...context, toolCallId: 'call' });
      const phases = (await getTraceLog()).filter(line => line.includes(' tool_phase '));
      assert.equal(phases.length, 1);
      assert.match(phases[0], /call=call /);
      assert.match(phases[0], /injectionCount=1 injectionMs=\d+ extractionCount=1 extractionMs=\d+/);
      assert.doesNotMatch(JSON.stringify(result), /tool_phase|injectionMs|extractionMs/);
      assert.equal(result.incomplete, undefined);
      assert.equal(result.error, undefined);
    }
    assert.equal(probes, 0, 'page-state sampling belongs only to the hard-timeout fallback');
    assert.equal(readiness, 2, 'page readers explicitly prepare their documents');
  } finally { chrome.tabs.sendMessage = sendMessage; chrome.scripting.executeScript = executeScript; }
});

test('ten concurrent page readers isolate targets and cancellation without updating the working tab', async () => {
  reset();
  for (let id = 1; id <= 10; id++) tabs.set(id, { id, windowId: 2, url: `https://example.test/${id}`, title: `Page ${id}`, status: 'complete' });
  const sendMessage = chrome.tabs.sendMessage, releases = new Map();
  chrome.tabs.sendMessage = async (id, message) => message.action === 'ping' ? { ok: true, documentReady: true, contentType: 'text/html', elementRefs: 1 }
    : new Promise(resolve => releases.set(id, () => resolve({ text: `article ${id}` })));
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const pending = controllers.map((controller, index) => runtime.execute('read_article', { tabRef: index + 1, limit: 100 }, controller.signal,
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
      assert.equal(results[i].value.tabRef, undefined);
      assert.equal(Object.hasOwn(results[i].value, '_pageUrl'), false);
      assert.equal(getToolResultPresentation(results[i].value)._pageUrl, `https://example.test/${i + 1}`);
      assert.deepEqual(runtime.getToolResultPageContext(results[i].value), getToolResultPresentation(results[i].value));
    }
    assert.equal(updates.length, 0, 'completed and late cancelled observations keep working-tab authority unchanged');
    await assert.rejects(runtime.execute('read_article', { tabRef: 99, limit: 100 }, undefined,
      { ...context, preserveWorkingTab: true }), { code: 'SESSION_TAB_UNAVAILABLE' });
    assert.equal(releases.has(99), false, 'parallel eligibility never grants access to an unowned page');
  } finally {
    controllers.forEach(controller => controller.abort());
    releases.forEach(release => release()); await Promise.all(pending);
    chrome.tabs.sendMessage = sendMessage; reset();
  }
});

test('stalled page readers reject with localized recovery and public page state', async () => {
  for (const language of ['zh-CN', 'en']) for (const name of ['read_article', 'find_elements']) {
    reset();
    await assert.rejects(runtime.execute(name, { tabRef: 1, limit: 100, timeout: 0.01 }, undefined,
      { ...context, language, preserveWorkingTab: true }), error => {
      assert.equal(error.code, 'TOOL_TIMEOUT');
      assert.match(error.hint, language === 'en' ? /[A-Za-z]/ : /[\u3400-\u9fff]/);
      assert.equal(error.details.tabRef, 1);
      assert.ok(error.details.pending);
      assert.equal(error.details.pageState.readyState, 'interactive');
      assert.equal(error.details.pageState.url, 'https://example.test/old');
      assert.equal(error.details.pageState.title, 'Article');
      assert.equal(resolveToolState({ name, result: error.toJSON() }), 'error');
      assert.doesNotMatch(JSON.stringify(error), /"(?:text|incomplete|tabId|documentId)":/);
      return true;
    });
    assert.equal(contentCalls, 1); assert.equal(updates.length, 0);
  }
});

test('qz SDK read failures cross the script bridge, stop processing, and permit explicit retry', async () => {
  const compiled = await compileInnerWorker({ mode: 'production' });
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => true, getAbortSignal: () => undefined },
    getRuntime: () => ({ status: 'running' }), canManageSessions: async () => true,
    buildRunProfile: async () => ({ session: { canManageSessions: true } }),
    getRunToolContext: async () => ({ language: 'en' }), toolRuntime: runtime,
    collectArtifacts: () => [],
  });
  const sendMessage = chrome.tabs.sendMessage;
  try {
    for (const recover of [false, true]) {
      reset();
      const responses = [];
      const code = recover ? `
        const page = qz.tab(1);
        try { await page.read({timeout: .01}); }
        catch (error) { trace(error.code); }
        return (await page.read({timeout: 1})).text.toUpperCase();
      ` : `
        const article = await qz.tab(1).read({timeout: .01});
        trace("processing article");
        return article.text.toUpperCase();
      `;
      chrome.tabs.sendMessage = sendMessage;
      const { result } = await runInnerWorker(compiled, code, {
        strictResult: true,
        async onMessage(message, reply) {
          if (message.type !== 'tool_call') return;
          const response = await bridge.handleToolCall({ ...message, sessionId: context.sessionId, runId: context.runId });
          responses.push(response);
          if (recover && responses.length === 1) chrome.tabs.sendMessage = async (_id, request) => request.action === 'ping'
            ? { ok: true, contentType: 'text/html', elementRefs: 1 } : { text: 'Recovered article' };
          reply({ type: 'tool_response', callId: message.callId, response });
        },
      });
      assert.equal(responses[0].ok, false);
      assert.equal(responses[0].code, 'TOOL_TIMEOUT');
      assert.ok(responses[0].hint);
      assert.equal(responses[0].details.pageState.title, 'Article');
      assert.equal(result.ok, recover);
      assert.equal(responses.length, recover ? 2 : 1);
      assert.ok(!result.trace.some(row => row.message === 'processing article'));
      if (recover) {
        assert.equal(result.result, 'RECOVERED ARTICLE');
        assert.ok(result.trace.some(row => row.message === 'TOOL_TIMEOUT'));
      } else {
        assert.equal(result.code, 'TOOL_TIMEOUT');
        assert.equal(result.hint, responses[0].hint);
        assert.deepEqual(result.details.pageState, responses[0].details.pageState);
      }
    }
  } finally { chrome.tabs.sendMessage = sendMessage; reset(); }
});

test('open_tab and navigate retain a loading tab and its current URL on the existing timeout', async () => {
  for (const name of ['open_tab', 'navigate']) {
    reset();
    const result = await runtime.execute(name, { url: 'https://example.test/new', ...(name === 'navigate' ? { tabRef: 1 } : {}), timeout: 0.01 }, undefined, context);
    assert.equal(resolveToolState({ name, result }), 'incomplete');
    assert.equal(result.incomplete.reason, 'timeout'); assert.equal(result.loading, true);
    assert.equal(result.url, name === 'open_tab' ? 'about:blank' : 'https://example.test/old');
    assert.equal(result.pageState.pendingUrl, 'https://example.test/new');
    assert.ok(tabs.has(name === "open_tab" ? createdTabResultId(result) : 1)); assert.deepEqual(removed, []); assert.equal(listeners.size, 0);
  }
});

test('a deferred navigation timeout retains the tab only when its original-order commit is authorized', async () => {
  for (const cancelled of [false, true]) {
    reset();
    const result = await runtime.execute('open_tab', { url: 'https://example.test/new', timeout: 0.01 }, undefined,
      { ...context, deferToolCommit: true, deferCreatedTabSelection: true });
    assert.equal(result.incomplete.reason, 'timeout'); assert.equal(updates.length, 0); assert.ok(tabs.has(createdTabResultId(result)));
    const controller = new AbortController();
    if (cancelled) {
      controller.abort(); await assert.rejects(runtime.commitToolResult(result, controller.signal, context), { code: 'OPERATION_ABORTED' });
      assert.equal(tabs.has(createdTabResultId(result)), false); assert.equal(updates.length, 0);
    } else {
      await runtime.commitToolResult(result, controller.signal, context);
      assert.equal(updates.length, 1); assert.ok(tabs.has(createdTabResultId(result)));
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

test('action preparation timeout reports that input was never dispatched', async () => {
  reset();
  const result = await runtime.execute('act_on_element', { tabRef: 'checkout', target: 'css:button', action: 'click', timeout: 0.01 }, undefined, context);
  assert.equal(result.details.status, 'not_started');
  assert.equal(result.details.tabRef, 'checkout');
  assert.equal(result.details.target, 'css:button');
  assert.equal(result.details.action, 'click');
  assert.equal(result.details.executed, false);
  assert.equal(result.details.mayHaveTakenEffect, false); assert.equal(result.details.automaticReplay, false);
  assert.equal(contentCalls, 1);
  assert.ok(result.message);
  assert.equal(result.code, 'TOOL_TIMEOUT');
  assert.equal(updates.length, 0, 'an action that never dispatched must not update task page state');
});

test('action timeout stays an error in Agent events and never issues effects', async () => {
  let attempts = 0, effectCalls = 0;
  defineTool({ name: '__partial_action', description: 'Synthetic action', timeout: 20,
    parameters: { type: 'object', properties: { tabRef: { type: 'integer' } }, required: ['tabRef'] }, page: 'owned',
    behavior: { reportsExecution: true, timeoutResult: { kind: 'action', pending: 'action outcome confirmation' } },
    effects: () => { effectCalls++; return [{ type: 'context.siteChanged' }]; },
    execute: async (_args, _signal, context) => {
      attempts++; context.operation.dispatch();
      context.reportPartial({ trace: ['Submitted checkout'] }, 'action outcome confirmation');
      return never();
    },
  });
  for (const language of ['zh-CN', 'en']) {
    reset();
    const before = attempts, events = [];
    const agent = new Agent(context.sessionId, createTestAgentOptions({ tools: runtime }));
    agent._currentRunId = context.runId;
    agent._runLanguage = language;
    agent._emit = event => events.push(event);
    const messages = await agent._executeToolCalls([{ id: 'action', function: {
      name: '__partial_action', arguments: JSON.stringify({ tabRef: 1 }),
    } }], new AbortController().signal);
    const end = events.find(event => event.type === 'tool_execution_end');
    assert.equal(end.isError, true);
    assert.ok(end.result.message);
    assert.equal(end.result.code, 'TOOL_TIMEOUT');
    assert.equal(end.result.details.timeoutMs, 20);
    assert.equal(end.result.details.mayHaveTakenEffect, true);
    assert.equal(end.result.details.automaticReplay, false);
    assert.deepEqual(end.result.details.trace, ['Submitted checkout']);
    assert.match(JSON.stringify(messages), /TOOL_TIMEOUT/);
    assert.deepEqual(runtime.consumeEffects(end.result, context), []);
    assert.equal(effectCalls, 0);
    assert.equal(updates.length, 0);
    assert.equal(attempts - before, 1);
  }
});

test('action errors and cancellation preserve dispatch facts through the runtime', async () => {
  let controller, operation;
  defineTool({ name: '__action_evidence', description: 'Synthetic action with explicit dispatch evidence', timeout: 20,
    parameters: { type: 'object', properties: { stage: { type: 'string' }, ending: { type: 'string' } }, required: ['stage', 'ending'] },
    behavior: { reportsExecution: true, timeoutResult: { kind: 'action', pending: 'action outcome confirmation' } },
    execute: async ({ stage, ending }, _signal, context) => {
      operation = context.operation;
      if (stage !== 'not_started') operation.dispatch();
      if (stage === 'completed') operation.confirm();
      if (ending === 'throw') throw Object.assign(new Error('Confirmation failed'), { code: 'CONFIRMATION_FAILED' });
      if (ending === 'cancel') controller.abort();
      return never();
    },
  });
  for (const stage of ['not_started', 'unconfirmed', 'completed']) for (const ending of ['throw', 'cancel', 'timeout']) {
    controller = new AbortController();
    const result = await runtime.execute('__action_evidence', { stage, ending }, controller.signal, { ...context, language: 'en' })
      .catch(error => error);
    assert.equal(result.code, ending === 'throw' ? 'CONFIRMATION_FAILED' : ending === 'cancel' ? 'OPERATION_ABORTED' : 'TOOL_TIMEOUT');
    assert.equal(result.details.status, stage);
    assert.equal(result.details.executed, stage === 'not_started' ? false : stage === 'completed' ? true : undefined);
    assert.equal(result.details.mayHaveTakenEffect, stage !== 'not_started');
    assert.equal(result.details.automaticReplay, false);
    if (ending === 'timeout') assert.match(result.message, {
      not_started: /__action_evidence timed out before execution started/,
      unconfirmed: /__action_evidence timed out.*completion is unconfirmed/,
      completed: /__action_evidence completed.*action outcome confirmation wait timed out/,
    }[stage], 'ordinary actions retain their stage and call language in the timeout receipt');
    const ended = operation.snapshot(); operation.dispatch(); operation.confirm();
    assert.deepEqual(operation.snapshot(), ended, 'late mutation callbacks cannot change a returned receipt');
  }
});

test('legacy actions without dispatch reporting retain uncertainty after failure', async () => {
  let attempts = 0;
  defineTool({ name: '__legacy_action_evidence', description: 'Legacy action', timeout: 20,
    parameters: { type: 'object', properties: { ending: { type: 'string' } }, required: ['ending'] },
    behavior: { timeoutResult: { kind: 'action', pending: 'action outcome confirmation' } },
    execute: async ({ ending }) => {
      attempts++;
      if (ending === 'throw') throw Object.assign(new Error('Reply lost'), { code: 'REPLY_LOST' });
      return never();
    },
  });
  for (const ending of ['throw', 'timeout']) {
    const before = attempts;
    const result = await runtime.execute('__legacy_action_evidence', { ending }, undefined, context).catch(error => error);
    assert.equal(result.code, ending === 'throw' ? 'REPLY_LOST' : 'TOOL_TIMEOUT');
    assert.equal(result.details.status, 'unconfirmed'); assert.equal(result.details.executed, undefined);
    assert.equal(result.details.mayHaveTakenEffect, true); assert.equal(result.details.automaticReplay, false);
    assert.equal(attempts - before, 1);
  }
});

test('a legacy parent preserves its precise child failure identity and execution evidence', async () => {
  defineTool({ name: '__child_action_evidence', description: 'Precise child action', timeout: 1000,
    parameters: { type: 'object', properties: { tabRef: { type: 'string' }, stage: { type: 'string' },
      target: { type: 'string' }, action: { type: 'string' } }, required: ['tabRef'] }, page: 'owned',
    behavior: { reportsExecution: true, timeoutResult: { kind: 'action', pending: 'action outcome confirmation' } },
    execute: async ({ stage }, _signal, context) => {
      if (stage === 'unconfirmed') context.operation.dispatch();
      throw Object.assign(new Error('Child failed'), { code: 'CHILD_FAILED', details: { executed: false } });
    },
  });
  defineTool({ name: '__parent_action_evidence', description: 'Legacy parent action', timeout: 1000,
    parameters: { type: 'object', properties: { stage: { type: 'string' } } },
    behavior: { timeoutResult: { kind: 'action', pending: 'child action' } },
    execute: async ({ stage }, signal, context) => {
      assert.equal(context.operation.snapshot().status, 'unconfirmed');
      if (stage === 'missing') return runtime.execute('read_article', { tabRef: 'missing' }, signal,
        { ...context, operation: undefined });
      return runtime.execute('__child_action_evidence', { tabRef: 'checkout', stage, target: 'css:#save', action: 'click' }, signal,
        { ...context, operation: undefined });
    },
  });
  for (const stage of ['not_started', 'unconfirmed']) {
    reset();
    await assert.rejects(runtime.execute('__parent_action_evidence', { stage }, undefined,
      { ...context, requestedTabRef: 'parent-page' }), error => {
      assert.equal(error.code, 'CHILD_FAILED'); assert.equal(error.details.tool, '__child_action_evidence');
      assert.equal(error.details.tabRef, 'checkout'); assert.equal(error.details.target, 'css:#save');
      assert.equal(error.details.action, 'click'); assert.equal(error.details.status, stage);
      assert.equal(error.details.executed, stage === 'not_started' ? false : undefined);
      assert.equal(error.details.mayHaveTakenEffect, stage !== 'not_started');
      return true;
    });
  }
  await assert.rejects(runtime.execute('__parent_action_evidence', { stage: 'missing' }, undefined, context), error => {
    assert.equal(error.code, 'BATCH_TAB_REFERENCE_ERROR'); assert.equal(error.details.tabRef, 'missing');
    return true;
  });
});

defineTool({ name: '__partial_read', description: 'Synthetic staged read', parameters: { type: 'object', properties: { tabRef: { type: 'integer' } }, required: ['tabRef'] }, page: 'owned',
  timeout: 20, behavior: { timeoutResult: { kind: 'read', pending: 'read' } },
  execute: async (_args, _signal, ctx) => {
    ctx.reportPartial({ text: 'old content', trace: [{ level: 'info', message: 'Main frame read' }],
      pageState: { documentId: 'old', url: 'https://example.test/old' } }, 'child frames');
    return never();
  },
});
test('timeout rejects closed tabs and drops content from an obsolete document', async () => {
  reset();
  await assert.rejects(runtime.execute('__partial_read', { tabRef: 1 }, undefined, context), error => {
    assert.equal(error.code, 'TOOL_TIMEOUT');
    assert.equal(error.details.pending, 'current document content');
    assert.equal(error.details.pageState.url, 'https://example.test/old');
    assert.deepEqual(error.details.trace, [{ level: 'info', message: 'Main frame read' }]);
    assert.doesNotMatch(JSON.stringify(error), /old content|"(?:incomplete|documentId)":/);
    return true;
  });
  const run = runtime.execute('__partial_read', { tabRef: 1 }, undefined, context);
  await new Promise(resolve => setTimeout(resolve, 5)); tabs.delete(1);
  await assert.rejects(run, { code: 'SESSION_TAB_UNAVAILABLE' });
});

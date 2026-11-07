import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { compileScriptToolHost } from '../support/script-runtime-fixture.mjs';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker } from '../support/inner-runner-fixture.mjs';
import { safeValueForMessage, installSecurityGuards, formatScriptErrorTrace } from '../../src/shared/script-runtime.js';
import { getToolResultTraces } from '../../src/shared/contracts/tool-result-presentation.js';

const rules = [
  { action: 'block', type: 'domain', value: 'blocked.test' },
  { action: 'allow', type: 'pattern', value: 'https://blocked.test/allowed/*' },
];

test('script error traces retain the message across Chrome, Firefox and absent stacks', () => {
  const error = new TypeError('Return a JSON value.');
  error.stack = 'TypeError: Return a JSON value.\n    at run (script.js:1:2)';
  assert.equal(formatScriptErrorTrace(error), error.stack, 'Chrome keeps its existing header once');
  error.stack = 'run@script.js:1:2\n';
  assert.equal(formatScriptErrorTrace(error), 'TypeError: Return a JSON value.\nrun@script.js:1:2\n');
  error.stack = undefined;
  assert.equal(formatScriptErrorTrace(error), 'TypeError: Return a JSON value.');
});

async function fixture(mode) {
  const calls = [];
  const fetch = function(...args) { calls.push({ kind: 'fetch', receiver: this, args }); return Promise.resolve('fetched'); };
  class XMLHttpRequest { open(...args) { calls.push({ kind: 'xhr', receiver: this, args }); return 'opened'; } }
  const navigator = { sendBeacon(...args) { calls.push({ kind: 'beacon', receiver: this, args }); return true; } };
  const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, () => {}]));
  const context = createContext({ URL, TransformStream, TextEncoder, TextDecoder, fetch, XMLHttpRequest, navigator, console, setTimeout, clearTimeout,
    location: { href: 'https://blocked.test/current' },
    chrome: { storage: { local: { get: async () => ({ securityGuardrails: { rules } }) } },
      tabs: { get: async id => ({ id, url: 'https://blocked.test/current', status: 'complete' }) },
      scripting: { executeScript: async options => {
        if (!options.files) return [{ result: true }];
        calls.push({ kind: 'bridge', files: options.files }); return [];
      } } },
  });
  runInContext("globalThis.window = globalThis; globalThis.document = { [Symbol.toStringTag]: 'Document' };", context);
  runInContext(await compileScriptToolHost(mode), context);
  const definitions = new Map();
  let privateCode = '';
  const { createScriptTools, ToolExecutionError } = context.QZ_SCRIPT_TEST;
  const runtime = createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    skills: { loadScript: async () => privateCode }, scriptTimeoutProperty: { type: 'number' }, evaluateCdpScript: async (_tab, { expression }) => {
      return { result: { type: 'object', value: await runInContext(expression, context) } };
    },
  });
  const originals = { fetch, open: XMLHttpRequest.prototype.open, beacon: navigator.sendBeacon, console: { ...console } };
  return {
    context, calls, runtime, definitions,
    run: (code, options = {}, context = {}) => definitions.get('evaluate').execute({ code, tabId: 7, timeout: 5, ...options }, undefined, { sessionId: 'task', runId: 'run', toolExecutionId: 'parent-call', ...context }),
    outer: (code, options = {}, context = {}) => definitions.get('run_script').execute({ code, timeout: 5, ...options }, undefined, { sessionId: 'task', runId: 'run', toolExecutionId: 'parent-call', ...context }),
    privateRun: (code, options = {}, context = {}) => {
      privateCode = code;
      return definitions.get('run_skill_script').execute({ skill: 'fixture', script: 'scripts/run.js', target: 'page', tabId: 7, timeout: 5, ...options }, undefined, { sessionId: 'task', runId: 'run', toolExecutionId: 'parent-call', ...context });
    },
    restored() {
      assert.equal(context.fetch, originals.fetch);
      assert.equal(XMLHttpRequest.prototype.open, originals.open);
      assert.equal(navigator.sendBeacon, originals.beacon);
      for (const level of Object.keys(console)) assert.equal(console[level], originals.console[level]);
    },
  };
}

for (const mode of ['development', 'production']) {
  test(`${mode}: unavailable page and outer runtimes expose recovery errors`, async () => {
    const f = await fixture(mode);
    f.context.chrome.scripting.executeScript = async () => { throw new Error('bridge unavailable'); };
    const result = await f.privateRun('async () => tools.list_tools()', {}, { runId: 'opaque-unavailable-run', externalDrive: true });
    assert.equal(result.code, 'PAGE_CONTEXT_UNAVAILABLE');
    assert.equal(result.message, 'The page execution context became unavailable.');
    assert.ok(result.hint);
    assert.equal(result.details.mayHaveTakenEffect, true);
    assert.equal(result.details.automaticReplay, false);
    const unavailable = await f.outer('return 1;');
    assert.equal(unavailable.code, 'SCRIPT_CONTEXT_UNAVAILABLE');
    assert.match(unavailable.hint, /Reload/);
    assert.doesNotMatch(JSON.stringify(unavailable), /\binner\b|execution_world|engine/);
  });

  test(`${mode}: input-only scripts use the no-bridge path and missing tools never replay side effects`, async () => {
    const f = await fixture(mode);
    const result = await f.run('async value => value.value + value.extra', { args: { value: 4, extra: 8 } });
    assert.equal(result, 12);
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 0);
    runInContext('globalThis.attempts = 0; globalThis.missingTools = () => tools.$list();', f.context);
    const failed = await f.run('async () => { globalThis.attempts++; return globalThis.missingTools(); }');
    assert.equal(failed.code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    assert.equal(failed.details.automaticReplay, false);
    assert.equal(failed.details.mayHaveTakenEffect, true);
    assert.match(failed.hint, /qz SDK/);
    assert.equal(f.context.attempts, 1);
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 0);
    const shape = await f.run('async () => { globalThis.shapeAttempts = (globalThis.shapeAttempts || 0) + 1; throw new Error("Illegal return statement"); }');
    assert.equal(shape.code, 'SCRIPT_EVALUATION_FAILED'); assert.equal(f.context.shapeAttempts, 1, 'a runtime error is not a compile-time shape retry');
    const absent = await f.run('async () => typeof tools');
    assert.equal(absent, 'undefined');
    assert.equal(f.calls.filter(c => c.kind === 'bridge').length, 0);
    f.restored();
  });

  test(`${mode}: private Skill page messages retain the parent invocation identity`, async () => {
    const f = await fixture(mode);
    runInContext(`
      const listeners = new Set();
      window.addEventListener = (_type, listener) => listeners.add(listener);
      window.removeEventListener = (_type, listener) => listeners.delete(listener);
      window.postMessage = message => {
        globalThis.lastToolMessage = message;
        for (const listener of listeners) listener({ source: window, data: {
          source: 'qz-run-script-tool-response', id: message.id, response: { ok: true, result: 42 }
        } });
      };
    `, f.context);
    assert.equal((await f.privateRun('async () => await tools.read_article({})')).result, 42);
    assert.equal(f.context.lastToolMessage.parentCallId, 'parent-call');
    assert.equal(f.context.lastToolMessage.args.tabId, undefined, 'page scripts never choose a nested page implicitly');
    await f.privateRun('async () => await tools.read_article({})', {}, { runId: 'drive-native-identifier', externalDrive: false });
    assert.equal(f.context.lastToolMessage.args.tabId, undefined, 'native scripts require the same explicit page references');
    await f.privateRun('async () => await tools.read_article({tabRef:"other"})');
    assert.equal(f.context.lastToolMessage.args.tabRef, 'other');
    assert.equal(f.context.lastToolMessage.args.tabId, undefined, 'explicit references are never overwritten by the source page');
    for (const code of ['async () => await tools.read_article({tabRef:"other"})', 'async () => await tools.read_article({})']) {
      await f.privateRun(code, {}, { runId: 'opaque-tool-run', externalDrive: true });
      assert.equal(f.context.lastToolMessage.args.tabId, undefined, 'direct drive never injects an implicit page');
    }
    assert.equal((await f.privateRun('async () => await qz.tab("other").locator({role:"button",name:"Save"}).click()')).result, 42);
    assert.equal(f.context.lastToolMessage.toolName, 'act_on_element');
    assert.deepEqual(structuredClone(f.context.lastToolMessage.args.locator), { role: 'button', name: 'Save' });
    assert.equal(f.context.lastToolMessage.args.tabRef, 'other');
    assert.equal(f.context.lastToolMessage.parentCallId, 'parent-call');
    await f.privateRun('async () => await qz.tab("other").evaluate(value => value + 1, 4)');
    assert.equal(f.context.lastToolMessage.toolName, 'evaluate');
    assert.equal(typeof f.context.lastToolMessage.args.code, 'string');
    assert.equal(f.context.lastToolMessage.args.args, 4);
  });

  test(`${mode}: actual page evaluation returns raw JSON values without business-key rewriting`, async () => {
    const f = await fixture(mode);
    const value = await f.run(`payload => ({ payload, code: 'BUSINESS_CODE', message: 'data', ok: false,
      error: 'data', result: '{"key":1}', _plugin: { tabId: 'business' }, nodes: [{ selector: 'data' }] })`, { args: ['value', null, false] });
    assert.deepEqual(structuredClone(value), { payload: ['value', null, false], code: 'BUSINESS_CODE', message: 'data', ok: false,
      error: 'data', result: '{"key":1}', _plugin: { tabId: 'business' }, nodes: [{ selector: 'data' }] });
    for (const expression of ['() => document', '() => () => 42', '() => NaN', '() => 1n', '() => { const v = {}; v.self = v; return v; }']) {
      const invalid = await f.run(expression);
      assert.equal(invalid.code, 'SCRIPT_VALUE_NOT_SERIALIZABLE', expression);
      assert.match(invalid.message, /Pass or return JSON values/);
      assert.equal(invalid.hint, undefined);
    }
    for (const args of [null, false, 0, 'text', [1, { x: 2 }]]) {
      assert.deepEqual(structuredClone(await f.run('value => value', { args })), args);
    }
    assert.deepEqual(structuredClone(await f.run(`value => ({ value, input: typeof input, args: typeof args,
      plugin: typeof $plugin, tab: typeof tabId })`, { args: 7 })),
    { value: 7, input: 'undefined', args: 'undefined', plugin: 'undefined', tab: 'undefined' },
    'a supplied function closes over the page, without capturing host input bindings');
    assert.equal(await f.run('() => undefined'), undefined);
    f.restored();
  });

  test(`${mode}: no-page computations and tools use the same public script contract`, async () => {
    const f = await fixture(mode);
    const workerSource = await compileInnerWorker({ mode });
    const nested = [];
    let executions = 0;
    f.context.chrome.offscreen = { hasDocument: async () => true, createDocument: async () => {} };
    f.context.chrome.runtime = { getURL: path => `chrome-extension://test/${path}`, sendMessage: async message => {
      if (message.type === 'run_script_inner_ping') return { ok: true, ready: true };
      assert.equal(message.type, 'run_script_inner_execute');
      executions++;
      void runInnerWorker(workerSource, message.source, {
        scriptArgs: message.scriptArgs, strictResult: message.strictResult,
        onMessage(call, reply) {
          if (call.type === 'script_trace') {
            f.runtime.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_diagnostic', requestId: message.requestId, row: call.row });
            return;
          }
          if (call.type !== 'tool_call') return;
          nested.push({ name: call.toolName, args: call.args });
          reply({ type: 'tool_response', callId: call.callId, response: call.toolName === 'fail'
            ? { ok: false, code: 'TEST_FAILURE', message: 'Could not save.', hint: 'Choose another value.', details: { action: 'save' } }
            : { ok: true, result: { saved: call.args.value } } });
        },
      }).then(({ result }) => f.runtime.handleRunScriptInnerRuntimeMessage({ type: 'run_script_inner_result', requestId: message.requestId, result }));
      return { ok: true, accepted: true };
    } };
    const code = `async () => ({ dom: [typeof document, typeof window], saved: await tools.data_store({ value: input.value }) })`;
    const native = structuredClone(await f.outer(code, { args: { value: 8 } }));
    const drive = structuredClone(await f.outer(code, { args: { value: 8 } }, { externalDrive: true }));
    assert.deepEqual(native, { dom: ['undefined', 'undefined'], saved: { saved: 8 } });
    assert.deepEqual(drive, native);
    assert.deepEqual(nested, [{ name: 'data_store', args: { value: 8 } }, { name: 'data_store', args: { value: 8 } }]);
    assert.equal(f.calls.length, 0, 'no page is inspected or selected for orchestration');
    const empty = await f.outer('async () => { await Promise.resolve(); }', {});
    assert.equal(empty, undefined);
    const failed = await f.outer('async () => await tools.fail({})', {});
    assert.equal(failed.code, 'TEST_FAILURE');
    assert.match(failed.message, /Could not save/);
    assert.equal(failed.hint, 'Choose another value.');
    assert.equal(failed.details.action, 'save');
    assert.ok(failed.details.trace.some(row => row.level === 'error' && row.message.includes('Could not save.')));
    assert.deepEqual(Object.keys(failed).sort(), ['code', 'details', 'hint', 'message']);
    for (const kind of ['throw', 'tool']) {
      nested.length = 0;
      const presentation = {}, before = executions;
      const failure = await f.outer(`async () => {
        console.log('completed steps');
        await tools.data_store({value: 'done'});
        trace('next step');
        for (let step = 0; step < 6; step++) trace('checkpoint-' + step);
        ${kind === 'throw' ? 'throw new Error("ordinary failure");' : 'await tools.fail({});'}
      }`, {}, { resultPresentation: presentation });
      const traces = [...getToolResultTraces(failure, presentation)];
      assert.equal(failure.code, kind === 'throw' ? 'SCRIPT_EVALUATION_FAILED' : 'TEST_FAILURE');
      // Only explicit checkpoints and the execution error reach the trace.
      assert.deepEqual(traces.slice(0, 2), ['completed steps', 'next step']);
      assert.deepEqual(traces.slice(2, 8), Array.from({ length: 6 }, (_, index) => `checkpoint-${index}`));
      assert.equal(traces.length, 9, 'failure retains eight explicit checkpoints and one error');
      assert.ok(traces.every(row => typeof row === 'string'));
      assert.equal(Object.hasOwn(presentation._display.script, 'valueOnly'), false, 'failure metadata never marks a successful return');
      assert.equal(failure.details.trace.length, 5, 'the native error retains its bounded structured diagnostic tail');
      assert.ok(failure.details.trace.some(row => row.level === 'error'));
      if (kind === 'tool') {
        assert.match(traces.at(-1), /Could not save/);
      } else {
        assert.match(traces.at(-1), /ordinary failure/);
      }
      assert.equal(executions, before + 1, 'a failed script is never replayed');
      assert.deepEqual(nested.map(call => call.name), kind === 'throw' ? ['data_store'] : ['data_store', 'fail']);
    }
    const presentation = {};
    const business = await f.outer(`console.log('ready'); return {
      traces: ['business trace'], trace: ['authored'], _display: {script: {trace: ['authored metadata']}}
    };`, {}, { resultPresentation: presentation });
    assert.deepEqual(structuredClone(business), { traces: ['business trace'], trace: ['authored'], _display: { script: { trace: ['authored metadata'] } } });
    assert.deepEqual([...getToolResultTraces(business, presentation)], ['ready']);
    assert.deepEqual(getToolResultTraces(structuredClone(business)), [], 'untrusted same-named fields cannot forge execution traces');
    const schema = f.definitions.get('run_script').parameters;
    assert.equal(schema.required.includes('tabRef'), false);
    for (const key of ['tabRef', 'target', 'scope']) assert.equal(Object.hasOwn(schema.properties, key), false);
  });

  test(`${mode}: page guards block each request surface, honor allow patterns and restore originals`, async () => {
    const f = await fixture(mode);
    const blocked = [
      ['fetch', 'await fetch("https://blocked.test/private")'],
      ['fetch', 'await fetch(new URL("https://child.blocked.test/private"))'],
      ['fetch', 'await fetch({ url: "https://blocked.test/private" })'],
      ['fetch', 'await fetch("/private")'],
      ['XMLHttpRequest.open', 'new XMLHttpRequest().open("GET", "https://blocked.test/private", false)'],
      ['navigator.sendBeacon', 'navigator.sendBeacon("https://blocked.test/private", "body")'],
    ];
    for (const [source, call] of blocked) {
      const result = await f.run(`async () => { ${call}; return 'escaped'; }`);
      assert.equal(Object.hasOwn(result, 'ok'), false, call);
      assert.equal(result.code, 'SECURITY_GUARDRAIL_BLOCKED', call);
      assert.match(result.message, /安全护栏已阻止 run_script 访问 blocked\.test 及其子域名。/);
      assert.equal(result.details.action, source);
      assert.equal(f.calls.length, 0, 'blocked requests must not invoke the original transport');
      f.restored();
    }
    const result = await f.run(`async () => {
      const fetched = await fetch(new URL('https://blocked.test/allowed/fetch'), { method: 'POST' });
      const xhr = new XMLHttpRequest(); const opened = xhr.open('POST', 'https://blocked.test/allowed/xhr', false, 'user', 'pass');
      const beacon = navigator.sendBeacon('https://blocked.test/allowed/beacon', 'payload');
      await fetch('https://unrelated.test/free');
      return { fetched, opened, beacon };
    }`);
    assert.deepEqual(structuredClone(result), { fetched: 'fetched', opened: 'opened', beacon: true });
    assert.deepEqual(f.calls.map(call => call.kind), ['fetch', 'xhr', 'beacon', 'fetch']);
    assert.equal(f.calls[0].args[0].href, 'https://blocked.test/allowed/fetch');
    assert.equal(f.calls[0].args[1].method, 'POST');
    assert.deepEqual(f.calls[1].args, ['POST', 'https://blocked.test/allowed/xhr', false, 'user', 'pass']);
    assert.equal(f.calls[1].receiver instanceof f.context.XMLHttpRequest, true);
    assert.equal(f.calls[2].receiver, f.context.navigator);
    assert.deepEqual(f.calls[2].args, ['https://blocked.test/allowed/beacon', 'payload']);
    f.restored();
    assert.equal((await f.run(`async () => { throw new Error('application failure'); }`)).code, 'SCRIPT_EVALUATION_FAILED');
    f.restored();
  });
}


test('shared runtime preserves page and inner compatibility differences', async () => {
  const names = ['self', 'location', 'fetch', 'XMLHttpRequest', 'navigator'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [];
  const fetch = (...values) => { calls.push(['fetch', values]); return Promise.resolve('allowed'); };
  class XMLHttpRequest { open(...values) { calls.push(['xhr', values]); return 'opened'; } }
  const navigator = { sendBeacon: url => { calls.push(['beacon', url]); return true; } };
  let restore;
  try {
    for (const [name, value] of Object.entries({ self: globalThis, location: { href: 'https://blocked.test/' }, fetch, XMLHttpRequest, navigator })) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const bytes = new Uint8Array([1, 2, 3]);
    bytes.slice = () => new Uint8Array([9]);
    assert.deepEqual(safeValueForMessage(bytes, 'page').sample, [9], 'page retains the existing slice-based sampling contract');
    assert.deepEqual(safeValueForMessage(bytes, 'inner').sample, [1, 2, 3], 'inner reads typed indices independently of an overridden slice');
    const getter = { get denied() { throw { message: 'plain failure' }; } };
    for (const world of ['page', 'inner']) {
      assert.deepEqual(safeValueForMessage(getter, world), { denied: { __qz_uncloneable: 'property', error: 'plain failure' } });
      assert.deepEqual(safeValueForMessage(globalThis, world), { __qz_uncloneable: 'global' });
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalBeacon = navigator.sendBeacon;
    restore = installSecurityGuards({ rules });
    for (const request of [() => globalThis.fetch('/private'), () => new XMLHttpRequest().open('GET', '/private')]) {
      assert.throws(request, error => error.code === 'SECURITY_GUARDRAIL_BLOCKED' && /run_script 访问/.test(error.message));
    }
    assert.equal(calls.length, 0);
    assert.equal(navigator.sendBeacon, originalBeacon, 'inner has no page beacon hook');
    assert.equal(navigator.sendBeacon('https://blocked.test/private'), true);
    assert.equal(await globalThis.fetch('https://blocked.test/allowed/item'), 'allowed');
    assert.equal(new XMLHttpRequest().open('GET', 'https://unrelated.test/free'), 'opened');
    assert.deepEqual(calls[2][1], ['GET', 'https://unrelated.test/free', true, undefined, undefined], 'inner retains its explicit XHR defaults');
    restore();
    assert.equal(globalThis.fetch, fetch);
    assert.equal(XMLHttpRequest.prototype.open, originalOpen);
  } finally {
    restore?.();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

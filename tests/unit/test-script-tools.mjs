import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { compileScriptRuntime } from '../support/script-runtime-fixture.mjs';
import { createScriptTools } from '../../src/capabilities/script/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

const originalChrome = globalThis.chrome;
const originalRuntimeSource = globalThis.SCRIPT_RUNTIME_SOURCE;
before(async () => {
  globalThis.SCRIPT_RUNTIME_SOURCE = await compileScriptRuntime();
  globalThis.chrome = { storage: { local: { async get() { return {}; } } } };
});
after(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalRuntimeSource === undefined) delete globalThis.SCRIPT_RUNTIME_SOURCE;
  else globalThis.SCRIPT_RUNTIME_SOURCE = originalRuntimeSource;
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(evaluateCdpScript) {
  const definitions = new Map();
  createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    skills: { loadScript: async () => null }, scriptTimeoutProperty: { type: 'number' }, evaluateCdpScript });
  const run = definitions.get('run_script').execute;
  return (tabId = 7, signal, context = {}, args = {}) => run({ code: '42', timeout: 5, tabId, ...args }, signal, { sessionId: 'task', runId: 'run', ...context });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a deferred tab-local invocation cannot escalate to the tool bridge', async () => {
  let evaluations = 0;
  const run = fixture(async () => { evaluations++; return {}; });
  await assert.rejects(run(7, undefined, { deferToolCommit: true }, { code: 'tools.$list()' }), error => {
    assert.equal(error.code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    assert.equal(error.details.executed, false); assert.equal(error.details.automaticReplay, false);
    return true;
  });
  assert.equal(evaluations, 0);
});

test('page results preserve large structured values and diagnostic envelopes', async () => {
  const value = { text: 'large'.repeat(20000), rows: Array.from({ length: 1200 }, (_, id) => ({ id })) };
  assert.equal((await fixture(async () => ({ result: { type: 'object', value } }))()).result, value);
  const run = fixture(async () => ({ result: { type: 'object', value: { __runScriptEnvelope: true, ok: false,
    error: 'querySelector returned null', trace: [{ message: 'selected 0' }], __lastObservation: { _image: 'data:image/png;base64,eA==' } } } }));
  const result = await run();
  assert.equal(result.diagnostic.category, 'selector_or_timing');
  assert.deepEqual(result.diagnostic.lastTrace, ['trace: selected 0']);
  assert.equal(result._image, 'data:image/png;base64,eA==');
  assert.equal(result.__runScriptEnvelope, undefined);
});

test('compile-only return recovery retains input args without adding a bridge', async () => {
  let calls = 0;
  const run = fixture(async (_id, { expression }) => {
    if (++calls === 1) return { exceptionDetails: { text: 'SyntaxError: Illegal return statement' } };
    assert.match(expression, /const input = \{"value":12\}/);
    return { result: { type: 'number', value: 12 } };
  });
  const result = await run(7, undefined, {}, { code: 'return input.value', args: { value: 12 } });
  assert.equal(result.result, 12); assert.equal(calls, 2);
});

test('missing-tool errors from the debugger return guidance without retrying', async () => {
  for (const message of ['ReferenceError: tool is not defined', "ReferenceError: Can't find variable: tools"]) {
    let calls = 0;
    const run = fixture(async () => { calls++; throw new Error(message); });
    const result = await run();
    assert.equal(result.code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    assert.equal(result.details.automaticReplay, false); assert.equal(calls, 1);
    assert.match(result.diagnostic.suggestedNextStep, /tools\.name/);
  }
});

test('a missing-tool exception takes precedence over return-shape recovery', async () => {
  let calls = 0;
  const run = fixture(async () => { calls++; return { exceptionDetails: { text: 'ReferenceError: tools is not defined (Illegal return statement)' } }; });
  assert.equal((await run()).code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('native runtime exceptions are not mistaken for compile-only shape recovery', async () => {
  for (const exceptionDetails of [
    { text: 'Error: Illegal return statement' },
    { text: 'SyntaxError: Illegal return statement', stackTrace: { callFrames: [{ functionName: 'pageCallback' }] } },
    { text: 'SyntaxError: Illegal return statement\n    at pageCallback' },
  ]) {
    let calls = 0;
    const run = fixture(async () => { calls++; return { exceptionDetails }; });
    assert.equal((await run()).ok, false); assert.equal(calls, 1);
  }
});

test('same tab serializes, other tabs proceed, cancellation releases queued work', async () => {
  const first = deferred(); const calls = [];
  const run = fixture(async tabId => { calls.push(tabId); if (calls.length === 1) await first.promise; return { result: { type: 'number', value: tabId } }; });
  const a = run(); await tick();
  const controller = new AbortController();
  const b = run(7, controller.signal);
  const rejected = assert.rejects(b, { code: 'OPERATION_ABORTED' });
  const c = run(7); const independent = run(9);
  await tick(); assert.deepEqual(calls, [7, 9]);
  controller.abort(); await rejected;
  first.resolve(); await Promise.all([a, c, independent]);
  assert.deepEqual(calls, [7, 9, 7]);
  await run(); assert.deepEqual(calls, [7, 9, 7, 7]);
});

test('nested run bypasses its own page queue and propagates abort failure', async () => {
  const first = deferred(); let calls = 0;
  const run = fixture(async () => { if (++calls === 1) await first.promise; return { result: { type: 'number', value: calls } }; });
  const outer = run(); await tick();
  await run(7, undefined, { runScriptToolDepth: 1 });
  assert.equal(calls, 2); first.resolve(); await outer;
  const fail = fixture(async () => { throw new ToolExecutionError('OPERATION_ABORTED', 'stopped'); });
  await assert.rejects(fail(), { code: 'OPERATION_ABORTED' });
});

test('cancelling the last queued request does not release its still-running predecessor', async () => {
  const first = deferred(); const calls = [];
  const run = fixture(async tabId => { calls.push(tabId); if (calls.length === 1) await first.promise; return { result: { type: 'undefined' } }; });
  const a = run(); await tick();
  const controller = new AbortController(); const b = run(7, controller.signal);
  const rejected = assert.rejects(b, { code: 'OPERATION_ABORTED' });
  await tick(); controller.abort(); await rejected;
  const c = run(); await tick(); assert.deepEqual(calls, [7]);
  first.resolve(); await Promise.all([a, c]); assert.deepEqual(calls, [7, 7]);
});

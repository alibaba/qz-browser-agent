import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { compileScriptRuntime } from '../support/script-runtime-fixture.mjs';
import { createScriptTools } from '../../src/capabilities/script/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

const originalChrome = globalThis.chrome;
const originalRuntimeSource = globalThis.SCRIPT_RUNTIME_SOURCE;
before(async () => {
  globalThis.SCRIPT_RUNTIME_SOURCE = await compileScriptRuntime();
  globalThis.chrome = { tabs: { get: async () => ({ url: "https://example.test", status: "complete" }) }, scripting: { executeScript: async () => [{ result: true, documentId: "document" }] }, storage: { local: { async get() { return {}; } } } };
});
after(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalRuntimeSource === undefined) delete globalThis.SCRIPT_RUNTIME_SOURCE;
  else globalThis.SCRIPT_RUNTIME_SOURCE = originalRuntimeSource;
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(evaluateCdpScript, name = 'evaluate') {
  const definitions = new Map();
  createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    skills: { loadScript: async () => null }, scriptTimeoutProperty: { type: 'number' }, evaluateCdpScript });
  const definition = definitions.get(name);
  return async (tabId = 7, signal, context = {}, args = {}) => {
    const input = { code: '() => 42', timeout: 5, tabId, ...args };
    definition.validateArgs(input);
    return definition.execute(input, signal, { sessionId: 'task', runId: 'run', ...context });
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('default evaluate prepares the current document; commit mode observes it without waiting for parsing', async t => {
  let ready = false, probes = 0, executions = 0;
  t.mock.method(chrome.scripting, 'executeScript', async () => { probes++; return [{ result: ready }]; });
  const run = fixture(async () => { executions++; return { result: { type: 'number', value: 42 } }; });
  assert.equal(await run(7, undefined, {}, { waitUntil: 'commit' }), 42);
  assert.equal(probes, 0);
  const waiting = run();
  while (!probes) await tick();
  assert.equal(executions, 1);
  ready = true;
  assert.equal(await waiting, 42);
  assert.equal(executions, 2);
});

test('document replacement retries preparation only; cancellation never executes late user code', async t => {
  let probes = 0, executions = 0, ready = false;
  t.mock.method(chrome.scripting, 'executeScript', async () => {
    if (++probes === 1) throw new Error('Execution context was destroyed');
    return [{ result: ready }];
  });
  const run = fixture(async () => { executions++; return { result: { type: 'number', value: 42 } }; });
  const controller = new AbortController();
  const waiting = run(7, controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  while (probes < 2) await tick();
  controller.abort();
  await rejected;
  ready = true;
  assert.equal(await run(), 42);
  assert.equal(executions, 1, 'only the new call may execute');
});

test('page evaluation requires a function before any debugger operation', async () => {
  let evaluations = 0;
  const run = fixture(async () => { evaluations++; return {}; });
  for (const code of ['42', 'return input.value', 'tools.list_tools()']) {
    await assert.rejects(run(7, undefined, { deferToolCommit: true }, { code }), error => {
      assert.equal(error.code, 'INVALID_SCRIPT_FUNCTION');
      assert.match(error.message, /not a function expression/);
      assert.equal(error.hint, undefined);
      return true;
    });
  }
  assert.equal(evaluations, 0);
});

test('page results preserve large structured values and public error feedback', async () => {
  const value = { text: 'large'.repeat(20000), rows: Array.from({ length: 1200 }, (_, id) => ({ id })) };
  assert.equal(await fixture(async () => ({ result: { type: 'object', value } }))(), value);
  const run = fixture(async () => ({ result: { type: 'object', value: { __runScriptEnvelope: true, ok: false,
    error: 'querySelector returned null', trace: [{ message: 'selected 0' }], __lastObservation: { _image: 'data:image/png;base64,eA==' } } } }));
  const result = await run();
  assert.equal(result.code, 'SCRIPT_EVALUATION_FAILED');
  assert.equal(result.message, 'querySelector returned null');
  assert.equal(result.hint, undefined);
  assert.deepEqual(result.details.trace.map(row => [row.level, row.message]), [['trace', 'selected 0']]);
  for (const field of ['diagnostic', 'engine', 'execution_world', 'hasResult']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(result._image, 'data:image/png;base64,eA==');
  assert.equal(result.__runScriptEnvelope, undefined);
});

test('script failures preserve supplied recovery hints without inventing advice or replay', async () => {
  for (const code of ['UNKNOWN_TOOL', 'STALE_ELEMENT_UID', 'STALE_ELEMENT_UID_PAGE_CHANGED', 'TOOL_TIMEOUT']) {
    for (const extra of [{}, { hint: 'Inspect payment receipt; do not submit again.' },
      { details: { mayHaveTakenEffect: true, automaticReplay: false } }]) {
      let calls = 0;
      const run = fixture(async () => {
        calls++;
        return { result: { type: 'object', value: { __runScriptEnvelope: true, ok: false,
          code, error: 'opaque failure without English keywords', ...extra } } };
      });
      const result = await run();
      assert.equal(result.code, code);
      assert.equal(result.message, 'opaque failure without English keywords');
      assert.equal(calls, 1, 'reporting a failure never replays the operation');
      assert.equal(result.hint, extra.hint);
      assert.deepEqual(result.details, extra.details || undefined);
    }
  }
});

test('page evaluation and legacy page Skills preserve native permission failures without replay', async () => {
  for (const name of ['evaluate', 'run_skill_script']) {
    for (const code of ['BROWSER_PERMISSION_REQUIRED', 'BROWSER_PERMISSION_DENIED']) {
      let calls = 0;
      const failure = Object.assign(new ToolExecutionError(code, 'Page script permission is unavailable.'), {
        hint: 'Allow user scripts in the qz side panel, then retry.',
      });
      const run = fixture(async () => { calls++; throw failure; }, name);
      await assert.rejects(run(7, undefined, {}, { skill: 'example', script: 'scripts/example.js' }), error => {
        assert.equal(error, failure, 'the permission code and hint must survive the page-context error boundary');
        return true;
      });
      assert.equal(calls, 1, 'permission failure never replays page code');
    }
  }
});

test('a page syntax error never replays the function body', async () => {
  let calls = 0;
  const run = fixture(async () => { calls++; return { exceptionDetails: { text: 'SyntaxError: Illegal return statement' } }; });
  const result = await run(7, undefined, {}, { code: 'value => value', args: 12 });
  assert.equal(result.code, 'SCRIPT_EVALUATION_FAILED');
  assert.equal(calls, 1);
});

test('missing-tool errors from the debugger report unavailable access without retrying', async () => {
  for (const message of ['ReferenceError: tool is not defined', "ReferenceError: Can't find variable: tools"]) {
    let calls = 0;
    const run = fixture(async () => { calls++; throw new Error(message); });
    const result = await run();
    assert.equal(result.code, 'RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    assert.equal(result.details.automaticReplay, false); assert.equal(calls, 1);
    assert.match(result.hint, /qz SDK.*page\.evaluate/);
    assert.ok(result.hint.includes('run_script'));
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
    const result = await run();
    assert.equal(result.code, 'SCRIPT_EVALUATION_FAILED');
    assert.equal(result.message, exceptionDetails.text);
    assert.equal(result.hint, undefined);
    assert.equal(calls, 1);
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

test('page evaluation keeps its queue even when called from outer orchestration', async () => {
  const first = deferred(); let calls = 0;
  const run = fixture(async () => { if (++calls === 1) await first.promise; return { result: { type: 'number', value: calls } }; });
  const outer = run(); await tick();
  const nested = run(7, undefined, { runScriptToolDepth: 1 });
  await tick(); assert.equal(calls, 1);
  first.resolve(); await Promise.all([outer, nested]);
  assert.equal(calls, 2);
  const fail = fixture(async () => { throw new ToolExecutionError('OPERATION_ABORTED', 'stopped'); });
  await assert.rejects(fail(), { code: 'OPERATION_ABORTED' });
});

test('a trusted private Skill page parent can reenter its own evaluation queue', async () => {
  const first = deferred(); let calls = 0;
  const run = fixture(async () => { if (++calls === 1) await first.promise; return { result: { type: 'number', value: calls } }; });
  const parent = run(); await tick();
  assert.equal(await run(7, undefined, { runScriptToolDepth: 1, senderTabId: 7 }), 2);
  first.resolve(); await parent;
  assert.equal(calls, 2);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker } from '../support/inner-runner-fixture.mjs';
import { createRunScriptBridge } from '../../src/background/tools/run-script-bridge.js';
import { withToolCallLifecycle } from '../../src/background/tools/call-lifecycle.js';
import { markToolValue, toolError } from '../../src/shared/contracts/tool-error.js';

const worker = await compileInnerWorker({ mode: 'production' });
const receipt = result => ({ ok: true, result, trace: [{ level: 'trace', message: 'Skill diagnostic' }] });

/** Keep the real host/Worker boundary; only the tool implementations are controlled. */
async function execute(code, definitions, { strictResult = true } = {}) {
  const controller = new AbortController(), responses = [], events = [];
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => true, getAbortSignal: () => controller.signal },
    getRuntime: () => ({ status: 'running' }), canManageSessions: async () => false,
    buildRunProfile: async () => ({}), collectArtifacts: () => [],
    recordNestedTool: async event => { events.push(event); },
    toolRuntime: {
      getSchemas: () => [], getBatchTabPolicy: () => ({ kind: 'script' }),
      resolveDefinition: name => definitions[name],
      execute: async (name, args) => definitions[name].execute(args),
    },
  });
  const execution = await withToolCallLifecycle({ sessionId: 'values', runId: 'run', signal: controller.signal }, context =>
    runInnerWorker(worker, code, {
      strictResult,
      async onMessage(message, respond) {
        if (message.type !== 'tool_call') return;
        const response = await bridge.handleToolCall({
          sessionId: context.sessionId, runId: context.runId, parentCallId: context.toolExecutionId,
          toolName: message.toolName, args: message.args,
        });
        responses.push(response);
        respond({ type: 'tool_response', callId: message.callId, response });
      },
    }));
  return { ...execution, responses, events };
}

const values = [null, false, 0, 42, '', 'value', [1, 2], {
  ok: false, error: 'business error', code: 'BUSINESS', result: { result: 'keep this field' },
  trace: ['business trace'], resultFormat: 'receipt', _display: { script: { trace: ['authored'] } },
}];

for (const strictResult of [true, false]) {
  test(`${strictResult ? 'modern' : 'legacy'} caller reads Skill results through the real bridge and Worker`, async () => {
    const definitions = Object.fromEntries(['script_skill', 'legacy_skill'].map(name => [name, {
      model: { scriptResult: 'receipt' }, execute: ({ index }) => receipt(values[index]),
    }]));
    const { result, responses, events } = await execute(`
      return await Promise.all(['script_skill','legacy_skill'].map(name =>
        Promise.all(Array.from({length:${values.length}}, (_,index) => tools[name]({index})))));
    `, definitions, { strictResult });
    assert.equal(result.ok, true, JSON.stringify(result));
    const expected = strictResult ? values : values.map(receipt);
    assert.deepEqual(result.result, [expected, expected]);
    assert.ok(responses.every(response => response.resultFormat === 'receipt'));
    const completed = events.filter(event => event.phase === 'end');
    assert.equal(completed.length, values.length * 2);
    assert.ok(completed.every(event => event.result.ok === true && event.result.trace[0].message === 'Skill diagnostic'),
      'host card and model receipts retain their original value and diagnostics');
  });
}

test('ordinary business objects and caller fields cannot request receipt unwrapping', async () => {
  const business = values.at(-1);
  const { result, responses } = await execute(`return await tools.ordinary({resultFormat:'receipt'});`, {
    ordinary: { model: { scriptResult: 'value' }, execute: () => markToolValue(business) },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, business);
  assert.equal(responses[0].resultFormat, undefined);
});

test('modern callers receive undefined and unwrap a receipt-shaped business value exactly once', async () => {
  const business = { ok: true, result: { answer: 42 }, trace: ['authored'] };
  const { result } = await execute(`
    const empty = await tools.empty({});
    return {empty:typeof empty, business:await tools.wrapped({})};
  `, {
    empty: { model: { scriptResult: 'receipt' }, execute: () => receipt(undefined) },
    wrapped: { model: { scriptResult: 'receipt' }, execute: () => receipt(business) },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { empty: 'undefined', business });
});

for (const strictResult of [true, false]) {
  test(`${strictResult ? 'modern' : 'legacy'} callers still reject failed Skill calls with recovery fields`, async () => {
    const failure = toolError('ELEMENT_NOT_FOUND', 'No matching element.', {
      hint: 'Find the target again.', details: { tabRef: 'checkout', target: 'css:button' },
    });
    const definitions = {
      returned: { model: { scriptResult: 'receipt' }, execute: () => failure },
      thrown: { model: { scriptResult: 'receipt' }, execute: () => { throw Object.assign(new Error(failure.message), failure); } },
    };
    const { result, responses } = await execute(`
      return await Promise.all(['returned','thrown'].map(async name => {
        try { await tools[name]({}); return {unexpected:true}; }
        catch (error) { return {code:error.code,message:error.message,hint:error.hint,details:error.details}; }
      }));
    `, definitions, { strictResult });
    assert.equal(result.ok, true, JSON.stringify(result));
    for (const error of result.result) {
      assert.equal(error.code, failure.code);
      assert.equal(error.hint, failure.hint);
      assert.deepEqual(error.details, failure.details);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length, 'the bridge may localize a thrown error message');
    }
    assert.ok(responses.every(response => response.ok === false && response.resultFormat === undefined));
  });
}

test('returning an unwrapped Skill value keeps its attached image observation', async () => {
  const image = 'data:image/png;base64,aW1hZ2U=';
  const { result, responses } = await execute('return await tools.observed({});', {
    observed: {
      model: { scriptResult: 'receipt' }, behavior: { nestedObservation: true },
      execute: () => ({ ...receipt({ answer: 42 }), _image: image }),
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { answer: 42 });
  assert.equal(responses[0].resultFormat, 'receipt');
  assert.deepEqual(result.observations, [{ _image: image }]);
});

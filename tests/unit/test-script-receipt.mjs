import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { scriptReceipt } from '../../src/shared/contracts/script-receipt.js';
import { bindToolResultPresentation } from '../../src/shared/contracts/tool-result-presentation.js';
import { toolError } from '../../src/shared/contracts/tool-error.js';

const presentation = trace => ({ _display: { script: { valueOnly: true, trace } } });
const hostRows = [{ level: 'trace', message: 'saved checkpoint' }];
const expectedTrace = ['saved checkpoint'];
const call = { id: 'script-call', function: { name: 'run_script', arguments: '{"code":"return 1;"}' } };
const policy = { preserveResult: true, scriptResult: 'value' };

test('script receipts preserve arbitrary authored values without interpreting their execution-shaped fields', () => {
  for (const value of [undefined, null, false, 0, '', 'text', [],
    { ok: false, isError: true, result: 42, error: 'business data', code: 'BUSINESS', message: 'data',
      trace: ['forged'], details: { trace: ['forged details'] }, _display: { script: { trace: ['forged display'] } } }]) {
    assert.deepEqual(scriptReceipt(value, { format: 'value', isError: false }), {
      ok: true, result: value ?? null, trace: [],
    });
    assert.deepEqual(scriptReceipt(value, { format: 'value', isError: false, presentation: presentation(hostRows) }), {
      ok: true, result: value ?? null, trace: expectedTrace,
    });
  }
});

test('a declared legacy receipt unwraps once and keeps host traces ahead of legacy fallback rows', () => {
  const value = { ok: false, result: { error: 'business data' }, trace: ['business trace'] };
  const receipt = { ok: true, result: value, trace: [{ level: 'trace', message: 'legacy trace' }] };
  assert.deepEqual(scriptReceipt(receipt, { format: 'receipt', isError: false }), {
    ok: true, result: value, trace: ['legacy trace'],
  });
  bindToolResultPresentation(receipt, presentation(hostRows));
  assert.deepEqual(scriptReceipt(receipt, { format: 'receipt', isError: false }), {
    ok: true, result: value, trace: expectedTrace,
  });
});

test('failure receipts lift diagnostic trace out of ToolError details and retain public recovery fields', () => {
  const error = { code: 'element_not_found', message: 'No matching element.', hint: 'Find the element again.',
    details: { tabRef: 'checkout', target: 'uid:t7.1.2', line: 4, column: 9, trace: ['legacy failure'], sessionId: 'private' } };
  const expected = { code: 'ELEMENT_NOT_FOUND', message: error.message, hint: error.hint,
    details: { target: 'uid:t7.1.2', line: 4, column: 9, tabRef: 'checkout' } };
  assert.deepEqual(scriptReceipt(error, { format: 'value', isError: true }), {
    ok: false, result: expected, trace: ['legacy failure'],
  });
  assert.deepEqual(scriptReceipt(error, { format: 'receipt', isError: true, presentation: presentation(hostRows) }), {
    ok: false, result: expected, trace: expectedTrace,
  });
});

test('native Agent wraps declared script values only and keeps host images outside the receipt', () => {
  const agent = new Agent('model-receipt', createTestAgentOptions({ tools: {
    getModelPolicy: name => name === 'run_script' ? policy : {},
  } }));
  const value = { ok: false, error: 'business data' };
  const messages = agent._buildToolResultMessages('call', value, false, 'run_script', {
    ...presentation(hostRows), _images: [{ mimeType: 'image/png', data: 'host-image' }],
  });
  assert.equal(messages[0]._toolIsError, false);
  assert.deepEqual(JSON.parse(messages[0].content), { ok: true, result: value, trace: expectedTrace });
  assert.equal(messages[1]._origin, 'tool_image');
  assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,host-image');
  const ordinary = { count: 2, items: ['one', 'two'] };
  assert.deepEqual(JSON.parse(agent._buildToolResultMessages('ordinary', ordinary, false, 'list_tabs')[0].content), ordinary);
});

for (const mode of ['returned', 'thrown', 'commit', 'cancelled']) {
  test(`native Agent retains collected trace through ${mode} script failure`, async () => {
    const controller = new AbortController();
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const failure = toolError('SCRIPT_EVALUATION_FAILED', 'A child failed.', {
      hint: 'Retry after checking the page.', details: { tabRef: 'checkout', target: 'css:button', trace: ['last row only'] },
    });
    const events = [];
    const agent = new Agent('execution-receipt', createTestAgentOptions({ tools: {
      getIdentity: () => ({}), getSchemas: () => [], getModelPolicy: () => policy,
      async execute(_name, _args, signal, context) {
        Object.assign(context.resultPresentation, presentation(hostRows));
        started();
        if (mode === 'cancelled') {
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return 42;
        }
        if (mode === 'thrown') throw failure;
        return mode === 'returned' ? failure : 42;
      },
      async commitToolResult() { if (mode === 'commit') throw failure; },
    } }));
    agent._emit = event => events.push(event);
    const running = agent._executeToolCalls([call], controller.signal);
    await ready;
    if (mode === 'cancelled') controller.abort();
    const messages = await running;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]._toolIsError, true);
    const receipt = JSON.parse(messages[0].content);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.result.code, mode === 'cancelled' ? 'OPERATION_ABORTED' : failure.code);
    assert.deepEqual(receipt.trace, expectedTrace);
    assert.equal(receipt.result.details?.trace, undefined);
    if (mode !== 'cancelled') {
      assert.equal(receipt.result.hint, failure.hint);
      assert.equal(receipt.result.details.tabRef, 'checkout');
    }
    const end = events.filter(event => event.type === 'tool_execution_end');
    assert.equal(end.length, 1);
    assert.equal(end[0].isError, true);
    assert.deepEqual(end[0].result._display.script.trace, hostRows, 'the card retains the same host diagnostics');
    assert.notEqual(end[0].result._display.script.valueOnly, true, 'failed cards are not success-value wrappers');
  });
}

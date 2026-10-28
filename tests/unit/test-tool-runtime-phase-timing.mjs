import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolPhaseTiming } from '../../src/background/tools/phase-timing.js';
import { createCdpRuntime } from '../../src/background/tools/cdp-runtime.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';
import { clearTraceLog, getTraceLog } from '../../src/background/trace.js';

const summaries = async () => (await getTraceLog()).filter(line => line.includes(' tool_phase '));

test('CDP commands and child sessions aggregate into exactly one summary per tool call', async () => {
  await clearTraceLog();
  const runtime = createCdpRuntime({
    ToolExecutionError,
    debuggerApi: {
      onDetach: { addListener() {} }, async attach() {}, async detach() {},
      async sendCommand(_target, method) {
        if (method === 'Fail') throw new Error('command failed');
        return { result: { value: 'unchanged' } };
      },
    },
    isRunCurrent: () => true, async assertTabAllowed() {}, async authorizeRunTab() {},
  });
  await Promise.all([1, 2].map(async tabId => {
    const context = { sessionId: 'timing', runId: 'run', toolCallId: `call-${tabId}` };
    const timing = createToolPhaseTiming('get_ax_tree', context);
    context.measurePhase = timing.start;
    for (let index = 0; index < 30; index++) {
      assert.deepEqual(await runtime.sendCdp(tabId, 'DOM.describeNode', {}, context), { result: { value: 'unchanged' } });
    }
    await runtime.withDebugger(tabId, async (_target, send) => {
      await send('Page.getFrameTree');
      await send.inSession('child')('Accessibility.getFullAXTree');
      await assert.rejects(send('Fail'), /command failed/);
    }, context);
    await runtime.evaluateCdpScript(tabId, {}, undefined, context);
    assert.ok((await summaries()).every(line => !line.includes(`call=call-${tabId} `)), 'commands never emit phase rows');
    timing.finish();
  }));
  const rows = await summaries();
  assert.equal(rows.length, 2);
  for (const id of [1, 2]) {
    const row = rows.find(line => line.includes(`call=call-${id} `));
    assert.match(row, /cdpCount=34 cdpMs=\d+/);
    assert.match(row, /injectionCount=0 injectionMs=0 extractionCount=0 extractionMs=0/);
    assert.doesNotMatch(row, /method=/);
  }
});

test('script cancellation includes its termination command in the same call summary', async () => {
  await clearTraceLog();
  let entered;
  const evaluating = new Promise(resolve => { entered = resolve; });
  const runtime = createCdpRuntime({
    ToolExecutionError,
    debuggerApi: {
      onDetach: { addListener() {} }, async attach() {}, async detach() {},
      async sendCommand(_target, method) {
        if (method === 'Runtime.evaluate') { entered(); return new Promise(() => {}); }
        assert.equal(method, 'Runtime.terminateExecution');
        return {};
      },
    },
    isRunCurrent: () => true, async assertTabAllowed() {}, async authorizeRunTab() {},
  });
  const context = { sessionId: 'timing', runId: 'run', toolCallId: 'cancelled-script' };
  const timing = createToolPhaseTiming('run_script', context), controller = new AbortController();
  context.measurePhase = timing.start;
  const run = runtime.evaluateCdpScript(1, {}, controller.signal, context);
  await evaluating; controller.abort();
  await assert.rejects(run, { code: 'OPERATION_ABORTED' });
  assert.deepEqual(await summaries(), []);
  timing.finish();
  const rows = await summaries();
  assert.equal(rows.length, 1);
  assert.match(rows[0], /call=cancelled-script .*cdpCount=2 cdpMs=\d+/);
});

test('settlement includes active phases once and ignores late completion or new measurements', async () => {
  await clearTraceLog();
  const timing = createToolPhaseTiming('read_article', { toolCallId: 'stopped' });
  const injection = timing.start('injection'); injection(); injection();
  const extraction = timing.start('extraction');
  const measurement = timing.start('measurement'); measurement();
  timing.start('normalization')(); timing.start('postprocess')();
  timing.finish();
  const rows = await summaries();
  assert.equal(rows.length, 1);
  for (const phase of ['injection', 'extraction', 'measurement', 'normalization', 'postprocess']) {
    assert.match(rows[0], new RegExp(`${phase}Count=1 ${phase}Ms=\\d+`));
  }
  extraction(); timing.start('cdp')(); timing.finish();
  assert.deepEqual(await summaries(), rows);
});

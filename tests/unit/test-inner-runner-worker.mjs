import assert from 'node:assert/strict';
import test from 'node:test';
import { build, } from 'esbuild';
import { minify } from 'terser';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker, sandboxFixture } from '../support/inner-runner-fixture.mjs';

for (const mode of ['development', 'production']) test(`${mode} Worker executes messages, tool results and cancellable fetch after compilation`, async () => {
  const source = await compileInnerWorker({ mode });
  const { result, events } = await runInnerWorker(source, `
    trace('Hello 轻舟 ✅');
    const response = await tools.lookup({ query: input.query });
    const fetched = await fetch('https://fixture.test/data', { headers: { Date: 'Fri, 17 Jul 2026 02:00:00 GMT', Authorization: 'signed' } });
    const controller = new AbortController();
    const cancellation = fetch('https://fixture.test/cancel', { signal: controller.signal }).catch(error => error.name);
    await tools.abortReady();
    controller.abort();
    return { response, body: await fetched.text(), cancelled: await cancellation, typed: new Uint8Array([1,2,3]), config: $plugin.value };
  `, {
    scriptArgs: { query: 'needle', $plugin: { value: 7 } }, fetchBridge: true,
    onMessage(message, respond) {
      if (message.type === 'tool_call') {
        if (message.toolName === 'lookup') {
          assert.equal(message.args.query, 'needle');
        }
        respond({ type: 'tool_response', callId: message.callId, response: { ok: true, result: 'found', artifacts: [{ id: 'artifact' }] } });
      } else if (message.type === 'fetch_call' && message.request.url.endsWith('/data')) {
        assert.ok(message.request.headers.some(([name, value]) => name === 'date' && value.startsWith('Fri,')));
        respond({ type: 'fetch_response', callId: message.callId, response: { ok: true, result: { status: 200, bodyBase64: Buffer.from('数据').toString('base64') } } });
      }
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, { response: 'found', body: '数据', cancelled: 'AbortError', typed: { __qz_type: 'Uint8Array', length: 3, sample: [1,2,3] }, config: 7 });
  assert.equal(result.artifacts[0].id, 'artifact');
  assert.deepEqual(result.trace.map(row => row.message), ['Hello 轻舟 ✅']);
  const cancelled = events.find(message => message.type === 'fetch_call' && message.request.url.endsWith('/cancel'));
  assert.equal(events.find(message => message.type === 'fetch_cancel').callId, cancelled.callId);
});

test('compiled Worker preserves errors, guards, syntax diagnostics and undefined results', async () => {
  const source = await compileInnerWorker({ mode: 'production' });
  const failed = await runInnerWorker(source, 'await tools.fail();', { onMessage(message, respond) {
    respond({ type: 'tool_response', callId: message.callId, response: { ok: false, code: 'TOOL_TEST_FAILURE', error: 'failed', details: { retry: false } } });
  } });
  assert.equal(failed.result.code, 'TOOL_TEST_FAILURE');
  assert.deepEqual(failed.result.details, { retry: false });
  assert.equal(failed.result.trace.length, 1);
  assert.equal(failed.result.trace[0].level, 'error');
  assert.match(failed.result.trace[0].message, /failed/);
  const blocked = await runInnerWorker(source, 'await fetch("https://blocked.test/path");', { fetchBridge: true, securityGuardrails: { rules: [{ action: 'block', type: 'domain', value: 'blocked.test' }] } });
  assert.equal(blocked.result.code, 'SECURITY_GUARDRAIL_BLOCKED');
  assert.equal(blocked.events.some(message => message.type === 'fetch_call'), false);
  const syntax = await runInnerWorker(source, 'return "raw\nnewline";');
  assert.equal(syntax.result.code, 'SCRIPT_SYNTAX_ERROR');
  assert.ok(syntax.result.details.suspiciousTokens.some(hint => hint.name === 'raw_newline_in_string'));
  assert.equal(syntax.result.details.sourcePreview.includes('\n'), false);
  const empty = await runInnerWorker(source, 'await Promise.resolve();');
  assert.equal(empty.result.ok, true);
  assert.equal(empty.result.hasResult, false);
  assert.deepEqual(empty.result.trace, []);
});

for (const mode of ['development', 'production']) test(`${mode} public outer scripts serialize page functions and preserve arbitrary JSON arguments`, async () => {
  const source = await compileInnerWorker({ mode });
  const calls = [];
  const { result } = await runInnerWorker(source, `
    const values = await Promise.all([null, false, 0, 'text', [1, { x: 2 }]].map(args => tools.evaluate({
      tabRef: 'page', code: value => ({ value, code: 'DATA', message: 'text', ok: false }), args,
    })));
    await tools.wait_for_function({ tabRef: 'page', code: value => value === 7, args: 7 });
    await tools.wait_for_navigation({ tabRef: 'page', trigger: { name: 'evaluate', args: {
      tabRef: 'page', code: url => location.assign(url), args: 'https://fixture.test/next',
    } } });
    return values;
  `, { strictResult: true, onMessage(message, respond) {
    if (message.type !== 'tool_call') return;
    calls.push(message);
    if (message.toolName === 'wait_for_navigation') {
      assert.equal(message.args.trigger.name, 'evaluate');
      assert.equal(message.args.trigger.args.tabRef, 'page');
      assert.equal(message.args.trigger.args.args, 'https://fixture.test/next');
      assert.equal(typeof message.args.trigger.args.code, 'string', 'the posted trigger serializes its declared page function');
      assert.match(message.args.trigger.args.code, /location\.assign\(url\)/);
      respond({ type: 'tool_response', callId: message.callId, response: { ok: true, result: { navigated: true } } });
      return;
    }
    assert.equal(typeof message.args.code, 'string');
    const fn = Function(`return (${message.args.code})`)();
    respond({ type: 'tool_response', callId: message.callId,
      response: { ok: true, result: fn(message.args.args) } });
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, [null, false, 0, 'text', [1, { x: 2 }]].map(value => ({ value, code: 'DATA', message: 'text', ok: false })));
  assert.equal(calls.length, 7);
  assert.deepEqual(result.trace, [], 'successful concurrent and sequential tool calls add no trace');
  assert.ok(calls.every(call => call.args.tabRef === 'page'));
  for (const script of [
    'return await tools.lookup({ transform: value => value });',
    "return await tools.wait_for_navigation({ tabRef: 'page', trigger: { name: 'lookup', args: { code: () => 42 } } });",
  ]) {
    const rejected = await runInnerWorker(source, script, { strictResult: true });
    assert.equal(rejected.result.code, 'SCRIPT_VALUE_NOT_SERIALIZABLE');
    assert.equal(rejected.events.some(event => event.type === 'tool_call'), false, 'ordinary business arguments never serialize functions');
  }
  for (const script of ['return NaN;', 'return () => 42;', 'const v = {}; v.self = v; return v;']) {
    const invalid = await runInnerWorker(source, script, { strictResult: true });
    assert.equal(invalid.result.code, 'SCRIPT_VALUE_NOT_SERIALIZABLE');
  }
});

for (const mode of ['development', 'production']) test(`${mode} Worker returns only explicitly selected host image observations`, async () => {
  const source = await compileInnerWorker({ mode });
  const image = key => ({ _image: `data:image/png;base64,${Buffer.from(key).toString('base64')}`, _imageDetail: 'high' });
  const run = script => runInnerWorker(source, script, { strictResult: true, onMessage(message, respond) {
    if (message.type === 'script_trace') return;
    assert.equal(message.type, 'tool_call');
    assert.ok(['screenshot', 'read_image'].includes(message.toolName));
    respond({ type: 'tool_response', callId: message.callId, response: {
      ok: true, result: { width: 2, height: 1 }, observation: image(message.args.key),
    } });
  } });

  const ignored = await run(`await tools.screenshot({ tabRef: 'page', key: 'ignored' }); return 42;`);
  assert.equal(ignored.result.ok, true);
  assert.equal(ignored.result.result, 42);
  assert.deepEqual(ignored.result.observations ?? [], [], 'calling a screenshot does not automatically return its image');

  const selected = await run(`
    const screenshot = await tools.screenshot({ tabRef: 'page', key: 'selected screenshot' });
    const image = await tools.read_image({ key: 'selected image' });
    await tools.screenshot({ tabRef: 'page', key: 'ignored last screenshot' });
    return { nested: { evidence: [screenshot, image] }, repeated: screenshot };
  `);
  assert.equal(selected.result.ok, true);
  assert.deepEqual(selected.result.result, { nested: { evidence: [{ width: 2, height: 1 }, { width: 2, height: 1 }] },
    repeated: { width: 2, height: 1 } }, 'images travel beside the exact returned business value');
  assert.deepEqual(selected.result.observations, [image('selected screenshot'), image('selected image')],
    'nested original result identities select their host observations once, regardless of identical result fields or later calls');

  const copied = await run(`const screenshot = await tools.screenshot({ tabRef: 'page', key: 'copied' }); return { ...screenshot };`);
  assert.equal(copied.result.ok, true);
  assert.deepEqual(copied.result.result, { width: 2, height: 1 });
  assert.deepEqual(copied.result.observations ?? [], [], 'copying business fields does not copy host image authority');

  const authoredValue = { _image: image('authored')._image, nested: { _image: image('nested authored')._image } };
  const authored = await run(`return ${JSON.stringify(authoredValue)};`);
  assert.equal(authored.result.ok, true);
  assert.deepEqual(authored.result.result, authoredValue);
  assert.deepEqual(authored.result.observations ?? [], [], 'authored image-shaped fields remain ordinary business data');
  assert.equal(authored.events.some(event => event.type === 'tool_call'), false);
});

test('minified sandbox ignores foreign, cancelled and replaced Worker events', async () => {
  const workerSource = await compileInnerWorker({ mode: 'production' });
  const host = await build({ entryPoints: ['src/runner-sandbox.ts'], bundle: true, write: false, format: 'iife', define: { INNER_WORKER_SOURCE: JSON.stringify(workerSource) } });
  const minified = await minify(host.outputFiles[0].text, { ecma: 2020, compress: { passes: 2 }, mangle: true, format: { comments: false } });
  const fixture = sandboxFixture(minified.code);
  fixture.send({ type: 'execute', requestId: 'foreign' }, {});
  assert.equal(fixture.workers.length, 0);
  fixture.send({ type: 'execute', requestId: 'same', scriptSource: 'return 42;' });
  const old = fixture.workers[0];
  fixture.send({ type: 'execute', requestId: 'same', scriptSource: 'return 43;' });
  const active = fixture.workers[1];
  assert.equal(old.terminated, true);
  const before = fixture.messages.length;
  old.onmessage({ data: { type: 'result', result: { ok: true } } });
  old.onerror({ message: 'late' });
  assert.equal(fixture.messages.length, before);
  fixture.send({ type: 'tool_response', requestId: 'same', callId: 'call', response: { ok: true } });
  assert.equal(active.sent.at(-1).callId, 'call');
  const { result } = await runInnerWorker(active.source, active.sent[0].source);
  assert.equal(result.result, 43);
  fixture.send({ type: 'cancel', requestId: 'same' });
  active.onmessage({ data: { type: 'result', result } });
  assert.equal(fixture.messages.some(message => message.type === 'result'), false);
  assert.equal(active.terminated, true);
});

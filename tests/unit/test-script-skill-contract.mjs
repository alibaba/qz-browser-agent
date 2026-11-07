import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptExecutionFixture } from '../support/script-execution-fixture.mjs';
import { getActiveSkillToolSchemasSync } from '../../src/background/skills/skill-tool-runtime.js';
import { getToolResultTraces, presentToolResult, traceMessages } from '../../src/shared/contracts/tool-result-presentation.js';
import { isToolValue } from '../../src/shared/contracts/tool-error.js';
import { planTabBatch } from '../../src/background/tools/tab-batch.js';
import { skillResultData } from '../../src/sidepanel/tools/primitives/skill-result-data.js';
import { createToolRuntimeDetails } from '../../src/sidepanel/tools/tool-runtime-details.js';
import { buildScriptRequest, presentScriptResult } from '../../services/mcp-bridge/src/script-call.mjs';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
import { scriptReceipt } from '../../src/shared/contracts/script-receipt.js';

const skill = (code, runtime = 'script') => ({ format: 'qingzhou.skill', schemaVersion: 2, name: 'script-contract', scope: 'resident', content: 'Contract fixture', resources: [
  { path: 'plugin.json', type: 'json', content: JSON.stringify({ format: 'qingzhou.plugin', schemaVersion: 1, id: 'script-contract', name: 'Script contract', settings: { fields: [{ key: 'token', type: 'secret', label: 'Token' }] }, tools: [
    { name: 'run', description: 'Run fixture', runtime, script: 'run.js', behavior: { orchestration: true },
      parameters: { type: 'object', properties: { tabRef: { type: 'string' }, tabAlias: { type: 'string' }, target: { type: 'string' }, value: {} } } },
  ] }) },
  { path: 'run.js', type: 'script', content: code },
] });
const name = () => getActiveSkillToolSchemasSync()[0].function.name;

test('Skill receipts and internal inline values produce the same CLI and Agent receipt', async () => {
  for (const value of [null, false, 42, 'text', '{"json":"string"}', [1, { ok: false }], { ok: true, result: { nested: true } },
    { ok: false, error: 'data', code: 'BUSINESS', message: 'authored', _display: { script: { trace: ['authored'] } } }]) {
    const code = 'trace("contract"); return args.value;';
    const f = await scriptExecutionFixture([skill(code)]);
    const presentation = {};
    const result = await f.execute(name(), { value }, { resultPresentation: presentation });
    const inlinePresentation = {};
    const inline = await f.execute('run_script', { code, args: { value } }, { resultPresentation: inlinePresentation });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, value);
    assert.deepEqual(result.trace.map(row => row.message), ['contract']);
    assert.deepEqual(inline, value);
    assert.deepEqual(getToolResultTraces(result, presentation), ['contract']);
    assert.equal(presentation._plugin.id, 'script-contract', 'scalar/array results keep sidebar presentation separately');
    assert.deepEqual(presentToolResult(result, presentation).result, value);
    const stored = JSON.parse(JSON.stringify(presentToolResult(result, presentation)));
    const view = createToolRuntimeDetails({ genericRenderer: {} }).project({ name: name(), result: stored, hasResult: true, isError: false });
    assert.equal(view.state, 'completed');
    assert.deepEqual(skillResultData(view.result, view.originalResult), value, 'renderer paths stay relative to authored business data after reload');
    assert.equal(presentation._display.script.valueOnly, undefined, 'a receipt must not gain a second UI envelope');
    const request = buildScriptRequest({ sessionId: 's', code, args: { value } });
    assert.equal(request.args.timeout, 120);
    const agent = new Agent('receipt-test', createTestAgentOptions({ tools: f.runtime }));
    const native = JSON.parse(agent._buildToolResultMessages('inline', inline, false, 'run_script', inlinePresentation)[0].content);
    const skillMessage = JSON.parse(agent._buildToolResultMessages('skill', result, false, name(), presentation)[0].content);
    assert.deepEqual(native, { ok: true, result: value, trace: ['contract'] });
    assert.deepEqual(skillMessage, native, 'installed Skill and inline script have one model-facing receipt');
    assert.deepEqual(JSON.parse(agent._buildToolResultMessages('page', inline, false, 'evaluate', inlinePresentation)[0].content), native,
      'a page script called directly by the model uses the same boundary');
    const cli = presentScriptResult({ scriptApiVersion: 2, isError: false,
      result: scriptReceipt(inline, { format: 'value', isError: false, presentation: inlinePresentation }) });
    assert.equal(cli.exitCode, 0);
    assert.deepEqual(JSON.parse(cli.text), native, 'CLI and native Agent expose the same script receipt');
  }
  for (const code of ['throw new Error("boom");', 'return new Map([["key", 1]]);', 'const a = {}; a.self = a; return a;']) {
    const f = await scriptExecutionFixture([skill(code)]);
    const actual = await f.execute(name(), {});
    const expected = await f.execute('run_script', { code });
    assert.equal(actual.code, expected.code);
    assert.equal(actual.message, expected.message);
    assert.equal(actual.hint, expected.hint);
    assert.equal(isToolValue(actual), false);
    assert.ok(actual.code);
    assert.ok(Object.keys(actual).every(key => ['code', 'message', 'hint', 'details'].includes(key)));
  }
});

test('a script Skill owns its argument schema; page-looking fields stay data until a child uses them', async () => {
  const f = await scriptExecutionFixture([skill('return {tabRef:args.tabRef, tabAlias:args.tabAlias, target:args.target};')]);
  const args = { tabRef: 'not-created-yet', tabAlias: 'business value', target: 'uid:not-a-page-element' };
  assert.deepEqual((await f.execute(name(), args)).result, args);
  const definition = f.runtime.resolveDefinition(name());
  assert.equal(definition.model.preserveResult, true);
  assert.equal(definition.timeout({}, name()), 120_000);
  assert.equal(definition.timeout({ timeout: 0 }, name()), 0);
  assert.ok(!definition.parameters.required.includes('timeout'));
  assert.deepEqual(f.runtime.getBatchTabPolicy(name(), args), { kind: 'script' });
  const batch = [1, 2].map(id => ({ id, args }));
  const plan = planTabBatch(batch, item => ({ args: item.args, policy: f.runtime.getBatchTabPolicy(name(), item.args) }));
  assert.ok(batch.every(item => plan.independent(item) && plan.args(item) === args));
  assert.notEqual(plan.lane(batch[0]), plan.lane(batch[1]));
  assert.deepEqual(plan.dependencies(batch[1]), { execution: [], commit: [] });
  assert.equal(f.messages[0].strictResult, true);
  assert.equal(f.messages[0].fetchBridge, true);
  assert.equal(f.settings[0].includeSecrets, true);
  assert.equal(f.networks[0].config.token, 'fixture-secret');
});

test('old inner Skill keeps its required timeout, result envelope and permissive serialization', async () => {
  const f = await scriptExecutionFixture([skill('return new Map([["key", 1]]);', 'inner')]);
  assert.ok(f.runtime.resolveDefinition(name()).parameters.required.includes('timeout'));
  assert.notEqual(f.runtime.getBatchTabPolicy(name(), {})?.kind, 'script', 'manifest behavior cannot grant orchestration');
  await assert.rejects(f.execute(name(), {}), { code: 'MISSING_REQUIRED_ARGUMENTS' });
  const result = await f.execute(name(), { timeout: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.result.__qz_type, 'Map');
  assert.notEqual(f.messages[0].strictResult, true);
});

test('internal Promise.all retains input result order when child tools complete in reverse order', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const f = await scriptExecutionFixture([], async call => {
    if (call.args.tabRef === 'slow') await slow;
    else release();
    return call.args.tabRef;
  });
  const presentation = {};
  const value = await f.execute('run_script', { code: `return await Promise.all(['slow','fast'].map(tabRef => tools.evaluate({tabRef, code:() => 1})));` },
    { resultPresentation: presentation });
  assert.deepEqual(value, ['slow', 'fast']);
  assert.deepEqual(getToolResultTraces(value, presentation), [], 'concurrent successes stay silent without explicit diagnostics');
  assert.deepEqual(traceMessages([{ level: 'error', message: 'evaluate boom' }, 'old trace']), ['evaluate boom', 'old trace']);
});

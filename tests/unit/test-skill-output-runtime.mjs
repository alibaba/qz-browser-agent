import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptExecutionFixture } from '../support/script-execution-fixture.mjs';
import { getToolResultTraces } from '../../src/shared/contracts/tool-result-presentation.js';
import { scriptReceipt } from '../../src/shared/contracts/script-receipt.js';

const name = 'output_contract__read';
const outputSchema = {
  type: 'object',
  properties: { title: { type: ['string', 'null'] }, body: { type: 'string', minLength: 1 } },
  required: ['title', 'body'], additionalProperties: false,
  examples: [{ title: null, body: 'A note without a title.' }],
};
function skill(code, schema = outputSchema, runtime = 'script') {
  return { format: 'qingzhou.skill', schemaVersion: 2, name: 'output-contract', scope: 'resident',
    content: 'Read notes.', resources: [
      { path: 'plugin.json', type: 'json', content: JSON.stringify({ format: 'qingzhou.plugin', schemaVersion: 1,
        id: 'output-contract', tools: [{ name: 'read', runtime, script: 'read.js', outputSchema: schema,
          parameters: { type: 'object', properties: { value: {} } } }],
      }) },
      { path: 'read.js', type: 'script', content: code },
    ] };
}

test('named discovery exposes the declared output contract without sending extra provider fields', async () => {
  const f = await scriptExecutionFixture([skill('return args.value;')]);
  const full = await f.execute('list_tools', { names: [name] });
  assert.deepEqual(full.tools[0].outputSchema, outputSchema);
  const compact = await f.execute('list_tools', {});
  assert.equal(compact.tools.find(tool => tool.name === name).outputSchema, undefined);
  assert.equal(f.runtime.getSchemas().find(tool => tool.function.name === name).function.outputSchema, undefined,
    'provider function declarations only contain supported input-schema fields');
});

test('loading a Skill returns its complete callable contracts before activation, for native and drive callers', async () => {
  const installed = { ...skill('return args.value;'), scope: 'global' };
  const other = { ...skill('return args.value;'), name: 'unrelated' };
  other.resources = other.resources.map(resource => resource.path === 'plugin.json'
    ? { ...resource, content: resource.content.replace('"id":"output-contract"', '"id":"unrelated"') } : resource);
  const f = await scriptExecutionFixture([installed, other,
    { name: 'instructions-only', content: 'Read the current page.', scope: 'global' }]);
  for (const externalDrive of [false, true]) {
    const context = { externalDrive, loadedPluginSkillNames: [] };
    const before = await f.execute('list_tools', {}, context);
    assert.ok(!before.tools.some(tool => tool.name === name));
    const loaded = await f.execute('load_skill', { name: installed.name }, context);
    assert.equal(loaded.content, installed.content, 'existing Skill prose is preserved');
    assert.deepEqual(loaded.tools.map(tool => tool.name), [name], 'only this Skill’s registered tools');
    assert.deepEqual(loaded.tools[0].outputSchema, outputSchema);
    assert.ok(loaded.tools[0].parameters.properties.value);
    assert.equal(typeof loaded.tools[0].description, 'string');
    assert.deepEqual(context.loadedPluginSkillNames, [], 'discovery does not mutate Session activation');
    const activated = { ...context, loadedPluginSkillNames: [loaded.name] };
    assert.deepEqual(loaded.tools, (await f.execute('list_tools', { names: [name] }, activated)).tools);
    const value = { title: null, body: 'Read using the returned calling name.' };
    assert.deepEqual((await f.execute(loaded.tools[0].name, { value }, activated)).result, value);
    for (const disabled of [[name], ['run_script']]) {
      const restricted = await f.execute('load_skill', { name: installed.name },
        { ...context, profile: { tools: { disabled } } });
      assert.deepEqual(restricted.tools, [], 'load respects the same tool permissions as discovery');
    }
    assert.deepEqual((await f.execute('load_skill', { name: 'instructions-only' }, context)).tools, []);
  }
});

test('Skill output validation checks business data, retaining receipts and explicit traces', async () => {
  for (const runtime of ['script', 'inner']) {
    const f = await scriptExecutionFixture([skill('trace("read complete"); return args.value;', outputSchema, runtime)]);
    const value = { title: null, body: 'Observed text.' };
    const presentation = {};
    const result = await f.execute(name, { value }, { resultPresentation: presentation });
    assert.deepEqual(result.result, value);
    assert.equal(result.ok, true);
    assert.deepEqual(getToolResultTraces(result, presentation), ['read complete']);

    const failedPresentation = {};
    const invalid = await f.execute(name, { value: { title: null, body: 42 } }, { resultPresentation: failedPresentation });
    assert.equal(invalid.code, 'SKILL_OUTPUT_INVALID');
    assert.equal(invalid.details.tool, name);
    assert.equal(invalid.details.executed, true);
    assert.equal(invalid.details.automaticReplay, false);
    assert.ok(invalid.details.issues.some(issue => issue.path.endsWith('/body') && issue.keyword === 'type'));
    const receipt = scriptReceipt(invalid, { format: 'receipt', isError: true, presentation: failedPresentation });
    assert.equal(receipt.ok, false);
    assert.deepEqual(receipt.trace, ['read complete']);
    assert.equal(receipt.result.code, 'SKILL_OUTPUT_INVALID');
    assert.ok(!('value' in invalid.details), 'validation errors do not echo the extracted data');
  }
});

test('output contracts accept arrays, scalars and authored failure-looking business values', async () => {
  for (const [schema, value] of [
    [{ type: 'array', items: { type: 'integer' } }, [1, 2]],
    [{ type: 'number' }, 0],
    [{ type: 'boolean' }, false],
    [{ type: 'null' }, null],
    [{ type: 'object', required: ['ok', 'error'], properties: { ok: { const: false }, error: { type: 'string' } } },
      { ok: false, error: 'Business data, not a tool failure.' }],
  ]) {
    const f = await scriptExecutionFixture([skill('return args.value;', schema)]);
    assert.deepEqual((await f.execute(name, { value })).result, value);
  }
});

test('execution errors retain their original cause instead of becoming output mismatches', async () => {
  const f = await scriptExecutionFixture([skill('throw new Error("source unavailable");')]);
  const result = await f.execute(name, {});
  assert.equal(result.code, 'SCRIPT_EVALUATION_FAILED');
  assert.match(result.message, /source unavailable/);
});

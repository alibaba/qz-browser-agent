import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSkillManifest, SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from '../../src/shared/skills/skill-manifest.js';
import { validateSkillOutput, validateSkillOutputSchema } from '../../src/shared/skills/skill-output-contract.js';

const parse = tools => parseSkillManifest(JSON.stringify({
  format: SKILL_MANIFEST_FORMAT, schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
  id: 'output-fixture', tools: tools.map(tool => ({ name: 'read', script: 'scripts/read.js', ...tool })),
}), { name: 'output-fixture' });

const reportSchema = {
  type: 'object', required: ['items'], additionalProperties: false,
  properties: { items: { type: 'array', items: {
    type: 'object', required: ['title', 'count'], additionalProperties: false,
    properties: { title: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 0 } },
  } } },
  examples: [{ items: [{ title: 'Example', count: 1 }] }],
};

test('optional output schemas survive manifest parsing while undeclared tools keep their old contract', () => {
  const parsed = parse([{ name: 'typed', outputSchema: reportSchema }, { name: 'legacy' }, { name: 'deny', outputSchema: false }]);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.plugin.tools[0].outputSchema, reportSchema);
  assert.equal(Object.hasOwn(parsed.plugin.tools[1], 'outputSchema'), false);
  assert.equal(parsed.plugin.tools[2].outputSchema, false);
});

test('JSON Schema validates arrays, primitives, nullable values, composition and boolean schemas without coercion', () => {
  for (const [schema, valid, invalid] of [
    [reportSchema, { items: [{ title: 'Result', count: 2 }] }, { items: [{ title: 'Result', count: '2' }] }],
    [{ type: 'array', items: { type: 'string' }, minItems: 1 }, ['value'], []],
    [{ type: 'integer' }, 2, '2'], [{ type: 'boolean' }, true, 1],
    [{ type: ['string', 'null'] }, null, false],
    [{ anyOf: [{ type: 'number' }, { type: 'boolean' }] }, false, 'value'],
    [{ type: 'string', format: 'date' }, '2026-11-07', 'next Saturday'],
  ]) {
    assert.deepEqual(validateSkillOutputSchema(schema), []);
    assert.deepEqual(validateSkillOutput(schema, valid), []);
    assert.ok(validateSkillOutput(schema, invalid).length > 0);
  }
  assert.deepEqual(validateSkillOutputSchema(true), []);
  assert.deepEqual(validateSkillOutputSchema(false), []);
  assert.deepEqual(validateSkillOutput(true, { anything: [1] }), []);
  assert.ok(validateSkillOutput(false, null).some(issue => issue.keyword === 'false'));
});

test('invalid declarations and examples produce errors and never expose an unchecked tool', () => {
  for (const schema of [null, [], 'object', { type: 'invalid' }, { required: 'title' },
    { type: 'array', items: 42 }, { minLength: -1 }, { examples: 'not an array' },
    { type: 'object', properties: { title: { type: 'string', pattern: '[' } } },
    { type: 'object', properties: { value: { $ref: '#/definitions/missing' } } },
    { $ref: 'https://example.com/remote-schema' }, { $ref: '#' },
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    { ...reportSchema, examples: [{ items: [{ title: '', count: 1 }] }] },
    { type: 'object', properties: { value: { type: 'integer', examples: ['wrong'] } } },
  ]) {
    const parsed = parse([{ outputSchema: schema }, { name: 'legacy' }]);
    assert.deepEqual(parsed.plugin.tools.map(tool => tool.localName), ['legacy']);
    assert.ok(parsed.diagnostics.some(item => item.level === 'error' && item.message.includes('outputSchema')));
    assert.ok(parsed.diagnostics.every(item => item.path === 'plugin.json'));
  }
});

test('local references and nested examples are validated against the same document', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft-07/schema#',
    type: 'object', required: ['items'],
    definitions: { count: { type: 'integer', minimum: 0 } },
    properties: { items: { type: 'array', items: { $ref: '#/definitions/count' }, examples: [[1, 2]] } },
    examples: [{ items: [3] }],
  };
  assert.deepEqual(validateSkillOutputSchema(schema), []);
  assert.deepEqual(validateSkillOutput(schema, { items: [7] }), []);
  assert.ok(validateSkillOutput(schema, { items: ['7'] }).some(issue => issue.path === '#/items/0' && issue.keyword === 'type'));
  schema.properties.items.examples = [['secret']];
  const errors = validateSkillOutputSchema(schema);
  assert.ok(errors.some(issue => issue.path === '#/properties/items/examples/0/0' && issue.keyword === 'type'));
  assert.doesNotMatch(JSON.stringify(errors), /secret/);
  const recursive = { type: 'object', properties: { next: { $ref: '#' } } };
  assert.deepEqual(validateSkillOutputSchema(recursive), []);
  assert.deepEqual(validateSkillOutput(recursive, { next: { next: {} } }), []);
});

test('issues stay bounded, contain no actual values, and never mutate schemas or outputs', () => {
  const schema = Object.freeze({ type: 'number', minimum: 0 });
  const numeric = validateSkillOutput(schema, -918273645);
  assert.ok(numeric.some(issue => issue.keyword === 'minimum'));
  assert.doesNotMatch(JSON.stringify(numeric), /918273645/);
  assert.deepEqual(Object.getOwnPropertyNames(schema).sort(), ['minimum', 'type']);
  const value = { items: [{ title: 'Result', count: '5' }] }, before = structuredClone(value);
  validateSkillOutput(reportSchema, value);
  assert.deepEqual(value, before);
  const many = validateSkillOutputSchema({ type: 'number', examples: Array(20).fill('secret-value') });
  assert.ok(many.length > 0 && many.length <= 8);
  assert.doesNotMatch(JSON.stringify(many), /secret-value/);
  assert.ok(many.every(issue => Object.keys(issue).sort().join(',') === 'keyword,message,path'));
});

test('validation works when runtime code generation is unavailable', () => {
  const oldFunction = globalThis.Function, oldEval = globalThis.eval;
  try {
    globalThis.Function = globalThis.eval = () => { throw new Error('CSP prohibits code generation'); };
    assert.deepEqual(validateSkillOutputSchema(reportSchema), []);
    assert.deepEqual(validateSkillOutput(reportSchema, { items: [] }), []);
  } finally {
    globalThis.Function = oldFunction; globalThis.eval = oldEval;
  }
});

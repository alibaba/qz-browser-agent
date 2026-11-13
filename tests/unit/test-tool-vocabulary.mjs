import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry } from '../../src/background/tools/registry.js';
import { validateToolSchema } from '../../src/background/tools/arguments.js';

globalThis.chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, url: 'https://example.test/', title: 'Fixture', status: 'complete' }; },
    async sendMessage(_id, message) { return message.action === 'ping' ? { ok: true, contentType: 'text/html', elementRefs: 1 } : { found: true }; } },
  scripting: { async executeScript() { return [{ documentId: 'doc', result: { readyState: 'complete' } }]; } } };
const { createToolRuntime, resolveToolDefinition, getToolSchemas } = await import('../../src/background/tools/runtime.js');

const ELEMENT_TOOLS = ['inspect_element', 'act_on_element', 'scroll_page', 'screenshot', 'read_image',
  'read_article', 'read_dom', 'get_ax_tree', 'wait_for_element'];

function capturing(names) {
  const registry = createToolRegistry(), seen = [];
  for (const name of names) {
    registry.forCapability('vocabulary-test')({ ...resolveToolDefinition(name), execute: args => { seen.push({ name, args }); return {}; } });
  }
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, getTabAliases: () => ({ page: 7 }),
    resolveTargetTab: async input => ({ ok: true, tabId: input.tabId, ownedByCurrentTask: true }),
  } });
  const context = { sessionId: 's', runId: 'run', language: 'en', toolRegistrySnapshot: registry.snapshot('en') };
  return { seen, execute: (name, args) => runtime.execute(name, args, undefined, context) };
}

test('every visible tool rejects unknown fields and exposes one element vocabulary', () => {
  const schemas = getToolSchemas({ language: 'en' }).map(schema => schema.function);
  assert.ok(schemas.length > 20);
  for (const { name, parameters } of schemas) {
    if (parameters.additionalProperties === true) continue;
    assert.throws(() => validateToolSchema(name, { __unknown: 1 }, parameters), error =>
      error.code === 'INVALID_ARGUMENTS' && error.details.invalidFields.includes('__unknown'), name);
    const fields = Object.keys(parameters.properties);
    if (!['target', 'locator', 'within'].some(field => fields.includes(field))) continue;
    for (const retired of ['index', 'selector', 'root', 'visibleOnly', 'waitFor', 'waitOptions']) {
      assert.equal(fields.includes(retired), false, `${name} exposes retired ${retired}`);
    }
    if (fields.includes('scope')) assert.ok(parameters.properties.scope.enum, `${name} scope names a mode, not a search container`);
  }
  for (const name of ELEMENT_TOOLS) {
    const { properties } = schemas.find(schema => schema.name === name).parameters;
    assert.equal(properties.target?.type, 'string', `${name} target`);
    assert.equal(properties.locator?.type, 'object', `${name} locator`);
  }
  for (const name of ['find_elements', 'list_images']) {
    const { properties } = schemas.find(schema => schema.name === name).parameters;
    assert.equal(properties.target, undefined, `${name} target only names an element`);
    assert.equal(properties.within.type, 'string');
  }
  assert.equal(schemas.find(schema => schema.name === 'list_images').parameters.properties.includeHidden.type, 'boolean');
  assert.equal(schemas.find(schema => schema.name === 'find_elements').parameters.properties.waitForMatch.type, 'boolean');
});

test('retired spellings stay accepted as hidden aliases and reach executors in canonical form', async () => {
  const f = capturing(['find_elements', 'list_images', 'inspect_element', 'act_on_element', 'scroll_page', 'wait_for_element']);
  for (const [name, input, expected] of [
    ['find_elements', { scope: 'css:main', role: 'link' }, { within: 'css:main' }],
    ['find_elements', { target: 'css:main', waitFor: 'match' }, { within: 'css:main', waitForMatch: true }],
    ['find_elements', { locator: { role: 'row', scope: 'css:#orders' }, countOnly: true }, { locator: { role: 'row', within: 'css:#orders' } }],
    ['list_images', { target: 'css:article', visibleOnly: false }, { within: 'css:article', includeHidden: true }],
    ['inspect_element', { target: 'css:li', index: 2 }, { nth: 2 }],
    ['scroll_page', { target: 'css:li', index: 1 }, { nth: 1 }],
    ['act_on_element', { target: 'css:input', action: 'press', value: 'Enter' }, { key: 'Enter' }],
    ['wait_for_element', { target: 'css:.toast', absent: true, interval: 500 }, { state: 'hidden', intervalSeconds: 0.5 }],
  ]) {
    await f.execute(name, { tabRef: 'page', ...input });
    const { args } = f.seen.at(-1);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(args[key], value, `${name} ${key}`);
    for (const retired of ['scope', 'index', 'visibleOnly', 'waitFor', 'absent', 'interval']) {
      assert.equal(Object.hasOwn(args, retired), false, `${name} forwards retired ${retired}`);
    }
    if (name === 'find_elements' || name === 'list_images') assert.equal(Object.hasOwn(args, 'target'), false);
  }
  await assert.rejects(f.execute('find_elements', { tabRef: 'page', waitFor: 'visible' }), { code: 'INVALID_ARGUMENTS' });
});

test('element tools accept target or locator, reject both, and reject unknown fields before starting', async () => {
  const f = capturing(ELEMENT_TOOLS);
  const required = { act_on_element: { action: 'click' } };
  for (const name of ['inspect_element', 'act_on_element', 'scroll_page', 'screenshot', 'read_dom', 'get_ax_tree', 'wait_for_element']) {
    const base = { tabRef: 'page', ...required[name] };
    await f.execute(name, { ...base, target: 'css:main' });
    await f.execute(name, { ...base, locator: { role: 'main', within: 'css:body' } });
    assert.deepEqual(f.seen.at(-1).args.locator, { role: 'main', within: 'css:body' }, name);
    await assert.rejects(f.execute(name, { ...base, target: 'css:main', locator: { role: 'main' } }), { code: 'INVALID_ELEMENT_TARGET' }, name);
    if (resolveToolDefinition(name).parameters.properties.nth) {
      await assert.rejects(f.execute(name, { ...base, locator: { role: 'main' }, nth: 1 }), { code: 'INVALID_ELEMENT_TARGET' }, name);
    }
    await assert.rejects(f.execute(name, { ...base, target: 'css:main', bogus: true }), error => {
      assert.equal(error.code, 'INVALID_ARGUMENTS', name);
      assert.deepEqual(error.details.invalidFields, ['bogus'], name);
      assert.equal(error.details.status, 'not_started');
      assert.equal(error.details.mayHaveTakenEffect, false);
      assert.doesNotMatch(error.message, /timed out|超时/);
      return true;
    });
  }
  const before = f.seen.length;
  for (const input of [{ action: 'fill' }, { action: 'select' }, { action: 'press' }]) {
    await assert.rejects(f.execute('act_on_element', { tabRef: 'page', target: 'css:input', ...input }), { code: 'MISSING_REQUIRED_ARGUMENTS' });
  }
  assert.equal(f.seen.length, before, 'invalid input never reaches the executor');
});

test('timeouts are seconds everywhere and out-of-range values fail instead of clamping', async () => {
  const names = ['inspect_element', 'act_on_element', 'read_article', 'wait_for_element', 'screenshot'];
  const f = capturing(names);
  for (const name of names) {
    const { timeout } = resolveToolDefinition(name);
    const maximum = (typeof timeout === 'function' ? timeout({}) : timeout).maxMs / 1000;
    const base = { tabRef: 'page', target: 'css:main', ...{ act_on_element: { action: 'click' }, read_article: { source: 'target', limit: 1000 } }[name] };
    for (const value of [0, -1, maximum + 1]) {
      await assert.rejects(f.execute(name, { ...base, timeout: value }), error => {
        assert.equal(error.code, 'INVALID_TIMEOUT', `${name} ${value}`);
        assert.deepEqual([error.details.unit, error.details.maximum, error.details.value], ['seconds', maximum, value]);
        assert.equal(error.details.status, 'not_started');
        return true;
      });
    }
    await f.execute(name, { ...base, timeout: maximum });
    assert.equal(f.seen.at(-1).name, name);
  }
});

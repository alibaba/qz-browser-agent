import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createMemoryStorage } from '../support/memory-storage.mjs';
import { createToolRegistry } from '../../src/background/tools/registry.js';
import { isDriveToolDiscoverable, isDriveToolForbidden, prepareDriveToolCall, projectDriveResult, runDriveCalls } from '../../src/background/mcp/external-drive.js';

globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: createMemoryStorage() },
  tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Page' }) },
};
const { createToolRuntime, resolveToolDefinition, getToolSchemas } = await import('../../src/background/tools/runtime.js');
const { prepareSkillToolRegistryFromStorage } = await import('../../src/background/skills/skill-tool-runtime.js');
const { driveGuide } = await import('../../services/mcp-bridge/src/drive-guide.mjs');

function fixture() {
  const aliases = { shop: 7, pdf: 8 };
  const targets = [];
  const runtime = createToolRuntime({ sessions: {
    getTabAliases: () => aliases,
    isRunCurrent: () => true,
    resolveTargetTab: async input => { targets.push(input.tabId); return { ok: true, tabId: input.tabId, ownedByCurrentTask: true }; },
  } });
  const context = { sessionId: 'drive', runId: 'opaque-external-run', externalDrive: true, workingTabId: 999 };
  return { runtime, aliases, targets, context };
}

test('compact discovery includes every visible tool and named discovery preserves full schemas', async () => {
  const skillToolRegistrySnapshot = await prepareSkillToolRegistryFromStorage();
  const schemas = getToolSchemas({ skillToolRegistrySnapshot, loadedPluginSkillNames: ['qingzhou-documents'] });
  const names = new Set(schemas.map(schema => schema.function.name).filter(name => !isDriveToolForbidden(name)));
  const guide = driveGuide({ explicit: 'en', env: {} });
  const f = fixture();
  const context = { ...f.context, skillToolRegistrySnapshot, loadedPluginSkillNames: ['qingzhou-documents'] };
  const defaults = await f.runtime.execute('list_tools', {}, undefined, context);
  assert.deepEqual(new Set(defaults.tools.map(tool => tool.name)), new Set([...names].filter(isDriveToolDiscoverable)));
  for (const name of ['act_on_screen', 'list_images', 'download_url', 'read_dom', 'wait_until']) {
    assert.ok(defaults.tools.some(tool => tool.name === name), `Discoverable without guessing its name: ${name}`);
  }
  assert.ok(defaults.tools.some(tool => tool.name.startsWith('qingzhou_documents__')), 'loaded Skill tools are discoverable');
  for (const name of ['run_script', 'collect_images', 'read_image_asset', 'data_store']) {
    assert.ok(!defaults.tools.some(tool => tool.name === name), `Hidden compatibility tool: ${name}`);
  }
  assert.ok(defaults.tools.every(tool => typeof tool.signature === 'string' && !Object.hasOwn(tool, 'parameters')));
  const mentioned = new Set([...guide.matchAll(/\btools\.([a-z_]+)\b|\b([a-z]+(?:_[a-z]+)+)\(\{/g)]
    .map(match => match[1] || match[2]));
  for (const name of mentioned) assert.ok(names.has(name), `Documented tool must be callable: ${name}`);
  const detailed = await f.runtime.execute('list_tools', { names: [...mentioned] }, undefined, context);
  assert.deepEqual(new Set(detailed.tools.map(tool => tool.name)), mentioned);
  for (const tool of detailed.tools) assert.deepEqual(tool.parameters, schemas.find(schema => schema.function.name === tool.name).function.parameters);
  for (const schema of schemas) {
    if (!names.has(schema.function.name)) continue;
    const description = schema.function.description;
    for (const [, name] of description.matchAll(/\b(qingzhou_documents__\w+)\b/g)) assert.ok(names.has(name), name);
  }
  const companion = readFileSync(new URL('../../skills/qz-browser-agent/references/create-task.md', import.meta.url), 'utf8');
  assert.match(companion, /Direct drive does not use this file/);
  assert.equal(isDriveToolDiscoverable('wait_until'), true);
  for (const name of ['ask_user', 'wait_for_user']) assert.equal(isDriveToolForbidden(name), true);
});

test('list_skills really executes before loading a Skill and accepts a valid page reference', async () => {
  const f = fixture();
  const listed = await f.runtime.execute('list_skills', { tabRef: 'shop' }, undefined, f.context);
  assert.ok(listed.names.includes('qingzhou-documents'));
  const loaded = await f.runtime.execute('load_skill', { name: 'qingzhou-documents', tabRef: 'shop' }, undefined, f.context);
  assert.equal(loaded.name, 'qingzhou-documents');
  const projected = projectDriveResult(loaded).value;
  assert.doesNotMatch(projected.runtime, /\binner\b|tabId|working tab|工作标签页/);
  assert.match(projected.runtime, /qingzhou_documents__document_read_chunk/);
  assert.deepEqual(f.targets, [], 'metadata calls must not select or claim a tab');
});

test('single and batch non-page calls validate then discard tabRef, including URL images', async () => {
  const f = fixture(), seen = [];
  const registry = createToolRegistry(), register = registry.forCapability('drive-test');
  const cases = [
    ['wait', { seconds: 0 }], ['wait_until', { until: '2030-01-01T00:00:00Z' }],
    ['list_tabs', {}], ['list_skills', {}], ['load_skill', { name: 'qingzhou-documents' }],
    ['read_image', { url: 'https://example.test/a.png' }],
    ['collect_images', { table: 'photos', urls: ['https://example.test/a.png'] }],
  ];
  for (const [name] of cases) register({ ...resolveToolDefinition(name), execute: args => { seen.push({ name, args }); return { ok: true }; } });
  const context = { ...f.context, toolRegistrySnapshot: registry.snapshot() };
  const calls = cases.map(([name, args]) => ({ id: name, name, args: { ...args, tabRef: 'shop' } }));
  for (const call of calls) await f.runtime.execute(call.name, call.args, undefined, context);
  const batch = await runDriveCalls(calls, {
    aliases: f.aliases, context, signal: new AbortController().signal,
    getBatchTabPolicy: (name, args) => f.runtime.getBatchTabPolicy(name, args, context),
    execute: (name, args, signal, context) => f.runtime.execute(name, args, signal, context),
  });
  assert.ok(batch.results.every(row => !row.isError), JSON.stringify(batch.results));
  assert.equal(seen.length, calls.length * 2);
  for (const { args } of seen) {
    assert.equal(Object.hasOwn(args, 'tabRef'), false);
    assert.equal(Object.hasOwn(args, 'tabId'), false);
  }
  assert.deepEqual(f.targets, []);
  await assert.rejects(f.runtime.execute('wait', { seconds: 0, tabRef: 'missing' }, undefined, context),
    { code: 'BATCH_TAB_REFERENCE_ERROR' });
});

test('screenshot viewport misuse retains actionable recovery through the real runtime in both languages', async () => {
  const f = fixture();
  for (const language of ['zh-CN', 'en']) {
    await assert.rejects(f.runtime.execute('screenshot', { tabRef: 'shop', target: 'viewport' }, undefined,
      { ...f.context, language }), error => {
      assert.equal(error.code, 'SCREENSHOT_TARGET_INVALID');
      assert.match(error.message, language === 'en' ? /Omit target to capture the viewport/ : /截视口不传 target/);
      return true;
    });
  }
  assert.deepEqual(f.targets, [], 'argument recovery must precede page targeting or capture');
});

test('screen actions require an explicit drive page and use its alias rather than the working tab', async () => {
  const f = fixture(), registry = createToolRegistry();
  registry.forCapability('drive-test')({ ...resolveToolDefinition('act_on_screen'), execute: args => ({ operated: args.tabId }) });
  const context = { ...f.context, toolRegistrySnapshot: registry.snapshot() };
  const args = { tabRef: 'pdf', action: 'press', key: 'Escape', returnScreenshot: false };
  assert.equal(prepareDriveToolCall('act_on_screen', {}).error.code, 'TAB_REF_REQUIRED');
  assert.equal((await f.runtime.execute('act_on_screen', args, undefined, context)).operated, 8);
  const batch = await runDriveCalls([{ id: 'screen', name: 'act_on_screen', args }], {
    aliases: f.aliases, context, signal: new AbortController().signal,
    getBatchTabPolicy: (name, args) => f.runtime.getBatchTabPolicy(name, args, context),
    execute: (name, args, signal, context) => f.runtime.execute(name, args, signal, context),
  });
  assert.equal(batch.results[0].result.operated, 8);
  assert.ok(f.targets.every(id => id === 8));
});

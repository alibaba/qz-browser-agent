import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestAgentOptions, createTestAgentServices } from '../support/agent-services.mjs';

let language = 'zh-CN';
globalThis.chrome = {
  i18n: { getUILanguage: () => language },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  runtime: { getURL: path => `chrome-extension://test/${path}`, lastError: null },
};
const { getLanguage, withLanguage } = await import('../../src/shared/i18n/index.js');
const { createToolRuntime, defineTool, getToolSchemas, resolveToolDefinition } = await import('../../src/background/tools/runtime.js');
const { createToolRegistry } = await import('../../src/background/tools/registry.js');
const { listBuiltinSkills } = await import('../../src/shared/skills/builtin-skills.js');
const { prepareSkillToolRegistryFromSkills, commitSkillToolRegistryCandidate, getSkillToolRegistryExecutionSnapshot, executeSkillTool } = await import('../../src/background/skills/skill-tool-runtime.js');
const { createSkillHostRegistry, resolveSkillHostBinding } = await import('../../src/background/skills/skill-host-registry.js');
const { parseSkillManifest, findSkillManifestResource } = await import('../../src/shared/skills/skill-manifest.js');
const { trustEmbeddedSkill, copySkillManifestTrust } = await import('../../src/shared/skills/skill-provenance.js');
const { issueToolEffects, consumeToolEffects } = await import('../../src/background/tools/effects.js');
const { Agent } = await import('../../src/background/agent/agent.js');
const { createRunScriptBridge } = await import('../../src/background/tools/run-script-bridge.js');

function assertPlainFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    assert.equal(descriptor.get, undefined, key);
    assertPlainFrozen(descriptor.value);
  }
}

test('real core declarations switch languages without recreating handlers or runtime bridges', () => {
  language = 'zh-CN';
  const runtime = createToolRuntime();
  const zh = runtime.snapshot();
  language = 'en';
  const en = runtime.snapshot();
  for (const [name, before] of zh.entries()) {
    const after = en.get(name);
    assert.equal(after.execute, before.execute, `${name}: stateful handler stays registered once`);
    assert.equal(after.validateArgs, before.validateArgs, name);
    assertPlainFrozen(before);
    assertPlainFrozen(after);
  }
  assert.match(zh.get('open_tab').description, /\p{Script=Han}/u);
  assert.doesNotMatch(en.get('open_tab').description, /\p{Script=Han}/u);
  assert.notEqual(zh.get('open_tab').title, en.get('open_tab').title);
  assert.notEqual(zh.get('inspect_element').parameters.properties.target.description, en.get('inspect_element').parameters.properties.target.description);
  assert.notEqual(zh.get('run_script').parameters.properties.timeout.description, en.get('run_script').parameters.properties.timeout.description);
  for (const locale of ['zh-CN', 'en', 'zh-CN', 'en']) {
    assert.equal(runtime.snapshot(locale), locale === 'en' ? en : zh);
    assert.equal(runtime.snapshot(locale).get('run_script').execute, zh.get('run_script').execute);
  }
  assert.equal(resolveToolDefinition('open_tab', { toolRegistrySnapshot: zh }).description, zh.get('open_tab').description);
  assert.equal(getToolSchemas({ toolRegistrySnapshot: zh }).find(tool => tool.function.name === 'open_tab').function.description, zh.get('open_tab').description);
});

test('snapshots materialize nested getters and isolate subsequent declaration changes', () => {
  const registry = createToolRegistry();
  const shared = { type: 'string', get description() { return getLanguage(); } };
  let executions = 0;
  const execute = () => ++executions;
  registry.defineTool({ name: 'probe', get description() { return getLanguage(); },
    parameters: { type: 'object', properties: { value: shared } }, execute });
  const zh = registry.snapshot('zh-CN'), en = registry.snapshot('en');
  shared.type = 'number';
  assert.equal(zh.get('probe').parameters.properties.value.type, 'string');
  assert.equal(zh.get('probe').parameters.properties.value.description, 'zh-CN');
  assert.equal(en.get('probe').parameters.properties.value.description, 'en');
  assert.throws(() => { en.get('probe').parameters.properties.value.type = 'boolean'; }, TypeError);
  assert.equal(zh.get('probe').execute, en.get('probe').execute);
  assert.equal(zh.get('probe').execute(), 1);
  assert.equal(en.get('probe').execute(), 2);
});

test('builtin manifest descriptions follow each snapshot while old snapshots retain their language', () => {
  language = 'zh-CN';
  commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills(listBuiltinSkills()));
  const zh = getSkillToolRegistryExecutionSnapshot('zh-CN');
  const en = getSkillToolRegistryExecutionSnapshot('en');
  const names = listBuiltinSkills().map(skill => skill.name);
  const schemas = snapshot => getToolSchemas({ language: snapshot === zh ? 'zh-CN' : 'en', skillToolRegistrySnapshot: snapshot, loadedPluginSkillNames: names });
  const old = schemas(zh);
  language = 'en';
  for (const plugin of en.plugins) {
    assert.doesNotMatch(plugin.description, /\p{Script=Han}/u);
    assertPlainFrozen(plugin);
    for (const tool of plugin.tools) assert.doesNotMatch(tool.description, /\p{Script=Han}/u);
  }
  assert.deepEqual(schemas(zh), old);
  assert.notDeepEqual(schemas(en), old);
  assert.match(listBuiltinSkills('zh-CN').find(skill => skill.name === 'skill-workbench').content, /\p{Script=Han}/u);
  assert.doesNotMatch(listBuiltinSkills('en').find(skill => skill.name === 'skill-workbench').content, /\p{Script=Han}/u);
});

test('trusted host bindings preserve their full contract across language snapshots', () => {
  const skills = new Map(['zh-CN', 'en'].map(locale => {
    const localized = locale === 'en' ? 'Inspect title' : '检查标题';
    const manifest = {
      format: 'qingzhou.plugin', schemaVersion: 1, id: 'locale-host-fixture',
      tools: [{ name: 'inspect', runtime: 'host', script: 'scripts/inspect.js', args: { mode: 'read' },
        description: localized, parameters: { type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', description: localized, minLength: 1 },
            description: { type: 'string', enum: ['literal description'], default: 'literal description' },
            default: { type: 'string', enum: ['literal default'] },
          }, required: ['title'] } }],
    };
    const skill = trustEmbeddedSkill({ ...listBuiltinSkills(locale)[0],
      name: 'locale-host-fixture', resources: [
        { path: 'plugin.json', type: 'json', content: JSON.stringify(manifest) },
        { path: 'scripts/inspect.js', type: 'script', content: 'return null;' },
      ],
    });
    return [locale, skill];
  }));
  let registrations = 0;
  const execute = () => ({ ok: true });
  const registry = createSkillHostRegistry([qz => {
    registrations++;
    qz.registerSkillHost({ skillName: 'locale-host-fixture', manifestId: 'locale-host-fixture', toolName: 'inspect', execute });
  }], [skills.get('zh-CN')], locale => [skills.get(locale)]);
  const plugins = new Map([...skills].map(([locale, skill]) => [locale,
    withLanguage(locale, () => parseSkillManifest(findSkillManifestResource(skill.resources).content, skill).plugin)]));
  for (const locale of ['en', 'zh-CN', 'en']) {
    language = locale === 'en' ? 'zh-CN' : 'en';
    const plugin = plugins.get(locale), tool = plugin.tools[0];
    assert.equal(registry.resolve(plugin, tool, locale).execute, execute);
    assert.equal(registry.resolve(plugin, tool, language), null, 'the descriptor must match the explicit run language');
    const external = structuredClone(plugin);
    assert.equal(registry.resolve(external, external.tools[0], locale), null, 'serialized builtin flags grant no authority');
    assert.equal(registry.resolve(plugin, structuredClone(tool), locale), null, 'tool identity must belong to this manifest');
    for (const mutate of [
      item => { item.parameters.properties.title.type = 'number'; },
      item => { item.parameters.properties.title.minLength = 0; },
      item => { item.parameters.properties.description.enum = ['changed']; },
      item => { item.parameters.properties.description.default = 'changed'; },
      item => { item.parameters.properties.default.enum = ['changed']; },
      item => { item.parameters.required = []; },
      item => { item.parameters.additionalProperties = true; },
      item => { item.script = 'scripts/other.js'; },
      item => { item.runtime = 'inner'; },
      item => { item.capabilityId = 'manage_settings'; },
      item => { item.args.mode = 'write'; },
    ]) {
      const changed = structuredClone(plugin);
      mutate(changed.tools[0]);
      // A trusted contribution still cannot bind host code to a different execution contract.
      copySkillManifestTrust(plugin, changed);
      for (const targetLocale of ['zh-CN', 'en']) assert.equal(registry.resolve(changed, changed.tools[0], targetLocale), null);
    }
  }
  assert.equal(registrations, 1, 'language catalogs never rerun host factories');
});

test('builtin host execution uses the explicit language with and without a run snapshot', async () => {
  commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills(listBuiltinSkills('zh-CN')));
  for (const locale of ['en', 'zh-CN', 'en']) {
    language = locale === 'en' ? 'zh-CN' : 'en';
    const snapshot = getSkillToolRegistryExecutionSnapshot(locale);
    for (const plugin of snapshot.plugins) for (const tool of plugin.tools.filter(tool => tool.runtime === 'host')) {
      assert.ok(resolveSkillHostBinding(plugin, tool, locale), `${locale}: ${tool.name}`);
    }
    const toolName = 'qingzhou_skill_author__load_available_renderers';
    for (const withSnapshot of [true, false]) {
      const result = await executeSkillTool(toolName, { timeout: 30 }, undefined,
        { language: locale, ...(withSnapshot ? { skillToolRegistrySnapshot: snapshot } : {}) },
        () => assert.fail('listing renderers should not dispatch nested tools'));
      assert.equal(result.ok, true);
      assert.ok(result.count > 0);
    }
  }
});

test('parallel Agents retain their run language through Skill changes and start later runs in the new language', async () => {
  const started = new Map(), release = new Map(), requests = new Map(), contexts = [], registryReads = [];
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  for (const id of ['old', 'new']) { started.set(id, deferred()); release.set(id, deferred()); requests.set(id, []); }
  defineTool({ name: '__language_run_probe', get description() { return getLanguage(); },
    parameters: { type: 'object', properties: {} },
    async execute(_args, _signal, context) {
      contexts.push(context); started.get(context.sessionId).resolve();
      await release.get(context.sessionId).promise;
      const result = { saved: true };
      issueToolEffects(result, [{ type: 'skills.changed' }], context);
      return result;
    },
  });
  const tools = createToolRuntime();
  const agents = ['old', 'new'].map(id => new Agent(id, createTestAgentOptions({
    tools: { ...tools, consumeEffects: consumeToolEffects },
    services: createTestAgentServices({
      getSkillToolRegistrySnapshot(locale) { registryReads.push([id, locale]); return getSkillToolRegistryExecutionSnapshot(locale); },
      buildSkillPromptSection: async locale => `\nSkill locale: ${locale}`,
    }),
    llm: {
      async *chatStream(messages, schemas) {
        const history = requests.get(id);
        history.push({ system: messages[0].content, description: schemas.find(tool => tool.function.name === '__language_run_probe').function.description });
        yield { type: 'done', message: history.length === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: `${id}-tool`, type: 'function', function: { name: '__language_run_probe', arguments: '{}' } }] }
          : { role: 'assistant', content: 'done' } };
      },
      async chat() { throw new Error('Unexpected fallback'); },
    },
  })));
  language = 'zh-CN';
  const oldRun = agents[0].prompt('first', {});
  await started.get('old').promise;
  const oldContext = agents[0].getRunToolContext();
  language = 'en';
  const newRun = agents[1].prompt('second', {});
  await started.get('new').promise;
  assert.equal(agents[0].getRunToolContext().toolRegistrySnapshot, oldContext.toolRegistrySnapshot);
  assert.equal(agents[1].getRunToolContext().language, 'en');
  commitSkillToolRegistryCandidate(prepareSkillToolRegistryFromSkills(listBuiltinSkills()));
  release.get('new').resolve(); await newRun;
  release.get('old').resolve(); await oldRun;
  await agents[0].prompt('follow up', {});
  assert.deepEqual(requests.get('old').map(request => request.description), ['zh-CN', 'zh-CN', 'en']);
  assert.deepEqual(requests.get('new').map(request => request.description), ['en', 'en']);
  assert.deepEqual(registryReads.filter(([id]) => id === 'old').map(([, locale]) => locale), ['zh-CN', 'zh-CN', 'en']);
  assert.equal(contexts[0].toolRegistrySnapshot, oldContext.toolRegistrySnapshot);
  assert.match(requests.get('old')[0].system, /Skill locale: zh-CN/);
  assert.match(requests.get('old')[1].system, /Skill locale: zh-CN/);
  assert.match(requests.get('old')[2].system, /Skill locale: en/);
  assert.doesNotMatch(requests.get('old')[2].system, /\p{Script=Han}/u);
  assert.equal(agents[0].getRunToolContext(), null);
});

test('delayed failures keep the calling run language through runtime and nested script localization', async () => {
  let release, started;
  let gate, entered;
  const reset = () => {
    gate = new Promise(resolve => { release = resolve; });
    entered = new Promise(resolve => { started = resolve; });
  };
  defineTool({ name: '__language_failure_probe', description: 'Delayed failure',
    parameters: { type: 'object', properties: { throws: { type: 'boolean' } } },
    async execute({ throws }) {
      started(); await gate;
      if (throws) throw Object.assign(new Error('row changed'), { code: 'DATA_ROW_CONFLICT' });
      return { error: 'row changed', code: 'DATA_ROW_CONFLICT' };
    },
  });
  const runtime = createToolRuntime();
  const context = { language: 'zh-CN', toolRegistrySnapshot: runtime.snapshot('zh-CN'), sessionId: 'failure', runId: 'run' };
  const bridge = createRunScriptBridge({
    supervisor: { isRunCurrent: () => true, hasAgent: () => true, getAbortSignal: () => undefined },
    getRuntime: () => ({ status: 'running' }),
    canManageSessions: async () => true,
    buildRunProfile: async () => ({}),
    getRunToolContext: async () => context,
    toolRuntime: runtime,
    collectArtifacts: () => [],
  });
  for (const nested of [false, true]) for (const throws of [false, true]) {
    reset(); language = 'zh-CN';
    const pending = nested
      ? bridge.handleToolCall({ sessionId: 'failure', runId: 'run', toolName: '__language_failure_probe', args: { throws } })
      : runtime.execute('__language_failure_probe', { throws }, undefined, context).catch(error => ({ error: error.message, code: error.code, codeLabel: error.codeLabel }));
    await entered; language = 'en'; release();
    const failure = await pending;
    assert.equal(failure.code, 'DATA_ROW_CONFLICT');
    assert.match(failure.message || failure.error, /\p{Script=Han}/u, `${nested ? 'nested' : 'direct'} ${throws ? 'throw' : 'payload'}`);
    if (nested) assert.ok(Object.keys(failure.result).every(key => ['code', 'message', 'hint', 'details'].includes(key)));
  }
  const fresh = await runtime.execute('__language_failure_probe', {}, undefined, { language: 'en', toolRegistrySnapshot: runtime.snapshot('en') });
  assert.doesNotMatch(fresh.message || fresh.error, /\p{Script=Han}/u);
});

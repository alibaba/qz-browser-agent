import assert from 'node:assert/strict';
import test from 'node:test';
import { issueToolEffects, consumeToolEffects } from '../../src/background/tools/effects.js';
import { Agent } from '../../src/background/agent/agent.js';
import { normalizeLlmFailure } from '../../src/background/llm/provider-errors.js';
import { createSessionRecord, readSessionRecord, updateTranscriptWithAgentEvent } from '../../src/shared/session/session-codec.js';
import { createTestAgentOptions, createTestAgentServices } from '../support/agent-services.mjs';

// No Chrome global or replaced Agent private method is needed by these run tests.
test('Agent freezes a run config, rebuilds Skill prompts, and adopts successful registry mutations', async () => {
  assert.equal(globalThis.chrome, undefined);
  let config = Object.freeze({ provider: 'test', model: 'model-a', contextWindow: 262000 });
  let configVersion = 0;
  let skillVersion = 0;
  let registryVersion = 1;
  let configReads = 0;
  let registryReads = 0;
  let skillReads = 0;
  const requests = [];
  const schemaVersions = [];
  const contextReasons = [];
  const agent = new Agent('pure-agent', createTestAgentOptions({
    services: createTestAgentServices({
      getRuntimeConfig: async () => { configReads++; return config; },
      getRuntimeConfigVersion: () => configVersion,
      buildSkillPromptSection: async () => { skillReads++; return `\nSkill version ${skillVersion}`; },
      getSkillToolRegistrySnapshot: () => { registryReads++; return { version: registryVersion }; },
    }),
    tools: {
      getIdentity: () => ({}),
      getSchemas({ skillToolRegistrySnapshot }) { schemaVersions.push(skillToolRegistrySnapshot.version); return []; },
      consumeEffects: consumeToolEffects,
      async execute(_name, _args, _signal, context) {
        config = Object.freeze({ ...config, model: 'model-b' }); configVersion++;
        skillVersion++; registryVersion++;
        const result = { action: 'update', saved: true };
        issueToolEffects(result, [{ type: 'skills.changed' }], context);
        return result;
      },
    },
    llm: {
      async *chatStream(messages, tools, signal, options) {
        requests.push({ messages: structuredClone(messages), tools, signal, config: options.config });
        const message = requests.length === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'skill-update', type: 'function', function: { name: 'manage_skill', arguments: '{"action":"update"}' } }] }
          : { role: 'assistant', content: 'done' };
        yield { type: 'done', message };
      },
      async chat() { throw new Error('unexpected fallback'); },
    },
  }));
  agent.setDynamicContextProvider(async ({ reason, runId }) => {
    contextReasons.push({ reason, runId });
    return { sources: [{ id: 'notes', title: 'Notes', text: 'Reference only' }] };
  });
  await agent.prompt('update the skill', {});
  await agent.prompt('continue', {});
  assert.deepEqual(requests.map(request => request.config.model), ['model-a', 'model-a', 'model-b']);
  assert.deepEqual(requests.map(request => request.messages[0].content.match(/Skill version (\d)/)[1]), ['0', '1', '1']);
  assert.deepEqual(schemaVersions, [1, 2, 2]);
  assert.equal(configReads, 2);
  assert.equal(skillReads, 3);
  assert.equal(registryReads, 3);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.notEqual(requests[1].signal, requests[2].signal);
  assert.ok(contextReasons.some(request => request.reason === 'tool' && request.runId));
  assert.ok(requests[0].messages.some(message => String(message.content).includes('Reference only')));
  assert.equal(agent.messages.at(-1).content, 'done');
});

test('a compatibility attempt reuses prepared messages, tools and Skill prompt', async () => {
  let skillReads = 0;
  let schemaReads = 0;
  let streamed;
  let fallback;
  const events = [];
  const agent = new Agent('prepared-once', createTestAgentOptions({
    services: createTestAgentServices({ buildSkillPromptSection: async () => { skillReads++; return 'skill prompt'; } }),
    tools: { getIdentity: () => ({}), getSchemas: () => { schemaReads++; return []; }, execute: async () => ({}) },
    llm: {
      async *chatStream(messages, tools, signal, options) {
        streamed = { messages, tools, signal, options };
        yield { type: 'text_delta', delta: 'partial' };
        throw normalizeLlmFailure(new Error('stream ended without finish_reason'), { code: 'STREAM_INCOMPLETE' });
      },
      async chat(messages, tools, signal, options) {
        fallback = { messages, tools, signal, options };
        return { message: { role: 'assistant', content: 'replacement' } };
      },
    },
  }));
  agent.subscribe(event => events.push(event));
  await agent.prompt('hello', {});
  assert.equal(skillReads, 1);
  assert.equal(schemaReads, 1);
  assert.equal(streamed.messages, fallback.messages);
  assert.equal(streamed.tools, fallback.tools);
  assert.equal(streamed.signal, fallback.signal);
  assert.equal(fallback.options.retry.maxRetries, 0);
  assert.equal(agent.messages.at(-1).content, 'replacement');
  assert.deepEqual(events.filter(event => event.type === 'message_update').map(event => event.content), ['partial', '', 'replacement']);
  const transcript = events.reduce((history, event) => updateTranscriptWithAgentEvent(history, event).transcript, []);
  assert.deepEqual(transcript.filter(entry => entry.type === 'assistant').map(entry => entry.content), ['replacement']);
});

test('live events retain tool identity, ordered metadata and terminal listener completion', async () => {
  const events = [];
  let round = 0;
  let terminalObserved = false;
  const result = { rows: [{ label: 'opaque tool result' }] };
  const agent = new Agent('typed-events', createTestAgentOptions({
    tools: { getIdentity: () => ({ name: 'lookup', capabilityId: 'example', title: 'Lookup' }),
      getSchemas: () => [], execute: async () => result },
    llm: {
      async *chatStream() {
        if (++round === 1) {
          yield { type: 'thinking_delta', delta: 'Inspecting' };
          yield { type: 'tool_call_update', index: 0, toolName: 'lookup', arguments: '{' };
          yield { type: 'tool_call_update', index: 0, toolCallId: 'call-1', toolName: 'lookup', arguments: '{}', argsComplete: true };
          yield { type: 'done', message: { role: 'assistant', content: '',
            tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }] } };
        } else {
          yield { type: 'text_delta', delta: 'Done', streamTraceId: 'trace-1' };
          yield { type: 'done', message: { role: 'assistant', content: 'Done' } };
        }
      },
      async chat() { throw new Error('unexpected fallback'); },
    },
  }));
  agent.subscribe(event => { events.push(event); });
  agent.subscribe(async event => {
    if (event.type === 'agent_end') {
      await Promise.resolve();
      terminalObserved = true;
    }
  });
  await agent.prompt('look up', {}, [], 'user-1');
  assert.equal(terminalObserved, true);
  const accepted = events.find(event => event.type === 'message_start' && event.clientMessageId === 'user-1');
  assert.equal(accepted.deliveryStatus, 'accepted');
  assert.equal(accepted.runId, undefined);
  const partial = events.find(event => event.type === 'tool_call_update');
  assert.equal(partial.toolCallId, undefined);
  const started = events.find(event => event.type === 'tool_execution_start');
  const ended = events.find(event => event.type === 'tool_execution_end');
  assert.equal(ended.toolCallId, 'call-1');
  assert.equal(started.spanId, ended.spanId);
  assert.equal(ended.toolCapabilityId, 'example');
  assert.equal(ended.result, result);
  assert.equal(ended.isError, false);
  const runId = events.find(event => event.type === 'agent_start').runId;
  const timeline = events.slice(events.findIndex(event => event.type === 'agent_start')).filter(event => event.eventSeq != null);
  assert.ok(timeline.length > 0);
  assert.ok(timeline.every(event => event.runId === runId));
  assert.deepEqual(timeline.map(event => event.eventSeq), timeline.map((_, index) => index + 1));
  const reply = events.findLast(event => event.type === 'message_end');
  assert.equal(reply.provider, 'test');
  assert.equal(reply.model, 'test-model');
  assert.equal(reply.streamTraceId, 'trace-1');
  const transcript = events.reduce((history, event) => updateTranscriptWithAgentEvent(history, event).transcript, []);
  assert.equal(transcript.filter(entry => entry.type === 'tool').length, 1);
  assert.deepEqual(transcript.find(entry => entry.type === 'tool').result, result);
  assert.equal(transcript.find(entry => entry.type === 'assistant').content, 'Done');
  await agent.prompt('continue', {});
});

test('a required context failure prevents the request from being accepted', async () => {
  let requests = 0;
  const agent = new Agent('required-source', createTestAgentOptions({ llm: {
    async *chatStream() { requests++; }, chat: async () => { requests++; },
  } }));
  agent.setDynamicContextProvider(async () => { throw Object.assign(new Error('required context unavailable'), { code: 'CONTEXT_SOURCE_REQUIRED' }); });
  await assert.rejects(agent.prompt('hello', {}), { code: 'CONTEXT_SOURCE_REQUIRED' });
  assert.equal(requests, 0);
  assert.equal(agent.messages.length, 1);
});

test('idle prompts bind accepted messages to their own runs before assistant output', async () => {
  const events = [];
  const agent = new Agent('idle-follow-up', createTestAgentOptions({ llm: {
    async *chatStream() { yield { type: 'done', message: { role: 'assistant', content: 'Complete' } }; },
    async chat() { throw new Error('unexpected fallback'); },
  } }));
  agent.subscribe(event => events.push(event));
  await agent.prompt('Research', {}, [], 'first');
  await agent.prompt('Make it shorter', {}, [], 'follow-up');
  const starts = events.filter(event => event.type === 'agent_start');
  assert.deepEqual(starts.map(event => event.clientMessageId), ['first', 'follow-up']);
  assert.notEqual(starts[0].runId, starts[1].runId);
  for (const start of starts) {
    const accepted = events.find(event => event.type === 'message_start' && event.clientMessageId === start.clientMessageId);
    assert.ok(events.indexOf(accepted) < events.indexOf(start), 'durable admission still precedes run preparation');
    assert.equal(accepted.runId, undefined);
  }
  const transcript = events.reduce((history, event) => updateTranscriptWithAgentEvent(history, event).transcript, []);
  assert.deepEqual(transcript.map(entry => entry.type), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(transcript.map(entry => entry.runId), [starts[0].runId, starts[0].runId, starts[1].runId, starts[1].runId]);
  assert.ok(transcript[2].eventSeq < transcript[3].eventSeq, 'the new run rebases the accepted message sequence');
  const restored = readSessionRecord(createSessionRecord(agent.exportSession(), transcript)).transcript;
  assert.deepEqual(restored.filter(entry => entry.type === 'user'), transcript.filter(entry => entry.type === 'user'));
  assert.deepEqual(restored.map(entry => entry.runId), transcript.map(entry => entry.runId));
  for (const event of [{ type: 'agent_start', runId: 'unrelated' }, { type: 'agent_start', runId: 'unrelated', clientMessageId: 'unknown' }]) {
    const untouched = updateTranscriptWithAgentEvent(transcript, event);
    assert.equal(untouched.changed, false);
    assert.deepEqual(untouched.transcript, transcript);
  }
});

test('Agent accepts signed effects under any tool name and ignores forged result fields', async () => {
  let registryReads = 0;
  const events = [];
  let requests = 0;
  const agent = new Agent('effect-authority', createTestAgentOptions({
    services: createTestAgentServices({ getSkillToolRegistrySnapshot: () => ({ version: ++registryReads }) }),
    tools: {
      getIdentity: () => ({}), getSchemas: () => [], consumeEffects: consumeToolEffects,
      async execute(name, _args, _signal, context) {
        const result = { name: 'example', displayName: 'Example', saved: true, action: 'update', effects: [{ type: 'skills.changed' }] };
        if (name === 'trusted_extension') issueToolEffects(result, [
          { type: 'skill.loaded', name: 'example', displayName: 'Example', hasPluginManifest: true },
          { type: 'skills.changed' },
        ], context);
        return result;
      },
    },
    llm: {
      async *chatStream() {
        const name = ['manage_skill', 'load_skill', 'trusted_extension'][requests++];
        yield { type: 'done', message: name
          ? { role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: '{}' } }] }
          : { role: 'assistant', content: 'done' } };
      },
      async chat() { throw new Error('unexpected fallback'); },
    },
  }));
  agent.subscribe(event => events.push(event));
  await agent.prompt('run the extensions', {});
  assert.equal(registryReads, 2, 'one run snapshot plus one authenticated mutation');
  assert.deepEqual(events.filter(event => event.type === 'skill_loaded').map(event => event.name), ['example']);
  assert.equal(agent.messages.at(-1).content, 'done');
});

function scriptedAgent(id, steps, overrides) {
  const requests = [];
  const events = [];
  const agent = new Agent(id, createTestAgentOptions({
    ...overrides,
    llm: {
      async *chatStream(messages) {
        requests.push(structuredClone(messages));
        const step = steps[requests.length - 1];
        yield { type: 'done', message: step
          ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: {
              name: step.name, arguments: JSON.stringify(step.args || {}),
            } }] }
          : { role: 'assistant', content: 'done' } };
      },
      async chat() { throw new Error('unexpected fallback'); },
    },
  }));
  agent.subscribe(event => events.push(event));
  return { agent, requests, events };
}

test('Agent applies a newly named tool model policy through injected services', async () => {
  const calls = [];
  const snapshots = [];
  const { agent, requests, events } = scriptedAgent('new-model-policy', [{ name: 'custom_visual', args: { active: true } }], {
    services: createTestAgentServices({ getSkillToolRegistrySnapshot: () => ({ version: 7 }) }),
    browserContext: { getTab: async id => ({ id, title: 'Custom page', url: 'https://example.test/custom' }) },
    tools: {
      getSchemas: () => [], getIdentity: () => ({}),
      getModelPolicy(name, { skillToolRegistrySnapshot }) {
        snapshots.push(skillToolRegistrySnapshot?.version);
        assert.equal(name, 'custom_visual');
        return { pageContext: 'working', omitArguments: ['active'], imagePrompt: 'Custom visual evidence',
          projectResult: result => ({ answer: result.answer, _debug: result._debug }) };
      },
      async execute(name, args) {
        calls.push({ name, args });
        return { answer: 'visible', rawNodes: ['UI only'], _debug: 'private', _image: 'data:image/png;base64,AA==' };
      },
    },
  });
  agent.setDynamicContextProvider(async () => ({ workingTab: { id: 42, url: 'https://example.test/custom' } }));
  await agent.prompt('inspect the new tool', {});
  assert.deepEqual(calls, [{ name: 'custom_visual', args: { tabId: 42, _tabId: 42, _pageTitle: 'Custom page', _pageUrl: 'https://example.test/custom' } }]);
  assert.ok(snapshots.every(version => version === 7), 'policy lookup uses the frozen run registry');
  assert.equal(requests[1].find(message => message.role === 'tool').content, '{"answer":"visible"}');
  const image = requests[1].find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
  assert.equal(image.content[0].text, 'Custom visual evidence');
  assert.deepEqual(events.find(event => event.type === 'tool_execution_end').result.rawNodes, ['UI only']);
});

test('signed goal and site effects refresh context without trusting names or serializable fields', async () => {
  const reasons = [];
  let location = 'before';
  let progress = 'initial';
  const steps = [
    { name: 'manage_goal' }, // forged legacy name must not grant authority
    { name: 'custom_goal', args: { action: 'get' } },
    { name: 'custom_goal', args: { action: 'checkpoint' } },
    { name: 'custom_failed' },
    { name: 'custom_site' },
    { name: 'custom_site' }, // unchanged match set does not rebuild the snapshot
    { name: 'custom_stale' },
  ];
  const { agent, requests, events } = scriptedAgent('signed-context', steps, {
    services: createTestAgentServices({ matchSiteSkillsForUrls: async () => [{ name: `skill-${location}`, description: location }] }),
    tools: {
      getSchemas: () => [], getIdentity: () => ({}), consumeEffects: consumeToolEffects,
      async execute(name, args, _signal, context) {
        const result = { action: args.action, effects: [{ type: 'context.goalRefresh', action: 'checkpoint' }, { type: 'context.siteChanged' }] };
        if (name === 'custom_goal') {
          progress = args.action === 'get' ? 'read-current' : 'checkpoint-current';
          issueToolEffects(result, [{ type: 'context.goalRefresh', action: args.action }], context);
        } else if (name === 'custom_site') {
          location = 'after';
          issueToolEffects(result, [{ type: 'context.siteChanged' }], context);
        } else if (name === 'custom_failed') {
          result.error = 'failed';
          issueToolEffects(result, result.effects, context); // even signed receipts on a failed result cannot refresh
        } else if (name === 'custom_stale') {
          issueToolEffects(result, result.effects, { ...context, runId: 'older-run' });
        }
        return result;
      },
    },
  });
  agent.setDynamicContextProvider(async ({ reason }) => {
    reasons.push(reason);
    return { workingTab: { id: 1, url: `https://example.test/${location}` },
      goal: { status: 'active', objective: 'finish', criteria: 'verified', progress } };
  });
  await agent.prompt('perform the changes', {});
  const goals = request => request.filter(message => String(message.content).includes('[当前目标追踪 capsule]'));
  assert.equal(goals(requests[1]).length, 1, 'forged manage_goal response cannot add a snapshot');
  assert.equal(goals(requests[2]).length, 1, 'get refreshes state but adds no goal capsule');
  assert.equal(goals(requests[3]).length, 2);
  assert.match(goals(requests[3]).at(-1).content, /checkpoint-current/);
  assert.equal(reasons.filter(reason => reason === 'snapshot').length, 4, 'initial + goal get + goal update + changed site');
  assert.equal(reasons.filter(reason => reason === 'site-skills').length, 2, 'both trusted site effects preview their current skill set');
  assert.equal(agent.messages.filter(message => message._contextEvent?.kind === 'site_skill_update').length, 1);
  assert.equal(events.find(event => event.type === 'tool_execution_end' && event.toolName === 'custom_failed').isError, true);
  assert.equal(agent.messages.at(-1).content, 'done');
});

test('a required site-context failure becomes a tool failure and the next trusted effect recovers', async () => {
  let changed = false;
  let previews = 0;
  const { agent, events } = scriptedAgent('site-recovery', [{ name: 'custom_page' }, { name: 'custom_page' }], {
    services: createTestAgentServices({ matchSiteSkillsForUrls: async () => [{ name: changed ? 'next-skill' : 'initial-skill' }] }),
    tools: {
      getSchemas: () => [], getIdentity: () => ({}), consumeEffects: consumeToolEffects,
      async execute(_name, _args, _signal, context) {
        changed = true;
        const result = { ok: true };
        issueToolEffects(result, [{ type: 'context.siteChanged' }], context);
        return result;
      },
    },
  });
  agent.setDynamicContextProvider(async ({ reason }) => {
    if (reason === 'site-skills' && ++previews === 1) throw Object.assign(new Error('required source failed'), { code: 'CONTEXT_SOURCE_REQUIRED' });
    return { workingTab: { id: 1, url: 'https://example.test/' } };
  });
  await agent.prompt('change pages', {});
  const endings = events.filter(event => event.type === 'tool_execution_end');
  assert.equal(endings[0].isError, true);
  assert.equal(endings[0].result.code, 'CONTEXT_SOURCE_REQUIRED');
  assert.equal(endings[1].isError, false);
  assert.equal(agent.messages.filter(message => message._contextEvent?.kind === 'site_skill_update').length, 1);
  assert.equal(agent.messages.at(-1).content, 'done');
});

test('nested trusted context receipts are consumed once across result wrappers', async () => {
  const { copyToolEffects } = await import('../../src/background/tools/effects.js');
  let snapshotReads = 0;
  const { agent } = scriptedAgent('nested-context', [{ name: 'custom_host' }], {
    tools: {
      getSchemas: () => [], getIdentity: () => ({}), consumeEffects: consumeToolEffects,
      async execute(_name, _args, _signal, context) {
        const result = { action: 'checkpoint' };
        issueToolEffects(result, [{ type: 'context.goalRefresh', action: 'checkpoint' }], context);
        assert.equal(await agent.applyNestedToolResult({ runId: 'stale', toolName: 'custom_nested', result }), false);
        assert.equal(await agent.applyNestedToolResult({ runId: context.runId, toolName: 'custom_nested', result }), true);
        return copyToolEffects(result, { ...result, host: true });
      },
    },
  });
  agent.setDynamicContextProvider(async ({ reason }) => {
    if (reason === 'snapshot') snapshotReads++;
    return { goal: { status: 'active', objective: 'finish', criteria: 'verified', progress: `snapshot-${snapshotReads}` } };
  });
  await agent.prompt('execute nested work', {});
  assert.equal(snapshotReads, 2, 'initial snapshot and one nested refresh; the wrapper does not repeat it');
  assert.equal(agent.messages.filter(message => message._contextCapsule?.reason === 'goal_snapshot').length, 2);
  assert.equal(agent.messages.at(-1).content, 'done');
});

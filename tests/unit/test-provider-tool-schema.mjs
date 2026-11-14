import assert from 'node:assert/strict';
import test from 'node:test';
import { Validator } from '@cfworker/json-schema';
import { chatOpenAi, chatStreamOpenAi } from '../../src/capabilities/provider-openai/adapter.js';
import { chatAnthropic, chatStreamAnthropic } from '../../src/capabilities/provider-anthropic/adapter.js';
import { chatCodex, chatStreamCodex } from '../../src/capabilities/provider-codex/adapter.js';

globalThis.chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}` }, storage: { local: {
  async get() { return { openaiCodexAuth: { access: 'synthetic-access', refresh: '', accountId: 'fixture', expires: Date.now() + 3600000 } }; },
  async set() {},
} } };
const { getToolSchemas } = await import('../../src/background/tools/runtime.js');
const tools = getToolSchemas({ language: 'en' });
const compoundTools = ['act_on_element', 'collect_images', 'inspect_element', 'read_image', 'wait_for_element'];

// Strict providers inspect each root alternative independently of its parent's type.
function assertObjectRoot(schema, path = '$') {
  assert.equal(schema.type, 'object', `${path} must explicitly declare an object type`);
  for (const keyword of ['anyOf', 'oneOf']) {
    for (const [index, branch] of (schema[keyword] || []).entries()) assertObjectRoot(branch, `${path}.${keyword}[${index}]`);
  }
}

function legacyImageSchema() {
  const schema = structuredClone(tools.find(tool => tool.function.name === 'read_image').function.parameters);
  for (const branch of schema.anyOf) delete branch.type;
  return schema;
}

test('built-in tool roots and every root union branch explicitly declare objects', () => {
  assert.ok(tools.length > 20, 'audit the complete visible catalog, including vision tools');
  assert.deepEqual(tools.filter(({ function: fn }) => fn.parameters.anyOf || fn.parameters.oneOf)
    .map(({ function: fn }) => fn.name).sort(), compoundTools);
  for (const { function: fn } of tools) assertObjectRoot(fn.parameters, fn.name);
  assertObjectRoot(tools.find(tool => tool.function.name === 'act_on_element').function.parameters.properties.destination, 'destination');
});

test('negative controls reproduce the untyped image alternatives and reject explicit non-object alternatives', () => {
  const legacy = legacyImageSchema();
  assert.equal(legacy.type, 'object', 'checking only the outer type missed this regression');
  assert.equal(new Validator(legacy).validate('not an object').valid, false, 'the parent type still protects full JSON Schema validation');
  for (const branch of legacy.anyOf) {
    assert.equal(new Validator(branch).validate('not an object').valid, true, 'required alone does not constrain the branch type');
  }
  assert.throws(() => assertObjectRoot(legacy), /anyOf\[0\].*object/);
  for (const keyword of ['anyOf', 'oneOf']) for (const branch of [{}, { type: 'string' }, { type: 'null' }, { type: ['object', 'null'] }]) {
    assert.throws(() => assertObjectRoot({ type: 'object', [keyword]: [{ type: 'object' }, branch] }), /object/);
  }
});

test('explicit branch types preserve image alternatives and sibling JSON Schema validation', () => {
  const cases = [
    [true, { url: 'https://example.test/image.png' }],
    [true, { tabRef: 'page', target: 'css:img' }],
    [true, { tabRef: 7, locator: { role: 'img' }, format: 'png', detail: 'high' }],
    [false, null], [false, []], [false, 'image'], [false, {}],
    [false, { target: 'css:img' }], [false, { locator: { role: 'img' } }], [false, { tabRef: 7 }],
    [false, { url: 123 }], [false, { tabRef: false, target: 'css:img' }],
    [false, { url: 'https://example.test/image.png', format: 'gif' }],
  ];
  const image = new Validator(structuredClone(tools.find(tool => tool.function.name === 'read_image').function.parameters));
  for (const [valid, args] of cases) assert.equal(image.validate(args).valid, valid, JSON.stringify(args));
  const samples = [...cases.map(([, args]) => args),
    { table: 'gallery', urls: ['https://example.test/image.png'] },
    { table: 'gallery', urls: [] }, { table: 'gallery', targets: ['css:img'] },
    { table: 'gallery', tabRef: 7, targets: ['css:img'] },
    { table: 'gallery', urls: ['https://example.test/image.png'], targets: ['css:img'] },
    { tabRef: 7, target: 'css:img', locator: { role: 'img' } },
    { action: 'click', tabRef: 7, target: 'css:img' },
    { action: 'drag', tabRef: 7, locator: { role: 'img' }, destination: { target: 'css:main' } },
  ];
  function removeBranchTypes(schema) {
    for (const keyword of ['anyOf', 'oneOf']) for (const branch of schema[keyword] || []) delete branch.type;
    for (const property of Object.values(schema.properties || {})) removeBranchTypes(property);
  }
  for (const name of compoundTools) {
    const schema = tools.find(tool => tool.function.name === name).function.parameters;
    const legacy = structuredClone(schema);
    removeBranchTypes(legacy);
    const before = new Validator(legacy), after = new Validator(structuredClone(schema));
    for (const args of samples) assert.equal(after.validate(args).valid, before.validate(args).valid, `${name}: ${JSON.stringify(args)}`);
    for (const branch of schema.anyOf || schema.oneOf) {
      for (const value of [null, [], 'image', 1, true]) assert.equal(new Validator(structuredClone(branch)).validate(value).valid, false);
    }
  }
});

const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const protocols = [
  { name: 'custom xAI OpenAI-compatible', chat: chatOpenAi, stream: chatStreamOpenAi,
    config: { provider: 'custom', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-4.7', vision: true, contextWindow: 512000 },
    parameters: tool => tool.function.parameters,
    reply: stream => stream ? sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]'])
      : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }) },
  { name: 'Anthropic', chat: chatAnthropic, stream: chatStreamAnthropic,
    config: { provider: 'anthropic', endpoint: 'https://provider.test/v1/messages', model: 'fixture-model' },
    parameters: tool => tool.input_schema,
    reply: stream => stream ? sse([
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]) : Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) },
  { name: 'Codex Responses', chat: chatCodex, stream: chatStreamCodex,
    config: { provider: 'openaicodex', endpoint: 'https://provider.test/codex/responses', model: 'fixture-model' },
    parameters: tool => tool.parameters,
    reply: () => sse([
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }], status: 'completed' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]) },
];
const messages = [{ role: 'user', content: 'Inspect an image.' }];
const options = { retry: { maxRetries: 0 } };

for (const stream of [false, true]) for (const protocol of protocols) {
  test(`${protocol.name} ${stream ? 'stream' : 'chat'}: first offline request has object-only tool alternatives`, async t => {
    const before = JSON.stringify(tools);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, protocol.config.endpoint, 'all provider traffic is intercepted; no live requests');
      requests++;
      const body = JSON.parse(init.body);
      assert.equal(body.tools.length, tools.length);
      for (const [index, tool] of body.tools.entries()) {
        const parameters = protocol.parameters(tool);
        const original = tools[index].function;
        assert.equal(tool.function?.name || tool.name, original.name);
        assertObjectRoot(parameters, original.name);
        // Anthropic's established projection keeps flat properties/required; other adapters preserve the full schema.
        assert.deepEqual(parameters, protocol.name === 'Anthropic'
          ? { type: 'object', properties: original.parameters.properties, required: original.parameters.required || [] }
          : original.parameters);
      }
      return protocol.reply(stream);
    });
    const config = { ...protocol.config, apiKey: '', modelParameters: {} };
    const result = stream
      ? (await Array.fromAsync(protocol.stream(messages, tools, undefined, options, config))).at(-1)
      : await protocol.chat(messages, tools, undefined, options, config);
    assert.equal(result.message.content, 'ok');
    assert.equal(requests, 1, 'no compatibility retry should be needed');
    assert.equal(JSON.stringify(tools), before, 'conversion must not mutate the catalog');
  });
}

for (const stream of [false, true]) test(`legacy read_image ${stream ? 'stream' : 'chat'} reproduces the offline HTTP 400 rejection`, async t => {
  const legacyTools = [{ type: 'function', function: { name: 'read_image', description: 'Historical schema', parameters: legacyImageSchema() } }];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, protocols[0].config.endpoint);
    requests++;
    assert.throws(() => assertObjectRoot(JSON.parse(init.body).tools[0].function.parameters), /anyOf\[0\].*object/);
    return Response.json({ error: { code: 'invalid_client_tool_schema', message:
      'read_image: tool parameter root must be an object type (root schema is an anyOf/oneOf union with a non-object branch)' } }, { status: 400 });
  });
  const config = { ...protocols[0].config, apiKey: '', modelParameters: {} };
  await assert.rejects(stream ? Array.fromAsync(chatStreamOpenAi(messages, legacyTools, undefined, options, config))
    : chatOpenAi(messages, legacyTools, undefined, options, config), /400|invalid_client_tool_schema/);
  assert.equal(requests, 1);
});

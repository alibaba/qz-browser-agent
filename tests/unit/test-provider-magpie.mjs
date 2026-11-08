import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderDef } from '../../src/background/llm/provider-catalog.js';
import { listProviderModels, matchProviderModelCapabilities } from '../../src/background/llm/model-directory.js';
import { saveConfig, getConfig, listModels, applyModelPreset, resolveRequestConfig } from '../../src/background/llm/config.js';
import { buildRunProfile } from '../../src/background/agent/run-profile.js';
import { chatOpenAi, chatStreamOpenAi } from '../../src/capabilities/provider-openai/adapter.js';

function storageFixture(t) {
  const storage = {};
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async key => ({ [key]: storage[key] }),
    set: async values => Object.assign(storage, values),
  } } };
  t.after(() => { globalThis.chrome = previous; });
  return storage;
}

// These are the fields emitted by Magpie's internal/gateway/gateway.go modelObject.
const models = { data: [
  { id: 'account/vision', display_name: 'Vision', context_window: 131072, max_output_tokens: 8192, modalities: { input: ['text', 'image'] } },
  { id: 'group/text', context_window: 32768, max_output_tokens: 4096, modalities: { input: ['text'] } },
  { id: 'account/gpt-6-astra' },
] };

test('Magpie discovers exact IDs, capabilities and optional keys from the selected gateway', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, headers: init.headers });
    return Response.json(url.includes('192.0.2.1')
      ? { data: [{ id: 'account/vision', context_window: 16384, modalities: { input: ['text'] } }] }
      : models);
  });
  const listed = await listProviderModels('magpie', getProviderDef('magpie'), '');
  assert.equal(requests[0].url, 'http://127.0.0.1:3425/v1/models');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(listed.models.find(model => model.id === 'account/vision').vision, true);
  assert.equal(listed.models.find(model => model.id === 'group/text').vision, false);
  const match = await matchProviderModelCapabilities({ provider: 'magpie', model: 'account/vision',
    customEndpoint: 'http://192.0.2.1:4000/v1', apiKey: 'fixture-lan-key' });
  assert.equal(requests.at(-1).url, 'http://192.0.2.1:4000/v1/models');
  assert.equal(requests.at(-1).headers.Authorization, 'Bearer fixture-lan-key');
  assert.equal(match.contextWindow, 16384);
  assert.equal(match.vision, false, 'same ID on another gateway must use that gateway metadata');
  const unknown = await matchProviderModelCapabilities({ provider: 'magpie', model: 'account/gpt-6-astra' });
  assert.equal(unknown.matched, false);
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.vision, null, 'missing metadata cannot use a similarly named public model');
  const controller = new AbortController(); controller.abort();
  const count = requests.length;
  await assert.rejects(listProviderModels('magpie', getProviderDef('magpie'), '', controller.signal), { name: 'AbortError' });
  assert.equal(requests.length, count);
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(matchProviderModelCapabilities({ provider: 'magpie', model: 'account/vision' }), /503/);
});

test('Magpie endpoint presets keep independent credentials and saved capabilities work offline', async t => {
  storageFixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected discovery'); });
  const local = await saveConfig({ provider: 'magpie', model: 'account/vision', apiKey: '',
    customEndpoint: 'http://127.0.0.1:3425/v1', contextWindow: 131072, maxOutputTokens: 8192, vision: true });
  const localId = local.activePresetId;
  const lan = await saveConfig({ provider: 'magpie', model: 'account/vision', apiKey: 'fixture-lan-key',
    customEndpoint: 'http://192.0.2.1:4000/v1', contextWindow: 16384, maxOutputTokens: 512, vision: false });
  assert.equal(lan.presets.length, 2);
  assert.notEqual(lan.activePresetId, localId);
  assert.equal(lan.providerApiKeys.magpie, undefined);
  const restored = await applyModelPreset(localId);
  assert.equal(restored.apiKey, '');
  assert.equal(restored.maxOutputTokens, 8192);
  assert.equal(restored.vision, true);
  await applyModelPreset(lan.activePresetId);
  const config = await resolveRequestConfig();
  const profile = await buildRunProfile({ config });
  assert.equal(profile.model.maxOutputTokens, 512);
  assert.equal(profile.model.outputReserveTokens, 512);
  assert.equal(profile.features.imageInput, false);
  let modelRequest;
  t.mock.method(globalThis, 'fetch', async (url, init) => { modelRequest = { url, init }; return Response.json(models); });
  await listModels({ provider: 'magpie', customEndpoint: 'http://127.0.0.1:5000/v1' });
  assert.equal(modelRequest.init.headers.Authorization, undefined, 'another gateway must not receive the saved LAN key');
  await saveConfig({ customEndpoint: 'http://127.0.0.1:5000/v1' });
  assert.equal((await getConfig()).apiKey, '');
  assert.equal((await getConfig()).maxOutputTokens, undefined);
});

test('Magpie reuses OpenAI image input and streaming tool calls with the saved output limit', async t => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
  const config = { provider: 'magpie', endpoint: 'http://127.0.0.1:3425/v1/chat/completions',
    apiKey: '', model: 'account/vision', maxOutputTokens: 512, vision: true };
  const tool = { type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: {} } } };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Inspect this' }, image] }];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, config.endpoint);
    assert.equal(init.headers.Authorization, undefined);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'account/vision');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.messages[0].content[1].image_url.url, image.image_url.url);
    assert.equal(body.tools[0].function.name, 'inspect');
    const toolCall = { id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } };
    if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const options = { providerDefinition: getProviderDef(config), retry: { maxRetries: 0 } };
  const result = await chatOpenAi(messages, [tool], undefined, options, config);
  assert.equal(result.message.tool_calls[0].function.name, 'inspect');
  const events = [];
  for await (const event of chatStreamOpenAi(messages, [tool], undefined, options, config)) events.push(event);
  assert.equal(events.at(-1).message.tool_calls[0].function.name, 'inspect');
});


test('unknown gateway output limits leave the request and reserve unset while explicit limits survive', async t => {
  const requests = [];
  const config = { provider: 'magpie', endpoint: 'http://127.0.0.1:3425/v1/chat/completions',
    apiKey: '', model: 'gpt-6-astra', contextWindow: 8192, vision: false };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, config.endpoint, 'saved local models must not query a public directory');
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  });
  for (const modelParameters of [{}, { max_tokens: 512 }, { max_completion_tokens: 1024 }]) {
    const current = { ...config, modelParameters };
    const definition = getProviderDef(current);
    assert.equal(definition.outputTokenParam, undefined);
    const profile = await buildRunProfile({ config: current });
    assert.equal(profile.model.outputReserveTokens, modelParameters.max_tokens || modelParameters.max_completion_tokens || 0);
    await chatOpenAi([{ role: 'user', content: 'hello' }], [], undefined,
      { providerDefinition: definition, maxTokens: profile.model.maxOutputTokens, retry: { maxRetries: 0 } }, current);
    const sent = Object.fromEntries(Object.entries(requests.at(-1)).filter(([key]) => ['max_tokens', 'max_completion_tokens'].includes(key)));
    assert.deepEqual(sent, modelParameters);
  }
  assert.equal(requests.length, 3);
});

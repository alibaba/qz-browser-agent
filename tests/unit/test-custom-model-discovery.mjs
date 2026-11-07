import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderDef } from '../../src/background/llm/provider-catalog.js';
import { listProviderModels } from '../../src/background/llm/model-directory.js';
import { saveConfig, getConfig, listModels, applyModelPreset } from '../../src/background/llm/config.js';

for (const protocol of ['openai', 'anthropic']) for (const apiKey of ['', 'fixture-key']) {
  test(`custom ${protocol} model discovery ${apiKey ? 'sends its key' : 'omits authentication'}`, async t => {
    const definition = getProviderDef({ provider: 'custom', customProtocol: protocol, customEndpoint: 'http://localhost:8123/proxy/v1' });
    t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
      assert.equal(url, 'http://localhost:8123/proxy/v1/models');
      assert.equal(headers.Authorization, protocol === 'openai' && apiKey ? `Bearer ${apiKey}` : undefined);
      assert.equal(headers['x-api-key'], protocol === 'anthropic' && apiKey ? apiKey : undefined);
      if (protocol === 'anthropic') assert.equal(headers['anthropic-version'], '2023-06-01');
      return Response.json({ data: [{ id: 'local-model', display_name: 'Local Model' }] });
    });
    const result = await listProviderModels('custom', definition, apiKey);
    assert.equal(result.models[0].id, 'local-model');
    assert.equal(result.models[0].label, 'Local Model');
  });
}

test('custom discovery reports unavailable, malformed and unsupported routes without inventing a model list', async t => {
  const definition = getProviderDef({ provider: 'custom', customEndpoint: 'https://router.example/v1' });
  for (const response of [new Response('not found', { status: 404 }), new Response('not JSON')]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(listProviderModels('custom', definition, ''));
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not request an invented route'); });
  const unsupported = getProviderDef({ provider: 'custom', customEndpoint: 'https://router.example/custom/infer' });
  assert.equal(unsupported.modelsEndpoint, '');
  await assert.rejects(listProviderModels('custom', unsupported, ''));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listProviderModels('custom', definition, '', controller.signal), { name: 'AbortError' });
});

test('manual custom settings save offline and empty credentials stay empty across presets', async t => {
  const storage = { llmConfig: { providerApiKeys: { custom: 'legacy-key' } } };
  const priorChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async key => ({ [key]: storage[key] }),
    set: async values => Object.assign(storage, values),
  } } };
  t.after(() => { globalThis.chrome = priorChrome; });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('saving must not depend on discovery'); });
  const saved = await saveConfig({ provider: 'custom', customProtocol: 'anthropic',
    customEndpoint: 'http://localhost:8123/v1', model: 'manual-model', contextWindow: 32000, apiKey: '' });
  const localPresetId = saved.activePresetId;
  assert.equal(saved.apiKey, '');
  assert.equal(saved.providerApiKeys.custom, undefined);
  assert.equal((await getConfig()).apiKey, '');
  await saveConfig({ customEndpoint: 'https://other.example/v1', apiKey: 'other-key' });
  await saveConfig({ customEndpoint: 'https://third.example/v1' });
  assert.equal((await getConfig()).apiKey, '', 'changing endpoints must not carry another endpoint key');
  assert.equal((await applyModelPreset(localPresetId)).apiKey, '');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    requests++;
    assert.equal(url, 'http://localhost:8123/v1/models');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
    return Response.json({ data: [{ id: 'manual-model' }] });
  });
  assert.equal((await listModels({ customProtocol: undefined })).models[0].id, 'manual-model');
  await assert.rejects(listModels({ customEndpoint: '', apiKey: '' }));
  assert.equal(requests, 1, 'clearing the draft endpoint must not discover the previously saved endpoint');
});

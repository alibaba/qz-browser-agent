import assert from 'node:assert/strict';
import test from 'node:test';
import { chatOpenAi, chatStreamOpenAi } from '../../src/capabilities/provider-openai/adapter.js';

const limits = body => Object.fromEntries(Object.entries(body).filter(([key]) =>
  ['max_tokens', 'max_completion_tokens'].includes(key)));
const scenarios = [
  { name: 'Azure GPT deployment omits optional limits', model: 'gpt-6.1', endpoint: 'https://fixture.openai.azure.com/openai/v1/chat/completions', expected: {} },
  { name: 'opaque Azure deployment omits optional limits', model: 'deployment-2026', endpoint: 'https://fixture.openai.azure.com/openai/deployments/deployment-2026/chat/completions?api-version=2024-10-21', expected: {} },
  { name: 'OpenAI omits optional limits', model: 'gpt-6.1', endpoint: 'https://api.openai.com/v1/chat/completions', expected: {} },
  { name: 'compatible service uses its own default', expected: {} },
  { name: 'explicit completion limit adds no legacy parameter', modelParameters: { max_completion_tokens: 321 }, expected: { max_completion_tokens: 321 } },
  { name: 'explicit legacy limit remains supported', modelParameters: { max_tokens: 654 }, expected: { max_tokens: 654 } },
  { name: 'provider can require a token limit', providerDefinition: { outputTokenParam: 'max_tokens' }, expected: { max_tokens: 8192 } },
  { name: 'explicit model limit overrides provider default field', providerDefinition: { outputTokenParam: 'max_tokens' }, modelParameters: { max_completion_tokens: 321 }, expected: { max_completion_tokens: 321 } },
  { name: 'provider request defaults are retained', providerDefinition: { outputTokenParam: 'max_tokens', requestDefaults: { max_tokens: 2048 } }, expected: { max_tokens: 2048 } },
];

for (const stream of [false, true]) for (const scenario of scenarios) {
  test(`${stream ? 'stream' : 'chat'}: ${scenario.name}`, async t => {
    const config = { provider: 'custom', apiKey: 'fixture', model: scenario.model || 'compatible-model',
      endpoint: scenario.endpoint || 'https://provider.test/chat/completions',
      modelParameters: { temperature: 0.25, ...scenario.modelParameters } };
    const before = JSON.stringify(config);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, config.endpoint);
      const body = JSON.parse(init.body);
      requests.push(body);
      if (config.model === 'gpt-6.1' && Object.hasOwn(body, 'max_tokens')) {
        return Response.json({ error: { code: 'unsupported_parameter', param: 'max_tokens',
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, { status: 400 });
      }
      return stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    });
    const rawExchange = {};
    const options = { maxTokens: 8192, rawExchange, retry: { maxRetries: 0 }, providerDefinition: scenario.providerDefinition };
    if (stream) {
      const events = [];
      for await (const event of chatStreamOpenAi([{ role: 'user', content: 'hello' }], [], undefined, options, config)) events.push(event);
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.at(-1).message.content, 'ok');
    } else {
      const result = await chatOpenAi([{ role: 'user', content: 'hello' }], [], undefined, options, config);
      assert.equal(result.message.content, 'ok');
    }
    assert.equal(requests.length, 1, 'the first request is valid without compatibility retries');
    assert.deepEqual(limits(requests[0]), scenario.expected);
    assert.equal(requests[0].temperature, 0.25);
    assert.equal(requests[0].stream, stream);
    assert.deepEqual(JSON.parse(rawExchange.requestBody), requests[0]);
    assert.equal(JSON.stringify(config), before, 'saved configuration remains unchanged');
  });
}

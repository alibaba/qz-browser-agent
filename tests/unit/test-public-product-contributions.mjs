import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductSettings } from '../../src/products/public/sidepanel/settings.js';
import { createGitSkillPublisherService } from '../../src/products/public/background/git-publisher.js';
import { PRODUCT_GIT_PLATFORMS } from '../../src/products/public/shared/git-platforms.js';
import { getProductDefaultProvider } from '../../src/products/public/background/providers.js';
import { withLanguage } from '../../src/shared/i18n/index.js';

test('public default providers follow the resolved interface language', () => {
  for (const [language, provider] of [['zh-CN', 'deepseek'], ['zh-TW', 'deepseek'], ['en', 'openrouter'], ['ja', 'openrouter'], ['ar', 'openrouter']]) {
    assert.equal(withLanguage(language, getProductDefaultProvider), provider, language);
  }
});

test('public settings use the common form without mounting deployment-specific controls', async () => {
  const product = createProductSettings(new Proxy({}, { get: () => assert.fail('public settings do not access authentication or DOM services') }));
  assert.deepEqual(product.setupIntent(), { focusSetup: true, focusTarget: 'setup' });
  for (const focus of ['apiKey', 'model', 'customEndpoint', 'providerAuth']) {
    assert.deepEqual(product.setupIntent(focus), { focusSetup: true, focusTarget: focus }, 'repair actions preserve their target without replacing the configured provider');
  }
  assert.deepEqual(product.presentation('custom'), {});
  assert.equal(await product.connect(true), false);
  assert.equal(product.handleEvent({ type: 'unrelated' }), false);
  assert.equal(product.onboarding({ provider: 'custom' }), null);
});

test('a product without a publishing adapter cannot inspect or submit to a browser tab', async () => {
  const service = createGitSkillPublisherService(new Proxy({}, { get: () => assert.fail('no browser access without an adapter') }));
  assert.deepEqual(await service.inspect(), { available: false, reason: 'git_publish_unavailable' });
  await assert.rejects(service.publish({ target: { tabId: 1 } }), { code: 'GIT_PUBLISH_UNAVAILABLE' });
  assert.deepEqual(PRODUCT_GIT_PLATFORMS, []);
});

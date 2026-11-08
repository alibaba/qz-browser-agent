import { test, expect } from './fixtures.mjs';
import { exerciseQzSdk } from '../support/qz-sdk-workflow.mjs';

test('qz SDK coordinates strict locators, dynamic results and action lifetimes', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { launchIsolatedExtensionMcp } = await import('../support/isolated-extension-mcp.mjs');
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-sdk-', requestTimeoutSeconds: 90 });
  try {
    await exerciseQzSdk({ endpoint: environment.bridge.endpoint, context: environment.context,
      expect, step: test.step, testInfo });
  } finally { await environment.close(); }
});

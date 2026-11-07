import { test, expect } from './fixtures.mjs';
import { exerciseCliSkillDiscovery } from '../support/cli-skill-discovery-workflow.mjs';

test('CLI returns available user Skill summaries in every script receipt', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { launchIsolatedExtensionMcp } = await import('../support/isolated-extension-mcp.mjs');
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-skill-discovery-', requestTimeoutSeconds: 60 });
  try {
    await exerciseCliSkillDiscovery({ endpoint: environment.bridge.endpoint, page: environment.page,
      expect, step: test.step, testInfo });
  } finally { await environment.close(); }
});

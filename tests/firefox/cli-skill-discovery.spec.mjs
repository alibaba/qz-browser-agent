import { test, expect } from './fixture.mjs';
import { connectFirefoxCli } from '../support/firefox-isolated-cli.mjs';
import { exerciseCliSkillDiscovery } from '../support/cli-skill-discovery-workflow.mjs';

test('Firefox CLI returns available user Skill summaries in every script receipt', async ({ firefoxSidebar }, testInfo) => {
  test.setTimeout(180_000);
  const environment = await connectFirefoxCli(firefoxSidebar, { requireObserver: false });
  try { await exerciseCliSkillDiscovery({ ...environment, expect, step: test.step, testInfo }); }
  finally { await environment.close(); }
});

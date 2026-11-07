import { test, expect } from './fixture.mjs';
import { connectFirefoxCli } from '../support/firefox-isolated-cli.mjs';
import { exerciseQzSdk } from '../support/qz-sdk-workflow.mjs';

test('Firefox qz SDK coordinates strict locators, dynamic results and action lifetimes', async ({ firefoxSidebar }, testInfo) => {
  test.setTimeout(180_000);
  const environment = await connectFirefoxCli(firefoxSidebar, { requireObserver: false });
  try { await exerciseQzSdk({ ...environment, expect, step: test.step, testInfo }); }
  finally { await environment.close(); }
});

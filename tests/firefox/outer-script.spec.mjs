import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { openFirefoxSidebar } from './launch.mjs';
import { connectFirefoxCli } from '../support/firefox-isolated-cli.mjs';
import { exerciseOuterScripts } from '../support/outer-script-acceptance.mjs';

for (const mode of ['navigation', 'interleavings', 'skills', 'interruption']) test(mode === 'interruption' ? 'CLI interruption preserves the session and tabs for immediate continuation' : mode === 'skills' ? 'installed script Skills return business values and preserve legacy callers, traces and live/static cards' : mode === 'interleavings' ? 'Firefox outer script interleaved branches preserve lanes across navigation and caught errors'
  : 'Firefox outer script coordinates actual navigation, AJAX, queues and popup cancellation', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const extensionDir=testInfo.outputPath('extension');
  await mkdir(extensionDir,{recursive:true});
  await cp(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR,extensionDir,{recursive:true});
  await cp(new URL('../fixtures/outer-script-probe.mjs',import.meta.url),join(extensionDir,'sidepanel/outer-script-probe.js'));
  const html=join(extensionDir,'sidepanel/sidepanel.html');
  const original=await readFile(html,'utf8');
  const instrumented=original.replace(/<script\b[^>]*\bsrc=["'](?:sidepanel|firefox-boot)\.js["'][^>]*>/,
    tag=>'<script type="module" src="outer-script-probe.js"></script>'+tag);
  expect(instrumented).not.toBe(original);
  await writeFile(html,instrumented);
  const firefoxSidebar=await openFirefoxSidebar({extensionDir});
  let environment;
  try { environment=await connectFirefoxCli(firefoxSidebar); await exerciseOuterScripts({ ...environment, expect, step: test.step, testInfo, interleavings: mode === 'interleavings', skillScripts: mode === 'skills', interruption: mode === 'interruption' }); }
  finally { await environment?.close(); await firefoxSidebar.close(); }
});

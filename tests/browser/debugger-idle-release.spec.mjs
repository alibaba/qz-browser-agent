import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { callTool, readHealth } from '../../services/mcp-bridge/src/client.mjs';
import { startElementReferencePage } from '../support/element-reference-page.mjs';
import { startOuterScriptPage } from '../support/outer-script-page.mjs';
import { expect, test } from './fixtures.mjs';

const idleWindow = 2700;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(fixture, exposeRuntime = false) {
  const { launchIsolatedExtensionMcp, EXTENSION_PATH } = await import('../support/isolated-extension-mcp.mjs');
  let directory, environment;
  try {
    let extensionDir = EXTENSION_PATH;
    if (exposeRuntime) {
      directory = await mkdtemp(join(tmpdir(), 'qz-idle-package-'));
      extensionDir = join(directory, 'extension');
      await cp(EXTENSION_PATH, extensionDir, { recursive: true });
      const manifestPath = join(extensionDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(join(extensionDir, 'idle-test-worker.js'), `import './${manifest.background.service_worker}';
        import * as tools from './background/tools/runtime.js'; globalThis.idleTestTools = tools;`);
      manifest.background.service_worker = 'idle-test-worker.js';
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-debugger-idle-', extensionDir });
    const endpoint = environment.bridge.endpoint;
    const worker = environment.context.serviceWorkers()[0];
    const { sessionId } = await callTool(endpoint, 'qingzhou_create_drive_session', { title: 'Debugger idle release' });
    const script = async (code, input = {}, ok = true) => {
      const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
      const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
      const exitCode = await main(['script', '--session', sessionId, '--json', '--timeout', '30', '--args', JSON.stringify(input), '-'], {
        stdout, stderr, readStdin: async () => code,
        findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
      });
      expect(exitCode, `${stdout.text}\n${stderr.text}`).toBe(ok ? 0 : 1);
      const receipt = JSON.parse(stdout.text);
      expect(receipt.ok, stdout.text).toBe(ok);
      return receipt.result;
    };
    // getTargets().attached also sees Playwright. A raw extension command probes
    // this extension's physical connection without acquiring or extending its lease.
    const attached = tabId => worker.evaluate(async tabId => {
      try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.getIsolateId'); return true; }
      catch (error) { if (/not attached/i.test(String(error))) return false; throw error; }
    }, tabId);
    const detached = tabId => expect.poll(() => attached(tabId), { timeout: 7000 }).toBe(false);
    const open = async (tabAlias, url, options = {}) => {
      const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
      const result = await script(`const tab = await tools.open_tab(input);
        await tools.wait_for_load({tabRef:tab.tabRef,timeout:10}); return tab;`, { tabAlias, url, ...options });
      expect(result.tabRef).toBe(tabAlias);
      const created = await worker.evaluate(async before => (await chrome.tabs.query({})).filter(tab => !before.includes(tab.id)), before);
      expect(created).toHaveLength(1);
      await expect.poll(() => environment.context.pages().some(page => page.url() === url)).toBe(true);
      return { id: created[0].id, page: environment.context.pages().find(page => page.url() === url) };
    };
    return { environment, endpoint, sessionId, worker, script, attached, detached, open,
      async close() {
        await environment.close();
        await fixture.close();
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await environment?.close();
    await fixture.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('CLI and ordinary tools release idle connections and reuse same-document UIDs including child frames', async () => {
  test.setTimeout(120_000);
  const fixture = await startElementReferencePage();
  const h = await harness(fixture, true);
  try {
    const tab = await h.open('page', fixture.url);
    await tab.page.frameLocator('#cross').locator('#frame-action').waitFor();
    const observed = await h.script(`return {
      elements:await tools.find_elements({tabRef:'page',target:'css:body',tags:['button'],limit:40}),
      tree:await tools.get_ax_tree({tabRef:'page',scope:'full',depth:12,limit:100})
    };`);
    const alpha = observed.elements.results.find(element => element.text === 'Alpha' || element.name === 'Alpha').target;
    const frameTargets = ['same', 'cross'].map(kind => observed.tree.snapshot.split('\n')
      .find(line => line.includes(' button ') && line.includes(`"Frame ${kind}"`))?.match(/target=(uid:\S+)/)?.[1]);
    for (const target of [alpha, ...frameTargets]) expect(target).toMatch(/^uid:t\d+\.[0-9a-z]{6}\.\d+$/);
    expect(await h.attached(tab.id)).toBe(true);
    await h.detached(tab.id);
    await h.script(`for (const target of input.targets) await tools.act_on_element({tabRef:'page',target,action:'click'});
      return await tools.list_tabs({});`, { targets: [alpha, ...frameTargets] });
    await expect(tab.page.locator('#alpha')).toHaveAttribute('data-clicked', 'yes');
    for (const kind of ['same', 'cross']) await expect(tab.page.frameLocator(`#${kind}`).locator('body')).toHaveAttribute('data-clicked', 'yes');
    await h.detached(tab.id);
    await h.script(`await tools.navigate({tabRef:'page',url:input.url});
      await tools.wait_for_load({tabRef:'page',timeout:10});`, { url: `${fixture.url}?replacement=1` });
    const stale = await h.script(`return await tools.act_on_element({tabRef:'page',target:input.target,action:'click'});`, { target: alpha }, false);
    expect(stale.code).toMatch(/^STALE_ELEMENT_UID/);

    // The native Agent entry uses the same tool runtime, with its Session authority supplied by the host.
    const ordinary = await h.worker.evaluate(async url => {
      const tab = await chrome.tabs.create({ url, active: false });
      const runtime = idleTestTools.createToolRuntime({ sessions: {
        isRunCurrent: () => true, listOwnedTabIds: () => [tab.id],
        resolveTargetTab: async ({ tabId }) => ({ ok: tabId === tab.id, tabId, ownedByCurrentTask: true }),
        updateWorkingTab: async () => {},
      } });
      const context = { sessionId: 'ordinary-idle', runId: 'ordinary-run', source: 'agent' };
      globalThis.idleNative = { tabId: tab.id, runtime, context };
      await runtime.execute('wait_for_load', { tabRef: tab.id }, undefined, context);
      const result = await runtime.execute('find_elements', { tabRef: tab.id, target: 'css:body', tags: ['button'] }, undefined, context);
      return { tabId: tab.id, target: result.results.find(element => element.text === 'Alpha').target };
    }, fixture.url);
    await h.detached(ordinary.tabId);
    await h.worker.evaluate(async target => {
      const { runtime, context, tabId } = idleNative;
      await runtime.execute('act_on_element', { tabRef: tabId, target, action: 'click' }, undefined, context);
    }, ordinary.target);
    const clicked = await h.worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId },
      func: () => document.querySelector('#alpha').dataset.clicked }))[0].result, ordinary.tabId);
    expect(clicked).toBe('yes');
    await h.detached(ordinary.tabId);
  } finally { await h.close(); }
});

test('outer script holds connections across concurrent waits and JavaScript gaps, then releases them', async () => {
  test.setTimeout(90_000);
  const fixture = await startOuterScriptPage();
  const h = await harness(fixture);
  try {
    const main = await h.open('main', `${fixture.origin}/main`);
    const other = await h.open('other', `${fixture.origin}/other`);
    const running = h.script(`await tools.evaluate({tabRef:'main',code:()=>{document.body.dataset.started='yes';}});
      return await Promise.all([
        tools.evaluate({tabRef:'other',code:async()=>{await fetch('/hold?lane=idle'); return 'released';}}),
        tools.wait_for_element({tabRef:'main',target:'css:#late-ready',timeout:15}),
        (async()=>{await new Promise(resolve=>setTimeout(resolve,7000)); return 'outer-gap';})()
      ]);`);
    let scriptFailure;
    void running.catch(error => { scriptFailure = error; });
    try {
      await expect.poll(() => {
        if (scriptFailure) throw scriptFailure;
        return fixture.pending('idle');
      }, { timeout: 15_000 }).toBe(1);
      await expect(main.page.locator('body')).toHaveAttribute('data-started', 'yes');
      await main.page.evaluate(() => { const node = document.createElement('button'); node.id = 'late-ready'; node.textContent = 'Ready'; document.body.append(node); });
      fixture.release('idle');
      // Both page calls can finish; the outer script's remaining JavaScript still owns its scope.
      await pause(idleWindow);
      expect(await h.attached(main.id)).toBe(true);
      expect(await h.attached(other.id)).toBe(true);
      const result = await running;
      expect(result[0]).toBe('released');
      expect(result[1].found).toBe(true);
      expect(result[2]).toBe('outer-gap');
    } finally { fixture.release('idle'); }
    await Promise.all([h.detached(main.id), h.detached(other.id)]);
  } finally { await h.close(); }
});

test('mobile mode and network watches retain their connection until explicitly released', async () => {
  test.setTimeout(120_000);
  const fixture = await startOuterScriptPage();
  const h = await harness(fixture, true);
  try {
    const mobile = await h.open('mobile', `${fixture.origin}/mobile`, { mode: 'mobile', watchNetwork: true });
    const watched = await h.open('watched', `${fixture.origin}/watched`, { watchNetwork: true });
    await pause(idleWindow);
    expect(await h.attached(mobile.id)).toBe(true);
    expect(await mobile.page.evaluate(() => navigator.maxTouchPoints)).toBe(5);
    expect(await h.attached(watched.id)).toBe(true);
    await watched.page.evaluate(() => fetch('/api/more').then(response => response.text()));
    const body = await h.script(`const recent = await tools.network_recent({tabRef:'watched',urlPattern:'/api/more'});
      return await tools.network_body({tabRef:'watched',requestId:recent.results[0].requestId});`);
    expect(JSON.parse(body.body)).toEqual([{ name: 'first' }, { name: 'second' }]);
    expect(await h.script(`return await tools.network_watch({tabRef:'watched',enabled:false});`)).toMatchObject({ watching: false });
    await h.detached(watched.id);
    expect(await h.attached(mobile.id)).toBe(true);
    await h.script(`return await tools.set_page_mode({tabRef:'mobile',mode:'desktop'});`);
    expect(await mobile.page.evaluate(() => navigator.maxTouchPoints)).toBe(0);
    await pause(idleWindow);
    expect(await h.attached(mobile.id), 'ending mobile mode must preserve the same tab\'s network watch').toBe(true);
    await h.script(`return await tools.network_watch({tabRef:'mobile',enabled:false});`);
    await h.detached(mobile.id);

    await h.script(`return await tools.network_watch({tabRef:'watched'});`);
    await pause(idleWindow);
    expect(await h.attached(watched.id)).toBe(true);
    await h.script(`return await tools.network_watch({tabRef:'watched',enabled:false});`);
    await h.detached(watched.id);
    const response = await h.script(`return await tools.wait_for_response({tabRef:'watched',urlPattern:'/api/more',timeout:10,
      trigger:{name:'act_on_element',args:{tabRef:'watched',target:'css:#more',action:'click'}}});`);
    expect(response.matched).toBe(true);
    await h.detached(watched.id);

    await watched.page.evaluate(() => console.log('idle-console-one'));
    const first = await h.script(`return await tools.read_console_messages({tabRef:'watched',textPattern:'idle-console-'});`);
    expect(first.results.map(row => row.text)).toEqual(['idle-console-one']);
    await h.detached(watched.id);
    await watched.page.evaluate(() => console.log('idle-console-two'));
    const second = await h.script(`return await tools.read_console_messages({tabRef:'watched',textPattern:'idle-console-'});`);
    expect(second.results.map(row => row.text).sort()).toEqual(['idle-console-one', 'idle-console-two']);
    await h.detached(watched.id);

    await h.script(`await tools.set_page_mode({tabRef:'mobile',mode:'mobile'});
      return await tools.network_watch({tabRef:'mobile'});`);
    const documentToken = await mobile.page.evaluate(() => document.body.dataset.documentToken);
    await h.worker.evaluate(sessionId => idleTestTools.releaseSessionCdp(sessionId), h.sessionId);
    expect(await h.attached(mobile.id)).toBe(false);
    expect(await h.script(`return await tools.network_watch({tabRef:'mobile',enabled:false});`)).toMatchObject({ watching: false });
    expect(await h.attached(mobile.id), 'stopping a disconnected watch must not restore mobile emulation').toBe(false);
    expect(await mobile.page.evaluate(() => document.body.dataset.documentToken)).toBe(documentToken);
    expect(await mobile.page.evaluate(() => navigator.maxTouchPoints)).toBe(0);
  } finally { await h.close(); }
});

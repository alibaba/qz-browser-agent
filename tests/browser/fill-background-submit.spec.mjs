import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { ensureTestExtension } from '../support/extension-build.mjs';

// Playwright's default focus emulation makes every background document visible.
// Connect with noDefaults so Chrome retains real visibility and input focus.
async function launchNativeExtension(directory, extension) {
  const profile = join(directory, 'profile');
  const child = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, ...(process.env.QINGZHOU_TEST_HEADED === '1' || process.env.DISPLAY ? [] : ['--headless=new']), '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: 'ignore' });
  let connection;
  const close = async () => {
    await connection?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  };
  try {
    let port;
    const deadline = Date.now() + 15000;
    while (!port) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Chrome did not start');
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
      if (!port) await delay(50);
    }
    connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = connection.contexts()[0];
    const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/qa-worker.js'))
      || await context.waitForEvent('serviceworker', worker => worker.url().endsWith('/qa-worker.js'));
    return { close, worker };
  } catch (error) { await close(); throw error; }
}

// The QA pages can be supplied for the before/after comparison. The default is
// an equivalent local form; no public pages or model providers are involved.
for (const pageName of ['keylog.html', 'form.html']) {
  for (const foreground of [false, true]) {
    test(`fill submits ${pageName} in a ${foreground ? 'foreground' : 'hidden'} tab`, async () => {
      test.setTimeout(90_000);
      const requests = [];
      const server = createServer(async (req, res) => {
        requests.push(decodeURIComponent(req.url));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const path = new URL(req.url, 'http://local.test').pathname;
        if (process.env.QZ_QA_PAGE_DIR && [ '/keylog.html', '/form.html', '/fast.html' ].includes(path)) {
          res.end(await readFile(join(process.env.QZ_QA_PAGE_DIR, path.slice(1))));
        } else if (path === '/fast.html') res.end('<!doctype html><title>Submitted</title>');
        else res.end(`<!doctype html><meta charset="utf-8"><title>Local search</title>
          <form action="/fast.html"><input id="q" name="q" type="search"><button>Go</button></form>`);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const directory = await mkdtemp(join(tmpdir(), 'qz-fill-background-'));
      let browser;
      try {
        const extension = join(directory, 'extension');
        await cp(await ensureTestExtension(), extension, { recursive: true });
        const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
        await writeFile(join(extension, 'qa-worker.js'), `import './${manifest.background.service_worker}';
          import { createToolRuntime } from './background/tools/runtime.js';
          globalThis.qaCreateRuntime = createToolRuntime;`);
        manifest.background.service_worker = 'qa-worker.js';
        await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
        browser = await launchNativeExtension(directory, extension);
        const worker = browser.worker;
        await expect.poll(() => worker.evaluate(() => typeof globalThis.qaCreateRuntime), { timeout: 30000 }).toBe('function');
        const base = `http://127.0.0.1:${server.address().port}`;
        await worker.evaluate(async base => {
          await chrome.tabs.create({ url: `${base}/cover`, active: true });
          let tabId;
          const runtime = qaCreateRuntime({
            windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
            sessions: {
              isRunCurrent: () => true,
              resolveTargetTab: async input => input.tabId === tabId
                ? { ok: true, tabId, tab: await chrome.tabs.get(tabId), ownedByCurrentTask: true }
                : { ok: false, code: 'SESSION_TAB_FOREIGN' },
              updateWorkingTab: async ({ tab }) => { tabId = tab.id; },
            },
          });
          globalThis.qa = {
            call: (name, args) => runtime.execute(name, args, undefined, {
              sessionId: 'qa-fill', runId: 'run', workingTabId: tabId,
              runProfile: { platform: { os: 'linux' } },
            }),
            activate: () => chrome.tabs.update(tabId, { active: true }),
            async page(func) {
              return (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func }))[0].result;
            },
          };
        }, base);
        await worker.evaluate(url => qa.call('open_tab', { url }), `${base}/${pageName}`);
        if (foreground) await worker.evaluate(() => qa.activate());
        await expect.poll(() => worker.evaluate(() => qa.page(() => document.readyState))).toBe('complete');
        const before = await worker.evaluate(() => qa.page(() => {
          sessionStorage.qaEvents = '[]';
          for (const type of ['focus', 'input', 'keydown', 'keypress', 'submit']) {
            document.addEventListener(type, event => {
              const entries = JSON.parse(sessionStorage.qaEvents);
              entries.push({ type, key: event.key || '', trusted: event.isTrusted, visibility: document.visibilityState });
              sessionStorage.qaEvents = JSON.stringify(entries);
            }, true);
          }
          return { visibility: document.visibilityState, focus: document.hasFocus() };
        }));
        expect(before.visibility).toBe(foreground ? 'visible' : 'hidden');
        const result = await worker.evaluate(() => qa.call('act_on_element', {
          target: 'css:#q', action: 'fill', value: '灵隐寺', submit: true,
        }));
        const after = await worker.evaluate(() => qa.page(() => ({
          events: JSON.parse(sessionStorage.qaEvents), url: location.href, visibility: document.visibilityState,
        })));
        console.log('QA_FILL', JSON.stringify({ pageName, foreground, before, result, after, requests }));
        expect(result).toMatchObject({ filled: true, submitDispatched: true, navigated: true });
        expect(after.url).toContain('/fast.html?q=');
        for (const type of ['input', 'keydown', 'keypress', 'submit']) {
          expect(after.events.filter(event => event.type === type)).toEqual([
            expect.objectContaining({ trusted: true, visibility: foreground ? 'visible' : 'hidden' }),
          ]);
        }
        expect(requests.filter(path => path.startsWith('/fast.html?'))).toHaveLength(1);
      } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
}

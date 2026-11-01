import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildExtension } from '../../scripts/build-extension.mjs';
import { acceptDataDisclosure } from '../support/data-consent.mjs';
import { expect, test } from './fixtures.mjs';

const cases = [
  { name: 'original eat fill-submit', path: '/eat.html', requests: 1, navigated: true },
  { name: 'same-document submit', path: '/same.html', requests: 1, navigated: false },
  { name: 'keydown-only capture', path: '/keys.html', requests: 1, navigated: true },
  { name: 'off=1 control', path: '/eat.html?off=1', requests: 1, navigated: true },
  { name: 'prevented Enter is still delivered', path: '/prevent.html', requests: 0, navigated: false },
  { name: 'value changes without input event', path: '/value.html', requests: 0, navigated: false, value: 'changed' },
  { name: 'click submit', path: '/eat.html', action: 'click', target: '#go', requests: 1, navigated: true },
  { name: 'deferred same-document click submit', path: '/delayed.html', action: 'click', target: '#go', requests: 1, navigated: false },
  { name: 'click navigation with no observable DOM events', path: '/blind.html', action: 'click', target: '#link', requests: 1, navigated: true },
  { name: 'ordinary swallowed click remains a miss', path: '/eat.html', action: 'click', target: '#b', requests: 0, missed: true },
  { name: 'physically undelivered click remains a miss', path: '/eat.html?off=1', action: 'click', target: '#b', requests: 0, missed: true, drop: true },
  { name: 'press Enter after a normal focus click', path: '/keys.html', action: 'press', requests: 1, navigated: true },
  { name: 'capture-stopped link navigates once', path: '/capture-link.html', action: 'click', target: '#link', requests: 1, navigated: true },
];

test('input delivery follows submitted forms without replaying input', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'qz-input-delivery-'));
  const requests = [], plans = new Map(), evidence = [];
  const eat = await readFile(new URL('../fixtures/input-delivery/eat.html', import.meta.url), 'utf8');
  let base, browser, child, panel, worker;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body).messages;
      const marker = [...messages].reverse().find(message => message.role === 'user')?.content;
      const next = plans.get(marker)?.shift();
      const delta = next ? { role: 'assistant', tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function',
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: 'assistant', content: 'done' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, next ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
      return;
    }
    requests.push(decodeURIComponent(req.url));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/fast.html') {
      // Make the old-document receipt window deterministic without altering input.
      await delay(350);
      res.end('<!doctype html><title>Submitted</title>');
      return;
    }
    let html = eat;
    if (url.pathname === '/keys.html') html = html.replace("['pointerdown','mousedown','touchstart','click','keydown']", "['keydown']");
    if (url.pathname === '/prevent.html') html = html.replace('e.stopImmediatePropagation();', "e.stopImmediatePropagation();if(e.type==='keydown')e.preventDefault();");
    if (url.pathname === '/value.html') html = html.replace('e.stopImmediatePropagation();', "e.stopImmediatePropagation();if(e.type==='keydown'){e.preventDefault();e.target.value='changed';}");
    if (url.pathname === '/same.html') html += `<script>f.addEventListener('submit',e=>{e.preventDefault();fetch('/submitted?'+new URLSearchParams(new FormData(f)))})</script>`;
    // A microtask stays within the observation window; hidden-tab timer clamping does not.
    if (url.pathname === '/delayed.html') html = `<script>window.addEventListener('click',e=>{if(e.target.id==='go'){e.preventDefault();queueMicrotask(()=>f.requestSubmit())}},true)</script>` + html
      + `<script>f.addEventListener('submit',e=>{e.preventDefault();fetch('/submitted?'+new URLSearchParams(new FormData(f)))})</script>`;
    if (url.pathname === '/blind.html') html += `<a id="link" href="/fast.html?q=link">Next</a><script>for(const t of ['submit','beforeunload','pagehide'])window.addEventListener(t,e=>e.stopImmediatePropagation(),true)</script>`;
    if (url.pathname === '/capture-link.html') html = `<!doctype html><title>Capture link</title><a id="link" href="/fast.html?q=capture">Next</a><script>for(const type of ['pointerdown','mousedown','touchstart','click'])window.addEventListener(type,event=>event.stopImmediatePropagation(),true)</script>`;
    res.end(html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const { outputDir } = await buildExtension({ mode: 'production', outputDir: join(directory, 'extension') });
    const profile = join(directory, 'profile');
    child = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`, '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${outputDir}`, `--load-extension=${outputDir}`, 'about:blank',
    ], { stdio: 'ignore' });
    let port;
    await expect.poll(async () => {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
      return Boolean(port);
    }, { timeout: 15000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    worker = context.serviceWorkers().find(item => item.url().includes('ghbaodmonhcgkfeejcpffknlggbjhjgj'))
      || await context.waitForEvent('serviceworker', item => item.url().includes('ghbaodmonhcgkfeejcpffknlggbjhjgj'));
    panel = await context.newPage();
    await panel.goto('chrome-extension://ghbaodmonhcgkfeejcpffknlggbjhjgj/sidepanel/sidepanel.html');
    await acceptDataDisclosure(panel);
    await panel.waitForFunction(() => !document.querySelector('#app')?.hasAttribute('data-workspace-booting'));
    await panel.evaluate(() => {
      const events = [], port = chrome.runtime.connect({ name: 'sidepanel' });
      port.onMessage.addListener(message => {
        if (message.type === 'dynamic_context_request') port.postMessage({ type: 'dynamic_context_response', requestId: message.requestId, context: {} });
        events.push(message);
      });
      globalThis.inputTest = { events, request(type, payload, responseType) {
        return new Promise((resolve, reject) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => { port.onMessage.removeListener(listener); reject(new Error(`${type} timed out`)); }, 15000);
          const listener = message => {
            if (message.requestId !== requestId || ![responseType, 'error', 'request_failed'].includes(message.type)) return;
            clearTimeout(timer); port.onMessage.removeListener(listener); resolve(message);
          };
          port.onMessage.addListener(listener); port.postMessage({ type, ...payload, requestId });
        });
      }, prompt(sessionId, text) { port.postMessage({ type: 'prompt', sessionId, text, clientMessageId: crypto.randomUUID() }); } };
    });
    const request = (type, payload, responseType) => panel.evaluate(args => inputTest.request(...args), [type, payload, responseType]);
    await request('save_config', { config: { provider: 'custom', customProtocol: 'openai', customEndpoint: `${base}/v1/chat/completions`,
      apiKey: 'local-fixture', model: 'local-fixture', contextWindow: 128000, vision: false, debugMode: false } }, 'config_saved');
    await worker.evaluate(() => {
      const send = chrome.debugger.sendCommand.bind(chrome.debugger);
      globalThis.inputCommands = [];
      chrome.debugger.sendCommand = (target, method, params) => {
        if (method.startsWith('Input.')) inputCommands.push({ method, params });
        return globalThis.dropPointer && method === 'Input.dispatchMouseEvent' ? Promise.resolve({}) : send(target, method, params);
      };
    });
    for (const scenario of cases) await test.step(scenario.name, async () => {
      const start = requests.length;
      await worker.evaluate(drop => { globalThis.dropPointer = drop; inputCommands.length = 0; }, Boolean(scenario.drop));
      const plan = [{ name: 'open_tab', args: { url: base + scenario.path, tabAlias: 'fixture' } }];
      if (scenario.action === 'press') plan.push({ name: 'act_on_element', args: { tabRef: 'fixture', target: 'css:#q', action: 'fill', value: 'once' } });
      plan.push({ name: 'act_on_element', args: { tabRef: 'fixture', target: `css:${scenario.target || '#q'}`,
        ...(scenario.action ? { action: scenario.action, ...(scenario.action === 'press' ? { key: 'Enter' } : {}) } : { action: 'fill', value: 'once', submit: true }) } });
      plans.set(scenario.name, plan);
      const created = await request('create_ui_session', { title: scenario.name, firstMessage: '' }, 'create_ui_session_result');
      const sessionId = created.session.id;
      await panel.evaluate(({ sessionId, text }) => inputTest.prompt(sessionId, text), { sessionId, text: scenario.name });
      await expect.poll(() => panel.evaluate(id => inputTest.events.some(event => event.sessionId === id && event.type === 'agent_end'), sessionId), { timeout: 20000 }).toBe(true);
      await delay(450);
      const events = await panel.evaluate(id => inputTest.events.filter(event => event.sessionId === id && event.type === 'tool_execution_end'), sessionId);
      const result = events.filter(event => event.toolName === 'act_on_element').at(-1)?.result;
      const tabId = events.find(event => event.toolName === 'open_tab')?.result.id;
      const page = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN',
        func: () => ({ url: location.href, out: document.querySelector('#out')?.textContent, value: document.querySelector('#q')?.value }) }))[0].result, tabId);
      const commands = await worker.evaluate(() => inputCommands);
      const submitted = requests.slice(start).filter(path => /^\/(fast.html|submitted)\?/.test(path));
      const sample = { scenario, result, page, commands, submitted };
      evidence.push(sample);
      const label = JSON.stringify(sample);
      expect.soft(submitted, label).toHaveLength(scenario.requests);
      expect.soft(result?.code, label).toBe(scenario.missed ? 'INPUT_NOT_DELIVERED' : undefined);
      if (scenario.missed) expect.soft(page.out, label).toBe('none');
      else {
        expect.soft(result?.navigated, label).toBe(scenario.navigated);
        if (!scenario.action) expect.soft(result?.submitDispatched, label).toBe(true);
        if (scenario.value) expect.soft(page.value, label).toBe(scenario.value);
      }
      const downs = commands.filter(command => command.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyDown' && command.params.key === 'Enter');
      expect.soft(downs, label).toHaveLength(!scenario.action || scenario.action === 'press' ? 1 : 0);
    });
  } finally {
    await testInfo.attach('input-delivery.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await browser?.close();
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

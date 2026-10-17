import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { installBenchmarkChromeStub } from './benchmark-chrome-stub.mjs';
import { ensureTestExtension } from '../support/extension-build.mjs';

const config = { provider: 'custom', model: 'fixture-model', apiKey: 'test-key', customEndpoint: 'https://example.test/v1/chat/completions', contextWindow: 128000, vision: false };
const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru', 'ar', 'hi'];
const output = resolve('tests/results/cli-connection-ui');
function installConnectionReplies(initial = {}) {
  window.cliFixture = {
    status: { state: 'disconnected', name: '', clientId: 'fixture-client', endpoint: 'http://127.0.0.1:18765', retryCount: 0, retryLimit: 3, ...initial },
    calls: [], pending: [], nextError: null, defer: false, copied: '',
    emit(status) { this.status = { ...this.status, ...status };window.__qzEmitPortMessage({ type: 'mcp_connection_status_changed', status: this.status }); },
    reply(message, result) { window.__qzEmitPortMessage({ type: 'mcp_connection_status', requestId: message.requestId, ok: true, result }); },
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.cliFixture.copied = text; } } });
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args), post = port.postMessage;
    port.postMessage = message => {
      if (!message.type.startsWith('mcp_connection_')) return post(message);
      const f = window.cliFixture;f.calls.push(message);
      if (f.defer) { f.pending.push(message);return; }
      if (message.type === 'mcp_connection_connect') {
        f.status = { ...f.status, name: message.name || 'default', endpoint: message.endpoint, state: f.nextError ? 'paused' : 'connected', lastError: f.nextError ? { code: f.nextError, message: 'English backend diagnostic' } : undefined };
        f.emit(f.status);
      } else if (message.type === 'mcp_connection_disconnect') f.emit({ state: 'disconnected', lastError: undefined });
      queueMicrotask(() => f.reply(message, f.status));
    };
    return port;
  };
}
async function mount(page, language = 'en', initial = {}) {
  const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${language.replace('-', '_')}/messages.json`), 'utf8'));
  await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages: messages, config });
  await page.addInitScript(installConnectionReplies, initial);
  await page.goto('/extension/sidepanel/sidepanel.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  await page.locator('#btn-settings').click();await page.locator('#settings-tab-advanced').click();
  await expect(page.locator('#cli-toggle')).toBeEnabled();
}

test.describe('CLI settings actions', () => {
  test.use({ viewport: { width: 360, height: 900 } });
  test('access exceptions explain themselves only while configuring an allow rule', async ({ page }) => {
    await mount(page);
    const hint = page.locator('#guardrail-allow-hint');
    const action = page.locator('#guardrail-rule-action');
    await expect(action).toHaveValue('block');await expect(hint).toBeHidden();
    await action.selectOption('allow');await expect(hint).toBeVisible();
    await action.selectOption('rate_limit');await expect(hint).toBeHidden();
    await action.selectOption('allow');await expect(hint).toBeVisible();
    await action.selectOption('block');await expect(hint).toBeHidden();
  });
  test('opening is local read-only; connection and disconnect act independently of Save', async ({ page }) => {
    await mount(page);
    expect(await page.evaluate(() => window.cliFixture.calls.map(x => x.type))).toEqual(['mcp_connection_status']);
    const saveDisabled = await page.locator('#btn-save-settings').isDisabled();
    await page.locator('#cli-toggle').click();
    await expect(page.locator('#cli-name')).toBeFocused();
    await expect(page.locator('#cli-name-label')).toHaveText('Browser identifier');
    await expect(page.locator('#cli-name')).toHaveAttribute('placeholder', 'Use in CLI, e.g. work');
    await expect(page.locator('#cli-name-example, #cli-name-hint')).toHaveCount(0);
    await page.locator('#cli-name').fill('work');await page.locator('#cli-submit').click();
    await expect(page.locator('#cli-toggle')).toHaveText('Disconnect: work');
    await expect(page.locator('#cli-connect-popover')).not.toBeVisible();
    await expect(page.locator('#cli-toggle')).toBeFocused();
    expect(await page.locator('#btn-save-settings').isDisabled()).toBe(saveDisabled);
    await page.locator('#cli-toggle').click();await expect(page.locator('#cli-toggle')).toHaveText('Connect CLI');
    expect(await page.evaluate(() => window.cliFixture.calls.map(x => x.type))).toEqual(['mcp_connection_status', 'mcp_connection_connect', 'mcp_connection_disconnect']);
    expect(await page.evaluate(() => window.cliFixture.status.name)).toBe('work');
  });
  test('unavailable service and name conflict preserve drafts and copy the selected port command', async ({ page }) => {
    await mount(page);await page.evaluate(() => { window.cliFixture.nextError = 'MCP_CONNECTION_UNAVAILABLE'; });
    await page.locator('#cli-toggle').click();await page.locator('#cli-name').fill('work');
    await page.locator('#cli-address-details summary').click();await page.locator('#cli-address').fill('http://127.0.0.1:18766');
    await page.locator('#cli-address-details summary').click();
    await expect(page.locator('#cli-address-details')).not.toHaveAttribute('open', '');
    await page.locator('#cli-submit').click();await expect(page.locator('#cli-submit')).toBeEnabled();
    await expect(page.locator('#cli-popover-status')).toHaveText('CLI service unavailable. Check the local service address shown in your terminal.');
    await expect(page.locator('#cli-popover-status')).toBeVisible();await expect(page.locator('#cli-status')).toBeHidden();
    await expect(page.locator('#cli-address-details')).toHaveAttribute('open', '');
    await expect(page.locator('#cli-name')).toHaveValue('work');await expect(page.locator('#cli-address')).toHaveValue('http://127.0.0.1:18766');
    await expect(page.locator('#cli-start-command')).toHaveText('npx --yes qz-browser-agent@latest connect --port 18766');
    await page.locator('#cli-copy').click();expect(await page.evaluate(() => window.cliFixture.copied)).toBe('npx --yes qz-browser-agent@latest connect --port 18766');
    const commandLayout = await page.evaluate(() => {
      const command = document.querySelector('#cli-start-command').getBoundingClientRect();
      const copy = document.querySelector('#cli-copy').getBoundingClientRect();
      const group = document.querySelector('#cli-start').getBoundingClientRect();
      return { commandTop: command.top, copyBottom: copy.bottom, commandWidth: command.width, groupWidth: group.width };
    });
    expect(commandLayout.commandTop).toBeGreaterThanOrEqual(commandLayout.copyBottom);
    expect(commandLayout.commandWidth).toBeGreaterThanOrEqual(commandLayout.groupWidth - 1);
    await page.locator('#cli-address-details summary').click();
    await page.locator('#cli-name').fill('work-2');
    await expect(page.locator('#cli-address-details')).not.toHaveAttribute('open', '');
    await page.locator('#cli-cancel').click();
    await expect(page.locator('#cli-status')).toBeVisible();await expect(page.locator('#cli-popover-status')).toBeHidden();
    await expect(page.locator('#cli-status')).toHaveText('CLI service unavailable. Check the local service address shown in your terminal.');
    await page.locator('#cli-toggle').click();
    await expect(page.locator('#cli-status')).toBeHidden();await expect(page.locator('#cli-popover-status')).toBeVisible();
    await expect(page.locator('#cli-address-details')).not.toHaveAttribute('open', '');
    await page.evaluate(() => { window.cliFixture.nextError = 'BRIDGE_NAME_IN_USE'; });
    await page.locator('#cli-submit').click();await expect(page.locator('#cli-popover-status')).toContainText('Identifier already in use');
    await page.locator('#cli-name').fill('work-2');await page.evaluate(() => { window.cliFixture.nextError = null; });
    await page.locator('#cli-submit').click();await expect(page.locator('#cli-toggle')).toHaveText('Disconnect: work-2');
  });
  test('a later status event wins over a stale read; closing settings does not cancel a started connection', async ({ page }) => {
    await mount(page);await page.locator('#btn-close-settings').click();
    await page.evaluate(() => { window.cliFixture.defer = true; });
    await page.locator('#btn-settings').click();
    await expect.poll(() => page.evaluate(() => window.cliFixture.pending.length)).toBe(1);
    await page.evaluate(() => { const f = window.cliFixture;f.emit({ state: 'connected', name: 'external' });f.reply(f.pending.shift(), { ...f.status, state: 'disconnected', name: '' }); });
    await expect(page.locator('#cli-toggle')).toHaveText('Disconnect: external');
    await page.evaluate(() => { window.cliFixture.emit({ state: 'disconnected' }); });
    await page.locator('#cli-toggle').click();await expect.poll(() => page.evaluate(() => window.cliFixture.pending.length)).toBe(1);
    await page.locator('#btn-close-settings').click();
    await page.evaluate(() => { const f = window.cliFixture;f.defer = false;f.status.state = 'connected';f.reply(f.pending.shift(), f.status); });
    await page.locator('#btn-settings').click();await expect(page.locator('#cli-toggle')).toHaveText('Disconnect: external');
  });
  test('a newer disconnect wins over a delayed connect reply without changing the draft or focus', async ({ page }) => {
    await mount(page);await page.locator('#cli-toggle').click();
    await page.locator('#cli-name').fill('research');await page.locator('#cli-address-details summary').click();
    await page.locator('#cli-address').fill('http://127.0.0.1:18766');
    await page.evaluate(() => { window.cliFixture.defer = true; });
    await page.locator('#cli-submit').click();
    await expect.poll(() => page.evaluate(() => window.cliFixture.pending.length)).toBe(1);
    await page.evaluate(() => {
      const f = window.cliFixture;
      f.emit({ state: 'connected', name: 'research', endpoint: 'http://127.0.0.1:18766' });
      f.emit({ state: 'disconnected', name: 'external', endpoint: 'http://127.0.0.1:18767' });
    });
    await page.locator('#cli-cancel').focus();
    await page.evaluate(() => {
      const f = window.cliFixture;
      f.reply(f.pending.shift(), { ...f.status, state: 'connected', name: 'research', endpoint: 'http://127.0.0.1:18766' });
    });
    await expect(page.locator('#cli-toggle')).toHaveText('Connect CLI');
    await expect(page.locator('#cli-submit')).toBeEnabled();
    await expect(page.locator('#cli-connect-popover')).toBeVisible();
    await expect(page.locator('#cli-name')).toHaveValue('research');
    await expect(page.locator('#cli-address')).toHaveValue('http://127.0.0.1:18766');
    await expect(page.locator('#cli-cancel')).toBeFocused();
    await page.locator('#cli-cancel').click();await expect(page.locator('#cli-toggle')).toBeFocused();
    await page.locator('#cli-toggle').click();await expect(page.locator('#cli-name')).toHaveValue('research');
  });
  test('cancel retains a draft and Escape closes only the naming popover', async ({ page }) => {
    await mount(page);await page.locator('#cli-toggle').click();await page.locator('#cli-name').fill('research');
    await page.keyboard.press('Escape');await expect(page.locator('#settings-panel')).toBeVisible();await expect(page.locator('#cli-toggle')).toBeFocused();
    await page.locator('#cli-toggle').click();await expect(page.locator('#cli-name')).toHaveValue('research');
    expect(await page.evaluate(() => window.cliFixture.calls.map(x => x.type))).toEqual(['mcp_connection_status']);
  });
  test('invalid endpoint opens its field once and keeps manual collapse and edited drafts', async ({ page }) => {
    await mount(page);await page.locator('#cli-toggle').click();await page.locator('#cli-name').fill('work');
    await page.evaluate(() => { window.cliFixture.nextError = 'MCP_CONNECTION_INVALID_ENDPOINT'; });
    await page.locator('#cli-submit').click();await expect(page.locator('#cli-submit')).toBeEnabled();
    await expect(page.locator('#cli-address-details')).toHaveAttribute('open', '');
    await expect(page.locator('#cli-popover-status')).toBeVisible();await expect(page.locator('#cli-status')).toBeHidden();
    await page.locator('#cli-address').fill('http://127.0.0.1:18768');
    await page.locator('#cli-address-details summary').click();await page.locator('#cli-name').fill('research');
    await expect(page.locator('#cli-address-details')).not.toHaveAttribute('open', '');
    await page.locator('#cli-cancel').click();await expect(page.locator('#cli-status')).toBeVisible();
    await page.locator('#cli-toggle').click();
    await expect(page.locator('#cli-name')).toHaveValue('research');
    await expect(page.locator('#cli-address')).toHaveValue('http://127.0.0.1:18768');
    await expect(page.locator('#cli-address-details')).not.toHaveAttribute('open', '');
  });
  test('a maximum-length browser name stays in one row with its full accessible label', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await mount(page, 'en', { name: 'work', state: 'connected' });
    const normalHeight = (await page.locator('#cli-toggle').boundingBox()).height;
    const name = 'research-' + 'a'.repeat(55);
    await page.evaluate(name => window.cliFixture.emit({ state: 'connected', name }), name);
    await expect(page.locator('#cli-toggle')).toHaveAttribute('title', `Disconnect: ${name}`);
    await expect(page.locator('#cli-toggle')).toHaveAttribute('aria-label', `Disconnect: ${name}`);
    await expect(page.locator('#cli-toggle-label')).toHaveText(`Disconnect: ${name}`);
    const geometry = await page.evaluate(() => {
      const button = document.querySelector('#cli-toggle'), label = document.querySelector('#cli-toggle-label');
      const rect = button.getBoundingClientRect(), style = getComputedStyle(label);
      return { height: rect.height, left: rect.left, right: rect.right, width: innerWidth,
        documentWidth: document.documentElement.scrollWidth, whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow, clipped: label.scrollWidth > label.clientWidth };
    });
    expect(geometry.height).toBeLessThanOrEqual(normalHeight + 1);expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.whiteSpace).toBe('nowrap');expect(geometry.textOverflow).toBe('ellipsis');expect(geometry.clipped).toBe(true);
  });
});

for (const language of locales) for (const colorScheme of ['light', 'dark']) {
  test.describe(`CLI connection · ${language} · ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 320, height: 900 } });
    test('keeps localized connection, conflict and port controls within the narrow panel', async ({ page }, testInfo) => {
      const captureSetup = ['en', 'zh-CN'].includes(language);
      await mount(page, language, captureSetup ? {} : { name: 'work', state: 'paused', lastError: { code: 'BRIDGE_NAME_IN_USE', message: 'English backend diagnostic' } });
      await mkdir(output, { recursive: true });
      const capture = async scene => {
        const geometry = await page.evaluate(() => ({
          overflow: [...document.querySelectorAll('#settings-cli-connection button, #settings-cli-connection input, #cli-connect-popover')].filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden').filter(x => {const r=x.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1;}).map(x=>x.id),
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          englishDiagnostic: document.querySelector('#cli-status').textContent.includes('English backend diagnostic'),
        }));
        expect(geometry.overflow).toEqual([]);expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);expect(geometry.englishDiagnostic).toBe(false);
        const file=resolve(output,`${language}-${colorScheme}-${scene}.png`);await page.screenshot({path:file,animations:'disabled'});await testInfo.attach(scene,{path:file,contentType:'image/png'});
      };
      if (captureSetup) {
        await page.locator('#cli-toggle').click();await capture('naming');await page.locator('#cli-name').fill('work');
        await page.evaluate(() => { window.cliFixture.nextError = 'MCP_CONNECTION_UNAVAILABLE'; });
        await page.locator('#cli-submit').click();await expect(page.locator('#cli-popover-status')).toBeVisible();
        await expect(page.locator('#cli-status')).toBeHidden();await capture('unavailable');
        await page.locator('#cli-cancel').click();
        await page.evaluate(() => {
          window.cliFixture.nextError = null;
          window.cliFixture.emit({ name: 'work', state: 'paused', lastError: { code: 'BRIDGE_NAME_IN_USE', message: 'English backend diagnostic' } });
        });
      }
      await capture('conflict');await page.locator('#cli-edit').click();
      if (!await page.locator('#cli-address-details').evaluate(node => node.open)) await page.locator('#cli-address-details summary').click();
      await capture('edit');await page.locator('#cli-name').fill('work-2');await page.locator('#cli-submit').click();
      await expect(page.locator('#cli-connect-popover')).not.toBeVisible();await capture('connected');
      if(language!=='en')expect(await page.locator('#cli-toggle').innerText()).not.toContain('Disconnect:');
      await page.evaluate(() => window.cliFixture.emit({ state: 'paused', lastError: { code: 'MCP_CONNECTION_INCOMPATIBLE' } }));
      await page.locator('#cli-edit').click();await capture('upgrade');
      await expect(page.locator('#cli-start-command')).toHaveText('npx --yes qz-browser-agent@latest stop\nnpx --yes qz-browser-agent@latest connect');
    });
  });
}

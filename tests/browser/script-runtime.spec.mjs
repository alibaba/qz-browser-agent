import { compileScriptToolHost } from '../support/script-runtime-fixture.mjs';
import { expect, test } from './fixtures.mjs';

for (const mode of ['development', 'production']) {
  test.describe(`${mode} page script runtime`, () => {
    let compiled;
    let cdp;
    test.beforeAll(async () => { compiled = await compileScriptToolHost(mode); });
    test.beforeEach(async ({ page }) => {
      await page.goto('/__test_health');
      cdp = await page.context().newCDPSession(page);
      await page.exposeFunction('evaluateCdpExpression', parameters => cdp.send('Runtime.evaluate', parameters));
      await page.setContent('<button id="sample" class="selected">  Real DOM  </button><svg class="vector"><text>SVG text</text></svg>');
      await page.addScriptTag({ content: compiled });
      await page.evaluate(() => {
        window.chrome = { storage: { local: { get: async () => ({ securityGuardrails: { rules: [
          { action: 'block', type: 'domain', value: 'blocked.test' },
          { action: 'allow', type: 'pattern', value: 'https://blocked.test/allowed/*' },
        ] } }) } },
          tabs: { get: async id => ({ id, url: location.href, status: document.readyState === 'complete' ? 'complete' : 'loading' }) },
          scripting: { executeScript: async ({ func, args = [] }) => func ? [{ result: await func(...args) }] : [] },
        };
        const definitions = new Map();
        let skillCode = '';
        const { createScriptTools, ToolExecutionError } = window.QZ_SCRIPT_TEST;
        createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
          skills: { loadScript: async () => skillCode },
          scriptTimeoutProperty: { type: 'number' },
          evaluateCdpScript: (_tabId, parameters) => window.evaluateCdpExpression(parameters),
        });
        window.runPageScript = (code, args) => definitions.get('evaluate').execute({ code, args, tabId: 17, timeout: 5 }, undefined,
          { sessionId: 'browser-task', runId: 'browser-run' });
        window.runPrivatePageScript = code => {
          skillCode = code;
          return definitions.get('run_skill_script').execute({ skill: 'fixture', script: 'scripts/page.js', target: 'page', tabId: 17, timeout: 5 }, undefined,
            { sessionId: 'browser-task', runId: 'browser-run' });
        };
      });
    });

    test.afterEach(async () => { await cdp?.detach(); });

    test('public page functions return plain values while private Skill messages retain serialization and run identity', async ({ page }) => {
      const plain = await page.evaluate(() => window.runPageScript('value => ({ text: document.querySelector("button").textContent.trim(), value, input: typeof input })', [null, 7]));
      expect(plain).toEqual({ text: 'Real DOM', value: [null, 7], input: 'undefined' });
      expect(await page.evaluate(() => window.runPageScript('() => document.querySelector("button")'))).toMatchObject({ code: 'SCRIPT_VALUE_NOT_SERIALIZABLE' });
      const result = await page.evaluate(() => window.runPrivatePageScript(`async () => {
        const long = document.createElement('p'); long.textContent = '  ' + 'x'.repeat(250) + '  ';
        return { button: document.querySelector('button'), svg: document.querySelector('svg'), long, window, document };
      }`));
      expect(result.ok).toBe(true);
      expect(result.result.button).toEqual({ __qz_uncloneable: 'dom', tagName: 'BUTTON', id: 'sample', className: 'selected', text: 'Real DOM' });
      expect(result.result.svg).toEqual({ __qz_uncloneable: 'dom', tagName: 'svg', id: '', className: '[object SVGAnimatedString]', text: 'SVG text' });
      expect(result.result.long.text).toBe('x'.repeat(200));
      expect(result.result.window).toEqual({ __qz_uncloneable: 'global' });
      expect(result.result.document).toEqual({ __qz_uncloneable: 'global' });
      const bridged = await page.evaluate(async () => {
        let call;
        const respond = event => {
          if (event.source !== window || event.data?.source !== 'qz-run-script-tool-call') return;
          call = event.data;
          window.postMessage({ source: 'qz-run-script-tool-response', id: call.id,
            response: { ok: true, result: { accepted: true } } }, '*');
        };
        window.addEventListener('message', respond);
        try {
          const result = await window.runPrivatePageScript(`async () => { return await tools.echo({ element: document.querySelector('button') }); }`);
          return { result, call };
        } finally { window.removeEventListener('message', respond); }
      });
      expect(bridged.result.ok).toBe(true);
      expect(bridged.result.result).toEqual({ accepted: true });
      expect(bridged.result.trace ?? []).toEqual([]);
      expect(bridged.call).toMatchObject({ toolName: 'echo', sessionId: 'browser-task', runId: 'browser-run', depth: 1,
        args: { element: result.result.button } });
    });

    test('page Skill traces contain explicit checkpoints and errors only', async ({ page }) => {
      const result = await page.evaluate(() => window.runPrivatePageScript(`
        trace('page ready');
        console.log('read checkpoint');
        throw new Error('checkpoint failure');
      `));
      expect(result.code).toBe('SCRIPT_EVALUATION_FAILED');
      expect(result.details.trace.map(row => row.message).slice(0, 2)).toEqual(['page ready', 'read checkpoint']);
      expect(result.details.trace).toHaveLength(3);
      expect(result.details.trace[2].message).toContain('checkpoint failure');
    });

    test('native browser request surfaces block and recover without leaving wrappers installed', async ({ page }) => {
      const requests = [];
      await page.route('https://blocked.test/**', async route => {
        requests.push(route.request().url());
        await route.fulfill({ status: 200, body: 'allowed', headers: { 'access-control-allow-origin': '*' } });
      });
      const result = await page.evaluate(async () => {
        const originals = { fetch, open: XMLHttpRequest.prototype.open, beacon: navigator.sendBeacon, log: console.log };
        const run = code => window.runPageScript(`async () => { ${code} }`);
        const blocked = [];
        for (const code of [
          `await fetch(new Request('https://blocked.test/private'));`,
          `new XMLHttpRequest().open('GET', 'https://blocked.test/private');`,
          `navigator.sendBeacon('https://blocked.test/private', 'body');`,
        ]) blocked.push(await run(code));
        const allowed = await run(`return await (await fetch('https://blocked.test/allowed/fetch')).text();`);
        const failed = await run(`throw new Error('intentional script failure');`);
        return { blocked, allowed, failed, restored: {
          fetch: fetch === originals.fetch, xhr: XMLHttpRequest.prototype.open === originals.open,
          beacon: navigator.sendBeacon === originals.beacon, console: console.log === originals.log,
        } };
      });
      expect(result.blocked.map(value => [value.code, value.details.action])).toEqual([
        ['SECURITY_GUARDRAIL_BLOCKED', 'fetch'],
        ['SECURITY_GUARDRAIL_BLOCKED', 'XMLHttpRequest.open'],
        ['SECURITY_GUARDRAIL_BLOCKED', 'navigator.sendBeacon'],
      ]);
      expect(result.allowed).toBe('allowed');
      expect(result.failed).toMatchObject({ code: 'SCRIPT_EVALUATION_FAILED', message: expect.stringContaining('intentional script failure') });
      expect(result.restored).toEqual({ fetch: true, xhr: true, beacon: true, console: true });
      expect(requests).toEqual(['https://blocked.test/allowed/fetch']);
    });
  });
}

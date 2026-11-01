import { expect, test } from './fixtures.mjs';

test('compiled page helpers execute through CDP with node identity, selectors and screenshot bounds', async ({ page }) => {
  await page.goto('/__test_health');
  await page.setContent('<main id="root"><section><button>first</button><button style="width:120px;height:40px">second</button></section><i id="hidden" hidden></i></main>');
  const declarations = await page.evaluate(async () => {
    const { elementPageFunction } = await import('/extension/background/tools/page-scripts.js');
    return { selector: elementPageFunction('selector'), bounds: elementPageFunction('bounds') };
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    const call = async (expression, name) => {
      const { result: node } = await cdp.send('Runtime.evaluate', { expression });
      const result = await cdp.send('Runtime.callFunctionOn', { objectId: node.objectId, functionDeclaration: declarations[name], returnByValue: true });
      expect(result.exceptionDetails).toBeUndefined();
      return result.result.value;
    };
    expect(await call('document.querySelectorAll("button")[1]', 'selector')).toBe('main#root > section > button:nth-of-type(2)');
    expect(await call('document.querySelectorAll("button")[1].firstChild', 'selector')).toBe('main#root > section > button:nth-of-type(2)');
    const bounds = await call('document.querySelectorAll("button")[1]', 'bounds');
    expect(bounds.selector).toBe('#root > section > button:nth-of-type(2)');
    expect(bounds.bounds).toMatchObject({ width: 120, height: 40 });
    expect(bounds.viewport).toMatchObject({ scale: 1 });
    expect(await call('document.querySelector("#hidden")', 'bounds')).toMatchObject({ error: 'Element has no rendered box to screenshot' });
    expect(await call('document', 'selector')).toBe('');
  } finally { await cdp.detach(); }
});

test('compiled script bridge stays idempotent and preserves request identity and transport failures', async ({ page }) => {
  await page.goto('/__test_health');
  await page.evaluate(() => {
    globalThis.bridgeCalls = [];
    globalThis.chrome = { runtime: {
      sendMessage(message, callback) { globalThis.bridgeCalls.push(message); callback({ ok: true }); },
    } };
  });
  await page.addScriptTag({ url: '/extension/content/run-script-tool-bridge.js' });
  await page.addScriptTag({ url: '/extension/content/run-script-tool-bridge.js' });
  const result = await page.evaluate(async () => {
    const reply = await new Promise(resolve => {
      const listener = event => {
        if (event.data?.source !== 'qz-run-script-tool-response') return;
        window.removeEventListener('message', listener); resolve(event.data);
      };
      window.addEventListener('message', listener);
      window.postMessage({ source: 'qz-run-script-tool-call', id: 'call-1', toolName: 'read_dom', args: { limit: 5 }, sessionId: 'owned', runId: 'active', parentCallId: 'parent-call', depth: 2 }, '*');
    });
    return { calls: globalThis.bridgeCalls, reply };
  });
  expect(result.calls).toEqual([{ type: 'run_script_tool_call', toolName: 'read_dom', args: { limit: 5 }, sessionId: 'owned', runId: 'active', parentCallId: 'parent-call', depth: 2 }]);
  expect(result.reply).toEqual({ source: 'qz-run-script-tool-response', id: 'call-1', response: { ok: true } });
  await page.evaluate(() => { chrome.runtime.lastError = { message: 'extension reloaded' }; });
  const failed = await page.evaluate(() => new Promise(resolve => {
    const listener = event => {
      if (event.data?.source !== 'qz-run-script-tool-response' || event.data.id !== 'call-2') return;
      window.removeEventListener('message', listener); resolve(event.data.response);
    };
    window.addEventListener('message', listener);
    window.postMessage({ source: 'qz-run-script-tool-call', id: 'call-2', toolName: 'read_dom' }, '*');
  }));
  expect(failed).toEqual({ ok: false, error: 'extension reloaded' });
});

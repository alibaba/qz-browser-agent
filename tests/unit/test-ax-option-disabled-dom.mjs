import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { loadOptionCorrection, installOptionCases, correctionNodes, predicateOracle } from '../support/ax-option-correction.mjs';
let browser, correct;
before(async () => { browser = await chromium.launch({ headless: true }); correct = await loadOptionCorrection(); });
after(async () => { await browser?.close(); });

test('correction is identical to the native predicate for attributes, JS, ancestors, legends, ARIA and open/closed shadow roots', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await installOptionCases(page);
  const cdp = await page.context().newCDPSession(page);
  const nodes = await correctionNodes(cdp), oracle = await predicateOracle(cdp, nodes);
  assert.ok(oracle.size >= 18);
  assert.equal(oracle.get('first-legend'), false);
  assert.equal(oracle.get('second-legend'), true);
  assert.equal(oracle.get('nested-legend'), false);
  assert.equal(oracle.get('nested-fieldset'), true);
  assert.equal(oracle.get('open-shadow'), false, 'closest does not cross the ARIA-disabled shadow host');
  assert.equal(oracle.get('closed-shadow'), false);
  assert.equal(oracle.get('custom-form'), true, 'form-associated custom elements use native :disabled');
  const before = await page.content();
  await correct(cdp.send.bind(cdp), nodes);
  for (const node of nodes.slice(1)) {
    assert.equal(node.properties.some(p => p.name === 'disabled'), oracle.get(node.label) !== false, node.label);
    assert.ok(node.properties.some(p => p.name === 'selected'), node.label);
  }
  assert.equal(await page.content(), before, 'correction never writes page DOM');
});

test('deleted original nodes stay disabled even when a replacement has identical markup', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await installOptionCases(page);
  const cdp = await page.context().newCDPSession(page);
  const nodes = await correctionNodes(cdp);
  await page.evaluate(() => { const old = document.querySelector('#enabled'); window.detachedOption = old; old.replaceWith(old.cloneNode(true)); });
  await correct(cdp.send.bind(cdp), nodes);
  assert.ok(nodes.find(n => n.label === 'enabled').properties.some(p => p.name === 'disabled'));
});

test('navigation after batch serialization discards staged values and releases every retained handle', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await installOptionCases(page);
  const cdp = await page.context().newCDPSession(page), nodes = await correctionNodes(cdp);
  const original = structuredClone(nodes), calls = [];
  await correct(async (method, params) => {
    calls.push({ method, params });
    const response = await cdp.send(method, params);
    if (method === 'Runtime.callFunctionOn' && params.serializationOptions) await page.goto('data:text/html,<select><option>replacement</option></select>');
    return response;
  }, nodes);
  assert.deepEqual(nodes, original);
  assert.equal(calls.filter(c => c.method === 'Runtime.releaseObjectGroup').length, 1);
});

test('removing the owning iframe after serialization cannot enable its old AX nodes', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent('<iframe id="frame" srcdoc="<select><option>Original</option></select>"></iframe>');
  await page.frameLocator('#frame').locator('option').waitFor({ state: 'attached' });
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: frameTree.childFrames[0].frame.id });
  const option = nodes.find(n => n.role?.value === 'option');
  assert.ok(option); option.properties = [{ name: 'disabled', value: { value: true } }];
  await correct(async (method, params) => {
    const response = await cdp.send(method, params);
    if (method === 'Runtime.callFunctionOn' && params.serializationOptions) await page.locator('#frame').evaluate(frame => frame.remove());
    return response;
  }, nodes);
  assert.ok(option.properties.some(p => p.name === 'disabled'));
});

test('element predicate exceptions are unknown and object groups are actually released', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await installOptionCases(page);
  const cdp = await page.context().newCDPSession(page), nodes = await correctionNodes(cdp);
  await page.evaluate(() => { document.querySelector('#enabled').matches = () => { throw new Error('predicate failed'); }; });
  const handles = [];
  await correct(async (method, params) => { const response = await cdp.send(method, params);
    if (method === 'DOM.resolveNode' && response.object?.objectId) handles.push(response.object.objectId); return response;
  }, nodes);
  assert.ok(nodes.find(n => n.label === 'enabled').properties.some(p => p.name === 'disabled'));
  assert.equal(nodes.find(n => n.label === 'first-legend').properties.some(p => p.name === 'disabled'), false);
  for (const objectId of handles) await assert.rejects(cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { return true; }' }));
});

test('reordering preserves original backend identity rather than matching position', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await installOptionCases(page);
  const cdp = await page.context().newCDPSession(page);
  const nodes = await correctionNodes(cdp);
  await page.evaluate(() => { const enabled = document.querySelector('#enabled'); enabled.parentNode.append(enabled); });
  const oracle = await predicateOracle(cdp, nodes);
  await correct(cdp.send.bind(cdp), nodes);
  for (const node of nodes.slice(1)) assert.equal(node.properties.some(p => p.name === 'disabled'), oracle.get(node.label) !== false, node.label);
});

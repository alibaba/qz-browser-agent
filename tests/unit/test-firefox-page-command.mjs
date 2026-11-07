import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExtension } from '../../scripts/build-extension.mjs';
import { auditReviewableCode } from '../../scripts/check-reviewable-code.mjs';

let browser, directory, firefoxPageCommand, installFirefoxDebugger, outputDir, contentSources;
let registerAccessibilityTools, ToolExecutionError;
const debuggerListeners = { event: [], detach: [] };
let nextTabId = 50;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qz-firefox-input-'));
  // Keep generated JS in ESM scope so tsx cannot add helpers that break page serialization.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  ({ outputDir } = await buildExtension({ browser: 'firefox', mode: 'production', outputDir: join(directory, 'extension') }));
  ({ firefoxPageCommand } = await import(pathToFileURL(join(outputDir, 'background/firefox/page-command.js'))));
  ({ installFirefoxDebugger } = await import(pathToFileURL(join(outputDir, 'background/firefox/debugger-host.js'))));
  contentSources = await Promise.all(['content/article-extractor.js', 'content/content-script.js'].map(file => readFile(join(outputDir, file), 'utf8')));
  // The production AX grafting module subscribes to debugger events at import time.
  const previousChrome = globalThis.chrome;
  try {
    globalThis.chrome = { debugger: {
      onEvent: { addListener(listener) { debuggerListeners.event.push(listener); } },
      onDetach: { addListener(listener) { debuggerListeners.detach.push(listener); } },
    } };
    ({ registerAccessibilityTools } = await import('../../src/capabilities/accessibility/tools.js'));
    ({ ToolExecutionError } = await import('../../src/background/tools/arguments.js'));
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await rm(directory, { recursive: true, force: true }); });

async function installContent(frame) {
  await frame.evaluate(sources => {
    const invoke = globalThis.__qzInvoke;
    globalThis.chrome ||= { runtime: {} };
    globalThis.chrome.runtime.onMessage ||= { addListener() {}, removeListener() {} };
    for (const source of sources) (0, eval)(source);
    if (invoke) globalThis.__qzInvoke = invoke;
  }, contentSources);
}

test('Firefox production package retains implicit submission and only reviewed execution sinks', async () => {
  const source = await readFile(join(outputDir, 'background/firefox/page-command.js'), 'utf8');
  assert.match(source, /implicitSubmit/);
  const findings = (await auditReviewableCode(outputDir)).flatMap(item => item.findings);
  assert.deepEqual(findings.filter(item => !item.reviewed), []);
  assert.equal(findings.filter(item => item.rule === 'dynamic-code' && item.file === 'background/firefox/page-command.js').length, 1);
});

for (const kind of ['mouse', 'touch']) test(`Firefox ${kind} reaches nested shadow elements and document event receipts`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<div id=outer></div>');
  await page.evaluate(() => {
    const outer = document.querySelector('#outer').attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id=inner></div>';
    const inner = outer.querySelector('#inner').attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id=button style="width:160px;height:80px">Click</button>';
    window.receipts = [];
    window.clicks = 0;
    inner.querySelector('button').addEventListener('click', () => clicks++);
    for (const type of ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
      'touchstart', 'touchmove', 'touchend']) document.addEventListener(type, event => {
      receipts.push({ type, target: event.composedPath()[0].id, composed: event.composed,
        marked: window.__qzExtensionInputEvents?.has(event) === true });
    }, true);
  });
  const point = await elementCenter(page.locator('button'));
  const types = kind === 'mouse' ? ['mouseMoved', 'mousePressed', 'mouseReleased'] : ['touchStart', 'touchMove', 'touchEnd'];
  for (const type of types) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind, type, ...point, button: 'left', clickCount: 1 },
  });
  const observed = await page.evaluate(() => ({ receipts, clicks }));
  const expectedTypes = kind === 'mouse'
    ? ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    : ['touchstart', 'touchmove', 'touchend'];
  assert.deepEqual(observed.receipts, expectedTypes.map(type => ({ type, target: 'button', composed: true, marked: true })));
  assert.equal(observed.clicks, kind === 'mouse' ? 1 : 0);
});

for (const cancel of ['pointerdown', 'mousedown', 'none']) test(`Firefox mouse focus respects ${cancel} cancellation`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<input id=search><button id=option>Suggestion</button>');
  await page.evaluate(cancel => {
    window.events = [];
    search.focus();
    search.addEventListener('blur', () => { if (cancel !== 'none') option.hidden = true; });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focus', 'blur']) {
      document.addEventListener(type, event => {
        events.push([type, event.target.id]);
        if (type === cancel) event.preventDefault();
      }, true);
    }
  }, cancel);
  const point = await elementCenter(page.locator('#option'));
  for (const type of ['mousePressed', 'mouseReleased']) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind: 'mouse', type, ...point, button: 'left', clickCount: 1 },
  });
  const expected = cancel === 'pointerdown' ? ['pointerdown', 'pointerup', 'click']
    : cancel === 'mousedown' ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    : ['pointerdown', 'mousedown', 'blur', 'focus', 'pointerup', 'mouseup', 'click'];
  assert.deepEqual(await page.evaluate(() => events.map(([type]) => type)), expected);
  assert.equal(await page.evaluate(() => document.activeElement.id), cancel === 'none' ? 'option' : 'search');
});

test('Firefox keys, text and focused frame discovery reach nested shadow focus', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<div id=host></div>');
  await page.evaluate(() => {
    const outer = host.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id=nested></div>';
    const root = outer.querySelector('div').attachShadow({ mode: 'open' });
    root.innerHTML = '<form><input id=field value=query><button>Go</button></form><iframe srcdoc="<input>"></iframe>';
    window.events = [];
    root.querySelector('form').addEventListener('submit', event => { events.push(['submit']); event.preventDefault(); });
    for (const type of ['keydown', 'keypress', 'keyup', 'input']) document.addEventListener(type, event => {
      events.push([type, event.composedPath()[0].id, event.composed]);
    });
    root.querySelector('input').focus();
  });
  for (const type of ['keyDown', 'keyUp']) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind: 'key', type, key: 'Enter', code: 'Enter', modifiers: 0 },
  });
  assert.deepEqual(await page.evaluate(() => events), [
    ['keydown', 'field', true], ['keypress', 'field', true], ['submit'], ['keyup', 'field', true],
  ]);
  // Exercise the value setter fallback as well as native execCommand insertion.
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.evaluate(firefoxPageCommand, { op: 'input', input: { kind: 'text', text: '!' } });
  assert.equal(await page.locator('#field').inputValue(), '!query');
  assert.deepEqual(await page.evaluate(() => events.at(-1)), ['input', 'field', true]);
  await page.locator('iframe').evaluate(frame => frame.contentDocument.querySelector('input').focus());
  const result = await page.evaluate(firefoxPageCommand, { op: 'inputFrame', active: true, x: 0, y: 0 });
  assert.ok(result.backendNodeId > 0);
});

for (const scenario of [
  { key: 'Backspace', value: 'original', start: 0, end: 8, expected: '' },
  { key: 'Backspace', value: 'a🐱b', start: 3, end: 3, expected: 'ab' },
  { key: 'Delete', value: 'a🐱b', start: 1, end: 1, expected: 'ab' },
  { key: 'Backspace', value: 'original', start: 0, end: 8, cancel: 'keydown', expected: 'original' },
  { key: 'Backspace', value: 'original', start: 0, end: 8, cancel: 'beforeinput', expected: 'original' },
]) test(`Firefox editing uses the browser selection (${scenario.key}, ${scenario.cancel || scenario.value})`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<input id=field>');
  await page.evaluate(scenario => {
    field.value = scenario.value;
    field.focus();
    field.setSelectionRange(scenario.start, scenario.end);
    window.edits = [];
    field.addEventListener('input', event => edits.push(event.inputType));
    if (scenario.cancel) field.addEventListener(scenario.cancel, event => event.preventDefault());
  }, scenario);
  for (const type of ['keyDown', 'keyUp']) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind: 'key', type, key: scenario.key, code: scenario.key, modifiers: 0 },
  });
  assert.equal(await page.locator('#field').inputValue(), scenario.expected);
  assert.deepEqual(await page.evaluate(() => edits), scenario.cancel ? []
    : [scenario.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward']);
});

test('Firefox Tab reports native focus traversal limits while retaining page key handlers', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<input id=first><input id=second>');
  await page.locator('#first').focus();
  const input = { op: 'input', input: { kind: 'key', type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: 0 } };
  await assert.rejects(page.evaluate(firefoxPageCommand, input), /native Tab focus navigation/);
  await page.evaluate(() => first.addEventListener('keydown', event => { event.preventDefault(); second.focus(); }));
  assert.deepEqual(await page.evaluate(firefoxPageCommand, input), {});
  assert.equal(await page.evaluate(() => document.activeElement.id), 'second');
});

for (const [kind, key, cancel = ''] of [
  ['button', 'Enter'], ['button', 'Space'], ['button', 'Space', 'keyup'],
  ['checkbox', 'Space'], ['checkbox', 'Space', 'keydown'], ['checkbox', 'Space', 'keypress'], ['checkbox', 'Space', 'keyup'],
  ['radio', 'Space'], ['submit', 'Enter'], ['reset', 'Space'], ['link', 'Enter'], ['link', 'Enter', 'keypress'],
]) test(`Firefox keyboard activation: ${kind}, ${key}, ${cancel || 'allowed'}`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(kind === 'button' ? '<button id=control type=button>Go</button>'
    : kind === 'link' ? '<a id=control href="#next">Go</a>' : `<input id=control type=${kind}>`);
  await page.evaluate(cancel => {
    window.events = [];
    control.focus();
    for (const type of ['keydown', 'keypress', 'keyup', 'click', 'input', 'change']) {
      control.addEventListener(type, event => {
        events.push(type);
        if (type === cancel) event.preventDefault();
      });
    }
  }, cancel);
  for (const type of ['keyDown', 'keyUp']) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind: 'key', type, key: key === 'Space' ? ' ' : key, code: key,
      text: type === 'keyDown' && key === 'Space' ? ' ' : '', modifiers: 0 },
  });
  const activated = key === 'Space' ? !['keydown', 'keyup'].includes(cancel) : !['keydown', 'keypress'].includes(cancel);
  const events = ['keydown', ...(cancel === 'keydown' ? [] : ['keypress'])];
  const activation = activated ? ['click', ...(['checkbox', 'radio'].includes(kind) ? ['input', 'change'] : [])] : [];
  events.push(...(key === 'Space' ? ['keyup', ...activation] : [...activation, 'keyup']));
  assert.deepEqual(await page.evaluate(() => window.events), events);
  if (['checkbox', 'radio'].includes(kind)) assert.equal(await page.locator('#control').isChecked(), activated);
});

test('Firefox AX and element observations share standard roles and accessible names', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(`<label for=track>Track</label><select id=track><option>Data</option><option>Design</option></select>
    <select id=multi multiple aria-label="Tracks"><option>Data</option></select>
    <label>Full name<input id=field name=internal_name value="Not the name"></label>
    <span id=label hidden>Primary action</span><button id=labelled aria-labelledby=label aria-label="Lower priority">Other text</button>
    <button id=presentation role=presentation>Continue</button>
    <table><tr><th id=row scope=row>Account</th><td>One</td></tr></table>
    <svg id=graphic><title>Lighthouse</title></svg><p>Visible paragraph text</p>
    <div style="visibility:hidden"><button id=visible style="visibility:visible">Visible child</button></div>`);
  assert.equal(await page.evaluate(firefoxPageCommand, { op: 'semantics' }), 0);
  await installContent(page);
  assert.equal(await page.evaluate(firefoxPageCommand, { op: 'semantics' }), 1);
  const { root } = await page.evaluate(firefoxPageCommand, { op: 'document' });
  const tree = await page.evaluate(firefoxPageCommand, { op: 'ax' });
  await t.test('paragraph content remains text rather than an accessible name', () => {
    assert.ok(tree.nodes.some(node => node.role.value === 'StaticText' && node.name?.value === 'Visible paragraph text'));
    assert.equal(tree.nodes.some(node => node.role.value === 'paragraph' && node.name?.value === 'Visible paragraph text'), false);
  });
  for (const [id, role, name] of [
    ['track', 'combobox', 'Track'], ['multi', 'listbox', 'Tracks'], ['field', 'textbox', 'Full name'],
    ['labelled', 'button', 'Primary action'], ['presentation', 'button', 'Continue'],
    ['row', 'rowheader', 'Account'], ['graphic', 'img', 'Lighthouse'], ['visible', 'button', 'Visible child'],
  ]) {
    const { nodeIds } = await page.evaluate(firefoxPageCommand, { op: 'query', nodeId: root.nodeId, selector: `#${id}` });
    const ax = tree.nodes.find(node => node.backendDOMNodeId === nodeIds[0]);
    assert.equal(ax?.role.value, role === 'img' ? 'image' : role, id);
    assert.equal(ax?.name.value, name, id);
    const element = await page.evaluate(id => __qzInvoke(document.getElementById(id), { action: 'inspectElement' }), id);
    assert.equal(element.role, role, id);
    assert.equal(element.name, name, id);
  }
  await page.locator('#track').selectOption({ label: 'Design' });
  const updated = await page.evaluate(firefoxPageCommand, { op: 'ax' });
  assert.equal(updated.nodes.find(node => node.role.value === 'combobox').name.value, 'Track');
  await page.evaluate(() => { globalThis.__qzDomSemantics = { version: 99 }; });
  await installContent(page);
  assert.equal(await page.evaluate(firefoxPageCommand, { op: 'semantics' }), 1, 'reinject refreshes the provider despite the content version guard');
  await page.locator('html').evaluate(node => { node.setAttribute('role', 'application'); node.setAttribute('aria-label', 'App'); });
  const application = await page.evaluate(firefoxPageCommand, { op: 'ax' });
  assert.ok(application.nodes.some(node => node.role.value === 'application' && node.name?.value === 'App'));
});

for (const crossOrigin of [false, true]) test(`Firefox frame sessions bind and click child nodes (crossOrigin=${crossOrigin})`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<button id=outer>Outer</button><iframe style="display:block;margin:20px;border:3px solid" srcdoc="<button id=inner>Inner</button>"></iframe>');
  const child = page.frames().find(frame => frame !== page.mainFrame());
  await child.waitForSelector('#inner');
  const frames = new Map([[0, page.mainFrame()], [7, child]]);
  for (const frame of frames.values()) await frame.evaluate(() => {
    globalThis.chrome = { runtime: { id: 'frame-test' } };
    globalThis.__qzElementRefVersion = 1;
    globalThis.__qzInvoke = (node, payload) => {
      if (payload.action === 'resolveElementRefs') return [document.querySelector('button'), null];
      if (!node?.isConnected || node.ownerDocument !== document) return { code: 'STALE_ELEMENT_UID' };
      return { id: node.id, action: payload.action };
    };
    window.clicks = [];
    document.addEventListener('click', event => clicks.push(event.target.id));
  });
  const events = [], injections = [];
  let committed;
  const api = {
    runtime: { id: 'frame-test', onMessage: { addListener() {} } },
    tabs: { async get() { return { url: 'http://127.0.0.1/outer' }; } },
    webNavigation: {
      onCommitted: { addListener(listener) { committed = listener; } },
      async getAllFrames() { return [
        { frameId: 0, parentFrameId: -1, url: 'http://127.0.0.1/outer' },
        { frameId: 7, parentFrameId: 0, url: crossOrigin ? 'http://localhost/inner' : 'http://127.0.0.1/inner' },
      ]; },
    },
    scripting: { async executeScript({ target, func, args, files }) {
      if (files) {
        assert.deepEqual(files, ['content/article-extractor.js', 'content/content-script.js']);
        await installContent(frames.get(target.frameIds[0]));
        return [{ result: undefined }];
      }
      if (func.name !== 'firefoxPageCommand') return [{ result: undefined }];
      injections.push({ frameId: target.frameIds[0], op: args[0].op });
      const result = await frames.get(target.frameIds[0]).evaluate(async ({ source, args }) => {
        const command = (0, eval)(`(${source})`);
        return command(...args);
      }, { source: func.toString(), args });
      return [{ result }];
    } },
  };
  installFirefoxDebugger(api);
  const send = (method, params = {}, sessionId) => api.debugger.sendCommand({ tabId: 5, ...(sessionId ? { sessionId } : {}) }, method, params);
  api.debugger.onEvent.addListener((source, method, params) => events.push({ source, method, params }));
  await api.debugger.attach({ tabId: 5 });
  await send('Target.setAutoAttach', { autoAttach: true });
  await send('Runtime.enable');
  const session = events.find(event => event.method === 'Target.attachedToTarget').params.sessionId;
  assert.equal(session, 'ff-5-7');
  const context = events.find(event => event.method === 'Runtime.executionContextCreated'
    && event.source.sessionId === session && event.params.context.auxData.type === 'isolated').params.context;
  assert.equal(context.auxData.frameId, '7');
  assert.deepEqual((await send('Page.getFrameTree')).frameTree.childFrames, []);
  assert.equal((await send('Page.getFrameTree', {}, session)).frameTree.frame.id, '7');
  const outer = await send('Accessibility.getFullAXTree');
  assert.equal(outer.nodes.some(node => node.name?.value === 'Inner'), false);
  const tree = await send('Accessibility.getFullAXTree', {}, session);
  const button = tree.nodes.find(node => node.name?.value === 'Inner');
  assert.ok(button.backendDOMNodeId);
  const { object } = await send('DOM.resolveNode', { backendNodeId: button.backendDOMNodeId, executionContextId: context.id, objectGroup: 'test' }, session);
  const { ISOLATED_CONTENT_INVOKE } = await import('../../src/background/tools/isolated-page-calls.js');
  const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ISOLATED_CONTENT_INVOKE,
    arguments: [{ value: { action: 'inspectElement' } }], returnByValue: true }, session);
  assert.deepEqual(result.result.value, { id: 'inner', action: 'inspectElement' });
  const batch = await send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: ISOLATED_CONTENT_INVOKE,
    arguments: [{ value: { action: 'resolveElementRefs', elementRefs: ['one', 'gone'] } }], returnByValue: false, objectGroup: 'bind-batch' }, session);
  assert.equal(batch.result.subtype, 'array');
  const properties = await send('Runtime.getProperties', { objectId: batch.result.objectId, ownProperties: true }, session);
  assert.equal(properties.result[0].value.subtype, 'node');
  assert.equal(properties.result[1].value.subtype, 'null');
  assert.equal((await send('DOM.describeNode', { objectId: properties.result[0].value.objectId }, session)).node.backendNodeId, button.backendDOMNodeId);
  await send('Runtime.releaseObjectGroup', { objectGroup: 'bind-batch' }, session);
  const original = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ISOLATED_CONTENT_INVOKE,
    arguments: [{ value: { action: 'inspectElement' } }], returnByValue: true }, session);
  assert.deepEqual(original.result.value, { id: 'inner', action: 'inspectElement' }, 'releasing a binding batch cannot invalidate another live object group');
  // Page tools dispatch in root coordinates even when the bound node is in a frame.
  const point = await page.evaluate(() => {
    const frame = document.querySelector('iframe'), outer = frame.getBoundingClientRect();
    const inner = frame.contentDocument.querySelector('button').getBoundingClientRect();
    return { x: outer.x + frame.clientLeft + inner.x + inner.width / 2, y: outer.y + frame.clientTop + inner.y + inner.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  assert.deepEqual(await child.evaluate(() => clicks), ['inner']);
  assert.deepEqual(await page.evaluate(() => clicks), []);
  assert.ok(injections.some(entry => entry.frameId === 7 && entry.op === 'input'));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left' });
  assert.equal(await child.evaluate(() => __qzFirefoxPage.mouseTarget), null);
  assert.deepEqual(await child.evaluate(() => clicks), ['inner'], 'cleanup releases the child without clicking again');
  const before = (await send('Page.getFrameTree', {}, session)).frameTree.frame.loaderId;
  committed({ tabId: 5, frameId: 7, url: 'http://127.0.0.1/replaced' });
  assert.notEqual((await send('Page.getFrameTree', {}, session)).frameTree.frame.loaderId, before);
  assert.ok(events.some(event => event.method === 'Runtime.executionContextDestroyed' && event.source.sessionId === session));
  await send('Runtime.releaseObjectGroup', { objectGroup: 'test' }, session);
  await api.debugger.detach({ tabId: 5 });
});

async function duplicateFrameFixture(t, kind, unrelatedFirst = false) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const base = 'http://127.0.0.1:43911';
  const childHtml = '<!doctype html><button>Inner</button>';
  const source = kind === 'srcdoc' ? `srcdoc="${childHtml}"` : `src="${kind === 'blank' ? 'about:blank' : '/inner'}"`;
  const html = `<!doctype html><title>Outer</title>
    <style>iframe { display:block; width:300px; height:120px; margin:20px; border:3px solid; padding:0; }</style>
    ${unrelatedFirst ? '<iframe id=other name=other src="/other"></iframe>' : ''}
    <iframe id=first name=first aria-label="First frame" ${source}></iframe>
    <iframe id=second name=second aria-label="Second frame" ${source}></iframe>`;
  await page.route(`${base}/**`, route => route.fulfill({
    contentType: 'text/html', body: new URL(route.request().url()).pathname === '/outer' ? html : childHtml,
  }));
  await page.goto(`${base}/outer`);
  const children = ['first', 'second'].map(name => page.frames().find(frame => frame.name() === name));
  const expectedUrl = kind === 'srcdoc' ? 'about:srcdoc' : kind === 'blank' ? 'about:blank' : `${base}/inner`;
  for (const [index, frame] of children.entries()) {
    // Write inside the child: document.open() from the parent can copy its URL.
    if (kind === 'blank') await frame.evaluate(content => {
      document.open();
      document.write(content);
      document.close();
    }, childHtml);
    await frame.waitForSelector('button');
    assert.equal(frame.url(), expectedUrl);
    assert.equal(await frame.evaluate(() => location.href), expectedUrl);
    await frame.evaluate(label => {
      document.title = `${label} document`;
      const button = document.querySelector('button');
      button.id = `${label.toLowerCase()}-button`;
      button.textContent = `${label} button`;
    }, index ? 'Second' : 'First');
  }
  const frames = new Map([[0, page.mainFrame()], [7, children[0]], [8, children[1]]]);
  if (unrelatedFirst) frames.set(9, page.frames().find(frame => frame.name() === 'other'));
  for (const frame of frames.values()) await frame.evaluate(() => {
    window.clicks = [];
    document.addEventListener('click', event => clicks.push(event.target.id));
  });
  const tabId = nextTabId++;
  const inputReads = { getAllFrames: 0, owners: [] };
  const api = {
    runtime: { id: 'duplicate-frame-test', onMessage: { addListener() {} } },
    tabs: { async get() { return { url: page.url() }; } },
    webNavigation: {
      onCommitted: { addListener() {} },
      async getAllFrames() {
        inputReads.getAllFrames++;
        return [...frames].map(([frameId, frame]) => ({
          frameId, parentFrameId: [...frames].find(([, parent]) => parent === frame.parentFrame())?.[0] ?? -1, url: frame.url(),
        }));
      },
    },
    scripting: { async executeScript({ target, func, args, files }) {
      if (files) {
        assert.deepEqual(files, ['content/article-extractor.js', 'content/content-script.js']);
        await installContent(frames.get(target.frameIds[0]));
        return [{ result: undefined }];
      }
      if (func.name !== 'firefoxPageCommand') return [{ result: undefined }];
      if (args[0].op === 'owners') inputReads.owners.push(target.frameIds[0]);
      const result = await frames.get(target.frameIds[0]).evaluate(async ({ source, args }) => {
        const command = (0, eval)(`(${source})`);
        return command(...args);
      }, { source: func.toString(), args });
      return [{ result }];
    } },
  };
  installFirefoxDebugger(api);
  api.debugger.onEvent.addListener((...args) => {
    for (const listener of debuggerListeners.event) listener(...args);
  });
  await api.debugger.attach({ tabId });
  t.after(async () => {
    for (const listener of debuggerListeners.detach) listener({ tabId });
    await api.debugger.detach({ tabId });
  });
  const send = (method, params = {}, sessionId) => api.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
  send.tabId = tabId;
  send.connectionId = 1;
  send.inSession = sessionId => (method, params) => send(method, params, sessionId);
  const { root } = await send('DOM.getDocument');
  const backendIds = async selector => {
    const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    return Promise.all(nodeIds.map(async nodeId => (await send('DOM.describeNode', { nodeId })).node.backendNodeId));
  };
  const expectedOwners = await backendIds('#first,#second');
  assert.equal(expectedOwners.length, 2);
  assert.ok(expectedOwners.every(id => id > 0));
  assert.notEqual(expectedOwners[0], expectedOwners[1]);
  return { page, children, frames, send, tabId, expectedOwners, backendIds, inputReads };
}

for (const kind of ['srcdoc', 'blank', 'same-src']) test(`Firefox duplicate iframe URLs: ${kind}`, async t => {
  const { page, children, send, tabId, expectedOwners } = await duplicateFrameFixture(t, kind);
  // Separate checks retain evidence for reading and input even when ownership fails.
  await t.test('getFrameOwner identifies each iframe element', async () => {
    const owners = await Promise.all([7, 8].map(async frameId => (await send('DOM.getFrameOwner', { frameId: String(frameId) })).backendNodeId));
    assert.deepEqual(owners, expectedOwners);
  });
  await t.test('AX sessions graft under their corresponding iframe', async () => {
    const outer = await send('Accessibility.getFullAXTree');
    assert.deepEqual(outer.nodes.filter(node => node.role?.value === 'Iframe').map(node => node.backendDOMNodeId), expectedOwners);
    assert.equal(outer.nodes.some(node => node.role?.value === 'button'), false);
    const childButtons = [];
    for (const [index, frameId] of [7, 8].entries()) {
      const tree = await send('Accessibility.getFullAXTree', {}, `ff-${tabId}-${frameId}`);
      const buttons = tree.nodes.filter(node => node.role?.value === 'button');
      assert.deepEqual(buttons.map(node => node.name.value), [index ? 'Second button' : 'First button']);
      childButtons.push(buttons[0].backendDOMNodeId);
    }
    let definition;
    const refs = [];
    registerAccessibilityTools({
      registerTool: value => { definition = value; }, ToolExecutionError,
      clampLimit: (value, min, max) => Math.max(min, Math.min(value, max)),
      makeSnapshotId: () => 'snapshot', elementTargetForUid: uid => `uid:${uid}`,
      registerElementBinding: ref => {
        const bound = { ...ref, uid: `snapshot.${refs.length}`, target: `uid:snapshot.${refs.length}` };
        refs.push(bound); return bound;
      },
      bindElementReferences: async () => [],
      sendToContent: async () => ({ title: 'Outer', url: page.url(), actions: [] }),
      withDebugger: async (_id, run) => run({}, send), elementTargetGrammar: 'target grammar',
    });
    const previousChrome = globalThis.chrome;
    globalThis.chrome = {
      tabs: { async get(id) { assert.equal(id, tabId); return { url: page.url(), status: 'complete' }; } },
      scripting: { async executeScript({ target, func }) {
        assert.deepEqual(target, { tabId, frameIds: [0] });
        return [{ result: await page.evaluate(func) }];
      } },
    };
    let result;
    try { result = await definition.execute({ tabId, scope: 'full' }, undefined, { sessionId: 'owner' }); }
    finally {
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    }
    assert.equal(result.snapshot.replace(/target=uid:\S+ /g, ''), [
      'RootWebArea "Outer"',
      ' Iframe "First frame"',
      '  RootWebArea "First document"',
      '   button "First button"',
      ' Iframe "Second frame"',
      '  RootWebArea "Second document"',
      '   button "Second button"',
    ].join('\n'));
    assert.deepEqual(refs.filter(ref => ref.role === 'button').map(ref => ({ frameId: ref.frameId, backendNodeId: ref.backendNodeId })),
      childButtons.map((backendNodeId, index) => ({ frameId: String(index + 7), backendNodeId })));
  });
  await t.test('root-coordinate click reaches only the second frame', async () => {
    const point = await page.evaluate(() => {
      const frame = document.querySelector('#second'), outer = frame.getBoundingClientRect();
      const inner = frame.contentDocument.querySelector('button').getBoundingClientRect();
      return { x: outer.x + frame.clientLeft + inner.x + inner.width / 2, y: outer.y + frame.clientTop + inner.y + inner.height / 2 };
    });
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
    assert.deepEqual(await children[0].evaluate(() => clicks), []);
    assert.deepEqual(await children[1].evaluate(() => clicks), ['second-button']);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  });
});

test('Firefox frame owner URL matches outrank an unrelated sibling position', async t => {
  // Frame IDs can follow creation order while the DOM order differs. A conflicting
  // sibling position must not override either a unique match or the matching set.
  const { send, expectedOwners, backendIds } = await duplicateFrameFixture(t, 'srcdoc', true);
  const [other] = await backendIds('#other');
  assert.equal((await send('DOM.getFrameOwner', { frameId: '7' })).backendNodeId, expectedOwners[0]);
  assert.equal((await send('DOM.getFrameOwner', { frameId: '9' })).backendNodeId, other);
});

async function elementCenter(locator) {
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function measureInput(fixture, method, params) {
  fixture.inputReads.getAllFrames = 0;
  fixture.inputReads.owners.length = 0;
  await fixture.send(method, params);
  return { command: params.type || method, getAllFrames: fixture.inputReads.getAllFrames, owners: [...fixture.inputReads.owners] };
}

for (const inChild of [true, false]) test(`Firefox dispatch owner reads: ${inChild ? 'last sibling' : 'main document'}`, async t => {
  const f = await duplicateFrameFixture(t, 'srcdoc');
  const target = inChild ? f.children[1] : f.page.mainFrame();
  if (!inChild) await target.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<button id=main-button>Main</button>'));
  const point = await elementCenter(target.locator('button'));
  const counts = [];
  for (const type of ['mousePressed', 'mouseReleased']) counts.push(await measureInput(f, 'Input.dispatchMouseEvent', {
    type, ...point, button: 'left', clickCount: 1,
  }));
  assert.deepEqual(await target.evaluate(() => clicks), [inChild ? 'second-button' : 'main-button']);
  assert.deepEqual(await f.children[0].evaluate(() => clicks), []);
  assert.deepEqual(await (inChild ? f.page : f.children[1]).evaluate(() => clicks), []);
  await target.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id=field>');
    document.querySelector('#field').focus();
    window.keys = [];
    for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => keys.push([event.type, event.key]));
  });
  for (const type of ['keyDown', 'keyUp']) counts.push(await measureInput(f, 'Input.dispatchKeyEvent', { type, key: 'ArrowRight', code: 'ArrowRight' }));
  counts.push(await measureInput(f, 'Input.insertText', { text: 'delivered' }));
  assert.equal(await target.locator('#field').inputValue(), 'delivered');
  assert.deepEqual(await target.evaluate(() => keys), [['keydown', 'ArrowRight'], ['keyup', 'ArrowRight']]);
  t.diagnostic(JSON.stringify(counts));
  assert.deepEqual(counts, counts.map(({ command }) => ({ command, getAllFrames: 1, owners: inChild ? [0] : [] })));
});

test('Firefox dispatch owner reads: iframe replacement starts a fresh lookup', async t => {
  const f = await duplicateFrameFixture(t, 'srcdoc');
  const oldFrame = f.children[1];
  await oldFrame.evaluate(() => {
    document.body.innerHTML = '<input id=field>';
    document.querySelector('#field').focus();
  });
  const counts = [await measureInput(f, 'Input.insertText', { text: 'before' })];
  assert.equal(await oldFrame.locator('#field').inputValue(), 'before');
  await f.page.evaluate(() => {
    const old = document.querySelector('#second');
    const replacement = old.cloneNode(false);
    replacement.srcdoc = '<input id=field>';
    old.replaceWith(replacement);
  });
  const handle = await f.page.locator('#second').elementHandle();
  const replacement = await handle.contentFrame();
  await handle.dispose();
  await replacement.waitForSelector('#field');
  assert.ok(oldFrame.isDetached());
  // webNavigation assigns a new frame identity to the replacement, even at the same URL.
  f.frames.delete(8);
  f.frames.set(9, replacement);
  await replacement.locator('#field').focus();
  counts.push(await measureInput(f, 'Input.insertText', { text: 'after' }));
  assert.equal(await replacement.locator('#field').inputValue(), 'after');
  assert.notEqual((await f.backendIds('#second'))[0], f.expectedOwners[1]);
  t.diagnostic(JSON.stringify(counts));
  assert.deepEqual(counts, counts.map(({ command }) => ({ command, getAllFrames: 1, owners: [0] })));
});

test('Firefox dispatch owner reads: each nested parent is read once', async t => {
  const f = await duplicateFrameFixture(t, 'srcdoc');
  await f.children[1].evaluate(() => {
    document.body.innerHTML = `<iframe style="display:block;height:30px" srcdoc="<button id=nested-first>First</button>"></iframe>
      <iframe style="display:block;height:30px" srcdoc="<button id=nested-second>Second</button>"></iframe>`;
  });
  const nested = [];
  for (const index of [0, 1]) {
    const handle = await f.children[1].locator('iframe').nth(index).elementHandle();
    const frame = await handle.contentFrame();
    await handle.dispose();
    await frame.waitForSelector('button');
    await frame.evaluate(() => {
      window.clicks = [];
      document.addEventListener('click', event => clicks.push(event.target.id));
    });
    f.frames.set(index + 10, frame);
    nested.push(frame);
  }
  const point = await elementCenter(nested[1].locator('button'));
  const counts = [];
  for (const type of ['mousePressed', 'mouseReleased']) counts.push(await measureInput(f, 'Input.dispatchMouseEvent', {
    type, ...point, button: 'left', clickCount: 1,
  }));
  assert.deepEqual(await nested[1].evaluate(() => clicks), ['nested-second']);
  for (const frame of [f.page.mainFrame(), ...f.children, nested[0]]) assert.deepEqual(await frame.evaluate(() => clicks), []);
  t.diagnostic(JSON.stringify(counts));
  assert.deepEqual(counts, counts.map(({ command }) => ({ command, getAllFrames: 1, owners: [0, 8] })));
});

const cases = [
  { name: 'default button', html: '<form><input id=q><button id=send>Go</button></form>', submit: 'send' },
  { name: 'external first default', html: '<button form=f id=first>Go</button><form id=f><input id=q><button id=second>Later</button></form>', submit: 'first' },
  { name: 'input submit', html: '<form><input id=q><input id=send type=submit></form>', submit: 'send' },
  { name: 'input image', html: '<form><input id=q><input id=send type=image></form>', submit: 'send' },
  { name: 'single field no button', html: '<form><input id=q></form>', submit: '' },
  { name: 'two fields no button', html: '<form><input id=q><input type=number></form>', submit: null },
  { name: 'external blocking field', html: '<input form=f type=date><form id=f><input id=q></form>', submit: null },
  { name: 'disabled default before enabled button', html: '<form><input id=q><button disabled>Stop</button><button>Go</button></form>', submit: null },
  { name: 'fieldset disabled default', html: '<form><input id=q><fieldset disabled><button>Stop</button></fieldset><button>Go</button></form>', submit: null },
  { name: 'keydown cancelled', html: '<form><input id=q><button>Go</button></form>', prevent: 'keydown', submit: null },
  { name: 'keypress cancelled', html: '<form><input id=q><button>Go</button></form>', prevent: 'keypress', submit: null },
  { name: 'default click cancelled', html: '<form><input id=q><button>Go</button></form>', prevent: 'click', submit: null },
  { name: 'validation retained', html: '<form><input id=q required><button>Go</button></form>', submit: null },
  { name: 'textarea newline', html: '<form><textarea id=q></textarea><button>Go</button></form>', submit: null, newline: true },
  { name: 'contenteditable newline', html: '<form><div id=q contenteditable></div><button>Go</button></form>', submit: null, newline: true },
  { name: 'no form JS key listener', html: '<input id=q>', submit: null },
  { name: 'checkbox does not submit', html: '<form><input id=q type=checkbox><button>Go</button></form>', submit: null },
  { name: 'select does not submit', html: '<form><select id=q><option>One</option></select><button>Go</button></form>', submit: null },
  ...[1, 2, 4, 8].map(modifiers => ({ name: `modified Enter ${modifiers}`, modifiers,
    html: '<form><input id=q><button>Go</button></form>', submit: null })),
];
for (const scenario of cases) test(`Firefox implicit submission: ${scenario.name}`, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(scenario.html);
  await page.evaluate(scenario => {
    window.events = [];
    for (const type of ['keydown', 'keypress', 'keyup', 'click', 'submit']) document.addEventListener(type, event => {
      events.push({ type, id: event.target.id, submitter: event.submitter?.id || '', trusted: event.isTrusted });
      if (type === 'submit' || type === scenario.prevent) event.preventDefault();
    }, true);
    document.querySelector('#q').focus();
  }, scenario);
  for (const type of ['keyDown', 'keyUp']) await page.evaluate(firefoxPageCommand, {
    op: 'input', input: { kind: 'key', type, key: 'Enter', code: 'Enter', text: type === 'keyDown' ? '\r' : '', modifiers: scenario.modifiers || 0 },
  });
  const state = await page.evaluate(() => ({ events, text: q.value ?? q.innerText }));
  const submits = state.events.filter(event => event.type === 'submit');
  assert.deepEqual(submits.map(event => event.submitter), scenario.submit === null ? [] : [scenario.submit]);
  assert.equal(state.events.filter(event => event.type === 'keydown').length, 1);
  assert.equal(state.events.filter(event => event.type === 'keyup').length, 1);
  assert.equal(state.events.filter(event => event.type === 'keypress').length, scenario.prevent === 'keydown' || scenario.modifiers ? 0 : 1);
  if (scenario.newline) assert.ok(state.text.includes('\n'), JSON.stringify(state));
  if (scenario.submit) assert.deepEqual(state.events.filter(event => event.type === 'click').map(event => event.id), [scenario.submit]);
});

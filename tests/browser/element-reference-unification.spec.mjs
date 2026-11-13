import { test, expect } from './fixtures.mjs';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool } from '../../services/mcp-bridge/src/client.mjs';
import { startElementReferencePage } from '../support/element-reference-page.mjs';

const uidPattern = /^uid:t\d+\.[0-9a-z]{6}\.\d+$/;
function axTarget(tree, label, role = '') {
  return tree.snapshot.split('\n').find(line => line.includes(`"${label}"`) && (!role || line.includes(` ${role} `)))?.match(/target=(uid:\S+)/)?.[1];
}

test('all element readers share node UIDs, consumers accept target/legacy selector, and UID waits never rematch replacements', async () => {
  test.setTimeout(180_000);
  const fixture = await startElementReferencePage();
  const { launchIsolatedExtensionMcp, EXTENSION_PATH } = await import('../support/isolated-extension-mcp.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'qz-element-ref-package-'));
  const extensionDir = join(directory, 'extension');
  await cp(EXTENSION_PATH, extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(join(extensionDir, 'element-reference-test.js'), `import './${manifest.background.service_worker}'; import * as tools from './background/tools/runtime.js'; globalThis.referenceTestTools = tools;`);
  manifest.background.service_worker = 'element-reference-test.js';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-element-refs-', extensionDir });
  const endpoint = environment.bridge.endpoint;
  try {
    const { sessionId } = await callTool(endpoint, 'qingzhou_create_drive_session', { title: 'Verify element references' });
    const invoke = async (name, args = {}) => {
      let response;
      try { response = await callTool(endpoint, 'qingzhou_execute_tool', { sessionId, name, args: { tabRef: 'page', ...args } }); }
      catch (error) { return { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.details ? { details: error.details } : {}) }; }
      const result = response.result;
      expect(result).not.toHaveProperty('tabRef');
      if (name !== 'evaluate') return result;
      expect(response.scriptApiVersion).toBe(2);
      expect(Object.keys(result).sort()).toEqual(['context', 'ok', 'result', 'trace']);
      expect(result.context).toEqual({ qz_skills: [] });
      expect(result.ok).toBe(!response.isError);
      expect(Array.isArray(result.trace)).toBe(true);
      expect(result.trace.every(line => typeof line === 'string')).toBe(true);
      return result.result;
    };
    const script = code => invoke('evaluate', { code: `async () => { ${code} }`, timeout: 20 });
    const opened = await callTool(endpoint, 'qingzhou_execute_tool', { sessionId, name: 'open_tab', args: { url: fixture.url, tabAlias: 'page' } });
    expect(opened.result.tabRef).toBe('page');
    const nativeTabId = await environment.context.serviceWorkers()[0].evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, fixture.url);
    await expect.poll(() => environment.context.pages().some(page => page.url() === fixture.url)).toBe(true);
    const page = environment.context.pages().find(page => page.url() === fixture.url);
    await page.frameLocator('#cross').locator('#frame-action').waitFor();
    for (const name of ['read_article', 'read_dom', 'find_elements', 'list_images', 'wait_for_element']) {
      const schema = await callTool(endpoint, 'qingzhou_get_tool', { sessionId, name });
      const field = name === 'find_elements' || name === 'list_images' ? 'within' : 'target';
      expect(schema.signature).toMatch(new RegExp(`\\b${field}\\??:string`));
      expect(schema.signature).not.toMatch(/\bselector\??:/);
    }
    const controls = await invoke('get_ax_tree', { scope: 'full', depth: 12, limit: 100 });
    expect(controls.message, JSON.stringify(controls)).toBeUndefined();
    for (const [id, name] of [['overlay-toggle', 'Overlay menu'], ['detached-toggle', 'Detached menu']]) {
      const target = axTarget(controls, name, 'button');
      expect(target || '', controls.snapshot).toMatch(uidPattern);
      const clicked = await invoke('act_on_element', { target, action: 'click' });
      expect(clicked).toEqual({});
      await expect(page.locator(`#${id}`)).toBeChecked();
      await expect(page.locator(`#${id}`)).toHaveAttribute('data-input-trusted', 'true');
      expect(await invoke('inspect_element', { target })).toMatchObject({
        target: expect.stringMatching(uidPattern), tag: 'input', role: 'button', name, checked: true, attrs: { id },
        rect: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
      });
      expect(await invoke('act_on_element', { target, action: 'click' })).toEqual({});
      await expect(page.locator(`#${id}`)).not.toBeChecked();
      await expect(page.locator(`#${id}`)).toHaveAttribute('data-input-trusted', 'true');
    }
    const found = await invoke('find_elements', { target: 'body', tags: ['button', 'img'], limit: 40 });
    expect(found.message, JSON.stringify(found)).toBeUndefined();
    expect(found.results.length).toBeGreaterThanOrEqual(5);
    expect(found.results.every(item => uidPattern.test(item.target))).toBe(true);
    expect(JSON.stringify(found)).not.toContain('_elementRef');
    const alpha = found.results.find(item => item.name === 'Alpha' || item.text === 'Alpha');
    const shadow = found.results.find(item => item.name === 'Shadow action' || item.text === 'Shadow action');
    expect(alpha.target).toMatch(uidPattern);
    expect(shadow.target).toMatch(uidPattern);
    const clicked = await invoke('act_on_element', { target: alpha.target, action: 'click' });
    expect(clicked).toEqual({});
    expect(await invoke('inspect_element', { target: alpha.target })).toMatchObject({
      target: expect.stringMatching(uidPattern), tag: 'button', role: 'button', name: 'Alpha', text: 'Alpha', attrs: { id: 'alpha' },
      rect: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
    });
    const cssClick = await invoke('act_on_element', { target: 'css:#alpha', action: 'click' });
    expect(cssClick).toEqual({});
    expect(await script("return document.querySelector('#alpha').dataset.clicked;")).toBe('yes');
    const inspected = await invoke('inspect_element', { target: '#alpha' });
    expect(inspected.target).toMatch(uidPattern);
    expect(inspected).not.toHaveProperty('selector');
    expect(inspected).not.toHaveProperty('uid');
    expect(inspected.parent.target).toMatch(uidPattern);
    const scoped = await invoke('read_dom', { target: shadow.target, limit: 20 });
    expect(scoped.content).toContain('Shadow action');
    const legacy = await invoke('read_dom', { selector: shadow.target, limit: 20 });
    expect(legacy.content).toBe(scoped.content);
    const canonical = await invoke('read_dom', { target: shadow.target, selector: 'uid:unknown', limit: 20 });
    expect(canonical.content).toBe(scoped.content);
    const article = await invoke('read_article', { target: '#region', limit: 2000 });
    expect(article.text).toContain('Scoped region only');
    expect(article.text).not.toContain('Outside scope marker');
    const images = await invoke('list_images', { target: 'body' });
    expect(images.message, JSON.stringify(images)).toBeUndefined();
    expect(images.images[0].target).toMatch(uidPattern);
    expect(images.images[0]).not.toHaveProperty('uid');
    expect(images.images[0]).not.toHaveProperty('selector');
    const imageClick = await invoke('act_on_element', { target: images.images[0].target, action: 'click' });
    expect(imageClick.message, JSON.stringify(imageClick)).toBeUndefined();
    expect(await script('return document.body.dataset.imageClicked;')).toBe('yes');
    const shot = await invoke('screenshot', { target: images.images[0].target });
    expect(shot.message, JSON.stringify(shot)).toBeUndefined();
    expect(shot.method).toBeTruthy();
    const waited = await invoke('wait_for_element', { target: '#alpha', timeout: 1 });
    expect(waited.found, JSON.stringify(waited)).toBe(true);
    expect(waited.element.target).toMatch(uidPattern);
    await script("document.querySelector('#alpha').style.display='none';");
    const hidden = await invoke('wait_for_element', { target: alpha.target, state: 'hidden', timeout: 1 });
    expect(hidden, JSON.stringify(hidden)).toMatchObject({ state: 'hidden', found: false, element: null });
    expect(hidden.timedOut).toBeUndefined();
    await script("const old=document.querySelector('#alpha'); const fresh=old.cloneNode(true); fresh.style.display=''; old.replaceWith(fresh);");
    const removed = await invoke('wait_for_element', { target: alpha.target, state: 'detached', timeout: 1 });
    expect(removed, JSON.stringify(removed)).toMatchObject({ state: 'detached', found: false, element: null });
    expect(removed.timedOut).toBeUndefined();
    expect((await invoke('act_on_element', { target: alpha.target, action: 'click' })).code).toMatch(/STALE_ELEMENT_UID/);
    expect((await invoke('wait_for_element', { target: 'uid:t0.000000.999', state: 'detached', timeout: 1 })).code).toMatch(/STALE_ELEMENT_UID/);

    const invalidTarget = await invoke('read_dom', { target: 'css:[' });
    expect(invalidTarget.code, JSON.stringify(invalidTarget)).toBe('INVALID_SELECTOR');
    expect(invalidTarget.message).toBeTruthy();
    expect(invalidTarget.hint).toBeTruthy();
    expect(invalidTarget.details.target).toBe('css:[');
    expect(Object.keys(invalidTarget).every(key => ['code', 'message', 'hint', 'details'].includes(key))).toBe(true);
    expect(JSON.stringify(invalidTarget)).not.toMatch(/"(?:selector|tabId)":/);

    const syntax = await invoke('evaluate', { code: 'async () => { const value = ; }', timeout: 20 });
    expect(syntax.code, JSON.stringify(syntax)).toBe('SCRIPT_EVALUATION_FAILED');
    expect(syntax.message).toMatch(/SyntaxError/);
    expect(Object.keys(syntax).every(key => ['code', 'message', 'hint', 'details'].includes(key))).toBe(true);
    expect(syntax.details).toBeTruthy();
    expect(syntax).not.toHaveProperty('line');
    expect(syntax).not.toHaveProperty('column');

    const tree = await invoke('get_ax_tree', { scope: 'full', depth: 12, limit: 100 });
    expect(tree.message, JSON.stringify(tree)).toBeUndefined();
    for (const kind of ['same', 'cross']) {
      const target = axTarget(tree, `Frame ${kind}`, 'button');
      expect(target || '', `${kind}: ${tree.snapshot}`).toMatch(uidPattern);
      const scope = axTarget(tree, `Child document ${kind}`, 'RootWebArea');
      const frameFind = await invoke('find_elements', { within: scope, roles: ['button'], limit: 5 });
      let diagnostic;
      if (frameFind.message) diagnostic = await environment.context.serviceWorkers()[0].evaluate(async ({ tabId, target, sessionId }) => {
        const binding = await referenceTestTools.createToolRuntime({}).element.resolveElementReference(tabId, { target }, { sessionId });
        const tree = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
        const ax = await chrome.debugger.sendCommand({ tabId }, 'Accessibility.getFullAXTree');
        return { target, binding, tree, roots: ax.nodes.filter(node => node.role?.value === 'RootWebArea') };
      }, { tabId: nativeTabId, target: scope, sessionId });
      expect(frameFind.message, `${kind}: ${JSON.stringify({ frameFind, diagnostic })}`).toBeUndefined();
      expect(frameFind.results[0].target).toMatch(uidPattern);
      const named = await invoke('find_elements', { within: scope, name: `Frame ${kind}`, limit: 5 });
      expect(named.message, JSON.stringify(named)).toBeUndefined();
      expect(named.results.map(item => item.name)).toEqual([`Frame ${kind}`]);
      const action = await invoke('act_on_element', { target: frameFind.results[0].target, action: 'click' });
      expect(action.message, JSON.stringify(action)).toBeUndefined();
      await expect(page.frameLocator(`#${kind}`).locator('body')).toHaveAttribute('data-clicked', 'yes');
      const frameImage = axTarget(tree, `Frame picture ${kind}`);
      expect(frameImage, tree.snapshot).toMatch(uidPattern);
      const listed = await invoke('list_images', { target: frameImage });
      expect(listed.message, JSON.stringify(listed)).toBeUndefined();
      expect(listed.images[0].target).toMatch(uidPattern);
      const frameShot = await invoke('screenshot', { target: listed.images[0].target });
      expect(frameShot.message, JSON.stringify(frameShot)).toBeUndefined();
      expect(frameShot.method).toBeTruthy();
    }
    await callTool(endpoint, 'qingzhou_stop_session', { sessionId });
    const native = await environment.context.serviceWorkers()[0].evaluate(async url => {
      const tab = await chrome.tabs.create({ url, active: false });
      const runtime = referenceTestTools.createToolRuntime({ sessions: {
        isRunCurrent: () => true, listOwnedTabIds: () => [tab.id],
        resolveTargetTab: async ({ tabId }) => ({ ok: tabId === tab.id, tabId, ownedByCurrentTask: true }),
        updateWorkingTab: async () => {},
      } });
      const context = { sessionId: 'native-agent-audit', runId: 'native-run', source: 'agent', workingTabId: tab.id,
        runProfile: { model: { vision: true }, features: { imageInput: true, toolImages: true }, tools: { disabled: [] } } };
      try {
        let missingReference;
        try { await runtime.execute('wait_for_load', {}, undefined, context); } catch (error) { missingReference = error.code; }
        await runtime.execute('wait_for_load', { tabRef: tab.id }, undefined, context);
        const definitions = runtime.getSchemas({ runProfile: context.runProfile }).filter(item => ['act_on_screen', 'collect_images'].includes(item.function.name));
        const press = await runtime.execute('act_on_screen', { tabRef: tab.id, action: 'press', key: 'Escape', returnScreenshot: false }, undefined, context);
        const collection = await runtime.execute('collect_images', { tabRef: tab.id, table: 'native-images', targets: ['#photo'] }, undefined, context);
        const urls = await runtime.execute('collect_images', { table: 'native-url-images', urls: [`${url}pixel.png`] }, undefined, { ...context, workingTabId: null });
        return { definitions, missingReference, press: { status: press.status, code: press.code, tabId: press.tabId, tabRef: press.tabRef },
          collection: { collected: collection.collected, error: collection.message },
          urls: { collected: urls.collected, error: urls.message }, tabId: tab.id };
      } finally { await chrome.tabs.remove(tab.id); }
    }, fixture.url);
    for (const { function: schema } of native.definitions) {
      expect(schema.parameters.properties.tabId).toBeUndefined();
      expect(schema.parameters.properties.tabRef).toBeTruthy();
      if (schema.name === 'act_on_screen') expect(schema.parameters.required).toContain('tabRef');
      else expect(schema.parameters.anyOf).toContainEqual({ required: ['tabRef', 'targets'], properties: { targets: { minItems: 1 } } });
    }
    expect(native.missingReference).toBe('TAB_REF_REQUIRED');
    expect(native.press.status).toBe('completed');
    expect(native.press.tabId).toBeUndefined();
    expect(native.press.tabRef).toBeUndefined();
    expect(native.collection.collected, JSON.stringify(native.collection)).toBe(1);
    expect(native.urls.collected, JSON.stringify(native.urls)).toBe(1);
  } finally { await environment.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

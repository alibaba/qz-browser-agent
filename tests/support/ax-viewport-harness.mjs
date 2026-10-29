import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Isolated integration harness: production AX tool + production Content handlers, real Chromium layout.
// No user browser, extension profile, MCP daemon or provider settings are touched.
export async function createAxViewportHarness({ baseline = false } = {}) {
  const bundle = await build({ stdin: { contents: `export { registerAccessibilityTools } from './src/capabilities/accessibility/tools.ts'; export { withLanguage } from './src/shared/i18n/index.ts';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'ax-sources', setup(b) {
      b.onResolve({ filter: /^#sdk\// }, args => ({ path: resolve('src/sdk', args.path.slice(5) + '.ts') }));
      if (baseline) b.onLoad({ filter: /capabilities\/accessibility\/(tools|tool-messages)\.ts$/ }, args => ({ contents: execFileSync('git', ['show', `cbac588:${args.path.slice(process.cwd().length + 1)}`], { encoding: 'utf8' }), loader: 'ts' }));
    } }] });
  const { registerAccessibilityTools, withLanguage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const content = (await build({ entryPoints: ['src/content/content-script.ts'], bundle: true, write: false, format: 'iife' })).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const send = cdp.send.bind(cdp);
  const refs = new Map();
  let definition, world, sequence = 0;
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, contextId: world, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function invoke(action, args = {}, ref) {
    const payload = { ...args, action };
    if (!ref?.backendNodeId) {
      if (ref && !ref.selector) throw new Error('STALE_ELEMENT_UID');
      if (ref) Object.assign(payload, { selector: ref.selector, index: ref.index || 0 });
      return evaluate(`new Promise(resolve => globalThis.__QZ_CONTENT_MESSAGE_LISTENER(${JSON.stringify(payload)}, {}, resolve))`);
    }
    const { object } = await send('DOM.resolveNode', { backendNodeId: ref.backendNodeId, executionContextId: world, objectGroup: 'ax-test' });
    try {
      const result = await send('Runtime.callFunctionOn', { objectId: object.objectId,
        functionDeclaration: 'function(payload) { return globalThis.__qzInvoke(this, payload); }',
        arguments: [{ value: payload }], returnByValue: true, awaitPromise: true });
      return result.result.value;
    } finally { await send('Runtime.releaseObjectGroup', { objectGroup: 'ax-test' }); }
  }
  async function bind(selectors) {
    // Match the production binder: one document handle, unique selectors, sequential reads.
    const { root } = await send('DOM.getDocument', { depth: 0, pierce: true });
    const ids = [];
    for (const selector of selectors) {
      try {
        const { nodeIds } = selector ? await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }) : { nodeIds: [] };
        ids.push(nodeIds.length === 1 ? (await send('DOM.describeNode', { nodeId: nodeIds[0] })).node.backendNodeId : 0);
      } catch { ids.push(0); }
    }
    return { loaderId: 'fixture', ids };
  }
  const host = {
    registerTool: value => { definition = value; },
    ToolExecutionError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    // Measurement-only high limit; public production tool still clamps to 300.
    clampLimit: (value, min, max) => value >= 100000 ? value : Math.max(min, Math.min(max, Math.floor(value))),
    makeSnapshotId: () => `t1.s${String(++sequence).padStart(5, '0')}`,
    elementTargetForUid: uid => `uid:${uid}`,
    registerElementRef: ref => refs.set(ref.uid, ref),
    resolveElementReference: async (_tab, { target }) => {
      const ref = refs.get(target.replace(/^uid:/, ''));
      const selector = target.startsWith('css:') ? target.slice(4) : !ref?.backendNodeId ? ref?.selector || '' : '';
      return { tabId: 1, target, uid: ref?.uid, selector, index: ref?.index || 0, ref };
    },
    backendNodeIdForSelector: async (_tab, selector) => (await bind([selector])).ids[0],
    bindBackendNodes: (_tab, selectors) => bind(selectors),
    makeSessionTabTargetError: code => new Error(code),
    sendToContent: (_tab, action, args) => invoke(action, args),
    callElement: (_tab, resolved, action, args) => invoke(action, { selector: resolved.selector, index: resolved.index, ...args }, resolved.ref),
    readMainDocumentId: async () => 'fixture-document',
    withDebugger: (_tab, callback) => callback({}, send),
    elementTargetGrammar: 'Use the exact uid: target from the snapshot.',
  };
  registerAccessibilityTools(host);
  return {
    page, browser, baseline,
    definition: () => withLanguage('en', () => ({ name: definition.name, description: definition.description, parameters: definition.parameters })),
    async goto(url, { waitUntil = 'load', timeout = 60000, settleMs = 0 } = {}) {
      refs.clear();
      const response = await page.goto(url, { waitUntil, timeout });
      // Public sites may replace the document during startup. Bind Content only after that settles.
      if (settleMs) await page.waitForTimeout(settleMs);
      const { frameTree } = await send('Page.getFrameTree');
      world = (await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'qz-ax-test' })).executionContextId;
      await evaluate(`globalThis.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } } }; ${content}`);
      return { status: response?.status(), url: page.url() };
    },
    reference: target => refs.get(String(target).replace(/^uid:/, '')),
    snapshot: args => definition.execute({ tabId: 1, ...args }, undefined, { sessionId: 'isolated-ax-measurement', runId: 'measure' }),
    async action({ target, action, value }) {
      const ref = refs.get(String(target).replace(/^uid:/, ''));
      if (!ref) return { code: 'STALE_ELEMENT_UID', error: 'Read a new snapshot and use its exact target.' };
      return invoke('actOnElement', { elementAction: action, value }, ref);
    },
    scroll: args => invoke('scrollPage', args),
    close: () => browser.close(),
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { Validator } from '@cfworker/json-schema';
import { createToolRegistry } from '../../src/background/tools/registry.js';
import { registerWaitTools } from '../../src/capabilities/wait/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

globalThis.chrome = { runtime: { getURL: path => `chrome-extension://fixture/${path}` },
  storage: { local: { async get() { return {}; } } }, tabs: {
    async get(id) { return { id, url: 'https://example.test/' }; },
    async sendMessage(_id, message) {
      if (message.action === 'ping') return { ok: true, contentType: 'text/html', elementRefs: 1 };
      assert.equal(message.action, 'elementPresence');
      assert.equal(message.selector, '#chosen'); assert.equal(message.queryOnly, true);
      return { found: true };
    },
  } };
const { createToolRuntime, resolveToolDefinition, getToolSchemas } = await import('../../src/background/tools/runtime.js');

function runtimeFixture() {
  const targets = [];
  const runtime = createToolRuntime({ sessions: {
    isRunCurrent: () => true, listOwnedTabIds: () => [5, 6],
    resolveTargetTab: async input => { targets.push(input); return { ok: true, tabId: input.tabId }; },
  } });
  return { runtime, targets, context: { sessionId: 's', runId: 'run', workingTabId: 5 } };
}

test('public element schemas hide selector, while legacy input is canonicalized before scheduling and validation', async () => {
  const f = runtimeFixture(), registry = createToolRegistry(), seen = [];
  const names = ['read_article', 'read_dom', 'find_elements', 'list_images', 'wait_for_element'];
  const searchRoot = name => name === 'find_elements' || name === 'list_images' ? 'within' : 'target';
  const schemas = getToolSchemas();
  for (const name of names) {
    const definition = resolveToolDefinition(name);
    const schema = schemas.find(item => item.function.name === name).function.parameters;
    assert.equal(schema.properties.selector, undefined, name);
    assert.equal(schema.properties[searchRoot(name)].type, 'string', name);
    if (searchRoot(name) === 'within') assert.equal(schema.properties.target, undefined, `${name} target only names an element`);
    if (name === 'wait_for_element') {
      const validator = new Validator(structuredClone(schema));
      for (const reference of [{ target: 'css:#chosen' }, { locator: { role: 'button' } }]) {
        assert.equal(validator.validate({ tabRef: 5, ...reference }).valid, true);
      }
      assert.equal(validator.validate({ tabRef: 5 }).valid, false);
      assert.equal(validator.validate({ tabRef: 5, target: 'css:#chosen', locator: { role: 'button' } }).valid, false);
    }
    registry.forCapability('reference-test')({ ...definition, execute: args => { seen.push(args); return { ok: true }; } });
  }
  const ref = f.runtime.element.registerElementBinding({ tabId: 5, sessionId: 's', backendNodeId: 42, loaderId: 'doc', snapshotId: 't5.000001' });
  const context = { ...f.context, toolRegistrySnapshot: registry.snapshot() };
  const sources = schemas.find(item => item.function.name === 'read_article').function.parameters.properties.source.enum;
  assert.ok(sources.includes('target')); assert.ok(!sources.includes('selector'));
  await f.runtime.execute('read_article', { tabRef: 5, source: 'selector', selector: ref.target, limit: 100 }, undefined, context);
  assert.equal(seen.at(-1).source, 'target');
  assert.equal(seen.at(-1).target, ref.target);
  for (const name of names) {
    const field = searchRoot(name), limit = name === 'wait_for_element' ? {} : { limit: 100 };
    await f.runtime.execute(name, { tabRef: 5, selector: ref.target, ...limit }, undefined, context);
    assert.equal(seen.at(-1)[field], ref.target);
    assert.equal(Object.hasOwn(seen.at(-1), 'selector'), false);
    await f.runtime.execute(name, { tabRef: 5, [field]: '#chosen', selector: 'uid:unknown', ...limit }, undefined, context);
    assert.equal(seen.at(-1)[field], '#chosen', `canonical ${field} wins over a legacy alias`);
    if (field === 'within') {
      await f.runtime.execute(name, { tabRef: 5, target: ref.target, ...limit }, undefined, context);
      assert.equal(seen.at(-1).within, ref.target, 'the retired target spelling resolves to within');
      assert.equal(Object.hasOwn(seen.at(-1), 'target'), false);
    }
    const policy = f.runtime.getBatchTabPolicy(name, { tabRef: 5, selector: ref.target }, context);
    if (name === "wait_for_element") assert.equal(policy.kind, "observe", "state waits release the mutation lane");
    else assert.equal(policy.tabId, 5);
    await assert.rejects(f.runtime.execute(name, { tabRef: 5, [field]: 'uid:unknown', ...limit }, undefined, context), { code: 'STALE_ELEMENT_UID' });
  }
});

test('one registry format separates frames/documents and preserves older image observations', async () => {
  const f = runtimeFixture(), register = f.runtime.element.registerElementBinding;
  const base = { sessionId: 's', tabId: 5, loaderId: 'doc-a', backendNodeId: 42, snapshotId: 't5.000001', selector: '#image', imageSrc: 'https://example.test/old.png' };
  const first = register(base);
  assert.match(first.target, /^uid:t5\.[0-9a-z]{6}\.\d+$/);
  assert.equal(register(base).uid, first.uid, 'partial snapshots keep the same node identity');
  const child = register({ ...base, frameId: 'child' });
  const replaced = register({ ...base, loaderId: 'doc-b' });
  const later = register({ ...base, snapshotId: 't5.000002', imageSrc: 'https://example.test/new.png' });
  assert.equal(new Set([first.uid, child.uid, replaced.uid, later.uid]).size, 4);
  const old = await f.runtime.element.resolveElementReference(5, { target: first.target }, f.context);
  assert.equal(old.ref.imageSrc, base.imageSrc, 'another reader must not overwrite a list_images source constraint');
  const fallback = register({ ...base, backendNodeId: 0 });
  assert.equal(fallback.uid, undefined);
  assert.equal(fallback.target, 'css:#image');
  for (const target of ['#image', 'css:#image']) assert.equal((await f.runtime.element.resolveElementReference(5, { target }, f.context)).selector, '#image');
});

test('UID waits retain opaque host authority, distinguish removal from unknown references, and cancel polling', async () => {
  const definitions = new Map(), controller = new AbortController();
  const authority = Symbol('authority');
  const context = Object.defineProperty({ signal: controller.signal }, authority, { value: 7 });
  let observationContext;
  let unavailable = false, calls = 0;
  registerWaitTools({ registerTool: definition => definitions.set(definition.name, definition),
    getToolRuntimeDependencies: () => ({}), captureTabScreenshot: async () => ({}), sendToContent: async () => ({}),
    element: {
      resolveSelectorTarget: async (_tabId, target, _index, received) => {
        assert.equal(Object.getPrototypeOf(received), context);
        assert.equal(received[authority], 7, 'observation inherits non-enumerable host authority');
        assert.notEqual(received.signal, controller.signal, 'the observation also carries its own deadline');
        observationContext = received;
        if (target === 'uid:unknown') throw new ToolExecutionError('STALE_ELEMENT_UID', 'unknown');
        return { tabId: 5, uid: 'node', target, selector: '', ref: { backendNodeId: 42 } };
      },
      callElement: async (_tabId, _binding, action, args, received) => {
        assert.equal(received, observationContext); assert.equal(received[authority], 7);
        assert.equal(action, 'elementPresence'); assert.equal(args.visibleOnly, true); calls++;
        if (unavailable) throw new ToolExecutionError('STALE_ELEMENT_UID', 'gone', { reason: 'node_unavailable' });
        return { found: true, element: { selector: '#node' } };
      },
      addElementTargetsToFindResult: async item => ({ ...item, uid: 'fresh', target: 'uid:fresh' }),
      elementTargetForSelector: selector => `css:${selector}`,
    },
  });
  const wait = definitions.get('wait_for_element');
  const found = await wait.execute({ target: 'uid:node', timeout: 1 }, controller.signal, context);
  assert.equal(found.element.target, 'uid:fresh');
  unavailable = true;
  assert.equal((await wait.execute({ target: 'uid:node', state: 'hidden', timeout: 1 }, controller.signal, context)).timedOut, undefined);
  await assert.rejects(wait.execute({ target: 'uid:unknown', state: 'hidden', timeout: 1 }, controller.signal, context), { code: 'STALE_ELEMENT_UID' });
  unavailable = false;
  const polling = wait.execute({ target: 'uid:node', state: 'hidden', timeout: 10, intervalSeconds: 1 }, controller.signal, context);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(polling, error => error.code === 'OPERATION_ABORTED' || error.name === 'AbortError');
  const settledCalls = calls; await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, settledCalls);
});

test('shared rect contract canonicalizes legacy boxes across element observations', async () => {
  const { toRect, createElementObservation } = await import('../../src/shared/contracts/element-observation.js');
  const expected = { x: 1, y: 2, width: 30, height: 40 };
  assert.deepEqual(toRect({ x: '1', y: 2, w: 30, h: 40 }), expected);
  assert.deepEqual(createElementObservation({ rect: { x: 1, y: 2, w: 30, h: 40 } }, 'uid:t5.000001.1').rect, expected);
  assert.deepEqual(toRect({ x: Infinity, y: 'invalid', w: 30, h: 40 }), { ...expected, x: 0, y: 0 });
  assert.ok(Number.isNaN(toRect({}, NaN).width), 'screenshot validation retains invalid geometry');
});

test('native click readiness failure contains only public error fields', async () => {
  const inspect = { selector: '#disabled', disabled: true, visible: true,
    rect: { x: 1, y: 2, w: 30, h: 40 }, _elementRef: undefined };
  const sendMessage = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, params) => params.action === 'ping' ? { ok: true, contentType: 'text/html', elementRefs: 1 } : inspect;
  try {
    await assert.rejects(resolveToolDefinition('act_on_element').execute({
      tabId: 5, target: 'css:#disabled', action: 'click', timeout: 0.05,
    }, undefined, {}), error => {
      const result = JSON.parse(JSON.stringify(error));
      assert.deepEqual(Object.keys(result).sort(), ['code', 'details', 'hint', 'message']);
      assert.equal(result.code, 'ELEMENT_NOT_READY');
      assert.deepEqual(result.details, { target: 'css:#disabled', reason: 'element is disabled' });
      assert.match(result.hint, /Inspect the target/);
      assert.doesNotMatch(JSON.stringify(result), /selector|tabId|originalElement|"w"|"h"/);
      return true;
    });
  } finally { chrome.tabs.sendMessage = sendMessage; }
});

test('the element binding converts Content query failures at its owned boundary', async () => {
  const f = runtimeFixture();
  const failure = await f.runtime.element.addElementTargetsToFindResult({
    code: 'INVALID_ELEMENT_TARGET', error: 'Invalid target syntax',
    details: { target: 'css:[', selector: '[', tabId: 5 }, element: { selector: '[' },
  }, 5, f.context);
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'details', 'hint', 'message']);
  assert.deepEqual(failure.details, { target: 'css:[' });
  assert.match(failure.hint, /target/);
  assert.doesNotMatch(JSON.stringify(failure), /selector|tabId/);
});

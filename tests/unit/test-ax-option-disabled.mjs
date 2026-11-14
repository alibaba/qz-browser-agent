import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const originalChrome = globalThis.chrome, debuggerEvents = [];
globalThis.chrome = {
  tabs: { get: async id => ({ id, url: 'https://example.test/', status: 'complete' }) },
  scripting: { executeScript: async () => [{ result: true }] },
  debugger: { onEvent: { addListener: listener => debuggerEvents.push(listener) } },
};
after(() => { globalThis.chrome = originalChrome; });
const { registerAccessibilityTools } = await import('../../src/capabilities/accessibility/tools.js');
const { ToolExecutionError } = await import('../../src/background/tools/arguments.js');
const { forgetChildFrames } = await import('../../src/background/tools/child-frames.js');
const property = (name, value) => ({ name, value: { value } });
const node = (id, role, disabled) => ({ nodeId: String(id), backendDOMNodeId: id, parentId: 'root',
  role: { value: role }, name: { value: `Node ${id}` }, properties: disabled === undefined ? [] : [property('disabled', disabled)] });
const tree = (nodes, root = 'root', documentId = 1000) => [
  { nodeId: root, backendDOMNodeId: documentId, role: { value: 'RootWebArea' }, childIds: nodes.map(n => n.nodeId) },
  ...nodes.map(n => ({ ...n, parentId: root })),
];
const identity = (id, nodeType = 1, loaderId = 'loader') => ({ type: 'node', value: { backendNodeId: id, nodeType, loaderId } });
const rows = (ids, values = [], root = 1000, loader = 'loader', rootType = 9) => ({ result: { deepSerializedValue: {
  type: 'array', value: [identity(root, rootType, loader), ...ids.map((id, i) => ({ type: 'array', value: [identity(id, 1, loader),
    { type: values[i] === null ? 'null' : typeof (i in values ? values[i] : false), value: i in values ? values[i] : false }],
  }))],
} } });
function harness(nodes, handlers = {}) {
  const calls = [], refs = [], partials = [], uids = new Map();
  const responses = {
    'Accessibility.getFullAXTree': () => ({ nodes: structuredClone(nodes) }),
    'Page.getFrameTree': () => ({}),
    'DOM.resolveNode': ({ backendNodeId }) => ({ object: { objectId: `object-${backendNodeId}` } }),
    'Runtime.callFunctionOn': params => params.serializationOptions ? rows(nodes.slice(1).map(n => n.backendDOMNodeId)) : { result: { value: true } },
    'Runtime.releaseObjectGroup': () => ({}), ...handlers,
  };
  const send = async (method, params = {}) => { calls.push({ method, params });
    if (!responses[method]) throw new Error(`Unexpected CDP: ${method}`); return responses[method](params); };
  let definition;
  registerAccessibilityTools({ registerTool: value => { definition = value; }, ToolExecutionError,
    clampLimit: (value, min, max) => Math.max(min, Math.min(value, max)), makeSnapshotId: () => 'snapshot', elementTargetForUid: uid => `uid:${uid}`,
    registerElementBinding: ref => { const key = `${ref.frameId || ''}:${ref.backendNodeId}`;
      if (!uids.has(key)) uids.set(key, `snapshot.${uids.size}`); const bound = { ...ref, uid: uids.get(key), target: `uid:${uids.get(key)}` }; refs.push(bound); return bound; },
    bindElementReferences: async () => [], sendToContent: async () => ({ title: 'Page', url: 'https://example.test/', actions: [] }),
    withDebugger: async (_id, fn) => fn({}, send), elementTargetGrammar: 'target grammar',
  });
  return { calls, refs, partials, send, run: signal => definition.execute({ tabId: 8, scope: 'full' }, signal, {
    sessionId: 'owner', reportPartial: result => partials.push(result),
  }) };
}
const callsFor = (h, method) => h.calls.filter(call => call.method === method).map(call => call.params);
function assertDisabled(result, id, disabled) { const line = result.snapshot.split('\n').find(line => line.includes(`"Node ${id}"`));
  assert.ok(line, result.snapshot); assert.equal(/\bdisabled\b/.test(line), disabled, line); }
function assertReleased(h) { const groups = callsFor(h, 'DOM.resolveNode').map(p => p.objectGroup);
  assert.ok(groups.length); assert.match(groups[0], /^qz-ax-option-disabled-/); assert.ok(groups.every(g => g === groups[0]));
  assert.deepEqual(callsFor(h, 'Runtime.releaseObjectGroup'), [{ objectGroup: groups[0] }]); }

test('only disabled option/optgroup flags change; batch preserves other flags, counts, partials and UIDs', async () => {
  const nodes = tree([node(1, 'option', true), node(2, 'optgroup', true), node(3, 'button', true), node(4, 'combobox', true),
    node(5, 'group', true), node(6, 'option'), node(7, 'optgroup', false)]);
  nodes[1].properties.push(property('selected', true));
  const h = harness(nodes), result = await h.run();
  assert.deepEqual(callsFor(h, 'DOM.resolveNode').map(p => p.backendNodeId), [1000], 'resolve the original AX document once');
  for (const id of [1, 2, 6, 7]) assertDisabled(result, id, false);
  for (const id of [3, 4, 5]) assertDisabled(result, id, true);
  assert.match(result.snapshot, /target=uid:snapshot\.1 option "Node 1" selected/);
  assert.deepEqual(h.refs.slice(-8).map(ref => ref.uid), Array.from({ length: 8 }, (_, i) => `snapshot.${i}`));
  assert.equal(result.nodeCount, 8); for (const partial of h.partials) assertDisabled(partial, 1, false);
  const serialized = callsFor(h, 'Runtime.callFunctionOn').filter(p => p.serializationOptions);
  assert.equal(serialized.length, 1);
  assert.match(serialized[0].functionDeclaration, /element\.matches\(':disabled'\) \|\| !!element\.closest\('select:disabled, optgroup:disabled, \[aria-disabled="true"\]'\)/);
  assert.doesNotMatch(serialized[0].functionDeclaration, /querySelector/);
  assertReleased(h);
});
test('zero candidates makes zero correction calls and never adds disabled', async () => {
  const h = harness(tree([node(1, 'option'), node(2, 'optgroup', false), node(3, 'button', true)]));
  const result = await h.run(); assert.deepEqual(h.calls.map(c => c.method), ['Page.getFrameTree', 'Accessibility.getFullAXTree', 'Page.getFrameTree']);
  assertDisabled(result, 1, false); assertDisabled(result, 2, false); assertDisabled(result, 3, true);
});
test('only a strictly false native boolean clears disabled', async () => {
  const values = [false, true, 0, '', undefined, null, 'false'];
  const h = harness(tree(values.map((_, i) => node(i + 1, 'option', true))), {
    'Runtime.callFunctionOn': p => p.serializationOptions ? rows(values.map((_, i) => i + 1), values) : { result: { value: true } },
  });
  const result = await h.run(); values.forEach((v, i) => assertDisabled(result, i + 1, v !== false)); assertReleased(h);
});
test('missing, detached and failed nodes retain disabled while confirmed nodes clear; cleanup failure is quiet', async () => {
  const nodes = tree(Array.from({ length: 6 }, (_, i) => node(i + 1, 'option', true))); delete nodes[6].backendDOMNodeId;
  const h = harness(nodes, {
    'DOM.resolveNode': ({ backendNodeId: id }) => { if (id === 1) throw new Error('Node detached'); return id === 2 ? {} : { object: { objectId: `object-${id}` } }; },
    'Runtime.callFunctionOn': p => p.serializationOptions ? rows([3, 4, 5], [null, null, false]) : { result: { value: true } },
    'Runtime.releaseObjectGroup': () => { throw new Error('Session gone'); },
  });
  const result = await h.run(); for (const id of [1, 2, 3, 4, 6]) assertDisabled(result, id, true); assertDisabled(result, 5, false); assertReleased(h);
});
for (const method of ['DOM.resolveNode', 'Runtime.callFunctionOn']) test(`${method} unavailable is fail-closed and cleans up`, async () => {
  const h = harness(tree([node(1, 'option', true), node(2, 'optgroup', true)]), { [method]: () => { throw new Error(`Unsupported: ${method}`); } });
  const result = await h.run(); assertDisabled(result, 1, true); assertDisabled(result, 2, true); assertReleased(h);
});
for (const [name, response] of [
  ['Firefox without deep serialization', { result: { value: [] } }], ['exceptionDetails', { ...rows([1]), exceptionDetails: { text: 'Exception' } }],
  ['different document', rows([1], [], 2000)], ['wrong loader', rows([1], [], 1000, '')],
  ['truncated response', { result: { deepSerializedValue: { type: 'array' } } }],
]) test(`${name} retains disabled`, async () => {
  const h = harness(tree([node(1, 'option', true)]), { 'Runtime.callFunctionOn': () => response });
  assertDisabled(await h.run(), 1, true); assertReleased(h);
});
for (const response of [{ result: { value: false } }, { result: { value: 1 } }, { result: { value: true }, exceptionDetails: {} }]) {
  test('navigation or failed document revalidation discards staged corrections', async () => {
    const h = harness(tree([node(1, 'option', true)]), { 'Runtime.callFunctionOn': p => p.serializationOptions ? rows([1]) : response });
    assertDisabled(await h.run(), 1, true); assertReleased(h);
  });
}
for (const code of ['OPERATION_ABORTED', 'BROWSER_PERMISSION_REQUIRED', 'SESSION_TAB_FOREIGN']) test(`${code} during revalidation is fail-closed`, async () => {
  const h = harness(tree([node(1, 'option', true)]), { 'Runtime.callFunctionOn': p => {
    if (p.serializationOptions) return rows([1]); throw Object.assign(new Error(code), { code });
  } });
  assertDisabled(await h.run(), 1, true); assertReleased(h);
});
test('cancellation during serialization discards corrections before the tool rejects and releases the group', async () => {
  const controller = new AbortController();
  const h = harness(tree([node(1, 'option', true)]), { 'Runtime.callFunctionOn': () => { controller.abort(new Error('cancel')); return rows([1]); } });
  await assert.rejects(h.run(controller.signal), /cancel/); assert.equal(h.partials.length, 0); assertReleased(h);
});
test('an unreturned candidate in an already visited root terminates conservatively', async () => {
  const h = harness(tree([node(1, 'option', true), node(2, 'option', true), node(3, 'option', true)]), { 'Runtime.callFunctionOn': p => p.serializationOptions ? rows([1]) : { result: { value: true } } });
  const result = await h.run(); assertDisabled(result, 1, false); assertDisabled(result, 2, true); assertDisabled(result, 3, true); assertReleased(h);
  assert.equal(callsFor(h, 'Runtime.callFunctionOn').length, 3);
});

test('main, local iframe and OOPIF use their original documents, sends and groups despite ID collisions', async () => {
  const remoteCalls = [];
  const remote = async (method, params = {}) => {
    remoteCalls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'remote', loaderId: 'remote-loader' } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes: tree([node(1, 'option', true)]) };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'remote-document' } };
    if (method === 'Runtime.callFunctionOn') return params.serializationOptions ? rows([1], [true], 1000, 'remote-loader') : { result: { value: true } };
    if (method === 'Runtime.releaseObjectGroup') return {};
    throw new Error(`Unexpected child CDP: ${method}`);
  };
  const main = tree([node(1, 'option', true), node(10, 'Iframe'), node(20, 'Iframe')]);
  const h = harness(main, {
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'local' } }] } }),
    'Accessibility.getFullAXTree': ({ frameId }) => ({ nodes: structuredClone(frameId === 'local' ? tree([node(2, 'option', true)], 'local-root', 2000) : main) }),
    'DOM.getFrameOwner': ({ frameId }) => ({ backendNodeId: frameId === 'local' ? 10 : 20 }),
    'Runtime.callFunctionOn': p => !p.serializationOptions ? { result: { value: true } }
      : p.objectId === 'object-2000' ? rows([2], [], 2000, 'local-loader') : rows([1]),
    'Target.setAutoAttach': () => { for (const listener of debuggerEvents) listener({ tabId: 8 }, 'Target.attachedToTarget', {
      sessionId: 'remote-session', targetInfo: { type: 'iframe', targetId: 'remote', parentFrameId: 'main' },
    }); return {}; },
  });
  h.send.tabId = 8; h.send.inSession = sessionId => { assert.equal(sessionId, 'remote-session'); return remote; };
  try {
    const result = await h.run(), options = result.snapshot.split('\n').filter(line => /\boption\b/.test(line));
    assert.equal(options.length, 3); assert.deepEqual(options.map(line => /disabled/.test(line)), [false, false, true]);
    assert.deepEqual(callsFor(h, 'DOM.resolveNode').map(p => p.backendNodeId), [1000, 2000]);
    const child = { calls: remoteCalls }; assert.deepEqual(callsFor(child, 'DOM.resolveNode').map(p => p.backendNodeId), [1000]); assertReleased(child);
    const groups = [...callsFor(h, 'DOM.resolveNode'), ...callsFor(child, 'DOM.resolveNode')].map(p => p.objectGroup);
    assert.equal(new Set(groups).size, 3); assert.deepEqual(callsFor(h, 'Runtime.releaseObjectGroup'), groups.slice(0, 2).map(objectGroup => ({ objectGroup })));
    assert.ok(h.refs.some(ref => ref.frameId === 'remote' && ref.backendNodeId === 1));
  } finally { forgetChildFrames(8); }
});

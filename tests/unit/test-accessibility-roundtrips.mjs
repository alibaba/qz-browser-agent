import assert from 'node:assert/strict';
import { registerAccessibilityTools } from '../../src/capabilities/accessibility/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';
import { runToolWithTimeout } from '../../src/background/tools/tool-timeout.js';

const node = (id, backend, role, name, parent, children = []) => ({ nodeId: id, backendDOMNodeId: backend, role: { value: role }, name: { value: name }, parentId: parent, childIds: children });
const main = [node('root', 1, 'RootWebArea', 'Page', undefined, ['group', 'f1', 'f2']),
  node('group', 2, 'group', 'Actions', 'root'), node('f1', 10, 'Iframe', 'First', 'root'), node('f2', 20, 'Iframe', 'Second', 'root')];
const actions = ['Alpha', 'Beta', 'Gamma'].map((text, index) => ({ selector: `#a${index}`, role: 'button', text }));
let definition;
let describes = 0, active = 0, peak = 0;
const refs = [];
let hangChild = false, releaseChild;
const send = async (method, params = {}) => {
  if (hangChild && method === 'Accessibility.getFullAXTree' && params.frameId === 'two') {
    await new Promise(resolve => { releaseChild = resolve; });
  }
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, params.frameId === 'one' ? 4 : 1));
  active--;
  if (method === 'DOM.describeNode') {
    describes++;
    if (params.backendNodeId) return { node: { backendNodeId: params.backendNodeId, parentId: 200 } };
    if (params.nodeId === 200) return { node: { backendNodeId: 2, parentId: 100, children: [3, 4, 5].map(backendNodeId => ({ backendNodeId })) } };
    if (params.nodeId === 100) return { node: { backendNodeId: 1 } };
  }
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: ['one','two'].map(id => ({ frame: { id, loaderId: `${id}-loader` } })) } };
  if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'one' ? 10 : 20 };
  if (method === 'Accessibility.getFullAXTree') return { nodes: params.frameId
    ? [node('document', 1, 'RootWebArea', params.frameId, undefined, ['button']), node('button', 2, 'button', `${params.frameId} button`, 'document')]
    : main };
  return {};
};
registerAccessibilityTools({
  registerTool: value => { definition = value; }, ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(value, max)),
  makeSnapshotId: () => 'snapshot', elementTargetForUid: uid => `uid:${uid}`,
  registerElementRef: ref => refs.push(ref), readMainDocumentId: async () => 'doc',
  bindBackendNodes: async () => ({ loaderId: 'main-loader', ids: [3,4,5] }),
  sendToContent: async () => ({ title: 'Page', url: 'https://example.test/', actions }),
  withDebugger: async (_id, fn) => fn({}, send), elementTargetGrammar: 'target grammar',
});
const result = await definition.execute({ tabId: 8, scope: 'full' }, undefined, { sessionId: 'owner' });
assert.equal(result.snapshot, `target=uid:snapshot.0 RootWebArea "Page"
 target=uid:snapshot.1 group "Actions"
  target=uid:snapshot.2 button "Alpha"
  target=uid:snapshot.3 button "Beta"
  target=uid:snapshot.4 button "Gamma"
 target=uid:snapshot.5 Iframe "First"
  target=uid:snapshot.6 RootWebArea "one"
   target=uid:snapshot.7 button "one button"
 target=uid:snapshot.8 Iframe "Second"
  target=uid:snapshot.9 RootWebArea "two"
   target=uid:snapshot.10 button "two button"`);
assert.deepEqual([result.nodeCount, result.semanticNodeCount, result.returnedNodeCount, result.outlineTruncated], [8, 11, 11, false]);
assert.deepEqual(refs.map(ref => ref.frameId || 'main'), ['main','main','main','main','main','main','one','one','main','two','two']);
// The locked sequential baseline used nine descriptions; shared parents now cost two total.
assert.equal(describes, 5);
assert.ok(peak > 1 && peak <= 4, `bounded concurrent CDP work: ${peak}`);

hangChild = true;
const partial = await runToolWithTimeout('get_ax_tree', (signal, reportPartial) => definition.execute(
  { tabId: 8, scope: 'full' }, signal, { sessionId: 'owner', signal, reportPartial }),
undefined, 50, async stage => ({ ...stage.result, incomplete: { reason: 'timeout', pending: stage.pending } }), {});
assert.match(partial.snapshot, /button "Alpha"/);
assert.doesNotMatch(partial.snapshot, /two button/);
assert.match(partial.snapshot, /one button/, 'completed child frames remain available too');
assert.match(partial.incomplete.pending, /child frames: two/);
const beforeRelease = refs.length;
releaseChild();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(refs.length, beforeRelease, 'an expired read cannot replace the returned partial UID bindings');

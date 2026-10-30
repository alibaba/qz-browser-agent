import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionTabs } from '../../src/background/session/tabs.js';
import { normalizeSessionRuntime } from '../../src/background/session/runtime-reducer.js';
import { createToolRegistry } from '../../src/background/tools/registry.js';
import { getActiveSkillToolSchemasSync, getSkillToolParameters, prepareSkillToolRegistryFromSkills } from '../../src/background/skills/skill-tool-runtime.js';
import { QINGZHOU_SKILL_FORMAT, QINGZHOU_SKILL_SCHEMA_VERSION } from '../../src/shared/skills/skill-utils.js';
import { SKILL_MANIFEST_FORMAT, SKILL_MANIFEST_SCHEMA_VERSION } from '../../src/shared/skills/skill-manifest.js';
import { planTabBatch } from '../../src/background/tools/tab-batch.js';
import { resolveTabReference } from '../../src/background/tools/tab-reference.js';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';
globalThis.chrome = { runtime: { getURL: path => `chrome-extension://test/${path}` }, storage: { local: {
  async get() { return {}; }, async set() {}, async remove() {},
} } };
const { createToolRuntime, resolveToolDefinition } = await import('../../src/background/tools/runtime.js');
const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
const open = (alias, extra = {}) => call(`open-${alias}`, 'open_tab', { tabAlias: alias, ...extra });
const read = (ref, extra = {}) => call(`read-${ref}`, 'read_ref', { tabRef: ref, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ metadataReady = async () => {}, skillToolRegistrySnapshot } = {}) {
  const states = { one: { ownedTabIds: [] }, two: { ownedTabIds: [] } }, tabs = new Map(), events = [], executed = [];
  const metadata = { one: { id: 'one' }, two: { id: 'two' } };
  const abort = new AbortController(); let runId = 'run1', next = 100, gate, fail = false, partial = false;
  let sessions;
  const supervisor = { getRuntime: id => states[id], runtimeEntries: () => Object.entries(states),
    setRuntime(id, state) { states[id] = state; return state; }, isRunCurrent: (_id, run) => run === runId && !abort.signal.aborted };
  const tabsApi = { async get(id) { if (!tabs.has(id)) throw new Error('closed'); return { ...tabs.get(id) }; },
    async remove(id) { tabs.delete(id); await sessions.handleTabRemoved(id); }, async query() { return [...tabs.values()]; } };
  chrome.tabs = tabsApi;
  const options = { supervisor, tabsApi, storage: chrome.storage.local, getSessions: async () => { await metadataReady(); return metadata; },
    setRuntime(id, patch) { Object.assign(states[id] ||= {}, patch); return states[id]; }, persistRuntime: async () => {},
    ensureTabGroupForWindow: async () => null, loadSecurityGuardrails: async () => ({}), logger: {warn(){}, debug(){}}, };
  sessions = createSessionTabs(options);
  const registry = createToolRegistry(), register = registry.forCapability('ref-fixture');
  register({ name: 'open_tab', description: 'open', workingTab: 'created', behavior: { parallelOpen: true },
    parameters: { type:'object', properties:{tabAlias:{type:'string'}} },
    async execute(args, signal, context) {
      executed.push({ name:'open', ...args });
      const tab = { id: ++next, url:`https://example.test/${next}`, title: args.tabAlias, windowId:1 };
      tabs.set(tab.id, tab);
      if (context.prepareCreatedTab) await context.prepareCreatedTab(tab);
      else await sessions.updateWorkingTab({ sessionId:context.sessionId,runId:context.runId,signal,tab,claim:true });
      if (gate) await gate;
      if (fail) throw new Error('opening failed');
      return { id:tab.id, ...(partial ? {incomplete:{reason:'timeout'}} : {}) };
    } });
  register({ name:'read_ref', description:'read', page:'tab', behavior:{parallelRead:true},
    parameters:{type:'object',properties:{tabId:{type:'number'},target:{type:'string'}},required:['tabId']},
    execute(args){ executed.push({name:'read',...args}); return {tabId:args.tabId}; } });
  register({ name:'close_ref', description:'close', page:'tab',behavior:{parallelTab:true},
    parameters:{type:'object',properties:{tabId:{type:'number'}},required:['tabId']},
    async execute(args){await tabsApi.remove(args.tabId);return {closed:true};} });
  if (skillToolRegistrySnapshot) register({ ...resolveToolDefinition('run_skill_script'),
    execute(args) {
      executed.push({ name: 'skill', ...args });
      return { ok: true, hasResult: true, result: { tabId: args.tabId } };
    } });
  const runtime = createToolRuntime({ sessions: {...sessions,isRunCurrent:supervisor.isRunCurrent} });
  const agent = new Agent('one', createTestAgentOptions({tools:runtime}));
  agent._toolRegistrySnapshot=registry.snapshot(); agent._currentRunId=runId; agent._emit=e=>events.push(e);
  agent._skillToolRegistrySnapshot = skillToolRegistrySnapshot;
  const context = language => ({sessionId:'one',runId,toolRegistrySnapshot:registry.snapshot(language),
    skillToolRegistrySnapshot, workingTabId: states.one?.workingTabId});
  return {states,metadata,tabs,sessions,options,events,executed,runtime,abort,agent,context,
    execute:(name,args)=>runtime.execute(name,args,abort.signal,context()),
    run:items=>agent._executeToolCalls(items,abort.signal),
    setGate(value){gate=value;},setFail(value){fail=value;},setPartial(value){partial=value;},
    nextRun(){runId='run2';agent._currentRunId=runId;},
  };
}

const skillToolRegistrySnapshot = prepareSkillToolRegistryFromSkills([{
  name: 'tab-reference-skill', scope: 'resident',
  format: QINGZHOU_SKILL_FORMAT, schemaVersion: QINGZHOU_SKILL_SCHEMA_VERSION,
  resources: [
    { path: 'plugin.json', type: 'json', content: JSON.stringify({
      format: SKILL_MANIFEST_FORMAT, schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION, id: 'tab-skill',
      tools: [
        { name: 'page', runtime: 'page' }, { name: 'default' },
        { name: 'inner', runtime: 'inner' }, { name: 'host', runtime: 'host' },
        { name: 'mcp', runtime: 'mcp', mcp: { server: 'fixture', tool: 'read' } },
        { name: 'no_page', runtime: 'page', needsPage: false },
      ].map(tool => ({ script: 'scripts/read.js', parameters: { type: 'object', properties: {} }, ...tool })),
    }) },
    { path: 'scripts/read.js', type: 'script', content: 'async () => ({ ok: true })' },
  ],
}]);
const skillCall = (localName, args = {}) => call(`skill-${localName}`, `tab_skill__${localName}`, { timeout: 5, ...args });

for (const language of ['en', 'zh-CN']) test(`Skill page schemas expose tabRef while runtime keeps tabId (${language})`, () => {
  const f = fixture({ skillToolRegistrySnapshot });
  const options = { ...f.context(language), language };
  for (const schemas of [getActiveSkillToolSchemasSync(options), f.runtime.getSchemas(options)]) {
    for (const localName of ['page', 'default']) {
      const schema = schemas.find(item => item.function.name === `tab_skill__${localName}`).function;
      const builtin = f.runtime.getSchemas(options).find(item => item.function.name === 'read_ref').function;
      assert.deepEqual(schema.parameters.properties.tabRef, builtin.parameters.properties.tabRef);
      assert.equal(schema.parameters.properties.tabId, undefined);
      assert.deepEqual(schema.parameters.required, ['timeout']);
      assert.match(schema.description, /\btabRef\b/);
      assert.doesNotMatch(schema.description, /\btabId\b/);
      const definition = f.runtime.resolveDefinition(schema.name, options);
      assert.equal(definition.page, 'owned');
      assert.equal(definition.parameters.properties.tabId.type, 'number');
      assert.equal(definition.parameters.properties.tabRef, undefined);
      assert.equal(definition.behavior.barrier, true);
      assert.deepEqual(f.runtime.getBatchTabPolicy(schema.name, { tabRef: 'dy' }, options),
        { kind: 'target', implicit: true, observation: false });
      assert.equal(f.runtime.getParallelReadTab(schema.name, { tabId: 101 }, options), null);
    }
    for (const localName of ['inner', 'host', 'mcp', 'no_page']) {
      const schema = schemas.find(item => item.function.name === `tab_skill__${localName}`).function;
      assert.equal(schema.parameters.properties.tabRef, undefined);
      assert.equal(schema.parameters.properties.tabId, undefined);
      assert.equal(f.runtime.resolveDefinition(schema.name, options).page, undefined);
      assert.deepEqual(f.runtime.getBatchTabPolicy(schema.name, { tabRef: 'dy' }, options), { kind: 'barrier' });
    }
  }
  assert.equal(getSkillToolParameters({ runtime: 'inner', script: 'read.js' }).properties.tabId, undefined);
});

for (const localName of ['page', 'default']) test(`Skill ${localName} resolves aliases, numeric refs and the working tab through the script host`, async () => {
  const f = fixture({ skillToolRegistrySnapshot });
  await f.run([open('dy'), open('other')]);
  const name = `tab_skill__${localName}`;
  await f.execute(name, { timeout: 5 });
  assert.equal(f.executed.at(-1).tabId, 102);
  for (const args of [{ tabRef: 'dy' }, { tabRef: 101 }, { tabRef: '101' }, { tabId: 101 }]) {
    await f.execute(name, { timeout: 5, ...args });
    assert.equal(f.executed.at(-1).name, 'skill');
    assert.equal(f.executed.at(-1).tabId, 101);
    assert.equal(Object.hasOwn(f.executed.at(-1), 'tabRef'), false);
    assert.equal(Object.hasOwn(f.executed.at(-1).args, 'tabRef'), false);
  }
});

test('Skill page references preserve target conflicts and Session ownership checks', async () => {
  const f = fixture({ skillToolRegistrySnapshot });
  await f.run([open('dy')]);
  await f.runtime.execute('open_tab', { tabAlias: 'foreign' }, f.abort.signal, { ...f.context(), sessionId: 'two' });
  await assert.rejects(f.execute('tab_skill__page', { timeout: 5, tabRef: 'dy', tabId: 102 }),
    error => error.details.reason === 'conflicting_target');
  await assert.rejects(f.execute('tab_skill__page', { timeout: 5, tabRef: 102 }), { code: 'SESSION_TAB_FOREIGN' });
  assert.equal(f.executed.filter(item => item.name === 'skill').length, 0);
});

test('Skill page alias consumers remain commit barriers in an Agent batch', async () => {
  const f = fixture({ skillToolRegistrySnapshot });
  const items = [open('dy'), open('other'), skillCall('page', { tabRef: 'dy' }), read('other')];
  const plan = planTabBatch(items, item => {
    const args = JSON.parse(item.function.arguments);
    return { args, policy: f.runtime.getBatchTabPolicy(item.function.name, args, f.context()) };
  });
  assert.equal(plan.independent(items[2]), false);
  assert.deepEqual(plan.dependencies(items[2]).commit, items.slice(0, 2));
  assert.ok(plan.dependencies(items[3]).commit.includes(items[2]));
  await f.run(items);
  assert.ok(f.events.filter(event => event.type === 'tool_execution_end').every(event => !event.isError));
  assert.equal(f.executed.find(item => item.name === 'skill').tabId, 101);
  await f.run([skillCall('default', { tabRef: 'dy' })]);
  assert.equal(f.executed.at(-1).tabId, 101);
});

for (const [localName, tabRef, reason] of [
  ['page', 'missing', 'unknown_reference'], ['default', 'missing', 'unknown_reference'],
  ...['bad ref', 0, -1, 1.5, null, {}].map(ref => ['page', ref, 'invalid_reference']),
  ...['inner', 'host', 'mcp', 'no_page'].map(name => [name, 'dy', 'invalid_reference']),
]) test(`Skill ${localName} rejects ${JSON.stringify(tabRef)} as ${reason} before dispatch`, async () => {
  const f = fixture({ skillToolRegistrySnapshot });
  await f.run([open('dy')]);
  await assert.rejects(f.execute(`tab_skill__${localName}`, { timeout: 5, tabRef }), error =>
    error.code === 'BATCH_TAB_REFERENCE_ERROR' && error.details.reason === reason);
  await f.run([skillCall(localName, { tabRef })]);
  const end = f.events.filter(event => event.type === 'tool_execution_end').at(-1);
  assert.equal(end.result.code, 'BATCH_TAB_REFERENCE_ERROR');
  assert.equal(end.result.details.reason, reason);
  assert.equal(f.executed.filter(item => item.name === 'skill').length, 0);
});

for (const ref of [123,'123','00123']) test(`numeric reference ${JSON.stringify(ref)} uses the browser ID`,()=>{
  assert.equal(resolveTabReference(ref,{}),123);
});
for(const ref of [0,-1,1.5,'0','-1','12.4','','has spaces',NaN,{},null]) test(`invalid reference ${JSON.stringify(ref)} fails without a fallback`,()=>{
  assert.throws(()=>resolveTabReference(ref,{}),{details:{reason:'invalid_reference',...(ref==null?{}:{tabRef:ref})}});
});

test('aliases persist across batches, follow-up runs, serialized runtime and host restart',async()=>{
  const f=fixture(); await f.run([open('docs'),read('docs')]);
  assert.deepEqual(f.sessions.getTabAliases('one'),{docs:101});
  f.nextRun(); await f.run([read('docs')]);
  assert.equal(f.events.filter(e=>e.type==='tool_execution_end').at(-1).isError,false);
  f.states.one=normalizeSessionRuntime(JSON.parse(JSON.stringify(f.states.one)),'one');
  const restarted=createSessionTabs(f.options);
  assert.deepEqual(restarted.getTabAliases('one'),{docs:101});
  assert.deepEqual(restarted.getTabAliases('two'),{});
  assert.equal((await f.execute('read_ref',{tabRef:'docs'})).tabId,101);
  assert.equal((await f.execute('read_ref',{tabRef:'101'})).tabId,101);
  assert.equal((await f.execute('read_ref',{tabId:101})).tabId,101);
  await assert.rejects(f.execute('read_ref',{tabRef:'docs',tabId:102}),e=>e.details.reason==='conflicting_target');
});

test('an idle metadata-only Session opens its first alias and reuses it across direct MCP calls',async()=>{
  const f=fixture(); delete f.states.one;
  const context={...f.context(),runId:'',source:'mcp_bridge'};
  const opened=await f.runtime.execute('open_tab',{tabAlias:'first'},f.abort.signal,context);
  assert.equal(opened.tabAlias,'first');
  assert.deepEqual(f.sessions.getTabAliases('one'),{first:101});
  assert.equal((await f.runtime.execute('read_ref',{tabRef:'first'},f.abort.signal,context)).tabId,101);
  await assert.rejects(f.runtime.execute('open_tab',{tabAlias:'first'},f.abort.signal,context),e=>e.details.reason==='duplicate_alias');
  assert.equal(f.tabs.size,1);
});

for (const invalid of ['missing Session','cancelled metadata read','stale run']) test(`alias initialization rejects ${invalid}`,async()=>{
  const f=fixture({metadataReady:async()=>{if(invalid==='cancelled metadata read')f.abort.abort();}});
  delete f.states.one;
  if(invalid==='missing Session')delete f.metadata.one;
  const context={...f.context(),runId:invalid==='stale run'?'old-run':'',source:'mcp_bridge'};
  await assert.rejects(f.runtime.execute('open_tab',{tabAlias:'first'},f.abort.signal,context),{code:'OPERATION_ABORTED'});
  assert.equal(f.states.one,undefined);
  assert.equal(f.tabs.size,0);
  assert.equal(f.executed.length,0);
});

test('duplicate live alias fails before opening and does not redirect its consumers',async()=>{
  const f=fixture(); await f.run([open('docs')]);
  await f.run([open('docs'),read('docs')]);
  assert.equal(f.executed.filter(e=>e.name==='open').length,1);
  const ends=f.events.filter(e=>e.type==='tool_execution_end');
  assert.equal(ends.at(-2).result.details.reason,'duplicate_alias');
  assert.equal(ends.at(-1).result.tabId,101);
});

test('pending aliases reject concurrent creators before a second tab is created; stop releases reservation',async()=>{
  const f=fixture(); let release;f.setGate(new Promise(resolve=>{release=resolve;}));
  const first=f.execute('open_tab',{tabAlias:'shared'}); await tick();
  await assert.rejects(f.execute('open_tab',{tabAlias:'shared'}),e=>e.details.reason==='duplicate_alias');
  assert.equal(f.executed.filter(e=>e.name==='open').length,1);
  release();await first;
  const reservation=await f.sessions.reserveTabAlias({sessionId:'one',runId:'run1',alias:'cancelled'});
  f.sessions.discardTabAlias(reservation);
  await f.sessions.reserveTabAlias({sessionId:'one',runId:'run1',alias:'cancelled'});
});

test('failed or cancelled deferred opens publish no alias and release the name',async()=>{
  const f=fixture(); f.setFail(true);await f.run([open('retry')]);
  assert.deepEqual(f.sessions.getTabAliases('one'),{});assert.equal(f.tabs.size,0);
  f.setFail(false);await f.run([open('retry')]);assert.deepEqual(f.sessions.getTabAliases('one'),{retry:102});
  const g=fixture();let release;g.setGate(new Promise(resolve=>{release=resolve;}));
  const running=g.run([open('stopped')]);await tick();g.abort.abort();release();await running;
  assert.deepEqual(g.sessions.getTabAliases('one'),{});assert.equal(g.tabs.size,0);
});

test('loading partials retain aliases and allow dependent and later reads',async()=>{
  const f=fixture();f.setPartial(true);await f.run([open('loading'),read('loading')]);
  assert.deepEqual(f.sessions.getTabAliases('one'),{loading:101});
  assert.equal(f.events.filter(e=>e.type==='tool_execution_end').at(-1).isError,false);
  assert.equal((await f.execute('read_ref',{tabRef:'loading'})).tabId,101);
});

test('closing releases aliases while already admitted consumers keep their original target',async()=>{
  const f=fixture();await f.run([open('reusable')]);
  const items=[{args:{tabRef:'reusable'}}];
  const batch=planTabBatch(items,item=>({...item,policy:{kind:'target',implicit:true,observation:true}}),'en',f.sessions.getTabAliases('one'));
  await f.execute('close_ref',{tabRef:'reusable'});assert.deepEqual(f.sessions.getTabAliases('one'),{});
  await f.run([open('reusable')]);assert.equal(f.sessions.getTabAliases('one').reusable,102);
  assert.equal(batch.args(items[0]).tabId,101);
  await assert.rejects(f.execute('read_ref',batch.args(items[0])));
});

test('manual close is reconciled even before the browser close event arrives',async()=>{
  const f=fixture();await f.run([open('manual')]);f.tabs.delete(101);
  await f.run([open('manual')]);assert.equal(f.sessions.getTabAliases('one').manual,102);
});

test('same alias in distinct Sessions is independent, foreign aliases never resolve',async()=>{
  const f=fixture();await f.run([open('local')]);
  await assert.rejects(f.runtime.execute('read_ref',{tabRef:'local'},f.abort.signal,{...f.context(),sessionId:'two'}),e=>e.details.reason==='unknown_reference');
  const result=await f.runtime.execute('open_tab',{tabAlias:'local'},f.abort.signal,{...f.context(),sessionId:'two'});
  assert.equal(result.id,102);assert.deepEqual(f.sessions.getTabAliases('two'),{local:102});
});

for(const alias of ['123','１２３','with spaces','']) test(`invalid alias ${JSON.stringify(alias)} creates no tabs`,async()=>{
  const f=fixture();await f.run([open(alias)]);assert.equal(f.tabs.size,0);
  assert.equal(f.events.find(e=>e.type==='tool_execution_end').result.details.reason,'invalid_alias');
});

test('runtime migration drops invalid or unowned aliases and preserves prototype-like names safely',()=>{
  const old=normalizeSessionRuntime({schemaVersion:3,ownedTabIds:[7],tabAliases:JSON.parse('{"docs":7,"lost":8,"123":7,"__proto__":7}')},'one');
  assert.equal(old.schemaVersion,4);assert.deepEqual(old.tabAliases,JSON.parse('{"docs":7,"__proto__":7}'));
  assert.deepEqual(normalizeSessionRuntime({schemaVersion:3,ownedTabIds:[7]},'one').tabAliases,{});
});

test('tab grouping preserves loading-page ownership and aliases until actual close',async()=>{
  const f=fixture();await f.run([open('loading')]);
  f.tabs.set(101,{id:101,url:'about:blank',status:'loading',windowId:1});
  await f.sessions.syncGroup('one');
  assert.deepEqual(f.states.one.ownedTabIds,[101]);assert.deepEqual(f.sessions.getTabAliases('one'),{loading:101});
});

test('group reconciliation prunes closed aliases without overwriting tabs created during its awaits',async()=>{
  const f=fixture();await f.run([open('old')]);
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const original=f.options.tabsApi.get;
  f.options.tabsApi.get=async id=>{if(id===101){entered();await new Promise(resolve=>{release=resolve;});throw new Error('closed');}return original(id);};
  const syncing=f.sessions.syncGroup('one');await started;
  await f.run([open('new')]);f.states.one.marker='newer-state';
  release();await syncing;
  assert.deepEqual(f.states.one.ownedTabIds,[102]);assert.deepEqual(f.sessions.getTabAliases('one'),{new:102});
  assert.equal(f.states.one.marker,'newer-state');
});

test('explicit null tabRef never silently falls back to the working tab',async()=>{
  const f=fixture();await f.run([open('docs')]);
  await assert.rejects(f.execute('read_ref',{tabRef:null}),e=>e.details.reason==='invalid_reference');
  await f.run([read(null)]);assert.equal(f.events.filter(e=>e.type==='tool_execution_end').at(-1).result.details.reason,'invalid_reference');
});

test('alias reservations cannot publish with a foreign Session, stale run, or unowned tab',async()=>{
  const f=fixture();await f.run([open('owned')]);
  const reservation=await f.sessions.reserveTabAlias({sessionId:'one',runId:'run1',alias:'guarded'});
  assert.throws(()=>f.sessions.commitTabAlias({sessionId:'two',runId:'run1',reservation,tabId:101}));
  assert.throws(()=>f.sessions.commitTabAlias({sessionId:'one',runId:'run1',reservation,tabId:999}));
  assert.throws(()=>f.sessions.commitTabAlias({sessionId:'one',runId:'run1',reservation:{},tabId:101}));
  f.nextRun();
  assert.throws(()=>f.sessions.commitTabAlias({sessionId:'one',runId:'run1',reservation,tabId:101}),{code:'OPERATION_ABORTED'});
  assert.deepEqual(f.sessions.getTabAliases('one'),{owned:101});
  assert.deepEqual(f.sessions.getTabAliases('two'),{});
});

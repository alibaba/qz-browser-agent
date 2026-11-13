// Synthetic, isolated measurements. Run through the locale-aware loader; no provider or user browser.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { playwrightDomSources } from '../../scripts/vendor/playwright-dom.mjs';
import { createSessionRepository } from '../../src/background/session/repository.js';
import { createSessionTranscript } from '../../src/background/session/transcript.js';
import { createSessionCommands } from '../../src/background/session/commands.js';
import { createMemoryStorage } from '../support/memory-storage.mjs';
import { createSessionListSummaryFromTranscript } from '../../src/shared/session/session-list-summary.js';
import { createAxViewportHarness } from '../support/ax-viewport-harness.mjs';

const output = process.env.QZ_PERF_OUTPUT;
if (!output) throw new Error('Set QZ_PERF_OUTPUT to a new evidence directory');
const repeats = Number(process.env.QZ_PERF_REPEATS || 5);
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const results = [];
async function measure(name, size, fn) {
  await fn();
  const samples = [];
  let facts;
  for (let trial = 0; trial < repeats; trial++) {
    const start = performance.now(); facts = await fn(); samples.push(performance.now() - start);
  }
  const result = { name, size, repeats, medianMs: median(samples), samples, facts };
  results.push(result); console.log(JSON.stringify(result));
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
}
await mkdir(output, { recursive: true });
const content = (await build({ entryPoints: ['src/content/content-script.ts'], bundle: true, write: false,
  format: 'iife', plugins: [playwrightDomSources()] })).outputFiles[0].text;
const firefox = (await build({ entryPoints: ['src/background/firefox/page-command.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'ff' })).outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
console.log(JSON.stringify({ node: process.version, browser: browser.version(), repeats, command: 'QZ_PERF_OUTPUT=<directory> node --import ./tests/support/typescript-loader.mjs tests/benchmarks/perf-hotspots.mjs' }));
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
async function fixture(html) {
  await page.goto('about:blank'); await page.setContent(html);
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.listener = fn; }, removeListener() {} } } };
    window.callContent = (action, args = {}) => new Promise(resolve => window.listener({action, ...args}, {}, resolve)); });
  await page.addScriptTag({ content }); await page.addScriptTag({ content: firefox });
}
try {
  for (const size of [500, 1000, 5000]) {
    await fixture(`<style>img{width:30px;height:20px}img.hidden{display:none}</style><h1>Image fixture</h1><main>${Array.from({length:size}, (_,i) => `<img class="${i < 20 ? '' : 'hidden'}" alt="Image ${i}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'/%3E">`).join('')}</main>`);
    await measure('images-hidden', size, () => page.evaluate(async () => { const v = await callContent('listImageElements'); return {count:v.count, scanned:v.scanned}; }));
    await fixture(`<main>${Array.from({length:size}, (_,i) => `<button aria-label="Action ${i}">Action ${i}</button>`).join('')}</main>`);
    for (const [name, action, args] of [
      ['find-limit20','findElements',{tags:['button'],limit:20}],
      ['find-regex20','findElements',{tags:['button'],pattern:'Action',limit:20}],
      ['find-all','findElements',{tags:['button'],all:true}],
      ['text-selector','elementPresence',{selector:'text=Action 499',queryOnly:true}],
      ['overview','pageOverview',{}],
    ]) await measure(name, size, () => page.evaluate(async ({action,args}) => { const v=await callContent(action,args); return {count:v.results?.length, total:v.matches, found:v.found}; }, {action,args}));
    await measure('firefox-ax-builder', size, () => page.evaluate(async () => ({count: (await ff.firefoxPageCommand({op:'ax'})).nodes.length})));
    const cdp = await page.context().newCDPSession(page);
    const {frameTree} = await cdp.send('Page.getFrameTree');
    const world = (await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'bench'})).executionContextId;
    await cdp.send('Runtime.evaluate',{contextId:world, expression:`globalThis.chrome={runtime:{onMessage:{addListener(){},removeListener(){}}}};${content}`});
    // Same original node array: quantify protocol crossings separately from Content and registry work.
    await measure('bind-describe',size,async()=>{
      const {result} = await cdp.send('Runtime.evaluate',{contextId:world,expression:'Array.from(document.querySelectorAll("button"))',objectGroup:'bench'});
      const {result:props} = await cdp.send('Runtime.getProperties',{objectId:result.objectId,ownProperties:true});
      const nodes=props.filter(p=>p.value?.subtype==='node');
      for(let i=0;i<nodes.length;i+=8) await Promise.all(nodes.slice(i,i+8).map(p=>cdp.send('DOM.describeNode',{objectId:p.value.objectId})));
      await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'bench'}); return {count:nodes.length};
    });
    await measure('bind-deep-experiment',size,async()=>{
      const {result} = await cdp.send('Runtime.evaluate',{contextId:world,expression:'Array.from(document.querySelectorAll("button"))',objectGroup:'bench',serializationOptions:{serialization:'deep',maxDepth:1,additionalParameters:{maxNodeDepth:0}}});
      if(size===500) await writeFile(`${output}/deep-example.json`,JSON.stringify({...result,deepSerializedValue:{...result.deepSerializedValue,value:result.deepSerializedValue?.value?.slice(0,2)}},null,2));
      await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'bench'}); return {count:result.deepSerializedValue?.value?.length,first:result.deepSerializedValue?.value?.[0]};
    });
    await cdp.detach();
  }
} finally { await browser.close(); }

// Production commands, transcript reducer, repository and summary with isolated structured-clone storage.
// Both start and end are durably awaited for every nested tool, just as recordNestedTool does.
for (let trial=0;trial<repeats;trial++) {
  const repository=createSessionRepository({storage:createMemoryStorage()});
  const supervisor={peekEntry:()=>null,getRuntime:()=>null};
  const transcript=createSessionTranscript({repository,supervisor,getLiveAgentEntry:async()=>null,
    normalizeSessionId:String,resolveToolDefinition:()=>null,getToolIdentity:()=>({})});
  const commands=createSessionCommands({sessionRuntimeReady:Promise.resolve(),sessionRepository:repository,
    normalizeSessionId:String,transcript,artifacts:{clearListSummaryPatch(){},buildListSummary:async(_id,entries,now)=>createSessionListSummaryFromTranscript(entries,now)},broadcast(){}});
  const id='perf-drive'; await repository.createMetadata({id,source:'external-drive'}); await transcript.get(id);
  const samples=[];
  for(let i=0;i<1000;i++) {
    const start=performance.now();
    transcript.recordEvent(id,{type:'tool_execution_start',toolCallId:`t${i}`,toolName:'read_dom',args:{tabRef:'fixture'},startedExecution:true});
    await commands.saveSessionRecordRuntime({sessionId:id});
    transcript.recordEvent(id,{type:'tool_execution_end',toolCallId:`t${i}`,toolName:'read_dom',result:{content:'synthetic text '.repeat(100)}});
    await commands.saveSessionRecordRuntime({sessionId:id}); samples.push(performance.now()-start);
  }
  results.push({name:'session-1000',trial,samples,first100:median(samples.slice(0,100)),last100:median(samples.slice(-100))});
  console.log(JSON.stringify({...results.at(-1),samples:undefined}));
  await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
  if(trial===0) await measure('read-record-1000',1000,async()=>({count:(await repository.readRecord(id)).transcript.length}));
}
const ax=await createAxViewportHarness();
try {
  for(const size of [500,1000,5000]) {
    await ax.goto(`data:text/html,${encodeURIComponent(`<main>${Array.from({length:size},(_,i)=>`<button>Action ${i}</button>`).join('')}</main>`)}`);
    await measure('ax-viewport',size,async()=> { const r=await ax.snapshot({scope:'viewport',limit:120}); return r; });
  }
} finally { await ax.close(); }
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));

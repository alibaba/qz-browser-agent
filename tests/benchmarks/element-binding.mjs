// Production binding pipeline over real isolated-world CDP; optional source revision stays in memory.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { playwrightDomSources } from '../../scripts/vendor/playwright-dom.mjs';
const output = process.env.QZ_PERF_OUTPUT;
if (!output) throw new Error('Set QZ_PERF_OUTPUT');
const revision = process.env.QZ_PERF_REF;
const sources = { name:'revision', setup(b) { if (revision) b.onLoad({filter:/\.ts$/}, args => {
  const path=relative(process.cwd(),args.path); if(!path.startsWith('src/')) return;
  return {contents:execFileSync('git',['show',`${revision}:${path}`],{encoding:'utf8'}),loader:'ts'};
}); } };
const content=(await build({entryPoints:['src/content/content-script.ts'],bundle:true,write:false,format:'iife',plugins:[sources,playwrightDomSources()]})).outputFiles[0].text;
const bundle=(await build({entryPoints:['src/background/tools/element-runtime.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[sources]})).outputFiles[0].text;
const listeners=[];
globalThis.chrome={runtime:{id:'binding-fixture'},tabs:{get:async id=>({id,url:'https://fixture.test/'})},debugger:{onEvent:{addListener(fn){listeners.push(fn);}},onDetach:{addListener(){}}}};
const {createElementRuntime}=await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const cdp=await page.context().newCDPSession(page);
cdp.on('Runtime.executionContextCreated', event=>{
  if(event.context.name!=='binding-fixture') return;
  for(const listener of listeners) listener({tabId:1},'Runtime.executionContextCreated',{
    context:{...event.context,origin:'chrome-extension://binding-fixture',auxData:{...event.context.auxData,type:'isolated'}},
  });
});
for (const method of ['Runtime.executionContextDestroyed','Runtime.executionContextsCleared']) cdp.on(method, params => {
  for (const listener of listeners) listener({tabId:1},method,params);
});
let counts={};
const send=async(method,params)=>{counts[method]=(counts[method]||0)+1;return cdp.send(method,params);};
class ToolExecutionError extends Error { constructor(code,message){super(message);this.code=code;} }
const runtime=createElementRuntime({ToolExecutionError,getToolRuntimeDependencies:()=>({sessions:{listOwnedTabIds:()=>[1]}}),
  makeSessionTabTargetError:code=>new ToolExecutionError(code,code),assertTabAllowed:async()=>{},
  initializeContentScript:async()=>{},withDebugger:(_id,fn)=>fn({},send),sendToContent:async()=>{throw new Error('No selector fallback');}});
const results=[];
try {
  for(const size of [500,1000,5000]) {
    await page.goto('about:blank'); await page.setContent('<main>'+Array.from({length:size},(_,i)=>`<button>Action ${i}</button>`).join('')+'</main>');
    const {frameTree}=await cdp.send('Page.getFrameTree');
    const world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'binding-fixture'})).executionContextId;
    await cdp.send('Runtime.evaluate',{contextId:world,expression:`globalThis.chrome={runtime:{id:'binding-fixture',onMessage:{addListener(){},removeListener(){}}}};${content}`});
    const samples=[],calls=[];
    for(let trial=0;trial<6;trial++) {
      const {result}=await cdp.send('Runtime.evaluate',{contextId:world,expression:`new Promise(resolve=>__QZ_CONTENT_MESSAGE_LISTENER({action:'findElements',tags:['button'],all:true},{},resolve))`,awaitPromise:true,returnByValue:true});
      counts={}; const start=performance.now();
      const bound=await runtime.bindElementReferences(1,result.value.results,{sessionId:'benchmark',runId:'run'},undefined,'required');
      const elapsed=performance.now()-start;
      if(bound.length!==size || new Set(bound.map(b=>b.backendNodeId)).size!==size) throw new Error('Incorrect original-node bindings');
      if(trial) {samples.push(elapsed);calls.push({...counts});}
    }
    results.push({size,medianMs:[...samples].sort((a,b)=>a-b)[2],samples,calls});
    console.log(JSON.stringify(results.at(-1)));
  }
} finally { await browser.close(); }
await mkdir(output,{recursive:true}); await writeFile(resolve(output,'results.json'),JSON.stringify({revision:revision||'worktree',results},null,2));

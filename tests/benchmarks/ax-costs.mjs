// Attribute real CDP costs; use only synthetic documents and production AX/viewport logic.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAxViewportHarness } from '../support/ax-viewport-harness.mjs';
const output=process.env.QZ_PERF_OUTPUT;
if(!output) throw new Error('Set QZ_PERF_OUTPUT');
const repeats=3, median=v=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)];
const launch=chromium.launch.bind(chromium);
let commands=[];
chromium.launch=async(...args)=>{
  const browser=await launch(...args), newContext=browser.newContext.bind(browser);
  browser.newContext=async(...args)=>{
    const context=await newContext(...args), newSession=context.newCDPSession.bind(context);
    context.newCDPSession=async(...args)=>{
      const session=await newSession(...args),send=session.send.bind(session);
      session.send=async(method,params)=>{
        const start=performance.now();
        try{return await send(method,params);}finally{commands.push({method,ms:performance.now()-start,
          kind:method==='Runtime.callFunctionOn' && params.functionDeclaration?.includes(":disabled")?'disabled':undefined});}
      };return session;
    };return context;
  };return browser;
};
const harness=await createAxViewportHarness();
const results=[];
try{
  for(const fixture of ['buttons','disabled-options']) for(const size of [500,1000,5000]){
    const html=fixture==='buttons'?'<main>'+Array.from({length:size},(_,i)=>`<button style="display:block">Action ${i}</button>`).join('')+'</main>':
      '<select size="20">'+Array.from({length:size},(_,i)=>`<option disabled>Option ${i}</option>`).join('')+'</select>';
    await harness.goto('data:text/html,'+encodeURIComponent(html));
    const samples=[];
    for(let trial=0;trial<=repeats;trial++){
      commands=[];const start=performance.now(); const value=await harness.snapshot({scope:'viewport',limit:120});
      const elapsed=performance.now()-start;
      const counts={},totals={};for(const c of commands){const key=c.kind||c.method;counts[key]=(counts[key]||0)+1;totals[key]=(totals[key]||0)+c.ms;}
      if(trial) samples.push({elapsed,counts,totalCommandMs:totals, result:value});
    }
    const result={fixture,size,repeats,medianMs:median(samples.map(s=>s.elapsed)),samples}; results.push(result);
    console.log(JSON.stringify({...result,samples:undefined,counts:samples[0].counts,totalCommandMs:samples[0].totalCommandMs}));
    await mkdir(output,{recursive:true});await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
  }
}finally{await harness.close();chromium.launch=launch;}

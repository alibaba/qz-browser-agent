import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeAssistantStreamFrames } from '../support/assistant-stream-fuzz.mjs';
import { installLiveTableProbe, checkLiveTableReveal } from '../support/live-table-reveal.mjs';

/** Real model + production tools/UI; only the task inputs and observation are fixtures. */
export async function runStreamUiJourneys({ page, createSession, deleteSession, runPrompt, historyMessages, output, recordEvidence, scenarios }) {
  await mkdir(output, { recursive: true });
  const codes = Array.from({ length: 4 }, () => randomBytes(5).toString('hex'));
  const products = ['青松杯', '白云杯', '山岚杯'];
  const requests = [], trials = [];
  let slowResponse;
  // Browser-generated PNGs exercise the normal image download/store/render path.
  const images = await page.evaluate(() => [0, 1, 2].map(index => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = ['#456d58', '#446a9d', '#ae7143'][index]; ctx.fillRect(0, 0, 960, 640);
    ctx.fillStyle = '#fff'; ctx.font = '60px sans-serif'; ctx.fillText(['Pine', 'Cloud', 'Mountain'][index], 90, 180);
    ctx.beginPath(); ctx.arc(480, 390, 140, 0, Math.PI * 2); ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const html = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><article><h1>${title}</h1>${body}</article>`;
  const product = index => html(products[index], `<p>商品校验码：${codes[index]}</p><p>价格：${[79,99,129][index]} 元；容量：${[350,420,500][index]} ml。</p><p>材质：陶瓷；适合日常办公和旅行；手工釉面，建议手洗。</p>`);
  const server = createServer((req, res) => {
    requests.push({ path: req.url, at: Date.now() });
    if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if (req.url === '/slow') { slowResponse = res; return; }
    const image = /^\/image-(\d)\.png$/.exec(req.url);
    if (image) { res.writeHead(200, { 'content-type':'image/png' }); res.end(Buffer.from(images[Number(image[1])], 'base64')); return; }
    const item = /^\/product-(\d)$/.exec(req.url);
    if (item && Number(item[1]) < 3) { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(product(Number(item[1]))); return; }
    if (req.url === '/gallery') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(html('旅行主题图片素材', images.map((_,i)=>`<figure><img src="/image-${i}.png" width="480" height="320" alt="${products[i]}旅行主题"><figcaption>${products[i]}，校验码 ${codes[i]}</figcaption></figure>`).join(''))); return; }
    res.writeHead(404); res.end('Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const longAnswer = '最终回答先给结论，再给 Markdown 对比表格，再给分成至少 10 段的详细说明（总计约 1800 字），最后列出真实页面链接的脚注来源。不要输出完成前的长说明。';
  const cases = (scenarios || [
    { id:'product-comparison', width:430, theme:'dark', required:codes.slice(0,3), tools:['open_tab','read_article','data_store'], table:true,
      prompt:`比较 ${origin}/product-0、${origin}/product-1、${origin}/product-2 三款杯子。第一次 open_tab 必须设置 watchNetwork=true，且至少一个页面使用 mode=mobile。请用 tabAlias/tabRef 开页后读取，按每100ml价格排序，将名称、校验码、价格、容量和单位价格保存到名为 live_product_comparison 的数据表，并读回确认三行。${longAnswer}` },
    { id:'image-collection', width:360, theme:'light', required:products, tools:['open_tab','collect_images','data_store'], table:true, images:true,
      prompt:`打开 ${origin}/gallery，采集页面的三张图片到 live_trip_images 图库（用 collect_images，保留来源，不要只输出图片 URL），读回图片数据表核对三张记录。给每张图片写一段用途建议，${longAnswer}` },
    { id:'public-documentation', width:560, theme:'dark', required:['fetch','AbortController','ReadableStream'], tools:['open_tab','read_article'], table:true,
      prompt:`阅读 https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API、https://developer.mozilla.org/en-US/docs/Web/API/AbortController 和 https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream 的官方资料，比较它们如何配合实现可取消的流式请求。首次打开页面启用 watchNetwork=true。${longAnswer} 请另附一段实际可用的 JavaScript 示例，以及吞吐率公式 $r=\\frac{B}{t}$ 和块级公式 $$T=\\frac{B}{r}$$。` },
    { id:'timeout-recovery', width:430, theme:'light', required:[codes[3]], tools:['open_tab','read_article'], timeout:true,
      prompt:`先用 open_tab 打开 ${origin}/slow，设置 timeout=1、watchNetwork=true。若工具提示仍加载中，用 read_article 读取同一个 tabId，不要重新开页，读到页面的校验码后原样输出，并解释此次加载经历。` },
  ]).filter(item => !process.env.QINGZHOU_LIVE_UI_CASES || process.env.QINGZHOU_LIVE_UI_CASES.split(',').includes(item.id));
  try {
    for (const scenario of cases) {
      const sessionId = await createSession(page, `Live UI · ${scenario.id}`);
      const record = { id:scenario.id, sessionId, prompt:scenario.prompt, ok:false, interactions:[] }; trials.push(record); recordEvidence({trials});
      let pending, finished = false;
      try {
        await page.setViewportSize({width:scenario.width,height:760});
        await page.emulateMedia({colorScheme:scenario.theme});
        await page.locator('.tab-btn[data-tab="sessions"]').click();
        await page.locator(`.session-card[data-id="${sessionId}"]`).click();
        await page.locator('#input').waitFor({state:'visible'});
        const after = await page.evaluate(() => window.__qzLiveHarness.count());
        record.preparations=[];
        for (const prompt of scenario.prepare || []) record.preparations.push(await runPrompt(page, sessionId, prompt, {timeoutMs:180000}));
        await page.evaluate(installViewportProbe);
        if (scenario.table) await page.evaluate(installLiveTableProbe);
        const start = Date.now();
        pending = runPrompt(page, sessionId, scenario.prompt, {timeoutMs:240000});
        pending.then(() => { finished = true; }, () => { finished = true; });
        if (scenario.timeout) {
          await page.waitForFunction(({sessionId,after}) => window.__qzLiveHarness.eventsSince(after).some(e=>e.sessionId===sessionId && e.type==='tool_execution_end' && e.result?.incomplete), {sessionId,after}, {timeout:90000});
          assert.ok(slowResponse, 'slow navigation reached the server');
          slowResponse.end(html('加载恢复', `<p>商品校验码：${codes[3]}</p><p>页面已准备完成。</p>`)); slowResponse = null;
          // The following read can already be active in a collapsed timeline.
          // Inspect the historical open result, not only the active summary dot.
          const summary=page.locator('#messages .msg-tool-timeline > .tool-summary').first();
          if(await summary.count() && await summary.getAttribute('aria-expanded')!=='true') await summary.click();
          const firstStep=page.locator('#messages [data-tool-timeline-index="0"]').first();
          if(await firstStep.count()) await firstStep.click();
          await page.locator('#messages .dot.incomplete').first().waitFor({state:'attached'});
          record.indicator = await page.locator('#messages .dot.incomplete').first().evaluate(el=>({title:el.title,background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderStyle}));
          await page.screenshot({path:join(output,`${scenario.id}-loading.png`)});
        } else {
          await page.waitForFunction(()=>!!document.querySelector('#messages .tool-summary'),null,{timeout:90000});
          const summary = page.locator('#messages .tool-summary').first();
          for (let i=0;i<3 && !finished;i++) {
            await summary.click({timeout:10000});
            record.interactions.push({action:'toggle-tool',at:Date.now()-start,running:!finished});
            await page.waitForTimeout(120);
          }
          // Leave an actual tool result expanded while the model writes its answer.
          if(await summary.getAttribute('aria-expanded')!=='true') await summary.click();
          await page.waitForFunction(()=>[...document.querySelectorAll('#messages .msg-assistant[data-markdown-mode="stream"]')].some(el=>(el.dataset.content?.length||0)>180),null,{timeout:180000});
          if (scenario.images) {
            const steps = page.locator('#messages [data-tool-timeline-index]');
            for (let i=0;i<await steps.count();i++) {
              if(/采集图片|Collect images/i.test(await steps.nth(i).innerText())) { await steps.nth(i).click(); record.interactions.push({action:'show-image-result',running:!finished}); break; }
            }
            await page.screenshot({path:join(output,`${scenario.id}-gallery.png`)});
          }
          const box=await page.locator('#messages').boundingBox();
          await page.mouse.move(box.x+3,box.y+box.height/2);
          await page.mouse.wheel(0,-100000);
          await page.waitForTimeout(300);
          await page.evaluate(()=>{
            const p=window.__liveViewport, m=document.querySelector('#messages');
            p.anchor=m.querySelector('.msg-user'); p.baseline=p.anchor.getBoundingClientRect().top; p.phase='reading';
          });
          await page.waitForTimeout(800);
          await page.evaluate(()=>{window.__liveViewport.phase='interaction';});
          record.wheelTarget=await page.evaluate(({x,y})=>{const m=document.querySelector('#messages'),el=document.elementFromPoint(x,y);return {tag:el?.tagName,classes:el?.className,id:el?.id,inside:m.contains(el),top:m.scrollTop,height:m.scrollHeight,client:m.clientHeight};},{x:box.x+3,y:box.y+box.height/2});
          // Streaming can grow the document while a wheel gesture is in flight. Reach the
          // actual tail with native wheel events before measuring passive follow behavior.
          record.tailApproach=[];
          for(let i=0;i<8;i++) {
            await page.mouse.wheel(0,100000); await page.waitForTimeout(100);
            const gap=await page.locator('#messages').evaluate(m=>m.scrollHeight-m.clientHeight-m.scrollTop);
            record.tailApproach.push(gap); if(gap<2)break;
          }
          await page.waitForFunction(()=>{const m=document.querySelector('#messages');return m.scrollHeight-m.clientHeight-m.scrollTop<2;},null,{timeout:5000});
          await page.evaluate(()=>{window.__liveViewport.phase='tail';});
          await page.screenshot({path:join(output,`${scenario.id}-streaming.png`)});
        }
        const result = await pending;
        await page.waitForTimeout(400);
        record.elapsedMs=Date.now()-start;
        record.answer=result.assistantText; record.updateCount=result.updateCount;
        const events=await page.evaluate(({after,sessionId})=>window.__qzLiveHarness.eventsSince(after).filter(e=>e.sessionId===sessionId),{after,sessionId});
        const messages=await historyMessages(page,sessionId);
        const frames=await page.evaluate(()=>{window.__liveViewport.stop=true;return window.__liveViewport.frames;});
        const stability=analyzeAssistantStreamFrames(frames);
        const toolStarts=events.filter(e=>e.type==='tool_execution_start'), toolEnds=events.filter(e=>e.type==='tool_execution_end');
        record.toolCount=toolEnds.length; record.toolNames=toolEnds.map(e=>e.toolName);
        record.toolErrors=toolEnds.filter(e=>e.isError).map(e=>({tool:e.toolName,result:e.result}));
        record.stability={...stability,frames:frames.length};
        record.renderCoverage={ pendingTableFrames:frames.filter(f=>f.pendingTable).length,
          pendingSourceFrames:frames.filter(f=>f.pendingSources>0).length, imageFrames:frames.filter(f=>f.images>0).length,
          frameP95Ms:frames.map(f=>f.frameMs).sort((a,b)=>a-b)[Math.floor(frames.length*.95)] };
        record.dom=await page.locator('#messages').evaluate(el=>({text:el.innerText,tables:el.querySelectorAll('.msg-assistant table').length,rows:el.querySelectorAll('.msg-assistant table tbody tr').length,pendingTables:el.querySelectorAll('.markdown-table-pending').length,pendingSources:el.querySelectorAll('.markdown-footnote-ref-pending').length,loading:el.querySelectorAll('.msg-assistant[data-markdown-mode="stream"]').length,images:el.querySelectorAll('.tool-image-grid-scroll img').length}));
        await writeFile(join(output,`${scenario.id}-trajectory.json`),JSON.stringify({sessionId,prompt:scenario.prompt,messages,events},null,2));
        await writeFile(join(output,`${scenario.id}-frames.json`),JSON.stringify(frames));
        await page.screenshot({path:join(output,`${scenario.id}-completed.png`)});
        if (scenario.table) {
          const tableProbe = await page.evaluate(() => window.__liveTables.stop());
          await writeFile(join(output,`${scenario.id}-table-frames.json`),JSON.stringify(tableProbe));
          record.tableReveal = checkLiveTableReveal(tableProbe);
        }
        for(const term of scenario.required) assert.ok(result.assistantText.toLowerCase().includes(term.toLowerCase()),`Missing ${term}`);
        for(const tool of scenario.tools) assert.ok(record.toolNames.includes(tool),`Required tool ${tool} was not used`);
        assert.equal(record.toolErrors.length,scenario.expectedErrors?.length||0,JSON.stringify(record.toolErrors));
        for(const [i,reason] of (scenario.expectedErrors||[]).entries()) assert.equal(record.toolErrors[i].result.details?.reason,reason);
        assert.equal(toolStarts.length,toolEnds.length,'every tool start has one completion');
        for(const end of toolEnds) assert.equal(toolStarts.filter(start=>start.toolCallId===end.toolCallId).length,1);
        assert.deepEqual(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),toolEnds.map(e=>e.toolCallId),'model tool results retain completion publication order');
        if(scenario.tools.includes('data_store')) assert.ok(toolEnds.some(e=>e.toolName==='data_store'&&e.result?.rows?.length===3),'read back all three persisted records');
        if(scenario.images) assert.ok(toolEnds.some(e=>e.toolName==='collect_images'&&e.result?.collected===3&&e.result?.failed===0),'all three image assets were collected');
        assert.equal(record.dom.loading,0,'final answer is no longer streaming');
        assert.equal(record.dom.pendingTables,0,'no table placeholder remains');
        if(scenario.table) assert.ok(record.dom.tables>0,'answer rendered a completed table');
        if(scenario.timeout) assert.equal(toolEnds.filter(e=>e.toolName==='open_tab').length,1,'recovery uses the original tab');
        if(scenario.check) await scenario.check({events,messages,record,page,sessionId});
        assert.equal(stability.failures.length,0,JSON.stringify(stability.failures.slice(0,3)));
        if(!scenario.timeout) assert.ok(stability.coverage.tailContentChanges>0,'tail was observed during real content updates');
        record.ok=true; console.log(`PASS live UI ${scenario.id}: ${record.toolCount} tools, ${frames.length} frames`);
      } catch(error) {
        record.error=String(error.stack||error);
        const probe=await page.evaluate(()=>{const p=window.__liveViewport,m=document.querySelector('#messages');return {frames:p?.frames||[],wheels:p?.wheels||[],scroll:{top:m?.scrollTop,height:m?.scrollHeight,client:m?.clientHeight,rect:m?.getBoundingClientRect().toJSON()}};});
        await writeFile(join(output,`${scenario.id}-failure-frames.json`),JSON.stringify(probe));
        const observed=await page.evaluate(()=>window.__qzLiveHarness.eventsSince(0));
        await writeFile(join(output,`${scenario.id}-failure-events.json`),JSON.stringify(observed.filter(e=>e.sessionId===sessionId),null,2));
        await page.screenshot({path:join(output,`${scenario.id}-failure.png`)}).catch(()=>{});
        console.log(`FAIL live UI ${scenario.id}: ${String(error.message).slice(0,250)}`);
      } finally {
        await page.evaluate(()=>window.__liveTables?.stop()).catch(()=>{});
        await page.evaluate(()=>{if(window.__liveViewport)window.__liveViewport.stop=true;}).catch(()=>{});
        if(!finished) await page.evaluate(sessionId=>window.__qzLiveHarness.request('stop_session',{sessionId},'state',20000),sessionId).catch(()=>{});
        slowResponse?.end('cancelled'); slowResponse=null;
        await pending?.catch(()=>{});
        await deleteSession(page,sessionId);
        await writeFile(join(output,'journeys.json'),JSON.stringify({trials,requests},null,2)); recordEvidence({trials});
      }
    }
    assert.ok(trials.every(trial=>trial.ok),`Live UI failures: ${trials.filter(t=>!t.ok).map(t=>t.id).join(', ')}`);
    return {trials};
  } finally { slowResponse?.end('stopped'); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}

function installViewportProbe() {
  const p=window.__liveViewport={phase:'interaction',frames:[],wheels:[],stop:false,anchor:null,baseline:null};
  const m=document.querySelector('#messages');
  m.addEventListener('wheel',e=>p.wheels.push({time:performance.now(),delta:e.deltaY,target:e.target?.className,top:m.scrollTop,height:m.scrollHeight,client:m.clientHeight}),{passive:true});
  let previous=performance.now();
  const sample=()=>{
    const now=performance.now(), answer=[...m.querySelectorAll('.msg-assistant')].at(-1);
    p.frames.push({time:now,frameMs:now-previous,phase:p.phase,top:m.scrollTop,height:m.scrollHeight,client:m.clientHeight,width:m.clientWidth,tailGap:Math.max(0,m.scrollHeight-m.clientHeight-m.scrollTop),contentLength:answer?.dataset.content?.length||0,mode:answer?.dataset.markdownMode,pendingTable:m.querySelector('.markdown-table-pending')?.textContent||'',pendingSources:m.querySelectorAll('.markdown-footnote-ref-pending').length,images:m.querySelectorAll('.tool-image-grid-scroll img').length,anchorConnected:p.anchor?.isConnected||false,anchorTop:p.anchor?.getBoundingClientRect().top??null,anchorBaseline:p.baseline});
    previous=now;if(!p.stop)requestAnimationFrame(sample);
  };requestAnimationFrame(sample);
}

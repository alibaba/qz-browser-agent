import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStreamUiJourneys } from './stream-ui-journeys.mjs';

/** Five real-provider tasks, with deterministic business facts served to real browser tabs. */
export async function runTabReferenceJourneys(options) {
  const codes=Array.from({length:7},()=>randomBytes(5).toString('hex'));
  const requests=[];
  const html=(title,body)=>`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:18px system-ui;line-height:1.6;padding:30px}td,th{padding:8px;border:1px solid #ccc}input,select,button{font:inherit;margin:8px}</style><article><h1>${title}</h1>${body}</article>`;
  const pages={
    '/trains':html('湖城到山城列车时刻表',`<p>校验码 ${codes[0]}</p><table><tr><th>车次</th><th>出发</th><th>到达</th><th>价格</th></tr><tr><td>T101</td><td>08:10</td><td>09:35</td><td>85</td></tr><tr><td>T203</td><td>09:15</td><td>10:20</td><td>110</td></tr><tr><td>T305</td><td>10:00</td><td>11:40</td><td>70</td></tr></table>`),
    '/tickets':html('会场交通与报到',`<p>校验码 ${codes[1]}</p><p>会议开始 11:00，火车站到会场步行 25 分钟，报到另需 10 分钟。所有价格为人民币，不含返程。</p>`),
    '/warehouse-north':html('北仓库存',`<p>校验码 ${codes[2]}</p><table><tr><th>SKU</th><th>库存</th></tr><tr><td>Notebook</td><td>15</td></tr><tr><td>Pen</td><td>30</td></tr><tr><td>Folder</td><td>8</td></tr></table>`),
    '/warehouse-south':html('南仓库存',`<p>校验码 ${codes[3]}</p><table><tr><th>SKU</th><th>库存</th><th>两仓合计目标</th></tr><tr><td>Notebook</td><td>12</td><td>40</td></tr><tr><td>Pen</td><td>20</td><td>60</td></tr><tr><td>Folder</td><td>7</td><td>30</td></tr></table>`),
    '/shipping':html('包裹运费估算器',`<p>校验码 ${codes[4]}</p><p>首公斤 12 元，每增加一公斤 3 元；偏远地区加 8 元，保价加 5 元。不提交订单，不付款。</p><label>重量公斤 <input id="weight" type="number" value="1"></label><label>目的地区 <select id="zone"><option value="0">普通地区</option><option value="8">偏远地区</option></select></label><label><input id="insurance" type="checkbox">保价</label><button id="calculate">计算运费</button><p id="quote" role="status">等待计算</p><script>document.querySelector('#calculate').onclick=()=>{const weight=Number(document.querySelector('#weight').value);const price=12+Math.max(0,Math.ceil(weight)-1)*3+Number(document.querySelector('#zone').value)+(document.querySelector('#insurance').checked?5:0);document.querySelector('#quote').textContent='估算运费：'+price+' 元；重量：'+weight+' 公斤；校验码 ${codes[4]}';}</script>`),
    '/agenda-old':html('社区讲座旧安排',`<p>校验码 ${codes[5]}</p><p>旧版：周六 09:00，东馆 201，主题：入门摄影，报名费 30 元。</p>`),
    '/agenda-new':html('社区讲座最新安排',`<p>校验码 ${codes[6]}</p><p>新版：周日 14:00，西馆 305，主题：手机摄影实践，免费参与，请提前 15 分钟到场。</p>`),
  };
  const server=createServer((req,res)=>{requests.push({path:req.url,at:Date.now()});if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}res.writeHead(pages[req.url]?200:404,{'content-type':'text/html;charset=utf-8'});res.end(pages[req.url]||'Not found');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const detailed='最终回答用中文，先给结论，再给 Markdown 表格，再给至少 10 段详细解释（约 1600 字），最后用脚注列出真实来源链接。只在最后输出长报告。';
  const ends=events=>events.filter(e=>e.type==='tool_execution_end');
  function checkAcrossTurns({messages,events}) {
    const aliases=new Set(ends(events).filter(e=>e.toolName==='open_tab'&&!e.isError).map(e=>e.result?.tabAlias));
    let seenOpen=false, reused=false;
    for(const message of messages){
      if(message.role==='tool'){try{if(JSON.parse(message.content)?.tabAlias)seenOpen=true;}catch{}}
      if(message.role==='assistant'&&seenOpen)for(const call of message.tool_calls||[]){const a=JSON.parse(call.function.arguments||'{}');if(aliases.has(a.tabRef))reused=true;}
    }
    assert.ok(reused,'the model reused an alias after receiving earlier tool results');
  }
  const scenarios=[
    {id:'conference-train-plan',width:430,theme:'dark',required:[codes[0],codes[1],'T203'],tools:['open_tab','read_article'],table:true,
      prepare:[`打开 ${origin}/trains（tabAlias=trains，watchNetwork=true）和 ${origin}/tickets（tabAlias=tickets），读取页面信息后用一句话确认准备就绪。不要关闭页面。`],
      prompt:`请再次通过 tabRef=trains 和 tabRef=tickets 读取刚才两页，帮我选择能在 11:00 开会前完成报到的最晚出发列车。计算每班的总耗时、提前量和价格，列出两个页面校验码。不要重新开页。${detailed}`,check:checkAcrossTurns},
    {id:'warehouse-replenishment',width:360,theme:'light',required:[codes[2],codes[3],'13','10','15'],tools:['open_tab','read_article','data_store'],table:true,expectedErrors:['duplicate_alias'],
      prepare:[`打开 ${origin}/warehouse-north 并取 tabAlias=stock，读取页面。再刻意调用一次 open_tab 打开 ${origin}/warehouse-south，也取 tabAlias=stock，确认系统拒绝重名。遇到重名错误后停止，不要重试，不要关闭原页，用一句话说明结果。`],
      prompt:`复用 tabRef=stock 读取北仓，并打开 ${origin}/warehouse-south 取别名 south。计算三种 SKU 的两仓合计和补货量，保存到 live_replenishment 数据表并读回三行确认。列出两个校验码。${detailed}`,
      check:result=>{checkAcrossTurns(result);assert.equal(ends(result.events).filter(e=>e.toolName==='open_tab'&&e.result?.tabAlias==='stock'&&!e.isError).length,1);}},
    {id:'shipping-form-estimate',width:430,theme:'dark',required:[codes[4],'34'],tools:['open_tab','get_ax_tree','act_on_element'],table:true,
      prepare:[`打开 ${origin}/shipping，取别名 shipping，检查表单后只用一句话确认，不要填写。`],
      prompt:`在 tabRef=shipping 的运费表单中用页面元素操作填入重量 4 公斤、选择偏远地区、勾选保价并点击计算。先重新调用 get_ax_tree，使用它的 snapshot 返回的 uid: 元素目标（find_elements 可能只返回 css: 目标）；至少一次 act_on_element 同时传入该 uid: 目标和 tabRef=shipping。读取实际页面结果和校验码，解释报价组成，再列出 1 到 5 公斤同条件的费用对比。${detailed}`,
      check:async result=>{checkAcrossTurns(result);const shipping=result.page.context().pages().find(p=>p.url()===`${origin}/shipping`);assert.ok(shipping,'shipping page remains open');assert.match(await shipping.locator('#quote').innerText(),/34 元/);assert.ok(result.messages.some(m=>(m.tool_calls||[]).some(c=>{const a=JSON.parse(c.function.arguments||'{}');return c.function.name==='act_on_element'&&a.tabRef==='shipping'&&String(a.target).startsWith('uid:');})),'UID and alias used together');}},
    {id:'python-data-export-guide',width:560,theme:'light',required:['json','csv'],tools:['open_tab','read_article'],table:true,
      prepare:['打开 https://docs.python.org/3/library/json.html，别名 pyjson；打开 https://docs.python.org/3/library/csv.html，别名 pycsv。每页只先读取约 1000 字，确认页面可用后一句话回复。'],
      prompt:`请再次通过别名 pyjson 和 pycsv 阅读刚才两份官方文档，给初学者写一份把中文联系人列表分别导出 JSON 和 CSV 的操作指南，比较编码、换行、字段结构和读回方式，附一段简短 Python 示例。${detailed}`,check:checkAcrossTurns},
    {id:'lecture-schedule-update',width:380,theme:'dark',required:[codes[6],'14:00','305'],tools:['open_tab','close_tab','read_article'],table:true,
      prepare:[`打开 ${origin}/agenda-old，取别名 agenda，读取旧讲座安排。只简短确认。`,`现在关闭刚才的讲座页面，close_tab 的 tabRef 请传浏览器数字 ID。只确认已关闭，不要打开新页。`],
      prompt:`打开最新安排 ${origin}/agenda-new，仍取别名 agenda，读取并对比旧消息中的安排。说明日期时间地点主题费用的变化，列出新版校验码，给出参与建议。${detailed}`,
      check:({events,messages})=>{const opened=ends(events).filter(e=>e.toolName==='open_tab'&&!e.isError);assert.equal(opened.length,2);assert.equal(opened[0].result.tabAlias,'agenda');assert.equal(opened[1].result.tabAlias,'agenda');assert.notEqual(opened[0].result.id,opened[1].result.id);assert.ok(messages.some(m=>(m.tool_calls||[]).some(c=>c.function.name==='close_tab'&&typeof JSON.parse(c.function.arguments).tabRef==='number')),'numeric tabRef closed the original tab');}},
  ];
  try{return await runStreamUiJourneys({...options,scenarios});}
  finally {await writeFile(join(options.output,'tabref-requests.json'),JSON.stringify({codes,requests},null,2));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

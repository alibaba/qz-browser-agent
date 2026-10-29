import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStreamUiJourneys } from './stream-ui-journeys.mjs';

/** Different page types and operations from the first five reference tasks. */
export async function runDiverseTabReferenceJourneys(options) {
  const codes=Array.from({length:5},()=>randomBytes(5).toString('hex')), requests=[];
  const invoices=[{invoice:'INV-A',amount:120,paid:100},{invoice:'INV-B',amount:230,paid:230},{invoice:'INV-C',amount:90,paid:50}];
  const images=await options.page.evaluate(()=>[0,1,2].map(i=>{const c=document.createElement('canvas');c.width=800;c.height=1100;const x=c.getContext('2d');x.fillStyle=['#3c6289','#527f61','#9a613d'][i];x.fillRect(0,0,800,1100);x.fillStyle='#fff';x.font='54px sans-serif';x.fillText(['Photography','First aid','Gardening'][i],60,160);x.font='32px sans-serif';x.fillText('Community workshop',60,260);return c.toDataURL('image/png').split(',')[1];}));
  const html=(title,body)=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" href="data:,"><style>body{font:18px system-ui;line-height:1.6;padding:24px}td,th{padding:8px;border:1px solid #ccc}button,input{font:inherit;margin:8px}</style><article><h1>${title}</h1>${body}</article>`;
  const invoicePage=html('季度发票对账',`<p>审计码 ${codes[0]}。金额单位：元。三页各一张发票。</p><table><thead><tr><th>发票</th><th>应收</th><th>已收</th></tr></thead><tbody id="rows"></tbody></table><p id="page"></p><button id="next">下一页</button><script>let page=1;async function load(){const r=await(await fetch('/api/invoices?page='+page)).json();document.querySelector('#rows').innerHTML=r.rows.map(v=>'<tr><td>'+v.invoice+'</td><td>'+v.amount+'</td><td>'+v.paid+'</td></tr>').join('');document.querySelector('#page').textContent='第 '+page+' / 3 页';document.querySelector('#next').disabled=page===3;}document.querySelector('#next').onclick=()=>{page++;load();};load();</script>`);
  const auditPage=html('社区课程报名页面',`<p>版本校验码 ${codes[1]}</p><p>检查此页面的移动端横向溢出和输入控件的可访问名称即可，无需提交报名。</p><div style="width:900px;background:#f0f2f4;padding:16px">课程介绍：周末摄影、园艺与急救体验</div><form><p>姓名</p><input id="name"><p>邮箱</p><input id="email" type="email"><button aria-label="发送报名" type="button">→</button></form>`);
  const posterNames=['摄影工作坊','急救入门','家庭园艺'];
  const gallery=html('社区培训海报素材',`<p>素材批次 ${codes[2]}，所有图片为本次测试生成的素材。</p>`+posterNames.map((name,i)=>`<figure><img src="/poster-${i}.png" width="240" height="330" alt="${name}"><figcaption>${name}，800×1100，竖版</figcaption></figure>`).join(''));
  const policy=html('售后政策第二版',`<p>政策校验码 ${codes[3]}</p><p>自收货起 14 天内可申请退货；商品须保持完好，定制商品不支持无理由退货。质量问题由商家承担运费，个人原因由买家承担。</p><a href="/policy-faq">售后常见问题</a>`);
  const faq=html('售后常见问题',`<p>常见问题校验码 ${codes[4]}</p><p>退款在退货验收后 5 个工作日内原路退回。申请时提供订单号与问题照片。定制商品出现质量问题仍可联系售后。未经确认不要自行寄回。</p><a href="/policy-v2">返回售后政策</a>`);
  const server=createServer((req,res)=>{
    requests.push({path:req.url,at:Date.now()});
    if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(req.url==='/legacy-policy'){res.writeHead(302,{location:'/policy-v2'});res.end();return;}
    if(req.url.startsWith('/api/invoices?')){const page=Number(new URL(req.url,'http://fixture').searchParams.get('page'));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({page,totalPages:3,code:codes[0],rows:[invoices[page-1]]}));return;}
    const match=/^\/poster-(\d)\.png$/.exec(req.url);
    if(match){res.writeHead(200,{'content-type':'image/png'});res.end(Buffer.from(images[Number(match[1])],'base64'));return;}
    const content={'/invoices':invoicePage,'/audit':auditPage,'/posters':gallery,'/policy-v2':policy,'/policy-faq':faq}[req.url];
    res.writeHead(content?200:404,{'content-type':'text/html;charset=utf-8'});res.end(content||'Not found');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const report='最后输出中文报告：先结论，随后 Markdown 表格与至少 8 段具体说明（约 1300 字），附真实来源链接脚注。中间只执行操作，最后再输出长报告。';
  const ends=events=>events.filter(e=>e.type==='tool_execution_end');
  const calls=messages=>messages.flatMap(m=>m.tool_calls||[]).map(c=>({name:c.function.name,args:JSON.parse(c.function.arguments||'{}')}));
  const tokyo='https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=3';
  const seoul='https://api.open-meteo.com/v1/forecast?latitude=37.57&longitude=126.98&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=3';
  const scenarios=[
    {id:'two-city-weather-json',width:450,theme:'light',required:['东京','首尔'],tools:['open_tab','read_article'],table:true,
      prepare:[`打开东京预报 JSON：${tokyo}，tabAlias=tokyo；首尔预报 JSON：${seoul}，tabAlias=seoul。先各读一次确认数据可用，然后简短确认。保留页面。`],
      prompt:`再次用 tabRef=tokyo 和 tabRef=seoul 读取预报，比较两城返回的三个日期的最高温、最低温和降水概率，推荐各自最适合户外活动的一天，并说明推荐依据。以页面实际返回日期为准，不推测实时天气。${report}`,
      check:({events,record})=>{const text=ends(events).filter(e=>e.toolName==='read_article').map(e=>e.result?.text||'').join('\n');const dates=[...new Set(text.match(/20\d\d-\d\d-\d\d/g)||[])];assert.ok(dates.length>=3,'actual forecast dates were read');for(const date of dates.slice(0,3))assert.ok(record.answer.includes(date),`reported actual date ${date}`);}},
    {id:'paginated-invoice-audit',width:390,theme:'dark',required:['INV-A','INV-B','INV-C','60',codes[0]],tools:['open_tab','network_recent','network_body','act_on_element','data_store'],table:true,
      prompt:`打开 ${origin}/invoices，设置 tabAlias=invoices、watchNetwork=true。用 network_recent/network_body 查看真实发票接口，再用页面“下一页”按钮依次查看第 2、3 页；后续页面工具继续使用 tabRef=invoices。把三张发票的应收、已收、未收保存到 live_invoice_audit 表并读回三行确认，给出总额和催收建议以及审计码。${report}`,
      check:({events})=>{assert.ok(requests.some(r=>r.path==='/api/invoices?page=2'));assert.ok(requests.some(r=>r.path==='/api/invoices?page=3'));assert.equal(ends(events).filter(e=>e.toolName==='open_tab').length,1);}},
    {id:'mobile-accessibility-review',width:520,theme:'light',required:[codes[1],'姓名','邮箱'],tools:['open_tab','set_page_mode','get_ax_tree','run_script'],table:true,
      prepare:[`打开 ${origin}/audit，tabAlias=audit，mode=desktop，检查标题后一句话确认。`],
      prompt:`审查 tabRef=audit 的报名页面：先记录桌面端视口与横向溢出，再用 set_page_mode 切换 mobile，读取 get_ax_tree 并用只读 run_script 测量 document.documentElement.clientWidth 和 scrollWidth，检查姓名、邮箱输入框有无可访问名称。最后切回 desktop。不要填写或提交。给出问题、影响、修复建议，并原样列出校验码。${report}`,
      check:({messages})=>{const changes=calls(messages).filter(c=>c.name==='set_page_mode');assert.ok(changes.some(c=>c.args.mode==='mobile'&&c.args.tabRef==='audit'));assert.ok(changes.some(c=>c.args.mode==='desktop'&&c.args.tabRef==='audit'));}},
    {id:'training-poster-collection',width:360,theme:'dark',required:[...posterNames,codes[2]],tools:['open_tab','list_images','collect_images','data_store'],table:true,images:true,
      prompt:`打开 ${origin}/posters，设置 tabAlias=posters。通过 tabRef=posters 的 list_images 获取素材，使用 collect_images 将三张海报真正采集到 live_training_posters 图库，不要仅保存 URL。读回图片表确认三行，保留来源与名称。比较三个活动的海报适用场景、竖版尺寸和发布建议，并列出素材批次码。${report}`},
    {id:'redirected-return-policy',width:420,theme:'light',required:[codes[3],codes[4],'14','5'],tools:['open_tab','navigate','read_article','network_recent'],table:true,
      prepare:[`打开旧售后入口 ${origin}/legacy-policy，设置 tabAlias=policy、watchNetwork=true。读取重定向后的页面并简短确认当前网址。保留此页。`],
      prompt:`继续使用 tabRef=policy：查看 network_recent 确认重定向请求，然后 navigate 到刚才页面链接指向的售后常见问题，读取内容；最后仍用同一 tabRef 导航回政策主页。回答“普通商品第 10 天想退、定制商品无理由退、定制商品有质量问题”三种情况，并列出退货运费、退款时间和两个校验码。不要重新开页。${report}`,
      check:({events,messages})=>{assert.equal(ends(events).filter(e=>e.toolName==='open_tab').length,1);assert.ok(requests.some(r=>r.path==='/policy-v2'));assert.ok(requests.some(r=>r.path==='/policy-faq'));const navigations=calls(messages).filter(c=>c.name==='navigate');assert.ok(navigations.length>=2&&navigations.every(c=>c.args.tabRef==='policy'));}},
  ];
  try{return await runStreamUiJourneys({...options,scenarios});}
  finally {await writeFile(join(options.output,'diverse-requests.json'),JSON.stringify({codes,requests},null,2));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

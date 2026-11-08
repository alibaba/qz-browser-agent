import { expect } from '@playwright/test';

// Each entry has a different failure boundary or observable task contract. Seeds
// vary order, profile and values; they do not increase the scenario count.
export const driveTaskScenarios = [
  ['missing-reference', async ({ run }) => {
    const failed = await run(`return await tools.evaluate({code:()=>document.title});`, {}, 1);
    expect(failed.result.code).toBe('TAB_REF_REQUIRED');
    expect((await run(`return await tools.evaluate({tabRef:'main',code:()=>document.querySelector('#edit').value});`)).result).toBe('0');
  }],
  ['unknown-alias', async ({ run, page }) => {
    const failed = await run(`return await tools.act_on_element({tabRef:'missing',target:'css:#edit',action:'fill',value:'wrong'});`, {}, 1);
    expect(failed.result.code).toBe('BATCH_TAB_REFERENCE_ERROR');
    expect(await page.locator('#edit').inputValue()).toBe('0');
    const recovered = await run(`const {tabs}=await tools.list_tabs();
      await tools.act_on_element({tabRef:tabs[0].tabRef,target:'css:#edit',action:'fill',value:'recovered'});
      return tabs.map(tab=>tab.tabRef);`);
    expect(recovered.result).toEqual(['main']);
    expect(await page.locator('#edit').inputValue()).toBe('recovered');
  }],
  ['detached-element', async ({ run, page }) => {
    const found = await run(`return (await tools.find_elements({tabRef:'main',target:'css:#edit',limit:1})).results[0].target;`);
    await page.locator('#edit').evaluate(node => { const replacement = node.cloneNode(); replacement.id = 'replacement'; node.replaceWith(replacement); });
    const failed = await run(`return await tools.act_on_element({tabRef:'main',target:input.target,action:'fill',value:'wrong'});`, { target: found.result }, 1);
    expect(failed.result.code).toBe('STALE_ELEMENT_UID');
    expect(await page.locator('#replacement').inputValue()).toBe('0');
    await run(`const found=await tools.find_elements({tabRef:'main',target:'css:#replacement',limit:1});
      return await tools.act_on_element({tabRef:'main',target:found.results[0].target,action:'fill',value:'fresh'});`);
    expect(await page.locator('#replacement').inputValue()).toBe('fresh');
  }],
  ['same-url-reload', async ({ run, page, url }) => {
    const before = await page.locator('body').getAttribute('data-document-token');
    const result = await run(`await tools.wait_for_navigation({tabRef:'main',trigger:{name:'navigate',args:{tabRef:'main',url:input.url}}});
      await tools.wait_for_element({tabRef:'main',target:'css:body[data-document-token] #edit'});
      await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:'after reload'});
      return await tools.evaluate({tabRef:'main',code:()=>({token:document.body.dataset.documentToken,url:location.href})});`, { url });
    expect(result.result.url).toBe(url);
    expect(result.result.token).not.toBe(before);
    expect(await page.locator('#edit').inputValue()).toBe('after reload');
  }],
  ['hash-navigation', async ({ run, page }) => {
    const token = await page.locator('body').getAttribute('data-document-token');
    const result = await run(`await tools.evaluate({tabRef:'main',code:()=>{location.hash='stage-two';}});
      await tools.wait_for_url({tabRef:'main',urlPattern:'#stage-two$'});
      await tools.act_on_element({tabRef:'main',target:'css:#continue',action:'click'});
      return await tools.evaluate({tabRef:'main',code:()=>({token:document.body.dataset.documentToken,hash:location.hash})});`);
    expect(result.result).toEqual({ token, hash: '#stage-two' });
    await expect(page.locator('body')).toHaveAttribute('data-continued', 'yes');
  }],
  ['ajax-trigger-once', async ({ run, page, site }) => {
    const before = site.requests.filter(row => row.path === '/api/more').length;
    await run(`await tools.wait_for_response({tabRef:'main',urlPattern:'/api/more',trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#more',action:'click'}}});
      await tools.wait_for_function({tabRef:'main',code:()=>document.body.dataset.more==='loaded'});
      return await tools.evaluate({tabRef:'main',code:()=>document.querySelector('#count').textContent});`);
    expect(site.requests.filter(row => row.path === '/api/more')).toHaveLength(before + 1);
    await expect(page.locator('#count')).toHaveText('2');
    await expect(page.locator('#more')).toHaveAttribute('data-clicks', '1');
  }],
  ['popup-chain', async ({ run, context }) => {
    const result = await run(`await tools.wait_for_popup({tabRef:'main',tabAlias:'child',trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#popup',action:'click'}}});
      await tools.wait_for_element({tabRef:'child',target:'css:#popup'});
      await tools.wait_for_popup({tabRef:'child',tabAlias:'grandchild',trigger:{name:'act_on_element',args:{tabRef:'child',target:'css:#popup',action:'click'}}});
      await tools.wait_for_element({tabRef:'grandchild',target:'css:#edit'});
      await tools.act_on_element({tabRef:'grandchild',target:'css:#edit',action:'fill',value:'third generation'});
      return (await tools.list_tabs()).tabs.map(tab=>tab.tabRef).sort();`);
    expect(result.result).toEqual(['child', 'grandchild', 'main']);
    expect(await Promise.all(context.pages().filter(p => new URL(p.url()).pathname === '/popup').map(p => p.locator('#edit').inputValue()))).toEqual(['0', 'third generation']);
  }],
  ['closed-alias-reuse', async ({ run, url, page, context }) => {
    await run(`await tools.close_tab({tabRef:'main'});await tools.open_tab({url:input.url,tabAlias:'main'});
      await tools.wait_for_element({tabRef:'main',target:'css:#edit'});
      return await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:'replacement tab'});`, { url });
    expect(page.isClosed()).toBe(true);
    expect(await context.pages().find(p => p.url() === url).locator('#edit').inputValue()).toBe('replacement tab');
  }],
  ['duplicate-alias', async ({ run, context, url, page }) => {
    const before = context.pages().length;
    const failed = await run(`return await tools.open_tab({url:input.url,tabAlias:'main'});`, { url: url + '?duplicate' }, 1);
    expect(failed.result.code).toBe('BATCH_TAB_REFERENCE_ERROR');
    expect(context.pages()).toHaveLength(before);
    await run(`return await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:'original'});`);
    expect(await page.locator('#edit').inputValue()).toBe('original');
  }],
  ['foreign-session-write', async ({ cli, run, owner, sid, script, url, context }) => {
    const other = (await cli(['session', 'create', '--title', 'Foreign ownership control', '--client', owner, '--json'])).result.sessionId;
    try {
      await script(other, `return await tools.open_tab({url:input.url,tabAlias:'private'});`, { url: url + '?private' });
      const foreign = context.pages().find(p => p.url() === url + '?private');
      await foreign.locator('#edit').waitFor();
      const listed = await run(`return (await tools.list_tabs({scope:'all'})).tabs.find(tab=>tab.url===input.url);`, { url: url + '?private' });
      const failed = await script(sid, `return await tools.act_on_element({tabRef:input.ref,target:'css:#edit',action:'fill',value:'intrusion'});`, { ref: listed.result.tabRef }, 1);
      expect(failed.result.code).toBe('SESSION_TAB_FOREIGN');
      expect(await foreign.locator('#edit').inputValue()).toBe('0');
      const read = await run(`return (await tools.read_article({tabRef:input.ref,limit:500})).url;`, { ref: listed.result.tabRef });
      expect(read.result).toBe(url + '?private');
    } finally { await cli(['session', 'cancel', other, '--json']); }
  }],
  ['user-tab-preserved', async ({ run, context, url, cli, sid }) => {
    const user = await context.newPage();
    try {
      await user.goto(url + '?user');
      const listed = await run(`return (await tools.list_tabs({scope:'all'})).tabs.find(tab=>tab.url===input.url);`, { url: url + '?user' });
      const read = await run(`const url=(await tools.read_article({tabRef:input.ref,limit:500})).url;
        return {url,owned:(await tools.list_tabs()).tabs.map(tab=>tab.tabRef)};`, { ref: listed.result.tabRef });
      expect(read.result).toEqual({ url: url + '?user', owned: ['main'] });
      await cli(['session', 'cancel', sid, '--json']);
      expect(user.isClosed()).toBe(false);
      expect(await user.locator('#edit').inputValue()).toBe('0');
      return { canceled: true };
    } finally { await user.close(); }
  }],
  ['same-tab-serialization', async ({ run, site, page, lane }) => {
    const pending = run(`return await Promise.all([true,false].map(first=>tools.evaluate({tabRef:'main',code:async ({first,lane})=>{
      const field=document.querySelector('#edit'),before=Number(field.value);if(first)await fetch('/hold?lane='+lane);
      field.value=String(before+(first?3:7));return Number(field.value);},args:{first,lane:input.lane}})));`, { lane });
    void pending.catch(() => {});
    try { await expect.poll(() => site.pending(lane)).toBe(1); }
    finally { site.release(lane); }
    expect((await pending).result).toEqual([3, 10]);
    expect(await page.locator('#edit').inputValue()).toBe('10');
  }],
  ['cross-tab-progress', async ({ run, site, lane, url }) => {
    await run(`return await tools.open_tab({url:input.url,tabAlias:'other'});`, { url: url + '?other' });
    const pending = run(`return await Promise.all(['main','other'].map(tabRef=>tools.evaluate({tabRef,code:async lane=>{
      await fetch('/hold?lane='+lane);return location.search;},args:input.lane+'-'+tabRef})));`, { lane });
    void pending.catch(() => {});
    try { await expect.poll(() => site.pending(lane + '-main') + site.pending(lane + '-other')).toBe(2); }
    finally { site.release(lane + '-main'); site.release(lane + '-other'); }
    expect((await pending).result).toEqual(['', '?other']);
  }],
  ['caught-tool-error', async ({ run, page }) => {
    const result = await run(`let failure;try{await tools.act_on_element({tabRef:'main',target:'css:#absent',action:'click'});}catch(error){failure=error.code;}
      await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:'continued'});return {failure};`);
    expect(result.result.failure).toBe('ELEMENT_NOT_READY');
    expect(await page.locator('#edit').inputValue()).toBe('continued');
  }],
  ['cancel-inflight', async ({ run, site, lane, cli, sid, context, url }) => {
    const pending = run(`await tools.evaluate({tabRef:'main',code:async lane=>{await fetch('/hold?lane='+lane);document.querySelector('#edit').value='late';},args:input.lane});
      return {lateSuccess:true};`, { lane }, 1);
    void pending.catch(() => {});
    try {
      await expect.poll(() => site.pending(lane)).toBe(1);
      await cli(['session', 'cancel', sid, '--json']);
    } finally { site.release(lane); }
    expect((await pending).result.code).toBe('OPERATION_ABORTED');
    expect(context.pages().some(p => p.url() === url)).toBe(false);
    const ended = await run(`return await tools.list_tabs();`, {}, 1);
    expect(ended.result.code).toBe('DRIVE_SESSION_ENDED');
    return { canceled: true };
  }],
  ['timeout-no-replay', async ({ run, page, site }) => {
    const before = site.requests.filter(row => row.path === '/api/more').length;
    // Establish a committed effect before starting the deliberately short wait.
    const failed = await run(`await tools.wait_for_response({tabRef:'main',urlPattern:'/api/more',
      trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#more',action:'click'}}});
      await tools.wait_for_function({tabRef:'main',code:()=>document.body.dataset.more==='loaded'});
      return await tools.wait_for_response({tabRef:'main',urlPattern:'/never-matches',timeout:0.2});`, {}, 1);
    expect(failed.result.code).toBe('TOOL_TIMEOUT');
    await run(`return await tools.wait_for_function({tabRef:'main',code:()=>document.body.dataset.more==='loaded'});`);
    expect(site.requests.filter(row => row.path === '/api/more')).toHaveLength(before + 1);
    await expect(page.locator('#more')).toHaveAttribute('data-clicks', '1');
    await expect(page.locator('#count')).toHaveText('2');
  }],
  ['unicode-business-values', async ({ run, page, choose }) => {
    const value = { ok: false, code: 'BUSINESS_STATUS', message: '库存 🧪 / café', error: 'not a transport failure', quantity: 3 + choose(8) };
    const result = await run(`await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:input.message});
      return await tools.evaluate({tabRef:'main',code:value=>({...value,actual:document.querySelector('#edit').value}),args:input});`, value);
    expect(result.result).toEqual({ ...value, actual: value.message });
    expect(await page.locator('#edit').inputValue()).toBe(value.message);
  }],
  ['large-result-projection', async ({ run, page }) => {
    await page.evaluate(() => { document.querySelector('#edit').value = 'x'.repeat(51_000) + 'TAIL-库存'; });
    const full = await run(`return await tools.evaluate({tabRef:'main',code:()=>document.querySelector('#edit').value});`);
    // Explicitly preserved script values are not mistaken for truncation envelopes.
    expect(full.result).toBe('x'.repeat(51_000) + 'TAIL-库存');
    const compact = await run(`return await tools.evaluate({tabRef:'main',code:()=>{const value=document.querySelector('#edit').value;return {length:value.length,tail:value.slice(-7)};}});`);
    expect(compact.result).toEqual({ length: 51_007, tail: 'TAIL-库存' });
  }],
  ['catalog-recovery', async ({ run }) => {
    const failed = await run(`return await tools.list_tools({names:['not_a_real_tool']});`, {}, 1);
    expect(failed.result.code).toBe('UNKNOWN_TOOL');
    expect(failed.result.message).toContain('not_a_real_tool');
    const result = await run(`const compact=await tools.list_tools();const selected=await tools.list_tools({names:['evaluate']});
      return {compact,selected,value:await tools.evaluate({tabRef:'main',code:()=>document.querySelector('#edit').value})};`);
    expect(result.result.compact.tools.some(tool => tool.name === 'evaluate')).toBe(true);
    expect(result.result.selected.tools).toHaveLength(1);
    expect(result.result.selected.tools[0].parameters.required).toContain('tabRef');
    expect(result.result.value).toBe('0');
  }],
  ['iframe-target-identity', async ({ run, page }) => {
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.title = 'Task frame';
      frame.srcdoc = '<button onclick="this.textContent=\'Frame saved\'">Save framed task</button>'; document.body.append(frame); });
    await page.frameLocator('iframe').getByRole('button', { name: 'Save framed task' }).waitFor();
    const result = await run(`const tree=await tools.get_ax_tree({tabRef:'main',scope:'full',limit:100});
      const line=tree.snapshot.split('\\n').find(line=>line.includes('button "Save framed task"'));
      const target=line&&line.match(/target=(uid:\\S+)/)[1];if(!target)throw new Error('missing frame target');
      await tools.act_on_element({tabRef:'main',target,action:'click'});return target;`);
    expect(result.result).toMatch(/^uid:/);
    await expect(page.frameLocator('iframe').getByRole('button')).toHaveText('Frame saved');
    expect(await page.locator('#edit').inputValue()).toBe('0');
  }],
  ['document-navigation', async ({ run, page }) => {
    const token = await page.locator('body').getAttribute('data-document-token');
    const result = await run(`await tools.wait_for_navigation({tabRef:'main',trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#navigate',action:'click'}}});
      await tools.wait_for_element({tabRef:'main',target:'css:body[data-document-token] #edit'});
      await tools.act_on_element({tabRef:'main',target:'css:#edit',action:'fill',value:'new document'});
      return await tools.evaluate({tabRef:'main',code:()=>({token:document.body.dataset.documentToken,path:location.pathname})});`);
    expect(result.result.path).toBe('/next');
    expect(result.result.token).not.toBe(token);
    expect(await page.locator('#edit').inputValue()).toBe('new document');
  }],
];

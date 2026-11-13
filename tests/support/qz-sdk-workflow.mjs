import { createServer } from 'node:http';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { callTool, readHealth } from '../../services/mcp-bridge/src/client.mjs';
import { buildScriptRequest } from '../../services/mcp-bridge/src/script-call.mjs';

async function startPage() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url.startsWith('/item/')) {
      const item = request.url.slice('/item/'.length);
      response.end(`<!doctype html><title>Item ${item}</title><div id="inventory">Loading</div>
        <script>setTimeout(()=>document.querySelector('#inventory').textContent='In stock: 12; Price: 35',300)</script>`);
      return;
    }
    if (request.url === '/frame') {
      response.end(`<!doctype html><title>Locator frame</title><button id="framed" aria-label="Frame target"
        onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Frame target</button>`);
      return;
    }
    response.end(`<!doctype html><title>Locator workflow</title><meta charset="utf-8">
      <style>body{font:16px sans-serif;margin:16px}button,input{margin:4px;min-height:32px}iframe{display:block;width:420px;height:90px}</style>
      <input id="destination" aria-label="Destination"><div id="suggestions"></div><section id="result" hidden></section>
      <button id="duplicate-a" aria-label="Duplicate">Duplicate</button><button id="duplicate-b" aria-label="Duplicate">Duplicate</button>
      <button id="replace" disabled aria-label="Replace while waiting">Replace while waiting</button>
      <button id="identity" aria-label="Pinned identity">Pinned identity</button>
      <button id="timeout" disabled aria-label="Timeout target">Timeout target</button>
      <button id="cancel" disabled aria-label="Cancelled target">Cancelled target</button>
      <button id="no-navigation" aria-label="No navigation">No navigation</button>
      <a id="popup" href="/?popup" target="_blank">Open details</a>
      <a id="item-a" href="/item/a" target="_blank">Item a</a>
      <a id="item-b" href="/item/b" target="_blank">Item b</a>
      <a id="item-c" href="/item/c" target="_blank">Item c</a>
      <button id="trap-Precise" data-testid="Precise" aria-label="Other name">Other name</button>
      <button id="precise" aria-label="Precise">Precise</button>
      <div id="state">Loading state</div><div id="counted"></div><div id="shadow"></div><iframe src="/frame"></iframe>
      <script>
        const count=event=>event.currentTarget.dataset.clicks=String(Number(event.currentTarget.dataset.clicks||0)+1);
        for(const button of document.querySelectorAll('button'))button.addEventListener('click',count);
        document.querySelector('#destination').addEventListener('input',event=>{
          const value=event.target.value;
          document.querySelector('#suggestions').replaceChildren();
          setTimeout(()=>{
            if(event.target.value!==value)return;
            const option=document.createElement('button');option.id='suggestion';option.setAttribute('role','option');
            option.setAttribute('aria-label',value);option.textContent=value;
            option.addEventListener('click',()=>{
              option.dataset.clicks=String(Number(option.dataset.clicks||0)+1);
              const result=document.querySelector('#result');result.hidden=false;result.textContent='Route to '+value;
            });document.querySelector('#suggestions').append(option);
          },300);
        });
        const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});
        shadow.innerHTML='<button id="shadow-action" aria-label="Shadow target">Shadow target</button>';
        shadow.querySelector('button').addEventListener('click',count);
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

/** Both packages execute the installed SDK through the real CLI, bridge and outer Worker. */
export async function exerciseQzSdk({ endpoint, context, expect, step, testInfo, isolatedSkills = true }) {
  const fixture = await startPage(), transcript = [];
  let sessionId, userPage;
  const cli = async (argv, source = '') => {
    const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
    const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
    const exitCode = await main(argv, { stdout, stderr, readStdin: async () => source,
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
    });
    const entry = { argv, source, exitCode, stdout: stdout.text, stderr: stderr.text };
    transcript.push(entry);
    let value;
    try { value = JSON.parse(stdout.text); } catch { throw new Error(JSON.stringify(entry)); }
    if (argv[0] === 'script') {
      const hasContext = Object.hasOwn(value, 'context');
      expect(Object.keys(value).sort(), JSON.stringify(entry)).toEqual(hasContext
        ? ['context', 'ok', 'result', 'trace'] : ['ok', 'result', 'trace']);
      expect(value.ok, JSON.stringify(entry)).toBe(exitCode === 0);
      if (value.ok) expect(hasContext, JSON.stringify(entry)).toBe(true);
      // A worker-scoped profile keeps Skills installed by an earlier test. An isolated
      // profile owns an empty catalog, so its receipt must stay empty.
      if (hasContext) expect(value.context, JSON.stringify(entry)).toEqual(isolatedSkills
        ? { qz_skills: [] } : { qz_skills: expect.any(Array) });
    }
    return value;
  };
  const script = async (code, args = {}, success = true) => {
    const receipt = await cli(['script', '--session', sessionId, '--timeout', '30', '--args', JSON.stringify(args), '-'], code);
    expect(receipt.ok, JSON.stringify(receipt)).toBe(success);
    return receipt.result;
  };
  try {
    const created = await cli(['session', 'create', '--title', 'qz SDK locator workflow', '--json']);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    sessionId = created.result.sessionId;
    const opened = await script('return await qz.openTab({url:args.url,tabAlias:"page"});', { url: fixture.url });
    expect(opened.tabRef).toBe('page');
    await expect.poll(() => context.pages().some(page => page.url() === fixture.url)).toBe(true);
    const page = context.pages().find(page => page.url() === fixture.url);
    await page.frameLocator('iframe').locator('#framed').waitFor();

    await step('fill waits for the matching asynchronous suggestion and reads its result', async () => {
      const result = await script(`
        const page=qz.tab('page');
        await page.locator({css:'#destination',role:'textbox',name:'Destination'}).fill('Harbor');
        await page.locator({role:'option',name:'Harbor'}).click({timeout:5});
        await page.locator('css:#result').wait({state:'visible'});
        return await page.locator('css:#result').read({limit:1000});
      `);
      expect(JSON.stringify(result)).toContain('Route to Harbor');
      await expect(page.locator('#destination')).toHaveValue('Harbor');
      await expect(page.locator('#suggestion')).toHaveAttribute('data-clicks', '1');
    });

    await step('semantic names are exact and multiple matches require explicit selection', async () => {
      const failure = await script("await qz.tab('page').locator({role:'button',name:'Duplicate'}).click();", {}, false);
      expect(failure.code).toMatch(/AMBIGUOUS|MULTIPLE/);
      expect(await page.locator('#duplicate-a').getAttribute('data-clicks')).toBeNull();
      expect(await page.locator('#duplicate-b').getAttribute('data-clicks')).toBeNull();
      await script(`
        const page=qz.tab('page');
        await page.locator({role:'button',name:'Duplicate'}).nth(1).click();
        await page.locator({role:'button',name:'Precise'}).click();
      `);
      await expect(page.locator('#duplicate-b')).toHaveAttribute('data-clicks', '1');
      await expect(page.locator('#precise')).toHaveAttribute('data-clicks', '1');
      expect(await page.locator('#trap-Precise').getAttribute('data-clicks')).toBeNull();
    });

    await step('invalid SDK inputs retain actionable diagnostics at the CLI boundary', async () => {
      const field = await script("return await qz.tab('page').locator({cs:'#destination'}).inspect();", {}, false);
      expect(field).toMatchObject({ code: 'INVALID_ARGUMENTS', details: { invalidFields: ['cs'] } });
      expect(field.details.allowedFields).toContain('target');
      const css = await script("await qz.tab('page').locator('css:button, css:input').click();", {}, false);
      expect(css).toMatchObject({ code: 'INVALID_SELECTOR', details: { target: 'css:button, css:input', tabRef: 'page' } });
      expect(css.message).not.toBe('The operation failed.');
    });

    await step('a query can replace an unready node while a uid remains pinned', async () => {
      await script(`
        const page=qz.tab('page');
        await page.evaluate(()=>{
          setTimeout(()=>{
            const old=document.querySelector('#replace'),next=old.cloneNode(true);
            next.disabled=false;next.dataset.generation='new';
            next.onclick=()=>next.dataset.clicks=String(Number(next.dataset.clicks||0)+1);old.replaceWith(next);
          },750);
        });
        await page.locator({role:'button',name:'Replace while waiting'}).click({timeout:5});
      `);
      await expect(page.locator('#replace')).toHaveAttribute('data-generation', 'new');
      await expect(page.locator('#replace')).toHaveAttribute('data-clicks', '1');
      const observed = await script("return await qz.tab('page').locator('css:#identity').inspect();");
      expect(observed.target).toMatch(/^uid:/);
      await page.locator('#identity').evaluate(old => {
        const next = old.cloneNode(true); next.onclick = () => { next.dataset.clicked = 'yes'; }; old.replaceWith(next);
      });
      const failure = await script("await qz.tab('page').locator(args.target).click();", { target: observed.target }, false);
      expect(failure.code).toMatch(/STALE_ELEMENT_UID/);
      expect(await page.locator('#identity').getAttribute('data-clicked')).toBeNull();
    });

    await step('queries share shadow and frame scopes with observation references', async () => {
      await script("await qz.tab('page').locator({role:'button',name:'Shadow target'}).click();");
      await expect(page.locator('#shadow-action')).toHaveAttribute('data-clicks', '1');
      const tree = await script("return await qz.tab('page').axTree({scope:'full',depth:12,limit:100});");
      const frameRoot = tree.snapshot.split('\n').find(line => line.includes(' RootWebArea') && line.includes('Locator frame'))?.match(/target=(uid:\S+)/)?.[1];
      expect(frameRoot || '', JSON.stringify(tree)).toMatch(/^uid:/);
      await script("await qz.tab('page').locator({scope:args.frame,role:'button',name:'Frame target'}).click();", { frame: frameRoot });
      await expect(page.frameLocator('iframe').locator('#framed')).toHaveAttribute('data-clicks', '1');
    });

    await step('hidden and detached waits preserve DOM presence semantics', async () => {
      await page.locator('#state').evaluate(element => { element.hidden = true; });
      const hidden = await script("return await qz.tab('page').locator('css:#state').wait({state:'hidden'});");
      expect(hidden).toMatchObject({ state: 'hidden' });
      const attached = await script("return await qz.tab('page').locator('css:#state').wait({state:'attached'});");
      expect(attached).toMatchObject({ state: 'attached', found: true });
      await page.locator('#state').evaluate(element => element.remove());
      expect(await script("return await qz.tab('page').locator('css:#state').wait({state:'detached'});"))
        .toMatchObject({ state: 'detached', found: false });
    });

    await step('count observes every attached match and can wait for an exact list size', async () => {
      const result = await script(`
        const page=qz.tab('page'),items=page.locator({scope:'css:#counted',role:'option'});
        const before=await items.count();
        await page.evaluate(()=>setTimeout(()=>{
          for(let index=0;index<3;index++){
            const item=document.createElement('div');item.setAttribute('role','option');item.textContent='Choice '+index;
            item.hidden=index===2;document.querySelector('#counted').append(item);
          }
        },300));
        await items.wait({count:3,timeout:5});
        return {before,after:await items.count(),selected:await items.nth(1).count(),missing:await items.nth(3).count()};
      `);
      expect(result).toEqual({ before: 0, after: 3, selected: 1, missing: 0 });
    });

    await step('timeouts and completed scripts never leave a delayed action behind', async () => {
      const timeout = await script("await qz.tab('page').locator('css:#timeout').click({timeout:0.3});", {}, false);
      expect(timeout.code).toMatch(/ELEMENT_NOT_READY|TOOL_TIMEOUT/);
      await script(`
        qz.tab('page').locator('css:#cancel').click({timeout:5}).catch(()=>{});
        return 'finished';
      `);
      await page.evaluate(() => { for (const id of ['timeout','cancel']) document.getElementById(id).disabled = false; });
      await script("return await qz.tab('page').locator('css:#precise').inspect();");
      expect(await page.locator('#timeout').getAttribute('data-clicks')).toBeNull();
      expect(await page.locator('#cancel').getAttribute('data-clicks')).toBeNull();
    });

    await step('an unsuccessful navigation wait does not replay its dispatched click', async () => {
      // Let background pointer dispatch finish before the intentionally absent navigation times out.
      const timeout = await script(`
        await qz.tab('page').locator('css:#no-navigation').click({timeout:20,waitFor:'navigation',waitOptions:{timeout:10}});
      `, {}, false);
      expect(timeout.code).toMatch(/TIMEOUT/);
      expect(timeout.details).toMatchObject({
        tabRef: 'page', action: 'click', locator: { target: 'css:#no-navigation' },
        pending: 'wait_for_navigation', executed: true, mayHaveTakenEffect: true, automaticReplay: false,
      });
      await expect(page.locator('#no-navigation')).toHaveAttribute('data-clicks', '1');
    });

    await step('popup actions return a directly usable Tab and URL waits accept RegExp flags', async () => {
      const result = await script(String.raw`
        const popup=await qz.tab('page').locator('css:#popup').click({waitFor:'popup',timeout:5});
        const page=qz.tab(popup);
        const matched=await page.waitForURL(/\?POPUP$/i,{timeout:5});
        const title=await page.evaluate(()=>document.title);
        await page.close();
        return {popup,matched,title};
      `);
      expect(result.popup.tabRef).toBeTruthy();
      expect(result.matched.url).toBe(`${fixture.url}?popup`);
      expect(result.title).toBe('Locator workflow');
    });

    await step('three task popups remain readable across CLI scripts and asynchronous inventory updates', async () => {
      const opened = await script(`
        const tabs=[];
        for (const item of ['a','b','c']) {
          tabs.push(await qz.tab('page').locator('css:#item-'+item).click({waitFor:'popup',timeout:10}));
        }
        return tabs;
      `);
      expect(new Set(opened.map(tab => tab.tabRef)).size).toBe(3);
      const result = await script(`
        const inventory = await Promise.all(args.tabs.map(async tab => {
          const page=qz.tab(tab);
          const title=await page.evaluate(()=>document.title);
          await page.locator({text:'In stock: 12; Price: 35'}).wait({state:'visible'});
          return {title,article:await page.read({limit:1000})};
        }));
        return {inventory,tabs:(await qz.listTabs()).tabs};
      `, { tabs: opened });
      expect(result.inventory.map(item => item.title)).toEqual(['Item a', 'Item b', 'Item c']);
      for (const item of result.inventory) expect(item.article.text).toContain('In stock: 12; Price: 35');
      for (const tab of opened) expect(result.tabs.some(item => item.tabRef === tab.tabRef)).toBe(true);
      await script('await Promise.all(args.tabs.map(tab=>qz.tab(tab).close()));', { tabs: opened });
    });

    await step('locator observations on a user tab preserve its ownership', async () => {
      const url = `${fixture.url}?user`;
      userPage = await context.newPage();
      await userPage.goto(url);
      const observed = await script(`
        const all=await qz.listTabs({scope:'all'});
        const tab=all.tabs.find(tab=>tab.url===args.url);
        if(!tab)throw new Error('User tab was not discovered');
        const page=qz.tab(tab);
        const inspected=await page.locator({role:'button',name:'Precise'}).inspect();
        const article=await page.locator('css:#state').read({limit:1000});
        const count=await page.locator({role:'button',name:'Duplicate'}).count();
        const owned=await qz.listTabs({scope:'owned'});
        const listed=(await qz.listTabs()).tabs.find(row=>row.tabRef===tab.tabRef);
        return {tabRef:tab.tabRef,inspected,article,count,owned:owned.tabs.map(tab=>tab.tabRef),ownership:[tab.ownership,listed?.ownership]};
      `, { url });
      expect(observed.inspected).toMatchObject({ target: expect.stringMatching(/^uid:/), role: 'button' });
      expect(JSON.stringify(observed.article)).toContain('Loading state');
      expect(observed.count).toBe(2);
      expect(observed.owned).not.toContain(observed.tabRef);
      expect(observed.ownership).toEqual(['unclaimed', 'unclaimed']);
      expect(await userPage.locator('#precise').getAttribute('data-clicks')).toBeNull();
    });

    await step('independent page branches retain Promise semantics and legacy scripts remain callable', async () => {
      const result = await script(`
        const other=await qz.openTab({url:args.url,tabAlias:'second'});
        const names=await Promise.all(['page',other.tabRef].map(async tabRef=>{
          const page=qz.tab(tabRef);
          await page.locator({role:'button',name:'Precise'}).click();
          return await page.evaluate(()=>document.querySelector('#precise').dataset.clicks);
        }));
        const dynamic=await qz.call('evaluate',{tabRef:'page',code:()=>document.title});
        return {names,dynamic};
      `, { url: `${fixture.url}?second` });
      expect(result).toEqual({ names: ['2','1'], dynamic: 'Locator workflow' });
      const legacy = (await callTool(endpoint, 'qingzhou_execute_tool', buildScriptRequest({ sessionId,
        code: "return await tools.evaluate({tabRef:'page',code:()=>document.title});",
      }))).result;
      expect(legacy).toMatchObject({ ok: true, result: 'Locator workflow' });
    });
  } finally {
    if (sessionId) await cli(['session', 'cancel', sessionId, '--json']).catch(() => {});
    await userPage?.close().catch(() => {});
    await fixture.close();
    await testInfo.attach('qz-sdk-transcript.json', { body: Buffer.from(JSON.stringify(transcript, null, 2)), contentType: 'application/json' });
  }
}

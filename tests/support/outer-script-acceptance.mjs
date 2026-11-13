import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { readHealth } from '../../services/mcp-bridge/src/client.mjs';
import { exerciseSkillScripts } from './script-skill-acceptance.mjs';
import { startOuterScriptPage } from './outer-script-page.mjs';

/** The same public CLI acceptance runs against the loaded Chrome and Firefox packages. */
export async function exerciseOuterScripts({ endpoint, page, context, ui, observe, expect, step, testInfo, interleavings = false, skillScripts = false, interruption = false }) {
  const fixture = await startOuterScriptPage(), transcript = [];
  let sessionId, stopped = false;
  const observeTools = observe || (() => page.evaluate(async () => {
    const { createPortTransport } = await import('/shared/transport/port-transport.js');
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    globalThis.__qzOuterScriptEvents = [];
    globalThis.__qzOuterScriptTabs = [];
    chrome.tabs.onCreated.addListener(tab => globalThis.__qzOuterScriptTabs.push({ type: 'tab', id: tab.id, openerTabId: tab.openerTabId, url: tab.url, pendingUrl: tab.pendingUrl }));
    chrome.webNavigation.onCreatedNavigationTarget.addListener(target => globalThis.__qzOuterScriptTabs.push({ type: 'navigationTarget', ...target }));
    const transport = createPortTransport({ postMessage: message => port.postMessage(message),
      onMessage: event => { if (event.type === 'tool_execution_end') globalThis.__qzOuterScriptEvents.push(event); },
    });
    port.onMessage.addListener(message => transport.receive(message));
    globalThis.__qzOuterScriptObserver = { port, transport };
  }));
  const events = () => page.evaluate(id => globalThis.__qzOuterScriptEvents.filter(event => event.sessionId === id), sessionId);
  const cli = async (argv, stdin = '') => {
    const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
    const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
    const exitCode = await main(argv, { stdout, stderr, readStdin: async () => stdin,
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
    });
    let value; try { value = JSON.parse(stdout.text); } catch { /* Include the exact stdout in an assertion. */ }
    const entry = { argv, stdin, exitCode, stdout: stdout.text, stderr: stderr.text, value };
    transcript.push(entry);
    if (argv[0] === 'script') {
      const hasContext = Object.hasOwn(value || {}, 'context');
      expect(Object.keys(value || {}).sort(), JSON.stringify(entry)).toEqual(hasContext
        ? ['context', 'ok', 'result', 'trace'] : ['ok', 'result', 'trace']);
      expect(value.ok, JSON.stringify(entry)).toBe(exitCode === 0);
      if (value.ok) expect(hasContext, JSON.stringify(entry)).toBe(true);
      if (hasContext) expect(value.context, JSON.stringify(entry)).toEqual({ qz_skills: expect.any(Array) });
      expect(Array.isArray(value.trace), JSON.stringify(entry)).toBe(true);
      expect(value.trace.every(trace => typeof trace === 'string'), JSON.stringify(entry)).toBe(true);
    }
    return entry;
  };
  const script = async (code, args) => {
    const result = await cli(['script', '--session', sessionId, '--json', '--timeout', '60',
      ...(args === undefined ? [] : ['--args', JSON.stringify(args)]), '-'], code);
    expect(result.exitCode, JSON.stringify(result)).toBe(0); return result.value.result;
  };
  const taskTabs = () => page.evaluate(async origin => (await chrome.tabs.query({})).filter(tab =>
    (tab.url || '').startsWith(origin) || (tab.pendingUrl || '').startsWith(origin))
    .map(tab => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl })), fixture.origin);
  try {
    await observeTools();
    const created = await cli(['session', 'create', '--title', 'Outer script browser acceptance', '--json']);
    expect(created.exitCode, JSON.stringify(created)).toBe(0);
    sessionId = created.value.result.sessionId;
    if (skillScripts) {
      await exerciseSkillScripts({ page, script, cli, sessionId, events, fixture, expect });
      return;
    }
    if (interleavings) {
      await exerciseInterleavedBranches({ script, fixture, expect });
      return;
    }

    if (interruption) {
      await script(`return qz.openTab({url:args.url,tabAlias:'main'});`, { url: `${fixture.origin}/next` });
      await step('CLI SIGINT cancels its script while preserving the session and tabs', async () => {
        await script(`return qz.tab('main').evaluate(() => {
          document.body.dataset.interruptedClicks = '0';
          document.querySelector('#continue').addEventListener('click', () => {
            document.body.dataset.interruptedClicks = String(Number(document.body.dataset.interruptedClicks) + 1);
          });
        });`);
        const tabsBefore = (await taskTabs()).map(tab => tab.id).sort();
        const runsBefore = (await events()).filter(event => event.toolName === 'run_script').length;
        const argv = ['script', '--session', sessionId, '--json', '--timeout', '30', '-'];
        const stdin = `const page = qz.tab('main');
          await page.evaluate(async () => { await fetch('/hold?lane=cli-interrupt'); return true; });
          await page.locator('css:#continue').click();
          return {unexpectedSuccess:true};`;
        const child = spawn(process.execPath, ['--input-type=module', '--eval', `
          import { runMain } from ${JSON.stringify(new URL('../../services/mcp-bridge/src/cli.mjs', import.meta.url).href)};
          import { readHealth } from ${JSON.stringify(new URL('../../services/mcp-bridge/src/client.mjs', import.meta.url).href)};
          const endpoint = ${JSON.stringify(endpoint)};
          process.exitCode = await runMain(${JSON.stringify(argv)}, {
            findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
          });
        `], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const exited = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (exitCode, signal) => {
            let value; try { value = JSON.parse(stdout); } catch { /* Preserve stdout in the transcript. */ }
            const entry = { argv, stdin, exitCode, signal, stdout, stderr, value };
            transcript.push(entry); resolve(entry);
          });
        });
        void exited.catch(() => {});
        child.stdin.end(stdin);
        try {
          await expect.poll(() => fixture.pending('cli-interrupt'), { timeout: 10_000 }).toBe(1);
          expect(child.kill('SIGINT')).toBe(true);
          await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(130);
          const interrupted = await exited;
          expect(interrupted.signal, JSON.stringify(interrupted)).toBe(null);
          expect(interrupted.value, JSON.stringify(interrupted)).toMatchObject({ ok: false, result: { code: 'INTERRUPTED' } });
          expect(await script(`return qz.tab('main').evaluate(() => ({
            path: location.pathname, clicks: document.body.dataset.interruptedClicks,
          }));`)).toEqual({ path: '/next', clicks: '0' });
          await expect.poll(async () => (await events()).filter(event => event.toolName === 'run_script').length,
            { timeout: 10_000 }).toBe(runsBefore + 2);
          expect((await events()).filter(event => event.toolName === 'run_script').at(-2).isError).toBe(true);
          expect((await taskTabs()).map(tab => tab.id).sort()).toEqual(tabsBefore);
          fixture.release('cli-interrupt');
          expect(await script(`return qz.tab('main').evaluate(() => document.body.dataset.interruptedClicks);`)).toBe('0');
        } finally {
          fixture.release('cli-interrupt');
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await exited.catch(() => {});
        }
      });

      return;
    }

    await step('outer script survives real document navigation and continues through evaluate', async () => {
      const result = await script(`async () => {
        trace('navigation.begin');
        const opened = await tools.open_tab({url:input.origin+'/start',tabAlias:'main'});
        const before = await tools.evaluate({tabRef:'main',code:()=>({token:document.body.dataset.documentToken,dom:typeof document})});
        const navigation = await tools.wait_for_navigation({tabRef:'main',timeout:10,trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#navigate',action:'click'}}});
        const after = await tools.evaluate({tabRef:'main',code:()=>({token:document.body.dataset.documentToken,title:document.title,path:location.pathname})});
        trace('navigation.arrived');
        await tools.act_on_element({tabRef:'main',target:'css:#continue',action:'click'});
        const continued = await tools.evaluate({tabRef:'main',code:()=>document.body.dataset.continued});
        trace('navigation.continued');
        return {opened,before,after,continued,navigation,outerDom:typeof document};
      }`, { origin: fixture.origin });
      expect(Object.keys(result.opened).sort()).toEqual(['active', 'tabRef', 'title', 'url']);
      expect(result.opened.tabRef).toBe('main'); expect(result.opened.active).toBe(false);
      expect(result.before.dom).toBe('object'); expect(result.outerDom).toBe('undefined');
      expect(result.before.token).toEqual(expect.any(String)); expect(result.after.token).toEqual(expect.any(String));
      expect(result.after.token).not.toBe(result.before.token);
      expect(result.after.path).toBe('/next'); expect(result.after.title).toBe('Outer script /next');
      expect(result.continued).toBe('yes'); expect(result.navigation.status).toBe('navigated');
      expect(transcript.at(-1).value.trace.filter(value => ['navigation.begin', 'navigation.arrived', 'navigation.continued'].includes(value)))
        .toEqual(['navigation.begin', 'navigation.arrived', 'navigation.continued']);
      await expect.poll(async () => (await events()).filter(event => event.toolName === 'run_script').length).toBe(1);
      expect((await events()).map(event => event.toolName).sort()).toEqual([
        'open_tab', 'evaluate', 'act_on_element', 'wait_for_navigation', 'evaluate', 'act_on_element', 'evaluate', 'run_script',
      ].sort());
      const taskPage = context.pages().find(candidate => candidate.url() === `${fixture.origin}/next`);
      await expect(taskPage.locator('body')).toHaveAttribute('data-continued', 'yes');
    });

    await step('SDK wait failures distinguish completed clicks from actions still preparing', async () => {
      await script(`return qz.tab('main').evaluate(() => {
        const button = document.querySelector('#continue');
        button.dataset.evidenceClicks = '0';
        button.addEventListener('click', () => button.dataset.evidenceClicks = String(Number(button.dataset.evidenceClicks) + 1));
      });`);
      const completed = await cli(['script', '--session', sessionId, '--json', '--timeout', '10', '-'], `
        trace('before click');
        await qz.tab('main').locator('css:#continue').click({waitFor:'navigation', timeout:3});
        trace('unreached');
      `);
      expect(completed.exitCode, JSON.stringify(completed)).toBe(1);
      expect(completed.value.result).toMatchObject({ code: 'TOOL_TIMEOUT', details: {
        tool: 'act_on_element', tabRef: 'main', action: 'click', status: 'completed', executed: true,
        mayHaveTakenEffect: true, automaticReplay: false, pending: 'wait_for_navigation',
      } });
      expect(completed.value.result.message).toMatch(/act_on_element.*(?:completed|已执行完成).*wait_for_navigation/);
      expect(completed.value.trace).toContain('before click');
      expect(completed.value.trace).not.toContain('unreached');
      expect(await script(`return qz.tab('main').evaluate(() => document.querySelector('#continue').dataset.evidenceClicks);`)).toBe('1');
      const preparing = await cli(['script', '--session', sessionId, '--json', '--timeout', '10', '-'], `
        await qz.tab('main').locator({role:'button', name:'Missing fixture action'}).click({waitFor:'navigation', timeout:0.3});
      `);
      expect(preparing.exitCode, JSON.stringify(preparing)).toBe(1);
      expect(preparing.value.result.details).toMatchObject({ tool: 'act_on_element', tabRef: 'main',
        status: 'not_started', executed: false, mayHaveTakenEffect: false, automaticReplay: false });
      expect(preparing.value.result.message).toMatch(/act_on_element.*(?:did not execute|尚未执行)/);
      expect(preparing.value.result.message).not.toContain('wait_for_navigation');
    });

    await step('AJAX More clicks once without a self-unload block and state waits read current state', async () => {
      const result = await script(`async () => {
        const response = await tools.wait_for_response({tabRef:'main',urlPattern:'/api/more',timeout:10,trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#more',action:'click'}}});
        await tools.wait_for_function({tabRef:'main',code:()=>document.body.dataset.more==='loaded',timeout:5});
        await tools.wait_for_element({tabRef:'main',target:'css:#count',state:'visible',timeout:2});
        await tools.wait_for_url({tabRef:'main',urlPattern:'/next$',timeout:2});
        const load = await tools.wait_for_load({tabRef:'main',timeout:2});
        return {matched:response.matched,load:load.status,page:await tools.evaluate({tabRef:'main',code:()=>({path:location.pathname,count:document.querySelector('#count').textContent,clicks:document.querySelector('#more').dataset.clicks})})};
      }`);
      expect(result).toEqual({ matched: true, load: 'complete', page: { path: '/next', count: '2', clicks: '1' } });
      expect(fixture.requests.filter(request => request.path === '/api/more')).toHaveLength(1);
    });

    await step('function code and JSON arguments preserve business keys in raw results', async () => {
      const business = { ok: false, code: 'BUSINESS_STATUS', message: 'authored message', error: 'authored error',
        result: { tabId: 42, selector: 'inventory', nodes: [{ _plugin: { value: 1 } }] },
        snapshot: 'authored snapshot', _display: { title: 'authored display' }, _plugin: { name: 'authored plugin' } };
      const result = await script(`async () => {
        return tools.evaluate({tabRef:'main',code:value=>({payload:value[1],sum:value[0]+7,dom:typeof document}),args:input});
      }`, [5, business]);
      expect(result).toEqual({ payload: business, sum: 12, dom: 'object' });
      expect(await script(`async () => tools.evaluate({tabRef:'main',code:value=>value,args:input})`, business)).toEqual(business);
      const raw = await script('async () => input', business);
      expect(raw).toEqual(business);
    });

    await step('Promise.all overlaps across tabs and queues conflicting edits within one tab', async () => {
      await script(`async () => await tools.open_tab({url:input.url,tabAlias:'other'})`, { url: `${fixture.origin}/other` });
      const parallel = script(`async () => Promise.all(['main','other'].map(tabRef=>tools.evaluate({tabRef,code:async lane=>{
        await fetch('/hold?lane='+lane); return {lane,path:location.pathname};
      },args:tabRef})))`);
      void parallel.catch(() => {});
      try {
        await expect.poll(() => fixture.pending('main') + fixture.pending('other'), { timeout: 10_000 }).toBe(2);
      } finally { fixture.release('main'); fixture.release('other'); }
      expect(await parallel).toEqual([{ lane: 'main', path: '/next' }, { lane: 'other', path: '/other' }]);

      const serial = script(`async () => Promise.all([true,false].map(first=>tools.evaluate({tabRef:'main',code:async first=>{
        const field=document.querySelector('#edit'), before=Number(field.value);
        if(first) await fetch('/hold?lane=serial-first');
        field.value=String(before+1); return Number(field.value);
      },args:first})))`);
      void serial.catch(() => {});
      try { await expect.poll(() => fixture.pending('serial-first'), { timeout: 10_000 }).toBe(1); }
      finally { fixture.release('serial-first'); }
      expect(await serial).toEqual([1, 2]);
      expect(await script(`async () => tools.evaluate({tabRef:'main',code:()=>document.querySelector('#edit').value})`)).toBe('2');
    });

    await step('fast open-read branches finish before a held navigation and keep Promise.all result order', async () => {
      const parallel = script(`return await Promise.all(['slow-open','fast-open'].map(async tabAlias => {
        const opened = await tools.open_tab({tabAlias,url:input.origin+(tabAlias==='slow-open'?'/popup-late':'/fast')});
        const result = await tools.evaluate({tabRef:opened.tabRef,code:()=>({path:location.pathname,title:document.title})});
        trace(tabAlias+'.read');
        return {tabAlias,...result};
      }));`, { origin: fixture.origin });
      void parallel.catch(() => {});
      try {
        await expect.poll(() => fixture.pending('popup-late'), { timeout: 10_000 }).toBe(1);
        await expect.poll(async () => (await events()).filter(event => event.toolName === 'evaluate'
          && event.args?.tabRef === 'fast-open' && !event.isError).length, { timeout: 10_000 }).toBe(1);
        expect(fixture.pending('popup-late')).toBe(1, 'fast branch returns before the slow navigation is released');
      } finally { fixture.release('popup-late'); }
      expect(await parallel).toEqual([
        { tabAlias: 'slow-open', path: '/popup-late', title: 'Outer script /popup-late' },
        { tabAlias: 'fast-open', path: '/fast', title: 'Outer script /fast' },
      ]);
      expect(transcript.at(-1).value.trace.filter(value => value.endsWith('.read'))).toEqual(['fast-open.read', 'slow-open.read']);
    });

    await step('caught Promise.all errors leave siblings running and allSettled preserves every outcome', async () => {
      const parallel = script(`const slow = tools.evaluate({tabRef:'other',code:async()=>{
        await fetch('/hold?lane=caught-sibling'); return 'sibling-completed';
      }});
      let caught;
      try { await Promise.all([slow,tools.evaluate({tabRef:'main',code:()=>{throw new Error('branch-failed')}})]); }
      catch(error) { caught=error.message; }
      const outcomes=await Promise.allSettled([slow,tools.evaluate({tabRef:'main',code:()=>{throw new Error('second-failure')}})]);
      return {caught,outcomes:outcomes.map(outcome=>outcome.status==='fulfilled'
        ? {status:outcome.status,value:outcome.value} : {status:outcome.status,message:outcome.reason.message})};`);
      void parallel.catch(() => {});
      try {
        await expect.poll(() => fixture.pending('caught-sibling'), { timeout: 10_000 }).toBe(1);
        await expect.poll(async () => (await events()).filter(event => event.isError
          && JSON.stringify(event.result).includes('second-failure')).length, { timeout: 10_000 }).toBe(1);
        expect(fixture.pending('caught-sibling')).toBe(1);
      } finally { fixture.release('caught-sibling'); }
      const result = await parallel;
      expect(result.caught).toContain('branch-failed');
      expect(result.outcomes[0]).toEqual({status:'fulfilled',value:'sibling-completed'});
      expect(result.outcomes[1].status).toBe('rejected');
      expect(result.outcomes[1].message).toContain('second-failure');
    });

    await step('page errors stay canonical and future-event waits reject an already complete document', async () => {
      const failure = await cli(['script', '--session', sessionId, '--json', '--timeout', '10', '-'],
        `async () => { trace('failure.begin'); await tools.evaluate({tabRef:'main',code:()=>{
          document.body.dataset.partialRuns=String(Number(document.body.dataset.partialRuns||0)+1);
          throw new TypeError('outer-fixture-failure');
        }}); trace('failure.unreached'); }`);
      expect(failure.exitCode, JSON.stringify(failure)).toBe(1);
      expect(failure.value.result.code).toBeTruthy(); expect(failure.value.result.message).toContain('outer-fixture-failure');
      expect(Object.keys(failure.value.result).every(key => ['code', 'message', 'hint', 'details'].includes(key))).toBe(true);
      expect(failure.value.trace.filter(value => value === 'failure.begin')).toHaveLength(1);
      expect(failure.value.trace).not.toContain('failure.unreached');
      const taskPage=context.pages().find(candidate=>candidate.url()===`${fixture.origin}/next`);
      await expect(taskPage.locator('body')).toHaveAttribute('data-partial-runs','1');
      const timeout = await cli(['script', '--session', sessionId, '--json', '--timeout', '10', '-'],
        `async () => await tools.wait_for_navigation({tabRef:'main',timeout:0.15})`);
      expect(timeout.exitCode, JSON.stringify(timeout)).toBe(1);
      expect(timeout.value.result.code).toBe('TOOL_TIMEOUT');
    });

    await step('causal popup belongs to the session; cancellation rejects pending work and late completion', async () => {
      const popup = await script(`async () => {
        const child=await tools.wait_for_popup({tabRef:'main',tabAlias:'child',timeout:10,trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#popup',action:'click'}}});
        await tools.wait_for_url({tabRef:child.tabRef,urlPattern:'/popup$',timeout:10});
        await tools.wait_for_load({tabRef:child.tabRef,timeout:10});
        return {child,document:await tools.evaluate({tabRef:child.tabRef,code:()=>({path:location.pathname,title:document.title})}),owned:await tools.list_tabs({scope:'owned'})};
      }`);
      expect(Object.keys(popup.child).sort()).toEqual(['active', 'tabRef', 'title', 'url']);
      expect(popup.child.tabRef).toBe('child'); expect(popup.document.path).toBe('/popup');
      expect(popup.owned.tabs.some(tab => tab.tabRef === 'child')).toBe(true);
      const evaluatedPopup = await script(`async () => {
        const child=await tools.wait_for_popup({tabRef:'main',tabAlias:'evaluated-child',timeout:10,trigger:{name:'evaluate',args:{tabRef:'main',code:"url=>{window.open(url,'_blank');return true;}",args:input.url}}});
        await tools.wait_for_url({tabRef:child.tabRef,urlPattern:'/popup-evaluate$',timeout:10});
        await tools.wait_for_load({tabRef:child.tabRef,timeout:10});
        return {child,path:await tools.evaluate({tabRef:child.tabRef,code:()=>location.pathname}),owned:await tools.list_tabs({scope:'owned'})};
      }`, {url:`${fixture.origin}/popup-evaluate`});
      expect(evaluatedPopup.child.tabRef).toBe('evaluated-child');
      expect(evaluatedPopup.path).toBe('/popup-evaluate');
      expect(evaluatedPopup.owned.tabs.some(tab=>tab.tabRef==='evaluated-child')).toBe(true);
      await step('each actual tool invocation has one persisted card in the titled session', async () => {
        const completed = await events();
        expect(new Set(completed.map(event => event.toolCallId)).size).toBe(completed.length);
        const recorded = await page.evaluate(async id => {
          const { readSessionSnapshot } = await import('/shared/session/session-recovery.js');
          const key=`_session_${id}`, checkpoint=`_session_transcript_checkpoint_${id}`;
          const stored=await chrome.storage.local.get([key,checkpoint]);
          return readSessionSnapshot(stored[key],null,stored[checkpoint]).transcript.filter(row=>row.type==='tool');
        }, sessionId);
        expect(recorded.map(row => row.toolCallId).sort()).toEqual(completed.map(event => event.toolCallId).sort());
        if (ui) { await ui({ sessionId, title: 'Outer script browser acceptance', count: completed.length, expect }); return; }
        await page.locator('[data-tab="sessions"]').click();
        await page.locator('[data-sessions-mode="external-drive"]').click();
        const row=page.locator(`#sessions-list .session-card[data-id="${sessionId}"]:not(.is-removing)`);
        await expect(row.locator('.session-card-title')).toHaveText('Outer script browser acceptance');
        await row.click();
        const cards=page.locator('#messages .msg-tool');
        await expect(cards).toHaveCount(completed.length);
        const ids=await cards.evaluateAll(nodes=>nodes.map(node=>node.id));
        expect(new Set(ids).size).toBe(ids.length);
      });
      const pending = cli(['script', '--session', sessionId, '--json', '--timeout', '20', '-'], `async () => {
        const child=await tools.wait_for_popup({tabRef:'main',tabAlias:'late',timeout:15,trigger:{name:'act_on_element',args:{tabRef:'main',target:'css:#popup-late',action:'click'}}});
        await tools.wait_for_load({tabRef:child.tabRef,timeout:15});
        return {lateSuccess:true};
      }`);
      await expect.poll(() => fixture.pending('popup-late'), { timeout: 10_000 }).toBe(1);
      const cancel = await cli(['cancel', sessionId, '--json']);
      expect(cancel.exitCode, JSON.stringify(cancel)).toBe(0); stopped = true;
      expect(cancel.stdout).not.toMatch(/tabId|workingTab/);
      fixture.release('popup-late');
      const rejected = await pending;
      expect(rejected.exitCode, JSON.stringify(rejected)).toBe(1);
      expect(rejected.value.result.code).toMatch(/OPERATION_ABORTED|RUN_STOPPED|DRIVE_SESSION_ENDED/);
      expect(rejected.value.result).not.toHaveProperty('lateSuccess');
      await expect.poll(taskTabs, { timeout: 10_000 }).toEqual([]);
      assert.equal(transcript.filter(entry => entry.argv[0]==='script'&&entry.exitCode===0&&entry.value?.result?.lateSuccess).length,0);
    });
  } finally {
    const runtime = await page.evaluate(async id => ({
      events: globalThis.__qzOuterScriptEvents.filter(event => event.sessionId === id),
      created: globalThis.__qzOuterScriptTabs,
      tabs: (await chrome.tabs.query({})).map(tab => ({ id: tab.id, openerTabId: tab.openerTabId, url: tab.url, pendingUrl: tab.pendingUrl })),
    }), sessionId).catch(error => ({ error: error.message }));
    await testInfo.attach('outer-script-runtime-evidence.json', { body: Buffer.from(JSON.stringify({ ...runtime, requests: fixture.requests }, null, 2)), contentType: 'application/json' });
    if (sessionId && !stopped) await cli(['cancel', sessionId, '--json']).catch(() => {});
    await testInfo.attach('outer-script-cli-transcript.json', { body: Buffer.from(JSON.stringify(transcript, null, 2)), contentType: 'application/json' });
    await fixture.close();
  }
}

async function exerciseInterleavedBranches({ script, fixture, expect }) {
  const refs = await script(`return await Promise.all([null,'stress-one','stress-two'].map(async tabAlias => {
    const opened=await tools.open_tab({url:input.origin+'/start',...(tabAlias?{tabAlias}:{})});
    return opened.tabRef;
  }));`, { origin: fixture.origin });
  const navigated = await script(`return await Promise.all(input.refs.map(tabRef =>
    tools.wait_for_navigation({tabRef,timeout:10,trigger:{name:'run_script',args:{args:{tabRef},code:
      "await tools.list_tools(); return await tools.act_on_element({tabRef:input.tabRef,target:'css:#navigate',action:'click'});"
    }}})));`, { refs });
  expect(navigated.map(result => result.status)).toEqual(['navigated', 'navigated', 'navigated']);
  for (const seed of [7, 29, 83]) {
    let random = seed, finished = false;
    const labels = Array.from({ length: 30 }, (_, i) => `${seed}-${Math.floor(i / 5)}-${i % 5}`);
    const pending = script(`const branches=Array.from({length:6},(_,branch)=>(async()=>{
      const reference=input.refs[branch%3], tabRef=branch%2?String(reference):reference, results=[];
      for(let step=0;step<5;step++){
        const ticket=input.seed+'-'+branch+'-'+step;
        try {
          results.push(await tools.evaluate({tabRef,code:async ({ticket,fail})=>{
            if(document.body.dataset.busy) throw new Error('overlapping-page-actions');
            document.body.dataset.busy=ticket;
            try {
              await fetch('/hold?lane='+ticket);
              if(fail) throw new Error('expected-branch-error');
              return ticket;
            } finally { delete document.body.dataset.busy; }
          },args:{ticket,fail:branch===1&&step===1}}));
        } catch(error) {
          if(!error.message.includes('expected-branch-error')) throw error;
          results.push('caught:'+ticket);
        }
        if(step===2&&branch<3) await tools.wait_for_navigation({tabRef,timeout:10,
          trigger:{name:'act_on_element',args:{tabRef,target:'css:#navigate',action:'click'}}});
        if(step===3) await Promise.all([
          tools.find_elements({tabRef,pattern:'Continue'}),
          tools.evaluate({tabRef,code:()=>document.title}),
        ]);
      }
      return results;
    })());
    return (await Promise.allSettled(branches)).map(row=>row.status==='fulfilled'
      ? {status:row.status,value:row.value} : {status:row.status,error:row.reason.message});`, { refs, seed });
    void pending.then(() => { finished = true; }, () => { finished = true; });
    try {
      for (let round = 0; round < 120 && !finished; round++) {
        await expect.poll(() => finished || labels.some(label => fixture.pending(label)), { timeout: 10_000, intervals: [10, 20, 50] }).toBeTruthy();
        const available = labels.filter(label => fixture.pending(label));
        for (let lane = 0; lane < 3; lane++) expect(available.filter(label => Number(label.split('-')[1]) % 3 === lane).length).toBeLessThanOrEqual(1);
        if (available.length) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          fixture.release(available[random % available.length]);
        }
      }
      expect(finished).toBe(true);
      const result = await pending;
      expect(result).toEqual(Array.from({ length: 6 }, (_, branch) => ({ status: 'fulfilled',
        value: Array.from({ length: 5 }, (_, step) => `${branch === 1 && step === 1 ? 'caught:' : ''}${seed}-${branch}-${step}`),
      })));
      const requests = fixture.requests.filter(request => request.path === '/hold' && request.lane.startsWith(`${seed}-`));
      expect(requests).toHaveLength(30);
      expect(new Set(requests.map(request => request.lane)).size).toBe(30);
    } finally { for (const label of labels) fixture.release(label); }
  }
}

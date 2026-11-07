import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { test, expect } from './fixture.mjs';
import { openFirefoxSidebar } from './launch.mjs';
import { connectFirefoxCli } from '../support/firefox-isolated-cli.mjs';
import { main } from '../../services/mcp-bridge/src/cli.mjs';
import { readHealth } from '../../services/mcp-bridge/src/client.mjs';

test('Firefox page scripts honor permission approval and run under strict CSP', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const browser = await openFirefoxSidebar({ grantUserScripts: false });
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; frame-src 'self'",
    });
    response.end(request.url === '/child'
      ? '<!doctype html><title>Strict child</title><h1>Child</h1>'
      : '<!doctype html><title>Strict parent</title><h1>Parent</h1><output id="state">pending</output><iframe src="/child"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const transcript = [];
  let sessionId, environment;
  const cli = async (argv, source = '') => {
    const stdout = { isTTY: false, text: '', write(value) { this.text += value; } };
    const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
    const exitCode = await main(argv, { stdout, stderr, readStdin: async () => source,
      findDaemon: async () => ({ endpoint: environment.endpoint, health: await readHealth(environment.endpoint) }),
    });
    transcript.push({ argv, source, exitCode, stdout: stdout.text, stderr: stderr.text });
    const result = JSON.parse(stdout.text);
    expect(result.ok, stdout.text).toBe(exitCode === 0);
    return result;
  };
  const script = source => cli(['script', '--session', sessionId, '--timeout', '45', '-'], source);
  const hasPermission = () => browser.extension('background', `
    return await view.chrome.permissions.contains(Cu.cloneInto({permissions:['userScripts']},content));
  `);
  try {
    environment = await connectFirefoxCli(browser, { requireObserver: false });
    expect(await hasPermission()).toBe(false);
    const created = await cli(['session', 'create', '--title', 'Strict CSP page scripts', '--json']);
    expect(created.ok).toBe(true);
    sessionId = created.result.sessionId;
    expect((await script(`return await Promise.all([
      qz.openTab({url:${JSON.stringify(url)},tabAlias:'strict'}),
      qz.openTab({url:${JSON.stringify(url + '?second')},tabAlias:'second'})
    ]);`)).ok).toBe(true);
    await expect.poll(() => browser.context.pages().some(page => page.url() === url)).toBe(true);
    const page = browser.context.pages().find(page => page.url() === url);
    await expect.poll(() => browser.context.pages().some(page => page.url() === url + '?second')).toBe(true);
    const secondPage = browser.context.pages().find(page => page.url() === url + '?second');
    await page.frameLocator('iframe').locator('h1').waitFor();
    // Firefox anchors native permission prompts to the selected tab; the connect page auto-closes.
    await page.bringToFront();

    await test.step('the permission card requests native Firefox approval before execution', async () => {
      const pending = script(`return await Promise.all(['strict','second'].map(tabRef=>qz.tab(tabRef).evaluate(() => {
        document.body.dataset.executions=String(Number(document.body.dataset.executions||0)+1);
        return {title:document.title,calls:Number(document.body.dataset.executions)};
      })));`);
      await selectSession(browser, sessionId);
      await waitForPermissionCard(browser);
      expect(await browser.extension('sidebar', `return content.document.querySelectorAll('.waiting-active').length;`)).toBe(1);
      expect(await page.locator('body').getAttribute('data-executions')).toBeNull();
      expect(await secondPage.locator('body').getAttribute('data-executions')).toBeNull();
      await clickSidebar(browser, '.waiting-active [data-wait-action="continue"]');
      const nativePromptReady = () => browser.chrome(`
        const win=Services.wm.getMostRecentWindow('navigator:browser');
        const panel=win.PopupNotifications.panel,prompt=panel.querySelector('popupnotification');
        return !!win.PopupNotifications.getNotification('addon-webext-permissions')
          && panel.state==='open' && !!prompt?.button;
      `);
      await expect.poll(async () => await hasPermission() || await nativePromptReady()).toBe(true);
      // Firefox may grant without an additional warning. Otherwise click its real doorhanger.
      if (!await hasPermission()) {
        await browser.chrome(`
          const win=Services.wm.getMostRecentWindow('navigator:browser');
          const prompt=win.PopupNotifications.panel.querySelector('popupnotification');
          if(!prompt?.button)throw new Error('Firefox permission Allow button is missing');
          const confirmation=prompt.querySelector('.webext-perm-optional moz-checkbox');
          if(confirmation&&!confirmation.checked)confirmation.click();return true;
        `);
        await expect.poll(() => browser.chrome(`
          const win=Services.wm.getMostRecentWindow('navigator:browser');
          const button=win.PopupNotifications.panel.querySelector('popupnotification')?.button;
          return !!button&&!button.disabled;
        `)).toBe(true);
        await browser.chrome(`Services.wm.getMostRecentWindow('navigator:browser').PopupNotifications.panel.querySelector('popupnotification').button.click();return true;`);
      }
      await expect.poll(hasPermission).toBe(true);
      const result = await pending;
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: [
        { title: 'Strict parent', calls: 1 }, { title: 'Strict parent', calls: 1 },
      ] });
      expect(await hasPermission()).toBe(true);
      await expect(page.locator('body')).toHaveAttribute('data-executions', '1');
      await expect(secondPage.locator('body')).toHaveAttribute('data-executions', '1');
    });

    await test.step('async values, caught errors and condition waits reach the outer script', async () => {
      const result = await script(`
        const page=qz.tab('strict'),failures=[];
        const value=await page.evaluate(async input=>{await Promise.resolve();return {title:document.title,input};},{answer:42});
        for(const code of [
          ()=>{document.body.dataset.syncCalls=String(Number(document.body.dataset.syncCalls||0)+1);throw new Error('SYNC_SENTINEL');},
          async()=>{document.body.dataset.asyncCalls=String(Number(document.body.dataset.asyncCalls||0)+1);await Promise.resolve();throw new TypeError('ASYNC_SENTINEL');}
        ])try{await page.evaluate(code);}catch(error){failures.push({code:error.code,message:error.message});}
        await page.evaluate(()=>{setTimeout(()=>{document.querySelector('#state').textContent='ready';},150);});
        const ready=await page.waitForFunction(expected=>document.querySelector('#state').textContent===expected&&{state:expected},'ready',{timeout:5});
        return {value,failures,ready,continued:await page.evaluate(()=>document.body.dataset.executions)};
      `);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
        value: { title: 'Strict parent', input: { answer: 42 } }, ready: { state: 'ready' }, continued: '1',
      } });
      expect(result.result.failures).toEqual([
        { code: 'SCRIPT_EVALUATION_FAILED', message: expect.stringContaining('SYNC_SENTINEL') },
        { code: 'SCRIPT_EVALUATION_FAILED', message: expect.stringContaining('ASYNC_SENTINEL') },
      ]);
      await expect(page.locator('body')).toHaveAttribute('data-sync-calls', '1');
      await expect(page.locator('body')).toHaveAttribute('data-async-calls', '1');
    });

    await test.step('native evaluation respects the selected child frame', async () => {
      // The public page SDK targets the top document. Exercise frame routing at its adapter boundary.
      const result = await browser.extension('background', `
        const tab=(await view.chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(url)});
        const frames=await view.chrome.webNavigation.getAllFrames(Cu.cloneInto({tabId:tab.id},content));
        const child=frames.find(frame=>frame.parentFrameId===0);
        if(!child)throw new Error('Strict CSP child frame is missing');
        const target=Cu.cloneInto({tabId:tab.id,sessionId:'ff-'+tab.id+'-'+child.frameId},content);
        await view.chrome.debugger.attach(Cu.cloneInto({tabId:tab.id},content),'1.3');
        return await view.chrome.debugger.sendCommand(target,'Runtime.evaluate',Cu.cloneInto({
          expression:'(async()=>({title:document.title,isTop:window===top}))()',awaitPromise:true,returnByValue:true,
        },content));
      `);
      expect(result, JSON.stringify(result)).toMatchObject({ result: { value: { title: 'Strict child', isTop: false } } });
      expect(result).not.toHaveProperty('exceptionDetails');
    });

    await test.step('revocation pauses condition scripts and cancellation prevents execution', async () => {
      await browser.extension('background', `await view.chrome.permissions.remove(Cu.cloneInto({permissions:['userScripts']},content));`);
      expect(await hasPermission()).toBe(false);
      const pending = script(`return await qz.tab('strict').waitForFunction(()=>{document.body.dataset.revoked='executed';return true;},undefined,{timeout:5});`);
      await waitForPermissionCard(browser);
      expect(await page.locator('body').getAttribute('data-revoked')).toBeNull();
      await clickSidebar(browser, '.waiting-active [data-wait-action="cancel"]');
      const result = await pending;
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, result: { code: 'USER_CANCELLED_WAIT' } });
      expect(await hasPermission()).toBe(false);
      expect(await page.locator('body').getAttribute('data-revoked')).toBeNull();
    });
  } finally {
    const sidebar = await browser.extension('sidebar', `return {
      text:content.document.body.innerText.slice(0,20000),messages:content.document.querySelector('#messages')?.innerHTML.slice(0,30000),
    };`).catch(error => ({ error: error.message }));
    const native = await browser.chrome(`
      const win=Services.wm.getMostRecentWindow('navigator:browser'),panel=win.PopupNotifications.panel;
      return {panelState:panel.state,html:panel.innerHTML.slice(0,15000),prompts:Services.prefs.getBoolPref('extensions.webextOptionalPermissionPrompts',true)};
    `).catch(error=>({error:error.message}));
    const permissionGranted = await hasPermission().catch(() => false);
    if (sessionId) await cli(['session', 'cancel', sessionId, '--json']).catch(() => {});
    await browser.extension('background', `await view.chrome.permissions.remove(Cu.cloneInto({permissions:['userScripts']},content));`).catch(() => {});
    await environment?.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const evidence = testInfo.outputPath('firefox-evaluate-csp.json');
    await writeFile(evidence, JSON.stringify({ transcript, sidebar, native, permissionGranted }, null, 2));
    await testInfo.attach('firefox-evaluate-csp.json', { path: evidence, contentType: 'application/json' });
  }
});

async function selectSession(browser, sessionId) {
  await browser.extension('sidebar', `
    content.document.querySelector('[data-tab="sessions"]').click();
    content.document.querySelector('[data-sessions-mode="external-drive"]').click();
  `);
  const selector = `.session-card[data-id="${sessionId}"]:not(.is-removing)`;
  await expect.poll(() => browser.extension('sidebar', `return !!content.document.querySelector(${JSON.stringify(selector)});`)).toBe(true);
  await browser.extension('sidebar', `content.document.querySelector(${JSON.stringify(selector)}).click();`);
}

async function waitForPermissionCard(browser) {
  await expect.poll(() => browser.extension('sidebar', `
    const card=content.document.querySelector('.waiting-active');
    return !!card?.querySelector('[data-wait-action="continue"]:not([disabled])');
  `)).toBe(true);
}

async function clickSidebar(browser, selector) {
  const gesture = await browser.extension('sidebar', `
    const button=content.document.querySelector(${JSON.stringify(selector)});
    if(!button)throw new Error('Sidebar button is missing');
    button.scrollIntoView({block:'center'});
    let trusted=false,handling=false;button.addEventListener('click',event=>{trusted=event.isTrusted;handling=content.windowUtils.isHandlingUserInput;},{once:true});
    const rect=button.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    const mouse={button:0,clickCount:1},options={isDOMEventSynthesized:true,isWidgetEventSynthesized:false,isAsyncEnabled:false};
    // Native synthesized events need a scoped input-handler flag in the privileged test driver.
    const userInput=content.windowUtils.setHandlingUserInput(true);
    try{
      content.synthesizeMouseEvent('mousedown',x,y,mouse,options);
      content.synthesizeMouseEvent('mouseup',x,y,mouse,options);
    }finally{userInput.destruct();}
    return {trusted,handling};
  `);
  expect(gesture, 'The permission UI must receive a trusted user click').toEqual({ trusted: true, handling: true });
}

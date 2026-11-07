import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { test, expect } from './fixtures.mjs';
import { buildIdentity, daemonPaths } from '../../services/mcp-bridge/src/daemon.mjs';
import { startBridge } from '../../services/mcp-bridge/src/server.mjs';
import { readHealth } from '../../services/mcp-bridge/src/client.mjs';
import { acceptDataDisclosure } from '../support/data-consent.mjs';
import { ensureTestExtension } from '../support/extension-build.mjs';
import { startDriveTaskPage } from '../support/drive-task-page.mjs';
import { startOuterScriptPage } from '../support/outer-script-page.mjs';
import { driveTaskScenarios } from '../support/drive-task-scenarios.mjs';

const scenarioIds = ['checkout-document', 'checkout-spa', 'checkout-shadow', 'compare-documents', ...driveTaskScenarios.map(([id]) => id)];
expect(scenarioIds).toHaveLength(25);
expect(new Set(scenarioIds).size).toBe(25);

const seeds = (process.env.QZ_DRIVE_FUZZ_SEEDS || '73,65537,20261103').split(',').map(value => {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new Error('QZ_DRIVE_FUZZ_SEEDS requires positive uint32 seeds');
  return seed;
});
for (const seed of seeds) {
  test(`direct CLI task and reconnect fuzz seed=${seed}`, async ({}, info) => {
    test.setTimeout(480_000);
    let state = seed;
    const choose = max => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
    const directory = await mkdtemp(join(tmpdir(), 'qz-drive-fuzz-'));
    const identity = buildIdentity(), contexts = [], browserObservers = [];
    const report = { seed, calls: [], tasks: [], events: [], scenarios: [] };
    const env = { ...process.env, QZ_STATE_DIR: join(directory, 'state'), NO_COLOR: '1' };
    for (const name of Object.keys(env)) if (/API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NODE_OPTIONS|NODE_PATH/i.test(name)) delete env[name];
    const paths = daemonPaths({ ...identity, stateDir: env.QZ_STATE_DIR });
    let bridge, pages, site;
    const writeState = async () => {
      const health = await readHealth(bridge.endpoint);
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.state, JSON.stringify({ endpoint: bridge.endpoint, ...identity, instanceId: health.instanceId, processId: health.processId }));
    };
    const cli = async (argv, stdin = '', expected = 0) => {
      const startedAt = Date.now(), started = performance.now();
      const child = spawn(process.execPath, ['services/mcp-bridge/src/bin.mjs', ...argv], {
        cwd: new URL('../../', import.meta.url), env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
      child.stdin.end(stdin);
      const timer = setTimeout(() => child.kill('SIGKILL'), 70_000);
      let exitCode;
      try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearTimeout(timer); }
      report.calls.push({ argv, stdin, exitCode, stdout, stderr, stdoutChars: stdout.length, startedAt, ms: Math.round(performance.now() - started) });
      expect(exitCode, `seed=${seed} ${argv.join(' ')}\n${stdout}\n${stderr}`).toBe(expected);
      return JSON.parse(stdout);
    };
    const script = (id, code, args = {}, expected = 0, client) => cli([
      'script', '--session', id, '--timeout', '20', '--args', JSON.stringify(args),
      ...(client ? ['--client', client] : []), '-',
    ], code, expected);
    try {
      const extension = await ensureTestExtension();
      bridge = await startBridge({ port: 0, ...identity, registryPath: join(directory, 'browsers.json') });
      await writeState();
      pages = await startDriveTaskPage();
      site = await startOuterScriptPage();
      // Two real isolated profiles share one bridge; no injected CLI transport or findDaemon.
      for (const name of ['alpha', 'beta']) {
        const context = await chromium.launchPersistentContext(join(directory, name), {
          headless: true, executablePath: process.env.CHROME_EXECUTABLE || chromium.executablePath(), ignoreDefaultArgs: ['--disable-extensions'],
          args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        });
        contexts.push(context);
        // A renderer can crash before Playwright exposes its Page object.
        const observer = await context.browser().newBrowserCDPSession(), targets = new Map();
        browserObservers.push(observer);
        for (const event of ['targetCreated', 'targetInfoChanged']) {
          observer.on(`Target.${event}`, ({ targetInfo }) => targets.set(targetInfo.targetId, targetInfo));
        }
        observer.on('Target.targetDestroyed', ({ targetId }) => targets.delete(targetId));
        observer.on('Target.targetCrashed', ({ targetId, status, errorCode }) => report.events.push({
          kind: 'target-crashed', at: Date.now(), owner: name, targetId, status, errorCode,
          url: targets.get(targetId)?.url ?? null, type: targets.get(targetId)?.type ?? null,
        }));
        await observer.send('Target.setDiscoverTargets', { discover: true });
        await context.route('http://127.0.0.1:18765/**', route => route.abort());
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const panel = await context.newPage();
        await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel/sidepanel.html`);
        await panel.locator('[data-consent-accept]').waitFor();
        await acceptDataDisclosure(panel, { disableBridge: false });
        const connection = await context.newPage();
        await connection.goto(`${bridge.endpoint}/qz-connect?name=${name}`);
        await connection.locator('[data-qz-connection-state="connected"]').waitFor();
        await context.unroute('http://127.0.0.1:18765/**');
      }
      const browserIds = (await readHealth(bridge.endpoint)).status.clients.map(row => row.clientId).sort();
      expect(browserIds).toHaveLength(2);
      const order = ['document', 'spa', 'shadow'];
      for (let i = order.length - 1; i > 0; i--) { const j = choose(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      for (const [index, mode] of order.entries()) {
        const owner = choose(2), name = ['alpha', 'beta'][owner];
        const task = { id: `s${seed}-${index}`, mode, owner: name, quantity: String(2 + choose(7)),
          shipping: choose(2) ? 'express' : 'standard', gift: Boolean(choose(2)), price: 11 + choose(37), delay: choose(4) * 35 };
        report.tasks.push(task);
        const url = pages.add(task.id, task);
        const sid = (await cli(['session', 'create', '--title', `Fuzz ${task.id}`, '--client', name, '--json'])).result.sessionId;
        // Reuse the session without a selector: ownership must win over browser enumeration order.
        const opened = await script(sid, `await tools.open_tab({url:input.url,tabAlias:'order'});
          await tools.wait_for_function({tabRef:'order',code:()=>document.body.dataset.ready==='yes'});
          const found=await tools.find_elements({tabRef:'order',target:'css:#task',roles:['textbox','combobox','checkbox','button'],limit:8});
          const targets=Object.fromEntries(found.results.map(row=>[row.name||row.text,row.target]));
          return {targets,fullChars:JSON.stringify(found).length};`, { url });
        expect(Object.keys(opened.result.targets).sort()).toEqual(['Gift wrap', 'Quantity', 'Save order', 'Shipping']);
        const targets = opened.result.targets;
        task.observationChars = { full: opened.result.fullChars, projected: JSON.stringify(targets).length };
        expect(task.observationChars.projected).toBeLessThan(task.observationChars.full / 4);
        // Raw intermediate tool results must stay inside the script, not leak into stdout/traces.
        expect(report.calls.at(-1).stdout).not.toMatch(/clickablePoint|obscuredAtCenter|lineRange/);
        const actualPage = contexts[owner].pages().find(page => page.url() === url);
        expect(actualPage, 'session must execute in its owning browser').toBeTruthy();
        expect(contexts[1 - owner].pages().some(page => page.url() === url)).toBe(false);

        // A randomized side-effect boundary: failure leaves the field changed, never replays it.
        const partialFailure = Boolean(choose(2));
        const filled = await script(sid, `await tools.act_on_element({tabRef:'order',target:input.target,action:'fill',value:input.value});
          ${partialFailure ? "throw new Error('intentional fuzz boundary');" : 'return {filled:true};'}`,
        { target: targets.Quantity, value: task.quantity }, partialFailure ? 1 : 0);
        if (partialFailure) expect(filled.result.message).toBe('intentional fuzz boundary');
        expect(await actualPage.getByRole('textbox', { name: 'Quantity', exact: true }).last().inputValue()).toBe(task.quantity);

        // The corpus covers every fault phase; extra seeds explore different histories.
        const restartPhase = ['before-submit', 'after-submit', 'inflight'][seed % 3];
        const interrupted = index === 1 && restartPhase === 'inflight';
        task.hold = interrupted;
        const restart = async () => {
          // A compatible build difference must not replace the service or browser identities.
          const port = Number(new URL(bridge.endpoint).port);
          await bridge.close();
          pages.release(task.id);
          bridge = await startBridge({ port, ...identity, buildId: `previous-build-${seed}`, registryPath: join(directory, 'browsers.json') });
          await writeState();
          report.events.push({ kind: 'service-restart', task: task.id, phase: restartPhase });
          // Observe auto-reconnection, without opening a pairing page or rewriting extension storage.
          await expect.poll(async () => (await readHealth(bridge.endpoint)).status.clients.map(row => row.clientId).sort(),
            { timeout: 75_000 }).toEqual(browserIds);
          const status = await cli(['status', '--json']);
          expect(status.result.updateAvailable).toBe(true);
        };
        if (index === 1 && restartPhase === 'before-submit') await restart();
        const wrong = await script(sid, `return await tools.list_tabs();`, {}, 1, ['alpha', 'beta'][1 - owner]);
        expect(wrong.result.code).toBe('DRIVE_SESSION_NOT_FOUND');
        if (mode === 'shadow') {
          const cssMiss = await script(sid, `return await tools.act_on_element({tabRef:'order',target:'css:#gift',action:'check'});`, {}, 1);
          expect(cssMiss.result.code).toBe('ELEMENT_NOT_READY');
          expect(pages.receipts.filter(row => row.id === task.id)).toHaveLength(0);
        }
        const changes = [
          `await tools.act_on_element({tabRef:'order',target:input.targets.Shipping,action:'select',value:input.shipping});`,
          `await tools.act_on_element({tabRef:'order',target:input.targets['Gift wrap'],action:input.gift?'check':'uncheck'});`,
        ];
        if (choose(2)) changes.reverse();
        const failAfterSave = !interrupted && Boolean(choose(2));
        task.partialFailure = partialFailure;
        task.failAfterSave = failAfterSave;
        const saving = script(sid, `${changes.join('\n')}
          await tools.wait_for_response({tabRef:'order',urlPattern:'/submit/',trigger:{name:'act_on_element',args:{tabRef:'order',target:input.targets['Save order'],action:'click'}}});
          await tools.wait_for_function({tabRef:'order',code:()=>document.body.dataset.saved==='yes'});
          ${failAfterSave ? "throw new Error('after submit boundary');" : "return await tools.evaluate({tabRef:'order',code:()=>{const host=document.querySelector('#task');return {total:(host.shadowRoot||host).querySelector('#result').textContent,path:location.pathname};}});"}`,
        { ...task, targets }, failAfterSave || interrupted ? 1 : 0);
        if (interrupted) {
          await expect.poll(() => pages.receipts.filter(row => row.id === task.id).length).toBe(1);
          await restart();
        }
        let saved = await saving;
        if (index === 1 && restartPhase === 'after-submit') await restart();
        if (failAfterSave || interrupted) {
          if (failAfterSave) expect(saved.result.message).toBe('after submit boundary');
          else expect(saved.result.code).toMatch(/CLOSED|DISCONNECTED|CONNECTION|REQUEST/);
          // Inspect the committed result in a fresh CLI process; never resubmit.
          saved = await script(sid, `return await tools.evaluate({tabRef:'order',code:()=>{const host=document.querySelector('#task');return {total:(host.shadowRoot||host).querySelector('#result').textContent,path:location.pathname};}});`);
        }
        const expectedTotal = Number(task.quantity) * task.price + (task.shipping === 'express' ? 17 : 5) + (task.gift ? 3 : 0);
        expect(saved.result).toEqual({ total: String(expectedTotal), path: `/${mode === 'spa' ? 'done' : 'order'}/${task.id}` });
        expect(pages.receipts.filter(row => row.id === task.id)).toEqual([
          { id: task.id, quantity: task.quantity, shipping: task.shipping, gift: task.gift },
        ]);
        expect(await actualPage.locator('#result').textContent()).toBe(String(expectedTotal));
        expect(await actualPage.locator('aside input').inputValue()).toBe('999');
        const popup = await script(sid, `await tools.wait_for_popup({tabRef:'order',tabAlias:'receipt',trigger:{name:'act_on_element',args:{tabRef:'order',target:'css:#receipt',action:'click'}}});
          const article=await tools.read_article({tabRef:'receipt',limit:600});return {text:article.text};`);
        expect(popup.result.text).toContain(`Receipt ${task.id}`);
        const canceled = await cli(['session', 'cancel', sid, '--json']);
        expect(canceled.result.status).toBe('aborted');
        expect(contexts[owner].pages().filter(page => page.url().includes(task.id))).toHaveLength(0);
        const ended = await script(sid, `return await tools.list_tabs();`, {}, 1, name);
        expect(ended.result.code).toBe('DRIVE_SESSION_ENDED');
        report.scenarios.push({ id: `checkout-${mode}`, status: 'passed' });
      }
      expect(pages.receipts).toHaveLength(order.length);

      // A different task: compare independent documents concurrently and retain source URLs.
      const prices = [19 + choose(31), 73 + choose(47)];
      if (choose(2)) prices.reverse();
      const urls = prices.map((price, index) => pages.add(`research-${seed}-${index}`, { price }).replace('/order/', '/receipt/'));
      const sid = (await cli(['session', 'create', '--title', `Compare sources ${seed}`, '--client', choose(2) ? 'alpha' : 'beta', '--json'])).result.sessionId;
      const compared = await script(sid, `await Promise.all(input.urls.map((url,index)=>tools.open_tab({url,tabAlias:'source-'+index})));
        const rows=await Promise.all(input.urls.map(async (_,index)=>{
          const article=await tools.read_article({tabRef:'source-'+index,limit:1000});
          return {source:article.url,price:Number(article.text.match(/Unit price (\\d+)/)[1])};
        }));return {rows,cheapest:rows.reduce((a,b)=>a.price<b.price?a:b)};`, { urls });
      expect(compared.result.rows).toEqual(urls.map((source, index) => ({ source, price: prices[index] })));
      const cheapest = prices[0] < prices[1] ? 0 : 1;
      expect(compared.result.cheapest).toEqual({ source: urls[cheapest], price: prices[cheapest] });
      await cli(['session', 'cancel', sid, '--json']);
      expect(contexts.flatMap(context => context.pages()).filter(page => page.url().startsWith(pages.origin))).toHaveLength(0);
      report.scenarios.push({ id: 'compare-documents', status: 'passed' });

      const deck = [...driveTaskScenarios], failures = [];
      for (let i = deck.length - 1; i > 0; i--) { const j = choose(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      for (const [id, exercise] of deck) {
        await test.step(id, async () => {
          const ownerIndex = choose(2), owner = ['alpha', 'beta'][ownerIndex], context = contexts[ownerIndex];
          const row = { id, owner, status: 'running', firstCommand: report.calls.length };
          report.scenarios.push(row);
          const sid = (await cli(['session', 'create', '--title', `${id} seed=${seed}`, '--client', owner, '--json'])).result.sessionId;
          const url = `${site.origin}/case-${seed}-${id}`;
          const run = (code, args, expected) => script(sid, code, args, expected);
          let canceled = false;
          try {
            await run(`await tools.open_tab({url:input.url,tabAlias:'main'});
              return await tools.wait_for_element({tabRef:'main',target:'css:body[data-document-token] #edit'});`, { url });
            const page = context.pages().find(page => page.url() === url);
            expect(page).toBeTruthy();
            expect(contexts[1 - ownerIndex].pages().some(page => page.url() === url)).toBe(false);
            const result = await exercise({ run, script, cli, sid, owner, context, page, url, site, choose, lane: `${seed}-${id}` });
            canceled = result?.canceled === true;
            row.status = 'passed';
          } catch (error) {
            row.status = 'failed'; row.error = error.message; throw error;
          } finally {
            if (!canceled) await cli(['session', 'cancel', sid, '--json']);
            row.lastCommand = report.calls.length - 1;
          }
          expect(contexts.flatMap(context => context.pages()).filter(page => page.url().startsWith(site.origin))).toHaveLength(0);
        }).catch(error => failures.push(`${id}: ${error.message}`));
      }
      expect(failures, `seed=${seed} scenario failures`).toEqual([]);
      expect(report.scenarios.map(row => row.id).sort()).toEqual([...scenarioIds].sort());
      expect(report.scenarios.every(row => row.status === 'passed')).toBe(true);
    } finally {
      await Promise.all(browserObservers.map(observer => observer.detach().catch(() => {})));
      report.summary = { commands: report.calls.length, stdoutChars: report.calls.reduce((sum, row) => sum + row.stdoutChars, 0) };
      const path = info.outputPath('direct-drive-fuzz.json');
      await writeFile(path, JSON.stringify(report, null, 2));
      await info.attach('direct-drive-fuzz.json', { path, contentType: 'application/json' });
      await Promise.all(contexts.map(context => context.close()));
      await bridge?.close(); await pages?.close(); await site?.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (const watchNetwork of [false, true]) test(`tab navigation commits before reading (watchNetwork=${watchNetwork})`, async () => {
  test.setTimeout(60_000);
  const held = new Map(), counts = new Map();
  const server = createServer((req, res) => {
    const path = req.url;
    counts.set(path, (counts.get(path) || 0) + 1);
    if (path.startsWith('/observation')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Observation fixture</title><div style="height:900px"></div><article id="story"><h1>Read without moving</h1><p>Stable observation content.</p><input id="focused"><button id="target">Observe target</button></article><div style="height:2000px"></div>');
      return;
    }
    if (path === "/redirect") { res.writeHead(302, { Location: `http://localhost:${server.address().port}/landed` }); res.end(); return; }
    if (path === "/fail") { req.socket.destroy(); return; }
    if (path.startsWith("/busy-open-")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<title>Busy renderer</title><script>fetch('/started'+location.pathname);const until=Date.now()+8000;while(Date.now()<until){}</script>");
      return;
    }
    if (path.startsWith('/late-body-')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><head><script src="/head-block-${path.slice('/late-body-'.length)}"></script></head><body style="background:rgb(20,120,60)"><article><h1>Late complete article</h1><p>The parser reached the complete document.</p><p>${escapeHtml(path)}</p></article><button>Late action</button><img src="/late-image"></body></html>`);
      return;
    }
    const finish = () => {
      if (path.startsWith('/head-block-')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// parser released'); return; }
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(`<title>Navigation fixture</title><article>Document ${escapeHtml(path)} generation ${counts.get(path)}</article>`);
    };
    if (held.has(path)) held.get(path).push({ res, finish });
    else if (path === "/stream") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write('<!doctype html><title>Streaming</title><article>New document</article><button>Continue</button><img src="/image"><iframe src="/slow-child"></iframe>');
      res.end();
    } else finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-navigation-"));
  let browser;
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.permissions).not.toContain("webNavigation");
    // Exercise explicit reader installation before document_idle, independently of manifest injection.
    manifest.content_scripts = manifest.content_scripts.filter(entry => !entry.js?.some(path => path.endsWith('/content-script.js')));
    await writeFile(join(extension, "navigation-test-worker.js"), `import "./${manifest.background.service_worker}";
      import { createToolRuntime } from "./background/tools/runtime.js";
      import { Agent } from "./background/agent/agent.js";
      globalThis.navigationTestAgent = Agent;
      globalThis.navigationTestRuntime = createToolRuntime;`);
    manifest.background.service_worker = "navigation-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      const owned = new Set(), pending = new Map();
      globalThis.navigationWorking = null;
      globalThis.navigationExecuted = [];
      globalThis.navigationCompleted = [];
      globalThis.navigationAttachCount = 0;
      const attach = chrome.debugger.attach.bind(chrome.debugger);
      chrome.debugger.attach = (...args) => { navigationAttachCount++; return attach(...args); };
      const runtime = navigationTestRuntime({
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: {
          isRunCurrent: () => true,
          resolveTargetTab: async ({ tabId, createdTabReservation }) => owned.has(tabId) || (pending.has(tabId) && pending.get(tabId) === createdTabReservation)
            ? { ok: true, tabId, tab: await chrome.tabs.get(tabId), ownedByCurrentTask: true }
            : { ok: false, code: "SESSION_TAB_FOREIGN" },
          reserveCreatedTab: async ({ tab }) => { const reservation = {}; pending.set(tab.id, reservation); return { ok: true, reservation }; },
          commitCreatedTab: async ({ reservation }) => {
            const id = [...pending].find(([, token]) => token === reservation)?.[0];
            if (!id) return { ok: false, code: 'SESSION_TAB_UNAVAILABLE' };
            await chrome.tabs.get(id); pending.delete(id); owned.add(id); navigationWorking = id; return { ok: true };
          },
          discardCreatedTab: async reservation => {
            const id = [...pending].find(([, token]) => token === reservation)?.[0];
            if (id) { await chrome.tabs.remove(id).catch(() => {}); pending.delete(id); }
          },
          updateWorkingTab: async ({ tab }) => { owned.add(tab.id); navigationWorking = tab.id; },
        },
      });
      globalThis.navigationRuntime = runtime;
      globalThis.navigationCall = async (name, args) => {
        globalThis.navigationAbort = new AbortController();
        try { return await runtime.execute(name, args, navigationAbort.signal, { sessionId: "navigation", runId: "run" }); }
        catch (error) { return { code: error.code, error: error.message }; }
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => navigationCall(name, args), { name, args });
    const release = path => { for (const entry of held.get(path) || []) entry.finish(); held.delete(path); };
    const slow = async (name, args, path) => {
      held.set(path, []);
      let done = false;
      const pending = call(name, { ...args, watchNetwork }).then(result => { done = true; return result; });
      await expect.poll(() => held.get(path).length).toBeGreaterThan(0);
      expect(done, `${name} must wait while response headers are held: ${done ? JSON.stringify(await pending) : "pending"}`).toBe(false);
      release(path);
      const result = await pending;
      expect(result, JSON.stringify(result)).not.toHaveProperty("error");
      return result;
    };
    const opened = await slow("open_tab", { url: `${origin}/article` }, "/article");
    const tabId = opened.id;
    const article = () => call("read_article", { tabId, limit: 1200 });
    expect((await article()).text).toContain("Document /article generation 1");
    if (!watchNetwork) {
      expect(await worker.evaluate(() => navigationAttachCount), "ordinary navigation must not attach a debugger just to wait").toBe(0);
    } else expect(JSON.stringify(await call("network_recent", { tabId }))).toContain("/article");
    await slow("navigate", { tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 1");
    await slow("navigate", { tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 2");
    const redirected = await slow("navigate", { tabId, url: `${origin}/redirect` }, "/landed");
    expect(redirected._pageUrl).toBe(`http://localhost:${server.address().port}/landed`);
    expect((await article()).text).toContain("Document /landed generation 1");
    for (let i = 0; i < 2; i++) {
      const fragment = await call("navigate", { tabId, url: `${redirected._pageUrl}#section`, timeout: 2 });
      expect(fragment, `fragment attempt ${i}: ${JSON.stringify(fragment)}`).not.toHaveProperty("error");
      expect(fragment._pageUrl).toBe(`${redirected._pageUrl}#section`);
    }

    // A held image must not prevent the navigation tool from returning at commit.
    held.set("/image", []);
    held.set("/slow-child", []);
    expect(await call("navigate", { tabId, url: `${origin}/stream` })).not.toHaveProperty("error");
    expect((await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId)).status).toBe("loading");
    await expect.poll(() => held.get("/image").length).toBeGreaterThan(0);
    await expect.poll(() => held.get("/slow-child").length).toBeGreaterThan(0);
    expect((await call("read_article", { tabId, limit: 1200, timeout: 1 })).text).toContain("New document");
    const found = await call("find_elements", { tabId, pattern: "Continue", timeout: 1 });
    expect(found).not.toHaveProperty("incomplete");
    expect(JSON.stringify(found)).toContain("Continue");
    expect((await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId)).status).toBe("loading");
    release("/image");
    release("/slow-child");

    if (!watchNetwork) {
      for (const name of ['read_article', 'get_ax_tree', 'screenshot']) for (const outcome of ['ready', 'timeout']) {
        const suffix = `${name}-${outcome}`, head = `/head-block-${suffix}`;
        held.set(head, []); held.set('/late-image', []);
        const opened = await call('open_tab', { url: `${origin}/late-body-${suffix}` });
        expect(opened).not.toHaveProperty('error');
        await expect.poll(() => held.get(head).length).toBeGreaterThan(0);
        const before = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true,
          func: () => ({ body: !!document.body, state: document.readyState }) }))[0].result, opened.id);
        expect(before).toEqual({ body: false, state: 'loading' });
        let done = false;
        const pending = call(name, { tabId: opened.id, timeout: outcome === 'timeout' ? 1 : 5,
          ...(name === 'read_article' ? { limit: 3000 } : name === 'screenshot' ? { format: 'png' } : {}) }).then(result => { done = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(done, `${name} must wait for the late body`).toBe(false);
        if (outcome === 'ready') release(head);
        const result = await pending;
        if (outcome === 'timeout') {
          expect(result.incomplete?.reason).toBe('timeout');
          expect(result).not.toHaveProperty('_image'); expect(result).not.toHaveProperty('snapshot'); expect(result).not.toHaveProperty('text');
          release(head);
        } else {
          expect(result).not.toHaveProperty('error'); expect(result).not.toHaveProperty('incomplete');
          if (name === 'read_article') expect(result.text).toContain('complete document');
          if (name === 'get_ax_tree') { expect(result.snapshot).toContain('Late action'); expect(result.returnedNodeCount).toBeGreaterThan(1); }
          if (name === 'screenshot') {
            const pixel = await worker.evaluate(async image => {
              const bitmap = await createImageBitmap(await (await fetch(image)).blob());
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0); bitmap.close(); return Array.from(ctx.getImageData(5, 5, 1, 1).data);
            }, result._image);
            expect(pixel).toEqual([20, 120, 60, 255]);
          }
          expect((await worker.evaluate(id => chrome.tabs.get(id), opened.id)).status).toBe('loading');
        }
        release('/late-image'); await call('close_tab', { tabId: opened.id });
      }
      // Exercise the production Agent dependency planner against two independently blocked heads.
      held.set('/head-block-batch-a', []); held.set('/batch-open-b', []); held.set('/late-image', []);
      const batchRun = worker.evaluate(async ({ origin, watchNetwork }) => {
        const agent = new navigationTestAgent('navigation', { tools: { ...navigationRuntime,
          async execute(name, args, signal, context) {
            navigationExecuted.push(context.toolCallId);
            const result = await navigationRuntime.execute(name, args, signal, context);
            navigationCompleted.push(context.toolCallId); return result;
          },
        } });
        agent._currentRunId = 'run';
        const events = []; agent.subscribe(event => { events.push(event); });
        const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const messages = await agent._executeToolCalls([
          tc('open-a', 'open_tab', { url: `${origin}/late-body-batch-a`, tabAlias: 'a', watchNetwork }),
          tc('open-b', 'open_tab', { url: `${origin}/batch-open-b`, tabAlias: 'b', watchNetwork }),
          tc('read-a', 'read_article', { tabRef: 'a', limit: 3000 }),
          tc('read-b', 'read_article', { tabRef: 'b', limit: 3000 }),
          tc('script-ref', 'run_script', { tabRef: 'b', target: 'page', timeout: 10, code: '() => location.href' }),
        ], new AbortController().signal);
        return { ids: messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
          ends: events.filter(event => event.type === 'tool_execution_end') };
      }, { origin, watchNetwork });
      await expect.poll(() => held.get('/batch-open-b').length).toBeGreaterThan(0);
      await expect.poll(() => held.get('/head-block-batch-a').length).toBeGreaterThan(0);
      release('/head-block-batch-a');
      await expect.poll(() => worker.evaluate(() => navigationCompleted.includes('read-a'))).toBe(true);
      expect(await worker.evaluate(() => navigationCompleted.includes('open-b'))).toBe(false);
      release('/batch-open-b');
      const batchResult = await batchRun;
      expect(batchResult.ids).toEqual(['open-a', 'open-b', 'read-a', 'read-b', 'script-ref']);
      expect(batchResult.ends.every(event => !event.isError)).toBe(true);
      const left = batchResult.ends.find(event => event.toolCallId === 'read-a').result;
      const right = batchResult.ends.find(event => event.toolCallId === 'read-b').result;
      expect(left.text).toContain('/late-body-batch-a'); expect(right.text).toContain('/batch-open-b');
      expect(left._tabId).not.toBe(right._tabId);
      expect(batchResult.ends.find(event => event.toolCallId === 'script-ref').result.result).toBe(`${origin}/batch-open-b`);
      release('/late-image');

      // A tool-using script blocks later no-tools scripts and reads, including other tabs.
      const scriptRun = worker.evaluate(async ids => {
        globalThis.scriptBatchStarted = [];
        let active = 0, peak = 0;
        const agent = new navigationTestAgent('navigation', { tools: { ...navigationRuntime,
          async execute(name, args, signal, context) {
            scriptBatchStarted.push(context.toolCallId);
            if (name === 'run_script') peak = Math.max(peak, ++active);
            try { return await navigationRuntime.execute(name, args, signal, context); }
            finally { if (name === 'run_script') active--; }
          },
        } });
        agent._currentRunId = 'run';
        const ends = []; agent.subscribe(event => { if (event.type === 'tool_execution_end') ends.push(event); });
        const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const messages = await agent._executeToolCalls([
          tc('script-a', 'run_script', { target: 'page', tabId: ids[0], mutatesPage: true, timeout: 10,
            code: 'async () => { void tools.$list; globalThis.__scriptStarted = true; while (!globalThis.__scriptRelease) await new Promise(r => setTimeout(r, 20)); document.body.dataset.scriptChecked = "yes"; return "script a"; }' }),
          tc('script-b', 'run_script', { tabId: ids[1], mutatesPage: false, timeout: 10, code: '() => "script b"' }),
          tc('after-script', 'read_article', { tabId: ids[1], limit: 3000 }),
        ], new AbortController().signal);
        return { peak, ends, ids: messages.filter(m => m.role === 'tool').map(m => m.tool_call_id) };
      }, [left._tabId, right._tabId]);
      await expect.poll(() => worker.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id },
        world: 'MAIN', func: () => Boolean(globalThis.__scriptStarted) }))[0]?.result, left._tabId)).toBe(true);
      expect(await worker.evaluate(() => scriptBatchStarted)).toEqual(['script-a']);
      await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN',
        func: () => { globalThis.__scriptRelease = true; } }), left._tabId);
      const scripts = await scriptRun;
      expect(scripts.peak).toBe(1);
      expect(scripts.ids).toEqual(['script-a', 'script-b', 'after-script']);
      expect(scripts.ends.every(event => !event.isError)).toBe(true);
      expect(scripts.ends.slice(0, 2).map(event => event.result.result)).toEqual(['script a', 'script b']);
      for (const event of batchResult.ends.filter(event => event.toolName === 'open_tab')) await call('close_tab', { tabId: event.result.id });

      const observations = [];
      for (let index = 0; index < 3; index++) observations.push((await call('open_tab', { url: `${origin}/observation-${index}` })).id);
      const observed = await worker.evaluate(async tabIds => {
        const activeBefore = (await chrome.tabs.query({ active: true })).map(tab => tab.id);
        for (const tabId of tabIds) {
          await chrome.scripting.executeScript({ target: { tabId }, func: () => {
            document.querySelector('#focused').focus({ preventScroll: true });
            window.scrollTo(0, 600);
            globalThis.readSideEffects = [];
            for (const [object, name] of [[HTMLElement.prototype, 'focus'], [Element.prototype, 'scrollIntoView'],
              [window, 'scrollTo'], [window, 'scrollBy']]) {
              const original = object[name];
              object[name] = function (...args) { readSideEffects.push(name); return original.apply(this, args); };
            }
            globalThis.beforeRead = { focus: document.activeElement.id, x: scrollX, y: scrollY };
          } });
        }
        const effects = [], update = chrome.tabs.update.bind(chrome.tabs), command = chrome.debugger.sendCommand.bind(chrome.debugger);
        chrome.tabs.update = (...args) => { if (args[1]?.active) effects.push('activate'); return update(...args); };
        chrome.debugger.sendCommand = (...args) => {
          if (/^(Input\.|DOM\.(focus|scrollIntoViewIfNeeded)$|Page\.(bringToFront|reload)$)/.test(args[1])) effects.push(args[1]);
          return command(...args);
        };
        try {
          const rounds = [];
          for (const scoped of [false, true]) {
            const names = ['read_article', 'find_elements', 'get_ax_tree'];
            rounds.push(await Promise.all(names.map((name, index) => {
              const args = { tabId: tabIds[index], ...(name === 'read_article' ? { limit: 1200 } : {}),
                ...(scoped ? name === 'get_ax_tree' ? { root: 'css:#story' } : { selector: '#story', ...(name === 'read_article' ? { source: 'selector' } : {}) } : {}) };
              if (navigationRuntime.getParallelReadTab(name, args) !== args.tabId) throw new Error('fixture must exercise eligible parallel reads');
              return navigationRuntime.execute(name, args, new AbortController().signal,
                { sessionId: 'navigation', runId: 'run', toolCallId: `observe-${scoped}-${index}`, preserveWorkingTab: true });
            })));
          }
          const pages = await Promise.all(tabIds.map(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
            before: beforeRead, after: { focus: document.activeElement.id, x: scrollX, y: scrollY }, effects: readSideEffects,
          }) }))[0].result));
          return { rounds, pages, effects, activeBefore, activeAfter: (await chrome.tabs.query({ active: true })).map(tab => tab.id) };
        } finally { chrome.tabs.update = update; chrome.debugger.sendCommand = command; }
      }, observations);
      expect(observed.effects).toEqual([]);
      expect(observed.activeAfter).toEqual(observed.activeBefore);
      for (const page of observed.pages) { expect(page.after).toEqual(page.before); expect(page.effects).toEqual([]); }
      for (const [article, elements, ax] of observed.rounds) {
        for (const result of [article, elements, ax]) { expect(result).not.toHaveProperty('error'); expect(result).not.toHaveProperty('incomplete'); }
        expect(article.text).toContain('Stable observation content');
        expect(JSON.stringify(elements)).toContain('Observe target');
        expect(ax.snapshot).toContain('Observe target');
      }
      for (const tabId of observations) await call('close_tab', { tabId });
    }

    expect((await call("navigate", { tabId, url: `${origin}/fail` })).code).toBe("NAVIGATION_FAILED");
    expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: { blockedDomains: ["localhost"] } }));
    expect((await call("navigate", { tabId, url: `${origin}/redirect` })).code).toBe("SECURITY_GUARDRAIL_BLOCKED");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: {} }));
    expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    for (const outcome of ["cancel", "timeout", "close"]) {
      const path = `/${outcome}`;
      held.set(path, []);
      const pending = call("navigate", { tabId, url: `${origin}${path}`, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => held.get(path).length).toBeGreaterThan(0);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      if (outcome === "close") await worker.evaluate(tabId => chrome.tabs.remove(tabId), tabId);
      const result = await pending;
      if (outcome === "timeout") expect(result).toMatchObject({ tabId, loading: true, incomplete: { reason: "timeout" } });
      else expect(result.code).toBe({ cancel: "OPERATION_ABORTED", close: "SESSION_TAB_UNAVAILABLE" }[outcome]);
      release(path);
      if (outcome !== "close") expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    }
    const before = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    held.set("/open-timeout", []);
    const incompleteOpen = await call("open_tab", { url: `${origin}/open-timeout`, watchNetwork, timeout: 1 });
    expect(incompleteOpen).toMatchObject({ loading: true, incomplete: { reason: "timeout" } });
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(before + 1);
    release("/open-timeout");
    expect(await call("close_tab", { tabId: incompleteOpen.tabId })).not.toHaveProperty("error");

    // Busy renderers retain a timeout handle; cancellation still cleans up the created tab.
    for (const outcome of ["timeout", "cancel"]) {
      const path = `/busy-open-${outcome}`;
      const pending = call("open_tab", { url: `${origin}${path}`, watchNetwork, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => counts.get(`/started${path}`) || 0).toBe(1);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      const result = await pending;
      if (outcome === "timeout") {
        expect(result).toMatchObject({ incomplete: { reason: "timeout" } });
        expect(await call("close_tab", { tabId: result.tabId })).not.toHaveProperty("error");
      } else expect(result.code).toBe("OPERATION_ABORTED");
      await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({})).length), { timeout: 1500 }).toBe(before);
    }

    const busyTab = await call("open_tab", { url: `${origin}/old-busy`, watchNetwork });
    expect(busyTab).not.toHaveProperty("error");
    for (let generation = 1; generation <= 2; generation++) {
      await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
        setTimeout(() => { fetch("/old-busy-start"); const until = Date.now() + 4000; while (Date.now() < until) {} }, 300);
      } }), busyTab.id);
      await expect.poll(() => counts.get("/old-busy-start") || 0).toBe(generation);
      held.set("/busy-target", []);
      const pending = call("navigate", { tabId: busyTab.id, url: `${origin}/busy-target`, timeout: 10 });
      // The request must start while the old renderer is still busy, including same-URL reload.
      await expect.poll(() => held.get("/busy-target").length, { timeout: 1500 }).toBeGreaterThan(0);
      release("/busy-target");
      expect(await pending).not.toHaveProperty("error");
      expect((await call("read_article", { tabId: busyTab.id, limit: 1200 })).text).toContain(`Document /busy-target generation ${generation}`);
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

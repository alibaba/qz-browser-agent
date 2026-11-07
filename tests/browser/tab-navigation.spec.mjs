import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

function successfulScriptResult(receipt) {
  expect(Object.keys(receipt).sort()).toEqual(['ok', 'result', 'trace']);
  expect(receipt.ok).toBe(true);
  expect(Array.isArray(receipt.trace)).toBe(true);
  expect(receipt.trace.every(line => typeof line === 'string')).toBe(true);
  return receipt.result;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

for (const watchNetwork of [false, true]) test(`tab navigation commits before reading (watchNetwork=${watchNetwork})`, async () => {
  test.setTimeout(90_000);
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
    if (path === '/early-elements') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body><article>Early body</article><input id="early" class="indexed"><button id="tap" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Tap</button><script src="/head-block-tail"></script><input class="indexed" value="Parsed tail"></body>');
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
      const sample = path === "/open-timeout"
        ? '<button>Loaded action</button><img id="sample" alt="Loaded image" width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">' : '';
      res.end(`<title>Navigation fixture</title><article>Document ${escapeHtml(path)} generation ${counts.get(path)}</article>${sample}`);
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
    expect(manifest.permissions).toContain("webNavigation");
    // Exercise explicit reader installation before document_idle, independently of manifest injection.
    manifest.content_scripts = manifest.content_scripts.filter(entry => !entry.js?.some(path => path.endsWith('/content-script.js')));
    await writeFile(join(extension, "navigation-test-worker.js"), `import { createToolRuntime, getToolResultPageContext } from "./background/tools/runtime.js";
      import { Agent } from "./background/agent/agent.js";
      import { createSessionTabs } from "./background/session/tabs.js";
      import { createRunScriptBridge } from "./background/tools/run-script-bridge.js";
      globalThis.navigationTestBridge = createRunScriptBridge;
      globalThis.navigationTestAgent = Agent;
      globalThis.navigationTestSessionTabs = createSessionTabs;
      globalThis.navigationTestRuntime = createToolRuntime;
      globalThis.navigationTestResultContext = getToolResultPageContext;`);
    manifest.background.service_worker = "navigation-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      const state = { sessionId: 'navigation', ownedTabIds: [], workingTabId: null };
      globalThis.navigationState = state;
      globalThis.navigationExecuted = [];
      globalThis.navigationCompleted = [];
      globalThis.navigationAttachCount = 0;
      const attach = chrome.debugger.attach.bind(chrome.debugger);
      chrome.debugger.attach = (...args) => { navigationAttachCount++; return attach(...args); };
      const isRunCurrent = (sessionId, runId) => sessionId === 'navigation' && runId === 'run';
      const setRuntime = (_id, patch) => Object.assign(state, patch);
      const runController = new AbortController();
      const supervisor = { getRuntime: id => id === 'navigation' ? state : null,
        runtimeEntries: () => [['navigation', state]], setRuntime, isRunCurrent,
        hasAgent: () => true, getAbortSignal: () => runController.signal };
      const sessions = navigationTestSessionTabs({ supervisor,
        tabsApi: chrome.tabs, storage: chrome.storage.local, setRuntime, persistRuntime: async () => {},
      });
      chrome.tabs.onRemoved.addListener(tabId => { void sessions.handleTabRemoved(tabId); });
      let bridge;
      const runtime = navigationTestRuntime({
        invokeNestedTool: (parent, name, args, signal) => bridge.invokeTool(parent, name, args, signal),
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: { ...sessions, isRunCurrent },
      });
      bridge = navigationTestBridge({ supervisor, getRuntime: () => state, canManageSessions: async () => true,
        buildRunProfile: async () => ({}), getRunToolContext: async () => ({ toolRegistrySnapshot: runtime.snapshot('en'), language: 'en' }),
        toolRuntime: runtime, collectArtifacts: () => [],
        applyNestedToolResult: async ({ toolName, result, isError }) => globalThis.navigationActiveAgent?._applyToolResultEffects(toolName, result, isError) });
      chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (runtime.handleRunScriptInnerRuntimeMessage(message)) return false;
        if (message.type !== 'run_script_tool_call') return false;
        bridge.handleToolCall(message, sender).then(respond, () => respond({ ok: false, code: 'FIXTURE_BRIDGE_ERROR' }));
        return true;
      });
      globalThis.navigationRuntime = runtime;
      globalThis.navigationCall = async (name, args) => {
        globalThis.navigationAbort = new AbortController();
        try {
          const result = await runtime.execute(name, args, navigationAbort.signal, { sessionId: "navigation", runId: "run" });
          globalThis.navigationPresentation = navigationTestResultContext(result);
          return result;
        }
        catch (error) { return { code: error.code, error: error.message, details: error.details }; }
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => navigationCall(name, args), { name, args });
    // A fresh Session must authorize CDP setup before its first tab is committed.
    const first = await worker.evaluate(async ({ origin, watchNetwork }) => {
      const before = structuredClone(navigationState);
      const agent = new navigationTestAgent('navigation', { tools: navigationRuntime });
      agent._currentRunId = 'run'; globalThis.navigationActiveAgent = agent;
      const events = []; agent.subscribe(event => events.push(event));
      const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
      const messages = await agent._executeToolCalls([
        tc('first-open', 'open_tab', { url: `${origin}/first-open`, tabAlias: 'first', watchNetwork }),
        tc('first-read', 'read_article', { tabRef: 'first', limit: 1200 }),
      ], new AbortController().signal);
      return { before, state: navigationState, ends: events.filter(event => event.type === 'tool_execution_end'),
        ids: messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
        outputs: messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)) };
    }, { origin, watchNetwork });
    expect(first.before.ownedTabIds).toEqual([]);
    expect(first.before.workingTabId).toBeNull();
    expect(first.ends.map(event => event.result), 'first open and alias read must succeed').toEqual([
      expect.objectContaining({ tabRef: 'first' }), expect.objectContaining({ text: expect.stringContaining('Document /first-open generation 1') }),
    ]);
    expect(first.ends.every(event => !event.isError)).toBe(true);
    expect(first.ids).toEqual(['first-open', 'first-read']);
    expect(Object.keys(first.outputs[0]).sort()).toEqual(['active', 'tabRef', 'title', 'url']);
    const firstTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, `${origin}/first-open`);
    expect(firstTabId).toEqual(expect.any(Number));
    expect(first.state.ownedTabIds).toEqual([firstTabId]);
    expect(first.state.workingTabId).toBe(firstTabId);
    if (watchNetwork) {
      const watched = await call('network_recent', { tabRef: 'first' });
      expect(watched.results.some(record => record.url.endsWith('/first-open')), 'the initial request proves monitoring started before navigation').toBe(true);
    }
    expect(first.state.tabAliases).toEqual({ first: firstTabId });
    expect((await call('read_article', { tabRef: 'first', limit: 1200 })).text).toContain('Document /first-open');
    expect((await call('read_article', { tabRef: String(firstTabId), limit: 1200 })).text).toContain('Document /first-open');
    const countBeforeDuplicate = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    expect(await call('open_tab', { url: `${origin}/duplicate`, tabAlias: 'first' })).toHaveProperty('code', 'BATCH_TAB_REFERENCE_ERROR');
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(countBeforeDuplicate);
    expect(counts.has('/duplicate')).toBe(false);
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
    const tabId = opened.tabRef;
    const article = () => call("read_article", { tabRef: tabId, limit: 1200 });
    expect((await article()).text).toContain("Document /article generation 1");
    if (!watchNetwork) {
      expect(await worker.evaluate(() => navigationAttachCount), "ordinary navigation must not attach a debugger just to wait").toBe(0);
    } else expect(JSON.stringify(await call("network_recent", { tabRef: tabId }))).toContain("/article");
    await slow("navigate", { tabRef: tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 1");
    await slow("navigate", { tabRef: tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 2");
    const redirected = await slow("navigate", { tabRef: tabId, url: `${origin}/redirect` }, "/landed");
    expect(redirected).not.toHaveProperty('_pageUrl');
    const redirectedUrl = await worker.evaluate(() => navigationPresentation._pageUrl);
    expect(redirectedUrl).toBe(`http://localhost:${server.address().port}/landed`);
    expect((await article()).text).toContain("Document /landed generation 1");
    for (let i = 0; i < 2; i++) {
      const fragment = await call("navigate", { tabRef: tabId, url: `${redirectedUrl}#section`, timeout: 2 });
      expect(fragment, `fragment attempt ${i}: ${JSON.stringify(fragment)}`).not.toHaveProperty("error");
      expect(fragment).not.toHaveProperty('_pageUrl');
      expect(await worker.evaluate(() => navigationPresentation._pageUrl)).toBe(`${redirectedUrl}#section`);
    }

    // A held image must not prevent the navigation tool from returning at commit.
    held.set("/image", []);
    held.set("/slow-child", []);
    expect(await call("navigate", { tabRef: tabId, url: `${origin}/stream` })).not.toHaveProperty("error");
    expect((await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId)).status).toBe("loading");
    await expect.poll(() => held.get("/image").length).toBeGreaterThan(0);
    await expect.poll(() => held.get("/slow-child").length).toBeGreaterThan(0);
    expect((await call("read_article", { tabRef: tabId, limit: 1200, timeout: 1 })).text).toContain("New document");
    const found = await call("find_elements", { tabRef: tabId, pattern: "Continue", timeout: 1 });
    expect(found).not.toHaveProperty("incomplete");
    expect(JSON.stringify(found)).toContain("Continue");
    expect((await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId)).status).toBe("loading");
    release("/image");
    release("/slow-child");

    if (!watchNetwork) {
      held.set('/head-block-evaluate', []);
      const early = await call('open_tab', { url: `${origin}/late-body-evaluate` });
      const earlyArgs = { tabRef: early.tabRef, code: '() => ({body:!!document.body, text:document.body?.innerText})' };
      expect(await call('evaluate', { ...earlyArgs, waitUntil: 'commit' })).toMatchObject({ body: false });
      const notStarted = await call('evaluate', { ...earlyArgs, timeout: 0.2, code: '() => {globalThis.__lateExecution = true;}' });
      expect(notStarted.details, JSON.stringify(notStarted)).toMatchObject({ executed: false, mayHaveTakenEffect: false });
      let evaluated = false;
      const prepared = call('evaluate', earlyArgs).then(value => { evaluated = true; return value; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(evaluated).toBe(false);
      release('/head-block-evaluate');
      expect(await prepared).toMatchObject({ body: true, text: expect.stringContaining('Late complete article') });
      expect(await call('evaluate', { tabRef: early.tabRef, code: '() => globalThis.__lateExecution === true' })).toBe(false);

      held.set('/head-block-tail', []);
      const partial = await call('open_tab', { url: `${origin}/early-elements` });
      for (const state of ['attached', 'visible']) {
        const found = await call('wait_for_element', { tabRef: partial.tabRef, target: 'css:#early', state, timeout: 1 });
        expect(found, JSON.stringify(found)).toMatchObject({ found: true });
        expect(await call('inspect_element', { tabRef: partial.tabRef, target: found.target })).toMatchObject({ tag: 'input' });
        expect(await call('act_on_element', { tabRef: partial.tabRef, target: found.target, action: 'fill', value: state })).toEqual({});
      }
      expect(await call('wait_for_function', { tabRef: partial.tabRef, code: '() => !!document.querySelector("#early")', timeout: 1 })).toBe(true);
      expect(await call('act_on_element', { tabRef: partial.tabRef, target: 'css:#tap', action: 'click' })).toEqual({});
      expect(await call('evaluate', { tabRef: partial.tabRef, waitUntil: 'commit', code: '() => ({clicks:document.querySelector("#tap").dataset.clicks,state:document.readyState})' })).toEqual({ clicks: '1', state: 'loading' });
      const probes = await worker.evaluate(tabId => Promise.all([0, 1].map(index => chrome.tabs.sendMessage(tabId,
        { action: 'elementPresence', selector: '.indexed', index, queryOnly: true }, { frameId: 0 }))), partial.tabRef);
      expect(probes).toEqual([{ found: true }, { found: false }]);
      let indexedSettled = false;
      const indexed = call('inspect_element', { tabRef: partial.tabRef, target: 'css:.indexed', index: 1, timeout: 5 })
        .then(result => { indexedSettled = true; return result; });
      void indexed.catch(() => {});
      const invalid = await call('inspect_element', { tabRef: partial.tabRef, target: 'css:[', timeout: 1 });
      expect(invalid, JSON.stringify(invalid)).toMatchObject({ code: 'INVALID_SELECTOR' });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(indexedSettled, 'the first match must not satisfy a later index before the parser reaches it').toBe(false);
      release('/head-block-tail');
      expect(await indexed).toMatchObject({ tag: 'input', value: 'Parsed tail' });
      for (const name of ['read_article', 'get_ax_tree', 'screenshot']) for (const outcome of ['ready', 'timeout']) {
        const suffix = `${name}-${outcome}`, head = `/head-block-${suffix}`;
        held.set(head, []); held.set('/late-image', []);
        const opened = await call('open_tab', { url: `${origin}/late-body-${suffix}` });
        expect(opened).not.toHaveProperty('error');
        await expect.poll(() => held.get(head).length).toBeGreaterThan(0);
        const before = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true,
          func: () => ({ body: !!document.body, state: document.readyState }) }))[0].result, opened.tabRef);
        expect(before).toEqual({ body: false, state: 'loading' });
        let done = false;
        const pending = call(name, { tabRef: opened.tabRef, timeout: outcome === 'timeout' ? 1 : 5,
          ...(name === 'read_article' ? { limit: 3000 } : name === 'screenshot' ? { format: 'png' } : {}) }).then(result => { done = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(done, `${name} must wait for the late body`).toBe(false);
        if (outcome === 'ready') release(head);
        const result = await pending;
        if (outcome === 'timeout') {
          expect(result, JSON.stringify(result)).toMatchObject({ code: 'TOOL_TIMEOUT', details: {
            pageState: { url: `${origin}/late-body-${suffix}`, status: 'loading', loading: true },
          } });
          expect(result).not.toHaveProperty('incomplete');
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
          expect((await worker.evaluate(id => chrome.tabs.get(id), opened.tabRef)).status).toBe('loading');
        }
        release('/late-image'); await call('close_tab', { tabRef: opened.tabRef });
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
        agent._currentRunId = 'run'; globalThis.navigationActiveAgent = agent;
        const events = []; agent.subscribe(event => { events.push(event); });
        const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const messages = await agent._executeToolCalls([
          tc('open-a', 'open_tab', { url: `${origin}/late-body-batch-a`, tabAlias: 'a', watchNetwork }),
          tc('open-b', 'open_tab', { url: `${origin}/batch-open-b`, tabAlias: 'b', watchNetwork }),
          tc('read-a', 'read_article', { tabRef: 'a', limit: 3000 }),
          tc('read-b', 'read_article', { tabRef: 'b', limit: 3000 }),
          tc('script-ref', 'evaluate', { tabRef: 'b', timeout: 10, code: '() => location.href' }),
        ], new AbortController().signal);
        return { ids: messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
          ends: events.filter(event => event.type === 'tool_execution_end'),
          outputs: messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, content: message.content })) };
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
      expect(left.url).not.toBe(right.url);
      const batchTabIds = await worker.evaluate(async urls => {
        const tabs = await chrome.tabs.query({}); return urls.map(url => tabs.find(tab => tab.url === url)?.id);
      }, [left.url, right.url]);
      expect(batchTabIds.every(id => Number.isInteger(id))).toBe(true);
      expect(successfulScriptResult(JSON.parse(batchResult.outputs.find(message => message.id === 'script-ref').content)))
        .toBe(`${origin}/batch-open-b`);
      release('/late-image');

      // A waiting page function leaves other tabs available; each page still runs its tools in order.
      const scriptRun = worker.evaluate(async ids => {
        globalThis.scriptBatchEvents = [];
        let active = 0, peak = 0;
        const agent = new navigationTestAgent('navigation', { tools: { ...navigationRuntime,
          async execute(name, args, signal, context) {
            scriptBatchEvents.push(`start:${context.toolCallId}`);
            if (name === 'run_script') peak = Math.max(peak, ++active);
            try { return await navigationRuntime.execute(name, args, signal, context); }
            finally {
              scriptBatchEvents.push(`end:${context.toolCallId}`);
              if (name === 'run_script') active--;
            }
          },
        } });
        agent._currentRunId = 'run'; globalThis.navigationActiveAgent = agent;
        const ends = []; agent.subscribe(event => { if (event.type === 'tool_execution_end') ends.push(event); });
        const tc = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
        const messages = await agent._executeToolCalls([
          tc('script-a', 'run_script', { args: { tabRef: ids[0] }, timeout: 10,
            code: 'return await tools.evaluate({tabRef:input.tabRef,code:async () => { globalThis.__scriptStarted = true; while (!globalThis.__scriptRelease) await new Promise(r => setTimeout(r, 20)); document.body.dataset.scriptChecked = "yes"; return "script a"; }});' }),
          tc('script-b', 'evaluate', { tabRef: ids[1], timeout: 10, code: '() => "script b"' }),
          tc('after-script', 'read_article', { tabRef: ids[1], limit: 3000 }),
        ], new AbortController().signal);
        return { peak, ends, ids: messages.filter(m => m.role === 'tool').map(m => m.tool_call_id),
          outputs: messages.filter(m => m.role === 'tool').map(m => m.content) };
      }, batchTabIds);
      await expect.poll(() => worker.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id },
        world: 'MAIN', func: () => Boolean(globalThis.__scriptStarted) }))[0]?.result, batchTabIds[0])).toBe(true);
      await expect.poll(() => worker.evaluate(() => scriptBatchEvents.filter(event => !event.endsWith(':script-a'))))
        .toEqual(['start:script-b', 'end:script-b', 'start:after-script', 'end:after-script']);
      expect(await worker.evaluate(() => scriptBatchEvents.filter(event => event.endsWith(':script-a'))))
        .toEqual(['start:script-a']);
      await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN',
        func: () => { globalThis.__scriptRelease = true; } }), batchTabIds[0]);
      const scripts = await scriptRun;
      expect(scripts.peak).toBe(1);
      expect(scripts.ids).toEqual(['script-a', 'script-b', 'after-script']);
      expect(scripts.ends.every(event => !event.isError)).toBe(true);
      expect(scripts.outputs.slice(0, 2).map(content => successfulScriptResult(JSON.parse(content))))
        .toEqual(['script a', 'script b']);
      for (const event of batchResult.ends.filter(event => event.toolName === 'open_tab')) await call('close_tab', { tabRef: event.result.tabRef });

      const observations = [];
      for (let index = 0; index < 3; index++) observations.push((await call('open_tab', { url: `${origin}/observation-${index}` })).tabRef);
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
                ...(scoped ? name === 'get_ax_tree' ? { target: 'css:#story' } : { target: '#story', ...(name === 'read_article' ? { source: 'target' } : {}) } : {}) };
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
      for (const tabId of observations) await call('close_tab', { tabRef: tabId });
    }

    expect((await call("navigate", { tabRef: tabId, url: `${origin}/fail` })).code).toBe("NAVIGATION_FAILED");
    expect(await call("navigate", { tabRef: tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: { blockedDomains: ["localhost"] } }));
    expect((await call("navigate", { tabRef: tabId, url: `${origin}/redirect` })).code).toBe("SECURITY_GUARDRAIL_BLOCKED");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: {} }));
    expect(await call("navigate", { tabRef: tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    for (const outcome of ["cancel", "timeout", "close"]) {
      const path = `/${outcome}`;
      held.set(path, []);
      const pending = call("navigate", { tabRef: tabId, url: `${origin}${path}`, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => held.get(path).length).toBeGreaterThan(0);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      if (outcome === "close") await worker.evaluate(tabId => chrome.tabs.remove(tabId), tabId);
      const result = await pending;
      if (outcome === "timeout") expect(result).toMatchObject({ loading: true, incomplete: { reason: "timeout" } });
      else expect(result.code).toBe({ cancel: "OPERATION_ABORTED", close: "SESSION_TAB_UNAVAILABLE" }[outcome]);
      release(path);
      if (outcome !== "close") expect(await call("navigate", { tabRef: tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    }
    const before = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    held.set("/open-timeout", []);
    const incompleteOpen = await call("open_tab", { url: `${origin}/open-timeout`, tabAlias: "loading", watchNetwork, timeout: 1 });
    expect(incompleteOpen).toMatchObject({ loading: true, incomplete: { reason: "timeout" } });
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(before + 1);
    expect(incompleteOpen.tabRef).toBe('loading');
    const loadingTabId = await worker.evaluate(() => navigationRuntime.getTabAliases('navigation').loading);
    expect(loadingTabId).toEqual(expect.any(Number));
    const readers = [
      ['read_article', { limit: 1200 }], ['read_dom', {}], ['find_elements', { target: 'button' }],
      ['inspect_element', { target: 'css:article' }], ['list_images', {}],
      ['read_image', { target: 'css:#sample' }], ['get_ax_tree', {}], ['screenshot', {}],
    ];
    // Keep the real response withheld: every reader must spend its own deadline
    // waiting, and neither the open timeout nor a read timeout may close the tab.
    for (const [name, args] of readers) {
      const result = await call(name, { ...args, tabRef: 'loading', timeout: 0.1 });
      expect(result.code, `${name}: ${JSON.stringify(result)}`).toBe('TOOL_TIMEOUT');
      expect(result).not.toHaveProperty('incomplete');
      if (!['list_images', 'read_image'].includes(name)) {
        expect(result.details?.pageState, JSON.stringify(result)).toMatchObject({ status: 'loading', loading: true });
      }
      expect(await worker.evaluate(tabId => chrome.tabs.get(tabId).then(tab => tab.status), loadingTabId)).toBe('loading');
    }
    release("/open-timeout");
    const loadingRead = await call('read_article', { tabRef: 'loading', limit: 1200 });
    expect(loadingRead, JSON.stringify(loadingRead)).not.toHaveProperty('error');
    expect(loadingRead.text, JSON.stringify(loadingRead)).toContain('Document /open-timeout');
    for (const [name, args] of readers.slice(1)) {
      const result = await call(name, { ...args, tabRef: 'loading' });
      expect(result, `${name}: ${JSON.stringify(result)}`).not.toHaveProperty('error');
      expect(result, `${name}: ${JSON.stringify(result)}`).not.toHaveProperty('incomplete');
      if (name === 'read_dom' || name === 'inspect_element') expect(JSON.stringify(result)).toContain('Document /open-timeout');
      if (name === 'find_elements' || name === 'get_ax_tree') expect(JSON.stringify(result)).toContain('Loaded action');
      if (name === 'list_images') expect(result.images).toHaveLength(1);
      if (name === 'read_image' || name === 'screenshot') expect(result._image).toBeTruthy();
    }
    expect(await call('close_tab', { tabRef: 'loading' })).not.toHaveProperty('error');
    expect(await call('read_article', { tabRef: 'loading', limit: 1200 })).toHaveProperty('code', 'BATCH_TAB_REFERENCE_ERROR');
    const reopened = await call('open_tab', { url: `${origin}/alias-reused`, tabAlias: 'loading' });
    expect(reopened).not.toHaveProperty('error'); expect(reopened.tabRef).toBe('loading');
    const reopenedId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, `${origin}/alias-reused`);
    expect(reopenedId).toEqual(expect.any(Number));
    expect(reopenedId).not.toBe(loadingTabId);
    expect((await call('read_article', { tabRef: 'loading', limit: 1200 })).text).toContain('Document /alias-reused');
    expect(await call('close_tab', { tabRef: 'loading' })).not.toHaveProperty('error');

    // Busy renderers retain a timeout handle; cancellation still cleans up the created tab.
    for (const outcome of ["timeout", "cancel"]) {
      const path = `/busy-open-${outcome}`;
      const pending = call("open_tab", { url: `${origin}${path}`, watchNetwork, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => counts.get(`/started${path}`) || 0).toBe(1);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      const result = await pending;
      if (outcome === "timeout") {
        expect(result).toMatchObject({ incomplete: { reason: "timeout" } });
        expect(await call("close_tab", { tabRef: result.tabRef })).not.toHaveProperty("error");
      } else expect(result.code).toBe("OPERATION_ABORTED");
      await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({})).length), { timeout: 1500 }).toBe(before);
    }

    const busyTab = await call("open_tab", { url: `${origin}/old-busy`, watchNetwork });
    expect(busyTab).not.toHaveProperty("error");
    for (let generation = 1; generation <= 2; generation++) {
      await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
        setTimeout(() => { fetch("/old-busy-start"); const until = Date.now() + 4000; while (Date.now() < until) {} }, 300);
      } }), busyTab.tabRef);
      await expect.poll(() => counts.get("/old-busy-start") || 0).toBe(generation);
      held.set("/busy-target", []);
      const pending = call("navigate", { tabRef: busyTab.tabRef, url: `${origin}/busy-target`, timeout: 10 });
      // The request must start while the old renderer is still busy, including same-URL reload.
      await expect.poll(() => held.get("/busy-target").length, { timeout: 1500 }).toBeGreaterThan(0);
      release("/busy-target");
      expect(await pending).not.toHaveProperty("error");
      expect((await call("read_article", { tabRef: busyTab.tabRef, limit: 1200 })).text).toContain(`Document /busy-target generation ${generation}`);
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

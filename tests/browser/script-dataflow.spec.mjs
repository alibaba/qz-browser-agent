import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './fixtures.mjs';
import { ensureTestExtension } from '../support/extension-build.mjs';

test('local page scripts overlap without a bridge; tool scripts remain barriers and errors never replay', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const server = createServer((req, res) => {
    const index = /^\/page-(\d+)$/.exec(req.url || '')?.[1];
    if (index == null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Local page ${index}</title><article><h1>Local page ${index}</h1><p>${'Deterministic local article content. '.repeat(50)}</p></article>
      <script>globalThis.missingTools = () => tools.$list();</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), 'qz-script-dataflow-'));
  let browser;
  try {
    const extension = join(directory, 'extension');
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    // Isolated host with production modules: no real user Session or provider is involved.
    await writeFile(join(extension, 'script-test-worker.js'), `
      import { Agent } from './background/agent/agent.js';
      import { createToolRuntime } from './background/tools/runtime.js';
      import { createSessionTabs } from './background/session/tabs.js';
      import { createRunScriptBridge } from './background/tools/run-script-bridge.js';
      const state = { sessionId: 'script-test', ownedTabIds: [], workingTabId: null };
      const controller = new AbortController();
      const setRuntime = (_id, patch) => Object.assign(state, patch);
      const supervisor = { getRuntime: () => state, runtimeEntries: () => [['script-test', state]], setRuntime,
        isRunCurrent: (id, run) => id === 'script-test' && run === 'run' && !controller.signal.aborted,
        hasAgent: () => true, getAbortSignal: () => controller.signal };
      const sessions = createSessionTabs({ supervisor, tabsApi: chrome.tabs, storage: chrome.storage.local,
        setRuntime, persistRuntime: async () => {}, ready: async () => {}, normalizeSessionId: String,
        now: () => new Date().toISOString(), broadcast() {}, loadSecurityGuardrails: async () => ({}) });
      chrome.tabs.onRemoved.addListener(id => { void sessions.handleTabRemoved(id); });
      const runtime = createToolRuntime({ sessions: { ...sessions, isRunCurrent: supervisor.isRunCurrent },
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id } });
      let agent;
      globalThis.bridgeInstalls = 0; globalThis.bridgeCalls = 0;
      const inject = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = options => {
        if (options.files?.includes('content/run-script-tool-bridge.js')) bridgeInstalls++;
        return inject(options);
      };
      const bridge = createRunScriptBridge({ supervisor, getRuntime: () => state, canManageSessions: async () => true,
        buildRunProfile: async () => ({}), getRunToolContext: async () => ({ toolRegistrySnapshot: runtime.snapshot(), language: 'en' }),
        toolRuntime: runtime, collectArtifacts: () => [],
        applyNestedToolResult: async ({ toolName, result, isError }) => agent._applyToolResultEffects(toolName, result, isError) });
      chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message.type !== 'run_script_tool_call') return false;
        bridgeCalls++; bridge.handleToolCall(message, sender).then(respond, () => respond({ ok: false, code: 'FIXTURE_BRIDGE_ERROR' }));
        return true;
      });
      globalThis.scriptTest = { state,
        open: url => runtime.execute('open_tab', { url }, controller.signal, { sessionId: 'script-test', runId: 'run' }),
        async run(calls, budget) {
          let active = 0, peak = 0; const intervals = [], ends = [], starts = [];
          const beforeBridge = bridgeInstalls, beforeCalls = bridgeCalls, start = performance.now();
          agent = new Agent('script-test', { tools: { ...runtime, maxInFlight: budget,
            async execute(name, args, signal, context) {
              const begin = performance.now() - start; peak = Math.max(peak, ++active); starts.push(context.toolCallId);
              try { return await runtime.execute(name, args, signal, context); }
              finally { active--; intervals.push({ id: context.toolCallId, start: begin, end: performance.now() - start }); }
            },
          } });
          agent._currentRunId = 'run'; agent._maybeRefreshDynamicContextForSiteSkills = async () => null;
          agent.subscribe(event => { if (event.type === 'tool_execution_end') ends.push(event); });
          const messages = await agent._executeToolCalls(calls, controller.signal);
          return { ms: performance.now() - start, peak, intervals, starts, ends,
            bridgeInstalls: bridgeInstalls - beforeBridge, bridgeCalls: bridgeCalls - beforeCalls,
            owned: [...state.ownedTabIds], working: state.workingTabId,
            ids: messages.filter(m => m.role === 'tool').map(m => m.tool_call_id) };
        },
      };`);
    manifest.background.service_worker = 'script-test-worker.js';
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, 'profile'), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server',
        '--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    await expect.poll(() => worker.evaluate(() => Boolean(globalThis.scriptTest))).toBe(true);
    const tabs = [];
    for (let i = 0; i < 6; i++) tabs.push((await worker.evaluate(url => scriptTest.open(url), `${origin}/page-${i}`)).id);
    const tc = (id, args) => ({ id, function: { name: 'run_script', arguments: JSON.stringify({ timeout: 10, ...args }) } });
    const code = `async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      document.body.dataset.runs = String(Number(document.body.dataset.runs || 0) + 1);
      return { title: document.title, text: document.querySelector('article').textContent.slice(0, 200), value: input.value + args.bump };
    }`;
    const calls = tabs.map((tabId, i) => tc(`plain-${i}`, { tabId, code, args: { value: i, bump: 10 }, mutatesPage: true }));
    const run = (calls, budget = 10) => worker.evaluate(({ calls, budget }) => scriptTest.run(calls, budget), { calls, budget });
    const trials = [];
    for (let trial = 1; trial <= 3; trial++) for (const budget of trial % 2 ? [1, 10] : [10, 1]) {
      const result = await run(calls, budget);
      expect(result.ends.every(e => !e.isError && !e.result.incomplete)).toBe(true);
      expect(result.ends.map(e => e.result.result.title)).toEqual(tabs.map((_, i) => `Local page ${i}`));
      expect(result.ends.map(e => e.result.result.value)).toEqual(tabs.map((_, i) => i + 10));
      expect(result.ends.every(e => e.result.result.text.length === 200)).toBe(true);
      expect(result.owned).toEqual(tabs); expect(result.working).toBe(tabs.at(-1));
      expect(result.ids).toEqual(calls.map(c => c.id));
      expect(result.bridgeInstalls).toBe(0); expect(result.bridgeCalls).toBe(0);
      expect(result.peak).toBe(budget === 1 ? 1 : 6);
      trials.push({ trial, budget, ms: result.ms, peak: result.peak, bridgeInstalls: result.bridgeInstalls, intervals: result.intervals });
    }
    const median = values => [...values].sort((a, b) => a - b)[1];
    const serialMedian = median(trials.filter(r => r.budget === 1).map(r => r.ms));
    const parallelMedian = median(trials.filter(r => r.budget === 10).map(r => r.ms));
    expect(parallelMedian).toBeLessThan(serialMedian * 0.8);

    const sameTab = await run([tc('same-1', { tabId: tabs[0], code, args: { value: 1, bump: 1 } }),
      tc('same-2', { tabId: tabs[0], code, args: { value: 2, bump: 1 } })]);
    expect(sameTab.peak).toBe(1); expect(sameTab.ends.every(e => !e.isError)).toBe(true);
    const withTools = await run(tabs.slice(0, 3).map((tabId, i) => tc(`tools-${i}`, { tabId,
      code: 'async () => { await new Promise(r => setTimeout(r, 400)); const article = await tools.read_article({limit:1200}); return {title:document.title,chars:article.text.length}; }' })));
    expect(withTools.peak).toBe(1); expect(withTools.ends.every(e => !e.isError)).toBe(true);
    expect(withTools.bridgeInstalls).toBe(3); expect(withTools.bridgeCalls).toBe(3);
    expect(withTools.ends.every(e => e.result.result.chars > 200)).toBe(true);

    const failed = await run([tc('no-replay', { tabId: tabs[0], mutatesPage: true,
      code: 'async () => { document.body.dataset.attempts = String(Number(document.body.dataset.attempts || 0) + 1); return globalThis.missingTools(); }' })]);
    expect(failed.ends[0].result.code).toBe('RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE');
    expect(failed.ends[0].result.details.automaticReplay).toBe(false);
    expect(failed.ends[0].result.diagnostic.suggestedNextStep).toContain('tools.name');
    expect(failed.bridgeInstalls).toBe(0); expect(failed.bridgeCalls).toBe(0);
    expect(await worker.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id },
      func: () => document.body.dataset.attempts }))[0].result, tabs[0])).toBe('1');
    const evidence = { trials, serialMedian, parallelMedian, sameTab: { ms: sameTab.ms, peak: sameTab.peak },
      withTools: { ms: withTools.ms, peak: withTools.peak, bridgeCalls: withTools.bridgeCalls }, noReplay: true };
    await testInfo.attach('script-dataflow-timings', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log('SCRIPT_DATAFLOW_RESULT', JSON.stringify(evidence));
    await worker.evaluate(ids => chrome.tabs.remove(ids), tabs);
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

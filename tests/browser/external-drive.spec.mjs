import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { textPdf } from "../support/text-pdf.mjs";
import { expect, test } from "./fixtures.mjs";
import { main } from "../../services/mcp-bridge/src/cli.mjs";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";

test("external drive runs page tools, preserves user tabs, and refuses occupied sessions", async () => {
  test.setTimeout(360_000);
  const { launchIsolatedExtensionMcp } = await import("../support/isolated-extension-mcp.mjs");
  const fixture = await startPage();
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-external-drive-", requestTimeoutSeconds: 90 });
  const stdout = { isTTY: true, text: "", write(value) { this.text += value; } };
  const stderr = { isTTY: true, text: "", write(value) { this.text += value; } };
  const dependencies = {
    stdout,
    stderr,
    findDaemon: async () => ({
      endpoint: environment.bridge.endpoint,
      health: await readHealth(environment.bridge.endpoint),
    }),
  };
  const openedTabs = [];
  const createdIds = new Set();
  const createDrive = async () => {
    stdout.text = "";
    stderr.text = "";
    expect(await main(["session", "create", "--title", "Drive browser regression", "--json"], dependencies), stderr.text).toBe(0);
    const id = JSON.parse(stdout.text).result.sessionId;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(createdIds.has(id)).toBe(false);
    createdIds.add(id);
    return id;
  };
  try {
    const created = await callTool(environment.bridge.endpoint, "qingzhou_create_session", {
      title: "Built-in task", firstMessage: "", timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    const builtinId = created.session?.sessionId || created.sessionId;
    expect(builtinId).toBeTruthy();
    const before = await callTool(environment.bridge.endpoint, "qingzhou_get_session_state", {
      sessionId: builtinId, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    const occupied = await scriptTool(dependencies, stdout, stderr, {
      sessionId: builtinId,
      name: "open_tab",
      args: { url: `${fixture}/occupied` },
    });
    expect(occupied.code, occupied.text || stderr.text).toBe(1);
    expect(occupied.body.code).toBe("DRIVE_SESSION_OCCUPIED");
    expect(occupied.text).toMatch(/这个会话已有任务在用|already has a task/);
    expect(await tabIdForUrl(environment.page, `${fixture}/occupied`)).toBeUndefined();
    const after = await callTool(environment.bridge.endpoint, "qingzhou_get_session_state", {
      sessionId: builtinId, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    expect(after.runId ?? null).toBe(before.runId ?? null);
    expect(after.status ?? "").toBe(before.status ?? "");
    const source = await environment.page.evaluate(async (id) => {
      const stored = await chrome.storage.local.get("_sessions");
      return stored._sessions?.[id]?.source || "";
    }, builtinId);
    expect(source).not.toBe("external-drive");

    const baseCatalog = await callTool(environment.bridge.endpoint, "qingzhou_list_tools", {});
    expect(baseCatalog.tools.map(tool => tool.name)).toContain("list_skills");
    const sessionId = await createDrive();
    const opened = await scriptTool(dependencies, stdout, stderr, {
      sessionId,
      name: "open_tab",
      args: { url: `${fixture}/drive`, tabAlias: "page" },
    }, "90");
    expect(opened.code, opened.text || stderr.text).toBe(0);
    expect(Object.keys(opened.body).sort()).toEqual(["active", "tabRef", "title", "url"]);
    expect(opened.body.tabRef).toBe("page");
    const tabId = await tabIdForUrl(environment.page, `${fixture}/drive`);
    openedTabs.push(tabId);
    expect(await environment.page.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId)).toBe(false);
    await expect.poll(async () => environment.page.evaluate(async () => (await chrome.tabGroups.query({})).map((group) => group.title)), {
      timeout: 15_000,
    }).toContain("轻舟 · CLI");

    const ax = await scriptTool(dependencies, stdout, stderr, {
      sessionId,
      name: "get_ax_tree",
      args: { tabRef: tabId },
    }, "90");
    expect(ax.code, ax.text || stderr.text).toBe(0);
    expect(ax.text).not.toMatch(/CDP_RUN_CONTEXT_REQUIRED/);
    expect(String(ax.body?.snapshot || "")).not.toBe("");

    const act = await scriptTool(dependencies, stdout, stderr, {
      sessionId,
      name: "act_on_element",
      args: { tabRef: tabId, target: "css:#go", action: "click" },
    }, "90");
    expect(act.code, act.text || stderr.text).toBe(0);
    expect(act.text).not.toMatch(/CDP_RUN_CONTEXT_REQUIRED/);
    await expect.poll(async () => environment.page.evaluate(async (id) => {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.title });
      return injected.result;
    }, tabId), { timeout: 15_000 }).toBe("clicked");

    const polish = await mcpBatch(environment.bridge, { sessionId, calls: [
      { id: "wait", name: "wait", args: { tabRef: "page", seconds: 0 } },
      { id: "list", name: "list_tabs", args: { tabRef: "page" } },
      { id: "skills", name: "list_skills", args: { tabRef: "page" } },
      { id: "press", name: "act_on_screen", args: { tabRef: "page", action: "press", key: "Escape", returnScreenshot: false } },
    ] });
    expect(polish.results.every(item => !item.isError)).toBe(true);
    const screenshot = await scriptTool(dependencies, stdout, stderr, { sessionId, name: "screenshot", args: { tabRef: "page", target: "viewport" } });
    expect(screenshot.code).toBe(1);
    expect(screenshot.text || stderr.text).toContain("SCREENSHOT_TARGET_INVALID");
    expect(screenshot.text || stderr.text).toMatch(/Omit target to capture the viewport|截视口不传 target/);

    await expect(callTool(environment.bridge.endpoint, "qingzhou_send_message", {
      sessionId, text: "hello", timeoutSeconds: 15,
    }, { timeoutMs: 20_000 })).rejects.toThrow(/只能查看|read-only/);

    const batchSession = await createDrive();
    const batch = await mcpBatch(environment.bridge, {
      sessionId: batchSession,
      calls: [
        { id: "open", name: "open_tab", args: { url: `${fixture}/batch`, tabAlias: "page" } },
        { id: "read", name: "get_ax_tree", args: { tabRef: "page" } },
        { id: "click", name: "act_on_element", args: { tabRef: "page", target: "css:#go", action: "click" } },
      ],
    }, "120");
    expect(batch.results).toHaveLength(3);
    expect(batch.results.every((item) => item.isError !== true), JSON.stringify(batch)).toBe(true);
    expect(batch.runId).toEqual(expect.any(String));
    const savedTools = await environment.page.evaluate(async (id) => {
      const key = `_session_${id}`;
      const stored = await chrome.storage.local.get(key);
      const record = stored[key] || {};
      const transcript = [...(record.transcript || []), ...(record.currentTranscript || [])];
      return transcript.filter((entry) => entry && entry.type === "tool").map((entry) => entry.name);
    }, batchSession);
    expect(savedTools).toEqual(["open_tab", "get_ax_tree", "act_on_element"]);

    const smokeId = await createDrive();
    const smoke = await mcpBatch(environment.bridge, {
      sessionId: smokeId,
      calls: [
        { id: "open", name: "open_tab", args: { url: `${fixture}/smoke`, tabAlias: "page" } },
        { id: "read", name: "get_ax_tree", args: { tabRef: "page" } },
      ],
    }, "120");
    expect(smoke.results).toHaveLength(2);
    expect(smoke.sessionId).toBe(smokeId);
    expect(smoke.results.every((item) => item.isError !== true)).toBe(true);
    openedTabs.push(await tabIdForUrl(environment.page, `${fixture}/smoke`));
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", {
      sessionId: smoke.sessionId, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    const batchTab = await tabIdForUrl(environment.page, `${fixture}/batch`);
    openedTabs.push(batchTab);
    expect(String(batch.results[1].result?.snapshot || "")).not.toBe("");
    expect(JSON.stringify(batch)).not.toMatch(/CDP_RUN_CONTEXT_REQUIRED/);
    await expect.poll(async () => environment.page.evaluate(async (id) => {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.title });
      return injected.result;
    }, batchTab), { timeout: 15_000 }).toBe("clicked");

    const keptId = await createDrive();
    const kept = await scriptTool(dependencies, stdout, stderr, {
      sessionId: keptId,
      name: "open_tab",
      args: { url: `${fixture}/keep` },
    }, "90");
    expect(kept.code, kept.text || stderr.text).toBe(0);
    const keptTab = Number(kept.body.tabRef);
    openedTabs.push(keptTab);
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", {
      sessionId: keptId, keepTabs: true, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await tabExists(environment.page, keptTab)).toBe(true);
    const keptMeta = await environment.page.evaluate(async (id) => {
      const stored = await chrome.storage.local.get("_sessions");
      return stored._sessions?.[id] || null;
    }, keptId);
    expect(keptMeta?.source).toBe("external-drive");
    expect(keptMeta?.keepDriveTabs).toBeUndefined();
    const again = await scriptTool(dependencies, stdout, stderr, {
      sessionId: keptId,
      name: "list_tabs",
      args: {},
    });
    expect(again.code, again.text || stderr.text).toBe(1);
    expect(again.text || stderr.text).toContain("DRIVE_SESSION_ENDED");
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", {
      sessionId: keptId, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await tabExists(environment.page, keptTab)).toBe(true);

    const userTab = await environment.page.evaluate(async (url) => {
      const tab = await chrome.tabs.create({ url, active: false });
      return tab.id;
    }, `${fixture}/user`);
    openedTabs.push(userTab);
    const claimId = await createDrive();
    const claimed = await scriptTool(dependencies, stdout, stderr, {
      sessionId: claimId,
      name: "act_on_element",
      args: { tabRef: userTab, target: "css:#go", action: "click" },
    }, "60");
    expect(claimed.code).toBe(1);
    expect(claimed.body.code).toBe('SESSION_TAB_UNOWNED');
    await expect.poll(() => environment.page.evaluate(async id => (await chrome.tabs.get(id)).title, userTab), { timeout: 15_000 }).toBe('drive');
    const readUserPage = await scriptTool(dependencies, stdout, stderr, { sessionId: claimId, name: 'read_article', args: { tabRef: userTab, limit: 100 } }, '60');
    expect(readUserPage.code, readUserPage.text || stderr.text).toBe(0);
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", {
      sessionId: claimId, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await tabExists(environment.page, userTab)).toBe(true);

    stdout.text = stderr.text = "";
    expect(await main(["session", "cancel", sessionId, "--json"], dependencies), stdout.text || stderr.text).toBe(0);
    expect(JSON.parse(stdout.text).result.sessionId).toBe(sessionId);
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", {
      sessionId: batchSession, timeoutSeconds: 20,
    }, { timeoutMs: 25_000 });
    await expect.poll(() => tabExists(environment.page, tabId), { timeout: 15_000 }).toBe(false);
    const afterCancel = await scriptTool(dependencies, stdout, stderr, { sessionId, name: "close_tab", args: { tabRef: "page" } });
    expect(afterCancel.code).toBe(1);
    expect(afterCancel.text || stderr.text).toContain("DRIVE_SESSION_ENDED");

    const pdfSession = await createDrive();
    const pdf = await scriptTool(dependencies, stdout, stderr, { sessionId: pdfSession, name: "open_tab",
      args: { url: `${fixture}/document`, tabAlias: "pdf" } }, "90");
    expect(pdf.code, pdf.text || stderr.text).toBe(0);
    openedTabs.push(await tabIdForUrl(environment.page, `${fixture}/document`));
    const pdfRead = await scriptTool(dependencies, stdout, stderr, { sessionId: pdfSession, name: "read_article",
      args: { tabRef: "pdf", limit: 1200 } });
    expect(pdfRead.code, pdfRead.text || stderr.text).toBe(1);
    expect(pdfRead.text || stderr.text).toContain("PDF_PAGE_UNSUPPORTED");
    expect(JSON.parse(pdfRead.text).result.details.url).toBe(`${fixture}/document`);
    expect(pdfRead.text || stderr.text).not.toMatch(/tabId|\binner\b/);
    const pdfPress = await scriptTool(dependencies, stdout, stderr, { sessionId: pdfSession, name: "act_on_screen",
      args: { tabRef: "pdf", action: "press", key: "Escape", returnScreenshot: false } });
    expect(pdfPress.code, pdfPress.text || stderr.text).toBe(1);
    expect(pdfPress.text || stderr.text).toContain("PDF_PAGE_UNSUPPORTED");
    expect(pdfPress.text || stderr.text).not.toContain("BATCH_TAB_REFERENCE_ERROR");
    await callTool(environment.bridge.endpoint, "qingzhou_stop_session", { sessionId: pdfSession });
  } finally {
    await environment.page.evaluate(async (ids) => {
      const open = [];
      for (const id of ids) {
        try { await chrome.tabs.get(id); open.push(id); } catch { /* already closed */ }
      }
      if (open.length) await chrome.tabs.remove(open);
    }, openedTabs).catch(() => {});
    await environment.close();
    await fixture.close();
  }
});

test("drive timeline retains repeated batch IDs and nested script calls as separate cards", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { launchIsolatedExtensionMcp } = await import("../support/isolated-extension-mcp.mjs");
  const fixture = await startPage();
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-drive-transcript-" });
  const { page, bridge } = environment;
  const navigationDiagnostics = process.env.QZ_TIMELINE_NAVIGATION_DIAGNOSTICS
    ? await observeTimelineNavigation(environment) : null;
  const stdout = { text: "", write(value) { this.text += value; } };
  const stderr = { text: "", write(value) { this.text += value; } };
  const dependencies = { stdout, stderr, findDaemon: async () => ({ endpoint: bridge.endpoint, health: await readHealth(bridge.endpoint) }) };
  try {
    const { sessionId } = await callTool(bridge.endpoint, "qingzhou_create_drive_session", { title: "Drive timeline regression" });
    const cards = page.locator("#messages .msg-tool");
    for (const [index, alias] of ["first", "second", "third"].entries()) {
      navigationDiagnostics?.mark("batch.begin", { alias });
      const result = await mcpBatch(bridge, { sessionId, calls: [
        { id: "open", name: "open_tab", args: { url: `${fixture}/${alias}`, tabAlias: alias } },
        { id: "read", name: "read_article", args: { tabRef: alias, limit: 6000 } },
      ] });
      navigationDiagnostics?.mark("batch.end", { alias, result });
      await navigationDiagnostics?.checkpoint();
      expect(result.results.every(row => !row.isError), JSON.stringify(result)).toBe(true);
      expect(result.results.map(row => row.id)).toEqual(["open", "read"]);
      if (index === 0) {
        await page.locator('[data-tab="sessions"]').click();
        await page.locator('[data-sessions-mode="external-drive"]').click();
        await page.locator(`.session-card[data-id="${sessionId}"]`).click();
        await expect(page.locator("#app")).toHaveAttribute("data-external-drive", "true");
        expect(await page.evaluate(async id => (await chrome.tabs.get(id)).active,
          await tabIdForUrl(page, `${fixture}/${alias}`))).toBe(false);
      }
      await expect(cards).toHaveCount((index + 1) * 2);
    }
    stdout.text = stderr.text = "";
    const scriptCode = `console.log("drive timeline trace");
      await tools.read_article({tabRef:"first",limit:100});
      await tools.wait({seconds:0});
      await tools.read_article({tabRef:"second",limit:100});
      return {title:"returned value is not the page title"};`;
    expect(await main(["script", "--session", sessionId, "--json", "-"], {
      ...dependencies, readStdin: async () => scriptCode,
    }), stdout.text || stderr.text).toBe(0);
    await expect(cards).toHaveCount(10);
    const scriptReceipt = scriptOutput(stdout, stderr);
    expect(scriptReceipt.result).toEqual({ title: "returned value is not the page title" });
    expect(scriptReceipt.trace).toContain("drive timeline trace");
    expect((await cards.last().locator(".tool-args-preview").allTextContents()).join(" ")).not.toMatch(/First page|Second page|returned value is not the page title/);
    await expect(cards.last()).not.toContainText("当前页面");
    const result = await callTool(bridge.endpoint, "qingzhou_execute_tool", { sessionId, calls: [
      { id: "read", name: "read_article", args: { tabRef: "third", limit: 100 } },
      { id: "read", name: "read_article", args: { tabRef: "first", limit: 100 } },
    ] });
    expect(result.results.every(row => !row.isError)).toBe(true);
    await expect(cards).toHaveCount(12);
    const saved = await page.evaluate(async id => {
      const { readSessionSnapshot } = await import('/shared/session/session-recovery.js');
      const recordKey = `_session_${id}`, checkpointKey = `_session_transcript_checkpoint_${id}`;
      const values = await chrome.storage.local.get([recordKey, checkpointKey]);
      return readSessionSnapshot(values[recordKey], null, values[checkpointKey]).transcript.filter(entry => entry.type === 'tool');
    }, sessionId);
    expect(saved).toHaveLength(12);
    expect(new Set(saved.map(row => row.toolCallId)).size).toBe(12);
    expect(saved.filter(row => row.name === "open_tab")).toHaveLength(3);
    expect(saved.find(row => row.name === "run_script").result._pageTitle).toBeUndefined();
    expect(saved.filter(row => row.name === "read_article" && row.args.tabRef === "second")
      .every(row => row.result._pageTitle === "Second page")).toBe(true);
    await page.reload();
    await expect(page.locator("#app")).toHaveAttribute("data-external-drive", "true");
    await expect(cards).toHaveCount(12);
    expect(await cards.evaluateAll(nodes => new Set(nodes.map(node => node.id)).size)).toBe(12);
    await page.locator('[data-tab="sessions"]').click();
    await page.locator('[data-sessions-mode="external-drive"]').click();
    const taskEntries = page.locator('#sessions-list .session-card:not(.is-removing)');
    await expect(taskEntries).toHaveCount(1);
    await expect(taskEntries.first()).toHaveAttribute('data-id', sessionId);
    for (const name of ['wait', 'read_article', 'read_article']) {
      const repeated = await scriptTool(dependencies, stdout, stderr, { sessionId, name,
        args: name === 'wait' ? { seconds: 0 } : { tabRef: 'first', limit: 100 } });
      expect(repeated.code, repeated.text || stderr.text).toBe(0);
      await expect(page.locator('#sessions-list .session-card')).toHaveCount(1);
      await expect(taskEntries.first()).toHaveAttribute('data-id', sessionId);
    }
    const extraIds = [];
    for (let i = 0; i < 2; i++) {
      stdout.text = stderr.text = '';
      expect(await main(['session', 'create', '--title', 'Drive timeline regression', '--json'], dependencies), stdout.text || stderr.text).toBe(0);
      extraIds.push(JSON.parse(stdout.text).result.sessionId);
      await expect(taskEntries).toHaveCount(i + 2);
    }
    expect(new Set(await taskEntries.evaluateAll(nodes => nodes.map(node => node.dataset.id))))
      .toEqual(new Set([sessionId, ...extraIds]));
    expect(await taskEntries.locator('.session-card-title').allTextContents()).toEqual(Array(3).fill("Drive timeline regression"));
    await expect(page.locator('#sessions-list .session-card')).toHaveCount(3);
    const createdTabs = await Promise.all(saved.filter(row => row.name === "open_tab").map(row => tabIdForUrl(page, row.result.url)));
    expect(createdTabs).toHaveLength(3);
    expect(createdTabs.every(id => Number.isInteger(id) && id > 0)).toBe(true);
    for (const id of extraIds) await callTool(bridge.endpoint, 'qingzhou_stop_session', { sessionId: id });
    await callTool(bridge.endpoint, "qingzhou_stop_session", { sessionId });
    await expect.poll(async () => (await Promise.all(createdTabs.map(id => tabExists(page, id)))).some(Boolean)).toBe(false);
  } finally {
    if (navigationDiagnostics) {
      const evidence = await navigationDiagnostics.finish();
      const path = testInfo.outputPath("timeline-navigation.json");
      await writeFile(path, JSON.stringify({ ...evidence, server: fixture.requests }, null, 2));
      await testInfo.attach("timeline-navigation", { path, contentType: "application/json" });
    }
    await environment.close(); await fixture.close();
  }
});

async function observeTimelineNavigation({ context, page }) {
  const events = [];
  const mark = (type, data) => events.push({ at: Date.now(), type, data });
  const watchPage = item => {
    mark("playwright.page", { url: item.url() });
    item.on("framenavigated", frame => mark("playwright.frame", { url: frame.url(), main: frame === item.mainFrame() }));
    item.on("close", () => mark("playwright.close", { url: item.url() }));
    item.on("crash", () => mark("playwright.crash", { url: item.url() }));
    item.on("requestfailed", request => mark("playwright.requestfailed", { url: request.url(), error: request.failure() }));
  };
  context.on("page", watchPage);
  await page.evaluate(() => {
    globalThis.timelineNavigationEvents = [];
    const save = (type, data) => timelineNavigationEvents.push({ at: Date.now(), type, data });
    chrome.tabs.onCreated.addListener(tab => save("tabs.created", tab));
    chrome.tabs.onUpdated.addListener((tabId, change, tab) => save("tabs.updated", { tabId, change, tab }));
    chrome.tabs.onRemoved.addListener((tabId, info) => save("tabs.removed", { tabId, info }));
    chrome.debugger.onDetach.addListener((source, reason) => save("debugger.detached", { source, reason }));
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (/^(Page\.|Target\.|Debugger\.paused)/.test(method)) save("debugger.event", { source, method, params });
    });
    for (const name of ["onBeforeNavigate", "onCommitted", "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget"])
      chrome.webNavigation[name]?.addListener(details => save(`navigation.${name}`, details));
  });
  const cdp = await context.newCDPSession(page);
  for (const type of ["targetCreated", "targetInfoChanged", "targetDestroyed", "targetCrashed", "attachedToTarget", "detachedFromTarget"])
    cdp.on(`Target.${type}`, data => mark(`cdp.${type}`, data));
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  return { mark, async checkpoint() {
    mark("browser.snapshot", await page.evaluate(async () => ({ events: globalThis.timelineNavigationEvents || [],
      tabs: await chrome.tabs.query({}), debuggerTargets: await chrome.debugger.getTargets() })));
  }, async finish() {
    const browser = await page.evaluate(async () => ({ events: globalThis.timelineNavigationEvents || [],
      tabs: await chrome.tabs.query({}), debuggerTargets: await chrome.debugger.getTargets() }))
      .catch(error => ({ error: String(error) }));
    await cdp.detach().catch(() => {});
    context.off("page", watchPage);
    return { events, browser };
  } };
}

async function scriptTool(dependencies, stdout, stderr, { sessionId, name, args = {} }, timeout = "60") {
  stdout.text = "";
  stderr.text = "";
  const code = await main(["script", "--session", sessionId, "--timeout", timeout, "--json", "--args", JSON.stringify({ name, args }), "-"], {
    ...dependencies, readStdin: async () => "return await tools[input.name](input.args);",
  });
  expect([0, 1]).toContain(code);
  const { result: body, trace } = scriptOutput(stdout, stderr);
  return { code, text: stdout.text, body, trace };
}

function scriptOutput(stdout, stderr) {
  expect(stderr.text, "These scripts return no images; their traces belong in stdout").toBe("");
  const value = JSON.parse(stdout.text);
  expect(Object.keys(value).sort()).toEqual(["ok", "result", "trace"]);
  expect(typeof value.ok).toBe("boolean");
  expect(Array.isArray(value.trace)).toBe(true);
  expect(value.trace.every(trace => typeof trace === "string")).toBe(true);
  return value;
}

function mcpBatch(bridge, payload, timeout = "60") {
  return callTool(bridge.endpoint, "qingzhou_execute_tool", { ...payload, timeoutSeconds: Number(timeout) }, { timeoutMs: (Number(timeout) + 5) * 1000 });
}

async function tabIdForUrl(page, url) {
  return page.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
}

function tabExists(page, tabId) {
  return page.evaluate(async (id) => {
    try { await chrome.tabs.get(id); return true; } catch { return false; }
  }, tabId);
}

function startPage() {
  const requests = [];
  const page = `<!doctype html><title>drive</title><p id="status">drive-ok</p><button id="go" type="button">Go</button>
<script>document.getElementById("go").addEventListener("click", () => { document.title = "clicked"; document.getElementById("status").textContent = "clicked"; });</script>`;
  const server = createServer((request, response) => {
    const event = { at: Date.now(), method: request.method, path: request.url };
    requests.push(event);
    response.on("finish", () => { event.finishedAt = Date.now(); });
    response.on("close", () => { event.closedAt = Date.now(); });
    if (request.url === "/document") {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(textPdf(["Drive PDF fixture"]));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const title = { "/first": "First page", "/second": "Second page", "/third": "Third page" }[request.url] || "drive";
    response.end(page.replace("<title>drive</title>", `<title>${title}</title>`));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        requests,
        toString() { return `http://127.0.0.1:${address.port}`; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

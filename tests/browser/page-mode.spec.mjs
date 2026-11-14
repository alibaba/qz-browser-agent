import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

test("mobile tabs use mobile headers from the first request, persist across runs, and reject stale screenshots", async () => {
  test.setTimeout(120_000);
  const requests = [];
  let releaseInitialNavigation;
  const initialNavigation = new Promise(resolve => { releaseInitialNavigation = resolve; });
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/landed" });
      res.end();
      return;
    }
    if (req.url === "/mobile") await initialNavigation;
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mode fixture</title>
      <button id="target" style="margin:20px;touch-action:none">Target</button><p>Mobile mode fixture</p>
      <img alt="Navigation fixture" width="1" height="1" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4FYAAAAASUVORK5CYII=">
      <form action="/search"><input name="q"><button>Search</button></form>
      <a id="next" href="/redirect">Next</a>
      <a id="cross-site" href="http://localhost:${server.address().port}/cross-site">Cross site</a>
      <script>
        window.inputEvents=[];
        for(const type of ['touchstart','touchend','touchcancel','mousedown','click']) document.querySelector('#target').addEventListener(type,event=>{
          if(event.cancelable && type.startsWith('touch')) event.preventDefault();
          inputEvents.push({type, trusted:event.isTrusted});
        },{passive:false});
      </script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-page-mode-"));
  let browser;
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    // Static test entry only: production modules, CDP, tool assembly and page scripts are unchanged.
    await writeFile(join(extension, "mode-test-worker.js"), `import "./${manifest.background.service_worker}";
      import * as tools from "./background/tools/runtime.js";
      import { readPageMode } from "./capabilities/tabs/page-mode.js";
      import { toolError } from "./shared/contracts/tool-error.js";
      globalThis.modeTestTools = tools;
      globalThis.modeTestPageMode = readPageMode;
      globalThis.modeTestToolError = toolError;`);
    manifest.background.service_worker = "mode-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      const owned = new Map();
      const harness = { runId: "first", tabId: null, detached: [], detachEvents: [] };
      const send = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = async (target, method, params) => {
        const result = await send(target, method, params);
        if (harness.failTouchEnd && method === "Input.dispatchTouchEvent" && params.type === "touchEnd") {
          harness.failTouchEnd = false;
          throw new Error("Injected lost touchEnd response");
        }
        return result;
      };
      chrome.debugger.onDetach.addListener((target, reason) => harness.detachEvents.push({ tabId: target.tabId, reason }));
      const detach = chrome.debugger.detach.bind(chrome.debugger);
      chrome.debugger.detach = async target => { await detach(target); harness.detached.push(target.tabId); };
      harness.runtime = modeTestTools.createToolRuntime({
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: {
          isRunCurrent: (_sessionId, runId) => runId === harness.runId,
          resolveTargetTab: async input => {
            if (owned.get(input.tabId) !== input.sessionId) return { ok: false, code: "SESSION_TAB_FOREIGN" };
            return { ok: true, tabId: input.tabId, tab: await chrome.tabs.get(input.tabId), ownedByCurrentTask: true };
          },
          updateWorkingTab: async ({ sessionId, tab }) => { owned.set(tab.id, sessionId); harness.tabId = tab.id; },
          clearWorkingTab: async ({ tabId }) => { owned.delete(tabId); if (harness.tabId === tabId) harness.tabId = null; },
        },
      });
      harness.call = async (name, args, sessionId = "mobile-test") => {
        try {
          const result = await harness.runtime.execute(name, args, undefined,
            { sessionId, runId: harness.runId, workingTabId: harness.tabId });
          if (name === "screenshot") return { screenshotId: result.screenshotId, coordinateSpace: result.coordinateSpace, page: modeTestTools.getToolResultPageContext(result)._pageContext };
          return result;
        } catch (error) {
          return modeTestToolError(String(error?.code || "TOOL_EXECUTION_FAILED"), error?.message || String(error),
            { hint: error?.hint, details: error?.details });
        }
      };
      globalThis.modeHarness = harness;
    });
    const call = (name, args = {}, sessionId) => worker.evaluate(({ name, args, sessionId }) => modeHarness.call(name, args, sessionId), { name, args, sessionId });
    const pageMode = tabId => worker.evaluate(tabId => modeTestPageMode(tabId), tabId);
    const inspect = tabId => worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId }, func: () => ({
      width: innerWidth, screenWidth: screen.width, dpr: devicePixelRatio, touch: navigator.maxTouchPoints,
      ua: navigator.userAgent, mobile: navigator.userAgentData?.mobile, platform: navigator.userAgentData?.platform,
      ready: document.readyState, url: location.href,
    }) }))[0].result, tabId);
    let opened = false;
    const opening = call("open_tab", { url: `${url}/mobile`, mode: "mobile", watchNetwork: true })
      .then(result => { opened = true; return result; });
    await expect.poll(() => requests.some(request => request.url === "/mobile")).toBe(true);
    expect(opened, "open_tab must wait for the initial document to commit").toBe(false);
    releaseInitialNavigation();
    const mobile = await opening;
    expect(mobile, JSON.stringify(mobile)).not.toHaveProperty("code");
    expect(Object.keys(mobile).sort()).toEqual(["active", "tabRef", "title", "url"]);
    const tabId = mobile.tabRef;
    expect(await pageMode(tabId)).toBe("mobile");
    const [images, article] = await Promise.all([
      call("list_images", { tabRef: tabId, minWidth: 1, minHeight: 1 }),
      call("read_article", { tabRef: tabId, limit: 1200 }),
    ]);
    await expect.poll(async () => { try { return (await inspect(tabId)).ready; } catch { return "loading"; } }).toBe("complete");
    expect(images, JSON.stringify(images)).not.toHaveProperty("code");
    expect(images.images).toEqual(expect.arrayContaining([expect.objectContaining({ alt: "Navigation fixture" })]));
    expect(article, JSON.stringify(article)).not.toHaveProperty("code");
    expect(article.text).toContain("Mobile mode fixture");
    expect(await inspect(tabId)).toMatchObject({ width: 412, screenWidth: 412, dpr: 2.625, touch: 5, mobile: true, platform: "Android" });
    const first = requests.find(request => request.url === "/mobile");
    expect(first.headers["user-agent"]).toMatch(/Android.*Mobile/);
    expect(first.headers["sec-ch-ua-mobile"]).toBe("?1");
    const requestCount = () => requests.filter(request => request.url === "/mobile").length;
    const before = requestCount();
    expect(await call("set_page_mode", { tabRef: tabId, mode: "mobile" })).toMatchObject({ changed: false, reloaded: false });
    expect(requestCount()).toBe(before);
    expect(await pageMode(tabId)).toBe("mobile");
    const listed = await call("list_tabs", { scope: "owned" });
    const listedMobile = listed.tabs.find(tab => tab.tabRef === tabId);
    expect(Object.keys(listedMobile).sort()).toEqual(["active", "ownership", "tabRef", "title", "url"]);
    expect(listedMobile).toMatchObject({ tabRef: tabId, url: `${url}/mobile`, active: false, ownership: "owned" });

    const inputEvents = () => worker.evaluate(async tabId => (await chrome.scripting.executeScript({target:{tabId}, world:"MAIN", func:()=>window.inputEvents}))[0].result, tabId);
    expect(await call("act_on_element", {tabRef:tabId,target:"css:#target", action:"click"})).toEqual({});
    expect(await inputEvents()).toEqual([{type:"touchstart",trusted:true},{type:"touchend",trusted:true}]);
    const inputShot = await call("screenshot", {tabRef:tabId,actionable:true});
    const point = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({target:{tabId}, func:()=>{
      const r=document.querySelector('#target').getBoundingClientRect();
      return {x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight};
    }}))[0].result, tabId);
    expect(await call("act_on_screen", {tabRef:tabId,action:"click", returnScreenshot:false,
      x:point.x*inputShot.coordinateSpace.width,y:point.y*inputShot.coordinateSpace.height})).toMatchObject({status:"completed"});
    expect((await inputEvents()).map(event=>event.type)).toEqual(["touchstart","touchend","touchstart","touchend"]);
    await worker.evaluate(() => { modeHarness.failTouchEnd = true; });
    expect(await call("act_on_element", {tabRef:tabId,target:"css:#target", action:"click"})).toEqual({
      code: "TOOL_EXECUTION_FAILED", message: "Injected lost touchEnd response",
      details: { tool: "act_on_element", action: "click", tabRef: tabId, target: "css:#target",
        status: "unconfirmed", mayHaveTakenEffect: true, automaticReplay: false },
    });
    expect((await inputEvents()).map(event=>event.type)).toEqual(["touchstart","touchend","touchstart","touchend","touchstart","touchend"]);
    // A terminal run revokes normal command access before cleanup. Its retained
    // connection still has to release a pressed finger on the native page.
    await worker.evaluate(async ({tabId, point}) => {
      await chrome.debugger.sendCommand({tabId}, "Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{x:point.x*412,y:point.y*915,id:0}]});
      await modeTestTools.releaseRunCdp("mobile-test", modeHarness.runId);
      modeHarness.runId = "after-stop";
    }, {tabId,point});
    expect((await inputEvents()).at(-1).type).toBe("touchcancel");

    for (const [action, path] of [["search", "/search?q=keyword"], ["next", "/landed"], ["cross-site", "/cross-site"]]) {
      await worker.evaluate(async ({ tabId, action }) => {
        await chrome.scripting.executeScript({ target: { tabId }, args: [action], func: action => {
          if (action === "search") {
            document.querySelector('input[name="q"]').value = "keyword";
            document.querySelector("form").requestSubmit();
          } else document.getElementById(action).click();
        } });
      }, { tabId, action });
      await expect.poll(async () => { try { const state = await inspect(tabId); return state.ready === "complete" && state.url.endsWith(path); } catch { return false; } }).toBe(true);
      expect(await inspect(tabId), action).toMatchObject({ width: 412, screenWidth: 412, touch: 5, mobile: true });
      expect(await worker.evaluate(() => modeHarness.detachEvents), action).toEqual([]);
      expect(await pageMode(tabId)).toBe("mobile");
      expect(requests.find(request => request.url === path)?.headers["sec-ch-ua-mobile"]).toBe("?1");
    }

    const shot = await call("screenshot", { tabRef: tabId, actionable: true });
    expect(shot.screenshotId).toBeTruthy();
    expect(shot.page).toEqual({ pageMode: "mobile" });
    expect(await call("set_page_mode", { tabRef: tabId, mode: "desktop" })).toMatchObject({ pageMode: "desktop", reloaded: true });
    await expect.poll(async () => { try { return (await inspect(tabId)).ready; } catch { return "loading"; } }).toBe("complete");
    expect(await inspect(tabId)).toMatchObject({ touch: 0, mobile: false });
    expect((await inspect(tabId)).ua).not.toContain("Android");
    await expect.poll(() => worker.evaluate(tabId => modeHarness.detached.includes(tabId), tabId)).toBe(true);
    const stale = await call("act_on_screen", { tabRef: tabId, action: "click", x: 20, y: 20, returnScreenshot: false });
    expect(stale.code).toMatch(/STALE|SCREENSHOT/);
    expect((await call("set_page_mode", { tabRef: tabId, mode: "mobile" }, "foreign-task")).code).toBe("SESSION_TAB_FOREIGN");
    expect(await call("set_page_mode", { tabRef: tabId, mode: "mobile" })).toMatchObject({ pageMode: "mobile" });
    expect(await call("navigate", { tabRef: tabId, url: `${url}/next` })).toMatchObject({ pageMode: "mobile" });
    await expect.poll(() => requests.find(request => request.url === "/next")?.headers["sec-ch-ua-mobile"]).toBe("?1");

    const nextRequests = () => requests.filter(request => request.url === "/next").length;
    const beforeRelease = nextRequests();
    await worker.evaluate(async () => { await modeTestTools.releaseRunCdp("mobile-test", modeHarness.runId); modeHarness.runId = "second"; });
    expect(await pageMode(tabId)).toBe("mobile");
    expect(await inspect(tabId)).toMatchObject({ width: 412, touch: 5, mobile: true });
    const restored = await call("screenshot", { tabRef: tabId, actionable: true });
    expect(restored.page).toEqual({ pageMode: "mobile" });
    expect((await inspect(tabId)).mobile).toBe(true);
    expect(nextRequests()).toBe(beforeRelease, "continuing a task must not reload its mobile page");
    const other = await call("open_tab", { url: `${url}/desktop` }, "other-task");
    expect(Object.keys(other).sort()).toEqual(["active", "tabRef", "title", "url"]);
    expect(await pageMode(other.tabRef)).toBe("desktop");
    await expect.poll(() => requests.find(request => request.url === "/desktop")?.headers["sec-ch-ua-mobile"]).toBe("?0");
    expect((await inspect(tabId)).mobile).toBe(true);
    await worker.evaluate(async () => { await modeTestTools.releaseRunCdp("mobile-test", modeHarness.runId); });
    expect(await inspect(tabId)).toMatchObject({ width: 412, touch: 5, mobile: true });
    const detachCount = await worker.evaluate(() => modeHarness.detached.length);
    await worker.evaluate(async () => { await modeTestTools.releaseSessionCdp("mobile-test"); });
    expect(await inspect(tabId)).toMatchObject({ touch: 0, mobile: false });
    expect(await worker.evaluate(() => modeHarness.detached.length)).toBe(detachCount + 1);
  } finally {
    releaseInitialNavigation();
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

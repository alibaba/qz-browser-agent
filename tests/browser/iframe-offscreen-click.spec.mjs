import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const frameDocument = (id, label) => `<!doctype html><button id="${id}" type="button" style="width:140px;height:32px" onclick="window.clicks=(window.clicks||0)+1">${label}</button>`;

function pageHtml(crossUrl) {
  return `<!doctype html><meta charset="utf-8"><title>Offscreen frames</title>
    <style>
      html,body{margin:0}
      iframe{display:block;width:320px;height:80px;border:0}
      button{width:160px;height:36px}
      #fixed{position:fixed;top:-700px;left:12px}
    </style>
    <button id="top" type="button">Top Button</button>
    <iframe id="same" name="same" title="Same frame"></iframe>
    <div id="gap" style="height:1px"></div>
    <iframe id="cross" name="cross" title="Cross frame" src="${crossUrl}"></iframe>
    <button id="below" type="button">Below Button</button>
    <iframe id="fixed" name="fixed" title="Fixed frame"></iframe>
    <script>
      window.topClicks=0; window.belowClicks=0;
      document.querySelector("#top").addEventListener("click",()=>{window.topClicks+=1});
      document.querySelector("#below").addEventListener("click",()=>{window.belowClicks+=1});
      document.addEventListener("click", event => {
        window.lastClick = (event.target.id || event.target.tagName || "");
        window.lastPoint = { x: event.clientX, y: event.clientY, trusted: event.isTrusted };
      }, true);
      document.querySelector("#same").srcdoc = ${JSON.stringify(frameDocument("same", "Same Button"))};
      document.querySelector("#fixed").srcdoc = ${JSON.stringify(frameDocument("fixed", "Fixed Button"))};
    </script>`;
}

test("off-screen iframe clicks scroll into the page viewport or fail", async () => {
  test.setTimeout(120000);
  const cross = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(frameDocument("cross", "Cross Button"));
  });
  const parent = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pageHtml(`http://localhost:${cross.address().port}/`));
  });
  await new Promise(resolve => cross.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-iframe-offscreen-"));
  let browser;
  const close = async () => {
    await browser?.close();
    cross.closeAllConnections?.();
    parent.closeAllConnections?.();
    await new Promise(resolve => cross.close(resolve));
    await new Promise(resolve => parent.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(join(extension, "element-test-worker.js"), `import "./${manifest.background.service_worker}";
      import * as tools from "./background/tools/runtime.js"; globalThis.elementTestTools = tools;`);
    manifest.background.service_worker = "element-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions", "--hide-scrollbars"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-proxy-server",
        "--window-size=800,600",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      let tabId;
      const context = { sessionId: "iframe-offscreen", runId: "run", runProfile: { platform: { os: "linux" } } };
      const runtime = elementTestTools.createToolRuntime({
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: {
          isRunCurrent: () => true,
          resolveTargetTab: async input => input.tabId === tabId
            ? { ok: true, tabId, tab: await chrome.tabs.get(tabId), ownedByCurrentTask: true }
            : { ok: false, code: "SESSION_TAB_FOREIGN" },
          updateWorkingTab: async ({ tab }) => { tabId = tab.id; },
        },
      });
      globalThis.elementHarness = {
        async call(name, args) {
          try { return await runtime.execute(name, { tabId, ...args }, undefined, { ...context, workingTabId: tabId, source: "run_script" }); }
          catch (error) { return { error: error.message, code: error.code, details: error.details }; }
        },
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => elementHarness.call(name, args), { name, args });
    const opened = await call("open_tab", { url: `http://127.0.0.1:${parent.address().port}/` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    const page = browser.pages().find(item => item.url().startsWith("http://127.0.0.1:"));
    await expect.poll(async () => page.frame({ name: "same" })?.locator("button").count().catch(() => 0) ?? 0, { timeout: 15000 }).toBe(1);
    await expect.poll(async () => page.frame({ name: "cross" })?.locator("button").count().catch(() => 0) ?? 0, { timeout: 15000 }).toBe(1);
    await expect.poll(async () => page.frame({ name: "fixed" })?.locator("button").count().catch(() => 0) ?? 0, { timeout: 15000 }).toBe(1);
    await page.evaluate(() => {
      document.querySelector("#gap").style.height = `${window.innerHeight + 2000}px`;
    });
    const placed = await page.evaluate(() => {
      const box = id => {
        const rect = document.querySelector(id).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      };
      return { height: window.innerHeight, scrollY: window.scrollY, same: box("#same"), cross: box("#cross"), below: box("#below"), fixed: box("#fixed") };
    });
    expect(placed.scrollY).toBe(0);
    expect(placed.same.bottom).toBeGreaterThan(0);
    expect(placed.same.top).toBeLessThan(placed.height);
    expect(placed.cross.top).toBeGreaterThan(placed.height);
    expect(placed.below.top).toBeGreaterThan(placed.height);
    expect(placed.fixed.bottom).toBeLessThan(0);

    const found = {};
    await expect.poll(async () => {
      const result = await call("get_ax_tree", { scope: "full", limit: 200 });
      const snapshot = String(result.snapshot || "");
      found.top = targetFor(snapshot, 'button "Top Button"');
      found.same = targetFor(snapshot, 'button "Same Button"');
      found.cross = targetFor(snapshot, 'button "Cross Button"');
      found.below = targetFor(snapshot, 'button "Below Button"');
      found.fixed = targetFor(snapshot, 'button "Fixed Button"');
      found.code = result.code || result.error || "";
      const ready = found.top && found.same && found.cross && found.below && found.fixed;
      return ready ? "ready" : `missing ${JSON.stringify(found)}\n${snapshot}`;
    }, { timeout: 30000 }).toBe("ready");
    expect(found.code).toBe("");

    const crossInspect = await call("inspect_element", { target: found.cross });
    expect(crossInspect, JSON.stringify(crossInspect)).toMatchObject({
      inViewport: false,
      state: { inViewport: false, clickablePointInViewport: false },
    });
    const fixedClick = await call("act_on_element", { target: found.fixed, action: "click" });
    expect(fixedClick, JSON.stringify(fixedClick)).toMatchObject({ code: "CLICK_POINT_OUT_OF_VIEWPORT" });
    expect(fixedClick.inputDelivered).not.toBe(true);
    expect(fixedClick.clickDispatched).not.toBe(true);
    expect(fixedClick.element?.state?.clickablePointInViewport).toBe(false);
    expect(await page.frame({ name: "fixed" }).evaluate(() => window.clicks || 0)).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const crossClick = await call("act_on_element", { target: found.cross, action: "click" });
    expect(crossClick, JSON.stringify(crossClick)).toMatchObject({
      clickDispatched: true, inputDelivered: true,
      element: { inViewport: true, state: { clickablePointInViewport: true } },
    });
    expect(crossClick).not.toHaveProperty("code");
    const crossDebug = {
      clicks: await page.frame({ name: "cross" }).evaluate(() => window.clicks || 0),
      point: crossClick.element?.clickablePoint || null,
      placement: await framePlacement(page, "#cross"),
      last: await page.evaluate(() => ({ click: window.lastClick || "", point: window.lastPoint || null })),
      local: await page.frame({ name: "cross" }).evaluate(() => {
        const rect = document.querySelector("button").getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, top: rect.top };
      }),
    };
    expect(crossDebug.clicks, JSON.stringify(crossDebug)).toBe(1);
    const afterCross = await framePlacement(page, "#cross");
    expect(afterCross.scrollY).toBeGreaterThan(0);
    expect(afterCross.top).toBeLessThan(afterCross.height);
    expect(afterCross.bottom).toBeGreaterThan(0);

    const sameInspect = await call("inspect_element", { target: found.same });
    expect(sameInspect, JSON.stringify(sameInspect)).toMatchObject({
      inViewport: false,
      state: { clickablePointInViewport: false },
    });
    const sameBefore = await page.evaluate(() => window.scrollY);
    const sameClick = await call("act_on_element", { target: found.same, action: "click" });
    expect(sameClick, JSON.stringify(sameClick)).toMatchObject({ clickDispatched: true, inputDelivered: true });
    expect(sameClick).not.toHaveProperty("code");
    expect(await page.frame({ name: "same" }).evaluate(() => window.clicks || 0)).toBe(1);
    const afterSame = await framePlacement(page, "#same");
    expect(afterSame.scrollY).toBeLessThan(sameBefore);
    expect(afterSame.top).toBeLessThan(afterSame.height);
    expect(afterSame.bottom).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    const belowInspect = await call("inspect_element", { target: found.below });
    expect(belowInspect, JSON.stringify(belowInspect)).toMatchObject({
      inViewport: false,
      state: { clickablePointInViewport: false },
    });
    const belowClick = await call("act_on_element", { target: found.below, action: "click" });
    expect(belowClick, JSON.stringify(belowClick)).toMatchObject({ clickDispatched: true, inputDelivered: true });
    expect(belowClick).not.toHaveProperty("code");
    expect(await page.evaluate(() => window.belowClicks)).toBe(1);
    const afterBelow = await framePlacement(page, "#below");
    expect(afterBelow.scrollY).toBeGreaterThan(0);
    expect(afterBelow.top).toBeLessThan(afterBelow.height);
    expect(afterBelow.bottom).toBeGreaterThan(0);
    expect(await page.frame({ name: "cross" }).evaluate(() => window.clicks || 0)).toBe(1);
    expect(await page.frame({ name: "fixed" }).evaluate(() => window.clicks || 0)).toBe(0);
  } finally {
    await close();
  }
});

function targetFor(snapshot, part) {
  const line = String(snapshot || "").split("\n").find(item => item.includes(part));
  return line?.match(/target=(uid:\S+)/)?.[1] || "";
}

async function framePlacement(page, selector) {
  return page.evaluate(target => {
    const rect = document.querySelector(target).getBoundingClientRect();
    return { scrollY: window.scrollY, height: window.innerHeight, top: rect.top, bottom: rect.bottom };
  }, selector);
}

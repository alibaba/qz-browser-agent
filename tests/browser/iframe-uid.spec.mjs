import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const sameDocument = `<!doctype html><button id="same" class="hit" type="button" onclick="window.clicks=(window.clicks||0)+1">Same</button><input id="field" aria-label="Same field" value="">`;
const crossDocument = `<!doctype html><button id="cross" type="button" onclick="window.clicks=(window.clicks||0)+1">Cross</button><input id="field" aria-label="Cross field" value="">`;
const nestDocument = `<!doctype html><iframe title="Inner" srcdoc="<!doctype html><button id='deep'>Deep</button>"></iframe>`;

function pageHtml(crossUrl) {
  return `<!doctype html><meta charset="utf-8"><title>Iframe uids</title>
    <style>iframe{width:320px;height:80px;border:0;display:block}button,input{width:140px;height:28px}</style>
    <iframe id="same" name="same" title="Same frame"></iframe>
    <iframe id="cross" name="cross" title="Cross frame" src="${crossUrl}"></iframe>
    <iframe id="nest" name="nest" title="Nest frame"></iframe>
    <button id="main-hit" class="hit" type="button" style="position:fixed;left:360px;top:8px;width:140px;height:28px" onclick="window.hits=(window.hits||0)+1">Main hit</button>
    <script>
      document.querySelector("#same").srcdoc = ${JSON.stringify(sameDocument)};
      document.querySelector("#nest").srcdoc = ${JSON.stringify(nestDocument)};
    </script>`;
}

test("one-level iframe elements have uids and accept click and fill", async () => {
  test.setTimeout(120000);
  const cross = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(crossDocument);
  });
  const parent = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(pageHtml(`http://localhost:${cross.address().port}/`));
  });
  await new Promise(resolve => cross.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-iframe-uid-"));
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
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      let tabId;
      const context = { sessionId: "iframe-uid", runId: "run", runProfile: { platform: { os: "linux" } } };
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

    let snapshot = "";
    const found = {};
    await expect.poll(async () => {
      const result = await call("get_ax_tree", {});
      snapshot = String(result.snapshot || "");
      found.same = targetFor(snapshot, 'button "Same"');
      found.sameField = targetFor(snapshot, 'textbox "Same field"');
      found.cross = targetFor(snapshot, 'button "Cross"');
      found.crossField = targetFor(snapshot, 'textbox "Cross field"');
      found.code = result.code || result.error || "";
      const ready = Boolean(found.same && found.sameField && found.cross && found.crossField);
      if (ready) return "ready";
      return `missing same=${found.same} field=${found.sameField} cross=${found.cross} crossField=${found.crossField} code=${found.code}\n${snapshot}`;
    }, { timeout: 30000 }).toBe("ready");
    expect(found.code, snapshot).toBe("");
    expect(snapshot, snapshot).not.toContain("Deep");

    const sameClick = await call("act_on_element", { target: found.same, action: "click" });
    expect(sameClick, JSON.stringify(sameClick)).toMatchObject({ clickDispatched: true, inputDelivered: true });
    expect(sameClick).not.toHaveProperty("code");
    expect(await page.frame({ name: "same" }).evaluate(() => window.clicks)).toBe(1);
    const sameFill = await call("act_on_element", { target: found.sameField, action: "fill", value: "same-value" });
    expect(sameFill, JSON.stringify(sameFill)).toMatchObject({ filled: true, value: "same-value" });
    expect(await page.frame({ name: "same" }).evaluate(() => document.querySelector("input").value)).toBe("same-value");

    const crossClick = await call("act_on_element", { target: found.cross, action: "click" });
    expect(crossClick, JSON.stringify(crossClick)).toMatchObject({ clickDispatched: true, inputDelivered: true });
    expect(crossClick).not.toHaveProperty("code");
    expect(await page.frame({ name: "cross" }).evaluate(() => window.clicks)).toBe(1);
    const crossFill = await call("act_on_element", { target: found.crossField, action: "fill", value: "cross-value" });
    expect(crossFill, JSON.stringify(crossFill)).toMatchObject({ filled: true, value: "cross-value" });
    expect(await page.frame({ name: "cross" }).evaluate(() => document.querySelector("input").value)).toBe("cross-value");

    const cssClick = await call("act_on_element", { target: "css:button.hit", action: "click" });
    expect(cssClick, JSON.stringify(cssClick)).toMatchObject({ clickDispatched: true, inputDelivered: true });
    expect(cssClick).not.toHaveProperty("code");
    expect(await page.evaluate(() => window.hits)).toBe(1);
    expect(await page.frame({ name: "same" }).evaluate(() => window.clicks)).toBe(1);
  } finally {
    await close();
  }
});

function targetFor(snapshot, part) {
  const line = String(snapshot || "").split("\n").find(item => item.includes(part));
  return line?.match(/target=(uid:\S+)/)?.[1] || "";
}

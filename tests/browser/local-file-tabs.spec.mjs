import { chromium } from "playwright";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

test("task-owned local HTML supports page tools, scripts and tab cleanup", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-local-file-"));
  let browser;
  try {
    const file = join(directory, "local report #1 中文.html");
    await writeFile(file, `<!doctype html><html><head><title>Local task report</title></head>
      <body><article><h1>Local hiring report</h1><p>A synthetic local report for browser automation.</p>
      <button id="filter">Show remote roles</button><p id="result">All roles</p>
      <a id="details" href="detail%20%23%E4%B8%AD%E6%96%87.html">Open role details</a></article>
      <script>document.querySelector('#filter').addEventListener('click', () => {
        document.querySelector('#result').textContent = 'Remote roles only';
      });</script></body></html>`);
    const fileUrl = pathToFileURL(file).href;
    const detailFile = join(directory, "detail #中文.html");
    await writeFile(detailFile, "<!doctype html><title>Local role details</title><article><h1>Remote role details</h1><p>Requirements for the selected remote role.</p></article>");
    const detailUrl = pathToFileURL(detailFile).href;
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(join(extension, "local-file-test-worker.js"), `import "./${manifest.background.service_worker}";
      import { createToolRuntime } from "./background/tools/runtime.js";
      import { createSessionTabs } from "./background/session/tabs.js";
      globalThis.localFileTestFactories = { createToolRuntime, createSessionTabs };`);
    manifest.background.service_worker = "local-file-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-proxy-server"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    // Command-line unpacked extensions have file access in this isolated profile.
    // Permission-denied behavior is covered by the Session/runtime unit tests.
    expect(await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())).toBe(true);
    await worker.evaluate(() => {
      const runtimes = new Map([["local-file", { sessionId: "local-file", ownedTabIds: [] }]]);
      const supervisor = {
        getRuntime: id => runtimes.get(id) || null,
        setRuntime: (id, value) => { runtimes.set(id, value); return value; },
        runtimeEntries: () => [...runtimes],
        isRunCurrent: () => true,
      };
      const sessions = localFileTestFactories.createSessionTabs({
        supervisor, tabsApi: chrome.tabs, storage: chrome.storage.local,
        getSessions: async () => ({ "local-file": { id: "local-file", parentSessionId: "0" } }),
        isAutomationSessionFamily: () => false,
        setRuntime: (id, patch) => supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }),
        persistRuntime: async () => {},
        ensureTabGroupForWindow: async () => null,
      });
      const runtime = localFileTestFactories.createToolRuntime({
        sessions: { ...sessions, isRunCurrent: supervisor.isRunCurrent },
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
      });
      globalThis.localFileCall = async (name, args) => {
        try {
          return await runtime.execute(name, args, new AbortController().signal,
            { ...supervisor.getRuntime("local-file"), sessionId: "local-file", runId: "file-run", language: "en" });
        } catch (error) { return { code: error.code, error: error.message, details: error.details }; }
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => localFileCall(name, args), { name, args });
    const succeeded = result => { expect(result, JSON.stringify(result)).not.toHaveProperty("error"); return result; };
    const opened = succeeded(await call("open_tab", { url: fileUrl }));
    const tabId = opened.id;
    expect(opened._pageUrl).toBe(fileUrl);
    expect(succeeded(await call("list_tabs", {})).find(tab => tab.id === tabId)).toMatchObject({ url: fileUrl, usable: true });
    expect(succeeded(await call("get_working_tab", {})).url).toBe(fileUrl);
    expect(succeeded(await call("read_article", { tabId, limit: 2000 })).text).toContain("Local hiring report");
    expect(JSON.stringify(succeeded(await call("read_dom", { tabId })))).toContain("Show remote roles");
    expect(JSON.stringify(succeeded(await call("inspect_element", { tabId, target: "css:#filter" })))).toContain("Show remote roles");
    expect(JSON.stringify(succeeded(await call("get_ax_tree", { tabId })))).toContain("Show remote roles");
    succeeded(await call("act_on_element", { tabId, target: "css:#filter", action: "click" }));
    expect(succeeded(await call("read_article", { tabId, source: "selector", selector: "#result", limit: 1000 })).text).toContain("Remote roles only");
    const script = succeeded(await call("run_script", {
      tabId, target: "page", timeout: 10, mutatesPage: true,
      code: "document.querySelector('#result').textContent = 'Script verified'; ({ title: document.title, url: location.href })",
    }));
    expect(JSON.stringify(script)).toContain("Local task report");
    expect(script._pageUrl).toBe(fileUrl);
    expect(succeeded(await call("read_article", { tabId, limit: 2000 })).text).toContain("Script verified");
    const screenshot = succeeded(await call("screenshot", { tabId, format: "png" }));
    expect(screenshot._image).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(screenshot._image.split(",")[1], "base64");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBeGreaterThan(100);
    // A denied toggle blocks opening/reading, but still permits cleanup and leaving a file tab.
    await worker.evaluate(() => { chrome.extension.isAllowedFileSchemeAccess = async () => false; });
    expect((await call("read_article", { tabId, limit: 2000 })).code).toBe("FILE_ACCESS_REQUIRED");
    const tabCount = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    expect((await call("open_tab", { url: detailUrl })).code).toBe("FILE_ACCESS_REQUIRED");
    expect(await worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(tabCount);
    expect((await call("navigate", { tabId, url: detailUrl })).code).toBe("FILE_ACCESS_REQUIRED");
    expect(await worker.evaluate(async id => (await chrome.tabs.get(id)).url, tabId)).toBe(fileUrl);
    await browser.route("https://example.test/return", route => route.fulfill({ contentType: "text/html", body: "<h1>Back on the web</h1>" }));
    succeeded(await call("navigate", { tabId, url: "https://example.test/return" }));
    expect(succeeded(await call("read_article", { tabId, limit: 2000 })).text).toContain("Back on the web");
    await worker.evaluate(() => { chrome.extension.isAllowedFileSchemeAccess = async () => true; });
    succeeded(await call("navigate", { tabId, url: fileUrl }));
    await worker.evaluate(() => { chrome.extension.isAllowedFileSchemeAccess = async () => false; });
    expect(succeeded(await call("close_tab", { tabId })).closed).toBe(tabId);
    expect(await worker.evaluate(async id => {
      try { await chrome.tabs.get(id); return true; } catch { return false; }
    }, tabId)).toBe(false);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

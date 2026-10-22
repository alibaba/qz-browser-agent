import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const sections = Array.from({ length: 40 }, (_value, index) => `<h2>Section ${index + 1}</h2>`).join("");
const repeatedHtml = `<!doctype html><meta charset="utf-8"><title>Repeated values</title>
  <p>Price: <span>100</span>; Stock: <span>100</span></p><p>Score: <b>10</b> / <b>10</b></p>`;
const html = `<!doctype html><meta charset="utf-8"><title>Compact snapshot</title>
  <style>body { margin: 12px; font: 16px sans-serif } button, input, a, div { display: block; margin: 8px 0 } #clicky { width: 120px; height: 28px }</style>
  <h1>Overview</h1>
  ${sections}
  <a id="next" href="/next">Next page</a>
  <a id="out" href="https://example.com/out">External</a>
  <button id="save">Save</button>
  <input id="name" aria-label="Name" value="">
  <div id="clicky" onclick="">Only click</div>
  <script>
    window.hits = {};
    document.querySelector("#save").addEventListener("click", () => { window.hits.save = (window.hits.save || 0) + 1; });
    document.querySelector("#clicky").addEventListener("click", () => { window.hits.clicky = (window.hits.clicky || 0) + 1; });
  </script>`;

async function createHarness() {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const body = pathname === "/repeated-text" ? repeatedHtml : html;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-ax-compact-"));
  let browser;
  const close = async () => {
    await browser?.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
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
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      let tabId;
      const context = { sessionId: "ax-compact", runId: "run", runProfile: { platform: { os: "linux" } } };
      const runtime = elementTestTools.createToolRuntime({
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: {
          isRunCurrent: () => true,
          resolveTargetTab: async input => input.tabId === tabId
            ? { ok: true, tabId, tab: await chrome.tabs.get(tabId), ownedByCurrentTask: true }
            : { ok: false, code: "SESSION_TAB_FOREIGN" },
          updateWorkingTab: async ({ tab }) => { tabId = tab.id; },
          listOwnedTabIds: () => tabId ? [tabId] : [],
        },
      });
      globalThis.elementHarness = {
        async call(name, args) {
          try { return await runtime.execute(name, { tabId, ...args }, undefined, { ...context, workingTabId: tabId, source: "run_script" }); }
          catch (error) { return { error: error.message, code: error.code, details: error.details }; }
        },
        async pageState() {
          return (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => ({
            ready: document.readyState,
            hits: window.hits,
            name: document.querySelector("#name")?.value || "",
          }) }))[0].result;
        },
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => elementHarness.call(name, args), { name, args });
    const state = () => worker.evaluate(() => elementHarness.pageState());
    const opened = await call("open_tab", { url: `http://127.0.0.1:${server.address().port}/` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    await expect.poll(async () => { try { return (await state()).ready; } catch { return "loading"; } }).toBe("complete");
    return { call, state, close, baseURL: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    await close();
    throw error;
  }
}

function line(snapshot, ...parts) {
  return String(snapshot || "").split("\n").find(item => parts.every(part => item.includes(part))) || "";
}

function target(snapshot, ...parts) {
  return line(snapshot, ...parts).match(/target=(uid:\S+)/)?.[1] || "";
}

test.describe("compact accessibility snapshot", () => {
  test.describe.configure({ mode: "serial", timeout: 180000 });
  let h;
  test.beforeAll(async () => { h = await createHarness(); });
  test.afterAll(async () => { await h?.close(); });

  test("puts guaranteed actions in a short-uid tree and leaves headings out", async () => {
    const result = await h.call("get_ax_tree", {});
    expect(result.code, JSON.stringify(result)).toBeUndefined();
    expect(result).not.toHaveProperty("actions");
    expect(result).not.toHaveProperty("headings");
    expect(result.snapshot).not.toContain("InlineTextBox");
    for (const item of result.snapshot.split("\n")) {
      if (item.includes("StaticText")) expect(item).toMatch(/"[^"]+"|value=|\bchecked\b|\bdisabled\b|\beditable\b/);
    }
    expect(target(result.snapshot, "button", '"Save"')).toMatch(/^uid:t\d+\.[0-9a-z]{6}\.\d+$/);
    expect(line(result.snapshot, "RootWebArea")).toMatch(/url="http:\/\/127\.0\.0\.1:\d+\/"/);
    expect(line(result.snapshot, "Next page")).toMatch(/url="http:\/\/127\.0\.0\.1:\d+\/next"/);
    expect(line(result.snapshot, "External")).toContain('url="https://example.com/out"');
    const limited = await h.call("get_ax_tree", { limit: 20 });
    expect(limited.code, JSON.stringify(limited)).toBeUndefined();
    expect(limited.snapshot).toMatch(/\(truncated, \d+ more\)/);
    expect(limited.snapshot).toContain('"Save"');
    expect(limited.snapshot).toContain("Only click");
  });

  test("clicks and fills through the short uid", async () => {
    const result = await h.call("get_ax_tree", {});
    const save = target(result.snapshot, "button", '"Save"');
    const clicked = await h.call("act_on_element", { target: save, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect((await h.state()).hits.save).toBe(1);
    const name = target(result.snapshot, "textbox", '"Name"');
    const filled = await h.call("act_on_element", { target: name, action: "fill", value: "Ada" });
    expect(filled, JSON.stringify(filled)).not.toHaveProperty("code");
    expect((await h.state()).name).toBe("Ada");
    const clicky = target(result.snapshot, "Only click");
    expect(clicky, result.snapshot).toMatch(/^uid:t/);
    const extra = await h.call("act_on_element", { target: clicky, action: "click" });
    expect(extra, JSON.stringify(extra)).not.toHaveProperty("code");
    expect((await h.state()).hits.clicky).toBe(1);
  });

  test("keeps same-named sibling StaticText for repeated values", async () => {
    const opened = await h.call("open_tab", { url: `${h.baseURL}/repeated-text` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    await expect.poll(async () => { try { return (await h.state()).ready; } catch { return "loading"; } }).toBe("complete");
    const result = await h.call("get_ax_tree", {});
    expect(result.code, JSON.stringify(result)).toBeUndefined();
    expect(result.outlineTruncated, result.snapshot).toBe(false);
    expect(result.snapshot).not.toContain("InlineTextBox");
    const texts = result.snapshot.split("\n").filter(item => item.includes("StaticText")).map(item => item.match(/StaticText "([^"]*)"/)?.[1]);
    expect(texts, result.snapshot).toEqual(["Price:", "100", "; Stock:", "100", "Score:", "10", "/", "10"]);
  });
});

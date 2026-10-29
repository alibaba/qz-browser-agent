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
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const body = pathname === "/band" ? await readFile(new URL("../fixtures/ax-snapshot/viewport-band.html", import.meta.url), "utf8")
      : pathname === "/folds" ? await readFile(new URL("../fixtures/ax-snapshot/viewport-folds.html", import.meta.url), "utf8")
      : pathname === "/repeated-text" ? repeatedHtml : html;
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
    const result = await h.call("get_ax_tree", { scope: "full" });
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
    const limited = await h.call("get_ax_tree", { scope: "full", limit: 20 });
    expect(limited.code, JSON.stringify(limited)).toBeUndefined();
    expect(limited.snapshot).toMatch(/\(truncated, \d+ more\)/);
    expect(limited.snapshot).toContain('"Save"');
    expect(limited.snapshot).toContain("Only click");
  });

  test("clicks and fills through the short uid", async () => {
    const result = await h.call("get_ax_tree", { scope: "full" });
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

  test("filters vertically before BFS and changes counts after scrolling", async () => {
    await h.call("open_tab", { url: h.baseURL });
    const top = await h.call("get_ax_tree", {});
    expect(top.scope).toBe("viewport");
    expect(top.viewportOmitted.above).toBe(0);
    expect(top.snapshot).not.toContain("↑");
    expect(top.viewportOmitted.below).toBeGreaterThan(0);
    expect(top.snapshot).not.toContain('"Save"');
    expect(top.snapshot).toContain("↓");
    const full = await h.call("get_ax_tree", { scope: "full" });
    const save = target(full.snapshot, "button", '"Save"');
    const scrolled = await h.call("act_on_element", { target: save, action: "scroll" });
    expect(scrolled, JSON.stringify(scrolled)).not.toHaveProperty("code");
    const bottom = await h.call("get_ax_tree", {});
    expect(bottom.viewportOmitted.above).toBeGreaterThan(0);
    expect(bottom.snapshot).toContain('"Save"');
    expect(target(bottom.snapshot, '"Section 1"')).toMatch(/^uid:/);
    const subtree = await h.call("get_ax_tree", { root: "css:body" });
    expect(subtree.scope).toBe("full");
    expect(subtree.snapshot).toContain('"Section 1"');
  });

  test("keeps partial intersections and horizontal overflow with structural ancestors", async () => {
    await h.call("open_tab", { url: `${h.baseURL}/band` });
    const result = await h.call("get_ax_tree", {});
    for (const name of ["Top intersection", "Bottom intersection", "Horizontal overflow", "Visible descendant", "Frame visible"]) {
      expect(target(result.snapshot, name), result.snapshot).toMatch(/^uid:/);
    }
    expect(result.snapshot).not.toContain("Above band");
    expect(result.snapshot).not.toContain("Below band");
    expect(result.snapshot).not.toContain("Frame below");
    expect(target(result.snapshot, "Off-band ancestor")).toMatch(/^uid:/);
    expect(result.viewportOmitted.above).toBeGreaterThan(0);
    expect(result.viewportOmitted.below).toBeGreaterThan(0);
  });

  test("keeps fixed and sticky controls after scrolling", async () => {
    await h.call("open_tab", { url: `${h.baseURL}/band` });
    const top = await h.call("get_ax_tree", {});
    const full = await h.call("get_ax_tree", { scope: "full" });
    await h.call("act_on_element", { target: target(full.snapshot, "Below band"), action: "scroll" });
    const bottom = await h.call("get_ax_tree", {});
    expect(bottom.viewportOmitted.above).toBeGreaterThan(0);
    for (const name of ["Fixed header", "Fixed footer", "Sticky header"]) {
      expect(target(top.snapshot, name), top.snapshot).toMatch(/^uid:/);
      expect(target(bottom.snapshot, name), bottom.snapshot).toMatch(/^uid:/);
    }
  });

  test("keeps off-screen structure in tree order with local folds and working subtree UIDs", async () => {
    await h.call("open_tab", { url: `${h.baseURL}/folds` });
    const result = await h.call("get_ax_tree", {});
    const list = target(result.snapshot, "list", "items=7");
    expect(list, result.snapshot).toMatch(/^uid:/);
    expect(target(result.snapshot, "About this article"), result.snapshot).toMatch(/^uid:/);
    expect(result.snapshot).not.toContain("ORBIT-7");
    expect(result.snapshot).not.toContain("MEADOW-57");
    const boundary = result.snapshot.indexOf(`root="${list}"`);
    expect(boundary).toBeGreaterThan(result.snapshot.indexOf("First visible card"));
    expect(boundary).toBeLessThan(result.snapshot.indexOf("About this article"));
    const listSubtree = await h.call("get_ax_tree", { root: list });
    expect(listSubtree.scope).toBe("full");
    expect(listSubtree.snapshot, JSON.stringify(listSubtree)).toContain("ORBIT-7");
    const afterAbout = result.snapshot.slice(result.snapshot.indexOf("About this article"));
    const section = afterAbout.match(/root="(uid:[^"]+)"/)?.[1];
    expect(section, result.snapshot).toMatch(/^uid:/);
    const aboutSubtree = await h.call("get_ax_tree", { root: section });
    expect(aboutSubtree.snapshot, JSON.stringify(aboutSubtree)).toContain("MEADOW-57");
    await h.call("act_on_element", { target: section, action: "scroll" });
    const scrolled = await h.call("get_ax_tree", {});
    expect(scrolled.viewportOmitted.above).toBeGreaterThan(0);
    expect(scrolled.snapshot).toContain('scope:"full"');
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

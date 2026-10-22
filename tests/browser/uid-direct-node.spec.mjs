import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const html = `<!doctype html><meta charset="utf-8"><title>Direct node</title>
  <style>
    body { margin: 12px; font: 16px sans-serif }
    button, input { display: block; margin: 8px 0; min-height: 28px }
    #covered { width: 48px; height: 48px; display: block }
    #cover { position: absolute; left: 0; top: 0; width: 80px; height: 80px; background: blue }
    #scope { border: 1px solid black; padding: 8px }
  </style>
  <section id="scope" role="region" aria-label="Scope">INSIDE-TOKEN<button id="inside">Inside</button></section>
  <p id="outside">OUTSIDE-TOKEN</p>
  <div id="mixed">Save <i>now</i></div>
  <button id="save">Save text</button>
  <button class="dup" id="dup-a">First duplicate</button>
  <button class="dup" id="dup-b">Second duplicate</button>
  <button id="swap">Swap</button>
  <button id="stay">Stay</button>
  <button id="reconnect">Reconnect</button>
  <form id="rich-form"><div id="rich" contenteditable="true"><b id="child">old rich</b></div><button type="submit">Go</button></form>
  <input id="when" type="date" aria-label="When">
  <input id="plain" aria-label="Plain" value="old">
  <select id="pick" aria-label="Pick"><option value="one">one</option><option value="two">two</option></select>
  <div id="closed"></div>
  <div id="open"></div>
  <img id="blob" alt="Blob picture" width="32" height="32">
  <div style="position:relative;width:80px;height:80px"><img id="covered" alt="Covered picture"><div id="cover"></div></div>
  <iframe id="frame" title="Child frame"></iframe>
  <script>
    window.hits = {};
    window.submits = 0;
    window.enters = 0;
    for (const id of ["save", "dup-a", "dup-b", "swap", "stay", "reconnect", "inside"]) {
      const button = document.getElementById(id);
      button.addEventListener("click", () => { window.hits[id] = (window.hits[id] || 0) + 1; });
    }
    document.querySelector("#rich-form").addEventListener("submit", event => { event.preventDefault(); window.submits += 1; });
    document.querySelector("#rich").addEventListener("keydown", event => { if (event.key === "Enter") window.enters += 1; });
    const closed = document.querySelector("#closed").attachShadow({ mode: "closed" });
    const shadowInput = document.createElement("input");
    shadowInput.value = "old";
    shadowInput.setAttribute("aria-label", "Shadow field");
    closed.append(shadowInput);
    window.shadowInput = shadowInput;
    const open = document.querySelector("#open").attachShadow({ mode: "open" });
    const shadowButton = document.createElement("button");
    shadowButton.id = "open-button";
    shadowButton.textContent = "Open shadow";
    shadowButton.addEventListener("click", () => { window.hits.open = (window.hits.open || 0) + 1; });
    open.append(shadowButton);
    document.querySelector("#frame").srcdoc = "<!doctype html><button id='inside-frame'>Inside frame</button>";
  </script>`;

async function createHarness() {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-direct-node-"));
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
      const context = { sessionId: "direct-node", runId: "run", runProfile: { platform: { os: "linux" } } };
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
      let debuggerAttaches = 0;
      const attach = chrome.debugger.attach.bind(chrome.debugger);
      chrome.debugger.attach = (target, version) => {
        debuggerAttaches += 1;
        return attach(target, version);
      };
      globalThis.elementHarness = {
        attaches: () => debuggerAttaches,
        async call(name, args, signal) {
          try { return await runtime.execute(name, { tabId, ...args }, signal, { ...context, workingTabId: tabId, source: "run_script" }); }
          catch (error) { return { error: error.message, code: error.code, details: error.details }; }
        },
        async detach() {
          try { await chrome.debugger.detach({ tabId }); return { detached: true }; }
          catch (error) { return { error: error.message }; }
        },
        async pageState() {
          return (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => ({
            ready: document.readyState,
            url: location.href,
            hits: window.hits,
            submits: window.submits,
            enters: window.enters,
            rich: document.querySelector("#rich")?.innerText || "",
            when: document.querySelector("#when")?.value || "",
            plain: document.querySelector("#plain")?.value || "",
            pick: document.querySelector("#pick")?.value || "",
            shadow: window.shadowInput ? window.shadowInput.value : "",
          }) }))[0].result;
        },
      };
    });
    const call = (name, args, signal) => worker.evaluate(
      ({ name, args, aborted }) => {
        const controller = new AbortController();
        if (aborted) controller.abort();
        return elementHarness.call(name, args, controller.signal);
      },
      { name, args, aborted: signal?.aborted === true },
    );
    const state = () => worker.evaluate(() => elementHarness.pageState());
    const opened = await call("open_tab", { url: `http://127.0.0.1:${server.address().port}/` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    const page = browser.pages().find(item => item.url().startsWith("http://127.0.0.1:"));
    await expect.poll(async () => { try { return (await state()).ready; } catch { return "loading"; } }).toBe("complete");
    return {
      call, state, close, page, worker,
      attaches: () => worker.evaluate(() => elementHarness.attaches()),
      detach: () => worker.evaluate(() => elementHarness.detach()),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function targets(snapshot, ...parts) {
  return String(snapshot || "").split("\n")
    .filter(line => parts.every(part => line.includes(part)))
    .map(line => line.match(/target=(uid:\S+)/)?.[1])
    .filter(Boolean);
}

async function tree(h) {
  let last;
  await expect.poll(async () => {
    last = await h.call("get_ax_tree", {});
    return last.snapshot || last.code || "";
  }, { timeout: 15000 }).toContain("target=uid:");
  expect(last, JSON.stringify(last)).not.toHaveProperty("code");
  return last;
}

async function paint(page, id, color) {
  await page.evaluate(async ({ id, color }) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 32, 32);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const image = document.querySelector(id);
    image.src = URL.createObjectURL(blob);
    await image.decode();
  }, { id, color });
}

async function sample(page, dataUrl) {
  return page.evaluate(async url => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const [r, g, b] = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return { r, g, b };
  }, dataUrl);
}

test.describe("uid resolves the original node", () => {
  test.describe.configure({ mode: "serial", timeout: 180000 });
  let h;
  test.beforeAll(async () => { h = await createHarness(); });
  test.afterAll(async () => { await h?.close(); });

  test("css read and write do not attach the debugger", async () => {
    await h.detach();
    const before = await h.attaches();
    const inspected = await h.call("inspect_element", { target: "css:#save" });
    expect(inspected.code, JSON.stringify(inspected)).toBeUndefined();
    expect(JSON.stringify(inspected)).toContain("Save");
    const dom = await h.call("read_dom", { selector: "css:#scope" });
    expect(dom.content, JSON.stringify(dom)).toContain("INSIDE-TOKEN");
    const article = await h.call("read_article", { selector: "css:#scope", source: "selector", limit: 4000 });
    expect(article.text, JSON.stringify(article)).toContain("INSIDE-TOKEN");
    const found = await h.call("find_elements", { selector: "css:#save", pattern: "Save text" });
    expect(found.matches ?? found.results?.length, JSON.stringify(found)).not.toBe(0);
    const selected = await h.call("act_on_element", { target: "css:#pick", action: "select", value: "two" });
    expect(selected.code, JSON.stringify(selected)).toBeUndefined();
    expect((await h.state()).pick).toBe("two");
    expect(await h.attaches()).toBe(before);
  });

  test("a text-node uid operates on the owning element", async () => {
    const snapshot = (await tree(h)).snapshot;
    const textUid = targets(snapshot, "StaticText", "Save")[0];
    expect(textUid, snapshot).toBeTruthy();
    const inspected = await h.call("inspect_element", { target: textUid });
    expect(inspected.code, JSON.stringify(inspected)).not.toBe("STALE_ELEMENT_UID");
    expect(JSON.stringify(inspected)).toContain("Save");
    const buttonUid = targets(snapshot, "button", "Save text")[0];
    const clicked = await h.call("act_on_element", { target: buttonUid, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect((await h.state()).hits.save).toBe(1);
  });

  test("scoped reads stay on the bound node", async () => {
    const snapshot = (await tree(h)).snapshot;
    const scope = targets(snapshot, "Scope")[0];
    expect(scope, snapshot).toBeTruthy();
    const dom = await h.call("read_dom", { selector: scope });
    expect(dom.content, JSON.stringify(dom)).toContain("INSIDE-TOKEN");
    expect(dom.content).not.toContain("OUTSIDE-TOKEN");
    const found = await h.call("find_elements", { selector: scope, pattern: "OUTSIDE-TOKEN" });
    expect(found.matches, JSON.stringify(found)).toBe(0);
    const article = await h.call("read_article", { selector: scope, source: "selector", limit: 4000 });
    expect(article.text, JSON.stringify(article)).toContain("INSIDE-TOKEN");
    expect(article.text).not.toContain("OUTSIDE-TOKEN");
    const images = await h.call("list_images", { selector: scope });
    expect(images.images, JSON.stringify(images)).toEqual([]);
  });

  test("blob and covered images are read from the element", async () => {
    await paint(h.page, "#blob", "#00ff00");
    await paint(h.page, "#covered", "#ff0000");
    const listed = await h.call("list_images", {});
    expect(listed, JSON.stringify(listed)).not.toHaveProperty("code");
    const blob = listed.images.find(item => item.alt === "Blob picture");
    const covered = listed.images.find(item => item.alt === "Covered picture");
    expect(blob?.target).toMatch(/^uid:/);
    expect(covered?.target).toMatch(/^uid:/);
    const blobRead = await h.call("read_image", { target: blob.target });
    expect(blobRead.code, JSON.stringify(blobRead)).not.toBe("UNSUPPORTED_IMAGE_URL_SCHEME");
    expect(String(blobRead.method || "")).toContain("canvas");
    expect(await sample(h.page, blobRead.dataUrl || blobRead._image)).toMatchObject({ g: expect.any(Number) });
    const blobPixel = await sample(h.page, blobRead.dataUrl || blobRead._image);
    expect(blobPixel.g).toBeGreaterThan(200);
    expect(blobPixel.r).toBeLessThan(40);
    const collected = await h.call("collect_images", { table: "direct_node_images", targets: [blob.target] });
    expect(JSON.stringify(collected)).not.toContain("UNSUPPORTED_IMAGE_URL_SCHEME");
    expect(collected.code, JSON.stringify(collected)).toBeUndefined();
    const coveredRead = await h.call("read_image", { target: covered.target });
    expect(String(coveredRead.method || "")).toContain("canvas");
    const coveredPixel = await sample(h.page, coveredRead.dataUrl || coveredRead._image);
    expect(coveredPixel.r).toBeGreaterThan(200);
    expect(coveredPixel.b).toBeLessThan(40);
    const shot = await h.call("screenshot", { target: blob.target });
    expect(shot, JSON.stringify(shot)).not.toHaveProperty("code");
    expect(shot.dataUrl || shot._image).toBeTruthy();
    const [left, right] = await Promise.all([
      h.call("read_image", { target: blob.target }),
      h.call("read_image", { target: covered.target }),
    ]);
    const leftPixel = await sample(h.page, left.dataUrl || left._image);
    const rightPixel = await sample(h.page, right.dataUrl || right._image);
    expect(leftPixel.g, JSON.stringify(left)).toBeGreaterThan(200);
    expect(leftPixel.r).toBeLessThan(40);
    expect(rightPixel.r, JSON.stringify(right)).toBeGreaterThan(200);
    expect(rightPixel.b).toBeLessThan(40);
  });

  test("closed-shadow focus, date fill, and rich-text child readback keep the existing editors", async () => {
    const snapshot = (await tree(h)).snapshot;
    const shadow = targets(snapshot, "Shadow field")[0];
    expect(shadow, snapshot).toBeTruthy();
    const filled = await h.call("act_on_element", { target: shadow, action: "fill", value: "shadow-ok" });
    expect(filled.code, JSON.stringify(filled)).not.toBe("ELEMENT_FOCUS_FAILED");
    expect(filled.code).not.toBe("NOT_EDITABLE_ELEMENT");
    expect(await h.page.evaluate(() => document.querySelector("#closed").shadowRoot)).toBeNull();
    expect((await h.state()).shadow).toBe("shadow-ok");
    const date = await h.call("act_on_element", { target: "css:#when", action: "fill", value: "2026-10-22" });
    expect(date.code, JSON.stringify(date)).not.toBe("NOT_EDITABLE_ELEMENT");
    expect((await h.state()).when).toBe("2026-10-22");
    const rich = await h.call("act_on_element", { target: "css:#child", action: "fill", value: "replaced rich", submit: true });
    expect(rich.code, JSON.stringify(rich)).not.toBe("INPUT_RESULT_UNKNOWN");
    expect(rich.filled).toBe(true);
    expect(rich.submitDispatched).toBe(true);
    expect(rich.value).toContain("replaced rich");
    expect((await h.state()).rich).toContain("replaced rich");
  });

  test("css index defaults to the first match and an explicit index hits its own element", async () => {
    const first = await h.call("act_on_element", { target: "css:button.dup", action: "click" });
    const second = await h.call("act_on_element", { target: "css:button.dup", index: 1, action: "click" });
    expect(first, JSON.stringify(first)).not.toHaveProperty("code");
    expect(second, JSON.stringify(second)).not.toHaveProperty("code");
    const hits = (await h.state()).hits;
    expect(hits["dup-a"]).toBe(1);
    expect(hits["dup-b"]).toBe(1);
  });

  test("replacing the node or reloading the same url invalidates the uid", async () => {
    const before = await tree(h);
    const swap = targets(before.snapshot, "button", "Swap")[0];
    const stay = targets(before.snapshot, "button", "Stay")[0];
    await h.page.evaluate(() => {
      const old = document.querySelector("#swap");
      const next = document.createElement("button");
      next.id = "swap";
      next.textContent = "Swap";
      next.addEventListener("click", () => { window.hits.swap = (window.hits.swap || 0) + 1; });
      old.replaceWith(next);
    });
    const replaced = await h.call("act_on_element", { target: swap, action: "click" });
    expect(replaced.code).toBe("STALE_ELEMENT_UID");
    expect(replaced.error).toMatch(/page structure|页面结构|頁面結構/);
    expect((await h.state()).hits.swap || 0).toBe(0);
    const fresh = await tree(h);
    const freshSwap = targets(fresh.snapshot, "button", "Swap")[0];
    expect(freshSwap).not.toBe(swap);
    const clicked = await h.call("act_on_element", { target: freshSwap, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect((await h.state()).hits.swap).toBe(1);
    const url = (await h.state()).url;
    await h.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await h.state()).ready).toBe("complete");
    expect((await h.state()).url.split("#")[0]).toBe(url.split("#")[0]);
    const refreshed = await h.call("act_on_element", { target: stay, action: "click" });
    expect(refreshed.code).toBe("STALE_ELEMENT_UID");
    expect(refreshed.code).not.toBe("STALE_ELEMENT_UID_PAGE_CHANGED");
    expect((await h.state()).hits.stay || 0).toBe(0);
  });

  test("a child frame is not operated through the top-document content script", async () => {
    await h.page.locator("#frame").waitFor();
    await expect.poll(async () => h.page.frameLocator("#frame").locator("button").count()).toBe(1);
    const snapshot = (await tree(h)).snapshot;
    const inside = targets(snapshot, "Inside frame")[0];
    if (inside) {
      const rejected = await h.call("act_on_element", { target: inside, action: "click" });
      expect(rejected.code, JSON.stringify(rejected)).toBe("STALE_ELEMENT_UID");
    } else {
      expect(snapshot).toContain('Iframe "Child frame"');
    }
  });

  test("cancellation does not change the control", async () => {
    const before = (await h.state()).plain;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await h.call("act_on_element", { target: "css:#plain", action: "fill", value: "should-not-land" }, controller.signal);
    expect(cancelled.code).toBe("OPERATION_ABORTED");
    expect((await h.state()).plain).toBe(before);
  });
});

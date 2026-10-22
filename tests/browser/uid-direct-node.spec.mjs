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
    window.edits = { pick: { input: 0, change: 0 }, when: { input: 0, change: 0 } };
    for (const type of ["input", "change"]) document.addEventListener(type, event => {
      const counts = window.edits[event.target.id];
      if (counts) counts[type]++;
    });
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
    document.querySelector("#frame").srcdoc = "<!doctype html><button id='inside-frame' type='button' onclick='window.clicks=(window.clicks||0)+1'>Inside frame</button>";
  </script>`;

async function createHarness({ reloadFixture = false, secondary = false } = {}) {
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
    const contentPath = join(extension, "content/content-script.js");
    const currentContent = reloadFixture ? await readFile(contentPath, "utf8") : "";
    if (reloadFixture) {
      // A prior Content contract can answer ping without exposing the node bridge.
      manifest.version = "0.0.1";
      await writeFile(contentPath, `${currentContent}\n;globalThis.__qzInvoke = undefined;`);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    const extensions = [extension];
    if (secondary) {
      const sibling = join(directory, "idle-extension");
      await cp(await ensureTestExtension(), sibling, { recursive: true });
      const siblingManifest = JSON.parse(await readFile(join(sibling, "manifest.json"), "utf8"));
      delete siblingManifest.key; // A separate installation, enabled without a task.
      await writeFile(join(sibling, "manifest.json"), JSON.stringify(siblingManifest));
      extensions.push(sibling);
    }
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions", "--hide-scrollbars"],
      args: [`--disable-extensions-except=${extensions.join(",")}`, `--load-extension=${extensions.join(",")}`, "--no-proxy-server",
        ...(reloadFixture ? ["--enable-unsafe-extension-debugging"] : []),
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const primaryWorker = worker => worker.url().endsWith("/element-test-worker.js");
    let worker = browser.serviceWorkers().find(primaryWorker) || await browser.waitForEvent("serviceworker", { predicate: primaryWorker });
    const initializeWorker = tabId => worker.evaluate(initialTabId => {
      let tabId = initialTabId;
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
      let injections = 0;
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = args => {
        if (args.files?.includes("content/content-script.js")) injections++;
        return execute(args);
      };
      globalThis.elementHarness = {
        attaches: () => debuggerAttaches,
        injections: () => injections,
        tabId: () => tabId,
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
            edits: window.edits,
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
    }, tabId);
    await initializeWorker();
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
      async reload(version) {
        const tabId = await worker.evaluate(() => elementHarness.tabId());
        manifest.version = version;
        await writeFile(manifestPath, JSON.stringify(manifest));
        await writeFile(contentPath, currentContent);
        const nextWorker = browser.waitForEvent("serviceworker", { predicate: primaryWorker, timeout: 15000 });
        // Reload the unpacked installation through Chrome while keeping web pages alive.
        const cdp = await browser.browser().newBrowserCDPSession();
        try { await cdp.send("Extensions.loadUnpacked", { path: extension }); }
        finally { await cdp.detach(); }
        worker = await nextWorker;
        await initializeWorker(tabId);
      },
      async contexts() {
        return worker.evaluate(async () => {
          const target = { tabId: elementHarness.tabId() }, contexts = [];
          const listener = (source, method, params) => {
            if (source.tabId === target.tabId && method === "Runtime.executionContextCreated") contexts.push(params.context);
          };
          chrome.debugger.onEvent.addListener(listener);
          try {
            await chrome.debugger.sendCommand(target, "Runtime.disable");
            await chrome.debugger.sendCommand(target, "Runtime.enable");
            return await Promise.all(contexts.filter(context => context.origin.startsWith("chrome-extension://")).map(async context => {
              const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
                contextId: context.id, returnByValue: true,
                expression: "({ extensionId: chrome.runtime?.id || '', bridge: typeof globalThis.__qzInvoke === 'function' })",
              });
              return { contextId: context.id, origin: context.origin, ...result.result.value };
            }));
          } finally { chrome.debugger.onEvent.removeListener(listener); }
        });
      },
      async removeBridge() {
        return worker.evaluate(async () => {
          const tabId = elementHarness.tabId();
          await chrome.scripting.executeScript({ target: { tabId }, func: () => { delete globalThis.__qzInvoke; } });
          return { ping: await chrome.tabs.sendMessage(tabId, { action: "ping" }), injections: elementHarness.injections() };
        });
      },
      injections: () => worker.evaluate(() => elementHarness.injections()),
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

test("element screenshots and image fallbacks preserve their pixels at browser zoom after scrolling", async () => {
  test.setTimeout(120000);
  // A different port without CORS makes the DOM canvas unreadable, as on public image CDNs.
  const imageServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120">
      <path fill="red" d="M0 0h80v60H0z"/><path fill="lime" d="M80 0h80v60H80z"/>
      <path fill="blue" d="M0 60h80v60H0z"/><path fill="yellow" d="M80 60h80v60H80z"/>
    </svg>`);
  });
  await new Promise(resolve => imageServer.listen(0, "127.0.0.1", resolve));
  let h;
  try {
    h = await createHarness();
    await h.page.setContent(`<!doctype html><style>
      body { margin: 0; width: 4000px; height: 4000px; background: magenta }
      img { position: absolute; left: 420px; top: 320px; width: 160px; height: 120px }
    </style><img id="zoom-image" alt="Zoom quadrants" src="http://127.0.0.1:${imageServer.address().port}/quadrants.svg">`);
    await h.page.locator("#zoom-image").evaluate(image => image.decode());
    const listed = await h.call("list_images", {});
    const uid = listed.images?.find(image => image.alt === "Zoom quadrants")?.target;
    expect(uid, JSON.stringify(listed)).toMatch(/^uid:/);
    for (const zoom of [0.75, 1, 1.25]) {
      await h.worker.evaluate(zoom => chrome.tabs.setZoom(elementHarness.tabId(), zoom), zoom);
      for (const scrolled of [false, true]) {
        const geometry = await h.page.evaluate(async scrolled => {
          const image = document.querySelector("#zoom-image");
          image.style.left = scrolled ? "1000px" : "420px";
          image.style.top = scrolled ? "1200px" : "320px";
          window.scrollTo(scrolled ? 700 : 0, scrolled ? 900 : 0);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { scrollX, scrollY, dpr: devicePixelRatio };
        }, scrolled);
        expect(geometry.scrollX).toBe(scrolled ? 700 : 0);
        expect(geometry.scrollY).toBe(scrolled ? 900 : 0);
        for (const target of [uid, "css:#zoom-image"]) {
          for (const name of ["screenshot", "read_image"]) {
            const padding = name === "screenshot" ? 8 : 0;
            const shot = await h.call(name, { target, format: "png", ...(padding ? { padding, destination: "zoom_screenshots" } : {}) });
            const diagnostic = JSON.stringify({ zoom, scrolled, target, name, ...shot, _image: undefined, dataUrl: undefined });
            expect(shot, diagnostic).not.toHaveProperty("error");
            if (name === "read_image") expect(shot.method, diagnostic).toContain("element_screenshot_fallback:");
            const pixels = await h.page.evaluate(async dataUrl => {
              const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
              context.drawImage(bitmap, 0, 0);
              bitmap.close();
              return {
                width: canvas.width, height: canvas.height,
                corner: [...context.getImageData(0, 0, 1, 1).data],
                colors: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) =>
                  [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data]),
              };
            }, shot._image || shot.dataUrl);
            expect(pixels.colors, diagnostic).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]);
            if (padding) expect(pixels.corner, diagnostic).toEqual([255, 0, 255, 255]);
            expect(pixels.width, diagnostic).toBe(Math.round((160 + padding * 2) * geometry.dpr));
            expect(pixels.height, diagnostic).toBe(Math.round((120 + padding * 2) * geometry.dpr));
            if (padding) expect(shot.image, diagnostic).toMatchObject({
              width: pixels.width, height: pixels.height, naturalWidth: pixels.width, naturalHeight: pixels.height,
            });
          }
        }
      }
    }
  } finally {
    await h?.close();
    imageServer.closeAllConnections?.();
    await new Promise(resolve => imageServer.close(resolve));
  }
});

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

  test("the root uid expands the accessibility tree", async () => {
    const snapshot = (await tree(h)).snapshot;
    const rootUid = targets(snapshot, "RootWebArea")[0];
    expect(rootUid, snapshot).toBeTruthy();
    const expanded = await h.call("get_ax_tree", { root: rootUid });
    expect(expanded.code, JSON.stringify(expanded)).not.toBe("STALE_ELEMENT_UID");
    expect(expanded.rootFound, JSON.stringify(expanded)).toBe(true);
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

  test("a list_images uid does not read a replaced image", async () => {
    await paint(h.page, "#blob", "#00ff00");
    const listed = await h.call("list_images", { selector: "#blob" });
    expect(listed.code, JSON.stringify(listed)).toBeUndefined();
    const image = listed.images.find(item => item.alt === "Blob picture");
    expect(image?.target, JSON.stringify(listed)).toMatch(/^uid:/);
    const before = await h.call("read_image", { target: image.target });
    expect(before.code, JSON.stringify(before)).toBeUndefined();
    const beforePixel = await sample(h.page, before.dataUrl || before._image);
    expect(beforePixel.g).toBeGreaterThan(200);
    expect(beforePixel.r).toBeLessThan(40);
    await paint(h.page, "#blob", "#ff0000");
    const after = await h.call("read_image", { target: image.target });
    expect(after.code, JSON.stringify(after)).toBe("STALE_IMAGE_TARGET");
    expect(after._image || after.dataUrl).toBeFalsy();
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

  test("a shadow subtree button is not bound to the outer button with the same id", async () => {
    await h.page.evaluate(() => {
      const outer = document.createElement("button");
      outer.id = "shadow-save";
      outer.textContent = "Outer save";
      outer.addEventListener("click", () => { window.hits.outer = (window.hits.outer || 0) + 1; });
      const host = document.createElement("div");
      host.id = "shadow-panel-host";
      const root = host.attachShadow({ mode: "open" });
      const region = document.createElement("div");
      region.setAttribute("role", "region");
      region.setAttribute("aria-label", "Panel");
      const inner = document.createElement("button");
      inner.id = "shadow-save";
      inner.textContent = "Inner save";
      inner.addEventListener("click", () => { window.hits.inner = (window.hits.inner || 0) + 1; });
      region.append(inner);
      root.append(region);
      document.body.append(outer, host);
    });
    const page = await h.call("get_ax_tree", {});
    expect(page.code, JSON.stringify(page)).toBeUndefined();
    const region = targets(page.snapshot, "region", "Panel")[0];
    expect(region, page.snapshot).toBeTruthy();
    const sub = await h.call("get_ax_tree", { root: region });
    expect(sub.code, JSON.stringify(sub)).toBeUndefined();
    const buttons = targets(sub.snapshot, "button", "Inner save");
    expect(buttons, sub.snapshot).toHaveLength(1);
    const clicked = await h.call("act_on_element", { target: buttons[0], action: "click" });
    expect(clicked.code, JSON.stringify(clicked)).toBeUndefined();
    const inspected = await h.call("inspect_element", { target: buttons[0] });
    expect(inspected.code, JSON.stringify(inspected)).toBeUndefined();
    expect(inspected.text, JSON.stringify(inspected)).toContain("Inner save");
    expect(inspected.text).not.toContain("Outer save");
    const hits = (await h.state()).hits;
    expect(hits.inner).toBe(1);
    expect(hits.outer || 0).toBe(0);
  });

  test("a list_images uid dies when the same url reloads", async () => {
    const listed = await h.call("list_images", { selector: "#blob" });
    expect(listed.code, JSON.stringify(listed)).toBeUndefined();
    const image = listed.images.find(item => item.alt === "Blob picture");
    expect(image?.target, JSON.stringify(listed)).toMatch(/^uid:/);
    const before = await h.call("read_image", { target: image.target });
    expect(before.code, JSON.stringify(before)).toBeUndefined();
    const url = (await h.state()).url;
    await h.page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await h.state()).ready).toBe("complete");
    expect((await h.state()).url.split("#")[0]).toBe(url.split("#")[0]);
    const after = await h.call("read_image", { target: image.target });
    expect(after.code).toBe("STALE_ELEMENT_UID");
    expect(after.code).not.toBe("STALE_ELEMENT_UID_PAGE_CHANGED");
  });

  test("duplicate image ids stay readable", async () => {
    await h.page.evaluate(() => {
      const root = document.createElement("div");
      root.id = "dup-pics";
      const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      for (const alt of ["First pic", "Second pic"]) {
        const image = document.createElement("img");
        image.id = "pic";
        image.alt = alt;
        image.width = 40;
        image.height = 40;
        image.src = pixel;
        image.addEventListener("click", () => {
          const key = alt === "First pic" ? "pic1" : "pic2";
          window.hits[key] = (window.hits[key] || 0) + 1;
        });
        root.append(image);
      }
      document.body.append(root);
    });
    const listed = await h.call("list_images", { selector: "#dup-pics" });
    expect(listed.code, JSON.stringify(listed)).toBeUndefined();
    const images = listed.images.filter(item => item.alt === "First pic" || item.alt === "Second pic");
    expect(images.map(item => item.alt).sort()).toEqual(["First pic", "Second pic"]);
    for (const image of images) {
      const inspected = await h.call("inspect_element", { target: image.target });
      expect(inspected.code, JSON.stringify(inspected)).not.toBe("STALE_ELEMENT_UID");
      expect(inspected.tag, JSON.stringify(inspected)).toBe("img");
      expect(inspected.name || inspected.attrs?.alt).toBe(image.alt);
      const clicked = await h.call("act_on_element", { target: image.target, action: "click" });
      expect(clicked.code, JSON.stringify(clicked)).not.toBe("STALE_ELEMENT_UID");
    }
    const hits = (await h.state()).hits;
    expect(hits.pic1).toBe(1);
    expect(hits.pic2).toBe(1);
  });

  test("a shallow snapshot clicks each duplicate-id button", async () => {
    await h.page.evaluate(() => {
      const root = document.createElement("div");
      root.id = "deep-dups";
      root.innerHTML = `
        <section><div><p><button id="same" class="same">Alpha</button></p></div></section>
        <section><div><p><button id="same" class="same">Beta</button></p></div></section>`;
      document.body.append(root);
      const [alpha, beta] = root.querySelectorAll("button");
      alpha.addEventListener("click", () => { window.hits.alpha = (window.hits.alpha || 0) + 1; });
      beta.addEventListener("click", () => { window.hits.beta = (window.hits.beta || 0) + 1; });
    });
    const snapshot = await h.call("get_ax_tree", { depth: 1, limit: 8 });
    expect(snapshot.code, JSON.stringify(snapshot)).toBeUndefined();
    const alpha = targets(snapshot.snapshot, "button", "Alpha")[0];
    const beta = targets(snapshot.snapshot, "button", "Beta")[0];
    expect(alpha, snapshot.snapshot).toBeTruthy();
    expect(beta, snapshot.snapshot).toBeTruthy();
    expect(alpha).not.toBe(beta);
    const first = await h.call("act_on_element", { target: alpha, action: "click" });
    const second = await h.call("act_on_element", { target: beta, action: "click" });
    expect(first, JSON.stringify(first)).not.toHaveProperty("code");
    expect(second, JSON.stringify(second)).not.toHaveProperty("code");
    const hits = (await h.state()).hits;
    expect(hits.alpha).toBe(1);
    expect(hits.beta).toBe(1);
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

  test("a direct child frame element is clicked through its uid", async () => {
    test.setTimeout(120000);
    await h.page.locator("#frame").waitFor();
    await expect.poll(async () => h.page.frameLocator("#frame").locator("button").count()).toBe(1);
    let inside = "";
    await expect.poll(async () => {
      inside = targets((await tree(h)).snapshot, "Inside frame")[0] || "";
      return inside;
    }, { timeout: 20000 }).not.toBe("");
    const clicked = await h.call("act_on_element", { target: inside, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect(clicked.inputDelivered).toBe(true);
    expect(await h.page.evaluate(() => document.querySelector("#frame").contentWindow.clicks)).toBe(1);
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

async function expectSingleCssEdits(h, step) {
  const before = (await h.state()).edits;
  const value = step % 2 ? "one" : "two";
  const date = `2026-10-${step % 2 ? "21" : "22"}`;
  expect(await h.call("act_on_element", { target: "css:#pick", action: "select", value })).not.toHaveProperty("code");
  expect(await h.call("act_on_element", { target: "css:#when", action: "fill", value: date })).not.toHaveProperty("code");
  const after = await h.state();
  expect(after.pick).toBe(value);
  expect(after.when).toBe(date);
  for (const id of ["pick", "when"]) {
    expect(after.edits[id]).toEqual({ input: before[id].input + 1, change: before[id].change + 1 });
  }
}

for (const secondary of [false, true]) test(`UID survives Content upgrade and reload without refreshing the page (idle sibling: ${secondary})`, async () => {
  test.setTimeout(180000);
  const h = await createHarness({ reloadFixture: true, secondary });
  try {
    const origin = await h.page.evaluate(() => performance.timeOrigin);
    await paint(h.page, "#blob", "#00ff00");
    let clicks = 0;
    for (const version of ["0.0.2", "0.0.2"]) {
      await h.reload(version);
      expect(await h.page.evaluate(() => performance.timeOrigin)).toBe(origin);
      const snapshot = (await tree(h)).snapshot;
      const target = targets(snapshot, "button", "Save text")[0];
      const contexts = await h.contexts();
      expect(contexts.some(context => !context.extensionId), JSON.stringify(contexts)).toBe(true);
      expect(contexts.some(context => context.extensionId && context.bridge), JSON.stringify(contexts)).toBe(true);
      expect(new Set(contexts.map(context => context.origin)).size).toBe(secondary ? 2 : 1);
      // The second reload must exclude an invalidated context even though its old bridge remains.
      if (clicks) expect(contexts.some(context => !context.extensionId && context.bridge), JSON.stringify(contexts)).toBe(true);
      expect(await h.call("inspect_element", { target })).not.toHaveProperty("code");
      expect(await h.call("act_on_element", { target, action: "click" })).not.toHaveProperty("code");
      expect((await h.state()).hits.save).toBe(++clicks);
      const images = await h.call("list_images", {});
      const image = images.images.find(item => item.alt === "Blob picture");
      const read = await h.call("read_image", { target: image.target });
      expect(read.code, JSON.stringify(read)).toBeUndefined();
      expect((await sample(h.page, read.dataUrl || read._image)).g).toBeGreaterThan(200);
      expect(await h.call("inspect_element", { target: "css:#save" })).not.toHaveProperty("code");
      await expectSingleCssEdits(h, clicks);
      for (let recovery = 0; recovery < 2; recovery++) {
        const missing = await h.removeBridge();
        expect(missing.ping.ok).toBe(true);
        expect(await h.call("act_on_element", { target, action: "click" })).not.toHaveProperty("code");
        expect((await h.state()).hits.save).toBe(++clicks);
        expect(await h.injections()).toBe(missing.injections + 1);
        await expectSingleCssEdits(h, clicks);
      }
    }
  } finally { await h.close(); }
});

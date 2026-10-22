import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Element input fixture</title>
  <style>body{margin:12px}input,textarea,[contenteditable]{display:block;margin:8px 0;min-height:24px}input[type=checkbox],input[type=radio]{width:24px;height:24px}label{display:block;width:180px;min-height:40px;margin:8px 0}label>a,label>button{display:block;width:180px;height:40px}</style>
  <form><input id="text" value="old"><input id="controlled" value="old"><input id="uppercase" value="old">
    <input id="required" required value="valid"><button>Submit</button></form>
  <textarea id="textarea">old</textarea><div id="rich" contenteditable="true"><b>old rich text</b></div>
  <input id="readonly" readonly value="readonly"><input id="disabled" disabled value="disabled">
  <input id="refuses" value="refuses"><input id="redirects" value="old"><input id="sink" value="untouched">
  <input id="checkbox" type="checkbox"><input id="rollback" type="checkbox"><input id="cancelled" type="checkbox">
  <input id="disabled-check" type="checkbox" disabled><input id="radio" type="radio" checked>
  <input id="hidden-check" type="checkbox" style="display:none"><label id="hidden-label" for="hidden-check">Hidden checkbox</label>
  <input id="hidden-disabled" type="checkbox" style="display:none" disabled><label id="disabled-label" for="hidden-disabled">Disabled checkbox</label>
  <input id="link-check" type="checkbox" style="display:none"><label for="link-check"><a id="label-link" href="#unexpected">Another destination</a></label>
  <input id="button-check" type="checkbox" style="display:none"><label for="button-check"><button id="label-button" type="button">Other action</button></label>
  <script>
    window.events=[];window.submits=0;window.invalid=0;window.acceptedValue='old';window.blockEnter=false;
    for(const type of ['beforeinput','input','change','keydown','click','touchstart','touchend']) document.addEventListener(type,event=>{
      events.push({type,id:event.target.id,key:event.key||'',trusted:event.isTrusted});
    },true);
    document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();submits++});
    document.querySelector('#required').addEventListener('invalid',()=>invalid++);
    document.querySelector('#text').addEventListener('keydown',event=>{if(blockEnter&&event.key==='Enter')event.preventDefault()});
    document.querySelector('#controlled').addEventListener('input',event=>{acceptedValue=event.target.value});
    document.querySelector('#uppercase').addEventListener('input',event=>{event.target.value=event.target.value.toUpperCase()});
    document.querySelector('#refuses').addEventListener('focus',()=>document.querySelector('#sink').focus());
    document.querySelector('#redirects').addEventListener('input',()=>document.querySelector('#sink').focus());
    document.querySelector('#rollback').addEventListener('change',event=>{requestAnimationFrame(()=>{event.target.checked=false})});
    document.querySelector('#cancelled').addEventListener('click',event=>event.preventDefault());
  </script>`;

// Use the real extension's tool composition and Chrome debugger transport, as in page-mode.spec.
async function createHarness(mode, launchOptions = {}) {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-element-actions-"));
  let browser;
  const close = async () => {
    await browser?.close(); server.closeAllConnections();
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
      ...launchOptions,
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      let tabId;
      const context = { sessionId: "element-test", runId: "run", runProfile: { platform: { os: "linux" } } };
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
        command: (method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
        screen(name, args) { return this.call(name, { tabId, ...args }, "run_script"); },
        async call(name, args, source) {
          try { return await runtime.execute(name, args, undefined, { ...context, workingTabId: tabId, source }); }
          catch (error) { return { error: error.message, code: error.code, details: error.details }; }
        },
        async state() {
          return (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => ({
            ready: document.readyState, url: location.href, events, submits, invalid, acceptedValue,
            richRaw: document.querySelector('#rich').textContent,
            values: Object.fromEntries([...document.querySelectorAll('input,textarea,[contenteditable]')].map(el => [el.id, el.isContentEditable ? el.innerText : el.value])),
            checks: Object.fromEntries([...document.querySelectorAll('input[type=checkbox],input[type=radio]')].map(el => [el.id, el.checked])),
          }) }))[0].result;
        },
        async blockEnter() { await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => { window.blockEnter = true; } }); },
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => elementHarness.call(name, args), { name, args });
    const state = () => worker.evaluate(() => elementHarness.state());
    const opened = await call("open_tab", { url: `http://127.0.0.1:${server.address().port}/`, mode });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    await expect.poll(async () => { try { return (await state()).ready; } catch { return "loading"; } }).toBe("complete");
    return { state, close, worker, page: browser.pages().find(page => page.url().startsWith('http://127.0.0.1:')),
      command: (method, params) => worker.evaluate(({ method, params }) => elementHarness.command(method, params), { method, params }),
      screen: (name, args) => worker.evaluate(({ name, args }) => elementHarness.screen(name, args), { name, args }),
      blockEnter: () => worker.evaluate(() => elementHarness.blockEnter()),
      act: (id, action, options = {}) => call("act_on_element", { target: `css:#${id}`, action, ...options }) };
  } catch (error) { await close(); throw error; }
}

test('first screenshot stays actionable after the debugger infobar expands', async ({ headless }) => {
  const h = await createHarness('desktop', {
    headless, viewport: null,
    ignoreDefaultArgs: ['--disable-extensions', '--hide-scrollbars', '--enable-automation'],
  });
  try {
    await h.page.setContent(`<style>body{margin:0;overflow:hidden}input{position:fixed;left:50%;top:30%;transform:translate(-50%,-50%);width:200px;height:36px}</style><input>`);
    const shot = await h.screen('screenshot', { actionable: true });
    expect(shot).not.toHaveProperty('error');
    // Let the real browser chrome finish any remaining animation before using the original image.
    await h.page.waitForTimeout(300);
    const typed = await h.worker.evaluate(args => elementHarness.call('act_on_screen', args), {
      action: 'type', x: shot.coordinateSpace.width / 2, y: shot.coordinateSpace.height * 0.3,
      text: 'whale', returnScreenshot: true,
    });
    expect(typed).not.toHaveProperty('error');
    await expect(h.page.locator('input')).toHaveValue('whale');
  } finally { await h.close(); }
});

for (const mode of ["desktop", "mobile"]) {
  test(`${mode} screenshots map their actual pixels through scrollbars, scaling and native fallback`, async () => {
    test.setTimeout(120_000);
    const h = await createHarness(mode);
    try {
      await h.page.setContent(`<!doctype html><style>
        html { overflow: scroll } body { margin: 0; width: 2000px; height: 2000px }
        ::-webkit-scrollbar { width: 15px; height: 15px; background: magenta }
        #target { position: absolute; left: 600px; top: 200px; width: 8px; height: 8px; background: red }
        #text { position: absolute; left: 550px; top: 280px; font: 20px monospace }
      </style><div id="target"></div><span id="text">ABCDEFGHIJ</span>`);
      await h.page.evaluate(() => {
        window.hits = 0;
        document.querySelector('#target').onclick = () => window.hits++;
        for (const [offset, color] of [[1, 'lime'], [5, 'blue']]) {
          const range = document.createRange(); range.setStart(document.querySelector('#text').firstChild, offset); range.collapse(true);
          const box = range.getBoundingClientRect();
          const marker = document.createElement('i');
          marker.style.cssText = `position:absolute;left:${box.x - 2}px;top:${box.y + box.height / 2 - 4}px;width:4px;height:8px;background:${color};pointer-events:none`;
          document.body.append(marker);
        }
      });
      if (mode === 'desktop') await h.worker.evaluate(() => {
        globalThis.originalSend = chrome.debugger.sendCommand.bind(chrome.debugger);
        globalThis.firstCaptures = 0;
        chrome.debugger.sendCommand = async (target, method, ...args) => {
          const result = await originalSend(target, method, ...args);
          if (method === 'Page.captureScreenshot' && ++firstCaptures === 1) {
            const [{ result: size }] = await chrome.scripting.executeScript({ target: { tabId: target.tabId }, func: () => ({ width: innerWidth, height: innerHeight - 80 }) });
            // Reproduce the first-attach infobar changing viewport height during capture.
            await originalSend(target, 'Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
          }
          return result;
        };
      });
      const first = await h.screen('screenshot', { actionable: true });
      expect(first).not.toHaveProperty('error');
      if (mode === 'desktop') {
        expect(await h.worker.evaluate(() => firstCaptures)).toBe(2);
        const size = await h.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(await h.screen('act_on_screen', { action: 'click', x: 604 * first.coordinateSpace.width / size.width,
          y: 204 * first.coordinateSpace.height / size.height, returnScreenshot: false })).not.toHaveProperty('error');
        expect(await h.page.evaluate(() => window.hits)).toBe(1);
        await h.worker.evaluate(() => { chrome.debugger.sendCommand = originalSend; });
      }
      await h.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: mode === 'mobile' });
      for (const native of [false, true]) {
        await h.worker.evaluate(native => {
          globalThis.originalSend ||= chrome.debugger.sendCommand.bind(chrome.debugger);
          chrome.debugger.sendCommand = (target, method, ...args) => native && method === 'Page.captureScreenshot'
            ? Promise.reject(new Error('Synthetic CDP capture failure')) : originalSend(target, method, ...args);
        }, native);
        for (const scale of [mode === 'mobile' ? 0.64 : 1, 1.25]) {
          await h.worker.evaluate(async zoom => chrome.tabs.setZoom((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id, zoom), scale === 1.25 ? 1.25 : 1);
          await h.command('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
          await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const shot = await h.screen('screenshot', { actionable: true, format: 'png' });
          expect(shot, JSON.stringify({ ...shot, _image: undefined })).not.toHaveProperty('error');
          expect(shot.method.startsWith(native ? 'visible_tab' : 'cdp')).toBe(true);
          if (!native) expect(shot.coordinateSpace.width).toBe(2048);
          const points = await h.worker.evaluate(async dataUrl => {
            const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0); bitmap.close();
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            return [[255, 0, 0], [0, 255, 0], [0, 0, 255]].map(rgb => {
              let x = 0, y = 0, n = 0;
              for (let i = 0; i < pixels.length; i += 4) if (rgb.every((v, c) => Math.abs(v - pixels[i + c]) < 30)) {
                x += (i / 4) % canvas.width + 0.5; y += Math.floor(i / 4 / canvas.width) + 0.5; n++;
              }
              if (!n) throw new Error('Missing screenshot marker');
              return { x: x / n, y: y / n };
            });
          }, shot._image);
          const before = await h.page.evaluate(() => window.hits);
          const click = await h.screen('act_on_screen', { action: 'click', ...points[0], returnScreenshot: false });
          expect(click).not.toHaveProperty('error');
          expect(await h.page.evaluate(() => window.hits), JSON.stringify({ native, scale, space: shot.coordinateSpace, pixel: points[0], resolved: click.resolvedPoint })).toBe(before + 1);
          if (mode === 'desktop') {
            expect(await h.screen('act_on_screen', { action: 'drag', ...points[1], endX: points[2].x, endY: points[2].y, returnScreenshot: false })).not.toHaveProperty('error');
            expect(await h.page.evaluate(() => String(getSelection()))).toBe('BCDE');
          }
        }
      }
    } finally { await h.close(); }
  });

  test(`${mode} element fill and check use trusted input and verify the page's actual state`, async () => {
    test.setTimeout(120_000);
    const h = await createHarness(mode);
    const events = (state, id, type) => state.events.filter(event => event.id === id && event.type === type);
    try {
      for (const [id, value] of [["text", "订单🙂"], ["textarea", "第一行\n第二行🙂  "], ["textarea", ""], ["controlled", "Accepted-轻舟"]]) {
        const filled = await h.act(id, "fill", { value });
        expect(filled, JSON.stringify(filled)).toMatchObject({ filled: true, value, submitDispatched: false, method: "cdp" });
        expect(filled).not.toHaveProperty("submitted");
        const state = await h.state();
        expect(state.values[id]).toBe(value);
        expect(events(state, id, "input").length).toBeGreaterThan(0);
        expect(events(state, id, "input").every(event => event.trusted)).toBe(true);
      }
      expect((await h.state()).acceptedValue).toBe("Accepted-轻舟");
      const spacedText = "  keep  spaces🙂  ";
      const spaced = await h.act("rich", "fill", { value: spacedText });
      expect(spaced).toMatchObject({ filled: true, method: "cdp" });
      const spacedState = await h.state();
      expect(spaced.value).toBe(spacedState.richRaw);
      expect(spaced.value.replace(/\u00a0/g, " ")).toBe(spacedText);
      expect(events(spacedState, "rich", "input").length).toBeGreaterThan(0);
      expect(events(spacedState, "rich", "input").every(event => event.trusted)).toBe(true);
      expect(await h.act("rich", "fill", { value: "第一段\n第二段" })).toMatchObject({ filled: true, method: "content" });
      expect((await h.state()).values.rich.split(/\n+/)).toEqual(["第一段", "第二段"]);

      const mismatch = await h.act("uppercase", "fill", { value: "mixed", submit: true });
      expect(mismatch).toMatchObject({ code: "ELEMENT_VALUE_MISMATCH", value: "MIXED" });
      let state = await h.state();
      expect(state.submits).toBe(0);
      expect(events(state, "uppercase", "keydown").some(event => event.key === "Enter")).toBe(false);
      expect(await h.act("text", "fill", { value: "submit", submit: true })).toMatchObject({ filled: true, submitDispatched: true });
      state = await h.state();
      expect(state.submits).toBe(1);
      expect(events(state, "text", "keydown").filter(event => event.key === "Enter")).toEqual([
        expect.objectContaining({ trusted: true }),
      ]);
      await h.blockEnter();
      expect(await h.act("text", "fill", { value: "cancelled", submit: true })).toMatchObject({ submitDispatched: true });
      expect((await h.state()).submits).toBe(1);
      expect(await h.act("required", "fill", { value: "", submit: true })).toMatchObject({ submitDispatched: true });
      state = await h.state();
      expect(state.invalid).toBe(1);
      expect(state.submits).toBe(1);

      for (const id of ["readonly", "disabled", "refuses"]) {
        const result = await h.act(id, "fill", { value: "must not appear", submit: true });
        expect(result, JSON.stringify(result)).toHaveProperty("error");
        state = await h.state();
        expect(state.values[id]).toBe(id);
        expect(state.values.sink).toBe("untouched");
        expect(events(state, id, "input")).toEqual([]);
      }
      expect(await h.act("redirects", "fill", { value: "focus moved", submit: true })).toMatchObject({ code: "ELEMENT_FOCUS_FAILED" });
      state = await h.state();
      expect(state.values.redirects).toBe("focus moved");
      expect(state.values.sink).toBe("untouched");
      expect(events(state, "sink", "keydown").some(event => event.key === "Enter")).toBe(false);
      expect(state.submits).toBe(1);

      expect(await h.act("checkbox", "check")).toMatchObject({ checked: true, changed: true, method: "cdp" });
      const afterCheck = await h.state();
      expect(await h.act("checkbox", "check")).toMatchObject({ checked: true, changed: false });
      expect((await h.state()).events.length).toBe(afterCheck.events.length);
      expect(await h.act("checkbox", "uncheck")).toMatchObject({ checked: false, changed: true });
      state = await h.state();
      expect(state.checks.checkbox).toBe(false);
      expect(events(state, "checkbox", "click")).toHaveLength(2);
      expect(events(state, "checkbox", "click").every(event => event.trusted)).toBe(true);
      if (mode === "mobile") {
        expect(events(state, "checkbox", "touchstart")).toHaveLength(2);
        expect(events(state, "checkbox", "touchstart").every(event => event.trusted)).toBe(true);
      }
      // open_tab creates a background tab. Its paint-dependent rollback needs a
      // foreground frame; the preceding input checks cover the non-painting path.
      await h.page.bringToFront();
      await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      for (const id of ["rollback", "cancelled"]) {
        expect(await h.act(id, "check")).toMatchObject({ code: "ELEMENT_CHECK_STATE_MISMATCH", checked: false });
        state = await h.state();
        expect(state.checks[id]).toBe(false);
        expect(events(state, id, "click")).toHaveLength(1);
      }
      expect(await h.act("disabled-check", "check")).toHaveProperty("error");
      expect(await h.act("radio", "uncheck")).toHaveProperty("error");
      state = await h.state();
      expect(state.checks["disabled-check"]).toBe(false);
      expect(state.checks.radio).toBe(true);

      expect(await h.act("hidden-check", "check")).toMatchObject({ checked: true, changed: true, method: "cdp" });
      expect(await h.act("hidden-check", "uncheck")).toMatchObject({ checked: false, changed: true });
      state = await h.state();
      expect(state.checks["hidden-check"]).toBe(false);
      expect(events(state, "hidden-label", "click")).toHaveLength(2);
      expect(events(state, "hidden-check", "click")).toHaveLength(2);
      expect(events(state, "hidden-check", "click").every(event => event.trusted)).toBe(true);
      const safeUrl = state.url;
      for (const [id, labelTarget] of [["hidden-disabled", "disabled-label"], ["link-check", "label-link"], ["button-check", "label-button"]]) {
        expect(await h.act(id, "check")).toHaveProperty("error");
        state = await h.state();
        expect(state.checks[id]).toBe(false);
        expect(events(state, labelTarget, "click")).toEqual([]);
        expect(state.url).toBe(safeUrl);
      }
    } finally { await h.close(); }
  });
}

test("httpbin pizza radios check through the wrapped label", async () => {
  test.setTimeout(120_000);
  const h = await createHarness("desktop");
  try {
    await h.page.setContent(`<!doctype html><title>pizza</title>
      <form method="post" action="/post">
        <fieldset>
          <legend> Pizza Size </legend>
          <p><label> <input type=radio name=size value="small"> Small </label></p>
          <p><label> <input type=radio name=size value="medium"> Medium </label></p>
          <p><label> <input type=radio name=size value="large"> Large </label></p>
        </fieldset>
        <fieldset>
          <legend> Pizza Toppings </legend>
          <p><label> <input type=checkbox name="topping" value="bacon"> Bacon </label></p>
          <p><label> <input type=checkbox name="topping" value="onion"> Onion </label></p>
        </fieldset>
      </form>`);
    const call = (target, action) => h.worker.evaluate(
      ({ target, action }) => elementHarness.call("act_on_element", { target, action }),
      { target, action },
    );
    const large = await call('css:input[name="size"][value="large"]', "check");
    const checks = await h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll("input")].map(el => [el.value || el.name, el.checked])));
    expect(large, JSON.stringify({ large, checks })).toMatchObject({ checked: true, changed: true, method: "cdp" });
    expect(checks).toMatchObject({ small: false, medium: false, large: true });
    const label = await call("css:fieldset:nth-of-type(1) > p:nth-of-type(2) > label", "click");
    const afterLabel = await h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('input[type=radio]')].map(el => [el.value, el.checked])));
    expect(label, JSON.stringify({ label, afterLabel })).not.toHaveProperty("error");
    expect(afterLabel).toMatchObject({ small: false, medium: true, large: false });
    const bacon = await call('css:input[name="topping"][value="bacon"]', "check");
    expect(bacon, JSON.stringify(bacon)).toMatchObject({ checked: true, changed: true, inputDelivered: true });
    const opened = await h.worker.evaluate((url) => elementHarness.call("open_tab", { url }), h.page.url());
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    const shot = await h.worker.evaluate((tabId) => elementHarness.call("screenshot", { tabId, actionable: true }, "run_script"), opened.id);
    expect(shot, JSON.stringify({ ...shot, _image: undefined })).not.toHaveProperty("error");
    const acted = await h.worker.evaluate((tabId) => elementHarness.call("act_on_screen", {
      tabId, action: "click", x: 20, y: 20, returnScreenshot: false,
    }, "run_script"), opened.id);
    expect(acted, JSON.stringify(acted)).not.toHaveProperty("code", "SCREENSHOT_CONTEXT_STALE");
  } finally { await h.close(); }
});

test("a click that navigates is not reported as undelivered input", async () => {
  test.setTimeout(120_000);
  const h = await createHarness("desktop");
  try {
    await h.worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.receiptReads = 0;
      chrome.scripting.executeScript = async options => {
        const source = String(options?.func || "");
        if (!source.includes("__qzInputReceiptBound") || options.args?.[0] !== false) return original(options);
        // A committed navigation leaves this read on a document that was never armed.
        receiptReads += 1;
        const root = globalThis;
        const previousDocument = root.document;
        const previousCount = root.__qzInputReceipt;
        root.document = { addEventListener() {} };
        delete root.__qzInputReceipt;
        try { return [{ result: options.func(false) }]; }
        finally {
          if (previousDocument === undefined) delete root.document;
          else root.document = previousDocument;
          if (previousCount === undefined) delete root.__qzInputReceipt;
          else root.__qzInputReceipt = previousCount;
        }
      };
    });
    for (const [id, html, url] of [
      ["go", `<!doctype html><a id="go" href="/next" style="display:block;width:160px;height:40px">Next</a>`, "/next"],
      ["send", `<!doctype html><form action="/sent" method="get"><button id="send" type="submit" style="width:160px;height:40px">Send</button></form>`, "/sent"],
    ]) {
      await h.page.setContent(html);
      const result = await h.act(id, "click");
      expect(result, JSON.stringify(result)).toMatchObject({
        clickDispatched: true, inputDelivered: true, navigated: true,
      });
      expect(result).not.toHaveProperty("code", "INPUT_NOT_DELIVERED");
      await expect.poll(() => h.page.url()).toContain(url);
    }
    expect(await h.worker.evaluate(() => receiptReads)).toBe(2);
  } finally { await h.close(); }
});

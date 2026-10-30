import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const html = `<!doctype html><meta charset="utf-8"><title>Shadow hit</title>
  <style>
    body { margin: 0; font: 16px sans-serif }
    #open-host { position: absolute; left: 16px; top: 16px }
    #closed-host { position: absolute; left: 16px; top: 80px }
    #blocked-host { position: absolute; left: 16px; top: 150px; width: 200px; height: 48px }
    #covered-anchor { position: absolute; left: 16px; top: 220px; width: 200px; height: 48px }
    #cover { position: absolute; inset: 0; background: rgba(0, 0, 128, .35); z-index: 2 }
    #check-host { position: absolute; left: 16px; top: 300px; width: 220px; height: 96px }
  </style>
  <div id="open-host"></div>
  <div id="closed-host"></div>
  <div id="blocked-host"></div>
  <div id="covered-anchor"><div id="covered-host"></div><div id="cover"></div></div>
  <div id="check-host"></div>
  <script>
    window.hits = { header: 0, buy: 0, closed: 0, blocked: 0, covered: 0, link: 0 };
    window.checks = { shadow: false, linked: false };
    function button(label, key) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = "btn";
      const span = document.createElement("span");
      span.textContent = label;
      control.append(span);
      control.addEventListener("click", () => { window.hits[key] += 1; });
      return control;
    }
    const open = document.querySelector("#open-host").attachShadow({ mode: "open" });
    const row = document.createElement("div");
    row.className = "card";
    row.style.cssText = "display:flex;gap:12px";
    for (const [label, key] of [["Header", "header"], ["Buy", "buy"]]) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const control = button(label, key);
      control.style.cssText = "width:88px;height:36px";
      cell.append(control);
      row.append(cell);
    }
    open.append(row);
    const closed = document.querySelector("#closed-host").attachShadow({ mode: "closed" });
    const closedButton = button("Closed", "closed");
    closedButton.style.cssText = "width:88px;height:36px";
    closed.append(closedButton);
    const blocked = document.querySelector("#blocked-host").attachShadow({ mode: "open" });
    const blockedButton = button("Blocked", "blocked");
    blockedButton.style.cssText = "width:160px;height:36px";
    const blocker = document.createElement("div");
    blocker.style.cssText = "position:absolute;left:0;top:0;width:200px;height:48px;background:rgba(200,0,0,.4)";
    blocked.append(blockedButton, blocker);
    const covered = document.querySelector("#covered-host").attachShadow({ mode: "open" });
    const coveredButton = button("Covered", "covered");
    coveredButton.style.cssText = "width:160px;height:36px";
    covered.append(coveredButton);
    const checks = document.querySelector("#check-host").attachShadow({ mode: "closed" });
    function offscreenBox(id, key) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.style.cssText = "position:absolute;left:-2000px;width:16px;height:16px";
      input.addEventListener("change", () => { window.checks[key] = input.checked; });
      return input;
    }
    const shadowBox = offscreenBox("shadow-box", "shadow");
    const shadowLabel = document.createElement("label");
    shadowLabel.setAttribute("for", "shadow-box");
    shadowLabel.textContent = "Shadow check";
    shadowLabel.style.cssText = "display:block;width:180px;height:40px";
    const linkedBox = offscreenBox("linked-box", "linked");
    const linkedLabel = document.createElement("label");
    linkedLabel.setAttribute("for", "linked-box");
    const link = document.createElement("a");
    link.href = "#unexpected";
    link.textContent = "Other destination";
    link.style.cssText = "display:block;width:180px;height:40px";
    link.addEventListener("click", event => { event.preventDefault(); window.hits.link += 1; });
    linkedLabel.append(link);
    checks.append(shadowBox, shadowLabel, linkedBox, linkedLabel);
  </script>`;

async function createHarness() {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-shadow-hit-"));
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
      const context = { sessionId: "shadow-hit", runId: "run", runProfile: { platform: { os: "linux" } } };
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
        async pageState() {
          return (await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => ({
            ready: document.readyState,
            hits: window.hits,
            checks: window.checks,
          }) }))[0].result;
        },
      };
    });
    const call = (name, args) => worker.evaluate(
      ({ name, args }) => elementHarness.call(name, args),
      { name, args },
    );
    const state = () => worker.evaluate(() => elementHarness.pageState());
    const opened = await call("open_tab", { url: `http://127.0.0.1:${server.address().port}/` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    await expect.poll(async () => { try { return (await state()).ready; } catch { return "loading"; } }).toBe("complete");
    return { call, state, close, page: browser.pages().find(page => page.url().startsWith('http://127.0.0.1:')) };
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
  return last.snapshot;
}

test("find_elements binds open shadow hits to inspectable, clickable node UIDs", async ({}, testInfo) => {
  const h = await createHarness();
  try {
    // No AX snapshot is needed to create a find_elements target.
    const found = await h.call('find_elements', { roles: ['button'] });
    expect(found, JSON.stringify(found)).not.toHaveProperty('code');
    expect(found.results.some(hit => hit.text === 'Closed')).toBe(false);
    const buy = found.results.find(hit => hit.text === 'Buy');
    expect(buy?.target, JSON.stringify(found)).toMatch(/^uid:/);
    for (const hit of found.results) {
      expect(hit.target).toMatch(/^uid:/);
      expect(hit).not.toHaveProperty('_elementRef');
      expect(hit).not.toHaveProperty('line');
      expect(hit).not.toHaveProperty('lineRange');
    }
    const inspection = await h.call('inspect_element', { target: buy.target });
    expect(inspection).toMatchObject({ tag: 'button', text: 'Buy', target: buy.target });
    expect(inspection).not.toHaveProperty('lineRange');
    const dom = await h.call('read_dom', { selector: buy.target });
    expect(dom.content).toContain('Buy');
    expect(dom.content).not.toContain('Header');
    const clicked = await h.call('act_on_element', { target: buy.target, action: 'click' });
    expect(clicked, JSON.stringify(clicked)).toMatchObject({ clickDispatched: true });
    const state = await h.state();
    expect(state.hits).toMatchObject({ buy: 1, header: 0, closed: 0 });
    await testInfo.attach('shadow-find-target', {
      body: JSON.stringify({ hit: buy, inspection, dom, clicked, hits: state.hits }, null, 2), contentType: 'application/json',
    });

    await h.page.evaluate(() => {
      const host = document.createElement('div');
      document.querySelector('#open-host').shadowRoot.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="nested">Nested find</button>';
      root.firstElementChild.addEventListener('click', () => { window.hits.nested = (window.hits.nested || 0) + 1; });
    });
    const nested = await h.call('find_elements', { selector: '#nested', roles: ['button'] });
    const target = nested.results[0].target;
    expect(target).toMatch(/^uid:/);
    const scoped = await h.call('find_elements', { selector: target, roles: ['button'] });
    expect(scoped.results[0].target).toMatch(/^uid:/);
    expect((await h.call('inspect_element', { target: scoped.results[0].target })).text).toBe('Nested find');
    expect(await h.call('act_on_element', { target, action: 'click' })).toMatchObject({ clickDispatched: true });
    expect((await h.state()).hits.nested).toBe(1);
    await h.page.evaluate(() => {
      const root = document.querySelector('#open-host').shadowRoot.lastElementChild.shadowRoot;
      root.firstElementChild.replaceWith(root.firstElementChild.cloneNode(true));
    });
    expect(await h.call('inspect_element', { target })).toHaveProperty('code', 'STALE_ELEMENT_UID');
    expect(await h.call('act_on_element', { target, action: 'click' })).toHaveProperty('code', 'STALE_ELEMENT_UID');
    expect((await h.state()).hits.nested).toBe(1);
    const refreshed = await h.call('find_elements', { selector: '#nested' });
    expect((await h.call('inspect_element', { target: refreshed.results[0].target })).text).toBe('Nested find');

    await h.page.reload();
    expect(await h.call('inspect_element', { target: buy.target })).toHaveProperty('code', 'STALE_ELEMENT_UID');
    const afterReload = await h.call('find_elements', { roles: ['button'], pattern: '^Buy$' });
    expect(await h.call('act_on_element', { target: afterReload.results[0].target, action: 'click' })).toMatchObject({ clickDispatched: true });
    expect((await h.state()).hits.buy).toBe(1);
  } finally {
    await h.close();
  }
});

test.describe("shadow hit testing", () => {
  test.describe.configure({ mode: "serial", timeout: 180000 });
  let h;
  let snapshot;
  test.beforeAll(async () => {
    h = await createHarness();
    snapshot = await tree(h);
  });
  test.afterAll(async () => { await h?.close(); });

  test("an open shadow button is clicked on its own node", async () => {
    const buy = targets(snapshot, "button", '"Buy"')[0];
    expect(buy, snapshot).toBeTruthy();
    const clicked = await h.call("act_on_element", { target: buy, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect(clicked.clickDispatched).toBe(true);
    const hits = (await h.state()).hits;
    expect(hits.buy).toBe(1);
    expect(hits.header).toBe(0);
  });

  test("a closed shadow button is clicked on its own node", async () => {
    const closed = targets(snapshot, "button", '"Closed"')[0];
    expect(closed, snapshot).toBeTruthy();
    const clicked = await h.call("act_on_element", { target: closed, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    expect(clicked.clickDispatched).toBe(true);
    expect((await h.state()).hits.closed).toBe(1);
  });

  test("a light DOM overlay covering a shadow button stays obscured", async () => {
    const covered = targets(snapshot, "button", '"Covered"')[0];
    expect(covered, snapshot).toBeTruthy();
    const clicked = await h.call("act_on_element", { target: covered, action: "click" });
    expect(clicked.code, JSON.stringify(clicked)).toBe("ELEMENT_OBSCURED");
    expect(clicked.details?.state?.obscuredAtCenter ?? clicked.details?.originalState?.obscuredAtCenter).toBe(true);
    expect((await h.state()).hits.covered || 0).toBe(0);
  });

  test("a shadow sibling covering a shadow button stays obscured", async () => {
    const blocked = targets(snapshot, "button", '"Blocked"')[0];
    expect(blocked, snapshot).toBeTruthy();
    const clicked = await h.call("act_on_element", { target: blocked, action: "click" });
    expect(clicked.code, JSON.stringify(clicked)).toBe("ELEMENT_OBSCURED");
    expect((await h.state()).hits.blocked || 0).toBe(0);
  });

  test("a closed shadow checkbox uses its visible label and ignores a nested link", async () => {
    const shadow = targets(snapshot, "checkbox", '"Shadow check"')[0];
    const linked = targets(snapshot, "checkbox", '"Other destination"')[0];
    expect(shadow, snapshot).toBeTruthy();
    expect(linked, snapshot).toBeTruthy();
    const checked = await h.call("act_on_element", { target: shadow, action: "check" });
    expect(checked, JSON.stringify(checked)).toMatchObject({ checked: true, changed: true });
    const rejected = await h.call("act_on_element", { target: linked, action: "check" });
    expect(rejected, JSON.stringify(rejected)).toHaveProperty("code");
    const page = await h.state();
    expect(page.checks).toMatchObject({ shadow: true, linked: false });
    expect(page.hits.link || 0).toBe(0);
  });
});

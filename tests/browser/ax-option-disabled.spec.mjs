import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const html = await readFile(new URL("../fixtures/ax-option-disabled.html", import.meta.url), "utf8");

async function createHarness() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-ax-disabled-"));
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
      const context = { sessionId: "ax-disabled", runId: "run", runProfile: { platform: { os: "linux" } } };
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
            selects: Object.fromEntries(["city", "province", "route", "grouped"].map(id => {
              const select = document.getElementById(id);
              return [id, { disabled: select.disabled, options: [...select.options].map(option => ({
                text: option.text, disabled: option.disabled, matches: option.matches(":disabled"),
              })) }];
            })),
          }) }))[0].result;
        },
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => elementHarness.call(name, args), { name, args });
    const state = () => worker.evaluate(() => elementHarness.pageState());
    const opened = await call("open_tab", { url: `http://127.0.0.1:${server.address().port}/` });
    expect(opened, JSON.stringify(opened)).not.toHaveProperty("error");
    await expect.poll(async () => { try { return (await state()).ready; } catch { return "loading"; } }).toBe("complete");
    return { call, state, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function roleLine(snapshot, role, name) {
  return String(snapshot || "").split("\n").find(line => new RegExp(`\\b${role}\\b`).test(line) && line.includes(`"${name}"`)) || "";
}

function expectDisabled(snapshot, role, name, disabled) {
  const line = roleLine(snapshot, role, name);
  expect(line, snapshot).not.toBe("");
  if (disabled) expect(line, snapshot).toMatch(/\bdisabled\b/);
  else expect(line, snapshot).not.toMatch(/\bdisabled\b/);
}

function expectUnchangedOptions(snapshot) {
  for (const name of ["丙", "丁", "甲", "己", "子"]) expectDisabled(snapshot, "option", name, true);
  for (const name of ["乙", "戊"]) expectDisabled(snapshot, "option", name, false);
}

test("get_ax_tree clears stale option disabled after loading cities and re-enabling selects", async () => {
  test.setTimeout(180000);
  const h = await createHarness();
  try {
    // Populate Chrome's AX cache while the original options inherit disabled.
    const before = await h.call("get_ax_tree", { scope: "full", limit: 300 });
    expect(before, JSON.stringify(before)).not.toHaveProperty("error");
    const dom = (await h.state()).selects;
    expect(dom.city.disabled).toBe(true);
    expect(dom.city.options.map(option => option.text)).toEqual(["请选择"]);
    expect(dom.grouped.options.find(option => option.text === "甲")).toMatchObject({ disabled: false, matches: true });
    for (const name of ["请选择", "浙江", "江苏"]) expectDisabled(before.snapshot, "option", name, true);
    expectUnchangedOptions(before.snapshot);

    const load = roleLine(before.snapshot, "button", "加载城市").match(/target=(uid:\S+)/)?.[1] || "";
    expect(load, before.snapshot).toMatch(/^uid:/);
    const clicked = await h.call("act_on_element", { target: load, action: "click" });
    expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
    await expect.poll(async () => {
      const current = (await h.state()).selects;
      return [current.city.disabled, current.city.options.map(option => option.text).join(","),
        current.province.disabled, current.route.disabled].join("|");
    }).toBe("false|杭州,宁波,温州|false|true");
    const enabled = (await h.state()).selects;
    expect([...enabled.city.options, ...enabled.province.options].every(option => !option.matches && !option.disabled)).toBe(true);

    const after = await h.call("get_ax_tree", { scope: "full", limit: 300 });
    expect(after, JSON.stringify(after)).not.toHaveProperty("error");
    expect(after.snapshot).not.toContain("请选择");
    // City options were replaced; province options are the same cached DOM nodes.
    for (const name of ["杭州", "宁波", "温州", "浙江", "江苏"]) expectDisabled(after.snapshot, "option", name, false);
    expectDisabled(after.snapshot, "combobox", "城市", false);
    expectDisabled(after.snapshot, "combobox", "省份", false);
    expectDisabled(after.snapshot, "combobox", "航线", true);
    // Route options may remain unmarked: the correction never adds flags.
    expectUnchangedOptions(after.snapshot);
  } finally {
    await h.close();
  }
});

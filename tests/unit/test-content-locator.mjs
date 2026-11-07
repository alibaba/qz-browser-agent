import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { playwrightDomSources } from "../../scripts/vendor/playwright-dom.mjs";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { localizeToolFailureError, localizeToolFailurePayload } from "../../src/shared/tools/tool-error-localization.js";

let browser, page, content;
const html = `
  <button id="save">Save</button>
  <button aria-label="Save draft">Different text</button>
  <button class="Save">Cancel</button>
  <label for="destination">Destination</label><input id="destination">
  <span id="city">Hangzhou</span><span id="building">Tower</span>
  <div role="option" aria-labelledby="city building">Unrelated text</div>
  <button id="hidden" hidden>Hidden</button>
  <div class="twin" role="option">Duplicate</div><div class="twin" role="option">Duplicate</div>
  <section id="scope"><button>Scoped</button><p><span>Ready result</span></p></section>
  <div id="shadow"></div>`;

test.before(async () => {
  const built = await build({
    entryPoints: ["src/content/content-script.ts"], bundle: true, write: false,
    format: "iife", platform: "browser", target: "chrome114", logLevel: "silent",
    plugins: [playwrightDomSources()],
  });
  content = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

async function installContent(target) {
  await target.evaluate(() => {
    delete window.__QZ_CONTENT_VERSION;
    let listener;
    if (!window.chrome) window.chrome = {};
    Object.defineProperty(window.chrome, "runtime", { configurable: true, value: {
      getManifest: () => ({ name: "Locator fixture", version: "0.0.0" }),
      onMessage: { addListener(value) { listener = value; }, removeListener() {} },
      sendMessage: async () => ({ ok: true }),
    } });
    window.callContent = (action, args = {}) => new Promise(resolve => listener({ action, ...args }, {}, resolve));
  });
  await target.addScriptTag({ content });
}

test.beforeEach(async () => {
  await page.setContent(html);
  await installContent(page);
});

test.after(async () => { await browser?.close(); });

const resolve = (locator, extra = {}) => page.evaluate(
  ({ locator, extra }) => window.callContent("resolveLocator", { locator, ...extra }), { locator, extra },
);

test("semantic names use the named field, implicit roles, labels and content", async () => {
  const save = await resolve({ role: "button", name: "Save" });
  assert.equal(save.matched, 1);
  assert.equal(save.element.text, "Save");
  assert.equal(save.element.name, "Save");
  assert.equal(save.element.selector, "");
  assert.ok(save.element._elementRef);
  assert.equal((await resolve({ role: "button", name: "save" })).matched, 0);
  assert.equal((await resolve({ role: "button", name: "Save", exact: false })).matched, 2);
  const textbox = await resolve({ role: "textbox", name: "Destination" });
  assert.equal(textbox.matched, 1);
  assert.equal(textbox.element.tag, "input");
  const labelled = await resolve({ role: "option", name: "Hangzhou   Tower" });
  assert.equal(labelled.matched, 1);
  assert.equal(labelled.element.text, "Unrelated text");
  const discovery = await page.evaluate(() => window.callContent("findElements", { roles: ["button"], pattern: "^Save$" }));
  assert.ok(discovery.results.some(element => element.name === save.element.name));
});

test("wrapping labels exclude their control's own text from its accessible name", async () => {
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `
    <label><span>Tr</span>ack <select id="track"><option value="">-- choose --</option>
      <option value="data">Data extraction</option><option value="web">Web automation</option></select></label>
    <label for="notes">Notes <textarea id="notes">Prefilled note</textarea></label>
    <label>Count <output id="count">42</output></label>`));
  for (const [role, name] of [["combobox", "Track"], ["textbox", "Notes"], ["status", "Count"]]) {
    assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1);
    const found = await resolve({ role, name });
    assert.equal(found.matched, 1, `${role} must use the same name as the browser`);
    assert.equal(found.element.name, name);
  }
  await page.getByRole("combobox", { name: "Track", exact: true }).selectOption("data");
  assert.equal((await resolve({ role: "combobox", name: "Track" })).matched, 1);
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<label for="track">Required</label>'));
  assert.equal(await page.getByRole("combobox", { name: "Track Required", exact: true }).count(), 1);
  assert.equal((await resolve({ role: "combobox", name: "Track Required" })).matched, 1);
});

test("accessible names follow references, label precedence, hidden content and SVG titles", async () => {
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `
    <label>Native label<input aria-label="Explicit label"></label>
    <span id="reference"><span aria-label="Referenced name">Ignored text</span></span>
    <button aria-labelledby="reference" aria-label="Fallback name">Other text</button>
    <span id="hidden-reference" hidden>Hidden reference</span><button aria-labelledby="hidden-reference">Other text</button>
    <button>Visible name<span hidden>hidden suffix</span><span aria-hidden="true">ignored suffix</span></button>
    <style>#generated-name::before { content: "Generated "; }</style><button id="generated-name">name</button>
    <svg><title>Route icon</title><path d="M0 0h10v10z"/></svg>
    <button role="presentation">Apply changes</button>
    <table><tr><th>Price</th><td>$42</td></tr><tr><th>Stock</th><td>Available</td></tr></table>`));
  for (const [role, name] of [["textbox", "Explicit label"], ["button", "Referenced name"],
    ["button", "Hidden reference"], ["button", "Visible name"], ["button", "Generated name"], ["img", "Route icon"],
    ["button", "Apply changes"], ["rowheader", "Price"]]) {
    assert.equal(await page.getByRole(role, { name, exact: true }).count(), 1);
    const found = await resolve({ role, name });
    assert.equal(found.matched, 1, `accessible name: ${name}`);
    assert.equal(found.element.name, name);
  }
});

test("shadow names use their own ID scope and assigned slot content", async () => {
  await page.evaluate(() => {
    const host = document.querySelector("#shadow");
    host.innerHTML = '<span slot="caption">Slotted action</span>';
    host.attachShadow({ mode: "open" }).innerHTML = `
      <span id="city">Shadow destination</span><button aria-labelledby="city">Other text</button>
      <button><slot name="caption"></slot></button>`;
  });
  for (const name of ["Shadow destination", "Slotted action"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1);
    const found = await resolve({ role: "button", name });
    assert.equal(found.matched, 1, name);
    assert.equal(found.element.name, name);
  }
});

test("iframe names resolve references in the owning document", async () => {
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.srcdoc = '<span id="city">Frame destination</span><button aria-labelledby="city">Other text</button>';
    document.body.append(frame);
  });
  const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
  await frame.waitForSelector("button");
  await installContent(frame);
  assert.equal(await frame.getByRole("button", { name: "Frame destination", exact: true }).count(), 1);
  const found = await frame.evaluate(() => window.callContent("resolveLocator", {
    locator: { role: "button", name: "Frame destination" },
  }));
  assert.equal(found.matched, 1);
  assert.equal(found.element.name, "Frame destination");
});

test("strict queries report ambiguity; nth is explicit and preserves tree order", async () => {
  const ambiguous = await resolve({ target: "css:.twin" });
  assert.deepEqual(ambiguous, { matched: 2 });
  const selected = await resolve({ target: "css:.twin", nth: 1 });
  assert.equal(selected.matched, 2);
  assert.ok(selected.element._elementRef);
  const isSecond = await page.evaluate(async token => {
    const [node] = await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: [token] });
    return node === document.querySelectorAll(".twin")[1];
  }, selected.element._elementRef);
  assert.equal(isSecond, true);
  assert.deepEqual(await resolve({ target: "css:.twin", nth: 8 }), { matched: 2 });
});

test("attached hidden nodes remain queryable and counting does not bind nodes", async () => {
  const hidden = await resolve({ target: "css:#hidden" });
  assert.equal(hidden.matched, 1);
  assert.equal(hidden.element.visible, false);
  assert.equal(hidden.element.name, "");
  const count = await resolve({ role: "button" }, { countOnly: true });
  assert.deepEqual(count, { matched: 5 });
  await page.evaluate(() => { document.querySelector("#hidden").hidden = false; });
  assert.equal((await resolve({ role: "button", name: "Hidden" })).matched, 1);
  await page.evaluate(() => document.querySelector("#hidden").remove());
  assert.deepEqual(await resolve({ target: "css:#hidden" }), { matched: 0 });
});

test("list queries preserve total counts, bounded results and explicit nth", async () => {
  const found = await resolve({ role: "button" }, { all: true, limit: 2 });
  assert.equal(found.matched, 5);
  assert.equal(found.results.length, 2);
  assert.deepEqual(found.results.map(element => element.name), ["Save", "Save draft"]);
  assert.ok(found.results.every(element => element._elementRef));
  const nth = await resolve({ role: "button", nth: 3 }, { all: true });
  assert.equal(nth.matched, 5);
  assert.equal(nth.results.length, 1);
  assert.equal(nth.results[0].visible, false);
  const missing = await resolve({ role: "button", nth: 9 }, { all: true });
  assert.deepEqual(missing, { matched: 5, results: [] });
  const self = await page.evaluate(() => window.__qzInvoke(document.querySelector("#save"), {
    action: "resolveLocator", locator: {}, matchSelf: true, all: true,
  }));
  assert.equal(self.matched, 1);
  assert.equal(self.results[0].text, "Save");
});

test("text-only queries choose smallest matching nodes and scoped calls remain local", async () => {
  const text = await resolve({ text: "Ready result" });
  assert.equal(text.matched, 1);
  assert.equal(text.element.tag, "span");
  const scoped = await page.evaluate(() => window.__qzInvoke(document.querySelector("#scope"), {
    action: "resolveLocator", locator: { role: "button" },
  }));
  assert.equal(scoped.matched, 1);
  assert.equal(scoped.element.text, "Scoped");
  const self = await page.evaluate(() => window.__qzInvoke(document.querySelector("#save"), {
    action: "resolveLocator", locator: { role: "button", name: "Save" }, matchSelf: true,
  }));
  assert.equal(self.matched, 1);
  const documentRoot = await page.evaluate(() => window.__qzInvoke(document, {
    action: "resolveLocator", locator: { role: "button", name: "Save" },
  }));
  assert.equal(documentRoot.matched, 1);
  assert.equal((await resolve({ target: "css:button", scope: "css:.twin" })).code, "AMBIGUOUS_ELEMENT");
});

test("open shadow queries bind the exact node and never rematch after replacement", async () => {
  await page.evaluate(() => {
    document.querySelector("#shadow").attachShadow({ mode: "open" }).innerHTML =
      '<label for="field">Shadow field</label><input id="field"><button id="save">Shadow save</button>';
  });
  const named = await resolve({ role: "textbox", name: "Shadow field" });
  assert.equal(named.matched, 1);
  assert.ok(named.element._elementRef);
  assert.equal((await resolve({ target: "css:#save" })).matched, 2);
  const old = await resolve({ role: "button", name: "Shadow save" });
  await page.evaluate(() => {
    document.querySelector("#shadow").shadowRoot.querySelector("button").outerHTML = '<button id="save">New save</button>';
  });
  const stale = await page.evaluate(async token => {
    const [node] = await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: [token] });
    return node;
  }, old.element._elementRef);
  assert.equal(stale, null);
  assert.equal((await resolve({ role: "button", name: "New save" })).matched, 1);
});

test("CSS scope is rooted at the supplied search root and preserves shadow walk order", async () => {
  await page.evaluate(() => {
    const list = document.createElement("ul");
    list.id = "list";
    list.innerHTML = '<li id="first">First<ul><li id="nested">Nested</li></ul></li><li id="second">Second</li>';
    document.querySelector("#scope").append(list);
    document.querySelector("#shadow").attachShadow({ mode: "open" }).innerHTML = '<ul><li id="shadow-row">Shadow</li></ul>';
  });
  const scoped = await resolve({ scope: "css:#list", target: "css::scope > li" }, { all: true });
  assert.equal(scoped.matched, 2);
  assert.deepEqual(scoped.results.map(element => element.text), ["FirstNested", "Second"]);
  const bound = await page.evaluate(async () => {
    const selected = await window.callContent("resolveLocator", { locator: { target: "css:#list" } });
    const [root] = await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: [selected.element._elementRef] });
    return window.__qzInvoke(root, { action: "resolveLocator", locator: { target: "css::scope > li" }, all: true });
  });
  assert.equal(bound.matched, 2);
  assert.deepEqual(bound.results.map(element => element.text), ["FirstNested", "Second"]);
  const root = await resolve({ scope: "css:#list", target: "css::scope" });
  assert.equal(root.matched, 1);
  assert.equal(root.element.tag, "ul");
  const ordinary = await resolve({ target: "css:li" }, { all: true });
  assert.equal(ordinary.matched, 4);
  assert.deepEqual(ordinary.results.map(element => element.text), ["FirstNested", "Nested", "Second", "Shadow"]);
  assert.equal((await resolve({ target: "css::scope > body" })).matched, 1);
  const documentRoot = await page.evaluate(() => window.__qzInvoke(document, {
    action: "resolveLocator", locator: { target: "css::scope > body" },
  }));
  assert.equal(documentRoot.matched, 1);
  assert.equal(documentRoot.element.tag, "body");
});

test("invalid queries fail before selection", async () => {
  assert.equal((await resolve({ target: "css:[" })).code, "INVALID_SELECTOR");
  assert.equal((await resolve({ role: "button", nth: -1 })).code, "INVALID_ELEMENT_LOCATOR");
  assert.equal((await resolve({ scope: "css:#scope" })).code, "INVALID_ELEMENT_LOCATOR");
  assert.equal((await resolve({ target: "uid:unknown" })).code, "INVALID_ELEMENT_LOCATOR");
});

test("invalid CSS keeps the browser syntax reason and the whole public target through localization", async () => {
  const target = "css:form input[type=submit], css:form button";
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<form><input type="submit"><button>Submit</button></form>'));
  const failed = await resolve({ target });
  assert.equal(failed.code, "INVALID_SELECTOR");
  assert.match(failed.error, /^SyntaxError: /);
  assert.ok(failed.error.includes("form input[type=submit], css:form button"), "native CSS failure explains the rejected query");
  assert.deepEqual(failed.details, { target });
  assert.equal(failed.hint, undefined);
  for (const language of ["en", "zh-CN"]) withLanguage(language, () => {
    const payload = localizeToolFailurePayload(failed);
    assert.equal(payload.error, failed.error, "localization must not replace the native syntax reason");
    assert.equal(payload.details.target, target);
    assert.equal(payload.hint, undefined);
    const error = localizeToolFailureError(Object.assign(new Error(failed.error), { code: failed.code, details: failed.details }));
    assert.equal(error.message, failed.error);
    assert.equal(error.hint, undefined);
  });
  const scoped = await resolve({ target: "css:button", scope: target });
  assert.equal(scoped.details.target, target, "an invalid scope identifies the offending query");
  assert.equal((await resolve({ target: "css:form input[type=submit], form button" }, { all: true })).matched, 2,
    "one css prefix applies to the entire comma-separated query");
});

test("detached original nodes have a retryable reason but foreign documents do not", async () => {
  const result = await page.evaluate(async () => {
    const original = document.querySelector("#save");
    original.remove();
    const bound = await window.__qzInvoke(original, { action: "readElementReadiness" });
    const direct = await window.callContent("readElementReadiness", { selector: original });
    const scope = await window.__qzInvoke(original, { action: "resolveLocator", locator: { role: "button" } });
    document.implementation.createHTMLDocument("Other").adoptNode(original);
    const foreign = await window.__qzInvoke(original, { action: "readElementReadiness" });
    return { bound, direct, scope, foreign };
  });
  for (const name of ["bound", "direct", "scope"]) {
    assert.equal(result[name].code, "STALE_ELEMENT_UID", name);
    assert.equal(result[name].details.reason, "node_unavailable", name);
  }
  assert.equal(result.foreign.code, "STALE_ELEMENT_UID");
  assert.equal(result.foreign.details.reason, undefined);
});

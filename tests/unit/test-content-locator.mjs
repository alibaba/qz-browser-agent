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

test("queries match hidden nodes only with includeHidden, a target always does, and counting does not bind nodes", async () => {
  assert.deepEqual(await resolve({ role: "button", name: "Hidden" }), { matched: 0 });
  const named = await resolve({ role: "button", name: "Hidden", includeHidden: true });
  assert.equal(named.matched, 1, "includeHidden names hidden nodes from their hidden content");
  assert.equal(named.element.visible, false);
  const hidden = await resolve({ target: "css:#hidden" });
  assert.equal(hidden.matched, 1, "an explicit target is not visibility-filtered");
  assert.equal(hidden.element.visible, false);
  assert.equal(hidden.element.name, "");
  assert.equal((await resolve({ target: "css:#hidden", role: "button", name: "Hidden" })).matched, 1,
    "role and name narrow a target without filtering its hidden nodes");
  assert.deepEqual(await resolve({ role: "button" }, { countOnly: true }), { matched: 4 });
  assert.deepEqual(await resolve({ role: "button", includeHidden: true }, { countOnly: true }), { matched: 5 });
  assert.deepEqual(await resolve({ target: "css:button" }, { countOnly: true }), { matched: 5 });
  await page.evaluate(() => { document.querySelector("#hidden").hidden = false; });
  assert.equal((await resolve({ role: "button", name: "Hidden" })).matched, 1);
  await page.evaluate(() => document.querySelector("#hidden").remove());
  assert.deepEqual(await resolve({ target: "css:#hidden" }), { matched: 0 });
});

test("a hidden duplicate neither makes a query ambiguous nor shifts its nth, while target nth indexes every css match", async () => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("afterbegin", '<button class="go" hidden>Go</button>');
    document.body.insertAdjacentHTML("beforeend", '<button class="go" id="visible-go">Go</button>');
  });
  const strict = await resolve({ role: "button", name: "Go" });
  assert.equal(strict.matched, 1, "the visible match resolves without nth");
  assert.equal(strict.element.visible, true);
  assert.equal((await resolve({ role: "button", name: "Go", nth: 0 })).element.visible, true);
  assert.deepEqual(await resolve({ role: "button", name: "Go", includeHidden: true }), { matched: 2 });
  assert.equal((await resolve({ role: "button", name: "Go", includeHidden: true, nth: 0 })).element.visible, false);
  assert.deepEqual(await resolve({ target: "css:.go" }), { matched: 2 });
  assert.equal((await resolve({ target: "css:.go", nth: 0 })).element.visible, false);
  assert.equal((await resolve({ target: ".go", nth: 1 })).element.visible, true, "bare CSS is a target too");
});

test("an explicit target resolves a hidden file input for upload and a native select behind a custom dropdown", async () => {
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<form id="controls">
    <label for="upload">Attach file</label><input id="upload" type="file" style="display:none">
    <input id="zero-upload" type="file" style="position:absolute;width:0;height:0;border:0;padding:0">
    <button type="button">Choose file</button>
    <label for="country">Country</label><select id="country" style="display:none">
      <option value="">Choose</option><option value="cn">China</option></select>
    <div id="fake-country" role="combobox" aria-label="Country picker" tabindex="0">Choose</div></form>`));
  const node = token => page.evaluateHandle(async token =>
    (await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: [token] }))[0], token);

  for (const target of ["css:#upload", "#zero-upload"]) {
    const upload = await resolve({ target });
    assert.equal(upload.matched, 1, `${target} resolves although hidden`);
    assert.equal(upload.element.visible, false);
    const handle = await node(upload.element._elementRef);
    await handle.asElement().setInputFiles({ name: "report.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
    const inspected = await page.evaluate(input => window.__qzInvoke(input, { action: "inspectElement" }), handle);
    assert.equal(inspected.selectedFileCount, 1, `${target} reports the uploaded file`);
  }
  assert.equal((await resolve({ name: "Attach file" })).matched, 0);
  assert.equal((await resolve({ name: "Attach file", includeHidden: true })).matched, 1);

  const select = await resolve({ target: "css:#controls select", name: "Country" });
  assert.equal(select.matched, 1, "a target narrowed by name still sees the hidden select");
  assert.equal(select.element.visible, false);
  const selectNode = await node(select.element._elementRef);
  const selected = await page.evaluate(
    input => window.__qzInvoke(input, { action: "actOnElement", elementAction: "select", value: "cn" }), selectNode);
  assert.equal(selected.error, undefined);
  assert.equal(await page.$eval("#country", element => element.value), "cn");
  const presence = await page.evaluate(async input => ({
    visible: await window.__qzInvoke(input, { action: "elementPresence", visibleOnly: true }),
    attached: await window.__qzInvoke(input, { action: "elementPresence", visibleOnly: false }),
  }), selectNode);
  assert.equal(presence.visible.found, false, "a visible wait on a hidden target keeps waiting");
  assert.equal(presence.attached.found, true);

  await assertFindNthParity(page, { selector: "#controls", roles: ["combobox"] }, { role: "combobox", within: "css:#controls" },
    { visible: ["fake-country"], all: ["country", "fake-country"] });
  assert.equal((await resolve({ role: "combobox", name: "Country" })).matched, 0, "queries stay visible-only by default");
});

test("list queries preserve total counts, bounded results and explicit nth", async () => {
  const found = await resolve({ role: "button" }, { all: true, limit: 2 });
  assert.equal(found.matched, 4);
  assert.equal(found.results.length, 2);
  assert.deepEqual(found.results.map(element => element.name), ["Save", "Save draft"]);
  assert.ok(found.results.every(element => element._elementRef));
  const nth = await resolve({ role: "button", nth: 3 }, { all: true });
  assert.equal(nth.matched, 4);
  assert.deepEqual(nth.results.map(element => element.text), ["Scoped"]);
  const hidden = await resolve({ role: "button", nth: 3, includeHidden: true }, { all: true });
  assert.equal(hidden.matched, 5);
  assert.equal(hidden.results[0].visible, false);
  const missing = await resolve({ role: "button", nth: 9 }, { all: true });
  assert.deepEqual(missing, { matched: 4, results: [] });
  const self = await page.evaluate(() => window.__qzInvoke(document.querySelector("#hidden"), {
    action: "resolveLocator", locator: { role: "button" }, matchSelf: true, all: true,
  }));
  assert.equal(self.matched, 1, "a pinned node matches its own query even when hidden");
  assert.equal(self.results[0].visible, false);
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
  assert.equal((await resolve({ target: "css:button", within: "css:.twin" })).code, "AMBIGUOUS_ELEMENT");
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
  const scoped = await resolve({ within: "css:#list", target: "css::scope > li" }, { all: true });
  assert.equal(scoped.matched, 2);
  assert.deepEqual(scoped.results.map(element => element.text), ["FirstNested", "Second"]);
  const bound = await page.evaluate(async () => {
    const selected = await window.callContent("resolveLocator", { locator: { target: "css:#list" } });
    const [root] = await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: [selected.element._elementRef] });
    return window.__qzInvoke(root, { action: "resolveLocator", locator: { target: "css::scope > li" }, all: true });
  });
  assert.equal(bound.matched, 2);
  assert.deepEqual(bound.results.map(element => element.text), ["FirstNested", "Second"]);
  const root = await resolve({ within: "css:#list", target: "css::scope" });
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

const newsHtml = `<div id="itn" style="width:640px">
  <h2>In the news</h2>
  <a id="hidden" href="/wiki/Hidden" hidden>Booker Prize</a>
  <div style="float:right"><a id="image" href="/wiki/File:Cover.jpg"><img alt="Cover" width="220" height="160"
    src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></a></div>
  <ul>
    <li><b><a id="book" href="/wiki/The_End">The End of Everything</a></b> by <a id="author" href="/wiki/MJH">M. John Harrison</a>
      wins the <a id="booker" href="/wiki/Booker">Booker Prize</a>.</li>
    <li><a id="paper" href="/wiki/NG">Novaya Gazeta</a> is fined.</li>
    <li><span><span><small><a id="deep" href="/wiki/Jaros">Peter Jaroš</a></small></span></span> dies.</li>
  </ul>
  <p><small><a id="timeline" href="/wiki/Timeline">timeline</a></small> ·
    <span><span><small><a id="booker-again" href="/wiki/Booker">Booker Prize</a></small></span></span></p>
  <div id="itn-shadow"></div>
</div>`;

/** Element ids in find_elements order and in locator nth order (nth = 0, 1, ... until no match). */
async function findAndNthOrder(target, findArgs, locator) {
  return target.evaluate(async ({ findArgs, locator }) => {
    const label = node => node?.id || node?.textContent || null;
    const nodes = async refs => window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: refs });
    const found = await window.callContent("findElements", { limit: 100, ...findArgs });
    const located = [];
    for (let nth = 0; locator && nth < 100; nth += 1) {
      const result = await window.callContent("resolveLocator", { locator: { ...locator, nth } });
      if (!result.element) break;
      located.push(result.element._elementRef);
    }
    return {
      find: (await nodes(found.results.map(item => item._elementRef))).map(label),
      nth: (await nodes(located)).map(label),
      matchKinds: found.results.map(item => item.matchKind),
    };
  }, { findArgs, locator });
}

async function installNews(target) {
  await target.evaluate(html => {
    document.body.insertAdjacentHTML("beforeend", html);
    document.querySelector("#itn-shadow").attachShadow({ mode: "open" }).innerHTML = '<a id="shadow-link" href="/wiki/Shadow">Shadow story</a>';
  }, newsHtml);
}

const visibleNewsLinks = ["image", "book", "author", "booker", "paper", "deep", "timeline", "booker-again", "shadow-link"];

/** find results[i] and locator nth: i name the same node, by default and with includeHidden on both. */
async function assertFindNthParity(target, findArgs, locator, expected) {
  const visible = await findAndNthOrder(target, findArgs, locator);
  assert.deepEqual(visible.nth, expected.visible);
  assert.deepEqual(visible.find, visible.nth, "default find results[i] is default locator nth i");
  const all = await findAndNthOrder(target, { ...findArgs, includeHidden: true }, { ...locator, includeHidden: true });
  assert.deepEqual(all.nth, expected.all);
  assert.deepEqual(all.find, all.nth, "includeHidden find results[i] is includeHidden locator nth i");
}

test("structural queries list find results in locator nth order, which is document order", async () => {
  await installNews(page);
  await assertFindNthParity(page, { selector: "#itn", roles: ["link"] }, { role: "link", within: "css:#itn" },
    { visible: visibleNewsLinks, all: ["hidden", ...visibleNewsLinks] });
});

test("an exact:false text match inside a visible parent survives a hidden child with the same text", async () => {
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend",
    '<ul id="prices"><li id="row">Price: 42 <span id="tip" hidden>Price</span></li></ul>'));
  await assertFindNthParity(page, { selector: "#prices", text: "Price", exact: false },
    { text: "Price", exact: false, within: "css:#prices" }, { visible: ["row"], all: ["tip"] });
});

test("name queries share one order between find and locator nth", async () => {
  await installNews(page);
  await assertFindNthParity(page, { selector: "#itn", roles: ["link"], name: "Booker Prize" },
    { role: "link", name: "Booker Prize", within: "css:#itn" },
    { visible: ["booker", "booker-again"], all: ["hidden", "booker", "booker-again"] });
  assert.deepEqual(await resolve({ role: "link", name: "Booker Prize", within: "css:#itn" }), { matched: 2 });
});

test("fuzzy name and pattern queries list whole, then prefix, then other matches, each in document order", async () => {
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<nav id="prizes">
    <a id="nobel" href="/nobel">Nobel Peace Prize</a><a id="money" href="/money">Prize money</a>
    <a id="winners" href="/prize-winners">Winners</a><a id="prize" href="/prize">Prize</a>
    <a id="booker" href="/booker">Booker Prize</a><a id="money-again" href="/money-2">Prize money</a></nav>`));
  const fuzzy = await findAndNthOrder(page, { selector: "#prizes", roles: ["link"], name: "Prize", exact: false },
    { role: "link", name: "Prize", exact: false, within: "css:#prizes" });
  assert.deepEqual(fuzzy.nth, ["prize", "money", "money-again", "nobel", "booker"]);
  assert.deepEqual(fuzzy.find, fuzzy.nth, "find and locator nth rank fuzzy matches identically");
  const strict = await resolve({ role: "link", name: "Prize", exact: false, within: "css:#prizes" });
  assert.deepEqual(strict, { matched: 5 }, "a best match does not resolve ambiguity without nth");

  const pattern = await findAndNthOrder(page, { selector: "#prizes", roles: ["link"], pattern: "prize" });
  assert.deepEqual(pattern.find, ["prize", "money", "money-again", "nobel", "booker", "winners"]);
  assert.deepEqual(pattern.matchKinds, ["name", "name", "name", "name", "name", "href"],
    "an attribute-only pattern match ranks after name and text matches");
});

test("frame documents use the same find and locator nth order", async () => {
  await page.evaluate(html => {
    const frame = document.createElement("iframe");
    frame.srcdoc = html;
    document.body.append(frame);
  }, newsHtml);
  const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
  await frame.waitForSelector("#itn");
  await installContent(frame);
  await frame.evaluate(() => {
    document.querySelector("#itn-shadow").attachShadow({ mode: "open" }).innerHTML = '<a id="shadow-link" href="/wiki/Shadow">Shadow story</a>';
  });
  await assertFindNthParity(frame, { selector: "#itn", roles: ["link"] }, { role: "link", within: "css:#itn" },
    { visible: visibleNewsLinks, all: ["hidden", ...visibleNewsLinks] });
});

test("invalid queries fail before selection", async () => {
  assert.equal((await resolve({ target: "css:[" })).code, "INVALID_SELECTOR");
  assert.equal((await resolve({ role: "button", nth: -1 })).code, "INVALID_ELEMENT_LOCATOR");
  assert.equal((await resolve({ within: "css:#scope" })).code, "INVALID_ELEMENT_LOCATOR");
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
  const scoped = await resolve({ target: "css:button", within: target });
  assert.equal(scoped.details.target, target, "an invalid within identifies the offending query");
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

const lineHtml = `<main id="lines"><button>Save</button><button>Save</button>
<p>Lead <button>Save</button></p>
<div role="group" aria-label="Pair"><button>Inner</button>
<button>Inner</button></div>
<script>const copy = "<button>Save</button>";
</script><style>
button { color: red }
</style>
<button title="first
second">Multi</button><svg><a href="#vector"><text>Vector</text></a></svg>
<button><svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>Icon</button></main>`;

/** find rows with the read_dom lines of the same scope, both read in one page state. */
async function findWithDomLines(target, findArgs) {
  return target.evaluate(async findArgs => {
    const dom = await window.callContent("readDom", { selector: findArgs.selector, limit: 1000 });
    const found = await window.callContent("findElements", { limit: 100, ...findArgs });
    return { lines: dom.content.split("\n").map(line => line.replace(/^\d+: /, "")), results: found.results };
  }, findArgs);
}

test("find line ranges are each element's own read_dom lines, past duplicates and removed tags", async () => {
  await page.setContent(lineHtml);
  await installContent(page);
  const { lines, results } = await findWithDomLines(page, { selector: "#lines", roles: ["button", "group", "link"] });
  const byText = text => results.filter(item => item.text === text);
  const text = (range) => lines.slice(range[0] - 1, range[1]).join("\n");
  const saves = byText("Save");
  assert.deepEqual(saves.map(item => item.lineRange), [[1, 1], [2, 2], [3, 3]], "identical buttons keep their own lines");
  assert.deepEqual(saves.map(item => lines[item.line - 1]), ["<button>Save</button>", "<button>Save</button>", "<p>Lead <button>Save</button>"]);
  const [group] = results.filter(item => item.role === "group");
  const inner = byText("Inner");
  assert.deepEqual(inner.map(item => item.lineRange), [[6, 6], [7, 7]]);
  assert.deepEqual(group.lineRange, [5, 8], "a container range spans its nested elements");
  assert.equal(text(group.lineRange), '<div role="group" aria-label="Pair">\n<button>Inner</button>\n<button>Inner</button>\n</div>');
  const [multi] = byText("Multi");
  assert.equal(text(multi.lineRange), '<button title="first\nsecond">Multi</button>', "a multi-line attribute starts at its tag");
  const [icon] = byText("Icon");
  assert.equal(text(icon.lineRange), "<button>Icon</button>", "removed svg markup does not extend the range");
  const vector = results.find(item => item.href?.endsWith("#vector"));
  assert.ok(vector);
  assert.equal("line" in vector || "lineRange" in vector, false, "read_dom omits svg content");
  assert.equal(lines.some(line => line.includes("const copy")), false);
  for (const item of results) assert.ok(!("line" in item) || item.line === item.lineRange[0]);
});

test("find line ranges follow the scope root, the page body and frame documents", async () => {
  await page.setContent(lineHtml);
  await installContent(page);
  const body = await findWithDomLines(page, { selector: "body", roles: ["button"], name: "Save" });
  assert.deepEqual(body.results.map(item => item.lineRange), [[2, 2], [3, 3], [4, 4]]);
  assert.equal(body.lines[0], '<main id="lines">');
  const scoped = await findWithDomLines(page, { selector: "#lines > p", roles: ["button"] });
  assert.deepEqual(scoped.results.map(item => item.lineRange), [[1, 1]]);
  assert.equal(scoped.lines[0], "Lead <button>Save</button>");
  const root = await page.evaluate(() => window.callContent("findElements", { selector: "#lines > p", tags: ["p"] }));
  assert.equal(root.results.length, 1);
  assert.equal("lineRange" in root.results[0], false, "read_dom of a scope does not show the scope's own tag");
  await page.evaluate(html => {
    const frame = document.createElement("iframe");
    frame.srcdoc = html;
    document.body.append(frame);
  }, lineHtml);
  const frame = await (await page.locator("iframe").elementHandle()).contentFrame();
  await frame.waitForSelector("#lines");
  await installContent(frame);
  const framed = await findWithDomLines(frame, { selector: "#lines", roles: ["button"], name: "Save" });
  assert.deepEqual(framed.results.map(item => item.lineRange), [[1, 1], [2, 2], [3, 3]]);
});

test("find all returns the limited find fields for every match", async () => {
  await page.setContent(lineHtml);
  await installContent(page);
  const [limited, all] = await page.evaluate(async () => Promise.all([
    window.callContent("findElements", { selector: "#lines", roles: ["button", "group"], limit: 100 }),
    window.callContent("findElements", { selector: "#lines", roles: ["button", "group"], all: true }),
  ]));
  const strip = ({ _elementRef, ...item }) => item;
  assert.ok(limited.results.length > 5);
  assert.deepEqual(all.results.map(strip), limited.results.map(strip));
  for (const item of all.results) {
    assert.ok(item.selector && "obscuredAtCenter" in item && Array.isArray(item.lineRange), JSON.stringify(item));
  }
});

test("absolute selectors equal the per-element document query result on ambiguous markup", async () => {
  await page.setContent(`<div id="dup"><span>one</span></div><div id="dup"><span>two</span></div>
    <ul class="list">${Array.from({ length: 12 }, (_, i) => `<li><a href="/${i}">L${i}</a></li>`).join("")}</ul>
    <section><p class="x:y">colon</p><p class="1st">digit</p><p>plain</p></section>
    <div id="mixed"><div>html</div></div><div id="nest"></div><div id="host"></div>`);
  await installContent(page);
  const result = await page.evaluate(async () => {
    const svgDiv = document.createElementNS("http://www.w3.org/2000/svg", "div");
    document.querySelector("#mixed").append(svgDiv);
    const nested = document.createElement("body");
    nested.innerHTML = '<div id="dup"><span>three</span></div>';
    document.querySelector("#nest").append(nested);
    document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<div id="dup"><span>shadow</span></div><p>own</p>';
    const reference = el => {
      const parts = [];
      let current = el;
      while (current && current !== document.documentElement) {
        if (current.id) {
          const idSelector = `#${CSS.escape(current.id)}`;
          if (current.ownerDocument.querySelectorAll(idSelector).length === 1) { parts.unshift(idSelector); break; }
        }
        let tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(c => c.tagName === current.tagName);
          if (siblings.length > 1) tag += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        if (current.className && typeof current.className === "string") {
          const cls = current.className.split(/\s+/).filter(Boolean)[0];
          if (cls) tag = tag.split(":")[0] + `.${CSS.escape(cls)}` + (tag.includes(":") ? ":" + tag.split(":").slice(1).join(":") : "");
        }
        parts.unshift(tag);
        current = parent;
      }
      const selector = parts.join(" > ");
      if (!selector) return "";
      try {
        const matches = el.ownerDocument.querySelectorAll(selector);
        return matches.length === 1 && matches[0] === el ? selector : "";
      } catch { return ""; }
    };
    const found = await window.callContent("findElements", { all: true, includeHidden: true });
    const nodes = await window.__qzInvoke(null, { action: "resolveElementRefs", elementRefs: found.results.map(item => item._elementRef) });
    const single = [];
    for (const node of nodes) single.push((await window.__qzInvoke(node, { action: "inspectElement" })).selector);
    return found.results.map((item, index) => [item.selector, single[index], reference(nodes[index]), nodes[index].textContent.slice(0, 12)]);
  });
  assert.ok(result.length > 25);
  for (const [batch, single, expected, label] of result) {
    assert.equal(batch, expected, `batch ${label}`);
    assert.equal(single, expected, `single ${label}`);
  }
  assert.ok(result.some(([selector]) => selector === ""), "ambiguous and shadow elements keep an empty selector");
  assert.ok(result.some(([selector]) => selector.includes(":nth-of-type(12)")));
});

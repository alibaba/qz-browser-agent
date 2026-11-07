import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { playwrightDomSources } from "../../scripts/vendor/playwright-dom.mjs";

let browser, page;
test.before(async () => {
  const result = await build({
    entryPoints: ["src/content/dom-semantics.ts"], bundle: true, write: false,
    format: "iife", globalName: "semantics", platform: "browser", plugins: [playwrightDomSources()],
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(`
    <button id="present-button" role="presentation">Save changes</button>
    <a id="none-link" role="none" href="#next">Next page</a>
    <label>Unloaded suggestions<input id="missing-list" list="missing"></label>
    <label>Suggestions<input id="valid-list" list="options"></label><datalist id="options"><option>Alpha</option></datalist>
    <label>Attachment<input id="file" type="file"></label><label>Password<input id="password" type="password"></label>
    <section id="named-section" aria-labelledby="nested-label">Content</section><span id="nested-label"><img alt="Photo region"></span>
    <svg id="named-svg"><title>Map icon</title><path d="M0 0h10v10z"/></svg>
    <table><tr><th id="row-header">Price</th><td>$42</td></tr><tr><th>Stock</th><td>Available</td></tr></table>
    <dl><dt id="term">Price</dt><dd id="definition">42 dollars</dd></dl>
    <input id="transparent" style="opacity:0"><button id="contents" style="display:contents"><span>Visible child</span></button>
    <button id="hidden" hidden>Hidden</button><div style="content-visibility:hidden"><button id="skipped">Skipped</button></div>
    <details><summary id="summary">Expand</summary><button id="collapsed">Collapsed</button></details>
    <div id="shadow-host"></div>`);
  await page.evaluate(() => {
    const host = document.querySelector("#shadow-host");
    host.innerHTML = '<span slot="caption">Slotted action</span>';
    host.attachShadow({ mode: "open" }).innerHTML = `
      <span id="label">Shadow region</span><section id="shadow-section" aria-labelledby="label">Inside</section>
      <button id="slotted"><slot name="caption"></slot></button>`;
  });
  await page.addScriptTag({ content: result.outputFiles[0].text });
});
test.after(async () => { await browser?.close(); });

const observe = id => page.locator(`#${id}`).evaluate(el => ({
  role: semantics.elementAriaRole(el), name: semantics.elementAccessibleName(el), visible: semantics.elementIsVisible(el),
}));

test("roles and names agree with browser locators across native, ARIA and shadow elements", async () => {
  for (const [id, role, name] of [
    ["present-button", "button", "Save changes"], ["none-link", "link", "Next page"],
    ["missing-list", "textbox", "Unloaded suggestions"], ["valid-list", "combobox", "Suggestions"],
    ["file", "button", "Attachment"], ["password", "textbox", "Password"],
    ["named-section", "region", "Photo region"], ["named-svg", "img", "Map icon"],
    ["row-header", "rowheader", "Price"], ["term", "term", ""], ["definition", "definition", ""],
    ["shadow-section", "region", "Shadow region"], ["slotted", "button", "Slotted action"],
  ]) {
    assert.equal(await page.locator(`#${id}`).and(page.getByRole(role, { name, exact: true })).count(), 1, id);
    const actual = await observe(id);
    assert.equal(actual.role, role, id);
    assert.equal(actual.name, name, id);
  }
});

test("rendering visibility follows browser behavior for transparent and boxless controls", async () => {
  for (const [id, expected] of [["transparent", true], ["contents", true], ["hidden", false],
    ["skipped", false], ["summary", true], ["collapsed", false]]) {
    assert.equal(await page.locator(`#${id}`).isVisible(), expected, id);
    assert.equal((await observe(id)).visible, expected, id);
  }
});

test("one observation's caches cannot retain a previous DOM state", async () => {
  const names = await page.evaluate(() => {
    const button = document.querySelector("#present-button");
    const before = semantics.withDomSemantics(() => semantics.elementAccessibleName(button));
    button.textContent = "Saved";
    const after = semantics.withDomSemantics(() => semantics.elementAccessibleName(button));
    return { before, after };
  });
  assert.deepEqual(names, { before: "Save changes", after: "Saved" });
});

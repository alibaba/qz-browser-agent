import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { elementAriaRole } from "../../src/content/implicit-aria-role.js";

const contentScript = readFileSync(new URL("../../src/content/content-script.ts", import.meta.url), "utf8");
assert.match(contentScript, /return elementAriaRole\(el\)/, "find_elements should use the shared implicit role mapping");

function el(tag, options = {}) {
  const { attrs = {}, children = [], ...extra } = options;
  const node = {
    parentElement: null,
    children,
    ...extra,
    tagName: String(tag).toUpperCase(),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? String(attrs[name]) : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function role(tag, options) {
  return elementAriaRole(el(tag, options));
}

const staticRoles = [
  ["article", "article"],
  ["aside", "complementary"],
  ["button", "button"],
  ["details", "group"],
  ["fieldset", "group"],
  ["address", "group"],
  ["hgroup", "group"],
  ["optgroup", "group"],
  ["dialog", "dialog"],
  ["form", "form"],
  ["hr", "separator"],
  ["main", "main"],
  ["meter", "meter"],
  ["nav", "navigation"],
  ["ol", "list"],
  ["ul", "list"],
  ["menu", "list"],
  ["option", "option"],
  ["output", "status"],
  ["p", "paragraph"],
  ["progress", "progressbar"],
  ["table", "table"],
  ["textarea", "textbox"],
  ["blockquote", "blockquote"],
  ["figure", "figure"],
  ["caption", "caption"],
  ["code", "code"],
  ["datalist", "listbox"],
  ["search", "search"],
];
for (const [tag, expected] of staticRoles) {
  assert.equal(role(tag), expected, tag);
}
for (const level of [1, 2, 3, 4, 5, 6]) {
  assert.equal(role(`h${level}`), "heading", `h${level}`);
}

assert.equal(role("a", { attrs: { href: "/docs" } }), "link");
assert.equal(role("a", { attrs: { href: "" } }), "link");
assert.equal(role("a"), "");
assert.equal(role("area", { attrs: { href: "#part" } }), "link");
assert.equal(role("area"), "");
assert.equal(role("div"), "");
assert.equal(role("span"), "");
assert.equal(role("label"), "");

assert.equal(role("img", { attrs: { alt: "Diagram" } }), "img");
assert.equal(role("img"), "img");
assert.equal(role("img", { attrs: { alt: "" } }), "presentation");
assert.equal(role("img", { attrs: { alt: " " } }), "presentation");
assert.equal(role("img", { attrs: { alt: "", title: "Chart" } }), "img");
assert.equal(role("img", { attrs: { alt: "", "aria-label": "Chart" } }), "img");

const inputRoles = [
  ["text", "textbox"],
  ["email", "textbox"],
  ["tel", "textbox"],
  ["url", "textbox"],
  ["password", "textbox"],
  ["search", "searchbox"],
  ["checkbox", "checkbox"],
  ["radio", "radio"],
  ["button", "button"],
  ["submit", "button"],
  ["reset", "button"],
  ["image", "button"],
  ["file", "button"],
  ["range", "slider"],
  ["number", "spinbutton"],
  ["hidden", ""],
  ["color", ""],
  ["date", ""],
  ["datetime-local", ""],
  ["month", ""],
  ["time", ""],
  ["week", ""],
  ["not-a-type", "textbox"],
];
for (const [type, expected] of inputRoles) {
  assert.equal(role("input", { attrs: { type } }), expected, `input ${type}`);
}
assert.equal(role("input"), "textbox");
assert.equal(role("input", { attrs: { type: "TEXT" } }), "textbox");
assert.equal(role("input", { attrs: { type: "email", list: "domains" } }), "combobox");
assert.equal(role("input", { attrs: { type: "search", list: "terms" } }), "combobox");
assert.equal(role("input", { attrs: { type: "url", list: "pages" } }), "combobox");
assert.equal(role("input", { attrs: { type: "number", list: "counts" } }), "spinbutton");

assert.equal(role("select"), "combobox");
assert.equal(role("select", { multiple: true }), "listbox");
assert.equal(role("select", { attrs: { multiple: "" } }), "listbox");
assert.equal(role("select", { size: 2 }), "listbox");
assert.equal(role("select", { attrs: { size: "4" } }), "listbox");
assert.equal(role("select", { attrs: { size: "1" } }), "combobox");
assert.equal(role("div", { isContentEditable: true }), "textbox");
assert.equal(role("h2", { isContentEditable: true }), "heading");

assert.equal(role("h2", { attrs: { role: "tab" } }), "tab");
assert.equal(role("div", { attrs: { role: "Button" } }), "button");
assert.equal(role("h1", { attrs: { role: "button heading" } }), "button");
assert.equal(role("div", { attrs: { role: "foo heading" } }), "heading");
assert.equal(role("h2", { attrs: { role: "presentation heading" } }), "presentation");
assert.equal(role("h2", { attrs: { role: "not-a-role" } }), "heading");
assert.equal(role("h2", { attrs: { role: "" } }), "heading");
assert.equal(role("h2", { attrs: { role: "   " } }), "heading");
assert.equal(role("button", { attrs: { role: "none" } }), "none");
assert.equal(role("h2", { attrs: { role: "doc-subtitle" } }), "doc-subtitle");
assert.equal(role("img", { attrs: { alt: "Diagram", role: "presentation" } }), "presentation");
assert.equal(role("div", { attrs: { role: "image" } }), "image");

const named = el("section", {
  attrs: { "aria-labelledby": "title" },
  ownerDocument: {
    getElementById(id) {
      return id === "title" ? { textContent: "Notes" } : null;
    },
  },
});
assert.equal(elementAriaRole(named), "region");
assert.equal(role("section", { attrs: { "aria-label": "Notes" } }), "region");
assert.equal(role("section", { attrs: { title: "Notes" } }), "region");
assert.equal(role("section"), "");
assert.equal(role("section", { attrs: { "aria-label": "  " } }), "");
const emptyName = el("section", {
  attrs: { "aria-labelledby": "missing" },
  ownerDocument: { getElementById: () => null },
});
assert.equal(elementAriaRole(emptyName), "");

const topHeader = el("header");
el("body", { children: [topHeader] });
assert.equal(elementAriaRole(topHeader), "banner");
const nestedHeader = el("header");
el("article", { children: [nestedHeader] });
assert.equal(elementAriaRole(nestedHeader), "sectionheader");
const mainHeader = el("header");
el("div", { attrs: { role: "Main" }, children: [mainHeader] });
assert.equal(elementAriaRole(mainHeader), "sectionheader");
const regionHeader = el("header");
el("div", { attrs: { role: "foo region" }, children: [regionHeader] });
assert.equal(elementAriaRole(regionHeader), "sectionheader");
const namedRegionHeader = el("header");
el("div", { attrs: { role: "region" }, children: [namedRegionHeader] });
assert.equal(elementAriaRole(namedRegionHeader), "sectionheader");
const topFooter = el("footer");
el("body", { children: [topFooter] });
assert.equal(elementAriaRole(topFooter), "contentinfo");
const nestedFooter = el("footer");
el("nav", { children: [nestedFooter] });
assert.equal(elementAriaRole(nestedFooter), "sectionfooter");

const item = el("li");
el("ul", { children: [item] });
assert.equal(elementAriaRole(item), "listitem");
const ordered = el("li");
el("ol", { children: [ordered] });
assert.equal(elementAriaRole(ordered), "listitem");
const menuItem = el("li");
el("menu", { children: [menuItem] });
assert.equal(elementAriaRole(menuItem), "listitem");
assert.equal(role("li"), "");
const presented = el("li");
el("ul", { attrs: { role: "presentation" }, children: [presented] });
assert.equal(elementAriaRole(presented), "");
const explicitListItem = el("li");
el("div", { attrs: { role: "list" }, children: [explicitListItem] });
assert.equal(elementAriaRole(explicitListItem), "listitem");
const menuRoleItem = el("li");
el("ul", { attrs: { role: "menu" }, children: [menuRoleItem] });
assert.equal(elementAriaRole(menuRoleItem), "");

const nameHeader = el("th");
const valueHeader = el("th");
const rowHeader = el("th", { attrs: { scope: "row" } });
const cell = el("td");
const headRow = el("tr", { children: [nameHeader, valueHeader] });
const bodyRow = el("tr", { children: [rowHeader, cell] });
const head = el("thead", { children: [headRow] });
const body = el("tbody", { children: [bodyRow] });
el("table", { children: [head, body] });
assert.equal(elementAriaRole(headRow), "row");
assert.equal(elementAriaRole(bodyRow), "row");
assert.equal(elementAriaRole(nameHeader), "columnheader");
assert.equal(elementAriaRole(valueHeader), "columnheader");
assert.equal(elementAriaRole(rowHeader), "rowheader");
assert.equal(elementAriaRole(cell), "cell");
assert.equal(elementAriaRole(head), "rowgroup");
assert.equal(elementAriaRole(body), "rowgroup");
assert.equal(role("th", { attrs: { scope: "colgroup" } }), "");
assert.equal(role("td"), "");

const gridCell = el("td");
el("table", { attrs: { role: "grid" }, children: [el("tr", { children: [gridCell] })] });
assert.equal(elementAriaRole(gridCell), "gridcell");
const hiddenCell = el("td");
el("table", { attrs: { role: "presentation" }, children: [el("tr", { children: [hiddenCell] })] });
assert.equal(elementAriaRole(hiddenCell), "");

const laterRowHeader = el("th");
const laterCell = el("td");
const firstDataRow = el("tr", { children: [el("th"), el("td")] });
const laterRow = el("tr", { children: [laterRowHeader, laterCell] });
el("table", { children: [firstDataRow, laterRow] });
assert.equal(elementAriaRole(laterRowHeader), "rowheader");
assert.equal(elementAriaRole(laterCell), "cell");

const disclosure = el("summary");
const extraSummary = el("summary");
el("details", { children: [disclosure, extraSummary] });
assert.equal(elementAriaRole(disclosure), "button");
assert.equal(elementAriaRole(extraSummary), "");
assert.equal(role("summary"), "");

console.log("implicit aria role tests passed");

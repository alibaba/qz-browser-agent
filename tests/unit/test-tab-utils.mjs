import assert from "node:assert/strict";
import {
  formatTab,
  getEffectiveTabUrl,
  isWebTab,
  isPageTab,
} from "../../src/shared/tab-utils.js";

const pendingWebTab = {
  id: 7,
  url: "about:blank",
  pendingUrl: "https://example.test/loading",
  title: "about:blank",
};

assert.equal(getEffectiveTabUrl(pendingWebTab), "https://example.test/loading");
assert.equal(isWebTab(pendingWebTab), true);
assert.equal(formatTab(pendingWebTab).url, "https://example.test/loading");
assert.equal(
  formatTab(pendingWebTab).title,
  "",
  "a pending web navigation must not pair its target URL with the temporary page title",
);

assert.equal(
  formatTab({ id: 10, url: "https://example.test/loading", title: "about:blank" }).title,
  "",
  "an internal-page title must not survive after the web URL commits",
);
assert.equal(
  formatTab({ id: 11, url: "https://example.test/ready", title: "Ready" }).title,
  "Ready",
  "a committed web page keeps its real title",
);

const navigatingWebTab = {
  id: 8,
  url: "https://example.test/current",
  pendingUrl: "https://example.test/next",
};
assert.equal(
  getEffectiveTabUrl(navigatingWebTab),
  "https://example.test/current",
  "the committed web page remains the effective page until the next navigation commits",
);

const internalTab = { id: 9, url: "chrome://extensions", pendingUrl: "" };
assert.equal(getEffectiveTabUrl(internalTab), "chrome://extensions");
assert.equal(isWebTab(internalTab), false);

console.log("tab URL semantics tests passed");

const invisiblePrefix = "\u200b\u202c\ufeff\u200c\u200d\u2061\u2062\u2063 ".repeat(30);
for (const title of ["「Demo Playground」玩法攻略 · 示例文档", "می\u200cروم", "👩\u200d💻 开发笔记", "\u200fالعربية"]) {
  const tab = Object.freeze({ id: 12, url: "https://example.test/doc", title: invisiblePrefix + title });
  assert.equal(formatTab(tab).title, title, "invisible prefixes must not consume the visible title budget");
  assert.equal(tab.title, invisiblePrefix + title, "formatting must preserve the browser's original title");
  assert.equal(formatTab(tab, { titleLimit: 8 }).title, title.slice(0, 8), "custom limits apply to the cleaned title");
}
assert.equal(formatTab({ id: 13, url: "https://example.test/doc", title: invisiblePrefix }).title, "");
assert.equal(formatTab({ id: 14, url: "https://example.test/doc", title: "x".repeat(100) }).title, "x".repeat(80));

const fileTab = { id: 15, url: "file:///tmp/local%20report.html", pendingUrl: "https://old.example/", title: "Local report" };
assert.equal(isWebTab(fileTab), false, "Site Skill matching remains HTTP-only");
assert.equal(isPageTab(fileTab), true);
assert.equal(formatTab(fileTab).url, fileTab.url, "committed file URL wins over stale HTTP metadata");
assert.equal(isPageTab(internalTab), false);
assert.equal(isPageTab({ url: "about:blank", pendingUrl: fileTab.url }), true);

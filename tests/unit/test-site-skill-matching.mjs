import assert from "node:assert/strict";
import test from "node:test";
import { matchSiteSkillsForUrls } from "../../src/shared/skills/skill-utils.js";
import { normalizeSkillManifest, skillActivationMatchesUrl, skillMatchesContext } from "../../src/shared/skills/skill-manifest.js";

const skills = [
  {
    name: "taobao-order",
    description: "订单页操作经验",
    scope: "site",
    domains: ["taobao.com"],
    urlPatterns: ["/order/"],
  },
  {
    name: "taobao-common",
    description: "淘宝通用经验",
    scope: "site",
    domains: ["taobao.com"],
  },
  {
    name: "xiaohongshu-note",
    description: "小红书笔记经验",
    scope: "site",
    domains: ["xiaohongshu.com"],
    urlPatterns: ["/explore/"],
  },
  {
    name: "disabled-skill",
    description: "禁用 skill 不应出现",
    scope: "site",
    status: "disabled",
    domains: ["taobao.com"],
  },
  {
    name: "resident-taobao",
    description: "常驻说明不应参与站点匹配",
    scope: "resident",
    domains: ["taobao.com"],
  },
];

const matched = matchSiteSkillsForUrls(skills, [
  "https://buyer.taobao.com/order/detail?id=1",
  "https://www.xiaohongshu.com/explore/abc",
  "https://buyer.taobao.com/order/detail?id=1",
], { limit: 5 });

assert.deepEqual(matched.map(item => item.name), [
  "xiaohongshu-note",
  "taobao-order",
  "taobao-common",
]);
assert.equal(matched.find(item => item.name === "taobao-order").matchedUrls.length, 1);
assert.ok(!matched.some(item => item.name === "disabled-skill"));
assert.ok(!matched.some(item => item.name === "resident-taobao"));

console.log("site skill multi-url matching ok");

test("site recommendations and automatic tools agree on supported URL rules", () => {
  const cases = [
    [{ domains: ["example.test"] }, "https://shop.example.test/item/1", true],
    [{ domains: ["*.example.test"] }, "https://example.test/item/1", true],
    [{ domains: ["*.example.test"] }, "https://shop.example.test/item/1", true],
    [{ domains: [".example.test"] }, "https://shop.example.test/item/1", true],
    [{ domains: ["HTTPS://EXAMPLE.TEST/path"] }, "https://shop.example.test/", true],
    [{}, "https://notexample.test/item/1", false],
    [{}, "https://example.test.evil.test/item/1", false],
    [{ urlPatterns: ["regex:^https://shop\\.example\\.test/item/\\d+$"] }, "https://shop.example.test/item/12", true],
    [{ urlPatterns: ["/^https://shop\\.example\\.test/item/\\d+$/"] }, "https://shop.example.test/item/12", true],
    [{ urlPatterns: ["/item/*"] }, "https://example.test/catalog/item/12", true],
    [{ urlPatterns: ["https://*.example.test/item/*"] }, "https://shop.example.test/item/12", true],
    [{ urlPatterns: ["/v1.0/*"] }, "https://example.test/v1X0/item", false],
    [{ urlPatterns: ["/v1.0/*"] }, "https://example.test/v1.0/item", true],
    [{ urlPatterns: ["?kind=item"] }, "https://example.test/search?kind=item", true],
    [{ urlPatterns: ["regex:["] }, "https://example.test/item/1", false],
    [{}, "ftp://example.test/item/1", false],
    [{}, "not a URL", false],
  ];
  for (const [rules, url, expected] of cases) {
    const skill = { name: "matching-fixture", scope: "site", domains: ["example.test"], ...rules };
    const plugin = normalizeSkillManifest({ id: skill.name }, skill);
    const label = JSON.stringify({ rules, url });
    assert.equal(matchSiteSkillsForUrls([skill], [url]).length > 0, expected, `discovery: ${label}`);
    assert.equal(skillMatchesContext(plugin, { pageUrl: url }), expected, `activation: ${label}`);
    assert.equal(skillMatchesContext(plugin, { taskSiteTabs: [{ url }] }), expected, `visited: ${label}`);
  }
});

test("exclusions retain their coverage for both recommendations and automatic tools", () => {
  for (const excludePattern of ["private/*", "/private/*", "regex:/private/", "/\\/private\\//", "https://example.test/*/private/*"]) {
    const skill = { name: "excluded-fixture", scope: "site", domains: ["example.test"],
      urlPatterns: ["https://example.test/*"], excludePatterns: [excludePattern] };
    const plugin = normalizeSkillManifest({ id: skill.name }, skill);
    const url = "https://example.test/account/private/details";
    assert.deepEqual(matchSiteSkillsForUrls([skill], [url]), [], excludePattern);
    assert.equal(skillMatchesContext(plugin, { pageUrl: url }), false, excludePattern);
    assert.equal(skillMatchesContext(plugin, { pageUrl: url, loadedPluginSkillNames: [skill.name] }), true,
      "explicit loading still takes precedence over automatic activation");
    assert.equal(skillMatchesContext({ ...plugin, status: "disabled" }, { pageUrl: url, loadedPluginSkillNames: [skill.name] }), false);
  }
});

test("domain-free manifest rules retain URL filtering without recommending unscoped site records", () => {
  assert.equal(skillActivationMatchesUrl({ urlPatterns: ["/docs/*"] }, "https://example.test/docs/intro"), true);
  assert.equal(skillActivationMatchesUrl({ urlPatterns: ["/docs/*"] }, "https://example.test/products/1"), false);
  assert.deepEqual(matchSiteSkillsForUrls([{ name: "missing-domain", scope: "site" }], ["https://example.test/"]), []);
});

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import * as zh from "../../src/capabilities/skills/prompts/site-author-zh-CN.js";
import * as en from "../../src/capabilities/skills/prompts/site-author-en.js";

const blocks = (content, language) => [...content.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```", "g"))].map(match => match[1]);
const withoutCopy = value => Array.isArray(value) ? value.map(withoutCopy)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["displayName", "title", "description", "label", "userJob"].includes(key))
    .map(([key, child]) => [key, withoutCopy(child)])) : value;

test("site Skill examples preserve their executable contracts across languages", async () => {
  assert.doesNotMatch(en.content, /\p{Script=Han}/u);
  const chineseExamples = blocks(zh.content, "json").map(text => JSON.parse(text));
  const englishExamples = blocks(en.content, "json").map(text => JSON.parse(text));
  assert.equal(englishExamples.length, 2);
  assert.deepEqual(withoutCopy(englishExamples), withoutCopy(chineseExamples));

  for (const [language, { content }] of Object.entries({ zh, en })) {
    const source = blocks(content, "js").find(code => code.includes("const rawLimit"));
    assert.ok(source, `${language} includes a runnable collection example`);
    const run = async (args, response) => {
      let requests = 0;
      const script = vm.runInNewContext(`(async () => {${source}\n})`, {
        args: { tabRef: 'research', ...args },
        qz: { tab(tabRef) {
          assert.notEqual(args.limit, 51, 'reject invalid input before page access');
          assert.equal(tabRef, 'research');
          return { async evaluate(code, pageArgs) {
            const pageScript = vm.runInNewContext(`(${code.toString()})`, {
              URL, location: { href: "https://example.com/list" },
              fetch: async (url, options) => {
                assert.equal(url, 'https://example.com/api/hot');
                assert.equal(options.credentials, 'include');
                requests += 1;
                return response;
              },
            });
            return pageScript(pageArgs);
          } };
        } },
      });
      return { result: JSON.parse(JSON.stringify(await script())), requests };
    };
    await assert.rejects(run({ limit: 51 }), { code: "ARGUMENT" });
    await assert.rejects(run({ limit: 3 }, { status: 401, ok: false }), /登录|sign-in/i);
    await assert.rejects(run({ limit: 3 }, { status: 500, ok: false }), /HTTP 500/);
    await assert.rejects(run({}, { status: 200, ok: true, json: async () => ({}) }), /Expected data.items array/);
    const empty = await run({}, { status: 200, ok: true, json: async () => ({ data: { items: [] } }) });
    assert.equal(empty.result.count, 0);
    assert.deepEqual(empty.result.rows, []);
    assert.ok(empty.result.emptyReason);

    const valid = await run({ limit: 1 }, { status: 200, ok: true, json: async () => ({ data: { items: [
      { title: "  Sample  ", author: "A", url: "/item/1" },
      { title: "Second", url: "/item/2" },
    ] } }) });
    assert.deepEqual(valid.result, { count: 1,
      rows: [{ rank: 1, title: "Sample", author: "A", url: "https://example.com/item/1" }], emptyReason: null });
  }
});

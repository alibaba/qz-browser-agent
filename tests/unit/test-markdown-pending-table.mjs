import assert from "node:assert/strict";
import test from "node:test";
import { loadMarkdownParser } from "../support/markdown-parser-fixture.mjs";

const createParser = loadMarkdownParser();

test("pending table start stays within the first paragraph", () => {
  const start = createParser("").defaults.extensions.startBlock[0];
  assert.equal(start("intro\n| header"), 6);
  assert.equal(start("intro\n| header\n\nafter"), 6);
  assert.equal(start("intro without a pipe"), undefined);
  for (const blank of ["\n\n", "\n \n", "\n\t\n", "\n \t \n"]) {
    assert.equal(start(`intro${blank}| header`), undefined);
    assert.equal(start(`intro${blank}next paragraph\n| header`), undefined);
  }
});

test("bounded table start preserves every streaming prefix of mixed blocks", t => {
  const previousDocument = globalThis.document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  // Match the text-only DOM fixture in test-session-image-storage.mjs.
  globalThis.document = { createElement: () => ({ textContent: "", get innerHTML() {
    return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  } }) };
  const documents = [
    "说明：\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文",
    "first\n \t\nsecond\n| a | b |\n| - | - |\n| 1 | 2 |",
    "paragraph\n| literal prose\ncontinuation\n\nend",
    "```text\n| a | b |\n| - | - |\n```\n\ntext\n| x",
    "> intro\n> | a | b |\n> | - | - |\n> | 1 | 2 |\n\nend",
    "1. first\n   intro\n   | a | b |\n   | - | - |\n   | 1 | 2 |\n2. next",
    "`a | b`\n\\| escaped\n| literal `x|y`\nend",
    "<div>\n| html\n</div>\n\ntext\n| z",
    "**bold** and ~~deleted~~\n\n[link](https://example.invalid)\n| x",
    "intro\n`<tag> | unfinished",
  ];
  for (const document of documents) for (let end = 0; end <= document.length; end += 1) {
    const source = document.slice(0, end);
    const bounded = createParser(source);
    const unbounded = createParser(source);
    // Reproduce the previous hint without replacing any production tokenizer.
    unbounded.defaults.extensions.startBlock[0] = source => {
      const index = source.indexOf("\n|");
      return index < 0 ? undefined : index + 1;
    };
    const options = { breaks: true, async: false };
    assert.equal(bounded.parse(source, options), unbounded.parse(source, options), JSON.stringify(source));
  }
});

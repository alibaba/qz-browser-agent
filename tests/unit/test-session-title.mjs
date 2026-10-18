import assert from "node:assert/strict";
import {
  createSessionTitle,
  getConversationPreview,
  serializeConversation,
} from "../../src/shared/session/session-codec.js";

const englishTitle = "Luxembourg City 3-day cultural itinerary with museum opening hours";
assert.equal(createSessionTitle(englishTitle), englishTitle);
assert.equal(createSessionTitle("卢森堡三日文化漫游"), "卢森堡三日文化漫游");
assert.equal(createSessionTitle("  Research\n  museum hours  "), "Research museum hours");
assert.equal(createSessionTitle("Museum hours https://example.test/visit"), "Museum hours");
assert.equal(createSessionTitle("Museum hours\n\n[当前页面] private page context"), "Museum hours");
assert.equal(getConversationPreview(serializeConversation([
  { role: "user", content: englishTitle },
])), englishTitle);

const completeWords = "Compare ".repeat(14).trim();
assert.equal(completeWords.length, 111);
assert.equal(createSessionTitle(`${completeWords} international museums`), completeWords);
assert.equal(createSessionTitle(`${"a".repeat(119)} more`), "a".repeat(119));
assert.equal(createSessionTitle(`${"a".repeat(120)} more`), "a".repeat(120));
assert.equal(createSessionTitle("a".repeat(121)), "a".repeat(120));
assert.equal(createSessionTitle("文".repeat(121)), "文".repeat(120));
assert.equal(createSessionTitle("😀".repeat(61)), "😀".repeat(60));
assert.equal(createSessionTitle("e\u0301".repeat(61)), "e\u0301".repeat(60));
assert.equal(createSessionTitle("  "), createSessionTitle(null));

console.log("session title normalization tests passed");

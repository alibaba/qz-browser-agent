import assert from "node:assert/strict";
import { createSessionTranscript } from "../../src/background/session/transcript.js";
import { createSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";

const summaries = [];
const records = new Map([
  ["stored", createSessionRecord(
    serializeConversation([{ role: "assistant", content: "stored conversation" }]),
    [{ type: "tool", name: "alias_tool", phase: "done" }],
  )],
  ["record-only", createSessionRecord(
    serializeConversation([{ role: "assistant", content: "record" }]),
    [],
  )],
]);
const active = new Map([["active", [{ role: "assistant", content: "active" }]]]);
let exports = 0;
const liveEntry = { agent: { exportSession: () => { exports++; return [{ role: "assistant", content: "live" }]; } } };
const transcript = createSessionTranscript({
  repository: {
    readRecord: async id => records.get(id) || null,
    readActiveConversation: async id => active.get(id) || null,
  },
  supervisor: {
    peekEntry: id => id === "fallback" ? liveEntry : null,
  },
  getLiveAgentEntry: async id => id === "live" ? liveEntry : null,
  normalizeSessionId: value => String(value || "").trim(),
  resolveToolDefinition: name => name === "alias_tool" ? { name } : null,
  getToolIdentity: () => ({
    capabilityId: "canonical_tool",
    title: "Canonical Tool",
    familyId: "family",
    familyTitle: "Family",
  }),
  scheduleListSummaryPatch: (...args) => summaries.push(args),
});

const hydrated = await transcript.hydrate("stored");
assert.equal(hydrated[0].capabilityId, "canonical_tool");
assert.equal(hydrated[0].title, "Canonical Tool");
assert.equal(await transcript.get("stored"), hydrated);

const changed = transcript.recordEvent("fallback", {
  type: "message_end",
  message: { role: "assistant", content: "answer" },
});
assert.equal(changed, true);
assert.equal(transcript.getCached("fallback").at(-1).content, "answer");
assert.equal(summaries.length, 1);
assert.equal(summaries[0][0], "fallback");
const exportsAfterSeed = exports;
transcript.recordEvent("fallback", { type: "message_update", text: "next token" });
assert.equal(exports, exportsAfterSeed, "stream deltas must not re-export the full image history when the transcript cache exists");

assert.deepEqual(await transcript.getConversation("live"), [{ role: "assistant", content: "live" }]);
assert.deepEqual(await transcript.getConversation("active"), [{ role: "assistant", content: "active" }]);
assert.equal((await transcript.getConversation("record-only")).type, "conversation");
const provided = [{ role: "user", content: "provided" }];
assert.equal(await transcript.getConversation("stored", provided), provided);

const grouped = transcript.set("group", [{
  type: "tool-group",
  tools: [{ type: "tool", name: "alias_tool" }],
}]);
assert.equal(grouped[0].tools[0].capabilityId, "canonical_tool");
assert.equal(transcript.remove("group"), true);
assert.deepEqual(transcript.getCached("group"), []);

const previous = [
  { role: "user", content: "previous question", clientMessageId: "previous" },
  { role: "assistant", content: "previous answer" },
];
const checkpoint = serializeConversation([
  ...previous,
  { role: "user", content: "follow-up", clientMessageId: "follow-up" },
  { role: "assistant", content: "completed before restart" },
]);
records.set("interrupted", createSessionRecord(serializeConversation(previous), [
  { type: "user", text: "previous question", clientMessageId: "previous" },
  { type: "thinking", text: "preserved thinking" },
  { type: "assistant", content: "previous answer" },
]));
active.set("interrupted", checkpoint);
for (const supplied of [null, checkpoint]) {
  transcript.remove("interrupted");
  const restored = await transcript.hydrate("interrupted", supplied);
  assert.deepEqual(restored.map(entry => entry.text || entry.content), [
    "previous question", "preserved thinking", "previous answer", "follow-up", "completed before restart",
  ]);
  assert.equal(await transcript.get("interrupted"), restored, "later reads reuse the complete recovered projection");
}

console.log("session transcript tests passed");

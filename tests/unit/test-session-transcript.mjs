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
const runtimes = new Map();
let exports = 0;
const liveEntry = { agent: { exportSession: () => { exports++; return [{ role: "assistant", content: "live" }]; } } };
const transcript = createSessionTranscript({
  repository: {
    readRecord: async id => records.get(id) || null,
    readActiveConversation: async id => active.get(id) || null,
  },
  supervisor: {
    peekEntry: id => id === "fallback" ? liveEntry : null,
    getRuntime: id => runtimes.get(id),
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
records.set("interrupted", createSessionRecord(checkpoint, [
  { type: "user", text: "previous question", clientMessageId: "previous" },
  { type: "thinking", text: "preserved thinking" },
  { type: "assistant", content: "previous answer" },
  { type: "user", text: "follow-up", clientMessageId: "follow-up", runId: "recovered-run" },
  { type: "assistant", content: "completed before restart", runId: "recovered-run" },
]));
active.set("interrupted", checkpoint);
runtimes.set("interrupted", {
  status: "interrupted", runId: "recovered-run", reason: "service_worker_restarted",
  endedAt: "2026-10-20 12:00:00",
});
for (const supplied of [null, checkpoint]) {
  transcript.remove("interrupted");
  const restored = await transcript.hydrate("interrupted", supplied);
  assert.deepEqual(restored.slice(0, -1).map(entry => entry.text || entry.content), [
    "previous question", "preserved thinking", "previous answer", "follow-up", "completed before restart",
  ]);
  assert.equal(restored.at(-1).type, "run-status");
  assert.equal(restored.at(-1).status, "interrupted");
  assert.equal(restored.at(-1).runId, "recovered-run");
  assert.equal(restored.at(-1).timestamp, "2026-10-20 12:00:00");
  assert.equal(await transcript.get("interrupted"), restored, "later reads reuse the complete recovered projection");
}
records.set("interrupted", createSessionRecord(checkpoint, await transcript.get("interrupted")));
transcript.remove("interrupted");
assert.equal((await transcript.hydrate("interrupted")).filter(entry => entry.type === "run-status").length, 1,
  "rehydrating an already saved interruption must not duplicate the notice");
runtimes.set("interrupted", { status: "running", runId: "next-run" });
transcript.recordEvent("interrupted", {
  type: "message_start", runId: "next-run",
  message: { role: "user", content: "continue", clientMessageId: "continue" },
});
assert.equal((await transcript.get("interrupted")).at(-2).runId, "recovered-run",
  "a new run keeps the interruption notice before its new user message");
const continued = serializeConversation([
  ...checkpoint.entries.map(entry => entry.message),
  { role: "user", content: "continue", clientMessageId: "continue" },
]);
records.set("interrupted", createSessionRecord(continued, await transcript.get("interrupted")));
active.set("interrupted", continued);
transcript.remove("interrupted");
const reopened = await transcript.hydrate("interrupted");
assert.equal(reopened.at(-2).runId, "recovered-run", "saving and reopening keeps the old notice before the new round");
assert.equal(reopened.at(-1).clientMessageId, "continue");
assert.equal(reopened.filter(entry => entry.type === "run-status").length, 1);

console.log("session transcript tests passed");

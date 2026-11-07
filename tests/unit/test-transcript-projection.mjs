import assert from "node:assert/strict";
import test from "node:test";

import { createTranscriptProjection } from "../../src/sidepanel/features/chat/transcript/projection.js";
import { groupConsecutiveToolTranscriptEntries } from "../../src/sidepanel/tools/tool-timeline-renderer.js";

test("protocol transcript keys stay stable while streamed content changes", () => {
  const projection = createTranscriptProjection();
  const source = Array.from({ length: 12 }, (_, index) => ({
    type: index % 2 === 0 ? "thinking" : "assistant",
    runId: "run-without-entry-ids",
    eventSeq: index + 1,
    streaming: true,
    text: `thinking ${index}`,
    content: `assistant ${index}`,
  }));
  const first = structuredClone(source);
  const second = structuredClone(source);
  second[0].text = "streaming content changed";
  second[1].content = "streaming content changed";

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  assert.deepEqual(
    second.map(entry => entry._uiKey),
    first.map(entry => entry._uiKey),
  );
  assert.equal(new Set(first.map(entry => entry._uiKey)).size, source.length);
  assert.ok(first.every(entry => /:event:\d+$/.test(entry._uiKey)));
});

test("identity-poor legacy keys survive clone and canonical reordering", () => {
  const projection = createTranscriptProjection();
  const notes = Array.from({ length: 12 }, (_, index) => ({
    type: "note",
    text: `legacy note ${index + 1}`,
    ...(index === 0 ? { _uiKey: "session-a:entry:91" } : {}),
  }));
  const tool = { type: "tool", runId: "run-a", toolCallId: "call-a" };
  const first = structuredClone([...notes, tool]);
  const second = structuredClone([tool, ...notes]);

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  const firstNoteKeys = first.filter(entry => entry.type === "note").map(entry => entry._uiKey);
  const secondNoteKeys = second.filter(entry => entry.type === "note").map(entry => entry._uiKey);
  assert.deepEqual(secondNoteKeys, firstNoteKeys);
  assert.equal(new Set(firstNoteKeys).size, notes.length);
  assert.ok(firstNoteKeys.every(key => /^session-a:note:legacy:/.test(key)));
});

test("duplicate protocol identities receive deterministic suffixes", () => {
  const projection = createTranscriptProjection();
  const source = [
    { type: "tool", runId: "run-a", toolCallId: "call-a" },
    { type: "tool", runId: "run-a", toolCallId: "call-a" },
  ];
  const first = structuredClone(source);
  const second = structuredClone(source);

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  assert.deepEqual(
    first.map(entry => entry._uiKey),
    [
      "session-a:tool:run-a:call-a",
      "session-a:tool:run-a:call-a:duplicate:2",
    ],
  );
  assert.deepEqual(second.map(entry => entry._uiKey), first.map(entry => entry._uiKey));
});

test("direct drive lists each tool call instead of one timeline group", () => {
  const tools = [
    { type: "tool", runId: "drive-1", toolCallId: "open", name: "open_tab", timestamp: "2026-11-01 10:00:00" },
    { type: "tool", runId: "drive-1", toolCallId: "shot", name: "screenshot", timestamp: "2026-11-01 10:00:01" },
  ];
  const grouped = groupConsecutiveToolTranscriptEntries(structuredClone(tools));
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].type, "tool-group");
  assert.equal(grouped[0].entries.length, 2);

  const flat = createTranscriptProjection({
    groupTools: () => false,
  }).uiHistory(structuredClone(tools), { sessionId: "drive" });
  assert.deepEqual(flat.map(entry => [entry.type, entry.name]), [
    ["tool", "open_tab"],
    ["tool", "screenshot"],
  ]);
  assert.notEqual(flat[0]._toolPresentationAnchor, flat[1]._toolPresentationAnchor);
  assert.equal(flat.every(entry => entry.type !== "tool-group"), true);

  const ordinary = createTranscriptProjection().uiHistory(structuredClone(tools), { sessionId: "chat" });
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].type, "tool-group");
});

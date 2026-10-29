import assert from "node:assert/strict";
import test from "node:test";
import { createScrollFuzz } from "../benchmarks/conversation-render/tools/scroll-fuzz.mjs";

test("scroll fuzz seeds reproduce directions, distances and pauses", () => {
  const series = seed => { const next = createScrollFuzz(seed); return Array.from({ length: 40 }, next); };
  const first = series(12345);
  assert.deepEqual(first, series(12345));
  assert.notDeepEqual(first, series(12346));
  for (const plan of first) {
    assert.ok(plan.deltas[0] < 0);
    assert.ok(plan.deltas.some(delta => delta > 0));
    assert.ok(plan.deltas.every(delta => Math.abs(delta) >= 0.12 && Math.abs(delta) <= 0.77));
    assert.ok(plan.holdMs >= 80 && plan.holdMs <= 320);
    assert.ok(plan.gapMs >= 16 && plan.gapMs <= 80);
  }
});

test("invalid seeds cannot silently produce non-random plans", () => {
  for (const seed of [0, -1, 1.1, NaN, Infinity, 2 ** 32]) assert.throws(() => createScrollFuzz(seed));
});

const { assistantStreamPlan, analyzeAssistantStreamFrames } = await import("../support/assistant-stream-fuzz.mjs");

test("assistant stream seeds vary chunk boundaries and delivery delays", () => {
  const first = assistantStreamPlan(12345);
  assert.deepEqual(first, assistantStreamPlan(12345));
  assert.notDeepEqual(first.chunks, assistantStreamPlan(12346).chunks);
  assert.equal(first.chunks.at(-1).length, first.transcript.at(-1).content.length);
  assert.ok(new Set(first.chunks.map(c => c.delayMs)).size > 10);
  assert.throws(() => assistantStreamPlan(0));
});

test("tail following cannot hide a content shrink behind a zero tail gap", () => {
  const frame = { phase: "tail", top: 100, tailGap: 0, height: 700, client: 600, width: 400, contentLength: 20 };
  const frames = [frame, { ...frame, top: 79, height: 679, contentLength: 21 }, { ...frame, contentLength: 22 }];
  const result = analyzeAssistantStreamFrames(frames);
  assert.equal(result.failures[0].kind, "tail-backward");
  assert.equal(result.failures[0].delta, -21);
  assert.equal(result.coverage.tailContentChanges, 2);
});

test("stream geometry distinguishes user motion, viewport changes and stolen reading position", () => {
  const tail = { phase: "tail", top: 100, tailGap: 0, client: 600, width: 400, contentLength: 20 };
  assert.equal(analyzeAssistantStreamFrames([tail, { ...tail, top: 70, client: 630 }]).failures.length, 0);
  assert.equal(analyzeAssistantStreamFrames([tail, { ...tail, phase: "interaction", top: 70 }]).failures.length, 0);
  const reading = { ...tail, phase: "reading", anchorConnected: true, anchorTop: 10, anchorBaseline: 10 };
  const result = analyzeAssistantStreamFrames([reading, { ...reading, contentLength: 21, anchorTop: 12 }]);
  assert.equal(result.failures[0].kind, "reading-anchor");
  assert.equal(result.coverage.readingContentChanges, 1);
});

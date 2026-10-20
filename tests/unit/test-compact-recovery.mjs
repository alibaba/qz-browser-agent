import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionRecord,
  readSessionRecord,
  updateTranscriptWithAgentEvent,
} from "../../src/shared/session/session-codec.js";

const roundTrip = transcript => readSessionRecord(createSessionRecord(null, transcript)).transcript;
const start = () => updateTranscriptWithAgentEvent([], {
  type: "context_compaction_start", runId: "compact-run", compactId: "pending",
  inputTokensBefore: 49000, contextWindow: 64000,
}).transcript[0];

test("running compact snapshots retain their streaming marker", () => {
  const restored = roundTrip([start()])[0];
  assert.equal(restored.status, "running");
  assert.equal(restored.streaming, true);
});

for (const legacy of [false, true]) {
  test(`interrupted recovery settles compact cards across continuation and restart (legacy=${legacy})`, () => {
    const running = { ...start(), summary: "已生成的部分摘要" };
    if (legacy) delete running.streaming;
    const snapshot = roundTrip([
      { type: "compact", compactId: "finished", status: "done", summary: "之前已完成的摘要" },
      running,
    ]);
    const before = structuredClone(snapshot);
    snapshot.forEach(Object.freeze);
    const event = {
      type: "state", runId: "compact-run", status: "interrupted", isStreaming: false,
      runtime: { status: "interrupted", running: false, runId: "compact-run", reason: "service_worker_restarted" },
    };
    const recovered = updateTranscriptWithAgentEvent(snapshot, event);
    const card = recovered.transcript.find(entry => entry.compactId === "pending");
    assert.equal(recovered.changed, true);
    assert.equal(card.status, "aborted");
    assert.equal(card.streaming, undefined);
    assert.equal(card.summary, running.summary);
    assert.equal(card.inputTokensBefore, 49000);
    assert.ok(card.endedAt);
    assert.strictEqual(recovered.transcript[0], snapshot[0], "completed cards stay unchanged");
    assert.deepEqual(snapshot, before, "recovery does not mutate the stored snapshot");

    let transcript = roundTrip(recovered.transcript);
    assert.equal(updateTranscriptWithAgentEvent(transcript, event).changed, false, "repeated recovery is idempotent");
    for (const next of [
      { type: "message_start", runId: "next-run", message: { role: "user", content: "继续" } },
      { type: "message_end", runId: "next-run", message: { role: "assistant", content: "已继续处理" } },
      { type: "agent_end", runId: "next-run" },
    ]) transcript = updateTranscriptWithAgentEvent(transcript, next).transcript;
    transcript = updateTranscriptWithAgentEvent(roundTrip(transcript), {
      type: "state", runId: "next-run", status: "completed", runtime: { status: "completed" },
    }).transcript;
    assert.deepEqual(transcript.find(entry => entry.compactId === "pending"), card);
    assert.deepEqual(transcript.find(entry => entry.compactId === "finished"), before[0]);
    assert.equal(transcript.some(entry => entry.type === "compact" && (entry.status === "running" || entry.streaming)), false);
  });
}

import { imageTranscript } from "./markdown-stream-fixture.mjs";

/** Vary the stream itself as well as the input; every plan can be replayed by seed. */
export function assistantStreamPlan(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff) throw Error("assistant stream seed must be a positive uint32");
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const transcript = imageTranscript();
  const answer = transcript.at(-1);
  // Give concurrent clicks and history reading time to run before the table arrives.
  answer.content = Array.from({ length: 8 }, (_, index) => (
    `**第 ${index + 1} 项核对**：正在整理图片及页面来源。图片对应 DOM 中的 \`<figure>/<img>\`，请保留各景点的说明、尺寸和原始链接，随后给出汇总表格。`
  )).join("\n\n") + "\n\n" + answer.content;
  const chunks = [];
  for (let length = 0; length < answer.content.length;) {
    length = Math.min(answer.content.length, length + 1 + Math.floor(random() * 15));
    chunks.push({ length, delayMs: 16 + Math.floor(random() * 25) });
  }
  return { seed, transcript, chunks, toolIndex: random() < 0.5 ? 0 : 3, readingMs: 350 + Math.floor(random() * 250) };
}

/** Tail distance alone cannot detect a viewport that follows shrinking Markdown upward. */
export function analyzeAssistantStreamFrames(frames) {
  const failures = [];
  const coverage = { tailFrames: 0, readingFrames: 0, tailContentChanges: 0, readingContentChanges: 0, viewportChanges: 0 };
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1], after = frames[i];
    if (after.phase !== before.phase || !["tail", "reading"].includes(after.phase)) continue;
    if (before.client !== after.client || before.width !== after.width) { coverage.viewportChanges += 1; continue; }
    const changed = after.contentLength !== before.contentLength;
    coverage[`${after.phase}Frames`] += 1;
    if (changed) coverage[`${after.phase}ContentChanges`] += 1;
    if (after.phase === "tail") {
      if (after.top < before.top - 0.5) failures.push({ kind: "tail-backward", index: i, delta: after.top - before.top, before, after });
      if (after.tailGap > 2 && before.tailGap > 2) failures.push({ kind: "tail-lost", index: i, before, after });
    } else if (!after.anchorConnected || Math.abs(after.anchorTop - after.anchorBaseline) > 0.5) {
      failures.push({ kind: "reading-anchor", index: i, before, after });
    }
  }
  return { coverage, failures };
}

import { readFileSync } from "node:fs";
import { expect, test } from "./sidepanel-fixtures.mjs";
import { assistantStreamPlan, analyzeAssistantStreamFrames } from "../support/assistant-stream-fuzz.mjs";

const seedOffset = Number(process.env.QINGZHOU_ASSISTANT_FUZZ_SEED_OFFSET || 0);
for (const [index, width] of [360, 430, 560].entries()) for (const readHistory of [false, true]) {
  const seed = 0x51f15e + seedOffset + index * 7919 + (readHistory ? 104729 : 0);
  test(`assistant stream viewport fuzz · ${width}px · ${readHistory ? "history then tail" : "tail"} · seed ${seed}`, async ({ page }, testInfo) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ colorScheme: readHistory ? "dark" : "light" });
    // Optional local baseline module proves the same assertions reject an older renderer.
    // Keep compiled baselines and private traces outside tracked fixtures.
    if (process.env.QINGZHOU_FUZZ_MARKDOWN_MODULE) {
      await page.route("**/sidepanel/features/chat/markdown-feature.js", route => route.fulfill({
        contentType: "application/javascript", body: readFileSync(process.env.QINGZHOU_FUZZ_MARKDOWN_MODULE, "utf8"),
      }));
      await page.reload();
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    }
    const plan = assistantStreamPlan(seed + testInfo.repeatEachIndex * 1000003);
    await page.evaluate(async plan => {
      const bench = window.qingzhouConversationBenchmark;
      const answer = plan.transcript.at(-1), runId = answer.runId, sessionId = "assistant-viewport-fuzz";
      const history = Array.from({ length: plan.historyTurns }, (_, i) => [
        { type: "user", text: `历史问题 ${i}` },
        { type: "assistant", spanId: `history-${i}`, content: "历史结果用于验证阅读位置。".repeat(40) },
      ]).flat();
      await bench.runLiveReplay({ sessionId, baseTranscript: [...history, ...plan.transcript.slice(0, -1)], events: [] }, { runId });
      const messages = document.querySelector("#messages");
      const probe = window.__assistantFuzz = { frames: [], phase: "interaction", done: false, seq: 0, inputs: [], readingAnchor: null };
      const sample = () => {
        const current = messages.querySelector(`[data-stream-trace-id="${answer.spanId}"]`);
        probe.frames.push({ time: performance.now(), phase: probe.phase, top: messages.scrollTop,
          height: messages.scrollHeight, client: messages.clientHeight, width: messages.clientWidth,
          tailGap: Math.max(0, messages.scrollHeight - messages.clientHeight - messages.scrollTop),
          contentLength: Number(current?.dataset.content?.length || 0),
          anchorConnected: probe.readingAnchor?.isConnected ?? false,
          anchorTop: probe.readingAnchor?.getBoundingClientRect().top ?? null,
          anchorBaseline: probe.anchorBaseline ?? null });
        if (!probe.stop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      for (const type of ["click", "wheel"]) messages.addEventListener(type, event => {
        if (event.isTrusted) probe.inputs.push({ type, time: performance.now(), seq: probe.seq, done: probe.done });
      }, { capture: true });
      probe.start = async () => {
        for (const chunk of plan.chunks) {
          bench.dispatchBackgroundEvent({ type: "message_update", sessionId, runId, eventSeq: ++probe.seq,
            spanId: answer.spanId, content: answer.content.slice(0, chunk.length) });
          await new Promise(resolve => setTimeout(resolve, chunk.delayMs));
        }
        probe.done = true;
      };
      probe.finish = () => {
        bench.dispatchBackgroundEvent({ type: "message_end", sessionId, runId, eventSeq: ++probe.seq,
          spanId: answer.spanId, message: { role: "assistant", content: answer.content } });
        bench.dispatchBackgroundEvent({ type: "agent_end", sessionId, runId, eventSeq: ++probe.seq });
      };
    }, { ...plan, historyTurns: readHistory ? 5 : 0 });

    const card = page.locator(".msg-tool-timeline"), summary = card.locator(":scope > .tool-summary");
    await summary.click();
    await card.locator('[data-tool-timeline-index="2"]').click();
    await expect(card.locator(".tool-image-grid-scroll")).toBeVisible();
    await page.evaluate(() => { void window.__assistantFuzz.start(); });
    await page.waitForFunction(() => window.__assistantFuzz.seq >= 3);
    // Native clicks overlap real reducer/render updates, including two height changes.
    await summary.click();
    if (!readHistory) await expect(page.locator(".msg-user").first()).toBeInViewport();
    await summary.click();
    await card.locator(`[data-tool-timeline-index="${plan.toolIndex}"]`).click();
    await card.locator('[data-tool-timeline-index="2"]').click();
    const messages = page.locator("#messages");
    const box = await messages.boundingBox();
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    if (readHistory) {
      await page.mouse.wheel(0, -800);
      // Exclude the native wheel's animation, then observe all painted idle frames.
      await page.waitForTimeout(350);
      await page.evaluate(() => {
        const probe = window.__assistantFuzz, messages = document.querySelector("#messages"), viewport = messages.getBoundingClientRect();
        probe.readingAnchor = [...messages.querySelectorAll(".msg-user, .msg-assistant")].find(el => {
          const rect = el.getBoundingClientRect();
          return rect.bottom > viewport.top + 5 && rect.top < viewport.bottom - 5 && !el.dataset.markdownMode;
        });
        if (!probe.readingAnchor) throw Error("No stable visible history anchor");
        probe.anchorBaseline = probe.readingAnchor.getBoundingClientRect().top;
        probe.phase = "reading";
      });
      await page.waitForTimeout(plan.readingMs);
    }
    await page.evaluate(() => { window.__assistantFuzz.phase = "interaction"; });
    await page.mouse.wheel(0, 100000);
    await page.waitForFunction(() => {
      const messages = document.querySelector("#messages");
      return messages.scrollHeight - messages.clientHeight - messages.scrollTop < 2;
    });
    await page.evaluate(() => { window.__assistantFuzz.phase = "tail"; });
    await page.waitForFunction(() => window.__assistantFuzz.done);
    const answer = page.locator('.msg-assistant').last();
    await expect(answer).toHaveAttribute("data-content", plan.transcript.at(-1).content);
    await page.evaluate(() => window.__assistantFuzz.finish());
    await expect(answer).toHaveAttribute("data-markdown-mode", "complete");
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => { window.__assistantFuzz.stop = true; return { frames: window.__assistantFuzz.frames, inputs: window.__assistantFuzz.inputs }; });
    const analysis = analyzeAssistantStreamFrames(result.frames);
    await testInfo.attach("assistant-stream-fuzz.json", { body: Buffer.from(JSON.stringify({ seed: plan.seed, chunks: plan.chunks, ...result, ...analysis })), contentType: "application/json" });
    expect(analysis.coverage.tailFrames).toBeGreaterThan(20);
    expect(analysis.coverage.tailContentChanges).toBeGreaterThan(5);
    if (readHistory) {
      expect(analysis.coverage.readingFrames).toBeGreaterThan(10);
      expect(analysis.coverage.readingContentChanges).toBeGreaterThan(0);
    }
    expect(result.inputs.filter(e => e.type === "click" && e.seq > 0 && !e.done).length).toBeGreaterThanOrEqual(4);
    expect(result.inputs.some(e => e.type === "wheel" && !e.done)).toBe(true);
    expect(analysis.failures, JSON.stringify(analysis.failures.slice(0, 5))).toEqual([]);
    await expect(answer.locator('table tbody tr')).toHaveCount(5);
    await expect(answer.locator('table a')).toHaveCount(5);
    await expect(card.locator(".tool-image-grid-scroll")).toBeVisible();
  });
}

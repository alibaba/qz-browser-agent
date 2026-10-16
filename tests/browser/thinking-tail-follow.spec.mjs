import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`expanded thinking tail · ${colorScheme}`, () => {
    test.use({ viewport: { width: 430, height: 844 }, colorScheme });

    test("resumes and keeps following streamed text without losing manual reading position", async ({ page }, testInfo) => {
      await page.evaluate(async () => {
        const api = window.qingzhouConversationBenchmark;
        const sessionId = "thinking-tail-session";
        const runId = "thinking-tail-run";
        const spanId = "thinking-tail-span";
        const history = Array.from({ length: 8 }, (_, index) => ({
          type: "assistant", spanId: `history-${index}`, runId: `history-${index}`,
          content: `Earlier research ${index + 1}. `.repeat(20),
        }));
        history.push({ type: "user", text: "Compare these findings.", clientMessageId: "thinking-tail-user" });
        await api.runSnapshotRender({ sessionId, transcript: history });
        let lines = 50;
        const text = () => Array.from({ length: lines }, (_, index) => `Research step ${index + 1}: check the source and compare the evidence.`).join("\n");
        const dispatch = event => api.dispatchBackgroundEvent({ sessionId, runId, ...event });
        dispatch({ type: "agent_start" });
        dispatch({ type: "thinking_update", spanId, thinking: text() });
        window.__thinkingTailProbe = {
          append() {
            lines += 3;
            dispatch({ type: "thinking_update", spanId, thinking: text() });
            return text();
          },
          reconcile() {
            dispatch({ type: "messages", save: false, transcript: [
              ...history,
              { type: "thinking", spanId, runId, text: text(), streaming: true },
            ] });
          },
          finish() { dispatch({ type: "agent_end" }); },
        };
      });

      const group = page.locator(".msg-thinking-group").last();
      await group.locator(":scope > .thinking-group-summary").click();
      const body = group.locator(".thinking-group-body");
      await expect(body).toBeVisible();
      await returnToTail(body);
      await body.hover();
      await page.mouse.wheel(0, -240);
      await expect.poll(() => body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeGreaterThan(100);
      const pausedTop = await body.evaluate(node => node.scrollTop);
      const pausedSamples = await appendAndSample(page, body, 6);
      expect(pausedSamples.every(sample => Math.abs(sample.top - pausedTop) <= 1), JSON.stringify(pausedSamples)).toBe(true);

      // The canonical snapshot takes the full reconciliation path, while deltas
      // above and below use live tail patches. Both must preserve reading intent.
      await page.evaluate(() => {
        window.__thinkingTailNode = document.querySelector(".thinking-group-body");
        window.__thinkingTailProbe.reconcile();
      });
      await page.waitForTimeout(180);
      expect(await body.evaluate(node => ({ same: node === window.__thinkingTailNode, top: node.scrollTop }))).toEqual({ same: true, top: pausedTop });
      const reconciledSamples = await appendAndSample(page, body, 4);
      expect(reconciledSamples.every(sample => Math.abs(sample.top - pausedTop) <= 1), JSON.stringify(reconciledSamples)).toBe(true);

      await returnToTail(body);
      // A downward wheel at the inner boundary may move the outer conversation;
      // it must retain the user's decision to follow the thinking text.
      await body.hover();
      await page.mouse.wheel(0, 160);
      const resumedSamples = await appendAndSample(page, body, 26);
      expect(resumedSamples.every(sample => sample.following === "true" && sample.gap <= 1), JSON.stringify(resumedSamples)).toBe(true);
      expect(resumedSamples.at(-1).top).toBeGreaterThan(resumedSamples[0].top + 500);
      await testInfo.attach("thinking-tail-samples.json", {
        body: JSON.stringify({ pausedTop, pausedSamples, reconciledSamples, resumedSamples }), contentType: "application/json",
      });
      await testInfo.attach(`thinking-tail-${colorScheme}.png`, { body: await page.screenshot(), contentType: "image/png" });
      await page.evaluate(() => window.__thinkingTailProbe.finish());
    });

    test("scrolling above thinking pauses only that card's inner tail", async ({ page }) => {
      await page.evaluate(async () => {
        const text = Array.from({ length: 50 }, (_, index) => `Reading line ${index + 1}`).join("\n");
        await window.qingzhouConversationBenchmark.runSnapshotRender({
          sessionId: "thinking-wheel-scope",
          transcript: [
            { type: "thinking", spanId: "first-thought", runId: "first-run", text, streaming: true },
            { type: "assistant", spanId: "first-answer", runId: "first-run", content: "Earlier findings. ".repeat(100) },
            { type: "user", clientMessageId: "next-question", text: "Check the next source." },
            { type: "thinking", spanId: "second-thought", runId: "second-run", text, streaming: true },
          ],
        });
      });
      const groups = page.locator(".msg-thinking-group");
      await expect(groups).toHaveCount(2);
      await groups.first().locator(":scope > .thinking-group-summary").click();
      await groups.last().locator(":scope > .thinking-group-summary").click();
      const previous = groups.first().locator(".thinking-group-body");
      const current = groups.last().locator(".thinking-group-body");
      await returnToTail(previous);
      await current.evaluate(node => {
        node.scrollTop = 0;
        node.dispatchEvent(new Event("scroll"));
      });
      await current.hover();
      const before = await page.locator("#messages").evaluate(node => node.scrollTop);
      await page.mouse.wheel(0, -160);
      await expect.poll(() => page.locator("#messages").evaluate(node => node.scrollTop)).toBeLessThan(before);
      await expect(previous).toHaveAttribute("data-follow-tail", "true");
      await expect(current).toHaveAttribute("data-follow-tail", "false");
    });
  });
}

async function returnToTail(body) {
  await body.evaluate(node => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => body.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
}

async function appendAndSample(page, body, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const expected = await page.evaluate(() => window.__thinkingTailProbe.append());
    await expect(body).toHaveText(expected);
    // Continue beyond both scroll grace periods and the outer tail lock.
    await page.waitForTimeout(90);
    samples.push(await body.evaluate(node => ({
      top: node.scrollTop, gap: node.scrollHeight - node.clientHeight - node.scrollTop, following: node.dataset.followTail,
    })));
  }
  return samples;
}

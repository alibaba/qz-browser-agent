import { expect, test } from "./sidepanel-fixtures.mjs";

const fixture = {
  sessionId: "error-typography",
  title: "Error typography",
  transcript: [
    { type: "user", text: "Read the page." },
    { type: "assistant", spanId: "provider-error", content: "Model request failed: The provider is temporarily unavailable. Try again later." },
    { type: "user", text: "Continue." },
    { type: "tool", toolCallId: "save-error", name: "save_file", args: { filename: "report.html" }, result: { error: "Incomplete output" }, isError: true },
    { type: "error", text: "The model reached its output limit. Use shorter tool arguments or process bulk data in a script." },
  ],
};

for (const colorScheme of ["light", "dark"]) {
  test.describe(`error card typography · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 390, height: 900 }, sidepanelChromeOptions: { uiLanguage: "en" } });

    test("assistant and event failures share reading size through streaming, rebuild and export", async ({ page, browser }, testInfo) => {
      await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input), fixture);
      await expect(page.locator(".msg-assistant-error .chat-error-card")).toHaveCount(1);
      await expect(page.locator(".msg-error .chat-error-card")).toHaveCount(1);

      for (const [level, size] of [["small", 11], ["compact", 11.7], ["standard", 13], ["comfortable", 14.3], ["large", 16.25], ["xlarge", 18]]) {
        await page.locator("#messages").evaluate((element, value) => { element.dataset.chatTextSize = value; }, level);
        await expectCardSizes(page, 2, size);
      }

      // A later error arriving after tool execution must keep the existing cards' size.
      await page.evaluate(() => {
        const dispatch = event => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          sessionId: "error-typography", runId: "retry", ...event,
        });
        dispatch({ type: "agent_start" });
        dispatch({ type: "error", text: "The retry failed. Check the model connection." });
      });
      await expect(page.locator(".chat-error-card")).toHaveCount(3);
      await expectCardSizes(page, 3, 18);

      const complete = { ...fixture, transcript: [...fixture.transcript, { type: "error", text: "The retry failed. Check the model connection." }] };
      await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input), complete);
      await page.locator("#messages").evaluate(element => { element.dataset.chatTextSize = "xlarge"; });
      await expectCardSizes(page, 3, 18);
      await page.locator("#messages").evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`errors-${colorScheme}.png`) });

      // Exports use the skin's default size, independently of the panel preference.
      const exported = await page.evaluate(input => window.qingzhouConversationBenchmark.renderSessionDocument(input), complete);
      const context = await browser.newContext({ colorScheme, viewport: { width: 390, height: 900 } });
      try {
        await context.setOffline(true);
        const offline = await context.newPage();
        await offline.setContent(exported.html);
        await expectCardSizes(offline, 3, 13);
      } finally { await context.close(); }
    });
  });
}

async function expectCardSizes(page, count, size) {
  const cards = page.locator(".chat-error-card");
  await expect(cards).toHaveCount(count);
  const styles = await cards.evaluateAll(elements => elements.map(card => {
    const fontSize = element => Number.parseFloat(getComputedStyle(element).fontSize);
    return { card: fontSize(card), title: fontSize(card.querySelector(".chat-error-title")), summary: fontSize(card.querySelector(".chat-error-summary")) };
  }));
  for (const style of styles) {
    expect(style.card).toBeCloseTo(size, 2);
    expect(style.title).toBeCloseTo(size * 0.96, 2);
    expect(style.summary).toBeCloseTo(size * 0.94, 2);
  }
  expect(await page.locator("#messages").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

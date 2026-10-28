import { expect, test } from "./sidepanel-fixtures.mjs";

const incompleteTitle = "等待超时，结果不完整";
const incompleteResult = {
  tabId: 1, url: "https://example.test/slow", status: "loading", loading: true,
  incomplete: { reason: "timeout", pending: "navigation commit" },
};

for (const colorScheme of ["light", "dark"]) {
  for (const count of [1, 3, 15]) {
    test(`partial timeout indicators · ${count} tools · ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.evaluate(async count => {
        const tools = Array.from({ length: count }, (_, index) => ({
          type: "tool", name: "open_tab", toolCallId: `open-${index}`, runId: "timeout-run",
          args: { url: `https://example.test/page-${index}` },
          phase: index === count - 1 ? "running" : "done", isRunning: index === count - 1,
          result: index === count - 1 ? null : { tabId: index + 1, status: "complete" },
        }));
        window.__timeoutFixture = {
          sessionId: "timeout-session",
          transcript: [{ type: "user", text: "打开页面并读取内容", clientMessageId: "timeout-user" }, ...tools],
        };
        await window.qingzhouConversationBenchmark.runSnapshotRender(window.__timeoutFixture);
        window.qingzhouConversationBenchmark.configureVisualState({ running: true });
      }, count);
      const card = page.locator("#messages > .msg-tool");
      const dot = card.locator(":scope > .tool-summary .dot");
      await expect(dot).toHaveClass(/running/);
      await page.evaluate(({ count, result }) => {
        window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          type: "tool_execution_end", sessionId: "timeout-session", runId: "timeout-run", eventSeq: 1,
          toolCallId: `open-${count - 1}`, toolName: "open_tab", result,
        });
      }, { count, result: incompleteResult });
      await expectIncompleteDot(dot);
      await card.locator(":scope > .tool-summary").click();
      if (count > 1) {
        const indicator = count > 12
          ? card.locator(".tool-family-row .mini-dot.incomplete")
          : card.locator(".tool-timeline-step.incomplete .mini-dot");
        await expectIncompleteDot(indicator);
        await expect(card.locator(":scope > .tool-summary .tool-args-preview")).toContainText("未完成");
      }
      await card.screenshot({ path: testInfo.outputPath("incomplete-result.png"), animations: "disabled" });
      // A restored historical conversation must keep the timeout indication.
      await page.evaluate(async result => {
        const tool = window.__timeoutFixture.transcript.at(-1);
        Object.assign(tool, { phase: "done", isRunning: false, result });
        await window.qingzhouConversationBenchmark.runSnapshotRender(window.__timeoutFixture);
      }, incompleteResult);
      await expectIncompleteDot(dot);
      // Updating the same rendered card with a complete result clears its tooltip and warning.
      await page.evaluate(async count => {
        const tool = { ...window.__timeoutFixture.transcript.at(-1), result: { tabId: 1, status: "complete" } };
        const card = document.querySelector("#messages > .msg-tool");
        if (count === 1) {
          const { patchToolEvent } = await import("/extension/sidepanel/tools/tool-renderer.js");
          patchToolEvent(card, tool);
        } else {
          const { patchToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
          const entry = card.__toolTimelineGroupEntry;
          patchToolTimelineGroupElement(card, { ...entry, entries: [...entry.entries.slice(0, -1), tool] });
        }
      }, count);
      await expect(dot).not.toHaveClass(/incomplete|running|error/);
      await expect(dot).toHaveAttribute("title", "");
      await expect(dot).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    });
  }
}

async function expectIncompleteDot(dot) {
  await expect(dot).toHaveAttribute("title", incompleteTitle);
  await expect(dot).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(dot).toHaveCSS("border-top-style", "solid");
  await expect(dot).toHaveCSS("animation-name", "none");
  const colors = await dot.evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--orange)";
    element.append(probe);
    const colors = { actual: getComputedStyle(element).borderTopColor, expected: getComputedStyle(probe).color };
    probe.remove();
    return colors;
  });
  expect(colors.actual).toBe(colors.expected);
}

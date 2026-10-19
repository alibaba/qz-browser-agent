import { expect, test } from "./sidepanel-fixtures.mjs";

test("shows a follow-up initialization failure before agent_start and permits recovery", async ({ page }) => {
  const sessionId = "pending-run-error";
  const failure = "Run configuration could not be initialized.";
  const dispatch = event => page.evaluate(event => window.__qzEmitPortMessage(event), { sessionId, ...event });
  await page.evaluate(sessionId => window.qingzhouConversationBenchmark.runSnapshotRender({
    sessionId,
    transcript: [{ type: "user", text: "First request", clientMessageId: "first-request" }],
  }), sessionId);
  await dispatch({ type: "agent_start", runId: "r1", eventSeq: 1 });
  await dispatch({
    type: "message_end", runId: "r1", eventSeq: 2, spanId: "first-answer",
    message: { role: "assistant", content: "The first answer is complete." },
  });
  await dispatch({ type: "agent_end", runId: "r1" });
  await expect(page.locator("#messages")).toContainText("The first answer is complete.");
  await expect(page.locator("#status-bar")).toBeHidden();

  await page.locator("#input").fill("Follow up on the first answer");
  await page.locator("#input").press("Enter");
  await expect(page.locator("#input")).toHaveValue("");
  await dispatch({ type: "session_pending", runId: "r2" });
  await dispatch({ type: "error", runId: "r2", eventSeq: 1, code: "AGENT_RUN_FAILED", message: failure });
  await dispatch({ type: "agent_end", runId: "r2" });

  await expect(page.locator(".chat-error-card")).toHaveCount(1);
  await expect(page.locator(".chat-error-card")).toContainText(failure);
  await expect(page.locator("#messages")).toContainText("The first answer is complete.");
  await expect(page.locator("#messages")).toContainText("Follow up on the first answer");
  await expect(page.locator("#status-bar")).toBeHidden();
  await expect(page.locator("#input")).toBeEditable();

  await page.locator("#input").fill("Retry after fixing the configuration");
  await expect(page.locator("#btn-send")).toBeEnabled();
  await page.locator("#input").press("Enter");
  await expect(page.locator("#input")).toHaveValue("");
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "prompt").map(message => message.text)))
    .toEqual(["Follow up on the first answer", "Retry after fixing the configuration"]);
  await dispatch({ type: "session_pending", runId: "r3" });
  await expect(page.locator("#status-bar")).toBeVisible();
  await dispatch({ type: "agent_start", runId: "r3", eventSeq: 1 });

  // Higher sequence numbers from obsolete runs must not end or corrupt the new run.
  await dispatch({ type: "error", runId: "r1", eventSeq: 100, message: "Obsolete first-run failure" });
  await dispatch({ type: "agent_end", runId: "r2", eventSeq: 100 });
  await expect(page.locator("#status-bar")).toBeVisible();
  await expect(page.locator(".chat-error-card")).toHaveCount(1);
  await expect(page.locator("#messages")).not.toContainText("Obsolete first-run failure");

  await dispatch({
    type: "message_end", runId: "r3", eventSeq: 2, spanId: "recovered-answer",
    message: { role: "assistant", content: "The follow-up recovered successfully." },
  });
  await dispatch({ type: "agent_end", runId: "r3" });
  await expect(page.locator("#messages")).toContainText("The follow-up recovered successfully.");
  await expect(page.locator("#messages")).toContainText("The first answer is complete.");
  await expect(page.locator(".chat-error-card")).toHaveCount(1);
  await expect(page.locator("#status-bar")).toBeHidden();
  await expect(page.locator("#input")).toBeEditable();
});

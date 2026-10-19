import { expect, test } from "./sidepanel-fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => window.qingzhouConversationBenchmark.runSnapshotRender({
    sessionId: "search-keyboard",
    transcript: [
      { type: "user", text: "needle one" },
      { type: "assistant", content: "needle two", runId: "answer" },
      { type: "user", text: "needle three" },
    ],
  }));
});

test("Escape closes search from every keyboard-reachable search button", async ({ page }) => {
  for (const [index, id] of ["prev", "next", "close"].entries()) {
    await openSearch(page);
    for (let tab = 0; tab <= index; tab++) await page.keyboard.press("Tab");
    await expect(page.locator(`#chat-search-${id}`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#chat-search-bar")).toBeHidden();
    await expect(page.locator("#input")).toBeFocused();
  }
});

test("search leaves composition confirmation and cancellation to the input method", async ({ page }) => {
  await openSearch(page);
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const [selector, key] of [["#chat-search-input", "Enter"], ["#chat-search-input", "Escape"], ["#input", "Escape"]]) {
      const field = page.locator(selector);
      await field.focus();
      expect(await field.evaluate((element, init) => {
        const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }, { key, ...composition })).toBe(false);
      await expect(page.locator("#chat-search-bar")).toBeVisible();
      await expect(page.locator("#chat-search-count")).toHaveText("1/3");
      await expect(field).toBeFocused();
    }
  }
});

test("Enter and Shift+Enter navigate results and buttons activate exactly once", async ({ page }) => {
  await openSearch(page);
  const input = page.locator("#chat-search-input");
  const count = page.locator("#chat-search-count");
  await input.press("Enter");
  await expect(count).toHaveText("2/3");
  await input.press("Shift+Enter");
  await expect(count).toHaveText("1/3");
  await input.press("Tab");
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("3/3");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("1/3");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#chat-search-bar")).toBeHidden();
  await expect(page.locator("#input")).toBeFocused();
});

async function openSearch(page) {
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.locator("#chat-search-input");
  await expect(input).toBeFocused();
  await input.fill("needle");
  await expect(page.locator("#chat-search-count")).toHaveText("1/3");
}

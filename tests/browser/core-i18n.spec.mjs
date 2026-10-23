import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`English workspace and offline export · ${colorScheme}`, () => {
    test.use({ locale: "en-US", colorScheme, viewport: { width: 430, height: 900 } });
    test("uses the Chrome UI language for navigation, chat, errors and exported controls", async ({ page, browser }) => {
      await page.addInitScript(installBenchmarkChromeStub, {
        uiLanguage: "en-US",
        config: { provider: "custom", model: "test-model", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false },
      });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await expect(page.locator('button[data-tab="chat"]')).toHaveText("Chat");
      await expect(page.locator("#btn-settings")).toHaveAttribute("title", "Settings");
      await expect(page.locator("#btn-new")).toHaveAttribute("title", "New chat");
      await expect(page.locator(".welcome-subtitle")).toHaveCount(1);
      await expect(page.locator(".welcome-subtitle")).toBeHidden();
      const snapshot = {
        session: { id: "i18n-export", title: '用户标题 <script>window.pwned=true</script>' },
        transcript: [
          { id: "user", type: "user", text: "用户正文保持原样" },
          { id: "error", type: "error", text: "错误原文 unchanged" },
          { id: "follow-up", type: "user", text: "继续" },
          { id: "assistant", type: "assistant", content: "模型回答保持原样" },
        ],
      };
      const exported = await page.evaluate(async input => {
        await window.qingzhouConversationBenchmark.runSnapshotRender(input, { debug: false, clearStorage: false });
        return window.qingzhouConversationBenchmark.renderSessionDocument(input);
      }, snapshot);
      await expect(page.locator("#messages")).toContainText("用户正文保持原样");
      await expect(page.locator("#messages")).toContainText("模型回答保持原样");
      await expect(page.locator(".chat-error-card")).toContainText("Unable to continue");
      await expect(page.locator(".chat-error-card")).toContainText("错误原文 unchanged");
      await expect(page.locator('[data-action="copy-markdown"]').first()).toHaveAttribute("title", "Copy Markdown");

      // A recipient's different browser language must not rewrite the exported document.
      const recipient = await browser.newContext({ locale: "zh-CN", colorScheme });
      const offline = await recipient.newPage();
      const errors = [];
      offline.on("pageerror", error => errors.push(error.message));
      try {
        await recipient.setOffline(true);
        await offline.setContent(exported.html);
        await expect(offline.locator("html")).toHaveAttribute("lang", "en");
        await expect(offline.locator("#current-session-title")).toHaveText(snapshot.session.title);
        await expect(offline.locator("#messages")).toContainText("用户正文保持原样");
        await expect(offline.locator(".chat-error-card")).toContainText("Unable to continue");
        expect(await offline.evaluate(() => window.pwned)).toBeUndefined();
        await offline.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "probe", installed: true }, "*"));
        await expect(offline.locator("#qingzhou-session-cta")).toHaveText("Continue in qz");
        await offline.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: false }, "*"));
        await expect(offline.locator("#qingzhou-session-cta")).toHaveText("Try again");
        expect(errors).toEqual([]);
      } finally { await recipient.close(); }
    });
  });
}

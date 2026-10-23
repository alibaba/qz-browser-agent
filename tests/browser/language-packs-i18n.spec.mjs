import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const scenarios = [
  ["en-US", "en", "en", "Save", "qz"], ["zh-CN", "zh-CN", "zh_CN", "保存配置", "轻舟"],
  ["zh-TW", "zh-TW", "zh_TW", "儲存設定", "輕舟"], ["ja-JP", "ja", "ja", "保存", "軽舟"],
  ["ko-KR", "ko", "ko", "저장", "qz"], ["es-MX", "es", "es", "Guardar", "qz"],
  ["fr-FR", "fr", "fr", "Enregistrer", "qz"], ["de-DE", "de", "de", "Speichern", "qz"],
  ["pt-BR", "pt-BR", "pt_BR", "Salvar", "qz"], ["ru-RU", "ru", "ru", "Сохранить", "qz"],
  ["ar-SA", "ar", "ar", "حفظ", "qz"], ["hi-IN", "hi", "hi", "सेव करें", "qz"],
];
const messageId = key => `qz_${key.replace(/[^a-z0-9]/g, char => `_${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
const artifacts = resolve("tests/results/i18n/world-languages");
const config = { provider: "custom", model: "qwen3.5-plus", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false };
const layoutArtifacts = resolve("tests/results/i18n/main-layout");

// Check actual painted labels and hit targets, not just document.scrollWidth. The header and
// list containers intentionally scroll; their individual controls are reached separately below.
async function auditMainSurface(page, selector, label, testInfo) {
  const report = await page.locator(selector).evaluateAll(roots => {
    const issues = [];
    const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const identity = element => element.id || `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]}`;
    const allowsEllipsis = element => element.closest("#current-model-indicator, #current-session-title, .model-preset-switcher-name, .model-preset-switcher-meta, .queued-followup-text, .slash-subtitle");
    const scrollsHorizontally = element => element.closest(".header-tabs");
    for (const root of roots) {
      for (const element of [root, ...root.querySelectorAll("*")]) {
        if (!visible(element) || element.closest("svg") || scrollsHorizontally(element)) continue;
        const box = element.getBoundingClientRect();
        if (element.matches("button")) {
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const overflow = getComputedStyle(ancestor).overflowY;
            if (overflow === "auto" || overflow === "scroll") break;
            const clip = ancestor.getBoundingClientRect();
            if (overflow === "hidden" && (box.top < clip.top - 1 || box.bottom > clip.bottom + 1)) {
              issues.push({ kind: "unreachable-control", element: identity(element), clip: identity(ancestor), bottom: box.bottom, clipBottom: clip.bottom });
              break;
            }
          }
        }
        if (box.bottom <= 0 || box.top >= innerHeight) continue;
        if (element.matches("button, input, textarea, .qz-popover, .model-preset-switcher-panel") && (box.left < -1 || box.right > innerWidth + 1)) {
          issues.push({ kind: "outside", element: identity(element), left: box.left, right: box.right });
        }
        if (element.matches("input, textarea") && !element.value && element.placeholder) {
          const style = getComputedStyle(element), context = document.createElement("canvas").getContext("2d");
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          if (context.measureText(element.placeholder).width > available + 1 && element.clientHeight < parseFloat(style.lineHeight) * 2) {
            issues.push({ kind: "clipped-placeholder", element: identity(element), text: element.placeholder, available });
          }
        }
        for (const text of element.childNodes) {
          if (text.nodeType !== Node.TEXT_NODE || !text.textContent.trim() || allowsEllipsis(element)) continue;
          const range = document.createRange();
          range.selectNode(text);
          for (const ink of range.getClientRects()) {
            if (ink.width < 1 || ink.height < 1 || ink.bottom <= 0 || ink.top >= innerHeight) continue;
            let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
            const control = element.closest("button, .queued-followup-meta");
            if (control) {
              const bounds = control.getBoundingClientRect();
              left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
              top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
            }
            for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
              const style = getComputedStyle(ancestor);
              const rect = ancestor.getBoundingClientRect();
              if (style.overflowX !== "visible") { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
              if (style.overflowY !== "visible") { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
            }
            // A scrollable list may continue below the viewport; partially visible labels are
            // checked after scrollIntoView by the reachability assertions, rather than rejected.
            if (ink.bottom <= top || ink.top >= bottom) continue;
            if (ink.left < left - 1 || ink.right > right + 1 || (ink.top >= top && ink.bottom > bottom + 2)) {
              issues.push({ kind: "clipped-text", element: identity(element), text: text.textContent.trim(), ink: { left: ink.left, right: ink.right, top: ink.top, bottom: ink.bottom }, clip: { left, right, top, bottom } });
            }
          }
        }
        if (element.matches("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") && box.top >= 0 && box.bottom <= innerHeight && box.width > 0) {
          const x = box.left + box.width / 2, y = box.top + box.height / 2;
          let outsideScrollport = false;
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
            if ((style.overflowX !== "visible" && (x < clip.left || x > clip.right)) || (style.overflowY !== "visible" && (y < clip.top || y > clip.bottom))) outsideScrollport = true;
          }
          if (outsideScrollport) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !element.contains(hit)) issues.push({ kind: "covered-control", element: identity(element), by: hit && identity(hit) });
        }
      }
    }
    return { issues, width: innerWidth, direction: document.documentElement.dir };
  });
  await mkdir(layoutArtifacts, { recursive: true });
  const filename = resolve(layoutArtifacts, label);
  await writeFile(`${filename}.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${filename}.png`, animations: "disabled" });
  await testInfo.attach(label, { path: `${filename}.png`, contentType: "image/png" });
  expect.soft(report.issues, `${label}: labels fit and controls are unobstructed`).toEqual([]);
}

for (const [locale, language, chromeLocale] of scenarios) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`${language} main layout · ${colorScheme}`, () => {
      test.use({ locale, colorScheme, viewport: { width: 320, height: 760 } });
      test("keeps main controls and translated labels reachable at 320, 360 and 430px", async ({ page }, testInfo) => {
        test.setTimeout(90_000);
        const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
        const presets = [
          { id: "layout-current", provider: "custom", model: "qwen3.5-plus", name: "Current model", apiKey: "test-key", customEndpoint: config.customEndpoint },
          { id: "layout-next", provider: "deepseek", model: "deepseek-v4-flash", name: "Alternative model", apiKey: "test-key" },
        ];
        await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: locale, localeMessages: messages, config: { ...config, activePresetId: presets[0].id, presets } });
        await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
        for (const width of [320, 360, 430]) {
          await page.setViewportSize({ width, height: 760 });
          await page.locator("#welcome").evaluate(element => { element.scrollTop = 0; });
          const prefix = `${language}-${colorScheme}-${width}`;
          await auditMainSurface(page, "#header, #welcome, #chat-dock", `${prefix}-landing`, testInfo);
          for (const button of await page.locator(".header-tabs .tab-btn:visible, .onboarding-action:visible").all()) {
            await button.scrollIntoViewIfNeeded();
            await button.click({ trial: true });
            const geometry = await button.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
            expect.soft(geometry.scroll, `${prefix}: ${await button.innerText()} is fully readable`).toBeLessThanOrEqual(geometry.client + 2);
          }
          await page.evaluate(() => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: "model_preset_switcher_requested", source: "shortcut" }));
          await expect(page.locator("#model-preset-switcher")).toBeVisible();
          await auditMainSurface(page, "#model-preset-switcher", `${prefix}-models`, testInfo);
          await page.locator("#model-preset-switcher-input").fill("no matching model");
          await auditMainSurface(page, "#model-preset-switcher", `${prefix}-models-empty`, testInfo);
          await page.locator("#model-preset-switcher-input").press("Escape");
        }
        await page.evaluate(async () => {
          await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId: "localized-layout", title: "Original user title / 用户标题 / عنوان المستخدم", transcript: [
            { type: "user", text: "Original user content / 用户内容 / نص المستخدم", clientMessageId: "layout-question" },
            { type: "assistant", content: "A short reply with **original content**.", spanId: "layout-reply" },
          ] });
          window.qingzhouConversationBenchmark.configureVisualState({ running: true, pendingFollowUps: [{ clientMessageId: "layout-followup", text: "Follow-up / 追问 / متابعة" }], pendingSteerings: [{ clientMessageId: "layout-steering", text: "Steering / 补充 / توجيه" }] });
          window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: "llm_rate_wait", sessionId: "localized-layout", runId: "benchmark-visual-run" });
        });
        for (const width of [320, 360, 430]) {
          await page.setViewportSize({ width, height: 760 });
          const prefix = `${language}-${colorScheme}-${width}`;
          await auditMainSurface(page, "#header, #session-title-bar, #messages, #chat-dock", `${prefix}-chat`, testInfo);
          await page.locator("#btn-chat-text-size").click();
          await auditMainSurface(page, "#chat-text-size-popover", `${prefix}-text-size`, testInfo);
          for (const button of await page.locator("#chat-text-size-popover button:enabled").all()) await button.click({ trial: true });
          await page.locator("#btn-chat-text-size").click();
          await page.locator("#input").fill("/");
          await expect(page.locator(".input-slash-menu")).toBeVisible();
          await auditMainSurface(page, ".input-slash-menu", `${prefix}-slash`, testInfo);
          for (const button of await page.locator(".input-slash-menu button").all()) await button.click({ trial: true });
          await page.locator("#input").press("Escape");
          await page.locator("#input").fill("");
        }
      });
    });
  }
}

for (const [locale, language, chromeLocale, save, brand] of scenarios) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`${language} language pack · ${colorScheme}`, () => {
      test.use({ locale, colorScheme, viewport: { width: 360, height: 900 } });
      test("localizes the real workspace and prepares four editable, concrete task drafts", async ({ page }) => {
        const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
        await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: locale, localeMessages: messages, config });
        await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
        await expect(page).toHaveTitle(brand);
        await expect(page.locator(".welcome-icon")).toHaveAttribute("aria-label", brand);
        await page.locator("#btn-settings").click();
        await expect(page.locator("#btn-save-settings")).toHaveText(save);
        await expect(page.locator("#cfg-model")).toHaveValue(config.model);
        await page.locator("#btn-close-settings").click();
        const drafts = [];
        for (const [action, key] of [["summarize", "summarizePagePrompt"], ["extract", "compareOptionsPrompt"], ["assist", "researchTopicPrompt"], ["skill", "createWebsiteSkillPrompt"]]) {
          const button = page.locator(`[data-onboarding-action="${action}"]`);
          await button.scrollIntoViewIfNeeded();
          await expect(button).toBeInViewport();
          await button.click();
          await expect(page.locator("#input")).not.toBeEmpty();
          const draft = await page.locator("#input").inputValue();
          if (messages[messageId(`settings.${key}`)]) expect(draft).toBe(messages[messageId(`settings.${key}`)].message);
          expect(draft).not.toMatch(/全国各省会|北京|上海|杭州|Beijing|Shanghai|Hangzhou/);
          drafts.push(draft);
          // Suggestions prepare a draft; they never create a conversation or start a model request.
          await expect(page.locator("#welcome")).toBeVisible();
          await expect(page.locator("#messages .msg-user")).toHaveCount(0);
        }
        expect(new Set(drafts).size).toBe(4);
        await page.locator("#input").fill("");
        await page.locator("#welcome").evaluate(element => { element.scrollTop = 0; });
        await expect(page.locator(".welcome-subtitle")).toHaveCount(1);
        await expect(page.locator(".welcome-subtitle")).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: resolve(artifacts, `${language}-${colorScheme}.png`) });

        // Reopen with the same persisted state as a returning user; the real onboarding feature
        // decides which welcome to show, without the test changing presentation classes.
        await page.evaluate(() => localStorage.setItem("qingzhou_onboarding_v2", JSON.stringify({ status: "activated" })));
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
        await expect(page.locator("#welcome")).toBeVisible();
        await expect(page.locator(".welcome-onboarding")).toBeHidden();
        await expect(page.locator(".welcome-subtitle")).toBeVisible();
        const tagline = messages[messageId("core.tagline")]?.message
          ?? (language === "zh-CN" ? "万重山外，一舟轻渡" : "A lighter way to get things done.");
        await expect(page.locator(".welcome-subtitle")).toHaveText(tagline);
        if (language === "ja") await expect(page.locator(".welcome-subtitle")).toHaveCSS("white-space", "pre-line");
        await page.screenshot({ path: resolve(artifacts, `${language}-${colorScheme}-welcome.png`) });
      });
    });
  }
}

for (const [locale, language, chromeLocale] of scenarios.filter(([,language]) => ["ja", "ko", "ar", "hi"].includes(language))) {
  test.describe(`${language} offline export`, () => {
    test.use({ locale });
    test("keeps language, direction and original content when opened offline in another language", async ({ page, browser }) => {
      const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: locale, localeMessages: messages, config });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      const snapshot = { session: { id: "world-export", title: "User title / 用户标题" }, transcript: [
        { id: "user", type: "user", text: "用户内容 {name} <script>unchanged</script>" },
        { id: "error", type: "error", text: "Provider detail — unchanged" },
        { id: "original-brand-text", type: "assistant", content: "Qingzhou / 轻舟 / 輕舟 / 軽舟 — original user-provided names" },
      ] };
      const exported = await page.evaluate(async value => {
        await window.qingzhouConversationBenchmark.runSnapshotRender(value, { debug: false, clearStorage: false });
        return window.qingzhouConversationBenchmark.renderSessionDocument(value);
      }, snapshot);
      expect(exported.payload).toMatchObject({ format: "qingzhou.session", version: 1, source: { sessionId: "world-export" } });
      expect(exported.payload.session.title).toBe(snapshot.session.title);
      const recipient = await browser.newContext({ locale: "en-US", offline: true });
      try {
        const offline = await recipient.newPage();
        const errors = [];
        offline.on("pageerror", error => errors.push(error.message));
        await offline.setContent(exported.html);
        await expect(offline.locator("html")).toHaveAttribute("lang", language);
        await expect(offline.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
        await expect(offline).toHaveTitle(snapshot.session.title);
        await expect(offline.locator("#current-session-title")).toHaveText(snapshot.session.title);
        await expect(offline.locator("#messages")).toContainText(snapshot.transcript[0].text);
        await expect(offline.locator("#messages")).toContainText(snapshot.transcript[2].content);
        await expect(offline.locator(".chat-error-card")).toContainText("Provider detail — unchanged");
        await expect(offline.locator("script[src]")).toHaveCount(0);
        await expect(offline.locator("#qingzhou-session-exchange")).toHaveCount(1);
        await offline.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "probe", installed: true }, "*"));
        const cta = offline.locator("#qingzhou-session-cta");
        await expect(cta).toBeVisible();
        await expect(cta).toHaveText({
          ja: "軽舟にインポート", ko: "qz로 가져오기", ar: "استيراد إلى qz", hi: "qz में इंपोर्ट करें",
        }[language]);
        expect(errors).toEqual([]);
      } finally { await recipient.close(); }
    });
  });
}

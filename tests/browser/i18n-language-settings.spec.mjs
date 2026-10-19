import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureCapabilityExtension, resolveTestAsset } from "../support/extension-build.mjs";

test.use({ locale: "en-US", viewport: { width: 360, height: 900 } });
const config = { provider: "custom", model: "qwen3.5-plus", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false };
const storageFixtureKey = "i18n-language-settings-fixture";
const configFixtureKey = "i18n-language-settings-config";

function persistFixtureStorage(key) {
  window.__panelLoads = Number(sessionStorage.getItem("language-panel-loads") || 0) + 1;
  sessionStorage.setItem("language-panel-loads", String(window.__panelLoads));
  chrome.runtime.getURL = path => new URL(`/extension/${path}`, location.origin).href;
  const storage = chrome.storage.local;
  const set = storage.set.bind(storage);
  storage.set = async (...args) => {
    await set(...args);
    localStorage.setItem(key, JSON.stringify(await storage.get(null)));
  };
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const post = port.postMessage;
    port.postMessage = message => {
      if (message.type === "get_composer_draft") {
        window.__qzPostedMessages.push(structuredClone(message));
        queueMicrotask(() => window.__qzEmitPortMessage({
          type: "get_composer_draft_result", requestId: message.requestId, sessionId: message.sessionId,
          draft: JSON.parse(localStorage.getItem(`draft:${message.sessionId}`) || "null"),
        }));
        return;
      }
      if (message.type !== "create_ui_session" && message.type !== "sync_composer_draft") return post(message);
      window.__qzPostedMessages.push(structuredClone(message));
      if (message.type === "sync_composer_draft") localStorage.setItem(`draft:${message.sessionId}`, JSON.stringify(message.draft));
      queueMicrotask(async () => {
        const session = { id: message.id, title: message.title };
        if (message.type === "create_ui_session") {
          // Real Background persists the session index before acknowledging creation.
          const { _sessions = {} } = await storage.get("_sessions");
          await storage.set({ _sessions: { ..._sessions, [session.id]: session } });
          if (message.composerDraft) localStorage.setItem(`draft:${session.id}`, JSON.stringify(message.composerDraft));
        }
        window.__qzEmitPortMessage({
          type: `${message.type}_result`, requestId: message.requestId,
          ...(message.type === "create_ui_session" ? { session } : {}),
        });
      });
    };
    return port;
  };
}

async function openApp(page, initialConfig = config) {
  const options = { config: initialConfig, uiLanguage: "en-US", benchmark: false };
  await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})({ ...${JSON.stringify(options)}, config: JSON.parse(localStorage.getItem(${JSON.stringify(configFixtureKey)}) || ${JSON.stringify(JSON.stringify(initialConfig))}), localStorage: JSON.parse(localStorage.getItem(${JSON.stringify(storageFixtureKey)}) || "{}") }); (${persistFixtureStorage.toString()})(${JSON.stringify(storageFixtureKey)});` });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
  await expect(page.locator('[data-settings-tab="advanced"]')).toBeAttached();
}

async function expectReload(page, language, loads = 2) {
  await page.waitForFunction(loads => window.__panelLoads === loads, loads);
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
}

async function openLanguage(page) {
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="advanced"]').click();
  await expect(page.locator("#settings-save-status")).not.toHaveText("Loading language preference…");
}

async function holdNextStorageWrite(page) {
  await page.evaluate(() => {
    window.__languageWrite = null;
    const storage = chrome.storage.local;
    const set = storage.set.bind(storage);
    storage.set = values => {
      storage.set = set;
      return new Promise((resolve, reject) => {
        window.__languageWrite = {
          resolve: () => set(values).then(resolve, reject),
          reject: () => reject(new Error("synthetic storage failure")),
        };
      });
    };
  });
}

test("saving a changed language reloads the panel once and retains the chat draft", async ({ page }, testInfo) => {
  await openApp(page);
  await page.locator("#input").fill("fixture draft stays unchanged");
  await page.locator("#btn-settings").click();
  await expect(page.locator("#btn-close-settings")).toHaveAccessibleName("Close");
  await expect(page.locator("[data-settings-tab]:visible")).toHaveText(["Model", "Advanced"]);
  await expect(page.locator('[data-settings-tab="i18n-language"]')).toHaveCount(0);
  await page.locator('[data-settings-tab="advanced"]').click();
  const select = page.locator("#i18n-language-select");
  await expect(select).toHaveValue("system");
  await expect(select.locator("option")).toHaveCount(13);
  await expect(select.locator('option[value="system"]')).toHaveText("Follow browser");
  await expect(page.locator('label[for="i18n-language-select"]')).toHaveText("Interface language");
  await expect(page.locator("#i18n-language-description")).toHaveCount(0);
  const label = page.locator('label[for="i18n-language-select"]');
  const rowTitle = page.locator("#settings-panel-advanced .advanced-setting-title").first();
  const typography = element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight, style.lineHeight, style.color];
  };
  expect(await label.evaluate(typography)).toEqual(await rowTitle.evaluate(typography));
  const labelBounds = await label.boundingBox();
  const selectBounds = await select.boundingBox();
  expect(labelBounds.x + labelBounds.width).toBeLessThan(selectBounds.x);
  expect(Math.abs(labelBounds.y + labelBounds.height / 2 - selectBounds.y - selectBounds.height / 2)).toBeLessThan(1);
  const names = await select.locator("option").allTextContents();
  expect(names).toEqual(["Follow browser", "English", "简体中文", "繁體中文", "日本語", "한국어", "Español", "Français", "Deutsch", "Português (Brasil)", "Русский", "العربية", "हिन्दी"]);
  await select.selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "ja");
  await expect(page.locator("#input")).toHaveValue("fixture draft stays unchanged");
  await openLanguage(page);
  await expect(page.locator("#btn-close-settings")).toHaveAccessibleName("閉じる");
  await expect(select).toHaveValue("ja");
  await expect(page.locator('[data-settings-tab="advanced"]')).toHaveText("詳細設定");
  await expect(select.locator('option[value="system"]')).toHaveText("ブラウザーに合わせる");
  await expect(page.locator('label[for="i18n-language-select"]')).toHaveText("表示言語");
  await mkdir(resolve("tests/results/i18n/language-settings"), { recursive: true });
  const screenshot = resolve("tests/results/i18n/language-settings/ja-reloaded.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("language-settings-reloaded", { path: screenshot, contentType: "image/png" });
  expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "save_config" || message.type === "prompt"))).toBe(false);
});

async function configSaveRequest(page, count = 1) {
  await expect.poll(() => page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_config").length)).toBe(count);
  return page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_config").at(-1));
}

async function respondToConfigSave(page, request, error = "") {
  // Background accepts display presets but returns normalized token counts.
  const config = { ...request.config, contextWindow: ({ "128K": 128000, "256K": 256000 })[request.config.contextWindow] ?? request.config.contextWindow };
  await page.evaluate(({ request, error, config, key }) => {
    if (!error) localStorage.setItem(key, JSON.stringify(config));
    window.__qzEmitPortMessage(error
      ? { type: "error", requestId: request.requestId, message: error }
      : { type: "config_saved", requestId: request.requestId, config });
  }, { request, error, config, key: configFixtureKey });
}

async function savedLanguage(page) {
  return page.evaluate(async () => (await import("/extension/sdk/shared/i18n.js")).readLanguagePreference());
}

test("one Advanced save persists the language and model configuration drafts together", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  const select = page.locator("#i18n-language-select");
  const rateLimit = page.locator("#cfg-request-rate-limit");
  expect((await select.boundingBox()).y).toBeLessThan((await rateLimit.boundingBox()).y);
  await select.selectOption("ja");
  await rateLimit.check();
  await page.locator('[data-settings-tab="model"]').click();
  await page.locator("#cfg-context-preset").selectOption("256K");
  await page.locator('[data-settings-tab="advanced"]').click();
  await expect(select).toHaveValue("ja");
  await expect(rateLimit).toBeChecked();
  await page.locator("#btn-save-settings").click();
  const request = await configSaveRequest(page);
  expect(request.config.requestRateLimit).toBe(true);
  expect(request.config.contextWindow).toBe("256K");
  await expect.poll(() => savedLanguage(page)).toBe("ja");
  expect(await page.evaluate(() => window.__panelLoads)).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await respondToConfigSave(page, request);
  await expectReload(page, "ja");
  await openLanguage(page);
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await expect.poll(() => savedLanguage(page)).toBe("ja");
  await expect(rateLimit).toBeChecked();
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
});

for (const failedContribution of ["language", "configuration"]) {
  test(`a failed ${failedContribution} save stays retryable after the other Advanced contribution succeeds`, async ({ page }) => {
    await openApp(page);
    await openLanguage(page);
    await page.locator("#i18n-language-select").selectOption("ko");
    await page.locator("#cfg-request-rate-limit").check();
    await holdNextStorageWrite(page);
    await page.locator("#btn-save-settings").click();
    await page.waitForFunction(() => Boolean(window.__languageWrite));
    const request = await configSaveRequest(page);
    const error = failedContribution === "language" ? "Could not save the language. Try again." : "Could not save configuration. Try again.";
    // Complete the failed contribution first: the other success must not hide it.
    if (failedContribution === "language") {
      await page.evaluate(() => window.__languageWrite.reject());
      await respondToConfigSave(page, request);
    } else {
      await respondToConfigSave(page, request, error);
      await page.evaluate(() => window.__languageWrite.resolve());
    }
    await expect(page.locator("#settings-panel")).toBeVisible();
    const status = page.locator("#settings-save-status");
    if (failedContribution === "language") await expect(status).toHaveText(error);
    else await expect(status).toContainText(error);
    await expect(status).toHaveAttribute("data-tone", "error");
    await expect(page.locator("#btn-save-settings")).toBeEnabled();
    await expect(page.locator("#i18n-language-select")).toHaveValue("ko");
    await expect(page.locator("#cfg-request-rate-limit")).toBeChecked();
    await expect.poll(() => savedLanguage(page)).toBe(failedContribution === "language" ? "system" : "ko");
    await page.locator("#btn-save-settings").click();
    if (failedContribution === "configuration") await respondToConfigSave(page, await configSaveRequest(page, 2));
    await expectReload(page, "ko");
    await openLanguage(page);
    await expect(page.locator("#btn-save-settings")).toBeDisabled();
    await expect(page.locator("#settings-save-status")).not.toHaveAttribute("data-tone", "error");
    await expect.poll(() => savedLanguage(page)).toBe("ko");
    await expect(page.locator("#cfg-request-rate-limit")).toBeChecked();
  });
}

test("language can be saved before a model is configured", async ({ page }) => {
  await openApp(page, { ...config, model: "", apiKey: "", customEndpoint: "" });
  await openLanguage(page);
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await page.locator("#i18n-language-select").selectOption("fr");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "fr");
  await openLanguage(page);
  await expect(page.locator("#i18n-language-select")).toHaveValue("fr");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await expect(page.locator("#settings-panel")).toBeVisible();
  expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "save_config"))).toBe(false);
});

test("switching groups preserves a language draft and closing without saving discards it", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  const select = page.locator("#i18n-language-select");
  await select.selectOption("ar");
  await page.locator('[data-settings-tab="model"]').click();
  await page.locator('[data-settings-tab="advanced"]').click();
  await expect(select).toHaveValue("ar");
  await expect(page.locator("#settings-save-status")).toHaveText("Unsaved changes");
  await page.locator("#btn-close-settings").click();
  await openLanguage(page);
  await expect(select).toHaveValue("system");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
});

test("saving other preferences with an unchanged language does not reload the panel", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  await page.locator("#i18n-language-select").selectOption("ja");
  await page.locator("#i18n-language-select").selectOption("system");
  await page.locator("#cfg-request-rate-limit").check();
  await page.locator("#btn-save-settings").click();
  await respondToConfigSave(page, await configSaveRequest(page));
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await expect(page.locator("#settings-panel")).toBeVisible();
  expect(await page.evaluate(() => window.__panelLoads)).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await savedLanguage(page)).toBe("system");
});

test("a cancelled committed language write waits for a successful save after reopening", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  await page.locator("#i18n-language-select").selectOption("ja");
  await holdNextStorageWrite(page);
  await page.locator("#btn-save-settings").click();
  await page.waitForFunction(() => Boolean(window.__languageWrite));
  await page.locator("#btn-close-settings").click();
  await page.evaluate(() => window.__languageWrite.resolve());
  await expect.poll(() => savedLanguage(page)).toBe("ja");
  await expect(page.locator("#settings-panel")).toBeHidden();
  expect(await page.evaluate(() => window.__panelLoads)).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await openLanguage(page);
  await expect(page.locator("#i18n-language-select")).toHaveValue("ja");
  await page.locator("#cfg-request-rate-limit").check();
  await page.locator("#btn-save-settings").click();
  await respondToConfigSave(page, await configSaveRequest(page));
  await expectReload(page, "ja");
});

test("storage failures keep the selection retryable and use a localized error", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  await page.locator("#i18n-language-select").selectOption("ko");
  await holdNextStorageWrite(page);
  await page.locator("#btn-save-settings").click();
  await page.waitForFunction(() => Boolean(window.__languageWrite));
  await page.evaluate(() => window.__languageWrite.reject());
  await expect(page.locator("#settings-save-status")).toHaveText("Could not save the language. Try again.");
  await expect(page.locator("#i18n-language-select")).toHaveValue("ko");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "ko");
});

test("failed preference reads remain recoverable without exposing storage errors", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  await page.locator("#btn-close-settings").click();
  await page.evaluate(() => {
    const storage = chrome.storage.local;
    const get = storage.get.bind(storage);
    storage.get = async () => { storage.get = get; throw new Error("synthetic read failure"); };
  });
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-save-status")).toHaveText("Could not load the saved language. Reopen settings to try again.");
  await page.locator("#i18n-language-select").selectOption("es");
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "es");
});

test("cancelled saves cannot replace another group's status or a newer language draft", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  const select = page.locator("#i18n-language-select");
  await select.selectOption("ja");
  await holdNextStorageWrite(page);
  await page.locator("#btn-save-settings").click();
  await page.waitForFunction(() => Boolean(window.__languageWrite));
  await page.locator('[data-settings-tab="model"]').click();
  await page.locator("#cfg-context-preset").selectOption("256K");
  await page.evaluate(() => window.__languageWrite.reject());
  await expect(page.locator("#settings-save-status")).toHaveText("Unsaved changes");
  await page.locator("#cfg-context-preset").selectOption("128K");
  await page.locator('[data-settings-tab="advanced"]').click();
  await expect(select).toHaveValue("ja");
  await expect(page.locator("#settings-save-status")).toHaveText("Unsaved changes");
  await holdNextStorageWrite(page);
  await page.locator("#btn-save-settings").click();
  await page.waitForFunction(() => Boolean(window.__languageWrite));
  await select.selectOption("fr");
  await page.evaluate(() => window.__languageWrite.resolve());
  await expect(page.locator("#settings-save-status")).toHaveText("Unsaved changes");
  await expect(select).toHaveValue("fr");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "fr");
});

test("a late preference read cannot overwrite input or a different settings group", async ({ page }) => {
  await openApp(page);
  await openLanguage(page);
  await page.locator("#btn-close-settings").click();
  await page.evaluate(async () => {
    const { saveLanguagePreference } = await import("/extension/sdk/shared/i18n.js");
    await saveLanguagePreference("ja");
    const storage = chrome.storage.local;
    const get = storage.get.bind(storage);
    storage.get = async key => {
      storage.get = get;
      const value = await get(key);
      return new Promise(resolve => { window.__languageRead = () => resolve(value); });
    };
  });
  await page.locator("#btn-settings").click();
  await page.waitForFunction(() => Boolean(window.__languageRead));
  await page.locator("#i18n-language-select").selectOption("hi");
  await page.locator('[data-settings-tab="model"]').click();
  await page.evaluate(() => window.__languageRead());
  await expect(page.locator("#cfg-model")).toHaveValue(config.model);
  await page.locator('[data-settings-tab="advanced"]').click();
  await expect(page.locator("#i18n-language-select")).toHaveValue("hi");
  await expect(page.locator("#settings-save-status")).toHaveText("Unsaved changes");
});

test("saving Follow browser reloads back to its language after an RTL preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  await openLanguage(page);
  await page.locator("#i18n-language-select").selectOption("ar");
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await openLanguage(page);
  await expect(page.locator('[data-settings-tab="advanced"]')).toHaveText("متقدّم");
  await expect(page.locator('label[for="i18n-language-select"]')).toHaveText("لغة الواجهة");
  await expect(page.locator("#i18n-language-select")).toHaveValue("ar");
  const bounds = await page.locator("#i18n-language-select").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  await mkdir(resolve("tests/results/i18n/language-settings"), { recursive: true });
  await page.screenshot({ path: resolve("tests/results/i18n/language-settings/ar-reloaded.png"), animations: "disabled" });
  await page.locator("#i18n-language-select").selectOption("system");
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "en", 3);
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await openLanguage(page);
  await expect(page.locator("#i18n-language-select")).toHaveValue("system");
});

test("Advanced keeps language settings when the built-in settings capability is absent", async ({ page }) => {
  const extensionDir = await ensureCapabilityExtension({ omit: ["settings"] });
  await page.route("**/extension/**", route => {
    const path = resolveTestAsset(decodeURIComponent(new URL(route.request().url()).pathname), { root: process.cwd(), extensionDir });
    return path ? route.fulfill({ path }) : route.abort();
  });
  await openApp(page);
  await openLanguage(page);
  await expect(page.locator('[data-settings-tab="model"], #cfg-model')).toHaveCount(0);
  await expect(page.locator("[data-settings-tab]:visible")).toHaveText(["Advanced"]);
  await expect(page.locator('[data-settings-tab="i18n-language"]')).toHaveCount(0);
  await page.locator("#i18n-language-select").selectOption("ko");
  await page.locator("#btn-save-settings").click();
  await expectReload(page, "ko");
  expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "save_config"))).toBe(false);
});

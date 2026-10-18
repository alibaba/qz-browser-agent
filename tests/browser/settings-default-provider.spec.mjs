import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

test.use({ viewport: { width: 360, height: 800 } });

function installConfigurationBackend() {
  chrome.runtime.getURL = path => new URL(`/extension/${path}`, location.origin).href;
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const post = port.postMessage;
    port.postMessage = message => {
      if (message.type !== "get_config" && message.type !== "list_models") return post(message);
      window.__qzPostedMessages.push(structuredClone(message));
      void (async () => {
        if (message.type === "list_models") {
          window.__qzEmitPortMessage({ type: "models", requestId: message.requestId, models: [] });
          return;
        }
        // Use the shipped config reader and language runtime, not a fixture's chosen provider.
        const { initializeLanguage } = await import("/extension/shared/i18n/index.js");
        await initializeLanguage();
        const { getConfig } = await import("/extension/background/llm/config.js");
        window.__qzEmitPortMessage({ type: "config", requestId: message.requestId, config: await getConfig() });
      })().catch(error => console.error(error));
    };
    return port;
  };
}

async function boot(page, { browserLanguage, preference, config }) {
  const externalRequests = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    externalRequests.push(url.href);
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  const localStorage = {
    ...(preference ? { qingzhou_language: { v: 1, language: preference } } : {}),
    ...(config ? { llmConfig: config } : {}),
  };
  // Install in a single script so the real config reader replaces the canned response before boot.
  await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify({ uiLanguage: browserLanguage, localStorage, benchmark: false })}); (${installConfigurationBackend.toString()})();` });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
  await expect(page.locator("#onboarding-status")).not.toHaveAttribute("data-state", "loading");
  return externalRequests;
}

async function expectConfigUnchanged(page, initialConfig) {
  expect(await page.evaluate(async () => (await chrome.storage.local.get("llmConfig")).llmConfig)).toEqual(initialConfig);
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_config"))).toEqual([]);
}

const languages = [
  { browserLanguage: "zh-CN", language: "zh-CN", provider: "deepseek" },
  { browserLanguage: "zh-TW", language: "zh-TW", provider: "deepseek" },
  { browserLanguage: "en-US", language: "en", provider: "openrouter" },
  { browserLanguage: "ja-JP", language: "ja", provider: "openrouter" },
  { browserLanguage: "en-US", preference: "zh-CN", language: "zh-CN", provider: "deepseek" },
  { browserLanguage: "zh-CN", preference: "en", language: "en", provider: "openrouter" },
];

for (const scenario of languages) {
  test(`first setup uses ${scenario.provider} with browser ${scenario.browserLanguage} and preference ${scenario.preference || "system"}`, async ({ page }) => {
    const externalRequests = await boot(page, scenario);
    await expect(page.locator("html")).toHaveAttribute("lang", scenario.language);
    for (const entry of ["#onboarding-primary-btn", "#btn-settings"]) {
      await page.locator(entry).click();
      await expect(page.locator("#settings-panel")).toBeVisible();
      await expect(page.locator("#cfg-provider")).toHaveValue(scenario.provider);
      await expect(page.locator("#cfg-provider-trigger")).toContainText(scenario.provider === "deepseek" ? "DeepSeek" : "OpenRouter");
      await expect(page.locator("#cfg-apikey")).toHaveValue("");
      if (entry === "#onboarding-primary-btn") await expect(page.locator("#cfg-apikey")).toBeFocused();
      await expectConfigUnchanged(page, undefined);
      await page.locator("#btn-close-settings").click();
    }
    await page.locator("#btn-settings").click();
    const chosen = scenario.provider === "deepseek" ? "openrouter" : "deepseek";
    await chooseProvider(page, chosen);
    await expect(page.locator("#cfg-provider")).toHaveValue(chosen);
    await page.locator("#cfg-apikey").fill("synthetic-unsaved-key");
    await page.locator('[data-settings-tab="advanced"]').click();
    await page.locator('[data-settings-tab="model"]').click();
    await expect(page.locator("#cfg-provider")).toHaveValue(chosen);
    await expect(page.locator("#cfg-apikey")).toHaveValue("synthetic-unsaved-key");
    await expectConfigUnchanged(page, undefined);
    expect(externalRequests).toEqual([]);
  });
}

for (const scenario of [
  { browserLanguage: "zh-CN", provider: "openrouter" },
  { browserLanguage: "en-US", provider: "deepseek" },
  { browserLanguage: "zh-CN", provider: "custom", customEndpoint: "https://fixture.example/v1/chat/completions" },
]) {
  test(`setup preserves the saved ${scenario.provider} provider and credentials in ${scenario.browserLanguage}`, async ({ page }) => {
    // A missing model keeps onboarding available for repairing a partly configured provider.
    const config = { provider: scenario.provider, apiKey: "synthetic-saved-key", model: "", contextWindow: 128000,
      providerApiKeys: { [scenario.provider]: "synthetic-saved-key" },
      ...(scenario.customEndpoint ? { customEndpoint: scenario.customEndpoint, customProtocol: "openai" } : {}),
    };
    const externalRequests = await boot(page, { ...scenario, config });
    for (const entry of ["#onboarding-primary-btn", "#btn-settings"]) {
      await page.locator(entry).click();
      await expect(page.locator("#cfg-provider")).toHaveValue(config.provider);
      await expect(page.locator("#cfg-apikey")).toHaveValue(config.apiKey);
      if (config.customEndpoint) await expect(page.locator("#cfg-custom-endpoint")).toHaveValue(config.customEndpoint);
      await expectConfigUnchanged(page, config);
      await page.locator("#btn-close-settings").click();
    }
    expect(externalRequests).toEqual([]);
  });
}

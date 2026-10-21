import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

const url = "/extension/sidepanel/sidepanel.html";
async function setup(page, options = {}) {
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, dataConsent: false, uiLanguage: "en", ...options });
  await page.goto(url);
  await expect(page.locator(".data-consent")).toBeVisible();
}

test("consent blocks workspace initialization, survives reopening, and starts no task", async ({ page }) => {
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  await setup(page);
  await expect(page.locator("#app")).toHaveAttribute("inert", "");
  // The panel body cannot scroll; the card must sit at the top without relying on focus scrolling.
  expect(await page.evaluate(() => {
    document.body.scrollTop = 0;
    return [getComputedStyle(document.querySelector("#app")).display, document.querySelector(".data-consent").getBoundingClientRect().top];
  })).toEqual(["none", 0]);
  expect(requests.some(value => /\/sidepanel\/app\.js/.test(value))).toBe(false);
  expect(await page.evaluate(() => window.__qzPostedMessages)).toEqual([]);
  await page.locator("[data-consent-accept]").click();
  await expect(page.locator(".data-consent")).toHaveCount(0);
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator(".welcome-onboarding")).toBeVisible();
  expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "prompt"))).toBe(false);
  await page.reload();
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator(".data-consent")).toHaveCount(0);
});

test("a stalled consent read reveals the startup notice", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, dataConsent: false, uiLanguage: "en" });
  await page.addInitScript(() => {
    const local = chrome.storage.local;
    const get = local.get.bind(local);
    local.get = keys => {
      if (keys !== "qz_data_consent") return get(keys);
      window.__consentReadStalled = true;
      return new Promise(() => {});
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__consentReadStalled === true);
  await expect(page.locator("#app")).toHaveAttribute("data-workspace-booting", "");
  await page.clock.runFor(6000);
  await expect(page.locator("#workspace-boot-fallback")).toHaveText("qz is still starting. Wait a moment or reopen the side panel.");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).toHaveCSS("visibility", "visible");
});

test("the startup timer stops while the consent card waits for the user", async ({ page }) => {
  await page.clock.install();
  await setup(page);
  await page.clock.runFor(60_000);
  await expect(page.locator(".data-consent")).toBeVisible();
  await expect(page.locator("#workspace-boot-fallback")).toBeHidden();
  await expect(page.locator("#app")).toHaveAttribute("data-workspace-booting", "");
});

test("save failure keeps the card open and supports retry", async ({ page }) => {
  await setup(page, { consentSaveFailures: 1 });
  await page.locator("[data-consent-accept]").click();
  await expect(page.locator("[data-consent-error]")).toHaveText("Could not save your choice. Try again.");
  await expect(page.locator("[data-consent-accept]")).toBeEnabled();
  expect(await page.evaluate(() => window.__qzPostedMessages)).toEqual([]);
  await page.locator("[data-consent-accept]").click();
  await expect(page.locator(".data-consent")).toHaveCount(0);
});

test("later closes the panel without accepting, and reopening still asks", async ({ page }) => {
  await page.addInitScript(() => { window.close = () => { window.__closed = true; }; });
  await setup(page);
  await page.locator("[data-consent-later]").click();
  expect(await page.evaluate(() => window.__closed)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("__qz_test_consent"))).toBeNull();
  await page.reload();
  await expect(page.locator(".data-consent")).toBeVisible();
});

for (const language of ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "ar", "hi"]) {
  for (const colorScheme of ["light", "dark"]) test(`${language} ${colorScheme}: consent and permission cards fit a narrow panel`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ colorScheme });
    // Use the emitted Chrome catalog to exercise the same lookup as an installed extension.
    const response = await page.request.get(`/extension/_locales/${language.replace("-", "_")}/messages.json`);
    const localeMessages = await response.json();
    await setup(page, { uiLanguage: language, localeMessages });
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    const result = await page.evaluate(async () => {
      const { chromeMessageId } = await import("/extension/shared/i18n/definition.js");
      const { default: messages } = await import("/extension/sidepanel/i18n/messages.js");
      const { t } = await import("/extension/sidepanel/i18n/index.js");
      const nodes = [...document.querySelectorAll(".data-consent [data-i18n]")];
      return { strings: nodes.map(node => [node.textContent, chrome.i18n.getMessage(chromeMessageId(node.dataset.i18n)) || messages.messages[node.dataset.i18n.slice(5)][document.documentElement.lang]]),
        overflow: document.querySelector(".data-consent").scrollWidth > innerWidth,
        heading: t("dataConsentTitle", { brand: t("brand") }) };
    });
    for (const [actual, expected] of result.strings) { expect(expected).not.toBe(""); expect(actual).toBe(expected); }
    expect(result.overflow).toBe(false);
    await expect(page.locator(".data-consent h1")).toHaveText(result.heading);
    await expect(page.locator(".data-consent a")).toHaveAttribute("href", "https://github.com/alibaba/qz-browser-agent/blob/main/docs/permissions.md");
    await page.locator("[data-consent-accept]").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-consent-accept]")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("consent.png") });

    // Render the production waiting card with the same catalogs and skin as the consent page.
    await page.evaluate(async () => {
      const { createWaitingCards } = await import("/extension/sidepanel/features/chat/transcript/waiting-card.js");
      const root = document.createElement("main");
      root.id = "messages";
      root.dataset.chatState = "active";
      document.body.replaceChildren(root);
      window.approvalCards = createWaitingCards({ isCurrentSession: () => true, send() {} });
    });
    for (const kind of ["bookmarks", "history", "location"]) {
      const expected = await page.evaluate(async kind => {
        const { permissionT, browserPermissionMessages } = await import("/extension/shared/browser-permissions.js");
        const { t } = await import("/extension/shared/i18n/backend.js");
        const { backendMessages } = await import("/extension/shared/i18n/backend-messages.js");
        const { default: coreMessages } = await import("/extension/sidepanel/i18n/messages.js");
        const { chromeMessageId } = await import("/extension/shared/i18n/definition.js");
        const { withLanguage } = await import("/extension/shared/i18n/index.js");
        const location = kind === "location";
        const cards = window.approvalCards;
        cards.reset();
        const snapshot = withLanguage("zh-CN", () => ({
          type: "wait", waitId: kind, runId: "preview-run", status: "waiting",
          message: location ? t("locationDisclosure") : permissionT(kind),
          form: location ? { title: t("locationTitle"), locationConsent: true }
            : { title: permissionT("title"), browserPermission: kind },
        }));
        document.querySelector("#messages").replaceChildren(cards.create(snapshot, "preview-session"));
        const catalogs = { "browser-permissions": browserPermissionMessages, backend: backendMessages, core: coreMessages };
        const text = key => {
          const split = key.indexOf(".");
          return chrome.i18n.getMessage(chromeMessageId(key))
            || catalogs[key.slice(0, split)].messages[key.slice(split + 1)]?.[document.documentElement.lang];
        };
        return { title: text(location ? "backend.locationTitle" : "browser-permissions.title"),
          message: text(location ? "backend.locationDisclosure" : `browser-permissions.${kind}`),
          button: text(location ? "core.dataConsentAccept" : "browser-permissions.allow") };
      }, kind);
      for (const value of Object.values(expected)) expect(value).toBeTruthy();
      await expect(page.locator(".waiting-title")).toHaveText(expected.title);
      await expect(page.locator(".waiting-message")).toHaveText(expected.message);
      await expect(page.locator('[data-wait-action="continue"]')).toHaveText(expected.button);
      expect(await page.locator(".waiting-card").evaluate(card => {
        const rect = card.getBoundingClientRect();
        // The pulse animates outside the clipped card; readable content must fit inside it.
        return [...card.querySelectorAll(".waiting-body, .waiting-title, .waiting-message, .waiting-hint, button")].every(node => {
          const bounds = node.getBoundingClientRect();
          return node.scrollWidth <= node.clientWidth + 1 && bounds.left >= rect.left && bounds.right <= rect.right;
        });
      })).toBe(true);
      await page.locator(".msg-waiting").screenshot({ path: testInfo.outputPath(`${kind}.png`) });
    }
  });
}

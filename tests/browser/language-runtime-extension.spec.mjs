import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

/** Exercise the real MV3 worker and Chrome storage; no model or user profile is involved. */
test("saving a language reloads the real extension panel and updates Background", async () => {
  const extension = await ensureTestExtension();
  const profile = await mkdtemp(join(tmpdir(), "qingzhou-language-runtime-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: chromium.executablePath(),
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https?:/, route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const panelUrl = new URL("/sidepanel/sidepanel.html", worker.url()).href;
    let page = await context.newPage();
    await page.goto(panelUrl);
    await acceptDataDisclosure(page);
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
    await page.locator("#btn-settings").click();
    await page.locator('[data-settings-tab="advanced"]').click();
    await page.locator("#i18n-language-select").selectOption("ja");
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    const contentLanguage = () => page.evaluate(() => chrome.runtime.sendMessage({ type: "get_content_language" }));
    await expect.poll(async () => (await contentLanguage()).result.locale).toBe("ja");
    const japanese = await contentLanguage();
    expect(japanese.ok).toBe(true);
    expect(Object.keys(japanese.result.messages).sort()).toEqual(["brand", "importFailed", "noStableSelector"]);
    expect(japanese.result.messages.importFailed).toMatch(/[\u3040-\u30ff]/);
    await page.close();
    page = await context.newPage();
    await page.goto(panelUrl);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await page.locator("#btn-settings").click();
    await page.locator('[data-settings-tab="advanced"]').click();
    await expect(page.locator("#i18n-language-select")).toHaveValue("ja");
    await page.locator("#i18n-language-select").selectOption("ar");
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await expect.poll(async () => (await contentLanguage()).result.locale).toBe("ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
    expect(await page.evaluate(() => Boolean(chrome.runtime.getManifest().web_accessible_resources))).toBe(false);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

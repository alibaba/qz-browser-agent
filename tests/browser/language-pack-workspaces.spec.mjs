import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const scenarios = [
  ["en-US", "en", "en"], ["zh-CN", "zh-CN", "zh_CN"], ["zh-TW", "zh-TW", "zh_TW"],
  ["ja-JP", "ja", "ja"], ["ko-KR", "ko", "ko"], ["es-MX", "es", "es"],
  ["fr-FR", "fr", "fr"], ["de-DE", "de", "de"], ["pt-BR", "pt-BR", "pt_BR"],
  ["ru-RU", "ru", "ru"], ["ar-SA", "ar", "ar"], ["hi-IN", "hi", "hi"],
];
const artifacts = resolve("tests/results/i18n/workspaces");
const messageId = key => `qz_${key.replace(/[^a-z0-9]/g, char => `_${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
const config = { provider: "custom", model: "qwen3.5-plus", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false };
const skill = { name: "fixture-skill", displayName: "fixture-skill", description: "fixture-description", content: "# fixture-content\n\nOriginal / 原文 / نص", scope: "global", status: "active", resources: [], updatedAt: "2026-09-19 12:00:00" };
const task = { id: "fixture-task", title: "fixture-task", parentSessionId: "0", status: "running", updatedAt: "2026-09-19 12:00:00", tracker: { mode: "pagination", current: 1, total: 5 } };
const childTask = { id: "fixture-child", title: "fixture-child", parentSessionId: task.id, status: "idle", updatedAt: "2026-09-19 12:01:00" };

// Extend the same offline Chrome fixture used by language-packs-i18n.spec.mjs.
// The messages still pass through the real transport, lazy capability host and renderers.
function installWorkspaceReplies(sessions) {
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const postMessage = port.postMessage;
    port.postMessage = message => {
      let reply;
      if (message.type === "list_sessions") reply = { type: "list_sessions_result", sessions };
      if (message.type === "list_automations") reply = { type: "automations", automations: [], runs: {} };
      if (message.type === "get_state" && message.sessionId === "fixture-task") reply = { type: "state", sessionId: message.sessionId, status: "running", runtime: { ...sessions[0], sessionId: message.sessionId, running: true } };
      if (reply) {
        window.__qzPostedMessages.push(structuredClone(message));
        queueMicrotask(() => window.__qzEmitPortMessage({ ...reply, requestId: message.requestId }));
      } else postMessage(message);
    };
    return port;
  };
}

async function auditView(page, rootSelector, messages, name, testInfo) {
  const report = await page.locator(rootSelector).evaluate((root, catalog) => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const id = key => `qz_${key.replace(/[^a-z0-9]/g, char => `_${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
    const translations = [];
    for (const element of root.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]")) {
      if (!visible(element)) continue;
      for (const [marker, attribute] of [["data-i18n", null], ["data-i18n-title", "title"], ["data-i18n-aria-label", "aria-label"], ["data-i18n-placeholder", "placeholder"]]) {
        const key = element.getAttribute(marker);
        if (!key) continue;
        // These placeholders are replaced by loaded state; explicit assertions below
        // cover their final values and shortcut descriptions.
        if (["settings-save-status", "btn-save-settings", "side-panel-shortcut-value", "model-switcher-shortcut-value"].includes(element.id)) continue;
        if (attribute === "title" && ["btn-edit-side-panel-shortcut", "btn-edit-model-switcher-shortcut"].includes(element.id)) continue;
        if (element.id === "sessions-search" && attribute === "placeholder") continue;
        if (element.closest("#btn-save-skill-edit-top")) continue;
        const expected = catalog[id(key)];
        if (!expected || /\{\w+\}/.test(expected)) continue;
        const actual = attribute ? element.getAttribute(attribute) : element.textContent;
        if (normalize(actual) !== normalize(expected)) translations.push({ element: element.id || element.tagName, key, attribute, expected, actual });
      }
    }
    const overflow = [...root.querySelectorAll("button, input, select, textarea, .qz-popover, .automation-editor-card, .data-import-card, .automation-filter-tabs")]
      // Tables and status filters own horizontal scrolling. The filter container
      // is bounded here; each filter is checked for scroll reachability below.
      .filter(element => visible(element) && !element.closest(".tabulator") && !element.matches(".automation-filter-btn, .settings-tab"))
      .map(element => ({ element: element.id || element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
      .filter(bounds => bounds.left < -1 || bounds.right > innerWidth + 1);
    // Page scrollWidth alone misses text clipped inside a correctly sized button.
    // User-generated titles may deliberately use ellipsis; action labels may not.
    const clippedLabels = [];
    for (const control of root.querySelectorAll("button")) {
      if (!visible(control) || control.closest(".tabulator")) continue;
      const bounds = control.getBoundingClientRect();
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!normalize(node.textContent) || !visible(node.parentElement) || node.parentElement.closest("svg")) continue;
        const labelStyle = getComputedStyle(node.parentElement);
        if (labelStyle.textOverflow === "ellipsis") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if ([...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)) {
          clippedLabels.push({ element: control.id || control.className, text: normalize(node.textContent) });
        }
      }
    }
    return { translations, overflow, clippedLabels, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  }, messages);
  await testInfo.attach(`${name}-audit.json`, { body: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
  await mkdir(artifacts, { recursive: true });
  const path = resolve(artifacts, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await writeFile(resolve(artifacts, `${name}.json`), JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path, contentType: "image/png" });
  expect.soft(report.translations, `${name}: visible labels and accessible names use the native catalog`).toEqual([]);
  expect.soft(report.overflow, `${name}: controls and menus fit the viewport`).toEqual([]);
  expect.soft(report.clippedLabels, `${name}: action labels fit inside their controls`).toEqual([]);
  expect.soft(report.documentWidth, `${name}: page has no horizontal overflow`).toBeLessThanOrEqual(report.viewportWidth);
}

for (const width of [320, 360, 430]) {
  for (const [locale, language, chromeLocale] of scenarios) {
    for (const colorScheme of ["light", "dark"]) {
      test.describe(`${language} dynamic workspaces · ${colorScheme} · ${width}px`, () => {
        test.use({ locale, colorScheme, viewport: { width, height: 900 } });
        test("localizes settings, tasks, skills and imported data without clipping actions", async ({ page }, testInfo) => {
          test.setTimeout(60_000);
          const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
          const options = { uiLanguage: locale, localeMessages: messages, config, localStorage: { _skills: { [skill.name]: skill }, _sessions: { [task.id]: task, [childTask.id]: childTask } } };
          await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify(options)}); (${installWorkspaceReplies.toString()})(${JSON.stringify([task, childTask])});` });
          await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
          const catalog = await page.evaluateHandle(async ({ catalog, language }) => {
            const { decodeChromeMessage, chromeMessageId } = await import("/extension/shared/i18n/definition.js");
            const { default: capabilities } = await import("/extension/capability-catalogs/translations.js");
            const { default: core } = await import("/extension/sidepanel/i18n/messages.js");
            // English and Simplified Chinese live with their owning packages; other
            // languages are supplied by the installed locale catalog.
            const source = Object.fromEntries([core, ...capabilities].flatMap(pack => Object.entries(pack.messages)
              .map(([key, value]) => [chromeMessageId(`${pack.namespace}.${key}`), value[language] ?? value.en])));
            return { ...source, ...Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, decodeChromeMessage(value)])) };
          }, { catalog: messages, language });
          const decodedMessages = await catalog.jsonValue();
          const t = (key, values = {}) => {
            const message = decodedMessages[messageId(key)];
            expect(message, `compiled catalog contains ${key}`).toBeTruthy();
            return message.replace(/\{(\w+)\}/g, (token, key) => values[key] ?? token);
          };
          await expect(page.locator("html")).toHaveAttribute("lang", language);
          await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
          expect(await page.locator("#app").evaluate(element => getComputedStyle(element).direction)).toBe(language === "ar" ? "rtl" : "ltr");
          const chat = await page.locator('[data-tab="chat"]').boundingBox();
          const tasks = await page.locator('[data-tab="sessions"]').boundingBox();
          expect(chat.x > tasks.x, "Arabic navigation mirrors the visible tab order").toBe(language === "ar");
          // Keep the full oracle in this page instead of resending it for every view.
          const audit = (root, view) => auditView(page, root, catalog, `${language}-${colorScheme}-${width}-${view}`, testInfo);

          await page.locator("#btn-settings").click();
          await expect(page.locator("#cfg-model")).toHaveValue(config.model);
          await page.locator("#btn-add-model-parameter").click();
          await expect(page.locator('[data-model-parameter-field="key"]').last()).toHaveAttribute("aria-label", t("settings.modelParameterKey"));
          await page.keyboard.press("Escape");
          await expect.soft(page.locator('[data-model-parameter-field="key"]').last()).toHaveAttribute("placeholder", t("settings.modelParameterKey"));
          await expect.soft(page.locator('[data-model-parameter-field="value"]').last()).toHaveAttribute("placeholder", t("settings.modelParameterValue"));
          await expect(page.locator("#settings-save-status")).toHaveText(t("settings.saved"));
          await expect(page.locator("#btn-save-settings")).toHaveText(t("settings.saveConfiguration"));
          await audit("#settings-panel", "settings-model");
          await page.locator("#settings-tab-advanced").click();
          await expect(page.locator("#guardrail-rule-action")).toHaveAttribute("aria-label", t("settings.accessAction"));
          await expect(page.locator("#btn-edit-side-panel-shortcut")).toHaveAttribute("title", t("settings.clickToChange", { command: t("settings.openQingzhou"), shortcut: "Ctrl+Shift+K" }));
          await expect(page.locator("#btn-edit-model-switcher-shortcut")).toHaveAttribute("title", t("settings.clickToChange", { command: t("settings.switchModel"), shortcut: "Ctrl+Shift+M" }));
          await expect(page.locator("#i18n-language-select")).toBeVisible();
          const languageText = await page.locator("#i18n-language-select").evaluate(select => {
            const style = getComputedStyle(select);
            const context = document.createElement("canvas").getContext("2d");
            context.font = style.font;
            return {
              width: context.measureText(select.selectedOptions[0].textContent).width,
              available: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            };
          });
          expect.soft(languageText.width, "The selected language fits the compact control").toBeLessThanOrEqual(languageText.available + 2);
          const languageLabelLines = await page.locator('label[for="i18n-language-select"]').evaluate(label =>
            label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight));
          expect.soft(languageLabelLines, "The language label stays readable in a compact settings row").toBeLessThanOrEqual(2.1);
          await expect(page.locator("#settings-tab-i18n-language")).toHaveCount(0);
          await expect(page.locator("#settings-tab-advanced")).toHaveText(t("settings.advanced"));
          await audit("#settings-panel", "settings-advanced");
          const tablist = page.locator(".settings-tabs");
          for (const tab of await tablist.getByRole("tab").all()) {
            await tab.click();
            const viewport = await tablist.boundingBox();
            const bounds = await tab.boundingBox();
            expect.soft(bounds.x, "Selected settings tabs remain reachable").toBeGreaterThanOrEqual(viewport.x - 1);
            expect.soft(bounds.x + bounds.width, "Selected settings tabs remain reachable").toBeLessThanOrEqual(viewport.x + viewport.width + 1);
          }
          await page.locator("#btn-close-settings").click();

          await page.locator('[data-tab="sessions"]').click();
          await expect(page.locator("#sessions-search")).toHaveAttribute("placeholder", t("sessions.searchTasks"));
          await expect(page.locator('.session-card[data-id="fixture-task"]')).toBeVisible();
          await expect(page.locator('.session-card[data-id="fixture-task"] .session-status')).toHaveText(t("sessions.running"));
          await expect(page.locator(".session-tracker-count")).toHaveText(t("sessions.step", { value: 1, total: 5, unit: t("core.pagesUnit") }));
          const toggle = page.locator('[data-session-action="toggle"][data-id="fixture-task"]');
          await expect(toggle).toHaveAttribute("aria-label", t("sessions.expand"));
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-label", t("sessions.collapse"));
          await expect(page.locator('.session-card[data-id="fixture-child"]')).toBeVisible();
          await audit("#sessions-panel", "tasks");
          const parentBounds = await page.locator('.session-card[data-id="fixture-task"]').boundingBox();
          const childBounds = await page.locator('.session-card[data-id="fixture-child"]').boundingBox();
          const indent = language === "ar" ? parentBounds.x + parentBounds.width - childBounds.x - childBounds.width : childBounds.x - parentBounds.x;
          expect.soft(indent, "Child tasks indent from the reading direction, beside their tree connector").toBeGreaterThan(10);
          await page.locator("#sessions-search").fill("missing-fixture");
          await expect(page.locator("#sessions-list")).toContainText(t("sessions.noMatchingTasks"));
          await page.locator("#sessions-search").fill("");
          await page.locator('[data-sessions-mode="automation"]').click();
          await expect(page.locator("#automations-list")).toContainText(t("sessions.noAutomationsYet"));
          await expect(page.locator("#sessions-search")).toHaveAttribute("placeholder", t("sessions.searchAutomations"));
          await audit("#sessions-panel", "automations");
          const filters = await page.locator(".automation-filter-tabs").boundingBox();
          const activeFilter = await page.locator(".automation-filter-btn.active").boundingBox();
          expect.soft(activeFilter.x, "The selected status filter is visible inside its own scroll area").toBeGreaterThanOrEqual(filters.x - 1);
          expect.soft(activeFilter.x + activeFilter.width, "RTL status filters stay reachable").toBeLessThanOrEqual(filters.x + filters.width + 1);
          for (const filter of await page.locator(".automation-filter-btn").all()) {
            await filter.scrollIntoViewIfNeeded();
            const bounds = await filter.boundingBox();
            expect.soft(bounds.x, "Every status filter can scroll fully into view").toBeGreaterThanOrEqual(filters.x - 1);
            expect.soft(bounds.x + bounds.width, "Every status filter can scroll fully into view").toBeLessThanOrEqual(filters.x + filters.width + 1);
          }
          await page.locator(".automation-filter-btn.active").scrollIntoViewIfNeeded();
          await page.locator("#btn-new-automation").click();
          await expect(page.locator("#automation-editor-title")).toHaveText(t("sessions.newAutomation"));
          await page.locator("#automation-frequency").selectOption("weekly");
          await expect(page.locator("#automation-weekday")).toBeVisible();
          await audit("#sessions-panel", "automation-editor");
          await page.locator("#btn-cancel-automation").click();

          await page.locator('[data-tab="skills"]').click();
          const card = page.locator(`.skill-card[data-name="${skill.name}"]`);
          await expect(card.locator(".skill-card-desc")).toHaveText(skill.description);
          await page.locator("#skills-search").fill("missing-fixture");
          await expect(page.locator("#skills-list")).toContainText(t("skills.noMatchingSkills"));
          await page.locator("#skills-search").fill("");
          await page.locator("#btn-import-skills").click();
          await expect(page.locator("#skills-import-menu")).toBeVisible();
          await audit("#skills-panel", "skills-import");
          await page.locator("#btn-import-skills-git").click();
          await expect(page.locator("#git-skill-source-url")).toBeVisible();
          await audit("#git-skill-sources-panel", "skill-git");
          await page.locator("#btn-close-git-skill-sources").click();
          await card.click();
          await expect(page.locator("#skill-detail-content")).toContainText("Original / 原文 / نص");
          await page.locator("#btn-edit-skill").click();
          await expect(page.locator("#skill-body-text")).toBeVisible();
          await page.locator("#skill-body-text").fill(`${skill.content}\nfixture unsaved edit`);
          await page.locator("#btn-back-skills").click();
          await expect(page.locator("#qz-decision-dialog")).toBeVisible();
          await audit("#qz-decision-dialog", "discard-confirmation");
          await page.locator("#qz-decision-cancel").click();
          await expect(page.locator("#skill-body-text")).toHaveValue(`${skill.content}\nfixture unsaved edit`);
          await expect(page.locator("#btn-save-skill-edit-top span")).toHaveText(t("skills.save"));
          await audit("#skill-detail", "skill-editor");
          await page.locator("#btn-preview-skill").click();
          await page.locator("#skill-tab-resources").click();
          await expect(page.locator("#skill-detail")).toContainText(t("skills.noResources"));
          await audit("#skills-panel", "skill-resources");
          await page.locator("#btn-skill-actions").click();
          await expect(page.locator("#skill-actions-menu")).toBeVisible();
          await audit("#skills-panel", "skill-actions");
          await page.locator("#btn-skill-settings").click();
          await expect(page.locator("#skill-settings-view")).toBeVisible();
          await audit("#skill-settings-view", "skill-settings");
          await page.locator("#btn-close-skill-settings").click();
          await page.locator("#skill-tab-mcp").click();
          await page.locator("#btn-add-skill-mcp").click();
          await expect(page.locator("#btn-save-skill-edit-top")).toHaveAttribute("title", t("skills.saveSkill"));
          await audit("#skill-detail", "skill-mcp");

          await page.locator('[data-tab="data"]').click();
          await expect(page.locator('#data-empty [data-i18n="data.noDataTables"]')).toHaveText(t("data.noDataTables"));
          await expect(page.locator('#data-empty [data-i18n="data.createTableHint"]')).toHaveText(t("data.createTableHint"));
          await page.locator("#btn-import-data").click();
          await expect(page.locator("#data-import-panel")).toBeVisible();
          await audit("#data-import-panel", "data-import");
          await page.locator("#data-import-table").fill("fixture-table");
          await page.locator("#data-import-text").fill(JSON.stringify([{ code: "fixture-a", quantity: 2 }, { code: "fixture-b", quantity: 3 }]));
          await page.locator("#btn-import-text").click();
          await expect(page.locator("#data-import-panel")).toBeHidden();
          await expect(page.locator("#data-preview")).toContainText("fixture-a");
          await page.locator("#data-table-search").click();
          await expect(page.locator('.data-table-item[data-table="fixture-table"] .data-table-meta')).toContainText(t("data.rowCount", { count: 2 }));
          await page.locator('.data-table-select[data-table="fixture-table"]').click();
          await page.locator("#btn-data-columns").click();
          await expect(page.locator("#data-columns-menu")).toBeVisible();
          await expect(page.locator("#data-columns-menu")).toContainText(t("data.text"));
          await expect(page.locator("#data-columns-menu")).toContainText(t("data.number"));
          await audit("#data-panel", "data-columns");
          await page.locator("#btn-data-columns").click();
          await page.locator("#data-search").fill("fixture-b");
          await expect(page.locator("#data-preview .tabulator-row")).toHaveCount(1);
          await expect(page.locator("#data-preview .tabulator-row")).toContainText("fixture-b");
          await page.locator("#btn-data-table-actions").click();
          await audit("#data-panel", "data-actions");
          await page.locator("#btn-delete-data").click();
          await expect(page.locator("#qz-decision-dialog")).toBeVisible();
          await audit("#qz-decision-dialog", "delete-confirmation");
          await page.locator("#qz-decision-cancel").click();
          await expect(page.locator("#data-preview")).toContainText("fixture-b");
          expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "prompt"))).toBe(false);
        });
      });
    }
  }
}

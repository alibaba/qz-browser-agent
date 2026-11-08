import { expect, test } from "./fixtures.mjs";
import { providers as modelSnapshot } from "@opencode-ai/models/snapshot";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

const PRESETS = [
  {
    id: "preset-deepseek",
    name: "DeepSeek · deepseek-v4-flash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    contextWindow: 1_000_000,
    vision: false,
  },
  {
    id: "preset-kimi",
    name: "KimiCode · kimi-k3",
    provider: "kimicode",
    model: "kimi-k3",
    contextWindow: 262_000,
    vision: true,
  },
  {
    id: "preset-qwen",
    name: "百炼 · qwen3.7-max",
    provider: "bailian",
    model: "qwen3.7-max",
    contextWindow: 1_000_000,
    vision: false,
  },
];

for (const colorScheme of ["light", "dark"]) {
  test.describe(`model preset switcher · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 760 } });

    test("header button opens the same picker and restores composer focus", async ({ page }, testInfo) => {
      await openSidepanel(page, configForPreset(PRESETS[0]));
      await page.evaluate(() => window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: 'model-switch-button', title: '模型快速切换',
        transcript: [{ type: 'user', text: '继续当前对话' }],
      }));
      const button = page.getByRole('button', { name: '切换模型', exact: true });
      await expect(button).toBeVisible();
      const buttonBox = await button.boundingBox();
      const textSizeBox = await page.locator('#btn-chat-text-size').boundingBox();
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(textSizeBox.x);
      expect(buttonBox.height).toBe(textSizeBox.height);
      await testInfo.attach(`model-switch-button-${colorScheme}.png`, {
        body: await page.locator('#session-title-bar').screenshot(), contentType: 'image/png',
      });
      await button.click();
      const input = page.locator('#model-preset-switcher-input');
      await expect(input).toBeFocused();
      await input.fill('km k3');
      await input.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__qzPostedMessages
        .filter(message => message.type === 'apply_model_preset').length)).toBe(1);
      const request = await page.evaluate(() => window.__qzPostedMessages.find(message => message.type === 'apply_model_preset'));
      expect(request.presetId).toBe('preset-kimi');
      await page.evaluate(({ requestId, config }) => window.__qzEmitPortMessage({ type: 'config', requestId, config }),
        { requestId: request.requestId, config: configForPreset(PRESETS[1]) });
      await expect(page.locator('#model-preset-switcher')).toBeHidden();
      await expect(page.locator('#input')).toBeFocused();
      await button.click();
      await expect(input).toBeFocused();
      await input.press('Escape');
      await expect(page.locator('#input')).toBeFocused();
    });

    test("fuzzy-matches and applies a preset entirely from the keyboard", async ({ page }) => {
      const initialConfig = configForPreset(PRESETS[0]);
      await openSidepanel(page, initialConfig);
      await page.locator("#btn-settings").focus();
      await page.evaluate(() => {
        const dialog = document.querySelector("#model-preset-switcher");
        const composer = document.querySelector("#input");
        window.__qzPresetFocusOrder = [];
        dialog.addEventListener("close", () => window.__qzPresetFocusOrder.push("dialog-close"), { once: true });
        composer.addEventListener("focus", () => {
          window.__qzPresetFocusOrder.push(`composer-focus:${dialog.open}`);
        }, { once: true });
      });
      await emitShortcut(page);

      const dialog = page.locator("#model-preset-switcher");
      const input = page.locator("#model-preset-switcher-input");
      const items = page.locator("[data-model-preset-index]");
      await expect(dialog).toBeVisible();
      await expect(input).toBeFocused();
      await expect(items).toHaveCount(3);
      await expect(items.filter({ hasText: "DeepSeek" }).locator(".model-preset-switcher-current")).toHaveText("当前");
      await expect(items.first()).toHaveAttribute("aria-selected", "true");
      await expect(items.first().locator(".model-preset-switcher-name")).toHaveText("kimi-k3");

      await input.press("ArrowDown");
      await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");
      await input.fill("km k3");
      await expect(items).toHaveCount(1);
      await expect(items.first().locator(".model-preset-switcher-name")).toHaveText("kimi-k3");
      await expect(items.first().locator(".model-preset-switcher-meta")).toHaveText(modelSnapshot["kimi-code-plan-cn"].name);

      await input.press("Enter");
      await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "apply_model_preset"));
      await expect(input).toBeFocused();
      await expect(input).toBeEnabled();
      await expect(input).toHaveJSProperty("readOnly", false);
      await expect(dialog).toHaveAttribute("aria-busy", "true");
      await input.press("Enter");
      expect(await page.evaluate(() => window.__qzPostedMessages
        .filter(message => message.type === "apply_model_preset").length)).toBe(1);
      const request = await page.evaluate(() => {
        return window.__qzPostedMessages.filter(message => message.type === "apply_model_preset").at(-1);
      });
      expect(request.presetId).toBe("preset-kimi");
      await page.evaluate(({ requestId, config }) => {
        window.__qzEmitPortMessage({ type: "config", requestId, config });
      }, {
        requestId: request.requestId,
        config: configForPreset(PRESETS[1]),
      });

      await expect(dialog).toBeHidden();
      await expect(page.locator("#current-model-indicator")).toHaveText(`${modelSnapshot["kimi-code-plan-cn"].name} - kimi-k3`);
      await expect(page.locator("#input")).toBeFocused();
      expect(await page.evaluate(() => window.__qzPresetFocusOrder)).toEqual([
        "dialog-close",
        "composer-focus:false",
      ]);
      await page.keyboard.type("x");
      await expect(page.locator("#input")).toHaveValue("x");
      await page.locator("#input").fill("");

      await page.locator("#btn-settings").focus();
      await emitShortcut(page);
      await expect(dialog).toBeVisible();
      await expect(items.filter({ hasText: "kimi-k3" }).locator(".model-preset-switcher-current")).toHaveText("当前");
      await expect(items.first().locator(".model-preset-switcher-name")).toHaveText("deepseek-v4-flash");
      const geometry = await page.locator(".model-preset-switcher-panel").evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: innerWidth,
          overflow: panel.scrollWidth - panel.clientWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(8);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 8);
      expect(geometry.overflow).toBe(0);
      await input.fill("not-a-preset");
      await expect(page.locator("#model-preset-switcher-status")).toHaveText("没有匹配的模型预设");
      const emptyLayout = await page.evaluate(() => {
        const search = document.querySelector(".model-preset-switcher-search").getBoundingClientRect();
        const list = document.querySelector(".model-preset-switcher-list");
        const footer = document.querySelector(".model-preset-switcher-footer").getBoundingClientRect();
        const status = document.querySelector(".model-preset-switcher-status").getBoundingClientRect();
        return {
          listDisplay: getComputedStyle(list).display,
          searchHeight: search.height,
          footerHeight: footer.height,
          statusGap: status.top - search.bottom,
        };
      });
      expect(emptyLayout.listDisplay).toBe("none");
      expect(emptyLayout.searchHeight).toBeGreaterThanOrEqual(39);
      expect(emptyLayout.searchHeight).toBeLessThanOrEqual(41);
      expect(emptyLayout.footerHeight).toBeGreaterThanOrEqual(25);
      expect(emptyLayout.footerHeight).toBeLessThanOrEqual(27);
      expect(emptyLayout.statusGap).toBeLessThanOrEqual(8);
      await input.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator("#input")).toBeFocused();
    });
  });
}

test("uses learned transitions for a one-keystroke preset switch", async ({ page }) => {
  const initialConfig = {
    ...configForPreset(PRESETS[0]),
    presetUsage: {
      selections: {
        "preset-kimi": 3,
        "preset-qwen": 40,
      },
      transitions: {
        "preset-deepseek": {
          "preset-kimi": 5,
          "preset-qwen": 1,
        },
      },
    },
  };
  await openSidepanel(page, initialConfig);
  await emitShortcut(page);

  const items = page.locator("[data-model-preset-index]");
  await expect(items.first().locator(".model-preset-switcher-name")).toHaveText("kimi-k3");
  await expect(items.first()).toHaveAttribute("aria-selected", "true");
  await page.locator("#model-preset-switcher-input").press("Enter");

  await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "apply_model_preset"));
  const request = await page.evaluate(() => {
    return window.__qzPostedMessages.findLast(message => message.type === "apply_model_preset");
  });
  expect(request.presetId).toBe("preset-kimi");
  await page.evaluate(({ requestId, config }) => {
    window.__qzEmitPortMessage({ type: "config", requestId, config });
  }, {
    requestId: request.requestId,
    config: {
      ...configForPreset(PRESETS[1]),
      presetUsage: initialConfig.presetUsage,
    },
  });
  await expect(page.locator("#model-preset-switcher")).toBeHidden();
});

test("treats selecting the current preset as a no-op and respects IME composition", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await emitShortcut(page);

  const dialog = page.locator("#model-preset-switcher");
  const input = page.locator("#model-preset-switcher-input");
  await input.fill("deepseek-v4-flash");
  await expect(page.locator("[data-model-preset-index]")).toHaveCount(1);

  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "isComposing", { value: true });
      element.dispatchEvent(event);
    }
  });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__qzPostedMessages
    .filter(message => message.type === "apply_model_preset").length)).toBe(0);

  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#input")).toBeFocused();
  expect(await page.evaluate(() => window.__qzPostedMessages
    .filter(message => message.type === "apply_model_preset").length)).toBe(0);
});

test("keeps the upper command-palette anchor and fits a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 320 });
  const extraPresets = Array.from({ length: 9 }, (_, index) => ({
    id: `preset-short-${index}`,
    name: `短窗口模型 ${index + 1}`,
    provider: "deepseek",
    model: `deepseek-short-${index + 1}`,
    contextWindow: 1_000_000,
    vision: false,
  }));
  await openSidepanel(page, {
    ...configForPreset(PRESETS[0]),
    presets: [...PRESETS, ...extraPresets],
  });
  await emitShortcut(page);
  await page.locator(".model-preset-switcher-panel").evaluate(async (panel) => {
    await Promise.all(panel.getAnimations().map(animation => animation.finished));
  });

  const readGeometry = () => page.locator(".model-preset-switcher-panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      scrollable: document.querySelector(".model-preset-switcher-list").scrollHeight
        > document.querySelector(".model-preset-switcher-list").clientHeight,
    };
  });
  const populated = await readGeometry();
  expect(populated.top).toBeGreaterThanOrEqual(44);
  expect(populated.top).toBeLessThanOrEqual(46);
  expect(populated.bottom).toBeLessThanOrEqual(populated.viewportHeight - 23);
  expect(populated.scrollable).toBe(true);

  await page.locator("#model-preset-switcher-input").fill("no-such-preset");
  const empty = await readGeometry();
  expect(Math.abs(empty.top - populated.top)).toBeLessThan(1);
  expect(empty.bottom).toBeLessThanOrEqual(empty.viewportHeight - 23);
});

test("renders a compact Spotlight-style surface for a long preset list", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  const extraPresets = Array.from({ length: 9 }, (_, index) => ({
    id: `preset-extra-${index}`,
    name: `模型 ${index + 1}`,
    provider: "deepseek",
    model: `deepseek-variant-${index + 1}`,
    contextWindow: 1_000_000,
    vision: false,
  }));
  await openSidepanel(page, {
    ...configForPreset(PRESETS[0]),
    presets: [...PRESETS, ...extraPresets],
  });
  await emitShortcut(page);

  const styles = await page.evaluate(() => {
    const panel = document.querySelector(".model-preset-switcher-panel");
    const search = document.querySelector(".model-preset-switcher-search");
    const list = document.querySelector(".model-preset-switcher-list");
    const selected = document.querySelector('.model-preset-switcher-item[aria-selected="true"]');
    const footer = document.querySelector(".model-preset-switcher-footer");
    list.scrollTop = list.scrollHeight;
    const panelRect = panel.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const lastItemRect = list.lastElementChild.getBoundingClientRect();
    return {
      panelBackgroundImage: getComputedStyle(panel).backgroundImage,
      panelBackgroundColor: getComputedStyle(panel).backgroundColor,
      searchBackgroundColor: getComputedStyle(search).backgroundColor,
      searchBorderTop: getComputedStyle(search).borderTopWidth,
      searchBorderBottom: getComputedStyle(search).borderBottomWidth,
      selectedBoxShadow: getComputedStyle(selected).boxShadow,
      scrollbarWidth: getComputedStyle(list, "::-webkit-scrollbar").width,
      scrollable: list.scrollHeight > list.clientHeight,
      footerHeight: footer.getBoundingClientRect().height,
      persistentBottomInset: panelRect.bottom - listRect.bottom,
      lastItemBottomInset: panelRect.bottom - lastItemRect.bottom,
      footerDisplay: getComputedStyle(footer).display,
      footerBorderTop: getComputedStyle(footer).borderTopWidth,
    };
  });
  expect(styles.panelBackgroundImage).toBe("none");
  expect(styles.panelBackgroundColor).toBe(styles.searchBackgroundColor);
  expect(styles.searchBorderTop).toBe("0px");
  expect(styles.searchBorderBottom).toBe("0px");
  expect(styles.selectedBoxShadow).toBe("none");
  expect(styles.scrollbarWidth).toBe("6px");
  expect(styles.scrollable).toBe(true);
  expect(styles.footerDisplay).toBe("flex");
  expect(styles.footerBorderTop).toBe("0px");
  expect(styles.footerHeight).toBeGreaterThanOrEqual(7);
  expect(styles.footerHeight).toBeLessThanOrEqual(9);
  expect(styles.persistentBottomInset).toBeGreaterThanOrEqual(7);
  expect(styles.persistentBottomInset).toBeLessThanOrEqual(10);
  expect(styles.lastItemBottomInset).toBeGreaterThanOrEqual(13);
  await expect(page.locator(".model-preset-switcher-item")).toHaveCount(12);
  await expect(page.locator(".model-preset-switcher-item").first().locator(".model-preset-switcher-name"))
    .toHaveText("kimi-k3");
  await expect(page.locator(".model-preset-switcher-item").first().locator(".model-preset-switcher-meta"))
    .toHaveText(modelSnapshot["kimi-code-plan-cn"].name);
});

test("advanced settings presents both Chrome shortcuts with one visual contract", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await page.locator("#btn-settings").click();
  await page.locator("#settings-tab-advanced").click();

  const sidePanelButton = page.locator("#btn-edit-side-panel-shortcut");
  const switcherButton = page.locator("#btn-edit-model-switcher-shortcut");
  await expect(sidePanelButton.locator("kbd")).toHaveText("Ctrl + Shift + K");
  await expect(switcherButton.locator("kbd")).toHaveText("Ctrl + Shift + M");
  await expect(sidePanelButton.locator("xpath=preceding-sibling::*[1]")).toHaveText("唤起轻舟");
  await expect(switcherButton.locator("xpath=preceding-sibling::*[1]")).toHaveText("切换模型");
  expect(await sidePanelButton.getAttribute("class")).toBe(await switcherButton.getAttribute("class"));

  await switcherButton.click();
  await expect.poll(async () => page.evaluate(() => window.__qzCreatedTabs.at(-1)?.url)).toBe("chrome://extensions/shortcuts");

  await page.evaluate(() => {
    window.__qzCommands = [
      { name: "_execute_action", shortcut: "Ctrl+Shift+J" },
      { name: "open-model-preset-switcher", shortcut: "Ctrl+Shift+L" },
    ];
  });
  await expect(sidePanelButton.locator("kbd")).toHaveText("Ctrl + Shift + J");
  await expect(switcherButton.locator("kbd")).toHaveText("Ctrl + Shift + L");

  await page.locator("#settings-tab-model").click();
  const readsAfterLeavingAdvanced = await page.evaluate(() => window.__qzCommandsGetAllCount);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__qzCommandsGetAllCount)).toBe(readsAfterLeavingAdvanced);

  await page.locator("#settings-tab-advanced").click();
  await expect.poll(async () => page.evaluate(() => window.__qzCommandsGetAllCount)).toBeGreaterThan(readsAfterLeavingAdvanced);
  await page.locator("#btn-close-settings").click();
  const readsAfterClosingSettings = await page.evaluate(() => window.__qzCommandsGetAllCount);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__qzCommandsGetAllCount)).toBe(readsAfterClosingSettings);
});

test("keeps the keyboard flow recoverable when preset application fails", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await emitShortcut(page);
  const dialog = page.locator("#model-preset-switcher");
  const input = page.locator("#model-preset-switcher-input");
  await input.fill("kimi");
  await input.press("Enter");
  await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "apply_model_preset"));
  const requestId = await page.evaluate(() => {
    return window.__qzPostedMessages.findLast(message => message.type === "apply_model_preset")?.requestId;
  });
  await page.evaluate((id) => window.__qzEmitPortMessage({
    type: "error",
    requestId: id,
    message: "模型服务暂时不可用",
  }), requestId);

  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await expect(page.locator("#model-preset-switcher-status")).toHaveText("模型服务暂时不可用");
  await input.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#input")).toBeFocused();
});

test("defers shortcut focus until the Side Panel document reports real focus", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await installPresetFocusProbe(page);
  await page.evaluate(() => { window.__qzDocumentFocused = false; });
  await emitShortcut(page);
  await expect(page.locator("#model-preset-switcher")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__qzPresetExplicitFocus)).toEqual({ focus: 0, select: 0 });

  await page.evaluate(() => {
    window.__qzDocumentFocused = true;
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await expect.poll(() => page.evaluate(() => window.__qzPresetExplicitFocus)).toEqual({ focus: 1, select: 1 });
  await expect(page.locator("#model-preset-switcher-input")).toBeFocused();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("#model-preset-switcher-input")).toBeFocused();

  await page.evaluate(() => {
    window.__qzDocumentFocused = false;
    document.querySelector("#model-preset-switcher-input").dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
  });
  await expect(page.locator("#model-preset-switcher")).toBeHidden();
  await page.evaluate(() => {
    window.__qzDocumentFocused = true;
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await expect(page.locator("#input")).toBeFocused();
  expect(await page.evaluate(() => window.__qzPresetExplicitFocus)).toEqual({ focus: 1, select: 1 });
});

test("restores a failed preset search after focus returns without selecting its query", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await installPresetFocusProbe(page);
  await emitShortcut(page);
  const input = page.locator("#model-preset-switcher-input");
  await input.fill("kimi");
  await input.press("Enter");
  await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "apply_model_preset"));
  const requestId = await page.evaluate(() => {
    return window.__qzPostedMessages.findLast(message => message.type === "apply_model_preset")?.requestId;
  });
  const callsBeforeError = await page.evaluate(() => ({ ...window.__qzPresetExplicitFocus }));
  await page.evaluate((id) => {
    window.__qzDocumentFocused = false;
    window.__qzEmitPortMessage({
      type: "error",
      requestId: id,
      message: "模型服务暂时不可用",
    });
  }, requestId);
  await expect(page.locator("#model-preset-switcher-status")).toHaveText("模型服务暂时不可用");
  expect(await page.evaluate(() => window.__qzPresetExplicitFocus)).toEqual(callsBeforeError);

  await page.evaluate(() => {
    window.__qzDocumentFocused = true;
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await expect.poll(() => page.evaluate(() => window.__qzPresetExplicitFocus.focus))
    .toBe(callsBeforeError.focus + 1);
  expect(await page.evaluate(() => window.__qzPresetExplicitFocus.select)).toBe(callsBeforeError.select);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("kimi");
  await input.press("Escape");
});

test("focuses the Composer when Chrome reveals an already-focused Side Panel document", async ({ page }) => {
  await openSidepanel(page, configForPreset(PRESETS[0]));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator("#btn-settings").focus();
  await expect(page.locator("#btn-settings")).toBeFocused();
  await page.evaluate(() => window.__qzEmitSidePanelOpened({ windowId: 1 }));
  await expect(page.locator("#input")).toBeFocused();
});

async function openSidepanel(page, config) {
  await page.addInitScript(installBenchmarkChromeStub, { config });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  await page.locator("#input").focus();
}

async function emitShortcut(page) {
  await page.evaluate(() => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
    type: "model_preset_switcher_requested",
    source: "shortcut",
  }));
}

async function installPresetFocusProbe(page) {
  await page.evaluate(() => {
    const input = document.querySelector("#model-preset-switcher-input");
    const nativeFocus = input.focus.bind(input);
    const nativeSelect = input.select.bind(input);
    window.__qzPresetExplicitFocus = { focus: 0, select: 0 };
    window.__qzDocumentFocused = true;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => window.__qzDocumentFocused,
    });
    input.focus = (options) => {
      window.__qzPresetExplicitFocus.focus += 1;
      nativeFocus(options);
    };
    input.select = () => {
      window.__qzPresetExplicitFocus.select += 1;
      nativeSelect();
    };
  });
}

function configForPreset(preset) {
  return {
    ...preset,
    apiKey: "test-key",
    activePresetId: preset.id,
    presets: PRESETS,
    providerApiKeys: {
      deepseek: "test-key",
      kimicode: "test-key",
      bailian: "test-key",
    },
    modelParameters: {},
    trimOldToolResults: true,
    requestRateLimit: false,
    debugMode: false,
    securityGuardrails: { rules: [], siteOpenRateLimits: [], order: [] },
  };
}

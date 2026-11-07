import { expect, test, testAssetUrl } from "./fixtures.mjs";
const contentScripts = [
  "extension/content/article-extractor.js",
  "extension/content/content-script.js",
];

async function installContentScript(page, html) {
  await page.setContent(`<base href="https://example.test/upload/">${html}`);
  await page.evaluate(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    const runtime = {
      getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
      onMessage: {
        addListener(nextListener) {
          listener = nextListener;
        },
      },
      sendMessage: async () => ({ ok: true }),
    };
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: runtime,
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  });
  for (const script of contentScripts) {
    await page.addScriptTag({ url: testAssetUrl(script) });
  }
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function callContent(page, action, params = {}) {
  return page.evaluate(
    ({ nextAction, nextParams }) => window.__callQingzhouContent(nextAction, nextParams),
    { nextAction: action, nextParams: params },
  );
}

const contentLanguages = {
  ja: { v: 1, locale: "ja", messages: {
    brand: "Qingzhou", noStableSelector: "この要素の安定したセレクターを生成できませんでした", importFailed: "チャットをインポートできませんでした",
  } },
  ar: { v: 1, locale: "ar", messages: {
    brand: "Qingzhou", noStableSelector: "تعذّر إنشاء محدّد ثابت لهذا العنصر", importFailed: "تعذّر استيراد المحادثة",
  } },
};

async function startPicker(page, resultKey = "picked") {
  await page.evaluate(key => {
    globalThis[key] = null;
    void window.__callQingzhouContent("startElementPicker").then(result => { globalThis[key] = result; });
  }, resultKey);
}

async function selectWithoutStableSelector(page) {
  await expect(page.locator("div[data-qingzhou-element-picker]")).toHaveCount(1);
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="pick-me"]');
    const querySelectorAll = document.querySelectorAll;
    // Exercise the actual picker error path when the DOM cannot verify a selector.
    document.querySelectorAll = () => { throw new Error("fixture selector verification unavailable"); };
    try { target.click(); }
    finally { document.querySelectorAll = querySelectorAll; }
  });
  await expect.poll(() => page.evaluate(() => globalThis.picked?.code)).toBe("ELEMENT_PICKER_SELECTOR_FAILED");
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
  return page.evaluate(() => globalThis.picked);
}

test("Content cancels a picker before a delayed language reply without reviving its overlay", async ({ page }) => {
  await installContentScript(page, '<main><button data-testid="pick-me">Pick target</button></main>');
  await page.evaluate(() => {
    globalThis.languageRequests = 0;
    globalThis.normalClicks = 0;
    document.querySelector('[data-testid="pick-me"]').addEventListener("click", () => { globalThis.normalClicks++; });
    chrome.runtime.sendMessage = message => {
      if (message.type !== "get_content_language") throw new Error("Unexpected Content request");
      globalThis.languageRequests++;
      return new Promise(resolve => { globalThis.releaseLanguage = resolve; });
    };
  });
  await startPicker(page);
  await expect.poll(() => page.evaluate(() => globalThis.languageRequests)).toBe(1);
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
  expect(await callContent(page, "cancelElementPicker")).toMatchObject({ ok: true, status: "cancelled" });
  await page.evaluate(result => globalThis.releaseLanguage({ ok: true, result }), contentLanguages.ja);
  await expect.poll(() => page.evaluate(() => globalThis.picked?.status)).toBe("cancelled");
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
  await page.getByTestId("pick-me").click();
  expect(await page.evaluate(() => globalThis.normalClicks)).toBe(1);

  // The same injected script must permit another interaction after cancellation.
  await startPicker(page);
  await expect.poll(() => page.evaluate(() => globalThis.languageRequests)).toBe(2);
  await page.evaluate(result => globalThis.releaseLanguage({ ok: true, result }), contentLanguages.ar);
  expect((await selectWithoutStableSelector(page)).error).toBe(contentLanguages.ar.messages.noStableSelector);
  expect(await page.evaluate(() => globalThis.normalClicks)).toBe(1);
});

test("Content retries language failures and refreshes the next picker on the same page", async ({ page }) => {
  await installContentScript(page, '<main><button data-testid="pick-me">Pick target</button></main>');
  await page.evaluate(snapshots => {
    globalThis.languageRequests = 0;
    chrome.runtime.sendMessage = async message => {
      if (message.type !== "get_content_language") throw new Error("Unexpected Content request");
      const attempt = ++globalThis.languageRequests;
      if (attempt === 1) throw new Error("extension restarting");
      return { ok: true, result: snapshots[attempt - 2] };
    };
  }, [contentLanguages.ja, contentLanguages.ar]);

  await startPicker(page);
  expect((await selectWithoutStableSelector(page)).error).toBe("无法为该元素生成稳定 selector");
  for (const language of ["ja", "ar"]) {
    await startPicker(page);
    expect((await selectWithoutStableSelector(page)).error).toBe(contentLanguages[language].messages.noStableSelector);
  }
  expect(await page.evaluate(() => globalThis.languageRequests)).toBe(3);
});

test("a newer Content picker supersedes a pending start while sharing its language request", async ({ page }) => {
  await installContentScript(page, '<main><button data-testid="pick-me">Pick target</button></main>');
  await page.evaluate(() => {
    globalThis.languageRequests = 0;
    chrome.runtime.sendMessage = message => {
      if (message.type !== "get_content_language") throw new Error("Unexpected Content request");
      globalThis.languageRequests++;
      return new Promise(resolve => { globalThis.releaseLanguage = resolve; });
    };
  });
  await startPicker(page, "olderPicker");
  await startPicker(page);
  expect(await page.evaluate(() => globalThis.languageRequests)).toBe(1);
  await page.evaluate(result => globalThis.releaseLanguage({ ok: true, result }), contentLanguages.ja);
  await expect.poll(() => page.evaluate(() => globalThis.olderPicker?.status)).toBe("cancelled");
  await expect(page.locator("div[data-qingzhou-element-picker]")).toHaveCount(1);
  await page.getByTestId("pick-me").click();
  await expect.poll(() => page.evaluate(() => globalThis.picked?.status)).toBe("selected");
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
});

test("self-contained Content resolves picker selectors without vendor globals and releases its listeners", async ({ page }) => {
  await installContentScript(page, '<main><button data-testid="pick-me">Pick target</button><button>Other</button></main>');
  expect(await page.evaluate(() => ["Readability", "TurndownService", "turndownPluginGfm", "QingzhouFinder"].map(name => typeof globalThis[name])))
    .toEqual(["undefined", "undefined", "undefined", "undefined"]);
  await page.evaluate(() => {
    globalThis.normalClicks = 0;
    document.querySelector('[data-testid="pick-me"]').addEventListener("click", () => { globalThis.normalClicks++; });
    globalThis.picked = null;
    void window.__callQingzhouContent("startElementPicker").then(result => { globalThis.picked = result; });
  });
  await expect(page.locator("div[data-qingzhou-element-picker]")).toHaveCount(1);
  await page.getByTestId("pick-me").click();
  await expect.poll(() => page.evaluate(() => globalThis.picked?.status)).toBe("selected");
  const selected = await page.evaluate(() => ({
    ...globalThis.picked,
    exactTarget: document.querySelector(globalThis.picked.selector) === document.querySelector('[data-testid="pick-me"]'),
    count: document.querySelectorAll(globalThis.picked.selector).length,
    normalClicks: globalThis.normalClicks,
  }));
  expect(selected).toMatchObject({ ok: true, exactTarget: true, count: 1, normalClicks: 0 });
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
  await page.getByTestId("pick-me").click();
  expect(await page.evaluate(() => globalThis.normalClicks)).toBe(1);
  await page.evaluate(() => {
    globalThis.picked = null;
    void window.__callQingzhouContent("startElementPicker").then(result => { globalThis.picked = result; });
  });
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => globalThis.picked?.status)).toBe("cancelled");
  await expect(page.locator("[data-qingzhou-element-picker]")).toHaveCount(0);
});

test("element operations preserve selector errors and recover with the same matched target", async ({ page }) => {
  await installContentScript(page, '<main><button class="target">First</button><button class="target">Second</button></main>');
  for (const action of ["inspectElement", "scrollElementIntoView", "actOnElement", "resolveClickTarget"]) {
    for (const [selector, index, code] of [["", 0, "MISSING_SELECTOR"], ["[", 0, "INVALID_SELECTOR"], [".missing", 0, "ELEMENT_NOT_FOUND"], [".target", 2, "ELEMENT_NOT_FOUND"]]) {
      const result = await callContent(page, action, { selector, index, elementAction: "scroll" });
      expect(result.code, `${action}: ${selector}[${index}]`).toBe(code);
      expect(result.error).toBeTruthy();
      expect(Array.isArray(result.interactable)).toBe(true);
      expect(result.details.target).toBe(selector);
      if (code === "ELEMENT_NOT_FOUND") expect(result.details).toMatchObject({ index, matched: selector === ".target" ? 2 : 0 });
    }
    const result = await callContent(page, action, { selector: ".target", index: 1, elementAction: "scroll" });
    expect(result.error).toBeUndefined();
    expect(result.index).toBe(1);
    if (action === "inspectElement" || action === "scrollElementIntoView") {
      expect(result.matched).toBe(2);
      expect(result.text).toBe("Second");
    } else expect(result.element.text).toBe("Second");
  }
});

test("file inputs remain observable without being presented as editable text fields", async ({ page }) => {
  await installContentScript(page, `
    <main>
      <label for="resume">上传简历</label>
      <input id="resume" type="file" accept=".pdf,image/png" multiple>
      <input id="query" type="text" value="ordinary text">
    </main>
  `);

  const before = await callContent(page, "pageOverview", { selector: "body", limit: 20 });
  const fileAction = before.actions.find(item => item.type === "file");
  expect(fileAction).toMatchObject({
    role: "button",
    type: "file",
    accept: ".pdf,image/png",
    multiple: true,
    selectedFileCount: 0,
    editable: false,
    value: "",
  });

  await page.locator("#resume").setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("test resume"),
  });

  const inspection = await callContent(page, "inspectElement", { selector: "#resume", index: 0 });
  expect(inspection).toMatchObject({
    role: "button",
    type: "file",
    accept: ".pdf,image/png",
    multiple: true,
    selectedFileCount: 1,
    editable: false,
    value: "",
  });
  expect(JSON.stringify(inspection)).not.toContain("fakepath");
});

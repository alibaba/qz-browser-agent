import { expect, test, testAssetUrl } from "./fixtures.mjs";

const contentScripts = [
  "extension/content/article-extractor.js",
  "extension/content/content-script.js",
];

async function installContentScript(page, html) {
  await page.setContent(`<base href="https://example.test/form/">${html}`);
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

async function callSelect(page, params = {}) {
  return page.evaluate(
    ({ nextParams }) => window.__callQingzhouContent("actOnElement", nextParams),
    {
      nextParams: {
        selector: "#city",
        elementAction: "select",
        ...params,
      },
    },
  );
}

const selectHtml = `
  <label for="city">城市</label>
  <select id="city">
    <option value="">请选择</option>
    <option value="sh">上海</option>
    <option value="bj">北京</option>
    <option value="gz"> 广州 </option>
    <option value=" overlap ">重叠值标签</option>
    <option value="collision">collision-as-value</option>
    <option value="other">collision</option>
    <option value="dup">第一份重复</option>
    <option value="dup">第二份重复</option>
    <option value=" spaced ">空格值</option>
  </select>
`;

test("select matches exact option.value before label", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "sh" });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("sh");
  expect(result.selectedLabel).toBe("上海");
  expect(await page.locator("#city").inputValue()).toBe("sh");
});

test("select falls back to visible label when value differs", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "北京" });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("bj");
  expect(result.selectedLabel).toBe("北京");
  expect(await page.locator("#city").inputValue()).toBe("bj");
});

test("select ignores surrounding whitespace for label matching", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "  广州  " });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("gz");
  expect(result.selectedLabel).toBe("广州");
});

test("select prefers exact value when label and value collide", async ({ page }) => {
  await installContentScript(page, selectHtml);
  // "collision" is both an option.value and another option's visible label.
  const result = await callSelect(page, { value: "collision" });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("collision");
  expect(result.selectedLabel).toBe("collision-as-value");
});

test("select by label still works when a different option uses that string as value", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "collision-as-value" });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("collision");
  expect(result.selectedLabel).toBe("collision-as-value");
});

test("select uses option index so duplicate values pick the first match", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "第一份重复" });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("dup");
  expect(result.selectedLabel).toBe("第一份重复");
  const selectedIndex = await page.locator("#city").evaluate(el => el.selectedIndex);
  const label = await page.locator("#city").evaluate(el => el.options[el.selectedIndex].label.trim());
  expect(label).toBe("第一份重复");
  expect(selectedIndex).toBeGreaterThan(0);

  const second = await callSelect(page, { value: "第二份重复" });
  expect(second.error).toBeUndefined();
  expect(second.selected).toBe("dup");
  expect(second.selectedLabel).toBe("第二份重复");
  const secondLabel = await page.locator("#city").evaluate(el => el.options[el.selectedIndex].label.trim());
  expect(secondLabel).toBe("第二份重复");
});

test("select matches untrimmed option.value that contains surrounding whitespace", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: " spaced " });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe(" spaced ");
  expect(result.selectedLabel).toBe("空格值");
});

test("select returns OPTION_NOT_FOUND when neither value nor label matches", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callSelect(page, { value: "不存在的城市" });
  expect(result.code).toBe("OPTION_NOT_FOUND");
  expect(await page.locator("#city").inputValue()).toBe("");
});

test("select with action instead of elementAction would overwrite the route (regression guard)", async ({ page }) => {
  await installContentScript(page, selectHtml);
  // Spreading action into the message overwrites content action "actOnElement".
  const broken = await page.evaluate(() => window.__callQingzhouContent("actOnElement", {
    selector: "#city",
    action: "select",
    value: "bj",
  }));
  expect(broken.code).toBe("UNKNOWN_ACTION");

  const ok = await callSelect(page, { value: "bj" });
  expect(ok.error).toBeUndefined();
  expect(ok.selected).toBe("bj");
});

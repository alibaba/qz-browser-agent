import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

const providers = [
  { id: "fixture-a", label: "Fixture Alpha", requiresApiKey: true, endpoint: "https://alpha.invalid/v1/chat/completions" },
  { id: "fixture-b", label: "Fixture Beta", requiresApiKey: true, endpoint: "https://beta.invalid/v1/chat/completions" },
  { id: "custom", label: "Custom endpoint", requiresApiKey: false, customEndpoint: true },
];
const config = {
  provider: "fixture-a", apiKey: "fixture-key-a", model: "", contextWindow: 128_000, vision: false,
  providerApiKeys: { "fixture-a": "fixture-key-a", "fixture-b": "fixture-key-b" }, providers,
};
const alphaModels = [{ id: "alpha-one", label: "Alpha One" }, { id: "alpha-two", label: "Alpha Two" }];
const betaModels = [{ id: "beta-one", label: "Beta One" }, { id: "beta-two", label: "Beta Two" }];

// Hold just the two public model API responses; the ordinary transport and settings UI still run.
function deferModelRequests() {
  const connect = window.chrome.runtime.connect;
  window.chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const post = port.postMessage;
    port.postMessage = message => {
      if (["list_models", "match_model_capabilities"].includes(message.type)) {
        window.__qzPostedMessages.push(structuredClone(message));
        return;
      }
      post(message);
    };
    return port;
  };
}

test.use({ viewport: { width: 430, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify({ config })}); (${deferModelRequests.toString()})();` });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  await page.locator("#btn-settings").click();
  await expect(page.locator("#cfg-provider")).toHaveValue("fixture-a");
});

async function request(page, type, { provider, model, after = "" } = {}) {
  const criteria = { type, provider, model, after };
  await page.waitForFunction(({ type, provider, model, after }) => {
    const messages = window.__qzPostedMessages;
    const offset = after ? messages.findIndex(message => message.requestId === after) + 1 : 0;
    return messages.slice(offset).some(message => message.type === type && (!provider || message.provider === provider) && (model === undefined || message.model === model));
  }, criteria);
  return page.evaluate(({ type, provider, model, after }) => {
    const messages = window.__qzPostedMessages;
    const offset = after ? messages.findIndex(message => message.requestId === after) + 1 : 0;
    return messages.slice(offset).filter(message => message.type === type && (!provider || message.provider === provider) && (model === undefined || message.model === model)).at(-1);
  }, criteria);
}

async function models(page, pending, values, error = false) {
  await page.evaluate(({ pending, values, error }) => window.__qzEmitPortMessage(error
    ? { type: "error", requestId: pending.requestId, code: "MODEL_LIST_UNAVAILABLE", message: "stale directory failure" }
    : { type: "models", requestId: pending.requestId, provider: pending.provider, models: values }), { pending, values, error });
}
async function capabilities(page, pending, match) {
  await page.evaluate(({ pending, match }) => window.__qzEmitPortMessage({ type: "model_capabilities", requestId: pending.requestId, match }), { pending, match });
}
async function expectModels(page, values) {
  const menu = page.locator("#cfg-model-options");
  if (!await menu.isVisible()) await page.locator("#cfg-model-toggle").click();
  await expect(menu.getByRole("option")).toHaveText(values.map(value => value.label));
}
async function settleInitialList(page) {
  const initial = await request(page, "list_models", { provider: "fixture-a" });
  await models(page, initial, alphaModels);
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取/);
  return initial;
}

for (const oldFails of [false, true]) {
  test(`rapid A → B → A ignores old ${oldFails ? "failures" : "successes"} without ending current loading`, async ({ page }) => {
    const first = await request(page, "list_models", { provider: "fixture-a" });
    await chooseProvider(page, "fixture-b");
    const second = await request(page, "list_models", { provider: "fixture-b", after: first.requestId });
    await chooseProvider(page, "fixture-a");
    const current = await request(page, "list_models", { provider: "fixture-a", after: second.requestId });
    await models(page, second, betaModels, oldFails);
    await models(page, first, [{ id: "obsolete", label: "Obsolete Alpha" }], oldFails);
    await expect(page.locator("#cfg-model")).toHaveValue("");
    await expect(page.locator("#cfg-model")).toHaveAttribute("title", /正在获取/);
    await models(page, current, alphaModels);
    await expectModels(page, alphaModels);
    await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取/);
    await expect(page.locator("#settings-save-status")).not.toContainText("stale directory failure");
  });

  test(`a late ${oldFails ? "failed" : "successful"} response cannot replace a newer provider's loaded list`, async ({ page }) => {
    const old = await request(page, "list_models", { provider: "fixture-a" });
    await chooseProvider(page, "fixture-b");
    const current = await request(page, "list_models", { provider: "fixture-b", after: old.requestId });
    await models(page, current, betaModels);
    await expectModels(page, betaModels);
    await models(page, old, alphaModels, oldFails);
    await expectModels(page, betaModels);
    await expect(page.locator("#cfg-provider")).toHaveValue("fixture-b");
  });
}

test("a pending directory cannot replace custom input, and returning loads the original provider afresh", async ({ page }) => {
  const old = await request(page, "list_models", { provider: "fixture-a" });
  await chooseProvider(page, "custom");
  await page.locator("#cfg-model").fill("my-private-model");
  await models(page, old, alphaModels);
  await expect(page.locator("#cfg-model")).toHaveValue("my-private-model");
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveCount(0);
  await expect(page.locator("#cfg-context-preset")).toHaveValue("");
  await chooseProvider(page, "fixture-a");
  const current = await request(page, "list_models", { provider: "fixture-a", after: old.requestId });
  await models(page, current, alphaModels);
  await expectModels(page, alphaModels);
  await expect(page.locator("#cfg-model")).toHaveValue("");
});

test("out-of-order capability matches keep the latest model's defaults", async ({ page }) => {
  await settleInitialList(page);
  await page.locator("#cfg-model").fill("alpha-one");
  const old = await request(page, "match_model_capabilities", { model: "alpha-one" });
  await page.locator("#cfg-model").fill("alpha-two");
  const current = await request(page, "match_model_capabilities", { model: "alpha-two" });
  await capabilities(page, current, { matched: true, contextWindow: 256_000, vision: false });
  await capabilities(page, old, { matched: true, contextWindow: 1_000_000, vision: true });
  await expect(page.locator("#cfg-model")).toHaveValue("alpha-two");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-vision")).toHaveValue("false");
});

for (const field of ["preset", "custom-context", "vision"]) {
  test(`late model defaults cannot overwrite a user's ${field} edit`, async ({ page }) => {
    await settleInitialList(page);
    await page.locator("#cfg-model").fill("alpha-two");
    const pending = await request(page, "match_model_capabilities", { model: "alpha-two" });
    if (field === "preset") await page.locator("#cfg-context-preset").selectOption("256K");
    if (field === "custom-context") {
      await page.locator("#cfg-context-preset").selectOption("__custom");
      await page.locator("#cfg-context-window").fill("333K");
    }
    if (field === "vision") await page.locator("#cfg-vision").selectOption("true");
    await capabilities(page, pending, { matched: true, contextWindow: 1_000_000, vision: false });
    if (field === "preset") await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
    if (field === "custom-context") await expect(page.locator("#cfg-context-window")).toHaveValue("333K");
    if (field === "vision") await expect(page.locator("#cfg-vision")).toHaveValue("true");
  });
}

test("identical model names from different providers do not share late capability matches", async ({ page }) => {
  await settleInitialList(page);
  await page.locator("#cfg-model").fill("same-name");
  const old = await request(page, "match_model_capabilities", { provider: "fixture-a", model: "same-name" });
  await chooseProvider(page, "fixture-b");
  await page.locator("#cfg-model").fill("same-name");
  const current = await request(page, "match_model_capabilities", { provider: "fixture-b", model: "same-name" });
  await capabilities(page, current, { matched: true, contextWindow: 256_000, vision: false });
  await capabilities(page, old, { matched: true, contextWindow: 1_000_000, vision: true });
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-vision")).toHaveValue("false");
});

test("closing and reopening rejects old responses even when provider and model are identical", async ({ page }) => {
  const oldList = await request(page, "list_models", { provider: "fixture-a" });
  await page.locator("#cfg-model").fill("alpha-one");
  const oldMatch = await request(page, "match_model_capabilities", { model: "alpha-one" });
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  const currentList = await request(page, "list_models", { provider: "fixture-a", after: oldList.requestId });
  await page.locator("#cfg-model").fill("alpha-one");
  const currentMatch = await request(page, "match_model_capabilities", { model: "alpha-one", after: oldMatch.requestId });
  await models(page, currentList, alphaModels);
  await capabilities(page, currentMatch, { matched: true, contextWindow: 256_000, vision: false });
  await models(page, oldList, betaModels);
  await capabilities(page, oldMatch, { matched: true, contextWindow: 1_000_000, vision: true });
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-vision")).toHaveValue("false");
  await expectModels(page, alphaModels);
});

test("late lists do not reopen a popup on the advanced tab, and the model draft survives returning", async ({ page }) => {
  const pending = await request(page, "list_models", { provider: "fixture-a" });
  await page.locator("#cfg-model").fill("typed-before-tab-change");
  await page.locator("#settings-tab-advanced").click();
  await models(page, pending, alphaModels);
  await expect(page.locator("#cfg-model-options")).toBeHidden();
  await page.locator("#settings-tab-model").click();
  await expect(page.locator("#cfg-model")).toHaveValue("typed-before-tab-change");
  await page.locator("#cfg-model").fill("Alpha");
  await expectModels(page, alphaModels);
});

test("provider cache is reused for unchanged credentials and isolated after a key change", async ({ page }) => {
  const first = await settleInitialList(page);
  await chooseProvider(page, "fixture-b");
  const second = await request(page, "list_models", { provider: "fixture-b", after: first.requestId });
  await models(page, second, betaModels);
  await chooseProvider(page, "fixture-a");
  await expectModels(page, alphaModels);
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "list_models" && message.provider === "fixture-a").length)).toBe(1);
  await page.locator("#cfg-apikey").fill("fixture-key-new");
  await page.locator("#cfg-apikey").press("Tab");
  const changed = await request(page, "list_models", { provider: "fixture-a", after: second.requestId });
  expect(changed.apiKey).toBe("fixture-key-new");
  const newModels = [{ id: "account-new", label: "New account model" }];
  await models(page, changed, newModels);
  await expectModels(page, newModels);
  await chooseProvider(page, "fixture-b");
  await expectModels(page, betaModels);
  await chooseProvider(page, "fixture-a");
  await expect(page.locator("#cfg-apikey")).toHaveValue("fixture-key-a");
  await expectModels(page, alphaModels);
});

test("editing credentials invalidates an old pending list before the new request debounce", async ({ page }) => {
  const old = await request(page, "list_models", { provider: "fixture-a" });
  await page.clock.install({ time: new Date("2026-09-20T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-20T12:00:01Z"));
  await page.locator("#cfg-model").fill("shared-alias");
  await page.locator("#cfg-context-preset").selectOption("256K");
  await page.locator("#cfg-apikey").fill("fixture-key-new");
  await models(page, old, [{ id: "old-private-model", label: "shared-alias" }]);
  // The old account must not resolve the typed alias or clear its explicit context length.
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("data-model-id");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
});

test("editing a custom endpoint never sends its saved key to the new model directory", async ({ page }) => {
  await settleInitialList(page);
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), {
    ...config, provider: "custom", apiKey: "saved-private-key", customProtocol: "openai",
    customEndpoint: "https://saved.invalid/v1/chat/completions",
  });
  await expect(page.locator("#cfg-apikey")).toHaveValue("saved-private-key");
  const saved = await request(page, "list_models", { provider: "custom" });
  expect(saved.apiKey).toBe("saved-private-key");
  await models(page, saved, alphaModels);

  await page.locator("#cfg-custom-endpoint").fill("https://new.invalid/v1/chat/completions");
  await expect(page.locator("#cfg-apikey")).toHaveValue("");
  const changed = await request(page, "list_models", { provider: "custom", after: saved.requestId });
  expect(changed.customEndpoint).toBe("https://new.invalid/v1/chat/completions");
  expect(changed.apiKey).toBe("");
  await models(page, changed, betaModels);
  await expectModels(page, betaModels);
});

test("search selection keeps canonical model identity through reopen, filtering and save", async ({ page }) => {
  await settleInitialList(page);
  const input = page.locator("#cfg-model");
  await input.fill("two");
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveText(["Alpha Two"]);
  await page.locator("#cfg-model-options").getByRole("option", { name: "Alpha Two", exact: true }).click();
  const match = await request(page, "match_model_capabilities", { model: "alpha-two" });
  await capabilities(page, match, { matched: true, contextWindow: 256_000, vision: true });
  await expect(input).toHaveValue("Alpha Two");
  await input.click();
  await expectModels(page, alphaModels);
  await input.press("Escape");
  await expect(page.locator("#settings-panel")).toBeVisible();
  await page.locator("#btn-save-settings").click();
  const saved = await request(page, "save_config");
  expect(saved.config).toMatchObject({ provider: "fixture-a", model: "alpha-two", contextWindow: "256K", vision: true });
});

test("committing an edited key makes one replacement request without a second debounced request", async ({ page }) => {
  const initial = await settleInitialList(page);
  await page.clock.install();
  await page.locator("#cfg-apikey").fill("fixture-key-new");
  await page.locator("#cfg-apikey").press("Tab");
  const pending = await request(page, "list_models", { provider: "fixture-a", after: initial.requestId });
  await page.clock.runFor(700);
  const replacements = await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "list_models" && message.apiKey === "fixture-key-new"));
  expect(replacements.map(message => message.requestId)).toEqual([pending.requestId]);
  await models(page, pending, betaModels);
  await expectModels(page, betaModels);
});

test("a current directory failure preserves manual input and a later credential retry recovers", async ({ page }) => {
  const first = await request(page, "list_models", { provider: "fixture-a" });
  await page.locator("#cfg-model").fill("manual-model");
  await page.locator("#cfg-context-preset").selectOption("256K");
  await models(page, first, [], true);
  await expect(page.locator("#cfg-model")).toHaveValue("manual-model");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title");
  await expect(page.getByText("stale directory failure", { exact: true })).toHaveCount(0);
  await page.locator("#cfg-apikey").fill("fixture-key-recovered");
  await page.locator("#cfg-apikey").press("Tab");
  const retry = await request(page, "list_models", { provider: "fixture-a", after: first.requestId });
  await models(page, retry, alphaModels);
  await expect(page.locator("#cfg-model")).toHaveValue("manual-model");
  await page.locator("#cfg-model").fill("Alpha");
  await expectModels(page, alphaModels);
});

for (const close of ["escape", "button"]) test(`closing settings by ${close} cancels any remaining credential debounce and its late directory response`, async ({ page }) => {
  const first = await settleInitialList(page);
  await page.clock.install({ time: new Date("2026-09-20T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-20T12:00:01Z"));
  await page.locator("#cfg-model").fill("manual-alias");
  await page.locator("#cfg-context-preset").selectOption("256K");
  await page.locator("#cfg-apikey").fill("fixture-key-closing");
  if (close === "escape") await page.locator("#cfg-apikey").press("Escape");
  else await page.locator("#btn-close-settings").click();
  await expect(page.locator("#settings-panel")).toBeHidden();
  const closedRequests = await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "list_models"));
  await page.clock.runFor(700);
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "list_models"))).toEqual(closedRequests);
  for (const pending of closedRequests.filter(message => message.requestId !== first.requestId)) {
    await models(page, pending, [{ id: "late-model", label: "manual-alias" }]);
  }
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("data-model-id");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-model-options")).toBeHidden();
});

test("changing credentials removes previously loaded choices while waiting and after an empty account list", async ({ page }) => {
  const first = await settleInitialList(page);
  await page.locator("#cfg-apikey").fill("fixture-key-empty-account");
  await page.locator("#cfg-apikey").press("Tab");
  const pending = await request(page, "list_models", { provider: "fixture-a", after: first.requestId });
  await page.locator("#cfg-model-toggle").click();
  await expect(page.locator("#cfg-model-options").getByRole("option", { disabled: false })).toHaveCount(0);
  await models(page, pending, []);
  await expect(page.locator("#cfg-model-options").getByRole("option", { disabled: false })).toHaveCount(0);
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取/);
  await page.locator("#cfg-model").fill("new-manual-model");
  await expect(page.locator("#cfg-model")).toHaveValue("new-manual-model");
  await expect(page.locator("#cfg-model-options").getByRole("option", { disabled: false })).toHaveCount(0);
});

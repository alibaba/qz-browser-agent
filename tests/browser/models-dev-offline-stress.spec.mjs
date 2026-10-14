import { chromium } from "playwright";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { providers as snapshot } from "@opencode-ai/models/snapshot";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";

/** Read accepted Background facts through the same public protocol as the panel. */
async function request(page, type, fields = {}) {
  return page.evaluate(({ type, fields }) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { port.disconnect(); reject(new Error(`Timed out: ${type}`)); }, 15_000);
    port.onMessage.addListener(response => {
      if (response.requestId !== requestId) return;
      clearTimeout(timeout);
      port.disconnect();
      if (response.error) reject(new Error(response.error));
      else resolve(response);
    });
    port.postMessage({ type, requestId, ...fields });
  }), { type, fields });
}

async function withOfflinePanel(testInfo, scenario, run) {
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-models-offline-stress-"));
  const output = resolve("tests/results/models-dev-offline-stress", scenario);
  const evidence = { pageErrors: [], requests: [], failedRequests: [], selections: [] };
  let context;
  let page;
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    context = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(),
      viewport: { width: 360, height: 800 }, locale: "en-US", reducedMotion: "reduce",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    context.on("request", item => {
      if (/^https?:/u.test(item.url())) evidence.requests.push({ method: item.method(), url: item.url() });
    });
    context.on("requestfailed", item => {
      if (/^https?:/u.test(item.url())) evidence.failedRequests.push({ url: item.url(), error: item.failure()?.errorText });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    evidence.networkProbe = await worker.evaluate(async () => {
      try {
        await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) });
        return { reachable: true };
      } catch (error) { return { reachable: false, error: String(error) }; }
    });
    expect(evidence.networkProbe.reachable).toBe(false);
    page = await context.newPage();
    page.on("pageerror", error => evidence.pageErrors.push(String(error.stack || error)));
    await page.goto(new URL("/sidepanel/sidepanel.html", worker.url()).href);
    await acceptDataDisclosure(page);
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
    await page.locator("#btn-settings").click();
    await run({ page, evidence });
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.requests.filter(item => item.method === "POST" && /\/(chat\/completions|messages|responses)(?:\?|$)/u.test(item.url)), "configuration never invokes a model").toEqual([]);
  } finally {
    await mkdir(output, { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: join(output, "last-panel-state.png"), animations: "disabled" }).catch(() => {});
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    await testInfo.attach("offline-provider-stress.json", { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json" });
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function selectProvider(page, id, { keyboard = false } = {}) {
  const trigger = page.locator("#cfg-provider-trigger");
  if (keyboard) await trigger.press("ArrowDown");
  else await trigger.click();
  const search = page.locator("#cfg-provider-search");
  await expect(search).toHaveValue("");
  await search.fill(`  ${id.toUpperCase()}  `);
  const choice = page.locator(`#cfg-provider-list [data-provider-id="${id}"]`);
  await expect(choice).toBeVisible();
  if (keyboard) {
    await expect(page.locator("#cfg-provider-list [role=option]:visible")).toHaveCount(1);
    await search.press("Enter");
  } else await choice.click();
  await expect(page.locator("#cfg-provider")).toHaveValue(id);
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
}

async function selectModel(page, providerId, modelId, evidence, { sdkId = providerId } = {}) {
  const model = snapshot[sdkId].models[modelId];
  expect(model).toBeTruthy();
  const input = page.locator("#cfg-model");
  await input.fill(model.id);
  // Exact IDs may intentionally suppress the automatic list; an explicit open still offers it.
  await input.press("ArrowDown");
  const name = page.locator("#cfg-model-options .model-suggestion-name").getByText(model.name, { exact: true });
  await expect(name).toBeVisible();
  await name.click();
  await expect(input).toHaveAttribute("data-model-id", model.id);
  await expect(page.locator("#cfg-vision")).toHaveValue(String(model.modalities.input.includes("image")));
  await expect.poll(async () => {
    const value = (await page.locator("#cfg-context-window").inputValue()).toUpperCase();
    return parseFloat(value) * (value.endsWith("M") ? 1_000_000 : value.endsWith("K") ? 1000 : 1);
  }).toBe(model.limit.context);
  evidence.selections.push({ provider: providerId, model: modelId, context: model.limit.context, vision: model.modalities.input.includes("image") });
}

test("offline MV3 repeatedly switches SDK and policy providers without leaking selection or search state", async ({}, testInfo) => {
  test.setTimeout(120_000);
  await withOfflinePanel(testInfo, "switching", async ({ page, evidence }) => {
    await test.step("empty results, Enter, Escape and clearing search preserve the form", async () => {
      const previous = await page.locator("#cfg-provider").inputValue();
      await page.locator("#cfg-provider-trigger").click();
      const choices = page.locator("#cfg-provider-list [role=option]:visible");
      await expect.poll(() => choices.count()).toBeGreaterThan(100);
      const count = await choices.count();
      const search = page.locator("#cfg-provider-search");
      await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
      const box = await search.boundingBox();
      await search.fill("no-provider-can-have-this-unique-id");
      await expect(choices).toHaveCount(0);
      await expect(page.locator("#cfg-provider-empty")).toBeVisible();
      await search.press("Enter");
      await expect(page.locator("#cfg-provider")).toHaveValue(previous);
      await expect(page.locator("#cfg-provider-picker")).toBeVisible();
      await search.fill("");
      await expect(choices).toHaveCount(count);
      expect(await search.boundingBox(), "filtering keeps the search field stationary").toEqual(box);
      await search.press("Escape");
      await expect(page.locator("#cfg-provider-picker")).toBeHidden();
      await expect(page.locator("#settings-panel")).toBeVisible();
      evidence.providerCount = count;
    });

    const cases = [
      { provider: "openrouter", model: "openai/gpt-4.1" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "opencodego", sdkId: "opencode-go", model: "deepseek-v4-flash" },
      { provider: "kimicode", sdkId: "kimi-code-plan-cn", model: "kimi-for-coding" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "moonshotai", sdkId: "moonshotai-cn", model: "kimi-k2.6" },
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "openrouter", model: "openai/gpt-4.1" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ];
    for (const [index, item] of cases.entries()) await test.step(`${index + 1}: ${item.provider}/${item.model}`, async () => {
      await selectProvider(page, item.provider, { keyboard: index % 2 === 0 });
      await selectModel(page, item.provider, item.model, evidence, item);
      // The selected input remains focused; one arrow click must still reopen it.
      await page.locator("#cfg-model-toggle").click();
      await expect(page.locator("#cfg-model-options")).toBeVisible();
      await expect.poll(() => page.locator("#cfg-model-options .model-suggestion-item").count()).toBeGreaterThan(1);
      await page.locator("#cfg-model").press("Escape");
      await expect(page.locator("#cfg-model-options")).toBeHidden();
      await expect(page.locator("#settings-panel")).toBeVisible();
    });
    expect(evidence.requests.filter(item => item.url === "https://models.dev/api.json"), "all known model defaults remain offline; only the explicit probe uses the network").toHaveLength(1);
  });
});

test("offline MV3 preserves manual overrides and recovers from an unknown model after failed metadata refresh", async ({}, testInfo) => {
  test.setTimeout(90_000);
  await withOfflinePanel(testInfo, "unknown", async ({ page, evidence }) => {
    await selectProvider(page, "openrouter", { keyboard: true });
    await page.locator("#cfg-apikey").fill("offline-stress-fixture-key");
    await selectModel(page, "openrouter", "openai/gpt-4.1", evidence);
    await page.locator("#cfg-context-window").fill("64K");
    await page.locator("#cfg-vision").selectOption("false");
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("#settings-panel")).toBeHidden();
    const expected = { provider: "openrouter", model: "openai/gpt-4.1", contextWindow: 64000, vision: false };
    expect((await request(page, "get_config")).config).toMatchObject(expected);
    await page.reload();
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await page.locator("#btn-settings").click();
    await expect(page.locator("#cfg-context-window")).toHaveValue("64K");
    await expect(page.locator("#cfg-vision")).toHaveValue("false");
    await expect(page.locator("#cfg-apikey")).toHaveValue("offline-stress-fixture-key");
    expect((await request(page, "get_config")).config).toMatchObject(expected);
    evidence.restoredOverride = expected;

    const unknown = "offline-unknown-model-unique-fixture";
    await page.locator("#cfg-model").fill(unknown);
    await expect(page.locator("#cfg-context-window")).toHaveValue("");
    await expect(page.locator("#cfg-vision")).toHaveValue("false");
    await expect(page.locator("#btn-save-settings")).toBeDisabled();
    const { match } = await request(page, "match_model_capabilities", { provider: "openrouter", model: unknown });
    expect(match.matched).toBe(false);
    await expect.poll(() => evidence.failedRequests.filter(item => item.url === "https://models.dev/api.json").length).toBeGreaterThan(1);
    await expect(page.locator("#cfg-model")).toHaveValue(unknown);
    await page.locator("#cfg-context-preset").selectOption("256K");
    await expect(page.locator("#btn-save-settings")).toBeEnabled();
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("#settings-panel")).toBeHidden();
    const fallback = { provider: "openrouter", model: unknown, contextWindow: 256000, vision: false };
    expect((await request(page, "get_config")).config).toMatchObject(fallback);
    evidence.savedUnknown = fallback;

    await page.locator("#btn-settings").click();
    await expect(page.locator("#cfg-model")).toHaveValue(unknown);
    await expect(page.locator("#cfg-context-window")).toHaveValue("256K");
    await selectModel(page, "openrouter", "openai/gpt-4.1", evidence);
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("#settings-panel")).toBeHidden();
    expect((await request(page, "get_config")).config).toMatchObject({
      provider: "openrouter", model: "openai/gpt-4.1",
      contextWindow: snapshot.openrouter.models["openai/gpt-4.1"].limit.context, vision: true,
    });
  });
});

test("offline Codex fallback offers Astra first and fills its account-specific image profile", async ({}, testInfo) => {
  test.setTimeout(90_000);
  await withOfflinePanel(testInfo, "codex", async ({ page, evidence }) => {
    await selectProvider(page, "openaicodex", { keyboard: true });
    const reasoning = page.locator("#cfg-provider-option-codexReasoningEffort");
    await expect(reasoning.locator("option")).toHaveText(["Low", "Medium", "High", "Extra High", "Max"]);
    await expect(reasoning).toHaveValue("medium");
    const input = page.locator("#cfg-model");
    await expect(input).not.toHaveAttribute("title", /Loading/i);
    await page.locator("#cfg-model-toggle").click();
    const choices = page.locator("#cfg-model-options .model-suggestion-item");
    await expect(choices.first()).toContainText("gpt-6-astra");
    await choices.first().click();
    await expect(input).toHaveAttribute("data-model-id", "gpt-6-astra");
    await expect(page.locator("#cfg-context-window")).toHaveValue("272K");
    await expect(page.locator("#cfg-vision")).toHaveValue("true");
    const { match } = await request(page, "match_model_capabilities", { provider: "openaicodex", model: "gpt-6-astra" });
    expect(match).toMatchObject({ matched: true, contextWindow: 272000, maxOutputTokens: 128000, vision: true });
    evidence.capabilityMatch = match;
    await input.click();
    await expect(choices.first()).toContainText("gpt-6-astra");
    expect(evidence.requests.filter(item => item.url === "https://models.dev/api.json")).toHaveLength(1);
  });
});

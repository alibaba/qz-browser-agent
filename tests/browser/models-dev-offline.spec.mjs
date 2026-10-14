import { chromium } from "playwright";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { providers as snapshot } from "@opencode-ai/models/snapshot";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";

/** Speak the public panel protocol to the unchanged production Service Worker. */
async function request(page, type, fields = {}) {
  return page.evaluate(({ type, fields }) => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    const requestId = crypto.randomUUID();
    const finish = (error, response) => {
      clearTimeout(timeout);
      port.onMessage.removeListener(receive);
      port.onDisconnect.removeListener(disconnected);
      port.disconnect();
      if (error) reject(error);
      else resolve(response);
    };
    const receive = response => {
      if (response.requestId !== requestId) return;
      finish(response.error ? new Error(response.error) : null, response);
    };
    const disconnected = () => finish(new Error(chrome.runtime.lastError?.message || "Background disconnected"));
    const timeout = setTimeout(() => finish(new Error(`Background request timed out: ${type}`)), 15_000);
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(disconnected);
    port.postMessage({ type, requestId, ...fields });
  }), { type, fields });
}

test("a real offline MV3 panel discovers, configures and restores models.dev providers", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-models-offline-"));
  const output = resolve("tests/results/models-dev-offline");
  const evidence = { pageErrors: [], requests: [], failedRequests: [] };
  const selectedModel = snapshot.openrouter.models["openai/gpt-4.1"];
  expect(selectedModel).toBeTruthy();
  expect(selectedModel.modalities.input).toContain("image");
  let context;
  let page;
  try {
    const extension = join(directory, "extension");
    // Chrome may create extension metadata; keep both the user's build and shared test build untouched.
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const workerPath = join(extension, "background/service-worker.js");
    await writeFile(workerPath, `
      globalThis.__modelAssetReads = 0;
      const modelGate = new Promise(resolve => { globalThis.__releaseModelAsset = resolve; });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, options) => {
        if (String(input).endsWith('/vendor/models-dev/providers.json')) {
          globalThis.__modelAssetReads++;
          await modelGate;
        }
        return originalFetch(input, options);
      };
    ` + await readFile(workerPath, "utf8"));
    const launchOptions = {
      headless: true, executablePath: chromium.executablePath(),
      viewport: { width: 360, height: 800 }, locale: "en-US",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND",
      ],
    };
    context = await chromium.launchPersistentContext(join(directory, "profile"), launchOptions);
    context.on("request", item => {
      if (/^https?:/u.test(item.url())) evidence.requests.push({ method: item.method(), url: item.url() });
    });
    context.on("requestfailed", item => {
      if (/^https?:/u.test(item.url())) evidence.failedRequests.push({ url: item.url(), error: item.failure()?.errorText });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const panelUrl = new URL("/sidepanel/sidepanel.html", worker.url()).href;
    evidence.networkProbe = await worker.evaluate(async () => {
      try {
        const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) });
        return { reachable: true, status: response.status };
      } catch (error) { return { reachable: false, error: String(error) }; }
    });
    expect(evidence.networkProbe.reachable).toBe(false);

    page = await context.newPage();
    page.on("pageerror", error => evidence.pageErrors.push(String(error.stack || error)));
    await page.goto(panelUrl);
    await acceptDataDisclosure(page);
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
    await request(page, "get_config");
    expect(await worker.evaluate(() => globalThis.__modelAssetReads)).toBe(0);
    await page.locator("#btn-settings").click();
    await page.locator("#cfg-provider-trigger").click();
    const choices = page.locator("#cfg-provider-list [role=option]:visible");
    await expect.poll(() => choices.count()).toBeGreaterThan(100);
    evidence.providerCount = await choices.count();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "offline-provider-directory.png"), animations: "disabled" });

    await page.locator("#cfg-provider-search").fill("openrouter");
    await expect(choices).toHaveCount(1);
    await expect(choices).toHaveAttribute("data-provider-id", "openrouter");
    await choices.click();
    await expect(page.locator("#cfg-provider")).toHaveValue("openrouter");
    await page.locator("#cfg-apikey").fill("offline-integration-fixture-key");
    await expect.poll(() => worker.evaluate(() => globalThis.__modelAssetReads)).toBe(1);
    await page.locator("#cfg-model").click();
    await expect(page.locator("#cfg-model-options")).toContainText("Loading");
    await worker.evaluate(() => globalThis.__releaseModelAsset());
    await page.locator("#cfg-model").fill(selectedModel.id);
    const selectedOption = page.locator("#cfg-model-options .model-suggestion-name").getByText(selectedModel.name, { exact: true });
    await expect(selectedOption).toBeVisible();
    await selectedOption.click();
    await expect(page.locator("#cfg-model")).toHaveAttribute("data-model-id", selectedModel.id);
    await expect(page.locator("#cfg-context-window")).not.toHaveValue("");
    await expect(page.locator("#cfg-vision")).toHaveValue("true");

    const result = await request(page, "match_model_capabilities", { provider: "openrouter", model: selectedModel.id });
    expect(result.match).toMatchObject({
      matched: true, providerId: "openrouter", matchedId: selectedModel.id,
      contextWindow: selectedModel.limit.context, maxOutputTokens: selectedModel.limit.output,
      vision: true, source: "models.dev",
    });
    evidence.capabilityMatch = result.match;
    await page.locator("#btn-save-settings").click();
    await expect(page.locator("#settings-panel")).toBeHidden();
    const { config } = await request(page, "get_config");
    expect(config).toMatchObject({ provider: "openrouter", model: selectedModel.id, contextWindow: selectedModel.limit.context, vision: true });
    expect(config.apiKey).toBe("offline-integration-fixture-key");

    await page.reload();
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    await page.locator("#btn-settings").click();
    await expect(page.locator("#cfg-provider-trigger")).toHaveText("OpenRouter");
    await expect(page.locator("#cfg-model")).toHaveAttribute("data-model-id", selectedModel.id);
    await expect(page.locator("#cfg-apikey")).toHaveValue("offline-integration-fixture-key");
    await expect(page.locator("#cfg-vision")).toHaveValue("true");
    const restored = await request(page, "get_config");
    expect(restored.config).toMatchObject({ provider: "openrouter", model: selectedModel.id, contextWindow: selectedModel.limit.context, vision: true });
    expect(await worker.evaluate(() => globalThis.__modelAssetReads)).toBe(1);
    evidence.restoredConfig = { provider: restored.config.provider, model: restored.config.model, contextWindow: restored.config.contextWindow, vision: restored.config.vision };
    await page.screenshot({ path: join(output, "offline-restored-settings.png"), animations: "disabled" });
    await context.close();
    context = await chromium.launchPersistentContext(join(directory, "profile"), launchOptions);
    const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    page = await context.newPage();
    page.on("pageerror", error => evidence.pageErrors.push(String(error.stack || error)));
    await page.goto(panelUrl);
    await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
    expect((await request(page, "get_config")).config).toMatchObject(evidence.restoredConfig);
    expect(await restartedWorker.evaluate(() => globalThis.__modelAssetReads)).toBe(0);
    await restartedWorker.evaluate(() => globalThis.__releaseModelAsset());
    const restartedMatch = await request(page, "match_model_capabilities", { provider: "openrouter", model: selectedModel.id });
    expect(restartedMatch.match).toMatchObject({ contextWindow: selectedModel.limit.context, maxOutputTokens: selectedModel.limit.output, vision: true });
    expect(await restartedWorker.evaluate(() => globalThis.__modelAssetReads)).toBe(1);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.failedRequests.some(item => item.url === "https://models.dev/api.json"), "Chrome actually failed the models.dev request").toBe(true);
    expect(evidence.requests.filter(item => item.url === "https://models.dev/api.json"), "only the deliberate offline probe may request models.dev; known model selection must stay local").toHaveLength(1);
    expect(evidence.requests.filter(item => item.method === "POST" && /\/(chat\/completions|messages|responses)(?:\?|$)/u.test(item.url)), "the test configures models without invoking inference").toEqual([]);
  } finally {
    await mkdir(output, { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: join(output, "last-panel-state.png"), animations: "disabled" }).catch(() => {});
    await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    await testInfo.attach("offline-model-directory.json", { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json" });
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

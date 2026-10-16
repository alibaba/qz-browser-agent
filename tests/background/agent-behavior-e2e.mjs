import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentArgs } from "./agent-behavior-cli.mjs";
import {
  PROJECT_ROOT,
  assertNoUnexpectedDiagnostics,
  launchIsolatedExtensionMcp,
  runBridgePython,
  saveExtensionLlmConfig,
} from "../support/isolated-extension-mcp.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";

const options = parseAgentArgs(process.argv.slice(2));
const provider = options.provider || String(process.env.QINGZHOU_LLM_PROVIDER || "deepseek").trim();
const akFile = options.akFile
  || String(process.env.QINGZHOU_LLM_AK_FILE || "").trim()
  || (provider === "deepseek" ? String(process.env.QINGZHOU_DEEPSEEK_AK_FILE || "").trim() : "");
const apiKey = readTestApiKey(provider, { keyFile: akFile });

const model = options.model
  || String(process.env.QINGZHOU_LLM_MODEL || "").trim()
  || String(process.env.QINGZHOU_DEEPSEEK_MODEL || "").trim()
  || (provider === "deepseek" ? "deepseek-v4-flash" : "");
if (!model) throw new Error("isolated Agent E2E requires --model or QINGZHOU_LLM_MODEL for non-DeepSeek providers");
const reportDir = join(PROJECT_ROOT, "tests", "results", "agent");
mkdirSync(reportDir, { recursive: true });
const report = options.report || join(reportDir, `behavior-${options.suite}.json`);
mkdirSync(dirname(report), { recursive: true });
let environment = null;

try {
  environment = await launchIsolatedExtensionMcp({
    profilePrefix: `qingzhou-agent-${provider.replace(/[^a-z0-9_-]+/gi, "-")}-${options.suite}-e2e-`,
    headless: process.env.QINGZHOU_AGENT_E2E_HEADLESS !== "0",
    requestTimeoutSeconds: 600,
  });
  const saved = await saveExtensionLlmConfig(environment.page, {
    provider,
    apiKey,
    model,
    vision: options.vision,
    contextWindow: 128000,
    trimOldToolResults: true,
    debugMode: false,
  });
  if (saved.provider !== provider || saved.model !== model) {
    throw new Error(`unexpected isolated model config: ${JSON.stringify({ provider: saved.provider, model: saved.model })}`);
  }
  if (options.language) {
    await selectInterfaceLanguage(environment.page, options.language);
    await environment.page.screenshot({ path: join(dirname(report), `language-${options.language}.png`) });
  }
  await installNewTabWindowProbe(environment.page, {
    useAlternateWindow: options.windowTargetProbe,
  });

  const pythonArgs = [
    "--bridge-url", environment.bridge.mcpUrl,
    "--suite", options.suite,
    "--concurrency", String(options.concurrency),
    "--repetitions", String(options.repetitions),
    "--bridge-timeout", String(options.bridgeTimeout),
    "--report", report,
  ];
  if (options.cases) pythonArgs.push("--cases", options.cases);
  if (options.language) pythonArgs.push("--language", options.language);
  if (options.captureDir) pythonArgs.push("--capture-dir", resolve(options.captureDir));
  let regressionError = null;
  try {
    await runBridgePython(fileURLToPath(new URL("./agent-behavior-regression.py", import.meta.url)), pythonArgs, { env: {
      ...(options.captureDir ? { QINGZHOU_CAPTURE_API_KEY: apiKey } : {}),
    } });
  } catch (error) {
    regressionError = error;
  }
  const windowTarget = await readNewTabWindowProbe(environment.page);
  if (options.windowTargetProbe && !windowTarget.createdTabs.length) {
    throw new Error(`window target probe observed no newly created tabs: ${JSON.stringify(windowTarget)}`);
  }
  const misplacedTabs = windowTarget.createdTabs.filter(tab => tab.windowId !== windowTarget.expectedWindowId);
  if (misplacedTabs.length) {
    throw new Error(`new tabs escaped the isolated normal window: ${JSON.stringify({
      expectedWindowId: windowTarget.expectedWindowId,
      misplacedTabs,
    })}`);
  }
  if (regressionError) {
    console.error(JSON.stringify({ ok: false, provider, model, windowTarget }));
    throw regressionError;
  }
  assertNoUnexpectedDiagnostics(environment.diagnostics, [apiKey]);
  console.log(JSON.stringify({
    ok: true,
    suite: options.suite,
    provider,
    model,
    language: options.language || "zh-CN",
    isolatedProfile: true,
    isolatedBridge: environment.bridge.endpoint,
    windowTarget,
    report,
  }));
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  try {
    assertNoUnexpectedDiagnostics(environment?.diagnostics || [], [apiKey]);
  } catch (diagnosticError) {
    failure.message = `${failure.message}\n${diagnosticError.message}`;
  }
  throw failure;
} finally {
  await environment?.close().catch(() => undefined);
}

async function selectInterfaceLanguage(page, language) {
  await page.waitForFunction(() => !document.querySelector("#app")?.hasAttribute("data-workspace-booting"));
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="advanced"]').click();
  const select = page.locator("#i18n-language-select");
  if (await select.inputValue() !== language) {
    await select.selectOption(language);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.locator("#btn-save-settings").click(),
    ]);
  }
  await page.waitForFunction(language => document.documentElement.lang === language
    && !document.querySelector("#app")?.hasAttribute("data-workspace-booting"), language);
  await page.waitForFunction(async language => {
    const response = await chrome.runtime.sendMessage({ type: "get_content_language" });
    return response.ok && response.result.locale === language;
  }, language);
  if (await page.locator("#app").getAttribute("data-workspace-boot-fallback") !== null) {
    throw new Error("Language change fell back to an incomplete workspace");
  }
}

async function installNewTabWindowProbe(page, { useAlternateWindow = false } = {}) {
  await page.evaluate(async useAlternate => {
    const originWindow = await chrome.windows.getCurrent();
    const targetWindow = useAlternate
      ? await chrome.windows.create({ url: "about:blank", focused: true, type: "normal" })
      : originWindow;
    if (useAlternate) await chrome.windows.update(targetWindow.id, { focused: true });
    const createdTabs = [];
    chrome.tabs.onCreated.addListener(tab => {
      createdTabs.push({
        id: Number(tab?.id) || null,
        windowId: Number(tab?.windowId),
      });
    });
    globalThis.__qingzhouNewTabWindowProbe = {
      originWindowId: Number(originWindow?.id),
      expectedWindowId: Number(targetWindow?.id),
      expectedWindowType: String(targetWindow?.type || ""),
      createdTabs,
    };
  }, useAlternateWindow);
}

async function readNewTabWindowProbe(page) {
  const result = await page.evaluate(() => {
    const probe = globalThis.__qingzhouNewTabWindowProbe || {};
    return {
      originWindowId: probe.originWindowId,
      expectedWindowId: probe.expectedWindowId,
      expectedWindowType: probe.expectedWindowType,
      createdTabs: Array.isArray(probe.createdTabs) ? [...probe.createdTabs] : [],
    };
  });
  if (!Number.isInteger(result.expectedWindowId) || result.expectedWindowId < 0 || result.expectedWindowType !== "normal") {
    throw new Error(`isolated Agent E2E did not start in a normal Chrome window: ${JSON.stringify(result)}`);
  }
  return result;
}

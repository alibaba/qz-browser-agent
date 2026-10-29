import { acceptDataDisclosure } from "../support/data-consent.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentBytes } from "../../src/shared/documents/document-codecs.js";
import { AUTOMATION_SCHEDULER_ALARM } from "../../src/background/automation/runtime.js";
import { readCheckpointRecord, readSessionSnapshot } from "../../src/shared/session/session-recovery.js";
import {
  createZip,
  skillFromSkillMarkdown,
  skillToSkillMarkdown,
} from "../../src/shared/skills/skill-package.js";
import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";
import { getMcpSkillToolName } from "../../src/capabilities/mcp/skill-contract.js";
import { ensureTestExtension } from "../support/extension-build.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex < 0 ? "" : process.argv[scenarioIndex + 1];
const workerRestartOnly = scenarioIndex >= 0;
if (workerRestartOnly && !["worker_restart", "worker_restart_images", "worker_restart_errors", "worker_restart_checkpoint", "worker_restart_compact", "reset_reopen", "uid_batch"].includes(scenario)) {
  throw new Error("Supported scenarios: worker_restart, worker_restart_images, worker_restart_errors, worker_restart_checkpoint, worker_restart_compact, reset_reopen, uid_batch");
}
const extensionPath = await ensureTestExtension({
  extensionDir: process.env.QINGZHOU_EXTENSION_PATH || process.env.QINGZHOU_TEST_EXTENSION_DIR,
});
const { chromium } = await import("playwright");
const executablePath = findChromeExecutable(chromium.executablePath());
if (!executablePath) throw new Error("Chrome executable not found");

const provider = await createProviderServer();
const gitRepository = await createGitRepositoryServer();
const profile = mkdtempSync(join(tmpdir(), "qingzhou-background-e2e-"));
let context;
let page;
const pageErrors = [];

try {
  context = await chromium.launchPersistentContext(profile, {
    locale: "zh-CN",
    headless: true,
    executablePath,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 980, height: 860 },
    args: [
      "--lang=zh-CN",
      // Keep headless compositor input progressing on the task's background tab.
      "--disable-frame-rate-limit",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  context.on("page", current => current.on("pageerror", error => pageErrors.push(String(error))));
  const extensionId = await getExtensionId(context, profile);
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ type: "run_script_tool_call" }))).code, "DATA_CONSENT_REQUIRED");
  await acceptDataDisclosure(page);
  await waitForWorkspaceReady(page);
  await installHarness(page);
  await saveConfig(page, provider.endpoint);
  if (!workerRestartOnly) {
    await runProfileInitializationFailureIsVisible(page, context);
    await locationOnlyWhenRequested(page);
    await mcpOutputSchemaSurvivesExtensionCsp(page, provider);
    page = await automationAlarmRunsWithoutSidepanel(page, context, extensionId, provider);
    await runningAutomationCanBeDeleted(page, provider);

    const attachmentFixtureBase64 = process.env.QINGZHOU_ATTACHMENT_E2E_BASE64
      || Buffer.from(await createDocumentBytes({
        format: "xlsx",
        title: "Attachment E2E",
        sheets: [{
          name: "Data",
          columns: ["id", "value"],
          rows: [{ id: "1", value: "真实后台解析" }],
        }],
      })).toString("base64");
    await saveConfig(page, provider.endpoint, { vision: true });
    await screenActionFeedbackRoundTrip(page, context, provider);
    page = await composerDraftSurvivesActualSidepanelCloseAndResize(page, context, extensionId);
    await composerAttachmentsSurviveSessionSwitchAndSend(page, attachmentFixtureBase64, provider);
    await saveConfig(page, provider.endpoint);
    await gitSkillSourceAuthenticatedArchive(page, gitRepository);
    await skillResultSelectionRoundTrip(page, provider);
    await uiComposerRoundTrip(page);
    await manualCompactRendersLifecycleCard(page);
    await queuedComposerBubbleUsesOutgoingMotion(page);
    await basicAndRetryScenarios(page, provider);
    await steeringReentersTheActiveRun(page, provider);
    await steeringQueueLifecycleMatrix(page, provider);
    await providerFailureReleasesTheSession(page);
    await providerFaultLifecycleMatrix(page, provider);
    await manageExistingSession(page, provider);
    await stopCutsOffLateStreaming(page, provider);
    await concurrentSessionsStayIsolated(page);
    await sidepanelReloadKeepsTheBackgroundRun(page);
  }
  if (!workerRestartOnly || scenario === "uid_batch") await uidBatchCollectAcrossTabsHonorsDocumentIdentity(page, context, provider);
  if (!workerRestartOnly || scenario === "worker_restart") page = await serviceWorkerRestartSettlesInterruptedTurn(page, context, extensionId, provider);
  if (scenario === "worker_restart_checkpoint") page = await serviceWorkerRestartKeepsCompletedCheckpoints(page, context, extensionId, provider);
  if (!workerRestartOnly || ["worker_restart", "worker_restart_images"].includes(scenario)) await serviceWorkerRestartKeepsImagesAndThinking(page, context, extensionId, provider);
  if (!workerRestartOnly || ["worker_restart", "worker_restart_errors"].includes(scenario)) await serviceWorkerRestartKeepsProviderFailure(page, context, extensionId);
  if (!workerRestartOnly || ["worker_restart", "worker_restart_compact"].includes(scenario)) await serviceWorkerRestartCancelsCompaction(page, context, extensionId, provider);
  if (!workerRestartOnly || scenario === "reset_reopen") await resetSurvivesSessionReopen(page, provider);

  console.log(JSON.stringify({
    ok: true,
    scenarios: workerRestartOnly ? [scenario] : ["run_profile_initialization_error_recovery", "data_consent_location", "mcp_output_schema_csp", "automation_alarm_without_sidepanel", "running_automation_delete", "screen_action_feedback", "composer_draft_actual_close_and_resize", "composer_attachment_session_switch", "git_skill_authenticated_archive", "skill_selection_reload_submit_cancel", "ui_composer", "manual_compact_card", "queued_composer_motion", "basic", "retry", "steering", "steering_matrix", "provider_error_recovery", "stream_stop_queue_resume", "concurrent", "sidepanel_reload", "uid_batch_collect_redirect", "worker_restart", "reset_reopen"],
    providerRequests: provider.requests.length,
    providerFaultCases: workerRestartOnly ? 0 : 16,
  }));
} catch (error) {
  const events = await page?.evaluate(() => window.__qzBackgroundE2E?.events?.() || []).catch(() => []);
  const sidepanelState = await page?.evaluate(() => ({
    booting: document.querySelector("#app")?.hasAttribute("data-workspace-booting"),
    fallback: document.querySelector("#app")?.getAttribute("data-workspace-boot-fallback") || "",
    fallbackText: document.querySelector("#workspace-boot-fallback")?.textContent || "",
    activeTab: document.querySelector(".tab-btn.active")?.getAttribute("data-tab") || "",
    composer: {
      text: document.querySelector("#input")?.value || "",
      attachments: [...document.querySelectorAll(".input-image-attachment, .input-document-attachment")].map(node => ({
        className: node.className,
        text: node.textContent,
        title: node.getAttribute("title"),
        image: node.querySelector("img")?.getAttribute("alt"),
      })),
      disabled: document.querySelector("#btn-send")?.disabled,
      toast: document.querySelector(".case-toast")?.textContent,
    },
  })).catch(() => null);
  console.error(JSON.stringify({
    stage: "background-extension-e2e-failure",
    providerRequests: provider.requests,
    recentEvents: events.slice(-30),
    pageErrors,
    sidepanelState,
  }, null, 2));
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await gitRepository.close();
  await provider.close();
  rmSync(profile, { recursive: true, force: true });
}

async function runProfileInitializationFailureIsVisible(page, browserContext) {
  const sessionId = await createSession(page, "Run profile initialization failure");
  const worker = browserContext.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  assert.ok(worker);
  const failure = "QZ run profile initialization failed: platform information unavailable";
  try {
    assert.match(await runPrompt(page, sessionId, "QZ_E2E_BASIC"), /QZ_E2E_BASIC_OK/);
    await switchUiToSession(page, sessionId);
    await page.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("QZ_E2E_BASIC_OK"));
    // Fail one native dependency of _buildRunProfile, before Agent can emit agent_start.
    await worker.evaluate(message => {
      const original = chrome.runtime.getPlatformInfo;
      let entered;
      globalThis.__qzRunProfileFault = {
        entered: new Promise(resolve => { entered = resolve; }),
        restore: () => { chrome.runtime.getPlatformInfo = original; },
      };
      chrome.runtime.getPlatformInfo = () => {
        chrome.runtime.getPlatformInfo = original;
        return new Promise((_resolve, reject) => {
          globalThis.__qzRunProfileFault.reject = () => reject(new Error(message));
          entered();
        });
      };
    }, failure);
    const after = await eventCount(page);
    await submitComposerMessage(page, "Follow up after the completed answer");
    const pending = await waitEvent(page, { type: "session_pending", sessionId }, after);
    await worker.evaluate(() => globalThis.__qzRunProfileFault.entered);
    await worker.evaluate(() => globalThis.__qzRunProfileFault.reject());
    const failed = await waitEvent(page, { type: "error", sessionId, runId: pending.runId }, after);
    await waitEvent(page, { type: "agent_end", sessionId, runId: pending.runId }, after);
    assert.equal(failed.message, failure);
    assert.equal(await matchingEventCount(page, { type: "agent_start", sessionId, runId: pending.runId }, after), 0);
    const state = await request(page, "get_state", { sessionId }, "state");
    assert.equal(state.status, "error");
    assert.equal(state.runtime?.reason, failure);
    await page.waitForFunction(message => [...document.querySelectorAll(".chat-error-card")]
      .some(card => card.textContent.includes(message)), failure, { timeout: 10_000 });
    assert.match(await page.locator("#messages").innerText(), /QZ_E2E_BASIC_OK/);
    assert.equal(await page.locator("#status-bar").isVisible(), false);
    assert.equal(await page.locator("#input").isEditable(), true);
    const recoveryAfter = await eventCount(page);
    await submitComposerMessage(page, "QZ_E2E_RECOVER");
    const recovered = await waitEvent(page, { type: "agent_start", sessionId }, recoveryAfter);
    assert.notEqual(recovered.runId, pending.runId);
    await waitEvent(page, { type: "agent_end", sessionId, runId: recovered.runId }, recoveryAfter);
    await page.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("QZ_E2E_RECOVER_OK"));
    assert.equal((await request(page, "get_state", { sessionId }, "state")).status, "completed");
    assert.match(await page.locator("#messages").innerText(), /QZ_E2E_BASIC_OK/);
    assert.equal(await page.locator("#input").isEditable(), true);
    console.log(JSON.stringify({ scenario: "run_profile_initialization_error_recovery", ok: true }));
  } finally {
    await worker.evaluate(() => {
      globalThis.__qzRunProfileFault?.restore();
      globalThis.__qzRunProfileFault?.reject?.();
      delete globalThis.__qzRunProfileFault;
    });
    await deleteSession(page, sessionId);
  }
}

async function locationOnlyWhenRequested(page) {
  await page.evaluate(() => {
    window.__locationReads = 0;
    Object.defineProperty(navigator.geolocation, "getCurrentPosition", { configurable: true, value(success) {
      window.__locationReads++;
      success({ coords: { latitude: 30.25, longitude: 120.15, accuracy: 10 }, timestamp: Date.now() });
    } });
  });
  const sessionId = await createSession(page, "Location consent");
  await switchUiToSession(page, sessionId);
  await page.locator("#input").fill("QZ_E2E_LOCATION");
  await page.locator("#input").press("Enter");
  await page.locator('.waiting-active [data-wait-action="continue"]').waitFor();
  assert.equal(await page.evaluate(() => window.__locationReads), 0);
  await page.locator('.waiting-active [data-wait-action="continue"]').click();
  await waitForTerminalState(page, sessionId, 20_000);
  assert.equal(await page.evaluate(() => window.__locationReads), 2);
  const events = await sessionEvents(page, sessionId);
  assert.equal(events.filter(event => event.type === "waiting_for_user").length, 1);
  const results = events.filter(event => event.type === "tool_execution_end" && event.toolName === "get_location");
  assert.equal(results.length, 2);
  for (const event of results) { assert.equal(event.isError, false); assert.equal(event.result.latitude, 30.25); }
  await deleteSession(page, sessionId);
}

async function waitForWorkspaceReady(page) {
  await page.waitForFunction(() => {
    const app = document.querySelector("#app");
    return app
      && !app.hasAttribute("data-workspace-booting")
      && !app.hasAttribute("data-workspace-boot-fallback");
  }, null, { timeout: 10_000 });
}

async function mcpOutputSchemaSurvivesExtensionCsp(page, providerServer) {
  const sessionId = await createSession(page, "MCP output schema under MV3 CSP");
  assert.match(await runPrompt(page, sessionId, "QZ_E2E_MCP_OUTPUT_SCHEMA"), /QZ_E2E_MCP_OUTPUT_SCHEMA_OK/);
  const events = await sessionEvents(page, sessionId);
  const toolResult = id => events.find(event => event.type === "tool_execution_end" && event.toolCallId === id);
  const inspected = toolResult("mcp_schema_inspect");
  assert.equal(inspected?.isError, false, "MCP tools/list must compile outputSchema under the real extension CSP");
  assert.equal(inspected.result.tools[0].outputSchema.properties.count.type, "integer");
  for (const id of ["mcp_schema_valid", "mcp_schema_recovered"]) {
    assert.equal(toolResult(id)?.isError, false, `${id} should validate successfully`);
    assert.deepEqual(toolResult(id).result.structuredContent, { count: 1 });
  }
  const invalid = toolResult("mcp_schema_invalid");
  assert.equal(invalid?.isError, true, "invalid structured output must remain an error after the session reconnects");
  assert.equal(invalid.result.code, "MCP_-32602");
  assert.equal(providerServer.mcpRequests.filter(method => method === "initialize").length, 2);
  assert.equal(providerServer.mcpRequests.filter(method => method === "tools/list").length, 2, "each connection initializes its SDK validators once");
  assert.equal(providerServer.mcpRequests.filter(method => method === "tools/call").length, 4);
}

async function screenActionFeedbackRoundTrip(page, browserContext, providerServer) {
  const sessionId = await createSession(page, "screen action feedback");
  const activeTabId = await page.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  const result = await runPrompt(page, sessionId, "QZ_E2E_SCREEN_ACTION");
  assert.match(result, /QZ_E2E_SCREEN_ACTION_OK/);

  const tabs = await page.evaluate(() => chrome.tabs.query({}));
  const targetTab = tabs.find(tab => tab.url === providerServer.screenActionUrl);
  assert.equal(targetTab?.active, false, "screen actions must work on the owned background tab");
  assert.equal(tabs.find(tab => tab.active && tab.windowId === targetTab.windowId)?.id, activeTabId, "screen actions must preserve the user's active tab");

  const targetPage = browserContext.pages().find(candidate => candidate.url() === providerServer.screenActionUrl);
  assert.ok(targetPage, "screen action should keep its owned target tab");
  await targetPage.waitForFunction(() => {
    const state = window.__readScreenActionState?.();
    return state?.inputValue === "扩展最终值"
      && state?.wheelEvents === 3
      && state?.dragReleased === true;
  });
  const observedState = await targetPage.evaluate(() => window.__readScreenActionState());
  assert.equal(observedState.clickCount, 1);
  assert.equal(observedState.doubleClickClicks, 2);
  assert.equal(observedState.doubleClickCount, 1);
  assert.ok(observedState.hoverEnterCount >= 1);
  assert.ok(observedState.hoverMoveCount >= 1);
  assert.equal(observedState.longPressActive, false);
  assert.ok(observedState.longPressMs >= 260, `the page should observe the requested long press (${observedState.longPressMs}ms)`);
  assert.equal(observedState.inputValue, "扩展最终值");
  assert.equal(observedState.keyEvents.at(-1)?.key, "Enter");
  assert.equal(observedState.trustedWheelEvents, 3, "every requested wheel must reach the page as native input");
  assert.equal(observedState.wheelDeltaX, 30);
  assert.equal(observedState.wheelDeltaY, 360);
  assert.equal(observedState.scrollY, 0);
  assert.equal(observedState.dragStarted, true);
  // Chrome can coalesce DOM moves; the unit suite checks all eight dispatched steps.
  assert.ok(observedState.dragMoves >= 1);
  assert.equal(observedState.dragReleased, true);
  assert.equal(observedState.dropped, true);

  const events = await page.evaluate(() => window.__qzBackgroundE2E.events());
  const screenshotEnd = events.find(event => (
    event?.type === "tool_execution_end"
    && event?.sessionId === sessionId
    && event?.toolName === "screenshot"
    && event?.result?.actionable === true
  ));
  const macroEnd = events.find(event => (
    event?.type === "tool_execution_end"
    && event?.sessionId === sessionId
    && event?.toolName === "run_script"
    && event?.toolCallId === "call_screen_macro"
  ));
  const actions = macroEnd?.result?.result?.batch?.actions || [];
  const longPress = actions.find(action => action.action === "long_press");
  const wheel = actions.find(action => action.action === "scroll");
  const finalAction = actions.at(-1);
  assert.ok(screenshotEnd?.result?.screenshotId, "actionable screenshot should expose a bound screenshot id");
  assert.equal(screenshotEnd?.result?.coordinateSpace?.unit, "pixel");
  assert.ok(screenshotEnd?.result?.coordinateSpace?.width >= 500);
  assert.ok(screenshotEnd?.result?.coordinateSpace?.height >= 500);
  assert.equal(macroEnd?.isError, false);
  assert.deepEqual(
    actions.map(action => action.action),
    ["click", "double_click", "hover", "long_press", "type", "press", "type", "press", "scroll", "drag"],
    "the extension E2E should exercise every act_on_screen action in one ordered sequence",
  );
  assert.equal(actions[0]?.sourceScreenshotId, screenshotEnd.result.screenshotId);
  assert.equal(
    actions.filter(action => action.coordinateBound).every(action => (
      action.sourceScreenshotId === screenshotEnd.result.screenshotId
    )),
    true,
    "coordinate-bound actions should reuse one basis without hidden screenshots",
  );
  assert.equal(
    actions.filter(action => !action.coordinateBound).every(action => action.sourceScreenshotId == null),
    true,
    "coordinate-free actions should not consume a screenshot coordinate basis",
  );
  assert.equal(actions.every(action => action.feedbackAvailable === false), true);
  assert.equal(actions.every(action => action.coordinateBasisReady === true), true);
  assert.equal(longPress?.durationMs, 300);
  assert.equal(wheel?.repeat, 3, "the visual macro should preserve one bounded real-wheel sequence");
  assert.equal(wheel?.coordinateBasisReady, true);
  assert.deepEqual(wheel?.viewportChange, {
    observed: true,
    scrolled: false,
    deltaX: 0,
    deltaY: 0,
    scaled: false,
    resized: false,
  }, "the tool should report that the page consumed wheel input without moving Chrome's viewport");
  assert.equal(finalAction?.feedbackAvailable, false);
  assert.equal(finalAction?.coordinateBasisReady, true);
  assert.equal(finalAction?.sourceScreenshotId, screenshotEnd.result.screenshotId);
  assert.equal(finalAction?.action, "drag");
  assert.equal(finalAction?.marker?.kind, "drag");
  assert.equal(finalAction?.marker?.action, "drag");
  assert.ok(finalAction?.marker?.endX > finalAction?.marker?.x);
  assert.equal(macroEnd?.result?.result?.ok, true);
  assert.equal(macroEnd?.result?.result?.filled, 10);
  assert.deepEqual(macroEnd?.result?.result?.batch?.state, observedState);
  assert.equal(macroEnd?.result?._display, undefined, "run_script should not synthesize an action animation");
  assert.match(macroEnd?.result?._image, /^data:image\/jpeg;base64,/);
  const feedbackPixels = await page.evaluate(async id => {
    const event = window.__qzBackgroundE2E.events().find(item => (
      item?.type === "tool_execution_end"
      && item?.sessionId === id
      && item?.toolName === "run_script"
      && item?.toolCallId === "call_screen_macro"
    ));
    const response = await fetch(event?.result?._image || "");
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let green = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      if (r > 170 && g < 130 && b < 140) red += 1;
      if (r > 190 && g > r + 6 && g > b + 3) green += 1;
    }
    return { red, green };
  }, sessionId);
  assert.ok(feedbackPixels.red < 20, `model feedback should not contain a burned-in red position marker (${feedbackPixels.red})`);
  assert.ok(feedbackPixels.green > 1000, `run_script should promote the final explicit screenshot after the green hover/drop states (${feedbackPixels.green})`);

  const requests = providerServer.requests.filter(item => item.marker === "QZ_E2E_SCREEN_ACTION");
  assert.equal(requests.length, 11, "one run should execute the visual macro and seven further screenshot observations");
  assert.equal(requests[2].imageCount, 1, "the actionable screenshot should reach the model");
  assert.equal(requests[3].imageCount, 1, "the batch's last explicit observation should return to the model");
  assert.equal(requests[2].imageMessageCount, 1);
  assert.equal(requests[2].totalImageCount, 1);
  assert.equal(requests[2].imagePlaceholderCount, 0);
  assert.deepEqual(requests.slice(2).map(item => item.imageMessageCount), [1, 2, 3, 4, 5, 6, 7, 8, 8],
    "successive tool images in a single run must obey the default eight-message limit");
  assert.equal(requests.at(-1).totalImageCount, 8, "the entire final model request retains only the latest eight screenshots");
  assert.equal(requests.at(-1).imagePlaceholderCount, 1, "the oldest screenshot remains represented by its placeholder");
  assert.equal(requests[3].containsDisplayProjection, false, "chat-only action metadata must not enter model context");

  const history = await historyMessages(page, sessionId);
  assert.equal(imageProjectionStats(history).totalImageCount, 9, "model projection must preserve all nine original history images");
  const exported = await request(page, "get_messages", { sessionId }, "messages");
  const exportedMessages = (exported.session?.entries || []).map(entry => entry.message);
  assert.equal(imageProjectionStats(exportedMessages).totalImageCount, 9, "conversation export retains all nine original tool images");
  assert.equal(imageProjectionStats(exportedMessages).imagePlaceholderCount, 0);
}

async function uidBatchCollectAcrossTabsHonorsDocumentIdentity(page, browserContext, providerServer) {
  const sessionId = await createSession(page, "uid batch collect across tabs");
  const after = await eventCount(page);
  const worker = browserContext.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  assert.ok(worker);
  try {
    await send(page, "prompt", { sessionId, text: "QZ_E2E_TABUIDS", clientMessageId: id("uid-batch") });
    const started = await waitEvent(page, { type: "agent_start", sessionId }, after, 20_000);

    // The provider gates the third request until the pages change below.
    const collectRequest = await (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const match = providerServer.requests.find(item => item.marker === "QZ_E2E_TABUIDS" && item.count === 3);
        if (match) return match;
        await page.waitForTimeout(50);
      }
      return null;
    })();
    assert.ok(collectRequest, "the provider must receive the request following the list_images batch");
    for (const variant of ["a", "b", "c"]) {
      assert.equal(collectRequest.uidBatch?.[variant]?.targets?.length, 2, `list_images on tab ${variant} must yield two uid targets`);
    }

    const fixturePage = variant => browserContext.pages().find(candidate => candidate.url().includes(`/uid-batch/${variant}`));
    const renamed = fixturePage("b");
    assert.ok(renamed, "fixture tab b must be open");
    // A MediaWiki-style title redirect: the URL string changes, the document does not.
    await renamed.evaluate(() => history.replaceState(null, "UID batch fixture b renamed", "/uid-batch/b-renamed"));
    const moved = fixturePage("c");
    assert.ok(moved, "fixture tab c must be open");
    await moved.goto(`${moved.url()}?moved=1`);

    // Hold a's first document probe. b must reach its probe while a is held,
    // but a's second call must not enter the same tab lane yet. Observe the probe
    // itself to verify overlap inside tool execution after its live start event.
    await worker.evaluate(tabId => {
      const original = chrome.scripting.executeScript;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const state = globalThis.__uidBatchProbe = { seen: [], held: false, release,
        restore() { release(); chrome.scripting.executeScript = original; delete globalThis.__uidBatchProbe; } };
      chrome.scripting.executeScript = async options => {
        if (options.target?.frameIds?.[0] === 0 && typeof options.func === "function") {
          state.seen.push(options.target.tabId);
          if (options.target.tabId === tabId && !state.held) { state.held = true; await gate; }
        }
        return original.call(chrome.scripting, options);
      };
    }, collectRequest.uidBatch.a.tabId);
    providerServer.release("QZ_E2E_TABUIDS_COLLECT");
    const seen = await worker.evaluate(async tabId => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (!globalThis.__uidBatchProbe.held || !globalThis.__uidBatchProbe.seen.includes(tabId))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return globalThis.__uidBatchProbe.seen;
    }, collectRequest.uidBatch.b.tabId);
    assert.ok(seen.includes(collectRequest.uidBatch.b.tabId), "different uid tabs must execute concurrently");
    assert.equal(seen.filter(tabId => tabId === collectRequest.uidBatch.a.tabId).length, 1,
      "a second call on the held uid tab must wait for its lane");
    await worker.evaluate(() => globalThis.__uidBatchProbe.restore());
    await waitEvent(page, { type: "agent_end", sessionId, runId: started.runId }, after, 90_000);
    assert.match(await latestAssistantText(page, sessionId), /QZ_E2E_TABUIDS_OK/);

    const events = await sessionEvents(page, sessionId, after);
    const collectStart = variant => events.find(event => event.type === "tool_execution_start" && event.toolCallId === `uid_batch_collect_${variant}`);
    const collectEnd = variant => events.find(event => event.type === "tool_execution_end" && event.toolCallId === `uid_batch_collect_${variant}`);
    for (const variant of ["a", "b", "c", "a_again", "mixed", "css"]) {
      const start = collectStart(variant);
      assert.ok(start, `collect_images ${variant} must start`);
      assert.equal(start.args?.tabId, undefined, `collect_images ${variant} must not inherit the working tab`);
      assert.equal(start.args?._tabId, undefined, `collect_images ${variant} must not carry the working tab mirror`);
      assert.equal(start.args?._pageUrl, undefined, `collect_images ${variant} must not carry the working page url`);
    }
    const unchanged = collectEnd("a");
    assert.equal(unchanged?.isError, false, `the unchanged tab must collect: ${JSON.stringify(unchanged?.result || {})}`);
    assert.equal(unchanged?.result?.collected, 2);
    assert.equal(unchanged?.result?.failed, 0);
    const renamedEnd = collectEnd("b");
    assert.equal(renamedEnd?.isError, false, `a same-document rename must not be judged stale: ${JSON.stringify(renamedEnd?.result || {})}`);
    assert.equal(renamedEnd?.result?.collected, 2);
    assert.equal(renamedEnd?.result?.images?.length, 2);
    assert.ok(
      (renamedEnd?.result?.images || []).every(image => String(image.pageUrl || "").includes("/uid-batch/b-renamed")),
      "the renamed tab resolves its uids against the live document",
    );
    const movedEnd = collectEnd("c");
    assert.equal(movedEnd?.isError, true, "a real navigation must stay stale");
    assert.equal(movedEnd?.result?.code, "STALE_ELEMENT_UID_PAGE_CHANGED");
    assert.equal(collectEnd("a_again")?.isError, false, "a second same-tab call succeeds after the first");
    const mixed = collectEnd("mixed");
    assert.equal(mixed?.isError, false, JSON.stringify(mixed?.result));
    assert.equal(mixed?.result?.collected, 2, "one cross-tab call resolves each uid on its own tab");
    assert.deepEqual(mixed?.result?.images?.map(image => new URL(image.pageUrl).pathname),
      ["/uid-batch/a", "/uid-batch/b-renamed"]);
    assert.deepEqual(mixed?.result?.images?.map(image => image.target),
      [collectRequest.uidBatch.a.targets[0], collectRequest.uidBatch.b.targets[0]]);
    const css = collectEnd("css");
    assert.equal(css?.isError, false, JSON.stringify(css?.result));
    assert.equal(css?.result?.collected, 2);
    assert.deepEqual(css?.result?.images?.map(image => new URL(image.pageUrl).pathname),
      ["/uid-batch/b-renamed", "/uid-batch/a"], "CSS uses the owned working tab while the uid retains its own tab");
  } finally {
    await worker.evaluate(() => globalThis.__uidBatchProbe?.restore()).catch(() => undefined);
    providerServer.release("QZ_E2E_TABUIDS_COLLECT");
    const fixtureTabIds = await page.evaluate(async () => (
      (await chrome.tabs.query({})).filter(tab => String(tab.url || "").includes("/uid-batch/")).map(tab => tab.id)
    )).catch(() => []);
    for (const tabId of fixtureTabIds) {
      if (Number.isInteger(tabId)) await page.evaluate(id => chrome.tabs.remove(id), tabId).catch(() => undefined);
    }
    await deleteSession(page, sessionId).catch(() => undefined);
  }
}

async function automationAlarmRunsWithoutSidepanel(currentPage, browserContext, extensionId, providerServer) {
  const fireAt = Date.now() + 3_000;
  const saved = await request(currentPage, "save_automation", {
    automation: {
      title: "alarm without sidepanel",
      instruction: "QZ_E2E_AUTOMATION",
      schedule: { type: "once", runAt: new Date(fireAt).toISOString() },
      missedPolicy: "skip",
      notifyPolicy: "silent",
      enabled: true,
    },
  }, "automation_saved");
  const automationId = saved.automation?.id;
  assert.ok(automationId, "automation should be saved before the sidepanel closes");

  await currentPage.evaluate(async ({ alarmName, when }) => {
    await chrome.alarms.clear(alarmName);
    await chrome.alarms.create(alarmName, { when, periodInMinutes: 1 });
  }, { alarmName: AUTOMATION_SCHEDULER_ALARM, when: fireAt });
  await currentPage.close();

  const deadline = Date.now() + 15_000;
  while (providerServer.count("QZ_E2E_AUTOMATION") === 0 && Date.now() < deadline) {
    await sleep(100);
  }
  assert.equal(
    providerServer.count("QZ_E2E_AUTOMATION"),
    1,
    "a real Chrome alarm should launch the automation while no sidepanel page is open",
  );

  const nextPage = await browserContext.newPage();
  await nextPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await waitForWorkspaceReady(nextPage);
  await installHarness(nextPage);
  await nextPage.waitForFunction(async id => {
    const { _automation_runs: runs = {} } = await chrome.storage.local.get("_automation_runs");
    const run = Object.values(runs).find(item => item?.automationId === id);
    return run && ["completed", "error", "aborted", "interrupted"].includes(run.status);
  }, automationId, { timeout: 20_000 });

  const listed = await request(nextPage, "list_automations", { runLimit: 5 }, "automations");
  const run = listed.runs?.[automationId]?.[0];
  assert.equal(run?.status, "completed");
  assert.equal(run?.triggerType, "schedule");
  assert.equal(run?.delayed, false, "an on-time alarm must not be classified as a missed run");
  await request(nextPage, "delete_automation", { automationId }, "automation_deleted");
  return nextPage;
}

async function runningAutomationCanBeDeleted(page, providerServer) {
  const marker = "QZ_E2E_DELETE_RUNNING_AUTOMATION";
  const saved = await request(page, "save_automation", {
    automation: {
      title: "delete while running",
      instruction: marker,
      schedule: { type: "daily", time: "23:59" },
      notifyPolicy: "silent",
      enabled: false,
    },
  }, "automation_saved");
  const automationId = saved.automation?.id;
  assert.ok(automationId);

  const started = await request(page, "run_automation", { automationId }, "automation_run_started");
  assert.ok(started.run?.sessionId, "manual automation should own a running Session before deletion");
  const deadline = Date.now() + 5_000;
  while (providerServer.count(marker) === 0 && Date.now() < deadline) await sleep(25);
  assert.equal(providerServer.count(marker), 1, "the automation Provider request must still be active when deletion begins");

  try {
    const deleted = await request(page, "delete_automation", { automationId }, "automation_deleted", 5_000);
    assert.equal(deleted.deleted, true, "deleting a running automation must complete without a lifecycle deadlock");
  } finally {
    providerServer.release(marker);
  }

  const persisted = await page.evaluate(async id => {
    const { _automations: automations = {}, _automation_runs: runs = {} } = await chrome.storage.local.get([
      "_automations",
      "_automation_runs",
    ]);
    return {
      definition: automations[id] || null,
      runs: Object.values(runs).filter(run => run?.automationId === id),
    };
  }, automationId);
  assert.equal(persisted.definition, null);
  assert.deepEqual(persisted.runs, []);
}

async function composerDraftSurvivesActualSidepanelCloseAndResize(currentPage, browserContext, extensionId) {
  const draftText = "切换侧边栏时需要保留这段较长的草稿，同时输入框应该按照侧边栏最终宽度重新计算高度，不能停留在展开过程中较窄宽度测出的高度。";
  await currentPage.locator("#btn-new").click();
  await currentPage.waitForFunction(() => (
    document.querySelector("#session-title-bar")?.classList.contains("hidden")
    && document.querySelector("#input")?.value === ""
  ));
  await currentPage.locator("#input").fill(draftText);
  await currentPage.close();

  const nextPage = await browserContext.newPage();
  await nextPage.setViewportSize({ width: 240, height: 860 });
  await nextPage.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await waitForWorkspaceReady(nextPage);
  await installHarness(nextPage);
  await nextPage.waitForFunction(expected => (
    document.querySelector("#input")?.value === expected
  ), draftText, { timeout: 10_000 });
  const narrowHeight = await nextPage.locator("#input").evaluate(input => input.getBoundingClientRect().height);
  assert.ok(narrowHeight >= 80, `the narrow restored composer should wrap (${narrowHeight}px)`);

  await nextPage.setViewportSize({ width: 520, height: 860 });
  await nextPage.waitForFunction(previousHeight => {
    const input = document.querySelector("#input");
    return input?.clientWidth >= 400
      && input.getBoundingClientRect().height < previousHeight - 20;
  }, narrowHeight, { timeout: 5_000 });
  const settledHeight = await nextPage.locator("#input").evaluate(input => input.getBoundingClientRect().height);
  assert.ok(
    settledHeight < narrowHeight - 20,
    `the composer should remeasure after its width settles (${narrowHeight}px -> ${settledHeight}px)`,
  );

  await nextPage.setViewportSize({ width: 980, height: 860 });
  await nextPage.locator("#input").fill("");
  await sleep(350);
  return nextPage;
}

async function composerAttachmentsSurviveSessionSwitchAndSend(page, fixtureBase64, providerServer) {
  const historicalSessionId = await createSession(page, "attachment history");
  await runPrompt(page, historicalSessionId, "QZ_E2E_ATTACHMENT_HISTORY_SEED");

  await page.locator("#btn-new").click();
  await page.waitForFunction(() => (
    document.querySelector("#session-title-bar")?.classList.contains("hidden")
    && document.querySelector("#input")?.value === ""
    && document.querySelectorAll(".input-attachment").length === 0
  ), null, { timeout: 10_000 });

  const createdAfter = await eventCount(page);
  await pasteComposerAttachments(page, {
    fixtureBase64,
    imageName: "new-session-image.png",
    documentName: "new-session-document.xlsx",
  });
  const created = await waitEvent(page, { type: "session_created" }, createdAfter, 20_000);
  const newSessionId = created.session?.id;
  assert.ok(newSessionId, "adding files in a new chat must create one real Session");
  await page.locator("#input").fill("QZ_E2E_ATTACHMENT_NEW");
  await assertComposerAttachments(page, {
    text: "QZ_E2E_ATTACHMENT_NEW",
    imageName: "new-session-image.png",
    documentName: "new-session-document.xlsx",
  });
  assert.equal(
    await matchingEventCount(page, { type: "session_created" }, createdAfter),
    1,
    "adding an image and document together must create exactly one Session",
  );

  await switchUiToSession(page, historicalSessionId);
  await assertComposerEmpty(page);
  await pasteComposerAttachments(page, {
    fixtureBase64,
    imageName: "history-session-image.png",
    documentName: "history-session-document.xlsx",
  });
  await page.locator("#input").fill("QZ_E2E_ATTACHMENT_HISTORY");
  await assertComposerAttachments(page, {
    text: "QZ_E2E_ATTACHMENT_HISTORY",
    imageName: "history-session-image.png",
    documentName: "history-session-document.xlsx",
  });

  for (let round = 0; round < 3; round += 1) {
    await switchUiToSession(page, newSessionId);
    await assertComposerAttachments(page, {
      text: "QZ_E2E_ATTACHMENT_NEW",
      imageName: "new-session-image.png",
      documentName: "new-session-document.xlsx",
    });
    await switchUiToSession(page, historicalSessionId);
    await assertComposerAttachments(page, {
      text: "QZ_E2E_ATTACHMENT_HISTORY",
      imageName: "history-session-image.png",
      documentName: "history-session-document.xlsx",
    });
  }

  const trace = await request(page, "get_trace", {}, "trace");
  const attachmentTrace = (trace.logs || []).filter(line => line.includes("attachment_trace action=stage"));
  for (const phase of ["decoded", "parsed", "ready"]) {
    assert.ok(
      attachmentTrace.filter(line => line.includes(` phase=${phase}`)).length >= 2,
      `both real documents should reach ${phase}`,
    );
  }
  assert.doesNotMatch(attachmentTrace.join("\n"), /真实后台解析/, "attachment trace must not include parsed file content");

  await sendComposerAttachments(page, historicalSessionId, "QZ_E2E_ATTACHMENT_HISTORY", providerServer);
  await switchUiToSession(page, newSessionId);
  await assertComposerAttachments(page, {
    text: "QZ_E2E_ATTACHMENT_NEW",
    imageName: "new-session-image.png",
    documentName: "new-session-document.xlsx",
  });
  await sendComposerAttachments(page, newSessionId, "QZ_E2E_ATTACHMENT_NEW", providerServer);

  for (const sessionId of [historicalSessionId, newSessionId]) {
    await switchUiToSession(page, sessionId);
    await assertComposerEmpty(page);
  }
  await deleteSession(page, historicalSessionId);
  await deleteSession(page, newSessionId);
}

async function pasteComposerAttachments(page, {
  fixtureBase64,
  imageName,
  documentName,
}) {
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await page.locator("#input").evaluate((input, value) => {
    const bytes = source => Uint8Array.from(atob(source), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes(value.imageBase64)], value.imageName, { type: "image/png" }));
    transfer.items.add(new File([bytes(value.fixtureBase64)], value.documentName, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, { fixtureBase64, imageBase64, imageName, documentName });
}

async function assertComposerAttachments(page, expected) {
  await page.waitForFunction(value => {
    const images = [...document.querySelectorAll(".input-image-attachment img")];
    const documents = [...document.querySelectorAll(".input-document-attachment")];
    return documents.some(node => node.classList.contains("is-error")) || (document.querySelector("#input")?.value === value.text
      && images.length === 1
      && images[0].getAttribute("alt") === value.imageName
      && documents.length === 1
      && documents[0].classList.contains("is-ready")
      && documents[0].querySelector(".document-attachment-name")?.textContent === value.documentName);
  }, expected, { timeout: 20_000 });
  const errors = await page.locator(".input-document-attachment.is-error").evaluateAll(nodes => nodes.map(node => node.getAttribute("title")));
  assert.deepEqual(errors, [], "composer document parsing failed");
  const state = await page.evaluate(() => ({
    text: document.querySelector("#input")?.value || "",
    imageCount: document.querySelectorAll(".input-image-attachment").length,
    documentCount: document.querySelectorAll(".input-document-attachment").length,
    sendDisabled: document.querySelector("#btn-send")?.disabled,
  }));
  assert.deepEqual(state, {
    text: expected.text,
    imageCount: 1,
    documentCount: 1,
    sendDisabled: false,
  });
}

async function assertComposerEmpty(page) {
  await page.waitForFunction(() => (
    document.querySelector("#input")?.value === ""
    && document.querySelectorAll(".input-image-attachment").length === 0
    && document.querySelectorAll(".input-document-attachment").length === 0
    && document.querySelector("#btn-send")?.disabled === true
  ), null, { timeout: 10_000 });
}

async function sendComposerAttachments(page, sessionId, marker, providerServer) {
  const after = await eventCount(page);
  await page.locator("#input").press("Enter");
  const started = await waitEvent(page, { type: "agent_start", sessionId }, after, 20_000);
  await waitEvent(page, { type: "agent_end", sessionId, runId: started.runId }, after, 20_000);
  await assertComposerEmpty(page);

  const userMessages = (await historyMessages(page, sessionId)).filter(message => (
    message.role === "user" && messageText(message).trim() === marker
  ));
  assert.equal(userMessages.length, 1, `${marker} should be committed exactly once`);
  const [message] = userMessages;
  const imageParts = Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "image_url")
    : [];
  assert.equal(imageParts.length, 1, `${marker} should retain one image in transcript`);
  assert.equal(message.documents?.length, 1, `${marker} should retain one document in transcript`);
  assert.equal(message.documents[0].messageId, message.clientMessageId, "document and message identity must match");

  const requestRecord = [...providerServer.requests].reverse().find(item => item.marker === marker);
  assert.ok(requestRecord, `${marker} should reach the Provider`);
  assert.equal(providerServer.count(marker), 1, `${marker} should produce one Provider request`);
  assert.equal(requestRecord.imageCount, 1, `${marker} should send one image to a vision Provider`);
  assert.ok(requestRecord.documentCapsuleCount >= 1, `${marker} should send its document capsule`);

  const bubble = page.locator(".msg-user").filter({ hasText: marker }).last();
  assert.equal(await bubble.locator(".msg-images img").count(), 1);
  assert.equal(await bubble.locator(".document-attachment-card").count(), 1);
}

async function gitSkillSourceAuthenticatedArchive(page, repositoryServer) {
  const result = await request(page, "bind_git_skill_source", {
    repositoryUrl: repositoryServer.repositoryUrl,
  }, "git_skill_source_synced", 60_000);
  assert.equal(result.ok, true);
  assert.equal(result.action, "bound");
  assert.deepEqual(result.names, ["git-auth-e2e-skill"]);
  assert.equal(repositoryServer.archiveRequests, 1, "archive download must use only the authenticated repository tab");
  assert.equal(repositoryServer.authenticatedArchiveRequests, 1, "the tab download must carry the repository page cookie");

  const stored = await page.evaluate(async () => chrome.storage.local.get(["_skills", "_gitSkillSources"]));
  const skill = stored._skills?.["git-auth-e2e-skill"];
  const source = Object.values(stored._gitSkillSources || {})[0];
  assert.equal(skill?.metadata?.qingzhou?.origin?.type, "git");
  assert.equal(skill?.metadata?.qingzhou?.origin?.sourceId, source?.id);
  assert.equal(source?.repositoryUrl, repositoryServer.rootUrl);
  assert.equal(source?.browseUrl, repositoryServer.repositoryUrl);
  assert.equal(source?.ref, "main");
  assert.equal(source?.subpath, "skills");
  assert.equal(source?.branch, "main");
  assert.equal(stored._skills?.["git-auth-outside-skill"], undefined);

  const listed = await request(page, "list_git_skill_sources", {}, "git_skill_sources");
  assert.equal(listed.sources?.[0]?.modifiedCount, 0, "a freshly overwritten repository Skill must match its installed baseline");

  const checked = await request(page, "check_git_skill_source", {
    sourceId: source.id,
  }, "git_skill_source_checked", 60_000);
  assert.equal(checked.action, "checked");
  assert.equal(checked.updateAvailable, false);
  assert.equal(checked.remoteChanged, false);
  const afterCheck = await page.evaluate(async () => chrome.storage.local.get(["_skills", "_gitSkillSources"]));
  assert.equal(afterCheck._skills?.["git-auth-e2e-skill"]?.content, skill?.content, "check must not write Skill content");
  assert.equal(afterCheck._gitSkillSources?.[source.id]?.revision, source.revision, "check must not advance the installed revision");

  const current = await request(page, "update_git_skill_source", {
    sourceId: source.id,
  }, "git_skill_source_synced", 60_000);
  assert.equal(current.action, "current");
  await page.evaluate(async () => {
    const { _skills: skills = {} } = await chrome.storage.local.get("_skills");
    skills["git-auth-e2e-skill"].content = "# Locally modified before unbind";
    await chrome.storage.local.set({ _skills: skills });
  });
  const removed = await request(page, "remove_git_skill_source", {
    sourceId: source.id,
    deleteUnmodifiedSkills: true,
  }, "git_skill_source_removed");
  assert.equal(removed.deletedCount, 0);
  assert.equal(removed.preservedModifiedCount, 1);
  const detached = await page.evaluate(async () => {
    const { _skills: skills = {} } = await chrome.storage.local.get("_skills");
    const value = skills["git-auth-e2e-skill"];
    return { content: value?.content, origin: value?.metadata?.qingzhou?.origin || null };
  });
  assert.equal(detached.content, "# Locally modified before unbind");
  assert.equal(detached.origin, null);
  await page.evaluate(async () => {
    const { _skills: skills = {} } = await chrome.storage.local.get("_skills");
    delete skills["git-auth-e2e-skill"];
    await chrome.storage.local.set({ _skills: skills });
  });
}

async function skillResultSelectionRoundTrip(page, providerServer) {
  const directory = join(root, "tests/fixtures/skills/result-selection");
  const evidenceDirectory = join(root, "tests/results/result-selection-task");
  mkdirSync(evidenceDirectory, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8"));
  Object.assign(manifest.tools[0].renderer, { itemImagePath: "imageUrl", urlPath: "url" });
  const sampleScript = readFileSync(join(directory, "scripts/choose.js"), "utf8");
  const script = `async () => {
    const result = await (${sampleScript})();
    return { items: result.items.map((item, index) => ({ ...item,
      imageUrl: ${JSON.stringify(providerServer.selectionImageUrl)} + "?portrait=" + (index % 2),
      url: ${JSON.stringify(providerServer.selectionImageUrl)} + "?role=" + item.id,
    })) };
  }`;
  const skill = normalizeModernSkill({
    ...skillFromSkillMarkdown(readFileSync(join(directory, "SKILL.md"), "utf8")),
    resources: [{ path: "plugin.json", content: JSON.stringify(manifest) }, { path: "scripts/choose.js", content: script }],
  });
  const saved = await request(page, "save_workspace_skill", { name: skill.name, expected: null, skill }, "skill_workspace_saved");
  assert.equal(saved.registryReady, true);
  const candidateIds = ["northstar-backend", "harbor-platform", "fieldwork-systems"];
  await page.setViewportSize({ width: 360, height: 920 });
  await page.emulateMedia({ colorScheme: "light" });

  for (const cancel of [false, true]) {
    const marker = cancel ? "QZ_E2E_SELECTION_CANCEL" : "QZ_E2E_SELECTION_PICK";
    const sessionId = await createSession(page, marker);
    await switchUiToSession(page, sessionId);
    const after = await eventCount(page);
    await submitComposerMessage(page, marker);
    const waiting = await waitEvent(page, { type: "waiting_for_user", sessionId }, after);
    assert.equal(waiting.form.fields[0].presentation, "cards");
    assert.deepEqual(waiting.form.fields[0].options.map(option => option.value), candidateIds);
    assert.deepEqual(waiting.form.fields[0].options[1].meta, ["Location: London · Hybrid", "Stack: Go · Kubernetes"]);
    assert.equal(waiting.form.fields[0].options[1].imageUrl, `${providerServer.selectionImageUrl}?portrait=1`);
    assert.equal(providerServer.count(marker), 2, "the model waits after loading and calling the Skill");

    if (!cancel) {
      await page.reload();
      await waitForWorkspaceReady(page);
      await installHarness(page);
      await switchUiToSession(page, sessionId);
    }
    const card = page.locator(`.waiting-active[data-wait-id="${waiting.waitId}"]`);
    await card.waitFor();
    assert.deepEqual(await card.locator(".qz-choice-card input").evaluateAll(inputs => inputs.map(input => input.value)), candidateIds);
    for (const image of await card.locator(".qz-choice-card-image").all()) {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(element => element.decode());
    }
    const rendered = await card.locator(".qz-choice-card").evaluateAll(cards => cards.map(element => {
      const image = element.querySelector("img");
      const rect = image.getBoundingClientRect();
      return {
        title: element.querySelector(".qz-choice-card-title").textContent,
        meta: [...element.querySelectorAll(".qz-choice-card-tag")].map(tag => tag.textContent),
        url: element.querySelector(".qz-choice-card-source").href,
        decoded: image.complete && image.naturalWidth > 0,
        imageSize: [rect.width, rect.height],
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    }));
    assert.deepEqual(rendered.map(item => item.title), ["Northstar", "Harbor", "Fieldwork"]);
    assert.deepEqual(rendered[1].meta, waiting.form.fields[0].options[1].meta);
    assert.equal(rendered[1].url, `${providerServer.selectionImageUrl}?role=harbor-platform`);
    assert.ok(rendered.every(item => item.decoded && !item.overflow));
    assert.deepEqual(rendered.map(item => item.imageSize), [[40, 40], [40, 40], [40, 40]]);
    assert.equal(providerServer.count(marker), 2, "restoring and rendering the wait must not resume the model");
    const actionAfter = await eventCount(page);
    if (cancel) {
      await card.locator('[data-wait-action="cancel"]').click();
      const failed = await waitEvent(page, { type: "tool_execution_end", sessionId, toolCallId: "selection_choose" }, actionAfter);
      assert.equal(failed.isError, true);
      assert.equal(failed.result.code, "USER_CANCELLED_WAIT");
    } else {
      await card.locator('input[value="harbor-platform"]').check();
      await card.locator('input[value="fieldwork-systems"]').check();
      assert.match(await card.locator("[data-choice-count]").innerText(), /2/);
      assert.equal(providerServer.count(marker), 2, "local selection must not call the model");
      await card.locator(".waiting-options").evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: join(evidenceDirectory, "waiting-light.png"), animations: "disabled" });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: join(evidenceDirectory, "waiting-dark.png"), animations: "disabled" });
      await page.emulateMedia({ colorScheme: "light" });
      const locked = await card.locator('[data-wait-action="continue"]').evaluate(button => {
        button.click();
        button.click();
        return button.disabled;
      });
      assert.equal(locked, true, "submission locks immediately, including a second click in the same event loop");
      const completed = await waitEvent(page, { type: "tool_execution_end", sessionId, toolCallId: "selection_choose" }, actionAfter);
      assert.equal(completed.isError, false);
      assert.deepEqual(completed.result.result.selectedIds, candidateIds.slice(1));
      assert.equal(Object.hasOwn(completed.result.result, "items"), false);
    }
    await waitForTerminalState(page, sessionId, 20_000);
    await card.waitFor({ state: "detached" });
    const modelRequests = providerServer.requests.filter(item => item.marker === marker);
    assert.equal(modelRequests.length, 3, "the task resumes once after the user settles the selection");
    const modelResult = modelRequests.at(-1).selectionResult;
    if (cancel) {
      assert.equal(modelResult.code, "USER_CANCELLED_WAIT");
      assert.equal(modelResult.selectedItems, undefined);
    } else {
      const selection = modelResult.result || modelResult;
      assert.deepEqual(selection.selectedIds, candidateIds.slice(1));
      assert.deepEqual(selection.selectedItems.map(item => item.id), candidateIds.slice(1));
      assert.equal(selection.selectedItems[0].company, "Harbor");
      assert.equal(selection.totalItems, 3);
      assert.equal(modelRequests.at(-1).selectionContainsUnselected, false, "unselected candidate data stays out of model context");
      assert.match(await latestAssistantText(page, sessionId), /QZ_E2E_SELECTION_PICK_OK/);
      await page.screenshot({ path: join(evidenceDirectory, "submitted-light.png"), animations: "disabled" });
    }
    await deleteSession(page, sessionId);
  }
  await request(page, "delete_workspace_skill", { name: skill.name, expected: saved.skill }, "skill_workspace_deleted");
  await page.setViewportSize({ width: 980, height: 860 });
  await page.emulateMedia({ colorScheme: "light" });
}

async function uiComposerRoundTrip(page) {
  await page.locator("#input").fill("QZ_E2E_UI");
  await page.locator("#input").press("Enter");
  await page.waitForFunction(() => document.querySelector("#messages")?.innerText?.includes("QZ_E2E_UI_OK"), null, {
    timeout: 20_000,
  });
  const text = await page.locator("#messages").innerText();
  assert.match(text, /QZ_E2E_UI/);
  assert.match(text, /QZ_E2E_UI_OK/);
}

async function manualCompactRendersLifecycleCard(page) {
  const sessionId = await createSession(page, "manual compact lifecycle");
  const longRound = "compact fixture history ".repeat(80);
  await runPrompt(page, sessionId, `${longRound} first`);
  await runPrompt(page, sessionId, `${longRound} second`);
  await runPrompt(page, sessionId, `${longRound} retained`);
  await switchUiToSession(page, sessionId);
  const messages = page.locator("#messages");
  await messages.hover();
  await page.mouse.wheel(0, -1200);
  await page.waitForFunction(() => {
    const host = document.querySelector("#messages");
    return host && host.scrollHeight - host.scrollTop - host.clientHeight > 100;
  });

  const after = await eventCount(page);
  await submitComposerMessage(page, "/compact 重点保留第二轮内容");
  const started = await waitEvent(page, { type: "context_compaction_start", sessionId }, after, 20_000);
  assert.ok(started.compactId, "manual compact must publish its stable operation identity");
  await page.locator(`.msg-compact`).last().waitFor({ state: "visible", timeout: 10_000 });
  await waitEvent(page, {
    type: "context_compaction_end",
    sessionId,
    compactId: started.compactId,
  }, after, 20_000);
  await waitEvent(page, { type: "state", sessionId, status: "completed" }, after, 20_000);
  await page.waitForFunction(() => (
    [...document.querySelectorAll(".msg-compact")]
      .some(card => card.textContent?.includes("上下文已压缩"))
  ), null, { timeout: 10_000 });
  const compactCardIsInViewport = await page.locator(".msg-compact").last().evaluate(card => {
    const host = document.querySelector("#messages");
    const cardRect = card.getBoundingClientRect();
    const hostRect = host?.getBoundingClientRect();
    return Boolean(hostRect && cardRect.bottom > hostRect.top && cardRect.top < hostRect.bottom);
  });
  assert.equal(compactCardIsInViewport, true, "an explicit compact command must reveal its lifecycle card");

  const state = await request(page, "get_state", { sessionId }, "state");
  assert.equal(state.status, "completed", "manual compact must settle its Session runtime");
  assert.equal(state.runtime?.running, false, "manual compact must not leave the Session runtime active");
  await deleteSession(page, sessionId);
}

async function queuedComposerBubbleUsesOutgoingMotion(page) {
  await page.locator("#input").fill("QZ_QUEUE_ACTIVE");
  await page.locator("#input").press("Enter");
  await page.locator("#btn-abort").waitFor({ state: "visible", timeout: 20_000 });

  await page.evaluate(() => {
    window.__qzQueuedEntryMotion = null;
    window.__qzQueuedEntryObserver?.disconnect?.();
    const messages = document.querySelector("#messages");
    const observer = new MutationObserver(() => {
      const message = [...messages.querySelectorAll(".msg-user")]
        .find(element => element.textContent?.includes("QZ_QUEUE_NEXT"));
      if (!message) return;
      const content = message.querySelector(".msg-content");
      window.__qzQueuedEntryMotion = {
        armed: message.classList.contains("msg-user-outgoing-enter"),
        animationName: content ? getComputedStyle(content).animationName : "",
      };
      observer.disconnect();
    });
    observer.observe(messages, { childList: true, subtree: true });
    window.__qzQueuedEntryObserver = observer;
  });

  await page.locator("#input").fill("QZ_QUEUE_NEXT");
  await page.locator("#input").press("Enter");
  await page.waitForFunction(() => document.querySelector("#queued-followups")?.innerText?.includes("QZ_QUEUE_NEXT"), null, {
    timeout: 10_000,
  });
  await page.waitForFunction(() => window.__qzQueuedEntryMotion !== null, null, { timeout: 20_000 });
  const motion = await page.evaluate(() => window.__qzQueuedEntryMotion);
  assert.deepEqual(motion, { armed: true, animationName: "user-message-sail-in" });
  await page.waitForFunction(() => document.querySelector("#messages")?.innerText?.includes("QZ_QUEUE_NEXT_OK"), null, {
    timeout: 20_000,
  });
}

async function basicAndRetryScenarios(page, providerServer) {
  const basic = await createSession(page, "deterministic basic");
  const basicResult = await runPrompt(page, basic, "QZ_E2E_BASIC");
  assert.match(basicResult, /QZ_E2E_BASIC_OK/);
  await deleteSession(page, basic);

  const retry = await createSession(page, "deterministic retry");
  const retryResult = await runPrompt(page, retry, "QZ_E2E_RETRY");
  assert.match(retryResult, /QZ_E2E_RETRY_OK/);
  assert.equal(providerServer.count("QZ_E2E_RETRY"), 2, "503 must produce exactly one retry");
  await deleteSession(page, retry);
}

async function steeringReentersTheActiveRun(page, providerServer) {
  const sessionId = await createSession(page, "steering active run");
  const firstClientMessageId = id("steering-first");
  const secondClientMessageId = id("steering-second");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "QZ_E2E_STEER_ACTIVE",
    clientMessageId: id("steering-active"),
  });
  const activeRun = await waitEvent(page, { type: "agent_start", sessionId }, after, 20_000);

  await send(page, "follow_up", {
    sessionId,
    text: "QZ_E2E_STEER_ONE",
    clientMessageId: firstClientMessageId,
  });
  await send(page, "follow_up", {
    sessionId,
    text: "QZ_E2E_STEER_TWO",
    clientMessageId: secondClientMessageId,
  });
  await waitForQueueCount(page, sessionId, 2, after);

  const first = await request(page, "steer_follow_up", {
    sessionId,
    clientMessageId: firstClientMessageId,
  }, "follow_up_steered");
  assert.equal(first.moved, true);
  const second = await request(page, "steer_follow_up", {
    sessionId,
    clientMessageId: secondClientMessageId,
  }, "follow_up_steered");
  assert.equal(second.moved, true);
  assert.deepEqual(second.pendingFollowUps, []);
  assert.deepEqual(
    second.pendingSteerings.map(item => item.clientMessageId),
    [firstClientMessageId, secondClientMessageId],
  );

  await waitEvent(page, { type: "agent_end", sessionId, runId: activeRun.runId }, after, 20_000);
  const history = await historyMessages(page, sessionId);
  assert.deepEqual(
    history
      .filter(message => message.role === "user" && /QZ_E2E_STEER_(?:ONE|TWO)/u.test(messageText(message)))
      .map(message => messageText(message)),
    ["QZ_E2E_STEER_ONE", "QZ_E2E_STEER_TWO"],
  );
  const events = await page.evaluate(({ sessionId, after }) => (
    window.__qzBackgroundE2E.events().slice(after).filter(event => event?.sessionId === sessionId)
  ), { sessionId, after });
  const acceptedSteering = events.filter(event => (
    event.type === "message_start"
    && [firstClientMessageId, secondClientMessageId].includes(event.clientMessageId || event.message?.clientMessageId)
  ));
  assert.equal(acceptedSteering.length, 2);
  const firstAcceptedIndex = events.findIndex(event => (
    event.type === "message_start"
    && (event.clientMessageId || event.message?.clientMessageId) === firstClientMessageId
  ));
  let handoffQueueIndex = -1;
  for (let index = 0; index < firstAcceptedIndex; index += 1) {
    const event = events[index];
    if (
      event.type === "queue_update"
      && event.pendingFollowUps?.length === 0
      && event.pendingSteerings?.length === 0
    ) handoffQueueIndex = index;
  }
  assert.notEqual(handoffQueueIndex, -1, "steering handoff must publish the final queue state");
  assert.equal(
    firstAcceptedIndex,
    handoffQueueIndex + 1,
    "the first accepted steering message must immediately follow the visible batch dequeue",
  );
  assert.ok(acceptedSteering.every(event => event.runId === activeRun.runId), "steering must stay inside the active run");
  assert.equal(events.filter(event => event.type === "agent_start").length, 1, "steering must not open follow-up runs");

  const steeredRequest = providerServer.requests.find(item => item.marker === "QZ_E2E_STEER_TWO");
  assert.ok(steeredRequest, "provider must receive a continuation after steering is injected");
  assert.deepEqual(
    steeredRequest.userTexts.filter(text => /QZ_E2E_STEER_(?:ONE|TWO)/u.test(text)),
    ["QZ_E2E_STEER_ONE", "QZ_E2E_STEER_TWO"],
    "all steering messages available at the safe point must share one LLM request",
  );
  const checkpoint = await readRuntime(page, sessionId);
  assert.deepEqual(checkpoint.pendingSteeringMessages, []);
  assert.deepEqual(checkpoint.pendingFollowUpMessages, []);
  await deleteSession(page, sessionId);
}

async function steeringQueueLifecycleMatrix(page, providerServer) {
  const singleSessionId = await createSession(page, "steering matrix single");
  const otherSessionId = await createSession(page, "steering matrix other");
  const multiSessionId = await createSession(page, "steering matrix multi");

  try {
    await switchUiToSession(page, singleSessionId);
    const singleAfter = await eventCount(page);
    await submitComposerMessage(page, "QZ_E2E_STEER_SINGLE_ACTIVE");
    const singleRun = await waitEvent(page, { type: "agent_start", sessionId: singleSessionId }, singleAfter, 20_000);
    const singleMessageId = await enqueueComposerMessage(page, "QZ_E2E_STEER_SINGLE_MESSAGE");
    await steerQueuedMessage(page, singleMessageId);
    await waitForRuntimeQueues(page, singleSessionId, {
      steerings: [singleMessageId],
      followUps: [],
    });

    providerServer.release("QZ_E2E_STEER_SINGLE_ACTIVE");
    await waitEvent(page, { type: "agent_end", sessionId: singleSessionId, runId: singleRun.runId }, singleAfter, 20_000);
    await page.waitForFunction(text => document.querySelector("#messages")?.innerText?.includes(text), "QZ_E2E_STEER_SINGLE_OK", {
      timeout: 20_000,
    });

    const singleHistory = await historyMessages(page, singleSessionId);
    assert.deepEqual(
      singleHistory
        .filter(message => message.role === "user" && messageText(message).includes("QZ_E2E_STEER_SINGLE_MESSAGE"))
        .map(message => messageText(message)),
      ["QZ_E2E_STEER_SINGLE_MESSAGE"],
      "one steering message must enter the transcript exactly once",
    );
    assert.equal(
      singleHistory.filter(message => message?._contextCapsule?.reason === "queued_user_message").length,
      1,
      "one steering handoff must create exactly one runtime-context capsule",
    );
    assertGaplessSteeringHandoff(
      await sessionEvents(page, singleSessionId, singleAfter),
      [singleMessageId],
    );
    assert.deepEqual(await visibleQueueRows(page), [], "single steering queue must be empty after handoff");
    assertRuntimeQueuesEmpty(await readRuntime(page, singleSessionId));
    const singleRequest = [...providerServer.requests].reverse()
      .find(item => item.marker === "QZ_E2E_STEER_SINGLE_MESSAGE");
    assert.ok(singleRequest, "provider must receive the single steering continuation");
    assert.equal(
      singleRequest.userTexts.filter(text => text.includes("QZ_E2E_STEER_SINGLE_MESSAGE")).length,
      1,
      "provider must receive the single steering message exactly once",
    );

    await switchUiToSession(page, multiSessionId);
    const multiAfter = await eventCount(page);
    await submitComposerMessage(page, "QZ_E2E_STEER_MULTI_ACTIVE");
    const multiRun = await waitEvent(page, { type: "agent_start", sessionId: multiSessionId }, multiAfter, 20_000);

    const firstId = await enqueueComposerMessage(page, "QZ_E2E_STEER_MULTI_ONE");
    const deletedSteeringId = await enqueueComposerMessage(page, "QZ_E2E_STEER_MULTI_DELETE_STEERING");
    const thirdId = await enqueueComposerMessage(page, "QZ_E2E_STEER_MULTI_THREE");
    const deletedFollowUpId = await enqueueComposerMessage(page, "QZ_E2E_STEER_MULTI_DELETE_FOLLOWUP");
    await steerQueuedMessage(page, firstId);
    await steerQueuedMessage(page, deletedSteeringId);
    await steerQueuedMessage(page, thirdId);
    await deleteQueuedMessage(page, deletedSteeringId);
    await deleteQueuedMessage(page, deletedFollowUpId);
    await waitForRuntimeQueues(page, multiSessionId, {
      steerings: [firstId, thirdId],
      followUps: [],
    });
    assert.deepEqual(await visibleQueueRows(page), [
      { id: firstId, kind: "steering", text: "QZ_E2E_STEER_MULTI_ONE" },
      { id: thirdId, kind: "steering", text: "QZ_E2E_STEER_MULTI_THREE" },
    ], "deleting one steering and one follow-up must preserve the remaining order");

    await switchUiToSession(page, otherSessionId);
    assert.deepEqual(await visibleQueueRows(page), [], "another session must not display the active session queue");
    await switchUiToSession(page, multiSessionId);
    assert.deepEqual(await visibleQueueRows(page), [
      { id: firstId, kind: "steering", text: "QZ_E2E_STEER_MULTI_ONE" },
      { id: thirdId, kind: "steering", text: "QZ_E2E_STEER_MULTI_THREE" },
    ], "switching back must restore the exact steering queue from runtime state");

    await observeSteeringBatchMotion(page);
    providerServer.release("QZ_E2E_STEER_MULTI_ACTIVE");
    await waitEvent(page, { type: "agent_end", sessionId: multiSessionId, runId: multiRun.runId }, multiAfter, 20_000);
    await page.waitForFunction(text => document.querySelector("#messages")?.innerText?.includes(text), "QZ_E2E_STEER_MULTI_OK", {
      timeout: 20_000,
    });
    await page.waitForFunction(() => window.__qzSteeringBatchMotion?.maxBatchGhostCount >= 1, null, { timeout: 10_000 });
    const batchMotion = await finishSteeringBatchMotion(page);
    assert.deepEqual(batchMotion, {
      maxBatchGhostCount: 1,
      maxBatchRowCount: 2,
      maxIndividualGhostCount: 0,
      batchSizes: ["2"],
    }, "two steering messages must leave through one batch capsule, never two individual capsules");

    const multiHistory = await historyMessages(page, multiSessionId);
    assert.deepEqual(
      multiHistory
        .filter(message => message.role === "user" && /QZ_E2E_STEER_MULTI_(?:ONE|THREE)/u.test(messageText(message)))
        .map(message => messageText(message)),
      ["QZ_E2E_STEER_MULTI_ONE", "QZ_E2E_STEER_MULTI_THREE"],
      "surviving steering messages must enter the transcript once and in order",
    );
    assert.equal(
      multiHistory.filter(message => message?._contextCapsule?.reason === "queued_user_message").length,
      1,
      "one multi-message steering handoff must share one runtime-context capsule",
    );
    assert.equal(
      multiHistory.some(message => /QZ_E2E_STEER_MULTI_DELETE_(?:STEERING|FOLLOWUP)/u.test(messageText(message))),
      false,
      "deleted queue entries must never enter the transcript",
    );
    assertGaplessSteeringHandoff(
      await sessionEvents(page, multiSessionId, multiAfter),
      [firstId, thirdId],
    );
    assert.deepEqual(await visibleQueueRows(page), [], "multi steering queue must be empty after handoff");
    assertRuntimeQueuesEmpty(await readRuntime(page, multiSessionId));

    const multiRequest = [...providerServer.requests].reverse()
      .find(item => item.marker === "QZ_E2E_STEER_MULTI_THREE");
    assert.ok(multiRequest, "provider must receive the multi steering continuation");
    assert.deepEqual(
      multiRequest.userTexts.filter(text => /QZ_E2E_STEER_MULTI_(?:ONE|THREE)/u.test(text)),
      ["QZ_E2E_STEER_MULTI_ONE", "QZ_E2E_STEER_MULTI_THREE"],
      "all surviving steering messages must share one provider request in FIFO order",
    );
    assert.equal(
      multiRequest.userTexts.some(text => /QZ_E2E_STEER_MULTI_DELETE_(?:STEERING|FOLLOWUP)/u.test(text)),
      false,
      "deleted queue entries must never reach the provider",
    );
  } finally {
    await finishSteeringBatchMotion(page).catch(() => undefined);
    providerServer.release("QZ_E2E_STEER_SINGLE_ACTIVE");
    providerServer.release("QZ_E2E_STEER_MULTI_ACTIVE");
    await Promise.all([
      deleteSession(page, singleSessionId),
      deleteSession(page, otherSessionId),
      deleteSession(page, multiSessionId),
    ]).catch(() => undefined);
  }
}

async function manageExistingSession(page, provider) {
  const parent = await createSession(page, "manage existing task");
  const child = await createSession(page, "managed task");
  try {
    for (const mode of ["follow_up", "steer"]) {
      const after = await eventCount(page);
      await runPrompt(page, parent, "QZ_E2E_MANAGE " + JSON.stringify({ action: "send_message", sessionId: child, message: "QZ_E2E_RECOVER", mode }));
      await waitEvent(page, { type: "agent_end", sessionId: child }, after, 20_000);
    }
    const after = await eventCount(page);
    await send(page, "prompt", { sessionId: child, text: "QZ_E2E_MANAGED_CHILD", clientMessageId: id("managed") });
    await waitEvent(page, { type: "agent_start", sessionId: child }, after, 20_000);
    await runPrompt(page, parent, "QZ_E2E_MANAGE " + JSON.stringify({ action: "stop", sessionId: child }));
    const state = await request(page, "get_state", { sessionId: child }, "state");
    assert.equal(state.status, "aborted");
  } finally {
    provider.release("QZ_E2E_MANAGED_CHILD");
    await deleteSession(page, parent);
    await deleteSession(page, child);
  }
}

async function providerFailureReleasesTheSession(page) {
  for (const [marker, expected] of [
    ["QZ_E2E_HTTP_ERROR", /401|injected auth failure/i],
    ["QZ_E2E_UNSUPPORTED_IMAGE", /当前模型可能不支持图片或截图输入/],
  ]) {
    const sessionId = await createSession(page, "provider failure recovery");
    const after = await eventCount(page);
    await send(page, "prompt", { sessionId, text: marker, clientMessageId: id("error") });
    await waitEvent(page, { type: "error", sessionId }, after, 20_000);
    await waitEvent(page, { type: "agent_end", sessionId }, after, 20_000);
    const failed = await request(page, "get_state", { sessionId }, "state");
    assert.equal(failed.status, "error");
    assert.match(failed.runtime?.reason || "", expected);
    const failedMessages = await request(page, "get_messages", { sessionId }, "messages");
    const failureTranscript = Array.isArray(failedMessages.transcript) ? failedMessages.transcript : [];
    assert.equal(failureTranscript.filter(entry => entry.type === "error").length, 0, "visible assistant failure must not duplicate an error card");
    assert.equal(failureTranscript.filter(entry => entry.type === "assistant" && /LLM 调用失败/.test(entry.content || "")).length, 1);

    if (marker === "QZ_E2E_UNSUPPORTED_IMAGE") {
      const failure = failureTranscript.find(entry => entry.type === "assistant" && /LLM 调用失败/.test(entry.content || ""));
      assert.match(failure.content, expected);
      assert.doesNotMatch(failure.content, /data:|Unexpected|invalid_parameter_error/);
    }

    const recovered = await runPrompt(page, sessionId, "QZ_E2E_RECOVER");
    assert.match(recovered, /QZ_E2E_RECOVER_OK/);
    const state = await request(page, "get_state", { sessionId }, "state");
    assert.equal(state.status, "completed");
    await deleteSession(page, sessionId);
  }
}

async function providerFaultLifecycleMatrix(page, providerServer) {
  for (const fault of ["HTTP", "EOF", "SSE", "SOCKET"]) {
    for (const action of ["FAIL", "STEER", "STOP", "DELETE"]) {
      const marker = `QZ_E2E_FAULT_${fault}_${action}`;
      const sessionId = await createSession(page, marker);
      const after = await eventCount(page);
      try {
        await switchUiToSession(page, sessionId);
        await submitComposerMessage(page, marker);
        const run = await waitEvent(page, { type: "agent_start", sessionId }, after);
        if (fault === "HTTP") {
          const deadline = Date.now() + 10_000;
          while (!providerServer.count(marker) && Date.now() < deadline) await sleep(20);
          assert.equal(providerServer.count(marker), 1, "provider must receive the gated request");
        } else {
          await waitEvent(page, { type: "message_update", sessionId, runId: run.runId }, after);
        }

        let queuedId;
        if (action === "STEER") {
          queuedId = await enqueueComposerMessage(page, "QZ_E2E_RECOVER");
          await steerQueuedMessage(page, queuedId);
          await waitForRuntimeQueues(page, sessionId, { steerings: [queuedId] });
        } else if (action === "STOP") {
          const stopped = await request(page, "stop_session", { sessionId }, "state", 5_000);
          assert.equal(stopped.status, "aborted", "stop must settle before the provider is released");
        } else if (action === "DELETE") {
          const deleted = await request(page, "delete_session", { sessionId }, "delete_session_result", 5_000);
          assert.equal(deleted.sessionId, sessionId, "deletion must finish while the provider is still blocked");
        }

        const boundary = await eventCount(page);
        const recoveryRequests = providerServer.count("QZ_E2E_RECOVER");
        providerServer.release(marker);
        if (action === "DELETE" || action === "STOP") {
          // Allow the late network failure to cross the real worker/Port boundary.
          await page.waitForTimeout(200);
          assert.equal(await matchingEventCount(page, {
            type: "message_update", sessionId, runId: run.runId,
          }, boundary), 0, "late deltas must not cross a terminal boundary");
          if (action === "DELETE") {
            const records = await page.evaluate(id => chrome.storage.local.get([
              `_session_${id}`, `_session_runtime_${id}`, `_active_conversation_${id}`, `_session_transcript_checkpoint_${id}`,
            ]), sessionId);
            assert.deepEqual(records, {}, "late provider failure must not revive deleted records");
          } else {
            const state = await request(page, "get_state", { sessionId }, "state");
            assert.equal(state.status, "aborted", "late provider failure must not overwrite explicit stop");
          }
        } else {
          await waitEvent(page, { type: "error", sessionId, runId: run.runId }, after);
          await waitEvent(page, { type: "agent_end", sessionId, runId: run.runId }, after);
          assert.equal(await matchingEventCount(page, { type: "aborted", sessionId, runId: run.runId }, after), 0);
          if (action === "STEER") {
            await page.waitForFunction(() => document.querySelector("#messages")?.innerText?.includes("QZ_E2E_RECOVER_OK"), null, { timeout: 20_000 });
            await waitForAgentEndCount(page, sessionId, after, 2, 20_000);
            const history = await historyMessages(page, sessionId);
            assert.equal(history.filter(message => message.role === "user" && messageText(message) === "QZ_E2E_RECOVER").length, 1);
            assert.equal(providerServer.count("QZ_E2E_RECOVER"), recoveryRequests + 1,
              "queued steering must continue automatically and reach the provider exactly once");
            assertRuntimeQueuesEmpty(await readRuntime(page, sessionId));
            assert.deepEqual(await visibleQueueRows(page), []);
            assertGaplessSteeringHandoff(await sessionEvents(page, sessionId, after), [queuedId]);
          }
          const state = await request(page, "get_state", { sessionId }, "state");
          assert.equal(state.status, action === "STEER" ? "completed" : "error");
          if (action === "FAIL") assert.match(await runPrompt(page, sessionId, "QZ_E2E_RECOVER"), /QZ_E2E_RECOVER_OK/);
        }
        console.log(JSON.stringify({ providerFault: fault, action, ok: true }));
      } finally {
        providerServer.release(marker);
        await deleteSession(page, sessionId);
      }
    }
  }
}

async function stopCutsOffLateStreaming(page, providerServer) {
  const sessionId = await createSession(page, "stream stop");
  const after = await eventCount(page);
  await send(page, "prompt", { sessionId, text: "QZ_E2E_STOP", clientMessageId: id("stop") });
  const stoppedRun = await waitEvent(page, { type: "agent_start", sessionId }, after, 20_000);
  await waitEvent(page, { type: "message_update", sessionId, runId: stoppedRun.runId }, after, 20_000);

  const queueAfter = await eventCount(page);
  await send(page, "follow_up", {
    sessionId,
    text: "QZ_E2E_AFTER_ABORT_1",
    clientMessageId: id("queued-1"),
  });
  await send(page, "follow_up", {
    sessionId,
    text: "QZ_E2E_AFTER_ABORT_2",
    clientMessageId: id("queued-2"),
  });
  const queued = await waitForQueueCount(page, sessionId, 2, queueAfter);
  assert.deepEqual(
    queued.pendingFollowUpMessages.map(message => message.clientMessageId),
    queued.pendingFollowUps.map(item => item.clientMessageId),
  );

  const afterStop = await eventCount(page);
  const stopped = await request(page, "stop_session", { sessionId }, "state");
  assert.equal(stopped.status, "aborted");
  assert.deepEqual(
    stopped.runtime?.pendingFollowUpMessages?.map(message => message.clientMessageId),
    queued.pendingFollowUpMessages.map(message => message.clientMessageId),
  );
  const oldRunUpdates = { type: "message_update", sessionId, runId: stoppedRun.runId };
  const countAtStop = await matchingEventCount(page, oldRunUpdates, after);
  await page.waitForTimeout(500);
  assert.equal(
    await matchingEventCount(page, oldRunUpdates, after),
    countAtStop,
    "no stream delta may cross the durable stop boundary",
  );

  const queuedEnds = await waitForAgentEndCount(page, sessionId, afterStop, 2, 20_000);
  assert.equal(new Set(queuedEnds.map(event => event.runId)).size, 2, "each queued message must own a distinct run");
  const history = await historyMessages(page, sessionId);
  assert.deepEqual(
    history
      .filter(message => message.role === "user" && /QZ_E2E_AFTER_ABORT_[12]/.test(messageText(message)))
      .map(message => messageText(message)),
    ["QZ_E2E_AFTER_ABORT_1", "QZ_E2E_AFTER_ABORT_2"],
    "queued user messages must survive abort in FIFO order",
  );
  assert.deepEqual(
    providerServer.requests
      .filter(item => /^QZ_E2E_AFTER_ABORT_[12]$/u.test(item.marker))
      .map(item => item.marker),
    ["QZ_E2E_AFTER_ABORT_1", "QZ_E2E_AFTER_ABORT_2"],
    "the provider must receive each queued message exactly once and in order",
  );
  const checkpoint = await readRuntime(page, sessionId);
  assert.equal(checkpoint.status, "completed");
  assert.deepEqual(checkpoint.pendingFollowUpMessages, []);
  await deleteSession(page, sessionId);
}

async function concurrentSessionsStayIsolated(page) {
  const [left, right] = await Promise.all([
    createSession(page, "concurrent left"),
    createSession(page, "concurrent right"),
  ]);
  const after = await eventCount(page);
  await Promise.all([
    send(page, "prompt", { sessionId: left, text: "QZ_E2E_PARALLEL_A", clientMessageId: id("left") }),
    send(page, "prompt", { sessionId: right, text: "QZ_E2E_PARALLEL_B", clientMessageId: id("right") }),
  ]);
  await Promise.all([
    waitEvent(page, { type: "agent_end", sessionId: left }, after, 20_000),
    waitEvent(page, { type: "agent_end", sessionId: right }, after, 20_000),
  ]);
  assert.match(await latestAssistantText(page, left), /QZ_E2E_PARALLEL_A_OK/);
  assert.match(await latestAssistantText(page, right), /QZ_E2E_PARALLEL_B_OK/);
  await Promise.all([deleteSession(page, left), deleteSession(page, right)]);
}

async function sidepanelReloadKeepsTheBackgroundRun(page) {
  const sessionId = await createSession(page, "sidepanel reload");
  const after = await eventCount(page);
  await send(page, "prompt", { sessionId, text: "QZ_E2E_RECONNECT", clientMessageId: id("reload") });
  await waitEvent(page, { type: "message_update", sessionId }, after, 20_000);

  await page.reload();
  await page.waitForSelector("#input", { state: "attached" });
  await installHarness(page);
  const terminal = await waitForTerminalState(page, sessionId, 20_000);
  assert.equal(terminal.status, "completed");
  assert.match(await latestAssistantText(page, sessionId), /QZ_E2E_RECONNECT_OK/);
  const history = await historyMessages(page, sessionId);
  assert.equal(history.filter(message => message.role === "user" && messageText(message).includes("QZ_E2E_RECONNECT")).length, 1);
  await deleteSession(page, sessionId);
}

async function resetSurvivesSessionReopen(page, providerServer) {
  const sessionId = await createSession(page, "reset and reopen");
  const otherSessionId = await createSession(page, "switch away after reset");
  const oldPrompt = `QZ_E2E_RESET_OLD ${id("old-context")}`;
  try {
    assert.match(await runPrompt(page, sessionId, oldPrompt), /QZ_E2E_RESET_OLD_OK/);
    await switchUiToSession(page, sessionId);
    await page.waitForFunction(() => document.querySelector("#messages")?.innerText.includes("QZ_E2E_RESET_OLD_OK"));
    const after = await eventCount(page);
    await send(page, "reset", { sessionId });
    await waitEvent(page, { type: "reset", sessionId }, after);
    const cleared = await page.evaluate(async sessionId => {
      const key = `_session_${sessionId}`, activeKey = `_active_conversation_${sessionId}`;
      const checkpointKey = `_session_transcript_checkpoint_${sessionId}`;
      const saved = await chrome.storage.local.get([key, activeKey, checkpointKey]);
      return { record: saved[key], active: saved[activeKey], checkpoint: saved[checkpointKey] };
    }, sessionId);
    assert.deepEqual(cleared.active?.entries, [], "reset completion must follow the empty active-conversation write");
    assert.deepEqual(cleared.record?.conversation?.entries, [], "reset must replace the durable model history");
    assert.deepEqual(readCheckpointRecord(cleared.record, cleared.checkpoint)?.transcript, []);
    await page.waitForFunction(() => !document.querySelector("#messages")?.innerText.includes("QZ_E2E_RESET_OLD"));
    await switchUiToSession(page, otherSessionId);
    await switchUiToSession(page, sessionId);

    // Await the same saved-conversation restore protocol used when opening a session.
    const stored = await page.evaluate(async sessionId => {
      const key = `_session_${sessionId}`, activeKey = `_active_conversation_${sessionId}`;
      const checkpointKey = `_session_transcript_checkpoint_${sessionId}`;
      const saved = await chrome.storage.local.get([key, activeKey, checkpointKey]);
      return { record: saved[key], active: saved[activeKey], checkpoint: saved[checkpointKey] };
    }, sessionId);
    const { conversation } = readSessionSnapshot(stored.record, stored.active, stored.checkpoint);
    await request(page, "restore_session", { sessionId, session: conversation }, "session_restored");
    const reopened = await request(page, "get_messages", { sessionId }, "messages");
    assert.doesNotMatch(JSON.stringify(reopened.transcript), /QZ_E2E_RESET_OLD/);
    assert.doesNotMatch(await page.locator("#messages").innerText(), /QZ_E2E_RESET_OLD/);
    assert.match(await runPrompt(page, sessionId, "QZ_E2E_RESET_NEW"), /QZ_E2E_RESET_NEW_OK/);
    const nextRequest = providerServer.requests.find(item => item.marker === "QZ_E2E_RESET_NEW");
    assert.ok(nextRequest);
    assert.equal(nextRequest.containsResetHistory, false, "reset must remove old context from the next model request");
    assert.equal(nextRequest.userTexts.includes(oldPrompt), false);
    assert.equal(providerServer.count("QZ_E2E_RESET_OLD"), 1);
    assert.equal(providerServer.count("QZ_E2E_RESET_NEW"), 1);
    assert.doesNotMatch(JSON.stringify((await request(page, "get_messages", { sessionId }, "messages")).transcript), /QZ_E2E_RESET_OLD/);
    console.log(JSON.stringify({ scenario: "reset_reopen", ok: true }));
  } finally {
    await deleteSession(page, sessionId);
    await deleteSession(page, otherSessionId);
  }
}

async function serviceWorkerRestartSettlesInterruptedTurn(page, browserContext, extensionId, providerServer) {
  const sessionId = await createSession(page, "service worker restart");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "QZ_E2E_WORKER_OLD",
    clientMessageId: id("worker-old"),
  });
  await waitEvent(page, { type: "message_update", sessionId }, after, 20_000);
  assert.equal((await readRuntime(page, sessionId)).status, "running");

  await terminateExtensionServiceWorker(page, browserContext, extensionId);
  await page.reload();
  await page.waitForSelector("#input", { state: "attached" });
  await installHarness(page);
  const recovered = await request(page, "get_state", { sessionId }, "state");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.runtime?.reason, "service_worker_restarted");

  const response = await runPrompt(page, sessionId, "QZ_E2E_WORKER_NEW");
  assert.match(response, /QZ_E2E_WORKER_NEW_OK/);
  const requestRecord = [...providerServer.requests].reverse().find(item => item.marker === "QZ_E2E_WORKER_NEW");
  assert.equal(requestRecord?.settledInterruptedTurn, true, "the provider must not receive consecutive unresolved user turns");
  await deleteSession(page, sessionId);
  return serviceWorkerRestartKeepsCompletedCheckpoints(page, browserContext, extensionId, providerServer);
}

async function serviceWorkerRestartKeepsCompletedCheckpoints(page, browserContext, extensionId, providerServer) {
  const sessionId = await createSession(page, "restore completed checkpoint after restart");
  const marker = "QZ_E2E_WORKER_CHECKPOINT";
  const completedText = "QZ_CHECKPOINT_COMPLETED_BEFORE_RESTART";
  const partialText = "QZ_CHECKPOINT_IN_PROGRESS";
  const toolCallId = "call_worker_checkpoint_tabs";
  const interruptedText = "运行已中断，已恢复保存的对话。发送消息可继续。";
  const assertInterruptedNotice = async () => {
    const notice = page.locator("#messages .msg-run-status-interrupted");
    await notice.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await notice.count(), 1);
    assert.equal((await notice.textContent()).trim(), interruptedText);
    assert.equal(await notice.evaluate((element, completedText) => {
      const completed = [...document.querySelectorAll("#messages .msg-assistant .msg-content")]
        .find(node => node.textContent.includes(completedText));
      return Boolean(completed && (completed.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    }, completedText), true, "the interruption notice must follow the recovered checkpoint");
  };
  try {
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    assert.match(await runPrompt(page, sessionId, "QZ_E2E_BASIC"), /QZ_E2E_BASIC_OK/);
    const completedTranscript = await page.evaluate(async sessionId => {
      const key = `_session_${sessionId}`;
      return (await chrome.storage.local.get(key))[key]?.transcript;
    }, sessionId);
    assert.ok(completedTranscript?.some(entry => entry.type === "assistant" && entry.content === "QZ_E2E_BASIC_OK"));
    await switchUiToSession(page, sessionId);
    const after = await eventCount(page);
    await submitComposerMessage(page, marker);
    await waitEvent(page, { type: "tool_execution_end", sessionId, toolCallId }, after);
    await page.waitForFunction(text => document.querySelector("#messages")?.innerText.includes(text), partialText);
    const deadline = Date.now() + 5_000;
    let savedRecord;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(async sessionId => {
        const recordKey = `_session_${sessionId}`;
        const activeKey = `_active_conversation_${sessionId}`;
        const checkpointKey = `_session_transcript_checkpoint_${sessionId}`;
        const values = await chrome.storage.local.get([recordKey, activeKey, checkpointKey]);
        return { record: values[recordKey], active: values[activeKey], checkpoint: values[checkpointKey] };
      }, sessionId);
      const messages = snapshot.active?.entries?.map(entry => entry.message) || [];
      const record = readCheckpointRecord(snapshot.record, snapshot.checkpoint);
      const transcript = record?.transcript || [];
      if (messages.some(message => message?.role === "assistant" && message.content === completedText)
        && messages.some(message => message?.role === "tool" && message.tool_call_id === toolCallId)
        && transcript.some(entry => entry.type === "user" && entry.text === marker)
        && transcript.some(entry => entry.type === "assistant" && entry.content === completedText)
        && transcript.some(entry => entry.type === "tool" && entry.toolCallId === toolCallId && entry.result && !entry.isRunning)
        && transcript.some(entry => entry.type === "assistant" && entry.content === partialText)) {
        savedRecord = record;
        break;
      }
      await sleep(50);
    }
    assert.ok(savedRecord, "the current transcript, including partial output, must reach storage while the provider stream remains open");
    assert.deepEqual(savedRecord.transcript.slice(0, completedTranscript.length), completedTranscript,
      "checkpointing the current turn must leave the completed transcript unchanged");

    await terminateExtensionServiceWorker(page, browserContext, extensionId);
    await page.close();
    page = await browserContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
    await waitForWorkspaceReady(page);
    await installHarness(page);
    await switchUiToSession(page, sessionId);
    const restored = await request(page, "get_messages", { sessionId }, "messages");
    assert.deepEqual(restored.transcript.slice(0, completedTranscript.length), completedTranscript);
    assert.equal(restored.transcript.filter(entry => entry.type === "user" && entry.text === marker).length, 1);
    assert.equal(restored.transcript.filter(entry => entry.type === "assistant" && entry.content === completedText).length, 1);
    assert.equal(restored.transcript.filter(entry => entry.type === "assistant" && entry.content === partialText).length, 1);
    await page.waitForFunction(texts => texts.every(text => document.querySelector("#messages")?.innerText.includes(text)),
      [completedText, partialText]);
    assert.equal(await page.locator("#messages .msg-user").filter({ hasText: marker }).count(), 1);
    for (const text of ["QZ_E2E_BASIC_OK", completedText, partialText]) {
      assert.equal(await page.locator("#messages .msg-assistant").filter({ hasText: text }).count(), 1);
    }
    const tools = restored.transcript.filter(entry => entry.type === "tool" && entry.toolCallId === toolCallId);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].isError, false);
    assert.ok(tools[0].result);
    const state = await request(page, "get_state", { sessionId }, "state");
    assert.equal(state.status, "interrupted");
    assert.equal(state.runtime?.reason, "service_worker_restarted");
    await assertInterruptedNotice();
    await page.reload();
    await waitForWorkspaceReady(page);
    await installHarness(page);
    await switchUiToSession(page, sessionId);
    await assertInterruptedNotice();
    const otherSessionId = await createSession(page, "switch away from interrupted checkpoint");
    await switchUiToSession(page, otherSessionId);
    await switchUiToSession(page, sessionId);
    await assertInterruptedNotice();
    await deleteSession(page, otherSessionId);
    assert.equal(providerServer.count(marker), 2, "reopening must not resend the interrupted request");
    const oldRunId = state.runtime.runId;
    assert.match(await runPrompt(page, sessionId, "QZ_E2E_RECOVER"), /QZ_E2E_RECOVER_OK/);
    const completed = await request(page, "get_state", { sessionId }, "state");
    assert.equal(completed.status, "completed");
    assert.notEqual(completed.runtime.runId, oldRunId);
    await restartWorkerAndReloadSession(page, browserContext, extensionId, sessionId);
    await assertInterruptedNotice();
    const afterContinuation = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
    const notices = afterContinuation.filter(entry => entry.type === "run-status" && entry.status === "interrupted");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].runId, oldRunId);
    assert.ok(afterContinuation.indexOf(notices[0]) < afterContinuation.findIndex(entry => entry.type === "user" && entry.text === "QZ_E2E_RECOVER"));
    assert.equal(afterContinuation.filter(entry => entry.type === "assistant" && entry.content === "QZ_E2E_RECOVER_OK").length, 1);
    assert.equal(providerServer.count(marker), 2);
    console.log(JSON.stringify({ scenario: "worker_restart_checkpoint", ok: true }));
    await deleteSession(page, sessionId);
    return page;
  } finally {
    providerServer.release(marker);
  }
}

async function restartWorkerAndReloadSession(page, browserContext, extensionId, sessionId) {
  await terminateExtensionServiceWorker(page, browserContext, extensionId);
  await page.reload();
  await waitForWorkspaceReady(page);
  await installHarness(page);
  await switchUiToSession(page, sessionId);
}

async function serviceWorkerRestartCancelsCompaction(page, browserContext, extensionId, providerServer) {
  const sessionId = await createSession(page, "restore interrupted manual compaction");
  const marker = "QZ_E2E_WORKER_COMPACT";
  try {
    const longRound = "compact fixture history ".repeat(80);
    for (const round of ["first", "second", "retained"]) await runPrompt(page, sessionId, `${longRound} ${round}`);
    await switchUiToSession(page, sessionId);
    const after = await eventCount(page);
    await submitComposerMessage(page, `/compact ${marker}`);
    const started = await waitEvent(page, { type: "context_compaction_start", sessionId }, after, 20_000);
    assert.ok(started.compactId);
    const deadline = Date.now() + 5_000;
    let savedCompact;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(async sessionId => {
        const recordKey = `_session_${sessionId}`;
        const checkpointKey = `_session_transcript_checkpoint_${sessionId}`;
        const values = await chrome.storage.local.get([recordKey, checkpointKey]);
        return { record: values[recordKey], checkpoint: values[checkpointKey] };
      }, sessionId);
      savedCompact = readCheckpointRecord(snapshot.record, snapshot.checkpoint)?.transcript
        .find(entry => entry.type === "compact" && entry.compactId === started.compactId);
      if (savedCompact?.status === "running" && providerServer.count(marker) === 1) break;
      await sleep(50);
    }
    assert.equal(savedCompact?.status, "running", "the in-progress compaction must reach storage before Worker termination");
    assert.equal(providerServer.count(marker), 1, "the summary provider request must be held at its gate");

    for (const continued of [false, true]) {
      if (continued) assert.match(await runPrompt(page, sessionId, "QZ_E2E_RECOVER"), /QZ_E2E_RECOVER_OK/);
      await restartWorkerAndReloadSession(page, browserContext, extensionId, sessionId);
      const transcript = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
      const compact = transcript.filter(entry => entry.type === "compact");
      assert.equal(compact.length, 1);
      assert.equal(compact[0].compactId, started.compactId);
      assert.equal(compact[0].status, "aborted");
      assert.equal(Boolean(compact[0].streaming), false);
      const card = page.locator("#messages .msg-compact");
      await card.waitFor({ state: "visible" });
      assert.equal(await card.count(), 1);
      await card.locator('.compact-node[data-status="aborted"]').waitFor({ state: "visible" });
      assert.ok((await card.innerText()).includes("压缩已取消，未写入新的上下文边界。"));
      assert.equal(await card.locator(".compact-node-dot").evaluate(node => getComputedStyle(node).animationName), "none");
      assert.equal(providerServer.count(marker), 1, "reopening must not replay the interrupted compaction");
      if (continued) assert.equal(transcript.filter(entry => entry.type === "assistant" && entry.content === "QZ_E2E_RECOVER_OK").length, 1);
    }
    console.log(JSON.stringify({ scenario: "worker_restart_compact", ok: true }));
  } finally {
    providerServer.release(marker);
    await deleteSession(page, sessionId);
  }
}

async function serviceWorkerRestartKeepsImagesAndThinking(page, browserContext, extensionId, providerServer) {
  const sessionId = await createSession(page, "restore nine real screenshots and thinking");
  const project = transcript => ({
    screenshots: transcript.filter(entry => entry.type === "tool" && entry.name === "screenshot").map(entry => ({
      toolCallId: entry.toolCallId, args: entry.args, result: entry.result,
      imageHash: createHash("sha256").update(entry.image || "").digest("hex"),
    })),
    thinking: transcript.filter(entry => entry.type === "thinking").map(entry => ({ text: entry.text, runId: entry.runId, spanId: entry.spanId })),
  });
  try {
    await saveConfig(page, providerServer.endpoint, { vision: true });
    const after = await eventCount(page);
    await send(page, "prompt", { sessionId, text: "QZ_E2E_WORKER_IMAGES", clientMessageId: id("worker-images") });
    await waitEvent(page, { type: "agent_end", sessionId }, after, 60_000);
    assert.match(await latestAssistantText(page, sessionId), /QZ_E2E_WORKER_IMAGES_OK/);
    const before = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
    const screenshots = before.filter(entry => entry.type === "tool" && entry.name === "screenshot");
    assert.equal(screenshots.length, 9);
    for (const entry of screenshots) {
      assert.equal(entry.isError, false);
      assert.match(entry.image || "", /^data:image\/jpeg;base64,/);
      assert.ok(entry.args._tabId > 0, "real execution must enrich the model's empty screenshot arguments");
      assert.equal(entry.args._pageTitle, "Act on screen behavior fixture");
      assert.equal(entry.args._pageUrl, providerServer.screenActionUrl);
    }
    const expected = project(before);
    assert.equal(expected.thinking.length, 9);
    await restartWorkerAndReloadSession(page, browserContext, extensionId, sessionId);
    const restored = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
    assert.deepEqual(project(restored), expected, "reopening must preserve all nine images, enriched arguments, results and complete thinking");
    const closedTools = page.locator('#messages .msg-tool > .tool-summary[aria-expanded="false"]');
    while (await closedTools.count()) await closedTools.first().click();
    const closedThinking = page.locator('#messages .thinking-group-summary[aria-expanded="false"]');
    while (await closedThinking.count()) await closedThinking.first().click();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll("#messages .tool-screenshot img")];
      return images.length === 9 && images.every(image => image.complete && image.naturalWidth > 0);
    });
    for (const { text } of expected.thinking) assert.ok((await page.locator("#messages").innerText()).includes(text));
    console.log(JSON.stringify({ scenario: "worker_restart_images", screenshots: 9, thinking: expected.thinking.length, ok: true }));
  } finally {
    await saveConfig(page, providerServer.endpoint);
    await deleteSession(page, sessionId);
  }
}

async function serviceWorkerRestartKeepsProviderFailure(page, browserContext, extensionId) {
  const sessionId = await createSession(page, "restore provider error before and after retry");
  try {
    await switchUiToSession(page, sessionId);
    const after = await eventCount(page);
    await submitComposerMessage(page, "QZ_E2E_HTTP_ERROR");
    await waitEvent(page, { type: "error", sessionId }, after);
    await waitEvent(page, { type: "agent_end", sessionId }, after);
    const before = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
    const failure = before.find(entry => entry.type === "assistant" && /LLM 调用失败/.test(entry.content || ""));
    assert.ok(failure);
    const errorCard = page.locator("#messages .chat-error-card");
    await errorCard.waitFor({ state: "visible" });
    const failureText = await errorCard.innerText();
    assert.match(failureText, /401|injected auth failure/);
    for (const recovered of [false, true]) {
      if (recovered) assert.match(await runPrompt(page, sessionId, "QZ_E2E_RECOVER"), /QZ_E2E_RECOVER_OK/);
      await restartWorkerAndReloadSession(page, browserContext, extensionId, sessionId);
      const restored = (await request(page, "get_messages", { sessionId }, "messages")).transcript;
      assert.equal(restored.filter(entry => entry.type === "assistant" && entry.content === failure.content).length, 1,
        `the provider failure text must survive restart${recovered ? " after a successful retry" : ""}`);
      await errorCard.waitFor({ state: "visible" });
      assert.equal(await errorCard.count(), 1);
      assert.equal(await errorCard.innerText(), failureText);
      if (recovered) assert.equal(restored.filter(entry => entry.type === "assistant" && entry.content === "QZ_E2E_RECOVER_OK").length, 1);
    }
    console.log(JSON.stringify({ scenario: "worker_restart_errors", ok: true }));
  } finally {
    await deleteSession(page, sessionId);
  }
}

async function saveConfig(page, endpoint, overrides = {}) {
  const response = await request(page, "save_config", {
    config: {
      provider: "custom",
      customProtocol: "openai",
      customEndpoint: endpoint,
      apiKey: "deterministic-test-key",
      model: "deterministic-model",
      contextWindow: 128000,
      trimOldToolResults: true,
      vision: false,
      debugMode: false,
      ...overrides,
    },
  }, "config_saved");
  assert.equal(response.config?.provider, "custom");
}

async function runPrompt(page, sessionId, text) {
  const after = await eventCount(page);
  await send(page, "prompt", { sessionId, text, clientMessageId: id("user") });
  const started = await waitEvent(page, { type: "agent_start", sessionId }, after, 20_000);
  await waitEvent(page, { type: "agent_end", sessionId, runId: started.runId }, after, 20_000);
  return latestAssistantText(page, sessionId);
}

async function createSession(page, title) {
  const result = await request(page, "create_ui_session", { title, firstMessage: "" }, "create_ui_session_result");
  assert.ok(result.session?.id);
  return result.session.id;
}

async function deleteSession(page, sessionId) {
  const result = await request(page, "delete_session", { sessionId }, "delete_session_result");
  assert.equal(result.sessionId, sessionId);
}

async function latestAssistantText(page, sessionId) {
  const messages = await historyMessages(page, sessionId);
  return messageText([...messages].reverse().find(message => message.role === "assistant"));
}

async function historyMessages(page, sessionId) {
  const result = await request(page, "get_history", { sessionId }, "history");
  return Array.isArray(result.messages) ? result.messages : [];
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter(item => item?.type === "text").map(item => item.text || "").join("\n");
}

async function waitForTerminalState(page, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await request(page, "get_state", { sessionId }, "state", 5_000);
    if (["completed", "error", "aborted", "interrupted"].includes(state.status)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error(`timed out waiting for terminal state: ${sessionId}`);
}

function readRuntime(page, sessionId) {
  return page.evaluate(async id => {
    const key = `_session_runtime_${id}`;
    return (await chrome.storage.local.get(key))[key] || null;
  }, sessionId);
}

async function switchUiToSession(page, sessionId) {
  await page.locator('.tab-btn[data-tab="sessions"]').click();
  await page.waitForFunction(id => (
    [...document.querySelectorAll(".session-card[data-id]")]
      .some(card => card.dataset.id === id)
  ), sessionId, { timeout: 10_000 });
  await page.locator(`.session-card[data-id="${sessionId}"]`).click();
  await page.waitForFunction(sessionId => {
    const chatIsActive = document.querySelector('.tab-btn[data-tab="chat"]')?.classList.contains("active");
    const currentTitle = document.querySelector("#current-session-title")?.textContent?.trim() || "";
    const selectedCard = [...document.querySelectorAll(".session-card[data-id]")]
      .find(card => card.dataset.id === sessionId);
    const selectedTitle = selectedCard?.querySelector(".session-card-title")?.textContent?.trim() || "";
    return Boolean(selectedCard && chatIsActive && selectedTitle && currentTitle === selectedTitle);
  }, sessionId, { timeout: 10_000 });
}

async function submitComposerMessage(page, text) {
  const input = page.locator("#input");
  await input.fill(text);
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector("#input")?.value === "", null, { timeout: 10_000 });
}

async function enqueueComposerMessage(page, text) {
  await submitComposerMessage(page, text);
  await page.waitForFunction(expected => (
    [...document.querySelectorAll("#queued-followups .queued-followup")]
      .some(row => row.querySelector(".queued-followup-text")?.textContent?.trim() === expected)
  ), text, { timeout: 10_000 });
  return page.evaluate(expected => {
    const row = [...document.querySelectorAll("#queued-followups .queued-followup")]
      .find(item => item.querySelector(".queued-followup-text")?.textContent?.trim() === expected);
    return row?.dataset.clientMessageId || "";
  }, text).then(clientMessageId => {
    assert.ok(clientMessageId, `queued composer message must have a clientMessageId: ${text}`);
    return clientMessageId;
  });
}

async function steerQueuedMessage(page, clientMessageId) {
  await page.locator(`[data-steer-follow-up="${clientMessageId}"]`).click();
  await page.waitForFunction(id => {
    const row = [...document.querySelectorAll("#queued-followups .queued-followup")]
      .find(item => item.dataset.clientMessageId === id);
    return row?.dataset.queueKind === "steering";
  }, clientMessageId, { timeout: 10_000 });
}

async function deleteQueuedMessage(page, clientMessageId) {
  const row = page.locator(`#queued-followups .queued-followup[data-client-message-id="${clientMessageId}"]`);
  await row.locator(".queued-followup-delete").click();
  await row.waitFor({ state: "detached", timeout: 10_000 });
}

function visibleQueueRows(page) {
  return page.evaluate(() => (
    [...document.querySelectorAll("#queued-followups .queued-followup")].map(row => ({
      id: row.dataset.clientMessageId || "",
      kind: row.dataset.queueKind || "",
      text: row.querySelector(".queued-followup-text")?.textContent?.trim() || "",
    }))
  ));
}

async function waitForRuntimeQueues(page, sessionId, { steerings = [], followUps = [] }, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let runtime = null;
  while (Date.now() < deadline) {
    runtime = await readRuntime(page, sessionId);
    const steeringIds = (runtime?.pendingSteeringMessages || []).map(item => item.clientMessageId);
    const followUpIds = (runtime?.pendingFollowUpMessages || []).map(item => item.clientMessageId);
    if (
      JSON.stringify(steeringIds) === JSON.stringify(steerings)
      && JSON.stringify(followUpIds) === JSON.stringify(followUps)
    ) return runtime;
    await page.waitForTimeout(25);
  }
  assert.fail(`timed out waiting for runtime queues: ${JSON.stringify({
    sessionId,
    expected: { steerings, followUps },
    actual: {
      steerings: (runtime?.pendingSteeringMessages || []).map(item => item.clientMessageId),
      followUps: (runtime?.pendingFollowUpMessages || []).map(item => item.clientMessageId),
    },
  })}`);
}

function assertRuntimeQueuesEmpty(runtime) {
  assert.ok(runtime, "session runtime must be persisted");
  assert.deepEqual(runtime.pendingSteeringMessages || [], []);
  assert.deepEqual(runtime.pendingFollowUpMessages || [], []);
}

function sessionEvents(page, sessionId, after = 0) {
  return page.evaluate(({ sessionId, after }) => (
    window.__qzBackgroundE2E.events().slice(after).filter(event => event?.sessionId === sessionId)
  ), { sessionId, after });
}

function assertGaplessSteeringHandoff(events, clientMessageIds) {
  const acceptedIds = events
    .filter(event => event.type === "message_start")
    .map(event => event.clientMessageId || event.message?.clientMessageId || "")
    .filter(id => clientMessageIds.includes(id));
  assert.deepEqual(acceptedIds, clientMessageIds, "steering messages must enter the transcript once and in FIFO order");
  const firstAcceptedIndex = events.findIndex(event => (
    event.type === "message_start"
    && (event.clientMessageId || event.message?.clientMessageId) === clientMessageIds[0]
  ));
  let dequeueIndex = -1;
  for (let index = 0; index < firstAcceptedIndex; index += 1) {
    const event = events[index];
    if (
      event.type === "queue_update"
      && event.pendingSteerings?.length === 0
      && event.pendingFollowUps?.length === 0
    ) dequeueIndex = index;
  }
  assert.notEqual(dequeueIndex, -1, "steering handoff must publish the empty queue state");
  assert.equal(
    firstAcceptedIndex,
    dequeueIndex + 1,
    "the first transcript message must immediately follow batch dequeue without a visible gap",
  );
}

async function observeSteeringBatchMotion(page) {
  await page.waitForFunction(() => (
    document.querySelectorAll(".queued-followup-exit-ghost, .queued-followup-batch-exit-ghost").length === 0
  ), null, { timeout: 10_000 });
  await page.evaluate(() => {
    window.__qzSteeringBatchObserver?.disconnect?.();
    const state = {
      maxBatchGhostCount: 0,
      maxBatchRowCount: 0,
      maxIndividualGhostCount: 0,
      batchSizes: [],
    };
    const scan = () => {
      const batchGhosts = [...document.querySelectorAll(".queued-followup-batch-exit-ghost")];
      const individualGhosts = document.querySelectorAll(".queued-followup-exit-ghost");
      state.maxBatchGhostCount = Math.max(state.maxBatchGhostCount, batchGhosts.length);
      state.maxBatchRowCount = Math.max(
        state.maxBatchRowCount,
        ...batchGhosts.map(ghost => ghost.querySelectorAll(".queued-followup-batch-exit-row").length),
      );
      state.maxIndividualGhostCount = Math.max(state.maxIndividualGhostCount, individualGhosts.length);
      for (const ghost of batchGhosts) {
        if (ghost.dataset.batchSize && !state.batchSizes.includes(ghost.dataset.batchSize)) {
          state.batchSizes.push(ghost.dataset.batchSize);
        }
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.__qzSteeringBatchMotion = state;
    window.__qzSteeringBatchObserver = observer;
    scan();
  });
}

async function finishSteeringBatchMotion(page) {
  return page.evaluate(() => {
    window.__qzSteeringBatchObserver?.disconnect?.();
    window.__qzSteeringBatchObserver = null;
    const state = window.__qzSteeringBatchMotion || {
      maxBatchGhostCount: 0,
      maxBatchRowCount: 0,
      maxIndividualGhostCount: 0,
      batchSizes: [],
    };
    window.__qzSteeringBatchMotion = null;
    return state;
  });
}

async function installHarness(page) {
  await page.evaluate(() => {
    const events = [];
    const waiters = new Set();
    let sequence = 0;
    const port = chrome.runtime.connect({ name: "sidepanel" });
    const matches = (message, expected) => Object.entries(expected || {}).every(([key, value]) => message?.[key] === value);
    port.onMessage.addListener(message => {
      if (message?.type === "dynamic_context_request") {
        port.postMessage({ type: "dynamic_context_response", requestId: message.requestId, context: {} });
      }
      events.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.after > events.length - 1 || !waiter.predicate(message)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    const wait = (expected, after = 0, timeoutMs = 20_000, predicate = null) => {
      const test = predicate || (message => matches(message, expected));
      const existing = events.slice(after).find(test);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          after,
          predicate: test,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for ${JSON.stringify(expected)}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    };
    window.__qzBackgroundE2E = {
      send(type, payload = {}) { port.postMessage({ type, ...payload }); },
      wait,
      count: () => events.length,
      events: () => events.slice(),
      matchingCount: (expected, after = 0) => events.slice(after).filter(message => matches(message, expected)).length,
      async request(type, payload, responseType, timeoutMs = 20_000) {
        const requestId = `e2e_${Date.now().toString(36)}_${++sequence}`;
        const after = events.length;
        port.postMessage({ type, ...payload, requestId });
        return wait({}, after, timeoutMs, message => message?.requestId === requestId && [responseType, "error", "request_failed", "transport_error"].includes(message.type));
      },
    };
  });
}

async function request(page, type, payload, responseType, timeoutMs = 20_000) {
  const result = await page.evaluate(({ type, payload, responseType, timeoutMs }) => (
    window.__qzBackgroundE2E.request(type, payload, responseType, timeoutMs)
  ), { type, payload, responseType, timeoutMs });
  if (["error", "request_failed", "transport_error"].includes(result.type)) throw Object.assign(new Error(result.message), { code: result.code, details: result.details });
  return result;
}

function send(page, type, payload = {}) {
  return page.evaluate(({ type, payload }) => window.__qzBackgroundE2E.send(type, payload), { type, payload });
}

function waitEvent(page, expected, after = 0, timeoutMs = 20_000) {
  return page.evaluate(({ expected, after, timeoutMs }) => window.__qzBackgroundE2E.wait(expected, after, timeoutMs), {
    expected, after, timeoutMs,
  });
}

function eventCount(page) {
  return page.evaluate(() => window.__qzBackgroundE2E.count());
}

function matchingEventCount(page, expected, after = 0) {
  return page.evaluate(({ expected, after }) => window.__qzBackgroundE2E.matchingCount(expected, after), { expected, after });
}

function waitForQueueCount(page, sessionId, count, after = 0, timeoutMs = 20_000) {
  return page.evaluate(({ sessionId, count, after, timeoutMs }) => (
    window.__qzBackgroundE2E.wait({}, after, timeoutMs, message => (
      message?.type === "queue_update"
      && message?.sessionId === sessionId
      && message?.pendingFollowUpMessages?.length === count
    ))
  ), { sessionId, count, after, timeoutMs });
}

async function waitForAgentEndCount(page, sessionId, after, count, timeoutMs) {
  await page.waitForFunction(({ sessionId, after, count }) => (
    window.__qzBackgroundE2E.events()
      .slice(after)
      .filter(message => message?.type === "agent_end" && message?.sessionId === sessionId)
      .length >= count
  ), { sessionId, after, count }, { timeout: timeoutMs });
  return page.evaluate(({ sessionId, after }) => (
    window.__qzBackgroundE2E.events()
      .slice(after)
      .filter(message => message?.type === "agent_end" && message?.sessionId === sessionId)
  ), { sessionId, after });
}

async function createProviderServer() {
  const requests = [];
  const mcpRequests = [];
  const markerCounts = new Map();
  const gateWaiters = new Map();
  const releasedGates = new Set();
  const screenActionFixture = readFileSync(join(root, "tests/fixtures/screen-action-runtime.html"), "utf8");
  const screenActionResultFixture = readFileSync(join(root, "tests/fixtures/screen-action-runtime-result.html"), "utf8");
  const waitForRelease = marker => {
    if (releasedGates.delete(marker)) return Promise.resolve();
    return new Promise(resolvePromise => gateWaiters.set(marker, resolvePromise));
  };
  const release = marker => {
    const resolvePromise = gateWaiters.get(marker);
    if (!resolvePromise) {
      releasedGates.add(marker);
      return;
    }
    gateWaiters.delete(marker);
    resolvePromise();
  };
  const server = createServer(async (req, res) => {
    const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && requestPath === "/selection-image.svg") {
      const portrait = new URL(req.url, "http://127.0.0.1").searchParams.get("portrait") === "1";
      const [width, height] = portrait ? [40, 80] : [80, 40];
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#d8d6d1"/><circle cx="${width / 2}" cy="${height / 2}" r="12" fill="#55534f"/></svg>`);
      return;
    }
    if (requestPath === "/mcp-output-schema") {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      const rpc = await readJsonBody(req);
      mcpRequests.push(rpc.method);
      if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      let result;
      if (rpc.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "schema-fixture", version: "1" } };
      } else if (rpc.method === "tools/list") {
        result = { tools: [{ name: "count", inputSchema: { type: "object", properties: { invalid: { type: "boolean" } } },
          outputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }] };
      } else if (rpc.method === "tools/call") {
        if (rpc.params.arguments.invalid && mcpRequests.filter(method => method === "tools/call").length === 2) {
          res.writeHead(404); res.end("Session not found"); return;
        }
        const structuredContent = { count: rpc.params.arguments.invalid ? "invalid" : 1 };
        result = { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
      } else { res.writeHead(404); res.end(); return; }
      res.setHeader("mcp-session-id", "schema-fixture-session");
      sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
      return;
    }
    if (req.method === "GET" && requestPath === "/screen-action-target") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(screenActionFixture);
      return;
    }
    if (req.method === "GET" && requestPath === "/screen-action-runtime-result.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(screenActionResultFixture);
      return;
    }
    if (req.method === "GET" && requestPath.startsWith("/uid-batch/")) {
      const variant = requestPath.split("/").pop() || "x";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>UID batch fixture ${variant}</title></head><body>`
        + `<h1>UID batch fixture ${variant}</h1>`
        + [1, 2].map(n => `<img id="img-${n}" src="/selection-image.svg?variant=${variant}&amp;n=${n}" width="80" height="40" alt="fixture ${variant} ${n}">`).join("")
        + `</body></html>`);
      return;
    }
    const body = await readJsonBody(req);
    const marker = isTitleGenerationRequest(body) ? "title" : detectMarker(body);
    const count = (markerCounts.get(marker) || 0) + 1;
    markerCounts.set(marker, count);
    const settledInterruptedTurn = hasSettledInterruptedTurn(body);
    requests.push({
      marker,
      count,
      stream: body.stream === true,
      settledInterruptedTurn,
      userTexts: userMessageTexts(body),
      imageCount: latestUserImageCount(body),
      ...imageProjectionStats(body.messages),
      documentCapsuleCount: documentCapsuleCount(body),
      containsDisplayProjection: JSON.stringify(body?.messages || []).includes("imageWithAction"),
      ...(marker === "QZ_E2E_RESET_NEW" ? { containsResetHistory: JSON.stringify(body.messages).includes("QZ_E2E_RESET_OLD") } : {}),
      ...(marker.startsWith("QZ_E2E_SELECTION_") ? {
        selectionResult: selectionToolResult(body),
        selectionContainsUnselected: JSON.stringify(body.messages).includes("northstar-backend"),
      } : {}),
      ...(marker === "QZ_E2E_TABUIDS" ? { uidBatch: uidBatchTargets(body) } : {}),
    });

    if (marker.startsWith("QZ_E2E_FAULT_")) {
      const fault = marker.split("_")[3];
      if (fault !== "HTTP") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify(streamChunk("QZ partial output before injected failure", true))}\n\n`);
      }
      // The recovery attempt must receive the fault too, without a second gate.
      if (count === 1) await waitForRelease(marker);
      if (res.destroyed) return;
      if (fault === "HTTP") sendJson(res, 401, { error: { message: "QZ gated auth failure" } });
      else if (fault === "SOCKET") res.destroy();
      else if (fault === "SSE") res.end(`data: ${JSON.stringify({ error: { message: "QZ gated stream failure", type: "invalid_request_error", code: "invalid_request_error" } })}\n\n`);
      else res.end(); // Clean transport EOF without the protocol's finish marker.
      return;
    }
    if (marker === "QZ_E2E_HTTP_ERROR") {
      sendJson(res, 401, { error: { message: "QZ injected auth failure" } });
      return;
    }
    if (marker === "QZ_E2E_UNSUPPORTED_IMAGE") {
      const content = `data: ${JSON.stringify({ error: {
        code: "invalid_parameter_error",
        type: "invalid_request_error",
        message: "The provided messages input is invalid. The error info is [Unexpected item type in content.].",
      } })}`;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "error_finish" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (marker === "QZ_E2E_RETRY" && count === 1) {
      sendJson(res, 503, { error: { message: "QZ injected overloaded" } });
      return;
    }
    if (marker === "QZ_E2E_WORKER_COMPACT") {
      await waitForRelease(marker);
      if (res.destroyed) return;
    }
    if (body.stream !== true) {
      sendJson(res, 200, completion("QZ validation OK"));
      return;
    }

    if (marker === "QZ_E2E_WORKER_IMAGES" && count <= 10) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      if (count > 1) {
        const thinking = streamChunk("", true);
        thinking.choices[0].delta.reasoning_content = `QZ_SCREEN_THINK_${count - 1}: retain the complete reasoning for screenshot ${count - 1}.`;
        res.write(`data: ${JSON.stringify(thinking)}\n\n`);
        res.write(`data: ${JSON.stringify(streamChunk(`QZ_SCREENSHOT_${count - 1}`, false))}\n\n`);
      }
      const call = count === 1
        ? streamToolCall("call_worker_images_open", "open_tab", JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/screen-action-target` }))
        : streamToolCall(`call_worker_image_${count - 1}`, "screenshot", "{}");
      res.write(`data: ${JSON.stringify(call)}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (marker === "QZ_E2E_WORKER_CHECKPOINT") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      if (count === 1) {
        res.write(`data: ${JSON.stringify(streamChunk("QZ_CHECKPOINT_COMPLETED_BEFORE_RESTART", true))}\n\n`);
        res.write(`data: ${JSON.stringify(streamToolCall("call_worker_checkpoint_tabs", "list_tabs", "{}"))}\n\n`);
        res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.write(`data: ${JSON.stringify(streamChunk("QZ_CHECKPOINT_IN_PROGRESS", true))}\n\n`);
        await waitForRelease(marker);
        if (!res.destroyed) res.end();
      }
      return;
    }

    if (marker === "QZ_E2E_TABUIDS" && count <= 3) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      // Alias bindings only live inside one batch, so later batches address tabs by id.
      const results = uidBatchToolResults(body);
      const calls = count === 1
        ? ["a", "b", "c"].map(variant => [`uid_batch_open_${variant}`, "open_tab", JSON.stringify({ url: `${base}/uid-batch/${variant}`, tabAlias: variant })])
        : count === 2
          ? ["a", "b", "c"].map(variant => [`uid_batch_list_${variant}`, "list_images", JSON.stringify({ tabId: results[`open_${variant}`]?.id })])
          : ["a", "b", "c"].map(variant => [`uid_batch_collect_${variant}`, "collect_images", JSON.stringify({
            table: "uid_batch_e2e",
            targets: uidBatchTargets(body)[variant]?.targets || [],
          })]);
      if (count === 3) {
        const targets = uidBatchTargets(body);
        calls.push(["uid_batch_collect_a_again", "collect_images", JSON.stringify({
          table: "uid_batch_e2e", targets: targets.a?.targets?.slice(0, 1) || [],
        })]);
        calls.push(["uid_batch_collect_mixed", "collect_images", JSON.stringify({
          table: "uid_batch_e2e", targets: [targets.a?.targets?.[0], targets.b?.targets?.[0]],
        })]);
        calls.push(["uid_batch_collect_css", "collect_images", JSON.stringify({
          table: "uid_batch_e2e", targets: ["css:#img-2", targets.a?.targets?.[0]],
        })]);
        // The scenario renames one document and navigates another before these calls stream.
        await waitForRelease("QZ_E2E_TABUIDS_COLLECT");
        if (res.destroyed) return;
      }
      for (const [index, [toolCallId, name, args]] of calls.entries()) {
        res.write(`data: ${JSON.stringify(streamToolCallAt(index, toolCallId, name, args))}\n\n`);
      }
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (marker === "QZ_E2E_LOCATION" && count <= 2) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(streamToolCall(`location_${count}`, "get_location", "{}"))}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (marker.startsWith("QZ_E2E_SELECTION_") && count <= 2) {
      const [toolCallId, name, args] = count === 1
        ? ["selection_load", "load_skill", { name: "result-selection-example" }]
        : ["selection_choose", "result_selection_example__choose", { timeout: 10 }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(streamToolCall(toolCallId, name, JSON.stringify(args)))}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (marker === "QZ_E2E_MCP_OUTPUT_SCHEMA" && count <= 5) {
      const serverArgs = { url: `http://127.0.0.1:${server.address().port}/mcp-output-schema`, name: "schema-fixture", timeout: 10 };
      const steps = [
        ["mcp_schema_load", "load_skill", { name: "qingzhou-mcp" }],
        ["mcp_schema_inspect", getMcpSkillToolName("mcp_inspect_server"), { ...serverArgs, refresh: true }],
        ["mcp_schema_valid", getMcpSkillToolName("mcp_call_tool"), { ...serverArgs, tool: "count", args: {} }],
        ["mcp_schema_invalid", getMcpSkillToolName("mcp_call_tool"), { ...serverArgs, tool: "count", args: { invalid: true } }],
        ["mcp_schema_recovered", getMcpSkillToolName("mcp_call_tool"), { ...serverArgs, tool: "count", args: {} }],
      ];
      const [toolCallId, name, args] = steps[count - 1];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(streamToolCall(toolCallId, name, JSON.stringify(args)))}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (marker === "QZ_E2E_MANAGED_CHILD") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      await waitForRelease(marker);
      if (!res.destroyed) res.end("data: [DONE]\n\n");
      return;
    }
    if (marker === "QZ_E2E_MANAGE" && count % 2 === 1) {
      const text = userMessageTexts(body).findLast(value => value.startsWith("QZ_E2E_MANAGE "));
      const args = text.slice("QZ_E2E_MANAGE ".length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(streamToolCall(`manage_${count}`, "manage_sessions", args))}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (marker === "QZ_E2E_STEER_ACTIVE" && count === 1) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(streamToolCall("call_steering_list_tabs", "list_tabs", "{}"))}\n\n`);
      await sleep(1200);
      if (res.destroyed || req.aborted) return;
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (["QZ_E2E_STEER_SINGLE_ACTIVE", "QZ_E2E_STEER_MULTI_ACTIVE"].includes(marker) && count === 1) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const suffix = marker === "QZ_E2E_STEER_SINGLE_ACTIVE" ? "single" : "multi";
      res.write(`data: ${JSON.stringify(streamToolCall(`call_steering_matrix_${suffix}`, "list_tabs", "{}"))}\n\n`);
      await waitForRelease(marker);
      if (res.destroyed || req.aborted) return;
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (marker === "QZ_E2E_DELETE_RUNNING_AUTOMATION" && count === 1) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      await waitForRelease(marker);
      if (res.destroyed || req.aborted) return;
      res.write(`data: ${JSON.stringify(streamDone())}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (marker === "QZ_E2E_SCREEN_ACTION" && count <= 10) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const call = count === 1
        ? streamToolCall("call_screen_open", "open_tab", JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/screen-action-target` }))
        : count === 2
          ? streamToolCall("call_screen_capture", "screenshot", JSON.stringify({ actionable: true }))
          : count > 3
            ? streamToolCall(`call_screen_observation_${count}`, "screenshot", "{}")
          : streamToolCall("call_screen_macro", "run_script", JSON.stringify({
            timeout: 30,
            mutatesPage: true,
            code: `async () => {
  // Run page actions sequentially in a fixed layout, then capture the result for the model.
  const dpr = window.devicePixelRatio || 1;
  const point = selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return {
      x: (rect.left + rect.width / 2) * dpr,
      y: (rect.top + rect.height / 2) * dpr,
    };
  };
  const actionResults = [];
  await tools.screenshot({});
  const perform = async (action, args = {}) => {
    const result = await tools.act_on_screen({
      action,
      returnScreenshot: false,
      ...args,
    });
    if (result.feedbackAvailable !== false || result.coordinateBasisReady !== true) {
      throw new Error(action + " broke stable visual coordinate continuation");
    }
    if (result.viewportChange?.scrolled !== false || result.viewportChange?.resized !== false) {
      throw new Error(action + " unexpectedly changed the browser viewport");
    }
    actionResults.push({
      action: result.action,
      coordinateBound: Number.isFinite(args.x) && Number.isFinite(args.y),
      sourceScreenshotId: result.sourceScreenshotId,
      marker: result.marker,
      durationMs: result.durationMs,
      repeat: result.repeat,
      viewportChange: result.viewportChange,
      feedbackAvailable: result.feedbackAvailable,
      coordinateBasisReady: result.coordinateBasisReady,
    });
    return result;
  };

  await perform("click", point("#click-target"));
  await perform("double_click", point("#double-click-target"));
  await perform("hover", point("#hover-target"));
  await perform("long_press", { ...point("#long-press-target"), durationMs: 300 });
  await perform("type", { ...point("#text-target"), text: "扩展替换值", replace: true });
  const primaryModifier = /Mac/i.test(navigator.platform) ? "Meta" : "Control";
  await perform("press", { key: primaryModifier + "+A" });
  await perform("type", { text: "扩展最终值", replace: false });
  await perform("press", { key: "Enter" });
  await perform("scroll", { ...point("#wheel-target"), deltaX: 10, deltaY: 120, repeat: 3 });
  const dragStart = point("#drag-source");
  const dragEnd = point("#drop-target");
  await perform("drag", {
    x: dragStart.x,
    y: dragStart.y,
    endX: dragEnd.x,
    endY: dragEnd.y,
  });

  const state = window.__readScreenActionState();
  if (state.clickCount !== 1
    || state.doubleClickClicks !== 2
    || state.doubleClickCount !== 1
    || state.hoverEnterCount < 1
    || state.hoverMoveCount < 1
    || state.longPressActive !== false
    || state.longPressMs < 260
    || state.inputValue !== "扩展最终值"
    || state.keyEvents.at(-1)?.key !== "Enter"
    || state.wheelEvents !== 3
    || state.trustedWheelEvents !== 3
    || state.wheelDeltaX !== 30
    || state.wheelDeltaY !== 360
    || state.scrollY !== 0
    || state.dragStarted !== true
    // Chrome can coalesce the eight dispatched steps into fewer DOM moves.
    || state.dragMoves < 1
    || state.dragReleased !== true
    || state.dropped !== true) {
    throw new Error("screen action HTML state did not match the expected sequence: " + JSON.stringify(state));
  }
  await tools.screenshot({});
  return {
    ok: true,
    filled: actionResults.length,
    batch: {
      actions: actionResults,
      state,
    },
  };
}`,
          }));
      res.write(`data: ${JSON.stringify(call)}\n\n`);
      res.write(`data: ${JSON.stringify(streamToolCallsDone())}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const output = outputForMarker(marker);
    const delayMs = [
      "QZ_E2E_STOP",
      "QZ_QUEUE_ACTIVE",
      "QZ_E2E_RECONNECT",
      "QZ_E2E_PARALLEL_A",
      "QZ_E2E_PARALLEL_B",
      "QZ_E2E_WORKER_OLD",
    ].includes(marker) ? 90 : 0;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunks = splitOutput(output, delayMs ? 8 : 2);
    for (let index = 0; index < chunks.length; index += 1) {
      if (res.destroyed || req.aborted) return;
      res.write(`data: ${JSON.stringify(streamChunk(chunks[index], index === 0))}\n\n`);
      if (delayMs) await sleep(delayMs);
    }
    if (res.destroyed || req.aborted) return;
    res.write(`data: ${JSON.stringify(streamDone())}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    selectionImageUrl: `http://127.0.0.1:${address.port}/selection-image.svg`,
    screenActionUrl: `http://127.0.0.1:${address.port}/screen-action-target`,
    requests,
    mcpRequests,
    count: marker => markerCounts.get(marker) || 0,
    release,
    close: () => {
      for (const resolvePromise of gateWaiters.values()) resolvePromise();
      gateWaiters.clear();
      releasedGates.clear();
      return new Promise(resolvePromise => server.close(() => resolvePromise()));
    },
  };
}

async function createGitRepositoryServer() {
  const skill = normalizeModernSkill({
    name: "git-auth-e2e-skill",
    description: "Private repository authenticated archive fixture",
    content: "# Git authenticated archive fixture\n\nLoaded from the repository Zip.",
    scope: "global",
    metadata: {
      qingzhou: {
        origin: { type: "local-draft", note: "legacy publish metadata" },
      },
    },
  });
  const zip = await createZip([{
    path: "private-skill-repository-main/skills/git-auth-e2e-skill/SKILL.md",
    content: skillToSkillMarkdown(skill),
  }, {
    path: "private-skill-repository-main/examples/git-auth-outside-skill/SKILL.md",
    content: skillToSkillMarkdown(normalizeModernSkill({
      name: "git-auth-outside-skill",
      description: "Out-of-scope repository Skill fixture",
      content: "# Must not be imported",
      scope: "global",
    })),
  }]);
  const zipBytes = Buffer.from(await zip.arrayBuffer());
  let archiveRequests = 0;
  let authenticatedArchiveRequests = 0;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address()?.port || 80}`;
    const url = new URL(req.url || "/", base);
    if (url.pathname === "/group/private-skill-repository" || url.pathname === "/group/private-skill-repository/tree/main/skills") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "qz_git_auth=1; Path=/; SameSite=Lax",
      });
      res.end(`<!doctype html><html><head><meta name="project:default_branch" content="main"><title>private-skill-repository</title></head><body data-project-id="77"><a href="/group/private-skill-repository/commit/${"a".repeat(40)}">commit</a></body></html>`);
      return;
    }
    if (url.pathname === "/api/v3/projects/77/repository/archive.zip") {
      archiveRequests += 1;
      const authenticated = /(?:^|;\s*)qz_git_auth=1(?:;|$)/u.test(String(req.headers.cookie || ""));
      if (!authenticated) {
        sendJson(res, 401, { error: "authentication required" });
        return;
      }
      authenticatedArchiveRequests += 1;
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(zipBytes.byteLength),
        "cache-control": "no-store",
      });
      res.end(zipBytes);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = server.address().port;
  const rootUrl = `http://127.0.0.1:${port}/group/private-skill-repository`;
  return {
    rootUrl,
    repositoryUrl: `${rootUrl}/tree/main/skills`,
    get archiveRequests() { return archiveRequests; },
    get authenticatedArchiveRequests() { return authenticatedArchiveRequests; },
    close: () => new Promise(resolvePromise => server.close(() => resolvePromise())),
  };
}

function outputForMarker(marker) {
  return {
    QZ_E2E_BASIC: "QZ_E2E_BASIC_OK",
    QZ_E2E_RESET_OLD: "QZ_E2E_RESET_OLD_OK",
    QZ_E2E_RESET_NEW: "QZ_E2E_RESET_NEW_OK",
    QZ_E2E_UI: "QZ_E2E_UI_OK",
    QZ_E2E_ATTACHMENT_HISTORY_SEED: "QZ_E2E_ATTACHMENT_HISTORY_SEED_OK",
    QZ_E2E_ATTACHMENT_HISTORY: "QZ_E2E_ATTACHMENT_HISTORY_OK",
    QZ_E2E_ATTACHMENT_NEW: "QZ_E2E_ATTACHMENT_NEW_OK",
    QZ_E2E_AUTOMATION: "QZ_E2E_AUTOMATION_OK",
    QZ_E2E_DELETE_RUNNING_AUTOMATION: "QZ_E2E_DELETE_RUNNING_AUTOMATION_OK",
    QZ_E2E_SCREEN_ACTION: "QZ_E2E_SCREEN_ACTION_OK",
    QZ_E2E_MCP_OUTPUT_SCHEMA: "QZ_E2E_MCP_OUTPUT_SCHEMA_OK",
    QZ_E2E_SELECTION_PICK: "QZ_E2E_SELECTION_PICK_OK",
    QZ_E2E_SELECTION_CANCEL: "QZ_E2E_SELECTION_CANCEL_OK",
    QZ_E2E_RETRY: "QZ_E2E_RETRY_OK",
    QZ_E2E_STEER_TWO: "QZ_E2E_STEER_OK",
    QZ_E2E_STEER_SINGLE_MESSAGE: "QZ_E2E_STEER_SINGLE_OK",
    QZ_E2E_STEER_MULTI_THREE: "QZ_E2E_STEER_MULTI_OK",
    QZ_E2E_RECOVER: "QZ_E2E_RECOVER_OK",
    QZ_E2E_STOP: "QZ_E2E_STOP_SHOULD_BE_CUT_OFF_AFTER_THE_FIRST_CHUNK",
    QZ_QUEUE_ACTIVE: "QZ_QUEUE_ACTIVE_STREAM_MUST_STAY_OPEN_LONG_ENOUGH_TO_QUEUE",
    QZ_QUEUE_NEXT: "QZ_QUEUE_NEXT_OK",
    QZ_E2E_AFTER_ABORT_1: "QZ_E2E_AFTER_ABORT_1_OK",
    QZ_E2E_AFTER_ABORT_2: "QZ_E2E_AFTER_ABORT_2_OK",
    QZ_E2E_PARALLEL_A: "QZ_E2E_PARALLEL_A_OK",
    QZ_E2E_PARALLEL_B: "QZ_E2E_PARALLEL_B_OK",
    QZ_E2E_RECONNECT: "QZ_E2E_RECONNECT_OK",
    QZ_E2E_WORKER_OLD: "QZ_E2E_WORKER_OLD_STREAM_MUST_BE_INTERRUPTED",
    QZ_E2E_WORKER_NEW: "QZ_E2E_WORKER_NEW_OK",
    QZ_E2E_WORKER_IMAGES: "QZ_E2E_WORKER_IMAGES_OK",
    QZ_E2E_TABUIDS: "QZ_E2E_TABUIDS_OK",
  }[marker] || "QZ_DEFAULT_OK";
}

function detectMarker(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const markers = ["QZ_E2E_LOCATION", "QZ_E2E_SELECTION_PICK", "QZ_E2E_SELECTION_CANCEL",
    "QZ_E2E_RESET_OLD", "QZ_E2E_RESET_NEW",
    "QZ_E2E_MANAGED_CHILD", "QZ_E2E_MANAGE", "QZ_E2E_HTTP_ERROR", "QZ_E2E_UNSUPPORTED_IMAGE", "QZ_E2E_RETRY", "QZ_E2E_BASIC", "QZ_E2E_UI",
    "QZ_E2E_ATTACHMENT_HISTORY_SEED", "QZ_E2E_ATTACHMENT_HISTORY", "QZ_E2E_ATTACHMENT_NEW",
    "QZ_E2E_AUTOMATION", "QZ_E2E_DELETE_RUNNING_AUTOMATION", "QZ_E2E_SCREEN_ACTION", "QZ_E2E_MCP_OUTPUT_SCHEMA", "QZ_E2E_RECOVER",
    "QZ_E2E_STEER_ACTIVE", "QZ_E2E_STEER_ONE", "QZ_E2E_STEER_TWO",
    "QZ_E2E_STEER_SINGLE_ACTIVE", "QZ_E2E_STEER_SINGLE_MESSAGE",
    "QZ_E2E_STEER_MULTI_ACTIVE", "QZ_E2E_STEER_MULTI_ONE", "QZ_E2E_STEER_MULTI_THREE",
    "QZ_E2E_STEER_MULTI_DELETE_STEERING", "QZ_E2E_STEER_MULTI_DELETE_FOLLOWUP",
    "QZ_E2E_STOP", "QZ_E2E_AFTER_ABORT_1", "QZ_E2E_AFTER_ABORT_2", "QZ_QUEUE_ACTIVE", "QZ_QUEUE_NEXT",
    "QZ_E2E_PARALLEL_A", "QZ_E2E_PARALLEL_B", "QZ_E2E_RECONNECT",
    "QZ_E2E_WORKER_OLD", "QZ_E2E_WORKER_NEW", "QZ_E2E_WORKER_CHECKPOINT", "QZ_E2E_WORKER_IMAGES", "QZ_E2E_WORKER_COMPACT",
    "QZ_E2E_TABUIDS",
  ];
  for (const message of [...messages].reverse()) {
    if (message?.role !== "user") continue;
    const text = JSON.stringify(message.content ?? "");
    const faultMarker = text.match(/QZ_E2E_FAULT_[A-Z_]+/u)?.[0];
    if (faultMarker) return faultMarker;
    const marker = markers.find(candidate => text.includes(candidate));
    if (marker) return marker;
  }
  const fallbackText = JSON.stringify(body?.input ?? body ?? {});
  return markers.find(marker => fallbackText.includes(marker)) || "validation";
}

function selectionToolResult(body) {
  const message = (body.messages || []).find(item => item.role === "tool" && item.tool_call_id === "selection_choose");
  if (!message) return null;
  try { return JSON.parse(messageText(message)); } catch { return null; }
}

function isTitleGenerationRequest(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some(message => (
    message?.role === "system"
    && String(message.content || "").includes("会话标题生成器")
  ));
}

function hasSettledInterruptedTurn(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const oldIndex = messages.findIndex(message => JSON.stringify(message?.content || "").includes("QZ_E2E_WORKER_OLD"));
  const newIndex = messages.findIndex(message => JSON.stringify(message?.content || "").includes("QZ_E2E_WORKER_NEW"));
  if (oldIndex < 0 || newIndex <= oldIndex) return false;
  return messages.slice(oldIndex + 1, newIndex).some(message => (
    message?.role === "assistant" && String(message?.content || "").includes("上一轮运行中断")
  ));
}

function completion(content) {
  return { id: id("completion"), object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

function streamChunk(content, first) {
  return { id: id("chunk"), object: "chat.completion.chunk", choices: [{ index: 0, delta: { ...(first ? { role: "assistant" } : {}), content }, finish_reason: null }] };
}

function streamDone() {
  return { id: id("done"), object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

function streamToolCall(toolCallId, name, args) {
  return streamToolCallAt(0, toolCallId, name, args);
}

function streamToolCallAt(toolIndex, toolCallId, name, args) {
  return {
    id: id("tool-call"),
    object: "chat.completion.chunk",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: toolIndex,
          id: toolCallId,
          type: "function",
          function: { name, arguments: args },
        }],
      },
      finish_reason: null,
    }],
  };
}

function uidBatchToolResults(body) {
  const results = {};
  for (const message of body?.messages || []) {
    if (message?.role !== "tool") continue;
    const match = /^uid_batch_(open|list)_([abc])$/u.exec(String(message.tool_call_id || ""));
    if (!match || results[`${match[1]}_${match[2]}`]) continue;
    try {
      results[`${match[1]}_${match[2]}`] = JSON.parse(messageText(message));
    } catch { /* a malformed result fails the scenario assertions instead of the server */ }
  }
  return results;
}

function uidBatchTargets(body) {
  const results = uidBatchToolResults(body);
  const byVariant = {};
  for (const variant of ["a", "b", "c"]) {
    const listed = results[`list_${variant}`];
    if (!listed) continue;
    byVariant[variant] = {
      tabId: listed.tabId,
      targets: (Array.isArray(listed.images) ? listed.images : [])
        .map(image => String(image?.target || ""))
        .filter(target => target.startsWith("uid:")),
    };
  }
  return byVariant;
}

function streamToolCallsDone() {
  return {
    id: id("tool-done"),
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
}

function userMessageTexts(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter(message => message?.role === "user")
    .map(message => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .filter(part => part?.type === "text")
        .map(part => String(part.text || ""))
        .join("\n");
    })
    .filter(Boolean);
}

function latestUserImageCount(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const latest = [...messages].reverse().find(message => message?.role === "user");
  return Array.isArray(latest?.content)
    ? latest.content.filter(part => part?.type === "image_url").length
    : 0;
}

function imageProjectionStats(messages) {
  let imageMessageCount = 0, totalImageCount = 0, imagePlaceholderCount = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const images = parts.filter(part => part?.type === "image_url").length;
    if (images) imageMessageCount += 1;
    totalImageCount += images;
    imagePlaceholderCount += parts.filter(part => (
      part?.type === "text" && String(part.text || "").includes("[image omitted for context saving]")
    )).length;
  }
  return { imageMessageCount, totalImageCount, imagePlaceholderCount };
}

function documentCapsuleCount(body = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.filter(message => (
    message?.role === "user"
    && String(message.content || "").startsWith("[文档附件 capsule]")
  )).length;
}

function splitOutput(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count));
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function getExtensionId(browserContext, userDataDir) {
  const existing = browserContext.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  if (existing) return new URL(existing.url()).host;
  try {
    const worker = await browserContext.waitForEvent("serviceworker", {
      predicate: item => item.url().startsWith("chrome-extension://"),
      timeout: 5_000,
    });
    return new URL(worker.url()).host;
  } catch (_error) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      for (const candidate of [join(userDataDir, "Default", "Preferences"), join(userDataDir, "Preferences")]) {
        if (!existsSync(candidate)) continue;
        const settings = JSON.parse(readFileSync(candidate, "utf8"))?.extensions?.settings || {};
        const found = Object.entries(settings).find(([, record]) => {
          const path = String(record?.path || record?.manifest?.path || "");
          return path && resolve(path) === resolve(extensionPath);
        });
        if (found?.[0]) return found[0];
      }
      await sleep(250);
    }
    throw new Error("Unable to resolve loaded extension id");
  }
}

function findChromeExecutable(bundled = "") {
  return [
    process.env.CHROME_EXECUTABLE,
    bundled,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find(existsSync) || "";
}

async function terminateExtensionServiceWorker(page, browserContext, extensionId) {
  const cdp = await browserContext.newCDPSession(page);
  try {
    const { targetInfos = [] } = await cdp.send("Target.getTargets");
    const worker = targetInfos.find(target => (
      target.type === "service_worker"
      && target.url === `chrome-extension://${extensionId}/background/service-worker.js`
    ));
    assert.ok(worker?.targetId, "extension service worker target should be discoverable");
    const closed = await cdp.send("Target.closeTarget", { targetId: worker.targetId });
    assert.equal(closed?.success, true);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

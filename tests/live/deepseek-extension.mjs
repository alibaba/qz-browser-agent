import { runSessionManagementCases } from "./session-management-cases.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { skillFromSkillMarkdown } from "../../src/shared/skills/skill-package.js";
import { normalizeModernSkill } from "../../src/shared/skills/skill-utils.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const akFile = String(process.env.QINGZHOU_DEEPSEEK_AK_FILE || "").trim();
const model = String(process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-v4-flash").trim();

const apiKey = readTestApiKey("deepseek", { keyFile: akFile, required: false });
if (!apiKey) {
  console.log("deepseek extension live e2e skipped: set DEEPSEEK_API_KEY in .env.local or QINGZHOU_DEEPSEEK_AK_FILE");
  process.exit(0);
}
const extensionPath = await ensureTestExtension();

const { chromium } = await import("playwright");
const executablePath = findChromeExecutable(chromium.executablePath());
if (!executablePath) throw new Error("Chrome executable not found");

const profile = mkdtempSync(join(tmpdir(), "qingzhou-deepseek-live-"));
let context, page;
const diagnostics = [];
const report = { ok: false, provider: "deepseek", model, scenarios: {} };
let currentCase = "setup";

async function runSelected(name, operation) {
  const selected = String(process.env.QINGZHOU_LIVE_CASES || "").split(",").filter(Boolean);
  if (selected.length && !selected.includes(name)) return { skipped: true };
  currentCase = name;
  const result = await operation();
  report.scenarios[name] = result;
  console.log(`PASS baseline ${name}`);
  return result;
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.QINGZHOU_LIVE_HEADLESS === "1",
    executablePath,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 980, height: 860 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const extensionId = await getExtensionId(context, profile);
  attachWorkerDiagnostics(context, diagnostics, apiKey);
  page = await context.newPage();
  page.on("pageerror", error => diagnostics.push(redact(String(error), apiKey)));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(redact(message.text(), apiKey));
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await acceptDataDisclosure(page);
  await page.waitForFunction(() => {
    const app = document.querySelector("#app");
    return app && !app.hasAttribute("data-workspace-booting") && !app.hasAttribute("data-workspace-boot-fallback");
  });
  await page.waitForSelector("#input", { state: "attached" });
  await installHarness(page);

  await saveDeepSeekConfig(page, apiKey, model);
  if (process.env.QINGZHOU_LIVE_SESSION_MANAGEMENT === "1") {
    currentCase = "sessionManagement";
    const result = await runSessionManagementCases({ extended: process.env.QINGZHOU_LIVE_SESSION_MANAGEMENT_EXTENDED === "1", page, createSession, deleteSession, runPrompt, eventCount, eventsSince, waitEvent, requestWithoutId, send, historyMessages, messageText });
    report.sessionManagement = result;
    console.log(JSON.stringify({ ok: true, provider: "deepseek", model, sessionManagement: result }, null, 2));
  } else {
    report.invalidKey = await runSelected("invalidKey", () => assertInvalidKeyFailureAndRecovery(page, model));
    const basic = await runSelected("basic", () => assertBasicStreaming(page));

    const tool = await runSelected("tool", () => assertToolRoundTrip(page));

    const concurrent = await runSelected("concurrent", () => assertConcurrentSessions(page));

    const duplicateStart = await runSelected("duplicateStart", () => assertDuplicatePromptDoesNotSupersede(page));

    const pendingStop = await runSelected("pendingStop", () => assertPendingStartStop(page));

    const stopped = await runSelected("stopped", () => assertStreamingStop(page));

    const stopRestart = await runSelected("stopRestart", () => assertStopRestartHandoff(page));

    const deleteRunning = await runSelected("deleteRunning", () => assertDeleteRunningSession(page));

    const workerRestart = await runSelected("workerRestart", () => assertServiceWorkerRestart(page, context, extensionId));

    const followUp = await runSelected("followUp", () => assertFollowUpHandoff(page));

    const userWait = await runSelected("userWait", () => assertUserWaitLifecycle(page));

    const skillSelection = String(process.env.QINGZHOU_LIVE_CASES || "").split(",").includes("skillSelection")
      ? await runSelected("skillSelection", () => assertSkillSelection(page)) : { skipped: true };

    const editRerun = await runSelected("editRerun", () => assertEditAndRerun(page));


    const unexpected = diagnostics.filter(message => !isExpectedDiagnostic(message));
    assert.deepEqual(unexpected, [], `extension emitted errors:\n${unexpected.join("\n")}`);
    console.log(JSON.stringify({
      ok: true,
      provider: "deepseek",
      model,
      scenarios: {
        basic,
        tool,
        concurrent,
        duplicateStart,
        pendingStop,
        stopped,
        stopRestart,
        deleteRunning,
        workerRestart,
        followUp,
        userWait,
        skillSelection,
        editRerun,
      },
    }, null, 2));
  }
  report.ok = true;
} catch (error) {
  report.failedCase = currentCase;
  report.error = redact(error?.stack || error?.message || String(error), apiKey);
  report.diagnostics = diagnostics;
  report.recentEvents = await page?.evaluate(() => window.__qzLiveHarness?.eventsSince(0).slice(-80)).catch(() => []);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
  rmSync(profile, { recursive: true, force: true });
  if (process.env.QINGZHOU_LIVE_REPORT) writeFileSync(process.env.QINGZHOU_LIVE_REPORT, redact(JSON.stringify(report, null, 2), apiKey));
}

async function saveDeepSeekConfig(page, key, selectedModel) {
  const result = await request(page, "save_config", {
    config: {
      provider: "deepseek",
      apiKey: key,
      model: selectedModel,
      vision: false,
      contextWindow: 128000,
      trimOldToolResults: true,
      debugMode: false,
    },
  }, "config_saved", 30_000);
  assert.equal(result.config?.provider, "deepseek");
  assert.equal(result.config?.model, selectedModel);
}

async function assertInvalidKeyFailureAndRecovery(page, selectedModel) {
  // SDK catalog providers validate non-empty keys on the real inference request.
  // Missing required configuration must still fail without replacing valid settings.
  const failure = await requestEither(page, "save_config", {
    config: { provider: "deepseek", apiKey: "", model: selectedModel },
  }, ["config_saved", "error", "request_failed", "transport_error"], 30_000);
  assert.ok(["error", "request_failed", "transport_error"].includes(failure.type), "an empty AK must fail before replacing the active config");
  const config = await requestWithoutId(page, "get_config", {}, "config", 10_000);
  assert.equal(config.config?.provider, "deepseek");
  assert.equal(config.config?.model, selectedModel);
  assert.equal(await page.evaluate(async key => (await chrome.storage.local.get("llmConfig")).llmConfig?.apiKey === key, apiKey), true);

  const sessionId = await createSession(page, "DeepSeek invalid credential recovery");
  try {
    await saveDeepSeekConfig(page, "invalid-test-key", selectedModel);
    const after = await eventCount(page);
    await send(page, "prompt", { sessionId, text: "不要调用工具。只回复 QZ_INVALID_KEY_BAD。", clientMessageId: id("invalid-key") });
    const error = await waitEvent(page, { type: "error", sessionId }, after, 90_000);
    assert.equal(error.kind, "auth");
    assert.equal(error.status, 401);
    await waitEvent(page, { type: "agent_end", sessionId, runId: error.runId }, after, 20_000);
    const failed = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
    assert.equal(failed.status, "error");
    assert.equal((await eventsSince(page, after)).filter(event => event.type === "llm_retry" && event.sessionId === sessionId).length, 0, "invalid credentials must not retry");
    await saveDeepSeekConfig(page, apiKey, selectedModel);
    const recovered = await runPrompt(page, sessionId, "不要调用工具。只回复 QZ_KEY_RECOVERED_OK。");
    assert.match(recovered.assistantText, /QZ_KEY_RECOVERED_OK/);
    const state = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
    assert.equal(state.status, "completed");
    return { emptyKeyPreservedConfig: true, invalidKeyStatus: error.status, invalidKeyKind: error.kind, recovered: true };
  } finally {
    await saveDeepSeekConfig(page, apiKey, selectedModel);
    await deleteSession(page, sessionId);
  }
}

async function assertBasicStreaming(page) {
  const sessionId = await createSession(page, "DeepSeek live basic");
  const result = await runPrompt(page, sessionId, "不要调用工具。只回复精确文本 QZ_DEEPSEEK_OK。", { timeoutMs: 90_000 });
  assert.match(result.assistantText, /QZ_DEEPSEEK_OK/);
  assert.ok(result.updateCount > 0, "real provider response should arrive through message_update events");
  await deleteSession(page, sessionId);
  return { updateCount: result.updateCount, assistantChars: result.assistantText.length };
}

async function assertToolRoundTrip(page) {
  const sessionId = await createSession(page, "DeepSeek live tool");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "必须调用 list_tabs 工具一次，不要调用其他工具。拿到结果后只回复 QZ_TOOL_OK 和标签页数量。",
    clientMessageId: id("tool-user"),
  });
  const started = await waitEvent(page, { type: "tool_execution_start", sessionId, toolName: "list_tabs" }, after, 90_000);
  const ended = await waitEvent(page, { type: "tool_execution_end", sessionId, toolName: "list_tabs" }, after, 90_000);
  assert.equal(ended.isError, false);
  await waitEvent(page, { type: "agent_end", sessionId }, after, 90_000);
  const assistantText = await latestAssistantText(page, sessionId);
  assert.match(assistantText, /QZ_TOOL_OK/);
  await deleteSession(page, sessionId);
  return { toolName: started.toolName, assistantChars: assistantText.length };
}

async function assertConcurrentSessions(page) {
  const [left, right] = await Promise.all([
    createSession(page, "DeepSeek concurrent A"),
    createSession(page, "DeepSeek concurrent B"),
  ]);
  const after = await eventCount(page);
  await Promise.all([
    send(page, "prompt", { sessionId: left, text: "不要调用工具，只回复 QZ_PARALLEL_A。", clientMessageId: id("parallel-a") }),
    send(page, "prompt", { sessionId: right, text: "不要调用工具，只回复 QZ_PARALLEL_B。", clientMessageId: id("parallel-b") }),
  ]);
  await Promise.all([
    waitEvent(page, { type: "agent_end", sessionId: left }, after, 90_000),
    waitEvent(page, { type: "agent_end", sessionId: right }, after, 90_000),
  ]);
  const [leftText, rightText] = await Promise.all([
    latestAssistantText(page, left),
    latestAssistantText(page, right),
  ]);
  assert.match(leftText, /QZ_PARALLEL_A/);
  assert.match(rightText, /QZ_PARALLEL_B/);
  const [leftState, rightState] = await Promise.all([
    requestWithoutId(page, "get_state", { sessionId: left }, "state", 20_000, { sessionId: left }),
    requestWithoutId(page, "get_state", { sessionId: right }, "state", 20_000, { sessionId: right }),
  ]);
  assert.equal(leftState.status, "completed");
  assert.equal(rightState.status, "completed");
  await Promise.all([deleteSession(page, left), deleteSession(page, right)]);
  return { completed: 2 };
}

async function assertDuplicatePromptDoesNotSupersede(page) {
  const sessionId = await createSession(page, "DeepSeek duplicate start");
  const after = await eventCount(page);
  const clientMessageId = id("duplicate-primary");
  const text = "不要调用工具。逐行输出从 1 到 300，每行写序号和八个汉字。";
  await send(page, "prompt", { sessionId, text, clientMessageId });
  const firstStart = await waitEvent(page, { type: "agent_start", sessionId }, after, 90_000);
  await waitEvent(page, { type: "message_update", sessionId, runId: firstStart.runId }, after, 90_000);
  const accepted = await request(page, "prompt", { sessionId, text, clientMessageId }, "prompt_accepted", 20_000);
  assert.equal(accepted.duplicate, true);
  const state = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
  assert.equal(state.runId, firstStart.runId, "duplicate delivery must preserve the active run");
  assert.deepEqual(state.runtime.pendingFollowUps, []);
  await request(page, "stop_session", { sessionId, source: "live_duplicate" }, "state", 20_000);
  const history = await historyMessages(page, sessionId);
  assert.equal(history.filter(message => message.clientMessageId === clientMessageId).length, 1);
  await deleteSession(page, sessionId);
  return { deduplicated: true, originalRunPreserved: true };
}

async function assertPendingStartStop(page) {
  const sessionId = await createSession(page, "DeepSeek pending stop");
  const after = await eventCount(page);
  await setDynamicContextDelay(page, 750);
  try {
    await send(page, "prompt", {
      sessionId,
      text: "不要调用工具，只回复 QZ_PENDING_SHOULD_NOT_RUN。",
      clientMessageId: id("pending-stop"),
    });
    const pending = await waitForRuntimeStatus(page, sessionId, "pending", 20_000);
    assert.equal(pending.pendingStart, true);
    const stopped = await request(page, "stop_session", { sessionId, source: "live_pending" }, "state", 20_000);
    assert.equal(stopped.status, "aborted");
    await page.waitForTimeout(1_000);
    const events = await eventsSince(page, after);
    assert.equal(events.some(event => event.type === "agent_start" && event.sessionId === sessionId), false);
    assert.equal(JSON.stringify(await readActiveConversation(page, sessionId)).includes("QZ_PENDING_SHOULD_NOT_RUN"), false);
  } finally {
    await setDynamicContextDelay(page, 0);
  }
  await deleteSession(page, sessionId);
  return { stoppedBeforeProviderRun: true };
}

async function assertStreamingStop(page) {
  const sessionId = await createSession(page, "DeepSeek streaming stop");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "不要调用工具。逐行输出从 1 到 500，每行写序号和十个汉字，不要提前结束。",
    clientMessageId: id("stop-user"),
  });
  await waitEvent(page, { type: "message_update", sessionId }, after, 90_000);
  const stopped = await request(page, "stop_session", { sessionId, source: "live_e2e" }, "state", 20_000);
  assert.ok(["aborted", "cancelled", "canceled"].includes(stopped.status), `unexpected stop status: ${stopped.status}`);
  const updatesAtStop = await matchingEventCount(page, { type: "message_update", sessionId }, after);
  await page.waitForTimeout(1_000);
  const updatesAfterSettle = await matchingEventCount(page, { type: "message_update", sessionId }, after);
  assert.equal(updatesAfterSettle, updatesAtStop, "stopped run must not emit late message updates");
  const persisted = await readRuntimeCheckpoint(page, sessionId);
  assert.ok(["aborted", "cancelled", "canceled"].includes(persisted?.status));
  await deleteSession(page, sessionId);
  return { updatesBeforeStop: updatesAtStop, lateUpdates: updatesAfterSettle - updatesAtStop };
}

async function assertStopRestartHandoff(page) {
  const sessionId = await createSession(page, "DeepSeek stop restart handoff");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "不要调用工具。逐行输出从 1 到 500，每行写序号和十个汉字，不要提前结束。",
    clientMessageId: id("handoff-old"),
  });
  const oldStart = await waitEvent(page, { type: "agent_start", sessionId }, after, 90_000);
  await waitEvent(page, { type: "message_update", sessionId, runId: oldStart.runId }, after, 90_000);
  const raceAfter = await eventCount(page);
  const stopBoundary = await requestThenSend(page, {
    type: "stop_session",
    payload: { sessionId, source: "live_handoff" },
    responseType: "state",
    timeoutMs: 20_000,
  }, {
    type: "prompt",
    payload: {
      sessionId,
      text: "不要调用工具，只回复精确文本 QZ_AFTER_STOP_OK。",
      clientMessageId: id("handoff-new"),
    },
  });
  assert.equal(stopBoundary.message.status, "aborted");
  const newStart = await waitEventExcludingRun(page, { type: "agent_start", sessionId }, oldStart.runId, raceAfter, 90_000);
  await waitEvent(page, { type: "agent_end", sessionId, runId: newStart.runId }, raceAfter, 90_000);
  assert.notEqual(newStart.runId, oldStart.runId);
  assert.match(await latestAssistantText(page, sessionId), /QZ_AFTER_STOP_OK/);
  await page.waitForTimeout(1_000);
  const lateEvents = (await eventsSince(page, stopBoundary.eventIndex))
    .filter(event => event.sessionId === sessionId && event.runId === oldStart.runId && event.type === "message_update");
  assert.equal(lateEvents.length, 0, "the revoked run must stay silent after the durable stop boundary");
  const persistedRuntime = await readRuntimeCheckpoint(page, sessionId);
  assert.equal(persistedRuntime.status, "completed");
  assert.equal(persistedRuntime.runId, newStart.runId);
  assert.equal(JSON.stringify(await readActiveConversation(page, sessionId)).includes("QZ_AFTER_STOP_OK"), true);
  await deleteSession(page, sessionId);
  return { oldRunRevoked: true, newRunCompleted: true, lateUpdates: 0 };
}

async function assertDeleteRunningSession(page) {
  const sessionId = await createSession(page, "DeepSeek delete running");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "不要调用工具。逐行输出从 1 到 500，每行写序号和十个汉字，不要提前结束。",
    clientMessageId: id("delete-running"),
  });
  const started = await waitEvent(page, { type: "agent_start", sessionId }, after, 90_000);
  await waitEvent(page, { type: "message_update", sessionId, runId: started.runId }, after, 90_000);
  const deleted = await request(page, "delete_session", { sessionId }, "delete_session_result", 20_000);
  assert.equal(deleted.sessionId, sessionId);
  const boundary = await eventCount(page);
  await page.waitForTimeout(1_000);
  const lateUpdates = (await eventsSince(page, boundary))
    .filter(event => event.sessionId === sessionId && event.runId === started.runId && event.type === "message_update");
  assert.equal(lateUpdates.length, 0);
  const persisted = await readSessionStorage(page, sessionId);
  assert.equal(persisted.metadata, undefined);
  assert.equal(persisted.runtime, undefined);
  assert.equal(persisted.activeConversation, undefined);
  assert.equal(persisted.record, undefined);
  const rejected = await requestEither(page, "prompt", {
    sessionId,
    text: "不要调用工具，只回复 QZ_DELETED_BAD。",
    clientMessageId: id("deleted-rejected"),
  }, ["error", "request_failed", "transport_error"], 20_000);
  assert.match(rejected.message || "", /session not found|任务不存在/i);
  return { storageStayedDeleted: true, lateUpdates: 0 };
}

async function assertServiceWorkerRestart(page, browserContext, extensionId) {
  const sessionId = await createSession(page, "DeepSeek worker restart");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "必须调用 wait 工具，seconds=60。等待完成后只回复 QZ_WAIT_FINISHED。",
    clientMessageId: id("worker-restart-old"),
  });
  const started = await waitEvent(page, { type: "agent_start", sessionId }, after, 90_000);
  await waitEvent(page, { type: "tool_execution_start", sessionId, runId: started.runId, toolName: "wait" }, after, 90_000);
  const beforeRestart = await readRuntimeCheckpoint(page, sessionId);
  assert.equal(beforeRestart?.status, "running");

  await terminateExtensionServiceWorker(page, browserContext, extensionId);
  const recovered = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.runtime?.reason, "service_worker_restarted");
  assert.equal(recovered.runtime?.runId, started.runId);

  const continuation = await runPrompt(
    page,
    sessionId,
    "不要调用工具，只回复精确文本 QZ_AFTER_WORKER_RESTART_OK。",
    { timeoutMs: 90_000 },
  );
  assert.match(continuation.assistantText, /QZ_AFTER_WORKER_RESTART_OK/);
  const finalRuntime = await readRuntimeCheckpoint(page, sessionId);
  assert.equal(finalRuntime.status, "completed");
  assert.notEqual(finalRuntime.runId, started.runId);
  await deleteSession(page, sessionId);
  return { recoveredAsInterrupted: true, continuationCompleted: true };
}

async function assertFollowUpHandoff(page) {
  const sessionId = await createSession(page, "DeepSeek follow-up handoff");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "不要调用工具。先只回复 QZ_QUEUE_FIRST。",
    clientMessageId: id("queue-first"),
  });
  const firstStart = await waitEvent(page, { type: "agent_start", sessionId }, after, 90_000);
  await send(page, "follow_up", {
    sessionId,
    text: "不要调用工具。只回复 QZ_QUEUE_SECOND。",
    clientMessageId: id("queue-second"),
  });
  const firstEnd = await waitEvent(page, { type: "agent_end", sessionId, runId: firstStart.runId }, after, 90_000);
  const secondStart = await waitEventExcludingRun(page, { type: "agent_start", sessionId }, firstEnd.runId, after, 90_000);
  await waitEvent(page, { type: "agent_end", sessionId, runId: secondStart.runId }, after, 90_000);
  const history = await historyMessages(page, sessionId);
  const assistantText = history.filter(message => message.role === "assistant").map(messageText).join("\n");
  assert.match(assistantText, /QZ_QUEUE_FIRST/);
  assert.match(assistantText, /QZ_QUEUE_SECOND/);
  assert.notEqual(firstStart.runId, secondStart.runId);
  await deleteSession(page, sessionId);
  return { runs: 2 };
}

async function assertUserWaitLifecycle(page) {
  const sessionId = await createSession(page, "DeepSeek user wait");
  const after = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "必须调用 wait_for_user 一次，message 写 QZ_WAIT_FOR_USER。用户继续后，只回复精确文本 QZ_WAIT_RESUMED_OK。",
    clientMessageId: id("wait-user"),
  });
  const waiting = await waitEvent(page, { type: "waiting_for_user", sessionId }, after, 90_000);
  assert.ok(waiting.waitId, "wait_for_user must publish a stable waitId");
  const waitingState = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
  assert.equal(waitingState.status, "waiting_user");
  assert.equal(waitingState.runtime?.waitId, waiting.waitId);
  await send(page, "continue_task", {
    sessionId,
    waitId: waiting.waitId,
    payload: { continued: true, reason: "live_e2e" },
  });
  await waitEvent(page, {
    type: "user_wait_resolved",
    sessionId,
    waitId: waiting.waitId,
  }, after, 20_000);
  await waitEvent(page, { type: "agent_end", sessionId }, after, 90_000);
  assert.match(await latestAssistantText(page, sessionId), /QZ_WAIT_RESUMED_OK/);
  const finalState = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.runtime?.waitId || "", "");
  await deleteSession(page, sessionId);
  return { resumed: true, waitIdCleared: true };
}

async function assertEditAndRerun(page) {
  const sessionId = await createSession(page, "DeepSeek edit rerun");
  const clientMessageId = id("edit-user");
  const firstAfter = await eventCount(page);
  await send(page, "prompt", {
    sessionId,
    text: "不要调用工具，只回复精确文本 QZ_EDIT_OLD。",
    clientMessageId,
  });
  await waitEvent(page, { type: "agent_end", sessionId }, firstAfter, 90_000);
  assert.match(await latestAssistantText(page, sessionId), /QZ_EDIT_OLD/);

  const rerunAfter = await eventCount(page);
  await send(page, "resend_prompt", {
    sessionId,
    clientMessageId,
    text: "不要调用工具，只回复精确文本 QZ_EDIT_NEW。",
    images: [],
  });
  await waitEvent(page, { type: "transcript_replace", sessionId }, rerunAfter, 20_000);
  await waitEvent(page, { type: "agent_end", sessionId }, rerunAfter, 90_000);
  const history = await historyMessages(page, sessionId);
  const text = history.map(messageText).join("\n");
  assert.match(text, /QZ_EDIT_NEW/);
  assert.doesNotMatch(text, /QZ_EDIT_OLD/, "edit-and-rerun must replace the old branch instead of appending a second branch");
  const runtime = await readRuntimeCheckpoint(page, sessionId);
  assert.equal(runtime.status, "completed");
  await deleteSession(page, sessionId);
  return { branchReplaced: true, completed: true };
}

async function assertSkillSelection(page) {
  const directory = join(root, "tests/fixtures/skills/result-selection");
  const skill = normalizeModernSkill({
    ...skillFromSkillMarkdown(readFileSync(join(directory, "SKILL.md"), "utf8")),
    resources: ["plugin.json", "scripts/choose.js"].map(path => ({ path, content: readFileSync(join(directory, path), "utf8") })),
  });
  const saved = await request(page, "save_workspace_skill", { name: skill.name, expected: null, skill }, "skill_workspace_saved");
  assert.equal(saved.registryReady, true);
  const sessionId = await createSession(page, "Choose my next role");
  const prompt = "Use the result-selection-example Skill to let me choose roles, then summarize only my picks.";
  const selectedIds = ["harbor-platform", "fieldwork-systems"];
  const providerRequests = [];
  const onRequest = request => {
    if (request.method() !== "POST" || !new URL(request.url()).hostname.endsWith("deepseek.com")) return;
    let body;
    try { body = request.postDataJSON(); } catch { return; }
    if (!Array.isArray(body?.messages)) return;
    const selectionMessage = body.messages.find(message => message.role === "tool" && /"selectedIds"/.test(String(message.content)));
    providerRequests.push({
      hasSelection: Boolean(selectionMessage),
      selectionContent: selectionMessage?.content || "",
      containsUnselected: JSON.stringify(body.messages).includes("northstar-backend"),
    });
  };
  page.context().on("request", onRequest);
  try {
    await page.setViewportSize({ width: 360, height: 1000 });
    await page.locator('.tab-btn[data-tab="sessions"]').click();
    await page.locator(`.session-card[data-id="${sessionId}"]`).click();
    await page.locator('#input').fill(prompt);
    const after = await eventCount(page);
    await page.locator('#input').press("Enter");
    const waiting = await waitEvent(page, { type: "waiting_for_user", sessionId }, after, 180_000);
    assert.equal(waiting.form.fields[0].presentation, "cards");
    assert.deepEqual(waiting.form.fields[0].options.map(option => option.value), ["northstar-backend", ...selectedIds]);
    const card = page.locator(`.waiting-active[data-wait-id="${waiting.waitId}"]`);
    await card.waitFor();
    assert.equal(await card.locator(".qz-choice-card").count(), 3);
    const callsBeforeSelection = providerRequests.length;
    for (const value of selectedIds) await card.locator(`input[value="${value}"]`).check();
    assert.equal(providerRequests.length, callsBeforeSelection, "choosing cards stays local until submission");
    const screenshotDirectory = process.env.QINGZHOU_LIVE_REPORT ? dirname(resolve(process.env.QINGZHOU_LIVE_REPORT)) : "";
    const screenshots = [];
    if (screenshotDirectory) {
      const screenshot = join(screenshotDirectory, "selection-live-waiting.png");
      await page.screenshot({ path: screenshot, animations: "disabled" });
      screenshots.push(screenshot);
    }
    const actionAfter = await eventCount(page);
    await card.locator('[data-wait-action="continue"]').click();
    const completed = await waitEvent(page, { type: "tool_execution_end", sessionId, toolName: "result_selection_example__choose" }, actionAfter, 30_000);
    assert.equal(completed.isError, false);
    const selection = completed.result.result || completed.result;
    assert.deepEqual(selection.selectedIds, selectedIds);
    assert.deepEqual(selection.selectedItems.map(item => item.id), selectedIds);
    assert.equal(selection.totalItems, 3);
    assert.equal(Object.hasOwn(selection, "items"), false);
    await waitEvent(page, { type: "agent_end", sessionId }, actionAfter, 180_000);
    const state = await requestWithoutId(page, "get_state", { sessionId }, "state", 20_000, { sessionId });
    assert.equal(state.status, "completed");
    const assistantText = await latestAssistantText(page, sessionId);
    assert.match(assistantText, /Harbor/);
    assert.match(assistantText, /Fieldwork/);
    assert.doesNotMatch(assistantText, /Northstar/);
    await page.waitForFunction(expected => {
      const message = [...document.querySelectorAll("#messages .msg-assistant")].at(-1);
      const text = message?.querySelector(".msg-content")?.textContent || "";
      return message?.dataset.content === expected && text.includes("Harbor") && text.includes("Fieldwork");
    }, assistantText, { timeout: 20_000 });
    await page.locator("#messages .msg-assistant").last().scrollIntoViewIfNeeded();
    const resumedRequests = providerRequests.filter(item => item.hasSelection);
    assert.ok(resumedRequests.length > 0, "the real model request must contain the selected tool result");
    assert.equal(resumedRequests.some(item => item.containsUnselected), false, "unselected candidate records stay out of model context");
    assert.ok(resumedRequests.every(item => selectedIds.every(id => item.selectionContent.includes(id))));
    const events = await eventsSince(page, after);
    assert.equal(events.filter(event => event.type === "waiting_for_user" && event.sessionId === sessionId).length, 1);
    if (screenshotDirectory) {
      const screenshot = join(screenshotDirectory, "selection-live-completed.png");
      await page.screenshot({ path: screenshot, animations: "disabled" });
      screenshots.push(screenshot);
    }
    return {
      prompt, sessionId, waitId: waiting.waitId, candidateCount: 3, selectedIds,
      toolCalls: events.filter(event => event.type === "tool_execution_start" && event.sessionId === sessionId).map(event => event.toolName),
      providerRequestCount: providerRequests.length, resumedRequestCount: resumedRequests.length,
      selectedRecordsOnly: true, assistantRendered: true, assistantText, screenshots,
    };
  } finally {
    page.context().off("request", onRequest);
    await deleteSession(page, sessionId);
    await request(page, "delete_workspace_skill", { name: skill.name, expected: saved.skill }, "skill_workspace_deleted");
    await page.setViewportSize({ width: 980, height: 860 });
  }
}

async function runPrompt(page, sessionId, text, { timeoutMs = 90_000 } = {}) {
  const after = await eventCount(page);
  await send(page, "prompt", { sessionId, text, clientMessageId: id("user") });
  const started = await waitEvent(page, { type: "agent_start", sessionId }, after, timeoutMs);
  await waitEvent(page, { type: "agent_end", sessionId, runId: started.runId }, after, timeoutMs);
  const events = await eventsSince(page, after);
  return {
    runId: started.runId,
    assistantText: await latestAssistantText(page, sessionId),
    updateCount: events.filter(event => (
      event.type === "message_update"
      && event.sessionId === sessionId
      && event.runId === started.runId
    )).length,
  };
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
  const assistant = [...messages].reverse().find(message => message.role === "assistant");
  return messageText(assistant);
}

async function historyMessages(page, sessionId) {
  const result = await requestWithoutId(page, "get_history", { sessionId }, "history", 20_000, { sessionId });
  return Array.isArray(result.messages) ? result.messages : [];
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter(item => item?.type === "text").map(item => item.text || "").join("\n");
}

async function installHarness(page) {
  await page.evaluate(() => {
    let port = null;
    const events = [];
    const waiters = new Set();
    let sequence = 0;
    let dynamicContextDelayMs = 0;

    const scrub = (value) => JSON.parse(JSON.stringify(value, (key, item) => (
      /api.?key|authorization|token|secret/i.test(key) ? "[redacted]" : item
    )));
    const matches = (message, expected) => Object.entries(expected || {}).every(([key, value]) => message?.[key] === value);
    const settle = (message) => {
      for (const waiter of [...waiters]) {
        if (waiter.after > events.length - 1 || !waiter.predicate(message)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    };
    const connect = () => {
      port = chrome.runtime.connect({ name: "sidepanel" });
      port.onMessage.addListener(raw => {
        if (raw?.type === "dynamic_context_request") {
          setTimeout(() => {
            try {
              port.postMessage({ type: "dynamic_context_response", requestId: raw.requestId, context: {} });
            } catch (_error) {}
          }, dynamicContextDelayMs);
        }
        const message = scrub(raw);
        events.push(message);
        settle(message);
      });
      return true;
    };
    connect();

    const wait = (expected, after = 0, timeoutMs = 30_000, predicate = null) => {
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
    const send = (type, payload = {}) => port.postMessage({ type, ...payload });
    const request = async (type, payload, responseType, timeoutMs, acceptedTypes = [responseType]) => {
      const requestId = `live_${Date.now().toString(36)}_${++sequence}`;
      const after = events.length;
      send(type, { ...payload, requestId });
      const failures = ["error", "request_failed", "transport_error"];
      const response = await wait({}, after, timeoutMs, message => message?.requestId === requestId
        && (acceptedTypes.includes(message.type) || failures.includes(message.type)));
      if (failures.includes(response.type) && !acceptedTypes.includes(response.type)) {
        throw new Error(`${type} failed (${response.code || response.type}): ${response.message || "request failed"}`);
      }
      return response;
    };
    const requestThenSend = async (requestInput, nextInput) => {
      const pending = request(
        requestInput.type,
        requestInput.payload || {},
        requestInput.responseType,
        requestInput.timeoutMs,
        requestInput.acceptedTypes || [requestInput.responseType],
      );
      send(nextInput.type, nextInput.payload || {});
      const message = await pending;
      return { message, eventIndex: events.length };
    };
    window.__qzLiveHarness = {
      send,
      wait,
      request,
      requestThenSend,
      reconnect: connect,
      setDynamicContextDelay: value => {
        dynamicContextDelayMs = Math.max(0, Number(value) || 0);
      },
      count: () => events.length,
      eventsSince: index => events.slice(index),
      matchingCount: (expected, after = 0) => events.slice(after).filter(message => matches(message, expected)).length,
    };
  });
}

function request(page, type, payload, responseType, timeoutMs = 30_000) {
  return page.evaluate(({ type, payload, responseType, timeoutMs }) => (
    window.__qzLiveHarness.request(type, payload, responseType, timeoutMs)
  ), { type, payload, responseType, timeoutMs });
}

function requestEither(page, type, payload, responseTypes, timeoutMs = 30_000) {
  return page.evaluate(({ type, payload, responseTypes, timeoutMs }) => (
    window.__qzLiveHarness.request(type, payload, responseTypes[0], timeoutMs, responseTypes)
  ), { type, payload, responseTypes, timeoutMs });
}

function requestThenSend(page, requestInput, nextInput) {
  return page.evaluate(({ requestInput, nextInput }) => (
    window.__qzLiveHarness.requestThenSend(requestInput, nextInput)
  ), { requestInput, nextInput });
}

async function requestWithoutId(page, type, payload, responseType, timeoutMs = 30_000, expected = {}) {
  const after = await eventCount(page);
  await send(page, type, payload);
  return waitEvent(page, { type: responseType, ...expected }, after, timeoutMs);
}

function send(page, type, payload = {}) {
  return page.evaluate(({ type, payload }) => window.__qzLiveHarness.send(type, payload), { type, payload });
}

function waitEvent(page, expected, after = 0, timeoutMs = 30_000) {
  return page.evaluate(({ expected, after, timeoutMs }) => window.__qzLiveHarness.wait(expected, after, timeoutMs), {
    expected,
    after,
    timeoutMs,
  });
}

function waitEventExcludingRun(page, expected, excludedRunId, after = 0, timeoutMs = 30_000) {
  return page.evaluate(({ expected, excludedRunId, after, timeoutMs }) => (
    window.__qzLiveHarness.wait({}, after, timeoutMs, message => (
      Object.entries(expected).every(([key, value]) => message?.[key] === value)
      && message?.runId !== excludedRunId
    ))
  ), { expected, excludedRunId, after, timeoutMs });
}

function eventCount(page) {
  return page.evaluate(() => window.__qzLiveHarness.count());
}

function eventsSince(page, index) {
  return page.evaluate(index => window.__qzLiveHarness.eventsSince(index), index);
}

function matchingEventCount(page, expected, after = 0) {
  return page.evaluate(({ expected, after }) => window.__qzLiveHarness.matchingCount(expected, after), { expected, after });
}

function setDynamicContextDelay(page, delayMs) {
  return page.evaluate(delayMs => window.__qzLiveHarness.setDynamicContextDelay(delayMs), delayMs);
}

async function waitForRuntimeStatus(page, sessionId, expectedStatus, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await requestWithoutId(page, "get_state", { sessionId }, "state", 10_000, { sessionId });
    if (state.status === expectedStatus) return state.runtime || state;
    await page.waitForTimeout(25);
  }
  throw new Error(`timed out waiting for runtime ${expectedStatus}: ${sessionId}`);
}

function readRuntimeCheckpoint(page, sessionId) {
  return page.evaluate(async sessionId => {
    const key = `_session_runtime_${sessionId}`;
    return (await chrome.storage.local.get(key))[key] || null;
  }, sessionId);
}

function readActiveConversation(page, sessionId) {
  return page.evaluate(async sessionId => {
    const key = `_active_conversation_${sessionId}`;
    return (await chrome.storage.local.get(key))[key];
  }, sessionId);
}

function readSessionStorage(page, sessionId) {
  return page.evaluate(async sessionId => {
    const runtimeKey = `_session_runtime_${sessionId}`;
    const activeKey = `_active_conversation_${sessionId}`;
    const recordKey = `_session_${sessionId}`;
    const values = await chrome.storage.local.get(["_sessions", runtimeKey, activeKey, recordKey]);
    return {
      metadata: values._sessions?.[sessionId],
      runtime: values[runtimeKey],
      activeConversation: values[activeKey],
      record: values[recordKey],
    };
  }, sessionId);
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

  await page.waitForTimeout(100);
  await page.evaluate(() => window.__qzLiveHarness.reconnect());
  // Reconnecting does not push a state snapshot; the caller queries its session explicitly.
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
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    throw new Error("Unable to resolve loaded extension id");
  }
}

function attachWorkerDiagnostics(browserContext, output, secret) {
  const attach = worker => {
    worker.on("console", message => {
      if (message.type() === "error") output.push(redact(message.text(), secret));
    });
  };
  browserContext.serviceWorkers().forEach(attach);
  browserContext.on("serviceworker", attach);
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

function redact(value, secret) {
  return String(value || "").split(secret).join("[redacted]");
}

function isExpectedDiagnostic(message) {
  return /Receiving end does not exist|message port closed/i.test(message);
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

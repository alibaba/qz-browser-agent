import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localFetch, readHealth, resultValue } from "../../services/mcp-bridge/src/client.mjs";
import { PROJECT_ROOT, launchIsolatedExtensionMcp, saveExtensionLlmConfig } from "../support/isolated-extension-mcp.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { verifyTable, verifyDownloads } from "../support/live-soak-oracles.mjs";
import { closeCompletedTaskTabs } from "../support/mcp-soak-tab-cleanup.mjs";
import { verifyLiveCase } from "./deepseek-cli-mcp-acceptance.mjs";
import { CASES } from "./deepseek-cli-mcp-cases.mjs";

const { values } = parseArgs({ options: { "duration-seconds": { type: "string", default: "1800" }, "task-timeout-seconds": { type: "string", default: "360" }, "cases": { type: "string" } } });
const durationSeconds = Number(values["duration-seconds"]);
const taskTimeoutSeconds = Number(values["task-timeout-seconds"]);
assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 7200);
assert.ok(Number.isFinite(taskTimeoutSeconds) && taskTimeoutSeconds >= 30 && taskTimeoutSeconds <= 600);
const selected = values.cases ? CASES.filter(item => values.cases.split(",").includes(item.id)) : CASES;
assert.ok(selected.length, "No live cases selected");
const apiKey = readTestApiKey("deepseek", { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || "" });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = join(PROJECT_ROOT, "tests/results/mcp-bridge");
mkdirSync(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, `deepseek-live-soak-${stamp}.json`);
const downloads = mkdtempSync(join(tmpdir(), "qz-live-soak-downloads-"));
const report = { ok: false, phase: "setup", provider: "deepseek", model, requestedDurationSeconds: durationSeconds, runnerPid: process.pid,
  environment: "Real DeepSeek API, public websites, isolated real Chrome extension/service, real CLI subprocesses and MCP SDK. No synthetic provider or canned model responses.",
  tasks: [], operations: [], network: [], health: [], failures: [], tabCleanup: [], cliProcesses: 0, mcpCalls: 0, connectionGenerations: 0 };
const children = new Set();
const activeSessions = new Set();
let environment, client, transport, clientId, heartbeat, startedAt, stopRequested = false;
process.on("SIGUSR2", () => { stopRequested = true; });
try {
  environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-deepseek-live-soak-", requestTimeoutSeconds: 60, downloadDirectory: downloads });
  // Preserve the filenames produced by Chrome downloads instead of Playwright's UUID renaming.
  const downloadSession = await environment.context.newCDPSession(environment.page);
  await downloadSession.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  clientId = environment.bridgeStatus.clients[0].clientId;
  report.endpoint = environment.bridge.endpoint;
  report.clientId = clientId;
  report.servicePid = environment.bridge.process.pid;
  environment.context.on("response", response => {
    const url = new URL(response.url());
    if (url.hostname === "api.deepseek.com") report.network.push({ at: new Date().toISOString(), provider: true, path: url.pathname, status: response.status() });
  });
  await selectEnglish(environment.page);
  report.language = "en";
  await saveExtensionLlmConfig(environment.page, { provider: "deepseek", apiKey, model, contextWindow: 128000,
    trimOldToolResults: true, vision: false, debugMode: false });
  report.fileAccessAllowed = await environment.page.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  await connectMcp();
  await environment.connectionPage.close();
  startedAt = Date.now();
  report.startedAt = new Date(startedAt).toISOString();
  report.expectedEndAt = new Date(startedAt + durationSeconds * 1000).toISOString();
  report.phase = "running";
  heartbeat = setInterval(() => { persist(); console.log(JSON.stringify({ heartbeat: true, elapsedSeconds: elapsed(), tasks: report.tasks.length,
    passed: report.tasks.filter(task => task.ok).length, failed: report.tasks.filter(task => !task.ok).length, current: report.current, providerResponses: report.network.length })); }, 30_000);
  console.log(JSON.stringify({ ready: true, provider: "deepseek", model, startedAt: report.startedAt, expectedEndAt: report.expectedEndAt, reportPath, endpoint: report.endpoint }));
  persist();
  let index = 0;
  do {
    const test = selected[index % selected.length];
    await runCase(test, ++index);
    if (index % selected.length === 0) report.tabCleanup.push(await closeCompletedTaskTabs({ mcp,
      sessionIds: report.tasks.map(task => task.sessionId).filter(Boolean), activeSessionIds: [...activeSessions] }));
    const health = await readHealth(environment.bridge.endpoint);
    report.health.push({ at: new Date().toISOString(), elapsedSeconds: elapsed(), connected: health.status.clientCount === 1, polls: environment.pollRequests.length });
    persist();
    await delay(2000);
  } while (!stopRequested && (Date.now() - startedAt < durationSeconds * 1000 || index < selected.length));
  report.completedRequestedDuration = Date.now() - startedAt >= durationSeconds * 1000;
  report.ok = report.tasks.every(task => task.ok) && report.completedRequestedDuration && report.tabCleanup.every(item => !item.errors.length);
  report.phase = stopRequested ? "interrupted" : "completed";
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.phase = "failed";
  report.failures.push({ message: redact(error.message), stack: redact(error.stack) });
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  report.finishedAt = new Date().toISOString();
  report.actualDurationMs = startedAt ? Date.now() - startedAt : 0;
  await Promise.all([...children].map(child => new Promise(resolve => {
    child.once("close", resolve); child.kill("SIGTERM");
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); timer.unref();
  })));
  const cleanupErrors = [];
  for (const sessionId of activeSessions) await mcp("qingzhou_stop_session", { sessionId }).catch(error => cleanupErrors.push(redact(error.message)));
  await transport?.terminateSession().catch(() => {});
  await client?.close().catch(() => {});
  await environment?.close().catch(error => cleanupErrors.push(redact(error.message)));
  rmSync(downloads, { recursive: true, force: true });
  report.cleanupSucceeded = !cleanupErrors.length;
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.ok = false; process.exitCode = 1; }
  persist();
  console.log(JSON.stringify({ finished: true, ok: report.ok, elapsedSeconds: elapsed(), tasks: report.tasks.length,
    passed: report.tasks.filter(task => task.ok).length, failed: report.tasks.filter(task => !task.ok).length, reportPath }));
}

function elapsed() { return startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0; }
function redact(value) { return String(value || "").split(apiKey).join("[REDACTED]"); }
function persist() {
  report.elapsedSeconds = elapsed();
  writeFileSync(reportPath, redact(JSON.stringify({ ...report, diagnostics: environment?.diagnostics || [], bridgeLogs: environment?.bridge.logs || [] }, null, 2)));
}
function contentText(value) { return typeof value === "string" ? value : Array.isArray(value) ? value.filter(part => part.type === "text").map(part => part.text).join("\n") : ""; }
function assistantText(snapshot) { return (snapshot.transcript || []).filter(entry => entry.type === "assistant").map(entry => contentText(entry.content)).join("\n"); }
async function connectMcp() {
  client = new Client({ name: "qz-deepseek-live-soak", version: "1.0.0" });
  transport = new StreamableHTTPClientTransport(new URL(environment.bridge.mcpUrl), { fetch: localFetch,
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
  await client.connect(transport);
  report.connectionGenerations++;
}
async function mcp(name, args = {}, options = {}) {
  const started = Date.now(); report.mcpCalls++;
  try {
    const result = await client.callTool({ name, arguments: { clientId, ...args } }, undefined,
      { timeout: (taskTimeoutSeconds + 20) * 1000, resetTimeoutOnProgress: true, ...options });
    const value = resultValue(result);
    if (result.isError) throw new Error(`MCP ${name}: ${JSON.stringify(value)}`);
    report.operations.push({ channel: "mcp", name, ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    report.operations.push({ channel: "mcp", name, ok: false, ms: Date.now() - started, error: redact(error.message) }); throw error;
  }
}
function observeMcp(name, args) {
  const state = { settled: false, updates: [], value: null, error: null, created: null };
  const pending = mcp(name, { ...args, stream: true, waitTimeoutSeconds: taskTimeoutSeconds }, { onprogress: value => {
    const event = value._meta?.["qz/task-event"];
    if (!event) return; state.updates.push(event); if (event.type === "created") state.created = event;
  } }).then(value => { state.value = value; }, error => { state.error = error; }).finally(() => { state.settled = true; });
  state.finish = async () => { await pending; if (state.error) throw state.error; return state.value; };
  return state;
}
function startCli(args, { timeoutSeconds = taskTimeoutSeconds } = {}) {
  const started = Date.now(); report.cliProcesses++;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from "./services/mcp-bridge/src/cli.mjs";
    import { readHealth } from "./services/mcp-bridge/src/client.mjs";
    const endpoint = process.argv[1];
    process.exitCode = await main(process.argv.slice(2), {
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
      onTaskCreated: value => process.send({ type: "created", value }),
      onTaskUpdate: value => process.send({ type: "update", value }),
    }); process.disconnect();
  `, "--", environment.bridge.endpoint, ...args, "--json", "--client", clientId, "--timeout", String(timeoutSeconds)],
  { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  const state = { child, settled: false, created: null, updates: [], stdout: "", stderr: "" };
  child.stdout.on("data", value => { state.stdout += value; }); child.stderr.on("data", value => { state.stderr += value; });
  child.on("message", event => { if (event.type === "created") state.created = event.value; if (event.type === "update") state.updates.push(event.value); });
  const timer = setTimeout(() => child.kill("SIGTERM"), (timeoutSeconds + 25) * 1000);
  const pending = new Promise(resolve => { child.once("error", error => { state.error = error; resolve(); }); child.once("close", code => { state.code = code; resolve(); }); })
    .finally(() => { clearTimeout(timer); state.settled = true; children.delete(child); });
  state.finish = async () => {
    await pending;
    report.operations.push({ channel: "cli", name: args[0], ok: state.code === 0, ms: Date.now() - started });
    if (state.error) throw state.error;
    assert.equal(state.code, 0, redact(`CLI ${args[0]} failed: ${state.stdout}\n${state.stderr}`));
    const output = JSON.parse(state.stdout.trim()); assert.equal(output.ok, true); return output.result;
  };
  return state;
}
async function cli(args, options) { return startCli(args, options).finish(); }
async function snapshot(sessionId) { return mcp("qingzhou_get_session_snapshot", { sessionId, compact: false, tail: false, includeArtifacts: true }); }
async function until(predicate, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
async function runCase(original, iteration) {
  const test = { ...original };
  if (test.expectTable) {
    const table = test.expectTable;
    test.expectTable = `${table} ${iteration}`;
    test.prompt = test.prompt.replace(table, test.expectTable);
    const followUpTable = test.id === "hn-reading-list" ? "HN shortlist" : "Earthquake shortlist";
    test.expectFollowUpTable = `${followUpTable} ${iteration}`;
    test.followUp = test.followUp.replace(followUpTable, test.expectFollowUpTable);
  }
  const started = Date.now();
  let stage = "admission";
  const remainingSeconds = () => Math.max(1, Math.floor(taskTimeoutSeconds - (Date.now() - started) / 1000));
  const entry = { id: test.id, iteration, prompt: test.prompt, channel: iteration % 2 ? "cli" : "mcp", startedAt: new Date().toISOString(), ok: false, inputs: [], followUps: [] };
  report.current = { id: test.id, iteration, startedAt: entry.startedAt };
  const observer = entry.channel === "cli" ? startCli(["create", test.prompt, "--title", `Live ${iteration}: ${test.id}`, "--stream"])
    : observeMcp("qingzhou_create_session", { title: `Live ${iteration}: ${test.id}`, firstMessage: test.prompt });
  let sessionId;
  try {
    const created = await until(() => { if (observer.error) throw observer.error; if (observer.settled && !observer.created) throw new Error("Creation ended before exposing a task ID"); return observer.created; }, "task admission");
    sessionId = created.session?.id || created.sessionId; assert.ok(sessionId); entry.sessionId = sessionId; activeSessions.add(sessionId);
    report.current.sessionId = sessionId; stage = "execution"; persist();
    if (test.kind === "steer") {
      await delay(2000);
      const message = test.steer || "Focus on practical free options and cite the sources.";
      const steered = await (entry.channel === "cli" ? mcp("qingzhou_send_message", { sessionId, text: message, steer: true }) : cli(["send", sessionId, message, "--steer"]));
      assert.equal(steered.accepted, true); assert.equal(steered.deliveryMode, "steer"); entry.steer = { message, clientMessageId: steered.clientMessageId };
    }
    if (test.kind === "cancel") {
      await delay(5000);
      entry.cancelResult = await cli(["cancel", sessionId]);
    }
    const answered = new Set();
    while (!observer.settled) {
      if (Date.now() - started > (taskTimeoutSeconds + 15) * 1000) throw new Error("Live task exceeded its bounded observation budget");
      for (const event of observer.updates.filter(item => item.type === "input")) {
        if (answered.has(event.waitId)) continue; answered.add(event.waitId);
        const current = (await cli(["show", sessionId])).input;
        if (!current?.waiting || current.waitId !== event.waitId) continue;
        if (current.requiresUserAction) throw new Error(`Native browser action required: ${current.kind}: ${current.instructions || current.message}`);
        assert.ok(["form", "confirmation"].includes(current.kind), `Unexpected protected wait: ${current.kind}`);
        assert.ok(test.kind === "confirmation" || (test.kind === "form" && current.kind === "form"), `Unexpected input in ${test.id}: ${current.kind}`);
        const action = current.kind === "form" ? "submit" : "approve";
        const answers = action === "submit" ? formAnswers(current.form, test) : undefined;
        entry.inputs.push({ kind: current.kind, waitId: current.waitId, fields: current.form?.fields, answers, action, message: current.message });
        if (entry.channel === "cli") await mcp("qingzhou_respond_to_user_input", { ...current.responseTemplate, action, ...(answers ? { answers } : {}) });
        else await cli([action, sessionId, ...(answers ? [JSON.stringify(answers)] : []), "--wait-id", current.waitId]);
        persist();
      }
      await delay(750);
    }
    const result = await observer.finish().catch(error => {
      if (test.kind !== "cancel") throw error;
      entry.cancellationObserverError = redact(error.message);
      return {};
    });
    stage = "output";
    entry.snapshot = result.snapshot || await snapshot(sessionId);
    if (test.kind === "cancel") assert.ok(["aborted", "cancelled", "interrupted"].includes(entry.snapshot.status), `Cancel ended as ${entry.snapshot.status}`);
    else {
      assert.equal(entry.snapshot.status, "completed");
      entry.tools = entry.snapshot.transcript.filter(item => item.type === "tool").map(item => ({ name: item.name, status: item.status, eventSeq: item.eventSeq }));
      assert.ok(entry.tools.some(item => /open_tab|navigate|read_article|run_script|inspect_page|fetch|skill/i.test(item.name)), "The task must use browser tools or Skills to consult its public sources");
      entry.answer = assistantText(entry.snapshot); assert.ok(entry.answer.length > 30, "The task needs a substantive answer");
      if (test.kind === "form") assert.ok(entry.inputs.some(input => input.kind === "form"), "The real model must create a form");
      if (test.kind === "confirmation") assert.ok(entry.inputs.some(input => ["confirmation", "form"].includes(input.kind)), "The real model must request confirmation before browsing");
      if (test.expectTerms) for (const term of test.expectTerms) assert.ok(entry.answer.toLowerCase().includes(term.toLowerCase()), `Answer missing ${term}`);
      if (test.expectSource) assert.match(entry.answer, /https?:\/\//, "The answer needs source links");
      if (entry.steer) assert.equal(entry.snapshot.transcript.filter(item => item.clientMessageId === entry.steer.clientMessageId).length, 1);
      const oracleOptions = { environment, mcp, cli, downloadDirectory: downloads,
        artifactDirectory: join(reportDirectory, `deepseek-live-soak-${stamp}-artifacts`, `${iteration}-${test.id}`) };
      if (test.expectTable) entry.table = await verifyTable({ ...oracleOptions, table: test.expectTable, minRows: test.expectMinRows });
      if (test.expectDownload) entry.downloads = (await verifyDownloads({ ...oracleOptions, since: started })).downloads;
      if (test.followUp) {
        stage = "followup";
        assert.ok(remainingSeconds() >= 15, "Insufficient remaining task budget for follow-up");
        const followStarted = Date.now();
        const follow = await (entry.channel === "cli" ? mcp("qingzhou_send_message", { sessionId, text: test.followUp, wait: true, waitTimeoutSeconds: remainingSeconds() })
          : cli(["send", sessionId, test.followUp, "--wait"], { timeoutSeconds: remainingSeconds() }));
        assert.equal(follow.snapshot.status, "completed");
        assert.equal(follow.snapshot.transcript.filter(item => item.clientMessageId === follow.clientMessageId).length, 1);
        entry.followUps.push({ prompt: test.followUp, clientMessageId: follow.clientMessageId, answer: assistantText(follow.snapshot), snapshot: follow.snapshot });
        stage = "output";
        if (test.expectFollowUpTable) entry.followUpTable = await verifyTable({ ...oracleOptions, table: test.expectFollowUpTable, minRows: 0 });
        if (test.id === "city-choice") entry.downloads = (await verifyDownloads({ ...oracleOptions, since: followStarted })).downloads;
      }
      entry.acceptance = verifyLiveCase({ id: test.id, rows: entry.table?.rows, followUpRows: entry.followUpTable?.rows,
        markdown: entry.downloads?.map(file => file.text).join("\n\n") });
    }
    activeSessions.delete(sessionId);
    entry.ok = true;
  } catch (error) {
    entry.error = redact(error.message); entry.stack = redact(error.stack); entry.failureStage = stage;
    entry.failureKind = stage === "output" ? "task_output" : /provider|deepseek|rate.limit|429|quota|API key|502|503/i.test(entry.error)
      ? "provider_or_network" : /MCP|CLI|bridge|connect|timed out|timeout/i.test(entry.error) ? "transport_or_timeout" : "task_execution";
    if (sessionId) {
      entry.snapshot = await snapshot(sessionId).catch(failure => ({ error: redact(failure.message) }));
      await cli(["cancel", sessionId]).then(() => activeSessions.delete(sessionId)).catch(failure => { entry.recoveryError = redact(failure.message); });
    }
    if (observer.child && !observer.settled) observer.child.kill("SIGTERM");
    // Observe the original mutation outcome; never resubmit a failed create or message.
    await observer.finish().catch(() => {});
  } finally {
    entry.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    entry.events = observer.updates;
    report.tasks.push(entry); delete report.current; persist();
    console.log(JSON.stringify({ taskFinished: true, id: test.id, iteration, ok: entry.ok, elapsedSeconds: entry.elapsedSeconds, sessionId, error: entry.error }));
  }
}
function formAnswers(form, test) {
  return Object.fromEntries((form?.fields || []).map(field => {
    const choices = field.options || [];
    const match = choices.find(option => /hangzhou|yes|confirm|proceed|approve|walk|free|brief|summary|csv/i.test(`${option.label} ${option.value}`)) || choices[0];
    const value = test.answers?.[field.id] ?? (field.type === "multi_choice" ? [match?.value].filter(Boolean)
      : field.type === "single_choice" ? match?.value : field.defaultValue || "Hangzhou; concise, free options using public sources.");
    return [field.id, value];
  }));
}

async function selectEnglish(page) {
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="advanced"]').click();
  const select = page.locator("#i18n-language-select");
  if (await select.inputValue() !== "en") {
    await select.selectOption("en");
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator("#btn-save-settings").click()]);
  }
  await page.waitForFunction(() => document.documentElement.lang === "en" && !document.querySelector("#app")?.hasAttribute("data-workspace-booting"));
  await page.waitForFunction(async () => { const response = await chrome.runtime.sendMessage({ type: "get_content_language" }); return response.ok && response.result.locale === "en"; });
}

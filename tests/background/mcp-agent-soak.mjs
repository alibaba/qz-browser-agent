import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localFetch, readHealth, resultValue } from "../../services/mcp-bridge/src/client.mjs";
import { PROJECT_ROOT, launchIsolatedExtensionMcp, saveExtensionLlmConfig, assertNoUnexpectedDiagnostics } from "../support/isolated-extension-mcp.mjs";
import { closeCompletedTaskTabs } from "../support/mcp-soak-tab-cleanup.mjs";

// Manual, bounded soak. Default CI does not spend 30 minutes on this scenario.
const args = process.argv.slice(2);
const durationIndex = args.indexOf("--duration-seconds");
const durationSeconds = durationIndex < 0 ? 1800 : Number(args[durationIndex + 1]);
assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 7200);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDirectory = join(PROJECT_ROOT, "tests/results/mcp-bridge");
mkdirSync(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, `agent-soak-${stamp}.json`);
const downloadDirectory = mkdtempSync(join(tmpdir(), "qz-soak-downloads-"));
const report = { ok: false, phase: "setup", runnerPid: process.pid, requestedDurationSeconds: durationSeconds, scenarios: [], operations: [], health: [],
  fixture: "One isolated real Chromium extension/profile/service; real CLI child processes and a persistent MCP SDK connection. Model responses and web pages are synthetic local fixtures; no external AI service or user data.",
  failures: [], cliProcesses: 0, mcpCalls: 0, providerRequests: 0 };
const children = new Set();
const pending = new Set();
const sessions = new Set();
const client = new Client({ name: "qz-agent-soak", version: "1.0.0" });
let environment, transport, clientId, resources, startedAt, heartbeat;
let stopRequested = false;
const requestStop = signal => { stopRequested = true; report.stopRequested = signal; };
const terminate = () => requestStop("SIGTERM");
const interrupt = () => requestStop("SIGINT");
process.on("SIGTERM", terminate);
process.on("SIGINT", interrupt);
const fixture = await startFixture();
try {
  environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-agent-soak-", requestTimeoutSeconds: 45, downloadDirectory });
  clientId = environment.bridgeStatus.clients[0].clientId;
  report.endpoint = environment.bridge.endpoint;
  report.clientId = clientId;
  report.servicePid = environment.bridge.process.pid;
  await saveExtensionLlmConfig(environment.page, { provider: "custom", customProtocol: "openai", customEndpoint: fixture.endpoint,
    apiKey: "synthetic-soak-key", model: "deterministic-agent-soak", contextWindow: 128000,
    trimOldToolResults: true, vision: false, debugMode: false, requestRateLimit: false });
  transport = new StreamableHTTPClientTransport(new URL(environment.bridge.mcpUrl), { fetch: localFetch,
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
  await client.connect(transport);
  const catalogue = await client.listTools();
  assert.ok(catalogue.tools.some(tool => tool.name === "qingzhou_watch_task"));
  assert.ok(catalogue.tools.some(tool => tool.name === "qingzhou_get_tool_job"));
  report.mcpTools = catalogue.tools.length;
  await environment.connectionPage.close();
  const { prepareResources } = await import("../support/mcp-soak-resources.mjs");
  resources = await prepareResources({ environment, mcp, cli, outputDirectory: downloadDirectory, downloadDirectory });
  startedAt = Date.now();
  report.startedAt = new Date(startedAt).toISOString();
  report.expectedEndAt = new Date(startedAt + durationSeconds * 1000).toISOString();
  report.phase = "running";
  heartbeat = setInterval(() => { persist(); console.log(JSON.stringify({ heartbeat: true, elapsedSeconds: elapsed(), rounds: report.rounds || 0,
    scenarios: report.scenarios.length, operations: report.operations.length, cliProcesses: report.cliProcesses, mcpCalls: report.mcpCalls, failures: report.failures.length })); }, 30_000);
  console.log(JSON.stringify({ ready: true, startedAt: report.startedAt, expectedEndAt: report.expectedEndAt, reportPath, endpoint: report.endpoint, servicePid: report.servicePid }));
  persist();
  let round = 0;
  do {
    round++;
    await scenario("task-wait-stream-followup", round, () => simpleTasks(round));
    await scenario("cross-interface-form-steer", round, () => forms(round));
    if (round % 3 === 0) await scenario("queued-followup-across-form", round, () => queuedFollowup(round));
    await scenario("confirmation-approve-reject", round, () => confirmations(round));
    await scenario("browser-sync-async-tools", round, () => browserTools(round));
    await scenario("observer-cancel-and-input-errors", round, () => cancellation(round));
    if (resources) await scenario("resources-settings-exports", round, () => resources.iterate(round));
    await scenario("completed-task-tab-cleanup", round, () => completedTabs(round));
    const health = await readHealth(environment.bridge.endpoint);
    assert.equal(health.status.clientCount, 1);
    assert.equal(health.status.clients[0].clientId, clientId);
    report.health.push({ at: new Date().toISOString(), elapsedSeconds: elapsed(), clientCount: health.status.clientCount,
      sessions: sessions.size, polls: environment.pollRequests.length, harnessRssBytes: process.memoryUsage().rss });
    assertNoUnexpectedDiagnostics(environment.diagnostics);
    report.rounds = round;
    persist();
    await delay(1500);
  } while (!stopRequested && Date.now() - startedAt < durationSeconds * 1000);
  report.ok = !stopRequested;
  report.phase = stopRequested ? "interrupted" : "completed";
  report.completedRequestedDuration = Date.now() - startedAt >= durationSeconds * 1000;
} catch (error) {
  report.phase = "failed";
  report.failures.push({ at: new Date().toISOString(), message: error.message, stack: error.stack });
  console.error(JSON.stringify({ failed: true, reportPath, message: error.message, stack: error.stack }));
  report.failedSnapshots = [];
  for (const sessionId of [...sessions].slice(-3)) {
    try { report.failedSnapshots.push(await mcp("qingzhou_get_session_snapshot", { sessionId, compact: false, tail: false, includeArtifacts: false }, { timeout: 5000 })); }
    catch (snapshotError) { report.failedSnapshots.push({ sessionId, error: snapshotError.message }); }
  }
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  report.finishedAt = new Date().toISOString();
  report.actualDurationMs = startedAt ? Date.now() - startedAt : 0;
  report.elapsedSeconds = elapsed();
  persist();
  for (const child of children) child.kill("SIGTERM");
  await Promise.allSettled([...pending]);
  const cleanupErrors = [];
  await resources?.cleanup?.().catch(error => { cleanupErrors.push(error.message); });
  await transport?.terminateSession().catch(() => {});
  await client.close().catch(() => {});
  await environment?.close().catch(error => { cleanupErrors.push(error.message); });
  await fixture.close();
  rmSync(downloadDirectory, { recursive: true, force: true });
  report.cleanupSucceeded = cleanupErrors.length === 0;
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.ok = false; process.exitCode = 1; }
  process.off("SIGTERM", terminate);
  process.off("SIGINT", interrupt);
  persist();
  console.log(JSON.stringify({ finished: true, ok: report.ok, elapsedSeconds: report.elapsedSeconds, rounds: report.rounds,
    scenarios: report.scenarios.length, operations: report.operations.length, reportPath }));
}

function elapsed() { return startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0; }
function persist() {
  report.elapsedSeconds = elapsed();
  report.providerRequests = fixture.requests.length;
  writeFileSync(reportPath, JSON.stringify({ ...report, providerTrace: fixture.requests, diagnostics: environment?.diagnostics || [], bridgeLogs: environment?.bridge.logs || [] }, null, 2));
}
async function scenario(name, round, operation) {
  const at = Date.now();
  const result = await operation();
  report.scenarios.push({ name, round, ok: true, seconds: (Date.now() - at) / 1000, ...(result ? { result } : {}) });
  persist();
  await delay(750);
}
function marker(round, type) { return `QZ_SOAK_${String(round).padStart(4, "0")}_${type}`; }
function remember(created) { const id = created.session?.id || created.sessionId; assert.ok(id); sessions.add(id); return id; }
function text(snapshot) { return (snapshot.transcript || []).filter(entry => entry.type === "assistant").map(entry => contentText(entry.content)).join("\n"); }
function contentText(value) { return typeof value === "string" ? value : Array.isArray(value) ? value.filter(part => part.type === "text").map(part => part.text).join("\n") : ""; }
async function until(predicate, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(150); }
  throw new Error(`Timed out: ${description}`);
}
async function mcp(name, args = {}, options = {}) {
  const started = Date.now();
  report.mcpCalls++;
  const local = name === "qingzhou_get_tool_job";
  let result;
  try {
    result = await client.callTool({ name, arguments: { ...(!local ? { clientId, timeoutSeconds: 35 } : {}), ...args } }, undefined,
      { timeout: 90_000, resetTimeoutOnProgress: true, ...options });
  } catch (error) {
    report.operations.push({ channel: "mcp", name, ok: false, expectedCancellation: options.signal?.aborted === true, ms: Date.now() - started, error: error.message });
    throw error;
  }
  const value = resultValue(result);
  report.operations.push({ channel: "mcp", name, ok: !result.isError, expectedError: Boolean(options.expectedError), ms: Date.now() - started });
  if (result.isError && !options.expectedError) throw Object.assign(new Error(`MCP ${name}: ${JSON.stringify(value)}`), { details: value });
  if (options.expectedError) assert.equal(result.isError, true, `${name} must reject invalid input`);
  return value;
}
function trackingMcp(name, args, extra = {}) {
  const updates = [];
  const state = { settled: false, updates, value: null, error: null };
  const promise = mcp(name, args, { ...extra, onprogress: event => { if (event._meta?.["qz/task-event"]) updates.push(event._meta["qz/task-event"]); } })
    .then(value => { state.value = value; }, error => { state.error = error; }).finally(() => { state.settled = true; pending.delete(promise); });
  pending.add(promise);
  state.finish = async () => { await promise; if (state.error) throw state.error; return state.value; };
  return state;
}
function startCli(args, { humanOutput = false } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from "./services/mcp-bridge/src/cli.mjs";
    import { readHealth } from "./services/mcp-bridge/src/client.mjs";
    const endpoint = process.argv[1];
    process.exitCode = await main(process.argv.slice(2), {
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
      onTaskCreated: value => process.send({ type: "created", value }),
      onTaskUpdate: value => process.send({ type: "update", value }),
    });
    process.disconnect();
  `, "--", environment.bridge.endpoint, ...args, humanOutput ? "--plain" : "--json", ...(!["status", "mcp"].includes(args[0]) ? ["--client", clientId, "--timeout", "60"] : [])],
  { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  report.cliProcesses++;
  children.add(child);
  const state = { child, updates: [], created: null, stdout: "", stderr: "", settled: false };
  child.stdout.on("data", data => { state.stdout += data; });
  child.stderr.on("data", data => { state.stderr += data; });
  child.on("message", message => { if (message.type === "created") state.created = message.value; if (message.type === "update") state.updates.push(message.value); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 95_000);
  const promise = new Promise(resolve => { child.once("error", error => { state.error = error; resolve(); }); child.once("close", (code, signal) => { state.code = code; state.signal = signal; resolve(); }); })
    .finally(() => { clearTimeout(timer); state.settled = true; children.delete(child); pending.delete(promise); });
  pending.add(promise);
  state.finish = async ({ expectedError = false } = {}) => {
    await promise;
    if (state.error) throw state.error;
    report.operations.push({ channel: "cli", name: args.slice(0, 2).join(" "), ok: state.code === 0, expectedError, ms: Date.now() - started });
    if (expectedError) assert.ok(Number.isInteger(state.code) && state.code > 0, "invalid CLI requests must fail");
    else assert.equal(state.code, 0, `CLI ${args.join(" ")} failed: ${state.stdout}\n${state.stderr}`);
    if (humanOutput) return { stdout: state.stdout, created: state.created };
    const lines = state.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `CLI machine output must contain one JSON object: ${state.stdout}`);
    const result = JSON.parse(lines[0]);
    assert.equal(result.ok, !expectedError);
    return expectedError ? result.error : result.result;
  };
  return state;
}
async function cli(args, options) { return startCli(args).finish(options); }
async function input(id, kind) {
  return until(async () => { const value = await mcp("qingzhou_get_user_input", { sessionId: id });
    if (!value.waiting) return null;
    assert.equal(value.kind, kind); assert.equal(value.sessionId, id); assert.ok(value.runId); assert.ok(value.waitId); return value;
  }, `${kind} input for ${id}`);
}
async function simpleTasks(round) {
  const tag = marker(round, "BASIC");
  const streamed = startCli(["create", `Summarize the browser research workflow. [${tag}]`, "--title", tag, round % 2 ? "--stream" : "--wait"]);
  const result = await streamed.finish();
  const id = remember(result);
  assert.equal(result.snapshot.status, "completed");
  assert.match(text(result.snapshot), new RegExp(tag));
  if (round % 2) assert.ok(streamed.updates.some(update => update.type === "text"));
  const follow = marker(round, "FOLLOWUP");
  const sending = round % 2
    ? trackingMcp("qingzhou_send_message", { sessionId: id, text: `Make it shorter. [${follow}]`, stream: true })
    : startCli(["send", id, `Make it shorter. [${follow}]`, round % 4 ? "--stream" : "--wait"]);
  const sent = await sending.finish();
  assert.equal(sent.snapshot.status, "completed"); assert.ok(sent.clientMessageId);
  assert.equal(sent.snapshot.transcript.filter(entry => entry.clientMessageId === sent.clientMessageId).length, 1);
  assert.ok((await cli(["tasks", "--limit", "100"])).sessions.some(session => session.id === id));
  assert.equal((await cli(["show", id])).sessionId, id);
  assert.equal(fixture.count(tag), 1); assert.equal(fixture.count(follow), 1);
  return { sessionId: id, clientMessageId: sent.clientMessageId };
}
async function forms(round) {
  const tag = marker(round, "FORM");
  const observer = trackingMcp("qingzhou_create_session", { title: tag, firstMessage: `Ask which city and output format I want. [${tag}]`, stream: true });
  const event = await until(() => { if (observer.error) throw observer.error; return observer.updates.find(update => update.type === "input"); }, "MCP form progress");
  const id = event.sessionId; sessions.add(id);
  const form = (await cli(["show", id])).input;
  assert.ok(form, "qz show exposes the pending input without a second command");
  assert.deepEqual(form.form.fields.map(field => field.id), ["city", "formats"]);
  assert.equal(form.waitId, event.waitId);
  const wrong = await mcp("qingzhou_respond_to_user_input", { sessionId: id, waitId: "stale-soak-wait", action: "submit", answers: { city: "Hangzhou", formats: ["csv"] } });
  assert.equal(wrong.accepted, false);
  assert.equal((await input(id, "form")).waitId, form.waitId);
  const steerTag = marker(round, "STEER");
  const steering = startCli(["send", id, `Focus on walkable places. [${steerTag}]`, "--steer", "--stream"]);
  await until(() => { assert.equal(steering.settled, false); return steering.updates.find(update => update.type === "input" && update.waitId === form.waitId); }, "CLI steering retains form");
  await delay(1000);
  assert.equal(observer.settled, false); assert.equal(steering.settled, false);
  const submitted = await cli(["submit", id, JSON.stringify({ city: "Hangzhou", formats: ["csv", "html"] }), "--wait-id", form.waitId, "--wait"]);
  assert.equal(submitted.snapshot.status, "completed");
  const [created, steered] = await Promise.all([observer.finish(), steering.finish()]);
  assert.equal(created.snapshot.status, "completed"); assert.equal(steered.snapshot.status, "completed");
  assert.equal(steered.deliveryMode, "steer");
  assert.equal(steered.snapshot.runId, form.runId);
  assert.equal(steered.snapshot.transcript.filter(entry => entry.clientMessageId === steered.clientMessageId).length, 1);
  assert.equal(fixture.count(tag), 1); assert.equal(fixture.count(steerTag), 1);
  return { sessionId: id, waitId: form.waitId, runId: form.runId };
}
async function confirmations(round) {
  const tag = marker(round, "CONFIRM");
  const humanOutput = round % 2 === 1;
  const waiting = startCli(["create", `Ask me to confirm before preparing the report. [${tag}]`, "--stream"], { humanOutput });
  await until(() => waiting.created, "CLI created confirmation task");
  const id = remember(waiting.created);
  const confirmation = await input(id, "confirmation");
  await delay(1000); assert.equal(waiting.settled, false);
  const action = round % 2 ? "approve" : "reject";
  const result = await mcp("qingzhou_respond_to_user_input", { ...confirmation.responseTemplate, action, wait: true });
  assert.equal(result.snapshot.status, "completed");
  const finished = await waiting.finish();
  if (humanOutput) {
    assert.match(finished.stdout, /Confirm preparing this synthetic report/);
    assert.ok(finished.stdout.includes(`qz approve ${id}`));
    assert.ok(finished.stdout.includes(`${tag}: Research task completed`));
  } else assert.equal(finished.snapshot.status, "completed");
  const stale = await mcp("qingzhou_respond_to_user_input", { ...confirmation.responseTemplate, action });
  assert.equal(stale.accepted, false);
  assert.equal(fixture.count(tag), 2);
  return { sessionId: id, action, output: humanOutput ? "plain" : "json" };
}
async function queuedFollowup(round) {
  const tag = marker(round, "QUEUEDFORM");
  const id = remember(await cli(["create", `Ask which city and output format I want. [${tag}]`]));
  const form = await input(id, "form");
  const next = marker(round, "QUEUEDFOLLOWUP");
  const sending = trackingMcp("qingzhou_send_message", { sessionId: id, text: `Add a concise summary. [${next}]`, stream: true });
  await until(() => { if (sending.error) throw sending.error; return sending.updates.find(event => event.type === "input" && event.waitId === form.waitId); }, "queued follow-up keeps preceding form actionable");
  assert.equal(fixture.count(next), 0);
  await cli(["submit", id, JSON.stringify({ city: "Hangzhou", formats: ["csv"] }), "--wait-id", form.waitId]);
  const result = await sending.finish();
  assert.equal(result.disposition, "queued");
  assert.equal(result.snapshot.status, "completed");
  assert.notEqual(result.snapshot.runId, form.runId);
  assert.equal(result.snapshot.transcript.filter(entry => entry.clientMessageId === result.clientMessageId).length, 1);
  assert.equal(fixture.count(tag), 2); assert.equal(fixture.count(next), 1);
  assert.equal(sending.updates.filter(event => event.type === "text").map(event => event.text).join(""), `${next}: Research task completed with the requested scope.`);
  return { sessionId: id, previousRunId: form.runId, runId: result.snapshot.runId };
}
async function browserTools(round) {
  const id = remember(await mcp("qingzhou_create_session", { title: `Browser research ${round}` }));
  const schema = await mcp("qingzhou_get_tool", { name: "open_tab", sessionId: id });
  assert.equal(schema.name, "open_tab"); assert.equal(schema.parameters.properties.url.type, "string");
  const url = `${fixture.baseUrl}/research/${round}`;
  const opened = await mcp("qingzhou_execute_tool", { sessionId: id, name: "open_tab", args: { url } });
  const tabId = opened.result.id; assert.equal(opened.result.url, url);
  const job = await mcp("qingzhou_execute_tool", { sessionId: id, name: "read_article", args: { tabId, source: "body", limit: 4000 }, wait: false });
  assert.ok(job.jobId);
  const complete = await until(async () => { const result = await mcp("qingzhou_get_tool_job", { jobId: job.jobId, includeResult: true }); return result.status === "completed" || result.status === "failed" ? result : null; }, "async tool result");
  assert.equal(complete.status, "completed", JSON.stringify(complete));
  assert.match(JSON.stringify(complete.result), new RegExp(`Research fixture ${round}`));
  const second = await mcp("qingzhou_execute_tool", { sessionId: id, name: "read_article", args: { tabId, source: "body", limit: 4000 } });
  assert.match(second.result.text, new RegExp(`Research fixture ${round}`));
  const snapshot = await cli(["show", id]);
  assert.ok(snapshot.runtime.ownedTabIds.includes(tabId));
  const closed = await mcp("qingzhou_execute_tool", { sessionId: id, name: "close_tab", args: { tabId } });
  assert.equal(closed.result.closed, tabId);
  await cli(["cancel", id]);
  return { sessionId: id, tabId, jobId: job.jobId };
}
async function completedTabs(round) {
  const sessionId = report.scenarios.find(item => item.round === round && item.name === "task-wait-stream-followup").result.sessionId;
  const before = await cli(["show", sessionId]);
  const opened = await mcp("qingzhou_execute_tool", { sessionId, name: "open_tab", args: { url: `${fixture.baseUrl}/cleanup/${round}` } });
  const protectedResult = await closeCompletedTaskTabs({ mcp, sessionIds: [sessionId], activeSessionIds: [sessionId] });
  assert.equal(protectedResult.closed.length, 0, "active task exclusion preserves its tabs");
  assert.ok((await cli(["show", sessionId])).runtime.ownedTabIds.includes(opened.result.id));
  const result = await closeCompletedTaskTabs({ mcp, sessionIds: [...sessions] });
  assert.deepEqual(result.errors, []);
  assert.ok(result.closed.some(item => item.sessionId === sessionId && item.tabId === opened.result.id));
  const after = await cli(["show", sessionId]);
  assert.ok(!after.runtime.ownedTabIds.includes(opened.result.id));
  assert.deepEqual(after.transcript, before.transcript, "tab cleanup preserves task history");
  return result;
}
async function cancellation(round) {
  const invalid = await mcp("qingzhou_create_session", { firstMesage: "must not create a task" }, { expectedError: true });
  assert.equal(invalid.code, "invalid_arguments");
  const invalidCli = await cli(["send", "missing-session", "test", "--steeer"], { expectedError: true });
  assert.equal(invalidCli.code, "invalid_arguments");
  const tag = marker(round, "CANCEL");
  const id = remember(await mcp("qingzhou_create_session", { title: tag, firstMessage: `Wait for my choice. [${tag}]` }));
  const form = await input(id, "form");
  const controller = new AbortController();
  const observing = trackingMcp("qingzhou_watch_task", { sessionId: id, stream: true }, { signal: controller.signal });
  await until(() => observing.updates.some(update => update.type === "input"), "cancellable MCP observer");
  controller.abort();
  await assert.rejects(observing.finish());
  assert.equal((await input(id, "form")).waitId, form.waitId, "observer cancellation must preserve browser task");
  const stopped = await cli(["cancel", id]); assert.equal(stopped.sessionId, id);
  const stale = await mcp("qingzhou_respond_to_user_input", { ...form.responseTemplate, answers: { city: "Hangzhou", formats: ["csv"] } });
  assert.equal(stale.accepted, false, "stopped tasks reject late form responses");
  assert.equal(fixture.count(tag), 1, "cancellation cannot replay the model request");
  const snapshot = await cli(["show", id]);
  assert.ok(["stopped", "cancelled", "aborted", "interrupted", "idle"].includes(snapshot.status), JSON.stringify({ status: snapshot.status, runtime: snapshot.runtime }));
  return { sessionId: id, waitId: form.waitId, status: snapshot.status };
}
async function startFixture() {
  const requests = [];
  let baseUrl;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      const id = request.url?.split("/").at(-1) || "index";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>Research fixture ${id}</title><main><h1>Research fixture ${id}</h1><p>Hangzhou has West Lake, museums and walkable neighbourhoods. Compare sources before planning a visit.</p><table><tr><th>Place</th><th>Type</th></tr><tr><td>West Lake</td><td>Public landscape</td></tr></table></main>`); return;
    }
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const tag = body.messages.filter(message => message.role === "user").map(message => contentText(message.content).match(/QZ_SOAK_\d+_[A-Z]+/)?.[0]).filter(Boolean).at(-1) || "validation";
      const results = body.messages.filter(message => message.role === "tool").map(message => ({ id: message.tool_call_id, content: contentText(message.content) }));
      requests.push({ at: new Date().toISOString(), tag, stream: body.stream === true, resultIds: results.map(result => result.id) });
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "soak-validation", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Soak fixture" }, finish_reason: "stop" }] })); return;
      }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: tag, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const toolId = `${tag}_input`;
      const needsInput = /_(FORM|QUEUEDFORM|CANCEL|CONFIRM)$/.test(tag) && !results.some(result => result.id === toolId);
      if (needsInput) {
        const confirmation = tag.endsWith("_CONFIRM");
        const args = confirmation ? { message: "Confirm preparing this synthetic report." } : { title: "Choose the research scope", message: "Select a city and output formats.", fields: [
          { id: "city", label: "City", type: "text", required: true },
          { id: "formats", label: "Formats", type: "multi_choice", required: true, options: [{ label: "CSV", value: "csv" }, { label: "HTML", value: "html" }] },
        ] };
        send({ role: "assistant", tool_calls: [{ index: 0, id: toolId, type: "function", function: { name: confirmation ? "wait_for_user" : "ask_user", arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: `${tag}: ` }); await delay(250);
        send({ content: "Research task completed with the requested scope." }); await delay(250); send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      requests.push({ error: error.message }); if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, endpoint: `${baseUrl}/v1/chat/completions`, requests,
    count: tag => requests.filter(request => request.tag === tag && request.stream).length,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

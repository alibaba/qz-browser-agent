import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { callTool, localFetch, readHealth, resultValue } from "../../services/mcp-bridge/src/client.mjs";
import {
  PROJECT_ROOT, assertNoUnexpectedDiagnostics,
  launchIsolatedExtensionMcp, saveExtensionLlmConfig,
} from "../support/isolated-extension-mcp.mjs";

const report = { ok: false, scenario: "mcp-cli-user-input", cases: [], mocks: [
  "Local deterministic OpenAI-compatible provider; no real model or external website.",
  "Native history permission and history API are simulated inside the isolated profile; the real Side Panel button, Background permission guard, wait lifecycle and tool execution run unchanged.",
  "navigator.geolocation returns synthetic coordinates after the real location-consent flow.",
] };
const fixture = await startFixture();
let environment;
let command;
let respond;
let clientId;
const cliProcesses = new Set();
const toolCalls = [];
try {
  environment = await launchIsolatedExtensionMcp({ profilePrefix: "qz-user-input-e2e-", requestTimeoutSeconds: 40 });
  clientId = environment.bridgeStatus.clients[0].clientId;
  const observedCall = (...args) => {
    toolCalls.push(args[1]);
    return callTool(...args);
  };
  const dependencies = {
    findDaemon: async () => ({ endpoint: environment.bridge.endpoint, health: await readHealth(environment.bridge.endpoint) }),
    callTool: observedCall,
  };
  command = async (args, extra = {}) => (await runCli([...args, "--client", clientId, "--timeout", "30"], { ...dependencies, ...extra })).result;
  respond = args => observedCall(environment.bridge.endpoint, "qingzhou_respond_to_user_input", { clientId, ...args });
  await saveExtensionLlmConfig(environment.page, {
    provider: "custom", customProtocol: "openai", customEndpoint: fixture.endpoint,
    apiKey: "synthetic-user-input-key", model: "deterministic-model", contextWindow: 128000,
    trimOldToolResults: true, vision: false, debugMode: false,
  });
  await formsRoundTrip();
  await selfContainedRecovery();
  await submitAndWait();
  await queuedFollowupStream();
  await steerCurrentRun();
  await timeoutRecovery();
  await confirmations();
  await permissionGuidance();
  await locationConsent();
  await mcpStreamingParity();
  assertNoUnexpectedDiagnostics(environment.diagnostics);
  report.ok = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  try {
    const directory = join(PROJECT_ROOT, "tests/results/mcp-bridge");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "user-input-e2e.json"), JSON.stringify({
      ...report, providerRequests: fixture.requests,
      diagnostics: environment?.diagnostics || [], logs: environment?.bridge.logs || [],
    }, null, 2));
  } finally {
    for (const child of cliProcesses) child.kill("SIGTERM");
    await environment?.close().catch(() => undefined);
    await fixture.close();
  }
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

async function waitForInput(sessionId, kind, previousWaitId = "") {
  return waitUntil(async () => {
    const input = (await command(["show", sessionId])).input;
    if (!input.waiting || input.waitId === previousWaitId) return null;
    assert.equal(input.sessionId, sessionId);
    assert.equal(input.kind, kind);
    assert.ok(input.waitId);
    assert.ok(input.runId);
    return input;
  }, `Task ${sessionId} did not reach its ${kind} wait`);
}

async function waitForSnapshotInput(sessionId, kind, previousWaitId = "") {
  return waitUntil(async () => {
    const snapshot = await command(["show", sessionId]);
    const input = snapshot.input;
    if (!input?.waiting || input.waitId === previousWaitId) return null;
    assert.equal(input.sessionId, sessionId);
    assert.equal(input.kind, kind);
    assert.equal(input.waitId, snapshot.runtime.waitId);
    assert.equal(input.runId, snapshot.runId || snapshot.runtime.runId);
    return input;
  }, `Task ${sessionId} did not expose its ${kind} input in the snapshot`);
}

async function createWaiting(marker, kind) {
  const created = await command(["create", marker, "--title", marker]);
  const sessionId = created.session.id;
  return { sessionId, input: await waitForInput(sessionId, kind) };
}

function trackCommand(args, extra = {}) {
  const tracked = { settled: false, result: null, error: null };
  tracked.done = command(args, extra).then(result => {
    tracked.settled = true;
    tracked.result = result;
  }, error => {
    tracked.settled = true;
    tracked.error = error;
  });
  tracked.finish = async () => {
    await tracked.done;
    if (tracked.error) throw tracked.error;
    return tracked.result;
  };
  return tracked;
}

// Exercise the real CLI entry point in a separate process. Only daemon discovery is
// injected so the child uses this isolated browser instead of the developer's service.
function startCliProcess(args, { timeout = 30 } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from "./services/mcp-bridge/src/cli.mjs";
    import { readHealth } from "./services/mcp-bridge/src/client.mjs";
    const endpoint = process.argv[1];
    const exitCode = await main(process.argv.slice(2), {
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
      onTaskCreated: value => process.send({ type: "created", value }),
      onTaskUpdate: value => process.send({ type: "update", value }),
    });
    process.exitCode = exitCode;
    process.disconnect();
  `, "--", environment.bridge.endpoint, ...args, "--timeout", String(timeout)], {
    cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  cliProcesses.add(child);
  const tracked = { child, created: null, updates: [], stdout: "", stderr: "", settled: false, error: null };
  child.stdout.on("data", chunk => { tracked.stdout += chunk; });
  child.stderr.on("data", chunk => { tracked.stderr += chunk; });
  child.on("message", event => {
    if (event.type === "created") tracked.created = event.value;
    if (event.type === "update") tracked.updates.push(event.value);
  });
  tracked.done = new Promise(resolve => {
    child.once("error", error => { tracked.error = error; tracked.settled = true; resolve(); });
    child.once("close", (code, signal) => {
      cliProcesses.delete(child);
      tracked.code = code;
      tracked.signal = signal;
      tracked.settled = true;
      resolve();
    });
  });
  tracked.envelope = async () => {
    await tracked.done;
    if (tracked.error) throw tracked.error;
    const lines = tracked.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "machine output must contain one final JSON result");
    return JSON.parse(lines[0]);
  };
  tracked.finish = async () => {
    const output = await tracked.envelope();
    assert.equal(tracked.code, 0, `CLI failed: ${tracked.stdout}\n${tracked.stderr}`);
    assert.equal(output.ok, true);
    return output.result;
  };
  return tracked;
}

async function waitForObservedRun(tracked, runId) {
  return waitUntil(() => {
    assert.equal(tracked.settled, false, `Observer ended before run ${runId}: ${tracked.stdout || tracked.error || ""}`);
    return tracked.updates.find(event => event.type === "status" && event.runId === runId && event.status === "running");
  }, `Observer did not follow run ${runId}`);
}

async function assertStillWaiting(tracked, message) {
  // Two poll intervals ensure an implementation that returns on waiting_user is observed.
  await delay(1600);
  assert.equal(tracked.settled, false, message);
}

async function unchangedWait(sessionId, waitId, marker, requestsBefore) {
  const input = (await command(["show", sessionId])).input;
  assert.equal(input.waiting, true);
  assert.equal(input.waitId, waitId, "an invalid response must preserve the current wait");
  assert.equal(fixture.count(marker), requestsBefore, "invalid input must not resume the model");
}

async function formsRoundTrip() {
  const marker = "QZ_INPUT_FORMS";
  const watching = startCliProcess(["create", marker, "--title", marker, "--stream", "--json"]);
  await waitUntil(() => {
    assert.equal(watching.settled, false, `create --stream exited before its form: ${watching.stdout}`);
    return watching.created;
  }, "Streaming CLI did not report its created task");
  const sessionId = watching.created.session.id;
  const input = await waitForInput(sessionId, "form");
  await assertStillWaiting(watching, "create --stream must remain alive at the first form");
  assert.equal(watching.stdout, "", "JSON stdout stays empty while a task is waiting");
  assert.deepEqual(input.form.fields.map(field => field.type), ["text", "textarea", "single_choice", "multi_choice"]);
  assert.equal(input.form.fields[3].presentation, "cards");
  assert.deepEqual(input.form.fields[3].options.map(option => option.value), ["northstar", "harbor"]);
  assert.match(input.form.fields[3].options[1].imageUrl, /\/card.png$/);
  assert.deepEqual(input.actions, ["submit", "reject"]);
  assert.deepEqual(await waitForSnapshotInput(sessionId, "form"), input,
    "the snapshot carries the same actionable input as the dedicated input endpoint");
  assert.deepEqual(input.responseTemplate, {
    sessionId, waitId: input.waitId, action: "submit", clientId,
    answers: { name: "<text>", notes: "<text>", route: "<option value>", roles: ["<option value>"] },
  });
  await switchToSession(sessionId);
  const card = environment.page.locator(`.waiting-active[data-wait-id="${input.waitId}"]`);
  await card.waitFor();
  assert.equal(await card.locator(".qz-choice-card").count(), 2);
  const count = fixture.count(marker);
  const valid = { name: "Ada", notes: "Remote\nTwo days per week", route: "local", roles: ["harbor"] };
  for (const answers of [{}, { ...valid, route: "missing" }, { ...valid, roles: ["missing"] }]) {
    const invalid = await respond({ sessionId, waitId: input.waitId, action: "submit", answers });
    assert.equal(invalid.accepted, false);
    assert.ok(invalid.fieldErrors?.length, "invalid fields must be identified for the caller");
    assert.deepEqual(invalid.input, input, "validation errors carry all information needed to correct the reply");
    await unchangedWait(sessionId, input.waitId, marker, count);
  }
  const invalidApprove = await command(["approve", sessionId, "--wait-id", input.waitId]);
  assert.equal(invalidApprove.accepted, false, "approve cannot bypass a required form");
  await unchangedWait(sessionId, input.waitId, marker, count);

  const first = trackCommand(["submit", sessionId, JSON.stringify(valid), "--wait-id", input.waitId, "--wait"]);
  const next = await waitForInput(sessionId, "form", input.waitId);
  await assertStillWaiting(first, "submit --wait must remain alive at the next question");
  assert.equal(watching.settled, false, "the original create --stream must follow the second question");
  assert.notEqual(next.waitId, input.waitId);
  assert.equal(next.form.fields[0].presentation, "cards");
  const stale = await respond({ sessionId, waitId: input.waitId, action: "submit", answers: valid });
  assert.equal(stale.accepted, false, "the previous wait cannot answer the next question");
  assert.deepEqual(stale.input, next, "a stale reply returns the current form, not the obsolete one");
  assert.equal(stale.input.responseTemplate.waitId, next.waitId);
  await unchangedWait(sessionId, next.waitId, marker, count + 1);

  const updates = [];
  let receivedWhileStreaming = false;
  const second = await command(["submit", sessionId, JSON.stringify({ choice: "report", formats: ["html", "csv"] }),
    "--wait-id", next.waitId, "--stream"], { onTaskUpdate: event => {
    updates.push(event);
    if (event.type === "text" && !fixture.finished.has(marker)) receivedWhileStreaming = true;
  } });
  assert.equal(second.accepted, true);
  assert.equal(second.snapshot.status, "completed");
  const firstResult = await first.finish();
  assert.equal(firstResult.accepted, true);
  assert.equal(firstResult.snapshot.status, "completed");
  const watched = await watching.finish();
  assert.equal(watched.snapshot.status, "completed");
  const pendingIds = watching.updates.filter(event => event.type === "input").map(event => event.waitId);
  assert.deepEqual(pendingIds, [input.waitId, next.waitId], "each pending form must be shown once across polling");
  for (const pending of [input, next]) {
    const event = watching.updates.find(event => event.type === "input" && event.waitId === pending.waitId);
    assert.deepEqual(event.form, pending.form);
    assert.deepEqual(event.responseTemplate, pending.responseTemplate, "stream consumers can reply directly from the input event");
  }
  assert.match(watching.stderr, /Field ID/, "machine callers see exact response field IDs on stderr");
  assert.match(watching.stderr, /Value/, "choice values are distinct from display labels");
  for (const value of ['"name"', '"route"', '"roles"', '"choice"', '"formats"', input.waitId, next.waitId]) {
    assert.ok(watching.stderr.includes(value), `stderr must contain the actionable response value ${value}`);
  }
  const output = updates.filter(event => event.type === "text").map(event => event.text).join("");
  assert.equal(output, `${marker}: answers received.`);
  assert.equal(receivedWhileStreaming, true, "submit --stream must deliver text before completion");
  const duplicate = await respond({ sessionId, waitId: next.waitId, action: "submit", answers: { choice: "report", formats: ["html"] } });
  assert.equal(duplicate.accepted, false);
  assert.equal(((await command(["show", sessionId])).input).waiting, false);
  assert.deepEqual(fixture.toolResult(marker, 1).answers, valid);
  assert.deepEqual(fixture.toolResult(marker, 2).answers, { choice: "report", formats: ["html", "csv"] });
  assert.equal(fixture.count(marker), 3, "each accepted response resumes exactly once");
  report.cases.push({ name: "form-validation-cards-multiple-waits-live-cli-stream", ok: true, sessionId, chunks: updates.filter(event => event.type === "text").length, processStayedAliveAcrossWaits: 2 });
}

async function selfContainedRecovery() {
  const marker = "QZ_INPUT_SELF_CONTAINED";
  const firstCall = toolCalls.length;
  const created = await command(["create", marker, "--title", marker]);
  const sessionId = created.session.id;
  const input = await waitForSnapshotInput(sessionId, "form");
  assert.deepEqual(input.form.fields.map(field => field.id), ["project_scope", "run_mode", "output_formats"]);
  assert.deepEqual(input.form.fields[2].defaultValue, ["csv"], "ask_user normalizes multi-choice defaults into defaultValue");
  assert.deepEqual(input.form.fields[1].options.map(({ value, label }) => ({ value, label })), [
    { value: "local", label: "Local research" }, { value: "remote", label: "Remote analysis" },
  ]);
  assert.deepEqual(input.responseTemplate, {
    sessionId, waitId: input.waitId, action: "submit", clientId,
    answers: { project_scope: "browser-only", run_mode: "<option value>", output_formats: ["csv"] },
  });
  const invalid = await respond({
    ...input.responseTemplate,
    answers: { ...input.responseTemplate.answers, run_mode: "Local research" },
  });
  assert.equal(invalid.accepted, false);
  assert.ok(invalid.fieldErrors.some(error => error.fieldId === "run_mode" && error.code === "INVALID_OPTION"));
  assert.deepEqual(invalid.input, input);
  // Build the corrected wire payload solely from the rejected response, without another input lookup.
  const corrected = structuredClone(invalid.input.responseTemplate);
  const fields = invalid.input.form.fields;
  corrected.answers.run_mode = fields.find(field => field.id === "run_mode").options[0].value;
  assert.deepEqual(corrected.answers.output_formats, ["csv"], "the normalized multi-choice default survives recovery unchanged");
  assert.equal(corrected.clientId, clientId, "the replay template retains the selected browser");
  assert.equal((await respond(corrected)).accepted, true);
  const watched = await command(["watch", sessionId]);
  assert.equal(watched.snapshot.status, "completed");
  assert.deepEqual(fixture.toolResult(marker, 1).answers, { project_scope: "browser-only", run_mode: "local", output_formats: ["csv"] });
  assert.equal(toolCalls.slice(firstCall).filter(name => name === "qingzhou_get_user_input").length, 0,
    "snapshot and rejected-response input must eliminate a separate input discovery call");
  report.cases.push({ name: "snapshot-and-rejected-reply-self-contained-recovery", ok: true, sessionId, inputDiscoveryCalls: 0 });
}

async function submitAndWait() {
  const marker = "QZ_INPUT_WAIT";
  const watching = startCliProcess(["create", marker, "--title", marker, "--wait", "--json"]);
  await waitUntil(() => {
    assert.equal(watching.settled, false, `create --wait exited before its form: ${watching.stdout}`);
    return watching.created;
  }, "Waiting CLI did not report its created task");
  const sessionId = watching.created.session.id;
  await waitForInput(sessionId, "form");
  await assertStillWaiting(watching, "create --wait must remain alive until an independent answer");
  const submitted = await command(["submit", sessionId, "-", "--wait"], { readStdin: async () => JSON.stringify({ note: "Completed through stdin" }) });
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.snapshot.status, "completed");
  assert.match(assistantText(submitted.snapshot), /QZ_INPUT_WAIT: answers received/);
  assert.equal(fixture.toolResult(marker, 1).answers.note, "Completed through stdin");
  const watched = await watching.finish();
  assert.equal(watched.snapshot.status, "completed");
  report.cases.push({ name: "create-wait-stays-alive-submit-stdin-wait", ok: true, sessionId });
}

async function mcpStreamingParity() {
  const marker = "QZ_INPUT_MCP_FORMS";
  const followup = "QZ_INPUT_MCP_FOLLOWUP";
  const client = new Client({ name: "qz-parity-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", environment.bridge.endpoint), { fetch: localFetch });
  const controller = new AbortController();
  const pending = [];
  const stream = (name, args) => {
    const tracked = { settled: false, updates: [] };
    tracked.done = client.callTool({ name, arguments: { clientId, timeoutSeconds: 10, waitTimeoutSeconds: 30, stream: true, ...args } }, undefined, {
      signal: controller.signal, timeout: 40_000,
      onprogress: progress => { if (progress._meta?.["qz/task-event"]) tracked.updates.push(progress._meta["qz/task-event"]); },
    }).then(result => { tracked.value = resultValue(result); tracked.isError = result.isError; }, error => { tracked.error = error; })
      .finally(() => { tracked.settled = true; });
    pending.push(tracked.done);
    tracked.finish = async () => {
      await tracked.done;
      if (tracked.error) throw tracked.error;
      assert.ok(!tracked.isError, JSON.stringify(tracked.value));
      return tracked.value;
    };
    return tracked;
  };
  const inputEvent = (tracked, previous = "") => waitUntil(() => {
    assert.equal(tracked.settled, false, `MCP finished before input: ${JSON.stringify(tracked.value)}`);
    return tracked.updates.find(event => event.type === "input" && event.waitId !== previous);
  }, "MCP did not stream its actionable input");
  try {
    await client.connect(transport);
    const creation = stream("qingzhou_create_session", { title: marker, firstMessage: marker });
    const first = await inputEvent(creation);
    const sessionId = first.sessionId;
    assert.equal(first.clientId, clientId);
    assert.equal(first.responseTemplate.clientId, clientId);
    assert.equal(first.responseTemplate.waitId, first.waitId);
    assert.deepEqual(first.form.fields.map(field => field.id), ["name", "notes", "route", "roles"]);
    await assertStillWaiting(creation, "MCP create must keep waiting at the form");
    const answers = { name: "Ada", notes: "MCP and CLI", route: "local", roles: ["harbor"] };
    const submission = stream("qingzhou_respond_to_user_input", { ...first.responseTemplate, answers });
    const second = await inputEvent(submission, first.waitId);
    assert.equal(second.sessionId, sessionId);
    assert.equal(second.responseTemplate.waitId, second.waitId);
    await assertStillWaiting(submission, "MCP response must keep waiting at the next form");
    const watching = stream("qingzhou_watch_task", { sessionId });
    const watchedInput = await inputEvent(watching);
    assert.equal(watchedInput.waitId, second.waitId);
    const queued = await command(["send", sessionId, followup]);
    assert.equal(queued.accepted, true);
    assert.equal(queued.disposition, "queued");
    // Complete the MCP task from the CLI, using only IDs and fields received in MCP progress.
    const cliResponse = trackCommand(["submit", sessionId, JSON.stringify({ choice: "report", formats: ["csv"] }),
      "--wait-id", second.waitId, "--wait"]);
    await waitUntil(() => fixture.count(followup) === 1, "MCP observers did not reach the queued follow-up");
    const nextRunId = (await command(["show", sessionId])).runId;
    assert.notEqual(nextRunId, first.runId);
    await Promise.all([creation, submission, watching].map(tracked => waitForObservedRun(tracked, nextRunId)));
    assert.equal(cliResponse.settled, false, "CLI response also waits for queued work");
    fixture.release(followup);
    const cliResult = await cliResponse.finish();
    assert.equal(cliResult.snapshot.status, "completed");
    assert.equal(cliResult.snapshot.runId, nextRunId);
    for (const tracked of [creation, submission, watching]) {
      const completed = await tracked.finish();
      assert.equal(completed.snapshot.status, "completed");
      assert.equal(completed.snapshot.runId, nextRunId);
      assert.equal(tracked.updates.filter(event => event.type === "text").map(event => event.text).join(""),
        `${marker}: answers received.${followup}: answers received.`);
    }
    assert.deepEqual(creation.updates.filter(event => event.type === "input").map(event => event.waitId), [first.waitId, second.waitId]);
    assert.equal(fixture.count(marker), 3, "parallel observers must never replay a mutation");
    assert.equal(fixture.count(followup), 1);
    assert.deepEqual(fixture.toolResult(marker, 1).answers, answers);
    report.cases.push({ name: "mcp-create-response-watch-progress-cli-completion-and-followup", ok: true, sessionId,
      observers: 3, inputRounds: 2, runIds: [first.runId, nextRunId] });
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    await transport.terminateSession().catch(() => {});
    await client.close();
  }
}

async function confirmations() {
  for (const action of ["approve", "reject"]) {
    const marker = `QZ_INPUT_${action.toUpperCase()}`;
    const { sessionId, input } = await createWaiting(marker, "confirmation");
    assert.deepEqual(input.actions, ["approve", "reject"]);
    assert.deepEqual(input.responseTemplate, { sessionId, waitId: input.waitId, action: "approve", clientId });
    const result = await command([action, sessionId, "--wait-id", input.waitId, "--wait"]);
    assert.equal(result.accepted, true);
    const snapshot = result.snapshot || (await command(["watch", sessionId])).snapshot;
    assert.equal(snapshot.status, "completed");
    assert.match(assistantText(snapshot), new RegExp(`${marker}: answers received`));
    const tool = fixture.toolResult(marker, 1);
    if (action === "approve") assert.equal(tool.continued, true);
    else assert.equal(tool.code, "USER_CANCELLED_WAIT");
    const stale = await respond({ sessionId, waitId: input.waitId, action });
    assert.equal(stale.accepted, false);
    report.cases.push({ name: `confirmation-${action}`, ok: true, sessionId });
  }
}

async function queuedFollowupStream() {
  const marker = "QZ_INPUT_SEND_WAIT";
  const followup = "QZ_INPUT_SEND_FOLLOWUP";
  const nextFollowup = "QZ_INPUT_SEND_NEXT_FOLLOWUP";
  const creating = startCliProcess(["create", marker, "--client", clientId, "--stream", "--json"]);
  await waitUntil(() => {
    assert.equal(creating.settled, false, `Creation ended before its form: ${creating.stdout}`);
    return creating.created;
  }, "Creation did not report its task");
  const sessionId = creating.created.session.id;
  const input = await waitForInput(sessionId, "form");
  const watching = startCliProcess(["watch", sessionId, "--client", clientId, "--stream", "--json"]);
  const sending = startCliProcess(["send", sessionId, followup, "--client", clientId, "--stream", "--json"]);
  const pending = await waitUntil(() => {
    assert.equal(sending.settled, false, `send --stream exited while its message was queued: ${sending.stdout}\n${sending.stderr}`);
    return sending.updates.find(event => event.type === "input" && event.waitId === input.waitId);
  }, "Queued send did not expose the preceding run's pending form");
  assert.deepEqual(pending.form, input.form);
  assert.deepEqual(pending.responseTemplate, input.responseTemplate);
  assert.equal(sending.stdout, "", "queued JSON output stays empty until all accepted work completes");
  await unchangedWait(sessionId, input.waitId, marker, 1);
  assert.equal(fixture.count(followup), 0, "a follow-up cannot start before the existing form resolves");

  const responseUpdates = [];
  const answering = trackCommand(["submit", sessionId, JSON.stringify({ note: "Finish the existing task first" }),
    "--wait-id", input.waitId, "--wait"], { onTaskUpdate: event => responseUpdates.push(event) });
  answering.updates = responseUpdates;
  await waitUntil(() => fixture.count(followup) === 1, "The queued follow-up did not start a new model run");
  assert.equal(fixture.finished.has(marker), true, "the previous run finishes before its queued follow-up starts");
  const firstRunId = (await command(["show", sessionId])).runId;
  const observers = [creating, watching, sending, answering];
  await Promise.all(observers.map(observer => waitForObservedRun(observer, firstRunId)));
  assert.equal(sending.updates.some(event => event.type === "text" || event.type === "replace"), false,
    "queued send must suppress the previous run's assistant response");
  const next = await command(["send", sessionId, nextFollowup]);
  assert.equal(next.accepted, true);
  assert.equal(next.disposition, "queued");
  fixture.release(followup);
  await waitUntil(() => fixture.count(nextFollowup) === 1, "The second follow-up did not start");
  const finalRunId = (await command(["show", sessionId])).runId;
  assert.notEqual(finalRunId, firstRunId);
  await Promise.all(observers.map(observer => waitForObservedRun(observer, finalRunId)));
  fixture.release(nextFollowup);

  const result = await sending.finish();
  assert.equal(result.accepted, true);
  assert.equal(result.disposition, "queued");
  assert.equal(result.deliveryMode, "follow_up");
  assert.equal(result.input.waitId, input.waitId, "the acceptance response retains the form that blocked the queued message");
  assert.ok(result.clientMessageId);
  assert.equal(result.snapshot.status, "completed");
  const submitted = result.snapshot.transcript.find(entry => entry.type === "user" && entry.clientMessageId === result.clientMessageId);
  assert.ok(submitted?.runId, "the accepted message ID identifies its actual run in the transcript");
  assert.notEqual(submitted.runId, input.runId);
  assert.equal(submitted.runId, firstRunId);
  assert.equal(result.snapshot.runId, finalRunId);
  assert.equal(sending.updates.filter(event => event.type === "text").map(event => event.text).join(""),
    `${followup}: answers received.${nextFollowup}: answers received.`);
  for (const observer of [creating, watching, answering]) {
    const observed = await observer.finish();
    assert.equal(observed.snapshot.status, "completed");
    assert.equal(observed.snapshot.runId, finalRunId, "every wrapper waits through both follow-ups");
  }
  for (const accepted of [result, next]) {
    assert.equal(result.snapshot.transcript.filter(entry => entry.clientMessageId === accepted.clientMessageId).length, 1);
  }
  assert.deepEqual(result.snapshot.runtime.pendingFollowUps, []);
  assert.deepEqual(result.snapshot.runtime.pendingSteerings, []);
  assert.equal(fixture.count(marker), 2);
  assert.equal(fixture.count(followup), 1, "queued send executes exactly once");
  assert.equal(fixture.count(nextFollowup), 1);
  report.cases.push({ name: "create-watch-send-response-follow-two-queued-runs", ok: true, sessionId,
    runIds: [input.runId, firstRunId, finalRunId], clientMessageIds: [result.clientMessageId, next.clientMessageId], observers: observers.length });
}

async function permissionGuidance() {
  const marker = "QZ_INPUT_PERMISSION";
  const worker = environment.context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${environment.extensionId}/`));
  assert.ok(worker);
  // Only the Chrome permission/native-history boundary is mocked. Access begins false and
  // changes only through the real waiting-card click calling chrome.permissions.request.
  await worker.evaluate(() => {
    const originalContains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = async request => request.permissions?.includes("history")
      ? (await chrome.storage.local.get("__userInputHistoryGranted")).__userInputHistoryGranted === true
      : originalContains(request);
    const history = chrome.history || {};
    history.search = async () => [{ id: "synthetic", url: "https://example.test/history", title: "Synthetic history", lastVisitTime: Date.now(), visitCount: 1 }];
    if (!chrome.history) Object.defineProperty(chrome, "history", { configurable: true, value: history });
  });
  await environment.page.evaluate(() => {
    window.__historyPermissionRequests = 0;
    chrome.permissions.request = async request => {
      if (!request.permissions?.includes("history")) throw new Error("Unexpected native permission request");
      window.__historyPermissionRequests++;
      // Simulate a grant that is not yet reflected by the Background check on the first click.
      if (window.__historyPermissionRequests > 1) await chrome.storage.local.set({ __userInputHistoryGranted: true });
      return true;
    };
  });
  const { sessionId, input } = await createWaiting(marker, "browser_permission");
  const snapshotInput = await waitForSnapshotInput(sessionId, "browser_permission");
  assert.equal(snapshotInput.requiresUserAction, true);
  assert.equal(snapshotInput.responseTemplate, undefined, "native Chrome approval cannot be supplied as a tool response");
  assert.ok(snapshotInput.instructions.length > 20, "native permission input contains an actionable user instruction");
  const steered = await command(["send", sessionId, "Continue with the requested history source after I approve access.", "--steer"]);
  assert.equal(steered.accepted, true);
  assert.equal(steered.deliveryMode, "steer");
  assert.equal(steered.input.waitId, input.waitId);
  await unchangedWait(sessionId, input.waitId, marker, 1);
  const approved = await command(["approve", sessionId, "--wait-id", input.waitId], {
    openBrowser: () => { throw new Error("Permission guidance must not open a page automatically"); },
  });
  assert.equal(approved.requiresUserAction, true);
  assert.deepEqual(approved.input, snapshotInput);
  assert.equal(approved.snapshot, undefined, "approval without --wait returns native guidance immediately");
  const pendingApproval = trackCommand(["approve", sessionId, "--wait-id", input.waitId, "--wait"], {
    openBrowser: () => { throw new Error("Permission guidance must not open a page automatically"); },
  });
  await assertStillWaiting(pendingApproval, "approve --wait must stay alive while Chrome permission awaits a click");
  await unchangedWait(sessionId, input.waitId, marker, 1);
  assert.equal(await environment.page.evaluate(() => window.__historyPermissionRequests), 0);
  const bypass = await callTool(environment.bridge.endpoint, "qingzhou_continue_task", { sessionId, waitId: input.waitId });
  assert.equal(bypass.accepted, false, "the legacy continue endpoint cannot bypass permission approval");
  await unchangedWait(sessionId, input.waitId, marker, 1);
  await switchToSession(sessionId);
  const card = environment.page.locator(`.waiting-active[data-wait-id="${input.waitId}"]`);
  const allow = card.locator('[data-wait-action="continue"]');
  await allow.click();
  await environment.page.waitForFunction(waitId => {
    const card = document.querySelector(`.waiting-active[data-wait-id="${waitId}"]`);
    const buttons = [...(card?.querySelectorAll(".waiting-actions button") || [])];
    return window.__historyPermissionRequests === 1 && buttons.length === 2
      && buttons.every(button => !button.disabled)
      && /失败|Could not complete/i.test(card.querySelector(".waiting-hint")?.textContent || "");
  }, input.waitId, { timeout: 10_000 });
  await unchangedWait(sessionId, input.waitId, marker, 1);
  await allow.click();
  const watched = await pendingApproval.finish();
  assert.equal(watched.snapshot.status, "completed", "the same approve --wait call completes after the actual permission click");
  assert.equal(watched.snapshot.transcript.find(entry => entry.clientMessageId === steered.clientMessageId)?.runId, input.runId,
    "native permission steering resumes in the existing run only after the user grants access");
  assert.equal(await environment.page.evaluate(() => window.__historyPermissionRequests), 2);
  assert.equal(fixture.toolResult(marker, 1)[0].title, "Synthetic history");
  report.cases.push({ name: "native-permission-cli-guidance-real-sidepanel-click", ok: true, sessionId, failedPermissionCheckUnlocksCard: true });
}

async function steerCurrentRun() {
  const marker = "QZ_INPUT_STEER_WAIT";
  const redirected = "QZ_INPUT_STEER_RESULT";
  const followup = "QZ_INPUT_STEER_FOLLOWUP";
  const { sessionId, input } = await createWaiting(marker, "form");
  const other = await createWaiting("QZ_INPUT_STEER_UNRELATED", "form");
  await switchToSession(other.sessionId);
  const sending = startCliProcess(["send", sessionId, redirected, "--steer", "--client", clientId, "--stream", "--json"]);
  await waitUntil(() => {
    assert.equal(sending.settled, false, `Steering ended while its task was waiting: ${sending.stdout}\n${sending.stderr}`);
    return sending.updates.find(event => event.type === "input" && event.waitId === input.waitId);
  }, "Steering must retain the target task's form");
  await assertStillWaiting(sending, "steering cannot answer or bypass a pending form");
  await unchangedWait(sessionId, input.waitId, marker, 1);
  await unchangedWait(other.sessionId, other.input.waitId, "QZ_INPUT_STEER_UNRELATED", 1);
  assert.equal(fixture.count(redirected), 0);
  assert.equal(sending.updates.some(event => event.type === "text" || event.type === "replace"), false,
    "steering must not stream earlier assistant text from the same run");

  const queued = await command(["send", sessionId, followup]);
  assert.equal(queued.accepted, true);
  assert.equal(queued.disposition, "queued");
  assert.equal((await command(["submit", sessionId, JSON.stringify({ note: "Use the new direction" }), "--wait-id", input.waitId])).accepted, true);
  await waitUntil(() => fixture.count(followup) === 1, "The follow-up after steering did not start");
  const finalRunId = (await command(["show", sessionId])).runId;
  assert.notEqual(finalRunId, input.runId);
  await waitForObservedRun(sending, finalRunId);
  fixture.release(followup);
  const result = await sending.finish();
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryMode, "steer");
  assert.equal(result.snapshot.status, "completed");
  const matching = result.snapshot.transcript.filter(entry => entry.type === "user" && entry.clientMessageId === result.clientMessageId);
  assert.equal(matching.length, 1, "a steering message is consumed exactly once");
  assert.equal(matching[0].runId, input.runId, "steering joins the target's active run");
  assert.equal(result.snapshot.runId, finalRunId, "the steering observer also follows accepted follow-ups");
  assert.equal(result.snapshot.transcript.find(entry => entry.clientMessageId === queued.clientMessageId)?.runId, finalRunId);
  assert.match(assistantText(result.snapshot), /Prior context before steering\./, "the fixture contains earlier text from this same run");
  assert.equal(sending.updates.filter(event => event.type === "text").map(event => event.text).join(""),
    `${redirected}: answers received.${followup}: answers received.`);
  assert.equal(fixture.count(marker), 1, "the existing run adopts steering at its next model call");
  assert.equal(fixture.count(redirected), 1);
  assert.equal(fixture.count(followup), 1);
  await unchangedWait(other.sessionId, other.input.waitId, "QZ_INPUT_STEER_UNRELATED", 1);
  assert.equal((await command(["show", other.sessionId])).transcript.some(entry => entry.clientMessageId === result.clientMessageId), false);
  await command(["cancel", other.sessionId]);
  report.cases.push({ name: "steer-current-run-and-followup-target-isolation-form-preserved-own-stream", ok: true, sessionId,
    runId: input.runId, finalRunId, clientMessageId: result.clientMessageId });
}

async function timeoutRecovery() {
  const marker = "QZ_INPUT_TIMEOUT";
  const followup = "QZ_INPUT_TIMEOUT_FOLLOWUP";
  const created = await command(["create", marker]);
  const sessionId = created.session.id;
  await waitUntil(() => fixture.count(marker) === 1, "The timeout task did not reach its provider gate");
  const watching = startCliProcess(["watch", sessionId, "--client", clientId, "--json"], { timeout: 2 });
  const timedOut = await watching.envelope();
  assert.equal(watching.code, 1);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, "timeout");
  assert.equal(timedOut.error.sessionId, sessionId);
  assert.equal(timedOut.error.clientId, clientId);
  assert.equal(timedOut.error.command, `qz watch ${sessionId} --client ${clientId} --stream`);
  const running = await command(["show", sessionId]);
  assert.equal(running.status, "running", "ending observation leaves the browser task running");
  const accepted = await command(["send", sessionId, followup]);
  assert.equal(accepted.accepted, true);
  // Execute the returned command, including its original task and browser UUID.
  const recovering = startCliProcess([...timedOut.error.command.split(" ").slice(1), "--json"]);
  await waitForObservedRun(recovering, running.runId);
  fixture.release(marker);
  await waitUntil(() => fixture.count(followup) === 1, "Recovery did not reach the queued follow-up");
  const nextRunId = (await command(["show", sessionId])).runId;
  assert.notEqual(nextRunId, running.runId);
  await waitForObservedRun(recovering, nextRunId);
  fixture.release(followup);
  const recovered = await recovering.finish();
  assert.equal(recovered.sessionId, sessionId);
  assert.equal(recovered.snapshot.clientId, clientId);
  assert.equal(recovered.snapshot.status, "completed");
  assert.equal(recovered.snapshot.runId, nextRunId);
  assert.equal(recovered.snapshot.transcript.filter(entry => entry.type === "user" && entry.text === marker).length, 1);
  assert.equal(recovered.snapshot.transcript.filter(entry => entry.clientMessageId === accepted.clientMessageId).length, 1);
  assert.equal(fixture.count(marker), 1, "timeout and recovery never replay the initial request");
  assert.equal(fixture.count(followup), 1);
  assert.equal(recovering.updates.filter(event => event.type === "text").map(event => event.text).join(""),
    `${marker}: answers received.${followup}: answers received.`);
  report.cases.push({ name: "timeout-execute-returned-watch-command-through-followup", ok: true, sessionId, clientId,
    command: timedOut.error.command, runIds: [running.runId, nextRunId] });
}

async function locationConsent() {
  await environment.page.evaluate(async () => {
    await chrome.storage.local.remove("qz_location_consent");
    window.__locationReads = 0;
    Object.defineProperty(navigator.geolocation, "getCurrentPosition", { configurable: true, value(success) {
      window.__locationReads++;
      success({ coords: { latitude: 30.25, longitude: 120.15, accuracy: 10 }, timestamp: Date.now() });
    } });
  });
  const denied = await createWaiting("QZ_INPUT_LOCATION_REJECT", "location_consent");
  await command(["reject", denied.sessionId, "--wait-id", denied.input.waitId]);
  assert.equal((await command(["watch", denied.sessionId])).snapshot.status, "completed");
  assert.equal(await environment.page.evaluate(async () => (await chrome.storage.local.get("qz_location_consent")).qz_location_consent), undefined);
  assert.equal(await environment.page.evaluate(() => window.__locationReads), 0);
  const marker = "QZ_INPUT_LOCATION";
  const { sessionId, input } = await createWaiting(marker, "location_consent");
  assert.ok(Number.isInteger(input.consentVersion) && input.consentVersion > 0);
  assert.ok(input.message.length > 20, "MCP exposes the disclosure before consent");
  assert.deepEqual(input.responseTemplate, { sessionId, waitId: input.waitId, action: "approve", consentVersion: input.consentVersion, clientId });
  const bypass = await callTool(environment.bridge.endpoint, "qingzhou_continue_task", { sessionId, waitId: input.waitId });
  assert.equal(bypass.accepted, false);
  const wrongVersion = await respond({ sessionId, waitId: input.waitId, action: "approve", consentVersion: input.consentVersion + 1 });
  assert.equal(wrongVersion.accepted, false);
  await unchangedWait(sessionId, input.waitId, marker, 1);
  assert.equal(await environment.page.evaluate(() => window.__locationReads), 0);
  const disclosures = [];
  const approved = await command(["approve", sessionId, "--wait-id", input.waitId, "--wait"], { onUserInput: value => disclosures.push(value) });
  assert.equal(approved.accepted, true);
  assert.equal(approved.snapshot.status, "completed");
  assert.equal(disclosures.length, 1);
  assert.equal(disclosures[0].message, input.message);
  assert.equal(await environment.page.evaluate(() => window.__locationReads), 1);
  const stored = await environment.page.evaluate(async () => (await chrome.storage.local.get("qz_location_consent")).qz_location_consent);
  assert.equal(stored.version, input.consentVersion);
  assert.equal(fixture.toolResult(marker, 1).latitude, 30.25);
  report.cases.push({ name: "location-reject-version-check-explicit-cli-consent", ok: true, sessionId });
}

async function switchToSession(sessionId) {
  const page = environment.page;
  await page.locator('.tab-btn[data-tab="sessions"]').click();
  const card = page.locator(`.session-card[data-id="${sessionId}"]`);
  await card.waitFor();
  await card.click();
  await page.waitForFunction(() => document.querySelector('.tab-btn[data-tab="chat"]')?.classList.contains("active"));
}

function assistantText(snapshot) {
  return (snapshot.transcript || []).filter(entry => entry.type === "assistant").map(entry => textContent(entry.content)).join("\n");
}

function textContent(content) {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
}

async function startFixture() {
  const requests = [];
  const finished = new Set();
  const gates = new Map([
    "QZ_INPUT_SEND_FOLLOWUP", "QZ_INPUT_SEND_NEXT_FOLLOWUP", "QZ_INPUT_STEER_FOLLOWUP",
    "QZ_INPUT_TIMEOUT", "QZ_INPUT_TIMEOUT_FOLLOWUP", "QZ_INPUT_MCP_FOLLOWUP",
  ].map(marker => [marker, Promise.withResolvers()]));
  let baseUrl;
  const server = createServer(async (request, response) => {
    if (request.url === "/card.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0S8AAAAASUVORK5CYII=", "base64"));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404); response.end(); return;
    }
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const marker = body.messages.filter(message => message.role === "user")
        .map(message => textContent(message.content).match(/QZ_INPUT_[A-Z_]+/)?.[0]).filter(Boolean).at(-1) || "validation";
      const results = body.messages.filter(message => message.role === "tool").map(message => ({ id: message.tool_call_id, content: textContent(message.content) }));
      requests.push({ marker, stream: body.stream === true, results });
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "input-validation", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "User input fixture" }, finish_reason: "stop" }] }));
        return;
      }
      const plan = scenario(marker, baseUrl);
      const step = plan.find((_, index) => !results.some(result => result.id === `${marker}_${index + 1}`));
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (step) {
        const index = plan.indexOf(step);
        if (marker === "QZ_INPUT_STEER_WAIT") send({ role: "assistant", content: "Prior context before steering." });
        send({ role: "assistant", tool_calls: [{ index: 0, id: `${marker}_${index + 1}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] });
        send({}, "tool_calls");
      } else {
        if (gates.has(marker)) await gates.get(marker).promise;
        send({ role: "assistant", content: `${marker}: ` });
        if (["QZ_INPUT_FORMS", "QZ_INPUT_MCP_FORMS", "QZ_INPUT_SEND_FOLLOWUP", "QZ_INPUT_STEER_RESULT"].includes(marker)) await delay(1200);
        send({ content: "answers received." });
        if (marker === "QZ_INPUT_FORMS") await delay(1200);
        finished.add(marker);
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      requests.push({ error: error.message });
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    endpoint: `${baseUrl}/v1/chat/completions`, requests, finished,
    release(marker) { assert.ok(gates.has(marker), `Unknown provider gate: ${marker}`); gates.get(marker).resolve(); },
    count: marker => requests.filter(item => item.marker === marker && item.stream).length,
    toolResult(marker, step) {
      const result = requests.filter(item => item.marker === marker).flatMap(item => item.results || []).find(item => item.id === `${marker}_${step}`);
      assert.ok(result, `provider did not receive ${marker} tool result ${step}`);
      return JSON.parse(result.content);
    },
    close: () => new Promise(resolve => {
      for (const gate of gates.values()) gate.resolve();
      server.close(resolve); server.closeAllConnections();
    }),
  };
}

function scenario(marker, baseUrl) {
  const ask = fields => ({ name: "ask_user", args: { title: "Choose the next step", message: "Use these synthetic options to continue.", fields } });
  if (["QZ_INPUT_FORMS", "QZ_INPUT_MCP_FORMS"].includes(marker)) return [ask([
    { id: "name", label: "Name", type: "text", required: true },
    { id: "notes", label: "Notes", type: "textarea", required: true },
    { id: "route", label: "Route", type: "single_choice", options: [{ label: "Local", value: "local" }, { label: "Remote", value: "remote" }] },
    { id: "roles", label: "Roles", type: "multi_choice", presentation: "cards", options: [
      { label: "Northstar", value: "northstar", description: "Backend role", meta: ["Remote", "Rust"] },
      { label: "Harbor", value: "harbor", description: "Platform role", meta: ["Hybrid", "Go"], imageUrl: `${baseUrl}/card.png`, url: `${baseUrl}/role` },
    ] },
  ]), ask([
    { id: "choice", label: "Output", type: "single_choice", presentation: "cards", options: [{ label: "Report", value: "report" }, { label: "Summary", value: "summary" }] },
    { id: "formats", label: "Formats", type: "multi_choice", options: [{ label: "HTML", value: "html" }, { label: "CSV", value: "csv" }] },
  ])];
  if (marker === "QZ_INPUT_SELF_CONTAINED") return [ask([
    { id: "project_scope", label: "Project scope", type: "text", defaultValue: "browser-only", required: true },
    { id: "run_mode", label: "Execution mode", type: "single_choice", options: [
      { label: "Local research", value: "local" }, { label: "Remote analysis", value: "remote" },
    ] },
    { id: "output_formats", label: "Output formats", type: "multi_choice", defaultValues: ["csv"], options: [
      { label: "Web report", value: "html" }, { label: "Spreadsheet", value: "csv" },
    ] },
  ])];
  if (["QZ_INPUT_WAIT", "QZ_INPUT_SEND_WAIT", "QZ_INPUT_STEER_WAIT", "QZ_INPUT_STEER_UNRELATED"].includes(marker)) return [ask([{ id: "note", label: "Note", type: "text", required: true }])];
  if (["QZ_INPUT_SEND_FOLLOWUP", "QZ_INPUT_SEND_NEXT_FOLLOWUP", "QZ_INPUT_STEER_RESULT", "QZ_INPUT_STEER_FOLLOWUP",
    "QZ_INPUT_TIMEOUT", "QZ_INPUT_TIMEOUT_FOLLOWUP", "QZ_INPUT_MCP_FOLLOWUP"].includes(marker)) return [];
  if (marker === "QZ_INPUT_PERMISSION") return [{ name: "browse_history", args: { action: "recent", limit: 1 } }];
  if (marker.startsWith("QZ_INPUT_LOCATION")) return [{ name: "get_location", args: {} }];
  return [{ name: "wait_for_user", args: { message: "Confirm the synthetic action before continuing." } }];
}

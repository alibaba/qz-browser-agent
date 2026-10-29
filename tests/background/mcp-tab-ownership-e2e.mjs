import { createServer } from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import {
  PROJECT_ROOT,
  assertNoUnexpectedDiagnostics,
  launchIsolatedExtensionMcp,
  runBridgePython,
  saveExtensionLlmConfig,
} from "../support/isolated-extension-mcp.mjs";

const fixture = await startFixtureServer();
let environment = null;
const report = { ok: false, scenario: "node-bridge-connect-and-tab-ownership" };
try {
  environment = await launchIsolatedExtensionMcp({
    profilePrefix: "qingzhou-tab-owner-e2e-",
    headless: true,
    requestTimeoutSeconds: 60,
  });
  const clientId = environment.bridgeStatus.clients[0].clientId;
  assert.match(clientId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
  const pollCountAtDisconnect = environment.pollRequests.length;
  await environment.bridge.close();
  // The persisted retry deadline keeps a short outage from producing a hot poll loop.
  await new Promise(resolve => setTimeout(resolve, 8000));
  const stoppedPollCount = environment.pollRequests.length;
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(environment.pollRequests.length, stoppedPollCount, "offline bridge must stop polling");
  assert.ok(stoppedPollCount - pollCountAtDisconnect <= 3, "offline retries must be bounded");
  report.offlineRetries = stoppedPollCount - pollCountAtDisconnect;

  await environment.bridge.restart();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await (await fetch(environment.bridge.healthUrl)).json()).status.clientCount, 0,
    "idle extension resumes through the local connection page");
  const reconnected = await environment.connect();
  assert.equal(reconnected.clientCount, 1);
  assert.equal(reconnected.clients[0].clientId, clientId, "reconnect keeps the persisted browser identity");

  const oldEndpoint = environment.bridge.endpoint;
  await environment.bridge.restart({ newPort: true });
  assert.notEqual(environment.bridge.endpoint, oldEndpoint);
  const moved = await environment.connect();
  assert.equal(moved.clients[0].clientId, clientId);
  assert.equal(await environment.page.evaluate(async () =>
    (await chrome.storage.local.get("_qingzhou_mcp_bridge"))._qingzhou_mcp_bridge.endpoint), environment.bridge.endpoint,
  "connection page saves the new port without DevTools configuration");
  report.endpoint = environment.bridge.endpoint;
  report.previousEndpoint = oldEndpoint;
  const unownedPage = await environment.context.newPage();
  await unownedPage.goto(`${fixture.baseUrl}/free`, { waitUntil: "domcontentloaded" });
  await runBridgePython(fileURLToPath(new URL("./mcp-tab-ownership.py", import.meta.url)), [
    "--bridge-url", environment.bridge.mcpUrl,
    "--base-url", fixture.baseUrl,
  ]);
  report.cli = await cliMcpBrowserRoundTrip(environment, fixture.baseUrl);
  report.cliTasks = await cliModelTasks(environment, fixture);
  assertNoUnexpectedDiagnostics(environment.diagnostics);
  Object.assign(report, {
    ok: true,
    scenario: "multi-session-subsession-tab-ownership",
    bridgePortIsolated: new URL(environment.bridge.endpoint).port !== "18765",
    bridgeClientCount: reconnected.clientCount,
    consentGatedConnectionPage: true,
    bridgeRestartReconnect: true,
    portChangeReconnect: true,
  });
  console.log(JSON.stringify(report));
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  try {
    assertNoUnexpectedDiagnostics(environment?.diagnostics || []);
  } catch (diagnosticError) {
    failure.message = `${failure.message}\n${diagnosticError.message}`;
  }
  report.error = failure.message;
  throw failure;
} finally {
  const reportDir = join(PROJECT_ROOT, "tests/results/mcp-bridge");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "extension-e2e.json"), JSON.stringify({ ...report, pollRequests: environment?.pollRequests || [], logs: environment?.bridge.logs || [], diagnostics: environment?.diagnostics || [] }, null, 2));
  await environment?.close().catch(() => undefined);
  await fixture.close();
}

async function cliMcpBrowserRoundTrip(environment, baseUrl) {
  // Only daemon discovery is redirected; the CLI uses its real MCP SDK client and server.
  const dependencies = { findDaemon: async () => ({
    endpoint: environment.bridge.endpoint,
    health: await readHealth(environment.bridge.endpoint),
  }) };
  const command = async (...args) => (await runCli([...args, "--timeout", "30"], dependencies)).result;
  const mcp = (name, args) => callTool(environment.bridge.endpoint, name, {
    clientId: environment.bridgeStatus.clients[0].clientId, timeoutSeconds: 30, ...args,
  }, { timeoutMs: 30_000 });
  const created = await mcp("qingzhou_create_session", { title: "CLI local page" });
  const sessionId = created.session.id;
  assert.ok(sessionId);
  assert.equal(created.session.title, "CLI local page");
  assert.equal(created.started, false, "creating an empty MCP task must not invoke a model");
  const listed = await command("tasks");
  assert.ok(listed.sessions.some(session => session.id === sessionId));
  const snapshot = await command("show", sessionId);
  assert.equal(snapshot.sessionId, sessionId);
  assert.equal(snapshot.session.title, "CLI local page");

  const schema = await mcp("qingzhou_get_tool", { name: "open_tab", sessionId });
  assert.equal(schema.name, "open_tab");
  assert.equal(schema.parameters.properties.url.type, "string");
  assert.ok(schema.parameters.required.includes("url"));
  const articleSchema = await mcp("qingzhou_get_tool", { name: "read_article", sessionId });
  assert.deepEqual(articleSchema.parameters.properties.tabRef.type, ["integer", "string"]);
  assert.equal(Object.hasOwn(articleSchema.parameters.properties, "tabId"), false);
  assert.ok(articleSchema.parameters.required.includes("limit"));

  const url = `${baseUrl}/cli-roundtrip`;
  const opened = await mcp("qingzhou_execute_tool", { name: "open_tab", sessionId, args: { url, tabAlias: "cli-page" }, wait: true });
  assert.equal(opened.toolName, "open_tab");
  assert.equal(opened.sessionId, sessionId);
  const tabId = opened.result.id;
  assert.equal(typeof tabId, "number");
  assert.equal(opened.result.url, url);
  assert.equal(opened.result.tabAlias, "cli-page");
  const article = await mcp("qingzhou_execute_tool", {
    name: "read_article", sessionId, args: { tabRef: "cli-page", source: "body", limit: 4000 }, wait: true,
  });
  assert.equal(article.toolName, "read_article");
  assert.equal(article.sessionId, sessionId);
  assert.equal(article.result.url, url);
  assert.match(article.result.text, /deterministic fixture cli-roundtrip/);
  const active = await command("show", sessionId);
  assert.ok(active.runtime.ownedTabIds.includes(tabId));

  const closed = await mcp("qingzhou_execute_tool", { name: "close_tab", sessionId, args: { tabRef: String(tabId) }, wait: true });
  assert.equal(closed.toolName, "close_tab");
  assert.equal(closed.result.closed, tabId);
  assert.equal(await environment.page.evaluate(async tabId => {
    try { await chrome.tabs.get(tabId); return false; } catch { return true; }
  }, tabId), true);
  const stopped = await command("cancel", sessionId);
  assert.equal(stopped.sessionId, sessionId);
  return { ok: true, sessionId, tabId, commands: ["tasks", "show", "cancel"],
    mcpCalls: ["qingzhou_create_session", "qingzhou_get_tool:open_tab", "qingzhou_get_tool:read_article",
      "qingzhou_execute_tool:open_tab", "qingzhou_execute_tool:read_article", "qingzhou_execute_tool:close_tab"],
    readText: article.result.text };
}

async function startFixtureServer() {
  const providerRequests = [];
  let streamFinished = false;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://fixture.test").pathname.slice(1) || "index";
    if (request.method === "POST" && path === "v1/chat/completions") {
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const userText = (body.messages || []).filter(message => message.role === "user")
          .map(message => JSON.stringify(message.content)).join("\n");
        const marker = ["QZ_CLI_STREAM", "QZ_CLI_WAIT", "QZ_CLI_NEEDS_USER"].find(value => userText.includes(value)) || "validation";
        providerRequests.push({ marker, stream: body.stream === true });
        if (!body.stream) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "cli-validation", object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "CLI task" }, finish_reason: "stop" }] }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
          id: `cli-${marker}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        if (marker === "QZ_CLI_NEEDS_USER") {
          send({ role: "assistant", tool_calls: [{ index: 0, id: "cli-wait-choice", type: "function", function: {
            name: "ask_user", arguments: JSON.stringify({ title: "Choose a route", message: "Choose the local option to continue.",
              fields: [{ id: "route", label: "Route", type: "single_choice", options: [
                { label: "Local", value: "local" }, { label: "Remote", value: "remote" },
              ], required: true }] }),
          } }] });
          send({}, "tool_calls");
        } else if (marker === "QZ_CLI_STREAM") {
          send({ role: "assistant", reasoning_content: "Hidden fixture reasoning." });
          for (const [index, content] of ["Streaming ", "from the real ", "extension."].entries()) {
            if (response.destroyed) return;
            send({ content });
            if (index < 2) await new Promise(resolve => setTimeout(resolve, 1100));
          }
          streamFinished = true;
          send({}, "stop");
        } else {
          send({ role: "assistant", content: "QZ_CLI_WAIT finished in the extension." });
          send({}, "stop");
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: error.message } }));
      }
      return;
    }
    const body = `<!doctype html><html><head><title>${path}</title></head><body><main><article><h1>${path}</h1><p>deterministic fixture ${path}</p></article></main></body></html>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    providerEndpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    providerRequests,
    get streamFinished() { return streamFinished; },
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  };
}

async function cliModelTasks(environment, fixture) {
  await saveExtensionLlmConfig(environment.page, {
    provider: "custom", customProtocol: "openai", customEndpoint: fixture.providerEndpoint,
    apiKey: "deterministic-cli-test-key", model: "deterministic-model", contextWindow: 128000,
    trimOldToolResults: true, vision: false, debugMode: false,
  });
  const dependencies = { findDaemon: async () => ({
    endpoint: environment.bridge.endpoint, health: await readHealth(environment.bridge.endpoint),
  }) };
  const updates = [];
  const created = [];
  let textBeforeProviderFinished = false;
  const stream = (await runCli(["create", "Say QZ_CLI_STREAM.", "--title", "Chosen CLI title", "--stream", "--timeout", "30"], {
    ...dependencies,
    onTaskCreated: result => created.push(result),
    onTaskUpdate: update => {
      updates.push(update);
      if (update.type === "text" && update.text && !fixture.streamFinished) textBeforeProviderFinished = true;
    },
  })).result;
  assert.equal(created.length, 1, "the prompt creates exactly one task");
  assert.equal(stream.snapshot.status, "completed");
  assert.equal(stream.snapshot.sessionId, stream.session.id);
  assert.equal(stream.snapshot.session.title, "Chosen CLI title", "an explicit CLI title survives task completion");
  assert.equal(stream.snapshot.session.titleSource, "manual");
  const deltas = updates.filter(update => update.type === "text");
  assert.ok(deltas.length >= 2, "CLI receives live partial snapshots before the final answer");
  assert.equal(deltas.map(update => update.text).join(""), "Streaming from the real extension.");
  assert.equal(textBeforeProviderFinished, true, "streaming must begin before the provider response finishes");
  assert.ok(deltas.every(update => update.messageId && update.runId), "raw transcript identity survives MCP snapshot projection");
  assert.ok(!deltas.some(update => /Hidden fixture reasoning/.test(update.text)));

  const waited = (await runCli(["create", "Say QZ_CLI_WAIT.", "--wait", "--timeout", "30"], dependencies)).result;
  assert.equal(waited.snapshot.status, "completed");
  assert.ok(waited.snapshot.transcript.some(entry => entry.type === "assistant"
    && JSON.stringify(entry.content).includes("QZ_CLI_WAIT finished in the extension.")), "--wait returns the completed answer");

  const waitingUpdates = [];
  let waitingTask, waitingResult, waitingError, waitingSettled = false;
  const waitingRun = runCli(["create", "Ask me QZ_CLI_NEEDS_USER.", "--stream", "--timeout", "30"], {
    ...dependencies,
    onTaskCreated: result => { waitingTask = result; },
    onTaskUpdate: update => waitingUpdates.push(update),
  }).then(result => { waitingResult = result.result; waitingSettled = true; },
    error => { waitingError = error; waitingSettled = true; });
  const waitingDeadline = Date.now() + 15_000;
  while (!waitingUpdates.some(update => update.type === "input") && Date.now() < waitingDeadline) {
    assert.equal(waitingSettled, false, `The task exited before its input request: ${waitingError?.message || ""}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const input = waitingUpdates.find(update => update.type === "input");
  assert.ok(input, "streaming emits the pending form while the task remains live");
  assert.equal(input.title, "Choose a route");
  assert.equal(input.message, "Choose the local option to continue.");
  assert.ok(waitingUpdates.some(update => update.type === "status" && update.status === "waiting_user"));
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(waitingSettled, false, "--stream keeps waiting for user input");
  const stopped = (await runCli(["cancel", waitingTask.session.id, "--timeout", "30"], dependencies)).result;
  assert.equal(stopped.stopped, true, "the isolated human wait is cleaned up through the normal CLI");
  await waitingRun;
  if (waitingError) throw waitingError;
  assert.equal(waitingResult.snapshot.status, "aborted", "an explicit task stop ends the same streaming call");
  for (const marker of ["QZ_CLI_STREAM", "QZ_CLI_WAIT", "QZ_CLI_NEEDS_USER"]) {
    assert.equal(fixture.providerRequests.filter(request => request.stream && request.marker === marker).length, 1,
      `${marker} must not replay the prompt or make an extra model request`);
  }
  assert.equal(fixture.providerRequests.filter(request => request.marker === "QZ_CLI_STREAM").length, 1,
    "an explicit CLI title must not trigger a separate title model request");
  return { ok: true, streamingBeforeCompletion: true, streamChunks: deltas.length, waitReturnsFinal: true,
    waitingUserStaysLive: true, waitingTaskCancelled: true, providerRequests: fixture.providerRequests };
}

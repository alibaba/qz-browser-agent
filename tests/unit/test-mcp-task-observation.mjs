import { mockObservationTimers } from "../support/observation-timers.mjs";
import { pairBrowser, browserId, pollBrowser, completeBrowser } from "../support/paired-bridge.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { executeMcpTool } from "../../services/mcp-bridge/src/tools.mjs";
import { BridgeState } from "../../services/mcp-bridge/src/state.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";

const snapshot = (status, transcript = [], input = { waiting: false }) => ({
  sessionId: "task", session: { id: "task" }, status, runId: "run", runtime: { status, runId: "run" }, transcript, input,
});
const assistant = text => ({ type: "assistant", runId: "run", id: "answer", content: text });
async function connectedState(t, call) {
  const state = new BridgeState({ connectWaitMs: 0 });
  await pairBrowser(state, { id: "browser-a" });
  state.callExtension = call;
  t.after(() => state.close());
  return state;
}

test("create streams task text and actionable input, remains waiting, and binds one browser", async t => {
  const calls = [], events = [];
  let answered = false, reads = 0;
  const input = { waiting: true, waitId: "wait-1", kind: "form", fields: [{ id: "city", type: "text" }],
    responseTemplate: { sessionId: "task", waitId: "wait-1", action: "submit", answers: { city: "" } } };
  const state = await connectedState(t, async (method, params, options) => {
    calls.push({ method, params, options });
    assert.equal(options.clientId, browserId(state, "browser-a"));
    if (method === "create_session") {
      assert.equal(Object.hasOwn(params, "stream"), false);
      assert.equal(Object.hasOwn(params, "wait"), false);
      await pairBrowser(state, { id: "browser-b" });
      return { session: { id: "task" } };
    }
    assert.equal(method, "get_session_snapshot");
    assert.equal(params.compact, false);
    assert.equal(params.tail, false);
    reads += 1;
    return answered ? snapshot("completed", [assistant("Done")])
      : snapshot("waiting_user", [assistant("Choose a city")], input);
  });
  const result = await executeMcpTool(state, "qingzhou_create_session", { firstMessage: "Plan a trip", stream: true }, {
    onTaskUpdate: event => { events.push(event); if (event.type === "input") answered = true; },
  });
  assert.equal(result.snapshot.status, "completed");
  assert.equal(reads, 2);
  assert.equal(calls.filter(call => call.method === "create_session").length, 1);
  const waiting = events.find(event => event.type === "input");
  assert.equal(waiting.clientId, browserId(state, "browser-a"));
  assert.equal(waiting.responseTemplate.clientId, browserId(state, "browser-a"));
  assert.deepEqual(waiting.fields, input.fields);
  assert.equal(events.filter(event => event.type === "created").length, 1);
  assert.ok(events.some(event => event.type === "text" && event.text === "Choose a city"));
});

test("send waits for its tracked steer response and never streams earlier same-run text", async t => {
  const calls = [], events = [];
  const state = await connectedState(t, async (method, params) => {
    calls.push({ method, params });
    if (method === "send_message") return { accepted: true, clientMessageId: "message-2", deliveryMode: "steer" };
    return snapshot("completed", [assistant("Old answer"),
      { type: "user", runId: "run", clientMessageId: "message-2", content: "Change direction" },
      { ...assistant("New answer"), id: "new-answer" }]);
  });
  const result = await executeMcpTool(state, "qingzhou_send_message", {
    sessionId: "task", text: "Change direction", steer: true, stream: true,
  }, { onTaskUpdate: event => events.push(event) });
  assert.equal(result.snapshot.status, "completed");
  assert.equal(calls[0].params.wait, false);
  assert.equal(calls[0].params.steer, true);
  assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["New answer"]);
  assert.equal(calls.filter(call => call.method === "send_message").length, 1);
});

test("MCP send waits for the current run after its queued steering message was removed", async t => {
  const calls = [], events = [];
  let reads = 0;
  const state = await connectedState(t, async method => {
    calls.push(method);
    if (method === "send_message") return { accepted: true, disposition: "queued", clientMessageId: "removed" };
    assert.equal(method, "get_session_snapshot");
    assert.ok(++reads <= 2);
    return snapshot(reads === 1 ? "running" : "completed", [assistant("Earlier answer")]);
  });
  const result = await executeMcpTool(state, "qingzhou_send_message", {
    sessionId: "task", text: "Removed steer", steer: true, stream: true,
  }, { onTaskUpdate: event => events.push(event) });
  assert.equal(result.accepted, true);
  assert.equal(result.snapshot.status, "completed");
  assert.equal(events.some(event => event.type === "text"), false);
  assert.deepEqual(events.filter(event => event.type === "status").map(event => event.status), ["running", "completed"]);
  assert.deepEqual(calls, ["send_message", "get_session_snapshot", "get_session_snapshot"]);
});

test("native permission input remains actionable while responding waits for the human", async t => {
  const events = [];
  let humanApproved = false;
  const state = await connectedState(t, async (method, params) => {
    if (method === "respond_to_user_input") {
      assert.equal(params.waitId, "chrome-wait");
      assert.equal(params.consentVersion, 2);
      assert.equal(Object.hasOwn(params, "wait"), false);
      return { accepted: false, requiresUserAction: true, runId: "run" };
    }
    return humanApproved ? snapshot("completed", [assistant("Location found")]) : snapshot("waiting_user", [], {
      waiting: true, kind: "browser_permission", waitId: "chrome-wait", requiresUserAction: true,
      instructions: "Click Allow in Chrome.",
    });
  });
  const result = await executeMcpTool(state, "qingzhou_respond_to_user_input", {
    sessionId: "task", waitId: "chrome-wait", action: "approve", consentVersion: 2, wait: true,
  }, { onTaskUpdate: event => { events.push(event); if (event.type === "input") humanApproved = true; } });
  assert.equal(result.snapshot.status, "completed");
  assert.equal(Object.hasOwn(result, "accepted"), false);
  const input = events.find(event => event.type === "input");
  assert.equal(input.requiresUserAction, true);
  assert.equal(Object.hasOwn(input, "responseTemplate"), false);
  assert.equal(events.some(event => event.type === "text"), false);
});

test("invalid observation arguments and ambiguous browser selection cannot submit a task", async t => {
  const state = await connectedState(t, () => assert.fail("invalid requests must not reach the extension"));
  for (const input of [{ stream: "yes" }, ...["timeoutSeconds", "waitTimeoutSeconds"].flatMap(key =>
    [0, -1, Infinity, 1e100, 86400.1].map(value => ({ [key]: value })))]) {
    await assert.rejects(executeMcpTool(state, "qingzhou_create_session", { firstMessage: "Task", ...input }), { code: "invalid_arguments" });
  }
  await pairBrowser(state, { id: "browser-b" });
  await assert.rejects(executeMcpTool(state, "qingzhou_create_session", { firstMessage: "Task", wait: true }), { code: "BRIDGE_CLIENT_REQUIRED" });
});

test("watch cancellation revokes its pending read without stopping or resubmitting the task", async t => {
  const state = new BridgeState({ connectWaitMs: 0 });
  await pairBrowser(state, { id: "browser-a" });
  t.after(() => state.close());
  const controller = new AbortController();
  const waiting = executeMcpTool(state, "qingzhou_watch_task", { sessionId: "task" }, { signal: controller.signal });
  const rejected = assert.rejects(waiting, error => {
    assert.equal(error.code, "interrupted");
    assert.equal(error.details.recovery.tool, "qingzhou_watch_task");
    assert.deepEqual(error.details.recovery.arguments, { sessionId: "task", clientId: browserId(state, "browser-a") });
    return true;
  });
  const [read] = await pollBrowser(state, { id: "browser-a" }, { timeoutMs: 1000 });
  assert.equal(read.method, "get_session_snapshot");
  controller.abort();
  await rejected;
  assert.equal(state.inflight.size, 0);
  assert.equal(state.pending.size, 0);
  assert.equal(completeBrowser(state, read.id, { ok: true, result: snapshot("completed") }), false);
});

test("timeout recovery watches the original task through later runs without replaying a message", async t => {
  let sends = 0, recovery, resumed = false, reads = 0;
  const state = await connectedState(t, async (method, params, options) => {
    assert.equal(params.sessionId, "task");
    assert.equal(options.clientId, browserId(state, "browser-a"));
    if (method === "send_message") { sends += 1; return { accepted: true, clientMessageId: "target" }; }
    assert.equal(method, "get_session_snapshot");
    if (resumed) reads++;
    return { ...snapshot(resumed && reads === 2 ? "completed" : "running", [
      { type: "user", runId: "old", clientMessageId: "target" },
      { ...assistant("Requested answer"), runId: "old" },
      { type: "user", runId: "run", clientMessageId: "later" },
      assistant("Later answer"),
    ]) };
  });
  await assert.rejects(executeMcpTool(state, "qingzhou_send_message", {
    sessionId: "task", text: "Hello", wait: true, waitTimeoutSeconds: 0.01,
  }), error => {
    assert.equal(error.code, "timeout");
    recovery = error.details.recovery;
    assert.deepEqual(recovery, {
      tool: "qingzhou_watch_task", arguments: { sessionId: "task", clientId: browserId(state, "browser-a") },
    });
    return true;
  });
  resumed = true;
  const result = await executeMcpTool(state, recovery.tool, recovery.arguments);
  assert.equal(result.snapshot.status, "completed");
  assert.equal(result.snapshot.runId, "run");
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});

test("all MCP observation entry points follow queued work across run boundaries", async t => {
  for (const [name, args, accepted] of [
    ["qingzhou_watch_task", { sessionId: "task", stream: true }, null],
    ["qingzhou_create_session", { firstMessage: "Start", wait: true }, { session: { id: "task" } }],
    ["qingzhou_send_message", { sessionId: "task", text: "Follow up", stream: true }, { accepted: true, clientMessageId: "target" }],
    ["qingzhou_respond_to_user_input", { sessionId: "task", waitId: "old-wait", action: "approve", wait: true }, { accepted: true, runId: "run" }],
  ]) {
    let reads = 0, mutations = 0;
    const transcript = [{ type: "user", runId: "run", clientMessageId: "target" }, assistant("First answer")];
    const done = { ...snapshot("completed", [...transcript,
      { type: "user", runId: "next-run", clientMessageId: "next" },
      { ...assistant("Next answer"), runId: "next-run" }]), runId: "next-run" };
    const state = await connectedState(t, async method => {
      if (method !== "get_session_snapshot") { mutations++; return accepted; }
      reads++;
      assert.ok(reads <= 2);
      return reads === 1 ? { ...snapshot("completed", transcript), runtime: { pendingFollowUps: [{}] } } : done;
    });
    const events = [];
    const result = await executeMcpTool(state, name, args, { onTaskUpdate: event => events.push(event) });
    assert.equal(result.snapshot.runId, "next-run", name);
    assert.equal(reads, 2, name);
    assert.equal(mutations, accepted ? 1 : 0, name);
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), args.stream ? ["First answer", "Next answer"] : [], name);
  }
});

test("an accepted MCP message without a tracking ID can recover by watching without another send", async t => {
  const calls = [];
  const state = await connectedState(t, async method => {
    calls.push(method);
    return method === "send_message" ? { accepted: true } : snapshot("completed");
  });
  let recovery;
  await assert.rejects(executeMcpTool(state, "qingzhou_send_message", { sessionId: "task", text: "Hello", wait: true }), error => {
    assert.equal(error.code, "invalid_response");
    recovery = error.details.recovery;
    return true;
  });
  assert.equal((await executeMcpTool(state, recovery.tool, recovery.arguments)).snapshot.status, "completed");
  assert.deepEqual(calls, ["send_message", "get_session_snapshot"]);
});

test("MCP missing-task recovery lists the selected browser's tasks while snapshots keep their null protocol", async t => {
  const calls = [];
  const missing = { sessionId: "task", session: null, status: "idle", runtime: { status: "idle" }, transcript: [] };
  const state = await connectedState(t, async (method, params, options) => {
    calls.push({ method, params, clientId: options.clientId });
    if (method === "list_sessions") return { sessions: [] };
    assert.equal(method, "get_session_snapshot");
    return missing;
  });
  await assert.rejects(executeMcpTool(state, "qingzhou_watch_task", { sessionId: "task" }), error => {
    assert.equal(error.code, "task_deleted");
    assert.match(error.message, /not found in the selected browser/);
    assert.doesNotMatch(error.message, /was deleted/);
    assert.equal(error.details.sessionId, "task");
    assert.deepEqual(error.details.recovery, {
      tool: "qingzhou_list_sessions", arguments: { clientId: browserId(state, "browser-a") },
    });
    return true;
  });
  assert.deepEqual(await executeMcpTool(state, "qingzhou_get_session_snapshot", { sessionId: "task" }),
    { ...missing, clientId: browserId(state, "browser-a") });
  assert.deepEqual(calls.map(call => call.method), ["get_session_snapshot", "get_session_snapshot"]);
});

test("MCP wrong-browser recovery keeps the resolved UUID and never searches another browser", async t => {
  let recovery;
  const calls = [];
  const state = await connectedState(t, async (method, params, options) => {
    calls.push({ method, params, clientId: options.clientId });
    if (method === "list_sessions") return { sessions: [] };
    assert.equal(method, "get_session_snapshot");
    return options.clientId === browserId(state, "browser-b")
      ? { sessionId: "task", session: null, status: "idle", runtime: { status: "idle" } }
      : snapshot("completed", [assistant("Owner's answer")]);
  });
  await pairBrowser(state, { id: "browser-b" });
  await assert.rejects(executeMcpTool(state, "qingzhou_watch_task", { sessionId: "task", clientId: "browser-b" }), error => {
    assert.equal(error.code, "task_deleted");
    assert.equal(error.details.clientId, browserId(state, "browser-b"));
    recovery = error.details.recovery;
    assert.deepEqual(recovery, {
      tool: "qingzhou_list_sessions", arguments: { clientId: browserId(state, "browser-b") },
    });
    return true;
  });
  const listed = await executeMcpTool(state, recovery.tool, recovery.arguments);
  assert.deepEqual(listed, { sessions: [], clientId: browserId(state, "browser-b") });
  assert.deepEqual(calls.map(call => call.clientId), [browserId(state, "browser-b"), browserId(state, "browser-b")]);
  const owning = await executeMcpTool(state, "qingzhou_watch_task", { sessionId: "task", clientId: "browser-a" });
  assert.equal(owning.snapshot.status, "completed");
  assert.equal(owning.snapshot.transcript[0].content, "Owner's answer");
  assert.equal(owning.clientId, browserId(state, "browser-a"));
});

for (const scenario of [
  { name: "shorter total deadline", total: 2, request: 5, expiresMs: 2000, code: "timeout" },
  { name: "equal deadlines", total: 5, request: 5, expiresMs: 5000, code: "timeout" },
  { name: "earlier request deadline", total: 5, request: 2, expiresMs: 2000, code: "request_timeout" },
  { name: "caller cancellation", total: 5, request: 2, code: "interrupted" },
]) test(`MCP observation preserves request budgets and causes: ${scenario.name}`, async t => {
  mockObservationTimers(t, { apis: ["setTimeout", "Date"], now: 1_000_000 });
  const controller = new AbortController();
  const reason = new DOMException("User stopped watching.", "AbortError");
  const readReady = Promise.withResolvers();
  const calls = [];
  const state = await connectedState(t, async (method, params, options) => {
    calls.push(method);
    if (method === "send_message") return { accepted: true, clientMessageId: "message-1" };
    readReady.resolve({ params, options });
    return new Promise(() => {});
  });
  const pending = executeMcpTool(state, "qingzhou_send_message", {
    sessionId: "task", text: "Keep working", wait: true,
    timeoutSeconds: scenario.request, waitTimeoutSeconds: scenario.total,
  }, { signal: controller.signal }).catch(error => error);
  const read = await readReady.promise;
  assert.equal(read.params.timeoutSeconds, scenario.request);
  assert.equal(read.options.timeoutSeconds, scenario.request);
  if (scenario.code === "interrupted") controller.abort(reason);
  else t.mock.timers.tick(scenario.expiresMs);
  const error = await pending;
  assert.equal(error.code, scenario.code);
  assert.equal(error.cause, read.options.signal.reason, "MCP preserves the downstream cancellation cause");
  assert.equal(read.options.signal.aborted, true);
  if (scenario.code === "interrupted") assert.equal(error.cause, reason);
  else if (scenario.code === "timeout") assert.equal(error.cause.name, "TimeoutError");
  else assert.equal(error.cause.code, "request_timeout");
  assert.deepEqual(error.details.recovery, {
    tool: "qingzhou_watch_task", arguments: { sessionId: "task", clientId: browserId(state, "browser-a") },
  });
  assert.deepEqual(calls, ["send_message", "get_session_snapshot"],
    "ending observation must neither stop the browser task nor replay its accepted message");
});

test("tool lookup uses task context and returns the exact schema or a useful missing-tool error", async t => {
  const tool = { name: "read_article", inputSchema: { type: "object", properties: { tabId: { type: "number" } } } };
  const state = await connectedState(t, async (method, params, options) => {
    assert.equal(method, "list_tools");
    assert.equal(params.sessionId, "task");
    assert.equal(options.clientId, browserId(state, "browser-a"));
    return { tools: [tool] };
  });
  assert.deepEqual(await executeMcpTool(state, "qingzhou_get_tool", { sessionId: "task", name: "read_article", clientId: "browser-a" }), tool);
  await assert.rejects(executeMcpTool(state, "qingzhou_get_tool", { sessionId: "task", name: "missing", clientId: "browser-a" }), { code: "tool_not_found" });
});

test("async browser-tool admission pins its profile and returns task and job identities", async t => {
  const state = await connectedState(t, async (method, params, options) => {
    assert.equal(method, "execute_tool");
    assert.equal(options.clientId, browserId(state, "browser-a"));
    assert.equal(params.sessionId, "task");
    return { value: "Done" };
  });
  const start = state.startExtensionJob.bind(state);
  let additionalBrowser;
  state.startExtensionJob = (...args) => {
    additionalBrowser = pairBrowser(state, { id: "browser-b" });
    return start(...args);
  };
  const accepted = await executeMcpTool(state, "qingzhou_execute_tool", { sessionId: "task", name: "read_article", wait: false });
  await additionalBrowser;
  assert.equal(accepted.sessionId, "task");
  assert.equal(accepted.clientId, browserId(state, "browser-a"));
  assert.ok(accepted.jobId);
  assert.equal(accepted.done, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.getJob(accepted.jobId).result, { value: "Done" });
  await assert.rejects(executeMcpTool(state, "qingzhou_execute_tool", { sessionId: "task", name: "read_article", wait: false }), { code: "BRIDGE_CLIENT_REQUIRED" });
  assert.equal(state.jobs.size, 1);
});

test("MCP progress transports canonical task events and streaming without a token still completes", async t => {
  const bridge = await startBridge({ port: 0 });
  t.after(() => bridge.close());
  await pairBrowser(bridge.state, { id: "browser-a" });
  bridge.state.callExtension = async () => snapshot("completed", [assistant("Result")]);
  const client = new Client({ name: "task-observation-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.endpoint}/mcp`)));
  t.after(() => client.close());
  const events = [];
  const result = await client.callTool({ name: "qingzhou_watch_task", arguments: { sessionId: "task", stream: true } }, undefined, {
    onprogress: event => events.push(event),
  });
  assert.equal(JSON.parse(result.content[0].text).snapshot.status, "completed");
  assert.deepEqual(events.map(event => event.progress), [1, 2]);
  assert.equal(events[1]._meta["qz/task-event"].text, "Result");
  const noToken = await client.callTool({ name: "qingzhou_watch_task", arguments: { sessionId: "task", stream: true } });
  assert.equal(JSON.parse(noToken.content[0].text).snapshot.status, "completed");
});

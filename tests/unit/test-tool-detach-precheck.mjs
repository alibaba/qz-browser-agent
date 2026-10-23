import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";

const detachListeners = [];
const cdpCalls = [];
globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async get(id) { return { id, url: "https://example.test/", title: "Page" }; } },
  debugger: {
    onDetach: { addListener(listener) { detachListeners.push(listener); } },
    onEvent: { addListener() {} },
    async attach(target) { cdpCalls.push(["attach", target.tabId]); },
    async detach(target) { cdpCalls.push(["detach", target.tabId]); },
    async sendCommand(target, method) { cdpCalls.push(["command", target.tabId, method]); return {}; },
  },
};
const tools = await import("../../src/background/tools/runtime.js");

const supervisor = createSessionSupervisor({ createAgent: () => ({ subscribe(emit) { this.emit = emit; } }) });
const events = [];
const stops = [];
const runtime = tools.createToolRuntime({
  sessions: {
    beginUserWait: supervisor.beginUserWait,
    isWaitingForUser: supervisor.isWaitingForUser,
    isRunCurrent: supervisor.isRunCurrent,
    async resolveTargetTab(input) { return { ok: true, tabId: input.tabId }; },
    async stopSession(id, meta) { stops.push([id, meta]); },
  },
  emit: event => events.push(event),
});

const executed = [];
tools.defineTool({
  name: "__detach_probe",
  description: "Detach precheck probe",
  parameters: { type: "object", properties: { attach: { type: "number" } } },
  timeout: 50,
  execute: async (args, _signal, context) => {
    if (args.attach) await tools.withRunCdp(args.attach, context, (_target, send) => send("Page.enable"));
    executed.push(args);
    return { ok: true };
  },
});

// Attaches a run-owned connection through the real executeTool path, then dismisses the bar.
async function fixture(tabId) {
  const sessionId = crypto.randomUUID();
  const agent = await supervisor.getAgent(sessionId);
  const runId = crypto.randomUUID();
  agent.emit({ type: "agent_start", runId });
  const context = { sessionId, runId };
  await runtime.execute("__detach_probe", { attach: tabId }, undefined, context);
  detachListeners.forEach(listener => listener({ tabId }, "canceled_by_user"));
  return { sessionId, runId, context };
}

const lastWait = () => events.findLast(event => event.type === "waiting_for_user");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const within = (promise, ms, label) => {
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); });
  return Promise.race([promise, hung]).finally(() => clearTimeout(timer));
};

test("the detach card opens before the tool body and outside its timeout", async () => {
  const tabId = 71;
  const { sessionId, runId, context } = await fixture(tabId);
  const before = executed.length;
  const pending = runtime.execute("__detach_probe", {}, undefined, context);
  await tick();
  const wait = lastWait();
  assert.ok(wait, "the card is emitted before the tool runs");
  assert.equal(wait.form.debuggerDetached, true);
  assert.equal(executed.length, before, "the tool body waits for the card");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(executed.length, before, "the ask outlives the 50ms tool timeout without failing the call");
  supervisor.resolveUserWait({ sessionId, waitId: wait.waitId });
  assert.equal((await pending).ok, true);
  assert.equal(executed.length, before + 1, "approval runs the tool once");
  assert.equal(stops.length, 0);
  await tools.releaseRunCdp(sessionId, runId);
});

test("stop ends the run before the tool body, with the panel's stopped_by_user reason", async () => {
  const tabId = 72;
  const { sessionId, runId, context } = await fixture(tabId);
  const before = executed.length;
  const beforeStops = stops.length;
  const pending = runtime.execute("__detach_probe", {}, undefined, context);
  await tick();
  const wait = lastWait();
  supervisor.rejectUserWait({ sessionId, waitId: wait.waitId });
  await assert.rejects(pending, error => error?.code === "CDP_RUN_RELEASED");
  assert.equal(executed.length, before, "stop never runs the tool body");
  assert.deepEqual(stops.slice(beforeStops), [[sessionId, { source: "ui", requestedBy: "user" }]], "stop matches the panel's manual stop");
  assert.equal(supervisor.isWaitingForUser(sessionId), false, "no dangling wait");
  assert.equal(supervisor.resolveUserWait({ sessionId, waitId: wait.waitId }), false, "late approval cannot revive the wait");
  assert.equal(cdpCalls.filter(call => call[0] === "attach" && call[1] === tabId).length, 1, "stop never re-attaches");
  await tools.releaseRunCdp(sessionId, runId);
});

test("cancelling the tool signal settles the wait and late approval runs nothing", async () => {
  const tabId = 73;
  const { sessionId, runId, context } = await fixture(tabId);
  const before = executed.length;
  const beforeStops = stops.length;
  const controller = new AbortController();
  const pending = runtime.execute("__detach_probe", {}, controller.signal, context);
  await tick();
  const wait = lastWait();
  assert.equal(supervisor.isWaitingForUser(sessionId), true);
  controller.abort();
  await assert.rejects(within(pending, 2000, "aborted tool"), error => error?.code === "CDP_RUN_RELEASED");
  assert.equal(supervisor.isWaitingForUser(sessionId), false, "abort cleans the wait");
  assert.equal(supervisor.resolveUserWait({ sessionId, waitId: wait.waitId }), false, "late approval is a no-op");
  await tick();
  assert.equal(executed.length, before, "the tool body never runs after abort");
  assert.equal(stops.length, beforeStops, "abort does not stop the session");
  await tools.releaseRunCdp(sessionId, runId);
});

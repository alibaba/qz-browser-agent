import assert from "node:assert/strict";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { confirmDebuggerReattach } from "../../src/background/tools/debugger-reattach.js";

const supervisor = createSessionSupervisor({ createAgent: () => ({ subscribe(emit) { this.emit = emit; } }) });
const events = [];
const stops = [];
let stopFails = false;
const sessions = {
  beginUserWait: supervisor.beginUserWait,
  isWaitingForUser: supervisor.isWaitingForUser,
  async stopSession(id, meta) {
    stops.push([id, meta]);
    if (stopFails) throw new Error("stop failed");
  },
};
const emit = event => events.push(event);

async function fixture() {
  const sessionId = crypto.randomUUID();
  const agent = await supervisor.getAgent(sessionId);
  const runId = crypto.randomUUID();
  agent.emit({ type: "agent_start", runId });
  return { sessionId, runId };
}

function ask(sessionId, runId, language = "en") {
  return confirmDebuggerReattach(
    { tabId: 7, sessionId, runId, context: { sessionId, runId, language } },
    { sessions, emit },
  );
}

{
  // Continue resolves the wait and lets the tool call proceed.
  const { sessionId, runId } = await fixture();
  const pending = ask(sessionId, runId, "zh-CN");
  const wait = events.findLast(event => event.type === "waiting_for_user");
  assert.ok(wait, "a wait card is emitted");
  assert.equal(wait.form.debuggerDetached, true);
  assert.equal(wait.form.title, "已断开调试");
  assert.equal(wait.message, "你关闭了「正在调试此浏览器」提示，调试连接已断开。要继续这个任务吗？");
  assert.equal(wait.runId, runId);
  assert.equal(supervisor.isWaitingForUser(sessionId), true);
  supervisor.resolveUserWait({ sessionId, waitId: wait.waitId });
  assert.equal(await pending, true);
  assert.equal(events.at(-1).type, "user_wait_resolved");
  assert.equal(events.at(-1).reason, "user");
  assert.deepEqual(stops, []);
}

{
  // The same card is localized in English.
  const { sessionId, runId } = await fixture();
  const pending = ask(sessionId, runId, "en");
  const wait = events.findLast(event => event.type === "waiting_for_user");
  assert.equal(wait.form.title, "Debugging disconnected");
  assert.equal(wait.message, "You dismissed the “debugging this browser” bar, so the debugger connection was closed. Continue this task?");
  supervisor.resolveUserWait({ sessionId, waitId: wait.waitId });
  assert.equal(await pending, true);
}

for (const failStop of [false, true]) {
  // Stop rejects the wait, ends the run through the Session commands, and leaves no wait behind.
  stopFails = failStop;
  const { sessionId, runId } = await fixture();
  const pending = ask(sessionId, runId);
  const wait = events.findLast(event => event.type === "waiting_for_user");
  supervisor.rejectUserWait({ sessionId, waitId: wait.waitId });
  assert.equal(await pending, false);
  assert.deepEqual(stops.at(-1), [sessionId, { source: "ui", requestedBy: "user" }], "stop matches the panel's manual stop (stopped_by_user)");
  assert.equal(supervisor.isWaitingForUser(sessionId), false, "stop leaves no dangling wait");
  assert.equal(supervisor.resolveUserWait({ sessionId, waitId: wait.waitId }), false, "a settled wait cannot be revived");
}
stopFails = false;
stops.length = 0;

{
  // The tool signal settles the wait on cancellation: the card closes and late answers do nothing.
  const { sessionId, runId } = await fixture();
  const controller = new AbortController();
  const pending = confirmDebuggerReattach(
    { tabId: 7, sessionId, runId, context: { sessionId, runId }, signal: controller.signal },
    { sessions, emit },
  );
  const wait = events.findLast(event => event.type === "waiting_for_user");
  assert.equal(supervisor.isWaitingForUser(sessionId), true);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(supervisor.isWaitingForUser(sessionId), false, "abort cleans the wait");
  assert.equal(supervisor.resolveUserWait({ sessionId, waitId: wait.waitId }), false, "late approval is a no-op");
  assert.deepEqual(stops, [], "aborted waits never stop the session");
}

{
  // Run shutdown settles the wait as aborted without asking Session commands to stop again.
  const { sessionId, runId } = await fixture();
  const pending = ask(sessionId, runId);
  assert.equal(supervisor.isWaitingForUser(sessionId), true);
  await supervisor.revoke(sessionId);
  assert.equal(await pending, false);
  assert.deepEqual(stops, [], "aborted waits never stop the session twice");
}

{
  // Without a wait channel the host keeps the previous silent re-attach behavior.
  const { sessionId, runId } = await fixture();
  const before = events.length;
  assert.equal(await confirmDebuggerReattach(
    { tabId: 7, sessionId, runId, context: { sessionId, runId } },
    { sessions: null, emit: null },
  ), true);
  assert.equal(await confirmDebuggerReattach(
    { tabId: 7, sessionId: "", runId: "", context: {} },
    { sessions, emit },
  ), true);
  assert.equal(events.length, before, "no card is emitted without a wait channel");
}

{
  // An active wait in the same Session is never superseded by the detach prompt.
  const { sessionId, runId } = await fixture();
  const blocker = supervisor.beginUserWait(sessionId, { waitId: "other_wait", runId, onSettled() {} });
  const before = events.length;
  assert.equal(await ask(sessionId, runId), true);
  assert.equal(events.length, before, "no card is emitted while another wait is pending");
  assert.equal(supervisor.isWaitingForUser(sessionId), true);
  supervisor.resolveUserWait({ sessionId, waitId: "other_wait" });
  await blocker;
}

console.log("Debugger re-attach confirmation tests passed");

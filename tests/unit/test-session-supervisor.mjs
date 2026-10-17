import assert from "node:assert/strict";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { createSessionRepository, StaleSessionLeaseError } from "../../src/background/session/repository.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";

async function rejectsConcurrentStartsInOneSession() {
  const fixture = createFixture();
  const release = deferred();
  const first = await fixture.supervisor.startTask("s1", async ({ agent }) => {
    agent.streaming = true;
    await release.promise;
    agent.streaming = false;
  });
  await assert.rejects(
    fixture.supervisor.startTask("s1", async () => {}),
    error => error?.code === "SESSION_ALREADY_RUNNING",
  );
  release.resolve();
  await first.promise;
  await fixture.supervisor.waitForIdle("s1");
}

async function permitsIndependentSessionsToRunInParallel() {
  const fixture = createFixture();
  const bothStarted = deferred();
  const release = deferred();
  let started = 0;
  const run = sessionId => fixture.supervisor.startTask(sessionId, async ({ agent }) => {
    agent.streaming = true;
    started += 1;
    if (started === 2) bothStarted.resolve();
    await release.promise;
    agent.streaming = false;
  });
  const [left, right] = await Promise.all([run("left"), run("right")]);
  await bothStarted.promise;
  assert.equal(started, 2);
  release.resolve();
  await Promise.all([left.promise, right.promise]);
}

async function messageAdmissionOwnsStartOrQueueDecision() {
  const fixture = createFixture();
  let started = 0;
  let queued = 0;
  const start = () => fixture.supervisor.submitMessage("message-admission", {
    executor: async () => { started += 1; },
    enqueue: async () => { queued += 1; },
  });

  const idle = await start();
  assert.equal(idle.disposition, "started");
  await idle.task.promise;
  await fixture.supervisor.waitForIdle("message-admission");

  const agent = await fixture.supervisor.getAgent("message-admission");
  agent.pendingUserInput = true;
  const pending = await start();
  assert.equal(pending.disposition, "queued");
  assert.equal(started, 1);
  assert.equal(queued, 1);
  await assert.rejects(
    fixture.supervisor.startTask("message-admission", async () => {}),
    error => error?.code === "SESSION_ALREADY_RUNNING",
    "strict task starts must not overtake an accepted user-message queue",
  );

  agent.pendingUserInput = false;
  const release = deferred();
  const accepted = deferred();
  const first = await fixture.supervisor.submitMessage("message-admission", {
    messageId: "same-message",
    acceptance: accepted.promise,
    executor: () => release.promise,
    enqueue: async () => { queued += 1; },
  });
  const duplicate = await fixture.supervisor.submitMessage("message-admission", {
    messageId: "same-message",
    executor: async () => { started += 1; },
    enqueue: async () => { queued += 1; },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.disposition, "started");
  assert.equal(duplicate.task, first.task);
  assert.equal(queued, 1, "an in-flight retry must join the original submission instead of entering follow-up");
  accepted.resolve({ clientMessageId: "same-message" });
  release.resolve();
  await first.task.promise;
}

async function terminalEventCannotExposeAFalseIdleAdmissionWindow() {
  const fixture = createFixture();
  const terminalVisible = deferred();
  const releaseTaskTail = deferred();
  const running = await fixture.supervisor.startTask("terminal-tail", async ({ agent }) => {
    agent.emit({ type: "agent_start", runId: "run-tail", eventSeq: 1 });
    agent.emit({ type: "agent_end", runId: "run-tail", eventSeq: 2 });
    terminalVisible.resolve();
    await releaseTaskTail.promise;
  });
  await terminalVisible.promise;
  assert.equal(fixture.supervisor.isRunCurrent("terminal-tail", "run-tail"), false);
  assert.equal((await fixture.supervisor.getAgent("terminal-tail")).isStreaming, false);

  let newRunStarted = false;
  let queued = false;
  const admission = await fixture.supervisor.submitMessage("terminal-tail", {
    executor: async () => { newRunStarted = true; },
    enqueue: async () => { queued = true; },
  });
  assert.equal(admission.disposition, "queued");
  assert.equal(queued, true);
  assert.equal(newRunStarted, false, "the terminal tail must not be mistaken for an idle task slot");

  releaseTaskTail.resolve();
  await running.promise;
  await fixture.supervisor.waitForIdle("terminal-tail");
}

async function revocationRejectsLateEventsAndConversationWrites() {
  const fixture = createFixture();
  const agent = await fixture.supervisor.getAgent("stale");
  agent.emit({ type: "agent_start", runId: "run-old", eventSeq: 1 });
  await fixture.repository.writeActiveConversation(
    "stale",
    { messages: [{ role: "user", content: "before" }] },
    agent.lease,
  );
  const beforeEvents = fixture.events.length;
  const snapshot = await fixture.supervisor.revoke("stale", { reason: "test-stop" });
  assert.equal(snapshot.activeRunId, "run-old");
  assert.equal(agent.aborted, true);

  agent.emit({ type: "message_update", runId: "run-old", eventSeq: 2, text: "late" });
  assert.equal(fixture.events.length, beforeEvents);
  await assert.rejects(
    async () => fixture.repository.writeActiveConversation(
      "stale",
      { messages: [{ role: "assistant", content: "late" }] },
      agent.lease,
    ),
    StaleSessionLeaseError,
  );
  assert.equal((await fixture.repository.readActiveConversation("stale")).messages[0].content, "before");
}

async function restartWaitsForDurableStopBoundary() {
  const fixture = createFixture();
  const oldAgent = await fixture.supervisor.getAgent("handoff");
  const allowStopCommit = deferred();
  let stopCommitStarted = false;
  const stop = fixture.supervisor.revoke("handoff", {
    beforeRelease: async snapshot => {
      stopCommitStarted = true;
      assert.equal(snapshot.agent, oldAgent);
      await allowStopCommit.promise;
    },
  });
  while (!stopCommitStarted) await tick();

  let newTaskStarted = false;
  const nextTaskPromise = fixture.supervisor.startTask("handoff", async ({ agent }) => {
    newTaskStarted = true;
    assert.notEqual(agent, oldAgent);
  });
  await tick();
  assert.equal(newTaskStarted, false, "a new run must wait for the stop checkpoint boundary");

  allowStopCommit.resolve();
  await stop;
  const nextTask = await nextTaskPromise;
  await nextTask.promise;
  assert.equal(newTaskStarted, true);
}

async function rejectsStaleRunAndOutOfOrderEvents() {
  const fixture = createFixture();
  const agent = await fixture.supervisor.getAgent("events");
  agent.emit({ type: "agent_start", runId: "run-current", eventSeq: 1 });
  agent.emit({ type: "message_update", runId: "run-current", eventSeq: 3, text: "fresh" });
  agent.emit({ type: "message_update", runId: "run-current", eventSeq: 2, text: "out-of-order" });
  agent.emit({ type: "message_update", runId: "run-old", eventSeq: 4, text: "stale-run" });
  assert.deepEqual(
    fixture.events.filter(event => event.type === "message_update").map(event => event.text),
    ["fresh"],
  );
  assert.equal(fixture.supervisor.isRunCurrent("events", "run-current"), true);
  agent.emit({ runId: "run-current", eventSeq: 100 });
  agent.emit({ type: "", runId: "run-current", eventSeq: 101 });
  assert.equal(fixture.events.length, 2, "malformed events must not advance sequence or reach projection");
  agent.emit({ type: "agent_end", runId: "run-current", eventSeq: 4 });
  assert.equal(fixture.supervisor.isRunCurrent("events", "run-current"), false);
}

async function removeCannotRaceWithRecreation() {
  const fixture = createFixture();
  const oldAgent = await fixture.supervisor.getAgent("remove");
  const release = deferred();
  let removing = false;
  const removal = fixture.supervisor.remove("remove", {
    beforeRelease: async () => {
      removing = true;
      await release.promise;
    },
  });
  while (!removing) await tick();
  const replacementPromise = fixture.supervisor.startTask("remove", async () => {});
  release.resolve();
  await removal;
  const replacement = await replacementPromise;
  await replacement.promise;
  assert.notEqual(fixture.created.at(-1), oldAgent);
  assert.equal(fixture.supervisor.has("remove"), true);
}

async function ownsParallelUserWaitsPerSession() {
  const fixture = createFixture();
  const leftAgent = await fixture.supervisor.getAgent("wait-left");
  const rightAgent = await fixture.supervisor.getAgent("wait-right");
  leftAgent.emit({ type: "agent_start", runId: "run-left", eventSeq: 1 });
  rightAgent.emit({ type: "agent_start", runId: "run-right", eventSeq: 1 });

  const left = fixture.supervisor.beginUserWait("wait-left", {
    waitId: "wait-1",
    runId: "run-left",
  });
  const right = fixture.supervisor.beginUserWait("wait-right", {
    waitId: "wait-2",
    runId: "run-right",
  });
  const rightRejected = assert.rejects(right, error => error?.code === "OPERATION_ABORTED");

  assert.deepEqual(fixture.supervisor.getUserWait("wait-left"), { sessionId: "wait-left", waitId: "wait-1", runId: "run-left" });
  assert.equal(fixture.supervisor.getUserWait("missing"), null);
  assert.equal(fixture.supervisor.isWaitingForUser("wait-left"), true);
  assert.equal(fixture.supervisor.isWaitingForUser("wait-right"), true);
  assert.equal(fixture.supervisor.resolveUserWait({ sessionId: "wait-left", waitId: "wrong" }), false);
  assert.equal(fixture.supervisor.resolveUserWait({ sessionId: "wait-left", waitId: "wait-1", payload: { ok: true } }), true);
  assert.deepEqual(await left, { ok: true });
  assert.equal(fixture.supervisor.isWaitingForUser("wait-left"), false);
  assert.equal(fixture.supervisor.getUserWait("wait-left"), null);

  await fixture.supervisor.revoke("wait-right", { reason: "stop-during-wait" });
  await rightRejected;
  assert.equal(fixture.supervisor.isWaitingForUser("wait-right"), false);
  assert.equal(fixture.supervisor.getUserWait("wait-right"), null);
}

async function newerUserWaitSupersedesOnlyTheSameSession() {
  const fixture = createFixture();
  const agent = await fixture.supervisor.getAgent("wait-supersede");
  agent.emit({ type: "agent_start", runId: "run-current", eventSeq: 1 });
  const first = fixture.supervisor.beginUserWait("wait-supersede", {
    waitId: "wait-old",
    runId: "run-current",
  });
  const firstRejected = assert.rejects(first, error => error?.code === "WAIT_SUPERSEDED");
  const second = fixture.supervisor.beginUserWait("wait-supersede", {
    waitId: "wait-new",
    runId: "run-current",
  });
  await firstRejected;
  assert.equal(fixture.supervisor.getUserWait("wait-supersede").waitId, "wait-new");
  assert.throws(
    () => fixture.supervisor.beginUserWait("wait-supersede", { waitId: "wait-stale", runId: "run-old" }),
    error => error?.code === "STALE_RUN",
  );
  assert.equal(fixture.supervisor.rejectUserWait({ sessionId: "wait-supersede", waitId: "wait-new" }), true);
  await assert.rejects(second, error => error?.code === "USER_CANCELLED_WAIT");
}

async function initializationFailureDoesNotPoisonTheSession() {
  let attempts = 0;
  const fixture = createFixture({
    async initializeAgent() {
      attempts += 1;
      if (attempts === 1) throw new Error("hydrate failed");
    },
  });
  await assert.rejects(fixture.supervisor.getAgent("hydrate"), /hydrate failed/);
  assert.equal(fixture.supervisor.hasAgent("hydrate"), false);
  const recovered = await fixture.supervisor.getAgent("hydrate");
  assert.ok(recovered);
  assert.equal(attempts, 2);
  assert.equal(fixture.created.length, 2);
}

async function cancelledRevocationsCannotPassTheCommandQueue() {
  for (const method of ["revoke", "remove"]) {
    const f = createFixture(), controller = new AbortController(), gate = deferred(), entered = deferred();
    const agent = await f.supervisor.getAgent("pending-terminal");
    const blocked = f.supervisor.withAgent("pending-terminal", async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    let cleaned = false;
    const pending = f.supervisor[method]("pending-terminal", { admissionSignal: controller.signal, beforeRelease() { cleaned = true; } });
    controller.abort(new Error("connection revoked")); gate.resolve();
    await blocked; await assert.rejects(pending, /connection revoked/);
    assert.equal(cleaned, false); assert.equal(agent.aborted, false);
    assert.equal(await f.supervisor.getAgent("pending-terminal"), agent);
    await f.supervisor[method]("pending-terminal", { admissionSignal: new AbortController().signal, beforeRelease() { cleaned = true; } });
    assert.equal(cleaned, true); assert.equal(agent.aborted, true);
  }
}

async function taskFailuresReleaseTheCommandSlot() {
  const fixture = createFixture();
  await assert.rejects(
    fixture.supervisor.startTask("task-failure", async () => {}, {
      onStart: async () => { throw new Error("start boundary failed"); },
    }),
    /start boundary failed/,
  );
  assert.equal(fixture.supervisor.getTask("task-failure"), null);

  const failed = await fixture.supervisor.startTask("task-failure", async () => {
    throw new Error("executor failed");
  });
  await assert.rejects(failed.promise, /executor failed/);
  await waitUntil(() => fixture.supervisor.getTask("task-failure") === null);

  let recovered = false;
  const next = await fixture.supervisor.startTask("task-failure", async () => { recovered = true; });
  await next.promise;
  assert.equal(recovered, true);
}

async function abortFailureStillRevokesTheLease() {
  const warnings = [];
  const fixture = createFixture({ logger: { warn: (...args) => warnings.push(args), error() {} } });
  const agent = await fixture.supervisor.getAgent("abort-failure");
  agent.abort = () => { throw new Error("abort hook failed"); };
  const snapshot = await fixture.supervisor.revoke("abort-failure", { reason: "test" });
  assert.equal(snapshot.agent, agent);
  assert.equal(agent.lease.isActive(), false);
  assert.equal(fixture.supervisor.hasAgent("abort-failure"), false);
  assert.equal(warnings.length, 1);
  assert.notEqual(await fixture.supervisor.getAgent("abort-failure"), agent);
}

async function alreadyAbortedWaitSettlesOnce() {
  const fixture = createFixture();
  const agent = await fixture.supervisor.getAgent("wait-aborted");
  agent.emit({ type: "agent_start", runId: "run-wait", eventSeq: 1 });
  const controller = new AbortController();
  controller.abort();
  const settled = [];
  await assert.rejects(
    fixture.supervisor.beginUserWait("wait-aborted", {
      waitId: "wait-aborted",
      runId: "run-wait",
      signal: controller.signal,
      onSettled: reason => settled.push(reason),
    }),
    error => error?.code === "OPERATION_ABORTED",
  );
  assert.deepEqual(settled, ["aborted"]);
  assert.equal(fixture.supervisor.isWaitingForUser("wait-aborted"), false);
  assert.equal(fixture.supervisor.resolveUserWait({ sessionId: "wait-aborted", waitId: "wait-aborted" }), false);
}

function createFixture({ initializeAgent = async () => {}, logger = console } = {}) {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  const events = [];
  const created = [];
  const supervisor = createSessionSupervisor({
    createAgent: lease => {
      const agent = new FakeAgent(lease);
      created.push(agent);
      return agent;
    },
    initializeAgent,
    onAgentEvent: (_sessionId, event) => events.push(event),
    logger,
  });
  return { storage, repository, events, created, supervisor };
}

class FakeAgent {
  constructor(lease) {
    this.lease = lease;
    this.messages = [{ role: "system", content: "test" }];
    this.streaming = false;
    this.runId = "";
    this.listeners = new Set();
    this.aborted = false;
    this.pendingUserInput = false;
  }

  get isStreaming() {
    return this.streaming;
  }

  hasPendingUserInput() {
    return this.pendingUserInput;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    if (event.type === "agent_start") {
      this.streaming = true;
      this.runId = event.runId;
    }
    if (event.type === "agent_end") this.streaming = false;
    for (const listener of this.listeners) listener(event);
  }

  getRunState() {
    return { isStreaming: this.streaming, runId: this.runId };
  }

  getAbortSignal() {
    return null;
  }

  exportSession() {
    return { messages: this.messages };
  }

  abort() {
    this.aborted = true;
    this.streaming = false;
  }

  async waitForIdle() {}
}

await rejectsConcurrentStartsInOneSession();
await permitsIndependentSessionsToRunInParallel();
await messageAdmissionOwnsStartOrQueueDecision();
await terminalEventCannotExposeAFalseIdleAdmissionWindow();
await revocationRejectsLateEventsAndConversationWrites();
await restartWaitsForDurableStopBoundary();
await rejectsStaleRunAndOutOfOrderEvents();
await removeCannotRaceWithRecreation();
await ownsParallelUserWaitsPerSession();
await newerUserWaitSupersedesOnlyTheSameSession();
await initializationFailureDoesNotPoisonTheSession();
await cancelledRevocationsCannotPassTheCommandQueue();
await taskFailuresReleaseTheCommandSlot();
await abortFailureStillRevokesTheLease();
await alreadyAbortedWaitSettlesOnce();

console.log("session supervisor lifecycle tests passed");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("condition was not reached");
}

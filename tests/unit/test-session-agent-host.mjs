import assert from "node:assert/strict";
import { createSessionRecord } from "../../src/shared/session/session-codec.js";
import { createLifecycleObservers } from "../../src/background/lifecycle-observers.js";
import { createTestAgentServices } from "../support/agent-services.mjs";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { reduceSessionRuntime } from "../../src/background/session/runtime-reducer.js";

globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  runtime: { getURL: path => path },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
};

const { Agent } = await import("../../src/background/agent/agent.js?terminal-event-boundary");
const { createSessionAgentHost } = await import("../../src/background/session/agent-host.js?terminal-event-boundary");

await agentEmitCanWaitForAsyncSubscribers();
await terminalEventsWaitForDurableStateAndRecord();
await automationOutcomeDoesNotDelayTerminalCommit();
await agentEndReleasesRunResourcesOnce();
await terminalEventsDoNotWaitForAsyncObservation();
await observationFailuresAreBestEffort();
await terminalWritesRetryTransientFailures();
await terminalWriteFailureDoesNotDeadlockTheAgent();
await deletedSessionTerminalWritesAreNotRetried();
await writeBlockedSessionsDropEventsAtTheEntryBoundary();
await historyMutationHydratesOnlyWhenNeeded();
await dynamicContextIncludesTaskSites();
await lifecycleCommitReflectsDurability();
await customContextPreservesIdentityAndFailure();
await restoredQueuesResumeWithInitializationOccupancy();
await initializationRestoresTranscriptBeforePublishingQueues();

console.log("session Agent host boundary tests passed");

async function initializationRestoresTranscriptBeforePublishingQueues() {
  let hydrated = false, queueEvents = 0;
  const { host } = createHostFixture({
    hydrateTranscript: async (_id, conversation) => {
      assert.equal(conversation, null, "an unhydrated Agent must allow recovery from the stored record");
      hydrated = true;
    },
    recordTranscriptEvent: (_id, event) => {
      if (event.type !== "queue_update") return;
      assert.ok(hydrated, "queue events must not seed an incomplete projection before history recovery");
      queueEvents += 1;
    },
  });
  const agent = host.createAgent(activeLease("s1"));
  const unsubscribe = agent.subscribe(event => host.handleEvent("s1", event));
  try {
    await host.initializeAgent(agent, "s1");
    assert.equal(queueEvents, 1);
  } finally {
    unsubscribe();
  }
}

async function restoredQueuesResumeWithInitializationOccupancy() {
  for (const status of ["aborted", "error", "cancelled"]) {
    let host;
    let calls = 0;
    const initializing = deferred(), release = deferred();
    const supervisor = createSessionSupervisor({
      createAgent: lease => host.createAgent(lease),
      initializeAgent: (agent, id) => host.initializeAgent(agent, id),
      onAgentEvent: (id, event) => host.handleEvent(id, event),
    });
    ({ host } = createHostFixture({
      owner: supervisor,
      agentServices: createTestAgentServices({
        async getRuntimeConfig() {
          initializing.resolve();
          await release.promise;
          return { provider: "test", model: "test-model", contextWindow: 262000, vision: true };
        },
      }),
      llm: {
        async *chatStream() {
          calls += 1;
          yield { type: "done", message: { role: "assistant", content: "done" } };
        },
        async chat() { throw new Error("unexpected fallback"); },
      },
      recordRuntimeEvent: (id, event) => supervisor.setRuntime(id, reduceSessionRuntime(supervisor.getRuntime(id), event)),
    }));
    const previous = await supervisor.getAgent("s1");
    await supervisor.revoke("s1");
    supervisor.setRuntime("s1", {
      status, running: false,
      pendingFollowUpMessages: [{ role: "user", content: "retained", clientMessageId: "retained" }],
    });
    try {
      const restored = await supervisor.getAgent("s1");
      assert.notEqual(restored, previous);
      await initializing.promise;
      assert.equal(supervisor.getRuntime("s1").status, "pending");
      assert.equal(restored.isRunning, true);
      assert.ok(restored.findPendingUserMessage("retained"), "initialization keeps accepted work visible");
      assert.equal(await restored._runNextFollowUpRun(), false, "initialization occupancy prevents duplicate queue drains");
      release.resolve();
      await restored.waitForIdle();
      assert.equal(calls, 1, "the restored queue resumes automatically without another message");
      assert.deepEqual(restored.messages.filter(message => message.clientMessageId).map(message => message.clientMessageId), ["retained"]);
      assert.equal(supervisor.getRuntime("s1").status, "completed");
    } finally {
      release.resolve();
      await supervisor.revoke("s1");
    }
  }
}

async function agentEmitCanWaitForAsyncSubscribers() {
  const gate = deferred();
  const agent = new Agent("emit-wait", {
    services: createTestAgentServices(),
    conversationRepository: emptyConversationRepository(),
    conversationLease: activeLease("emit-wait"),
    llm: emptyLlm(),
    tools: emptyTools(),
    browserContext: emptyBrowserContext(),
    sessionPolicy: { canManageSessions: async () => true },
  });
  let settled = false;
  agent.subscribe(event => event.type === "agent_end" ? gate.promise.then(() => { settled = true; }) : undefined);
  const pending = agent._emit({ type: "agent_end", runId: "run-1" });
  assert.equal(typeof pending?.then, "function");
  await tick();
  assert.equal(settled, false);
  gate.resolve();
  await pending;
  assert.equal(settled, true);
}

async function terminalEventsWaitForDurableStateAndRecord() {
  const runtimeGate = deferred();
  const recordGate = deferred();
  const broadcasts = [];
  const sequence = [];
  const fixture = createHostFixture({
    persistRuntime: async (_sessionId, options) => {
      sequence.push(["runtime:start", options]);
      await runtimeGate.promise;
      sequence.push(["runtime:done"]);
    },
    saveRecord: async payload => {
      sequence.push(["record:start", payload.sessionId]);
      await recordGate.promise;
      sequence.push(["record:done"]);
      return { saved: true };
    },
    broadcast: event => {
      sequence.push(["broadcast", event.type]);
      broadcasts.push(event);
    },
  });

  fixture.host.handleEvent("s1", { type: "message_update", runId: "run-1", content: "hello" });
  assert.equal(broadcasts.at(-1)?.type, "message_update", "non-terminal events keep the synchronous fast path");
  broadcasts.length = 0;

  const terminal = fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-1" });
  assert.equal(typeof terminal?.then, "function");
  await tick();
  assert.equal(broadcasts.length, 0, "terminal UI state must not cross the durable boundary early");
  runtimeGate.resolve();
  await tick();
  assert.equal(broadcasts.length, 0, "the final Session record is part of the same terminal boundary");
  recordGate.resolve();
  await terminal;
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, "agent_end");
  assert.deepEqual(sequence.filter(item => item[0] !== "broadcast").map(item => item[0]), [
    "runtime:start",
    "record:start",
    "runtime:done",
    "record:done",
  ]);
  assert.equal(sequence.at(-1)[0], "broadcast");
  assert.deepEqual(sequence.find(item => item[0] === "runtime:start")?.[1], { terminal: true });
}

async function automationOutcomeDoesNotDelayTerminalCommit() {
  let outcomeCalls = 0;
  const broadcasts = [];
  const fixture = createHostFixture({
    automationOutcome: () => {
      outcomeCalls += 1;
      return new Promise(() => {});
    },
    broadcast: event => broadcasts.push(event),
  });

  fixture.host.handleEvent("s1", { type: "error", runId: "run-1", message: "provider failed" });
  await tick();
  assert.equal(outcomeCalls, 0, "non-terminal result events must not enter Automation");

  await Promise.race([
    fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-1" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Automation delayed Session terminal commit")), 50)),
  ]);
  await tick();
  assert.equal(outcomeCalls, 1);
  assert.deepEqual(broadcasts.map(event => event.type), ["error", "agent_end"]);
}

async function agentEndReleasesRunResourcesOnce() {
  const sequence = [];
  const fixture = createHostFixture({
    releaseRunResources: async input => {
      sequence.push(["release", input]);
      return { released: 2 };
    },
    persistRuntime: async () => { sequence.push(["persist"]); },
    saveRecord: async () => { sequence.push(["record"]); },
  });

  await fixture.host.handleEvent("s1", { type: "error", runId: "run-cdp", message: "failed" });
  assert.deepEqual(sequence, [], "error reports do not release resources or cross the terminal persistence boundary");
  await fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-cdp" });

  assert.equal(sequence[0][0], "release", "the run-owned browser connection must be released before terminal persistence");
  assert.deepEqual(sequence.filter(item => item[0] === "release").map(item => item[1]), [
    { sessionId: "s1", runId: "run-cdp", eventType: "agent_end" },
  ], "natural run teardown has one definitive release boundary");
}

async function terminalEventsDoNotWaitForAsyncObservation() {
  const observationGate = deferred();
  const broadcasts = [];
  let observationStarted = false;
  const fixture = createHostFixture({
    observeAgentEvent: (_sessionId, event) => {
      if (event.type !== "agent_end") return undefined;
      observationStarted = true;
      return observationGate.promise;
    },
    broadcast: event => broadcasts.push(event),
  });

  const terminal = fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-observed" });
  await tick();
  assert.equal(observationStarted, true, "terminal observation still starts");
  assert.deepEqual(broadcasts.map(event => event.type), ["agent_end"]);
  observationGate.resolve();
  await terminal;
}

async function observationFailuresAreBestEffort() {
  const broadcasts = [];
  const warnings = [];
  let observe = () => { throw new Error("sync observer failure"); };
  const fixture = createHostFixture({
    observeAgentEvent: (...args) => observe(...args),
    broadcast: event => broadcasts.push(event),
    logger: { warn: (...args) => warnings.push(args), debug() {} },
  });

  for (const failure of [
    () => { throw new Error("sync observer failure"); },
    () => Promise.reject(new Error("async observer failure")),
  ]) {
    observe = failure;
    assert.equal(fixture.host.handleEvent("s1", { type: "message_update", runId: "run-1" }), undefined);
    await tick();
  }
  assert.deepEqual(broadcasts.map(event => event.type), ["message_update", "message_update"]);
  assert.equal(warnings.length, 2);
}

async function terminalWriteFailureDoesNotDeadlockTheAgent() {
  const warnings = [];
  const broadcasts = [];
  const fixture = createHostFixture({
    persistRuntime: async () => { throw new Error("runtime unavailable"); },
    saveRecord: async () => { throw new Error("record unavailable"); },
    broadcast: event => broadcasts.push(event),
    logger: { warn: (...args) => warnings.push(args), debug() {} },
  });
  fixture.host.handleEvent("s1", { type: "error", runId: "run-1", message: "provider failed" });
  await fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-1" });
  assert.deepEqual(broadcasts.map(event => event.type), ["error", "agent_end"], "failure details remain visible before final teardown");
  assert.equal(warnings.length, 2);
}

async function terminalWritesRetryTransientFailures() {
  let runtimeAttempts = 0;
  let recordAttempts = 0;
  const broadcasts = [];
  const fixture = createHostFixture({
    persistRuntime: async () => {
      runtimeAttempts += 1;
      if (runtimeAttempts === 1) throw new Error("transient runtime failure");
    },
    saveRecord: async () => {
      recordAttempts += 1;
      if (recordAttempts === 1) throw new Error("transient record failure");
      return { saved: true };
    },
    broadcast: event => broadcasts.push(event),
  });
  await fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-retry" });
  assert.equal(runtimeAttempts, 2);
  assert.equal(recordAttempts, 2);
  assert.deepEqual(broadcasts.map(event => event.type), ["agent_end"]);
}

async function deletedSessionTerminalWritesAreNotRetried() {
  let attempts = 0;
  const warnings = [];
  const broadcasts = [];
  const fixture = createHostFixture({
    persistRuntime: async () => {
      attempts += 1;
      const error = new Error("deleted");
      error.code = "SESSION_DELETED";
      throw error;
    },
    broadcast: event => broadcasts.push(event),
    logger: { warn: (...args) => warnings.push(args), debug() {} },
  });
  assert.equal(await fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-deleted" }), false);
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 0);
  assert.equal(broadcasts.length, 0);
}

async function writeBlockedSessionsDropEventsAtTheEntryBoundary() {
  const calls = [];
  const fixture = createHostFixture({
    isWriteBlocked: true,
    recordTranscriptEvent: () => calls.push("transcript"),
    recordRuntimeEvent: () => calls.push("runtime"),
    recordResourceEvent: () => calls.push("resource"),
    broadcast: () => calls.push("broadcast"),
    releaseRunResources: input => calls.push(["release", input]),
  });
  assert.equal(fixture.host.handleEvent("s1", { type: "message_update", runId: "late" }), false);
  assert.deepEqual(calls, []);

  assert.equal(fixture.host.handleEvent("s1", { type: "aborted", runId: "late" }), false);
  assert.deepEqual(calls, [], "late result events cannot write or release a retired Session");

  assert.equal(await fixture.host.handleEvent("s1", { type: "agent_end", runId: "late" }), false);
  assert.deepEqual(calls, [["release", {
    sessionId: "s1",
    runId: "late",
    eventType: "agent_end",
  }]], "a retired Session still releases at the definitive terminal boundary without accepting late writes");
}

async function historyMutationHydratesOnlyWhenNeeded() {
  const restored = [];
  const skillNames = [];
  const fixture = createHostFixture({
    storedRecord: createSessionRecord(
      [{ role: "system", content: "system" }, { role: "user", content: "stored" }],
      [],
    ),
    runtime: { loadedPluginSkillNames: ["docs"] },
  });
  const agent = {
    isStreaming: false,
    messages: [{ role: "system", content: "system" }],
    async restoreSession(conversation) {
      restored.push(conversation);
      this.messages = [{ role: "system", content: "system" }, { role: "user", content: "stored" }];
    },
    restoreLoadedSkillToolNames(names) {
      skillNames.push(names);
    },
  };
  assert.equal(await fixture.host.ensureConversationForHistoryMutation("s1", agent), true);
  assert.equal(restored.length, 1);
  assert.deepEqual(skillNames, [["docs"]]);
  assert.equal(await fixture.host.ensureConversationForHistoryMutation("s1", agent), true);
  assert.equal(restored.length, 1, "an already hydrated Agent must not reload and overwrite live history");
}

async function dynamicContextIncludesTaskSites() {
  const taskSiteTabs = [{ id: 7, url: "https://example.test/page" }];
  const fixture = createHostFixture({ runtime: { visitedTaskSites: taskSiteTabs } });
  const agent = fixture.host.createAgent(activeLease("s1"));
  assert.deepEqual((await agent._dynamicContextProvider()).taskSiteTabs, taskSiteTabs);
}

function createHostFixture({
  persistRuntime = async () => {},
  saveRecord = async () => ({ saved: true }),
  broadcast = () => {},
  logger = { warn() {}, debug() {} },
  storedRecord = null,
  runtime = {},
  automationOutcome = async () => false,
  isWriteBlocked = false,
  recordTranscriptEvent = () => {},
  recordRuntimeEvent = () => {},
  recordResourceEvent = () => {},
  hydrateTranscript = async () => {},
  releaseRunResources = async () => ({ released: 0 }),
  observeAgentEvent = null,
  lifecycle = null,
  contextSources = [],
  owner = null,
  llm = emptyLlm(),
  agentServices = createTestAgentServices(),
} = {}) {
  const agent = {
    messages: [{ role: "system", content: "system" }, { role: "assistant", content: "done" }],
    exportSession: () => [{ role: "system", content: "system" }, { role: "assistant", content: "done" }],
  };
  const entry = { agent, epoch: 7, ready: Promise.resolve() };
  const supervisor = owner || {
    peekEntry: () => entry,
    getEntry: () => entry,
    getAgent: async () => agent,
    getRuntime: () => runtime,
  };
  const host = createSessionAgentHost({
    repository: {
      ...emptyConversationRepository(),
      readRecord: async () => storedRecord,
      isWriteBlocked: () => isWriteBlocked,
    },
    normalizeSessionId: value => String(value || "").trim(),
    llm,
    agentServices,
    browserContext: emptyBrowserContext(),
    getToolRuntime: emptyTools,
    getSupervisor: () => supervisor,
    getCommands: () => ({
      canManageSessionTools: async () => true,
      canUseSessionGoal: async () => true,
      commitSessionRecordRuntime: saveRecord,
    }),
    getWorkingTabContext: async () => null,
    recordTranscriptEvent,
    recordRuntimeEvent,
    persistRuntime,
    recordResourceEvent,
    hydrateTranscript,
    getTranscript: async () => [],
    releaseRunResources,
    closeOwnedTabs: async () => {},
    contextSources,
    lifecycle: lifecycle || createLifecycleObservers(observeAgentEvent ? [{
      id: "test", accepts: event => event.phase === "emitted",
      onEvent: event => observeAgentEvent(event.sessionId, event),
    }] : [], { onDiagnostic: diagnostic => logger.warn?.("observer", diagnostic) }),
    getAutomationRuntime: () => ({ syncSessionOutcome: automationOutcome }),
    broadcast,
    logger,
    terminalRetryDelay: () => 0,
  });
  return { host, agent, supervisor };
}

function emptyConversationRepository() {
  return {
    readActiveConversation: async () => null,
    writeActiveConversation: async () => true,
    clearActiveConversation: async () => true,
  };
}

function activeLease(sessionId) {
  return { sessionId, isActive: () => true };
}

function emptyLlm() {
  return { chat: async () => ({}), chatStream: async function* () {} };
}

function emptyTools() {
  return { execute: async () => ({}), getIdentity: () => ({}), getSchemas: () => [] };
}

function emptyBrowserContext() {
  return { readSelectedText: async () => "", getTab: async () => null };
}

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

async function lifecycleCommitReflectsDurability() {
  for (const outcome of ["success", "failure", "missing", "deleted"]) {
    const events = [];
    const gate = deferred();
    const lifecycle = createLifecycleObservers([{ id: "audit", onEvent: event => { events.push(event); } }]);
    const fixture = createHostFixture({ lifecycle, saveRecord: async () => {
      await gate.promise;
      if (outcome === "failure") throw new Error("disk failed");
      if (outcome === "deleted") throw Object.assign(new Error("deleted"), { code: "SESSION_DELETED" });
      return { saved: outcome !== "missing" };
    } });
    const pending = fixture.host.handleEvent("s1", { type: "agent_end", runId: "run-1", eventSeq: 9 });
    await lifecycle.flush();
    assert.deepEqual(events.map(event => event.phase), ["emitted"]);
    assert.equal(events[0].epoch, 7);
    gate.resolve();
    await pending;
    await lifecycle.flush();
    assert.deepEqual(events.map(event => event.phase), outcome === "success" ? ["emitted", "committed"] : ["emitted"]);
    assert.ok(events.every(event => event.runId === "run-1" && event.eventSeq === 9 && event.epoch === 7));
    lifecycle.dispose();
  }
}

async function customContextPreservesIdentityAndFailure() {
  let received;
  const fixture = createHostFixture({ contextSources: [{ id: "note", read: request => { received = request; return "Use the current document"; } }] });
  const agent = fixture.host.createAgent({ ...activeLease("s1"), epoch: 4 });
  const controller = new AbortController();
  const result = await agent._dynamicContextProvider({ reason: "snapshot", runId: "run-note", signal: controller.signal });
  assert.deepEqual(result.sources, [{ id: "note", title: "note", text: "Use the current document" }]);
  assert.equal(received.sessionId, "s1");
  assert.equal(received.runId, "run-note");
  assert.equal(received.epoch, 4);
  controller.abort("stop");
  await assert.rejects(agent._dynamicContextProvider({ signal: controller.signal }), { name: "AbortError" });
  const failed = createHostFixture({ contextSources: [{ id: "required", required: true, read: () => { throw new Error("secret"); } }] });
  await assert.rejects(failed.host.createAgent(activeLease("s1"))._dynamicContextProvider(), { code: "CONTEXT_SOURCE_REQUIRED" });
}

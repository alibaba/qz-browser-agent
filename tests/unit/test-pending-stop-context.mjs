import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../../src/background/agent/agent.js";
import { createSessionRepository } from "../../src/background/session/repository.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionTranscript } from "../../src/background/session/transcript.js";
import { activeConversationKey } from "../../src/shared/session/session-store.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { createTestAgentOptions, createTestAgentServices } from "../support/agent-services.mjs";

const MARKER = "QZ_PENDING_SHOULD_NOT_RUN";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function containsMarker(value) {
  return JSON.stringify(value ?? null).includes(MARKER);
}

async function harness({ holdWrite = false, holdConfig = false, holdModel = false, failConfig = false } = {}) {
  const storage = createMemoryStorage();
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let holdingWrite = holdWrite;
  const set = storage.set.bind(storage);
  storage.set = async patch => {
    if (holdingWrite && Object.keys(patch).some(key => key.startsWith("_active_conversation_"))) {
      holdingWrite = false;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    return set(patch);
  };
  const repository = createSessionRepository({ storage });
  const sessionId = "pending-stop";
  const configEntered = deferred();
  const releaseConfig = deferred();
  const modelEntered = deferred();
  const releaseModel = deferred();
  const events = [];
  let transcript;
  const supervisor = createSessionSupervisor({
    createAgent: lease => new Agent(sessionId, createTestAgentOptions({
      conversationLease: lease,
      conversationRepository: repository,
      services: createTestAgentServices({
        async getRuntimeConfig() {
          configEntered.resolve();
          if (holdConfig) await releaseConfig.promise;
          if (failConfig) throw new Error("runtime config unavailable");
          return { provider: "test", model: "test-model", contextWindow: 262000, vision: true };
        },
      }),
      llm: {
        async *chatStream() {
          modelEntered.resolve();
          if (holdModel) await releaseModel.promise;
          yield { type: "done", message: { role: "assistant", content: "should-not-run" } };
        },
        async chat() { throw new Error("unexpected fallback"); },
      },
    })),
    onAgentEvent(_id, event) {
      events.push(event);
      transcript.recordEvent(sessionId, event);
    },
  });
  transcript = createSessionTranscript({
    repository,
    supervisor,
    getLiveAgentEntry: async () => {
      const entry = supervisor.peekEntry(sessionId);
      return entry?.agent ? { agent: entry.agent } : null;
    },
    normalizeSessionId: value => String(value || "").trim(),
    resolveToolDefinition: () => null,
    getToolIdentity: () => ({}),
  });
  const task = await supervisor.startTask(sessionId, async ({ agent }) => {
    await agent.prompt(MARKER, {}, [], "pending-user");
  });
  return {
    storage, repository, supervisor, transcript, sessionId, events, task,
    writeEntered, releaseWrite, configEntered, releaseConfig, modelEntered, releaseModel,
    async stop() {
      return supervisor.revoke(sessionId, {
        reason: "stopped",
        beforeRelease: async snapshot => {
          const messageId = String(snapshot.discardedPrompt?.clientMessageId || "").trim();
          if (messageId) transcript.dropUnstartedUserMessage(sessionId, messageId);
          if (snapshot.conversation) await repository.replaceActiveConversation(sessionId, snapshot.conversation);
        },
      });
    },
    async conversation() {
      return (await storage.get(activeConversationKey(sessionId)))[activeConversationKey(sessionId)];
    },
  };
}

test("stopping before the user-message write lands leaves no model or display prompt", async t => {
  const run = await harness({ holdWrite: true });
  t.after(() => { run.releaseWrite.resolve(); run.releaseConfig.resolve(); run.releaseModel.resolve(); });
  await run.writeEntered.promise;
  const stopped = run.stop();
  run.releaseWrite.resolve();
  await stopped;
  await run.task.promise.catch(() => {});
  assert.equal(containsMarker(await run.conversation()), false);
  assert.equal(containsMarker(run.transcript.snapshot(run.sessionId)), false);
  assert.equal(run.events.some(event => event.type === "agent_start"), false);
});

test("stopping after the user-message write still drops the unstarted prompt", async t => {
  const run = await harness({ holdConfig: true });
  t.after(() => { run.releaseWrite.resolve(); run.releaseConfig.resolve(); run.releaseModel.resolve(); });
  await run.configEntered.promise;
  assert.equal(containsMarker(await run.conversation()), true);
  assert.equal(containsMarker(run.transcript.snapshot(run.sessionId)), true);
  await run.stop();
  run.releaseConfig.resolve();
  await run.task.promise.catch(() => {});
  assert.equal(containsMarker(await run.conversation()), false);
  assert.equal(containsMarker(run.transcript.snapshot(run.sessionId)), false);
  assert.equal(run.events.some(event => event.type === "agent_start"), false);
});

test("a later stop keeps a prompt whose startup already failed", async t => {
  const run = await harness({ failConfig: true });
  t.after(() => { run.releaseWrite.resolve(); run.releaseConfig.resolve(); run.releaseModel.resolve(); });
  await assert.rejects(run.task.promise, /runtime config unavailable/);
  const agent = run.supervisor.peekEntry(run.sessionId).agent;
  assert.equal(agent.discardUnstartedPrompt(), null);
  const revoked = await run.stop();
  assert.equal(revoked.discardedPrompt, null);
  assert.equal(containsMarker(await run.conversation()), true);
  assert.equal(containsMarker(run.transcript.snapshot(run.sessionId)), true);
  assert.equal(run.events.some(event => event.type === "agent_start"), false);
});

test("stopping after agent_start keeps the accepted prompt", async t => {
  const run = await harness({ holdModel: true });
  t.after(() => { run.releaseWrite.resolve(); run.releaseConfig.resolve(); run.releaseModel.resolve(); });
  await run.modelEntered.promise;
  assert.equal(run.events.some(event => event.type === "agent_start"), true);
  await run.stop();
  run.releaseModel.resolve();
  await run.task.promise.catch(() => {});
  assert.equal(containsMarker(await run.conversation()), true);
});

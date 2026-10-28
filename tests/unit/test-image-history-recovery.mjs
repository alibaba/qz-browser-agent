import test from "node:test";
import assert from "node:assert/strict";
import { createSessionNavigationFeature } from "../../src/sidepanel/features/sessions/session-navigation-feature.js";
import { createSidepanelEventRouter } from "../../src/sidepanel/features/app/sidepanel-event-router.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { Agent } from "../../src/background/agent/agent.js";
import { createSessionCommands } from "../../src/background/session/commands.js";
import { createSessionRepository, SESSION_RUNTIME_PREFIX } from "../../src/background/session/repository.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionRuntimeState } from "../../src/background/session/runtime-state.js";
import { createSessionTranscript } from "../../src/background/session/transcript.js";
import { createSessionRecord, serializeConversation, readSessionRecord, deserializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { normalizeSessionRuntimeStatus } from "../../src/shared/session/session-runtime-status.js";
import { SESSION_RECORD_PREFIX } from "../../src/shared/session/session-store.js";

import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";
const assets = installImageAssetsFixture();
test.after(() => assets.dispose());

const noop = () => {};
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlqUAAAAASUVORK5CYII=";
const user = { role: "user", content: [{ type: "text", text: "Remember fixture number 742 and this image" }, { type: "image_url", image_url: { url: image, detail: "auto" } }] };
const messages = [{ role: "system", content: "fixture" }, user, { role: "assistant", content: "I remember 742" }];

test('transport failures never project into Agent state, transcripts or reconciliation', () => {
  const failures = [];
  const unexpected = () => assert.fail('transport failures must stay outside Agent event handling');
  const router = createSidepanelEventRouter({
    switchToSession() {}, onTransportError: event => failures.push(event), onEvent: unexpected,
    sessionState: { applyEvent: unexpected }, runController: {}, transcriptRenderer: {},
    transcriptReconcile: { handleEvent: unexpected }, queuedFollowups: {}, goalStrip: {}, runStates: {},
  });
  for (const type of ['request_failed', 'transport_error']) router.handle({ type, sessionId: 's1', code: 'MESSAGE_TOO_LARGE', message: 'too large' });
  assert.deepEqual(failures.map(event => event.type), ['request_failed', 'transport_error']);
});


test("snapshot and save requests retain the complete conversation contract", () => {
  const sends = [];
  const conversation = serializeConversation(messages);
  const navigation = createSessionNavigationFeature({
    getCurrentSessionId: () => "s1", send: event => sends.push(event),
    transcriptRenderer: { applyRuntimeSnapshot: () => true, maybeRenderUpdated: noop },
  });
  navigation.requestConversationSnapshot("s1");
  navigation.requestConversationSnapshot("s1", { persist: true });
  navigation.applyConversationSnapshot({ sessionId: "s1", conversation, transcript: [], persist: true });
  assert.deepEqual(sends, [
    { type: "get_messages", sessionId: "s1", save: false },
    { type: "get_messages", sessionId: "s1", save: true },
    { type: "save_session_record", sessionId: "s1", session: conversation },
  ]);
});

test("opening a naturally imported conversation restores its complete model history", async () => {
  const f = fixture();
  const imported = await f.commands.importSessionExchangeRuntime(createSessionExchangePayload({
    session: { id: "source", title: "Imported images" }, conversation: serializeConversation(messages),
    runtime: { status: "completed" },
  }));
  const id = imported.session.id;
  const record = readSessionRecord(await f.repository.readRecord(id));
  assert.ok(record.transcript.length >= 2);
  assert.equal(await f.repository.readActiveConversation(id), null, "import initially stores the saved record, not an active Agent history");
  let currentId = "previous", epoch = 0;
  const sends = [], restores = [], seeded = [];
  const navigation = createSessionNavigationFeature({
    getCurrentSessionId: () => currentId, setCurrentSessionIdValue: id => { currentId = id; },
    getSessionSwitchEpoch: () => epoch, incrementSessionSwitchEpoch: () => ++epoch,
    chatTab: "chat", getCurrentTab: () => "other", storage: { local: f.storage },
    perfTrace: (_name, _data, operation) => operation(), perfTraceAsync: (_name, _data, operation) => operation(),
    isRuntimeRunning: () => false, chatScroll: { requestLatest: noop },
    runController: { setSuppressEvents: noop, finish: noop, beginRestore: noop },
    transcriptRenderer: { hasTranscript: () => false, seedFromStorage: (_id, entries) => { seeded.push(entries); return true; }, renderCurrent: noop },
    send(event) {
      sends.push(event);
      if (event.type === "restore_session") restores.push(f.commands.restoreSessionFromApi(event.sessionId, event.session));
    },
  });
  await navigation.switchToSession(id);
  await Promise.all(restores);
  assert.equal(restores.length, 1);
  const restore = sends.find(event => event.type === "restore_session");
  assert.deepEqual(restore, { type: "restore_session", sessionId: id, session: f.storage.snapshot()[`_session_${id}`].conversation });
  assert.ok(!JSON.stringify(restore).includes("data:image/"), "the Agent resolves references without another image-sized IPC copy");
  assert.deepEqual(seeded[0], record.transcript);
  const history = await f.commands.getSessionHistoryRuntime(id);
  assert.deepEqual(history.messages.find(message => message.role === "user"), user);
  assert.equal(history.messages.some(message => message.role === "assistant" && message.content === "I remember 742"), true);
  const persisted = deserializeConversation(await f.repository.readActiveConversation(id));
  assert.deepEqual(persisted.find(message => message.role === "user"), user);
});

test("reopening an interrupted follow-up restores the latest checkpoint to both the chat and Agent", async () => {
  const f = fixture();
  const id = "interrupted-follow-up";
  await f.repository.createMetadata({ id, title: "Interrupted follow-up" });
  const checkpoint = serializeConversation([
    ...messages,
    { role: "user", content: "Continue with the image", clientMessageId: "follow-up" },
    { role: "assistant", content: "Saved answer before restart" },
  ]);
  await f.storage.set({
    [`_session_${id}`]: createSessionRecord(checkpoint, [
      { type: "user", text: "Remember fixture number 742 and this image", images: [{ dataUrl: image }] },
      { type: "thinking", text: "Saved reasoning" },
      { type: "assistant", content: "I remember 742" },
      { type: "user", text: "Continue with the image", clientMessageId: "follow-up" },
      { type: "assistant", content: "Saved answer before restart" },
    ]),
    [`_active_conversation_${id}`]: checkpoint,
  });
  let currentId = null, epoch = 0;
  const seeded = [], restores = [];
  const navigation = createSessionNavigationFeature({
    getCurrentSessionId: () => currentId, setCurrentSessionIdValue: value => { currentId = value; },
    getSessionSwitchEpoch: () => epoch, incrementSessionSwitchEpoch: () => ++epoch,
    chatTab: "chat", getCurrentTab: () => "other", chatScroll: { requestLatest: noop },
    storage: { local: f.storage }, perfTrace: (_name, _detail, action) => action(),
    perfTraceAsync: async (_name, _detail, action) => action(),
    runController: { setSuppressEvents: noop, finish: noop, beginRestore: noop },
    transcriptRenderer: { hasTranscript: () => false, seedFromStorage: (_id, entries) => { seeded.push(entries); return true; }, renderCurrent: noop },
    send(event) {
      if (event.type === "restore_session") restores.push(f.commands.restoreSessionFromApi(event.sessionId, event.session));
    },
  });
  await navigation.switchToSession(id);
  await Promise.all(restores);
  assert.deepEqual(seeded[0].map(entry => entry.text || entry.content), [
    "Remember fixture number 742 and this image", "Saved reasoning", "I remember 742",
    "Continue with the image", "Saved answer before restart",
  ]);
  assert.equal(seeded[0][0].images[0].dataUrl, image);
  const history = await f.commands.getSessionHistoryRuntime(id);
  assert.deepEqual(history.messages.filter(message => message.role !== "system"), checkpoint.entries.map(entry => entry.message));
});

test("legacy exchange -> stored references -> new exchange -> independent image-preserving clone", async () => {
  const f = fixture();
  const legacy = createSessionExchangePayload({ session: { id: "legacy", title: "Image exchange" },
    conversation: serializeConversation(messages), transcript: [{ type: "user", text: "image", images: [{ dataUrl: image }] }] });
  const source = await f.commands.importSessionExchangeRuntime(JSON.parse(JSON.stringify(legacy)));
  const sourceId = source.session.id;
  assert.ok(!JSON.stringify(f.storage.snapshot()[`_session_${sourceId}`]).includes("data:image/"));
  const exported = await f.commands.exportSessionExchangeRuntime(sourceId);
  const file = JSON.stringify(exported);
  assert.ok(file.includes(image));
  assert.ok(!file.includes("qz-history-image:"));
  // Export/import is the application's independent-copy operation; there is no
  // separate fork/duplicate Session command in this branch.
  const clone = await f.commands.importSessionExchangeRuntime(JSON.parse(file));
  assert.notEqual(clone.session.id, sourceId);
  await f.repository.deleteSession(sourceId);
  const cloned = readSessionRecord(await f.repository.readRecord(clone.session.id));
  assert.equal(cloned.transcript[0].images[0].dataUrl, image);
  await f.commands.restoreSessionFromApi(clone.session.id, cloned.conversation);
  const replay = await f.commands.getSessionHistoryRuntime(clone.session.id);
  assert.deepEqual(replay.messages.find(message => message.role === "user" && Array.isArray(message.content)), user);
  const exportedClone = await f.commands.exportSessionExchangeRuntime(clone.session.id);
  assert.ok(JSON.stringify(exportedClone).includes(image));
});

for (const [stage, prefix] of [["runtime checkpoint", SESSION_RUNTIME_PREFIX], ["history record", SESSION_RECORD_PREFIX]]) {
  test(`a failed stop ${stage} rejects without retaining a new Session admission lock`, async () => {
    const f = fixture();
    const id = "stopping";
    await f.repository.createMetadata({ id, title: "Stop storage failure" });
    const old = await f.supervisor.getAgent(id);
    old.messages = structuredClone(messages);
    await old.persist();
    f.runtime.set(id, { status: "running", running: true, runId: "old-run" });
    await f.runtime.persist(id, { terminal: true });
    const nativeSet = f.storage.set;
    f.storage.set = async patch => {
      if (Object.hasOwn(patch, prefix + id)) throw new Error(`${stage} unavailable`);
      return nativeSet(patch);
    };
    await assert.rejects(f.commands.stopSessionRuntime(id, { cascade: false }), new RegExp(`${stage} unavailable`));
    assert.equal(f.broadcasts.some(event => event.type === "state" && event.status === "aborted"), false);
    assert.equal(f.leases[0].isActive(), false, "the old Agent remains revoked even when persistence fails");
    assert.equal(f.supervisor.peekEntry(id).agent, null);
    f.storage.set = nativeSet;
    let resumed = false;
    const next = await f.commands.startSessionAgentTask({ sessionId: id, operationName: "storage_recovery", operation: ({ agent }) => {
      assert.notEqual(agent, old);
      assert.deepEqual(agent.messages.find(message => message.role === "user"), user);
      resumed = true;
    } });
    await next.promise;
    assert.equal(resumed, true, "a storage failure must not add a permanent SESSION_STOPPING gate");
  });
}

function fixture() {
  const storage = createMemoryStorage();
  const repository = createSessionRepository({ storage });
  const normalizeId = value => String(value || "").trim();
  const leases = [], broadcasts = [];
  const supervisor = createSessionSupervisor({
    createAgent: lease => { leases.push(lease); return new Agent(lease.sessionId, { conversationRepository: repository, conversationLease: lease }); },
    initializeAgent: agent => agent.hydrateFromStore(),
  });
  const runtime = createSessionRuntimeState({ supervisor, repository, getSessions: repository.listMetadata,
    getAgentEntry: supervisor.getEntry, normalizeSessionId: normalizeId, logger: { warn: noop, debug: noop } });
  const getLiveEntry = async id => { const entry = supervisor.peekEntry(id); return entry?.agent ? entry : null; };
  const transcript = createSessionTranscript({ repository, supervisor,
    getLiveAgentEntry: getLiveEntry, normalizeSessionId: normalizeId,
    resolveToolDefinition: () => null, getToolIdentity: () => ({}) });
  const commands = createSessionCommands({ runtime, transcript, sessionRuntimeReady: Promise.resolve(),
    sessionSupervisor: supervisor, sessionRepository: repository, normalizeSessionId: normalizeId,
    requireExplicitSessionId: normalizeId, normalizeRuntimeStatus: normalizeSessionRuntimeStatus,
    getSessions: repository.listMetadata, isAutomationSessionTree: () => false, broadcast: event => broadcasts.push(event),
    agents: { getLiveEntry, getAgent: supervisor.getAgent,
      ensureConversationForHistoryMutation: async () => true, handleEvent: noop },
    artifacts: { clearListSummaryPatch: noop, clearSummaryRefresh: noop, buildListSummary: async () => ({}), collect: async () => ({}), empty: () => ({}) },
    tabs: { getOwnedTabContexts: async () => [], closeOwnedTabsAfterTerminal: async () => {} },
    getCurrentRuntimeConfig: async () => ({}), llmChat: async () => assert.fail("history restoration must not invoke a model"),
    buildSessionTitleMessages: () => [], collectBrowserContext: async () => ({}),
    usageCollector: { recordAgentEvent: noop }, getAutomationRuntime: () => ({ syncSessionOutcome: noop }),
  });
  return { storage, repository, supervisor, runtime, commands, leases, broadcasts };
}

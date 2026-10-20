import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRecord, readSessionRecord, serializeConversation, deserializeConversationWithRepair, transcriptFromConversation } from '../../src/shared/session/session-codec.js';
import { normalizeSessionExchangePayload, SESSION_EXCHANGE_FORMAT } from '../../src/shared/session/session-exchange.js';
import { createSessionRepository } from '../../src/background/session/repository.js';
import { createMemoryStorage } from '../support/memory-storage.mjs';
import { createSessionNavigationFeature } from '../../src/sidepanel/features/sessions/session-navigation-feature.js';
import { Agent } from '../../src/background/agent/agent.js';
import { createTestAgentOptions } from '../support/agent-services.mjs';

// v3 shape is preserved from the initial repository's session-codec (17c8d2cd).
const legacyRecord = () => ({
  type: 'qz-browser-agent-session', version: 3,
  conversation: { type: 'conversation', version: 1, entries: [
    { type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-01-01 12:00:00', message: { role: 'user', content: 'old question' } },
    { type: 'message', id: 'entry-2', parentId: 'entry-1', timestamp: '2026-01-01 12:00:01', message: { role: 'assistant', content: 'old answer' } },
  ] },
  transcript: [{ type: 'user', text: 'old question' }, { type: 'assistant', content: 'old answer' }],
});
const currentConversation = () => serializeConversation([{ role: 'user', content: 'current' }]);
const futureRecord = () => ({ ...legacyRecord(), version: 99, futureField: { mustSurvive: true } });
const lease = { sessionId: 'test', isActive: () => true };

test('a transcript-only snapshot retains its content without inventing a conversation format', () => {
  const transcript = [{ type: 'assistant', content: 'exported result' }];
  for (const conversation of [undefined, null]) {
    const saved = createSessionRecord(conversation, transcript);
    const loaded = readSessionRecord(saved);
    assert.deepEqual(loaded.conversation.entries, []);
    assert.equal(loaded.transcript[0].content, 'exported result');
  }
  assert.deepEqual(readSessionRecord(null), { conversation: null, transcript: [] });
});

test('record v3 migrates in memory without touching the source or losing message identity', async () => {
  const saved = legacyRecord();
  const before = structuredClone(saved);
  const read = readSessionRecord(saved);
  assert.deepEqual(saved, before);
  assert.deepEqual(read.conversation.entries.map(entry => [entry.id, entry.parentId]), [['entry-1', null], ['entry-2', 'entry-1']]);
  assert.equal(read.transcript[1].content, 'old answer');
  const storage = createMemoryStorage({ _session_test: saved });
  const repository = createSessionRepository({ storage });
  assert.equal((await repository.readRecord('test')).version, 3);
  const migrated = createSessionRecord(read.conversation, read.transcript);
  await repository.writeRecord('test', migrated);
  assert.equal((await repository.readRecord('test')).version, 4);
  assert.deepEqual(readSessionRecord(migrated), read);
});

for (const version of [1, 2, 5, 99, '4', null]) test(`unverified record version ${JSON.stringify(version)} is explicit, never empty`, () => {
  const saved = { ...legacyRecord(), version };
  assert.throws(() => readSessionRecord(saved), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  assert.equal(saved.version, version);
});

test('future conversation versions cannot be deserialized, exported, or relabelled', () => {
  const future = { ...currentConversation(), version: 2 };
  for (const decode of [
    () => deserializeConversationWithRepair(future, 'system'),
    () => transcriptFromConversation(future),
    () => createSessionRecord(future, []),
    () => readSessionRecord({ ...legacyRecord(), conversation: future }),
    () => normalizeSessionExchangePayload({ format: SESSION_EXCHANGE_FORMAT, version: 1, session: { conversation: future } }),
  ]) assert.throws(decode, { code: 'UNSUPPORTED_CONVERSATION_VERSION' });
  assert.equal(future.version, 2);
});

test('known pre-versioned conversation forms retain their messages', () => {
  const messages = [{ role: 'user', content: 'legacy' }];
  for (const value of [messages, { messages }, { entries: messages.map(message => ({ message })) }]) {
    assert.equal(deserializeConversationWithRepair(value).messages[0].content, 'legacy');
    assert.equal(createSessionRecord(value, []).conversation.entries[0].message.content, 'legacy');
  }
});

for (const withActive of [false, true]) test(`future record blocks old active fallback and writes (active=${withActive})`, async () => {
  const storage = createMemoryStorage({ _session_test: futureRecord(), ...(withActive ? { _active_conversation_test: currentConversation() } : {}) });
  const repository = createSessionRepository({ storage });
  const before = storage.snapshot();
  await assert.rejects(repository.readActiveConversation('test'), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  await assert.rejects(repository.writeRecord('test', createSessionRecord(currentConversation(), [])), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  await assert.rejects(repository.writeActiveConversation('test', currentConversation(), lease), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  await assert.rejects(repository.clearActiveConversation('test', lease), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  const agent = new Agent('test', createTestAgentOptions({ conversationRepository: repository, conversationLease: lease }));
  await assert.rejects(agent.hydrateFromStore(), { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  assert.deepEqual(storage.snapshot(), before);
  assert.equal(agent.messages.length, 1);
});

test('future active conversation blocks record writes even without a saved record', async () => {
  const storage = createMemoryStorage({ _active_conversation_test: { ...currentConversation(), version: 99 } });
  const repository = createSessionRepository({ storage });
  const before = storage.snapshot();
  await assert.rejects(repository.writeRecord('test', createSessionRecord(currentConversation(), [])), { code: 'UNSUPPORTED_CONVERSATION_VERSION' });
  assert.deepEqual(storage.snapshot(), before);
});

test('a failed legacy save preserves the old record and the serial queue accepts a retry', async () => {
  const base = createMemoryStorage({ _session_test: legacyRecord() });
  let fail = true;
  const storage = { get: (...args) => base.get(...args), remove: (...args) => base.remove(...args), set: async values => { if (fail) { fail = false; throw new Error('disk unavailable'); } return base.set(values); } };
  const repository = createSessionRepository({ storage });
  const read = readSessionRecord(await repository.readRecord('test'));
  const migrated = createSessionRecord(read.conversation, read.transcript);
  await assert.rejects(repository.writeRecord('test', migrated), /disk unavailable/);
  assert.deepEqual(base.snapshot()._session_test, legacyRecord());
  await repository.writeRecord('test', migrated);
  assert.equal(base.snapshot()._session_test.version, 4);
});

test('write lease is rechecked after asynchronous compatibility reads', async () => {
  const base = createMemoryStorage();
  let active = true;
  let release;
  let began;
  const reading = new Promise(resolve => { began = resolve; });
  const storage = { ...base, get: async keys => { began(); await new Promise(resolve => { release = resolve; }); return base.get(keys); } };
  const repository = createSessionRepository({ storage });
  const pending = repository.writeActiveConversation('test', currentConversation(), { sessionId: 'test', isActive: () => active });
  await reading;
  active = false;
  release();
  await assert.rejects(pending, { code: 'STALE_SESSION_LEASE' });
  assert.deepEqual(base.snapshot(), {});
});

test('queued writes validate the current stored version when they execute', async () => {
  const base = createMemoryStorage({ _session_test: legacyRecord() });
  let release;
  let began;
  const reading = new Promise(resolve => { began = resolve; });
  let pause = true;
  const storage = { ...base, get: async keys => {
    if (pause) { pause = false; began(); await new Promise(resolve => { release = resolve; }); }
    return base.get(keys);
  } };
  const repository = createSessionRepository({ storage });
  const record = createSessionRecord(currentConversation(), []);
  const first = repository.writeRecord('test', record);
  const second = repository.writeRecord('test', record);
  await reading;
  await base.set({ _session_test: futureRecord() });
  release();
  await assert.rejects(first, { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  await assert.rejects(second, { code: 'UNSUPPORTED_SESSION_RECORD_VERSION' });
  assert.deepEqual(base.snapshot()._session_test, futureRecord());
});

test('navigation projects legacy history only without a display snapshot and preserves future-version guidance', async () => {
  const legacyWithoutTranscript = legacyRecord();
  delete legacyWithoutTranscript.transcript;
  for (const saved of [legacyWithoutTranscript, { ...legacyRecord(), transcript: [] }, futureRecord()]) {
    const storage = createMemoryStorage({ _session_test: saved, _active_conversation_test: currentConversation() });
    if (saved.version === 3) await storage.remove('_active_conversation_test');
    const before = storage.snapshot();
    const fixture = navigationFixture(storage);
    const result = await fixture.navigation.switchToSession('test');
    if (saved.version === 3) {
      if ('transcript' in saved) assert.deepEqual(fixture.transcript, []);
      else assert.deepEqual(fixture.transcript.map(entry => entry.text ?? entry.content), ['old question', 'old answer']);
      assert.equal(fixture.sent.find(message => message.type === 'restore_session').session.entries.length, 2);
    } else {
      assert.equal(result, false);
      assert.equal(fixture.transcript[0].type, 'error');
      assert.match(fixture.transcript[0].text, /原始数据已保留/);
      assert.equal(fixture.sent.some(message => ['restore_session', 'save_session_record'].includes(message.type)), false);
    }
    assert.deepEqual(storage.snapshot(), before);
  }
});

function navigationFixture(storage) {
  let current = null;
  let epoch = 0;
  const fixture = { transcript: [], sent: [], navigation: null };
  fixture.navigation = createSessionNavigationFeature({
    storage: { local: storage }, chatTab: 'chat', getCurrentTab: () => 'sessions', getCurrentSessionId: () => current,
    setCurrentSessionIdValue: id => { current = id; }, getSessionSwitchEpoch: () => epoch, incrementSessionSwitchEpoch: () => ++epoch,
    composer: { prepareSession: async () => null, handleSessionChanged() {} }, send: message => fixture.sent.push(message),
    sessions: { scheduleRefresh() {} }, sessionExport: { syncCurrentControl() {} }, goalStrip: { renderCurrent() {} }, chatScroll: { requestLatest() {} },
    runController: { setSuppressEvents() {}, finish() {}, beginRestore() {}, syncCurrentRuntimeView() {} },
    transcriptRenderer: { hasTranscript: () => false, seedFromStorage: (_id, transcript) => { fixture.transcript = transcript; }, setTranscript: (_id, transcript) => { fixture.transcript = transcript; }, renderCurrent() {} },
    perfTrace: (_name, _meta, operation) => operation(), perfTraceAsync: (_name, _meta, operation) => operation(),
    getRuntime: () => ({ status: 'idle' }), isRuntimeRunning: () => false, switchToChatTab() {}, resetUi() {},
  });
  return fixture;
}

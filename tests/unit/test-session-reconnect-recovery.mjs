import assert from "node:assert/strict";
import { createSidepanelPortRuntime } from "../../src/sidepanel/features/app/sidepanel-port-runtime.js";
import { createAppShellFeature } from "../../src/sidepanel/features/app/app-shell-feature.js";
import { createSessionNavigationFeature } from "../../src/sidepanel/features/sessions/session-navigation-feature.js";
import { persistSessionImages, resolveSessionImages } from "../../src/shared/session/session-image-assets.js";
import { createSessionRecord, serializeConversation } from "../../src/shared/session/session-codec.js";
import { installImageAssetsFixture } from "../support/image-assets-fixture.mjs";

await portReconnectRequestsOnlyTheCurrentSessionState();
await deliveryTraceFollowsTheLiveDebugSetting();
await sessionNavigationAlwaysRequestsAuthoritativeState();
await sessionCreationKeepsItsSourceDraftIdentity();
await finishedSessionCreationDoesNotUndoNewerNavigation();
await currentSessionClickCancelsAnOlderPendingSwitch();
await repeatedTargetClickKeepsItsHydrationOwner();
await onlyTheLatestPreparedSessionCanCommit();
await materializedDraftDoesNotCancelRequestedSwitch();
await newChatAlwaysReloadsTheComposer();
await cancelledRestoreCannotCommitOrReveal();
await supersededNavigationStopsLoadingImagePayloads();
await navigationHydratesTheUiButRestoresTheAgentWithReferences();

console.log("session reconnect recovery tests passed");

async function deliveryTraceFollowsTheLiveDebugSetting() {
  let debugEnabled = false;
  const ports = [];
  const runtime = createSidepanelPortRuntime({
    isTraceEnabled: () => debugEnabled,
    shouldKeepAlive: () => false,
    connect({ name }) {
      const port = fakePort(name);
      ports.push(port);
      return port;
    },
  });
  runtime.start();
  const port = ports[0];
  port.sent.length = 0;

  runtime.emitStreamTrace("message_delivery", {
    sessionId: "s1",
    streamTraceId: "message-1",
  }, { phase: "ui.submitted" });
  assert.deepEqual(port.sent, [], "normal mode must not publish UI trace traffic");

  debugEnabled = true;
  runtime.emitStreamTrace("message_delivery", {
    sessionId: "s1",
    streamTraceId: "message-1",
  }, { phase: "ui.submitted", message: "message-1" });
  assert.deepEqual(port.sent, [{
    type: "stream_trace",
    stage: "message_delivery",
    traceId: "message-1",
    sessionId: "s1",
    runId: "",
    spanId: "",
    fields: {
      event: "",
      n: 0,
      chars: 0,
      deltaChars: 0,
      gapMs: 0,
      phase: "ui.submitted",
      message: "message-1",
    },
  }]);
  runtime.stop();
}

async function portReconnectRequestsOnlyTheCurrentSessionState() {
  let currentSessionId = "s1";
  const ports = [];
  const runtime = createSidepanelPortRuntime({
    getCurrentSessionId: () => currentSessionId,
    shouldKeepAlive: () => false,
    reconnectDelayMs: 1,
    maxReconnectDelayMs: 1,
    connect({ name }) {
      const port = fakePort(name);
      ports.push(port);
      return port;
    },
  });

  runtime.start();
  assert.deepEqual(ports[0].sent, [{ type: "get_state", sessionId: "s1" }]);
  const attachPromise = runtime.attachWindow(9);
  const attachRequest = ports[0].sent.at(-1);
  assert.equal(attachRequest.type, "sidepanel_attach");
  assert.equal(attachRequest.windowId, 9);
  ports[0].onMessage.emit({
    type: "sidepanel_attached",
    requestId: attachRequest.requestId,
    windowId: 9,
  });
  await attachPromise;

  currentSessionId = "s2";
  ports[0].emitDisconnect();
  await waitFor(() => ports.length === 2);
  assert.deepEqual(ports[1].sent, [
    { type: "sidepanel_attach", windowId: 9 },
    { type: "get_state", sessionId: "s2" },
  ]);

  runtime.stop();
}

async function sessionNavigationAlwaysRequestsAuthoritativeState() {
  let currentSessionId = null;
  const sent = [];
  const navigation = createSessionNavigationFeature({
    chatTab: "chat",
    getCurrentTab: () => "sessions",
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionIdValue: value => { currentSessionId = value; },
    getSessionSwitchEpoch: () => 0,
    incrementSessionSwitchEpoch: () => 1,
    send: message => sent.push(message),
    sessionExport: { syncCurrentControl() {} },
    goalStrip: { renderCurrent() {} },
    sessions: {
      scheduleRefresh() {},
    },
    chatScroll: { requestLatest() {} },
    runController: {
      syncCurrentRuntimeView() {},
      finish() {},
    },
    getRuntime: () => ({ status: "idle", running: false }),
    isRuntimeRunning: () => false,
    switchToChatTab() {},
  });

  navigation.setCurrentSessionId("s1");
  assert.deepEqual(sent, [{ type: "get_state", sessionId: "s1" }]);

  sent.length = 0;
  await navigation.switchToSession("s1");
  assert.deepEqual(sent, [{ type: "get_state", sessionId: "s1" }]);
}

async function sessionCreationKeepsItsSourceDraftIdentity() {
  const sourceDraft = { sessionId: null };
  let adoptedDraft = null;
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => null,
    setCurrentSessionId: () => {},
    getEpoch: () => 0,
    incrementEpoch: () => 1,
    prepareSession: async () => null,
    adoptSession: (_sessionId, draft) => {
      adoptedDraft = draft;
      return draft;
    },
    request: async () => ({ session: { id: "created", title: "Created" } }),
  });

  await navigation.createSession("Created", sourceDraft);
  assert.equal(adoptedDraft, sourceDraft);
}

async function finishedSessionCreationDoesNotUndoNewerNavigation() {
  let currentSessionId = null;
  let switchEpoch = 0;
  let finishCreation;
  const sourceDraft = { sessionId: null };
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: value => { currentSessionId = value; },
    getEpoch: () => switchEpoch,
    incrementEpoch: () => ++switchEpoch,
    prepareSession: async sessionId => ({ sessionId }),
    adoptSession: (sessionId, draft) => {
      draft.sessionId = sessionId;
      return draft;
    },
    request: () => new Promise(resolve => { finishCreation = resolve; }),
  });

  const pending = navigation.createSession("Created", sourceDraft);
  await waitFor(() => currentSessionId && typeof finishCreation === "function");
  const createdSessionId = currentSessionId;
  await navigation.transitionToSession(null);
  finishCreation({ session: { id: createdSessionId, title: "Created" } });
  await pending;
  assert.equal(currentSessionId, null, "a late create response must not reopen the draft the user left");
}

async function currentSessionClickCancelsAnOlderPendingSwitch() {
  let currentSessionId = "a";
  let switchEpoch = 0;
  let resolveDraft;
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: value => { currentSessionId = value; },
    getEpoch: () => switchEpoch,
    incrementEpoch: () => ++switchEpoch,
    prepareSession: sessionId => sessionId === "b"
      ? new Promise(resolve => { resolveDraft = resolve; })
      : Promise.resolve({ sessionId }),
  });

  const pending = navigation.switchToSession("b");
  await waitFor(() => typeof resolveDraft === "function");
  await navigation.switchToSession("a");
  resolveDraft({ sessionId: "b" });
  await pending;
  assert.equal(currentSessionId, "a", "clicking the current Session must cancel an older pending switch");
}

async function onlyTheLatestPreparedSessionCanCommit() {
  let currentSessionId = "a";
  let switchEpoch = 0;
  const resolvers = new Map();
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: value => { currentSessionId = value; },
    getEpoch: () => switchEpoch,
    incrementEpoch: () => ++switchEpoch,
    prepareSession: sessionId => new Promise(resolve => resolvers.set(sessionId, resolve)),
  });

  const first = navigation.transitionToSession("b");
  const second = navigation.transitionToSession("c");
  await waitFor(() => resolvers.size === 2);
  resolvers.get("c")({ sessionId: "c" });
  await second;
  resolvers.get("b")({ sessionId: "b" });
  await first;
  assert.equal(currentSessionId, "c", "a slower prepared draft must not overwrite the latest navigation intent");
}

async function materializedDraftDoesNotCancelRequestedSwitch() {
  let currentSessionId = null;
  let switchEpoch = 0;
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: value => { currentSessionId = value; },
    getEpoch: () => switchEpoch,
    incrementEpoch: () => ++switchEpoch,
    prepareSession: async sessionId => {
      currentSessionId = "materialized-draft";
      return { sessionId };
    },
  });

  assert.equal(await navigation.transitionToSession("target"), true);
  assert.equal(currentSessionId, "target", "materializing the source draft must not swallow the first navigation");
}

async function newChatAlwaysReloadsTheComposer() {
  const newButton = fakeElement();
  const root = fakeElement({ querySelectorAll: () => [] });
  let transition = null;
  let currentTab = "chat";
  const shell = createAppShellFeature({
    ui: {
      getPages: () => [], getPage: id => ({ id }), isPageEnabled: () => true,
      subscribeChanges: () => () => {}, activatePage() {}, deactivatePage() {}, emit() {},
      closeTopmostOverlay: () => false,
      hasBlockingOverlay: () => false,
    },
    root,
    newButton,
    tabs: { CHAT: "chat", LOGS: "logs" },
    panels: {},
    getCurrentTab: () => currentTab,
    setCurrentTab: value => { currentTab = value; },
    isDebugEnabled: () => false,
    logs: { setEnabled() {} },
    runController: { renderDock() {}, setSuppressEvents() {}, finish() {} },
    goalStrip: { renderCurrent() {} },
    input: { focus() {} },
    transitionToSession: async (...args) => { transition = args; },
  });
  shell.start();
  newButton.dispatchEvent(new Event("click"));
  await waitFor(() => transition !== null);
  shell.stop();

  assert.deepEqual(transition, [null, { reload: true }]);
}

async function repeatedTargetClickKeepsItsHydrationOwner() {
  let currentSessionId = "a";
  let switchEpoch = 0;
  let resolveRecord;
  let hydrated = false;
  const navigation = createNavigationFixture({
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: value => { currentSessionId = value; },
    getEpoch: () => switchEpoch,
    incrementEpoch: () => ++switchEpoch,
    prepareSession: sessionId => Promise.resolve({ sessionId }),
    hasTranscript: () => false,
    readStorage: () => new Promise(resolve => { resolveRecord = resolve; }),
    seedTranscript: () => { hydrated = true; },
  });

  const first = navigation.switchToSession("b");
  await waitFor(() => currentSessionId === "b" && typeof resolveRecord === "function");
  await navigation.switchToSession("b");
  assert.equal(switchEpoch, 1, "a repeated click must not cancel the in-flight hydration for its own target");
  resolveRecord({
    _session_b: {
      type: "qz-browser-agent-session",
      version: 4,
      conversation: { type: "conversation", version: 1, entries: [] },
      transcript: [{ type: "assistant", content: "restored" }],
    },
  });
  await first;
  assert.equal(hydrated, true, "the original hydration owner must still reveal the repeated target");
}

async function cancelledRestoreCannotCommitOrReveal() {
  for (const boundary of ["composer", "storage"]) {
    let current = "before";
    let epoch = 0;
    let release;
    let entered;
    const pending = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    let hydrated = 0;
    let revealed = 0;
    const wait = () => { entered(); return pending; };
    const navigation = createNavigationFixture({
      getCurrentSessionId: () => current, setCurrentSessionId: id => { current = id; },
      getEpoch: () => epoch, incrementEpoch: () => ++epoch,
      prepareSession: boundary === "composer" ? wait : async () => null,
      readStorage: boundary === "storage" ? wait : async () => ({}),
      hasTranscript: () => false, seedTranscript: () => { hydrated++; },
      switchToChatTab: () => { revealed++; },
    });
    const controller = new AbortController();
    const restoring = navigation.switchToSession("target", { source: "restore", signal: controller.signal });
    await reached;
    controller.abort();
    release(boundary === "composer" ? null : {});
    await restoring;
    assert.equal(hydrated, 0, `${boundary}: cancelled restoration cannot hydrate`);
    assert.equal(revealed, 0, `${boundary}: cancelled restoration cannot reclaim navigation`);
    if (boundary === "composer") assert.equal(current, "before", "cancelled draft read cannot change the selected session");
    // Cancellation releases a pending reveal, allowing a later explicit click to recover.
    await navigation.switchToSession("target");
    assert.equal(revealed, 1, `${boundary}: a fresh navigation still works`);
  }
}

async function navigationHydratesTheUiButRestoresTheAgentWithReferences() {
  const assets = installImageAssetsFixture();
  try {
    const image = "data:image/png;base64,AAAA";
    const conversation = serializeConversation([{ role: "user", content: [{ type: "image_url", image_url: { url: image } }] }]);
    const stored = await persistSessionImages({
      _session_target: createSessionRecord([], [{ type: "user", text: "image", images: [{ dataUrl: image }] }]),
      _active_conversation_target: conversation,
    });
    let current = "before", epoch = 0, transcript;
    const sent = [];
    const navigation = createNavigationFixture({
      getCurrentSessionId: () => current, setCurrentSessionId: id => { current = id; },
      getEpoch: () => epoch, incrementEpoch: () => ++epoch,
      prepareSession: async () => null, hasTranscript: () => false,
      readStorage: async () => stored, seedTranscript: (_id, entries) => { transcript = entries; },
      send: message => sent.push(message),
    });
    await navigation.switchToSession("target");
    assert.equal(transcript[0].images[0].dataUrl, image, "all UI images are hydrated before reveal");
    const restored = sent.find(message => message.type === "restore_session");
    assert.equal(restored.sessionId, "target");
    assert.deepEqual(restored.session, stored._active_conversation_target, "active conversation precedence survives transport");
    assert.ok(!JSON.stringify(restored).includes("data:image/"), "restore IPC does not clone image bytes");
    assert.deepEqual(await resolveSessionImages(restored.session), conversation, "Agent hydration receives the exact original snapshot");
  } finally { assets.dispose(); }
}

async function supersededNavigationStopsLoadingImagePayloads() {
  for (const action of ["abort", "switch"]) for (const boundary of ["storage", "image"]) {
    const assets = installImageAssetsFixture();
    const nativeText = Blob.prototype.text;
    try {
      const stored = await persistSessionImages({ _session_target: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [index, `data:image/png;base64,${Buffer.from([index]).toString("base64")}`]),
      ) });
      let current = "before", epoch = 0, reads = 0, hydrated = 0;
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      Blob.prototype.text = async function () {
        reads++;
        if (boundary === "image") { entered.resolve(); await release.promise; }
        return nativeText.call(this);
      };
      const navigation = createNavigationFixture({
        getCurrentSessionId: () => current, setCurrentSessionId: id => { current = id; },
        getEpoch: () => epoch, incrementEpoch: () => ++epoch,
        prepareSession: async () => null, hasTranscript: () => false,
        seedTranscript: () => { hydrated++; },
        readStorage: async keys => {
          if (keys[0] !== "_session_target") return {};
          if (boundary === "storage") { entered.resolve(); await release.promise; }
          return stored;
        },
      });
      const controller = new AbortController();
      const pending = navigation.switchToSession("target", { signal: controller.signal });
      await entered.promise;
      if (action === "abort") controller.abort();
      else await navigation.switchToSession("newer");
      release.resolve();
      await pending;
      assert.equal(reads, boundary === "storage" ? 0 : 4, `${action}/${boundary}: no further batch starts after revocation`);
      assert.equal(hydrated, action === "switch" ? 1 : 0, "only the current view may hydrate");
    } finally {
      Blob.prototype.text = nativeText;
      assets.dispose();
    }
  }
}

function createNavigationFixture({
  getCurrentSessionId,
  setCurrentSessionId,
  getEpoch,
  incrementEpoch,
  prepareSession,
  adoptSession = () => null,
  request = async () => ({}),
  send = () => {},
  hasTranscript = () => true,
  readStorage = () => Promise.resolve({}),
  seedTranscript = () => {},
  switchToChatTab = () => {},
}) {
  return createSessionNavigationFeature({
    chatTab: "chat",
    getCurrentTab: () => "sessions",
    getCurrentSessionId,
    setCurrentSessionIdValue: setCurrentSessionId,
    getSessionSwitchEpoch: getEpoch,
    incrementSessionSwitchEpoch: incrementEpoch,
    composer: {
      prepareSession,
      adoptSession,
      handleSessionChanged() {},
    },
    request,
    send,
    sessionExport: { syncCurrentControl() {} },
    goalStrip: { renderCurrent() {} },
    sessions: { scheduleRefresh() {} },
    chatSearch: { close() {} },
    chatScroll: { requestLatest() {} },
    runController: {
      setSuppressEvents() {},
      syncCurrentRuntimeView() {},
      finish() {},
      beginRestore() {},
    },
    transcriptRenderer: {
      hasTranscript,
      seedFromStorage: seedTranscript,
      setTranscript() {},
      render() {},
      renderCurrent() {},
    },
    storage: { local: { get: readStorage } },
    perfTrace: (_name, _meta, fn) => fn(),
    perfTraceAsync: (_name, _meta, fn) => fn(),
    getRuntime: () => ({ status: "idle", running: false }),
    isRuntimeRunning: () => false,
    switchToChatTab,
    resetUi() {},
  });
}

function fakePort(name) {
  const onMessage = makeEvent();
  const onDisconnect = makeEvent();
  return {
    name,
    sent: [],
    onMessage,
    onDisconnect,
    postMessage(message) {
      this.sent.push(structuredClone(message));
    },
    disconnect() {
      onDisconnect.emit();
    },
    emitDisconnect() {
      onDisconnect.emit();
    },
  };
}

function fakeElement(values = {}) {
  const element = new EventTarget();
  element.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  element.querySelectorAll = () => [];
  return Object.assign(element, values);
}

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
  };
}

async function waitFor(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for reconnect");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

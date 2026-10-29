import assert from "node:assert/strict";
import { createComposerFeature } from "../../src/sidepanel/features/chat/composer-feature.js";

await failedImageNormalizationPreservesStoredDraft();
await draftsFollowSessionSwitches();
await concurrentFirstWritesCreateOneSession();
await doubleSendDuringSessionCreationSubmitsOnce();
await sendWaitsForProvisionedFirstSessionCreation();
await concurrentTargetLoadsShareOneRequest();
await typingWhileTargetLoadsPersistsTheLatestRevision();
await localDraftSurvivesPersistenceFailure();
await sendCarriesTheExactDraftIdentity();
await failedPromptStaysRetryableWithTheSameIdentity();
await pageHidePublishesTheLastTextSnapshot();
await inputResizeTracksAllocatedWidth();
await queuedRestoreStaysWithItsSession();
await queuedRestoreFailurePreservesDraft();
await queuedRestoreReconcilesLostResponses();
await queuedRestoreCannotResurrectDeletedSessions();

console.log("composer draft lifecycle tests passed");

async function queuedRestoreStaysWithItsSession() {
  let respond;
  const fixture = createFixture({ sessionId: "source", request(type, payload, fallback) {
    if (type !== "restore_queued_message") return fallback();
    return new Promise(resolve => { respond = () => resolve({ restored: true, draft: {
      ...payload.draft, text: "queued text\n\noriginal draft", updatedAt: payload.draft.updatedAt + 10,
    } }); });
  } });
  type(fixture, "original draft");
  const pending = fixture.composer.restoreQueuedMessage("source", "queued", "followup");
  assert.equal(fixture.input.readOnly, true);
  assert.deepEqual(await fixture.composer.restoreQueuedMessage("source", "queued", "followup"), { busy: true });
  await switchSession(fixture, "target");
  type(fixture, "target draft");
  respond();
  await pending;
  assert.equal(fixture.input.value, "target draft", "a late recall must not overwrite a different Session");
  await switchSession(fixture, "source");
  assert.equal(fixture.input.value, "queued text\n\noriginal draft");
  assert.equal(fixture.input.readOnly, false);
  await fixture.composer.send();
  assert.equal(fixture.promptRequests[0].text, "queued text\n\noriginal draft");
}

async function queuedRestoreFailurePreservesDraft() {
  const fixture = createFixture({ sessionId: "source", request(type, _payload, fallback) {
    if (type === "restore_queued_message") throw new Error("connection failed");
    return fallback();
  } });
  type(fixture, "unsent work");
  await assert.rejects(fixture.composer.restoreQueuedMessage("source", "queued", "followup"), /connection failed/);
  assert.equal(fixture.input.value, "unsent work");
  assert.equal(fixture.input.readOnly, false);
  await fixture.composer.flushDraft();
  assert.equal(fixture.records.get("source").text, "unsent work");
}

async function queuedRestoreReconcilesLostResponses() {
  for (const queueKind of ["followup", "steering"]) {
    for (const code of ["PORT_DISCONNECTED", "PORT_REQUEST_TIMEOUT", "TRANSPORT_DISCONNECTED", "TRANSPORT_TIMEOUT", "COMPOSER_DRAFT_CHANGED"]) {
      let readStarted, finishRead, reads = 0, restoring = false, restoreRequests = 0;
      const reading = new Promise(resolve => { readStarted = resolve; });
      const gate = new Promise(resolve => { finishRead = resolve; });
      const fixture = createFixture({ sessionId: "source", async request(type, payload, fallback) {
        if (type === "restore_queued_message") {
          restoreRequests++;
          restoring = true;
          fixture.records.set("source", { ...payload.draft, text: "recovered\n\noriginal", updatedAt: payload.draft.updatedAt + 10 });
          throw Object.assign(new Error("restore response lost"), { code });
        }
        if (type === "get_composer_draft" && payload.sessionId === "source" && restoring) {
          reads++;
          if (reads === 1) throw Object.assign(new Error("recovery connection interrupted"), { code: "PORT_DISCONNECTED" });
          readStarted();
          await gate;
        }
        return fallback();
      } });
      type(fixture, "original");
      const pending = fixture.composer.restoreQueuedMessage("source", "queued", queueKind);
      const rejected = assert.rejects(pending, /restore response lost/);
      await reading;
      assert.equal(fixture.input.readOnly, true, "editing waits for authoritative recovery after reconnect");
      await fixture.composer.send();
      assert.equal(fixture.promptRequests.length, 0);
      await switchSession(fixture, "target");
      type(fixture, "other session");
      finishRead();
      await rejected;
      assert.equal(fixture.input.value, "other session");
      await switchSession(fixture, "source");
      assert.equal(fixture.input.value, "recovered\n\noriginal");
      assert.equal(fixture.input.readOnly, false);
      type(fixture, fixture.input.value + " edited");
      await fixture.composer.flushDraft();
      assert.equal(fixture.records.get("source").text, "recovered\n\noriginal edited");
      assert.equal(restoreRequests, 1, "recovery reads the result without replaying the mutation");
    }
  }
}

async function queuedRestoreCannotResurrectDeletedSessions() {
  for (const queueKind of ["followup", "steering"]) {
    let finish, readingStarted;
    const reading = new Promise(resolve => { readingStarted = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    const fixture = createFixture({ sessionId: "source", async request(type, payload, fallback) {
      if (type === "restore_queued_message") throw Object.assign(new Error("response lost"), { code: "PORT_DISCONNECTED" });
      if (type === "get_composer_draft" && payload.afterQueuedMutation) {
        readingStarted();
        await gate;
        return { draft: { sessionId: "source", messageId: "queued", text: "must not resurrect", updatedAt: Date.now() + 1000 } };
      }
      return fallback();
    } });
    type(fixture, "source draft");
    const rejected = assert.rejects(fixture.composer.restoreQueuedMessage("source", "queued", queueKind), /response lost/);
    await reading;
    fixture.composer.forgetSession("source");
    await switchSession(fixture, "target");
    type(fixture, "keep target");
    finish();
    await rejected;
    assert.equal(fixture.input.value, "keep target");
    assert.equal(fixture.input.readOnly, false);
    assert.equal(fixture.records.has("source"), false);
    assert.equal(fixture.promptRequests.length, 0);
  }
}

async function failedImageNormalizationPreservesStoredDraft() {
  const dataUrl = "data:image/png;base64,AAAA";
  const original = { sessionId: "target", messageId: "owned-message", text: "keep this", updatedAt: 1,
    images: [{ attachmentId: "owned-image", dataUrl, name: "old.png", type: "image/png", size: 3 }], documents: [] };
  const records = new Map([["target", structuredClone(original)]]);
  const fixture = createFixture({ sessionId: "source", records });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ textContent: "", get innerHTML() { return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"); } }) };
  try { await switchSession(fixture, "target"); }
  finally { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
  assert.deepEqual(records.get("target"), original, "a decoder failure must not rewrite persisted image bytes");
  await fixture.composer.send();
  assert.equal(fixture.promptRequests.length, 0, "invalid images block submission until explicitly handled");
  type(fixture, "edited text");
  await fixture.composer.flushDraft();
  assert.equal(records.get("target").images[0].dataUrl, dataUrl, "editing text still preserves the failed attachment");
}

async function draftsFollowSessionSwitches() {
  const fixture = createFixture({ sessionId: "source" });
  type(fixture, "source draft");
  await fixture.composer.flushDraft();

  await switchSession(fixture, "target");
  assert.equal(fixture.input.value, "");
  type(fixture, "target draft");
  await fixture.composer.flushDraft();

  await switchSession(fixture, "source");
  assert.equal(fixture.input.value, "source draft");
  await switchSession(fixture, "target");
  assert.equal(fixture.input.value, "target draft");
}

async function concurrentFirstWritesCreateOneSession() {
  let releaseCreation;
  const fixture = createFixture({
    sessionId: null,
    createSession: () => new Promise(resolve => { releaseCreation = resolve; }),
  });
  type(fixture, "new Session draft");
  const first = fixture.composer.flushDraft();
  const second = fixture.composer.flushDraft();
  await waitFor(() => fixture.createSessionCalls() === 1);
  releaseCreation();
  await Promise.all([first, second]);

  assert.equal(fixture.createSessionCalls(), 1);
  assert.equal(fixture.getSessionId(), "created-session");
  assert.equal(fixture.records.get("created-session")?.text, "new Session draft");
}

async function doubleSendDuringSessionCreationSubmitsOnce() {
  let releaseCreation;
  const fixture = createFixture({
    sessionId: null,
    createSession: () => new Promise(resolve => { releaseCreation = resolve; }),
  });
  type(fixture, "send once");
  const first = fixture.composer.send();
  const second = fixture.composer.send();
  await waitFor(() => fixture.createSessionCalls() === 1);
  assert.equal(fixture.input.readOnly, true);
  releaseCreation();
  await Promise.all([first, second]);

  assert.equal(fixture.promptRequests.length, 1);
  assert.equal(fixture.input.readOnly, false);
}

async function sendWaitsForProvisionedFirstSessionCreation() {
  let releaseCreation;
  let modelRequestCount = 0;
  const acceptedMessageIds = new Set();
  const fixture = createFixture({
    sessionId: null,
    provisionSessionBeforeCreateResolve: true,
    createSession: () => new Promise(resolve => { releaseCreation = resolve; }),
    async request(type, payload, fallback) {
      const response = await fallback();
      if (type !== "prompt") return response;
      const duplicate = acceptedMessageIds.has(payload.clientMessageId);
      if (!duplicate) {
        acceptedMessageIds.add(payload.clientMessageId);
        modelRequestCount += 1;
      }
      return { ...response, duplicate };
    },
  });
  type(fixture, "hihi");

  // flushDraft follows the same saveDraft -> ensureDraftSession path as the
  // 240 ms autosave timer, without making the regression timing-dependent.
  const autosave = fixture.composer.flushDraft();
  await waitFor(() => typeof releaseCreation === "function");
  const sending = fixture.composer.send();
  await new Promise(resolve => setImmediate(resolve));
  const promptCountBeforeCreateResolved = fixture.promptRequests.length;

  releaseCreation();
  await Promise.all([autosave, sending]);
  const inputAfterCreateResolved = fixture.input.value;
  await fixture.composer.send();

  assert.deepEqual({
    promptCountBeforeCreateResolved,
    inputAfterCreateResolved,
    promptCountAfterSecondEnter: fixture.promptRequests.length,
    optimisticBubbleCount: fixture.userMessages.length,
    modelRequestCount,
    clientMessageIds: fixture.promptRequests.map(message => message.clientMessageId),
  }, {
    promptCountBeforeCreateResolved: 0,
    inputAfterCreateResolved: "",
    promptCountAfterSecondEnter: 1,
    optimisticBubbleCount: 1,
    modelRequestCount: 1,
    clientMessageIds: [fixture.promptRequests[0]?.clientMessageId],
  }, "sending must wait for the provisional Session and must not restore or resubmit the consumed draft");
}

async function concurrentTargetLoadsShareOneRequest() {
  let loadCount = 0;
  let releaseLoad;
  const fixture = createFixture({
    sessionId: "source",
    request(type, payload, fallback) {
      if (type !== "get_composer_draft" || payload.sessionId !== "target") return fallback();
      loadCount += 1;
      return new Promise(resolve => { releaseLoad = () => resolve({ draft: null }); });
    },
  });
  const first = fixture.composer.prepareSession("target");
  const second = fixture.composer.prepareSession("target");
  await waitFor(() => typeof releaseLoad === "function");
  assert.equal(loadCount, 1);
  releaseLoad();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
}

async function typingWhileTargetLoadsPersistsTheLatestRevision() {
  let releaseLoad;
  const fixture = createFixture({
    sessionId: "source",
    request(type, payload, fallback) {
      if (type !== "get_composer_draft" || payload.sessionId !== "target") return fallback();
      return new Promise(resolve => { releaseLoad = () => resolve({ draft: null }); });
    },
  });
  type(fixture, "before navigation");
  const pending = fixture.composer.prepareSession("target");
  await waitFor(() => typeof releaseLoad === "function");
  type(fixture, "typed while loading");
  releaseLoad();
  const targetDraft = await pending;
  fixture.setSessionId("target");
  fixture.composer.handleSessionChanged("source", "target", targetDraft);
  await waitFor(() => fixture.records.get("source")?.text === "typed while loading");

  assert.equal(fixture.records.get("source")?.text, "typed while loading");
}

async function localDraftSurvivesPersistenceFailure() {
  const fixture = createFixture({
    sessionId: "source",
    request(type, _payload, fallback) {
      if (type === "sync_composer_draft") throw new Error("storage unavailable");
      return fallback();
    },
  });
  type(fixture, "kept in this panel");
  await fixture.composer.flushDraft();
  await switchSession(fixture, "target");
  await switchSession(fixture, "source");
  assert.equal(fixture.input.value, "kept in this panel");
}

async function sendCarriesTheExactDraftIdentity() {
  const fixture = createFixture({ sessionId: "send-source" });
  type(fixture, "message payload");
  await fixture.composer.send();
  const prompt = fixture.promptRequests[0];

  assert.equal(prompt?.sessionId, "send-source");
  assert.equal(prompt?.composerDraft?.text, "message payload");
  assert.equal(prompt?.composerDraft?.messageId, prompt?.clientMessageId);
  assert.equal(fixture.input.value, "");
  assert.deepEqual(fixture.deliveryUpdates.map(update => update.status), ["accepted"]);
}

async function failedPromptStaysRetryableWithTheSameIdentity() {
  let failPrompt = true;
  const fixture = createFixture({
    sessionId: "retry-source",
    request(type, payload, fallback) {
      if (type !== "prompt") return fallback();
      fixture.promptRequests.push(clone(payload));
      if (failPrompt) throw new Error("conversation persistence failed");
      return { accepted: true, clientMessageId: payload.clientMessageId };
    },
  });
  type(fixture, "send this exactly once");
  const accepted = await fixture.composer.send();
  assert.equal(accepted, false);
  assert.equal(fixture.userMessages.length, 1);
  assert.deepEqual(fixture.deliveryUpdates.map(update => update.status), ["failed"]);

  const original = {
    ...fixture.userMessages[0],
    deliveryStatus: "failed",
  };
  failPrompt = false;
  const retried = await fixture.composer.retryUserMessage(original);

  assert.equal(retried, true);
  assert.equal(fixture.promptRequests.length, 2);
  assert.equal(fixture.promptRequests[1].clientMessageId, fixture.promptRequests[0].clientMessageId);
  assert.equal(fixture.promptRequests[1].text, fixture.promptRequests[0].text);
  assert.deepEqual(fixture.promptRequests[1].composerDraft, {
    sessionId: "retry-source",
    messageId: fixture.promptRequests[0].clientMessageId,
  });
  assert.deepEqual(
    fixture.deliveryUpdates.slice(1).map(update => ({ status: update.status, moveToTail: update.options.moveToTail === true })),
    [
      { status: "pending", moveToTail: true },
      { status: "accepted", moveToTail: false },
    ],
  );
  assert.deepEqual(
    fixture.deliveryTraces.map(trace => ({ phase: trace.fields.phase, retry: trace.fields.retry })),
    [
      { phase: "ui.submitted", retry: false },
      { phase: "ui.failed", retry: false },
      { phase: "ui.submitted", retry: true },
      { phase: "ui.accepted", retry: true },
    ],
  );
  assert.equal(
    JSON.stringify(fixture.deliveryTraces).includes("send this exactly once"),
    false,
    "delivery traces must record message identity and size, not message content",
  );
}

async function pageHidePublishesTheLastTextSnapshot() {
  const sent = [];
  const fixture = createFixture({
    sessionId: "closing",
    sendMessage: message => sent.push(message),
  });
  type(fixture, "last keystroke");
  fixture.lifecycleWindow.dispatchEvent(new Event("pagehide"));
  const snapshot = sent.find(message => message.type === "sync_composer_draft");

  assert.equal(snapshot?.sessionId, "closing");
  assert.equal(snapshot?.draft?.text, "last keystroke");
  assert.ok(snapshot?.draft?.messageId);
}

async function inputResizeTracksAllocatedWidth() {
  const previousResizeObserver = globalThis.ResizeObserver;
  let resizeCallback = null;
  let observation = null;
  let heightWrites = 0;
  const style = new Proxy({}, {
    set(target, property, value) {
      if (property === "height") heightWrites += 1;
      return Reflect.set(target, property, value);
    },
  });

  try {
    globalThis.ResizeObserver = class {
      constructor(callback) {
        resizeCallback = callback;
      }

      observe(target, options) {
        observation = { target, options };
      }
    };
    const fixture = createFixture({
      sessionId: "resize-observer",
      inputValues: {
        clientWidth: 242,
        offsetWidth: 242,
        scrollHeight: 39,
        style,
        getBoundingClientRect: () => ({ width: 242 }),
      },
    });

    assert.equal(observation?.target, fixture.input);
    assert.deepEqual(observation?.options, { box: "border-box" });
    resizeCallback?.([{
      contentRect: { width: 227 },
      borderBoxSize: [{ inlineSize: 242 }],
    }]);
    assert.equal(heightWrites, 0, "an internal scrollbar must not resize the composer");

    resizeCallback?.([{
      contentRect: { width: 205 },
      borderBoxSize: [{ inlineSize: 220 }],
    }]);
    assert.equal(heightWrites, 2, "a real allocated-width change should remeasure the composer once");
    assert.equal(style.height, "39px");
    assert.equal(style.overflowY, "hidden");

    fixture.input.scrollHeight = 180;
    type(fixture, "long draft");
    assert.equal(style.height, "120px");
    assert.equal(style.overflowY, "auto", "only capped content should own a vertical scrollbar");
  } finally {
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousResizeObserver;
  }
}

async function switchSession(fixture, next) {
  const previous = fixture.getSessionId();
  const draft = await fixture.composer.prepareSession(next);
  fixture.setSessionId(next);
  fixture.composer.handleSessionChanged(previous, next, draft);
}

function type(fixture, value) {
  fixture.input.value = value;
  fixture.input.dispatchEvent(new Event("input"));
}

function createFixture({
  sessionId,
  records = new Map(),
  createSession = async () => {},
  provisionSessionBeforeCreateResolve = false,
  request: interceptRequest = null,
  sendMessage = () => {},
  inputValues = {},
} = {}) {
  let currentSessionId = sessionId;
  let createCalls = 0;
  let composer;
  const input = createElement({ value: "", scrollHeight: 36, ...inputValues });
  const sendButton = createElement({ disabled: true, offsetWidth: 24 });
  const attachments = createElement();
  const lifecycleDocument = createElement({ visibilityState: "visible" });
  const lifecycleWindow = createElement();
  const promptRequests = [];
  const deliveryUpdates = [];
  const deliveryTraces = [];
  const userMessages = [];

  const fallbackRequest = async (type, payload) => {
    if (type === "get_composer_draft") {
      return { sessionId: payload.sessionId, draft: clone(records.get(payload.sessionId)) };
    }
    if (type === "sync_composer_draft") {
      const current = records.get(payload.sessionId);
      if (current && current.updatedAt > payload.draft.updatedAt) {
        return { sessionId: payload.sessionId, draft: clone(current) };
      }
      if (hasContent(payload.draft)) records.set(payload.sessionId, clone(payload.draft));
      else records.delete(payload.sessionId);
      return { sessionId: payload.sessionId, draft: clone(records.get(payload.sessionId)) };
    }
    if (type === "prompt") {
      promptRequests.push(clone(payload));
      return { accepted: true, sessionId: payload.sessionId, clientMessageId: payload.clientMessageId };
    }
    throw new Error(`unexpected request: ${type}`);
  };

  composer = createComposerFeature({
    input,
    sendButton,
    attachments,
    slashMenu: {
      close() {},
      executeCommand: async () => ({ ok: true }),
      handleKeydown: () => false,
      isOpen: () => false,
      parseCommand: () => null,
      update() {},
    },
    elementPicker: { cancel() {}, isActive: () => false },
    queue: { set() {} },
    getSessionId: () => currentSessionId,
    async ensureSession(title, draft) {
      createCalls += 1;
      if (provisionSessionBeforeCreateResolve) {
        const previous = currentSessionId;
        currentSessionId = "created-session";
        const prepared = composer.adoptSession(currentSessionId, draft);
        await createSession(title);
        composer.handleSessionChanged(previous, currentSessionId, prepared);
        return;
      }
      await createSession(title);
      const previous = currentSessionId;
      currentSessionId = "created-session";
      const prepared = await composer.adoptSession(currentSessionId, draft);
      composer.handleSessionChanged(previous, currentSessionId, prepared);
    },
    request(type, payload) {
      const fallback = () => fallbackRequest(type, payload);
      return interceptRequest ? interceptRequest(type, payload, fallback) : fallback();
    },
    appendUserMessage(text, images, clientMessageId, documents) {
      userMessages.push({
        type: "user",
        text,
        images: clone(images),
        documents: clone(documents),
        clientMessageId,
      });
    },
    setUserMessageDeliveryStatus(targetSessionId, clientMessageId, status, options = {}) {
      deliveryUpdates.push({ sessionId: targetSessionId, clientMessageId, status, options });
      return true;
    },
    emitTrace(stage, event, fields) {
      deliveryTraces.push({ stage, event: clone(event), fields: clone(fields) });
    },
    sendMessage,
    lifecycleDocument,
    lifecycleWindow,
  });

  return {
    composer,
    input,
    lifecycleWindow,
    records,
    promptRequests,
    deliveryUpdates,
    deliveryTraces,
    userMessages,
    createSessionCalls: () => createCalls,
    getSessionId: () => currentSessionId,
    setSessionId: value => { currentSessionId = value; },
  };
}

function createElement(values = {}) {
  const target = new EventTarget();
  const classes = new Set();
  return Object.assign(target, {
    value: "",
    readOnly: false,
    disabled: false,
    innerHTML: "",
    style: {},
    scrollHeight: 36,
    offsetWidth: 0,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    },
    focus() {},
    querySelectorAll: () => [],
  }, values);
}

function hasContent(draft = {}) {
  return Boolean(draft.text || draft.images?.length || draft.documents?.length);
}

function clone(value) {
  return value == null ? null : structuredClone(value);
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for draft lifecycle");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

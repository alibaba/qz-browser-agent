import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRuntimeState } from "../../src/background/session/runtime-state.ts";
import { createChromeStoreReviewStore } from "../../src/background/services/chrome-store-review.ts";
import { createStoreReviewTranscriptCard } from "../../src/sidepanel/features/chat/transcript/store-review-card.ts";
import coreMessages from "../../src/sidepanel/i18n/messages.ts";
import {
  CHROME_STORE_REVIEW_STORAGE_KEY,
  CHROME_STORE_REVIEW_TASK_THRESHOLD,
  CHROME_WEB_STORE_REVIEWS_URL,
  CHROME_WEB_STORE_UPDATE_URL,
  classifyBrowserTarget,
  completedTaskRunKey,
  emptyChromeStoreReviewRecord,
  finishChromeStoreReview,
  isChromeWebStoreInstall,
  normalizeChromeStoreReviewRecord,
  readChromeWebStoreInstallProbe,
  recordCompletedTask,
  shouldShowChromeStoreReview,
} from "../../src/shared/chrome-store-review.ts";
import { normalizeParentSessionId, ROOT_SESSION_ID } from "../../src/shared/session/session-store.ts";

globalThis.chrome = {
  i18n: { getUILanguage: () => "en", getMessage: () => "" },
};

const STORE_INSTALL = Object.freeze({
  browser: "chrome",
  installType: "normal",
  updateUrl: CHROME_WEB_STORE_UPDATE_URL,
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return { [key]: data.has(key) ? structuredClone(data.get(key)) : undefined };
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
  };
}

function createDocument() {
  function matches(element, selector) {
    const attr = selector.match(/^\[([^\]=]+)(?:="([^"]*)"|='([^']*)')?\]$/);
    if (attr) {
      if (!element.attributes.has(attr[1])) return false;
      const expected = attr[2] ?? attr[3];
      return expected === undefined || element.attributes.get(attr[1]) === expected;
    }
    return selector === "button" && element.tagName === "BUTTON";
  }
  function queryAll(root, selector) {
    const found = [];
    for (const child of root.children) {
      if (matches(child, selector)) found.push(child);
      found.push(...queryAll(child, selector));
    }
    return found;
  }
  function createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      className: "",
      textContent: "",
      type: "",
      disabled: false,
      parentElement: null,
      children: [],
      attributes: new Map(),
      listeners: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
      appendChild(child) {
        child.parentElement?.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child.parentElement === this) child.parentElement = null;
        return child;
      },
      remove() { this.parentElement?.removeChild(this); },
      append(...items) { for (const item of items) this.appendChild(item); },
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      click() {
        if (this.disabled) return;
        this.listeners.get("click")?.({ preventDefault() {} });
      },
      querySelector(selector) { return queryAll(this, selector)[0] || null; },
      querySelectorAll(selector) { return queryAll(this, selector); },
      get lastElementChild() { return this.children.at(-1) || null; },
    };
  }
  return {
    createElement,
    createElementNS(_namespace, tag) { return createElement(tag); },
  };
}

function joinedCopy(copy) {
  return copy.querySelector("[data-store-review-before]").textContent
    + copy.querySelector("[data-store-review-mention]").textContent
    + copy.querySelector("[data-store-review-after]").textContent;
}

function assertStoreMark(messages, mention, prompt) {
  const copy = messages.querySelector("[data-store-review-copy]");
  const store = copy.querySelector("[data-store-review-store]");
  const mark = store.querySelector("[data-store-review-chrome]");
  assert.equal(joinedCopy(copy), prompt);
  assert.equal(store.children[0], mark);
  assert.equal(store.children[1].getAttribute("data-store-review-mention"), "");
  assert.equal(store.children[1].textContent, mention);
  assert.equal(mark.getAttribute("aria-hidden"), "true");
  assert.equal(mark.children.some(node => node.getAttribute("fill") === "#EA4335"), true);
  assert.equal(mark.children.some(node => node.getAttribute("fill") === "#1A73E8"), true);
  assert.equal(copy.querySelector("[data-store-review-action]"), null);
}

function visibleRecord(sessionId = "chat") {
  return {
    version: 1,
    completedRunIds: ["run-1", "run-2", "run-3", "run-4", "run-5"],
    status: "visible",
    sessionId,
    runId: "run-5",
    resolution: "",
  };
}

async function flush() {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

async function mountCard({
  record = visibleRecord(),
  probe = STORE_INSTALL,
  sessionId = "chat",
  hasTranscript = true,
  openReviews,
} = {}) {
  const storage = memoryStorage({ [CHROME_STORE_REVIEW_STORAGE_KEY]: record });
  const doc = createDocument();
  const messages = doc.createElement("div");
  const opened = [];
  const listeners = [];
  let openError = null;
  const card = createStoreReviewTranscriptCard({
    messagesEl: messages,
    document: doc,
    storage,
    listen(listener) {
      listeners.push(listener);
      return () => {};
    },
    probeInstall: async () => probe,
    openReviews: openReviews || (async url => {
      if (openError) throw openError;
      opened.push(url);
    }),
    getSessionId: () => sessionId,
    hasTranscript: () => hasTranscript,
  });
  await card.ready;
  await flush();
  return {
    card, messages, storage, opened, listeners, doc,
    failOpen(error) { openError = error; },
  };
}

test("the fifth successful root-session finish is the first time the prompt becomes visible", () => {
  assert.equal(CHROME_STORE_REVIEW_TASK_THRESHOLD, 5);
  assert.equal(CHROME_WEB_STORE_REVIEWS_URL, "https://chromewebstore.google.com/detail/qz/dknbdgkgoinlgjpfebapkklbmjjgdblm/reviews");
  let state = emptyChromeStoreReviewRecord();
  state = recordCompletedTask(state, { sessionId: "chat", runId: "run-1", endedAt: "t1" }).record;
  assert.equal(state.status, "hidden");
  assert.deepEqual(state.completedRunIds, ["run-1"]);
  assert.equal(shouldShowChromeStoreReview({ record: state, sessionId: "chat", hasTranscript: true, install: STORE_INSTALL }), false);

  const duplicate = recordCompletedTask(state, { sessionId: "chat", runId: "run-1", endedAt: "t1" });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.record.status, "hidden");

  for (let index = 2; index <= 4; index += 1) {
    state = recordCompletedTask(state, { sessionId: "chat", runId: `run-${index}`, endedAt: `t${index}` }).record;
    assert.equal(state.status, "hidden");
    assert.equal(shouldShowChromeStoreReview({ record: state, sessionId: "chat", hasTranscript: true, install: STORE_INSTALL }), false);
  }
  assert.deepEqual(state.completedRunIds, ["run-1", "run-2", "run-3", "run-4"]);

  state = recordCompletedTask(state, { sessionId: "chat", runId: "run-5", endedAt: "t5" }).record;
  assert.equal(state.status, "visible");
  assert.equal(state.sessionId, "chat");
  assert.equal(state.runId, "run-5");
  assert.deepEqual(state.completedRunIds, ["run-1", "run-2", "run-3", "run-4", "run-5"]);
  assert.equal(shouldShowChromeStoreReview({ record: state, sessionId: "chat", hasTranscript: true, install: STORE_INSTALL }), true);
  assert.equal(shouldShowChromeStoreReview({ record: state, sessionId: "other", hasTranscript: true, install: STORE_INSTALL }), false);
  assert.equal(shouldShowChromeStoreReview({ record: state, sessionId: "chat", hasTranscript: false, install: STORE_INSTALL }), false);

  const later = recordCompletedTask(state, { sessionId: "later", runId: "run-6", endedAt: "t6" });
  assert.equal(later.changed, false);
  assert.equal(later.record.sessionId, "chat");
  assert.equal(later.record.runId, "run-5");

  const earlyVisible = normalizeChromeStoreReviewRecord({
    version: 1,
    completedRunIds: ["run-1", "run-2"],
    status: "visible",
    sessionId: "chat",
    runId: "run-2",
    resolution: "",
  });
  assert.equal(earlyVisible.status, "hidden");
  assert.deepEqual(earlyVisible.completedRunIds, ["run-1", "run-2"]);
});

test("a finish without a run id keeps the session and end time, and an empty finish does not count", () => {
  const keyed = recordCompletedTask(emptyChromeStoreReviewRecord(), {
    sessionId: "chat",
    endedAt: "2026-10-24 12:00:00",
  });
  assert.deepEqual(keyed.record.completedRunIds, ["chat:2026-10-24 12:00:00"]);
  assert.equal(completedTaskRunKey("chat", { runId: "run-1", endedAt: "later" }), "run-1");
  const skipped = recordCompletedTask(emptyChromeStoreReviewRecord(), { sessionId: "chat" });
  assert.equal(skipped.changed, false);
  assert.deepEqual(skipped.record.completedRunIds, []);
});

test("dismiss and review both finish the prompt permanently", () => {
  const visible = visibleRecord();
  const dismissed = finishChromeStoreReview(visible, "dismissed").record;
  assert.equal(dismissed.status, "done");
  assert.equal(dismissed.resolution, "dismissed");
  assert.equal(recordCompletedTask(dismissed, { sessionId: "chat", runId: "run-9" }).changed, false);
  assert.equal(finishChromeStoreReview(dismissed, "reviewed").changed, false);
  const reviewed = finishChromeStoreReview(visible, "reviewed").record;
  assert.equal(reviewed.resolution, "reviewed");
  assert.equal(shouldShowChromeStoreReview({ record: reviewed, sessionId: "chat", hasTranscript: true, install: STORE_INSTALL }), false);
});

test("store install check fails closed for Firefox, unpacked, sideload, and other update URLs", async () => {
  const closed = [
    { browser: "firefox", installType: "normal", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "development", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "sideload", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "admin", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "other", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "normal", updateUrl: "" },
    { browser: "chrome", installType: "normal", updateUrl: "https://example.test/updates" },
    { browser: "other", installType: "normal", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
  ];
  for (const probe of closed) {
    assert.equal(isChromeWebStoreInstall(probe), false, JSON.stringify(probe));
    assert.equal(shouldShowChromeStoreReview({
      record: visibleRecord(), sessionId: "chat", hasTranscript: true, install: probe,
    }), false);
  }
  assert.equal(isChromeWebStoreInstall(STORE_INSTALL), true);
  assert.equal(isChromeWebStoreInstall({ ...STORE_INSTALL, updateUrl: `${CHROME_WEB_STORE_UPDATE_URL}/` }), true);
  assert.equal(classifyBrowserTarget({ protocol: "moz-extension:" }), "firefox");
  assert.equal(classifyBrowserTarget({ protocol: "chrome-extension:", hasGetBrowserInfo: true }), "firefox");
  assert.equal(classifyBrowserTarget({ protocol: "chrome-extension:", userAgent: "Mozilla/5.0 Firefox/120.0" }), "firefox");
  assert.equal(classifyBrowserTarget({ protocol: "chrome-extension:", userAgent: "Mozilla/5.0 Chrome/130.0" }), "chrome");
  assert.equal(classifyBrowserTarget({ protocol: "http:" }), "other");

  let reads = 0;
  const firefox = await readChromeWebStoreInstallProbe({
    protocol: "moz-extension:",
    getSelf: async () => {
      reads += 1;
      return STORE_INSTALL;
    },
  });
  assert.equal(firefox.browser, "firefox");
  assert.equal(reads, 0);
  const unpacked = await readChromeWebStoreInstallProbe({
    protocol: "chrome-extension:",
    userAgent: "Chrome/130.0",
    getSelf: async () => ({ installType: "development", updateUrl: "" }),
  });
  assert.equal(isChromeWebStoreInstall(unpacked), false);
  const failed = await readChromeWebStoreInstallProbe({
    protocol: "chrome-extension:",
    getSelf: async () => { throw new Error("management unavailable"); },
  });
  assert.equal(isChromeWebStoreInstall(failed), false);
  const missingApi = await readChromeWebStoreInstallProbe({ protocol: "chrome-extension:" });
  assert.equal(isChromeWebStoreInstall(missingApi), false);
  assert.deepEqual(normalizeChromeStoreReviewRecord({ version: 99, status: "visible" }), emptyChromeStoreReviewRecord());
});

test("root-session completion counts once, and aborts, errors, child sessions, and queued follow-ups do not", async () => {
  const sessions = {
    root: { id: "root", parentSessionId: ROOT_SESSION_ID },
    child: { id: "child", parentSessionId: "root" },
  };
  const storage = memoryStorage();
  const review = createChromeStoreReviewStore({
    storage,
    isRootSession: async id => {
      const session = sessions[id];
      if (!session) return false;
      return normalizeParentSessionId(session.parentSessionId) === ROOT_SESSION_ID;
    },
  });
  const runtimes = new Map();
  const runtime = createSessionRuntimeState({
    supervisor: {
      replaceRuntimes() {},
      runtimeEntries: () => [...runtimes.entries()],
      getRuntime: id => runtimes.get(id) || null,
      setRuntime(id, value) {
        runtimes.set(id, value);
        return value;
      },
      deleteRuntime(id) { runtimes.delete(id); },
    },
    repository: {
      async migrateLegacyRuntime() {},
      async readRuntimeBatch() { return {}; },
      async writeRuntime() {},
      async deleteRuntime() {},
    },
    getSessions: async () => sessions,
    getAgentEntry: () => ({ ready: null }),
    normalizeSessionId: value => String(value || "").trim(),
    onTaskCompleted: (id, next) => review.recordCompletion(id, next),
    now: () => "2026-10-24 12:00:00",
  });

  runtime.recordEvent("root", { type: "agent_start", runId: "run-1" });
  runtime.recordEvent("root", { type: "agent_end", runId: "run-1" });
  runtime.recordEvent("root", { type: "agent_end", runId: "run-1" });
  await review.idle();
  assert.deepEqual((await review.read()).completedRunIds, ["run-1"]);

  runtime.recordEvent("root", { type: "agent_start", runId: "run-abort" });
  runtime.recordEvent("root", { type: "aborted", runId: "run-abort", reason: "stopped" });
  runtime.recordEvent("root", { type: "agent_start", runId: "run-error" });
  runtime.recordEvent("root", { type: "error", runId: "run-error", message: "failed" });
  runtime.recordEvent("child", { type: "agent_start", runId: "run-child" });
  runtime.recordEvent("child", { type: "agent_end", runId: "run-child" });
  runtime.recordEvent("missing", { type: "agent_end", runId: "run-missing" });
  await review.idle();
  assert.deepEqual((await review.read()).completedRunIds, ["run-1"]);
  assert.equal((await review.read()).status, "hidden");

  runtime.set("root", {
    status: "running",
    running: true,
    runId: "run-follow",
    pendingFollowUpMessages: [{ role: "user", content: "continue" }],
  });
  runtime.recordEvent("root", { type: "agent_end", runId: "run-follow" });
  await review.idle();
  assert.equal(runtimes.get("root").status, "pending");
  assert.deepEqual((await review.read()).completedRunIds, ["run-1"]);
  runtime.recordEvent("root", {
    type: "queue_update",
    isRunning: false,
    pendingFollowUpMessages: [],
    pendingSteeringMessages: [],
  });
  await review.idle();
  const counted = await review.read();
  assert.equal(counted.status, "hidden");
  assert.equal(counted.completedRunIds.length, 2);

  for (const runId of ["run-3", "run-4"]) {
    runtime.recordEvent("root", { type: "agent_start", runId });
    runtime.recordEvent("root", { type: "agent_end", runId });
  }
  await review.idle();
  const fourth = await review.read();
  assert.equal(fourth.status, "hidden");
  assert.equal(fourth.completedRunIds.length, 4);

  runtime.recordEvent("root", { type: "agent_start", runId: "run-5" });
  runtime.recordEvent("root", { type: "agent_end", runId: "run-5" });
  await review.idle();
  const visible = await review.read();
  assert.equal(visible.status, "visible");
  assert.equal(visible.sessionId, "root");
  assert.equal(visible.completedRunIds.length, CHROME_STORE_REVIEW_TASK_THRESHOLD);

  await review.finish("dismissed");
  const reopened = createChromeStoreReviewStore({
    storage,
    isRootSession: async () => true,
  });
  assert.equal((await reopened.read()).status, "done");
  assert.equal((await reopened.read()).resolution, "dismissed");
  runtime.recordEvent("root", { type: "agent_start", runId: "run-later" });
  runtime.recordEvent("root", { type: "agent_end", runId: "run-later" });
  await reopened.idle();
  assert.equal((await reopened.read()).status, "done");
});

test("concurrent finishes serialize and a failed write can be retried", async () => {
  const storage = memoryStorage();
  const review = createChromeStoreReviewStore({ storage, isRootSession: async () => true });
  await Promise.all([
    review.recordCompletion("chat", { runId: "run-a", endedAt: "1" }),
    review.recordCompletion("chat", { runId: "run-a", endedAt: "1" }),
    review.recordCompletion("chat", { runId: "run-b", endedAt: "2" }),
    review.recordCompletion("chat", { runId: "run-c", endedAt: "3" }),
    review.recordCompletion("chat", { runId: "run-d", endedAt: "4" }),
  ]);
  const early = await review.read();
  assert.deepEqual(early.completedRunIds, ["run-a", "run-b", "run-c", "run-d"]);
  assert.equal(early.status, "hidden");
  await review.recordCompletion("chat", { runId: "run-e", endedAt: "5" });
  const saved = await review.read();
  assert.deepEqual(saved.completedRunIds, ["run-a", "run-b", "run-c", "run-d", "run-e"]);
  assert.equal(saved.status, "visible");
  assert.equal(saved.sessionId, "chat");
  assert.equal(saved.runId, "run-e");

  let rejectWrites = true;
  const flaky = memoryStorage();
  const retry = createChromeStoreReviewStore({
    storage: {
      get: key => flaky.get(key),
      async set(values) {
        if (rejectWrites) throw new Error("storage full");
        await flaky.set(values);
      },
    },
    isRootSession: async () => true,
  });
  await assert.rejects(retry.recordCompletion("chat", { runId: "run-1", endedAt: "1" }), /storage full/);
  rejectWrites = false;
  await retry.recordCompletion("chat", { runId: "run-1", endedAt: "1" });
  assert.deepEqual((await retry.read()).completedRunIds, ["run-1"]);
});

test("the transcript card appears after the fifth completed root session, then dismiss or review removes it for good", async () => {
  assert.equal(coreMessages.messages.storeReviewAction.en, "Leave a review");
  assert.equal(coreMessages.messages.storeReviewDismiss.en, "Dismiss");
  assert.equal(coreMessages.messages.storeReviewDismiss["zh-CN"], "不再显示");
  assert.match(coreMessages.messages.storeReviewPrompt.en, /Chrome Web Store/);
  assert.match(coreMessages.messages.storeReviewPrompt["zh-CN"], /轻舟/);
  assert.match(coreMessages.messages.storeReviewPrompt["zh-CN"], /Chrome 应用商店/);

  const hidden = await mountCard({
    record: { ...emptyChromeStoreReviewRecord(), completedRunIds: ["run-1", "run-2", "run-3", "run-4"] },
  });
  assert.equal(hidden.messages.querySelector("[data-store-review-card]"), null);

  const view = await mountCard();
  const card = view.messages.querySelector("[data-store-review-card]");
  assert.ok(card);
  assert.equal(card.getAttribute("data-chat-lane"), "summary");
  assert.equal(card.getAttribute("role"), "note");
  assertStoreMark(view.messages, "Chrome Web Store", coreMessages.messages.storeReviewPrompt.en);
  const previousLanguage = globalThis.chrome.i18n.getUILanguage;
  globalThis.chrome.i18n.getUILanguage = () => "zh-CN";
  try {
    const chinese = await mountCard();
    assertStoreMark(chinese.messages, "Chrome 应用商店", coreMessages.messages.storeReviewPrompt["zh-CN"]);
  } finally {
    globalThis.chrome.i18n.getUILanguage = previousLanguage;
  }
  const review = view.messages.querySelector("[data-store-review-action='review']");
  const dismiss = view.messages.querySelector("[data-store-review-action='dismiss']");
  assert.equal(review.textContent, "Leave a review");
  assert.equal(review.className.includes("qz-btn--primary"), true);
  assert.equal(dismiss.textContent, "Dismiss");
  assert.equal(dismiss.className.includes("qz-btn--ghost"), true);
  assert.equal(view.messages.lastElementChild, card);

  const result = view.doc.createElement("div");
  result.setAttribute("data-transcript-key", "result");
  view.messages.appendChild(result);
  view.card.sync();
  await flush();
  assert.equal(view.messages.lastElementChild.getAttribute("data-store-review-card"), "");
  assert.equal(view.messages.children[0].getAttribute("data-transcript-key"), "result");

  dismiss.click();
  await view.card.idle();
  assert.equal(view.messages.querySelector("[data-store-review-card]"), null);
  const dismissed = (await view.storage.get(CHROME_STORE_REVIEW_STORAGE_KEY))[CHROME_STORE_REVIEW_STORAGE_KEY];
  assert.equal(dismissed.status, "done");
  assert.equal(dismissed.resolution, "dismissed");
  const again = await mountCard({ record: dismissed });
  assert.equal(again.messages.querySelector("[data-store-review-card]"), null);

  const reviewing = await mountCard();
  reviewing.messages.querySelector("[data-store-review-action='review']").click();
  await reviewing.card.idle();
  assert.deepEqual(reviewing.opened, [CHROME_WEB_STORE_REVIEWS_URL]);
  const reviewed = (await reviewing.storage.get(CHROME_STORE_REVIEW_STORAGE_KEY))[CHROME_STORE_REVIEW_STORAGE_KEY];
  assert.equal(reviewed.status, "done");
  assert.equal(reviewed.resolution, "reviewed");
  assert.equal(reviewing.messages.querySelector("[data-store-review-card]"), null);

  const blocked = await mountCard();
  blocked.failOpen(new Error("tabs unavailable"));
  blocked.messages.querySelector("[data-store-review-action='review']").click();
  await blocked.card.idle();
  assert.deepEqual(blocked.opened, []);
  assert.equal((await blocked.storage.get(CHROME_STORE_REVIEW_STORAGE_KEY))[CHROME_STORE_REVIEW_STORAGE_KEY].status, "visible");
  assert.ok(blocked.messages.querySelector("[data-store-review-card]"));
});

test("the card stays hidden for non-store installs and other conversations", async () => {
  for (const probe of [
    { browser: "firefox", installType: "normal", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "development", updateUrl: "" },
    { browser: "chrome", installType: "sideload", updateUrl: CHROME_WEB_STORE_UPDATE_URL },
    { browser: "chrome", installType: "normal", updateUrl: "https://addons.mozilla.org/update" },
  ]) {
    const view = await mountCard({ probe });
    assert.equal(view.messages.querySelector("[data-store-review-card]"), null, JSON.stringify(probe));
  }
  const otherSession = await mountCard({ sessionId: "elsewhere" });
  assert.equal(otherSession.messages.querySelector("[data-store-review-card]"), null);
  const emptyChat = await mountCard({ hasTranscript: false });
  assert.equal(emptyChat.messages.querySelector("[data-store-review-card]"), null);

  const waiting = await mountCard({ record: emptyChromeStoreReviewRecord() });
  waiting.listeners[0]({
    [CHROME_STORE_REVIEW_STORAGE_KEY]: { newValue: visibleRecord() },
  }, "sync");
  await flush();
  assert.equal(waiting.messages.querySelector("[data-store-review-card]"), null);
  waiting.listeners[0]({
    [CHROME_STORE_REVIEW_STORAGE_KEY]: { newValue: visibleRecord() },
  }, "local");
  await flush();
  assert.ok(waiting.messages.querySelector("[data-store-review-card]"));
  waiting.listeners[0]({
    [CHROME_STORE_REVIEW_STORAGE_KEY]: { newValue: { ...visibleRecord(), status: "done", resolution: "dismissed" } },
  }, "local");
  await flush();
  assert.equal(waiting.messages.querySelector("[data-store-review-card]"), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { navigateTab as navigate } from "../../src/capabilities/tabs/navigation.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

const url = "https://example.test/next";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let checkAllowed = async () => {};
const navigateTab = (id, target, signal) => navigate(id, target, checkAllowed, signal);
function fixture(initialUrl = "https://example.test/old") {
  checkAllowed = async () => {};
  const pages = new Map([1, 2].map(id => [id, { id, url: initialUrl, status: "complete", documentId: `${id}:old` }]));
  const calls = [], probes = [];
  const listeners = new Set();
  const emit = (id, change) => { for (const listener of listeners) listener(id, change); };
  let updateHook = () => {}, probeHook = () => {};
  globalThis.chrome = {
    tabs: {
      onUpdated: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
      async get(id) { if (!pages.has(id)) throw new Error("No tab"); return { ...pages.get(id) }; },
      async update(id, options) {
        calls.push({ id, ...options });
        Object.assign(pages.get(id), { pendingUrl: options.url, status: "loading" });
        await updateHook(id, options);
        return { ...pages.get(id) };
      },
    },
    scripting: { async executeScript(options) {
      probes.push(options);
      assert.equal(options.injectImmediately, true);
      assert.deepEqual(options.target.frameIds, [0]);
      assert.equal(options.func(), null, "the probe must not read or modify page content");
      await probeHook();
      const page = pages.get(options.target.tabId);
      if (page.error) throw new Error(page.error);
      return [{ frameId: 0, documentId: page.documentId }];
    } },
  };
  return { pages, calls, probes, listeners, emit,
    onUpdate(fn) { updateHook = fn; }, onProbe(fn) { probeHook = fn; },
    async started(count = 1) { for (let i = 0; calls.length < count && i < 100; i++) await pause(2); assert.equal(calls.length, count); },
    commit(id = 1, patch = {}) {
      Object.assign(pages.get(id), { url, documentId: `${id}:new`, status: "complete", ...patch });
      delete pages.get(id).pendingUrl;
      emit(id, { status: pages.get(id).status });
    },
  };
}

for (const initial of ["about:blank", "https://example.test/old", url]) {
  test(`navigation from ${initial} waits for a new document, even if the URL is unchanged`, async () => {
    const f = fixture(initial);
    const controller = new AbortController();
    let finished = false;
    const pending = navigateTab(1, url, controller.signal).then(() => { finished = true; });
    try {
      await f.started();
      await pause(65);
      assert.equal(finished, false);
      if (initial !== "about:blank") {
        // A URL/load-state update alone cannot prove that the old document has gone.
        f.commit(1, { documentId: "1:old" });
        await pause(65);
        assert.equal(finished, false);
      }
      f.commit();
      await pending;
    } finally { controller.abort(); await pending.catch(() => {}); }
  });
}

test("a redirect's new document is accepted without waiting for slow subresources", async () => {
  const f = fixture();
  f.onUpdate(() => f.commit(1, { url: "https://redirect.test/landed", status: "loading" }));
  await navigateTab(1, url);
  assert.equal(f.pages.get(1).status, "loading");
});

for (const [before, target] of [[url, `${url}#section`], [`${url}#section`, `${url}#section`], [`${url}#section`, url]]) {
  test(`fragment navigation ${before} -> ${target} retains the document`, async () => {
    const f = fixture(before);
    f.onUpdate(() => f.commit(1, { url: target, documentId: "1:old" }));
    await navigateTab(1, target);
    assert.equal(f.pages.get(1).documentId, "1:old");
  });
}

test("cancellation while taking the baseline cannot start navigation", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.onProbe(() => controller.abort());
  await assert.rejects(navigateTab(1, url, controller.signal), { code: "OPERATION_ABORTED" });
  assert.deepEqual(f.calls, []);
});

for (const initial of [url, "https://example.test/old"])
test(`a hung baseline cannot block navigation from ${initial} or accept the old document`, async () => {
  const f = fixture(initial);
  let release;
  f.onProbe(() => f.probes.length === 1 ? new Promise(resolve => { release = resolve; }) : undefined);
  let finished = false;
  const controller = new AbortController();
  const pending = navigateTab(1, url, controller.signal).then(() => { finished = true; });
  try {
    await f.started();
    Object.assign(f.pages.get(1), { url, status: "complete", pendingUrl: undefined });
    f.emit(2, { status: "complete" });
    await pause(65);
    assert.equal(finished, false, "old/foreign completed tabs are not navigation completion");
    f.commit();
    await pending;
    assert.equal(f.listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    const count = f.probes.length;
    release();
    await pause(0);
    assert.equal(f.probes.length, count, "late baseline completion cannot start more work");
    assert.equal(f.calls.length, 1);
  } finally { controller.abort(); release?.(); await pending.catch(() => {}); }
});

for (const phase of ["baseline", "probe", "guard", "fallback"])
test(`cancellation releases a pending ${phase} and removes listeners`, async () => {
  const f = fixture();
  const controller = new AbortController();
  const pendingApi = new Promise(() => {});
  if (phase === "guard") checkAllowed = () => pendingApi;
  else f.onProbe(() => (phase === "baseline" || phase === "fallback" || f.calls.length) ? pendingApi : undefined);
  if (phase === "probe") f.onUpdate(() => f.commit());
  const pending = navigateTab(1, url, controller.signal);
  const rejected = assert.rejects(pending, { code: "OPERATION_ABORTED" });
  if (phase === "probe" || phase === "fallback") await f.started();
  else await pause(0);
  controller.abort();
  await rejected;
  assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const count = f.probes.length;
  await pause(120);
  assert.equal(f.probes.length, count);
  if (phase === "baseline" || phase === "guard") assert.equal(f.calls.length, 0);
});

for (const failure of ["abort-before", "abort-during", "closed", "network", "api", "missing-document-id"]) {
  test(`navigation ${failure} stops polling and permits recovery`, async () => {
    const f = fixture();
    const controller = new AbortController();
    if (failure === "abort-before") controller.abort();
    if (failure === "api") f.onUpdate(() => { throw new Error("update failed"); });
    const pending = navigateTab(1, url, controller.signal);
    const rejected = assert.rejects(pending, error => failure === "api" ? error.message === "update failed"
      : error.code === ({ "abort-before": "OPERATION_ABORTED", "abort-during": "OPERATION_ABORTED",
        closed: "SESSION_TAB_UNAVAILABLE", network: "NAVIGATION_FAILED", "missing-document-id": "NAVIGATION_FAILED" })[failure]);
    if (failure !== "abort-before") await f.started();
    if (failure === "abort-during") controller.abort();
    if (failure === "closed") f.pages.delete(1);
    if (failure === "network") f.commit(1, { error: "Cannot access the error page" });
    if (failure === "missing-document-id") f.commit(1, { documentId: undefined });
    await rejected;
    const count = f.probes.length;
    await pause(65);
    assert.equal(f.probes.length, count, "no probe may run after cancellation or failure");
    if (failure === "abort-before") assert.deepEqual(f.calls, []);
    const next = fixture();
    next.onUpdate(() => next.commit());
    await navigateTab(1, url);
  });
}

test("a transient injection failure during loading is retried", async () => {
  const f = fixture();
  f.onUpdate(() => f.commit(1, { status: "loading", error: "Document changed during injection" }));
  const pending = navigateTab(1, url);
  await f.started();
  await pause(65);
  delete f.pages.get(1).error;
  await pending;
});

test("a Firefox frame missing on a completed same-URL reload is retried", async () => {
  const f = fixture(url);
  f.onUpdate(() => f.commit(1, { status: "complete", error: "Error: Missing host permission for the tab" }));
  f.onProbe(() => { if (f.probes.length >= 4) delete f.pages.get(1).error; });
  await navigateTab(1, url);
  assert.equal(f.pages.get(1).documentId, "1:new");
  assert.ok(f.probes.length >= 4);
});

test("a persistent Firefox frame-missing error on a completed tab still fails", async () => {
  const f = fixture(url);
  f.onUpdate(() => f.commit(1, { status: "complete", error: "Error: Missing host permission for the tab" }));
  await assert.rejects(navigateTab(1, url), error => error.code === "NAVIGATION_FAILED"
    && String(error.details.cause).includes("Missing host permission for the tab"));
  assert.equal(f.probes.length, 22);
});

test("a blocked redirect is rejected before injecting a document probe", async () => {
  const f = fixture();
  checkAllowed = async id => {
    if (f.pages.get(id).url === "https://blocked.test/") throw new ToolExecutionError("SECURITY_GUARDRAIL_BLOCKED", "Blocked");
  };
  f.onUpdate(() => f.commit(1, { url: "https://blocked.test/", status: "loading" }));
  await assert.rejects(navigateTab(1, url), { code: "SECURITY_GUARDRAIL_BLOCKED" });
  assert.equal(f.probes.length, 1, "only the original allowed document may be probed");
});

test("independent tabs keep separate waits when one is cancelled", async () => {
  const f = fixture();
  const controller = new AbortController();
  const first = assert.rejects(navigateTab(1, url, controller.signal), { code: "OPERATION_ABORTED" });
  const second = navigateTab(2, url);
  await f.started(2);
  controller.abort(); await first;
  f.commit(2);
  await second;
});

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { beginPageNavigationObservation } from "../../src/background/tools/page-navigation.js";

const before = { url: "https://example.test/form", title: "Form" };
const after = { url: "https://example.test/done", title: "Done" };

function fixture(t) {
  const previous = globalThis.chrome;
  const tab = { id: 7, ...before, status: "complete" };
  const listeners = new Set();
  let documentId = "old", getHook, probeHook, reads = 0;
  globalThis.chrome = {
    tabs: {
      onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      async get(id) {
        assert.equal(id, 7);
        reads++;
        const value = { ...tab };
        return getHook ? getHook(value) : value;
      },
    },
    scripting: { async executeScript(options) {
      assert.deepEqual(options.target, { tabId: 7, frameIds: [0] });
      assert.equal(options.func(), null, "the probe does not read or modify page content");
      return probeHook ? probeHook() : [{ frameId: 0, documentId }];
    } },
  };
  t.after(() => { globalThis.chrome = previous; });
  return {
    tab, listeners,
    get reads() { return reads; },
    onGet(fn) { getHook = fn; }, onProbe(fn) { probeHook = fn; },
    emit(id, change) { for (const listener of listeners) listener(id, change); },
    document(id) { documentId = id; },
    start(signal, options = {}) {
      return beginPageNavigationObservation(7, signal, { settleMs: 1, timeoutMs: 500, probeMs: 10, ...options });
    },
  };
}

test("an observed form navigation waits through loading and returns the committed page", async t => {
  const f = fixture(t);
  const observer = await f.start();
  Object.assign(f.tab, { status: "loading", pendingUrl: after.url });
  f.emit(7, { status: "loading" });
  const firstRead = Promise.withResolvers();
  f.onGet(value => { firstRead.resolve(); return value; });
  let finished = false;
  const pending = observer.finish(before).then(result => { finished = true; return result; });
  await firstRead.promise;
  assert.equal(finished, false, "the old page cannot be returned as a completed navigation");
  Object.assign(f.tab, after, { status: "complete" });
  delete f.tab.pendingUrl;
  f.document("new");
  f.emit(7, { status: "complete", url: after.url });
  assert.deepEqual(await pending, {
    pageAfter: after, navigationPending: false, documentChanged: true, navigationStarted: true,
  });
  assert.ok(f.reads >= 2);
  assert.equal(f.listeners.size, 0);
});

test("a same-URL navigation is identified by its new document even when it finishes before observation", async t => {
  const f = fixture(t);
  const observer = await f.start();
  f.document("reloaded");
  assert.deepEqual(await observer.finish(before), {
    pageAfter: before, navigationPending: false, documentChanged: true, navigationStarted: false,
  });
  assert.equal(f.listeners.size, 0);
});

test("a prevented navigation ignores updates from other tabs and retains the current document", async t => {
  const f = fixture(t);
  const observer = await f.start();
  f.emit(8, { status: "loading", url: after.url });
  f.emit(8, { status: "complete" });
  assert.deepEqual(await observer.finish(before), {
    pageAfter: before, navigationPending: false, documentChanged: false, navigationStarted: false,
  });
  assert.equal(f.reads, 1);
  assert.equal(f.listeners.size, 0);
});

for (const pendingState of [{ status: "loading" }, { pendingUrl: after.url }]) {
  test(`unfinished navigation returns pending at the deadline: ${JSON.stringify(pendingState)}`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    const observer = await f.start(controller.signal, { timeoutMs: 5 });
    Object.assign(f.tab, pendingState);
    const result = await observer.finish(before);
    assert.equal(result.navigationPending, true);
    assert.equal(result.documentChanged, null);
    assert.deepEqual(result.pageAfter, before, "a pending destination is not reported as the committed URL");
    assert.equal(f.listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

for (const phase of ["baseline", "settle", "tab lookup"]) {
  test(`cancelling navigation observation during ${phase} removes its listeners`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const never = new Promise(() => {});
    let pending;
    if (phase === "baseline") {
      f.onProbe(() => { entered.resolve(); return never; });
      pending = f.start(controller.signal, { probeMs: 10_000 });
    } else {
      const observer = await f.start(controller.signal, { settleMs: phase === "settle" ? 10_000 : 1 });
      if (phase === "tab lookup") f.onGet(() => { entered.resolve(); return never; });
      else entered.resolve();
      pending = observer.finish(before);
    }
    const rejected = assert.rejects(pending, { code: "OPERATION_ABORTED" });
    await entered.promise;
    controller.abort();
    await rejected;
    assert.equal(f.listeners.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
}

test("a Chrome tab lookup failure propagates and releases navigation listeners", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const observer = await f.start(controller.signal);
  const error = new Error("No tab with id: 7");
  f.onGet(() => { throw error; });
  await assert.rejects(observer.finish(before), candidate => candidate === error);
  assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an unavailable document probe leaves identity unknown and does not claim a replacement", async t => {
  const f = fixture(t);
  f.onProbe(() => { throw new Error("Document changed during injection"); });
  const observer = await f.start();
  assert.deepEqual(await observer.finish(before), {
    pageAfter: before, navigationPending: false, documentChanged: null, navigationStarted: false,
  });
  assert.equal(f.listeners.size, 0);
});

test("abandoning an observation removes the listener before the action can start", async t => {
  const f = fixture(t);
  const observer = await f.start();
  assert.equal(f.listeners.size, 1);
  observer.dispose();
  observer.dispose();
  assert.equal(f.listeners.size, 0);
  await assert.rejects(observer.finish(before), { code: "OPERATION_ABORTED" });
  assert.equal(f.reads, 0);
});

test("cancellation releases the listener while the action itself is still pending", async t => {
  const f = fixture(t), controller = new AbortController();
  const observer = await f.start(controller.signal);
  assert.equal(f.listeners.size, 1);
  controller.abort();
  assert.equal(f.listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(observer.finish(before), { code: "OPERATION_ABORTED" });
});

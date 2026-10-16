import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationService } from "../../src/background/services/location.js";
import { DATA_CONSENT_VERSION, LOCATION_CONSENT_KEY, hasDataConsent } from "../../src/shared/data-consent.js";
import contextSources from "../../src/capabilities/sessions/context.js";

const context = { sessionId: "s", runId: "r", language: "en" };
const sender = { id: "test", url: "chrome-extension://test/sidepanel/sidepanel.html" };
globalThis.chrome = { runtime: { id: sender.id, getURL: path => `chrome-extension://test/${path}` } };
function fixture() {
  const data = {}, events = [];
  const pending = new Map(), stopped = new Set();
  let located = 0, unavailable = false, failSave = false, beforeSave = async () => {};
  const storage = { async get() { return data; }, async set(value) {
    if (failSave) throw new Error("disk full");
    await beforeSave(value);
    Object.assign(data, value);
  } };
  const host = { storage, emit: event => events.push(event), locate: async () => {
    located++; return unavailable ? null : { latitude: 30.25, longitude: 120.15, accuracy: 10, timestamp: "2026-10-14" };
  }, sessions: {
    isRunCurrent: (id, runId) => !stopped.has(`${id}:${runId}`), isWaitingForUser: id => pending.has(id),
    beginUserWait(id, options) { return new Promise((resolve, reject) => { pending.set(id, { options, resolve, reject }); }); },
  } };
  const service = createLocationService(host);
  return { service, data, events, host, get located() { return located; },
    stop(id = context.sessionId, runId = context.runId) { stopped.add(`${id}:${runId}`); },
    setUnavailable() { unavailable = true; }, failSave(value) { failSave = value; }, beforeSave(fn) { beforeSave = fn; },
    settle(error, id = context.sessionId) { const p = pending.get(id); pending.delete(id); p.options.onSettled(error ? "cancelled" : "user"); error ? p.reject(error) : p.resolve({ continued: true }); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("location is absent from automatic context collection", async () => {
  let reads = 0;
  const sources = contextSources({ getSessionRuntime: () => ({}), canUseSessionGoal: async () => false,
    getWorkingTabContext: async () => null, requestLocation: () => { reads++; }, getSecurityGuardrails: async () => ({}) });
  for (const source of sources) await source.read({ ...context, reason: "snapshot" });
  assert.equal(reads, 0);
  assert.equal(sources.some(source => source.id === "location"), false);
});

test("first use needs a panel click; later calls and restarts reuse durable permission", async () => {
  const f = fixture(); const task = f.service.request(context); await tick();
  const event = f.events[0];
  assert.equal(event.form.locationConsent, true);
  assert.equal(f.located, 0);
  await assert.rejects(f.service.accept(event.waitId, context.sessionId, { ...sender, url: "https://example.com" }));
  await f.service.accept(event.waitId, context.sessionId, sender); f.settle();
  assert.equal((await task).latitude, 30.25);
  await f.service.request(context);
  await createLocationService(f.host).request(context);
  assert.equal(f.located, 3);
  assert.equal(f.events.filter(event => event.type === "waiting_for_user").length, 1);
});

test("continue alone cannot grant location access", async () => {
  const f = fixture(); const task = f.service.request(context); const rejected = assert.rejects(task, { code: "LOCATION_CONSENT_REQUIRED" });
  await tick(); f.settle(); await rejected;
  assert.equal(f.located, 0); assert.equal(f.data[LOCATION_CONSENT_KEY], undefined);
});

test("declining or stopping prevents collection and stale approval", async () => {
  for (const stop of [false, true]) {
    const f = fixture(); const task = f.service.request(context); const rejected = assert.rejects(task);
    await tick(); const event = f.events[0];
    if (stop) f.stop();
    f.settle(new Error("cancelled")); await rejected;
    await assert.rejects(f.service.accept(event.waitId, context.sessionId, sender));
    assert.equal(f.located, 0); assert.equal(f.data[LOCATION_CONSENT_KEY], undefined);
  }
});

test("failed approval writes can be retried; unavailable location gives recovery guidance", async () => {
  const f = fixture(); const task = f.service.request(context); await tick(); const event = f.events[0];
  f.failSave(true); await assert.rejects(f.service.accept(event.waitId, context.sessionId, sender), /disk full/);
  assert.equal(f.located, 0);
  f.failSave(false); await f.service.accept(event.waitId, context.sessionId, sender); f.settle(); await task;
  f.setUnavailable(); await assert.rejects(f.service.request(context), { code: "LOCATION_UNAVAILABLE" });
});

test("external approval requires the current disclosure version and exact pending task", async () => {
  const f = fixture(); const task = f.service.request(context); await tick(); const { waitId } = f.events[0];
  assert.equal(await f.service.isAccepted(), false);
  for (const version of [undefined, DATA_CONSENT_VERSION - 1, String(DATA_CONSENT_VERSION)]) {
    await assert.rejects(f.service.acceptExternal(waitId, context.sessionId, version), { code: "LOCATION_CONSENT_VERSION_MISMATCH" });
  }
  for (const [id, sessionId] of [["old-wait", context.sessionId], [waitId, "other-session"]]) {
    await assert.rejects(f.service.acceptExternal(id, sessionId, DATA_CONSENT_VERSION), { code: "STALE_RUN" });
  }
  assert.equal(f.data[LOCATION_CONSENT_KEY], undefined);
  assert.deepEqual(await f.service.acceptExternal(waitId, context.sessionId, DATA_CONSENT_VERSION), { accepted: true });
  assert.equal(await f.service.isAccepted(), true);
  assert.equal(f.located, 0, "approval must not settle the wait or start location collection");
  f.settle(); await task;
  await assert.rejects(f.service.acceptExternal(waitId, context.sessionId, DATA_CONSENT_VERSION), { code: "STALE_RUN" });
});

test("external approval storage failures keep the wait pending and can be retried", async () => {
  const f = fixture(); const task = f.service.request(context); await tick(); const { waitId } = f.events[0];
  f.failSave(true);
  await assert.rejects(f.service.acceptExternal(waitId, context.sessionId, DATA_CONSENT_VERSION), /disk full/);
  assert.equal(await f.service.isAccepted(), false);
  f.failSave(false);
  await f.service.acceptExternal(waitId, context.sessionId, DATA_CONSENT_VERSION);
  f.settle(); await task;
});

test("cancellation or a new run during a write cannot leave location consent granted", async () => {
  for (const stop of [false, true]) {
    const f = fixture(); const task = f.service.request(context); const taskRejected = assert.rejects(task);
    await tick(); const { waitId } = f.events[0];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    f.beforeSave(value => value[LOCATION_CONSENT_KEY]?.grantId ? gate : undefined);
    const approving = f.service.acceptExternal(waitId, context.sessionId, DATA_CONSENT_VERSION);
    const approvalRejected = assert.rejects(approving, { code: "STALE_RUN" });
    await tick();
    const accepted = f.service.isAccepted();
    if (stop) f.stop();
    f.settle(new Error("cancelled"));
    release();
    await Promise.all([taskRejected, approvalRejected]);
    assert.equal(await accepted, false, "readers must wait for cancellation rollback");
    assert.equal(hasDataConsent(f.data[LOCATION_CONSENT_KEY]), false);
    assert.equal(f.located, 0);
  }
});

test("rolling back a cancelled approval preserves the next concurrent task's approval", async () => {
  const f = fixture(); const second = { ...context, sessionId: "second" };
  const firstTask = f.service.request(context); const rejected = assert.rejects(firstTask);
  const secondTask = f.service.request(second);
  await tick();
  const firstWait = f.events.find(event => event.sessionId === context.sessionId).waitId;
  const secondWait = f.events.find(event => event.sessionId === second.sessionId).waitId;
  let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.beforeSave(value => value[LOCATION_CONSENT_KEY]?.grantId && writes++ === 0 ? gate : undefined);
  const firstApproval = f.service.acceptExternal(firstWait, context.sessionId, DATA_CONSENT_VERSION);
  const rejectedApproval = assert.rejects(firstApproval, { code: "STALE_RUN" });
  const secondApproval = f.service.acceptExternal(secondWait, second.sessionId, DATA_CONSENT_VERSION);
  await tick();
  f.settle(new Error("cancelled"));
  release();
  await Promise.all([rejected, rejectedApproval, secondApproval]);
  assert.equal(await f.service.isAccepted(), true);
  f.settle(undefined, second.sessionId);
  await secondTask;
  assert.equal(f.located, 1);
});

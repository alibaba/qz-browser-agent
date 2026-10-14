import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationService } from "../../src/background/services/location.js";
import { LOCATION_CONSENT_KEY } from "../../src/shared/data-consent.js";
import contextSources from "../../src/capabilities/sessions/context.js";

const context = { sessionId: "s", runId: "r", language: "en" };
const sender = { id: "test", url: "chrome-extension://test/sidepanel/sidepanel.html" };
globalThis.chrome = { runtime: { id: sender.id, getURL: path => `chrome-extension://test/${path}` } };
function fixture() {
  const data = {}, events = [];
  let pending, current = true, located = 0, unavailable = false, failSave = false;
  const storage = { async get() { return data; }, async set(value) { if (failSave) throw new Error("disk full"); Object.assign(data, value); } };
  const host = { storage, emit: event => events.push(event), locate: async () => {
    located++; return unavailable ? null : { latitude: 30.25, longitude: 120.15, accuracy: 10, timestamp: "2026-10-14" };
  }, sessions: {
    isRunCurrent: () => current, isWaitingForUser: () => Boolean(pending),
    beginUserWait(_id, options) { return new Promise((resolve, reject) => { pending = { options, resolve, reject }; }); },
  } };
  const service = createLocationService(host);
  return { service, data, events, host, get located() { return located; },
    stop() { current = false; }, setUnavailable() { unavailable = true; }, failSave(value) { failSave = value; },
    settle(error) { const p = pending; pending = null; p.options.onSettled(error ? "cancelled" : "user"); error ? p.reject(error) : p.resolve({ continued: true }); },
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

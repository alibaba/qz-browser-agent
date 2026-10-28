import assert from "node:assert/strict";
import { test } from "node:test";
import { createDynamicContextProvider } from "../../src/sidepanel/features/app/dynamic-context-provider.js";

test("location errors retain browser diagnostics and each request can recover", async () => {
  const responses = [];
  let failure, calls = 0;
  const provider = createDynamicContextProvider({
    geolocation: { getCurrentPosition(success, reject, options) {
      calls++;
      assert.deepEqual(options, { enableHighAccuracy: false, maximumAge: 300000, timeout: 5000 });
      if (failure) reject(failure);
      else success({ coords: { latitude: 30.25, longitude: 120.15, accuracy: 10 }, timestamp: Date.now() });
    } },
    send: response => responses.push(response),
  });
  await provider.handle({ requestId: "no-location", fields: [] });
  assert.equal(calls, 0);
  for (const code of [1, 2, 3]) {
    failure = { code, message: `Browser error ${code}` };
    await provider.handle({ requestId: `fail-${code}`, fields: ["location"] });
    assert.deepEqual(responses.at(-1), { type: "dynamic_context_response", requestId: `fail-${code}`, context: { locationError: failure } });
    failure = null;
    await provider.handle({ requestId: `retry-${code}`, fields: ["location"] });
    const { context } = responses.at(-1);
    assert.equal(context.location.latitude, 30.25);
    assert.equal(context.locationError, undefined);
  }
  assert.equal(calls, 6);
});

test("missing APIs and synchronous exceptions still return a diagnostic response", async () => {
  for (const failure of [null, new DOMException("Blocked", "SecurityError"), new Error("Location failed")]) {
    let response;
    const provider = createDynamicContextProvider({
      geolocation: failure ? { getCurrentPosition() { throw failure; } } : undefined,
      send: value => { response = value; },
    });
    await provider.handle({ requestId: "request", fields: ["location"] });
    assert.equal(response.requestId, "request");
    assert.deepEqual(response.context.locationError, {
      code: failure?.name === "SecurityError" ? 1 : 0,
      message: failure?.message || "Geolocation API is unavailable",
    });
  }
});

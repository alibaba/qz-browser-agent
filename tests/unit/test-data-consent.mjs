import assert from "node:assert/strict";
import { test } from "node:test";
import { createDataConsentService } from "../../src/background/services/data-consent.js";
import { createBackgroundApi } from "../../src/background/background-api.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { DATA_CONSENT_KEY, DATA_CONSENT_VERSION, hasDataConsent } from "../../src/shared/data-consent.js";

const runtime = { id: "test", getURL: path => `chrome-extension://test/${path}` };
globalThis.chrome = { runtime };
const sender = { id: runtime.id, url: runtime.getURL("sidepanel/sidepanel.html") };
const record = () => ({ version: DATA_CONSENT_VERSION, acceptedAt: 1 });
function memory(value) {
  const data = { [DATA_CONSENT_KEY]: value };
  return { data, async get() { return data; }, async set(patch) { Object.assign(data, patch); } };
}

test("only a current, explicitly accepted disclosure survives restart", async () => {
  for (const value of [null, true, {}, { status: "activated" }, { version: 0, acceptedAt: 1 }, { version: 1 }, { version: 1, acceptedAt: NaN }]) {
    assert.equal(hasDataConsent(value), false);
    const service = createDataConsentService(memory(value));
    await service.ready;
    assert.throws(service.assertAccepted, { code: "DATA_CONSENT_REQUIRED" });
  }
  const service = createDataConsentService(memory(record()));
  await service.ready;
  await service.whenAccepted;
  assert.doesNotThrow(service.assertAccepted);
});

test("storage failures remain blocked and accepting can be retried", async () => {
  const storage = memory();
  let fail = true;
  const service = createDataConsentService({ ...storage, async set(patch) {
    if (fail) throw new Error("disk full");
    await storage.set(patch);
  } });
  await service.ready;
  await assert.rejects(service.accept(DATA_CONSENT_VERSION, sender), /disk full/);
  assert.throws(service.assertAccepted, { code: "DATA_CONSENT_REQUIRED" });
  fail = false;
  await service.accept(DATA_CONSENT_VERSION, sender);
  await service.whenAccepted;
  const restarted = createDataConsentService(storage);
  await restarted.ready;
  assert.doesNotThrow(restarted.assertAccepted);
});

test("only the side panel can accept the current disclosure", async () => {
  const service = createDataConsentService(memory());
  for (const invalid of [{}, { ...sender, id: "other" }, { ...sender, url: "https://example.com" }, { ...sender, url: runtime.getURL("offscreen.html") }]) {
    await assert.rejects(service.accept(DATA_CONSENT_VERSION, invalid), /side panel/);
  }
  await assert.rejects(service.accept(DATA_CONSENT_VERSION - 1, sender), /changed/);
  assert.throws(service.assertAccepted, { code: "DATA_CONSENT_REQUIRED" });
});

test("shared API rejects task and tool execution until runtime consent succeeds", async () => {
  let calls = 0;
  const service = createDataConsentService(memory());
  await service.ready;
  const api = createBackgroundApi({
    system: { acceptDataConsent: service.accept },
    sessions: { submit: () => ++calls },
    tools: { acceptRunScriptInnerMessage: () => ++calls },
  }, path => { if (path !== "system.acceptDataConsent") service.assertAccepted(); });
  assert.throws(() => api.sessions.submit(), { code: "DATA_CONSENT_REQUIRED" });
  const transport = createRuntimeMessageTransport(api);
  const reply = (message, source = sender) => new Promise(resolve => transport.listener(message, source, resolve));
  assert.equal((await reply({ type: "run_script_tool_call" })).code, "DATA_CONSENT_REQUIRED");
  assert.equal(calls, 0);
  assert.equal((await reply({ type: "accept_data_consent", version: DATA_CONSENT_VERSION })).ok, true);
  assert.equal(api.sessions.submit(), 1);
});

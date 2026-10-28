import assert from "node:assert/strict";
import { createSidepanelChannel } from "../../src/background/transports/sidepanel-channel.js";
import { backendMessages } from "../../src/shared/i18n/backend-messages.js";
import { getLanguage } from "../../src/shared/i18n/index.js";

const runtime = { onConnect: makeEvent() };
const dispatched = [];
const channel = createSidepanelChannel({
  normalizeSessionId: value => String(value || "").trim(),
  getRuntime: sessionId => ({ sessionId, status: "running", running: true,
    pendingFollowUpMessages: [{ images: ["private-image-body"] }], pendingSteeringMessages: [{ text: "private-body" }],
    pendingFollowUps: [{ messageId: "queued" }], pendingFollowUpCount: 1,
  }),
});
const unregister = channel.register(runtime, async (message, port) => {
  dispatched.push(message);
  if (message.type === "dynamic_context_response") {
    channel.acceptDynamicContextResponse(message);
    return;
  }
  if (message.type === "fail") {
    const error = new Error("injected dispatch failure");
    error.code = "DISPATCH_FAILED";
    error.details = { retryable: false };
    throw error;
  }
  port.postMessage({ type: "ack", requestId: message.requestId });
});

channel.remember("pending", { type: "session_deleted", sessionId: "s0" }, 1000);
const ignored = createPort("other");
runtime.onConnect.emit(ignored);
assert.equal(channel.size(), 0);

const first = createPort("sidepanel");
runtime.onConnect.emit(first);
assert.equal(channel.size(), 1);
assert.deepEqual(first.sent, [{ type: "session_deleted", sessionId: "s0" }], "a new port should receive only real pending events");

const second = createPort("sidepanel");
runtime.onConnect.emit(second);
assert.equal(channel.size(), 2);
assert.equal(second.sent.some(message => message.type === "session_deleted"), false, "remembered events are delivered once");

channel.remember(
  "target-window-2",
  { type: "session_reveal_requested", sessionId: "s2" },
  1000,
  { windowId: 2 },
);
first.onMessage.emit({ type: "sidepanel_attach", requestId: "attach-1", windowId: 1 });
second.onMessage.emit({ type: "sidepanel_attach", requestId: "attach-2", windowId: 2 });
await tick();
assert.equal(channel.hasPorts(1), true);
assert.equal(channel.hasPorts(2), true);
assert.equal(channel.getWindowId(first), 1);
assert.equal(channel.getWindowId(second), 2);
assert.equal(first.sent.some(message => message.type === "session_reveal_requested"), false);
assert.equal(second.sent.some(message => message.type === "session_reveal_requested" && message.sessionId === "s2"), true);
assert.equal(second.sent.at(-1).type, "sidepanel_attached");

assert.equal(await channel.sendToWindow(1, { type: "session_reveal_requested", sessionId: "s1" }), true);
assert.equal(first.sent.at(-1).sessionId, "s1");
assert.notEqual(second.sent.at(-1).sessionId, "s1", "window-scoped navigation must not leak to another panel");
assert.equal(await channel.sendToWindow(9, { type: "session_reveal_requested", sessionId: "missing" }), false);

const enriched = channel.broadcast({ type: "message_update", sessionId: "s1", content: "hello" });
assert.equal(enriched.runtime.status, "running");
assert.equal(first.sent.at(-1).runtime.sessionId, "s1");
assert.equal(second.sent.at(-1).content, "hello");
assert.deepEqual(first.sent.at(-1).runtime.pendingFollowUpMessages, [{ images: ["private-image-body"] }]);
assert.deepEqual(first.sent.at(-1).runtime.pendingSteeringMessages, [{ text: "private-body" }]);
assert.equal(first.sent.at(-1).runtime.pendingFollowUpCount, 1);
assert.deepEqual(first.sent.at(-1).runtime.pendingFollowUps, [{ messageId: "queued" }]);
channel.broadcast({ type: "session_pending", sessionId: "s1", runId: "next-run" });
assert.equal(first.sent.at(-1).runId, "next-run");
assert.deepEqual(first.sent.at(-1).runtime, enriched.runtime, "initialization events include the authoritative runtime snapshot");
channel.broadcast({ type: "queue_update", sessionId: "s1", pendingFollowUpMessages: [{ images: ["private-image-body"] }],
  pendingSteeringMessages: [], pendingFollowUpCount: 1, pendingFollowUps: [{ messageId: "queued" }],
});
assert.deepEqual(first.sent.at(-1).pendingFollowUpMessages, [{ images: ["private-image-body"] }]);
assert.deepEqual(first.sent.at(-1).pendingSteeringMessages, []);
assert.equal(first.sent.at(-1).pendingFollowUpCount, 1);

first.onPosted = message => {
  if (message.type !== "dynamic_context_request") return;
  queueMicrotask(() => first.onMessage.emit({
    type: "dynamic_context_response",
    requestId: message.requestId,
    context: { location: { href: "https://example.test/" } },
  }));
};
assert.deepEqual(await channel.requestLocation({ timeoutMs: 100 }), { href: "https://example.test/" });
first.onPosted = null;
const locationText = key => backendMessages.messages[key][getLanguage() === "zh-CN" ? "zh-CN" : "en"];
await assert.rejects(channel.requestLocation({ timeoutMs: 5 }), error => {
  assert.equal(error.code, "LOCATION_RESPONSE_TIMEOUT");
  assert.equal(error.message, locationText("locationResponseTimeout"));
  assert.equal(error.message.includes("LOCATION_RESPONSE_TIMEOUT"), false);
  assert.equal(error.details.timeoutMs, 5);
  return true;
});
const timedOutId = first.sent.at(-1).requestId;
assert.equal(channel.acceptDynamicContextResponse({ requestId: timedOutId, context: { location: { latitude: 1 } } }), false);
await assert.rejects(channel.requestLocation({ windowId: 999 }), error => {
  assert.equal(error.code, "LOCATION_PANEL_UNAVAILABLE");
  assert.equal(error.message, locationText("locationPanelUnavailable"));
  return true;
});
const locationAbort = new AbortController();
const pendingLocation = channel.requestLocation({ signal: locationAbort.signal });
locationAbort.abort();
assert.equal(await pendingLocation, null);
assert.equal(await channel.requestLocation({ signal: locationAbort.signal }), null);

for (const [browserCode, code, messageKey] of [
  [1, "LOCATION_PERMISSION_DENIED", "locationPermissionDenied"],
  [2, "LOCATION_POSITION_UNAVAILABLE", "locationPositionUnavailable"],
  [3, "LOCATION_TIMEOUT", "locationTimeout"],
  [0, "LOCATION_UNAVAILABLE", "locationUnavailable"],
]) {
  const pending = channel.requestLocation({ timeoutMs: 100 });
  const requestId = first.sent.at(-1).requestId;
  channel.acceptDynamicContextResponse({ requestId, context: { locationError: { code: browserCode, message: "Browser diagnostic" } } });
  await assert.rejects(pending, error => error.code === code && error.message === locationText(messageKey)
    && error.details.browserCode === browserCode && error.details.browserMessage === "Browser diagnostic"
    && !error.message.includes(code));
  assert.equal(channel.acceptDynamicContextResponse({ requestId }), false);
  const retry = channel.requestLocation({ timeoutMs: 100 });
  channel.acceptDynamicContextResponse({ requestId: first.sent.at(-1).requestId, context: { location: { latitude: 30.25 } } });
  assert.deepEqual(await retry, { latitude: 30.25 });
}


first.onMessage.emit({ type: "ok", requestId: "request-ok" });
await tick();
assert.deepEqual(dispatched.at(-1), { type: "ok", requestId: "request-ok" });
assert.deepEqual(first.sent.at(-1), { type: "ack", requestId: "request-ok" });

first.onMessage.emit({ type: "fail", requestId: "request-fail", sessionId: "s1" });
await tick();
assert.deepEqual(first.sent.at(-1), {
  type: "request_failed",
  sessionId: "s1",
  requestId: "request-fail",
  requestType: "fail",
  message: "injected dispatch failure",
  code: "DISPATCH_FAILED",
  details: { retryable: false },
});

const disconnectedLocation = channel.requestLocation({ windowId: 1 });
const disconnectedRequestId = first.sent.at(-1).requestId;
first.onDisconnect.emit();
await assert.rejects(disconnectedLocation, { code: "LOCATION_PANEL_UNAVAILABLE" });
assert.equal(channel.acceptDynamicContextResponse({ requestId: disconnectedRequestId }), false);
const otherWindowLocation = channel.requestLocation({ windowId: 2 });
channel.acceptDynamicContextResponse({ requestId: second.sent.at(-1).requestId, context: { location: { latitude: 31 } } });
assert.deepEqual(await otherWindowLocation, { latitude: 31 });
second.onDisconnect.emit();
assert.equal(channel.getWindowId(first), null);
assert.equal(channel.size(), 0);
assert.equal(first.onMessage.size, 0);
assert.equal(first.onDisconnect.size, 0);
const third = createPort("sidepanel");
runtime.onConnect.emit(third);
const reconnectedLocation = channel.requestLocation();
channel.acceptDynamicContextResponse({ requestId: third.sent.at(-1).requestId, context: { location: { latitude: 32 } } });
assert.deepEqual(await reconnectedLocation, { latitude: 32 });
unregister();
assert.equal(runtime.onConnect.size, 0);
assert.equal(third.onMessage.size, 0);
assert.equal(third.onDisconnect.size, 0);
assert.equal(channel.size(), 0);

console.log("sidepanel channel lifecycle tests passed");

function createPort(name) {
  const port = {
    name,
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    sent: [],
    onPosted: null,
    postMessage(message) {
      this.sent.push(structuredClone(message));
      this.onPosted?.(message);
    },
  };
  return port;
}

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
    get size() { return listeners.size; },
  };
}

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

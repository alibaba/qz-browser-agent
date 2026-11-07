import assert from "node:assert/strict";
import test from "node:test";
import { createReceiveBudget, createTransferBudget } from "../../src/shared/transport/transfer-budget.js";
import { createPortTransport } from "../../src/shared/transport/port-transport.js";
import { encodeMessage, MESSAGE_FRAME_BYTES } from "../../src/shared/transport/message-codec.js";
import { createPortClient } from "../../src/sidepanel/features/app/port-client.js";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createChatRunController } from "../../src/sidepanel/features/chat/chat-run-controller.js";
import { createSidepanelChannel } from "../../src/background/transports/sidepanel-channel.js";

const limits = { frameBytes: 4096, chunkBytes: 512, transferBytes: 32_768, bufferedBytes: 32_768, messages: 8, timeoutMs: 1000, handshakeMs: 100 };

test("small messages retain synchronous native delivery and legacy large envelopes remain accepted", t => {
  const sent = [], received = [];
  const transport = createPortTransport({ limits, postMessage: message => sent.push(message), onMessage: message => received.push(message) });
  t.after(() => transport.dispose());
  void transport.send({ type: "first", sessionId: "s" });
  void transport.send({ type: "second", sessionId: "other" });
  assert.deepEqual(sent.map(message => message.type), ["first", "second"]);
  assert.equal(transport.snapshot().queued, 0);
  const legacy = { type: "messages", text: "legacy".repeat(1000) };
  transport.receive(legacy);
  assert.deepEqual(received, [legacy]);
});

test("native and forced chunk delivery preserve invocation order without awaiting business handlers", async t => {
  const messages = [
    { type: "prompt", sessionId: "s", text: "x".repeat(6000) },
    { type: "stop_session", sessionId: "s" },
    { type: "get_state", sessionId: "other" },
    { type: "ping" },
  ];
  const observations = [];
  for (const frameBytes of [16_384, 4096]) {
    let releaseBusiness;
    const completed = [];
    const fixture = linked(t, { frameBytes }, async message => {
      if (message.type === "prompt") await new Promise(resolve => { releaseBusiness = resolve; });
      completed.push(message.type);
    });
    await Promise.all(messages.map(message => fixture.left.send(message)));
    await until(() => fixture.received.length === messages.length);
    observations.push(fixture.received);
    assert.deepEqual(completed, ['stop_session', 'get_state', 'ping'], "transport dispatch must not serialize business completion");
    releaseBusiness();
    await until(() => completed.length === messages.length);
    assert.equal(completed.at(-1), 'prompt');
  }
  assert.deepEqual(observations, [messages, messages]);
});

test("opposite directions remain independent while each direction preserves FIFO", async t => {
  const fixture = linked(t, {}, undefined, true);
  const first = fixture.left.send({ type: "messages", text: "x".repeat(6000) });
  const after = fixture.left.send({ type: "state", requestId: "after" });
  await until(() => fixture.held.length);
  await fixture.right.send({ type: "get_state", requestId: "reverse" });
  await until(() => fixture.reverse.length);
  assert.deepEqual(fixture.received, []);
  assert.equal(fixture.reverse[0].requestId, "reverse");
  fixture.release();
  await Promise.all([first, after]);
  assert.deepEqual(fixture.received.map(message => message.type), ["messages", "state"]);
});

test("Side Panel preserves event, snapshot, cross-session and reply order during chunk delivery", async t => {
  const fixture = channelFixture(t);
  fixture.channel.broadcast({ type: "message_start", sessionId: "s", runId: "run", eventSeq: 1, content: "x".repeat(MESSAGE_FRAME_BYTES) });
  fixture.channel.broadcast({ type: "message_update", sessionId: "s", runId: "run", eventSeq: 2, requestId: "provider-reference", delta: "next" });
  fixture.channel.broadcast({ type: "reset", sessionId: "s" });
  fixture.channel.broadcast({ type: "message_end", sessionId: "other", eventSeq: 1 });
  await fixture.peer.send({ type: "stop_session", sessionId: "s", requestId: "stop" });
  await until(() => fixture.held.length && fixture.dispatched.length === 1);
  assert.deepEqual(fixture.received, [], "the stop reply uses the same outbound FIFO");
  assert.equal(fixture.dispatched[0].type, "stop_session", "the inbound direction is independent");
  fixture.release();
  await until(() => fixture.received.some(message => message.requestId === "stop"));
  assert.deepEqual(fixture.received.map(message => message.type), ["message_start", "message_update", "reset", "message_end", "state"]);
  assert.deepEqual(fixture.errors, []);
});

test("correlated large snapshots precede later increments, restore barriers and state replies", async t => {
  const fixture = channelFixture(t);
  fixture.channel.broadcast({ type: "messages", sessionId: "s", requestId: "snapshot", transcript: [{ type: "user", text: "u".repeat(MESSAGE_FRAME_BYTES) }] });
  fixture.channel.broadcast({ type: "message_end", sessionId: "s", eventSeq: 1, message: { role: "assistant", content: "new answer" } });
  fixture.channel.broadcast({ type: "session_restored", sessionId: "s", requestId: "restore" });
  await fixture.peer.send({ type: "get_state", sessionId: "s", requestId: "status" });
  await until(() => fixture.held.length && fixture.dispatched.length === 1);
  assert.deepEqual(fixture.received, []);
  fixture.release();
  await until(() => fixture.received.some(message => message.requestId === "status"));
  assert.deepEqual(fixture.received.map(message => message.type), ["messages", "message_end", "session_restored", "state"]);
});

test("queued and active messages share bounded byte and count budgets and recover after cancellation", async t => {
  for (const overrides of [{ messages: 2 }, { bufferedBytes: 12_500, transferBytes: 12_500 }]) {
    const budget = createTransferBudget(32_768);
    const fixture = linked(t, overrides, undefined, true, budget);
    const controller = new AbortController();
    const first = fixture.left.send({ type: "first", text: "a".repeat(6000) }, { signal: controller.signal });
    const cancelled = assert.rejects(first, { code: "TRANSPORT_CANCELLED" });
    const second = { type: "second", text: "b".repeat(6000) };
    const waiting = fixture.left.send(second);
    second.text = "mutated after enqueue";
    await assert.rejects(fixture.left.send({ type: "third", text: "c".repeat(6000) }), { code: "TRANSPORT_BUSY" });
    assert.equal(fixture.left.snapshot().queued, 2);
    assert.ok(budget.snapshot().reservedBytes > 12_000);
    await until(() => fixture.held.length);
    // Discard the native frame already withheld by this fixture: cancellation revokes it.
    fixture.held.splice(0);
    controller.abort();
    await cancelled;
    fixture.release();
    await waiting;
    assert.equal(fixture.received[0].text, "b".repeat(6000));
    assert.equal(budget.snapshot().reservedBytes, 0);
    await fixture.left.send({ type: "recovered" });
    await until(() => fixture.received.length === 2);
    assert.equal(fixture.received.at(-1).type, "recovered");
  }
});

test("queued cancellation skips only that message and disposal never replays waiting messages", async t => {
  const budget = createTransferBudget(32_768);
  const fixture = linked(t, {}, undefined, true, budget);
  const first = fixture.left.send({ type: "first", text: "x".repeat(6000) });
  const controller = new AbortController();
  const skipped = fixture.left.send({ type: "cancelled" }, { signal: controller.signal });
  const cancelled = assert.rejects(skipped, { code: "TRANSPORT_CANCELLED" });
  const third = fixture.left.send({ type: "third" });
  controller.abort(); await cancelled;
  assert.equal(fixture.left.snapshot().queued, 2);
  fixture.release();
  await Promise.all([first, third]);
  assert.deepEqual(fixture.received.map(message => message.type), ["first", "third"]);
  assert.equal(budget.snapshot().reservedBytes, 0);

  fixture.pause();
  const active = fixture.left.send({ type: "discarded", text: "x".repeat(6000) });
  const queued = fixture.left.send({ type: "never" });
  const failed = [active, queued].map(promise => assert.rejects(promise, { code: "TRANSPORT_DISCONNECTED" }));
  await until(() => fixture.held.length);
  fixture.left.dispose(); fixture.right.dispose();
  assert.equal(budget.snapshot().reservedBytes, 0);
  assert.equal(fixture.left.snapshot().queued, 0);
  fixture.release();
  await Promise.all(failed);
  assert.deepEqual(fixture.received.map(message => message.type), ["first", "third"]);
});

test("one context budget bounds incomplete transfers across independent ports and frees on disconnect", async t => {
  const budget = createTransferBudget(14_000);
  const limits = { frameBytes: 4096, chunkBytes: 512, transferBytes: 16_000, bufferedBytes: 16_000, transfers: 2, timeoutMs: 1000, handshakeMs: 100 };
  const ports = [0, 1].map(() => createPortTransport({ budget, limits, postMessage() {}, onMessage() {} }));
  t.after(() => ports.forEach(port => port.dispose()));
  const request = ports[0].send({ type: "messages", text: "a".repeat(10_000) });
  const result = assert.rejects(request, { code: "TRANSPORT_DISCONNECTED" });
  await assert.rejects(ports[1].send({ type: "messages", text: "b".repeat(10_000) }), { code: "TRANSPORT_BUSY" });
  assert.ok(budget.snapshot().reservedBytes > 10_000);
  ports[0].dispose();
  await result;
  assert.equal(budget.snapshot().reservedBytes, 0);
  await ports[1].send({ type: "state", requestId: "stop" });
});

test("incoming Ports wait fairly for shared allocation and malformed transfer cleanup restores capacity", async t => {
  const receiveBudget = createReceiveBudget(14_000);
  const errors = [], frames = [[], []];
  const limits = { frameBytes: 4096, chunkBytes: 512, transferBytes: 16_000, bufferedBytes: 32_000 };
  const ports = [0, 1].map(index => createPortTransport({ receiveBudget, limits, postMessage: frame => frames[index].push(frame), onMessage: assert.fail,
    onError: error => errors.push(error.code),
  }));
  t.after(() => ports.forEach(port => port.dispose()));
  const frame = fields => ({ __qz_transport__: 1, ...fields });
  ports.forEach(port => port.receive(frame({ op: "hello" })));
  ports[0].receive(frame({ op: "begin", id: "first", bytes: 10_000, identity: {} }));
  ports[1].receive(frame({ op: "begin", id: "second", bytes: 10_000, identity: {} }));
  await Promise.resolve();
  assert.deepEqual(errors, []);
  assert.equal(receiveBudget.snapshot().reservedBytes, 10_000);
  assert.equal(receiveBudget.snapshot().waiting, 1);
  assert.equal(ports[1].snapshot().receivingBytes, 0);
  assert.equal(frames[1].some(frame => frame.op === 'ack'), false);
  ports[0].receive(frame({ op: "chunk", id: "first", seq: 99, data: "YQ==" }));
  assert.equal(errors.at(-1), "TRANSPORT_PROTOCOL_ERROR");
  await Promise.resolve();
  assert.equal(receiveBudget.snapshot().waiting, 0);
  assert.equal(ports[1].snapshot().receivingBytes, 10_000);
  assert.equal(frames[1].at(-1).op, 'ack');
  ports[1].dispose();
  assert.equal(receiveBudget.snapshot().reservedBytes, 0);
});

test("two large logical responses on one Port or separate Ports wait without exceeding receive quota", async t => {
  for (const samePort of [true, false]) {
    const encoded = createTransferBudget(25_600), receiveBudget = createReceiveBudget(12_800);
    const overrides = { transferBytes: 12_800, bufferedBytes: 25_600 };
    const first = linked(t, overrides, undefined, true, encoded, receiveBudget);
    const second = samePort ? first : linked(t, overrides, undefined, false, encoded, receiveBudget);
    const a = first.left.send({ type: 'messages', requestId: 'a', text: 'a'.repeat(7000) });
    const b = second.left.send({ type: 'messages', requestId: 'b', text: 'b'.repeat(7000) });
    await until(() => first.held.length);
    assert.ok(encoded.snapshot().reservedBytes > 14_000);
    assert.ok(receiveBudget.snapshot().reservedBytes < 12_800);
    assert.equal(receiveBudget.snapshot().waiting, samePort ? 0 : 1);
    assert.equal(second.received.length, 0);
    first.release();
    await Promise.all([a, b]);
    const received = samePort ? first.received : [...first.received, ...second.received];
    assert.deepEqual(received.map(message => message.requestId), ['a', 'b']);
    assert.equal(encoded.snapshot().reservedBytes, 0);
    assert.equal(receiveBudget.snapshot().reservedBytes, 0);
  }
});

test("large transfers in both directions cannot deadlock by consuming each other's receive quota", async t => {
  const fixture = linked(t, { transferBytes: 12_800, bufferedBytes: 25_600 });
  await Promise.all([
    fixture.left.send({ type: 'request', text: 'a'.repeat(7000) }),
    fixture.right.send({ type: 'response', text: 'b'.repeat(7000) }),
  ]);
  assert.equal(fixture.received[0].type, 'request');
  assert.equal(fixture.reverse[0].type, 'response');
  assert.equal(fixture.left.snapshot().bufferedBytes, 0);
  assert.equal(fixture.right.snapshot().bufferedBytes, 0);
});

test("receive quota is FIFO and removing a cancelled waiter permits the next grant", async () => {
  const budget = createReceiveBudget(12_000, 2);
  const releaseFirst = await budget.acquire(8000);
  const controller = new AbortController(), grants = [];
  const second = budget.acquire(6000, { signal: controller.signal });
  const cancelled = assert.rejects(second, { code: 'TRANSPORT_CANCELLED' });
  const third = budget.acquire(3000).then(release => { grants.push('third'); return release; });
  await Promise.resolve();
  assert.deepEqual(grants, [], 'a smaller request cannot bypass the earlier waiter');
  await assert.rejects(budget.acquire(1), { code: 'TRANSPORT_BUSY' });
  controller.abort();
  await cancelled;
  const releaseThird = await third;
  assert.deepEqual(grants, ['third']);
  assert.equal(budget.snapshot().reservedBytes, 11_000);
  releaseThird(); releaseThird(); releaseFirst();
  assert.deepEqual(budget.snapshot(), { reservedBytes: 0, limitBytes: 12_000, waiting: 0 });
});

test("waiting receive timeout and disconnect cancel quota ownership even before the grant continuation", async t => {
  const budget = createReceiveBudget(12_000);
  const release = await budget.acquire(8000);
  const errors = [];
  const transport = createPortTransport({ limits: { ...limits, timeoutMs: 20 }, receiveBudget: budget,
    postMessage() {}, onMessage: assert.fail, onError: error => errors.push(error.code),
  });
  t.after(() => transport.dispose());
  const frame = fields => ({ __qz_transport__: 1, ...fields });
  transport.receive(frame({ op: 'hello' }));
  transport.receive(frame({ op: 'begin', id: 'timeout', bytes: 6000, identity: {} }));
  assert.equal(budget.snapshot().waiting, 1);
  await until(() => errors.length);
  assert.deepEqual(errors, ['TRANSPORT_TIMEOUT']);
  assert.equal(budget.snapshot().waiting, 0);
  assert.equal(budget.snapshot().reservedBytes, 8000);
  release();
  transport.receive(frame({ op: 'begin', id: 'cancelled-after-grant', bytes: 6000, identity: {} }));
  assert.equal(budget.snapshot().reservedBytes, 6000);
  transport.dispose();
  await Promise.resolve();
  assert.equal(budget.snapshot().reservedBytes, 0);
  assert.equal(transport.snapshot().bufferedBytes, 0);
});

test("streaming UTF-8 encoding preserves non-BMP text at slice and byte boundaries", async t => {
  const fixture = linked(t);
  const message = { type: 'unicode', text: ('a'.repeat(493) + '🌏🌍' + '中文'.repeat(21)).repeat(25) };
  await fixture.left.send(message);
  assert.deepEqual(fixture.received, [message]);
});

function channelFixture(t) {
  const received = [], errors = [], held = [], dispatched = [];
  const runtime = { onConnect: event() };
  const native = { name: "sidepanel", onMessage: event(), onDisconnect: event(), disconnect() { native.onDisconnect.emit(); } };
  let paused = true;
  const peer = createPortTransport({ postMessage: message => queueMicrotask(() => native.onMessage.emit(message)), onMessage: message => received.push(message), onError: error => errors.push(error.code) });
  native.postMessage = message => {
    if (paused && message.op === "chunk") held.push(message);
    else queueMicrotask(() => peer.receive(message));
  };
  const channel = createSidepanelChannel();
  const unregister = channel.register(runtime, async (message, port) => {
    dispatched.push(message);
    port.postMessage({ type: "state", sessionId: message.sessionId, requestId: message.requestId, running: false });
  });
  runtime.onConnect.emit(native);
  t.after(() => { unregister(); peer.dispose(); });
  return { channel, peer, native, runtime, received, errors, held, dispatched, release() { paused = false; for (const frame of held.splice(0)) peer.receive(frame); } };
}
function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: (...args) => [...listeners].forEach(listener => listener(...args)) };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for transport observation");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function linked(t, overrides = {}, onMessage = () => {}, paused = false, budget, receiveBudget) {
  const received = [], reverse = [], held = [], errors = [];
  let left, right;
  left = createPortTransport({ limits: { ...limits, ...overrides }, budget,
    postMessage(message) {
      if (paused && message.op === 'chunk') held.push(message);
      else queueMicrotask(() => right.receive(structuredClone(message)));
    },
    onMessage: message => reverse.push(message), onError: error => errors.push(error.code),
  });
  right = createPortTransport({ limits: { ...limits, ...overrides }, receiveBudget,
    postMessage: message => queueMicrotask(() => left.receive(structuredClone(message))),
    onMessage(message) { received.push(message); void onMessage(message); }, onError: error => errors.push(error.code),
  });
  t.after(() => { left.dispose(); right.dispose(); });
  return { left, right, received, reverse, held, errors,
    pause() { paused = true; },
    release() { paused = false; for (const message of held.splice(0)) right.receive(message); },
  };
}

test("UI stop cannot overtake an earlier uploading follow-up and start a new run afterward", async t => {
  const runtime = { onConnect: event() }, held = [], calls = [], acceptedFollowUps = [];
  let paused = true, agentSequence = 0, view = { status: 'idle', running: false, runId: '' }, stopResponse;
  const supervisor = createSessionSupervisor({ createAgent(lease) {
    const number = ++agentSequence;
    let finish;
    const agent = {
      isStreaming: false, messages: [], runId: '',
      getRunState() { return { runId: agent.runId, isStreaming: agent.isStreaming }; },
      exportSession() { return { entries: [] }; },
      abort() { agent.isStreaming = false; finish?.(); },
      begin(label) {
        agent.isStreaming = true; agent.runId = `run-${number}`;
        view = { status: 'running', running: true, runId: agent.runId };
        calls.push({ action: 'run_started', label, epoch: lease.epoch, runId: agent.runId });
        return new Promise(resolve => { finish = resolve; });
      },
    };
    return agent;
  } });
  const original = await supervisor.startTask('s', ({ agent }) => agent.begin('original run'));
  await Promise.resolve();
  const clientPort = {
    onMessage: event(), onDisconnect: event(),
    disconnect() { clientPort.onDisconnect.emit(); native.onDisconnect.emit(); },
    postMessage(frame) {
      if (paused && frame.op === 'chunk') held.push(frame);
      else queueMicrotask(() => native.onMessage.emit(frame));
    },
  };
  const native = { name: 'sidepanel', onMessage: event(), onDisconnect: event(),
    disconnect: () => clientPort.disconnect(), postMessage: frame => queueMicrotask(() => clientPort.onMessage.emit(frame)) };
  const api = { system: { ready: async () => {} }, sessions: {
    async stop(sessionId) {
      calls.push({ action: 'stop' });
      const revoked = await supervisor.revoke(sessionId);
      view = { status: 'aborted', running: false, runId: revoked.liveState.runId };
      return { sessionId, title: 'Uploading follow-up', status: view.status, stopped: true };
    },
    async state(sessionId) { return { sessionId, status: view.status, isStreaming: view.running, runId: view.runId, runtime: view }; },
    async submit(message) {
      calls.push({ action: 'submit' });
      const admitted = await supervisor.submitMessage(message.sessionId, {
        messageId: message.clientMessageId,
        enqueue: async () => {
          acceptedFollowUps.push(message.clientMessageId);
          await message.onMessageAccepted({ clientMessageId: message.clientMessageId }, { disposition: 'queued' });
          return {};
        },
        executor: async ({ agent }) => {
          const running = agent.begin('uploaded before stop');
          await message.onMessageAccepted({ clientMessageId: message.clientMessageId }, { disposition: 'started' });
          return running;
        },
      });
      return { promise: admitted.task?.promise };
    },
  } };
  const channel = createSidepanelChannel();
  const unregister = channel.register(runtime, createSidepanelTransport(api).dispatch);
  const client = createPortClient({ connect() { queueMicrotask(() => runtime.onConnect.emit(native)); return clientPort; } });
  const noop = () => {}, classes = new Set(['hidden']);
  const ui = createChatRunController({
    messagesEl: {}, statusBar: { classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x) } }, statusText: { textContent: '' },
    transcript: { getCurrentTranscript: () => [], hideAssistantActions: noop, scheduleRender: noop, render: noop },
    scroll: { updateSafeArea: noop, settleAfterDockLayout: noop, shouldFollowTail: () => false }, queue: { render: noop },
    getSessionId: () => 's', isCurrentSession: id => id === 's', isChatActive: () => true,
    getRuntime: () => view, isRuntimeRunning: value => value.running,
    trackBackgroundRun: incoming => { view = { ...view, ...incoming.runtime }; },
    send: message => { void client.send(message); },
    request(type, payload, timeout) {
      const pending = client.request(type, payload, timeout);
      if (type === 'stop_session') stopResponse = pending;
      return pending;
    },
  });
  t.after(async () => { ui.finish(); await supervisor.revoke('s'); client.stop(); unregister(); });
  ui.start('run-1', { requireConversation: false });
  const prompt = client.request('prompt', { sessionId: 's', clientMessageId: 'image-followup', text: 'inspect the attached images',
    images: Array.from({ length: 4 }, () => ({ dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(2400000) })),
  }, 10000);
  await until(() => held.length === 1);
  assert.equal(ui.canStop(), true);
  assert.equal(ui.stop(), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls.map(call => call.action), ['run_started'], 'stop must wait behind the earlier incomplete prompt');
  paused = false;
  for (const frame of held.splice(0)) native.onMessage.emit(frame);
  const [accepted, stopped] = await Promise.all([prompt, stopResponse]);
  assert.equal(accepted.disposition, 'queued');
  assert.equal(stopped.runtime.running, false);
  assert.deepEqual(calls.map(call => call.action), ['run_started', 'submit', 'stop']);
  assert.deepEqual(acceptedFollowUps, ['image-followup'], 'accepted follow-ups retain the existing stop semantics');
  assert.equal(original.cancelled, true);
  assert.equal(agentSequence, 1, 'upload completion must not start a fresh run after stop');
});

test("window delivery reports a failed native send so its caller can remember and retry", async t => {
  const runtime = { onConnect: event() }, channel = createSidepanelChannel();
  const unregister = channel.register(runtime, async () => {});
  t.after(unregister);
  const makePort = () => ({ name: 'sidepanel', sent: [], fail: false, onMessage: event(), onDisconnect: event(),
    postMessage(message) { if (this.fail) throw new Error('Port disconnected'); this.sent.push(message); },
    disconnect() { this.onDisconnect.emit(); },
  });
  const old = makePort(); runtime.onConnect.emit(old);
  old.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  old.fail = true;
  const reveal = { type: 'session_reveal_requested', sessionId: 's' };
  assert.equal(await channel.sendToWindow(1, reveal), false);
  channel.remember('reveal', reveal, 1000, { windowId: 1 });
  const fresh = makePort(); runtime.onConnect.emit(fresh);
  fresh.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  await until(() => fresh.sent.some(message => message.type === reveal.type));
  assert.deepEqual(fresh.sent, [reveal]);
});

test("failed queued pending delivery survives disconnect and repeated attach does not duplicate it", async t => {
  const fixture = channelFixture(t);
  fixture.channel.broadcast({ type: 'messages', text: 'x'.repeat(MESSAGE_FRAME_BYTES) });
  await until(() => fixture.held.length);
  const reveal = { type: 'session_reveal_requested', sessionId: 's' };
  fixture.channel.remember('pending', reveal, 1000, { windowId: 1 });
  for (let count = 0; count < 3; count++) fixture.native.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  const delivery = fixture.channel.sendToWindow(1, { type: 'queued_reveal' });
  fixture.native.disconnect(); fixture.peer.dispose();
  assert.equal(await delivery, false);
  await new Promise(resolve => setTimeout(resolve, 0));
  const fresh = { name: 'sidepanel', sent: [], onMessage: event(), onDisconnect: event(),
    postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } };
  fixture.runtime.onConnect.emit(fresh);
  fresh.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  fresh.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(fresh.sent, [reveal]);
});

test("completion of an older pending event never clears its replacement", async t => {
  const fixture = channelFixture(t);
  fixture.channel.broadcast({ type: 'messages', text: 'x'.repeat(MESSAGE_FRAME_BYTES) });
  await until(() => fixture.held.length);
  fixture.channel.remember('pending', { type: 'session_reveal_requested', sessionId: 'old' }, 1000, { windowId: 1 });
  fixture.native.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  fixture.native.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  fixture.channel.remember('pending', { type: 'session_reveal_requested', sessionId: 'new' }, 1000, { windowId: 1 });
  fixture.release();
  await until(() => fixture.received.some(message => message.sessionId === 'old'));
  assert.equal(fixture.received.filter(message => message.sessionId === 'old').length, 1);
  fixture.native.onMessage.emit({ type: 'sidepanel_attach', windowId: 1 });
  await until(() => fixture.received.some(message => message.sessionId === 'new'));
  assert.deepEqual(fixture.received.filter(message => message.type === 'session_reveal_requested').map(message => message.sessionId), ['old', 'new']);
});

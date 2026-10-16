import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForTask } from "../../services/mcp-bridge/src/task-stream.mjs";

const assistant = (content, extra = {}) => ({ type: "assistant", runId: "run-1", spanId: "answer-1", content, streaming: true, ...extra });
const snapshot = (status, transcript = [], extra = {}) => ({ sessionId: "session-1", status,
  runId: status === "idle" ? null : "run-1", runtime: { status }, transcript, ...extra });

function controlledClock(t) {
  let now = 1000;
  const timers = new Set();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    const timer = { callback, deadline: now + milliseconds };
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => timers.delete(timer));
  return { timers, advance: milliseconds => { now += milliseconds; },
    fireNext() {
      const timer = [...timers].sort((a, b) => a.deadline - b.deadline)[0];
      assert.ok(timer, "a pending deadline must exist");
      timers.delete(timer);
      now = Math.max(now, timer.deadline);
      timer.callback();
    },
  };
}

for (const [name, total, request, expectedName, timerCount] of [
  ["total deadline first", 0.02, 1, "TimeoutError", 1],
  ["request deadline first", 1, 0.02, "Error", 2],
  ["equal deadlines belong to total", 0.02, 0.02, "TimeoutError", 1],
  ["unlimited observation", null, 0.02, "Error", 1],
]) {
  test(`controlled observation deadlines: ${name}`, async t => {
    const clock = controlledClock(t);
    let read, calls = 0;
    const outcome = waitForTask({ sessionId: "session-1", timeoutSeconds: total, requestTimeoutSeconds: request,
      getSnapshot(value) {
        calls++;
        read = value;
        // Delay rejection handling beyond both deadlines: the first reason must survive.
        read.signal.addEventListener("abort", () => clock.advance(2000), { once: true });
        return new Promise(() => {});
      },
    }).then(() => assert.fail("a hung read must time out"), error => error);
    await Promise.resolve();
    assert.equal(read.timeoutSeconds, request, "downstream keeps its independent request budget");
    assert.equal(clock.timers.size, timerCount, "equal or later request deadlines must not compete with total");
    clock.fireNext();
    const error = await outcome;
    assert.equal(error.name, expectedName);
    assert.equal(error, read.signal.reason, "the caller and downstream observe the identical cancellation");
    if (expectedName === "Error") assert.equal(error.code, "request_timeout");
    assert.equal(calls, 1, "observation cannot replay or cancel a task");
    assert.equal(clock.timers.size, 0, "all observation timers are cleared");
  });
}

test("external cancellation owns the request reason and clears both deadlines", async t => {
  const clock = controlledClock(t);
  const controller = new AbortController();
  const reason = new DOMException("Stopped watching", "AbortError");
  let read;
  const outcome = waitForTask({ sessionId: "session-1", timeoutSeconds: 1, requestTimeoutSeconds: 0.02,
    signal: controller.signal, getSnapshot(value) { read = value; return new Promise(() => {}); },
  }).catch(error => error);
  await Promise.resolve();
  clock.advance(10);
  controller.abort(reason);
  assert.equal(await outcome, reason);
  assert.equal(read.signal.reason, reason);
  assert.equal(clock.timers.size, 0);
});

for (const settle of ["resolve", "reject"]) {
  test(`a synchronous ${settle} after both deadlines still attributes the earlier request timeout`, async t => {
    const clock = controlledClock(t);
    let read;
    await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.1, requestTimeoutSeconds: 0.02,
      getSnapshot(value) {
        read = value;
        clock.advance(200);
        if (settle === "reject") throw new Error("late transport failure");
        return snapshot("completed");
      },
    }), error => error.code === "request_timeout" && error === read.signal.reason);
    assert.equal(clock.timers.size, 0);
  });
}

test("successful observation clears its total and request deadlines", async t => {
  const clock = controlledClock(t);
  let read;
  const result = await waitForTask({ sessionId: "session-1", timeoutSeconds: 1, requestTimeoutSeconds: 0.02,
    getSnapshot(value) { read = value; return snapshot("completed"); },
  });
  assert.equal(result.status, "completed");
  assert.equal(clock.timers.size, 0);
  clock.advance(2000);
  assert.equal(read.signal.aborted, false);
});

async function sequence(snapshots, options = {}) {
  const updates = [];
  let calls = 0;
  const result = await waitForTask({ sessionId: "session-1", timeoutSeconds: 1, pollIntervalMs: 0,
    getSnapshot: async request => {
      assert.equal(request.sessionId, "session-1");
      assert.ok(request.signal instanceof AbortSignal);
      assert.ok(request.timeoutSeconds > 0);
      assert.ok(calls < snapshots.length, "polling must stop at the expected snapshot");
      return snapshots[calls++];
    }, onUpdate: update => updates.push(update), ...options });
  return { result, updates, calls };
}

test("streams live assistant deltas across tool interleaving without repeating text", async () => {
  const tool = { type: "tool", toolCallId: "tool-1", result: "do not print script output" };
  const thinking = { type: "thinking", text: "do not print thinking" };
  const done = snapshot("completed", [thinking, assistant("Hello", { streaming: false }), tool,
    assistant("World", { spanId: "answer-2", streaming: false })]);
  const { result, updates, calls } = await sequence([
    snapshot("idle"), snapshot("running", [thinking, assistant("")]), snapshot("running", [thinking, assistant("H")]),
    snapshot("running", [thinking, assistant("Hel")]), snapshot("running", [thinking, assistant("Hello"), tool]),
    snapshot("running", [thinking, assistant("Hello"), tool, assistant("Wor", { spanId: "answer-2" })]), done,
  ]);
  assert.equal(result, done);
  assert.equal(calls, 7);
  const texts = updates.filter(update => update.type === "text");
  assert.deepEqual(texts.map(update => update.text), ["H", "el", "lo", "Wor", "ld"]);
  assert.deepEqual(texts.map(update => update.newMessage), [true, false, false, true, false]);
  assert.deepEqual(updates.filter(update => update.type === "status").map(update => update.status), ["idle", "running", "completed"]);
});

test("a final snapshot arriving before the first poll still emits its complete answer", async () => {
  const done = snapshot("completed", [assistant("Fast answer", { streaming: false })]);
  const { result, updates, calls } = await sequence([done]);
  assert.equal(calls, 1);
  assert.equal(result, done);
  assert.deepEqual(updates.filter(update => update.type === "text").map(update => update.text), ["Fast answer"]);
});

test("queued messages expose preceding input but wait for their own user message and run", async () => {
  const user = { type: "user", clientMessageId: "message-2", runId: "run-2", content: "Add sources." };
  const waiting = snapshot("waiting_user", [assistant("Earlier question")], {
    input: { waiting: true, waitId: "old-question", form: { fields: [{ id: "city", type: "text" }] } },
    runtime: { waitId: "old-question" },
  });
  const oldDone = snapshot("completed", [assistant("Earlier answer", { streaming: false })]);
  const newDone = snapshot("completed", [assistant("Earlier answer", { streaming: false }), user,
    assistant("New answer", { runId: "run-2", streaming: false })], { runId: "run-2" });
  const { result, calls, updates } = await sequence([waiting, waiting, oldDone,
    snapshot("running", [user, assistant("New", { runId: "run-2" })], { runId: "run-2" }), newDone],
  { expectedMessageId: "message-2" });
  assert.equal(result, newDone); assert.equal(calls, 5);
  assert.deepEqual(updates.filter(item => item.type === "input").map(item => item.waitId), ["old-question"]);
  assert.deepEqual(updates.filter(item => item.type === "text").map(item => item.text), ["New", " answer"]);
  assert.deepEqual(updates.filter(item => item.type === "status").map(item => item.status), ["waiting_user", "running", "completed"]);
});

test("message tracking handles immediate completion and a transcript arriving before matching runtime", async () => {
  const user = { type: "user", clientMessageId: "message-2", runId: "run-2" };
  const done = snapshot("completed", [user, assistant("Quick answer", { runId: "run-2", streaming: false })], { runId: "run-2" });
  const immediate = await sequence([done], { expectedMessageId: "message-2" });
  assert.equal(immediate.result, done); assert.equal(immediate.calls, 1);
  assert.equal(immediate.updates.find(item => item.type === "text").text, "Quick answer");
  const delayed = await sequence([snapshot("completed", [user]), done], { expectedMessageId: "message-2" });
  assert.equal(delayed.result, done); assert.equal(delayed.calls, 2);
  assert.ok(delayed.updates.every(item => item.runId === "run-2"));
});

test("same-run steering streams only assistant entries after the submitted message", async () => {
  const prior = assistant("Prior context before steering.", { spanId: "prior", streaming: false });
  const user = { type: "user", clientMessageId: "steer-message", runId: "run-1", content: "Focus on sources." };
  const waiting = snapshot("waiting_user", [prior], { input: { waiting: true, waitId: "question", form: { fields: [] } } });
  const done = snapshot("completed", [prior, user, assistant("Sources checked.", { streaming: false })]);
  const { result, updates } = await sequence([waiting, waiting,
    snapshot("running", [prior, user, assistant("Sources")]), done], { expectedMessageId: "steer-message" });
  assert.equal(result, done);
  assert.deepEqual(updates.filter(event => event.type === "text").map(event => event.text), ["Sources", " checked."]);
  assert.deepEqual(updates.filter(event => event.type === "input").map(event => event.waitId), ["question"]);
  const immediate = await sequence([done], { expectedMessageId: "steer-message" });
  assert.deepEqual(immediate.updates.filter(event => event.type === "text").map(event => event.text), ["Sources checked."]);
});

test("queued observation remains cancellable and stops if the preceding task is aborted or deleted", async () => {
  for (const status of ["aborted", "cancelled", "interrupted", "error"]) {
    const stopped = snapshot(status);
    assert.equal((await sequence([stopped], { expectedMessageId: "message-2" })).result, stopped);
  }
  await assert.rejects(sequence([{ session: null }], { expectedMessageId: "message-2" }), error => error.code === "task_deleted");
  const controller = new AbortController();
  await assert.rejects(sequence([snapshot("waiting_user", [], { runtime: { waitId: "old-question" } })], {
    expectedMessageId: "message-2", signal: controller.signal,
    onUpdate: event => { if (event.type === "input") controller.abort(); },
  }), error => error.name === "AbortError");
});

test("default and null total deadlines allow long tasks and user pauses while reads stay bounded", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const total of [undefined, null]) {
    let calls = 0;
    const updates = [];
    const waiting = snapshot("waiting_user", [], { runtime: { waitId: "permission", waitForm: { browserPermission: "history" } } });
    const snapshots = [snapshot("running"), waiting, waiting, snapshot("running"), snapshot("completed")];
    const result = await waitForTask({ sessionId: "session-1", timeoutSeconds: total, pollIntervalMs: 0,
      onUpdate: event => updates.push(event), getSnapshot: request => {
        assert.equal(request.timeoutSeconds, 180, "each request has its own finite budget");
        assert.equal(JSON.parse(JSON.stringify({ timeoutSeconds: request.timeoutSeconds })).timeoutSeconds, 180);
        assert.equal(request.signal.aborted, false);
        now += 120_000;
        assert.ok(calls < snapshots.length);
        return snapshots[calls++];
      } });
    assert.equal(result.status, "completed");
    assert.equal(calls, 5);
    assert.equal(updates.filter(event => event.type === "input").length, 1);
    assert.deepEqual(updates.filter(event => event.type === "status").map(event => event.status),
      ["running", "waiting_user", "running", "completed"]);
  }
});

test("an unlimited watch still aborts a hung snapshot with a distinct request timeout", async () => {
  let calls = 0, requestSignal;
  await assert.rejects(waitForTask({ sessionId: "session-1", requestTimeoutSeconds: 0.03,
    getSnapshot(request) {
      calls++;
      assert.equal(request.timeoutSeconds, 0.03);
      requestSignal = request.signal;
      return new Promise(() => {});
    },
  }), error => {
    assert.equal(error.code, "request_timeout");
    assert.notEqual(error.name, "TimeoutError");
    assert.match(error.message, /Reading task session-1 timed out.*browser connection.*resume watching/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.code, "request_timeout");
});

test("each snapshot gets a fresh request deadline and completed requests leave no timeout behind", async () => {
  let calls = 0;
  const signals = [];
  const result = await waitForTask({ sessionId: "session-1", requestTimeoutSeconds: 0.2, pollIntervalMs: 160,
    getSnapshot: async request => {
      signals.push(request.signal);
      assert.equal(request.timeoutSeconds, 0.2);
      await new Promise(resolve => setTimeout(resolve, 30));
      return snapshot(++calls === 2 ? "completed" : "running");
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.ok(signals.every(signal => !signal.aborted), "cleared request timers cannot abort later polls");
});

test("caller abort and explicit total deadline take priority over a simultaneous request timeout", async () => {
  let signal;
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.02, requestTimeoutSeconds: 1,
    getSnapshot(request) { signal = request.signal; return new Promise(() => {}); },
  }), error => error.name === "TimeoutError" && error.code !== "request_timeout");
  assert.equal(signal.reason.name, "TimeoutError");

  const controller = new AbortController();
  const reason = new DOMException("User stopped watching.", "AbortError");
  await assert.rejects(waitForTask({ sessionId: "session-1", signal: controller.signal, requestTimeoutSeconds: 0.02,
    getSnapshot(request) {
      signal = request.signal;
      controller.abort(reason);
      return new Promise(() => {});
    },
  }), error => error === reason);
  assert.equal(signal.reason, reason);
});

test("unlimited watching remains cancellable while waiting for user input", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(waitForTask({ sessionId: "session-1", signal: controller.signal, pollIntervalMs: 1000,
    getSnapshot() { calls++; return snapshot("waiting_user", [], { runtime: { waitId: "form" } }); },
    onUpdate(event) { if (event.type === "input") controller.abort(); },
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("only a null total deadline is unlimited; request deadlines must be finite and positive", async () => {
  for (const value of [0, -1, NaN, Infinity, "180"]) {
    await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: value,
      getSnapshot() { assert.fail("invalid timeout issued a read"); },
    }), TypeError);
  }
  for (const value of [null, 0, -1, NaN, Infinity, "180"]) {
    await assert.rejects(waitForTask({ sessionId: "session-1", requestTimeoutSeconds: value,
      getSnapshot() { assert.fail("invalid request timeout issued a read"); },
    }), TypeError);
  }
});

test("an unlimited watch rejects snapshots without a status after one read", async () => {
  for (const response of [null, {}, { status: "   " }, { runtime: { status: "" } }]) {
    let calls = 0, updates = 0;
    await assert.rejects(waitForTask({ sessionId: "session-1", pollIntervalMs: 0,
      getSnapshot() {
        assert.equal(++calls, 1, "malformed responses must not be polled repeatedly");
        return response;
      }, onUpdate() { updates++; },
    }), error => error.code === "invalid_response" && /no status/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(updates, 0);
  }
});

test("nonempty future status values remain observable and deletion keeps its specific failure", async () => {
  const done = snapshot("completed");
  const { updates, result } = await sequence([snapshot("reconnecting"), done], { timeoutSeconds: null });
  assert.equal(result, done);
  assert.equal(updates[0].status, "reconnecting");
  await assert.rejects(waitForTask({ sessionId: "session-1", getSnapshot: () => ({ session: null }) }),
    error => error.code === "task_deleted");
});

test("resuming ignores the just-submitted wait and keeps observing through the next question", async () => {
  const old = snapshot("waiting_user", [assistant("Old question")], { runtime: { waitId: "old-wait" } });
  const next = snapshot("waiting_user", [assistant("Next question")], { runtime: { waitId: "next-wait" } });
  const done = snapshot("completed", [assistant("Done")]);
  const { result, calls, updates } = await sequence([old, old, snapshot("running"), next, next, done], { ignoreWaitId: "old-wait", expectedRunId: "run-1" });
  assert.equal(result, done);
  assert.equal(calls, 6);
  assert.deepEqual(updates.filter(event => event.type === "status").map(event => event.waitId), ["", "next-wait", ""]);
  assert.deepEqual(updates.filter(event => event.type === "input").map(event => event.waitId), ["next-wait"]);
  assert.ok(!updates.some(event => event.fullText === "Old question"));
  const direct = await sequence([old, next, done], { ignoreWaitId: "old-wait" });
  assert.equal(direct.result, done);
});

test("a resumed task can finish before running is observed; watching an idle task ends promptly", async () => {
  const old = snapshot("waiting_user", [], { runtime: { waitId: "old-wait" } });
  const done = snapshot("completed", [assistant("Done")]);
  assert.equal((await sequence([old, done], { ignoreWaitId: "old-wait" })).result, done);
  const idle = snapshot("idle");
  assert.equal((await sequence([idle], { allowIdle: true })).result, idle);
});

test("a persistent stale wait times out rather than falsely reporting a new request", async () => {
  let emitted = 0;
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.03, pollIntervalMs: 100,
    ignoreWaitId: "old-wait", getSnapshot: () => snapshot("waiting_user", [], { runtime: { waitId: "old-wait" } }),
    onUpdate: () => emitted++,
  }), error => error.name === "TimeoutError");
  assert.equal(emitted, 0);
});

test("text revisions produce replace events, including clearing text", async () => {
  const { updates } = await sequence([
    snapshot("running", [assistant("draft text")]), snapshot("running", [assistant("corrected")]),
    snapshot("running", [assistant("")]), snapshot("completed", [assistant("Final", { streaming: false })]),
  ]);
  assert.deepEqual(updates.filter(update => update.type !== "status").map(({ type, text }) => ({ type, text })), [
    { type: "text", text: "draft text" }, { type: "replace", text: "corrected" },
    { type: "replace", text: "" }, { type: "text", text: "Final" },
  ]);
  assert.equal(updates.at(-1).newMessage, false);
});

test("failure, cancellation and interruption return the real snapshot promptly", async () => {
  for (const status of ["error", "failed", "aborted", "cancelled", "interrupted"]) {
    const end = snapshot(status, [], { runtime: { status, waitTitle: "Choose a destination", waitMessage: "Open the qz panel", waitId: "wait-1" } });
    const { result, calls, updates } = await sequence([snapshot("pending"), end]);
    assert.equal(calls, 2);
    assert.equal(result, end);
    assert.equal(updates.at(-1).status, status);
    assert.equal(updates.at(-1).waitMessage, "Open the qz panel");
  }
});

test("previous/expected run IDs ignore stale completed state and old assistant messages", async () => {
  const old = assistant("Old answer", { runId: "run-old", streaming: false });
  const done = snapshot("completed", [old, assistant("New answer", { streaming: false })]);
  const { result, updates } = await sequence([
    snapshot("completed", [old], { runId: "run-old" }), snapshot("idle", [old]),
    snapshot("running", [old, assistant("New")]), done,
  ], { previousRunId: "run-old", expectedRunId: "run-1" });
  assert.equal(result, done);
  assert.deepEqual(updates.filter(update => update.type === "text").map(update => update.text), ["New", " answer"]);
});

test("structured assistant text excludes image/thinking blocks and deduplicates stable event identities", async () => {
  const first = { type: "assistant", runId: "run-1", eventSeq: 3, content: [{ type: "text", text: "Hello" }, { type: "thinking", text: "hidden" }] };
  const final = { ...first, content: [{ type: "text", text: "Hello" }, { type: "text", text: "world" }, { type: "image", data: "hidden" }] };
  const { updates } = await sequence([snapshot("running", [first]), snapshot("completed", [{ type: "tool" }, final])]);
  assert.deepEqual(updates.filter(update => update.type === "text").map(update => update.text), ["Hello", "\nworld"]);
});

test("timeout interrupts a hung snapshot and does not retry or cancel the browser task", async () => {
  let calls = 0;
  let observedSignal;
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.03,
    getSnapshot({ signal }) { calls++; observedSignal = signal; return new Promise(() => {}); },
  }), error => error.name === "TimeoutError");
  assert.equal(calls, 1);
  assert.equal(observedSignal.aborted, true);
});

test("caller abort interrupts polling sleeps without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 1, pollIntervalMs: 1000,
    signal: controller.signal, getSnapshot() { calls++; return snapshot("running"); },
    onUpdate() { setTimeout(() => controller.abort(), 10); },
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
});

test("deadline during a polling sleep remains a TimeoutError and sends no extra read", async () => {
  let calls = 0;
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.03, pollIntervalMs: 1000,
    getSnapshot() { calls++; return snapshot("running"); },
  }), error => error.name === "TimeoutError");
  assert.equal(calls, 1);
});

test("snapshot failures propagate once and never repeat task mutations", async () => {
  let calls = 0;
  const failure = Object.assign(new Error("The bridge disconnected"), { code: "not_connected" });
  await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 1, getSnapshot() { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 1);
});

test("a different Session or replacement run cannot be mistaken for the watched task", async () => {
  await assert.rejects(sequence([snapshot("running", [], { sessionId: "other" })]), error => error.code === "task_changed");
  await assert.rejects(sequence([snapshot("running"), snapshot("completed", [], { runId: "run-2" })]), error => error.code === "task_changed");
  await assert.rejects(sequence([snapshot("running"), snapshot("completed", [], { runId: "run-2" })], { expectedRunId: "run-1" }), error => error.code === "task_changed");
});

test("a deleted Session fails immediately before or after observing its active run", async () => {
  for (const preceding of [[], [snapshot("running")]]) {
    const snapshots = [...preceding, snapshot("idle", [], { session: null })];
    const updates = [];
    let calls = 0;
    await assert.rejects(waitForTask({ sessionId: "session-1", expectedRunId: "run-1", timeoutSeconds: 1,
      pollIntervalMs: 0, onUpdate: update => updates.push(update),
      getSnapshot() {
        assert.ok(calls < snapshots.length, "deletion must not trigger another poll");
        return snapshots[calls++];
      },
    }), error => error.code === "task_deleted");
    assert.equal(calls, snapshots.length);
    assert.ok(!updates.some(update => update.status === "idle"), "deletion must not look like successful idle completion");
  }
});

test("an already aborted caller cannot issue even the first snapshot request", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(waitForTask({ sessionId: "session-1", signal,
    getSnapshot() { assert.fail("read after caller cancellation"); },
  }), error => error.name === "AbortError");
});


test("form and native permission waits stay active, emit each input once and resume the same run", async () => {
  const form = { fields: [{ id: "choice", type: "single_choice", options: [{ value: "a", label: "Alpha" }] }] };
  const waiting = snapshot("waiting_user", [assistant("Choose a value")], {
    runtime: { waitId: "w1", waitTitle: "Choose", waitMessage: "Pick one", waitForm: form },
  });
  const permission = snapshot("waiting_user", [assistant("Choose a value"), assistant("Allow history", { spanId: "permission" })], {
    runtime: { waitId: "w2", waitTitle: "History", waitMessage: "Approve in Chrome", waitForm: { browserPermission: "history" } },
  });
  const done = snapshot("completed", [assistant("Choose a value"), assistant("Allow history", { spanId: "permission" }), assistant("Finished", { spanId: "result" })]);
  const { result, updates, calls } = await sequence([waiting, waiting, snapshot("running", waiting.transcript), permission, permission, done]);
  assert.equal(result, done);
  assert.equal(calls, 6);
  const inputs = updates.filter(event => event.type === "input");
  assert.deepEqual(inputs.map(event => event.waitId), ["w1", "w2"]);
  assert.deepEqual(inputs[0].form, form);
  assert.equal(inputs[1].kind, "browser_permission");
  assert.equal(inputs[1].requiresUserAction, true);
  assert.deepEqual(updates.filter(event => event.type === "text").map(event => event.text), ["Choose a value", "Allow history", "Finished"]);
});

test("watching an existing pause also stays alive until the user resumes", async () => {
  const paused = snapshot("paused", [], { runtime: { waitId: "manual", waitMessage: "Resume in qz" } });
  const done = snapshot("completed");
  const { result, updates } = await sequence([paused, paused, snapshot("running"), done], { allowIdle: true });
  assert.equal(result, done);
  assert.equal(updates.filter(event => event.type === "input").length, 1);
});

test("changed questions are reported without repeatedly printing an unchanged wait", async () => {
  const first = snapshot("waiting_user", [], { runtime: { waitId: "w1", waitForm: { fields: [{ id: "name", label: "Name" }] } } });
  const changed = snapshot("waiting_user", [], { runtime: { ...first.runtime, waitForm: { fields: [{ id: "name", label: "Full name" }] } } });
  const { updates } = await sequence([first, first, changed, changed, snapshot("completed")]);
  assert.deepEqual(updates.filter(event => event.type === "input").map(event => event.form.fields[0].label), ["Name", "Full name"]);
});

test("canonical pending input retains response templates and current identity instead of stale runtime data", async () => {
  const input = { sessionId: "session-1", runId: "run-1", waitId: "current", waiting: true, kind: "form",
    title: "Current question", form: { fields: [{ id: "city", type: "single_choice", required: true,
      options: [{ value: "hz", label: "Hangzhou" }] }] }, actions: ["submit", "reject"],
    responseTemplate: { sessionId: "session-1", waitId: "current", action: "submit", answers: { city: "<option value>" } } };
  const current = snapshot("waiting_user", [], { input, runtime: { waitId: "old", waitTitle: "Stale question", waitForm: {} } });
  const changed = { ...current, input: { ...input, responseTemplate: { ...input.responseTemplate, answers: { city: "hz" } } } };
  const { updates } = await sequence([current, current, changed, changed, snapshot("completed")],
    { clientId: "browser-profile", ignoreWaitId: "old" });
  const inputs = updates.filter(event => event.type === "input");
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], { ...input, type: "input", clientId: "browser-profile" });
  assert.deepEqual(inputs[1].responseTemplate.answers, { city: "hz" });
  assert.ok(!JSON.stringify(inputs).includes("Stale question"));
});

test("a canonical cleared input prevents re-showing a stale runtime form", async () => {
  const cleared = snapshot("waiting_user", [], { input: { sessionId: "session-1", waiting: false },
    runtime: { waitId: "stale", waitTitle: "Already answered", waitForm: { fields: [{ id: "old" }] } } });
  const { updates } = await sequence([cleared, snapshot("completed")]);
  assert.equal(updates.filter(event => event.type === "input").length, 0);
});

test("timeout and Ctrl-C while waiting stop observation without answering or cancelling", async () => {
  for (const interrupt of [false, true]) {
    const controller = new AbortController();
    let calls = 0, inputs = 0;
    await assert.rejects(waitForTask({ sessionId: "session-1", timeoutSeconds: 0.03, pollIntervalMs: 1000,
      signal: controller.signal,
      getSnapshot() { calls++; return snapshot("waiting_user", [], { runtime: { waitId: "w1" } }); },
      onUpdate(event) { if (event.type === "input") { inputs++; if (interrupt) controller.abort(); } },
    }), error => error.name === (interrupt ? "AbortError" : "TimeoutError"));
    assert.equal(calls, 1);
    assert.equal(inputs, 1);
  }
});

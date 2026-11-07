import assert from "node:assert/strict";
import test from "node:test";
import { waitForElementReady } from "../../src/capabilities/page/element-readiness.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
const target = "css:#submit";
const ready = reply => reply.disabled ? "element is disabled" : undefined;
const rect = x => ({ x, y: 0, width: 20, height: 10 });

test("readiness waits for a missing and disabled control, then stable geometry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const observations = [
    { code: "ELEMENT_NOT_FOUND", message: "Missing" },
    { disabled: true, rect: rect(0) },
    { disabled: false, rect: rect(0) },
    { disabled: false, rect: rect(10) },
    { disabled: false, rect: rect(10) },
  ];
  let reads = 0, preparations = 0, settled = false;
  const pending = waitForElementReady({ target, deadline: 2000, stable: true,
    inspect: async () => observations[reads++], readiness: ready,
    prepare: async reply => { preparations++; return reply; },
  }).then(value => { settled = true; return value; });
  await flush();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(50);
    await flush();
    assert.equal(settled, false);
  }
  t.mock.timers.tick(50);
  assert.deepEqual(await pending, observations[4]);
  assert.equal(reads, 5);
  assert.equal(preparations, 1);
});

test("the absolute deadline is not extended by preparation or repeated observations", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let reads = 0;
  const pending = waitForElementReady({ target, deadline: 1120,
    inspect: async () => { reads++; return { disabled: true }; },
    prepare: async reply => { t.mock.timers.tick(70); return reply; }, readiness: ready,
  });
  const rejected = assert.rejects(pending, error => error.code === "ELEMENT_NOT_READY"
    && error.details.target === target && error.details.reason === "element is disabled");
  await flush();
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(reads, 1);
});

test("cancellation during readiness stops polling and preserves the cancellation reason", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const controller = new AbortController();
  const reason = Object.assign(new Error("Stopped"), { code: "OPERATION_ABORTED" });
  let reads = 0;
  const pending = waitForElementReady({ target, signal: controller.signal,
    inspect: async () => { reads++; return { disabled: true }; }, readiness: ready,
  });
  const rejected = assert.rejects(pending, error => error === reason);
  await flush();
  controller.abort(reason);
  await rejected;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 1);
});

test("stale UIDs and invalid target errors are not retried", async () => {
  const stale = Object.assign(new Error("Stale"), { code: "STALE_ELEMENT_UID" });
  let reads = 0;
  await assert.rejects(waitForElementReady({ target: "uid:t1.s1.1", readiness: ready,
    inspect: async () => { reads++; throw stale; },
  }), error => error === stale);
  assert.equal(reads, 1);
  const invalid = { code: "INVALID_SELECTOR", message: "Invalid CSS" };
  assert.equal(await waitForElementReady({ target, readiness: ready, inspect: async () => invalid }), invalid);
});

test("an abort while inspecting cannot return a ready element", async () => {
  const controller = new AbortController();
  const reason = new Error("Stopped during inspection");
  await assert.rejects(waitForElementReady({ target, signal: controller.signal, readiness: ready,
    inspect: async () => { controller.abort(reason); return { disabled: false }; },
  }), error => error === reason);
});

test("pointer confirmation waits again after a new overlay and moved geometry, within the original deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let moved = false, confirms = 0;
  const pending = waitForElementReady({ target, deadline: 1500, stable: true, readiness: ready,
    inspect: async () => ({ rect: rect(moved ? 40 : 0), disabled: false }),
    confirm: async observed => { confirms++; moved = true; return confirms === 1 ? { rect: rect(40), disabled: true } : observed; },
  });
  await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(50); await flush(); }
  assert.deepEqual(await pending, { rect: rect(40), disabled: false });
  assert.equal(confirms, 2);
});

test("readiness defaults to one five-second budget", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const pending = waitForElementReady({ target, inspect: async () => ({ disabled: true }), readiness: ready });
  const rejected = assert.rejects(pending, { code: "ELEMENT_NOT_READY" });
  await flush();
  t.mock.timers.tick(5000);
  await rejected;
});

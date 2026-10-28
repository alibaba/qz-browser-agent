import assert from "node:assert/strict";
import test from "node:test";
import { createPageModeRuntime } from "../../src/capabilities/tabs/page-mode.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

const context = { sessionId: "owner", runId: "run" };
function fixture() {
  const calls = [], removed = [], connections = new Map();
  const physical = { mode: "desktop", touch: false, ua: "", loader: 1, retained: false };
  let sequence = 0, fail = "", hook = async () => {}, releaseCount = 0, restore, beforeDebugger = async () => {};
  globalThis.chrome = { tabs: { onRemoved: { addListener: fn => removed.push(fn) } } };
  const send = async (method, params = {}) => {
    calls.push([method, params]);
    await hook(method, params);
    if (method === fail) { fail = ""; throw new Error("injected failure"); }
    if (method === "Runtime.evaluate") return { result: { value: "Chrome/149.0.0.0" } };
    if (method === "Emulation.setUserAgentOverride") physical.ua = params.userAgent;
    if (method === "Emulation.setTouchEmulationEnabled") physical.touch = params.enabled;
    if (method === "Emulation.setDeviceMetricsOverride") physical.mode = "mobile";
    if (method === "Emulation.clearDeviceMetricsOverride") physical.mode = "desktop";
    if (method === "Page.reload") physical.loader++;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: String(physical.loader) } } };
    return {};
  };
  const runtime = createPageModeRuntime({ ToolExecutionError,
    getDebuggerConnectionId: tabId => connections.get(tabId) ?? null,
    setDebuggerRetention(_tabId, retained, _context, callback) { physical.retained = retained; restore = callback; },
    async withDebugger(tabId, fn) {
      await beforeDebugger();
      if (!connections.has(tabId)) connections.set(tabId, ++sequence);
      return fn({ tabId }, send);
    },
    async releaseDebugger(tabId) { releaseCount++; connections.delete(tabId); physical.mode = "desktop"; },
  });
  return { runtime, calls, physical, connections, removed,
    async restore(tabId) { connections.set(tabId, ++sequence); await restore(send); },
    beforeDebugger: fn => { beforeDebugger = fn; },
    fail: method => { fail = method; }, hook: fn => { hook = fn; }, released: () => releaseCount,
    reloads: () => calls.filter(([method]) => method === "Page.reload").length };
}

test("target recovery restores mobile configuration and identity without reloading", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context);
  const connection = f.connections.get(1);
  const reloads = f.reloads();
  f.physical.mode = "desktop";
  f.physical.touch = false;
  await f.restore(1);
  assert.notEqual(f.connections.get(1), connection);
  assert.deepEqual(f.runtime.describePage(1), { pageMode: "mobile" });
  assert.equal(f.physical.mode, "mobile");
  assert.equal(f.physical.touch, true);
  await f.runtime.preparePage(1, "act_on_element", undefined, context);
  assert.equal(f.reloads(), reloads, "the next page action must not reload a recovered page");
});

test("explicit desktop mode wins over an in-flight mobile recovery", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context);
  f.connections.delete(1);
  f.beforeDebugger(async () => { await f.restore(1); });
  const result = await f.runtime.change(1, "desktop", undefined, context);
  assert.equal(result.changed, true);
  assert.equal(f.physical.mode, "desktop");
  assert.equal(f.physical.retained, false);
  assert.deepEqual(f.runtime.describePage(1), { pageMode: "desktop" });
});

test("mobile applies coherent UA, client hints, viewport and touch before reload; repeated modes are no-ops", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.change(1, "desktop", undefined, context), { tabId: 1, pageMode: "desktop", changed: false, reloaded: false });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.change(1, "mobile", undefined, context)).reloaded, true);
  assert.equal(f.physical.mode, "mobile"); assert.equal(f.physical.touch, true);
  assert.equal(f.physical.retained, true);
  const ua = f.calls.find(([name]) => name === "Emulation.setUserAgentOverride")[1];
  assert.match(ua.userAgent, /Android.*Chrome\/149.0.0.0 Mobile/);
  assert.equal(ua.userAgentMetadata.mobile, true);
  assert.equal(ua.userAgentMetadata.platform, "Android");
  assert.equal(f.calls.find(([name]) => name === "Emulation.setDeviceMetricsOverride")[1].width, 412);
  const count = f.calls.length;
  assert.equal((await f.runtime.change(1, "mobile", undefined, context)).changed, false);
  assert.equal(f.calls.length, count);
  assert.equal((await f.runtime.change(1, "desktop", undefined, context)).reloaded, true);
  assert.equal(f.physical.mode, "desktop"); assert.equal(f.physical.ua, ""); assert.equal(f.physical.touch, false);
  assert.equal(f.physical.retained, false);
  assert.equal(f.reloads(), 2);
});

test("opening a mobile page performs no reload before its first navigation", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context, false);
  assert.equal(f.reloads(), 0);
  assert.deepEqual(f.runtime.describePage(1), { pageMode: "mobile" });
});

for (const command of ["Emulation.setUserAgentOverride", "Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Page.reload"]) {
  test(`a failure at ${command} rolls back the physical mode`, async () => {
    const f = fixture(); f.fail(command);
    await assert.rejects(f.runtime.change(1, "mobile", undefined, context), { code: "PAGE_MODE_FAILED" });
    assert.equal(f.physical.mode, "desktop"); assert.equal(f.physical.touch, false); assert.equal(f.physical.ua, "");
    assert.deepEqual(f.runtime.describePage(1), { pageMode: "desktop" });
    await f.runtime.change(1, "mobile", undefined, context);
    assert.equal(f.runtime.describePage(1).pageMode, "mobile");
  });
}

test("cancellation during configuration rolls back; failed rollback retires the lease", async () => {
  for (const failRollback of [false, true]) {
    const f = fixture(), controller = new AbortController();
    f.hook(async method => {
      if (method === "Emulation.setDeviceMetricsOverride") controller.abort();
      if (failRollback && method === "Emulation.clearDeviceMetricsOverride") throw new Error("connection lost");
    });
    await assert.rejects(f.runtime.change(1, "mobile", controller.signal, context), { code: "OPERATION_ABORTED" });
    assert.equal(f.runtime.describePage(1).pageMode, "desktop");
    assert.equal(f.released(), failRollback ? 1 : 0);
  }
});

test("a released or reconnected lease never reports mobile; only the owning session restores it", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context);
  f.connections.delete(1);
  assert.equal(f.runtime.describePage(1).pageMode, "desktop");
  await f.runtime.preparePage(1, "read_dom", undefined, { sessionId: "other", runId: "other-run" });
  assert.equal(f.reloads(), 1);
  await assert.rejects(f.runtime.preparePage(1, "read_dom", undefined, { ...context, source: "run_script", senderTabId: 1 }),
    { code: "PAGE_MODE_REOBSERVE_REQUIRED" });
  await f.runtime.preparePage(1, "read_dom", undefined, { ...context, runId: "next" });
  assert.equal(f.runtime.describePage(1).pageMode, "mobile");
  assert.equal(f.reloads(), 2);
  assert.equal(f.runtime.describePage(2).pageMode, "desktop");
  f.connections.set(1, 99);
  assert.equal(f.runtime.describePage(1).pageMode, "desktop");
  await f.runtime.preparePage(1, "navigate", undefined, context);
  assert.equal(f.reloads(), 2, "navigation itself loads the page; restoration must not reload the old URL");
  f.connections.delete(1);
  await f.runtime.preparePage(1, "set_page_mode", undefined, context);
  await f.runtime.change(1, "desktop", undefined, context);
  await f.runtime.preparePage(1, "read_dom", undefined, context);
  assert.equal(f.runtime.describePage(1).pageMode, "desktop", "explicit desktop cancels the stored mobile preference");
});

test("parallel page observations never restore a disconnected mode or reload the document", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context);
  f.connections.delete(1);
  const before = f.calls.length;
  for (const name of ["read_article", "find_elements", "get_ax_tree"]) {
    await f.runtime.preparePage(1, name, undefined, { ...context, preserveWorkingTab: true });
  }
  assert.equal(f.calls.length, before);
  assert.equal(f.reloads(), 1);
  assert.equal(f.runtime.describePage(1).pageMode, "desktop");
  await f.runtime.preparePage(1, "read_article", undefined, context);
  assert.equal(f.reloads(), 2, "sequential reads retain the existing restoration behavior");
});

test("failed desktop switch preserves mobile; closed tabs discard their preference", async () => {
  const f = fixture();
  await f.runtime.change(1, "mobile", undefined, context);
  f.hook(async method => {
    if (method === "Emulation.clearDeviceMetricsOverride") assert.equal(f.physical.retained, false, "an interrupted transition must not park partial emulation");
  });
  f.fail("Emulation.setTouchEmulationEnabled");
  await assert.rejects(f.runtime.change(1, "desktop", undefined, context));
  assert.equal(f.physical.mode, "mobile");
  assert.equal(f.physical.retained, true, "successful rollback restores retention too");
  assert.equal(f.runtime.describePage(1).pageMode, "mobile");
  f.connections.delete(1);
  f.removed[0](1);
  await f.runtime.preparePage(1, "read_dom", undefined, context);
  assert.equal(f.runtime.describePage(1).pageMode, "desktop");
});

test("opposing changes on the same tab serialize and a cancelled queued change has no effect", async () => {
  const f = fixture(), controller = new AbortController();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  f.hook(async method => { if (method === "Runtime.evaluate") { started(); await gate; } });
  const mobile = f.runtime.change(1, "mobile", undefined, context);
  await entered;
  const cancelled = f.runtime.change(1, "desktop", controller.signal, context);
  controller.abort(); release();
  await mobile;
  await assert.rejects(cancelled, { code: "OPERATION_ABORTED" });
  assert.equal(f.runtime.describePage(1).pageMode, "mobile");
});

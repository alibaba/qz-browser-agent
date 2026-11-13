import assert from "node:assert/strict";
import test from "node:test";

const events = [];
let nextTab = 500;
globalThis.chrome = {
  runtime: { id: "locator-fixture" },
  tabs: { async get(id) { return { id, url: "https://example.test/" }; } },
  scripting: { async executeScript() { return [{ documentId: "document" }]; } },
  debugger: { onEvent: { addListener(fn) { events.push(fn); } }, onDetach: { addListener() {} } },
};
const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
class ToolExecutionError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function fixture(reply, options = {}) {
  const tabId = nextTab++, calls = [], context = { sessionId: "session", requestedTabRef: "page" };
  let debuggerCalls = 0;
  const observe = (params, bound = false) => {
    calls.push({ ...params, bound });
    return typeof reply === "function" ? reply(params, bound) : reply;
  };
  const runtime = createElementRuntime({
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({ sessions: { listOwnedTabIds: () => [tabId], resolveTargetTab: async () => ({ ok: true }) } }),
    makeSessionTabTargetError: (code, details) => new ToolExecutionError(code, code, details),
    assertTabAllowed: async () => {}, initializeContentScript: async () => {},
    sendToContent: async (_id, action, params) => {
      assert.equal(action, "resolveLocator");
      return observe(params);
    },
    withDebugger: async (_id, run) => {
      debuggerCalls++;
      if (options.bindingError) throw options.bindingError;
      return run({ tabId }, async (method, params = {}) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "loader" } } };
        if (method === "Runtime.enable") {
          events.forEach(fn => fn({ tabId }, "Runtime.executionContextCreated", { context: { id: tabId, origin: "chrome-extension://locator-fixture", auxData: { frameId: "main", type: "isolated" } } }));
          return {};
        }
        if (method === "Runtime.evaluate") return { result: { value: { extensionId: "locator-fixture", bridge: true, elementRefs: true } } };
        if (method === "DOM.resolveNode") return { object: { objectId: `node-${params.backendNodeId}` } };
        if (method === "DOM.describeNode") return options.describedNode || { node: { backendNodeId: 91 } };
        if (method === "Runtime.releaseObjectGroup") return {};
        if (method === "Runtime.callFunctionOn") {
          const message = params.arguments[0].value;
          if (message.action === "resolveElementRefs") return options.bindingResult || { result: { subtype: "array", objectId: "unavailable" } };
          assert.equal(message.action, "resolveLocator");
          return { result: { value: observe(message, true) } };
        }
        if (method === "Runtime.getProperties") return options.bindingProperties || { result: [{ name: "0", value: { subtype: "null" } }] };
        throw new Error(`Unexpected CDP method ${method}`);
      });
    },
  });
  return { runtime, tabId, context, calls, debuggerCalls: () => debuggerCalls,
    pin: () => runtime.registerElementBinding({ tabId, sessionId: "session", backendNodeId: 73, documentId: "document", loaderId: "loader" }).target,
    resolve: locator => runtime.resolveLocatorTarget(tabId, locator, context),
    count: locator => runtime.countLocatorMatches(tabId, locator, context),
    find: locator => runtime.findLocatorElements(tabId, locator, context),
  };
}

test("strict locator distinguishes missing, ambiguous, and explicitly selected matches", async () => {
  const missing = fixture({ matched: 0 });
  assert.equal(await missing.resolve({ role: "button", name: "Save" }), null);
  const multiple = fixture({ matched: 2 });
  await assert.rejects(multiple.resolve({ role: "button" }), error => error.code === "AMBIGUOUS_ELEMENT" && error.details.matched === 2);
  assert.equal(await multiple.resolve({ role: "button", nth: 2 }), null);
  assert.equal(multiple.debuggerCalls(), 0);
  const selected = fixture({ matched: 2, element: { backendNodeId: 72, role: "button", name: "Save" } });
  const bound = await selected.resolve({ role: "button", nth: 1 });
  assert.match(bound.target, /^uid:/);
  assert.equal(bound.ref.backendNodeId, 72);
  assert.equal(bound.selector, "");
  assert.equal(selected.calls.length, 1);
});

test("count reads do not bind nodes or require a unique match", async () => {
  const f = fixture({ matched: 4 });
  assert.equal(await f.count({ role: "option" }), 4);
  assert.equal(await f.count({ role: "option", nth: 2 }), 1);
  assert.equal(await f.count({ role: "option", nth: 4 }), 0);
  assert.ok(f.calls.every(call => call.countOnly));
  assert.equal(f.debuggerCalls(), 0);
});

test("discovery shares matching and returns observations without leaking backend identity", async () => {
  const f = fixture({ matched: 2, results: [{ backendNodeId: 72, role: "option", name: "First" }, { backendNodeId: 73, role: "option", name: "Second" }] });
  const result = await f.find({ role: "option" });
  assert.equal(result.count, 2);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(item => item.target.startsWith("uid:") && !("backendNodeId" in item)));
  assert.equal(f.calls[0].all, true);
});

test("CSS scopes are resolved in the same query, while UID scopes use their bound root", async () => {
  const f = fixture({ matched: 1, element: { backendNodeId: 74, role: "button" } });
  const result = await f.resolve({ within: "css:#form", role: "button" });
  assert.equal(result.ref.backendNodeId, 74);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].locator, { within: "css:#form", role: "button" });
  assert.equal(f.calls[0].bound, false);
  assert.equal(f.debuggerCalls(), 0);
  const within = f.pin();
  assert.equal((await f.resolve({ within, role: "button" })).ref.backendNodeId, 74);
  assert.deepEqual(f.calls[1].locator, { role: "button" });
  assert.equal(f.calls[1].bound, true);
});

test("UID queries retain identity and only filter the bound node", async () => {
  const f = fixture({ matched: 1 }), target = f.pin();
  assert.equal((await f.resolve({ target })).target, target);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.resolve({ target, role: "button" })).target, target);
  assert.equal(f.calls[0].matchSelf, true);
  assert.equal(f.calls[0].bound, true);
  assert.equal(Object.hasOwn(f.calls[0].locator, "target"), false);
  await assert.rejects(f.resolve({ target: "uid:t999.000000.1" }), { code: "STALE_ELEMENT_UID" });
  await assert.rejects(f.resolve({ target, within: "css:main" }), { code: "INVALID_ELEMENT_LOCATOR" });
});

test("a removed pinned target is absent, while a removed search scope stays stale", async () => {
  const f = fixture({ code: "STALE_ELEMENT_UID", error: "Removed", details: { reason: "node_unavailable" } });
  const target = f.pin();
  assert.equal(await f.count({ target }), 0);
  assert.equal(await f.resolve({ target, role: "button" }), null);
  await assert.rejects(f.count({ within: target, role: "button" }), error =>
    error.code === "STALE_ELEMENT_UID" && error.details.target === target && error.details.reason === "node_unavailable");
});

test("a node lost during binding never falls back to a replacement CSS match", async () => {
  const f = fixture({ matched: 1, element: { _elementRef: "removed", selector: "#replacement" } });
  await assert.rejects(f.resolve({ role: "button" }), error =>
    error.code === "STALE_ELEMENT_UID" && error.details.reason === "locator_match_changed");
  assert.equal(f.calls.length, 1);
});

test("strict binding preserves authority and transport failures; discovery keeps its fallback", async () => {
  for (const code of ["SESSION_TAB_FOREIGN", "SESSION_TAB_UNOWNED", "CDP_TRANSPORT_FAILED"]) {
    const failure = new ToolExecutionError(code, "Binding denied", { tabRef: "page" });
    const candidate = { _elementRef: "observed", selector: "#candidate" };
    const f = fixture({ matched: 1, element: candidate }, { bindingError: failure });
    await assert.rejects(f.resolve({ role: "button" }), error => error === failure);
    const legacy = await f.runtime.addElementTargetsToFindResult(candidate, f.tabId, f.context);
    assert.equal(legacy.target, "css:#candidate");
  }
});

test("strict binding consumes the original node token and keeps its backend identity", async () => {
  const f = fixture({ matched: 1, element: { _elementRef: "observed", selector: "#unused" } }, {
    bindingProperties: { result: [{ name: "0", value: { subtype: "node", objectId: "original" } }] },
  });
  const result = await f.resolve({ role: "button" });
  assert.equal(result.ref.backendNodeId, 91);
  assert.equal(result.selector, "");
  assert.equal(f.calls.length, 1);
});

test("malformed binding replies do not masquerade as a disappearing node", async () => {
  for (const options of [
    { bindingResult: { result: { subtype: "object", objectId: "wrong-shape" } } },
    { bindingProperties: { result: [] } },
    { bindingProperties: { result: [{ name: "0", value: { subtype: "node" } }] } },
    { bindingProperties: { result: [{ name: "0", value: { subtype: "node", objectId: "original" } }] }, describedNode: { node: { backendNodeId: 0 } } },
  ]) {
    const f = fixture({ matched: 1, element: { _elementRef: "observed" } }, options);
    await assert.rejects(f.resolve({ role: "button" }), { code: "INVALID_CONTENT_RESPONSE" });
  }
  const missingIdentity = fixture({ matched: 1, element: { selector: "#candidate" } });
  await assert.rejects(missingIdentity.resolve({ role: "button" }), { code: "INVALID_CONTENT_RESPONSE" });
});

test("invalid queries and aborted contexts stop before page observation", async () => {
  const f = fixture({ matched: 1 });
  await assert.rejects(f.resolve({ within: "css:main" }), { code: "INVALID_ELEMENT_LOCATOR" });
  await assert.rejects(f.resolve({ role: "button", nth: -1 }), { code: "INVALID_ELEMENT_LOCATOR" });
  const stop = new Error("cancelled");
  await assert.rejects(f.runtime.countLocatorMatches(f.tabId, { role: "button" }, { ...f.context, signal: AbortSignal.abort(stop) }), stop);
  assert.equal(f.calls.length, 0);
});

test("CSS syntax failures preserve the offending target without an invented recovery hint", async () => {
  const target = "css:form input[type=submit], css:form button";
  const failure = { code: "INVALID_SELECTOR", error: "SyntaxError: Invalid CSS query", details: { target } };
  const f = fixture(failure);
  for (const locator of [{ target }, { target: "css:button", within: target }]) {
    await assert.rejects(f.resolve(locator), error => {
      assert.equal(error.code, failure.code);
      assert.equal(error.message, failure.error);
      assert.equal(error.hint, undefined);
      assert.deepEqual(error.details, { tabRef: "page", target });
      return true;
    });
  }
  assert.equal(f.debuggerCalls(), 0, "invalid CSS never reaches element binding or dispatch");
});

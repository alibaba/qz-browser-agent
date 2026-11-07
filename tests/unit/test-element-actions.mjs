import assert from "node:assert/strict";
import test from "node:test";
import { registerPageElementTools } from "../../src/capabilities/page/tools.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";
import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";

const navigationListeners = new Set();
const frameNavigationListeners = new Set();
globalThis.chrome = {
  storage: { local: { async get() { return {}; } } },
  tabs: { async get() { return { url: "https://example.test/", title: "Fixture", status: "complete" }; },
    onUpdated: { addListener: listener => navigationListeners.add(listener), removeListener: listener => navigationListeners.delete(listener) } },
  webNavigation: {
    ...Object.fromEntries(['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onErrorOccurred']
      .map(name => [name, { addListener: listener => frameNavigationListeners.add(listener), removeListener: listener => frameNavigationListeners.delete(listener) }])),
    async getFrame({ tabId }) {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, documentId: tab.url, errorOccurred: false };
    },
  },
};
const context = { sessionId: "owner", runId: "run", runProfile: { platform: { os: "linux" } } };

function fixture({ checked, mobile = false, frameId = "", hidden = false, observedNavigation = null, attached = true, receiptCount = 1, rejectUnbound = false } = {}) {
  const commands = [], messages = [], observations = [], controller = new AbortController();
  const operationEvents = [];
  const operation = { dispatch() { operationEvents.push("dispatch"); }, confirm() { operationEvents.push("confirm"); } };
  const receipts = new Set();
  chrome.scripting = { async executeScript({ args }) {
    if (!args) return [{ frameId: 0, documentId: "fixture", result: { width: 800, height: 600 } }];
    const [id, arm] = args;
    if (arm) receipts.add(id); else receipts.delete(id);
    return [{ frameId: 0, documentId: "fixture", result: arm ? 0 : receiptCount }];
  } };
  const state = { value: "old", checked };
  let execute, focusRef, onCommand = async () => {}, onContent = async () => {};
  const inspection = () => ({ selector: "#target", tag: "input", type: checked === undefined ? "text" : "checkbox",
    editable: checked === undefined, disabled: false, readOnly: false, focused: true, ...state,
    clickablePoint: hidden ? null : state.clickablePoint || { x: 20, y: 20 }, clickablePointInViewport: true, inViewport: true });
  const content = async (action, params) => {
    messages.push({ action, params });
    if (action === "prepareElementFill") focusRef = "filled-element";
    if (action === "prepareElementPress") focusRef = "focused-element";
    const reply = await onContent(action, params);
    if (reply !== undefined) return reply;
    if (action === "elementPresence") return { found: true };
    if (action === "prepareElementFill") return { ...inspection(), fillMode: "text", expectedValue: String(params.value ?? ""), _elementRef: "filled-element" };
    if (action === "prepareElementPress") return { ...inspection(), _elementRef: "focused-element" };
    if (action === "verifyElementFocus") assert.deepEqual(params.elementRefs, [focusRef]);
    return { ...inspection(), ...(action === "readElementActionState" && params.value !== undefined
      ? { valueMatches: state.value === params.value } : {}) };
  };
  const send = async (method, params = {}) => {
    commands.push({ method, params });
    if (method === "Input.insertText") state.value = params.text;
    if (method === "Input.dispatchKeyEvent" && params.key === "Backspace" && params.type !== "keyUp") state.value = "";
    if ((method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && params.x >= 0 && params.y >= 0)
      || (method === "Input.dispatchTouchEvent" && params.type === "touchEnd")) {
      if (state.checked !== undefined) state.checked = !state.checked;
    }
    const produced = await onCommand(method, params);
    return produced === undefined ? {} : produced;
  };
  registerPageElementTools({
    registerTool(definition) { if (definition.name === "act_on_element") execute = definition.execute; },
    ToolExecutionError,
    async resolveElementReference(tabId, { target, index }) {
      return { tabId, target, selector: target.slice(4), index, ...(frameId ? { uid: "frame-target", ref: { frameId } } : {}) };
    },
    async useElement(_tabId, _ref, _context, run) { return run(content); },
    async readMainDocumentId() { return state.documentId || "fixture-document"; },
    elementTargetForSelector: selector => `css:${selector}`,
    getElementTargetDescription: () => "test target",
    async sendToContent(_tabId, action, params) {
      assert.equal(rejectUnbound, false, "a frame target must stay on its node-bound Content connection");
      return content(action, params);
    },
    clickPointReady: inspected => Boolean(inspected.clickablePoint) && inspected.disabled !== true
      && inspected.visible !== false && inspected.state?.obscuredAtCenter !== true,
    clickNotReadyResult: () => ({ error: "No point", code: "CLICK_POINT_OUT_OF_VIEWPORT" }),
    getPageContext: () => ({ pageMode: mobile ? "mobile" : "desktop" }),
    async getTabPageState() { return { url: "https://example.test/", title: "Fixture" }; },
    pageStateDelta: (before, after) => ({ pageBefore: before, pageAfter: after, urlChanged: before.url !== after.url, titleChanged: before.title !== after.title }),
    async prepareKnownPageNavigation() { return null; },
    commitObservedPageNavigation: input => { observations.push(input); return observedNavigation; },
    sendCdp: async (_tabId, method, params) => send(method, params),
    getDebuggerConnectionId: () => attached ? 1 : null,
    withDebugger: async (_tabId, callback) => {
      assert.equal(attached, true, 'CSS selection must not attempt to attach');
      return callback({}, send);
    },
  });
  return { commands, messages, observations, controller, state, receipts, inspection, operationEvents,
    call: (args, overrides = {}) => execute({ tabId: 7, target: "css:#target", ...args }, controller.signal, { ...context, operation, ...overrides }),
    onCommand: hook => { onCommand = hook; }, onContent: hook => { onContent = hook; } };
}

function assertNoReplay(f) {
  assert.equal(f.messages.some(message => message.action === "actOnElement"), false,
    "a failed trusted input must never replay through synthetic Content actions");
  assert.equal(frameNavigationListeners.size, 0, "native navigation listeners must be released");
}

for (const action of ["click", "check", "press"]) test(`a failed child surface preparation cannot dispatch or synthesize ${action}`, async () => {
  const f = fixture({ frameId: "child", checked: action === "check" ? false : undefined });
  f.onCommand(method => { if (method === "Page.captureScreenshot") throw new Error("frame surface unavailable"); });
  await assert.rejects(f.call({ action, key: "Enter" }), /frame surface unavailable/);
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assert.equal(f.receipts.size, 0);
  assert.equal(navigationListeners.size, 0);
  assert.deepEqual(f.operationEvents, []);
  assertNoReplay(f);
});

test("a lost click response releases receipts and never repeats the click", async () => {
  const f = fixture();
  f.onCommand((method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") throw new Error("lost click response");
  });
  await assert.rejects(f.call({ action: "click" }), /lost click response/);
  assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
  assert.equal(f.receipts.size, 0);
  assert.equal(navigationListeners.size, 0);
  assert.deepEqual(f.operationEvents, ["dispatch"], "a lost browser reply leaves execution unconfirmed");
  assertNoReplay(f);
});

test("an observation failure after a click never replays the action", async () => {
  const f = fixture(), get = chrome.tabs.get;
  chrome.tabs.get = async (...args) => {
    if (f.commands.some(command => command.params.type === "mouseReleased")) throw new Error("tab closed while observing");
    return get(...args);
  };
  try {
    await assert.rejects(f.call({ action: "click" }), /tab closed while observing/);
    assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
    assert.equal(navigationListeners.size, 0);
    assert.deepEqual(f.operationEvents, ["dispatch", "confirm"], "an observation failure preserves the acknowledged input");
    assertNoReplay(f);
  } finally { chrome.tabs.get = get; }
});

test("cancellation during click preparation cannot dispatch a Content fallback", async () => {
  const f = fixture();
  let inspections = 0;
  f.onContent(action => {
    if (action === "readElementReadiness" && ++inspections === 2) {
      f.controller.abort();
      throw new Error("Content response lost during cancellation");
    }
  });
  await assert.rejects(f.call({ action: "click" }), { code: "OPERATION_ABORTED" });
  assert.equal(f.commands.length, 0);
  assert.equal(navigationListeners.size, 0);
  assert.deepEqual(f.operationEvents, []);
  assertNoReplay(f);
});

test("a committed URL still undergoes navigation security checks while resources keep loading", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(), get = chrome.tabs.get;
  chrome.tabs.get = async (...args) => f.commands.some(command => command.params.type === "mouseReleased")
    ? { url: "https://example.test/done", title: "Done", status: "loading" } : get(...args);
  try {
    const pending = f.call({ action: "click" });
    await new Promise(setImmediate);
    t.mock.timers.tick(180);
    await new Promise(setImmediate);
    t.mock.timers.tick(10_000);
    const result = await pending;
    assert.equal(result.navigationPending, undefined);
    assert.equal(result.navigated, true, "a committed destination is known even if its resources are still loading");
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].pageAfter.url, "https://example.test/done");
    assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
    assertNoReplay(f);
  } finally { chrome.tabs.get = get; }
});

for (const documentChanged of [false, true, null]) test(`Firefox Enter keeps pending and document evidence separate (${documentChanged})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(), get = chrome.tabs.get;
  const pressed = () => f.commands.some(command => command.method === 'Input.dispatchKeyEvent');
  t.mock.method(chrome.tabs, 'get', async (...args) => ({ ...await get(...args), ...(pressed() ? { status: 'loading', pendingUrl: 'https://example.test/' } : {}) }));
  t.mock.method(chrome.webNavigation, 'getFrame', async () => ({ url: 'https://example.test/', errorOccurred: false,
    documentId: documentChanged === null ? undefined : pressed() && documentChanged ? 'new-document' : 'same-document',
  }));
  const pending = f.call({ action: 'press', key: 'Enter' });
  await new Promise(setImmediate);
  t.mock.timers.tick(180);
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  const result = await pending;
  assert.deepEqual(result, { navigationPending: true,
    ...(documentChanged === true ? { navigated: true, url: "https://example.test/" } : {}) });
});

test("page changes during click preparation form the baseline instead of being attributed to the click", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(), get = chrome.tabs.get;
  let tab = { url: "https://example.test/", title: "Fixture", status: "complete" }, inspections = 0;
  chrome.tabs.get = async () => ({ ...tab });
  f.onContent(action => {
    if (action === "readElementReadiness" && ++inspections === 2) {
      tab = { url: "https://example.test/prepared", title: "Prepared", status: "loading" };
      for (const listener of navigationListeners) listener(7, { url: tab.url, status: "loading" });
    }
  });
  try {
    const pending = f.call({ action: "click" });
    await new Promise(setImmediate);
    t.mock.timers.tick(180);
    const result = await pending;
    assert.deepEqual(result, {}, "pre-existing loading is not reported as navigation caused by the action");
    assert.equal(f.observations.length, 0, "an unchanged document must not commit a navigation");
    assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
    assert.equal(navigationListeners.size, 0);
  } finally { chrome.tabs.get = get; }
});

for (const outcome of ["no start", "stopped without commit", "already loading", "committed"]) {
  test(`content fallback observes ${outcome} without repeating the request`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture(), get = chrome.tabs.get;
    const href = "https://example.test/done";
    let inspections = 0, requests = 0;
    chrome.tabs.get = async (...args) => outcome === "committed" && requests
      ? { url: href, title: "Done", status: "complete" }
      : { ...await get(...args), status: outcome === "already loading" ? "loading" : "complete" };
    f.onContent(action => {
      if (action === "readElementReadiness" && ++inspections === 2) throw new Error("CDP preparation failed");
      if (action === "actOnElement") {
        requests++;
        f.state.navigated = true;
        f.state.href = href;
        if (outcome === "stopped without commit") {
          for (const status of ["loading", "complete"]) {
            for (const listener of navigationListeners) listener(7, { status });
          }
        }
      }
    });
    try {
      const pending = f.call({ action: "click" });
      await new Promise(setImmediate);
      t.mock.timers.tick(180);
      const result = await pending;
      assert.deepEqual(result, outcome === "committed" ? { navigated: true, url: href } : {});
      assert.equal(f.observations.length, outcome === "committed" ? 1 : 0);
      if (outcome === "committed") assert.equal(f.observations[0].pageAfter.url, href);
      assert.equal(result._pageUrl, undefined);
      assert.equal(requests, 1);
      assert.equal(f.messages.filter(message => message.action === "actOnElement").length, 1);
      assert.equal(navigationListeners.size, 0);
    } finally { chrome.tabs.get = get; }
  });
}

test('select dispatches Content once and does not enable page events or replay a lost response', async () => {
  const f = fixture();
  f.onContent((action, params) => {
    if (action !== 'actOnElement') return;
    assert.equal(params.elementAction, 'select');
    throw new Error('selection response lost');
  });
  await assert.rejects(f.call({ action: 'select', value: 'choice' }), /selection response lost/);
  assert.equal(f.messages.filter(message => message.action === 'actOnElement').length, 1);
  assert.equal(f.commands.some(command => command.method === 'Page.enable'), false);
  assert.deepEqual(f.operationEvents, ["dispatch"]);
});

test('CSS select succeeds without a debugger connection or attachment permission', async () => {
  const f = fixture({ attached: false });
  f.onContent((action, params) => {
    if (action !== 'actOnElement') return;
    assert.equal(params.elementAction, 'select');
    return { selected: true };
  });
  assert.deepEqual(await f.call({ action: 'select', value: 'choice' }), {});
  assert.equal(f.messages.filter(message => message.action === 'actOnElement').length, 1);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.operationEvents, ["dispatch", "confirm"]);
});

for (const args of [{ key: "Enter" }, { value: "Enter" }, { key: " Enter " }]) {
  for (const hidden of [false, true]) test(`press ${JSON.stringify(args)} observes before input (hidden=${hidden}) and appends navigation`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pageBefore = { url: "https://example.test/", title: "Fixture" };
    const pageAfter = hidden ? pageBefore : { url: "https://example.test/done", title: "Done" };
    const observedNavigation = hidden ? null : { url: pageAfter.url };
    const f = fixture({ hidden, observedNavigation });
    let changed = false;
    t.mock.method(chrome.tabs, "get", async () => ({ ...(changed ? pageAfter : pageBefore), status: "complete" }));
    const added = t.mock.method(chrome.tabs.onUpdated, "addListener");
    f.onCommand((method, params) => {
      if (!method.startsWith("Input.") || params.type === "mouseMoved") return;
      assert.equal(navigationListeners.size, 1, "observe before dispatching the key");
      changed = true;
    });
    const pending = f.call({ action: "press", ...args });
    await new Promise(setImmediate);
    t.mock.timers.tick(180);
    const result = await pending;
    assert.deepEqual(result, hidden ? {} : { navigated: true, url: pageAfter.url });
    assert.equal(added.mock.callCount(), 1);
    assert.equal(f.observations.length, hidden ? 0 : 1);
    if (!hidden) assert.equal(f.observations[0].prepared, null);
    assert.equal(f.commands.filter(command => command.params.type === "keyDown").length, 1);
    assert.equal(f.commands.some(command => command.method === "Input.dispatchMouseEvent"), false);
    assert.deepEqual(f.messages.filter(message => ["prepareElementPress", "verifyElementFocus"].includes(message.action))
      .map(message => message.action), ["prepareElementPress", "verifyElementFocus"]);
    assert.equal(navigationListeners.size, 0);
    assert.equal(f.receipts.size, 0);
    assertNoReplay(f);
  });
}

for (const key of ["Shift+Enter", "Ctrl+Enter", "Alt+Enter", "Meta+Enter", "Escape", "Tab", "a"]) {
  test(`press ${key} does not observe or wait and keeps its exact JSON structure`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    const added = t.mock.method(chrome.tabs.onUpdated, "addListener");
    t.mock.method(chrome.tabs, "get", () => { throw new Error("non-Enter must not probe navigation"); });
    // A supplied key wins over value:'Enter'. No timer is advanced in this test.
    const result = await f.call({ action: "press", key, value: "Enter" });
    assert.deepEqual(result, {});
    assert.equal(f.commands.filter(command => command.params.type === "keyDown" || command.params.type === "rawKeyDown").length, 1);
    assert.equal(added.mock.callCount(), 0);
    assert.equal(f.observations.length, 0);
    assert.equal(f.receipts.size, 0);
  });
}

for (const boundary of ["prepareElementPress", "verifyElementFocus", "keyDown", "keyUp"]) {
  test(`press Enter disposes and never replays a lost ${boundary} response`, async () => {
    const f = fixture();
    f.onContent(action => { if (action === boundary) throw new Error("input response lost"); });
    f.onCommand((method, params) => {
      if (!method.startsWith("Input.") || params.type === "mouseMoved") return;
      assert.equal(navigationListeners.size, 1);
      if (params.type === boundary) throw new Error("input response lost");
    });
    await assert.rejects(f.call({ action: "press", key: "Enter" }), /input response lost/);
    assert.equal(f.commands.some(command => command.method === "Input.dispatchMouseEvent"), false);
    assert.equal(f.messages.filter(message => message.action === "prepareElementPress").length, 1);
    assert.equal(f.commands.filter(command => command.params.type === "keyDown").length, boundary.startsWith("key") ? 1 : 0);
    assert.equal(navigationListeners.size, 0);
    assert.equal(f.receipts.size, 0);
    assertNoReplay(f);
  });
}

for (const boundary of ["observer setup", "prepareElementPress", "verifyElementFocus", "keyDown", "observation wait"]) {
  test(`press Enter cancellation at ${boundary} disposes without further dispatch or fallback`, async t => {
    const f = fixture();
    if (boundary === "observer setup") t.mock.method(chrome.tabs.onUpdated, "addListener", listener => {
      navigationListeners.add(listener);
      queueMicrotask(() => f.controller.abort());
    });
    f.onContent(action => { if (action === boundary) f.controller.abort(); });
    f.onCommand((_method, params) => { if (params.type === boundary) f.controller.abort(); });
    const pending = f.call({ action: "press", key: "Enter" });
    const rejected = assert.rejects(pending, { code: "OPERATION_ABORTED" });
    if (boundary === "observation wait") {
      await new Promise(setImmediate);
      assert.equal(navigationListeners.size, 1);
      f.controller.abort();
    }
    await rejected;
    assert.equal(f.commands.some(command => command.method === "Input.dispatchMouseEvent"), false);
    assert.equal(f.commands.filter(command => command.params.type === "keyDown").length, ["keyDown", "observation wait"].includes(boundary) ? 1 : 0);
    assert.equal(navigationListeners.size, 0);
    assert.equal(f.receipts.size, 0);
    assertNoReplay(f);
  });
}

for (const navigated of [false, true]) test(`zero click receipts wait for navigation before denial (${navigated})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ receiptCount: 0 });
  t.mock.method(chrome.tabs, 'get', async () => ({
    url: navigated && f.commands.some(command => command.params.type === 'mouseReleased')
      ? 'https://example.test/done' : 'https://example.test/', title: 'Fixture', status: 'complete',
  }));
  const pending = f.call({ action: 'click' });
  await new Promise(setImmediate);
  assert.equal(f.receipts.size, 1, 'receipt stays armed until the navigation observation finishes');
  t.mock.timers.tick(180);
  const result = await pending;
  assert.equal(result.code, navigated ? undefined : 'INPUT_NOT_DELIVERED');
  if (navigated) assert.equal(result.navigated, true);
  assert.equal(f.commands.filter(command => command.params.type === 'mouseReleased').length, 1);
  assert.equal(f.receipts.size, 0);
  assert.equal(navigationListeners.size, 0);
  assertNoReplay(f);
});

test('click cancellation during final receipt read rejects success without replay', async t => {
  const f = fixture(), execute = chrome.scripting.executeScript;
  t.mock.method(chrome.scripting, 'executeScript', async options => {
    if (options.args?.[1] === false) f.controller.abort();
    return execute(options);
  });
  await assert.rejects(f.call({ action: 'click' }), { code: 'OPERATION_ABORTED' });
  assert.equal(f.receipts.size, 0);
  assert.equal(navigationListeners.size, 0);
  assert.equal(f.commands.filter(command => command.params.type === 'mouseReleased').length, 1);
  assertNoReplay(f);
});

for (const boundary of ["prepareElementPress", "verifyElementFocus"]) test(`press Enter stops on ${boundary} rejection without sending the key`, async t => {
  const f = fixture();
  f.onContent(action => action === boundary ? { code: "ELEMENT_FOCUS_FAILED", error: "Focus moved to another element" } : undefined);
  const added = t.mock.method(chrome.tabs.onUpdated, "addListener");
  const result = await f.call({ action: "press", key: "Enter" });
  assert.equal(result.code, "ELEMENT_FOCUS_FAILED");
  assert.deepEqual(result.details, { target: "css:#target", action: "press" });
  assert.equal(result.message.length > 0, true);
  assert.equal(added.mock.callCount(), 1);
  assert.equal("pageBefore" in result, false);
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assert.equal(navigationListeners.size, 0);
  assert.equal(f.receipts.size, 0);
  assert.deepEqual(f.operationEvents, ["dispatch"]);
  assertNoReplay(f);
});

test("press Enter observation failure after dispatch disposes without replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(), get = chrome.tabs.get;
  t.mock.method(chrome.tabs, "get", async (...args) => {
    if (f.commands.some(command => command.params.type === "keyDown")) throw new Error("tab closed while observing");
    return get(...args);
  });
  const pending = f.call({ action: "press", key: "Enter" });
  const rejected = assert.rejects(pending, /tab closed while observing/);
  await new Promise(setImmediate);
  t.mock.timers.tick(180);
  await rejected;
  assert.equal(f.commands.filter(command => command.params.type === "keyDown").length, 1);
  assert.deepEqual(f.operationEvents, ["dispatch", "confirm"]);
  assert.equal(navigationListeners.size, 0);
  assert.equal(f.receipts.size, 0);
  assertNoReplay(f);
});

test("press rejects a document replaced by focus without retargeting or replay", async () => {
  const f = fixture();
  f.onContent(action => { if (action === "prepareElementPress") f.state.documentId = "replacement-document"; });
  await assert.rejects(f.call({ action: "press", key: "Enter" }), { code: "STALE_ELEMENT_UID" });
  assert.equal(f.messages.filter(message => message.action === "prepareElementPress").length, 1);
  assert.equal(f.messages.some(message => message.action === "verifyElementFocus"), false);
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assert.equal(navigationListeners.size, 0);
  assertNoReplay(f);
});

test("a lost insertText response does not replay input or submit", async () => {
  const f = fixture();
  f.onCommand(method => { if (method === "Input.insertText") throw new Error("lost insert response"); });
  await assert.rejects(f.call({ action: "fill", value: "订单🙂", submit: true }), /lost insert response/);
  assert.equal(f.state.value, "订单🙂", "the browser may have applied the failed command");
  assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, 1);
  assert.equal(f.commands.some(command => command.params.key === "Enter"), false);
  assert.deepEqual(f.operationEvents, ["dispatch"]);
  assertNoReplay(f);
});

for (const boundary of ["prepare", "insert", "readback", "focus"]) {
  test(`cancellation after ${boundary} prevents later input and submission`, async () => {
    const f = fixture();
    f.onContent((action, params) => {
      if ((boundary === "prepare" && action === "prepareElementFill")
        || (boundary === "readback" && action === "readElementActionState")
        || (boundary === "focus" && action === "verifyElementFocus" && params.retainRef !== true)) f.controller.abort();
    });
    f.onCommand(method => { if (boundary === "insert" && method === "Input.insertText") f.controller.abort(); });
    await assert.rejects(f.call({ action: "fill", value: "new", submit: true }));
    assert.equal(f.commands.some(command => command.params.key === "Enter"), false);
    assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, boundary === "prepare" ? 0 : 1);
    assertNoReplay(f);
  });
}

for (const boundary of ["before input", "readback", "before submit"]) test(`a same-id replacement is rejected ${boundary} despite copying the value and focus`, async () => {
  const f = fixture();
  f.onContent((action, params) => {
    if (!["readElementActionState", "verifyElementFocus"].includes(action)) return;
    assert.deepEqual(params.elementRefs, ["filled-element"], "readback and submission must keep the prepared node identity");
    const reject = boundary === "readback" ? action === "readElementActionState"
      : action === "verifyElementFocus" && (boundary === "before input" ? params.retainRef === true : params.retainRef !== true);
    if (reject) return { error: "The original element was replaced", code: "STALE_ELEMENT_UID" };
    return { ...f.inspection(), valueMatches: true };
  });
  const result = await f.call({ action: "fill", value: "new", submit: true });
  assert.equal(f.state.value, boundary === "before input" ? "old" : "new", "value alone cannot establish the original field identity");
  assert.equal(result.code, "STALE_ELEMENT_UID");
  assert.equal(result.submitDispatched, undefined);
  assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, boundary === "before input" ? 0 : 1);
  assert.equal(f.commands.some(command => command.params.key === "Enter"), false);
  assert.equal(f.messages.some(message => message.action === "refreshElementFill"), false);
  assertNoReplay(f);
});

for (const submit of [false, true]) test(`ordinary fill verifies the field and returns a compact receipt (submit=${submit})`, async t => {
  const f = fixture();
  const injections = t.mock.method(chrome.scripting, 'executeScript');
  const result = await f.call({ action: "fill", value: "new", submit });
  assert.deepEqual(result, {});
  assert.equal(injections.mock.calls.some(call => call.arguments[0].target?.allFrames), false);
  assert.equal(f.commands.filter(command => command.params.key === 'Enter' && command.params.type === 'keyDown').length, Number(submit));
  assert.equal(f.state.value, "new");
  assert.equal(f.operationEvents.at(-1), "confirm");
  assert.equal(f.messages.filter(message => message.action === "readElementActionState").length, 1);
  assert.deepEqual(f.messages.find(message => message.action === "readElementActionState").params.elementRefs, ["filled-element"]);
  assert.equal(f.messages.filter(message => message.action === "verifyElementFocus").length, 1 + Number(submit));
  assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, 1);
  assert.equal(f.messages.some(message => message.action === "refreshElementFill" || message.action === "releaseElementFill"), false);
  assertNoReplay(f);
});

for (const uncertain of [false, true]) test(`rich-text evidence stays in presentation metadata and uncertainty remains explicit (${uncertain})`, async () => {
  const f = fixture();
  const structure = { paragraphCount: 2, brCount: 0, blockCount: 2, lineBreakCount: 1, htmlSample: "<p>One</p><p>Two</p>" };
  f.onContent((action, params) => {
    if (action === "inspectElement") return { ...f.inspection(), role: "textbox", name: "Article" };
    if (action === "prepareElementFill") return { ...f.inspection(), fillMode: "content", contentEditable: true, expectedValue: params.value, _elementRef: "filled-element" };
    if (action === "actOnElement") {
      assert.deepEqual(params.elementRefs, ["filled-element"], "the specialized writer must use the prepared editing host");
      f.state.value = params.value;
      return { filled: true, fill: { value: params.value, richText: { structure,
        ...(uncertain ? { method: "innerHTML", warning: "Editor state requires verification" } : {}),
      } } };
    }
  });
  const result = await f.call({ action: "fill", value: "One\nTwo" });
  assert.deepEqual(result, uncertain ? { confirmationRequired: true, hint: "Verify the editor saved the value before continuing." } : {});
  assert.doesNotMatch(JSON.stringify(result), /innerHTML|Article|paragraphCount|filled|"value"/);
  assert.equal(f.state.value, "One\nTwo");
  assert.equal(f.operationEvents.includes("confirm"), !uncertain);
  assert.equal(f.messages.filter(message => message.action === "actOnElement").length, 1);
  assert.equal(f.messages.filter(message => message.action === "readElementActionState").length, 1);
  assert.deepEqual(getToolResultPresentation(result)._display, {
    elementAction: { element: { role: "textbox", name: "Article", text: undefined }, structure },
  });
});

for (const valueMatches of [false, null]) test(`rich-text ${valueMatches === null ? "unknown" : "mismatched"} value cannot submit`, async () => {
  const f = fixture();
  f.onContent((action, params) => {
    if (action === "prepareElementFill") return { ...f.inspection(), fillMode: "content", expectedValue: "One\nTwo", _elementRef: "filled-element" };
    if (action === "actOnElement") return { filled: true };
    if (action === "readElementActionState") {
      assert.equal(params.value, "One\nTwo", "readback must compare the prepared expected value");
      return { ...f.inspection(), contentEditable: true, valueMatches };
    }
  });
  const result = await f.call({ action: "fill", value: "One\r\nTwo", submit: true });
  if (valueMatches === null) assert.equal(result.confirmationRequired, true);
  else assert.equal(result.code, "ELEMENT_VALUE_MISMATCH");
  assert.equal(f.messages.filter(message => message.action === "actOnElement").length, 1);
  assert.equal(f.commands.some(command => command.method === "Input.dispatchKeyEvent"), false);
  assert.equal(navigationListeners.size, 0);
  assert.deepEqual(f.operationEvents, ["dispatch"]);
});

test("a replacement non-checkable input cannot count as a successful check", async () => {
  const f = fixture({ checked: false });
  f.onCommand((_method, params) => { if (params.type === "mouseReleased") f.state.type = "text"; });
  assert.equal((await f.call({ action: "check" })).code, "ELEMENT_CHECK_STATE_MISMATCH");
  assertNoReplay(f);
});

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} cancellation while pressed releases without activating the target`, async () => {
    const f = fixture({ checked: false, mobile });
    const method = mobile ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent";
    f.onCommand((name, params) => {
      if (name === method && params.type === (mobile ? "touchStart" : "mousePressed")) f.controller.abort();
    });
    await assert.rejects(f.call({ action: "check" }));
    assert.equal(f.receipts.size, 0, "cancellation releases the armed operation");
    assert.equal(f.state.checked, false);
    const cleanup = f.commands.at(-1);
    assert.equal(cleanup.method, method);
    assert.equal(cleanup.params.type, mobile ? "touchCancel" : "mouseReleased");
    if (!mobile) assert.deepEqual([cleanup.params.x, cleanup.params.y], [-1, -1]);
    assert.equal(f.commands.some(command => command.params.type === "touchEnd"), false);
    assertNoReplay(f);
  });

  test(`${mobile ? "mobile" : "desktop"} check is idempotent and never replays a partially applied click`, async () => {
    const f = fixture({ checked: true, mobile });
    const unchanged = await f.call({ action: "check" });
    assert.deepEqual(unchanged, {});
    assert.equal(f.state.checked, true);
    assert.equal(f.commands.length, 0);
    f.state.checked = false;
    const method = mobile ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent";
    const release = mobile ? "touchEnd" : "mouseReleased";
    f.onCommand((name, params) => { if (name === method && params.type === release) throw new Error("lost click response"); });
    await assert.rejects(f.call({ action: "check" }), /lost click response/);
    assert.equal(f.state.checked, true);
    assert.equal(f.commands.filter(command => command.method === method && command.params.type === release
      && (mobile || command.params.x >= 0)).length, 1, "neutral cleanup may release again, but must never click the target twice");
    assertNoReplay(f);
  });
}

function frameBox(y) {
  return { model: { content: [8, y, 308, y, 308, y + 80, 8, y + 80] } };
}

test("an iframe's resolved label stays on its original node-bound frame through click refresh", async () => {
  const f = fixture({ frameId: "child", rejectUnbound: true });
  const target = "uid:t7.00abcd.1";
  const original = { ...f.inspection(), selector: "#control", visible: false, clickablePoint: null };
  const label = { ...f.inspection(), selector: "#label", tag: "label", editable: false };
  f.onContent((action, params) => {
    if (action === "resolveClickTarget") return { resolvedSelector: "#label", element: label, originalElement: original };
    if (["inspectElement", "readElementReadiness", "scrollElementIntoView"].includes(action)) return { ...(params.clickTarget ? label : original) };
  });
  f.onCommand(method => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(40);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  });
  const clicked = await f.call({ target, action: "click" });
  assert.deepEqual(clicked, {});
  assert.equal(f.messages.filter(message => message.action === "scrollElementIntoView" && message.params.clickTarget).length, 1);
  assert.equal(f.messages.filter(message => message.action === "readElementReadiness" && message.params.clickTarget).length, 3,
    "readiness and the post-hover confirmation keep the original frame-bound click surface");
  const release = f.commands.find(command => command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseReleased");
  assert.deepEqual([release.params.x, release.params.y], [28, 60]);
});

test("an in-view iframe click keeps the shifted point and does not scroll", async () => {
  const f = fixture({ frameId: "child" });
  f.onCommand(method => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(40);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  });
  const clicked = await f.call({ action: "click" });
  assert.deepEqual(clicked, {});
  assert.equal(f.messages.some(message => message.action === "scrollElementIntoView"), false);
  const release = f.commands.find(command => command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseReleased");
  assert.deepEqual([release.params.x, release.params.y], [28, 60]);
});

test("an off-screen iframe click scrolls into the page viewport before dispatch", async () => {
  const f = fixture({ frameId: "child" });
  let top = 1800;
  f.onContent(action => { if (action === "scrollElementIntoView") top = 80; });
  f.onCommand(method => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(top);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  });
  const clicked = await f.call({ action: "click" });
  assert.deepEqual(clicked, {});
  assert.equal(f.messages.filter(message => message.action === "scrollElementIntoView").length, 1);
  const release = f.commands.find(command => command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseReleased");
  assert.deepEqual([release.params.x, release.params.y], [28, 100]);
  assert.deepEqual(f.commands.filter(command => command.method === "Input.dispatchMouseEvent").map(command => command.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("an iframe click that stays outside the page viewport fails instead of reporting success", async () => {
  const f = fixture({ frameId: "child" });
  f.onCommand(method => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(1800);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  });
  const missed = await f.call({ action: "click" });
  assert.equal(missed.code, "CLICK_POINT_OUT_OF_VIEWPORT");
  assert.notEqual(missed.inputDelivered, true);
  assert.equal(f.messages.filter(message => message.action === "scrollElementIntoView").length, 1);
  assert.equal(f.commands.some(command => command.method === "Input.dispatchMouseEvent"), false);
  assert.equal(f.receipts.size, 0);
  assertNoReplay(f);
});

test("hover can target a disabled control without pressing a button", async () => {
  const f = fixture();
  f.state.disabled = true;
  assert.deepEqual(await f.call({ action: "hover" }), {});
  const input = f.commands.filter(command => command.method.startsWith("Input."));
  assert.deepEqual(input.map(command => command.params.type), ["mouseMoved"]);
  assert.equal(input[0].params.buttons, 0);
});

test("double click dispatches one native two-click sequence", async () => {
  const f = fixture();
  assert.deepEqual(await f.call({ action: "double_click" }), {});
  assert.deepEqual(f.commands.filter(command => command.params.type === "mouseReleased")
    .map(command => command.params.clickCount), [1, 2]);
  assertNoReplay(f);
});

test("a new document after the first click prevents the second click", async () => {
  const f = fixture();
  f.onCommand((_method, params) => {
    if (params.type === "mouseReleased" && params.x >= 0) f.state.documentId = "replacement";
  });
  await assert.rejects(f.call({ action: "double_click" }), { code: "STALE_ELEMENT_UID" });
  assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, 1);
  assert.equal(f.commands.filter(command => command.params.type === "mouseReleased" && command.params.x >= 0).length, 1);
  assertNoReplay(f);
});

test("an iframe's original node becoming stale prevents a second click without a main document change", async () => {
  const f = fixture({ frameId: "child", rejectUnbound: true });
  let replaced = false;
  f.onCommand((method, params) => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(80);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    if (params.type === "mouseReleased" && params.x >= 0) replaced = true;
  });
  f.onContent(action => action === "elementPresence" ? { found: !replaced } : undefined);
  await assert.rejects(f.call({ action: "double_click" }), { code: "STALE_ELEMENT_UID" });
  assert.equal(f.state.documentId, undefined, "the main document has not changed");
  assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, 1);
  assert.equal(f.commands.filter(command => command.params.type === "mouseReleased" && command.params.x >= 0).length, 1);
  assertNoReplay(f);
});

test("drag holds the pointer until it reaches the observed destination", async () => {
  const f = fixture();
  f.onContent((_action, params) => params.selector === "#destination" ? { ...f.inspection(), clickablePoint: { x: 240, y: 80 } } : undefined);
  assert.deepEqual(await f.call({ action: "drag", destination: { target: "css:#destination" } }), {});
  const moved = f.commands.filter(command => command.params.type === "mouseMoved" && command.params.buttons === 1);
  assert.equal(moved.length > 1, true);
  const released = f.commands.filter(command => command.params.type === "mouseReleased");
  assert.equal(released.length, 1);
  assert.equal(released[0].params.x, 240);
  assert.equal(released[0].params.y, 80);
  assert.equal(released[0].params.buttons, 0);
  assertNoReplay(f);
});

test("drag cancellation releases away from the target without completing or replaying the gesture", async () => {
  const f = fixture();
  f.onCommand((_method, params) => {
    if (params.type === "mouseMoved" && params.buttons === 1) f.controller.abort();
  });
  await assert.rejects(f.call({ action: "drag", destination: { target: "css:#destination" } }), { code: "OPERATION_ABORTED" });
  assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, 1);
  const released = f.commands.filter(command => command.params.type === "mouseReleased");
  assert.equal(released.length, 1);
  assert.equal(released[0].params.x, -1);
  assert.equal(released[0].params.y, -1);
  assert.equal(navigationListeners.size, 0);
  assertNoReplay(f);
});

test("readiness waits for a disabled button and never dispatches after its deadline", async () => {
  const f = fixture();
  f.state.disabled = true;
  await assert.rejects(f.call({ action: "click", timeout: 0.05 }), { code: "ELEMENT_NOT_READY" });
  f.state.disabled = false;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
});

test("a temporary no-clickable-target resolution waits for the overlay to disappear", async () => {
  const f = fixture();
  f.state.state = { obscuredAtCenter: true };
  f.onContent(action => action === "resolveClickTarget"
    ? { error: "Covered", code: "NO_CLICKABLE_TARGET" } : undefined);
  const reveal = setTimeout(() => { f.state.state = { obscuredAtCenter: false }; }, 60);
  try {
    assert.deepEqual(await f.call({ action: "click", timeout: 0.5 }), {});
    assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, 1);
    assertNoReplay(f);
  } finally { clearTimeout(reveal); }
});

test("a permanently obscured click times out without input or a Content fallback", async () => {
  const f = fixture();
  f.state.state = { obscuredAtCenter: true };
  f.onContent(action => action === "resolveClickTarget"
    ? { error: "Covered", code: "NO_CLICKABLE_TARGET" } : undefined);
  await assert.rejects(f.call({ action: "click", timeout: 0.05 }), { code: "ELEMENT_NOT_READY" });
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assertNoReplay(f);
});

for (const action of ["click", "check", "double_click", "drag"]) {
  test(`${action} waits after hover changes its hit target and uses the newly observed point`, async () => {
    const f = fixture({ checked: action === "check" ? false : undefined });
    let hovered = false, reveal;
    f.onCommand((_method, params) => {
      if (params.type === "mouseMoved" && !hovered) {
        hovered = true;
        f.state.state = { obscuredAtCenter: true };
        f.state.clickablePoint = { x: 70, y: 80 };
        reveal = setTimeout(() => { f.state.state = { obscuredAtCenter: false }; }, 60);
      }
      if (params.type === "mousePressed") {
        assert.equal(f.state.state.obscuredAtCenter, false);
        assert.deepEqual([params.x, params.y], [70, 80]);
      }
    });
    try {
      assert.deepEqual(await f.call({ action, key: "Escape", destination: { target: "css:#destination" }, timeout: 1 }), {});
      assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, action === "double_click" ? 2 : 1);
      assert.equal(f.messages.filter(message => message.action === "inspectElement").length, 1, "presentation reads a rich observation only once");
      assertNoReplay(f);
    } finally { clearTimeout(reveal); }
  });

  test(`${action} never presses through a persistent hover overlay or falls back after the deadline`, async () => {
    const f = fixture({ checked: action === "check" ? false : undefined });
    f.onCommand((_method, params) => {
      if (params.type === "mouseMoved") f.state.state = { obscuredAtCenter: true };
    });
    await assert.rejects(f.call({ action, key: "Escape", destination: { target: "css:#destination" }, timeout: 0.1 }), { code: "ELEMENT_NOT_READY" });
    assert.equal(f.commands.some(command => ["mousePressed", "keyDown", "rawKeyDown"].includes(command.params.type)), false);
    assertNoReplay(f);
  });
}

for (const action of ["click", "check", "double_click", "drag"]) {
  test(`${action} rejects CSS retargeting into a document loaded by hover`, async () => {
    const f = fixture({ checked: action === "check" ? false : undefined });
    f.onCommand((_method, params) => { if (params.type === "mouseMoved") f.state.documentId = "new-document"; });
    await assert.rejects(f.call({ action, key: "Escape", destination: { target: "css:#destination" } }), { code: "STALE_ELEMENT_UID" });
    assert.equal(f.commands.some(command => command.params.type === "mousePressed"), false);
    assertNoReplay(f);
  });
}

test("double click does not prepare or replay its first click when the second click becomes unsafe", async () => {
  const f = fixture();
  f.onCommand((_method, params) => {
    if (params.type === "mouseReleased") f.state.state = { obscuredAtCenter: true };
  });
  await assert.rejects(f.call({ action: "double_click" }), { code: "ELEMENT_NOT_READY" });
  assert.equal(f.commands.filter(command => command.params.type === "mousePressed").length, 1);
  assert.equal(f.commands.filter(command => command.params.type === "mouseMoved").length, 1);
  assertNoReplay(f);
});

test("post-hover confirmation refreshes the containing iframe's offset before pressing", async () => {
  const f = fixture({ frameId: "child", rejectUnbound: true });
  let origin = 40, moved = false;
  f.onCommand((method, params) => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(origin);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
    if (params.type === "mouseMoved" && !moved) { moved = true; origin = 140; }
  });
  assert.deepEqual(await f.call({ action: "click" }), {});
  const pressed = f.commands.filter(command => command.params.type === "mousePressed");
  assert.equal(pressed.length, 1);
  assert.deepEqual([pressed[0].params.x, pressed[0].params.y], [28, 160]);
  assertNoReplay(f);
});

test("action preparation uses the host's remaining deadline instead of starting another timeout", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const f = fixture();
  f.state.disabled = true;
  const pending = f.call({ action: "click", timeout: 20 }, { deadlineAt: 1100 });
  const rejected = assert.rejects(pending, { code: "ELEMENT_NOT_READY" });
  await new Promise(setImmediate);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assertNoReplay(f);
});

test("drag refreshes a source that moved while its destination was becoming ready", async () => {
  const f = fixture();
  let destinations = 0;
  f.onContent((action, params) => {
    if (action !== "readElementReadiness" || params.selector !== "#destination") return;
    if (++destinations === 2) f.state.clickablePoint = { x: 110, y: 40 };
    return { ...f.inspection(), clickablePoint: { x: 240, y: 80 } };
  });
  assert.deepEqual(await f.call({ action: "drag", destination: { target: "css:#destination" } }), {});
  const pressed = f.commands.filter(command => command.params.type === "mousePressed");
  assert.equal(pressed.length, 1);
  assert.deepEqual([pressed[0].params.x, pressed[0].params.y], [110, 40]);
  assertNoReplay(f);
});

test("default preparation stops after five seconds even when the host allows twenty seconds for input", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const f = fixture();
  f.state.disabled = true;
  const pending = f.call({ action: "click" }, { deadlineAt: 21000 });
  const rejected = assert.rejects(pending, { code: "ELEMENT_NOT_READY" });
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assertNoReplay(f);
});

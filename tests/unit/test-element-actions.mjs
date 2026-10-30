import assert from "node:assert/strict";
import test from "node:test";
import { registerPageElementTools } from "../../src/capabilities/page/tools.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

const navigationListeners = new Set();
globalThis.chrome = {
  storage: { local: { async get() { return {}; } } },
  tabs: { async get() { return { url: "https://example.test/", title: "Fixture", status: "complete" }; },
    onUpdated: { addListener: listener => navigationListeners.add(listener), removeListener: listener => navigationListeners.delete(listener) } },
};
const context = { sessionId: "owner", runId: "run", runProfile: { platform: { os: "linux" } } };

function fixture({ checked, mobile = false, frameId = "", hidden = false } = {}) {
  const commands = [], messages = [], observations = [], controller = new AbortController();
  const receipts = new Set();
  chrome.scripting = { async executeScript({ args }) {
    if (!args) return [{ frameId: 0, documentId: "fixture", result: { width: 800, height: 600 } }];
    const [id, arm] = args;
    if (arm) receipts.add(id); else receipts.delete(id);
    return [{ frameId: 0, documentId: "fixture", result: arm ? 0 : 1 }];
  } };
  const state = { value: "old", checked };
  let execute, onCommand = async () => {}, onContent = async () => {};
  const inspection = () => ({ tag: "input", type: checked === undefined ? "text" : "checkbox",
    editable: checked === undefined, disabled: false, readOnly: false, focused: true, ...state,
    clickablePoint: hidden ? null : { x: 20, y: 20 }, clickablePointInViewport: true, inViewport: true });
  const content = async (action, params) => {
    messages.push({ action, params });
    await onContent(action, params);
    return { ...inspection(), ...(action === "prepareElementFill" ? { fillMode: "text" } : {}) };
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
    elementTargetForSelector: selector => `css:${selector}`,
    getElementTargetDescription: () => "test target",
    async sendToContent(_tabId, action, params) { return content(action, params); },
    clickPointReady: inspected => Boolean(inspected.clickablePoint),
    clickNotReadyResult: () => ({ error: "No point", code: "CLICK_POINT_OUT_OF_VIEWPORT" }),
    getPageContext: () => ({ pageMode: mobile ? "mobile" : "desktop" }),
    async getTabPageState() { return { url: "https://example.test/", title: "Fixture" }; },
    pageStateDelta: (before, after) => ({ pageBefore: before, pageAfter: after, urlChanged: before.url !== after.url, titleChanged: before.title !== after.title }),
    async prepareKnownPageNavigation() { return null; },
    commitObservedPageNavigation: input => { observations.push(input); return null; },
    sendCdp: async (_tabId, method, params) => send(method, params),
    withDebugger: async (_tabId, callback) => callback({}, send),
  });
  return { commands, messages, observations, controller, state, receipts,
    call: args => execute({ tabId: 7, target: "css:#target", ...args }, controller.signal, context),
    onCommand: hook => { onCommand = hook; }, onContent: hook => { onContent = hook; } };
}

function assertNoReplay(f) {
  assert.equal(f.messages.some(message => message.action === "actOnElement"), false,
    "a failed trusted input must never replay through synthetic Content actions");
}

for (const action of ["click", "check", "press"]) test(`a failed child surface preparation cannot dispatch or synthesize ${action}`, async () => {
  const f = fixture({ frameId: "child", checked: action === "check" ? false : undefined });
  f.onCommand(method => { if (method === "Page.captureScreenshot") throw new Error("frame surface unavailable"); });
  await assert.rejects(f.call({ action, key: "Enter" }), /frame surface unavailable/);
  assert.equal(f.commands.some(command => command.method.startsWith("Input.")), false);
  assert.equal(f.receipts.size, 0);
  assert.equal(navigationListeners.size, 0);
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
    assertNoReplay(f);
  } finally { chrome.tabs.get = get; }
});

test("cancellation during click preparation cannot dispatch a Content fallback", async () => {
  const f = fixture();
  let inspections = 0;
  f.onContent(action => {
    if (action === "inspectElement" && ++inspections === 2) {
      f.controller.abort();
      throw new Error("Content response lost during cancellation");
    }
  });
  await assert.rejects(f.call({ action: "click" }), { code: "OPERATION_ABORTED" });
  assert.equal(f.commands.length, 0);
  assert.equal(navigationListeners.size, 0);
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
    assert.equal(result.navigationPending, true);
    assert.equal(result.navigated, true, "a committed destination is known even if its resources are still loading");
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].pageAfter.url, "https://example.test/done");
    assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
    assertNoReplay(f);
  } finally { chrome.tabs.get = get; }
});

test("page changes during click preparation form the baseline instead of being attributed to the click", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(), get = chrome.tabs.get;
  let tab = { url: "https://example.test/", title: "Fixture", status: "complete" }, inspections = 0;
  chrome.tabs.get = async () => ({ ...tab });
  f.onContent(action => {
    if (action === "inspectElement" && ++inspections === 2) {
      tab = { url: "https://example.test/prepared", title: "Prepared", status: "loading" };
      for (const listener of navigationListeners) listener(7, { url: tab.url, status: "loading" });
    }
  });
  try {
    const pending = f.call({ action: "click" });
    await new Promise(setImmediate);
    t.mock.timers.tick(180);
    const result = await pending;
    assert.equal(result.navigationPending, false);
    assert.equal(result.navigated, null, "pre-existing loading is ambiguous, not evidence of a new navigation");
    assert.equal(result.urlChanged, false);
    assert.equal(result.pageBefore.url, tab.url);
    assert.equal(result.pageAfter.url, tab.url);
    assert.equal(f.commands.filter(command => command.params.type === "mouseReleased").length, 1);
    assert.equal(navigationListeners.size, 0);
  } finally { chrome.tabs.get = get; }
});

for (const method of ["href_navigation", "content_fallback"]) {
  for (const outcome of ["no start", "stopped without commit", "already loading", "committed"]) {
    test(`${method} observes ${outcome} without repeating the request`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const hidden = method === "href_navigation";
      const f = fixture({ hidden }), get = chrome.tabs.get, update = chrome.tabs.update;
      const href = "https://example.test/done";
      let inspections = 0, requests = 0;
      const request = () => {
        requests++;
        if (outcome === "stopped without commit") {
          for (const status of ["loading", "complete"]) {
            for (const listener of navigationListeners) listener(7, { status });
          }
        }
      };
      chrome.tabs.get = async (...args) => outcome === "committed" && requests
        ? { url: href, title: "Done", status: "complete" }
        : { ...await get(...args), status: outcome === "already loading" ? "loading" : "complete" };
      chrome.tabs.update = async (tabId, options) => {
        assert.equal(tabId, 7);
        assert.equal(options.url, href);
        request();
      };
      if (hidden) f.state.navigateUrl = href;
      f.onContent(action => {
        if (!hidden && action === "inspectElement" && ++inspections === 2) throw new Error("CDP preparation failed");
        if (action === "actOnElement") { request(); f.state.navigated = true; f.state.href = href; }
      });
      try {
        const pending = f.call({ action: "click" });
        await new Promise(setImmediate);
        t.mock.timers.tick(180);
        const result = await pending;
        assert.equal(result.method, method);
        assert.equal(result.navigationPending, false);
        assert.equal(result.navigated, outcome === "already loading" ? null : outcome === "committed");
        assert.equal(result.pageAfter.url, result._pageUrl);
        assert.equal(requests, 1);
        assert.equal(f.messages.filter(message => message.action === "actOnElement").length, hidden ? 0 : 1);
        assert.equal(navigationListeners.size, 0);
      } finally { chrome.tabs.get = get; chrome.tabs.update = update; }
    });
  }
}

test("a lost insertText response does not replay input or submit", async () => {
  const f = fixture();
  f.onCommand(method => { if (method === "Input.insertText") throw new Error("lost insert response"); });
  await assert.rejects(f.call({ action: "fill", value: "订单🙂", submit: true }), /lost insert response/);
  assert.equal(f.state.value, "订单🙂", "the browser may have applied the failed command");
  assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, 1);
  assert.equal(f.commands.some(command => command.params.key === "Enter"), false);
  assertNoReplay(f);
});

for (const boundary of ["prepare", "insert", "readback"]) {
  test(`cancellation after ${boundary} prevents later input and submission`, async () => {
    const f = fixture();
    f.onContent(action => {
      if ((boundary === "prepare" && action === "prepareElementFill")
        || (boundary === "readback" && action === "readElementActionState")) f.controller.abort();
    });
    f.onCommand(method => { if (boundary === "insert" && method === "Input.insertText") f.controller.abort(); });
    await assert.rejects(f.call({ action: "fill", value: "new", submit: true }));
    assert.equal(f.commands.some(command => command.params.key === "Enter"), false);
    assert.equal(f.commands.filter(command => command.method === "Input.insertText").length, boundary === "prepare" ? 0 : 1);
    assertNoReplay(f);
  });
}

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
    assert.equal(unchanged.checked, true);
    assert.equal(unchanged.changed, false);
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

test("an in-view iframe click keeps the shifted point and does not scroll", async () => {
  const f = fixture({ frameId: "child" });
  f.onCommand(method => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: 5 };
    if (method === "DOM.getBoxModel") return frameBox(40);
    if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
  });
  const clicked = await f.call({ action: "click" });
  assert.equal(clicked.clickDispatched, true);
  assert.equal(clicked.inputDelivered, true);
  assert.equal(clicked.element.state.clickablePointInViewport, true);
  assert.equal(clicked.element.inViewport, true);
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
  assert.equal(clicked.code, undefined);
  assert.equal(clicked.clickDispatched, true);
  assert.equal(clicked.inputDelivered, true);
  assert.equal(clicked.element.state.clickablePointInViewport, true);
  assert.equal(f.messages.filter(message => message.action === "scrollElementIntoView").length, 1);
  const release = f.commands.find(command => command.method === "Input.dispatchMouseEvent" && command.params.type === "mouseReleased");
  assert.deepEqual([release.params.x, release.params.y], [28, 100]);
  assert.equal(f.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, 2);
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

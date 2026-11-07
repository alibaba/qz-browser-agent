import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionTabs } from "../../src/background/session/tabs.js";
import { createToolRegistry } from "../../src/background/tools/registry.js";

const targetUrl = "https://example.test/gallery";
let tab, closed, denied, reads, resolves, polls;
let contentReady = true, contentType = "text/html", injectionError;
let documentReady = true, completeDocument;
let ackDelay = 0;
let completeInjection;
let afterResolve;
const injections = [];
const targetQueries = [];
let targetPresence = () => ({ found: true });
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return { securityGuardrails: { blockedDomains: ["blocked.test"] } }; } } },
  tabs: {
    async get() { polls++; if (closed) throw new Error("No tab with id: 1"); return { ...tab }; },
    async sendMessage(_tabId, message) {
      if (message.action === "ping") {
        if (contentReady && ackDelay) await pause(ackDelay);
        return { ok: contentReady, documentReady, contentType, url: tab.url, elementRefs: 1 };
      }
      if (message.action === "elementPresence") { targetQueries.push(message); return targetPresence(message); }
      reads++;
      assert.equal(tab.url, targetUrl, "must never read the initial blank document");
      return { text: "Loaded article", images: [], scanned: 0 };
    },
  },
  scripting: { async executeScript(options) {
    if (options.func?.name === "documentReadiness") {
      completeDocument = () => { documentReady = true; };
      return [{ documentId: "document", result: documentReady }];
    }
    if (!options.files) return [];
    if (injectionError) throw injectionError;
    injections.push(options);
    await new Promise(resolve => { completeInjection = resolve; });
    contentReady = true;
    contentType = 'text/html';
  } },
};
const { createToolRuntime, resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const state = { sessionId: "readiness", ownedTabIds: [1], workingTabId: 1 };
const sessionTabs = createSessionTabs({
  supervisor: { getRuntime: () => state, runtimeEntries: () => [["readiness", state]], isRunCurrent: () => true },
  tabsApi: chrome.tabs, storage: chrome.storage.local,
  setRuntime: (_id, patch) => Object.assign(state, patch), persistRuntime: async () => {},
});
const runtime = createToolRuntime({ sessions: {
  isRunCurrent: () => true,
  async resolveTargetTab(options) {
    resolves++;
    const result = denied ? { ok: false, code: "SESSION_TAB_UNAVAILABLE" }
      : await sessionTabs.resolveTargetTab(options);
    const callback = afterResolve; afterResolve = undefined; callback?.();
    return result;
  },
} });
const context = { sessionId: "readiness", runId: "run", workingTabId: 1, preserveWorkingTab: true };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = () => { tab = { id: 1, url: targetUrl, status: "complete", title: "Gallery" }; };

test('passive navigation observation arms while a replacement document is still pending', async () => {
  load(); closed = denied = false;
  tab.pendingUrl = targetUrl; tab.status = 'loading';
  const listeners = new Set();
  chrome.tabs.onUpdated = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
  const committed = new Set();
  chrome.webNavigation = Object.fromEntries(['onBeforeNavigate', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onErrorOccurred'].map(name =>
    [name, { addListener() {}, removeListener() {} }]));
  chrome.webNavigation.onCommitted = { addListener: fn => committed.add(fn), removeListener: fn => committed.delete(fn) };
  chrome.webNavigation.getFrame = async () => ({ url: tab.url, documentId: 'document', errorOccurred: false });
  const controller = new AbortController();
  const waiting = runtime.execute('wait_for_navigation', { tabId: 1, timeout: 1 }, controller.signal, context);
  try {
    for (let i = 0; !listeners.size && i < 100; i++) await pause(2);
    assert.equal(listeners.size, 1, 'listener must precede the commit, not wait behind it');
    load();
    for (const listener of listeners) listener(1, { status: 'loading' }, tab);
    for (const listener of committed) listener({ tabId: 1, frameId: 0, url: tab.url, documentId: 'document' });
    for (const listener of listeners) listener(1, { status: 'complete' }, tab);
    assert.equal((await waiting).status, 'navigated');
    assert.equal(listeners.size, 0);
  } finally { controller.abort(); await waiting.catch(() => {}); delete chrome.tabs.onUpdated; }
});

for (const name of ["read_article", "list_images"]) for (const pendingUrl of [targetUrl, undefined]) {
  for (const outcome of ["loaded", "cancelled", "timeout", "closed", "access-revoked", "blocked-redirect"]) {
    test(`${name} waits for initial navigation (pendingUrl=${Boolean(pendingUrl)}): ${outcome}`, async () => {
      tab = { id: 1, url: "about:blank", pendingUrl, status: "loading" };
      closed = denied = false;
      reads = resolves = polls = 0;
      const controller = new AbortController();
      let finished = false;
      const result = runtime.execute(name, { tabId: 1, limit: 1200, timeout: outcome === "timeout" ? 0.1 : 2 }, controller.signal, context)
        .then(value => ({ value }), error => ({ error }))
        .then(value => { finished = true; return value; });
      try {
        // Observe two polls so the assertion does not depend on tool setup speed.
        for (let i = 0; polls < 2 && !finished && i < 100; i++) await pause(2);
        if (outcome !== "timeout") assert.equal(finished, false);
        assert.equal(reads, 0);
        if (outcome === "loaded") load();
        if (outcome === "cancelled") controller.abort();
        if (outcome === "closed") closed = true;
        if (outcome === "access-revoked") { denied = true; load(); }
        if (outcome === "blocked-redirect") tab = { id: 1, url: "https://blocked.test/gallery", status: "complete" };
        const settled = await result;
        if (outcome === "loaded") {
          assert.equal(settled.error, undefined);
          assert.equal(reads, 1);
          assert.ok(resolves >= 2, "access must be checked again after waiting");
        } else {
          assert.ok(settled.error, `${outcome} must fail`);
          assert.equal(settled.value, undefined, "an unsuccessful read must not return business data");
          if (outcome !== "closed") assert.equal(settled.error.code, {
            cancelled: "OPERATION_ABORTED", timeout: "TOOL_TIMEOUT", "access-revoked": "SESSION_TAB_UNAVAILABLE",
            "blocked-redirect": "SECURITY_GUARDRAIL_BLOCKED",
          }[outcome]);
          if (outcome === "timeout" && name === "read_article") {
            assert.equal(settled.error.details.pageState.url, "about:blank");
            assert.equal(settled.error.details.pageState.pendingUrl, pendingUrl || "");
            assert.equal(settled.error.details.pageState.readyState, "unknown", "tab loading does not imply document readiness");
            assert.equal(typeof settled.error.details.pending, "string");
          }
          closed = false;
          load();
          await pause(70);
          assert.equal(reads, 0, "a cancelled, timed out or rejected read must not resume after navigation");
        }
      } finally {
        controller.abort();
        await result;
        await pause(60);
      }
    });
  }
}

test('a pre-upgrade content bridge is replaced before reading', async () => {
  load(); closed = denied = false; contentReady = documentReady = true;
  contentType = undefined; completeInjection = undefined;
  const before = injections.length;
  const pending = runtime.execute('read_article', { tabId: 1, limit: 1200 }, undefined, context);
  for (let i = 0; !completeInjection && i < 100; i++) await pause(2);
  assert.equal(injections.length, before + 1);
  completeInjection();
  assert.equal((await pending).text, 'Loaded article');
});

test('PDF content cannot succeed as an empty HTML article; injection denial has recovery', async () => {
  load(); closed = denied = false; contentReady = documentReady = true; reads = 0;
  try {
    contentType = 'application/pdf';
    await assert.rejects(runtime.execute('read_article', { tabId: 1, limit: 1200 }, undefined, context), error => {
      assert.equal(error.code, 'PDF_PAGE_UNSUPPORTED');
      assert.match(error.message, /PDF/);
      assert.match(error.message, /HTML/);
      assert.equal(error.hint, undefined);
      assert.equal(error.details.url, tab.url);
      return true;
    });
    assert.equal(reads, 0);
    contentType = 'text/html'; contentReady = false;
    injectionError = new Error('Cannot access contents of the page.');
    await assert.rejects(runtime.execute('read_article', { tabId: 1, limit: 1200 }, undefined, context), error => {
      assert.equal(error.code, 'PAGE_CONTENT_UNAVAILABLE');
      assert.match(error.message, /qingzhou-documents/);
      return true;
    });
    assert.equal(reads, 0);
  } finally { contentType = 'text/html'; contentReady = true; injectionError = undefined; }
  assert.equal((await runtime.execute('read_article', { tabId: 1, limit: 1200 }, undefined, context)).text, 'Loaded article');
});

const pageReaders = [
  ["read_article", { limit: 1200 }], ["read_dom", {}], ["find_elements", {}],
  ["inspect_element", { target: "css:body" }], ["list_images", {}],
  ["read_image", { target: "css:img" }], ["get_ax_tree", {}], ["screenshot", {}],
];
for (const [name, args] of pageReaders) {
  for (const url of ["", "about:blank"]) test(`${name} keeps a loading blank tab without pendingUrl until its deadline (${JSON.stringify(url)})`, async () => {
    tab = { id: 1, url, status: "loading" }; closed = denied = false; reads = 0;
    const result = await runtime.execute(name, { ...args, tabId: 1, timeout: 0.1 }, undefined, context)
      .then(value => ({ value }), error => ({ error }));
    assert.equal(result.error?.code, "TOOL_TIMEOUT");
    assert.equal(result.value, undefined);
    if (!["list_images", "read_image"].includes(name)) {
      assert.equal(result.error.details.pageState.loading, true);
      assert.equal(typeof result.error.details.pending, "string");
    }
    load(); await pause(70);
    assert.equal(reads, 0, "deadline cannot revive a read after the page commits");
  });
}

for (const finalUrl of ["about:blank", "chrome://settings", "https://blocked.test/gallery"]) {
  test(`reader rechecks a page that settles before its first readiness poll: ${finalUrl}`, async () => {
    tab = { id: 1, url: "about:blank", status: "loading" }; closed = denied = false; reads = 0;
    afterResolve = () => { tab = { id: 1, url: finalUrl, status: "complete" }; };
    await assert.rejects(runtime.execute("read_article", { tabRef: 1, limit: 1200 }, undefined, context), {
      code: finalUrl.startsWith("https:") ? "SECURITY_GUARDRAIL_BLOCKED" : "SESSION_TAB_NOT_WEB",
    });
    assert.equal(reads, 0);
  });
}

for (const outcome of ['ready', 'cancelled', 'timeout']) test(`a parsed-document gate protects late-body reads: ${outcome}`, async () => {
  load(); closed = denied = false; reads = 0; contentReady = true; documentReady = false; completeDocument = undefined;
  const controller = new AbortController();
  let done = false;
  const pending = runtime.execute('read_article', { tabId: 1, limit: 1200, timeout: 1 }, controller.signal, context)
    .then(value => ({ value }), error => ({ error })).finally(() => { done = true; });
  try {
    for (let attempt = 0; !completeDocument && attempt < 100; attempt++) await pause(2);
    assert.equal(typeof completeDocument, 'function');
    assert.equal(done, false); assert.equal(reads, 0);
    if (outcome === 'ready') completeDocument();
    if (outcome === 'cancelled') controller.abort();
    const result = await pending;
    if (outcome === 'ready') { assert.equal(result.value.text, 'Loaded article'); assert.equal(reads, 1); }
    else {
      if (outcome === 'cancelled') assert.equal(result.error.code, 'OPERATION_ABORTED');
      else {
        assert.equal(result.error.code, 'TOOL_TIMEOUT');
        assert.equal(result.error.details.pageState.url, targetUrl);
        assert.equal(result.value, undefined);
      }
      completeDocument(); await pause(20);
      assert.equal(reads, 0, 'late DOM readiness never revives cancelled extraction');
    }
  } finally { controller.abort(); completeDocument?.(); documentReady = true; await pending; }
});

test("ordinary Content initialization immediately targets the main frame and reuses its bridge", async () => {
  closed = denied = false;
  reads = 0;
  contentReady = false; completeInjection = undefined; injections.length = 0;
  load();
  const pending = runtime.execute("read_article", { tabId: 1, limit: 1200 }, undefined, context);
  try {
    for (let attempt = 0; !completeInjection && attempt < 100; attempt++) await pause(2);
    assert.equal(typeof completeInjection, "function", "a missing Content script must be initialized");
    assert.deepEqual(injections, [{
      target: { tabId: 1, frameIds: [0] }, world: "ISOLATED",
      files: ["content/article-extractor.js", "content/content-script.js"], injectImmediately: true,
    }]);
    assert.equal(reads, 0, "the page read must wait for injection to finish");
    completeInjection();
    await pending;
    assert.equal(reads, 1);
    await runtime.execute("read_article", { tabId: 1, limit: 1200 }, undefined, context);
    assert.equal(injections.length, 1, "an acknowledged Content script is reused");
  } finally {
    completeInjection?.();
    await pending;
  }
});

test("slow Content installation and acknowledgement can finish within the tool deadline", async () => {
  closed = denied = false;
  reads = 0; contentReady = false; completeInjection = undefined; ackDelay = 200;
  load();
  let settled = false;
  const pending = runtime.execute("read_article", { tabId: 1, limit: 1200, timeout: 5 }, undefined, context)
    .then(value => ({ value }), error => ({ error })).then(result => { settled = true; return result; });
  try {
    for (let attempt = 0; !completeInjection && attempt < 100; attempt++) await pause(2);
    assert.equal(typeof completeInjection, "function");
    await pause(1600);
    assert.equal(settled, false, "installation has no independent 1500ms cutoff");
    completeInjection();
    const result = await pending;
    assert.equal(result.error, undefined);
    assert.equal(result.value.text, "Loaded article");
    assert.equal(reads, 1, "a slow post-install ack still permits the read");
  } finally { ackDelay = 0; completeInjection?.(); await pending; }
});

test("cancelled Content installation cannot dispatch a late page read", async () => {
  closed = denied = false;
  reads = 0; contentReady = false; completeInjection = undefined;
  load();
  const controller = new AbortController();
  const pending = runtime.execute("read_article", { tabId: 1, limit: 1200 }, controller.signal, context);
  const rejected = assert.rejects(pending, { code: "OPERATION_ABORTED" });
  try {
    for (let attempt = 0; !completeInjection && attempt < 100; attempt++) await pause(2);
    assert.equal(typeof completeInjection, "function");
    controller.abort();
    await rejected;
    completeInjection();
    await pause(20);
    assert.equal(reads, 0);
  } finally { controller.abort(); completeInjection?.(); await rejected; }
});


function targetedFixture(name) {
  load(); tab.status = "loading"; closed = denied = false; reads = 0;
  contentReady = true; contentType = "text/html"; documentReady = false; completeDocument = undefined;
  targetQueries.length = 0; targetPresence = () => ({ found: false });
  const dispatched = [], registry = createToolRegistry();
  registry.forCapability("readiness-probe")({ ...resolveToolDefinition(name), execute(args) {
    dispatched.push(args); return { executed: true };
  } });
  return { dispatched, context: { ...context, toolRegistrySnapshot: registry.snapshot() } };
}

test("legacy page Skill target remains an execution mode with its original barrier", async () => {
  const fixture = targetedFixture("run_skill_script");
  const behavior = resolveToolDefinition("run_skill_script").behavior;
  assert.equal(behavior.barrier, true); assert.equal(behavior.orchestration, undefined);
  const result = await runtime.execute("run_skill_script", {
    tabRef: 1, target: "page", skill: "fixture", script: "legacy.js", timeout: 1,
  }, undefined, fixture.context);
  assert.equal(result.executed, true); assert.equal(fixture.dispatched.length, 1);
  assert.equal(targetQueries.length, 0); assert.equal(completeDocument, undefined); assert.equal(documentReady, false);
  documentReady = true;
});

for (const targetLookup of [undefined, "light"]) test(`custom target preparation follows its declared lookup: ${targetLookup || "business"}`, async () => {
  targetedFixture("inspect_element");
  const registry = createToolRegistry(), calls = [];
  registry.forCapability("business-target")({
    name: "save_target", description: "Save a business record.", page: "owned",
    behavior: { ...(targetLookup ? { targetLookup } : {}), timeoutResult: { kind: "action", pending: "record update" } },
    parameters: { type: "object", properties: { tabRef: { type: "integer" }, target: { type: "string", enum: ["#record"] } }, required: ["tabRef", "target"] },
    execute: args => { calls.push(args); return { saved: args.target }; },
  });
  const pending = runtime.execute("save_target", { tabRef: 1, target: "#record", timeout: 1 }, undefined,
    { ...context, toolRegistrySnapshot: registry.snapshot() });
  if (targetLookup) {
    await until(() => typeof completeDocument === "function");
    assert.equal(calls.length, 0, "CSS enums still prepare their declared locator");
    completeDocument();
  }
  const result = await pending;
  assert.equal(result.saved, "#record"); assert.equal(calls.length, 1);
  assert.equal(targetQueries.length, targetLookup ? 1 : 0);
  if (!targetLookup) { assert.equal(completeDocument, undefined); assert.equal(documentReady, false); }
  documentReady = true;
});

async function until(condition) {
  for (let attempt = 0; !condition() && attempt < 200; attempt++) await pause(2);
  assert.ok(condition(), "expected readiness stage was reached");
}

for (const name of ["inspect_element", "find_elements", "act_on_element"]) {
  for (const outcome of ["ready", "cancelled", "timeout"]) test(`CSS ${name} preparation before dispatch: ${outcome}`, async () => {
    const fixture = targetedFixture(name), controller = new AbortController();
    const pending = runtime.execute(name, { tabRef: 1, target: "css:#late", timeout: 0.3,
      ...(name === "act_on_element" ? { action: "fill", value: "once" } : {}) }, controller.signal, fixture.context)
      .then(value => ({ value }), error => ({ error }));
    try {
      await until(() => typeof completeDocument === "function");
      assert.equal(fixture.dispatched.length, 0, "lookup preparation must precede the operation");
      assert.equal(targetQueries.length, 1);
      assert.equal(targetQueries[0].queryOnly, true, "preparation must not create observation refs");
      if (outcome === "ready") completeDocument();
      if (outcome === "cancelled") controller.abort();
      const result = await pending;
      if (outcome === "ready") {
        assert.equal(result.error, undefined);
        assert.equal(result.value.executed, true); assert.equal(fixture.dispatched.length, 1);
      } else {
        if (outcome === "cancelled") assert.equal(result.error.code, "OPERATION_ABORTED");
        else {
          if (name === "act_on_element") {
            assert.equal(result.error, undefined);
            assert.equal(result.value.code, "TOOL_TIMEOUT");
            assert.equal(result.value.details.status, "not_started");
            assert.equal(result.value.details.executed, false);
            assert.equal(result.value.details.mayHaveTakenEffect, false);
            assert.equal(result.value.details.automaticReplay, false);
          } else {
            assert.equal(result.error.code, "TOOL_TIMEOUT");
            assert.equal(result.error.details.pageState.url, targetUrl);
            assert.equal(typeof result.error.details.pending, "string");
            assert.equal(result.value, undefined);
          }
        }
        completeDocument(); await pause(20);
        assert.equal(fixture.dispatched.length, 0, "late parsing must never revive cancelled execution");
      }
    } finally { controller.abort(); completeDocument?.(); documentReady = true; await pending; }
  });
}

for (const name of ["inspect_element", "act_on_element"]) test(`existing CSS ${name} target remains usable during parsing`, async () => {
  const fixture = targetedFixture(name);
  targetPresence = () => ({ found: true });
  const result = await runtime.execute(name, { tabRef: 1, target: "css:#early", timeout: 0.3,
    ...(name === "act_on_element" ? { action: "fill", value: "once" } : {}) }, undefined, fixture.context);
  assert.equal(result.executed, true); assert.equal(documentReady, false); assert.equal(completeDocument, undefined);
  assert.equal(fixture.dispatched.length, 1);
  documentReady = true;
});

for (const status of ["loading", "complete"]) test(`CSS preparation does not wait after parsing: ${status}`, async () => {
  const fixture = targetedFixture("inspect_element"); documentReady = true; tab.status = status;
  const result = await runtime.execute("inspect_element", { tabRef: 1, target: "css:#missing", timeout: 0.3 }, undefined, fixture.context);
  assert.equal(result.executed, true); assert.equal(fixture.dispatched.length, 1);
  assert.equal(targetQueries.length, 1, "CSS preparation follows the document, not the tab load status");
});

test("a complete tab still prepares CSS against its unparsed committed document", async () => {
  const fixture = targetedFixture("inspect_element"), controller = new AbortController();
  tab.status = "complete";
  const pending = runtime.execute("inspect_element", { tabRef: 1, target: "css:#late", timeout: 1 }, controller.signal, fixture.context);
  try {
    await until(() => typeof completeDocument === "function");
    assert.equal(fixture.dispatched.length, 0); assert.equal(targetQueries.length, 1);
    completeDocument();
    assert.equal((await pending).executed, true); assert.equal(fixture.dispatched.length, 1);
  } finally { controller.abort(); completeDocument?.(); documentReady = true; await pending; }
});

test("CSS action admission tolerates a new tab pending its first document", async () => {
  const fixture = targetedFixture("act_on_element"), controller = new AbortController();
  tab.url = "about:blank"; tab.pendingUrl = targetUrl; targetPresence = () => ({ found: true });
  let done = false;
  const pending = runtime.execute("act_on_element", { tabRef: 1, target: "css:#early", action: "fill", value: "once", timeout: 1 },
    controller.signal, fixture.context).finally(() => { done = true; });
  try {
    await pause(20); assert.equal(done, false); assert.equal(fixture.dispatched.length, 0);
    tab.url = targetUrl; delete tab.pendingUrl;
    assert.equal((await pending).executed, true); assert.equal(fixture.dispatched.length, 1);
  } finally { controller.abort(); documentReady = true; await pending; }
});

for (const name of ["inspect_element", "find_elements"]) test(`CSS ${name} retains its declared lookup scope`, async () => {
  const fixture = targetedFixture(name), controller = new AbortController();
  targetPresence = message => ({ found: message.includeShadow });
  const pending = runtime.execute(name, { tabRef: 1, target: "css:#shadow-only", timeout: 0.3 }, controller.signal, fixture.context)
    .then(value => ({ value }), error => ({ error }));
  try {
    await until(() => targetQueries.length === 1);
    assert.equal(targetQueries[0].includeShadow, name === "find_elements");
    if (name === "find_elements") { assert.equal((await pending).value.executed, true); assert.equal(documentReady, false); }
    else {
      await until(() => typeof completeDocument === "function");
      assert.equal(fixture.dispatched.length, 0); controller.abort();
      assert.equal((await pending).error.code, "OPERATION_ABORTED");
    }
  } finally { controller.abort(); completeDocument?.(); documentReady = true; await pending; }
});

for (const state of ["hidden", "detached"]) test(`passive ${state} observation bypasses CSS preparation`, async () => {
  targetedFixture("wait_for_element");
  const result = await runtime.execute("wait_for_element", { tabRef: 1, target: "css:#not-yet-parsed", state, timeout: 0.3 }, undefined, context);
  assert.equal(result.found, false); assert.equal(result.state, state);
  assert.equal(documentReady, false); assert.equal(completeDocument, undefined);
  assert.equal(targetQueries.length, 1); assert.equal(targetQueries[0].queryOnly, undefined);
  documentReady = true;
});

for (const violation of ["ownership", "security"]) test(`CSS preparation revalidates ${violation} before execution`, async () => {
  const fixture = targetedFixture("act_on_element"), controller = new AbortController();
  const pending = runtime.execute("act_on_element", { tabRef: 1, target: "css:#late", action: "fill", value: "never", timeout: 1 },
    controller.signal, fixture.context);
  const rejected = assert.rejects(pending, { code: violation === "ownership" ? "SESSION_TAB_UNAVAILABLE" : "SECURITY_GUARDRAIL_BLOCKED" });
  try {
    await until(() => typeof completeDocument === "function");
    if (violation === "ownership") denied = true;
    else tab.url = "https://blocked.test/after-parsing";
    completeDocument(); await rejected;
    assert.equal(fixture.dispatched.length, 0);
  } finally { controller.abort(); denied = false; documentReady = true; await rejected; }
});

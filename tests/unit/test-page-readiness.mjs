import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionTabs } from "../../src/background/session/tabs.js";

const targetUrl = "https://example.test/gallery";
let tab, closed, denied, reads, resolves, polls;
let contentReady = true;
let documentReady = true, completeDocument;
let ackDelay = 0;
let completeInjection;
let afterResolve;
const injections = [];
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return { securityGuardrails: { blockedDomains: ["blocked.test"] } }; } } },
  tabs: {
    async get() { polls++; if (closed) throw new Error("No tab with id: 1"); return { ...tab }; },
    async sendMessage(_tabId, message) {
      if (message.action === "ping") {
        if (contentReady && ackDelay) await pause(ackDelay);
        return { ok: contentReady, documentReady };
      }
      if (message.action === 'awaitDocument') return new Promise(resolve => { completeDocument = () => { documentReady = true; resolve({ ok: true }); }; });
      reads++;
      assert.equal(tab.url, targetUrl, "must never read the initial blank document");
      return { text: "Loaded article", images: [], scanned: 0 };
    },
  },
  scripting: { async executeScript(options) {
    if (!options.files) return [];
    injections.push(options);
    await new Promise(resolve => { completeInjection = resolve; });
    contentReady = true;
  } },
};
const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
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
          if (outcome === "timeout" && name === "read_article") {
            assert.equal(settled.error, undefined);
            assert.equal(settled.value.incomplete.reason, "timeout");
            assert.equal(settled.value.pageState.url, "about:blank");
            assert.equal(settled.value.pageState.pendingUrl, pendingUrl || "");
            assert.equal(settled.value.pageState.readyState, "unknown", "tab loading does not imply document readiness");
          } else {
            assert.ok(settled.error, `${outcome} must fail`);
            if (outcome !== "closed") assert.equal(settled.error.code, {
              cancelled: "OPERATION_ABORTED", timeout: "TOOL_TIMEOUT", "access-revoked": "SESSION_TAB_UNAVAILABLE",
              "blocked-redirect": "SECURITY_GUARDRAIL_BLOCKED",
            }[outcome]);
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
    if (["list_images", "read_image"].includes(name)) assert.equal(result.error?.code, "TOOL_TIMEOUT");
    else {
      assert.equal(result.error, undefined);
      assert.equal(result.value.incomplete.reason, "timeout");
      assert.equal(result.value.pageState.loading, true);
    }
    load(); await pause(70);
    assert.equal(reads, 0, "deadline cannot revive a read after the page commits");
  });
}

for (const finalUrl of ["about:blank", "chrome://settings", "https://blocked.test/gallery"]) {
  test(`reader rechecks a page that settles before its first readiness poll: ${finalUrl}`, async () => {
    tab = { id: 1, url: "about:blank", status: "loading" }; closed = denied = false; reads = 0;
    afterResolve = () => { tab = { id: 1, url: finalUrl, status: "complete" }; };
    await assert.rejects(runtime.execute("read_article", { limit: 1200 }, undefined, context), {
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
      else assert.equal(result.value.incomplete.reason, 'timeout');
      completeDocument(); await pause(20);
      assert.equal(reads, 0, 'late DOM readiness never revives cancelled extraction');
    }
  } finally { controller.abort(); completeDocument?.(); documentReady = true; await pending; }
});

test("ordinary Content initialization immediately targets the main frame and reuses its bridge", async () => {
  closed = denied = false;
  reads = 0;
  contentReady = false;
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

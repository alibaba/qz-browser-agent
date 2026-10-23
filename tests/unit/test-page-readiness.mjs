import assert from "node:assert/strict";
import { test } from "node:test";

const targetUrl = "https://example.test/gallery";
let tab, closed, denied, reads, resolves, polls;
let contentReady = true;
let completeInjection;
const injections = [];
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return { securityGuardrails: { blockedDomains: ["blocked.test"] } }; } } },
  tabs: {
    async get() { polls++; if (closed) throw new Error("No tab with id: 1"); return { ...tab }; },
    async sendMessage(_tabId, message) {
      if (message.action === "ping") return { ok: contentReady };
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
const runtime = createToolRuntime({ sessions: {
  isRunCurrent: () => true,
  async resolveTargetTab() {
    resolves++;
    return denied ? { ok: false, code: "SESSION_TAB_UNAVAILABLE" }
      : { ok: true, tabId: 1, tab: { ...tab }, ownedByCurrentTask: true };
  },
} });
const context = { sessionId: "readiness", runId: "run", workingTabId: 1 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = () => { tab = { id: 1, url: targetUrl, status: "complete", title: "Gallery" }; };

for (const name of ["read_article", "list_images"]) {
  for (const outcome of ["loaded", "cancelled", "timeout", "closed", "access-revoked", "blocked-redirect"]) {
    test(`${name} waits for initial navigation: ${outcome}`, async () => {
      tab = { id: 1, url: "about:blank", pendingUrl: targetUrl, status: "loading" };
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
          if (outcome !== "closed") assert.equal(settled.error.code, {
            cancelled: "OPERATION_ABORTED", timeout: "TOOL_TIMEOUT", "access-revoked": "SESSION_TAB_UNAVAILABLE",
            "blocked-redirect": "SECURITY_GUARDRAIL_BLOCKED",
          }[outcome]);
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

test("ordinary Content initialization waits for document_idle before reading", async () => {
  closed = denied = false;
  reads = 0;
  contentReady = false;
  load();
  const pending = runtime.execute("read_article", { tabId: 1, limit: 1200 }, undefined, context);
  try {
    for (let attempt = 0; !completeInjection && attempt < 100; attempt++) await pause(2);
    assert.equal(typeof completeInjection, "function", "a missing Content script must be initialized");
    assert.deepEqual(injections, [{
      target: { tabId: 1, allFrames: true }, world: "ISOLATED",
      files: ["content/article-extractor.js", "content/content-script.js"], injectImmediately: false,
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

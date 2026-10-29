import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { createSessionTabs } from "../../src/background/session/tabs.js";

let fixture;
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  storage: { local: { async get() { return { securityGuardrails: { blockedDomains: ["blocked.test"] } }; } } },
  tabs: {
    async get(id) {
      const tab = fixture.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    },
    async sendMessage(id, message) {
      if (message.action === "ping") return { ok: true, documentReady: true };
      const tab = fixture.tabs.get(id);
      const observation = { id, url: tab.url, pendingUrl: tab.pendingUrl, run: fixture.run, time: Date.now() };
      fixture.reads.push(observation);
      assert.match(tab.url, /^https:\/\/allowed\.test\//, "never extract a blank or restricted document");
      assert.ok(!tab.pendingUrl, "never extract the old document while replacement navigation is pending");
      assert.equal(fixture.run, "run", "an obsolete run cannot extract");
      return { text: `DOCUMENT ${tab.url}` };
    },
  },
  scripting: { async executeScript() { return []; } },
};
const { createToolRuntime } = await import("../../src/background/tools/runtime.js");

function random(seed) {
  let state = seed >>> 0;
  return max => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
}

const seeds = [1, 17, 20261029, 0x9e3779b9];
const outcomes = ["commit", "timeout", "cancel", "close", "obsolete-run", "delete-session", "blocked", "internal", "blank-complete", "replace", "deadline-race"];
const starts = ["empty", "blank", "blank-pending", "old-pending", "reload"];
const plans = [
  ...seeds.map(seed => ({ seed, kind: "lifecycle", outcomes })),
  ...[73, 65537, 20261031].map(seed => ({ seed, kind: "combinations", outcomes: ["chain-commit", "chain-cancel", "chain-close", "chain-obsolete-run", "chain-blocked", "chain-timeout", "chain-deadline-race"] })),
];

for (const { seed, kind, outcomes } of plans) test(`page readiness ${kind} fuzz seed=${seed}`, async t => {
  const choose = random(seed);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let cases = 0;
  for (const start of starts) for (const outcome of outcomes) {
    const label = `seed=${seed} start=${start} outcome=${outcome}`;
    const chained = outcome.startsWith("chain-"), terminal = chained ? outcome.slice(6) : outcome;
    const began = Date.now(), eventAt = outcome === "deadline-race" ? 999 + choose(3) : 1 + choose(180);
    const oldUrl = `https://allowed.test/${seed}/old`;
    const target = start === "reload" ? oldUrl : `https://allowed.test/${seed}/new`;
    const finalTarget = chained ? `${target}-final` : target;
    const tab = { id: 1, url: start === "empty" ? "" : start.startsWith("old") || start === "reload" ? oldUrl : "about:blank", status: "loading" };
    if (!["empty", "blank"].includes(start)) tab.pendingUrl = target;
    const state = { sessionId: "fuzz", ownedTabIds: [1, 2], workingTabId: 1, tabAliases: { loading: 1, fast: 2 } };
    fixture = { tabs: new Map([[1, tab], [2, { id: 2, url: "https://allowed.test/independent", status: "loading" }]]), reads: [], run: "run", state };
    const isRunCurrent = (_id, runId) => fixture.run === runId && Boolean(fixture.state);
    const sessions = createSessionTabs({
      supervisor: { getRuntime: () => fixture.state, runtimeEntries: () => fixture.state ? [["fuzz", state]] : [], isRunCurrent },
      tabsApi: chrome.tabs, storage: chrome.storage.local,
      setRuntime: (_id, patch) => Object.assign(state, patch), persistRuntime: async () => {},
    });
    const runtime = createToolRuntime({ sessions: { ...sessions, isRunCurrent } });
    const controller = new AbortController();
    const context = { sessionId: "fuzz", runId: "run", preserveWorkingTab: true, workingTabId: 1 };
    let result;
    const pending = runtime.execute("read_article", { tabRef: choose(2) ? "loading" : 1, limit: 100, timeout: 1 }, controller.signal, context)
      .then(value => { result = { value }; }, error => { result = { error }; });
    const commit = url => fixture.tabs.set(1, { id: 1, url, status: choose(2) ? "loading" : "complete" });
    const apply = () => {
      switch (terminal) {
        case "commit": case "deadline-race": commit(finalTarget); break;
        case "cancel": controller.abort(); break;
        case "close": fixture.tabs.delete(1); break;
        case "obsolete-run": fixture.run = "replacement-run"; commit(finalTarget); break;
        case "delete-session": fixture.state = null; controller.abort(); break;
        case "blocked": commit("https://blocked.test/redirect"); break;
        case "internal": commit("chrome://settings"); break;
        case "blank-complete": fixture.tabs.set(1, { id: 1, url: "about:blank", status: "complete" }); break;
        case "replace": tab.pendingUrl = `${target}-replacement`; setTimeout(() => commit(`${target}-replacement`), 1 + choose(80)); break;
      }
    };
    setTimeout(() => {
      if (!chained) { apply(); return; }
      tab.pendingUrl = `${target}-intermediate`;
      const nextAt = terminal === "deadline-race" ? 999 + choose(3) - eventAt : 1 + choose(80);
      setTimeout(() => { tab.pendingUrl = finalTarget; apply(); }, nextAt);
    }, eventAt);
    // A loaded document with slow subresources is independently readable.
    const fast = await runtime.execute("read_article", { tabRef: "fast", limit: 100, timeout: 1 }, undefined, context);
    assert.equal(fast.text, "DOCUMENT https://allowed.test/independent", label);
    for (let elapsed = 0; !result && elapsed < 1300; elapsed++) {
      t.mock.timers.tick(1);
      await turn();
    }
    assert.ok(result, `${label}: must settle within its own budget`);
    await pending;
    const reads = fixture.reads.filter(read => read.id === 1);
    if (["commit", "replace"].includes(terminal)) {
      assert.equal(result.error, undefined, `${label}: ${result.error?.stack}`);
      assert.equal(result.value.text, `DOCUMENT ${terminal === "replace" ? `${target}-replacement` : finalTarget}`, label);
      assert.equal(reads.length, 1, label);
    } else if (terminal === "deadline-race" && result.value?.text) {
      assert.equal(result.value.text, `DOCUMENT ${finalTarget}`, label);
      assert.equal(reads.length, 1, label);
    } else {
      assert.equal(reads.length, 0, `${label}: rejected or timed out calls never extract`);
      if (terminal === "timeout" || terminal === "deadline-race") assert.equal(result.value?.incomplete?.reason, "timeout", label);
      else if (["cancel", "obsolete-run", "delete-session"].includes(terminal)) assert.equal(result.error?.code, "OPERATION_ABORTED", label);
      else if (terminal === "blocked") assert.equal(result.error?.code, "SECURITY_GUARDRAIL_BLOCKED", label);
      else if (terminal === "internal" || terminal === "blank-complete") assert.equal(result.error?.code, "SESSION_TAB_NOT_WEB", label);
      else assert.ok(result.error, label);
    }
    assert.ok(Date.now() - began <= 1150, `${label}: readiness cannot extend the tool deadline`);
    // Drive every late timer after settlement and commit an allowed page. No late
    // poll is permitted to revive extraction, even after cancellation or timeout.
    controller.abort();
    t.mock.timers.tick(1400); await turn();
    fixture.state = state; fixture.run = "run"; commit(target);
    t.mock.timers.tick(100); await turn();
    assert.equal(fixture.reads.filter(read => read.id === 1).length, reads.length, label);
    cases++;
  }
  t.diagnostic(`${cases} scheduled lifecycle cases; independent reads, deadline bounds and late callbacks checked in every case`);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { registerTabsNavigationTools } from "../../src/capabilities/tabs/tools.js";
import { pageModeStates } from "../../src/capabilities/tabs/page-mode.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";
import { navigationDocuments } from "../support/navigation-documents.mjs";

for (const mode of ["desktop", "mobile"])
for (const phase of ["before", "create", "claim", "watch", "navigate", "claim-failure", "success", ...(mode === "mobile" ? ["emulate", "emulate-failure"] : [])]) {
  test(`open_tab ${mode} preserves ownership and cleanup at ${phase}`, async () => {
    pageModeStates.clear();
    const controller = new AbortController();
    const navigation = navigationDocuments();
    let tab;
    const events = [];
    const context = { sessionId: "owner", runId: "run", workingTabId: 9, sourceWindowId: 4 };
    const binding = Symbol("private host binding");
    Object.defineProperty(context, binding, { value: "preserved" });
    const watchNetwork = ["watch", "navigate", "success"].includes(phase);
    const abortAt = name => { if (phase === name) controller.abort(); };
    globalThis.chrome = {
      storage: { local: { async get() { return {}; } } },
      tabs: {
        async get() { return { ...tab }; },
        async create(options) { events.push(["create", options]); abortAt("create"); return tab = { id: 42, windowId: 4, url: options.url }; },
        async update(id, options) { events.push(["navigate", id, options]); abortAt("navigate"); Object.assign(tab, options); navigation.commit(id); return { ...tab }; },
        async remove(id) { events.push(["remove", id]); },
      },
      scripting: { async executeScript({ target }) { return navigation.result(target.tabId); } },
    };
    let openTab;
    registerTabsNavigationTools({
      registerTool: definition => { if (definition.name === "open_tab") openTab = definition; },
      ToolExecutionError,
      getDebuggerConnectionId: () => 1,
      setDebuggerRetention() {},
      releaseDebugger: async () => {},
      async withDebugger(id, fn, actual) {
        assert.equal(actual[binding], "preserved");
        assert.equal(actual.sessionId, context.sessionId);
        assert.equal(actual.runId, context.runId);
        assert.equal(actual.allowPreNavigationBlank, true);
        events.push(["emulate", id]);
        abortAt("emulate");
        if (phase === "emulate-failure") throw new Error("emulation failed");
        return fn({ tabId: id }, async method => {
          if (method === "Runtime.evaluate") return { result: { value: "Chrome/149.0.0.0" } };
          assert.notEqual(method, "Page.reload", "first navigation must not reload");
          return {};
        });
      },
      makeSessionTabTargetError: (code, details) => new ToolExecutionError(code, code, details),
      assertTabAllowed() {}, assertUrlAllowed() {}, async assertPageUrlAccessible() {},
      getToolRuntimeDependencies(actual) {
        assert.equal(actual, context);
        return {
          windowTarget: { async resolveForNewTab(input) { events.push(["window", input]); return 4; } },
          sessions: { async updateWorkingTab(input) {
            events.push(["claim", input]);
            abortAt("claim");
            if (phase === "claim-failure") throw new Error("claim failed");
          } },
        };
      },
      async enablePreNavigationNetworkWatch(id, options, actual) {
        assert.equal(actual, context);
        events.push(["watch", id, options]); abortAt("watch"); return { watching: true };
      },
    });
    abortAt("before");
    const operation = openTab.execute({ url: "https://example.com/target", mode, watchNetwork }, controller.signal, context);
    if (phase === "success") {
      assert.deepEqual(await operation, { id: 42, url: "https://example.com/target", pageMode: mode, networkWatch: { watching: true } });
    } else {
      await assert.rejects(operation, error => phase === "claim-failure" ? error.message === "claim failed" : error.code === (phase === "emulate-failure" ? "PAGE_MODE_FAILED" : "OPERATION_ABORTED"));
    }
    if (phase === "before") { assert.deepEqual(events, []); return; }
    const claim = events.find(event => event[0] === "claim")?.[1];
    if (phase === "create") assert.equal(claim, undefined, "cancellation while creating must not claim a tab");
    else {
      assert.equal(claim.sessionId, "owner");
      assert.equal(claim.runId, "run");
      assert.equal(claim.signal, controller.signal);
      assert.equal(claim.tab.id, 42);
      assert.equal(claim.createdTab, true);
      assert.equal(claim.claim, true);
    }
    assert.deepEqual(events[0], ["window", { anchorTabId: 9, sourceWindowId: 4 }]);
    assert.deepEqual(events[1], ["create", { windowId: 4, url: "about:blank", active: false }]);
    assert.deepEqual(events.filter(event => event[0] === "remove"), phase === "success" ? [] : [["remove", 42]]);
    assert.equal(events.some(event => event[0] === "navigate"), phase === "navigate" || phase === "success");
    if (phase === "success" && mode === "mobile") {
      assert.deepEqual(events.map(event => event[0]), ["window", "create", "claim", "emulate", "watch", "navigate"]);
    }
  });
}

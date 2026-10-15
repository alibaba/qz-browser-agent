import assert from "node:assert/strict";

const queries = [];
globalThis.chrome = {
  storage: {
    local: {
      async get() { return {}; },
    },
  },
};

const { createSessionBrowserContextCollector } = await import(
  "../../src/background/session/browser-context.js"
);

const collector = createSessionBrowserContextCollector({
  tabs: {
    async query(query) {
      queries.push({ ...query });
      return query.windowId === 8
        ? [{ id: 81, windowId: 8, active: true, title: "Visible in source", url: "https://visible.example/" }]
        : [{ id: 91, windowId: 9, active: true, title: "Other window", url: "https://other.example/" }];
    },
  },
  normalizeSessionId: value => String(value || ""),
  supervisor: { getRuntime: () => ({}) },
  canUseSessionGoal: async () => false,
  getOwnedTabContexts: async () => [],
  findOwnedTabOwner: tabId => tabId === 81 ? { sessionId: "s1" } : null,
  ownsTab: (_sessionId, tabId) => tabId === 81,
  getWorkingTabContext: async () => null,
  getRuntime: () => ({}),
});

const sourceContext = await collector.collect("s1", { sourceWindowId: 8 });
assert.equal(sourceContext.sourceWindowId, 8);
assert.equal(sourceContext.userVisibleTab.id, 81);
assert.equal(sourceContext.userVisibleTab.ownedByCurrentTask, true);
assert.equal(sourceContext.userVisibleTab.ownerSessionId, "s1");
assert.deepEqual(queries, [{ active: true, windowId: 8 }]);

const backgroundContext = await collector.collect("s1");
assert.equal(Object.hasOwn(backgroundContext, "sourceWindowId"), false);
assert.equal(Object.hasOwn(backgroundContext, "userVisibleTab"), false);
assert.deepEqual(queries, [{ active: true, windowId: 8 }], "background runs must not infer a global current window");

console.log("session browser context tests passed");

let grant = false;
const fileCollector = createSessionBrowserContextCollector({
  isAllowedFileSchemeAccess: async () => { if (grant === null) throw new Error('unavailable'); return grant; },
  tabs: { query: async () => [{ id: 7, url: 'file:///tmp/report.html' }] },
});
for (grant of [false, true, null]) {
  const context = await fileCollector.collect('s1', { sourceWindowId: 8 });
  assert.equal(context.fileAccessAllowed, grant === true);
  assert.equal(context.userVisibleTab.readOnlyUsable, grant === true);
  assert.equal((await fileCollector.collect('s1')).fileAccessAllowed, grant === true, 'permission is known even without a visible tab');
}

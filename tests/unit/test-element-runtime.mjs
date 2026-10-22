import assert from "node:assert/strict";

let currentUrl = "https://example.test/page#one";
let ownedTabs = [5];
const listeners = new Set();
const commands = [];
const contentCalls = [];
let debuggerUses = 0;
globalThis.chrome = {
  runtime: { id: "extension-id" },
  tabs: { async get(tabId) { return { id: tabId, url: currentUrl }; } },
  debugger: {
    onEvent: { addListener(listener) { listeners.add(listener); } },
    onDetach: { addListener() {} },
    async sendCommand() { return {}; },
  },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const targetResolutions = [];
const runtime = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return { sessions: {
      async resolveTargetTab(input) { targetResolutions.push(input); return { ok: true }; },
      listOwnedTabIds: () => ownedTabs,
    } };
  },
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {},
  async sendToContent(tabId, action, params = {}) {
    contentCalls.push({ tabId, action, ...params });
    return { ok: true, action, selector: params.selector, index: params.index };
  },
  async withDebugger(tabId, callback) {
    debuggerUses += 1;
    return await callback({ tabId }, async (method, params = {}) => {
      commands.push({ method, params });
      if (method === "Runtime.enable") {
        for (const listener of listeners) {
          listener({ tabId }, "Runtime.executionContextCreated", {
            context: {
              id: 7,
              origin: "chrome-extension://extension-id",
              auxData: { type: "isolated", frameId: "main" },
            },
          });
          listener({ tabId }, "Runtime.executionContextCreated", {
            context: {
              id: 8,
              origin: "chrome-extension://extension-id",
              auxData: { type: "isolated", frameId: "child" },
            },
          });
        }
        return {};
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: params.loaderId || "loader-live" } } };
      if (method === "DOM.getDocument") return { root: { nodeId: 3 } };
      if (method === "DOM.querySelectorAll") {
        return { nodeIds: String(params.selector).includes("dup") ? [11, 12] : [9] };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 44 } };
      if (method === "DOM.resolveNode") return { object: { objectId: "uid-node" } };
      if (method === "Runtime.evaluate") return { result: { value: { extensionId: "extension-id", bridge: true } } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true, action: params.arguments?.[0]?.value?.action || "" } } };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method ${method}`);
    });
  },
});

const context = { sessionId: "session-a", runId: "run" };
runtime.registerElementRef({
  uid: "t5.000001.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.primary",
  backendNodeId: 41,
  loaderId: "loader-live",
});

const resolved = await runtime.resolveElementReference(undefined, { target: "uid:t5.000001.1" }, context);
assert.equal(resolved.selector, "");
assert.equal(commands.length, 0, "resolving a uid must not query or generate a selector");
assert.equal(runtime.selectorFromBackendNode, undefined);

const css = await runtime.resolveElementReference(5, { target: "css:main > button" }, context);
assert.equal(css.selector, "main > button");
assert.equal(css.index, 0, "an omitted css index stays at the first match");

const beforeCss = debuggerUses;
const cssRead = await runtime.callElement(5, { tabId: 5, selector: "#save", target: "css:#save" }, "inspectElement", {}, context);
const cssWrite = await runtime.callElement(5, { tabId: 5, selector: "#plain", target: "css:#plain" }, "actOnElement", { elementAction: "fill", value: "next" }, context);
const cssIndexed = await runtime.callElement(5, { tabId: 5, selector: "button.dup", index: 1, target: "css:button.dup" }, "inspectElement", {}, context);
assert.equal(debuggerUses, beforeCss, "css read and write must not attach the debugger");
assert.equal(cssRead.selector, "#save");
assert.equal(cssRead.index, 0);
assert.equal(cssWrite.action, "actOnElement");
assert.equal(cssWrite.index, 0);
assert.equal(cssIndexed.index, 1);
assert.equal(contentCalls.at(-1).elementAction, undefined);
assert.equal(contentCalls.find(call => call.action === "actOnElement").value, "next");

const contentBeforeNode = contentCalls.length;
const called = await runtime.callElement(5, resolved, "inspectElement", {}, context);
assert.equal(contentCalls.length, contentBeforeNode, "a backend node uid must not fall back to the content script");
assert.equal(called.ok, true);
assert.ok(commands.some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 7));
assert.equal(commands.some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 8), false, "an iframe isolated world is not the content script");
assert.ok(commands.some(command => command.method === "Runtime.callFunctionOn"));
assert.ok(commands.some(command => command.method === "Runtime.releaseObjectGroup"));
assert.equal(commands.some(command => command.method === "DOM.querySelector"), false);

runtime.registerElementRef({
  uid: "t5.000002.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  backendNodeId: 41,
  loaderId: "loader-previous",
});
const beforeStale = commands.length;
await assert.rejects(
  runtime.callElement(5, { tabId: 5, uid: "t5.000002.1", target: "uid:t5.000002.1", ref: { backendNodeId: 41, loaderId: "loader-previous" } }, "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
);
assert.equal(commands.slice(beforeStale).some(command => command.method === "DOM.resolveNode"), false, "a replaced document must not be rematched");

const bound = await runtime.bindBackendNodes(5, ["button.dup", "#only"], context);
assert.equal(bound.loaderId, "loader-live");
assert.deepEqual(bound.ids, [0, 44], "a selector that matches two nodes must not bind the first");

ownedTabs = [5493, 15493];
assert.match(runtime.makeSnapshotId(5493, context), /^t5493\.[0-9a-z]{6}$/);
assert.match(runtime.makeSnapshotId(15493, context), /^t15493\.[0-9a-z]{6}$/);
ownedTabs = [955493525, 1855493525];
assert.match(runtime.makeSnapshotId(955493525, context), /^t955493525\./, "a suffix shared through the last 8 digits keeps the whole shorter id");
assert.match(runtime.makeSnapshotId(1855493525, context), /^t855493525\./);
ownedTabs = [5];
const snapshotId = runtime.makeSnapshotId(5, context);
assert.match(snapshotId, /^t5\.[0-9a-z]{6}$/);
const imageUid = runtime.makeElementUid(snapshotId, 1, "i");
assert.equal(imageUid, `${snapshotId}.i1`);
runtime.registerElementRef({
  uid: imageUid,
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  backendNodeId: 41,
  loaderId: "loader-live",
});
const imageRef = await runtime.resolveElementReference(undefined, { target: `uid:${imageUid}` }, context);
assert.equal(imageRef.uid, imageUid);
assert.equal(imageRef.ref.backendNodeId, 41);

runtime.registerElementRef({
  uid: "t9999.000001.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  backendNodeId: 41,
});
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t9999.000001.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID" && /tab suffix/.test(error.message),
);
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t955493525_mvidb4l5_12" }, context),
  error => error?.code === "STALE_ELEMENT_UID",
);
runtime.registerElementRef({
  uid: "t9.000001.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  backendNodeId: 41,
});
ownedTabs = [5, 9];
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t9.000001.1" }, context),
  error => error?.code === "ELEMENT_UID_TAB_MISMATCH",
);
ownedTabs = [5];
await assert.rejects(
  runtime.resolveElementReference(9, { target: "uid:t5.000001.1" }, context),
  error => error?.code === "ELEMENT_UID_TAB_MISMATCH",
);
currentUrl = "https://example.test/other";
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t5.000001.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID_PAGE_CHANGED",
);
currentUrl = "https://example.test/page#one";
const fresh = await runtime.resolveElementReference(undefined, { target: "uid:t5.000001.1" }, context);
assert.equal(fresh.tabId, 5);
assert.equal(fresh.selector, "", "a backend node uid keeps its direct node resolution");

targetResolutions.length = 0;
await runtime.resolveElementReference(undefined, { target: "uid:t5.000001.1", readOnly: true }, context);
assert.equal(targetResolutions.at(-1).readOnly, false, "node-backed uids keep the ownership check");

const debuggerBeforeFallback = debuggerUses;
runtime.registerElementRef({
  uid: "t5.000003.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "main > img.card:nth-of-type(2)",
  index: 2,
  imageSrc: "https://example.test/b.png",
});
const fallbackRef = await runtime.resolveElementReference(undefined, { target: "uid:t5.000003.1", readOnly: true }, context);
assert.equal(fallbackRef.uid, "t5.000003.1");
assert.equal(fallbackRef.selector, "main > img.card:nth-of-type(2)");
assert.equal(fallbackRef.index, 2);
assert.equal(fallbackRef.ref.imageSrc, "https://example.test/b.png");
assert.equal(targetResolutions.at(-1).readOnly, true, "selector fallback may read a tab the session does not own");
const fallbackCall = await runtime.callElement(5, fallbackRef, "readImageElement", {}, context);
assert.equal(fallbackCall.selector, "main > img.card:nth-of-type(2)");
assert.equal(fallbackCall.index, 2);
assert.equal(debuggerUses, debuggerBeforeFallback, "selector fallback must not attach the debugger");

runtime.registerElementRef({
  uid: "t5.000004.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
});
await assert.rejects(
  runtime.callElement(5, await runtime.resolveElementReference(undefined, { target: "uid:t5.000004.1" }, context), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a uid with neither a backend node nor a selector is stale",
);

runtime.registerElementRef({
  uid: "t5.000009.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.primary",
  backendNodeId: 41,
  loaderId: "loader-previous",
});
const contentBeforeReplacedNode = contentCalls.length;
const commandsBeforeReplacedNode = commands.length;
await assert.rejects(
  runtime.callElement(5, await runtime.resolveElementReference(undefined, { target: "uid:t5.000009.1" }, context), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a replaced node must not fall back to the selector of its replacement",
);
assert.equal(contentCalls.length, contentBeforeReplacedNode);
assert.equal(commands.slice(commandsBeforeReplacedNode).some(command => command.method === "DOM.resolveNode"), false);

runtime.registerElementRef({
  uid: "t5.00000a.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.replacement",
  index: 0,
  loaderId: "loader-previous",
});
const contentBeforeStaleSelector = contentCalls.length;
await assert.rejects(
  runtime.callElement(5, await runtime.resolveElementReference(undefined, { target: "uid:t5.00000a.1" }, context), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a selector uid from a previous document must not run",
);
assert.equal(contentCalls.length, contentBeforeStaleSelector, "a stale selector uid must not reach the content script");

let probedDocumentId = "doc-live";
chrome.scripting = {
  async executeScript() { return [{ documentId: probedDocumentId }]; },
};
runtime.registerElementRef({
  uid: "t5.00000b.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.primary",
  backendNodeId: 41,
  loaderId: "loader-live",
  documentId: "doc-previous",
});
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t5.00000b.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "the same url with a new document invalidates the old uid",
);
probedDocumentId = "doc-previous";
const sameDocument = await runtime.resolveElementReference(undefined, { target: "uid:t5.00000b.1" }, context);
assert.equal(sameDocument.uid, "t5.00000b.1");
delete chrome.scripting;

ownedTabs = [5];
runtime.registerElementRef({
  uid: "t15.000005.1",
  tabId: 15,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "main > img.card:nth-of-type(2)",
  index: 0,
});
const foreignRead = await runtime.resolveElementReference(15, { target: "uid:t15.000005.1", readOnly: true }, context);
assert.equal(foreignRead.tabId, 15);
assert.equal(foreignRead.selector, "main > img.card:nth-of-type(2)");
assert.equal(targetResolutions.at(-1).readOnly, true);
assert.equal(targetResolutions.at(-1).tabId, 15);
await assert.rejects(
  runtime.resolveElementReference(15, { target: "uid:t15.000005.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "the same selector uid is stale for a non-readonly operation on an unowned tab",
);
runtime.registerElementRef({
  uid: "t15.000006.1",
  tabId: 15,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "main > img.card:nth-of-type(2)",
  backendNodeId: 44,
});
await assert.rejects(
  runtime.resolveElementReference(15, { target: "uid:t15.000006.1", readOnly: true }, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a node-backed uid still has to match a tab this session owns",
);
ownedTabs = [15];
runtime.registerElementRef({
  uid: "t15.000007.1",
  tabId: 115,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "img.only",
  index: 0,
});
const unambiguous = await runtime.resolveElementReference(undefined, { target: "uid:t15.000007.1", readOnly: true }, context);
assert.equal(unambiguous.tabId, 115, "suffix 15 must match the registered tab 115, not owned tab 15");
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t15.000007.1" }, context),
  error => error?.code === "ELEMENT_UID_TAB_MISMATCH",
);
runtime.registerElementRef({
  uid: "t99.000008.1",
  tabId: 115,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "img.only",
});
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t99.000008.1", readOnly: true }, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a read-only selector uid whose suffix misses its registered tab is stale",
);
ownedTabs = [5];

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;
try {
  const host = {
    ToolExecutionError,
    getToolRuntimeDependencies() {
      return { sessions: { async resolveTargetTab() { return { ok: true }; }, listOwnedTabIds: () => [5] } };
    },
    makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
    async assertTabAllowed() {},
    async sendToContent() { return { ok: true }; },
    async withDebugger() { throw new Error("unused"); },
  };
  const first = createElementRuntime(host);
  const firstSnapshot = first.makeSnapshotId(5, context);
  const firstUid = first.makeElementUid(firstSnapshot, 12);
  first.registerElementRef({
    uid: firstUid,
    tabId: 5,
    sessionId: "session-a",
    pageUrl: "https://example.test/page",
    backendNodeId: 41,
  });
  clock += 1;
  const second = createElementRuntime(host);
  const secondSnapshot = second.makeSnapshotId(5, context);
  assert.match(firstSnapshot, /^t5\.[0-9a-z]{6}$/);
  assert.match(secondSnapshot, /^t5\.[0-9a-z]{6}$/);
  assert.notEqual(firstSnapshot, secondSnapshot);
  await assert.rejects(
    second.resolveElementReference(undefined, { target: `uid:${firstUid}` }, context),
    error => error?.code === "STALE_ELEMENT_UID",
  );
} finally {
  Date.now = realNow;
}

console.log("element runtime ownership tests passed");

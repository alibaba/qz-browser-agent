import assert from "node:assert/strict";

let currentUrl = "https://example.test/page#one";
let ownedTabs = [5];
const listeners = new Set();
const commands = [];
const contentCalls = [];
let debuggerUses = 0;
let childBridge = true;
let oopifBridge = true;
let contentInitializations = 0;
let exposeOopif = false;
let childLoaderId = "child-loader";
let navigateDuringBind = false;
let childDocumentAvailable = true;
let findBindingError = null;
const scriptCalls = [];
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
let targetResolution = { ok: true };
let securityFailure = false;
const runtime = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return { sessions: {
      async resolveTargetTab(input) { targetResolutions.push(input); return targetResolution; },
      listOwnedTabIds: () => ownedTabs,
    } };
  },
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {
    if (securityFailure) throw new ToolExecutionError('SECURITY_GUARDRAIL_BLOCKED', 'blocked');
  },
  async initializeContentScript() { contentInitializations += 1; },
  async sendToContent(tabId, action, params = {}) {
    contentCalls.push({ tabId, action, ...params });
    return { ok: true, action, selector: params.selector, index: params.index };
  },
  async withDebugger(tabId, callback) {
    debuggerUses += 1;
    const send = async (method, params = {}) => {
      commands.push({ method, params, sessionId: "" });
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
      if (method === "Runtime.disable") throw new Error("disable");
      if (method === "Page.getFrameTree") return {
        frameTree: {
          frame: { id: "main", loaderId: params.loaderId || "loader-live" },
          childFrames: [{
            frame: { id: "child", parentId: "main", loaderId: childLoaderId },
            childFrames: [{ frame: { id: "grandchild", parentId: "child", loaderId: "grand-loader" } }],
          }],
        },
      };
      if (method === "Target.getTargets" || method === "Target.attachToTarget") {
        throw new Error(`${method} is not used`);
      }
      if (method === "Target.setAutoAttach") {
        if (!exposeOopif) throw new Error("auto-attach ran without a cross-site frame");
        for (const listener of listeners) listener({ tabId }, "Target.attachedToTarget", {
          sessionId: "sess",
          targetInfo: { type: "iframe", targetId: "tid", parentFrameId: "main" },
        });
        return {};
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 3 } };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 500 };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [30] };
      if (method === "DOM.querySelectorAll") {
        if (params.nodeId === 30) {
          if (navigateDuringBind) childLoaderId = "child-replaced";
          return { nodeIds: [19] };
        }
        return { nodeIds: String(params.selector).includes("dup") ? [11, 12] : [9] };
      }
      if (method === "DOM.describeNode") return { node: params.backendNodeId === 500
        ? { contentDocument: childDocumentAvailable ? { backendNodeId: 51 } : undefined }
        : { backendNodeId: params.nodeId === 19 ? 144 : 44 } };
      if (method === "DOM.resolveNode") return { object: { objectId: "uid-node" } };
      if (method === "Runtime.evaluate") {
        const bridge = Number(params.contextId) === 8 ? childBridge : true;
        return { result: { value: { extensionId: "extension-id", bridge } } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.arguments?.[0]?.value?.action === 'resolveFindElement') {
          if (findBindingError) throw findBindingError;
          return { result: params.arguments[0].value.elementRef === 'removed'
            ? { subtype: 'null', value: null } : { subtype: 'node', objectId: 'found-shadow-node' } };
        }
        return { result: { value: { ok: true, action: params.arguments?.[0]?.value?.action || "" } } };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method ${method}`);
    };
    send.inSession = sessionId => async (method, params = {}) => {
      commands.push({ method, params, sessionId });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "oopif", loaderId: "oopif-loader" } } };
      if (method === "DOM.getDocument") return { root: { nodeId: 3 } };
      if (method === "DOM.querySelectorAll") return { nodeIds: [9] };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 244 } };
      if (method === "Runtime.disable" || method === "Runtime.releaseObjectGroup") return {};
      if (method === "Runtime.enable") {
        for (const listener of listeners) {
          listener({ tabId, sessionId }, "Runtime.executionContextCreated", {
            context: {
              id: 9,
              origin: "chrome-extension://extension-id",
              auxData: { type: "isolated", frameId: "oopif" },
            },
          });
        }
        return {};
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { extensionId: "extension-id", bridge: oopifBridge } } };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "oopif-node" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true, action: params.arguments?.[0]?.value?.action || "" } } };
      throw new Error(`unexpected child CDP method ${method}`);
    };
    if (exposeOopif) {
      send.tabId = tabId;
      send.connectionId = 1;
    }
    return await callback({ tabId }, send);
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

{
  const light = { results: [{ selector: '#only', tag: 'button', actionable: true, line: 2, lineRange: [2, 2] }] };
  const before = debuggerUses;
  assert.equal(JSON.stringify(await runtime.addElementTargetsToFindResult(light, 5, context)),
    '{"results":[{"selector":"#only","tag":"button","actionable":true,"line":2,"lineRange":[2,2],"target":"css:#only"}]}');
  assert.equal(debuggerUses, before, 'light-DOM finds must not attach the debugger');
  const input = { results: [light.results[0], { selector: '', text: 'Shadow', actionable: true, _elementRef: 'live' }] };
  const found = await runtime.addElementTargetsToFindResult(input, 5, context);
  assert.equal(JSON.stringify(found.results[0]), JSON.stringify({ ...light.results[0], target: 'css:#only' }));
  const hit = found.results[1];
  assert.match(hit.target, /^uid:t5\./);
  assert.equal(hit.actionable, true);
  assert.equal(Object.hasOwn(hit, '_elementRef'), false);
  assert.equal(runtime.elementUidTabId([hit.target]), 5);
  const ref = await runtime.resolveElementReference(5, { target: hit.target }, context);
  assert.equal(ref.ref.backendNodeId, 44);
  assert.equal(ref.ref.loaderId, 'loader-live');
  assert.equal((await runtime.callElement(5, ref, 'inspectElement', {}, context)).action, 'inspectElement');
  await assert.rejects(runtime.resolveElementReference(5, { target: hit.target }, { sessionId: 'another-session' }), { code: 'ELEMENT_UID_SESSION_MISMATCH' });
  assert.ok(commands.some(command => command.method === 'DOM.describeNode' && command.params.objectId === 'found-shadow-node'));
  assert.ok(commands.some(command => command.method === 'Runtime.releaseObjectGroup' && command.params.objectGroup.startsWith('qz-uid-find-')));
  const removed = await runtime.addElementTargetsToFindResult({ results: [{ selector: '', actionable: true, _elementRef: 'removed' }] }, 5, context);
  assert.deepEqual(removed, { results: [{ selector: '', actionable: false }] });
  try {
    findBindingError = new Error('Debugger unavailable');
    const failed = await runtime.addElementTargetsToFindResult(input, 5, context);
    assert.deepEqual(failed.results[1], { selector: '', text: 'Shadow', actionable: false });
    assert.deepEqual(failed.results[0], found.results[0]);
    findBindingError = new ToolExecutionError('OPERATION_ABORTED', 'cancelled');
    await assert.rejects(runtime.addElementTargetsToFindResult(input, 5, context), { code: 'OPERATION_ABORTED' });
  } finally { findBindingError = null; }
}

const beforeChildBind = commands.length;
const childScope = { frameId: "child", loaderId: "child-loader" };
assert.deepEqual(await runtime.bindBackendNodes(5, ["#only"], context, childScope), { loaderId: "child-loader", ids: [144] });
assert.equal(commands.slice(beforeChildBind).filter(command => command.method === "DOM.querySelectorAll").every(command => command.params.nodeId === 30), true,
  "a same-process child selector is scoped to its own document");
await assert.rejects(runtime.bindBackendNodes(5, ["#only"], context, { ...childScope, loaderId: "previous-loader" }), { code: "STALE_ELEMENT_UID" });
navigateDuringBind = true;
await assert.rejects(runtime.bindBackendNodes(5, ["#only"], context, childScope), { code: "STALE_ELEMENT_UID" });
navigateDuringBind = false;
childLoaderId = "child-loader";
childDocumentAvailable = false;
assert.deepEqual((await runtime.bindBackendNodes(5, ["#only"], context, childScope)).ids, [0], "a missing child document must not query the main document");
childDocumentAvailable = true;

exposeOopif = true;
const beforeRemoteBind = commands.length;
assert.deepEqual(await runtime.bindBackendNodes(5, ["#only"], context, { frameId: "oopif", loaderId: "oopif-loader" }), { loaderId: "oopif-loader", ids: [244] });
assert.equal(commands.slice(beforeRemoteBind).filter(command => command.method === "DOM.querySelectorAll").every(command => command.sessionId === "sess"), true,
  "an out-of-process child selector uses its own CDP session");
exposeOopif = false;

ownedTabs = [5493, 15493];
assert.match(runtime.makeSnapshotId(5493, context), /^t5493\.[0-9a-z]{6}$/);
assert.match(runtime.makeSnapshotId(15493, context), /^t15493\.[0-9a-z]{6}$/);
ownedTabs = [955493525, 1855493525];
assert.match(runtime.makeSnapshotId(955493525, context), /^t955493525\./, "a suffix shared through the last 8 digits keeps the whole shorter id");
assert.match(runtime.makeSnapshotId(1855493525, context), /^t855493525\./);
ownedTabs = [5];
{
const realNow = Date.now;
try {
  Date.now = () => 1700000000000;
  const concurrentIds = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => runtime.makeSnapshotId(5, context))));
  assert.equal(new Set(concurrentIds).size, 100, "same-millisecond snapshots remain unique");
} finally { Date.now = realNow; }
}
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
const debuggerBeforeSelector = debuggerUses;
const contentBeforeSelector = contentCalls.length;
const selectorRead = await runtime.callElement(5, await runtime.resolveElementReference(undefined, { target: "uid:t5.00000a.1", readOnly: true }, context), "inspectElement", {}, context);
assert.equal(selectorRead.ok, true);
assert.equal(contentCalls.length, contentBeforeSelector + 1, "a selector uid keeps its content-script read");
assert.equal(debuggerUses, debuggerBeforeSelector, "a stored loader id must not attach the debugger for a selector uid");

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

// A title redirect rewrites the URL string without replacing the document.
runtime.registerElementRef({
  uid: "t5.00000c.1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/before-redirect",
  selector: "img.redirect",
  backendNodeId: 41,
  loaderId: "loader-live",
  documentId: "doc-redirect",
});
currentUrl = "https://example.test/after-redirect";
probedDocumentId = "doc-redirect";
const redirected = await runtime.resolveElementReference(undefined, { target: "uid:t5.00000c.1" }, context);
assert.equal(redirected.uid, "t5.00000c.1", "a same-document redirect keeps the uid valid");

// A real navigation replaces the document, so the changed URL stays stale.
probedDocumentId = "doc-replaced";
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t5.00000c.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID_PAGE_CHANGED",
  "a replaced document under a new url is a page change",
);

// Without a live probe the changed url cannot be disproved, so it stays stale.
probedDocumentId = "";
await assert.rejects(
  runtime.resolveElementReference(undefined, { target: "uid:t5.00000c.1" }, context),
  error => error?.code === "STALE_ELEMENT_UID_PAGE_CHANGED",
  "a missing document probe keeps the strict verdict",
);
probedDocumentId = "doc-redirect";

// Reject a conflicting tab before ownership resolution can select or claim it.
const beforeMismatch = targetResolutions.length;
targetResolution = { ok: false, code: 'SESSION_TAB_FOREIGN' };
await assert.rejects(
  runtime.resolveElementReference(9, { target: "uid:t5.00000c.1" }, context),
  error => error?.code === "ELEMENT_UID_TAB_MISMATCH",
  "an explicit wrong tab reports a tab mismatch, not a page or ownership error",
);
assert.equal(targetResolutions.length, beforeMismatch, 'a mismatched tab must never be selected or claimed');
await assert.rejects(runtime.resolveElementReference(undefined, { target: 'uid:t5.00000c.1' }, context),
  { code: 'SESSION_TAB_FOREIGN' }, 'uids still enforce ownership on their own tab');
targetResolution = { ok: true };
const uidSignal = new AbortController().signal;
await runtime.resolveElementReference(undefined, { target: 'uid:t5.00000c.1' }, { ...context, signal: uidSignal, deferToolCommit: true });
assert.equal(targetResolutions.at(-1).runId, context.runId);
assert.equal(targetResolutions.at(-1).signal, uidSignal);
assert.equal(targetResolutions.at(-1).checkOnly, true, 'parallel uid calls must not select a working tab during execution');
targetResolution = { ok: true, claimRequired: true };
await assert.rejects(runtime.resolveElementReference(undefined, { target: 'uid:t5.00000c.1' }, { ...context, deferToolCommit: true }),
  { code: 'SESSION_TAB_UNOWNED' }, 'a speculative uid call cannot operate on a merely claimable tab');
targetResolution = { ok: true };
securityFailure = true;
await assert.rejects(runtime.resolveElementReference(undefined, { target: 'uid:t5.00000c.1' }, context),
  { code: 'SECURITY_GUARDRAIL_BLOCKED' }, 'document identity never bypasses URL guardrails');
securityFailure = false;
currentUrl = "https://example.test/page#one";

runtime.registerElementRef({
  uid: "t15.000099.1",
  tabId: 15,
  sessionId: "session-a",
  pageUrl: "https://example.test/other-page",
  selector: "img.other",
});
assert.equal(runtime.elementUidTabId(["uid:t5.000001.1", "uid:t5.00000b.1"]), 5, "uids on one tab share its lane");
assert.equal(runtime.elementUidTabId(["uid:t5.000001.1", "uid:t15.000099.1"]), null, "uids spanning tabs share no lane");
assert.equal(runtime.elementUidTabId(["uid:t77.000001.1"]), null, "an unknown uid has no lane");
assert.equal(runtime.elementUidTabId(["css:img"]), null, "a non-uid target has no lane");
assert.equal(runtime.elementUidTabId([]), null, "no targets means no lane");
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

chrome.scripting = {
  async executeScript(options) {
    scriptCalls.push(options);
    if (options.target?.allFrames) throw new Error("element runtime must not probe frames");
    if (String(options.func || "").includes("__qzFrameProbe")) throw new Error("frame probe is not used");
    return [{ documentId: "doc-live", frameId: options.target?.frameIds?.[0] ?? 0, result: null }];
  },
};

function childRef(uid, frameId, loaderId, backendNodeId = 41) {
  runtime.registerElementRef({
    uid, tabId: 5, sessionId: "session-a", pageUrl: "https://example.test/page",
    backendNodeId, loaderId, frameId,
  });
  return { tabId: 5, uid, target: `uid:${uid}`, ref: { backendNodeId, loaderId, frameId } };
}

const childCommands = commands.length;
const childScripts = scriptCalls.length;
const childInits = contentInitializations;
const childHit = await runtime.callElement(5, childRef("t5.000010.1", "child", "child-loader"), "inspectElement", {}, context);
assert.equal(childHit.ok, true);
assert.ok(commands.slice(childCommands).some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 8 && command.sessionId === ""));
assert.equal(commands.slice(childCommands).some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 7), false);
assert.equal(scriptCalls.length, childScripts, "a reported child context does not inject or probe frames");
assert.equal(contentInitializations, childInits);
assert.equal(commands.slice(childCommands).some(command => command.method === "Runtime.disable"), false);

const staleScripts = scriptCalls.length;
const staleCommands = commands.length;
await assert.rejects(
  runtime.callElement(5, childRef("t5.000011.1", "child", "old-child"), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
);
assert.equal(scriptCalls.length, staleScripts, "a replaced child document must not inject");
assert.equal(commands.slice(staleCommands).some(command => command.method === "DOM.resolveNode"), false);

await assert.rejects(
  runtime.callElement(5, childRef("t5.000012.1", "missing", "child-loader"), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
);
await assert.rejects(
  runtime.callElement(5, childRef("t5.000013.1", "grandchild", "grand-loader"), "inspectElement", {}, context),
  error => error?.code === "STALE_ELEMENT_UID",
  "a nested frame is not a direct child",
);

childBridge = false;
const missingBridgeInits = contentInitializations;
const missingBridgeScripts = scriptCalls.length;
await assert.rejects(
  runtime.callElement(5, childRef("t5.000015.1", "child", "child-loader"), "inspectElement", {}, context),
  error => error?.code === "CONTENT_SCRIPT_NOT_READY",
);
assert.equal(contentInitializations, missingBridgeInits + 1, "a child frame with no bridge uses Content initialization");
assert.equal(scriptCalls.length, missingBridgeScripts);
childBridge = true;

exposeOopif = true;
const oopifCommands = commands.length;
const oopifScripts = scriptCalls.length;
const oopifHit = await runtime.callElement(5, childRef("t5.000014.1", "oopif", "oopif-loader", 3), "inspectElement", {}, context);
assert.equal(oopifHit.ok, true);
const oopifResolve = commands.slice(oopifCommands).filter(command => command.method === "DOM.resolveNode");
assert.equal(oopifResolve.length, 1);
assert.equal(oopifResolve[0].sessionId, "sess");
assert.equal(oopifResolve[0].params.executionContextId, 9);
assert.equal(scriptCalls.length, oopifScripts, "a reported cross-site context does not inject or probe frames");
assert.equal(commands.slice(oopifCommands).some(command => command.method === "Runtime.disable"), false);
const mainAfterOopif = commands.length;
await runtime.callElement(5, resolved, "inspectElement", {}, context);
assert.ok(commands.slice(mainAfterOopif).some(command => command.method === "DOM.resolveNode" && command.params.executionContextId === 7 && command.sessionId === ""));

assert.equal(commands.some(command => command.method === "Runtime.disable"), false, "uid resolution must leave Runtime enabled");
console.log("element runtime ownership tests passed");

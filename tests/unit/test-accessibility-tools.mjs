import assert from "node:assert/strict";
import { registerAccessibilityTools } from "../../src/capabilities/accessibility/tools.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";
import { isPageOverview } from "../../src/shared/contracts/page-content.js";

const overview = {
  title: "Page", url: "https://example.com/", viewport: { width: 800, height: 600 },
  actions: [{ selector: "button", role: "button", text: "Continue", clickablePoint: { x: 10, y: 10 } }],
  headings: [{ level: null, text: "Section", selector: "h2" }],
  canvases: [{ name: "Chart", rect: { x: 0, y: 0, w: 300, h: 200 }, bitmapSize: { width: 600, height: 400 } }],
};
assert.equal(isPageOverview(overview), true);
assert.equal(isPageOverview({ error: "No match", code: "ELEMENT_NOT_FOUND" }), true);
for (const invalid of [null, [], { actions: {} }, { actions: [{ selector: 123 }] }, { actions: [{ checked: "false" }] }, { canvases: [{ rect: { w: "300" } }] }]) {
  assert.equal(isPageOverview(invalid), false);
}
let input = overview;
let definition;
const refs = [];
registerAccessibilityTools({
  registerTool: value => { definition = value; }, ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(value, max)),
  makeSnapshotId: () => "snapshot", elementTargetForUid: uid => `uid:${uid}`,
  registerElementRef: ref => refs.push(ref),
  resolveElementReference: async () => ({ tabId: 8, target: "css:button", selector: "button", index: 0 }),
  backendNodeIdForSelector: async () => 2,
  bindBackendNodes: async (_tabId, selectors = []) => ({ loaderId: "", ids: selectors.map(() => 2) }),
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => input,
  withDebugger: async (id, fn, context) => {
    assert.equal(id, 8); assert.equal(context.sessionId, "owner");
    return fn({}, async () => ({ nodes: [
      { nodeId: "root", childIds: ["button"], role: { value: "RootWebArea" } },
      { nodeId: "button", parentId: "root", backendDOMNodeId: 2, role: { value: "button" }, name: { value: "Continue" } },
    ] }));
  }, elementTargetGrammar: "target grammar",
});
const context = { sessionId: "owner", runId: "run" };
const result = await definition.execute({ tabId: 8 }, null, context);
assert.equal(result.returnedNodeCount, 2);
assert.match(result.snapshot, /target=uid:snapshot\.1 button "Continue"/);
assert.equal("actions" in result, false);
assert.equal("headings" in result, false);
assert.deepEqual(result.canvases, overview.canvases);
assert.ok(refs.every(ref => ref.sessionId === "owner" && ref.tabId === 8));
const subtree = await definition.execute({ tabId: 8, root: "css:button" }, null, context);
assert.equal(subtree.returnedNodeCount, 1);
assert.equal(subtree.rootFound, true);
input = { actions: [{ selector: 123 }] };
const malformed = await definition.execute({ tabId: 8 }, null, context);
assert.equal(malformed.pageOverviewError.code, "PAGE_OVERVIEW_FAILED");
assert.equal(malformed.returnedNodeCount, 2, "AX output remains available after invalid overview");
assert.equal("actions" in malformed, false);
assert.equal("headings" in malformed, false);
console.log("accessibility tree and unknown content boundary passed");

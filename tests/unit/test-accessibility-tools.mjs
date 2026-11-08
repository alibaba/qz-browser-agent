globalThis.chrome = { tabs: { get: async () => ({ url: "https://example.com/", status: "complete" }) }, scripting: { executeScript: async () => [{ result: true }] } };
import assert from "node:assert/strict";
import { registerAccessibilityTools } from "../../src/capabilities/accessibility/tools.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";
import { assertHtmlPage } from "../../src/background/tools/page-access.js";
import { isPageOverview } from "../../src/shared/contracts/page-content.js";
import { withLanguage } from "../../src/shared/i18n/index.js";

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
  registerElementBinding: ref => {
    const uid = ref.backendNodeId ? `snapshot.${ref.backendNodeId}` : undefined;
    const bound = { ...ref, uid, target: uid ? `uid:${uid}` : ref.selector ? `css:${ref.selector}` : '' };
    refs.push(bound); return bound;
  },
  resolveElementReference: async () => ({ tabId: 8, target: "css:button", selector: "button", index: 0 }),
  backendNodeIdForSelector: async () => 2,
  bindElementReferences: async (_tabId, candidates) => candidates.map(ref => ({ ...ref, backendNodeId: ref.selector ? 2 : 0, target: ref.selector ? `css:${ref.selector}` : '' })),
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => { if (input instanceof Error) throw input; return input; },
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
assert.match(result.snapshot, /target=uid:snapshot\.2 button "Continue"/);
assert.equal("actions" in result, false);
assert.equal("headings" in result, false);
assert.deepEqual(result.canvases, [{ name: "Chart", rect: { x: 0, y: 0, width: 300, height: 200 }, bitmapSize: { width: 600, height: 400 } }]);
assert.ok(refs.every(ref => ref.sessionId === "owner" && ref.tabId === 8));
const subtree = await definition.execute({ tabId: 8, target: "css:button" }, null, context);
assert.equal(subtree.returnedNodeCount, 1);
assert.equal(subtree.rootFound, true);
input = { actions: [{ selector: 123 }] };
const malformed = await definition.execute({ tabId: 8 }, null, context);
assert.equal(malformed.pageOverviewError.code, "PAGE_OVERVIEW_FAILED");
assert.equal(malformed.returnedNodeCount, 2, "AX output remains available after invalid overview");
assert.equal("actions" in malformed, false);
assert.equal("headings" in malformed, false);
const pdfUrl = "https://example.com/report.pdf";
try { withLanguage("en", () => assertHtmlPage(pdfUrl, "application/pdf")); }
catch (error) { input = error; }
assert.equal(input.code, "PDF_PAGE_UNSUPPORTED");
assert.match(input.message, /PDF viewer.*HTML page/);
assert.match(input.message, /document Skill and original PDF URL/);
assert.equal(input.hint, undefined);
const pdf = await definition.execute({ tabId: 8 }, null, context);
assert.deepEqual(pdf.pageOverviewError, input.toJSON());
assert.equal(pdf.pageOverviewError.details.url, pdfUrl);
assert.equal(pdf.returnedNodeCount, 2, "a PDF overview diagnostic does not discard a successful AX snapshot");
assert.equal(pdf.pageOverviewError.hint, undefined, "AX does not add recovery advice to the source diagnostic");
input = Object.assign(new ToolExecutionError("ELEMENT_NOT_FOUND", "Target was removed", { target: "css:button" }), {
  hint: "Choose a current target from the snapshot.",
});
const unavailable = await definition.execute({ tabId: 8 }, null, context);
assert.deepEqual(unavailable.pageOverviewError, input.toJSON(), "all typed overview failures retain their source recovery fields");
input = { error: "Partial overview", code: "ELEMENT_NOT_FOUND", hint: "Choose another target.", details: { target: "css:button" } };
const partial = await definition.execute({ tabId: 8 }, null, context);
assert.deepEqual(partial.pageOverviewError, { code: input.code, message: input.error, hint: input.hint, details: input.details });
console.log("accessibility tree and unknown content boundary passed");

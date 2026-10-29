import assert from "node:assert/strict";
import { filterViewportNodes, readViewportBands, verticalBand } from "../../src/capabilities/accessibility/viewport.js";

assert.equal(verticalBand(-20, 1, 600), "inside");
assert.equal(verticalBand(599, 900, 600), "inside");
assert.equal(verticalBand(-20, 900, 600), "inside");
assert.equal(verticalBand(-20, 0, 600), "above");
assert.equal(verticalBand(600, 900, 600), "below");
assert.equal(verticalBand(0, 0, 600), "inside", "zero-height nodes at the top are not above the viewport");
assert.equal(verticalBand(599, 599, 600), "inside");
assert.equal(verticalBand(-1, -1, 600), "above");
assert.equal(verticalBand(600, 600, 600), "below");
const nodes = [
  { nodeId: "root", backendDOMNodeId: 1, childIds: ["text", "unknown"] },
  { nodeId: "text", parentId: "root", backendDOMNodeId: 2, childIds: ["inline"] },
  { nodeId: "inline", parentId: "text" },
  { nodeId: "unknown", parentId: "root", backendDOMNodeId: 3 },
];
const fallback = await readViewportBands(async (method, params) => {
  if (method === "DOMSnapshot.captureSnapshot") throw new Error("not supported in Firefox");
  if (method === "Page.getLayoutMetrics") return { layoutViewport: { clientHeight: 600 } };
  if (method === "DOM.getBoxModel" && params.backendNodeId !== 3) return { model: { border: [0, -100, 10, -100, 10, -50, 0, -50] } };
  throw new Error("detached");
}, nodes);
const filtered = filterViewportNodes(nodes, fallback);
assert.deepEqual([...filtered.kept].sort(), ["root", "unknown"]);
assert.deepEqual([...filtered.structural], ["root"]);
assert.equal(filtered.above, 2, "count raw text and inline AX nodes, not output lines");
assert.equal(filtered.below, 0);
assert.equal(filtered.unmeasured, 1, "unknown DOM boxes fail open");
assert.equal((await readViewportBands(async () => { throw new Error("unavailable"); }, nodes)).size, 0);
const missingLayout = await readViewportBands(async (method, params) => {
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientHeight: 600 } };
  if (method === "DOMSnapshot.captureSnapshot") return { documents: [{ scrollOffsetY: 100, nodes: { backendNodeId: [1] }, layout: { nodeIndex: [0], bounds: [[0, 100, 800, 600]] } }] };
  if (method === "DOM.getBoxModel") return { model: { border: [0, 700, 10, 700, 10, 720, 0, 720] } };
  return {};
}, nodes);
assert.equal(missingLayout.get("root"), "inside");
assert.equal(missingLayout.get("text"), "below", "batch gaps use box-model geometry, including input internals");

const scrollbarBand = await readViewportBands(async method => {
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientHeight: 585 } };
  if (method === "DOM.getBoxModel") return { model: { border: [2000, 595, 2020, 595, 2020, 620, 2000, 620] } };
  return {};
}, [{ nodeId: "partial", backendDOMNodeId: 1 }], 600);
assert.equal(scrollbarBand.get("partial"), "inside", "use Content innerHeight even when a horizontal scrollbar reduces clientHeight");

const childBands = await readViewportBands(async method => {
  if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientHeight: 600 } };
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" }, childFrames: [{ frame: { id: "child" } }] } };
  if (method === "DOM.getFrameOwner") return { backendNodeId: 9 };
  if (method === "DOM.getBoxModel") return { model: { content: [0, 550, 100, 550, 100, 650, 0, 650] } };
  if (method === "DOMSnapshot.captureSnapshot") return { strings: ["child"], documents: [{ frameId: 0, scrollOffsetY: 20,
    nodes: { backendNodeId: [1, 2] }, layout: { nodeIndex: [0, 1], bounds: [[0, 30, 100, 20], [0, 100, 100, 20]] } }] };
  return {};
}, [{ nodeId: "visible", backendDOMNodeId: 1, documentFrameId: "child" }, { nodeId: "below", backendDOMNodeId: 2, documentFrameId: "child" }]);
assert.equal(childBands.get("visible"), "inside");
assert.equal(childBands.get("below"), "below", "child document scroll and root-viewport origin are both applied");
console.log("AX viewport geometry and fallback passed");

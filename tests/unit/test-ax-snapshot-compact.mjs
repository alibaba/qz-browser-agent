import assert from "node:assert/strict";

let currentUrl = "https://example.com/forms/post";
globalThis.chrome = {
  runtime: { id: "extension-id" },
  tabs: { async get(tabId) { return { id: tabId, url: currentUrl }; } },
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
const { registerAccessibilityTools } = await import("../../src/capabilities/accessibility/tools.js");
const { ToolExecutionError } = await import("../../src/background/tools/arguments.js");

const owned = [8];
const element = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies: () => ({ sessions: { async resolveTargetTab() { return { ok: true }; }, listOwnedTabIds: () => owned } }),
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  async assertTabAllowed() {},
  async sendToContent() { return {}; },
  async withDebugger(_tabId, callback) { return callback({ tabId: 8 }, async () => ({})); },
});

let scenario = {};
let definition;
registerAccessibilityTools({
  registerTool: value => { definition = value; },
  ToolExecutionError,
  clampLimit: (value, min, max) => Math.max(min, Math.min(max, Math.floor(Number(value)))),
  makeSnapshotId: element.makeSnapshotId,
  makeElementUid: element.makeElementUid,
  elementTargetForUid: element.elementTargetForUid,
  registerElementRef: element.registerElementRef,
  resolveElementReference: element.resolveElementReference,
  backendNodeIdForSelector: async () => 0,
  bindBackendNodes: async () => scenario.bound,
  makeSessionTabTargetError: code => new ToolExecutionError(code, code),
  sendToContent: async () => scenario.overview,
  callElement: async () => scenario.overview,
  withDebugger: async (_id, fn) => fn({}, async (method, params = {}) => {
    if (method === "Accessibility.getFullAXTree") return { nodes: scenario.nodes };
    if (method === "DOM.describeNode") return scenario.describe(params);
    return {};
  }),
  elementTargetGrammar: "target grammar",
});

const context = { sessionId: "owner", runId: "run" };

function ax({ id, parent, children = [], backend, role, name, url, ignored, value, properties = [] }) {
  const node = { nodeId: id, childIds: children };
  if (parent) node.parentId = parent;
  if (backend) node.backendDOMNodeId = backend;
  if (role) node.role = { value: role };
  if (name) node.name = { value: name };
  if (value) node.value = { value };
  const props = [...properties];
  if (url) props.push({ name: "url", value: { value: url } });
  if (props.length) node.properties = props;
  if (ignored) node.ignored = true;
  return node;
}

function line(snapshot, part) {
  return String(snapshot || "").split("\n").find(item => item.includes(part)) || "";
}

async function run(next) {
  scenario = {
    describe: () => ({ node: {} }),
    bound: { loaderId: "loader", ids: [] },
    limit: 120,
    ...next,
  };
  currentUrl = scenario.overview.url;
  return definition.execute({ tabId: 8, limit: scenario.limit, actionsLimit: 40 }, null, context);
}

const headingIds = Array.from({ length: 30 }, (_value, index) => `h${index + 1}`);
const budget = await run({
  limit: 20,
  overview: {
    title: "Budget", url: "https://example.com/forms/post",
    actions: [
      { selector: "#alpha", role: "button", text: "Alpha" },
      { selector: "#beta", role: "button", text: "Beta" },
      { selector: "#gamma", role: "button", text: "Gamma" },
    ],
  },
  bound: { loaderId: "loader", ids: [201, 202, 203] },
  nodes: [
    ax({ id: "root", children: [...headingIds, "a", "b", "c"], backend: 1, role: "RootWebArea", name: "Page" }),
    ...headingIds.map((id, index) => ax({ id, parent: "root", backend: 100 + index, role: "heading", name: `Heading ${index + 1}` })),
    ax({ id: "a", parent: "root", backend: 201, role: "button", name: "Alpha" }),
    ax({ id: "b", parent: "root", backend: 202, role: "button", name: "Beta" }),
    ax({ id: "c", parent: "root", backend: 203, role: "button", name: "Gamma" }),
  ],
});
assert.equal(budget.returnedNodeCount, 24, "guaranteed actions and the root sit outside the optional budget");
assert.match(budget.snapshot, /"Alpha"/);
assert.match(budget.snapshot, /"Beta"/);
assert.match(budget.snapshot, /"Gamma"/);
assert.match(budget.snapshot, /"Heading 20"/);
assert.doesNotMatch(budget.snapshot, /"Heading 21"/);
assert.match(budget.snapshot, /\(truncated, 10 more\)/);
assert.equal("actions" in budget, false);
assert.equal("headings" in budget, false);

const orphan = await run({
  overview: {
    title: "Orphan", url: "https://example.com/forms/post",
    actions: [{ selector: "#orphan", role: "button", text: "Orphan" }],
  },
  bound: { loaderId: "loader", ids: [9] },
  describe(params) {
    if (params.backendNodeId === 9) return { node: { nodeId: 90, backendNodeId: 9, parentId: 20 } };
    if (params.nodeId === 20) return { node: { nodeId: 20, backendNodeId: 2, parentId: 10, children: [{ backendNodeId: 8 }, { backendNodeId: 9 }, { backendNodeId: 4 }] } };
    if (params.nodeId === 10) return { node: { nodeId: 10, backendNodeId: 1 } };
    return { node: {} };
  },
  nodes: [
    ax({ id: "root", children: ["section"], backend: 1, role: "RootWebArea", name: "Page" }),
    ax({ id: "section", parent: "root", children: ["left", "right"], backend: 2, role: "group", name: "Section" }),
    ax({ id: "left", parent: "section", backend: 8, role: "link", name: "Left" }),
    ax({ id: "right", parent: "section", backend: 4, role: "link", name: "Right" }),
  ],
});
const orphanLines = orphan.snapshot.split("\n");
const leftAt = orphanLines.findIndex(item => item.includes("Left"));
const orphanAt = orphanLines.findIndex(item => item.includes("Orphan"));
const rightAt = orphanLines.findIndex(item => item.includes("Right"));
assert.ok(leftAt >= 0 && orphanAt > leftAt && rightAt > orphanAt, orphan.snapshot);
const orphanTarget = orphanLines[orphanAt].match(/target=(uid:\S+)/)?.[1];
const resolvedOrphan = await element.resolveElementReference(8, { target: orphanTarget }, context);
assert.equal(resolvedOrphan.selector, "");
assert.equal(resolvedOrphan.ref.backendNodeId, 9);

const urls = await run({
  overview: { title: "Links", url: "https://example.com/forms/post?run=s5-C-r1", actions: [] },
  nodes: [
    ax({ id: "root", children: ["next", "out", "here", "query", "top"], backend: 1, role: "RootWebArea", name: "Page", url: "https://example.com/forms/post?run=s5-C-r1" }),
    ax({ id: "next", parent: "root", backend: 2, role: "link", name: "Next", url: "https://example.com/forms/next" }),
    ax({ id: "out", parent: "root", backend: 3, role: "link", name: "Out", url: "https://other.example/x" }),
    ax({ id: "here", parent: "root", backend: 4, role: "link", name: "Here", url: "https://example.com/forms/post#section" }),
    ax({ id: "query", parent: "root", backend: 5, role: "link", name: "Query", url: "https://example.com/forms/post?x=1" }),
    ax({ id: "top", parent: "root", backend: 6, role: "link", name: "Top", url: "https://example.com/x" }),
  ],
});
assert.match(line(urls.snapshot, "RootWebArea"), /url="https:\/\/example\.com\/forms\/post\?run=s5-C-r1"/);
assert.match(line(urls.snapshot, "Next"), /url="https:\/\/example\.com\/forms\/next"/);
assert.match(line(urls.snapshot, "Out"), /url="https:\/\/other\.example\/x"/);
assert.match(line(urls.snapshot, "Here"), /url="https:\/\/example\.com\/forms\/post#section"/);
assert.match(line(urls.snapshot, "Query"), /url="https:\/\/example\.com\/forms\/post\?x=1"/);
assert.match(line(urls.snapshot, "Top"), /url="https:\/\/example\.com\/x"/);

const names = await run({
  overview: { title: "Names", url: "https://example.com/forms/post", actions: [] },
  nodes: [
    ax({ id: "root", children: ["text", "box", "empty", "dup", "inline", "own"], backend: 1, role: "button", name: "Save" }),
    ax({ id: "text", parent: "root", children: ["slice"], backend: 2, role: "StaticText", name: "Save" }),
    ax({ id: "slice", parent: "text", backend: 3, role: "InlineTextBox", name: "Save" }),
    ax({ id: "box", parent: "root", backend: 4, role: "InlineTextBox", name: "Save" }),
    ax({ id: "empty", parent: "root", backend: 5, role: "StaticText", name: "" }),
    ax({ id: "dup", parent: "root", backend: 6, role: "StaticText", name: "Note" }),
    ax({ id: "inline", parent: "root", backend: 7, role: "InlineTextBox", name: "Note" }),
    ax({ id: "own", parent: "root", backend: 8, role: "StaticText", name: "Note" }),
  ],
});
assert.match(line(names.snapshot, "button"), /"Save"/);
const noteLines = names.snapshot.split("\n").filter(item => item.includes("StaticText"));
assert.equal(noteLines.length, 2, "same-named sibling StaticText stays");
assert.match(noteLines[0], /"Note"/);
assert.match(noteLines[1], /"Note"/);
assert.equal(names.snapshot.includes("InlineTextBox"), false);
assert.equal(names.returnedNodeCount, 3);

const repeatedValues = await run({
  overview: { title: "Repeated values", url: "https://example.com/forms/post", actions: [] },
  nodes: [
    ax({ id: "root", children: ["price", "score"], backend: 1, role: "RootWebArea", name: "Repeated values" }),
    ax({ id: "price", parent: "root", children: ["priceLabel", "priceValue", "stockLabel", "stockValue"], backend: 2, role: "paragraph", name: "Price: 100; Stock: 100" }),
    ax({ id: "priceLabel", parent: "price", backend: 3, role: "StaticText", name: "Price:" }),
    ax({ id: "priceValue", parent: "price", children: ["priceInline"], backend: 4, role: "StaticText", name: "100" }),
    ax({ id: "priceInline", parent: "priceValue", backend: 5, role: "InlineTextBox", name: "100" }),
    ax({ id: "stockLabel", parent: "price", backend: 6, role: "StaticText", name: "; Stock:" }),
    ax({ id: "stockValue", parent: "price", children: ["stockInline"], backend: 7, role: "StaticText", name: "100" }),
    ax({ id: "stockInline", parent: "stockValue", backend: 8, role: "InlineTextBox", name: "100" }),
    ax({ id: "score", parent: "root", children: ["scoreLabel", "scoreNum", "scoreSlash", "scoreDen"], backend: 9, role: "paragraph", name: "Score: 10 / 10" }),
    ax({ id: "scoreLabel", parent: "score", backend: 10, role: "StaticText", name: "Score:" }),
    ax({ id: "scoreNum", parent: "score", backend: 11, role: "StaticText", name: "10" }),
    ax({ id: "scoreSlash", parent: "score", backend: 12, role: "StaticText", name: "/" }),
    ax({ id: "scoreDen", parent: "score", children: ["scoreDenInline"], backend: 13, role: "StaticText", name: "10" }),
    ax({ id: "scoreDenInline", parent: "scoreDen", backend: 14, role: "InlineTextBox", name: "10" }),
  ],
});
const repeatedText = repeatedValues.snapshot.split("\n").filter(item => item.includes("StaticText")).map(item => item.match(/StaticText "([^"]*)"/)?.[1]);
assert.deepEqual(repeatedText, ["Price:", "100", "; Stock:", "100", "Score:", "10", "/", "10"]);
assert.equal(repeatedValues.snapshot.includes("InlineTextBox"), false);
assert.equal(repeatedValues.outlineTruncated, false);

const distinct = await run({
  overview: { title: "Distinct", url: "https://example.com/forms/post", actions: [] },
  nodes: [
    ax({ id: "root", children: ["text"], backend: 1, role: "button", name: "Save text" }),
    ax({ id: "text", parent: "root", backend: 2, role: "StaticText", name: "Save" }),
  ],
});
assert.match(line(distinct.snapshot, "StaticText"), /"Save"/);

const informative = await run({
  overview: {
    title: "Informative", url: "https://example.com/forms/post",
    actions: [{ selector: "#act", role: "StaticText", text: "Save" }],
  },
  bound: { loaderId: "loader", ids: [9] },
  nodes: [
    ax({ id: "root", children: ["act", "flag", "valued"], backend: 1, role: "button", name: "Save" }),
    ax({ id: "act", parent: "root", backend: 9, role: "StaticText", name: "Save" }),
    ax({ id: "flag", parent: "root", backend: 10, role: "StaticText", name: "Save", properties: [{ name: "checked", value: { value: true } }] }),
    ax({ id: "valued", parent: "root", backend: 11, role: "InlineTextBox", name: "Save", value: "typed" }),
  ],
});
assert.match(line(informative.snapshot, "StaticText"), /"Save"/);
assert.match(informative.snapshot, /checked/);
assert.match(line(informative.snapshot, "InlineTextBox"), /value="typed"/);
const actionTarget = line(informative.snapshot, "StaticText").match(/target=(uid:\S+)/)?.[1];
const resolvedAction = await element.resolveElementReference(8, { target: actionTarget }, context);
assert.equal(resolvedAction.ref.backendNodeId, 9);

const textIds = Array.from({ length: 30 }, (_value, index) => `th${index + 1}`);
const textBudget = await run({
  limit: 20,
  overview: { title: "Text budget", url: "https://example.com/forms/post", actions: [] },
  nodes: [
    ax({ id: "root", children: textIds, backend: 1, role: "RootWebArea", name: "Page" }),
    ...textIds.map((id, index) => ax({
      id, parent: "root", children: [`${id}t`], backend: 300 + index, role: "heading", name: `Heading ${index + 1}`,
    })),
    ...textIds.map((id, index) => ax({
      id: `${id}t`, parent: id, children: [`${id}i`], backend: 400 + index, role: "StaticText", name: `Heading ${index + 1}`,
    })),
    ...textIds.map((id, index) => ax({
      id: `${id}i`, parent: `${id}t`, backend: 500 + index, role: "InlineTextBox", name: `Heading ${index + 1}`,
    })),
  ],
});
assert.equal(textBudget.returnedNodeCount, 20);
assert.match(textBudget.snapshot, /"Heading 19"/);
assert.doesNotMatch(textBudget.snapshot, /"Heading 20"/);
assert.match(textBudget.snapshot, /\(truncated, 11 more\)/);
assert.doesNotMatch(textBudget.snapshot, /StaticText|InlineTextBox/);

const merged = await run({
  overview: {
    title: "Merge", url: "https://example.com/forms/post",
    actions: [
      { selector: "#agree", role: "checkbox", text: "Agree", placeholder: "Email", checked: true, disabled: true },
      { selector: "#file", role: "button", type: "file", text: "Upload", accept: ".png", multiple: true, selectedFileCount: 0 },
    ],
  },
  bound: { loaderId: "loader", ids: [7, 8] },
  nodes: [
    ax({ id: "root", children: ["box", "file"], backend: 1, role: "RootWebArea", name: "Page" }),
    ax({ id: "box", parent: "root", backend: 7, role: "checkbox" }),
    ax({ id: "file", parent: "root", backend: 8, role: "button", name: "Upload" }),
  ],
});
const agree = line(merged.snapshot, "Agree");
assert.match(agree, /checkbox/);
assert.match(agree, /placeholder="Email"/);
assert.match(agree, /\bchecked\b/);
assert.match(agree, /\bdisabled\b/);
const upload = line(merged.snapshot, "Upload");
assert.match(upload, /type=file/);
assert.match(upload, /accept="\.png"/);
assert.match(upload, /\bmultiple\b/);
assert.match(upload, /selectedFileCount=0/);

const kept = await run({
  overview: {
    title: "Kept", url: "https://example.com/forms/post",
    actions: [{ selector: "#click", role: "button", text: "Click me" }],
  },
  bound: { loaderId: "loader", ids: [5] },
  nodes: [
    ax({ id: "root", children: ["ghost"], backend: 1, role: "RootWebArea", name: "Page" }),
    ax({ id: "ghost", parent: "root", backend: 5, role: "generic", ignored: true }),
  ],
});
const clicks = kept.snapshot.split("\n").filter(item => item.includes("Click me"));
assert.equal(clicks.length, 1);
assert.match(clicks[0], /generic "Click me"/);

const sameName = await run({
  overview: {
    title: "Search", url: "https://example.com/forms/post",
    actions: [{ selector: "#search", role: "button", text: "Search" }],
  },
  bound: { loaderId: "loader", ids: [999] },
  nodes: [
    ax({ id: "root", children: ["heading"], backend: 1, role: "RootWebArea", name: "Page" }),
    ax({ id: "heading", parent: "root", backend: 2, role: "heading", name: "Search" }),
  ],
});
const headingLine = line(sameName.snapshot, "heading");
const buttonLine = line(sameName.snapshot, "button");
assert.match(headingLine, /"Search"/);
assert.doesNotMatch(headingLine, /\bbutton\b/);
assert.match(buttonLine, /button "Search"/);
const headingTarget = headingLine.match(/target=(uid:\S+)/)?.[1];
const buttonTarget = buttonLine.match(/target=(uid:\S+)/)?.[1];
const resolvedHeading = await element.resolveElementReference(8, { target: headingTarget }, context);
const resolvedButton = await element.resolveElementReference(8, { target: buttonTarget }, context);
assert.equal(resolvedHeading.ref.role, "heading");
assert.equal(resolvedHeading.ref.backendNodeId, 2, "a same-named heading must not absorb the action");
assert.equal(resolvedButton.ref.role, "button");
assert.equal(resolvedButton.ref.backendNodeId, 999);

const treeTarget = budget.snapshot.match(/target=(uid:\S+)/)?.[1];
const resolvedTree = await element.resolveElementReference(8, { target: treeTarget }, context);
assert.equal(resolvedTree.uid, treeTarget.slice(4));
assert.match(resolvedTree.uid, /^t8\.[0-9a-z]{6}\.\d+$/);

console.log("ax snapshot compact tests passed");

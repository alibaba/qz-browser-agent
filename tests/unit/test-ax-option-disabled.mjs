import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalChrome = globalThis.chrome;
const debuggerEvents = [];
globalThis.chrome = { debugger: { onEvent: { addListener: listener => debuggerEvents.push(listener) } } };
after(() => { globalThis.chrome = originalChrome; });
const { registerAccessibilityTools } = await import("../../src/capabilities/accessibility/tools.js");
const { ToolExecutionError } = await import("../../src/background/tools/arguments.js");
const { forgetChildFrames } = await import("../../src/background/tools/child-frames.js");

const property = (name, value) => ({ name, value: { value } });
const node = (id, role, disabled) => ({
  nodeId: String(id), backendDOMNodeId: id, parentId: "root", role: { value: role }, name: { value: `Node ${id}` },
  properties: disabled === undefined ? [] : [property("disabled", disabled)],
});
const tree = (nodes, root = "root") => [
  { nodeId: root, role: { value: "RootWebArea" }, childIds: nodes.map(node => node.nodeId) },
  ...nodes.map(node => ({ ...node, parentId: root })),
];

function harness(nodes, handlers = {}) {
  const calls = [], refs = [], partials = [];
  const responses = {
    "Accessibility.getFullAXTree": () => ({ nodes: structuredClone(nodes) }),
    "Page.getFrameTree": () => ({}),
    "DOM.resolveNode": params => ({ object: { objectId: `object-${params.backendNodeId}` } }),
    "Runtime.callFunctionOn": () => ({ result: { value: false } }),
    "Runtime.releaseObjectGroup": () => ({}),
    ...handlers,
  };
  const send = async (method, params = {}) => {
    calls.push({ method, params });
    if (!responses[method]) throw new Error(`Unexpected CDP: ${method}`);
    return responses[method](params);
  };
  let definition;
  registerAccessibilityTools({
    registerTool: value => { definition = value; }, ToolExecutionError,
    clampLimit: (value, min, max) => Math.max(min, Math.min(value, max)),
    makeSnapshotId: () => "snapshot", elementTargetForUid: uid => `uid:${uid}`,
    registerElementRef: ref => refs.push(ref),
    sendToContent: async () => ({ title: "Page", url: "https://example.test/", actions: [] }),
    withDebugger: async (_id, fn) => fn({}, send), elementTargetGrammar: "target grammar",
  });
  return {
    calls, refs, partials, send,
    run: () => definition.execute({ tabId: 8, scope: "full" }, undefined, {
      sessionId: "owner", reportPartial: result => partials.push(result),
    }),
  };
}
const callsFor = (h, method) => h.calls.filter(call => call.method === method).map(call => call.params);
function assertDisabled(result, id, disabled) {
  const line = result.snapshot.split("\n").find(line => line.includes(`"Node ${id}"`));
  assert.ok(line, result.snapshot);
  assert.equal(/\bdisabled\b/.test(line), disabled, line);
}
function assertReleased(h) {
  const groups = callsFor(h, "DOM.resolveNode").map(params => params.objectGroup);
  assert.ok(groups.length);
  assert.match(groups[0], /^qz-ax-option-disabled-/);
  assert.ok(groups.every(group => group === groups[0]));
  assert.deepEqual(callsFor(h, "Runtime.releaseObjectGroup"), [{ objectGroup: groups[0] }]);
}

test("only disabled option/optgroup candidates are resolved; other flags and UIDs stay intact", async () => {
  const nodes = tree([
    node(1, "option", true), node(2, "optgroup", true), node(3, "button", true),
    node(4, "combobox", true), node(5, "group", true), node(6, "option"), node(7, "optgroup", false),
  ]);
  nodes[1].properties.push(property("selected", true));
  const h = harness(nodes);
  const result = await h.run();
  assert.deepEqual(callsFor(h, "DOM.resolveNode").map(params => params.backendNodeId), [1, 2]);
  for (const id of [1, 2, 6, 7]) assertDisabled(result, id, false);
  for (const id of [3, 4, 5]) assertDisabled(result, id, true);
  assert.match(result.snapshot, /target=uid:snapshot\.1 option "Node 1" selected/);
  assert.deepEqual(h.refs.slice(-8).map(ref => ref.uid), Array.from({ length: 8 }, (_, i) => `snapshot.${i}`));
  assert.equal(result.nodeCount, 8);
  for (const partial of h.partials) assertDisabled(partial, 1, false);
  for (const call of callsFor(h, "Runtime.callFunctionOn")) {
    assert.equal(call.functionDeclaration, `function() { return this.matches(':disabled') || !!this.closest('select:disabled, optgroup:disabled, [aria-disabled="true"]'); }`);
    assert.equal(call.returnByValue, true);
  }
  assertReleased(h);
});

test("zero candidates makes zero correction calls and never adds disabled", async () => {
  const h = harness(tree([node(1, "option"), node(2, "optgroup", false), node(3, "button", true)]), {
    "Runtime.callFunctionOn": () => ({ result: { value: true } }),
  });
  const result = await h.run();
  assert.deepEqual(h.calls.map(call => call.method), ["Accessibility.getFullAXTree", "Page.getFrameTree"]);
  assertDisabled(result, 1, false);
  assertDisabled(result, 2, false);
  assertDisabled(result, 3, true);
});

test("only a strictly false result clears disabled", async () => {
  const values = [false, true, 0, "", undefined, null, "false"];
  const h = harness(tree(values.map((_, index) => node(index + 1, "option", true))), {
    "Runtime.callFunctionOn": ({ objectId }) => ({ result: { value: values[Number(objectId.split("-")[1]) - 1] } }),
  });
  const result = await h.run();
  values.forEach((value, index) => assertDisabled(result, index + 1, value !== false));
  assertReleased(h);
});

test("per-node failures retain disabled, later candidates still run, and cleanup failure is quiet", async () => {
  const nodes = tree(Array.from({ length: 6 }, (_, index) => node(index + 1, "option", true)));
  delete nodes[6].backendDOMNodeId;
  const h = harness(nodes, {
    "DOM.resolveNode": ({ backendNodeId }) => {
      if (backendNodeId === 1) throw new Error("Node detached");
      return backendNodeId === 2 ? {} : { object: { objectId: `object-${backendNodeId}` } };
    },
    "Runtime.callFunctionOn": ({ objectId }) => {
      if (objectId === "object-3") throw new Error("Context destroyed");
      return { result: { value: false }, ...(objectId === "object-4" ? { exceptionDetails: { text: "Exception" } } : {}) };
    },
    "Runtime.releaseObjectGroup": () => { throw new Error("Session gone"); },
  });
  const result = await h.run();
  for (const id of [1, 2, 3, 4, 6]) assertDisabled(result, id, true);
  assertDisabled(result, 5, false);
  assert.deepEqual(callsFor(h, "DOM.resolveNode").map(params => params.backendNodeId), [1, 2, 3, 4, 5]);
  assertReleased(h);
});

for (const unavailable of ["DOM.resolveNode", "Runtime.callFunctionOn"]) {
  test(`${unavailable} unavailable leaves Firefox-style hosts unchanged and releases the group`, async () => {
    const h = harness(tree([node(1, "option", true), node(2, "optgroup", true)]), {
      [unavailable]: () => { throw new Error(`Unsupported debugger command: ${unavailable}`); },
    });
    const result = await h.run();
    assertDisabled(result, 1, true);
    assertDisabled(result, 2, true);
    assertReleased(h);
  });
}

test("main, local iframe and child session use their own document send and object group", async () => {
  const remoteCalls = [];
  const remote = async (method, params = {}) => {
    remoteCalls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "remote", loaderId: "remote-loader" } } };
    // Backend and AX ids deliberately collide with the main document.
    if (method === "Accessibility.getFullAXTree") return { nodes: tree([node(1, "option", true)]) };
    if (method === "DOM.resolveNode") return { object: { objectId: "remote-option" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: true } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected child CDP: ${method}`);
  };
  const main = tree([node(1, "option", true), node(10, "Iframe"), node(20, "Iframe")]);
  const h = harness(main, {
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main" }, childFrames: [{ frame: { id: "local" } }] } }),
    "Accessibility.getFullAXTree": ({ frameId }) => ({ nodes: structuredClone(frameId === "local"
      ? tree([node(2, "option", true)], "local-root") : main) }),
    "DOM.getFrameOwner": ({ frameId }) => ({ backendNodeId: frameId === "local" ? 10 : 20 }),
    "Target.setAutoAttach": () => {
      for (const listener of debuggerEvents) listener({ tabId: 8 }, "Target.attachedToTarget", {
        sessionId: "remote-session", targetInfo: { type: "iframe", targetId: "remote", parentFrameId: "main" },
      });
      return {};
    },
  });
  h.send.tabId = 8;
  h.send.inSession = sessionId => {
    assert.equal(sessionId, "remote-session");
    return remote;
  };
  try {
    const result = await h.run();
    const options = result.snapshot.split("\n").filter(line => /\boption\b/.test(line));
    assert.equal(options.length, 3);
    assert.equal(/disabled/.test(options[0]), false);
    assert.equal(/disabled/.test(options[1]), false);
    assert.equal(/disabled/.test(options[2]), true);
    assert.deepEqual(callsFor(h, "DOM.resolveNode").map(params => params.backendNodeId), [1, 2]);
    const child = { calls: remoteCalls };
    assert.deepEqual(callsFor(child, "DOM.resolveNode").map(params => params.backendNodeId), [1]);
    assert.deepEqual(callsFor(child, "Runtime.callFunctionOn").map(params => params.objectId), ["remote-option"]);
    assertReleased(child);
    const groups = [...callsFor(h, "DOM.resolveNode"), ...callsFor(child, "DOM.resolveNode")].map(params => params.objectGroup);
    assert.equal(new Set(groups).size, 3, "each document pass owns its group");
    assert.deepEqual(callsFor(h, "Runtime.releaseObjectGroup"), groups.slice(0, 2).map(objectGroup => ({ objectGroup })));
    assert.ok(h.refs.some(ref => ref.frameId === "remote" && ref.backendNodeId === 1));
  } finally {
    forgetChildFrames(8);
  }
});

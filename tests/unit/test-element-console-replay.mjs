import assert from "node:assert/strict";
import { test } from "node:test";

const listeners = [];
globalThis.chrome = {
  runtime: { id: "extension-id" },
  storage: { local: { async get() { return {}; } } },
  debugger: {
    onEvent: { addListener(listener) { listeners.push(listener); } },
    onDetach: { addListener() {} },
  },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
const { createDiagnosticsTools } = await import("../../src/capabilities/diagnostics/tools.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const definitions = new Map();
const sessions = new Map();
createDiagnosticsTools({
  registerTool(definition) { definitions.set(definition.name, definition); },
  ToolExecutionError,
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async sendCdp(tabId, method, params = {}) {
    const page = sessions.get(tabId);
    if (!page) throw new Error(`No debugger session for tab ${tabId}`);
    return page.send(method, params);
  },
  assertUrlAllowed() {},
  secondsToMs(value, fallback) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : fallback;
  },
});

const run = { sessionId: "session-a", runId: "run-1" };
let nextTab = 40;

function counts(result) {
  const tally = new Map();
  for (const row of result.results || []) {
    const key = `${row.type}:${row.text}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return Object.fromEntries([...tally.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

// Chrome reports existing contexts and replays stored console calls only when
// Runtime transitions from disabled to enabled. A second enable is a no-op.
function session(tabId, contexts) {
  let runtimeEnabled = false;
  const buffer = [];
  const commands = [];
  const emit = (method, params) => listeners.forEach(listener => listener({ tabId }, method, params));
  const send = async (method, params = {}) => {
    commands.push(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", loaderId: "document-1" } } };
    if (method === "Runtime.disable") {
      runtimeEnabled = false;
      return {};
    }
    if (method === "Runtime.enable") {
      if (runtimeEnabled) return {};
      runtimeEnabled = true;
      for (const context of contexts) emit("Runtime.executionContextCreated", { context: publicContext(context) });
      for (const message of buffer) emit(message.method, message.params);
      return {};
    }
    if (method === "Runtime.evaluate") {
      const context = contexts.find(item => item.id === params.contextId);
      if (!context) throw new Error("Cannot find context with specified id");
      return { result: { value: { extensionId: context.extensionId, bridge: context.bridge } } };
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  };
  const remember = (method, params) => {
    buffer.push({ method, params });
    emit(method, params);
  };
  return { commands, contexts, emit, send, remember, enabled: () => runtimeEnabled };
}

function publicContext(context) {
  return { id: context.id, origin: context.origin, auxData: context.auxData };
}

function isolated(id, bridge) {
  return {
    id,
    origin: "chrome-extension://extension-id",
    auxData: { type: "isolated", frameId: "main" },
    extensionId: "extension-id",
    bridge,
  };
}

function runtimeFor(tabId, page) {
  let initialized = 0;
  const runtime = createElementRuntime({
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({}),
    makeSessionTabTargetError: code => new ToolExecutionError(code, code),
    assertTabAllowed: async () => {},
    sendToContent: async () => { throw new Error("UID must not use CSS fallback"); },
    async initializeContentScript() {
      initialized += 1;
      await page.initialize?.(page);
    },
    async withDebugger(_tabId, callback) { return callback({ tabId }, page.send); },
  });
  return {
    get initialized() { return initialized; },
    call: () => runtime.callElement(tabId, {
      tabId, uid: "original", ref: { backendNodeId: 44, loaderId: "document-1" },
    }, "inspectElement"),
  };
}

test("uid resolution does not replay console messages already recorded for the tab", async () => {
  const tabId = nextTab++;
  const contexts = [isolated(7, false)];
  const page = session(tabId, contexts);
  sessions.set(tabId, page);
  await definitions.get("read_console_messages").execute({ tabId, reset: true }, null, run);
  page.remember("Runtime.consoleAPICalled", {
    type: "log", args: [{ type: "string", value: "once" }], timestamp: 10,
  });
  page.remember("Runtime.consoleAPICalled", {
    type: "log", args: [{ type: "string", value: "once" }], timestamp: 11,
  });
  page.remember("Runtime.exceptionThrown", {
    timestamp: 12,
    exceptionDetails: { text: "boom", exception: { type: "object", description: "boom" } },
  });
  const before = await definitions.get("read_console_messages").execute({ tabId }, null, run);
  assert.deepEqual(counts(before), { "exception:boom": 1, "log:once": 2 });

  const runtime = runtimeFor(tabId, {
    ...page,
    async initialize() { contexts[0].bridge = true; },
  });
  assert.equal((await runtime.call()).ok, true);
  assert.equal(runtime.initialized, 1);
  const after = await definitions.get("read_console_messages").execute({ tabId }, null, run);
  assert.deepEqual(counts(after), counts(before), "cached console calls must not be recorded again");
  assert.equal(after.totalBuffered, before.totalBuffered);
  assert.equal(page.commands.includes("Runtime.disable"), false);
  assert.equal(page.commands.includes("Runtime.enable"), true);
});

test("a context created while Runtime is enabled resolves without toggling the domain", async () => {
  const tabId = nextTab++;
  const contexts = [];
  const page = session(tabId, contexts);
  sessions.set(tabId, page);
  await definitions.get("read_console_messages").execute({ tabId, reset: true }, null, run);
  page.remember("Runtime.consoleAPICalled", {
    type: "warning", args: [{ type: "string", value: "kept" }], timestamp: 20,
  });
  const before = await definitions.get("read_console_messages").execute({ tabId }, null, run);

  const runtime = runtimeFor(tabId, {
    ...page,
    initialize() {
      const context = isolated(9, true);
      contexts.push(context);
      if (page.enabled()) page.emit("Runtime.executionContextCreated", { context: publicContext(context) });
    },
  });
  assert.equal((await runtime.call()).ok, true);
  assert.equal(runtime.initialized, 1);
  const after = await definitions.get("read_console_messages").execute({ tabId }, null, run);
  assert.deepEqual(counts(after), { "warning:kept": 1 });
  assert.deepEqual(counts(before), counts(after));
  assert.equal(page.commands.includes("Runtime.disable"), false);
});

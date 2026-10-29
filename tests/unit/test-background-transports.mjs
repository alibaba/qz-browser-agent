import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createBackgroundApi,
  resolveBackgroundApiMethod,
} from "../../src/background/background-api.js";
import { createMcpTransport } from "../../src/background/transports/mcp.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { createSidepanelTransport } from "../../src/background/transports/sidepanel.js";
import {
  clearTraceLog,
  getTraceLog,
  setTraceDebugMode,
} from "../../src/background/trace.js";

const calls = [];
const runtimes = new Map([["s1", { sessionId: "s1", status: "completed", running: false, runId: "run-1" }]]);
const api = createBackgroundApi({
  system: {
    ready: async () => calls.push(["ready"]),
    contentLanguage: async () => ({ v: 1, locale: "ja", messages: { brand: "Qingzhou", noStableSelector: "選択できません", importFailed: "読み込めません" } }),
    ping: async () => ({ pong: true }),
    runtimeMessage: async message => ({ message }),
  },
  sessions: {
    list: async options => ({ sessions: { s1: { id: "s1" } }, options }),
    create: async input => ({ session: input }),
    createUi: async input => {
      calls.push(["create_ui_session", input]);
      return { session: { id: "created-session", title: input.title } };
    },
    send: async input => {
      calls.push(["send", input]);
      return { accepted: true, sessionId: input.sessionId };
    },
    submit: async input => {
      calls.push(["submit", input]);
      return {
        accepted: true,
        sessionId: input.sessionId,
        disposition: "started",
        promise: Promise.resolve(),
      };
    },
    followUp: async input => {
      calls.push(["follow_up", input]);
      if (input.detachWindow) sidepanelWindowId = null;
      return { accepted: true, sessionId: input.sessionId };
    },
    getDraft: async input => {
      calls.push(["get_draft", input]);
      return { sessionId: input.sessionId, draft: null };
    },
    saveDraft: async input => {
      if (input.draft?.text === "fail-store") throw new Error("draft store unavailable");
      calls.push(["sync_draft", input]);
      return { sessionId: input.sessionId, draft: input.draft };
    },
    consumeDraft: async input => {
      calls.push(["consume_draft", input]);
      return true;
    },
    compact: async input => ({
      sessionId: input.sessionId,
      compacted: true,
      instructionApplied: Boolean(input.instruction),
    }),
    continueWait: async input => ({ accepted: true, waitId: input.waitId }),
    userInput: async input => {
      calls.push(["user_input", input]);
      return { sessionId: input.sessionId, waiting: true, waitId: "wait-input", kind: "location_consent", consentVersion: 1 };
    },
    respondToUserInput: async input => {
      calls.push(["respond_to_user_input", input]);
      if (input.sessionId === "native") return { accepted: false, requiresUserAction: true, code: "BROWSER_PERMISSION_REQUIRED", waitId: input.waitId };
      if (input.waitId === "old") return { accepted: false, stale: true, code: "STALE_WAIT", waitId: input.waitId };
      return { accepted: true, sessionId: input.sessionId, waitId: input.waitId, runId: "run-1" };
    },
    submitWaitForm: async input => ({ accepted: true, waitId: input.waitId }),
    cancelWait: async input => ({ accepted: true, waitId: input.waitId }),
    state: async sessionId => ({ sessionId, status: runtimes.get(sessionId)?.status || "idle", runtime: runtimes.get(sessionId) || {} }),
    snapshot: async sessionId => ({ sessionId, transcript: [], runtime: runtimes.get(sessionId) || {} }),
    messages: async (sessionId, options) => {
      calls.push(["messages", sessionId, options]);
      return { sessionId, session: [], transcript: [] };
    },
    history: async sessionId => ({ sessionId, messages: [] }),
    stop: async (sessionId, options) => {
      if (sessionId === "forbidden") {
        const error = new Error("stop denied");
        error.code = "STOP_DENIED";
        throw error;
      }
      calls.push(["stop", sessionId, options]);
      const runtime = { sessionId, status: "aborted", running: false, runId: "run-1" };
      runtimes.set(sessionId, runtime);
      return { sessionId, stopped: true, runId: "run-1", runtime };
    },
    clearGoal: async sessionId => ({ sessionId, cleared: true }),
  },
  tools: {
    list: async () => ({ tools: [] }),
    execute: async params => ({ toolName: params.name, result: {} }),
    acceptRunScriptInnerMessage: message => (
      message.type === "run_script_inner_result" ? { ok: true, handled: true } : null
    ),
    executeRunScriptCall: async (message, sender) => {
      if (message.toolName === "fail") {
        const error = new Error("nested call failed");
        error.code = "NESTED_FAILED";
        throw error;
      }
      return { ok: true, result: { toolName: message.toolName, senderTabId: sender?.tab?.id || null } };
    },
    executeInnerFetch: async (message, sender) => ({
      requestId: message.requestId,
      senderUrl: sender?.url || "",
      status: 200,
    }),
    cancelInnerFetch: (message, sender) => {
      if (message.callId === "fail") {
        throw Object.assign(new Error("cancel failed"), {
          code: "CANCEL_FAILED",
          details: { callId: message.callId },
          diagnostic: { retryable: false },
        });
      }
      return {
        requestId: message.requestId,
        callId: message.callId,
        senderUrl: sender?.url || "",
        cancelled: true,
      };
    },
  },
  data: {
    listTables: async () => ({ tables: [{ name: "prices", count: 2 }] }),
    deleteTable: async params => ({ table: params.table, deleted: true }),
    exportTable: async params => ({ ...params, downloadId: 1 }),
    listImageCollections: async () => ({ collections: [{ name: "photos", count: 3 }] }),
    deleteImageCollection: async params => ({ ...params, deleted: true }),
    exportImageCollection: async params => ({ ...params, downloadId: 2 }),
    listDownloads: async params => ({ downloads: [{ downloadId: params.id || 1, state: "complete" }] }),
  },
  skills: {
    list: async () => ({ skills: [] }),
    get: async params => ({ name: params.name }),
    resource: async params => ({ name: params.name, path: params.path }),
    export: async params => ({ ...params, downloadId: 3 }),
    contributions: async () => ({ tools: [] }),
    refresh: async () => ({ skillToolRegistry: {} }),
  },
  exchange: {
    importFromPage: async (message, sender) => {
      if (message.fail) throw new Error("bad import");
      return { sessionId: message.sessionId, sourceTabId: sender?.tab?.id || null };
    },
  },
  settings: {
    get: async params => ({ config: { model: "m1" }, ...params }),
    update: async params => ({ config: params.config, updated: Object.keys(params.config) }),
  },
  config: {
    get: async () => ({ provider: "deepseek", model: "test" }),
    save: async config => {
      calls.push(["save_config", config]);
      return { ...config, saved: true };
    },
    getRuntime: () => ({ provider: "deepseek" }),
    setRuntime: config => config,
  },
  skillSettings: {
    list: async () => ({ settings: [{ id: "demo::plugin", configured: false }] }),
    save: async input => ({ setting: { id: `${input.skillName}::${input.pluginId}`, configured: true, valuesAccepted: Object.keys(input.values) } }),
    remove: async input => ({ setting: { id: `${input.skillName}::${input.pluginId}`, configured: false } }),
  },
  automations: {
    list: async () => ({ automations: [] }),
    run: async automationId => ({ automationId }),
  },
  trace: {
    get: async () => [],
    clear: async () => undefined,
  },
});

assert.equal(resolveBackgroundApiMethod(api, "config.get"), api.config.get);
assert.throws(() => resolveBackgroundApiMethod(api, "missing.get"), error => error?.code === "BACKGROUND_API_METHOD_UNAVAILABLE");

const mcp = createMcpTransport(api, {
  bridge: {
    describe: () => ({ methods: ["ping"] }),
    getConfig: () => ({ enabled: true }),
    saveConfig: config => config,
  },
});
assert.deepEqual(await mcp.dispatch({ method: "get_config" }), { provider: "deepseek", model: "test" });
assert.deepEqual(
  await mcp.dispatch({ method: "save_config", params: { config: { model: "m1" } } }),
  { model: "m1", saved: true },
);
assert.equal((await mcp.dispatch({ method: "stop_session", params: { sessionId: "s1", cascade: false } })).stopped, true);
assert.equal(mcp.methods.includes("get_user_input"), true);
assert.equal(mcp.methods.includes("respond_to_user_input"), true);
for (const [method, params, expected] of [
  ["list_data_tables", {}, { tables: [{ name: "prices", count: 2 }] }],
  ["delete_data_table", { table: "prices" }, { table: "prices", deleted: true }],
  ["export_data_table", { table: "prices", format: "xlsx" }, { table: "prices", format: "xlsx", downloadId: 1 }],
  ["list_image_collections", {}, { collections: [{ name: "photos", count: 3 }] }],
  ["delete_image_collection", { collection: "photos" }, { collection: "photos", deleted: true }],
  ["export_image_collection", { collection: "photos" }, { collection: "photos", downloadId: 2 }],
  ["list_downloads", { id: 2 }, { downloads: [{ downloadId: 2, state: "complete" }] }],
  ["export_skill", { name: "demo", filename: "demo.zip" }, { name: "demo", filename: "demo.zip", downloadId: 3 }],
  ["get_settings", { key: "model" }, { config: { model: "m1" }, key: "model" }],
  ["update_settings", { config: { model: "m2" } }, { config: { model: "m2" }, updated: ["model"] }],
]) {
  assert.ok(mcp.methods.includes(method), `Method must be discoverable: ${method}`);
  assert.deepEqual(await mcp.dispatch({ method, params }), expected, `Wrong owner dispatch: ${method}`);
}
assert.deepEqual(await mcp.dispatch({ method: "get_user_input", params: { sessionId: "s1" } }), {
  sessionId: "s1", waiting: true, waitId: "wait-input", kind: "location_consent", consentVersion: 1,
});
assert.deepEqual(calls.at(-1), ["user_input", { sessionId: "s1" }]);
const inputResponse = { sessionId: "s1", waitId: "wait-input", action: "approve", consentVersion: 1 };
assert.deepEqual(await mcp.dispatch({ method: "respond_to_user_input", params: inputResponse }), {
  accepted: true, sessionId: "s1", waitId: "wait-input", runId: "run-1",
});
assert.deepEqual(calls.at(-1), ["respond_to_user_input", inputResponse]);
const formResponse = { sessionId: "s1", waitId: "wait-form", action: "submit", answers: { city: "Hangzhou", selectedIds: ["a", "b"] } };
await mcp.dispatch({ method: "respond_to_user_input", params: formResponse });
assert.deepEqual(calls.at(-1), ["respond_to_user_input", formResponse]);
assert.deepEqual(await mcp.dispatch({ method: "respond_to_user_input", params: { sessionId: "native", waitId: "wait-permission", action: "approve" } }), {
  accepted: false, requiresUserAction: true, code: "BROWSER_PERMISSION_REQUIRED", waitId: "wait-permission",
});
assert.deepEqual(await mcp.dispatch({ method: "respond_to_user_input", params: { sessionId: "s1", waitId: "old", action: "reject" } }), {
  accepted: false, stale: true, code: "STALE_WAIT", waitId: "old",
});
await assert.rejects(
  mcp.dispatch({ method: "does_not_exist" }),
  error => error?.code === "METHOD_NOT_FOUND",
);

const responses = [];
let sidepanelWindowId = 42;
const sidepanel = createSidepanelTransport(api, { getWindowId: () => sidepanelWindowId });
const port = { postMessage: message => responses.push(message) };
await sidepanel.dispatch({ type: "get_composer_draft", requestId: "recover-draft", sessionId: "s1",
  windowId: 999, afterQueuedMutation: true }, port);
assert.deepEqual(calls.at(-1), ["get_draft", { sessionId: "s1", windowId: 42, afterQueuedMutation: true }]);
assert.deepEqual(responses.pop(), { type: "get_composer_draft_result", requestId: "recover-draft", sessionId: "s1", draft: null });
await sidepanel.dispatch({
  type: "create_ui_session",
  requestId: "create-draft",
  title: "Draft",
  windowId: 999,
  composerDraft: { messageId: "initial", text: "latest" },
}, port);
assert.equal(calls.at(-1)[0], "create_ui_session");
assert.equal(calls.at(-1)[1].windowId, 42);
assert.deepEqual(responses.pop(), {
  type: "create_ui_session_result",
  requestId: "create-draft",
  session: { id: "created-session", title: "Draft" },
});
await sidepanel.dispatch({
  type: "sync_composer_draft",
  sessionId: "s1",
  draft: { windowId: 999, sessionId: "s1", messageId: "draft-1", text: "latest" },
}, port);
assert.deepEqual(calls.at(-1), ["sync_draft", {
  windowId: 42,
  sessionId: "s1",
  draft: { windowId: 999, sessionId: "s1", messageId: "draft-1", text: "latest" },
}]);
await clearTraceLog();
setTraceDebugMode(true);
await sidepanel.dispatch({
  type: "prompt",
  requestId: "prompt-accept",
  sessionId: "s1",
  clientMessageId: "draft-1",
  text: "send",
  composerDraft: {
    windowId: 999,
    sessionId: "wrong-session",
    messageId: "wrong-message",
    text: "send",
  },
}, port);
const sendCall = calls.at(-1);
assert.equal(sendCall[0], "submit");
assert.deepEqual(calls.at(-2), ["sync_draft", {
  windowId: 42,
  sessionId: "s1",
  draft: {
    windowId: 999,
    sessionId: "s1",
    messageId: "draft-1",
    text: "send",
  },
}]);
assert.equal(sendCall[1].swallowErrors, false);
assert.equal(sendCall[1].sourceWindowId, 42, "prompt execution must keep the Side Panel host window");
assert.equal(calls.some(call => call[0] === "consume_draft"), false);
sidepanelWindowId = null; // Closing the panel after acceptance must not lose its captured scope.
await sendCall[1].onMessageAccepted({ clientMessageId: "draft-1" }, {
  disposition: "started",
  duplicate: false,
});
assert.deepEqual(calls.at(-1), ["consume_draft", {
  windowId: 42,
  sessionId: "s1",
  messageId: "draft-1",
}]);
assert.deepEqual(responses.pop(), {
  type: "prompt_accepted",
  requestId: "prompt-accept",
  accepted: true,
  sessionId: "s1",
  clientMessageId: "draft-1",
  disposition: "started",
  duplicate: false,
});
const deliveryTrace = (await getTraceLog()).filter(line => line.includes("message_delivery_trace"));
assert.deepEqual(
  deliveryTrace.map(line => line.match(/ phase=([^ ]+)/)?.[1]).filter(Boolean),
  [
    "background.received",
    "draft.synced",
    "background.run_completed",
    "background.accepted",
    "draft.consumed",
    "background.ack_sent",
  ],
);
assert.equal(deliveryTrace.every(line => line.includes("message=draft-1")), true);
assert.equal(deliveryTrace.some(line => line.includes("text=send")), false, "delivery trace must not include prompt content");
setTraceDebugMode(false);
await clearTraceLog();
await sidepanel.dispatch({
  type: "prompt",
  requestId: "prompt-queued",
  sessionId: "s1",
  clientMessageId: "draft-queued",
  text: "queue atomically",
  composerDraft: { text: "queue atomically" },
}, port);
const queuedSubmitCall = calls.at(-1);
assert.equal(queuedSubmitCall[0], "submit");
await queuedSubmitCall[1].onMessageAccepted({ clientMessageId: "draft-queued" }, {
  disposition: "queued",
  duplicate: false,
});
assert.deepEqual(responses.pop(), {
  type: "prompt_accepted",
  requestId: "prompt-queued",
  accepted: true,
  sessionId: "s1",
  clientMessageId: "draft-queued",
  disposition: "queued",
  duplicate: false,
});
sidepanelWindowId = 42;
await sidepanel.dispatch({
  type: "follow_up",
  sessionId: "s1",
  clientMessageId: "draft-2",
  text: "queue",
  detachWindow: true,
  composerDraft: { text: "queue" },
}, port);
assert.deepEqual(calls.at(-1), ["consume_draft", {
  windowId: 42,
  sessionId: "s1",
  messageId: "draft-2",
}]);
sidepanelWindowId = 42;
await sidepanel.dispatch({
  type: "prompt",
  sessionId: "s1",
  clientMessageId: "draft-store-failure",
  text: "send despite draft failure",
  composerDraft: { text: "fail-store" },
}, port);
assert.equal(calls.at(-1)[0], "submit", "draft persistence failure must not block message delivery");
await assert.rejects(
  createSidepanelTransport(api).dispatch({
    type: "sync_composer_draft",
    draft: { sessionId: "s1", text: "must stay window-scoped" },
  }, port),
  error => error?.code === "COMPOSER_DRAFT_WINDOW_REQUIRED",
);
await sidepanel.dispatch({ type: "get_config" }, port);
assert.deepEqual(responses.pop(), {
  type: "config",
  config: { provider: "deepseek", model: "test" },
});
await sidepanel.dispatch({ type: "save_config", requestId: "req-1", config: { model: "m2" } }, port);
assert.deepEqual(responses.pop(), {
  type: "config_saved",
  requestId: "req-1",
  config: { model: "m2", saved: true },
});
await sidepanel.dispatch({ type: "list_skill_settings" }, port);
assert.deepEqual(responses.pop(), {
  type: "skill_settings",
  settings: [{ id: "demo::plugin", configured: false }],
});
await sidepanel.dispatch({
  type: "save_skill_settings",
  requestId: "req-skill-settings-save",
  pluginId: "plugin",
  skillName: "demo",
  values: { endpoint: "https://example.test", secret: "secret-value" },
}, port);
assert.deepEqual(responses.pop(), {
  type: "skill_settings_saved",
  requestId: "req-skill-settings-save",
  setting: { id: "demo::plugin", configured: true, valuesAccepted: ["endpoint", "secret"] },
});
await sidepanel.dispatch({
  type: "delete_skill_settings",
  requestId: "req-skill-settings-delete",
  pluginId: "plugin",
  skillName: "demo",
}, port);
assert.deepEqual(responses.pop(), {
  type: "skill_settings_deleted",
  requestId: "req-skill-settings-delete",
  setting: { id: "demo::plugin", configured: false },
});
await sidepanel.dispatch({ type: "stop_session", requestId: "req-2", sessionId: "s1" }, port);
assert.deepEqual(responses.pop(), {
  type: "state",
  requestId: "req-2",
  sessionId: "s1",
  status: "aborted",
  runtime: { sessionId: "s1", status: "aborted", running: false, runId: "run-1" },
  isStreaming: false,
  runId: "run-1",
  hasHistory: true,
});
await sidepanel.dispatch({
  type: "compact_context",
  requestId: "req-compact",
  sessionId: "s1",
  instruction: "重点保留接口契约",
}, port);
assert.deepEqual(responses.pop(), {
  type: "compact_context_result",
  requestId: "req-compact",
  sessionId: "s1",
  compacted: true,
  instructionApplied: true,
});
assert.equal(await sidepanel.dispatch({ type: "does_not_exist" }, port), false);

assert.deepEqual(
  calls.filter(call => call[0] === "save_config").map(call => call[1].model),
  ["m1", "m2"],
  "MCP and Side Panel must invoke the same config command",
);
assert.equal(calls.filter(call => call[0] === "stop").length, 2);

await sidepanel.dispatch({ type: "get_messages", sessionId: "s1", requestId: "history", save: false }, port);
assert.deepEqual(calls.at(-1), ["messages", "s1", undefined]);
assert.equal(responses.pop().save, false);
await sidepanel.dispatch({ type: "get_messages", sessionId: "s1", requestId: "legacy" }, port);
assert.deepEqual(calls.at(-1), ["messages", "s1", undefined]);
assert.equal(responses.pop().save, true);
sidepanelWindowId = 42;
const canonicalImages = [{ attachmentId: "image-1", name: "synthetic.png", dataUrl: "data:image/png;base64,YQ==" }];
await sidepanel.dispatch({
  type: "prompt", sessionId: "s1", clientMessageId: "with-images", images: canonicalImages,
  composerDraft: { text: "image prompt", images: canonicalImages },
}, port);
assert.deepEqual(calls.at(-2)[1].draft.images, canonicalImages, "the explicit composer draft must preserve its images");

const runtimeMessages = createRuntimeMessageTransport(api, { clock: () => 1234 });
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, { type: "get_content_language" }), {
  keepChannelOpen: true,
  response: { ok: true, result: await api.system.contentLanguage() },
});
assert.deepEqual(await invokeRuntimeMessage(createRuntimeMessageTransport(createBackgroundApi({
  system: { contentLanguage: async () => { throw new Error("language unavailable"); } },
})), { type: "get_content_language" }), {
  keepChannelOpen: true,
  response: { ok: false, error: "language unavailable", code: "CONTENT_LANGUAGE_UNAVAILABLE" },
});

assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, { type: "offscreen_keepalive" }), {
  keepChannelOpen: false,
  response: { ok: true, at: 1234 },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "session_export_import_request",
  sessionId: "imported",
}, { tab: { id: 42 } }), {
  keepChannelOpen: true,
  response: { ok: true, sessionId: "imported", sourceTabId: 42 },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "stop_session",
  sessionId: "forbidden",
}), {
  keepChannelOpen: true,
  response: { ok: false, error: "stop denied", code: "STOP_DENIED" },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "session_export_import_request",
  fail: true,
}), {
  keepChannelOpen: true,
  response: { ok: false, error: "bad import", code: "SESSION_EXPORT_IMPORT_FAILED" },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "run_script_tool_call",
  toolName: "fail",
}), {
  keepChannelOpen: true,
  response: { ok: false, error: "nested call failed", code: "NESTED_FAILED" },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "stop_session",
  sessionId: "s1",
  source: "content",
}), {
  keepChannelOpen: true,
  response: {
    ok: true,
    result: {
      sessionId: "s1",
      stopped: true,
      runId: "run-1",
      runtime: { sessionId: "s1", status: "aborted", running: false, runId: "run-1" },
    },
  },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, { type: "run_script_inner_result" }), {
  keepChannelOpen: false,
  response: { ok: true, handled: true },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "run_script_inner_fetch",
  requestId: "inner-1",
  request: { url: "https://example.test" },
}, { url: "chrome-extension://test/offscreen.html" }), {
  keepChannelOpen: true,
  response: {
    ok: true,
    result: {
      requestId: "inner-1",
      senderUrl: "chrome-extension://test/offscreen.html",
      status: 200,
    },
  },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "run_script_inner_fetch_cancel",
  requestId: "inner-1",
  callId: "fetch-1",
}, { url: "chrome-extension://test/offscreen.html" }), {
  keepChannelOpen: true,
  response: {
    ok: true,
    result: {
      requestId: "inner-1",
      callId: "fetch-1",
      senderUrl: "chrome-extension://test/offscreen.html",
      cancelled: true,
    },
  },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "run_script_inner_fetch_cancel",
  requestId: "inner-1",
  callId: "fail",
}), {
  keepChannelOpen: true,
  response: {
    ok: false,
    error: "cancel failed",
    code: "CANCEL_FAILED",
    details: { callId: "fail" },
    diagnostic: { retryable: false },
  },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, {
  type: "run_script_tool_call",
  toolName: "get_current_datetime",
}, { tab: { id: 7 } }), {
  keepChannelOpen: true,
  response: { ok: true, result: { toolName: "get_current_datetime", senderTabId: 7 } },
});
assert.deepEqual(await invokeRuntimeMessage(runtimeMessages, { type: "unknown" }), {
  keepChannelOpen: false,
  response: undefined,
});

const listeners = new Set();
assert.throws(
  () => runtimeMessages.register(null),
  /chrome\.runtime\.onMessage is unavailable/,
);
const fakeRuntime = {
  onMessage: {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
  },
};
const unregister = runtimeMessages.register(fakeRuntime);
assert.equal(listeners.size, 1);
unregister();
assert.equal(listeners.size, 0);

for (const file of [
  "src/background/transports/mcp.ts",
  "src/background/transports/runtime-message.ts",
  "src/background/transports/sidepanel.ts",
]) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /chrome\.storage|sessionSupervisor|new Agent|setSessionRuntime\(/);
}

async function invokeRuntimeMessage(transport, message, sender = {}) {
  let resolveResponse;
  const responsePromise = new Promise(resolve => {
    resolveResponse = resolve;
  });
  const keepChannelOpen = transport.listener(message, sender, resolveResponse);
  const response = keepChannelOpen ? await responsePromise : await Promise.race([
    responsePromise,
    Promise.resolve(undefined),
  ]);
  return { keepChannelOpen, response };
}

console.log("background API transport parity tests passed");

// Wait validation failures are request-correlated replies, so the card can unlock and retry.
{
  const inputApi = createBackgroundApi({ system: { ready: async () => {} }, sessions: {
    continueWait: async () => ({ accepted: false, sessionId: "s1", waitId: "w1", code: "BROWSER_PERMISSION_REQUIRED", requiresUserAction: true }),
    cancelWait: async () => ({ accepted: true, sessionId: "s1", waitId: "w1", reason: "cancelled" }),
  } });
  const adapter = createSidepanelTransport(inputApi);
  const replies = [];
  const port = { postMessage: message => replies.push(message) };
  await adapter.dispatch({ type: "continue_task", sessionId: "s1", waitId: "w1", requestId: "reply-1" }, port);
  assert.deepEqual(replies[0], { type: "user_input_response", requestId: "reply-1", accepted: false, sessionId: "s1", waitId: "w1", code: "BROWSER_PERMISSION_REQUIRED", requiresUserAction: true });
  await adapter.dispatch({ type: "cancel_wait", sessionId: "s1", waitId: "w1", requestId: "reply-2" }, port);
  assert.equal(replies[1].accepted, true);
  assert.equal(replies[1].requestId, "reply-2");
}

// The in-process MCP adapter carries cancellation through the legacy Side Panel protocol.
{
  const controller = new AbortController(), captured = [];
  const capture = (...args) => { captured.push(args); return {}; };
  const adapter = createSidepanelTransport({ system: { ready() {} }, sessions: {
    stop: capture, remove: capture, create: capture, followUp: capture, continueWait: capture, cancelWait: capture, clearGoal: capture,
  }, config: { save: capture }, automations: { run: capture } });
  const port = { signal: controller.signal, postMessage() {} };
  for (const type of ["stop_session", "delete_session", "create_session", "follow_up", "continue_task", "cancel_wait", "clear_goal", "save_config", "run_automation"]) {
    await adapter.dispatch({ type, sessionId: "s1", waitId: "w1" }, port);
  }
  assert.equal(captured.length, 9);
  for (const args of captured) assert.equal(args.at(-1), controller.signal);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = createSidepanelTransport({ system: { ready: () => gate }, sessions: { remove: capture } })
    .dispatch({ type: "delete_session", sessionId: "s1" }, port);
  controller.abort(new Error("connection replaced")); release();
  await assert.rejects(pending, /connection replaced/); assert.equal(captured.length, 9);
}

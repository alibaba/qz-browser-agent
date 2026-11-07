import assert from "node:assert/strict";
import test from "node:test";
import { createMcpRuntime } from "../../src/background/mcp/mcp-runtime.js";
import {
  createExternalDriveCoordinator,
  DRIVE_RESULT_CHAR_LIMIT,
  driveGroupTitle,
  driveToolSignature,
  isDriveToolDiscoverable,
  isDriveToolForbidden,
  parseDriveRequest,
  prepareDriveToolCall,
  projectDriveResult,
  runDriveCalls,
  getDriveToolTraces,
} from "../../src/background/mcp/external-drive.js";
import { createRunScriptBridge } from "../../src/background/tools/run-script-bridge.js";
import { toolT as scriptToolT } from "../../src/capabilities/script/tool-messages.js";
import { t as toolT } from "../../src/background/tools/messages.js";
import { t } from "../../src/shared/i18n/backend.js";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { createSessionSupervisor } from "../../src/background/session/supervisor.js";
import { createSessionRepository } from "../../src/background/session/repository.js";
import { tabReferenceError } from "../../src/background/tools/tab-reference.js";
import { createMemoryStorage } from "../support/memory-storage.mjs";
import { normalizeRuntimeSessionId, requireExplicitSessionId } from "../../src/background/session/id.js";
import { markToolValue, toolError } from "../../src/shared/contracts/tool-error.js";
import { bindToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";

globalThis.chrome = { i18n: { getUILanguage: () => "zh-CN" }, runtime: { getURL: path => path }, storage: { local: createMemoryStorage() } };
const { getToolSchemas, createToolRuntime } = await import("../../src/background/tools/runtime.js");

test("drive titles and request sentences stay on the existing tool", () => {
  assert.equal(driveGroupTitle("qz-cli"), "轻舟 · CLI");
  assert.equal(driveGroupTitle("Claude Code"), "轻舟 · Claude Code");
  assert.equal(driveGroupTitle("  pi\nnext  "), "轻舟 · pi next");
  assert.equal(driveGroupTitle(""), "轻舟 · MCP");
  assert.equal(driveGroupTitle("x".repeat(80)).length, "轻舟 · ".length + 40);

  withLanguage("zh-CN", () => {
    const both = parseDriveRequest({ name: "open_tab", calls: [{ id: "a", name: "open_tab", args: {} }] });
    assert.equal(both.ok, false);
    assert.equal(both.error.message, "请只传 name 或 calls 中的一个。");

    const shape = parseDriveRequest({ calls: [{ name: "open_tab" }] });
    assert.equal(shape.ok, false);
    assert.equal(shape.error.message, "calls 的每一项都要包含 id 和 name。请补全后再试。");

    const tooMany = parseDriveRequest({ calls: Array.from({ length: 11 }, (_, index) => ({ id: String(index), name: "list_tabs", args: {} })) });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.message, "一批最多 10 个调用。请减少 calls 后再试。");

    const forbidden = parseDriveRequest({ name: "ask_llm", args: {} });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.error.code, "DRIVE_TOOL_FORBIDDEN");
    assert.equal(forbidden.error.message, "此工具不对直驱开放。请查询可用工具；页面操作显式传入 tabRef。");
    for (const name of [
      "delete_skill", "manage_bookmarks", "manage_skill_settings", "import_page_zip",
      "manage_goal", "example_echo", "plugin__manage_goal", "plugin__example_echo",
      "qingzhou_skill_author__create_skill", "qingzhou_skill_author__delete_skill", "mcp_browser", "qingzhou_x__mcp_remote",
    ]) {
      const blocked = parseDriveRequest({ name, args: {} });
      assert.equal(blocked.ok, false, name);
      assert.equal(blocked.error.code, "DRIVE_TOOL_FORBIDDEN", name);
    }

    assert.equal(parseDriveRequest({ name: "run_script", args: { target: "page", tabRef: "page", timeout: 1, code: "async () => 1" } }).mode, "single");
    assert.equal(parseDriveRequest({ name: "open_tab", args: { url: "https://example.com" } }).mode, "single");
    assert.equal(parseDriveRequest({ name: "document_fetch", args: {} }).mode, "single");
    assert.equal(parseDriveRequest({ name: "qingzhou_documents__document_fetch", args: {} }).mode, "single");
    assert.equal(parseDriveRequest({ name: "read_dom", args: {} }).mode, "single");
    assert.equal(parseDriveRequest({ name: "browse_history", args: {} }).mode, "single");
    assert.equal(parseDriveRequest({ name: "list_skills", args: {} }).mode, "single");
    const readBatch = parseDriveRequest({ calls: [{ id: "a", name: "read_dom", args: {} }] });
    assert.equal(readBatch.ok, true);
    assert.equal(readBatch.mode, "batch");
    assert.equal(t("drive.sessionOccupied"), "这个会话已有任务在用，不能直接操作。请用 qz session create（MCP：qingzhou_create_drive_session）创建新会话。");
    assert.equal(t("drive.toolForbidden", { name: "ask_llm" }), "不能通过直驱调用 ask_llm。");
    assert.equal(t("drive.sendMessageRejected"), "这个会话由外部客户端直接操作，这里只能查看。");
  });
  withLanguage("en", () => {
    assert.equal(driveGroupTitle("qz-cli"), "qz · CLI");
    assert.equal(driveGroupTitle("轻舟 · My client"), "qz · 轻舟 · My client");
    assert.equal(t("drive.sessionOccupied"), "This session already has a task, so it cannot be driven directly. Create a new session with qz session create (MCP: qingzhou_create_drive_session).");
    assert.equal(t("drive.toolForbidden", { name: "ask_llm" }), "Direct drive cannot call ask_llm.");
    assert.equal(t("drive.sendMessageRejected"), "An external client is driving this session. This view is read-only.");
  });
});

test("direct-drive discovery separates outer orchestration from explicit page evaluation", () => {
  assert.equal(isDriveToolDiscoverable("open_tab"), true);
  assert.equal(isDriveToolDiscoverable("list_skills"), true);
  assert.equal(isDriveToolDiscoverable("use_tab"), false);
  assert.equal(isDriveToolForbidden("use_tab"), true);
  assert.equal(isDriveToolDiscoverable("wait_for_element"), true);
  assert.equal(isDriveToolDiscoverable("wait_for_navigation"), true);
  assert.equal(isDriveToolDiscoverable("wait_until"), true);
  assert.equal(isDriveToolDiscoverable("get_working_tab"), false);
  assert.equal(isDriveToolDiscoverable("read_dom"), true);
  assert.equal(isDriveToolDiscoverable("browse_history"), true);
  assert.equal(isDriveToolDiscoverable("manage_goal"), false);
  assert.equal(isDriveToolDiscoverable("run_script"), false);
  assert.equal(isDriveToolForbidden("wait_until"), false);
  assert.equal(isDriveToolForbidden("get_working_tab"), true);
  assert.equal(isDriveToolForbidden("wait_for_user"), true);
  assert.equal(isDriveToolForbidden("ask_user"), true);
  for (const name of ["run_script", "collect_images", "read_image_asset", "data_store"]) {
    assert.equal(isDriveToolDiscoverable(name), false);
    assert.equal(isDriveToolDiscoverable(`skill__${name}`), false);
    assert.equal(parseDriveRequest({ name, args: {} }).ok, true, "discovery does not revoke execution");
  }
  const page = getToolSchemas().find(schema => schema.function.name === "evaluate").function;
  assert.deepEqual(page.parameters.required, ["tabRef", "code"]);
  const orchestration = prepareDriveToolCall("run_script", { timeout: 1, code: "return 1;" });
  assert.equal(orchestration.ok, true);
  assert.equal(Object.hasOwn(orchestration.args, "tabRef"), false);
  withLanguage("zh-CN", () => {
    const zh = prepareDriveToolCall("navigate", {});
    assert.equal(zh.ok, false);
    assert.equal(zh.error.message, "页面工具必须显式传 tabRef。");
    assert.doesNotMatch(zh.error.message, /省略 tabRef/);
  });
  withLanguage("en", () => {
    const en = prepareDriveToolCall("navigate", {});
    assert.equal(en.ok, false);
    assert.equal(en.error.message, "Page tools require an explicit tabRef.");
    assert.doesNotMatch(en.error.message, /omit tabRef/i);
  });
  assert.equal(prepareDriveToolCall("open_tab", { url: "https://example.com" }).ok, true);
  for (const name of ["navigate", "get_ax_tree", "read_dom", "close_tab", "screenshot", "act_on_element", "wait_for_element"]) {
    const rejected = prepareDriveToolCall(name, {});
    assert.equal(rejected.ok, false, name);
    assert.equal(rejected.error.code, "TAB_REF_REQUIRED", name);
    for (const reference of [null, "  "]) {
      const invalid = prepareDriveToolCall(name, { tabRef: reference });
      assert.equal(invalid.ok, true, name);
      assert.equal(invalid.args.tabRef, typeof reference === 'string' ? '' : reference, 'invalid explicit values reach the shared reference validator');
    }
    const prefixed = prepareDriveToolCall(`plugin__${name}`, { tabRef: " page " });
    assert.equal(prefixed.ok, true, name);
    assert.equal(prefixed.args.tabRef, "page", name);
  }
  const tabIdOnly = prepareDriveToolCall("screenshot", { tabId: 4 });
  assert.equal(tabIdOnly.ok, false);
  assert.equal(tabIdOnly.error.code, "TAB_REF_REQUIRED");
  for (const name of ["open_tab", "list_tabs", "list_skills", "load_skill", "wait_until", "wait", "document_fetch", "get_working_tab", "browse_history", "data_store"]) {
    assert.equal(prepareDriveToolCall(name, {}).ok, true, name);
  }
  assert.equal(prepareDriveToolCall("read_image", { url: "https://example.com/a.png" }).ok, true);
  assert.equal(prepareDriveToolCall("read_image", {}).error.code, "TAB_REF_REQUIRED");
  const other = prepareDriveToolCall("open_tab", { url: "https://example.com" });
  assert.equal(other.ok, true);

});

test("drive preserves user data with names that overlap private implementation fields", () => {
  const userValue = { tabId: 7, _tabId: 7, inner: "user value", target: "inner", scope: "custom",
    selector: "value", nested: { workingTabId: "data", uid: "data" } };
  const before = structuredClone(userValue);
  assert.deepEqual(projectDriveResult({ ok: true, result: userValue }).value,
    { ok: true, result: before });
  assert.deepEqual(userValue, before);
});

test("drive signatures follow native required fields and image input variants without catalog repair", () => {
  const schemas = getToolSchemas({ language: "en" });
  for (const { function: tool } of schemas) {
    if (isDriveToolForbidden(tool.name)) continue;
    const advertised = driveToolSignature(tool);
    const signatures = advertised.signature.split(" | ");
    const variants = tool.parameters.anyOf || [{}];
    assert.equal(signatures.length, variants.length, tool.name);
    for (const [index, variant] of variants.entries()) {
      const required = new Set([...(tool.parameters.required || []), ...(variant.required || [])]);
      for (const key of Object.keys(tool.parameters.properties)) {
        assert.match(signatures[index], new RegExp(`(?:\\{|, )${key}${required.has(key) ? '' : '\\?'}:`), `${tool.name}.${key}`);
      }
    }
    assert.equal(advertised.description, tool.description.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 240) || "");
  }
  for (const name of ["open_tab", "list_tabs", "wait_until"]) {
    const tool = schemas.find(schema => schema.function.name === name).function;
    assert.equal(prepareDriveToolCall(name, {}).ok, true);
    assert.doesNotMatch(driveToolSignature(tool).signature, /\btabRef:/, name);
  }
  for (const [name, urlField, targetField, targetType] of [
    ['read_image', 'url', 'target', 'string'], ['collect_images', 'urls', 'targets', 'array'],
  ]) {
    const tool = schemas.find(schema => schema.function.name === name).function;
    const variants = driveToolSignature(tool).signature.split(" | ");
    const url = variants.find(signature => new RegExp(`\\b${urlField}:`).test(signature));
    const page = variants.find(signature => /\btabRef:/.test(signature));
    assert.ok(url, name); assert.ok(page, name);
    assert.match(url, /\btabRef\?:/, 'the URL variant does not require a page');
    assert.match(page, new RegExp(`\\b${targetField}:${targetType}`), 'the page variant requires the selected element');
    assert.equal(prepareDriveToolCall(name, { [urlField]: urlField === 'url' ? 'https://example.com/p.png' : ['https://example.com/p.png'] }).ok, true);
  }
  assert.equal(driveToolSignature({ name: 'screenshot', parameters: {
    type: 'object', properties: { target: { type: 'string' } },
  } }).signature, 'screenshot({target?:string})', 'a catalog cannot invent missing declaration fields');
});

test("a calls batch runs no-page scripts without injecting an execution selector", async () => {
  const seen = [];
  const result = await runDriveCalls([
    { id: "script", name: "run_script", args: { timeout: 1, code: "async () => 1" } },
  ], {
    context: { sessionId: "s1", runId: "opaque-run" },
    signal: new AbortController().signal,
    execute: async (name, args) => { seen.push({ name, args }); return { ok: true, result: 1 }; },
    getModelPolicy: () => null,
    getBatchTabPolicy: () => null,
  });
  assert.equal(result.results[0].isError, false);
  assert.deepEqual(seen, [{ name: "run_script", args: { timeout: 1, code: "async () => 1" } }]);
  assert.deepEqual(result.results[0].result, { ok: true, result: 1 });
});

test("projection preserves business fields while separating screenshot bytes", () => {
  const projected = projectDriveResult({
    snapshot: "tree",
    nodes: [{ id: 1 }],
    _display: { big: true },
    _image: "data:image/png;base64,aGk=",
  }, { projectResult: (result) => result });
  assert.equal(projected.value.snapshot, "tree");
  assert.deepEqual(projected.value.nodes, [{ id: 1 }]);
  assert.equal(Object.hasOwn(projected.value, "_image"), false);
  assert.deepEqual(projected.value._display, { big: true });
  assert.deepEqual(projected.images, [{ mimeType: "image/png", data: "aGk=" }]);
});

test("script results preserve large values and authored protocol-like keys", () => {
  const text = "x".repeat(DRIVE_RESULT_CHAR_LIMIT + 1);
  for (const result of [text, { code: "AUTHORED", message: text, error: "value", ok: false,
    _image: "data:image/png;base64,aGk=", _display: { result: "authored" } }, [text]]) {
    const projected = projectDriveResult(markToolValue(result), { preserveResult: true });
    assert.equal(projected.value, result);
    assert.deepEqual(projected.images, []);
  }
});

test("drive script projection carries explicit images from a primitive call collector", async () => {
  const holders = [], settled = [];
  const result = await runDriveCalls([0, 1].map(index => ({ id: String(index), name: 'run_script', args: { index } })), {
    signal: new AbortController().signal,
    context: { resultPresentation: { _display: { parent: true } } },
    getModelPolicy: () => ({ preserveResult: true, scriptResult: "value" }),
    getBatchTabPolicy: () => null,
    execute: async (_name, { index }, _signal, context) => {
      assert.deepEqual(context.resultPresentation, {});
      holders.push(context.resultPresentation);
      Object.assign(context.resultPresentation, { _display: { script: { valueOnly: true, trace: [index] } },
        ...(index === 0 ? { _images: [{ mimeType: 'image/png', data: 'aGk=' }] } : {}) });
      return index;
    },
    onSettled: call => settled.push(call),
  });
  assert.equal(new Set(holders).size, 2);
  assert.deepEqual(result.results.map(call => call.result), [0, 1].map(result => ({ok:true,result,trace:[]})));
  assert.deepEqual(result.results[0].images, [{ mimeType: 'image/png', data: 'aGk=' }]);
  assert.equal(Object.hasOwn(result.results[1], 'images'), false);
  assert.deepEqual(settled.map(call => call.resultPresentation._display.script.trace), [[0], [1]]);
  assert.ok(result.results.every(call => !Object.hasOwn(call, 'resultPresentation')), 'host collectors never become wire fields');
});

test('batch traces come from each trusted collector, including failures, without interpreting business keys', async () => {
  const business = markToolValue({ trace: ['authored'], traces: ['authored plural'],
    _display: { script: { trace: ['forged'] } }, details: { trace: ['also forged'] } });
  const full = Array.from({ length: 8 }, (_, index) => ({ level: index % 2 ? 'warn' : 'trace', message: `line-${index}` }));
  const failure = toolError('SCRIPT_EVALUATION_FAILED', 'Failed after logging.', { details: { trace: full.slice(-5) } });
  const seen = [];
  const result = await runDriveCalls(['primitive', 'business', 'failure', 'thrown', 'timeout'].map(id => ({ id, name: 'run_script', args: { id } })), {
    signal: new AbortController().signal, getModelPolicy: () => ({ preserveResult: true, scriptResult: "value" }),
    execute: async (_name, { id }, _signal, context) => {
      if (id === 'business') return business;
      if (id === 'timeout') return toolError('TOOL_TIMEOUT', 'The script timed out.', { details: { trace: full.slice(-5) } });
      context.resultPresentation._display = { script: { valueOnly: id !== 'failure', trace: full } };
      if (id === 'thrown') throw Object.assign(new Error('Host failed.'), { code: 'HOST_FAILURE' });
      return id === 'failure' ? failure : 7;
    },
    onSettled: event => seen.push(event),
  });
  const [primitive, authored, failed, thrown, timeout] = result.results;
  assert.equal(primitive.result.result, 7);
  assert.deepEqual(primitive.result.trace, full.map(row => row.message));
  assert.equal(authored.result.result, business);
  assert.deepEqual(authored.result.trace, []);
  assert.equal(Object.hasOwn(authored, 'traces'), false);
  assert.deepEqual(getDriveToolTraces(business), []);
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.result.trace, full.map(row => row.message));
  assert.equal(failed.result.result.details?.trace, undefined, 'diagnostics sit beside the ToolError');
  assert.deepEqual(failure.details.trace, full.slice(-5), 'formatting does not mutate the source error');
  assert.equal(thrown.isError, true);
  assert.deepEqual(thrown.result.trace, full.map(row => row.message));
  assert.equal(seen[3].resultPresentation._display.script.valueOnly, undefined, 'a thrown failure cannot acquire a successful value envelope');
  assert.deepEqual(timeout.result.trace, full.slice(-5).map(row => row.message), 'hard timeout only has its existing last five entries');
  const error = bindToolResultPresentation(toolError('TEST_FAILURE', 'failed'), { _display: { script: { trace: ['trusted'] } } });
  assert.deepEqual(getDriveToolTraces(error, {}, true), ['trusted']);
});

test("drive caps large tool observations without rewriting public business data", () => {
  const tabs = { tabs: [{ tabRef: "form", title: "Form", url: "https://example.test", active: true }], count: 1, foreign: 0 };
  assert.deepEqual(projectDriveResult(tabs).value, tabs);
  const body = { text: "x".repeat(DRIVE_RESULT_CHAR_LIMIT) };
  for (const result of [body, { ok: true, result: body }, { result: body, ok: true },
    { trace: ["started"], ok: true, result: body }, [body], body.text]) {
    const serialized = JSON.stringify(result);
    const capped = projectDriveResult(result).value;
    assert.equal(capped.truncated, true);
    assert.equal(capped.limitChars, DRIVE_RESULT_CHAR_LIMIT);
    assert.equal(capped.totalChars, serialized.length);
    assert.equal(capped.preview.length, DRIVE_RESULT_CHAR_LIMIT);
    assert.equal(capped.preview, serialized.slice(0, DRIVE_RESULT_CHAR_LIMIT), 'previews retain the original envelope and field order');
    assert.equal(JSON.stringify(result), serialized, 'the source result is unchanged');
  }
  const exactLimit = 'x'.repeat(DRIVE_RESULT_CHAR_LIMIT - 2);
  assert.equal(projectDriveResult(exactLimit).value, exactLimit);
  assert.equal(projectDriveResult(exactLimit + 'x').value.truncated, true);
});





test("direct drive resolves an alias and a returned tabRef", async () => {
  const seen = [];
  const run = (calls, aliases) => runDriveCalls(calls, {
    signal: new AbortController().signal,
    aliases,
    execute: async (_name, args) => {
      seen.push(args.tabId);
      return { snapshot: "ok" };
    },
    getBatchTabPolicy: () => ({ kind: "target", implicit: false, observation: true }),
  });
  const byAlias = await run([{ id: "alias", name: "get_ax_tree", args: { tabRef: "page" } }], { page: 11 });
  const byId = await run([
    { id: "number", name: "get_ax_tree", args: { tabRef: 11 } },
    { id: "digits", name: "get_ax_tree", args: { tabRef: "11" } },
  ], {});
  assert.equal(byAlias.results[0].isError, false);
  assert.equal(byId.results[0].isError, false);
  assert.equal(byId.results[1].isError, false);
  assert.deepEqual(seen, [11, 11, 11]);
  let missingPromise;
  withLanguage("zh-CN", () => {
    missingPromise = run([{ id: "gone", name: "get_ax_tree", args: { tabRef: "page" } }], {});
  });
  const missing = await missingPromise;
  assert.equal(missing.results[0].isError, true);
  assert.equal(missing.results[0].result.code, "BATCH_TAB_REFERENCE_ERROR");
  assert.equal(missing.results[0].result.message, "本会话还没有页面别名。tabRef 可以是 open_tab 时用 tabAlias 设的别名，也可以是 open_tab 或 list_tabs 返回的 tabRef。别名和 tabRef 都属于本会话。同一任务后续调用带同一个 --session（MCP 带同一个 sessionId）。");
  assert.doesNotMatch(missing.results[0].result.message, /省略 tabRef/);
  let missingEnPromise;
  withLanguage("en", () => {
    missingEnPromise = run([{ id: "gone", name: "get_ax_tree", args: { tabRef: "page" } }], {});
  });
  const missingEn = await missingEnPromise;
  assert.equal(missingEn.results[0].result.message, "This session has no page alias yet. tabRef can be the alias set with tabAlias on open_tab, or the tabRef returned by open_tab or list_tabs. Aliases and tab refs belong to this session. Later calls in the same task use the same --session (MCP: the same sessionId).");
  assert.doesNotMatch(missingEn.results[0].result.message, /omit tabRef/i);
});

test("single drive no_alias matches calls and the script bridge", async () => {
  const throwNoAlias = language => { throw tabReferenceError("no_alias", "page", language); };
  const callBatch = (language) => {
    let pending;
    withLanguage(language, () => {
      pending = runDriveCalls([{ id: "gone", name: "get_ax_tree", args: { tabRef: "page" } }], {
        signal: new AbortController().signal,
        aliases: {},
        execute: async () => { throw new Error("planner should reject before execute"); },
        getBatchTabPolicy: () => ({ kind: "target", implicit: false, observation: true }),
      });
    });
    return pending;
  };
  const zhCalls = await callBatch("zh-CN");
  const enCalls = await callBatch("en");
  const zhSentence = withLanguage("zh-CN", () => t("drive.noAlias"));
  const enSentence = withLanguage("en", () => t("drive.noAlias"));
  assert.equal(zhCalls.results[0].result.message, zhSentence);
  assert.equal(enCalls.results[0].result.message, enSentence);

  const noted = [];
  const metadata = {};
  const driveRuns = new Map();
  const runtime = createMcpRuntime({
    sessions: {
      normalizeId: (value) => String(value || "").trim(),
      requireId: (value) => String(value || "").trim(),
      supervisor: {
        isRunCurrent: (sessionId, runId) => Boolean(runId) && driveRuns.get(sessionId) === runId,
        mintDriveRunId(sessionId) {
          if (!driveRuns.get(sessionId)) driveRuns.set(sessionId, `drive-${crypto.randomUUID()}`);
          return driveRuns.get(sessionId);
        },
        clearDriveRunId(sessionId) { driveRuns.set(sessionId, ""); },
        takeDriveRunForRelease(sessionId) {
          const current = driveRuns.get(sessionId) || "";
          driveRuns.set(sessionId, "");
          return current;
        },
        getUserWait: () => null,
        resolveUserWait: () => false,
        rejectUserWait: () => false,
      },
      submitMessage: async () => ({ promise: Promise.resolve(), disposition: "started" }),
      waitForRunObserved: async () => true,
      getRuntimeOutput: async (_id, project = (value) => value) => project({ status: "idle" }),
      getLiveAgentEntry: async () => null,
      setRuntime() {},
      getStoredRuntime: () => null,
      getLastMessages: async () => ({ messages: [] }),
      getAgent: async () => null,
      getTranscript: async () => [],
      listMetadata: async () => ({ ...metadata }),
      createMetadata: async (input) => { metadata[input.id] = { ...input }; return metadata[input.id]; },
      getConversation: async () => [],
      compactTranscriptEvent: (event) => event,
      getRuntime: () => ({ status: "idle", workingTabId: null }),
      recordToolEvent(event) { noted.push(event); },
    },
    userInputPermissions: {
      hasBrowserPermission: async () => false,
      locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } },
    },
    tools: {
      ready: async () => {},
      canManageSessions: async () => true,
      buildRunProfile: async () => ({}),
      loadedSkillNames: () => [],
      recordLoadedSkillNames: () => {},
      runtime: {
        getSchemas: () => [],
        async execute(name, _args, _signal, context) {
          if (name === "get_ax_tree") throwNoAlias(context.language);
          if (name === "list_tabs") throw new Error("plain failure");
          return { ok: true };
        },
        getModelPolicy: () => null,
        getBatchTabPolicy: name => name === "get_ax_tree" ? { kind: "target", implicit: false, observation: true } : null,
        getTabAliases: () => ({}),
      },
    },
    skills: { list: async () => [], load: async () => null, getDisplayName: (skill) => skill?.name || "", normalizeResourcePath: (value) => String(value || "") },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    async dispatchSidepanel() {},
  });
  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-alias" });
  const rejectMessage = async (language, params) => {
    let pending;
    withLanguage(language, () => {
      pending = runtime.executeTool(params);
    });
    try {
      await pending;
    } catch (error) {
      return error.message;
    }
    throw new Error("expected executeTool to reject");
  };
  const zhSingle = await rejectMessage("zh-CN", { sessionId: "drive-alias", name: "get_ax_tree", args: { tabRef: "page" }, clientName: "qz-cli" });
  const enSingle = await rejectMessage("en", { sessionId: "drive-alias", name: "get_ax_tree", args: { tabRef: "page" }, clientName: "qz-cli" });
  assert.equal(zhSingle, zhSentence);
  assert.equal(enSingle, enSentence);
  assert.equal(zhSingle, zhCalls.results[0].result.message);
  assert.equal(enSingle, enCalls.results[0].result.message);
  assert.equal(noted[0].result.message, zhSentence);
  assert.equal(noted.at(-1).result.message, enSentence);
  const plain = await rejectMessage("zh-CN", { sessionId: "drive-alias", name: "list_tabs", args: {} });
  assert.equal(plain, "plain failure");
  assert.doesNotMatch(plain, /--session/);

  const scriptCall = async (language, runId, externalDrive = false) => {
    const bridge = createRunScriptBridge({
      supervisor: {
        isRunCurrent: (_sessionId, id) => id === runId,
        hasAgent: () => false,
        getAbortSignal: () => new AbortController().signal,
      },
      getRuntime: () => ({ status: "running" }),
      isTerminalRuntimeForRun: () => false,
      canManageSessions: async () => true,
      buildRunProfile: async () => ({}),
      getRunToolContext: async () => ({ language, externalDrive }),
      toolRuntime: {
        resolveDefinition: () => ({ behavior: {} }),
        getSchemas: () => [],
        async execute(name, _args, _signal, context) {
          if (name === "get_ax_tree") throwNoAlias(context.language);
          return { ok: true };
        },
      },
      collectArtifacts: () => [],
    });
    return bridge.handleToolCall({
      toolName: "get_ax_tree",
      args: { tabRef: "page" },
      sessionId: "s1",
      runId,
    });
  };
  const zhScript = await scriptCall("zh-CN", "opaque-zh-run", true);
  const enScript = await scriptCall("en", "opaque-en-run", true);
  const builtIn = await scriptCall("en", "drive-native-looking-run", false);
  assert.equal(zhScript.message, zhSentence);
  assert.equal(enScript.message, enSentence);
  assert.equal(zhScript.message, zhSingle);
  assert.equal(enScript.message, enSingle);
  assert.equal(builtIn.message, enSentence);
  assert.match(builtIn.message, /no page alias yet/);

  const builtInZh = withLanguage("zh-CN", () => toolT("batchTabReferenceNoAlias", { tabRef: "page" }));
  const builtInEn = withLanguage("en", () => toolT("batchTabReferenceNoAlias", { tabRef: "page" }));
  assert.doesNotMatch(builtInZh, /--session/);
  assert.doesNotMatch(builtInEn, /--session/);
  assert.notEqual(builtInZh, zhSentence);
  assert.notEqual(builtInEn, enSentence);
});

test("one calls batch reuses tab aliases and the existing scheduler", async () => {
  const seen = [];
  const commits = [];
  const settled = [];
  const batch = await runDriveCalls([
    { id: "open", name: "open_tab", args: { url: "https://example.com", tabAlias: "page" } },
    { id: "read", name: "get_ax_tree", args: { tabRef: "page" } },
  ], {
    signal: new AbortController().signal,
    execute: async (name, args) => {
      seen.push({ name, args });
      if (name === "open_tab") return { tabRef: 11 };
      return { snapshot: "ok", nodes: [1], _image: "data:image/png;base64,YQ==" };
    },
    getBatchTabPolicy: (name) => name === "open_tab"
      ? { kind: "create", parallel: true }
      : { kind: "target", implicit: false, observation: true },
    commitToolResult: async (result) => { commits.push(result); },
    discardToolResult: async () => {},
    onSettled: call => settled.push({ id: call.id, name: call.name, images: call.images.length }),
  });
  assert.equal(seen[0].name, "open_tab");
  assert.equal(seen[1].args.tabId, 11);
  assert.equal(seen[1].args.tabRef, "page");
  assert.equal(batch.results[0].result.tabRef, 11);
  assert.equal(batch.results[1].result.snapshot, "ok");
  assert.deepEqual(batch.results[1].result.nodes, [1]);
  assert.equal(Object.hasOwn(batch, "images"), false);
  assert.deepEqual(batch.results[1].images, [{ mimeType: "image/png", data: "YQ==" }]);
  assert.equal(commits.length, 2);
  assert.deepEqual(settled, [
    { id: "open", name: "open_tab", images: 0 },
    { id: "read", name: "get_ax_tree", images: 1 },
  ]);
});

test("a batch refreshes the working tab before the next call and keeps the drive run", async () => {
  let workingTabId = 1;
  const seen = [];
  await runDriveCalls([
    { id: "open", name: "open_tab", args: { url: "https://example.com", tabAlias: "page" } },
    { id: "read", name: "get_ax_tree", args: { tabRef: "page" } },
  ], {
    signal: new AbortController().signal,
    context: { sessionId: "drive-1", runId: "drive-fixed", workingTabId: 1 },
    refreshContext: (context) => ({ ...context, workingTabId, runId: context.runId }),
    execute: async (name, _args, _signal, context) => {
      seen.push({ name, workingTabId: context.workingTabId, runId: context.runId });
      if (name === "open_tab") {
        workingTabId = 9;
        return { tabRef: 9 };
      }
      return { snapshot: "tree" };
    },
    getBatchTabPolicy: (name) => name === "open_tab"
      ? { kind: "create", parallel: true }
      : { kind: "target", implicit: false, observation: true },
    commitToolResult: async () => {},
    discardToolResult: async () => {},
  });
  assert.deepEqual(seen.map(item => item.runId), ["drive-fixed", "drive-fixed"]);
  assert.deepEqual(seen.map(item => item.workingTabId), [1, 9]);
});

test("a second batch on the same session is rejected before another session is", () => {
  const drive = createExternalDriveCoordinator();
  withLanguage("zh-CN", () => {
    const lease = drive.begin("s");
    assert.throws(() => drive.begin("s"), (error) => error.code === "DRIVE_SESSION_BUSY"
      && error.message === "本会话已有操作正在执行，请等它结束。并行页面操作请放在同一个脚本的 Promise.all 中。");
    assert.doesNotThrow(() => drive.begin("other").release());
    lease.release();
    assert.doesNotThrow(() => drive.begin("s").release());
  });
});

test("stop is terminal and a late release cannot resurrect the session", () => {
  const drive = createExternalDriveCoordinator();
  const first = drive.begin("s");
  assert.equal(drive.noteStopped("s", { source: "drive_idle" }), false);
  assert.equal(drive.isBusy("s"), true);
  drive.noteStopped("s", { source: "user" });
  assert.equal(first.signal.aborted, true);
  first.release();
  assert.equal(drive.isBusy("s"), false);
  assert.throws(() => drive.begin("s"), { code: "DRIVE_SESSION_ENDED" });
  const restarted = createExternalDriveCoordinator({ getRuntime: () => ({ status: "aborted" }) });
  assert.throws(() => restarted.begin("s"), { code: "DRIVE_SESSION_ENDED" });
  assert.doesNotThrow(() => drive.begin("other").release());
});

test("a drive run id is current only until stop clears it", () => {
  const supervisor = createSessionSupervisor({
    createAgent: () => { throw new Error("no agent"); },
    logger: { warn() {}, error() {} },
  });
  const first = supervisor.mintDriveRunId("drive-session");
  assert.match(first, /^drive-/);
  assert.equal(supervisor.isRunCurrent("drive-session", first), true);
  assert.equal(supervisor.isRunCurrent("drive-session", ""), false);
  assert.equal(supervisor.isRunCurrent("drive-session", "run-permanent"), false);
  const taken = supervisor.takeDriveRunForRelease("drive-session");
  assert.equal(taken, first);
  assert.equal(supervisor.isRunCurrent("drive-session", first), true);
  const second = supervisor.mintDriveRunId("drive-session");
  assert.match(second, /^drive-/);
  assert.notEqual(second, first);
  assert.equal(supervisor.isRunCurrent("drive-session", second), true);
  supervisor.finishDriveRunRelease("drive-session", first);
  assert.equal(supervisor.isRunCurrent("drive-session", first), false);
  assert.equal(supervisor.isRunCurrent("drive-session", second), true);
  supervisor.clearDriveRunId("drive-session");
  assert.equal(supervisor.isRunCurrent("drive-session", second), false);
});

test("only explicit creation admits a drive session; busy runs remain isolated", async () => {
  const metadata = { s1: { id: "s1", title: "Session" } };
  const stored = {};
  const executed = [];
  const created = [];
  let releaseOpen;
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  let opened = 0;
  const driveRuns = new Map();
  const stops = [];
  stored.s1 = { runId: "agent-run", status: "running" };
  const sessions = {
    normalizeId: (value) => String(value || "").trim(),
    requireId(value, operation) {
      const id = String(value || "").trim();
      if (!id) throw new Error(`${operation} requires sessionId`);
      return id;
    },
    supervisor: {
      isRunCurrent: (sessionId, runId) => Boolean(runId) && driveRuns.get(sessionId) === runId,
      mintDriveRunId(sessionId) {
        if (!driveRuns.get(sessionId)) driveRuns.set(sessionId, `drive-${crypto.randomUUID()}`);
        return driveRuns.get(sessionId);
      },
      clearDriveRunId(sessionId) { driveRuns.set(sessionId, ""); },
      takeDriveRunForRelease(sessionId) {
        const current = driveRuns.get(sessionId) || "";
        driveRuns.set(sessionId, "");
        return current;
      },
      getUserWait: () => null,
      resolveUserWait: () => false,
      rejectUserWait: () => false,
    },
    submitMessage: async () => ({ promise: Promise.resolve(), disposition: "started" }),
    waitForRunObserved: async () => true,
    getRuntimeOutput: async (_id, project = (value) => value) => project({ status: "idle" }),
    getLiveAgentEntry: async () => null,
    setRuntime(id, patch) { stored[id] = { ...(stored[id] || {}), ...patch }; },
    getStoredRuntime: (id) => stored[id] || null,
    getLastMessages: async () => ({ messages: [] }),
    getAgent: async () => null,
    getTranscript: async () => [],
    listMetadata: async () => ({ ...metadata }),
    createMetadata: async (input) => {
      created.push(input);
      metadata[input.id] = { ...input };
      return metadata[input.id];
    },
    stop: async (id, meta) => { stops.push({ id, meta }); return { stopped: true }; },
    getConversation: async () => [],
    compactTranscriptEvent: (event) => event,
    getRuntime: () => ({ status: "idle", workingTabId: null }),
  };
  const runtime = createMcpRuntime({
    sessions,
    userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } } },
    tools: {
      ready: async () => {},
      canManageSessions: async () => true,
      buildRunProfile: async ({ sessionId }) => ({ sessionId }),
      loadedSkillNames: () => [],
      recordLoadedSkillNames: () => {},
      runtime: {
        getSchemas: () => [],
        async execute(name, args, _signal, context) {
          executed.push({ name, args, runId: context?.runId || "" });
          if (name === "open_tab") {
            opened += 1;
            await openGate;
            return { tabRef: 4, url: args.url, snapshot: "page", nodes: [9], _display: { raw: true }, _image: "data:image/png;base64,YQ==" };
          }
          return { ok: true, nodes: [1] };
        },
        getModelPolicy: () => null,
        getBatchTabPolicy: () => null,
        getTabAliases: () => ({}),
      },
    },
    skills: { list: async () => [], load: async () => null, getDisplayName: (skill) => skill?.name || "", normalizeResourcePath: (value) => String(value || "") },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    async dispatchSidepanel() {},
  });

  const before = executed.length;
  await assert.rejects(
    runtime.createDriveSession({ title: "Inspect example page", sessionId: "s1" }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && /qz session create/.test(error.message),
  );
  await assert.rejects(
    runtime.executeTool({ sessionId: "s1", name: "open_tab", args: { url: "https://example.com" }, clientName: "pi" }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && /qz session create/.test(error.message),
  );
  assert.equal(executed.length, before);
  await assert.rejects(
    runtime.executeTool({ sessionId: "s1", name: "read_dom", args: { selector: "main" } }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && executed.length === before,
  );
  await assert.rejects(
    runtime.executeTool({ sessionId: "s1", calls: [{ id: "dom", name: "read_dom", args: {} }] }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && executed.length === before,
  );
  assert.deepEqual(stored.s1, { runId: "agent-run", status: "running" });
  assert.equal(metadata.s1.title, "Session");
  assert.equal(metadata.s1.source, undefined);
  assert.equal(stops.length, 0);
  assert.equal(created.length, 0);

  await assert.rejects(runtime.executeTool({ name: "read_dom", args: { tabRef: "page" } }),
    error => error.code === "DRIVE_SESSION_REQUIRED");
  await assert.rejects(runtime.executeTool({ sessionId: "unknown", name: "list_tabs", args: {} }),
    error => error.code === "DRIVE_SESSION_NOT_FOUND");
  assert.equal(created.length, 0);
  assert.equal(executed.length, before);
  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-1", clientName: "pi" });
  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-2", clientName: "Claude Code" });

  const first = runtime.executeTool({ sessionId: "drive-1", name: "open_tab", args: { url: "https://example.com" }, clientName: "pi" });
  await new Promise((resolve) => {
    const check = () => (opened ? resolve() : setTimeout(check, 0));
    check();
  });
  await assert.rejects(runtime.executeTool({ sessionId: "drive-1", name: "list_tabs", args: {} }), (error) => error.code === "DRIVE_SESSION_BUSY");
  await assert.rejects(runtime.executeTool({ sessionId: "drive-1", name: "read_dom", args: {} }), (error) => error.code === "DRIVE_SESSION_BUSY");
  const other = await runtime.executeTool({ sessionId: "drive-2", name: "list_tabs", args: {}, clientName: "Claude Code" });
  assert.equal(other.toolName, "list_tabs");
  releaseOpen();
  const openedResult = await first;
  assert.equal(openedResult.result.tabRef, 4);
  assert.deepEqual(openedResult.result.nodes, [9]);
  assert.deepEqual(openedResult.result._display, { raw: true });
  assert.deepEqual(openedResult.images, [{ mimeType: "image/png", data: "YQ==" }]);
  assert.equal(metadata["drive-1"].source, "external-drive");
  assert.equal(metadata["drive-1"].title, "Inspect example page");
  assert.equal(metadata["drive-1"].driveClientName, "pi");
  assert.equal(metadata["drive-1"].driveGroupTitle, undefined);
  assert.equal(metadata["drive-2"].title, "Inspect example page");
  assert.match(openedResult.runId, /^drive-/);
  assert.equal(created.length, 2);

  const readBack = await runtime.executeTool({ sessionId: "drive-1", name: "read_dom", args: { tabRef: "page" } });
  assert.deepEqual(readBack.result.nodes, [1]);
  assert.match(readBack.runId, /^drive-/);

  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-docs" });
  const fetched = await runtime.executeTool({ sessionId: "drive-docs", name: "document_fetch", args: { url: "https://example.com/a.pdf" } });
  assert.equal(metadata["drive-docs"].source, "external-drive");
  assert.match(fetched.runId, /^drive-/);
  assert.equal(executed.at(-1).name, "document_fetch");

  await assert.rejects(
    runtime.executeTool({ sessionId: "s1", calls: [{ id: "a", name: "document_fetch", args: {} }] }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED",
  );
  assert.equal(metadata.s1.source, undefined);
  assert.deepEqual(stored.s1, { runId: "agent-run", status: "running" });
  assert.equal(stops.length, 0);

  const sent = await runtime.sendMessage({ sessionId: "s1", text: "hello" });
  assert.equal(sent.accepted, true);

  runtime.drive.markHandoff("drive-1", 4);
  runtime.drive.markHandoff("drive-1", 8);
  assert.deepEqual(stored["drive-1"].driveHandoffTabIds, [4, 8]);
});

test("idle stop reaches an external drive session and leaves an occupied session alone", async () => {
  const metadata = { s1: { id: "s1", title: "Session", source: "" } };
  const stops = [];
  const driveRuns = new Map();
  const runtime = createMcpRuntime({
    driveIdleMs: 25,
    sessions: {
      normalizeId: (value) => String(value || "").trim(),
      requireId: (value) => String(value || "").trim(),
      supervisor: {
        isRunCurrent: (sessionId, runId) => Boolean(runId) && driveRuns.get(sessionId) === runId,
        mintDriveRunId(sessionId) {
          if (!driveRuns.get(sessionId)) driveRuns.set(sessionId, `drive-${crypto.randomUUID()}`);
          return driveRuns.get(sessionId);
        },
        clearDriveRunId(sessionId) { driveRuns.set(sessionId, ""); },
        takeDriveRunForRelease(sessionId) {
          const current = driveRuns.get(sessionId) || "";
          driveRuns.set(sessionId, "");
          return current;
        },
        getUserWait: () => null,
        resolveUserWait: () => false,
        rejectUserWait: () => false,
      },
      submitMessage: async () => ({ promise: Promise.resolve(), disposition: "started" }),
      waitForRunObserved: async () => true,
      getRuntimeOutput: async (_id, project = (value) => value) => project({ status: "idle" }),
      getLiveAgentEntry: async () => null,
      setRuntime() {},
      getStoredRuntime: () => null,
      getLastMessages: async () => ({ messages: [] }),
      getAgent: async () => null,
      getTranscript: async () => [],
      listMetadata: async () => ({ ...metadata }),
      createMetadata: async (input) => { metadata[input.id] = { ...input }; return metadata[input.id]; },
      stop: async (id, meta) => { stops.push({ id, meta }); return { stopped: true }; },
      getConversation: async () => [],
      compactTranscriptEvent: (event) => event,
      getRuntime: () => ({ status: "idle" }),
    },
    userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } } },
    tools: {
      ready: async () => {},
      canManageSessions: async () => true,
      buildRunProfile: async () => ({}),
      loadedSkillNames: () => [],
      recordLoadedSkillNames: () => {},
      runtime: {
        getSchemas: () => [],
        execute: async () => ({ ok: true }),
        getModelPolicy: () => null,
        getBatchTabPolicy: () => null,
        getTabAliases: () => ({}),
      },
    },
    skills: { list: async () => [], load: async () => null, getDisplayName: () => "", normalizeResourcePath: (value) => String(value || "") },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    async dispatchSidepanel() {},
  });
  await assert.rejects(runtime.executeTool({ sessionId: "s1", name: "list_tabs", args: {} }), (error) => error.code === "DRIVE_SESSION_OCCUPIED");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stops.length, 0);
  assert.equal(metadata.s1.source, "");
  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-idle" });
  await runtime.executeTool({ sessionId: "drive-idle", name: "list_tabs", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(stops.length, 1);
  assert.equal(stops[0].id, "drive-idle");
  assert.equal(stops[0].meta.source, "drive_idle");
  assert.equal(stops[0].meta.keepTabs, false);
  assert.equal(metadata["drive-idle"].source, "external-drive");
  assert.equal(stops[0].meta.driveRunCaptured, true);
});

test("drive refresh keeps an empty runtime tab instead of the previous one", async () => {
  const stored = {
    "drive-clear": {
      workingTabId: 4,
      workingUrl: "https://old.example",
      workingTab: { id: 4, url: "https://old.example" },
      visitedTaskSites: [{ url: "https://old.example" }],
    },
  };
  const seen = [];
  const metadata = {};
  const driveRuns = new Map();
  const runtime = createMcpRuntime({
    sessions: {
      normalizeId: (value) => String(value || "").trim(),
      requireId: (value) => String(value || "").trim(),
      supervisor: {
        isRunCurrent: (sessionId, runId) => Boolean(runId) && driveRuns.get(sessionId) === runId,
        mintDriveRunId(sessionId) {
          if (!driveRuns.get(sessionId)) driveRuns.set(sessionId, `drive-${crypto.randomUUID()}`);
          return driveRuns.get(sessionId);
        },
        clearDriveRunId(sessionId) { driveRuns.set(sessionId, ""); },
        takeDriveRunForRelease(sessionId) {
          const current = driveRuns.get(sessionId) || "";
          driveRuns.set(sessionId, "");
          return current;
        },
        getUserWait: () => null,
        resolveUserWait: () => false,
        rejectUserWait: () => false,
      },
      submitMessage: async () => ({ promise: Promise.resolve(), disposition: "started" }),
      waitForRunObserved: async () => true,
      getRuntimeOutput: async (_id, project = (value) => value) => project({}),
      getLiveAgentEntry: async () => null,
      setRuntime() {},
      getStoredRuntime: (id) => stored[id] || null,
      getLastMessages: async () => ({ messages: [] }),
      getAgent: async () => null,
      getTranscript: async () => [],
      listMetadata: async () => ({ ...metadata }),
      createMetadata: async (input) => { metadata[input.id] = { ...input }; return metadata[input.id]; },
      stop: async () => ({ stopped: true }),
      getConversation: async () => [],
      compactTranscriptEvent: (event) => event,
      getRuntime: () => stored["drive-clear"],
    },
    userInputPermissions: { hasBrowserPermission: async () => false, locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } } },
    tools: {
      ready: async () => {},
      canManageSessions: async () => true,
      buildRunProfile: async ({ externalDrive }) => ({ externalDrive }),
      loadedSkillNames: () => [],
      recordLoadedSkillNames: () => {},
      runtime: {
        getSchemas: () => [],
        async execute(name, _args, _signal, context) {
          seen.push({
            name,
            workingTabId: context.workingTabId,
            pageUrl: context.dynamicContext.pageUrl,
            externalDrive: context.runProfile.externalDrive,
          });
          if (name === "open_tab") {
            stored["drive-clear"] = { workingTabId: null, workingUrl: "", workingTab: null, visitedTaskSites: [] };
            return { tabRef: 9 };
          }
          return { ok: true };
        },
        getModelPolicy: () => null,
        getBatchTabPolicy: (name) => name === "open_tab"
          ? { kind: "create", parallel: true }
          : { kind: "target", implicit: false, observation: true },
        getTabAliases: () => ({}),
        async commitToolResult() {},
        async discardToolResult() {},
      },
    },
    skills: { list: async () => [], load: async () => null, getDisplayName: () => "", normalizeResourcePath: (value) => String(value || "") },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    async dispatchSidepanel() {},
  });
  await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-clear" });
  const batch = await runtime.executeTool({
    sessionId: "drive-clear",
    calls: [
      { id: "open", name: "open_tab", args: { url: "https://example.com", tabAlias: "page" } },
      { id: "read", name: "list_tabs", args: { tabRef: "page" } },
    ],
  });
  assert.equal(batch.results[1].isError, false);
  assert.equal(seen[0].workingTabId, 4);
  assert.equal(seen[0].externalDrive, true);
  assert.equal(seen[1].workingTabId, null);
  assert.equal(seen[1].pageUrl, "");
});

test("production normalization creates fresh isolated sessions even with an occupied default", async () => {
  const repository = createSessionRepository({ storage: createMemoryStorage() });
  const supervisor = createSessionSupervisor({ createAgent: () => { throw new Error("must not start a model"); } });
  const aliases = new Map();
  const pages = new Map();
  let nextTab = 1;
  let executions = 0;
  const runtime = createMcpRuntime({
    sessions: {
      normalizeId: normalizeRuntimeSessionId,
      requireId: requireExplicitSessionId,
      supervisor,
      listMetadata: repository.listMetadata,
      createMetadata: repository.createMetadata,
      setRuntime: (id, patch) => supervisor.setRuntime(id, { ...supervisor.getRuntime(id), ...patch }),
      getRuntime: id => supervisor.getRuntime(id) || { status: "idle" },
    },
    tools: {
      canManageSessions: async () => false,
      buildRunProfile: async () => ({}),
      loadedSkillNames: () => [],
      recordLoadedSkillNames() {},
      runtime: {
        getSchemas: () => [],
        getTabAliases: id => aliases.get(id) || {},
        getBatchTabPolicy: name => name === "open_tab"
          ? { kind: "create", parallel: true } : { kind: "target", implicit: false, observation: true },
        async execute(name, args, _signal, context) {
          executions++;
          const id = context.sessionId;
          if (name === "run_script") throw Object.assign(new Error('Use a valid tabRef'), {
            code: "SCRIPT_EVALUATION_FAILED", details: { tabRef: "page" },
          });
          if (name === "open_tab") {
            const tab = nextTab++;
            aliases.set(id, { ...aliases.get(id), [args.tabAlias]: tab });
            pages.set(tab, { sessionId: id, url: args.url });
            return { tabRef: tab, url: args.url };
          }
          const page = pages.get(args.tabId ?? aliases.get(id)?.[args.tabRef]);
          assert.equal(page?.sessionId, id, "page reads must stay within the owning session");
          return { snapshot: page.url };
        },
      },
    },
    skills: { list: async () => [], load: async () => null, getDisplayName: skill => skill?.name || "", normalizeResourcePath: String },
    artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
    trace: { get: async () => [] },
    userInputPermissions: {
      hasBrowserPermission: async () => false,
      locationConsent: { isAccepted: async () => false, acceptExternal: async () => {} },
    },
    async dispatchSidepanel() {},
  });
  assert.equal(normalizeRuntimeSessionId(undefined), "default");
  const first = await runtime.createDriveSession({ title: "Inspect example page", clientName: "qz-cli" });
  const second = await runtime.createDriveSession({ title: "Inspect example page", clientName: "pi" });
  assert.match(first.sessionId, /^[0-9a-f]{32}$/);
  assert.match(second.sessionId, /^[0-9a-f]{32}$/);
  assert.notEqual(first.sessionId, second.sessionId);
  await repository.createMetadata({ id: "default", title: "Ordinary task" });
  supervisor.setRuntime("default", { status: "running", runId: "ordinary-run" });
  const third = await runtime.createDriveSession({ title: "Inspect example page", clientName: "other" });
  assert.match(third.sessionId, /^[0-9a-f]{32}$/);
  assert.equal(new Set([first.sessionId, second.sessionId, third.sessionId]).size, 3);
  assert.equal((await repository.getMetadata("default")).title, "Ordinary task");
  assert.equal(supervisor.getRuntime("default").runId, "ordinary-run");
  assert.equal((await repository.getMetadata(first.sessionId)).title, "Inspect example page");
  assert.equal((await repository.getMetadata(second.sessionId)).title, "Inspect example page");

  const ids = [first.sessionId, second.sessionId];
  const opened = await Promise.all(ids.map((sessionId, i) => runtime.executeTool({ sessionId, calls: [
    { id: "open", name: "open_tab", args: { url: `https://example.com/${i}`, tabAlias: "page" } },
    { id: "read", name: "get_ax_tree", args: { tabRef: "page" } },
  ] })));
  assert.notEqual(opened[0].results[0].result.tabRef, opened[1].results[0].result.tabRef);
  for (const [i, sessionId] of ids.entries()) {
    assert.ok(opened[i].results.every(row => !row.isError));
    assert.equal(opened[i].results[1].result.snapshot, `https://example.com/${i}`);
    const read = await runtime.executeTool({ sessionId, name: "get_ax_tree", args: { tabRef: "page" } });
    assert.equal(read.result.snapshot, `https://example.com/${i}`, "later connections retain only this session's alias");
  }

  await assert.rejects(runtime.executeTool({ sessionId: first.sessionId, scriptApiVersion: 2, name: "run_script",
    args: { tabRef: "page", timeout: 30, code: "async () => 7" },
  }), error => {
    assert.equal(error.code, "SCRIPT_EVALUATION_FAILED");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, /tabId|inner|工作标签页|working tab|target/i);
    assert.match(error.message, /tabRef/);
    return true;
  });
  const before = await repository.listMetadata();
  const executed = executions;
  for (const method of ["executeTool", "listTools", "getTool"]) {
    for (const sessionId of [undefined, "", " ", "misspelled"]) {
      if (method !== "executeTool" && sessionId === undefined) {
        await runtime[method]({ name: "list_tabs" });
        continue;
      }
      await assert.rejects(runtime[method]({ sessionId, name: "list_tabs", args: {} }), error => {
        assert.equal(error.code, sessionId === "misspelled" ? "DRIVE_SESSION_NOT_FOUND" : "DRIVE_SESSION_REQUIRED");
        assert.match(error.message, /qz session create/);
        assert.match(error.message, /qingzhou_create_drive_session/);
        return true;
      });
    }
  }
  assert.equal(executions, executed);
  assert.deepEqual(await repository.listMetadata(), before);
  await assert.rejects(runtime.executeTool({ sessionId: "default", name: "list_tabs" }), error => error.code === "DRIVE_SESSION_OCCUPIED");
});

test("drive creation reports occupied when metadata creation is unavailable", async () => {
  const runtime = createMcpRuntime({
    sessions: {
      supervisor: {},
      listMetadata: async () => ({}),
    },
    async dispatchSidepanel() {},
  });
  await assert.rejects(
    runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-unavailable" }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && /qz session create/.test(error.message),
  );
});

test("a drive create does not take over an existing task", async () => {
  const repository = createSessionRepository({ storage: createMemoryStorage() });
  await repository.createMetadata({ id: "busy", title: "Busy" });
  await assert.rejects(
    repository.createMetadata({ id: "busy", title: "轻舟 · CLI", source: "external-drive", driveGroupTitle: "轻舟 · CLI" }),
    (error) => error.code === "DRIVE_SESSION_OCCUPIED" && /qz session create/.test(error.message),
  );
  const stored = await repository.getMetadata("busy");
  assert.equal(stored.title, "Busy");
  assert.equal(stored.source, undefined);
  const created = await repository.createMetadata({
    id: "fresh", title: "轻舟 · CLI", source: "external-drive", driveGroupTitle: "轻舟 · CLI", titleSource: "fixed",
  });
  assert.equal(created.source, "external-drive");
  const again = await repository.createMetadata({ id: "fresh", title: "other", source: "external-drive" });
  assert.equal(again.title, "轻舟 · CLI");
  assert.equal(again.source, "external-drive");
});

test("drive metadata migrates generated labels while preserving client and custom titles", async () => {
  const storage = createMemoryStorage({ _sessions: {
    old: { id: "old", title: "用户任务标题", source: "external-drive", driveGroupTitle: "轻舟 · Claude Code" },
    custom: { id: "custom", source: "external-drive", driveGroupTitle: "Personal research" },
  } });
  const repository = createSessionRepository({ storage });
  const old = await repository.getMetadata("old");
  assert.equal(old.driveClientName, "Claude Code");
  assert.equal(old.driveGroupTitle, undefined);
  assert.equal(old.title, "用户任务标题");
  assert.equal((await repository.getMetadata("custom")).driveGroupTitle, "Personal research");
  const created = await repository.createMetadata({ id: "new", source: "external-drive", title: "新任务", driveClientName: "qz-cli" });
  assert.equal(created.driveClientName, "CLI");
  assert.equal(storage.snapshot()._sessions.new.driveGroupTitle, undefined);
  assert.equal(storage.snapshot()._sessions.old.driveClientName, "Claude Code");
});


function assertNoDriveTabLeak(label, value) {
  const text = typeof value === "string" ? value : `${value?.signature || ""}\n${value?.description || ""}`;
  assert.doesNotMatch(text, /tabId|workingTab|isWorkingTab|working tab|工作标签|use_tab|get_working_tab|\bselector\b/i, `${label} leaks retired targeting concepts: ${text.slice(0, 240)}`);
  assert.doesNotMatch(text, /\binner\b/i, `${label} still shows inner: ${text.slice(0, 240)}`);
}

test("drive catalogs hide tabId and inner for every default tool", async () => {
  const metadata = { "agent-1": { id: "agent-1", source: "agent" } };
  for (const language of ["zh-CN", "en"]) {
    const schemas = withLanguage(language, () => JSON.parse(JSON.stringify(getToolSchemas({ language }))));
    const catalog = schemas.map(schema => ({
      name: schema.function?.name || "",
      description: schema.function?.description || "",
      parameters: schema.function?.parameters || {},
      type: schema.type || "function",
    })).filter(tool => tool.name);
    const watched = catalog.filter(tool => isDriveToolDiscoverable(tool.name));
    assert.ok(watched.some(tool => tool.name === "list_tabs"));
    assert.ok(!watched.some(tool => ['use_tab', 'get_working_tab'].includes(tool.name)));
    for (const tool of watched) assertNoDriveTabLeak(`${language} signature ${tool.name}`, driveToolSignature(tool));
    const runScript = driveToolSignature(catalog.find(tool => tool.name === "run_script"));
    assert.equal(runScript.signature, "run_script({timeout?:number, args?:any, code:string})");
    assert.doesNotMatch(runScript.signature, /\b(?:target|scope)\b/);
    const ax = driveToolSignature(catalog.find(tool => tool.name === "get_ax_tree"));
    assert.match(ax.signature, /scope\?:"viewport"\|"full"/);
    assert.doesNotMatch(ax.signature, /"page"/);

    const runtime = createMcpRuntime({
      sessions: {
        normalizeId: (value) => String(value || "").trim(),
        requireId: (value) => String(value || "").trim(),
        supervisor: {
          isRunCurrent: () => false,
          mintDriveRunId: () => "drive-run",
          clearDriveRunId() {},
          takeDriveRunForRelease: () => "",
          getUserWait: () => null,
          resolveUserWait: () => false,
          rejectUserWait: () => false,
        },
        submitMessage: async () => ({ promise: Promise.resolve(), disposition: "started" }),
        waitForRunObserved: async () => true,
        getRuntimeOutput: async (_id, project = (value) => value) => project({ status: "idle" }),
        getLiveAgentEntry: async () => null,
        setRuntime() {},
        getStoredRuntime: () => null,
        getLastMessages: async () => ({ messages: [] }),
        getAgent: async () => null,
        getTranscript: async () => [],
        listMetadata: async () => ({ ...metadata }),
        createMetadata: async (input) => { metadata[input.id] = { ...input }; return metadata[input.id]; },
        getConversation: async () => [],
        compactTranscriptEvent: (event) => event,
        getRuntime: () => ({ status: "idle", workingTabId: null }),
      },
      userInputPermissions: {
        hasBrowserPermission: async () => false,
        locationConsent: { isAccepted: async () => false, acceptExternal: async () => { throw new Error("not configured"); } },
      },
      tools: {
        ready: async () => {},
        canManageSessions: async () => true,
        buildRunProfile: async () => ({}),
        loadedSkillNames: () => [],
        recordLoadedSkillNames: () => {},
        runtime: {
          getSchemas: () => schemas,
          execute: async () => ({ ok: true }),
          getModelPolicy: () => null,
          getBatchTabPolicy: () => null,
          getTabAliases: () => ({}),
        },
      },
      skills: { list: async () => [], load: async () => null, getDisplayName: (skill) => skill?.name || "", normalizeResourcePath: (value) => String(value || "") },
      artifacts: { empty: () => ({ total: 0, items: [] }), collect: async () => ({ total: 0, items: [] }) },
      trace: { get: async () => [] },
      async dispatchSidepanel() {},
    });
    await runtime.createDriveSession({ title: "Inspect example page", sessionId: "drive-1" });
    const listed = await runtime.listTools({ sessionId: "drive-1" });
    assert.ok(listed.tools.length > 1);
    for (const name of ["act_on_screen", "list_images", "download_url", "read_dom"]) {
      assert.ok(listed.tools.some(tool => tool.name === name), `MCP discovers ${name} without a name lookup`);
    }
    for (const tool of listed.tools) assertNoDriveTabLeak(`${language} list_tools ${tool.name}`, tool);
    for (const name of ["list_tabs", "navigate"]) {
      assertNoDriveTabLeak(`${language} get_tool ${name}`, await runtime.getTool({ sessionId: "drive-1", name }));
    }
    for (const name of ["run_script", "collect_images", "read_image_asset", "data_store"]) {
      assert.ok(!listed.tools.some(tool => tool.name === name));
      assert.equal(await runtime.getTool({ sessionId: "drive-1", name }), null);
      assert.equal((await runtime.getTool({ sessionId: "agent-1", name })).name, name);
    }
    for (const name of ['use_tab', 'get_working_tab', 'run_skill_script']) await assert.rejects(runtime.getTool({ sessionId: 'drive-1', name }), { code: 'DRIVE_TOOL_FORBIDDEN' });
    const builtInList = await runtime.getTool({ sessionId: "agent-1", name: "list_tabs" });
    assert.doesNotMatch(JSON.stringify(builtInList), /tabId/);

    const bridge = createRunScriptBridge({
      supervisor: {
        isRunCurrent: (_sessionId, runId) => [`opaque-${language}`, "drive-native-looking-run"].includes(runId),
        hasAgent: () => true,
        getAbortSignal: () => new AbortController().signal,
      },
      getRuntime: () => ({ status: "running" }),
      isTerminalRuntimeForRun: () => false,
      canManageSessions: async () => true,
      buildRunProfile: async () => ({}),
      getRunToolContext: async (_sessionId, runId) => ({ language, externalDrive: runId === `opaque-${language}` }),
      toolRuntime: createToolRuntime(),
      collectArtifacts: () => [],
    });
    const driveList = await bridge.handleToolCall({ toolName: "__list_tools__", sessionId: "s1", runId: `opaque-${language}` });
    assert.ok(driveList.result.tools.length > 1);
    for (const tool of driveList.result.tools) assertNoDriveTabLeak(`${language} $list ${tool.name}`, tool);
    const builtInScriptList = await bridge.handleToolCall({ toolName: "__list_tools__", sessionId: "s1", runId: "drive-native-looking-run" });
    assert.doesNotMatch(JSON.stringify(builtInScriptList.result.tools.find(tool => tool.name === "list_tabs")), /tabId/);
  }
  const zhSchemas = withLanguage("zh-CN", () => JSON.parse(JSON.stringify(getToolSchemas({ language: "zh-CN" }))));
  const zhTool = (name) => driveToolSignature(zhSchemas.map(schema => ({
    name: schema.function?.name || "",
    description: schema.function?.description || "",
    parameters: schema.function?.parameters || {},
  })).find(tool => tool.name === name));
  assert.match(zhTool("list_tabs").description, /active(?:=true)? 表示用户正在看的标签/);
  for (const name of ['use_tab', 'get_working_tab']) assert.equal(zhSchemas.some(schema => schema.function.name === name), false);


});

test("a drive batch conflict names tabRef", async () => {
  const builtIn = withLanguage("zh-CN", () => toolT("tabReferenceConflict", { tabRef: "page" }));
  const builtInEn = withLanguage("en", () => toolT("tabReferenceConflict", { tabRef: "page" }));
  assert.doesNotMatch(builtIn, /tabId/);
  assert.doesNotMatch(builtInEn, /tabId/);
  assert.match(withLanguage("zh-CN", () => t("toolError.BATCH_TAB_REFERENCE_ERROR.conflictingTarget.message", { tabRef: "page" })), /tabRef/);
  const run = (language) => {
    let pending;
    withLanguage(language, () => {
      pending = runDriveCalls([{ id: "mix", name: "get_ax_tree", args: { tabRef: "page", tabId: 99 } }], {
        signal: new AbortController().signal,
        aliases: { page: 11 },
        execute: async () => { throw new Error("planner should reject before execute"); },
        getBatchTabPolicy: () => ({ kind: "target", implicit: false, observation: true }),
      });
    });
    return pending;
  };
  const zh = await run("zh-CN");
  const en = await run("en");
  assert.equal(zh.results[0].result.message, builtIn);
  assert.equal(en.results[0].result.message, builtInEn);
  assert.doesNotMatch(zh.results[0].result.message, /tabId/);
  assert.doesNotMatch(en.results[0].result.message, /tabId/);
});

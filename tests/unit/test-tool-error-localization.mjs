import assert from "node:assert/strict";
import { isToolFailure, toolError } from "../../src/shared/contracts/tool-error.js";
import { withLanguage } from "../../src/shared/i18n/index.js";
import { t as skillT } from "../../src/capabilities/skills/i18n.js";
import { readFileSync, readdirSync } from "node:fs";
import {
  hasLocalizedToolFailureCode,
  localizeToolDiagnostic,
  localizeToolFailureCode,
  localizeToolFailureError,
  localizeToolFailurePayload,
  localizeToolFailureText,
} from "../../src/shared/tools/tool-error-localization.js";

withLanguage("zh-CN", () => {
const SOURCE_FILES = [
  "src/background/agent/agent.ts",
  "src/background/skills/skill-tool-runtime.ts",
  "src/background/service-worker.ts",
  "src/background/skills/runtime.ts",
  "src/capabilities/wait/tools.ts",
  "src/capabilities/media/tools.ts",
  "src/background/tools/runtime.ts",
  ...readdirSync("src/background/tools")
    .filter(name => /\.[jt]s$/.test(name) && !name.endsWith(".d.ts"))
    .map(name => `src/background/tools/${name}`),
  "src/offscreen.ts",
  "src/runner-sandbox.ts",
  "src/workers/inner-runner.ts",
  "src/shared/session/session-codec.ts",
  "src/shared/tools/tool-message-protocol.ts",
  "src/sidepanel/sidepanel.ts",
];

const CODE_PATTERNS = [
  /new ToolExecutionError\(\s*["`]([A-Z][A-Z0-9_]+)["`]/g,
  /toolError\(\s*["`]([A-Z][A-Z0-9_]+)["`]/g,
  /new SkillEditError\(\s*["`]([A-Z][A-Z0-9_]+)["`]/g,
  /code\s*:\s*["`]([A-Z][A-Z0-9_]+)["`]/g,
  /code\s*\|\|\s*["`]([A-Z][A-Z0-9_]+)["`]/g,
];

const codes = new Set();
for (const file of SOURCE_FILES) {
  const source = readFileSync(file, "utf8");
  for (const pattern of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) codes.add(match[1]);
  }
}

assert.ok(codes.size > 40, "should discover tool failure codes from source");
for (const code of [...codes].sort()) {
  assert.ok(hasLocalizedToolFailureCode(code), `missing localized label for ${code}`);
  const label = localizeToolFailureCode(code);
  assert.notEqual(label, code, `code should not be shown raw: ${code}`);
  assert.equal(label.includes("_"), false, `localized label should not contain underscores: ${code}`);
}
for (const [language, forbidden, target, tabRef] of [
  ["zh-CN", "直驱不能调用此工具", "直驱脚本只跑页面", "直驱需要页面"],
  ["en", "Direct drive cannot call this tool", "Page scripts only", "Page reference required"],
]) withLanguage(language, () => {
  assert.equal(localizeToolFailureCode("DRIVE_TOOL_FORBIDDEN"), forbidden);
  assert.equal(localizeToolFailureCode("DRIVE_RUN_SCRIPT_TARGET"), target);
  assert.equal(localizeToolFailureCode("DRIVE_TAB_REF_REQUIRED"), tabRef);
});

for (const [language, message] of [
  ["zh-CN", "截视口不传 target。截元素请传 uid: 或 css: 目标。"],
  ["en", "Omit target to capture the viewport. For an element, pass a uid: or css: target."],
]) withLanguage(language, () => {
  const error = Object.assign(new Error(message), { code: "SCREENSHOT_TARGET_INVALID" });
  assert.equal(localizeToolFailureError(error).message, message);
  assert.equal(localizeToolFailurePayload({ error: error.message, code: error.code }).error, message,
    "runtime and transport localization must preserve screenshot recovery guidance");
});

for (const language of ["en", "zh-CN"]) withLanguage(language, () => {
  for (const code of [undefined, "CUSTOM_FAILURE", "TOOL_EXECUTION_FAILED"]) {
    const error = Object.assign(new Error("Injected lost touchEnd response"), {
      ...(code ? { code } : {}), hint: "Inspect the page before retrying.",
      details: { tabRef: "page", trace: [{ message: "touch started" }], tabId: 7 },
    });
    const result = localizeToolFailureError(error);
    assert.equal(result, error, "native Error identity survives tool boundaries");
    assert.deepEqual(toolError(result.code, result.message, result), { code: code || "TOOL_EXECUTION_FAILED", message: error.message,
      hint: error.hint, details: { tabRef: "page", trace: [{ message: "touch started" }] } });
    assert.equal(localizeToolFailureError(result), result, "another tool boundary preserves canonical recovery data");
  }
  for (const error of ["AbortError", "TimeoutError"].flatMap(name => [Object.assign(new Error("The operation was aborted"), { name }), new DOMException("The operation was aborted", name)])) {
    assert.equal(localizeToolFailureError(error), error, "cancellation keeps its native identity and code");
    assert.ok(["AbortError", "TimeoutError"].includes(error.name));
    assert.equal(error.message, "The operation was aborted");
  }
  const denied = new DOMException("The browser denied the request", "NotAllowedError");
  assert.equal(localizeToolFailureError(denied), denied, "read-only native codes do not replace the original exception");
  assert.deepEqual(toolError(String(denied.code || "TOOL_EXECUTION_FAILED"), denied.message), {
    code: "TOOL_EXECUTION_FAILED", message: "The browser denied the request",
  });
  const mapped = Object.assign(new Error("changed revision 7"), { code: "DATA_ROW_CONFLICT", details: { rowId: "row:abc" } });
  assert.equal(localizeToolFailureError(mapped), mapped, "known legacy errors retain their identity");
  assert.equal(mapped.message, localizeToolFailurePayload({ ok: false, error: "changed revision 7", code: "DATA_ROW_CONFLICT", details: mapped.details }).error);
});

assert.equal(localizeToolFailureCode("TOOL_NOT_EXECUTED"), "工具未执行");
assert.equal(
  localizeToolFailurePayload({ error: "x", code: "TOOL_NOT_EXECUTED" }).error,
  "模型没有完成这次工具调用，工具未执行。",
);

{
  const payload = localizeToolFailurePayload({
    ok: false,
    error: "[RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED] run_script blocked open_tab on its own tab.",
    code: "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED",
    diagnostic: { category: "page_lifecycle", likelyCause: "页面会卸载" },
    details: { toolName: "open_tab" },
  }, { toolName: "open_tab" });
  assert.equal(payload.error, "run_script 阻止了会卸载当前页面的内部工具调用，请拆成普通工具步骤执行。");
  assert.equal(payload.code, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
  assert.equal(payload.codeLabel, "脚本内工具会卸载当前页面");
  assert.equal(payload.diagnostic.category, "页面生命周期");
  assert.equal(payload.details.originalCode, undefined);
  assert.equal(payload.details.originalError, undefined);
}

{
  const err = new Error("Unknown tool: no_such_tool");
  err.code = "UNKNOWN_TOOL";
  err.details = { name: "no_such_tool" };
  const localized = localizeToolFailureError(err);
  assert.equal(localized.message, "未知工具：no_such_tool");
  assert.equal(localized.codeLabel, "未知工具");
  assert.deepEqual(localized.details, { name: "no_such_tool" });
  // Catalog queries fail inside list_tools, but the requested name is what the
  // caller must fix. The execution context must not hide that identity.
  const queryError = Object.assign(new Error("Unknown or unavailable tool: no_such_tool"), {
    code: "UNKNOWN_TOOL", details: { name: "no_such_tool", toolName: "list_tools" },
  });
  assert.equal(localizeToolFailureError(queryError, { toolName: "list_tools" }).message, "未知工具：no_such_tool");
}

{
  const err = new Error("Unexpected token");
  err.code = "PLUGIN_HOST_SCRIPT_FAILED";
  err.details = { skillName: "技能工作台", script: "scripts/create-skill.js" };
  const localized = localizeToolFailureError(err);
  assert.equal(localized.message, "Skill 脚本执行失败：技能工作台/scripts/create-skill.js");
  assert.equal(localized.codeLabel, "Skill 脚本执行失败");
}

{
  const err = new Error("Long press duration is out of range");
  err.code = "INVALID_LONG_PRESS_DURATION";
  err.details = { field: "durationMs", value: 200, min: 300, max: 5000 };
  const localized = localizeToolFailureError(err, { toolName: "act_on_screen" });
  assert.equal(localized.message, "长按时长必须在 300–5000 毫秒之间。");
  assert.equal(localized.codeLabel, "长按时长无效");
  assert.equal(localized.details.value, 200);
}

{
  const err = new Error("Scroll repeat is out of range");
  err.code = "INVALID_SCROLL_REPEAT";
  err.details = { field: "repeat", value: 21, min: 1, max: 20 };
  const localized = localizeToolFailureError(err, { toolName: "act_on_screen" });
  assert.equal(localized.message, "滚轮次数必须是 1–20 之间的整数。");
  assert.equal(localized.codeLabel, "滚轮次数无效");
  assert.equal(localized.details.value, 21);
}

{
  const message = localizeToolFailureText("安全护栏已阻止 Agent 访问 restricted.example.com。");
  assert.equal(message.includes("Agent"), false);
  assert.equal(message.includes("安全护栏"), false);
  assert.equal(message.includes("安全策略"), true);
}

{
  const message = localizeToolFailureText("Cannot wait for the session currently executing this tool");
  assert.equal(message, "不能等待当前正在执行该工具的会话。");
}

{
  const diagnostic = localizeToolDiagnostic({ category: "tool_bridge" });
  assert.equal(diagnostic.category, "工具桥接");
  assert.equal(diagnostic.originalCategory, "tool_bridge");
}

for (const [language, label, message] of [
  ["zh-CN", "技能名称有歧义", "有多个技能都叫“Shared title”，无法确定是哪一个，操作未执行。请改用 list_skills 里的 name：rt1, rt2。"],
  ["en", "Ambiguous skill name", 'Several skills are named "Shared title", so the action did not run. Use one of these names from list_skills: rt1, rt2.'],
]) withLanguage(language, () => {
  const candidates = ["rt1", "rt2"].map(name => ({ name, displayName: "Shared title" }));
  const payload = localizeToolFailurePayload({ code: "SKILL_NAME_AMBIGUOUS", error: "original", details: { name: "Shared title", candidates } });
  assert.equal(payload.codeLabel, label);
  assert.equal(payload.error, message);
  assert.deepEqual(payload.details.candidates, candidates);
  assert.equal(skillT("skillNameAmbiguous", { name: "Shared title", names: "rt1, rt2" }), message);
});

for (const [language, syntax, failed] of [
  ["zh-CN", "脚本语法错误。", "脚本执行失败。"],
  ["en", "The script has a syntax error.", "The script failed."],
]) withLanguage(language, () => {
  const reference = localizeToolFailurePayload({
    ok: false,
    code: "SCRIPT_EVALUATION_FAILED",
    error: "ReferenceError: price is not defined",
    details: { lineNumber: 4 },
  });
  assert.match(reference.error, /price is not defined/);
  assert.equal(reference.error.includes("未定义的变量") || reference.error.includes("undefined variable"), false);

  const typeError = localizeToolFailureText(
    "TypeError: Cannot read properties of undefined (reading 'title')",
    { code: "SCRIPT_EVALUATION_FAILED" },
  );
  assert.match(typeError, /reading 'title'/);

  const safari = localizeToolFailureText("ReferenceError: Can't find variable: tools", { code: "SCRIPT_EVALUATION_FAILED" });
  assert.match(safari, /tools/);

  const unset = localizeToolFailureText("price is not defined");
  assert.match(unset, /price/);

  assert.equal(localizeToolFailureText("SyntaxError: Unexpected token", { code: "SCRIPT_EVALUATION_FAILED" }), syntax);
  assert.equal(localizeToolFailureText("Script evaluation failed", { code: "SCRIPT_EVALUATION_FAILED" }), failed);
  const restored = localizeToolFailurePayload({
    ok: false,
    code: "SCRIPT_EVALUATION_FAILED",
    error: "Script evaluation failed: ReferenceError: price is not defined",
  });
  assert.equal(restored.error, failed);
  assert.equal(restored.details, undefined, "localization does not append internal diagnostics");
});

console.log("tool error localization tests passed");

for (const [details, message] of [
  [{ path: "$.rows[0].value", expectedType: "number" }, "example 的 rows[0].value 参数格式不正确：需要传入数字。"],
  [{ path: "$.action", allowedValues: ["create", "get"] }, "example 的 action 参数无效，请使用：create、get。"],
  [{ path: "$.content", expectedType: ["string", "object"] }, "example 的 content 参数格式不正确：需要传入文本或对象。"],
  [{ path: "$", expectedType: "object" }, "example 的参数格式不正确：需要传入对象。"],
]) assert.equal(localizeToolFailurePayload({ code: "INVALID_ARGUMENTS", error: "Invalid", details }, { toolName: "example" }).error, message);

// Fixed messages, aliases and context-dependent messages keep distinct presentation semantics.
for (const code of ["INNER_RUNNER_FAILED", "INNER_RUNNER_WORKER_ERROR", "INNER_RUNNER_SEND_FAILED"]) {
  assert.equal(localizeToolFailureText("failed", { code }), "内部脚本执行失败。");
}
assert.equal(localizeToolFailurePayload({ ok: true, value: 42 }).value, 42);
assert.equal(localizeToolFailureText("Failed to fetch", { code: "CDP_COMMAND_FAILED" }), "网络请求失败。");
assert.equal(localizeToolFailureText("custom", { code: "DOCUMENT_TABLE_NOT_FOUND" }),
  "未找到指定的文档表格，请使用解析摘要或正文结果返回的 tableId。");

{
  const payload = localizeToolFailurePayload({ error: "x", code: "BATCH_TAB_DEPENDENCY_FAILED", details: { tabRef: "a" } });
  assert.equal(payload.codeLabel, "前置 open_tab 失败");
  assert.equal(payload.error, "tabAlias「a」对应的 open_tab 未能建立有效页面，已跳过此次调用。请先处理该 open_tab 的错误，再重试。");
}

{
  const payload = localizeToolFailurePayload({ error: "x", code: "BATCH_TAB_DEPENDENCY_FAILED", details: {} });
  assert.equal(payload.error, "tabAlias「（未知）」对应的 open_tab 未能建立有效页面，已跳过此次调用。请先处理该 open_tab 的错误，再重试。");
}

{
  const messages = {}, labels = {};
  for (const reason of ["unknown_reference", "duplicate_alias", "forward_reference", "invalid_alias", "invalid_reference", "ambiguous_target", "outside_batch", "conflicting_target", "no_alias"]) {
    const payload = localizeToolFailurePayload({ error: "x", code: "BATCH_TAB_REFERENCE_ERROR", details: { reason, tabRef: "a" } });
    messages[reason] = payload.error;
    labels[reason] = payload.codeLabel;
    assert.ok(!payload.error.includes("{tabRef}"), `${reason} interpolates tabRef`);
    assert.ok(payload.codeLabel && !payload.codeLabel.includes("BATCH_TAB"), `${reason} label stays human-readable`);
  }
  assert.equal(new Set(Object.values(messages)).size, 9, "every reference reason owns its message");
  assert.equal(new Set(Object.values(labels)).size, 9, "every reference reason owns its label");
  assert.equal(messages.unknown_reference, "当前任务没有已打开或本批待创建的别名「a」。请检查名称，或在 tabRef 中使用已返回的浏览器数字 ID。");
  assert.equal(messages.no_alias, "本会话还没有页面别名。tabRef 可以是 open_tab 时用 tabAlias 设的别名，也可以是 open_tab 或 list_tabs 返回的 tabRef。别名和 tabRef 都属于本会话。同一任务后续调用带同一个 --session（MCP 带同一个 sessionId）。");
  assert.doesNotMatch(messages.no_alias, /省略 tabRef/);
  const englishNoAlias = withLanguage("en", () => localizeToolFailurePayload({
    error: "x", code: "BATCH_TAB_REFERENCE_ERROR", details: { reason: "no_alias", tabRef: "a" },
  }).error);
  assert.equal(englishNoAlias, "This session has no page alias yet. tabRef can be the alias set with tabAlias on open_tab, or the tabRef returned by open_tab or list_tabs. Aliases and tab refs belong to this session. Later calls in the same task use the same --session (MCP: the same sessionId).");
  assert.doesNotMatch(englishNoAlias, /omit tabRef/i);
  assert.equal(messages.outside_batch, "tabRef「a」尚未关联到本会话的页面。请使用 open_tab 或 list_tabs 返回的 tabRef。");
  assert.equal(labels.duplicate_alias, "tabAlias 重复");
  const generic = localizeToolFailurePayload({ error: "x", code: "BATCH_TAB_REFERENCE_ERROR", details: { tabRef: "a" } });
  assert.equal(generic.codeLabel, "标签页引用无法解析");
  assert.equal(generic.error, "标签页引用无法解析。请用 tabRef 指定已返回的浏览器数字 ID 或当前任务的页面别名；新页面的 open_tab 应放在引用它的调用之前。");
}

{
  const err = new Error("ignored");
  err.code = "BATCH_TAB_REFERENCE_ERROR";
  err.details = { reason: "forward_reference", tabRef: "b" };
  const localized = localizeToolFailureError(err);
  assert.equal(localized.codeLabel, "open_tab 顺序错误");
  assert.equal(localized.message, "tabAlias「b」的 open_tab 必须排在引用它的页面调用之前。请调整本批中的调用顺序。");
}

// Native ToolError values retain their public shape through localization.
assert.deepEqual(localizeToolFailurePayload({ code: "CUSTOM_FAILURE", message: "Try again", hint: "Open the page first", details: { tabRef: "page" } }), {
  code: "CUSTOM_FAILURE", message: "Try again", hint: "Open the page first", details: { tabRef: "page" },
});

assert.equal(isToolFailure({ code: "BUSINESS_CONFLICT", message: "Retry" }), true);
assert.equal(isToolFailure({ ok: true, result: { code: "BUSINESS_CONFLICT", message: "User data" } }), false);
assert.equal(isToolFailure({ code: "SUCCESS", message: "done" }), false);

});

// Real execution boundaries preserve the same native failure in both caller modes.
{
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async () => ({}) } } };
  try {
    const { createToolRegistry } = await import("../../src/background/tools/registry.js");
    const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
    const registry = createToolRegistry();
    let injected;
    registry.forCapability("native-error")({ name: "native_error_probe", parameters: {
      type: "object", properties: { code: { type: "string" } },
    }, execute: args => {
      injected = Object.assign(new Error("Injected lost touchEnd response"), args.code ? { code: args.code } : {});
      throw injected;
    } });
    const runtime = createToolRuntime({ sessions: { isRunCurrent: () => true } });
    for (const language of ["en", "zh-CN"]) for (const externalDrive of [false, true]) {
      for (const code of [undefined, "CUSTOM_FAILURE", "TOOL_EXECUTION_FAILED"]) {
        await assert.rejects(runtime.execute("native_error_probe", code ? { code } : {}, undefined, {
          sessionId: "native-error", runId: "opaque-native-error", language, externalDrive,
          toolRegistrySnapshot: registry.snapshot(language),
        }), error => {
          assert.equal(error, injected);
          assert.deepEqual(toolError(error.code, error.message), {
            code: code || "TOOL_EXECUTION_FAILED", message: "Injected lost touchEnd response",
          });
          return true;
        });
      }
    }
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}


withLanguage("en", () => assert.equal(localizeToolFailureText("The requested tab is no longer available.", { code: "SESSION_TAB_UNAVAILABLE" }),
  "The requested tab is no longer available."));
withLanguage("zh-CN", () => assert.equal(localizeToolFailureText("Session tab unavailable", { code: "SESSION_TAB_UNAVAILABLE" }),
  localizeToolFailureCode("SESSION_TAB_UNAVAILABLE")));

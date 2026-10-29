import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  hasLocalizedToolFailureCode,
  localizeToolDiagnostic,
  localizeToolFailureCode,
  localizeToolFailureError,
  localizeToolFailurePayload,
  localizeToolFailureText,
} from "../../src/shared/tools/tool-error-localization.js";

const SOURCE_FILES = [
  "src/background/agent/agent.ts",
  "src/background/skills/skill-tool-runtime.ts",
  "src/background/service-worker.ts",
  "src/background/skills/runtime.ts",
  "src/capabilities/wait/tools.ts",
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
  assert.equal(payload.details.originalCode, "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED");
  assert.match(payload.details.originalError, /run_script blocked/);
}

{
  const err = new Error("Unknown tool: no_such_tool");
  err.code = "UNKNOWN_TOOL";
  err.details = { name: "no_such_tool" };
  const localized = localizeToolFailureError(err);
  assert.equal(localized.message, "未知工具：no_such_tool");
  assert.equal(localized.codeLabel, "未知工具");
  assert.equal(localized.details.originalMessage, "Unknown tool: no_such_tool");
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
  for (const reason of ["unknown_reference", "duplicate_alias", "forward_reference", "invalid_alias", "invalid_reference", "ambiguous_target", "outside_batch", "conflicting_target"]) {
    const payload = localizeToolFailurePayload({ error: "x", code: "BATCH_TAB_REFERENCE_ERROR", details: { reason, tabRef: "a" } });
    messages[reason] = payload.error;
    labels[reason] = payload.codeLabel;
    assert.ok(!payload.error.includes("{tabRef}"), `${reason} interpolates tabRef`);
    assert.ok(payload.codeLabel && !payload.codeLabel.includes("BATCH_TAB"), `${reason} label stays human-readable`);
  }
  assert.equal(new Set(Object.values(messages)).size, 8, "every reference reason owns its message");
  assert.equal(new Set(Object.values(labels)).size, 8, "every reference reason owns its label");
  assert.equal(messages.unknown_reference, "当前任务没有已打开或本批待创建的别名「a」。请检查名称，或在 tabRef 中使用已返回的浏览器数字 ID。");
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

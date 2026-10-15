import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  isRunScriptCallableExpression,
  normalizeRunScriptSourceShape,
  wrapRunScriptSource,
} from "../../src/shared/run-script-source.js";

const cases = [
  {
    name: "async arrow IIFE",
    code: "(async () => { return 1; })();",
    changed: true,
    shape: "iife",
    out: "async () => { return 1; }",
  },
  {
    name: "sync arrow IIFE without semicolon",
    code: "(() => ({ ok: true }))()",
    changed: true,
    shape: "iife",
    out: "() => ({ ok: true })",
  },
  {
    name: "async arrow IIFE with leading semicolon",
    code: ";(async () => { return document.title; })();",
    changed: true,
    shape: "iife",
    out: "async () => { return document.title; }",
  },
  {
    name: "async arrow IIFE with spaced empty call",
    code: "(\n  async () => {\n    return 1;\n  }\n)\n(\n)\n;",
    changed: true,
    shape: "iife",
    out: "async () => {\n    return 1;\n  }",
  },
  {
    name: "double wrapped async arrow IIFE",
    code: "((async () => { return 2; }))();",
    changed: true,
    shape: "iife",
    out: "async () => { return 2; }",
  },
  {
    name: "anonymous function IIFE",
    code: "(function () { return 3; })();",
    changed: true,
    shape: "iife",
    out: "function () { return 3; }",
  },
  {
    name: "named function IIFE",
    code: "(function main() { return 4; })();",
    changed: true,
    shape: "iife",
    out: "function main() { return 4; }",
  },
  {
    name: "async named function IIFE",
    code: "(async function main() { return 5; })();",
    changed: true,
    shape: "iife",
    out: "async function main() { return 5; }",
  },
  {
    name: "Crockford anonymous function IIFE",
    code: "(function () { return 6; }());",
    changed: true,
    shape: "iife",
    out: "function () { return 6; }",
  },
  {
    name: "Crockford async function IIFE",
    code: "(async function () { return 7; }());",
    changed: true,
    shape: "iife",
    out: "async function () { return 7; }",
  },
  {
    name: "string contains fake IIFE tail",
    code: "(async () => { const s = \")();\"; return s; })();",
    changed: true,
    shape: "iife",
    out: "async () => { const s = \")();\"; return s; }",
  },
  {
    name: "template contains fake IIFE tail",
    code: "(async () => { const s = `)(); ${1 + 1}`; return s; })();",
    changed: true,
    shape: "iife",
    out: "async () => { const s = `)(); ${1 + 1}`; return s; }",
  },
  {
    name: "line and block comments contain fake parens",
    code: "(async () => { // )();\n/* (() */ return 8; })();",
    changed: true,
    shape: "iife",
    out: "async () => { // )();\n/* (() */ return 8; }",
  },
  {
    name: "regex literal contains fake parens",
    code: "(async () => { const re = /\\)\\(\\);/; return re.test(')();'); })();",
    changed: true,
    shape: "iife",
    out: "async () => { const re = /\\)\\(\\);/; return re.test(')();'); }",
  },
  {
    name: "IIFE with arguments is not normalized",
    code: "(async (value) => { return value; })(123);",
    changed: false,
    shape: "iife_with_args",
    out: "(async (value) => { return value; })(123)",
    reason: "iife_with_args_not_normalized",
  },
  {
    name: "call method is not normalized",
    code: "(async () => { return 1; }).call(null);",
    changed: false,
    shape: "script",
    out: "(async () => { return 1; }).call(null)",
  },
  {
    name: "optional call is not normalized",
    code: "(async () => { return 1; })?.();",
    changed: false,
    shape: "script",
    out: "(async () => { return 1; })?.()",
  },
  {
    name: "assignment expression is not normalized",
    code: "const result = (async () => { return 1; })();",
    changed: false,
    shape: "script",
    out: "const result = (async () => { return 1; })()",
  },
  {
    name: "direct async arrow is already canonical",
    code: "async () => { return 9; }",
    changed: false,
    shape: "async_arrow_function",
    out: "async () => { return 9; }",
  },
  {
    name: "direct named function expression is callable",
    code: "function main() { return 10; }",
    changed: false,
    shape: "function_expression",
    out: "function main() { return 10; }",
  },
  {
    name: "function main call is not normalized",
    code: "function main() { return 11; }; main();",
    changed: false,
    shape: "main_invocation",
    out: "function main() { return 11; }; main()",
    reason: "main_invocation_not_normalized",
  },
  {
    name: "plain expression is not normalized",
    code: "document.title",
    changed: false,
    shape: "script",
    out: "document.title",
  },
];

const generatedCallables = [
  "async () => { return 101; }",
  "() => { return 102; }",
  "value => value",
  "(value) => value * 2",
  "async (value) => { return value ?? input.value; }",
  "function () { return 106; }",
  "function named() { return 107; }",
  "async function () { return await Promise.resolve(108); }",
  "async function named() { return await Promise.resolve(109); }",
  "() => ({ ok: true, text: \")();\" })",
  "async () => { const t = `hello )(); ${1}`; return t; }",
  "async () => { const re = /\\)\\(\\);/; return re.source; }",
  "async () => { // fake )();\n return 113; }",
  "async () => { /* fake (() */ return 114; }",
  "() => document.title",
  "async () => { trace(\"stage\", \"x\"); return { ok: true }; }",
  "async args => args?.value",
  "async () => await Promise.resolve(118)",
  "() => [1, 2, 3].map(x => x * 2)",
  "function withRegex() { return /return\\s+\\//.test(\"return /x/\"); }",
];

generatedCallables.forEach((expr, index) => {
  cases.push({
    name: `generated outer empty call ${index + 1}`,
    code: `(${expr})();`,
    changed: true,
    shape: "iife",
    out: expr,
  });
  cases.push({
    name: `generated double wrapped empty call ${index + 1}`,
    code: `(( ${expr} ))();`,
    changed: true,
    shape: "iife",
    out: expr,
  });
  cases.push({
    name: `generated newline empty call ${index + 1}`,
    code: `;(${expr})\n(\n)\n;`,
    changed: true,
    shape: "iife",
    out: expr,
  });
});

[
  "function () { return \"c1\"; }",
  "function namedC2() { return \"c2\"; }",
  "async function () { return \"c3\"; }",
  "async function namedC4() { return \"c4\"; }",
  "function () { const s = \")();\"; return s; }",
  "function () { const t = `(());`; return t; }",
  "function () { /* ) */ return /\\(\\)/.source; }",
  "function namedC8() { // fake )();\n return 8; }",
  "async function namedC9() { return await Promise.resolve(9); }",
  "function namedC10() { return { ok: true }; }",
].forEach((expr, index) => {
  cases.push({
    name: `generated crockford empty call ${index + 1}`,
    code: `(${expr}());`,
    changed: true,
    shape: "iife",
    out: expr,
  });
});

[
  {
    name: "generated args async arrow unchanged",
    code: "(async (x) => x)(1);",
    shape: "iife_with_args",
    out: "(async (x) => x)(1)",
    reason: "iife_with_args_not_normalized",
  },
  {
    name: "generated args function unchanged",
    code: "(function (x) { return x; })(1);",
    shape: "iife_with_args",
    out: "(function (x) { return x; })(1)",
    reason: "iife_with_args_not_normalized",
  },
  {
    name: "generated call unchanged",
    code: "(async () => 1).call(null);",
    shape: "script",
    out: "(async () => 1).call(null)",
  },
  {
    name: "generated optional call unchanged",
    code: "(async () => 1)?.();",
    shape: "script",
    out: "(async () => 1)?.()",
  },
  {
    name: "generated assignment unchanged",
    code: "const p = (async () => 1)();",
    shape: "script",
    out: "const p = (async () => 1)()",
  },
  {
    name: "generated nested call unchanged",
    code: "foo((async () => 1)());",
    shape: "script",
    out: "foo((async () => 1)())",
  },
  {
    name: "generated main invocation unchanged",
    code: "function main(){return 1}; main();",
    shape: "main_invocation",
    out: "function main(){return 1}; main()",
    reason: "main_invocation_not_normalized",
  },
  {
    name: "generated logical expression unchanged",
    code: "(() => 1) || (() => 2);",
    shape: "script",
    out: "(() => 1) || (() => 2)",
  },
].forEach((item) => {
  cases.push({
    changed: false,
    ...item,
  });
});

assert.equal(cases.length, 100, "test suite should cover exactly 100 source-shape cases");

for (const item of cases) {
  const actual = normalizeRunScriptSourceShape(item.code);
  assert.equal(actual.changed, item.changed, `${item.name}: changed`);
  assert.equal(actual.sourceShape, item.shape, `${item.name}: sourceShape`);
  assert.equal(actual.code, item.out, `${item.name}: code`);
  if (item.reason) assert.equal(actual.reason, item.reason, `${item.name}: reason`);
}

assert.equal(isRunScriptCallableExpression("async () => 1"), true, "async arrow callable");
assert.equal(isRunScriptCallableExpression("function main() { return 1; }"), true, "named function callable");
assert.equal(isRunScriptCallableExpression("(async () => 1)"), true, "wrapped async arrow callable");
assert.equal(isRunScriptCallableExpression("(async () => 1)()"), false, "IIFE is not callable expression");
assert.match(
  wrapRunScriptSource("var seed=42; var rng=function(){ return seed + 1; }; var x=rng(); x;"),
  /return \(x\);$/,
  "nested function returns should not prevent returning the last top-level expression",
);
assert.match(
  wrapRunScriptSource("var seed=42; var rng=()=>{ return seed + 1; }; var x=rng(); x;"),
  /return \(x\);$/,
  "nested arrow returns should not prevent returning the last top-level expression",
);
assert.equal(
  wrapRunScriptSource("if (input.stop) return { ok: false }; return { ok: true };"),
  "if (input.stop) return { ok: false }; return { ok: true }",
  "top-level return should remain an explicit script body",
);
assert.equal(
  wrapRunScriptSource("throw new Error('boom')"),
  "throw new Error('boom')",
  "top-level throw should remain an explicit script body",
);

[
  {
    name: "line comment before async arrow",
    code: "// purpose\nasync () => { return 1; }",
    out: "// purpose\nreturn await (async () => { return 1; })();",
  },
  {
    name: "line comment with CRLF before async arrow",
    code: "// purpose\r\nasync () => { return 2; }",
    out: "// purpose\r\nreturn await (async () => { return 2; })();",
  },
  {
    name: "block comment before async arrow",
    code: "/* purpose */ async () => { return 3; }",
    out: "/* purpose */\nreturn await (async () => { return 3; })();",
  },
  {
    name: "multiline block comment before sync arrow",
    code: "/*\n * purpose\n */\n() => ({ ok: true })",
    out: "/*\n * purpose\n */\nreturn await (() => ({ ok: true }))();",
  },
  {
    name: "multiple leading comments before function expression",
    code: "// purpose one\n/* purpose two */\nfunction main() { return 4; }",
    out: "// purpose one\n/* purpose two */\nreturn await (function main() { return 4; })();",
  },
  {
    name: "leading comments with fake IIFE tokens before callable",
    code: "// fake )();\n/* fake (() */\nasync () => { return 5; }",
    out: "// fake )();\n/* fake (() */\nreturn await (async () => { return 5; })();",
  },
  {
    name: "leading comment before async arrow IIFE",
    code: "// purpose\n(async () => { return 6; })();",
    out: "// purpose\nreturn await ((async () => { return 6; })());",
  },
  {
    name: "leading semicolon and comment before async arrow",
    code: "; // purpose\nasync () => { return 7; };",
    out: "// purpose\nreturn await (async () => { return 7; })();",
  },
  {
    name: "data crunching purpose comment before async arrow",
    code: "// Data regression: create a source table and insert 180+ rows with duplicate emails.\nasync () => {\n  return { ok: true };\n}",
    out: "// Data regression: create a source table and insert 180+ rows with duplicate emails.\nreturn await (async () => {\n  return { ok: true };\n})();",
  },
].forEach((item) => {
  assert.equal(wrapRunScriptSource(item.code), item.out, item.name);
});

const toolsSource = [
  readSource("../../src/background/tools/runtime.js"),
  readSource("../../src/capabilities/script/tools.js"),
].join("\n");
globalThis.chrome ||= {};
const { resolveToolDefinition } = await import("../../src/background/tools/runtime.js");
const runScriptDefinition = resolveToolDefinition("run_script");
const runSkillScriptDefinition = resolveToolDefinition("run_skill_script");
const { default: workbench } = await import("../../src/capabilities/skills/workbench.js");
const runScriptStart = toolsSource.indexOf('registerTool({\n  name: "run_script"');
const runScriptEnd = toolsSource.indexOf("\n});\n\nfunction scriptUsesToolApi", runScriptStart);
assert.ok(runScriptStart >= 0 && runScriptEnd > runScriptStart, "should find run_script tool block");
const runScriptToolBlock = toolsSource.slice(runScriptStart, runScriptEnd);
const runSkillScriptStart = toolsSource.indexOf('registerTool({\n  name: "run_skill_script"');
const runSkillScriptEnd = toolsSource.indexOf("\n});\n\nregisterTool({\n  name: \"run_script\"", runSkillScriptStart);
assert.ok(runSkillScriptStart >= 0 && runSkillScriptEnd > runSkillScriptStart, "should find run_skill_script tool block");
const runSkillScriptToolBlock = toolsSource.slice(runSkillScriptStart, runSkillScriptEnd);
assert.match(
  runScriptDefinition.description,
  /脚本开始处用一行注释简明说明：这个脚本在什么页面做什么事情，达到什么目的/,
  "run_script description should require a purpose comment at script start",
);
assert.match(
  runScriptDefinition.description,
  /async \(\) => \{\n  \/\/ 在当前列表页采集条目文本，形成 rows 摘要用于验证页面解析并支持后续落库。/,
  "run_script recommended skeleton should show the opening purpose comment",
);
assert.match(
  runScriptDefinition.parameters.properties.tabId.description,
  /本次调用的目标标签页 ID；省略时使用当前任务 workingTabId。/,
  "run_script tabId schema should document strict target policy",
);
assert.match(
  runScriptToolBlock,
  /target:\s*\{\s*type:\s*"string",\s*enum:\s*\["page",\s*"inner"\]/,
  "run_script should expose an explicit page/inner execution target",
);
assert.match(
  runScriptToolBlock,
  /executionTarget === "inner"[\s\S]*runScriptWithOffscreenInnerRunner/,
  "run_script should only use the inner runner when target is explicitly inner",
);
assert.match(
  runScriptToolBlock,
  /timeout:\s*SCRIPT_TIMEOUT_SECONDS_PROPERTY/,
  "run_script should expose the seconds-based script timeout property",
);
assert.match(
  runScriptToolBlock,
  /required:\s*\["timeout", "code"\]/,
  "run_script should require timeout so the agent chooses finite or infinite execution",
);
assert.match(
  runSkillScriptDefinition.description,
  /page 必须使用当前任务已拥有的网页 tab；inner 运行在轻舟内部 Worker，不需要网页 tab/,
  "run_skill_script description should distinguish page and inner target policy",
);
assert.match(
  runSkillScriptToolBlock,
  /required:\s*\["timeout", "skill", "script"\]/,
  "run_skill_script should require timeout so plugin tools use one timeout source",
);
assert.match(
  runSkillScriptDefinition.parameters.properties.tabId.description,
  /本次调用的目标标签页 ID；省略时使用当前任务 workingTabId。/,
  "run_skill_script tabId schema should document its working-tab default",
);
assert.match(
  runScriptDefinition.description,
  /target:"inner" 表示轻舟内部 offscreen 运行环境/,
  "run_script description should document explicit inner mode",
);
assert.match(
  runScriptDefinition.description,
  /target 不填或 target:"page" 表示页面模式，使用显式的当前任务拥有 tabId，或当前任务 workingTabId/,
  "run_script description should keep page tasks on page targets",
);
assert.match(
  runScriptDefinition.description,
  /不能用 getEventListeners、\$0、copy、monitorEvents/,
  "run_script description should warn against DevTools Console helpers",
);
assert.match(
  runScriptDefinition.description,
  /tools 是当前运行配置下可用工具的动态代理/,
  "run_script should explain that its tool surface follows the frozen run profile",
);
assert.match(
  runScriptDefinition.description,
  /不要用 Object\.keys\(tools\) 判断能力，诊断时使用 await tools\.\$list\(\)/,
  "run_script should give the model one reliable way to discover bridged tools",
);
assert.match(
  runScriptDefinition.description,
  /视觉序列先由主 Agent 单步观察[\s\S]*效果符合预期、后续坐标可预测且 viewportChange 表明浏览器视口稳定[\s\S]*串行 await tools\.act_on_screen[\s\S]*检查 coordinateBasisReady[\s\S]*按执行顺序返回最后一张此类图片/,
  "run_script should teach one evidence-based visual macro principle",
);
assert.match(
  runScriptDefinition.description,
  /调用 run_script 时设 mutatesPage:true/,
  "visual macros should declare their page mutation ownership",
);
assert.doesNotMatch(toolsSource, /会滚动、缩放、改尺寸.*逐步执行/, "run_script guidance should not overfit policy to action names");
assert.match(
  runScriptDefinition.description,
  /自动提升内部最后一次 screenshot 或 act_on_screen\(returnScreenshot:true\) 的图片/,
  "run_script summary guidance should explain last-observation promotion",
);
assert.match(
  toolsSource,
  /let __qzLastObservation = null/,
  "the page tool proxy should keep one ordered observation slot",
);
assert.match(
  toolsSource,
  /if \(response\.observation[\s\S]*__qzLastObservation = response\.observation/,
  "each successful observation should overwrite the previous value in execution order",
);
assert.match(
  toolsSource,
  /out\.__lastObservation = __qzSafeValueForMessage\(__qzLastObservation\)/,
  "the controlled envelope should carry only the last observation",
);
assert.match(
  toolsSource,
  /normalizeRunScriptObservation\(out\.__lastObservation\)[\s\S]*delete out\.__lastObservation[\s\S]*\.\.\.lastObservation/,
  "the outer run_script result should promote and hide the last observation",
);
assert.doesNotMatch(toolsSource, /captureRunScriptScreenFeedback|finalizeRunScriptScreenFeedback|__qzScreenActionUsed/, "run_script must not retain hidden final-capture machinery");
assert.doesNotMatch(
  toolsSource,
  /out\.result[\s\S]{0,180}typeof out\.result\._image/,
  "run_script must not infer visual execution by inspecting the script return shape",
);
assert.match(
  toolsSource,
  /geteventlisteners\|\\\$0\|monitorevents\|copy is not defined/i,
  "run_script diagnostics should classify DevTools helpers as wrong runtime",
);
assert.match(
  workbench.content,
  /\`runtime:"page"\` 只在当前任务 workingTabId 或显式传入的自有 tabId 上执行；\`runtime:"inner"\` 在无 DOM 的 Worker 中执行，不需要 tab/,
  "skill author script conventions should distinguish page and inner tab prerequisites",
);
assert.match(
  workbench.content,
  /与页面无关、需要自身设置或网络 API 的脚本使用 \`runtime:"inner"\`/,
  "skill author high-level rules should route non-page plugin tools to inner runtime",
);
assert.doesNotMatch(
  runScriptDefinition.description,
  /get_ax_tree\/read_article 等页面工具建立当前任务的工作标签页/,
  "run_script target error examples should not suggest read-only tools create working tabs",
);
assert.doesNotMatch(
  runScriptDefinition.description,
  /用户(?:明确)?说[“「]?当前页面/,
  "run_script should rely on the kernel page-language contract instead of restating it",
);
assert.match(
  runScriptToolBlock,
  /resolvedTabId = resolveRunScriptTargetTabId\(tabId, context\)/,
  "run_script page branch should resolve targets through the strict target helper",
);
await assertScriptTargetPreflight();

async function assertScriptTargetPreflight() {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { getURL: path => path },
    storage: { local: { async get() { return {}; } } },
    tabs: { async query() { throw new Error("Scripts must never fall back to the active tab"); } },
  };
  try {
    const { createToolRuntime } = await import("../../src/background/tools/runtime.js");
    const resolutions = [];
    const runtime = createToolRuntime({ sessions: { async resolveTargetTab(input) {
      resolutions.push(input);
      return { ok: false, code: "SESSION_TAB_FOREIGN", ownerSessionId: "other-session" };
    } } });
    const context = { sessionId: "script-session", runId: "script-run" };
    for (const [name, input] of [
      ["run_script", { code: "42" }],
      ["run_skill_script", { skill: "fixture", script: "scripts/test.js" }],
    ]) {
      const controller = new AbortController();
      controller.abort();
      const before = resolutions.length;
      // Cancellation stops the real handler before creating a Worker or loading a Skill.
      // Reaching it without a tab proves the registered inner policy skips page preflight.
      await assert.rejects(runtime.execute(name, { ...input, timeout: 0, target: "inner" }, controller.signal, context), { code: "OPERATION_ABORTED" });
      assert.equal(resolutions.length, before, `${name} inner mode must not resolve a page`);
      await assert.rejects(runtime.execute(name, { ...input, timeout: 0, target: "page" }, undefined, context), { code: "SESSION_TAB_TARGET_REQUIRED" });
      for (const target of [undefined, "page"]) {
        await assert.rejects(runtime.execute(name, { ...input, timeout: 0, ...(target ? { target, tabId: 8 } : {}) }, undefined,
          { ...context, workingTabId: 7 }), { code: "SESSION_TAB_FOREIGN" });
        const resolved = resolutions.at(-1);
        assert.equal(resolved.tabId, target ? 8 : 7, `${name} uses only its explicit or session working tab`);
        assert.equal(resolved.sessionId, context.sessionId);
        assert.equal(resolved.runId, context.runId);
        assert.equal(resolved.readOnly, false);
      }
    }
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}
assert.match(
  toolsSource,
  /timeout: scriptTimeout,/,
  "run_script and run_skill_script should convert the required seconds timeout in one place",
);
assert.match(
  toolsSource,
  /timeout: isSkillPageScriptTool\(entry\.tool\) \? 0/,
  "page plugin tools should not add an outer timeout around run_skill_script",
);
assert.match(
  toolsSource,
  /isSkillScriptTool\(entry\.tool\) \? scriptTimeout/,
  "host plugin script tools should use the same required seconds timeout",
);
assert.doesNotMatch(
  toolsSource,
  /__qzBridgeTimeout|const bridgeTimeout/,
  "page bridge delegates timeout ownership to the actual tool execution layer",
);
const { scriptTimeout } = await import("../../src/background/tools/timing.js");
assert.equal(scriptTimeout({ timeout: 0 }, "run_script"), 0);
assert.equal(scriptTimeout({ timeout: -1 }, "run_script"), 0);
assert.equal(scriptTimeout({ timeout: 1.25 }, "run_script"), 1250);
assert.throws(() => scriptTimeout({ timeout: "invalid" }, "run_script"), error => error.code === "INVALID_TIMEOUT");
assert.doesNotMatch(
  runScriptToolBlock,
  /getActiveTabId\(\)/,
  "run_script should not fall back to the active browser tab",
);
assert.match(
  toolsSource,
  /RUN_SCRIPT_TARGET_TAB_REQUIRED/,
  "run_script strict target failure should have a structured error code",
);
assert.match(
  toolsSource,
  /run_script_inner_execute/,
  "run_script inner runner should call the offscreen document explicitly",
);

console.log(`ok ${cases.length} run-script source shape cases + callable/wrapper checks`);

function readSource(path) {
  const source = new URL(path, import.meta.url);
  return readFileSync(existsSync(source) ? source : new URL(path.replace(/\.js$/, ".ts"), import.meta.url), "utf8");
}

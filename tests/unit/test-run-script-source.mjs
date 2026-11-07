import assert from "node:assert/strict";
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

globalThis.chrome ||= {};
globalThis.chrome.i18n = { getUILanguage: () => "zh-CN" };
const { resolveToolDefinition, createToolRuntime } = await import("../../src/background/tools/runtime.js");
const outer = resolveToolDefinition("run_script"), page = resolveToolDefinition("evaluate");
const privateSkill = resolveToolDefinition("run_skill_script");
assert.equal(outer.page, false);
assert.deepEqual(outer.parameters.required, ["code"]);
for (const key of ["tabRef", "tabId", "target", "scope", "mutatesPage"]) {
  assert.equal(Object.hasOwn(outer.parameters.properties, key), false, `outer scripts have no ${key} page axis`);
}
assert.deepEqual(page.parameters.required, ["tabRef", "code"]);
assert.equal(page.page, "owned");
assert.equal(privateSkill.hidden, true);
assert.deepEqual(privateSkill.parameters.required, ["timeout", "skill", "script"]);
for (const code of ['() => 42', 'async value => value', 'function task(value) { return value; }']) page.validateArgs({ code });
for (const code of ['42', 'return args.value', '(() => 42)()', 'fetch("https://example.test")']) {
  assert.throws(() => page.validateArgs({ code }), { code: "INVALID_SCRIPT_FUNCTION" });
}
assert.throws(() => outer.validateArgs({ code: 'return 42', tabRef: 8 }), { code: "INVALID_RUN_SCRIPT_INPUT" });

const previousChrome = globalThis.chrome;
globalThis.chrome = {
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; } } },
  tabs: { async query() { throw new Error("Scripts must never fall back to the active tab"); } },
};
try {
  const resolutions = [];
  const runtime = createToolRuntime({ sessions: { async resolveTargetTab(input) {
    resolutions.push(input);
    return { ok: false, code: "SESSION_TAB_FOREIGN", ownerSessionId: "other-session" };
  } } });
  const context = { sessionId: "script-session", runId: "script-run", workingTabId: 7 };
  for (const [name, input] of [
    ["run_script", { code: "return 42" }],
    ["run_skill_script", { skill: "fixture", script: "scripts/test.js", target: "inner" }],
  ]) {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runtime.execute(name, { ...input, timeout: 0 }, controller.signal, context), { code: "OPERATION_ABORTED" });
    assert.equal(resolutions.length, 0, `${name} does not inspect a page`);
  }
  await assert.rejects(runtime.execute("run_script", { code: "return 42", tabRef: 8 }, undefined, context), { code: "INVALID_RUN_SCRIPT_INPUT" });
  await assert.rejects(runtime.execute("evaluate", { code: "return 42", tabRef: 8 }, undefined, context), { code: "INVALID_SCRIPT_FUNCTION" });
  assert.equal(resolutions.length, 0, "invalid public scripts cannot claim a tab");
  await assert.rejects(runtime.execute("evaluate", { code: "() => 42" }, undefined, context), { code: "TAB_REF_REQUIRED" });
  await assert.rejects(runtime.execute("run_skill_script", { skill: "fixture", script: "scripts/test.js", timeout: 0 }, undefined, context), { code: "TAB_REF_REQUIRED" });
  for (const [name, input] of [
    ["evaluate", { code: "() => 42" }],
    ["run_skill_script", { skill: "fixture", script: "scripts/test.js", timeout: 0 }],
  ]) {
    await assert.rejects(runtime.execute(name, { ...input, tabRef: 8 }, undefined, context), { code: "SESSION_TAB_FOREIGN" });
    const resolved = resolutions.at(-1);
    assert.equal(resolved.tabId, 8);
    assert.equal(resolved.sessionId, context.sessionId);
    assert.equal(resolved.runId, context.runId);
    assert.equal(resolved.readOnly, false);
  }
} finally { globalThis.chrome = previousChrome; }
const { scriptTimeout } = await import("../../src/background/tools/timing.js");
assert.equal(scriptTimeout({ timeout: 0 }, "run_script"), 0);
assert.equal(scriptTimeout({ timeout: -1 }, "run_script"), 0);
assert.equal(scriptTimeout({ timeout: 1.25 }, "run_script"), 1250);
assert.throws(() => scriptTimeout({ timeout: "invalid" }, "run_script"), { code: "INVALID_TIMEOUT" });
console.log(`ok ${cases.length} source normalization cases + actual public/private script contracts`);

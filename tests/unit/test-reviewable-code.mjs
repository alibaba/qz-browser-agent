import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minify } from "terser";
import { buildExtension } from "../../scripts/build-extension.mjs";
import { auditReviewableCode, inspectJavaScript, assertReviewableCode } from "../../scripts/check-reviewable-code.mjs";

const failures = source => inspectJavaScript(source).findings.filter(item => !item.reviewed);
for (const source of [
  'eval("code")', '(0, globalThis.eval)("code")', 'new Function("input", "return input")',
  'const F = Function; new F("return 1");', 'setTimeout("runRemoteLogic()", 10);',
  'send("Runtime.evaluate", { expression: remoteCode });',
  'send(target, "Runtime." + "callFunctionOn", { functionDeclaration: remoteCode });',
  'evaluateCdpScript(tabId, { expression: remoteCode });',
  'const lt = "<", tag = "script"; const html = `${lt}${tag}>${payload}</script>`;',
  'import("https://unknown.example/engine.mjs")', 'import(remoteUrl)',
  'importScripts("https://unknown.example/code.js")', 'new Worker(remoteUrl)',
  'const node = document.createElement("script"); node.src = remoteUrl;',
  'const LT = "<", SCRIPT = "script", GT = ">"; const markup = LT + SCRIPT + GT + content + LT + "/" + SCRIPT + GT;',
  'const markup = "<" + "scr" + "ipt>" + content + "</script>";',
  'var LT="<", SCRIPT="script", GT=">"; function tag(content){return LT+SCRIPT+GT+content+LT+"/"+SCRIPT+GT} function parseNumber(){const GT=62;return GT}',
  'const F=Function; new F("return 1"); function local(){const F=42;return F}',
  'const _0xa33 = ["hidden", "behavior"];',
]) assert.ok(failures(source).length, source);

// Audit the real production pipeline, including product overrides and embedded
// scripts. A standalone TS transform does not produce the shipped fingerprints.
const buildRoot = await mkdtemp(join(tmpdir(), 'qz-review-build-'));
const cdpFindings = (code, file) => inspectJavaScript(code, file).findings.filter(item => item.rule === 'cdp-execution');
try {
  for (const [browser, bundle] of [['chrome', false], ['chrome', true], ['firefox', true]]) {
    const outputDir = join(buildRoot, `${browser}-${bundle ? 'bundled' : 'unbundled'}`);
    await buildExtension({ mode: 'production', bundle, browser, outputDir });
    const findings = (await auditReviewableCode(outputDir)).flatMap(item => item.findings);
    assert.ok(findings.length > 0);
    assert.deepEqual(findings.filter(item => !item.reviewed), []);

    // Parent-call identity is data, not source. Changing its origin, adding a
    // sink, or moving the code outside its reviewed output path requires review.
    const scriptPath = bundle ? 'background/service-worker.js' : 'capabilities/script/tools.js';
    const scriptCode = await readFile(join(outputDir, scriptPath), 'utf8');
    const scriptFindings = cdpFindings(scriptCode, scriptPath);
    assert.equal(scriptFindings.length, bundle ? 10 : 3);
    assert.ok(scriptFindings.every(item => item.reviewed));
    assert.ok(cdpFindings(scriptCode, 'unrelated.js').every(item => !item.reviewed));
    const mutatedScriptCode = scriptCode.replaceAll('context.toolExecutionId || ""', 'pageControlledParent');
    assert.notEqual(mutatedScriptCode, scriptCode);
    assert.equal(cdpFindings(mutatedScriptCode, scriptPath).filter(item => !item.reviewed).length, 2);
    assert.equal(cdpFindings(`${scriptCode}\nevaluateCdpScript(tabId, { expression: remoteCode });`, scriptPath).filter(item => !item.reviewed).length, 1);

    if (!bundle) {
      // The disabled-option repair is a fixed node predicate, not a general execution exemption.
      const axPath = 'capabilities/accessibility/tools.js';
      const axCode = await readFile(join(outputDir, axPath), 'utf8');
      assert.equal(cdpFindings(axCode, axPath).length, 1);
      assert.ok(cdpFindings(axCode, axPath)[0].reviewed);
      assert.ok(cdpFindings(axCode, 'background/service-worker.js')[0].reviewed);
      assert.equal(cdpFindings(axCode, 'unrelated.js')[0].reviewed, undefined);
      const mutatedAxCode = axCode.replace("this.matches(':disabled')", "this.matches(pageControlledSelector)");
      assert.notEqual(mutatedAxCode, axCode);
      assert.equal(cdpFindings(mutatedAxCode, axPath)[0].reviewed, undefined);
      assert.equal(cdpFindings(`${axCode}\nsend('Runtime.callFunctionOn', { functionDeclaration: remoteCode });`, axPath).filter(item => !item.reviewed).length, 1);
    }
  }
} finally { await rm(buildRoot, { recursive: true, force: true }); }

// Real rejected upstream inputs, including the worker's unrelated local numeric GT binding.
for (const file of ["pdf.mjs", "pdf.worker.mjs"]) {
  const source = await readFile(new URL(import.meta.resolve(`pdfjs-dist/legacy/build/${file}`)), "utf8");
  assert.ok(failures(source).some(item => item.rule === "script-tag"), `${file}: actual legacy script concatenation`);
}

const original = Array.from({ length: 120 }, (_, index) => `function readableAction${index}(inputValue) { const selectedValue = inputValue + ${index}; return selectedValue * 2; }`).join("\n");
const packed = await minify(original, { compress: false, mangle: { toplevel: true }, format: { comments: false } });
assert.ok(failures(packed.code).some(item => item.rule === "readability"));
assert.ok(failures(`const payload = ${JSON.stringify(`(() => {${packed.code}})();`)};`).some(item => item.file.includes("#embedded-")));
assert.equal(failures('export const meaningOfLife = 42;\n').length, 0);
assert.equal(failures('import { localFeature } from "./local-feature.js";\n').length, 0);
assert.equal(failures(`const unicodeTable = [${Array.from({ length: 5000 }, (_, index) => index).join(",")}];`).length, 0,
  "long numeric data is not minified executable logic");

const root = await mkdtemp(join(tmpdir(), "qz-review-code-"));
try {
  await mkdir(join(root, "vendor"));
  await writeFile(join(root, "vendor/engine.mjs"), "export const engineVersion = 1;\n");
  const audit = await assertReviewableCode(root);
  assert.equal(audit.length, 1);
  assert.match(audit[0].sha256, /^[a-f0-9]{64}$/);
  await writeFile(join(root, "vendor/new.min.js"), "const readable = true;\n");
  await assert.rejects(assertReviewableCode(root), /readability/);
  await rm(join(root, "vendor/new.min.js"));
  await writeFile(join(root, "vendor/engine.mjs"), 'const source = "<script>" + remoteCode + "</script>";');
  await assert.rejects(assertReviewableCode(root), /script-tag/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("reviewable-code guard regressions passed");

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
  'browser.userScripts.execute({ target, js: [{ code: remoteCode }] });',
  'host["userScripts"]["execute"]({ target, js: [{ code: remoteCode }] });',
  'const scripts = browser.userScripts; scripts.execute({ target, js: [{ code: remoteCode }] });',
  'const run = browser.userScripts.execute; run({ target, js: [{ code: remoteCode }] });',
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

// Large readable bundles must not exceed the engine's argument-count limit.
const largeSource = ';\n'.repeat(150000) + 'globalThis.reviewed = 42;\n';
assert.deepEqual(inspectJavaScript(largeSource), {
  findings: [],
  metrics: { bytes: Buffer.byteLength(largeSource), lines: 150002,
    maxLine: 25, maxCodeTokens: 6, maxStatements: 1,
    bindings: 0, shortBindings: 0, embeddedScripts: 0 },
});

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
    const nativeFindings = findings.filter(item => item.rule === 'user-script-execution');
    assert.equal(nativeFindings.length, browser === 'firefox' ? 1 : 0, 'native page compilation is Firefox-only');
    if (browser === 'firefox') {
      const nativePath = 'background/firefox/page-evaluation.js';
      const nativeCode = await readFile(join(outputDir, nativePath), 'utf8');
      const inspectNative = (code, path = nativePath) => inspectJavaScript(code, path).findings.filter(item => item.rule === 'user-script-execution');
      assert.ok(inspectNative(nativeCode)[0].reviewed);
      assert.equal(inspectNative(nativeCode, 'background/service-worker.js')[0].reviewed, undefined);
      const unpinned = nativeCode.replace('documentIds: [document.documentId]', 'frameIds: [frameId]');
      assert.notEqual(unpinned, nativeCode);
      assert.equal(inspectNative(unpinned)[0].reviewed, undefined, 'changing document identity requires review');
      const changedWrapper = nativeCode.replace(/await evaluate\d*\.call\(globalThis\)/u, 'await pageControlledFunction()');
      assert.notEqual(changedWrapper, nativeCode);
      assert.equal(inspectNative(changedWrapper)[0].reviewed, undefined, 'the serialized helper is covered by the sink fingerprint');
      assert.equal(inspectNative(`${nativeCode}\nhost.userScripts.execute({target,js:[{code:remoteCode}]});`).filter(item => !item.reviewed).length, 1);
    }

    // Parent-call identity is data, not source. Changing its origin, adding a
    // sink, or moving the code outside its reviewed output path requires review.
    const scriptPath = bundle ? 'background/service-worker.js' : 'capabilities/script/tools.js';
    const scriptCode = await readFile(join(outputDir, scriptPath), 'utf8');
    const scriptFindings = cdpFindings(scriptCode, scriptPath);
    assert.equal(scriptFindings.length, bundle ? 12 : 2);
    assert.ok(scriptFindings.every(item => item.reviewed));
    assert.ok(cdpFindings(scriptCode, 'unrelated.js').every(item => !item.reviewed));
    const mutatedScriptCode = scriptCode.replaceAll('context.toolExecutionId || ""', 'pageControlledParent');
    assert.notEqual(mutatedScriptCode, scriptCode);
    assert.equal(cdpFindings(mutatedScriptCode, scriptPath).filter(item => !item.reviewed).length, 2);
    const implicitTarget = scriptCode.replaceAll(/const resolvedTabId(\d*) = resolveRunScriptTargetTabId(\d*)\(tabId\d*\);/gu,
      'const resolvedTabId$1 = resolveRunScriptTargetTabId$2(context.workingTabId);');
    assert.notEqual(implicitTarget, scriptCode);
    const implicitTargetFindings = inspectJavaScript(implicitTarget, scriptPath).findings;
    assert.equal(implicitTargetFindings.some(item => item.rule === 'syntax'), false);
    assert.equal(implicitTargetFindings.filter(item => item.rule === 'cdp-execution' && !item.reviewed).length, 1,
      'introducing an implicit page target requires a new factory review');
    assert.equal(cdpFindings(`${scriptCode}\nevaluateCdpScript(tabId, { expression: remoteCode });`, scriptPath).filter(item => !item.reviewed).length, 1);

    if (!bundle) {
      const elementPath = 'background/tools/element-runtime.js';
      const elementCode = await readFile(join(outputDir, elementPath), 'utf8');
      const changedSerialization = elementCode.replace('function() { return this; }', 'function() { return pageControlledNodes; }');
      assert.notEqual(changedSerialization, elementCode);
      assert.equal(cdpFindings(changedSerialization, elementPath).filter(item => !item.reviewed).length, 2,
        'the static identity serialization and original token bridge share a reviewed enclosing function');
      // The disabled-option repair is a fixed node predicate, not a general execution exemption.
      const axPath = 'capabilities/accessibility/tools.js';
      const axCode = await readFile(join(outputDir, axPath), 'utf8');
      assert.equal(cdpFindings(axCode, axPath).length, 2);
      assert.ok(cdpFindings(axCode, axPath)[0].reviewed);
      assert.ok(cdpFindings(axCode, 'background/service-worker.js')[0].reviewed);
      assert.equal(cdpFindings(axCode, 'unrelated.js')[0].reviewed, undefined);
      const mutatedAxCode = axCode.replace("element.matches(':disabled')", "element.matches(pageControlledSelector)");
      assert.notEqual(mutatedAxCode, axCode);
      assert.equal(cdpFindings(mutatedAxCode, axPath).filter(item => !item.reviewed).length, 2);
      const staleDocument = axCode.replace('this.defaultView.document === this', 'true');
      assert.notEqual(staleDocument, axCode);
      assert.equal(cdpFindings(staleDocument, axPath).filter(item => !item.reviewed).length, 2, 'document revalidation belongs to the reviewed function');
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

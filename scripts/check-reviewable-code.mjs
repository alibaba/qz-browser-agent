#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, tokenizer } from "acorn";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const scriptExtensions = new Set([".js", ".mjs", ".cjs"]);

// Exact AST-token fingerprints, not file-wide exemptions. Every accepted executable sink
// is documented in docs/store-code-audit.md. Changing one requires explicit review.
const REVIEWED = new Map([
  ["script-tag:2f44707acff77728876a3e3806c8d0d6951d7940e55cad7b0c56607ccf9f165c", {
    files: /^(?:background\/service-worker|sidepanel\/(?:chunk-[\w.-]+|features\/export\/session-export-feature)|shared\/session\/session-exchange)\.js$/u,
    reason: "Escaped session JSON in an inert application/json element (renderSessionExchangeScript).",
  }],
  ["script-tag:2c8330e12bfa9b63027205ff658c84f742ddf0d06b00186f6dcda2347b1e81cc", {
    files: /^sidepanel\/(?:chunk-[\w.-]+|features\/export\/session-export-feature)\.js$/u,
    reason: "Offline HTML export embeds the audited, build-time session-export-runtime plus escaped messages.",
  }],
  ...["script-element", "script-source"].map(rule => [`${rule}:79e44d48ea4e59b324db7168311be6d60d40d86f8e1e63255e864b63d9f34a0b`, {
    files: /^sidepanel\/(?:chunk-[\w.-]+|features\/chat\/math-runtime)\.js$/u,
    reason: "loadMathRuntime loads only packaged vendor/mathjax/startup.js, with a local test-server fallback.",
  }]),
  ["dynamic-code:4257df8c31520a5d7340e3b17e0186dba6dbb7e359bb6b7a83f57be5ac518dae", {
    files: /^(?:runner-sandbox\.js#embedded-1|\.qingzhou-debug\/embedded\/workers\/inner-runner\.js)$/u,
    reason: "Existing user/Agent script executor in an isolated sandbox Worker; no extension APIs. See policy risk in the audit guide.",
  }],
  ["dynamic-code:9320e0271a5fb141f43cdc676a62a81b330b57d7b32cd48f5974aeadb62435d2", {
    files: /^background\/(?:firefox\/page-command|service-worker)\.js$/u,
    reason: "Firefox-only emulation of CDP Runtime.callFunctionOn for the reviewed CDP callers, including explicit user/Agent page scripts. Compiles in the page realm only, never the isolated world or extension context.",
  }],
  ["worker-source:890f3c5dc5be580fe67f809f64e6fe9556b44894fdd87172868660fa83fcd795", {
    files: /^runner-sandbox\.js$/u,
    reason: "startWorkerRun creates a Blob Worker from the packaged, recursively audited inner-runner only.",
  }],
  ...[
    ["33445b4d16f8797c82850bf05d48c497e57dc488270f9c4756edb8a2ffe89e28", "background/tools/cdp-runtime", "Run-owned CDP evaluator with cancellation and stale-owner checks; existing page-script capability."],
    ["3e11705ca0c9ddb62d92e242771769301b481d4c3349267a5132318e07e6763a", "capabilities/media/tools", "Calls only the packaged bounds function on a resolved page element."],
    ["fd33ba99589746223f976d8fefb913d8fb665001c4f72964dc50b7609f7081a3", "capabilities/script/tools", "Page-script tool bridge carries Session/run identity and arguments to the run-owned evaluator."],
    ["d8437ba77796cdef3249f94639760a4ef2dcaa0f15b306c69909725881b748bb", "capabilities/script/tools", "Existing explicit-return page-script fallback uses the same run-owned evaluator."],
    ["2262d3ad0ea465f9ac9f74cece546f998cf578252c960a95aa886f2799d2f62f", "capabilities/tabs/page-mode", "Evaluates only the literal navigator.userAgent for mobile emulation."],
    ["65929b0848c416804606d4a12b3715bc690342f7fccb678df2249009ec383e36", "capabilities/script/tools", "Entire createScriptTools factory with product-specific offscreen error text. Same explicit user/Agent page-script capability. Policy risk remains."],
    ["e1026a3accc9f907512ec6d6eeed9728cfbd86b130ad009452f3bee13803b70c", "background/tools/element-runtime", "Isolated-world probe using the packaged ISOLATED_CONTENT_PROBE constant from isolated-page-calls; validates live context identity."],
    ["c56fb6154c392cf8fece033fcc496139904617749a4fb93acae372347b20b1fd", "background/tools/element-runtime", "Calls the packaged ISOLATED_CONTENT_INVOKE bridge constant; action parameters are passed as CDP values, not code."],
  ].map(([digest, module, reason]) => [`cdp-execution:${digest}`, {
    files: new RegExp(`^(?:background/service-worker|${module})\\.js$`, "u"), reason,
  }]),
  // The unbundled forms differ only in esbuild's expansion of shorthand properties after renaming.
  // Bundling now renames inside page-mode apply as well, so its bundled form needs its own entry.
  ["cdp-execution:a2d915a9cb4666b2a6a1935a8b6597702edbe8a3e04b7f2da4a20a421b0410f8", {
    files: /^background\/tools\/element-runtime\.js$/u,
    reason: "Unbundled invokeBound: same ISOLATED_CONTENT_INVOKE bridge constant and value arguments as the bundled reviewed function.",
  }],
  ["cdp-execution:f3b1d7fbbdc9be7986c55c8a3a1989d231c1a3e2fcb18fc8d8ac5415d1d994d0", {
    files: /^capabilities\/script\/tools\.js$/u,
    reason: "Unbundled createScriptTools: same reviewed page-script factory, without bundled shorthand expansion.",
  }],
  ["cdp-execution:fd8e4ae64e94143af4a077d5318fd519eaea39ed16675c93875a993e21dc73c3", {
    files: /^background\/service-worker\.js$/u,
    reason: "Bundled page-mode apply: same literal navigator.userAgent evaluation, with esbuild shorthand expansion after renaming.",
  }],
]);

function fingerprint(source) {
  return sha256(JSON.stringify([...tokenizer(source, { ecmaVersion: "latest" })].map(token => [
    token.type.label,
    token.type.label === "name" ? token.value.replace(/\d+$/u, "") : token.value,
  ])));
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, [...ancestors, node]));
    else if (value && typeof value === "object") walk(value, visit, [...ancestors, node]);
  }
}

/** Static heuristics supplement (not replace) source provenance and browser network tests. */
export function inspectJavaScript(source, file = "input.js", depth = 0) {
  const findings = [];
  const tokens = [];
  const comments = [];
  let ast;
  try { ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, onToken: tokens, onComment: comments }); }
  catch (error) { return { findings: [{ rule: "syntax", file, line: error.loc?.line, detail: error.message }], metrics: {} }; }
  const add = (rule, node, detail, ancestors = []) => {
    const owner = ancestors.findLast(parent => parent.type === "FunctionDeclaration");
    const reviewedNode = owner || node;
    const text = source.slice(reviewedNode.start, reviewedNode.end);
    const digest = fingerprint(text);
    const entry = REVIEWED.get(`${rule}:${digest}`);
    const reviewed = entry?.files.test(file) ? entry.reason : undefined;
    findings.push({ rule, file, line: node.loc.start.line, detail, fingerprint: digest, ...(reviewed ? { reviewed } : {}) });
  };
  const bindings = new Map();
  const scriptVariables = new Set();
  const dataRanges = [];
  function isData(node) {
    return node?.type === "Literal" || node?.type === "UnaryExpression" && ["-", "+"].includes(node.operator) && isData(node.argument) ||
      node?.type === "ArrayExpression" && node.elements.every(value => value === null || isData(value)) ||
      node?.type === "ObjectExpression" && node.properties.every(value => value.type === "Property" && !value.computed && isData(value.value));
  }
  walk(ast, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const blockScoped = ancestors.at(-1)?.kind !== "var";
      const scope = ancestors.findLast(parent => /^(?:Program|FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(parent.type) ||
        blockScoped && /^(?:BlockStatement|ForStatement|ForOfStatement|ForInStatement|SwitchStatement|CatchClause)$/u.test(parent.type)) || ast;
      const entries = bindings.get(node.id.name) || [];
      entries.push({ value: node.init, scope });
      bindings.set(node.id.name, entries);
    }
    if (["ArrayExpression", "ObjectExpression"].includes(node.type) && node.start >= (dataRanges.at(-1)?.end || 0) && isData(node)) dataRanges.push(node);
    if (node.type === "CallExpression" && node.callee.property?.name === "createElement" && node.arguments[0]?.value === "script") {
      const parent = ancestors.at(-1);
      const target = parent?.type === "VariableDeclarator" ? parent.id : parent?.type === "AssignmentExpression" ? parent.left : null;
      if (target?.type === "Identifier") scriptVariables.add(target.name);
    }
  });
  // A later local GT (PDF's numeric parser) must not hide core-js's outer GT = ">".
  function bindingValue(node) {
    const visible = (bindings.get(node.name) || []).filter(entry => entry.scope.start <= node.start && entry.scope.end >= node.end);
    visible.sort((a, b) => (a.scope.end - a.scope.start) - (b.scope.end - b.scope.start));
    return visible[0]?.value;
  }
  function staticText(node, seen = new Set()) {
    if (!node || seen.has(node)) return "";
    seen = new Set([...seen, node]);
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "Identifier") return staticText(bindingValue(node), seen);
    if (node.type === "BinaryExpression" && node.operator === "+") return staticText(node.left, seen) + staticText(node.right, seen);
    if (node.type === "TemplateLiteral") return node.quasis.map((part, index) => (part.value.cooked ?? part.value.raw) + staticText(node.expressions[index], seen)).join("");
    return "";
  }
  function codeCallee(node, seen = new Set()) {
    if (!node || seen.has(node)) return "";
    seen.add(node);
    if (node.type === "SequenceExpression") return codeCallee(node.expressions.at(-1), seen);
    if (node.type === "MemberExpression") return node.property.name || node.property.value || "";
    if (node.type === "Identifier") return /^(?:eval|Function|AsyncFunction)$/u.test(node.name) ? node.name : codeCallee(bindingValue(node), seen) || node.name;
    return "";
  }
  let shortBindings = 0;
  for (const name of bindings.keys()) if (/^[a-zA-Z_$]{1,2}$/u.test(name)) shortBindings++;
  const statementsByLine = new Map();
  const embedded = new Set();
  walk(ast, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (/Statement$|Declaration$/u.test(node.type) && node.type !== "BlockStatement") {
      const line = node.loc.start.line;
      statementsByLine.set(line, (statementsByLine.get(line) || 0) + 1);
    }
    if (node.type === "Identifier" && /^_0x[\da-f]+$/iu.test(node.name)) add("obfuscated-name", node, node.name, ancestors);
    if ((node.type === "CallExpression" || node.type === "NewExpression") &&
        /^(?:eval|Function|AsyncFunction)$/u.test(codeCallee(node.callee))) {
      add("dynamic-code", node, "JavaScript string compilation", ancestors);
    }
    if (node.type === "CallExpression" && /^(?:setTimeout|setInterval)$/u.test(codeCallee(node.callee)) && staticText(node.arguments[0])) {
      add("dynamic-code", node, "string timer execution", ancestors);
    }
    if (node.type === "CallExpression" && (node.arguments.some(argument => /^Runtime\.(?:evaluate|compileScript|runScript|callFunctionOn)$/u.test(staticText(argument))) ||
        /^evaluateCdpScript\d*$/u.test(node.callee.name || node.callee.property?.name || ""))) {
      add("cdp-execution", node, "CDP JavaScript execution needs source and target review", ancestors);
    }
    if (node.type === "ImportExpression" || node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" && node.source) {
      const target = node.source;
      if (target?.type !== "Literal" || typeof target.value !== "string" || !/^\.{1,2}\//u.test(target.value)) {
        add("code-url", node, "imports must name packaged relative modules", ancestors);
      }
    }
    if ((node.type === "CallExpression" || node.type === "NewExpression") &&
        /^(?:importScripts|Worker|SharedWorker)$/u.test(node.callee.name || "")) {
      add("worker-source", node, "Worker/script source needs review", ancestors);
    }
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression" &&
        /^(?:src|text|textContent|innerHTML)$/u.test(node.left.property.name || node.left.property.value || "") &&
        (scriptVariables.has(node.left.object.name) || /^(?:script|scriptElement)\d*$/iu.test(node.left.object.name || ""))) {
      add("script-source", node, "script element assignment needs review", ancestors);
    }
    // Catch both literal tags and core-js-style LT + SCRIPT + GT constructions.
    if (["BinaryExpression", "TemplateLiteral", "Literal"].includes(node.type) &&
        !(parent?.type === "BinaryExpression" && parent.operator === "+") &&
        /<script(?:\s|>)/iu.test(staticText(node))) {
      add("script-tag", node, "script markup needs review", ancestors);
    }
    if (node.type === "CallExpression" && node.callee.property?.name === "createElement" && staticText(node.arguments[0]).toLowerCase() === "script") {
      add("script-element", node, "script element creation needs review", ancestors);
    }
    // Inspect compiled source embedded as a string, not just the readable host around it.
    if (depth < 3 && (node.type === "Literal" && typeof node.value === "string" || node.type === "TemplateLiteral" && !node.expressions.length)) {
      const text = staticText(node);
      if (text.length > 80 && /^(?:\s*\(\(\) =>|\s*(?:var|let|const) QZ_)/u.test(text) && !embedded.has(text)) {
        embedded.add(text);
        findings.push(...inspectJavaScript(text, `${file}#embedded-${embedded.size}`, depth + 1).findings);
      }
    }
  });
  const codeTokensByLine = new Map();
  let dataIndex = 0;
  for (const token of tokens) {
    while (dataRanges[dataIndex]?.end <= token.start) dataIndex++;
    if (["string", "regexp", "template"].includes(token.type.label) || token.start >= dataRanges[dataIndex]?.start && token.end <= dataRanges[dataIndex]?.end) continue;
    const line = token.loc.start.line;
    codeTokensByLine.set(line, (codeTokensByLine.get(line) || 0) + 1);
  }
  const maxStatements = Math.max(0, ...statementsByLine.values());
  const maxCodeTokens = Math.max(0, ...codeTokensByLine.values());
  const metrics = { bytes: Buffer.byteLength(source), lines: source.split("\n").length,
    maxLine: Math.max(...source.split("\n").map(line => line.length)), maxCodeTokens, maxStatements,
    bindings: bindings.size, shortBindings, embeddedScripts: embedded.size };
  if (/\.min\.(?:m?js|cjs)(?:$|#)/iu.test(file) || maxStatements > 12 || maxCodeTokens > 1200 ||
      bindings.size > 80 && shortBindings / bindings.size > 0.6) {
    findings.push({ rule: "readability", file, line: 1, detail: JSON.stringify(metrics) });
  }
  if (/\b\d+:\s*function\s*\([a-z](?:,[a-z]){1,3}\)/u.test(source)) {
    findings.push({ rule: "webpack-minified", file, line: 1, detail: "numeric module table with mangled parameters" });
  }
  return { metrics, findings };
}

export async function auditReviewableCode(directory) {
  const root = resolve(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in extension: ${full}`);
      if (entry.isDirectory()) await visit(full);
      else if (scriptExtensions.has(extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  await visit(root);
  return Promise.all(files.sort().map(async path => {
    const source = await readFile(path, "utf8");
    const file = relative(root, path).split(sep).join("/");
    return { file, sha256: sha256(source), ...inspectJavaScript(source, file) };
  }));
}

export async function assertReviewableCode(directory) {
  const audit = await auditReviewableCode(directory);
  const failures = audit.flatMap(item => item.findings).filter(item => !item.reviewed);
  if (failures.length) throw new Error(`Unreviewable extension code:\n${failures.map(hit => `${hit.file}:${hit.line} ${hit.rule}: ${hit.detail} [${hit.fingerprint || ""}]`).join("\n")}`);
  return audit;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const json = args[0] === "--json";
  const directory = args[json ? 1 : 0];
  if (!directory) throw new Error("usage: node scripts/check-reviewable-code.mjs [--json] <extension-directory>");
  const audit = await auditReviewableCode(directory);
  if (json) console.log(JSON.stringify(audit, null, 2));
  const failures = audit.flatMap(item => item.findings).filter(item => !item.reviewed);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else if (!json) console.log(`Reviewed ${audit.length} JavaScript files (including embedded scripts).`);
}

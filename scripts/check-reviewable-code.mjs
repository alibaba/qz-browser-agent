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
  ["dynamic-code:976cd60cbe022e889a24681eb14d41bf9fda68ca8aa62ec23d329db56b3a8f3f", {
    files: /^(?:runner-sandbox\.js#embedded-1|\.qingzhou-debug\/embedded\/workers\/inner-runner\.js)$/u,
    reason: "Outer user/Agent script executor in the existing isolated sandbox Worker; no extension APIs. The packaged qz SDK is passed as one additional function parameter and lowers operations to the existing callTool bridge; legacy tool bindings remain available. Code and JSON arguments enter through validated host messages. Only declared function arguments are serialized as source; raw business values and explicitly returned host image observations use separate channels. Tool calls retain host policy, ownership and cancellation. Error trace formatting preserves the message when Firefox stacks omit it; only explicit diagnostics and errors stream as bounded data to the live host request; tool identity remains host-owned. Modern callers unwrap only host-declared Skill receipts once; legacy callers retain receipts and image observations follow the selected business object.",
  }],
  ["dynamic-code:4145362d3bf1d627640f9b869457f43e55a161b2c3de73fef69cfc61c6b70032", {
    files: /^background\/(?:firefox\/page-command|service-worker)\.js$/u,
    reason: "Firefox-only emulation of CDP Runtime.callFunctionOn for reviewed callers. Native exception names are retained as data. Node-array references/getProperties, weak node indexing and separate object-group handles stay data in the isolated world. Deep open-shadow hit testing and composed pointer/mouse/touch events only affect DOM input dispatch. Pointer buttons, click counts, cancellation state and event ordering are data. Deep active-element routing, keyboard activation and native editing commands only affect DOM input; unsupported native Tab traversal reports an error. AX role/name/hidden observations call the versioned, packaged Content semantics provider in the same isolated frame, with caches limited to one synchronous scan. Bounded AX assembly preserves visible DOM Text nodes as StaticText, checks descendant visibility independently, and omits only the duplicate implicit document root. The provider readiness probe returns only a version number; no library or page strings are compiled. No execution sink or script authorization changes; explicit user/Agent script compilation remains in the page realm only, never the extension context.",
  }],
  ["user-script-execution:ee8db34ea752f2edf5ae6600be2fbb9ab022f59af5c7d9e7a20442d85ba16e0b", {
    files: /^background\/firefox\/page-evaluation\.js$/u,
    reason: "Firefox native MAIN execution of the existing authorized page expression. Optional userScripts access and live scope are checked before dispatch; webNavigation supplies an exact document ID and context generation is checked after execution. No document fallback or replay. The enclosing function includes the serialized, self-contained result/error wrapper; user code stays in the page realm. Chrome does not ship this module.",
  }],
  ["worker-source:65b2fe7945049bfda6adc2cb6f9f2f6697313dcf0ac6e0fecafdf44eecd25b7b", {
    files: /^runner-sandbox\.js$/u,
    reason: "startWorkerRun creates a Blob Worker from the packaged, recursively audited inner-runner only, including its static qz SDK and locator input contract. SDK find returns the existing result array and rejects countOnly; raw tool receipts are unchanged. RegExp find and URL patterns lower to source/flags data, preserving flags and whitespace; returned Tab objects contribute only their explicit tabRef and locator css becomes a target string. No source compilation is added; locator validation reports schema field names and JSON-value failures retain their source message without a generic hint. The host forwards JSON arguments and strict-result mode as data. Embedded Worker traces contain explicit diagnostics and errors; Worker identity, cancellation and message routing are unchanged. ToolError, explicit image observations and streamed diagnostic rows are data in replies. The packaged error formatter preserves messages beside Firefox stacks. Only the current Worker may publish; trace forwarding and snapshots do not bypass cancellation.",
  }],
  ...[
    ["7568aa891e36a648a894563616d2f771d0d1abcd8e4c9d9a99fba42bf63bbaed", "background/tools/cdp-runtime", "CDP evaluator holds an execution lease through evaluation, releasing it in finally for idle cleanup; host-authorized per-call access, cancellation and stale-owner rejection remain enforced. A private read grant permits observation without taking the owner lease; owned evaluation keeps its task authorization. A timeout queues a fixed trace read and termination while its owner and connection identities still match. Late diagnostics cannot terminate a subsequent evaluation. Optional browser permission errors pass through without replacing their recovery guidance; evaluation source, explicit page selection and lease boundaries are unchanged."],
    ["a36dfc60d9dd63fbe417be448b1ec12a50a982e938a85837212784e1a267bf48", "capabilities/media/tools", "Calls only the packaged bounds function on a resolved page element; geometry uses the shared Rect contract."],
    ["32487d7650cc71f56ee23130e8de01b0adf155cce8c0f3b7a75e97a3364fa410", "capabilities/script/tools", "Page-script tool bridge carries Session/run/parent-call identity and arguments as JSON data to the same run-owned evaluator. Optional browser permission errors propagate without replay. No caller mode or implicit page is injected."],
    ["2262d3ad0ea465f9ac9f74cece546f998cf578252c960a95aa886f2799d2f62f", "capabilities/tabs/page-mode", "Evaluates only the literal navigator.userAgent for mobile emulation."],
    ["990830c3227cb894088d278179347f610d4b956688621ef4007d63a1c67acec6", "capabilities/script/tools", "Entire createScriptTools factory: the existing private page bridge initializes the packaged qz SDK with its same live-parent call channel; locator queries remain data. SDK find returns the existing result array and rejects countOnly; raw tool receipts are unchanged. The packaged SDK extracts only tabRef from returned Tab objects, converts locator css to a target string, and lowers RegExp find/URL patterns to source/flags data without compiling them; locator validation reports schema field names; JSON-value failures retain their source message without a generic hint. evaluate receives no SDK bridge. run_script always runs in the existing sandbox Worker; evaluate requires an owned explicit page and a self-contained function defined outside the host closure. Arguments are JSON data. The private Skill page bridge retains live parent authorization. Success and failure traces use trusted host presentation beside business values. Automatic lifecycle trace rows are removed; host collection is scoped to the live execution, includes nested diagnostics, and survives cancellation; Skill callers retain receipts for legacy compatibility. Only successful raw values receive the valueOnly marker. Localized recovery hints are data. Cancellation and packaged security guards remain enforced. Error formatting preserves messages beside Firefox stacks as data. Page-code requirements obtain browser-specific permission before execution; revoked permission errors propagate. Host-only dispatch and confirmation evidence is recorded around the existing evaluation; it is never serialized into page code and does not grant execution authority. No implicit page selection or evaluation replay."],
    ["60ac3b226baabdc75705c018ae301fdb89773f66bee9b698dd8be223e7829ed0", "background/tools/element-runtime", "Isolated-world probe using the packaged ISOLATED_CONTENT_PROBE constant; validates live context identity and the element-reference protocol version. Only public error context changed; probe source and frame selection are unchanged."],
    ["8e177aed927806daf6fc4e73005a6eaa450143a33981f607f0cb26a4eeb0f29b", "capabilities/accessibility/tools", "clearStaleOptionDisabled calls only the literal disabled-state predicate on resolved option/optgroup nodes through their owned document send; no model/page strings become code."],
    ["4dd22594a03e425ce0e6857ca199fcee6c7fe54d0d0aac714ee92886c33d13c5", "background/tools/element-runtime", "bindContentElementRefs resolves bounded batches of original-node tokens through the packaged ISOLATED_CONTENT_INVOKE bridge; token arrays are CDP values, not code. It checks the document/frame and limits concurrent node descriptions. Required locator binding validates the returned node list and propagates permission/transport failures; discovery retains its best-effort fallback. The packaged declaration and value-only token arguments are unchanged."],
  ].map(([digest, module, reason]) => [`cdp-execution:${digest}`, {
    files: new RegExp(`^(?:background/service-worker|${module})\\.js$`, "u"), reason,
  }]),
  // The unbundled forms differ only in esbuild's expansion of shorthand properties after renaming.
  // Bundling now renames inside page-mode apply as well, so its bundled form needs its own entry.
  ["cdp-execution:a5203c6a972363050717b8203449409afe91e157f3e3f0a72e27dd81c80cd214", {
    files: /^background\/service-worker\.js$/u,
    reason: "Chrome bundled invokeBound: the same packaged ISOLATED_CONTENT_INVOKE bridge and value arguments, with graph-specific shorthand expansion. Public caller context and target are used only for response/error handling; no page-controlled declaration or implicit target.",
  }],
  ["cdp-execution:945c48ed5587dadc2a473a40ab53c706c2dfa9c26b09b8bd7268fa85b8c84663", {
    files: /^background\/(?:service-worker|tools\/element-runtime)\.js$/u,
    reason: "Bundled invokeBound: same packaged bridge and value arguments; caller context and the resolved public target are used only for failure details, including the bounded node_unavailable reason; the CDP declaration and argument channel are unchanged, with graph-specific shorthand expansion.",
  }],
  ["cdp-execution:55436984fdb2f49409a071fda3e8994d23d5f13d058c9168df4881649b90a639", {
    files: /^background\/tools\/element-runtime\.js$/u,
    reason: "Unbundled invokeBound: same ISOLATED_CONTENT_INVOKE bridge constant and value arguments as the bundled reviewed function; caller context and resolved public target are used only for failure details, including the bounded node_unavailable reason. The CDP declaration and argument channel are unchanged.",
  }],
  ["cdp-execution:05998f6384843a018c38b4eca0d343009a1aace5b074c722002687bc99a6bee9", {
    files: /^capabilities\/script\/tools\.js$/u,
    reason: "Unbundled createScriptTools: the same reviewed outer Worker, explicit owned-page evaluate function and private Skill bridge as the bundled factory. Only the private bridge initializes the packaged qz SDK; it lowers locator data to the existing live-parent channel, while evaluate remains without SDK access. SDK find returns the existing result array and rejects countOnly; raw tool receipts are unchanged. The packaged SDK extracts only tabRef from returned Tab objects, converts locator css to a target string, and lowers RegExp find/URL patterns to source/flags data without compiling them; it reports schema field names for invalid locators; JSON-value failures keep their source message without a generic hint. User function source is evaluated outside host lexical bindings; JSON arguments and trusted success/failure traces stay separate. Automatic lifecycle trace rows are removed; host collection includes nested diagnostics from live requests; Skill receipts remain available for legacy callers. Only successful raw values receive the valueOnly marker. Localized recovery hints are data. The same page-code permission preflight, error propagation and message-preserving error trace formatter apply. Host-only dispatch and confirmation evidence is recorded around the existing evaluation; it is never serialized into page code and does not grant execution authority. No implicit page or replay fallback.",
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

function maximum(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, value);
  return result;
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
  function userScriptExecute(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (node.type === "SequenceExpression") return userScriptExecute(node.expressions.at(-1), seen);
    if (node.type === "Identifier") return userScriptExecute(bindingValue(node), seen);
    return node.type === "MemberExpression" && codeCallee(node) === "execute" && codeCallee(node.object) === "userScripts";
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
    if (node.type === "CallExpression" && userScriptExecute(node.callee)) {
      add("user-script-execution", node, "Native user-script execution needs source and document-target review", ancestors);
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
  const maxStatements = maximum(statementsByLine.values());
  const maxCodeTokens = maximum(codeTokensByLine.values());
  const metrics = { bytes: Buffer.byteLength(source), lines: source.split("\n").length,
    maxLine: maximum(source.split("\n").map(line => line.length)), maxCodeTokens, maxStatements,
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

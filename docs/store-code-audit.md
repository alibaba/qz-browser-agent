# Chrome package code audit

Run the Chrome preflight after changing runtime dependencies or build scripts:

```bash
npm run verify:store
npm run release -- --version 0.1.5 --target webstore --source worktree
```

The second command creates a local preview, not a publication. For distribution, use committed Git
source as described in [Package a version](commands.md#package-a-version). The Web Store publisher
extracts its ZIP, scans the extracted scripts, and runs the pinned storecheck CLI against the ZIP.
A failed gate removes the upload ZIP. `code-audit.json` and `storecheck.json` remain beside the ZIP,
not inside it. Full `verify` and `verify:quick` exercise this path through the release suite.

## Readable, static dependencies

All application bundles and embedded scripts are unminified. Production no longer runs Terser;
`--no-minify` remains a compatibility no-op. The compiler rejects `.min.js`/`.min.mjs`/`.min.cjs`
JavaScript inputs. CSS minification is unchanged.

| Component | Packaged implementation |
| --- | --- |
| PDF.js 4.10.38 | Modern `build/` modules, with hash-checked AST reductions in [`pdfjs.mjs`](../scripts/vendor/pdfjs.mjs). No legacy core-js, iframe script construction, dynamic function compilation, Worker URL loading, or OpenJPEG binary/URL fallback. |
| MathJax 3.2.2 | [`mathjax-entry.mjs`](../scripts/vendor/mathjax-entry.mjs) statically bundles `mathjax-full/ts`: upstream Startup, TeX packages, SVG/TeX fonts and assistive MathML. No webpack component runtime, network loader, menu, or Speech Rule Engine. |
| SheetJS 0.20.3 | Readable package ESM rather than `xlsx.mini.min.js`; still loaded only for spreadsheet I/O. |
| MCP SDK 1.31.0 | Explicit and default JSON schema validators use the existing CfWorker interpreter. The Ajv provider and its code generator are absent. |
| Zod 4.4.3 | [`zod.mjs`](../scripts/vendor/zod.mjs) removes the optional Function-alias probe, JIT object parser and `Doc.compile` implementation. Objects use Zod's own interpreter. |

The PDF legacy script construction was a core-js `Object.create(null)` compatibility fallback for
old IE/ActiveX. Chrome does not need it. qz imports `WorkerMessageHandler` statically and reads PDF
text through its loopback transport. Modern PDF's `Promise.withResolvers` calls use a small local
capability helper, retaining Chrome 114 support without core-js. PostScript functions use PDF.js's
interpreter. JPEG2000 **pixel rendering** is excluded; text extraction, including text on pages with
images, does not decode those pixels. This engine is not a general PDF viewer or OCR implementation.

MathJax keeps the upstream parser, glyph paths, SVG, accessibility and retry/clear APIs. Its
TypeScript build uses upstream assignment semantics for class fields. `\require` accepts only
statically registered local TeX packages (including physics); unknown names and URLs cannot trigger
loads. Tests compare actual DOM, MathML and pixels against upstream 3.2.2 in both color schemes.
Exports embed completed SVGs and the existing local export controls, not a MathJax runtime.

Original licenses are copied unchanged. Dependency provenance records package integrity, input
hashes for reviewed reductions, transformation entry points and final output hashes. Debug maps
contain the **reviewed transformed PDF/Zod input**, rather than falsely claiming byte-identical
upstream code. Runtime vendor outputs are immutable after generation; maps stay in the debug ZIP.

## Complementary gates

- [`check-no-remote-code.mjs`](../scripts/check-no-remote-code.mjs) rejects known CDN hosts, including
  references in maps, and remote HTML script sources on any host. Only SheetJS's tarball URL in
  dependency provenance is exempt metadata.
- [`check-reviewable-code.mjs`](../scripts/check-reviewable-code.mjs) parses every JS/MJS/CJS file,
  recursively inspects build-time script strings, checks script-tag concatenation (including
  `LT + SCRIPT + GT`), imports, Worker/script sinks, eval/Function and aliases, CDP and native user-script execution, `_0x` names and
  executable-line/identifier-density heuristics. Literal data tables and strings do not count as
  compressed executable lines. The JSON report retains raw maximum line lengths too. Regression
  tests scan both real legacy PDF inputs: the worker's unrelated numeric `GT` declaration must not
  hide the outer `GT = ">"` used in the rejected concatenation.
- [`check-store.mjs`](../scripts/check-store.mjs) invokes the unmodified
  `storecheck --severity=error --json` CLI and runs all 24 rules through its public API. Errors,
  rule failures and even warning-severity findings in the Red Titanium/Blue Argon rule families
  block the package after the exact exception below. Permission warnings remain visible and do
  not remove any permission.

storecheck 0.1.0 exists on npm and requires Node >=20.11. It is an exact devDependency with locked
transitives. Its nested Zod is pinned to 3.25.76 to honor its declared v3 dependency rather than
inheriting the application's v4 override. Its regex rules do not understand PDF's concatenated
script tags or Function aliases; our AST checks cover those cases. Neither tool proves arbitrary
JavaScript data flow or guarantees store approval.

### Exact reviewed sinks

The self-audit uses whole-enclosing-function token hashes and bounded output paths, not file-wide
exemptions. Whitespace/comments and esbuild's numeric name suffixes do not alter these fingerprints.
Changes to a reviewed function require a new review and fingerprint. Three CDP functions
(`createScriptTools`, `invokeBound`, and page-mode `apply`) have separate bundled and unbundled
fingerprints: only esbuild's shorthand-property expansion after renaming differs between the forms.
This is a source-change gate, not a whole-program data-flow proof. Regression tests audit real
production builds (unbundled Chrome, bundled Chrome and Firefox) in temporary directories, then
mutate those artifacts to verify identity-source, implicit-target, extra-sink and output-path rejection. Standalone
TypeScript transforms do not substitute for the production pipeline when reviewing fingerprints.

| Sink | Reason |
| --- | --- |
| `renderSessionExchangeScript` | An inert `application/json` element, with JSON escaping; not executable code. |
| `renderSessionExportRuntime` | Offline HTML contains only escaped localized messages and the recursively audited, build-time export UI runtime. |
| `loadMathRuntime` | The script source is the literal packaged `vendor/mathjax/startup.js`; browser fixtures use a same-origin test-server URL. |
| `startWorkerRun` | Creates a sandbox Blob Worker from the exact packaged inner-runner; the embedded source is scanned separately. Infrastructure failures use the public script-context code; Worker identity, cancellation and message routing remain unchanged. Bridge failures carry ToolError message, hint and details as data. JSON arguments, strict-result mode and explicit image observations remain separate host message fields. Diagnostic rows stream from the current Worker through its request-bound sandbox message channel. A timeout can also request a trace snapshot; neither channel changes cancellation or grants execution authority. |
| Inner-runner's execution function | Existing user/Agent JavaScript execution in a manifest-declared sandbox Worker. Its code is readable and its extension/service access is through validated host messages. The statically packaged qz SDK is passed as one additional executor argument; its Page/Locator methods lower structured data to the existing tool bridge. It adds no extension APIs, execution sink, or implicit page selection. Public run_script always uses this outer executor; tools keep host authorization, and evaluate function arguments are serialized only at declared code fields. Returned business data is validated without renaming fields; image observations are selected by identity from explicitly returned tool results. Only explicit trace/console diagnostics and errors stream as bounded data to the live host request for aggregation; tool lifecycle identity is assigned by Background. Modern scripts unwrap a host-declared Skill receipt once and bind image observations to the returned business value; legacy callers retain their receipt ABI. Authored result fields do not select receipt format or diagnostics. A timeout snapshot remains available. |
| `evaluateCdpScript` | Run-owned CDP evaluation holds an execution lease until settlement and releases it in finally for idle cleanup, with cancellation and stale-owner rejection. Error details include the caller's page reference only when supplied, and omit raw CDP parameters. This is a second intentional user/Agent execution environment, not sandbox execution. When a page script times out, it queues a fixed `Runtime.callFunctionOn` reading `__qzTrace` from the promise CDP is already awaiting, followed immediately by `Runtime.terminateExecution`. Both commands require the original owner and connection identities; termination never waits for a diagnostic response that could arrive during a later evaluation. The declaration is a literal in this function. It does not compile page or model text. |
| `createScriptTools`, `runScriptWithCdpToolBridgeUnlocked` | Public run_script uses the sandbox Worker. evaluate requires an explicit owned page and a self-contained function, evaluated outside the host wrapper with a JSON argument. The private Skill page bridge initializes the same packaged qz SDK with its existing call channel and retains its existing ABI; the old implicit page selection and explicit-return retry fallback are removed. Nested tools require their own explicit page references. The SDK may bind an explicit reference locally, but the host continues to resolve and authorize every call. Public evaluate receives no SDK bridge; SDK functions are never serialized with Function.toString or reconstructed from caller data. The entire factory fingerprint includes the builders that combine packaged trace/guard code with user/Agent source; Session/run identity, target ownership and cancellation remain required. Parent invocation IDs are JSON-serialized data and are resolved against live Background calls. Page messages cannot choose the host execution context. Public tools return raw business values; the host stores status, presentation and image observations separately. Both script success and failure retain trusted trace metadata; only successful raw values use the valueOnly presentation marker. Script Skill producers retain their receipt ABI, and the model boundary builds the shared `{ok,result,trace}` shape. The collector accepts diagnostic rows only for a registered live execution, aggregates nested calls, rejects late rows and retains already received progress on cancellation. The CLI presents ordered trace messages beside the result, without reading trace fields from authored values. ToolError keeps location and recent trace context in details. Cancellation errors include only the caller's page reference when supplied. The factory prepares document readiness before one evaluation, supplies localized context/tool-access recovery hints as data and preserves supplied hints, and records whether dispatch began for timeout reporting. The commit option permits early observation. Preparation never replays user code; execution sources, owned-page checks and cancellation boundaries are unchanged. Automatic script/tool lifecycle trace rows are omitted. Page trace rows stay in the script closure, on a property of the promise CDP holds. They are not posted to the page. |
| Page-mode `apply` | Evaluates only the literal `navigator.userAgent`. |
| `contentContextId`, `invokeBound` | Static isolated-world identity/protocol-version probe and literal bridge function; arguments travel as CDP values rather than code. Caller context and the resolved public target are used only to build failure details; a bounded node_unavailable reason supports pre-dispatch locator recovery. The probe and bridge declarations, value-argument channel, and frame selection are unchanged. |
| Firefox `page-command` invoke | Firefox-only emulation of CDP `Runtime.callFunctionOn` for the same callers. Native exception names are retained as data. Node-array references and `Runtime.getProperties` remain structured data in the isolated world. AX assembly uses a per-scan parent-node index; its ordering, traversal limits and text semantics are unchanged. Coordinate input descends open shadow roots and emits composed pointer/mouse/touch events; these DOM operations do not compile code. It compiles declarations only with the page realm's `Function`, never in the isolated world or extension context. The Chrome package does not contain it. |
| Firefox `evaluateFirefoxPage` | Native `userScripts.execute` compiles the existing user/Agent expression in the page's `MAIN` world after optional permission and live-run checks. `webNavigation.getFrame` supplies the document ID; the injection targets that exact document and checks context generation again after execution. It never falls back to another document or replays failed code. The enclosing function includes the serialized result/error helper, so changes to that source also require review. Only the Firefox adapter output path is accepted. |
| `getElementScreenshotBoundsFromRuntime` | Calls only the packaged element bounds function on an owned page element; public geometry uses the shared Rect contract. |
| `clearStaleOptionDisabled` | Resolves the original AX document and remaining candidate backend IDs through that frame's send. A literal read-only TreeWalker function visits each connected document/shadow root and evaluates the unchanged native disabled predicate. Deep serialization supplies backend IDs and loader IDs; only matching AX option/optgroup candidates with a strictly false boolean are staged. No selector or position establishes identity. A second literal checks that the original document is still current before applying corrections. Cancellation, missing nodes, unsupported serialization (including Firefox), exceptions and revoked access retain disabled; object groups are released in finally. No DOM attributes are written and no page/model strings become executable source. |
| `bindContentElementRefs` | Resolves bounded batches of original-node tokens through the packaged `ISOLATED_CONTENT_INVOKE` bridge with action `resolveElementRefs`; token arrays are CDP values, not code. A second literal `function() { return this; }` serializes the retained isolated-world array with CDP deep serialization, without interpolating source. Backend IDs must be elements in the captured loader. Unsupported hosts or shapes describe the same retained objects without replaying the one-shot tokens. Frame/document checks, cancellation and object-group cleanup remain enforced. Required locator binding propagates permission/transport failures; ordinary discovery retains its best-effort fallback. |

On the Firefox-integrated branch, `contentContextId` and `invokeBound` read their probe and bridge
source from the literal constants in `background/tools/isolated-page-calls.ts`. Their function
fingerprints do not cover those constants, so changes to that module need the same review.

Page-code permission requirements are checked before tool execution. The CDP evaluator and page
Skill bridge preserve permission failures and their recovery hints without replay. The shared error
trace formatter retains the message when Firefox supplies a stack without its error header; this
changes diagnostic data only, with the Worker and page execution boundaries preserved.

The packaged SDK lowers find and URL-wait `RegExp` inputs to source and flags passed as data to
the existing tools, preserving explicit flags and pattern whitespace. A returned Tab object supplies
only its explicit `tabRef`; locator `css` becomes a `target` string before schema validation. These
values do not become executable source or grant page ownership. SDK `find()` runs the existing
`find_elements` query without its result limit, returns every match as a plain array, and
rejects `countOnly`; raw tool receipts remain unchanged. Locator actions accept only `expect`,
`timeout`, `tabAlias` with a popup, and `submit` for fill, and compile `expect` to the existing
wait-tool trigger; `scrollIntoView` and `page.scroll` lower to the existing element and page scroll
tools. This unwraps and validates data without adding execution or source interpolation. Locator validation reports field
names from its static schema and accepts `includeHidden` only as a boolean; JSON-value errors retain their source message. The host records dispatch
and confirmation around the existing evaluation for timeout diagnostics; that evidence never enters
page code and does not authorize or replay execution. These changes affect the Worker source,
private page-bridge factory fingerprints, and storecheck's whole-runner token digest without changing
execution sources, target authorization, sandbox isolation, or replay behavior.

The CDP call sites remain explicit findings in the custom report, each limited to its exact
function fingerprint and owning output path. storecheck does not detect these calls. In particular,
`evaluate` deliberately executes a self-contained user/Agent function in an explicitly owned page through CDP; it is not
made static or policy-safe merely because there is no `eval` token. This capability has the same
submission-policy review obligation as the sandbox executor.

### storecheck's sandbox finding

The unmodified CLI can report a `privacy/remote-code-execution` error for `runner-sandbox.js`'s
embedded `new Function`. Its regex comment stripper can also mask this sink: it treats a `//`
inside the serialized Worker as a comment through the end of the containing source line. The qz
SDK build currently exhibits that false negative. The recursive AST audit still detects and reviews
the executor. Its CSP rules distinguish sandbox pages. Version 0.1.0 has **no ignore-file or
inline-suppression feature**.

The integration uses its supported `runRules({ rules })` / `RuleContext.report` API to adapt only
that individual report. It requires all of:

- the exact rule, file, message and line containing the expected argument list, including the packaged qz SDK binding;
- a token hash of the **entire** packaged runner, without identifier normalization;
- the exact sandbox page declaration, sandbox CSP and restrictive extension-page CSP;
- the sandbox HTML loading the packaged runner.

No rule is disabled and no package bytes are hidden from the CLI. `storecheck.json` preserves the
original exit code and report, the accepted finding with its reason, and the effective report.
Additional or changed execution sites fail the recursive AST audit. Unit tests exercise the exact
report adapter directly, including another file, a modified runner and a removed sandbox declaration,
so upstream detection gaps cannot make those assertions vacuous. The upstream CLI result is preserved
as returned; a minification warning still blocks the package.

This exception preserves a deliberate product capability, not a claim that CWS must accept it.
Chrome permits eval in sandboxed pages, but store policy also considers remotely supplied logic,
user intent and the host bridge. Reviewers can still scrutinize Agent-generated scripts, installed
Skills and CDP page execution. Supply an accurate explanation in the submission notes; do not
rename or conceal these paths to make a regex pass. Privacy-policy dashboard details, permission
justifications and store listing copy require maintainer review.

## Load the exact ZIP

```bash
node --import ./tests/support/typescript-loader.mjs tests/release/verify-store-zip.mjs \
  dist/releases/0.1.5/webstore/qz-browser-agent-extension-0.1.5.webstore.zip \
  tests/results/final-store-zip
```

This uses isolated Chromium storage. It imports a synthetic Session through the real Background
protocol, renders formulas in the packaged panel, uploads a two-page compressed PDF through the
composer, verifies the stored extracted text, downloads a real session HTML export and opens it
with HTTP requests blocked. Reports, screenshots and synthetic files stay under the specified
ignored results directory. It neither contacts a live model nor changes a user's Sessions.

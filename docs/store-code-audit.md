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
  `LT + SCRIPT + GT`), imports, Worker/script sinks, eval/Function and aliases, CDP execution, `_0x` names and
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
This is a source-change gate, not a whole-program data-flow proof.

| Sink | Reason |
| --- | --- |
| `renderSessionExchangeScript` | An inert `application/json` element, with JSON escaping; not executable code. |
| `renderSessionExportRuntime` | Offline HTML contains only escaped localized messages and the recursively audited, build-time export UI runtime. |
| `loadMathRuntime` | The script source is the literal packaged `vendor/mathjax/startup.js`; browser fixtures use a same-origin test-server URL. |
| `startWorkerRun` | Creates a sandbox Blob Worker from the exact packaged inner-runner; the embedded source is scanned separately. |
| Inner-runner's execution function | Existing user/Agent JavaScript execution in a manifest-declared sandbox Worker. Its code is readable and its extension/service access is through validated host messages. |
| `evaluateCdpScript` | Run-owned CDP evaluation, with cancellation and stale-owner rejection. This is a second intentional user/Agent execution environment, not sandbox execution. |
| `createScriptTools`, `runScriptWithCdpToolBridgeUnlocked`, `runScriptAsFunctionBody` | Existing page-script entry, message bridge and explicit-return fallback. The entire factory fingerprint includes the builders that combine packaged trace/guard code with user/Agent source; Session/run identity and target ownership remain required. |
| Page-mode `apply` | Evaluates only the literal `navigator.userAgent`. |
| `contentContextId`, `invokeBound` | Static isolated-world identity probe and literal bridge function; arguments travel as CDP values rather than code. |
| Firefox `page-command` invoke | Firefox-only emulation of CDP `Runtime.callFunctionOn` for the same callers. It compiles the declaration with the page realm's `Function`, never in the isolated world or extension context. The Chrome package does not contain it. |
| `getElementScreenshotBoundsFromRuntime` | Calls only the packaged element bounds function on an owned page element. |

On the Firefox-integrated branch, `contentContextId` and `invokeBound` read their probe and bridge
source from the literal constants in `background/tools/isolated-page-calls.ts`. Their function
fingerprints do not cover those constants, so changes to that module need the same review.

The eight CDP call sites remain explicit findings in the custom report, each limited to its exact
function fingerprint and owning output path. storecheck does not detect these calls. In particular,
`run_script target:"page"` deliberately executes user/Agent source in a page through CDP; it is not
made static or policy-safe merely because there is no `eval` token. This capability has the same
submission-policy review obligation as the sandbox executor.

### storecheck's sandbox finding

The unmodified CLI reports one `privacy/remote-code-execution` error for `runner-sandbox.js`'s
embedded `new Function`. Its CSP rules already distinguish sandbox pages and report no sandbox CSP
error. Version 0.1.0 has **no ignore-file or inline-suppression feature**.

The integration uses its supported `runRules({ rules })` / `RuleContext.report` API to adapt only
that individual report. It requires all of:

- the exact rule, file, message and line containing the expected argument list;
- a token hash of the **entire** packaged runner, without identifier normalization;
- the exact sandbox page declaration, sandbox CSP and restrictive extension-page CSP;
- the sandbox HTML loading the packaged runner.

No rule is disabled and no package bytes are hidden from the CLI. `storecheck.json` preserves the
original exit code and report, the accepted finding with its reason, and the effective report.
Additional or changed execution sites fail. Unit tests check another file, a modified runner,
a removed sandbox declaration and a minification warning.

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

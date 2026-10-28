# Benchmarks

Use these checks to measure a change against fixed inputs. Run from the repository root after
[setting up tests](../tests/README.md). Keep the browser version, inputs and machine conditions the
same across comparisons; run timing checks without concurrent builds or browser tests.

```bash
npm run benchmark -- conversation
npm run benchmark -- grid --rows 10000 --cols 20
npm run benchmark -- stream --samples 3 --budget-ms 34
npm run benchmark -- rate /path/to/session-export.html
```

The default target is `conversation`, with all modes, JSON output and failing health gates. `npm run
benchmark -- <target> --help` prints the common options. For specialized article scripts, inspect
the linked argument parser before invoking them. Keep generated evidence under ignored
`tests/results/` or outside the checkout.

## AX viewport and BFS budgets

Measure snapshot sizes on four synthetic pages and the public Wikipedia River article:

```bash
node tests/benchmarks/ax-viewport.mjs
```

The isolated Chromium harness runs the production AX tool and Content handlers at 1280×720.
It compares full/viewport scope with BFS budgets 120, 300 and a measurement-only high limit.
Depth 16 and normal text pruning remain enabled. The public tool still caps `limit` at 300.
`tests/results/viewport-ax/sizes.json` records node counts, snapshot characters, characters/4
estimates, raw omission counts, truncation and elapsed time; adjacent text files preserve snapshots.
Live-page errors are recorded without discarding fixture results.

For an explicitly authorized real-provider comparison, export `DEEPSEEK_API_KEY` securely and run:

```bash
npm test -- live ax-viewport
```

This runs six short tasks per variant with `deepseek-flash`, a 1M context budget and image support.
The baseline compiles the AX tool/messages from Git commit `cbac588`; the prototype uses the current
worktree. It uses a minimal tool loop, not the full extension Agent lifecycle or CLI/MCP. Production
Content handlers execute actions and scrolling; DOM state checks answers and side effects.
`tests/results/viewport-ax/live/` contains transcripts, provider usage and pass/fail results.
`QZ_AX_OUTPUT` selects another evidence directory. No user profile or stored settings are changed.

For the public-site matrix, use the same isolated AX/Content harness:

```bash
npm test -- live ax-viewport-public --trials 2 --output tests/results/viewport-ax/round3
npm test -- live ax-viewport-public --cases github,mdn --output tests/results/viewport-ax/follow-up
```

The matrix declares two tasks on each of 13 public sites. Before calling the model, each run records
an independent rendered-DOM oracle and checks that the target starts in or outside the viewport as
specified. Access challenges, HTTP errors, missing facts and invalid initial geometry are retained
as precondition failures, not model failures. Read tasks do not submit forms or follow external
links; the two fill tasks use synthetic text without submitting. No login or purchase is performed.

Baseline/prototype order alternates by task and trial. `--trials` sets the minimum paired trials
(default1, range1–3). Any failure raises that task to three paired trials; Baidu and PyPI always
receive three because preflight found intermittent challenges. Every attempt,
including provider errors, stays in `results.json` and its transcript. The runner continues after
failures so later sites still produce evidence; exit zero means the matrix completed, not that all
tasks passed. `--concurrency` defaults to 2 and supports 1–3; `--repeat-all` runs three paired trials
for every selected task. `--pause-ms` adds a per-lane cooldown between attempts (0–60000ms,
default0); combine it with `--concurrency 1` for availability follow-ups without request bursts.
Existing result directories are rejected to preserve earlier attempts.
Read tasks also capture a final DOM oracle to distinguish source changes from wrong answers;
the initial-oracle score is retained even when the page changes. The harness uses one document
handle for unique-selector binding and supports selector-only UIDs for subtree reads and actions,
matching the production element runtime's fallback route.

The matrix also measures six scope/BFS combinations per reachable site and compares fixed/sticky
control names in full versus viewport high-budget snapshots after each prototype task. These audit
reads are not sent to the model and are excluded from task tool-call/character/token totals.

## Replay a conversation

The runner measures compiled Side Panel rendering with simulated Chrome APIs and recorded data.
Standalone runs prefer local Chrome, then Chromium; set `CHROME_EXECUTABLE` when comparing
revisions.

```bash
npm run benchmark -- conversation /path/to/export.html --mode snapshot-render
npm run benchmark -- conversation --real-examples
npm run benchmark -- conversation /path/to/export.html --mode stream-fixture-interaction \
  --stream-fuzz-seed 12345 --color-scheme dark --artifact-dir tests/results/stream-check
```

HTML exports and JSON with `sessionId`, `title` and `transcript` are accepted. JSON may also provide
`baseTranscript` and `events` for live replay. Use the [synthetic
fixture](../tests/benchmarks/conversation-render/fixtures/smoke.json) as a starting point. Real
exports belong in the [private sample
directory](../tests/benchmarks/conversation-render/real_examples/README.md). Only its README and
synthetic stub are tracked; samples, screenshots and reports must remain private. `--real-examples`
uses a fresh context per sample and reports all failures, including an empty corpus. For single-file
screenshots or baseline comparisons, pass the sample path directly. Private samples are optional.

| Mode | Use it to check |
| --- | --- |
| `session-switch` / `snapshot-render` | Loading a saved Session / rendering an existing transcript |
| `expand-tool-raw` | Expanding a timeline and materializing its raw result |
| `data-grid-tab-state` | Leaving and returning to Data without losing grid or sort state |
| `live-replay` | Applying fixture events through the production reducer and render scheduler |
| `stream-fixture` | Reconstructing runtime events from a complete conversation |
| `stream-fixture-expanded` | Streaming with the heaviest timelines kept open |
| `stream-fixture-pager` | Clicking both pager directions while streaming |
| `stream-fixture-interaction` | Reading away from the tail, resuming follow and using pagers |
| `visual-audit` | Discovering and clicking Chat controls in isolated UI states |
| `all` | All modes; live replay requires fixture events |

Streaming defaults to `--stream-pace-scale 0.05`; `1` approximates recorded delays and `0` is a fast
stress run. `--expand-tool-timeline-limit` controls expanded cards. Exact options and default health
budgets are in [`run.mjs`](../tests/benchmarks/conversation-render/run.mjs).

Interaction checks reject stolen scroll position, lost anchors or click targets, whole-message
animation restarts and missed tail resumption. Default anchor/pager drift is at most 1 px. A seeded
run adds reproducible wheel direction, distance and reading pauses; during settled pauses it samples
completed visible cards every frame and rejects drift above 0.5 px, disappearing cards or empty
coverage. Intentional scrolling is excluded. Preserve the seed and traces when reporting a failure.

```bash
node --import tsx tests/benchmarks/conversation-render/run-stream-interaction.mjs
node --import tsx tests/benchmarks/conversation-render/run-visual-audit-matrix.mjs
node --import tsx tests/benchmarks/conversation-render/check-context-pruning.mjs
```

These entries provide synthetic interaction coverage, a responsive light/dark control audit, and an
offline check that context pruning preserves the canonical transcript and tool pairing. The visual
audit records before/first-frame/settled screenshots, click coverage, clipping, overlap, motion and
browser errors. A failed action preparation remains a failed case.

`--artifact-dir` saves `report.json`, semantic snapshots, screenshots and any interaction galleries.
`--update-baseline` and `--compare-baseline` create or compare a single fixture's baseline;
`--baseline-dir` selects its location. Baselines are local artifacts. Use `--fail-on-health` when
calling the runner directly; the npm benchmark entry already includes it. Performance improvements
require matching semantic order, content, and final stream digest. Inspect intentional visual
changes.

To compare identical captured transcripts against a compatible ref in local Git history:

```bash
node --import tsx tests/benchmarks/conversation-render/compare-revisions.mjs --prepare <output> <baseline-ref>
node --import tsx tests/benchmarks/conversation-render/compare-revisions.mjs --captures <output> <capture-dir> <live-metadata.json>
node --import tsx tests/benchmarks/conversation-render/compare-revisions.mjs --run <output>
```

This comparator needs Node 24, locked Chromium and ImageMagick. It retains failed captures, input
hashes, resource errors and unmasked before/after images. Optional `resources/resources.json`
supplies identical recorded resources; other external requests fail. Invalid renders stay in the
denominator. Its screenshot budget is 0.1% changed pixels; the CSS migration audit below requires
exact equality. For font-size, viewport and expansion fuzz, see
[Tests](../tests/README.md#benchmarks-and-visual-checks).

## Tables, Markdown and request timing

`grid` defaults to 50,000 rows and 100 columns. Its fixed viewport-height table must exercise
virtual rows; more than 200 rows in the first screen fails. Only layout research should override
`--table-height`. The subprocess has a five-minute default hard timeout. `--rows`, `--cols`,
viewport and timeout options override `DATA_GRID_BENCH_*` variables; see the target's help.

`stream` measures Markdown rendering and retains `--fail-on-budget`; the default total-render p95
budget is 34 ms for each tested viewport. `rate` replays production Governor/Learner behavior
locally. Exported provider usage supplies a reproducible load proxy. Interpret results against the
timing and usage fields actually present in the export. Earlier neighboring exports may restore
collapsed timestamps; use `--no-history` to disable this, or `--from-request` to select a reliable
suffix. Reports and SVGs default to `tests/results/provider-rate-replay/`; help lists policy
overrides.

## Reproduce large-image communication failures

Run `images` in an isolated, loaded extension with synthetic images and a local SSE provider:

```bash
npm run benchmark -- images --verify
npm run benchmark -- images --cases history,stream --max-errors 6 \
  --output-dir tests/results/large-image-conversation --headed
npm run benchmark -- images --cases collect --verify \
  --output-dir tests/results/image-collection
```

| Case | Input and checks |
| --- | --- |
| `single` | A valid 4096 px PNG sent through a native Port exercises Chrome's size boundary. Composer verification checks normalization of a 2560 px image. |
| `history` | A saved conversation with 25 images of 512 px exercises snapshot transfer and production recovery. |
| `stream` | A conversation starts with 23 images, receives two composer uploads, streams an answer, and handles Stop during snapshot transfer. |
| `collect` | Forty `read_image(url)` calls fetch distinct 3072×192 px PNGs above 2 MiB each. A delayed forty-first fetch exercises cancellation. |

The default selection is `single,history,stream`; select `collect` explicitly. `--verify` checks the
shared 2048 px / 2 MiB image limits, complete snapshot transfer above 64 MiB and below 128 MiB,
ordered results, placeholder retention, and stop recovery. In the history projection, the latest
eight image-bearing messages retain nine images; sixteen earlier images become placeholders. Stored
history and the UI retain all twenty-five images.

Collection verification checks forty unique hashes and the latest eight image-bearing messages in
each model request. Every ten reads, `get_state` must complete within two seconds. Stop must cancel
the delayed fetch within two seconds and acknowledge within eight seconds, preserving the forty
completed results and leaving the Session aborted.

Reports and screenshots default to `tests/results/large-image-conversation/`; use `--output-dir` to
select another directory. `--headed` shows the isolated browser. `--max-errors` bounds diagnostic
error collection at 1–10 repetitions, default 6. The native-Port oversize failure is the control
case. Omitting `--verify` records diagnostics for investigation.

Reports contain payload estimates, error identities, control latency, provider cancellation, stop
acknowledgement, and model projections with image payloads removed. Snapshot estimates serialize the
local envelope; native Chrome errors confirm limit breaches. Event-loop lag includes fixture setup
and restoration. Run this optional benchmark on its own when comparing responsiveness.

## Compare production loading

Build both revisions first, then run an isolated A/B comparison:

```bash
node tests/benchmarks/capability-loading/compare.mjs \
  --reference /absolute/path/to/before-production \
  --candidate /absolute/path/to/after-production \
  --fixture /absolute/path/to/frozen-development \
  --output tests/results/capability-loading-comparison --rounds 7
```

Use a new output directory. The development fixture supplies deterministic Data setup; each measured
page loads its own unmodified production files. The driver alternates A/B order after warmup and
records startup, first formula, first Data table and Excel download, including actual bytes and
hashes. Separate light/dark captures require equal pixels and geometry. Compare both startup and
deferred first use alongside bundle size.

## Compare CSS and markup

Freeze each revision's application and control fixture before editing. Compare real old/new DOM:

```bash
node tests/design-system/compare-css.mjs \
  --reference-dir /absolute/path/to/verified-reference-extension \
  --candidate-dir /absolute/path/to/candidate-extension \
  --reference-fixture-dir /absolute/path/to/before-development-extension \
  --candidate-fixture-dir /absolute/path/to/after-development-extension \
  --reference-controls /absolute/path/to/before-control-fixture.html \
  --candidate-controls /absolute/path/to/after-control-fixture.html \
  --output tests/results/css-comparison
```

For CSS-only changes, `--fixture-dir` can supply the same application to both sides. Per-side
options override it. Control fixtures default to `tests/button-system/smoke.html`; freeze both when
its classes change. Prepare verified unpacked reference assets and development fixture builds before
running. The comparator requires Node 24, locked Chromium, and ImageMagick.

The default matrix covers 360/660 px in light/dark, public controls, real workspaces and exported
HTML. Every case must settle in two consecutive equal captures. Any pixel/geometry difference,
missing case, page error, or unexpected network request fails. The pixel tolerance is zero across
the full image. Use a new output directory and preserve each revision's original markup, inputs,
hashes, and screenshots. Establish a reference self-comparison before attributing existing drift to
a change.

`--full-raster` adds a compositor diagnostic flag to both browsers. Retain the default-browser
result alongside it and report each configuration separately. The separate
[`tool-timeline/compare-revisions.mjs`](../tests/tool-timeline/compare-revisions.mjs) supports a
broader Renderer history audit, with `--baseline <compatible-ref>` and optional `--candidate-dir`.
It requires a compatible historical checkout containing the old extension layout.

## Evaluate article extraction

Start with the offline synthetic check; it blocks network and measures both extraction and the
complete `readArticle(source=auto)` path:

```bash
node --import tsx tests/benchmarks/article-extraction/offline-smoke.mjs
node tests/benchmarks/article-extraction/compare-upstream.mjs \
  --upstream /path/to/trafilatura --python /path/to/python --refresh-upstream
```

The second command needs an upstream corpus checkout and Python environment. Its canonical 990-page
Trafilatura score measures selected text; the Chinese real-world suite measures the complete product
path and Markdown. Runtime and corpus hashes accompany reports. External Defuddle bundles are
optional via `--defuddle-bundle`; keep them outside source control. Chinese runs can compare shared
versus native Markdown with `--defuddle-markdown shared|native|both`; native modes require the full
bundle.

Capture visits real websites and belongs outside unattended checks. Freeze each shard independently:

```bash
node tests/benchmarks/article-extraction/realworld.mjs capture \
  --config tests/benchmarks/article-extraction/chinese-realworld-sites.json \
  --workers 8 --screenshots --output tests/results/article-extraction/base
node tests/benchmarks/article-extraction/realworld.mjs compose \
  --base <base-corpus> --increment <increment-corpus> --supplement <reserve-corpus> \
  --output tests/results/article-extraction/combined
node tests/benchmarks/article-extraction/realworld.mjs run \
  --corpus <combined-corpus> --labels <finalized-labels> \
  --upstream /path/to/trafilatura --python /path/to/python
```

Use `chinese-realworld-increment-v2.json` for the 200-page increment to the 300-page base.
Composition keeps source shards immutable, deduplicates canonical URLs and checks hashes before
committing a complete derived directory. Repeated `--supplement` inputs fill shortages; omit them
when unnecessary. For split-aware expansion plans, reserves can fill only the same
split/vertical/page-type quota. Record challenges, login walls, HTTP errors, and unstable hydration
as failed captures. Keep captured HTML, screenshots, and reports in ignored working directories.

Scores default to proxy references for diagnosis. Human gold requires `--labels` pointing to a
finalized `human-reviewed-frozen-dom` set: all reviews complete, exact corpus IDs/count/digest, and
matching DOM hashes. Review the frozen DOM and its content-addressed screenshot when present.
[`manual-annotate.mjs`](../tests/benchmarks/article-extraction/manual-annotate.mjs) provides `seed`,
`audit`, `inspect` and `finalize` operations; `finalize` takes `--corpus`, `--candidates`,
`--decisions` and `--output`. Preserve reviewed screenshots as evidence.

Only approved `extract` pages contribute text F1. Approved `exclude` pages report non-empty false
positives separately from empty output and execution errors. Preserve base/increment and page-type
breakdowns. Markdown defects and pagination integrity remain separate from text quality; oracle
selection uses human-gold text F1. Internal candidate diagnostics run outside product timing;
`--candidate-provenance` is an explicit, larger diagnostic capture.

For reranker work, keep site families, shared templates and near-duplicates in one split. The
versioned 1,500-page protocol uses 800 train / 300 validation / 400 frozen test pages, including
approved excludes. Run
[`corpus-diversity-audit.mjs`](../tests/benchmarks/article-extraction/corpus-diversity-audit.mjs)
with `--config <plan> --policy <policy> --fail-on-gate`, then add `--manifest
<corpus>/manifest.json` after capture. Keep gate thresholds fixed. Freeze features, model, and
threshold before opening the test set once.
[`conservative-reranker.py`](../tests/benchmarks/article-extraction/conservative-reranker.py) takes
`--dataset`, `--manifest`, `--output` and opt-in `--open-test`; it owns readiness and safety gates.
Use inference features derived from the candidate content and structure. Keep sites, URLs,
selectors, timings, and gold-derived values in evaluation metadata. A test-informed change needs a
fresh test shard; report challenge subsets separately.

## Export extraction training data

Tree-DP exports default to `base,train` and reject test data:

```bash
node tests/benchmarks/article-extraction/export-tree-dp-training.mjs \
  --corpus <corpus> --labels <finalized-labels> --output tests/results/tree-dp-training
```

Validation export requires `--validation-evaluation` and defaults to `validation`; keep it separate
from training. The exporter retains input identity and gold provenance. Its argument parsing is in
[`export-tree-dp-training.mjs`](../tests/benchmarks/article-extraction/export-tree-dp-training.mjs).

Gold Markdown and task synthesis call a real model and need explicit authorization. Credentials use
the [live-test configuration](../tests/README.md#real-model-tests). Generate gold with
`generate-gold-markdown.mjs --corpus <corpus> --labels <finalized-labels>`; its default output is
`<corpus>/gold-markdown-deepseek-v4-flash-v1`, which the variation generator reads.

```bash
node tests/benchmarks/article-extraction/generate-training-variations.mjs synthesize \
  --corpus <corpus> --output tests/results/extraction-training --sample-ids <id1,id2>
node tests/benchmarks/article-extraction/generate-training-variations.mjs pack \
  --corpus <corpus> --output tests/results/extraction-training
node tests/benchmarks/article-extraction/generate-training-variations.mjs export-jsonl \
  --output tests/results/extraction-training --jsonl tests/results/extraction-training.jsonl
```

`--sample-ids` is only for a synthesis smoke run; omit it for the full corpus before packing. `all`
performs synthesis, packing, and JSONL export. Generate each answer once and retain only answers
that pass evidence and format checks. Packaging revalidates persisted evidence, exact artifact
inventory, hashes and page/site split isolation; preserve these checks and the generated manifest.
For the full input contract and options, see
[`generate-training-variations.mjs`](../tests/benchmarks/article-extraction/generate-training-variations.mjs).

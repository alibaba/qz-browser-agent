# Tests

Run tests from the repository root. Default suites use synthetic fixtures, isolated browser
profiles, and local services. See [Commands](../docs/commands.md#run-tests) for dependencies and
runner options.

## Run and filter tests

Install the locked browser binaries with `npx playwright install chromium`. Playwright and extension
tests use Chromium; standalone page fixtures also use Chromium Headless Shell. Python browser tests
use `tests/python/uv.lock` through uv. Missing dependencies fail the run.

```bash
npm test -- unit contracts
npm test -- unit --match session
npm test -- browser --list
npm test -- playwright renderer-lifecycle.spec.mjs --workers 1
npm run verify
```

| Suite | What it checks |
| --- | --- |
| `unit` | Logic, repositories, cancellation, concurrency and data formats |
| `contracts` | Side Panel projections, Port lifecycle and cross-context messages |
| `services` | Node MCP/CLI lifecycle, endpoint failures, and Agent acceptance checks |
| `browser` | Playwright, Python page smoke tests and Data Grid behavior |
| `e2e` | The loaded extension, Session exchange, documents and tool timelines |
| `release` | Deterministic builds, ZIP contents and the packaged extension |
| `visual` | Tool timelines and conversation streaming |

`npm test` selects `unit contracts services browser`; `--all` also selects E2E, release and visual.
`verify` adds type checking and coverage gates. `--list` prints the selected commands. `--match`
filters unit filenames or suite commands; the `playwright` entry accepts Playwright options
directly.

For the standalone CLI package, run `npm test -- services --match node` and
`npm test -- release --match npm-package`. The package check uses the public npm registry to
install the packed artifact in two clean temporary directories. It exercises the installed bin,
MCP handshake, tools, daemon reuse across install paths, and shutdown on a temporary port.
It uses isolated npm configuration, cache, and qz state, and cleans up its own service and files.
Use `node tests/release/npm-package.mjs --help` to retain or test a specific tarball.
The **npm package** workflow runs these checks on Linux, macOS, and Windows.

The runner selects one to three concurrent jobs based on available CPUs. Timing-sensitive suites run
after other work. Each lane runs ready commands while dependent commands wait; build-only release
checks use the general lane. Use `npm test -- --all --jobs 1` to diagnose resource contention.
With two jobs, the auxiliary slot finishes ready general work, then runs isolated extension checks
alongside Playwright. Each extension check owns its profile; timing measurements still run alone.
`QINGZHOU_TEST_CONCURRENCY` and `QINGZHOU_PLAYWRIGHT_WORKERS` override their respective pools; suite
ownership stays in [`runner/suites.mjs`](runner/suites.mjs).

The runner uses the locked Chromium, including its full headless mode for Playwright page tests.
Native keyboard, clipboard and control fixtures retain Chromium Headless Shell.
Page tests can select `QINGZHOU_PLAYWRIGHT_CHANNEL=chrome`;
other browser entries accept `CHROME_EXECUTABLE`. Keep the browser version fixed for comparisons.

## Add a test at the right boundary

| Behavior being changed | Where to put the evidence |
| --- | --- |
| Pure logic, storage or a race | `unit/test-*.mjs`, discovered automatically |
| Client projection or message protocol | `sidepanel-rendering/`, run with `contracts` |
| Layout, focus, scrolling or user interaction | `browser/*.spec.mjs` |
| Worker restart, real Chrome storage, Port or tab ownership | `background/` extension E2E |
| A Python service | `integration/` or the service's pytest suite |
| Public TypeScript contracts | `types/`, including negative `@ts-expect-error` cases |

Test observable results and failure recovery. Session and tool changes need cancellation, obsolete
events, deletion and concurrent-write coverage where relevant. Use a loaded extension to test Worker
restart recovery. The deterministic [`background/extension-e2e.mjs`](background/extension-e2e.mjs)
provides local HTTP errors, slow streams, concurrent runs, and restart scenarios through a local
provider.

Playwright tests import `test` and `expect` from [`browser/fixtures.mjs`](browser/fixtures.mjs) to
inherit error diagnostics and coverage. Use `sidepanel-fixtures.mjs` when the full panel is needed;
its Chrome stub has explicit responses and is ready before interaction. Existing UI fixtures use
`zh-CN`; multilingual tests choose and restore their own language.

Use a small named fixture for a regression. Markdown cases live in `message-rendering/cases.js`;
formula cases and streaming checkpoints live in `mathjax/cases.js`. Tool-timeline JSON fixtures
combine `conversation.entries` with declarative `steps`; start with
[`thinking-tools-stream.json`](tool-timeline/fixtures/conversations/thinking-tools-stream.json).
Keep expected results with the test.

Shared facilities in `support/` build isolated extensions, serve compiled assets and manage local
services. `/extension/*` serves compiled assets. The runner shares a temporary build through
`QINGZHOU_TEST_EXTENSION_DIR`; tests own and clean up extra resources they create. When bypassing
the runner for a Node test, load both its bootstrap and TypeScript loader:

```bash
node --require ./tests/support/unit-bootstrap.cjs \
  --import ./tests/support/typescript-loader.mjs tests/unit/test-session-exchange.mjs
```

Use `t.after` or `finally` to release servers, timers, profiles, temporary directories and global
mocks. Register new suites in the catalog. Keep test instrumentation under `tests/`.

### Local connection resilience

Run the real-browser connection checks with:

```bash
npm test -- e2e --match mcp-resilience
npm test -- e2e --match mcp-user-input
npm test -- e2e --match mcp-resources
QINGZHOU_MCP_IDLE_MS=300000 npm test -- e2e --match mcp-resilience
```

The default idle window is 125 seconds. During that window, Chrome runs without a side panel or
debugger attached; Node only reads the local service health endpoint. The test briefly reconnects
to a regular page to stop the extension worker, disconnects again, and verifies automatic recovery.
It also covers service interruption during navigation, three observed HTTP poll failures followed by
automatic reconnection without a connection page, and an occupied port with fallback to a free port.
Interrupted actions are checked for accidental replay. Evidence is saved to
`tests/results/mcp-bridge/resilience-e2e.json`. Protocol, cancellation, concurrent-client and daemon
lifecycle regressions run in `npm test -- services`.

The resource scenario uses an isolated profile and temporary download directory to exercise CLI
table CSV/XLSX exports, image ZIP exports, exact deletion, shared asset retention, Skill packages,
and settings updates. It reads the saved files and verifies their contents. The user-input scenario
also queues a CLI message behind a pending form and checks that streaming follows that message's
run after the form is submitted.
It also creates and observes a task through real MCP progress notifications, submits its first
form through MCP, and completes the next form through CLI while all observers remain connected.
Service tests check one MCP initialization per CLI command, bounded initialization and cleanup,
request cancellation, and command routes against the advertised MCP schemas.

For a sustained CLI/MCP check, run this manual scenario with Node.js 24:

```bash
node tests/background/mcp-agent-soak.mjs --duration-seconds 1800
```

The clock starts after setup. One isolated Chrome profile, service, and MCP connection remain alive
while real CLI subprocesses and MCP calls alternate task creation, follow-ups, steering, forms,
confirmations, cancellation, browser tools, and resource exports. The model and web pages use local
synthetic fixtures. Export checks read the saved CSV, XLSX, and ZIP files; settings checks restore
the original configuration. Profiles and downloads are removed on exit.

Timestamped `agent-soak-*.json` reports in `tests/results/mcp-bridge/` record operations, expected
rejections, task outcomes, health samples, and failures. This manual scenario is excluded from the
default suites. Use `--duration-seconds 1` for one complete preflight round.

## Fixtures and isolation

Shared fixtures must be small, synthetic and explainable. The [capability
example](fixtures/capabilities/example/README.md) is a runnable starting point for extension
authors. Real conversation exports belong only in the ignored [private sample
directory](benchmarks/conversation-render/real_examples/README.md) for optional local replay.
Reports and screenshots can contain the same private content.

Tests create their own Chrome profile, random service ports, and storage. Callers acquire these
resources explicitly and own their lifecycle.

### Local HTTPS fixtures

`fixtures/tls/` contains public test certificates and keys for isolated loopback servers. Keep their
use confined to those servers and profiles. Test browsers ignore their certificate errors and route
provider domains to a local receiver.

## Browser failures

Use `npm test -- report` to open `tests/results/playwright-report/`. Trace files, screenshots and
error context are under `tests/results/playwright/`. Page exceptions and `console.error` fail a
test; traces are retained on failure.

Default traces include API calls and network events. Set `QINGZHOU_TEST_TRACE_SNAPSHOTS=1` to also
record DOM snapshots, screencasts and sources for visual debugging. Failure screenshots, layout
assertions, locale/viewport matrices and coverage collection run in both modes.

The next Playwright run clears its output. Copy evidence you need to another ignored
`tests/results/` directory before rerunning. Reproduce a failing scenario narrowly, then run its
affected suite. Visual evidence should include page errors, geometry and both color schemes; include
narrow panels and RTL when text or direction can affect the layout.

## Real model tests

Select `live` explicitly to run real-provider tests. These calls can incur charges. Copy
[`.env.example`](../.env.example) to the ignored root `.env.local`, set its permissions to `600`,
and fill only the keys needed for the selected Provider.

```bash
npm test -- live agent --cases document_pipeline,network_form_edge
npm test -- live agent --suite journeys
npm test -- live realworld
npm test -- live deepseek
npm test -- live rate
npm test -- live cli-mcp --duration-seconds 1800
```

`agent` calls a real model against constructed pages; `realworld` and `cli-mcp` visit public sites.
`deepseek` checks extension lifecycle and stream behavior; `rate` checks Provider throttling.
`cli-mcp` runs English research, data, document, and interaction tasks with real DeepSeek responses
through CLI and MCP in one isolated Chrome profile. Its 30-minute clock starts after setup; individual
task failures are recorded and cancelled before the next task. It saves transcripts, downloads,
acceptance results, and redacted provider request metadata under `tests/results/mcp-bridge/`.
Set `QINGZHOU_DEEPSEEK_MODEL` to select a model. Use `--cases id,id` or
`--task-timeout-seconds 360` to narrow a follow-up run. While that isolated run is active,
`npm test -- live cli-mcp-supplement --report <live-soak-report.json>` checks MCP-created input
through CLI responses and compares resource exports across the two interfaces.
Without a scenario, `live` selects DeepSeek extension tests and real-world Agent tests. Use `--list`
to inspect the selection. Provider and model overrides are accepted by `agent`; see
[`background/agent-behavior-e2e.mjs`](background/agent-behavior-e2e.mjs).

`agent --suite all` runs the base, journey and real-world cases. Vision cases require a separate
`agent --suite journeys-vision --vision` run; language variants are also separate runs as shown
below. The full matrix has 35 distinct cases and nine additional English, Japanese and Arabic
variants. Keep the initial reports alongside any rerun reports. Use `agent --cases
navigation_readiness_plain,navigation_readiness_watched` for immediate article reads after delayed
opens, navigation, same-URL reloads and redirects. These cases require every first read immediately
after navigation to return the new document.

For the extended session-management checks, run `live deepseek` with
`QINGZHOU_LIVE_SESSION_MANAGEMENT=1 QINGZHOU_LIVE_SESSION_MANAGEMENT_EXTENDED=1`. The ordinary
lifecycle run and this management run use separate temporary profiles. Set `QINGZHOU_LIVE_REPORT` to
an output JSON path for `live deepseek` or `live rate` to retain success and failure evidence; the
parent directory must already exist.

Key precedence is an explicit key file (`--ak-file` / `--key-file` or the corresponding file
variable), the provider environment variable, then root `.env.local`. The explicit live invocation
loads the chosen key into a temporary profile and removes that profile on exit.

Add `--capture-dir tests/results/agent/captures` to save each case's transcript, acceptance evidence
and Data readback, including failed cases. Credentials are redacted before writing. Validate actual
business results through page state, stored data, and tool output.

```bash
npm test -- live agent --suite all --language ja \
  --cases goal_driven_pagination,document_pipeline,parallel_subtasks --concurrency 2 \
  --capture-dir tests/results/agent/ja/captures --report tests/results/agent/ja/report.json
```

Language runs save through the real settings UI before sending the task. English, Japanese and
Arabic prompts cover these three cases; unsupported case/language pairs fail explicitly. Business
acceptance and human language review remain separate. Additional Provider parameter checks use the
explicit [`live/model-parameters.mjs`](live/model-parameters.mjs) entry.

Run the focused DeepSeek vision regression against a local canvas in an isolated Chrome profile:

```bash
node --import tsx tests/live/deepseek-vision.mjs
node --import tsx tests/live/deepseek-vision.mjs --steps 30
```

It uses `deepseek-flash` by default (`QINGZHOU_DEEPSEEK_MODEL` overrides it). The default nine-step
run checks the first image-window eviction; `--steps 30` exercises repeated evictions in one Agent
run. Every step requires a fresh screenshot and a correct visual click, with the 2560×1440 →
2048×1152 coordinate mapping and 2 MiB image limit checked independently. The canvas uses a fixed
viewport; scrolling has separate page-tool coverage. Redacted request counts, pruning checkpoints,
click evidence and a final screenshot are saved under `tests/results/deepseek-vision/` for nine
steps and its `retention-30/` subdirectory for thirty. The script removes its temporary profile on
exit.

## Behavior evidence

[BEHAVIOR_INDEX.md](BEHAVIOR_INDEX.md) is the single map from user/Agent workflows to tests. Add the
observable outcome, failure recovery and evidence there when adding a feature:

```bash
npm test -- behavior --journey H03,A07
npm test -- behavior --actor human --layer browser
npm test -- behavior --coverage strong,medium --list
```

The runner deduplicates commands. Live services and explicit gap probes remain `skipped-explicit`
unless `--include-explicit` is requested with the needed authorization and credentials. Missing
dependencies fail the gate. Reports go to `tests/results/behavior/latest.json`; `evidence-passed`
means the selected tests passed, while coverage maturity remains the index's separate assessment.

Behavior runs use one Playwright worker by default; `QINGZHOU_BEHAVIOR_PLAYWRIGHT_WORKERS` allows up
to four for deliberate concurrency checks. Benchmark evidence retains its own performance gates.

## Release checks

`npm test -- release` checks the actual build and packaged ZIP locally. It covers fixed entries,
deterministic output, stale-file cleanup, notices, source-map separation and private-data scanning.
Git packaging uses scripts, declarations and lockfiles from the same commit. The Chrome smoke test
loads the compressed Web Store package and exercises Worker, panel, Data and restart behavior.
Archive tests compare both targets and check missing resources, debug-file leaks, and invalid ZIP
paths. See [package commands](../docs/commands.md#package-a-version) for source selection.

## Coverage

`verify` collects Node V8 and Playwright coverage during the same full test run, then checks module
thresholds. `--coverage` requires unfiltered `unit` or `--all`:

```bash
npm test -- unit --coverage
open tests/results/coverage/index.html
```

Reports include all first-party source, with unloaded files at 0%. Module gates prevent a high
global percentage from hiding gaps. Test event ordering, cancellation, and compatibility at runtime.

## Benchmarks and visual checks

[Benchmarks](../docs/benchmarks.md) covers conversation replay, seeded scrolling, Data Grid,
Markdown streaming, Provider timing replay, production loading, CSS comparisons and article
extraction. Run the relevant synthetic benchmark for stream, motion, timeline or virtualized-grid
changes.

The browser viewport fuzz uses 60 fixed-seed cases across three windows and six font sizes. To
replay private samples, place a JSON array of paths in the ignored `tests/results/corpus.json`:

```bash
QINGZHOU_FUZZ_CORPUS=tests/results/corpus.json npm test -- playwright \
  tests/browser/viewport-stability-fuzz.spec.mjs --repeat-each=3 --workers=1
```

Paths may be absolute or relative to the repository. Each seed is reproducible; evidence goes to the
Playwright case output. Keep the path list in `tests/results/`; `real_examples/` holds conversation
exports. Geometry tests cover layout changes; transient operating-system/GPU flicker still needs
manual review.

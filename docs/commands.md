# Commands

Run these commands from the repository root with Node.js 24 LTS. Use `npm ci` to install the
versions in the lockfile. Build, test, and benchmark commands accept `--help`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch source files and rebuild `dist/extension/` |
| `npm run build` | Type-check and build the extension |
| `npm run typecheck` | Check TypeScript without a production build |
| `npm test` | Run unit, contract, service, and browser tests |
| `npm run verify` | Run type checking, all automated test suites, and coverage checks |
| `npm run verify:quick` | Run type checking and all automated test suites, omitting coverage gates |
| `npm run benchmark` | Measure conversation rendering; arguments select other benchmarks |
| `npm run docs` | Generate the API reference at `dist/docs/api.md` |
| `npm run doctor` | Check the local tools, dependencies, and test browser |
| `npm run release` | Build a versioned ZIP locally |
| `npm run qz -- --help` | Show the local CLI commands for tasks, resources, and MCP |

For npm installation and installed CLI usage, see the
[CLI and MCP guide](cli.md#quick-start).

## Build the extension

```bash
npm ci
npm run build
```

Load `dist/extension/` from Chrome's **Load unpacked** button. For development, run `npm run dev`
and reload the extension after each rebuild. Stop the watcher before running `build`; both use the
same output directory. If you need them at the same time, use `--output-dir` to choose another
directory. `npm run build -- --help` lists build options; `--json` emits metadata for scripts. On
failure, the last successful output stays available. A watcher owns its output until it exits; stale
locks are recovered only after confirming the owner is gone. Restart `dev` after changing build
scripts.

The public `key` in [`src/manifest.json`](../src/manifest.json) fixes the unpacked extension ID to
`ghbaodmonhcgkfeejcpffknlggbjhjgj` across checkout and installation paths. Preserve this key across
builds and releases. See Chrome's [manifest key reference](https://developer.chrome.com/docs/extensions/reference/manifest/key).

## Run tests

Tests need Python 3.11+, uv, and the Chromium version installed by Playwright:

```bash
npx playwright install chromium
npm run doctor
npm test
```

On Linux, `npx playwright install-deps chromium` installs missing browser system libraries. These
tests use synthetic data and local services.

To work on one part of the project:

```bash
npm test -- unit contracts
npm test -- unit --match session
npm test -- browser --list
npm test -- playwright renderer-lifecycle.spec.mjs --workers 1
npm test -- grid
```

The suites are `unit`, `contracts`, `services`, `browser`, `e2e`, `release`, and `visual`. `--match`
filters unit filenames or suite commands. `--list` shows what would run. `browser` includes
Playwright, Python page smoke tests, and Data Grid tests; `playwright` runs only Playwright and
accepts its own options.

Before submitting ordinary code changes, run `npm run verify:quick` and set
`QINGZHOU_PLAYWRIGHT_WORKERS` to the available core count (`$(nproc)` on Linux). Run `npm run verify`
for packaging, releases, and coverage gates. For documentation changes, check commands, links, and
examples. For narrower coverage checks, use `npm test -- unit --coverage`. On a busy machine,
`npm test -- --all --jobs 1` runs suites sequentially.

Reports go to `tests/results/`. Use `npm test -- report` to open the Playwright report, or `npm test
-- behavior --journey H03,A07` to run the tests linked to those entries in the [behavior
index](../tests/BEHAVIOR_INDEX.md). See [tests/README.md](../tests/README.md) for details.

### Continuous integration

[GitHub Actions](../.github/workflows/ci.yml) runs type-checked builds and focused Tool and Renderer
browser contract tests on Linux, macOS and Windows. Run `npm run verify` locally for the full
test suites and coverage gates.

## Run against a real model

Live tests call a provider and may incur charges. They run only when you explicitly select `live`.
Keep keys in the ignored root `.env.local`, with file permissions `600`; the variable names are in
[`.env.example`](../.env.example).

```bash
npm test -- live agent --cases document_pipeline,network_form_edge
npm test -- live agent --suite journeys
npm test -- live agent --suite all --language ja --cases goal_driven_pagination,document_pipeline,parallel_subtasks
npm test -- live realworld
npm test -- live deepseek
npm test -- live rate
```

`agent` uses test pages; `realworld` visits real websites. `deepseek` checks the extension
lifecycle, and `rate` checks request throttling. Without a target, `npm test -- live` runs the
DeepSeek extension and real-world tests. See [live tests](../tests/README.md#real-model-tests) for
provider settings and isolation.

## Measure performance

```bash
npm run benchmark
npm run benchmark -- conversation --mode snapshot-render
npm run benchmark -- conversation --real-examples
npm run benchmark -- grid --rows 10000 --cols 20
npm run benchmark -- stream
npm run benchmark -- rate /path/to/session-export.html
```

The default is `conversation`. `grid` measures large tables, `stream` measures streaming Markdown,
and `rate` replays recorded request timing from an export. Keep real conversation exports in the
[ignored sample directory](../tests/benchmarks/conversation-render/real_examples/README.md). See the
[benchmark guide](benchmarks.md) for options and performance limits.

## Package a version

The release command builds a ZIP locally from committed Git `HEAD`:

```bash
npm run release -- --version 0.0.0.1 --summary "Local package preview"
```

Packaging installs the selected commit's locked dependencies and builds in a temporary directory. It
preserves the source manifest and writes the ZIP, README, and metadata to
`dist/releases/<version>/`. The install archive is `qz-browser-agent-extension-<version>.zip`,
with the extension under `qz-browser-agent-extension/`. The debug archive is
`qz-browser-agent-extension-<version>.debug.zip`. Distribution and Git tags are separate maintainer steps.

For a Chrome Web Store upload, select the `webstore` target:

```bash
npm run release -- --version 0.0.0.1 --target webstore
```

This writes `dist/releases/<version>/webstore/qz-browser-agent-extension-<version>.webstore.zip`
with `manifest.json` at the ZIP root. Upload this ZIP in the Chrome Developer Dashboard.
The Web Store target removes `key` from the packaged manifest. Source and manual packages retain
their public key to keep a stable extension ID during local development.
Both targets use the same runtime files. The default `manual` target keeps the installation folder;
each target has its own metadata and debug archive. The Web Store ZIP contains runtime files and
licenses; its release metadata and source maps stay alongside it. Packaging checks the single root manifest,
its referenced resources, ZIP integrity, upload size, and separation of development files.

JavaScript uses standard Terser minification, including variable shortening. `--no-minify` disables
the final Terser pass for diagnostics. Build-time script compilation retains its production settings.
Store review also covers runtime behavior, permissions, and data disclosures; this target validates
the upload package.

Use `--source worktree` to preview local edits, or `--git-ref` for another commit containing the
packaging toolchain. Scripts and dependencies come from the selected source.

Before distributing a version, obtain authorization for it, confirm the intended commit and an
unused Chrome-compatible numeric version, then run `npm ci`, `npm run doctor`, and `npm run verify`.
Package the committed source and check the output:

- `version.json` records `source: "git"` and the intended `gitCommit`.
- `target` and `packageRoot` identify the archive layout; `minification` records the Terser pass.
- Bundling and minification are enabled; runtime entries, assets, and licenses are complete.
- File counts, sizes, and SHA-256 match the package.
- The install ZIP contains compiled runtime files, licenses, and notices. Source maps are in the debug archive.

Load the ZIP's contents in an isolated Chrome profile and check the installed extension. Keep the
local `.debug.zip` with the release: it contains source maps and matching runtime hashes. Verify
those hashes before loading maps and review the source before sharing the archive.

`npm test -- release` checks deterministic output, resource integrity, obsolete-file cleanup,
license notices, and the actual minified ZIP in isolated Chrome. Fix failures with the normal
bundling and minification enabled, then rerun the affected gates. Release corrections under a new
patch version; published artifacts and tags remain immutable.

## Dependencies and static resources

Import npm dependencies from TypeScript and pin them in the root lockfile. Ordinary dependencies are
bundled with their Chrome runtime. PDF.js, MathJax and other resources loaded by URL are copied by
[vendor/assets.mjs](../scripts/vendor/assets.mjs), together with their licenses and source maps.

Each build records actual compiler inputs, including transitive dependencies, in
`vendor/provenance.json`. It contains package versions, upstream integrity and output hashes. Build
and release checks verify those hashes; copied assets and licenses must remain byte-for-byte
upstream copies. Bundling/minification only refresh provenance for compiler-owned files. Release
moves maps to the debug archive and removes their entries from installed provenance. See
[third-party notices](../THIRD_PARTY_NOTICES.md).

For a package published without its license text, [license
supplements](../scripts/vendor/licenses/supplements.json) pin the exact version, upstream commit and
license hash. Review the supplement again when upgrading.

## Other tools

Connect a local MCP client or use qz from the terminal:

```bash
npm run qz -- connect
npm run qz -- status
npm run qz -- browsers
npm run qz -- mcp
npm run qz -- create "Summarize the current page." --wait
npm run qz -- create "Compare these two laptops." --title "Research" --stream
npm run qz -- send TASK_ID "Add the source links." --stream
npm run qz -- send TASK_ID "Focus on open-source options." --steer --stream
npm run qz -- tasks
npm run qz -- show TASK_ID
npm run qz -- submit TASK_ID '{"selectedIds":["option-a"]}' --stream
npm run qz -- approve TASK_ID --wait
npm run qz -- reject TASK_ID
npm run qz -- watch TASK_ID --stream
npm run qz -- cancel TASK_ID
npm run qz -- data
npm run qz -- data export TABLE --format xlsx
npm run qz -- images export COLLECTION
npm run qz -- skills --query research
npm run qz -- skills export NAME
npm run qz -- settings get model
npm run qz -- settings set vision true
npm run qz -- automations
npm run qz -- stop
```

`connect` starts the local service and opens its connection page for first pairing. The first
browser is named `default`; repeating the command reuses an online connection. `status` shows the
actual service address and `mcp` prints its MCP URL. The default port is 18765, with a free-port
fallback when occupied; `connect --port PORT` requests another port. A running service keeps its
existing address. Use the reported address when connecting another profile.

To pair a chosen browser Profile from the shell:

```bash
npm run qz -- connect --no-open --name work --json
```

Open `result.url` in that Profile and verify its online UUID with `browsers --json`.
`--no-open` returns the URL immediately. `--name` sets or updates the identifier of the Profile
opening it; omit it to preserve an existing name or allocate `default`, `browser-2`, and so on.
`connect --name work` opens the URL and also returns without waiting for pairing. Neither mode
accepts `--client`. See [platform launch commands](cli.md#pair-a-selected-browser-from-the-shell).
Pairing is also available in **qz Settings → Advanced → CLI**.

`--client NAME|UUID` selects a browser for task and resource commands. With one online browser,
selection is automatic; with several, it is required. Unknown or offline selections fail without
falling back. Names are persistent and case-sensitive. Disconnect one profile in its qz Settings;
`stop` stops the service and disconnects all browsers. To release an offline name, run
`npm run qz -- browsers forget NAME`. Each command and its suggested next steps remain bound to
the resolved profile UUID.

Connections require opening a pairing URL or the settings action. Ordinary connection failures
pause after three attempts; reopen the URL in that Profile or use its settings to retry. Use the current CLI and extension together. Source edits do not
restart a working service. To update, finish current tasks, run `stop`, update and reload the extension, then run `connect`. See
[connection and upgrade details](cli.md#connect-and-stop).

`create` accepts the task text directly, with an optional title.
`--wait` follows the task across runs until its current work and accepted follow-ups and steering
messages have completed and its queues are empty; `--stream` also displays progress. Both stay
connected through questions and permission requests, then continue automatically after you respond.
Pending output includes the full request, field IDs, option values, and a submission template. Use `show TASK_ID` to
read the request again, answer fields with `submit`, continue a confirmation with
`approve`, or decline it with `reject`. Responses bind to the current wait; `--wait-id ID` selects a
specific request. `submit`, `approve`, and `reject` also accept `--wait` and `--stream`. Review the displayed
application consent notice before approving. Native Chrome permissions require a click in the
side panel; the CLI preserves the wait and tells you where to confirm. Respond in the side panel or
another terminal while the original command keeps watching. `watch` follows an existing task with
the same completion condition. Task failure or stopping ends observation.
Task observation has no default time limit. Add `--timeout SECONDS` to set a total deadline,
including user-input pauses. Each individual connection request remains bounded (180 seconds by
default). Timeout or Ctrl-C ends watching; execute the returned `watch` recovery command with the
same task ID and browser UUID to resume observation. Observation never resends a message.
`cancel TASK_ID` stops the task.

If the selected browser has no matching task, `show` fails with `task_not_found` and exit code 1.
`watch` reports `task_deleted` and suggests listing tasks for the same browser UUID. Check the ID
and browser selection with `tasks --client CLIENT_UUID` and `browsers` before watching again.

`send TASK_ID MESSAGE` follows up on a specific task and supports the same waiting options. A busy
task queues the follow-up for its next run. Add `--steer` to deliver the message to the current run
at its next safe boundary. Both start a new run when idle; pending questions and permissions still
require a response. Streaming shows responses after the submitted message.

`data` and `images` list, export, or delete saved tables and image collections. Table exports support
`xlsx` (default) and `csv`; image collections and individual user-installed Skills export as ZIPs
through Chrome downloads. `skills` lists or searches installed Skills; `skills show NAME` reads one,
`skills read NAME PATH` reads a resource in chunks, and `skills tools -s TASK_ID` lists contributions.
`settings` reads redacted configuration and editable fields; `settings set KEY VALUE` updates a
field, and `settings set -` reads a JSON patch from stdin. Use stdin for credentials.
`automations` lists saved automations, and `automations run ID` starts one. Export results include
the download status and path when available; check pending downloads in `chrome://downloads`.

Exports accept `--filename NAME`; `skills --scope site` filters Skills by scope. CLI commands reuse
one MCP connection for all their requests. Use `--client NAME|UUID` to select a profile from `browsers`.
MCP supports the same task waiting, streaming, and input flows, plus direct browser tool calls and
diagnostic logs; see the [operation mapping](cli.md#task-and-resource-operations).

Interactive terminals show text; pipes receive JSON. `--json` and `--plain` select the output
format explicitly. `--no-color` or `NO_COLOR` disables color. JSON waiting and streaming produce one
final result on stdout, with pending-input notices on stderr. The installed CLI requires Node.js 22 or later.
See the [CLI and MCP reference](cli.md) for short options, stdin input, and
MCP browser tools.

```bash
node scripts/source-inventory.mjs --baseline <git-ref> --check-reduction
node scripts/vendor/assets.mjs --check
```

The first command compares source size against a commit; the second checks that installed runtime
dependencies match the lockfile. For setup outside the extension, see the [local MCP
bridge](../services/mcp-bridge/README.md).

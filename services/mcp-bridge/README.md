# qz command line and MCP

Run browser tasks, manage results, and connect external agents to qz through CLI or MCP.
Requires Node.js 24 or later and Chrome. CLI and MCP share the same browser connection.

## Quick start

Run the published package with npx:

```bash
npx qz-browser-agent@latest install
npx qz-browser-agent@latest connect
npx qz-browser-agent@latest create "Summarize the current page." --stream
```

`install` opens the [latest extension release](https://github.com/alibaba/qz-browser-agent/releases/latest).
Extract its ZIP, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
Select the extracted extension folder. Open qz and accept its first-use data notice.

`connect` starts the local MCP service and opens a connection page if a browser has not connected.
Open that page in the Chrome profile where qz is installed. The connection page identifies the
local service to the extension; no token or DevTools configuration is required.

The examples and suggested next commands use `qz`. Replace it with
`npx qz-browser-agent@latest`, or install the command globally:

```sh
npm install --global qz-browser-agent@latest
qz --version
```

On Windows, use PowerShell 7.3 or newer with its default native argument passing. After a global
install, use `qz.ps1` for commands containing JSON or quoted names; Windows command suggestions
use that wrapper. For automation, pin an exact npm version such as `qz-browser-agent@0.1.0`.

## Connect and stop

```bash
qz connect
qz status
qz mcp
qz stop
```

`connect` reuses the healthy service already running for this installation and protocol. It prefers port
18765; if another program owns that port, it uses a free port chosen by the operating system.
It confirms that a browser responds before reporting success, and opens the connection page to
resume polling if a previously connected browser no longer responds.
`mcp` prints the actual MCP URL. `status` and `mcp` never start a service or open a browser.
`stop` shuts down the shared service and disconnects the extension and MCP clients.

After first-use consent, an unavailable local service gets up to three connection attempts.
Once a connection succeeds, later interruptions switch to one recovery attempt per minute after
three consecutive failed polls, using that same endpoint. Recovery continues across worker restarts;
disabling the bridge stops it. Run `qz connect` to retry immediately. Connected browsers use long polls
capped at 20 seconds and reload saved settings before each poll. The side panel and connection page
can be closed.

`status` distinguishes an unavailable local service from a running service with no connected
browser. A failed health check is retried once; an unresponsive live service is reported without
starting another instance. After updating the extension, reload it at `chrome://extensions` and
run `qz connect` to reconnect.

## Connect an MCP client

Run `qz connect`, then `qz mcp`. Copy the returned URL into your MCP client's HTTP configuration:

```toml
[mcp_servers.qz]
url = "http://127.0.0.1:18765/mcp"
```

Use the URL printed by your command if its port differs. `qz mcp --json` returns the URL as JSON
for scripts. The `qingzhou_*` MCP tool names and extension protocol remain available. Responses
to pending input bind to an explicit `waitId`. MCP initialization and streaming are handled by your
client's MCP implementation.

### Task and resource operations

CLI and MCP use the same task observer and browser operations. The task and resource commands map to these MCP operations:

| CLI | MCP tool |
| --- | --- |
| `create`, `send`, `cancel` | `qingzhou_create_session`, `qingzhou_send_message`, `qingzhou_stop_session` |
| `tasks`, `show`, `watch` | `qingzhou_list_sessions`, `qingzhou_get_session_snapshot`, `qingzhou_watch_task` |
| `show`, `submit` / `approve` / `reject` | `qingzhou_get_session_snapshot`, `qingzhou_respond_to_user_input` |
| `data list` / `delete` / `export` | `qingzhou_list_data_tables`, `qingzhou_delete_data_table`, `qingzhou_export_data_table` |
| `images list` / `delete` / `export` | `qingzhou_list_image_collections`, `qingzhou_delete_image_collection`, `qingzhou_export_image_collection` |
| `skills list` / `show` / `read` / `tools` / `export` | `qingzhou_list_skills`, `qingzhou_get_skill`, `qingzhou_get_skill_resource`, `qingzhou_list_plugins`, `qingzhou_export_skill` |
| `settings get` / `set` | `qingzhou_get_settings`, `qingzhou_update_settings` |
| `automations list` / `run` | `qingzhou_list_automations`, `qingzhou_run_automation` |

MCP creation, message submission, and input responses accept `wait: true` to wait for completion;
`stream: true` also sends assistant text through standard MCP progress notifications. A watch call
always waits. For example, call `qingzhou_create_session` with:

```json
{"firstMessage":"Summarize the current page.","stream":true}
```

Supply `_meta.progressToken` on the MCP request to receive progress. Each notification includes a
readable `message` and its structured event in `params._meta["qz/task-event"]`. Events include
`created`, `status`, `text`, `replace`, and `input`. Input events include the current form, exact
field IDs, option values, and `responseTemplate`. Fill that template and pass it to
`qingzhou_respond_to_user_input`; another CLI or MCP connection can answer while the original call
keeps waiting. Native Chrome permissions still require the user's click in the side panel.

MCP `timeoutSeconds` bounds each browser request (180 seconds by default).
`waitTimeoutSeconds` bounds the whole observation; omit it for no overall deadline. Configure your
MCP client's own request deadline for long tasks. On timeout or cancellation, the browser task
continues; error details include the task ID and a recovery tool call. `send_message` supports
`steer: true` and follows its returned `clientMessageId`, including when steering stays in the same
run. A long observation stays bound to the browser selected when it started.

## Run a task

```bash
qz create "Compare these two laptops."
qz create "Summarize the current page." --title "Research" --wait
qz create "Find the main differences between these pages." --stream
qz send TASK_ID "Add the source links." --stream
qz send TASK_ID "Focus on open-source options." --steer --stream
qz tasks
qz show TASK_ID
qz cancel TASK_ID
```

`create` starts a task and returns its ID. The title is optional. `--wait` waits for the result;
`--stream` also displays progress as it arrives. Both stay connected while the task waits for user
input and continue automatically after you respond. Task observation has no default time limit.
Add `--timeout SECONDS` to set a total deadline, including time spent waiting for input. Each
individual connection request remains bounded (180 seconds by default). A timeout or Ctrl-C ends
watching; `qz watch TASK_ID --stream` resumes observation and `qz cancel TASK_ID` stops the task.
Each CLI command initializes one MCP connection on its first tool call and reuses it for subsequent
reads and responses. Completion, errors, and Ctrl-C close that connection. Transport failures are
reported without automatically repeating browser actions.

Provide the task text directly after `create`, or read it from stdin with `qz create -`.
Use `--parent TASK_ID` to create a child task, and `qz tasks --limit N` to limit the task list.
`send TASK_ID MESSAGE` sends a follow-up to the specified task; `qz send TASK_ID -` reads the message
from stdin. A busy task queues a follow-up for its next run. Add `--steer` to deliver the message
to the current run at its next safe boundary. Both start a new run when the task is idle. Pending
questions and permissions still require a response.

`--wait` and `--stream` track the submitted message. Streaming starts after that message, including
when steering continues the same run. Pending questions from the preceding run remain visible so
you can answer them and let a queued follow-up proceed. A connection failure never resends a message
automatically.

## Respond to a task

```bash
qz show TASK_ID
qz submit TASK_ID '{"selectedIds":["option-a"]}' --stream
qz approve TASK_ID --wait
qz reject TASK_ID
qz watch TASK_ID --stream
```

`show` and pending-input notices include the current question, labeled field IDs,
option values, descriptions, image URLs, and a submission template with the actual field IDs.
Edit its placeholder values and run the displayed command to respond. `submit` takes a JSON object
keyed by field IDs; use option values for choices and arrays for multiple choices. Use
`qz submit TASK_ID -` to read answers from stdin. Invalid or stale submissions return the current
input and its template so you can correct the response directly.
`approve` continues a confirmation after you finish the requested action. `reject` declines the
current request; `cancel` stops the whole task.

Each response reads the current wait ID before sending. To answer a specific request you already
read, pass `--wait-id WAIT_ID` to `submit`, `approve`, or `reject`. A stale or invalid response
leaves the request pending. Review the application consent notice included in the pending input,
such as location sharing, before approving. Native Chrome permissions require a click in the qz side panel; CLI
approval reports that action is needed and preserves the wait without opening a browser page.
With `--wait` or `--stream`, the command stays connected while you grant permission in Chrome.
Location approval reads the current disclosure version and includes it in the response. Human
terminal output shows the notice before submitting the explicit approval; JSON output remains a
single final result. MCP callers should show the notice to the user before sending approval with
the returned `consentVersion`.

`submit`, `approve`, and `reject` accept `--wait` and `--stream` to follow the task until it finishes, including
further questions and permission requests. Each new request is shown once. Respond in the side
panel or another terminal; the original command continues automatically. `watch` follows an
existing task without resubmitting anything. Timeouts and Ctrl-C stop watching, while the task
continues in the browser.

## Browser selection and MCP tools

Use `--client ID` or `-c ID` to select a browser when several are connected. Find IDs in `qz status`.
Use `-t` for `--title`. Run `qz help COMMAND` or `qz COMMAND --help` for command-specific options.

MCP clients can inspect browser tool schemas with `qingzhou_list_tools` and `qingzhou_get_tool`,
then call `qingzhou_execute_tool` in a task. Set `wait: false` to receive a job ID and read the result
with `qingzhou_get_tool_job`. Pass `runId` to bind execution to a particular task run. MCP also
provides `qingzhou_get_trace` and `qingzhou_clear_trace` for diagnostics.

If a request times out or its connection is interrupted, an operation already started in the
browser may still be running. Check the task before repeating it. Disconnected MCP requests are
cancelled in the service, and reconnecting does not replay their browser actions.

## Data, images, and Skills

```bash
qz data
qz data export TABLE
qz data export TABLE --format csv
qz data delete TABLE
qz images
qz images export COLLECTION
qz images delete COLLECTION
qz skills --query research
qz skills show NAME
qz skills read NAME scripts/run.js --limit 20000
qz skills tools --session TASK_ID
qz skills export NAME
```

Use the exact names printed by each list; quote names containing spaces. Data exports default to
Excel (`xlsx`); `--format csv` selects CSV. Image collections export as a ZIP containing available
image files and metadata. Missing local images are reported in the result. Skill exports contain
one user-installed Skill and its resources; built-in Skills require the extension and cannot be
exported independently.

`skills show` includes the resource paths. `skills read NAME PATH` reads one resource, with a
default limit of 20,000 characters. Use `--start` and `--limit` to select a chunk; truncated text
includes the command for the next chunk. `skills tools` lists contributed tools and whether they
are active in the selected task's context.
`skills --scope all|global|site|resident` filters by activation scope. Exports accept `--filename NAME`.
`automations --limit N` limits the automation list.

Exports use Chrome downloads. The result includes the download status, ID, filename, and path when
Chrome provides it. Check pending downloads in `chrome://downloads`. `delete` removes the named table
or image collection and its rows. Image blobs shared by other collections or task history remain
in the asset store.

## Settings and automations

```bash
qz settings
qz settings get model
qz settings set model MODEL_ID
qz settings set vision true
qz settings set '{"modelParameters":{"temperature":0.5}}'
qz settings set - < settings.json
qz automations
qz automations run AUTOMATION_ID
```

`settings` returns current values, editable fields, provider IDs, and protocol IDs. Credentials are
redacted; `qz settings get apiKey` reports whether a key is configured. `set KEY VALUE` parses JSON
values such as booleans, numbers, objects, and arrays; other values are strings. `set JSON` applies
a patch containing the supplied top-level fields. Follow the field descriptions for values that
replace an entire object, such as `modelParameters`.

Read credential patches from stdin to keep them out of shell history. JSON is validated before
connecting. The extension validates field names and values before saving. All commands accept
`--client ID` to select a browser profile. `automations run` starts an existing automation and
returns its task ID.

The CLI uses the same browser operations as MCP. Its commands correspond to tasks, data,
images, Skills, settings, and automations. `qz mcp` only returns the connection URL for MCP
clients.

## Terminal output

Interactive terminals show readable text; pipes and redirected output receive JSON. Use `--json`
to request JSON explicitly or `--plain` to keep text when redirecting output. `--no-color` or the
`NO_COLOR` environment variable disables color. `qz mcp` prints only the MCP URL by default;
`qz mcp --json` returns a JSON result.

In JSON mode, `--wait` and `--stream` emit one final JSON result on stdout. Complete pending-input
notices and submission templates appear on stderr so you can respond while preserving
machine-readable output. MCP snapshots and rejected responses include `input`, with a
`responseTemplate` that binds answers to the current session and wait. Chrome-native permission
requests provide user instructions instead of an approval template.
Exit codes are `0` for success (including reading pending input), `1` for an operation or
task failure or a rejected submission, `2` for invalid arguments, and `130` for Ctrl-C.
Connection errors include the GitHub setup guide and installation link.

## Local access

The service listens on loopback. It validates Host and Origin, rejects redirects, and accepts
extension polling only from extension origins or local clients. Ordinary websites cannot send
requests through the MCP endpoint. Local programs can control connected qz tasks while the
service is running. Run `qz stop` to disconnect.

Connection metadata is stored in `~/.qz-browser-agent/run/`; `QZ_STATE_DIR` selects another local
directory for isolated tests. Atomic startup locks prevent duplicate services. Development copies
and published installations use separate identities. The client verifies the service identity,
protocol version, instance, and process before reusing or stopping it. Editing source files or
running a newer package keeps the healthy service and its connections alive. `status` reports
when a different build is available. To load the new service code, finish active work, run
`qz stop`, then `qz connect`.

## Package development

The npm package name is `qz-browser-agent`; the executable name is `qz`. Local development uses
this same package name. The repository root stays private, and this service directory is the
publishable package. Publishing requires separate authorization and ownership of the npm name.

From the repository root, install the locked dependencies and run the local source:

```bash
npm ci
npm run qz -- --version
npm run qz -- connect
npm run qz -- create "Summarize the current page." --stream
```

Keep the `--` separator when forwarding options through npm. For a local `qz` executable,
run `npm link` in `services/mcp-bridge`. JavaScript runs directly on Node.js. The published
package contains the runtime files, tool catalog, README, and license.

```bash
npm test -- services --match node
node tests/release/npm-package.mjs
```

The package check packs the service and installs that tarball in two clean temporary directories
using the public npm registry. It checks the installed command, versions, MCP tools, service reuse,
and shutdown on an isolated port. The test owns its npm configuration, cache, connection state,
and service process. It requires network access to download dependencies.

Use `--output tests/results/npm/qz-browser-agent-0.1.0.tgz` to retain the verified tarball.
Use `--tarball PATH` to check an existing tarball. The check also runs through
`npm test -- release --match npm-package`.

## Publish to npm

Choose the package version in `services/mcp-bridge/package.json`, complete the repository checks,
and commit the intended source before publishing. CLI and MCP report that same package version.
Each published version identifies immutable package contents; use a new version for updates.

The **npm package** GitHub Actions workflow tests the CLI and the installed package on Linux,
macOS, and Windows. On a manual run, provide the expected version. With **publish** left unchecked,
it only validates the package and retains the tested tarball. Publishing requires a manual run
from `main` with **publish** checked; all three platforms must pass first.

Configure the npm package's trusted publisher for the `alibaba/qz-browser-agent` repository,
workflow `npm-package.yml`, and GitHub environment `npm`. Enable direct publishing in that
trusted publisher configuration. The publish job uses OIDC and uploads the exact Linux-tested
tarball. The npm package must be created under an account with publishing rights before this
trusted publisher can be configured. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

For the first manual release, log in with npm, verify the saved tarball, and publish it:

```bash
npm login --registry=https://registry.npmjs.org
node tests/release/npm-package.mjs --output tests/results/npm/qz-browser-agent-0.1.0.tgz
npm publish tests/results/npm/qz-browser-agent-0.1.0.tgz --access public --registry=https://registry.npmjs.org
```

The root package stays private. Publishing the service does not publish the Chrome extension.
After publication, check `npx qz-browser-agent@0.1.0 --version` from a directory outside the repository.

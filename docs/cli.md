# qz CLI and MCP reference

Run browser tasks, manage results, and connect external agents to qz through CLI or MCP.
For a short overview, see the [package README](../services/mcp-bridge/README.md).
Requires Node.js 22 or later. CLI and MCP share one local daemon. Each paired browser profile
has its own connection.

The daemon is [`services/mcp-bridge`](../services/mcp-bridge/README.md). From this repository the
command is `npm run qz`. The published command is `qz`. The daemon is not copied into
`dist/extension/` or `dist/extension-firefox/`. Chrome loads the first directory. Firefox loads
the second. Package layout is in [Firefox packaging](firefox-packaging.md). The command list is
in [Commands](commands.md).

## Quick start

Install [qz from the Chrome Web Store](https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm)
with **Add to Chrome**. Open the qz side panel, accept the data notice shown on first use, and configure
your provider and model in Settings. A development build in Firefox uses
[Load qz in Firefox](#load-qz-in-firefox) instead of the store.

Run the published package with npx:

```bash
npx qz-browser-agent@latest create "Summarize the current page." --stream
```

`npx qz-browser-agent@latest install` opens the same Chrome Web Store page. For a manual ZIP
installation, download the [latest GitHub release](https://github.com/alibaba/qz-browser-agent/releases/latest)
and follow the [manual installation steps](https://github.com/alibaba/qz-browser-agent/blob/main/README.md#manual-installation).

Browser operations prepare their connection automatically. They reuse a responding online browser,
or open the connection page once in the system default browser, then wait for its extension to
respond. When qz does not respond there, the page links to the Chrome Web Store and shows its URL
with a copy button for a browser profile that already has qz. A pending connection error includes
the same URL; open it in that profile and retry, or use `qz connect uri` to pair a specific profile.
Complete the first-use notice and connection prompt when needed. Use `qz connect uri` to print a URL
for a specific profile without opening it.
The first new profile is named `default`; an existing profile retains its name.

The examples and suggested next commands use `qz`. Replace it with
`npx qz-browser-agent@latest`, or install the command globally:

```sh
npm install --global qz-browser-agent@latest
qz --version
```

On Windows, use PowerShell 7.3 or newer with its default native argument passing. After a global
install, use `qz.ps1` for commands containing JSON or quoted names; Windows command suggestions
use that wrapper. For automation, pin a compatible release version verified with your extension.

## Load qz in Firefox

One daemon serves both packages. Build the Firefox package and load it for this session.
Pairing uses **Connect CLI** or a pairing URL.

```bash
npm run build:firefox
```

`npm run dev:firefox` watches `dist/extension-firefox/` and leaves `dist/extension/` alone.
Load `dist/extension-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. The
clicks, the reload, and the fact that a temporary add-on is removed when Firefox exits are in
[Load temporarily in Firefox](commands.md#load-temporarily-in-firefox). The gecko id
`qz-browser-agent@heleifz.github.io` and the Chrome `key` are compared in
[Firefox packaging](firefox-packaging.md#identifiers).

Open the sidebar from the toolbar button, then pair:

1. In qz, open **Settings → Advanced → CLI → Connect CLI**. The service address is the one
   `qz status` prints. The default is `http://127.0.0.1:18765`.
2. Or run `qz connect uri --json` and open `result.url` in the Firefox profile that has
   the add-on. The URI command does not open a browser.

The settings sender accepts a `moz-extension://<host>/` page when `sender.id` is this add-on.
A web page URL is rejected.

The daemon allows two Origin shapes on extension routes
([`services/mcp-bridge/src/server.mjs`](../services/mcp-bridge/src/server.mjs)). A Chrome origin
remains `chrome-extension://` plus 32 characters from `a` to `p`. A Firefox origin is
`moz-extension://` plus a lowercase UUID. Firefox stores that UUID for gecko id
`qz-browser-agent@heleifz.github.io` in the profile pref `extensions.webextensions.uuids`.
`runtime.id` stays the gecko id. The bridge cannot derive the UUID from the gecko id, so the
origin check accepts the UUID shape and then the pairing token authenticates the profile.
The first `/v1/qingzhou/pair` from an allowed origin issues or checks that token. Later poll
and result calls require it. A web origin is rejected with `403` and `invalid bridge origin`.
A request to `/mcp` that carries any Origin is rejected. The daemon still binds to loopback.

### Check Connect CLI on a local Firefox

Use `npm run qz` from this checkout. Browser operations restart an incompatible local service once
before submitting any browser operation; compatible running services remain in use.

1. Run `npm run build:firefox`. In Firefox 154 or later, open
   `about:debugging#/runtime/this-firefox` and load `dist/extension-firefox/manifest.json`.
2. Open the sidebar and accept the data notice.
3. Run `npm run qz -- connect uri --json` and open `result.url` in that Firefox window.
4. The page reports the profile connected. `npm run qz -- browsers` lists it online.

**Settings → Advanced → CLI → Connect CLI** is the same check. Use the address `qz status` prints.

## Connection preparation

```bash
qz session create --title "Inspect a page"
qz status
qz browsers
qz mcp
```

Browser operations reuse a responding connection or prepare one automatically. The local service
prefers port 18765; if another program owns it, the service chooses a free port. `status` shows the
actual service address, and `mcp` prints its MCP URL. A protocol-incompatible service is restarted
once under its scope lock after verifying its process and instance identity. Build changes alone
do not restart compatible services. No submitted browser operation is replayed during recovery.

Without an explicit selection, a new task uses the first responding browser. An existing session
is located through read-only queries when several browsers are online; ambiguous ownership requires
`--client NAME|UUID`. An explicit selection never falls back to another browser. With no online
connection, the CLI opens the connection page once in the system default browser and waits there.
When the service confirms a browser is reconnecting, the CLI first waits for its lease recovery within
the command's timeout. If connection remains pending, check that page or use `qz connect uri` to pair
a chosen browser profile. Pairing requires the extension’s first-use notice and connection prompt.
The connection page updates while reconnecting, then counts down for three seconds and closes after
a successful connection.

To disconnect one browser, click **Disconnect: NAME** in its qz Settings. To cancel a task, use
`qz cancel TASK_ID`, or `qz session cancel ID` for a direct-drive session, adding --client when needed.
The extension retains browser tasks independently of the local service.

Run `qz cleanup` to stop registered local services from installed packages and development checkouts,
and remove their runtime files and logs. It uses `~/.qz-browser-agent/run/`, or `QZ_STATE_DIR` when set.
Browser registrations, tabs, tasks and saved data are preserved. The next browser command starts
its service automatically. Active CLI requests and direct-drive scripts are interrupted; side-panel
tasks continue. Unverified or busy entries are reported and preserved; incomplete cleanup
exits with code 1. Use `--json` for the per-service report.

In a sandbox with isolated process IDs, the CLI can reuse a host service when its runtime files
and localhost endpoint are accessible. Start and connect the service from a host terminal first
with `qz connect uri`. Run service cleanup or upgrades from the host terminal when the sandbox
cannot verify the service process.

### Pair a selected browser from the shell

Print a pairing URL without opening a browser, waiting for a connection or interrupting tasks:

```bash
qz connect uri
qz connect uri --name work --json
```

The first command prints the URL. With --json, read result.url. Open that exact URL in the browser
profile where qz is installed. --name names a new profile; --client NAME|UUID addresses a registered
profile and cannot be combined with --name. To request a custom service port, use --port; if the
service is already running on another port, it remains running and the command reports its address.

### Open the URL in Chrome

Set `QZ_PAIRING_URL` to that URL and `QZ_PROFILE_DIRECTORY` to the selected profile's directory
name, such as `Default` or `Profile 2`. These are directory names, not Chrome's display labels.
Use a profile already chosen by the user. On macOS:

```sh
open -na "Google Chrome" --args --profile-directory="$QZ_PROFILE_DIRECTORY" "$QZ_PAIRING_URL"
```

For Chrome on Linux:

```sh
google-chrome --profile-directory="$QZ_PROFILE_DIRECTORY" "$QZ_PAIRING_URL"
```

For Chrome installed under Program Files on Windows, set `$QzProfileDirectory` and
`$QzPairingUrl` to those same values in PowerShell:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" "--profile-directory=$QzProfileDirectory" $QzPairingUrl
```

Use the installed browser's executable or app name. For an existing custom data directory, also
pass `--user-data-dir` with its exact path; for example on macOS:

```sh
open -na "Google Chrome" --args --user-data-dir="$QZ_USER_DATA_DIR" --profile-directory="$QZ_PROFILE_DIRECTORY" "$QZ_PAIRING_URL"
```

The [Chrome profile documentation](https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md)
distinguishes the data directory from the profile inside it. A new data directory needs its own
extension installation and first-use setup.

### Open the URL in Firefox

A Firefox profile is the directory path shown in `about:profiles`. Load the temporary add-on in
that profile first. See [Load qz in Firefox](#load-qz-in-firefox).

```sh
firefox --profile "$QZ_FIREFOX_PROFILE" "$QZ_PAIRING_URL"
```

Use the installed Firefox executable when `firefox` is not on `PATH`. A new profile needs the
temporary add-on and first-use setup again. After the page opens, the sidebar background pairs
with the daemon. `qz browsers` lists that profile when the pair succeeds. See
[Check Connect CLI on a local Firefox](#check-connect-cli-on-a-local-firefox).

`--name work` adds `?name=work` to the URL. The profile opening it receives that identifier,
including when it already has a connection. Without `--name`, a registered profile keeps its name;
a new profile receives the next available name: `default`, `browser-2`, and so on. A name conflict
requires another name. `qz connect uri --name work` only prints the URL.
These URL-returning commands do not confirm that a browser connected. Verify it with:

```bash
qz browsers --json
qz create "Summarize the current page." --client UUID --stream
```

Read `result.browsers`, then use the intended online entry's `clientId` UUID. `--client` selects an
existing connection and cannot be combined with --name on the URI command. --port follows the
existing-service behavior above.

### Add and select browsers

You can also pair from **qz Settings → Advanced → CLI** in the intended profile. Enter a distinct
browser identifier and connect. Use the service address printed by `qz status` in **Local service address** if
its port differs from 18765. Names use 1–64 letters, digits, underscores, or hyphens, beginning with
a letter or digit; names are case-sensitive. UUID-shaped names are reserved for profile IDs.

```bash
qz browsers
qz create "Summarize the current page." --client work --stream
qz show TASK_ID --client work
qz data --client work
```

`--client NAME|UUID` and `-c NAME|UUID` select a profile. New tasks use the first responsive browser;
existing sessions are located through read-only queries when several browsers are online, and
ambiguous ownership requires a selection. `default` is a name, not a routing preference. An unknown
selection fails immediately; an offline selection waits for that UUID within the connection deadline
without opening or using another browser. Each command resolves its name once and carries the UUID through subsequent
requests. JSON task results and suggested next commands include that UUID.

Names remain registered while their browsers are offline and across service restarts. To release
an offline name, remove its registration explicitly:

```bash
qz browsers forget work
```

An online browser must first disconnect in its settings. Forgetting a registration leaves the
browser's tasks and data intact. A browser can then explicitly pair using the released name.

### Update the connection

Use the current CLI and extension together. Compatible running services remain in use after package
updates. Before browser operations, the CLI can replace a protocol-incompatible service once under
its scope lock, retaining the service address and paired identities. If the extension’s script API
is incompatible, update the CLI and extension together before retrying; no script is submitted.
Chrome store users update through the store; manual packages must be reloaded. Firefox development
packages are rebuilt with npm run build:firefox and reloaded at about:debugging.

## Connect an MCP client

Run `qz mcp` to start or reuse the local service. If the intended profile is not paired, open the URL
from `qz connect uri` there. Copy the MCP URL into your client’s HTTP configuration:

```toml
[mcp_servers.qz]
url = "http://127.0.0.1:18765/mcp"
```

Use the URL printed by your command if its port differs. `qz mcp --json` returns the URL as JSON
for scripts. The `qingzhou_*` MCP tool names and extension protocol remain available. Responses
to pending input bind to an explicit `waitId`. Use `qingzhou_bridge_status` to list browser names
and UUIDs, then pass `clientId: "work"` or a UUID to browser tools. Selection is required with
multiple online browsers. Task results include the resolved `clientId`. MCP initialization and streaming are handled by your
client's MCP implementation.

### Task and resource operations

CLI and MCP use the same task observer and browser operations. The task and resource commands map to these MCP operations:

| CLI | MCP tool |
| --- | --- |
| `browsers`, `browsers forget` | `qingzhou_bridge_status`, `qingzhou_forget_browser` |
| `create`, `send`, `cancel` | `qingzhou_create_session`, `qingzhou_send_message`, `qingzhou_stop_session` |
| `tasks`, `show`, `watch` | `qingzhou_list_sessions`, `qingzhou_get_session_snapshot`, `qingzhou_watch_task` |
| `show`, `submit` / `approve` / `reject` | `qingzhou_get_session_snapshot`, `qingzhou_respond_to_user_input` |
| `data list` / `delete` / `export` | `qingzhou_list_data_tables`, `qingzhou_delete_data_table`, `qingzhou_export_data_table` |
| `images list` / `delete` / `export` | `qingzhou_list_image_collections`, `qingzhou_delete_image_collection`, `qingzhou_export_image_collection` |
| `skills list` / `show` / `read` / `tools` / `export` | `qingzhou_list_skills`, `qingzhou_get_skill`, `qingzhou_get_skill_resource`, `qingzhou_list_plugins`, `qingzhou_export_skill` |
| `settings get` / `set` | `qingzhou_get_settings`, `qingzhou_update_settings` |
| `automations list` / `run` | `qingzhou_list_automations`, `qingzhou_run_automation` |

MCP creation, message submission, and input responses accept `wait: true` to observe the task until
its current work and accepted follow-ups and steering messages have finished. Observation follows
successive runs of the same task and succeeds when the task is completed and its queues are empty.
Messages accepted after that completion snapshot belong to later work.
`stream: true` also sends assistant text through standard MCP progress notifications. A watch call
uses the same completion condition and always waits. For example, call `qingzhou_create_session` with:

```json
{"firstMessage":"Summarize the current page.","stream":true}
```

Supply `_meta.progressToken` on the MCP request to receive progress. Each notification includes a
readable `message` and its structured event in `params._meta["qz/task-event"]`. Events include
`created`, `status`, `text`, `replace`, and `input`. Input events include the current form, exact
field IDs, option values, and `responseTemplate`. Fill that template and pass it to
`qingzhou_respond_to_user_input`; another CLI or MCP connection can answer while the original call
keeps waiting. A permission dialog the browser itself shows still needs a click in the side panel
or sidebar.

MCP `timeoutSeconds` bounds each browser request (180 seconds by default).
`waitTimeoutSeconds` bounds the whole observation; omit it for no overall deadline. Configure your
MCP client's own request deadline for long tasks. Task failure or stopping ends observation. On
timeout or cancellation, the browser task continues; execute the returned `qingzhou_watch_task`
recovery call with the same task and browser IDs to continue observing. Observation never resends
a message. `send_message` supports `steer: true`; its returned `clientMessageId` confirms acceptance
and sets the starting point for streamed responses, including within the same run. A long
observation stays bound to the browser selected when it started.

When a watched task is absent from the selected browser, `task_deleted` returns a
`qingzhou_list_sessions` recovery call for that same `clientId`. Check the task ID and browser
selection before watching again. The raw snapshot tool continues to return `session: null`
for a missing task.

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

`create` starts a task and returns its ID. The title is optional. `--wait` follows the task through
its current work and accepted follow-ups and steering messages, including successive runs.
`--stream` also displays progress as it arrives. Both succeed when the task is completed and its
queues are empty. Both stay connected while the task waits for user input and continue automatically
after you respond. Task failure or stopping ends observation. Task observation has no default time limit.
Add `--timeout SECONDS` to set a total deadline, including time spent waiting for input. Each
individual connection request remains bounded (180 seconds by default). A timeout or Ctrl-C ends
watching. Run the returned `qz watch TASK_ID --stream --client CLIENT_UUID` recovery command to
resume observation of the same task in the same browser; `qz cancel TASK_ID` stops the task.

`show` JSON includes `usage` for the whole task. `create --wait`, `send --wait`, `watch`, and the other waiting commands include the same object on `snapshot.usage`. The fields are `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`, `modelCalls`, `toolCalls`, `screenshots`, and `contextCompressions`. Token and cost totals sum the provider usage stored on each recorded model call, including context compression. `inputTokens` counts prompt tokens that were not read from cache, including tokens written into the cache. `cachedTokens` counts cache reads. `costUsd` is dollars reported by the provider (`cost_in_usd_ticks / 10^10`, or `cost_usd` when the provider reports dollars directly). A call that does not report a price adds zero. Sessions saved before this codec change did not keep cost fields, so `costUsd` is 0 for those historical calls. `toolCalls` counts tools that were invoked. `screenshots` counts completed successful calls whose name contains `screenshot`, and `act_on_screen` when it returns a screenshot. `contextCompressions` counts completed context compressions. `contextUsage` remains the latest context reading.

`show` returns `task_not_found` with exit code 1 when the selected browser has no matching task.
`watch` retains the `task_deleted` error code and directs you to `qz tasks --client CLIENT_UUID`.
Check the task ID and `qz browsers` before retrying; the task may have been deleted or belong to
another browser. Recovery commands keep the originally selected browser UUID.

Provide the task text directly after `create`, or read it from stdin with `qz create -`.
Use `--parent TASK_ID` to create a child task, and `qz tasks --limit N` to limit the task list.
`send TASK_ID MESSAGE` sends a follow-up to the specified task; `qz send TASK_ID -` reads the message
from stdin. A busy task queues a follow-up for its next run. Add `--steer` to deliver the message
to the current run at its next safe boundary. Both start a new run when the task is idle. Pending
questions and permissions still require a response.

The send response confirms acceptance and includes `clientMessageId`. `--wait` and `--stream`
follow the same task until its work is completed and its queues are empty. Removing an unconsumed
follow-up or steering message removes that work from the wait; observation can complete once the
remaining execution ends and the queues are empty. Streaming starts after the submitted message,
including when steering continues the same run, and follows later runs without repeating text.
Pending questions from the preceding run remain visible so you can answer them and let a queued
follow-up proceed. A connection failure never resends a message automatically.

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
such as location sharing, before approving. A permission dialog the browser itself shows needs a
click in the qz side panel or sidebar. CLI approval reports that action is needed and preserves
the wait without opening a browser page.
With `--wait` or `--stream`, the command stays connected while you grant permission in the paired browser.
Location approval reads the current disclosure version and includes it in the response. Human
terminal output shows the notice before submitting the explicit approval; JSON output remains a
single final result. MCP callers should show the notice to the user before sending approval with
the returned `consentVersion`.

`submit`, `approve`, and `reject` accept `--wait` and `--stream` with the same completion condition:
the task has completed and its follow-up and steering queues are empty. They follow successive
runs, questions, and permission requests. Each new request is shown once. Respond in the side
panel, the Firefox sidebar, or another terminal; the original command continues automatically. `watch` follows an
existing task with this same condition without resubmitting anything. Timeouts and Ctrl-C stop
watching, while the task continues in the browser.

## Browser selection and MCP tools

Use `--client NAME|UUID` or `-c NAME|UUID` to select a browser. `qz browsers` lists registered names,
UUIDs, and online status. See [browser selection](#add-and-select-browsers) for pairing and name reuse.
Use `-t` for `--title`. Run `qz help COMMAND` or `qz COMMAND --help` for command-specific options.

The default MCP catalog is the direct-drive set: `qingzhou_guide`, `qingzhou_create_drive_session`,
`qingzhou_list_drive_sessions`, `qingzhou_get_drive_session`, `qingzhou_stop_session`,
`qingzhou_execute_tool`, `qingzhou_list_tools`, `qingzhou_get_tool`, and `qingzhou_bridge_status`.
`qingzhou_guide` returns the CLI workflow from `skills/qz-browser-agent/SKILL.md`.
MCP clients use the protocol below and [MCP connection setup](#connect-an-mcp-client).
Run `qz skill` for the guide shipped with the installed CLI.
`qz mcp` prints the local MCP endpoint. `qz mcp --profile full`
prints the task and diagnostic catalog. A direct-drive session lists all discoverable tools as compact signatures from
`qingzhou_list_tools`. `qingzhou_get_tool` returns the selected tool's full schema, and returns
`DRIVE_TOOL_FORBIDDEN` for a blocked name. Set `wait: false` to receive a job ID and read the
result with `qingzhou_get_tool_job`. The full catalog also provides `qingzhou_get_trace` and
`qingzhou_clear_trace` for diagnostics. MCP `qingzhou_list_tools` and `qingzhou_get_tool` can
inspect the base catalog without a session. To inspect loaded Skill tools by name, pass
`sessionId` to `qingzhou_get_tool`.
Tool execution requires a created session: omitting `sessionId` returns `DRIVE_SESSION_REQUIRED`;
an unknown ID returns `DRIVE_SESSION_NOT_FOUND`. Neither case creates a session. Check the browser selection and ID,
or create a new task session with `qz session create --title "Task title"` / `qingzhou_create_drive_session({title:"Task title"})`.

`qz session create --title "Task title"` creates a fresh session and requires a readable title.
It prints `sessionId <id>`; with `--json`, read `result.sessionId`. The new session activates the
tools of enabled user Global Skills; Resident Skills are always active, and Site Skills activate on
matching task sites. `result.qz_skills` lists the summaries of the Skills available to the new
session, in the same form as a script receipt's `context.qz_skills`, and is omitted when Skill
discovery is unavailable. `qz skills tools --session ID` shows each Skill's state. Use the installed `qz` command
and read `qz skill` for its guide. `qz session list` lists direct-drive sessions, and
`qz session show ID` reads `{sessionId,title,status}`. Finish with `qz session cancel ID` to end
the session and clean up its created tabs, including while a script is running. User tabs are
preserved. Add `--keep result --keep evidence` to return specific task pages to the user;
references are validated before stopping, and the first cancellation fixes the retention decision.
Further execution returns `DRIVE_SESSION_ENDED`.

`qz script --session ID [FILE|-] [--args JSON]` runs JavaScript outside the page. It reads a local
file or stdin; `--args` supplies the script's `args` value. Use the `qz` SDK: `qz.openTab(options)`
returns a Tab, `qz.tab(tabRef)` binds a Page, and `page.locator(targetOrQuery)` creates an element query.
`qz.listTabs()` lists the session's tabs and unclaimed tabs, such as the page the user is viewing, with
each row's `ownership`. The first action, navigation, or `page.evaluate` on an unclaimed tab claims it.
Locator actions resolve a unique match and wait for it to become usable within one call budget.
Awaited SDK calls return business values directly and throw on failure.
For additional capabilities and active Skill tools, discover compact signatures with `qz.listTools()`
and selected full schemas with `qz.listTools({names:["list_images"]})`, then use `qz.call(name,args)`.
`qz.call("load_skill",{name})` activates that Skill's tools for the session immediately, including
later calls in the same script.
`page.evaluate(code,args?,options?)` runs a self-contained page function with DOM and login-state
access; pass its inputs explicitly and return JSON. Outer scripts survive page navigation;
an evaluation that unloads its own page can be interrupted. The
[installed Skill](../skills/qz-browser-agent/SKILL.md) provides the SDK reference and workflow.

Ctrl-C (`SIGINT`) or `SIGTERM` cancels the current script request, preserving its session and tabs.
Already-dispatched browser actions may still finish and are not undone. A supervisor should signal its owned CLI process or
process group; signaling an npm wrapper alone depends on its shell forwarding the signal.

```sh
qz session create --title "Read example page"
qz script --session SESSION_ID - <<'JS'
const { tabRef } = await qz.openTab({url:"https://example.com", tabAlias:"page"});
return await qz.tab(tabRef).read({limit:3000});
JS
qz session show SESSION_ID
qz session cancel SESSION_ID
```

stdout is JSON `{ok,result,trace}` on success and failure. `ok` reports execution success; `trace` is an ordered string array of errors and explicit `trace()`/`console` diagnostics without levels. `result` is the returned business value, `null` for `undefined`, or a failure in `{code,message,hint?,details?}` form. Business `trace`/`traces` fields stay inside `result`. Script locations are in `details`. Exit codes are `0` for success, `1` for execution or connection failure, and `2` for invalid arguments. `--timeout` defaults to `120` seconds, accepts `>0` through `3600`, and the request waits 60 seconds longer. The caller's deadline must allow that request to finish. A timeout does not undo completed browser actions.

For action-dependent navigation or popups, use `locator.click({waitFor:"navigation"})` or
`locator.click({waitFor:"popup"})`. The wait listens before dispatching the action once; failure
never replays it. For current element state, use `locator.wait({state:"visible"})`; for an exact
attached match count, use `locator.wait({count:3})`. `locator.count()` reads the current count.
Use `page.waitForFunction(code,args?,options?)` for application-specific completion conditions.

MCP clients can call `qingzhou_execute_tool` directly. Its single-call transport returns
`{toolName,sessionId,isError,result}`: inspect isError, then read result as the business value or
ToolError; script calls carry the `{ok,result,trace}` receipt in result. Do not infer execution status
from keys inside a script's returned object. Batches
correlate each result by call ID and are not transactions. The service extends script request
waiting to at least the execution budget plus 60 seconds without rewriting execution budgets.
Native MCP session operations include `qingzhou_list_drive_sessions`,
`qingzhou_get_drive_session` and `qingzhou_stop_session`.

A CLI process exiting does not close its session's tabs. While the extension runtime runs,
about 30 minutes of inactivity triggers cleanup. Cancel the session for task cleanup;
`qz cleanup` disconnects browsers from the local services. Full MCP can explicitly retain created tabs with
`qingzhou_stop_session({sessionId,keepTabs:true,cascade:false})`. Check the session and page
after an interrupted request before repeating an action; reconnecting does not replay it.

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

Exports use the browser's downloads. The result includes the download status, ID, filename, and path when
the browser provides it. Pending Chrome downloads are in `chrome://downloads`. Pending Firefox
downloads are in `about:downloads`. `delete` removes the named table
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
connecting. The extension validates field names and values before saving. Browser commands accept
`--client NAME|UUID` to select a profile. `automations run` starts an existing automation and
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
`responseTemplate` that binds answers to the current session and wait. A permission dialog the
browser itself shows provides user instructions instead of an approval template.
Exit codes are `0` for success (including reading pending input), `1` for an operation or
task failure or a rejected submission, `2` for invalid arguments, and `130` for Ctrl-C.
Connection errors include the GitHub setup guide and installation link.

## Local access

The service accepts connections only on your computer. Ordinary websites cannot use its MCP
endpoint. Local programs can control connected qz tasks while the service is running.
Run `qz cleanup` to stop local services and disconnect their browser and MCP connections;
side-panel tasks keep running, while active direct-drive scripts are interrupted.

Connection settings and browser registrations are stored in `~/.qz-browser-agent/run/`.
Pairing credentials stay on your computer and are omitted from status output.

# Architecture

qz is a Manifest V3 Chrome extension. Background owns task state and persistence; Side Panel owns
presentation. Chrome contexts communicate through explicit protocols. The optional [MCP
bridge](../services/mcp-bridge/README.md) exposes extension operations to external clients.

For a new tool, page, renderer, provider, or embedded Skill, start with the [capability
guide](../src/capabilities/README.md). Development rules are in [AGENTS.md](../AGENTS.md).

## Runtime map

```text
Side Panel / Chrome message / MCP
                 |
           Background API
                 |
       Session commands and supervisor
          /                    \
   Repositories              Agent
                        /             \
                 Model gateway     Tool runtime
                                       |
                           Content / Chrome / services
```

The [manifest](../src/manifest.json) declares the runtime entries.

The local CLI declares command syntax, help, and direct MCP routes in
[`commands.mjs`](../services/mcp-bridge/src/commands.mjs). A command lazily opens one MCP client and
closes it when the command finishes. CLI and MCP task observation both use
[`waitForTask`](../services/mcp-bridge/src/task-stream.mjs); it projects status, text, and actionable
input from Background snapshots. Observation follows one Session across runs. Successful completion
requires a completed snapshot with empty follow-up and steering queues; accepted message identity
sets the stream's starting point. Failure, stopping, timeout, and cancellation end observation.
Observation only reads snapshots and never resubmits work. Task execution and persistence remain
in the extension.

| Context | Entry and responsibility |
| --- | --- |
| Background | [service-worker.ts](../src/background/service-worker.ts) composes state owners, capabilities, transports, and Chrome listeners. |
| Side Panel | [sidepanel.ts](../src/sidepanel/sidepanel.ts) initializes language; [app.ts](../src/sidepanel/app.ts) connects the workspace to Background. |
| Content | [content-script.ts](../src/content/content-script.ts) reads and operates page DOM in the isolated world. [session-export-bridge.ts](../src/content/session-export-bridge.ts) handles imports from trusted export pages. |
| Offscreen and sandbox | [offscreen.ts](../src/offscreen.ts) hosts DOM-dependent work; [runner-sandbox.ts](../src/runner-sandbox.ts) creates isolated [inner Workers](../src/workers/inner-runner.ts). |
| Local service | [MCP bridge](../services/mcp-bridge/README.md): external MCP requests and extension polling. |

[Shared](../src/shared/) defines wire/storage formats and pure transformations usable across
runtimes. [SDK modules](../src/sdk/) expose services to capabilities. Package indexes declare
contributions; generated catalogs connect them to each runtime. The [product
manifest](../src/products/manifest.json) selects adapters for the public build.

## First-use data consent

[Data consent](../src/background/services/data-consent.ts) owns the versioned acceptance record.
[Side Panel startup](../src/sidepanel/features/app/data-consent.ts) defers workspace initialization
until acceptance. The Background API gate covers transports, while Session commands guard internal
run admission. Scheduler and MCP startup wait for consent.

Location is collected by the `get_location` tool when a task needs local information. The
[location service](../src/background/services/location.ts) requests a separate first-use approval
through the Session's wait lifecycle. A Side Panel click or an explicit CLI/MCP approval of the
current disclosure version saves that approval. Continuing a task alone does not grant consent.
Approval writes recheck the pending wait and run; cancelled writes roll back before another
approval or consent read proceeds. Collection checks the run before and after asynchronous work.

## A task from submission to completion

1. A transport parses and correlates a request, then calls the
   [Background API](../src/background/background-api.ts).
2. [Session commands](../src/background/session/commands.ts) enter the supervisor's per-Session queue.
   Submission deduplicates `clientMessageId`, starts a run or queues the message, and acknowledges
   after the initial conversation write succeeds. Retries reuse the accepted message.
3. The [Agent host](../src/background/session/agent-host.ts) hydrates an
   [Agent](../src/background/agent/agent.ts) with repositories, model/tool services, and a write lease.
   Each run captures its language, tool catalogs, and [configuration](../src/background/agent/run-profile.ts).
4. The Agent gathers context, calls the model gateway, executes tools, and commits complete turns.
   Steering enters at a complete-turn boundary; queued follow-ups start subsequent runs in FIFO order.
5. [Agent events](../src/shared/contracts/agent-event.ts) pass through the host into runtime and
   transcript projections. Side Panel renders those projections.
6. `agent_end` triggers resource cleanup and terminal persistence. Notifications and observers run
   independently of that commit.

The supervisor's task admission covers initial browser-context collection and prompt preparation;
automatic follow-ups wait for that admission to release. The Agent's `_activeRun` slot covers each
run's configuration initialization, execution, and terminal persistence. These handles can overlap
as one logical run reservation. A queued handoff publishes `session_pending` before removing its
next message from the queue. Initialization failure or cancellation releases the reservation.

Successful execution with queued work stays pending. Deletion keeps a queued message visible until
cleanup succeeds; removing the last message permits completion once execution has ended. Queued
messages retain their existing automatic continuation after a run fails or is stopped. Startup
failure before handoff releases the reservation without repeatedly retrying the unconsumed message.

Observers follow the Session across runs and return successfully when a snapshot shows completion,
empty queues, and no pending execution. Messages accepted after that snapshot belong to later work.
Removing a queued message also allows its waiting sender to finish without streaming an earlier
answer. Failure, stop, timeout, and cancellation end observation without resubmitting messages.

The [model gateway](../src/background/llm/index.ts) normalizes provider messages, tool calls, usage,
streaming, errors, and request admission. The Agent owns conversation history, semantic recovery,
and retry budgets. [Providers](providers.md) covers adapters, authentication, and rate policies.

[Context sources](../src/background/context-sources.ts) collect data concurrently and allocate text
budgets in registration order. Titled text becomes model context; structured results remain host
data. [Lifecycle observers](../src/background/lifecycle-observers.ts) receive identity and phase
metadata. Their `committed` phase indicates successful terminal persistence.
[Automation](../src/background/automation/runtime.ts) creates independent Sessions and reconciles
results through `automationRunId`; Chrome alarms wake the scheduler.

## Task input

[User input commands](../src/background/session/user-input.ts) expose a live wait's form and
confirmation through the Background API. CLI, MCP, and Side Panel responses use the same
validation. Each response names its Session and wait ID; stale replies leave newer waits intact.
Invalid field values keep the form pending. The supervisor settles a valid response once.
Task snapshots and rejected responses include the current input, its field IDs and option values,
and a response template bound to the wait ID. Clients can complete the next response from that
result. Templates contain defaults or placeholders; callers fill them from the user's answers.

Native Chrome permission requests remain paused until the user grants access in the Side Panel.
External approval checks the actual permission and returns `requiresUserAction` while it is absent.
The [CLI guide](cli.md#respond-to-a-task) covers input and response commands.

## Message transport

[Port transport](../src/shared/transport/port-transport.ts) sends small messages directly and
transfers large messages through a versioned chunk protocol. Callers use the same request and
response payloads.

| Limit | Value |
| --- | --- |
| Chunk | 512 KiB |
| Native frame | Below 8 MiB |
| Logical message | 128 MiB |
| Encoded snapshot budget | 256 MiB; shared across Background connections |
| Receive allocation pool | 128 MiB |
| Queue per Port | 256 messages |
| Transfer deadline | 30 seconds, including capacity waits; caller deadlines also apply |

Senders encode one chunk at a time. Receivers reserve capacity before acknowledging a transfer's
start. An admitted message keeps one immutable encoded snapshot until delivery. Cancellation and
disconnect release buffers and waiting reservations; disconnect also discards incomplete transfers.

Each direction delivers complete messages in call order. Stop requests and state replies queue
behind earlier data; protocol acknowledgements and cancellation frames can pass the queue. Business
handlers run concurrently after dispatch. The client retains unsent offline messages and retires a
failed connection before handing over the next one. Accepted requests execute once.

Session imports and Skill network requests use a dedicated runtime Port with native sender
authorization and the existing operation deadlines. Request and transfer failures settle their own
requests. The event router discards replies for completed or expired requests before dispatch.
Session commands retain ownership of import, restore, save, and stop behavior.

## State, persistence, and cancellation

The [supervisor](../src/background/session/supervisor.ts) owns live Agents, epochs, runs, waits, and
write leases. The [repository](../src/background/session/repository.ts) owns records, conversations,
checkpoints, and deletion barriers. Commands coordinate them through a queue for each Session.

A lease grants write authority. `AbortSignal` requests cancellation; the host rechecks the run and
lease after asynchronous operations before accepting results. Stop establishes terminal state and
revokes subscriptions and write authority before cleanup. Delete also installs a repository
tombstone that rejects late writes. Stop preserves accepted steering and follow-ups; reset and
delete clear them. A new run receives a new epoch.
Reset completes after the empty model conversation, display history, and reset runtime are persisted.

[Session codecs](../src/shared/session/session-codec.ts) normalize historical records when reading.
The repository validates record and conversation versions before selecting or replacing a copy. The
[format contract](../src/shared/session/session-format.ts) defines supported versions and errors.
List summaries and [artifact projections](../src/background/session/artifacts.ts) derive from
records, transcripts, and resource stores.

The transcript owner keeps completed history (H) separate from the current operation (C).
Agent events update C; explicit `finish` moves it into H. Ordinary UI saves checkpoint state
without finishing the operation.
Message and tool boundaries save immediately; streaming updates share a fixed one-second deadline.
The first checkpoint writes H and the initial C together in one baseline record. Later checkpoints
replace only C in a separate versioned key tied to that baseline revision, retaining all display content.
The Repository coalesces pending checkpoints and validates the Agent lease before queued writes.
Full saves and edits establish a new revision; a completed save supplies the next operation's baseline.
After a Worker restart, readers combine H with the matching saved C, or the baseline's initial C.
Readers remove internal checkpoint fields so repeated reads do not duplicate current content.
The active conversation remains the separate model execution checkpoint.
Recovery settles interrupted display state and does not resume an interrupted model or tool call.
The recovered turn ends with a localized notice inviting the user to send a message to continue.

[Compaction](../src/background/agent/compaction.ts) changes the model's sending window after a
checkpoint commits. It carries earlier summaries, the Goal, and durable document references forward;
transcripts and exports retain full history. Manual and automatic compaction use this boundary.

With history trimming enabled, completed runs apply the round/token policy to old tool results and
images, protecting the latest two user rounds. While trimming is enabled, each model request also
keeps images in the latest eight image-bearing messages. Uploads and tool images share this count;
each message occupies one slot regardless of its image count. Earlier images become placeholders
while text and tool-call links remain. Sending and token estimation use the same selection. Stored
images and exports stay complete.

Resource owners check document revisions, Data versions, and Skill snapshots across asynchronous
reads and writes. Use the [Data](../src/sdk/shared/data.ts) and
[document](../src/sdk/shared/documents.ts) contracts to access those stores.

## Pages, debugger connections, and scripts

[Session tabs](../src/background/session/tabs.ts) owns the working tab and claimed tabs. Page tools
resolve targets through it. Parent and child Sessions have separate runs and tabs; creating,
claiming, and updating a tab requires the current run's authority.

[CDP runtime](../src/background/tools/cdp-runtime.ts) manages debugger connections and operation
leases. A run normally releases its connections on completion. Capabilities can retain a connection
across runs; completion or stop still revokes commands and event collection. Session deletion
releases retained connections.

[Page mode](../src/capabilities/tabs/page-mode.ts) applies mobile UA, viewport, and touch settings
before initial navigation. Mobile mode retains its connection between runs. Mode changes refresh the
page and invalidate screenshot coordinates. A lost debugger target permits one configuration
reconnect; previous page actions remain completed. User detachment ends automatic reconnection.

### Navigation readiness

`open_tab` and `navigate` share the [navigation gate](../src/capabilities/tabs/navigation.ts), using
`tabs` and `scripting`. A constant main-frame script obtains Chrome's document ID after a tab
security check. The gate waits for `pendingUrl` to clear and a new document ID to become accessible.
Fragment navigation can keep the same document.

The old-document probe has a 100 ms deadline. If it expires or fails, the fallback also requires a
`tabs.onUpdated` completion event. Polls run 50 ms apart; every awaited Chrome operation races
against cancellation. Timeout and stop release the gate and permit new-tab cleanup. New tabs are
claimed while blank, configured for mobile mode or network capture, then navigated through this
gate.

Read-only page tools also wait for an initial pending navigation to leave `about:blank`, within
their timeout and cancellation signal. They recheck access after waiting. Content injection uses
Chrome's `document_idle` timing. Dynamic page content can require an explicit element or network
wait.

### Page execution

Content returns validated [page payloads](../src/shared/contracts/page-content.ts). The [article
extractor](../src/content/article-extractor.ts) produces Markdown and preserves complex tables as
sanitized HTML. Display hints stay separate from model input.

Element actions inspect fields in Content, use CDP for text input and checkbox/radio clicks, then
read back field state. Mobile actions use touch. Optional form submission sends Enter and follows
page handlers and native validation. A CDP error ends that attempt. Multiline rich-text fields use
their paragraph writer.

[Script policy](../src/background/tools/script-policy.ts) and the [script
bridge](../src/background/tools/run-script-bridge.ts) check page and inner-script access. The inner
Worker calls tools and fetch through the host; its runtime contains only Worker APIs.

## Images and screenshots

The shared [image policy](../src/shared/images/policy.ts) and
[encoder](../src/shared/images/normalize.ts) limit images to a 2048-pixel long edge and 2 MiB
encoded. Producers normalize before sending across runtimes. Each context runs one decode/encode
operation at a time and releases the bitmap on completion, failure, or cancellation. DOM adapters
live in `src/dom/`; SVG conversion runs in offscreen and retains the original dimensions in its
result.

The model gateway limits cumulative image bytes to 48 MiB and the final adapter request to 64 MiB.
Over-budget requests return an explicit terminal error. Remote image references first pass through a
safety-checked image-reading tool. The [asset store](../src/shared/asset-store.ts) defaults to 2000
images and 1.5 GiB.

Actionable screenshots register coordinates from the final encoded dimensions. Capture reads page
identity and viewport geometry, takes the image, waits 200 ms, then compares the current state. A
changed frame triggers one retry. Requested screenshots and post-action observations use the same
path, including the retry delay. Coordinate actions require a valid screenshot. `press`, `type`, and
`scroll` use current page state; scrolling targets the viewport center.

## Tool and Skill execution

The [tool runtime](../src/background/tools/runtime.ts) checks the catalog, arguments, ownership,
safety, and rate limits before execution. It normalizes results and applies authorized effects.
Argument validation precedes target resolution. [Effect tickets](../src/background/tools/effects.ts)
come from trusted registrations. Shared [security
guards](../src/background/security-guardrails-runtime.ts) check navigation, fetch, scripts, Skills,
and MCP; user grants apply to the named target. See [permissions](permissions.md) for browser access
and recovery behavior.

[Skill tools](../src/background/skills/skill-tool-runtime.ts) use the same execution and identity
protocols. Embedded content and trusted `skillHosts` have separate contributions and validated
[provenance](../src/shared/skills/skill-provenance.ts). Installed packages execute through the
restricted Skill interfaces. [Workspace](../src/background/skills/skill-workspace.ts) writes compare
expected snapshots, prepare the registry, reconcile settings, commit, and publish in order. [Skill
network access](../src/background/skills/skill-network.ts) checks manifest permissions and shared
guards; the host injects secrets at the execution boundary.

The [MCP client](../src/background/mcp/mcp-client.ts) initializes its packaged SDK on the first
connection and reuses it for the Service Worker's lifetime. The build wraps the SDK in a cached
factory with static imports, source maps, and dependency attribution. Protocol schema initialization
runs when MCP is used.

## Side Panel projection and export

Background snapshot/event → [Session view
state](../src/sidepanel/features/sessions/session-state.ts) → [transcript
projection](../src/sidepanel/features/chat/transcript/projection.ts) → DOM reconciliation.
Connection generations, run ordering, and deletion barriers reject stale updates. [Workspace
composition](../src/sidepanel/features/app/workspace-composition.ts) connects features through
bounded ports and optional capability commands.

[Presentation state](../src/sidepanel/features/chat/transcript/presentation-state.ts) owns expansion
and active-tool selection. The [renderer host](../src/sidepanel/tools/renderer-host.ts) owns
component lifetimes; [chat scrolling](../src/sidepanel/features/chat/chat-scroll-feature.ts) owns
reading anchors and following. Reconciliation preserves those choices, focus, and selection through
timeline upgrades.

The [capability host](../src/sidepanel/capability-host/runtime.ts) registers and cleans up pages and
settings. Packages own form drafts; Session runtime owns unsent messages by window and message ID.
Heavy UI libraries load on demand and update the instance that requested them.

[Session export](../src/sidepanel/features/export/session-export-feature.ts) uses one Background
exchange payload and synchronous `renderStatic` projections. It embeds the active skin and a
standalone [export runtime](../src/sidepanel/features/export/session-export-runtime.ts). Text and
tables work offline; formulas use deferred MathJax from a CDN. Import restores safe URLs into newly
owned, inactive tabs. See [design system](design-system.md) and [localization](localization.md) for
export presentation.

## Build and source boundaries

The [builder](../scripts/build-extension.mjs) emits entries, capability catalogs, dependency assets,
and licenses from the root lockfile. TypeScript uses `.js` relative imports and capabilities use
`#sdk/*`. [Runtime configurations](../config/typescript/) check each dependency graph with its
environment: Background uses WebWorker/Chrome globals, DOM entries use DOM/Chrome, and standalone
Workers use Worker globals. Shared modules are checked in each consuming environment.
[Commands](commands.md) covers builds and releases.

## Assets

The [icons](../src/icons/) and light/dark logos come from project-supplied artwork. Release PNGs
retain pixels and color profiles and strip EXIF/XMP and editor metadata. The [workspace
screenshot](images/workspace.png) shows a recorded Hangzhou photo collection task in Chrome.
See [media credits](images/credits.md) for the source and third-party content.

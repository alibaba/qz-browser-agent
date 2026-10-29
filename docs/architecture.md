# Architecture

qz is a Manifest V3 Chrome extension. Background owns task state and persistence; Side Panel owns
presentation. Chrome contexts communicate through explicit protocols. The optional [MCP
bridge](../services/mcp-bridge/README.md) exposes extension operations to external clients.
Firefox temporary loading is in [Commands](commands.md#load-temporarily-in-firefox). Remaining
differences from Chrome are in [Firefox differences from Chrome](firefox-differences.md). The API
survey is in [Firefox capability gap](firefox-capability-gap.md). How the packages are separated
is in [Firefox packaging](firefox-packaging.md). The Chrome runtime below stays the
source of the shared code.

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
leases. A run normally releases its connections on completion. Dismissing Chrome's debugging bar
marks the tab as user-detached; before the run's next tool call, outside the tool timeout, a
confirmation asks to continue (re-attach) or stop (ending the run), while other detach reasons
keep the silent reconnection. Capabilities can retain a connection across runs; completion or
stop still revokes commands and event collection. Releasing a run does not disable Runtime.
Session deletion releases retained connections.
An existing question remains pending when a tool requests reattachment; it does not grant consent.
The tool returns `CDP_REATTACH_WAIT_CONFLICT`; after answering the question, retrying asks for
reattachment approval.
Closing a tab releases its debugger state and removes it from pending reattachment checks.

Diagnostics captures bounded console history as soon as a run-owned connection enables Runtime,
including replay triggered by UID tools. Buffers follow Session/run/connection identity; idle
retained connections collect no events, and reconnecting replaces the buffer before accepting replay.

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
against cancellation. Timeout releases the gate and retains a claimed tab with its current URL,
loading state and `incomplete` marker. Stop and navigation failures retain new-tab cleanup. New tabs are
claimed while blank, configured for mobile mode or network capture, then navigated through this
gate.

Read-only page tools also wait for an initial pending navigation to leave `about:blank`, within
their timeout and cancellation signal. They recheck access after waiting. Content reads inject
immediately into the main frame. The initial presence ping has a short probe budget; installation
and its acknowledgement use the call's existing deadline and cancellation signal. The installed bridge
is idempotent. A presence ping also reports whether DOMContentLoaded has fired. Content reads wait
for that document event before extracting, so a heavy head cannot produce a successful empty body.
Screenshots use an immediate main-frame document gate before capturing. Both paths use the
[self-contained readiness function](../src/shared/document-readiness.ts): Content calls it directly
for presence probes and its cached event wait; screenshots serialize it through `executeScript`,
without installing the Content bundle or adding a probe. Both gates share the tool's hard deadline
and cancellation, exclude subresource/child-frame load, and do no late extraction or
capture after cancellation. Readiness has its own phase counter. Explicit UID bridge recovery
initializes frames immediately and validates the selected document again. Dynamic page content can
require an explicit element or network wait.

Element clicks and form submission capture a navigation baseline immediately before input. They
allow 180 ms for navigation to start, then wait up to 10 seconds while new navigation evidence
coincides with loading or a pending URL. Pre-existing loading alone does not extend the wait.
`pageAfter` and result page metadata describe the same observation. A changed document ID detects
same-URL reloads, including documents still loading subresources. Sending a navigation request does
not extend the wait. A settled page with an unchanged URL and document returns `navigated: false`,
including downloads, 204 responses and cancelled navigations. Ambiguous observations leave
`navigated` unknown. Committed URLs undergo navigation security
checks. Observation never replays input; callers can inspect the page again.

### Page execution

Content returns validated [page payloads](../src/shared/contracts/page-content.ts). The [article
extractor](../src/content/article-extractor.ts) produces Markdown and preserves complex tables as
sanitized HTML. Display hints stay separate from model input.

Element actions inspect fields in Content, use CDP for text input and checkbox/radio clicks, then
read back field state. Mobile actions use touch. Optional form submission sends Enter and follows
page handlers and native validation. A CDP error ends that attempt. Multiline rich-text fields use
their paragraph writer.

Node-backed UIDs use the isolated context of the node's own document after verifying the current
extension ID and its Content bridge. The main frame is the default. A direct child iframe uses the
same uid and action path: the snapshot grafts that frame's accessibility tree under the owning
iframe, and click or fill resolves the node in the child frame.
Snapshot actions and ancestor matches stay within that document; child-root selectors bind through
the child frame's session and loader identity.

Within one debugger connection, Runtime is enabled and never disabled. Tool paths do not disable
and re-enable Runtime to rediscover contexts or to check that the target is alive. `isolatedByTab`
is the only source of isolated contexts. Each record stores the numeric execution context id and,
when Chrome reports one, the context's `uniqueId`. Probing and selection then call
`Runtime.evaluate` with `uniqueContextId`, so a numeric id reused after a cross-process navigation
cannot select another context. A same-process frame is keyed by its CDP frame id. A cross-process
frame is keyed by `session:` plus its flattened session id and that frame id.

When a frame has no recorded context, the only path is `Runtime.enable`, selection, one Content
initialization, selection, then an error. There is no further recovery. Initialization injects
scripts into every frame. Page messages stay on the main frame. Extension reloads can leave older
contexts alive. This path precedes action dispatch; an action failure is never replayed.

Programmatic detach and debugger `onDetach` clear the tab's contexts and child-target cache.
`chrome.debugger.detach()` does not emit `onDetach`, so the connection exit also performs this cleanup.
A retained connection keeps Runtime enabled and its contexts; enabling Runtime again would not
report contexts that are already live. `Target.detachedFromTarget` drops only that child's entries.

Mouse and text input stay on the page target. A click point from a child frame adds that iframe's
content origin. Nested frames stay unaddressed. A cross-site child is absent from the page frame
tree; the page session auto-attaches to that child target and uses the child session for the tree
and the node call. Before child-frame input, one discarded screenshot refreshes Chrome's input
surface. Preparation failure ends the operation before input is sent.

[Script policy](../src/background/tools/script-policy.ts) and the [script
bridge](../src/background/tools/run-script-bridge.ts) check page and inner-script access. The inner
Worker calls tools and fetch through the host; its runtime contains only Worker APIs.

## Accessibility snapshots

Use `get_ax_tree({scope:"viewport"})` for the current vertical viewport band, or
`get_ax_tree({scope:"full"})` for the document range. The page root defaults to viewport;
explicit `uid:`/`css:` roots default to full subtree scope. Both retain depth and BFS limits.

The [accessibility capability](../src/capabilities/accessibility/tools.ts) filters raw AX nodes
by positive Y overlap before semantic pruning, depth limits, redundant-text removal and BFS.
Horizontal overflow stays eligible. Zero-height boxes are in-band when their Y coordinate is within
`[0, viewportHeight)`. The same filter also retains bounded off-screen headings, regions/landmarks,
lists and longer named links in their original tree positions, with UIDs for subtree reads. Other
off-band ancestors remain structural. Guaranteed actions are filtered too; unmatched actions need
an in-band rectangle before they can receive a target.

Global `↑`/`↓` markers (only when nonzero) and `viewportOmitted.above/below` count raw AX nodes
dropped, including text fragments that semantic formatting may later merge or remove. Retained
structure and ancestors are excluded. Local fold markers sit before/after each retained container's
remaining children and count folded semantic branches, not repeated text descendants. A list's
`items` attribute counts its existing direct AX list items, excluding nested lists. Markers give
`scope:"full"` and UID-root read targets. Depth and node budgets are documented in the tool's
parameter descriptions; markers report omissions without repeating those definitions.

A conservative 1800-character allowance bounds additional off-screen structure and its ancestors;
selection samples both document ends. These are ordinary tree nodes, not a separate outline. A
heading's nearest content-bearing wrapper can remain as a subtree entry so its sibling content
is addressable. The existing BFS/depth limits still apply, and off-screen value/URL/flag details
remain folded.
These counts are independent of BFS leftovers and cover only the browser's existing AX/DOM set;
unloaded lazy/virtual items and browser-adapter collection caps are outside that set. The default
BFS budget remains 120 optional nodes (maximum 300), plus guaranteed actions and their ancestors.

[Geometry collection](../src/capabilities/accessibility/viewport.ts) uses Chromium's batched
`DOMSnapshot.captureSnapshot`, then box-model reads for missing boxes. Firefox uses the internal
`DOM.getNodeRects` adapter to read all requested rectangles in one isolated-world page injection,
because it lacks DOMSnapshot. Inline fragments without DOM ids inherit
the parent box classification. Unmeasurable nodes remain eligible and are reported separately;
geometry failures do not silently discard content. Direct child frame boxes are translated into
the root viewport. This is a vertical band filter, not an occlusion or nested-scroll clipping test.

## Images and screenshots

The shared [image policy](../src/shared/images/policy.ts) and
[encoder](../src/shared/images/normalize.ts) limit images to a 2048-pixel long edge and 2 MiB
encoded. Producers normalize before sending across runtimes. Each context runs one decode/encode
operation at a time and releases the bitmap on completion, failure, or cancellation. DOM adapters
live in `src/dom/`; SVG conversion runs in offscreen and retains the original dimensions in its
result.

Element screenshots keep bounds and padding in CSS pixels, then convert the capture rectangle
to CDP's device-independent pixels using the current page zoom. UID and CSS targets, including
image-read screenshot fallbacks, share this conversion without changing the user's zoom.

The model gateway limits cumulative image bytes to 48 MiB and the final adapter request to 64 MiB.
Over-budget requests return an explicit terminal error. Remote image references first pass through a
safety-checked image-reading tool. The [asset store](../src/shared/asset-store.ts) defaults to 2000
images and 1.5 GiB for its gallery cache. Session image payloads use a separate durable,
content-addressed store in that database; persisted conversations and transcripts carry references,
while public reads and exports resolve the original inline data. Gallery GC cannot evict history
images. Session deletion sweeps unreferenced history assets behind a repository write barrier,
including prepared but not yet committed conversations in the live reference set.

Ordinary screenshot CSS measurement injects immediately with a 150 ms probe budget. An unavailable
measurement leaves an observation image without coordinates. Native capture fallback serializes
activation, capture and focus restoration per window. A call-local accumulator records injection,
extraction, CDP, measurement, normalization and result postprocessing counts and cumulative durations.
Tool settlement emits one `tool_phase` diagnostic row with the call ID, including work still pending at
settlement. Concurrent phase durations may overlap; these are not a wall-clock breakdown. Late work
cannot change the closed summary. CDP commands emit no individual phase rows, and timing stays out of
model-visible results.

Actionable screenshots register coordinates from the final encoded dimensions. Capture reads page
identity and viewport geometry, takes the image, waits 200 ms, then compares the current state. A
changed frame triggers one retry. Requested screenshots and post-action observations use the same
path, including the retry delay. Coordinate actions require a valid screenshot. `press`, `type`, and
`scroll` use current page state; scrolling targets the viewport center.

## Tool and Skill execution

The [tool runtime](../src/background/tools/runtime.ts) checks the catalog, arguments, ownership,
safety, and rate limits before execution. It normalizes results and applies authorized effects.
Argument validation precedes target resolution. A model response can contain multiple tool calls.
The Agent executes ready data-flow nodes with one shared limit of ten in-flight calls. Creators,
explicit observations, and declared tab-local actions share that budget. Each tab has an execution
lane: a navigation or element action waits for earlier work on its tab while independent tabs advance.
UID calls use their registered tab lane when all targets share one known tab and the definition grants
a parallel role. `behavior.uidTargets` extends the singular target fields; mixed, unknown and cross-tab
target sets retain commit barriers, as do implicit targets and undeclared/global operations.
Capability definitions can set `behavior.barrier` to a boolean or synchronous argument predicate.
The runtime evaluates it once per call during planning; true or a thrown predicate overrides
`parallelOpen`, `parallelTab` and `parallelRead`. The Agent reuses this decision for execution.
Projection preserves target metadata for `tabRef`, and the same graph builder adds preceding-commit
and following-execution dependencies. No tool-name branch in the scheduler selects this behavior.

`run_script` declares `parallelTab: true` with a barrier predicate for inner mode or potential tool
API use. An omitted target means page. The capability's [classifier](../src/capabilities/script/tool-access.ts)
uses the pinned JavaScript parser to distinguish comments, quoted strings and ordinary member
properties from tool references, template expressions and dynamic access. Parse failures, tool
references and dynamic constructs remain barriers. This is conservative scheduling analysis, not a
JavaScript sandbox or proof that arbitrary page functions have no external side effects.

No-tools page scripts use tab lanes regardless of `mutatesPage`, which continues to control effects.
Input/args bindings are injected without a bridge. A tab-local execution cannot install the tool
bridge, even if a later classification disagrees. Missing tool access returns
`RUN_SCRIPT_TOOL_ACCESS_UNAVAILABLE`, with inspection/recovery guidance and no automatic replay.
Only a native return-shape syntax error without an execution stack can use the existing no-bridge
shape recovery; runtime error envelopes never trigger it. Tool-using page scripts retain their existing nested-tool scope and are barriers.
`run_skill_script`, inner execution, and all Skill/plugin tools remain barriers; plugin resolution
overrides host predicates with literal true. Permission, ownership, deadlines and run checks still apply.
Tool start and progress events publish during execution, including flow-control waits. A separate
cursor publishes tool-owned Session state, effects, alias bindings, final tool events and model
messages in the original call order. Completed execution frees a slot immediately, even while its
result awaits publication. Progress stops when execution settles or cancellation revokes the call.
The Background runtime tracks overlapping calls and projects the most recently active tool; ending
one call preserves other active tools.

Execution-time permission checks are read-only, including nested CDP checks and browser-context
collection. Working-tab selection occurs at commit, following the same order as serial execution.
An earlier numeric or UID-resolved page target forms a window-anchor dependency for subsequent creators. Each
call has its own cancellation signal derived from the run. Stop launches no further work, revokes
uncommitted state/effects and closes uncommitted creations. The ledger retains the committed prefix
and returns ordered cancellation records for the remainder, including calls that were never started.
Parallel `read_article`, `find_elements` and `get_ax_tree` do not scroll, focus or activate tabs.
They observe the current mode and skip
mobile-preference restoration that could reload a disconnected page. Sequential preparation keeps
its existing restoration behavior.
For known URLs, the model can include `open_tab({url,tabAlias:"a"})` and
`read_article({tabRef:"a",limit:4000})` in the same assistant message's `tool_calls` array.
Place each creator before its consumers. The [tab batch planner](../src/background/tools/tab-batch.ts)
builds execution edges without reordering publication. Independent `open_tab` calls execute concurrently,
including creation, page-mode/network preparation and navigation to commit. Each finished creator
makes its private numeric target available to its own readers immediately; a slow sibling opening
creates no read barrier. Document readiness stays inside the reading tool's existing deadline.

New tabs receive opaque execution-only permits in `SessionTabs`. They stay outside Session ownership,
working-tab state and visited sites until ordered commit. Only the originating runtime/session/run
can use the original result identity to authorize a dependent observation. A JSON copy grants no
permission. Actions await published ownership. Commit checks run authority, live tab availability and
security again, then publishes ownership and selection together. Failed or cancelled uncommitted
creations are closed; terminal cleanup also retries outstanding permits. A navigation timeout retains
its loading tab only if its ordered commit is still authorized, and retains its alias for dependent and later calls.

Only trusted core registrations declare scheduling authority. Page-tool model schemas expose `tabRef`
(integer or string); numeric strings also select browser IDs. Internal handlers retain numeric `tabId`,
and legacy `tabId` input remains compatible. `open_tab.tabAlias` names a page within its Session until
closure. Aliases persist across turns, follow-ups and worker restarts in runtime schema 4. An alias
reservation precedes browser creation, so open and pending names cannot collide; aliases cannot be
entirely numeric. Failed creation releases the reservation. The planner snapshots existing aliases
when admitting a batch, so reuse after closure cannot retarget already queued calls. UID and explicit
page references must agree. Multiple opens require explicit page targets. Duplicate, invalid,
conflicting, forward and ambiguous references return `BATCH_TAB_REFERENCE_ERROR`. Failed or
effect-failed producers yield `BATCH_TAB_DEPENDENCY_FAILED` for their consumers, including observations
that executed speculatively before the producer's commit failed. Independent pages continue. Browser
operations already issued may still finish after cancellation; closed provisional tabs and revoked
run authority prevent their late publication.

[Effect tickets](../src/background/tools/effects.ts)
come from trusted registrations. Shared [security
guards](../src/background/security-guardrails-runtime.ts) check navigation, fetch, scripts, Skills,
and MCP; user grants apply to the named target. See [permissions](permissions.md) for browser access
and recovery behavior.

Tools can publish completed stages into a call-local partial-result slot. Only the existing hard
deadline reads that slot: it aborts the call and returns the saved content with
`incomplete: { reason: "timeout", pending }`. Only the hard-timeout fallback samples
`pageState.readyState`, URL and title. Successful Content reads reuse the presence acknowledgement's
readiness flag; their document-event gate is separate from timeout state sampling. A busy
renderer can retain an observation supplied by the partial result and its timestamp; an unavailable
observation reports `unknown`. Changed documents discard obsolete partial content.
Safety rejection, a closed tab and user cancellation remain errors. Tools without a partial retain
`TOOL_TIMEOUT`.

The Content overview ranks every action candidate using semantic eligibility and geometry, then
computes labels and unique selectors for retained actions. Unnamed-role candidates still use their
labels when determining eligibility. This preserves selection and snapshot output while avoiding
whole-document selector/label queries for thousands of discarded links.
AX snapshots cache ancestor descriptions within one read and fetch up to four child frames at once,
merging in frame order. A timed-out AX read retains the main document and completed children. Until
viewport geometry completes, this partial explicitly uses `scope:"full"` and lists filtering in
`pending`; successful output retains the requested scope. Screenshot partials use normalized images
without coordinates. Action timeouts remain localized `TOOL_TIMEOUT` errors, with an unconfirmed
outcome that may already have taken effect. They issue no success effects or working-tab update;
the runtime preserves the attempt without replaying it.

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
standalone [export runtime](../src/sidepanel/features/export/session-export-runtime.ts). Text,
tables, and formulas work offline: each formula is embedded as a self-contained SVG from the local
MathJax components. Each import creates an independent
Session, including repeated imports of the same file. Import restores safe URLs into newly owned,
inactive tabs. See [design system](design-system.md) and [localization](localization.md) for
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

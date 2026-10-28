# Behavior test index

Use this index to find the tests behind a user, Agent, or runtime workflow. Each journey describes
observable results, persisted state, failure recovery, and the evidence supporting its coverage
rating.

## Use this index

1. Find the affected journey before changing a feature; add one if none applies.
2. Review its task, steps, outcome, and recovery together.
3. Link evidence at the appropriate unit, browser, extension E2E, Agent E2E, live, visual, or benchmark boundary.
4. List only behavior-defining tool arguments here; tool definitions remain the schema reference.
5. Update evidence and coverage when adding an entry point, tool family, stored artifact, or recovery policy.

Coverage ratings:

- **Strong**: checks the main path at a real product boundary and a key failure or recovery path.
- **Medium**: directly tests the main path, but lacks a real-model, real-extension, or key recovery check.
- **Weak**: has unit, contract, or static UI evidence; full task acceptance remains open.
- **Missing**: needs a test directly checking the workflow.

Judge a task at four levels:

1. **Steps**: the user or Agent takes a direct path with explicit Session and tab ownership.
2. **Outcome**: the page, transcript, Data, images, files, task, or settings actually reach the required state.
3. **Visibility**: the user can understand progress, failures, recovery, and delivered results.
4. **Persistence**: state and ownership remain correct after refresh, Worker restart, task switching, or late events.

## Overview

### Human workflows

| ID | Task | Coverage | Main gap |
| --- | --- | --- | --- |
| H01 | Set up a model and send the first message | Medium | An end-to-end check from a fresh installation to the first complete answer. |
| H02 | Send a message and read a streaming answer | Strong | Check that long answers satisfy the task, beyond successful stream completion. |
| H03 | Paste or drop documents into a message | Strong | In-place retry for failed attachment parsing. |
| H04 | Steer a running task or queue a follow-up | Strong | An end-to-end mixed queue with attachments. |
| H05 | Stop, retry, edit, and resend | Medium | A real-model check of branching from an edited historical message. |
| H06 | Rename, switch, search, resume, and delete tasks | Medium | A complete mouse and keyboard journey through the task tree. |
| H07 | Open artifacts and export or import conversations | Medium | User-level evidence connecting artifact panels to exported files. |
| H08 | Browse, filter, edit, and export Data | Medium | A complete import, manual correction, and export workflow. |
| H09 | Create, run, pause, and inspect scheduled tasks | Medium | End-to-end UI coverage of the editor and run history. |
| H10 | Install, create, edit, and delete a Skill | Medium | A complete browser journey through the Skill lifecycle. |
| H11 | Import, update, and restore Skills from Git | Strong | Preserve the boundary between source synchronization and optional publishing. |
| H12 | Change model, advanced, Skill, and capability settings | Medium | Real-extension persistence and UI synchronization after restart. |
| H13 | Answer Agent questions or complete a manual step | Medium | Waiting, continuation, cancellation, and task switching in the real extension. |
| H14 | Use narrow panels, dark mode, and the keyboard | Medium | Workspace-wide accessibility and focus-order acceptance. |
| H15 | Paste or drop images into a message | Strong | Mixed image/document follow-up coverage. |
| H16 | Return to a task from a notification | Medium | Real Chrome notification clicks and reopening the Side Panel. |
| H17 | Copy answers and code snippets | Medium | Browser checks of full clipboard content and selection restoration. |

### Agent workflows

| ID | Task | Coverage | Main gap |
| --- | --- | --- | --- |
| A01 | Read a page and answer with sources | Strong | Automatic scoring of citation accuracy on real sites. |
| A02 | Find elements, act, and verify the change | Strong | Multi-window and popup interactions. |
| A03 | Choose a tab and preserve its ownership | Strong | Changes to the browser's active tab between turns. |
| A04 | Submit a form and verify Network/Console evidence | Strong | Combined authentication, redirects, and download responses. |
| A05 | Process page or internal data in scripts | Strong | Detecting and correcting scripts that run but produce wrong results. |
| A06 | Write and maintain structured Data | Strong | Real Agent recovery after concurrent write conflicts. |
| A07 | Find, inspect, and collect images | Strong | A complete user-selection path when visual judgment is unavailable. |
| A08 | Read documents and create document artifacts | Strong | Real-model coverage across PDF, XLSX, and DOCX formats. |
| A09 | Track a long task with Goal checkpoints | Medium | Real Agent recovery from durable checkpoints after interruption. |
| A10 | Delegate subtasks, wait, and collect artifacts | Medium | Parent-stop and child-failure combinations in the real extension. |
| A11 | Schedule a workflow or wait until a specific time | Medium | Panel-closed behavior and missed-run policies. |
| A12 | Clarify requirements, wait for login, and verify | Medium | Cancellation, task switching, and real login pages. |
| A13 | Discover and load Skills and resources as needed | Medium | False-positive and missed Skill matches. |
| A14 | Create, edit, or publish Skills with the workbench | Medium | A complete publishing journey on a simulated Code page. |
| A15 | Read or change settings, safety rules, and Skill configuration | Medium | UI synchronization in the real extension. |
| A16 | Discover and call MCP tools | Medium | Actual calls and recovery beyond tool discovery. |
| A17 | Manage bookmarks, history, and downloads | Medium | Real Chrome download failures and idempotent cleanup. |
| A18 | Research across real sites and keep sources | Medium | Automatic scoring of facts, citation coverage, and source correspondence. |
| A19 | Verify task outcomes before declaring success | Medium | Factual and citation scoring for real research. |
| A20 | Notify the user when attention is needed | Medium | Real Chrome notification click E2E. |
| A21 | Inspect and operate pages visually | Medium | Scoring the decision to avoid visual mode when the DOM is sufficient. |

### Runtime reliability

| ID | Task | Coverage | Main gap |
| --- | --- | --- | --- |
| S01 | Serialize within Sessions and run Sessions concurrently | Strong | Detect global locks that accidentally serialize independent work. |
| S02 | Reject late writes after stop or delete | Strong | Tombstone coverage for each new artifact type. |
| S03 | Restore the Side Panel after refresh or disconnection | Strong | Explicit handling of transient UI and unsaved edits on departure. |
| S04 | Interrupt safely and retry after Worker restart | Strong | Restart during Skill tool execution. |
| S05 | Run schedules with the Side Panel closed | Strong | Missed-run policy combinations after browser exit or sleep. |
| S06 | Isolate and recover tab ownership | Strong | Tab groups and close/reopen combinations. |
| S07 | Recover from storage failures, conflicts, and migrations | Strong | Real-extension E2E for exhausted storage quota. |
| S08 | Handle Provider errors, retries, and context compaction | Strong | Equivalent failure matrices across Providers. |
| S09 | Keep streaming transcripts and timelines stable | Strong | Each new renderer must pass the existing fuzz/visual gates. |
| S10 | Refresh the Skill registry and settings atomically | Strong | Worker restart between prepare and commit. |
| S11 | Enforce navigation, script, fetch, Skill, and MCP safety rules | Medium | Real-extension denial messages and recovery actions. |
| S12 | Install and upgrade clean, traceable packages | Strong | Upgrade verification against an isolated older installation. |
| S13 | Keep long conversations, large tables, and streaming usable | Strong | User-visible performance budgets for specific workflows. |

## Human workflows: details

### H01 · Set up a model and send the first message

- **Role**: Human
- **Task**: Open qz for the first time, connect a model, and receive a useful answer.
- **Preconditions**: A fresh extension profile ready for model setup.
- **Steps**: Open the Side Panel → agree to the data disclosure → open model settings → choose a Provider or custom endpoint → authorize or enter the endpoint, model, and API key → save → return to chat and send a clear task.
- **Expected outcome**: Configuration is saved once; the composer becomes usable immediately; the task starts in the current Session; the user sees streaming progress, the answer, and an error recovery action if needed.
- **Failure and recovery**: Deferring first-use consent closes the panel; failed consent writes retain the card for retry. Authorization timeout preserves retry and custom setup options. Only unambiguous endpoint paths are completed automatically. Authentication, quota, or network errors preserve the draft and the existing Session.
- **Evidence**: [Data consent browser](browser/data-consent.spec.mjs), [Consent gate unit](unit/test-data-consent.mjs), [Custom endpoint browser](browser/settings-custom-endpoint.spec.mjs), [session tools unit](unit/test-session-tools.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Medium
- **Next test**: In an empty profile, test successful authorization, authorization timeout followed by custom setup, and correction of an invalid API key. End each path with a complete first answer.

### H02 · Send a message and read a streaming answer

- **Role**: Human
- **Task**: Send a text task, follow the Agent's progress, and ask a follow-up after the answer.
- **Preconditions**: A valid model configuration and an idle Session.
- **Steps**: Enter text → send with Enter (Shift+Enter inserts a newline) → watch thinking, tools, and the answer enter the transcript → wait for completion → send the next message.
- **Expected outcome**: The user message appears once; the composer resets; status and tool events appear in causal order; completion preserves a reasonable reading position.
- **Failure and recovery**: Interrupted Provider streams show a stable error and allow retry against the existing user message. Long answers and tool updates preserve deliberate scrolling. Returning a streaming code block to its bottom resumes following new content.
- **Evidence**: [Extension E2E](background/extension-e2e.mjs), [landing browser](browser/chat-landing-state.spec.mjs), [timeline browser](browser/tool-timeline.spec.mjs), [Scroll stability browser](browser/tool-scroll-stability.spec.mjs)
- **Coverage**: Strong
- **Next test**: Assert that completed answers meet the task's acceptance criteria.

### H03 · Paste or drop documents into a message

- **Role**: Human
- **Task**: Give the Agent a PDF, XLSX, DOCX, text, or code file as part of a message.
- **Preconditions**: An empty draft in the current Session and a supported file type and size.
- **Steps**: Drop or paste a file anywhere in Chat → watch the attachment parse → enter instructions after parsing succeeds → send. Use the attachment's delete button to remove it.
- **Expected outcome**: Sending is disabled during parsing; each card belongs to its draft or message; the message and document id are submitted together. Switching Sessions or reopening the panel restores each attachment once in its original Session. Removing a draft attachment also releases its unsent document.
- **Failure and recovery**: Parsing failures mark the card as failed and keep sending disabled; removing the card permits another attempt. Late parsing updates only the original Session's live draft; deletion revokes those updates.
- **Evidence**: [Attachments browser](browser/chat-document-attachment.spec.mjs), [Attachments unit](unit/test-chat-document-attachments.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Cover all four document formats and `.py/.js/.cpp` text paths. Add an in-place parsing retry journey if that interaction is implemented.

### H04 · Steer a running task or queue a follow-up

- **Role**: Human
- **Task**: Add information to a running Agent or queue work after the current task.
- **Preconditions**: The current Session is running.
- **Steps**: Enter a message → inject it as steering at a safe boundary or queue it as a follow-up → inspect the queue → reorder follow-ups or convert one to steering when needed.
- **Expected outcome**: Steering precedes follow-ups. A steering batch produces one queue animation but separate user messages. Follow-ups run in order after the current run. Queued items retain their original message bodies and attachments.
- **Failure and recovery**: Refresh and Session switching preserve queue ownership. Stopping the current run retains valid follow-ups. Each queued item is consumed once.
- **Evidence**: [follow-up browser](browser/chat-followup-visibility.spec.mjs), [motion contract](unit/test-chat-motion-contract.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Cover simultaneous image/document steering and follow-ups, refresh recovery, and continuation after stopping.

### H05 · Stop, retry, edit, and resend

- **Role**: Human
- **Task**: Stop an incorrect approach, edit an earlier user message, and run again from that point.
- **Preconditions**: A running Session or at least one existing turn.
- **Steps**: Stop → wait for the terminal state → retry; alternatively, edit a user message → confirm removal of the subsequent branch → resend and return to the live tail.
- **Expected outcome**: Stopping revokes old write authority immediately. Resending retains only the new branch. Tool states and artifact ownership remain scoped to their run. The viewport follows the new run.
- **Failure and recovery**: Repeated stop/retry clicks are idempotent. Late stream events from the stopped run are discarded. Canceling the edit confirmation leaves history unchanged.
- **Evidence**: [Edit/resend browser](browser/chat-edit-resend-tail.spec.mjs), [Edit/resend unit](unit/test-chat-edit-resend.mjs), [stop model unit](unit/test-stop-session-model.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Medium
- **Next test**: With a real model, edit a middle message and verify that old artifacts remain inspectable, the new answer follows the edited branch, and new artifact identities are unique.

### H06 · Rename, switch, search, resume, and delete tasks

- **Role**: Human
- **Task**: Manage tasks and subtasks with clear titles, and find and resume the intended conversation.
- **Preconditions**: Several Sessions in running, waiting, or completed states.
- **Steps**: Rename in the Chat title bar → open Tasks → search titles or summaries → expand the parent/child tree → switch tasks → inspect recent messages, status, and artifact counts → confirm deletion of a task.
- **Expected outcome**: Manual titles update both views and survive late automatic titles. Switching changes only the visible projection; other Sessions keep running. Lists preserve order, hover, and focus. Search uses actual metadata. Deletion releases resources according to policy and rejects late writes.
- **Failure and recovery**: Failed renames restore the previous title and show an error. Snapshot timeouts show local summaries before filling in details. Drafts remain Session-specific and are released on deletion. Deleting a running task establishes its terminal state before cleanup.
- **Evidence**: [Title editing browser](browser/session-title-edit.spec.mjs), [Session command unit](unit/test-session-commands-runtime.mjs), [chat search unit](unit/test-chat-search.mjs), [list summary unit](unit/test-session-list-summary.mjs), [task state unit](unit/test-session-task-state.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Medium
- **Next test**: Use the real Side Panel DOM to combine rename/search, tree expansion, keyboard switching, deletion during a run, and detail recovery after the 1.2-second soft timeout.

### H07 · Open artifacts and export or import conversations

- **Role**: Human
- **Task**: Open Data, image collections, and files from a task or task list, and export or restore the full conversation.
- **Preconditions**: A Session with at least one artifact or an exportable transcript.
- **Steps**: Open an artifact pill or the top-level artifact entry → browse the index → open Data, images, or files. Export the conversation and wait for the HTML download. Import a Session exchange file to restore it, including its working tabs.
- **Expected outcome**: Each logical artifact appears once, with a stable type, name, and count. HTML exports use the active skin and include a readable transcript, owned-tab URLs whose current hostnames are evidenced by successful page tools, and the working-tab marker. Later manual navigation to unrelated sites is excluded. Imported running states become interrupted. Every import creates an independent Session, including repeated imports of the same file. The new Session opens and owns valid pages, remapping the original working page to its new tab. Import returns after Chrome assigns the new tab IDs; the pages continue loading.
- **Failure and recovery**: Missing artifacts show a useful error. Repeated export clicks share the active export. Older v1 files without owned tabs retain their behavior, and the earlier single-working-tab field still imports. Invalid or blocked URLs are rejected; existing tab ownership is preserved.
- **Evidence**: [artifact unit](unit/test-session-artifacts.mjs), [resource ledger unit](unit/test-session-resource-ledger.mjs), [Message actions unit](unit/test-chat-message-actions.mjs), [session exchange unit](unit/test-session-exchange.mjs), [exchange E2E](session-exchange/e2e-check.py)
- **Coverage**: Medium
- **Next test**: Open each artifact type from a real task card, export HTML, import into an empty profile, and check independent imported copies and ownership.

### H08 · Browse, filter, edit, and export Data

- **Role**: Human
- **Task**: Inspect collected data and filter, sort, edit, import, or export it.
- **Preconditions**: At least one regular Data table or image collection.
- **Steps**: Open Data → select a table → filter, sort, or adjust columns → edit cells or rows → append an imported file → export to Excel.
- **Expected outcome**: Large-table virtual scrolling stays stable. Business `id` fields remain visible; internal `rowId/revision` fields remain row metadata. Edits respect version conflicts. Column order matches the export.
- **Failure and recovery**: Conflicting writes are rejected while preserving input. Older databases and row ids remain supported. Malformed imports preserve the previous data. Editing overlays stay aligned during scrolling.
- **Evidence**: [Data browser matrix](data-grid/browser-matrix.mjs), [Data extension page](data-grid/extension-page.mjs), [Data contract unit](unit/test-data-grid-contract.mjs), [row id browser](browser/data-row-id-compat.spec.mjs), [Large-table benchmark](benchmarks/data-grid-large-runner.mjs)
- **Coverage**: Medium
- **Next test**: Import CSV/XLSX → resolve an editing conflict → filter → export and read back. Assert zero partial writes on failure.

### H09 · Create, run, pause, and inspect scheduled tasks

- **Role**: Human
- **Task**: Schedule a proven workflow once, hourly, daily, or weekly, and inspect its results.
- **Preconditions**: Chrome is running; the instruction, schedule, missed-run policy, and notification policy are clear.
- **Steps**: Open Tasks → scheduled tasks → create → enter a title and instruction → choose frequency and time → choose missed-run and notification policies → save → run manually or wait → inspect run history and artifacts → pause, edit, or delete.
- **Expected outcome**: The next run time is correct. Scheduling continues with the panel closed. Each run has its own Session. Artifact pills appear only when artifacts exist. Pausing suspends future runs.
- **Failure and recovery**: Resume after sleep or exit follows `missedPolicy`. Duplicate alarms are idempotent. Failed runs remain inspectable and can run again. Deleting a rule handles its run history and preserves delivered artifacts.
- **Evidence**: [automation runtime unit](unit/test-automation-runtime.mjs), [once unit](unit/test-automation-once.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Medium
- **Next test**: Exercise all four schedules, three missed-run policies, manual run, pause, failed-run retry, and artifact entry points through the editor.

### H10 · Install, create, edit, and delete a Skill

- **Role**: Human
- **Task**: Install a Skill from a local package, Git repository, or web ZIP, and maintain its Markdown and resources.
- **Preconditions**: A valid Skill package and a permitted import source.
- **Steps**: Open Skills → search or filter → import → open details → edit `SKILL.md` or a text resource → save and wait for registry refresh → export or delete when needed.
- **Expected outcome**: Saved Skills become available immediately. Renaming migrates settings. Binary resources show metadata only. Errors use the shared toast. Deletion removes tools and settings together.
- **Failure and recovery**: Manifest, Markdown, and path validation identify the failing field. Registry refresh failure preserves the previous version and allows retry. Users explicitly resolve name conflicts.
- **Evidence**: [Skill resource edit unit](unit/test-skill-resource-edits.mjs), [Page Skill import unit](unit/test-page-skill-importer.mjs), [Skill list browser](browser/skill-list-status.spec.mjs)
- **Coverage**: Medium
- **Next test**: Install a Skill with settings and binary resources from the list, edit and rename it, run a tool, then delete it. Check the complete registry/settings lifecycle.

### H11 · Import, update, and restore Skills from Git

- **Role**: Human
- **Task**: Use a supported GitHub/GitLab repository directory as a Skill source, check for updates, and update or restore local changes.
- **Preconditions**: The user is signed in on an explicitly opened repository page; its tab is usable by the current Session.
- **Steps**: Open Skills → Git sources → import from the repository page → check for updates → apply remote changes or restore local differences. Optional publishing is registered as a product contribution and requires target confirmation before submission.
- **Expected outcome**: Authentication stays inside the repository page. The source snapshot matches the installed baseline. Confirmation freezes the target. A closed source tab can reopen at its validated URL and be checked again. The local change count returns to zero correctly.
- **Failure and recovery**: Source URLs are persisted with secret query parameters removed. Read-only checks preserve the revision. Conflicts require resolution. Identity changes and API failures leave the local Skill untouched.
- **Evidence**: [Git source browser](browser/git-skill-source.spec.mjs), [Git publish browser](browser/git-skill-publish.spec.mjs), [target lifecycle browser](browser/git-skill-publish-target-lifecycle.spec.mjs), [Git source unit](unit/test-git-skill-sources.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Cover source selection across Git platforms, safe retry after network failure, and a source-only configuration with publishing controls omitted.

### H12 · Change model, advanced, Skill, and capability settings

- **Role**: Human
- **Task**: Adjust the Provider, model capabilities, safety rules, Skill settings, or settings sections contributed by capabilities.
- **Preconditions**: The settings shell opens. Each registered section appears independently. Skill settings appear only when an installed Skill declares them.
- **Steps**: Open settings → select a section → edit and inspect unsaved state → save through the shared action. Switch away and back to inspect the draft. Retry failures; reopen to inspect saved values. Search the index before opening a Skill's settings when several exist. Complete managed Provider authentication before saving.
- **Expected outcome**: Saving calls the eligible sections on the active tab. Each section keeps its own draft, errors, and save state. Model/advanced saves close the panel; independent sections provide their own feedback. Reopening reads saved values. Managed providers use their declared authentication and capability controls; Background stores authentication identity. Skill fields follow their manifest constraints; secrets use password controls. The Skill section appears when at least one installed Skill declares settings.
- **Failure and recovery**: Save failure retains the draft and permits retry. Edits made after a request starts survive its late success. Switching, closing, or unloading cancels obsolete UI work; newer forms, drafts, and busy states retain their authority. Removing a section leaves others usable; remounting restores one instance. Reopening built-in model settings restores saved values. Provider authentication, unsaved Skill changes, and registry refresh retain their respective recovery rules.
- **Evidence**: [Independent capability in the full app browser](browser/capability-independence.spec.mjs), [Settings shell and disposal recovery browser](browser/settings-sections.spec.mjs), [Save races and retry browser](browser/settings-save-races.spec.mjs), [Added capability navigation and restoration browser](browser/extension-example.spec.mjs), [Skill settings browser](browser/settings-skill-settings.spec.mjs), [endpoint browser](browser/settings-custom-endpoint.spec.mjs), [UI lifecycle unit](unit/test-ui-capabilities.mjs), [Model selection and reopening browser](browser/settings-model-combobox.spec.mjs), [Provider switching and credential races browser](browser/settings-provider-model-races.spec.mjs), [Real-extension offline stress browser](browser/models-dev-offline-stress.spec.mjs), [Offline model catalog unit](unit/test-models-dev-presets.mjs), [settings unit](unit/test-settings-menu.mjs), [manage settings unit](unit/test-manage-settings-tool.mjs)
- **Coverage**: Medium
- **Next test**: Use the real extension to check save, Worker restart, and UI synchronization. Cover close/late-response races through the close button, backdrop, and Escape.

Added-package tests build temporary source and run the full app with a stubbed Background. Use
extension E2E and live tests for persistence and real-model behavior.

### H13 · Answer Agent questions or complete a manual step

- **Role**: Human
- **Task**: Clarify a requirement or personally complete login, CAPTCHA, authorization, or local file selection.
- **Preconditions**: The Agent called `ask_user` or `wait_for_user`, or first requested `get_location`, and the Session is waiting.
- **Steps**: Read and answer a structured question, or complete the action on the target page → return to qz and continue.
- **Expected outcome**: Answers reach only the initiating run. The Agent observes the page again after continuation. The wait card names the target and action. Submitted answers remain bound to the initiating task. Location is collected only after the first explicit approval; later calls and Worker restarts reuse that recorded consent.
- **Failure and recovery**: Cancel, stop, and delete end the wait. Worker restart interrupts pending waits for user recovery. A closed target tab prompts context recovery.
- **Evidence**: [Location service unit](unit/test-location-service.mjs), [Location approval browser](browser/waiting-card.spec.mjs), [Extension E2E](background/extension-e2e.mjs), [decision dialog browser](browser/decision-dialog.spec.mjs), [wait defaults unit](unit/test-wait-form-default-values.mjs), [Session supervisor unit](unit/test-session-supervisor.mjs)
- **Coverage**: Medium
- **Next test**: Add a responding-user extension E2E covering submit, cancel, stop, Session switching, tab closure, and panel refresh.

### H14 · Use narrow panels, dark mode, and the keyboard

- **Role**: Human
- **Task**: Complete core tasks at different panel widths, themes, zoom levels, and input methods.
- **Preconditions**: Representative transcripts, tool cards, settings, Data, Skills, and task-list fixtures.
- **Steps**: Change width, theme, or conversation text size → navigate, send, expand, save, and close using Tab/Enter/Escape/arrows → open and use preset search with the browser shortcut → compose and commit Chinese IME input in an existing two-line draft → scroll deliberately and select text.
- **Expected outcome**: Content fits the panel width. Text size persists across Sessions; resizing preserves tail-following or the message being read. Preset search accepts Enter and orders choices by usage; closing returns focus to the composer. Focus is visible and ordered. IME preedit preserves a stationary transcript; commit resizes the composer once, and wrapped committed text preserves the message viewport. Reconciliation preserves selections. Motion respects reduced-motion preferences. Toasts, dialogs, and popovers keep required controls accessible.
- **Failure and recovery**: Long filenames, URLs, and tool values truncate but remain inspectable. Narrow layouts keep actions reachable. Visual updates preserve scroll and focus ownership.
- **Evidence**: [Model preset shortcut browser](browser/settings-model-preset-switcher.spec.mjs), [Model preset ordering unit](unit/test-model-preset-switcher.mjs), [Conversation text size browser](browser/chat-text-size.spec.mjs), [viewport fuzz browser](browser/viewport-stability-fuzz.spec.mjs), [IME composer browser](browser/chat-composer-ime.spec.mjs), [button browser](browser/button-system.spec.mjs), [selection browser](browser/chat-selection.spec.mjs), [Toast browser](browser/toast-system.spec.mjs), [visual audit](benchmarks/conversation-render/run-visual-audit-matrix.mjs)
- **Coverage**: Medium
- **Next test**: Build a workspace-wide keyboard and ARIA journey covering at least 400/520/820px widths, 100%/125% zoom, and both color schemes.

### H15 · Paste or drop images into a message

- **Role**: Human
- **Task**: Send screenshots, photos, or local images as visual context to a multimodal Agent.
- **Preconditions**: An empty Session draft, vision enabled for the Provider/model, and a readable image format and size.
- **Steps**: Paste into the composer or drop anywhere in Chat → inspect thumbnails and names → remove or add images as needed → enter the question → send.
- **Expected outcome**: Images belong only to their draft/message. Multiple images retain order; removal takes effect immediately. Uploads use the shared 2048 px long-edge and 2 MiB encoded-image limits before entering extension messaging. With history trimming enabled, model requests retain images from the latest eight image-bearing messages within the round limit; earlier images become placeholders in that request projection. Stored history and UI images remain available. Switching Sessions or reopening the panel restores images only in their original draft.
- **Failure and recovery**: Unreadable files, input-size violations, and images exceeding the limits after normalization produce clear errors. Unsupported vision is explained before sending or handled by a safe fallback. Failed reads remove their pending thumbnail. Deletion revokes late reads.
- **Evidence**: [Image normalization unit](unit/test-image-normalization.mjs) checks limits. [Image and document attachments browser](browser/chat-document-attachment.spec.mjs) covers projection and races. [Extension E2E](background/extension-e2e.mjs) uses real Background, IndexedDB, and parsers to add images and documents in new/existing Sessions, switch repeatedly, send, check transcript/Provider payloads, and verify draft cleanup.
- **Coverage**: Strong
- **Next test**: Combine images and documents in steering/follow-ups, refresh with queued attachments, disable vision, and fail an image read.

### H16 · Return to a task from a notification

- **Role**: Human
- **Task**: Learn that a scheduled task or other task has finished through a local notification, and return to its conversation.
- **Preconditions**: Browser notifications are allowed and the Agent or automation sends one.
- **Steps**: Click the browser notification → open the Side Panel → select the associated Session.
- **Expected outcome**: The correct task opens. Each completion event produces at most one notification.
- **Failure and recovery**: Deleted targets and denied notification permission retain the current view. Notification failures preserve the task's terminal state.
- **Evidence**: [background services unit](unit/test-background-services.mjs), [send alert unit](unit/test-send-alert-tool.mjs), [automation runtime unit](unit/test-automation-runtime.mjs), [Notification return behavior probe](behavior/probes/notification-return.mjs)
- **Coverage**: Medium
- **Next test**: In real Chrome, click with the panel closed and already open, and after the target task has been deleted.

### H17 · Copy answers and code snippets

- **Role**: Human
- **Task**: Copy an entire answer or a code snippet for use in another application.
- **Preconditions**: A displayed model answer in the current Session.
- **Steps**: Copy Markdown from the answer footer, use a code block's copy button, or select text and use the system copy shortcut.
- **Expected outcome**: Copying preserves content and code formatting, shows feedback, and leaves selection and conversation presentation stable.
- **Failure and recovery**: Unavailable clipboard access shows a useful error. Copying completes independently of optional lifecycle observers.
- **Evidence**: [message actions unit](unit/test-chat-message-actions.mjs), [product runtime unit](unit/test-product-runtime.mjs), [observer unit](unit/test-lifecycle-observers.mjs)
- **Coverage**: Medium
- **Next test**: Check full Markdown, code-block, and selection clipboard contents in a real browser, including focus restoration.

## Agent workflows: details

### A01 · Read a page and answer with sources

- **Role**: Agent
- **Task**: Understand an article, document, or search result and answer with traceable sources.
- **Preconditions**: A readable current page or a user-provided URL.
- **Steps**: Use `list_tabs({})` to identify the intended page and `use_tab({tabId})` if needed. Prefer `read_article({tabId,limit:4000..8000,offset})` for text, continuing through `outline/nextOffset`. Use `read_dom({tabId,selector,offset,limit})` when DOM attributes are needed. Retain the source URL in the answer.
- **Expected outcome**: Article and DOM tools return complete sections in order. Facts map to sources. Read-only inspection preserves the tab's existing ownership. The first read after `open_tab` or `navigate` sees the parsed new document. One `tool_calls` array can open named pages with `tabAlias` and read each with `tabRef`; each creator precedes its consumers. Readers start as soon as their own opening completes, within one ten-call execution budget. Ownership, working-tab selection, effects, aliases, events and results publish in original call order. Failed producers fail their dependents; cancellation closes unpublished creations.
- **Failure and recovery**: If article extraction misses the text, locate its container with `get_ax_tree`/`find_elements` and read it directly. Continue truncated results by offset. An existing hard timeout returns completed observations plus `incomplete.pending` and sampled readiness; read the named missing part when needed. Explain content blocked by policy.
- **Evidence**: [Navigation readiness unit](unit/test-tab-navigation.mjs), [read_article browser](browser/read-article-markdown.spec.mjs), [Agent behavior regression](background/agent-behavior-regression.py), [Citation prompt unit](unit/test-llm-prompt-citations.mjs), [partial timeout unit](unit/test-tool-runtime-partials.mjs), [AX output and round trips](unit/test-accessibility-roundtrips.mjs), [slow-document and dependent-read browser](browser/tab-navigation.spec.mjs), [tab dependency unit](unit/test-agent-tab-batch.mjs), [DeepSeek batch acceptance](live/page-batch-case.mjs)
- **Coverage**: Strong
- **Next test**: Score whether every key conclusion in a real research task has a corresponding URL or page evidence, beyond counting Data rows.

### A02 · Find elements, act, and verify the change

- **Role**: Agent
- **Task**: Click, fill, select, or scroll a page control and verify the intended effect.
- **Preconditions**: The current Session owns the target tab.
- **Steps**: Use `get_ax_tree({tabId,root:"root",limit})` or `find_elements({tabId,roles/tags/pattern})` → inspect with `inspect_element({tabId,target})` if needed → pass the unchanged target to `act_on_element({tabId,target,action,value|key})`. Use `scroll_page({tabId,direction,pixels})` for ordinary scrolling. Wait for navigation with `wait_for_navigation({tabId,fromUrl,fromTitle})`, or dynamic content with `wait_for_element`/`wait_for_network_idle` → read the resulting page state.
- **Expected outcome**: Ordinary interactions use structured page tools. Targets come from the current page snapshot. AX viewport scope keeps Y-intersecting detail and bounded off-screen structural nodes in tree order without horizontal culling. Retained structures have working subtree UIDs. Local folds identify clipped containers; list item counts exclude nested lists, and global raw-node counts precede BFS. Acceptance checks the business result after the action.
- **Failure and recovery**: Observe again after stale, ambiguous, or hidden targets and use candidate diagnostics. Scroll and reread after viewport omission markers, or request `scope:"full"`/an element subtree. Unknown geometry remains eligible. Wait for unavailable controls or select a new target. Recheck ownership when a new tab opens.
- **Evidence**: [Dynamic-target Agent regression](background/agent-behavior-regression.py), [element runtime unit](unit/test-element-runtime.mjs), [element target contract](unit/test-element-target-contract.mjs), [AX compaction unit](unit/test-ax-snapshot-compact.mjs), [viewport geometry unit](unit/test-ax-viewport.mjs), [AX browser](browser/ax-snapshot-compact.spec.mjs), [explicit DeepSeek comparison](live/ax-viewport.mjs), [repeated public-site comparison](live/ax-viewport-public.mjs)
- **Coverage**: Strong
- **Next test**: Combine new windows, dialogs, reachable iframe content, and browser back/forward navigation, retaining outcome checks after each action.

### A03 · Choose a tab and preserve its ownership

- **Role**: Agent
- **Task**: Interpret “the current page,” reuse a suitable tab, and avoid operating another task's page.
- **Preconditions**: Several browser windows/tabs, some owned by other Sessions.
- **Steps**: Start with `get_working_tab({})`; an unassigned working page returns `hasWorkingTab:false`. If selection is needed, use `list_tabs({})` and choose `active:true` for a user reference to the current page. Claim `usable:true`/`claimRequired:true` tabs with `use_tab({tabId})`. Pass `readOnlyUsable:true` tabs only to read-only tools. Use `open_tab({url,watchNetwork?})` for new pages, and `close_tab({tabId})` only when needed.
- **Expected outcome**: Each writable tab has one owner. Read-only observation preserves ownership. Child Sessions own separate tabs. CDP connections are reused per run only on owned tabs. Closing and navigation always name a tab. `open_tab` and `navigate` wait for the new document within their deadline; a timeout retains the claimed tab with its current URL and loading state. Network watching attaches before navigation when requested. Independent creation, explicit-tab observation and declared tab-local actions use data-flow execution with ordered Session state and model-result publication. Same-tab work follows its own lane; private creation permits grant no serialized authority.
- **Failure and recovery**: Reject a tab owned by another task and offer read-only access. Explicitly select a new page after the working tab closes. Revalidate ownership before reattaching CDP. Require an explicit target after ownership loss.
- **Evidence**: [Current-page context Agent regression](background/agent-behavior-regression.py), [tab ownership E2E](background/mcp-tab-ownership-e2e.mjs), [tab isolation unit](unit/test-session-tab-isolation.mjs), [tab targeting unit](unit/test-session-tab-targeting.mjs), [CDP run/tab lifecycle unit](unit/test-cdp-runtime.mjs), [Agent tool scheduling](unit/test-agent-tool-scheduler.mjs), [partial timeout unit](unit/test-tool-runtime-partials.mjs)
- **Coverage**: Strong
- **Next test**: With a real Agent, change the active browser tab between turns. Verify that each turn samples the visible page again while the current run retains its initial meaning of “current.”

### A04 · Submit a form and verify Network/Console evidence

- **Role**: Agent
- **Task**: Complete a form or search and verify the result using requests and logs.
- **Preconditions**: The target tab is owned, and the Agent knows whether to capture initial or subsequent requests.
- **Steps**: Capture initial requests with `open_tab({url,watchNetwork:true})`/`navigate({url,watchNetwork:true})`. Before later interactions, call `network_watch({tabId,reset:true})` → observe and fill/submit with `act_on_element` → `wait_for_response({tabId,urlPattern,method,status})` or `wait_for_network_idle({tabId})` → inspect `network_recent({tabId})`, `network_body({tabId,requestId})`, and `read_console_messages({tabId})` → verify the page result.
- **Expected outcome**: Form values are checked before submission. Request URL, method, and status agree with the visible result. Network, console, and page evidence verify the user's goal together.
- **Failure and recovery**: Missed capture timing is reported as an evidence gap. Authentication, permission, throttling, and server errors have actionable recovery. Large bodies are read on demand. Retries preserve one-time external writes.
- **Evidence**: [Form Agent regression](background/agent-behavior-regression.py), [diagnostics unit](unit/test-diagnostics-tools.mjs)
- **Coverage**: Strong
- **Next test**: Add login redirects, downloads, 429 backoff, and one-time writes; verify exactly one submission during recovery.

### A05 · Process page or internal data in scripts

- **Role**: Agent
- **Task**: Extract, transform, and store multi-row or multi-page data, returning summaries and durable IDs.
- **Preconditions**: A known page structure or explicit internal data input.
- **Steps**: Use `run_script({target:"page",tabId?,timeout,mutatesPage?,code})` only on owned tabs, and `run_script({target:"inner",timeout,code})` for pure computation. Process batches through `tools.data_store(...)`/`tools.ask_llm(...)`; return concise summaries and durable ids.
- **Expected outcome**: Large arrays stay in durable stores with concise model-facing summaries. Page and inner scripts have separate permissions. Batch writes can deduplicate and be verified. Tool cards stream code and execution status.
- **Failure and recovery**: Syntax/runtime errors provide line numbers and short diagnostics. Timeouts can be canceled. Observe again after page-context changes. Resume partially written batches from a checkpoint.
- **Evidence**: [Script extraction Agent regression](background/agent-behavior-regression.py), [script bridge unit](unit/test-run-script-bridge.mjs), [page script queue unit](unit/test-page-script-queue.mjs), [result contract unit](unit/test-run-script-result-contract.mjs)
- **Coverage**: Strong
- **Next test**: Add a script that runs successfully but produces incorrect business data. Require the Agent to detect it through row counts, fields, or page evidence, repair it, and verify the result.

### A06 · Write and maintain structured Data

- **Role**: Agent
- **Task**: Create tables and upsert, read, update, replace, or delete structured rows.
- **Preconditions**: A stable table, columns, and business deduplication key.
- **Steps**: Use `data_store({action:"upsert",table,rows,dedupField})` for small writes and verify with `list`. Update fields using a recently returned `rowId` and `expectedValue`; replace rows using `rowId`, `revision`, and `data`. Pass returned `rowId` values unchanged for deletion. Use A05 for large batches.
- **Expected outcome**: Business fields stay in `row.data`; internal row IDs come from store responses. Field and row concurrency checks apply. The final list and schema satisfy the task.
- **Failure and recovery**: On conflict, read again and merge. Repeated upserts deduplicate. Invalid tables or row IDs are rejected before deletion. Large writes switch to batched scripts.
- **Evidence**: [Data CRUD Agent regression](background/agent-behavior-regression.py), [delete unit](unit/test-data-store-delete.mjs), [Agent/Data interaction unit](unit/test-data-grid-agent-interaction.mjs)
- **Coverage**: Strong
- **Next test**: Have two real Agents edit the same row. Verify that one receives a conflict, rereads, explains the difference, and retries safely.

### A07 · Find, inspect, and collect images

- **Role**: Agent
- **Task**: Collect only images meeting the user's criteria, while their source context is still valid.
- **Preconditions**: Candidate pages or direct image URLs, with a named target collection.
- **Steps**: Inspect bounded metadata with `list_images({tabId,limit})` → select a target when metadata is sufficient, otherwise `read_image({tabId,target})` → immediately save qualifying targets with `collect_images({table,targets:[target]})`. Use `collect_images({table,urls:[url]})` for direct resources. Repeat on another page if needed.
- **Expected outcome**: Stable targets bind Session, tab, page, and URL. Collection happens in the source context and returns an `assetId`; use `read_image_asset({assetId})` to review it later.
- **Failure and recovery**: Ask the user to choose when metadata is insufficient and the model lacks vision. Rediscover expired targets. Retrying failed images preserves completed results. Rediscover targets after page changes.
- **Evidence**: [Image Agent regression](background/agent-behavior-regression.py), [Image discovery browser](browser/image-discovery-context.spec.mjs), [media unit](unit/test-media-tools.mjs)
- **Coverage**: Strong
- **Next test**: Add a responding-user Agent E2E for choosing candidate images, and score duplicate collection, delayed cross-tab collection, and recovery time.

### A08 · Read documents and create document artifacts

- **Role**: Agent
- **Task**: Parse PDF/XLSX/DOCX/text, read chunks, and create new documents or spreadsheets.
- **Preconditions**: A document id in the message capsule, a remote URL, or a Skill resource.
- **Steps**: Load the built-in document Skill from an attachment capsule. For remote files, call `qingzhou_documents__document_fetch({url})` → `qingzhou_documents__document_parse({fileId})` → `qingzhou_documents__document_read_chunk({docModelId,chunkIndex})` or `qingzhou_documents__document_read_chunk({docModelId,tableId|sheetName,offset,limit})` → `qingzhou_documents__document_create({format,filename?,docModelId|blocks|sheets,download})`. Download with `qingzhou_documents__document_download({artifactId})` only if needed; verify with `qingzhou_documents__document_list_artifacts({limit})`.
- **Expected outcome**: Long documents are read in bounded text and table chunks. Text and table projections are correct. Files, document models, and artifacts have stable identities. Downloading requires an explicit request.
- **Failure and recovery**: Format and parser failures are explicit. Chunk positions allow continuation. Existing database versions are preserved. Invalid creation input preserves parsed content for retry.
- **Evidence**: [Document Agent regression](background/agent-behavior-regression.py), [documents skill unit](unit/test-qingzhou-documents-skill.mjs), [read projection unit](unit/test-document-read-projection.mjs), [documents E2E](qingzhou-documents/e2e-check.py)
- **Coverage**: Strong
- **Next test**: With real models, process a long PDF, a multi-sheet XLSX, DOCX tables, and code text; check extracted facts and generated artifact contents consistently.

### A09 · Track a long task with Goal checkpoints

- **Role**: Agent
- **Task**: Preserve the objective, acceptance criteria, and durable progress across pages, tools, or long runs.
- **Preconditions**: A task requiring several tool calls.
- **Steps**: Call `manage_goal({action:"create",objective,criteria})` → after each durable Data/image/file write, `manage_goal({action:"checkpoint",progress,next,checkpoint})` → use `manage_goal({action:"block",progress,next})` when blocked and `manage_goal({action:"resume"})` to continue → verify the criteria with actual tools → `manage_goal({action:"complete"})`.
- **Expected outcome**: Goal records contain concise progress and durable references. Checkpoints identify the next action. Completion follows verification. The task list shows a useful summary.
- **Failure and recovery**: Goal and durable stores allow continuation after compaction or refresh. Incorrect objectives can be updated. An impossible continuation is recorded as blocked.
- **Evidence**: [Goal Agent regression](background/agent-behavior-regression.py), [goal unit](unit/test-goal-driven.mjs), [context compaction unit](unit/test-context-compaction.mjs)
- **Coverage**: Medium
- **Next test**: Force Worker restart or compaction on page 2/3. Require recovery to nine records from the checkpoint and exactly one completion.

### A10 · Delegate subtasks, wait, and collect artifacts

- **Role**: Agent
- **Task**: Delegate independent research branches to child Sessions and combine their results.
- **Preconditions**: Clear subtask boundaries and useful parallel work.
- **Steps**: Call `manage_sessions({action:"create",title,firstMessage})` for each branch → retain each `sessionId` → `manage_sessions({action:"wait",sessionIds,waitFor:"all"|"any",timeout,num})` → inspect `last_messages({sessionId,num})` if needed → open Data, images, or files from returned artifact indices → combine the results.
- **Expected outcome**: Parent and child Sessions have separate runs/tabs. Sessions run concurrently. Wait targets require a different Session ID. Summaries reference durable artifacts.
- **Failure and recovery**: Other results remain available after a child failure. Timeout returns a snapshot and permits another wait. Deleting a child preserves the parent. Repeated collection deduplicates artifacts.
- **Evidence**: [session commands unit](unit/test-session-commands-runtime.mjs), [supervisor unit](unit/test-session-supervisor.mjs), [tab ownership E2E](background/mcp-tab-ownership-e2e.mjs), [Natural-language Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: Move the passing three-branch real-model `waitFor:any/all` scenario across the extension boundary; combine parent stop with child failure.

### A11 · Schedule a workflow or wait until a specific time

- **Role**: Agent
- **Task**: Schedule a proven method or align the current run with an absolute time within two hours.
- **Preconditions**: Automation handles long-term work; a wait inside the current run lasts at most two hours.
- **Steps**: Validate the method → call `manage_sessions({action:"create_automation",title,instruction,schedule,missedPolicy,notifyPolicy})`. A one-time schedule uses `{type:"once",runAt:"...+08:00"}`. Inspect `list_automations`/`automation_runs` and optionally `run_automation`. Use `wait_until({until:"ISO-8601+timezone"})` for exact times and `wait({seconds})` for ordinary delays.
- **Expected outcome**: Future runs use automation records and Background alarms. Instructions specify pages, outputs, and failure handling. Absolute time and timezone are correct. Results have separate run records.
- **Failure and recovery**: Waits beyond two hours return a stable error suggesting automation. Past times continue immediately with `pastDue`. Invalid schedules preserve the previous records.
- **Evidence**: [automation once unit](unit/test-automation-once.mjs), [wait_until unit](unit/test-wait-until.mjs), [automation runtime unit](unit/test-automation-runtime.mjs), [Natural-language Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: Extend the passing daily-automation and `wait_until` real-model scenario to a closed panel and verify missed-run behavior.

### A12 · Clarify requirements, wait for login, and verify

- **Role**: Agent
- **Task**: Ask only necessary questions or hand actions requiring human input back to the user.
- **Preconditions**: A missing choice materially affects the result, or login, CAPTCHA, authorization, or file selection is required.
- **Steps**: Use `ask_user({title,message,fields:[{id,label,type,options?,defaultValue?}]})` for short questions and choices, or `wait_for_user({message,tabId})` for manual page actions. After continuation, observe again with `get_ax_tree`/`read_article` and verify the page outcome.
- **Expected outcome**: Questions are few, specific, and have sensible defaults. Independent work can continue. After manual intervention, the Agent checks the resulting page state against the task.
- **Failure and recovery**: Cancellation or prolonged silence can end the wait. Waits stay bound to their initiating Session. Restore context after tab closure. Without vision, use structured observation.
- **Evidence**: [wait defaults unit](unit/test-wait-form-default-values.mjs), [wait runtime unit](unit/test-session-supervisor.mjs), [decision dialog browser](browser/decision-dialog.spec.mjs), [Responding-user Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: On a login page in the real extension, cover waiting, user continuation, outcome checks, cancellation, and task switching.

### A13 · Discover and load Skills and resources as needed

- **Role**: Agent
- **Task**: Load specialized guidance when a task matches a Skill.
- **Preconditions**: The system prompt lists Skill names/descriptions, and the target Skill is installed.
- **Steps**: Match the task and call `load_skill({name})` → follow `SKILL.md` → call `load_skill_resource({name,path,offset,limit})` only when needed. Read binary resources through the document pipeline. Loaded Skill tools join the shared registry.
- **Expected outcome**: The Agent selects a matching Skill and reads its complete instructions first. Resource paths stay inside the package. Tool identity, errors, and display follow core protocols.
- **Failure and recovery**: Explain missing/invalid Skills and use core capabilities where possible. Continue truncated resources with `nextOffset`. Registry refresh retains the last successful snapshot.
- **Evidence**: [Document Agent regression](background/agent-behavior-regression.py), [MCP Agent regression](background/agent-behavior-regression.py), [site matching unit](unit/test-site-skill-matching.mjs), [package unit](unit/test-skill-package.mjs)
- **Coverage**: Medium
- **Next test**: Test correct matches, rejected near-matches, several candidates, and Skill load failures with a real model.

### A14 · Create, edit, or publish Skills with the workbench

- **Role**: Agent
- **Task**: Create or maintain a self-contained Skill package, importing or publishing it with explicit authorization.
- **Preconditions**: Load `skill-workbench` first with `load_skill({name:"skill-workbench"})`; edits stay inside the target Skill.
- **Steps**: Create through workbench tools → read/edit `SKILL.md` and resources → save and wait for registry refresh → verify loading. Use dedicated workbench tools for web ZIP, Git, and submission, with user confirmation for external writes.
- **Expected outcome**: The model calls workbench tools that wrap core Skill services. Package structure, paths, manifest, settings, and renderers validate. Confirmation freezes the publishing target.
- **Failure and recovery**: Validation errors name paths/fields. Failed saves retain the old registry. Failed external submissions report their error. Renaming migrates settings correctly.
- **Evidence**: [plugin creator skill unit](unit/test-builtin-plugin-creator-skill.mjs), [resource edit unit](unit/test-skill-resource-edits.mjs), [Git publish browser](browser/git-skill-publish.spec.mjs), [Skill creation and reload Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: Extend real-model creation/reload tests with renderer execution and verify submitted file contents on a simulated Code page.

### A15 · Read or change settings, safety rules, and Skill configuration

- **Role**: Agent
- **Task**: Read or change qz configuration at the user's explicit request.
- **Preconditions**: Load `qingzhou-management` first with `load_skill({name:"qingzhou-management"})`; changes are authorized.
- **Steps**: Use `qingzhou_management__manage_settings({action:"get"|"update_config"|"apply_preset",...})` for model settings and `qingzhou_management__manage_guardrails(...)` for safety rules. List Skill settings with `qingzhou_management__manage_skill_settings({action:"list"})`, then use its `get({settingId})`/`update({settingId,values})` operations.
- **Expected outcome**: The Agent and UI call the same service. Setting ids are stable. Secret reads expose only `hasValue`; updates merge changed fields. Validation details reach the Agent. Success events refresh the settings UI.
- **Failure and recovery**: Validation rejects invalid types and ranges. Failed registry/settings transactions preserve the old state and report failure. Missing Skill settings return actionable guidance.
- **Evidence**: [manage settings unit](unit/test-manage-settings-tool.mjs), [plugin settings unit](unit/test-plugin-settings.mjs), [security guardrails unit](unit/test-security-guardrails.mjs), [Validation recovery Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: Run the invalid-value correction and secret-redaction scenarios against real extension settings, checking that UI and tool reads agree.

### A16 · Discover and call MCP tools

- **Role**: Agent
- **Task**: Find an appropriate tool on a configured MCP server, inspect its arguments, and call it.
- **Preconditions**: Load `qingzhou-mcp` first with `load_skill({name:"qingzhou-mcp"})`; the bridge/server is available.
- **Steps**: Call `qingzhou_mcp__mcp_list_tools({limit})` or `qingzhou_mcp__mcp_search_tools({query,limit})` → inspect with `qingzhou_mcp__mcp_inspect_server({url,headers?})` if needed. Use `qingzhou_mcp__mcp_call_tool({url,tool,args,validate?})` only for one-off validation of an unregistered server. For registered tools, load the owning Skill and call the returned `pluginTool.name`.
- **Expected outcome**: Advertised capabilities match dispatch. Call identity retains server/tool information. Error codes and recovery are stable. Results use shared artifact/timeline protocols.
- **Failure and recovery**: Offline servers, missing tools, invalid arguments, and timeouts are diagnosable. Verify the called tool's business result. External writes still respect confirmation and safety rules.
- **Evidence**: [MCP probe Agent regression](background/agent-behavior-regression.py), [MCP tools unit](unit/test-mcp-tools.mjs), [MCP runtime unit](unit/test-mcp-runtime.mjs), [connection service](unit/test-node-mcp-bridge.mjs), [CLI lifecycle](unit/test-node-mcp-cli.mjs)
- **Coverage**: Medium
- **Next test**: Find a synthetic MCP tool, call it with invalid arguments, correct them, and complete the task; verify large-result and artifact projections.

### A17 · Manage bookmarks, history, and downloads

- **Role**: Agent
- **Task**: Search history, maintain bookmarks, or save/download results and verify completion.
- **Preconditions**: A clear user request; destructive deletion or replacement requires appropriate confirmation.
- **Steps**: Use `browse_history({action:"search"|"recent",query?,limit})` and `manage_bookmarks({action:"search"|"create"|"update"|"move"|"delete"|"list",...})`. Save text with `save_file({content,mimeType,filename?})` or a URL with `download_url({url,filename?})`. Verify the returned `downloadId` through `list_downloads({id})`.
- **Expected outcome**: Only intended bookmarks change. Folder deletion requires `recursive:true`. Download status, path, and failure reason are visible. Files become task artifacts.
- **Failure and recovery**: Permission, duplication, invalid URL, and download errors are explicit. Generated content remains available if the filename is missing. Retry avoids duplicate downloads or bookmarks.
- **Evidence**: [bookmarks/history unit](unit/test-bookmarks-history-tools.mjs), [long output contract](unit/test-long-output-tool-contract.mjs), [artifact unit](unit/test-session-artifacts.mjs), [Browser library Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: In real Chrome, cover failed downloads, duplicate request suppression, bookmark moves/deletion, and idempotent cleanup.

### A18 · Research across real sites and keep sources

- **Role**: Agent
- **Task**: Collect facts from articles, communities, or repositories, store structured findings, and report them.
- **Preconditions**: Access to the sites is authorized; login and high-frequency crawling are unnecessary.
- **Steps**: Explore using A01/A02 → promptly store each source with `data_store({action:"upsert",table,rows,dedupField})` → track long tasks through A09 → verify final counts and fields with `list` → associate key conclusions with `sourceUrl`.
- **Expected outcome**: The Agent adapts to ordinary site changes using fresh page observations. Structured findings include evidence/source URLs. The report agrees with Data.
- **Failure and recovery**: Use available information and explain site restrictions. Switch sources when one is insufficient. Keep conclusions tied to observed evidence after site changes.
- **Evidence**: [Agent realworld cases](background/agent-behavior-regression.py), [Agent E2E runner](background/agent-behavior-e2e.mjs), [Citation prompt unit](unit/test-llm-prompt-citations.mjs)
- **Coverage**: Medium
- **Next test**: Add factual and citation judges to HN/Wikipedia/GitHub scenarios.

### A19 · Verify task outcomes before declaring success

- **Role**: Agent
- **Task**: Check code, documents, data, and page actions against the user's actual goal.
- **Preconditions**: Observable acceptance criteria.
- **Steps**: Translate the task into one to five criteria → execute tools → independently read/query/check each result → repair and verify failures → summarize only when all criteria pass, otherwise state what remains.
- **Expected outcome**: The final answer agrees with page state, stored records, and artifact contents. Each acceptance criterion has independent evidence.
- **Failure and recovery**: Continue fixing structural or semantic failures. When the budget runs out, distinguish finished from unfinished work. Report completion against the acceptance criteria.
- **Evidence**: [Agent constructed-page regression](background/agent-behavior-regression.py) applies task-specific judges to pages, Data, documents, forms, and images. [Acceptance counterexamples](integration/test-agent-behavior-acceptance.py) reject incorrect content even when the required calls and row counts are present.
- **Coverage**: Medium
- **Next test**: Judge facts, citation coverage, and final claims in real research, and expand structural acceptance for complex Markdown and Office documents.

### A20 · Notify the user when attention is needed

- **Role**: Agent
- **Task**: Bring the user back for a completed long task, important failure, or manual blocker without excessive notifications.
- **Preconditions**: The notification has immediate value. Ordinary answers remain in the transcript; login/CAPTCHA blockers still use `wait_for_user`.
- **Steps**: Call `send_alert({message,title?,level?,dedupeKey?})` → keep waiting or working on the original task → route a notification click to its Session. Deduplicate equivalent completion alerts.
- **Expected outcome**: Only the local user is notified. Sessions share a rate limit. Explicit alerts and automation notifications deduplicate. Clicking opens the correct task.
- **Failure and recovery**: A rate-limited alert returns `suppressed` and ends that notification attempt. Transcript delivery continues when notification permission is unavailable. Use a wait tool for required user input.
- **Evidence**: [send alert unit](unit/test-send-alert-tool.mjs), [automation runtime unit](unit/test-automation-runtime.mjs), [background services unit](unit/test-background-services.mjs), [Foreground/background notification Agent journey](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py), [Notification return behavior probe](behavior/probes/notification-return.mjs)
- **Coverage**: Medium
- **Next test**: Have a real Agent decide whether to alert for blocked and completed tasks; check rate limits, deduplication, Session routing, and denied-permission fallback.

### A21 · Inspect and operate pages visually

Mobile mode: `open_tab({ url, mode: "mobile" })` uses Android Chrome settings from the first
request. `set_page_mode({ mode })` changes only the task's own page; it reloads when the mode
changes and preserves the page when the mode is unchanged. Observe again before using new
coordinates. Mobile mode survives run completion/stop while old run authority is revoked. Returning
to desktop, closing the page, or deleting the Session releases the connection. A later authorized
run reuses the connection and current page. Evidence: [Mobile browser
workflow](browser/page-mode.spec.mjs), [Page mode transactions](unit/test-page-mode.mjs), [Initial
navigation and cancellation](unit/test-open-tab-cancellation.mjs), [CDP lease
lifecycle](unit/test-cdp-runtime.mjs). In mobile mode, clicks, double-clicks, holds, drags, and
focus before typing use touch; scrolling keeps its content-scroll semantics. Evidence: [Touch
controls and cancellation](browser/mobile-touch.spec.mjs), [Single-touch failure
cleanup](unit/test-cdp-touch.mjs), [Desktop mouse
regression](browser/screen-action-runtime.spec.mjs).

- **Role**: Agent
- **Task**: Inspect layout, charts, popups, and image details; operate Canvas or remote-desktop surfaces through visual coordinates. Ask the user to complete CAPTCHAs.
- **Preconditions**: The model supports images. Observation requires a readable tab; coordinate actions require Session ownership. Visual information is more suitable than structured text.
- **Steps**: Use `screenshot({tabId})` for layout, `screenshot({tabId,target})` for one element, and `read_image({tabId,target|url})` for image content. For coordinate actions, obtain `screenshot({actionable:true})` and pass coordinates in the returned image to `act_on_screen({action,x,y,returnScreenshot,...})`. The host maps that encoded image to the captured CSS viewport. `press`, typing at the current focus, and scrolling work independently of a preceding screenshot. Direct calls show compact before/after transition frames; `returnScreenshot:true` requests a model observation. Start visual sequences one step at a time. After verifying stable effects and `viewportChange`, use bounded serial batches in `run_script`. Scripts return the last explicitly requested image. Set `destination` to save a screenshot.
- **Expected outcome**: All page screenshots share the stabilization path: capture the image, wait 200 ms, compare page and viewport state with the pre-capture state, and retry once after a change. Images fit the shared 2048 px long-edge and 2 MiB limits. Coordinate conversion uses the returned image and captured viewport dimensions. Chat transition frames remain presentation-only. Tools report dispatched input and observed viewport changes; the Agent verifies application effects from the returned observation. Batches promote the final explicit observation.
- **Failure and recovery**: Visual tools require image support. Stale navigation or viewport state, cross-Session/run use, and consumed coordinate observations require a fresh screenshot. Unclear effects return to single-step observation. Canceled holds/drags release the pointer. If a post-action screenshot fails, report the dispatched action and request another observation.
- **Evidence**: [media tools unit](unit/test-media-tools.mjs), [Image format conversion E2E](background/image-conversion-e2e.mjs), [CDP keyboard semantics unit](unit/test-cdp-keyboard.mjs), [All screen actions in real Chrome](browser/screen-action-runtime.spec.mjs), [Page structure and recovery matrix](browser/screen-action-structures.spec.mjs), [Real-extension action feedback E2E](background/extension-e2e.mjs), [Non-vision run profile gate](unit/test-llm-prompt-citations.mjs), [tab targeting unit](unit/test-session-tab-targeting.mjs), [image discovery browser](browser/image-discovery-context.spec.mjs), [tool renderer contract](unit/test-tool-renderer-contract.mjs), [Visual Agent journeys: Canvas, text replacement, selection, drag, and scroll](background/agent-behavior-regression.py), [Task-judge counterexamples](integration/test-agent-behavior-acceptance.py)
- **Coverage**: Medium
- **Next test**: Add a DOM-sufficient control task and a page-rejected action. Score whether the Agent enters coordinate mode only when needed and recovers from visual action failures.

## Runtime reliability: details

### S01 · Serialize within Sessions and run Sessions concurrently

- **Role**: System
- **Task**: Preserve causal order within a task while allowing separate tasks to run concurrently.
- **Preconditions**: Concurrent start, send, tool, or write requests in one or several Sessions.
- **Steps**: Queue commands per Session. Within that boundary, atomically start an ordinary message or queue it as a follow-up; exclusive operations such as edit/resend or compaction check the active task. Separate Sessions have separate Agents, epochs, and tabs. Events carry `sessionId/runId/eventSeq`.
- **Expected outcome**: A Session has one write lease. If the terminal state is visible while cleanup continues, new messages join the existing queue and wait for cleanup. Separate Sessions run concurrently. List and transcript order stay stable.
- **Failure and recovery**: `clientMessageId` makes repeated messages idempotent. Strict start rejects conflicts explicitly. Other Sessions continue if one stalls. Exceptions release leases.
- **Evidence**: [supervisor unit](unit/test-session-supervisor.mjs), [session commands unit](unit/test-session-commands-runtime.mjs), [message delivery browser](browser/chat-message-delivery.spec.mjs), [request isolation unit](unit/test-session-request-isolation.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: When adding a global service/registry write queue, assert a two-Session latency bound to catch accidental serialization.

### S02 · Reject late writes after stop or delete

- **Role**: System
- **Task**: Prevent old model, tool, or storage callbacks from reviving a stopped task or creating orphan resources.
- **Preconditions**: A streaming run or tool write is interrupted by stop, delete, or restart.
- **Steps**: Commit the terminal state/tombstone first → advance the epoch and revoke the lease/AbortSignal → revalidate authority on repository writes → reject stale `eventSeq/runId` in UI reducers.
- **Expected outcome**: Obsolete events, transcript writes, and Data/artifact writes are rejected. New runs can start normally. Deletion releases owned records.
- **Failure and recovery**: Temporary terminal-write failures permit retry; permanent failures release the queue with a diagnostic. Repeated termination is idempotent.
- **Evidence**: [repository unit](unit/test-background-repositories.mjs), [agent host unit](unit/test-session-agent-host.mjs), [runtime reducer unit](unit/test-session-runtime-reducer.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Give each new artifact/store a stop/delete race proving that its resource ledger rejects obsolete leases.

### S03 · Restore the Side Panel after refresh or disconnection

- **Role**: System
- **Task**: Restore from Background facts after Port loss, refresh, or reopening without duplicate messages or missing state.
- **Preconditions**: A panel in any Chrome window showing Chat, Tasks, a Data table, Skill details, or logs; Sessions may be running, queued, waiting, or completed.
- **Steps**: Read the window's saved presentation checkpoint → initialize the owning features while startup remains hidden → reconstruct Chat from Background/storage or load the selected Data table directly → reveal the final UI → attach the new Port with `windowId`, ignoring obsolete request ids and Port responses.
- **Expected outcome**: Reopening shows that window's previous stable workspace without flashing a default tab/table. Runs continue. Current Session, unsent text/image/document drafts, queue, tool expansion, and scroll intent restore according to their contracts. Browser windows and background Session events remain isolated.
- **Failure and recovery**: Corrupt or timed-out checkpoints fall back to a new chat and revoke late navigation responses. Resolve the Chrome window id at startup; if that API fails, this panel keeps drafts only in memory. Flush debounced state when the panel hides. Owning features choose safe defaults for deleted Sessions/tables/Skills. Transient dialogs and edit states reset on reopening. Canonical snapshots recover events missed during disconnection.
- **Evidence**: [workspace restore browser](browser/workspace-restore.spec.mjs), [Attachments and drafts browser](browser/chat-document-attachment.spec.mjs), [workspace store unit](unit/test-workspace-view-store.mjs), [sidepanel channel unit](unit/test-sidepanel-channel.mjs), [background contract unit](unit/test-sidepanel-background-contract.mjs), [reconnect unit](unit/test-session-reconnect-recovery.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Check clear leave/reopen behavior for `ask_user`/`wait_for_user` forms, unsaved Skill edits, and unsaved settings.

### S04 · Interrupt safely and retry after Worker restart

- **Role**: System
- **Task**: Interrupt obsolete requests after an MV3 Worker is reclaimed or terminated and allow user recovery.
- **Preconditions**: An active stream, tool, or wait.
- **Steps**: On Worker startup, scan persisted runtime state → convert nonterminal runs to `interrupted` with `reason=service_worker_restarted` → revoke old epochs → refresh the UI → retry in a new run.
- **Expected outcome**: Old readers and tool callbacks lose write authority. The transcript displays interruption. The new run uses a new epoch.
- **Failure and recovery**: Repeated restarts preserve terminal states idempotently. Durable writes survive, allowing continuation from Goals/artifacts.
- **Evidence**: [interrupted recovery unit](unit/test-agent-interrupted-turn-recovery.mjs), [runtime state unit](unit/test-session-runtime-state.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Force restart during Skill inner/page scripts and document parsing, and verify their cancellation and retry boundaries.

### S05 · Run schedules with the Side Panel closed

- **Role**: System
- **Task**: Keep scheduling in Background, independent of panel DOM or Port lifetime.
- **Preconditions**: An enabled saved automation and a running Chrome instance.
- **Steps**: Save schedule/`nextRunAt` → register a Background alarm → close the panel → wake the Worker → atomically claim the run → create its Session/Agent → persist completion, artifacts, and notification.
- **Expected outcome**: The task runs once without the panel. Duplicate alarms reuse the same claimed run. Reopening shows the correct history and artifacts.
- **Failure and recovery**: Sleep/exit recovery follows `missedPolicy`. Provider failures produce failed-run records. Notification policies apply correctly. The next run retains its scheduled time.
- **Evidence**: [automation runtime unit](unit/test-automation-runtime.mjs), [repository unit](unit/test-background-repositories.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Parameterize once/hourly/daily/weekly × run_once/latest_only/skip, including sleep spanning several scheduled periods.

### S06 · Isolate and recover tab ownership

- **Role**: System
- **Task**: Read or operate only tabs the requesting Session owns or may explicitly read.
- **Preconditions**: Parent tasks, child tasks, and MCP requests accessing several tabs concurrently.
- **Steps**: Claim atomically through the Session tab repository → resolve owner/`workingTabId` before execution → permit explicit read-only tab ids for content-only tools → recheck ownership when acquiring CDP and reuse connections per tab/run → release run authority on completion or stop/delete → update ownership on closure/navigation.
- **Expected outcome**: Concurrent claims have one winner. Parent and child Sessions retain separate ownership. CDP uses the Session tab repository and one physical connection per tab. Termination revokes reconnection authority; a new authorized run can take over. Tools require explicit tab targets.
- **Failure and recovery**: Revalidate after owner loss or external detach. Cross-task actions fail before attachment. An attachment in flight during stop is revoked before late commands can be sent. Reconnection restores persisted ownership.
- **Evidence**: [tab ownership E2E](background/mcp-tab-ownership-e2e.mjs), [tabs unit](unit/test-session-tabs.mjs), [targeting unit](unit/test-session-tab-targeting.mjs), [CDP lifecycle unit](unit/test-cdp-runtime.mjs), [Agent host terminal unit](unit/test-session-agent-host.mjs), [Session commands runtime unit](unit/test-session-commands-runtime.mjs)
- **Coverage**: Strong
- **Next test**: Test tab groups, moving between windows, and identity when the user closes an owned tab and opens the same URL again.

### S07 · Recover from storage failures, conflicts, and migrations

- **Role**: System
- **Task**: Avoid silent data loss when persistence fails, concurrent writes conflict, or schemas change.
- **Preconditions**: Repository/store writes or loading older Session, Data, or document records.
- **Steps**: Normalize/migrate at boundaries → queue writes/check optimistic versions → atomically commit source facts and derived summaries → report commit failures → allow subsequent reads/writes to retry.
- **Expected outcome**: `listSummary` can be rebuilt. Data `expectedValue/revision` conflicts are visible. Newer databases retain their version. Migrated wire shapes are canonical.
- **Failure and recovery**: Later queued writes can proceed after a failure. Permanent failure produces a terminal diagnostic. Missing fields in old records receive safe defaults.
- **Evidence**: [repository unit](unit/test-background-repositories.mjs), [session exchange unit](unit/test-session-exchange.mjs), [row id browser](browser/data-row-id-compat.spec.mjs), [Attachment database browser](browser/chat-document-attachment.spec.mjs)
- **Coverage**: Strong
- **Next test**: Inject storage quota and IndexedDB abort failures in a real extension. Verify visible failure and successful continuation after repair, without partial messages/artifacts.

### S08 · Handle Provider errors, retries, and context compaction

- **Role**: System
- **Task**: Recover from 401/429/503, timeouts, malformed streams, and context overflow.
- **Preconditions**: An Agent is making a Provider request.
- **Steps**: Normalize HTTP/envelope/SSE errors in the Provider adapter → retry only transient request-opening failures within bounds → share explicitly supplied `Retry-After`/reset waits, while ambiguous local 429 fallback affects only its request → release readers on abort. For actual context overflow, force one compaction; for recoverable stream interruption, attempt one nonstreaming fallback with transport retries disabled; for exactly `Throttling.AllocationQuota`, wait two seconds and retry once within the same request and streaming protocol. Users can also invoke `/compact` (Chinese command `/压缩上下文`) to summarize complete history except the latest turn, adding summary instructions. Persist terminal state before notifying the UI.
- **Expected outcome**: 503/timeouts retry within bounds. Sessions on the same Provider share only Provider-declared waits; other Providers are unaffected. The `AllocationQuota` retry affects its own request; other quota, authentication, and unknown errors follow their explicit classification. Error details stay in the transcript, outside the next model context. Structured errors are localized. Unsupported content-type parameter errors inside data-only SSE `error_finish` show image-capability guidance, retaining raw bodies in diagnostic traces. Unparseable `error_finish` returns bounded raw text. Compaction accumulates earlier summaries while retaining goals, durable attachment references, and tool-call correspondence.
- **Failure and recovery**: Adapter-configured `insufficient_quota`/`tpm_limit_exceeded` retries share the transport budget only before any answer, thinking, or tool fragment; waits can be canceled. Nested HTTP 429 SSE `choices` → `error_finish` → content errors follow the same recovery, including success, exhaustion, cancellation, and Provider isolation. Nested gateway errors reuse existing authentication, parameter, context, safety, and transient classifications; malformed content retains bounded raw diagnostics. Semantic recovery shares the transport retry budget. A second `AllocationQuota`, context overflow, or failed fallback ends the run immediately. Users can retry exhausted runs. Interrupted streams clear `streaming=true`. Provider changes refresh capability profiles.
- **Evidence**: [transport failure unit](unit/test-llm-transport-failures.mjs), [provider errors unit](unit/test-llm-provider-errors.mjs), [Agent recovery unit](unit/test-agent-provider-error-recovery.mjs), [provider governor unit](unit/test-provider-rate-governor.mjs), [context compaction unit](unit/test-context-compaction.mjs), [slash command unit](unit/test-slash-menu-commands.mjs), [slash command browser](browser/chat-slash-command.spec.mjs), [Extension E2E](background/extension-e2e.mjs)
- **Coverage**: Strong
- **Next test**: Move Anthropic/Codex error matrices into real-extension E2E and assert exactly one runtime terminal event and one UI failure message.

### S09 · Keep streaming transcripts and timelines stable

- **Role**: System
- **Task**: Preserve DOM identity, scrolling, and user choices while thinking, tools, answers, and aggregated timelines update.
- **Preconditions**: A long transcript with mixed renderers, deliberate scrolling, or expanded tools.
- **Steps**: Project events into Session state → assign stable turn/tool keys → reconcile → retain presentation state → anchor or follow according to scroll intent.
- **Expected outcome**: Upgrading a single tool to a timeline/family preserves its active selection. Internal cards preserve their scroll position. User scrolling and selection take priority. Leaving the tail pauses following; returning resumes it. Internal and outer scroll boundaries preserve that intent.
- **Failure and recovery**: Ordinary status phases appear only after remaining stable for 250ms; shorter tool phases remain suppressed. Retry/rate-limit waits appear immediately. Termination or run/Session changes cancel pending phases. Canonical reordering preserves DOM. Malformed results use the generic renderer. Renderer failures use the generic fallback and allow transcript updates to continue.
- **Evidence**: [status stability unit](unit/test-chat-status-stability.mjs), [status stability browser](browser/chat-status-stability.spec.mjs), [text compositing browser](browser/chat-font-stability.spec.mjs), [tool scroll browser](browser/tool-scroll-stability.spec.mjs), [thinking tail browser](browser/thinking-tail-follow.spec.mjs), [viewport fuzz browser](browser/viewport-stability-fuzz.spec.mjs), [Interaction probe checks, including 1px drift](browser/streaming-pager-driver.spec.mjs), [timeline browser](browser/tool-timeline.spec.mjs), [stream benchmark](benchmarks/message-stream.py)
- **Coverage**: Strong
- **Next test**: Require fuzz, both themes, and narrow/wide viewports for renderer or tool-profile changes.

### S10 · Refresh the Skill registry and settings atomically

- **Role**: System
- **Task**: Keep tool registry and settings lifecycles consistent during Skill install, save, rename, and deletion.
- **Preconditions**: A registry candidate or settings schema may change.
- **Steps**: Within one serial boundary, prepare the registry → reconcile/migrate/prune settings → commit the registry → emit one `plugin_registry_update`. Readers await readiness and use the last successful snapshot.
- **Expected outcome**: Registry changes share one refresh path. Renaming migrates settings; deletion removes them. Changed field constraints prune invalid old values. Running tools retain snapshot identities.
- **Failure and recovery**: Failed reconciliation preserves the previous registry and reports failure. Dirty state remains retryable on a subsequent read. The previous registry stays usable.
- **Evidence**: [registry refresh unit](unit/test-plugin-registry-refresh.mjs), [plugin settings unit](unit/test-plugin-settings.mjs), [plugin contract unit](unit/test-qingzhou-plugin.mjs)
- **Coverage**: Strong
- **Next test**: Restart the Worker after prepare, during settings reconciliation, and before commit. Recovery must expose only a complete old or new state.

### S11 · Enforce navigation, script, fetch, Skill, and MCP safety rules

- **Role**: System
- **Task**: Limit external input and privileged operations to explicitly permitted scopes, with useful recovery for users and Agents.
- **Preconditions**: Navigation URLs, scripts, Skill resources, fetches, or MCP calls supplied by a model or external package.
- **Steps**: Normalize URL/path/method/origin at each boundary → apply shared guardrails and package permissions → execute and clean up temporary privileges, or return a stable code, localized explanation, and next step.
- **Expected outcome**: Ordinary access follows the default policy, deny rules, and explicit exceptions. Skill paths stay inside their package. Managed header DNR rules match only their request and are removed afterward.
- **Failure and recovery**: Rejected operations stop before external effects. Cleanup failures retain the original permission scope. Users may explicitly change a guardrail and retry.
- **Evidence**: [security unit](unit/test-security-guardrails.mjs), [skill network unit](unit/test-skill-network.mjs), [tool runtime unit](unit/test-tool-runtime.mjs), [Explicit tool replacement and execution boundaries](unit/test-tool-replacements.mjs), [Tool replacement MV3 composition](browser/tool-replacements.spec.mjs), [MCP contract unit](unit/test-mcp-background-contract.mjs)
- **Coverage**: Medium
- **Next test**: In a real extension, reject a navigation, out-of-package resource, undeclared-origin fetch, and unsafe MCP call; verify actionable messages reach both UI and Agent.

### S12 · Install and upgrade clean, traceable packages

- **Role**: System
- **Task**: Build an installable, runnable, upgradable extension from Git HEAD with traceable output.
- **Preconditions**: Intended changes are committed, the version is valid, and locked dependencies are available.
- **Steps**: Export a temporary Git copy → bundle Background/Side Panel → minify and inject configuration → create ZIP/version.json/SHA → load in isolated Chrome → verify obsolete-file cleanup and key E2E paths.
- **Expected outcome**: The source manifest is unchanged. Bundles are deterministic; vendor bytes remain stable. Manual and Web Store archives contain identical runtime files. The Web Store ZIP has a root manifest and keeps release metadata and debug files outside it. The packaged Worker and panel actually start.
- **Failure and recovery**: Failed gates prevent distribution. Use the report to diagnose the build source or installation, repair, repackage, and verify. Distribution and tagging are separate maintainer steps.
- **Evidence**: [release bundle tests](release/bundle-release.test.mjs), [release Chrome smoke](release/chrome-smoke.mjs)
- **Coverage**: Strong
- **Next test**: Verify replacement and obsolete-file cleanup in an isolated copy of an older installation, preserving the user's active installation.

See [Release checks](README.md#release-checks) for running package checks.

### S13 · Keep long conversations, large tables, and streaming usable

- **Role**: System
- **Task**: Keep interaction latency, scroll stability, and memory usage acceptable as data grows.
- **Preconditions**: Long transcripts, many tools, large tables, several Sessions, or frequent stream patches.
- **Steps**: Load fixed fixtures → simulate scrolling, search, expansion, and editing → measure rendering, paint, drift, long tasks, and memory → compare with budgets and baselines.
- **Expected outcome**: Interaction latency stays within the benchmark budgets. Viewport drift stays within limits. Data virtualization works. Context pruning preserves behavior. Benchmark results are reproducible.
- **Failure and recovery**: Regressions fail the gate with the case/seed recorded. Performance comparisons require equivalent content and behavior.
- **Evidence**: [conversation benchmark](benchmarks/conversation-render/run.mjs), [viewport fuzz browser](browser/viewport-stability-fuzz.spec.mjs), [Data benchmark](benchmarks/data-grid-large-runner.mjs), [stream benchmark](benchmarks/message-stream.py)
- **Coverage**: Strong
- **Next test**: Define first-display, task-switch, filter, and history-expansion budgets for H02/H06/H08/H09, beyond generic rendering metrics.

## Coverage gaps

Runtime journeys S01–S10 combine unit tests, deterministic extension E2E, and browser or benchmark
evidence. Human workflows need more complete entry-to-result browser journeys for settings,
schedules, task trees, artifacts, and Skills.

Constructed-page Agent tests use task-specific judges for data, documents, forms, and images. Real
research needs factual and citation scoring. Keep default acceptance checks locally reproducible and
use live sites to evaluate adaptability. Each journey's **Next test** identifies its remaining
coverage work.

## Maintenance

- Keep journey IDs and their order once referenced by tests, issues, or release notes. Retain retired
  IDs with a `replaced-by` note.
- Every journey needs a role, task, preconditions, steps, expected outcome, failure/recovery, evidence,
  coverage rating, and next test.
- Strong coverage requires an existing test and an explicit key failure/recovery check. Use runtime evidence
  for Strong ratings.
- Update links when moving or deleting tests. Validation rejects broken links, duplicate ids, missing
  fields, and mismatched summary/detail ratings.
- A test can support several journeys. Rate each journey against the outcomes that its evidence checks.
- Live tests establish external adaptability. Default gates still need locally reproducible acceptance checks.

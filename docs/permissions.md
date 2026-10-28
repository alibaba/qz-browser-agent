# Privacy and browser permissions

This privacy policy covers the qz-browser-agent Chrome extension. qz stores its workspace in your
browser and connects to the model providers, websites, Skills, and MCP services you use for tasks.

## Information used by tasks

| Information | Use and destination |
| --- | --- |
| Prompts, conversations, attached files, and collected data | Stored locally; task context is sent to your configured model service to generate responses and choose actions. |
| Tab titles and URLs, page content, screenshots, and captured network data | Read for browser tasks. Tool results added to the task context are sent to the model service. Page and network content may contain personal or authentication information. |
| Bookmarks and browsing history | Read by their tools after Chrome grants access. Results used by a task are sent to the model service. |
| Location | Coordinates, accuracy, and timestamp are returned by `get_location` after first-use consent and sent to the model service for local information. |
| Model, Skill, and MCP credentials | Stored in your browser profile and used to authenticate requests to the corresponding configured services. |
| Screen recordings and exports | Created on request and saved locally. You choose whether to share the saved files. |

Skills can send task data to their configured services. Connected external agents receive tool
results and task data through MCP. Websites receive the requests, form submissions, and files
needed for the actions you request. Each receiving service applies its own privacy and retention
policy. Review those policies when choosing providers or enabling integrations.

## Storage and controls

Conversations, Skills, collections, and settings remain in your browser profile until you delete
them or clear the extension's storage. Diagnostic traces and cached resources are bounded by
storage limits. Delete chats, Skills, and collections from the side panel; remove configured
credentials in Settings. Uninstalling the extension removes its local storage. Downloaded files,
exports, and data already sent to other services are retained independently; delete those copies
at their destination.

You can stop a task, decline an access request, or disable the extension in Chrome. Chrome and your
operating system control device location access. Use HTTPS for remote model and integration
endpoints, and protect the browser profile that stores your settings and credentials.

## Limited Use

qz-browser-agent's use and transfer of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting_user_privacy),
including the [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Task data is used to provide the features you request.
qz does not sell this data or use it for advertising. Data sharing is limited to the services and
actions used to carry out your tasks, as described above.

For questions about this policy, contact the maintainers through the
[project issue tracker](https://github.com/alibaba/qz-browser-agent/issues). Share a description of
your question; keep credentials and personal task content out of public issues.

## Browser access

This guide explains the 19 permissions and host permission in [manifest.json](../src/manifest.json).
`history`, `bookmarks`, `desktopCapture`, and `downloads.open` are optional: Chrome requests them
when the user activates the feature. All other permissions, including `geolocation`, are declared
at installation. Chrome, operating system, and website restrictions still apply.

## Permission use

| Permission | Purpose and main callers | Feature |
| --- | --- | --- |
| `sidePanel` | Open the workspace; `background/service-worker.ts` and window commands | Core UI |
| `storage` | Store model settings, Sessions, Skills, and versioned repository records | Core state |
| `unlimitedStorage` | Persist conversations, documents, Data tables, and resources locally; disk space can still run out | Core state |
| `tabs` | Read URLs, titles, and status of task-owned tabs; `background/session/tabs.ts` | Page operations |
| `tabGroups` | Group task tabs; `shared/tab-groups.ts` | Task organization |
| `scripting` | Inject Content features and self-contained functions into task pages; `background/tools/runtime.ts` | Page operations |
| `debugger` | Use CDP to operate pages, capture screenshots, inspect requests, and print PDFs; `background/tools/cdp-runtime.ts` and tools | Page operations |
| `activeTab` | Access a page after user interaction and provide a screenshot fallback for the task's target; `capabilities/media/tools.ts` | Screenshots |
| `offscreen` | Bridge sandboxed scripts, keep background work alive, and convert images; `background/services/offscreen-document.ts` | Scripts and conversion |
| `alarms` | Schedule tasks, reminders, and background maintenance; `background/automation/runtime.ts` | Scheduling |
| `downloads` | Save files, documents, and exports; file tools, Artifacts, and export features | Files |
| `downloads.open` | Open saved files from Artifacts; `capabilities/sessions/artifacts/artifacts-feature.ts` | Files |
| `desktopCapture` | Let the user choose a screen or window when recording a case; `sidepanel/features/chat/case-recording-feature.ts` | Optional recording |
| `geolocation` | Serve the `get_location` tool after first-use consent; `background/services/location.ts` | Tool request |
| `bookmarks` | Search and manage bookmarks; `capabilities/bookmarks/tools.ts` | Optional tools |
| `history` | Search browsing history; `capabilities/bookmarks/tools.ts` | Optional tools |
| `clipboardWrite` | Copy answers, code, tables, and exported page content | UI actions |
| `notifications` | Show explicit reminders and task completion notifications; `background/services/chrome-notifications.ts` | Optional notifications |
| `declarativeNetRequest` | Apply provider headers and authorized Skill network rules to extension requests; `background/services/provider-header-rules.ts`, `background/skills/skill-network.ts` | Network access |
| `<all_urls>` | Run Content Scripts, browse across sites, and access user-configured provider and Skill endpoints | Host access |

Page tools require the Session's working tab or an explicitly authorized target. Tools, navigation,
fetch, MCP, and Skill resources also enforce shared safety checks. File URLs also require Chrome's
**Allow access to file URLs** setting.

To preview a generated HTML file, query `list_downloads` with its download ID and pass the returned
`fileUrl` to `open_tab`. The URL is available once the download completes and the file still exists.
Enable **Allow access to file URLs** in the extension details at `chrome://extensions` to open,
read, or interact with it. Each task reads the setting; if disabled, its system prompt tells the
Agent to avoid local file operations. Tools check access again before operating and return
`FILE_ACCESS_REQUIRED` when disabled.

Capabilities declare operations and UI; Background and Chrome enforce access. When removing a
feature from a distribution, review its callers, stored data, authorization checks, and manifest
together.

## On-demand access

History and bookmark tools pause with an authorization card in the side panel. Clicking **Allow
and continue** opens Chrome's permission request and resumes the tool after access is granted.
This wait is outside the tool execution timeout and ends when the task is stopped. MCP callers
must complete the same authorization in the side panel.

Recording requests `desktopCapture` when the user starts recording. Opening a saved artifact
requests `downloads.open`; downloading files continues to use the required `downloads` permission.
Chrome remembers grants until the user revokes them. Subsequent use checks the current grant and
requests access again when needed.

## Denial and recovery

- Declining an optional permission cancels that action. Retry the feature to authorize it later.
- A failed `get_location` call keeps its error code and a short next step: allow browser location, turn on system Location Services, open the sidebar, or name a city or area. A disconnected sidebar asks them to open it in this window.
- Disabled notifications make the reminder tool return `SEND_ALERT_PERMISSION_DENIED`. Completion notifications leave the task's final state intact.
- Protected pages, closed tabs, and failed CDP attachment return tool errors. Select an authorized target before retrying.
- Chrome controls screen selection. Canceling its picker ends the recording attempt.
- A failed download or file open leaves the artifact in the Session so the user can try again.
- Storage exhaustion returns a persistence failure; report a successful save after the write commits.

## First-use disclosure

The Side Panel shows a localized data disclosure before initializing the workspace. **Agree and
continue** saves the current disclosure version and opens the normal landing screen. **Maybe later**
closes the panel and leaves consent unset. The next opening shows the disclosure again.

Background gates task commands and tool execution until consent is saved. Automation scheduling,
queued follow-up recovery, and MCP bridge polling start after consent. Storage failures keep the
panel on the disclosure so users can retry. This first-use consent is separate from the location
tool's consent and Chrome's optional permission grants.

## Data flow

Requests to the selected model provider contain user input and task context, possibly after
compaction. Context can include page and file content, screenshots, tab titles and URLs, and results
from authorized bookmark and history tools. When a task needs local information, the Agent can call
`get_location`. The first call explains that coordinates, accuracy, and the location timestamp will
be sent to the configured model service. A Side Panel click records consent in local storage;
later calls reuse it. Declining leaves consent unset. Device location access and an open Side Panel
are required; a failed lookup returns recovery guidance. History and bookmarks
are read when their tools are invoked; their authorization cards explain that task results are sent
to the configured model service. Skill network access and outgoing MCP connections follow user
configuration. After first-use consent, qz enables local MCP and CLI connections. `qz connect`
starts the local service and opens a local connection page when needed. The extension verifies that
page's address and the service identity before saving its endpoint. It tries the saved endpoint
(initially `http://127.0.0.1:18765`) and becomes idle after three consecutive failures; the connection
page resumes it. Local clients can then access qz tasks and browser tools without a pairing token.
The service accepts loopback connections, validates request Host and Origin, and rejects ordinary
web-page origins. `qz stop` stops the local service. See the [connection guide](../services/mcp-bridge/README.md)
for setup and connection controls.

Provider header rules use the current `chrome.runtime.id` as their `initiatorDomains` condition.
Background installs these session rules before accepting task and model configuration commands.
Worker restarts replace the provider rules and preserve the separate Skill rule namespace.

The Chrome Web Store privacy disclosures must describe location, website content, and other task
data sent to model services, alongside any enabled Skill or MCP data flows. Keep those disclosures,
the store listing, and this policy consistent with this behavior. Use this page's public URL as the
privacy policy URL in the Chrome Web Store Developer Dashboard.

Diagnostic traces stay local. Lifecycle observers receive frozen, redacted identity and phase
metadata. Users configure model endpoints, Skill sources, and outgoing MCP connections explicitly.

For permission semantics, see the [Chrome permission
list](https://developer.chrome.com/docs/extensions/reference/permissions-list) and [Tabs
API](https://developer.chrome.com/docs/extensions/reference/api/tabs). When changing the manifest,
review this table, failure paths, and packaged Chrome tests together. Moving a feature to on-demand
permissions requires request, denial, revocation, and recovery flows.

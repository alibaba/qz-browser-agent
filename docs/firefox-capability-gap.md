# Firefox capability gap

This survey lists every Chrome-only or differing extension surface that a Firefox port has to
account for. The decisions from the confirmation list are now implemented in the Firefox package.
What a person or a tool result can still observe is in
[Firefox differences from Chrome](firefox-differences.md). The tables below record the API facts
that led to those decisions. They are not a description of the current Firefox package.

The Chrome package is unchanged: `src/manifest.json`, the Chrome side panel, and the Chrome
debugger path stay as they are. Firefox-only modules are omitted from the Chrome compilation.

The temporary-load package is built with
[`npm run build:firefox`](commands.md#load-temporarily-in-firefox). It writes
`dist/extension-firefox/` from the same sources. `npm run build` still writes the Chrome package
to `dist/extension/`.

Firefox facts below come from Mozilla's WebExtensions documentation and `browser-compat-data`.
Version numbers are that data's `version_added` values. `web-ext lint` on the built package
reports no errors for the Firefox rewrite that omits `background.service_worker`. Firefox
starts the event page from `background.scripts`. This checkout was not loaded through
`about:debugging`. Confirm that step on Firefox 154 or later.

## What the Firefox package loads

| Piece | Firefox package |
| --- | --- |
| Scripts | The Chrome module graph, plus `background/firefox-boot.js` and `sidepanel/firefox-boot.js`. Those boot modules patch Firefox APIs, then import the shared background and side panel. |
| Background | `background.scripts` is `background/firefox-boot.js` with `"type": "module"`. The Firefox manifest omits `background.service_worker`. Firefox starts the event page and does not run a service worker entry ([bug 1573659](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659)). |
| Workspace page | `sidebar_action.default_panel` is `sidepanel/sidepanel.html`. The copy in this package loads `firefox-boot.js`. `open_at_install` is `false`, so install does not open the sidebar. |
| Session automations | Disabled. The boot sets `qzSessionAutomationsEnabled` to false and clears `qingzhou.automation.scheduler`. The sidebar omits the automations controls. Stored records stay in `storage.local` and do not run. |
| MCP keepalive | While the CLI connection is enabled, the event page calls `runtime.getPlatformInfo` every 10 seconds and keeps `qingzhou-mcp-bridge-reconnect` armed. Firefox stores the bridge `connectionId` so a wake pairs the same lease. The boundary is in [MCP keepalive and reconnect](firefox-differences.md#mcp-keepalive-and-reconnect). |
| Content scripts | The same three registrations: MCP connect on loopback, session export at `document_start`, and the page tools at `document_idle`. |
| Permissions kept | `activeTab`, `alarms`, `tabs`, `tabGroups`, `scripting`, `storage`, `downloads`, `geolocation`, `clipboardWrite`, `notifications`, `declarativeNetRequest`, `unlimitedStorage`, and optional `history`, `bookmarks`, `downloads.open`. |
| Permissions added in this package only | `webNavigation`, `webRequest`, and `webRequestBlocking`, used by the page and network approximations. |
| Permissions removed from this package only | `sidePanel`, `debugger`, `offscreen`, and optional `desktopCapture`. Firefox rejects these names. They remain in [`src/manifest.json`](../src/manifest.json). |
| Data collection | `websiteContent` and `browsingActivity` are required. `locationInfo` and `bookmarksInfo` are optional. `none` is not declared. |
| Minimum version | `browser_specific_settings.gecko.strict_min_version` is `154.0`, because `sandbox` and `content_security_policy.sandbox` require Firefox 154 (`data_collection_permissions` needs 140). |
| Add-on id | Provisional `qz-browser-agent@heleifz.github.io`. Confirm it before any signed build. Changing it later changes stored data and the AMO identity. |
| Chrome `key` | Omitted from the Firefox manifest. The Chrome extension id stays `ghbaodmonhcgkfeejcpffknlggbjhjgj`. |
| Sandbox declaration | `sandbox.pages` and `content_security_policy.sandbox` are copied through. Firefox documents `content_security_policy.sandbox` from version 154. The runner page is created from the hidden offscreen frame. |

The toolbar button, the `_execute_action` shortcut, notification clicks, session-import reveal,
and the model-preset shortcut call `sidePanel.open`. On Firefox the toolbar button and the
shortcuts open the sidebar. A notification click or a session import is not user input, so it
leaves a toolbar badge and a hint to click the toolbar icon. Remaining differences are in
[Firefox differences from Chrome](firefox-differences.md).

## Portable as-is

These surfaces use APIs Firefox implements. Call sites can stay shared. A version floor is noted
where Firefox added the API later than Chrome.

| Chrome API or feature | Firefox reality | User-visible effect when present |
| --- | --- | --- |
| `chrome.*` namespace | Firefox exposes `chrome.*` and `browser.*`. | Shared call sites keep their names. No polyfill is added. |
| Manifest V3 `action`, `commands`, `default_locale`, icons, `__MSG_*` | Supported. Suggested keys are `Ctrl+Shift+K` and `Ctrl+Shift+M`. | Toolbar icon, localized name, and command entries load. The shortcut editor link is in the next section. |
| `host_permissions: ["<all_urls>"]` | Supported. A temporary add-on grants install-time host permissions without the store dialog. | Content scripts and page tools can be registered. Store-install permission UI is in the next section. |
| Content scripts and `chrome.tabs.sendMessage` | Supported. The manifest does not set `all_frames`, so injection stays on the top frame. | Page reads that already go through the content script keep that path. |
| `scripting.executeScript`, including `world: "MAIN"` | Isolated world from Firefox 102. `MAIN` from Firefox 128. | Main-world probes used by page setup can run on Firefox 128+. |
| `runtime` messaging, ports, `getURL`, `onInstalled`, `onStartup`, `getManifest`, `getPlatformInfo`, `id` | Supported. `runtime.id` is the gecko id, not the Chrome id derived from `key`. | Background and sidebar connect. The local MCP record stores whatever id the browser reports. |
| `storage.local`, `unlimitedStorage` | Supported. | Sessions, settings, and Skills use the same repository calls. |
| `tabs` and `windows`, except grouping | Supported, including `captureVisibleTab` (host permission or `activeTab`; Firefox 126 accepts either). | Open, close, list, focus, and navigate tabs. Visible-tab capture is available to callers that already use it. |
| `tabGroups` and `tabs.group` | `tabs.group` from Firefox 138. `tabGroups` from Firefox 139. `TabGroup.shared` is unsupported and unused. | Task tabs can be grouped with the same title, color, and collapsed flag. The group chrome is Firefox's. See the confirmation list. |
| `alarms` for the one-minute scheduler | Supported. The automation scheduler uses `periodInMinutes: 1`. | Scheduled tasks can wake the background. The MCP reconnect alarm is in the next section. |
| `downloads` including `download`, `search`, `open`, and `show` | Present since Firefox 47–48. Optional `downloads.open` is a valid permission. `FilenameConflictAction.prompt` is unsupported. | Save and list files. Opening a finished download can call `downloads.open`. Firefox may show its own confirm dialog. `saveAs` behavior differed before Firefox 58; current Firefox shows the chooser when `saveAs` is true. |
| `bookmarks` and `history` | Supported optional permissions. | The same tools, after the browser permission prompt. |
| `permissions.contains` and `permissions.request` | Supported for the optional permissions that remain. | History, bookmarks, and `downloads.open` still use the in-panel allow card. |
| `notifications` of type `basic`, plus `onClicked` | Supported. `buttons`, `requireInteraction`, `priority`, image and list templates, and `getPermissionLevel` are ignored or absent. | A basic completion notification can appear. It does not stay on screen the way `requireInteraction: true` does in Chrome, and its click does not open the sidebar. |
| `clipboardWrite` | Supported since Firefox 51. | Copy actions in the sidebar keep the permission. |
| `geolocation` permission and `navigator.geolocation` in the sidebar | The manifest permission exists since Firefox 54. The side panel reads the location after the in-app consent card. | `get_location` still asks inside qz. Whether Firefox also shows its own location prompt needs a device check. |
| `declarativeNetRequest` session rules | The API, `modifyHeaders`, and `initiatorDomains` exist since Firefox 113. | The calls are the same. Whether those rules match extension requests is in the next section. |
| `extension.isAllowedFileSchemeAccess` | Firefox 48–152 always returned `false`. From Firefox 153 the value follows **Access local files on your computer** in the add-on permissions. | The flag can become true on Firefox 153+. The error text still names `chrome://extensions`. |
| `commands.getAll` and `commands.onCommand` | Supported. | The model-preset command event can fire. Opening the workspace for that command is not wired. |
| Model requests, device-code login, and local MCP/CLI | Ordinary `fetch` from the extension. The bridge records `extensionId` and does not require the Chrome id. | Provider calls that do not depend on rewritten request headers can proceed. Pairing uses the loopback service. |
| Session import content script | `session-export-bridge.js` runs at `document_start` on all URLs. | An export page can message the extension. Revealing the workspace still calls `sidePanel.open`. |

## Needs a confirmed alternative

These rows record the API facts from the survey. The Firefox package now uses the approximations
in [Firefox differences from Chrome](firefox-differences.md). The rows below are not the current
behavior.

| Chrome API or feature | Firefox reality | User-visible effect |
| --- | --- | --- |
| `sidePanel` (`open`, `setPanelBehavior({ openPanelOnActionClick: true })`, `onOpened`) | No `sidePanel` API and no `sidePanel` permission. `sidebarAction` is a different API. Firefox draws the sidebar, on the side the user has set, and shows one sidebar at a time. `sidebarAction.open` and `toggle` require a user gesture. There is no `onOpened` event. | The workspace page can appear in the sidebar. It does not occupy Chrome's side panel slot, it does not follow `open({ tabId })` or `open({ windowId })`, and the toolbar button does not toggle it. Composer focus also listens to `visibilitychange` and `focus`, so the missing `onOpened` event is not the only focus signal. |
| Background service worker and offscreen keepalive | The background is an event page. `chrome.offscreen` does not exist. `offscreen.ts` pings the worker every 10 seconds from `offscreen.html`. | With the sidebar closed, the event page can suspend and drop in-memory run state that has not been written. Chrome keeps that work alive through the offscreen document. |
| `chrome.offscreen.createDocument` for SVG raster and the inner script runner | No offscreen API. The event page has a DOM, and Firefox 154 documents extension sandbox pages. This package does not move either job onto that DOM. | SVG conversion fails closed with the existing offscreen error. `run_script` returns `INNER_RUNNER_UNAVAILABLE`. Skill scripts that depend on the inner runner stop. |
| `chrome.debugger` and CDP | The `debugger` permission is rejected. There is no WebExtensions debugger API. | Tools that attach the debugger throw `DEBUGGER_UNAVAILABLE` unless a caller already catches that error. The debugging infobar Chrome shows cannot appear. |
| `act_on_element` click and press | On debugger failure, click and press already call the content script, except inside a child frame, after a partial CDP dispatch, or for mobile touch. `DEBUGGER_UNAVAILABLE` is not in the "do not fall back" set. | On Firefox those actions can return `method: "content_fallback"`. That is a DOM event, not a trusted CDP click, and it does not match Chrome's result. Fill, check, and uncheck stay on the debugger and fail. Select and in-page scroll already use the content script on Chrome. |
| `screenshot` and `act_on_screen` | Page and element capture call `Page.captureScreenshot`. The page capture catch already continues to `tabs.captureVisibleTab` unless the error is an image limit or a forbidden CDP error. `act_on_screen` sends CDP mouse, wheel, and text input. | A page screenshot can become a visible-viewport image after the tab is activated. Element clips, capture beyond the viewport, and screen actions do not have that fallback. |
| `get_ax_tree` | `Accessibility.getFullAXTree` has no extension equivalent. | The accessibility snapshot tool fails. Agents that read the page through that tree do not see the Chrome result. |
| `read_console_messages`, `network_watch`, `network_recent`, `network_body`, `wait_for_response`, `wait_for_network_idle` | These subscribe to CDP `Runtime` and `Network` events. Firefox still has blocking `webRequest` and `webRequest.filterResponseData`. | Network and console tools fail. A `webRequest` replacement would observe a different set of requests and bodies. |
| `set_page_mode` | Mobile mode uses CDP emulation: viewport, touch, and user agent. | Mobile page mode cannot be applied. Touch input in element actions follows that mode and stays unavailable. |
| PDF creation | `document` PDF rendering opens a tab and calls `Page.printToPDF`. | PDF artifacts fail with the debugger error. Other document formats that encode bytes in the background keep their current path. |
| Child frames and cross-origin iframes | CDP uses `Page.getFrameTree`, `DOM.getFrameOwner`, and `Target.setAutoAttach`. Content scripts are top-frame only. | iframe targets that Chrome resolves through CDP fail. Top-frame content-script reads continue. |
| Git Skill download through CDP | `Network.loadNetworkResource` and `IO.read` fetch an archive from a tab. | Importing a Skill repository through that page path fails. |
| Provider and Skill header rules | Session rules set `initiatorDomains` to `runtime.id`. In Chrome that id is the `chrome-extension` host. In Firefox `runtime.id` is the email-shaped add-on id, and the origin host is an internal UUID. | User-Agent and Skill managed headers can miss the extension's own requests. Kimi, DashScope, ChatGPT, and OpenCode calls that require `qz-agent/1.0.0` can fail until the condition is confirmed. |
| `desktopCapture.chooseDesktopMedia` | Not a Firefox permission or API. The recorder already returns "desktopCapture is unavailable" when the method is missing. `getDisplayMedia` is a different picker. | Case recording does not start. Replacing the picker changes the chooser, the stream id, and the audio options. |
| Shortcut settings | The settings buttons open `chrome://extensions/shortcuts`. | The buttons do not open Firefox's shortcut page (`about:addons`). Display of `commands.getAll` can still show the current binding. |
| File URL instructions | The `FILE_ACCESS_REQUIRED` text tells the user to enable file access at `chrome://extensions`. | On Firefox 153+ the real control is the add-on's local-file permission. The current sentence sends the user to a Chrome URL. |
| MCP reconnect alarm | `periodInMinutes: 0.5`. Firefox can clamp short alarm periods through its alarm minimum. | CLI reconnect after the background sleeps can be slower than in Chrome. The one-minute automation alarm is inside the portable floor. |
| Completion notification click and session import | Both call `sidePanel.open` on the user-gesture turn so Chrome accepts the open. | The click and the import message are delivered. The sidebar stays closed, so the user does not land in the imported or finished session until they open the sidebar themselves. |
| Store host permissions and data collection | Temporary loading grants install-time permissions silently. AMO requires `browser_specific_settings.gecko.data_collection_permissions` for new submissions. This manifest omits that field. Users can revoke host access later in the add-on manager. | A signed Firefox listing needs an explicit data-collection list before upload. The permission doorhanger and revocation UI are Firefox copy. |

## Not available on Firefox

These rows record APIs Firefox does not provide. The package approximates the ones listed in
[Firefox differences from Chrome](firefox-differences.md). The rows below describe the missing
API, not the current tool result.

| Chrome API or feature | Firefox reality | User-visible effect |
| --- | --- | --- |
| `chrome.debugger.attach` / `sendCommand` / `detach` | Permission `version_added` is false. No debugger API page. | Any tool that needs a debugger lease fails with `DEBUGGER_UNAVAILABLE` when it does not already catch that error. The "debugging this browser" infobar cannot be shown. |
| CDP domains used by qz: `Accessibility.*`, `DOM.*`, `Emulation.*`, `Input.*`, `IO.*`, `Network.*`, `Page.captureScreenshot`, `Page.printToPDF`, `Page.getFrameTree`, `Runtime.evaluate` on a debugger execution context, `Target.setAutoAttach` | No extension binding. | Accessibility snapshots, trusted input, element geometry from the debugger, mobile emulation, response bodies, full-page screenshots, PDF print, and out-of-process frame attach do not run. |
| `chrome.offscreen` | No API and no permission. | The offscreen document is never created. Inner `run_script`, SVG rasterization, and the keepalive ping do not run. |
| `chrome.sidePanel` | `version_added` is false for the API and the permission. | Per-tab panels, `setPanelBehavior`, and `sidePanel.open({ windowId \| tabId })` do not exist. `sidebar_action` is a different surface and is listed above for confirmation. |
| `chrome.desktopCapture` | Not implemented. | The Chrome desktop chooser, including its window and audio result, cannot be opened. |
| Manifest `key` | Ignored as a Chrome id mechanism. Firefox ids are gecko ids. | Unpacked and store installs do not share Chrome's fixed extension id. |
| `background.service_worker` as the running context | Unsupported. The event page is the background. | Service-worker-only lifetime and `clients.matchAll` do not apply. The offscreen existence check already tolerates a missing `clients` global. |
| Sandbox page as a live runner | Declaring the page does not create the offscreen iframe that loads it. | The inner runner stays unavailable even on Firefox 154+, where the sandbox manifest keys exist. |

## Decisions

The confirmation list is implemented. The Firefox package uses the sidebar for the workspace,
a hidden event-page frame for offscreen work, and page, capture, and `webRequest` approximations
for the debugger tools. Header initiator domains, file-access copy, shortcut links, case
recording, notification renewal, and `data_collection_permissions` are Firefox-only. The exact
remaining differences, including the debugging infobar, are in
[Firefox differences from Chrome](firefox-differences.md).

Session automations are disabled. The alarm API can take a one-minute period, which the survey
above records, and this package does not arm `qingzhou.automation.scheduler`. An event page can
be discarded, and the sidebar opens only from a user gesture, so an unattended session cannot
finish reliably. Definitions already stored for the add-on stay in `storage.local` and do not
start. The sidebar has no control that creates, edits, or runs one. `manage_sessions` automation
actions return `AUTOMATION_DISABLED`. The MCP reconnect alarm keeps its half-minute period. While
the CLI connection is enabled, a 10-second parent-API ping holds the event page across the
default idle timeout, and a discard resumes the stored connection id. That path does not start
stored automations. The guarantee is in
[MCP keepalive and reconnect](firefox-differences.md#mcp-keepalive-and-reconnect).

Chrome's manifest, permissions, side panel opener, and debugger implementation are unchanged.
The Firefox package is a second build output.

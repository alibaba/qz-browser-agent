# Differences from Chrome on Firefox

The Firefox package loads the same tools as Chrome. A boot module installs Firefox stand-ins
before those tools run. The Chrome package does not include that module. Its manifest and the
Chrome sentences in shared code stay on the Chrome path. Shared copy that a person can read
chooses a Firefox sentence only when `runtime.getURL("")` starts with `moz-extension:`. How the
two packages are separated is in [Firefox packaging](firefox-packaging.md).

This list is what a person or a tool result can still observe. Each row names the Firefox
behavior and the limit that remains. Platform limits cite the Firefox 158.0.1 APIs that were
inspected. Build the package with
[`npm run build:firefox`](commands.md#load-temporarily-in-firefox). It writes
`dist/extension-firefox/`. `npm run build` still writes the Chrome package to `dist/extension/`.
Chromium Playwright and the Chrome smoke test load the Chrome package only. `npm run verify` runs
the shared suites and does not launch a browser. `npm run verify:chrome` loads this Chrome package.
`npm run verify:firefox` builds the Firefox package and loads it in Firefox. See
[Run tests](commands.md#run-tests).

## Package

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Background | `background.scripts` is `background/firefox-boot.js`. That module patches Firefox APIs, then imports `background/service-worker.js`. The Firefox manifest omits `background.service_worker` so web-ext does not warn that the key is ignored. Shared build validators still see the Chrome entry before the Firefox rewrite. | The event page can still be discarded. While the CLI connection is enabled, a 10-second parent-API ping keeps it loaded across the default 30-second idle timeout, and the reconnect alarm loads it again after a discard. See [MCP keepalive and reconnect](#mcp-keepalive-and-reconnect). |
| Workspace page | `sidebar_action` is the panel. `default_panel` is `sidepanel/sidepanel.html`. `default_title` and `default_icon` match the toolbar button. `open_at_install` is `false`. The HTML loads `sidepanel/firefox-boot.js` and `sidepanel/firefox-sidebar.css` after the shared skin. | Install does not open the sidebar. Firefox's schema default for `open_at_install` is true. This package keeps false so first install matches the Chrome task flow. |
| Toolbar and shortcut | `action.default_area` is `navbar`, which is Firefox's toolbar. The suggested key that Chrome puts on `_execute_action` moves to the reserved command `_execute_sidebar_action`. Its description is the extension name. The model-preset command stays. The toolbar click calls `sidebarAction.toggle()` during the user gesture. | Firefox rejects two commands with the same suggested key, so `_execute_action` is not also declared. The extension does not add a `menus` item: the sidebar menu already lists a `sidebar_action`, and an extra `menus` permission would be a second entry point. |
| Permissions | `sidePanel`, `debugger`, `offscreen`, and optional `desktopCapture` are omitted. `webNavigation`, `webRequest`, and `webRequestBlocking` are added. There is no `update_url`. | A store review can still reject `webRequestBlocking`. If that permission is removed, response bodies are unavailable. Add-ons Manager owns updates for a signed package. A temporary add-on does not update itself. |
| Storage | Sessions, settings, and Skills use `storage.local` and the extension origin, the same repository calls as Chrome. `unlimitedStorage` stays. | The data lives in the Firefox profile for this add-on. It does not follow a Chrome profile or a Google account. |
| Identity | `browser_specific_settings.gecko.id` is `qz-browser-agent@heleifz.github.io`. `strict_min_version` is `154.0`. The Chrome `key` is omitted. | The id is provisional. Changing it later changes stored data. The minimum is 154 because `sandbox` / `content_security_policy.sandbox` require Firefox 154; `data_collection_permissions` needs 140. |
| Data collection | `data_collection_permissions.required` is `websiteContent` and `browsingActivity`. `optional` is `locationInfo` and `bookmarksInfo`. | The field is Firefox-only. `none` is not declared: tab URLs/titles and page content go to the configured model in the main flow. Location and bookmarks request Firefox's built-in optional data-collection consent when those features are used. |
| Appearance | `sidepanel/firefox-sidebar.css` sets `color-scheme: light dark` and replaces the shared tokens with `--qz-ff-*` tokens. Their base is Firefox's default sidebar: white or `#1c1b22`, `#15141a` or `#f9f9fa` text, and the violet accent `#764edd` or `#b89cff`. `sidepanel/firefox/theme.ts` recolors them from the active theme. See [Sidebar skin](#sidebar-skin). | Built-in Default, Light, Dark, and System themes return no colors (`colors: null`), so the Firefox defaults apply. On Linux the default theme draws the toolbar with GTK colors, which an extension cannot read; qz keeps the Firefox defaults there. The controls are still the shared widgets: Firefox does not give an extension its XUL widgets, and the sidebar title and close button are Firefox chrome outside this document. `browser_style` is not set; Firefox warns that it is deprecated. |

## Sidebar

The toolbar button, a notification click, session-import reveal, and the model-preset shortcut
call `chrome.sidePanel.open`. On Firefox that call is `sidebarAction.setPanel({ tabId, panel })`
when a tab id is present, then `sidebarAction.open()` with no arguments. Firefox 158
`sidebar_action.json` defines `open`, `close`, and `toggle` with an empty parameter list and
`requireUserInput: true`. Passing `{ windowId }` is not in that schema.

Firefox runs `sidebarAction.open()` only while the extension handles user input. The child API
checks `windowUtils.isHandlingUserInput` and otherwise rejects with
`sidebarAction.open may only be called from a user input handler`. Firefox 158 sets that flag
only for events declared with `inputHandling: true`: `browserAction.onClicked`,
`commands.onCommand`, `pageAction.onClicked`, and `omnibox`. Menu clicks run inside
`withHandlingUserInput`. `ext-notifications.js`
declares `notifications.onClicked` without it, so a notification click is not user input on any
platform. Focusing the window first with `windows.update({ focused: true })` does not change that
flag. A content-script message is not user input either, so the session-import jump and
"Continue in qz" cannot open the sidebar on that turn. The import still stores the session.

When Firefox refuses an open, the wrapper does the following:

1. It logs `[轻舟] firefox sidebarAction failed (<source>): <Firefox message>` with
   `console.error` in the background console. `<source>` is `api`, `notification`, or `toolbar`.
2. It updates the `qzFirefoxSidebar` counters on the background global.
3. It rejects with `Firefox opens the sidebar only from the toolbar button, the sidebar shortcut,
   or a menu item.` followed by Firefox's message.
4. When `sidebarAction.isOpen({})` reports that the sidebar is closed, it sets the toolbar badge
   to `!` and the tooltip to `qz: click to open the sidebar` (`轻舟：点击打开侧边栏`). An open
   sidebar already shows the result, so it gets no badge.
5. The first refusal in a cycle also creates notification `qz-open-sidebar` with
   `Click the qz icon in the toolbar to view.` (`点击工具栏中的轻舟图标查看。`). A refusal that
   started inside a notification click never creates a notification.

Clicking `qz-open-sidebar` still calls `sidebarAction.open()` once. A future Firefox that marks
the click as user input would open the sidebar. On Firefox 158 the click logs the real error with
source `notification`, closes the notification, focuses the last browser window, and leaves the
badge on the toolbar button.

The badge, tooltip, and notification clear whenever the sidebar page connects its `sidepanel`
runtime port. That covers the toolbar button, the `_execute_sidebar_action` shortcut, the sidebar
switcher, and the View menu. A successful open also clears them. Clearing resets the prompt, so a
later import prompts again.

`action.openPopup` is not used: this package has no `default_popup`, and `openPopup` has the same
user-input requirement. Content scripts do not receive `sidebarAction`. The import event stays
available for 15 seconds, so opening the sidebar from the toolbar in that window still selects the
imported session.

No extension entry opens `sidepanel/sidepanel.html` as a browser tab. The toolbar button,
`_execute_sidebar_action`, the sidebar menu, and a later open after consent use Firefox's sidebar
browser. about:debugging Inspect opens a toolbox. A tab whose address is the panel URL is a
manual navigation.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Opening | `open()` runs inside the user-gesture turn and is not preceded by `windows.update`. `setPanel` records the sidebar document for that tab and is not awaited, so the gesture is still current when `open()` runs. The toolbar path calls `toggle()` when Firefox provides it. A refused call follows the steps above. | Firefox draws one sidebar for the window and chooses the side. `open()` cannot target a tab or a window. A refused call is not retried and does not open a tab. A notification click cannot open the sidebar on Firefox 158. |
| Diagnostics | `qzFirefoxSidebar` in the background console holds `attempts`, `opened`, `refused`, `prompts`, `notified`, `notificationClicks`, `lastSource`, `lastError`, and `lastAt`. Every refusal is also logged with `console.error`. No debug flag is needed. | The counters reset when Firefox restarts the event page. |
| Per-tab panel | `setPanel({ tabId, panel })` is Firefox's tab-scoped panel URL. Other tabs keep the default panel. The package does not call `setPanel` with an empty string. | The open or closed state is still one per window. Firefox 158 has no API that opens the sidebar for one tab and leaves it closed in another. Switching tabs can show that tab's panel document, which for this package is the same `sidepanel.html`. |
| Focus | Composer focus still uses `visibilitychange` and `focus`. | There is no `sidePanel.onOpened`. |
| Closing | A programmatic open does not close a sidebar that is already open. The toolbar button toggles, which matches Firefox's toolbar convention and Chrome's `openPanelOnActionClick` toggle. | Chrome's side panel and Firefox's sidebar are different frames. |

## Exported conversations

An exported conversation shows **Continue in qz** when `content/session-export-bridge.js` finds
its `qingzhou-session-exchange` payload. `isAllowedSessionExchangeLocation` accepts `file:`,
loopback HTTP, and the HTTPS allowlist in both browsers. The click imports the session, then asks
for the sidebar as described in [Sidebar](#sidebar).

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Local file | Firefox injects the bridge into a `file:` page only after the user turns on **Access local files on your computer** for the add-on in `about:addons` → Permissions. In Firefox 158.0.1 the same export page received no bridge reply before that switch and replied after `internal:fileSchemeAllowed` was granted. | Without the switch a `file:` export has no button. `http://127.0.0.1` and `http://localhost` pages work without it. The tool error for `file:` tabs names the same switch; the export page itself cannot show it, because no extension script runs there. |
| Repeated imports | Each click imports a new session with the exported title. | Chrome behaves the same: the shared `importSessionExchangeRuntime` creates a session for every import and does not look for an earlier copy, so several sessions can share one title. |

## Check on macOS

Headless Linux runs the Firefox suite. Notification delivery, the macOS system accent, and focus
handling still need a Mac. Load the package and read the background console:

1. Run `npm run build:firefox`, open `about:debugging#/runtime/this-firefox`, choose
   **Load Temporary Add-on**, and select `dist/extension-firefox/manifest.json`.
2. Allow notifications for Firefox in macOS System Settings → Notifications.
3. Choose **Inspect** next to qz. Close the sidebar, then run this in the console:

   ```js
   setTimeout(() => chrome.sidePanel.open({}).then(
     () => console.log("PROBE opened"),
     error => console.log("PROBE refused:", error.message),
   ), 0);
   ```

   The console prints `[轻舟] firefox sidebarAction failed (api): …` and `PROBE refused: …`. The
   toolbar icon shows `!` and the hint notification appears.
4. Click the hint notification, then run `qzFirefoxSidebar`. `notificationClicks` grows by one,
   `lastSource` is `notification`, and `lastError` is Firefox's own message. `notified` does not
   change, and no second notification appears.
5. Check the click without qz code in the path:

   ```js
   browser.notifications.onClicked.addListener(id => {
     if (id !== "qz-probe") return;
     browser.sidebarAction.open().then(
       () => console.log("PROBE notification opened"),
       error => console.error("PROBE notification refused:", error.message),
     );
   });
   browser.notifications.create("qz-probe", { type: "basic", title: "qz probe", message: "Click me" });
   ```

   Click the notification and copy the console line. `refused` with
   `may only be called from a user input handler` confirms the Firefox 158 source reading on
   macOS. `opened` means macOS Firefox treats the click as input, and the hint copy can change.
6. Open the sidebar with Cmd+Shift+K, the sidebar switcher, or the toolbar icon. The badge clears
   each time. Repeat step 3 and the hint appears again.
7. With the macOS accent set to blue and the default theme, the primary button and the send button
   stay Firefox violet, `#764edd` in light and `#b89cff` in dark, with a 4.5:1 label. With an empty
   composer, the send button is gray with a not-allowed cursor.
8. Switch to Spark in `about:addons` → Themes, then switch macOS between Light and Dark. The qz
   sidebar matches the Bookmarks sidebar (Cmd+B) each time without a reload.

## Offscreen work

`run_script`, SVG rasterization, and the 10-second keepalive use `chrome.offscreen.createDocument`.
On Firefox that creates a hidden iframe in the event page whose `src` is `offscreen.html`. The
iframe uses the `hidden` attribute and a zero-size box. It is not `display: none`, so its scripts
run. The same `offscreen.js` keepalive, SVG conversion, and sandbox iframe run inside it.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Hidden frame | `hasDocument` stays false until the iframe loads `offscreen.html`. An `about:blank` load does not count. Overlapping `createDocument` calls share that load. A load error removes the frame, so the next `ensure()` can try again. A document that is still loading waits for `DOMContentLoaded` before the frame is created. | The minimized popup is used only when the event page has no document. That window can flash. The log line is `[轻舟] firefox offscreen uses a minimized window`. |
| Lifetime | The iframe's 10-second ping is the same message the Chrome offscreen document sends. Firefox does not treat that message as a background parent-API call, so it does not reset the event-page idle timer. | Discarding the event page drops the frame until the next `ensure()`. The CLI keepalive is the separate parent-API ping in [MCP keepalive and reconnect](#mcp-keepalive-and-reconnect). |
| Sandbox runner | The manifest still declares `runner-sandbox.html` and the sandbox CSP. | Firefox documents those sandbox keys from version 154. This approximation was not executed against a live page in the temporary-load check. |

## Page input

Click, press, and `act_on_screen` send `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
`Input.dispatchTouchEvent`, and `Input.insertText`. Firefox runs those in the page through
`scripting.executeScript`.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Mouse, wheel, keys, and text | The command hits the element at the point, or the last mouse target. It dispatches `pointerdown`, `pointerup`, or `pointermove` when `PointerEvent` exists, then the matching mouse event. A press calls `focus` when the page allows it. A click that the page does not cancel follows the default action: a link assigns `location` or opens `_blank` in a new window, and a submit control calls `form.requestSubmit`. `javascript:` links are skipped. Checkboxes are left to the page. `selectAll`, `copy`, `paste`, and `cut` call `execCommand` on keydown only. Text uses `execCommand("insertText")`, then the input or textarea value setter plus an `input` event, then a `contentEditable` append. A release with a negative coordinate is a mouseup without a click. Wheel events also scroll the document. | `Event.isTrusted` stays false. Firefox 158 has no `debugger` namespace in the extension schemas. `nsIDOMWindowUtils.sendMouseEvent`, `sendKeyEvent`, and `sendTouchEvent` are chrome-privileged and are not available to an extension. A page that checks `isTrusted` still ignores the events. A file picker still does not open. A missing element reports `Firefox could not dispatch mousedown: the page has no element at (x, y).` A missing focus for a key reports `Firefox could not press <key>: the page has no focused element.` Paste, copy, and cut report a clipboard or focus failure when `execCommand` does not apply. Inserting text with no editable element reports `Firefox could not insert text. Focus an editable element, or the page refused the untrusted insert.` |
| Touch | `Input.dispatchTouchEvent` dispatches `TouchEvent` when the page provides that constructor, and otherwise sends mouse events. | `Emulation.setTouchEmulationEnabled` only stores a flag. It does not make the page report a touch device. |
| Coordinates | `DOM.getBoxModel` returns the element's viewport quad from `getBoundingClientRect`. Clicks and iframe screenshot math in this extension use that origin. | These quads are viewport CSS pixels. Raw Chrome DevTools Protocol box models are document coordinates. |
| Stop | `Runtime.terminateExecution` returns an empty result. `Runtime.disable` also returns an empty result and leaves the console hook in place until detach. | A running page function is not interrupted. Calling `Runtime.disable` in Firefox returns `{}` and must not be treated as success at clearing the hook. |

## Screenshots

`Page.captureScreenshot` uses `tabs.captureTab`. Firefox 158 `ImageDetails.rect` is CSS pixels
relative to the page. `ext-tabs-base.js` `capture()` draws that rect. A clip that stays inside
the viewport is cropped from one visible capture. A `captureBeyondViewport` clip that falls
outside the viewport tries one `captureTab` with that rect and scale. If that throws, the tab
scrolls and up to 8 viewport pieces are stitched. `resetScrollPosition` is not sent.
`ext-tabs-base.js` allows it only when `context.extension.restrictSchemes` is false, which is
the Mozilla-signed path, and the comment there marks the option as not standardized.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Viewport | A capture without a clip returns the visible tab as base64, without a data-URL prefix. | The image is a tab capture, not a Chrome compositor surface. Device pixel ratio and zoom can differ from Chrome. |
| Element and overflow clips | An in-viewport clip is cropped where it sits. A larger clip tries one document rect. The scroll fallback keeps the rectangle that is actually visible, then repeats across and down for up to 8 captures, and restores the scroll position. | The page can jump while the pieces are taken. When the 8-capture budget stops the clip early, the background logs `[轻舟] firefox screenshot kept 8 viewport pieces; the rest of the clip was omitted`. A failed rect capture does not fall through to `captureVisibleTab`. |
| Background tabs | `captureTab` can capture a tab that is not focused. | When `captureTab` fails and no rect was requested, the fallback focuses the tab and its window. |

## Accessibility tree

Viewport AX filtering uses the internal `DOM.getNodeRects` command. It resolves the requested
backend ids and measures their rectangles in one `scripting.executeScript` call per document.
Missing or detached nodes are omitted from the batch response and remain unmeasured; they do not
trigger individual injection retries. The shared Chromium path uses DOMSnapshot and box-model reads.

`Accessibility.getFullAXTree` walks the DOM and ARIA attributes in the isolated world. An open
shadow root is entered. A same-origin iframe's `contentDocument.documentElement` is entered.
Firefox 158 has no `accessibility` namespace in the extension schemas, and no experiment-free
computed-role API was available to this package.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Nodes | The root role is `RootWebArea`. Buttons, links, inputs, images, and other mapped roles are kept. A generic or none node with no name is omitted and its children, including open shadow children, attach to the nearest kept parent. `backendDOMNodeId` matches the ids from the DOM commands. `depth` is honored. A shadow root that cannot be read is marked `shadowBoundary` `shadow root could not be read: …`. A node stopped by `depth` is marked `depthBoundary` `children below this depth were omitted` when it has light children, shadow children, or a nested document. | This is not the browser accessibility tree. Computed roles and presentational nodes are missing. Closed shadow roots stay closed. The walk stops at 4000 nodes. |
| Frames | An iframe element is role `Iframe`. A same-origin document is walked, so that frame has no boundary error. A document without an element is marked `frameBoundary` `nested frame has no document`. A document that cannot be read is marked `cross-origin nested frame is not included`. Direct child frames can be grafted through `DOM.getFrameOwner`. | A page whose iframe order disagrees with `webNavigation` can still pair a duplicated `src` with the wrong element. |

## Mobile page mode

`set_page_mode` reads `navigator.userAgent`, then sets an Android Chrome user agent, device metrics
of 412×915, touch emulation, and reloads the page. The compatibility string is the value the page
sees. It is not extension UI copy, so the Firefox catalog rewrite does not change it. Sites that
branch on a Chrome user agent keep receiving the layout the tool asked for.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| User agent | A debugger evaluation of the exact expression `navigator.userAgent` returns `Chrome/131.0.0.0` until an override is set, then returns the override. `Emulation.setUserAgentOverride` also assigns `navigator.userAgent` in the page's main world. An empty override restores the native getter. | The engine stays Gecko. `navigator.userAgentData` stays Firefox's. The main-world assignment can lose to a page script that runs first. Other expressions that read `navigator.userAgent` see the page value, not the compatibility string. |
| Viewport | The window is resized so the page's inner size is near 412×915. The previous bounds are restored when that tab clears emulation or the debugger detaches. | The whole window changes size, including other tabs. |
| Reload | `Page.reload` is `tabs.reload`. The frame's `loaderId` changes on `webNavigation.onCommitted`. | The reload is a normal tab reload. |

## PDF

`Page.printToPDF` tries one JPEG `captureTab` rect of the document, then one PDF page. If that
capture throws, it scrolls and captures up to 8 JPEG viewport slices. Each JPEG is one page.
The page size is the bitmap size in points.

Firefox 158 `tabs.json` has `print`, `printPreview`, and `saveAsPDF`. It has no `printToPDF`.
`ext-tabs.js` `print()` calls `PrintUtils.startPrintWindow`, which opens the print UI.
`saveAsPDF` creates `nsIFilePicker` in save mode and reports `saved`, `replaced`, `canceled`,
`not_saved`, or `not_replaced`. It does not return bytes. This package does not call it.
WebDriver BiDi `browsingContext.print` can return a PDF, and an extension cannot start the
Remote Agent.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Output | The result is `{ data }` with base64 PDF bytes, which is the shape the document tool already reads. A full-document capture is one page and has no truncation note. | The PDF is a raster. Text is not selectable. CSS page size, headers, and margins are ignored. Content below 8 viewport slices adds a last page whose text is `Firefox kept N of M viewport pages. Content below that was omitted.` The background also logs `[轻舟] firefox pdf kept N of M viewport pages; content below that was omitted`. `printBackground` is whatever the pixels contain. A sliced capture is one viewport wide. |
| `data:` documents | The tool opens an inactive tab and prints it through this command. | Capturing a `data:` tab was not checked in Firefox. If scripting or capture is blocked there, PDF creation fails. |

## Network and console

`Network.enable` listens with `webRequest`. `Runtime.enable` installs a console hook.
`Network.loadNetworkResource` reads through the extension's `fetch`. The manifest host
permission is `<all_urls>`, so that fetch is not limited by the page's CORS or CSP.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Requests | `requestWillBeSent`, `responseReceived`, `loadingFinished`, and `loadingFailed` are emitted on the tab, with no `sessionId`. Timestamps are seconds. Resource types are mapped onto the CDP names the monitor already accepts. Request headers are included when `onBeforeSendHeaders` runs. If Firefox rejects an `extraInfoSpec`, that listener is added without it, and `Network.enable` still returns. | The set of requests is Firefox's `webRequest` set. Cache and service-worker fidelity differ from CDP. Requests from iframes appear on the main tab monitor. |
| Bodies | A blocking listener reads the body with `filterResponseData`, up to about 1 MB and 200 entries. `xmlhttprequest`, `script`, `stylesheet`, and `other` are returned as text. Other types are base64. A missing body throws `No data found for resource`. | Truncated bodies omit the rest of the response. If the blocking listener cannot be added, bodies are not stored. |
| `loadNetworkResource` | An `http` or `https` URL returns `resource.success: true` with `httpStatusCode`, headers, and a stream handle `ff-io-<tabId>-<n>`. `includeCredentials: false` omits credentials. `disableCache: true` uses `cache: "reload"`. `IO.read` returns `{ data, base64Encoded: true, eof }`. `IO.close` drops the handle. A non-HTTP URL returns `ERR_INVALID_URL`. A failed fetch returns `ERR_FAILED` and `success: false`. | The cookies are the extension's jar for hosts it may request, not the frame's partitioned jar, and the bytes are not CDP's HTTP cache. Streams are dropped when the debugger detaches. |
| Console | `console.debug`, `log`, `info`, `warn`, `error`, and `unhandledrejection` are reported after `Runtime.enable`. The hook is installed again on navigation. | Messages from before `Runtime.enable` are not replayed. Line numbers are parsed from the wrapper stack. A burst can drop records. A failed hook install is ignored so `Runtime.enable` still succeeds. `Runtime.disable` leaves the hook in place. |

## Cross-origin iframes

`Page.getFrameTree` on the main frame includes same-origin direct child frames. A child session's
tree includes that frame's same-origin direct children. Frames that are cross-origin relative to
the main frame are omitted from the main tree and announced with `Target.attachedToTarget`.
The session id is `ff-<tabId>-<frameId>`. `targetInfo.parentFrameId` is `"0"` so the existing
direct-child consumer attaches a nested cross-origin frame without a Chrome bundle change.
Commands with that `sessionId` run in that frame. `about:blank`, `about:`, and `javascript:`
URLs stay with the parent. An origin of `"null"` is treated as cross-origin.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| Injection | The frame command uses `scripting.executeScript` with `frameIds`. | Pages that block extension scripting, including some `about:` and `data:` URLs, still fail. |
| Nesting | Every frame that is not the main frame and is cross-origin to the main frame is announced once. A cross-origin frame that leaves is announced with `Target.detachedFromTarget`. | The announced parent is flattened to `"0"`. A frame that is same-origin with the main page but nested inside a cross-origin frame is not a direct child of the main tree and is not announced. |
| Owner node | `DOM.getFrameOwner` matches the frame URL to the iframe's `contentWindow` location, then to an exact `src`, then to a `src` prefix, and uses the sibling index when several iframes share that `src`. | A page whose iframe order disagrees with `webNavigation` can still pair a duplicated `src` with the wrong element. |

## Header rules

Kimi, DashScope, ChatGPT, and OpenCode session rules set `initiatorDomains` to `runtime.id` so
the `qz-agent/1.0.0` user agent is added to the extension's own requests. On Firefox `runtime.id`
is the email-shaped gecko id, which is not a hostname. `declarativeNetRequest.updateSessionRules`
and `updateDynamicRules` rewrite an initiator domain equal to that id into the hostname of
`runtime.getURL("/")`. An update that does not include `addRules` is passed through unchanged, so
a removal is not given an add list. When the hostname already equals `runtime.id`, the rules are
unchanged, so the Chrome path is a no-op if this module were ever loaded there.

Live calls to those providers were not made from Firefox. If Firefox does not treat the
extension's UUID host as the initiator, the header is still missing.

## Copy and settings links

Catalogs in the Firefox package are rewritten. `chrome-extension://` becomes `moz-extension://`.
`chrome.debugger` becomes `debugger`. `chrome://extensions`, including the shortcuts URL, becomes
`about:addons`. `chrome://downloads` becomes `about:downloads`. A remaining `chrome://` becomes
`about:`. `Chrome Web Store` becomes `Add-ons Manager`. `Chrome` becomes `Firefox`. `ChromeOS`
is left as `ChromeOS`. `Side Panel` and `side panel` become `Sidebar` and `sidebar`. Historical
label catalogs are not rewritten. English and Simplified Chinese catalogs ship only the strings
that differ from the shared bundle, because those packs omit the full catalog and the loader
would otherwise show the Chrome sentence. Sentences that are not in a catalog use `productText`,
which returns the Chrome sentence unless the caller is a Firefox extension page.

| Feature | Firefox behavior | Known limitation |
| --- | --- | --- |
| File access | The Firefox package tells the user to open qz in `about:addons`, open Permissions, and enable local-file access. English and Simplified Chinese omit that key in Chrome and use the shared bundle sentence, so the Firefox package adds the key. The loader prefers the catalog. The English source and the Chrome package still name `chrome://extensions`. | The sentence does not deep-link to the checkbox. |
| Shortcuts | A sidebar `tabs.create` URL that starts with `chrome://extensions` opens `about:addons`. The button label comes from the rewritten catalog. | Firefox has no equivalent of `chrome://extensions/shortcuts` in this package. Shortcuts are edited from the Add-ons Manager gear menu, **Manage Extension Shortcuts**. |
| Downloads and prompts | Download hints name `about:downloads` and Firefox. Permission instructions name the sidebar and Firefox's permission prompt. | The local `qz` command process is not an extension page. Its terminal text still says "side panel". |
| Page mode | The tool description in the Firefox catalog says an Android layout. The user agent sent to the page stays the Chrome compatibility string above. | A site can still tell that the engine is Gecko. |

## Case recording

The sidebar asks for the optional `desktopCapture` permission, then calls
`desktopCapture.chooseDesktopMedia`, then `getUserMedia` with `chromeMediaSource`. Firefox has no
`desktopCapture` permission. A request for that permission alone resolves as granted. The chooser
calls `getDisplayMedia` immediately, keeps the stream, and returns the id `firefox-display`.
`getUserMedia` with a desktop source returns that stream. Audio tracks are stopped when the caller
did not ask for audio.

The picker is Firefox's display picker. The stream is the display stream itself. Audio is present
only when the user shares it. A dismissal does not open the picker again. If audio was requested
and the first call fails for another reason, the chooser tries once more without audio. Starting
a new capture stops a stream that was still held. The picker was not opened in the temporary-load check.

## Notifications

Firefox 158 `CreateNotificationOptions` has no `requireInteraction`. Passing that property makes
`notifications.create` fail with `Unexpected property "requireInteraction"`, so the completion
toast and an automation failure toast never appear. The Firefox notification wrapper copies the
options into a new plain object and deletes `requireInteraction` before `create` and before each
renewal, including when the field is inherited. Firefox still validates the object passed to the
original `create`. `priority`, `contextMessage`, and the other schema fields stay.
`ext-notifications.js` builds the alert from the title, message, and icon, so `priority` does not
change the toast.

When the caller passed `requireInteraction: true`, a notification that closes with
`byUser !== true` is created again, up to 12 times, with the stripped options. A click, a close
with `byUser === true`, or a recreate that throws stops the renewals. Firefox 158's `onClosed`
always reports `byUser: true` (the `byUser` argument is still the Bug 1413188 placeholder), so a
system dismissal does not renew. The toast still disappears on Firefox's own timer.

A completion-notification click calls `chrome.sidePanel.open` like Chrome. Firefox 158 does not
treat `notifications.onClicked` as user input, so that open is refused. If the sidebar is closed,
the click leaves badge `!` and the toolbar tooltip. It does not create `qz-open-sidebar`, so one
click never produces a second notification. See [Sidebar](#sidebar).

## Session automations

The Firefox package does not run session automations. The event page can be discarded, and
`sidebarAction.open()` runs only during a user gesture, so an unattended task cannot rely on
the sidebar or a long-lived background. On Firefox, qz is a chat and CLI assistant.

`background/firefox-boot.js` installs the host before `background/service-worker.js`. The host
sets `chrome.qzSessionAutomationsEnabled` to false, clears the alarm
`qingzhou.automation.scheduler`, and ignores a later `alarms.create` for that name. The shared
runtime sees the flag and does not schedule, tick, or start a stored automation. Records already
in `storage.local` stay there.

The Firefox sidebar document omits the automations tab, the New automation button, and the
editor. A restored task view stays on ordinary tasks. `manage_sessions` omits the automation
actions. A call that still names one returns `AUTOMATION_DISABLED`. The model prompt for this
package says scheduled tasks are unavailable.

The MCP reconnect alarm `qingzhou-mcp-bridge-reconnect` is separate. Its `periodInMinutes: 0.5`
behavior and the keepalive boundary are in [MCP keepalive and reconnect](#mcp-keepalive-and-reconnect).

## MCP keepalive and reconnect

Firefox's event page unloads after `extensions.background.idle.timeout` with no parent-process API
call from the background. The default is 30 seconds, with a floor of 0.1 seconds and a ceiling of
5 minutes. Closing the sidebar removes the visible extension view, so the idle timer is the
lifetime that remains.

While the CLI connection is enabled and the bridge is not paused, the event page calls
`runtime.getPlatformInfo` every 10 seconds. That call is the keepalive. The log line is
`[轻舟] firefox mcp keepalive armed`. Disconnect, or a paused permanent failure, clears the
timer. The log line is `[轻舟] firefox mcp keepalive stopped`.

`storage.local` holds the bridge record `_qingzhou_mcp_bridge` and the client id
`_qingzhou_mcp_bridge_client_id`. On Firefox the record also stores `connectionId`. A wake reads
that id, the pairing token, and the service instance id, then pairs with the same connection id.
The daemon accepts the new poll for this profile's existing lease. The add-on does not need a
reload. `runtime.onSuspend` writes the connection id again if a discard starts before the latest
state write.

The alarm `qingzhou-mcp-bridge-reconnect` uses `periodInMinutes: 0.5`. The boot script registers
its listener while the event page is still starting. A transport failure keeps that alarm armed
and restores the retry budget. `BRIDGE_CLIENT_IN_USE` still pauses after its one lease wait. An
incompatible bridge, a rejected pairing token, a name conflict, or missing data consent still
pauses until the user connects again.

| Guarantee | What remains |
| --- | --- |
| With the sidebar closed, an enabled CLI connection stays loaded across the default 30-second idle timeout. | An idle timeout below 10 seconds can still discard the page between pings. The alarm is the recovery, about 30 seconds after the last schedule. |
| After a discard, the alarm loads the event page and the stored lease pairs again. | A crash can drop tool calls and run state that had not been written. The alarm restores the CLI connection on the next fire. |
| Session automations stay disabled. `qzSessionAutomationsEnabled` stays false and `qingzhou.automation.scheduler` stays cleared. | This keepalive is not a scheduler. An unattended multi-step page task still has no sidebar gesture and no automation alarm. |

Probe it on a temporary load:

1. Run `npm run build:firefox` and load `dist/extension-firefox/manifest.json` from
   `about:debugging#/runtime/this-firefox`. A root-manifest zip of that directory loads the same
   package.
2. Pair with `npm run qz -- connect`, or open the pairing URL the command prints.
3. Run `npm run qz -- browsers --json` and confirm this browser is online.
4. Close the sidebar. Leave Firefox open for at least a minute.
5. Run `npm run qz -- browsers --json` again. The same browser is online. The background console
   shows `[轻舟] firefox mcp keepalive armed` while the connection stays enabled.
6. In `about:debugging`, terminate the background script. Within about a minute the browser is
   online again. Reloading the add-on is not required.

## Platform limits

These calls stay short of Chrome because Firefox 158.0.1 does not expose the API, or because the
available API opens a dialog or a privileged path this package does not use.

| Feature | What happens |
| --- | --- |
| Trusted input | Clicks, keys, and touch dispatch DOM events and then run the default action described above. `isTrusted` cannot be set. The chrome-privileged `nsIDOMWindowUtils` send methods are not in the extension API. |
| Browser accessibility tree | The tree is the DOM and ARIA walk above, including open shadow trees and same-origin frame documents. Firefox 158 ships no extension accessibility namespace. |
| Vector PDF | The PDF is JPEG pages. `tabs.saveAsPDF` opens a file picker. `tabs.print` opens the print UI. There is no `tabs.printToPDF`. |
| Per-tab side panel | `setPanel({ tabId })` selects that tab's panel document. `open()` and `toggle()` take no window or tab argument and affect the active window's one sidebar. |
| Open from a notification or a page | `notifications.onClicked` and content-script messages are not user input, so `sidebarAction.open()` is refused there. The badge, tooltip, and `qz-open-sidebar` hint point to the toolbar button. |
| Local export pages | Firefox runs content scripts on `file:` pages only after the user turns on **Access local files on your computer** for the add-on in `about:addons` → Permissions. That switch grants `internal:fileSchemeAllowed` while `extensions.webextensions.fileSchemeAccess.requireOptIn` is true, which is the Firefox 158 default. An extension cannot grant it to itself. |
| Notification priority | Ignored. |
| `Runtime.terminateExecution` | Returns `{}` and does not stop script. |
| MCP settings sender | `assertMcpSettingsSender` accepts `chrome-extension://<extension id>/` and a `moz-extension://<host>/` page. Firefox's host is an internal UUID, and `sender.id` must still be this extension. A web page URL is still rejected. |
| MCP bridge origin | The daemon allows `chrome-extension://` plus 32 characters from `a` to `p`, and `moz-extension://` plus a lowercase UUID. That UUID is the profile-local host in `extensions.webextensions.uuids` for gecko id `qz-browser-agent@heleifz.github.io`. `runtime.id` remains the gecko id. The first pair from an allowed origin issues or checks the pairing token. Later poll and result calls require it. A web origin receives `403`. `/mcp` rejects every Origin. The process still listens on loopback. Steps are in [Load qz in Firefox](cli.md#load-qz-in-firefox). |
| Session automations | Disabled. The boot does not arm `qingzhou.automation.scheduler`, and stored definitions do not start. The sidebar has no create, edit, or run control. See [Session automations](#session-automations). |
| Half-minute alarm | The MCP reconnect alarm stays `periodInMinutes: 0.5`. Firefox 158.0.1 does not clamp that value: the shipped alarm implementation stores it and schedules `periodInMinutes * 60` seconds. A temporary add-on that created `{ periodInMinutes: 0.5 }` read back `periodInMinutes` `0.5` and a first fire 30047 ms later. That alarm loads a discarded event page and resumes the stored CLI lease. It is not a session automation. |
| Geolocation prompt | The in-app consent card is unchanged. Whether Firefox also shows its own location prompt was not checked. |
| Tab groups | The same `tabGroups` calls run. The group chrome is Firefox's. `TabGroup.shared` is unsupported and unused. |
| Chrome debugger infobar | `debugger.attach` does not show a debugging banner. Firefox has no `debugger` permission in this package. |

## Sidebar skin

`sidepanel/firefox-sidebar.css` loads after the shared skin and follows Firefox's own sidebar
panels. Only the Firefox package contains it. The accent fills primary controls only and is
never mixed into a surface. The conversation stream uses 14px of inline padding, the same inset
as the header, and keeps `scrollbar-gutter: stable both-edges`. The shared skin stays at 10px.

| Token | Source | Use |
| --- | --- | --- |
| `--qz-ff-sidebar`, `--qz-ff-sidebar-text` | Firefox's `#ffffff` and `#15141a` in light, `#1c1b22` and `#f9f9fa` in dark; theme surface and ink, see [Theme derivation](#theme-derivation) | Surface and body text |
| `--qz-ff-text-deemphasized`, `--qz-ff-text-muted` | 72% and 60% of the text over the surface, raised by the palette | Inactive tabs, secondary and muted text |
| `--qz-ff-hairline`, `--qz-ff-border` | 12% and 24% of the text color; theme `sidebar_border` | 1px dividers and field borders |
| `--qz-ff-row-hover`, `--qz-ff-fill`, `--qz-ff-selected`, `--qz-ff-fill-hover`, `--qz-ff-fill-active` | 6%, 7%, 11%, 14%, and 21% of the text color | Row hover, neutral buttons, selected tab, hover, pressed |
| `--qz-ff-box`, `--qz-ff-box-hover`, `--qz-ff-box-active` | 3% (5% dark), 8%, and 12% of the text over the surface | Task rows and code blocks |
| `--qz-ff-accent`, `--qz-ff-accent-text` | Firefox's `#764edd` under white in light, `#b89cff` under `#252428` in dark; theme `sidebar_highlight`, `sidebar_highlight_text` | Palette input |
| `--qz-ff-primary`, `-hover`, `-active`, `-text` | Palette. Fallback: Firefox's `#764edd`, `#5939a8`, `#3e2976` under white in light, and `#b89cff`, `#d4c1ff`, `#eaddff` under `#252428` in dark | Primary and send buttons, checked switches |
| `--qz-ff-accent-ink`, `--qz-ff-focus` | Palette; theme `focus_outline`, raised to 3:1 on the surface | Links, code accent, 2px focus ring |
| `--qz-ff-field`, `-field-text`, `-field-border` | The surface in light, 18% black over it in dark; theme `toolbar_field`, `toolbar_field_text`, `toolbar_field_border` | Composer and inputs |
| `--qz-ff-popup`, `-popup-text`, `-popup-border` | Theme `popup`, `popup_text`, `popup_border` | Popovers and menus |
| `--qz-ff-success`, `-warning`, `-critical` | Light and dark pairs, raised by the palette on a theme surface | Status text and 12% tints |

Radii are 4px for tabs, icon buttons, and chips, 6px for buttons and code, and 8px for rows,
popovers, and cards. Icon buttons have no border or fill until hover. The selected tab is a pill
on an 11% fill. Task rows are list rows on a 3% fill. Disabled primary and send buttons use the neutral fill,
deemphasized text, and a `not-allowed` cursor instead of opacity.

`sidepanel/firefox/theme.ts` resolves the accent, sidebar, popup, and field colors through a
hidden probe element and writes these values on `:root`:

- Primary. The label candidates are `--qz-ff-accent-text`, white, and `#15141a`. A light label
  darkens the fill until the label reaches 4.6:1 at rest; hover and active darken 12% and 22%
  more, so they only gain contrast. A dark label lightens the fill until the label reaches 4.6:1
  on the active fill. The candidate that needs the smallest change wins. The macOS blue `#007aff`
  (4.02:1 under white) becomes `#0070eb`, with hover `#0063cf` and active `#0057b7`. Firefox's
  `#0060df` stays as is.
- Accent ink. The accent moves away from the surface until it reaches 4.6:1 on the sidebar and on
  a 5% tint.
- Text tiers. Each tier starts from the stylesheet share and rises until the text reaches 4.6:1
  on its surface and on the darkest fill it sits on.
- Status colors. Success, warning, and critical move away from the surface until they reach
  4.6:1 on it and on a 12% tint of themselves.

The palette is recomputed on load, on `theme.onUpdated` for this window, on a
`prefers-color-scheme` change, and when the sidebar window regains focus. When the accent cannot
be parsed, for example a `color(display-p3 …)` value, the palette is removed and the stylesheet
fallback applies.

The primary follows the window theme's `sidebar_highlight` when a theme supplies it and Firefox's
violet otherwise, the accent Firefox's own sidebar uses for its focus ring and checked controls.
The system accent (`AccentColor`) is not used. Text selection keeps the system `Highlight`, as
the Bookmarks sidebar does.

### Theme derivation

`theme.getCurrent()` returns only a theme's `theme` block. Built-in themes return
`colors: null`, so the stylesheet defaults apply and follow `prefers-color-scheme`. When the
theme has colors, `deriveFirefoxSidebarTheme()` in `sidepanel/firefox/theme.ts` picks one of two
variants.

The sidebar document's `prefers-color-scheme` follows Firefox's toolbar. When the document is
dark but the theme block is light, Firefox is painting the theme's `dark_theme` block, which an
extension cannot read. `firefoxThemeIsDark()` repeats Firefox's toolbar test to detect this: an
opaque `toolbar`, else `toolbar_text`, else an opaque `frame`, else `tab_background_text`, with
perceived brightness at most 127 counting as dark. A theme with `properties.color_scheme` set to
`dark` counts as dark.

| Variant | Key | Source, first match wins |
| --- | --- | --- |
| Painted | Surface | `sidebar`; `toolbar` over `frame`; `tab_selected` over `frame`; `frame`; Firefox's default surface |
| Painted | Text | `sidebar_text`, `toolbar_text`, `tab_text`, `bookmark_text`, `tab_background_text`, `toolbar_field_text`; else white or `#15141a`, whichever reads; raised to 4.6:1 |
| Painted | Border, field, popup | `sidebar_border`; `toolbar_field`, `toolbar_field_text`, `toolbar_field_border`; `popup`, `popup_text`, `popup_border`. A missing key keeps the stylesheet value derived from the surface |
| Derived dark | Surface | The light block's text, darkened to 2% luminance; else `#1c1b22` |
| Derived dark | Text | The light block's `frame`, `sidebar`, `tab_selected`, or `toolbar_field`, lightened to 80% luminance and raised to 4.6:1; else `#fbfbfe` |
| Derived dark | Border, field, popup | Not written, so the stylesheet derives them from the dark surface |
| Both | Accent | `sidebar_highlight` over the surface, with `sidebar_highlight_text` or a readable label; else Firefox's violet |
| Both | Focus ring | `focus_outline`, raised to 3:1 on the surface; else the accent ink |

Firefox's own dark blocks use the same swap: under Spark, the dark sidebar `#250e0b` is the light
block's `sidebar_text`, and the dark text `#f8f0ec` is the light block's `frame`. A theme switch
or an appearance change repaints the sidebar without a reload. On Linux, the default theme uses
GTK colors for the toolbar. The sidebar document cannot read them, so qz shows Firefox's default
sidebar colors there.

## Native feel

Matching Chrome wins when the result is the same task. The Firefox shape wins when Chrome's
call would be a non-Firefox argument, a warning, or a second menu.

| Choice | Why |
| --- | --- |
| `sidebarAction.open()` takes no arguments | Firefox 158's schema has an empty parameter list. An extra `windowId` is non-standard. |
| Toolbar uses `toggle()` | That is Firefox's toolbar behavior, and Chrome's action click toggles the side panel too. A notification open still only opens, so it does not close a sidebar the user already has open. |
| Import jump points at the toolbar | A page message and a notification click cannot satisfy `requireUserInput` in Firefox 158. The badge, tooltip, and `qz-open-sidebar` name the toolbar button, which is user input. The session is already stored. |
| `_execute_sidebar_action` owns the shortcut | Firefox toggles a sidebar from that reserved command. `_execute_action` would not. |
| No custom context menu | The sidebar menu and the toolbar button are already Firefox's. A `menus` permission would add a warning and a second entry. |
| `open_at_install: false` | Firefox would otherwise open the sidebar during install. The Chrome task does not. |
| Firefox defaults, then the window theme | The shared theme stays in the Chrome package. The Firefox base is `color-scheme: light dark` and Firefox's default sidebar colors, which cover built-in light, dark, and system themes when `theme.getCurrent()` has no colors. A theme recolors the sidebar from its sidebar keys, or from its toolbar, tab, and frame keys when it has none, the way Firefox themes its own sidebar panels. See [Theme derivation](#theme-derivation). `onUpdated` for another window is ignored. The package does not call `theme.update`, does not declare the `theme` permission, and does not ship a static `theme` key. |
| No `resetScrollPosition` | Firefox treats it as non-standard and ignores it unless the add-on is Mozilla-signed. |
| No `saveAsPDF` | The file picker interrupts the task and does not return PDF bytes. |
| Catalog rewrite plus `productText` | Firefox pages say Firefox, sidebar, `about:addons`, and `about:downloads`. `chrome.debugger` in a catalog becomes `debugger`. English and Simplified Chinese receive the rewritten sentences the shared bundle would otherwise show. Chrome pages keep the Chrome sentence. The page-mode user agent stays a Chrome string so the site receives the layout the tool requested. |

The sidebar title and close control are Firefox's header, outside this document. Chat, Tasks, Data, and Skills stay one row of tabs. Code stays monospace. Status colors keep their hue, so they can disagree with a custom theme. A theme's text, text tiers, primary, accent ink, and status colors are raised to 4.5:1, and its focus ring to 3:1.

## What this check did not run

`npm run verify:firefox` loads `dist/extension-firefox/` in Mozilla Firefox. The Playwright suite
temporarily installs that package, opens the sidebar from the toolbar button and from the
`_execute_sidebar_action` shortcut, and checks that the panel is Firefox's sidebar browser rather
than a tab at `sidepanel.html`. In light and dark `prefers-color-scheme`, with a macOS accent of
`#007aff`, under a temporary theme add-on, and under a light-only theme in a dark sidebar, it measures text at 4.5:1 and icons and focus rings
at 3:1 in rest, hover, active, and focus-visible states. It also checks that disabled primary and
send buttons are neutral and show a `not-allowed` cursor, and that the sidebar has no horizontal
overflow at 320 and 400 pixels. It covers `notifications.create` with `requireInteraction`, a
refused `sidePanel.open()`, a hint-notification click, a completion-notification click, and badge
clearing from the shortcut, the sidebar switcher, and the toolbar.

Headless Linux has no notification server, so the suite sets `alerts.useSystemBackend` to false
and clicks Firefox's own alert window through its `alertclickcallback` observer. A macOS
Notification Center click, the macOS system accent itself, and window focus on macOS need the
[macOS check](#check-on-macos). These paths are still not exercised in that window: a provider
request, the display-capture picker, a real-page click, an accessibility snapshot, a PDF of a
page, mobile resize, the `about:debugging` button, and the geolocation prompt.

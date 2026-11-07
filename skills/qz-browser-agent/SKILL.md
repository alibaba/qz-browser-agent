---
name: qz-browser-agent
description: Drive the connected browser through qz (轻舟) scripts. Create one titled session per task, pass its sessionId to every script, and bind each page with qz.tab(tabRef). Read qz skill for the installed CLI's guide. Read references/create-task.md only when the built-in agent should plan the task.
---

Use the installed `qz` command. If unavailable, use `npx -y qz-browser-agent@latest` in place of `qz` in the commands below. Run `qz skill` once at the start of a task for the matching guide. `qz --version` prints its version.

<!-- qz-drive-guide:en -->
The external agent plans the work and drives the connected browser through qz (轻舟). Do not configure a qz model or call `qz create`. Read references/create-task.md only when the built-in agent should plan and execute the task.

## Connect

Run commands with Node.js 22+ on the machine running the browser extension:

```sh
qz status --json
```

Session and script commands prepare the connection automatically: they reuse a responding online browser, or open the connection page once in your supported system default browser (Chromium or Firefox) and wait for its extension to respond. Complete the extension's first-use notice and connection prompt when shown. If the extension is missing, `qz install` opens the store; ask the user to install it.

When multiple browsers are registered, run `qz browsers --json` and pass `--client CLIENT_UUID` to select a profile explicitly. Existing sessions are located via read-only queries before execution; ambiguous or unavailable ownership requires explicit selection. To pair a specific profile without launching a browser, run `qz connect uri --name work --json` and open `result.url` in that profile. An incompatible local service is restarted once before browser operations; an incompatible extension requires updating the CLI and extension together.

## One task uses one session

Run `qz session create --title "Inspect example page"` first. A readable `--title` is required (omitting it exits 2). stdout prints `sessionId <id>`; with `--json`, read `result.sessionId`. Each call creates a fresh session without starting a model.

Pass that same ID to every `qz script --session ID` call (missing `--session` exits 2). Scripts never create or resume a session implicitly. Use separate sessions for independent tasks. Run `qz session list` to list sessions and `qz session show ID` to read `{sessionId,title,status}`. If an ID is not found, check `qz session list` and the selected browser; never invent an ID.

```sh
CREATED=$(qz session create --title "Inspect example page" --json) || exit 1
SID=$(printf '%s' "$CREATED" | node -e 'const x=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!x.ok || !x.result.sessionId) process.exit(1); console.log(x.result.sessionId)') || exit 1
qz script --session "$SID" - <<'JS'
// Open one page and read its relevant text.
const opened = await qz.openTab({ url: "https://example.com", tabAlias: "page" });
return await qz.tab(opened).read({ limit: 3000 });
JS
```

`qz.openTab({url,tabAlias?})` creates a page and returns a Tab `{tabRef,url,title,active}`; `qz.listTabs()` returns a list in `tabs`. `qz.tab(...)` binds an existing page using that Tab, its `tabRef`, or its optional alias. Aliases use 1–64 letters, digits, underscores, or hyphens (not all digits), and expire when the tab closes. Returned positive integers or numeric strings are valid references; never guess one. `active` marks the tab visible to the user and never selects an operation's target. Use `page.goto(url)` to navigate an existing task tab. `page.setMode("mobile")` switches to mobile mode (`"desktop"` restores it); a change reloads the page, so re-observe it afterward.

One tab belongs to one session at a time. Use `qz.listTabs({scope:"all"})` for read-only inspection of other tabs, and a session-owned page for actions or evaluation. Binding a Page neither changes ownership nor selects the active tab.

## Scripts and the qz SDK

`qz script --session ID [FILE|-] [--args JSON]` runs JavaScript orchestration outside web pages. Read a local file or `-` for stdin; `--args` passes a JSON value exposed as `args`. Use top-level `await` and `return`, starting with a short comment stating the script's purpose. The outer script survives page navigation and provides `qz`, `args`, `trace()`, and `console`, without `document`/`window`, Node.js, `fs`, `process`, `require`, or `import`. Awaited SDK calls return business values directly and throw on failure.

Bind `const page = qz.tab(tabRef)` and use:

| Purpose | SDK methods |
| --- | --- |
| Navigation and page mode | `page.goto(url, options?)`, `page.close()`, `page.setMode(mode)` |
| Focused observations | `page.read({limit,...})`, `page.find({role:"link",...})`, `page.axTree(options)`, `page.screenshot(options)` |
| Page JavaScript | `page.evaluate(code, args?, options?)` |
| State waits | `page.waitForURL(pattern, options?)`, `page.waitForLoad(options?)`, `page.waitForFunction(code, args?, options?)` |
| Element operations | `page.locator(targetOrQuery)` with the methods below |

Use `qz.listTools()` for compact signatures of additional capabilities and `qz.listTools({names:["list_images"]})` for selected full schemas. Invoke those capabilities and loaded Skill tools through `qz.call(name, args)`, using their catalog names and explicit `tabRef` for page calls. Read unfamiliar schemas before calling; loaded Skills can register additional tools.

Access page DOM and authenticated `fetch` inside self-contained `page.evaluate` or `page.waitForFunction` callbacks, including DOM reads used to build the outer return value. Their second argument supplies the function's input; return a JSON-serializable value. Closures, DOM nodes, functions, Page objects, and Locators cannot cross the page boundary.

```sh
qz script --session "$SID" --args '{"limit":1000}' - <<'JS'
// Reuse the page opened earlier and read a compact DOM summary.
const page = qz.tab("page");
await page.goto("https://example.org");
return await page.evaluate(
  ({ limit }) => ({ title: document.title, text: document.body.innerText.slice(0, limit) }),
  args
);
JS
```

Use outer SDK methods for clicks, form input, and navigation. `page.evaluate` waits for `DOMContentLoaded` by default (third argument `{waitUntil:"commit"}` allows early observation); wait for specific conditions when reading dynamic content. The page function has DOM access and cannot call the qz SDK. Navigating or closing its page can interrupt an in-flight evaluation; catch its error if the outer script should continue. Inspect completed state before retrying an uncertain action.

## Observe, act, and verify

Observe the relevant controls and choose the result needed by the next step. Use `page.read({limit})` for document text, lists, and tables, or a scoped `page.axTree(...)` / `page.find(...)` for controls. Element observations identify nodes by `target` (`uid:t<tab>.<snap>.<n>` or `css:...`); `rect` is `{x,y,width,height}`. Pass returned targets unchanged to `page.locator(target)`. A `uid:` always identifies its original node; navigation or DOM replacement can make it stale, requiring a new observation.

Use search results as leads; verify key facts on the original pages. Include source URLs for key findings and make clear when evidence or coverage is incomplete.

`page.locator(query)` stores a query and resolves it when an operation runs. Queries accept `target`, `role`, `name`, `text`, `exact`, `scope`, and `nth`; at least one of `target`, `role`, `name`, or `text` is required. The SDK accepts `{css:"#input"}` as shorthand for `{target:"css:#input"}`; use one form. CSS lists have one prefix for the whole expression (`"css:input, button"`). `name` matches the accessible name reported by `page.find` or `page.axTree`; `text` matches element text. Both normalize whitespace and match exactly, case-sensitively, by default; `exact:false` matches a substring. `scope` is an observed `uid:` or `css:` root, including a frame document reference. A pinned UID already identifies its scope; do not combine it with `scope`. Element operations require one match: narrow an ambiguous query or explicitly choose `locator.nth(index)` using a zero-based index.

Locator methods are `click(options?)`, `doubleClick(options?)`, `hover(options?)`, `fill(value, options?)`, `press(key, options?)`, `select(value, options?)`, `check(options?)`, `uncheck(options?)`, `scroll(options?)`, and `dragTo(destination, options?)` on the same tab. Actions locate and wait for a usable element within their shared `timeout` budget (seconds, default 20, maximum 120), then dispatch once. Call the next locator operation directly; it handles readiness. Dispatched actions are never automatically replayed. Ordinary success returns `{}`, with `navigated`/`url` or `navigationPending` when navigation is detected, and `popups` for observed new Tabs. If `confirmationRequired` is true, verify the field locally before continuing.

```js
// Fill an observed form and choose its asynchronously appearing suggestion.
const page = qz.tab("page");
await page.locator(args.fieldTarget).fill(args.query);
await page.locator({ role: "option", name: args.expectedOption }).click({ timeout: 10 });
return await page.locator(args.fieldTarget).inspect();
```

Use `locator.inspect()` for current element state and `locator.read({limit})` for its text. `locator.wait({state:"visible",timeout:10})` waits for `attached`, `visible` (default), `hidden`, or `detached` state. Hidden includes removal or invisibility; detached requires removal. `locator.count()` reads the current attached match count, including hidden elements; `locator.wait({count:3,timeout:10})` waits for exactly that count, including zero. Use either `state` or `count` per wait. A match or count describes the current moment; it does not prove a dynamic list has finished updating.

When an action must cause navigation or a popup, pass `waitFor:"navigation"` or `waitFor:"popup"` in its options. This installs the listener before dispatch. Navigation returns its observation; popup returns a Tab `{tabRef,url,title,active}` directly. A failed wait never replays the action.

```js
// Open a detail page and read it.
const popup = await qz.tab("page").locator({ role: "link", name: "Details" })
  .click({ waitFor: "popup", timeout: 10 });
return await qz.tab(popup).read({ limit: 2000 });
```

Navigation waits observe new navigations, including reloads, SPA transitions, and hash changes. `page.waitForLoad()` checks the current load state; `page.waitForURL(pattern)` matches the full URL using a regular expression string or a `RegExp`. For in-page updates, use `page.waitForFunction(code, args?, options?)` to wait for the specific fields needed by the next step and return them. Keep action, condition, and focused result in one script. Match the requested item or mode as well as its required fields. Reserve fixed delays for tasks that require elapsed time.

```js
// Open a place's details. This page clears the old detail fields while loading.
const page = qz.tab("page");
await page.locator(args.itemTarget).click();
return await page.waitForFunction(name => {
  const panel = document.querySelector(".place-details");
  const title = panel?.querySelector("h2")?.textContent?.trim();
  const address = panel?.querySelector(".address")?.textContent?.trim();
  return title === name && address ? { name: title, address } : null;
}, args.place, { timeout: 20 });
```

Use selectors and fields observed on the page. If it retains previous values while loading, also wait for a completion signal that distinguishes the selected item's result.

`page.find` returns an array of current element observations (up to `limit`), or `[]` when none match. Use normal array operations, e.g. `(await page.find({role:"link"})).slice(0,5)`; `waitFor:"match",timeout:10` waits for a candidate. Use `role`, `tag`, and `type` for single filters, or `roles`, `tags`, and `types` for multiple alternatives; use one form per filter. For example, `page.find({tag:"input",type:"search"})` finds search inputs. Its `pattern` accepts a regex string (case-insensitive by default) or a `RegExp`, as in `page.find({role:"link",pattern:/download/i})`; a `RegExp` supplies its own flags. Locator `name` and `text` match their specific fields. `page.axTree` uses `scope:"viewport"` or `"full"`; narrow `target` or `limit` when inspecting one control. Reserve screenshots for visual checks.

Run one `qz script` at a time per session. Within it, use `await` for dependencies and `Promise.all` for independent page workflows. Same-page actions serialize; the caller sees results when the script returns. `Promise.all` preserves input order and rejects on first failure without cancelling siblings; use `Promise.allSettled` to retain every outcome. Await all calls before returning: exit cancels unfinished calls.

```sh
qz script --session "$SID" - <<'JS'
// Open and read each page independently.
return await Promise.all(
  ["https://example.com", "https://example.org"].map(async url => {
    const opened = await qz.openTab({ url });
    return await qz.tab(opened).read({ limit: 1500 });
  })
);
JS
```

Scripts are not transactions: completed actions remain in effect after a later failure. Return only the business data needed for the task. Use `trace()` at key checkpoints, such as completed stages and counts, to aid recovery. `trace` contains only errors and explicit `trace()`/`console` output, in order.

## Documents and larger results

For PDFs, load the document Skill before reading: call `qz.call("list_skills", {})`, then `qz.call("load_skill", {name:"qingzhou-documents"})`, and follow its schemas using the original PDF URL. PDF viewers do not support ordinary body reads or element actions. Keep returned `fileId`/`docModelId` values within the session and follow chunk cursors only as needed. `qz.call("load_skill_resource", {name,path})` parses packaged documents directly.

Images and files remain in their artifact stores; return their references. Business results exceeding ~48,000 characters become `{truncated:true,totalChars,limitChars,preview}`; narrow the query or paginate instead of treating `preview` as complete. `ToolError` is never truncated.

## Output and recovery

stdout is JSON `{ok,result,trace}` on success and failure. `ok` reports execution success; `result` is the returned business value (`null` for `undefined`) or the uncaught `{code,message,hint?,details?}` error (with script line/column in `details`); `trace` lists errors and explicit `trace()`/`console` messages in order, without levels. Exit codes: `0` success, `1` execution or connection failure, `2` invalid CLI arguments.

`--timeout` sets script execution seconds (default `120`, range `>0` through `3600`); the request waits 60 seconds longer. Give the calling shell a longer deadline. A timeout or interrupted connection does not undo browser actions; inspect the session and page before repeating an action.

- Disconnected: retry with the same `--session ID`; connection preparation is automatic. Use `qz connect uri` to pair a specific browser profile.
- `DRIVE_SESSION_NOT_FOUND`: check `qz session list` and `--client`.
- `DRIVE_SESSION_ENDED`: create a new session for a new task.
- `DRIVE_SESSION_BUSY`: wait for the active operation to finish. Put concurrent page work inside one script with `Promise.all`.
- `TAB_REF_REQUIRED`: bind `qz.tab(tabRef)` using a reference from `qz.openTab` or `qz.listTabs`.
- Unknown alias or stale target: inspect `qz.listTabs()` or refresh the element observation. After a failed open, only reuse an alias if `qz.listTabs()` confirms it.
- Login or challenge: stop and ask the user to complete it in the browser.

## Finish

Run `qz session cancel "$SID"` when the task is done. It ends the session and closes its created tabs (including while a script is running), while preserving pre-existing user tabs and tabs handed back to the user. To leave result pages open, pass their references with `--keep result --keep evidence`; all references are validated before stopping. Kept pages return to the user and the session still ends. Do not call `page.close()` after the session ends; further calls return `DRIVE_SESSION_ENDED`.

Ctrl-C (`SIGINT`) or `SIGTERM` cancels the current script while preserving its session and tabs; already-dispatched browser actions may still finish and are not undone. CLI process exit does not close task tabs; ~30 minutes of inactivity triggers cleanup while the extension runtime is running. Always run `qz session cancel` for task cleanup. The side panel for a drive session is view-only. Use the qz SDK for page content and the shell for local files.
<!-- qz-drive-guide:end -->

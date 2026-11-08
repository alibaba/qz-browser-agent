# Qingzhou for DeepSeek Harness

[中文](README.zh-CN.md)

Use Qingzhou (轻舟) to operate your connected Chrome, Edge or Firefox from dsh. The
`qz_browser` tool runs scripts through the installed `qz` CLI. Results, authored traces,
scripts and screenshots appear in a compact conversation card that follows dsh's theme.

## Install

Requires Node.js 24.9 or later, dsh `0.2.2-rc.1`, and a matching qz CLI and browser extension.
Install [Qingzhou](https://alibaba.github.io/qz-browser-agent/), open its side panel once,
and complete setup.

```sh
npm install --global qz-browser-agent
qz --version
```

After this package is published, install it into the profile you use:

```sh
dsh plugin --profile web add dsh-browser-qz
```

You can also install the package from dsh's Plugins page. Installation enables its bundle;
restart dsh when the installer requests it. For a local package, replace the package name
with the absolute path to the `.tgz` produced by `npm pack` below.

Ask dsh to use Qingzhou to read a page or complete a browser task. The CLI prepares the
connection automatically. For another browser profile, run `qz connect uri` and open the
printed URL in that browser.

## Browser scripts

The model calls `qz_browser` with a short `title`, JavaScript `code`, optional JSON `args`,
and a `timeout` in seconds. The plugin creates and retains the browser session for the
conversation. Browser operations use the qz SDK:

```js
const opened = await qz.openTab({ url: "https://example.com", tabAlias: "example" });
const page = qz.tab(opened);
trace("Opened the example page");
return await page.read({ limit: 2000 });
```

Later calls reuse `qz.tab("example")`. Use `page.goto(url)` to navigate the same tab,
`page.locator(query)` for actions, and `page.evaluate(fn, args)` for page DOM access.
Independent page workflows can use `Promise.all` inside one script. The plugin serializes
separate calls in the same conversation.

Return the data the next step needs. To show a screenshot, include its receipt in the return
value, for example `return { screenshot: await page.screenshot() }`. The adapter attaches
images exported by the CLI to the dsh result. Merely capturing an image without returning
it does not attach it. The model receives `{ok,result,trace}` and image attachments;
the card displays the same result and trace. Trace contains script-authored messages and errors.

Return the complete `page.read()` or `page.axTree()` result to retain its presentation, including
inside an object such as `{ article, structure }`. Articles render Markdown with their title and
source; page structure separates roles, names and targets, with collapsible branches. Screenshots
and `read_image` results use image previews that open the original, with dimensions and format.
Raw values remain available through Inspect and Copy. Ordinary Markdown tables render as tables;
embedded HTML, including complex merged-cell tables, is shown as text by dsh's Markdown renderer.

Stopping a running call interrupts that script and retains its session and tabs. Completed
browser actions are not rolled back. Resuming the same dsh conversation retains its binding;
a fork gets its own browser session. If the qz session has ended or expired, the call reports
that fact before executing the script, and the next call can open fresh task pages.

## Configuration

Defaults use `qz` from `PATH` and the CLI's normal connection settings. Optional overrides
belong to the `browser-qz` entry in your profile patch:

```yaml
- id: browser-qz
  config:
    cliPath: /absolute/path/to/qz
    client: work-browser
```

`cliPath` can also point to `services/mcp-bridge/src/bin.mjs` in a qz checkout. `stateDir`
selects a separate qz state directory when needed; leaving it unset shares the ordinary CLI
service. `client` selects a paired browser by its name or UUID. Use `qz browsers` to list them.
On Windows, use the npm-installed CLI or its JavaScript entry so cancellation can reach the CLI.

## Develop and package

From this directory:

```sh
npm ci
npm test
npm run build
npm run check:package
```

`check:package` packs, installs in a temporary directory, checks both entry points, and writes
the tested tarball to `dist/`. `npm pack` also builds a tarball directly.
The tarball contains the host adapter, the built dsh client, bundle configuration, locale
metadata and documentation. Installation runs no build script. `npm pack` builds the client
locally; React and dsh services are supplied by the host. The browser extension and CLI are
separate installations.

The source package is in `services/dsh-plugin`. Keep its dsh peer versions aligned with the
version used for integration checks. Review the package contents and set the intended version
before publishing with `npm publish --access public`.

# Firefox packaging

Status: adopted. Chrome remains the default build. The skin and palette are unchanged.

`npm run build` and `npm run dev` write `dist/extension/`. `npm run build:firefox` and
`npm run dev:firefox` write `dist/extension-firefox/`. Day-to-day commands are paired:
`dev` with `dev:firefox`, and `build` with `build:firefox`. Checks follow the tiers in
[Commands](commands.md): `npm run verify:firefox` runs when a change puts the Firefox package at risk.

`npm run release` writes the Chrome zip. `npm run release:firefox` writes the unsigned Firefox
archive. A CI upload of that archive stays deferred at the bottom of this page.

Related pages keep their current jobs. [Commands](commands.md) lists the commands.
[Firefox differences from Chrome](firefox-differences.md) lists behavior a person can observe.
[Firefox capability gap](firefox-capability-gap.md) records the API survey. This page owns how the
two packages are separated.

The CLI daemon is outside both packages. `npm run qz` and the published `qz` command run
[`services/mcp-bridge`](../services/mcp-bridge/README.md). Load and pair steps are in
[Load qz in Firefox](cli.md#load-qz-in-firefox).

## Decision

The browser is a build-time package target. `chrome` is the default. `firefox` is the other target.
One source tree emits one package per target.

| Axis | Selector | What it chooses |
| --- | --- | --- |
| Browser | `--browser chrome\|firefox` on [build-extension.mjs](../scripts/build-extension.mjs) | Output directory, which sources are emitted, manifest, sidebar document, sidebar skin, locale supplements |
| Product | `--product`, read by [product-profile.mjs](../scripts/product-profile.mjs) | Composition facades under `src/products/`. The default product is `public` |
| Sentence | `productText` in [product-text.ts](../src/shared/product-text.ts) | One of two strings already compiled into a shared module, chosen when that module runs |

The product axis and the browser axis compose. `npm run build -- --product public --browser firefox`
is a Firefox package of the public product. A product facade stays free of host branches. Host
behavior belongs to the Firefox adapter or to `productText`.

Edge loads the Chrome package. There is no `--browser edge` target.

`esbuild` `target: "chrome114"` is the JavaScript language floor for both packages. It is not the
browser target.

## What the build owns

`prepareBuild` accepts `chrome` or `firefox` and defaults to `chrome`. The default output is
`dist/extension/`. The Firefox output is `dist/extension-firefox/`. `--output-dir` overrides either
default. The two directories can be watched at the same time because each watcher locks its own
output.

For `firefox`, [firefox-manifest.mjs](../scripts/firefox-manifest.mjs) runs after the shared compile
and rewrites only that output:

| Rewrite | Result in `dist/extension-firefox/` |
| --- | --- |
| `firefoxManifest` | Drops `key` and `side_panel`. Drops `debugger`, `desktopCapture`, `offscreen`, and `sidePanel`. Adds `webNavigation`, `webRequest`, and `webRequestBlocking`. Sets `sidebar_action`, moves the suggested key to `_execute_sidebar_action`, and sets `background.scripts` to `background/firefox-boot.js` without `service_worker` (Firefox ignores that key). Points `action.default_icon` and `sidebar_action.default_icon` at `icons/firefox/qz-glyph.svg` and keeps the brand `icons` for about:addons. Sets `browser_specific_settings.gecko`. |
| `rewriteFirefoxSidepanelHtml` | The sidebar document loads `firefox-boot.js` and `firefox-sidebar.css`. |
| `writeFirefoxSidebarSkin` | Writes `sidepanel/firefox-sidebar.css`. That file has no twin under `src/`. |
| `rewriteFirefoxLocaleFiles` | Rewrites catalog sentences in the Firefox copy. `src/` locale sources stay on the Chrome wording. |

`src/manifest.json` stays the Chrome manifest. The Chrome output manifest matches it.

## What runtime code owns

Runtime detection chooses a sentence inside a package that the build already selected. It does not
choose permissions, entry points, or which files exist.

`firefoxExtension()` is true when `chrome.runtime.getURL("")` starts with `moz-extension:`.
`productText(chromeText, firefoxText)` returns the matching sentence. Both sentences ship in every
package, because the shared module ships in both. Use it for inline strings in shared modules.
Catalog copy that should exist in only one package goes through the locale rewrite above, so the
Chrome catalog keeps the Chrome sentence alone.

Firefox API stand-ins install from the boot modules, which run before the shared graph:

- [background/firefox-boot.ts](../src/background/firefox-boot.ts) imports `background/firefox/host.ts`, then `background/service-worker.ts`.
- [sidepanel/firefox-boot.ts](../src/sidepanel/firefox-boot.ts) imports `sidepanel/firefox/host.ts`, then `sidepanel/sidepanel.ts`.

`installFirefoxHost` patches `sidebarAction`, notifications, offscreen, debugger, and network
hooks on the `chrome` object, then the shared service worker reads that object. It supplies
Firefox's missing `Tab.pendingUrl` through main-frame request and commit events. Request IDs keep
errors from replaced requests from clearing a newer navigation; commits, errors, no-content responses
and tab removal clear the pending field. This adapter uses the package's existing permissions.
The host also sets
`qzSessionAutomationsEnabled` to false, clears `qingzhou.automation.scheduler`, and arms the
Firefox MCP wake (`qzFirefoxMcpWake`) before that service worker starts. The wake pings a parent
API while the CLI connection is enabled and registers `qingzhou-mcp-bridge-reconnect` during
event-page startup. Session automations stay disabled. The boundary is in
[MCP keepalive and reconnect](firefox-differences.md#mcp-keepalive-and-reconnect). The side panel host does the same for display capture, extension-page
URLs, and the sidebar palette, and sets the same automations flag.
`rewriteFirefoxSidepanelHtml` removes the automations tab, the new-automation button, and the
editor from the Firefox sidebar document. The
`qzFirefoxHost` and `qzFirefoxSidepanel` flags make that install run once. They are not a second
browser switch. Behavior a person can observe is in
[Session automations](firefox-differences.md#session-automations).

A runtime flag cannot be the package boundary. Firefox rejects unknown permission names at install,
and the entry script is fixed by the manifest. One manifest cannot be the Chrome package and the
Firefox package. A flag read after startup can change a sentence or patch an API the package was
allowed to call. It cannot take `sidePanel` out of a package Firefox has already refused to load,
and it cannot keep Firefox boot code out of the Chrome zip.

## Source layout

Host adapters and Firefox-only assets live in these trees:

```text
src/background/firefox-boot.ts
src/background/firefox/**
src/sidepanel/firefox-boot.ts
src/sidepanel/firefox/**
src/icons/firefox/**
```

`isFirefoxOnlySource` is that set. The Chrome compile drops those paths. The Firefox compile emits
them plus the shared graph. The Firefox build fails when a manifest toolbar or sidebar icon is
missing from the package.

`icons/firefox/qz-glyph.svg` is the toolbar and sidebar glyph: the Side Panel send-button mark
from `sidepanel.html`, scaled into a 16px box. Keep its path equal to the send mark. Firefox grants
SVG context paint only to Mozilla extensions, so `context-fill` alone draws nothing for qz. The
glyph names a fallback fill for each color scheme: `#15141a` for light and `#fbfbfe` for dark.
Firefox loads the image with the color scheme of the toolbar or sidebar that shows it.

Shared extension modules leave those paths alone. The boot files are the extension importers.
Tests may import the adapters directly. A new Firefox-only module is imported from
`background/firefox/host.ts` or `sidepanel/firefox/host.ts`, which the matching boot file already
loads.

The shared graph is the program both packages run. The Firefox package includes it on purpose:
the adapters wrap `chrome.*`, and the service worker and side panel stay the callers. There is no
Chrome-only source tree. A file with no Firefox caller would need a matching exclusion predicate
on the Firefox compile. No such file exists in this tree, so the predicate is not added here.

Production bundling inlines the service worker and the side panel, then deletes modules that only
those bundles imported. `background/firefox-boot.js` and `sidepanel/firefox-boot.js` stay outside
those bundles. Every static import they reach, except the two bundled entries, remains a file in
`dist/extension-firefox/`. The build fails if one is missing. The boot path reads alarm names from
`shared/reconnect-alarm.ts` and `shared/automation-scheduler-alarm.ts`. It does not import
`background/mcp/mcp-bridge.ts` or `background/automation/runtime.ts`, so those modules are not
loaded a second time beside the service worker.

Generated files that differ by target are written by the Firefox build step into the Firefox
output. They are not committed under `src/`, so the Chrome copy step never sees them.

`src/products/` stays a product axis. `readProductProfile` selects facades whose paths match
`{background,shared,sidepanel}/product/*.ts` and whose implementations live under
`src/products/<product>/`. Browser packaging does not read or write those ports.

### Dead weight

| Package | What it contains | What stays out |
| --- | --- | --- |
| `dist/extension/` | Shared sources, Chrome manifest, Chrome locales | Paths matched by `isFirefoxOnlySource`. The generated sidebar skin. Rewritten Firefox locales |
| `dist/extension-firefox/` | Shared sources, Firefox boot modules, toolbar glyph, rewritten manifest, generated skin, rewritten locales | `key`, `side_panel`, and the permission names Firefox rejects |

The path filter decides which files are copied and which modules are esbuild entries. esbuild still
follows imports from disk. On a Chrome build, a relative import or a bundled input whose path
matches `isFirefoxOnlySource` fails the build with
`Chrome package cannot import Firefox-only source …`. The Firefox build allows that import. The
boot files remain the extension importers.

## Commands

| Command | Target | Output |
| --- | --- | --- |
| `npm run dev` | `chrome` | Watches `dist/extension/` |
| `npm run build` | `chrome`, production, typecheck | `dist/extension/` |
| `npm run dev:firefox` | `firefox` | Watches `dist/extension-firefox/` |
| `npm run build:firefox` | `firefox`, production, typecheck | `dist/extension-firefox/` |
| `npm run dev -- --browser firefox` | `firefox` | Same directory as `dev:firefox` |
| `npm run build -- --browser firefox` | `firefox`, production, typecheck | Same directory as `build:firefox` |
| `npm run verify` | Shared suites | Typecheck, then `unit`, `contracts`, and `services`. Does not launch Firefox or Chromium Playwright |
| `npm run verify:chrome` | Chrome package suites | `browser`, `e2e`, `release`, and `visual`. Loads `dist/extension/` |
| `npm run verify:firefox` | Firefox suite | Builds `dist/extension-firefox/` in development mode, then runs `tests/unit/test-firefox-*.mjs` and Firefox Playwright |
| `npm run verify:coverage` | Shared suites plus Chrome package suites | The coverage gate. Same suites as `verify` and `verify:chrome`, with `--coverage` |
| `npm test -- firefox` | Firefox suite | Same suite as `verify:firefox` without the leading typecheck |
| `npm run release` | `chrome` | `dist/releases/<version>/qz-browser-agent-extension-<version>.zip` |
| `npm run release:firefox` | `firefox` | `dist/releases/<version>/firefox/qz-browser-agent-firefox-<version>.xpi` |

`build:firefox` is the production package you load in Firefox. `verify:firefox` rebuilds a
development package in that same directory unless `QINGZHOU_FIREFOX_EXTENSION_DIR` is set. A shell
that exports the variable tests the directory as it stands, including a production build left by
`build:firefox`. Leave the variable unset for the suite's own development build.

Typecheck is repository-wide. `npm run build` and `npm run verify` typecheck Firefox sources
even though they emit the Chrome package. One TypeScript program covers both targets. Emit stays
per target.

## Release archive

`npm run release:firefox` runs `python3 scripts/publish-release.py --target firefox`. It compiles
with `build-extension.mjs --browser firefox`, the production path `npm run build:firefox` uses,
then zips those files with `manifest.json` at the archive root. The archive stays on disk.
Uploading and tagging remain separate maintainer steps. `npm run release` with no `--target`
still writes the Chrome manual zip.

```bash
npm run release:firefox -- --version 0.0.0.1
npm run release -- --version 0.0.0.1 --target firefox
```

`--version` is required, as it is for `npm run release`. Load a temporary add-on from
`dist/extension-firefox/` with **Load Temporary Add-on**. `npm run build:firefox -- --no-bundle`
forwards the extra build flag. `--browser` remains the switch that product and browser flags share
on the build command, so a product build can still pass both.

## Release artifacts

[publish-release.py](../scripts/publish-release.py) writes one archive per `--target`. With no
`--target` it compiles Chrome and writes `qz-browser-agent-extension-<version>.zip`.
`--target webstore` writes `qz-browser-agent-extension-<version>.webstore.zip`. The manual zip keeps
the public `key`. The webstore zip removes `key` and places `manifest.json` at the ZIP root. That
`key` fixes the unpacked Chrome id `ghbaodmonhcgkfeejcpffknlggbjhjgj`. `--target firefox` compiles
with `--browser firefox` and writes the unsigned `.xpi` below.

The Firefox archive is a separate directory and a separate file:

```text
dist/releases/<version>/firefox/qz-browser-agent-firefox-<version>.xpi
dist/releases/<version>/firefox/qz-browser-agent-firefox-<version>.debug.zip
dist/releases/<version>/firefox/version.json
```

The `.xpi` is a zip of the extension files, which is the layout
[Package your extension](https://extensionworkshop.com/documentation/publish/package-your-extension/)
requires: `manifest.json` is a direct child of the archive, and the parent directory is omitted.
The bytes are a zip stored with an `.xpi` name. The archive contains the runtime files from the
Firefox production build, including the license notices the Chrome release packages. It omits
`.git`, source files, and `META-INF`. Add-ons Manager adds the signature on upload. The manifest
keeps `browser_specific_settings.gecko`, including id `qz-browser-agent@heleifz.github.io`, and the
Firefox permissions from `firefox-manifest.mjs`. There is no `key`. `version.json` records
`browser: "firefox"` and `geckoId`. The debug zip stays local, as the Chrome debug zip does. The
version number is the same `manifest.version` as the Chrome archive of that commit. The stores do
not share an update channel.

### Identifiers

| | Chrome | Firefox |
| --- | --- | --- |
| Id | `ghbaodmonhcgkfeejcpffknlggbjhjgj`, from `key` | `qz-browser-agent@heleifz.github.io`, from `browser_specific_settings.gecko.id` |
| Where it is set | `src/manifest.json` | `FIREFOX_GECKO_ID` in `firefox-manifest.mjs`, applied only to the Firefox output |
| Minimum browser | Chrome's own | `strict_min_version` `154.0` |
| Data collection | Chrome Web Store form | `websiteContent` and `browsingActivity` required; `locationInfo` and `bookmarksInfo` optional. `none` is not declared |

The ids are independent. `runtime.id`, `storage.local`, and update URLs belong to the browser that
loaded the package. The Firefox build deletes `key` so the Chrome id mechanism is absent from the
Firefox manifest. The gecko id is provisional until the first signed upload. A later change of that
id splits stored data and the Add-ons Manager identity. Temporary builds keep this id so profiles
created during development match the eventual listing.

## Developer workflow

CI already runs the two targets as two jobs in [ci.yml](../.github/workflows/ci.yml). The portable
job builds `dist/extension/` and runs focused Chromium contracts on Linux, macOS, and Windows. The
`firefox-package` job runs `npm run verify:firefox` on Linux. That split is the CI shape. A
matrix cell on the portable job would rebuild Chrome on each OS and still need a Linux Firefox
install, so the Firefox gate stays its own job.

Local checks follow the tiers in [Commands](commands.md). Small changes and docs run no suites;
ordinary changes run typecheck plus focused tests. When a change carries broad or browser-specific
risk, this table shows which suite covers it.

| Change at risk | Suite |
| --- | --- |
| Shared runtime, manifest, locales, content scripts, or `scripts/build-extension.mjs` | `npm run verify`; add `npm run verify:firefox` when Firefox behavior is at risk. The Firefox package compiles the shared graph |
| Chrome side panel, Playwright, e2e, release, or visual behavior | `npm run verify:chrome`. Set `QINGZHOU_PLAYWRIGHT_WORKERS` for the Chrome run |
| Firefox-only trees, `scripts/firefox-manifest.mjs`, `tests/firefox/**`, `tests/unit/test-firefox-*.mjs` | `npm run verify:firefox` when the Firefox package is at risk. The Chrome package's file set does not include those sources |
| Product facades under `src/products/` | The same shared-runtime row. Product selection is orthogonal and still ships in both packages |

`npm test -- unit --match firefox` is the inner loop for adapter work. `npm test -- firefox` runs
the Firefox suite without a fresh typecheck.

A change to the Chrome emit path, including a new field inside the packaged `.qingzhou-build.json`,
is a Chrome package change. Prove the default `npm run build` output against the previous Chrome
tip when that path is edited. A Firefox-only edit leaves that output byte-identical.

## What landed

| Piece | Behavior |
| --- | --- |
| Build-time target, default Chrome | `--browser`, two output directories |
| Firefox manifest, boot, skin, and locale rewrite | `firefox-manifest.mjs` after the shared compile |
| Chrome exclusion of Firefox paths | `isFirefoxOnlySource` on the copy and entry list, plus a compile error when a Chrome graph still imports one |
| Runtime sentence helper | `productText` / `moz-extension:`. It chooses a sentence inside the built package |
| Product axis | `--product` and `src/products/`, orthogonal to the browser |
| `build:firefox`, `dev:firefox` | Aliases for `--browser firefox`. `npm run build` and `npm run dev` stay Chrome |
| `release:firefox` | Unsigned `.xpi` at `dist/releases/<version>/firefox/`, with `manifest.json` at the archive root |
| Build summary | The log line and `--json` stdout include `browser`. The packaged `.qingzhou-build.json` does not |
| Checks | Tiered by change size. Broad shared-graph changes run `verify`; `verify:chrome` and `verify:firefox` cover browser-specific risk. Coverage is `verify:coverage` |
| CI | The separate `firefox-package` job runs `verify:firefox`. The portable job stays an OS matrix for Chrome |
| Typecheck | One program for the repo |

## Deferred

| Piece | Why it waits |
| --- | --- |
| Signing and Add-ons Manager upload | Maintainer steps. The local `.xpi` is the unsigned file AMO signs |
| CI success upload of `dist/extension-firefox/` | The job already fails the build when Firefox tests fail. A success artifact is extra weight on the workflow |
| Gecko id confirmation | `qz-browser-agent@heleifz.github.io` stays the id until the first signed upload |
| `productText` rename | A rename rewrites shared modules and moves the Chrome package hash |
| Data-collection lists | They stay as declared. `none` stays undeclared |

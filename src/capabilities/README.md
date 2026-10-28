# Capabilities

Add a package under `src/capabilities/` to extend qz with tools, result cards, pages, model
providers, or embedded Skills. Declare its contributions in `index.ts`; the build discovers them
automatically.

Start with the [working example](../../tests/fixtures/capabilities/example/README.md) and keep the
parts you need. Capabilities compile with the extension and use its trusted SDK. User-installed
Skills are runtime file packages with access to controlled scripts and declarative rendering.
They can use [result selection cards](../../docs/skill-result-selection.md) to let users choose
candidates before an Agent continues.

## Start with a tool

Create `src/capabilities/example/index.ts`:

```ts
export { default as tools } from "./tools.js";
```

Add `tools.ts` in the same directory:

```ts
import type { ToolExtensionAPI } from "#sdk/background";
import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

const t = createTranslator(defineMessages("example-tool", {
  title: { "zh-CN": "回显文本", en: "Echo text" },
  description: { "zh-CN": "返回输入的文本。", en: "Return the supplied text unchanged." },
  text: { "zh-CN": "要返回的文本", en: "Text to return." },
}));

export default function (qz: ToolExtensionAPI) {
  qz.registerTool({
    name: "example_echo",
    get title() { return t("title"); },
    get description() { return t("description"); },
    get parameters() { return {
      type: "object",
      properties: { text: { type: "string", description: t("text") } },
      required: ["text"],
    } as const; },
    execute: ({ text }) => text,
  });
}
```

Run `npm run dev` and load `dist/extension/` in Chrome. After rebuilding, reload the extension and
reopen the side panel. Argument types are inferred from the schema; the host handles validation,
cancellation, timeouts, permissions, and errors. Page tools declare `page: "owned"` and use the
task's tab from the call context. Require an explicitly owned target.

Tools using bookmarks or history declare `requires: { browserPermission: "bookmarks" }` or
`"history"`. The host waits for user authorization before starting the tool deadline. Obtain the
Chrome API inside the handler through `qz.getBookmarks()` or `qz.getHistory()` so newly granted
permissions take effect immediately. See [permission handling](../../docs/permissions.md#on-demand-access).

## One package, separate runtimes

```text
capabilities/example/
  index.ts          Contribution declarations
  tools.ts          Background execution
  renderers.ts      Side Panel rendering
  result.ts         Shared result types and parsers for this package
  ui.ts             Optional pages or settings
  ui.html / ui.css   Optional templates and styles
```

Choose filenames to suit the package; larger packages can use subdirectories. Keep `index.ts` to
static named re-exports. The build imports each declared module directly into its runtime.

| Export | Contribution | Runtime |
| --- | --- | --- |
| `tools`, `skillHosts` | Registration functions for tools and embedded Skill hosts | Background |
| `providers`, `presets` | Model protocols and provider presets | Background |
| `context`, `observers` | Context source factories and lifecycle observer arrays | Background |
| `renderers`, `ui` | Registration functions for result views, pages, and settings | Side Panel |
| `metadata`, `modelCapabilities` | Tool identity and model capabilities | Shared |
| `skills` | Embedded Skill registration function | Shared |
| `artifacts`, `codecs` | Artifact adapter map keyed by tool name; document codec array | Shared |
| `translations`, `locales` | Messages and language packs | Shared / build |

Build-time tools can declare `behavior.parallelRead` for pure observations. The Agent applies it only
to explicit tab lanes. `parallelOpen` permits provisional creation; `parallelTab` permits tab-local
mutations such as navigation and element actions. `barrier` accepts a boolean or synchronous argument
predicate, evaluated once per call during batch planning. True or a thrown predicate waits for every
preceding commit and blocks later execution until its own commit. It overrides all three parallel
roles while retaining page targeting and `tabRef` validation. All ready calls share one execution limit of ten.
Same-tab work follows execution dependencies. UID-targeted calls use their registered tab lane when
all targets are known UIDs on one tab and the definition grants a parallel role. Declare additional
target fields through `behavior.uidTargets`; the extractor extends `target`, `selector`, and `root`.
Return every target, including non-UID values, so mixed or cross-tab calls retain commit barriers.
Implicit targets and undeclared/global tools also retain commit barriers. Runtime-owned Session writes, effects, final events and results publish in
original call order, independently of execution completion order. Start and progress events publish
during execution, including flow-control waits. A `parallelOpen` handler obtains
its new tab's execution context from `context.prepareCreatedTab` before page preparation. Declared
parallel handlers leave Session ownership and selection writes to the runtime's ordered commit.
Use `parallelRead` only for operations without resource or page writes. Article, element and AX
readers must not scroll, focus or activate tabs. Native screenshot fallback serializes its activation,
capture and restoration transaction per window. Installed Skill manifests, trusted Skill host aliases,
model arguments and result
payloads cannot grant scheduling authority; the selected definition must come from a core registry
snapshot. Any build-time capability can use these fields through `qz.registerTool`; there is no tool-name
allowlist. For example, `qz.registerTool({ ...definition, behavior: { ...definition.behavior, barrier: true } })`
marks a tool that may touch global resources. Skill/plugin tools (`source: "plugin"`) are always barriers;
manifest fields cannot opt them into parallel execution. `run_skill_script` remains a barrier.
`run_script` declares `parallelTab: true` and a barrier predicate: inner mode or code that may use
host tools is a barrier; no-tools page code uses the normal tab lane. Omitting `target` means page,
and `mutatesPage` controls effects rather than classification. The capability's conservative static
classifier also selects bridge installation. Input/args-only code needs no bridge. Unknown syntax
stays a barrier; missing tool access in a no-bridge invocation returns an error without replay.
Parallel page observations read the current page mode without restoring a disconnected
mobile preference, because restoration may reload the document.

Core page-tool schemas with `tabId` also expose `tabRef`. The Agent resolves it from an
`open_tab.tabAlias` in the same assistant `tool_calls` array before invoking the tool runtime.
Place each creator before its consumers. Readers can use a completed creator's private execution
permit before its ownership is published; actions await the creator's commit. The runtime carries
numeric targets and opaque authority through normal safety checks. Session ownership and working-tab
selection publish only at ordered commit. Cancellation closes uncommitted creations. The host rejects
unresolved references at direct-runtime boundaries. See [batch ordering and failure
semantics](../../docs/architecture.md#tool-and-skill-execution).

A handler can call `context.reportPartial?.(result, pending)` after a completed stage. The host copies
that result into a call-local slot, reads it only at the existing hard timeout, and revokes late
updates. Use concise `pending` text naming the unfinished work. `behavior.timeoutResult` selects the
host's page-read, action-uncertainty or navigation fallback. Page identity and safety checks still
apply; an image partial is an observation without coordinates.

Tools pass serializable results to renderers. Package imports are limited to their own files, pinned
npm dependencies, and `#sdk/*`. Type checking applies each runtime's constraints to its dependency
graph and requires every TypeScript file to be reachable from a contribution declaration.

## SDK

| Task | API and working example |
| --- | --- |
| Register tools and access task pages | [Background API](../sdk/background.ts), [table-tool.ts](../../tests/fixtures/capabilities/example/table-tool.ts) |
| Render results and format summaries | [Renderer API](../sdk/sidepanel/renderers.ts), [value-card.ts](../../tests/fixtures/capabilities/example/value-card.ts) |
| Add pages, settings, and commands | [UI API](../sdk/sidepanel/ui.ts), [ui.ts](../../tests/fixtures/capabilities/example/ui.ts) |
| Manage settings drafts | [settings-form](../sdk/sidepanel/settings-form.ts) |
| Add model protocols and providers | [Provider API](../sdk/background/providers.ts), [provider guide](../../docs/providers.md) |
| Supply context or observe lifecycle events | [Context API](../sdk/background/context.ts), [Observer API](../sdk/background/observers.ts), [example](../../tests/fixtures/capabilities/example/context-and-observer.ts) |
| Parse and export documents | [Document API](../sdk/shared/documents.ts), [JSON codec](../../tests/fixtures/capabilities/example/json-document-codec.ts) |
| Use Data, Skill, and task services | [Runtime services](../sdk/background/services.ts), [shared protocols](../sdk/shared/) |

Run `npm run docs` to generate `dist/docs/api.md` from public types for complete field and method
signatures. These APIs are still evolving; see [extension
contracts](../../CONTRIBUTING.md#extension-contracts).

Keep registration synchronous and lightweight. Start listeners and tasks inside factories. UI
contributions can defer expensive code with a literal `import("./implementation.js")`; MV3
Background contributions remain statically bundled. Share the load Promise and check the instance's
signal before using its result. If the browser caches a module load failure, reopen the side panel.

## Add a result view

Add `rendererId: "example.echo"` to the tool definition and this declaration to the index:

```ts
export { default as renderers } from "./renderers.js";
```

In `renderers.ts`:

```ts
import type { RendererExtensionAPI } from "#sdk/sidepanel";

export default function (qz: RendererExtensionAPI) {
  qz.registerRenderer(qz.project("example.echo", (parent, view) => {
    parent.textContent = String(view.result ?? "");
  }));
  qz.registerPresentation({
    id: "example.echo",
    argsSummary: ({ args }) => `(${String(args.text ?? "")})`,
  });
}
```

`project` supplies updates, cleanup, and static export. For views that preserve interaction state,
implement `mount/update/dispose/renderStatic` and bind listeners to the instance signal.
`renderStatic` returns an offline-readable Node synchronously using the supplied view. Keep
summaries synchronous and pure. A failed render falls back to the generic view; a duplicate
registration ID is an error.

Define structured result types and parsers in the package, and declare the return type of `execute`.
Renderers validate `unknown` before reading it. Interactive views and offline exports share a
projection; unrecognized historical results retain a readable text or JSON fallback. Use runtime
validation before narrowing result types. See the example
[result.ts](../../tests/fixtures/capabilities/example/result.ts).

New tools return artifacts through `artifacts[]`, with stable `type/kind`, identity, and counts. The
`artifacts` contribution adapts existing results: `normalize` normalizes explicit envelopes, while
`project` extracts artifacts from older results. Translate labels at display time, but preserve user
titles and filenames.

## Add a page or settings

In `ui.html`:

```html
<template id="example-ui">
  <section id="example-page" class="hidden" data-i18n="example.pageTitle">示例页面</section>
</template>
```

Declare `export { default as ui } from "./ui.js";` in the index, then register the page in `ui.ts`:

```ts
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { t } from "./i18n.js";

export default function (qz: UiExtensionAPI) {
  const view = qz.mountTemplate("example-ui");
  const page = view.querySelector<HTMLElement>("#example-page")!;
  qz.registerPage({ id: "example", title: t("pageTitle"), order: 80, elements: [page] });
}
```

Define `pageTitle` in the package's messages and export `translations`; the [localization
guide](../../docs/localization.md) shows how to write `i18n.ts`. Use `capture/restore` to preserve
page position and `activate/deactivate` to handle navigation.

`qz.on` subscribes to read-only events accepted by the framework. Use `qz.onDispose` to release
owned resources, bind DOM listeners to `qz.signal`, and check lifecycle cancellation before
asynchronous updates. Discard late results after disposal. Store UI preferences in the package
namespace through `qz.storage`; use host APIs for task and resource data. Cooperate with other
packages through optional commands and handle their absence.

### Settings

`registerSettings` creates a separate tab by default. Groups with the same `tab: { id, title, order
}` share navigation and a Save button, but retain their own drafts, persistence, and cancellation
signals. Each group commits independently; failed groups keep their drafts for retry.

For ordinary forms, use `createSettingsForm(qz, { initialValue, getDraft, setDraft, load, save,
renderState })`. Pass its `activate/deactivate/save` methods to the settings registration and call
`changed()` on input. The helper separates the submitted snapshot from later edits and handles
revisions and late results. Writes already submitted to Chrome may complete after cancellation.

Put actions such as reloading the UI in `afterSave`. It runs only when every group in the current
save succeeds and the submitted revision still matches the current draft. Previously saved groups on
the same tab also receive the callback; check the signal again after each `await`.

## Replace an existing tool

To replace a package's tool, provide a complete tool definition with `replaces: "tabs/open_tab"` and
keep `name: "open_tab"`. Every package follows the same rules: the target must exist, and ordinary
name collisions, competing replacements, self-replacement, and replacement chains are errors. Remove
the replacement package and rebuild to restore the original. Running tasks retain their own
snapshots.

A replacement supplies its full schema, description, execution function, permissions, and policies.
To reuse the original renderer, keep its result structure and existing metadata registration. Use a
unique `rendererId` and metadata ID for a different view. See the [replacement contract
tests](../../tests/unit/test-tool-replacements.mjs).

## Add an embedded Skill

Declare `export { default as skills } from "./skills.js";` in the index, then register the Skill:

```ts
import type { SkillExtensionAPI } from "#sdk/shared/skill-definition";

export default function (qz: SkillExtensionAPI) {
  qz.registerSkill({
    name: "example-guide",
    displayName: "Example guide",
    description: "Use when organizing notes from web pages.",
    content: "# Reading notes\nRead the page, group findings by topic, and retain source links.",
    resources: [],
  });
}
```

For multilingual Skills, provide localized getters for the display name, description, and content;
use `aliases` to retain names in other languages. Keep normalized names and aliases unique. Scope
defaults to `global`; `site` and `resident` are also supported. Site matching controls automatic
activation. An explicit `load_skill` can load any enabled Skill by name. Resources declare
`path/type/content`; binary resources also use `encoding: "base64"`. Paths must stay within the
package. The framework marks embedded Skills read-only; removing the capability removes them on the
next build.

For controlled Background execution, add `skillHosts` and use `registerSkillHost` to bind a
registered manifest tool to a `target` or implement `execute(args, context)`; these options are
mutually exclusive. Calls pass task identity, cancellation, permission, and effect checks. Trusted
host bindings require build-time registration. See the [document hosts](documents/skill-hosts.ts).
Preserve historical manifest and script values such as `plugin.json` and `$plugin` in installed
packages and user history.

## Templates and styles

The build includes `ui.html/ui.css` beside UI and renderer implementations. Asset paths resolve
relative to the source file, and exports use the same skin. Reuse `qz-*` controls and complete
static `qz:` classes; put complex states in the `components` layer. The build supplies Tailwind and
the shared skin. See the [design system](../../docs/design-system.md) for available classes.

Keep copy with its package. Preserve tool identifiers, action values, enums, and stored values
verbatim. See [localization](../../docs/localization.md) for message definitions.

## Find an implementation to build on

| Feature | Source |
| --- | --- |
| Tabs, mobile mode, element and screen actions | [tabs](tabs/index.ts), [page](page/index.ts), [media](media/index.ts) |
| Data tables, image collections, file import and export | [data](data/index.ts), [documents](documents/index.ts) |
| Skill editing, Git sources, and embedded guides | [skills](skills/index.ts) |
| Tasks, schedules, and artifacts | [sessions](sessions/index.ts) |
| Settings, languages, and model providers | [settings](settings/index.ts), [i18n](i18n/index.ts), [models](models/index.ts) |
| Console, network, MCP, and scripts | [diagnostics](diagnostics/index.ts), [mcp](mcp/index.ts), [script](script/index.ts) |
| Generic tables and declarative Skill cards | [ui](ui/index.ts) |

Read the interface and related tests before changing a package. Data and Skill edits must preserve
version conflict checks. After switching resources, discard responses belonging to the previous
view. The [architecture guide](../../docs/architecture.md) covers page modes, screenshot
coordinates, and Session permissions.

## Develop and test

```bash
npm run typecheck
npm run dev
npm test -- playwright extension-example.spec.mjs
```

The last command runs the example fixture. Adapt that test to cover your contribution, including
cancellation, failures, unknown results, removal and reinstallation, and offline export. See the
[test guide](../../tests/README.md) for other entry points.

When removing a contribution, remove its unused TypeScript files from the contribution graph. Follow
the development rules in [AGENTS.md](AGENTS.md).

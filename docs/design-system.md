# Design system

Build capability layouts with the shared tokens, `qz-*` controls, and `qz:` utilities. The Side
Panel and exported Session HTML use the same compiled skin. Begin with the [capability
guide](../src/capabilities/README.md) to register a page or renderer; this guide covers its public
styling contract.

## CSS ownership and cascade

[The default theme](../src/themes/default/index.css) declares the cascade: `theme → base → vendor →
components → utilities`. It imports [tokens](../src/themes/default/tokens.css), [base
styles](../src/themes/default/base.css), [controls](../src/themes/default/controls.css), and
[utilities](../src/themes/default/utilities.css). [sidepanel.css](../src/sidepanel/sidepanel.css)
combines the selected theme with feature styles. Feature and capability CSS stays with its owning
module; the build includes it in the complete skin.

Tokens own semantic colors, fonts, density, radii, and motion. Tailwind 4 maps them with `@theme
inline`; the build imports Tailwind utilities with the project theme. Base styles use a 13px root
font and 4px spacing units. Capability styles join the build through their own `ui.css`.

Use template utilities for ordinary layout and spacing. Shared controls, generated Markdown, complex
states, and animation belong in scoped `components` rules. Utilities can override component
defaults; keep an overridable property's hover, responsive, and disabled behavior consistent with
that cascade. Third-party styles enter through a thin `vendor` layer wrapper; retain upstream files
and licenses.

## Controls and tokens

Use native button/input semantics and the shared control states.

| Purpose | Public classes |
| --- | --- |
| Buttons | `qz-btn` with `qz-btn--primary`, `qz-btn--secondary`, `qz-btn--ghost`, or `qz-btn--danger`; sizes `qz-btn--xs/sm/lg` |
| Icon buttons | `qz-icon-btn` with `qz-icon-btn--secondary` or `qz-icon-btn--danger`; sizes `qz-icon-btn--xs/sm/md` |
| Fields | `qz-field`, `qz-field-label`, `qz-field-hint`; combine `qz-field qz-select` for selects |
| Choice inputs | `qz-checkbox`, `qz-radio`, `qz-switch`, driven by native input state |
| Result choices | `qz-choice-card` family, built with `renderResultChoice` from SDK DOM; single-column cards with a native radio or checkbox |
| Popovers and menus | `qz-popover`, `qz-menu`, `qz-menu-item` |
| Lists and decisions | `qz-list-toolbar` and `qz-decision-dialog` families; use the SDK dialog interaction |
| Scrolling | `qz-scroll`; add `qz-scroll--native` for native scrollbars |

Control overrides use the declared `--qz-control-*`, `--qz-field-*`, and `--qz-popover-*` variables.
Preserve accessible names, keyboard focus, and disabled semantics. DOM helpers and renderer
contracts are available through [SDK DOM](../src/sdk/sidepanel/dom.ts) and
[renderers](../src/sdk/sidepanel/renderers.ts).

Use `renderResultChoice(document, options)` for selectable tool results. Supply a unique `id`, the
form field `name`, a stable result `value`, and its `label`; `multiple` selects checkbox or radio
semantics. Optional `description`, short `meta` labels, an HTTP(S) `imageUrl`, and an HTTP(S) `url`
add detail. The source link sits outside the selection label so opening a source preserves the
selection. Pass `checked` and `disabled` from the owning form. The helper owns no listeners or
state; its native input events bubble to the form, which handles validation and submission.

Result cards use the theme's field, choice, and focus tokens. Keep them in one column in narrow
panels, with metadata wrapping below the title and a small optional thumbnail. Group related cards
with an accessible field label; use the existing form controls for the selection count and action.
Title, description, metadata, and source text share the 18px `--choice-card-line-height`. Separate
text blocks by 2px, cards by 8px, and use the small field padding token (8px) for card insets.

| Utility examples | Semantic source |
| --- | --- |
| `qz:bg-surface`, `qz:bg-surface-muted`, `qz:bg-surface-elevated` | `--bg-primary`, `--bg-tertiary`, `--bg-elevated` |
| `qz:text-foreground`, `qz:text-secondary`, `qz:text-muted` | `--text-primary`, `--text-secondary`, `--text-muted` |
| `qz:text-danger`, `qz:text-success`, `qz:text-warning` | `--red`, `--green`, `--orange` |
| `qz:border-border`, `qz:border-focus` | `--border`, `--border-focus` |
| `qz:font-ui`, `qz:font-code`, `qz:text-body` | `--font-sans`, `--font-mono`, `--field-font-md` |
| `qz:rounded-control`, `qz:rounded-panel`, `qz:shadow-popover` | `--control-radius`, `--radius-lg`, `--shadow-lg` |

## Template example

The `qz:` utility prefix precedes variants, as in `qz:hover:bg-surface-muted`. It is distinct from
the `qz-*` component classes. Keep semantic classes and IDs used by interaction, tests, and skins.

```html
<section class="example-panel qz:flex qz:flex-col qz:gap-2 qz:p-4 qz:bg-surface qz:rounded-panel">
  <label class="qz-field-label" for="example-name">Name</label>
  <input id="example-name" class="qz-field" dir="auto">
  <button type="button" class="qz-btn qz-btn--primary">Save</button>
</section>
```

Use localized labels in production templates. The build discovers complete class strings in HTML and
TypeScript. Enumerate dynamic states explicitly:

```ts
const tones = { ready: "qz:text-success", failed: "qz:text-danger" };
element.classList.remove(...Object.values(tones));
element.classList.add(tones[state]);
```

Use complete class names as above. For dynamic numeric values, use CSS variables in scoped rules.
Cloned templates and later `className` assignments must retain the same layout classes as the
initial template.

## Select a theme

Themes live under [src/themes/](../src/themes/README.md). To select another theme at build time,
create a sibling directory with an `index.css` and change the first import in
[sidepanel.css](../src/sidepanel/sidepanel.css):

```css
@import "../themes/custom/index.css";
```

For a variation of the default theme, the new entry can import `../default/index.css` and override
semantic tokens in `@layer theme`. An independent theme implements the same public contract. Set
`data-qingzhou-skin` on the stylesheet link in [sidepanel.html](../src/sidepanel/sidepanel.html) to
the theme's name when recording that name in HTML exports.

Keep the remaining feature imports. Each theme preserves the public semantic tokens, `qz-*`
controls, `qz:` utilities, layer order, and DOM contract described here. Rebuild using the
[development commands](commands.md); the output remains `sidepanel/sidepanel.css` and includes the
selected theme, feature styles, and enabled capability styles.

## Color schemes, direction, and export

Semantic tokens respond to `prefers-color-scheme`; the same utility class works in light and dark
mode. Use logical margins, padding, alignment, and popover anchors so the root `dir` can control
layout. Code, shortcuts, URLs, and technical inputs remain LTR; free text inputs can use
`dir="auto"`. Preserve image orientation and stored data. See [localization](localization.md) for
language behavior.

[Skin runtime](../src/sidepanel/ui/skin-runtime.ts) reads the active skin link and supplies its
complete compiled CSS to exports. Static renderers produce readable standalone content. Selectors
cover both live containers and static output, including containers styled with `display: contents`.
The panel stores its reading-size preference locally; exports use the skin's text size.

Verify relevant fixtures in both color schemes, narrow panels, RTL, keyboard/focus/disabled states,
reduced motion, and exported HTML. Use the [test guide](../tests/README.md) to select browser and
visual checks; contribution requirements, including pixel comparisons for visual migrations, live in
[AGENTS.md](../AGENTS.md).

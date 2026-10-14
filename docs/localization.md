# Translate qz

Keep source messages with the feature that owns them, and language packs in a capability.
Translations run locally through contributed language descriptors. The public contracts are in the
[catalog SDK](../src/sdk/shared/i18n-definition.ts) and [translation
SDK](../src/sdk/shared/i18n.ts).

## Add or change interface copy

Define a stable namespace and key with English and Simplified Chinese source text. Translate whole
sentences and preserve named parameters. For example, a feature's `messages.ts` can contain:

```ts
import { defineMessages } from "#sdk/shared/i18n-definition";

export default defineMessages("example", {
  saved: { en: "Saved {name}", "zh-CN": "已保存 {name}" },
});
```

Export that catalog as `translations` from the capability's `index.ts`. Create its translator where
the feature needs text:

```ts
import { createTranslator } from "#sdk/shared/i18n";
import messages from "./messages.js";

const t = createTranslator(messages);
label.textContent = t("saved", { name: displayName });
```

Translations are plain text. Use `textContent` or the existing HTML/attribute escaper for markup.
Preserve user data, model output, page content, imported Skill documents, model IDs, commands, enum
values, storage keys, and stored diagnostics verbatim.

Add other translations under [language catalogs](../src/capabilities/i18n/locales/), in
`<language>/<namespace>.json`. For the example above, `ja/example.json` would contain:

```json
{ "example.saved": "{name}を保存しました" }
```

Write short, idiomatic actions and sentence-case labels. English uses **chat** for a conversation,
**task** for work the agent executes, and **session** for technical runtime or authentication
contexts. Errors should explain what happened and what the user can do next. Review loading, empty,
error and success states in their actual controls; a grammatically correct label may still be
unclear or clipped.

## Add a language

Add its native name, Chrome locale, optional matching aliases, reading direction and catalog path to
[locales.ts](../src/capabilities/i18n/locales.ts). A separate capability may contribute its own
`locales` instead. Keep catalog paths inside that package. The build rejects duplicate declarations,
unknown message keys and mismatched parameters, then compiles native Chrome `_locales` resources.
Only the selected catalog is loaded at startup; missing translations retain authored fallbacks.

Use the existing regional aliases, especially for Chinese scripts. Unsupported languages fall back
to English. The language selector is generated from installed descriptors and offers **Follow
browser** alongside each native language name.

Model-facing instructions and detailed tool schemas retain maintained English and Simplified Chinese
versions; other languages fall back to English. Keep identifiers and execution behavior stable.
External Skill and MCP descriptions remain unchanged, and the model still follows the user's
requested response language.

Built-in approval cards resolve their titles and disclosures from the stored approval type in the
panel's current language. Apply this to pending and resolved history entries. Keep model-authored
questions and form labels verbatim; translation belongs to the display projection and preserves
the stored transcript.

## Preserve language and history behavior

Resolve long-lived display metadata through getters, as in the [provider
presets](../src/capabilities/models/presets.ts). The Background captures localized descriptions for
each new run; existing runs retain their language snapshot. Keep `withLanguage` within synchronous
calls; it restores the previous scope on return.

Declare canonical tool titles in `defineMessages`' `historicalLabels` option. The compiled alias
index recognizes translated titles from saved conversations and displays known titles in the current
language. Custom titles and stored snapshots remain unchanged. Use separate `Short` message keys for
compact cards and timeline labels while preserving the canonical history mapping.

Read and save preferences through the SDK. The [language settings
form](../src/capabilities/i18n/ui.ts) reloads the panel only after every participating form in the
shared settings tab has saved its current revision. Failed or cancelled saves must leave the draft
recoverable. Background tasks keep running; the reopened panel initializes with the saved language.
Chrome's extension-management labels independently follow Chrome's language, using base [manifest
messages](../src/_locales/) and contributed manifest translations.

Use `轻舟`, `輕舟` and `軽舟` for Simplified Chinese, Traditional Chinese and Japanese; other languages
use lowercase `qz`. Keep code symbols and user content unchanged. Ordinary empty chats show the
localized `core.tagline`; initial task suggestions hide it. Keep the tagline natural in each
language and preserve the suggestion's editable-draft behavior.

## Check text, layout and exports

Run the relevant catalog checks and inspect the rendered interface:

```bash
npm run build
npm test -- unit --match i18n
npm test -- unit --match language
npm test -- unit --match locales
npm test -- playwright i18n-language-settings.spec.mjs language-packs-i18n.spec.mjs tool-history-i18n.spec.mjs
```

Check both color schemes at a 320px panel width, including selected options, long labels, focus and
keyboard operation. Arabic uses RTL layout while code, URLs and technical tokens keep LTR order.
Preserve image orientation. Follow the shared [design system](design-system.md) for controls that
must accommodate longer copy. Open an exported chat offline and check its language, direction and
historical titles; exports must preserve user text and include their own display labels. The
[language workspace](../tests/browser/language-pack-workspaces.spec.mjs) and [offline
export](../tests/browser/session-export-runtime.spec.mjs) tests cover these broader surfaces.

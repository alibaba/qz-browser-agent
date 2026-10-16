# Let users select Skill results

Use a `selection` renderer when the next step depends on which candidates the user chooses. The
Skill returns ordinary JSON; qz displays result cards and waits for confirmation. Start with the
[runnable example](../tests/fixtures/skills/result-selection/README.md).

Declare the renderer on the tool in `plugin.json`:

```json
{
  "type": "selection",
  "title": "Choose opportunities",
  "subtitle": "Select the roles you want to explore.",
  "itemsPath": "items",
  "itemIdPath": "id",
  "itemTitlePath": "company",
  "itemSubtitlePath": "role",
  "itemMeta": [{ "label": "Location", "path": "location" }],
  "selectionMode": "multiple",
  "submitLabel": "Research selected roles"
}
```

The script returns:

```json
{
  "items": [
    { "id": "role-1", "company": "Example", "role": "Backend engineer", "location": "Remote" }
  ]
}
```

After confirmation, the tool returns `selectedIds`, `selectedItems` (the original selected objects),
and `totalItems`. The Agent can continue using those IDs and fields. qz keeps the candidate cards
in the wait transcript and sends only selected records in the completed tool result. Each tool
invocation creates a new selection; completed results are read-only in the transcript and exports.

| Property | Behavior |
| --- | --- |
| `itemsPath` | Candidate array, default `items`. |
| `itemIdPath` | Stable string ID, default `id`. IDs must be unique, nonempty and have no surrounding whitespace. |
| `itemTitlePath`, `itemSubtitlePath` | Card title and description, defaults `title` and `description`. |
| `itemMeta` | Up to six small `{label, path}` or `{label, value}` details. Values are plain text, numbers or booleans. |
| `itemImagePath`, `urlPath` | Optional HTTP(S) thumbnail and source link. |
| `selectionMode` | `multiple` (default) or `single`. |
| `required` | Defaults to `true`. Set `false` to allow confirming an empty selection. |
| `title`, `subtitle`, `submitLabel` | Authored copy displayed in the user's task. |
| `sourcePath`, `titlePath`, `subtitlePath` | Optional paths into the result; item paths resolve relative to `sourcePath`. |

Return up to 50 concise candidate objects. An empty array completes with empty selected arrays.
Invalid collections or answers return a stable error code. Use `selection` as the top-level result
renderer; composite layouts and argument-source renderers use the other display components.
Page, inner Worker, host and MCP tools share the same selection behavior. MCP tools can provide
`structuredContent` or JSON text containing the candidate array.

Collection runs under the tool's normal timeout. Once results are ready, the existing Session wait
mechanism owns confirmation, cancellation and stale-run checks; human waiting time is outside that
timeout. Scripts supply candidate data and finish before the user chooses. Cancellation stops the
pending tool call. Browser or extension restart closes the old run's wait; rerun the tool to choose
again.

The cards use the shared `qz-*` design-system control and stack vertically in narrow panels. The
same presentation is available to `ask_user` choice fields with `presentation: "cards"`.

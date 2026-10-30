// Mirrors the Chinese workflow, including executable examples and safety boundaries.
export default `# Skill workbench

Use this skill when the user wants to create, edit, delete, import, or publish a Skill, or add callable tools or result views to a Skill. System instructions, persistent knowledge, long-term preferences, writing rules, and delivery standards belong in a resident skill with \`scope: "resident"\`. An ordinary skill only needs procedural guidance in \`SKILL.md\`; add a root \`plugin.json\` and \`scripts/*.js\` only when exposing scripts as tools or customizing their result views.

## Workflow

1. Decide whether the Skill needs tools. Do not create \`plugin.json\` for guidance, preferences, or procedures alone. Add resources when the Skill needs model-callable tools or custom result views.
2. For system instructions, persistent knowledge, long-term preferences, domain rules, writing rules, or delivery standards, create or update a resident skill with \`scope: "resident"\`. Its content should contain durable rules suitable for full injection into the system context. Do not edit the Kernel Prompt.
3. Use a stable lowercase English ID for \`name\` (the standard Agent Skill name), and put the localized name in \`displayName\`. Supply content, scope, and any required domains/urlPatterns. resources may be empty.
4. When tools are needed, explain the procedure, prerequisite navigation, page-state checks, when to call each Skill tool, and recovery steps in the content. Declare tools and result views in the root \`plugin.json\`; put scripts in \`scripts/*.js\`.
5. Before designing a result view, call this skill's renderer-discovery tool, choose a renderer, and make the script's return value match its schema exactly.
6. To inspect the full installed Skill system, call this skill's listing tool with \`all/global/site/resident\`. Review the existing names before deciding to create a new skill or update one.
7. Use this skill's create tool for new skills, resource-editing tool for \`plugin.json\`, \`scripts/*.js\`, and \`references/*.md\`, update tool for existing content or metadata, and delete tool for removal. Edit one resource with one action per call.
8. Scripts should implement reusable, well-defined local operations suitable for tool calls, not entire workflows. The skill itself is the user-selectable entry point; do not add Skill slash commands.
9. qz refreshes the Skill registry after a write or update. Newly declared tools and result views should become available to the current conversation immediately.
10. Scripts default to \`runtime:"page"\` on the current task's page. Page tools automatically receive an optional \`tabRef\` parameter: pass a task-owned tab alias or positive integer ID (numeric strings also work), or omit it to use the current task's working tab. If declaring it in \`plugin.json\`, use \`tabRef\` with \`type:["integer","string"]\`. Unknown aliases fail rather than falling back to the working tab. For page-independent scripts using their own settings or network APIs, use \`runtime:"inner"\`: read manifest settings through \`$plugin.config\` and use standard \`fetch\` only for origins declared in \`network.allowedOrigins\`. Do not assign \`runtime:"host"\` to user-created Skills; it is reserved for controlled Background actions explicitly registered by qz core.
11. Skill script tools automatically receive a required \`timeout\` argument; do not add it to the business schema. Values are in seconds: \`timeout <= 0\` waits indefinitely; \`timeout > 0\` sets the maximum wait. Choose it deliberately for Skill tools, \`run_script\`, and \`run_skill_script\` according to task complexity.
12. Tool availability follows the skill's \`scope\`, not an extra manifest setting. \`resident\` is always available; \`site\` is available when the page matches domains/urlPatterns or after the current conversation calls \`load_skill\`; \`global\` is available only after \`load_skill\` in the current conversation. \`builtin\`, \`readOnly\`, and \`source\` describe origin and permissions, not loading policy.
13. For external MCP, first \`load_skill("qingzhou-mcp")\` and follow its registry search, unregistered-URL inspection, and minimal test-call workflow. Persist selected server/tool bindings only when ongoing reuse is confirmed. Call registered MCP tools by their Skill tool names.
14. Discover a Skill ZIP URL with the existing page or Network tools. Make its source page the current task's working tab, then pass the URL to the page-ZIP import tool. That tool does not scan or guess download links. It downloads in the page's authenticated context; Background handles extraction, validation, and Skill storage. Do not assemble base64 or parse ZIP files in page scripts.
15. For supported GitHub or GitLab repository/directory URLs, use the Git inspection/import tool. It opens the repository, waits for sign-in if needed, discovers the branch and ZIP, and records an updatable source. Never pass \`overwrite:true\` for name or local-edit conflicts without user confirmation.
16. When the user explicitly asks to install a local Skill into a Git repository, use the Git installation tool. The current product's publishing adapter must support the target URL. The directory determines the installation path; the tool creates or updates \`<directory>/<skill-name>/SKILL.md\` and resources in one commit. If no adapter is available, export the Skill for the user to commit.
17. Skill packages may include DOCX, XLSX, or PDF references. \`load_skill_resource(name,path)\` uses the document pipeline to return the first preview chunk and docModelId. To read more, first \`load_skill("qingzhou-documents")\`, then call \`document_read_chunk\`. Binary resources cannot be edited with text replace/append/set operations.

## Page-mode prerequisites

- When creating or updating a Skill from a webpage, confirm the target page's mode using the current task's page context or the \`pageMode\` returned by \`list_tabs\`. Do not infer it from the window width or URL. If the mode is missing or changing, observe the page again to confirm it first.
- If the workflow was captured or tested with \`pageMode:"mobile"\`, the generated \`SKILL.md\` / content must state “Tested in mobile mode” in its prerequisites and explain how to reproduce that setup: open a new page with \`open_tab\` and \`mode:"mobile"\`, or switch an existing task-owned page with \`set_page_mode\` and \`mode:"mobile"\`. Switching modes reloads the page; read the page or take a new screenshot before interacting, without reusing old element references or coordinates.
- Record only the modes actually tested. Mobile-only testing does not establish desktop compatibility; document separate workflows if the modes differ. Keep mode requirements in the Skill body, without adding manifest fields or hard-coding the tabRef used during authoring.

## Content and scripts

- \`SKILL.md\` / skill content explains how to complete the task. For a video-search skill, for example, describe opening the site, searching, filtering, visiting details, recognizing success, and handling verification or empty results.
- \`plugin.json\` is optional. It exposes scripts in the model's tool schema and renders results with qz components.
- \`scripts/*.js\` is optional. A script becomes a tool only when explicitly declared in \`plugin.json.tools[]\`. Use \`runtime:"page"\` for page actions and \`runtime:"inner"\` for computation, Skill settings, or external APIs. Keep scripts focused on local operations.
- If a tool needs multiple prerequisite steps, its description or skill content must say to read the workflow with \`load_skill\` first and then run the script on the appropriate page.
- Use this skill's exposed Skill tools to create, update, and delete skills, so authoring logic, directory rules, and result views use the same entry point. Do not call bare core tools directly.

## Package imports and Git distribution

- Page-ZIP import accepts a complete http(s) download URL already discovered by the agent. It uses the current workingTabId's authenticated page context by default; it does not scan the DOM or Network or guess URLs. It can import one or more standard Skills. Existing names are not overwritten unless the user confirms and \`overwrite:true\` is supplied.
- Git inspection/import accepts supported GitHub or GitLab repository-root or directory-page URLs. It reuses the Skills page's Git source integration and preserves repository, branch, directory, and update summary. The source can later be checked for updates or unlinked in the Skills page.
- Git installation accepts a local Skill name and a supported publishing URL. It creates an external Git commit and therefore requires an explicit installation/commit request. Verify the returned targetPath, fileCount, and commitId.
- ZIP and Git imports operate on whole packages. Do not replace them with \`create_skill\` followed by repeated resource edits: content, resources, manifest, and source metadata must be validated and written together.

## MCP integration

qz supports remote HTTP MCP only, not local stdio. \`qingzhou-mcp\` handles discovery, inspection, and one-off calls. This skill persists configurations already confirmed for reuse:

1. Before editing, \`load_skill("qingzhou-mcp")\`. Use its inspection results, tools[].name/description/inputSchema, minimal test calls, and the user's goal to select bindings. Do not wrap every server tool by default.
2. Set a top-level category in \`plugin.json\` using a stable, user-facing business category such as Research, Data, Travel, or Development. Use \`{ "id": "mcp", "label": "MCP" }\` only for a general MCP gateway spanning multiple use cases.
3. Read the available renderer registry and choose a standard renderer such as table/list/fields/summary/article/image_grid/tree/markdown/text based on real test-call results. Map structuredContent or JSON text directly; use text/markdown for natural-language-only results. Do not invent fields.
4. Declare the server in plugin.json.mcpServers. For each selected tool, set \`runtime:"mcp"\`, \`mcp:{ server, tool }\`, and a renderer matching its result. Set the renderer on the tool or in top-level renderers.tools.
5. Before saving, qz verifies that enabled servers complete tools/list. Fix the URL/headers or explicitly set a temporarily unavailable server to \`enabled:false\`. Do not bypass validation.
6. Reload the saved skill with \`load_skill(name)\`. Follow the qingzhou-mcp registry workflow to verify pluginTool.name, make the real call through that Skill tool, and confirm the intended renderer is used instead of a generic text fallback.

\`\`\`json
{
  "format": "qingzhou.plugin",
  "schemaVersion": 1,
  "id": "docs-mcp",
  "displayName": "Documentation MCP",
  "description": "Query documentation through a remote MCP server",
  "category": { "id": "research", "label": "Research" },
  "mcpServers": {
    "docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  },
  "tools": [
    {
      "name": "resolve_library",
      "title": "Resolve library ID",
      "description": "Call the docs MCP resolve-library-id tool.",
      "runtime": "mcp",
      "mcp": { "server": "docs", "tool": "resolve-library-id" },
      "parameters": {
        "type": "object",
        "properties": {
          "libraryName": { "type": "string", "description": "Library or framework name" }
        },
        "required": ["libraryName"]
      },
      "renderer": {
        "type": "text",
        "title": "Result",
        "valuePath": "text"
      }
    }
  ]
}
\`\`\`

## Minimal manifest

\`\`\`json
{
  "format": "qingzhou.plugin",
  "schemaVersion": 1,
  "id": "page-inspector",
  "displayName": "Page inspector",
  "version": "0.1.0",
  "description": "Extract the page title, links, and a text summary",
  "category": { "id": "research", "label": "Research" },
  "tools": [
    {
      "name": "inspect_page",
      "title": "Inspect page",
      "description": "Read the visible page structure and return a summary",
      "script": "scripts/inspect-page.js",
      "needsPage": true,
      "parameters": {
        "type": "object",
        "properties": {
          "tabRef": { "type": ["integer", "string"], "description": "Task-owned tab alias or positive integer ID; defaults to the working tab" },
          "limit": { "type": "integer", "description": "Maximum number of links to return" }
        }
      }
    }
  ],
  "renderers": {
    "tools": {
      "inspect_page": {
        "type": "summary",
        "titlePath": "title",
        "subtitlePath": "url",
        "fields": [
          { "label": "Links", "path": "linkCount" },
          { "label": "Text", "path": "textLength" }
        ]
      }
    }
  }
}
\`\`\`

## Settings DSL and inner-runtime networking

For endpoints, tokens, or other user configuration, declare top-level settings.fields. Do not add a business-specific settings page or host action. Controls, grouping, and widths use the generic DSL below; custom style, theme, and arbitrary component names are unsupported:

- settings.fields[].type supports only text, secret, url, boolean, number, and select. Use boolean for switches.
- Every field can declare key, type, label, description, placeholder, required, default, and width. key must start with an English letter and contain only letters, digits, underscores, and hyphens. width is full by default or half for two-column layouts; narrow screens return to full width.
- text can declare a regex string in pattern. url accepts HTTP(S) URLs without embedded credentials. secret can declare reenterWhen, listing fields whose changes require the secret to be reentered; it must not declare a nonempty default.
- number can declare min, max, and step. select requires nonempty options, each \`{ "label": "Display text", "value": "stable-string-value" }\`. boolean values and defaults must be actual JSON booleans, not the strings "true" or "false".
- Group many fields with settings.layout.sections. Each section supports title, optional description, and a fields array of keys. A field may belong to at most one section; ungrouped fields still appear. layout affects only the generic settings view, not storage or script configuration.

Scripts read settings through \`$plugin.config.<key>\`. Secret values are populated in local password controls but never injected into the page runtime; tools that need secrets must use \`runtime:"inner"\`. A dynamic network origin references a \`type:"url"\` setting. Use ordinary fetch.

\`\`\`json
{
  "settings": {
    "title": "Example API",
    "description": "Connection details and query preferences",
    "fields": [
      { "key": "endpoint", "type": "url", "label": "Endpoint", "required": true },
      { "key": "token", "type": "secret", "label": "Token", "required": true, "reenterWhen": ["endpoint"] },
      { "key": "project", "type": "text", "label": "Project", "pattern": "^[A-Za-z][A-Za-z0-9_\\\\-]*$", "width": "half" },
      { "key": "limit", "type": "number", "label": "Result limit", "min": 1, "max": 1000, "step": 1, "default": 100, "width": "half" },
      { "key": "mode", "type": "select", "label": "Mode", "options": [{ "label": "Standard", "value": "standard" }, { "label": "Fast", "value": "fast" }], "default": "standard", "width": "half" },
      { "key": "cache", "type": "boolean", "label": "Enable cache", "default": true, "width": "half" }
    ],
    "layout": {
      "sections": [
        { "title": "Connection", "description": "Service URL and credentials", "fields": ["endpoint", "token", "project"] },
        { "title": "Query", "fields": ["limit", "mode", "cache"] }
      ]
    }
  },
  "network": {
    "allowedOrigins": [{ "setting": "endpoint" }],
    "allowedMethods": ["GET", "POST"]
  },
  "tools": [{
    "name": "query_api",
    "title": "Query API",
    "runtime": "inner",
    "script": "scripts/query-api.js",
    "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
  }]
}
\`\`\`

## Script conventions

Skill scripts use the same source form as run_script.code: normally one \`async () => { ... }\` function expression, which qz invokes. Do not use top-level return, an IIFE, main(), or a result wrapper. \`runtime:"page"\` runs on the current task's working tab or a task-owned page selected with \`tabRef\`. \`runtime:"inner"\` runs in a Worker without a DOM or tab requirement, with standard Web APIs, \`$plugin.config\`, fetch, and tools/tool.

\`\`\`js
async () => {
  const limit = Number(args.limit || 10);
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, limit)
    .map(a => ({ text: a.innerText.trim(), href: a.href }));

  return {
    title: document.title,
    url: location.href,
    linkCount: links.length,
    textLength: document.body?.innerText?.length || 0,
    links
  };
}
\`\`\`

Both runtimes provide args/input, $plugin, tools/tool, and Web APIs. page additionally provides window/document and the host-resolved numeric tabId. This runtime value is not an author-declared targeting parameter; use tabRef when calling page tools. inner has no DOM; network origins and methods must be declared in the manifest's network settings. Do not use Node.js, fs/path/process/require, npm packages, local shell commands, or the server filesystem.

### Page state and safe return values

Tool return values and diagnostic traces must be small plain JSON containing only strings, numbers, booleans, null, arrays, and plain objects. Never return or trace DOM nodes, Window, Document, Event, Response, Request, Headers, Promise, Function, raw Map/Set objects, Proxy, Vue/React internals, raw page-state references, or objects with cycles or deep prototype chains.

You may read SSR/hydration state such as window.__INITIAL_STATE__, __NEXT_DATA__, or __NUXT__, but only project needed business fields. Immediately use slice, map, and String/Number/Boolean to produce small plain objects. Do not return state, window.__INITIAL_STATE__, or state.search.feeds._rawValue; do not trace("state", stateObj) or JSON.stringify(window.__INITIAL_STATE__).

For large state objects, prefer DOM-first or Network-first extraction. Use state-first only when the visible DOM/API is insufficient, and then read only primitives, small arrays, and required business fields. Keep large intermediate objects out of return values, renderer payloads, traces, errors, and caches.

trace() should record only URLs, counts, field names, error codes, and a few samples. Treat "Object reference chain is too long", "Converting circular structure to JSON", "DataCloneError", "Maximum call stack size exceeded", and similar CDP serialization errors as STATE_SERIALIZATION / SERIALIZATION. Switch to DOM-first, Network-first, or projected state fields, then retest the actual Skill tool.

For tools with a UI renderer, return the renderer's expected structure directly, without a result wrapper:

- summary/compact/metrics/fields: an object matching titlePath, subtitlePath, and fields[].path.
- table: \`{ rows: [...] }\` by default; row fields must match columns[].path. If itemsPath/valuePath is configured, it must resolve to an array. For pagination/truncation, totalPath points to the full row count and truncatedPath to the truncation flag.
- list: \`{ items: [...] }\` by default, with fields matching itemTitlePath/itemSubtitlePath/itemMeta[].path.
- markdown: \`{ markdown: "..." }\` by default; a configured valuePath must resolve to a Markdown string.
- json: serializable JSON; a configured valuePath must exist.

For complex views, use a linear layout.blocks list of renderers. A block's source defaults to the script result; \`source:"args"\` displays input directly without copying it into the return value. sourcePath selects the block's data within that source; valuePath/itemsPath then resolves relative to that data:

\`\`\`json
{
  "layout": {
    "type": "stack",
    "blocks": [
      { "type": "code", "title": "SQL", "source": "args", "valuePath": "sql", "language": "sql" },
      { "type": "summary", "sourcePath": "summary", "fields": [{ "label": "Count", "path": "count" }] },
      { "type": "table", "sourcePath": "data", "itemsPath": "rows", "totalPath": "totalRows", "truncatedPath": "truncated", "columns": [{ "label": "Title", "path": "title" }] },
      { "type": "markdown", "sourcePath": "notes" }
    ]
  }
}
\`\`\`

Return \`{ summary: {...}, data: { rows:[...], totalRows: 10, truncated: false }, notes: { markdown:"..." } }\`. SQL already comes from args.sql, so do not copy it into the result.

## Update protocol

- To edit Skill Markdown, use the update tool's top-level oldText/newText, prependContent, or appendContent. Make one clear kind of change per call. These fields modify content only, not resources.
- To add, replace, or edit plugin.json, scripts/*.js, or references/*.md, use the resource-editing tool. name, path, action, type, title, description, content, oldText, and newText are top-level arguments. One resource and one action per call.
- Replace a large script/JSON file with \`action:"set"\`. Specify path/type/title/description first and the long content last.
- For a small edit, use \`action:"replace"\` and top-level oldText/newText. Copy the smallest unique contiguous oldText verbatim from the resource just read; do not recreate it from memory. Use append/prepend for additions, rename to rename, and delete to remove.
- Before editing an existing resource, inspect the resource list with load_skill, then read the file with load_skill_resource(name,path). Do not pack multiple resources or edits into arrays or nested objects.
- Imports preserve original DOCX/XLSX/PDF bytes and route reading through the document pipeline. The resource editor handles text only; do not convert binary files into base64 text arguments.

## UI and rendering

- name is a stable lowercase English ID containing only letters, digits, and hyphens. displayName is the localized name. For Chinese skills, supply displayName explicitly rather than putting the Chinese name only in the content heading.
- Supply a category for Skill organization and automatic tool grouping in the conversation. Use a business category users recognize instead of relying on the default.
- The renderer-discovery tool defines the available renderers.tools types. Read the registry before creating a Skill with a UI; choose a renderer and design the return value to match its schema.
- Configured renderers use qz's standard views and grouping. Tools without renderers use generic script-result presentation.
- Compose existing components with layout.blocks for complex views; do not invent a one-off visual structure.
- For user configuration, declare generic settings.fields and qz adds a card under Settings → Skills.
- settings.fields declares field structure and optional initial defaults, not the user's current values. For actual configuration reads/writes, load qingzhou-management, use qingzhou_management__manage_skill_settings list/get/update, and verify with get. Do not put secret defaults in manifests.

## Quality requirements

- Keep Skill IDs and tool names short, stable, lowercase, and English. Put localized text in displayName/title/label.
- Match returned JSON to the renderer schema. Specify the script's return shape for any UI renderer; avoid result wrappers, raw JSON strings, or unstructured text.
- Audit serialization before writing, reviewing, or fixing scripts/*.js. Project small page-state fields; exclude DOM/Window/Response/Proxy/framework internals/raw state/large response bodies from results and traces.
- Put site domains/urlPatterns at the skill's top level. Do not add manifest exposure modes or manual/resident exposure settings.
- Do not overwrite existing user skills. Read them with load_skill or load_skill_resource before editing.
- Deliver Skills the user can continue editing and export directly.`;

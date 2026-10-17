# qz-browser-agent (轻舟)

English · [简体中文](README.zh-CN.md)

> 两岸猿声啼不住，轻舟已过万重山。  
> — Li Bai, *Leaving Baidi City in the Morning*

**qz** (轻舟, *qingzhou*, “light boat”) is a local-first Chrome extension for web research, browser
automation, and structured data extraction. Bring your own model, and extend it with Skills and
TypeScript capabilities.

![qz collecting Hangzhou photos from Wikipedia](docs/images/workspace.png)

https://github.com/user-attachments/assets/26ee85fd-540f-4427-af59-c196fadfa221

## Features

- **Browser automation.** Interact through DOM elements or screenshots, fill forms, and work across tabs in desktop or mobile viewports.
- **Parallel subtasks.** Run tasks and delegate subtasks concurrently. Interrupt, redirect, or add context while a task is running.
- **Structured data.** Extract tables, media, and page content into local collections. Preview, edit, and export them from the side panel.
- **Skills.** Run JavaScript in target web pages. Package instructions, scripts, tools, and custom UI as reusable Skills, with optional site-based activation.
- **Model choice.** Use any provider with a supported API protocol and tool calling, including local model servers.
- **TypeScript capabilities.** Add agent tools, panel views, settings pages, or model providers.
- **CLI and MCP.** Delegate browser tasks from your terminal, coding agent, or MCP client. Manage tasks, data, images, and settings through the same browser connection.

## Privacy and data flow

Sessions, Skills, and collected data are stored in your browser. Model requests include your input
and task context, including page or file content, screenshots, tab information, and results from
authorized bookmark or history tools. When a task needs local information, the
`get_location` tool can send coordinates, accuracy, and the location timestamp to the model. It asks for consent on first use.
Skills and MCP connections may also exchange data with services you configure.
See the [privacy policy and browser permissions](docs/permissions.md).

## Quick start

### Install

Open [qz in the Chrome Web Store](https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm)
and click **Add to Chrome**.

#### Manual installation

To install from a ZIP:

1. Download the ZIP from the [latest release](https://github.com/alibaba/qz-browser-agent/releases/latest).
2. Extract the ZIP.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `qz-browser-agent-extension` folder.

### Build from source

To build locally, install Node.js 24 LTS and npm, then run from a local checkout:

```bash
npm ci
npm run build
```

Follow the [manual installation steps](#manual-installation), selecting `dist/extension/` as the extension folder.

### Run

1. Open the qz side panel from the extension toolbar.
2. In **Settings**, choose a provider and enter its credentials. A custom endpoint also requires a URL and protocol.
3. Select a model and save.
4. Try a prompt: `Open example.com and extract its main heading into a table.`

## CLI and coding agents

**Agent-friendly.** Let your agent delegate browser tasks to qz via CLI, Skill, or MCP.

Use Node.js 24 or later on the same machine as Chrome. Install the extension from the
[Chrome Web Store](https://chromewebstore.google.com/detail/dknbdgkgoinlgjpfebapkklbmjjgdblm) and configure its
model in qz Settings, then install the CLI:

```bash
npm install --global qz-browser-agent
qz connect
qz create "Compare SQLite, DuckDB, and PostgreSQL for local analytics. Save trade-offs and source links in a table." --stream
```

`connect` opens the local connection page in the system’s default browser for first pairing.
Open it in the Chrome profile where qz is installed and complete its first-use data notice. The first browser is named `default`; repeating
`connect` reuses the connection. `--stream` displays progress, pending questions, and the result.
You can replace `qz` with `npx --yes qz-browser-agent@latest` to run without a global install.

To pair a specific Profile from the shell, get its connection URL:

```bash
qz connect --no-open --name work --json
```

Open `result.url` in the intended Profile, then check `qz browsers`. Omit `--name` to keep its
existing identifier or assign one automatically. See the [browser launch commands](services/mcp-bridge/README.md#pair-a-selected-browser-from-the-shell).
You can also connect in that Profile's **qz Settings → Advanced → CLI**.
When several browsers are online, select one by name or UUID:

```bash
qz browsers
qz create "Summarize the current page." --client work --stream
```

Disconnect one browser in its qz Settings. `qz stop` stops the local service and disconnects all
browsers. See [connection and upgrade instructions](services/mcp-bridge/README.md#connect-and-stop).

### Install the agent Skill

Install the [qz-browser-agent Skill](skills/qz-browser-agent/SKILL.md) to let your coding agent
check the connection, delegate a task, handle user input, and retrieve results:

```bash
npx --yes skills add alibaba/qz-browser-agent --skill qz-browser-agent --agent codex --global
```

Use `--agent claude-code` or `--agent pi` to install for Claude Code or Pi. `--skill` selects the
Skill; `--agent` selects the coding agent. See the [supported agents](https://github.com/vercel-labs/skills#supported-agents).

Then ask your agent: **Use qz to compare these three product pages and save a table with prices and source links.**

For MCP clients, run `qz mcp` after connecting and use the returned
HTTP URL. See the [CLI and MCP guide](services/mcp-bridge/README.md) for task follow-ups, pending
input, exports, and configuration.

## Extending qz

### Skills

Skills package repeatable workflows: automation scripts, interactive widgets in the side panel, and
optional activation on matching websites (Site Skills). Manage them in the UI or install them from
Git repositories.

### TypeScript capabilities

Capabilities are TypeScript modules compiled into the extension. Copy the
[example](tests/fixtures/capabilities/example/README.md) to `src/capabilities/<your-feature>/`,
rename its registrations, and keep the contributions you need:

```ts
// src/capabilities/<your-feature>/index.ts
export { default as tools } from "./tools.js";         // Agent tools
export { default as renderers } from "./renderers.js"; // Tool result views
```

The build discovers these declarations automatically.
Tool handlers run in the background service worker and can delegate actions or script execution to active tabs.
Renderers mount interactive result cards in the side panel.

See the [capability guide](src/capabilities/README.md) for SDK details. These APIs are experimental;
see [extension contracts](CONTRIBUTING.md#extension-contracts).

## Development

Set up the [test environment](docs/commands.md#run-tests) before running tests.

```bash
npm run dev       # Rebuild on source changes
npm test          # Run the default test suites
npm run verify    # Type-check and run all automated suites with coverage
```

After a rebuild, reload the extension at `chrome://extensions` and reopen the side panel.

- [Architecture](docs/architecture.md)
- [Commands and build options](docs/commands.md)
- [Benchmarks](docs/benchmarks.md)
- [Contributing](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE). Third-party dependencies retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

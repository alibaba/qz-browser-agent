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
- **MCP bridge.** Expose browser tools and task controls to external agents through the optional [local MCP bridge](services/mcp-bridge/README.md).

## Privacy and data flow

Sessions, Skills, and collected data are stored in your browser. Model requests include your input
and task context, including page or file content, screenshots, tab information, and results from
authorized bookmark or history tools. When a task needs local information, the
`get_location` tool can send coordinates, accuracy, and the location timestamp to the model. It asks for consent on first use.
Skills and MCP connections may also exchange data with services you configure.
See the [privacy policy and browser permissions](docs/permissions.md).

## Quick start

### Install

1. Download the [latest release](https://github.com/alibaba/qz-browser-agent/releases/latest).
2. Extract the ZIP.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `qz-browser-agent-extension` folder.

### Build from source

To build locally, install Node.js 24 LTS and npm, then run from a local checkout:

```bash
npm ci
npm run build
```

Follow the Chrome installation steps above, selecting `dist/extension/` as the extension folder.

### Run

1. Open the qz side panel from the extension toolbar.
2. In **Settings**, choose a provider and enter its credentials. A custom endpoint also requires a URL and protocol.
3. Select a model and save.
4. Try a prompt: `Open example.com and extract its main heading into a table.`

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

import { parseArgs } from "node:util";

const node = (...args) => ({ bin: process.execPath, args });
const agent = "tests/background/agent-behavior-e2e.mjs";
const deepseek = "tests/live/deepseek-extension.mjs";

// Specialized runners retain their own options and resource lifecycles. This
// table only selects an entrypoint; it never imports a live runner for discovery.
export function directEntrypoint(argv) {
  let [name, ...args] = argv;
  if (!["playwright", "report", "behavior", "grid", "live"].includes(name)) return null;
  if (name === "live" && args[0] && !args[0].startsWith("-")) name += ` ${args.shift()}`;
  const routes = {
    playwright: { command: ["node_modules/@playwright/test/cli.js", "test", "--config", "tests/config/playwright.config.mjs"], help: "Native Playwright options, including file filters, --grep, --workers, --headed and --list." },
    report: { command: ["node_modules/@playwright/test/cli.js", "show-report", "tests/results/playwright-report"], help: "Native show-report options: --host <host>, --port <port>." },
    behavior: { command: ["tests/behavior/run.mjs"], help: "Options: --journey <ids>, --actor <actors>, --coverage <ratings>, --layer <layers>, --include-explicit, --list, --fail-fast, --report <path>." },
    grid: { command: ["tests/data-grid/extension-page.mjs"], fixed: true, help: "Environment: DATA_GRID_EXTENSION_HEADLESS=1, CHROME_EXECUTABLE. No test arguments." },
    live: { commands: [node(deepseek), node(agent, "--suite", "realworld")], fixed: true, prepareBrowser: true, help: "Runs DeepSeek extension checks, then real-world Agent tasks. Choose agent, realworld, deepseek, rate or cli-mcp to run one target." },
    "live agent": { command: [agent], help: "Options: --suite base|journeys|journeys-vision|realworld|all, --cases <ids>, --provider <name>, --model <name>, --ak-file <path>, --concurrency <1..12>, --repetitions <1..10>, --bridge-timeout <30..600>, --report <path>, --capture-dir <path>, --vision, --window-target-probe." },
    "live realworld": { command: [agent, "--suite", "realworld"], help: "Agent options as in live agent, except --suite (fixed to realworld)." },
    "live deepseek": { command: [deepseek], fixed: true, help: "Environment: QINGZHOU_DEEPSEEK_MODEL, QINGZHOU_DEEPSEEK_AK_FILE, QINGZHOU_LIVE_HEADLESS=1, QINGZHOU_LIVE_CASES, QINGZHOU_LIVE_SESSION_MANAGEMENT=1, QINGZHOU_LIVE_SESSION_MANAGEMENT_EXTENDED=1. No test arguments." },
    "live rate": { command: ["tests/live/deepseek-rate-governor.mjs"], fixed: true, help: "Environment: QINGZHOU_DEEPSEEK_MODEL, QINGZHOU_DEEPSEEK_AK_FILE. No test arguments." },
    "live cli-mcp-supplement": { command: ["tests/live/deepseek-cli-mcp-supplement.mjs"], help: "Additional real CLI input and MCP resource coverage against an active isolated soak. Required: --report <live-soak-report.json>." },
    "live cli-mcp": { command: ["tests/live/deepseek-cli-mcp-soak.mjs"], help: "Real DeepSeek CLI/MCP soak. Options: --duration-seconds 1800, --task-timeout-seconds 360, --cases id,id. Requires DEEPSEEK_API_KEY; QINGZHOU_DEEPSEEK_MODEL selects the model." },
  };
  const route = routes[name];
  if (!route) throw new Error(`Unknown live target: ${name.slice(5)}. Available: agent, realworld, deepseek, rate, cli-mcp, cli-mcp-supplement`);
  if (name !== "behavior" && args.some(arg => arg === "--coverage" || arg.startsWith("--coverage="))) {
    throw new Error("--coverage is only available for unattended unit or --all suites");
  }
  if (args.includes("--all")) throw new Error("--all cannot be combined with a direct command");
  if (name === "live realworld" && args.some(arg => arg === "--suite" || arg.startsWith("--suite="))) {
    throw new Error("live realworld fixes --suite to realworld; use live agent to select another suite");
  }
  let help = args.includes("--help") || args.includes("-h");
  let list = false;
  if (route.fixed) {
    ({ values: { help = false, list = false } } = parseArgs({ args, options: {
      help: { type: "boolean", short: "h" }, list: { type: "boolean" },
    } }));
    args = [];
  } else if (name.startsWith("live ")) {
    list = args.includes("--list");
    args = args.filter(arg => arg !== "--list");
  }
  return { ...route, name, helpRequested: help, list, commands: route.commands || [node(...route.command, ...args)] };
}

export function printEntrypointHelp(route) {
  console.log(`Usage: npm test -- ${route.name} [arguments]\n\n${route.help}`);
  if (route.name.startsWith("live")) console.log("\nReal model calls are explicit. Keys: DEEPSEEK_API_KEY, KIMICODE_API_KEY, OPENCODEGO_API_KEY in the environment or root .env.local. Agent defaults also accept QINGZHOU_LLM_PROVIDER, QINGZHOU_LLM_MODEL and QINGZHOU_LLM_AK_FILE. --list prints the command without reading keys or calling models.");
}

export function coverageCommands(argv, full) {
  return [
    node("node_modules/c8/bin/c8.js", "--config", "tests/config/c8.json", process.execPath, "tests/run.mjs", ...argv.filter(arg => arg !== "--coverage")),
    node("tests/coverage/check-critical.mjs", ...(full ? ["--scope", "full"] : [])),
  ];
}

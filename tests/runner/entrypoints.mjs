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
    "live ax-viewport": { command: ["tests/live/ax-viewport.mjs"], fixed: true, help: "Paired baseline/viewport DeepSeek flash tasks using production AX and Content handlers in isolated Chromium. Requires sourced DEEPSEEK_API_KEY; QZ_AX_OUTPUT selects evidence directory. Minimal tool loop, not full extension Agent E2E." },
    "live ax-viewport-public": { command: ["tests/live/ax-viewport-public.mjs"], help: "Paired public-site DeepSeek AX comparison. Requires sourced DEEPSEEK_API_KEY. Options: --cases site-or-task-ids, --output directory, --concurrency 1..3, --trials 1..3, --pause-ms 0..60000, --repeat-all. Failed pairs and preflight-flaky sites receive three trials; all attempts are retained." },
    "live rate": { command: ["tests/live/deepseek-rate-governor.mjs"], fixed: true, help: "Environment: QINGZHOU_DEEPSEEK_MODEL, QINGZHOU_DEEPSEEK_AK_FILE. No test arguments." },
    "live cli-mcp-supplement": { command: ["tests/live/deepseek-cli-mcp-supplement.mjs"], help: "Additional real CLI input and MCP resource coverage against an active isolated soak. Required: --report <live-soak-report.json>." },
    "live cli-mcp": { command: ["tests/live/deepseek-cli-mcp-soak.mjs"], help: "Real DeepSeek CLI/MCP soak. Options: --duration-seconds 1800, --task-timeout-seconds 360, --cases id,id. Requires DEEPSEEK_API_KEY; QINGZHOU_DEEPSEEK_MODEL selects the model." },
    "live multi-browser": { command: ["tests/live/deepseek-multi-browser.mjs"], help: "Six real DeepSeek public-site tasks in three independent Chrome profiles, through CLI and MCP. Includes input, follow-up, reconnect and ownership checks. Options: --task-timeout-seconds 450, --cases id,id, --output <directory>. Builds one isolated production extension unless QINGZHOU_TEST_EXTENSION_DIR is supplied." },
    "live pi-multi-browser": { command: ["tests/live/pi-multi-browser.mjs"], help: "Pi delegates real DeepSeek browser tasks across independent Chrome profiles. Requires the Pi executable, QINGZHOU_TEST_EXTENSION_DIR pointing to a production build, and DEEPSEEK_API_KEY in the environment or ignored .env.local." },
    "live pi-concurrent-browsers": { command: ["tests/live/pi-concurrent-browsers.mjs"], fixed: true, help: "Three independent Pi processes pair three named Chrome Profiles, then two Pi processes share one Profile. Five real DeepSeek tasks each receive a follow-up. Requires Pi, a graphical session, QINGZHOU_TEST_EXTENSION_DIR pointing to a production build, and a DeepSeek key. No test arguments." },
  };
  const route = routes[name];
  if (!route) throw new Error(`Unknown live target: ${name.slice(5)}. Available: agent, realworld, deepseek, rate, ax-viewport, ax-viewport-public, cli-mcp, cli-mcp-supplement, multi-browser, pi-multi-browser, pi-concurrent-browsers`);
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

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_SUITES = ["unit", "contracts", "services", "browser"];
export const AUTOMATED_SUITES = ["unit", "contracts", "services", "browser", "e2e", "release", "visual"];
export const BROWSER_RESOURCE_SUITES = new Set(["browser", "e2e", "release", "visual"]);

const command = (bin, ...args) => ({ bin, args });
const commandWith = (options, bin, ...args) => ({ bin, args, ...options });
const parallelCommand = (bin, ...args) => ({ ...command(bin, ...args), resource: "general" });
const secondaryBrowserCommand = (bin, ...args) => ({ ...command(bin, ...args), resource: "browser-secondary" });
const testPythonParallel = (...args) => parallelCommand("node", "tests/support/run-python-browser.mjs", ...args);
const testPythonSecondary = (...args) => secondaryBrowserCommand("node", "tests/support/run-python-browser.mjs", ...args);

// The catalog owns discovery and command policy; scheduling only consumes its descriptors.
export function createSuiteCatalog({ root: ROOT, match, unitConcurrency }) {
  const pathFromRoot = (...parts) => relative(ROOT, join(ROOT, ...parts));
  const browserUnitConcurrency = Math.min(2, unitConcurrency);
  const serviceNodeTests = [
    "test-node-mcp-bridge.mjs", "test-node-mcp-cli.mjs", "test-node-mcp-pairing.mjs", "test-qz-cli-args.mjs",
    "test-qz-terminal.mjs", "test-qz-task-stream.mjs", "test-qz-cli-output.mjs", "test-qz-cli-resources.mjs",
    "test-qz-cli-version-compat.mjs", "test-qz-task-stream-recovery.mjs", "test-mcp-tool-arguments.mjs",
    "test-qz-client-scope.mjs", "test-mcp-task-observation.mjs", "test-qz-cli-launcher.mjs", "test-qz-cli-signals.mjs", "test-qz-daemon-liveness.mjs",
  ];
  const unitTestFiles = readdirSync(join(ROOT, "tests/unit"))
    .filter(name => /^test-.*\.mjs$/.test(name))
    .filter(name => !serviceNodeTests.includes(name))
    .map(name => pathFromRoot("tests/unit", name))
    .sort();

  const matchedUnitTestFiles = unitTestFiles.filter(path => matchesFilter(path, match));
  const browserHeavyUnitPaths = new Set([
    "tests/unit/test-article-extraction-benchmark.mjs",
    "tests/unit/test-article-extraction-capture-guards.mjs",
    "tests/unit/test-article-extraction-capture-hydration.mjs",
    "tests/unit/test-article-extraction-capture-overflow.mjs",
    "tests/unit/test-article-extraction-runner.mjs",
    "tests/unit/test-article-extraction-snapshot-html.mjs",
    "tests/unit/test-gold-markdown-generator.mjs",
    "tests/unit/test-design-system-comparison.mjs",
  ]);
  const browserHeavyUnitFiles = matchedUnitTestFiles.filter(path => browserHeavyUnitPaths.has(path));
  const pureUnitTestFiles = matchedUnitTestFiles.filter(path => !browserHeavyUnitPaths.has(path));

  const SUITES = {
    unit: [
      unitCommand(pureUnitTestFiles),
      unitCommand(browserHeavyUnitFiles, {
        after: ["playwright-browser"],
        testConcurrency: browserUnitConcurrency,
      }),
    ].filter(Boolean),
    contracts: [
      command("node", "tests/sidepanel-rendering/run.mjs"),
    ],
    services: [
      command("node", "--test", ...serviceNodeTests.map(name => pathFromRoot("tests/unit", name))),
      command(
        "uv",
        "run",
        "--project",
        "tests/python",
        "--default-index",
        "https://pypi.org/simple",
        "--locked",
        "pytest",
        "-q",
        "--durations=5",
        "tests/integration/test-agent-behavior-acceptance.py",
      ),
    ],
    browser: [
      commandWith(
        { id: "playwright-browser" },
        "node",
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "tests/config/playwright.config.mjs",
      ),
      testPythonParallel("tests/chat-search/smoke-check.py"),
      testPythonParallel("tests/chat-ordering/repro-check.py"),
      parallelCommand("node", "tests/data-grid/browser-matrix.mjs"),
    ],
    e2e: [
      commandWith({ id: "provider-header-rules-e2e", resource: "browser-secondary" }, "node", "tests/background/provider-header-rules-e2e.mjs"),
      commandWith({ id: "image-conversion-e2e" }, "node", "tests/background/image-conversion-e2e.mjs"),
      commandWith({ id: "extension-e2e", resource: "browser-secondary" }, "node", "tests/background/extension-e2e.mjs"),
      commandWith({ id: "mcp-tab-ownership-e2e", resource: "browser-secondary" }, "node", "tests/background/mcp-tab-ownership-e2e.mjs"),
      commandWith({ id: "mcp-resilience-e2e", resource: "browser-secondary" }, "node", "tests/background/mcp-resilience-e2e.mjs"),
      commandWith({ id: "mcp-user-input-e2e", resource: "browser-secondary" }, "node", "tests/background/mcp-user-input-e2e.mjs"),
      commandWith({ id: "mcp-resources-e2e", resource: "browser-secondary" }, "node", "tests/background/mcp-resources-e2e.mjs"),
      commandWith(
        {
          resource: "general",
          after: ["playwright-browser"],
          env: { DATA_GRID_EXTENSION_HEADLESS: "1" },
        },
        "node",
        "tests/data-grid/extension-page.mjs",
      ),
      commandWith(
        { id: "tool-presentation-streaming", exclusive: true },
        "node",
        "tests/benchmarks/conversation-render/run.mjs",
        "--mode",
        "tool-presentation-streaming",
        "--json",
        "--fail-on-health",
      ),
      commandWith(
        { id: "stream-interaction", exclusive: true },
        "node",
        "tests/benchmarks/conversation-render/run-stream-interaction.mjs",
      ),
      commandWith(
        { id: "consent-import-e2e", resource: "browser-secondary" },
        "node",
        "tests/session-exchange/consent-import-check.mjs",
      ),
      testPythonSecondary("tests/session-exchange/e2e-check.py"),
      testPythonSecondary("tests/qingzhou-documents/e2e-check.py"),
      testPythonSecondary("tests/tool-timeline/e2e-check.py"),
    ],
    release: [
      parallelCommand("node", "tests/release/npm-package.mjs"),
      parallelCommand("node", "--test", "--test-reporter=spec", "tests/release/build-extension.test.mjs", "tests/release/bundle-release.test.mjs"),
      commandWith(
        { id: "release-chrome-smoke", resource: "browser-secondary" },
        "node",
        "tests/release/chrome-smoke.mjs",
      ),
    ],
    visual: [
      commandWith(
        { resource: "browser-secondary", after: ["playwright-browser", "mcp-tab-ownership-e2e"] },
        "node",
        "tests/support/run-python-browser.mjs",
        "tests/tool-timeline/sticky-check.py",
      ),
      testPythonSecondary(
        "tests/tool-timeline/visual-check.py",
        "--screenshot",
        "/tmp/qingzhou-tool-timeline-visual-test.png",
      ),
      commandWith(
        { id: "conversation-visual-audit", exclusive: true, after: ["release-chrome-smoke", "mcp-tab-ownership-e2e"] },
        "node",
        "tests/benchmarks/conversation-render/run-visual-audit-matrix.mjs",
        "--profiles",
        "sidepanel-light",
        "--json",
      ),
    ],
  };

  return { suites: SUITES, matchedUnitTestFiles, browserHeavyUnitFiles, filteredCommands };

  function filteredCommands(suite) {
    const commands = SUITES[suite];
    if (!commands || suite === "unit" || !match) return commands;
    return commands.filter(item => matchesFilter(commandLabel(item), match));
  }

  function unitCommand(files, options = {}) {
    if (!files.length) return null;
    const { testConcurrency = unitConcurrency, ...commandOptions } = options;
    return commandWith(
      commandOptions,
      "node",
      "--test",
      `--test-concurrency=${testConcurrency}`,
      "--test-reporter=spec",
      "--require=./tests/support/unit-bootstrap.cjs",
      ...files,
    );
  }
}

function matchesFilter(value, match) {
  return !match || String(value || "").toLowerCase().includes(match);
}

export function commandLabel(item) {
  if (item.bin === "node" && item.args.includes("--test")) {
    const files = item.args.filter(arg => /^tests\/.+\.(?:c?js|mjs)$/.test(arg)).length;
    const concurrency = item.args.find(arg => arg.startsWith("--test-concurrency="))?.split("=")[1];
    return `node --test (${files} ${files === 1 ? "file" : "files"}${concurrency ? `, concurrency ${concurrency}` : ""})`;
  }
  return [item.bin, ...item.args].join(" ");
}

import { parseArgs } from "node:util";
import { AUTOMATED_SUITES, DEFAULT_SUITES, commandLabel } from "./suites.mjs";

export function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean" }, coverage: { type: "boolean" }, list: { type: "boolean" },
      help: { type: "boolean", short: "h" }, match: { type: "string" }, jobs: { type: "string" },
      suite: { type: "string", multiple: true },
    },
  });
  const suites = [...positionals, ...(values.suite || [])].flatMap(splitSuites);
  if (values.all && suites.length) throw new Error("--all cannot be combined with explicit suites");
  for (const key of ["match", "jobs"]) {
    if (values[key] !== undefined && (!values[key].trim() || values[key].startsWith("-"))) {
      throw new Error(`--${key} requires a value`);
    }
  }
  if (values.suite?.some(value => !value.trim() || value.startsWith("-"))) {
    throw new Error("--suite requires a suite name");
  }
  if (values.jobs !== undefined && !/^[1-4]$/.test(values.jobs)) throw new Error("--jobs must be an integer from 1 to 4");
  return {
    ...values,
    suites: [...new Set(values.all ? AUTOMATED_SUITES : suites.length ? suites : DEFAULT_SUITES)],
    match: (values.match || "").trim().toLowerCase(),
  };
}

export function validateSelection(cli, suites) {
  const unknown = cli.suites.filter(suite => !Object.hasOwn(suites, suite));
  if (unknown.length) throw new Error(`Unknown test suite: ${unknown.join(", ")}. Available: ${Object.keys(suites).join(", ")}`);
  if (cli.coverage && (cli.match || (!cli.all && !(cli.suites.length === 1 && cli.suites[0] === "unit")))) {
    throw new Error("--coverage requires unfiltered unit or --all; live and partial-suite coverage cannot satisfy the gates");
  }
}

export function printSelectedTests(selected, { matchedUnitTestFiles, filteredCommands }, cli) {
  let count = 0;
  for (const suite of selected) {
    console.log(`\n${suite}:`);
    const labels = suite === "unit" ? matchedUnitTestFiles : filteredCommands(suite).map(commandLabel);
    labels.forEach(label => { console.log(`  ${label}`); count += 1; });
  }
  if (!count) throw new Error(cli.match ? `No tests matched: ${cli.match}` : "No tests selected");
  if (cli.coverage) console.log(`\nCoverage: c8 + ${cli.all ? "full runtime" : "background"} critical gate`);
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function splitSuites(value) {
  const names = value.split(",").map(item => item.trim());
  if (names.some(name => !name)) throw new Error("Suite names cannot be empty");
  return names;
}

export function printHelp(defaultTestJobs) {
  console.log(`Usage:
  npm test                              # unit + contracts + services + browser
  npm test -- unit contracts            # one or more unattended suites
  npm test -- unit --match data-grid
  npm test -- --all --jobs 1
  npm test -- browser --list
  npm test -- unit --coverage           # unit coverage + background gate
  npm test -- --all --coverage          # full coverage + runtime gates
  npm test -- firefox                   # Firefox package only; not part of --all
  npm test -- playwright [arguments]    # Chromium Playwright options for dist/extension
  npm test -- report [arguments]        # open the Playwright HTML report
  npm test -- behavior [arguments]      # indexed product journeys
  npm test -- grid                      # standalone extension Data Grid test
  npm test -- live [target] [arguments]  # explicit real-model tests

Suites: ${AUTOMATED_SUITES.join(", ")}
Firefox package suite: firefox
  browser=firefox package=dist/extension-firefox
  npm run verify            typecheck plus unit, contracts, and services
  npm run verify:chrome     browser, e2e, release, and visual on dist/extension
  npm run verify:firefox    builds that package, then runs its unit tests and Playwright in Firefox
  npm run verify:coverage   typecheck plus --all with coverage gates
  npm test and --all stay on Chromium and the Chrome package. They do not select firefox.
Live targets: agent, realworld, deepseek, firefox-ui, rate, cli-mcp, cli-mcp-supplement, multi-browser, pi-multi-browser, pi-concurrent-browsers
  (no target: deepseek + realworld)

Options:
  --match <text>    filter unit paths or suite commands
  --jobs <1..4>     bound resource-aware concurrent jobs (default: ${defaultTestJobs})
  --list           list the plan without building or running tests
  --all            select the shared suites and the Chrome package suites; excludes firefox and live tests
  --coverage       collect once and apply gates; requires unit or --all without --match
  --help, -h       show help; append to a direct command for its options
`);
}

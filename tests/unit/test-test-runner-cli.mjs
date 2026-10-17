import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { parseCliArgs, validateSelection } from "../runner/cli.mjs";
import { directEntrypoint } from "../runner/entrypoints.mjs";
import { AUTOMATED_SUITES } from "../runner/suites.mjs";

function select(args) {
  const direct = directEntrypoint(args);
  if (direct) return direct;
  const cli = parseCliArgs(args);
  validateSelection(cli, Object.fromEntries(AUTOMATED_SUITES.map(name => [name, []])));
  return cli;
}

test("help and plans do not build, launch children or read live credentials", async t => {
  const fixture = await createFixture(t);
  for (const args of [
    ["--help"], ["--all", "--coverage", "--list"], ["unit", "--list"],
    ["live", "--help"], ["live", "--list"], ["live", "agent", "--help"],
    ["live", "agent", "--cases", "example", "--list"], ["live", "deepseek", "--help"],
    ["live", "rate", "--list"], ["live", "cli-mcp", "--help"], ["live", "cli-mcp", "--list"],
    ["live", "pi-concurrent-browsers", "--help"], ["live", "pi-concurrent-browsers", "--list"],
    ["grid", "--help"], ["grid", "--list"],
    ["playwright", "--help"], ["behavior", "--help"], ["report", "--help"],
  ]) {
    const plan = select(args);
    assert.ok(plan.help || plan.helpRequested || plan.list, args.join(" "));
  }
  for (const args of [["--help"], ["--all", "--coverage", "--list"]]) {
    assert.equal(fixture.run(args).status, 0, args.join(" "));
  }
  assert.match(fixture.run(["live", "agent", "--help"]).stdout, /--provider <name>, --model <name>/);
  assert.match(fixture.run(["live", "rate", "--help"]).stdout, /QINGZHOU_DEEPSEEK_MODEL/);
  assert.match(fixture.run(["live", "cli-mcp", "--help"]).stdout, /--duration-seconds 1800/);
  const soakPlan = fixture.run(["live", "cli-mcp", "--list"]);
  assert.equal(soakPlan.status, 0, soakPlan.stderr);
  assert.match(soakPlan.stdout, /tests\/live\/deepseek-cli-mcp-soak\.mjs/);
  assert.match(fixture.run(["live", "pi-concurrent-browsers", "--help"]).stdout, /Three independent Pi processes/);
  const concurrentPlan = fixture.run(["live", "pi-concurrent-browsers", "--list"]);
  assert.equal(concurrentPlan.status, 0, concurrentPlan.stderr);
  assert.match(concurrentPlan.stdout, /tests\/live\/pi-concurrent-browsers\.mjs/);
  assert.deepEqual(await fixture.events(), []);
});

test("invalid selections fail before launching or building anything", async t => {
  const fixture = await createFixture(t);
  for (const args of [
    ["--unknown"], ["--match"], ["--match", "--list"], ["--suite"], ["--suite="],
    ["--jobs", "0"], ["--jobs", "1.5"], ["--all", "unit"], ["--all", "live"],
    ["unit", "unknown"], ["agent"], ["--coverage"], ["browser", "--coverage"],
    ["unit", "--coverage", "--match", "example"], ["live", "--coverage"],
    ["live", "agent", "--coverage"], ["live", "unknown"], ["live", "rate", "--model", "example"],
    ["live", "deepseek", "--unknown"], ["grid", "--unknown"], ["live", "realworld", "--suite", "base"],
    ["live", "pi-concurrent-browsers", "--unknown"],
    ["playwright", "--all"], ["unit,", "--list"],
  ]) assert.throws(() => select(args), undefined, args.join(" "));
  for (const args of [["--jobs", "0"], ["browser", "--coverage"], ["live", "unknown"]]) {
    const result = fixture.run(args);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--jobs must|--coverage requires|Unknown live target/);
  }
  assert.deepEqual(await fixture.events(), []);
});

test("native runners receive their exact arguments, including spaces and equals", async t => {
  const fixture = await createFixture(t);
  const cases = [
    [["playwright", "a test.spec.mjs", "--grep", "hello = world", "--workers", "1"], "node_modules/@playwright/test/cli.js", ["test", "--config", "tests/config/playwright.config.mjs", "a test.spec.mjs", "--grep", "hello = world", "--workers", "1"]],
    [["report", "--port", "9911"], "node_modules/@playwright/test/cli.js", ["show-report", "tests/results/playwright-report", "--port", "9911"]],
    [["behavior", "--journey", "A03,H01", "--coverage", "强", "--list"], "tests/behavior/run.mjs", ["--journey", "A03,H01", "--coverage", "强", "--list"]],
    [["live", "agent", "--model", "custom=model", "--report", "a directory/report.json"], "tests/background/agent-behavior-e2e.mjs", ["--model", "custom=model", "--report", "a directory/report.json"]],
    [["live", "realworld", "--cases", "example"], "tests/background/agent-behavior-e2e.mjs", ["--suite", "realworld", "--cases", "example"]],
    [["grid"], "tests/data-grid/extension-page.mjs", []],
    [["live", "deepseek"], "tests/live/deepseek-extension.mjs", []],
    [["live", "rate"], "tests/live/deepseek-rate-governor.mjs", []],
    [["live", "pi-concurrent-browsers"], "tests/live/pi-concurrent-browsers.mjs", []],
    [["live", "cli-mcp", "--duration-seconds", "1800", "--cases", "research,forms"], "tests/live/deepseek-cli-mcp-soak.mjs", ["--duration-seconds", "1800", "--cases", "research,forms"]],
  ];
  for (const [args, path, expectedArgs] of cases) {
    const result = fixture.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await fixture.events()).at(-1), { path, args: expectedArgs });
  }
});

test("default and full unattended plans exclude live runners", async t => {
  const fixture = await createFixture(t);
  for (const [args, expected] of [[[], ["unit", "contracts", "services", "browser"]], [["--all"], unattended]]) {
    await fixture.clear();
    assert.equal(fixture.run(args).status, 0);
    assert.deepEqual((await fixture.events()).map(event => event.args[0]).sort(), [...expected].sort());
  }
});

test("the explicit live default preserves DeepSeek then realworld", async t => {
  const fixture = await createFixture(t);
  const result = fixture.run(["live"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fixture.events(), [
    { path: "build", args: [] },
    { path: "tests/live/deepseek-extension.mjs", args: [] },
    { path: "tests/background/agent-behavior-e2e.mjs", args: ["--suite", "realworld"] },
  ]);
});

for (const full of [false, true]) {
  test(`${full ? "full" : "unit"} coverage executes each selected suite once before its matching gate`, async t => {
    const fixture = await createFixture(t);
    const result = fixture.run([full ? "--all" : "unit", "--coverage", "--jobs", "1"]);
    assert.equal(result.status, 0, result.stderr);
    const events = await fixture.events();
    assert.equal(events[0].path, "c8");
    assert.deepEqual(events.filter(event => event.path === "tests/unit/example.mjs").map(event => event.args[0]), full ? unattended : ["unit"]);
    assert.deepEqual(events.at(-1), { path: "tests/coverage/check-critical.mjs", args: full ? ["--scope", "full"] : [] });
    assert.equal(events.filter(event => event.path === "c8").length, 1);
  });
}

test("runner failures and coverage gate failures retain their exit codes", async t => {
  const fixture = await createFixture(t);
  for (const [args, path] of [
    [["playwright", "example.spec.mjs"], "node_modules/@playwright/test/cli.js"],
    [["unit", "--coverage"], "tests/unit/example.mjs"],
    [["unit", "--coverage"], "tests/coverage/check-critical.mjs"],
  ]) {
    await fixture.clear();
    const result = fixture.run(args, { QZ_FIXTURE_FAILURE: path });
    assert.equal(result.status, 7, result.stderr);
    if (path === "tests/unit/example.mjs") {
      assert.equal((await fixture.events()).some(event => event.path === "tests/coverage/check-critical.mjs"), false);
    }
  }
});

const unattended = ["unit", "contracts", "services", "browser", "e2e", "release", "visual"];

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-cli-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventFile = join(root, "events.jsonl");
  await put("package.json", '{"type":"module"}');
  await put("tests/run.mjs", await readFile(new URL("../run.mjs", import.meta.url), "utf8"));
  for (const name of ["cli", "entrypoints", "scheduler"]) {
    await put(`tests/runner/${name}.mjs`, await readFile(new URL(`../runner/${name}.mjs`, import.meta.url), "utf8"));
  }
  // Synthetic commands exercise the real CLI and process scheduler without
  // requiring browsers, provider credentials or a generated coverage report.
  await put("tests/runner/suites.mjs", `
    export const AUTOMATED_SUITES = ${JSON.stringify(unattended)};
    export const DEFAULT_SUITES = AUTOMATED_SUITES.slice(0, 4);
    export const BROWSER_RESOURCE_SUITES = new Set();
    export const commandLabel = item => [item.bin, ...item.args].join(' ');
    export function createSuiteCatalog() {
      const suites = Object.fromEntries(AUTOMATED_SUITES.map(name => [name, [{ bin: process.execPath, args: ['tests/unit/example.mjs', name] }]]));
      return { suites, browserHeavyUnitFiles: [], matchedUnitTestFiles: ['tests/unit/example.mjs'], filteredCommands: name => suites[name] };
    }
  `);
  await put("tests/support/typescript-loader.mjs", "// Fixture descendants contain only plain JavaScript.\n");
  await put("tests/support/extension-build.mjs", `import { appendFileSync } from 'node:fs'; export async function ensureTestExtension() { appendFileSync(process.env.QZ_FIXTURE_EVENTS, JSON.stringify({path:'build',args:[]})+'\\n'); return '/isolated-fixture'; }`);
  await put("node_modules/playwright/package.json", '{"type":"module","exports":"./index.mjs"}');
  await put("node_modules/playwright/index.mjs", "export const chromium = { executablePath: () => '/locked-chromium' };");
  for (const path of [
    "tests/unit/example.mjs", "tests/coverage/check-critical.mjs", "tests/behavior/run.mjs",
    "tests/background/agent-behavior-e2e.mjs", "tests/data-grid/extension-page.mjs",
    "tests/live/deepseek-extension.mjs", "tests/live/deepseek-rate-governor.mjs", "tests/live/deepseek-cli-mcp-soak.mjs",
    "tests/live/pi-concurrent-browsers.mjs",
  ]) await put(path, recorder);
  await put("node_modules/@playwright/test/package.json", '{"type":"module"}');
  await put("node_modules/@playwright/test/cli.js", recorder);
  await put("node_modules/c8/package.json", '{"type":"module"}');
  await put("node_modules/c8/bin/c8.js", `
    import { appendFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    appendFileSync(process.env.QZ_FIXTURE_EVENTS, JSON.stringify({path:'c8',args})+'\\n');
    const result = spawnSync(args[2], args.slice(3), { stdio: 'inherit', env: process.env });
    process.exit(result.status ?? 1);
  `);
  return {
    run(args, env = {}) {
      const environment = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter), QZ_FIXTURE_EVENTS: eventFile, ...env };
      delete environment.NODE_OPTIONS;
      delete environment.NODE_TEST_CONTEXT;
      delete environment.NODE_V8_COVERAGE;
      return spawnSync(process.execPath, ["tests/run.mjs", ...args], { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 });
    },
    async clear() { await writeFile(eventFile, ""); },
    async events() {
      const text = await readFile(eventFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
    },
  };
  async function put(path, contents) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), contents); }
}

const recorder = `
  import { appendFileSync } from 'node:fs'; import { relative } from 'node:path';
  const path = relative(process.cwd(), process.argv[1]).replaceAll('\\\\', '/');
  appendFileSync(process.env.QZ_FIXTURE_EVENTS, JSON.stringify({path, args:process.argv.slice(2)})+'\\n');
  if (process.env.QZ_FIXTURE_FAILURE === path) process.exit(7);
`;

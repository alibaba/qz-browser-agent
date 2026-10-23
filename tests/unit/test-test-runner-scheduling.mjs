import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

const PRIMARY = "tests/background/image-conversion-e2e.mjs";
const SECONDARY = "tests/release/build-extension.test.mjs";
const MEASUREMENTS = [
  "tests/benchmarks/conversation-render/run.mjs",
  "tests/benchmarks/conversation-render/run-stream-interaction.mjs",
  "tests/benchmarks/conversation-render/run-visual-audit-matrix.mjs",
];

test("ordinary resource lanes overlap, then all three conversation measurements run alone", async t => {
  const fixture = await createFixture(t);
  const result = await fixture.run();
  assert.equal(result.code, 0, result.output);
  const events = await fixture.events();
  const active = new Set();
  const measured = [];
  let resourceLanesOverlap = false;
  let ordinaryAfterMeasurement = false;
  for (const event of events) {
    if (event.kind === "start") {
      if (MEASUREMENTS.includes(event.id)) {
        assert.equal(active.size, 0, `${event.id} overlapped ${[...active].join(", ")}`);
        measured.push(event.id);
      } else if (measured.length) ordinaryAfterMeasurement = true;
      active.add(event.id);
      if (active.has(PRIMARY) && active.has(SECONDARY)) resourceLanesOverlap = true;
    } else active.delete(event.id);
  }
  assert.equal(resourceLanesOverlap, true, "primary and secondary commands must still run concurrently");
  assert.deepEqual(measured, MEASUREMENTS);
  assert.equal(ordinaryAfterMeasurement, false, "the whole ordinary phase must finish before measurement");
  assert.equal(active.size, 0);
});

test("an ordinary failure stops peers and prevents the exclusive phase", async t => {
  const fixture = await createFixture(t);
  const result = await fixture.run({ QZ_FAIL_TASK: PRIMARY });
  assert.equal(result.code, 7, result.output);
  const events = await fixture.events();
  assert.ok(events.some(event => event.id === PRIMARY && event.kind === "end"));
  assert.equal(events.some(event => MEASUREMENTS.includes(event.id)), false);
});

test("a blocked general command leaves its lane available while respecting dependencies", async t => {
  const fixture = await createFixture(t);
  const source = await readFile(fixture.suites, "utf8");
  const dependency = 'resource: "general",\n          after: ["playwright-browser"],';
  assert.ok(source.includes(dependency));
  // The primary fixture waits for the release build. Queuing the dependent grid
  // command first must not prevent that build from using the same general lane.
  await writeFile(fixture.suites, source.replace(dependency,
    'resource: "general",\n          after: ["image-conversion-e2e"],'));
  const result = await fixture.run({}, ["e2e", "release", "--jobs", "2"]);
  assert.equal(result.code, 0, result.output);
  const events = await fixture.events();
  const position = (id, kind) => events.findIndex(event => event.id === id && event.kind === kind);
  const ended = position(PRIMARY, "end");
  assert.ok(position(SECONDARY, "start") < ended);
  assert.ok(position("tests/data-grid/extension-page.mjs", "start") > ended);
  const starts = events.filter(event => event.kind === "start").map(event => event.id);
  assert.equal(new Set(starts).size, starts.length, "each command runs once");
});

test("two jobs reuse the general slot for isolated browser work before the primary lane finishes", async t => {
  const smoke = "tests/release/chrome-smoke.mjs";
  const fixture = await createFixture(t, { secondaryPeer: smoke });
  const result = await fixture.run({}, ["e2e", "release", "visual", "--jobs", "2"]);
  assert.equal(result.code, 0, result.output);
  const events = await fixture.events();
  const position = (id, kind) => events.findIndex(event => event.id === id && event.kind === kind);
  assert.ok(position(SECONDARY, "end") < position("tests/background/extension-e2e.mjs", "start"));
  assert.ok(position(smoke, "start") < position(PRIMARY, "end"), "secondary work must not wait for the primary lane");
  for (const measurement of MEASUREMENTS) {
    assert.ok(position(measurement, "start") > position(smoke, "end"));
    assert.ok(position(measurement, "start") > position(PRIMARY, "end"));
  }
});

test("a selected measurement can run by itself", async t => {
  const fixture = await createFixture(t);
  const result = await fixture.run({}, ["e2e", "--match", "tool-presentation-streaming", "--jobs", "3"]);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await fixture.events()).map(event => [event.kind, event.id]), [
    ["start", MEASUREMENTS[0]], ["end", MEASUREMENTS[0]],
  ]);
});

for (const executable of ["", "/explicit/chromium"]) {
  test(`browser tasks inherit ${executable ? "the explicit browser" : "locked Chromium by default"}`, async t => {
    const fixture = await createFixture(t);
    const result = await fixture.run({ CHROME_EXECUTABLE: executable }, ["e2e", "--match", "tool-presentation-streaming"]);
    assert.equal(result.code, 0, result.output);
    const started = (await fixture.events()).filter(event => event.kind === "start");
    assert.equal(started.length, 1);
    assert.equal(started[0].chromeExecutable, executable || "/locked-playwright-chromium");
  });
}

test("ordinary dependencies cannot point into the later exclusive phase", async t => {
  const fixture = await createFixture(t);
  const source = await readFile(fixture.suites, "utf8");
  const declaration = 'commandWith({ id: "image-conversion-e2e" },';
  assert.ok(source.includes(declaration));
  await writeFile(fixture.suites, source.replace(declaration,
    'commandWith({ id: "image-conversion-e2e", after: ["tool-presentation-streaming"] },'));
  const result = await fixture.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Ordinary test command depends on the later exclusive phase/);
  assert.deepEqual(await fixture.events(), [], "invalid plans fail before spawning any command");
});

test("SIGTERM during ordinary work cancels the pending exclusive phase", { skip: process.platform === "win32" }, async t => {
  const fixture = await createFixture(t);
  const { child, completion } = fixture.start();
  await Promise.race([
    fixture.primaryStarted,
    completion.then(result => { throw new Error(`fixture exited before its primary task started\n${result.output}`); }),
  ]);
  child.kill("SIGTERM");
  const result = await completion;
  assert.equal(result.code, 143, result.output);
  assert.equal((await fixture.events()).some(event => MEASUREMENTS.includes(event.id)), false);
});

for (const cancellation of ["peer failure", "external SIGTERM"]) {
  test(`a detached web server releases its port after ${cancellation}`, { skip: process.platform === "win32" }, async t => {
    const fixture = await createFixture(t);
    const env = { QZ_DETACHED_SERVER: "1", ...(cancellation === "peer failure" ? { QZ_FAIL_TASK: SECONDARY } : {}) };
    const { child, completion } = fixture.start(env);
    if (cancellation === "external SIGTERM") {
      await Promise.race([
        fixture.primaryStarted,
        completion.then(result => { throw new Error(`fixture exited before web server startup\n${result.output}`); }),
      ]);
      child.kill("SIGTERM");
    }
    const result = await completion;
    assert.equal(result.code, cancellation === "peer failure" ? 1 : 143, result.output);
    const server = (await fixture.events()).find(event => event.kind === "server-ready");
    assert.ok(server, result.output);
    await waitForPortRelease(server.port);
    server.released = true;
    assert.equal((await fixture.events()).some(event => MEASUREMENTS.includes(event.id)), false);
  });
}

async function waitForPortRelease(port) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const probe = createServer();
    try {
      probe.listen(port, "127.0.0.1");
      await once(probe, "listening");
      await new Promise(resolve => probe.close(resolve));
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

async function createFixture(t, { secondaryPeer = SECONDARY } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-runner-scheduling-"));
  const children = new Set();
  const sockets = new Set();
  const events = [];
  const peers = new Map();
  let peersReleased = false;
  let resolvePrimaryStarted;
  const primaryStarted = new Promise(resolve => { resolvePrimaryStarted = resolve; });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // Cancelling the runner can terminate an active fixture socket.
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        events.push(event);
        if (event.kind !== "start") continue;
        if (event.id === PRIMARY) resolvePrimaryStarted();
        if ([PRIMARY, secondaryPeer].includes(event.id)) peers.set(event.id, socket);
        if (peers.size === 2 && !peersReleased) {
          // Neither resource lane can finish until both child processes are alive.
          peersReleased = true;
          for (const peer of peers.values()) peer.write("continue\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => {
      child.once("close", resolve);
      child.kill("SIGTERM");
    })));
    for (const event of events.filter(event => event.kind === "server-ready" && !event.released)) {
      // Only fixture-owned PIDs are eligible for cleanup when the assertion fails.
      try { process.kill(event.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const runner = join(root, "tests/run.mjs");
  await mkdir(join(root, "tests/unit"), { recursive: true });
  await put(root, "tests/run.mjs", await readFile(new URL("../run.mjs", import.meta.url), "utf8"));
  for (const name of ["cli", "entrypoints", "suites", "scheduler"]) {
    await put(root, `tests/runner/${name}.mjs`, await readFile(new URL(`../runner/${name}.mjs`, import.meta.url), "utf8"));
  }
  await put(root, "tests/support/extension-build.mjs", "export async function ensureTestExtension() { return '/isolated-fixture'; }\nexport function resolveTestAsset() { return null; }\n");
  await put(root, "tests/support/typescript-loader.mjs", "// Fixture child scripts are plain JavaScript.\n");
  await put(root, "node_modules/playwright/package.json", JSON.stringify({ type: "module", exports: "./index.mjs" }));
  await put(root, "node_modules/playwright/index.mjs", "export const chromium = { executablePath: () => '/locked-playwright-chromium' };\n");
  await put(root, "tests/support/benchmark-assets.mjs", "export async function prepareBenchmarkAssets() {}\n");
  await put(root, "tests/support/static-server.mjs", await readFile(new URL("../support/static-server.mjs", import.meta.url), "utf8"));
  for (const path of [
    PRIMARY, SECONDARY, ...MEASUREMENTS,
    "tests/background/provider-header-rules-e2e.mjs",
    "tests/background/extension-e2e.mjs",
    "tests/background/mcp-tab-ownership-e2e.mjs",
    "tests/background/mcp-resilience-e2e.mjs",
    "tests/background/mcp-user-input-e2e.mjs",
    "tests/background/mcp-resources-e2e.mjs",
    "tests/data-grid/extension-page.mjs",
    "tests/release/bundle-release.test.mjs",
    "tests/release/npm-package.mjs",
    "tests/release/chrome-smoke.mjs",
    "tests/session-exchange/consent-import-check.mjs",
    "tests/support/run-python-browser.mjs",
  ]) await put(root, path, childSource);

  const fixture = {
    runner,
    suites: join(root, "tests/runner/suites.mjs"),
    primaryStarted,
    async events() { return [...events]; },
    start(env = {}, args = ["e2e", "release", "visual", "--jobs", "3"]) {
      const environment = {
        ...process.env,
        QZ_RUNNER_EVENT_PORT: String(server.address().port),
        QZ_RUNNER_SECONDARY_PEER: secondaryPeer,
        PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
        ...env,
      };
      // This isolated tree contains only synthetic JS, not production coverage or TS.
      // Inherit the actual Node version but not the outer test runner/loader state.
      delete environment.NODE_TEST_CONTEXT;
      delete environment.NODE_OPTIONS;
      delete environment.NODE_V8_COVERAGE;
      const child = spawn(process.execPath, [runner, ...args], {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const completion = new Promise((resolve, reject) => {
        // This is a deadlock guard, not a speed assertion: the fixture starts nested
        // Node commands while the full coverage/browser run competes for CPU.
        const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`fixture runner timed out\n${output}`)); }, 60_000);
        child.once("error", reject);
        child.once("close", code => {
          clearTimeout(timeout);
          children.delete(child);
          resolve({ code, output });
        });
      });
      return { child, completion };
    },
    async run(env, args) { return this.start(env, args).completion; },
  };
  return fixture;
}

async function put(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

const childSource = `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { relative } from "node:path";
const script = relative(process.cwd(), process.argv[1]).replaceAll("\\\\", "/");
const id = script.endsWith("run-python-browser.mjs") ? process.argv[2] : script;
const peers = [${JSON.stringify(PRIMARY)}, process.env.QZ_RUNNER_SECONDARY_PEER];
const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.QZ_RUNNER_EVENT_PORT) });
const ready = peers.includes(id) ? once(socket, "data") : null;
await once(socket, "connect");
const event = kind => JSON.stringify({ kind, id, chromeExecutable: process.env.CHROME_EXECUTABLE }) + "\\n";
const log = kind => socket.write(event(kind));
const delay = duration => new Promise(resolve => setTimeout(resolve, duration));
process.on("SIGTERM", () => {
  socket.once("close", () => process.exit(0));
  socket.end(event("stopped"));
});
if (process.env.QZ_DETACHED_SERVER && id === ${JSON.stringify(PRIMARY)}) {
  // Match Playwright's separate group and dedicated stdin pipe; the runner cannot
  // reach this grandchild by signalling the ordinary command's process group.
  const server = spawn(process.execPath, ["tests/support/static-server.mjs", "--port", "0", "--watch-stdin"], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  server.stderr.pipe(process.stderr);
  const port = await new Promise((resolve, reject) => {
    let output = "";
    server.once("error", reject);
    server.once("exit", code => reject(new Error("web server exited early: " + code)));
    server.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/127[.]0[.]0[.]1:([0-9]+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  socket.write(JSON.stringify({ kind: "server-ready", id, pid: server.pid, port }) + "\\n");
}
log("start");
if (ready) await ready;
if (process.env.QZ_DETACHED_SERVER && id === ${JSON.stringify(PRIMARY)}) await new Promise(() => {});
await delay(script.endsWith("chrome-smoke.mjs") ? 600 : 60);
const closed = once(socket, "close");
socket.end(event("end"));
await closed;
if (process.env.QZ_FAIL_TASK === id) process.exit(7);
`;

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { localFetch, readHealth, resultValue } from "../../services/mcp-bridge/src/client.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { independentChrome, until } from "../support/independent-chrome.mjs";
import { CASES } from "./deepseek-multi-browser-cases.mjs";

// Explicit live entry only. Fixed cases, owned Chrome processes, isolated service and profiles.
const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: { "task-timeout-seconds": { type: "string", default: "450" }, output: { type: "string" }, cases: { type: "string" } } });
const taskTimeout = Number(values["task-timeout-seconds"]);
assert.ok(taskTimeout >= 60 && taskTimeout <= 900);
const selected = values.cases ? CASES.filter(item => values.cases.split(",").includes(item.id)) : CASES;
assert.ok(selected.length); assert.ok(!values.cases || values.cases.split(",").every(id => CASES.some(item => item.id === id)), "Unknown live case");
const apiKey = readTestApiKey("deepseek", { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || "" });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const output = resolve(values.output || join(root, "tests/results/multi-browser", `deepseek-${new Date().toISOString().replace(/[:.]/g, "-")}`));
await mkdir(output, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(tmpdir(), "qz-live-three-browsers-"));
const browsers = [], children = new Set(), pendingWrites = new Set();
const report = { ok: false, phase: "setup", provider: "deepseek", model, startedAt: new Date().toISOString(),
  environment: "Three independent Chrome processes/profiles, real DeepSeek, public websites, production extension, real CLI subprocesses and MCP SDK. No synthetic model responses or user browser state.",
  plannedCases: selected.map(item => item.id), profiles: [], tasks: [], scenarios: [], operations: [], cleanup: {}, failures: [] };
let bridge, extensionPath, saveExtensionLlmConfig, heartbeat, interrupted = false, serial = 0;
const redact = text => String(text).split(apiKey).join("[REDACTED]");
async function save(path, value) {
  const target = join(output, path); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)), { mode: 0o600 });
}
const persist = () => save("report.json", report);
function progress(stage, details = {}) { console.log(JSON.stringify({ stage, ...details, output })); }
function track(promise) { pendingWrites.add(promise); promise.catch(error => report.failures.push({ stage: "capture", error: redact(error.message) })).finally(() => pendingWrites.delete(promise)); }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; for (const child of children) child.kill("SIGTERM"); });
async function startService(port = 0) { bridge = await startBridge({ port, registryPath: join(directory, "browsers.json"), requestTimeoutSeconds: 40 }); }
async function settings(browser, type) {
  const page = await browser.panel();
  try { return await page.evaluate(type => chrome.runtime.sendMessage({ type }), type); }
  finally { await page.close(); }
}
async function connected(browser) {
  return until(async () => (await readHealth(bridge.endpoint)).status.clients.find(client => client.clientId === browser.uuid), `${browser.name} connected`, 100000);
}
async function connect(browser) {
  const result = await runCli(["connect", "--no-open", "--name", browser.name, "--json"], {
    ensureDaemon: async () => ({ endpoint: bridge.endpoint, instanceId: bridge.instanceId, health: await readHealth(bridge.endpoint) }),
    openBrowser: () => assert.fail("--no-open must not launch a default user browser"),
  });
  assert.ok(result.result.url, "headless connect returns the exact browser pairing URL");
  const page = await browser.context.newPage();
  try {
    await page.goto(result.result.url);
    await page.locator('[data-qz-connection-state="connected"]').waitFor({ timeout: 40000 });
    await connected(browser);
  } finally { await page.close(); }
}
async function openMcp(browser) {
  browser.mcp = new Client({ name: `qz-live-${browser.name}`, version: "1.0.0" });
  browser.transport = new StreamableHTTPClientTransport(new URL("/mcp", bridge.endpoint), { fetch: localFetch });
  await browser.mcp.connect(browser.transport);
}
async function closeMcp(browser) {
  await browser.transport?.terminateSession().catch(() => {}); await browser.mcp?.close().catch(() => {});
}
async function mcp(browser, name, args = {}, options = {}) {
  const at = Date.now();
  const result = await browser.mcp.callTool({ name, arguments: { clientId: browser.uuid, ...args } }, undefined,
    { timeout: (taskTimeout + 30) * 1000, resetTimeoutOnProgress: true, ...options });
  const value = resultValue(result);
  report.operations.push({ at, route: "mcp", browser: browser.name, clientId: browser.uuid, name, ok: !result.isError, durationMs: Date.now() - at });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
function observeMcp(browser, name, args) {
  const observer = { events: [], settled: false };
  observer.promise = mcp(browser, name, { ...args, stream: true, waitTimeoutSeconds: taskTimeout }, { onprogress(progress) {
    const event = progress._meta?.["qz/task-event"];
    if (event) { observer.events.push({ at: Date.now(), event }); if (event.type === "created") observer.created = event; }
  } }).then(value => { observer.value = value; }, error => { observer.error = error; }).finally(() => { observer.settled = true; });
  return observer;
}
function observeCli(browser, args) {
  const observer = { events: [], settled: false, stdout: "", stderr: "" };
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from './services/mcp-bridge/src/cli.mjs';
    import { readHealth } from './services/mcp-bridge/src/client.mjs';
    const endpoint = process.argv[1];
    process.exitCode = await main(process.argv.slice(2), {
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
      onTaskCreated: value => process.send({ type: 'created', value }),
      onTaskUpdate: value => process.send({ type: 'event', value }),
    }); process.disconnect();
  `, "--", bridge.endpoint, ...args, "--client", browser.name, "--json", "--timeout", String(taskTimeout)],
  { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  child.stdout.on("data", chunk => { observer.stdout += chunk; }); child.stderr.on("data", chunk => { observer.stderr += chunk; });
  child.on("message", message => {
    if (message.type === "created") observer.created = message.value;
    else observer.events.push({ at: Date.now(), event: message.value });
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), (taskTimeout + 30) * 1000);
  observer.promise = new Promise(resolve => {
    child.once("error", error => { observer.error = error; resolve(); });
    child.once("close", code => {
      observer.exitCode = code;
      try { const value = JSON.parse(observer.stdout.trim()); if (code !== 0 || !value.ok) throw new Error(observer.stdout || observer.stderr); observer.value = value.result; }
      catch (error) { observer.error = error; }
      resolve();
    });
  }).finally(() => { clearTimeout(timer); children.delete(child); observer.settled = true; });
  return observer;
}
async function cli(browser, args) { const observer = observeCli(browser, args); await observer.promise; if (observer.error) throw observer.error; return observer.value; }
const text = content => typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
const assistantText = snapshot => (snapshot.transcript || []).filter(entry => entry.type === "assistant").map(entry => text(entry.content)).join("\n");
async function snapshot(browser, sessionId) { return mcp(browser, "qingzhou_get_session_snapshot", { sessionId, compact: false, tail: false, includeArtifacts: true }); }
function attachCapture(browser) {
  browser.sources = []; browser.network = []; browser.diagnostics = [];
  browser.context.on("response", response => {
    const url = new URL(response.url()), request = response.request();
    if (!/^https?:$/.test(url.protocol) || ["127.0.0.1", "localhost"].includes(url.hostname)) return;
    const provider = url.hostname === "api.deepseek.com", source = /earthquake\.usgs\.gov|hacker-news\.firebaseio\.com/.test(url.hostname);
    const event = { at: Date.now(), url: url.href, status: response.status(), method: request.method(), provider };
    browser.network.push(event);
    if (provider || source) track((async () => {
      const id = `${browser.name}/network/${++serial}`;
      const body = await response.body();
      event.bodyPath = `${id}.body.txt`; event.bytes = body.length;
      await save(event.bodyPath, body.toString("utf8"));
      if (provider) await save(`${id}.request.json`, { method: request.method(), url: url.href, body: request.postDataJSON() });
      if (source) { try { browser.sources.push({ ...event, value: JSON.parse(body.toString("utf8")) }); } catch {} }
    })());
  });
  const worker = item => item.on("console", message => { if (["error", "warning"].includes(message.type())) browser.diagnostics.push({ at: Date.now(), text: redact(message.text()) }); });
  browser.context.serviceWorkers().forEach(worker); browser.context.on("serviceworker", worker);
}
async function answerInput(browser, entry, input, observer) {
  assert.notEqual(input.requiresUserAction, true, "native Chrome consent must stay under direct user control");
  assert.ok(input.kind === entry.input || (entry.input === "confirmation" && input.kind === "form"), "only the case's requested input may be answered");
  if (entry.input === "confirmation") assert.ok(`${input.message} ${input.form?.message}`.includes(entry.source), "confirmation stays scoped to the requested public URL");
  await delay(1200); assert.equal(observer.settled, false, "stream remains active while user input is pending");
  const action = input.kind === "form" ? "submit" : "approve";
  const answers = input.kind === "form" ? Object.fromEntries(input.form.fields.map(field => {
    const option = field.options?.find(option => entry.input === "confirmation"
      ? [option.label, option.value].some(value => /^(yes|approve|confirm|允许访问|同意|确认)$/i.test(String(value)))
      : /webb|韦布/i.test(`${option.label} ${option.value}`));
    assert.ok(option, `field ${field.id} must offer the case's explicit answer`);
    return [field.id, field.type === "multi_choice" ? [option.value] : option.value];
  })) : undefined;
  entry.inputs.push({ waitId: input.waitId, kind: input.kind, form: input.form, action, answers });
  if (entry.route === "mcp") await cli(browser, [action, entry.sessionId, ...(answers ? [JSON.stringify(answers)] : []), "--wait-id", input.waitId]);
  else await mcp(browser, "qingzhou_respond_to_user_input", { sessionId: entry.sessionId, waitId: input.waitId, action, ...(answers ? { answers } : {}) });
}
async function verifyTable(browser, entry) {
  const listed = await cli(browser, ["data", "list"]);
  assert.equal(listed.tables.find(table => table.name === entry.table)?.count, 5);
  const exported = await cli(browser, ["data", "export", entry.table, "--format", "csv"]);
  await save(`${entry.id}/export.json`, exported);
  const page = await browser.panel(); let download;
  try { download = await until(() => page.evaluate(async id => (await chrome.downloads.search({ id }))[0], exported.downloadId).then(item => item?.state === "complete" && item), "CSV download"); }
  finally { await page.close(); }
  const path = relative(browser.downloads, download.filename); assert.ok(path && !path.startsWith("..") && !isAbsolute(path));
  const bytes = await readFile(download.filename); await save(`${entry.id}/table.csv`, bytes.toString("utf8"));
  const book = XLSX.read(bytes, { type: "buffer", raw: true });
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: "" });
  assert.equal(rows.length, 5); assert.equal(new Set(rows.map(row => row.event_id)).size, 5);
  await Promise.allSettled([...pendingWrites]);
  const captured = browser.sources.filter(source => source.url === entry.source && source.value?.features).at(-1);
  let matched = 0; const timestampPrecision = { milliseconds: 0, seconds: 0 };
  for (const [index, row] of rows.entries()) {
    const magnitude = Number(row.magnitude); assert.ok(Number.isFinite(magnitude));
    if (index) assert.ok(Number(rows[index - 1].magnitude) >= magnitude);
    let feature = captured?.value.features.find(feature => feature.id === row.event_id);
    if (!feature) {
      const response = await fetch(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${encodeURIComponent(row.event_id)}.geojson`, { signal: AbortSignal.timeout(30000) });
      assert.equal(response.ok, true); feature = await response.json(); await save(`${entry.id}/event-${row.event_id}.json`, feature);
    }
    assert.equal(feature.id, row.event_id); assert.equal(feature.properties.mag, magnitude);
    assert.equal(feature.properties.place, row.place);
    const time = Date.parse(row.time_utc), sourceTime = feature.properties.time;
    assert.ok(time === sourceTime || time === Math.floor(sourceTime / 1000) * 1000, "UTC time must preserve the source instant to at least whole seconds");
    timestampPrecision[time === sourceTime ? "milliseconds" : "seconds"]++;
    assert.equal(row.source_url, feature.properties.url); matched++;
  }
  if (captured) {
    const strongest = captured.value.features.map(feature => feature.properties.mag).filter(value => typeof value === "number").sort((a, b) => b - a).slice(0, 5);
    assert.deepEqual(rows.map(row => Number(row.magnitude)), strongest);
  }
  entry.tableVerification = { rows: matched, timestampPrecision, exactCapturedFeed: Boolean(captured), sourcePath: captured?.bodyPath,
    limitation: captured ? null : "Event metadata verified independently; exact top-five membership cannot be verified without the browser's feed snapshot." };
}
async function runCase(spec) {
  const browser = browsers.find(item => item.name === spec.browser);
  const entry = { ...spec, terms: spec.terms.map(String), prompt: `${spec.prompt}\nSource: ${spec.source}`, clientId: browser.uuid,
    startedAt: new Date().toISOString(), inputs: [], ok: false };
  report.tasks.push(entry); await persist(); progress("task-start", { id: entry.id, browser: browser.name, route: entry.route });
  const observer = spec.route === "cli" ? observeCli(browser, ["create", entry.prompt, "--title", `Live ${entry.id}`, "--stream"])
    : observeMcp(browser, "qingzhou_create_session", { firstMessage: entry.prompt, title: `Live ${entry.id}` });
  try {
    const created = await until(() => { if (observer.error) throw observer.error; return observer.created; }, `${entry.id} admission`, 45000);
    entry.sessionId = created.session?.id || created.sessionId; assert.ok(entry.sessionId); browser.sessions.add(entry.sessionId);
    const deadline = Date.now() + taskTimeout * 1000, answered = new Set();
    while (!observer.settled) {
      if (interrupted || Date.now() > deadline) throw new Error("Bounded live observation ended");
      for (const { event } of observer.events.filter(item => item.event?.type === "input")) {
        if (answered.has(event.waitId)) continue;
        const shown = await cli(browser, ["show", entry.sessionId]);
        if (shown.input?.waiting && shown.input.waitId === event.waitId) {
          answered.add(event.waitId); await answerInput(browser, entry, shown.input, observer);
        }
      }
      await delay(500);
    }
    await observer.promise; if (observer.error) throw observer.error;
    entry.snapshot = await snapshot(browser, entry.sessionId); assert.equal(entry.snapshot.status, "completed");
    const answer = assistantText(entry.snapshot); entry.answer = answer;
    assert.ok(answer.trim().length > 20); for (const term of spec.terms) assert.match(answer, term);
    entry.toolCalls = (entry.snapshot.transcript || []).filter(item => item.type === "tool").map(item => ({ name: item.name, isError: item.isError, phase: item.phase }));
    assert.ok(entry.toolCalls.some(item => !item.isError), "task performed actual tool execution");
    if (spec.input) assert.ok(entry.inputs.length, "task must actually wait for requested input");
    if (spec.table) await verifyTable(browser, entry);
    entry.ok = true;
  } catch (error) {
    entry.error = redact(error.stack || error.message); entry.failureKind = /assert|match|equal|expected/i.test(error.message) ? "acceptance" : "execution-or-environment";
    if (entry.sessionId) {
      entry.snapshot = await snapshot(browser, entry.sessionId).catch(() => null);
      if (entry.snapshot?.status !== "completed") await mcp(browser, "qingzhou_stop_session", { sessionId: entry.sessionId }).catch(() => {});
    }
    await Promise.race([observer.promise, delay(5000)]);
  } finally {
    entry.finishedAt = new Date().toISOString(); entry.durationMs = Date.parse(entry.finishedAt) - Date.parse(entry.startedAt);
    await save(`${entry.id}/events.json`, observer.events); await save(`${entry.id}/result.json`, observer.value || { error: entry.error });
    if (observer.stdout !== undefined) { await save(`${entry.id}/stdout.txt`, observer.stdout); await save(`${entry.id}/stderr.txt`, observer.stderr); }
    if (entry.snapshot) await save(`${entry.id}/snapshot.json`, entry.snapshot);
    const page = await browser.panel();
    try {
      await page.locator('[data-tab="sessions"]').click({ timeout: 5000 });
      await page.locator(`.session-card[data-id="${entry.sessionId}"]`).click({ timeout: 5000 });
      await page.screenshot({ path: join(output, `${entry.id}/panel.png`), fullPage: true });
    } catch (error) { entry.screenshotError = redact(error.message); }
    await page.close();
    delete entry.snapshot; await persist(); progress("task-finished", { id: entry.id, ok: entry.ok, durationMs: entry.durationMs, sessionId: entry.sessionId, error: entry.error?.split("\n")[0] });
  }
}
async function scenario(name, work) {
  const entry = { name, startedAt: new Date().toISOString(), ok: false }; report.scenarios.push(entry); progress(name);
  try { await work(entry); entry.ok = true; } catch (error) { entry.error = redact(error.stack || error.message); }
  entry.finishedAt = new Date().toISOString(); await persist(); return entry;
}
try {
  extensionPath = process.env.QINGZHOU_TEST_EXTENSION_DIR;
  if (!extensionPath) {
    const { buildExtension } = await import("../../scripts/build-extension.mjs");
    extensionPath = (await buildExtension({ outputDir: join(output, "extension"), mode: "production" })).outputDir;
  }
  process.env.QINGZHOU_TEST_EXTENSION_DIR = extensionPath;
  ({ saveExtensionLlmConfig } = await import("../support/isolated-extension-mcp.mjs"));
  report.extensionPath = extensionPath; report.manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  report.extensionSha256 = createHash("sha256").update(await readFile(join(extensionPath, "background/service-worker.js"))).digest("hex");
  await startService(); report.endpoint = bridge.endpoint;
  for (const name of ["default", "research", "work"]) {
    const profile = join(directory, name), downloads = join(profile, "downloads");
    await mkdir(join(profile, "Default"), { recursive: true }); await mkdir(downloads, { recursive: true });
    await writeFile(join(profile, "Default/Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }));
    const browser = await independentChrome({ profile, extensionPath, name, outputDirectory: join(output, name) });
    browsers.push(browser); browser.sessions = new Set(); browser.downloads = downloads;
    attachCapture(browser); const page = await browser.panel();
    const cdp = await browser.context.newCDPSession(page); await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: browser.downloads }); await cdp.detach();
    await acceptDataDisclosure(page, { disableBridge: false });
    await saveExtensionLlmConfig(page, { provider: "deepseek", apiKey, model, contextWindow: 1048576, trimOldToolResults: true, vision: false, debugMode: false });
    const local = await page.evaluate(() => chrome.runtime.sendMessage({ type: "mcp_connection_status" }));
    assert.equal(local.result.state, "disconnected"); assert.equal(browser.requests.length, 0); browser.uuid = local.result.clientId;
    await page.close(); await connect(browser); await openMcp(browser);
    report.profiles.push({ name, uuid: browser.uuid, chromeVersion: browser.version, launches: browser.launches });
  }
  report.phase = "running"; heartbeat = setInterval(() => { progress("heartbeat", { tasks: report.tasks.length, finished: report.tasks.filter(item => item.finishedAt).length }); track(persist()); }, 30000);
  assert.equal(new Set(browsers.map(browser => browser.uuid)).size, 3);
  await scenario("explicit-selection-required", async () => {
    await assert.rejects(browsers[0].mcp.callTool({ name: "qingzhou_list_sessions", arguments: {} }).then(result => { if (result.isError) throw new Error(JSON.stringify(resultValue(result))); }), /select|multiple|client|browser/i);
  });
  await scenario("pairing-name-conflict-preserves-existing-connection", async entry => {
    const page = await browsers[0].context.newPage();
    try {
      await page.goto(`${bridge.endpoint}/qz-connect?name=work`);
      await page.locator('[data-qz-connection-code="BRIDGE_NAME_IN_USE"]').waitFor({ timeout: 15000 });
      const own = await connected(browsers[0]); assert.equal(own.name, "default");
      await Promise.all(browsers.map(browser => mcp(browser, "qingzhou_list_sessions")));
      entry.clientId = own.clientId; entry.browserName = own.name;
    } finally { await page.close(); }
  });
  await Promise.all(selected.filter(spec => CASES.indexOf(spec) < 3).map(runCase));
  if (selected.some(spec => spec.id === "python-counter")) await scenario("follow-up-same-task", async entry => {
    const task = report.tasks.find(item => item.id === "python-counter"); assert.ok(task.ok);
    const result = await mcp(browsers[0], "qingzhou_send_message", { sessionId: task.sessionId, text: "Now explain in English how ties are ordered by Counter.most_common. Cite the documentation.", wait: true, waitTimeoutSeconds: taskTimeout });
    assert.equal(result.sessionId, task.sessionId); assert.equal(result.snapshot.status, "completed");
    const full = await snapshot(browsers[0], task.sessionId); await save("follow-up/snapshot.json", full);
    assert.match(assistantText(full), /first|encounter|insert/i); entry.sessionId = task.sessionId;
  });
  await scenario("disconnect-one-profile-others-remain-usable", async () => {
    assert.equal((await settings(browsers[1], "mcp_connection_disconnect")).ok, true);
    await assert.rejects(mcp(browsers[1], "qingzhou_list_sessions"), /offline|disconnect|not.*connect/i);
    await Promise.all([mcp(browsers[0], "qingzhou_list_sessions"), mcp(browsers[2], "qingzhou_list_sessions")]);
    await connect(browsers[1]);
  });
  await scenario("service-restart-retains-profile-and-task-ownership", async () => {
    const saved = await Promise.all(report.tasks.filter(task => task.ok).map(async task => ({ task, snapshot: await snapshot(browsers.find(browser => browser.name === task.browser), task.sessionId) })));
    await Promise.all(browsers.map(closeMcp)); const port = Number(new URL(bridge.endpoint).port); await bridge.close(); await startService(port);
    await Promise.all(browsers.map(connected)); await Promise.all(browsers.map(openMcp));
    for (const { task, snapshot: prior } of saved) {
      const after = await snapshot(browsers.find(browser => browser.name === task.browser), task.sessionId);
      assert.deepEqual(after.transcript, prior.transcript); assert.equal(after.status, prior.status);
    }
  });
  await Promise.all(selected.filter(spec => CASES.indexOf(spec) >= 3).map(runCase));
  await scenario("cross-profile-session-isolation", async entry => {
    entry.checked = [];
    for (const task of report.tasks.filter(task => task.sessionId)) {
      const owner = browsers.find(browser => browser.name === task.browser);
      const own = await snapshot(owner, task.sessionId); assert.equal(own.sessionId, task.sessionId);
      for (const other of browsers.filter(browser => browser !== owner)) {
        await snapshot(other, task.sessionId).then(outside => {
          assert.equal(outside.session, null); assert.equal(outside.transcript.length, 0); assert.equal(outside.hasHistory, false);
        }, error => assert.match(error.message, /not.found|unknown|missing|不存在/i));
        const listed = await mcp(other, "qingzhou_list_sessions", { limit: 100 }); assert.ok(!listed.sessions.some(session => session.id === task.sessionId));
      }
      entry.checked.push({ sessionId: task.sessionId, clientId: owner.uuid });
    }
  });
  report.phase = "completed"; report.ok = report.tasks.length === selected.length && report.tasks.every(task => task.ok) && report.scenarios.every(item => item.ok);
} catch (error) { report.phase = "failed"; report.failures.push({ stage: "runner", error: redact(error.stack || error.message) }); }
finally {
  clearInterval(heartbeat);
  for (const child of children) child.kill("SIGTERM");
  const cleanupErrors = [];
  for (const browser of browsers) {
    for (const sessionId of browser.sessions || []) await mcp(browser, "qingzhou_stop_session", { sessionId }).catch(() => {});
    await closeMcp(browser); await browser.stop().catch(error => cleanupErrors.push(error.message));
    await save(`${browser.name}/browser.json`, { uuid: browser.uuid, logs: browser.logs, crashes: browser.crashes, network: browser.network, diagnostics: browser.diagnostics });
  }
  await bridge?.close().catch(error => cleanupErrors.push(error.message));
  await Promise.allSettled([...pendingWrites]);
  // Chrome writes netlogs itself. Remove known credentials before retaining those files.
  for (const browser of browsers) for (const filename of await readdir(join(output, browser.name))) {
    if (filename.endsWith("-netlog.json")) { const path = join(output, browser.name, filename); await writeFile(path, redact(await readFile(path, "utf8")), { mode: 0o600 }); }
  }
  await rm(directory, { recursive: true, force: true }).catch(error => cleanupErrors.push(error.message));
  report.cleanup = { succeeded: cleanupErrors.length === 0, errors: cleanupErrors, profilesRemoved: true, userChromeOrDaemonTouched: false };
  report.finishedAt = new Date().toISOString(); if (cleanupErrors.length || interrupted) report.ok = false;
  await persist(); progress("finished", { ok: report.ok, passed: report.tasks.filter(task => task.ok).length, tasks: report.tasks.length });
  if (!report.ok) process.exitCode = 1;
}

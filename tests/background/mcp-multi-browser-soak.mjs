import assert from "node:assert/strict";
import "tsx";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { EXTENSION_PATH, PROJECT_ROOT, saveExtensionLlmConfig } from "../support/isolated-extension-mcp.mjs";
import { independentChrome, stopExtensionWorker, until } from "../support/independent-chrome.mjs";
import { multiBrowserFixture } from "../support/multi-browser-fixture.mjs";

const { createSessionRecord } = await import("../../src/shared/session/session-codec.ts");

// Manual entry: five minutes minimum, three OS processes and three isolated profiles. Never part of default CI.
const argument = process.argv.indexOf("--duration-seconds");
const duration = argument < 0 ? 300 : Number(process.argv[argument + 1]);
assert.ok(Number.isFinite(duration) && duration >= 300 && duration <= 3600);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(PROJECT_ROOT, "tests/results/multi-browser", stamp);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "qz-three-browsers-"));
const registryPath = join(directory, "browsers.json");
const report = { ok: false, startedAt: new Date().toISOString(), requestedDuration: duration, profiles: [],
  fixture: "Three real independent Chrome processes; real extension Agent, CLI and MCP. Local deterministic model and pages; no external provider or user sessions.",
  scenarios: [], trace: [], operations: [], health: [], cleanup: {} };
const browsers = [], children = new Set();
const fixture = await multiBrowserFixture();
let bridge, startTime, heartbeat;
function progress(stage, details = {}) { console.log(JSON.stringify({ stage, elapsedSeconds: startTime ? Math.round((Date.now() - startTime) / 1000) : 0, ...details })); }
async function persist() {
  await writeFile(join(output, "report.json"), JSON.stringify({ ...report, providerRequests: fixture.requests, pageRequests: fixture.pages,
    browsers: browsers.map(browser => ({ name: browser.name, uuid: browser.uuid, version: browser.version, launches: browser.launches, crashes: browser.crashes, logs: browser.logs })) }, null, 2));
}
async function startService(port = 0) {
  bridge = await startBridge({ port, registryPath, requestTimeoutSeconds: 30 });
  bridge.server.on("request", (request, response) => {
    if (!request.url.startsWith("/v1/qingzhou/")) return;
    const event = { at: Date.now(), path: request.url };
    report.trace.push(event);
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try {
        const value = JSON.parse(body);
        event.clientId = value.client?.id || value.clientId;
        event.connectionId = value.client?.connectionId || value.connectionId;
        event.requestId = value.requestId;
      } catch { /* The protocol handles malformed requests. */ }
    });
    const end = response.end;
    response.end = function (chunk, ...args) {
      try { const value = JSON.parse(String(chunk)); event.dispatched = value.requests?.map(item => ({ id: item.id, method: item.method })); }
      catch { /* Only JSON protocol metadata is recorded. */ }
      event.finishedAt = Date.now(); event.status = response.statusCode;
      return end.call(this, chunk, ...args);
    };
  });
}
async function settings(browser, type, payload = {}) {
  const page = await browser.panel();
  try { return await page.evaluate(message => chrome.runtime.sendMessage(message), { type, ...payload }); }
  finally { await page.close(); }
}
async function connect(browser) {
  const response = await settings(browser, "mcp_connection_connect", { endpoint: bridge.endpoint, name: browser.name });
  assert.equal(response.ok, true, JSON.stringify(response));
  await connected(browser);
  await browser.closeExtensionPages();
  await browser.detach();
}
async function screenshotSettings(browser) {
  const page = await browser.panel();
  try {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator("#btn-settings").click();
    await page.locator("#settings-tab-advanced").click();
    await page.locator("#cli-toggle").waitFor();
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(output, `actual-${browser.name}-${colorScheme}.png`), animations: "disabled" });
    }
  } finally { await page.close(); await browser.detach(); }
}
async function connected(browser) {
  return until(async () => (await readHealth(bridge.endpoint)).status.clients.find(client => client.clientId === browser.uuid), `${browser.name} connected`, 75000);
}
async function mcp(browser, name, args = {}) {
  const at = Date.now();
  try {
    const result = await callTool(bridge.endpoint, name, { ...args, clientId: browser.uuid, timeoutSeconds: 30 }, { timeoutMs: 45000 });
    report.operations.push({ at, channel: "mcp", client: browser.name, name, ok: true });
    return result;
  } catch (error) { report.operations.push({ at, channel: "mcp", client: browser.name, name, error: error.message }); throw error; }
}
async function cli(browser, args) {
  const at = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from './services/mcp-bridge/src/cli.mjs';
    import { readHealth } from './services/mcp-bridge/src/client.mjs';
    const endpoint = process.argv[1];
    process.exitCode = await main(process.argv.slice(2), { findDaemon: async () => { const health = await readHealth(endpoint); return { endpoint, instanceId: health.instanceId, health }; } });
  `, "--", bridge.endpoint, ...args, "--client", browser.name, "--json", "--timeout", "40"], { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  children.delete(child);
  report.operations.push({ at, channel: "cli", client: browser.name, name: args[0], code });
  assert.equal(code, 0, `${args.join(" ")}: ${stderr}\n${stdout}`);
  const value = JSON.parse(stdout);
  assert.equal(value.ok, true, JSON.stringify(value));
  return value.result;
}
// Compare the full persisted transcript. Live streamTraceId and absent/null defaults
// are normalized by the same codec used on Worker restoration; object key order is irrelevant.
function transcript(snapshot) { return createSessionRecord([], snapshot.transcript || []).transcript; }
async function round(browser, number) {
  const marker = `QZ_MULTI_${browser.name.toUpperCase()}_${number}_BROWSE`;
  const created = await cli(browser, ["create", `Read the test page and summarize it. [${marker}]`, "--title", marker, "--wait"]);
  const id = created.sessionId || created.session?.id;
  assert.ok(id); browser.sessions.add(id);
  assert.equal(created.snapshot.status, "completed", JSON.stringify(created.snapshot));
  assert.ok(JSON.stringify(transcript(created.snapshot)).includes(marker));
  const followed = await mcp(browser, "qingzhou_send_message", { sessionId: id, text: `[${marker.replace("BROWSE", "FOLLOW")}] Summarize in one line.`, wait: true });
  assert.equal(followed.snapshot.status, "completed");
  const content = JSON.stringify(transcript(followed.snapshot));
  assert.ok(content.includes(marker.replace("BROWSE", "FOLLOW")));
  for (const other of browsers.filter(item => item !== browser)) {
    assert.ok(!content.includes(`QZ_MULTI_${other.name.toUpperCase()}_`), "cross-profile transcript contamination");
  }
  const tabs = await mcp(browser, "qingzhou_execute_tool", { sessionId: id, name: "list_tabs", args: {}, wait: true });
  const list = Array.isArray(tabs.result) ? tabs.result : tabs.result?.tabs || [];
  for (const tab of list.filter(item => item.url?.startsWith(fixture.endpoint))) {
    await mcp(browser, "qingzhou_execute_tool", { sessionId: id, name: "close_tab", args: { tabId: tab.id }, wait: true });
  }
  browser.histories.set(id, transcript(await mcp(browser, "qingzhou_get_session_snapshot", { sessionId: id, compact: false, tail: false, includeArtifacts: false })));
}
async function scenario(name, work) {
  const at = Date.now(); progress(name);
  await work(); report.scenarios.push({ name, at, durationMs: Date.now() - at, ok: true }); await persist();
}
try {
  await startService();
  report.endpoint = bridge.endpoint;
  for (const name of ["default", "research", "work"]) {
    const browser = await independentChrome({ name, profile: join(directory, name), extensionPath: EXTENSION_PATH, outputDirectory: output });
    browsers.push(browser); browser.sessions = new Set(); browser.histories = new Map();
    const page = await browser.panel();
    await acceptDataDisclosure(page, { disableBridge: false });
    await saveExtensionLlmConfig(page, fixture.config);
    const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "mcp_connection_status" }));
    assert.equal(state.result.state, "disconnected"); browser.uuid = state.result.clientId;
    const requestsBefore = browser.requests.length;
    await delay(1500);
    assert.equal(browser.requests.length, requestsBefore, "opening settings/status on a disabled extension must not probe localhost");
    await page.close();
    if (name === "default") {
      let opened = 0;
      const result = await runCli(["connect", "--timeout", "30"], {
        ensureDaemon: async () => ({ endpoint: bridge.endpoint, instanceId: bridge.instanceId, health: await readHealth(bridge.endpoint) }),
        openBrowser: async url => { opened++; const page = await browser.context.newPage(); await page.goto(url); },
      });
      assert.equal(result.result.connected, true); assert.equal(opened, 1);
      await connected(browser);
      const again = await runCli(["connect"], { ensureDaemon: async () => ({ endpoint: bridge.endpoint, instanceId: bridge.instanceId, health: await readHealth(bridge.endpoint) }),
        openBrowser: () => assert.fail("repeat connect must not reopen the browser") });
      assert.equal(again.result.connected, true);
      await browser.closeExtensionPages(); await browser.detach();
    } else await connect(browser);
    browser.initialSessions = new Set((await mcp(browser, "qingzhou_list_sessions", { limit: 500 })).sessions.map(session => session.id));
    await screenshotSettings(browser);
    report.profiles.push({ name, uuid: browser.uuid, version: browser.version });
  }
  assert.equal(new Set(browsers.map(browser => browser.uuid)).size, 3);
  assert.equal((await readHealth(bridge.endpoint)).status.clientCount, 3);
  assert.ok(!JSON.stringify(await readHealth(bridge.endpoint)).includes("pairingToken"));
  await assert.rejects(callTool(bridge.endpoint, "qingzhou_list_sessions", {}), /select|multiple|client|browser/i);
  startTime = Date.now();
  heartbeat = setInterval(() => progress("heartbeat", { operations: report.operations.length }), 30000);
  await scenario("concurrent-tasks-and-followups", () => Promise.all(browsers.map(browser => round(browser, 0))));
  await scenario("disconnect-one-other-profiles-continue", async () => {
    const browser = browsers[1];
    assert.equal((await settings(browser, "mcp_connection_disconnect")).ok, true);
    await browser.closeExtensionPages(); await browser.detach();
    const disconnectedAt = Date.now();
    await assert.rejects(callTool(bridge.endpoint, "qingzhou_list_sessions", { clientId: browser.uuid }), /offline|disconnected|not.*connect/i);
    await Promise.all([round(browsers[0], 1), round(browsers[2], 1)]);
    assert.equal(report.trace.filter(event => event.at > disconnectedAt && event.clientId === browser.uuid && /poll|pair/.test(event.path)).length, 0);
    await connect(browser);
  });
  await scenario("service-restart-with-closed-panels-and-detached-debuggers", async () => {
    const port = Number(new URL(bridge.endpoint).port);
    await bridge.close(); await delay(500); await startService(port);
    await Promise.all(browsers.map(connected));
    assert.equal((await readHealth(bridge.endpoint)).status.browsers.length, 3);
  });
  await scenario("worker-restart-without-debugger-keepalive", async () => {
    report.workerStop = await stopExtensionWorker(browsers[1]);
    const at = Date.now();
    await until(() => report.trace.some(event => event.at > at && event.path.endsWith("/pair") && event.clientId === browsers[1].uuid && event.status === 200), "new worker reconnects", 95000);
    await connected(browsers[1]);
  });
  await scenario("whole-chrome-restart-without-opening-extension-pages", async () => {
    const browser = browsers[2];
    await browser.stop(); await browser.start({ attachDebugger: false });
    const at = Date.now();
    await until(() => report.trace.some(event => event.at >= at && event.path.endsWith("/pair") && event.clientId === browser.uuid && event.status === 200), "Chrome restart reconnects", 95000);
    await connected(browser);
  });
  let count = 2;
  while (Date.now() - startTime < duration * 1000) {
    await scenario(`concurrent-round-${count}`, () => Promise.all(browsers.map(browser => round(browser, count))));
    if (count % 2 === 0) await scenario(`reconnect-${count}`, async () => {
      await settings(browsers[1], "mcp_connection_disconnect"); await connect(browsers[1]);
    });
    report.health.push({ at: Date.now(), ...(await readHealth(bridge.endpoint)).status });
    count++; await delay(1000);
  }
  report.measuredDurationMs = Date.now() - startTime;
  await scenario("inventory-over-default-limit-and-history-integrity", async () => {
    const browser = browsers[0];
    while (browser.sessions.size < 105) {
      const created = await mcp(browser, "qingzhou_create_session", { title: `inventory-${browser.sessions.size}` });
      browser.sessions.add(created.session.id);
    }
    for (const browser of browsers) {
      // list_sessions has a documented 500 cap and defaults to 100; this fixture remains below the cap.
      assert.ok(browser.sessions.size < 500);
      const inventory = await mcp(browser, "qingzhou_list_sessions", { limit: 500 });
      const expected = [...new Set([...browser.initialSessions, ...browser.sessions])].sort();
      const actual = inventory.sessions.map(session => session.id).sort();
      assert.deepEqual(actual, expected);
      for (const [sessionId, expectedHistory] of browser.histories) {
        const snapshot = await mcp(browser, "qingzhou_get_session_snapshot", { sessionId, compact: false, tail: false, includeArtifacts: false });
        assert.deepEqual(transcript(snapshot), expectedHistory, `${browser.name} ${sessionId} history must survive reconnection`);
      }
    }
    const status = (await readHealth(bridge.endpoint)).status;
    assert.equal(status.pending, 0); assert.equal(status.inflight, 0);
    report.finalInventory = browsers.map(browser => ({ name: browser.name, sessions: browser.sessions.size, histories: browser.histories.size }));
  });
  assert.equal(browsers.flatMap(browser => browser.crashes).length, 0);
  report.ok = true;
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  // Preserve evidence before stopping processes. Timeouts are failures, never extended/retried here.
  report.failureHealth = await readHealth(bridge.endpoint).catch(error => ({ error: error.message }));
  for (const browser of browsers) {
    try { await browser.attach(); for (const [i, page] of browser.context.pages().entries()) await page.screenshot({ path: join(output, `failure-${browser.name}-${i}.png`) }); }
    catch (error) { report.cleanup[`capture-${browser.name}`] = error.message; }
  }
  await persist(); console.error(report.error);
} finally {
  clearInterval(heartbeat);
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(browsers.map(async browser => {
    await browser.stop();
    for (const launch of browser.launches) {
      const netlog = JSON.parse(await readFile(launch.netLog, "utf8"));
      const unexpected = netlog.events.filter(event => /http:\/\/(?:127\.0\.0\.1|localhost):18765(?:\/|$)/.test(String(event.params?.url || "")));
      if (unexpected.length) { report.ok = false; process.exitCode = 1; report.cleanup.defaultPortRequests = unexpected.length; }
    }
  }));
  await bridge?.close(); await fixture.close();
  await rm(directory, { recursive: true, force: true });
  report.cleanup.processesStopped = browsers.every(browser => browser.child.exitCode !== null || browser.child.signalCode !== null);
  report.cleanup.temporaryDirectoryRemoved = true;
  report.finishedAt = new Date().toISOString(); await persist();
  progress("finished", { ok: report.ok, report: join(output, "report.json") });
}

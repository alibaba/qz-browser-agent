import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { callTool, readHealth } from "../../services/mcp-bridge/src/client.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { EXTENSION_PATH, PROJECT_ROOT, saveExtensionLlmConfig } from "../support/isolated-extension-mcp.mjs";
import { independentChrome, until } from "../support/independent-chrome.mjs";
import { multiBrowserFixture } from "../support/multi-browser-fixture.mjs";

// Manual entry: two real Chrome profiles with a deterministic model, plus explicit storage faults.
// Pairing credentials remain in memory and the owned temporary profiles/registry only.
const KEY = "_qingzhou_mcp_bridge", ID = "_qingzhou_mcp_bridge_client_id";
const output = join(PROJECT_ROOT, "tests/results/multi-browser", `pairing-edges-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "qz-pairing-edges-"));
const registryPath = join(temporary, "browsers.json");
const report = { ok: false, startedAt: new Date().toISOString(), scenarios: [], trace: [], cleanup: {},
  evidence: "Real independent Chrome processes, packaged extension, runtime messages, MCP and browser tasks. The model and web pages are deterministic local fixtures.",
  injectedFaults: ["Copy only the two bridge identity storage keys from A to B to simulate a copied profile.", "Reject registry.persist during B's explicit rename; this simulates a disk write failure, not an actual full disk.", "Drop the successful dedicated rename response after the real service has committed it; the next real poll must reconcile the extension's name."],
};
const browsers = [], secrets = new Set();
let fixture, bridge, originalPersist;
const clean = value => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  return text;
};
async function persist() {
  await writeFile(join(output, "report.json"), clean({ ...report,
    modelRequests: fixture?.requests, pageRequests: fixture?.pages,
    browsers: browsers.map(browser => ({ name: browser.name, uuid: browser.uuid, version: browser.version,
      launches: browser.launches.map(({ netLog: _netLog, ...launch }) => launch), crashes: browser.crashes })),
  }));
}
async function scenario(name, run) {
  const entry = { name, startedAt: new Date().toISOString() }; report.scenarios.push(entry);
  console.log(JSON.stringify({ stage: name, output }));
  try { Object.assign(entry, await run(), { ok: true }); }
  catch (error) { entry.ok = false; entry.error = error.stack; throw error; }
  finally { entry.finishedAt = new Date().toISOString(); await persist(); }
}
function recordProtocol() {
  bridge.server.on("request", (request, response) => {
    if (!request.url.startsWith("/v1/qingzhou/")) return;
    const entry = { at: Date.now(), path: request.url }; report.trace.push(entry);
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body), identity = parsed.client || parsed;
        entry.clientId = identity.id || identity.clientId; entry.connectionId = identity.connectionId;
      } catch { /* The protocol owns malformed input errors. */ }
      body = "";
    });
    const end = response.end;
    response.end = function (chunk, ...args) {
      try { const parsed = JSON.parse(String(chunk)); entry.code = parsed.code; entry.name = parsed.name; }
      catch { /* Only pairing status fields are retained. */ }
      entry.status = response.statusCode; entry.finishedAt = Date.now();
      return end.call(this, chunk, ...args);
    };
  });
}
async function settings(browser, type, payload = {}) {
  return browser.page.evaluate(message => chrome.runtime.sendMessage(message), { type, ...payload });
}
async function connection(browser, name = browser.name) {
  const response = await settings(browser, "mcp_connection_connect", { endpoint: bridge.endpoint, name });
  assert.equal(response.ok, true, "settings connection request must return its public status");
  return response.result;
}
async function identityKeys(browser) {
  const value = await browser.page.evaluate(keys => chrome.storage.local.get(keys), [KEY, ID]);
  secrets.add(value[KEY]?.pairingToken);
  return value;
}
async function ping(browser) {
  await callTool(bridge.endpoint, "qingzhou_call", { method: "ping", clientId: browser.uuid, timeoutSeconds: 10 }, { timeoutMs: 15000 });
}
async function task(browser, number) {
  const marker = `QZ_MULTI_ALPHA_${number}_BROWSE`;
  const created = await callTool(bridge.endpoint, "qingzhou_create_session", {
    title: marker, firstMessage: `Read the test page and summarize it. [${marker}]`, clientId: browser.uuid,
    wait: true, waitTimeoutSeconds: 45, timeoutSeconds: 15,
  }, { timeoutMs: 50000 });
  assert.equal(created.snapshot.status, "completed");
  assert.ok(JSON.stringify(created.snapshot.transcript).includes(marker));
  assert.ok(fixture.pages.some(page => page.marker === marker), "the task must load the actual fixture page");
  assert.ok(browser.context.pages().some(page => page.url().includes(marker)), "the healthy browser owns the task page");
  assert.ok(browsers.filter(item => item !== browser).every(item => item.context.pages().every(page => !page.url().includes(marker))), "the other profile must not receive the task page");
  return { sessionId: created.sessionId || created.session?.id, status: created.snapshot.status, marker };
}
try {
  fixture = await multiBrowserFixture();
  bridge = await startBridge({ port: 0, registryPath, requestTimeoutSeconds: 15 });
  recordProtocol(); report.endpoint = bridge.endpoint;
  for (const name of ["default", "research"]) {
    const browser = await independentChrome({ name, profile: join(temporary, name), extensionPath: EXTENSION_PATH, outputDirectory: output });
    browsers.push(browser); browser.page = await browser.panel();
    await acceptDataDisclosure(browser.page, { disableBridge: false });
    await saveExtensionLlmConfig(browser.page, fixture.config);
    const before = await settings(browser, "mcp_connection_status");
    assert.equal(before.result.state, "disconnected"); browser.uuid = before.result.clientId;
    const connected = await connection(browser); assert.equal(connected.state, "connected");
    await identityKeys(browser);
  }
  const [a, b] = browsers;
  assert.notEqual(a.uuid, b.uuid);
  const owner = bridge.state.clients.get(a.uuid);
  assert.ok(owner?.connectionId);
  const assertOwner = () => {
    assert.equal(bridge.state.clients.get(a.uuid), owner, "A's healthy connection must retain its exact owner");
    assert.ok(bridge.state.liveClients().includes(owner));
    assert.equal(bridge.state.registry.get(a.uuid).name, "default");
  };
  await settings(b, "mcp_connection_disconnect");
  const originalB = await identityKeys(b);
  assert.equal(originalB[KEY].enabled, false);

  await scenario("duplicate-name-rejected-with-healthy-owner-unchanged", async () => {
    const result = await connection(b, "default");
    assert.equal(result.state, "paused"); assert.equal(result.lastError.code, "BRIDGE_NAME_IN_USE");
    assert.equal(bridge.state.registry.get(b.uuid).name, "research");
    assertOwner(); await ping(a);
    return { rejectedCode: result.lastError.code, healthyTask: await task(a, 1) };
  });

  await scenario("copied-profile-identity-cannot-replace-a-healthy-worker", async () => {
    const copied = await identityKeys(a), at = Date.now();
    await b.page.evaluate(values => chrome.storage.local.set(values), copied);
    const rejected = await until(() => report.trace.find(entry => entry.at >= at && entry.path.endsWith("/pair")
      && entry.clientId === a.uuid && entry.connectionId !== owner.connectionId && entry.code === "BRIDGE_CLIENT_IN_USE"), "copied profile's distinct worker rejected", 75000);
    assertOwner(); await ping(a);
    const healthyTask = await task(a, 2);
    // Stop the copied authorization locally; the mismatched worker cannot disconnect A.
    await settings(b, "mcp_connection_disconnect"); assertOwner();
    await b.page.evaluate(values => chrome.storage.local.set(values), originalB);
    assert.equal((await settings(b, "mcp_connection_status")).result.clientId, b.uuid);
    assert.equal((await connection(b)).state, "connected"); await ping(b); assertOwner();
    return { rejectedCode: rejected.code, distinctWorker: rejected.connectionId !== owner.connectionId, healthyTask, restoredBrowser: b.uuid };
  });

  await scenario("registry-write-failure-does-not-acknowledge-rename-or-affect-other-browsers", async () => {
    const bytesBefore = await readFile(registryPath, "utf8");
    const priorConnection = bridge.state.clients.get(b.uuid);
    originalPersist = bridge.state.registry.persist;
    bridge.state.registry.persist = async () => { throw new Error("Injected registry write failure"); };
    const result = await settings(b, "mcp_connection_connect", { endpoint: bridge.endpoint, name: "research-renamed" });
    assert.equal(result.ok, false); assert.equal(result.code, "BRIDGE_REGISTRY_WRITE_FAILED");
    const local = (await settings(b, "mcp_connection_status")).result;
    assert.equal(local.state, "connected"); assert.equal(local.name, "research");
    assert.equal(bridge.state.clients.get(b.uuid), priorConnection, "failed rename preserves the current healthy lease");
    assert.equal(bridge.state.registry.get("research-renamed"), undefined);
    assert.equal(bridge.state.registry.get(b.uuid).name, "research");
    assert.equal(await readFile(registryPath, "utf8"), bytesBefore, "failed persistence leaves prior registry bytes intact");
    assertOwner(); await Promise.all([ping(a), ping(b)]);
    const healthyTask = await task(a, 3);
    const unchangedBrowserTask = await task(b, 4);
    bridge.state.registry.persist = originalPersist; originalPersist = undefined;
    assert.equal((await connection(b, "research-renamed")).state, "connected");
    assert.equal(bridge.state.registry.get(b.uuid).name, "research-renamed");
    await ping(b); assertOwner();
    return { injectedFailure: true, rejectedCode: result.code, healthyTask, unchangedBrowserTask, recoveredName: "research-renamed" };
  });

  await scenario("lost-rename-ack-converges-through-real-poll", async () => {
    const nextName = "research-recovered", priorConnection = bridge.state.clients.get(b.uuid);
    let dropped = 0;
    const discardAck = (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/qingzhou/rename") return;
      const end = response.end;
      response.end = function (chunk, ...args) {
        let value;
        try { value = JSON.parse(String(chunk)); } catch { /* Preserve error and non-JSON responses. */ }
        // Chrome can transparently retry an HTTP request after a closed keep-alive socket.
        // Drop every successful acknowledgment for this one rename, including those retries.
        if (response.statusCode === 200 && value?.name === nextName) {
          dropped++;
          report.trace.push({ at: Date.now(), path: request.url, injectedFault: "drop-successful-response", clientId: b.uuid, name: nextName });
          response.destroy();
          return this;
        }
        return end.call(this, chunk, ...args);
      };
    };
    bridge.server.on("request", discardAck);
    try {
      const reply = await settings(b, "mcp_connection_connect", { endpoint: bridge.endpoint, name: nextName });
      assert.ok(dropped >= 1, "the service must reach its successful dedicated rename response");
      assert.equal(reply.ok, false, "the extension must not claim it received the discarded response");
      assert.equal(bridge.state.registry.get(b.uuid).name, nextName);
      assert.equal(bridge.state.clients.get(b.uuid), priorConnection, "rename keeps the same live connection");
      const local = await until(async () => {
        const value = (await settings(b, "mcp_connection_status")).result;
        return value.name === nextName && value.state === "connected" && value;
      }, "canonical name from the next real poll", 45000);
      await Promise.all([ping(a), ping(b)]); assertOwner();
      return { successfulAcknowledgmentsDropped: dropped, recoveredName: local.name, healthyTask: await task(b, 5) };
    } finally {
      bridge.server.off("request", discardAck);
    }
  });
  report.finalStatus = (await readHealth(bridge.endpoint)).status;
  assert.equal(report.finalStatus.clientCount, 2);
  assert.equal(JSON.stringify(report.finalStatus).includes("pairingToken"), false);
  assert.equal(browsers.flatMap(browser => browser.crashes).length, 0);
  report.ok = true;
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  console.error(clean({ error: report.error }));
} finally {
  if (originalPersist && bridge) bridge.state.registry.persist = originalPersist;
  for (const browser of browsers) {
    try {
      await browser.stop();
      for (const launch of browser.launches) {
        const netlog = JSON.parse(await readFile(launch.netLog, "utf8"));
        const unexpected = netlog.events.filter(event => /http:\/\/(?:127\.0\.0\.1|localhost):18765(?:\/|$)/.test(String(event.params?.url || "")));
        assert.equal(unexpected.length, 0, "isolated profiles must not contact the user's default service");
        // Keep only the safe request metadata collected above, never full HTTP capture.
        await rm(launch.netLog, { force: true });
      }
    } catch (error) { report.ok = false; process.exitCode = 1; report.cleanup[browser.name] = error.message; }
  }
  await bridge?.close(); await fixture?.close();
  await rm(temporary, { recursive: true, force: true });
  report.cleanup.processesStopped = browsers.every(browser => browser.child.exitCode !== null || browser.child.signalCode !== null);
  report.cleanup.temporaryProfilesAndRegistryRemoved = true;
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ stage: "finished", ok: report.ok, report: join(output, "report.json") }));
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { readHealth } from "../../services/mcp-bridge/src/client.mjs";
import { buildExtension } from "../../scripts/build-extension.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";
import { independentChrome, until } from "../support/independent-chrome.mjs";
import { multiBrowserFixture } from "../support/multi-browser-fixture.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const output = join(root, "tests/results/multi-browser", `settings-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const temporary = await mkdtemp(join(tmpdir(), "qz-connection-settings-"));
await mkdir(output, { recursive: true });
const report = { ok: false, startedAt: new Date().toISOString(), buildMode: "production", language: "zh-CN", screenshots: [], cleanup: {},
  limitations: ["Real current extension, Chrome, CLI and MCP; deterministic local model responses and test pages replace a paid provider.", "CLI daemon discovery is scoped to the test service; no user service is started or stopped."] };
let fixture, bridge, browser, page;
const runtime = (type, payload = {}) => page.evaluate(message => chrome.runtime.sendMessage(message), { type, ...payload });
async function capture(scene) {
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const filename = `actual-settings-${scene}-${colorScheme}.png`;
    await page.screenshot({ path: join(output, filename), animations: "disabled" });
    report.screenshots.push(filename);
  }
}
try {
  console.log(JSON.stringify({ stage: "build-current-extension", output }));
  const extension = await buildExtension({ mode: "production", outputDir: join(temporary, "extension") });
  process.env.QINGZHOU_TEST_EXTENSION_DIR = extension.outputDir;
  const { saveExtensionLlmConfig } = await import("../support/isolated-extension-mcp.mjs");
  fixture = await multiBrowserFixture();
  bridge = await startBridge({ port: 0, scopeId: "connection-settings", registryPath: join(temporary, "browsers.json"), requestTimeoutSeconds: 15 });
  browser = await independentChrome({ name: "settings", profile: join(temporary, "profile"), extensionPath: extension.outputDir, outputDirectory: output });
  page = await browser.panel();
  await acceptDataDisclosure(page, { disableBridge: false });
  await saveExtensionLlmConfig(page, fixture.config);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator("#btn-settings").click(); await page.locator("#settings-tab-advanced").click();
  await page.locator("#i18n-language-select").selectOption("zh-CN");
  await Promise.all([page.waitForEvent("domcontentloaded"), page.locator("#btn-save-settings").click()]);
  await page.locator("#btn-settings").click(); await page.locator("#settings-tab-advanced").click();
  await until(async () => !(await page.locator("#cli-toggle").isDisabled()), "settings local status response");
  assert.equal(await page.locator("#cli-name-label").textContent(), "浏览器标识");
  assert.equal(await page.locator("#cli-status").textContent(), "");
  assert.equal((await readHealth(bridge.endpoint)).status.clientCount, 0);
  await capture("disconnected");
  const allowHint = page.locator("#guardrail-allow-hint");
  assert.equal(await allowHint.isVisible(), false);
  await page.locator("#guardrail-rule-action").selectOption("allow");
  assert.equal(await allowHint.isVisible(), true);
  await allowHint.scrollIntoViewIfNeeded(); await capture("allow-rule");
  await page.locator("#guardrail-rule-action").selectOption("block");
  assert.equal(await allowHint.isVisible(), false);
  report.allowHint = { visibleForAllow: true, hiddenForBlock: true };

  await page.locator("#cli-toggle").click();
  assert.equal(await page.locator("#cli-name").inputValue(), "");
  assert.equal(await page.locator("#cli-name").getAttribute("placeholder"), "供 CLI 选择，例如 work");
  assert.equal(await page.locator("#cli-name-example, #cli-name-hint").count(), 0);
  await capture("naming");
  await page.locator("#cli-name").fill("work");
  // Close an owned ephemeral service to obtain a real unavailable endpoint.
  const unavailable = await startBridge({ port: 0, scopeId: "settings-unavailable", registryPath: join(temporary, "unavailable-browsers.json") });
  const unavailableEndpoint = unavailable.endpoint; await unavailable.close();
  await page.locator("#cli-address-details summary").click(); await page.locator("#cli-address").fill(unavailableEndpoint);
  await page.locator("#cli-submit").click();
  await until(async () => !(await page.locator("#cli-submit").isDisabled()) && Boolean(await page.locator("#cli-popover-status").textContent()), "unavailable service shown in settings");
  assert.equal(await page.locator("#cli-name").inputValue(), "work");
  assert.equal(await page.locator("#cli-address").inputValue(), unavailableEndpoint);
  assert.ok((await page.locator("#cli-start-command").textContent()).includes(`--port ${new URL(unavailableEndpoint).port}`));
  await capture("unavailable");

  await page.locator("#cli-address").fill(bridge.endpoint); await page.locator("#cli-submit").click();
  await until(async () => (await runtime("mcp_connection_status")).result.state === "connected", "settings connects real service");
  await until(async () => (await page.locator("#cli-toggle").textContent()).includes("work"), "UI broadcasts connected identifier");
  await until(async () => !(await page.locator("#cli-connect-popover").isVisible()), "connected naming popover closes");
  await capture("connected");

  const locate = async () => {
    const health = await readHealth(bridge.endpoint);
    return { endpoint: bridge.endpoint, instanceId: health.instanceId, health };
  };
  const dependencies = { findDaemon: locate, ensureDaemon: locate, openBrowser: () => assert.fail("a connected browser must be reused") };
  assert.equal((await runCli(["connect", "--client", "work", "--timeout", "10"], dependencies)).result.connected, true);
  const marker = "QZ_MULTI_SETTINGS_0_BROWSE";
  const result = (await runCli(["create", `Read the fixture page. [${marker}]`, "--client", "work", "--wait", "--timeout", "45"], dependencies)).result;
  assert.equal(result.snapshot.status, "completed", JSON.stringify(result));
  assert.ok(JSON.stringify(result.snapshot.transcript).includes(marker));
  assert.ok(fixture.pages.some(request => request.marker === marker), "real browser must load the fixture page");
  report.task = { sessionId: result.sessionId || result.session?.id, status: result.snapshot.status, marker };

  await page.locator("#cli-toggle").click();
  await until(async () => (await runtime("mcp_connection_status")).result.state === "disconnected", "settings disconnects immediately");
  const saved = (await runtime("mcp_connection_status")).result;
  assert.equal(saved.name, "work"); assert.equal(saved.endpoint, bridge.endpoint);
  await until(async () => (await readHealth(bridge.endpoint)).status.clientCount === 0, "service releases the disconnected browser");
  report.settingsActions = ["local-status", "failed-connect-preserves-input", "connect", "disconnect"];
  report.preservedName = saved.name;
  report.ok = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png"), animations: "disabled" }).catch(() => {});
} finally {
  report.modelRequests = fixture?.requests || []; report.pageRequests = fixture?.pages || [];
  report.browser = browser && { version: browser.version, extensionId: browser.extensionId, launches: browser.launches, crashes: browser.crashes };
  await browser?.stop().catch(error => { report.cleanup.browserError = error.message; });
  await bridge?.close().catch(error => { report.cleanup.serviceError = error.message; });
  await fixture?.close().catch(error => { report.cleanup.fixtureError = error.message; });
  await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); report.cleanup.temporaryRemoved = true;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, error: report.error }));
}

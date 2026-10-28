// Real MV3 worker persistence; no model/provider or user profile. Build --no-bundle.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installProbes, launchMeasurement, rssSample, sleep, summarizeRss } from "./image-history-measurement.mjs";
const { values } = parseArgs({ options: {
  extension: { type: "string", default: "dist/extension" }, output: { type: "string", default: "tests/results/chromium-image-history.json" },
  turns: { type: "string", default: "60" }, interval: { type: "string", default: "1000" },
} });
const extensionDir = resolve(values.extension), output = resolve(values.output), profile = output + ".profile";
const turns = Number(values.turns), interval = Number(values.interval);
await mkdir(dirname(output), { recursive: true });
await rm(profile, { recursive: true, force: true });
const uninstall = await installProbes(extensionDir);
const report = { extensionDir, turns, intervalMs: interval, samples: [], turnsCompleted: [], verification: {} };
let driver, timer, currentTurn = 0;
try {
  driver = await launchMeasurement({ browser: "chromium", extensionDir, profile });
  report.version = driver.version;
  report.workerUrls = driver.context.serviceWorkers().map(worker => worker.url());
  await driver.evaluate("background", "return await view.imageMemoryProbe.initialize();");
  await sleep(1500);
  const take = () => report.samples.push(rssSample("chromium", driver.rootPid, currentTurn));
  take(); timer = setInterval(take, 250);
  for (let turn = 1; turn <= turns; turn++) {
    const start = performance.now();
    const result = await driver.evaluate("background", `return await view.imageMemoryProbe.turn(${turn});`);
    currentTurn = turn;
    report.turnsCompleted.push({ ...result, elapsedMs: performance.now() - start });
    await sleep(Math.max(0, interval - (performance.now() - start)));
    if (turn % 10 === 0) {
      take(); console.log(JSON.stringify({ turn, rss: report.samples.at(-1).buckets }));
      await writeFile(output, JSON.stringify(report, null, 2));
    }
  }
  report.activeRss = summarizeRss(report.samples);
  await driver.evaluate("background", "return await view.imageMemoryProbe.finish();");
  await sleep(5000); clearInterval(timer); timer = null; take();
  report.rss = summarizeRss(report.samples);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log("PHASE persistence_complete", JSON.stringify(report.rss));
  await driver.openUI();
  report.verification.beforeRestart = await driver.open("firefox-image-memory-proxy", turns);
  await driver.close(); driver = null;
  driver = await launchMeasurement({ browser: "chromium", extensionDir, profile });
  report.verification.agent = await driver.evaluate("background", "return await view.imageMemoryProbe.restore();");
  assert.deepEqual(report.verification.agent, { images: turns, identical: true, inline: true });
  await driver.openUI();
  report.verification.afterRestart = await driver.open("firefox-image-memory-proxy", turns);
  report.verification.export = await driver.evaluate("sidebar", "return await view.imageMemorySidebarProbe.export();");
  assert.equal(report.verification.export.images, turns);
  assert.equal(report.verification.export.conversationImages, turns);
  assert.equal(report.verification.export.inline, true);
  assert.equal(report.verification.export.hasHistoryReferences, false);
  report.ok = true;
  console.log("CHROMIUM_IMAGE_MEMORY", JSON.stringify({ rss: report.rss, verification: report.verification }));
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  clearInterval(timer);
  await driver?.close().catch(() => {});
  await uninstall();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}

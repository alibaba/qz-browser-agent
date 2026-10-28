// Click-to-all-images-decoded, warm switches and first opens after full restart.
// Cold means browser/extension caches are cold, not an OS filesystem-cache flush.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installProbes, launchMeasurement, sleep, statistics } from "./image-history-measurement.mjs";
const { values } = parseArgs({ options: {
  browser: { type: "string", default: "chromium" }, extension: { type: "string" },
  output: { type: "string", default: "tests/results/session-open-speed.json" },
  counts: { type: "string", default: "10,30,60" }, runs: { type: "string", default: "5" },
  "reuse-profile": { type: "string" }, modes: { type: "string", default: "warm,cold" },
  "trace-readers": { type: "boolean", default: false }, "settle-ms": { type: "string", default: "2000" },
} });
const browser = values.browser, extensionDir = resolve(values.extension), output = resolve(values.output);
const profile = values["reuse-profile"] ? resolve(values["reuse-profile"]) : output + ".profile";
const modes = values.modes.split(",");
const counts = values.counts.split(",").map(Number), runs = Number(values.runs), settleMs = Number(values["settle-ms"]);
await mkdir(dirname(output), { recursive: true });
if (!values["reuse-profile"]) await rm(profile, { recursive: true, force: true });
const uninstall = await installProbes(extensionDir);
const report = { browser, extensionDir, profile, reusedProfile: !!values["reuse-profile"], runs, counts, modes, settleMs, measurements: [] };
let driver, readerOriginal;
const readerPath = resolve(extensionDir, "shared/session/session-image-assets.js");
const launch = () => launchMeasurement({ browser, extensionDir, profile });
const blank = async () => { await driver.open("image-open-blank", 0); await sleep(150); };
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
try {
  if (values["trace-readers"]) {
    readerOriginal = await readFile(readerPath, "utf8");
    if (!readerOriginal.includes("async function resolveSessionImages(")) throw new Error("Reader tracing requires --no-bundle");
    await writeFile(readerPath, readerOriginal.replace("async function resolveSessionImages(", "async function measuredResolveSessionImages(") + `
async function resolveSessionImages(...args) {
  const start = performance.now(), sequence = globalThis.__imageOpenSequence;
  try { return await measuredResolveSessionImages(...args); }
  finally {
    const timings = globalThis.__imageReadTimings ||= [];
    if (timings.length < 1000) timings.push({ start, elapsedMs: performance.now() - start, sequence,
      superseded: sequence !== globalThis.__imageOpenSequence, keys: Object.keys(args[0] || {}) });
  }
}
`);
  }
  driver = await launch(); report.version = driver.version;
  if (!values["reuse-profile"]) {
    await driver.evaluate("background", 'return await view.imageMemoryProbe.initialize("image-open-source");');
    for (let turn = 1; turn <= Math.max(...counts); turn++) {
      await driver.evaluate("background", `return await view.imageMemoryProbe.turn(${turn});`);
      if (counts.includes(turn)) await driver.evaluate("background", `return await view.imageMemoryProbe.saveAs("image-open-${turn}");`);
    }
    await driver.evaluate("background", 'await view.imageMemoryProbe.initialize("image-open-blank"); return await view.imageMemoryProbe.finish();');
  }
  await driver.openUI();
  if (modes.includes("warm")) for (const count of counts) {
    await blank();
    await driver.open(`image-open-${count}`, count); // Prime this Session for warm switches.
    await sleep(settleMs); // Keep prior background refreshes outside the next sample.
    const times = [];
    for (let run = 0; run < runs; run++) {
      await blank();
      const result = await driver.open(`image-open-${count}`, count);
      assert.equal(result.images, count); assert.equal(result.decoded, true);
      times.push(result.elapsedMs);
      await sleep(settleMs);
    }
    report.measurements.push({ count, mode: "warm", ...statistics(times) });
    console.log(JSON.stringify(report.measurements.at(-1))); await save();
  }
  if (modes.includes("cold")) for (const count of counts) {
    const times = [];
    for (let run = 0; run < runs; run++) {
      await blank();
      await driver.close(); driver = null;
      driver = await launch();
      await driver.openUI();
      await blank();
      const result = await driver.open(`image-open-${count}`, count);
      assert.equal(result.images, count); assert.equal(result.decoded, true);
      times.push(result.elapsedMs);
      console.log(JSON.stringify({ count, mode: "cold", run, elapsedMs: result.elapsedMs }));
    }
    report.measurements.push({ count, mode: "cold", ...statistics(times) });
    console.log(JSON.stringify(report.measurements.at(-1))); await save();
  }
  if (values["trace-readers"]) {
    await sleep(1000);
    report.readerTraces = await driver.evaluate("sidebar", "return view.__imageReadTimings || [];");
  }
  report.ok = true;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  await driver?.close().catch(() => {});
  if (readerOriginal !== undefined) await writeFile(readerPath, readerOriginal);
  await uninstall(); await save();
}

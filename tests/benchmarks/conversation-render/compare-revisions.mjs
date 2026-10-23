#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildExtension } from "../../../scripts/build-extension.mjs";
import { instrumentComparisonDriver } from "./comparison-preload.mjs";
import { MISSING_IMAGEMAGICK_REASON, imageMagickCommandAvailable } from "../../support/imagemagick.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DRIVER = "tests/benchmarks/conversation-render/run.mjs";
const PRELOAD = join(ROOT, "tests/benchmarks/conversation-render/comparison-preload.mjs");
const PROFILES = [
  { id: "light", width: 430, height: 900, colorScheme: "light" },
  { id: "dark", width: 430, height: 900, colorScheme: "dark" },
];
const MODES = ["snapshot-render", "expand-tool-raw"];
const POSITIONS = ["top", "middle", "bottom"];
const PIXEL_LIMIT = 0.001; // Same settled-screenshot budget as the existing conversation benchmark.
const FIXED_TIME = "2026-09-18T04:00:00.000Z";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function prepareComparison(output, ref = "01dbe268") {
  const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ROOT, encoding: "utf8" }).trim();
  const baseline = join(output, "baseline");
  if (existsSync(baseline)) throw new Error(`Refusing to replace an existing baseline: ${baseline}`);
  mkdirSync(baseline, { recursive: true });
  const archive = join(output, "baseline.tar");
  const fd = openSync(archive, "wx");
  try {
    execFileSync("git", ["archive", "--format=tar", commit, "extension", "tests/benchmarks/conversation-render"], {
      cwd: ROOT, stdio: ["ignore", fd, "pipe"],
    });
  } finally { closeSync(fd); }
  execFileSync("tar", ["-xf", archive, "-C", baseline]);
  symlinkSync(join(ROOT, "node_modules"), join(baseline, "node_modules"), "dir");
  const browsers = json(join(ROOT, "node_modules/playwright-core/browsers.json"));
  const browser = browsers.browsers.find(item => item.name === "chromium");
  if (!browser.browserVersion.startsWith("149.")) throw new Error(`Expected Chromium 149, found ${browser.browserVersion}`);
  if (!existsSync(chromium.executablePath())) throw new Error("Locked Chromium is not installed");
  const magick = spawnSync("magick", ["-version"], { encoding: "utf8" });
  if (magick.status !== 0) throw new Error("ImageMagick is required for an exact pixel comparison");
  for (const root of [ROOT, baseline]) instrumentComparisonDriver(readFileSync(join(root, DRIVER), "utf8"));
  const plan = {
    baselineCommit: commit, baselineTree: execFileSync("git", ["rev-parse", `${commit}:extension`], { cwd: ROOT, encoding: "utf8" }).trim(),
    archiveSha256: hash(readFileSync(archive)), baseline, browser, executable: chromium.executablePath(),
    playwrightVersion: json(join(ROOT, "node_modules/playwright/package.json")).version,
    lockfileSha256: hash(readFileSync(join(ROOT, "package-lock.json"))),
    instrumentationSha256: hash(readFileSync(PRELOAD)), imageMagick: magick.stdout.split("\n")[0],
    profiles: PROFILES, modes: MODES, positions: POSITIONS, fixedTime: FIXED_TIME, pixelLimit: PIXEL_LIMIT,
    definitions: {
      differentPixelRatio: "ImageMagick AE (no fuzz) / viewport pixel count; equal dimensions required",
      screenshotPassRate: "passing planned screenshots / all planned screenshots; missing or failed render counts as failure",
      pixelConsistency: "1 - sum(different pixels) / sum(all planned pixels); missing images or invalid renders count as entirely different",
      animations: "Both existing benchmark drivers zero CSS animation/transition duration; screenshots disable animations and hide caret. No masked regions.",
      stability: "Same locale/timezone/device scale and fixed Date; fonts.ready and visible image decode awaited; identical viewport and top/middle/bottom positions.",
      duplication: "Short transcripts can produce identical top/middle/bottom views; unique image-pair counts are reported separately.",
    },
  };
  save(join(output, "plan.json"), plan);
  return plan;
}

export function comparePixels(before, after, diffPath) {
  const sizes = [before, after].map(path => execFileSync("magick", ["identify", "-format", "%w %h", path], { encoding: "utf8" }).trim());
  if (sizes[0] !== sizes[1]) return { status: "fail", reason: "image dimensions differ", sizes };
  const [width, height] = sizes[0].split(" ").map(Number);
  const result = spawnSync("magick", ["compare", "-metric", "AE", before, after, diffPath], { encoding: "utf8" });
  const differentPixels = Number(String(result.stderr).trim().split(/\s+/)[0]);
  if (![0, 1].includes(result.status) || !Number.isFinite(differentPixels)) throw new Error(`Image comparison failed: ${result.stderr}`);
  return { status: differentPixels / (width * height) <= PIXEL_LIMIT ? "pass" : "fail", differentPixels, totalPixels: width * height, ratio: differentPixels / (width * height) };
}

export function prepareCapturedFixtures(output, captureDir, metadataPath) {
  if (existsSync(join(output, "comparison.json"))) throw new Error("Refusing to change fixtures after comparison started");
  const plan = json(join(output, "plan.json"));
  for (const root of [ROOT, plan.baseline]) instrumentComparisonDriver(readFileSync(join(root, DRIVER), "utf8"));
  plan.instrumentationSha256 = hash(readFileSync(PRELOAD));
  plan.definitions.resources = "Recorded resource bytes are fulfilled at original URLs for both revisions; provenance/hashes are in inputs.json. Other external network is blocked and recorded as a render failure.";
  plan.definitions.expanded = "The first tool timeline (or a single tool card when no timeline exists) and its raw panel when available are expanded; not every tool is expanded.";
  save(join(output, "plan.json"), plan);
  const expected = Object.values(json(metadataPath).cases).flat();
  const selected = readdirSync(captureDir).filter(name => name.endsWith(".json")).map(name => {
    const path = join(captureDir, name);
    return { path, capture: json(path) };
  }).filter(item => item.capture.iteration === 1);
  if (selected.length !== expected.length || expected.some(name => selected.filter(item => item.capture.case === name).length !== 1)) {
    throw new Error("Expected exactly one first-attempt capture for every planned case, including failures");
  }
  const resourcePath = join(output, "resources/resources.json");
  const resources = existsSync(resourcePath) ? json(resourcePath) : { resources: [] };
  const fixtures = [];
  const dir = join(output, "inputs");
  mkdirSync(dir, { recursive: true });
  for (const name of expected) {
    const { path, capture } = selected.find(item => item.capture.case === name);
    const snapshot = capture.snapshot || {};
    const fixture = { name, sessionId: snapshot.sessionId, session: snapshot.session,
      title: snapshot.session?.title || name, transcript: snapshot.transcript || [],
      comparisonResources: resources.resources.filter(item => JSON.stringify(snapshot.transcript).includes(item.url)) };
    const fixturePath = join(dir, `${name}.json`);
    save(fixturePath, fixture);
    writeFileSync(join(dir, `${name}.capture.json`), readFileSync(path));
    fixtures.push({ case: name, path: fixturePath, captureSha256: hash(readFileSync(path)),
      fixtureSha256: hash(readFileSync(fixturePath)), transcriptEntries: fixture.transcript.length,
      rawSuccess: capture.result?.success ?? false, resourceCount: fixture.comparisonResources.length,
      captureError: capture.captureError || null });
  }
  save(join(output, "inputs.json"), { selection: "Every planned case, iteration 1, including failures", resources, fixtures });
  return fixtures;
}

async function runComparison(output, fixtures) {
  if (!fixtures.length) throw new Error("Provide the selected first-attempt JSON fixtures, including failed tasks");
  const plan = json(join(output, "plan.json"));
  if (hash(readFileSync(PRELOAD)) !== plan.instrumentationSha256) throw new Error("Comparison instrumentation changed; prepare a fresh plan");
  if (hash(readFileSync(join(ROOT, "package-lock.json"))) !== plan.lockfileSha256) throw new Error("Dependencies changed; prepare a fresh plan");
  const currentExtension = join(output, "current-extension");
  const build = await buildExtension({ outputDir: currentExtension, mode: "development" });
  save(join(output, "current-build.json"), { ...build, runtimeSha256: Object.fromEntries(build.files.map(path => [path, hash(readFileSync(join(currentExtension, path)))])), sourceManifest: execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" }) });
  const results = [];
  for (const [index, input] of fixtures.entries()) {
    const fixture = resolve(input);
    const captured = json(fixture);
    const hasTranscript = Array.isArray(captured.transcript) && captured.transcript.length > 0;
    const id = `${String(index + 1).padStart(2, "0")}-${json(fixture).sessionId || "task"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fixtureDir = join(output, "cases", id);
    mkdirSync(fixtureDir, { recursive: true });
    const canonical = join(fixtureDir, "fixture.json");
    const bytes = readFileSync(fixture);
    writeFileSync(canonical, bytes);
    for (const profile of PROFILES) for (const mode of MODES) {
      const runs = {};
      for (const [revision, root] of [["before", plan.baseline], ["after", ROOT]]) {
        const dir = join(fixtureDir, profile.id, mode, revision);
        mkdirSync(dir, { recursive: true });
        const driver = join(root, DRIVER);
        if (!hasTranscript) {
          runs[revision] = { dir, ok: false, exitCode: null, error: "Missing captured transcript", report: null };
          continue;
        }
        const child = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, driver,
          "--mode", mode, "--json", "--color-scheme", profile.colorScheme, "--artifact-dir", dir, canonical], {
          cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CHROME_EXECUTABLE: plan.executable, QZ_COMPARISON_DRIVER: driver,
            QZ_COMPARISON_TIME: FIXED_TIME, QINGZHOU_TEST_EXTENSION_DIR: currentExtension,
            CONVERSATION_BENCH_WIDTH: String(profile.width), CONVERSATION_BENCH_HEIGHT: String(profile.height) },
        });
        writeFileSync(join(dir, "stdout.log"), child.stdout || "");
        writeFileSync(join(dir, "stderr.log"), child.stderr || "");
        const report = existsSync(join(dir, "report.json")) ? json(join(dir, "report.json")) : null;
        const ok = child.status === 0 && report?.stage === "conversation-render" && report.browserVersion === plan.browser.browserVersion
          && !report.pageErrors.length && !report.resourceErrors.length
          && (mode !== "expand-tool-raw" || report.result?.interaction?.ok === true);
        runs[revision] = { dir, ok, exitCode: child.status, error: child.error?.message || "", report };
      }
      for (const position of POSITIONS) {
        const before = join(runs.before.dir, "screenshots", `${position}.png`);
        const after = join(runs.after.dir, "screenshots", `${position}.png`);
        const diff = join(fixtureDir, profile.id, mode, `${position}-diff.png`);
        let pixel = { status: "fail", reason: "missing screenshot", differentPixels: profile.width * profile.height, totalPixels: profile.width * profile.height };
        if (existsSync(before) && existsSync(after)) pixel = comparePixels(before, after, diff);
        results.push({ id, profile: profile.id, mode, position, fixtureSha256: hash(bytes),
          status: runs.before.ok && runs.after.ok ? pixel.status : "fail", pixel,
          before: relative(output, before), after: relative(output, after), diff: relative(output, diff),
          pairHash: existsSync(before) && existsSync(after) ? `${hash(readFileSync(before))}:${hash(readFileSync(after))}` : "",
          render: Object.fromEntries(Object.entries(runs).map(([revision, run]) => [revision, { ok: run.ok, exitCode: run.exitCode, error: run.error, pageErrors: run.report?.pageErrors || [], resourceErrors: run.report?.resourceErrors || [] }])),
          scroll: Object.fromEntries(Object.entries(runs).map(([revision, run]) => [revision,
            run.report?.artifacts?.visualSnapshots?.find(item => item.name === position)?.scrollTop ?? null])),
        });
      }
      writeReport(output, plan, results, fixtures.length * PROFILES.length * MODES.length * POSITIONS.length);
      console.log(`${id} ${profile.id} ${mode}: ${runs.before.ok && runs.after.ok ? "rendered" : "render failed"}`);
    }
  }
  return writeReport(output, plan, results, results.length);
}

export function writeReport(output, plan, results, planned) {
  const labels = new Map();
  for (const item of results) {
    if (labels.has(item.id)) continue;
    const path = join(output, "cases", item.id, "fixture.json");
    const fixture = existsSync(path) ? json(path) : {};
    labels.set(item.id, [fixture.name, fixture.title].filter(Boolean).join(" · ") || item.id);
  }
  const passed = results.filter(item => item.status === "pass").length;
  const missing = planned - results.length;
  const viewportPixels = PROFILES[0].width * PROFILES[0].height;
  const totalPixels = planned * viewportPixels;
  const valid = item => item.render.before.ok && item.render.after.ok;
  const differentPixels = results.reduce((sum, item) => sum + (valid(item) ? item.pixel.differentPixels ?? viewportPixels : viewportPixels), missing * viewportPixels);
  const report = { baselineCommit: plan.baselineCommit, planned, captured: results.length, validScreenshots: results.filter(valid).length, passed,
    screenshotPassRate: passed / planned, pixelConsistency: 1 - differentPixels / totalPixels,
    exactScreenshots: results.filter(item => valid(item) && item.pixel.differentPixels === 0).length,
    uniqueViewPairs: new Set(results.map(item => item.pairHash).filter(Boolean)).size,
    definitions: plan.definitions, results };
  save(join(output, "comparison.json"), report);
  const cards = results.map(item => `<article><h2>${html(`${labels.get(item.id)} / ${item.profile} / ${item.mode} / ${item.position}`)}</h2><p>${html(item.id)} · ${item.status} · AE ${item.pixel.differentPixels ?? "unavailable"} · ${(100 * (item.pixel.ratio ?? 1)).toFixed(4)}% pixels differ · scroll ${html(JSON.stringify(item.scroll))}</p><div>${["before", "after", "diff"].map(key => `<figure><figcaption>${key}</figcaption><a href="${html(item[key])}"><img loading="lazy" src="${html(item[key])}" alt="${key}"></a></figure>`).join("")}</div></article>`).join("\n");
  writeFileSync(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>Qingzhou visual comparison</title><style>body{font:14px system-ui;margin:24px;background:#eee;color:#222}article{background:white;padding:16px;margin:20px 0}article>div{display:flex;gap:12px}figure{margin:0;flex:1;min-width:0}img{width:100%;height:auto}h2{font-size:16px}</style><h1>Same-transcript visual comparison</h1><p>Baseline ${html(plan.baselineCommit)} · Chromium ${html(plan.browser.browserVersion)} · ${passed}/${planned} screenshots within 0.1% AE · pixel consistency ${(100 * report.pixelConsistency).toFixed(4)}% · ${report.uniqueViewPairs} unique pairs.</p><p>Same transcript and wall clock; no masked regions. Short transcripts may repeat top/middle/bottom. Missing or failed renders remain in the denominator. Metrics measure pixel agreement, not task success or a perceptual score.</p>${cards}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const action = args.shift();
  if ((action === "--prepare" || action === "--run") && !imageMagickCommandAvailable()) {
    console.log(`conversation revision comparison skipped: ${MISSING_IMAGEMAGICK_REASON}`);
    process.exit(0);
  }
  const output = resolve(args.shift() || "tests/results/live-visual-comparison");
  if (action === "--prepare") console.log(JSON.stringify(prepareComparison(output, args[0]), null, 2));
  else if (action === "--captures") console.log(JSON.stringify(prepareCapturedFixtures(output, resolve(args[0]), resolve(args[1])), null, 2));
  else if (action === "--run") {
    const report = await runComparison(output, args.length ? args : json(join(output, "inputs.json")).fixtures.map(item => item.path));
    console.log(JSON.stringify(report, null, 2));
    if (report.validScreenshots !== report.planned || report.passed !== report.planned) process.exitCode = 1;
  }
  else throw new Error("Usage: node --import tsx compare-revisions.mjs --prepare <new-output> | --captures <prepared-output> <captures-dir> <metadata.json> | --run <prepared-output> [fixture.json...]");
}

#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extname, join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { discoverRealExamples } from "./tools/real-examples.mjs";
import { createScrollFuzz } from "./tools/scroll-fuzz.mjs";
import { mergeBudgets } from "./tools/merge-budgets.mjs";
import { parseExportHtmlFixture } from "./tools/export-html-fixture.mjs";
import { runConversationVisualAudit } from "./visual-audit.mjs";
import { prepareBenchmarkAssets } from "../../support/benchmark-assets.mjs";
import { ensureTestExtension, resolveTestAsset } from "../../support/extension-build.mjs";
import { MISSING_IMAGEMAGICK_REASON } from "../../support/imagemagick.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_TIMEOUT_MS = clampNumber(process.env.CONVERSATION_BENCH_TIMEOUT_MS, 5_000, 600_000, 180_000);
const HEADLESS = process.env.CONVERSATION_BENCH_HEADLESS !== "0";
const VIEWPORT = {
  width: clampNumber(process.env.CONVERSATION_BENCH_WIDTH, 320, 3840, 430),
  height: clampNumber(process.env.CONVERSATION_BENCH_HEIGHT, 480, 2160, 900),
};
const DEFAULT_HEALTH_BUDGETS = {
  elapsedMs: {
    "session-switch": 500,
    "snapshot-render": 300,
    "live-replay": 500,
  },
  renderCalls: {
    "session-switch": 1,
    "snapshot-render": 1,
    "live-replay": 50,
  },
  maxLongTaskMs: 200,
  totalLongTaskMs: 600,
  domNodes: 30_000,
  spans: 20_000,
  textChars: 800_000,
  heapGrowthMB: 40,
  visualDiffRatio: 0.001,
  interactionVisualDiffRatio: 0.005,
  streamPatchSuccessRate: 0.9,
  streamMaxPatchMs: 32,
  streamP95PatchMs: 16,
  streamMaxRenderMs: 50,
  streamLivePatchFallback: 1,
  streamFullReconcileDuringLive: null,
  streamRenderPerEvent: 1.2,
  streamInteractionMaxDelayMs: 100,
  streamInteractionP95DelayMs: 50,
  streamInputHandlerP95Ms: 8,
  streamScrollHandlerP95Ms: 8,
  streamMaxConcurrentPlayback: 1,
  streamMaxHostAnimationStarts: 0,
  streamMaxRepeatedHostAnimationStarts: 0,
  streamMaxAgedHostAnimationStarts: 0,
  streamFrameP95Ms: 24,
  streamFrameMaxMs: 100,
  streamScrollMinSamples: 4,
  streamScrollMinConcurrentSamples: 2,
  streamScrollMaxAnchorDriftPx: 1,
  streamScrollMaxCardDriftPx: 0.5,
  streamScrollMaxLostAnchors: 0,
  streamScrollMaxTailHijacks: 0,
  streamScrollMaxResumeLagFrames: 1,
  streamScrollMaxResumeFailures: 0,
  streamPagerMinClicks: 8,
  streamPagerMinDirectionClicks: 1,
  streamPagerMaxTopDriftPx: 1,
  streamPagerMaxLeftDriftPx: 1,
  streamPagerMaxLostTargets: 0,
  streamPagerMaxMissingModes: 0,
  visualAuditMinActions: 12,
  visualAuditMaxUnexercisedKinds: 0,
  visualAuditMaxClickFailures: 0,
  visualAuditMaxErrors: 0,
  visualAuditMaxWarnings: 0,
  visualAuditMaxStableMovementPx: 1,
  visualAuditMaxUnexpectedLayoutShift: 0.001,
};

let args;
try { args = parseArgs(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }
if (args.help) {
  console.log("Usage: npm run benchmark -- conversation [fixture.html|fixture.json | --real-examples] [--mode <mode>] [options]\nSee docs/benchmarks.md#replay-a-conversation for modes, capture and stream options.");
  process.exit(0);
}
if (args.realExamples && (args.fixture || args._.length || args.screenshot || args.baselineDir || args.updateBaseline || args.compareBaseline)) {
  throw new Error("--real-examples cannot be combined with a single fixture, screenshot or baseline; select an individual file for those options.");
}
if (args.compareBaseline === true && !findImageMagickExecutable()) {
  console.log(`conversation render baseline comparison skipped: ${MISSING_IMAGEMAGICK_REASON}`);
  process.exit(0);
}
const fixturePaths = args.realExamples
  ? discoverRealExamples(join(ROOT, "tests/benchmarks/conversation-render/real_examples"))
  : [args.fixture || args._[0] || join(ROOT, "tests/benchmarks/conversation-render/fixtures/smoke.json")];
const collectionDir = args.realExamples
  ? resolve(args.artifactDir || join(ROOT, "tests/results/conversation-real-examples", timestampSlug()))
  : null;
const mode = args.mode || "session-switch";
const jsonOnly = args.json === true;
const COLOR_SCHEME = normalizeColorScheme(args.colorScheme || process.env.CONVERSATION_BENCH_COLOR_SCHEME);

const playwright = await loadPlaywright();
const chromeExecutable = findChromeExecutable(playwright.chromium.executablePath());
if (!chromeExecutable) {
  throw new Error("Conversation benchmark requires Chromium; run npx playwright install chromium or set CHROME_EXECUTABLE.");
}

const server = await startStaticServer(ROOT);
const browser = await playwright.chromium.launch({
  headless: HEADLESS,
  executablePath: chromeExecutable,
  args: [
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
});

const samples = [];
try {
  // Each sample has its own context; failures must not skip the remaining corpus.
  for (const [index, fixturePath] of fixturePaths.entries()) {
    const artifactDir = collectionDir ? join(collectionDir, `sample-${index + 1}`) : null;
    try {
      const report = await runFixture(fixturePath, artifactDir);
      samples.push({ file: fixturePath, status: report.failed ? "fail" : "pass", report: report.artifacts?.report });
    } catch (error) {
      if (!collectionDir) throw error;
      process.exitCode = 1;
      const failure = { file: fixturePath, status: "error", error: String(error?.stack || error) };
      writeJsonFile(join(artifactDir, "error.json"), failure);
      samples.push(failure);
    }
  }
  if (collectionDir) {
    const summary = { mode, samples, passed: samples.filter(sample => sample.status === "pass").length, total: samples.length };
    writeJsonFile(join(collectionDir, "summary.json"), summary);
    console.log(JSON.stringify({ stage: "real-examples", passed: summary.passed, total: summary.total, report: join(collectionDir, "summary.json") }));
  }
} finally {
  await browser.close().catch(() => {});
  await server.close();
}

async function runFixture(fixturePath, sampleArtifactDir) {
  const fixture = readFixture(fixturePath);
  if (collectionDir && (!Array.isArray(fixture.transcript) || !fixture.transcript.length)) {
    throw new Error("Conversation fixture must contain a non-empty transcript");
  }
  const context = await browser.newContext({ locale: "zh-CN", viewport: VIEWPORT, colorScheme: COLOR_SCHEME });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable").catch(() => {});
    await page.addInitScript(installBenchmarkChromeStub);

    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.message));
    page.on("console", msg => {
      if (msg.type() === "error" && !isIgnorableConsoleError(msg.text())) pageErrors.push(msg.text());
      if (!jsonOnly && msg.type() === "debug" && /轻舟 perf/.test(msg.text())) {
        console.error(msg.text());
      }
    });

    await page.goto(`${server.url}/extension/sidepanel/sidepanel.html?benchmark=conversation-render`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    const syntaxHighlighting = !boolArg(args.disableSyntaxHighlight, false);
    if (!syntaxHighlighting) {
      await page.evaluate(async () => {
        const { hljs } = await import("/extension/sidepanel/ui/highlight-config.js");
        hljs.getLanguage = () => undefined;
      });
    }

    const baselineDir = resolveBaselineDir(args, fixture, mode);
    const artifactDir = sampleArtifactDir || resolveArtifactDir(args, fixture, mode, baselineDir);
    await resetLongTaskSummary(page);
    const longTaskStart = await readLongTaskSummary(page);
    const heapStart = await readHeap(page, cdp);
    const result = await runBenchmarkMode(page, fixture, mode, { artifactDir, syntaxHighlighting });
    const longTaskEnd = await readLongTaskSummary(page);
    const heapEnd = await readHeap(page, cdp);
    const longTasks = diffLongTasks(longTaskStart, longTaskEnd);
    const heap = {
      before: heapStart,
      after: heapEnd,
    };
    const healthBudgets = readHealthBudgets(args.budget);
    const semanticSnapshot = await readSemanticSnapshot(page);
    const health = buildHealthReport({
      mode,
      result,
      longTasks,
      heap,
      budgets: healthBudgets,
    });
    const visualAudit = extractVisualAudit(result);
    const artifacts = artifactDir
      ? await writeBenchmarkArtifacts(page, artifactDir, {
        semanticSnapshot,
        captureVisuals: true,
        visualAudit,
        interactionSnapshots: visualAudit?.snapshots || [],
      })
      : null;
    const baselineComparison = args.compareBaseline === true
      ? compareBenchmarkBaseline({
        baselineDir,
        current: {
          semanticSnapshot,
          artifacts,
        },
        budgets: healthBudgets,
      })
      : null;
    const screenshotPath = await maybeWriteScreenshot(page, args.screenshot);
    const report = normalizeNumbers({
      stage: "conversation-render",
      mode,
      fixture: fixture.name || fixture.title || fixture.sessionId || fixturePath,
      viewport: VIEWPORT,
      colorScheme: COLOR_SCHEME,
      syntaxHighlighting,
      result,
      screenshot: screenshotPath,
      longTasks,
      heap,
      health,
      semanticSnapshot: summarizeSemanticSnapshot(semanticSnapshot),
      artifacts,
      baseline: baselineComparison,
      pageErrors,
    });
    if (artifacts?.dir) {
      const reportPath = join(artifacts.dir, "report.json");
      report.artifacts.report = reportPath;
      writeJsonFile(reportPath, report);
    }
    console.log(JSON.stringify(report, null, jsonOnly ? 0 : 2));
    const failed = Boolean(pageErrors.length || args.failOnHealth === true && health.status === "fail" || baselineComparison?.status === "fail");
    if (failed) process.exitCode = 1;
    return { ...report, failed };
  } finally {
    await context.close();
  }
}

async function runBenchmarkMode(page, fixture, mode, runtime = {}) {
  if (mode.startsWith("stream-fixture") && boolArg(args.streamDisableMessageMotion, false)) {
    await page.addStyleTag({ content: "#messages > .msg { animation: none !important; }" });
  }
  if (mode === "tool-presentation-streaming") {
    return page.evaluate(() => window.qingzhouConversationBenchmark.runToolPresentationStateRegression());
  }
  if (mode === "data-grid-tab-state") {
    return runDataGridTabStateBenchmark(page);
  }
  if (mode === "stream-fixture") {
    const streamFixture = buildFixtureStreamReplay(fixture, args);
    const result = await page.evaluate(({ input, options }) => {
      return window.qingzhouConversationBenchmark.runLiveReplay(input, options);
    }, {
      input: streamFixture,
      options: streamReplayOptions(args),
    });
    result.benchmark = "stream-fixture";
    result.streamFixture = streamFixture.stream;
    return result;
  }
  if (mode === "stream-fixture-expanded") {
    const streamFixture = buildFixtureStreamReplay(fixture, args);
    const result = await page.evaluate(({ input, options }) => {
      return window.qingzhouConversationBenchmark.runLiveReplay(input, options);
    }, {
      input: streamFixture,
      options: {
        ...streamReplayOptions(args),
        expandToolTimelines: true,
        expandToolTimelineLimit: numberArg(args.expandToolTimelineLimit, 4),
        expandToolTimelineEveryEvents: numberArg(args.expandToolTimelineEveryEvents, numberArg(args.streamYieldEvery, 25)),
      },
    });
    result.benchmark = "stream-fixture-expanded";
    result.streamFixture = streamFixture.stream;
    return result;
  }
  if (mode === "stream-fixture-pager" || mode === "stream-fixture-interaction") {
    return runStreamFixturePagerBenchmark(page, fixture, args, {
      interactionContract: mode === "stream-fixture-interaction",
    });
  }
  if (mode === "visual-audit") {
    return runConversationVisualAudit(page, fixture, {
      artifactDir: runtime.artifactDir,
      viewport: VIEWPORT,
      maxActions: numberArg(args.visualAuditMaxActions, 64),
      maxDepth: numberArg(args.visualAuditMaxDepth, 2),
      settleMs: numberArg(args.visualAuditSettleMs, 240),
    });
  }
  if (mode === "snapshot-render") {
    return page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input), fixture);
  }
  if (mode === "expand-tool-raw") {
    return runExpandToolRawBenchmark(page, fixture);
  }
  if (mode === "live-replay") {
    return page.evaluate(input => window.qingzhouConversationBenchmark.runLiveReplay(input), fixture);
  }
  if (mode === "all") {
    const streamFixture = buildFixtureStreamReplay(fixture, args);
    const results = {
      sessionSwitch: await page.evaluate(input => window.qingzhouConversationBenchmark.runSessionSwitch(input), fixture),
      snapshotRender: await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input), fixture),
      liveReplay: Array.isArray(fixture.events) && fixture.events.length
        ? await page.evaluate(input => window.qingzhouConversationBenchmark.runLiveReplay(input), fixture)
        : null,
      streamFixture: await page.evaluate(({ input, options }) => {
        return window.qingzhouConversationBenchmark.runLiveReplay(input, options);
      }, {
        input: streamFixture,
        options: streamReplayOptions(args),
      }).then(result => ({ ...result, benchmark: "stream-fixture", streamFixture: streamFixture.stream })),
      streamFixtureExpanded: await page.evaluate(({ input, options }) => {
        return window.qingzhouConversationBenchmark.runLiveReplay(input, options);
      }, {
        input: streamFixture,
        options: {
          ...streamReplayOptions(args),
          expandToolTimelines: true,
          expandToolTimelineLimit: numberArg(args.expandToolTimelineLimit, 4),
          expandToolTimelineEveryEvents: numberArg(args.expandToolTimelineEveryEvents, numberArg(args.streamYieldEvery, 25)),
        },
      }).then(result => ({ ...result, benchmark: "stream-fixture-expanded", streamFixture: streamFixture.stream })),
    };
    await reloadBenchmarkSurface(page, { syntaxHighlighting: runtime.syntaxHighlighting });
    results.visualAudit = await runConversationVisualAudit(page, fixture, {
      artifactDir: runtime.artifactDir,
      viewport: VIEWPORT,
      maxActions: numberArg(args.visualAuditMaxActions, 64),
      maxDepth: numberArg(args.visualAuditMaxDepth, 2),
      settleMs: numberArg(args.visualAuditSettleMs, 240),
    });
    return results;
  }
  return page.evaluate(input => window.qingzhouConversationBenchmark.runSessionSwitch(input), fixture);
}

async function reloadBenchmarkSurface(page, { syntaxHighlighting = true } = {}) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  if (!syntaxHighlighting) {
    await page.evaluate(async () => {
      const { hljs } = await import("/extension/sidepanel/ui/highlight-config.js");
      hljs.getLanguage = () => undefined;
    });
  }
}

async function runStreamFixturePagerBenchmark(page, fixture, args = {}, { interactionContract = false } = {}) {
  const streamFixture = buildFixtureStreamReplay(fixture, args);
  const replayOptions = {
    ...streamReplayOptions(args),
    paceScale: numberArg(args.streamPaceScale, 0.2),
    yieldEveryEvents: numberArg(args.streamYieldEvery, 5),
    expandToolTimelines: false,
    visualStabilityProbe: interactionContract || boolArg(args.streamVisualStabilityProbe, false),
  };
  const nextScrollPlan = args.streamFuzzSeed == null ? null : createScrollFuzz(Number(args.streamFuzzSeed));
  const intervalMs = Math.max(0, numberArg(args.streamPagerIntervalMs, 12));
  const minClicksPerMode = Math.max(1, numberArg(args.streamPagerClicksPerMode, 4));
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  await page.evaluate(({ input, options }) => {
    const state = {
      done: false,
      error: "",
      result: null,
    };
    state.promise = window.qingzhouConversationBenchmark.runLiveReplay(input, options).then(
      result => {
        state.result = result;
        state.done = true;
        return result;
      },
      error => {
        state.error = error?.stack || error?.message || String(error);
        state.done = true;
        return null;
      },
    );
    window.__qingzhouPagerStreamBenchmark = state;
  }, { input: streamFixture, options: replayOptions });

  const samples = [];
  const scrollSamples = [];
  const modeCounts = { steps: 0, family: 0 };
  let desiredDirection = 1;
  let attempts = 0;
  let replayDone = false;
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => {
      const state = window.__qingzhouPagerStreamBenchmark;
      return { done: Boolean(state?.done), error: state?.error || "" };
    });
    if (status.error) throw new Error(status.error);
    if (status.done) {
      replayDone = true;
      break;
    }

    if (interactionContract) {
      const scrollSample = await sampleStreamingScrollInteraction(page, {
        holdMs: numberArg(args.streamScrollHoldMs, 64),
        fuzzPlan: nextScrollPlan?.(),
      });
      if (scrollSample) scrollSamples.push({ ...scrollSample, duringReplay: true });
    }

    const preferredMode = modeCounts.steps < minClicksPerMode
      ? "steps"
      : modeCounts.family < minClicksPerMode
        ? "family"
        : (samples.length % 2 ? "steps" : "family");
    const sample = await sampleStreamingPagerInteraction(page, {
      direction: desiredDirection,
      preferredMode,
    });
    attempts += 1;
    if (sample?.clicked) {
      sample.duringReplay = true;
      samples.push(sample);
      modeCounts[sample.modeBefore] = (modeCounts[sample.modeBefore] || 0) + 1;
      desiredDirection = sample.direction === 1 ? -1 : 1;
    }
    if (intervalMs > 0) await page.waitForTimeout(intervalMs);
  }
  if (!replayDone) throw new Error(`stream fixture pager benchmark timed out after ${DEFAULT_TIMEOUT_MS}ms`);

  const replay = await page.evaluate(async () => {
    const state = window.__qingzhouPagerStreamBenchmark;
    if (!state) throw new Error("pager stream benchmark state is missing");
    await state.promise;
    const payload = { result: state.result, error: state.error || "" };
    delete window.__qingzhouPagerStreamBenchmark;
    return payload;
  });
  if (replay.error) throw new Error(replay.error);

  const availableModes = await page.evaluate(() => Array.from(new Set(
    Array.from(document.querySelectorAll(".tool-timeline-slot-nav"))
      .map(pager => pager.closest(".tool-timeline-details")?.dataset.timelineMode || "")
      .filter(Boolean),
  )).sort());
  const pagerInteraction = summarizeStreamingPagerSamples(samples, {
    attempts,
    availableModes,
  });
  const scrollInteraction = interactionContract
    ? summarizeStreamingScrollSamples(scrollSamples)
    : null;
  return {
    ...(replay.result || {}),
    benchmark: interactionContract ? "stream-fixture-interaction" : "stream-fixture-pager",
    streamFixture: streamFixture.stream,
    pagerInteraction,
    ...(scrollInteraction ? { scrollInteraction } : {}),
    ...(nextScrollPlan ? { fuzzSeed: Number(args.streamFuzzSeed) } : {}),
  };
}

async function sampleStreamingScrollInteraction(page, { holdMs = 64, fuzzPlan } = {}) {
  const setup = await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    if (!messages) return { ready: false, reason: "messages-missing" };
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll", { bubbles: true }));
    messages.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
    const maxScroll = Math.max(0, messages.scrollHeight - messages.clientHeight);
    return {
      ready: maxScroll >= 96,
      reason: maxScroll >= 96 ? "" : "insufficient-history",
      maxScroll,
      clientHeight: messages.clientHeight,
    };
  });
  if (!setup.ready) return { sampled: false, reason: setup.reason, maxScroll: setup.maxScroll };

  const box = await page.locator("#messages").boundingBox();
  if (!box) return { sampled: false, reason: "messages-not-visible" };
  const leaveDistance = Math.min(
    Math.max(96, setup.clientHeight * 0.4),
    Math.max(96, setup.maxScroll * 0.6),
  );
  await page.mouse.move(box.x + 4, box.y + Math.max(4, Math.min(box.height - 4, box.height * 0.5)));
  if (fuzzPlan) {
    for (const delta of fuzzPlan.deltas) {
      await page.mouse.wheel(0, Math.round(delta * setup.clientHeight));
      await page.waitForTimeout(fuzzPlan.gapMs);
    }
  } else {
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(0, -leaveDistance);
  }
  await page.evaluate(async () => {
    const messages = document.querySelector("#messages");
    if (!messages) return;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    let previousTop = messages.scrollTop;
    let stableFrames = 0;
    for (let index = 0; index < 30 && stableFrames < 3; index += 1) {
      await frame();
      const nextTop = messages.scrollTop;
      stableFrames = Math.abs(nextTop - previousTop) < 0.5 ? stableFrames + 1 : 0;
      previousTop = nextTop;
    }
  });

  const held = await page.evaluate(async ({ holdMs: requestedHoldMs, monitorCards }) => {
    const messages = document.querySelector("#messages");
    if (!messages) return { sampled: false, reason: "messages-missing" };
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const tailGap = () => Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    const signature = () => {
      const last = messages.lastElementChild;
      return [
        messages.childElementCount,
        messages.textContent?.length || 0,
        messages.scrollHeight,
        last?.textContent?.length || 0,
      ].join(":");
    };
    await frame();
    await frame();
    if (tailGap() <= 28) return { sampled: false, reason: "wheel-did-not-leave-tail" };

    const viewport = messages.getBoundingClientRect();
    const visibleMessages = Array.from(messages.children)
      .filter(element => {
        if (!(element instanceof Element) || !element.matches(".msg")) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewport.top + 4 && rect.top < viewport.bottom - 4;
      });
    const stableMessages = visibleMessages.filter(element => (
      element.dataset.transcriptLive !== "true"
      && !element.classList.contains("msg-waiting")
    ));
    const anchor = stableMessages[Math.floor(stableMessages.length / 2)]
      || visibleMessages[Math.floor(visibleMessages.length / 2)]
      || null;
    if (!anchor) return { sampled: false, reason: "visible-anchor-missing" };

    const cards = monitorCards ? visibleMessages.filter(element => (
      element.matches(".msg-tool, .msg-tool-timeline") && element.dataset.transcriptLive !== "true"
    )).map(element => ({ element, key: element.dataset.transcriptKey || "", top: element.getBoundingClientRect().top })) : [];
    const anchorTop = anchor.getBoundingClientRect().top;
    const scrollTop = messages.scrollTop;
    const initialSignature = signature();
    const trace = [];
    const capture = () => {
      const connected = anchor.isConnected && messages.contains(anchor);
      const currentTop = connected ? anchor.getBoundingClientRect().top : null;
      return {
        connected,
        elapsedMs: performance.now() - startedAt,
        anchorTop: currentTop,
        anchorDriftPx: Number.isFinite(currentTop) ? Math.abs(currentTop - anchorTop) : null,
        ...(monitorCards ? { cards: cards.map(card => {
          const connected = card.element.isConnected && messages.contains(card.element);
          const replacement = connected ? null : Array.from(messages.children)
            .find(element => element.dataset.transcriptKey === card.key);
          return {
            key: card.key, connected,
            driftPx: connected ? Math.abs(card.element.getBoundingClientRect().top - card.top) : null,
            ...(connected ? {} : {
              replacementDriftPx: replacement ? Math.abs(replacement.getBoundingClientRect().top - card.top) : null,
              replacementType: replacement?.dataset.transcriptType || null,
            }),
          };
        }) } : {}),
        scrollTop: messages.scrollTop,
        scrollTopDeltaPx: Math.abs(messages.scrollTop - scrollTop),
        tailGap: tailGap(),
        signature: signature(),
      };
    };
    const startedAt = performance.now();
    const minimumFrames = 4;
    do {
      await frame();
      trace.push(capture());
    } while (trace.length < minimumFrames || performance.now() - startedAt < Math.max(32, Number(requestedHoldMs) || 64));

    const connectedFrames = trace.filter(sample => sample.connected);
    return {
      sampled: true,
      anchorKey: anchor.dataset.transcriptKey || "",
      anchorTopBefore: anchorTop, scrollTopBefore: scrollTop,
      ...(monitorCards ? { monitoredCards: cards.length,
        maxCardDriftPx: Math.max(0, ...trace.flatMap(frame => frame.cards.filter(card => card.connected).map(card => card.driftPx))),
        lostCards: trace.some(frame => frame.cards.some(card => !card.connected)),
      } : {}),
      anchorType: anchor.dataset.transcriptType || "",
      maxAnchorDriftPx: Math.max(0, ...connectedFrames.map(sample => Number(sample.anchorDriftPx) || 0)),
      maxScrollTopDeltaPx: Math.max(0, ...trace.map(sample => Number(sample.scrollTopDeltaPx) || 0)),
      lostAnchor: trace.some(sample => !sample.connected),
      tailHijacked: trace.some(sample => Number(sample.tailGap) <= 28),
      changedDuringHold: trace.some(sample => sample.signature !== initialSignature),
      trace,
    };
  }, { holdMs: fuzzPlan?.holdMs ?? holdMs, monitorCards: Boolean(fuzzPlan) });

  await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
    messages.dispatchEvent(new Event("scroll", { bubbles: true }));
    messages.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));
  });
  await page.mouse.wheel(0, 120);
  const resume = await page.evaluate(async () => {
    const messages = document.querySelector("#messages");
    if (!messages) return { resumeTailGap: null, maxResumeLagFrames: null, resumeFailed: true, resumeTrace: [] };
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const tailGap = () => Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    const resumeTrace = [];
    const resumeFrames = [];
    for (let index = 0; index < 24; index += 1) {
      await frame();
      resumeTrace.push(tailGap());
      resumeFrames.push({ top: messages.scrollTop, height: messages.scrollHeight,
        client: messages.clientHeight, width: messages.clientWidth });
    }
    let consecutiveOffTailFrames = 0;
    let maxResumeLagFrames = 0;
    for (const gap of resumeTrace) {
      if (gap > 28) consecutiveOffTailFrames += 1;
      else consecutiveOffTailFrames = 0;
      maxResumeLagFrames = Math.max(maxResumeLagFrames, consecutiveOffTailFrames);
    }
    // A shrinking answer can move the viewport upward while the tail gap stays zero.
    // Viewport resizing (e.g. the run-status bar closing) has its own layout contract.
    const backward = resumeFrames.slice(1).map((after, i) => {
      const before = resumeFrames[i];
      return before.client === after.client && before.width === after.width ? before.top - after.top : 0;
    });
    const maxResumeBackwardPx = Math.max(0, ...backward);
    return {
      resumeTailGap: resumeTrace[resumeTrace.length - 1] ?? tailGap(),
      maxResumeLagFrames,
      resumeFailed: !resumeTrace.some(gap => gap <= 28) || maxResumeLagFrames > 1 || maxResumeBackwardPx > 0.5,
      maxResumeBackwardPx,
      resumeTrace,
      resumeFrames,
    };
  });
  return { ...held, ...resume, ...(fuzzPlan ? { fuzzPlan } : {}) };
}

async function sampleStreamingPagerInteraction(page, { direction = 1, preferredMode = "" } = {}) {
  return page.evaluate(async ({ direction: requestedDirection, preferredMode: requestedMode }) => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const messages = document.querySelector("#messages");
    const collectCandidates = () => Array.from(document.querySelectorAll(".msg-tool-timeline.tool-timeline-expanded"))
      .map(card => ({
        card,
        details: card.querySelector(":scope > .tool-timeline-details"),
        pager: card.querySelector(".tool-timeline-slot-nav"),
      }))
      .filter(item => item.details && item.pager && item.card.querySelector(".tool-timeline-slot-body"));
    let candidates = collectCandidates();
    if (requestedMode && !candidates.some(item => item.details.dataset.timelineMode === requestedMode)) {
      const collapsed = Array.from(document.querySelectorAll(".msg-tool-timeline"))
        .reverse()
        .find(card => card.querySelector(":scope > .tool-timeline-details")?.dataset.timelineMode === requestedMode);
      const summary = collapsed?.querySelector(":scope > .tool-timeline-summary[aria-expanded='false']");
      if (summary) {
        summary.click();
        await frame();
        await frame();
        candidates = collectCandidates();
      }
    }
    if (!candidates.length) return { clicked: false, reason: "no-pager" };
    let selected = candidates.find(item => item.details.dataset.timelineMode === requestedMode)
      || candidates[candidates.length - 1];
    const transcriptKey = selected.card.dataset.transcriptKey || "";
    const requested = Number(requestedDirection) < 0 ? -1 : 1;
    const buttonFor = value => selected.pager?.querySelector(`.tool-timeline-nav-btn[data-timeline-nav-direction="${value}"]:not(:disabled)`);
    let button = buttonFor(requested) || buttonFor(-requested);
    if (!button) return { clicked: false, reason: "no-enabled-direction", mode: selected.details.dataset.timelineMode || "steps" };
    messages?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
    button.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    // Playwright's wheel command returns before compositor scrolling ends. At
    // 120 Hz the preceding eight resume frames can still leave wheel momentum;
    // require a visible, stable click target, not merely a motionless offscreen
    // pager. Reposition the same transcript target if scrolling or a patch moves it.
    const settleStartedAt = performance.now();
    let stableSince = settleStartedAt;
    let previousPosition = null;
    let settleFrames = 0;
    let scrollAdjustments = 0;
    let viewport = null;
    while (true) {
      await frame();
      if (transcriptKey) {
        const card = messages?.querySelector(`[data-transcript-key="${CSS.escape(transcriptKey)}"]`);
        selected = {
          card,
          details: card?.querySelector(":scope > .tool-timeline-details"),
          pager: card?.querySelector(".tool-timeline-slot-nav"),
        };
      }
      button = buttonFor(requested) || buttonFor(-requested);
      const rect = button?.getBoundingClientRect();
      const containerRect = messages?.getBoundingClientRect();
      viewport = containerRect && {
        top: Math.max(0, containerRect.top + messages.clientTop),
        left: Math.max(0, containerRect.left + messages.clientLeft),
        bottom: Math.min(innerHeight, containerRect.top + messages.clientTop + messages.clientHeight),
        right: Math.min(innerWidth, containerRect.left + messages.clientLeft + messages.clientWidth),
      };
      const visible = Boolean(rect && viewport && button.isConnected && rect.width > 0 && rect.height > 0
        && rect.top >= viewport.top && rect.bottom <= viewport.bottom
        && rect.left >= viewport.left && rect.right <= viewport.right);
      const now = performance.now();
      settleFrames += 1;
      if (now - settleStartedAt >= 1000) throw new Error("Pager preparation did not become visible and stable within 1000 ms");
      if (!visible) {
        messages?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -8 }));
        button?.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        scrollAdjustments += 1;
      }
      const position = visible
        ? [messages.scrollTop, rect.top, rect.left, rect.width, rect.height,
          viewport.top, viewport.left, viewport.bottom, viewport.right, button.dataset.timelineNavDirection]
        : null;
      if (!position || !previousPosition || position.some((value, index) => value !== previousPosition[index])) {
        stableSince = now;
      }
      previousPosition = position;
      if (position && now - stableSince >= 64) break;
    }
    const preparation = {
      elapsedMs: performance.now() - settleStartedAt,
      stableMs: performance.now() - stableSince,
      frames: settleFrames,
      scrollAdjustments,
      viewport,
    };

    const modeBefore = selected.details.dataset.timelineMode || "steps";
    const actualDirection = Number(button.dataset.timelineNavDirection) || requested;
    const beforeRect = button.getBoundingClientRect();
    const scrollBefore = {
      top: messages?.scrollTop ?? null,
      height: messages?.scrollHeight ?? null,
      max: messages ? Math.max(0, messages.scrollHeight - messages.clientHeight) : null,
    };
    const activeBefore = selected.details.dataset.activeToolKey || selected.card.dataset.activeToolKey || "";
    const scrollEvents = [];
    const onScroll = () => scrollEvents.push({
      top: messages?.scrollTop ?? null,
      height: messages?.scrollHeight ?? null,
      at: performance.now(),
    });
    messages?.addEventListener("scroll", onScroll, { passive: true });
    button.click();
    const captureFrame = () => {
      const card = transcriptKey
        ? messages?.querySelector(`[data-transcript-key="${CSS.escape(transcriptKey)}"]`)
        : selected.card;
      const pager = card?.querySelector(".tool-timeline-slot-nav");
      const nextButton = pager?.querySelector(`.tool-timeline-nav-btn[data-timeline-nav-direction="${actualDirection}"]`);
      const rect = nextButton?.getBoundingClientRect();
      return {
        card,
        pager,
        nextButton,
        rect,
        details: card?.querySelector(":scope > .tool-timeline-details"),
        scrollTop: messages?.scrollTop ?? null,
        scrollHeight: messages?.scrollHeight ?? null,
        anchor: window.qingzhouConversationBenchmark.collectViewportAnchorState?.() || null,
      };
    };
    const frameTrace = [];
    let finalFrame = null;
    for (let index = 0; index < 3; index += 1) {
      await frame();
      finalFrame = captureFrame();
      frameTrace.push({
        top: finalFrame.rect?.top ?? null,
        left: finalFrame.rect?.left ?? null,
        scrollTop: finalFrame.scrollTop,
        scrollHeight: finalFrame.scrollHeight,
        anchor: finalFrame.anchor,
      });
    }
    messages?.removeEventListener("scroll", onScroll);

    const { card, pager, nextButton, rect: afterRect, details } = finalFrame || captureFrame();
    const activeAfter = details?.dataset.activeToolKey || card?.dataset.activeToolKey || "";
    return {
      clicked: true,
      direction: actualDirection,
      modeBefore,
      modeAfter: details?.dataset.timelineMode || "",
      cardConnected: Boolean(card?.isConnected),
      pagerFound: Boolean(pager),
      buttonFound: Boolean(nextButton && afterRect),
      activeChanged: Boolean(activeBefore && activeAfter && activeBefore !== activeAfter),
      topBefore: beforeRect.top,
      topAfter: afterRect?.top ?? null,
      leftBefore: beforeRect.left,
      leftAfter: afterRect?.left ?? null,
      topDeltaPx: afterRect ? Math.abs(afterRect.top - beforeRect.top) : null,
      leftDeltaPx: afterRect ? Math.abs(afterRect.left - beforeRect.left) : null,
      scrollBefore,
      preparation,
      scrollAfter: {
        top: messages?.scrollTop ?? null,
        height: messages?.scrollHeight ?? null,
        max: messages ? Math.max(0, messages.scrollHeight - messages.clientHeight) : null,
      },
      frameTrace,
      scrollEvents,
      activeBefore,
      activeAfter,
    };
  }, { direction, preferredMode });
}

function summarizeStreamingPagerSamples(samples = [], { attempts = 0, availableModes = [] } = {}) {
  const clicked = samples.filter(sample => sample?.clicked);
  const directionCounts = { previous: 0, next: 0 };
  const modeCounts = { steps: 0, family: 0 };
  for (const sample of clicked) {
    if (sample.direction < 0) directionCounts.previous += 1;
    else directionCounts.next += 1;
    const mode = sample.modeBefore || "unknown";
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;
  }
  const targetLost = clicked.filter(sample => !sample.cardConnected || !sample.pagerFound || !sample.buttonFound).length;
  const missingModes = availableModes.filter(mode => !(modeCounts[mode] > 0));
  const top = summarizePagerDelta(clicked.map(sample => sample.topDeltaPx));
  const left = summarizePagerDelta(clicked.map(sample => sample.leftDeltaPx));
  const driftSamples = clicked.filter(sample => Number(sample.topDeltaPx) > 1 || Number(sample.leftDeltaPx) > 1 || !sample.buttonFound);
  return normalizeNumbers({
    attempts,
    clicks: clicked.length,
    duringReplayClicks: clicked.filter(sample => sample.duringReplay).length,
    directionCounts,
    modeCounts,
    availableModes,
    missingModes,
    missingModeCount: missingModes.length,
    targetLost,
    activeChanged: clicked.filter(sample => sample.activeChanged).length,
    top,
    left,
    driftSamples: driftSamples.slice(0, 12),
    sample: clicked.slice(0, 12),
  });
}

function summarizeStreamingScrollSamples(samples = []) {
  const sampled = samples.filter(sample => sample?.sampled);
  const anchor = summarizePagerDelta(sampled.map(sample => sample.maxAnchorDriftPx));
  const scrollTopDelta = summarizePagerDelta(sampled.map(sample => sample.maxScrollTopDeltaPx));
  const anomalies = sampled.filter(sample => (
    sample.lostAnchor
    || sample.tailHijacked
    || sample.resumeFailed
    || Number(sample.maxAnchorDriftPx) >= 0.5
    || sample.lostCards || Number(sample.maxCardDriftPx) >= 0.5
  ));
  return normalizeNumbers({
    samples: sampled.length,
    attempts: samples.length,
    skippedReasons: samples.filter(sample => !sample?.sampled).reduce((counts, sample) => {
      const reason = sample?.reason || "unknown";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {}),
    ...(sampled.some(sample => sample.monitoredCards != null) ? {
      monitoredCards: sampled.reduce((sum, sample) => sum + (sample.monitoredCards || 0), 0),
      maxCardDriftPx: Math.max(0, ...sampled.map(sample => sample.maxCardDriftPx || 0)),
      lostCards: sampled.filter(sample => sample.lostCards).length,
    } : {}),
    duringReplaySamples: sampled.filter(sample => sample.duringReplay).length,
    concurrentSamples: sampled.filter(sample => sample.changedDuringHold).length,
    lostAnchors: sampled.filter(sample => sample.lostAnchor).length,
    tailHijacks: sampled.filter(sample => sample.tailHijacked).length,
    maxResumeLagFrames: Math.max(0, ...sampled.map(sample => Number(sample.maxResumeLagFrames) || 0)),
    maxResumeBackwardPx: Math.max(0, ...sampled.map(sample => Number(sample.maxResumeBackwardPx) || 0)),
    resumeFailures: sampled.filter(sample => sample.resumeFailed).length,
    anchor,
    scrollTopDelta,
    anomalies: anomalies.slice(0, 12),
    sample: sampled.slice(0, 12),
  });
}

function summarizePagerDelta(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, maxPx: null, p95Px: null };
  return {
    count: sorted.length,
    maxPx: sorted[sorted.length - 1],
    p95Px: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}

async function runDataGridTabStateBenchmark(page) {
  const tableName = "__data_grid_tab_state_benchmark__";
  await page.evaluate(async table => {
    await window.qingzhouConversationBenchmark.reset({ debug: true, clearStorage: false });
    const dataStore = await import(new URL("../shared/data-store.js", location.href).href);
    await dataStore.clearDataTable(table).catch(() => {});
    await dataStore.insertDataRows(table, [
      { name: "alpha ".repeat(20).trim(), score: "9.3" },
      { name: "beta", score: "7.5" },
      { name: "gamma", score: "8.7" },
    ], { columns: ["name", "score"] });
  }, tableName);

  await page.locator('[data-tab="data"]').click();
  await page.waitForFunction(table => document.querySelector("#data-table-search")?.value === table, tableName);
  await page.waitForSelector(".data-grid-table.tabulator");
  const scoreHeader = page.locator(".tabulator-col[tabulator-field='score']");
  await scoreHeader.locator(".data-grid-column-title-text").click();
  await page.waitForFunction(() => {
    const header = document.querySelector(".tabulator-col[tabulator-field='score']");
    return header && header.getAttribute("aria-sort") !== "none";
  });

  const before = await readDataGridTabState(page);
  await page.locator(".data-grid-table").evaluate(el => { el.dataset.benchmarkIdentity = "stable"; });
  await page.locator(".tabulator-cell[tabulator-field='name']").last().click();
  await page.waitForSelector("#data-row-detail:not(.hidden)");
  await page.locator('[data-tab="chat"]').click();
  const overlayClosedAfterLeave = await page.locator("#data-row-detail").evaluate(el => el.classList.contains("hidden"));
  await page.waitForTimeout(5200);
  await page.evaluate(() => { window.__qingzhouPerf = []; });
  await page.locator('[data-tab="data"]').click();
  await page.waitForFunction(() => (
    Array.isArray(window.__qingzhouPerf)
    && window.__qingzhouPerf.some(entry => entry?.name === "data.render_grid")
  ));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterReturn = await readDataGridTabState(page);
  const ok = [afterReturn].every(state => (
    state.identity === "stable"
    && state.sortDirection === before.sortDirection
    && stableJson(state.values) === stableJson(before.values)
  )) && overlayClosedAfterLeave;
  if (!ok) {
    throw new Error(`Data grid tab state mismatch: ${stableJson({ before, afterReturn })}`);
  }
  return {
    benchmark: "data-grid-tab-state",
    ok,
    before,
    afterReturn,
    overlayClosedAfterLeave,
    perfTrace: await page.evaluate(() => Array.isArray(window.__qingzhouPerf) ? window.__qingzhouPerf.slice() : []),
  };
}

async function readDataGridTabState(page) {
  return page.evaluate(() => ({
    identity: document.querySelector(".data-grid-table")?.dataset?.benchmarkIdentity || "",
    sortDirection: document.querySelector(".tabulator-col[tabulator-field='score']")?.getAttribute("aria-sort") || "",
    values: Array.from(document.querySelectorAll(".tabulator-row .tabulator-cell[tabulator-field='score']"))
      .map(cell => cell.textContent?.trim() || ""),
  }));
}

async function runExpandToolRawBenchmark(page, fixture) {
  await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input), fixture);
  const interaction = await page.evaluate(async () => {
    const settle = () => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    const group = Array.from(document.querySelectorAll(".msg-tool-timeline"))
      .find(item => item.querySelector(":scope > .tool-timeline-summary"));
    if (!group) {
      return {
        ok: false,
        reason: "no-tool-timeline",
        expanded: window.qingzhouConversationBenchmark.collectMetrics({ phase: "no-tool-timeline" }),
      };
    }

    const summary = group.querySelector(":scope > .tool-timeline-summary");
    const expandStart = performance.now();
    summary.click();
    const expandClickHandlerMs = performance.now() - expandStart;
    const shellExpandedImmediately = summary.getAttribute("aria-expanded") === "true";
    const bodyRenderedImmediately = Boolean(group.querySelector(".tool-timeline-slot-body"));
    await settle();
    const expandedMs = performance.now() - expandStart;
    const firstBody = group.querySelector(".tool-timeline-slot-body");
    summary.click();
    const repeatStart = performance.now();
    summary.click();
    const repeatClickHandlerMs = performance.now() - repeatStart;
    const slotReused = Boolean(firstBody && firstBody === group.querySelector(".tool-timeline-slot-body"));
    const expanded = window.qingzhouConversationBenchmark.collectMetrics({
      phase: "expanded-without-raw",
      elapsedMs: expandedMs,
    });

    const rawButton = group.querySelector(".tool-timeline-raw-btn:not(.hidden)");
    if (!rawButton) {
      return {
        ok: true,
        reason: "no-raw-button",
        expandedMs,
        expandClickHandlerMs,
        repeatClickHandlerMs,
        shellExpandedImmediately,
        bodyRenderedImmediately,
        slotReused,
        expanded,
      };
    }

    const rawStart = performance.now();
    rawButton.click();
    await settle();
    const rawOpenMs = performance.now() - rawStart;
    const rawOpen = window.qingzhouConversationBenchmark.collectMetrics({
      phase: "raw-open",
      elapsedMs: rawOpenMs,
    });
    return {
      ok: true,
      expandedMs,
      expandClickHandlerMs,
      repeatClickHandlerMs,
      shellExpandedImmediately,
      bodyRenderedImmediately,
      slotReused,
      rawOpenMs,
      activeTitle: group.querySelector(".tool-timeline-slot-title")?.textContent?.trim() || "",
      expanded,
      rawOpen,
    };
  });
  return {
    ...(interaction.expanded || {}),
    benchmark: "expand-tool-raw",
    elapsedMs: interaction.expandedMs || interaction.expanded?.elapsedMs || 0,
    interaction,
  };
}

function buildFixtureStreamReplay(fixture = {}, args = {}) {
  const sourceTranscript = Array.isArray(fixture.transcript) ? fixture.transcript : [];
  const transcript = normalizeStreamExpectedTranscript(sourceTranscript);
  const runId = String(args.streamRunId || "fixture-stream-run");
  const delayMs = numberArg(args.streamDelayMs, 30);
  const messageChunkChars = numberArg(args.streamChunkChars, 28);
  const thinkingChunkChars = numberArg(args.streamThinkingChunkChars, messageChunkChars);
  const argsChunkChars = numberArg(args.streamArgsChunkChars, 512);
  const eventGapMs = numberArg(args.streamEventGapMs, 5);
  const events = [];
  let atMs = 0;
  let eventSeq = 1;
  let userSeq = 1;
  let assistantSeq = 1;
  let thinkingSeq = 1;
  let toolSeq = 1;

  const push = event => {
    events.push({
      runId,
      atMs,
      eventSeq: eventSeq++,
      timestamp: syntheticTimestamp(eventSeq),
      ...event,
    });
  };
  const tick = (ms = eventGapMs) => {
    atMs += Math.max(0, Number(ms) || 0);
  };

  for (const entry of transcript) {
    if (entry.type === "user") {
      push({
        type: "message_start",
        clientMessageId: entry.clientMessageId || `fixture_user_${userSeq++}`,
        message: {
          role: "user",
          content: entry.text || "",
          _origin: "user",
        },
      });
      tick(eventGapMs);
      continue;
    }

    if (entry.type === "thinking") {
      const text = String(entry.text || "");
      for (const chunk of cumulativeTextChunks(text, thinkingChunkChars)) {
        push({
          type: "thinking_update",
          thinking: chunk,
        });
        tick(delayMs);
      }
      if (!text) tick(eventGapMs);
      thinkingSeq += 1;
      continue;
    }

    if (entry.type === "assistant") {
      const content = String(entry.content || "");
      push({
        type: "message_start",
        message: {
          role: "assistant",
          content: "",
        },
      });
      tick(eventGapMs);
      for (const chunk of cumulativeTextChunks(content, messageChunkChars)) {
        push({
          type: "message_update",
          content: chunk,
        });
        tick(delayMs);
      }
      push({
        type: "message_end",
        message: {
          role: "assistant",
          content,
        },
      });
      tick(eventGapMs);
      assistantSeq += 1;
      continue;
    }

    if (entry.type === "tool") {
      const toolCallId = entry.toolCallId || `fixture_tool_${String(toolSeq).padStart(4, "0")}`;
      const spanId = entry.spanId || `fixture_tool_span_${String(toolSeq).padStart(4, "0")}`;
      const toolName = entry.name || "tool";
      const argsText = stableJson(entry.args ?? {});
      for (const chunk of cumulativeTextChunks(argsText, argsChunkChars)) {
        push({
          type: "tool_call_update",
          toolCallId,
          spanId,
          toolName,
          argsText: chunk,
          argsComplete: false,
          phase: "preparing",
        });
        tick(delayMs);
      }
      push({
        type: "tool_call_update",
        toolCallId,
        spanId,
        toolName,
        argsText,
        argsComplete: true,
        phase: "preparing",
      });
      tick(eventGapMs);
      push({
        type: "tool_execution_start",
        toolCallId,
        spanId,
        toolName,
        args: entry.args ?? {},
      });
      tick(eventGapMs);
      push({
        type: "tool_execution_end",
        toolCallId,
        spanId,
        toolName,
        args: entry.args ?? {},
        result: entry.result ?? null,
        isError: entry.isError === true,
      });
      tick(eventGapMs);
      toolSeq += 1;
    }
  }

  push({ type: "agent_end" });
  return {
    name: `${fixture.name || fixture.title || fixture.sessionId || "fixture"} stream`,
    sessionId: `${fixture.sessionId || "fixture"}_stream`,
    title: `${fixture.title || fixture.name || "Fixture"} Stream`,
    transcript: [],
    baseTranscript: [],
    events,
    expectedTranscriptDigest: digestBenchmarkTranscript(transcript).digest,
    expectedTranscript: summarizeExpectedStreamTranscript(transcript),
    stream: {
      source: "fixture-transcript",
      delayMs,
      messageChunkChars,
      thinkingChunkChars,
      argsChunkChars,
      eventGapMs,
      estimatedAtMs: atMs,
    },
  };
}

function streamReplayOptions(args = {}) {
  return {
    timed: boolArg(args.streamTimed, true),
    paceScale: numberArg(args.streamPaceScale, 0.05),
    framePerEvent: boolArg(args.streamFramePerEvent, false),
    finishRun: boolArg(args.streamFinishRun, false),
    yieldEveryEvents: numberArg(args.streamYieldEvery, 25),
    interactionProbe: boolArg(args.streamInteractionProbe, true),
    interactionProbeIntervalMs: numberArg(args.streamInteractionProbeIntervalMs, 24),
    visualStabilityProbe: boolArg(args.streamVisualStabilityProbe, false),
  };
}

function normalizeStreamExpectedTranscript(transcript = []) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((entry, index) => {
      if (entry?.type === "user") {
        return {
          type: "user",
          text: String(entry.text || ""),
          images: Array.isArray(entry.images) ? entry.images : [],
          clientMessageId: entry.clientMessageId || `expected_user_${index}`,
        };
      }
      if (entry?.type === "assistant") {
        return {
          type: "assistant",
          content: String(entry.content || ""),
        };
      }
      if (entry?.type === "thinking") {
        return {
          type: "thinking",
          text: String(entry.text || ""),
        };
      }
      if (entry?.type === "tool") {
        return {
          type: "tool",
          toolCallId: entry.toolCallId || `expected_tool_${index}`,
          spanId: entry.spanId || "",
          name: entry.name || "tool",
          args: entry.args ?? {},
          result: entry.result ?? null,
          isError: entry.isError === true,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function cumulativeTextChunks(text, chunkChars) {
  const chars = Array.from(String(text || ""));
  const size = Math.max(1, Math.round(Number(chunkChars) || 1));
  const chunks = [];
  for (let end = Math.min(size, chars.length); end < chars.length; end += size) {
    chunks.push(chars.slice(0, end).join(""));
  }
  if (chars.length) chunks.push(chars.join(""));
  return chunks;
}

function digestBenchmarkTranscript(transcript = []) {
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter(entry => ["user", "assistant", "thinking", "tool"].includes(entry?.type))
    .map(entry => {
      if (entry.type === "user") {
        return {
          type: "user",
          textHash: qzTextHash(entry.text || ""),
          images: Array.isArray(entry.images) ? entry.images.length : 0,
        };
      }
      if (entry.type === "assistant") {
        return {
          type: "assistant",
          contentHash: qzTextHash(entry.content || ""),
          contentChars: String(entry.content || "").length,
        };
      }
      if (entry.type === "thinking") {
        return {
          type: "thinking",
          textHash: qzTextHash(entry.text || ""),
          textChars: String(entry.text || "").length,
        };
      }
      return {
        type: "tool",
        name: entry.name || "tool",
        argsHash: qzTextHash(stableJson(entry.args ?? {})),
        resultHash: qzTextHash(stableJson(entry.result ?? null)),
        isError: entry.isError === true,
      };
    });
  return {
    digest: qzTextHash(stableJson(entries)),
    count: entries.length,
    roles: entries.reduce((acc, entry) => {
      acc[entry.type] = (acc[entry.type] || 0) + 1;
      return acc;
    }, {}),
  };
}

function summarizeExpectedStreamTranscript(transcript = []) {
  const digest = digestBenchmarkTranscript(transcript);
  return {
    ...digest,
    first: transcript.slice(0, 3).map(summarizeExpectedStreamEntry),
    last: transcript.slice(-3).map(summarizeExpectedStreamEntry),
  };
}

function summarizeExpectedStreamEntry(entry = {}) {
  if (entry.type === "tool") {
    return {
      type: "tool",
      name: entry.name || "tool",
      argsChars: stableJson(entry.args ?? {}).length,
      resultChars: stableJson(entry.result ?? null).length,
    };
  }
  const text = entry.text || entry.content || "";
  return {
    type: entry.type,
    chars: String(text).length,
    hash: qzTextHash(text),
    preview: String(text).slice(0, 120),
  };
}

function qzTextHash(text) {
  let hash = 5381;
  const source = String(text || "");
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolArg(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function syntheticTimestamp(seq) {
  const base = Date.UTC(2026, 6, 10, 0, 0, 0);
  return new Date(base + Math.max(0, Number(seq) || 0) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

async function readSemanticSnapshot(page) {
  const snapshot = await page.evaluate(() => {
    const normalize = value => String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const hashText = value => {
      let hash = 5381;
      const source = String(value || "");
      for (let i = 0; i < source.length; i += 1) {
        hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
      }
      return (hash >>> 0).toString(36);
    };
    const inferType = el => {
      const datasetType = String(el.dataset?.transcriptType || "").trim();
      if (datasetType) return datasetType;
      if (el.classList.contains("msg-user")) return "user";
      if (el.classList.contains("msg-assistant")) return "assistant";
      if (el.classList.contains("msg-thinking")) return "thinking";
      if (el.classList.contains("msg-tool")) return "tool";
      return "unknown";
    };
    const toolName = el => {
      const candidates = [
        ".tool-title",
        ".tool-name",
        ".tool-label",
        ".tool-timeline-title",
        ".tool-summary-title",
        "summary",
      ];
      for (const selector of candidates) {
        const text = normalize(el.querySelector(selector)?.textContent || "");
        if (text) return text.slice(0, 120);
      }
      return "";
    };
    const preview = text => text.length > 180 ? `${text.slice(0, 180)}...` : text;
    const messages = Array.from(document.querySelectorAll("#messages .msg"));
    const items = messages.map((el, index) => {
      const text = normalize(el.innerText || el.textContent || "");
      const pres = Array.from(el.querySelectorAll("pre")).map(pre => normalize(pre.textContent || ""));
      return {
        index,
        type: inferType(el),
        className: Array.from(el.classList).sort().join(" "),
        transcriptKey: String(el.dataset?.transcriptKey || ""),
        toolName: toolName(el),
        collapsed: Boolean(el.querySelector(".tool-details.hidden, .tool-timeline-body.hidden, details:not([open])")),
        hiddenDetails: el.querySelectorAll(".hidden").length,
        preCount: pres.length,
        preHashes: pres.map(item => ({ chars: item.length, hash: hashText(item) })),
        textChars: text.length,
        textHash: hashText(text),
        preview: preview(text),
      };
    });
    const roles = items.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});
    return {
      version: 1,
      title: document.title || "",
      itemCount: items.length,
      roles,
      totalTextChars: items.reduce((sum, item) => sum + item.textChars, 0),
      items,
    };
  });
  snapshot.digest = stableHash({
    version: snapshot.version,
    itemCount: snapshot.itemCount,
    roles: snapshot.roles,
    totalTextChars: snapshot.totalTextChars,
    items: snapshot.items.map(item => ({
      index: item.index,
      type: item.type,
      className: item.className,
      toolName: item.toolName,
      collapsed: item.collapsed,
      hiddenDetails: item.hiddenDetails,
      preCount: item.preCount,
      preHashes: item.preHashes,
      textChars: item.textChars,
      textHash: item.textHash,
    })),
  });
  return snapshot;
}

function summarizeSemanticSnapshot(snapshot = {}) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  return {
    version: snapshot.version || 1,
    digest: snapshot.digest || "",
    itemCount: snapshot.itemCount || items.length,
    roles: snapshot.roles || {},
    totalTextChars: snapshot.totalTextChars || 0,
    first: items.slice(0, 3).map(summarizeSemanticItem),
    last: items.slice(-3).map(summarizeSemanticItem),
  };
}

function summarizeSemanticItem(item = {}) {
  return {
    index: item.index,
    type: item.type,
    toolName: item.toolName || undefined,
    textChars: item.textChars,
    textHash: item.textHash,
    preCount: item.preCount,
    preview: item.preview,
  };
}

function buildHealthReport({ mode, result, longTasks, heap, budgets }) {
  const checks = [];
  const entries = benchmarkResultEntries(mode, result);
  const resultSummaries = entries.map(entry => {
    const traceSummary = summarizePerfTrace(entry.result?.perfTrace || []);
    const dom = entry.result?.dom || {};
    const elapsedLimit = budgetForMode(budgets.elapsedMs, entry.mode);
    const renderLimit = budgetForMode(budgets.renderCalls, entry.mode);
    addBudgetCheck(checks, {
      metric: `${entry.mode}.elapsedMs`,
      value: entry.result?.elapsedMs,
      limit: elapsedLimit,
      unit: "ms",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.renderCalls`,
      value: traceSummary.byName["chat.renderTranscript"]?.count || 0,
      limit: renderLimit,
      unit: "calls",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.dom.nodes`,
      value: dom.nodes,
      limit: budgets.domNodes,
      unit: "nodes",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.dom.spans`,
      value: dom.spans,
      limit: budgets.spans,
      unit: "spans",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.dom.textChars`,
      value: dom.textChars,
      limit: budgets.textChars,
      unit: "chars",
    });
    addStreamHealthChecks(checks, entry, budgets);
    addVisualAuditHealthChecks(checks, entry, budgets);
    return {
      mode: entry.mode,
      elapsedMs: entry.result?.elapsedMs || 0,
      transcriptCount: entry.result?.transcriptCount || 0,
      visibleCount: entry.result?.visibleCount || 0,
      dom,
      stream: entry.result?.stream || null,
      interaction: entry.result?.interaction || null,
      playbackSettle: entry.result?.playbackSettle || null,
      playbackConcurrency: entry.result?.playbackConcurrency || null,
      pagerInteraction: entry.result?.pagerInteraction || null,
      scrollInteraction: entry.result?.scrollInteraction || null,
      visualStability: entry.result?.visualStability || null,
      visualAudit: summarizeVisualAudit(entry.result?.visualAudit),
      traceSummary,
    };
  });

  addBudgetCheck(checks, {
    metric: "longTasks.maxMs",
    value: longTasks?.maxMs,
    limit: budgets.maxLongTaskMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: "longTasks.totalMs",
    value: longTasks?.totalMs,
    limit: budgets.totalLongTaskMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: "heap.jsHeapUsedGrowthMB",
    value: heapGrowthMB(heap),
    limit: budgets.heapGrowthMB,
    unit: "MB",
  });

  const failures = checks.filter(check => check.status === "fail");
  return normalizeNumbers({
    status: failures.length ? "fail" : "pass",
    failures: failures.length,
    checks,
    results: resultSummaries,
  });
}

function addVisualAuditHealthChecks(checks, entry, budgets) {
  const audit = entry.result?.visualAudit;
  if (!audit) return;
  addMinBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.actions`,
    value: audit.actionCount,
    limit: budgets.visualAuditMinActions,
    unit: "actions",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.unexercisedKinds`,
    value: audit.unexercisedKinds,
    limit: budgets.visualAuditMaxUnexercisedKinds,
    unit: "controls",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.clickFailures`,
    value: audit.clickFailures,
    limit: budgets.visualAuditMaxClickFailures,
    unit: "actions",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.errors`,
    value: audit.errorCount,
    limit: budgets.visualAuditMaxErrors,
    unit: "errors",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.warnings`,
    value: audit.warningCount,
    limit: budgets.visualAuditMaxWarnings,
    unit: "warnings",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.stableMovement`,
    value: audit.maxStableMovementPx,
    limit: budgets.visualAuditMaxStableMovementPx,
    unit: "px",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.visualAudit.unexpectedLayoutShift`,
    value: audit.maxUnexpectedLayoutShift,
    limit: budgets.visualAuditMaxUnexpectedLayoutShift,
    unit: "score",
  });
}

function summarizeVisualAudit(audit = null) {
  if (!audit) return null;
  return {
    discoveredKinds: audit.discoveredKinds,
    actionableKinds: audit.actionableKinds,
    exercisedKinds: audit.exercisedKinds,
    unexercisedKinds: audit.unexercisedKinds,
    actionCount: audit.actionCount,
    clickFailures: audit.clickFailures,
    errorCount: audit.errorCount,
    warningCount: audit.warningCount,
    maxStableMovementPx: audit.maxStableMovementPx,
    maxUnexpectedLayoutShift: audit.maxUnexpectedLayoutShift,
  };
}

function addStreamHealthChecks(checks, entry, budgets) {
  const stream = entry.result?.stream;
  if (!stream) return;
  if (stream.transcriptMatches === false) {
    checks.push({
      status: "fail",
      metric: `${entry.mode}.stream.transcriptMatches`,
      value: false,
      limit: true,
      unit: "",
      message: `${entry.mode}.stream.transcriptMatches false`,
    });
  }
  addMinBudgetCheck(checks, {
    metric: `${entry.mode}.stream.livePatch.successRate`,
    value: stream.livePatch?.successRate,
    limit: budgets.streamPatchSuccessRate,
    unit: "ratio",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.livePatch.maxMs`,
    value: stream.livePatch?.durations?.maxMs,
    limit: budgets.streamMaxPatchMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.livePatch.p95Ms`,
    value: stream.livePatch?.durations?.p95Ms,
    limit: budgets.streamP95PatchMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.render.maxMs`,
    value: stream.renderDurations?.maxMs,
    limit: budgets.streamMaxRenderMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.livePatch.fallback`,
    value: stream.livePatch?.fallback,
    limit: budgets.streamLivePatchFallback,
    unit: "calls",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.fullReconcileDuringLive`,
    value: stream.fullReconcileDuringLive,
    limit: budgets.streamFullReconcileDuringLive,
    unit: "calls",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.stream.renderPerEvent`,
    value: stream.renderPerEvent,
    limit: budgets.streamRenderPerEvent,
    unit: "ratio",
  });
  if (entry.result?.playbackSettle?.settled === false) {
    checks.push({
      status: "fail",
      metric: `${entry.mode}.playback.settled`,
      value: false,
      limit: true,
      unit: "",
      message: `${entry.mode}.playback.settled false`,
    });
  }
  addBudgetCheck(checks, {
    metric: `${entry.mode}.playback.maxConcurrent`,
    value: entry.result?.playbackConcurrency?.maxActive,
    limit: budgets.streamMaxConcurrentPlayback,
    unit: "messages",
  });
  const visualStability = entry.result?.visualStability;
  if (visualStability) {
    addBudgetCheck(checks, {
      metric: `${entry.mode}.visualStability.hostAnimationStarts`,
      value: visualStability.hostAnimationStarts,
      limit: budgets.streamMaxHostAnimationStarts,
      unit: "animations",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.visualStability.repeatedHostAnimationStarts`,
      value: visualStability.repeatedHostAnimationStarts,
      limit: budgets.streamMaxRepeatedHostAnimationStarts,
      unit: "animations",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.visualStability.agedHostAnimationStarts`,
      value: visualStability.agedHostAnimationStarts,
      limit: budgets.streamMaxAgedHostAnimationStarts,
      unit: "animations",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.visualStability.frameInterval.p95Ms`,
      value: visualStability.frameInterval?.p95Ms,
      limit: budgets.streamFrameP95Ms,
      unit: "ms",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.visualStability.frameInterval.maxMs`,
      value: visualStability.frameInterval?.maxMs,
      limit: budgets.streamFrameMaxMs,
      unit: "ms",
    });
  }
  const scroll = entry.result?.scrollInteraction;
  if (scroll) {
    if (scroll.monitoredCards != null) {
      addMinBudgetCheck(checks, { metric: `${entry.mode}.scroll.monitoredCards`, value: scroll.monitoredCards, limit: 1, unit: "cards" });
      addBudgetCheck(checks, { metric: `${entry.mode}.scroll.cards.maxDrift`, value: scroll.maxCardDriftPx, limit: budgets.streamScrollMaxCardDriftPx, unit: "px" });
      addBudgetCheck(checks, { metric: `${entry.mode}.scroll.lostCards`, value: scroll.lostCards, limit: 0, unit: "cards" });
    }
    addMinBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.duringReplaySamples`,
      value: scroll.duringReplaySamples,
      limit: budgets.streamScrollMinSamples,
      unit: "samples",
    });
    addMinBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.concurrentSamples`,
      value: scroll.concurrentSamples,
      limit: budgets.streamScrollMinConcurrentSamples,
      unit: "samples",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.anchor.maxDrift`,
      value: scroll.anchor?.maxPx,
      limit: budgets.streamScrollMaxAnchorDriftPx,
      unit: "px",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.lostAnchors`,
      value: scroll.lostAnchors,
      limit: budgets.streamScrollMaxLostAnchors,
      unit: "anchors",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.tailHijacks`,
      value: scroll.tailHijacks,
      limit: budgets.streamScrollMaxTailHijacks,
      unit: "samples",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.maxResumeLagFrames`,
      value: scroll.maxResumeLagFrames,
      limit: budgets.streamScrollMaxResumeLagFrames,
      unit: "frames",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.scroll.resumeFailures`,
      value: scroll.resumeFailures,
      limit: budgets.streamScrollMaxResumeFailures,
      unit: "samples",
    });
  }
  const pager = entry.result?.pagerInteraction;
  if (pager) {
    addMinBudgetCheck(checks, {
      metric: `${entry.mode}.pager.duringReplayClicks`,
      value: pager.duringReplayClicks,
      limit: budgets.streamPagerMinClicks,
      unit: "clicks",
    });
    addMinBudgetCheck(checks, {
      metric: `${entry.mode}.pager.previousClicks`,
      value: pager.directionCounts?.previous,
      limit: budgets.streamPagerMinDirectionClicks,
      unit: "clicks",
    });
    addMinBudgetCheck(checks, {
      metric: `${entry.mode}.pager.nextClicks`,
      value: pager.directionCounts?.next,
      limit: budgets.streamPagerMinDirectionClicks,
      unit: "clicks",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.pager.top.maxDrift`,
      value: pager.top?.maxPx,
      limit: budgets.streamPagerMaxTopDriftPx,
      unit: "px",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.pager.left.maxDrift`,
      value: pager.left?.maxPx,
      limit: budgets.streamPagerMaxLeftDriftPx,
      unit: "px",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.pager.targetLost`,
      value: pager.targetLost,
      limit: budgets.streamPagerMaxLostTargets,
      unit: "targets",
    });
    addBudgetCheck(checks, {
      metric: `${entry.mode}.pager.missingModes`,
      value: pager.missingModeCount,
      limit: budgets.streamPagerMaxMissingModes,
      unit: "modes",
    });
  }
  const interaction = entry.result?.interaction;
  if (!interaction) return;
  addBudgetCheck(checks, {
    metric: `${entry.mode}.interaction.eventLoopDelay.maxMs`,
    value: interaction.eventLoopDelay?.maxMs,
    limit: budgets.streamInteractionMaxDelayMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.interaction.eventLoopDelay.p95Ms`,
    value: interaction.eventLoopDelay?.p95Ms,
    limit: budgets.streamInteractionP95DelayMs,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.interaction.inputHandler.p95Ms`,
    value: interaction.inputHandler?.p95Ms,
    limit: budgets.streamInputHandlerP95Ms,
    unit: "ms",
  });
  addBudgetCheck(checks, {
    metric: `${entry.mode}.interaction.scrollHandler.p95Ms`,
    value: interaction.scrollHandler?.p95Ms,
    limit: budgets.streamScrollHandlerP95Ms,
    unit: "ms",
  });
}

function benchmarkResultEntries(mode, result) {
  if (result?.perfTrace) {
    return [{ mode: result.benchmark || mode, result }];
  }
  if (!result || typeof result !== "object") return [];
  return Object.entries(result)
    .filter(([, value]) => value?.perfTrace)
    .map(([key, value]) => ({ mode: value.benchmark || key, result: value }));
}

function summarizePerfTrace(trace = []) {
  const byName = {};
  for (const item of Array.isArray(trace) ? trace : []) {
    const name = item?.name || "unknown";
    const ms = Number(item?.ms) || 0;
    const row = byName[name] || { count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1;
    row.totalMs += ms;
    row.maxMs = Math.max(row.maxMs, ms);
    byName[name] = row;
  }
  const topByTotal = Object.entries(byName)
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 12);
  return normalizeNumbers({
    traceCount: Array.isArray(trace) ? trace.length : 0,
    byName,
    topByTotal,
  });
}

function addBudgetCheck(checks, { metric, value, limit, unit }) {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return;
  const status = value > limit ? "fail" : "pass";
  checks.push({
    status,
    metric,
    value,
    limit,
    unit,
    message: status === "fail" ? `${metric} ${roundOne(value)}${unit ? ` ${unit}` : ""} > ${roundOne(limit)}${unit ? ` ${unit}` : ""}` : "",
  });
}

function addMinBudgetCheck(checks, { metric, value, limit, unit }) {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return;
  const status = value < limit ? "fail" : "pass";
  checks.push({
    status,
    metric,
    value,
    limit,
    unit,
    message: status === "fail" ? `${metric} ${roundOne(value)}${unit ? ` ${unit}` : ""} < ${roundOne(limit)}${unit ? ` ${unit}` : ""}` : "",
  });
}

function budgetForMode(value, mode) {
  if (value && typeof value === "object") {
    return Number(value[mode] ?? value.default);
  }
  return Number(value);
}

function heapGrowthMB(heap = {}) {
  const before = Number(heap.before?.jsHeapUsedMB ?? heap.before?.performanceUsedMB);
  const after = Number(heap.after?.jsHeapUsedMB ?? heap.after?.performanceUsedMB);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return after - before;
}

function extractVisualAudit(result = null) {
  if (!result || typeof result !== "object") return null;
  if (result.benchmark === "visual-audit" && result.visualAudit) return result.visualAudit;
  if (result.visualAudit?.visualAudit) return result.visualAudit.visualAudit;
  return null;
}

function renderVisualAuditReviewHtml(audit = {}) {
  const actions = Array.isArray(audit.actions) ? audit.actions : [];
  const snapshots = Array.isArray(audit.snapshots) ? audit.snapshots : [];
  const anomalies = Array.isArray(audit.anomalies) ? audit.anomalies : [];
  const coverage = Array.isArray(audit.coverage) ? audit.coverage : [];
  const snapshotsByAction = new Map();
  for (const snapshot of snapshots) {
    const rows = snapshotsByAction.get(snapshot.actionId) || [];
    rows.push(snapshot);
    snapshotsByAction.set(snapshot.actionId, rows);
  }
  const anomaliesByAction = new Map();
  for (const anomaly of anomalies) {
    const key = anomaly.actionId || "global";
    const rows = anomaliesByAction.get(key) || [];
    rows.push(anomaly);
    anomaliesByAction.set(key, rows);
  }
  const summary = [
    ["控件类型", audit.actionableKinds ?? 0],
    ["已点击", audit.exercisedKinds ?? 0],
    ["未覆盖", audit.unexercisedKinds ?? 0],
    ["点击失败", audit.clickFailures ?? 0],
    ["错误", audit.errorCount ?? 0],
    ["警告", audit.warningCount ?? 0],
    ["意外位移", Number(audit.maxUnexpectedLayoutShift || 0).toFixed(4)],
  ].map(([label, value]) => `<div class="metric"><span>${escapeAuditHtml(label)}</span><strong>${escapeAuditHtml(value)}</strong></div>`).join("");
  const actionCards = actions.map(action => {
    const rows = snapshotsByAction.get(action.actionId) || [];
    const actionAnomalies = anomaliesByAction.get(action.actionId) || [];
    const status = !action.clicked || action.clickError || actionAnomalies.some(item => item.severity === "error") ? "fail" : "pass";
    const frames = rows.map(snapshot => `
      <figure>
        <a href="${escapeAuditHtml(snapshot.relativePath || snapshot.path || "")}"><img loading="lazy" src="${escapeAuditHtml(snapshot.relativePath || snapshot.path || "")}" alt="${escapeAuditHtml(snapshot.phase || snapshot.name || "frame")}"></a>
        <figcaption>${escapeAuditHtml(snapshot.phase || snapshot.name || "frame")}</figcaption>
      </figure>
    `).join("");
    const anomalyList = actionAnomalies.length
      ? `<ul class="anomalies">${actionAnomalies.map(item => `<li class="${escapeAuditHtml(item.severity || "warning")}"><code>${escapeAuditHtml(item.code || "anomaly")}</code> ${escapeAuditHtml(item.message || "")}</li>`).join("")}</ul>`
      : "";
    return `
      <article class="action-card ${status}">
        <header>
          <div><span class="status-dot"></span><strong>${escapeAuditHtml(action.label || action.signature || action.actionId)}</strong></div>
          <span>${escapeAuditHtml(action.rootId || "")} · ${escapeAuditHtml(Number(action.stableMovementPx || 0).toFixed(2))} px</span>
        </header>
        <code class="signature">${escapeAuditHtml(action.signature || "")}</code>
        ${action.clickError ? `<p class="click-error">${escapeAuditHtml(action.clickError)}</p>` : ""}
        ${anomalyList}
        <div class="frames">${frames}</div>
      </article>
    `;
  }).join("");
  const coverageRows = coverage.map(item => `
    <tr>
      <td><span class="coverage-mark ${item.exercised ? "covered" : "missing"}"></span>${escapeAuditHtml(item.label || item.signature || "")}</td>
      <td><code>${escapeAuditHtml(item.signature || "")}</code></td>
      <td>${escapeAuditHtml((item.roots || []).join(", "))}</td>
      <td>${item.exercised ? "已点击" : item.enabled ? "未覆盖" : item.visible ? "禁用" : "隐藏"}</td>
    </tr>
  `).join("");
  const globalAnomalies = anomaliesByAction.get("global") || [];
  const globalBlock = globalAnomalies.length ? `
    <section class="global-anomalies">
      <h2>全局异常</h2>
      <ul class="anomalies">${globalAnomalies.map(item => `<li class="${escapeAuditHtml(item.severity || "warning")}"><code>${escapeAuditHtml(item.code || "anomaly")}</code> ${escapeAuditHtml(item.message || "")}</li>`).join("")}</ul>
    </section>
  ` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>轻舟 Chat 视觉审计</title>
  <style>
    :root { color-scheme: light dark; --bg:#f7f8f8; --panel:#fff; --line:#e5e8e7; --text:#202423; --muted:#7a8280; --ok:#2f8f70; --bad:#b94b4b; --warn:#9b762e; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--text); background:var(--bg); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1500px,100%); margin:auto; padding:32px; }
    h1 { margin:0; font-size:24px; letter-spacing:0; }
    h2 { margin:32px 0 12px; font-size:17px; letter-spacing:0; }
    .lede { color:var(--muted); margin:4px 0 22px; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); gap:1px; border:1px solid var(--line); background:var(--line); }
    .metric { padding:13px 15px; background:var(--panel); }
    .metric span { display:block; color:var(--muted); font-size:12px; }
    .metric strong { display:block; margin-top:2px; font-size:21px; }
    .action-list { display:grid; gap:12px; }
    .action-card { border:1px solid var(--line); background:var(--panel); overflow:hidden; }
    .action-card > header { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); }
    .action-card > header > span { color:var(--muted); white-space:nowrap; }
    .status-dot,.coverage-mark { display:inline-block; width:7px; height:7px; margin-right:8px; border-radius:50%; background:var(--ok); vertical-align:1px; }
    .fail .status-dot,.coverage-mark.missing { background:var(--bad); }
    .signature { display:block; padding:9px 14px 0; color:var(--muted); overflow-wrap:anywhere; }
    .click-error { color:var(--bad); margin:8px 14px; }
    .frames { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; margin-top:10px; background:var(--line); border-top:1px solid var(--line); }
    figure { margin:0; background:var(--panel); min-width:0; }
    figure a { display:block; aspect-ratio:430/900; overflow:hidden; background:#eef0ef; }
    figure img { width:100%; height:100%; display:block; object-fit:contain; object-position:top; }
    figcaption { padding:7px 10px; color:var(--muted); border-top:1px solid var(--line); }
    .anomalies { margin:8px 14px; padding-left:20px; }
    .anomalies li { margin:3px 0; }
    .anomalies .error { color:var(--bad); }
    .anomalies .warning { color:var(--warn); }
    .coverage-wrap { overflow:auto; border:1px solid var(--line); background:var(--panel); }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:9px 11px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:12px; font-weight:600; }
    td code { overflow-wrap:anywhere; }
    @media (max-width:760px) { main{padding:18px}.metrics{grid-template-columns:repeat(3,1fr)}.frames{grid-template-columns:1fr}.action-card>header{align-items:flex-start;flex-direction:column}.action-card>header>span{white-space:normal} }
    @media (prefers-color-scheme:dark) { :root{--bg:#141716;--panel:#1b1f1e;--line:#303533;--text:#edf0ef;--muted:#9ba3a0;--ok:#65b99a;--bad:#e57a7a;--warn:#d5ad62} figure a{background:#111413} }
  </style>
</head>
<body><main>
  <h1>Chat 视觉交互审计</h1>
  <p class="lede">逐个恢复状态并点击控件，记录点击前、首帧和稳定帧。新增控件未覆盖、点击失败、遮挡、溢出和稳定后位移都会进入报告。</p>
  <section class="metrics">${summary}</section>
  ${globalBlock}
  <h2>交互帧</h2>
  <section class="action-list">${actionCards || "<p>没有可执行控件。</p>"}</section>
  <h2>覆盖矩阵</h2>
  <div class="coverage-wrap"><table><thead><tr><th>控件</th><th>稳定标识</th><th>状态根</th><th>结果</th></tr></thead><tbody>${coverageRows}</tbody></table></div>
</main></body></html>`;
}

function escapeAuditHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function writeBenchmarkArtifacts(page, dir, {
  semanticSnapshot,
  captureVisuals = true,
  visualAudit = null,
  interactionSnapshots = [],
} = {}) {
  mkdirSync(dir, { recursive: true });
  const semanticPath = join(dir, "semantic-snapshot.json");
  writeJsonFile(semanticPath, semanticSnapshot);
  const artifacts = {
    dir,
    semanticSnapshot: semanticPath,
    visualSnapshots: [],
    interactionSnapshots: Array.isArray(interactionSnapshots) ? interactionSnapshots : [],
  };
  if (captureVisuals) {
    artifacts.visualSnapshots = await captureVisualSnapshots(page, join(dir, "screenshots"));
    writeJsonFile(join(dir, "visual-snapshots.json"), artifacts.visualSnapshots);
  }
  if (artifacts.interactionSnapshots.length || visualAudit) {
    artifacts.interactionSnapshotManifest = join(dir, "interaction-visual-snapshots.json");
    writeJsonFile(artifacts.interactionSnapshotManifest, artifacts.interactionSnapshots);
  }
  if (visualAudit) {
    artifacts.visualAudit = join(dir, "visual-audit.json");
    artifacts.visualAuditReview = join(dir, "visual-audit.html");
    writeJsonFile(artifacts.visualAudit, visualAudit);
    writeFileSync(artifacts.visualAuditReview, renderVisualAuditReviewHtml(visualAudit), "utf8");
  }
  return artifacts;
}

async function captureVisualSnapshots(page, dir) {
  mkdirSync(dir, { recursive: true });
  await stabilizeVisualSnapshotPage(page);
  const metrics = await page.evaluate(() => {
    const el = document.querySelector("#messages");
    const scrollHeight = el?.scrollHeight || document.documentElement.scrollHeight || 0;
    const clientHeight = el?.clientHeight || window.innerHeight || 0;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    return {
      scrollHeight,
      clientHeight,
      positions: [
        { name: "top", y: 0 },
        { name: "middle", y: Math.round(maxScroll / 2) },
        { name: "bottom", y: maxScroll },
      ],
    };
  });
  const snapshots = [];
  for (const position of metrics.positions) {
    await page.evaluate(y => {
      const el = document.querySelector("#messages");
      if (el) el.scrollTop = y;
      window.scrollTo(0, 0);
    }, position.y);
    await page.waitForTimeout(80);
    const path = join(dir, `${position.name}.png`);
    await page.screenshot({ path, fullPage: false });
    snapshots.push({
      name: position.name,
      path,
      relativePath: `screenshots/${position.name}.png`,
      scrollTop: position.y,
      scrollHeight: metrics.scrollHeight,
      clientHeight: metrics.clientHeight,
      hash: fileHash(path),
      ...readImageSize(path),
    });
  }
  return snapshots;
}

async function stabilizeVisualSnapshotPage(page) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    let style = document.querySelector("#conversation-benchmark-visual-stability-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "conversation-benchmark-visual-stability-style";
      style.textContent = `
        *,
        *::before,
        *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          caret-color: transparent !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `;
      document.head.appendChild(style);
    }
  });
  await page.waitForTimeout(120);
}

function compareBenchmarkBaseline({ baselineDir, current, budgets }) {
  const comparison = {
    status: "pass",
    baselineDir,
    semantic: null,
    visuals: [],
    interactionInventory: null,
    interactionVisuals: [],
    missing: [],
  };
  if (!baselineDir || !existsSync(baselineDir)) {
    comparison.status = "fail";
    comparison.missing.push(baselineDir || "(empty baseline dir)");
    return comparison;
  }

  const semanticPath = join(baselineDir, "semantic-snapshot.json");
  if (!existsSync(semanticPath)) {
    comparison.status = "fail";
    comparison.missing.push(semanticPath);
  } else {
    const baselineSemantic = JSON.parse(readFileSync(semanticPath, "utf8"));
    comparison.semantic = compareSemanticSnapshots(current.semanticSnapshot, baselineSemantic);
    if (comparison.semantic.status === "fail") comparison.status = "fail";
  }

  const visualPath = join(baselineDir, "visual-snapshots.json");
  if (!existsSync(visualPath)) {
    comparison.status = "fail";
    comparison.missing.push(visualPath);
  } else {
    const baselineVisuals = JSON.parse(readFileSync(visualPath, "utf8"));
    comparison.visuals = compareVisualSnapshots({
      baselineDir,
      baselineVisuals,
      currentVisuals: current.artifacts?.visualSnapshots || [],
      visualDiffRatio: budgets.visualDiffRatio,
    });
    if (comparison.visuals.some(item => item.status === "fail")) comparison.status = "fail";
  }
  const interactionVisualPath = join(baselineDir, "interaction-visual-snapshots.json");
  const currentInteractionVisuals = current.artifacts?.interactionSnapshots || [];
  if (currentInteractionVisuals.length || existsSync(interactionVisualPath)) {
    if (!existsSync(interactionVisualPath)) {
      comparison.status = "fail";
      comparison.missing.push(interactionVisualPath);
    } else {
      const baselineInteractionVisuals = JSON.parse(readFileSync(interactionVisualPath, "utf8"));
      comparison.interactionInventory = compareVisualSnapshotInventory(
        baselineInteractionVisuals,
        currentInteractionVisuals,
      );
      if (comparison.interactionInventory.status === "fail") comparison.status = "fail";
      comparison.interactionVisuals = compareVisualSnapshots({
        baselineDir,
        baselineVisuals: baselineInteractionVisuals.filter(isStableInteractionSnapshot),
        currentVisuals: currentInteractionVisuals.filter(isStableInteractionSnapshot),
        visualDiffRatio: budgets.interactionVisualDiffRatio,
      });
      if (comparison.interactionVisuals.some(item => item.status === "fail")) comparison.status = "fail";
    }
  }
  return normalizeNumbers(comparison);
}

function compareVisualSnapshotInventory(baselineVisuals = [], currentVisuals = []) {
  const baselineNames = new Set(baselineVisuals.map(item => item.name));
  const currentNames = new Set(currentVisuals.map(item => item.name));
  const missingCurrent = Array.from(baselineNames).filter(name => !currentNames.has(name)).sort();
  const missingBaseline = Array.from(currentNames).filter(name => !baselineNames.has(name)).sort();
  return {
    status: missingCurrent.length || missingBaseline.length ? "fail" : "pass",
    baselineCount: baselineNames.size,
    currentCount: currentNames.size,
    missingCurrent,
    missingBaseline,
  };
}

function isStableInteractionSnapshot(snapshot = {}) {
  return snapshot.phase === "before" || snapshot.phase === "settled";
}

function compareSemanticSnapshots(current = {}, baseline = {}) {
  if (current.digest === baseline.digest) {
    return {
      status: "pass",
      digest: current.digest,
      itemCount: current.itemCount,
    };
  }
  const currentItems = Array.isArray(current.items) ? current.items : [];
  const baselineItems = Array.isArray(baseline.items) ? baseline.items : [];
  const max = Math.max(currentItems.length, baselineItems.length);
  let firstMismatch = null;
  for (let i = 0; i < max; i += 1) {
    const a = semanticComparableItem(currentItems[i]);
    const b = semanticComparableItem(baselineItems[i]);
    if (stableJson(a) !== stableJson(b)) {
      firstMismatch = { index: i, current: a, baseline: b };
      break;
    }
  }
  return {
    status: "fail",
    currentDigest: current.digest,
    baselineDigest: baseline.digest,
    currentItemCount: current.itemCount,
    baselineItemCount: baseline.itemCount,
    firstMismatch,
  };
}

function semanticComparableItem(item = null) {
  if (!item) return null;
  return {
    type: item.type,
    className: item.className,
    toolName: item.toolName,
    collapsed: item.collapsed,
    hiddenDetails: item.hiddenDetails,
    preCount: item.preCount,
    preHashes: item.preHashes,
    textChars: item.textChars,
    textHash: item.textHash,
    preview: item.preview,
  };
}

function compareVisualSnapshots({ baselineDir = "", baselineVisuals = [], currentVisuals = [], visualDiffRatio }) {
  const currentByName = new Map(currentVisuals.map(item => [item.name, item]));
  const baselineNames = new Set(baselineVisuals.map(item => item.name));
  const comparisons = baselineVisuals.map(baseline => {
    const current = currentByName.get(baseline.name);
    if (!current) {
      return { name: baseline.name, status: "fail", reason: "missing current screenshot" };
    }
    if (current.hash === baseline.hash) {
      return { name: baseline.name, status: "pass", exact: true, hash: current.hash };
    }
    const diff = compareImagesWithMagick(resolveVisualSnapshotPath(baselineDir, baseline), current.path);
    if (diff.available) {
      const ratio = diff.totalPixels ? diff.diffPixels / diff.totalPixels : 1;
      return {
        name: baseline.name,
        status: ratio <= visualDiffRatio ? "pass" : "fail",
        exact: false,
        diffPixels: diff.diffPixels,
        totalPixels: diff.totalPixels,
        diffRatio: ratio,
        limit: visualDiffRatio,
      };
    }
    return {
      name: baseline.name,
      status: "fail",
      exact: false,
      reason: "screenshot hash changed and ImageMagick compare is unavailable",
      baselineHash: baseline.hash,
      currentHash: current.hash,
    };
  });
  for (const current of currentVisuals) {
    if (baselineNames.has(current.name)) continue;
    comparisons.push({
      name: current.name,
      status: "fail",
      reason: "missing baseline screenshot",
      currentHash: current.hash,
    });
  }
  return comparisons;
}

function resolveVisualSnapshotPath(baselineDir, snapshot = {}) {
  if (snapshot.relativePath) {
    const relative = resolve(baselineDir, snapshot.relativePath);
    if (existsSync(relative)) return relative;
  }
  if (snapshot.path && existsSync(snapshot.path)) return snapshot.path;
  return snapshot.path || "";
}

function compareImagesWithMagick(baselinePath, currentPath) {
  const magick = findImageMagickExecutable();
  if (!magick || !existsSync(baselinePath) || !existsSync(currentPath)) {
    return { available: false };
  }
  try {
    const size = readImageSize(currentPath);
    const totalPixels = Number(size.width) * Number(size.height);
    execFileSync(magick, ["compare", "-metric", "AE", baselinePath, currentPath, "null:"], { stdio: "pipe" });
    return { available: true, diffPixels: 0, totalPixels };
  } catch (err) {
    const stderr = String(err?.stderr || "");
    const diffPixels = Number(stderr.match(/\d+/)?.[0]);
    const size = readImageSize(currentPath);
    const totalPixels = Number(size.width) * Number(size.height);
    return {
      available: Number.isFinite(diffPixels),
      diffPixels: Number.isFinite(diffPixels) ? diffPixels : null,
      totalPixels: Number.isFinite(totalPixels) ? totalPixels : null,
    };
  }
}

function readFixture(file) {
  const absolute = resolve(file);
  const text = readFileSync(absolute, "utf8");
  if (/\.html?$/i.test(absolute)) {
    return parseExportHtmlFixture(text, {
      sessionId: basenameWithoutExtension(absolute),
      title: basenameWithoutExtension(absolute),
    });
  }
  return JSON.parse(text);
}

function installBenchmarkChromeStub() {
  const storageData = { qz_data_consent: { version: 1, acceptedAt: 1 } };
  const storageListeners = [];
  const composerDrafts = {};
  const clone = value => {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  };
  const normalizeKeys = keys => {
    if (keys == null) return null;
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    if (typeof keys === "object") return Object.keys(keys);
    return [];
  };
  const notifyStorage = changes => {
    if (!Object.keys(changes).length) return;
    for (const listener of storageListeners) {
      try { listener(changes, "local"); } catch (_err) {}
    }
  };
  window.__QZ_CONVERSATION_BENCHMARK__ = true;
  window.__qzBenchMessages = [];
  window.__qzBenchLongTasks = [];
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__qzBenchLongTasks.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (_err) {}

  window.chrome = {
    runtime: {
      connect() {
        const messageListeners = [];
        return {
          postMessage(message) {
            window.__qzBenchMessages.push(clone(message));
            let response = null;
            if (message?.type === "get_config") {
              response = { type: "config", config: { provider: "benchmark", model: "benchmark" } };
            } else if (message?.type === "sync_composer_draft") {
              const sessionId = String(message.sessionId || "");
              composerDrafts[sessionId] = clone(message.draft);
              response = {
                type: "sync_composer_draft_result",
                sessionId,
                draft: clone(composerDrafts[sessionId]),
              };
            } else if (message?.type === "get_composer_draft") {
              const sessionId = String(message.sessionId || "");
              response = {
                type: "get_composer_draft_result",
                sessionId,
                draft: clone(composerDrafts[sessionId]) || null,
              };
            } else if (message?.type === "steer_follow_up") {
              response = {
                type: "follow_up_steered",
                moved: true,
                pendingFollowUps: [],
                pendingSteerings: [],
              };
            }
            if (response) {
              setTimeout(() => {
                for (const listener of messageListeners) {
                  listener({ ...response, requestId: message.requestId });
                }
              }, 0);
            }
          },
          onDisconnect: { addListener() {} },
          onMessage: { addListener(fn) { if (typeof fn === "function") messageListeners.push(fn); } },
        };
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(storageData);
          if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map(key => [key, clone(storageData[key])]));
          }
          if (typeof keys === "object") {
            return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
              key,
              storageData[key] === undefined ? clone(fallback) : clone(storageData[key]),
            ]));
          }
          return {};
        },
        async set(values = {}) {
          const changes = {};
          for (const [key, value] of Object.entries(values || {})) {
            changes[key] = { oldValue: clone(storageData[key]), newValue: clone(value) };
            storageData[key] = clone(value);
          }
          notifyStorage(changes);
        },
        async remove(keys) {
          const list = normalizeKeys(keys) || [];
          const changes = {};
          for (const key of list) {
            changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
            delete storageData[key];
          }
          notifyStorage(changes);
        },
        async clear() {
          const changes = {};
          for (const key of Object.keys(storageData)) {
            changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
            delete storageData[key];
          }
          notifyStorage(changes);
        },
      },
      onChanged: {
        addListener(fn) { if (typeof fn === "function") storageListeners.push(fn); },
      },
    },
    downloads: {
      async download() { return 1; },
      async search() { return []; },
      open() {},
      show() {},
    },
    tabs: {
      async create() { return { id: 1 }; },
      async query() { return []; },
    },
    desktopCapture: {
      chooseDesktopMedia() { return null; },
    },
  };
}

async function startStaticServer(root) {
  const extensionDir = await ensureTestExtension();
  await prepareBenchmarkAssets(extensionDir);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const requested = decodeURIComponent(url.pathname);
      const file = resolveTestAsset(requested === "/" ? "/extension/sidepanel/sidepanel.html" : requested, { root, extensionDir });
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(file) });
      res.end(readFileSync(file));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal server error");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function readLongTaskSummary(page) {
  return page.evaluate(() => {
    const items = Array.isArray(window.__qzBenchLongTasks) ? window.__qzBenchLongTasks : [];
    const total = items.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const max = items.reduce((value, item) => Math.max(value, Number(item.duration) || 0), 0);
    return { count: items.length, totalMs: total, maxMs: max };
  });
}

async function resetLongTaskSummary(page) {
  await page.evaluate(() => {
    if (Array.isArray(window.__qzBenchLongTasks)) window.__qzBenchLongTasks.length = 0;
  });
}

function diffLongTasks(before = {}, after = {}) {
  return normalizeNumbers({
    count: (after.count || 0) - (before.count || 0),
    totalMs: (after.totalMs || 0) - (before.totalMs || 0),
    maxMs: Math.max(0, after.maxMs || 0),
  });
}

async function maybeWriteScreenshot(page, requested) {
  if (!requested) return "";
  const target = requested === true
    ? "/tmp/qingzhou-conversation-render-benchmark.png"
    : resolve(String(requested));
  mkdirSync(dirname(target), { recursive: true });
  if (args.fullPage === true) await expandConversationForFullPageScreenshot(page);
  await page.screenshot({
    path: target,
    fullPage: args.fullPage === true,
  });
  return target;
}

async function expandConversationForFullPageScreenshot(page) {
  await page.evaluate(() => {
    const messages = document.querySelector("#messages");
    const app = document.querySelector("#app");
    const dock = document.querySelector("#chat-dock");
    const style = document.createElement("style");
    style.id = "conversation-benchmark-fullpage-style";
    style.textContent = `
      html,
      body {
        height: auto !important;
        min-height: 100% !important;
        overflow: visible !important;
      }
      #app {
        height: auto !important;
        min-height: 100% !important;
        overflow: visible !important;
      }
      #messages {
        flex: none !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
      }
      #chat-dock {
        position: static !important;
      }
    `;
    document.head.appendChild(style);
    if (messages) {
      messages.scrollTop = 0;
      messages.style.height = `${messages.scrollHeight}px`;
      messages.style.overflow = "visible";
    }
    if (app) app.style.overflow = "visible";
    if (dock) dock.scrollIntoView({ block: "end" });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(50);
}

async function readHeap(page, cdp) {
  const heap = {
    jsHeapUsedMB: null,
    jsHeapTotalMB: null,
    performanceUsedMB: null,
    performanceTotalMB: null,
  };
  try {
    await cdp.send("HeapProfiler.collectGarbage");
  } catch (_err) {}
  try {
    const metrics = await cdp.send("Performance.getMetrics");
    const byName = new Map(metrics.metrics.map(metric => [metric.name, metric.value]));
    heap.jsHeapUsedMB = roundBytes(byName.get("JSHeapUsedSize"));
    heap.jsHeapTotalMB = roundBytes(byName.get("JSHeapTotalSize"));
  } catch (_err) {}
  try {
    const memory = await page.evaluate(() => {
      const item = performance.memory;
      return item
        ? { used: item.usedJSHeapSize, total: item.totalJSHeapSize, limit: item.jsHeapSizeLimit }
        : null;
    });
    if (memory) {
      heap.performanceUsedMB = roundBytes(memory.used);
      heap.performanceTotalMB = roundBytes(memory.total);
      heap.performanceLimitMB = roundBytes(memory.limit);
    }
  } catch (_err) {}
  return heap;
}

function readHealthBudgets(file) {
  const budgets = JSON.parse(JSON.stringify(DEFAULT_HEALTH_BUDGETS));
  if (!file) return budgets;
  const override = JSON.parse(readFileSync(resolve(String(file)), "utf8"));
  return mergeBudgets(budgets, override);
}

function resolveBaselineDir(args, fixture, mode) {
  if (args.baselineDir) return resolve(String(args.baselineDir));
  const viewport = mode === "visual-audit" ? `${viewportSlug()}-${COLOR_SCHEME}` : viewportSlug();
  return join(ROOT, "tests/benchmarks/conversation-render/baselines", fixtureSlug(fixture), viewport, mode);
}

function resolveArtifactDir(args, fixture, mode, baselineDir) {
  if (args.artifactDir) return resolve(String(args.artifactDir));
  if (args.updateBaseline === true) return baselineDir;
  if (args.compareBaseline === true) {
    return join("/tmp/qingzhou-conversation-render", fixtureSlug(fixture), viewportSlug(), `${mode}-${timestampSlug()}`);
  }
  if (mode === "visual-audit") {
    return join("/tmp/qingzhou-conversation-visual-audit", fixtureSlug(fixture), `${viewportSlug()}-${COLOR_SCHEME}`, timestampSlug());
  }
  return "";
}

function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function stableHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function readImageSize(file) {
  const magick = findImageMagickExecutable();
  if (!magick) return { width: null, height: null };
  try {
    const output = execFileSync(magick, ["identify", "-format", "%w %h", file], { encoding: "utf8" }).trim();
    const [width, height] = output.split(/\s+/).map(Number);
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    };
  } catch (_err) {
    return { width: null, height: null };
  }
}

function findImageMagickExecutable() {
  const candidates = [
    process.env.MAGICK_EXECUTABLE,
    "/opt/homebrew/bin/magick",
    "/usr/local/bin/magick",
    "/usr/bin/magick",
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || "";
}

function fixtureSlug(fixture = {}) {
  return slugify(fixture.name || fixture.title || fixture.sessionId || "fixture");
}

function viewportSlug() {
  return `${VIEWPORT.width}x${VIEWPORT.height}`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(value) {
  return String(value || "item")
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    || "item";
}

function parseArgs(argv) {
  const booleanArgs = new Set([
    "help",
    "realExamples",
    "json",
    "fullPage",
    "updateBaseline",
    "compareBaseline",
    "failOnHealth",
    "streamFramePerEvent",
    "streamFinishRun",
    "disableSyntaxHighlight",
  ]);
  const optionalBooleans = new Set(["streamTimed", "streamInteractionProbe", "streamDisableMessageMotion", "streamVisualStabilityProbe"]);
  const valueArgs = new Set([
    "fixture", "mode", "screenshot", "artifactDir", "baselineDir", "budget", "colorScheme",
    "expandToolTimelineEveryEvents", "expandToolTimelineLimit", "streamArgsChunkChars", "streamChunkChars",
    "streamDelayMs", "streamEventGapMs", "streamInteractionProbeIntervalMs", "streamPaceScale",
    "streamPagerClicksPerMode", "streamPagerIntervalMs", "streamRunId", "streamScrollHoldMs", "streamFuzzSeed",
    "streamThinkingChunkChars", "streamYieldEvery", "visualAuditMaxActions", "visualAuditMaxDepth", "visualAuditSettleMs",
  ]);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (arg === "-h") { out.help = true; continue; }
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-")) throw new Error(`Unknown benchmark option: ${arg}`);
      out._.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const rawKey = arg.slice(2, equals < 0 ? undefined : equals);
    const rawValue = equals < 0 ? undefined : arg.slice(equals + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!booleanArgs.has(key) && !optionalBooleans.has(key) && !valueArgs.has(key)) throw new Error(`Unknown benchmark option: --${rawKey}`);
    if (valueArgs.has(key) && (rawValue === "" || rawValue == null && (!argv[i + 1] || argv[i + 1].startsWith("-")))) throw new Error(`--${rawKey} requires a value`);
    if (rawValue != null) out[key] = rawValue;
    else if (booleanArgs.has(key)) out[key] = true;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  if (out._.length > 1) throw new Error("Only one conversation fixture can be selected");
  return out;
}

function normalizeColorScheme(value) {
  return String(value || "light").trim().toLowerCase() === "dark" ? "dark" : "light";
}

function isIgnorableConsoleError(text = "") {
  const value = String(text || "");
  return /^Failed to load resource: the server responded with a status of 404 \(Not Found\)/.test(value);
}

function normalizeNumbers(value) {
  if (typeof value === "number") return normalizeNumber(value);
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNumbers(item)]));
}

function normalizeNumber(value) {
  if (!Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1) return Math.round(value * 1_000_000) / 1_000_000;
  return Math.round(value * 10) / 10;
}

function roundBytes(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value / 1024 / 1024 * 10) / 10;
}

function roundOne(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10) / 10;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function basenameWithoutExtension(file) {
  return file.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const explicitPath = process.env.PLAYWRIGHT_PATH || "";
    if (explicitPath) return import(pathToFileURL(explicitPath).href);
    throw new Error("Conversation benchmark requires Playwright; run npm ci or set PLAYWRIGHT_PATH.", { cause: error });
  }
}

function findChromeExecutable(bundled = "") {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    bundled,
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || "";
}

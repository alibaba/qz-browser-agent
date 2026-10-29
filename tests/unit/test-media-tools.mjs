import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

let tabPageUrl = "https://example.test/";
let mainDocumentId = "";
let browserZoom = 1;
let browserZoomError = null;
globalThis.chrome = {
  scripting: {
    async executeScript({ func, args }) {
      if (measurementUnavailable && typeof args?.[0] === 'boolean') throw new Error("Cannot measure this page");
      return [{ documentId: mainDocumentId, result: runInNewContext(`(${func})(...(args || []))`, { args: args || [],
        document: { readyState: 'complete' },
        innerWidth: viewportState.clientWidth, innerHeight: viewportState.clientHeight,
        outerWidth: 412, outerHeight: 915, visualViewport: { scale: viewportState.scale },
      }) }];
    },
  },
  tabs: {
    async get(tabId) { return { id: tabId, windowId: 2, url: tabPageUrl, title: "Example", width: viewportState.clientWidth, height: viewportState.clientHeight }; },
    async getZoom() { if (browserZoomError) throw browserZoomError; return browserZoom; },
    async query() { return [{ id: 9, windowId: 2, active: true }]; },
    async update(tabId, update) { updates.push([tabId, update]); return { id: tabId, ...update }; },
    async captureVisibleTab() { return "data:image/jpeg;base64,dmlzaWJsZQ=="; },
  },
};

const { registerMediaTools } = await import("../../src/capabilities/media/tools.js");
const { createScreenActionRuntime } = await import("../../src/capabilities/media/screen-action-runtime.js");
const { runToolWithTimeout } = await import("../../src/background/tools/tool-timeout.js");
const { clearTraceLog, getTraceLog } = await import("../../src/background/trace.js");
await clearTraceLog();

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function settleWithin(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const definitions = new Map();
const updates = [];
const cdpCalls = [];
const elementRefs = new Map();
let cdpFailure = false;
let mobileMode = false;
let measurementUnavailable = false;
let fakeNow = 1000;
let frameLoaderId = "loader-a";
let viewportState = { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0, scale: 1 };
// These transport tests use synthetic encoded strings; browser tests exercise actual decoding.
globalThis.createImageBitmap = async blob => ({ width: viewportState.clientWidth, height: viewportState.clientHeight, data: await blob.text(), close() {} });
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { drawImage: image => { this.image = image; } }; }
  async convertToBlob({ type }) { return new Blob([this.image?.data || 'cdp'], { type }); }
};
let layoutMetricsSequence = [];
let onCdpCall = null;
let guardrailReads = 0;
let blockImageUrl = false;
let nextAssetId = 1;
const storedImageRows = new Map();
const imageMetadataWrites = [];
const imageUpserts = [];
let imageWriteError = null;
let bindBackendNodesImpl = async (_tabId, selectors = []) => ({ loaderId: "", ids: selectors.map(() => 0) });
let readImageDataUrl = "data:image/png;base64,aW1hZ2U=";
let readImageFailure = null;
let listImageResults = [];
let listedImages = [{
  index: 4,
  rank: 0,
  selector: "#gallery > img.hero",
  src: "https://example.test/hero-a.png",
  currentSrc: "https://example.test/hero-a.png",
  alt: "Hero",
  title: "",
  context: {
    accessibleName: "Featured campus portrait",
    caption: "Taken during the CMU years",
    heading: "Research profile",
    linkText: "Open profile",
    linkTitle: "View the complete profile",
    linkUrl: "https://example.test/profile",
    nearbyText: "Research profile · Taken during the CMU years",
    privateField: "must not escape the projection",
  },
  naturalWidth: 800,
  naturalHeight: 600,
  visible: true,
}];
const runtime = registerMediaTools({
  getPageContext: () => ({ pageMode: mobileMode ? "mobile" : "desktop" }),
  registerTool({ name, description, parameters, execute, validateArgs }) { definitions.set(name, { description, parameters, execute, validateArgs }); },
  ToolExecutionError,
  getToolRuntimeDependencies() { return {}; },
  async queryDataRows({ table }) {
    const rows = storedImageRows.get(table) || [];
    return {
      rows: rows.map((data, index) => ({ id: `${table}:${index + 1}`, data: { ...data } })),
      totalMatched: rows.length,
    };
  },
  async updateDataTableMetadata(table, metadata) {
    imageMetadataWrites.push({ table, metadata });
  },
  async upsertDataRows(table, rows, { dedupField = "sourceKey" } = {}) {
    if (imageWriteError) throw imageWriteError;
    imageUpserts.push({ table, dedupField });
    const stored = storedImageRows.get(table) || [];
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const existingIndex = stored.findIndex(item => item[dedupField] === row[dedupField]);
      if (existingIndex >= 0) {
        stored[existingIndex] = { ...row };
        updated += 1;
      } else {
        stored.push({ ...row });
        inserted += 1;
      }
    }
    storedImageRows.set(table, stored);
    return { inserted, updated, records: [] };
  },
  async saveImageAsset(input) {
    const assetId = `asset-${nextAssetId++}`;
    return {
      assetId,
      sha256: `sha-${assetId}`,
      mimeType: input.mimeType || "image/png",
      bytes: String(input.dataUrl || "").length,
      width: input.width || 1,
      height: input.height || 1,
      sourceWidth: input.sourceWidth || input.width || 1,
      sourceHeight: input.sourceHeight || input.height || 1,
      deduped: false,
    };
  },
  makeSessionTabTargetError(code, details) { return new ToolExecutionError(code, code, details); },
  async sendToContent(_tabId, action) {
    if (action === "getElementScreenshotBounds") {
      return { selector: "#zoom-image", bounds: { x: 1200.5, y: 1400.25, width: 160, height: 120 } };
    }
    if (action === "listImageElements") {
      const result = listImageResults.shift();
      if (result instanceof Error) throw result;
      if (result) return result;
      return {
        ok: true,
        count: listedImages.length,
        scanned: listedImages.length + 2,
        pageUrl: "https://example.test/",
        pageTitle: "Example",
        pageContext: {
          heading: "Example gallery",
          description: "A curated image gallery",
          privateField: "must not escape the projection",
        },
        images: listedImages.map(item => ({ ...item })),
      };
    }
    if (action === "readImageElement") {
      if (readImageFailure instanceof Error) throw readImageFailure;
      if (readImageFailure) return readImageFailure;
      return {
        ...listedImages[0],
        ...(readImageDataUrl ? { dataUrl: readImageDataUrl } : {}),
        mimeType: "image/png",
        width: 800,
        height: 600,
      };
    }
    return {};
  },
  async resolveSelectorTarget(tabId, selector) { return { tabId, selector }; },
  async resolveElementReference(tabId, { target }) {
    const uid = String(target || "").startsWith("uid:") ? String(target).slice(4) : "";
    const stored = uid ? elementRefs.get(uid) : null;
    if (stored) return { tabId: stored.tabId, target, selector: stored.selector, index: 0, uid, ref: stored };
    return { tabId, target, selector: String(target || "").replace(/^css:/, "") || "img", index: 0 };
  },
  makeSnapshotId(tabId) { return `t${tabId}_snapshot`; },
  registerElementRef(ref) { elementRefs.set(ref.uid, { ...ref }); },
  elementTargetForUid(uid) { return uid ? `uid:${uid}` : ""; },
  elementTargetForSelector(selector) { return selector ? `css:${selector}` : ""; },
  elementTargetForRef(ref) { return ref?.target || ""; },
  elementTargetGrammar: "target grammar",
  getElementTargetDescription: () => "target description",
  bindBackendNodes(tabId, selectors) { return bindBackendNodesImpl(tabId, selectors); },
  async getTabPageState(tabId) { return { tabId, url: tabPageUrl, title: "Example" }; },
  pageStateDelta(before, after) {
    return {
      pageBefore: before,
      pageAfter: after,
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
    };
  },
  commitObservedPageNavigation({ pageBefore, pageAfter }) {
    return pageBefore.url !== pageAfter.url ? { url: pageAfter.url, rateLimitRecorded: false } : null;
  },
  async getSecurityGuardrails() { guardrailReads += 1; return { rules: [] }; },
  async assertTabAllowed() {},
  assertUrlAllowed(url) {
    if (blockImageUrl) throw new ToolExecutionError("SECURITY_GUARDRAIL_BLOCKED", "blocked", { url });
  },
  clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  },
  async sendCdp(tabId, method, params) {
    cdpCalls.push([tabId, method, params]);
    if (cdpFailure) throw new ToolExecutionError("CDP_COMMAND_FAILED", "failed");
    const hookResult = onCdpCall?.({ tabId, method, params });
    if (hookResult !== undefined) return await hookResult;
    if (method === "Page.captureScreenshot") return { data: "Y2Rw" };
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { ...(layoutMetricsSequence.shift() || viewportState) } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main", loaderId: frameLoaderId, url: tabPageUrl } } };
    }
    return {};
  },
  async withDebugger(_tabId, callback) { return await callback({ tabId: 1 }); },
  now: () => fakeNow,
});

assert.deepEqual([...definitions.keys()], [
  "screenshot",
  "act_on_screen",
  "list_images",
  "collect_images",
  "read_image_asset",
  "read_image",
]);
assert.throws(
  () => definitions.get("screenshot").validateArgs({ target: "css:body", actionable: true }),
  error => error?.code === "SCREENSHOT_COORDINATES_UNAVAILABLE",
  "cross-field screenshot validation should live beside the tool definition",
);

const phasesStarted = [], phasesFinished = [];
const cdpShot = await runtime.captureTabScreenshot(3, { format: "jpeg", quality: 70 }, {
  measurePhase(phase) { phasesStarted.push(phase); return () => phasesFinished.push(phase); },
});
assert.deepEqual(phasesStarted.sort(), ['measurement', 'normalization', 'readiness']);
assert.deepEqual(phasesFinished.sort(), phasesStarted);
assert.equal(cdpShot.method, "cdp");
assert.equal(cdpShot.dataUrl, "data:image/jpeg;base64,Y2Rw");
assert.equal(cdpShot.cssWidth, 1000);
assert.equal(cdpShot.cssHeight, 800);
assert.equal(cdpCalls[0][1], "Page.captureScreenshot");

try {
  const clipFor = async () => {
    const image = await runtime.captureElementScreenshot(3, { selector: "#zoom-image" }, { format: "png" });
    assert.equal(image.sourceWidth, viewportState.clientWidth, "source width describes the decoded image, not the DIP clip");
    assert.equal(image.sourceHeight, viewportState.clientHeight, "source height describes the decoded image, not the DIP clip");
    return cdpCalls.findLast(([, method]) => method === "Page.captureScreenshot")[2].clip;
  };
  browserZoom = 1.25;
  onCdpCall = ({ method }) => method === "Page.getLayoutMetrics" ? {
    cssVisualViewport: { ...viewportState, zoom: 0.75 },
    cssContentSize: { width: 1300, height: 1500 },
  } : undefined;
  browserZoomError = new Error("The metrics zoom should avoid a second zoom read");
  assert.deepEqual(await clipFor(), { x: 900, y: 1050, width: 75, height: 75, scale: 1 },
    "clip document coordinates and CSS content edges before converting zoomed pixels");

  browserZoomError = null;
  onCdpCall = ({ method }) => method === "Page.getLayoutMetrics" ? {
    visualViewport: { ...viewportState, scale: 2 }, contentSize: { width: 1000, height: 1000 },
  } : undefined;
  assert.deepEqual(await clipFor(), { x: 1500, y: 1750, width: 201, height: 151, scale: 1 },
    "missing CSS metrics use the tab zoom without clipping against legacy physical content sizes");

  onCdpCall = ({ method }) => {
    if (method === "Page.getLayoutMetrics") throw new Error("Layout metrics unavailable");
  };
  assert.deepEqual(await clipFor(), { x: 1500, y: 1750, width: 201, height: 151, scale: 1 },
    "a recoverable metrics failure still reads the real tab zoom");
  const capturesBeforeFailure = cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length;
  browserZoomError = new Error("Tab closed before reading zoom");
  await assert.rejects(clipFor(), /Tab closed before reading zoom/);
  browserZoomError = null;
  onCdpCall = ({ method }) => {
    if (method === "Page.getLayoutMetrics") throw new ToolExecutionError("OPERATION_ABORTED", "aborted");
  };
  await assert.rejects(clipFor(), { code: "OPERATION_ABORTED" });
  assert.equal(cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length, capturesBeforeFailure,
    "unknown zoom or cancellation must not capture an incorrectly positioned image");
} finally {
  browserZoom = 1;
  browserZoomError = null;
  onCdpCall = null;
}

const delayedResizeContext = { sessionId: "delayed-debugger-infobar", runId: "run", source: "run_script" };
const resizeTimers = [];
let delayedResizeStarted = false;
let delayedCaptures = 0;
onCdpCall = ({ method }) => {
  if (method === "Page.captureScreenshot") delayedCaptures++;
  if (method === "Page.captureScreenshot" && !delayedResizeStarted) {
    delayedResizeStarted = true;
    const initialHeight = viewportState.clientHeight;
    for (const [ms, delta] of [[25, 20], [80, 40], [140, 56]]) {
      resizeTimers.push(setTimeout(() => { viewportState.clientHeight = initialHeight - delta; }, ms));
    }
  }
};
try {
  const shot = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, delayedResizeContext);
  assert.equal(shot.coordinateSpace.height, 744, "first capture must wait for the delayed debugger infobar animation to finish");
  assert.equal(delayedCaptures, 2, "discard the first image and retry exactly once after the delayed resize");
  const action = await definitions.get("act_on_screen").execute({
    tabId: 3, action: "type", x: 500, y: 300, text: "whale", returnScreenshot: false,
  }, undefined, delayedResizeContext);
  assert.equal(action.status, "completed");
  delayedCaptures = 0;
  delayedResizeStarted = false;
  const observed = await definitions.get("act_on_screen").execute({
    tabId: 3, action: "type", x: 500, y: 300, text: "whale", returnScreenshot: true,
  }, undefined, delayedResizeContext);
  assert.equal(observed.coordinateSpace.height, 688, "automatic post-action screenshots use the same delayed validation");
  assert.equal(observed.coordinateBasisReady, true);
  assert.equal(delayedCaptures, 2, "post-action capture also discards a frame changed after capture");
  delayedCaptures = 0;
  await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, delayedResizeContext);
  assert.equal(delayedCaptures, 1, "a stable subsequent screenshot needs no retry");
} finally {
  resizeTimers.forEach(clearTimeout);
  onCdpCall = null;
  viewportState.clientHeight = 800;
}

const captureAbort = new AbortController();
let abortTimer;
onCdpCall = ({ method }) => {
  if (method === "Page.captureScreenshot") abortTimer = setTimeout(() => captureAbort.abort(), 10);
};
try {
  const captureContext = { sessionId: "aborted-first-capture", runId: "run" };
  await assert.rejects(definitions.get("screenshot").execute({ tabId: 3, actionable: true }, captureAbort.signal, captureContext), { code: "OPERATION_ABORTED" });
  await assert.rejects(definitions.get("act_on_screen").execute({ tabId: 3, action: "click", x: 500, y: 300, returnScreenshot: false }, undefined, captureContext),
    error => error.code === "SCREENSHOT_CONTEXT_STALE" && error.details.reason === "latest_missing", "cancelled capture must not publish coordinates");
} finally {
  clearTimeout(abortTimer);
  onCdpCall = null;
}

const callsBeforeSettlingCapture = cdpCalls.length;
let captureTransitions = 1;
onCdpCall = ({ method }) => {
  if (method === "Page.captureScreenshot" && captureTransitions > 0) {
    captureTransitions -= 1;
    frameLoaderId = "loader-b";
  }
};
const settlingCapture = await definitions.get("screenshot").execute({
  tabId: 3,
  actionable: true,
}, undefined, { sessionId: "session-settling", runId: "run-settling" });
onCdpCall = null;
assert.equal(settlingCapture.actionable, true);
assert.equal(
  cdpCalls.slice(callsBeforeSettlingCapture).filter(([, method]) => method === "Page.captureScreenshot").length,
  2,
  "navigation during capture should discard the frame and recapture once",
);

const resizeContext = { sessionId: "first-screenshot-resize", runId: "run", source: "run_script" };
for (const delta of [80, 1]) {
  let captures = 0;
  onCdpCall = ({ method }) => {
    if (method === "Page.captureScreenshot" && ++captures === 1) viewportState.clientHeight -= delta;
  };
  const shot = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, resizeContext);
  onCdpCall = null;
  assert.equal(captures, 2, "even a small resize during capture requires one fresh frame");
  const action = await definitions.get("act_on_screen").execute({
    tabId: 3, action: "click", x: 500, y: shot.coordinateSpace.height / 2, returnScreenshot: false,
  }, undefined, resizeContext);
  assert.equal(action.resolvedPoint.y, viewportState.clientHeight / 2, "first click uses the stabilized screenshot's height");
  viewportState.clientHeight += delta;
}
await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, resizeContext);
let unstableCaptures = 0;
onCdpCall = ({ method }) => {
  if (method === "Page.captureScreenshot") { unstableCaptures++; viewportState.pageY++; }
};
const beforeUnstableAction = cdpCalls.length;
const feedback = await definitions.get("act_on_screen").execute({
  tabId: 3, action: "click", x: 500, y: 400, returnScreenshot: true,
}, undefined, resizeContext);
onCdpCall = null;
assert.equal(unstableCaptures, 2, "continued changes stop after the single retry");
assert.equal(feedback.status, "completed");
assert.equal(feedback.coordinateBasisReady, false);
assert.equal(feedback.feedbackError.code, "SCREENSHOT_CONTEXT_STALE");
assert.equal(cdpCalls.slice(beforeUnstableAction).filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed").length, 1, "capture retries never replay input");
await assert.rejects(definitions.get("act_on_screen").execute({ tabId: 3, action: "click", x: 500, y: 400, returnScreenshot: false }, undefined, resizeContext), { code: "SCREENSHOT_CONTEXT_STALE" });
viewportState.pageY = 0;
await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, resizeContext);
assert.equal((await definitions.get("act_on_screen").execute({ tabId: 3, action: "click", x: 500, y: 400, returnScreenshot: false }, undefined, resizeContext)).coordinateBasisReady, true);

const screenContext = {
  sessionId: "session-screen",
  runId: "run-screen",
  runProfile: {
    platform: { os: "mac", label: "macOS" },
  },
};
const screenshotIndependentPressContext = {
  sessionId: "session-screen-press-only",
  runId: "run-screen-press-only",
  runProfile: screenContext.runProfile,
};
const callsBeforeScreenshotIndependentPress = cdpCalls.length;
const screenshotIndependentPress = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "press",
  returnScreenshot: false,
  key: "Escape",
}, undefined, screenshotIndependentPressContext);
const screenshotIndependentPressCalls = cdpCalls.slice(callsBeforeScreenshotIndependentPress);
assert.equal(screenshotIndependentPress.status, "completed");
assert.equal(screenshotIndependentPress.sourceScreenshotId, undefined, "a focused key press must not consume an input screenshot");
assert.equal(screenshotIndependentPress.sourceCoordinateSpace, undefined);
assert.equal(screenshotIndependentPress.feedbackAvailable, false);
assert.equal(screenshotIndependentPress.coordinateBasisReady, false);
assert.equal(
  screenshotIndependentPressCalls.some(([, method, params]) => (
    method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && params.key === "Escape"
  )),
  true,
  "a focused key press should dispatch without any actionable screenshot in its session/run scope",
);
const independentContext = { ...screenContext, sessionId: "scroll-without-screenshot", source: "run_script" };
const screenAction = definitions.get("act_on_screen");
await assert.rejects(screenAction.execute({ tabId: 3, action: "scroll", x: 500, y: 400, deltaY: 120,
  returnScreenshot: false }, undefined, independentContext), error => error.code === "SCREENSHOT_CONTEXT_STALE"
    && error.details.reason === "latest_missing", "an explicit scroll position still requires a screenshot");
const beforeIndependent = cdpCalls.length;
const independentScroll = await screenAction.execute({ tabId: 3, action: "scroll", deltaY: 120,
  returnScreenshot: false }, undefined, independentContext);
assert.equal(independentScroll.status, "completed");
assert.equal(independentScroll.sourceScreenshotId, undefined);
assert.equal(independentScroll.coordinateBasisReady, false);
assert.equal(independentScroll._image, undefined);
assert.deepEqual(independentScroll.resolvedPoint, { x: 500, y: 400 });
assert.equal(cdpCalls.slice(beforeIndependent).some(([, method]) => method === "Page.captureScreenshot"), false,
  "script scrolling without observation must not take an input or output screenshot");
await screenAction.execute({ tabId: 3, action: "type", text: "focus only", returnScreenshot: false }, undefined, independentContext);
assert.equal(cdpCalls.some(([, method, params]) => method === "Input.insertText" && params.text === "focus only"), true);

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, independentContext);
viewportState.clientHeight = 600;
try {
  await assert.rejects(screenAction.execute({ tabId: 3, action: "scroll", x: 500, y: 400, deltaY: 120,
    returnScreenshot: false }, undefined, independentContext), error => error.code === "SCREENSHOT_CONTEXT_STALE"
      && error.details.reason === "viewport_resized");
  const observed = await screenAction.execute({ tabId: 3, action: "scroll", deltaY: 120,
    returnScreenshot: true }, undefined, independentContext);
  assert.deepEqual(observed.resolvedPoint, { x: 500, y: 300 }, "default scroll uses the live viewport, not the stale image");
  assert.equal(observed.sourceScreenshotId, undefined);
  assert.equal(observed.coordinateBasisReady, true);
  assert.equal(observed.feedbackAvailable, true);
  assert.equal(observed.coordinateSpace.height, 600);
  assert.match(observed._image, /^data:image\//);
  const controller = new AbortController();
  controller.abort();
  const beforeAbort = cdpCalls.length;
  await assert.rejects(screenAction.execute({ tabId: 3, action: "scroll", deltaY: 120,
    returnScreenshot: false }, controller.signal, independentContext), { code: "OPERATION_ABORTED" });
  assert.equal(cdpCalls.slice(beforeAbort).some(([, method]) => method.startsWith("Input.")), false);
} finally {
  viewportState.clientHeight = 800;
}

const actionable = await definitions.get("screenshot").execute({
  tabId: 3,
  actionable: true,
}, undefined, screenContext);
assert.equal(actionable.actionable, true);
assert.equal(actionable._imageDetail, "high");
assert.match(actionable.screenshotId, /^screen_/);
assert.deepEqual(actionable.coordinateSpace, {
  origin: "top_left",
  width: 1000,
  height: 800,
  unit: "pixel",
});

layoutMetricsSequence = [
  { ...viewportState, clientWidth: 997, clientHeight: 803 },
  { ...viewportState },
];
const toleratedViewportJitter = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: false,
  x: 250,
  y: 600,
}, undefined, screenContext);
assert.equal(toleratedViewportJitter.status, "completed", "a viewport delta of exactly 3 CSS px should preserve the coordinate basis");
assert.equal(toleratedViewportJitter.viewportChange.resized, false);

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
layoutMetricsSequence = [
  { ...viewportState, clientWidth: 996.9 },
];
const justBeyondViewportTolerance = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: false,
  x: 250,
  y: 600,
}, undefined, screenContext).then(() => null, error => error);
assert.equal(justBeyondViewportTolerance?.code, "SCREENSHOT_CONTEXT_STALE");
assert.equal(justBeyondViewportTolerance?.details?.reason, "viewport_resized");
assert.equal(justBeyondViewportTolerance?.details?.sourceViewportWidth, 1000);
assert.equal(justBeyondViewportTolerance?.details?.currentViewportWidth, 996.9);
assert.equal(justBeyondViewportTolerance?.details?.viewportWidthDelta, -3.1);
assert.equal(justBeyondViewportTolerance?.details?.viewportResizeTolerancePx, 3);

layoutMetricsSequence = [
  { ...viewportState, clientHeight: 760 },
  { ...viewportState },
];
const staleClickArgs = {
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 250,
  y: 600,
};
const callsBeforeStaleClick = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute(staleClickArgs, undefined, screenContext),
  error => error?.code === "SCREENSHOT_CONTEXT_STALE" && error?.details?.reason === "viewport_resized",
  "a changed viewport should fail one coordinate check without hidden retries",
);
assert.equal(
  cdpCalls.slice(callsBeforeStaleClick).some(([, method]) => method === "Input.dispatchMouseEvent"),
  false,
  "stale coordinates must fail before input",
);
const callsBeforeClick = cdpCalls.length;
const clicked = await definitions.get("act_on_screen").execute(staleClickArgs, undefined, screenContext);
assert.equal(clicked.status, "completed");
assert.equal(clicked.feedbackAvailable, true);
assert.equal(clicked.coordinateBasisReady, true);
assert.equal(clicked._image, "data:image/jpeg;base64,Y2Rw", "model feedback must keep the captured pixels untouched");
assert.notEqual(clicked.screenshotId, actionable.screenshotId);
assert.deepEqual(clicked.marker, { kind: "point", action: "click", x: 250, y: 600 });
assert.deepEqual(clicked._display, {
  type: "imageWithAction",
  action: "click",
  kind: "point",
  x: 0.25,
  y: 0.75,
  beforeImage: actionable._image,
  afterImage: clicked._image,
}, "the chat-only action projection should use normalized coordinates outside the image bytes");
assert.deepEqual(clicked.resolvedPoint, { x: 250, y: 600 });
const clickInputCalls = cdpCalls.slice(callsBeforeClick).filter(([, method]) => method === "Input.dispatchMouseEvent");
assert.deepEqual(clickInputCalls.slice(0, 2).map(([, , params]) => ({ type: params.type, x: params.x, y: params.y })), [
  { type: "mousePressed", x: 250, y: 600 },
  { type: "mouseReleased", x: 250, y: 600 },
]);
assert.equal(layoutMetricsSequence.length, 0, "the caller may retry once the original coordinate space is current again");

const callsBeforeMissingReturnScreenshot = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    x: 250,
    y: 600,
  }, undefined, screenContext),
  error => error?.code === "MISSING_REQUIRED_ARGUMENTS"
    && error?.details?.missing?.includes("returnScreenshot"),
  "screen actions must require an explicit screenshot-return decision",
);
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    returnScreenshot: "false",
    x: 250,
    y: 600,
  }, undefined, screenContext),
  error => error?.code === "INVALID_ARGUMENTS" && error?.details?.field === "returnScreenshot",
  "screen actions must not coerce the screenshot-return decision",
);
assert.equal(cdpCalls.length, callsBeforeMissingReturnScreenshot, "invalid returnScreenshot values must not consume the current frame");

const callsBeforeInvalidHold = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "long_press",
    returnScreenshot: false,
    x: 250,
    y: 600,
    durationMs: 299,
  }, undefined, screenContext),
  error => error?.code === "INVALID_LONG_PRESS_DURATION" && error?.details?.field === "durationMs",
  "long press should reject unsafe hold durations before dispatch",
);
assert.equal(cdpCalls.length, callsBeforeInvalidHold, "invalid long-press duration must not consume the current frame");

const longPressEvents = [];
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && ["mousePressed", "mouseReleased"].includes(params.type)) {
    longPressEvents.push({ type: params.type, at: Date.now() });
  }
};
const held = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "long_press",
  returnScreenshot: false,
  x: 250,
  y: 600,
  durationMs: 300,
}, undefined, screenContext);
onCdpCall = null;
assert.equal(held.status, "completed");
assert.equal(held.durationMs, 300);
assert.equal(held.feedbackAvailable, false);
assert.equal(held.coordinateBasisReady, true);
assert.equal(held._image, undefined);
assert.deepEqual(held._display, {
  type: "imageWithAction",
  action: "long_press",
  kind: "point",
  x: 0.25,
  y: 0.75,
  beforeImage: clicked._image,
  afterImage: "data:image/jpeg;base64,Y2Rw",
}, "model-silent actions should retain both frames only as Chat UI animation data");
assert.match(held.note, /未截取观察图/);
assert.deepEqual(held.marker, { kind: "point", action: "long_press", x: 250, y: 600 });
assert.deepEqual(longPressEvents.map(event => event.type), ["mousePressed", "mouseReleased"]);
assert.ok(longPressEvents[1].at - longPressEvents[0].at >= 275, "long press must keep the mouse down for the requested interval");
assert.equal(
  cdpCalls.slice(callsBeforeInvalidHold).filter(([, method]) => method === "Page.captureScreenshot").length,
  2,
  "a direct model-silent action should capture only its before and after animation frames",
);

const callsBeforeScriptedActions = cdpCalls.length;
const scriptedAction = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: false,
  x: 250,
  y: 600,
}, undefined, { ...screenContext, source: "run_script" });
assert.equal(scriptedAction.coordinateBasisReady, true);
assert.equal(scriptedAction._image, undefined);
assert.equal(scriptedAction._display, undefined, "run_script child actions should not create unused Chat UI animation frames");
const scriptedObservation = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "hover",
  returnScreenshot: true,
  x: 250,
  y: 600,
}, undefined, { ...screenContext, source: "run_script" });
assert.match(scriptedObservation._image, /^data:image\/jpeg;base64,/, "an explicitly requested script observation should return its image");
assert.equal(scriptedObservation._display, undefined, "run_script observations should not create action animations");
assert.equal(
  cdpCalls.slice(callsBeforeScriptedActions).filter(([, method]) => method === "Page.captureScreenshot").length,
  1,
  "run_script should take no hidden screenshots and only the one explicitly requested observation",
);

const callsBeforeType = cdpCalls.length;
const typed = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "type",
  returnScreenshot: true,
  x: 500,
  y: 400,
  text: "轻舟",
  replace: true,
}, undefined, screenContext);
assert.equal(typed.feedbackAvailable, true);
assert.match(typed._display?.beforeImage || "", /^data:image\/jpeg;base64,/, "a direct action should capture a fresh animation pre-frame");
const typeCalls = cdpCalls.slice(callsBeforeType);
assert.equal(typeCalls.some(([, method, params]) => (
  method === "Input.dispatchKeyEvent"
  && params.key.toLowerCase() === "a"
  && params.modifiers === 4
  && params.commands?.includes("selectAll")
)), true, "replace typing should derive Meta from the same macOS fact exposed in the run profile");
assert.equal(typeCalls.some(([, method, params]) => method === "Input.insertText" && params.text === "轻舟"), true);

const callsBeforeExplicitSelectAll = cdpCalls.length;
await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "press",
  returnScreenshot: true,
  key: "Meta+A",
}, undefined, screenContext);
const explicitSelectAllCalls = cdpCalls.slice(callsBeforeExplicitSelectAll);
assert.equal(explicitSelectAllCalls.some(([, method, params]) => (
  method === "Input.dispatchKeyEvent"
  && params.type === "rawKeyDown"
  && params.key.toLowerCase() === "a"
  && params.modifiers === 4
  && params.commands?.includes("selectAll")
)), true, "an explicit macOS Meta+A press should carry Blink's selectAll editing command");

const windowsScreenContext = {
  sessionId: "session-screen-windows",
  runId: "run-screen-windows",
  runProfile: { platform: { os: "win", label: "Windows" } },
};
await definitions.get("screenshot").execute({
  tabId: 3,
  actionable: true,
}, undefined, windowsScreenContext);
const callsBeforeWindowsSelectAll = cdpCalls.length;
await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "press",
  returnScreenshot: false,
  key: "Control+A",
}, undefined, windowsScreenContext);
assert.equal(cdpCalls.slice(callsBeforeWindowsSelectAll).some(([, method, params]) => (
  method === "Input.dispatchKeyEvent"
  && params.type === "rawKeyDown"
  && params.key.toLowerCase() === "a"
  && params.modifiers === 2
  && params.commands?.includes("selectAll")
)), true, "an explicit Windows Control+A press should carry the same platform-neutral editing command");

const callsBeforeWhitespace = cdpCalls.length;
await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "type",
  returnScreenshot: true,
  x: 500,
  y: 400,
  text: "   ",
}, undefined, screenContext);
assert.equal(
  cdpCalls.slice(callsBeforeWhitespace).some(([, method, params]) => method === "Input.insertText" && params.text === "   "),
  true,
  "screen typing must preserve an all-whitespace payload",
);

const callsBeforeFocusedType = cdpCalls.length;
await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "type",
  returnScreenshot: true,
  text: "当前焦点",
}, undefined, screenContext);
const focusedTypeCalls = cdpCalls.slice(callsBeforeFocusedType);
assert.equal(
  focusedTypeCalls.some(([, method]) => method === "Input.dispatchMouseEvent"),
  false,
  "coordinate-free type should preserve and use the current focus",
);
assert.equal(
  focusedTypeCalls.some(([, method, params]) => method === "Input.insertText" && params.text === "当前焦点"),
  true,
  "coordinate-free type should insert text into the current focus",
);

const callsBeforeClear = cdpCalls.length;
await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "type",
  returnScreenshot: true,
  x: 500,
  y: 400,
  text: "",
  replace: true,
}, undefined, screenContext);
const clearCalls = cdpCalls.slice(callsBeforeClear);
assert.equal(clearCalls.some(([, method, params]) => method === "Input.dispatchKeyEvent" && params.key.toLowerCase() === "a"), true);
assert.equal(clearCalls.some(([, method, params]) => method === "Input.dispatchKeyEvent" && params.key === "Backspace"), true);
assert.equal(
  clearCalls.some(([, method, params]) => method === "Input.insertText" && params.text === ""),
  false,
  "replace=true with empty text should clear without dispatching a meaningless empty insertion",
);

await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "type",
    returnScreenshot: true,
    text: "",
    replace: false,
  }, undefined, screenContext),
  error => error?.code === "MISSING_REQUIRED_ARGUMENTS",
  "empty type without replace should remain an explicit no-op error",
);

const recoverable = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
const callsBeforeInvalid = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    returnScreenshot: true,
    x: 1001,
    y: 100,
  }, undefined, screenContext),
  error => error?.code === "INVALID_SCREEN_COORDINATE",
);
assert.equal(cdpCalls.length, callsBeforeInvalid, "invalid coordinates must fail before any CDP work");
const recovered = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 100,
  y: 100,
}, undefined, screenContext);
assert.equal(recovered.feedbackAvailable, true, "argument validation must not consume the actionable screenshot");
assert.equal(recovered.sourceScreenshotId, recoverable.screenshotId);

const callsBeforeInvalidRepeat = cdpCalls.length;
for (const repeat of [0, 1.5, 21]) {
  await assert.rejects(
    definitions.get("act_on_screen").execute({
      tabId: 3,
      action: "scroll",
      returnScreenshot: true,
      deltaY: 120,
      repeat,
    }, undefined, screenContext),
    error => error?.code === "INVALID_SCROLL_REPEAT" && error?.details?.field === "repeat",
    `scroll repeat should reject ${repeat}`,
  );
}
assert.equal(cdpCalls.length, callsBeforeInvalidRepeat, "invalid repeat must fail before consuming the actionable screenshot");

const callsBeforeInvalidKey = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "press",
    returnScreenshot: false,
    key: "Hyper+A",
  }, undefined, screenContext),
  error => error?.code === "INVALID_ARGUMENTS" && error?.details?.key === "Hyper+A",
  "invalid key modifiers should fail during argument preparation",
);
assert.equal(cdpCalls.length, callsBeforeInvalidKey, "invalid key syntax must not consume the actionable screenshot");

const callsBeforeScroll = cdpCalls.length;
const repeatedScroll = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "scroll",
  returnScreenshot: true,
  deltaY: 120,
  repeat: 3,
}, undefined, screenContext);
const wheelCalls = cdpCalls.slice(callsBeforeScroll).filter(([, method, params]) => (
  method === "Input.dispatchMouseEvent" && params.type === "mouseWheel"
));
assert.equal(wheelCalls.length, 3, "repeat should send the requested number of trusted wheel inputs");
assert.deepEqual(
  wheelCalls.map(([, , params]) => params),
  Array.from({ length: 3 }, () => ({
    type: "mouseWheel",
    x: 500,
    y: 400,
    deltaX: 0,
    deltaY: 120,
  })),
);
assert.equal(repeatedScroll.repeat, 3);
assert.deepEqual(repeatedScroll.viewportChange, {
  observed: true,
  scrolled: false,
  deltaX: 0,
  deltaY: 0,
  scaled: false,
  resized: false,
}, "a handled wheel sequence should report that the browser viewport stayed still without guessing application effects");
const screenActionTrace = await getTraceLog();
assert.equal(
  screenActionTrace.some(line => line.includes("screen_action_trace phase=action.coordinate_check.done")
    && line.includes("staleReason=viewport_resized")
    && line.includes("sourceViewportWidth=1000")
    && line.includes("currentViewportWidth=996.9")
    && line.includes("viewportWidthDelta=-3.1")
    && line.includes("viewportResizeTolerancePx=3")),
  true,
  "viewport rejection traces should expose the measured dimensions, delta, and tolerance",
);
for (const expected of [
  "screen_action_trace phase=action.input.done",
  "screen_action_trace phase=capture.screenshot.done",
  "screen_action_trace phase=action.done",
  "screen_capture_trace phase=cdp.done",
  "screen_capture_trace phase=normalize.done",
]) {
  assert.equal(
    screenActionTrace.some(line => line.includes(expected)),
    true,
    `screen action diagnostics should record ${expected}`,
  );
}

const callsBeforePendingWheel = cdpCalls.length;
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    return new Promise(() => {});
  }
};
const pendingWheel = await settleWithin(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "scroll",
    returnScreenshot: true,
    deltaY: 140,
  }, undefined, screenContext),
  500,
  "a missing wheel acknowledgement must not delay post-action observation",
);
onCdpCall = null;
assert.equal(pendingWheel.status, "completed");
assert.equal(pendingWheel.coordinateBasisReady, true);
assert.equal(
  cdpCalls.slice(callsBeforePendingWheel).some(([, method, params]) => (
    method === "Input.dispatchMouseEvent" && params.type === "mouseWheel"
  )),
  true,
  "the delayed wheel command must be dispatched before the feedback barrier",
);

const callsBeforePendingDrag = cdpCalls.length;
let heldMoveReply = false;
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved" && !heldMoveReply) {
    heldMoveReply = true;
    return new Promise(() => {});
  }
};
const pendingDrag = await settleWithin(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "drag",
    returnScreenshot: true,
    x: 100,
    y: 100,
    endX: 900,
    endY: 700,
  }, undefined, screenContext),
  500,
  "a missing drag acknowledgement must not prevent release or observation",
);
onCdpCall = null;
assert.equal(pendingDrag.status, "completed");
const pendingDragInputs = cdpCalls.slice(callsBeforePendingDrag).filter(([, method]) => method === "Input.dispatchMouseEvent");
assert.equal(pendingDragInputs.filter(([, , params]) => params.type === "mouseMoved").length, 8);
assert.equal(pendingDragInputs.at(-1)?.[2]?.type, "mouseReleased", "drag must dispatch its release even when an earlier reply remains pending");
const acknowledgementTrace = await getTraceLog();
assert.equal(
  acknowledgementTrace.filter(line => line.includes("screen_action_trace phase=action.input.done")).length >= 2,
  true,
  "wheel and drag dispatch completion should remain diagnosable without tracking acknowledgements",
);

onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    return new Promise(() => {});
  }
};
const neverAcknowledged = await settleWithin(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "scroll",
    returnScreenshot: true,
    deltaY: 140,
  }, undefined, screenContext),
  500,
  "an unacknowledged CDP input must not hold the tool open",
);
assert.equal(neverAcknowledged.status, "completed");
onCdpCall = null;

onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    return Promise.reject(new ToolExecutionError("CDP_COMMAND_FAILED", "wheel rejected"));
  }
};
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "scroll",
    returnScreenshot: true,
    deltaY: 140,
  }, undefined, screenContext),
  error => error?.code === "CDP_COMMAND_FAILED" && /wheel rejected/.test(error?.message || ""),
  "an explicit CDP gesture rejection must still fail instead of being mistaken for a delayed acknowledgement",
);
onCdpCall = null;

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
const modelSilentType = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "type",
  returnScreenshot: false,
  x: 240,
  y: 180,
  text: "navigation input",
  replace: true,
}, undefined, screenContext);
assert.equal(modelSilentType.coordinateBasisReady, true);
assert.equal(modelSilentType.feedbackAvailable, false);
assert.match(modelSilentType._display?.beforeImage || "", /^data:image\/jpeg;base64,/, "model-silent actions should keep their source frame for UI replay");
assert.match(modelSilentType._display?.afterImage || "", /^data:image\/jpeg;base64,/, "model-silent actions should keep their result frame for UI replay");
const callsBeforeModelSilentNavigation = cdpCalls.length;
const pageUrlBeforeModelSilentNavigation = tabPageUrl;
const loaderBeforeModelSilentNavigation = frameLoaderId;
const viewportBeforeModelSilentNavigation = viewportState;
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
    tabPageUrl = "https://example.test/result";
    frameLoaderId = "loader-navigation-result";
    viewportState = { ...viewportState, clientHeight: viewportState.clientHeight - 2 };
  }
};
const navigatedFromHiddenFeedback = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 300,
  y: 200,
}, undefined, screenContext);
onCdpCall = null;
assert.equal(navigatedFromHiddenFeedback.urlChanged, true);
assert.equal(navigatedFromHiddenFeedback.viewportChange.resized, false, "a 2 CSS px navigation jitter should not be reported as a resize");
assert.match(navigatedFromHiddenFeedback._display?.beforeImage || "", /^data:image\/jpeg;base64,/, "navigation from a model-hidden feedback frame should retain a fresh source preview for Chat UI");
assert.equal(
  cdpCalls.slice(callsBeforeModelSilentNavigation).filter(([, method]) => method === "Page.captureScreenshot").length,
  2,
  "a direct observed action should capture one animation pre-frame and one reusable observation post-frame",
);
tabPageUrl = pageUrlBeforeModelSilentNavigation;
frameLoaderId = loaderBeforeModelSilentNavigation;
viewportState = viewportBeforeModelSilentNavigation;
await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);

const callsBeforeChangedNoCapture = cdpCalls.length;
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
    viewportState = { ...viewportState, pageY: 300 };
  }
};
const changedNoCapture = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: false,
  x: 200,
  y: 200,
}, undefined, screenContext);
onCdpCall = null;
assert.equal(changedNoCapture.status, "completed");
assert.equal(changedNoCapture.feedbackAvailable, false);
assert.equal(changedNoCapture.coordinateBasisReady, true);
assert.equal(changedNoCapture.continuationBlockedReason, undefined);
assert.deepEqual(changedNoCapture.viewportChange, {
  observed: true,
  scrolled: true,
  deltaX: 0,
  deltaY: 300,
  scaled: false,
  resized: false,
}, "model-silent actions should expose the observed viewport movement independently of image delivery");
assert.equal(changedNoCapture._image, undefined);
assert.match(changedNoCapture._display?.beforeImage || "", /^data:image\/jpeg;base64,/);
assert.match(changedNoCapture._display?.afterImage || "", /^data:image\/jpeg;base64,/);
assert.equal(
  cdpCalls.slice(callsBeforeChangedNoCapture).filter(([, method]) => method === "Page.captureScreenshot").length,
  2,
  "a direct model-silent action should capture only its two animation frames",
);
viewportState = { ...viewportState, pageY: 0 };

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    viewportState = { ...viewportState, pageY: 180 };
  }
};
const observedScroll = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "scroll",
  returnScreenshot: true,
  deltaY: 180,
}, undefined, screenContext);
onCdpCall = null;
assert.equal(observedScroll.repeat, 1, "scroll should preserve one-event behavior when repeat is omitted");
assert.equal(observedScroll.coordinateBasisReady, true, "a returned screenshot should establish a new basis after viewport movement");
assert.equal(observedScroll._display?.direction, "down", "scroll feedback should expose its dominant wheel direction to Chat UI");
assert.deepEqual(observedScroll.viewportChange, {
  observed: true,
  scrolled: true,
  deltaX: 0,
  deltaY: 180,
  scaled: false,
  resized: false,
}, "screenshot-returning actions should still report whether the browser viewport actually moved");
viewportState = { ...viewportState, pageY: 0 };

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") cdpFailure = true;
};
const feedbackFailure = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 200,
  y: 200,
}, undefined, screenContext);
onCdpCall = null;
cdpFailure = false;
assert.equal(feedbackFailure.status, "completed");
assert.equal(feedbackFailure.feedbackAvailable, false);
assert.equal(feedbackFailure.feedbackError.code, "CDP_COMMAND_FAILED");
assert.match(feedbackFailure.note, /观察截图失败/);

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
viewportState = { ...viewportState, pageY: 300 };
const callsBeforeStale = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    returnScreenshot: true,
    x: 100,
    y: 100,
  }, undefined, screenContext),
  error => error?.code === "SCREENSHOT_CONTEXT_STALE" && error?.details?.reason === "viewport_scrolled",
  "scrolling after capture must invalidate coordinates before input dispatch",
);
assert.equal(cdpCalls.slice(callsBeforeStale).some(([, method]) => method.startsWith("Input.")), false);
viewportState = { ...viewportState, pageY: 0 };

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    returnScreenshot: true,
    x: 100,
    y: 100,
  }, undefined, { sessionId: "another-session", runId: "run-screen" }),
  error => error?.code === "SCREENSHOT_CONTEXT_STALE" && error?.details?.reason === "latest_missing",
  "screen coordinates must not cross session boundaries",
);

const longLivedCapture = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
fakeNow += 121000;
const longLivedAction = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 100,
  y: 100,
}, undefined, screenContext);
assert.equal(
  longLivedAction.sourceScreenshotId,
  longLivedCapture.screenshotId,
  "elapsed wall-clock time alone must not invalidate an otherwise current coordinate basis",
);
assert.equal(longLivedCapture.expiresInSeconds, undefined, "actionable screenshots must not advertise a time-based expiry");
assert.equal(longLivedAction.expiresInSeconds, undefined, "screen actions must not advertise a time-based expiry");

const superseded = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
const newest = await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
assert.notEqual(newest.screenshotId, superseded.screenshotId);
const newestAction = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 100,
  y: 100,
}, undefined, screenContext);
assert.equal(newestAction.sourceScreenshotId, newest.screenshotId, "screen actions must always consume the latest frame");

const repeatAbort = new AbortController();
let repeatedWheelCount = 0;
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel") {
    repeatedWheelCount += 1;
    repeatAbort.abort();
  }
};
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "scroll",
    returnScreenshot: false,
    deltaY: 120,
    repeat: 5,
  }, repeatAbort.signal, screenContext),
  error => error?.code === "OPERATION_ABORTED",
  "aborting a repeated wheel action should stop the remaining inputs",
);
onCdpCall = null;
assert.equal(repeatedWheelCount, 1, "a cancelled wheel sequence must not dispatch later repeats");

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
const longPressAbort = new AbortController();
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") longPressAbort.abort();
};
const callsBeforeAbortedHold = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "long_press",
    returnScreenshot: false,
    x: 100,
    y: 100,
    durationMs: 5000,
  }, longPressAbort.signal, screenContext),
  error => error?.code === "OPERATION_ABORTED",
  "aborting a long press should terminate the hold",
);
onCdpCall = null;
const holdCalls = cdpCalls.slice(callsBeforeAbortedHold).filter(([, method]) => method === "Input.dispatchMouseEvent");
assert.equal(holdCalls[0][2].type, "mousePressed");
assert.equal(holdCalls.at(-1)[2].type, "mouseReleased", "an aborted long press must release the mouse button");

await definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext);
const dragAbort = new AbortController();
onCdpCall = ({ method, params }) => {
  if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") dragAbort.abort();
};
const callsBeforeDrag = cdpCalls.length;
await assert.rejects(
  definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "drag",
    returnScreenshot: false,
    x: 100,
    y: 100,
    endX: 900,
    endY: 700,
  }, dragAbort.signal, screenContext),
  error => error?.code === "OPERATION_ABORTED",
  "aborting a drag should terminate the action",
);
onCdpCall = null;
const dragCalls = cdpCalls.slice(callsBeforeDrag).filter(([, method]) => method === "Input.dispatchMouseEvent");
assert.equal(dragCalls.some(([, , params]) => params.type === "mousePressed"), true);
assert.equal(dragCalls.at(-1)[2].type, "mouseReleased", "an aborted drag must release the mouse button");
const retriedAfterAbort = await definitions.get("act_on_screen").execute({
  tabId: 3,
  action: "click",
  returnScreenshot: true,
  x: 100,
  y: 100,
}, undefined, screenContext);
assert.equal(retriedAfterAbort.status, "completed", "an interrupted action should release the serial coordinate lock");

let transitionUrl = "https://before-transition.test/";
let transitionLoaderId = "transition-before";
let transitionImage = "YmVmb3Jl";
let transitionPresentationCount = 0;
const transitionRuntime = createScreenActionRuntime({
  getPageContext: () => ({}),
  ToolExecutionError,
  async captureTabScreenshot() {
    return {
      dataUrl: `data:image/jpeg;base64,${transitionImage}`,
      width: 1000,
      height: 800,
      cssWidth: 1000,
      cssHeight: 800,
      method: "test",
    };
  },
  async createPresentationImage(image) {
    transitionPresentationCount += 1;
    return image.endsWith("YmVmb3Jl")
      ? "data:image/jpeg;base64,cHJldmlldy1iZWZvcmU="
      : "data:image/jpeg;base64,cHJldmlldy1hZnRlcg==";
  },
  async getTabPageState(tabId) { return { tabId, url: transitionUrl, title: transitionLoaderId }; },
  pageStateDelta(before, after) {
    return { urlChanged: before.url !== after.url, titleChanged: before.title !== after.title };
  },
  commitObservedPageNavigation({ pageBefore, pageAfter }) {
    return pageBefore.url !== pageAfter.url ? { url: pageAfter.url } : null;
  },
  async getSecurityGuardrails() { return {}; },
  async sendCdp(_tabId, method, params) {
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0, scale: 1 } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { loaderId: transitionLoaderId, url: transitionUrl } } };
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      transitionUrl = "https://after-transition.test/";
      transitionLoaderId = "transition-after";
      transitionImage = "YWZ0ZXI=";
    }
    return {};
  },
  async withDebugger(_tabId, callback) { return await callback({ tabId: 6 }); },
  now: () => 4000,
});
const transitionContext = { sessionId: "transition-session", runId: "transition-run" };
await transitionRuntime.capture(6, {}, transitionContext);
const transitioned = await transitionRuntime.act({
  tabId: 6,
  action: "click",
  returnScreenshot: true,
  x: 250,
  y: 600,
}, undefined, transitionContext);
assert.equal(transitioned._image, "data:image/jpeg;base64,YWZ0ZXI=", "the model image must be the clean post-navigation frame");
assert.deepEqual(transitioned._display, {
  type: "imageWithAction",
  action: "click",
  kind: "point",
  x: 0.25,
  y: 0.75,
  beforeImage: "data:image/jpeg;base64,cHJldmlldy1iZWZvcmU=",
  afterImage: "data:image/jpeg;base64,cHJldmlldy1hZnRlcg==",
}, "Chat UI should receive compact presentation frames while the model keeps the full post-action image");
assert.equal(transitioned.urlChanged, true);
assert.equal(transitionPresentationCount, 2, "direct screen actions should prepare the before and after UI frames");
const scriptedTransition = await transitionRuntime.act({
  tabId: 6,
  action: "hover",
  returnScreenshot: false,
  x: 250,
  y: 600,
}, undefined, { ...transitionContext, source: "run_script" });
assert.equal(scriptedTransition._display, undefined, "run_script child actions should omit the animation projection");
assert.equal(transitionPresentationCount, 2, "run_script child actions should not render animation previews");
const scriptedTransitionObservation = await transitionRuntime.act({
  tabId: 6,
  action: "hover",
  returnScreenshot: true,
  x: 250,
  y: 600,
}, undefined, { ...transitionContext, source: "run_script" });
assert.equal(scriptedTransitionObservation._image, "data:image/jpeg;base64,YWZ0ZXI=");
assert.equal(scriptedTransitionObservation._display, undefined);
assert.equal(transitionPresentationCount, 2, "run_script observations must not prepare animation previews");
assert.equal(transitionRuntime.releaseRun("transition-session", "transition-run"), 1, "run teardown should release the retained display frame and coordinate basis");
await assert.rejects(
  transitionRuntime.act({
    tabId: 6,
    action: "click",
    returnScreenshot: true,
    x: 250,
    y: 600,
  }, undefined, transitionContext),
  error => error?.code === "SCREENSHOT_CONTEXT_STALE" && error?.details?.reason === "latest_missing",
  "a terminal run must not retain an actionable frame or its display image",
);

const rawCoordinateCalls = [];
const rawCoordinateRuntime = createScreenActionRuntime({
  getPageContext: () => ({}),
  ToolExecutionError,
  async captureTabScreenshot() {
    return { dataUrl: "data:image/jpeg;base64,YQ==", width: 2000, height: 1600, cssWidth: 1000, cssHeight: 800, method: "test" };
  },
  async getTabPageState() { return { url: "https://raw-coordinate.test/", title: "Raw" }; },
  pageStateDelta(before, after) {
    return { pageBefore: before, pageAfter: after, urlChanged: false, titleChanged: false };
  },
  async getSecurityGuardrails() { return {}; },
  async sendCdp(_tabId, method, params) {
    rawCoordinateCalls.push([method, params]);
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 985, clientHeight: 785, pageX: 0, pageY: 0, scale: 1 } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { loaderId: "raw-loader", url: "https://raw-coordinate.test/" } } };
    }
    return {};
  },
  async withDebugger(_tabId, callback) { return await callback({ tabId: 7 }); },
  now: () => 5000,
});
const rawContext = { sessionId: "raw-session", runId: "raw-run" };
const rawCapture = await rawCoordinateRuntime.capture(7, {}, rawContext);
assert.deepEqual(rawCapture.coordinateSpace, {
  origin: "top_left",
  width: 2000,
  height: 1600,
  unit: "pixel",
});
const rawAction = await rawCoordinateRuntime.act({
  tabId: 7,
  action: "click",
  returnScreenshot: true,
  x: 500,
  y: 1200,
}, undefined, rawContext);
const rawMouseDown = rawCoordinateCalls.find(([method, params]) => (
  method === "Input.dispatchMouseEvent" && params.type === "mousePressed"
));
assert.deepEqual(
  { x: rawMouseDown?.[1]?.x, y: rawMouseDown?.[1]?.y },
  { x: 250, y: 600 },
  "image pixels must use the full screenshot CSS extent, including scrollbar space",
);
assert.deepEqual(rawAction.marker, { kind: "point", action: "click", x: 500, y: 1200 });
assert.deepEqual(rawAction._display, {
  type: "imageWithAction",
  action: "click",
  kind: "point",
  x: 0.25,
  y: 0.75,
  beforeImage: "data:image/jpeg;base64,YQ==",
  afterImage: "data:image/jpeg;base64,YQ==",
});

const rawDrag = await rawCoordinateRuntime.act({
  tabId: 7,
  action: "drag",
  returnScreenshot: true,
  x: 200,
  y: 160,
  endX: 1800,
  endY: 1440,
}, undefined, rawContext);
assert.deepEqual(rawDrag._display, {
  type: "imageWithAction",
  action: "drag",
  kind: "drag",
  x: 0.1,
  y: 0.1,
  endX: 0.9,
  endY: 0.9,
  beforeImage: "data:image/jpeg;base64,YQ==",
  afterImage: "data:image/jpeg;base64,YQ==",
}, "drag feedback should keep a responsive start/end projection without changing the screenshot");
assert.equal(rawDrag._image, "data:image/jpeg;base64,YQ==");

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;
const previewCanvases = [];
try {
  globalThis.createImageBitmap = async blob => {
    const encoded = /^(\d+)x(\d+)$/.exec(await blob.text());
    return { width: encoded ? Number(encoded[1]) : 2400, height: encoded ? Number(encoded[2]) : 1600, close() {} };
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      previewCanvases.push({ width, height, options: null });
    }

    getContext(kind) {
      assert.equal(kind, "2d");
      return { drawImage() {} };
    }

    async convertToBlob(options) {
      previewCanvases.at(-1).options = options;
      return new Blob([`${this.width}x${this.height}`], { type: options.type });
    }
  };

  const previewContext = { sessionId: "preview-session", runId: "preview-run" };
  const fullPreviewBasis = await definitions.get("screenshot").execute({
    tabId: 3,
    actionable: true,
  }, undefined, previewContext);
  const previewOnlyAction = await definitions.get("act_on_screen").execute({
    tabId: 3,
    action: "click",
    returnScreenshot: false,
    x: 1200,
    y: 800,
  }, undefined, previewContext);

  assert.equal(fullPreviewBasis._image, `data:image/jpeg;base64,${Buffer.from('2048x1365').toString('base64')}`, "the coordinate/model frame respects the shared limit");
  assert.equal(previewOnlyAction._image, undefined, "animation previews must not become model-visible images");
  assert.deepEqual(previewCanvases.map(({ width, height }) => ({ width, height })), [
    { width: 2048, height: 1365 },
    { width: 2048, height: 1365 },
    { width: 960, height: 639 },
    { width: 2048, height: 1365 },
    { width: 960, height: 639 },
  ], "both animation frames should be derived at the bounded presentation size");
  assert.equal(previewCanvases.every(item => item.options?.type === "image/jpeg"), true);
  assert.equal(previewCanvases.filter(item => item.width === 960).every(item => item.options?.quality === 0.72), true);
  assert.equal(previewOnlyAction._display.beforeImage, `data:image/jpeg;base64,${Buffer.from('960x639').toString('base64')}`);
  assert.equal(previewOnlyAction._display.afterImage, `data:image/jpeg;base64,${Buffer.from('960x639').toString('base64')}`);
  assert.deepEqual(previewOnlyAction.coordinateSpace, {
    origin: "top_left",
    width: 2048,
    height: 1365,
    unit: "pixel",
  }, "animation downscaling must not change the coordinate world");
} finally {
  if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
  else globalThis.createImageBitmap = originalCreateImageBitmap;
  if (originalOffscreenCanvas === undefined) delete globalThis.OffscreenCanvas;
  else globalThis.OffscreenCanvas = originalOffscreenCanvas;
}

updates.length = 0;
cdpFailure = true;
const fallbackShot = await runtime.captureTabScreenshot(3, { format: "jpeg", quality: 60 });
assert.equal(fallbackShot.method, "visible_tab_restore");
assert.equal(fallbackShot.dataUrl, "data:image/jpeg;base64,dmlzaWJsZQ==");
assert.deepEqual(updates.map(([tabId]) => tabId), [3, 9], "a screenshot fallback must restore the previously active tab");
for (const fallback of [false, true]) {
  cdpFailure = fallback;
  for (const mobile of [false, true]) {
    mobileMode = mobile;
    viewportState.scale = mobile ? 0.5 : 1.25;
    const shot = await runtime.captureTabScreenshot(3);
    assert.equal(shot.cssWidth, (!fallback && mobile ? 412 : viewportState.clientWidth) / viewportState.scale);
    assert.equal(shot.cssHeight, (!fallback && mobile ? 915 : viewportState.clientHeight) / viewportState.scale);
  }
}
mobileMode = false;
viewportState.scale = 1;
cdpFailure = false;
measurementUnavailable = true;
assert.ok((await runtime.captureTabScreenshot(3)).dataUrl, "image-only capture survives unavailable page measurements");
await assert.rejects(definitions.get("screenshot").execute({ tabId: 3, actionable: true }, undefined, screenContext),
  { code: "SCREENSHOT_COORDINATES_UNAVAILABLE" }, "actionable images must not silently guess their CSS extent");
measurementUnavailable = false;
cdpFailure = true;

const validImages = listedImages;
const writesBeforeInvalidImageReply = imageMetadataWrites.length;
listedImages = [{ src: { unsafe: "not a URL string" } }];
await assert.rejects(
  definitions.get("list_images").execute({ tabId: 3 }, undefined, { sessionId: "session-a" }),
  { code: "INVALID_CONTENT_RESPONSE" },
);
assert.equal(imageMetadataWrites.length, writesBeforeInvalidImageReply, "malformed Content metadata cannot enter durable assets");
listedImages = validImages;
const listed = await definitions.get("list_images").execute({ tabId: 3 }, undefined, { sessionId: "session-a" });
const listImagesSchema = definitions.get("list_images").parameters;
const collectImagesSchema = definitions.get("collect_images").parameters;
const readImageSchema = definitions.get("read_image").parameters;
assert.equal(listImagesSchema.properties.tabId.type, "number");
assert.equal((listImagesSchema.required || []).includes("tabId"), false, "list_images should default to the working tab");
assert.deepEqual(collectImagesSchema.required, ["table"]);
assert.equal(collectImagesSchema.properties.targets.items.type, "string");
assert.equal(collectImagesSchema.properties.urls.items.type, "string");
assert.equal(readImageSchema.properties.target.type, "string");
assert.equal(readImageSchema.properties.url.type, "string");
assert.equal(listed.images.length, 1);
assert.equal(listed.images[0].target, "uid:t3_snapshot.i1");
assert.equal(listed.images[0].src, "https://example.test/hero-a.png");
assert.equal(listed.images[0].currentSrc, undefined, "discovery should not duplicate the effective URL");
assert.equal(listed.images[0].srcset, undefined, "discovery should not expose raw srcset");
assert.deepEqual(listed.pageContext, {
  heading: "Example gallery",
  description: "A curated image gallery",
});
assert.deepEqual(listed.images[0].context, {
  accessibleName: "Featured campus portrait",
  caption: "Taken during the CMU years",
  heading: "Research profile",
  linkText: "Open profile",
  linkTitle: "View the complete profile",
  nearbyText: "Research profile · Taken during the CMU years",
  linkUrl: "https://example.test/profile",
});
assert.equal(elementRefs.get("t3_snapshot.i1").imageSrc, "https://example.test/hero-a.png");
assert.equal(elementRefs.get("t3_snapshot.i1").imageIndex, 4);
const previousBind = bindBackendNodesImpl;
try {
  bindBackendNodesImpl = async () => { throw new ToolExecutionError("SESSION_TAB_FOREIGN", "foreign"); };
  const foreignListed = await definitions.get("list_images").execute({ tabId: 3 }, undefined, { sessionId: "session-a" });
  assert.equal(foreignListed.count, listedImages.length);
  assert.equal(foreignListed.images.length, 1);
  assert.equal(foreignListed.images[0].src, "https://example.test/hero-a.png");
  assert.equal(elementRefs.get("t3_snapshot.i1").backendNodeId, undefined);
  bindBackendNodesImpl = async () => { throw new ToolExecutionError("SECURITY_GUARDRAIL_BLOCKED", "blocked"); };
  await assert.rejects(
    definitions.get("list_images").execute({ tabId: 3 }, undefined, { sessionId: "session-a" }),
    error => error?.code === "SECURITY_GUARDRAIL_BLOCKED",
  );
} finally {
  bindBackendNodesImpl = previousBind;
}
const inspected = await definitions.get("read_image").execute({ target: listed.images[0].target }, undefined, { sessionId: "session-a" });
assert.equal(inspected.target, listed.images[0].target);
assert.match(inspected.note, /满足时在切换页面上下文前把这个 target 交给 collect_images/);

const embeddedSource = `data:image/png;base64,${"A".repeat(120000)}`;
listedImages = [{
  ...listedImages[0],
  src: embeddedSource,
  currentSrc: embeddedSource,
  srcset: `${embeddedSource} 1x, ${embeddedSource} 2x`,
  alt: "内嵌图片".repeat(300),
  context: {
    accessibleName: "内嵌图片".repeat(300),
    accessibleDescription: "辅助说明".repeat(300),
    caption: "图片说明".repeat(300),
    nearbyText: "附近正文".repeat(300),
    linkUrl: `https://example.test/${"path/".repeat(600)}`,
    privateField: "must not escape the projection",
  },
}];
const embeddedListing = await definitions.get("list_images").execute({ tabId: 4 }, undefined, { sessionId: "session-a" });
const embeddedCandidate = embeddedListing.images[0];
assert.equal(embeddedCandidate.sourceKind, "embedded");
assert.equal(embeddedCandidate.sourceOmitted, true);
assert.match(embeddedCandidate.sourceSummary, /内嵌 image\/png/);
assert.equal(embeddedCandidate.src, undefined, "embedded image bytes must stay behind the target reference");
assert.equal(embeddedCandidate.currentSrc, undefined);
assert.equal(embeddedCandidate.srcset, undefined);
assert.equal(embeddedCandidate.hasSrcset, true);
assert.ok(embeddedCandidate.alt.length <= 500, "candidate text should be bounded");
assert.equal(embeddedCandidate.context.accessibleName, undefined, "context should not repeat alt text");
assert.ok(embeddedCandidate.context.accessibleDescription.length <= 320);
assert.ok(embeddedCandidate.context.caption.length <= 320);
assert.ok(embeddedCandidate.context.nearbyText.length <= 400);
assert.ok(embeddedCandidate.context.linkUrl.length <= 2048);
assert.equal(embeddedCandidate.context.privateField, undefined, "candidate context must use an allowlisted projection");
assert.ok(JSON.stringify(embeddedCandidate).length < 5000, "a large embedded image must produce a bounded discovery result");
assert.equal(elementRefs.get("t4_snapshot.i1").imageSrc, embeddedSource, "the full source must remain bound internally for target validation");

listedImages = [{
  index: 4,
  rank: 0,
  selector: "#gallery > img.hero",
  src: "https://example.test/hero-a.png",
  currentSrc: "https://example.test/hero-a.png",
  alt: "Hero",
  title: "",
  naturalWidth: 800,
  naturalHeight: 600,
  visible: true,
}];

listedImages = [{ ...listedImages[0], src: "https://example.test/hero-b.png", currentSrc: "https://example.test/hero-b.png" }];
await assert.rejects(
  definitions.get("collect_images").execute({ table: "images", tabId: 3, targets: [listed.images[0].target] }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_IMAGE_TARGET",
  "collection should reject a target whose image source changed after listing",
);

listedImages = [
  { ...listedImages[0], selector: "#gallery img:nth-of-type(1)" },
  { ...listedImages[0], selector: "#gallery img:nth-of-type(2)" },
];
await assert.rejects(
  definitions.get("collect_images").execute({ table: "images", tabId: 3, targets: ["css:#gallery"] }, undefined, { sessionId: "session-a" }),
  error => error?.code === "IMAGE_TARGET_NOT_SINGLE",
  "collection should reject a target that resolves to multiple images",
);

await assert.rejects(
  definitions.get("collect_images").execute({ table: "images" }, undefined, { sessionId: "session-a" }),
  error => error?.code === "MISSING_IMAGE_SELECTION",
  "collection should require explicit URL or target selections",
);

blockImageUrl = true;
guardrailReads = 0;
await assert.rejects(
  definitions.get("read_image").execute({ url: "https://blocked.example/image.png" }, undefined, {}),
  error => error?.code === "SECURITY_GUARDRAIL_BLOCKED",
  "URL reads should use the injected security-guardrail dependency",
);
assert.equal(guardrailReads, 1, "URL reads should load guardrails before fetching");

blockImageUrl = false;
const originalFetch = globalThis.fetch;
const originalUrlBitmap = globalThis.createImageBitmap;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
try {
  globalThis.fetch = async (input) => {
    const url = String(input || "");
    if (url.includes("fail")) {
      return new Response("unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { status: 200, headers: { "content-type": "image/png", "content-length": "8" } },
    );
  };
  const remoteImage = await definitions.get("read_image").execute({ url: "https://images.example/tiny.png" }, undefined, {});
  assert.equal(remoteImage.method, "url_fetch");
  assert.match(remoteImage._image, /^data:image\/png;base64,/);
  assert.equal(guardrailReads, 3, "successful URL reads should validate both requested and final URLs");

  const savedCanvas = globalThis.OffscreenCanvas;
  const pngFetch = globalThis.fetch;
  try {
    globalThis.OffscreenCanvas = class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob({ type }) { return new Blob(["converted"], { type }); }
    };
    for (const mimeType of ["image/avif", "image/bmp", "image/tiff", "image/x-icon"]) {
      globalThis.fetch = async () => new Response("image bytes", { headers: { "content-type": mimeType } });
      const converted = await definitions.get("read_image").execute({ url: "https://images.example/image" }, undefined, {});
      assert.equal(converted.mimeType, "image/png", `${mimeType} must convert even below size limit`);
      assert.match(converted._image, /^data:image\/png;base64,/);
    }
    globalThis.createImageBitmap = async () => { throw new Error("corrupt image"); };
    await assert.rejects(
      definitions.get("read_image").execute({ url: "https://images.example/image" }, undefined, {}),
      error => error.code === "IMAGE_DECODE_FAILED" && /截图/.test(error.message),
    );
  } finally {
    globalThis.fetch = pngFetch;
    globalThis.OffscreenCanvas = savedCanvas;
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  }

  const partial = await definitions.get("collect_images").execute({
    table: "partial-images",
    urls: ["https://images.example/ok.png", "https://images.example/fail.png"],
  }, undefined, { sessionId: "session-a" });
  assert.equal(partial.status, "partial");
  assert.equal(partial.collected, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.inserted, 1, "only successfully saved images should count as inserted rows");
  assert.equal(partial.totalRows, 1, "gallery totals should count saved images, not failed attempts");
  assert.equal(partial.totalImages, 1);
  assert.equal(partial.diagnosticRows, 0);
  assert.equal(partial.artifacts[0].rowCount, 1);
  assert.equal(partial.artifacts[0].kind, "image_collection");
  assert.equal(partial.artifacts[0].meta, undefined, "generated count captions belong to the current-language projection");
  assert.match(partial.note, /失败项未写入图集/);
  assert.deepEqual(
    storedImageRows.get("partial-images").map(row => row.status),
    ["ready"],
    "failed attempts must stay in the tool diagnostics rather than the gallery table",
  );
  assert.equal(partial.failures[0].src, "https://images.example/fail.png");

  const embeddedCollection = await definitions.get("collect_images").execute({
    table: "embedded-images",
    urls: [embeddedSource],
  }, undefined, { sessionId: "session-a" });
  assert.equal(embeddedCollection.collected, 1);
  assert.equal(embeddedCollection.images[0].sourceKind, "embedded");
  assert.equal(embeddedCollection.images[0].sourceOmitted, true);
  assert.equal(embeddedCollection.images[0].src, undefined);
  assert.ok(JSON.stringify(embeddedCollection).length < 5000, "collection summaries must not echo embedded image bytes");
  assert.match(storedImageRows.get("embedded-images")[0].src, /^内嵌 image\/png/, "gallery metadata should store a bounded source summary");
  assert.ok(storedImageRows.get("embedded-images")[0].src.length < 100, "gallery rows must not persist embedded image bytes");

  const writesBeforeAllFailed = imageMetadataWrites.length;
  await assert.rejects(
    definitions.get("collect_images").execute({
      table: "all-failed-images",
      urls: ["https://images.example/fail-a.png", "https://images.example/fail-b.png"],
    }, undefined, { sessionId: "session-a" }),
    error => error?.code === "IMAGE_COLLECTION_ALL_FAILED"
      && error?.details?.collected === 0
      && error?.details?.failed === 2
      && error?.details?.failures?.length === 2,
    "an all-failed selection should be a tool failure rather than an empty gallery artifact",
  );
  assert.equal(storedImageRows.has("all-failed-images"), false, "all-failed attempts must not create table rows");
  assert.equal(imageMetadataWrites.length, writesBeforeAllFailed, "all-failed attempts must not create gallery metadata");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.createImageBitmap = originalUrlBitmap;
}

cdpFailure = false;
onCdpCall = null;
const savedScreenshot = await definitions.get("screenshot").execute({ tabId: 3, destination: "saved-screenshots" }, undefined, screenContext);
assert.equal(savedScreenshot.saved, true);
assert.equal(savedScreenshot.totalRows, 1);
assert.ok(savedScreenshot._image, "saving a screenshot still returns image input to the model");
assert.equal(savedScreenshot.assetId, storedImageRows.get("saved-screenshots")[0].assetId);
assert.deepEqual(imageUpserts.at(-1), { table: "saved-screenshots", dedupField: "sourceKey" });
assert.equal(savedScreenshot.artifacts[0].rowCount, 1);
assert.equal(savedScreenshot.artifacts[0].kind, "image_collection");
assert.equal(savedScreenshot.artifacts[0].meta, undefined);
assert.equal(imageMetadataWrites.at(-1).metadata.kind, "image_collection");
const screenshotMetadataCount = imageMetadataWrites.length;
imageWriteError = new Error("table write failed");
await assert.rejects(definitions.get("screenshot").execute({ tabId: 3, destination: "failed-screenshot" }, undefined, screenContext), /table write failed/);
assert.equal(imageMetadataWrites.length, screenshotMetadataCount, "a failed table write must not publish gallery metadata");
imageWriteError = null;
const recoveredScreenshot = await definitions.get("screenshot").execute({ tabId: 3, destination: "failed-screenshot" }, undefined, screenContext);
assert.equal(recoveredScreenshot.saved, true, "the same screenshot path recovers after a persistence failure");
assert.equal(recoveredScreenshot.totalRows, 1);

const savedListedImages = listedImages;
const savedBind = bindBackendNodesImpl;
const savedReadImageDataUrl = readImageDataUrl;
const savedCollectionFetch = globalThis.fetch;
try {
  bindBackendNodesImpl = async (_tabId, selectors = []) => ({ loaderId: "loader-images", ids: selectors.map(() => 77) });
  listedImages = [{
    index: 4,
    rank: 0,
    selector: "#gallery > img.hero",
    src: "https://example.test/hero-a.png",
    currentSrc: "https://example.test/hero-a.png",
    alt: "Hero",
    title: "",
    naturalWidth: 800,
    naturalHeight: 600,
    visible: true,
  }];
  const bound = await definitions.get("list_images").execute({ tabId: 6 }, undefined, { sessionId: "session-a" });
  assert.equal(bound.images[0].target, "uid:t6_snapshot.i1");
  assert.equal(elementRefs.get("t6_snapshot.i1").backendNodeId, 77);
  assert.equal(elementRefs.get("t6_snapshot.i1").imageSrc, "https://example.test/hero-a.png");
  const sameImage = await definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" });
  assert.equal(sameImage.src, "https://example.test/hero-a.png");
  assert.match(sameImage._image, /^data:image\/png;base64,/, "an unchanged node-backed image stays readable");

  listedImages = [{ ...listedImages[0], src: "https://example.test/hero-b.png", currentSrc: "https://example.test/hero-b.png" }];
  const capturesBeforeReplaced = cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length;
  await assert.rejects(
    definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" }),
    error => error?.code === "STALE_IMAGE_TARGET"
      && error?.details?.expectedSrc === "https://example.test/hero-a.png"
      && error?.details?.currentSrc === "https://example.test/hero-b.png",
    "a node-backed read must reject a replaced image instead of returning its pixels",
  );
  readImageDataUrl = "";
  await assert.rejects(
    definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" }),
    error => error?.code === "STALE_IMAGE_TARGET",
    "a node-backed screenshot fallback must reject a replaced image",
  );
  assert.equal(
    cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length,
    capturesBeforeReplaced,
    "a replaced node-backed image must not fall through to an element screenshot",
  );

  listedImages = [{ ...listedImages[0], src: "https://example.test/hero-a.png", currentSrc: "https://example.test/hero-a.png" }];
  const fallbackImage = await definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" });
  assert.equal(fallbackImage.code, undefined, JSON.stringify(fallbackImage));
  assert.match(fallbackImage.method, /^element_screenshot_fallback:/, "a matching node-backed image still uses the screenshot fallback when canvas pixels are unavailable");
  assert.match(fallbackImage._image, /^data:image\//);

  let downloads = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input).startsWith("data:")) return savedCollectionFetch(input, options);
    downloads++;
    throw new Error("Image download unavailable");
  };
  const collectBound = () => definitions.get("collect_images").execute({
    table: "source-verification", targets: [bound.images[0].target],
  }, undefined, { sessionId: "session-a" });
  for (const [failure, code] of [
    [new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "Content bridge unavailable", { stage: "bridge" }), "CONTENT_SCRIPT_NOT_READY"],
    [{ code: "CONTENT_SCRIPT_MESSAGE_FAILED", error: "Page reply unavailable", details: { stage: "reply" } }, "CONTENT_SCRIPT_MESSAGE_FAILED"],
    [{ code: "IMAGE_SRC_EMPTY", error: "Image element has no src/currentSrc", details: { src: "", currentSrc: "" } }, "STALE_IMAGE_TARGET"],
    [{ dataUrl: "data:image/png;base64,aW1hZ2U=" }, "INVALID_CONTENT_RESPONSE"],
    [{ dataUrl: "data:image/png;base64,aW1hZ2U=", src: "", currentSrc: "" }, "STALE_IMAGE_TARGET"],
  ]) {
    readImageFailure = failure;
    const capturesBeforeUnknownSource = cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length;
    await assert.rejects(
      definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" }),
      error => error?.code === code
        && (!(failure instanceof Error) || error === failure)
        && (code !== "CONTENT_SCRIPT_MESSAGE_FAILED" || (error.message === failure.error && error.details.stage === "reply")),
      "a source-bound image must not return pixels when its current source cannot be verified",
    );
    await assert.rejects(collectBound(), error => error?.code === "IMAGE_COLLECTION_ALL_FAILED"
      && error.details.failures[0].code === code
      && (!code.startsWith("CONTENT_SCRIPT_") || error.details.failures[0].error === (failure.message || failure.error)));
    assert.equal(cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length, capturesBeforeUnknownSource);
    assert.equal(downloads, 0, "unverified page identity cannot become a successful URL fallback");
  }

  readImageFailure = { code: "IMAGE_CANVAS_FAILED", error: "Canvas is tainted", src: listedImages[0].src };
  for (const [reply, code] of [
    [new ToolExecutionError("CONTENT_SCRIPT_NOT_READY", "Screenshot preflight unavailable"), "CONTENT_SCRIPT_NOT_READY"],
    [{ code: "CONTENT_SCRIPT_MESSAGE_FAILED", error: "Screenshot preflight reply unavailable" }, "CONTENT_SCRIPT_MESSAGE_FAILED"],
    [{}, "INVALID_CONTENT_RESPONSE"],
    [{ images: [] }, "STALE_IMAGE_TARGET"],
    [{ images: [{ src: "https://example.test/replaced.png" }] }, "STALE_IMAGE_TARGET"],
    [{ images: [{}] }, "INVALID_CONTENT_RESPONSE"],
  ]) {
    listImageResults = [null, reply]; // Initial resolution succeeds; screenshot preflight fails.
    const captures = cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length;
    await assert.rejects(collectBound(), error => error?.code === "IMAGE_COLLECTION_ALL_FAILED"
      && error.details.failures[0].code === code
      && (!code.startsWith("CONTENT_SCRIPT_") || error.details.failures[0].error === (reply.message || reply.error)));
    assert.equal(listImageResults.length, 0, "collection rechecks the image before capturing fallback pixels");
    assert.equal(cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length, captures);
  }
  const verifiedCollection = await collectBound();
  assert.equal(verifiedCollection.collected, 1, "unchanged sources still allow a tainted canvas to use a screenshot");
  assert.match(verifiedCollection.images[0].method, /^element_screenshot_fallback:/);

  readImageFailure = { code: "IMAGE_SRC_EMPTY", error: "Image element has no src/currentSrc" };
  const unboundFallback = await definitions.get("read_image").execute({ tabId: 6, target: "css:#gallery > img.hero" }, undefined, { sessionId: "session-a" });
  assert.match(unboundFallback.method, /^element_screenshot_fallback:/, "explicit CSS reads have no listed source to verify");

  for (const code of ["OPERATION_ABORTED", "SECURITY_GUARDRAIL_BLOCKED", "SESSION_TAB_FOREIGN", "CDP_RUN_RELEASED"]) {
    readImageFailure = new ToolExecutionError(code, code);
    const capturesBeforeForbidden = cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length;
    await assert.rejects(
      definitions.get("read_image").execute({ target: bound.images[0].target }, undefined, { sessionId: "session-a" }),
      error => error === readImageFailure,
    );
    assert.equal(cdpCalls.filter(([, method]) => method === "Page.captureScreenshot").length, capturesBeforeForbidden);
  }
} finally {
  listedImages = savedListedImages;
  bindBackendNodesImpl = savedBind;
  readImageDataUrl = savedReadImageDataUrl;
  readImageFailure = null;
  listImageResults = [];
  globalThis.fetch = savedCollectionFetch;
}

console.log("media screenshot boundary tests passed");

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");
{
  const calls = [];
  let failure = null;
  const measured = { bounds: { x: 510, y: 620, width: 40, height: 30 }, viewport: { pageX: 500, pageY: 600 } };
  let frameBounds = measured;
  let frameContent = [100, 200, 420, 200, 420, 440, 100, 440];
  const frameRef = { target: "uid:frame-image", uid: "frame-image", selector: "#same-id", ref: {
    backendNodeId: 77, frameId: "child", loaderId: "child-loader",
  } };
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === "DOM.resolveNode") return { object: { objectId: "unrelated-main-node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { bounds: { x: 1, y: 2, width: 3, height: 4 } } } };
    if (method === "DOM.getFrameOwner") return { backendNodeId: 999 };
    if (method === "DOM.getBoxModel") return { model: { content: frameContent } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 50, pageY: 70, zoom: 1 } };
    if (method === "Page.captureScreenshot") return { data: "Y2Rw" };
    throw new Error(`Unexpected method: ${method}`);
  };
  const frameRuntime = registerMediaTools({
    registerTool() {}, ToolExecutionError, getElementTargetDescription: () => "target",
    async assertTabAllowed() {},
    clampNumber: (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback,
    async callElement(tabId, binding, action) {
      assert.equal(tabId, 6);
      assert.equal(binding.ref.frameId, "child");
      assert.equal(action, "getElementScreenshotBounds");
      if (failure) throw failure;
      return frameBounds;
    },
    async sendToContent() { throw new Error("A frame UID cannot fall back to a main-document selector"); },
    async withDebugger(tabId, run) { return run({ tabId }, send); },
    async sendCdp(_tabId, method, params) { return send(method, params); },
  });
  const shot = await frameRuntime.captureElementScreenshot(6, frameRef, { format: "png" });
  assert.deepEqual(shot.clip, { x: 160, y: 290, width: 40, height: 30, scale: 1 },
    "frame screenshots project the actual child element into the parent viewport and scroll position");
  assert.equal(calls.some(({ method }) => method === "DOM.resolveNode"), false,
    "a child backend node id must never resolve an unrelated same-numbered main-document node");
  for (const code of ["STALE_ELEMENT_UID", "OPERATION_ABORTED", "SECURITY_GUARDRAIL_BLOCKED", "SESSION_TAB_FOREIGN", "CDP_RUN_RELEASED"]) {
    failure = new ToolExecutionError(code, code);
    const captures = calls.filter(({ method }) => method === "Page.captureScreenshot").length;
    await assert.rejects(frameRuntime.captureElementScreenshot(6, frameRef, { format: "png" }), error => error === failure);
    assert.equal(calls.filter(({ method }) => method === "Page.captureScreenshot").length, captures);
  }
  failure = null;
  for (const invalid of [{}, { ...measured, viewport: {} }, { ...measured, bounds: { ...measured.bounds, width: 0 } }, measured]) {
    frameBounds = invalid;
    if (invalid === measured) frameContent = [];
    const captures = calls.filter(({ method }) => method === "Page.captureScreenshot").length;
    await assert.rejects(frameRuntime.captureElementScreenshot(6, frameRef, { format: "png" }), error => error?.code === "INVALID_ELEMENT_SCREENSHOT_BOUNDS");
    assert.equal(calls.filter(({ method }) => method === "Page.captureScreenshot").length, captures);
    assert.equal(calls.some(({ method }) => method === "DOM.resolveNode"), false);
  }
}

const fallbackImages = [
  { index: 0, rank: 0, selector: "main > img.card:nth-of-type(1)", src: "https://example.test/a.png", currentSrc: "https://example.test/a.png", alt: "A", title: "", naturalWidth: 10, naturalHeight: 10, visible: true },
  { index: 1, rank: 1, selector: "main > img.card:nth-of-type(2)", src: "https://example.test/b.png", currentSrc: "https://example.test/b.png", alt: "B", title: "", naturalWidth: 10, naturalHeight: 10, visible: true },
];
let liveFallbackImages = fallbackImages.map(item => ({ ...item }));
let fallbackForeign = true;
let sessionOwnedTabIds = [5];
const foreignTabId = 15;
const fallbackContentCalls = [];
async function fallbackContent(_tabId, action, params = {}) {
  fallbackContentCalls.push({ action, selector: params.selector, index: params.index });
  const selector = String(params.selector || "");
  const scoped = selector ? liveFallbackImages.filter(item => item.selector === selector) : liveFallbackImages;
  if (action === "listImageElements") {
    return {
      ok: true,
      count: scoped.length,
      scanned: liveFallbackImages.length,
      pageUrl: "https://example.test/",
      pageTitle: "Example",
      images: scoped.map(item => ({ ...item })),
    };
  }
  if (action === "readImageElement") {
    const image = scoped[Number(params.index) || 0];
    if (!image) return { ok: false, code: "ELEMENT_NOT_FOUND", error: "missing", selector };
    return {
      ok: true,
      ...image,
      dataUrl: "data:image/png;base64,aW1hZ2U=",
      mimeType: "image/png",
      width: 10,
      height: 10,
      method: "canvas",
    };
  }
  return { ok: true };
}
const fallbackElements = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return { sessions: {
      listOwnedTabIds: () => sessionOwnedTabIds,
      async resolveTargetTab(input) {
        if (!fallbackForeign) return { ok: true, ownedByCurrentTask: true };
        if (input?.readOnly) return { ok: true, readOnlyAccess: true, ownedByCurrentTask: false };
        return { ok: false, code: "SESSION_TAB_FOREIGN", reason: "tab_owned_by_another_session" };
      },
    } };
  },
  makeSessionTabTargetError(code, details) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {},
  async withDebugger() { throw new ToolExecutionError("SESSION_TAB_UNOWNED", "unowned"); },
  sendToContent: fallbackContent,
});
const fallbackDefinitions = new Map();
registerMediaTools({
  getPageContext: () => ({ pageMode: "desktop" }),
  registerTool({ name, execute }) { fallbackDefinitions.set(name, { execute }); },
  ToolExecutionError,
  getToolRuntimeDependencies() { return {}; },
  makeSessionTabTargetError(code, details) { return new ToolExecutionError(code, code, details); },
  sendToContent: fallbackContent,
  resolveSelectorTarget: fallbackElements.resolveSelectorTarget,
  resolveElementReference: fallbackElements.resolveElementReference,
  makeSnapshotId: fallbackElements.makeSnapshotId,
  makeElementUid: fallbackElements.makeElementUid,
  registerElementRef: fallbackElements.registerElementRef,
  elementTargetForUid: fallbackElements.elementTargetForUid,
  elementTargetForSelector: fallbackElements.elementTargetForSelector,
  elementTargetForRef: fallbackElements.elementTargetForRef,
  elementTargetGrammar: "target grammar",
  getElementTargetDescription: () => "target description",
  callElement: fallbackElements.callElement,
  bindBackendNodes: fallbackElements.bindBackendNodes,
  readMainDocumentId: fallbackElements.readMainDocumentId,
  async getTabPageState(tabId) { return { tabId, url: "https://example.test/", title: "Example" }; },
  pageStateDelta() { return { urlChanged: false, titleChanged: false }; },
  commitObservedPageNavigation() { return null; },
  async getSecurityGuardrails() { return { rules: [] }; },
  async assertTabAllowed() {},
  assertUrlAllowed() {},
  clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  },
  async sendCdp() { return {}; },
  async withDebugger() { throw new ToolExecutionError("SESSION_TAB_UNOWNED", "unowned"); },
});
const { registerPageElementTools } = await import("../../src/capabilities/page/tools.js");
registerPageElementTools({
  registerTool({ name, execute }) { fallbackDefinitions.set(name, { execute }); },
  ToolExecutionError,
  sendToContent: fallbackContent,
  resolveSelectorTarget: fallbackElements.resolveSelectorTarget,
  resolveElementReference: fallbackElements.resolveElementReference,
  useElement: fallbackElements.useElement,
  addElementTargetsToFindResult: fallbackElements.addElementTargetsToFindResult,
  elementTargetForRef: fallbackElements.elementTargetForRef,
  elementTargetForSelector: fallbackElements.elementTargetForSelector,
  elementTargetGrammar: fallbackElements.elementTargetGrammar,
  getElementTargetDescription: fallbackElements.getElementTargetDescription,
  async getTabPageState(tabId) { return { tabId, url: "https://example.test/", title: "Example" }; },
  pageStateDelta() { return { urlChanged: false, titleChanged: false }; },
  async prepareKnownPageNavigation() { return null; },
  commitObservedPageNavigation() { return null; },
  clickPointReady: () => false,
  clickNotReadyResult: () => ({ error: "no point", code: "CLICK_POINT_OUT_OF_VIEWPORT" }),
  async sendCdp() { return {}; },
  async withDebugger() { throw new ToolExecutionError("SESSION_TAB_UNOWNED", "unowned"); },
  getPageContext: () => ({ pageMode: "desktop" }),
});
const unownedListed = await fallbackDefinitions.get("list_images").execute({ tabId: foreignTabId }, undefined, { sessionId: "session-a" });
assert.equal(unownedListed.images.length, 2);
assert.match(unownedListed.images[1].target, /^uid:/);
assert.equal(unownedListed.images[1].tabId, undefined, "image candidates keep the existing target fields");
const unownedRead = await fallbackDefinitions.get("read_image").execute({
  tabId: foreignTabId,
  target: unownedListed.images[1].target,
}, undefined, { sessionId: "session-a" });
assert.equal(unownedRead.src, "https://example.test/b.png");
assert.equal(unownedRead.code, undefined);
assert.equal(fallbackContentCalls.filter(call => call.action === "readImageElement").at(-1).selector, "main > img.card:nth-of-type(2)");
assert.equal(fallbackContentCalls.filter(call => call.action === "readImageElement").at(-1).index, 0);
fallbackElements.registerElementRef({
  uid: "t15.00000d.i1",
  tabId: foreignTabId,
  sessionId: "session-a",
  pageUrl: "https://example.test/",
  selector: "main > img.card:nth-of-type(1)",
  index: 0,
  loaderId: "loader-from-list",
});
const selectorOnlyRead = await fallbackDefinitions.get("read_image").execute({
  tabId: foreignTabId,
  target: "uid:t15.00000d.i1",
}, undefined, { sessionId: "session-a" });
assert.equal(selectorOnlyRead.code, undefined, JSON.stringify(selectorOnlyRead));
assert.equal(selectorOnlyRead.src, "https://example.test/a.png", "a selector-only uid on an unclaimed tab stays readable");
const contentBeforeMutation = fallbackContentCalls.length;
await assert.rejects(
  fallbackDefinitions.get("act_on_element").execute({
    tabId: foreignTabId,
    target: unownedListed.images[1].target,
    action: "click",
  }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_ELEMENT_UID",
  "a non-readonly action on an unowned selector uid is rejected",
);
assert.equal(fallbackContentCalls.length, contentBeforeMutation, "rejection happens before any content-script call");
fallbackElements.registerElementRef({
  uid: "t15.00000b.i9",
  tabId: foreignTabId,
  sessionId: "session-a",
  pageUrl: "https://example.test/",
  selector: "main > img.card:nth-of-type(2)",
  index: 0,
  imageSrc: "https://example.test/b.png",
  backendNodeId: 44,
});
await assert.rejects(
  fallbackDefinitions.get("read_image").execute({ tabId: foreignTabId, target: "uid:t15.00000b.i9" }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_ELEMENT_UID",
  "a node-backed uid on a tab this session does not own stays rejected",
);
liveFallbackImages[1] = { ...liveFallbackImages[1], src: "https://example.test/changed.png", currentSrc: "https://example.test/changed.png" };
await assert.rejects(
  fallbackDefinitions.get("read_image").execute({ tabId: foreignTabId, target: unownedListed.images[1].target }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_IMAGE_TARGET",
  "selector fallback must reject an image whose source changed after listing",
);
sessionOwnedTabIds = [5, foreignTabId];
fallbackForeign = false;
await assert.rejects(
  fallbackDefinitions.get("collect_images").execute({
    table: "fallback-images",
    tabId: foreignTabId,
    targets: [unownedListed.images[1].target],
  }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_IMAGE_TARGET",
  "collection uses the same source check when a uid falls back to its selector",
);
mainDocumentId = "doc-live";
const stamped = await fallbackDefinitions.get("list_images").execute({ tabId: 5 }, undefined, { sessionId: "session-a" });
assert.equal(stamped.code, undefined, JSON.stringify(stamped));
const liveImage = await fallbackDefinitions.get("read_image").execute({ target: stamped.images[0].target }, undefined, { sessionId: "session-a" });
assert.equal(liveImage.code, undefined, JSON.stringify(liveImage));
mainDocumentId = "doc-next";
await assert.rejects(
  fallbackDefinitions.get("read_image").execute({ target: stamped.images[0].target }, undefined, { sessionId: "session-a" }),
  error => error?.code === "STALE_ELEMENT_UID",
  "a list_images uid dies after the same url loads a new document",
);
mainDocumentId = "";

// A busy renderer cannot hold an ordinary screenshot behind CSS measurement.
{
  const originalExecute = chrome.scripting.executeScript;
  let immediate = false;
  chrome.scripting.executeScript = options => {
    if (typeof options.args?.[0] !== "boolean") return originalExecute(options);
    immediate = options.injectImmediately === true;
    return new Promise(() => {});
  };
  try {
    const shot = await settleWithin(runtime.captureTabScreenshot(5), 500, "measurement must be bounded");
    assert.equal(immediate, true);
    assert.ok(shot.dataUrl);
    assert.equal(shot.cssWidth, undefined);
    assert.equal(shot.cssHeight, undefined);
    const start = updates.length;
    const partial = await runToolWithTimeout('screenshot', (signal, reportPartial) => runtime.captureTabScreenshot(5, {}, { signal, reportPartial }),
      undefined, 60, async stage => ({ ...stage.result, incomplete: { reason: 'timeout', pending: stage.pending } }), {});
    assert.ok(partial._image);
    assert.equal(partial.actionable, false);
    assert.equal(partial.coordinateSpace, undefined);
    assert.equal(partial.incomplete.reason, 'timeout');
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(updates.length, start, 'timeout cannot trigger a late native fallback');
  } finally { chrome.scripting.executeScript = originalExecute; }
}

// Native fallback owns activation, capture and restoration as one window transaction.
{
  const originalCapture = chrome.tabs.captureVisibleTab;
  let activeCaptures = 0, peakCaptures = 0;
  cdpFailure = true;
  chrome.tabs.captureVisibleTab = async () => {
    peakCaptures = Math.max(peakCaptures, ++activeCaptures);
    await new Promise(resolve => setTimeout(resolve, 10));
    activeCaptures--;
    return "data:image/jpeg;base64,dmlzaWJsZQ==";
  };
  const start = updates.length;
  try {
    await Promise.all([runtime.captureTabScreenshot(5), runtime.captureTabScreenshot(6)]);
    assert.equal(peakCaptures, 1);
    assert.deepEqual(updates.slice(start).map(([id]) => id), [5, 9, 6, 9]);
  } finally { chrome.tabs.captureVisibleTab = originalCapture; cdpFailure = false; }
}

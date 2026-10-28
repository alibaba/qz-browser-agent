import { toolT } from "./tool-messages.js";
import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolContext } from "#sdk/background";
import { ensurePageSurface, waitForParsedDocument, type ElementReference, type ElementTarget, type PageObservationHost, type Screenshot, type ScreenshotOptions } from "#sdk/background/browser";
import type { ImageAssetRecord } from "#sdk/shared/data";
import { bytesToBase64 } from "#sdk/shared/format";
import { normalizeImage, readImageInput, readImageResponse, parseImageDataUrlHeader, IMAGE_MAX_EDGE, IMAGE_INPUT_MAX_BYTES, compactImageSource, ImageLimitError } from "#sdk/shared/images";
import type { ImageNormalizeOptions, NormalizedImage } from "#sdk/shared/images";
type Fields = Record<string, unknown>;
type ImageFormat = "jpeg" | "png" | "webp";
type MediaHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies" | "makeSessionTabTargetError"
  | "sendToContent" | "assertTabAllowed" | "assertUrlAllowed" | "clampNumber"
  | "sendCdp" | "withDebugger" | "getPageContext"> & Pick<ToolExtensionAPI["element"],
  "resolveSelectorTarget" | "resolveElementReference" | "makeSnapshotId" | "makeElementUid" | "registerElementRef"
  | "elementTargetForUid" | "elementTargetForSelector" | "elementTargetForRef" | "elementTargetGrammar"
  | "getElementTargetDescription" | "callElement" | "bindBackendNodes" | "readMainDocumentId"> & PageObservationHost & {
  queryDataRows?: typeof queryDataRows; updateDataTableMetadata?: typeof updateDataTableMetadata;
  upsertDataRows?: typeof upsertDataRows; saveImageAsset?: typeof saveImageAsset;
  now?(): number;
};
interface ImageMetadata extends Fields {
  dataUrl?: string; src?: string; currentSrc?: string; selector?: string; alt?: string; title?: string; target?: string;
  method?: string; sourceKind?: string; mimeType?: string; sourceKey?: string; expectedSrc?: string; pageUrl?: string; pageTitle?: string;
  bytes?: number; width?: number; height?: number; sourceWidth?: number; sourceHeight?: number; naturalWidth?: number; naturalHeight?: number;
  index?: number; tabId?: number; originalIndex?: number | string; error?: string; code?: string; images?: ImageMetadata[];
  details?: Fields; rect?: unknown; bounds?: unknown; viewport?: unknown;
}
interface ImageReadOptions { sourceMode?: string; tabId?: number; maxWidth?: number; maxHeight?: number; maxBytes?: number; format?: ImageFormat; quality?: number; signal?: AbortSignal; context?: ToolContext; detail?: string }
type ImageSizeOptions = Omit<ImageNormalizeOptions, "decode">;
type ImageData = NormalizedImage;
type LayoutMetrics = { pageX: number; pageY: number; scale: number; zoom: number; contentWidth: number; contentHeight: number };
interface BoundsInfo { method: string; bounds: unknown; selector?: string; visible?: unknown; matched?: unknown; viewport?: unknown; rect?: unknown }
type ScreenshotRef = Pick<ElementReference, "uid" | "selector" | "index"> & { target?: string; ref?: ElementReference | null };
interface ElementScreenshot extends Screenshot { target?: string; selector?: string; clip?: Fields; clipped?: boolean; bounds?: unknown; layoutMetrics?: LayoutMetrics | null }
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorCode = (error: unknown) => String(record(error).code || "");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(record(error).message || record(error).error || error || "");
import { elementPageFunction } from "#sdk/background/browser";
import { requireToolFields } from "#sdk/background/tools";
import { rasterizeSvg } from "./image-conversion.js";
import {
  queryDataRows,
  updateDataTableMetadata,
  upsertDataRows,
} from "#sdk/shared/data";
import { getImageAssetDataUrl, saveImageAsset } from "#sdk/shared/data";
import { nowBeijingDateTime } from "#sdk/shared/format";
import { isCdpFallbackForbiddenError } from "#sdk/background/browser";
import { createScreenActionRuntime } from "./screen-action-runtime.js";
import { diagnosticTrace, formatTraceFields } from "#sdk/background/tools";

const SCREEN_ACTION_PREVIEW_MAX_EDGE = 960;
const SCREEN_ACTION_PREVIEW_QUALITY = 0.72;

/** Registers screenshot and image collection/inspection tools. */
export function registerMediaTools({
  registerTool,
  ToolExecutionError,
  getToolRuntimeDependencies,
  queryDataRows: queryImageCollectionRows = queryDataRows,
  updateDataTableMetadata: updateImageCollectionMetadata = updateDataTableMetadata,
  upsertDataRows: upsertImageCollectionRows = upsertDataRows,
  saveImageAsset: saveImageAssetToStore = saveImageAsset,
  makeSessionTabTargetError,
  sendToContent: contentRequest,
  resolveSelectorTarget,
  resolveElementReference,
  makeSnapshotId,
  makeElementUid = (snapshotId: string, seq: number, mark = "") => `${snapshotId}.${mark}${seq}`,
  registerElementRef,
  elementTargetForUid,
  elementTargetForSelector,
  elementTargetForRef,
  elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
  getElementTargetDescription,
  callElement = async (tabId, binding, action, params = {}) => {
    const result = await contentRequest(binding.tabId || tabId, action, { ...params, selector: binding.selector, index: binding.index ?? 0 });
    return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  },
  bindBackendNodes = async (_tabId, selectors = []) => ({ loaderId: "", ids: selectors.map(() => 0) }),
  readMainDocumentId = async () => "",
  getTabPageState,
  pageStateDelta,
  commitObservedPageNavigation,
  getSecurityGuardrails,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  assertUrlAllowed: assertUrlAllowedBySecurityGuardrails,
  clampNumber,
  sendCdp,
  withDebugger,
  getPageContext,
  now: screenSnapshotNow = () => Date.now(),
}: MediaHost) {
type CollectedImage = ReturnType<typeof normalizeCollectedImageResult>;
const screenActions = createScreenActionRuntime({
  ToolExecutionError,
  captureTabScreenshot,
  getTabPageState,
  pageStateDelta,
  commitObservedPageNavigation,
  getSecurityGuardrails,
  sendCdp,
  withDebugger,
  getPageContext,
  createPresentationImage: createScreenActionPreview,
  now: screenSnapshotNow,
});

async function sendToContent(tabId: number, action: string, args: Fields): Promise<ImageMetadata> {
  return imageMetadata(await contentRequest(tabId, action, args));
}
function imageCallTarget(candidate: ImageMetadata): ElementTarget {
  const stored = candidate.ref && typeof candidate.ref === "object" && !Array.isArray(candidate.ref) ? candidate.ref as ElementReference : undefined;
  const backendNodeId = Number(candidate.backendNodeId || stored?.backendNodeId || 0);
  return {
    tabId: Number(candidate.tabId || 0) || undefined,
    selector: String(candidate.selector || ""),
    index: Number.isFinite(Number(candidate.index)) ? Number(candidate.index) : 0,
    target: typeof candidate.target === "string" ? candidate.target : undefined,
    uid: typeof candidate.uid === "string" ? candidate.uid : undefined,
    ref: backendNodeId ? { ...stored, backendNodeId } : stored,
  };
}
function imageMetadata(value: unknown): ImageMetadata {
  const result = record(value);
  const textFields = ["dataUrl", "src", "currentSrc", "selector", "alt", "title", "target", "method", "sourceKind", "mimeType", "sourceKey", "expectedSrc", "pageUrl", "pageTitle", "error", "code"];
  const numberFields = ["bytes", "width", "height", "sourceWidth", "sourceHeight", "naturalWidth", "naturalHeight", "index", "tabId"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || textFields.some(key => result[key] != null && typeof result[key] !== "string")
    || numberFields.some(key => result[key] != null && (typeof result[key] !== "number" || !Number.isFinite(result[key])))
    || (result.images != null && !Array.isArray(result.images))) {
    throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", t("thePageReturnedAnInvalidImageResponseReadThe"));
  }
  if (Array.isArray(result.images)) result.images.forEach(imageMetadata);
  return result as ImageMetadata;
}

async function createScreenActionPreview(dataUrl: string) {
  const preview = await resizeDataUrlToMaxSize(dataUrl, {
    maxWidth: SCREEN_ACTION_PREVIEW_MAX_EDGE,
    maxHeight: SCREEN_ACTION_PREVIEW_MAX_EDGE,
    format: "jpeg",
    quality: SCREEN_ACTION_PREVIEW_QUALITY,
  });
  return preview.dataUrl;
}

async function getImageCollectionCounts(table: string) {
  if (!table) return { totalImages: 0, storedRows: 0, diagnosticRows: 0 };
  const result = await queryImageCollectionRows({ table, limit: 100000 });
  const records = Array.isArray(result?.rows) ? result.rows : [];
  const totalImages = records.filter(record => String(record?.data?.assetId || "").trim()).length;
  const storedRows = Math.max(Number(result?.totalMatched || 0), records.length);
  return {
    totalImages,
    storedRows,
    diagnosticRows: Math.max(0, storedRows - totalImages),
  };
}

function emitDataChanged(payload: Fields, context: ToolContext = {}) {
  const sink = getToolRuntimeDependencies(context).emit;
  try {
    sink?.({ type: "data_changed", ...payload });
  } catch (_error) {
    // UI projection failure must not roll back a durable image collection write.
  }
}

// ===========================================================================
// Screenshots and images
// ===========================================================================

registerTool({
  name: "screenshot",
  behavior: { nestedObservation: true, parallelRead: args => args.actionable !== true && !String(args.destination || "").trim(),
    timeoutResult: { kind: "read", pending: "screenshot capture" } },
  requires: { images: true },
  get description() { return toolT("screenshotDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("screenshotTabId") },
      target: { type: "string", description: toolT("screenshotTarget", { targetDescription: getElementTargetDescription() }) },
      index: { type: "number", description: toolT("screenshotIndex") },
      destination: { type: "string", description: toolT("screenshotDestination") },
      format: { type: "string", enum: ["png", "jpeg"], description: toolT("screenshotFormat") },
      quality: { type: "number", description: toolT("screenshotQuality") },
      padding: { type: "number", description: toolT("screenshotPadding") },
      maxWidth: { type: "number", description: toolT("screenshotMaxWidth") },
      maxHeight: { type: "number", description: toolT("screenshotMaxHeight") },
      actionable: { type: "boolean", description: toolT("screenshotActionable") },
    },
  } as const; },
  page: "owned",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, target = "", index = 0, destination = "", format = "jpeg", quality = 70, padding = 0, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE, actionable = false }, signal, context = {}) => {
    const hasElementTarget = !!String(target || "").trim();
    let shot: ElementScreenshot;
    let ref = null;
    let screenCapture = null;

    if (hasElementTarget) {
      if (tabId) await waitForParsedDocument(tabId, context);
      ref = await resolveElementReference(tabId, { target, index }, context);
      shot = await captureElementScreenshot(ref.tabId!, ref, {
        format,
        quality,
        padding,
        maxWidth,
        maxHeight,
      }, context);
    } else if (actionable) {
      screenCapture = await screenActions.capture(tabId!, {
        format,
        quality,
        maxWidth,
        maxHeight,
      }, context, {}, signal);
      shot = screenCapture.shot;
    } else {
      shot = await captureTabScreenshot(tabId, { format, quality, maxWidth, maxHeight }, context);
    }

    signal?.throwIfAborted();
    const effectiveTabId = ref?.tabId || tabId;
    let collection = null;
    if (String(destination || "").trim()) {
      context.reportPartial?.({ tabId: effectiveTabId, _image: shot.dataUrl, method: shot.method, actionable: false }, "image collection save confirmation");
      collection = await saveScreenshotToImageCollection({
        shot,
        destination,
        tabId: effectiveTabId,
        ref,
        context,
      });
    }

    // The agent forwards _image as an image_url to the model.
    return {
      _image: shot.dataUrl,
      ...(actionable ? { _imageDetail: "high" } : {}),
      method: shot.method,
      ...(String(destination || "").trim() ? { destination: normalizeImageCollectionTableName(destination) } : {}),
      saved: Boolean(collection?.assetId),
      tabId: effectiveTabId,
      target: ref?.target || undefined,
      uid: ref?.uid || undefined,
      selector: shot.selector || ref?.selector || undefined,
      index: ref?.index,
      clip: shot.clip || undefined,
      clipped: shot.clipped || undefined,
      ...(screenCapture ? {
        actionable: true,
        screenshotId: screenCapture.snapshotId,
        coordinateSpace: screenCapture.coordinateSpace,
      } : {}),
      ...(collection ? {
        table: collection.table,
        kind: collection.kind,
        assetId: collection.assetId,
        totalRows: collection.totalRows,
        image: collection.image,
        artifacts: collection.artifacts,
      } : {}),
      note: collection
        ? t("screenshotCapturedAndSavedToTheImageCollection")
        : (ref
          ? t("elementScreenshotCaptured")
          : (screenCapture
            ? t("actionableScreenshotCapturedActOnScreenWillUseThis")
            : t("screenshotCaptured"))),
    };
  },
  validateArgs: ({ target = "", actionable = false }) => {
    if (!String(target || "").trim() || !actionable) return;
    throw new ToolExecutionError(
      "SCREENSHOT_COORDINATES_UNAVAILABLE",
      t("actionableTrueIsOnlyAvailableForCurrentViewportScreenshots"),
      { target, recommendedAction: "Remove target and capture the current viewport with actionable=true." },
    );
  },
});

registerTool({
  name: "act_on_screen",
  behavior: { nestedObservation: args => args.returnScreenshot === true, timeoutTrace: "screen_action_trace",
    timeoutResult: { kind: "action", pending: "screen action outcome confirmation" } },
  requires: { images: true },
  effects: (_args, result) => record(result).urlChanged === true ? [{ type: "context.siteChanged" }] : [],
  get description() { return toolT("actOnScreenDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      action: { type: "string", enum: ["click", "double_click", "long_press", "hover", "type", "press", "scroll", "drag"] },
      returnScreenshot: { type: "boolean", description: toolT("actOnScreenReturnScreenshot") },
      x: { type: "number", minimum: 0, description: toolT("actOnScreenX") },
      y: { type: "number", minimum: 0, description: toolT("actOnScreenY") },
      endX: { type: "number", minimum: 0, description: toolT("actOnScreenEndX") },
      endY: { type: "number", minimum: 0, description: toolT("actOnScreenEndY") },
      text: { type: "string", description: toolT("actOnScreenText") },
      replace: { type: "boolean", description: toolT("actOnScreenReplace") },
      key: { type: "string", description: toolT("actOnScreenKey") },
      button: { type: "string", enum: ["left", "right", "middle"], description: toolT("actOnScreenButton") },
      durationMs: { type: "number", minimum: 300, maximum: 5000, description: toolT("actOnScreenDurationMs") },
      deltaX: { type: "number", description: toolT("actOnScreenDeltaX") },
      deltaY: { type: "number", description: toolT("actOnScreenDeltaY") },
      repeat: { type: "number", minimum: 1, maximum: 20, description: toolT("actOnScreenRepeat") },
    },
    required: ["action", "returnScreenshot"],
  } as const; },
  page: "owned",
  timeout: { defaultMs: 20000, maxMs: 120000 },
  execute: (args, signal, context = {}) => screenActions.act(args, signal, context),
  validateArgs: args => {
    const action = String(args.action || "").trim();
    if (["click","double_click","long_press","hover"].includes(action)) requireToolFields("act_on_screen", args, ["x","y"], { action, requiredWhen: `action=${action}` });
    if (["press"].includes(action)) requireToolFields("act_on_screen", args, ["key"], { action, requiredWhen: `action=${action}` });
    if (["scroll"].includes(action)) requireToolFields("act_on_screen", args, [["deltaX","deltaY"]], { action, requiredWhen: `action=${action}` });
    if (["drag"].includes(action)) requireToolFields("act_on_screen", args, ["x","y","endX","endY"], { action, requiredWhen: `action=${action}` });
    screenActions.validate(args);
  },
});

registerTool({
  name: "list_images",
  get description() { return toolT("listImagesDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      tabId: { type: "number", description: toolT("listImagesTabId") },
      selector: { type: "string", description: toolT("listImagesSelector") },
      minWidth: { type: "number", description: toolT("listImagesMinWidth") },
      minHeight: { type: "number", description: toolT("listImagesMinHeight") },
      visibleOnly: { type: "boolean", description: toolT("listImagesVisibleOnly") },
      limit: { type: "number", description: toolT("listImagesLimit") },
    },
  } as const; },
  page: "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ tabId, selector = "", minWidth = 1, minHeight = 1, visibleOnly = true, limit = 100 }, _signal, context = {}) => {
    const target = await resolveSelectorTarget(tabId, selector, 0, context);
    if (!target.tabId) throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "list_images" });
    const result = target.uid
      ? imageMetadata(await callElement(target.tabId, target, "listImageElements", { minWidth, minHeight, visibleOnly, limit }, context))
      : await sendToContent(target.tabId, "listImageElements", { selector: target.selector, minWidth, minHeight, visibleOnly, limit });
    if (result?.error) return result;
    const snapshotId = makeSnapshotId(target.tabId, context);
    const listed = (result.images || []).slice(0, clampNumber(limit, 1, 1000, 100));
    const selectors = listed.map(item => String(item.selector || ""));
    let bound = { loaderId: "", ids: selectors.map(() => 0) };
    try {
      bound = await bindBackendNodes(target.tabId, selectors, context);
    } catch (error) {
      const code = errorCode(error);
      // A read-only tab cannot attach the debugger. Keep the images and resolve them by selector.
      if (code !== "SESSION_TAB_UNOWNED" && code !== "SESSION_TAB_FOREIGN") throw error;
    }
    const documentId = await readMainDocumentId(target.tabId);
    const images = listed.map((item, rank) => {
        const uid = makeElementUid(snapshotId, rank + 1, "i");
        registerElementRef({
          uid,
          tabId: target.tabId,
          sessionId: context.sessionId || "",
          pageUrl: result.pageUrl || "",
          selector: item.selector || "",
          index: 0,
          role: "img",
          name: item.alt || item.title || "",
          imageSrc: item.currentSrc || item.src || "",
          imageIndex: item.index,
          backendNodeId: bound.ids[rank] || undefined,
          loaderId: bound.loaderId || undefined,
          documentId: documentId || undefined,
          source: "list_images",
        });
        return imageDiscoveryResultItem(item, elementTargetForUid(uid));
      });
    const pageContext = imageDiscoveryPageContext(result.pageContext);
    return {
      ok: result.ok !== false,
      count: images.length,
      scanned: finiteImageMetadataNumber(result.scanned),
      pageUrl: clipImageDiscoveryText(result.pageUrl, 2048),
      pageTitle: clipImageDiscoveryText(result.pageTitle, 500),
      ...(pageContext ? { pageContext } : {}),
      tabId: target.tabId,
      images,
      note: toolT("imageCandidatesGuidance"),
    };
  },
});

async function resolveSelectedImageTarget(selectedTarget: string, tabId: number | undefined, context: ToolContext = {}): Promise<ImageMetadata> {
  const ref = await resolveElementReference(tabId, {
    target: selectedTarget,
    index: 0,
  }, context);
  // Mixed UID/CSS calls keep tabId unset globally. The runtime checks the CSS
  // default's ownership; apply that default only to the selector target here.
  if (!ref.uid && !ref.tabId) ref.tabId = Number(context.workingTabId) || undefined;
  if (!ref.tabId) {
    throw makeSessionTabTargetError("SESSION_TAB_TARGET_REQUIRED", { toolName: "collect_images" });
  }
  const listed = imageMetadata(await callElement(ref.tabId!, ref, "listImageElements", {
    minWidth: 0, minHeight: 0, visibleOnly: false, limit: 2,
  }, context));
  if (listed?.error) {
    throw new ToolExecutionError(
      listed.code || "LIST_IMAGES_FAILED",
      listed.error || "Failed to resolve selected image target",
      { ...(listed.details || listed), target: selectedTarget },
    );
  }
  const matched = Array.isArray(listed?.images) ? listed.images : [];
  if (matched.length !== 1) {
    throw new ToolExecutionError(
      "IMAGE_TARGET_NOT_SINGLE",
      t("selectedTargetMustResolveToExactlyOneImageMatched", { count: String(matched.length) }),
      {
        target: selectedTarget,
        matched: matched.length,
        suggestedNextStep: toolT("imageTargetRecovery"),
      },
    );
  }
  const item = matched[0];
  const expectedSrc = String(ref.ref?.imageSrc || "").trim();
  const currentSrc = String(item.currentSrc || item.src || "").trim();
  assertSelectedImageSource({ target: selectedTarget, expectedSrc }, item);
  return {
    ...item,
    target: ref.target || selectedTarget,
    selector: item.selector || ref.selector,
    uid: ref.uid,
    ref: ref.ref,
    backendNodeId: ref.ref?.backendNodeId,
    originalIndex: ref.ref?.imageIndex ?? item.index,
    sourceKind: "page",
    tabId: ref.tabId,
    pageUrl: listed.pageUrl || "",
    pageTitle: listed.pageTitle || "",
    expectedSrc: currentSrc,
  };
}

function assertSelectedImageSource(candidate: ImageMetadata = {}, observed: ImageMetadata = {}) {
  const expectedSrc = String(candidate.expectedSrc || "").trim();
  if (!expectedSrc) return;
  // A failed read is not evidence of a replacement. IMAGE_SRC_EMPTY is an
  // explicit page observation; other replies must carry the observed source.
  if (typeof observed.currentSrc !== "string" && typeof observed.src !== "string" && observed.code !== "IMAGE_SRC_EMPTY") {
    if (observed.error) throw normalizeImageReadError(observed, "IMAGE_PAGE_BINARY_FAILED", { target: candidate.target });
    throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", t("thePageReturnedAnInvalidImageResponseReadThe"), { target: candidate.target });
  }
  const currentSrc = String(observed.currentSrc || observed.src || "").trim();
  if (currentSrc === expectedSrc) return;
  throw new ToolExecutionError(
    "STALE_IMAGE_TARGET",
    t("selectedImageTargetNoLongerPointsToTheListed"),
    {
      target: candidate.target || "",
      expectedSrc,
      currentSrc,
      suggestedNextStep: toolT("changedImageRecovery"),
    },
  );
}

registerTool({
  name: "collect_images",
  behavior: { parallelTab: true, uidTargets: args => (Array.isArray(args.targets) ? args.targets : []) },
  get description() { return toolT("collectImagesDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      table: { type: "string", description: toolT("collectImagesTable") },
      targets: { type: "array", items: { type: "string" }, description: toolT("collectImagesTargets", { targetDescription: getElementTargetDescription() }) },
      urls: { type: "array", items: { type: "string" }, description: toolT("collectImagesUrls") },
      dedupField: { type: "string", description: toolT("collectImagesDedupField") },
      maxWidth: { type: "number", description: toolT("collectImagesMaxWidth") },
      maxHeight: { type: "number", description: toolT("collectImagesMaxHeight") },
      maxBytes: { type: "number", description: toolT("collectImagesMaxBytes") },
      maxImages: { type: "number", description: toolT("collectImagesMaxImages") },
      maxStorageBytes: { type: "number", description: toolT("collectImagesMaxStorageBytes") },
      format: { type: "string", enum: ["jpeg", "png", "webp"], description: toolT("collectImagesFormat") },
      quality: { type: "number", description: toolT("collectImagesQuality") },
    },
    required: ["table"],
  } as const; },
  page: args => Array.isArray(args.urls) && args.urls.some(url => String(url || "").trim()) && !(Array.isArray(args.targets) && args.targets.some(target => String(target || "").trim())) ? false : "owned",
  timeout: { defaultMs: 120000, maxMs: 600000 },
  defaultableFields: ["table"],
  execute: async (args, signal, context = {}) => {
    const {
      table = "",
      targets = [],
      urls = [],
      dedupField = "sourceKey",
      maxWidth = IMAGE_MAX_EDGE,
      maxHeight = IMAGE_MAX_EDGE,
      maxBytes = 20 * 1024 * 1024,
      maxImages,
      maxStorageBytes,
      format = "jpeg",
      quality = 0.88,
    } = args || {};
    const { tabId } = args as typeof args & { tabId?: number };
    const tableDefaulted = !String(table || "").trim();
    const tableName = resolveImageCollectionTableName(table);
    const targetList = [...new Set(normalizeStringList(targets))];
    const urlList = [...new Set(normalizeStringList(urls))];
    const selectionCount = targetList.length + urlList.length;
    if (!selectionCount) {
      throw new ToolExecutionError(
        "MISSING_IMAGE_SELECTION",
        t("collectImagesRequiresAtLeastOneSelectedTargetOr"),
        { table: tableName, suggestedNextStep: toolT("collectTargetsRecovery") },
      );
    }
    if (selectionCount > 200) {
      throw new ToolExecutionError(
        "IMAGE_SELECTION_LIMIT_EXCEEDED",
        t("collectImagesAcceptsAtMost200ExplicitTargetsAnd"),
        { selected: selectionCount, maximum: 200, suggestedNextStep: toolT("collectLimitRecovery") },
      );
    }
    const candidates: ImageMetadata[] = [];

    // Resolve every page target before the first durable write. A stale or
    // ambiguous target therefore fails the whole call without partial assets.
    for (const selectedTarget of targetList) {
      if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "collect_images aborted", { table: tableName });
      candidates.push(await resolveSelectedImageTarget(selectedTarget, tabId, context));
    }
    for (const [index, url] of urlList.entries()) {
      candidates.push({
        originalIndex: index,
        sourceKind: "download",
        src: url,
        currentSrc: url,
        pageUrl: "",
        pageTitle: "",
      });
    }

    const readyRows = [];
    const failures = [];
    for (const candidate of candidates) {
      if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "collect_images aborted", { table: tableName });
      const collectedAt = nowBeijingDateTime();
      try {
        const image = await readImageForAssetCollection(candidate, {
          sourceMode: "auto",
          tabId: candidate.tabId || tabId,
          maxWidth,
          maxHeight,
          maxBytes,
          format,
          quality,
          signal,
          context,
        });
        const asset = await storeCollectedImage(image, {
          maxImages,
          maxBytes: maxStorageBytes,
        });
        const row = buildImageCollectionRow({
          candidate,
          image,
          asset,
          tableName,
          tabId: candidate.tabId || tabId,
          pageMeta: {},
          collectedAt,
          status: "ready",
        });
        readyRows.push(row);
      } catch (err) {
        if (signal?.aborted || errorCode(err) === "OPERATION_ABORTED" || record(err).name === "AbortError") throw err;
        const row = buildImageCollectionRow({
          candidate,
          image: null,
          asset: null,
          tableName,
          tabId: candidate.tabId || tabId,
          pageMeta: {},
          collectedAt,
          status: "failed",
          error: errorMessage(err),
          code: errorCode(err) || "",
        });
        failures.push(row);
      }
    }

    const failureItems = failures.slice(0, 20).map(imageCollectionFailureItem);
    if (!readyRows.length) {
      throw new ToolExecutionError(
        "IMAGE_COLLECTION_ALL_FAILED",
        t("noSelectedImagesWereSavedAllCandidatesFailed", { count: String(failures.length) }),
        {
          table: tableName,
          matched: candidates.length,
          selectedTargets: targetList.length,
          selectedUrls: urlList.length,
          collected: 0,
          failed: failures.length,
          failures: failureItems,
          suggestedNextStep: toolT("collectionFailuresRecovery"),
        },
      );
    }

    const { writeResult, counts, totalRows, artifacts } = await commitImageCollection(tableName, readyRows.map(imageCollectionStoredRow), normalizeImageCollectionDedupField(dedupField), context);
    return {
      table: tableName,
      tableDefaulted,
      kind: "image_collection",
      status: failures.length ? "partial" : "success",
      matched: candidates.length,
      selectedTargets: targetList.length,
      selectedUrls: urlList.length,
      collected: readyRows.length,
      inserted: writeResult.inserted,
      updated: writeResult.updated,
      failed: failures.length,
      totalRows,
      totalImages: totalRows,
      diagnosticRows: counts.diagnosticRows,
      assetIds: readyRows.map(row => row.assetId).filter(Boolean).slice(0, 50),
      images: readyRows.slice(0, 60).map(imageCollectionResultItem),
      sample: readyRows.slice(0, 3).map(row => ({
        assetId: row.assetId,
        ...imageSourceResultFields(row.src),
        width: row.width,
        height: row.height,
        method: row.captureMethod,
      })),
      failures: failureItems.slice(0, 5),
      artifacts,
      note: failures.length
        ? t("savedImagesFailedAndWereNotAddedTheCollection", { saved: String(readyRows.length), failed: String(failures.length), total: String(totalRows) })
        : t("savedImagesTheCollectionNowHasImagesUseRead", { saved: String(readyRows.length), total: String(totalRows) }),
    };
  },
});

registerTool({
  name: "read_image_asset",
  requires: { images: true },
  model: { pageContext: false, get imagePrompt() { return toolT("readImagePrompt"); } },
  get description() { return toolT("readImageAssetDescription"); },
  get parameters() { return {
    type: "object",
    properties: {
      assetId: { type: "string", description: toolT("readImageAssetAssetId") },
      detail: { type: "string", enum: ["low", "auto", "high"], description: toolT("readImageAssetDetail") },
    },
    required: ["assetId"],
  } as const; },
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ assetId, detail = "auto" }) => {
    const asset = await getImageAssetDataUrl(assetId);
    if (!asset?.dataUrl) {
      throw new ToolExecutionError("IMAGE_ASSET_NOT_FOUND", t("imageAssetNotFound", { id: String(assetId) }), { assetId });
    }
    const normalized = await resizeDataUrlToMaxSize(asset.dataUrl, { format: "png" });
    return {
      ...buildReadImageResult({
        dataUrl: normalized.dataUrl,
        detail,
        method: "asset_blob",
        metadata: {
          src: asset.assetId,
          mimeType: normalized.mimeType,
          bytes: estimateDataUrlBytes(normalized.dataUrl),
          width: normalized.width,
          height: normalized.height,
          naturalWidth: asset.sourceWidth || asset.width,
          naturalHeight: asset.sourceHeight || asset.height,
        },
      }),
      assetId: asset.assetId,
    };
  },
});

registerTool({
  name: "read_image",
  requires: { images: true },
  model: { get imagePrompt() { return toolT("readImagePrompt"); } },
  get description() { return toolT("readImageDescription", { targetGrammar: ELEMENT_TARGET_GRAMMAR }); },
  get parameters() { return {
    type: "object",
    properties: {
      url: { type: "string", description: toolT("readImageUrl") },
      tabId: { type: "number", description: toolT("screenshotTabId") },
      target: { type: "string", description: toolT("readImageTarget", { targetDescription: getElementTargetDescription() }) },
      index: { type: "number", description: toolT("screenshotIndex") },
      detail: { type: "string", enum: ["low", "auto", "high"], description: toolT("readImageDetail") },
      maxWidth: { type: "number", description: toolT("screenshotMaxWidth") },
      maxHeight: { type: "number", description: toolT("screenshotMaxHeight") },
      maxBytes: { type: "number", description: toolT("readImageMaxBytes") },
      format: { type: "string", enum: ["jpeg", "png", "webp"], description: toolT("readImageFormat") },
      quality: { type: "number", description: toolT("readImageQuality") },
    },
  } as const; },
  page: args => String(args.url || "").trim() ? false : "readOnly",
  timeout: { defaultMs: 30000, maxMs: 300000 },
  execute: async ({ url = "", tabId, target = "", index = 0, detail = "auto", maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE, maxBytes = 20 * 1024 * 1024, format = "png", quality = 0.88 }, signal, context = {}) => {
    if (String(url || "").trim()) {
      return await readImageUrlAsResult(url, { detail, maxBytes, maxWidth, maxHeight, format, quality, signal });
    }

    const ref = await resolveElementReference(tabId, { target, index, readOnly: true }, context);
    let canvasResult: ImageMetadata;
    try {
      canvasResult = imageMetadata(await callElement(ref.tabId!, ref, "readImageElement", {
        maxWidth, maxHeight, format, quality: normalizeImageQuality(quality),
      }, context));
    } catch (err) {
      if (ref.ref?.imageSrc || isCdpFallbackForbiddenError(err) || (err instanceof ToolExecutionError && String(errorCode(err)).startsWith("STALE_ELEMENT_UID"))) throw err;
      canvasResult = { error: errorMessage(err), code: errorCode(err) || "IMAGE_CANVAS_FAILED" };
    }
    // list_images records the source and binds a node afterward. The node can
    // already be a replacement, so both the pixel read and the screenshot
    // fallback compare the observed source before returning an image.
    assertSelectedImageSource({
      target: ref.target || target,
      expectedSrc: String(ref.ref?.imageSrc || "").trim(),
    }, canvasResult);

    if (canvasResult?.dataUrl) {
	      return buildReadImageResult({
	        dataUrl: canvasResult.dataUrl,
	        detail,
	        tabId: ref.tabId,
	        target: ref.target,
	        uid: ref.uid,
	        selector: canvasResult.selector || ref.selector,
	        index: ref.index,
        method: canvasResult.method || "canvas",
        metadata: canvasResult,
      });
    }

    const src = String(canvasResult?.src || canvasResult?.currentSrc || canvasResult?.details?.src || "");
    try {
      const screenshotFormat = format === "png" ? "png" : "jpeg";
      const shot = await captureElementScreenshot(ref.tabId!, imageCallTarget({
        ...ref,
        selector: String(canvasResult?.selector || ref.selector || ""),
        index: Number.isFinite(Number(canvasResult?.index)) ? Number(canvasResult.index) : Number(ref.index || 0),
        backendNodeId: ref.ref?.backendNodeId,
      }), {
        format: screenshotFormat,
        quality: Math.round(normalizeImageQuality(quality) * 100),
        padding: 0,
        maxWidth,
        maxHeight,
      }, context);
	      return buildReadImageResult({
	        dataUrl: shot.dataUrl,
	        detail,
	        tabId: ref.tabId,
	        target: ref.target,
	        uid: ref.uid,
	        selector: shot.selector || canvasResult?.selector || ref.selector,
	        index: ref.index,
        method: `element_screenshot_fallback:${shot.method}`,
        metadata: {
          ...(canvasResult || {}),
          src,
          mimeType: shot.dataUrl.slice(5, shot.dataUrl.indexOf(";")),
          canvasError: canvasResult?.error || "",
          canvasCode: canvasResult?.code || "",
          clip: shot.clip,
          clipped: shot.clipped,
        },
      });
    } catch (err) {
      if (isCdpFallbackForbiddenError(err) || String(errorCode(err)).startsWith("STALE_ELEMENT_UID")) throw err;
      return {
        error: canvasResult?.error || record(err).message || "Cannot read image pixels from the loaded DOM image",
        code: canvasResult?.code || errorCode(err) || "IMAGE_DOM_READ_FAILED",
	        details: {
	          ...(canvasResult?.details || {}),
	          selector: ref.selector,
	          target: ref.target,
	          uid: ref.uid || undefined,
	          index: ref.index,
          tabId: ref.tabId,
          src,
          currentSrc: canvasResult?.currentSrc || "",
          fallbackError: record(err).message || "",
          fallbackCode: errorCode(err) || "",
        },
      };
    }
  },
});

function storeCollectedImage(image: ReturnType<typeof normalizeCollectedImageResult>, options?: Parameters<typeof saveImageAsset>[1]) {
  return saveImageAssetToStore({
    dataUrl: image.dataUrl,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    sourceWidth: image.sourceWidth || image.naturalWidth,
    sourceHeight: image.sourceHeight || image.naturalHeight,
  }, options);
}

async function commitImageCollection(tableName: string, rows: Record<string, unknown>[], dedupField: string, context: ToolContext) {
  const columns = imageCollectionColumns();
  const writeResult = await upsertImageCollectionRows(tableName, rows, { dedupField, columns });
  await updateImageCollectionMetadata(tableName, { kind: "image_collection", assetKind: "image", columns });
  const counts = await getImageCollectionCounts(tableName);
  const totalRows = counts.totalImages;
  emitDataChanged({
    action: "upsert",
    table: tableName,
    totalRows: counts.storedRows,
    totalImages: totalRows,
    inserted: writeResult.inserted,
    updated: writeResult.updated,
  }, context);
  const artifacts = [{
    type: "data",
    kind: "image_collection",
    kindLabel: t("imageCollection"),
    table: tableName,
    title: tableName,
    rowCount: totalRows,
    score: 3,
  }];
  return { writeResult, counts, totalRows, artifacts };
}

async function saveScreenshotToImageCollection({ shot, destination = "", tabId, ref = null, context = {} }: { shot: ElementScreenshot; destination?: string; tabId?: number; ref?: ScreenshotRef | null; context?: ToolContext }) {
  const tableName = normalizeImageCollectionTableName(destination || t("screenshot"));
  const tabState = await getTabPageState(tabId);
  const collectedAt = nowBeijingDateTime();
  const selector = shot?.selector || ref?.selector || "";
  const target = shot?.target || ref?.target || elementTargetForSelector(selector);
  const image = normalizeCollectedImageResult({
    dataUrl: shot.dataUrl,
    method: `screenshot:${shot.method || "unknown"}`,
    sourceKind: "screenshot",
    metadata: {
      src: target ? `screenshot:${target}` : "screenshot:viewport",
      currentSrc: "",
      selector,
      target,
      originalIndex: ref?.index ?? "",
      mimeType: shot.dataUrl.slice(5, shot.dataUrl.indexOf(";")),
      bytes: estimateDataUrlBytes(shot.dataUrl),
      width: shot.width,
      height: shot.height,
      sourceWidth: shot.sourceWidth,
      sourceHeight: shot.sourceHeight,
      naturalWidth: shot.sourceWidth || shot.width,
      naturalHeight: shot.sourceHeight || shot.height,
      resized: shot.resized,
      rect: shot.bounds,
    },
  });
  const asset = await storeCollectedImage(image);
  const row = buildImageCollectionRow({
    candidate: {
      sourceKind: "screenshot",
      sourceKey: `${tabState.url || ""}#screenshot#${asset.assetId}`,
      src: image.src,
      currentSrc: "",
      pageUrl: tabState.url || "",
      pageTitle: tabState.title || "",
      selector,
      target,
      originalIndex: ref?.index ?? "",
      title: target ? t("elementScreenshot") : t("viewportScreenshot"),
      tabId,
    },
    image,
    asset,
    tableName,
    tabId,
    pageMeta: { pageUrl: tabState.url || "", pageTitle: tabState.title || "" },
    collectedAt,
    status: "ready",
  });
  const { writeResult, totalRows, artifacts } = await commitImageCollection(tableName, [row], "sourceKey", context);
  return {
    table: tableName,
    kind: "image_collection",
    assetId: row.assetId,
    inserted: writeResult.inserted,
    updated: writeResult.updated,
    totalRows,
    image: imageCollectionResultItem(row),
    artifacts,
  };
}

async function readImageForAssetCollection(candidate: ImageMetadata = {}, options: ImageReadOptions = {}) {
  const mode = normalizeCollectImageSource(options.sourceMode);
  const tabId = Number(candidate.tabId || options.tabId || 0);
  const pageTarget = imageCallTarget(candidate);
  const canReadPage = candidate.sourceKind !== "download"
    && mode !== "download"
    && tabId > 0
    && Boolean(pageTarget.selector || pageTarget.uid || Number(pageTarget.ref?.backendNodeId || 0));
  let pageReadError: ReturnType<typeof normalizeImageReadError> | null = null;
  let downloadError: ReturnType<typeof normalizeImageReadError> | null = null;
  const captureFallback = async () => {
    try {
      return await captureImageCandidateScreenshot(candidate, options, pageReadError || downloadError);
    } catch (screenshotError) {
      if (isCdpFallbackForbiddenError(screenshotError)) throw screenshotError;
      throw combineImageCollectionReadError({ mode, candidate, pageReadError, downloadError, screenshotError });
    }
  };

  if (canReadPage) {
    let canvasResult = null;
    try {
      canvasResult = imageMetadata(await callElement(tabId, pageTarget, "readImageElement", {
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        format: options.format,
        quality: normalizeImageQuality(options.quality),
      }, options.context || {}));
    } catch (err) {
      if (candidate.expectedSrc || isCdpFallbackForbiddenError(err) || (err instanceof ToolExecutionError && String(err.code).startsWith("STALE_ELEMENT_UID"))) throw err;
      pageReadError = normalizeImageReadError(err, "IMAGE_PAGE_BINARY_FAILED", {
        stage: "page_canvas",
        selector: candidate.selector,
        index: candidate.originalIndex,
        src: candidate.currentSrc || candidate.src || "",
      });
    }
    assertSelectedImageSource(candidate, canvasResult || {});
    if (canvasResult?.dataUrl) {
      return normalizeCollectedImageResult({
        dataUrl: canvasResult.dataUrl,
        method: canvasResult.method || "page_canvas",
        sourceKind: "page",
        metadata: {
          ...candidate,
          ...canvasResult,
          src: canvasResult.src || candidate.currentSrc || candidate.src || "",
        },
      });
    }
    if (!pageReadError) {
      pageReadError = new ToolExecutionError(
        canvasResult?.code || "IMAGE_PAGE_BINARY_FAILED",
        canvasResult?.error || "Cannot read image binary from page element",
        {
          ...(canvasResult?.details || {}),
          selector: candidate.selector,
          index: candidate.originalIndex,
          src: canvasResult?.src || candidate.currentSrc || candidate.src || "",
          currentSrc: canvasResult?.currentSrc || candidate.currentSrc || "",
        },
      );
    }
    if (mode === "page") return captureFallback();
  }

  const imageUrl = String(candidate.currentSrc || candidate.src || candidate.url || "").trim();
  if (!imageUrl) {
    if (mode === "auto" && canReadPage) return captureFallback();
    throw new ToolExecutionError("IMAGE_SOURCE_URL_MISSING", t("imageCandidateHasNoUrlForDownloadFallback"), {
      selector: candidate.selector,
      index: candidate.originalIndex,
    });
  }
  try {
    const downloaded = await readImageUrlAsResult(imageUrl, {
      detail: "auto",
      maxBytes: options.maxBytes,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      format: options.format,
      quality: options.quality,
      signal: options.signal,
    });
    return normalizeCollectedImageResult({
      dataUrl: downloaded._image,
      method: downloaded.method || "url_fetch",
      sourceKind: "download",
      metadata: {
        ...candidate,
        ...downloaded,
        src: downloaded.src || imageUrl,
      },
    });
  } catch (err) {
    downloadError = normalizeImageReadError(err, "IMAGE_URL_FETCH_FAILED", {
      stage: "url_fetch",
      selector: candidate.selector,
      index: candidate.originalIndex,
      src: imageUrl,
    });
    if (mode === "download" || !canReadPage) throw downloadError;
  }

  if (mode === "auto" && canReadPage) return captureFallback();

  throw combineImageCollectionReadError({
    mode,
    candidate,
    pageReadError,
    downloadError,
  });
}

async function captureImageCandidateScreenshot(candidate: ImageMetadata = {}, options: ImageReadOptions = {}, cause: unknown = null) {
  const tabId = Number(candidate.tabId || options.tabId || 0);
  const binding = imageCallTarget({ ...candidate, tabId });
  const selector = binding.selector;
  if (!tabId || (!selector && !binding.uid && !Number(binding.ref?.backendNodeId || 0))) {
    throw new ToolExecutionError("IMAGE_ELEMENT_SCREENSHOT_UNAVAILABLE", t("cannotScreenshotImageCandidateWithoutTabidAndSelector"), {
      tabId,
      selector,
      index: candidate.originalIndex,
      src: candidate.currentSrc || candidate.src || "",
    });
  }
  if (candidate.expectedSrc) {
    const current = imageMetadata(await callElement(tabId, binding, "listImageElements", {
      minWidth: 0, minHeight: 0, visibleOnly: false, limit: 2,
    }, options.context || {}));
    if (current.error) throw normalizeImageReadError(current, "LIST_IMAGES_FAILED", { target: candidate.target });
    if (!Array.isArray(current.images)) throw new ToolExecutionError("INVALID_CONTENT_RESPONSE", t("thePageReturnedAnInvalidImageResponseReadThe"), { target: candidate.target });
    const matched = current.images;
    if (matched.length !== 1) {
      throw new ToolExecutionError(
        "STALE_IMAGE_TARGET",
        t("selectedImageTargetIsNoLongerAvailableForScreenshot"),
        {
          target: candidate.target || "",
          matched: matched.length,
          suggestedNextStep: toolT("changedImageRecovery"),
        },
      );
    }
    assertSelectedImageSource(candidate, matched[0]);
  }
  const screenshotFormat = options.format === "png" ? "png" : "jpeg";
  const shot = await captureElementScreenshot(tabId, binding, {
    format: screenshotFormat,
    quality: Math.round(normalizeImageQuality(options.quality) * 100),
    padding: 0,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
  }, options.context || {});
  return normalizeCollectedImageResult({
    dataUrl: shot.dataUrl,
    method: `element_screenshot_fallback:${shot.method}`,
    sourceKind: "page",
    metadata: {
      ...candidate,
      src: candidate.currentSrc || candidate.src || "",
      currentSrc: candidate.currentSrc || candidate.src || "",
      selector: shot.selector || selector,
      mimeType: shot.dataUrl.slice(5, shot.dataUrl.indexOf(";")),
      bytes: estimateDataUrlBytes(shot.dataUrl),
      width: shot.width,
      height: shot.height,
      sourceWidth: shot.sourceWidth,
      sourceHeight: shot.sourceHeight,
      naturalWidth: candidate.naturalWidth || shot.sourceWidth || shot.width,
      naturalHeight: candidate.naturalHeight || shot.sourceHeight || shot.height,
      resized: shot.resized,
      screenshotFallback: true,
      fallbackCauseCode: errorCode(cause) || "",
      fallbackCause: record(cause).message || record(cause).error || "",
    },
  });
}

function normalizeImageReadError(err: unknown, fallbackCode: string, fallbackDetails: Fields = {}) {
  if (err instanceof ToolExecutionError) return err;
  return new ToolExecutionError(
    errorCode(err) || fallbackCode,
    errorMessage(err) || "Image read failed",
    {
      ...fallbackDetails,
      ...(record(record(err).details) || {}),
    },
  );
}

function combineImageCollectionReadError({ mode, candidate = {}, pageReadError = null, downloadError = null, screenshotError = null }: { mode?: string; candidate?: ImageMetadata; pageReadError?: unknown; downloadError?: unknown; screenshotError?: unknown } = {}) {
  const errors = [pageReadError, downloadError, screenshotError].filter(Boolean).map(err => ({
    code: errorCode(err) || "",
    message: record(err).message || record(err).error || "",
    details: record(record(err).details) || {},
  }));
  const primary = screenshotError || downloadError || pageReadError;
  return new ToolExecutionError(
    errorCode(primary) || "IMAGE_COLLECTION_READ_FAILED",
    errorMessage(primary) || "Failed to collect image binary",
    {
      mode,
      selector: candidate.selector,
      index: candidate.originalIndex,
      src: candidate.currentSrc || candidate.src || "",
      errors,
    },
  );
}

function normalizeCollectedImageResult({ dataUrl, method, sourceKind, metadata = {} }: { dataUrl: string; method: string; sourceKind: string; metadata?: ImageMetadata }) {
  const mimeType = metadata.mimeType || (dataUrl ? dataUrl.slice(5, dataUrl.indexOf(";")) : "");
  return {
    dataUrl,
    method,
    sourceKind,
    src: metadata.src || metadata.currentSrc || "",
    currentSrc: metadata.currentSrc || metadata.src || "",
    alt: metadata.alt || "",
    title: metadata.title || "",
    selector: metadata.selector || "",
    target: metadata.target || elementTargetForSelector(metadata.selector),
    originalIndex: metadata.originalIndex ?? metadata.index,
    mimeType,
    bytes: metadata.bytes || estimateDataUrlBytes(dataUrl),
    width: metadata.width || metadata.naturalWidth || metadata.sourceWidth,
    height: metadata.height || metadata.naturalHeight || metadata.sourceHeight,
    naturalWidth: metadata.naturalWidth || metadata.sourceWidth || metadata.width,
    naturalHeight: metadata.naturalHeight || metadata.sourceHeight || metadata.height,
    sourceWidth: metadata.sourceWidth || metadata.naturalWidth || metadata.width,
    sourceHeight: metadata.sourceHeight || metadata.naturalHeight || metadata.height,
    resized: Boolean(metadata.resized),
    rect: metadata.rect,
  };
}

function buildImageCollectionRow({ candidate = {}, image = null, asset = null, tableName = "", tabId, pageMeta = {}, collectedAt, status = "ready", error = "", code = "" }: { candidate?: ImageMetadata; image?: CollectedImage | null; asset?: Partial<ImageAssetRecord> & { deduped?: boolean } | null; tableName?: string; tabId?: number; pageMeta?: ImageMetadata; collectedAt?: string; status?: string; error?: string; code?: string } = {}) {
  const src = image?.src || candidate.currentSrc || candidate.src || "";
  const pageUrl = candidate.pageUrl || pageMeta.pageUrl || "";
  const selector = image?.selector || candidate.selector || "";
  const target = image?.target || candidate.target || elementTargetForSelector(selector);
  const assetId = asset?.assetId || "";
  const sourceKey = candidate.sourceKey || createImageCollectionSourceKey({ src, pageUrl, selector, assetId, index: candidate.originalIndex });
  return {
    sourceKey,
    assetId,
    status,
    src,
    currentSrc: image?.currentSrc || candidate.currentSrc || src,
    pageUrl,
    pageTitle: candidate.pageTitle || pageMeta.pageTitle || "",
    target,
    selector,
    originalIndex: candidate.originalIndex ?? "",
    alt: image?.alt || candidate.alt || "",
    title: image?.title || candidate.title || "",
    mimeType: image?.mimeType || asset?.mimeType || "",
    bytes: asset?.bytes || image?.bytes || "",
    width: asset?.width || image?.width || "",
    height: asset?.height || image?.height || "",
    naturalWidth: image?.naturalWidth || asset?.sourceWidth || "",
    naturalHeight: image?.naturalHeight || asset?.sourceHeight || "",
    resized: Boolean(image?.resized),
    captureMethod: image?.method || "",
    source: image?.sourceKind || candidate.sourceKind || "",
    assetSha256: asset?.sha256 || "",
    deduped: Boolean(asset?.deduped),
    tabId: tabId || "",
    table: tableName,
    collectedAt,
    error,
    errorCode: code,
  };
}

function imageCollectionColumns() {
  return [
    "assetId",
    "status",
    "src",
    "pageUrl",
    "pageTitle",
    "alt",
    "title",
    "mimeType",
    "bytes",
    "width",
    "height",
    "naturalWidth",
    "naturalHeight",
    "captureMethod",
    "source",
    "target",
    "selector",
    "originalIndex",
    "collectedAt",
    "sourceKey",
    "assetSha256",
    "deduped",
    "error",
    "errorCode",
  ];
}

function imageCollectionResultItem(row: Fields = {}) {
  return {
    assetId: row.assetId,
    ...imageSourceResultFields(row.src),
    pageUrl: clipImageDiscoveryText(row.pageUrl, 2048),
    alt: clipImageDiscoveryText(row.alt, 500),
    title: clipImageDiscoveryText(row.title, 500),
    mimeType: row.mimeType,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    naturalWidth: row.naturalWidth,
    naturalHeight: row.naturalHeight,
    method: row.captureMethod,
    source: row.source,
    target: row.target,
    status: row.status,
  };
}

function normalizeImageCollectionTableName(table: unknown) {
  const name = String(table || "").trim();
  return (name || t("defaultCollectionName")).slice(0, 120);
}

function resolveImageCollectionTableName(table: unknown) {
  const name = String(table || "").trim();
  return normalizeImageCollectionTableName(name || defaultImageCollectionTableName());
}

function defaultImageCollectionTableName() {
  const stamp = nowBeijingDateTime().replace(/\D/g, "").slice(0, 14) || String(Date.now());
  const suffix = Math.random().toString(36).slice(2, 6);
  return t("generatedCollectionName", { date: String(stamp), suffix: String(suffix) });
}

function normalizeCollectImageSource(value: unknown) {
  const source = String(value || "auto").trim().toLowerCase();
  return ["auto", "page", "download"].includes(source) ? source : "auto";
}

function normalizeImageCollectionDedupField(value: unknown) {
  const key = String(value || "").trim();
  if (!key || key === "_rowId" || key.toLowerCase() === "rowid") return "sourceKey";
  return key;
}

function normalizeStringList(value: unknown) {
  const list = Array.isArray(value) ? value : [value];
  return list.map(item => String(item || "").trim()).filter(Boolean);
}

function imageDiscoveryResultItem(item: ImageMetadata = {}, target = "") {
  const source = String(item.currentSrc || item.src || "").trim();
  const context = imageDiscoveryTextContext(item.context, [item.alt, item.title]);
  return {
    index: item.index,
    rank: item.rank,
    selector: clipImageDiscoveryText(item.selector, 1000),
    alt: clipImageDiscoveryText(item.alt, 500),
    title: clipImageDiscoveryText(item.title, 500),
    loading: clipImageDiscoveryText(item.loading, 80),
    complete: Boolean(item.complete),
    naturalWidth: finiteImageMetadataNumber(item.naturalWidth),
    naturalHeight: finiteImageMetadataNumber(item.naturalHeight),
    rect: normalizeImageDiscoveryRect(item.rect),
    visible: Boolean(item.visible),
    hasSrcset: item.hasSrcset === true || Boolean(String(item.srcset || "").trim()),
    ...(context ? { context } : {}),
    ...imageSourceResultFields(source),
    target,
  };
}

function imageDiscoveryTextContext(input: unknown = {}, directText: unknown[] = []) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = record(input);
  const limits = {
    accessibleName: 240,
    accessibleDescription: 320,
    caption: 320,
    heading: 240,
    linkText: 240,
    linkTitle: 240,
    nearbyText: 400,
    linkUrl: 2048,
  };
  const seen = new Set(directText.map(value => normalizeImageDiscoveryText(value)).filter(Boolean));
  const context: Record<string, string> = {};
  for (const [key, limit] of Object.entries(limits)) {
    const rawText = normalizeImageDiscoveryText(value[key], false);
    const identity = normalizeImageDiscoveryText(rawText);
    if (!rawText || (key !== "linkUrl" && seen.has(identity))) continue;
    const text = clipImageDiscoveryText(rawText, limit);
    context[key] = text;
    if (key !== "linkUrl") seen.add(identity);
  }
  return Object.keys(context).length ? context : null;
}

function imageDiscoveryPageContext(input: unknown = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = record(input);
  const context: Record<string, string> = {};
  const heading = clipImageDiscoveryText(normalizeImageDiscoveryText(value.heading, false), 240);
  const description = clipImageDiscoveryText(normalizeImageDiscoveryText(value.description, false), 500);
  if (heading) context.heading = heading;
  if (description) context.description = description;
  return Object.keys(context).length ? context : null;
}

function normalizeImageDiscoveryText(value: unknown, lowerCase = true) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return lowerCase ? text.toLowerCase() : text;
}

function imageCollectionFailureItem(row: Fields = {}) {
  return {
    target: row.target || undefined,
    selector: clipImageDiscoveryText(row.selector, 1000) || undefined,
    ...imageSourceResultFields(row.src),
    error: clipImageDiscoveryText(row.error, 1000),
    code: row.errorCode || "",
  };
}

function imageCollectionStoredRow(row: Fields = {}) {
  const source = imageSourceResultFields(row.src);
  const hasCurrentSource = Boolean(String(row.currentSrc || "").trim());
  const currentSource = hasCurrentSource ? imageSourceResultFields(row.currentSrc) : source;
  const sourceOmitted = Boolean(source.sourceOmitted || currentSource.sourceOmitted);
  return {
    ...row,
    src: source.src || source.sourceSummary || "",
    currentSrc: currentSource.src || currentSource.sourceSummary || source.src || source.sourceSummary || "",
    sourceKey: sourceOmitted
      ? createImageCollectionSourceKey({
          src: `asset:${row.assetSha256 || row.assetId}`,
          pageUrl: row.pageUrl,
          selector: row.selector,
          index: row.originalIndex,
        })
      : row.sourceKey,
  };
}

function imageSourceResultFields(value: unknown = "") {
  const source = String(value || "").trim();
  if (!source) return { sourceKind: "missing", sourceSummary: t("noImageSourceProvided") };
  if (/^data:image\//i.test(source)) {
    const comma = source.indexOf(",");
    const header = comma >= 0 ? source.slice(5, comma) : source.slice(5, 120);
    const mimeType = String(header.split(";", 1)[0] || "image/*").toLowerCase();
    const bytes = comma >= 0
      ? (/;base64(?:;|$)/i.test(header)
          ? Math.floor(Math.max(0, source.length - comma - 1) * 0.75)
          : Math.max(0, source.length - comma - 1))
      : 0;
    return {
      sourceKind: "embedded",
      sourceSummary: t("embedded", { type: String(mimeType), size: String(bytes ? t("approx", { size: String(formatImageDiscoveryBytes(bytes)) }) : "") }),
      sourceOmitted: true,
    };
  }
  if (/^blob:/i.test(source)) {
    return {
      sourceKind: "blob",
      sourceSummary: t("blobImageFromTheCurrentPage"),
      sourceOmitted: true,
    };
  }
  if (source.length <= 2048) {
    return {
      sourceKind: /^https?:\/\//i.test(source) ? "url" : "page_source",
      src: source,
    };
  }
  let label = clipImageDiscoveryText(source, 240);
  try {
    const parsed = new URL(source);
    label = `${parsed.origin}${clipImageDiscoveryText(parsed.pathname, 160)}`;
  } catch (_error) {
    // The bounded textual label above is enough for non-standard sources.
  }
  return {
    sourceKind: /^https?:\/\//i.test(source) ? "url" : "page_source",
    sourceSummary: t("sourceUrlCharacters", { source: String(label), count: String(source.length) }),
    sourceOmitted: true,
  };
}

function clipImageDiscoveryText(value: unknown, maxLength: number) {
  const text = String(value || "");
  const max = Math.max(1, Number(maxLength) || 1);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function finiteImageMetadataNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeImageDiscoveryRect(input: unknown = {}) {
  return {
    x: finiteImageMetadataNumber(record(input).x),
    y: finiteImageMetadataNumber(record(input).y),
    w: finiteImageMetadataNumber(record(input).w),
    h: finiteImageMetadataNumber(record(input).h),
  };
}

function formatImageDiscoveryBytes(bytes: unknown) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

function createImageCollectionSourceKey({ src = "", pageUrl = "", selector = "", assetId = "", index = "" }: Fields = {}) {
  const source = String(src || assetId || selector || index || "").trim();
  const page = String(pageUrl || "").trim();
  return `${page}#${source}`.slice(0, 500);
}

async function readImageUrlAsResult(url: string, { detail = "auto", maxBytes = 20 * 1024 * 1024, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE, format = "png", quality = 0.88, signal }: ImageReadOptions = {}) {
  const sourceUrl = String(url || "").trim();
  if (!sourceUrl) {
    throw new ToolExecutionError("MISSING_IMAGE_URL", t("readImageUrlIsEmpty"), { url });
  }

  if (/^data:image\//i.test(sourceUrl)) {
    const normalized = await resizeDataUrlToMaxSize(sourceUrl, {
      maxWidth,
      maxHeight,
      format,
      quality: normalizeImageQuality(quality),
      signal,
    });
    return buildReadImageResult({
      dataUrl: normalized.dataUrl,
      detail,
      method: normalized.resized ? "url_data_resized" : "url_data",
      metadata: {
        src: await compactImageSource(sourceUrl),
        mimeType: normalized.mimeType,
        naturalWidth: normalized.sourceWidth,
        naturalHeight: normalized.sourceHeight,
        resized: normalized.resized,
        animationFlattened: normalized.animationFlattened,
        width: normalized.width,
        height: normalized.height,
      },
    });
  }

  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch(_err) {
    throw new ToolExecutionError("INVALID_IMAGE_URL", t("invalidImageUrl", { url: String(sourceUrl) }), { url: sourceUrl });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ToolExecutionError("UNSUPPORTED_IMAGE_URL_SCHEME", t("unsupportedImageUrlScheme", { scheme: String(parsed.protocol) }), {
      url: parsed.href,
      supported: ["http", "https", "data:image"],
    });
  }
  assertUrlAllowedBySecurityGuardrails(parsed.href, await getSecurityGuardrails(), { tool: "read_image", source: "url" });

  const byteLimit = clampNumber(maxBytes, 1024, IMAGE_INPUT_MAX_BYTES, 20 * 1024 * 1024);
  let response;
  try {
    response = await fetch(parsed.href, {
      method: "GET",
      redirect: "follow",
      credentials: "include",
      cache: "force-cache",
      signal,
    });
  } catch (err) {
    throw new ToolExecutionError("IMAGE_URL_FETCH_FAILED", t("failedToFetchImageUrl", { reason: String(record(err).message || String(err)) }), {
      url: parsed.href,
    });
  }

  if (!response.ok) {
    throw new ToolExecutionError("IMAGE_URL_HTTP_ERROR", t("imageUrlReturnedHttp", { status: String(response.status) }), {
      url: response.url || parsed.href,
      status: response.status,
      statusText: response.statusText || "",
    });
  }
  assertUrlAllowedBySecurityGuardrails(response.url || parsed.href, await getSecurityGuardrails(), { tool: "read_image", source: "response_url" });

  const downloaded = await readImageResponse(response, { maxBytes: byteLimit, signal });
  const buffer = await downloaded.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const mimeType = inferImageMimeType(bytes, response.headers.get("content-type") || "", response.url || parsed.href);
  if (!mimeType?.startsWith("image/")) {
    throw new ToolExecutionError("IMAGE_URL_NOT_IMAGE", t("urlDidNotReturnAnImage", { type: String(mimeType || "unknown content type") }), {
      url: response.url || parsed.href,
      contentType: response.headers.get("content-type") || "",
      bytes: buffer.byteLength,
    });
  }

  let normalized;
  try {
    normalized = await resizeImageBlobToMaxSize(new Blob([buffer], { type: mimeType }), {
      maxWidth,
      maxHeight,
      format,
      quality: normalizeImageQuality(quality),
      signal,
    });
  } catch(_err) {
    if (_err instanceof ImageLimitError) throw _err;
    throw new ToolExecutionError("IMAGE_DECODE_FAILED", t("theImageCouldNotBeDecodedOrConvertedUse"), { mimeType });
  }

  return buildReadImageResult({
    dataUrl: normalized.dataUrl,
    detail,
    method: normalized.resized ? "url_fetch_resized" : "url_fetch",
    metadata: {
      src: response.url || parsed.href,
      mimeType: normalized.mimeType || mimeType,
      bytes: estimateDataUrlBytes(normalized.dataUrl),
      naturalWidth: normalized.sourceWidth,
      naturalHeight: normalized.sourceHeight,
      resized: normalized.resized,
      animationFlattened: normalized.animationFlattened,
      width: normalized.width,
      height: normalized.height,
    },
  });
}

function buildReadImageResult({ dataUrl, detail, tabId, target, uid, selector, index, method, metadata = {} }: { dataUrl: string; detail?: string; tabId?: number; target?: string; uid?: string; selector?: string; index?: number; method: string; metadata?: ImageMetadata }) {
  const resolvedTarget = target || elementTargetForRef({ uid, selector }) || undefined;
  return {
    _image: dataUrl,
    _imageDetail: normalizeImageDetail(detail),
    tabId: tabId || undefined,
    target: resolvedTarget,
    uid: uid || undefined,
    selector,
    index: index ?? undefined,
    method,
    src: metadata.src || metadata.currentSrc || "",
    alt: metadata.alt || "",
    title: metadata.title || "",
    naturalWidth: metadata.naturalWidth || undefined,
    naturalHeight: metadata.naturalHeight || undefined,
    width: metadata.width || undefined,
    height: metadata.height || undefined,
    resized: metadata.resized || undefined,
    ...(metadata.animationFlattened ? { animationFlattened: true } : {}),
    rect: metadata.rect || undefined,
    mimeType: metadata.mimeType || dataUrl.slice(5, dataUrl.indexOf(";")),
    bytes: metadata.bytes || estimateDataUrlBytes(dataUrl),
    note: resolvedTarget
      ? t("imageReadCheckWhetherItMeetsTheCriteriaIf")
      : t("imageReadAnalyzeItsContentUseInspectElementRead"),
  };
}

function normalizeImageDetail(detail: unknown) {
  const value = String(detail || "").toLowerCase();
  return ["low", "auto", "high"].includes(value) ? value : "auto";
}

function normalizeImageQuality(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.88;
  return n > 1 ? Math.max(0.1, Math.min(1, n / 100)) : Math.max(0.1, Math.min(1, n));
}

function estimateDataUrlBytes(dataUrl: unknown) {
  const base64 = String(dataUrl || "").split(",", 2)[1] || "";
  return Math.floor(base64.length * 0.75);
}

function inferImageMimeType(bytes: Uint8Array, contentType = "", url = "") {
  const normalized = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  if (bytes?.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
    if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    if (bytes.length >= 12
      && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) return "image/avif";
  }

  const path = (() => {
    try { return new URL(url).pathname.toLowerCase(); }
    catch(_err) { return String(url || "").toLowerCase(); }
  })();
  if (/\.(jpe?g)(?:$|[?#])/.test(path)) return "image/jpeg";
  if (/\.png(?:$|[?#])/.test(path)) return "image/png";
  if (/\.gif(?:$|[?#])/.test(path)) return "image/gif";
  if (/\.webp(?:$|[?#])/.test(path)) return "image/webp";
  if (/\.avif(?:$|[?#])/.test(path)) return "image/avif";
  if (/\.svgz?(?:$|[?#])/.test(path)) return "image/svg+xml";
  return normalized || "";
}

async function resizeDataUrlToMaxSize(dataUrl: string, options: ImageSizeOptions = {}): Promise<ImageData> {
  return normalizeMediaImage(dataUrl, options);
}

async function resizeImageBlobToMaxSize(blob: Blob, options: ImageSizeOptions = {}): Promise<ImageData> {
  return normalizeMediaImage(blob, options);
}

async function normalizeMediaImage(input: Blob | string, options: ImageSizeOptions): Promise<ImageData> {
  const normalizedOptions = { ...options, quality: normalizeImageQuality(options.quality) };
  const mimeType = typeof input === "string" ? parseImageDataUrlHeader(input).mimeType : input.type.toLowerCase().split(";")[0];
  if (mimeType !== "image/svg+xml") return normalizeImage(input, normalizedOptions);
  const { blob, dataUrl } = await readImageInput(input, options.signal);
  const source = dataUrl || `data:image/svg+xml;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  return rasterizeSvg(source, normalizedOptions);
}

async function captureElementScreenshot(tabId: number, ref: ScreenshotRef, { format = "jpeg", quality = 70, padding = 0, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE }: ScreenshotOptions & { padding?: number } = {}, context: ToolContext = {}): Promise<ElementScreenshot> {
  if (!tabId) throw new ToolExecutionError("MISSING_TAB_ID", t("elementScreenshotRequiresTabid"), { ref });
  await assertTabAllowedBySecurityGuardrails(tabId, { tool: "screenshot", source: "element" });
  let boundsInfo: BoundsInfo | null = null;
  let runtimeError: unknown = null;
  let cdpError: unknown = null;
  let selectorError: unknown = null;

  if (ref.ref?.frameId) {
    // Child backend ids and selectors belong to that document, never the page target.
    boundsInfo = await getFrameElementScreenshotBounds(tabId, ref, context);
  } else if (ref?.ref?.backendNodeId) {
    try {
      boundsInfo = await getElementScreenshotBoundsFromRuntime(tabId, ref.ref.backendNodeId, context);
    } catch (err) {
      if (isCdpFallbackForbiddenError(err)) throw err;
      runtimeError = err;
    }
  }

  if (!boundsInfo && !ref.ref?.frameId && ref?.selector) {
    try {
      const contentBounds = await sendToContent(tabId, "getElementScreenshotBounds", {
        selector: ref.selector,
        index: ref.index,
      });
      if (contentBounds?.error) {
        selectorError = contentBounds;
      } else {
        boundsInfo = {
          method: "selector_bounds",
          selector: contentBounds.selector || ref.selector,
          bounds: contentBounds.bounds,
          visible: contentBounds.visible,
          matched: contentBounds.matched,
          viewport: contentBounds.viewport,
        };
      }
    } catch (err) {
      if (isCdpFallbackForbiddenError(err)) throw err;
      selectorError = {
        error: errorMessage(err),
        code: errorCode(err) || "SELECTOR_BOUNDS_FAILED",
        details: record(record(err).details) || {},
      };
    }
  }

  if (!boundsInfo && !ref.ref?.frameId && ref?.ref?.backendNodeId) {
    try {
      boundsInfo = await getElementScreenshotBoundsFromCdp(tabId, ref.ref.backendNodeId, context);
    } catch (err) {
      if (isCdpFallbackForbiddenError(err)) throw err;
      cdpError = err;
    }
  }

  if (!boundsInfo) {
    const error = runtimeError || selectorError || cdpError;
    throw new ToolExecutionError(
      errorCode(error) || "ELEMENT_SCREENSHOT_BOUNDS_FAILED",
      errorMessage(error) || "Cannot resolve element bounds for screenshot",
      {
        ...(record(record(error).details) || {}),
        target: ref.target || elementTargetForRef(ref),
        selector: ref.selector,
        index: ref.index,
        uid: ref.uid || undefined,
        runtimeError: record(runtimeError).message || undefined,
        cdpError: record(cdpError).message || undefined,
        selectorError: record(selectorError).error || record(selectorError).message || undefined,
      },
    );
  }

  const layoutMetrics = await getScreenshotLayoutMetrics(tabId, context);
  if (ref.ref?.frameId) {
    const bounds = normalizeRuntimeBounds(boundsInfo.bounds);
    boundsInfo.bounds = { ...bounds, x: bounds.x + layoutMetrics.pageX, y: bounds.y + layoutMetrics.pageY };
  }
  const { clip, clipped, outputWidth, outputHeight, resized } = buildScreenshotClip(boundsInfo.bounds, {
    padding,
    maxWidth,
    maxHeight,
    layoutMetrics,
  });
  const params: Fields = {
    format,
    fromSurface: true,
    captureBeyondViewport: true,
    clip,
  };
  if (format === "jpeg") params.quality = clampNumber(quality, 1, 100, 70);

  const result = record(await sendCdp(tabId, "Page.captureScreenshot", params, context));
	  if (!result?.data) {
	    throw new ToolExecutionError("ELEMENT_SCREENSHOT_EMPTY", t("cdpReturnedEmptyElementScreenshot"), {
	      tabId,
	      target: ref.target || elementTargetForRef(ref),
	      uid: ref.uid || undefined,
	      selector: ref.selector,
      clip,
    });
  }
  const normalized = await normalizeScreenshot(`data:image/${format};base64,${result.data}`, {
    maxWidth, maxHeight, format, quality: normalizeImageQuality(quality),
  }, context);
  return {
    dataUrl: normalized.dataUrl,
    method: `cdp_element_${boundsInfo.method || "box_model"}`,
	    target: ref.target || elementTargetForRef(ref),
	    selector: boundsInfo.selector || ref.selector,
    clip,
    clipped,
    resized: resized || normalized.resized,
    width: normalized.width || outputWidth,
    height: normalized.height || outputHeight,
    sourceWidth: normalized.sourceWidth,
    sourceHeight: normalized.sourceHeight,
    bounds: boundsInfo.bounds,
    layoutMetrics,
  };
}

async function getFrameElementScreenshotBounds(tabId: number, ref: ScreenshotRef, context: ToolContext): Promise<BoundsInfo> {
  const value = imageMetadata(await callElement(tabId, imageCallTarget({ ...ref, tabId }), "getElementScreenshotBounds", {}, context));
  if (value.error) throw new ToolExecutionError(value.code || "ELEMENT_HAS_NO_RENDERED_BOX", value.error, value.details);
  const bounds = normalizeRuntimeBounds(value.bounds);
  const viewport = record(value.viewport);
  return withDebugger(tabId, async (_target, send) => {
    const owner = record(await send("DOM.getFrameOwner", { frameId: ref.ref!.frameId }));
    const backendNodeId = Number(owner.backendNodeId || 0);
    if (!backendNodeId) throw new ToolExecutionError("ELEMENT_HAS_NO_RENDERED_BOX", t("elementHasNoRenderedBoxToScreenshot"));
    const model = record(record(await send("DOM.getBoxModel", { backendNodeId })).model);
    const content = Array.isArray(model.content) ? model.content : [];
    // CDP gives the iframe content origin in the root viewport. Content bounds
    // include the child's scroll; the caller adds the root document scroll.
    return {
      method: "frame_rect",
      selector: value.selector,
      bounds: { ...bounds, x: Number(content[0]) + bounds.x - Number(viewport.pageX), y: Number(content[1]) + bounds.y - Number(viewport.pageY) },
      viewport: value.viewport,
    };
  }, context);
}

async function getElementScreenshotBoundsFromRuntime(tabId: number, backendNodeId: number, context: ToolContext = {}) {
  return await withDebugger(tabId, async (_target, send) => {
    const resolved = record(await send("DOM.resolveNode", { backendNodeId }));
    const objectId = record(resolved.object).objectId;
    if (!objectId) {
      throw new ToolExecutionError("ELEMENT_RESOLVE_FAILED", t("cannotResolveElementNodeForScreenshot"), {
        tabId,
        backendNodeId,
      });
    }

    const evaluated = await send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: elementPageFunction("bounds"),
    });

    const rawValue = record(record(evaluated).result).value;
    const value = record(rawValue);
    if (!rawValue || value.error) {
      throw new ToolExecutionError("ELEMENT_HAS_NO_RENDERED_BOX", String(value.error || "Element has no rendered box to screenshot"), {
        tabId,
        backendNodeId,
        rect: value?.rect,
      });
    }

    const bounds = normalizeRuntimeBounds(value.bounds);
    return {
      method: "runtime_rect",
      selector: String(value.selector || ""),
      bounds,
      rect: value.rect,
      viewport: value.viewport,
    };
  }, context);
}

async function getElementScreenshotBoundsFromCdp(tabId: number, backendNodeId: number, context: ToolContext = {}) {
  const result = record(await sendCdp(tabId, "DOM.getBoxModel", { backendNodeId }, context));
  const model = record(result.model);
  const quad = model?.border || model?.content || model?.padding || model?.margin;
  const bounds = boundsFromQuad(quad);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new ToolExecutionError("ELEMENT_HAS_NO_RENDERED_BOX", t("elementHasNoRenderedBoxToScreenshot"), {
      tabId,
      backendNodeId,
      model,
    });
  }
  return {
    method: "box_model",
    bounds,
  };
}

async function getScreenshotLayoutMetrics(tabId: number, context: ToolContext = {}) {
  let metrics: Fields = {};
  try {
    metrics = record(await sendCdp(tabId, "Page.getLayoutMetrics", {}, context));
  } catch(error) {
    if (isCdpFallbackForbiddenError(error)) throw error;
  }
  const visual = record(metrics.cssVisualViewport);
  // Legacy contentSize uses physical pixels, so it cannot clamp CSS bounds.
  const content = record(metrics.cssContentSize);
  const metricZoom = toFiniteNumber(visual.zoom, 0);
  const zoom = metricZoom > 0 ? metricZoom : await chrome.tabs.getZoom(tabId);
  return {
    pageX: toFiniteNumber(visual.pageX, 0),
    pageY: toFiniteNumber(visual.pageY, 0),
    scale: toFiniteNumber(visual.scale, 1) || 1,
    zoom,
    contentWidth: toFiniteNumber(content.width, 0),
    contentHeight: toFiniteNumber(content.height, 0),
  };
}

function normalizeRuntimeBounds(bounds: unknown) {
  const source = record(bounds);
  return {
    x: toFiniteNumber(source.x, NaN),
    y: toFiniteNumber(source.y, NaN),
    width: toFiniteNumber(source.width, NaN),
    height: toFiniteNumber(source.height, NaN),
  };
}

function boundsFromQuad(quad: unknown) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number).filter(Number.isFinite);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number).filter(Number.isFinite);
  if (xs.length !== 4 || ys.length !== 4) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function buildScreenshotClip(bounds: unknown, { padding = 0, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE, layoutMetrics = null }: { padding?: number; maxWidth?: number; maxHeight?: number; layoutMetrics?: LayoutMetrics | null } = {}) {
  const source = record(bounds);
  const pad = clampNumber(padding, 0, 200, 0);
  const maxW = clampNumber(maxWidth, 64, IMAGE_MAX_EDGE, IMAGE_MAX_EDGE);
  const maxH = clampNumber(maxHeight, 64, IMAGE_MAX_EDGE, IMAGE_MAX_EDGE);
  const rawX = Number(source.x);
  const rawY = Number(source.y);
  const rawWidth = Number(source.width);
  const rawHeight = Number(source.height);
  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) {
    throw new ToolExecutionError("INVALID_ELEMENT_SCREENSHOT_BOUNDS", t("invalidElementBoundsForScreenshot"), { bounds });
  }

  const x = Math.max(0, rawX - pad);
  const y = Math.max(0, rawY - pad);
  const wantedWidth = rawWidth + pad * 2;
  const wantedHeight = rawHeight + pad * 2;
  const contentWidth = toFiniteNumber(layoutMetrics?.contentWidth, 0);
  const contentHeight = toFiniteNumber(layoutMetrics?.contentHeight, 0);
  const availableWidth = contentWidth > 0 ? Math.max(1, contentWidth - x) : Infinity;
  const availableHeight = contentHeight > 0 ? Math.max(1, contentHeight - y) : Infinity;
  const width = Math.max(1, Math.min(wantedWidth, availableWidth));
  const height = Math.max(1, Math.min(wantedHeight, availableHeight));
  // Element bounds are CSS pixels; CDP screenshot clips are DIP. Convert once,
  // after CSS padding/clipping, and round the edges outwards to retain the box.
  const zoom = layoutMetrics?.zoom || 1;
  const clipX = Math.floor(x * zoom);
  const clipY = Math.floor(y * zoom);
  const clipWidth = Math.ceil((x + width) * zoom) - clipX;
  const clipHeight = Math.ceil((y + height) * zoom) - clipY;
  const scale = Math.min(1, maxW / clipWidth, maxH / clipHeight);
  return {
    clip: {
      x: clipX,
      y: clipY,
      width: clipWidth,
      height: clipHeight,
      scale,
    },
    clipped: width < wantedWidth || height < wantedHeight,
    outputWidth: Math.max(1, Math.round(clipWidth * scale)),
    outputHeight: Math.max(1, Math.round(clipHeight * scale)),
    resized: scale < 1,
  };
}

function toFiniteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function normalizeScreenshot(dataUrl: string, options: Parameters<typeof resizeDataUrlToMaxSize>[1], context: ToolContext) {
  const finishPhase = context.measurePhase?.("normalization");
  try { return await resizeDataUrlToMaxSize(dataUrl, options); }
  finally { finishPhase?.(); }
}

async function screenshotCssSize(tabId: number, native = false, context: ToolContext = {}): Promise<Pick<Screenshot, "cssWidth" | "cssHeight">> {
  const finishPhase = context.measurePhase?.("measurement");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      measureScreenshotCssSize(tabId, native),
      new Promise<Pick<Screenshot, "cssWidth" | "cssHeight">>(resolve => { timer = setTimeout(() => resolve({}), 150); }),
    ]);
  } finally {
    clearTimeout(timer);
    finishPhase?.();
  }
}

async function measureScreenshotCssSize(tabId: number, native: boolean): Promise<Pick<Screenshot, "cssWidth" | "cssHeight">> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      args: [getPageContext(tabId).pageMode === "mobile"],
      func: (mobile: boolean) => {
        const view = globalThis as unknown as {
          innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number;
          visualViewport?: { scale: number };
        };
        const scale = view.visualViewport?.scale || 1;
        // Mobile emulation's outer size is the screen; inner size may be a wider layout.
        return {
          width: mobile ? view.outerWidth : view.innerWidth,
          height: mobile ? view.outerHeight : view.innerHeight,
          scale,
        };
      },
    });
    if (!frame?.result) return {};
    let { width, height, scale } = frame.result;
    if (native) {
      // Native capture covers the actual tab surface, which emulation can clip.
      const [tab, zoom] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.getZoom(tabId)]);
      width = Number(tab.width) / zoom;
      height = Number(tab.height) / zoom;
    }
    return { cssWidth: width / scale, cssHeight: height / scale };
  } catch {
    // Image-only capture remains available on pages that disallow script injection.
    return {};
  }
}

const visibleCaptureQueues = new Map<number, Promise<void>>();

async function withVisibleCapture<T>(windowId: number, fn: () => Promise<T>): Promise<T> {
  const previous = visibleCaptureQueues.get(windowId) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  visibleCaptureQueues.set(windowId, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (visibleCaptureQueues.get(windowId) === tail) visibleCaptureQueues.delete(windowId);
  }
}

async function captureTabScreenshot(tabId: number | undefined, { format = "jpeg", quality = 70, maxWidth = IMAGE_MAX_EDGE, maxHeight = IMAGE_MAX_EDGE }: ScreenshotOptions = {}, context: ToolContext = {}) {
  if (!tabId) throw new ToolExecutionError("MISSING_TAB_ID", t("screenshotRequiresTabid"));
  let phaseStartedAt = Date.now();
  let currentPhase = "guardrails";
  recordScreenCaptureTrace("guardrails.started", tabId, context);
  await assertTabAllowedBySecurityGuardrails(tabId, { tool: "screenshot", source: "tab" });
  recordScreenCaptureTrace("guardrails.done", tabId, context, { elapsedMs: Date.now() - phaseStartedAt });
  await waitForParsedDocument(tabId, context);
  await assertTabAllowedBySecurityGuardrails(tabId, { tool: "screenshot", source: "document_ready" });
  await ensurePageSurface(tabId, (method, params) => sendCdp(tabId, method, params || {}, context));

  try {
    const cssSizePending = screenshotCssSize(tabId, false, context);
    const params: Fields = {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
    };
    if (format === "jpeg") params.quality = quality;
    phaseStartedAt = Date.now();
    currentPhase = "cdp";
    recordScreenCaptureTrace("cdp.started", tabId, context, { format });
    const result = record(await sendCdp(tabId, "Page.captureScreenshot", params, context));
    recordScreenCaptureTrace("cdp.done", tabId, context, {
      elapsedMs: Date.now() - phaseStartedAt,
      bytes: typeof result.data === "string" ? Math.floor(result.data.length * 0.75) : 0,
    });
    if (result?.data) {
      phaseStartedAt = Date.now();
      currentPhase = "normalize";
      recordScreenCaptureTrace("normalize.started", tabId, context, { source: "cdp" });
      const normalized = await normalizeScreenshot(`data:image/${format};base64,${result.data}`, {
        maxWidth,
        maxHeight,
        format,
        quality: normalizeImageQuality(quality),
      }, context);
      recordScreenCaptureTrace("normalize.done", tabId, context, {
        source: "cdp",
        elapsedMs: Date.now() - phaseStartedAt,
        resized: normalized.resized === true,
        width: normalized.width,
        height: normalized.height,
      });
      context.signal?.throwIfAborted();
      context.reportPartial?.({ tabId, _image: normalized.dataUrl, method: "cdp", actionable: false }, "screenshot dimensions and coordinate validation");
      const cssSize = await cssSizePending;
      return {
        ...cssSize,
        dataUrl: normalized.dataUrl,
        method: normalized.resized ? "cdp_resized" : "cdp",
        resized: normalized.resized,
        animationFlattened: normalized.animationFlattened,
        width: normalized.width,
        height: normalized.height,
        sourceWidth: normalized.sourceWidth,
        sourceHeight: normalized.sourceHeight,
      };
    }
  } catch(error) {
    recordScreenCaptureTrace(`${currentPhase}.failed`, tabId, context, {
      elapsedMs: Date.now() - phaseStartedAt,
      code: errorCode(error) || "",
      error: record(error).message || String(error),
    });
    if (context.signal?.aborted || error instanceof ImageLimitError || isCdpFallbackForbiddenError(error)) throw error;
    // captureVisibleTab fallback below handles pages/CDP states that cannot be captured.
  }

  const targetTab = await chrome.tabs.get(tabId);
  return withVisibleCapture(targetTab.windowId, async () => {
  context.signal?.throwIfAborted();
  const previousTabs = await chrome.tabs.query({ windowId: targetTab.windowId, active: true });
  const previousActiveTabId = previousTabs[0]?.id;

  try {
    if (previousActiveTabId !== tabId) {
      phaseStartedAt = Date.now();
      recordScreenCaptureTrace("activate.started", tabId, context, { previousTab: previousActiveTabId });
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 200));
      recordScreenCaptureTrace("activate.done", tabId, context, { elapsedMs: Date.now() - phaseStartedAt });
    }
    phaseStartedAt = Date.now();
    recordScreenCaptureTrace("visible_tab.started", tabId, context, { format });
    const cssSizePending = screenshotCssSize(tabId, true, context);
    context.signal?.throwIfAborted();
    const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, {
      format,
      quality: format === "jpeg" ? quality : undefined,
    });
    recordScreenCaptureTrace("visible_tab.done", tabId, context, {
      elapsedMs: Date.now() - phaseStartedAt,
      bytes: estimateDataUrlBytes(dataUrl),
    });
    phaseStartedAt = Date.now();
    recordScreenCaptureTrace("normalize.started", tabId, context, { source: "visible_tab" });
    const normalized = await normalizeScreenshot(dataUrl, {
      maxWidth,
      maxHeight,
      format,
      quality: normalizeImageQuality(quality),
    }, context);
    recordScreenCaptureTrace("normalize.done", tabId, context, {
      source: "visible_tab",
      elapsedMs: Date.now() - phaseStartedAt,
      resized: normalized.resized === true,
      width: normalized.width,
      height: normalized.height,
    });
    context.signal?.throwIfAborted();
    context.reportPartial?.({ tabId, _image: normalized.dataUrl, method: "visible_tab", actionable: false }, "screenshot dimensions and coordinate validation");
    const cssSize = await cssSizePending;
    return {
      ...cssSize,
      dataUrl: normalized.dataUrl,
      method: `${previousActiveTabId === tabId ? "visible_tab" : "visible_tab_restore"}${normalized.resized ? "_resized" : ""}`,
      resized: normalized.resized,
      animationFlattened: normalized.animationFlattened,
      width: normalized.width,
      height: normalized.height,
      sourceWidth: normalized.sourceWidth,
      sourceHeight: normalized.sourceHeight,
    };
  } finally {
    if (previousActiveTabId && previousActiveTabId !== tabId) {
      try { await chrome.tabs.update(previousActiveTabId, { active: true }); } catch(_e) {}
    }
  }
  });
}

function recordScreenCaptureTrace(phase: string, tabId: number, context: ToolContext = {}, fields: Fields = {}) {
  diagnosticTrace(`screen_capture_trace${formatTraceFields({
    phase,
    session: context?.sessionId || "",
    run: context?.runId || "",
    call: context?.toolCallId || context?.callId || "",
    tab: Number(tabId) || 0,
    ...fields,
  })}`);
}

  return Object.freeze({
    captureElementScreenshot,
    captureTabScreenshot,
    releaseRunScreenState: screenActions.releaseRun,
  });
}


export default ((host) => {
  const runtime = registerMediaTools({ ...host, ...host.element });
  return { captureTabScreenshot: runtime.captureTabScreenshot, releaseRun: runtime.releaseRunScreenState };
}) satisfies ToolExtension;

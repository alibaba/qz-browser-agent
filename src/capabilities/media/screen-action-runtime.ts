import { t } from "./i18n.js";
import { IMAGE_MAX_EDGE } from "#sdk/shared/images";
import { assertHtmlPage } from "#sdk/background/browser";
import type { ToolContext, ToolErrorConstructor, ToolExtensionAPI } from "#sdk/background";
import type { CdpCommand, BrowserDebugger } from "#sdk/background/browser";
import type { MappedKey } from "#sdk/background/browser";
type Fields = Record<string, unknown>;
type CdpRuntime = BrowserDebugger;
import type { PageObservationHost, ScreenshotOptions, Screenshot } from "#sdk/background/browser";
export interface ScreenActionHost extends PageObservationHost {
  ToolExecutionError: ToolErrorConstructor;
  captureTabScreenshot(tabId: number, options?: ScreenshotOptions, context?: ToolContext): Promise<Screenshot>;
  sendCdp: CdpRuntime["sendCdp"]; withDebugger: CdpRuntime["withDebugger"];
  getPageContext: ToolExtensionAPI["getPageContext"];
  createPresentationImage?(image: string): Promise<string>;
  now?(): number;
}
interface Viewport { width: number; height: number; pageX: number; pageY: number; scale: number }
interface State { url: string; loaderId: string; viewport: Viewport }
type CoordinateSpace = ReturnType<typeof imageCoordinateSpace>;
interface Snapshot { id: string; tabId: number; sessionId: string; runId: string; state: State; coordinateSpace: CoordinateSpace; cssWidth: number; cssHeight: number; createdAt: number; consumedAt: number; invalidReason: string }
interface Point { x: number; y: number }
interface ScreenPoint extends Point { imageX: number; imageY: number; ratioX: number; ratioY: number }
interface Marker { kind: string; action: string; x: number; y: number; ratioX: number; ratioY: number; endX?: number; endY?: number; endRatioX?: number; endRatioY?: number; direction?: string }
interface ValidatedAction extends Fields {
  action: string; returnScreenshot: boolean; button?: string; durationMs?: number; replace?: boolean;
  key?: MappedKey; deltaX?: number; deltaY?: number; repeat?: number;
}
interface PreparedAction {
  action: string; point: ScreenPoint | null; marker: Marker | null; button?: string; durationMs?: number;
  text?: string; replace?: boolean; key?: MappedKey; deltaX?: number; deltaY?: number; repeat?: number; endPoint?: ScreenPoint;
}
interface InputDispatch { total: number; error: unknown; fail(error: unknown, command: string): void }
interface PerformedAction { point: Point | null; marker: Marker | null; durationMs?: number; repeat?: number; endPoint?: Point | null; inputDispatch?: InputDispatch }
const record = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(record(error).message || error);
import { createCdpKeyboard, createCdpTouch, primaryModifierForContext } from "#sdk/background/browser";
import { bindToolResultPresentation, diagnosticTrace, formatTraceFields } from "#sdk/background/tools";

const SNAPSHOT_LIMIT = 64;
const PRESENTATION_QUALITY = 72;
const DEFAULT_LONG_PRESS_MS = 800;
const MIN_LONG_PRESS_MS = 300;
const MAX_LONG_PRESS_MS = 5000;
const DEFAULT_SCROLL_REPEAT = 1;
const MAX_SCROLL_REPEAT = 20;
const SCROLL_EVENT_INTERVAL_MS = 50;
const VIEWPORT_RESIZE_TOLERANCE_PX = 3;
const CAPTURE_CHECK_DELAY_MS = 200;
const ACTIONS = Object.freeze(["click", "double_click", "long_press", "hover", "type", "press", "scroll", "drag"]);

/** Owns screenshot coordinates, raw CDP input, observation images, and direct-call animation frames. */
export function createScreenActionRuntime({
  ToolExecutionError,
  captureTabScreenshot,
  getTabPageState,
  pageStateDelta,
  commitObservedPageNavigation,
  getSecurityGuardrails,
  sendCdp,
  withDebugger,
  getPageContext,
  createPresentationImage = async image => image,
  now = () => Date.now(),
}: ScreenActionHost) {
  const snapshotsByScope = new Map<string, Snapshot>();
  const touch = createCdpTouch({ ToolExecutionError });
  const keyboard = createCdpKeyboard({ sendCdp, ToolExecutionError });

  async function capture(tabId: number, options: ScreenshotOptions = {}, context: ToolContext = {}, traceMeta: Fields = {}, signal?: AbortSignal) {
    const captureStartedAt = Date.now();
    recordTrace("capture.started", context, tabId, traceMeta);
    return await withDebugger(tabId, async () => {
      const frame = await captureFrame(tabId, options, context, traceMeta, signal);
      recordTrace("capture.frame.done", context, tabId, traceMeta, {
        elapsedMs: Date.now() - captureStartedAt,
        method: frame.shot?.method || "",
        width: frame.shot?.width || frame.shot?.sourceWidth,
        height: frame.shot?.height || frame.shot?.sourceHeight,
      });
      const snapshot = register(tabId, frame.state, frame.shot, context);
      recordTrace("capture.done", context, tabId, traceMeta, {
        elapsedMs: Date.now() - captureStartedAt,
        screenshot: snapshot.id,
      });
      return {
        shot: frame.shot,
        state: snapshot.state,
        snapshotId: snapshot.id,
        coordinateSpace: snapshot.coordinateSpace,
      };
    }, context);
  }

  async function capturePresentationFrame(tabId: number, context: ToolContext = {}, traceMeta: Fields = {}) {
    const startedAt = Date.now();
    recordTrace("presentation.capture.started", context, tabId, traceMeta);
    try {
      const shot = await captureTabScreenshot(tabId, {
        format: "jpeg",
        quality: PRESENTATION_QUALITY,
        maxWidth: IMAGE_MAX_EDGE,
        maxHeight: IMAGE_MAX_EDGE,
      }, context);
      const fullImage = inlineImageDataUrl(shot?.dataUrl);
      const image = fullImage
        ? (inlineImageDataUrl(await createPresentationImage(fullImage)) || fullImage)
        : "";
      recordTrace("presentation.capture.done", context, tabId, traceMeta, {
        elapsedMs: Date.now() - startedAt,
        method: shot?.method || "",
      });
      return image;
    } catch (error) {
      recordTrace("presentation.capture.failed", context, tabId, traceMeta, {
        elapsedMs: Date.now() - startedAt,
        code: record(error).code || "",
        error: errorMessage(error),
      });
      return "";
    }
  }

  async function presentationFromObservation(observation: Awaited<ReturnType<typeof capture>>, context: ToolContext = {}, tabId: number, traceMeta: Fields = {}) {
    const fullImage = inlineImageDataUrl(observation?.shot?.dataUrl);
    if (!fullImage) return "";
    const startedAt = Date.now();
    recordTrace("presentation.resize.started", context, tabId, traceMeta);
    try {
      const image = inlineImageDataUrl(await createPresentationImage(fullImage)) || fullImage;
      recordTrace("presentation.resize.done", context, tabId, traceMeta, {
        elapsedMs: Date.now() - startedAt,
        fallback: image === fullImage,
      });
      return image;
    } catch (error) {
      recordTrace("presentation.resize.failed", context, tabId, traceMeta, {
        elapsedMs: Date.now() - startedAt,
        code: record(error).code || "",
        error: errorMessage(error),
      });
      return fullImage;
    }
  }

  async function act(args: Fields = {}, signal?: AbortSignal, context: ToolContext = {}) {
    const validated = validate(args);
    const { returnScreenshot, action } = validated;
    const tabId = Number(validated.tabId);
    const coordinateIndependent = ["press", "type", "scroll"].includes(action) && validated.x == null;
    const snapshot = coordinateIndependent ? null : resolve(tabId, context);
    const retainedSnapshot = coordinateIndependent ? latestSnapshot(tabId, context) : snapshot;
    const prepared = snapshot ? prepareAction(validated, snapshot) : null;
    const traceMeta = { action, screenshot: snapshot?.id || "" };
    const animate = context.source !== "run_script";
    const actionStartedAt = Date.now();
    recordTrace("action.started", context, tabId, traceMeta, { returnScreenshot });
    // The current coordinate space may be reused by a serial sequence, but never
    // by concurrent physical actions.
    if (snapshot) snapshot.consumedAt = timestamp();
    try {
      let phaseStartedAt = Date.now();
      recordTrace("action.page_before.started", context, tabId, traceMeta);
      const pageBefore = await getTabPageState(tabId);
      recordTrace("action.page_before.done", context, tabId, traceMeta, { elapsedMs: Date.now() - phaseStartedAt });
      phaseStartedAt = Date.now();
      recordTrace("action.guardrails.started", context, tabId, traceMeta);
      const guardrails = await getSecurityGuardrails();
      recordTrace("action.guardrails.done", context, tabId, traceMeta, { elapsedMs: Date.now() - phaseStartedAt });

      return await withDebugger(tabId, async (_target, sendCommand) => {
        const dispatch: CdpCommand = typeof sendCommand === "function"
          ? sendCommand
          : (method, params) => sendCdp(tabId, method, params, context);
        assertNotAborted(signal, tabId);
        phaseStartedAt = Date.now();
        recordTrace("action.coordinate_check.started", context, tabId, traceMeta);
        const { current, staleReason } = snapshot
          ? await readActionState(tabId, snapshot.state, context)
          : { current: await readState(tabId, context), staleReason: "" };
        const sourceViewport = snapshot?.state?.viewport || current.viewport;
        const currentViewport = current.viewport;
        const viewportDiagnostics = {
          sourceViewportWidth: finite(sourceViewport.width),
          sourceViewportHeight: finite(sourceViewport.height),
          currentViewportWidth: finite(currentViewport.width),
          currentViewportHeight: finite(currentViewport.height),
          viewportWidthDelta: roundedDelta(finite(currentViewport.width) - finite(sourceViewport.width)),
          viewportHeightDelta: roundedDelta(finite(currentViewport.height) - finite(sourceViewport.height)),
          viewportResizeTolerancePx: VIEWPORT_RESIZE_TOLERANCE_PX,
        };
        recordTrace("action.coordinate_check.done", context, tabId, traceMeta, {
          elapsedMs: Date.now() - phaseStartedAt,
          staleReason,
          ...viewportDiagnostics,
        });
        if (staleReason) throw staleError(staleReason, {
          screenshotId: snapshot?.id,
          ...viewportDiagnostics,
        });

        const beforeImage = animate
          ? await capturePresentationFrame(tabId, context, { ...traceMeta, frame: "before" })
          : "";
        const inputStartedAt = Date.now();
        recordTrace("action.input.started", context, tabId, traceMeta);
        const performed = await perform(tabId, prepared || prepareAction(validated, null, current.viewport), signal, context, dispatch);
        recordTrace(performed.inputDispatch ? "action.input.dispatched" : "action.input.done", context, tabId, traceMeta, {
          elapsedMs: Date.now() - inputStartedAt,
          dispatched: performed.inputDispatch?.total || undefined,
        });
        if (performed.inputDispatch?.error) throw performed.inputDispatch.error;

        let observation = null;
        let observationError = null;
        let actionStateAfter = null;
        let afterImage = "";
        if (returnScreenshot) {
          try {
            observation = await capture(tabId, {
              format: "jpeg",
              quality: 82,
              maxWidth: IMAGE_MAX_EDGE,
              maxHeight: IMAGE_MAX_EDGE,
            }, context, { ...traceMeta, capture: "observation" }, signal);
            actionStateAfter = observation.state;
            if (animate) {
              afterImage = await presentationFromObservation(observation, context, tabId, traceMeta);
            }
          } catch (error) {
            recordTrace("action.observation.failed", context, tabId, traceMeta, {
              code: record(error).code || "",
              error: errorMessage(error),
            });
            observationError = compactRuntimeError(error, "SCREENSHOT_FEEDBACK_FAILED");
          }
        }
        if (animate && !afterImage) {
          afterImage = await capturePresentationFrame(tabId, context, { ...traceMeta, frame: "after" });
        }
        if (!actionStateAfter) {
          try {
            phaseStartedAt = Date.now();
            recordTrace("action.state_after.started", context, tabId, traceMeta);
            actionStateAfter = await readState(tabId, context);
            recordTrace("action.state_after.done", context, tabId, traceMeta, { elapsedMs: Date.now() - phaseStartedAt });
          } catch (error) {
            recordTrace("action.state_after.failed", context, tabId, traceMeta, {
              elapsedMs: Date.now() - phaseStartedAt,
              code: record(error).code || "",
              error: errorMessage(error),
            });
          }
        }

        if (performed.inputDispatch) {
          if (performed.inputDispatch.error) throw performed.inputDispatch.error;
          recordTrace("action.input.done", context, tabId, traceMeta, {
            elapsedMs: Date.now() - inputStartedAt,
            dispatched: performed.inputDispatch.total,
          });
        }

        phaseStartedAt = Date.now();
        recordTrace("action.page_after.started", context, tabId, traceMeta);
        const pageAfter = await getTabPageState(tabId);
        recordTrace("action.page_after.done", context, tabId, traceMeta, { elapsedMs: Date.now() - phaseStartedAt });
        const delta = pageStateDelta(pageBefore, pageAfter);
        const observedNavigation = commitObservedPageNavigation?.({
          pageBefore,
          pageAfter,
          guardrails,
          toolName: "act_on_screen",
          tabId,
        });
        const retainedBasisInvalidReason = observation || !retainedSnapshot
          ? ""
          : retainedSnapshot.invalidReason || coordinateBasisInvalidReason(retainedSnapshot.state, actionStateAfter);
        const coordinateBasisReady = Boolean(
          observation || (retainedSnapshot && actionStateAfter && !retainedBasisInvalidReason),
        );
        if (!observation && retainedSnapshot && latestSnapshot(tabId, context) === retainedSnapshot) {
          retainedSnapshot.invalidReason = retainedBasisInvalidReason;
          if (coordinateBasisReady && actionStateAfter) retainedSnapshot.state = actionStateAfter;
        }
        const popups = await context.observedPopups?.();
        const result = {
          status: "completed",
          action,
          ...(snapshot ? {
            sourceScreenshotId: snapshot.id,
            sourceCoordinateSpace: snapshot.coordinateSpace,
          } : {}),
          marker: publicMarker(performed.marker),
          resolvedPoint: performed.point || undefined,
          resolvedEndPoint: performed.endPoint || undefined,
          durationMs: performed.durationMs || undefined,
          repeat: performed.repeat || undefined,
          viewportChange: describeViewportChange(current, actionStateAfter),
          ...delta,
          ...(observedNavigation ? { observedNavigation } : {}),
          ...(popups?.length ? { popups } : {}),
          ...(observation ? {
            _image: observation.shot.dataUrl,
            _imageDetail: "high",
            screenshotId: observation.snapshotId,
          } : {}),
          ...(observation?.coordinateSpace || retainedSnapshot?.coordinateSpace ? {
            coordinateSpace: observation?.coordinateSpace || retainedSnapshot?.coordinateSpace,
          } : {}),
          feedbackAvailable: Boolean(observation),
          coordinateBasisReady,
          ...(observationError ? { feedbackError: observationError } : {}),
          ...(retainedBasisInvalidReason ? { continuationBlockedReason: retainedBasisInvalidReason } : {}),
          note: observation
            ? t("actionCompletedTheScreenshotAfterTheActionIsAttached")
            : (returnScreenshot
              ? t("actionCompletedButTheObservationScreenshotFailed")
              : t("actionCompletedWithoutAnObservationScreenshot")),
        };
        recordTrace("action.done", context, tabId, traceMeta, {
          elapsedMs: Date.now() - actionStartedAt,
          observation: Boolean(observation),
          animation: animate,
        });
        return bindToolResultPresentation(result, animate ? imageActionDisplay(performed.marker, { action, beforeImage, afterImage }) : {});
      }, context);
    } finally {
      if (snapshot && latestSnapshot(tabId, context) === snapshot) snapshot.consumedAt = 0;
    }
  }

  async function captureFrame(tabId: number, options: ScreenshotOptions, context: ToolContext, traceMeta: Fields, signal?: AbortSignal) {
    assertNotAborted(signal, tabId);
    let before = await readState(tabId, context);
    for (let attempt = 1; ; attempt++) {
      assertNotAborted(signal, tabId);
      let stageStartedAt = Date.now();
      recordTrace("capture.screenshot.started", context, tabId, traceMeta, { attempt });
      const shot = await captureTabScreenshot(tabId, options, context);
      recordTrace("capture.screenshot.done", context, tabId, traceMeta, {
        elapsedMs: Date.now() - stageStartedAt,
        method: shot?.method || "",
      });
      // Allow delayed viewport changes (including Chrome's debugger infobar)
      // before validating every requested, post-action, or retried frame.
      await delay(CAPTURE_CHECK_DELAY_MS, signal, tabId);
      stageStartedAt = Date.now();
      recordTrace("capture.state.started", context, tabId, traceMeta);
      const state = await readState(tabId, context);
      assertNotAborted(signal, tabId);
      recordTrace("capture.state.done", context, tabId, traceMeta, { elapsedMs: Date.now() - stageStartedAt });
      const reason = stateChange(before, state, true);
      if (!reason) return { shot, state };
      const previous = latestSnapshot(tabId, context);
      if (previous) previous.invalidReason = reason;
      recordTrace("capture.discarded", context, tabId, traceMeta, { attempt, reason });
      if (attempt === 2) throw staleError(reason, { phase: "capture", attempts: attempt });
      before = state;
    }
  }

  function scope(context: ToolContext, tabId: unknown) {
    return `${String(context.sessionId || "")}\u0000${String(context.runId || "")}\u0000${Number(tabId) || 0}`;
  }

  function register(tabId: number, state: State, shot: Screenshot, context: ToolContext) {
    const cssWidth = Number(shot.cssWidth), cssHeight = Number(shot.cssHeight);
    if (![cssWidth, cssHeight].every(value => Number.isFinite(value) && value > 0)) {
      throw new ToolExecutionError("SCREENSHOT_COORDINATES_UNAVAILABLE", t("theCurrentVisualViewportCouldNotBeMeasuredFor"), {});
    }
    const createdAt = timestamp();
    prune();
    const key = scope(context, tabId);
    const id = snapshotId(createdAt);
    const snapshot = {
      id,
      tabId: Number(tabId),
      sessionId: String(context.sessionId || ""),
      runId: String(context.runId || ""),
      state,
      coordinateSpace: imageCoordinateSpace(shot, state.viewport),
      cssWidth, cssHeight,
      createdAt,
      consumedAt: 0,
      invalidReason: "",
    };
    snapshotsByScope.set(key, snapshot);
    return snapshot;
  }

  function latestSnapshot(tabId: number, context: ToolContext) {
    const key = scope(context, tabId);
    return snapshotsByScope.get(key) || null;
  }

  function resolve(tabId: number, context: ToolContext) {
    const key = scope(context, tabId);
    const snapshot = snapshotsByScope.get(key);
    if (!snapshot) throw staleError("latest_missing");
    if (snapshot.sessionId !== String(context.sessionId || "")
      || snapshot.runId !== String(context.runId || "")
      || snapshot.tabId !== Number(tabId)) {
      throw staleError("context_mismatch", { screenshotId: snapshot.id });
    }
    if (snapshot.invalidReason) throw staleError(snapshot.invalidReason, { screenshotId: snapshot.id });
    if (snapshot.consumedAt) throw staleError("already_used", { screenshotId: snapshot.id });
    return snapshot;
  }

  function prune() {
    while (snapshotsByScope.size >= SNAPSHOT_LIMIT) {
      const key = snapshotsByScope.keys().next().value;
      if (key !== undefined) snapshotsByScope.delete(key);
    }
  }

  function releaseRun(sessionId: unknown, runId: unknown) {
    const targetSessionId = String(sessionId || "");
    const targetRunId = String(runId || "");
    let released = 0;
    for (const [key, snapshot] of snapshotsByScope) {
      if (snapshot.sessionId !== targetSessionId || snapshot.runId !== targetRunId) continue;
      snapshotsByScope.delete(key);
      released += 1;
    }
    return released;
  }

  function staleError(reason: string, details: Fields = {}) {
    return new ToolExecutionError(
      "SCREENSHOT_CONTEXT_STALE",
      t("theActionableScreenshotIsNoLongerSafeToUse"),
      {
        ...details,
        reason,
        recommendedAction: details.recommendedAction
          || "Call screenshot with actionable=true, then retry act_on_screen using the returned image.",
      },
    );
  }

  async function readState(tabId: number, context: ToolContext = {}) {
    const metrics = record(await sendCdp(tabId, "Page.getLayoutMetrics", {}, context));
    const raw = record(metrics?.cssVisualViewport
      || metrics?.visualViewport
      || metrics?.cssLayoutViewport
      || metrics?.layoutViewport
      || {});
    const width = Number(raw.clientWidth);
    const height = Number(raw.clientHeight);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new ToolExecutionError(
        "SCREENSHOT_COORDINATES_UNAVAILABLE",
        t("theCurrentVisualViewportCouldNotBeMeasuredFor"),
        { viewport: raw },
      );
    }
    let frame: Fields = {};
    try {
      frame = record(record(record(await sendCdp(tabId, "Page.getFrameTree", {}, context)).frameTree).frame);
    } catch (_error) {}
    const page = await getTabPageState(tabId);
    assertHtmlPage(frame.url || page?.url, frame.mimeType);
    return {
      url: String(frame.url || page?.url || ""),
      loaderId: String(frame.loaderId || ""),
      viewport: {
        width,
        height,
        pageX: finite(raw.pageX),
        pageY: finite(raw.pageY),
        scale: finite(raw.scale, 1) || 1,
      },
    };
  }

  async function readActionState(tabId: number, expected: State, context: ToolContext = {}) {
    const current = await readState(tabId, context);
    return { current, staleReason: stateChange(expected, current) };
  }

  function validate(args: Fields = {}): ValidatedAction {
    const action = normalizeAction(args.action, ToolExecutionError);
    const returnScreenshot = requiredReturnScreenshot(args.returnScreenshot, ToolExecutionError);
    const hasX = args.x != null;
    const hasY = args.y != null;
    if (hasX !== hasY) throw coordinateError("x_and_y_must_be_paired", { x: args.x, y: args.y });
    const validated: ValidatedAction = { ...args, action, returnScreenshot };
    if (["click", "double_click", "long_press", "drag"].includes(action)) {
      validated.button = mouseButton(args.button, ToolExecutionError);
    }
    if (action === "long_press") {
      validated.durationMs = longPressDuration(args.durationMs, ToolExecutionError);
    }
    if (action === "type") {
      if (typeof args.text !== "string" || (!args.text.length && args.replace !== true)) {
        throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", t("typeRequiresTextOrReplaceTrueWithEmptyText"), {
          action,
          missing: ["text"],
        });
      }
      validated.replace = args.replace === true;
    }
    if (action === "press") {
      if (!String(args.key || "").trim()) {
        throw new ToolExecutionError("MISSING_KEY", t("pressRequiresKey"), { action });
      }
      validated.key = keyboard.normalize(String(args.key));
    }
    if (action === "scroll") {
      validated.deltaX = scrollDelta(args.deltaX, ToolExecutionError);
      validated.deltaY = scrollDelta(args.deltaY, ToolExecutionError);
      validated.repeat = scrollRepeat(args.repeat, ToolExecutionError);
      if (validated.deltaX === 0 && validated.deltaY === 0) {
        throw new ToolExecutionError("MISSING_REQUIRED_ARGUMENTS", t("scrollRequiresANonZeroDeltaxOrDeltay"), {
          action,
          missing: ["deltaX or deltaY"],
        });
      }
    }
    return validated;
  }

  function prepareAction(args: ValidatedAction, snapshot: Snapshot | null, viewport?: Viewport): PreparedAction {
    const { action } = args;
    const hasX = args.x != null;
    const needsPoint = ["click", "double_click", "long_press", "hover", "drag"].includes(action);
    const point = needsPoint || hasX
      ? screenPoint(args.x, args.y, snapshot, "point")
      : (action === "scroll"
        ? { x: viewport!.width / 2, y: viewport!.height / 2,
          imageX: viewport!.width / 2, imageY: viewport!.height / 2, ratioX: 0.5, ratioY: 0.5 }
        : null);
    const prepared: PreparedAction = {
      action,
      point,
      marker: point ? {
        kind: "point",
        action,
        x: point!.imageX,
        y: point!.imageY,
        ratioX: point!.ratioX,
        ratioY: point!.ratioY,
      } : null,
    };

    if (args.button) prepared.button = args.button;
    if (action === "long_press") prepared.durationMs = args.durationMs;
    if (action === "type") {
      prepared.text = String(args.text);
      prepared.replace = args.replace;
    }
    if (action === "press") prepared.key = args.key;
    if (action === "scroll") {
      prepared.deltaX = args.deltaX;
      prepared.deltaY = args.deltaY;
      prepared.repeat = args.repeat;
      prepared.marker = {
        ...prepared.marker!,
        direction: scrollDirection(prepared.deltaX!, prepared.deltaY!),
      };
    }
    if (action === "drag") {
      prepared.endPoint = screenPoint(args.endX, args.endY, snapshot, "endPoint");
      prepared.marker = {
        kind: "drag",
        action,
        x: point!.imageX,
        y: point!.imageY,
        endX: prepared.endPoint.imageX,
        endY: prepared.endPoint.imageY,
        ratioX: point!.ratioX,
        ratioY: point!.ratioY,
        endRatioX: prepared.endPoint.ratioX,
        endRatioY: prepared.endPoint.ratioY,
      };
    }
    return prepared;
  }

  async function perform(tabId: number, prepared: PreparedAction, signal: AbortSignal | undefined, context: ToolContext = {}, sendCommand: CdpCommand): Promise<PerformedAction> {
    const { action, button, point, marker } = prepared;
    assertNotAborted(signal, tabId);
    const mobile = getPageContext(tabId).pageMode === "mobile";
    if (mobile && (action === "hover" || (button && button !== "left"))) {
      throw new ToolExecutionError("TOUCH_ACTION_UNSUPPORTED", t("unsupportedActOnScreenAction", { action }), { action, button, pageMode: "mobile" });
    }
    const press = (clickCount = 1, holdMs = 0) => mobile
      ? touch(sendCommand, point!, { durationMs: holdMs, signal })
      : pressMouse(tabId, point!, button || "left", { clickCount, holdMs, signal, context });

    if (action === "click" || action === "double_click") {
      await press();
      if (action === "double_click") {
        await delay(55, signal, tabId);
        await press(2);
      }
      return { point: publicPoint(point), marker };
    }
    if (action === "long_press") {
      await press(1, prepared.durationMs);
      return { point: publicPoint(point), durationMs: prepared.durationMs, marker };
    }
    if (action === "hover") {
      await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point!.x, y: point!.y, button: "none" }, context);
      return { point: publicPoint(point), marker };
    }
    if (action === "type") {
      if (point) await press();
      if (prepared.replace) {
        await keyboard.press(tabId, `${primaryModifierForContext(context)}+A`, context);
        await keyboard.press(tabId, "Backspace", context);
      }
      if (prepared.text!.length) {
        await sendCdp(tabId, "Input.insertText", { text: prepared.text }, context);
      }
      return { point: publicPoint(point), marker };
    }
    if (action === "press") {
      if (point) await press();
      await keyboard.press(tabId, prepared.key!, context);
      return { point: publicPoint(point), marker };
    }
    if (action === "scroll") {
      const inputDispatch = createInputDispatchState(context, tabId, action);
      for (let index = 0; index < prepared.repeat!; index += 1) {
        assertNotAborted(signal, tabId);
        issueInputCommand(inputDispatch, `wheel:${index + 1}`, () => sendCommand("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point!.x,
          y: point!.y,
          deltaX: prepared.deltaX,
          deltaY: prepared.deltaY,
        }));
        await delay(SCROLL_EVENT_INTERVAL_MS, signal, tabId);
      }
      return { point: publicPoint(point), repeat: prepared.repeat, marker, inputDispatch };
    }

    const { endPoint } = prepared;
    if (mobile) {
      await touch(sendCommand, point!, { end: endPoint!, durationMs: 200, signal });
      return { point: publicPoint(point), endPoint: publicPoint(endPoint), marker };
    }
    const inputDispatch = createInputDispatchState(context, tabId, action);
    let pressed = false;
    try {
      issueInputCommand(inputDispatch, "mousePressed", () => mouse(tabId, "mousePressed", point!, button, buttonsMask(button), 1, context, sendCommand));
      pressed = true;
      for (let step = 1; step <= 8; step += 1) {
        assertNotAborted(signal, tabId);
        const ratio = step / 8;
        issueInputCommand(inputDispatch, `mouseMoved:${step}`, () => mouse(tabId, "mouseMoved", {
          x: point!.x + (endPoint!.x - point!.x) * ratio,
          y: point!.y + (endPoint!.y - point!.y) * ratio,
        }, button, buttonsMask(button), undefined, context, sendCommand));
        if (step < 8) await delay(12, signal, tabId);
      }
      issueInputCommand(inputDispatch, "mouseReleased", () => mouse(tabId, "mouseReleased", endPoint!, button, 0, 1, context, sendCommand));
      pressed = false;
    } finally {
      if (pressed) {
        issueBestEffortInput(() => mouse(tabId, "mouseReleased", endPoint!, button, 0, 1, context, sendCommand));
      }
    }
    return { point: publicPoint(point), endPoint: publicPoint(endPoint), marker, inputDispatch };
  }

  async function pressMouse(tabId: number, point: Point, button: string | undefined, { clickCount = 1, holdMs = 0, signal, context = {} }: { clickCount?: number; holdMs?: number; signal?: AbortSignal; context?: ToolContext } = {}) {
    let pressed = false;
    try {
      await mouse(tabId, "mousePressed", point, button, buttonsMask(button), clickCount, context);
      pressed = true;
      if (holdMs > 0) await delay(holdMs, signal, tabId);
      await mouse(tabId, "mouseReleased", point, button, 0, clickCount, context);
      pressed = false;
    } finally {
      if (pressed) {
        try { await mouse(tabId, "mouseReleased", point, button, 0, clickCount, context); } catch (_error) {}
      }
    }
  }

  function mouse(tabId: number, type: string, point: Point, button: string | undefined, buttons: number, clickCount: number | undefined, context: ToolContext = {}, sendCommand: CdpCommand | null = null) {
    const params = {
      type,
      x: point.x,
      y: point.y,
      button,
      buttons,
      ...(clickCount ? { clickCount } : {}),
    };
    return sendCommand
      ? sendCommand("Input.dispatchMouseEvent", params)
      : sendCdp(tabId, "Input.dispatchMouseEvent", params, context);
  }

  function screenPoint(rawX: unknown, rawY: unknown, snapshot: Snapshot | null, label: string) {
    if (!snapshot) throw staleError("latest_missing");
    const { coordinateSpace: space, cssWidth, cssHeight } = snapshot;
    const imageX = coordinate(rawX, `${label}.x`, space.width, space);
    const imageY = coordinate(rawY, `${label}.y`, space.height, space);
    const ratioX = imageX / space.width;
    const ratioY = imageY / space.height;
    return {
      imageX,
      imageY,
      ratioX,
      ratioY,
      x: Math.max(0, Math.min(cssWidth - 0.5, ratioX * cssWidth)),
      y: Math.max(0, Math.min(cssHeight - 0.5, ratioY * cssHeight)),
    };
  }

  function coordinate(value: unknown, field: string, maximum: number, space: CoordinateSpace) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > maximum) {
      throw coordinateError("out_of_range", { field, value, min: 0, max: maximum }, space);
    }
    return number;
  }

  function coordinateError(reason: string, details: Fields, coordinateSpace?: CoordinateSpace) {
    return new ToolExecutionError(
      "INVALID_SCREEN_COORDINATE",
      t("screenCoordinatesMustBeFinitePixelPositionsInsideThe"),
      { ...details, reason, coordinateSpace },
    );
  }

  function delay(ms: number, signal: AbortSignal | undefined, tabId: number) {
    assertNotAborted(signal, tabId);
    let onAbort: (() => void) | null = null;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          reject(abortedError(tabId));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }).finally(() => signal && onAbort && signal.removeEventListener("abort", onAbort));
  }

  function timestamp() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function assertNotAborted(signal: AbortSignal | undefined, tabId: number) {
    if (signal?.aborted) throw abortedError(tabId);
  }

  function abortedError(tabId: number) {
    return new ToolExecutionError("OPERATION_ABORTED", "Screen action was aborted.", {});
  }

  function createInputDispatchState(context: ToolContext, tabId: number, action: string) {
    const state: InputDispatch = {
      total: 0,
      error: null,
      fail(error, command) {
        if (state.error) return;
        state.error = error;
        recordTrace("action.input.rejected", context, tabId, { action }, {
          command,
          code: record(error).code || "",
          error: errorMessage(error),
        });
      },
    };
    return state;
  }

  function issueInputCommand(state: InputDispatch, label: string, dispatch: () => unknown) {
    const commandLabel = String(label || `command:${state.total + 1}`);
    state.total += 1;
    let command;
    try {
      command = dispatch();
    } catch (error) {
      state.fail(error, commandLabel);
      return;
    }
    Promise.resolve(command).catch(error => state.fail(error, commandLabel));
  }

  function issueBestEffortInput(dispatch: () => unknown) {
    try {
      Promise.resolve(dispatch()).catch(() => {});
    } catch (_error) {}
  }

  function recordTrace(phase: string, context: ToolContext, tabId: number, meta: Fields = {}, fields: Fields = {}) {
    diagnosticTrace(`screen_action_trace${formatTraceFields({
      phase,
      session: context?.sessionId || "",
      run: context?.runId || "",
      call: context?.toolCallId || context?.callId || "",
      tab: Number(tabId) || 0,
      action: meta.action || "",
      capture: meta.capture || "",
      screenshot: meta.screenshot || "",
      ...fields,
    })}`);
  }

  return Object.freeze({
    act,
    capture,
    releaseRun,
    validate,
  });
}

function stateChange(before: Partial<State> = {}, after: Partial<State> = {}, exactViewport = false) {
  if (before.loaderId && after.loaderId && before.loaderId !== after.loaderId) return "page_navigated";
  if (before.url && after.url && before.url !== after.url) return "url_changed";
  const a: Partial<Viewport> = before.viewport || {};
  const b: Partial<Viewport> = after.viewport || {};
  if (viewportResized(a, b, exactViewport ? 0 : VIEWPORT_RESIZE_TOLERANCE_PX)) return "viewport_resized";
  if (Math.abs(finite(a.pageX) - finite(b.pageX)) > (exactViewport ? 0 : 1)
    || Math.abs(finite(a.pageY) - finite(b.pageY)) > (exactViewport ? 0 : 1)) return "viewport_scrolled";
  if (Math.abs(finite(a.scale, 1) - finite(b.scale, 1)) > (exactViewport ? 0 : 0.01)) return "viewport_scaled";
  return "";
}

function viewportResized(before: Partial<Viewport> = {}, after: Partial<Viewport> = {}, tolerance = VIEWPORT_RESIZE_TOLERANCE_PX) {
  return Math.abs(finite(before.width) - finite(after.width)) > tolerance
    || Math.abs(finite(before.height) - finite(after.height)) > tolerance;
}

function coordinateBasisInvalidReason(before: Partial<State> = {}, after: State | null = null) {
  if (!after) return "state_unavailable";
  const change = stateChange(before, after);
  return change === "viewport_scrolled" ? "" : change;
}

function describeViewportChange(before: Partial<State> = {}, after: State | null = null) {
  const a = before?.viewport;
  const b = after?.viewport;
  if (!a || !b) return { observed: false };
  const deltaX = roundedDelta(finite(b.pageX) - finite(a.pageX));
  const deltaY = roundedDelta(finite(b.pageY) - finite(a.pageY));
  const resized = viewportResized(a, b);
  const scaled = Math.abs(finite(b.scale, 1) - finite(a.scale, 1)) > 0.01;
  return {
    observed: true,
    scrolled: Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1,
    deltaX,
    deltaY,
    scaled,
    resized,
  };
}

function roundedDelta(value: unknown) {
  return Math.round(finite(value) * 10) / 10;
}

function compactRuntimeError(error: unknown, fallbackCode: string) {
  return {
    code: String(record(error).code || fallbackCode),
    message: String(errorMessage(error)),
  };
}

function normalizeAction(action: unknown, ToolExecutionError: ToolErrorConstructor) {
  const value = String(action || "").trim().toLowerCase();
  if (ACTIONS.includes(value)) return value;
  throw new ToolExecutionError(
    "UNSUPPORTED_SCREEN_ACTION",
    t("unsupportedActOnScreenAction", { action: String(action) }),
    { action, allowedActions: ACTIONS },
  );
}

function mouseButton(value: unknown, ToolExecutionError: ToolErrorConstructor) {
  const button = String(value || "left").trim().toLowerCase();
  if (["left", "right", "middle"].includes(button)) return button;
  throw new ToolExecutionError(
    "INVALID_ARGUMENTS",
    t("unsupportedMouseButton", { button: String(value) }),
    { field: "button", allowed: ["left", "right", "middle"] },
  );
}

function buttonsMask(button: string | undefined) {
  return button === "right" ? 2 : (button === "middle" ? 4 : 1);
}

function publicPoint(point: Point | null | undefined) {
  return point ? { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 } : null;
}

function publicMarker(marker: Marker | null) {
  if (!marker) return undefined;
  return {
    kind: marker.kind,
    action: marker.action,
    x: marker.x,
    y: marker.y,
    ...(marker.kind === "drag" ? { endX: marker.endX, endY: marker.endY } : {}),
  };
}

function imageActionDisplay(marker: Marker | null, { action = marker?.action || "", beforeImage = "", afterImage = "" } = {}) {
  const sourceImage = inlineImageDataUrl(beforeImage);
  const resultImage = inlineImageDataUrl(afterImage);
  const displayAction = String(action || marker?.action || "").trim();
  if (!marker) {
    if (!displayAction || (!sourceImage && !resultImage)) return {};
    return {
      _display: {
        type: "imageWithAction",
        action: displayAction,
        kind: "frame",
        ...(sourceImage ? { beforeImage: sourceImage } : {}),
        ...(resultImage ? { afterImage: resultImage } : {}),
      },
    };
  }
  return {
    _display: {
      type: "imageWithAction",
      action: displayAction || marker.action,
      kind: marker.kind,
      x: unitRatio(marker.ratioX),
      y: unitRatio(marker.ratioY),
      ...(marker.action === "scroll" ? { direction: marker.direction } : {}),
      ...(sourceImage ? { beforeImage: sourceImage } : {}),
      ...(resultImage ? { afterImage: resultImage } : {}),
      ...(marker.kind === "drag" ? {
        endX: unitRatio(marker.endRatioX),
        endY: unitRatio(marker.endRatioY),
      } : {}),
    },
  };
}

function inlineImageDataUrl(value: unknown) {
  const image = String(value || "");
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(image) ? image : "";
}

function unitRatio(value: unknown) {
  return Math.round(Math.max(0, Math.min(1, finite(value))) * 1_000_000) / 1_000_000;
}

function scrollDirection(deltaX: number, deltaY: number) {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX < 0 ? "left" : "right";
  return deltaY < 0 ? "up" : "down";
}

function imageCoordinateSpace(shot: Partial<Screenshot> = {}, viewport: Partial<Viewport> = {}) {
  return Object.freeze({
    origin: "top_left",
    width: positiveDimension(shot.width || shot.sourceWidth || viewport.width),
    height: positiveDimension(shot.height || shot.sourceHeight || viewport.height),
    unit: "pixel",
  });
}

function positiveDimension(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 1;
}

function requiredReturnScreenshot(value: unknown, ToolExecutionError: ToolErrorConstructor) {
  if (typeof value === "boolean") return value;
  if (value !== undefined) {
    throw new ToolExecutionError(
      "INVALID_ARGUMENTS",
      t("actOnScreenReturnscreenshotMustBeTrueOrFalse"),
      {
        name: "act_on_screen",
        field: "returnScreenshot",
        value,
        expected: { type: "boolean" },
      },
    );
  }
  throw new ToolExecutionError(
    "MISSING_REQUIRED_ARGUMENTS",
    t("actOnScreenRequiresReturnscreenshotToBeExplicitlyTrue"),
    {
      name: "act_on_screen",
      missing: ["returnScreenshot"],
      expected: { returnScreenshot: { type: "boolean" } },
    },
  );
}

function longPressDuration(value: unknown, ToolExecutionError: ToolErrorConstructor) {
  const number = value == null || value === "" ? DEFAULT_LONG_PRESS_MS : Number(value);
  if (!Number.isFinite(number) || number < MIN_LONG_PRESS_MS || number > MAX_LONG_PRESS_MS) {
    throw new ToolExecutionError(
      "INVALID_LONG_PRESS_DURATION",
      t("longPressDurationMustBeBetweenAndMilliseconds", { min: String(MIN_LONG_PRESS_MS), max: String(MAX_LONG_PRESS_MS) }),
      { field: "durationMs", value, min: MIN_LONG_PRESS_MS, max: MAX_LONG_PRESS_MS },
    );
  }
  return Math.round(number);
}

function scrollDelta(value: unknown, ToolExecutionError: ToolErrorConstructor) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ToolExecutionError("INVALID_ARGUMENTS", t("scrollDeltaMustBeAFiniteNumber"), { value });
  }
  return Math.max(-10000, Math.min(10000, number));
}

function scrollRepeat(value: unknown, ToolExecutionError: ToolErrorConstructor) {
  const number = value == null || value === "" ? DEFAULT_SCROLL_REPEAT : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_SCROLL_REPEAT) {
    throw new ToolExecutionError(
      "INVALID_SCROLL_REPEAT",
      t("scrollRepeatMustBeAnIntegerBetween1And", { max: String(MAX_SCROLL_REPEAT) }),
      { field: "repeat", value, min: 1, max: MAX_SCROLL_REPEAT },
    );
  }
  return number;
}

function snapshotId(nowMs: number) {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") || Math.random().toString(36).slice(2, 14);
  return `screen_${Math.floor(nowMs).toString(36)}_${random}`;
}

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

import { isIsolatedContentInvoke, isIsolatedContentProbe } from "../tools/isolated-page-calls.js";
import { createNetworkWatch } from "./network-watch.js";
import type { NetworkChrome } from "./network-watch.js";
import {
  firefoxApplyUserAgent,
  firefoxConsoleBridge,
  firefoxConsoleMain,
  firefoxPageCommand,
} from "./page-command.js";
import type { PageCommand } from "./page-command.js";
import { bytesToBase64, jpegsToPdf } from "./pdf-raster.js";
import { cropDataUrl, decodeDataUrl, stitchTiles, stripDataUrl } from "./screenshot-image.js";
import type { ImageClip } from "./screenshot-image.js";

const MARK = Symbol.for("qz.firefox.debugger");
const COMPAT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PDF_PAGES = 8;
const SCREENSHOT_TILES = 8;

/** Install chrome.debugger before service-worker modules register their listeners. */
export function installFirefoxDebugger(chromeApi: DebuggerChrome & NetworkChrome): void {
  const current = chromeApi.debugger as (DebuggerApi & { [MARK]?: boolean }) | undefined;
  if (current?.[MARK] || typeof current?.sendCommand === "function") return;
  const onEvent = createListeners<(source: DebugSource, method: string, params?: object) => void>();
  const onDetach = createListeners<(source: DebugSource, reason: string) => void>();
  const attached = new Set<number>();
  const runtimeEnabled = new Set<number>();
  const autoAttach = new Set<number>();
  const contexts = new Map<number, ContextRecord[]>();
  const generations = new Map<string, number>();
  const emulation = new Map<number, { userAgent: string; touch: boolean }>();
  const savedWindows = new Map<number, SavedWindow>();
  const announced = new Map<number, Map<string, string>>();
  const streams = new Map<string, { bytes: Uint8Array; offset: number }>();
  let nextContext = 1;
  let nextStream = 1;
  const emit = (tabId: number, method: string, params?: object) => onEvent.dispatch({ tabId }, method, params);
  const network = createNetworkWatch(chromeApi, emit);

  chromeApi.runtime?.onMessage?.addListener((message, sender) => {
    if (!message || message.type !== "qz-firefox-console") return;
    const tabId = Number(sender?.tab?.id);
    if (!runtimeEnabled.has(tabId)) return;
    publishConsole(tabId, message.record, emit);
  });
  chromeApi.webNavigation?.onCommitted?.addListener(details => {
    const tabId = Number(details.tabId);
    const frameId = Number(details.frameId);
    if (!attached.has(tabId)) return;
    bump(generations, tabId, frameId);
    if (runtimeEnabled.has(tabId)) {
      void replaceFrameContext(tabId, frameId, String(details.url || ""));
      void installConsole(tabId).catch(() => {});
    }
    const userAgent = emulation.get(tabId)?.userAgent;
    if (userAgent) void injectUserAgent(tabId, userAgent, frameId).catch(() => {});
    if (autoAttach.has(tabId)) void publishAutoAttach(tabId).catch(() => {});
  });
  chromeApi.tabs?.onRemoved?.addListener(tabId => {
    if (!attached.has(tabId)) return;
    void release(tabId, false);
    onDetach.dispatch({ tabId }, "target_closed");
  });

  const api: DebuggerApi & { [MARK]?: boolean } = {
    onEvent, onDetach,
    async attach(target) { attached.add(tabIdOf(target)); },
    async detach(target) { await release(tabIdOf(target), true); },
    sendCommand(target, method, params) {
      const tabId = tabIdOf(target);
      if (!attached.has(tabId)) return Promise.reject(new Error("Debugger is not attached to the tab"));
      return dispatch(tabId, frameFromSession(tabId, target?.sessionId), method, fields(params));
    },
  };
  api[MARK] = true;
  chromeApi.debugger = api;

  async function dispatch(tabId: number, frameId: number, method: string, params: Fields): Promise<unknown> {
    // Runtime.disable must not drop the hook. It stays until the debugger detaches.
    if (method === "Page.enable" || method === "Page.disable" || method === "Runtime.disable" || method === "Runtime.terminateExecution") return {};
    if (method === "Page.getFrameTree") return frameTree(tabId, frameId);
    if (method === "Page.reload") {
      await chromeApi.tabs?.reload?.(tabId, { bypassCache: params.ignoreCache === true });
      return {};
    }
    if (method === "Page.getLayoutMetrics") return run(tabId, frameId, { op: "layout" });
    if (method === "Page.captureScreenshot") return captureScreenshot(tabId, frameId, params);
    if (method === "Page.printToPDF") return printToPdf(tabId, frameId);
    if (method === "DOM.getFrameOwner") return frameOwner(tabId, String(params.frameId || ""));
    if (method === "DOM.getDocument") return run(tabId, frameId, { op: "document" });
    if (method === "DOM.querySelectorAll") return run(tabId, frameId, { op: "query", nodeId: numberValue(params.nodeId), selector: String(params.selector || "") });
    if (method === "DOM.describeNode") return run(tabId, frameId, { op: "describe", nodeId: numberValue(params.nodeId), backendNodeId: numberValue(params.backendNodeId) });
    if (method === "DOM.pushNodesByBackendIdsToFrontend") return run(tabId, frameId, { op: "push", backendNodeIds: numberList(params.backendNodeIds) });
    if (method === "DOM.getBoxModel") return run(tabId, frameId, { op: "box", backendNodeId: numberValue(params.backendNodeId) });
    if (method === "DOM.resolveNode") return run(tabId, frameId, { op: "resolve", backendNodeId: numberValue(params.backendNodeId), objectGroup: String(params.objectGroup || "") });
    if (method === "Runtime.enable") return enableRuntime(tabId);
    if (method === "Runtime.evaluate") return evaluate(tabId, frameId, params);
    if (method === "Runtime.callFunctionOn") {
      const declaration = String(params.functionDeclaration || "");
      const callArgs = Array.isArray(params.arguments) ? params.arguments as { value?: unknown }[] : [];
      if (isIsolatedContentInvoke(declaration)) {
        const first = callArgs[0];
        const payload = first && typeof first === "object" && "value" in first ? first.value : undefined;
        return run(tabId, frameId, {
          op: "invoke", objectId: String(params.objectId || ""), payload, awaitPromise: params.awaitPromise !== false,
        });
      }
      return run(tabId, frameId, {
        op: "call", objectId: String(params.objectId || ""), functionDeclaration: declaration,
        arguments: callArgs, awaitPromise: params.awaitPromise !== false,
      });
    }
    if (method === "Runtime.releaseObjectGroup") return run(tabId, frameId, { op: "release", objectGroup: String(params.objectGroup || "") });
    if (method === "Runtime.awaitPromise") return { result: { type: "undefined" } };
    if (method === "Input.dispatchMouseEvent") {
      return run(tabId, frameId, { op: "input", input: { kind: "mouse", type: String(params.type || ""), x: numberValue(params.x), y: numberValue(params.y), button: String(params.button || "left"), clickCount: numberValue(params.clickCount) || 1, deltaX: numberValue(params.deltaX), deltaY: numberValue(params.deltaY) } });
    }
    if (method === "Input.dispatchKeyEvent") {
      return run(tabId, frameId, { op: "input", input: { kind: "key", type: String(params.type || ""), key: String(params.key || ""), code: String(params.code || ""), keyCode: numberValue(params.windowsVirtualKeyCode), modifiers: numberValue(params.modifiers), text: String(params.text || ""), commands: stringList(params.commands) } });
    }
    if (method === "Input.dispatchTouchEvent") {
      const point = fields(arrayValue(params.touchPoints)[0]);
      return run(tabId, frameId, { op: "input", input: { kind: "touch", type: String(params.type || ""), x: numberValue(point.x), y: numberValue(point.y) } });
    }
    if (method === "Input.insertText") return run(tabId, frameId, { op: "input", input: { kind: "text", text: String(params.text || "") } });
    if (method === "Emulation.setUserAgentOverride") return setUserAgent(tabId, String(params.userAgent || ""));
    if (method === "Emulation.setDeviceMetricsOverride") return resizeWindow(tabId, numberValue(params.width) || 412, numberValue(params.height) || 915);
    if (method === "Emulation.clearDeviceMetricsOverride") return restoreWindow(tabId);
    if (method === "Emulation.setTouchEmulationEnabled") {
      const state = emulationState(tabId);
      state.touch = params.enabled === true;
      return {};
    }
    if (method === "Accessibility.getFullAXTree") return run(tabId, frameId, { op: "ax", depth: typeof params.depth === "number" ? params.depth : undefined });
    if (method === "Network.enable") { network.enable(tabId); return {}; }
    if (method === "Network.disable") { network.disable(tabId); return {}; }
    if (method === "Network.getResponseBody") return network.body(tabId, String(params.requestId || ""));
    if (method === "Network.loadNetworkResource") return loadNetworkResource(tabId, params);
    if (method === "IO.read") return readStream(params);
    if (method === "IO.close") return closeStream(params);
    if (method === "Target.setAutoAttach") { autoAttach.add(tabId); await publishAutoAttach(tabId); return {}; }
    throw new Error(`${method} is not available in Firefox`);
  }

  async function release(tabId: number, restore: boolean) {
    attached.delete(tabId);
    runtimeEnabled.delete(tabId);
    autoAttach.delete(tabId);
    contexts.delete(tabId);
    announced.delete(tabId);
    network.disable(tabId);
    for (const handle of streams.keys()) if (handle.startsWith(`ff-io-${tabId}-`)) streams.delete(handle);
    if (restore) await restoreWindow(tabId).catch(() => {});
    emulation.delete(tabId);
  }

  async function frameTree(tabId: number, frameId: number) {
    const all = await readFrames(tabId);
    if (frameId > 0) {
      const frame = all.find(item => item.frameId === frameId) || { frameId, parentFrameId: -1, url: "" };
      const children = all.filter(item => item.parentFrameId === frame.frameId && sameOrigin(frame.url, item.url));
      return { frameTree: { frame: frameRecord(tabId, frame), childFrames: children.map(item => ({ frame: frameRecord(tabId, item) })) } };
    }
    const main = all.find(item => item.frameId === 0) || all[0] || { frameId: 0, parentFrameId: -1, url: "" };
    const children = all.filter(item => item.frameId !== main.frameId && item.parentFrameId === main.frameId && sameOrigin(main.url, item.url));
    return { frameTree: { frame: frameRecord(tabId, main), childFrames: children.map(item => ({ frame: frameRecord(tabId, item) })) } };
  }

  function frameRecord(tabId: number, frame: FrameInfo) {
    return {
      id: frame.frameId === 0 ? "0" : String(frame.frameId),
      loaderId: `ff-${tabId}-${frame.frameId}-${generations.get(`${tabId}:${frame.frameId}`) || 0}`,
      url: frame.url,
      mimeType: "text/html",
      securityOrigin: originOf(frame.url),
    };
  }

  async function readFrames(tabId: number): Promise<FrameInfo[]> {
    const listed = await chromeApi.webNavigation?.getAllFrames?.({ tabId });
    if (listed?.length) return listed.map(frame => ({ frameId: Number(frame.frameId), parentFrameId: Number(frame.parentFrameId), url: String(frame.url || "") }));
    const tab = await chromeApi.tabs?.get?.(tabId);
    return [{ frameId: 0, parentFrameId: -1, url: String(tab?.url || "") }];
  }

  async function frameOwner(tabId: number, frameId: string) {
    const numeric = frameId === "0" ? 0 : Number(frameId);
    if (!Number.isInteger(numeric) || numeric <= 0) return { backendNodeId: 0 };
    const all = await readFrames(tabId);
    const frame = all.find(item => item.frameId === numeric);
    if (!frame || frame.parentFrameId < 0) return { backendNodeId: 0 };
    const owners = fields(await run(tabId, frame.parentFrameId, { op: "owners" }));
    const listed = arrayValue(owners.frames).map(fields);
    const siblings = all.filter(item => item.parentFrameId === frame.parentFrameId).sort((left, right) => left.frameId - right.frameId);
    const index = siblings.findIndex(item => item.frameId === frame.frameId);
    const at = index >= 0 ? listed[index] : undefined;
    const match = listed.find(item => item.childUrl && item.childUrl === frame.url)
      || preferOwner(listed.filter(item => item.url && frame.url === item.url), at)
      || preferOwner(listed.filter(item => item.url && frame.url && frame.url.startsWith(String(item.url)) && frame.url !== item.url), at)
      || at;
    return { backendNodeId: numberValue(match?.backendNodeId) };
  }

  async function publishAutoAttach(tabId: number) {
    const all = await readFrames(tabId);
    const main = all.find(item => item.frameId === 0);
    const next = new Map<string, string>();
    if (main) {
      for (const frame of all) {
        if (frame.frameId === main.frameId) continue;
        if (sameOrigin(main.url, frame.url)) continue;
        const sessionId = `ff-${tabId}-${frame.frameId}`;
        const targetId = `ff-target-${tabId}-${frame.frameId}`;
        next.set(sessionId, targetId);
        if (announced.get(tabId)?.has(sessionId)) continue;
        emit(tabId, "Target.attachedToTarget", {
          sessionId, waitingForDebugger: false,
          targetInfo: { type: "iframe", targetId, url: frame.url, parentFrameId: "0" },
        });
      }
    }
    for (const [sessionId, targetId] of announced.get(tabId) || []) {
      if (!next.has(sessionId)) emit(tabId, "Target.detachedFromTarget", { sessionId, targetId });
    }
    if (next.size) announced.set(tabId, next);
    else announced.delete(tabId);
  }

  async function enableRuntime(tabId: number) {
    if (runtimeEnabled.has(tabId)) return {};
    runtimeEnabled.add(tabId);
    const created: ContextRecord[] = [];
    for (const frame of await readFrames(tabId)) created.push(...createContexts(tabId, frame.frameId, frame.url));
    contexts.set(tabId, created);
    await installConsole(tabId).catch(() => {});
    return {};
  }

  async function replaceFrameContext(tabId: number, frameId: number, url: string) {
    const current = contexts.get(tabId) || [];
    for (const context of current) {
      if (context.frameId === frameId) emit(tabId, "Runtime.executionContextDestroyed", { executionContextId: context.id });
    }
    contexts.set(tabId, [...current.filter(context => context.frameId !== frameId), ...createContexts(tabId, frameId, url)]);
  }

  function createContexts(tabId: number, frameId: number, url: string): ContextRecord[] {
    const created: ContextRecord[] = [];
    for (const world of ["MAIN", "ISOLATED"] as const) {
      const id = nextContext;
      nextContext += 1;
      const uniqueId = `ff-${tabId}-${frameId}-${world}-${generations.get(`${tabId}:${frameId}`) || 0}`;
      created.push({ id, uniqueId, frameId, world });
      emit(tabId, "Runtime.executionContextCreated", {
        context: {
          id, uniqueId, name: "",
          origin: world === "ISOLATED" ? `chrome-extension://${chromeApi.runtime?.id || ""}` : originOf(url),
          auxData: { type: world === "ISOLATED" ? "isolated" : "default", frameId: frameId === 0 ? "0" : String(frameId), isDefault: world === "MAIN" },
        },
      });
    }
    return created;
  }

  async function evaluate(tabId: number, frameId: number, params: Fields) {
    if (String(params.expression || "").trim() === "navigator.userAgent") {
      return { result: { type: "string", value: emulation.get(tabId)?.userAgent || COMPAT_USER_AGENT } };
    }
    const selected = (contexts.get(tabId) || []).find(context => context.id === numberValue(params.contextId) || (params.uniqueContextId && context.uniqueId === params.uniqueContextId));
    if ((params.contextId || params.uniqueContextId) && !selected) throw new Error("Cannot find context");
    const world = selected?.world || "MAIN";
    const expression = String(params.expression || "");
    const targetFrame = selected?.frameId ?? frameId;
    if (isIsolatedContentProbe(expression)) return run(tabId, targetFrame, { op: "probe" }, world);
    return run(tabId, targetFrame, { op: "evaluate", expression, awaitPromise: params.awaitPromise === true }, world);
  }

  async function setUserAgent(tabId: number, userAgent: string) {
    emulationState(tabId).userAgent = userAgent;
    await injectUserAgent(tabId, userAgent).catch(() => {});
    return {};
  }

  async function resizeWindow(tabId: number, width: number, height: number) {
    const tab = await chromeApi.tabs?.get?.(tabId);
    const windowId = Number(tab?.windowId);
    if (!Number.isInteger(windowId) || windowId < 0 || !chromeApi.windows?.get || !chromeApi.windows.update) return {};
    const win = await chromeApi.windows.get(windowId);
    if (!savedWindows.has(windowId)) savedWindows.set(windowId, { ownerTabId: tabId, width: win.width, height: win.height, state: win.state, left: win.left, top: win.top });
    let frameWidth = 0;
    let frameHeight = 0;
    try {
      const layout = fields(fields(await run(tabId, 0, { op: "layout" })).cssVisualViewport);
      const innerWidth = numberValue(layout.clientWidth);
      const innerHeight = numberValue(layout.clientHeight);
      if (innerWidth > 0 && win.width) frameWidth = Math.max(0, win.width - innerWidth);
      if (innerHeight > 0 && win.height) frameHeight = Math.max(0, win.height - innerHeight);
    } catch { /* The requested size becomes the outer size. */ }
    await chromeApi.windows.update(windowId, {
      state: "normal",
      width: Math.max(100, Math.round(width + frameWidth)),
      height: Math.max(100, Math.round(height + frameHeight)),
    });
    return {};
  }

  async function restoreWindow(tabId: number) {
    const state = emulation.get(tabId);
    if (state) state.userAgent = "";
    await injectUserAgent(tabId, "").catch(() => {});
    for (const [windowId, saved] of savedWindows) {
      if (saved.ownerTabId !== tabId) continue;
      savedWindows.delete(windowId);
      await chromeApi.windows?.update?.(windowId, { state: saved.state || "normal", width: saved.width, height: saved.height, left: saved.left, top: saved.top });
    }
    return {};
  }

  function emulationState(tabId: number) {
    const current = emulation.get(tabId);
    if (current) return current;
    const created = { userAgent: "", touch: false };
    emulation.set(tabId, created);
    return created;
  }

  async function injectUserAgent(tabId: number, userAgent: string, frameId?: number) {
    const target = frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
    await execute(target, "MAIN", firefoxApplyUserAgent, [userAgent]);
  }

  async function installConsole(tabId: number) {
    const target = { tabId, allFrames: true };
    await execute(target, "MAIN", firefoxConsoleMain, []);
    await execute(target, "ISOLATED", firefoxConsoleBridge, []);
  }

  async function captureScreenshot(tabId: number, frameId: number, params: Fields) {
    const format = params.format === "png" ? "png" : "jpeg";
    const quality = numberValue(params.quality) || 70;
    const clip = fields(params.clip);
    const hasClip = numberValue(clip.width) > 0 && numberValue(clip.height) > 0;
    if (!hasClip) return { data: stripDataUrl(await captureTabImage(tabId, format, quality)) };
    const layout = fields(fields(await run(tabId, frameId, { op: "layout" })).cssVisualViewport);
    const cssWidth = numberValue(layout.clientWidth);
    const cssHeight = numberValue(layout.clientHeight);
    const view: ImageClip = { x: numberValue(clip.x), y: numberValue(clip.y), width: numberValue(clip.width), height: numberValue(clip.height), scale: numberValue(clip.scale) || 1 };
    const outside = params.captureBeyondViewport === true && (view.x < 0 || view.y < 0 || view.x + view.width > cssWidth || view.y + view.height > cssHeight);
    if (!outside) return { data: await cropDataUrl(await captureTabImage(tabId, format, quality), view, cssWidth, cssHeight, format) };
    const pageX = numberValue(layout.pageX);
    const pageY = numberValue(layout.pageY);
    if (params.captureBeyondViewport === true) {
      try {
        const shot = await captureTabImage(tabId, format, quality, {
          x: Math.max(0, pageX + view.x),
          y: Math.max(0, pageY + view.y),
          width: view.width,
          height: view.height,
        }, view.scale || 1);
        return { data: stripDataUrl(shot) };
      } catch { /* The document rect is too large for one capture. Stitch viewport pieces. */ }
    }
    const viewW = cssWidth > 0 ? cssWidth : view.width;
    const viewH = cssHeight > 0 ? cssHeight : view.height;
    const clipLeft = pageX + view.x;
    const clipTop = pageY + view.y;
    const rows: string[][] = [];
    let coveredY = 0;
    let coveredX = 0;
    let tiles = 0;
    while (coveredY < view.height && tiles < SCREENSHOT_TILES) {
      const row: string[] = [];
      coveredX = 0;
      let rowAdvance = 0;
      while (coveredX < view.width && tiles < SCREENSHOT_TILES) {
        const docX = clipLeft + coveredX;
        const docY = clipTop + coveredY;
        const scrolled = fields(await run(tabId, frameId, { op: "scroll", x: docX, y: docY }));
        const scrollX = numberValue(scrolled.scrollX);
        const scrollY = numberValue(scrolled.scrollY);
        const left = Math.max(docX, scrollX);
        const top = Math.max(docY, scrollY);
        const right = Math.min(scrollX + viewW, clipLeft + view.width);
        const bottom = Math.min(scrollY + viewH, clipTop + view.height);
        const advanceX = right - clipLeft - coveredX;
        const advanceY = bottom - clipTop - coveredY;
        if (advanceX <= 0 || advanceY <= 0) break;
        row.push(await cropDataUrl(
          await captureTabImage(tabId, format, quality),
          { x: left - scrollX, y: top - scrollY, width: right - left, height: bottom - top, scale: 1 },
          cssWidth, cssHeight, format,
        ));
        coveredX += advanceX;
        if (rowAdvance === 0 || advanceY < rowAdvance) rowAdvance = advanceY;
        tiles += 1;
      }
      if (!row.length || rowAdvance <= 0) break;
      rows.push(row);
      coveredY += rowAdvance;
    }
    await run(tabId, frameId, { op: "scroll", x: pageX, y: pageY }).catch(() => {});
    if (tiles >= SCREENSHOT_TILES && (coveredY + 0.5 < view.height || coveredX < view.width)) {
      console.warn(`[轻舟] firefox screenshot kept ${tiles} viewport pieces; the rest of the clip was omitted`);
    }
    return { data: await stitchTiles(rows, view.scale, format) };
  }

  async function printToPdf(tabId: number, frameId: number) {
    const layout = fields(await run(tabId, frameId, { op: "layout" }));
    const visual = fields(layout.cssVisualViewport);
    const content = fields(layout.cssContentSize);
    const pageX = numberValue(visual.pageX);
    const pageY = numberValue(visual.pageY);
    const height = Math.max(1, numberValue(visual.clientHeight) || 800);
    const total = Math.max(height, numberValue(content.height));
    const contentWidth = Math.max(1, numberValue(content.width) || numberValue(visual.clientWidth) || 800);
    try {
      const image = decodeDataUrl(await captureTabImage(tabId, "jpeg", 60, { x: 0, y: 0, width: contentWidth, height: total }, 1));
      return { data: bytesToBase64(jpegsToPdf([image])) };
    } catch { /* A full-document capture can exceed the canvas limit. Slice the viewport. */ }
    const images: Uint8Array[] = [];
    const pageCount = Math.ceil(total / height);
    for (let y = 0; y < total && images.length < PDF_PAGES; y += height) {
      await run(tabId, frameId, { op: "scroll", x: 0, y });
      images.push(decodeDataUrl(await captureTabImage(tabId, "jpeg", 60)));
    }
    await run(tabId, frameId, { op: "scroll", x: pageX, y: pageY }).catch(() => {});
    const truncated = pageCount > images.length;
    if (truncated) console.warn(`[轻舟] firefox pdf kept ${images.length} of ${pageCount} viewport pages; content below that was omitted`);
    const note = truncated ? `Firefox kept ${images.length} of ${pageCount} viewport pages. Content below that was omitted.` : "";
    return { data: bytesToBase64(jpegsToPdf(images, note)) };
  }

  async function captureTabImage(tabId: number, format: string, quality: number, rect?: CaptureRect, scale?: number): Promise<string> {
    const options: CaptureOptions = { format, quality };
    if (rect) {
      options.rect = rect;
      if (scale && scale > 0) options.scale = scale;
    }
    if (chromeApi.tabs?.captureTab) {
      try { return await chromeApi.tabs.captureTab(tabId, options); }
      catch (error) {
        if (rect) throw error;
      }
    } else if (rect) throw new Error("Firefox cannot capture this document area");
    const tab = await chromeApi.tabs?.get?.(tabId);
    await chromeApi.tabs?.update?.(tabId, { active: true });
    if (tab?.windowId != null) await chromeApi.windows?.update?.(tab.windowId, { focused: true });
    if (!chromeApi.tabs?.captureVisibleTab) throw new Error("Firefox cannot capture this tab");
    return chromeApi.tabs.captureVisibleTab(tab?.windowId, options);
  }

  async function loadNetworkResource(tabId: number, params: Fields) {
    const url = String(params.url || "");
    const options = fields(params.options);
    if (!/^https?:\/\//i.test(url)) {
      return { resource: { success: false, netError: -1, netErrorName: "ERR_INVALID_URL", httpStatusCode: 0, headers: [] } };
    }
    if (typeof fetch !== "function") {
      return { resource: { success: false, netError: -1, netErrorName: "ERR_FAILED", httpStatusCode: 0, headers: [] } };
    }
    try {
      const response = await fetch(url, {
        credentials: options.includeCredentials === false ? "omit" : "include",
        cache: options.disableCache === true ? "reload" : "default",
        redirect: "follow",
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const handle = `ff-io-${tabId}-${nextStream}`;
      nextStream += 1;
      streams.set(handle, { bytes, offset: 0 });
      const headers: { name: string; value: string }[] = [];
      response.headers?.forEach?.((value, name) => headers.push({ name, value }));
      return { resource: { success: true, httpStatusCode: response.status, stream: handle, headers } };
    } catch {
      return { resource: { success: false, netError: -1, netErrorName: "ERR_FAILED", httpStatusCode: 0, headers: [] } };
    }
  }

  function readStream(params: Fields) {
    const stream = streams.get(String(params.handle || ""));
    if (!stream) throw new Error("IO.read stream is closed");
    const requested = numberValue(params.size);
    const size = requested > 0 ? requested : stream.bytes.length - stream.offset;
    const end = Math.min(stream.bytes.length, stream.offset + Math.max(0, size));
    const slice = stream.bytes.subarray(stream.offset, end);
    stream.offset = end;
    return { data: bytesToBase64(slice), base64Encoded: true, eof: stream.offset >= stream.bytes.length };
  }

  function closeStream(params: Fields) {
    streams.delete(String(params.handle || ""));
    return {};
  }

  async function run(tabId: number, frameId: number, command: PageCommand, world: ScriptWorld = "ISOLATED") {
    const [result] = await execute({ tabId, frameIds: [frameId] }, world, firefoxPageCommand, [command, world]);
    return result;
  }

  async function execute<Args extends unknown[]>(target: ScriptTarget, world: ScriptWorld, func: (...args: Args) => unknown, args: Args): Promise<unknown[]> {
    const scripting = chromeApi.scripting;
    if (!scripting?.executeScript) throw new Error("scripting.executeScript is unavailable");
    let results: ScriptResult[];
    try {
      results = await scripting.executeScript({ target, world, injectImmediately: true, args, func });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/world|MAIN|ISOLATED/i.test(message)) throw error;
      results = await scripting.executeScript({ target, injectImmediately: true, args, func });
    }
    const failed = results.find(item => item?.error);
    if (failed) throw new Error(typeof failed.error === "string" ? failed.error : "Firefox page command failed");
    return results.map(item => item?.result);
  }
}

function publishConsole(tabId: number, recordValue: ConsoleMessage | undefined, emit: (tabId: number, method: string, params?: object) => void) {
  if (!recordValue) return;
  const timestamp = Date.now();
  const stack = stackFrame(recordValue.stack);
  if (recordValue.kind === "exception") {
    emit(tabId, "Runtime.exceptionThrown", {
      timestamp,
      exceptionDetails: {
        text: String(recordValue.text || "error"),
        url: String(recordValue.url || stack.url || ""),
        lineNumber: Number(recordValue.line || stack.lineNumber || 0),
        columnNumber: Number(recordValue.column || stack.columnNumber || 0),
        exception: { type: "object", description: String(recordValue.text || "error") },
        stackTrace: { callFrames: stack.url || stack.functionName ? [stack] : [] },
      },
    });
    return;
  }
  emit(tabId, "Runtime.consoleAPICalled", {
    type: recordValue.type || "log",
    timestamp,
    args: (recordValue.args || []).map(value => ({ type: "string", value })),
    stackTrace: { callFrames: stack.url || stack.functionName ? [stack] : [] },
  });
}

function stackFrame(stack: unknown) {
  const line = String(stack || "").split("\n").map(item => item.trim()).find(item => item && !item.includes("data-qz-console"));
  const firefox = /^(.*)@(.*):(\d+):(\d+)$/.exec(line || "");
  if (firefox) return { functionName: firefox[1], url: firefox[2], lineNumber: Number(firefox[3]) - 1, columnNumber: Number(firefox[4]) - 1 };
  const chrome = /at (.*?) \((.*?):(\d+):(\d+)\)/.exec(line || "");
  if (chrome) return { functionName: chrome[1], url: chrome[2], lineNumber: Number(chrome[3]) - 1, columnNumber: Number(chrome[4]) - 1 };
  return { functionName: line || "", url: "", lineNumber: 0, columnNumber: 0 };
}

function preferOwner(matches: Fields[], at: Fields | undefined): Fields | undefined {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return at && matches.includes(at) ? at : matches[0];
  return undefined;
}

function sameOrigin(parentUrl: string, url: string): boolean {
  if (!url || url === "about:blank") return true;
  try {
    const child = new URL(url);
    if (child.protocol === "about:" || child.protocol === "javascript:") return true;
    if (child.origin === "null") return false;
    return child.origin === new URL(parentUrl).origin;
  } catch { return false; }
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

function frameFromSession(tabId: number, sessionId: unknown): number {
  const value = String(sessionId || "");
  if (!value) return 0;
  const prefix = `ff-${tabId}-`;
  if (!value.startsWith(prefix)) throw new Error("Debugger session is not attached");
  const frameId = Number(value.slice(prefix.length));
  if (!Number.isInteger(frameId) || frameId < 0) throw new Error("Debugger session is not attached");
  return frameId;
}

function tabIdOf(target: { tabId?: number } | undefined): number {
  const tabId = Number(target?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Debugger target is missing a tab");
  return tabId;
}

function bump(generations: Map<string, number>, tabId: number, frameId: number) {
  const key = `${tabId}:${frameId}`;
  generations.set(key, (generations.get(key) || 0) + 1);
}

function createListeners<T extends (...args: never[]) => void>() {
  const items: T[] = [];
  return {
    addListener(listener: T) { items.push(listener); },
    removeListener(listener: T) {
      const index = items.indexOf(listener);
      if (index >= 0) items.splice(index, 1);
    },
    hasListener(listener: T) { return items.includes(listener); },
    dispatch(...args: Parameters<T>) { for (const listener of [...items]) listener(...args); },
  };
}

function fields(value: unknown): Fields {
  return value && typeof value === "object" ? value as Fields : {};
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function numberValue(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function numberList(value: unknown): number[] { return arrayValue(value).map(numberValue); }
function stringList(value: unknown): string[] { return arrayValue(value).map(item => String(item)); }

interface Fields { [key: string]: unknown }
interface CaptureRect { x: number; y: number; width: number; height: number }
interface CaptureOptions { format?: string; quality?: number; rect?: CaptureRect; scale?: number }
interface DebugSource { tabId?: number; sessionId?: string }
interface FrameInfo { frameId: number; parentFrameId: number; url: string }
interface ContextRecord { id: number; uniqueId: string; frameId: number; world: ScriptWorld }
interface SavedWindow { ownerTabId: number; width?: number; height?: number; state?: string; left?: number; top?: number }
interface ConsoleMessage { kind?: string; type?: string; text?: string; args?: string[]; stack?: string; url?: string; line?: number; column?: number }
type ScriptWorld = "MAIN" | "ISOLATED";
interface ScriptTarget { tabId: number; frameIds?: number[]; allFrames?: boolean }
interface ScriptResult { result?: unknown; error?: unknown }
interface DebuggerApi {
  onEvent: ReturnType<typeof createListeners<(source: DebugSource, method: string, params?: object) => void>>;
  onDetach: ReturnType<typeof createListeners<(source: DebugSource, reason: string) => void>>;
  attach(target: DebugSource, version: string): Promise<void>;
  detach(target: DebugSource): Promise<void>;
  sendCommand(target: DebugSource, method: string, params?: object): Promise<unknown>;
}
interface DebuggerChrome {
  debugger?: DebuggerApi;
  runtime?: { id?: string; onMessage?: { addListener(listener: (message: { type?: string; record?: ConsoleMessage } | undefined, sender: { tab?: { id?: number } } | undefined) => void): void } };
  tabs?: {
    get?(tabId: number): Promise<{ windowId?: number; url?: string } | undefined>;
    reload?(tabId: number, options?: { bypassCache?: boolean }): Promise<void>;
    update?(tabId: number, options: { active?: boolean }): Promise<unknown>;
    captureTab?(tabId: number, options: CaptureOptions): Promise<string>;
    captureVisibleTab?(windowId: number | undefined, options: { format?: string; quality?: number }): Promise<string>;
    onRemoved?: { addListener(listener: (tabId: number) => void): void };
  };
  windows?: {
    get?(windowId: number): Promise<{ width?: number; height?: number; state?: string; left?: number; top?: number }>;
    update?(windowId: number, options: { state?: string; width?: number; height?: number; left?: number; top?: number; focused?: boolean }): Promise<unknown>;
  };
  webNavigation?: {
    getAllFrames?(query: { tabId: number }): Promise<{ frameId: number; parentFrameId: number; url?: string }[] | undefined>;
    onCommitted?: { addListener(listener: (details: { tabId: number; frameId: number; url?: string }) => void): void };
  };
  scripting?: { executeScript(injection: { target: ScriptTarget; world?: ScriptWorld; injectImmediately?: boolean; args?: unknown[]; func: (...args: never[]) => unknown }): Promise<ScriptResult[]> };
}

import { createScreenActionRuntime } from "../../src/capabilities/media/screen-action-runtime.js";
import { getToolResultPresentation } from "../../src/shared/contracts/tool-result-presentation.js";

const TAB_ID = 1;

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export async function createScreenActionHarness(page, browserContext, scope, { mobile = false } = {}) {
  const cdp = await browserContext.newCDPSession(page);
  if (mobile) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {width: 412, height: 915, mobile: true, deviceScaleFactor: 1});
    await cdp.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
  }
  const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
  const toolContext = {
    sessionId: `screen-${scope}`,
    runId: `run-${scope}`,
    runProfile: { platform: { os } },
  };
  let latestCoordinateSpace = null;
  let cssSize;
  let screenshotCount = 0;
  const runtime = createScreenActionRuntime({
    getPageContext: () => ({ pageMode: mobile ? "mobile" : "desktop" }),
    ToolExecutionError,
    async captureTabScreenshot(_tabId, options = {}) {
      screenshotCount += 1;
      const measured = await cdp.send("Runtime.evaluate", {
        expression: `({cssWidth: ${mobile ? "outerWidth" : "innerWidth"} / visualViewport.scale, cssHeight: ${mobile ? "outerHeight" : "innerHeight"} / visualViewport.scale})`,
        returnByValue: true,
      });
      cssSize = measured.result.value;
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: Number(options.quality) || 82,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const dataUrl = `data:image/jpeg;base64,${data}`;
      // Decode dimensions from the JPEG header in the test process. Asking the
      // page to decode its own screenshot can stall behind browser-owned UI
      // such as an open native select popup, which would make the harness test
      // a Playwright artifact instead of the screen-action runtime.
      const dimensions = jpegDimensions(data);
      return {
        ...cssSize,
        dataUrl,
        width: dimensions.width,
        height: dimensions.height,
        method: "cdp_test",
      };
    },
    async getTabPageState(tabId) {
      return { tabId, url: page.url(), title: await page.title() };
    },
    pageStateDelta(before, after) {
      return {
        urlChanged: before.url !== after.url,
        titleChanged: before.title !== after.title,
      };
    },
    commitObservedPageNavigation({ pageBefore, pageAfter }) {
      return pageBefore.url !== pageAfter.url ? { url: pageAfter.url } : null;
    },
    async getSecurityGuardrails() { return {}; },
    async sendCdp(_tabId, method, params = {}) { return await cdp.send(method, params); },
    async withDebugger(_tabId, callback) {
      return await callback({}, (method, params = {}) => cdp.send(method, params));
    },
  });

  return Object.freeze({
    presentation: getToolResultPresentation,
    primaryModifier: os === "mac" ? "Meta" : "Control",
    get coordinateSpace() { return latestCoordinateSpace; },
    get screenshotCount() { return screenshotCount; },
    async capture() {
      const result = await runtime.capture(TAB_ID, { format: "jpeg", quality: 82 }, toolContext);
      latestCoordinateSpace = result.coordinateSpace;
      return result;
    },
    async act(args, signal, context = {}) {
      const result = await runtime.act({ tabId: TAB_ID, ...args }, signal, { ...toolContext, ...context });
      if (result.coordinateBasisReady && result.coordinateSpace) latestCoordinateSpace = result.coordinateSpace;
      return result;
    },
    async command(method, params = {}) {
      return await cdp.send(method, params);
    },
    async point(selectorOrLocator, position = {}) {
      const locator = typeof selectorOrLocator === "string"
        ? page.locator(selectorOrLocator)
        : selectorOrLocator;
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${String(selectorOrLocator)} should be visible`);
      return await imagePoint({
        x: box.x + box.width * finiteRatio(position.x, 0.5),
        y: box.y + box.height * finiteRatio(position.y, 0.5),
      });
    },
    async imagePoint(cssPoint) {
      return await imagePoint(cssPoint);
    },
    async state(reader = "__readScreenActionState") {
      return await page.evaluate(name => window[name]?.(), reader);
    },
    async close() {
      runtime.releaseRun(toolContext.sessionId, toolContext.runId);
      await cdp.detach();
    },
  });

  async function imagePoint(cssPoint) {
    if (!latestCoordinateSpace) throw new Error("capture() must establish a coordinate space before resolving points");
    return {
      x: rounded(Number(cssPoint.x) / cssSize.cssWidth * latestCoordinateSpace.width),
      y: rounded(Number(cssPoint.y) / cssSize.cssHeight * latestCoordinateSpace.height),
    };
  }
}

function finiteRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

function jpegDimensions(base64) {
  const bytes = Buffer.from(String(base64 || ""), "base64");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Page.captureScreenshot did not return a JPEG image");
  }
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  throw new Error("Could not read screenshot dimensions from JPEG header");
}

function isJpegStartOfFrame(marker) {
  return marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

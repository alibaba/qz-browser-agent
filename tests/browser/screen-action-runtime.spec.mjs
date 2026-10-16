import { expect, test } from "./fixtures.mjs";
import { createScreenActionHarness } from "./screen-action-harness.mjs";

// Preserve the established browser for native keyboard input.
test.use({ channel: process.env.QINGZHOU_PLAYWRIGHT_CHANNEL || "chromium-headless-shell" });

const FIXTURE_URL = "/tests/fixtures/screen-action-runtime.html";

test.describe("act_on_screen · real Chrome behavior", () => {
  for (const mobile of [false, true]) test(`scrolls without an input screenshot (${mobile ? "mobile" : "desktop"})`, async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    await page.evaluate(() => { document.body.innerHTML = '<div style="height:4000px">Scroll fixture</div>'; });
    const harness = await createScreenActionHarness(page, context, `independent-scroll-${mobile}`, { mobile });
    try {
      expect(harness.screenshotCount).toBe(0);
      const silent = await harness.act({ action: "scroll", deltaY: 240, returnScreenshot: false }, undefined, { source: "run_script" });
      expect(silent.status).toBe("completed");
      expect(silent.sourceScreenshotId).toBeUndefined();
      expect(silent._image).toBeUndefined();
      expect(harness.screenshotCount).toBe(0);
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(240);
      const observed = await harness.act({ action: "scroll", deltaY: 180, returnScreenshot: true });
      expect(observed.status).toBe("completed");
      expect(observed.sourceScreenshotId).toBeUndefined();
      expect(observed.feedbackAvailable).toBe(true);
      expect(observed.coordinateBasisReady).toBe(true);
      expect(observed._image).toMatch(/^data:image\/jpeg;base64,/);
      expect(observed._display).toMatchObject({ action: "scroll", x: 0.5, y: 0.5, direction: "down" });
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(420);
    } finally {
      await harness.close();
    }
  });

  test("presses the current focus without an actionable input screenshot", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "screenshot-independent-press");

    try {
      await page.locator("#key-target").focus();
      expect(harness.screenshotCount).toBe(0);
      const pressed = await harness.act({ action: "press", returnScreenshot: true, key: "Enter" });
      expect(pressed.status).toBe("completed");
      expect(pressed.sourceScreenshotId).toBeUndefined();
      expect(pressed.sourceCoordinateSpace).toBeUndefined();
      expect(pressed.feedbackAvailable).toBe(true);
      expect(pressed.coordinateBasisReady).toBe(true);
      expect(pressed._image).toMatch(/^data:image\/jpeg;base64,/);
      expect((await harness.state()).keyEvents.at(-1)?.key).toBe("Enter");
    } finally {
      await harness.close();
    }
  });

  test("executes every action in one predictable stable-coordinate sequence", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "complete-sequence");

    try {
      const initial = await harness.capture();
      expect(initial.shot.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      expect(initial.coordinateSpace.width).toBeGreaterThan(500);
      expect(initial.coordinateSpace.height).toBeGreaterThan(500);

      const stableAction = async (action, args = {}, returnScreenshot = false) => {
        const capturesBefore = harness.screenshotCount;
        const result = await harness.act({ action, returnScreenshot, ...args });
        expect(result.status).toBe("completed");
        expect(result.action).toBe(action);
        expect(result.viewportChange).toEqual({
          observed: true,
          scrolled: false,
          deltaX: 0,
          deltaY: 0,
          scaled: false,
          resized: false,
        });
        expect(harness.screenshotCount - capturesBefore).toBe(2);
        expect(result.feedbackAvailable).toBe(returnScreenshot);
        expect(result.coordinateBasisReady).toBe(true);
        expect(result._display?.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
        expect(result._display?.afterImage).toMatch(/^data:image\/jpeg;base64,/);
        if (!returnScreenshot) expect(result._image).toBeUndefined();
        return result;
      };

      const clickPoint = await harness.point("#click-target");
      const clicked = await stableAction("click", clickPoint);
      expect(clicked.marker).toEqual({ kind: "point", action: "click", ...clickPoint });
      expect((await harness.state()).clickCount).toBe(1);

      const doubleClickPoint = await harness.point("#double-click-target");
      await stableAction("double_click", doubleClickPoint);
      const doubleClickState = await harness.state();
      expect(doubleClickState.doubleClickClicks).toBe(2);
      expect(doubleClickState.doubleClickCount).toBe(1);

      const hoverPoint = await harness.point("#hover-target");
      await stableAction("hover", hoverPoint);
      const hoverState = await harness.state();
      expect(hoverState.hoverEnterCount).toBeGreaterThanOrEqual(1);
      expect(hoverState.hoverMoveCount).toBeGreaterThanOrEqual(1);

      const longPressPoint = await harness.point("#long-press-target");
      const held = await stableAction("long_press", { ...longPressPoint, durationMs: 320 });
      const heldState = await harness.state();
      expect(held.durationMs).toBe(320);
      expect(heldState.longPressActive).toBe(false);
      expect(heldState.longPressMs).toBeGreaterThanOrEqual(280);
      expect(heldState.longPressMs).toBeLessThan(1500);

      const inputPoint = await harness.point("#text-target");
      await stableAction("type", {
        ...inputPoint,
        text: "第一轮输入",
        replace: true,
      });
      let inputState = await harness.state();
      expect(inputState.activeElementId).toBe("text-target");
      expect(inputState.inputValue).toBe("第一轮输入");

      await stableAction("press", { key: `${harness.primaryModifier}+A` });
      inputState = await harness.state();
      expect(inputState.selectionStart).toBe(0);
      expect(inputState.selectionEnd).toBe(inputState.inputValue.length);

      await stableAction("type", { text: "第二轮输入", replace: false });
      expect((await harness.state()).inputValue).toBe("第二轮输入");

      await stableAction("press", { key: "Enter" });
      expect((await harness.state()).keyEvents.at(-1)?.key).toBe("Enter");

      await stableAction("type", { text: "", replace: true });
      expect((await harness.state()).inputValue).toBe("");
      await stableAction("type", { text: "最终输入", replace: false });
      expect((await harness.state()).inputValue).toBe("最终输入");

      const wheelPoint = await harness.point("#wheel-target");
      const wheel = await stableAction("scroll", {
        ...wheelPoint,
        deltaX: 15,
        deltaY: 120,
        repeat: 3,
      });
      const wheelState = await harness.state();
      expect(wheel.repeat).toBe(3);
      expect(wheelState.wheelEvents).toBe(3);
      expect(wheelState.wheelDeltaX).toBe(45);
      expect(wheelState.wheelDeltaY).toBe(360);
      expect(wheelState.scrollY).toBe(0);

      const dragStart = await harness.point("#drag-source");
      const dragEnd = await harness.point("#drop-target");
      const dragged = await stableAction("drag", {
        x: dragStart.x,
        y: dragStart.y,
        endX: dragEnd.x,
        endY: dragEnd.y,
      }, true);
      const dragState = await harness.state();
      expect(dragState.dragStarted).toBe(true);
      // Chrome can coalesce DOM moves; the unit suite checks all eight dispatched steps.
      expect(dragState.dragMoves).toBeGreaterThanOrEqual(1);
      expect(dragState.dragReleased).toBe(true);
      expect(dragState.dropped).toBe(true);
      expect(dragged.resolvedEndPoint).toBeTruthy();
      expect(dragged._image).toMatch(/^data:image\/jpeg;base64,/);
      expect(dragged._display).toMatchObject({
        type: "imageWithAction",
        action: "drag",
        kind: "drag",
      });
      expect(dragged._display.x).toBeGreaterThan(0);
      expect(dragged._display.endX).toBeGreaterThan(dragged._display.x);
    } finally {
      await harness.close();
    }
  });

  test("captures exactly the four animation and observation combinations", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "capture-matrix");

    try {
      await harness.capture();
      const point = await harness.point("#click-target");

      let before = harness.screenshotCount;
      const directSilent = await harness.act({ action: "click", returnScreenshot: false, ...point });
      expect(harness.screenshotCount - before).toBe(2);
      expect(directSilent._display?.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(directSilent._display?.afterImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(directSilent._image).toBeUndefined();

      before = harness.screenshotCount;
      const directObserved = await harness.act({ action: "click", returnScreenshot: true, ...point });
      expect(harness.screenshotCount - before).toBe(2);
      expect(directObserved._display?.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(directObserved._display?.afterImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(directObserved._image).toMatch(/^data:image\/jpeg;base64,/);

      before = harness.screenshotCount;
      const scriptedSilent = await harness.act(
        { action: "click", returnScreenshot: false, ...point },
        undefined,
        { source: "run_script" },
      );
      expect(harness.screenshotCount - before).toBe(0);
      expect(scriptedSilent._display).toBeUndefined();
      expect(scriptedSilent._image).toBeUndefined();

      before = harness.screenshotCount;
      const scriptedObserved = await harness.act(
        { action: "click", returnScreenshot: true, ...point },
        undefined,
        { source: "run_script" },
      );
      expect(harness.screenshotCount - before).toBe(1);
      expect(scriptedObserved._display).toBeUndefined();
      expect(scriptedObserved._image).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      await harness.close();
    }
  });

  test("reports viewport changes, rebuilds coordinates, and preserves navigation feedback", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "state-change-sequence");

    try {
      await harness.capture();
      const scrollPoint = await harness.point("#page-scroll-target");
      const modelSilentScroll = await harness.act({
        action: "scroll",
        returnScreenshot: false,
        ...scrollPoint,
        deltaY: 260,
      });
      expect(modelSilentScroll.feedbackAvailable).toBe(false);
      expect(modelSilentScroll.coordinateBasisReady).toBe(true);
      expect(modelSilentScroll.continuationBlockedReason).toBeUndefined();
      expect(modelSilentScroll._display.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(modelSilentScroll._display.afterImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(modelSilentScroll.viewportChange).toMatchObject({
        observed: true,
        scrolled: true,
        deltaY: 260,
      });
      expect((await harness.state()).scrollY).toBe(260);

      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(async () => (await harness.state()).scrollY).toBe(0);
      await harness.capture();
      const refreshedScrollPoint = await harness.point("#page-scroll-target");
      const observedScroll = await harness.act({
        action: "scroll",
        returnScreenshot: true,
        ...refreshedScrollPoint,
        deltaY: 180,
      });
      expect(observedScroll.feedbackAvailable).toBe(true);
      expect(observedScroll.coordinateBasisReady).toBe(true);
      expect(observedScroll.viewportChange).toMatchObject({
        observed: true,
        scrolled: true,
        deltaY: 180,
      });
      expect(observedScroll._image).toMatch(/^data:image\/jpeg;base64,/);
      expect(observedScroll._display).toMatchObject({
        type: "imageWithAction",
        action: "scroll",
        kind: "point",
        direction: "down",
      });
      expect(observedScroll._display.beforeImage).toMatch(/^data:image\/jpeg;base64,/);

      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(async () => (await harness.state()).scrollY).toBe(0);
      await harness.capture();
      const navigationPoint = await harness.point("#navigation-target");
      const navigated = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...navigationPoint,
      });
      expect(navigated.urlChanged).toBe(true);
      expect(navigated.observedNavigation?.url).toContain("screen-action-runtime-result.html?count=1");
      expect(navigated.coordinateBasisReady).toBe(true);
      expect(navigated._display).toMatchObject({
        type: "imageWithAction",
        action: "click",
        kind: "point",
      });
      expect(navigated._display.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect((await harness.state()).navigationCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("reuses one coordinate basis while direct actions capture fresh animation frames", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "model-silent-navigation");

    try {
      const initial = await harness.capture();
      const inputPoint = await harness.point("#text-target");
      const navigationPoint = await harness.point("#navigation-target");
      const typed = await harness.act({
        action: "type",
        returnScreenshot: false,
        ...inputPoint,
        text: "页面跳转前的输入",
        replace: true,
      });
      expect(typed.feedbackAvailable).toBe(false);
      expect(typed.coordinateBasisReady).toBe(true);
      expect(typed.sourceScreenshotId).toBe(initial.snapshotId);
      expect(typed._display.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(typed._display.afterImage).toMatch(/^data:image\/jpeg;base64,/);
      expect((await harness.state()).inputValue).toBe("页面跳转前的输入");

      const navigated = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...navigationPoint,
      });
      expect(navigated.urlChanged).toBe(true);
      expect(navigated._display).toMatchObject({
        type: "imageWithAction",
        action: "click",
        kind: "point",
      });
      expect(navigated._display.beforeImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(navigated.sourceScreenshotId).toBe(initial.snapshotId);
      expect(navigated._display.afterImage).toMatch(/^data:image\/jpeg;base64,/);
      expect(navigated.feedbackAvailable).toBe(true);
      expect(navigated.coordinateBasisReady).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test("does not consume coordinates on validation failure and releases an aborted hold", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "recovery-sequence");

    try {
      const captured = await harness.capture();
      await expect(harness.act({
        action: "click",
        returnScreenshot: false,
        x: captured.coordinateSpace.width + 1,
        y: 1,
      })).rejects.toMatchObject({ code: "INVALID_SCREEN_COORDINATE" });

      const clickPoint = await harness.point("#click-target");
      const recovered = await harness.act({
        action: "click",
        returnScreenshot: false,
        ...clickPoint,
      });
      expect(recovered.sourceScreenshotId).toBe(captured.snapshotId);
      expect((await harness.state()).clickCount).toBe(1);

      await harness.capture();
      const holdPoint = await harness.point("#long-press-target");
      const controller = new AbortController();
      const holdPromise = harness.act({
        action: "long_press",
        returnScreenshot: false,
        ...holdPoint,
        durationMs: 1000,
      }, controller.signal);
      await expect.poll(async () => (await harness.state()).longPressActive).toBe(true);
      setTimeout(() => controller.abort(), 80);
      await expect(holdPromise).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      const holdState = await harness.state();
      expect(holdState.longPressActive).toBe(false);
      expect(holdState.longPressMs).toBeGreaterThan(40);
      expect(holdState.longPressMs).toBeLessThan(900);
    } finally {
      await harness.close();
    }
  });

  test("allows only one physical action to hold the coordinate lock under a concurrent race", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "concurrent-consumption");

    try {
      await harness.capture();
      const point = await harness.point("#click-target");
      const attempts = await Promise.allSettled([
        harness.act({ action: "click", returnScreenshot: false, ...point }),
        harness.act({ action: "click", returnScreenshot: false, ...point }),
      ]);
      const fulfilled = attempts.filter(attempt => attempt.status === "fulfilled");
      const rejected = attempts.filter(attempt => attempt.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        code: "SCREENSHOT_CONTEXT_STALE",
        details: { reason: "already_used" },
      });
      expect(fulfilled[0].value.coordinateBasisReady).toBe(true);
      expect((await harness.state()).clickCount).toBe(1);
    } finally {
      await harness.close();
    }
  });

  test("invalidates pre-zoom coordinates and maps a fresh visual viewport correctly", async ({ page, context }) => {
    await page.goto(FIXTURE_URL);
    const harness = await createScreenActionHarness(page, context, "visual-viewport-scale");

    try {
      const beforeZoom = await harness.capture();
      const oldPoint = await harness.point("#click-target");
      await harness.command("Emulation.setPageScaleFactor", { pageScaleFactor: 1.35 });
      const metrics = await harness.command("Page.getLayoutMetrics");
      expect(metrics.cssVisualViewport.scale).toBeCloseTo(1.35, 2);

      const staleError = await harness.act({
        action: "click",
        returnScreenshot: false,
        ...oldPoint,
      }).then(() => null, error => error);
      expect(staleError).toMatchObject({ code: "SCREENSHOT_CONTEXT_STALE" });
      expect(["viewport_resized", "viewport_scaled"]).toContain(staleError.details.reason);
      expect((await harness.state()).clickCount).toBe(0);

      const zoomed = await harness.capture();
      expect(zoomed.coordinateSpace.width).toBeGreaterThan(0);
      const freshPoint = await harness.point("#click-target");
      const clicked = await harness.act({
        action: "click",
        returnScreenshot: true,
        ...freshPoint,
      });
      expect(clicked.coordinateBasisReady).toBe(true);
      expect((await harness.state()).clickCount).toBe(1);
    } finally {
      await harness.command("Emulation.setPageScaleFactor", { pageScaleFactor: 1 }).catch(() => {});
      await harness.close();
    }
  });
});

import { expect, test } from "./sidepanel-fixtures.mjs";
import { imageTranscript } from "../support/markdown-stream-fixture.mjs";

test.use({ viewport: { width: 430, height: 760 }, launchOptions: { args: ["--enable-smooth-scrolling"] } });

for (const colorScheme of ["light", "dark"]) test(`native wheel at the fractional tail preserves the visible timeline · ${colorScheme}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme });
  await page.evaluate(async transcript => {
    await window.qingzhouConversationBenchmark.runLiveReplay({ sessionId: "fractional-tail", baseTranscript: transcript.slice(0, -1), events: [] }, { runId: transcript.at(-1).runId });
  }, imageTranscript());
  const card = page.locator(".msg-tool-timeline");
  await card.locator(":scope > .tool-summary").click();
  await card.locator('[data-tool-timeline-index="2"]').click();
  await expect(card.locator(".tool-image-grid-scroll")).toBeVisible();
  await card.locator(".tool-timeline-collapse-btn").hover();
  await page.evaluate(() => {
    window.__fractionalFrames = [];
    window.__fractionalSampling = true;
    const sample = () => {
      const m = document.querySelector("#messages");
      window.__fractionalFrames.push({ top: m.scrollTop, height: m.scrollHeight, client: m.clientHeight,
        viewport: m.getBoundingClientRect().toJSON(),
        card: m.querySelector(".msg-tool-timeline").getBoundingClientRect().toJSON() });
      if (window.__fractionalSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // Keep content fixed: no stream update can conceal the wheel's boundary clamp.
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(200);
  const frames = await page.evaluate(() => { window.__fractionalSampling = false; return window.__fractionalFrames; });
  await testInfo.attach("subpixel-scroll.json", { body: Buffer.from(JSON.stringify(frames, null, 2)), contentType: "application/json" });
  expect(frames.length).toBeGreaterThan(5);
  expect(frames[0].height - frames[0].client - frames[0].top).toBe(0);
  expect(new Set(frames.map(f => f.top)).size, JSON.stringify(frames)).toBe(1);
  expect(new Set(frames.map(f => f.card.top - f.viewport.top)).size, JSON.stringify(frames)).toBe(1);
  // Upward history intent must still use native scrolling.
  await page.mouse.wheel(0, -60);
  await expect.poll(() => page.locator("#messages").evaluate(node => node.scrollTop)).toBeLessThan(frames[0].top - 20);
});

for (const colorScheme of ["light", "dark"]) {
  test(`diagonal wheel at the chat tail scrolls wide code horizontally · ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const code = await appendWideCodeAtTail(page);
    await code.hover();
    for (const deltaY of [4, 30]) {
      await code.evaluate(node => { node.scrollLeft = 0; });
      await expect.poll(() => page.locator("#messages").evaluate(node =>
        Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight))).toBe(0);
      await page.mouse.wheel(120, deltaY);
      await expect.poll(() => code.evaluate(node => node.scrollLeft)).toBe(120);
    }
  });

  test(`ctrl wheel at the chat tail keeps its default action · ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const code = await appendWideCodeAtTail(page);
    const prevented = await code.evaluate(node => [false, true].map(ctrlKey => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 30, ctrlKey });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }));
    // The unmodified wheel is a positive control: the tail guard really ran.
    expect(prevented).toEqual([true, false]);
  });
}

async function appendWideCodeAtTail(page) {
  await page.evaluate(async transcript => {
    await window.qingzhouConversationBenchmark.runLiveReplay({ sessionId: "wide-code-tail", baseTranscript: transcript.slice(0, -1), events: [] }, { runId: transcript.at(-1).runId });
    const messages = document.querySelector("#messages");
    const last = [...messages.querySelectorAll(".msg-content")].at(-1);
    const pre = document.createElement("pre");
    pre.id = "wheel-wide-code";
    pre.style.cssText = "overflow-x:auto;overflow-y:hidden;width:300px;height:80px;";
    const code = document.createElement("code");
    code.style.cssText = "display:block;width:2000px;height:60px;";
    code.textContent = "const wide = 1234567890; ".repeat(20);
    pre.append(code);
    last.append(pre);
    messages.scrollTop = messages.scrollHeight;
  }, imageTranscript());
  const code = page.locator("#wheel-wide-code");
  await expect(code).toBeVisible();
  await expect.poll(() => page.locator("#messages").evaluate(node =>
    Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight))).toBe(0);
  return code;
}

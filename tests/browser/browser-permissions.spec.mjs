import { expect, test } from "./fixtures.mjs";

async function setup(page, feature) {
  await page.goto("/__test_health");
  await page.evaluate(async feature => {
    const f = window.permissionFixture = { calls: [], toasts: [], controller: new AbortController() };
    window.chrome ??= {};
    chrome.permissions = { request(input) {
      f.calls.push(["request", input, navigator.userActivation.isActive]);
      return new Promise((resolve, reject) => { f.reply = { resolve, reject }; });
    } };
    document.body.innerHTML = '<button id="action" data-artifact-action="open-file" data-download-id="7">Open</button>';
    const button = document.querySelector("button");
    if (feature === "recording") {
      chrome.desktopCapture = { chooseDesktopMedia(_sources, callback) { f.calls.push(["picker"]); callback(""); } };
      const { createCaseRecordingFeature } = await import("/extension/sidepanel/features/chat/case-recording-feature.js");
      f.feature = createCaseRecordingFeature({ button, showToast: message => f.toasts.push(message) });
    } else {
      chrome.downloads = {
        search: async () => { f.calls.push(["search"]); return [{ id: 7, exists: !f.deleted, url: "https://example.com/file.txt" }]; },
        open: async id => { f.calls.push(["open", id]); },
        show: async id => { f.calls.push(["show", id]); },
        download: async options => { f.calls.push(["download", options.url]); },
      };
      const { createArtifactsFeature } = await import("/extension/capabilities/sessions/artifacts/artifacts-feature.js");
      f.feature = createArtifactsFeature({ signal: f.controller.signal, request: async () => ({}), sessionState: { getRecord() {}, mergeRecord() {} }, openTable() {}, showToast: message => f.toasts.push(message) });
    }
  }, feature);
}
for (const feature of ["recording", "file"]) for (const outcome of ["grant", "deny", "error"]) {
  test(`${feature} requests permission directly from its click: ${outcome}`, async ({ page }) => {
    await setup(page, feature);
    await page.locator("button").click();
    const permission = feature === "recording" ? "desktopCapture" : "downloads.open";
    expect(await page.evaluate(() => window.permissionFixture.calls)).toEqual([["request", { permissions: [permission] }, true]]);
    await page.evaluate(outcome => {
      const { reply } = window.permissionFixture;
      if (outcome === "error") reply.reject(new Error("request failed"));
      else reply.resolve(outcome === "grant");
    }, outcome);
    const calls = await page.evaluate(() => window.permissionFixture.calls.map(call => call[0]));
    expect(calls).toEqual(outcome === "grant" ? feature === "recording" ? ["request", "picker"] : ["request", "search", "open"] : ["request"]);
    await expect(page.locator("button")).toBeEnabled();
    if (outcome !== "grant") {
      expect(await page.evaluate(() => window.permissionFixture.toasts.length)).toBe(1);
      await page.locator("button").click();
      await page.evaluate(() => window.permissionFixture.reply.resolve(true));
      expect(await page.evaluate(() => window.permissionFixture.calls.at(-1)[0])).toBe(feature === "recording" ? "picker" : "open");
    }
  });
}
test("artifact permission reply after disposal cannot open a file", async ({ page }) => {
  await setup(page, "file");
  await page.locator("button").click();
  await page.evaluate(() => { const f = window.permissionFixture; f.controller.abort(); f.reply.resolve(true); });
  expect(await page.evaluate(() => window.permissionFixture.calls.length)).toBe(1);
});
test("downloading a new artifact needs no open permission; deleted files still recover", async ({ page }) => {
  await setup(page, "file");
  await page.locator("button").evaluate(button => { button.dataset.downloadId = ""; button.dataset.url = "https://example.com/new.txt"; });
  await page.locator("button").click();
  expect(await page.evaluate(() => window.permissionFixture.calls)).toEqual([["download", "https://example.com/new.txt"]]);
  await page.locator("button").evaluate(button => { button.dataset.downloadId = "7"; delete button.dataset.url; });
  await page.evaluate(() => { window.permissionFixture.deleted = true; });
  await page.locator("button").click();
  await page.evaluate(() => window.permissionFixture.reply.resolve(true));
  expect(await page.evaluate(() => window.permissionFixture.calls.at(-1))).toEqual(["download", "https://example.com/file.txt"]);
});

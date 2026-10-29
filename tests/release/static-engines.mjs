import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSessionExchangePayload } from "../../src/shared/session/session-exchange.js";
import { textPdf } from "../support/text-pdf.mjs";

/** Exercise the actual packaged panel, transport, Background parser, storage and HTML download. */
export async function verifyStaticEngines({ context, page, worker, evidenceDir = resolve("tests/results/store-engines") }) {
  await mkdir(evidenceDir, { recursive: true });
  const requests = [];
  const errors = [];
  const onRequest = request => requests.push({ url: request.url(), type: request.resourceType() });
  const onError = error => errors.push(String(error));
  page.on("request", onRequest);
  page.on("pageerror", onError);
  const title = "Store review: static math and PDF";
  const content = String.raw`Packaged formulas: $\frac{1}{2}$, $\ce{H2O}$ and $\bm{v}$.

$$\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`;
  const payload = createSessionExchangePayload({
    session: { id: "store-review-fixture", title },
    transcript: [{ type: "assistant", content }], runtime: { status: "completed" }, appVersion: "0.1.5",
  });
  const imported = await page.evaluate(payload => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    const requestId = "store-review-import";
    const timeout = setTimeout(() => { port.disconnect(); reject(new Error("session import timed out")); }, 15000);
    port.onMessage.addListener(message => {
      if (message.requestId !== requestId) return;
      clearTimeout(timeout);
      port.disconnect();
      if (message.type === "error") reject(new Error(message.message));
      else resolve(message);
    });
    port.postMessage({ type: "import_session_exchange", requestId, payload });
  }), payload);
  assert.ok(imported.session?.id);
  await page.locator('[data-tab="sessions"]').click();
  await page.getByText(title, { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#messages mjx-container svg").length === 4);
  assert.equal(await page.locator('#messages [data-mml-node="merror"]').count(), 0);
  assert.equal(await page.evaluate(() => typeof MathJax.loader), "undefined");
  await page.screenshot({ path: join(evidenceDir, "packaged-panel-math.png"), fullPage: true });

  const marker = "Compressed packaged PDF page one";
  const second = "Compressed packaged PDF page two";
  const pdf = textPdf([marker, second]);
  await writeFile(join(evidenceDir, "synthetic-input.pdf"), pdf);
  await page.evaluate(base64 => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], "store-review.pdf", { type: "application/pdf" }));
    document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, pdf.toString("base64"));
  await page.locator(".input-document-attachment.is-ready").filter({ hasText: "store-review.pdf" }).waitFor({ timeout: 30000 });
  const models = await worker.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("qz-browser-agent-documents");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction("models").objectStore("models").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
  const model = models.find(model => model.sessionId === imported.session.id && model.type === "pdf");
  assert.ok(model, "the owning Session persists a PDF model");
  const extracted = model.blocks.map(block => block.text || "").join("\n");
  assert.ok(extracted.includes(marker) && extracted.includes(second), "both compressed pages use the PDF.js parser, not the fallback");
  assert.deepEqual(model.warnings, []);
  await writeFile(join(evidenceDir, "pdf-model.json"), JSON.stringify(model, null, 2));
  await page.screenshot({ path: join(evidenceDir, "packaged-pdf-ready.png"), fullPage: true });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: evidenceDir });
  await page.locator("#btn-export-session").click();
  let download;
  for (let attempt = 0; attempt < 150; attempt++) {
    download = await worker.evaluate(async () => (await chrome.downloads.search({ limit: 1, orderBy: ["-startTime"] }))[0]);
    if (download?.state === "complete") break;
    await page.waitForTimeout(100);
  }
  assert.equal(download?.state, "complete", "real session HTML export downloads successfully");
  const html = await readFile(download.filename, "utf8");
  await writeFile(join(evidenceDir, "session-export.html"), html);
  assert.doesNotMatch(html, /<script[^>]+src\s*=/iu);
  assert.doesNotMatch(html, /chrome-extension:|cdn\.jsdelivr|unpkg\.com/iu);
  const offline = await context.newPage();
  const offlineLoads = [];
  offline.on("request", request => offlineLoads.push(request.url()));
  offline.on("pageerror", onError);
  try {
    await offline.route(/^https?:/u, route => route.abort());
    await offline.goto(pathToFileURL(download.filename).href, { waitUntil: "load" });
    assert.equal(await offline.locator("#messages .math-formula svg").count(), 4);
    const boxes = await offline.locator("#messages .math-formula svg").evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.ok(boxes.every(box => box.width > 2 && box.height > 2));
    assert.equal(offlineLoads.filter(url => /^https?:/u.test(url)).length, 0);
    await offline.screenshot({ path: join(evidenceDir, "offline-export-math.png"), fullPage: true });
  } finally { await offline.close(); await cdp.detach(); }
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(request => request.type === "script" && /^https?:/u.test(request.url)).length, 0);
  assert.equal(requests.filter(request => /\/vendor\/mathjax\//u.test(request.url)).length, 1);
  page.off("request", onRequest);
  page.off("pageerror", onError);
  const result = { ok: true, browser: context.browser()?.version(), sessionId: imported.session.id,
    panelFormulas: 4, offlineExportFormulas: 4, pdfPagesRead: 2, pdfFallbackUsed: false,
    remoteScriptRequests: [], offlineRemoteRequests: [], requests, evidenceDir };
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

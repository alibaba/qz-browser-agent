import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { compileEmbeddedScript } from "../../scripts/build-extension.mjs";
import { serializeConversation } from "../../src/shared/session/session-codec.js";
import { createSessionExchangePayload, renderSessionExchangeScript } from "../../src/shared/session/session-exchange.js";
import { ensureTestExtension } from "../support/extension-build.mjs";

const IDLE_SCREENSHOT = "/tmp/qingzhou-consent-import-idle.png";
const PANEL_SCREENSHOT = "/tmp/qingzhou-consent-panel.png";
const DONE_SCREENSHOT = "/tmp/qingzhou-consent-import-done.png";
const CONSENTED_SCREENSHOT = "/tmp/qingzhou-consent-import-already.png";
const REPEAT_SCREENSHOT = "/tmp/qingzhou-import-repeat-panel.png";
const headless = process.env.CONSENT_IMPORT_HEADLESS !== "0";

const [extension, runtime] = await Promise.all([
  ensureTestExtension(),
  compileEmbeddedScript({
    sourceDir: resolve("src"),
    entry: "sidepanel/features/export/session-export-runtime.ts",
    mode: "production",
  }),
]);
const pages = new Map([
  ["/pending.html", exportHtml("同意后再点导入", "pending-source", "未同意的会话正文")],
  ["/consented.html", exportHtml("已同意直接导入", "consented-source", "已同意的会话正文")],
  ["/english.html", exportHtml("English page", "english-source", "English body", "en")],
  ["/nolang.html", exportHtml("No lang", "nolang-source", "No lang body", "")],
]);
const server = createServer((request, response) => {
  const body = pages.get(new URL(request.url || "/", "http://127.0.0.1").pathname);
  if (!body) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
});
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
const profile = await mkdtemp(join(tmpdir(), "qz-consent-import-"));
const executablePath = chromeExecutable();
const logs = [];
const context = await chromium.launchPersistentContext(profile, {
  locale: "zh-CN",
  headless,
  executablePath,
  ignoreDefaultArgs: ["--disable-extensions"],
  viewport: { width: 980, height: 860 },
  args: ["--lang=zh-CN", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  await context.addInitScript(() => {
    window.__qzImportResults = [];
    window.addEventListener("message", event => {
      const data = event.data;
      if (!data || data.type !== "qingzhou:session-export:result" || data.action !== "import") return;
      window.__qzImportResults.push({ status: data.status, ok: data.ok, error: data.error || "" });
    });
  });
  const worker = await extensionWorker(context);
  worker.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
  await worker.evaluate(() => chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: false } }));
  assert.deepEqual(await sidePanelContexts(worker), [], "a fresh profile has no side panel");

  const english = await openExport(context, `${origin}/english.html`);
  const englishButton = await waitUntil("english page label", () => buttonState(english.page), state => state.text === "Continue in qz");
  assert.equal(englishButton.text, "Continue in qz");
  await english.page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", status: "working" }, "*"));
  await waitUntil("english importing", () => buttonState(english.page), state => state.text === "Importing");
  await english.page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: true, sessionId: "english-session" }, "*"));
  const englishDone = await waitUntil("english imported", () => buttonState(english.page), state => state.text === "Imported" && state.imported === "english-session");
  assert.equal(englishDone.text, "Imported");
  await english.page.screenshot({ path: "/tmp/qingzhou-import-english-cta.png" });

  const nolang = await openExport(context, `${origin}/nolang.html`);
  assert.equal(await nolang.page.locator("html").getAttribute("lang"), null);
  const uiLanguage = await worker.evaluate(() => chrome.i18n.getUILanguage());
  const extensionLabel = /^zh/i.test(uiLanguage) ? "导入轻舟继续对话" : "Continue in qz";
  const extensionLanguage = await waitUntil(`extension language ${uiLanguage}`, () => buttonState(nolang.page), state => state.text === extensionLabel);
  assert.equal(extensionLanguage.text, extensionLabel);

  const pending = await openExport(context, `${origin}/pending.html`);
  const before = await waitUntil("localized idle", () => buttonState(pending.page), state => state.text === "导入轻舟继续对话");
  assert.equal(before.text, "导入轻舟继续对话");
  assert.equal(before.disabled, false);
  assert.deepEqual(before.results, []);
  assert.deepEqual(await sessionTitles(worker), []);

  await pending.page.locator("#qingzhou-session-cta").click();
  const opened = await waitUntil("side panel consent", () => consentSnapshot(context, worker), snapshot => (
    snapshot.contexts.some(url => url.includes("sidepanel/sidepanel.html"))
    && snapshot.consent?.accept === true
    && snapshot.consent.pending === true
    && snapshot.consent.title
  ));
  const idle = await buttonState(pending.page);
  assertIdle(idle, "unconsented click");
  assert.deepEqual(await sessionTitles(worker), []);
  assert.deepEqual(pending.errors, []);
  await pending.page.screenshot({ path: IDLE_SCREENSHOT });
  await captureSidePanel(context, PANEL_SCREENSHOT);
  console.log(`unconsented click opened consent via ${opened.consent.via}: ${opened.consent.title}`);

  await acceptConsent(context);
  await waitUntil("consent saved", () => consentStored(worker), saved => saved === true);
  const quietUntil = Date.now() + 1500;
  while (Date.now() < quietUntil) {
    assertIdle(await buttonState(pending.page), "agreeing does not import");
    assert.deepEqual(await sessionTitles(worker), []);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  await pending.page.locator("#qingzhou-session-cta").click();
  const imported = await waitUntil("import after the second click", () => buttonState(pending.page), state => {
    if (state.text === "重试导入") throw new Error(`import failed: ${state.title} ${JSON.stringify(state.results)}`);
    return state.text === "已导入" && state.imported;
  }, 20000);
  assert.equal(imported.results.some(item => item.status === "error"), false);
  assert.deepEqual(await sessionTitles(worker), ["同意后再点导入"]);
  const pendingPanel = await waitUntil("panel focuses the second-click import", () => panelChat(context), snapshot => (
    snapshot.title === "同意后再点导入"
    && snapshot.hidden === false
    && snapshot.state === "conversation"
    && snapshot.text.includes("未同意的会话正文")
  ), 20000);
  assert.equal(pendingPanel.title, "同意后再点导入");
  await pending.page.screenshot({ path: DONE_SCREENSHOT });

  const consented = await openExport(context, `${origin}/consented.html`);
  const ready = await waitUntil("consented idle", () => buttonState(consented.page), state => state.text === "导入轻舟继续对话");
  assert.equal(ready.text, "导入轻舟继续对话");
  assert.equal(ready.disabled, false);
  assert.deepEqual(ready.results, []);
  const stillConsented = await consentSnapshot(context, worker);
  assert.equal(stillConsented.consent?.accept, false, "an accepted profile does not show the consent card again");
  await consented.page.locator("#qingzhou-session-cta").click();
  const direct = await waitUntil("already consented import", () => buttonState(consented.page), state => {
    if (state.text === "重试导入") throw new Error(`consented import failed: ${state.title} ${JSON.stringify(state.results)}`);
    return state.text === "已导入" && state.imported;
  }, 20000);
  assert.equal(direct.results.some(item => item.status === "error"), false);
  const importedRecords = await sessionRecords(worker);
  assert.deepEqual(importedRecords.map(session => session.title).sort(), ["同意后再点导入", "已同意直接导入"].sort());
  const existingId = importedRecords.find(session => session.title === "已同意直接导入")?.id;
  assert.equal(direct.imported, existingId);
  const focused = await waitUntil("panel focuses the direct import", () => panelChat(context), snapshot => (
    snapshot.title === "已同意直接导入"
    && snapshot.hidden === false
    && snapshot.state === "conversation"
    && snapshot.text.includes("已同意的会话正文")
  ), 20000);
  assert.equal(focused.title, "已同意直接导入");
  await consented.page.screenshot({ path: CONSENTED_SCREENSHOT });

  await closeSidePanel(context);
  await waitUntil("side panel closed", () => sidePanelContexts(worker), contexts => contexts.length === 0, 8000);
  await consented.page.reload({ waitUntil: "domcontentloaded" });
  await consented.page.locator("#qingzhou-session-cta[data-qingzhou-session-import]").waitFor({ timeout: 10000 });
  const reloaded = await waitUntil("reloaded idle", () => buttonState(consented.page), state => state.text === "导入轻舟继续对话");
  assert.equal(reloaded.text, "导入轻舟继续对话");
  await consented.page.locator("#qingzhou-session-cta").click();
  const repeated = await waitUntil("repeat import", () => buttonState(consented.page), state => {
    if (state.text === "重试导入") throw new Error(`repeat import failed: ${state.title} ${JSON.stringify(state.results)}`);
    return state.text === "已导入" && state.imported === existingId;
  }, 20000);
  assert.equal(repeated.imported, existingId);
  assert.deepEqual(await sessionRecords(worker), importedRecords, "importing the same export again must not create another session");
  const repeatedPanel = await waitUntil("panel reopens on the existing session", () => panelChat(context), snapshot => (
    snapshot.open === true
    && snapshot.title === "已同意直接导入"
    && snapshot.hidden === false
    && snapshot.state === "conversation"
    && snapshot.text.includes("已同意的会话正文")
  ), 20000);
  assert.equal(repeatedPanel.open, true);
  assert.equal(repeatedPanel.title, "已同意直接导入");
  await captureSidePanel(context, REPEAT_SCREENSHOT);
  assert.deepEqual(pending.errors, []);
  assert.deepEqual(consented.errors, []);
  console.log("consent import check passed");
} catch (error) {
  error.message = `${error.message}\nlogs: ${JSON.stringify(logs)}`;
  throw error;
} finally {
  await context.close().catch(() => {});
  server.closeAllConnections?.();
  server.close();
  await rm(profile, { recursive: true, force: true });
}

function exportHtml(title, sourceId, content, lang = "zh-CN") {
  const payload = createSessionExchangePayload({
    session: { id: sourceId, title },
    conversation: serializeConversation([{ role: "user", content }]),
    transcript: [],
    exportedAt: "2026-07-12 12:00:00",
  });
  const messages = {
    importQingzhou: "导入轻舟",
    importing: "正在导入",
    imported: "已导入",
    retryImport: "重试导入",
    importFailedRetry: "导入失败，请重试",
    imagePreview: "图片预览",
    images: "图片",
    close: "关闭",
  };
  const script = runtime.replace(/<\/script/giu, "<\\/script");
  const langAttr = lang ? ` lang="${lang}"` : "";
  return `<!DOCTYPE html><html${langAttr}><head><meta charset="utf-8"><title>${title}</title></head><body>
    ${renderSessionExchangeScript(payload)}
    <script type="application/json" id="qingzhou-export-messages">${JSON.stringify(messages)}</script>
    <button id="qingzhou-session-cta" type="button" hidden></button>
    <script>${script}</script>
  </body></html>`;
}

function chromeExecutable() {
  return [
    process.env.CHROME_EXECUTABLE,
    chromium.executablePath(),
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome",
  ].find(path => path && existsSync(path));
}

async function extensionWorker(context) {
  const existing = context.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: worker => worker.url().startsWith("chrome-extension://"),
    timeout: 15000,
  });
}

async function openExport(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#qingzhou-session-cta[data-qingzhou-session-import]").waitFor({ timeout: 10000 });
  return { page, errors };
}

async function buttonState(page) {
  return page.evaluate(() => {
    const cta = document.getElementById("qingzhou-session-cta");
    return {
      text: cta?.textContent || "",
      disabled: cta instanceof HTMLButtonElement ? cta.disabled : true,
      busy: cta?.getAttribute("aria-busy") || "",
      imported: cta?.getAttribute("data-qingzhou-imported-session-id") || "",
      title: cta?.getAttribute("title") || "",
      results: window.__qzImportResults || [],
    };
  });
}

function assertIdle(state, label) {
  assert.equal(state.text, "导入轻舟继续对话", label);
  assert.equal(state.disabled, false, label);
  assert.equal(state.busy, "", label);
  assert.equal(state.imported, "", label);
  assert.equal(state.title, "", label);
  assert.deepEqual(state.results, [], label);
}

async function sessionTitles(worker) {
  return (await sessionRecords(worker)).map(session => session.title).filter(Boolean);
}

async function sessionRecords(worker) {
  return worker.evaluate(async () => {
    const data = await chrome.storage.local.get("_sessions");
    const sessions = data._sessions && typeof data._sessions === "object" ? data._sessions : {};
    return Object.values(sessions)
      .map(session => ({ id: String(session?.id || ""), title: String(session?.title || "") }))
      .sort((left, right) => left.id.localeCompare(right.id));
  });
}

async function panelChat(context) {
  const contexts = await sidePanelContexts(workerFrom(context)).catch(() => []);
  const page = sidePanelPages(context).at(-1);
  if (page) {
    const chat = await page.evaluate(() => ({
      title: (document.querySelector("#current-session-title")?.textContent || "").trim(),
      hidden: document.querySelector("#session-title-bar")?.classList.contains("hidden") === true,
      state: document.querySelector("#messages")?.getAttribute("data-chat-state") || "",
      text: document.querySelector("#messages")?.textContent || "",
    })).catch(error => ({ error: String(error) }));
    return { title: "", hidden: true, state: "", text: "", ...chat, open: contexts.length > 0 };
  }
  if (!contexts.length) return { open: false, title: "", hidden: true, state: "", text: "" };
  const chat = await evaluateSidePanel(context, `(() => ({
    title: (document.querySelector("#current-session-title")?.textContent || "").trim(),
    hidden: document.querySelector("#session-title-bar")?.classList.contains("hidden") === true,
    state: document.querySelector("#messages")?.getAttribute("data-chat-state") || "",
    text: document.querySelector("#messages")?.textContent || "",
  }))()`).catch(error => ({ error: String(error) }));
  return { title: "", hidden: true, state: "", text: "", ...chat, open: contexts.length > 0 };
}

function workerFrom(context) {
  const worker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"));
  if (!worker) throw new Error("extension worker is gone");
  return worker;
}

async function closeSidePanel(context) {
  const page = sidePanelPages(context).at(-1);
  if (page) {
    await page.close();
    return;
  }
  await evaluateSidePanel(context, `(() => { window.close(); return true; })()`);
}

async function sidePanelContexts(worker) {
  return worker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    return contexts.map(item => item.documentUrl || "");
  });
}

async function consentStored(worker) {
  return worker.evaluate(async () => {
    const data = await chrome.storage.local.get("qz_data_consent");
    const consent = data.qz_data_consent;
    return Boolean(consent && consent.version === 1 && consent.acceptedAt > 0);
  });
}

async function consentSnapshot(context, worker) {
  const contexts = await sidePanelContexts(worker).catch(error => [`error:${error.message}`]);
  const page = sidePanelPages(context).at(-1);
  if (page) {
    const consent = await page.evaluate(() => ({
      via: "page",
      accept: Boolean(document.querySelector("[data-consent-accept]")),
      pending: document.querySelector("#app")?.hasAttribute("data-consent-pending") === true,
      title: document.querySelector("#data-consent-title")?.textContent || "",
    })).catch(error => ({ via: "page", error: String(error) }));
    return { contexts, consent };
  }
  const consent = await evaluateSidePanel(context, `(() => ({
    via: "cdp",
    accept: Boolean(document.querySelector("[data-consent-accept]")),
    pending: document.querySelector("#app")?.hasAttribute("data-consent-pending") === true,
    title: document.querySelector("#data-consent-title")?.textContent || "",
  }))()`).catch(error => ({ via: "cdp", error: String(error) }));
  return { contexts, consent };
}

function sidePanelPages(context) {
  return context.pages().filter(page => page.url().includes("sidepanel/sidepanel.html"));
}

async function acceptConsent(context) {
  const page = sidePanelPages(context).at(-1);
  if (page) {
    await page.locator("[data-consent-accept]").click();
    return;
  }
  const clicked = await evaluateSidePanel(context, `(() => {
    const button = document.querySelector("[data-consent-accept]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, "consent button did not click");
}

async function captureSidePanel(context, file) {
  const page = sidePanelPages(context).at(-1);
  if (page) {
    await page.screenshot({ path: file });
    return;
  }
  const image = await sidePanelCommand(context, "Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (image?.data) await writeFile(file, Buffer.from(image.data, "base64"));
}

async function evaluateSidePanel(context, expression) {
  const result = await sidePanelCommand(context, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

async function sidePanelCommand(context, method, params) {
  const session = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find(info => String(info.url || "").includes("sidepanel/sidepanel.html"));
    if (!target) {
      const urls = targetInfos.map(info => `${info.type}:${info.url || ""}`);
      throw new Error(`side panel target missing: ${JSON.stringify(urls)}`);
    }
    const attached = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    try {
      return await cdpCall(session, attached.sessionId, method, params);
    } finally {
      await session.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => {});
    }
  } finally {
    await session.detach().catch(() => {});
  }
}

function cdpCall(session, sessionId, method, params) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      session.off("Target.receivedMessageFromTarget", onMessage);
      reject(new Error(`cdp ${method} timed out`));
    }, 4000);
    const onMessage = event => {
      if (event.sessionId !== sessionId) return;
      let message;
      try { message = JSON.parse(event.message); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      session.off("Target.receivedMessageFromTarget", onMessage);
      if (message.error) reject(new Error(`${method} ${JSON.stringify(message.error)}`));
      else resolvePromise(message.result);
    };
    session.on("Target.receivedMessageFromTarget", onMessage);
    session.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch(error => {
      clearTimeout(timer);
      session.off("Target.receivedMessageFromTarget", onMessage);
      reject(error);
    });
  });
}

async function waitUntil(label, read, ready, timeoutMs = 15000) {
  const started = Date.now();
  let last;
  while (Date.now() - started <= timeoutMs) {
    last = await read();
    if (ready(last)) return last;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

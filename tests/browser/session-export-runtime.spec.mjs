import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileEmbeddedScript } from "../../scripts/build-extension.mjs";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

let compiledHost;
let compiledStyles;
test.beforeAll(async () => {
  compiledStyles = await readFile(resolve(await ensureTestExtension(), "sidepanel/sidepanel.css"), "utf8");
  const runtime = await compileEmbeddedScript({
    sourceDir: resolve("src"),
    entry: "sidepanel/features/export/session-export-runtime.ts",
    mode: "production",
  });
  const result = await build({
    stdin: { contents: `
      import { buildSessionExportHtml, buildStaticSessionChatHtml } from "./src/sidepanel/features/export/session-export-feature.ts";
      import { createSessionExchangePayload } from "./src/shared/session/session-exchange.js";
      window.createExport = (title, transcript, extraHtml) => {
        const session = { id: "exported", title };
        const payload = createSessionExchangePayload({ session, transcript });
        const chatHtml = buildStaticSessionChatHtml(session, transcript, {
          normalizeSessionId: value => String(value || ""), projectTranscript: value => value,
          renderTranscriptElement: entry => {
            const p = document.createElement("p"); p.textContent = entry.content; return p;
          }
        }) + extraHtml;
        return buildSessionExportHtml(session, payload, { chatHtml, stylesheet: window.exportStyles });
      };
    `, resolveDir: process.cwd() },
    bundle: true, minify: true, format: "iife", write: false, target: "chrome120",
    define: { SESSION_EXPORT_RUNTIME_SOURCE: JSON.stringify(runtime) },
  });
  compiledHost = result.outputFiles[0].text;
});

async function createDocument(page, transcript = [], extra = "") {
  await page.goto("/__test_health");
  await page.addScriptTag({ content: compiledHost });
  await page.evaluate(styles => { window.exportStyles = styles; }, compiledStyles);
  return page.evaluate(({ transcript, extra }) => window.createExport('</script><script>window.pwned=true</script>', transcript, extra), { transcript, extra });
}

const tableTool = (id, label) => ({ type: "tool", id, name: "example_table", toolCallId: id, rendererId: "table", args: {}, result: { rows: [{ label, value: 1 }] }, hasResult: true });

test("minified export runs offline with static renderers, safe script text, theme and print", async ({ page, context }) => {
  const html = await createDocument(page, [tableTool("first", "Alpha"), tableTool("second", "Beta")]);
  const offline = await context.newPage();
  const errors = []; offline.on("pageerror", error => errors.push(error.message));
  await context.setOffline(true);
  await offline.setContent(html);
  expect(await offline.evaluate(() => window.pwned)).toBeUndefined();
  await expect(offline.locator("#current-session-title")).toHaveText('</script><script>window.pwned=true</script>');
  expect(await offline.locator('script[src], canvas, .tool-copy-btn').count()).toBe(0);
  const timeline = offline.locator(".msg-tool-timeline");
  await timeline.locator(":scope > .tool-timeline-summary").click();
  await expect(timeline.locator(".tool-timeline-slot")).toContainText("Beta");
  await timeline.locator("[data-timeline-nav-direction='-1']").filter({ visible: true }).first().click();
  await expect(timeline.locator(".tool-timeline-slot")).toContainText("Alpha");
  await timeline.locator("[data-timeline-nav-direction='1']").filter({ visible: true }).first().click();
  await expect(timeline.locator(".tool-timeline-slot")).toContainText("Beta");
  for (const colorScheme of ["light", "dark"]) {
    await offline.emulateMedia({ colorScheme });
    expect(await offline.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  }
  await offline.emulateMedia({ media: "print" });
  await expect(offline.locator("#messages")).toContainText("Beta");
  expect(errors).toEqual([]);
  await offline.close();
});

test("offline family navigation keeps chronological batches visible and counts every call", async ({ page, context }) => {
  const routes = ["A", "B", "A", "C", "D"];
  const transcript = routes.flatMap((route, batch) => Array.from({ length: 3 }, (_, member) => ({
    type: "tool", name: "navigate", toolCallId: `route-${batch}-${member}`,
    args: { url: `https://example.com/${route}` },
    result: { title: `Route ${route}`, url: `https://example.com/${route}#${batch}-${member}` },
    hasResult: true,
  })));
  const html = await createDocument(page, transcript);
  const offline = await context.newPage();
  await context.setOffline(true);
  await offline.setContent(html);
  const group = offline.locator(".msg-tool-timeline");
  await group.locator(":scope > .tool-timeline-summary").click();
  const assertCall = async index => {
    await expect(group.locator(".tool-timeline-slot-nav > span")).toHaveText(`${index + 1}/15`);
    await expect(group.locator(":scope > .tool-timeline-summary .tool-args-preview")).toContainText(`${index + 1}/15`);
    await expect(group.locator(".tool-family-row.active .tool-family-count")).toHaveText("15");
    const active = group.locator(".tool-family-panel.active .tool-family-batch.active");
    await expect(active).toHaveCount(1);
    await expect(active.locator("b")).toHaveText("×3");
    await expect(active.locator("em")).toHaveText(`Route ${routes[Math.floor(index / 3)]}`);
    await expect(group.locator(".tool-timeline-slot")).toContainText(transcript[index].result.url);
  };
  for (let index = 14; index >= 0; index -= 1) {
    if (index !== 14) await group.locator('[data-timeline-nav-direction="-1"]').click();
    await assertCall(index);
  }
  await expect(group.locator('[data-timeline-nav-direction="-1"]')).toBeDisabled();
  for (let index = 1; index < 15; index += 1) {
    await group.locator('[data-timeline-nav-direction="1"]').click();
    await assertCall(index);
  }
  await expect(group.locator('[data-timeline-nav-direction="1"]')).toBeDisabled();
  await offline.close();
});

test("standalone controls copy, preview images and react to validated bridge messages", async ({ page }) => {
  const html = await createDocument(page, [tableTool("only", "Single")], `
    <div class="copyable-code-block" data-copy-text="const value = 1;"><button class="code-copy-btn">Copy</button><pre>const value = 1;</pre></div>
    <img alt="Local preview" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E">
  `);
  await page.setContent(html);
  await expect(page.locator("#qingzhou-session-cta")).toBeHidden();
  await expect(page.locator(".session-export-continuation")).toHaveText("");
  await expect(page.locator(".session-export-continuation a")).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.copiedText = value; } } }));
  await page.locator(".code-copy-btn").click();
  expect(await page.evaluate(() => window.copiedText)).toBe("const value = 1;");
  await page.locator("#messages img").click();
  await expect(page.locator(".image-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".image-lightbox")).toHaveCount(0);
  await page.locator(".tool-summary").click();
  await expect(page.locator(".tool-details")).toBeVisible();
  await page.locator(".tool-summary").click();
  await expect(page.locator(".tool-details")).toBeHidden();
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "probe", installed: true }, "*"));
  const cta = page.getByRole("button", { name: "导入轻舟继续对话", exact: true });
  await expect(cta).toBeVisible();
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", status: "working" }, "*"));
  await expect(page.locator("#qingzhou-session-cta")).toBeDisabled();
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: false, error: "Try again" }, "*"));
  await expect(page.getByRole("button", { name: "重试导入" })).toBeEnabled();
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: true, sessionId: "new-session" }, "*"));
  await expect(page.locator("#qingzhou-session-cta")).toHaveAttribute("data-qingzhou-imported-session-id", "new-session");
});

test("bridge labels replace baked import copy, including status text", async ({ page }) => {
  const baked = {
    importQingzhou: "导入轻舟",
    importing: "正在导入",
    imported: "已导入",
    retryImport: "重试导入",
    importFailedRetry: "导入失败，请重试",
  };
  const english = {
    importQingzhou: "Continue in qz",
    importing: "Importing",
    imported: "Imported",
    retryImport: "Try again",
    importFailedRetry: "Could not import. Try again.",
  };
  const bakedJson = JSON.stringify(baked).replace(/</g, "\\u003c");
  const html = (await createDocument(page, [tableTool("only", "Single")])).replace(
    /<script type="application\/json" id="qingzhou-export-messages">[\s\S]*?<\/script>/,
    `<script type="application/json" id="qingzhou-export-messages">${bakedJson}</script>`,
  );
  await page.setContent(html);
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "probe", installed: true, labels: { importQingzhou: "nope" } }, "*"));
  await expect(page.locator("#qingzhou-session-cta")).toHaveText("导入轻舟");
  await page.evaluate(labels => window.postMessage({ type: "qingzhou:session-export:result", action: "probe", installed: true, labels }, "*"), english);
  const cta = page.locator("#qingzhou-session-cta");
  await expect(cta).toHaveText("Continue in qz");
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", status: "working" }, "*"));
  await expect(cta).toHaveText("Importing");
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: false }, "*"));
  await expect(cta).toHaveText("Try again");
  await expect(cta).toHaveAttribute("title", "Could not import. Try again.");
  await page.evaluate(() => window.postMessage({ type: "qingzhou:session-export:result", action: "import", ok: true, sessionId: "kept" }, "*"));
  await expect(cta).toHaveText("Imported");
});

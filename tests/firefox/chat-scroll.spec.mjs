import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { openFirefoxSidebar } from "./launch.mjs";
import { openFromToolbar, setSidebarWidth } from "./driver.mjs";
import { prepareBenchmarkAssets } from "../support/benchmark-assets.mjs";
import { expectToolCollapseVisible, runToolCollapseProbe } from "../support/tool-collapse-probe.mjs";

test("collapsing a running conversation reveals its first message without a wheel event", async ({}, testInfo) => {
  // Keep the test hook out of the package exercised by the other Firefox tests.
  const extensionDir = testInfo.outputPath("extension");
  await mkdir(extensionDir, { recursive: true });
  await cp(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR, extensionDir, { recursive: true });
  await prepareBenchmarkAssets(extensionDir, join(extensionDir, "sidepanel"), { extensionUrlPrefix: "" });
  const hook = join(extensionDir, "sidepanel/benchmark-test-hook.js");
  await writeFile(hook, `globalThis.__QZ_CONVERSATION_BENCHMARK__ = true;\n${await readFile(hook, "utf8")}`);
  const session = await openFirefoxSidebar({ extensionDir, profile: testInfo.outputPath("profile") });
  try {
    await openFromToolbar(session);
    await setSidebarWidth(session, 400);
    // Match the short 400x600 viewport used by the Chrome collapse fixture.
    await session.chrome(`
      const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
      const panel = win.document.getElementById("sidebar").contentDocument.getElementById("webext-panels-browser");
      panel.style.height = panel.style.minHeight = panel.style.maxHeight = "600px";
      return true;
    `);
    const ready = await session.extension("sidebar", `
      const started = Date.now();
      while (Date.now() - started < 12000) {
        content.document.querySelector("[data-consent-accept]")?.click();
        if (view.qingzhouConversationBenchmark && !content.document.querySelector("#app")?.hasAttribute("data-consent-pending")) return true;
        await new Promise(resolve => content.setTimeout(resolve, 100));
      }
      return false;
    `);
    expect(ready).toBe(true);
    for (const toolCount of [1, 45]) {
      for (const footer of [false, true]) {
        const result = await session.extension("sidebar", `
          return (${runToolCollapseProbe.toString()})({ scope: view, toolCount: ${toolCount}, footer: ${footer} });
        `);
        await testInfo.attach(`collapse-${toolCount}-${footer ? "footer" : "summary"}`, {
          body: Buffer.from(JSON.stringify({ toolCount, footer, ...result }, null, 2)), contentType: "application/json",
        });
        expectToolCollapseVisible(expect, result);
      }
    }
  } finally {
    await session.close();
  }
});

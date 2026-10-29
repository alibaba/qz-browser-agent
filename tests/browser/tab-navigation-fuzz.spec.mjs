import { chromium } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { installNavigationFuzzHarness, runNavigationFuzz, navigationCombinationScenarios } from "../support/navigation-fuzz.mjs";

const scenarios = ["old-pending", "reload", "commit", "timeout", "cancel", "close", "replace", "redirect", "blocked", "obsolete", "delete", "transfer", "isolated-sessions", "no-content", "network-failure", "subresources", "fragment"];
const plans = [
  ...[17, 20261029, 2654435769].map(seed => ({ seed, kind: "lifecycle", scenarios })),
  ...[73, 65537, 20261031].map(seed => ({ seed, kind: "combinations", scenarios: navigationCombinationScenarios })),
];
for (const { seed, kind, scenarios } of plans) for (const watchNetwork of [false, true]) {
  test(`navigation ${kind} fuzz seed=${seed} watchNetwork=${watchNetwork}`, async ({}, info) => {
    test.setTimeout(180000);
    const directory = await mkdtemp(join(tmpdir(), "qz-navigation-fuzz-")), extension = join(directory, "extension");
    let browser;
    const report = { browser: "chromium", kind, seed, watchNetwork, reads: 0, cases: [] };
    try {
      await installNavigationFuzzHarness(await ensureTestExtension(), extension, "chrome");
      browser = await chromium.launchPersistentContext(join(directory, "profile"), {
        headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-proxy-server",
          "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
      });
      const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
      await runNavigationFuzz(request => worker.evaluate(request => navigationFuzz(request), request), { seed, watchNetwork, scenarios }, report);
    } finally {
      const reportPath = info.outputPath("navigation-fuzz.json");
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      await info.attach("navigation-fuzz.json", { path: reportPath, contentType: "application/json" });
      await browser?.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

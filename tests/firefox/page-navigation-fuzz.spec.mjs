import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "./fixture.mjs";
import { openFirefoxSidebar } from "./launch.mjs";
import { installNavigationFuzzHarness, runNavigationFuzz, navigationCombinationScenarios } from "../support/navigation-fuzz.mjs";

const scenarios = ["old-pending", "reload", "commit", "timeout", "cancel", "close", "replace", "redirect", "blocked", "obsolete", "delete", "transfer", "isolated-sessions", "no-content", "network-failure", "subresources", "fragment"];
const plans = [
  ...[17, 20261029, 2654435769].map(seed => ({ seed, kind: "lifecycle", watchNetwork: false, scenarios })),
  ...[73, 65537, 20261031].flatMap(seed => [false, true].map(watchNetwork => ({ seed, kind: "combinations", watchNetwork, scenarios: navigationCombinationScenarios }))),
];
for (const { seed, kind, watchNetwork, scenarios } of plans) test(`Firefox navigation ${kind} fuzz seed=${seed} watchNetwork=${watchNetwork}`, async ({}, info) => {
  test.setTimeout(180000);
  const directory = await mkdtemp(join(tmpdir(), "qz-firefox-navigation-fuzz-")), extension = join(directory, "extension");
  let session;
  const report = { browser: "firefox", kind, watchNetwork, seed, reads: 0, cases: [] };
  try {
    await installNavigationFuzzHarness(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR, extension, "firefox");
    session = await openFirefoxSidebar({ extensionDir: extension });
    const api = request => session.extension("background", `
      const request = Cu.cloneInto(${JSON.stringify(request)}, content);
      return JSON.parse(JSON.stringify(await view.navigationFuzz(request)));
    `);
    await runNavigationFuzz(api, { seed, watchNetwork, scenarios }, report);
  } finally {
    const reportPath = info.outputPath("navigation-fuzz.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await info.attach("navigation-fuzz.json", { path: reportPath, contentType: "application/json" });
    await session?.close(); await rm(directory, { recursive: true, force: true });
  }
});

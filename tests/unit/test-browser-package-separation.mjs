import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AUTOMATED_SUITES, CHROME_SUITES, DEFAULT_SUITES, SHARED_SUITES, createSuiteCatalog } from "../runner/suites.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import {
  assertChromiumChannel,
  chromePackageError,
  firefoxPackageError,
} from "../support/browser-package.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("the Chromium channel rejects Firefox and the Firefox package rejects a Chrome manifest", () => {
  assert.equal(assertChromiumChannel(""), "");
  assert.equal(assertChromiumChannel("chromium"), "chromium");
  assert.equal(assertChromiumChannel("chrome"), "chrome");
  assert.throws(() => assertChromiumChannel("firefox"), /dist\/extension-firefox/);
  assert.throws(() => assertChromiumChannel("moz-firefox"), /dist\/extension-firefox/);
  assert.equal(chromePackageError({ manifest_version: 3, side_panel: { default_path: "sidepanel/sidepanel.html" } }), "");
  assert.match(chromePackageError({ browser_specific_settings: { gecko: { id: "addon@example" } }, sidebar_action: {} }), /Firefox package/);
  assert.equal(firefoxPackageError({
    browser_specific_settings: { gecko: { id: "addon@example" } },
    sidebar_action: { default_panel: "sidepanel/sidepanel.html" },
  }), "");
  assert.match(firefoxPackageError({ manifest_version: 3, side_panel: {} }), /dist\/extension-firefox/);
  assert.match(firefoxPackageError({
    browser_specific_settings: { gecko: { id: "addon@example" } },
    sidebar_action: { default_panel: "sidepanel/sidepanel.html" },
    permissions: ["theme"],
  }), /theme permission/);
});

test("Chromium extension loading refuses the Firefox package", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qz-firefox-package-"));
  try {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      browser_specific_settings: { gecko: { id: "addon@example" } },
      sidebar_action: { default_panel: "sidepanel/sidepanel.html" },
    }));
    await assert.rejects(() => ensureTestExtension({ extensionDir: directory }), /Firefox package/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Firefox suite is outside the Chromium verification plan", () => {
  assert.equal(AUTOMATED_SUITES.includes("firefox"), false);
  assert.equal(DEFAULT_SUITES.includes("firefox"), false);
  assert.deepEqual(SHARED_SUITES, ["unit", "contracts", "services"]);
  assert.deepEqual(CHROME_SUITES, ["browser", "e2e", "release", "visual"]);
  assert.deepEqual(AUTOMATED_SUITES, [...SHARED_SUITES, ...CHROME_SUITES]);
  assert.deepEqual(DEFAULT_SUITES, [...SHARED_SUITES, "browser"]);
  const catalog = createSuiteCatalog({ root, match: "", unitConcurrency: 1 });
  const command = catalog.filteredCommands("firefox")[0];
  assert.deepEqual(command.args, ["tests/firefox/run.mjs"]);
  assert.equal(command.resource, "general");
  const help = execFileSync(process.execPath, ["tests/run.mjs", "--help"], { cwd: root, encoding: "utf8" });
  assert.match(help, /browser=firefox package=dist\/extension-firefox/);
  assert.match(help, /do not select firefox/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.verify, "npm run typecheck && npm test -- unit contracts services");
  assert.equal(pkg.scripts["verify:chrome"], "npm test -- browser e2e release visual");
  assert.equal(pkg.scripts["verify:firefox"], "npm run typecheck && npm test -- firefox");
  assert.equal(pkg.scripts["verify:coverage"], "npm run typecheck && npm test -- --all --coverage");
  assert.equal(pkg.scripts["verify:quick"], undefined);
  const chromiumConfig = readFileSync(join(root, "tests/config/playwright.config.mjs"), "utf8");
  const firefoxConfig = readFileSync(join(root, "tests/config/playwright.firefox.config.mjs"), "utf8");
  assert.match(chromiumConfig, /assertChromiumChannel/);
  assert.doesNotMatch(chromiumConfig, /moz-firefox|extension-firefox/);
  assert.match(firefoxConfig, /browserName: "firefox"/);
  assert.match(firefoxConfig, /channel: "moz-firefox"/);
  assert.match(firefoxConfig, /playwright-firefox/);
  assert.doesNotMatch(firefoxConfig, /browserName: "chromium"|ensureTestExtension|chromium\.launch/);
  const locator = readFileSync(join(root, "tests/support/browser-package.mjs"), "utf8");
  assert.match(locator, /npx playwright install firefox/);
  assert.match(locator, /npx playwright install-deps firefox/);
  const sidebar = readFileSync(join(root, "tests/firefox/sidebar.spec.mjs"), "utf8");
  const launch = readFileSync(join(root, "tests/firefox/launch.mjs"), "utf8");
  assert.match(sidebar, /openFromToolbar/);
  assert.match(sidebar, /openFromShortcut/);
  assert.match(sidebar, /requireInteraction:\s*true/);
  assert.match(sidebar, /refuseSidebarOpen/);
  assert.doesNotMatch(sidebar, /page\.goto/);
  assert.doesNotMatch(launch, /page\.goto/);
  const commands = readFileSync(join(root, "docs/commands.md"), "utf8");
  assert.match(commands, /npx playwright install firefox/);
  assert.match(commands, /npx playwright install-deps firefox/);
});

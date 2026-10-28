import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FIREFOX_INSTALL_HINT = "Install Mozilla Firefox 154 or newer with npx playwright install firefox and npx playwright install-deps firefox, or set FIREFOX_EXECUTABLE to a Mozilla Firefox binary.";

const FIREFOX_CHANNEL = /firefox|gecko/i;

/** Chromium suites stay on the Chrome package. Firefox channels belong to verify:firefox. */
export function assertChromiumChannel(channel = process.env.QINGZHOU_PLAYWRIGHT_CHANNEL || "") {
  if (FIREFOX_CHANNEL.test(channel)) {
    throw new Error(`Chromium tests load the Chrome package (dist/extension) in Chromium. Channel "${channel}" is not used here. Run npm run verify:firefox for dist/extension-firefox in Firefox.`);
  }
  return channel;
}

/** Reject a Firefox add-on before a Chromium launcher can open it. */
export function chromePackageError(manifest) {
  if (manifest?.browser_specific_settings?.gecko || manifest?.sidebar_action) {
    return "This directory is the Firefox package (dist/extension-firefox). Chromium suites load the Chrome package (dist/extension) only.";
  }
  return "";
}

/** Require the Firefox manifest shape before Firefox launches it. */
export function firefoxPackageError(manifest) {
  const id = manifest?.browser_specific_settings?.gecko?.id;
  if (!id || !manifest?.sidebar_action?.default_panel) {
    return "Firefox Playwright loads dist/extension-firefox only. This directory is not that package.";
  }
  if (manifest.theme || manifest.permissions?.includes("theme") || manifest.optional_permissions?.includes("theme")) {
    return "The Firefox package must not ship a static theme, theme.update, or the theme permission.";
  }
  return "";
}

export function assertFirefoxPackage(manifest, directory) {
  const error = firefoxPackageError(manifest);
  if (error) throw new Error(`${error} Directory: ${directory}`);
  return manifest;
}

/** Locate stock Firefox. Playwright's Chromium build is never a candidate. */
export function resolveFirefoxExecutable() {
  const candidates = [];
  if (process.env.FIREFOX_EXECUTABLE) candidates.push(process.env.FIREFOX_EXECUTABLE);
  const onPath = firefoxOnPath();
  if (onPath) candidates.push(onPath);
  candidates.push(...playwrightFirefoxCandidates(), "/tmp/ff/firefox/firefox", "/usr/bin/firefox", "/snap/bin/firefox");
  const seen = new Set();
  const errors = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!existsSync(candidate)) continue;
    try {
      const version = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
      const match = /^Mozilla Firefox (\d+)\./.exec(version);
      if (!match) {
        errors.push(`${candidate}: ${version || "not Mozilla Firefox"}`);
        continue;
      }
      if (Number(match[1]) < 154) {
        errors.push(`${candidate}: ${version} is older than strict_min_version 154`);
        continue;
      }
      return { executablePath: candidate, version };
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Firefox Playwright needs Mozilla Firefox for dist/extension-firefox. ${FIREFOX_INSTALL_HINT} Chromium is not used.${errors.length ? `\n${errors.join("\n")}` : ""}`);
}

function playwrightFirefoxCandidates() {
  const roots = [];
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") roots.push(override);
  roots.push(join(homedir(), ".cache", "ms-playwright"));
  roots.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, "ms-playwright"));
  const found = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let names = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names.filter(entry => entry.startsWith("firefox-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const directory = join(root, name);
      found.push(join(directory, "firefox", "firefox"));
      found.push(join(directory, "firefox", "Firefox.app", "Contents", "MacOS", "firefox"));
    }
  }
  return found;
}

function firefoxOnPath() {
  try {
    const found = execFileSync("which", ["firefox"], { encoding: "utf8", timeout: 5_000 }).trim();
    return found || "";
  } catch {
    return "";
  }
}

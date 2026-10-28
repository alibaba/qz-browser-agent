import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright";
import { FIREFOX_GECKO_ID } from "../../scripts/firefox-manifest.mjs";
import { assertFirefoxPackage, resolveFirefoxExecutable } from "../support/browser-package.mjs";

export const FIREFOX_EXTENSION_UUID = "12345678-1234-5678-9abc-123456789abc";
const PACKAGE_LABEL = "dist/extension-firefox";
const SIDEBAR_URL = `moz-extension://${FIREFOX_EXTENSION_UUID}/sidepanel/sidepanel.html`;

/** Launch stock Firefox, temporarily install the Firefox package, and leave the sidebar closed. */
export async function openFirefoxSidebar({ extensionDir = process.env.QINGZHOU_FIREFOX_EXTENSION_DIR } = {}) {
  if (!extensionDir) throw new Error("Set QINGZHOU_FIREFOX_EXTENSION_DIR to dist/extension-firefox. npm run verify:firefox builds it.");
  const manifest = assertFirefoxPackage(JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")), extensionDir);
  const browser = resolveFirefoxExecutable();
  const profile = mkdtempSync(join(tmpdir(), "qz-firefox-playwright-"));
  const context = await firefox.launchPersistentContext(profile, {
    channel: "moz-firefox",
    executablePath: browser.executablePath,
    headless: process.env.QINGZHOU_FIREFOX_HEADED !== "1",
    args: ["-remote-allow-system-access"],
    viewport: null,
    firefoxUserPrefs: {
      "browser.aboutwelcome.enabled": false,
      "datareporting.policy.dataSubmissionEnabled": false,
      "extensions.webextensions.uuids": JSON.stringify({ [FIREFOX_GECKO_ID]: FIREFOX_EXTENSION_UUID }),
    },
  });
  const pageErrors = [];
  const consoleErrors = [];
  try {
    const engineVersion = context.browser().version();
    if (!engineVersion.startsWith("Mozilla/") && !/^\d+\./.test(engineVersion)) {
      throw new Error(`Playwright attached to ${engineVersion}, not Firefox.`);
    }
    const session = bidiSession(context);
    await installFirefoxExtension(context, extensionDir);
    const page = context.pages()[0] || await context.newPage();
    page.on("pageerror", error => pageErrors.push(String(error?.stack || error)));
    page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const sidebar = {
      browserName: "firefox",
      packageLabel: PACKAGE_LABEL,
      packageDir: extensionDir,
      geckoId: manifest.browser_specific_settings.gecko.id,
      executablePath: browser.executablePath,
      browserVersion: browser.version,
      engineVersion,
      sidebarUrl: SIDEBAR_URL,
      widgetId: widgetId(manifest.browser_specific_settings.gecko.id),
      context,
      page,
      pageErrors,
      consoleErrors,
      chrome(expression) { return evaluateChrome(session, expression); },
      extension(target, expression) { return evaluateExtension(session, target, expression); },
      async close() { await context.close(); },
    };
    return sidebar;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export function widgetId(extensionId) {
  return String(extensionId || "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

function bidiSession(context) {
  const playwrightBrowser = context.browser();
  const session = playwrightBrowser._connection?.toImpl?.(playwrightBrowser)?._browserSession;
  if (typeof session?.send !== "function") {
    throw new Error("Playwright did not expose the Firefox WebDriver BiDi session used to install dist/extension-firefox.");
  }
  return session;
}

async function installFirefoxExtension(context, extensionDir) {
  const playwrightBrowser = context.browser();
  if (playwrightBrowser.browserType().name() !== "firefox") {
    throw new Error("Refusing to install dist/extension-firefox into a non-Firefox browser.");
  }
  const session = bidiSession(context);
  const installed = await session.send("webExtension.install", {
    extensionData: { type: "path", path: extensionDir },
  });
  if (installed?.extension !== FIREFOX_GECKO_ID) {
    throw new Error(`Firefox installed ${installed?.extension || "nothing"}; expected ${FIREFOX_GECKO_ID}.`);
  }
}

async function evaluateChrome(session, expression) {
  const tree = await session.send("browsingContext.getTree", { "moz:scope": "chrome" });
  const contextId = findBrowserWindow(tree.contexts);
  if (!contextId) {
    throw new Error("Firefox did not expose a browser window. The launch needs -remote-allow-system-access so the sidebar can be read.");
  }
  const result = await session.send("script.evaluate", {
    expression: `(async () => { ${expression} })()`,
    target: { context: contextId },
    awaitPromise: true,
  });
  if (result.type !== "success") throw new Error(bidiFailure(result));
  return unwrap(result.result);
}

let frameSerial = 0;

async function evaluateExtension(session, target, expression) {
  const message = `qz-firefox-test-${++frameSerial}`;
  const frameSource = `(async () => {
    try {
      const view = Cu.waiveXrays(content);
      const value = await (async () => {
        ${expression}
      })();
      sendAsyncMessage(${JSON.stringify(message)}, { ok: true, value });
    } catch (error) {
      sendAsyncMessage(${JSON.stringify(message)}, { ok: false, error: String(error && error.message || error) });
    }
  })();`;
  const dataUrl = `data:text/javascript,${encodeURIComponent(frameSource)}`;
  const payload = await evaluateChrome(session, `
    const target = ${JSON.stringify(target)};
    const dataUrl = ${JSON.stringify(dataUrl)};
    const messageName = ${JSON.stringify(message)};
    const geckoId = ${JSON.stringify(FIREFOX_GECKO_ID)};
    const win = Services.wm.getMostRecentWindow("navigator:browser") || window;
    let browser;
    if (target === "background") {
      browser = WebExtensionPolicy.getByID(geckoId).extension.backgroundContext.xulBrowser;
    } else {
      browser = win.document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser");
    }
    if (!browser) throw new Error("Firefox " + target + " browser is not open");
    const mm = browser.messageManager;
    const message = await new Promise(resolve => {
      let timer;
      const finish = payload => {
        clearTimeout(timer);
        try { mm.removeMessageListener(messageName, listener); } catch { /* The listener is already gone after a timeout. */ }
        resolve(payload);
      };
      const listener = event => finish(event.data);
      mm.addMessageListener(messageName, listener);
      try { mm.loadFrameScript(dataUrl, false); }
      catch (error) { finish({ ok: false, error: String(error) }); return; }
      timer = setTimeout(() => finish({ ok: false, error: "extension script timed out" }), 20000);
    });
    return message;
  `);
  if (!payload?.ok) throw new Error(payload?.error || `Firefox ${target} script failed`);
  return payload.value;
}

function findBrowserWindow(nodes) {
  for (const node of nodes || []) {
    if (String(node.url || "").includes("chrome://browser/content/browser.xhtml")) return node.context;
    const child = findBrowserWindow(node.children);
    if (child) return child;
  }
  return "";
}

function bidiFailure(result) {
  const details = result?.exceptionDetails;
  if (!details) return "Firefox chrome script failed";
  const text = details.text || details.exception?.message || "";
  const frames = details.stackTrace?.callFrames || [];
  const stack = frames.map(frame => `${frame.functionName || "script"}@${frame.url || ""}:${frame.lineNumber || 0}`).join("\n");
  return [text, stack].filter(Boolean).join("\n") || "Firefox chrome script failed";
}

function unwrap(value) {
  if (!value || typeof value !== "object") return value;
  if (value.type === "array") return (value.value || []).map(unwrap);
  if (value.type === "object" || value.type === "map") {
    return Object.fromEntries((value.value || []).map(pair => [unwrap(pair[0]), unwrap(pair[1])]));
  }
  if ("value" in value) return value.value;
  return null;
}

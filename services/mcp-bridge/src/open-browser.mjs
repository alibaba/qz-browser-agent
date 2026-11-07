import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { QzError } from "./client.mjs";

const executeFile = promisify(execFile);
const connectionHint = "Run qz connect uri and open its URL in a Chromium browser or Firefox with qz installed.";
const browserIds = {
  darwin: /^(?:com\.google\.chrome(?:\..+)?|org\.chromium\.chromium|com\.microsoft\.edgemac(?:\..+)?|org\.mozilla\.(?:firefox(?:developeredition)?|nightly)(?:\..+)?|com\.brave\.browser(?:\..+)?|com\.vivaldi\.vivaldi|com\.operasoftware\.opera(?:\..+)?|company\.thebrowser\.browser)$/i,
  win32: /^(?:Chrome(?:B|D|S)?HTML|ChromiumHTM(?:L)?|MSEdgeHTM|FirefoxURL|BraveHTML|VivaldiHTM|OperaStable|OperaGX|ArcHTML)(?:[.-].+)?$/i,
  linux: /^(?:google-chrome(?:-(?:stable|beta|unstable))?|chromium(?:-browser|_chromium)?|org\.chromium\.Chromium|microsoft-edge(?:-(?:stable|beta|dev))?|com\.microsoft\.Edge|firefox(?:-esr|_firefox)?|org\.mozilla\.firefox|brave-browser(?:-(?:beta|nightly))?|com\.brave\.Browser|vivaldi(?:-stable|-snapshot)?|com\.vivaldi\.Vivaldi|opera(?:-beta|-developer)?|com\.opera\.Opera)\.desktop$/i,
};

/** Open the supported system URL handler once, preserving the user's default browser and profile. */
export async function openConnectionBrowser(url, {
  platform = process.platform, execFileProcess = executeFile, spawnProcess = spawn, signal, timeoutMs = 10000,
} = {}) {
  const target = webUrl(url), deadline = Date.now() + timeoutMs;
  signal?.throwIfAborted();
  const scheme = target.protocol.slice(0, -1);
  const [command, args] = platform === "darwin"
    ? ["osascript", ["-e", `id of application (path to default application for URL "${scheme}://localhost/")`]]
    : platform === "win32"
      ? ["reg.exe", ["query", `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, "/v", "ProgId"]]
      : ["xdg-mime", ["query", "default", `x-scheme-handler/${scheme}`]];
  let handler;
  try {
    const { stdout } = await execFileProcess(command, args, { encoding: "utf8", timeout: Math.max(1, Math.min(3000, timeoutMs)), maxBuffer: 65536, signal });
    handler = platform === "win32" ? stdout.match(/\bProgId\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() : stdout.trim();
    if (!handler) throw new Error("No default URL handler is registered.");
  } catch {
    signal?.throwIfAborted();
    throw new QzError("DEFAULT_BROWSER_UNAVAILABLE", "Could not determine the system default browser.", { url, hint: connectionHint });
  }
  signal?.throwIfAborted();
  if (!browserIds[platform]?.test(handler)) throw new QzError("DEFAULT_BROWSER_UNSUPPORTED", `The system default browser (${handler}) was not recognized as a supported browser.`, { url, hint: connectionHint });
  if (Date.now() >= deadline) throw new QzError("BROWSER_OPEN_FAILED", "Timed out before opening the system default browser.", { url, hint: connectionHint });
  try {
    return { ...await openBrowser(url, { platform, spawnProcess, signal, waitForExit: false, timeoutMs: deadline - Date.now() }), browser: "System default browser" };
  } catch (error) {
    signal?.throwIfAborted();
    throw new QzError("BROWSER_OPEN_FAILED", error.message, { url, hint: connectionHint });
  }
}

export async function openBrowser(url, { platform = process.platform, spawnProcess = spawn, signal, timeoutMs = 10000, waitForExit = true } = {}) {
  webUrl(url);
  signal?.throwIfAborted();
  const [command, args] = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  const failure = () => new QzError("BROWSER_OPEN_FAILED", "Could not open the system default browser. Open the URL manually.", { url });
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // The system opener may itself become the browser process. Never kill it on timeout or cancellation.
      child.unref?.();
      error ? reject(error) : resolve();
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(failure()), Math.max(1, timeoutMs));
    if (!waitForExit) child.once("spawn", () => finish());
    child.once("error", () => finish(failure()));
    child.once("exit", code => finish(code === 0 ? null : failure()));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return { url, opened: true };
}

function webUrl(url) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new QzError("BROWSER_OPEN_FAILED", "Only web URLs can be opened.", { url });
  return target;
}

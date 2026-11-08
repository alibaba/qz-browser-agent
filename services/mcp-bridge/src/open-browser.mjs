import { spawn } from "node:child_process";
import { QzError } from "./client.mjs";

const connectionHint = "Open the connection URL in the browser profile where qz is installed, then retry.";

/** Open the connection page once with the system URL opener; the page guides browsers without qz. */
export async function openConnectionBrowser(url, { platform = process.platform, spawnProcess = spawn, signal, timeoutMs = 10000 } = {}) {
  try {
    return { ...await openBrowser(url, { platform, spawnProcess, signal, waitForExit: false, timeoutMs }), browser: "System default browser" };
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

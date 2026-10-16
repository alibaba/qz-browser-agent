import { spawn } from "node:child_process";
import { QzError } from "./client.mjs";

export async function openBrowser(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new QzError("browser_open_failed", "Only web URLs can be opened.", { url });
  const [command, args] = platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new QzError("browser_open_failed", "The browser did not open. Open the URL in Chrome with qz installed.", { url }));
    }, 10000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once("error", () => finish(new QzError("browser_open_failed", "Could not open a browser. Open the URL in Chrome with qz installed.", { url })));
    child.once("exit", code => finish(code === 0 ? null : new QzError("browser_open_failed", "Could not open a browser. Open the URL in Chrome with qz installed.", { url })));
  });
  return { url, opened: true };
}

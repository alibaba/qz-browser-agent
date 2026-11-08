import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";

const available = async file => access(file).then(() => true, () => false);

/** npm's Windows command shim is resolved to its package entry, never evaluated by a shell. */
export async function cliCommand(cliPath = "qz", {
  platform = process.platform, env = process.env, cwd = process.cwd(), exists = available, read = readFile,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  if (/\.[cm]?js$/i.test(cliPath)) return { command: process.execPath, prefix: [paths.resolve(cwd, cliPath)], node: true };
  if (platform !== "win32") return { command: cliPath, prefix: [] };
  let executable;
  if (paths.isAbsolute(cliPath) || /[\\/]/.test(cliPath)) {
    const candidate = paths.resolve(cwd, cliPath);
    if (await exists(candidate)) executable = candidate;
  } else {
    const search = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] || "";
    for (const directory of search.split(";").filter(Boolean)) {
      for (const suffix of paths.extname(cliPath) ? [""] : [".exe", ".cmd", ".bat", ""]) {
        const candidate = paths.join(directory.replace(/^"|"$/g, ""), cliPath + suffix);
        if (await exists(candidate)) { executable = candidate; break; }
      }
      if (executable) break;
    }
  }
  if (!executable) throw new HarnessError("qz was not found. Install qz-browser-agent globally or set cliPath to its JavaScript entry.", "QZ_CLI_NOT_FOUND");
  if (!/\.(cmd|bat)$/i.test(executable)) throw new HarnessError(
    "On Windows, set cliPath to qz-browser-agent's src/bin.mjs so browser calls can be interrupted safely.", "QZ_CLI_UNSUPPORTED");
  for (const directory of [paths.join(paths.dirname(executable), "node_modules", "qz-browser-agent"),
    paths.resolve(paths.dirname(executable), "..", "qz-browser-agent")]) {
    let metadata;
    try { metadata = JSON.parse(await read(paths.join(directory, "package.json"), "utf8")); } catch { continue; }
    const entry = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.qz;
    if (metadata.name !== "qz-browser-agent" || typeof entry !== "string") continue;
    const target = paths.resolve(directory, entry), relative = paths.relative(directory, target);
    if (relative.startsWith("..") || paths.isAbsolute(relative) || !await exists(target)) continue;
    return { command: process.execPath, prefix: [target], node: true };
  }
  throw new HarnessError("The qz command shim could not be resolved. Set cliPath to qz-browser-agent's src/bin.mjs.", "QZ_CLI_NOT_FOUND");
}

/** Wait for the owned CLI process to close, including after cancellation. */
export async function runCli(config, argv, input, signal) {
  signal.throwIfAborted();
  const launch = await cliCommand(config.cliPath, { cwd: config.cwd });
  signal.throwIfAborted();
  const env = { ...process.env, ...(config.stateDir ? { QZ_STATE_DIR: config.stateDir } : {}) };
  const selected = config.client ? ["--client", config.client] : [];
  const ipc = process.platform === "win32";
  const preload = ipc ? ["--import", new URL("./cli-cancel.mjs", import.meta.url).href] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...preload, ...launch.prefix, ...selected, ...argv], {
      cwd: config.cwd, env, stdio: ["pipe", "pipe", "pipe", ...(ipc ? ["ipc"] : [])], windowsHide: true,
    });
    let stdout = "", stderr = "", outputBytes = 0, failure, killTimer;
    const interrupt = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (killTimer) return;
      if (ipc) child.send({ type: "qz.cancel" }, () => {});
      else child.kill("SIGINT");
      killTimer = setTimeout(() => {
        failure = new HarnessError("The qz CLI did not acknowledge cancellation. Browser actions may still be running; inspect the page before continuing.", "QZ_CANCELLATION_UNCONFIRMED");
        child.kill("SIGKILL");
      }, 8000);
    };
    const collect = (channel, data) => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > 16 * 1024 * 1024) {
        failure ??= new HarnessError("qz output exceeded 16 MiB. Return a smaller result.", "QZ_OUTPUT_LIMIT");
        interrupt(); return;
      }
      if (channel === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => collect("stdout", data));
    child.stderr.on("data", data => collect("stderr", data));
    child.on("error", error => {
      failure = error.code === "ENOENT" ? new HarnessError(
        "qz was not found. Install qz-browser-agent globally or set cliPath to its JavaScript entry.", "QZ_CLI_NOT_FOUND") : error;
    });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") failure ??= error; });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", interrupt);
      if (failure) { reject(failure); return; }
      let payload;
      try { payload = JSON.parse(stdout.trim()); }
      catch {
        reject(signal.aborted ? signal.reason : new HarnessError(
          `qz returned no valid JSON receipt${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : "."}`, "QZ_INVALID_RECEIPT"));
        return;
      }
      resolve({ payload, stderr, exitCode, exitSignal });
    });
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    child.stdin.end(input || "");
  });
}

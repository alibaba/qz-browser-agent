import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as cli from "../../services/mcp-bridge/src/cli.mjs";
import { ensureDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";
import { localFetch, readHealth } from "../../services/mcp-bridge/src/client.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const bin = join(root, "services/mcp-bridge/src/bin.mjs");
const source = join(root, "services/mcp-bridge/src/cli.mjs");

for (const firstSignal of ["SIGINT", "SIGTERM"]) {
  test(`${firstSignal} remains idempotent through cleanup and restores process listeners`, async () => {
    const before = ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal));
    let output = "", aborts = 0;
    const code = await cli.runMain(["create", "-", "--json"], {
      stdout: { write: value => { output += value; } },
      readStdin: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", async () => {
          aborts++;
          await delay(10);
          reject(signal.reason);
        }, { once: true });
        queueMicrotask(() => {
          process.emit(firstSignal);
          process.emit(firstSignal);
          process.emit(firstSignal === "SIGINT" ? "SIGTERM" : "SIGINT");
        });
      }),
    });
    assert.equal(code, firstSignal === "SIGINT" ? 130 : 143);
    assert.equal(aborts, 1);
    assert.equal(JSON.parse(output).error.code, "interrupted");
    assert.deepEqual(["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)), before);
  });
}

async function npmEntry() {
  const candidates = [process.env.npm_execpath];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    candidates.push(join(directory, "node_modules/npm/bin/npm-cli.js"));
    const executable = await realpath(join(directory, "npm")).catch(() => "");
    if (executable.endsWith("npm-cli.js")) candidates.push(executable);
  }
  for (const path of candidates.filter(Boolean)) {
    if (path.endsWith("npm-cli.js") && await access(path).then(() => true, () => false)) return path;
  }
  throw new Error("npm is required for CLI process signal tests.");
}

function startCommand(t, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  t.after(async () => { killGroup(); child.stdin.destroy(); await closed; });
  return {
    child, closed, killGroup,
    get stdout() { return stdout; }, get stderr() { return stderr; },
    async ready() {
      const deadline = Date.now() + 8000;
      while (!stderr.includes("QZ_STDIN_READY:")) {
        assert.equal(child.exitCode, null, `CLI exited before reading stdin: ${stdout}\n${stderr}`);
        assert.ok(Date.now() < deadline, `CLI did not begin reading stdin: ${stdout}\n${stderr}`);
        await delay(10);
      }
    },
  };
}

async function waitForExit(command) {
  let timer;
  try {
    return await Promise.race([command.closed, new Promise((resolve, reject) => {
      timer = setTimeout(() => { command.killGroup(); reject(new Error("CLI did not exit after its signal.")); }, 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    if (/^State:\s+[ZX]\b/m.test(status)) return false;
  }
  return true;
}

test("real process signals stop CLI observation without stopping its service or browser task", {
  skip: process.platform === "win32" ? "POSIX process-group signals; Windows handler logic is covered above." : false,
  timeout: 90000,
}, async t => {
  const work = await mkdtemp(join(tmpdir(), "qz-cli-signals-"));
  const stateDir = join(work, "state");
  t.after(async () => {
    try { await stopDaemon({ stateDir }); }
    finally { await rm(work, { recursive: true, force: true }); }
  });
  const running = await ensureDaemon({ stateDir, preferredPort: 0 });
  const npm = await npmEntry();
  await mkdir(join(work, "node_modules/.bin"), { recursive: true });
  await symlink(bin, join(work, "node_modules/.bin/qz"));
  await writeFile(join(work, "package.json"), JSON.stringify({ private: true }));
  // Readiness only: the real CLI, transport, signal listeners and npm wrappers are unchanged.
  const preload = `if (process.argv[1]?.endsWith('/bin.mjs') || process.argv[1]?.endsWith('/cli.mjs') || process.argv[1]?.endsWith('/.bin/qz')) {
    process.stderr.write('QZ_CLI_PID:' + process.pid + '\\n');
    const on = process.stdin.on;
    process.stdin.on = function(event, ...args) {
      const result = on.call(this, event, ...args);
      if (event === 'data') queueMicrotask(() => process.stderr.write('QZ_STDIN_READY:' + process.pid + '\\n'));
      return result;
    };
  }`;
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}`,
    QZ_STATE_DIR: stateDir, NO_COLOR: "1", NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    npm_config_ignore_scripts: "true", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
  const post = async (path, body) => {
    const response = await localFetch(`${running.endpoint}/v1/qingzhou/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.ok, true, `${path}: ${response.status}`);
    return response.json();
  };
  const proof = await post("pair", { clientId: randomUUID(), connectionId: randomUUID(), instanceId: running.instanceId, name: "signal-fixture" });
  const browser = { ...proof, id: proof.clientId, pairingVersion: 1 };
  const poll = async timeout => (await post("poll", { client: { ...browser, pollTimeoutMs: timeout } })).requests;
  const launches = [
    { name: "bin", args: [bin], cwd: root, deliveries: ["group"] },
    { name: "source", args: [source], cwd: root, deliveries: ["group"] },
    { name: "npm run", args: [npm, "run", "qz", "--"], cwd: root, deliveries: ["group", "cli"] },
    { name: "npm exec", args: [npm, "exec", "--offline", "--", "qz"], cwd: work, deliveries: ["group", "cli"] },
  ];
  for (const launch of launches) for (const signal of ["SIGINT", "SIGTERM"]) {
    for (const delivery of launch.deliveries) for (const phase of ["stdin", "stream"]) {
      await t.test(`${launch.name}: ${signal} to ${delivery} during ${phase}`, async t => {
        const argv = phase === "stdin" ? ["create", "-", "--json"]
          : ["create", "Keep running in the browser", "--stream", "--json", "--client", proof.clientId];
        const command = startCommand(t, [...launch.args, ...argv], launch.cwd, env);
        let request;
        const taskId = `signal-task-${randomUUID()}`;
        if (phase === "stdin") await command.ready();
        else {
          const created = await poll(5000);
          assert.deepEqual(created.map(item => item.method), ["create_session"]);
          assert.equal((await post("result", { ...proof, requestId: created[0].id, ok: true, result: { sessionId: taskId } })).ok, true);
          const snapshots = await poll(5000);
          assert.deepEqual(snapshots.map(item => item.method), ["get_session_snapshot"]);
          [request] = snapshots;
          assert.equal(request.params.sessionId, taskId);
        }
        const cliPid = Number(command.stderr.match(/QZ_CLI_PID:(\d+)/)?.[1]);
        assert.ok(cliPid);
        // npm signals its shell, which may keep qz as a separate child. A single-PID
        // signal must target qz itself; terminal Ctrl-C targets the entire group.
        process.kill(delivery === "group" ? -command.child.pid : cliPid, signal);
        const exited = await waitForExit(command);
        // npm may re-emit the signal after its child exits. Its child's JSON must survive either way.
        assert.ok(exited.code === (signal === "SIGINT" ? 130 : 143) || exited.signal === signal, JSON.stringify(exited));
        const payload = command.stdout.split("\n").filter(line => line.startsWith('{"ok":')).map(line => JSON.parse(line)).at(-1);
        assert.equal(payload?.error?.code, "interrupted", `${command.stdout}\n${command.stderr}`);
        if (request) {
          assert.equal(payload.error.sessionId, taskId);
          assert.equal(payload.error.clientId, proof.clientId);
          assert.equal((await post("result", { ...proof, requestId: request.id, ok: true, result: { status: "completed" } })).ok, false,
            "an abandoned observation cannot consume a late result");
        }
        assert.deepEqual(await poll(20), [], "interrupting never cancels, resubmits or creates a browser task");
        const health = await readHealth(running.endpoint);
        assert.equal(health.instanceId, running.instanceId, "the existing daemon remains running");
        assert.equal(health.processId, running.processId);
        assert.equal(await alive(cliPid), false, "the npm wrapper must not leave a CLI child behind");
      });
    }
  }
});

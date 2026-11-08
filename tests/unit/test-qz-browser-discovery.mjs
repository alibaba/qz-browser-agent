import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { openConnectionBrowser } from "../../services/mcp-bridge/src/open-browser.mjs";

const url = "http://127.0.0.1:18765/qz-connect?name=work";

function fixture(platform) {
  const launches = [], child = new EventEmitter();
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  child.kill = () => assert.fail("an opener may become the browser process and must never be killed");
  return { launches, child, unrefs: () => unrefs, options: {
    platform,
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  } };
}

for (const [platform, launcher] of [["darwin", "open"], ["win32", "rundll32.exe"], ["linux", "xdg-open"]]) {
  test(`${platform} opens the connection page once with the system opener without waiting for the browser to exit`, async () => {
    const f = fixture(platform);
    assert.deepEqual(await openConnectionBrowser(url, f.options), { url, opened: true, browser: "System default browser" });
    assert.deepEqual(f.launches.map(({ command, args }) => ({ command, args })),
      [{ command: launcher, args: platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url] }]);
    assert.equal(f.launches[0].options.shell, undefined);
    assert.equal(f.launches[0].options.detached, true);
    assert.equal(f.unrefs(), 1);
    // xdg-open can remain alive as the browser. The connection loop owns readiness.
    f.child.emit("exit", 0);
  });
}

test("launch failures keep the connection URL and a manual recovery hint", async () => {
  const f = fixture("linux");
  await assert.rejects(openConnectionBrowser(url, { ...f.options, spawnProcess: () => {
    queueMicrotask(() => f.child.emit("error", new Error("xdg-open missing"))); return f.child;
  } }), error => error.code === "BROWSER_OPEN_FAILED" && error.details.url === url
    && /connection URL in the browser profile where qz is installed/.test(error.details.hint));
  await assert.rejects(openConnectionBrowser("file:///etc/passwd", f.options), error => error.code === "BROWSER_OPEN_FAILED");
  assert.equal(f.launches.length, 0, "only web URLs reach the system opener");
});

test("cancellation before or during launcher startup reports the caller's reason", async () => {
  const f = fixture("linux"), early = new AbortController(), reason = new Error("Cancelled before opening");
  early.abort(reason);
  await assert.rejects(openConnectionBrowser(url, { ...f.options, signal: early.signal }), error => error === reason);
  assert.equal(f.launches.length, 0);
  const controller = new AbortController(), late = new Error("Cancelled during launcher startup");
  await assert.rejects(openConnectionBrowser(url, { ...f.options, signal: controller.signal, spawnProcess: () => {
    queueMicrotask(() => controller.abort(late)); return f.child;
  } }), error => error === late);
});

test("a real long-lived opener survives command cancellation after handoff", async t => {
  const f = fixture("linux"), controller = new AbortController();
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  });
  await openConnectionBrowser(url, { ...f.options, signal: controller.signal, spawnProcess: (_command, _args, options) => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options); return child;
  } });
  controller.abort();
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0), "cancelling the CLI cannot close the browser it opened");
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { openConnectionBrowser } from "../../services/mcp-bridge/src/open-browser.mjs";

const url = "http://127.0.0.1:18765/qz-connect?name=work";

function fixture(platform, handler) {
  const queries = [], launches = [], child = new EventEmitter();
  let unrefs = 0;
  child.unref = () => { unrefs++; };
  child.kill = () => assert.fail("an opener may become the browser process and must never be killed");
  return { queries, launches, child, unrefs: () => unrefs, options: {
    platform,
    execFileProcess: async (command, args, options) => {
      queries.push({ command, args, options });
      return { stdout: platform === "win32" ? `    ProgId    REG_SZ    ${handler}\r\n` : `${handler}\n` };
    },
    spawnProcess(command, args, options) {
      launches.push({ command, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  } };
}

for (const [platform, handlers, query, launcher] of [
  ["darwin", ["com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly", "com.brave.Browser"], "osascript", "open"],
  ["win32", ["ChromeHTML", "ChromeBHTML", "ChromeDHTML", "ChromeHTML.a1b2", "ChromiumHTM", "MSEdgeHTM", "FirefoxURL-308046B0AF4A39CB"], "reg.exe", "rundll32.exe"],
  ["linux", ["google-chrome.desktop", "chromium-browser.desktop", "chromium_chromium.desktop", "microsoft-edge.desktop", "firefox-esr.desktop", "firefox_firefox.desktop", "org.mozilla.firefox.desktop", "com.brave.Browser.desktop"], "xdg-mime", "xdg-open"],
]) test(`${platform} opens its supported default handler once without waiting for the browser to exit`, async () => {
  for (const handler of handlers) {
    const f = fixture(platform, handler);
    assert.deepEqual(await openConnectionBrowser(url, f.options), { url, opened: true, browser: "System default browser" });
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0].command, query);
    assert.equal(f.queries[0].options.shell, undefined);
    assert.ok(f.queries[0].options.timeout > 0 && f.queries[0].options.timeout <= 3000);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0].command, launcher);
    assert.deepEqual(f.launches[0].args, platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]);
    assert.equal(f.launches[0].options.shell, undefined);
    assert.equal(f.launches[0].options.detached, true);
    assert.equal(f.unrefs(), 1);
    // xdg-open can remain alive as the browser. The connection loop owns readiness.
    f.child.emit("exit", 0);
  }
});

test("an unsupported or unknown default never launches another installed browser", async () => {
  for (const [platform, handler] of [["darwin", "com.apple.Safari"], ["win32", "IE.HTTP"], ["linux", "org.gnome.Epiphany.desktop"]]) {
    const f = fixture(platform, handler);
    await assert.rejects(openConnectionBrowser(url, f.options), error => error.code === "DEFAULT_BROWSER_UNSUPPORTED"
      && error.message.includes(handler) && error.details.url === url && /qz connect uri/.test(error.details.hint));
    assert.equal(f.launches.length, 0);
  }
});

test("a missing default association or failed query gives a manual connection path without launching", async () => {
  for (const mode of ["empty", "error"]) {
    const f = fixture("linux", "");
    if (mode === "error") f.options.execFileProcess = async () => { throw new Error("xdg-mime unavailable"); };
    await assert.rejects(openConnectionBrowser(url, f.options), error => error.code === "DEFAULT_BROWSER_UNAVAILABLE"
      && error.details.url === url && /qz connect uri/.test(error.details.hint));
    assert.equal(f.launches.length, 0);
  }
});

test("query cancellation and an exhausted budget prevent a late browser launch", async t => {
  const f = fixture("linux", "firefox.desktop"), controller = new AbortController(), reason = new Error("Cancelled during default-browser query");
  await assert.rejects(openConnectionBrowser(url, { ...f.options, signal: controller.signal,
    execFileProcess: async (_command, _args, { signal }) => {
      assert.equal(signal, controller.signal); controller.abort(reason); return { stdout: "firefox.desktop" };
    },
  }), error => error === reason);
  assert.equal(f.launches.length, 0);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  await assert.rejects(openConnectionBrowser(url, { ...f.options, timeoutMs: 5,
    execFileProcess: async (_command, _args, { timeout }) => {
      assert.equal(timeout, 5); now += 6; return { stdout: "firefox.desktop" };
    },
  }), error => error.code === "BROWSER_OPEN_FAILED");
  assert.equal(f.launches.length, 0);
});

test("launcher failure and cancellation report promptly without killing the browser", async () => {
  const f = fixture("linux", "firefox.desktop");
  await assert.rejects(openConnectionBrowser(url, { ...f.options, spawnProcess: () => {
    queueMicrotask(() => f.child.emit("error", new Error("xdg-open missing"))); return f.child;
  } }), error => error.code === "BROWSER_OPEN_FAILED" && /qz connect uri/.test(error.details.hint));
  const controller = new AbortController(), reason = new Error("Cancelled during launcher startup");
  await assert.rejects(openConnectionBrowser(url, { ...f.options, signal: controller.signal, spawnProcess: () => {
    queueMicrotask(() => controller.abort(reason)); return f.child;
  } }), error => error === reason);
});


test("a real long-lived opener survives command cancellation after handoff", async t => {
  const f = fixture("linux", "firefox.desktop"), controller = new AbortController();
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

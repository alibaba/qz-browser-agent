import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { expect, test, testAssetUrl } from "./fixtures.mjs";

const fixtureUrl = testAssetUrl("tests/fixtures/scroll-page-hidden.html");
const contentScriptUrl = testAssetUrl("extension/content/content-script.js");

// Playwright force-enables focus emulation, which keeps background tabs visible and
// lets smooth scrolling run. This regression needs a real hidden document.
async function launchHiddenChrome() {
  const profile = await mkdtemp(join(tmpdir(), "qz-scroll-hidden-"));
  const executable = process.env.CHROME_EXECUTABLE || chromium.executablePath();
  const noSandbox = process.platform === "linux" && (process.getuid?.() === 0 || process.env.QZ_TEST_NO_SANDBOX === "1");
  const logs = [];
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--window-size=900,700",
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const remember = (source) => (chunk) => {
    logs.push(`[${source}] ${chunk.toString()}`);
    if (logs.length > 40) logs.shift();
  };
  child.stdout.on("data", remember("stdout"));
  child.stderr.on("data", remember("stderr"));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exit, delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exit, delay(2000)]);
      }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    const deadline = Date.now() + 15000;
    let active = "";
    while (!active) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before DevTools was ready\n${logs.join("")}`);
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for Chrome\n${logs.join("")}`);
      active = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
      if (!active) await delay(50);
    }
    const endpoint = `http://127.0.0.1:${active.trim().split("\n")[0]}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const browser = await openCdp(version.webSocketDebuggerUrl);
    const created = [];
    for (const url of ["about:blank", "about:blank"]) {
      const target = await browser.send("Target.createTarget", { url });
      created.push(target.targetId);
    }
    await browser.send("Target.activateTarget", { targetId: created[0] });
    await delay(200);
    const listed = await (await fetch(`${endpoint}/json/list`)).json();
    const pages = [];
    for (const targetId of created) {
      const target = listed.find((item) => item.id === targetId && item.webSocketDebuggerUrl);
      if (!target) throw new Error(`Missing CDP target ${targetId}`);
      const session = await openCdp(target.webSocketDebuggerUrl);
      await session.send("Runtime.enable");
      await session.send("Page.navigate", { url: fixtureUrl });
      const navigationDeadline = Date.now() + 10000;
      let href = "";
      let readyState = "";
      while (href !== fixtureUrl || readyState !== "complete") {
        if (Date.now() > navigationDeadline) throw new Error(`Timed out opening ${fixtureUrl} (href=${href}, readyState=${readyState})`);
        href = await evaluate(session, "location.href");
        readyState = await evaluate(session, "document.readyState");
        if (href !== fixtureUrl || readyState !== "complete") await delay(50);
      }
      await installContentScript(session);
      const visibilityState = await evaluate(session, "document.visibilityState");
      pages.push({ session, visibilityState });
    }
    const hidden = pages.find((page) => page.visibilityState === "hidden");
    const visible = pages.find((page) => page.visibilityState === "visible");
    if (!hidden || !visible) {
      throw new Error(`Expected one hidden and one visible tab, got ${pages.map((page) => page.visibilityState).join(", ")}`);
    }
    return {
      hidden: hidden.session,
      visible: visible.session,
      stop: async () => {
        browser.close();
        hidden.session.close();
        visible.session.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error(`CDP connection failed: ${wsUrl}`)), { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else call.resolve(message.result);
  });
  return {
    ready,
    async send(method, params = {}) {
      await ready;
      const next = ++id;
      return new Promise((resolve, reject) => {
        pending.set(next, { resolve, reject });
        ws.send(JSON.stringify({ id: next, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "Page evaluation failed");
  }
  return result.result?.value;
}

async function installContentScript(session) {
  await evaluate(session, `(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: {
          addListener(next) { listener = next; },
          removeListener() {},
        },
        sendMessage: async () => ({ ok: true }),
      },
    });
    window.__scrollBehaviors = [];
    const originalScrollBy = window.scrollBy.bind(window);
    window.scrollBy = function(options) {
      window.__scrollBehaviors.push({ method: "scrollBy", behavior: options && options.behavior });
      return originalScrollBy(options);
    };
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) {
      window.__scrollBehaviors.push({ method: "scrollIntoView", behavior: options && options.behavior });
      return originalScrollIntoView.call(this, options);
    };
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  })()`);
  await evaluate(session, `new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ${JSON.stringify(contentScriptUrl)};
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error("content script failed to load"));
    document.documentElement.append(script);
  })`);
  await expect.poll(() => evaluate(session, "window.__QZ_CONTENT_READY === true")).toBe(true);
}

function waitForWindowScroll(session) {
  return evaluate(session, `new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ reason: "timeout", scrollY: window.scrollY }), 4000);
    document.addEventListener("scrollend", () => {
      clearTimeout(timer);
      resolve({ reason: "scrollend", scrollY: window.scrollY });
    }, { once: true });
  })`);
}

async function scrollPage(session, params) {
  return evaluate(session, `(() => {
    const scroller = document.querySelector("#scroller");
    const run = window.__callQingzhouContent("scrollPage", ${JSON.stringify(params)});
    return Promise.resolve(run).then((result) => ({
      result,
      scrollY: window.scrollY,
      inner: scroller.scrollTop,
      maxScroll: Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - (document.scrollingElement || document.documentElement).clientHeight),
      visibilityState: document.visibilityState,
      behaviors: window.__scrollBehaviors.splice(0),
    }));
  })()`);
}

test("scroll_page moves a hidden tab and reports the resulting scrollY", async () => {
  const chrome = await launchHiddenChrome();
  try {
    const hidden = chrome.hidden;
    expect(await evaluate(hidden, "document.visibilityState")).toBe("hidden");

    const down = await scrollPage(hidden, { direction: "down" });
    expect(down.result.error).toBeUndefined();
    expect(down.visibilityState).toBe("hidden");
    expect(down.scrollY).toBe(500);
    expect(down.result.scrollY).toBe(500);
    expect(down.behaviors).toEqual([{ method: "scrollBy", behavior: "instant" }]);

    const up = await scrollPage(hidden, { direction: "up" });
    expect(up.scrollY).toBe(0);
    expect(up.result.scrollY).toBe(0);
    expect(up.behaviors).toEqual([{ method: "scrollBy", behavior: "instant" }]);

    const downPixels = await scrollPage(hidden, { direction: "down", pixels: 250 });
    expect(downPixels.scrollY).toBe(250);
    expect(downPixels.result.scrollY).toBe(250);

    const bottom = await scrollPage(hidden, { direction: "bottom" });
    expect(bottom.result.error).toBeUndefined();
    expect(bottom.scrollY).toBe(bottom.maxScroll);
    expect(bottom.maxScroll).toBeGreaterThan(1000);
    expect(bottom.result.scrollY).toBe(bottom.scrollY);
    expect(bottom.result.direction).toBe("bottom");
    expect(bottom.behaviors).toEqual([{ method: "scrollBy", behavior: "instant" }]);

    const backToTop = await scrollPage(hidden, { direction: "top" });
    expect(backToTop.scrollY).toBe(0);
    expect(backToTop.result.scrollY).toBe(0);

    const inner = await scrollPage(hidden, { selector: "#inner-target" });
    expect(inner.result.error).toBeUndefined();
    expect(inner.result.scrolledTo).toBe("#inner-target");
    expect(inner.inner).toBeGreaterThan(1000);
    expect(inner.result.scrollY).toBe(inner.scrollY);
    expect(inner.behaviors).toEqual([{ method: "scrollIntoView", behavior: "instant" }]);

    const far = await scrollPage(hidden, { selector: "#far-target" });
    expect(far.result.error).toBeUndefined();
    expect(far.result.scrolledTo).toBe("#far-target");
    expect(far.scrollY).toBeGreaterThan(1000);
    expect(far.result.scrollY).toBe(far.scrollY);
    expect(far.behaviors).toEqual([{ method: "scrollIntoView", behavior: "instant" }]);

    const visible = chrome.visible;
    expect(await evaluate(visible, "document.visibilityState")).toBe("visible");
    const visibleDown = await scrollPage(visible, { direction: "down" });
    expect(visibleDown.result.error).toBeUndefined();
    expect(visibleDown.behaviors).toEqual([{ method: "scrollBy", behavior: "smooth" }]);
    expect(visibleDown.result.scrollY).toBe(500);
    expect(visibleDown.scrollY).toBeLessThan(500);
    const settled = await waitForWindowScroll(visible);
    expect(settled.reason).toBe("scrollend");
    expect(settled.scrollY).toBe(visibleDown.result.scrollY);

    const visibleBottom = await scrollPage(visible, { direction: "bottom" });
    expect(visibleBottom.behaviors).toEqual([{ method: "scrollBy", behavior: "smooth" }]);
    expect(visibleBottom.result.scrollY).toBe(visibleBottom.maxScroll);
    expect(visibleBottom.scrollY).toBeLessThan(visibleBottom.result.scrollY);
    const settledBottom = await waitForWindowScroll(visible);
    expect(settledBottom.reason).toBe("scrollend");
    expect(settledBottom.scrollY).toBe(visibleBottom.result.scrollY);

    const visibleInner = await scrollPage(visible, { selector: "#inner-target" });
    expect(visibleInner.behaviors).toEqual([{ method: "scrollIntoView", behavior: "smooth" }]);
    expect(visibleInner.result).toEqual({ scrolledTo: "#inner-target" });
    expect(visibleInner.inner).toBeLessThan(1000);
    const settledInner = await evaluate(visible, `new Promise((resolve) => {
      const scroller = document.querySelector("#scroller");
      const timer = setTimeout(() => resolve({ reason: "timeout", inner: scroller.scrollTop }), 4000);
      scroller.addEventListener("scrollend", () => {
        clearTimeout(timer);
        resolve({ reason: "scrollend", inner: scroller.scrollTop });
      }, { once: true });
    })`);
    expect(settledInner.reason).toBe("scrollend");
    expect(settledInner.inner).toBeGreaterThan(1000);
  } finally {
    await chrome.stop();
  }
});

// Shared measurement-only driver. All injected modules live in ignored build output.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { openFirefoxSidebar } from "../firefox/launch.mjs";
import { openFromSwitcher } from "../firefox/driver.mjs";
import { installBackgroundProbe, installSidebarProbe } from "./firefox-image-history-memory.mjs";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function poll(operation, predicate = Boolean, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await operation(); if (predicate(last)) return last; } catch (error) { last = String(error); }
    await sleep(100);
  }
  throw new Error(`Measurement poll timed out: ${JSON.stringify(last)}`);
}

export async function installProbes(extensionDir) {
  const workerPath = join(extensionDir, "background/service-worker.js");
  const original = await readFile(workerPath, "utf8");
  if (original.includes('import "./image-memory-probe.js"')) throw new Error("Measurement probe already installed; restore/rebuild package first");
  await writeFile(join(extensionDir, "background/image-memory-probe.js"), `
import { Agent } from "./agent/agent.js";
import { getSessionRepository } from "./session/repository.js";
import { createSessionRecord } from "../shared/session/session-codec.js";
import { bytesToBase64 } from "../shared/bytes.js";
(${installBackgroundProbe.toString()})({ Agent, getSessionRepository, createSessionRecord, bytesToBase64 });
`);
  await writeFile(workerPath, original + '\nimport "./image-memory-probe.js";\n');
  await writeFile(join(extensionDir, "sidepanel/image-memory-probe.js"), `(${installSidebarProbe.toString()})();\n(${installOpenProbe.toString()})();\n`);
  return async () => {
    await writeFile(workerPath, original);
    await rm(join(extensionDir, "background/image-memory-probe.js"), { force: true });
    await rm(join(extensionDir, "sidepanel/image-memory-probe.js"), { force: true });
  };
}

export async function launchMeasurement({ browser, extensionDir, profile }) {
  profile = resolve(profile);
  await mkdir(profile, { recursive: true });
  let native, context, worker, page, rootPid, version;
  if (browser === "firefox") {
    native = await openFirefoxSidebar({ extensionDir, profile, firefoxUserPrefs: {
      // Temporary add-ons are reinstalled after restart. Keep their storage, as
      // a normally installed add-on would, without changing product settings.
      "extensions.webextensions.keepStorageOnUninstall": true,
    } });
    context = native.context;
    rootPid = await native.chrome("return Services.appinfo.processID;");
    version = native.browserVersion;
  } else {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROME_EXECUTABLE || chromium.executablePath(),
      headless: true, ignoreDefaultArgs: ["--disable-extensions"],
      viewport: { width: 980, height: 860 },
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    worker = context.serviceWorkers().find(item => item.url().endsWith("/background/service-worker.js"))
      || await context.waitForEvent("serviceworker", { timeout: 30000 });
    const processes = processRows();
    rootPid = processes.find(row => row.args.includes(`--user-data-dir=${profile}`) && !row.args.includes("--type="))?.pid;
    if (!rootPid) throw new Error("Cannot identify owned Chromium browser PID");
    version = context.browser().version();
  }
  const evaluate = async (target, expression) => {
    if (native) return native.extension(target, expression);
    return (target === "background" ? worker : page).evaluate(`(async () => { const view = globalThis; ${expression} })()`);
  };
  const openUI = async () => {
    if (native) await openFromSwitcher(native);
    else {
      page ||= await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel/sidepanel.html`);
    }
    await poll(() => evaluate("sidebar", `return !!view.document.querySelector('[data-tab="sessions"]') && !view.document.querySelector('#app')?.hasAttribute('data-workspace-booting');`));
    await evaluate("sidebar", `const script = view.document.createElement('script'); script.type = 'module'; script.src = view.chrome.runtime.getURL('sidepanel/image-memory-probe.js'); view.document.documentElement.appendChild(script); return true;`);
    await poll(() => evaluate("sidebar", "return !!view.imageMemorySidebarProbe && !!view.imageOpenProbe;"));
  };
  await poll(() => evaluate("background", "return !!view.imageMemoryProbe;"));
  return { browser, context, native, rootPid, version, profile, evaluate, openUI,
    open: (id, count) => evaluate("sidebar", `return await view.imageOpenProbe(${JSON.stringify(id)}, ${count});`),
    close: () => context.close(),
  };
}

export function processRows() {
  return execFileSync("ps", ["-eo", "pid=,ppid=,rss=,comm=,args="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { pid: +match[1], ppid: +match[2], rssKiB: +match[3], comm: match[4], args: match[5] } : null;
  }).filter(Boolean);
}

export function rssSample(browser, rootPid, turn) {
  const rows = processRows(), ids = new Set([rootPid]);
  let changed;
  do { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } } while (changed);
  const own = rows.filter(row => ids.has(row.pid));
  const buckets = browser === "firefox" ? { browser: 0, extension: 0, renderer: 0, other: 0 }
    : { browser: 0, extension: 0, renderer: 0, gpu: 0, utility: 0, other: 0 };
  for (const row of own) {
    let type = "other";
    if (row.pid === rootPid) type = "browser";
    else if (browser === "firefox") type = /WebExtensions/i.test(row.comm) ? "extension" : /-isForBrowser/.test(row.args) ? "renderer" : "other";
    else if (/--extension-process/.test(row.args)) type = "extension";
    else if (/--type=renderer/.test(row.args)) type = "renderer";
    else if (/--type=gpu-process/.test(row.args)) type = "gpu";
    else if (/--type=utility/.test(row.args)) type = "utility";
    buckets[type] += row.rssKiB;
  }
  return { at: Date.now(), monotonicMs: performance.now(), turn, buckets, processes: own };
}

export function summarizeRss(samples) {
  const clock = sample => sample.monotonicMs ?? sample.at;
  return Object.fromEntries(Object.keys(samples[0].buckets).map(bucket => [bucket, {
    startKiB: samples[0].buckets[bucket], peakKiB: Math.max(...samples.map(sample => sample.buckets[bucket])),
    endKiB: samples.at(-1).buckets[bucket],
    slopeKiBPerMinute: (samples.at(-1).buckets[bucket] - samples[0].buckets[bucket]) * 60000 / (clock(samples.at(-1)) - clock(samples[0])),
  }]));
}

export function statistics(values) {
  const ordered = [...values].sort((a,b) => a-b);
  const mid = Math.floor(ordered.length / 2);
  return { median: ordered.length % 2 ? ordered[mid] : (ordered[mid-1] + ordered[mid]) / 2, min: ordered[0], max: ordered.at(-1), runs: values };
}

function installOpenProbe() {
  globalThis.imageOpenProbe = async (id, expected) => {
    const wait = async predicate => {
      const deadline = performance.now() + 15000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(`Open timeout: ${id}, images=${document.querySelectorAll('#messages .msg-images img').length}`);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    };
    document.querySelector('[data-tab="sessions"]').click();
    await wait(() => document.querySelector(`.session-card[data-id="${id}"]`));
    const start = performance.now();
    globalThis.__imageOpenSequence = (globalThis.__imageOpenSequence || 0) + 1;
    document.querySelector(`.session-card[data-id="${id}"]`).click();
    const images = () => [...document.querySelectorAll('#messages .msg-images img')];
    await wait(() => images().length === expected && images().every(img => img.complete && img.naturalWidth > 0));
    await Promise.all(images().map(img => img.decode()));
    if (images().length !== expected) throw new Error("Transcript changed during image decode");
    return { id, images: images().length, decoded: true, elapsedMs: performance.now() - start };
  };
}

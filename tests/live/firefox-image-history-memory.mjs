// Synthetic Firefox persistence proxy: no provider, network pages, or user Sessions.
// Build with --no-bundle so the probe imports the same repository/Agent modules as
// the running extension. Probe entry files are installed only in the test package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { openFirefoxSidebar } from "../firefox/launch.mjs";
import { openFromSwitcher } from "../firefox/driver.mjs";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
const { values } = parseArgs({ options: {
  turns: { type: "string", default: "60" }, interval: { type: "string", default: "1000" },
  output: { type: "string", default: "tests/results/firefox-image-history-memory.json" },
} });
const output = resolve(values.output), turns = Number(values.turns), interval = Number(values.interval);
const extensionDir = resolve(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR || "dist/extension-firefox");
await readFile(join(extensionDir, "background/session/repository.js"));
await mkdir(resolve(output, ".."), { recursive: true });
const probes = [
  [installBackgroundProbe, "background/image-memory-probe.js"],
  [installSidebarProbe, "sidepanel/image-memory-probe.js"],
];
for (const [install, target] of probes) await writeFile(join(extensionDir, target), `(${install.toString()})();\n`);
let sidebar, profile, timer;
const report = { extensionDir, turns, intervalMs: interval, samples: [], turnsCompleted: [], verification: {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function poll(operation, predicate = Boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await operation(); if (predicate(last)) return last; } catch (error) { last = String(error); }
    await sleep(200);
  }
  throw new Error(`Firefox proxy poll timed out: ${JSON.stringify(last)}`);
}

async function loadProbe(target) {
  const name = target === "background" ? "imageMemoryProbe" : "imageMemorySidebarProbe";
  await poll(() => sidebar.extension(target, `
    if (!view.${name}) {
      const script = view.document.createElement("script");
      script.type = "module"; script.src = view.chrome.runtime.getURL(${JSON.stringify(`${target === "background" ? "background" : "sidepanel"}/image-memory-probe.js`)});
      view.document.documentElement.appendChild(script);
    }
    return true;
  `));
  await poll(() => sidebar.extension(target, `return !!view.${name};`));
}

function sample(rootPid, turn) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,comm=,args="], { encoding: "utf8" }).trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { pid: +match[1], ppid: +match[2], rssKiB: +match[3], comm: match[4], args: match[5] } : null;
  }).filter(Boolean);
  const descendants = new Set([rootPid]);
  let changed;
  do { changed = false; for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } } while (changed);
  const own = rows.filter(row => descendants.has(row.pid));
  const buckets = { parent: 0, webextensions: 0, content: 0, other: 0 };
  for (const row of own) {
    const type = row.pid === rootPid ? "parent" : /WebExtensions/i.test(`${row.comm} ${row.args}`) ? "webextensions"
      : /-isForBrowser/.test(row.args) ? "content" : "other";
    buckets[type] += row.rssKiB;
  }
  return { at: new Date().toISOString(), turn, buckets, rows: own };
}

function summarize(samples) {
  return Object.fromEntries(["parent", "webextensions", "content"].map(bucket => {
    const first = samples[0], last = samples.at(-1);
    const minutes = (Date.parse(last.at) - Date.parse(first.at)) / 60000;
    return [bucket, { startKiB: first.buckets[bucket], peakKiB: Math.max(...samples.map(s => s.buckets[bucket])),
      endKiB: last.buckets[bucket], slopeKiBPerMinute: (last.buckets[bucket] - first.buckets[bucket]) / minutes }];
  }));
}

async function selectSession() {
  await openFromSwitcher(sidebar);
  await poll(() => sidebar.extension("sidebar", `
    const tab = view.document.querySelector('[data-tab="sessions"]');
    if (tab) tab.click();
    return !!view.document.querySelector('.session-card[data-id="firefox-image-memory-proxy"]');
  `));
  await sidebar.extension("sidebar", `view.document.querySelector('.session-card[data-id="firefox-image-memory-proxy"]').click(); return true;`);
  return poll(() => sidebar.extension("sidebar", `return view.document.querySelectorAll('#messages .msg-images img').length;`), count => count === turns, 60000);
}

try {
  sidebar = await openFirefoxSidebar({ extensionDir });
  report.firefox = sidebar.browserVersion;
  profile = await sidebar.chrome('return Services.dirsvc.get("ProfD", Ci.nsIFile).path;');
  const rootPid = await sidebar.chrome("return Services.appinfo.processID;");
  await loadProbe("background");
  await sidebar.extension("background", "return await view.imageMemoryProbe.initialize();");
  await sleep(1500);
  let currentTurn = 0;
  const take = () => report.samples.push(sample(rootPid, currentTurn));
  take();
  timer = setInterval(take, 250);
  for (let turn = 1; turn <= turns; turn++) {
    const start = Date.now();
    const result = await sidebar.extension("background", `return await view.imageMemoryProbe.turn(${turn});`);
    currentTurn = turn;
    report.turnsCompleted.push({ ...result, elapsedMs: Date.now() - start });
    await sleep(Math.max(0, interval - (Date.now() - start)));
    if (turn % 10 === 0) {
      take(); console.log(JSON.stringify({ turn, rss: report.samples.at(-1).buckets }));
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
  }
  console.log("PHASE finish");
  report.activeRss = summarize(report.samples);
  await sidebar.extension("background", "return await view.imageMemoryProbe.finish();");
  await sleep(5000);
  clearInterval(timer); timer = null;
  take();
  report.rss = summarize(report.samples);
  // All verification happens after RSS sampling so DOM/export allocations do
  // not contaminate the persistence-only comparison.
  console.log("PHASE persistence_complete", JSON.stringify(report.rss));
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log("PHASE select_before_reload");
  report.verification.beforeReloadImages = await selectSession();
  console.log("PHASE reload_extension");
  await sidebar.chrome(`
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID(${JSON.stringify(sidebar.geckoId)});
    await addon.reload(); return true;
  `);
  console.log("PHASE restore_agent");
  await loadProbe("background");
  report.verification.agent = await sidebar.extension("background", "return await view.imageMemoryProbe.restore();");
  assert.deepEqual(report.verification.agent, { images: turns, identical: true, inline: true });
  console.log("PHASE select_after_reload");
  report.verification.afterReloadImages = await selectSession();
  console.log("PHASE export");
  await loadProbe("sidebar");
  report.verification.export = await sidebar.extension("sidebar", "return await view.imageMemorySidebarProbe.export();");
  assert.equal(report.verification.export.images, turns);
  assert.equal(report.verification.export.conversationImages, turns);
  assert.equal(report.verification.export.inline, true);
  assert.equal(report.verification.export.hasHistoryReferences, false);
  report.ok = true;
  console.log("FIREFOX_IMAGE_MEMORY", JSON.stringify({ rss: report.rss, verification: report.verification }));
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  clearInterval(timer);
  if (report.samples.length && !report.rss) report.rss = summarize(report.samples);
  await sidebar?.close().catch(() => {});
  if (profile?.startsWith(resolve(process.env.TMPDIR || "/tmp")) && profile.includes("qz-firefox-playwright-")) await rm(profile, { recursive: true, force: true });
  for (const [, target] of probes) await rm(join(extensionDir, target), { force: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}

}

// Serialized into temporary modules in the test package, never application source.
// Keep these functions self-contained: imports resolve relative to those modules.
export async function installBackgroundProbe(dependencies) {
  const { Agent, getSessionRepository, createSessionRecord, bytesToBase64 } = dependencies || {
    ...await import("./agent/agent.js"), ...await import("./session/repository.js"),
    ...await import("../shared/session/session-codec.js"), ...await import("../shared/bytes.js"),
  };
  let id = "firefox-image-memory-proxy";
  const repository = getSessionRepository();
  let lease = { sessionId: id, isActive: () => true };
  const history = [], empty = [], hashes = [];
  let agent;
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");
  globalThis.imageMemoryProbe = {
    async initialize(sessionId = "firefox-image-memory-proxy") {
      id = sessionId;
      lease = { sessionId: id, isActive: () => true };
      history.length = hashes.length = 0;
      await chrome.storage.local.set({ qz_data_consent: { version: 1, acceptedAt: Date.now() }, _qingzhou_mcp_bridge: { enabled: false } });
      await repository.createMetadata({ id, title: "Image memory proxy" });
      agent = new Agent(id, { conversationRepository: repository, conversationLease: lease });
      return { id };
    },
    async turn(turn) {
      const canvas = typeof document === "undefined" ? new OffscreenCanvas(384, 256) : document.createElement("canvas");
      canvas.width = 384; canvas.height = 256;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = turn + 1;
      for (let index = 0; index < pixels.data.length; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[index] = index % 4 === 3 ? 255 : seed >>> 24;
      }
      ctx.putImageData(pixels, 0, 0);
      const dataUrl = canvas.toDataURL ? canvas.toDataURL("image/png")
        : `data:image/png;base64,${bytesToBase64(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()))}`;
      canvas.width = canvas.height = 1;
      hashes.push(await hash(dataUrl));
      agent.messages.push({ role: "user", clientMessageId: `image-${turn}`, content: [
        { type: "text", text: `Image ${turn}` }, { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
      ] });
      history.push({ type: "user", clientMessageId: `image-${turn}`, text: `Image ${turn}`, images: [{ dataUrl, name: `image-${turn}` }] });
      // Real Agent persistence and current-transcript checkpoints. Fresh holders
      // emulate snapshots arriving through structured clone/Ports.
      await agent._persistConversation({ rethrow: true });
      await repository.writeTranscriptCheckpoint(id, { history: empty, current: structuredClone(history) }, lease);
      await chrome.storage.local.set({ _image_memory_expected: hashes });
      return { turn, dataUrlBytes: dataUrl.length };
    },
    async finish() {
      await repository.writeRecord(id, createSessionRecord(agent.exportSession(), history), lease);
      return { id, images: hashes.length };
    },
    async saveAs(targetId) {
      await repository.createMetadata({ id: targetId, title: targetId, firstMessage: history[0]?.text || "" });
      await repository.writeActiveConversation(targetId, agent.exportSession(), { sessionId: targetId, isActive: () => true });
      await repository.writeRecord(targetId, createSessionRecord(agent.exportSession(), history));
    },
    async restore() {
      const expected = (await chrome.storage.local.get("_image_memory_expected"))._image_memory_expected;
      agent = new Agent(id, { conversationRepository: repository, conversationLease: lease });
      await agent.hydrateFromStore();
      const urls = agent.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(part => part.type === "image_url").map(part => part.image_url.url);
      const actual = [];
      for (const url of urls) actual.push(await hash(url));
      return { images: urls.length, identical: JSON.stringify(actual) === JSON.stringify(expected), inline: urls.every(url => url.startsWith("data:image/")) };
    },
  };
}

export async function installSidebarProbe() {
  const { createSessionExportFeature } = await import("./features/export/session-export-feature.js");
  const { createPortTransport } = await import("../shared/transport/port-transport.js");
  window.imageMemorySidebarProbe = {
    async export() {
      const id = "firefox-image-memory-proxy";
      const port = chrome.runtime.connect({ name: "sidepanel" });
      let reply, reject;
      const result = new Promise((resolve, fail) => { reply = resolve; reject = fail; });
      const transport = createPortTransport({
        postMessage: message => port.postMessage(message),
        onMessage: message => {
          if (message.requestId !== "memory-export") return;
          if (message.type === "export_session_exchange_result") reply(message);
          else reject(new Error(JSON.stringify(message)));
        },
        onError: reject,
      });
      port.onMessage.addListener(message => transport.receive(message));
      const feature = createSessionExportFeature({
        request: async () => {
          await transport.send({ type: "export_session_exchange", sessionId: id, requestId: "memory-export" });
          return result;
        },
        renderChatHtml: () => document.querySelector("#messages").innerHTML,
      });
      try {
        const { html, payload } = await feature.createDocument(id);
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const images = [...parsed.querySelectorAll("#messages img")];
        return { htmlBytes: html.length, images: images.length,
          inline: images.every(img => img.getAttribute("src").startsWith("data:image/")),
          hasHistoryReferences: html.includes("qz-history-image:"),
          conversationImages: payload.session.conversation.entries.flatMap(entry => Array.isArray(entry.message.content) ? entry.message.content : [])
            .filter(part => part.type === "image_url" && part.image_url.url.startsWith("data:image/")).length };
      } finally { feature.dispose(); transport.dispose(); port.disconnect(); }
    },
  };
}

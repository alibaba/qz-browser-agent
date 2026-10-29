// Deterministic five-child Kyoto tool workload. No provider/API key.
// Reuses the five-Wikipedia-tab shape from origin/fix/ff-parallel-images-memory's
// firefox-kyoto-memory-repro.mjs, replacing model planning with explicit tool calls.
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installProbes, launchMeasurement, poll, rssSample, sleep, summarizeRss } from "./image-history-measurement.mjs";

const { values } = parseArgs({ options: {
  browser: { type: "string", default: "firefox" }, extension: { type: "string" },
  output: { type: "string", default: "tests/results/kyoto-image-tools.json" },
  rounds: { type: "string", default: "3" }, select: { type: "string", default: "6" },
  reads: { type: "string", default: "4" }, local: { type: "boolean", default: false },
  deadline: { type: "string", default: "600" }, rssCapMiB: { type: "string", default: "8000" },
} });
const browser = values.browser, extensionDir = resolve(values.extension), output = resolve(values.output), profile = output + ".profile";
await mkdir(dirname(output), { recursive: true });
await rm(profile, { recursive: true, force: true });
const uninstall = await installProbes(extensionDir);
const workerPath = join(extensionDir, "background/service-worker.js");
const baseWorker = await readFile(workerPath, "utf8");
await writeFile(join(extensionDir, "shared/measurement-heartbeat.js"), "setInterval(() => postMessage(Date.now()), 50);\n");
if (!baseWorker.includes("mcpRuntime =")) throw new Error("Build the extension with --no-bundle");
await writeFile(workerPath, baseWorker + `\n(${installToolProbe.toString()})({ mcpRuntime, sessionCommands, sessionAgentHost, sessionTranscript, sessionRepository, installLagProbe: ${installLagProbe.toString()} });\n`);
const sights = ["Kinkaku-ji", "Fushimi_Inari-taisha", "Kiyomizu-dera", "Arashiyama", "Ginkaku-ji"];
let server, driver, timer, rssCapReached = false;
const report = { browser, extensionDir, workload: { rounds: Number(values.rounds), select: Number(values.select), reads: Number(values.reads), rssCapMiB: Number(values.rssCapMiB) }, scenario: values.local ? "local-24x2560x1920" : "kyoto-wikipedia", samples: [], polls: [], freeze: false,
  freezeCriterion: "background poll >=5s, background/sidebar event-queue delay >=5s, page worker-delivery delay >=5s, or workload deadline" };
try {
  let urls = sights.map(sight => `https://en.wikipedia.org/wiki/${sight}`);
  if (values.local) {
    const images = Array.from({ length: 24 }, (_, seed) => stressPng(seed));
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/image.png") { response.writeHead(200, { "content-type": "image/png" }); response.end(images[Number(url.searchParams.get("n")) % images.length]); }
      else { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><title>Kyoto image stress</title><style>img{width:640px;height:480px}figure{margin:16px}body{margin:0}</style><h1>High resolution image collection</h1>${images.map((_, n) => `<figure><img src="/image.png?n=${n}" alt="Stress image ${n}" width="2560" height="1920"><figcaption>Local high-resolution image ${n}</figcaption></figure>`).join("")}`); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    urls = sights.map((_, index) => `http://127.0.0.1:${server.address().port}/stress?site=${index}`);
  }
  report.urls = urls;
  driver = await launchMeasurement({ browser, extensionDir, profile }); report.version = driver.version;
  await driver.evaluate("background", "return await view.imageMemoryProbe.initialize();");
  await driver.openUI();
  await driver.evaluate("sidebar", "return await view.chrome.runtime.sendMessage({type:'accept_data_consent',version:1});");
  await driver.evaluate("background", `return await view.kyotoToolProbe.initialize();`);
  // Install the same timer/primitive instrumentation in the real sidebar realm.
  await writeFile(join(extensionDir, "sidepanel/kyoto-lag-probe.js"), `(${installLagProbe.toString()})("sidebar");`);
  await driver.evaluate("sidebar", `const s=view.document.createElement('script');s.type='module';s.src=view.chrome.runtime.getURL('sidepanel/kyoto-lag-probe.js');view.document.documentElement.appendChild(s);return true;`);
  await poll(() => driver.evaluate("sidebar", "return !!view.__qzLagProbe;"));
  const take = () => {
    const sample = rssSample(browser, driver.rootPid, 0); report.samples.push(sample);
    if (Object.values(sample.buckets).reduce((sum, value) => sum + value, 0) > Number(values.rssCapMiB) * 1024) rssCapReached = true;
  };
  take(); timer = setInterval(take, 250);
  const start = Date.now();
  await driver.evaluate("background", `view.kyotoToolProbe.start(view.JSON.parse(${JSON.stringify(JSON.stringify({ urls, rounds: Number(values.rounds), select: Number(values.select), reads: Number(values.reads) }))})); return true;`);
  while (Date.now() - start < Number(values.deadline) * 1000) {
    const polledAt = Date.now();
    let state;
    try { state = await driver.evaluate("background", "return view.kyotoToolProbe.snapshot();"); }
    catch (error) { report.polls.push({ at: polledAt, error: String(error), elapsedMs: Date.now() - polledAt }); report.freeze = true; break; }
    report.polls.push({ at: polledAt, elapsedMs: Date.now() - polledAt, stages: state.children.map(child => child.stage), events: state.events.length });
    if (Date.now() - polledAt >= 5000) report.freeze = true;
    report.state = state;
    if (rssCapReached && !state.done) {
      report.stopReason = `owned_browser_rss_cap_${values.rssCapMiB}MiB`;
      await driver.evaluate("background", "view.kyotoToolProbe.cancel(); return true;");
    }
    if (state.done) break;
    if (report.polls.length % 5 === 0) {
      console.log(JSON.stringify({ elapsedMs: Date.now() - start, stages: report.polls.at(-1).stages, events: state.events.length }));
      await writeFile(output, JSON.stringify(report, null, 2));
    }
    await sleep(1000);
  }
  report.elapsedMs = Date.now() - start;
  if (!report.state?.done) { report.freeze = true; report.stopReason = "deadline_or_unresponsive_background"; }
  report.sidebar = await driver.evaluate("sidebar", "return view.__qzLagProbe.snapshot();").catch(error => ({ error: String(error) }));
  report.background = await driver.evaluate("background", "return view.__qzLagProbe.snapshot();").catch(error => ({ error: String(error) }));
  report.pages = await driver.evaluate("background", "return await view.kyotoToolProbe.pageMetrics();").catch(error => ({ error: String(error) }));
  const activeLag = metrics => metrics?.workerHeartbeat?.available ? metrics.workerHeartbeat.maxDeliveryLagMs : metrics?.maxLagMs || 0;
  if (Math.max(activeLag(report.background), activeLag(report.sidebar), ...(Array.isArray(report.pages) ? report.pages.flatMap(page => (page.result || []).map(frame => frame.result?.workerHeartbeat?.maxDeliveryLagMs || 0)) : [0])) >= 5000) report.freeze = true;
  report.collectionFailedCalls = report.state?.events.filter(event => event.name === "collect_images" && (event.error || event.failures?.length)).length || 0;
  report.ok = !!report.state?.done && !report.state.error && !report.state.cancelled && !report.collectionFailedCalls && report.state.children.length === 5
    && report.state.children.every(child => child.collected > 0 && child.readImages > 0 && child.screenshots > 0);
  if (!report.ok) process.exitCode = 1;
  console.log("KYOTO_TOOLS", JSON.stringify({ ok: report.ok, freeze: report.freeze, elapsedMs: report.elapsedMs, children: report.state?.children,
    backgroundLag: report.background?.maxLagMs, sidebarLag: report.sidebar?.maxLagMs, pages: report.pages }));
} catch (error) { report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; }
finally {
  clearInterval(timer);
  if (report.samples.length) report.rss = summarizeRss(report.samples);
  await driver?.close().catch(() => {});
  await uninstall(); await rm(join(extensionDir, "sidepanel/kyoto-lag-probe.js"), { force: true });
  await rm(join(extensionDir, "shared/measurement-heartbeat.js"), { force: true });
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}

function installToolProbe({ mcpRuntime, sessionCommands, sessionAgentHost, sessionTranscript, sessionRepository, installLagProbe }) {
  installLagProbe("background");
  const state = { done: false, events: [], children: [] };
  const controller = new AbortController();
  async function call(child, name, args) {
    child.stage = name;
    const start = performance.now(), toolCallId = crypto.randomUUID();
    performance.mark(`qz-probe:${child.index}:${name}:start`);
    let result;
    try {
      result = (await mcpRuntime.executeTool({ sessionId: child.id, runId: child.runId, name, args }, controller.signal)).result;
      const toolMs = performance.now() - start;
      const agent = await sessionAgentHost.getAgent(child.id);
      agent.messages.push({ role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      agent.messages.push(...agent._buildToolResultMessages(toolCallId, result, !!result?.error, name));
      await agent._emit({ type: "tool_execution_end", runId: child.runId, toolCallId, toolName: name, args, result, isError: !!result?.error });
      await agent._persistConversation({ rethrow: true });
      await sessionCommands.saveSessionRecordRuntime({ sessionId: child.id, conversation: agent.exportSession() });
      state.events.push({ child: child.index, name, start, toolMs, persistMs: performance.now() - start - toolMs,
        imageBytes: result?._image?.length || 0, method: result?.method, collected: result?.collected, count: result?.count,
        error: result?.error, code: result?.code, failures: result?.failures });
      return result;
    } catch (error) {
      state.events.push({ child: child.index, name, start, toolMs: performance.now() - start, error: String(error), code: error?.code });
      return { error: String(error), code: error?.code };
    } finally { performance.mark(`qz-probe:${child.index}:${name}:end`); }
  }
  globalThis.kyotoToolProbe = {
    async initialize() {
      const stored = (await chrome.storage.local.get("llmConfig")).llmConfig || {};
      await chrome.storage.local.set({ llmConfig: { ...stored, provider: "openai", model: "gpt-4o", vision: true, toolCalling: true, apiKey: "" } });
      return true;
    },
    start({ urls, rounds, select, reads }) {
      void (async () => {
        const root = (await sessionCommands.createSessionFromApi({ title: "Kyoto parallel image measurement" })).session;
        state.rootId = root.id;
        await Promise.all(urls.map(async (url, index) => {
          const session = (await sessionCommands.createSessionFromApi({ title: `Kyoto ${index}`, parentSessionId: root.id })).session;
          const child = { id: session.id, runId: crypto.randomUUID(), index, url, stage: "open_tab", collected: 0, readImages: 0, screenshots: 0 };
          state.children.push(child);
          // Admit the scripted run through the real Agent event/supervisor path;
          // do not bypass tab ownership or CDP run-authority checks.
          const agent = await sessionAgentHost.getAgent(child.id);
          agent._currentRunId = child.runId;
          await agent._emit({ type: "agent_start", runId: child.runId });
          const opened = await call(child, "open_tab", { url });
          child.tabId = opened.id;
          if (!child.tabId) { child.stage = "navigation_failed"; return; }
          for (const world of ["ISOLATED", "MAIN"]) await chrome.scripting.executeScript({ target: { tabId: child.tabId }, world, func: installLagProbe, args: ["page"] });
          child.stage = "page_ready";
          const readyStart = performance.now();
          child.load = await chrome.scripting.executeScript({ target: { tabId: child.tabId }, world: "MAIN", func: async () => {
            const deadline = Date.now() + 30000;
            // Waiting for window.load inside executeScript can itself delay load
            // in Chromium. Wait only for existing eager images; leave lazy images alone.
            while ((document.readyState === "loading" || [...document.images].some(image => image.loading !== "lazy" && !image.complete)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
            return { ready: document.readyState, images: document.images.length, loaded: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length };
          } });
          state.events.push({ child: index, name: "page_ready", start: readyStart, toolMs: performance.now() - readyStart });
          for (let round = 0; round < rounds && !controller.signal.aborted; round++) {
            const listing = await call(child, "list_images", { tabId: child.tabId, selector: url.includes("wikipedia.org") ? "#mw-content-text" : "", visibleOnly: false, minWidth: 200, minHeight: 120, limit: 100 });
            const candidates = (listing.images || []).filter(image => image.complete && image.naturalWidth > 0).slice(0, select);
            child.available = candidates.length;
            for (const image of candidates.slice(0, reads)) {
              const result = await call(child, "read_image", { tabId: child.tabId, target: image.target });
              if (result._image) child.readImages++;
            }
            if (candidates.length) {
              const result = await call(child, "collect_images", { table: `Kyoto ${index}`, targets: candidates.map(image => image.target) });
              child.collected += result.collected || 0;
            }
            const shot = await call(child, "screenshot", { tabId: child.tabId, format: "png", destination: `Kyoto ${index}` });
            if (shot._image) child.screenshots++;
          }
          child.pageMetrics = await readPageMetrics(child);
          await agent._emit({ type: "agent_end", runId: child.runId });
          child.stage = "done";
        }));
      })().catch(error => { state.error = String(error) + "\n" + (error.stack || ""); }).finally(() => { state.done = true; });
    },
    cancel: () => { state.cancelled = true; controller.abort(); },
    snapshot: () => state,
    async pageMetrics() {
      return Promise.all(state.children.filter(child => child.tabId).map(child => child.pageMetrics || readPageMetrics(child)));
    },
  };
  async function readPageMetrics(child) {
    try { return { child: child.index, tabId: child.tabId,
      result: await chrome.scripting.executeScript({ target: { tabId: child.tabId }, world: "MAIN", func: () => globalThis.__qzLagProbe?.snapshot() }),
      isolated: await chrome.scripting.executeScript({ target: { tabId: child.tabId }, world: "ISOLATED", func: () => globalThis.__qzLagProbe?.snapshot() }),
    }; } catch (error) { return { child: child.index, error: String(error) }; }
  }
}

function installLagProbe(realm) {
  if (globalThis.__qzLagProbe) return;
  const state = { realm, maxLagMs: 0, samples: 0, stalls: [], primitives: {}, longTasks: [], visibility: typeof document === "undefined" ? "worker" : document.visibilityState };
  // Delivery delay measures the main event queue without treating background-tab
  // timer throttling as a long task. Worker timestamps are generated at send time.
  if (typeof Worker === "function") {
    const heartbeat = state.workerHeartbeat = { available: false, samples: 0, maxDeliveryLagMs: 0 };
    try {
      const url = realm === "page" ? URL.createObjectURL(new Blob(["setInterval(() => postMessage(Date.now()), 50);"], { type: "text/javascript" }))
        : chrome.runtime.getURL("shared/measurement-heartbeat.js");
      const worker = new Worker(url);
      worker.onmessage = event => { heartbeat.available = true; heartbeat.samples++; heartbeat.maxDeliveryLagMs = Math.max(heartbeat.maxDeliveryLagMs, Date.now() - event.data); };
      worker.onerror = event => { heartbeat.error = event.message || "worker blocked"; };
    } catch (error) { heartbeat.error = String(error); }
  }
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), lag = Math.max(0, now - last - 50); last = now;
    state.samples++; state.maxLagMs = Math.max(state.maxLagMs, lag);
    if (lag > 50 && state.stalls.length < 1000) state.stalls.push({ at: now, lagMs: lag, visibility: typeof document === "undefined" ? "worker" : document.visibilityState });
  }, 50);
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
    new PerformanceObserver(list => { for (const entry of list.getEntries()) if (state.longTasks.length < 1000) state.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true });
  }
  const wrap = (target, key, label) => {
    if (typeof target?.[key] !== "function") return;
    const original = target[key];
    target[key] = function (...args) {
      const start = performance.now();
      const stats = state.primitives[label] ||= { count: 0, syncMaxMs: 0, totalMs: 0, asyncMaxMs: 0 };
      stats.count++;
      const result = original.apply(this, args);
      const elapsed = performance.now() - start; stats.syncMaxMs = Math.max(stats.syncMaxMs, elapsed); stats.totalMs += elapsed;
      if (result?.then) result.then(() => { stats.asyncMaxMs = Math.max(stats.asyncMaxMs, performance.now() - start); }, () => {});
      return result;
    };
  };
  wrap(globalThis, "createImageBitmap", "createImageBitmap");
  wrap(globalThis, "btoa", "btoa");
  wrap(globalThis.OffscreenCanvas?.prototype, "convertToBlob", "convertToBlob");
  wrap(globalThis.OffscreenCanvasRenderingContext2D?.prototype, "drawImage", "drawImage");
  wrap(globalThis.HTMLCanvasElement?.prototype, "toDataURL", "toDataURL");
  wrap(globalThis.CanvasRenderingContext2D?.prototype, "getImageData", "getImageData");
  globalThis.__qzLagProbe = { snapshot: () => state };
}

function stressPng(seed) {
  const width = 2560, height = 1920, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * (width * 3 + 1) + 1 + x * 3;
    raw[p] = (x * 17 + y * 13 + seed * 23) & 255;
    raw[p+1] = (x * 3 + y * 7 + seed * 41) & 255;
    raw[p+2] = ((x ^ y) * 11 + seed * 31) & 255;
  }
  const crc = data => { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, check]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

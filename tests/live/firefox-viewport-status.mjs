import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openFirefoxSidebar } from "../firefox/launch.mjs";
import { openFromToolbar, setSidebarWidth } from "../firefox/driver.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { startBridge } from "../../services/mcp-bridge/src/server.mjs";
import { runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { readHealth } from "../../services/mcp-bridge/src/client.mjs";

// Explicit real-provider tests. Only the temporary sidebar receives the event probe.
const apiKey = readTestApiKey("deepseek", { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || "" });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const source = process.env.QINGZHOU_FIREFOX_EXTENSION_DIR;
assert.ok(source, "Build Firefox first and set QINGZHOU_FIREFOX_EXTENSION_DIR");
const output = resolve(process.env.QINGZHOU_LIVE_REPORT || "tests/results/firefox-viewport-status.json");
await mkdir(dirname(output), { recursive: true });
const work = await mkdtemp(join(tmpdir(), "qz-firefox-live-"));
const extensionDir = join(work, "extension");
const report = { ok: false, model, scenarios: {}, requests: [], transport: "Real DeepSeek through a test-only loopback forwarder; original request payloads and upstream SSE chunks preserved." };
let session, bridge, gate, slowResponse;
const codes = Array.from({ length: 4 }, () => randomBytes(5).toString("hex"));
const article = index => `<!doctype html><title>Product ${index}</title><article><h1>Product ${index}</h1><p>Verification code: ${codes[index]}</p>${"<p>Product information for the live reading fixture.</p>".repeat(100)}</article>`;
let slowRequested;
const slowArrival = new Promise(resolve => { slowRequested = resolve; });
const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/deepseek") {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = Buffer.concat(chunks), body = JSON.parse(payload);
      if (gate?.predicate(body)) {
        const held = gate; gate = null; held.entered(); await held.released;
      }
      const upstream = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: payload, signal: AbortSignal.timeout(120000),
      });
      const evidence = { status: upstream.status, model: body.model, chunks: 0 };
      report.requests.push(evidence);
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      for await (const chunk of upstream.body) { evidence.chunks += 1; response.write(chunk); }
      response.end();
    } catch (error) {
      report.transportError = String(error);
      if (!response.headersSent) response.writeHead(502);
      response.end("Live provider forwarding failed");
    }
    return;
  }
  if (request.url === "/slow") { slowResponse = response; slowRequested(); return; }
  const index = Number(/^\/item\/(\d+)$/.exec(request.url)?.[1]);
  response.writeHead(Number.isInteger(index) && index >= 1 && index <= 3 ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  response.end(index >= 1 && index <= 3 ? article(index) : "Not found");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const scrub = value => JSON.stringify(value, null, 2).split(apiKey).join("[redacted]");
const save = () => writeFile(output, scrub(report));
const sidebar = expression => session.extension("sidebar", expression);
const call = (method, ...args) => sidebar(`return await view.__qzFirefoxLive[${JSON.stringify(method)}](...view.JSON.parse(${JSON.stringify(JSON.stringify(args))}));`);
const finish = async task => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await call("finished", task)) return call("done", task);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Firefox live task did not finish");
};
const pauseModel = predicate => {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  gate = { predicate, entered, released, release };
  return { reached, release };
};

try {
  await cp(source, extensionDir, { recursive: true });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts.unshift("background/live-network.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(extensionDir, "background/live-network.js"), `(${installNetworkForwarder.toString()})(${JSON.stringify(`${origin}/deepseek`)});`);
  await writeFile(join(extensionDir, "sidepanel/live-test-hook.js"), `(${installSidebarProbe.toString()})();`);
  const html = join(extensionDir, "sidepanel/sidepanel.html");
  await writeFile(html, (await readFile(html, "utf8")).replace("</head>", '<script src="./live-test-hook.js"></script></head>'));
  session = await openFirefoxSidebar({ extensionDir, profile: join(work, "profile") });
  report.browser = session.browserVersion;
  report.version = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8")).version;
  await openFromToolbar(session);
  await setSidebarWidth(session, 400);
  await sidebar(`
    const start=Date.now();
    while(Date.now()-start<12000) {
      content.document.querySelector('[data-consent-accept]')?.click();
      const app=content.document.querySelector('#app');
      if(view.__qzFirefoxLive && app && !app.hasAttribute('data-workspace-booting') && !app.hasAttribute('data-consent-pending')) return true;
      await new Promise(resolve=>content.setTimeout(resolve,100));
    }
    throw new Error('Firefox sidebar did not become ready');
  `);
  await call("request", "save_config", { config: { provider: "deepseek", apiKey, model, vision: false, contextWindow: 128000, trimOldToolResults: true } }, "config_saved");

  const slowGate = pauseModel(body => body.messages?.some(message => message.role === "tool" && String(message.content).includes('"incomplete"')));
  try {
    const task = await call("start", `先只用 open_tab 打开 ${origin}/slow，设置 timeout=1。即使超时也继续，下一轮用 read_article 读取同一个标签页，输出商品校验码。不要重复新开标签。`);
    await Promise.race([slowArrival, finish(task).then(() => { throw new Error("Slow page was never requested"); })]);
    const loadingEvents = await call("events", task.after);
    assert.ok(loadingEvents.some(event => event.type === "tool_execution_start" && event.toolName === "open_tab"));
    assert.equal(loadingEvents.some(event => event.type === "tool_execution_end"), false);
    await Promise.race([slowGate.reached, finish(task).then(() => { throw new Error("No partial timeout result reached the model"); })]);
    const indicator = await sidebar(`
      await new Promise(resolve=>content.requestAnimationFrame(resolve));
      const dot=content.document.querySelector('#messages .dot.incomplete');
      if(!dot) return {found:false, text:content.document.querySelector('#messages').textContent};
      const style=content.getComputedStyle(dot);
      return {found:true,title:dot.title,background:style.backgroundColor,border:style.borderTopStyle,animation:style.animationName};
    `);
    assert.equal(indicator.found, true, JSON.stringify(indicator));
    assert.match(indicator.title, /incomplete|不完整/i);
    assert.equal(indicator.background, "rgba(0, 0, 0, 0)");
    assert.equal(indicator.animation, "none");
    slowResponse.writeHead(200, { "content-type": "text/html; charset=utf-8" }); slowResponse.end(article(0));
    slowGate.release();
    const done = await finish(task);
    assert.ok(done.answer.includes(codes[0]), done.answer);
    assert.equal(done.events.filter(event => event.type === "tool_execution_start" && event.toolName === "open_tab").length, 1);
    report.scenarios.timeoutRecovery = { sessionId: task.sessionId, startBeforeCompletion: true, indicator, ...done };
    await save(); console.log("PASS Firefox live timeout result, indicator, and same-tab recovery");
  } finally { slowGate.release(); }

  const readingGate = pauseModel(body => codes.slice(1).every(code => body.messages?.some(message => message.role === "tool" && String(message.content).includes(code))));
  try {
    const task = await call("start", `打开并读取 ${origin}/item/1、/item/2、/item/3，列出三个商品及校验码。不需要过程说明。`);
    await Promise.race([readingGate.reached, finish(task).then(() => { throw new Error("The model did not read all three pages"); })]);
    const measurements = await sidebar(`
      const doc=content.document, messages=doc.querySelector('#messages');
      const frame=()=>new Promise(resolve=>content.requestAnimationFrame(resolve));
      const settle=async()=>{for(let i=0;i<20;i++)await frame();};
      const card=messages.querySelector('.msg-tool-timeline');
      if(!card) throw new Error('No real tool timeline');
      const summary=card.querySelector(':scope > .tool-summary');
      const results=[];
      for(const footer of [false,true,false,true]) {
        summary.click(); await settle();
        const tools=Cu.waiveXrays(card).__toolTimelineGroupEntry.entries.filter(entry=>entry.type==='tool');
        const index=tools.findIndex(entry=>entry.name==='read_article' && entry.result?.text);
        const choice=card.querySelector('[data-tool-timeline-index="'+index+'"]');
        choice?.click(); await settle();
        messages.dispatchEvent(new content.WheelEvent('wheel',{deltaY:500,bubbles:true}));
        messages.scrollTop=messages.scrollHeight; await settle();
        const before={scrollTop:messages.scrollTop,summaryTop:summary.getBoundingClientRect().top-messages.getBoundingClientRect().top};
        (footer?card.querySelector('.tool-timeline-collapse-btn'):summary).click();
        const samples=[];
        for(let i=0;i<24;i++) {
          await frame(); const viewport=messages.getBoundingClientRect();
          samples.push({scrollTop:messages.scrollTop,overflow:messages.scrollHeight-messages.clientHeight,
            userTop:messages.querySelector('.msg-user').getBoundingClientRect().top-viewport.top,
            afterSpace:content.getComputedStyle(messages).getPropertyValue('--viewport-anchor-after-space')});
        }
        results.push({footer,before,samples});
      }
      return results;
    `);
    for (const interaction of measurements) {
      assert.ok(interaction.before.scrollTop > 20, JSON.stringify(interaction.before));
      for (const sample of interaction.samples) {
        assert.ok(Math.abs(sample.scrollTop) < 1 && sample.overflow <= 1 && sample.userTop >= 0, JSON.stringify(sample));
        assert.equal(sample.afterSpace.trim(), "0px");
      }
    }
    readingGate.release();
    const done = await finish(task);
    for (const code of codes.slice(1)) assert.ok(done.answer.includes(code), done.answer);
    report.scenarios.runningCollapse = { sessionId: task.sessionId, interactions: measurements, ...done };
    await save(); console.log("PASS Firefox live reading, repeated summary/footer collapse, and continuation");
  } finally { readingGate.release(); }

  bridge = await startBridge({ port: 0 });
  const paired = await call("request", "mcp_connection_connect", { name: "firefox-live", endpoint: bridge.endpoint }, "mcp_connection_connect_result");
  assert.equal(paired.result.state, "connected", JSON.stringify(paired));
  const tasks = await runCli(["tasks", "--client", "firefox-live", "--json"], { findDaemon: async () => ({ endpoint: bridge.endpoint, health: await readHealth(bridge.endpoint) }) });
  for (const scenario of Object.values(report.scenarios)) assert.ok(JSON.stringify(tasks).includes(scenario.sessionId));
  report.scenarios.cli = { connected: true, listedBothLiveTasks: true };
  assert.ok(report.requests.length >= 4, "Real DeepSeek requests must pass through the recorded transport");
  assert.ok(report.requests.some(request => request.chunks > 1), "The provider stream must arrive in multiple chunks");
  report.ok = true;
  console.log("PASS Firefox CLI pairing and actual CLI tasks command");
} catch (error) {
  report.error = String(error.stack || error);
  report.recentEvents = await call("events", 0).then(events => events.slice(-35)).catch(() => []);
  process.exitCode = 1;
} finally {
  gate?.release();
  await save();
  await session?.close();
  await bridge?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}

function installSidebarProbe() {
  const port = chrome.runtime.connect({ name: "sidepanel" });
  const events = [], waiters = new Set();
  let sequence = 0;
  const matches = (event, expected) => Object.entries(expected).every(([key, value]) => event[key] === value);
  port.onMessage.addListener(raw => {
    if (raw.type === "dynamic_context_request") port.postMessage({ type: "dynamic_context_response", requestId: raw.requestId, context: {} });
    const event = JSON.parse(JSON.stringify(raw, (key, value) => /api.?key|authorization|token|secret/i.test(key) ? "[redacted]" : value));
    events.push({ ...event, receivedAt: Date.now() });
    for (const waiter of [...waiters]) if (waiter.after < events.length && waiter.predicate(event)) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(event);
    }
  });
  function wait(predicate, after, timeout = 180000) {
    const found = events.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, after, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error("Live event timed out")); }, timeout) };
      waiters.add(waiter);
    });
  }
  async function request(type, payload, responseType) {
    const requestId = `firefox-live-${++sequence}`, after = events.length;
    port.postMessage({ type, ...payload, requestId });
    return wait(event => event.requestId === requestId && [responseType, "error", "request_failed"].includes(event.type)
      || event.type === responseType && payload.sessionId && event.sessionId === payload.sessionId, after, 30000);
  }
  globalThis.__qzFirefoxLive = {
    request, events: after => events.slice(after),
    finished: task => events.some(event => matches(event, { type: "agent_end", sessionId: task.sessionId, runId: task.runId })),
    async start(text) {
      document.querySelector("#btn-new").click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const input = document.querySelector("#input"), after = events.length;
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#btn-send").click();
      const event = await wait(event => event.type === "agent_start", after);
      return { sessionId: event.sessionId, runId: event.runId, after };
    },
    async done(task) {
      await wait(event => matches(event, { type: "agent_end", sessionId: task.sessionId, runId: task.runId }), task.after);
      const history = await request("get_history", { sessionId: task.sessionId }, "history");
      const assistant = [...(history.messages || [])].reverse().find(message => message.role === "assistant");
      const answer = typeof assistant?.content === "string" ? assistant.content : (assistant?.content || []).map(part => part.text || "").join("\n");
      return { answer, events: events.slice(task.after).filter(event => event.sessionId === task.sessionId) };
    },
  };
}

function installNetworkForwarder(endpoint) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.deepseek.com/") && url.endsWith("/chat/completions")) {
      return nativeFetch(input instanceof Request ? new Request(endpoint, input) : endpoint, options);
    }
    return nativeFetch(input, options);
  };
}

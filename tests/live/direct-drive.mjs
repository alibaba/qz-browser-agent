import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";

// Explicit live entry: the external model plans every CLI call; Chrome has no model configured.
const { values } = parseArgs({ options: { output: { type: "string" } } });
const output = resolve(values.output || `tests/results/direct-drive/${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(output, { recursive: true });
const apiKey = readTestApiKey("deepseek");
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const temporary = await mkdtemp(join(tmpdir(), "qz-live-direct-"));
const redact = value => String(value).split(apiKey).join("[redacted]");
const save = (name, value) => writeFile(join(output, name), redact(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
const report = { ok: false, startedAt: new Date().toISOString(), model, output,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDiffSha256: createHash("sha256").update(execFileSync("git", ["diff", "HEAD", "--", "src"])).digest("hex"),
  environment: "Real external DeepSeek, real qz CLI subprocesses, isolated loaded Chromium, public Wikipedia. No built-in qz model.",
  turns: [], cli: [], observations: [], uiChecks: [], codedErrors: [], productDiagnostics: [], browserModelRequests: [], evidence: [] };
const persist = () => save("report.json", report);
const log = (phase, details = {}) => console.log(redact(JSON.stringify({ phase, ...details, output })));
const deadline = Date.now() + 600_000;
const remaining = () => { const ms = deadline - Date.now(); assert.ok(ms > 0, "The ten-minute live budget expired"); return ms; };
const secretVariable = /API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DEEPSEEK|(?:^|_)AK$/i;
async function withoutSecretEnvironment(work) {
  const hidden = Object.entries(process.env).filter(([name]) => secretVariable.test(name));
  for (const [name] of hidden) delete process.env[name];
  try { return await work(); } finally { for (const [name, value] of hidden) process.env[name] = value; }
}
const childEnv = { ...process.env, QZ_STATE_DIR: join(temporary, "service"), NO_COLOR: "1" };
for (const name of Object.keys(childEnv)) {
  if (secretVariable.test(name)
    || /^(?:NODE_OPTIONS|NODE_PATH|HTTPS?_PROXY|ALL_PROXY)$/i.test(name)) delete childEnv[name];
}
const originalLaunch = chromium.launchPersistentContext.bind(chromium);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxyUrl = proxy ? new URL(proxy) : null;
chromium.launchPersistentContext = (profile, options) => originalLaunch(profile, { ...options,
  viewport: { width: 1440, height: 960 },
  ...(proxyUrl ? { proxy: { server: `${proxyUrl.protocol}//${proxyUrl.host}`, bypass: "localhost,127.0.0.1",
    ...(proxyUrl.username ? { username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) } : {}) } } : {}),
});
const { launchIsolatedExtensionMcp, assertNoUnexpectedDiagnostics, PROJECT_ROOT } = await withoutSecretEnvironment(() => import("../support/isolated-extension-mcp.mjs"));
const skill = await readFile(new URL("../../skills/qz-browser-agent/SKILL.md", import.meta.url), "utf8");
const children = new Set(), sessions = new Set();
const targets = { find_elements: new Set(), list_images: new Set() };
const clicked = { find_elements: false, list_images: false };
const aliases = new Set();
let environment, sidebar, expectedCalls = 0, canceled = false, scriptBusiness, worker;
const heartbeat = setInterval(() => log("heartbeat", { turns: report.turns.length, cliCalls: report.cli.length, secondsLeft: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) }), 15_000);

async function snapshot() {
  return sidebar.evaluate(async () => {
    const { readSessionSnapshot } = await import('/shared/session/session-recovery.js');
    const metadata = (await chrome.storage.local.get("_sessions"))._sessions || {};
    const entries = Object.entries(metadata).filter(([, value]) => value.source === "external-drive");
    return Promise.all(entries.map(async ([id, meta]) => {
      const key = `_session_${id}`, checkpoint = `_session_transcript_checkpoint_${id}`;
      const stored = await chrome.storage.local.get([key, checkpoint]);
      return { id, title: meta.title, source: meta.source,
        tools: readSessionSnapshot(stored[key], null, stored[checkpoint]).transcript.filter(row => row.type === "tool") };
    }));
  });
}
async function checkUi() {
  const records = await snapshot();
  assert.equal(records.length, 1, "one drive task must remain one Session");
  const entry = records[0];
  report.transcript = entry.tools;
  report.failedCards = entry.tools.filter(tool => tool.isError);
  assert.ok(sessions.has(entry.id));
  await sidebar.locator('[data-tab="sessions"]').click();
  await sidebar.locator('[data-sessions-mode="external-drive"]').click();
  const rows = sidebar.locator('#sessions-list .session-card:not(.is-removing)');
  await expect(rows).toHaveCount(1);
  const row = sidebar.locator(`#sessions-list .session-card[data-id="${entry.id}"]:not(.is-removing)`);
  assert.equal((await row.locator('.session-card-title').textContent())?.trim(), entry.title);
  await row.click();
  const cards = sidebar.locator('#messages .msg-tool');
  await expect(cards).toHaveCount(entry.tools.length);
  const ids = await cards.evaluateAll(nodes => nodes.map(node => node.id));
  assert.equal(new Set(ids).size, ids.length, "no duplicate tool cards");
  assert.equal(new Set(entry.tools.map(tool => tool.toolCallId)).size, entry.tools.length, "no duplicate persisted calls");
  report.uiChecks.push({ afterCli: report.cli.length, sessionId: entry.id, title: entry.title,
    actualCalls: entry.tools.length, observedCalls: expectedCalls, failedCalls: report.failedCards.length,
    cards: ids.length, uniqueCards: new Set(ids).size });
  assert.equal(entry.tools.length, expectedCalls, "each actual drive call, including a failed one, has exactly one persisted card");
}
async function captureEvidence(label) {
  await sidebar.screenshot({ path: join(output, `${label}-sidebar.png`), fullPage: true });
  const pages = environment.context.pages().filter(page => /^https:\/\//.test(page.url()));
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const dom = await page.evaluate(() => ({ url: location.href, title: document.title,
      heading: document.querySelector('h1')?.textContent, searchValue: document.querySelector('input[name="search"]')?.value, text: document.body?.innerText.slice(0, 12000) }));
    await save(`${label}-page-${index}.json`, dom);
    await page.screenshot({ path: join(output, `${label}-page-${index}.png`), fullPage: false });
    report.evidence.push(dom);
  }
}
function observe(name, args, result) {
  report.observations.push({ name, args, result });
  if (['find_elements', 'list_images', 'act_on_element', 'read_dom', 'read_article', 'get_ax_tree', 'navigate',
    'inspect_element', 'scroll_page', 'screenshot', 'wait_for_navigation', 'wait_for_element'].includes(name)) {
    assert.equal(Object.hasOwn(result, 'tabRef'), false, 'ordinary page results do not echo tabRef');
  }
  if (name === "open_tab" && args.tabAlias) {
    assert.equal(result.tabRef, args.tabAlias, "open_tab echoes the caller alias"); aliases.add(args.tabAlias);
  }
  // These are UI events with host page metadata; exact public Tab keys are covered
  // by the deterministic CLI acceptance, which reads the returned business value.
  if (name === "open_tab") for (const key of ["active", "tabRef", "title", "url"]) assert.ok(Object.hasOwn(result, key));
  if (name === "list_tabs") for (const tab of result.tabs || []) assert.deepEqual(Object.keys(tab).sort(), ["active", "tabRef", "title", "url"]);
  if (name === "find_elements") for (const item of result.results || []) if (item.target) targets.find_elements.add(item.target);
  if (name === "list_images") for (const item of result.images || []) if (item.target) targets.list_images.add(item.target);
  if (name === 'act_on_element' && ['click', 'fill'].includes(args.action)) {
    (report.elementIdentities ||= []).push({ action: args.action, requested: args.target });
  }
  if (name === 'act_on_element' && args.action === 'fill' && args.target?.startsWith('css:') && args.value === 'Hangzhou') {
    report.cssFill = true;
  }
  if (name === "act_on_element" && args.action === "click") {
    for (const kind of Object.keys(targets)) if (targets[kind].has(args.target)) clicked[kind] = true;
  }
}
const liveEvents = () => sidebar.evaluate(() => globalThis.__qzLiveToolEvents || []);
const bridgeCalls = () => worker.evaluate(() => globalThis.__qzLiveBridgeCalls || []);
async function qz({ argv, stdin = "" }) {
  assert.ok(Array.isArray(argv) && argv.length && argv.every(value => typeof value === "string"), "qz.argv must be CLI argument strings");
  assert.equal(typeof stdin, "string");
  let parsed; try { parsed = parseCommand(argv); } catch { /* Let the real CLI produce the argument error. */ }
  const stopsTask = (parsed?.command === "tasks" && parsed.action === "stop")
    || (parsed?.command === "session" && parsed.action === "cancel");
  if (stopsTask && sessions.size) { await checkUi(); await captureEvidence("before-cancel"); }
  const before = sessions.size ? (await snapshot())[0]?.tools.length || 0 : 0;
  const beforeEvents = (await liveEvents()).length, beforeBridge = (await bridgeCalls()).length;
  const entry = { argv, stdin, startedAt: new Date().toISOString(), exitCode: null, stdout: "", stderr: "" };
  report.cli.push(entry); log("qz", { argv: argv.slice(0, 5), index: report.cli.length }); await persist();
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from './services/mcp-bridge/src/cli.mjs';
    import { readHealth } from './services/mcp-bridge/src/client.mjs';
    const endpoint = process.argv[1];
    process.exitCode = await main(process.argv.slice(2), {
      findDaemon: async () => ({ endpoint, health: await readHealth(endpoint) }),
    });
  `, "--", environment.bridge.endpoint, ...argv], { cwd: PROJECT_ROOT, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child); child.stdin.end(stdin);
  child.stdout.on("data", data => { entry.stdout += data; });
  child.stderr.on("data", data => { entry.stderr += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), Math.min(150_000, remaining()));
  try {
    await new Promise((resolvePromise, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => { entry.exitCode = code; entry.signal = signal; resolvePromise(); });
    });
  } finally { clearTimeout(timer); children.delete(child); }
  let value; try { value = JSON.parse(entry.stdout); } catch { /* Plain CLI help is useful model input too. */ }
  if (entry.exitCode !== 0) report.codedErrors.push({ argv, exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr });
  if (parsed?.command === 'script') {
    assert.deepEqual(Object.keys(value).sort(), ['ok', 'result', 'trace']);
    assert.equal(value.ok, entry.exitCode === 0, 'receipt status matches the CLI exit code');
    assert.ok(Array.isArray(value.trace) && value.trace.every(trace => typeof trace === 'string'), 'CLI traces are plain strings');
    entry.trace = value.trace;
    for (const trace of value.trace.filter(trace => trace.trim())) {
      assert.equal(entry.stderr.split(/\r?\n/).includes(trace), false, 'script traces are in stdout, not stderr');
    }
    value = value.result;
  }
  if (parsed?.command === "session" && parsed.action === "create" && entry.exitCode === 0) {
    const id = value?.result?.sessionId || entry.stdout.match(/^sessionId\s+(\S+)/m)?.[1];
    assert.ok(id); sessions.add(id); assert.equal(sessions.size, 1, "the model should create exactly one task Session");
    report.sessionId = id; report.title = value?.result?.title || parsed.options.title?.trim();
  }
  if (parsed?.command === 'script' && entry.exitCode === 0) {
    await expect.poll(async () => (await liveEvents()).slice(beforeEvents)
      .some(event => event.toolName === 'run_script' && sessions.has(event.sessionId)), { timeout: 10_000 }).toBe(true);
  }
  const after = sessions.size ? (await snapshot())[0]?.tools || [] : [];
  const delta = after.slice(before);
  const events = (await liveEvents()).slice(beforeEvents).filter(event => sessions.has(event.sessionId));
  const nested = (await bridgeCalls()).slice(beforeBridge).filter(call => sessions.has(call.sessionId) && call.name !== '__list_tools__');
  const eventIds = events.map(event => event.toolCallId);
  assert.equal(new Set(eventIds).size, eventIds.length, 'each actual completed invocation publishes one unique end event');
  assert.deepEqual(new Set(delta.map(row => row.toolCallId)), new Set(eventIds), 'all published tool calls persist once');
  // The passive message observer independently sees calls from the external script Worker.
  // Trigger descriptors execute in the host and are checked through their own end events.
  const unmatched = [...events];
  for (const call of nested) {
    const index = unmatched.findIndex(event => event.toolName === call.name && JSON.stringify(event.args) === JSON.stringify(call.args));
    assert.ok(index >= 0, `the nested ${call.name} invocation has its own completed tool event`); unmatched.splice(index, 1);
  }
  expectedCalls += events.length; entry.admittedCalls = events.length; entry.bridgeCalls = nested.length;
  entry.admissionEvidence = 'public tool end events, checked against passive script-bridge messages';
  for (const event of events) {
    if (event.isError) report.observations.push({ name: event.toolName, args: event.args || {}, result: event.result, isError: true });
    else observe(event.toolName, event.args || {}, event.result);
  }
  if (parsed?.command === 'script') {
    assert.ok(events.some(event => event.toolName === 'run_script'), 'an admitted outer script has one completed call');
    if (entry.exitCode === 0 && value && typeof value === 'object' && typeof value.title === 'string'
      && typeof value.url === 'string' && Object.hasOwn(value, 'searchValue')) scriptBusiness = value;
  }
  if (entry.exitCode !== 0) {
    entry.error = { code: value?.code, message: value?.message };
  }
  // Save the real failure and its transcript before any UI assertion can fail.
  if (sessions.size) report.transcript = after;
  await save("cli-transcript.json", report.cli); await persist();
  if (stopsTask && entry.exitCode === 0) {
    canceled = true; report.cancel = value;
    assert.doesNotMatch(entry.stdout, /tabId|workingTab/);
  }
  if (sessions.size) {
    await checkUi();
    if (entry.exitCode !== 0) {
      await save(`call-${report.cli.length}-failure.json`, { cli: entry, tools: delta });
      await sidebar.screenshot({ path: join(output, `call-${report.cli.length}-failure-sidebar.png`), fullPage: true });
    }
  }
  await persist();
  return { exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr };
}

try {
  log("launch", { model });
  environment = await withoutSecretEnvironment(() => launchIsolatedExtensionMcp({ profilePrefix: "qz-live-direct-", requestTimeoutSeconds: 150 }));
  environment.context.on("request", request => { if (new URL(request.url()).hostname === "api.deepseek.com") report.browserModelRequests.push(request.url()); });
  worker = environment.context.serviceWorkers()[0];
  const newControl = environment.context.waitForEvent("page");
  report.clearing = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({}); await chrome.tabs.remove(tabs.map(tab => tab.id));
    const remaining = await chrome.tabs.query({}); await chrome.windows.create({ url, focused: true });
    return { closed: tabs.length, remainingBeforeControl: remaining.length };
  }, `chrome-extension://${environment.extensionId}/sidepanel/sidepanel.html`);
  assert.equal(report.clearing.remainingBeforeControl, 0);
  sidebar = await newControl;
  sidebar.on("pageerror", error => report.productDiagnostics.push(error.message));
  sidebar.on("console", message => { if (message.type() === "error") report.productDiagnostics.push(message.text()); });
  await sidebar.waitForLoadState("domcontentloaded");
  await sidebar.waitForFunction(() => !document.querySelector('#app')?.hasAttribute('data-workspace-booting'));
  await sidebar.evaluate(async () => {
    const { createPortTransport } = await import('/shared/transport/port-transport.js');
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    globalThis.__qzLiveToolEvents = [];
    const transport = createPortTransport({ postMessage: message => port.postMessage(message),
      onMessage: event => { if (event.type === 'tool_execution_end') globalThis.__qzLiveToolEvents.push(event); },
    });
    port.onMessage.addListener(message => transport.receive(message));
    globalThis.__qzLiveObserver = { port, transport };
  });
  await worker.evaluate(() => {
    globalThis.__qzLiveBridgeCalls = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'run_script_tool_call') globalThis.__qzLiveBridgeCalls.push({
        sessionId: message.sessionId, name: message.toolName, args: message.args,
      });
      return false;
    });
  });
  const tools = [{ type: "function", function: { name: "qz", description: "Run the real qz CLI in the already connected isolated browser. argv excludes the qz executable. stdin supplies script JavaScript. Script stdout is {ok,result,trace}: execution status, the returned value and ordered trace messages; use --json for other structured receipts. This is the current unpublished source, not npx.",
    parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, stdin: { type: "string" } }, required: ["argv"], additionalProperties: false } } }];
  const messages = [{ role: "system", content: `${skill}\n\nThis browser is already installed, connected and consented. Use only the qz tool to drive it. Use qz session create for the titled task, qz script --session for every browser operation, and qz session cancel to finish. Do not install/configure anything or start a built-in qz model. The tool executes CLI arguments directly, so no shell expansion, pipes or file-writing are available; pass JavaScript through stdin. Work within 30 model turns and ten minutes. Every qz command starts a new process. Read the CLI receipts and finish the task before your final response.` },
    { role: "user", content: "On public English Wikipedia (https://en.wikipedia.org/wiki/Main_Page), verify the site's navigation without signing in. Create exactly one readable titled session for this task and give the page a readable alias. Find the encyclopedia Contents link with find_elements and click that exact returned target. From the Contents page, list the site's logo image with list_images and click that exact returned target to return to Main Page. After returning to Main Page, fill CSS target css:input[name=\"search\"] with Hangzhou without submitting. Use qz script to log one concise verified page observation and return a small business object containing the verified document title, URL, and searchValue read from that search input. Keep the same session and alias throughout; then cancel the task to finish. Report what you verified and the source URL. Choose your own calls and inspect each response; never invent an element target." }];
  for (let turn = 0; turn < 30; turn++) {
    log("model", { turn: turn + 1 });
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(Math.min(120_000, remaining())),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools, temperature: 0, max_tokens: 4096, thinking: { type: "disabled" } }),
    });
    assert.equal(response.ok, true, `DeepSeek HTTP ${response.status}: ${response.ok ? '' : redact(await response.text())}`);
    const body = await response.json(), message = body.choices?.[0]?.message;
    assert.ok(message); report.turns.push({ turn: turn + 1, model: body.model, usage: body.usage, message });
    messages.push(message); await save("model-transcript.json", messages); await persist();
    if (!message.tool_calls?.length) { report.final = message.content; break; }
    for (const call of message.tool_calls) {
      assert.equal(call.function.name, "qz");
      let result;
      try { result = await qz(JSON.parse(call.function.arguments)); }
      catch (error) { throw new Error(`qz harness/oracle failed: ${redact(error.stack || error)}`); }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      await save("model-transcript.json", messages);
    }
  }
  assert.ok(report.final, "the external agent must return a final response within 30 turns");
  const modelReceipts = messages.filter(message => message.role === 'tool').flatMap((message, index) => {
    if (parseCommand(report.cli[index].argv).command !== 'script') return [];
    const response = JSON.parse(message.content);
    const receipt = JSON.parse(response.stdout);
    return [{ toolCallId: message.tool_call_id, trace: receipt.trace }];
  });
  assert.deepEqual(modelReceipts.map(receipt => receipt.trace), report.cli.filter(entry => parseCommand(entry.argv).command === 'script').map(entry => entry.trace),
    'the model receives every CLI trace unchanged through the complete stdout');
  const modelTraces = modelReceipts.flatMap(receipt => receipt.trace).filter(trace => trace.trim());
  report.modelVisibleTraces = { receipts: modelReceipts.length, nonEmpty: modelTraces.length,
    samples: modelTraces.slice(0, 5), transport: 'complete CLI stdout in model tool responses' };
  assert.ok(modelTraces.length > 0, 'real external model requests include non-empty CLI traces');
  assert.equal(report.codedErrors.length, 0, `Unexpected CLI/ToolError failures: ${JSON.stringify(report.cli.filter(entry => entry.exitCode !== 0).map(entry => entry.error || { exitCode: entry.exitCode }))}`);
  assert.equal(report.failedCards?.length || 0, 0, "no failed call may be hidden from the final acceptance result");
  assert.equal(sessions.size, 1); assert.ok(canceled, "the external agent must cancel its task");
  assert.ok(report.cli.some(entry => parseCommand(entry.argv).command === 'script'));
  assert.equal(report.cli.some(entry => parseCommand(entry.argv).command === 'exec'), false, 'browser operations use the outer-script CLI');
  assert.ok(clicked.find_elements, "a find_elements target must be passed directly to click");
  assert.ok(clicked.list_images, "a list_images target must be passed directly to click");
  assert.ok(aliases.size > 0, "open_tab must echo a supplied alias");
  assert.ok(report.observations.some(call => call.name !== 'open_tab' && aliases.has(call.args.tabRef)), "later calls reuse the alias");
  assert.ok(scriptBusiness && typeof scriptBusiness === "object" && typeof scriptBusiness.title === "string" && typeof scriptBusiness.url === "string");
  assert.ok(report.cssFill, "a CSS fill on the final Main Page search input must succeed");
  assert.equal(scriptBusiness.searchValue, "Hangzhou");
  assert.ok(report.evidence.some(page => page.title === scriptBusiness.title && page.url === scriptBusiness.url && page.searchValue === "Hangzhou"), "script business data agrees with independent browser DOM evidence");
  assertNoUnexpectedDiagnostics([...environment.diagnostics, ...report.productDiagnostics], [apiKey]);
  assert.equal(report.browserModelRequests.length, 0, "the extension must not run a built-in model");
  assert.ok(report.turns.some(turn => turn.usage?.total_tokens > 0), "real external provider usage is required");
  const records = await snapshot(); assert.equal(records.length, 1); assert.equal(records[0].title, report.title);
  assert.equal(report.uiChecks.at(-1).actualCalls, report.uiChecks.at(-1).cards);
  report.ok = true; log("passed", { calls: report.transcript.length, turns: report.turns.length });
} catch (error) {
  report.failure = { message: redact(error.message), stack: redact(error.stack || error) }; process.exitCode = 1;
  log("failed", { message: report.failure.message });
  if (sidebar && !sidebar.isClosed()) await sidebar.screenshot({ path: join(output, "failure-sidebar.png"), fullPage: true }).catch(() => {});
} finally {
  clearInterval(heartbeat);
  for (const child of children) child.kill("SIGKILL");
  if (environment) { report.diagnostics = environment.diagnostics; await environment.close(); }
  chromium.launchPersistentContext = originalLaunch;
  await rm(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await persist();
  await save("final.txt", report.final || "");
}

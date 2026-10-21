import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ensureDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";
import { callTool } from "../../services/mcp-bridge/src/client.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { independentChrome } from "../support/independent-chrome.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";

// Three independent Pi processes delegate through one isolated service and three real Profiles.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.QINGZHOU_TEST_EXTENSION_DIR;
assert.ok(extension && existsSync(join(extension, "manifest.json")), "Set QINGZHOU_TEST_EXTENSION_DIR to a current production build");
const apiKey = readTestApiKey("deepseek", { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || "" });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const output = join(root, "tests/results/final-validation", `pi-concurrent-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const temporary = await mkdtemp(join(tmpdir(), "qz-three-pi-"));
const stateDir = join(temporary, "service"), bin = join(temporary, "bin");
const skill = join(root, "skills/qz-browser-agent/SKILL.md"), cli = join(root, "services/mcp-bridge/src/bin.mjs");
for (const path of [output, stateDir, bin]) mkdirSync(path, { recursive: true, mode: 0o700 });
const clean = value => String(value).split(apiKey).join("[redacted]");
const save = (name, value) => {
  const path = join(output, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, clean(typeof value === "string" ? value : JSON.stringify(value, null, 2)), { mode: 0o600 });
};
writeFileSync(join(bin, "qz"), `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2), startedAt=Date.now();
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...args],{stdio:['inherit','pipe','pipe']});
let stdout='',stderr='';
child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b)});
child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b)});
child.on('error',e=>{console.error(e.message);process.exitCode=1});
child.on('close',code=>{
 const entry=JSON.stringify({startedAt,finishedAt:Date.now(),args,code,stdout,stderr});
 const key=process.env.DEEPSEEK_API_KEY;
 appendFileSync(process.env.QZ_PI_TRACE,key?entry.split(key).join('[redacted]')+'\\n':entry+'\\n');
 process.exitCode=code??1;
});
`, { mode: 0o700 });
const baseEnv = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, QZ_STATE_DIR: stateDir,
  PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1", QZ_PI_TRACE: join(output, "harness-cli.jsonl") };
for (const name of Object.keys(baseEnv)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) delete baseEnv[name];
delete baseEnv.NODE_OPTIONS; delete baseEnv.NODE_PATH;
const cases = [
  { name: "pi-docs", marker: "THREE_PI_COUNTER", source: "https://docs.python.org/3/library/collections.html#collections.Counter",
    task: "Read Python's official Counter documentation. Explain most_common(3), give a small example, and link the source.",
    followup: "Explain how most_common orders tied counts, with a source link.", terms: [/most_common/, /first|encounter|insert/i, /docs\.python\.org/] },
  { name: "pi-database", marker: "THREE_PI_SQLITE", source: "https://sqlite.org/wal.html",
    task: "阅读 SQLite 官方 WAL 文档，用中文说明两个优点和一个限制，并给来源链接。",
    followup: "补充 WAL 对网络文件系统和多个 ATTACH 数据库事务的限制，并给来源链接。", terms: [/WAL/, /网络|network/i, /ATTACH/i, /sqlite\.org/] },
  { name: "pi-runtime", marker: "THREE_PI_RUST", source: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
    task: "Read the Rust Book's ownership introduction. List the three ownership rules and link the source.",
    followup: "Explain what happens when the owner goes out of scope, using the Rust Book source.", terms: [/owner/i, /scope/i, /drop/i, /doc\.rust-lang\.org/] },
];
const sharedCases = [
  { name: "pi-shared-enumerate", browserName: "pi-docs", shared: true, marker: "SHARED_PI_ENUMERATE", source: "https://docs.python.org/3/library/functions.html#enumerate",
    task: "Read Python's official enumerate documentation. Explain its default starting index with a short example and source link.",
    followup: "Give the exact result of list(enumerate(['red', 'blue'], start=3)), and cite the same documentation.", terms: [/enumerate/, /3.{0,30}red/s, /4.{0,30}blue/s, /docs\.python\.org/] },
  { name: "pi-shared-foreignkeys", browserName: "pi-docs", shared: true, marker: "SHARED_PI_FOREIGNKEYS", source: "https://www.sqlite.org/foreignkeys.html",
    task: "Read SQLite's official foreign-key documentation. Explain how to enable foreign-key enforcement for a connection, with the source link.",
    followup: "Explain whether PRAGMA foreign_keys can change enforcement inside an active multi-statement transaction, with the source link.", terms: [/foreign_keys/, /ON|1/, /transaction|事务/i, /effect|no.op|cannot|not possible|无效|不生效|忽略/i, /sqlite\.org/] },
];
const facts = {
  "pi-docs": [{ fact: "Equal Counter counts retain first-encounter order", source: /equal counts.{0,200}first encountered/i, answer: /first.{0,80}encounter|encounter.{0,80}order|insertion order/is }],
  "pi-database": [{ fact: "WAL does not work over a network filesystem", source: /does not work over a network filesystem/i, answer: /网络文件系统|network filesystem/i }, { fact: "ATTACH commits are not atomic across the database set", source: /not.{0,100}atomic across all databases/is, answer: /原子|atomic/i }],
  "pi-runtime": [{ fact: "The value is dropped when its owner goes out of scope", source: /owner goes out of scope.{0,80}value will be dropped/is, answer: /scope.{0,180}drop|drop.{0,180}scope/is }],
  "pi-shared-enumerate": [{ fact: "enumerate counts from start, which defaults to zero", source: /start.{0,100}defaults to 0/is, answer: /(?:default|默认).{0,80}0|0.{0,80}(?:default|默认)/is }, { fact: "start=3 yields (3,red) and (4,blue)", source: /enumerate/is, answer: /3.{0,30}red.{0,80}4.{0,30}blue/is }],
  "pi-shared-foreignkeys": [{ fact: "PRAGMA foreign_keys changes inside an active transaction have no effect", source: /no effect/is, answer: /no effect|no.op|cannot|not possible|完全无效|不生效|静默忽略|无效果/is }],
};
const piExecutable = process.env.PI_EXECUTABLE || "pi";
const report = { ok: false, startedAt: new Date().toISOString(), output, model, extension,
  extensionSha256: createHash("sha256").update(readFileSync(join(extension, "background/service-worker.js"))).digest("hex"),
  skillSha256: createHash("sha256").update(readFileSync(skill)).digest("hex"),
  agentTools: ["read", "bash"], agents: [], phases: [], network: [], checks: [], cleanup: {}, limitations: [
    "qz on the isolated PATH runs the current unpublished CLI source; this does not test a published npm artifact.",
    "The harness initializes first-use consent and DeepSeek settings. The first three Pi processes each perform URL pairing using shell commands. The last two reuse one explicitly selected Profile.",
    "Prompts supply known Profile paths and browser identifiers; this tests real concurrent use, not autonomous discovery of a binding strategy.",
    "Acceptance compares selected source facts and checks task isolation; it does not independently certify every sentence in model output.",
  ] };
const persist = () => save("report.json", report);
const log = (stage, fields = {}) => { console.log(clean(JSON.stringify({ stage, ...fields, output }))); persist(); };
const browsers = [], children = new Set(), pendingNetwork = new Set();
let daemon, serial = 0, interrupted = false, currentPhase = "setup";
function kill(child, signal) { try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; for (const child of children) kill(child, signal); });
async function command(executable, args, { env = baseEnv, cwd = temporary, timeout = 30000, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); let stdout = "", stderr = "", carry = "", expired = false;
    const timer = setTimeout(() => { expired = true; kill(child, "SIGINT"); setTimeout(() => kill(child, "SIGKILL"), 5000).unref(); }, timeout);
    child.stdout.on("data", data => {
      stdout += data; carry += data; const lines = carry.split("\n"); carry = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); children.delete(child); if (carry) onLine?.(carry);
      let value; try { value = JSON.parse(stdout); } catch {}
      resolvePromise({ code, signal, expired, stdout: clean(stdout), stderr: clean(stderr), value });
    });
  });
}
async function qz(args) {
  const result = await command(join(bin, "qz"), [...args, "--json"]);
  assert.equal(result.code, 0, result.stderr || result.stdout); assert.equal(result.value?.ok, true, result.stdout);
  return result.value.result;
}
const assistantText = snapshot => snapshot.transcript.filter(entry => entry.type === "assistant")
  .map(entry => typeof entry.content === "string" ? entry.content : (entry.content || []).filter(item => item.type === "text").map(item => item.text).join("\n")).join("\n");
async function runPi(browser, spec) {
  const browserName = spec.browserName || spec.name;
  const entry = { name: spec.name, browserName, phase: currentPhase, profilePath: browser.profile, expectedUuid: browser.uuid, piSessionId: randomUUID(),
    task: spec.task, followup: spec.followup, marker: spec.marker, source: spec.source, startedAt: new Date().toISOString() };
  report.agents.push(entry);
  const work = join(temporary, spec.name, "work"), config = join(temporary, spec.name, "pi"), sessions = join(output, spec.name, "pi-sessions");
  for (const path of [work, config, sessions]) mkdirSync(path, { recursive: true, mode: 0o700 });
  entry.sessionDirectory = sessions;
  writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: model, defaultThinkingLevel: "off", enableInstallTelemetry: false, enableAnalytics: false }), { mode: 0o600 });
  const binding = spec.shared
    ? `This Profile is already connected as ${browserName}, UUID ${browser.uuid}. Read browsers --json and verify this exact name/UUID. Reuse that connection without renaming, re-pairing or stopping it. Another Pi is working concurrently in the SAME Profile; create only your own task and follow up only your own task ID.`
    : `First obtain a pairing URL with connect --no-open --name ${browserName} --json, then open that exact URL by launching the executable with --user-data-dir for your exact directory. Read browsers --json, match the exact identifier ${browserName}, and retain that entry's clientId UUID for every task command. Do not infer ownership from before/after list differences or select another online browser.`;
  const prompt = `Use the qz-browser-agent Skill to delegate one browser research task and one follow-up. Your only selected Chrome data directory is ${JSON.stringify(browser.profile)}. Its browser identifier is ${JSON.stringify(browserName)}; that identifier belongs to this Profile, not to you. The extension, first-use notice and DeepSeek model are configured. qz and Node are on PATH; use qz instead of npx for this unpublished build. Browser executable: ${JSON.stringify(browser.launches[0].executable)}.
${binding} Check settings for this UUID and retain it on every task command.
Create this task once: ${JSON.stringify(`${spec.task} Source: ${spec.source} Include ${spec.marker}_INITIAL in your final answer.`)}
Save its returned task ID, use bounded watches, and review the completed answer. Then send this follow-up to the SAME task ID and UUID: ${JSON.stringify(`${spec.followup} Include ${spec.marker}_FOLLOWUP in your final answer.`)}
Wait for the follow-up to complete and report the findings, source links, browser UUID and task ID. Keep the service running and leave other Profiles untouched. Use only read/bash, avoid browser debugging APIs, and do not inspect credentials. Write scratch files only in ${JSON.stringify(work)}.`;
  save(`${spec.name}/prompt.txt`, prompt); const events = []; const began = Date.now();
  log("pi-start", { name: spec.name, piSessionId: entry.piSessionId });
  const heartbeat = setInterval(() => log("pi-heartbeat", { name: spec.name, elapsedSeconds: Math.round((Date.now() - began) / 1000), tools: events.filter(event => event.type === "tool_execution_start").length }), 30000);
  try {
    const result = await command(piExecutable, ["--offline", "--no-extensions", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-skills", "--skill", skill,
      "--tools", "read,bash", "--provider", "deepseek", "--model", model, "--thinking", "off", "--mode", "json", "--print",
      "--append-system-prompt", `Write scratch files in ${work}.`, "--session-dir", sessions, "--session-id", entry.piSessionId,
      "--name", `qz concurrent ${spec.name}`, prompt], {
      cwd: work, timeout: 10 * 60000,
      env: { ...baseEnv, PI_CODING_AGENT_DIR: config, QZ_PI_TRACE: join(output, spec.name, "cli.jsonl"), DEEPSEEK_API_KEY: apiKey },
      onLine(line) {
        appendFileSync(join(output, spec.name, "pi.jsonl"), clean(line) + "\n");
        try { const event = JSON.parse(clean(line)); events.push(event); if (event.type === "tool_execution_start") log("pi-tool", { name: spec.name, tool: event.toolName }); } catch {}
      },
    });
    save(`${spec.name}/stderr.txt`, result.stderr); entry.code = result.code; entry.expired = result.expired;
    entry.tools = events.filter(event => event.type === "tool_execution_start").map(event => ({ name: event.toolName, args: event.args }));
    entry.final = events.filter(event => event.type === "message_end" && event.message?.role === "assistant")
      .flatMap(event => event.message.content.filter(item => item.type === "text").map(item => item.text)).at(-1);
    assert.equal(result.expired, false); assert.equal(result.code, 0, result.stderr);
    assert.ok(entry.tools.some(tool => tool.name === "read" && String(tool.args.path || tool.args.file_path || "").endsWith("qz-browser-agent/SKILL.md")), "each Pi reads the current Skill");
    if (!spec.shared) assert.ok(entry.tools.some(tool => tool.name === "bash" && String(tool.args.command).includes("--user-data-dir")), "each initial Pi launches its own selected Profile");
    entry.ok = true;
  } catch (error) { entry.ok = false; entry.error = clean(error.stack || error); }
  finally { clearInterval(heartbeat); entry.finishedAt = new Date().toISOString(); log("pi-finished", { name: spec.name, ok: entry.ok }); }
}
async function fullSnapshot(uuid, sessionId) {
  return callTool(daemon.endpoint, "qingzhou_get_session_snapshot", { clientId: uuid, sessionId, compact: false, tail: false, includeArtifacts: true }, { timeoutMs: 25000 });
}
function sourceSeen(browser, source) {
  const expected = new URL(source); expected.hash = "";
  const visit = browser.visits.find(entry => {
    try { const actual = new URL(entry.url); return actual.hostname.replace(/^www\./, "") === expected.hostname.replace(/^www\./, "") && actual.pathname === expected.pathname; }
    catch { return false; }
  });
  if (visit) return { method: "actual-page-navigation", ...visit };
  // Chrome also records requests from the extension's inner execution context, where no tab is required.
  const capture = browser.launches.find(launch => readFileSync(launch.netLog, "utf8").includes(expected.href));
  return capture ? { method: "chrome-network-capture", path: capture.netLog, url: expected.href } : null;
}
async function validateAgent(browser, spec) {
  const browserName = spec.browserName || spec.name, entry = report.agents.find(agent => agent.name === spec.name);
  const selected = (await qz(["browsers"])).browsers.find(client => client.name === browserName);
  assert.ok(selected); assert.equal(selected.clientId, browser.uuid); assert.equal(selected.online, true);
  const commands = readFileSync(join(output, spec.name, "cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  if (!spec.shared) assert.ok(commands.some(item => item.args[0] === "connect" && item.code === 0
    && item.args.includes("--no-open") && item.args[item.args.indexOf("--name") + 1] === browserName), "each Pi requests its assigned Profile's explicit named URL");
  else assert.ok(!commands.some(item => ["connect", "stop", "cancel"].includes(item.args[0])), "shared-Profile agents leave the connection and other tasks running");
  const created = commands.filter(item => item.args[0] === "create" && item.code === 0);
  const sent = commands.filter(item => item.args[0] === "send" && item.code === 0);
  assert.equal(created.length, 1, "one created task per Pi"); assert.equal(sent.length, 1, "one follow-up per Pi");
  const id = JSON.parse(created[0].stdout).result.session.id;
  entry.initialTaskInterval = { createdAt: created[0].startedAt, followupStartedAt: sent[0].startedAt };
  assert.equal(sent[0].args[1], id, "follow-up uses the original task ID");
  for (const item of commands.filter(item => ["create", "show", "watch", "send", "settings"].includes(item.args[0]))) {
    assert.equal(item.args[item.args.indexOf("--client") + 1], browser.uuid, "every task command retains the selected Profile UUID");
  }
  const snapshot = await fullSnapshot(browser.uuid, id); save(`${spec.name}/final-snapshot.json`, snapshot);
  assert.equal(snapshot.status, "completed");
  const text = assistantText(snapshot);
  for (const suffix of ["INITIAL", "FOLLOWUP"]) assert.ok(text.includes(`${spec.marker}_${suffix}`));
  for (const term of spec.terms) assert.match(text, term);
  for (const other of [...cases, ...sharedCases].filter(item => item !== spec)) assert.equal(JSON.stringify(snapshot).includes(other.marker), false, "each task history contains only its own caller's work");
  const toolResults = JSON.stringify(snapshot.transcript.filter(item => item.type === "tool" && !item.isError).map(item => item.result));
  entry.sourceFactChecks = facts[spec.name].map(item => ({ fact: item.fact, sourceExcerpt: toolResults.match(item.source)?.[0], answerExcerpt: text.match(item.answer)?.[0] }));
  for (const fact of entry.sourceFactChecks) assert.ok(fact.sourceExcerpt && fact.answerExcerpt, `source and answer evidence required: ${fact.fact}`);
  entry.sourceAccess = sourceSeen(browser, spec.source); assert.ok(entry.sourceAccess, "the selected Profile must actually access the requested source");
  const page = await browser.panel(); await page.setViewportSize({ width: 400, height: 900 });
  await page.locator('[data-tab="sessions"]').click(); await page.locator(`.session-card[data-id="${id}"]`).click();
  await page.screenshot({ path: join(output, spec.name, "panel.png") }); await page.close();
  entry.clientId = browser.uuid; entry.sessionId = id; entry.answer = text;
  return { clientId: browser.uuid, sessionId: id, snapshot };
}
async function runPhase(name, assignments, validate) {
  currentPhase = name;
  const phase = { name, startedAt: new Date().toISOString(), ok: false }; report.phases.push(phase); log("phase-start", { name });
  try {
    await Promise.all(assignments.map(({ browser, spec }) => runPi(browser, spec)));
    await Promise.allSettled([...pendingNetwork]);
    assert.equal(interrupted, false);
    const agents = report.agents.filter(agent => agent.phase === name);
    assert.ok(agents.every(agent => agent.ok), "all Pi processes must finish successfully");
    phase.piConcurrentOverlapMs = Math.min(...agents.map(agent => Date.parse(agent.finishedAt))) - Math.max(...agents.map(agent => Date.parse(agent.startedAt)));
    assert.ok(phase.piConcurrentOverlapMs > 0, "independent Pi processes must overlap");
    const completed = [];
    for (const { browser, spec } of assignments) completed.push(await validateAgent(browser, spec));
    phase.initialTaskObservationOverlapMs = Math.min(...agents.map(agent => agent.initialTaskInterval.followupStartedAt))
      - Math.max(...agents.map(agent => agent.initialTaskInterval.createdAt));
    assert.ok(phase.initialTaskObservationOverlapMs > 0, "created tasks must have overlapping observation intervals");
    phase.observationNote = "This interval measures create-to-follow-up observation overlap, not an exact model execution duration.";
    await validate(completed);
    phase.tasks = completed.map(({ clientId, sessionId }) => ({ clientId, sessionId })); phase.ok = true;
    return completed;
  } catch (error) { phase.error = clean(error.stack || error); throw error; }
  finally { phase.finishedAt = new Date().toISOString(); log("phase-finished", { name, ok: phase.ok }); }
}
try {
  log("prepare"); report.piVersion = (await command(piExecutable, ["--version"])).stdout.trim();
  daemon = await ensureDaemon({ stateDir, preferredPort: 0 }); report.endpoint = daemon.endpoint;
  const { saveExtensionLlmConfig } = await import("../support/isolated-extension-mcp.mjs");
  for (const spec of cases) {
    const browser = await independentChrome({ name: spec.name, profile: join(temporary, `${spec.name}-profile`), extensionPath: extension, outputDirectory: output, headless: false });
    browsers.push(browser);
    browser.visits = [];
    const trackPage = page => page.on("framenavigated", frame => { if (frame === page.mainFrame()) browser.visits.push({ at: Date.now(), url: frame.url() }); });
    browser.context.pages().forEach(trackPage); browser.context.on("page", trackPage);
    browser.context.on("response", response => {
      if (new URL(response.url()).hostname !== "api.deepseek.com") return;
      const id = ++serial, phase = currentPhase;
      const work = (async () => {
        save(`${spec.name}/model/${id}-request.json`, { url: response.url(), body: response.request().postDataJSON() });
        save(`${spec.name}/model/${id}-response.txt`, await response.text());
        report.network.push({ name: spec.name, phase, id, status: response.status() }); persist();
      })().catch(error => report.network.push({ name: spec.name, phase, id, error: clean(error.message) }));
      pendingNetwork.add(work); work.finally(() => pendingNetwork.delete(work));
    });
    const page = await browser.panel();
    await acceptDataDisclosure(page, { disableBridge: false });
    await saveExtensionLlmConfig(page, { provider: "deepseek", apiKey, model, contextWindow: 1048576, trimOldToolResults: true, vision: false, debugMode: false });
    const local = await page.evaluate(() => chrome.runtime.sendMessage({ type: "mcp_connection_status" }));
    assert.equal(local.result.state, "disconnected"); browser.uuid = local.result.clientId;
    await browser.closeExtensionPages();
  }
  assert.equal((await qz(["status"])).connected, false, "the harness leaves all three Profiles unpaired");
  const initial = await runPhase("three-pi-three-profiles", browsers.map((browser, index) => ({ browser, spec: cases[index] })), async completed => {
    for (const [index, own] of completed.entries()) {
      const listed = await qz(["tasks", "--client", own.clientId, "--limit", "500"]);
      assert.deepEqual(listed.sessions.filter(item => item.id !== "0").map(item => item.id), [own.sessionId]);
      for (const other of browsers.filter(browser => browser.uuid !== own.clientId)) {
        const outside = await fullSnapshot(other.uuid, own.sessionId);
        assert.equal(outside.session, null); assert.equal(outside.transcript.length, 0); assert.equal(outside.hasHistory, false);
        assert.equal(sourceSeen(other, cases[index].source), null, "source requests stay in the selected Profile");
      }
      assert.ok(report.network.filter(item => item.name === cases[index].name && item.status === 200).length >= 2);
    }
  });
  await runPhase("two-pi-one-profile", sharedCases.map(spec => ({ browser: browsers[0], spec })), async completed => {
    assert.notEqual(completed[0].sessionId, completed[1].sessionId);
    assert.equal(completed[0].clientId, completed[1].clientId);
    const listed = await qz(["tasks", "--client", browsers[0].uuid, "--limit", "500"]);
    assert.deepEqual(listed.sessions.filter(item => item.id !== "0").map(item => item.id).sort(), [initial[0].sessionId, ...completed.map(item => item.sessionId)].sort());
    for (const own of initial) {
      const after = await fullSnapshot(own.clientId, own.sessionId);
      assert.equal(after.status, "completed"); assert.deepEqual(after.transcript, own.snapshot.transcript, "shared work does not alter prior tasks or other Profiles");
    }
    for (const own of completed) for (const other of browsers.slice(1)) {
      const outside = await fullSnapshot(other.uuid, own.sessionId);
      assert.equal(outside.session, null); assert.equal(outside.transcript.length, 0);
    }
  });
  report.checks = ["three independently configured Pi processes pair named Profiles concurrently", "two additional Pi processes share one existing Profile without connection changes", "five independent tasks each receive one same-task follow-up", "task commands retain explicit Profile UUIDs and task IDs", "selected factual claims have evidence in actual tool results and final answers", "source access is recorded even if the task closes its tabs", "task histories do not mix and previous tasks remain unchanged", "wrong-Profile task reads return no task data"];
  report.ok = true; log("passed", { providerResponses: report.network.length });
} catch (error) { report.error = clean(error.stack || error); log("failed", { error: report.error }); process.exitCode = 1; }
finally {
  await Promise.race([Promise.allSettled([...pendingNetwork]), delay(10000)]);
  for (const child of children) kill(child, "SIGTERM");
  if (daemon) await Promise.allSettled(report.agents.map(async entry => {
    const path = join(output, entry.name, "cli.jsonl"); if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").trim().split("\n")) {
      try {
        const item = JSON.parse(line); if (item.args[0] !== "create" || item.code !== 0) continue;
        const id = JSON.parse(item.stdout).result.session.id;
        save(`${entry.name}/cleanup-snapshot-${id}.json`, await fullSnapshot(entry.expectedUuid, id));
      } catch (error) { entry.cleanupSnapshotError = clean(error.message); }
    }
  }));
  for (const browser of browsers) {
    save(`${browser.name}/browser.json`, { uuid: browser.uuid, version: browser.version, launches: browser.launches, logs: browser.logs, crashes: browser.crashes, requests: browser.requests, visits: browser.visits });
    await browser.stop().catch(error => { report.cleanup.error = clean(error.message); });
  }
  await Promise.allSettled([...pendingNetwork]);
  for (const filename of readdirSync(output).filter(name => name.endsWith("-netlog.json"))) save(filename, readFileSync(join(output, filename), "utf8"));
  if (daemon) await stopDaemon({ stateDir }).catch(error => { report.cleanup.error = clean(error.message); });
  for (const entry of report.agents) for (const filename of readdirSync(entry.sessionDirectory).filter(name => name.endsWith(".jsonl"))) {
    const path = join(entry.sessionDirectory, filename); writeFileSync(path, clean(readFileSync(path, "utf8")), { mode: 0o600 });
    const exported = await command(piExecutable, ["--offline", "--export", path, join(output, entry.name, "pi-session.html")]);
    if (exported.code !== 0) entry.exportError = exported.stderr;
  }
  await rm(temporary, { recursive: true, force: true });
  report.cleanup.temporaryRemoved = !existsSync(temporary);
  report.cleanup.chromeStopped = browsers.every(browser => browser.child.exitCode !== null || browser.child.signalCode !== null);
  if (report.cleanup.error || !report.cleanup.chromeStopped) { report.ok = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); persist();
}

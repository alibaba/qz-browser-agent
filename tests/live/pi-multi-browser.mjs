import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDaemon, stopDaemon } from "../../services/mcp-bridge/src/daemon.mjs";
import { readTestApiKey } from "../support/local-credentials.mjs";
import { independentChrome } from "../support/independent-chrome.mjs";
import { acceptDataDisclosure } from "../support/data-consent.mjs";

// Explicit live entrypoint: pi and the extension both call the real DeepSeek API.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.QINGZHOU_TEST_EXTENSION_DIR;
assert.ok(extension && existsSync(join(extension, "manifest.json")), "Set QINGZHOU_TEST_EXTENSION_DIR to a current production build");
const apiKey = readTestApiKey("deepseek", { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || "" });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-flash";
const output = join(root, "tests/results/skill-pi", `multi-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const temporary = await mkdtemp(join(tmpdir(), "qz-pi-multi-"));
const work = join(temporary, "work"), config = join(temporary, "pi"), stateDir = join(temporary, "service"), bin = join(temporary, "bin");
const sessions = join(output, "pi-sessions"), skill = join(root, "skills/qz-browser-agent/SKILL.md");
for (const directory of [output, work, config, stateDir, bin, sessions, join(output, "model")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const clean = value => String(value).split(apiKey).join("[redacted]");
const save = (filename, value) => writeFileSync(join(output, filename), clean(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
const cli = join(root, "services/mcp-bridge/src/bin.mjs");
// Use the actual unpublished CLI source without replacing npx or the user's installed package.
const wrapper = `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { appendFileSync } from 'node:fs';\nconst args=process.argv.slice(2); const p=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...args],{stdio:['inherit','pipe','pipe']});\nlet out='',err='';p.stdout.on('data',b=>{out+=b;process.stdout.write(b)});p.stderr.on('data',b=>{err+=b;process.stderr.write(b)});p.on('error',e=>{console.error(e.message);process.exitCode=1});p.on('close',code=>{appendFileSync(${JSON.stringify(join(output, "cli.jsonl"))},JSON.stringify({at:Date.now(),args,code,stdout:out,stderr:err})+'\\n');process.exitCode=code??1});\n`;
writeFileSync(join(bin, "qz"), wrapper, { mode: 0o700 });
writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: model, defaultThinkingLevel: "off", enableInstallTelemetry: false, enableAnalytics: false }), { mode: 0o600 });
const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, QZ_STATE_DIR: stateDir,
  PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
for (const key of Object.keys(env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete env[key];
// The test runner's TypeScript loader belongs to this repository, not the installed pi CLI.
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const piExecutable = process.env.PI_EXECUTABLE || "pi";
const report = { ok: false, startedAt: new Date().toISOString(), output, model, extension, piSessionId: randomUUID(),
  agentTools: ["read", "bash"], phases: [], browsers: [], network: [], checks: [], limitations: [
    "The current unpublished CLI is supplied as qz on the isolated PATH; this does not test a newly published npm version.",
    "The harness initializes consent and model settings. pi receives shell tools only and performs pairing by launching Chrome with the returned URL.",
  ] };
const persist = () => save("report.json", report);
const log = (stage, data = {}) => { report.stage = stage; persist(); console.log(clean(JSON.stringify({ stage, ...data, output }))); };
const browsers = [], children = new Set(), pendingNetwork = new Set();
let daemon, interrupted = false, modelSerial = 0;
const kill = (child, signal) => {
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {}
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; for (const child of children) kill(child, signal); });
async function command(executable, args, { input, timeout = 30000, childEnv = env, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: work, env: childEnv, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "", carry = "", expired = false;
    const timer = setTimeout(() => { expired = true; kill(child, "SIGINT"); setTimeout(() => kill(child, "SIGKILL"), 5000).unref(); }, timeout);
    child.stdin.end(input);
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
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.value?.ok, true, result.stdout);
  return result.value.result;
}
async function pi(label, prompt) {
  assert.equal(interrupted, false);
  const events = [], started = Date.now();
  save(`${label}-prompt.txt`, prompt);
  log(`pi-${label}-running`);
  const heartbeat = setInterval(() => log(`pi-${label}-running`, { elapsedSeconds: Math.round((Date.now() - started) / 1000), tools: events.filter(event => event.type === "tool_execution_start").length }), 30000);
  let result;
  try {
    result = await command(piExecutable, ["--offline", "--no-extensions", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-skills", "--skill", skill,
      "--tools", "read,bash", "--provider", "deepseek", "--model", model, "--thinking", "off", "--mode", "json", "--print",
      "--append-system-prompt", `Write scratch files in the current working directory (${work}).`,
      "--session-dir", sessions, "--session-id", report.piSessionId, "--name", "qz multi-browser validation", prompt], {
      timeout: 10 * 60000, childEnv: { ...env, DEEPSEEK_API_KEY: apiKey }, onLine(line) {
        appendFileSync(join(output, `${label}.jsonl`), clean(line) + "\n");
        try {
          const event = JSON.parse(clean(line)); events.push(event);
          if (event.type === "tool_execution_start") log(`pi-${label}-tool`, { tool: event.toolName, args: event.args });
        } catch {}
      },
    });
  } finally { clearInterval(heartbeat); }
  save(`${label}-stderr.txt`, result.stderr);
  const text = events.filter(event => event.type === "message_end" && event.message?.role === "assistant")
    .flatMap(event => event.message.content.filter(item => item.type === "text").map(item => item.text));
  const phase = { label, code: result.code, expired: result.expired, elapsedSeconds: (Date.now() - started) / 1000,
    tools: events.filter(event => event.type === "tool_execution_start").map(event => ({ name: event.toolName, args: event.args })), final: text.at(-1) };
  report.phases.push(phase); persist();
  assert.equal(result.expired, false, `pi ${label} exceeded its deadline`);
  assert.equal(result.code, 0, result.stderr);
  return phase;
}
async function collect(label) {
  const results = [];
  for (let index = 0; index < browsers.length; index++) {
    const browser = browsers[index], page = await browser.panel();
    const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: "mcp_connection_status" }));
    assert.equal(state.result.state, "connected", JSON.stringify(state));
    const client = state.result;
    const tasks = await qz(["tasks", "--client", client.clientId, "--limit", "500"]);
    const items = (tasks.sessions || tasks.items || []).filter(item => item.id !== "0");
    const snapshots = [];
    for (const item of items) {
      const snapshot = await qz(["show", item.id, "--client", client.clientId]);
      snapshots.push(snapshot);
    }
    save(`${label}-profile-${index + 1}.json`, { client, tasks, snapshots });
    if (items.length) {
      await page.locator('[data-tab="sessions"]').click();
      const card = page.locator(`.session-card[data-id="${items[0].id}"]`);
      await card.waitFor({ state: "visible" });
      await card.click();
    }
    await page.setViewportSize({ width: 400, height: 900 });
    await page.screenshot({ path: join(output, `${label}-profile-${index + 1}.png`) });
    const pages = browser.context.pages().filter(item => /^https?:/.test(item.url()));
    for (let p = 0; p < pages.length; p++) {
      await pages[p].screenshot({ path: join(output, `${label}-profile-${index + 1}-page-${p + 1}.png`) }).catch(() => {});
    }
    results.push({ client, tasks: items, snapshots, urls: pages.map(item => item.url()) });
    await page.close();
  }
  return results;
}
try {
  log("prepare");
  report.piVersion = (await command(piExecutable, ["--version"])).stdout.trim();
  daemon = await ensureDaemon({ stateDir, preferredPort: 0 });
  report.endpoint = daemon.endpoint;
  const { saveExtensionLlmConfig } = await import("../support/isolated-extension-mcp.mjs");
  for (let index = 0; index < 3; index++) {
    const browser = await independentChrome({ name: `pi-${index + 1}`, profile: join(temporary, `profile-${index + 1}`), extensionPath: extension, outputDirectory: output, headless: false });
    browsers.push(browser);
    browser.context.on("response", response => {
      if (new URL(response.url()).hostname !== "api.deepseek.com") return;
      const serial = ++modelSerial;
      const work = (async () => {
        const request = response.request();
        save(`model/${serial}-request.json`, { profile: index + 1, url: request.url(), body: request.postDataJSON() });
        save(`model/${serial}-response.txt`, await response.text());
        report.network.push({ profile: index + 1, status: response.status(), serial }); persist();
      })().catch(error => report.network.push({ profile: index + 1, serial, error: clean(error.message) }));
      pendingNetwork.add(work); work.finally(() => pendingNetwork.delete(work));
    });
    const page = await browser.panel();
    await acceptDataDisclosure(page, { disableBridge: false });
    await saveExtensionLlmConfig(page, { provider: "deepseek", apiKey, model, contextWindow: 128000, trimOldToolResults: true, vision: false, debugMode: false });
    await browser.closeExtensionPages();
    report.browsers.push({ profile: index + 1, path: browser.profile, pid: browser.child.pid, version: browser.version });
  }
  assert.equal((await qz(["status"])).connected, false, "the harness must leave all Profiles unpaired");
  const executable = browsers[0].launches[0].executable;
  const binding = await pi("bind", `Use the qz-browser-agent Skill to connect these three already-running Chrome Profiles without UI tools. qz and Node are on PATH; use qz instead of npx for this unpublished build. The extension, data notice and DeepSeek model are configured. Browser executable: ${JSON.stringify(executable)}. Profile directories in order: ${JSON.stringify(browsers.map(item => item.profile))}. Open the binding URL by launching that executable with --user-data-dir for each exact directory. Let qz assign identifiers. Report the online identifier and UUID for each Profile. Keep the local service running. Do not inspect credentials or use browser debugging APIs.`);
  assert.ok(binding.tools.some(tool => tool.name === "read" && String(tool.args.path || tool.args.file_path || "").endsWith("qz-browser-agent/SKILL.md")), "pi must read the Skill");
  assert.ok(binding.tools.some(tool => tool.name === "bash" && String(tool.args.command).includes("--user-data-dir")), "pi must launch the target browser itself");
  const before = await collect("bound");
  assert.equal(new Set(before.map(item => item.client.clientId)).size, 3);
  assert.deepEqual(before.map(item => item.client.name), ["default", "browser-2", "browser-3"]);
  report.checks.push("pi paired three Profiles with automatically allocated identifiers");
  const tasks = [
    { marker: "PI_SQLITE", prompt: "Read https://sqlite.org/wal.html and explain two advantages and one limitation of write-ahead logging, with the source link." },
    { marker: "PI_HANGZHOU", prompt: "Read https://en.wikipedia.org/wiki/Hangzhou and name its three UNESCO World Heritage Sites, with source links." },
    { marker: "PI_PYTHON", prompt: "Read https://docs.python.org/3/library/asyncio-task.html and explain TaskGroup cancellation in three bullets, with the source link." },
  ];
  const research = await pi("research", `Delegate these three independent research tasks to qz, each in its corresponding Profile, and start all three before waiting. ${JSON.stringify(tasks.map((task, index) => ({ client: before[index].client.name, marker: task.marker, task: task.prompt + " Include " + task.marker + " in the final response." })))} Review the completed responses and report findings, source links, task IDs and browser UUIDs. Use bounded watches; keep working until all three are complete.`);
  assert.ok(research.tools.some(tool => /\bcreate\b/.test(tool.args.command || "")));
  const commands = readFileSync(join(output, "cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const created = commands.filter(item => item.args[0] === "create" && item.code === 0);
  const firstWatch = commands.find(item => item.args[0] === "watch");
  assert.equal(created.length, 3);
  assert.ok(firstWatch && created.every(item => item.at <= firstWatch.at), "pi starts every task before watching");
  const researched = await collect("researched");
  for (let index = 0; index < researched.length; index++) {
    const own = researched[index];
    assert.equal(own.tasks.length, 1, "one independent task per Profile");
    assert.equal(own.snapshots[0].status, "completed");
    const text = JSON.stringify(own.snapshots[0]);
    assert.ok(text.includes(tasks[index].marker), "own marker must survive in task history");
    for (let other = 0; other < tasks.length; other++) if (other !== index) assert.equal(text.includes(tasks[other].marker), false, "task histories must not cross Profiles");
    const domain = new URL(tasks[index].prompt.match(/https:\/\/\S+/)[0]).hostname;
    assert.ok(own.urls.some(url => new URL(url).hostname === domain), `${domain} must actually be opened in its target browser`);
  }
  report.checks.push("three real DeepSeek browser tasks completed with separate histories and page ownership");
  await pi("rename-followup", "Rename only the second Profile's qz connection to pi-research by opening a binding URL in that Profile. Keep the same browser UUID. Then continue its existing Hangzhou task: add each UNESCO inscription year and source URL. Do not create a replacement task. Verify the other two browser connections are still online and return the final findings.");
  const after = await collect("final");
  assert.deepEqual(after.map(item => item.client.clientId), before.map(item => item.client.clientId), "rename retains all UUIDs");
  assert.deepEqual(after.map(item => item.client.name), ["default", "pi-research", "browser-3"]);
  assert.deepEqual(after.map(item => item.tasks.map(task => task.id)), researched.map(item => item.tasks.map(task => task.id)), "follow-up reuses the task");
  assert.equal(after[1].snapshots[0].status, "completed");
  const followed = JSON.stringify(after[1].snapshots[0]);
  for (const year of ["2011", "2014", "2019"]) assert.ok(followed.includes(year), `UNESCO year ${year}`);
  report.checks.push("URL rename retains UUID and all browser connections; pi follows up in the same task");
  for (let profile = 1; profile <= 3; profile++) {
    assert.ok(report.network.filter(item => item.profile === profile && item.status === 200).length >= 2, "each Profile must call the real provider for its task");
  }
  report.ok = true;
  log("passed", { checks: report.checks, providerResponses: report.network.length });
} catch (error) {
  report.error = clean(error.stack || error); log("failed", { error: report.error }); process.exitCode = 1;
} finally {
  await Promise.allSettled([...pendingNetwork]);
  for (const child of children) kill(child, "SIGTERM");
  for (const browser of browsers) {
    save(`${browser.name}-diagnostics.json`, { logs: browser.logs, crashes: browser.crashes, requests: browser.requests, launches: browser.launches });
    await browser.stop().catch(error => { report.cleanupError = clean(error.message); });
  }
  for (const filename of readdirSync(output).filter(name => name.endsWith("-netlog.json"))) {
    save(filename, readFileSync(join(output, filename), "utf8"));
  }
  if (daemon) await stopDaemon({ stateDir }).catch(error => { report.cleanupError = clean(error.message); });
  for (const filename of readdirSync(sessions).filter(name => name.endsWith(".jsonl"))) {
    const path = join(sessions, filename); writeFileSync(path, clean(readFileSync(path, "utf8")));
    const exported = await command(piExecutable, ["--offline", "--export", path, join(output, "pi-session.html")]);
    if (exported.code !== 0) report.exportError = exported.stderr;
  }
  if (existsSync(join(output, "cli.jsonl"))) save("cli.jsonl", readFileSync(join(output, "cli.jsonl"), "utf8"));
  await rm(temporary, { recursive: true, force: true });
  report.cleanup = { temporaryRemoved: !existsSync(temporary), chromeStopped: browsers.every(browser => browser.child.exitCode !== null || browser.child.signalCode !== null) };
  report.finishedAt = new Date().toISOString(); persist();
}

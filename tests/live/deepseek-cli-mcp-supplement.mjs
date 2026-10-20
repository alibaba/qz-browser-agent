import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localFetch, readHealth, resultValue } from "../../services/mcp-bridge/src/client.mjs";

const { values } = parseArgs({ options: { report: { type: "string" } } });
assert.ok(values.report, "--report must identify an active isolated live-soak report");
const primary = JSON.parse(readFileSync(values.report, "utf8"));
assert.equal(primary.phase, "running"); assert.equal(primary.provider, "deepseek");
const endpoint = new URL(primary.endpoint);
assert.equal(endpoint.hostname, "127.0.0.1"); assert.notEqual(endpoint.port, "18765");
process.kill(primary.runnerPid, 0);
const clientId = primary.clientId;
const reportPath = values.report.replace(/\.json$/, `-supplement-${Date.now()}.json`);
const report = { ok: false, startedAt: new Date().toISOString(), primaryReport: values.report, tasks: [], operations: [], failures: [] };
const client = new Client({ name: "qz-live-supplement", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", endpoint), { fetch: localFetch });
const sessions = new Set();
try {
  await client.connect(transport);
  await inputCase("form", "Ask me to choose CSV or Excel using a choice form. Then reply with my choice.");
  await inputCase("confirmation", "Use wait_for_user to ask for confirmation before opening https://example.com/. After I approve, read its page title and reply with it.");
  const table = primary.tasks.find(item => item.id === "earthquake-watch" && item.ok)?.table;
  assert.ok(table, "Primary run must have a verified real USGS table");
  const exported = await mcp("qingzhou_export_data_table", { table: table.table, format: "csv" });
  const downloaded = await mcp("qingzhou_list_downloads", { id: exported.downloadId });
  const item = downloaded.downloads[0]; assert.equal(item.state, "complete");
  const file = realpathSync(item.filepath);
  const expected = table.exports.find(item => item.format === "csv");
  const root = dirname(realpathSync(primary.tasks.find(item => item.downloads?.length)?.downloads[0].filepath));
  const within = relative(root, file); assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
  const bytes = readFileSync(file);
  assert.deepEqual(bytes, readFileSync(expected.savedPath), "MCP export exactly matches the earlier CLI export of the same real table");
  report.export = { table: table.table, downloadId: exported.downloadId, bytes: bytes.length, matchesCliBytes: true };
  const settings = await mcp("qingzhou_get_settings", { key: "model" });
  const cliSettings = await cli(["settings", "get", "model"]);
  assert.deepEqual(settings, cliSettings); report.settings = { key: "model", matched: true };
  report.ok = true;
} catch (error) { report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  for (const sessionId of sessions) await mcp("qingzhou_stop_session", { sessionId }).catch(() => {});
  await transport.terminateSession().catch(() => {}); await client.close().catch(() => {});
  report.finishedAt = new Date().toISOString(); persist();
  console.log(JSON.stringify({ finished: true, ok: report.ok, reportPath, failures: report.failures.map(item => item.message) }));
}
function persist() { writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
async function mcp(name, args = {}, options = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: { clientId, ...args } }, undefined, { timeout: 210_000, resetTimeoutOnProgress: true, ...options });
  const value = resultValue(result); report.operations.push({ channel: "mcp", name, ok: !result.isError, ms: Date.now() - started });
  assert.equal(result.isError || false, false, JSON.stringify(value)); return value;
}
async function cli(args) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { main } from './services/mcp-bridge/src/cli.mjs';
    import { readHealth } from './services/mcp-bridge/src/client.mjs';
    const endpoint=process.argv[1];
    process.exitCode=await main(process.argv.slice(2), {findDaemon:async()=>({endpoint,health:await readHealth(endpoint)})});
  `, "--", endpoint.href.replace(/\/$/, ""), ...args, "--json", "--client", clientId, "--timeout", "180"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", value => output += value); child.stderr.on("data", value => errors += value);
  const timer = setTimeout(() => child.kill("SIGTERM"), 200_000);
  const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
  report.operations.push({ channel: "cli", name: args[0], ok: code === 0 }); assert.equal(code, 0, `${output}\n${errors}`);
  const result = JSON.parse(output); assert.equal(result.ok, true); return result.result;
}
async function inputCase(kind, prompt) {
  const entry = { kind, prompt, ok: false }; report.tasks.push(entry); persist();
  let finished = false, result, failure, sessionId;
  const pending = mcp("qingzhou_create_session", { title: `Live supplement: ${kind}`, firstMessage: prompt, stream: true, waitTimeoutSeconds: 180 }, { onprogress: progress => {
    const event = progress._meta?.["qz/task-event"];
    if (event?.type === "created") { sessionId = event.session?.id || event.sessionId; entry.sessionId = sessionId; sessions.add(sessionId); }
  } }).then(value => result = value, error => failure = error).finally(() => finished = true);
  const deadline = Date.now() + 180_000;
  try {
    while (!finished && Date.now() < deadline) {
      if (sessionId && !entry.responded) {
        const shown = await cli(["show", sessionId]);
        if (shown.input.waiting) {
          const input = shown.input; assert.equal(input.requiresUserAction || false, false); assert.equal(input.kind, kind);
          entry.input = input;
          if (kind === "form") {
            const answers = Object.fromEntries(input.form.fields.map(field => [field.id, field.options.find(option => /csv/i.test(`${option.label} ${option.value}`))?.value || field.options[0].value]));
            await cli(["submit", sessionId, JSON.stringify(answers), "--wait-id", input.waitId]); entry.answers = answers;
          } else await cli(["approve", sessionId, "--wait-id", input.waitId]);
          entry.responded = true; persist();
        }
      }
      await delay(1000);
    }
    await pending; if (failure) throw failure;
    assert.equal(result.snapshot.status, "completed"); assert.equal(entry.responded, true);
    entry.snapshot = result.snapshot; entry.ok = true; sessions.delete(sessionId); persist();
  } catch (error) {
    if (sessionId) await mcp("qingzhou_stop_session", { sessionId }).catch(() => {});
    await pending; throw error;
  }
}

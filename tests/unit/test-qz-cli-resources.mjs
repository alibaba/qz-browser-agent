import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { main, runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";
import { renderResult } from "../../services/mcp-bridge/src/terminal.mjs";
import { QzError } from "../../services/mcp-bridge/src/client.mjs";

const running = { endpoint: "http://127.0.0.1:23456", health: { status: { connected: true, clients: [{ clientId: "profile" }] } } };
const dependencies = { findDaemon: async () => running };

test("resource commands map once to MCP names and preserve names, format, and selected browser", async () => {
  for (const [argv, name, parameters] of [
    [["data"], "qingzhou_list_data_tables", {}],
    [["data", "delete", "prices"], "qingzhou_delete_data_table", { table: "prices" }],
    [["data", "export", "prices"], "qingzhou_export_data_table", { table: "prices", format: "xlsx" }],
    [["data", "export", "prices", "--format", "csv"], "qingzhou_export_data_table", { table: "prices", format: "csv" }],
    [["data", "export", "prices", "--filename", "custom.xlsx"], "qingzhou_export_data_table", { table: "prices", format: "xlsx", filename: "custom.xlsx" }],
    [["images"], "qingzhou_list_image_collections", {}],
    [["images", "delete", "杭州 images"], "qingzhou_delete_image_collection", { collection: "杭州 images" }],
    [["images", "export", "杭州 images"], "qingzhou_export_image_collection", { collection: "杭州 images" }],
    [["images", "export", "photos", "--filename", "photos.zip"], "qingzhou_export_image_collection", { collection: "photos", filename: "photos.zip" }],
    [["skills", "--query", "hiring"], "qingzhou_list_skills", { scope: "all", query: "hiring" }],
    [["skills", "--scope", "global"], "qingzhou_list_skills", { scope: "global", query: "" }],
    [["skills", "show", "research"], "qingzhou_get_skill", { name: "research", includeContent: true, includeResources: false }],
    [["skills", "export", "research"], "qingzhou_export_skill", { name: "research" }],
    [["skills", "export", "research", "--filename", "research.zip"], "qingzhou_export_skill", { name: "research", filename: "research.zip" }],
    [["skills", "read", "research", "scripts/run.js", "--start", "10", "--limit", "100"], "qingzhou_get_skill_resource", { name: "research", path: "scripts/run.js", start: 10, maxChars: 100 }],
    [["skills", "tools", "-s", "task"], "qingzhou_list_plugins", { sessionId: "task" }],
    [["settings"], "qingzhou_get_settings", {}],
    [["automations"], "qingzhou_list_automations", {}],
    [["automations", "--limit", "5"], "qingzhou_list_automations", { limit: 5 }],
    [["automations", "run", "daily"], "qingzhou_run_automation", { automationId: "daily" }],
    [["settings", "apiKey"], "qingzhou_get_settings", { key: "apiKey" }],
    [["settings", "set", "vision", "false"], "qingzhou_update_settings", { config: { vision: false } }],
    [["settings", "set", "model", "model-id"], "qingzhou_update_settings", { config: { model: "model-id" } }],
    [["settings", "set", "contextWindow", "128000"], "qingzhou_update_settings", { config: { contextWindow: 128000 } }],
    [["settings", "set", "modelParameters", '{"temperature":0.5}'], "qingzhou_update_settings", { config: { modelParameters: { temperature: 0.5 } } }],
  ]) {
    let count = 0;
    const result = await runCli([...argv, "--client", "profile"], { ...dependencies, callTool: async (endpoint, actualName, args) => {
      count++; assert.equal(endpoint, running.endpoint); assert.equal(actualName, name);
      assert.deepEqual(args, { timeoutSeconds: 180, clientId: "profile", ...parameters });
      return { fixture: true };
    } });
    assert.equal(count, 1); assert.deepEqual(result, { result: { fixture: true } });
  }
});

test("invalid settings and MCP input fail before discovery and never echo supplied secrets", async () => {
  for (const argv of [["settings", "set", "bad-json-secret"], ["settings", "set", "null"], ["settings", "set", "[]"],
    ["settings", "set", "{}"], ["settings", "set", '{"__proto__":{}}'], ["mcp", "call", "unknown", "{}"],
    ["mcp", "call", "qingzhou_get_skill", "{}"], ["mcp", "call", "qingzhou_get_settings", "[]"],
    ["mcp", "call", "qingzhou_get_settings", '{"clientId":"one"}', "--client", "two"]]) {
    await assert.rejects(runCli(argv, { findDaemon: () => assert.fail("validate before discovery") }), error => {
      assert.equal(error.code, "invalid_arguments"); assert.doesNotMatch(error.message, /bad-json-secret/); return true;
    });
  }
  const patch = { apiKey: "fixture-credential", model: "model-id" };
  await runCli(["settings", "set", "-"], { ...dependencies, readStdin: async () => JSON.stringify(patch),
    callTool: async (_endpoint, name, args) => { assert.equal(name, "qingzhou_update_settings"); assert.deepEqual(args.config, patch); return { updated: ["apiKey", "model"], config: { hasApiKey: true, model: "model-id" } }; } });
});

test("removed commands fail before discovery; MCP has no command passthrough", async () => {
  for (const argv of [["tools"], ["tools", "list"], ["tools", "show", "open_tab"],
    ["tools", "call", "open_tab", "-", "-s", "task"], ["tools", "job", "job-1"],
    ["call", "open_tab", "-s", "task"], ["logs"], ["logs", "clear"], ["input", "task"],
    ["downloads"], ["downloads", "list"], ["downloads", "show", "42"],
    ["mcp", "tools"], ["mcp", "call", "qingzhou_get_settings", "{}"]]) {
    await assert.rejects(runCli(argv, { findDaemon: () => assert.fail("syntax fails before discovery"),
      readStdin: () => assert.fail("removed commands cannot consume stdin") }), error => error.code === "invalid_arguments");
  }
});

test("resource mutation failures are never replayed and JSON preserves export download details", async () => {
  for (const argv of [["data", "delete", "prices"], ["images", "delete", "photos"], ["settings", "set", "vision", "true"]]) {
    let calls = 0;
    await assert.rejects(runCli(argv, { ...dependencies, callTool: async () => { calls++; throw new Error("Disconnected after send"); } }), /Disconnected/);
    assert.equal(calls, 1);
  }
  for (const [command, filename] of [["data", "prices.xlsx"], ["images", "photos.zip"], ["skills", "research.zip"]]) {
    const download = { downloadId: 42, filename, state: "complete", filepath: `/tmp/${filename}`, fileUrl: `file:///tmp/${filename}` };
    let stdout = "";
    const code = await main([command, "export", "source", "--json"], { ...dependencies,
      stdout: { write: value => { stdout += value; } }, callTool: async () => download });
    assert.equal(code, 0); assert.deepEqual(JSON.parse(stdout), { ok: true, result: download });
  }
});

test("send waits for the new run, skips stale completed snapshots, and sends only once", async () => {
  let reads = 0, sends = 0;
  const snapshot = runId => ({ sessionId: "task", status: "completed", runId, runtime: { runId, status: "completed" },
    transcript: runId === "new-run" ? [{ type: "user", clientMessageId: "message", runId }] : [] });
  const result = await runCli(["send", "task", "-", "--stream"], { ...dependencies, readStdin: async () => "Add sources.",
    callTool: async (_endpoint, name, args) => {
      assert.equal(args.clientId, "profile");
      if (name === "qingzhou_get_session_snapshot") { assert.equal(sends, 1); return snapshot(++reads < 2 ? "old-run" : "new-run"); }
      assert.equal(name, "qingzhou_send_message"); sends++; assert.equal(args.text, "Add sources.");
      assert.equal(args.wait, false); assert.equal(args.waitForStart, true); assert.equal(args.steer, false);
      return { accepted: true, sessionId: "task", disposition: "queued", clientMessageId: "message", runtime: { runId: "old-run", status: "pending" } };
    },
  });
  assert.equal(sends, 1); assert.equal(reads, 2); assert.equal(result.result.snapshot.runId, "new-run");
});

test("send --steer targets the selected task once and streams only responses after its message", async () => {
  const updates = []; let sends = 0;
  const done = { sessionId: "chosen-task", status: "completed", runId: "current-run", transcript: [
    { type: "assistant", runId: "current-run", spanId: "prior", content: "Prior response." },
    { type: "user", runId: "current-run", clientMessageId: "steer-message", content: "Focus on sources." },
    { type: "assistant", runId: "current-run", spanId: "next", content: "Sources checked." },
  ] };
  const result = await runCli(["send", "chosen-task", "Focus on sources.", "--steer", "--stream", "-c", "chosen-profile"], {
    findDaemon: async () => ({ ...running, health: { status: { connected: true, clients: [{ clientId: "chosen-profile" }] } } }),
    onTaskUpdate: event => updates.push(event),
    callTool: async (_endpoint, name, args) => {
      assert.equal(args.sessionId, "chosen-task"); assert.equal(args.clientId, "chosen-profile");
      if (name === "qingzhou_get_session_snapshot") return done;
      assert.equal(name, "qingzhou_send_message"); sends++;
      assert.equal(args.steer, true); assert.equal(args.text, "Focus on sources."); assert.equal(args.wait, false);
      return { accepted: true, sessionId: "chosen-task", disposition: "queued", clientMessageId: "steer-message" };
    },
  });
  assert.equal(sends, 1); assert.equal(result.result.snapshot, done);
  assert.deepEqual(updates.filter(event => event.type === "text").map(event => event.text), ["Sources checked."]);
});

test("send interruption after acceptance reports the same task and never sends twice", async () => {
  const controller = new AbortController(); let sends = 0;
  await assert.rejects(runCli(["send", "task", "Continue.", "--wait"], { ...dependencies, signal: controller.signal,
    callTool: async (_endpoint, name) => {
      if (name === "qingzhou_send_message") { sends++; controller.abort(new DOMException("Stopped", "AbortError")); return { accepted: true, clientMessageId: "message", runtime: { runId: "new" } }; }
      return { sessionId: "task", status: "completed", runId: "old" };
    },
  }), error => error.code === "interrupted" && error.details.sessionId === "task");
  assert.equal(sends, 1);
});

test("a send accepted without a tracking identity fails with recovery guidance and is not replayed", async () => {
  let calls = 0;
  await assert.rejects(runCli(["send", "task", "Continue.", "--wait"], { ...dependencies,
    callTool: async (_endpoint, name) => { calls++; assert.equal(name, "qingzhou_send_message"); return { accepted: true }; },
  }), error => error.code === "invalid_response" && /qz watch task/.test(error.details.command));
  assert.equal(calls, 1);
});

test("resource output preserves exact names in safe copyable commands and labels useful metadata", { skip: process.platform === "win32" }, () => {
  const name = "杭州 O'Brien $(touch unwanted)";
  for (const command of ["data", "images", "skills"]) {
    const result = { [command === "data" ? "tables" : command === "images" ? "collections" : "items"]: [{ name, rowCount: 3, kind: "table", description: "A useful Skill" }] };
    const text = renderResult(parseCommand([command, "-c", "profile"]), result, { width: 40, shell: "posix" });
    assert.match(text, /Name/); assert.doesNotMatch(text, /"tables"|"collections"|"items"/);
    const line = text.split("\n").find(line => line.startsWith(`  qz ${command} export `));
    const parsed = spawnSync("sh", ["-c", `qz() { printf '%s\\n' "$@"; }; ${line}`], { encoding: "utf8" });
    assert.equal(parsed.status, 0); assert.deepEqual(parsed.stdout.trimEnd().split("\n"), [command, "export", name, "--client", "profile"]);
  }
  const text = renderResult(parseCommand(["images", "export", "photos"]), { downloadId: 1, filename: "photos.zip", state: "complete", bytes: 120, filepath: "/tmp/photos.zip" });
  assert.match(text, /Export downloaded/); assert.match(text, /Download ID  1/); assert.match(text, /Path  \/tmp\/photos.zip/);
});

test("settings output shows the supported field types and redacted configuration", () => {
  const text = renderResult(parseCommand(["settings", "-c", "profile"]), {
    config: { model: "model-id", hasApiKey: true },
    fields: [{ key: "model", type: "string", description: "Model ID" }, { key: "apiKey", type: "string", secret: true }],
    providers: [{ id: "custom", label: "Custom endpoint" }, { id: "signin", label: "Sign-in provider", auth: { mode: "sign_in", loggedIn: false, expired: false } }],
  });
  assert.match(text, /model  model-id/); assert.match(text, /apiKey · string · write-only/);
  assert.match(text, /custom · Custom endpoint/); assert.match(text, /qz settings set - --client profile/);
  assert.match(text, /signin · Sign-in provider · Sign in required/);
});

test("automation output exposes actual identifiers and progress", () => {
  const listed = renderResult(parseCommand(["automations", "-c", "profile"]), {
    automations: [{ id: "daily", name: "Daily research", enabled: false, nextRunAt: "2026-10-17T00:00:00Z" }],
  });
  assert.match(listed, /ID  daily/); assert.match(listed, /Paused/);
  assert.match(listed, /qz automations run daily --client profile/);
  const started = renderResult(parseCommand(["automations", "run", "daily", "-c", "profile"]), { run: { id: "run", sessionId: "task", automationId: "daily" } });
  assert.match(started, /qz watch task --client profile --stream/);

});

test("Skill resource chunks include an exact continuation command and missing resources fail", async () => {
  const text = renderResult(parseCommand(["skills", "read", "research", "scripts/run.js", "--limit", "10", "-c", "profile"]), {
    name: "research", path: "scripts/run.js", content: "abcdefghij", start: 0, end: 10, size: 25, truncated: true,
  });
  assert.match(text, /abcdefghij/);
  assert.match(text, /qz skills read research 'scripts\/run.js' --start 10 --limit 10 --client profile/);
  const contributions = renderResult(parseCommand(["skills", "tools", "-s", "task", "-c", "profile"]), {
    plugins: [{ skillName: "research", active: true, tools: [{ name: "research_search", description: "Find sources" }] }],
  });
  assert.match(contributions, /Tool  research_search/); assert.doesNotMatch(contributions, /qz (tools|call|logs|input)\b/);
  await assert.rejects(runCli(["skills", "read", "research", "missing.js"], { ...dependencies,
    callTool: async () => { throw new QzError("SKILL_RESOURCE_NOT_FOUND", "Resource missing"); },
  }), error => error.code === "SKILL_RESOURCE_NOT_FOUND");
});

test("built-in Skills omit unsupported export hints and exports report their file directly", () => {
  const builtin = { name: "built-in", scope: "system", builtin: true, readOnly: true };
  for (const action of ["list", "show"]) {
    const result = action === "list" ? { items: [builtin] } : builtin;
    const text = renderResult(parseCommand(action === "list" ? ["skills"] : ["skills", "show", "built-in"]), result);
    assert.doesNotMatch(text, /qz skills export/);
  }
  const mixed = renderResult(parseCommand(["skills"]), { items: [builtin, { name: "user-skill" }] });
  assert.match(mixed, /qz skills export user-skill/);
  for (const [command, filename] of [["data", "prices.xlsx"], ["images", "photos.zip"], ["skills", "research.zip"]]) {
    const parsed = parseCommand([command, "export", "source", "-c", "profile"]);
    const pending = renderResult(parsed, { downloadId: 42, state: "in_progress", filename });
    assert.match(pending, /Export download started/);
    assert.match(pending, /Download ID  42/);
    assert.ok(pending.includes(filename));
    assert.match(pending, /chrome:\/\/downloads/);
    assert.doesNotMatch(pending, /qz downloads\b/);
    const downloaded = renderResult(parsed, {
      downloadId: 42, filename, filepath: `/tmp/${filename}`, fileUrl: `file:///tmp/${filename}`, state: "complete", bytes: 124,
    });
    assert.match(downloaded, /Export downloaded/);
    assert.match(downloaded, /Download ID  42/);
    assert.ok(downloaded.includes(`Path  /tmp/${filename}`));
    assert.doesNotMatch(downloaded, /qz downloads\b/);
  }
});


test("task limits and child creation expose MCP capabilities without passthrough", async () => {
  for (const [argv, name, parameters] of [
    [["tasks", "--limit", "8"], "qingzhou_list_sessions", { limit: 8 }],
    [["create", "Inspect the source", "--parent", "parent-task"], "qingzhou_create_session", { title: "", firstMessage: "Inspect the source", parentSessionId: "parent-task" }],
  ]) {
    let count = 0;
    await runCli(argv, { ...dependencies, callTool: async (_endpoint, actualName, args) => {
      count++;
      assert.equal(actualName, name);
      assert.deepEqual(args, { timeoutSeconds: 180, ...parameters });
      return { accepted: true };
    } });
    assert.equal(count, 1);
  }
});

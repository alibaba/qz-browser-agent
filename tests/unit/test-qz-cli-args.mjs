import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";
import { COMMANDS } from "../../services/mcp-bridge/src/commands.mjs";
import { resourceRequest } from "../../services/mcp-bridge/src/cli-resources.mjs";
import { TOOL_CATALOG, validateMcpToolInput } from "../../services/mcp-bridge/src/tools.mjs";

function rejects(argv, message) {
  assert.throws(() => parseCommand(argv), error => error.code === "invalid_arguments" && (!message || message.test(error.message)), argv.join(" "));
}

test("resource commands select explicit operations, exact names, and export formats", () => {
  for (const command of ["data", "images", "skills"]) {
    assert.equal(parseCommand([command]).action, "list");
    assert.equal(parseCommand([command, "list"]).action, "list");
    assert.equal(parseCommand([command, "export", "杭州素材"]).id, "杭州素材");
    rejects([command, "export"]);
    rejects([command, "list", "unexpected"]);
    rejects([command, "unknown"]);
  }
  assert.equal(parseCommand(["data", "export", "prices"]).options.format, "xlsx");
  assert.equal(parseCommand(["data", "export", "prices", "--format", "csv"]).options.format, "csv");
  assert.equal(parseCommand(["data", "delete", "prices"]).id, "prices");
  assert.equal(parseCommand(["images", "delete", "photos"]).id, "photos");
  assert.equal(parseCommand(["skills", "show", "research"]).action, "show");
  assert.equal(parseCommand(["skills", "--query", "research"]).options.query, "research");
  const read = parseCommand(["skills", "read", "research", "scripts/run.js", "--start", "20", "--limit", "50"]);
  assert.equal(read.id, "research"); assert.equal(read.options.path, "scripts/run.js");
  assert.equal(read.options.start, 20); assert.equal(read.options.limit, 50);
  assert.equal(parseCommand(["skills", "read", "research", "README.md"]).options.limit, 20000);
  assert.equal(parseCommand(["skills", "tools", "-s", "task"]).options.session, "task");
  for (const args of [["data", "--format", "csv"], ["data", "export", "prices", "--format", "json"],
    ["images", "export", "photos", "--format", "csv"], ["skills", "export", "research", "--query", "x"],
    ["skills", "delete", "research"], ["images", "show", "photos"], ["skills", "read", "research"],
    ["skills", "read", "research", "x", "--start", "-1"], ["skills", "read", "research", "x", "--limit", "0"],
    ["skills", "read", "research", "x", "--limit", "1.5"], ["skills", "read", "research", "x", "--limit", "1000001"],
    ["skills", "show", "research", "--limit", "10"]]) rejects(args);
});

test("settings supports reading, typed field updates, and JSON patches from stdin", () => {
  assert.equal(parseCommand(["settings"]).action, "get");
  assert.equal(parseCommand(["settings", "get"]).id, undefined);
  assert.equal(parseCommand(["settings", "model"]).id, "model");
  assert.equal(parseCommand(["settings", "get", "model"]).id, "model");
  const update = parseCommand(["settings", "set", "vision", "false"]);
  assert.equal(update.id, "vision"); assert.equal(update.options.value, "false");
  assert.equal(parseCommand(["settings", "set", "-"]).options.args, "-");
  for (const args of [["settings", "set"], ["settings", "set", " ", "x"], ["settings", "get", "model", "extra"],
    ["settings", "set", "model", "one", "two"], ["settings", "--wait"]]) rejects(args);
});

test("MCP only prints a URL; automation commands remain explicit", () => {
  assert.equal(parseCommand(["mcp"]).action, undefined);
  for (const args of [["mcp", "tools"], ["mcp", "call", "anything"], ["mcp", "--client", "browser"],
    ["tools"], ["tools", "list"], ["tools", "show", "open_tab"], ["tools", "call", "open_tab", "-s", "task"],
    ["call", "open_tab", "-s", "task"], ["logs"], ["logs", "clear"], ["input", "task"],
    ["downloads"], ["downloads", "list"], ["downloads", "show", "42"]]) rejects(args);
  assert.equal(parseCommand(["automations"]).action, "list");
  assert.equal(parseCommand(["automations", "run", "automation-1"]).id, "automation-1");
  for (const args of [["automations", "run"], ["automations", "delete", "one"]]) rejects(args);
});

test("send accepts short follow-up text, stdin, and task observation options", () => {
  const parsed = parseCommand(["send", "task-1", "Add", "sources", "--stream", "-c", "browser"]);
  assert.equal(parsed.command, "send"); assert.equal(parsed.id, "task-1");
  assert.equal(parsed.options.prompt, "Add sources"); assert.equal(parsed.options.wait, true);
  assert.equal(parsed.waitTimeoutSeconds, null);
  assert.equal(parseCommand(["send", "task-1", "-", "--wait", "--timeout", "5"]).waitTimeoutSeconds, 5);
  assert.equal(parsed.options.steer, undefined);
  const steer = parseCommand(["send", "task-1", "Focus on sources.", "--steer", "--stream"]);
  assert.equal(steer.options.steer, true); assert.equal(steer.options.wait, true);
  for (const args of [["send"], ["send", "task-1"], ["send", " ", "hello"], ["send", "task-1", "hello", "--title", "No"]]) rejects(args);
  for (const args of [["create", "hello", "--steer"], ["watch", "task-1", "--steer"], ["send", "task-1", "hello", "--steer=false"]]) rejects(args);
});

test("task commands normalize to the existing task operations", () => {
  assert.deepEqual(parseCommand(["create", "Compare", "two laptops", "-t", "Research"]), {
    command: "tasks", action: "create", id: undefined, options: { title: "Research", prompt: "Compare two laptops" }, timeoutSeconds: 180, waitTimeoutSeconds: null,
  });
  assert.equal(parseCommand(["tasks"]).action, "list");
  for (const [command, action] of [["show", "get"], ["cancel", "stop"]]) {
    const result = parseCommand([command, "task-1"]);
    assert.equal(result.command, "tasks");
    assert.equal(result.action, action);
    assert.equal(result.id, "task-1");
  }
  assert.equal(parseCommand(["stop"]).command, "stop");
  rejects(["stop", "task-1"]);
});

test("task text is positional and the caller owns stdin reading", () => {
  assert.equal(parseCommand(["create", "Summarize", "this page"]).options.prompt, "Summarize this page");
  assert.equal(parseCommand(["create", "明天天气"]).options.prompt, "明天天气");
  assert.equal(parseCommand(["create", "-"]).options.prompt, "-");
  for (const args of [["create"], ["create", " "], ["create", "--title", "Empty task"]]) rejects(args, /prompt/);
  assert.equal(parseCommand(["create", "--", "--explain", "flags"]).options.prompt, "--explain flags");
});

test("creation can wait or stream, and both require a task prompt", () => {
  const waited = parseCommand(["create", "Read this page", "--wait"]);
  assert.equal(waited.options.wait, true);
  assert.equal(waited.options.stream, undefined);
  const streamed = parseCommand(["create", "Read this page", "--stream", "--json"]);
  assert.equal(streamed.options.wait, true);
  assert.equal(streamed.options.stream, true);
  assert.equal(streamed.options.json, true);
  for (const flag of ["--wait", "--stream"]) rejects(["create", flag], /prompt/);
  assert.equal(parseCommand(["create", "-", "--stream"]).options.prompt, "-");
  rejects(["show", "task", "--stream"], /not available/);
  rejects(["skills", "tools", "-s", "task", "--wait"], /not available/);
});

test("input commands bind task IDs, answers, and an optional wait identity", () => {
  for (const command of ["approve", "reject", "watch"]) {
    const parsed = parseCommand([command, "task-1", "-c", "profile"]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.id, "task-1");
    assert.equal(parsed.options["client-id"], "profile");
    rejects([command]);
    rejects([command, "task-1", "extra"]);
  }
  for (const command of ["submit", "approve", "reject"]) {
    const words = command === "submit" ? ["task-1", '{"city":"杭州"}'] : ["task-1"];
    assert.equal(parseCommand([command, ...words, "--wait-id", "wait-1"]).options["wait-id"], "wait-1");
    rejects([command, ...words, "--wait-id", " "]);
    rejects([command, ...words, "--wait-id", "one", "--wait-id", "two"]);
  }
  assert.equal(parseCommand(["submit", "task-1", "-"]).options.args, "-");
  rejects(["submit", "task-1"]);
  rejects(["submit", "task-1", "{}", "extra"]);
  for (const command of ["submit", "approve", "reject"]) {
    const words = command === "submit" ? ["task-1", "{}"] : ["task-1"];
    assert.equal(parseCommand([command, ...words, "--wait"]).options.wait, true);
    const streamed = parseCommand([command, ...words, "--stream", "--json"]);
    assert.equal(streamed.options.wait, true);
    assert.equal(streamed.options.stream, true);
  }
  assert.equal(parseCommand(["watch", "task-1"]).options.wait, true);
  assert.equal(parseCommand(["watch", "task-1", "--stream"]).options.stream, true);
  for (const args of [["input", "task", "--wait"], ["input", "task", "--wait-id", "wait"],
    ["watch", "task", "--wait-id", "wait"]]) rejects(args);
});

test("short options normalize without accepting duplicate identities", () => {
  for (const flag of ["--client", "-c"]) {
    const parsed = parseCommand(["skills", "tools", "-s", "task", flag, "browser"]);
    assert.equal(parsed.options["client-id"], "browser");
    assert.equal(parsed.options.client, undefined);
  }
  rejects(["tasks", "--client", "one", "-c", "two"], /--client only once/);
  rejects(["skills", "tools", "-s", "one", "--session", "two"], /only once/);
  rejects(["create", "Read this page", "--title", "one", "-t", "two"], /only once/);
  rejects(["tasks", "--client", " "], /non-empty ID/);
  rejects(["skills", "tools", "-s", ""], /non-empty ID/);
});

test("command-specific options fail instead of being silently ignored", () => {
  for (const args of [
    ["status", "--client", "browser"], ["status", "--timeout", "1"], ["mcp", "--session", "task"],
    ["stop", "--timeout", "1"], ["install", "--title", "x"], ["connect", "--title", "x"],
    ["skills", "--title", "x"], ["skills", "tools", "-s", "task", "--title", "x"],
    ["tasks", "--session", "task"], ["tasks", "--wait"],
    ["show", "task", "--title", "x"], ["cancel", "task", "--stream"],
  ]) rejects(args, /not available/);
});

test("output options are global and JSON/plain formats are mutually exclusive", () => {
  for (const command of ["status", "mcp", "stop", "install", "tasks"]) {
    assert.equal(parseCommand([command, "--json", "--no-color"]).options.json, true);
    assert.equal(parseCommand([command, "--plain", "--no-color"]).options.plain, true);
  }
  rejects(["tasks", "--json", "--plain"], /Choose/);
});

test("help is contextual and does not require operation arguments", () => {
  assert.equal(parseCommand([]).command, "help");
  assert.equal(parseCommand(["--help"]).helpTopic, undefined);
  for (const command of ["create", "show", "cancel", "send", "connect", "tasks"]) {
    assert.equal(parseCommand([command, "-h"]).helpTopic, command);
    assert.equal(parseCommand(["help", command]).helpTopic, command);
  }
  rejects(["help", "unknown"]);
  rejects(["help", "create", "extra"]);
  rejects(["tasks", "create", "--help"]);
  rejects(["help", "create", "--title", "ignored"], /not available/);
});

test("deadlines retain defaults and enforce the documented range", () => {
  assert.equal(parseCommand(["connect"]).timeoutSeconds, 30);
  assert.equal(parseCommand(["create", "Read this page"]).timeoutSeconds, 180);
  assert.equal(parseCommand(["tasks", "--timeout", "0.1"]).timeoutSeconds, 0.1);
  assert.equal(parseCommand(["connect", "--timeout=3600"]).timeoutSeconds, 3600);
  for (const value of ["0", "-1", "3601", "NaN", "Infinity", ""]) rejects(["tasks", `--timeout=${value}`], /timeout/);
});

test("task observation has no default deadline and only an explicit timeout limits it", () => {
  for (const args of [["create", "Research", "--wait"], ["create", "Research", "--stream"],
    ["watch", "task"], ["watch", "task", "--stream"], ["submit", "task", "{}", "--wait"], ["approve", "task", "--stream"]]) {
    const defaults = parseCommand(args);
    assert.equal(defaults.waitTimeoutSeconds, null);
    assert.equal(defaults.timeoutSeconds, 180, "each individual request remains bounded");
    const limited = parseCommand([...args, "--timeout", "45"]);
    assert.equal(limited.waitTimeoutSeconds, 45);
    assert.equal(limited.timeoutSeconds, 45);
  }
  for (const args of [["create", "Research"], ["submit", "task", "{}"], ["show", "task"]]) {
    assert.equal(parseCommand([...args, "--timeout", "45"]).waitTimeoutSeconds, null);
  }
});

test("removed commands and flags are rejected rather than interpreted", () => {
  for (const args of [["run", "Read this page"], ["tasks", "list"], ["tasks", "create", "Read this page"],
    ["tasks", "get", "task"], ["tasks", "stop", "task"], ["create", "--prompt", "Read this page"],
    ["create", "-p", "Read this page"], ["tools", "--client-id", "browser"],
    ["call", "inspect", "-s", "task", "--args", "{}"], ["help", "run"], ["help", "tasks", "create"]]) rejects(args);
});

test("valid commands and malformed syntax remain explicit", () => {
  for (const args of [["install"], ["connect"], ["status"], ["mcp"], ["stop"],
    ["skills", "tools"], ["tasks"], ["create", "Read this page"],
    ["show", "task"], ["cancel", "task"]]) assert.ok(parseCommand(args));
  for (const args of [["unknown"], ["status", "extra"], ["install", "qz"], ["install", "something"], ["tools", "one", "two"],
    ["show"], ["show", "one", "two"], ["cancel", ""], ["tools", "--wat"], ["tools", "--session"]]) rejects(args);
  const argv = ["create", "Read this page", "--title", "Research"];
  const before = [...argv];
  parseCommand(argv);
  assert.deepEqual(argv, before);
});


test("resource flags are action-specific", () => {
  assert.equal(parseCommand(["create", "Research", "--parent", "parent-task"]).options.parent, "parent-task");
  assert.equal(parseCommand(["tasks", "--limit", "20"]).options.limit, 20);
  assert.equal(parseCommand(["skills", "--scope", "resident"]).options.scope, "resident");
  for (const command of ["data", "images", "skills"]) {
    assert.equal(parseCommand([command, "export", "source", "--filename", "export.zip"]).options.filename, "export.zip");
    rejects([command, "list", "--filename", "export.zip"]);
    rejects([command, "export", "source", "--filename", " "]);
  }
  assert.equal(parseCommand(["automations", "--limit", "10"]).options.limit, 10);
  for (const argv of [["tasks", "--limit", "0"], ["automations", "run", "daily", "--limit", "5"],
    ["skills", "--scope", "unknown"], ["skills", "show", "research", "--scope", "site"],
    ["create", "Research", "--parent", " "], ["call", "read_article", "-s", "task", "--run-id", " "],
    ["constructor"], ["toString"], ["__proto__"]]) rejects(argv);
});

test("every declared CLI resource route maps to an advertised MCP schema", () => {
  const fixtures = {
    data: { list: [], delete: ["delete", "prices"], export: ["export", "prices", "--format", "csv", "--filename", "prices.csv"] },
    images: { list: [], delete: ["delete", "photos"], export: ["export", "photos", "--filename", "photos.zip"] },
    skills: { list: ["--query", "research", "--scope", "site"], show: ["show", "research"],
      read: ["read", "research", "scripts/run.js", "--start", "5", "--limit", "200"], tools: ["tools", "-s", "task"],
      export: ["export", "research", "--filename", "research.zip"] },
    settings: { get: ["get", "model"], set: ["set", "vision", "true"] },
    automations: { list: ["--limit", "5"], run: ["run", "daily"] },
  };
  const advertised = new Set(TOOL_CATALOG.map(tool => tool.name));
  for (const [command, definition] of Object.entries(COMMANDS)) {
    for (const [action, route] of Object.entries(definition.actions || {})) {
      if (!route.tool) continue;
      assert.ok(advertised.has(route.tool), `${command} ${action} advertises ${route.tool}`);
      const argv = fixtures[command]?.[action];
      assert.ok(argv, `Add a real parser fixture for ${command} ${action}`);
      const parsed = parseCommand([command, ...argv]);
      const mapped = resourceRequest(parsed, { vision: true });
      assert.equal(mapped.name, route.tool);
      const payload = { ...(mapped.local ? {} : { clientId: "profile", timeoutSeconds: 180 }), ...mapped.args };
      assert.doesNotThrow(() => validateMcpToolInput(mapped.name, payload), `${command} ${action} matches the public schema`);
    }
  }
});

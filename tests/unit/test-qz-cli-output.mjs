import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { main, runCli } from "../../services/mcp-bridge/src/cli.mjs";
import { createLiveOutput } from "../../services/mcp-bridge/src/output.mjs";

const running = { endpoint: "http://127.0.0.1:23456", health: { features: { browserPairing: 1 }, status: { connected: true, clients: [{ clientId: "fixture" }] } } };
const created = { session: { id: "task-1", title: "杭州天气" }, started: true };
const snapshot = (status, text = "", extra = {}) => ({ sessionId: "task-1", session: created.session,
  runId: "run-1", status, runtime: { status, runId: "run-1" },
  transcript: text ? [{ type: "assistant", spanId: "answer", runId: "run-1", content: text, streaming: status === "running" }] : [], ...extra });
function stream(isTTY = false) {
  return { isTTY, columns: 80, text: "", write(value) { this.text += value; } };
}
function setup({ tty = false, env = {}, ...rest } = {}) {
  const stdout = stream(tty), stderr = stream(tty);
  return { stdout, stderr, env, findDaemon: async () => running, ...rest };
}

test("TTY output is formatted; pipes and explicit JSON preserve the machine envelope", async () => {
  const tty = setup({ tty: true });
  assert.equal(await main(["status"], tty), 0);
  assert.match(tty.stdout.text, /Connected to qz/);
  assert.match(tty.stdout.text, /\u001b\[36m/);
  assert.equal(tty.stderr.text, "");
  for (const [args, terminal] of [[["status"], false], [["status", "--json"], true]]) {
    const deps = setup({ tty: terminal });
    assert.equal(await main(args, deps), 0);
    assert.equal(JSON.parse(deps.stdout.text).result.connected, true);
    assert.doesNotMatch(deps.stdout.text, /\u001b/);
    assert.equal(deps.stderr.text, "");
  }
});

test("plain forces readable text; color preferences never change the output format", async () => {
  for (const [args, tty, env] of [
    [["status", "--plain"], false, {}], [["status", "--no-color"], true, {}],
    [["status"], true, { NO_COLOR: "" }], [["status"], true, { TERM: "dumb" }], [["status"], true, { FORCE_COLOR: "0" }],
  ]) {
    const deps = setup({ tty, env });
    await main(args, deps);
    assert.match(deps.stdout.text, /Connected to qz/);
    assert.doesNotMatch(deps.stdout.text, /\u001b/);
  }
  const pipe = setup({ env: { FORCE_COLOR: "1" } });
  await main(["status", "--no-color"], pipe);
  assert.equal(JSON.parse(pipe.stdout.text).ok, true);
});

test("MCP always prints a bare URL except explicit JSON; help stays readable in pipes", async () => {
  for (const tty of [true, false]) {
    const deps = setup({ tty });
    await main(["mcp"], deps);
    assert.equal(deps.stdout.text, `${running.endpoint}/mcp\n`);
    assert.equal(deps.stderr.text, "");
  }
  const help = setup();
  await main(["create", "--help"], help);
  assert.match(help.stdout.text, /qz create.*PROMPT/);
  const json = setup({ tty: true });
  await main(["create", "--help", "--json"], json);
  assert.match(JSON.parse(json.stdout.text).result.help, /--stream/);
  assert.doesNotMatch(json.stdout.text, /\u001b/);
});

test("human errors use stderr, JSON errors use stdout, argument errors exit 2", async () => {
  for (const [args, tty, json] of [
    [["create"], true, false], [["create"], false, true], [["create", "--plain"], false, false], [["create", "--json"], true, true],
  ]) {
    const deps = setup({ tty });
    assert.equal(await main(args, deps), 2);
    assert.equal(json ? deps.stderr.text : deps.stdout.text, "");
    const text = json ? deps.stdout.text : deps.stderr.text;
    assert.match(text, /prompt/i);
    assert.doesNotMatch(text, /qz install/);
    if (json) assert.equal(JSON.parse(text).error.code, "invalid_arguments");
  }
  const tool = setup({ tty: true, callTool: async () => { throw Object.assign(new Error("Page failed"), { code: "tool_error" }); } });
  assert.equal(await main(["send", "task-1", "Read the article"], tool), 1);
  assert.match(tool.stderr.text, /Page failed/);
  assert.doesNotMatch(tool.stderr.text, /qz install/);
});

test("stdin prompt is validated before discovery and is submitted only once", async () => {
  const calls = [];
  const deps = setup({ readStdin: async () => "  Read this page\n", callTool: async (...args) => { calls.push(args); return created; } });
  assert.deepEqual((await runCli(["create", "-", "-t", "Research"], deps)).result, { ...created, clientId: "fixture" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "qingzhou_create_session");
  assert.equal(calls[0][2].firstMessage, "  Read this page\n");
  assert.equal(calls[0][2].title, "Research");
  await assert.rejects(runCli(["create", "-"], { readStdin: async () => " \n", findDaemon: () => assert.fail("validate stdin first") }),
    error => error.code === "invalid_arguments");
});

test("stream receives increments before completion and suppresses duplicate final output", async () => {
  let polls = 0;
  const calls = [], updates = [];
  const deps = setup({ tty: true, env: { NO_COLOR: "1" },
    onTaskUpdate: event => updates.push(event),
    callTool: async (_endpoint, name, args, options) => {
      calls.push(name);
      if (name === "qingzhou_create_session") return created;
      assert.equal(args.compact, false);
      assert.equal(args.tail, false);
      assert.equal(args.includeArtifacts, false);
      assert.equal(args.clientId, "fixture");
      assert.ok(options.signal);
      assert.ok(args.timeoutSeconds <= 5);
      if (++polls === 1) return snapshot("running", "Hello");
      assert.match(deps.stdout.text, /Hello/);
      return snapshot("completed", "Hello world");
    } });
  assert.equal(await main(["create", "Say hello", "--stream", "--client", "fixture", "--timeout", "5"], deps), 0);
  assert.equal(calls.filter(name => name === "qingzhou_create_session").length, 1);
  assert.equal(deps.stdout.text.match(/Hello world/g)?.length, 1);
  assert.match(deps.stdout.text, /Completed/);
  assert.deepEqual(updates.filter(event => event.type === "text").map(event => event.text), ["Hello", " world"]);
});

test("wait returns final result; JSON stream produces exactly one complete document", async () => {
  for (const args of [["--wait", "--plain"], ["--stream", "--json"]]) {
    const deps = setup({ tty: true, callTool: async (_endpoint, name) => name === "qingzhou_create_session" ? created : snapshot("completed", "Final response") });
    assert.equal(await main(["create", "Finish", ...args], deps), 0);
    if (args.includes("--json")) {
      assert.equal(JSON.parse(deps.stdout.text).result.snapshot.status, "completed");
      assert.equal(deps.stdout.text.split("\n").filter(Boolean).length, 1);
      assert.equal(deps.stderr.text, "");
    } else {
      assert.match(deps.stdout.text, /Final response/);
      assert.doesNotMatch(deps.stdout.text + deps.stderr.text, /\u001b/);
    }
  }
});

test("waiting stays bound to the creating browser across connection changes", async () => {
  const clients = [{ clientId: "creator" }];
  const methods = [];
  const deps = setup({
    findDaemon: async () => ({ ...running, health: { features: { browserPairing: 1 }, status: { connected: true, clients } } }),
    callTool: async (_endpoint, name, args) => {
      methods.push(name);
      assert.equal(args.clientId, "creator");
      if (name === "qingzhou_create_session") {
        clients.splice(0, 1, { clientId: "another-profile" });
        return created;
      }
      return snapshot("completed", "Done");
    },
  });
  assert.equal((await runCli(["create", "Work", "--wait"], deps)).result.snapshot.status, "completed");
  assert.equal(methods.length, 2);
});

test("human wait and stream remain connected through repeated questions and resume naturally", async () => {
  for (const flag of ["--wait", "--stream"]) {
    let polls = 0;
    const waiting = setup({ tty: true, env: { NO_COLOR: "1" }, callTool: async (_endpoint, name) => {
      if (name === "qingzhou_create_session") return created;
      polls++;
      if (polls <= 2) return snapshot("waiting_user", "", { runtime: { status: "waiting_user", waitId: "city",
        waitTitle: "Choose a city", waitMessage: "Hangzhou or Shanghai?" } });
      assert.equal(waiting.stdout.text.match(/Hangzhou or Shanghai/g)?.length, 1);
      if (polls === 3) return snapshot("running", "Checking the destination.");
      if (polls === 4) return snapshot("waiting_user", "", { runtime: { status: "waiting_user", waitId: "confirm",
        waitTitle: "Confirm itinerary", waitMessage: "Ready to continue?" } });
      assert.equal(waiting.stdout.text.match(/Ready to continue/g)?.length, 1);
      return snapshot("completed", "Your itinerary is ready.");
    } });
    assert.equal(await main(["create", "Ask a question", flag, "--timeout", "10"], waiting), 0);
    assert.equal(polls, 5);
    assert.match(waiting.stdout.text, /Waiting for you/);
    assert.match(waiting.stdout.text, /qz approve task-1/);
    assert.match(waiting.stdout.text, /Resumed/);
    assert.match(waiting.stdout.text, /Completed/);
    assert.equal(waiting.stdout.text.match(/Your itinerary is ready/g)?.length, 1);
  }
});

test("JSON waits report actionable pauses only on stderr and emit the final document after completion", async () => {
  let polls = 0;
  const deps = setup({ callTool: async () => {
    polls++;
    assert.equal(deps.stdout.text, "", "stdout remains empty while waiting");
    if (polls <= 2) return snapshot("waiting_user", "Assistant text is not a stderr log.", {
      runtime: { status: "waiting_user", waitId: "wait-1" }, input: {
        sessionId: "task-1", waitId: "wait-1", waiting: true, kind: "form", title: "Choose destination",
        form: { fields: [{ id: "city", label: "City", type: "single_choice", options: [{ value: "hz", label: "Hangzhou" }] }] },
        responseTemplate: { sessionId: "task-1", waitId: "wait-1", action: "submit", answers: { city: "<option value>" } },
      },
    });
    assert.equal(deps.stderr.text.match(/Waiting for you/g)?.length, 1);
    if (polls === 3) return snapshot("running", "Working.");
    return snapshot("completed", "Finished.");
  } });
  assert.equal(await main(["watch", "task-1", "--stream", "--json", "--timeout", "5"], deps), 0);
  assert.equal(JSON.parse(deps.stdout.text).result.snapshot.status, "completed");
  assert.equal(deps.stdout.text.split("\n").filter(Boolean).length, 1);
  assert.match(deps.stderr.text, /Field ID  city/);
  assert.match(deps.stderr.text, /Value  "hz"/);
  assert.match(deps.stderr.text, /qz submit task-1 '\{"city":"<option value>"\}' --wait-id wait-1 --client fixture --wait/);
  assert.match(deps.stderr.text, /Task resumed/);
  assert.doesNotMatch(deps.stderr.text, /Assistant text|Working\.|Finished\./);
});

// Advance polling timers without sleeping, while each test controls elapsed wall-clock time.
async function withMockPollingTimers(t, operation) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  let settled = false, value, failure;
  const pending = operation().then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
  for (let turns = 0; !settled && turns < 100; turns++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(750);
  }
  assert.equal(settled, true, "the synthetic snapshot sequence should finish without real polling delays");
  await pending;
  if (failure) throw failure;
  return value;
}

for (const argv of [["create", "Wait for a choice", "--stream"], ["watch", "task-1"],
  ["submit", "task-1", '{"city":"hangzhou"}', "--wait"]]) {
  test(`${argv[0]} keeps observing past 180 seconds by default with bounded individual requests`, async t => {
    let now = 1_000_000, polls = 0;
    t.mock.method(Date, "now", () => now);
    const methods = [], updates = [];
    const deps = setup({ onTaskUpdate: update => updates.push(update), callTool: async (_endpoint, name, args, options) => {
      methods.push(name);
      assert.ok(Number.isFinite(args.timeoutSeconds) && args.timeoutSeconds > 0 && args.timeoutSeconds <= 180,
        `${name} must receive a finite per-request timeout`);
      assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 180_000);
      assert.equal(args.clientId, "fixture");
      if (name === "qingzhou_create_session") return created;
      if (name === "qingzhou_get_user_input") return pendingInput;
      if (name === "qingzhou_respond_to_user_input") return {
        accepted: true, sessionId: "task-1", runId: "run-1", waitId: "wait-1",
      };
      assert.equal(name, "qingzhou_get_session_snapshot");
      now += 120_000;
      if (++polls === 1) return snapshot("waiting_user", "", {
        runtime: { status: "waiting_user", runId: "run-1", waitId: "wait-2" },
        input: { ...pendingInput, waitId: "wait-2" },
      });
      if (polls === 2) return snapshot("running", "Continuing after the user's response.");
      return snapshot("completed", "Task completed after a long wait.");
    } });
    const code = await withMockPollingTimers(t, () => main([...argv, "--json"], deps));
    assert.equal(code, 0, deps.stdout.text);
    const output = JSON.parse(deps.stdout.text);
    assert.equal(output.result.snapshot.status, "completed");
    assert.equal(polls, 3);
    assert.ok(now - 1_000_000 > 180_000, "total observation may exceed each individual request budget");
    assert.deepEqual(updates.filter(update => update.type === "status").map(update => update.status), ["waiting_user", "running", "completed"]);
    assert.match(deps.stderr.text, /Waiting for you/);
    assert.match(deps.stderr.text, /Task resumed/);
    assert.equal(methods.filter(name => name === "qingzhou_create_session").length, argv[0] === "create" ? 1 : 0);
    assert.equal(methods.filter(name => name === "qingzhou_respond_to_user_input").length, argv[0] === "submit" ? 1 : 0);
    assert.equal(methods.includes("qingzhou_stop_session"), false);
    assert.equal(deps.stdout.text.trim().split("\n").length, 1);
  });
}

test("an explicit wait deadline reports observation timeout with same-task recovery", async t => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const methods = [];
  const deps = setup({ callTool: async (_endpoint, name, args, options) => {
    methods.push(name);
    assert.equal(name, "qingzhou_get_session_snapshot");
    assert.ok(args.timeoutSeconds > 0 && args.timeoutSeconds <= 5);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    now += 6000;
    return snapshot("waiting_user", "", { runtime: { status: "waiting_user", waitId: "wait-1" }, input: pendingInput });
  } });
  assert.equal(await withMockPollingTimers(t, () => main(["watch", "task-1", "--client", "fixture", "--timeout", "5"], deps)), 1);
  const error = JSON.parse(deps.stdout.text).error;
  assert.equal(error.code, "timeout");
  assert.equal(error.sessionId, "task-1");
  assert.match(error.message, /Stopped watching.*--timeout/i);
  assert.equal(error.clientId, "fixture");
  assert.match(error.command, /qz watch task-1.*--client fixture/);
  assert.doesNotMatch(error.command, /qz (create|cancel)/);
  assert.deepEqual(methods, ["qingzhou_get_session_snapshot"]);
});

for (const scenario of [
  { name: "equal deadlines", timeout: 5, elapsedMs: 0, expiresMs: 5000, code: "timeout" },
  { name: "less total time after sending", timeout: 5, elapsedMs: 2000, expiresMs: 3000, code: "timeout" },
  { name: "request timeout without a total deadline", elapsedMs: 0, expiresMs: 180000, code: "request_timeout" },
  { name: "caller cancellation", timeout: 5, elapsedMs: 2000, code: "interrupted" },
]) test(`CLI observation preserves request budgets and causes: ${scenario.name}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const controller = new AbortController();
  const reason = new DOMException("User stopped watching.", "AbortError");
  const readReady = Promise.withResolvers();
  const calls = [];
  const deps = setup({ signal: controller.signal, callTool: async (_endpoint, name, args, options) => {
    calls.push({ name, args, options });
    if (name === "qingzhou_send_message") {
      t.mock.timers.tick(scenario.elapsedMs);
      return { accepted: true, clientMessageId: "message-1" };
    }
    readReady.resolve({ args, options });
    return new Promise(() => {});
  } });
  const pending = main(["send", "task-1", "Keep working", "--wait", "--json",
    ...(scenario.timeout ? ["--timeout", String(scenario.timeout)] : [])], deps);
  const read = await readReady.promise;
  const requestSeconds = scenario.timeout ?? 180;
  assert.equal(read.args.timeoutSeconds, requestSeconds);
  assert.equal(read.options.timeoutMs, requestSeconds * 1000);
  if (scenario.code === "interrupted") controller.abort(reason);
  else t.mock.timers.tick(scenario.expiresMs);
  assert.equal(await pending, scenario.code === "interrupted" ? 130 : 1);
  const error = JSON.parse(deps.stdout.text).error;
  assert.equal(error.code, scenario.code);
  assert.equal(error.sessionId, "task-1");
  assert.match(error.command, /qz watch task-1.*--client fixture/);
  assert.equal(read.options.signal.aborted, true);
  if (scenario.code === "interrupted") assert.equal(read.options.signal.reason, reason);
  else if (scenario.code === "timeout") assert.equal(read.options.signal.reason.name, "TimeoutError");
  else assert.equal(read.options.signal.reason.code, "request_timeout");
  assert.deepEqual(calls.map(call => call.name), ["qingzhou_send_message", "qingzhou_get_session_snapshot"],
    "ending observation must neither stop the browser task nor replay its accepted message");
});

test("a timed-out snapshot request is distinguished from the total wait deadline", async () => {
  for (const failure of [new DOMException("The RPC exceeded its deadline.", "TimeoutError"),
    Object.assign(new Error("MCP request timed out"), { code: -32001 }),
    Object.assign(new Error("Extension did not respond"), { code: "BRIDGE_REQUEST_TIMEOUT" }),
    Object.assign(new Error("BRIDGE_REQUEST_TIMEOUT: Extension did not respond"), { code: "tool_error" })]) {
    const methods = [];
    const deps = setup({ callTool: async (_endpoint, name, args, options) => {
      methods.push(name);
      assert.equal(args.timeoutSeconds, 180);
      assert.equal(options.timeoutMs, 180_000);
      throw failure;
    } });
    assert.equal(await main(["watch", "task-1", "--client", "fixture"], deps), 1);
    const error = JSON.parse(deps.stdout.text).error;
    assert.equal(error.code, "request_timeout");
    assert.equal(error.sessionId, "task-1");
    assert.match(error.message, /(?:request|task status).*timed out/i);
    assert.equal(error.clientId, "fixture");
    assert.match(error.command, /qz watch task-1.*--client fixture/);
    assert.doesNotMatch(error.command, /qz (create|cancel)/);
    assert.deepEqual(methods, ["qingzhou_get_session_snapshot"]);
  }
});

test("failed runs have a nonzero exit", async () => {
  const failed = setup({ callTool: async (_endpoint, name) => name === "qingzhou_create_session" ? created : snapshot("error") });
  assert.equal(await main(["create", "Fail", "--wait"], failed), 1);
  assert.equal(JSON.parse(failed.stdout.text).result.snapshot.status, "error");
});

const pendingInput = { sessionId: "task-1", runId: "run-1", waiting: true, waitId: "wait-1", kind: "form",
  title: "Choose a city", message: "Select a destination.", form: { fields: [{ id: "city", label: "City", type: "single_choice", required: true,
    options: [{ value: "hangzhou", label: "Hangzhou" }, { value: "shanghai", label: "Shanghai" }] }] }, actions: ["submit", "reject"] };

test("show includes the full form and submit binds its wait identity before sending once", async () => {
  const calls = [];
  const deps = setup({ callTool: async (_endpoint, name, args) => {
    calls.push({ name, args });
    if (name === "qingzhou_get_session_snapshot") return { ...snapshot("waiting_user"), input: pendingInput };
    return name === "qingzhou_get_user_input" ? pendingInput : { accepted: true, sessionId: "task-1", runId: "run-1", waitId: args.waitId };
  } });
  assert.deepEqual((await runCli(["show", "task-1"], deps)).result.input, pendingInput);
  const response = await runCli(["submit", "task-1", '{"city":"hangzhou"}'], deps);
  assert.equal(response.result.accepted, true);
  assert.deepEqual(calls.map(call => call.name), ["qingzhou_get_session_snapshot", "qingzhou_get_user_input", "qingzhou_respond_to_user_input"]);
  assert.deepEqual(calls.at(-1).args, { timeoutSeconds: 180, clientId: "fixture", sessionId: "task-1", waitId: "wait-1", action: "submit", answers: { city: "hangzhou" } });
});

test("explicit wait IDs cannot silently rebind to a newer question; rejected input exits nonzero", async () => {
  for (const command of ["submit", "approve", "reject"]) {
    const calls = [];
    const deps = setup({ callTool: async (_endpoint, name, args) => {
      calls.push({ name, args });
      if (name === "qingzhou_get_user_input") return { ...pendingInput, kind: "location_consent", waitId: "new-wait", consentVersion: 2 };
      assert.equal(name, "qingzhou_respond_to_user_input");
      return { accepted: false, stale: true, code: "STALE_WAIT", sessionId: args.sessionId, waitId: args.waitId };
    } });
    assert.equal(await main([command, "task-1", ...(command === "submit" ? ["{}"] : []), "--wait-id", "old-wait"], deps), 1);
    assert.equal(calls.length, command === "approve" ? 2 : 1);
    assert.equal(calls.at(-1).args.waitId, "old-wait");
    assert.equal(calls.at(-1).args.action, command);
    assert.equal(Object.hasOwn(calls.at(-1).args, "consentVersion"), false);
    assert.equal(JSON.parse(deps.stdout.text).result.stale, true);
  }
});

test("form stdin is validated before discovery; missing input never sends a mutation", async () => {
  for (const source of ["[]", "null", "not json", ""]) {
    await assert.rejects(runCli(["submit", "task-1", "-"], { readStdin: async () => source, findDaemon: () => assert.fail("validate answers first") }),
      error => error.code === "invalid_arguments");
  }
  const methods = [];
  await assert.rejects(runCli(["approve", "task-1"], setup({ callTool: async (_endpoint, name) => {
    methods.push(name); return { sessionId: "task-1", waiting: false };
  } })), error => error.code === "not_waiting");
  assert.deepEqual(methods, ["qingzhou_get_user_input"]);
  const deps = setup({ readStdin: async () => '{"city":"hangzhou"}', callTool: async (_endpoint, _name, args) => {
    assert.deepEqual(args.answers, { city: "hangzhou" }); return { accepted: true };
  } });
  assert.equal((await runCli(["submit", "task-1", "-", "--wait-id", "wait-1"], deps)).result.accepted, true);
});

test("approval waits through an old snapshot, stays in its browser, and emits one final JSON", async () => {
  const methods = [];
  let polls = 0;
  const deps = setup({ callTool: async (_endpoint, name, args) => {
    methods.push(name);
    assert.equal(args.clientId, "fixture");
    if (name === "qingzhou_get_user_input") return { ...pendingInput, kind: "confirmation" };
    if (name === "qingzhou_respond_to_user_input") return { accepted: true, sessionId: "task-1", runId: "run-1", waitId: "wait-1" };
    if (++polls === 1) return snapshot("waiting_user", "Previous question", { runtime: { status: "waiting_user", waitId: "wait-1" } });
    return snapshot("completed", "Done after approval");
  } });
  assert.equal(await main(["approve", "task-1", "--stream", "--timeout", "5"], deps), 0);
  assert.equal(polls, 2);
  assert.equal(methods.filter(name => name === "qingzhou_respond_to_user_input").length, 1);
  assert.equal(JSON.parse(deps.stdout.text).result.snapshot.status, "completed");
  assert.equal(deps.stdout.text.split("\n").filter(Boolean).length, 1);
  assert.equal(deps.stderr.text, "");
});

test("native approvals stay connected with wait or stream until the user responds in Chrome", async () => {
  for (const flag of ["--wait", "--stream"]) {
    const methods = [];
    let polls = 0;
    const deps = setup({ tty: true, openBrowser: () => assert.fail("native permission must not open a page"), callTool: async (_endpoint, name) => {
      methods.push(name);
      if (name === "qingzhou_get_user_input") return { ...pendingInput, kind: "browser_permission" };
      if (name === "qingzhou_respond_to_user_input") return { accepted: false, requiresUserAction: true,
        code: "BROWSER_PERMISSION_REQUIRED", sessionId: "task-1", runId: "run-1", message: "Confirm in the qz side panel." };
      assert.equal(name, "qingzhou_get_session_snapshot");
      if (++polls <= 2) return snapshot("waiting_user", "", { runtime: { status: "waiting_user", waitId: "wait-1",
        waitTitle: "Allow history", waitForm: { browserPermission: "history" } } });
      assert.equal(deps.stdout.text.match(/review and grant this permission/g)?.length, 1);
      return snapshot("completed", "Permission granted in Chrome.");
    } });
    assert.equal(await main(["approve", "task-1", "--wait-id", "wait-1", flag, "--timeout", "5"], deps), 0);
    assert.equal(methods.filter(name => name === "qingzhou_respond_to_user_input").length, 1);
    assert.equal(polls, 3);
    assert.match(deps.stdout.text, /Completed/);
    assert.doesNotMatch(deps.stdout.text, /Task continued|Answers submitted/);
  }
});

test("native approval without waiting returns guidance and validation failures never start watching", async () => {
  for (const native of [true, false]) {
    const methods = [];
    const deps = setup({ callTool: async (_endpoint, name) => {
      methods.push(name);
      if (name === "qingzhou_get_user_input") return pendingInput;
      assert.equal(name, "qingzhou_respond_to_user_input");
      return { accepted: false, sessionId: "task-1", ...(native
        ? { requiresUserAction: true, code: "BROWSER_PERMISSION_REQUIRED" }
        : { code: "INVALID_ANSWERS", fieldErrors: [{ fieldId: "city", code: "required", message: "Choose a city." }] }) };
    } });
    const args = native ? ["approve", "task-1"] : ["submit", "task-1", "{}", "--wait"];
    assert.equal(await main(args, deps), native ? 0 : 1);
    assert.deepEqual(methods, ["qingzhou_get_user_input", "qingzhou_respond_to_user_input"]);
    assert.equal(JSON.parse(deps.stdout.text).result.accepted, false);
  }
});

test("native JSON waits show pending guidance on stderr and return the observed final status", async () => {
  let polls = 0;
  const deps = setup({ callTool: async (_endpoint, name) => {
    if (name === "qingzhou_get_user_input") return { ...pendingInput, kind: "browser_permission" };
    if (name === "qingzhou_respond_to_user_input") return {
      accepted: false, requiresUserAction: true, code: "BROWSER_PERMISSION_REQUIRED", sessionId: "task-1", runId: "run-1",
    };
    assert.equal(deps.stdout.text, "");
    if (++polls === 1) return snapshot("waiting_user", "", { runtime: { status: "waiting_user", waitId: "wait-1",
      waitForm: { browserPermission: "history" } } });
    assert.match(deps.stderr.text, /Open the qz side panel to review and grant this permission/);
    return snapshot("completed", "Done.");
  } });
  assert.equal(await main(["approve", "task-1", "--wait", "--timeout", "5"], deps), 0);
  const result = JSON.parse(deps.stdout.text).result;
  assert.equal(result.snapshot.status, "completed");
  assert.equal(result.sessionId, "task-1");
  assert.equal(Object.hasOwn(result, "accepted"), false);
  assert.equal(Object.hasOwn(result, "requiresUserAction"), false);
  assert.equal(Object.hasOwn(result, "code"), false);
});

test("location approval shows the current notice before mutation and binds its consent version", async () => {
  for (const json of [false, true]) {
    const methods = [], shown = [];
    const notice = { sessionId: "task-1", runId: "run-1", waitId: "location-1", waiting: true,
      kind: "location_consent", consentVersion: 3, title: "Share location", message: "Coordinates go to your chosen model provider.",
      form: { locationConsent: true }, actions: ["approve", "reject"] };
    const deps = setup({ tty: true, env: { NO_COLOR: "1" }, onUserInput: input => shown.push(input),
      callTool: async (_endpoint, name, args) => {
        methods.push(name);
        if (name === "qingzhou_get_user_input") return notice;
        assert.equal(shown.length, 1, "the notice callback runs before accepting consent");
        assert.equal(deps.stdout.text.includes(notice.message), !json);
        assert.equal(args.consentVersion, 3);
        assert.equal(args.waitId, "location-1");
        assert.equal(args.action, "approve");
        return { accepted: true, sessionId: "task-1", runId: "run-1", waitId: "location-1" };
      } });
    assert.equal(await main(["approve", "task-1", "--wait-id", "location-1", ...(json ? ["--json"] : [])], deps), 0);
    assert.deepEqual(methods, ["qingzhou_get_user_input", "qingzhou_respond_to_user_input"]);
    if (json) {
      assert.equal(JSON.parse(deps.stdout.text).result.accepted, true);
      assert.equal(deps.stdout.text.split("\n").filter(Boolean).length, 1);
    } else {
      assert.match(deps.stdout.text, /Coordinates go to your chosen model provider/);
      assert.match(deps.stdout.text, /Task continued/);
    }
  }
});

test("a missing consent version or an interrupted notice cannot grant location access", async () => {
  for (const version of [undefined, null, "1", 0, -1, 1.2]) {
    const methods = [];
    await assert.rejects(runCli(["approve", "task-1"], setup({ callTool: async (_endpoint, name) => {
      methods.push(name); return { ...pendingInput, kind: "location_consent", consentVersion: version };
    } })), error => error.code === "invalid_response");
    assert.deepEqual(methods, ["qingzhou_get_user_input"]);
  }
  const controller = new AbortController();
  const methods = [];
  await assert.rejects(runCli(["approve", "task-1"], setup({ signal: controller.signal,
    onUserInput: () => controller.abort(), callTool: async (_endpoint, name) => {
      methods.push(name); return { ...pendingInput, kind: "location_consent", consentVersion: 1 };
    } })), error => error.name === "AbortError");
  assert.deepEqual(methods, ["qingzhou_get_user_input"]);
});

test("watch observes an existing task without creating or resuming it", async () => {
  const methods = [];
  const deps = setup({ tty: true, env: { NO_COLOR: "1" }, callTool: async (_endpoint, name, args) => {
    methods.push(name);
    assert.equal(args.sessionId, "task-1");
    return snapshot("completed", "Existing result");
  } });
  assert.equal(await main(["watch", "task-1", "--stream"], deps), 0);
  assert.deepEqual(methods, ["qingzhou_get_session_snapshot"]);
  assert.equal(deps.stdout.text.match(/Existing result/g)?.length, 1);
  assert.match(deps.stdout.text, /Completed/);
});

test("a failed response transport never retries approval or selects another wait", async () => {
  let mutations = 0;
  const deps = setup({ callTool: async (_endpoint, name) => {
    if (name === "qingzhou_get_user_input") return pendingInput;
    mutations++;
    throw Object.assign(new Error("Connection lost"), { code: "connection_error" });
  } });
  assert.equal(await main(["submit", "task-1", "{}", "--wait"], deps), 1);
  assert.equal(mutations, 1);
});

test("timeout or interruption after an accepted answer preserves the task and never repeats it", async () => {
  for (const interrupted of [false, true]) {
    const controller = new AbortController();
    const methods = [];
    const deps = setup({ signal: controller.signal, callTool: async (_endpoint, name) => {
      methods.push(name);
      if (name === "qingzhou_get_user_input") return pendingInput;
      if (name === "qingzhou_respond_to_user_input") {
        if (interrupted) controller.abort();
        return { accepted: true, sessionId: "task-1", runId: "run-1", waitId: "wait-1" };
      }
      return snapshot("running");
    } });
    assert.equal(await main(["submit", "task-1", '{"city":"hangzhou"}', "--wait", "--timeout", "0.05"], deps), interrupted ? 130 : 1);
    const error = JSON.parse(deps.stdout.text).error;
    assert.equal(error.sessionId, "task-1");
    assert.equal(error.code, interrupted ? "interrupted" : "timeout");
    assert.equal(methods.filter(name => name === "qingzhou_respond_to_user_input").length, 1);
    assert.equal(methods.includes("qingzhou_stop_session"), false);
  }
});

test("timeout and interruption preserve the task ID and never resubmit or cancel the task", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const methods = [];
    const deps = setup({ signal: controller.signal,
      onTaskCreated: () => { if (cancel) controller.abort(); },
      callTool: async (_endpoint, name) => { methods.push(name); return name === "qingzhou_create_session" ? created : snapshot("running"); },
    });
    assert.equal(await main(["create", "Keep working", "--wait", "--timeout", "0.1"], deps), cancel ? 130 : 1);
    const error = JSON.parse(deps.stdout.text).error;
    assert.equal(error.code, cancel ? "interrupted" : "timeout");
    assert.equal(error.sessionId, "task-1");
    assert.equal(error.clientId, "fixture");
    assert.match(error.command, /qz watch task-1.*--client fixture/);
    assert.doesNotMatch(error.command, /qz (create|cancel)/);
    assert.equal(methods.filter(method => method === "qingzhou_create_session").length, 1);
    assert.equal(methods.includes("qingzhou_stop_session"), false);
  }
});

test("live output sanitizes split control sequences, hides reasoning and labels revisions", () => {
  const stdout = stream(), stderr = stream();
  const live = createLiveOutput({ command: "tasks", action: "create", options: { stream: true } }, { stdout, stderr });
  live.update({ type: "text", messageId: "a", fullText: "Hi\u001b[" });
  live.update({ type: "text", messageId: "a", fullText: "Hi\u001b[31m there\u001b[0m" });
  live.update({ type: "replace", messageId: "a", fullText: "Corrected" });
  live.update({ type: "thinking", messageId: "thought", fullText: "Private reasoning" });
  live.update({ type: "status", status: "running", currentToolName: "read_article\u001b]52;c;payload\u0007" });
  live.finish();
  assert.doesNotMatch(stdout.text, /\u001b|payload|Private reasoning/);
  assert.match(stdout.text, /Revised response/);
  assert.match(stdout.text, /Corrected/);
  assert.match(stdout.text, /read_article/);
});

test("Ctrl-C stops stdin reading without EOF for both prompts and JSON arguments", async () => {
  const cliUrl = new URL("../../services/mcp-bridge/src/cli.mjs", import.meta.url).href;
  for (const argv of [["create", "-"], ["send", "task-1", "-"], ["settings", "set", "-"], ["submit", "task-1", "-"]]) {
    const script = `import { main } from ${JSON.stringify(cliUrl)};
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      if (process.platform === 'win32') process.once('message', () => {
        process.disconnect();
        process.emit('SIGINT');
      });
      process.stdout.write('ready\\n');
      process.exitCode = await main(${JSON.stringify(argv)}, { signal: controller.signal });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe", ...(process.platform === "win32" ? ["ipc"] : [])],
    });
    let output = "", errors = "", interrupted = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => {
      output += text;
      if (!interrupted && output.startsWith("ready\n")) {
        interrupted = true;
        // Windows kill(SIGINT) terminates immediately; deliver the console event to the handler.
        if (process.platform === "win32") child.send("interrupt");
        else child.kill("SIGINT");
      }
    });
    child.stderr.on("data", text => { errors += text; });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(result, { code: 130, signal: null }, errors);
      assert.equal(JSON.parse(output.slice("ready\n".length)).error.code, "interrupted");
    } finally { clearTimeout(deadline); child.stdin.destroy(); }
  }
});

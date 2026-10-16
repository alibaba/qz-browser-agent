import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { renderError, renderHelp, renderResult, renderInputNotice, sanitizeTerminalText } from "../../services/mcp-bridge/src/terminal.mjs";
import { defaultShell, optionTerminator, shellArgument, shellQuote } from "../../services/mcp-bridge/src/shell.mjs";
import { parseCommand } from "../../services/mcp-bridge/src/args.mjs";

const taskId = "2d02892a-1111-4222-8333-0123456789ab";
const task = { id: taskId, title: "杭州网页研究与城市景点整理", status: "running", running: true };
const parsed = action => ({ command: "tasks", action });
const snapshot = {
  sessionId: taskId, session: task, status: "completed", runtime: { status: "completed" },
  tail: [{ type: "assistant", content: "Earlier response." }, { type: "thinking", text: "Hidden thinking" },
    { type: "assistant", content: "杭州研究完成。\nSources checked and saved." },
    { type: "tool", result: "Hidden tool output" }],
};

// Independent display-cell checks for the Latin/CJK/emoji fixtures used below.
function displayWidth(line) {
  return Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(stripVTControlCharacters(line)))
    .reduce((length, { segment }) => length + (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)
      || /[\u3000-\u9fff\uff00-\uffef]/u.test(segment) ? 2 : 1), 0);
}
function fits(text, width) {
  for (const line of text.split("\n")) {
    // Copyable commands retain their bytes; terminals wrap these lines visually.
    if (/^  qz (submit|approve|reject) /.test(stripVTControlCharacters(line))) continue;
    assert.ok(displayWidth(line) <= width, `Overflow at ${width}: ${JSON.stringify(line)}`);
  }
  assert.ok(text.endsWith("\n"));
  assert.ok(!text.endsWith("\n\n"));
}

test("help recommends direct creation, optional titles, waiting, and contextual commands", () => {
  const general = renderHelp();
  assert.match(general, /create "PROMPT"/);
  assert.match(general, /--stream/);
  assert.match(general, /--title Research --wait/);
  assert.match(general, /npm run qz -- COMMAND/);
  assert.match(renderHelp("create"), /title is optional/);
  assert.match(renderHelp("create"), /read stdin/);
  assert.match(renderHelp("create"), /--title, -t/);
  assert.match(renderHelp("create"), /--client ID \(-c\)/);
  assert.match(renderHelp("show"), /pending form/i);
  assert.match(general, /send TASK_ID "MESSAGE"/);
  assert.doesNotMatch(general, /send ID "MESSAGE"/);
  assert.match(renderHelp("send"), /--steer/);
  assert.match(renderHelp("send"), /next safe boundary/);
  assert.match(renderHelp("send"), /next run/);
  for (const name of ["", "create", "tasks", "show", "cancel", "submit", "approve", "reject", "watch", "connect", "install", "status", "stop", "mcp", "send", "data", "images", "skills", "settings", "automations"]) {
    assert.doesNotMatch(renderHelp(name), /qz run|qz tasks (create|list|get|stop)|Legacy|--prompt|--args|--client-id/);
    for (const width of [40, 80]) fits(renderHelp(name, { width }), width);
  }
});

test("task lists preserve complete IDs and real statuses at wide and narrow widths", () => {
  const sessions = [task, { ...task, id: "second", title: "Compare 👩🏽‍💻 laptops", status: "waiting_user", running: true }];
  for (const width of [40, 80]) {
    const result = renderResult(parsed("list"), { sessions }, { width });
    assert.match(result, /Tasks · 2/);
    assert.match(result, /Running/);
    assert.match(result, /Waiting for you/);
    assert.ok(result.replaceAll("\n", "").includes(taskId));
    assert.match(result, /杭州/);
    fits(result, width);
  }
  const empty = renderResult({ command: "tasks" }, { sessions: [] });
  assert.match(empty, /No tasks yet/);
  assert.match(empty, /qz create/);
});

test("creation reports scheduling accurately and gives usable next commands", () => {
  const queued = renderResult(parsed("create"), { session: task, started: true });
  assert.match(queued, /Task queued/);
  assert.doesNotMatch(queued, /Completed|Running/);
  assert.ok(queued.includes(`qz show ${taskId}`));
  assert.ok(queued.includes(`qz cancel ${taskId}`));
  assert.match(renderResult(parsed("create"), { session: task, started: false }), /Task created/);
  fits(renderResult(parsed("create"), { session: task, started: true }, { width: 40 }), 40);
});

test("show selects only the latest assistant response and preserves its paragraphs", () => {
  const result = renderResult(parsed("get"), snapshot);
  assert.match(result, /Completed/);
  assert.match(result, /Latest response/);
  assert.match(result, /杭州研究完成。\nSources checked and saved\./);
  assert.doesNotMatch(result, /Earlier response|Hidden thinking|Hidden tool output|transcript/);
  assert.match(renderResult(parsed("get"), { ...snapshot, transcript: snapshot.tail, tail: [{ type: "tool", result: "Last tool" }] }), /Sources checked/);
  const blocks = renderResult(parsed("get"), { ...snapshot, transcript: [{ type: "assistant", content: [
    { type: "text", text: "Text block response" }, { type: "thinking", text: "Secret reasoning" }, { type: "image", url: "Secret image" },
  ] }] });
  assert.match(blocks, /Text block response/);
  assert.doesNotMatch(blocks, /Secret reasoning|Secret image/);
  fits(renderResult(parsed("get"), snapshot, { width: 40 }), 40);
});

test("waited creation shows actual status; streamed creation suppresses repeated text", () => {
  const result = { session: task, started: true, snapshot };
  const waited = renderResult({ ...parsed("create"), options: { wait: true } }, result);
  assert.match(waited, /Completed/);
  assert.match(waited, /Sources checked/);
  assert.doesNotMatch(waited, /qz cancel/);
  const streamed = renderResult({ ...parsed("create"), presentation: { streamed: true } }, result);
  assert.match(streamed, /Completed/);
  assert.doesNotMatch(streamed, /Latest response|Sources checked/);
});

test("waiting and stopped tasks retain runtime truth", () => {
  const waiting = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", isStreaming: true,
    runtime: { status: "waiting_user", waitTitle: "Location permission", waitMessage: "Choose whether to share your location.", waitForm: { browserPermission: "history" } } });
  assert.match(waiting, /Waiting for you/);
  assert.match(waiting, /Location permission/);
  assert.match(waiting, /Open the qz side panel/);
  assert.doesNotMatch(waiting, /Running/);
  for (const status of ["waitingUser", "paused"]) {
    assert.match(renderResult(parsed("get"), { ...snapshot, status }), /qz approve/);
  }
  const stopped = renderResult({ ...parsed("stop"), id: taskId }, { sessionId: taskId, stopped: true, status: "cancelled" });
  assert.match(stopped, /Task stopped/);
  assert.match(stopped, /Cancelled/);
  const inactive = renderResult(parsed("stop"), { sessionId: taskId, stopped: false, status: "completed" });
  assert.match(inactive, /no active run/);
  assert.match(inactive, /Completed/);
  assert.doesNotMatch(inactive, /Task stopped|Cancelled/);
});

test("show renders complete field choices and metadata without terminal controls", () => {
  const input = { sessionId: taskId, waiting: true, waitId: "wait-1", kind: "form", title: "Choose a role", message: "Compare the options.",
    form: { fields: [{ id: "selectedIds", label: "Available roles", type: "multi_choice", required: true, help: "Choose one or more.",
      defaultValues: ["job-a"], options: [{ value: "job-a", label: "Platform engineer", description: "Own the deployment workflow.",
        meta: ["Remote · EU", { label: "Salary", value: "€100k" }], url: "https://example.com/job-a", imageUrl: "https://example.com/logo.png" },
      { value: "job-b", label: "Backend engineer\u001b]52;c;SECRET\u0007" }] },
      { id: "note", label: "Anything else?", type: "textarea", placeholder: "Your note", required: false }] } };
  for (const width of [40, 80]) {
    const text = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", input }, { width });
    assert.match(text, /Field ID  selectedIds/);
    assert.match(text, /Type  multi_choice/);
    assert.match(text, /Required  yes/);
    assert.match(text, /Value  "job-a"\nLabel  Platform engineer/);
    assert.match(text, /Value  "job-b"\nLabel  Backend engineer/);
    assert.match(text, /Default  \["job-a"\]/);
    assert.match(text, /Remote · EU/);
    assert.match(text, /Salary  €100k/);
    assert.doesNotMatch(text, /\[object Object\]/);
    assert.match(text, /https:\/\/example.com\/logo.png/);
    assert.match(text, /Anything else/);
    assert.match(text, /qz submit/);
    assert.match(text, /'\{"selectedIds":\["job-a"\],"note":"<text>"\}'/);
    assert.match(text, /qz reject/);
    assert.doesNotMatch(text, /SECRET|\u001b/);
    fits(text, width);
  }
});

test("pending command templates retain the selected browser and backend required defaults", () => {
  const input = { sessionId: "task-1", waitId: "wait-1", waiting: true, kind: "form",
    form: { fields: [{ id: "city", type: "text", label: "City" }] } };
  for (const result of [renderResult({ ...parsed("get"), options: { "client-id": "profile-2" } }, { ...snapshot, status: "waiting_user", input }),
    renderResult({ command: "submit", options: { "client-id": "profile-2" } }, { accepted: false, input })]) {
    assert.match(result, /Required  yes/);
    assert.match(result, /--wait-id wait-1 --client profile-2 --wait/);
    assert.match(result, /qz reject task-1 --wait-id wait-1 --client profile-2/);
  }
  assert.match(renderResult({ command: "submit", options: { "client-id": "profile-2" } },
    { accepted: true, sessionId: "task-1" }), /qz watch task-1 --client profile-2 --stream/);
});

test("submission templates preserve actual keys and shell quotes without hard wrapping JSON", { skip: process.platform === "win32" }, () => {
  const answers = { city: "Xi'an", note: "'; printf injected; # $(printf surprise) `printf oops`", choices: ["a'b"],
    controls: "\u001b]52;c;payload\u0007\u202e\u0085" };
  const input = { sessionId: "task-1", waiting: true, waitId: "wait-2", kind: "form",
    form: { fields: Object.keys(answers).map(id => ({ id, type: id === "choices" ? "multi_choice" : "text" })) },
    responseTemplate: { sessionId: "task-1", waitId: "wait-2", action: "submit", answers } };
  const text = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", input }, { width: 30, shell: "posix" });
  const command = text.split("\n").find(line => line.startsWith("  qz submit "));
  assert.ok(command.endsWith("--wait-id wait-2 --wait"));
  assert.match(text, /Edit the template/);
  assert.doesNotMatch(text, /FIELD_ID|[\u001b\u202e\u0085]/);
  const result = spawnSync("/bin/sh", ["-c", `qz() { printf '%s\\n' "$@"; }\n${command}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const argv = result.stdout.trimEnd().split("\n");
  assert.deepEqual(argv.slice(0, 2), ["submit", "task-1"]);
  assert.deepEqual(JSON.parse(argv[2]), answers);
  assert.deepEqual(argv.slice(3), ["--wait-id", "wait-2", "--wait"]);
});

test("show and rejected responses include the canonical current input and ready-to-edit template", () => {
  const input = { sessionId: "task-1", waiting: true, waitId: "new-wait", kind: "form", title: "Choose destination",
    form: { fields: [{ id: "city", label: "Destination", type: "single_choice", required: true,
      options: [{ value: "hz", label: "Hangzhou" }] }] },
    responseTemplate: { sessionId: "task-1", waitId: "new-wait", action: "submit", answers: { city: "<option value>" } } };
  const results = [renderResult(parsed("get"), { ...snapshot, sessionId: "task-1", status: "waiting_user", input,
    runtime: { waitId: "old-wait", waitTitle: "Old question", waitForm: { fields: [{ id: "oldField" }] } } }),
    ...["INVALID_ANSWERS", "STALE_WAIT"].map(code => renderResult({ command: "submit" }, {
      accepted: false, code, message: "Use the current form.", fieldErrors: [{ fieldId: "city", message: "Pick a city." }], input,
    }))];
  for (const result of results) {
    assert.match(result, /Field ID  city/);
    assert.match(result, /Value  "hz"/);
    assert.match(result, /qz submit task-1 '\{"city":"<option value>"\}' --wait-id new-wait --wait/);
    assert.doesNotMatch(result, /oldField|Old question|old-wait|qz input/);
  }
  const native = renderResult({ command: "approve" }, { accepted: false, requiresUserAction: true,
    input: { sessionId: "task-1", waitId: "native", waiting: true, kind: "browser_permission", requiresUserAction: true,
      instructions: "Click Allow in the qz side panel.", form: { browserPermission: "history" } } });
  assert.match(native, /Click Allow in the qz side panel/);
  assert.doesNotMatch(native, /qz input|qz approve/);
});

test("permission and declined responses cannot look like successful approval", () => {
  const permission = renderResult({ command: "approve", id: taskId }, { accepted: false, requiresUserAction: true,
    sessionId: taskId, taskUrl: "chrome-extension://id/sidepanel/sidepanel.html", message: "Review location sharing in Chrome." });
  assert.match(permission, /Action needed in Chrome/);
  assert.match(permission, /Review location sharing/);
  assert.match(permission, /chrome-extension/);
  assert.doesNotMatch(permission, /Task continued|Answers submitted/);
  const invalid = renderResult({ command: "submit", id: taskId }, { accepted: false, code: "INVALID_INPUT", fieldErrors: { city: "Choose a listed option." } });
  assert.match(invalid, /Input was not accepted/);
  assert.match(invalid, /Choose a listed option/);
  assert.match(invalid, /qz show/);
  const empty = renderResult(parsed("get"), { ...snapshot, input: { waiting: false, sessionId: taskId } });
  assert.match(empty, /Completed/);
  assert.doesNotMatch(empty, /qz submit|qz approve/);
});

test("location consent shows its disclosure and approval, while native permission directs the user to Chrome", () => {
  const input = { sessionId: "task-1", waiting: true, waitId: "wait-1", kind: "location_consent", title: "Location sharing",
    message: "Coordinates will be shared with your configured model provider.", form: { locationConsent: true }, actions: ["approve", "reject"] };
  const location = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", input });
  assert.match(location, /Coordinates will be shared/);
  assert.match(location, /qz approve task-1 --wait-id wait-1 --wait/);
  assert.match(location, /qz reject task-1 --wait-id wait-1/);
  assert.doesNotMatch(location, /Open the qz side panel/);
  const native = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", input: { ...input, kind: "browser_permission", form: { browserPermission: "history" } } });
  assert.match(native, /Open the qz side panel/);
  assert.doesNotMatch(native, /qz approve/);
});

test("connection, install, and service results offer concise next steps", () => {
  const connected = renderResult({ command: "connect" }, { connected: true, mcpUrl: "http://127.0.0.1:18765/mcp", clients: [{ clientId: "one" }] });
  assert.match(connected, /Connected to qz/);
  assert.match(connected, /http:\/\/127.0.0.1:18765\/mcp/);
  assert.doesNotMatch(connected, /clientId|"clients"/);
  assert.match(renderResult({ command: "status" }, { running: false, connected: false }), /qz connect/);
  assert.match(renderResult({ command: "status" }, { running: true, connected: false }), /browser disconnected/);
  const updateAvailable = renderResult({ command: "status" }, { running: true, connected: true, clientCount: 2, updateAvailable: true });
  assert.match(updateAvailable, /Service update available/);
  assert.match(updateAvailable, /qz stop && qz connect/);
  assert.match(renderResult({ command: "stop" }, { stopped: false }), /already stopped/);
  assert.match(renderResult({ command: "install" }, { opened: true, url: "https://example.com" }), /Install the extension in Chrome/);
});

test("status displays every full browser client ID for explicit profile selection", () => {
  const clients = [{ clientId: `qz-${taskId}`, capabilities: { privatePayload: "omit" } }, { clientId: "profile-b" }];
  for (const width of [40, 80]) {
    const text = renderResult({ command: "status" }, { running: true, connected: true, clientCount: 2, clients }, { width });
    assert.match(text, /Browsers  2/);
    assert.match(text, /Client  profile-b/);
    assert.ok(text.replace(/\s/g, "").includes(clients[0].clientId));
    assert.doesNotMatch(text, /capabilities|privatePayload|omit/);
    fits(text, width);
  }
});

test("untrusted ANSI, OSC clipboard, hyperlinks, control bytes, and bidi overrides are removed", () => {
  const attack = "Safe\x1b[31mRED\x1b[0m\x1b]52;c;YXR0YWNr\x07\x1b]8;;https://evil.invalid\x1b\\link\x1b]8;;\x1b\\\x00\b\u202e";
  const result = renderResult(parsed("get"), { ...snapshot, session: { title: attack }, tail: [{ type: "assistant", content: attack + "\nSecond line" }] });
  assert.match(result, /SafeREDlink/);
  assert.match(result, /\nSecond line/);
  assert.doesNotMatch(result, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]|YXR0YWNr|evil\.invalid/);
  const error = renderError({ error: { message: attack, hint: attack, url: attack, guide: attack } });
  assert.doesNotMatch(error, /\x1b|YXR0YWNr|evil\.invalid/);
  assert.equal(sanitizeTerminalText(attack + "\nSecond line"), "SafeREDlink\nSecond line");
  const colored = renderResult(parsed("list"), { sessions: [{ ...task, title: attack }] }, { color: true });
  assert.match(colored, /\x1b\[36m/);
  assert.doesNotMatch(colored, /\x1b\]|YXR0YWNr|evil\.invalid/);
  assert.equal(stripVTControlCharacters(colored), renderResult(parsed("list"), { sessions: [{ ...task, title: attack }] }));
});

test("errors retain actionable details and respect plain and color output", () => {
  const payload = { ok: false, error: { code: "connection_pending", message: "Open the connection page in Chrome.",
    url: "http://127.0.0.1:18765/qz-connect", hint: "Then run qz connect again.", guide: "https://example.com/guide" } };
  const plain = renderError(payload, { width: 40 });
  assert.match(plain, /Waiting for Chrome/);
  assert.match(plain, /Then run qz connect again/);
  const colored = renderError(payload, { color: true, width: 40 });
  assert.match(colored, /\x1b\[33m/);
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.match(renderError({ error: { message: "Invalid arguments" } }, { color: true }), /\x1b\[31m/);
  fits(plain, 40);
  fits(renderError(), 40);
});

test("suggested shell commands use placeholders for untrusted identifiers", () => {
  const output = renderResult(parsed("create"), { session: { id: "task; touch /tmp/bad", title: "Task" }, started: true });
  assert.match(output, /Task  task; touch \/tmp\/bad/);
  assert.match(output, /qz show TASK_ID/);
  assert.match(output, /qz cancel TASK_ID/);
  assert.doesNotMatch(output, /qz show task;/);

});


test("help advertises task-centric commands and omits removed CLI entry points", () => {
  for (const topic of ["", "show", "submit", "skills"]) {
    const help = renderHelp(topic);
    assert.doesNotMatch(help, /qz (?:input|tools|call|logs|downloads)\b/);
    assert.doesNotMatch(help, /^\s+(?:input|tools|call|logs|downloads)\s/m);
  }
  assert.match(renderHelp("show"), /TASK_ID/);
});

test("Windows command hints identify PowerShell and escape every supported apostrophe", () => {
  assert.equal(defaultShell("win32"), "powershell");
  assert.equal(defaultShell("darwin"), "posix");
  assert.equal(defaultShell("linux"), "posix");
  assert.equal(shellQuote("'‘’‚‛", "powershell"), "'''‘‘’’‚‚‛‛'");
  assert.equal(shellArgument("profile-1", "powershell"), "profile-1");
  assert.equal(optionTerminator("powershell"), "'--'");
  assert.equal(optionTerminator("posix"), "--");
  assert.throws(() => shellQuote("text", "cmd"), /Unsupported command shell/);
  for (const topic of ["", "submit", "data", "skills"]) {
    const text = renderHelp(topic, { shell: "powershell" });
    assert.equal(text.match(/PowerShell 7\.3\+/g)?.length, 1);
    assert.match(text, /qz\.ps1/);
    assert.match(text, /Version: qz --version \(-v\)/);
    fits(text, 80);
  }
  const text = renderResult({ command: "data", action: "list" }, { tables: [{ name: "-O'Brien’s 表" }] }, { shell: "powershell" });
  assert.match(text, /qz data export '--' '-O''Brien’’s 表'/);
  assert.match(text, /PowerShell 7\.3\+/);
  const notice = renderInputNotice({ sessionId: "task", waiting: true, kind: "form", responseTemplate: { answers: { city: "Xi'an" } } }, { shell: "powershell" });
  assert.match(notice, /qz submit task '\{"city":"Xi''an"\}' --wait/);
  assert.match(notice, /PowerShell 7\.3\+/);
});

const powershell = process.env.QZ_TEST_PWSH || "pwsh";
const powershellProbe = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", timeout: 15000 });
for (const shell of ["posix", "powershell"]) {
  const skip = shell === "posix" ? process.platform === "win32"
    : process.platform !== "win32" && powershellProbe.error?.code === "ENOENT" ? "PowerShell is not installed" : false;
  test(`${shell} generated commands roundtrip through a native Node process without executing argument contents`, { skip }, t => {
    if (shell === "powershell") {
      assert.equal(powershellProbe.status, 0, powershellProbe.stderr || powershellProbe.error?.message);
      const [major, minor] = powershellProbe.stdout.trim().split(".").map(Number);
      assert.ok(major > 7 || (major === 7 && minor >= 3), "PowerShell 7.3+ is required");
    }
    const directory = mkdtempSync(join(tmpdir(), "qz-shell-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const capture = join(directory, "capture.mjs");
    writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n');
    // The PowerShell wrapper matches npm's native Node invocation, including $args forwarding.
    writeFileSync(join(directory, "qz.ps1"), `& ${shellQuote(process.execPath, "powershell")} ${shellQuote(capture, "powershell")} $args\n`);
    const commands = [], expected = [];
    const names = ["杭州 O'Brien’s \"quoted\" 📄", "-leading-name", "--", "-quoted ' 表",
      "'; touch injected; # $(touch injected) `touch injected` & echo injected",
      "‘; New-Item injected; # ’ ‚ ‛ $(New-Item injected) $env:PATH %PATH%"];
    for (const name of names) {
      for (const command of ["data", "images", "skills", "automations"]) {
        const items = [{ name, key: name, id: name }];
        const result = { [command === "data" ? "tables" : command === "images" ? "collections" : command === "skills" ? "items" : "automations"]: items };
        const text = renderResult({ command, action: "list", options: { "client-id": "profile" } }, result, { shell, width: 30 });
        const action = command === "automations" ? "run" : "export";
        commands.push(text.split("\n").find(line => line.startsWith(`  qz ${command} ${action} `)));
        expected.push({ command, action, id: name });
      }
      const path = "-resources/O'Brien’s 文档 \"test\".md";
      const text = renderResult({ command: "skills", action: "read", id: name, options: { path, limit: 10, "client-id": "profile" } },
        { name, path, end: 10, truncated: true }, { shell, width: 30 });
      commands.push(text.split("\n").find(line => line.startsWith("  qz skills read ")));
      expected.push({ command: "skills", action: "read", id: name, path });
    }
    const answers = { "O'Brien’s field": "‘’; New-Item injected; # $(touch injected) `touch injected` \"杭州\" ",
      selected: ["--choice", "a'b"], controls: "\u001b]52;c;payload\u0007\u202e\u0085", lines: "one\ntwo" };
    const text = renderResult(parsed("get"), { ...snapshot, status: "waiting_user", input: {
      waiting: true, sessionId: "task", waitId: "wait", kind: "form", responseTemplate: { answers },
    } }, { shell, width: 30 });
    commands.push(text.split("\n").find(line => line.startsWith("  qz submit ")));
    expected.push({ command: "submit", id: "task", answers });
    assert.ok(commands.every(Boolean));
    const program = shell === "posix" ? "sh" : powershell;
    const script = shell === "posix"
      ? `qz() { ${shellQuote(process.execPath, shell)} ${shellQuote(capture, shell)} "$@"; }\n${commands.join("\n")}`
      : `$ErrorActionPreference = 'Stop'\n${commands.join("\n")}`;
    const args = shell === "posix" ? ["-c", script] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
    const result = spawnSync(program, args, { cwd: directory, encoding: "utf8", timeout: 30000,
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH || ""}` } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(existsSync(join(directory, "injected")), false);
    const actual = result.stdout.trim().split(/\r?\n/).map(line => parseCommand(JSON.parse(line)));
    assert.equal(actual.length, expected.length, result.stdout);
    for (let index = 0; index < expected.length; index++) {
      const { command, action, id, path, answers } = expected[index];
      assert.equal(actual[index].command, command);
      assert.equal(actual[index].action, action);
      assert.equal(actual[index].id, id);
      if (path) assert.equal(actual[index].options.path, path);
      if (answers) assert.deepEqual(JSON.parse(actual[index].options.args), answers);
      else assert.equal(actual[index].options["client-id"], "profile");
    }
  });
}

import { stripVTControlCharacters } from "node:util";
import { COMMANDS, commandOptions } from "./commands.mjs";
import { defaultShell, optionTerminator, shellArgument, shellQuote } from "./shell.mjs";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const palette = { accent: 36, muted: 90, error: 31, waiting: 33 };

// Remote pages and model responses are text, never terminal instructions.
export function sanitizeTerminalText(value) {
  // Early Node 22 versions do not strip OSC strings terminated by ESC + backslash.
  const text = String(value ?? "").replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "");
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "  ");
}
const clean = sanitizeTerminalText;

function single(value) { return clean(value).replace(/\s+/gu, " ").trim(); }
function commandArgument(value, placeholder) {
  const text = String(value ?? "");
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : placeholder;
}
function resourceArgument(value, placeholder, shell) {
  const text = String(value ?? "");
  if (!text || clean(text) !== text || /[\r\n]/.test(text)) return placeholder;
  return shellArgument(text, shell);
}
function resourceCommand(command, value, client = "", placeholder = "NAME", shell) {
  const argument = resourceArgument(value, placeholder, shell);
  return String(value).startsWith("-") ? `qz ${command}${client} ${optionTerminator(shell)} ${argument}` : `qz ${command} ${argument}${client}`;
}
function answerArgument(answers, shell) {
  const json = JSON.stringify(answers).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return shellQuote(json, shell);
}
function graphemes(value) { return Array.from(segmenter.segment(value), item => item.segment); }
function cellWidth(value) {
  if (/^\p{Mark}+$/u.test(value)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\uFE0F/u.test(value)) return 2;
  const point = value.codePointAt(0);
  return point >= 0x1100 && (point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3) || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19) || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60) || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x20000 && point <= 0x3fffd)) ? 2 : 1;
}
function measure(value) { return graphemes(value).reduce((sum, item) => sum + cellWidth(item), 0); }
function truncate(value, width) {
  const text = single(value);
  if (measure(text) <= width) return text;
  let result = "";
  for (const item of graphemes(text)) {
    if (measure(result) + cellWidth(item) > width - 1) break;
    result += item;
  }
  return `${result}…`;
}
function pad(value, width) { return value + " ".repeat(Math.max(0, width - measure(value))); }

function wrap(value, width) {
  return clean(value).split("\n").flatMap(paragraph => {
    const parts = graphemes(paragraph), lines = [];
    while (parts.length) {
      let length = 0, cells = 0, space = -1;
      while (length < parts.length && cells + cellWidth(parts[length]) <= width) {
        if (/\s/u.test(parts[length]) && cells > 0) space = length;
        cells += cellWidth(parts[length++]);
      }
      if (length === parts.length) { lines.push(parts.join("").trimEnd()); break; }
      const end = space > 0 ? space : Math.max(1, length);
      lines.push(parts.splice(0, end).join("").trimEnd());
      while (parts.length && /\s/u.test(parts[0])) parts.shift();
    }
    return lines.length ? lines : [""];
  });
}

function output({ color = false, width = 80, shell = defaultShell() } = {}) {
  const columns = Number.isFinite(width) ? Math.max(20, Math.floor(width)) : 80;
  const lines = [];
  let shellShown = false;
  const tint = (value, tone) => color && palette[tone] ? `\u001b[${palette[tone]}m${value}\u001b[0m` : value;
  return {
    width: columns,
    shell,
    line(value = "", tone) { lines.push(...wrap(value, columns).map(line => tint(line, tone))); },
    field(label, value) {
      if (value === undefined || value === null || value === "") return;
      const prefix = `${single(label)}  `;
      const content = wrap(value, Math.max(1, columns - measure(prefix)));
      lines.push(tint(prefix, "muted") + content[0]);
      lines.push(...content.slice(1).map(line => " ".repeat(measure(prefix)) + line));
    },
    shellNote() {
      if (shell !== "powershell" || shellShown) return;
      shellShown = true;
      this.line("Copy commands into PowerShell 7.3+ (pwsh), using npm's qz.ps1 launcher.", "muted");
    },
    command(command) { this.shellNote(); this.line(`  ${command}`, "accent"); },
    script(command) { this.shellNote(); lines.push(tint(`  ${clean(command)}`, "accent")); },
    finish() { return `${lines.join("\n").trimEnd()}\n`; },
  };
}

const statusLabels = {
  idle: "Idle", pending: "Queued", running: "Running", waiting_user: "Waiting for you",
  completed: "Completed", aborted: "Aborted", cancelled: "Cancelled", canceled: "Cancelled",
  error: "Error", interrupted: "Interrupted", waitingUser: "Waiting for you", paused: "Paused",
};
function taskStatus(task) {
  const value = task?.status || task?.runtime?.status || task?.state?.status;
  return value || (task?.pendingStart ? "pending" : task?.running || task?.isStreaming ? "running" : "idle");
}
function label(status) { return statusLabels[status] || single(status); }
function tone(status) {
  return ["waiting_user", "waitingUser", "paused", "pending", "interrupted"].includes(status) ? "waiting" : status === "error" ? "error" : "accent";
}
function taskCommands(out, id, { cancel = true, client = "" } = {}) {
  if (!id) return;
  out.line();
  out.script(`qz show ${commandArgument(id, "TASK_ID")}${client}`);
  if (cancel) out.script(`qz cancel ${commandArgument(id, "TASK_ID")}${client}`);
}
function latestResponse(snapshot) {
  const events = snapshot?.transcript?.length ? snapshot.transcript : snapshot?.tail || [];
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type !== "assistant") continue;
    const content = events[index].content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
    if (text.trim()) return text;
  }
}

function inputView(out, input, { heading = true, clientId = "" } = {}) {
  if (heading) out.line(input.waiting ? "Waiting for you" : "No pending input", input.waiting ? "waiting" : "accent");
  if (heading) out.field("Task", input.sessionId);
  if (!input.waiting) return;
  out.field("Wait", input.waitId);
  if (input.consentVersion !== undefined) out.field("Consent version", input.consentVersion);
  if (Array.isArray(input.actions)) out.field("Actions", input.actions.map(action => typeof action === "string" ? action : action?.action || action?.id || "").filter(Boolean).join(", "));
  const form = input.form || {};
  if (input.title || form.title) { out.line(); out.line(input.title || form.title, "waiting"); }
  if (input.message) out.line(input.message);
  for (const field of Array.isArray(form.fields) ? form.fields : []) {
    out.line(); out.field("Field ID", field.id);
    if (field.label) out.line(field.label);
    out.field("Type", field.type || "text");
    out.field("Required", field.required !== false ? "yes" : "no");
    if (field.help) out.line(field.help);
    if (field.placeholder) out.field("Hint", field.placeholder);
    const initial = field.defaultValue ?? field.defaultValues;
    if (initial !== undefined) out.field("Default", JSON.stringify(initial));
    for (const choice of Array.isArray(field.options) ? field.options : []) {
      out.line(); out.field("Value", JSON.stringify(choice.value ?? ""));
      if (choice.label) out.field("Label", choice.label);
      if (choice.description) out.line(`    ${choice.description}`);
      if (Array.isArray(choice.meta)) for (const meta of choice.meta) {
        if (meta && typeof meta === "object") out.field(meta.label || "Info", meta.value);
        else out.line(`    ${meta}`);
      }
      if (choice.url) out.field("Link", choice.url);
      if (choice.imageUrl) out.field("Image", choice.imageUrl);
    }
  }
  const id = commandArgument(input.sessionId, "TASK_ID");
  const wait = input.waitId ? ` --wait-id ${commandArgument(input.waitId, "WAIT_ID")}` : "";
  const selectedClient = input.clientId || clientId;
  const client = selectedClient ? ` --client ${commandArgument(selectedClient, "CLIENT_ID")}` : "";
  const native = input.kind === "browser_permission" || form.browserPermission;
  const template = input.responseTemplate;
  out.line();
  if (native) {
    const instructions = Array.isArray(input.instructions) ? input.instructions.join("\n") : input.instructions;
    out.line(instructions || "Open the qz side panel to review and grant this permission.", "waiting");
    if (input.taskUrl) out.field("Open", input.taskUrl);
  } else if (input.kind === "form" || form.fields?.length) {
    const answers = template?.answers || Object.fromEntries((form.fields || []).map(field => [field.id,
      field.defaultValue ?? field.defaultValues ?? (field.type === "multi_choice" ? ["<option value>"]
        : field.type === "single_choice" ? "<option value>" : "<text>") ]));
    out.line("Edit the template below, then run it in another terminal. Use option values for choices.");
    out.script(`qz submit ${id} ${answerArgument(answers, out.shell)}${wait}${client} --wait`);
  } else {
    out.line("After reviewing this request, approve in another terminal:");
    out.script(`qz approve ${id}${wait}${client} --wait`);
  }
  out.script(`qz reject ${id}${wait}${client}`);
}

/** Pending notices go to stderr while stdout is reserved for the final JSON. */
export function renderInputNotice(input, options = {}) {
  const out = output(options);
  inputView(out, input);
  return out.finish();
}

function formatUsage(usage) {
  if (!usage || typeof usage !== "object") return "";
  const count = value => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.max(0, Math.trunc(number))) : "0";
  };
  const cost = Number(usage.costUsd);
  const text = Number.isFinite(cost) ? cost.toFixed(6).replace(/\.?0+$/u, "") : "";
  const shown = ["inputTokens", "outputTokens", "cachedTokens", "costUsd", "modelCalls", "toolCalls", "screenshots", "contextCompressions"]
    .some(key => Number(usage[key]) > 0);
  if (!shown) return "";
  return [
    `input ${count(usage.inputTokens)}`,
    `output ${count(usage.outputTokens)}`,
    `cached ${count(usage.cachedTokens)}`,
    `cost $${text || "0"}`,
    `model calls ${count(usage.modelCalls)}`,
    `tool calls ${count(usage.toolCalls)}`,
    `screenshots ${count(usage.screenshots)}`,
    `compressions ${count(usage.contextCompressions)}`,
  ].join(", ");
}

function snapshotView(out, snapshot, { streamed = false, clientId = "" } = {}) {
  const status = taskStatus(snapshot);
  out.line(label(status), tone(status));
  out.field("Task", snapshot.sessionId || snapshot.session?.id);
  out.field("Title", single(snapshot.session?.title));
  const runtime = snapshot.runtime || snapshot.state?.runtime || {};
  if (["waiting_user", "waitingUser", "paused"].includes(status)) {
    inputView(out, snapshot.input || { sessionId: snapshot.sessionId || snapshot.session?.id, waiting: true,
      waitId: runtime.waitId, title: runtime.waitTitle, message: runtime.waitMessage, form: runtime.waitForm }, { heading: false, clientId });
  } else if (status === "error" && runtime.reason) out.field("Reason", runtime.reason);
  const response = latestResponse(snapshot);
  if (response && !streamed) {
    out.line(); out.line("Latest response", "muted"); out.line(response);
  }
  const usage = formatUsage(snapshot.usage);
  if (usage) out.field("Usage", usage);
}

function taskList(out, sessions, client = "") {
  out.line(`Tasks · ${sessions.length}`, "accent");
  if (!sessions.length) { out.line("No tasks yet."); out.script(`qz create "Summarize the current page."${client}`); return; }
  out.line();
  const idWidth = Math.max(2, ...sessions.map(task => measure(single(task.id || task.sessionId))));
  const titleWidth = out.width - idWidth - 18;
  if (out.width >= 68 && titleWidth >= 12) {
    out.line(`${pad("ID", idWidth)}  ${pad("STATUS", 14)}  TITLE`, "muted");
    for (const task of sessions) {
      out.line(`${pad(single(task.id || task.sessionId), idWidth)}  ${pad(label(taskStatus(task)), 14)}  ${truncate(task.title || "Untitled", titleWidth)}`);
    }
  } else {
    sessions.forEach((task, index) => {
      if (index) out.line();
      out.line(`${label(taskStatus(task))} · ${single(task.title || "Untitled")}`, tone(taskStatus(task)));
      out.field("ID", task.id || task.sessionId);
    });
  }
  out.line(); out.script(`qz show TASK_ID${client}`);
}

function resourceList(out, command, result, client) {
  const items = command === "data" ? result?.tables || [] : command === "images" ? result?.collections || []
    : result?.items || result?.skills || (result?.names || []).map(name => ({ name }));
  const title = { data: "Data tables", images: "Image collections", skills: "Skills" }[command];
  out.line(`${title} · ${items.length}`, "accent");
  if (!items.length) { out.line("No matching items."); return; }
  for (const item of items) {
    out.line(); out.field("Name", command === "images" ? item.key || item.name : item.name);
    if (item.displayName || item.title) out.field("Title", item.displayName || item.title);
    if (command === "skills") {
      out.field("Scope", item.scope);
      if (builtinSkill(item)) out.field("Package", "Built-in");
      if (item.description) out.line(truncate(item.description, out.width * 2));
    } else {
      out.field(command === "images" ? "Images" : "Rows", item.rowCount ?? item.count ?? item.itemCount);
      if (command === "data") out.field("Kind", item.kind);
    }
  }
  const first = items[0];
  const name = command === "images" ? first.key || first.name : first.name;
  const placeholder = command === "skills" ? "NAME" : command === "data" ? "TABLE" : "COLLECTION";
  out.line();
  if (command === "skills") out.script(resourceCommand("skills show", name, client, "NAME", out.shell));
  if (command === "skills") {
    const exportable = items.find(item => !builtinSkill(item));
    if (exportable) out.script(resourceCommand("skills export", exportable.name, client, "NAME", out.shell));
  } else out.script(resourceCommand(`${command} export`, name, client, placeholder, out.shell));
  if (command !== "skills") out.script(resourceCommand(`${command} delete`, name, client, placeholder, out.shell));
}

function builtinSkill(skill) { return skill?.builtin === true || skill?.builtIn === true || skill?.readOnly === true || skill?.scope === "system"; }

function downloadView(out, result) {
  out.line(result?.state === "complete" ? "Export downloaded" : "Export download started", "accent");
  out.field("File", result?.filename || result?.fileName);
  out.field("Download ID", result?.downloadId);
  out.field("State", result?.state);
  out.field("Bytes", result?.bytes);
  out.field("Images", result?.images);
  if (result?.missingImages) out.field("Missing images", result.missingImages);
  out.field("Path", result?.filepath || result?.path || result?.filePath);
  out.field("File URL", result?.fileUrl);
  if (!(result?.filepath || result?.path || result?.filePath || result?.fileUrl)) out.line("Find the file in Chrome downloads (chrome://downloads).");
}

function settingsView(out, result, client) {
  out.line(result?.updated ? "Settings updated" : "Settings", "accent");
  if (result?.updated) out.field("Updated", result.updated.join(", "));
  const entries = result?.key ? [[result.key, result.value]] : Object.entries(result?.config || {});
  for (const [key, value] of entries) out.field(key, typeof value === "string" ? value : JSON.stringify(value));
  const fields = result?.field ? [result.field] : result?.fields || [];
  if (fields.length) {
    out.line(); out.line("Editable fields", "muted");
    for (const field of fields) {
      out.line(`${field.key} · ${field.type}${field.secret ? " · write-only" : ""}`, "accent");
      if (field.description) out.line(field.description);
      if (field.values?.length) out.field("Values", field.values.join(", "));
    }
  }
  for (const [label, list] of [["Providers", result?.providers], ["Protocols", result?.customProtocols]]) {
    if (!list?.length) continue;
    out.line(); out.line(label, "muted");
    for (const item of list) {
      const auth = item.auth?.mode === "sign_in"
        ? item.auth.expired ? " · Session expired" : item.auth.loggedIn ? " · Signed in" : " · Sign in required" : "";
      out.line(`${item.id} · ${item.label}${auth}`);
    }
  }
  out.line(); out.script(`qz settings set KEY VALUE${client}`);
  out.line("Read a JSON patch from stdin for credentials:"); out.script(`qz settings set -${client}`);
}

/** Human output only. Machine output retains the original data in the CLI. */
export function renderResult(parsed, result, options = {}) {
  const out = output(options);
  const { command, action } = parsed;
  const clientId = parsed.presentation?.clientId || result?.clientId || parsed.options?.["client-id"] || "";
  const client = clientId ? ` --client ${commandArgument(clientId, "CLIENT_ID")}` : "";
  const presentation = { streamed: parsed.presentation?.streamed === true, clientId };
  if (command === "watch") snapshotView(out, result?.snapshot || result || {}, presentation);
  else if (["data", "images", "skills"].includes(command)) {
    if (action === "list") resourceList(out, command, result, client);
    else if (action === "export") downloadView(out, result);
    else if (action === "read") {
      out.line(result?.path || parsed.options?.path || "Skill resource", "accent");
      out.field("Skill", result?.name || parsed.id);
      if (result?.start !== undefined) out.field("Characters", `${result.start}–${result.end} / ${result.size}`);
      if (result?.content !== undefined) { out.line(); out.line(result.content); }
      else { out.line(); out.line(JSON.stringify(result, null, 2)); }
      if (result?.truncated && Number.isSafeInteger(result.end) && result.end >= 0) {
        out.line(); out.line("Next chunk:");
        const name = result?.name || parsed.id, path = result?.path || parsed.options?.path;
        const args = `${resourceArgument(name, "NAME", out.shell)} ${resourceArgument(path, "PATH", out.shell)}`;
        const flags = ` --start ${result.end} --limit ${parsed.options?.limit || 20000}${client}`;
        out.script(String(name).startsWith("-") || String(path).startsWith("-") ? `qz skills read${flags} ${optionTerminator(out.shell)} ${args}` : `qz skills read ${args}${flags}`);
      }
    } else if (action === "tools") {
      const plugins = result?.plugins || [];
      out.line(`Skill contributions · ${plugins.length}`, "accent");
      if (!plugins.length) out.line("No Skill tools available.");
      for (const plugin of plugins) {
        out.line(); out.field("Skill", plugin.skillName || plugin.name);
        out.field("Status", plugin.active ? "Active" : "Inactive");
        for (const tool of plugin.tools || []) {
          out.field("Tool", tool.name);
          if (tool.description) out.line(truncate(tool.description, out.width * 2));
        }
      }
    } else if (action === "delete") {
      out.line(result?.deleted === false ? "Item was not deleted" : "Deleted", result?.deleted === false ? "waiting" : "accent");
      out.field("Name", result?.table || result?.collection || result?.name || parsed.id);
    } else {
      out.line(result?.name || parsed.id, "accent");
      if (result?.description) out.line(result.description);
      out.field("Scope", result?.scope);
      if (result?.content) { out.line(); out.line(result.content); }
      if (result?.resources?.length) {
        out.line(); out.line("Resources", "muted");
        for (const resource of result.resources) out.line(typeof resource === "string" ? resource : resource.path || resource.name);
      }
      if (!builtinSkill(result)) { out.line(); out.script(resourceCommand("skills export", result?.name || parsed.id, client, "NAME", out.shell)); }
    }
  } else if (command === "settings") settingsView(out, result, client);
  else if (command === "automations") {
    if (action === "run") {
      out.line("Automation started", "accent");
      out.field("Automation", result?.run?.automationId || parsed.id);
      out.field("Run", result?.run?.id);
      out.field("Task", result?.run?.sessionId);
      if (result?.run?.sessionId) out.script(`qz watch ${commandArgument(result.run.sessionId, "TASK_ID")}${client} --stream`);
    } else {
      const items = result?.automations || [];
      out.line(`Automations · ${items.length}`, "accent");
      if (!items.length) out.line("No automations.");
      for (const item of items) {
        out.line(); out.field("ID", item.id); out.field("Title", item.title || item.name);
        out.field("Status", item.enabled === false ? "Paused" : "Enabled"); out.field("Next run", item.nextRunAt);
      }
      if (items.length) { out.line(); out.script(resourceCommand("automations run", items[0].id, client, "ID", out.shell)); }
    }
  }
  else if (command === "send") {
    if (result?.snapshot) snapshotView(out, result.snapshot, presentation);
    else {
      out.line(result?.accepted ? result.disposition === "queued" ? "Message queued" : "Message accepted" : "Message was not accepted", result?.accepted ? "accent" : "waiting");
      out.field("Task", result?.sessionId || parsed.id);
      if (result?.message) out.line(result.message);
      if (result?.input?.waiting) inputView(out, result.input, { clientId });
      else out.script(`qz watch ${commandArgument(result?.sessionId || parsed.id, "TASK_ID")}${client} --stream`);
    }
  }
  else if (["submit", "approve", "reject"].includes(command)) {
    if (result?.snapshot) snapshotView(out, result.snapshot, presentation);
    else if (result?.requiresUserAction) {
      out.line("Action needed in Chrome", "waiting");
      out.field("Task", result.sessionId || parsed.id);
      out.line(result.message || "Open the qz side panel and review the permission request.");
      if (result.taskUrl) out.field("Open", result.taskUrl);
      if (result.input) { out.line(); inputView(out, result.input, { clientId }); }
      else out.script(`qz show ${commandArgument(result.sessionId || parsed.id, "TASK_ID")}${client}`);
    } else if (result?.accepted === true) {
      out.line(command === "reject" ? "Input rejected" : command === "submit" ? "Answers submitted" : "Task continued", "accent");
      out.field("Task", result.sessionId || parsed.id);
      out.script(`qz watch ${commandArgument(result.sessionId || parsed.id, "TASK_ID")}${client} --stream`);
    } else {
      out.line("Input was not accepted", "waiting");
      if (result?.message) out.line(result.message);
      if (result?.code) out.field("Code", result.code);
      const errors = result?.fieldErrors || result?.errors;
      if (errors) out.line(JSON.stringify(errors, null, 2));
      if (result?.input) { out.line(); inputView(out, result.input, { clientId }); }
      else out.script(`qz show ${commandArgument(result?.sessionId || parsed.id, "TASK_ID")}${client}`);
    }
  } else if (command === "tasks") {
    if (action === "list" || !action) taskList(out, result?.sessions || [], client);
    else if (action === "get") snapshotView(out, result || {}, presentation);
    else if (action === "create") {
      if (result?.snapshot) snapshotView(out, result.snapshot, presentation);
      else {
        out.line(result?.started ? "Task queued" : "Task created", "accent");
        out.field("Task", result?.session?.id);
        out.field("Title", single(result?.session?.title));
      }
      taskCommands(out, result?.session?.id || result?.snapshot?.sessionId, { client, cancel: !result?.snapshot || ["pending", "running", "waiting_user", "waitingUser", "paused"].includes(taskStatus(result.snapshot)) });
    } else if (action === "stop") {
      out.line(result?.stopped ? "Task stopped" : "Task has no active run", "accent");
      out.field("Task", result?.sessionId || parsed.id);
      if (result?.status) out.field("Status", label(result.status));
    }
  } else if (command === "browsers") {
    if (action === "forget") {
      out.line("Browser registration removed", "accent"); out.field("Name", result.name); out.field("UUID", result.clientId);
    } else {
      const browsers = result.browsers || [];
      out.line(`Browsers · ${browsers.length}`, "accent");
      for (const browser of browsers) { out.line(); out.field("Name", browser.name); out.field("UUID", browser.clientId); out.field("Status", browser.online ? "Connected" : "Offline"); }
      out.line(); out.command('qz create "TASK" --client NAME');
    }
  } else if (command === "connect" && result?.url) {
    out.line(result.opened ? "Browser binding page opened" : "Browser binding URL ready", "accent");
    out.field("URL", result.url);
    out.line("Open this URL in the browser profile you want to connect.");
    out.command("qz browsers");
  } else if (command === "connect") {
    out.line(result?.connected ? "Connected to qz" : "Waiting for qz", result?.connected ? "accent" : "waiting");
    const selected = result?.clients?.find(browser => browser.clientId === clientId);
    out.field("Browser", selected?.name);
    out.field("UUID", clientId);
    out.field("MCP", result?.mcpUrl);
    if (result?.connected) out.script(`qz create "Summarize the current page."${client}`);
  } else if (command === "status") {
    out.line(result?.connected ? "Connected to qz" : result?.running ? "Service running · browser disconnected" : "Local service stopped", result?.connected ? "accent" : "waiting");
    out.field("Service", result?.endpoint);
    if (result?.connected) {
      out.field("Browsers", result.clientCount ?? result.clients?.length ?? 1);
      for (const client of result.clients || []) out.field(client.name || "Client", client.clientId);
    }
    if (result?.updateRequired) {
      out.line("Service upgrade required for browser pairing.", "waiting");
      out.line(result.hint);
    } else if (result?.updateAvailable) {
      out.line("Service update available. Restart when your current work is finished:", "waiting");
      out.command("qz stop && qz connect");
    } else if (!result?.connected) out.command("qz connect");
  } else if (command === "install") {
    out.line(result?.opened ? "Chrome Web Store opened" : "Install qz from the Chrome Web Store", "accent");
    if (!result?.opened) out.line(result?.url);
    out.line("Click Add to Chrome, then connect:"); out.command("qz connect");
  } else if (command === "stop") {
    out.line(result?.stopped ? "Local service stopped" : "Local service is already stopped", "accent");
    out.command("qz connect");
  } else {
    out.line(JSON.stringify(result ?? null, null, 2));
  }
  return out.finish();
}

export function renderHelp(topic = "", options = {}) {
  const out = output(options);
  if (COMMANDS[topic]?.help) {
    const [usage, description, ...details] = COMMANDS[topic].help;
    out.line(usage, "accent"); out.line(); out.line(description);
    for (const detail of details) { out.line(); out.line(detail, detail.startsWith("qz ") ? "accent" : undefined); }
  } else {
    out.line("qz · Your browser, from the terminal", "accent");
    out.line("Run tasks with the qz browser agent, manage results, and connect via MCP.");
    out.line();
    for (const { help, summary: description } of Object.values(COMMANDS)) {
      if (!help) continue;
      const name = help[0].replace(/^qz /, "").replace(/ \[.*$/, "");
      if (out.width >= 64) out.line(`  ${pad(name, 23)} ${description}`);
      else { out.command(`qz ${name}`); out.line(`    ${description}`, "muted"); }
    }
    out.line(); out.command('qz create "Summarize this page." --stream');
    out.command('qz create "Compare these tabs." --title Research --wait');
  }
  if (!topic || commandOptions(topic).includes("client")) {
    out.line(); out.line("Browser: --client NAME|UUID (-c)", "muted");
  }
  if (!topic || topic === "watch" || commandOptions(topic).includes("wait")) {
    out.line(); out.line("Task waiting: no default time limit. --timeout SECONDS sets a total deadline, including input pauses.", "muted");
    out.line("Each connection request has its own timeout. Ctrl-C stops watching; the browser task continues.", "muted");
  }
  out.line(); out.line("Output: --json · --plain · --no-color", "muted");
  out.line("Help: qz COMMAND --help", "muted");
  out.line("Version: qz --version (-v)", "muted");
  out.line("npm: npm run qz -- COMMAND [options]", "muted");
  out.shellNote();
  return out.finish();
}

export function renderError(payload, options = {}) {
  const out = output(options);
  const error = payload?.error || payload || {};
  const waiting = error.code === "connection_pending";
  out.line(waiting ? "Waiting for Chrome" : "qz error", waiting ? "waiting" : "error");
  out.line(error.message || "The command could not be completed.");
  if (error.url) { out.line(); out.line(error.url, "accent"); }
  if (error.hint) { out.line(); out.line(error.hint); }
  if (error.command) out.script(error.command);
  if (error.log) out.field("Log", error.log);
  if (error.guide) { out.line(); out.field("Guide", error.guide); }
  return out.finish();
}

#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { GUIDE_URL, INSTALL_URL, QzError, withToolClient, readHealth } from "./client.mjs";
import { ensureDaemon, findDaemon, stopDaemon } from "./daemon.mjs";
import { openBrowser } from "./open-browser.mjs";
import { parseCommand } from "./args.mjs";
import { renderError, renderHelp, renderResult, renderInputNotice, sanitizeTerminalText } from "./terminal.mjs";
import { waitForTask } from "./task-stream.mjs";
import { createLiveOutput, outputMode } from "./output.mjs";
import { resourceRequest, settingsPatch } from "./cli-resources.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";
import { optionTerminator, shellArgument } from "./shell.mjs";

export const HELP = renderHelp();

async function stdinText({ signal } = {}) {
  signal?.throwIfAborted();
  const input = process.stdin;
  if (input.readableEnded) return "";
  return new Promise((resolve, reject) => {
    const chunks = [];
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", fail);
      signal?.removeEventListener("abort", abort);
      input.pause();
    };
    const data = chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    const fail = error => { cleanup(); reject(error); };
    const abort = () => fail(signal.reason);
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    input.resume();
  });
}

function connected(health, clientId = "") {
  return clientId ? health.status?.clients?.some(client => client.clientId === clientId) : Boolean(health.status?.connected);
}

function connectionRequired() {
  return new QzError("not_connected", "Run qz connect to start the local service and connect Chrome. If qz is not installed, run qz install.");
}

function recoveryCommand(command, sessionId, clientId, stream = false) {
  if (sanitizeTerminalText(sessionId) !== String(sessionId)) sessionId = "TASK_ID";
  if (clientId && sanitizeTerminalText(clientId) !== String(clientId)) clientId = "CLIENT_ID";
  const client = clientId ? ` --client${String(clientId).startsWith("-") ? "=" : " "}${shellArgument(clientId)}` : "";
  const options = `${client}${stream ? " --stream" : ""}`;
  return String(sessionId).startsWith("-")
    ? `qz ${command}${options} ${optionTerminator()} ${shellArgument(sessionId)}`
    : `qz ${command} ${shellArgument(sessionId)}${options}`;
}

export async function runCli(argv, dependencies = {}) {
  return executeCommand(parseCommand(argv), dependencies);
}

async function executeCommand(parsed, dependencies) {
  if (parsed.command === "version") return parsed.options.json
    ? { result: { name: PACKAGE_NAME, version: PACKAGE_VERSION } }
    : { text: `qz ${PACKAGE_VERSION}\n` };
  return withToolClient(callTool => dispatchCommand(parsed, { ...dependencies, callTool: dependencies.callTool || callTool }));
}

async function dispatchCommand(parsed, dependencies) {
  const { command, action, id, options = {}, timeoutSeconds, waitTimeoutSeconds } = parsed;
  if (command === "help") return { text: renderHelp(parsed.helpTopic) };
  dependencies.signal?.throwIfAborted();
  const open = dependencies.openBrowser || openBrowser;
  const find = dependencies.findDaemon || findDaemon;
  const healthReader = dependencies.readHealth || readHealth;
  if (command === "install") return { result: await open(INSTALL_URL) };
  if (command === "stop") return { result: await (dependencies.stopDaemon || stopDaemon)() };
  if (command === "connect") {
    const running = await (dependencies.ensureDaemon || ensureDaemon)();
    const connectUrl = `${running.endpoint}/qz-connect`;
    const deadline = Date.now() + timeoutSeconds * 1000;
    const probe = async health => {
      const clients = (health?.status?.clients || []).filter(client => !options["client-id"] || client.clientId === options["client-id"]);
      for (const client of clients) {
        dependencies.signal?.throwIfAborted();
        const timeoutMs = Math.min(2000, deadline - Date.now());
        if (timeoutMs <= 0) return false;
        const timeout = AbortSignal.timeout(timeoutMs);
        try {
          // A lease can outlive a stopped poller. Confirm a real extension round trip.
          await dependencies.callTool(running.endpoint, "qingzhou_call", {
            method: "ping", clientId: client.clientId, timeoutSeconds: timeoutMs / 1000,
          }, { timeoutMs, signal: dependencies.signal ? AbortSignal.any([dependencies.signal, timeout]) : timeout });
          return true;
        } catch (error) {
          dependencies.signal?.throwIfAborted();
          if (error.code === "connection_error" || (!timeout.aborted
            && !["BRIDGE_NOT_CONNECTED", "BRIDGE_REQUEST_TIMEOUT", -32001].includes(error.code))) throw error;
        }
      }
      return false;
    };
    const result = health => ({ result: { connected: true, mcpUrl: `${running.endpoint}/mcp`, clients: health.status.clients } });
    if (await probe(running.health)) return result(running.health);
    dependencies.signal?.throwIfAborted();
    await open(connectUrl);
    while (Date.now() < deadline) {
      dependencies.signal?.throwIfAborted();
      const health = await healthReader(running.endpoint).catch(() => null);
      if (health && health.instanceId !== running.instanceId) throw new QzError("connection_changed", "The local service changed. Run qz connect again.", { url: connectUrl });
      if (health && await probe(health)) return result(health);
      await delay(200, undefined, { signal: dependencies.signal });
    }
    throw new QzError("connection_pending", "qz is waiting for Chrome. Open the connection URL in the Chrome profile with qz installed and accept its data notice. Then run qz connect again.", { url: connectUrl });
  }
  // Validate JSON before connecting; malformed arguments cannot cause browser actions.
  let args = {};
  if (command === "submit" || (command === "settings" && action === "set" && id === undefined)) {
    const source = options.args === "-" ? await (dependencies.readStdin || stdinText)({ signal: dependencies.signal }) : options.args ?? "{}";
    try { args = JSON.parse(source); }
    catch { throw new QzError("invalid_arguments", "Pass a JSON object, or - to read one from stdin."); }
    if (!args || Array.isArray(args) || typeof args !== "object") throw new QzError("invalid_arguments", `${command === "submit" ? "Answers" : "Settings"} must be a JSON object.`);
  }
  let config;
  if (command === "settings" && action === "set") config = settingsPatch(id, options.value, args);
  let prompt = options.prompt || "";
  if (((command === "tasks" && action === "create") || command === "send") && prompt === "-") {
    prompt = await (dependencies.readStdin || stdinText)({ signal: dependencies.signal });
    if (!prompt.trim()) throw new QzError("invalid_arguments", "The prompt read from stdin is empty.");
  }
  dependencies.signal?.throwIfAborted();
  const resource = resourceRequest(parsed, config);
  const running = await find();
  if (command === "status") return { result: running ? { running: true, endpoint: running.endpoint, updateAvailable: running.updateAvailable === true, ...running.health.status } : { running: false, connected: false } };
  if (!running) throw connectionRequired();
  if (command === "mcp") return options.json ? { result: { url: `${running.endpoint}/mcp` } } : { text: `${running.endpoint}/mcp\n` };
  const call = dependencies.callTool;
  if (!connected(running.health, options["client-id"])) throw connectionRequired();
  const clients = running.health.status?.clients || [];
  // Keep a waited task in its creating browser even if other profiles connect or disconnect.
  const clientId = options["client-id"] || ((options.wait || ["submit", "approve", "reject"].includes(command)) && clients.length === 1 ? clients[0].clientId : "");
  const common = { timeoutSeconds, ...(clientId ? { clientId } : {}) };
  const requestOptions = { timeoutMs: timeoutSeconds * 1000, signal: dependencies.signal };
  const startedAt = Date.now();
  const readSnapshot = async (sessionId, seconds, signal) => {
    try {
      return await call(running.endpoint, "qingzhou_get_session_snapshot", {
        ...common, sessionId, timeoutSeconds: seconds, compact: false, tail: false, includeArtifacts: false,
      }, { timeoutMs: seconds * 1000, signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === "TimeoutError" || error.code === -32001 || error.code === "timeout" || error.code === "BRIDGE_REQUEST_TIMEOUT"
        || (error.code === "tool_error" && /BRIDGE_REQUEST_TIMEOUT/.test(error.message))) {
        throw new QzError("request_timeout", "Reading the task status timed out. The browser task may still be running.");
      }
      throw error;
    }
  };
  const observe = async (sessionId, { runId = "", expectedMessageId = "", previousRunId = "", ignoreWaitId = "", allowIdle = false } = {}) => {
    try {
      const remaining = waitTimeoutSeconds == null ? null : waitTimeoutSeconds - (Date.now() - startedAt) / 1000;
      if (remaining !== null && remaining <= 0) throw new DOMException("Stopped watching after the configured --timeout. The browser task may still be running.", "TimeoutError");
      return await waitForTask({
        sessionId, clientId: common.clientId, timeoutSeconds: remaining, signal: dependencies.signal,
        requestTimeoutSeconds: timeoutSeconds,
        expectedRunId: runId, expectedMessageId, previousRunId, ignoreWaitId, allowIdle,
        onUpdate: dependencies.onTaskUpdate,
        getSnapshot: ({ timeoutSeconds: seconds, signal }) => readSnapshot(sessionId, seconds, signal),
      });
    } catch (error) {
      const code = error.name === "TimeoutError" ? "timeout" : error.name === "AbortError" ? "interrupted" : error.code || "task_wait_failed";
      const changed = code === "task_changed";
      throw new QzError(code, code === "timeout"
        ? "Stopped watching after the configured --timeout. The browser task may still be running." : error.message,
      { ...error.details, sessionId, ...(clientId ? { clientId } : {}), hint: changed ? "Inspect the task conversation before sending another message:" : "Continue watching the same task:",
        command: recoveryCommand(changed ? "show" : "watch", sessionId, clientId, !changed) });
    }
  };
  if (command === "watch") return { result: { sessionId: id, snapshot: await observe(id, { allowIdle: true }) } };
  if (command === "send") {
    let result = await call(running.endpoint, "qingzhou_send_message", {
      ...common, sessionId: id, text: prompt, steer: Boolean(options.steer), wait: false, waitForStart: true,
    }, requestOptions);
    if (options.wait && result?.accepted === true) {
      if (typeof result.clientMessageId !== "string" || !result.clientMessageId.trim()) {
        throw new QzError("invalid_response", "The message was accepted without a tracking ID. Inspect the task before sending it again.", {
          sessionId: id, hint: "Continue watching the same task:", command: recoveryCommand("watch", id, clientId, true),
        });
      }
      result = { ...result, snapshot: await observe(id, { expectedMessageId: result.clientMessageId }) };
    }
    return { result };
  }
  if (["submit", "approve", "reject"].includes(command)) {
    let waitId = options["wait-id"];
    let input, consentVersion;
    if (!waitId || command === "approve") {
      input = await call(running.endpoint, "qingzhou_get_user_input", { ...common, sessionId: id }, requestOptions);
      if (!waitId) {
        if (!input?.waiting || !input?.waitId) throw new QzError("not_waiting", "This task has no pending input.", { sessionId: id });
        waitId = input.waitId;
      }
    }
    if (command === "approve" && input?.waiting && input.waitId === waitId && input.kind === "location_consent") {
      if (!Number.isInteger(input.consentVersion) || input.consentVersion < 1) {
        throw new QzError("invalid_response", "The location notice has no valid consent version. Run qz show to review the current request.", { sessionId: id });
      }
      consentVersion = input.consentVersion;
      await dependencies.onUserInput?.(input);
    }
    dependencies.signal?.throwIfAborted();
    let result = await call(running.endpoint, "qingzhou_respond_to_user_input", {
      ...common, sessionId: id, waitId, action: command, ...(command === "submit" ? { answers: args } : {}),
      ...(consentVersion === undefined ? {} : { consentVersion }),
    }, requestOptions);
    if (options.wait && (result?.accepted === true || result?.requiresUserAction)) {
      const snapshot = await observe(id, {
        runId: result.runId || "", ignoreWaitId: result.requiresUserAction ? "" : waitId,
      });
      result = result.requiresUserAction
        ? { sessionId: id, waitId, snapshot }
        : { ...result, snapshot };
    }
    return { result };
  }
  let name, parameters;
  if (resource) {
    name = resource.name; parameters = { ...common, ...resource.args };
  } else {
    name = { list: "qingzhou_list_sessions", create: "qingzhou_create_session", get: "qingzhou_get_session_snapshot", stop: "qingzhou_stop_session" }[action];
    parameters = { ...common, ...(id ? { sessionId: id } : {}),
      ...(action === "create" ? { title: options.title || "", firstMessage: prompt, ...(options.parent ? { parentSessionId: options.parent } : {}) } : {}),
      ...(action === "list" && options.limit !== undefined ? { limit: Number(options.limit) } : {}) };
  }
  let result = await call(running.endpoint, name, parameters, requestOptions);
  if (command === "tasks" && action === "create" && options.wait) {
    const sessionId = result?.session?.id || result?.sessionId;
    if (!sessionId) throw new QzError("invalid_response", "The task was created without an ID. Run qz tasks to find it before retrying.");
    await dependencies.onTaskCreated?.(result);
    result = { ...result, snapshot: await observe(sessionId) };
  }
  return { result };
}

export function errorPayload(error) {
  if (error.code === "invalid_arguments") return { ok: false, error: {
    code: error.code, message: error.message,
    hint: "With npm, use npm run qz -- <command> [options]. Run qz --help for usage.",
  } };
  const interrupted = error.name === "AbortError" || error.code === "interrupted";
  const timeout = error.name === "TimeoutError" || error.code === -32001 || error.code === "timeout";
  const code = interrupted ? "interrupted" : timeout ? "timeout" : error.code || "connection_error";
  const payload = { code, message: interrupted ? "Stopped waiting. A started browser task may still be running."
    : timeout && error.code !== "timeout" ? "The request timed out. A started browser task may still be running." : error.message, ...error.details };
  if (!payload.hint && (timeout || interrupted)) payload.hint = "Run qz tasks to inspect the task before repeating the command.";
  if (!payload.hint && code === "BRIDGE_REQUEST_TIMEOUT") payload.hint = "The browser operation may still be running. Check the task before repeating the command.";
  if (!payload.hint && code === "BRIDGE_CLIENT_REQUIRED") payload.hint = "Run qz status to list browser IDs, then repeat with --client ID.";
  if (["not_connected", "connection_error", "connection_unavailable", "connection_pending", "connection_changed", "browser_open_failed", "BRIDGE_NOT_CONNECTED", "BRIDGE_CLOSED"].includes(code)) {
    Object.assign(payload, { guide: GUIDE_URL, install: INSTALL_URL,
      hint: payload.hint || "Run qz install if the extension is missing, then qz connect. See the GitHub guide for setup." });
  }
  return { ok: false, error: payload };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const env = dependencies.env || process.env;
  // Preserve explicit machine output even when argument validation itself fails.
  let mode = outputMode({ json: argv.includes("--json"), plain: argv.includes("--plain"), "no-color": argv.includes("--no-color") }, stdout, env);
  let live;
  try {
    const parsed = parseCommand(argv);
    mode = outputMode(parsed.options, stdout, env);
    if (parsed.command === "help") {
      const help = renderHelp(parsed.helpTopic, mode);
      stdout.write(parsed.options.json ? `${JSON.stringify({ ok: true, result: { help } })}\n` : help);
      return 0;
    }
    if (parsed.options.wait) live = createLiveOutput(parsed, { stdout, stderr, ...mode });
    const result = await executeCommand(parsed, { ...dependencies,
      onTaskCreated: async task => { live?.created(task); await dependencies.onTaskCreated?.(task); },
      onTaskUpdate: async event => { live?.update(event); await dependencies.onTaskUpdate?.(event); },
      onUserInput: async input => {
        if (!mode.json) stdout.write(`${renderInputNotice({ ...input, clientId: input.clientId || parsed.options?.["client-id"] }, mode)}\n`);
        await dependencies.onUserInput?.(input);
      },
    });
    live?.finish();
    stdout.write(result.text ?? (mode.json ? `${JSON.stringify({ ok: true, result: result.result })}\n`
      : renderResult({ ...parsed, presentation: { streamed: live?.streamed } }, result.result, mode)));
    const status = result.result?.snapshot?.status || result.result?.snapshot?.runtime?.status;
    if (result.result?.accepted === false && !result.result?.requiresUserAction) return 1;
    return ["error", "failed", "aborted", "cancelled", "canceled", "interrupted"].includes(status) ? 1 : 0;
  } catch (error) {
    live?.finish();
    const payload = errorPayload(error);
    if (mode.json) stdout.write(`${JSON.stringify(payload)}\n`);
    else stderr.write(renderError(payload, { ...mode, color: mode.color && Boolean(stderr.isTTY) }));
    return payload.error.code === "invalid_arguments" ? 2 : payload.error.code === "interrupted" ? 130 : 1;
  }
}

let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isEntry) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
}

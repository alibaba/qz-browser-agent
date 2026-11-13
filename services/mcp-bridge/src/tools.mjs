import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { BridgeError } from "./state.mjs";
import { waitForTask } from "./task-stream.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";
import { driveGuide } from "./drive-guide.mjs";
import { driveExtensionTimeoutSeconds } from "./drive-timeout.mjs";
export { driveExtensionTimeoutSeconds } from "./drive-timeout.mjs";

// Public MCP tools use the extension's version 1 wire protocol.
export const TOOL_CATALOG = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"))
  .map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: false } }));
const schemaValidator = new AjvJsonSchemaValidator();
const definitions = new Map(TOOL_CATALOG.map(tool => [tool.name, {
  tool, validate: schemaValidator.getValidator(tool.inputSchema),
}]));
const taskInputResults = new Set([
  "qingzhou_get_session_snapshot", "qingzhou_get_session_state", "qingzhou_send_message",
  "qingzhou_respond_to_user_input", "qingzhou_continue_task", "qingzhou_submit_wait_form", "qingzhou_cancel_wait",
]);
const resourceResults = new Set([
  "qingzhou_get_skill", "qingzhou_get_skill_resource", "qingzhou_export_skill",
  "qingzhou_list_data_tables", "qingzhou_delete_data_table", "qingzhou_export_data_table",
  "qingzhou_list_image_collections", "qingzhou_delete_image_collection", "qingzhou_export_image_collection",
  "qingzhou_get_settings", "qingzhou_update_settings",
]);
const observableTools = new Set([
  "qingzhou_watch_task", "qingzhou_create_session", "qingzhou_send_message", "qingzhou_respond_to_user_input",
]);

function bindInputClient(name, result, clientId) {
  const selectedClient = String(clientId || "").trim();
  const isObject = value => value && typeof value === "object" && !Array.isArray(value);
  if (!selectedClient || !isObject(result)) return result;
  const bind = input => ({
    ...input, clientId: selectedClient,
    ...(isObject(input.responseTemplate)
      ? { responseTemplate: { ...input.responseTemplate, clientId: selectedClient } } : {}),
  });
  if (name === "qingzhou_get_user_input") return bind(result);
  return taskInputResults.has(name) && isObject(result.input)
    ? { ...result, input: bind(result.input) } : result;
}

function argumentsWithDefaults(definition, input) {
  const validation = definition.validate(input);
  if (!validation.valid) throw new Error(`Invalid arguments: ${validation.errorMessage}`);
  return Object.fromEntries(Object.entries(definition.tool.inputSchema.properties).flatMap(([key, schema]) => {
    if (Object.hasOwn(input, key)) return [[key, input[key]]];
    return Object.hasOwn(schema, "default") ? [[key, structuredClone(schema.default)]] : [];
  }));
}

export async function executeMcpTool(state, name, input = {}, { signal, onTaskUpdate, clientName } = {}) {
  const args = validateMcpToolInput(name, input);
  if (name === "qingzhou_bridge_status") return state.status();
  if (name === "qingzhou_forget_browser") return state.forgetBrowser(args.clientId);
  if (name === "qingzhou_get_tool_job") return state.getJob(args.jobId, args.includeResult);
  // One MCP operation, including observation, belongs to one connection.
  const connection = await state.resolveClient(String(args.clientId || "").trim(),
    (args.timeoutSeconds || state.requestTimeoutSeconds || 180) * 1000, state.signal(signal), true);
  args.clientId = connection.id;
  const connectionSignal = state.signal(connection.controller.signal);
  const operationSignal = signal ? AbortSignal.any([connectionSignal, signal]) : connectionSignal;
  operationSignal.throwIfAborted();
  const result = await executeBrowserTool(state, name, args, { signal: operationSignal, connectionSignal, onTaskUpdate, clientName });
  return args.clientId && (observableTools.has(name) || taskInputResults.has(name) || ["qingzhou_list_sessions", "qingzhou_get_user_input", "qingzhou_stop_session", "qingzhou_abort_session"].includes(name)) && result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, clientId: args.clientId } : result;
}

async function executeBrowserTool(state, name, args, { signal, connectionSignal, onTaskUpdate, clientName }) {
  const observe = observableTools.has(name) && (name === "qingzhou_watch_task" || args.wait || args.stream);
  const asyncTool = name === "qingzhou_execute_tool" && args.wait === false;
  const options = { timeoutSeconds: args.timeoutSeconds, clientId: args.clientId, signal };
  const startedAt = Date.now();
  const watch = async (sessionId, tracking = {}) => {
    try {
      const remaining = args.waitTimeoutSeconds == null ? null : args.waitTimeoutSeconds - (Date.now() - startedAt) / 1000;
      if (remaining !== null && remaining <= 0) throw new DOMException("Stopped watching after waitTimeoutSeconds. The browser task may still be running.", "TimeoutError");
      return await waitForTask({ sessionId, clientId: args.clientId, signal, timeoutSeconds: remaining,
        requestTimeoutSeconds: args.timeoutSeconds || state.requestTimeoutSeconds || 180,
        expectedRunId: tracking.runId, expectedMessageId: tracking.clientMessageId, messageWasQueued: tracking.disposition === "queued",
        ignoreWaitId: tracking.ignoreWaitId, allowIdle: tracking.allowIdle,
        onUpdate: onTaskUpdate && (event => args.stream || !["text", "replace"].includes(event.type) ? onTaskUpdate(event) : undefined),
        getSnapshot: async ({ signal: requestSignal, timeoutSeconds }) => bindInputClient("qingzhou_get_session_snapshot",
          await state.callExtension("get_session_snapshot", {
            sessionId, compact: false, tail: false, includeArtifacts: false, timeoutSeconds,
          }, { ...options, timeoutSeconds, signal: requestSignal }), args.clientId),
      });
    } catch (cause) {
      const code = typeof cause.code === "string" ? cause.code
        : cause.name === "TimeoutError" ? "TIMEOUT" : cause.name === "AbortError" ? "INTERRUPTED" : "TASK_WAIT_FAILED";
      const error = Object.assign(new Error(cause.message, { cause }), { code });
      error.details = { ...cause.details, sessionId, clientId: args.clientId,
        recovery: code === "TASK_DELETED"
          ? { tool: "qingzhou_list_sessions", arguments: { clientId: args.clientId } }
          : { tool: code === "TASK_CHANGED" ? "qingzhou_get_session_snapshot" : "qingzhou_watch_task",
            arguments: { sessionId, clientId: args.clientId } } };
      throw error;
    }
  };
  if (name === "qingzhou_watch_task") return { sessionId: args.sessionId, snapshot: await watch(args.sessionId, { allowIdle: true }) };
  if (name === "qingzhou_get_tool") {
    const tool = await state.callExtension("get_tool", {
      sessionId: args.sessionId, name: args.name, timeoutSeconds: args.timeoutSeconds,
    }, options);
    if (!tool || typeof tool !== "object") {
      throw new BridgeError("TOOL_NOT_FOUND", `No browser tool named ${args.name}. Use qingzhou_list_tools to list available tools.`);
    }
    return tool;
  }
  if (name === "qingzhou_call") return state.callExtension(args.method.trim(), args.params || {}, options);
  if (name === "qingzhou_list_capabilities") return state.callExtension("capabilities", {}, options);
  const { clientId, ...params } = args;
  if (observableTools.has(name)) {
    delete params.stream;
    delete params.waitTimeoutSeconds;
    if (name === "qingzhou_send_message") params.wait = false;
    else delete params.wait;
  }
  if (name === "qingzhou_follow_up") params.images ||= [];
  if (name === "qingzhou_submit_wait_form") params.answers ||= {};
  if (name === "qingzhou_create_drive_session") {
    const displayName = String(clientName || "").trim();
    if (displayName) params.clientName = displayName;
  }
  if (name === "qingzhou_execute_tool") {
    const scriptApiVersion = params.scriptApiVersion;
    if (scriptApiVersion != null) {
      const capabilities = await state.callExtension("capabilities", {}, options);
      if (capabilities?.scriptApiVersion !== scriptApiVersion) {
        throw Object.assign(new BridgeError("UPGRADE_REQUIRED", "The connected extension does not support this script API. No script was executed."), {
          hint: "Update the CLI and extension together, then reconnect before running the script.",
        });
      }
    }
    delete params.wait;
    if (!Array.isArray(params.calls)) params.args ||= {};
    const displayName = String(clientName || "").trim();
    if (displayName) params.clientName = displayName;
    const requestTimeout = driveExtensionTimeoutSeconds(params, args.timeoutSeconds || state.requestTimeoutSeconds || 180);
    const callOptions = { ...options, timeoutSeconds: requestTimeout, cancelOnAbort: !asyncTool };
    const invoke = () => asyncTool
      ? { ...state.startExtensionJob("execute_tool", params, { ...callOptions, connectionSignal }), sessionId: args.sessionId, clientId }
      : state.callExtension("execute_tool", params, callOptions);
    try {
      return await invoke();
    } catch (error) {
      if (error?.code === "DRIVE_SESSION_BUSY") return await invoke();
      throw error;
    }
  }
  const method = name === "qingzhou_abort_session" ? "stop_session" : name.slice("qingzhou_".length);
  let result = await state.callExtension(method, params, options);
  if (resourceResults.has(name) && result && typeof result.code === "string" && typeof result.error === "string") {
    throw new BridgeError(result.code, result.error, {
      ...result.details,
      ...(Array.isArray(result.available) ? { available: result.available } : {}),
      ...(Array.isArray(result.resources) ? { available: result.resources.map(resource => resource.path) } : {}),
    });
  }
  result = bindInputClient(name, result, clientId);
  if (observe) {
    const sessionId = name === "qingzhou_create_session"
      ? result?.session?.sessionId || result?.sessionId || result?.session?.id : args.sessionId;
    if (name === "qingzhou_create_session") {
      if (!sessionId) throw new BridgeError("INVALID_RESPONSE", "The task was created without an ID. Use qingzhou_list_sessions to find it before retrying.");
      await onTaskUpdate?.({ type: "created", sessionId, clientId, ...result });
      result = { ...result, snapshot: await watch(sessionId, { allowIdle: !args.firstMessage.trim() }) };
    } else if (name === "qingzhou_send_message" && result?.accepted === true) {
      if (typeof result.clientMessageId !== "string" || !result.clientMessageId.trim()) {
        throw Object.assign(new BridgeError("INVALID_RESPONSE", "The message was accepted without a tracking ID. Continue watching the same task before sending it again."), {
          details: { sessionId, clientId, recovery: { tool: "qingzhou_watch_task", arguments: { sessionId, clientId } } },
        });
      }
      result = { ...result, snapshot: await watch(sessionId, { clientMessageId: result.clientMessageId, disposition: result.disposition }) };
    } else if (name === "qingzhou_respond_to_user_input" && (result?.accepted === true || result?.requiresUserAction)) {
      const snapshot = await watch(sessionId, { runId: result.runId || "", ignoreWaitId: result.requiresUserAction ? "" : args.waitId });
      result = result.requiresUserAction ? { sessionId, waitId: args.waitId, snapshot } : { ...result, snapshot };
    }
  }
  return result;
}

/** Validate input against the advertised tool schema and apply its defaults. */
export function validateMcpToolInput(name, input = {}) {
  const definition = definitions.get(name);
  if (!definition) throw Object.assign(new Error(`Unknown tool: ${name}. Read the MCP tool list for available names.`), { code: "INVALID_ARGUMENTS" });
  try {
    return argumentsWithDefaults(definition, input);
  } catch (error) {
    error.code = "INVALID_ARGUMENTS";
    throw error;
  }
}

function imageEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.images)) return [];
  return value.images.filter(image => image && typeof image.data === "string" && typeof image.mimeType === "string");
}

function withoutImages(value) {
  if (!imageEntries(value).length) return value;
  const { images: _images, ...rest } = value;
  return rest;
}

function imageBlock(image, meta) {
  return {
    type: "image",
    data: image.data,
    mimeType: image.mimeType,
    ...(meta && Object.keys(meta).length ? { _meta: meta } : {}),
  };
}

function peelCallImages(value, callId, sink) {
  const images = imageEntries(value);
  if (!images.length) return value;
  const placeholders = images.map((image, offset) => {
    const meta = { ...(callId ? { id: callId } : {}), index: offset };
    sink.push(imageBlock(image, meta));
    return meta;
  });
  return { ...withoutImages(value), images: placeholders };
}

export function resultToContent(result, { toolResult = false } = {}) {
  if (result == null) return [];
  if (Array.isArray(result)) return result.flatMap(item => resultToContent(item));
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const nested = [];
  let body = result;
  if (toolResult && Array.isArray(result.results)) {
    body = {
      ...result,
      results: result.results.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const callId = String(item.id || "");
        return peelCallImages(item, callId, nested);
      }),
    };
  }
  const top = toolResult ? imageEntries(body) : [];
  if (!top.length && !nested.length) {
    return [{ type: "text", text: JSON.stringify(body) }];
  }
  return [
    { type: "text", text: JSON.stringify(top.length ? withoutImages(body) : body) },
    ...top.map(image => imageBlock(image)),
    ...nested,
  ];
}

const DRIVE_TOOL_NAMES = ["qingzhou_guide", "qingzhou_create_drive_session", "qingzhou_list_drive_sessions", "qingzhou_get_drive_session", "qingzhou_stop_session", "qingzhou_execute_tool", "qingzhou_list_tools", "qingzhou_get_tool", "qingzhou_bridge_status"];
const GUIDE_TOOL = {
  name: "qingzhou_guide",
  description: "Return the qz CLI direct-drive guide as an optional reference.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};
const DRIVE_INSTRUCTIONS = "先用 qingzhou_create_drive_session 或 qz session create --title TITLE 创建带可读标题的会话，后续每次执行工具或脚本都传入该 sessionId（CLI 必传 --session，缺失退出码为 2，不会自动建会话）；list_tools/get_tool 查询基础目录无需会话。页面工具必传 tabRef（open_tab 设置的可选 tabAlias，或 open_tab / list_tabs 返回的 tabRef）。list_tabs 默认列出本会话的页面和未被占用的页面（active=true 是用户正在看的页面）；对未占用页面首次执行操作、导航或 evaluate 时由本会话占用。通过 qingzhou_execute_tool（单工具、calls 批次或 run_script 外层编排）执行操作，页面内 DOM 求值使用 evaluate。Create a session with a readable title using qingzhou_create_drive_session or qz session create --title TITLE, then pass that sessionId on every tool or script execution (CLI calls require --session; omitting it exits 2 and does not create a session). list_tools/get_tool can inspect the base catalog without a session. Page tools require tabRef (an optional tabAlias from open_tab, or the tabRef returned by open_tab or list_tabs). By default list_tabs lists this session's tabs and unclaimed tabs (active:true is the user's page); the first action, navigation, or evaluate on an unclaimed tab claims it for this session. Orchestrate with qingzhou_execute_tool (single tool, calls batch, or outer run_script) and use evaluate for in-page DOM execution.";

export function mcpCatalogProfile({ clientName = "", profile = "" } = {}) {
  const explicit = String(profile || "").trim().toLowerCase();
  if (explicit === "full" || explicit === "drive") return explicit;
  return clientName === "qz-cli" ? "full" : "drive";
}

export function driveToolCatalog() {
  const byName = new Map(TOOL_CATALOG.map(tool => [tool.name, tool]));
  return DRIVE_TOOL_NAMES.map(name => name === "qingzhou_guide" ? GUIDE_TOOL : byName.get(name));
}

export function createMcpServer(state, { clientName = "", profile = "" } = {}) {
  const catalogProfile = mcpCatalogProfile({ clientName, profile });
  const server = new Server({ name: "qz-browser-agent-mcp-bridge", version: PACKAGE_VERSION }, {
    capabilities: { tools: {} },
    instructions: catalogProfile === "drive" ? DRIVE_INSTRUCTIONS : "Control qz tasks and browser tools through the local bridge.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalogProfile === "drive" ? driveToolCatalog() : TOOL_CATALOG,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      let progress = 0;
      const progressToken = request.params._meta?.progressToken;
      const input = { ...(request.params.arguments || {}) };
      if (request.params.name === "qingzhou_guide") {
        return { content: [{ type: "text", text: driveGuide() }] };
      }
      if (catalogProfile === "drive" && request.params.name === "qingzhou_list_sessions") {
        if (!String(input.scope || "").trim()) input.scope = "session";
      }
      if (request.params.name === "qingzhou_execute_tool" && !String(input.sessionId || "").trim()) {
        throw new BridgeError("DRIVE_SESSION_REQUIRED", "Pass sessionId from qz session create (MCP: qingzhou_create_drive_session). CLI calls require --session. This call does not create a session.");
      }
      const result = await executeMcpTool(state, request.params.name, input, { signal: extra.signal, clientName,
        onTaskUpdate: progressToken === undefined ? undefined : event => extra.sendNotification({
          method: "notifications/progress", params: { progressToken, progress: ++progress,
            message: ["text", "replace"].includes(event.type) ? event.text : JSON.stringify(event),
            _meta: { "qz/task-event": event } },
        }).catch(() => {}),
      });
      return { content: resultToContent(result, { toolResult: request.params.name === "qingzhou_execute_tool" }) };
    } catch (error) {
      const value = { code: String(error.code || "TOOL_EXECUTION_FAILED").toUpperCase(), message: error.message || String(error),
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}) };
      return { isError: true, content: resultToContent(value) };
    }
  });
  return server;
}

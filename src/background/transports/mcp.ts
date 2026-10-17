import type { BackgroundApi } from "../background-api.js";
type Fields = Record<string, unknown>;
interface BridgePort { describe?(): unknown; getConfig?(): unknown; saveConfig?(config: unknown): unknown }
import { resolveBackgroundApiMethod } from "../background-api.js";

export const QINGZHOU_MCP_METHODS = Object.freeze([
  "ping",
  "capabilities",
  "get_bridge_config",
  "save_bridge_config",
  "runtime_message",
  "list_sessions",
  "create_session",
  "send_message",
  "follow_up",
  "get_user_input",
  "respond_to_user_input",
  "continue_task",
  "submit_wait_form",
  "cancel_wait",
  "get_session_state",
  "get_session_snapshot",
  "get_messages",
  "get_history",
  "stop_session",
  "clear_goal",
  "list_tools",
  "execute_tool",
  "call_tool",
  "list_data_tables",
  "delete_data_table",
  "export_data_table",
  "list_image_collections",
  "delete_image_collection",
  "export_image_collection",
  "list_downloads",
  "list_skills",
  "get_skill",
  "load_skill",
  "get_skill_resource",
  "export_skill",
  "load_skill_resource",
  "get_config",
  "save_config",
  "get_settings",
  "update_settings",
  "get_runtime_config",
  "set_runtime_config",
  "list_plugins",
  "refresh_skill_registry",
  "list_automations",
  "run_automation",
  "get_trace",
  "clear_trace",
]);

export function createMcpTransport(api: BackgroundApi, { bridge = {} }: { bridge?: BridgePort } = {}) {
  const call = (path: string, ...args: unknown[]) => resolveBackgroundApiMethod(api, path)(...args);

  async function dispatch(request: Fields = {}) {
    const method = String(request.method || "").trim();
    const params = isPlainObject(request.params) ? request.params : {};
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined;
    signal?.throwIfAborted();
    await call("system.ready");
    // A disconnected client must not start queued browser work after readiness resolves.
    signal?.throwIfAborted();

    switch (method) {
      case "ping": return call("system.ping");
      case "capabilities": return bridge.describe?.() || { protocolVersion: 1, methods: QINGZHOU_MCP_METHODS };
      case "get_bridge_config": return bridge.getConfig?.() || {};
      case "save_bridge_config": return bridge.saveConfig?.(params.config || params);
      case "runtime_message": return call("system.runtimeMessage", params.message || {}, params, signal);
      case "list_sessions": return call("sessions.list", params);
      case "create_session": return call("sessions.create", params, signal);
      case "send_message": return call("sessions.send", params, signal);
      case "follow_up": return call("sessions.followUp", params, signal);
      case "get_user_input": return call("sessions.userInput", params);
      case "respond_to_user_input": return call("sessions.respondToUserInput", params, signal);
      case "continue_task": return call("sessions.continueWait", params, signal);
      case "submit_wait_form": return call("sessions.submitWaitForm", params, signal);
      case "cancel_wait": return call("sessions.cancelWait", params, signal);
      case "get_session_state": return call("sessions.state", params.sessionId);
      case "get_session_snapshot": return call("sessions.snapshot", params.sessionId, params);
      case "get_messages": return call("sessions.messages", params.sessionId, params);
      case "get_history": return call("sessions.history", params.sessionId);
      case "stop_session": return call("sessions.stop", params.sessionId, { source: "mcp_bridge", cascade: params.cascade !== false }, signal);
      case "clear_goal": return call("sessions.clearGoal", params.sessionId, "mcp_bridge", signal);
      case "list_tools": return call("tools.list", params);
      case "execute_tool":
      case "call_tool": return call("tools.execute", params, signal);
      case "list_data_tables": return call("data.listTables");
      case "delete_data_table": return call("data.deleteTable", params, signal);
      case "export_data_table": return call("data.exportTable", params, signal);
      case "list_image_collections": return call("data.listImageCollections");
      case "delete_image_collection": return call("data.deleteImageCollection", params, signal);
      case "export_image_collection": return call("data.exportImageCollection", params, signal);
      case "list_downloads": return call("data.listDownloads", params);
      case "list_skills": return call("skills.list", params);
      case "get_skill":
      case "load_skill": return call("skills.get", params);
      case "get_skill_resource":
      case "load_skill_resource": return call("skills.resource", params);
      case "export_skill": return call("skills.export", params, signal);
      case "get_config": return call("config.get");
      case "save_config": return call("config.save", params.config || {}, signal);
      case "get_settings": return call("settings.get", params);
      case "update_settings": return call("settings.update", params, signal);
      case "get_runtime_config": return call("config.getRuntime");
      case "set_runtime_config": return call("config.setRuntime", isPlainObject(params.config) ? params.config : params);
      case "list_plugins": return call("skills.contributions", params.sessionId);
      case "refresh_skill_registry": return call("skills.refresh", params);
      case "list_automations": return call("automations.list", params);
      case "run_automation": return call("automations.run", params.automationId, signal);
      case "get_trace": return { logs: await call("trace.get") };
      case "clear_trace":
        await call("trace.clear");
        return { cleared: true };
      default:
        // Older MCP bridge clients use this prefix to detect unsupported methods.
        throw transportError("METHOD_NOT_FOUND", `Unknown Qingzhou MCP bridge method: ${method || "(empty)"}`);
    }
  }

  return Object.freeze({ dispatch, methods: QINGZHOU_MCP_METHODS });
}

function isPlainObject(value: unknown): value is Fields {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function transportError(code: string, message: string) {
  const error = new Error(message);
  return Object.assign(error, { code });
}

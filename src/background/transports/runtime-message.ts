import type { BackgroundApi } from "../background-api.js";
type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
import { resolveBackgroundApiMethod } from "../background-api.js";
import { TransportError } from "../../shared/transport/message-codec.js";
import { createPortTransport } from "../../shared/transport/port-transport.js";
import { RUNTIME_REQUEST_PORT } from "../../shared/transport/runtime-request.js";
import { backgroundReceiveBudget, backgroundTransferBudget } from "./transfer-budget.js";

const OWNED_MESSAGE_TYPES = new Set([
  "accept_location_consent", "accept_data_consent", "get_content_language", "offscreen_keepalive", "session_export_import_request", "mcp_bridge_connect",
  "mcp_connection_status", "mcp_connection_connect", "mcp_connection_disconnect",
  "stop_session", "run_script_inner_result", "run_script_inner_trace", "run_script_inner_fetch",
  "run_script_inner_fetch_cancel", "run_script_tool_call",
]);

/** Chrome runtime-message protocol adapter. Business decisions stay behind Background API. */
export function createRuntimeMessageTransport(api: BackgroundApi, {
  clock = Date.now,
} = {}) {
  const call = (path: string, ...args: unknown[]) => resolveBackgroundApiMethod(api, path)(...args);

  function dispatch(message: Fields, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) {
    const type = String(message?.type || "");

    if (["mcp_connection_status", "mcp_connection_connect", "mcp_connection_disconnect"].includes(type)) {
      const method = type === "mcp_connection_status" ? "mcpConnectionStatus"
        : type === "mcp_connection_connect" ? "connectMcpFromSettings" : "disconnectMcp";
      respondAsync(
        () => call(`system.${method}`, sender, { endpoint: message.endpoint, name: message.name }),
        result => ({ ok: true, result }), error => failure(error, "MCP_CONNECTION_FAILED"), sendResponse,
      );
      return true;
    }

    if (type === "mcp_bridge_connect") {
      respondAsync(
        () => call("system.connectMcp", sender),
        result => ({ ok: true, ...object(result) }),
        error => failure(error, "MCP_CONNECTION_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type === "accept_location_consent") {
      respondAsync(
        () => call("system.acceptLocationConsent", message.waitId, message.sessionId, sender),
        result => ({ ok: true, ...object(result) }),
        error => failure(error, "LOCATION_CONSENT_SAVE_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type === "accept_data_consent") {
      respondAsync(
        () => call("system.acceptDataConsent", message.version, sender),
        result => ({ ok: true, ...object(result) }),
        error => failure(error, "DATA_CONSENT_SAVE_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type === "get_content_language") {
      respondAsync(
        () => call("system.contentLanguage"),
        result => ({ ok: true, result }),
        error => failure(error, "CONTENT_LANGUAGE_UNAVAILABLE"),
        sendResponse,
      );
      return true;
    }

    if (type === "session_export_import_labels") {
      respondAsync(
        () => call("system.sessionImportLabels", typeof message.language === "string" ? message.language : ""),
        result => ({ ok: true, labels: result }),
        error => failure(error, "SESSION_IMPORT_LABELS_UNAVAILABLE"),
        sendResponse,
      );
      return true;
    }

    if (type === "offscreen_keepalive") {
      sendResponse({ ok: true, at: clock() });
      return false;
    }

    if (type === "session_export_reveal_consent") {
      // sidePanel.open starts inside this listener so the click remains a user gesture.
      sendResponse({ ok: true, ...object(call("exchange.revealForImport", sender)) });
      return false;
    }

    if (type === "session_export_import_request") {
      respondAsync(
        () => call("exchange.importFromPage", message, sender),
        result => ({ ok: true, ...object(result) }),
        error => failure(error, "SESSION_EXPORT_IMPORT_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type === "stop_session") {
      respondAsync(
        () => call("sessions.stop", message.sessionId, { source: message.source || "runtime_message" }),
        result => ({ ok: true, result }),
        error => failure(error, "STOP_SESSION_FAILED"),
        sendResponse,
      );
      return true;
    }

    const innerResponse = call("tools.acceptRunScriptInnerMessage", message, sender);
    if (innerResponse) {
      sendResponse(innerResponse);
      return false;
    }

    if (type === "run_script_inner_fetch") {
      respondAsync(
        () => call("tools.executeInnerFetch", message, sender),
        result => ({ ok: true, result }),
        error => failure(error, "SKILL_NETWORK_FETCH_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type === "run_script_inner_fetch_cancel") {
      respondAsync(
        () => call("tools.cancelInnerFetch", message, sender),
        result => ({ ok: true, result }),
        error => failure(error, "SKILL_NETWORK_FETCH_CANCEL_FAILED"),
        sendResponse,
      );
      return true;
    }

    if (type !== "run_script_tool_call") return false;
    respondAsync(
      () => call("tools.executeRunScriptCall", message, sender),
      response => response,
      error => failure(error, "RUN_SCRIPT_TOOL_CALL_FAILED"),
      sendResponse,
    );
    return true;
  }

  function listener(message: Fields = {}, sender: chrome.runtime.MessageSender = {}, sendResponse: (response: unknown) => void = () => {}) {
    try { return dispatch(message, sender, sendResponse); }
    catch (error) { sendResponse(failure(error, "RUNTIME_REQUEST_FAILED")); return false; }
  }

  function register(runtime = globalThis.chrome?.runtime) {
    if (!runtime?.onMessage?.addListener) {
      throw new TypeError("chrome.runtime.onMessage is unavailable");
    }
    const active = new Set<() => void>();
    const onConnect = (port: chrome.runtime.Port) => {
      if (port.name !== RUNTIME_REQUEST_PORT) return;
      let requested = false;
      let closed = false;
      const transport = createPortTransport({
        budget: backgroundTransferBudget,
        receiveBudget: backgroundReceiveBudget,
        postMessage: message => port.postMessage(message),
        onMessage: message => {
          if (requested) { respond(failure(new TransportError("TRANSPORT_PROTOCOL_ERROR"), "TRANSPORT_PROTOCOL_ERROR")); return; }
          requested = true;
          if (!OWNED_MESSAGE_TYPES.has(String(message.type))) {
            respond(failure(new TransportError("TRANSPORT_PROTOCOL_ERROR"), "TRANSPORT_PROTOCOL_ERROR"));
            return;
          }
          // Once delivered, each operation owns its deadline and cancellation.
          clearTimeout(timer);
          try {
            // Exactly the same runtime sender and authorization checks as sendMessage.
            dispatch(message, port.sender || {}, respond);
          } catch (cause) { respond(failure(cause, "RUNTIME_REQUEST_FAILED")); }
        },
        onError: error => respond(failure(error, error.code)),
      });
      function respond(response: unknown) {
        if (closed) return;
        clearTimeout(timer);
        timer = setTimeout(cleanup, 60_000);
        void transport.send(object(response)).catch(error => {
          if (closed || error?.code === "TRANSPORT_DISCONNECTED") { cleanup(); return; }
          void transport.send(failure(error, "RUNTIME_REQUEST_FAILED")).catch(cleanup);
        });
      }
      const onMessage = (message: unknown) => transport.receive(message);
      let timer = setTimeout(cleanup, 60_000);
      function cleanup() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        transport.dispose();
        active.delete(cleanup);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(cleanup);
        try { port.disconnect(); } catch { /* Already closed. */ }
      }
      active.add(cleanup);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(cleanup);
    };
    runtime.onMessage.addListener(listener);
    runtime.onConnect?.addListener(onConnect);
    return () => {
      runtime.onMessage.removeListener?.(listener);
      runtime.onConnect?.removeListener(onConnect);
      for (const cleanup of active) cleanup();
    };
  }

  return Object.freeze({ listener, register });
}

function respondAsync(work: () => unknown, onSuccess: (result: unknown) => unknown, onFailure: (error: unknown) => unknown, sendResponse: (response: unknown) => void) {
  Promise.resolve()
    .then(work)
    .then(
      result => sendResponse(onSuccess(result)),
      error => sendResponse(onFailure(error)),
    );
}

function failure(cause: unknown, fallbackCode: string) {
  const error = object(cause);
  return {
    ok: false,
    error: error?.message || String(cause),
    code: error?.code || fallbackCode,
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
    ...(error?.diagnostic && typeof error.diagnostic === "object" ? { diagnostic: error.diagnostic } : {}),
  };
}

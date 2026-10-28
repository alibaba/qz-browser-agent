import { createPortTransport } from "../../shared/transport/port-transport.js";
import { transportFailure, TransportError } from "../../shared/transport/message-codec.js";
import { t } from "../../shared/i18n/backend.js";
import { backgroundReceiveBudget, backgroundTransferBudget } from "./transfer-budget.js";
import { ToolExecutionError } from "../tools/arguments.js";

type Fields = Record<string, unknown>;
type Port = chrome.runtime.Port;
interface PendingEvent { event: Fields; timer: ReturnType<typeof setTimeout>; windowId: number | null; inFlight?: boolean }
interface ChannelOptions {
  normalizeSessionId?(value: unknown): string; getRuntime?(id: string): Fields;
  trace?(message: string): unknown; streamTraceEnabled?: boolean;
}
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};

/** GeolocationPositionError codes. Any other value stays the generic unavailable failure. */
function locationBrowserFailure(code: unknown) {
  if (code === 1) return { code: "LOCATION_PERMISSION_DENIED", message: "locationPermissionDenied" } as const;
  if (code === 2) return { code: "LOCATION_POSITION_UNAVAILABLE", message: "locationPositionUnavailable" } as const;
  if (code === 3) return { code: "LOCATION_TIMEOUT", message: "locationTimeout" } as const;
  return { code: "LOCATION_UNAVAILABLE", message: "locationUnavailable" } as const;
}
const RUNTIME_EVENT_TYPES = new Set([
  "state",
  "session_pending",
  "agent_start",
  "turn_start",
  "thinking_update",
  "llm_stream_progress",
  "message_update",
  "tool_call_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "context_compaction_start",
  "context_compaction_end",
  "context_compaction_failed",
  "context_usage",
  "tracker_update",
  "goal_update",
  "waiting_for_user",
  "user_wait_resolved",
  "agent_end",
  "aborted",
  "error",
  "reset",
]);
export const SIDEPANEL_CHANNEL_MESSAGE_TYPES = new Set(["sidepanel_attach"]);

/** Owns Side Panel ports and their short-lived delivery state. */
export function createSidepanelChannel({
  normalizeSessionId = value => String(value || "").trim(),
  getRuntime = () => ({ status: "idle", running: false }),
  trace = () => {},
  streamTraceEnabled = false,
}: ChannelOptions = {}) {
  const ports = new Set<Port>();
  const nativePorts = new WeakMap<Port, Port>();
  const senders = new WeakMap<Port, (message: Fields) => Promise<void>>();
  const connections = new Map<Port, () => void>();
  const portWindowIds = new Map<Port, number | null>();
  const dynamicContextRequests = new Map<string, { port: Port; resolve(value: unknown): void; disconnect(): void }>();
  const pendingEvents = new Map<string, PendingEvent>();
  const streamTraceState = new Map<string, { count: number; chars: number; lastAt: number }>();
  let dynamicContextSeq = 0;

  function register(runtime: Pick<typeof chrome.runtime, "onConnect">, dispatch: (message: Fields, port: Port) => Promise<unknown>) {
    const onConnect = (native: Port) => {
      if (native.name !== "sidepanel") return;
      const reportFailure = (cause: unknown, message: Fields, type: "request_failed" | "transport_error" = "transport_error") => {
        const failure = transportFailure(cause, message, type);
        trace(`transport_failure type=${String(message.type || "")} code=${failure.code} session=${String(message.sessionId || "")} request=${String(message.requestId || "")}`);
        void transport.send(failure).catch(() => {
          cleanup();
          try { native.disconnect(); } catch { /* The connection is already closed. */ }
        });
      };
      const port: Port = {
        name: native.name, sender: native.sender, onMessage: native.onMessage, onDisconnect: native.onDisconnect,
        disconnect: () => native.disconnect(),
        postMessage(message: unknown) {
          void sendMessage(object(message));
        },
      };
      nativePorts.set(native, port);
      const transport = createPortTransport({
        budget: backgroundTransferBudget,
        receiveBudget: backgroundReceiveBudget,
        postMessage: message => native.postMessage(message),
        onMessage: message => { void handleMessage(message); },
        onError: (cause, identity) => reportFailure(cause, identity, "request_failed"),
      });
      function sendMessage(message: Fields) {
        const sending = transport.send(message);
        void sending.catch(cause => reportFailure(cause, message));
        return sending;
      }
      senders.set(port, sendMessage);
      ports.add(port);
      portWindowIds.set(port, null);
      const onMessage = (message: Fields) => transport.receive(message);
      const cleanup = () => {
        transport.dispose();
        native.onMessage.removeListener(onMessage);
        native.onDisconnect.removeListener(cleanup);
        connections.delete(port);
        ports.delete(port);
        portWindowIds.delete(port);
        for (const pending of dynamicContextRequests.values()) if (pending.port === port) pending.disconnect();
      };
      connections.set(port, cleanup);
      native.onDisconnect.addListener(cleanup);
      async function handleMessage(message: Fields) {
        try {
          if (message?.type === "sidepanel_attach") {
            const windowId = normalizeWindowId(message.windowId);
            if (windowId === null) throw new Error("sidepanel_attach requires windowId");
            portWindowIds.set(port, windowId);
            deliverPending(port, pending => pending.windowId === windowId);
            if (message.requestId) {
              port.postMessage({ type: "sidepanel_attached", requestId: message.requestId, windowId });
            }
            return;
          }
          await dispatch(message, port);
        } catch (cause) {
          reportFailure(cause, message, "request_failed");
        }
      }
      native.onMessage.addListener(onMessage);
      deliverPending(port, pending => pending.windowId === null);
    };
    runtime.onConnect.addListener(onConnect);
    return () => {
      runtime.onConnect.removeListener?.(onConnect);
      for (const cleanup of connections.values()) cleanup();
    };
  }

  function broadcast(event: Fields) {
    const enriched = enrichRuntimeEvent(event);
    traceStreamEvent("sw_broadcast", enriched, { ports: ports.size });
    for (const port of ports) {
      port.postMessage(enriched);
    }
    return enriched;
  }

  async function sendToWindow(windowId: unknown, event: Fields) {
    const targetWindowId = normalizeWindowId(windowId);
    if (targetWindowId === null) return false;
    const enriched = enrichRuntimeEvent(event);
    const deliveries = [...ports].filter(port => portWindowIds.get(port) === targetWindowId)
      .map(port => send(port, enriched).then(() => true, () => false));
    return (await Promise.all(deliveries)).some(Boolean);
  }

  function send(port: Port, message: Fields) {
    return senders.get(port)?.(message) || Promise.reject(new TransportError("TRANSPORT_DISCONNECTED"));
  }

  function acceptDynamicContextResponse(message: Fields = {}) {
    const pending = dynamicContextRequests.get(String(message.requestId || ""));
    if (!pending) return false;
    dynamicContextRequests.delete(String(message.requestId || ""));
    pending.resolve(message.context || {});
    return true;
  }

  function requestLocation({ timeoutMs = 6_000, windowId = null, signal }: { timeoutMs?: number; windowId?: number | null; signal?: AbortSignal } = {}) {
    if (signal?.aborted) return Promise.resolve(null);
    const port = [...ports].find(port => windowId == null || portWindowIds.get(port) === windowId);
    if (!port) return Promise.reject(new ToolExecutionError("LOCATION_PANEL_UNAVAILABLE", t("locationPanelUnavailable")));
    const requestId = `ctx_${++dynamicContextSeq}`;
    return new Promise<Fields | null>((resolve, reject) => {
      function cleanup() { clearTimeout(timer); signal?.removeEventListener("abort", cancel); dynamicContextRequests.delete(requestId); }
      function cancel() { cleanup(); resolve(null); }
      function fail(code: string, message: string, details: Fields = {}) { cleanup(); reject(new ToolExecutionError(code, message, details)); }
      const timer = setTimeout(() => fail("LOCATION_RESPONSE_TIMEOUT", t("locationResponseTimeout"), { timeoutMs }), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      dynamicContextRequests.set(requestId, {
        port,
        disconnect: () => fail("LOCATION_PANEL_UNAVAILABLE", t("locationPanelUnavailable")),
        resolve(value) {
          cleanup();
          const error = object(object(value).locationError);
          if (Object.keys(error).length) {
            const failure = locationBrowserFailure(error.code);
            reject(new ToolExecutionError(failure.code, t(failure.message), {
              browserCode: error.code, browserMessage: String(error.message || ""),
            }));
            return;
          }
          const location = object(value).location;
          resolve(location && typeof location === "object" ? object(location) : null);
        },
      });
      void send(port, { type: "dynamic_context_request", requestId, fields: ["location"] })
        .catch(() => { if (dynamicContextRequests.has(requestId)) fail("LOCATION_PANEL_UNAVAILABLE", t("locationPanelUnavailable")); });
    });
  }

  function remember(key: string, event: Fields, ttlMs = 15_000, { windowId = null }: { windowId?: number | null } = {}) {
    clearPending(key);
    const timer = setTimeout(() => clearPending(key), Math.max(0, Number(ttlMs) || 0));
    pendingEvents.set(key, { event, timer, windowId: normalizeWindowId(windowId) });
    return event;
  }

  function deliverPending(port: Port, matches: (pending: PendingEvent) => boolean) {
    for (const [key, pending] of pendingEvents) {
      if (!matches(pending) || pending.inFlight) continue;
      pending.inFlight = true;
      void send(port, pending.event).then(() => {
        if (pendingEvents.get(key) === pending) clearPending(key);
      }, () => {
        pending.inFlight = false;
      });
    }
  }

  function clearPending(key: string) {
    const pending = pendingEvents.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingEvents.delete(key);
    return true;
  }

  function enrichRuntimeEvent(event: Fields) {
    if (!RUNTIME_EVENT_TYPES.has(String(event.type))) return event;
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId) return event;
    const runtime = getRuntime(sessionId);
    return {
      ...event,
      sessionId,
      status: event.status || runtime.status,
      runtime,
    };
  }

  function isRuntimeEvent(eventOrType: unknown) {
    const type = typeof eventOrType === "string" ? eventOrType : object(eventOrType).type;
    return RUNTIME_EVENT_TYPES.has(String(type));
  }

  function recordStreamTrace(message: Fields = {}) {
    trace(`stream_trace stage=${formatTraceValue(message.stage || "ui")} traceId=${formatTraceValue(message.traceId || "-")} session=${formatTraceValue(message.sessionId || "")} run=${formatTraceValue(message.runId || "")} span=${formatTraceValue(message.spanId || "")}${formatTraceFields(object(message.fields))}`);
    return true;
  }

  function traceStreamEvent(stage: string, event: Fields = {}, extra: Fields = {}) {
    if (!streamTraceEnabled || !["message_start", "message_update", "message_end"].includes(String(event?.type))) return;
    const traceId = String(event.streamTraceId || event.spanId || "").trim();
    const key = `${stage}:${traceId || event.sessionId || "unknown"}`;
    const state = streamTraceState.get(key) || { count: 0, chars: 0, lastAt: 0 };
    const now = Date.now();
    const deltaChars = String(event.delta || "").length;
    const contentChars = String(event.content || object(event.message).content || "").length;
    state.count += event.type === "message_update" ? 1 : 0;
    state.chars = Math.max(state.chars, contentChars);
    const gapMs = state.lastAt ? now - state.lastAt : 0;
    state.lastAt = now;
    streamTraceState.set(key, state);
    if (event.type === "message_update" && !(state.count <= 3 || state.count % 20 === 0 || gapMs >= 500)) return;
    trace(`stream_trace stage=${stage} traceId=${traceId || "-"} session=${event.sessionId || ""} run=${event.runId || ""} span=${event.spanId || ""} event=${event.type || ""} n=${state.count} chars=${contentChars || state.chars} deltaChars=${deltaChars} gapMs=${gapMs}${formatTraceFields(extra)}`);
  }

  return Object.freeze({
    register,
    broadcast,
    sendToWindow,
    acceptDynamicContextResponse,
    requestLocation,
    remember,
    clearPending,
    getWindowId: (port: Port) => portWindowIds.get(nativePorts.get(port) || port) ?? null,
    hasPorts: (windowId?: unknown) => {
      if (windowId === undefined) return ports.size > 0;
      const targetWindowId = normalizeWindowId(windowId);
      return targetWindowId !== null && [...portWindowIds.values()].includes(targetWindowId);
    },
    size: (windowId?: unknown) => {
      if (windowId === undefined) return ports.size;
      const targetWindowId = normalizeWindowId(windowId);
      return targetWindowId === null
        ? 0
        : [...portWindowIds.values()].filter(id => id === targetWindowId).length;
    },
    isRuntimeEvent,
    recordStreamTrace,
  });
}

function normalizeWindowId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function formatTraceFields(fields: Fields = {}) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}=${formatTraceValue(value)}`)
    .join("");
}

function formatTraceValue(value: unknown) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w:./|@=-]/g, "_")
    .slice(0, 160);
}

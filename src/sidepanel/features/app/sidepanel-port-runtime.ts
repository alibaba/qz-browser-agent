import { sessionIdText as normalizeSessionId } from "../sessions/session-id.js";
import type { TranscriptAgentEvent } from "../../../shared/contracts/session.js";
interface RuntimeOptions extends Pick<PortClientOptions, "connect" | "keepAliveMs" | "reconnectDelayMs" | "maxReconnectDelayMs" | "shouldKeepAlive"> {
  traceEnabled?: boolean; isTraceEnabled?(): boolean; getCurrentSessionId?(): unknown;
}
type TraceEvent = TranscriptAgentEvent & { sessionId?: string };

import { createPortClient, type PortClientOptions, type PortMessage } from "./port-client.js";

export function createSidepanelPortRuntime(options: RuntimeOptions = {}) {
  const traceState = new Map<string, { count: number; chars: number; lastAt: number }>();
  const lastTraceIdBySession = new Map<string, string>();
  const isTraceEnabled = typeof options.isTraceEnabled === "function"
    ? options.isTraceEnabled
    : () => options.traceEnabled === true;
  let attachedWindowId: number | null = null;
  const client = createPortClient({
    name: "sidepanel",
    connect: options.connect,
    keepAliveMs: options.keepAliveMs,
    reconnectDelayMs: options.reconnectDelayMs || 300,
    maxReconnectDelayMs: options.maxReconnectDelayMs || 3000,
    shouldKeepAlive: options.shouldKeepAlive,
    onListenerError(error, event) {
      console.warn("[轻舟] port listener failed", (event && typeof event === "object" && "type" in event ? event.type : "event"), error);
    },
  });

  function send(message: PortMessage) {
    client.send(message).catch(() => {});
  }

  function request(type: string, payload: PortMessage = {}, timeoutMs: number | null = 5000) {
    return client.request(type, payload, timeoutMs);
  }

  function attachWindow(windowId: unknown, timeoutMs = 1500) {
    const id = normalizeWindowId(windowId);
    if (id === null) return Promise.reject(new Error("Side Panel windowId is required"));
    attachedWindowId = id;
    return request("sidepanel_attach", { windowId: id }, timeoutMs);
  }

  function emitStreamTrace(stage: string, event: TraceEvent = {}, fields: PortMessage = {}) {
    if (!isTraceEnabled()) return;
    const sessionId = normalizeSessionId(event.sessionId || options.getCurrentSessionId?.());
    const streamEvent = isStreamTraceEvent(event);
    const traceId = String(
      event.streamTraceId
      || event.spanId
      || (sessionId ? lastTraceIdBySession.get(sessionId) : "")
      || "",
    ).trim();
    if (!traceId && !streamEvent) return;
    if (sessionId && traceId && streamEvent) lastTraceIdBySession.set(sessionId, traceId);

    const key = `${stage}:${traceId || sessionId || "unknown"}`;
    const state = traceState.get(key) || { count: 0, chars: 0, lastAt: 0 };
    const now = Date.now();
    const deltaChars = String(event.delta || "").length;
    const contentChars = String(event.content || (typeof event.message === "object" ? event.message?.content : "") || "").length;
    if (event.type === "message_update") state.count += 1;
    state.chars = Math.max(state.chars, contentChars);
    const gapMs = state.lastAt ? now - state.lastAt : 0;
    state.lastAt = now;
    traceState.set(key, state);
    if (event.type === "message_update" && !shouldTraceDelta(state.count, gapMs)) return;

    send({
      type: "stream_trace",
      stage,
      traceId: traceId || "-",
      sessionId,
      runId: event.runId || "",
      spanId: event.spanId || "",
      fields: {
        event: event.type || "",
        n: state.count,
        chars: contentChars || state.chars,
        deltaChars,
        gapMs,
        ...fields,
      },
    });
  }

  function getTraceId(sessionId: unknown) {
    return lastTraceIdBySession.get(normalizeSessionId(sessionId)) || "";
  }

  client.onStateChange((snapshot) => {
    if (snapshot?.state !== "connected") return;
    if (attachedWindowId !== null) send({ type: "sidepanel_attach", windowId: attachedWindowId });
    const sessionId = normalizeSessionId(options.getCurrentSessionId?.());
    if (sessionId) send({ type: "get_state", sessionId });
  });

  return {
    client,
    send,
    request,
    attachWindow,
    start: () => client.start(),
    stop: () => client.stop(),
    syncKeepAlive: () => client.syncKeepAlive(),
    onMessage: client.onMessage,
    emitStreamTrace,
    getTraceId,
  };
}

function isStreamTraceEvent(event: TraceEvent) {
  return event?.type === "message_start" || event?.type === "message_update" || event?.type === "message_end";
}

function shouldTraceDelta(count: number, gapMs = 0) {
  const value = Number(count) || 0;
  return value <= 3 || value % 20 === 0 || Number(gapMs) >= 500;
}


function normalizeWindowId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

import { createPortTransport } from "../../../shared/transport/port-transport.js";
import { isConnectionFailure, MESSAGE_TRANSFER_BYTES, normalizeTransportError, prepareMessage, transportFailure, TransportError } from "../../../shared/transport/message-codec.js";
import type { PreparedMessage } from "../../../shared/transport/message-codec.js";
import { productText } from "../../../shared/product-text.js";
import { createReceiveBudget, createTransferBudget } from "../../../shared/transport/transfer-budget.js";

export type PortMessage = Record<string, unknown>;
type Timer = ReturnType<typeof setTimeout>;
type PortState = "idle" | "connecting" | "connected" | "disconnected" | "stopped";
interface PortLike {
  postMessage(message: PortMessage): void;
  disconnect?(): void;
  onMessage: { addListener(listener: (event: unknown) => void): void; removeListener?(listener: (event: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void; removeListener?(listener: () => void): void };
}
export interface PortClientOptions {
  name?: string;
  connect?(options: { name: string }): PortLike | undefined;
  setTimeout?(callback: () => void, delay: number): Timer;
  clearTimeout?(timer: Timer): void;
  setInterval?(callback: () => void, delay: number): Timer;
  clearInterval?(timer: Timer): void;
  requestTimeoutMs?: number; keepAliveMs?: number; reconnectDelayMs?: number; maxReconnectDelayMs?: number;
  maxQueuedMessages?: number; maxBufferedBytes?: number;
  shouldKeepAlive?(): boolean;
  /** Optional diagnostic suffix; the client always owns the request namespace. */
  createRequestId?(sequence: number, type: string): string;
  onListenerError?(error: unknown, event: unknown): void;
}
interface SentMessage { generation: number }
interface QueuedMessage { prepared: PreparedMessage; token: symbol; controller: AbortController; resolve(result: SentMessage): void; reject(error: unknown): void }
interface PendingRequest {
  requestId: string; type: string; generation: number; token: symbol; timer: Timer | null;
  controller: AbortController;
  resolve(response: PortMessage): void; reject(error: unknown): void;
}
export interface PortSnapshot {
  state: PortState; connected: boolean; stopped: boolean; generation: number; queued: number;
  bufferedBytes: number;
  pendingRequests: number; reconnectAttempt: number; keepAlive: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_KEEP_ALIVE_MS = 10000;
const DEFAULT_RECONNECT_DELAY_MS = 300;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 3000;

export class PortClientError extends Error {
  readonly code: string;
  readonly details: PortMessage;
  constructor(code: string, message: string, details: PortMessage = {}) {
    super(message);
    this.name = "PortClientError";
    this.code = code;
    this.details = details;
  }
}

export function createPortClient(options: PortClientOptions = {}) {
  const connect: NonNullable<PortClientOptions["connect"]> = typeof options.connect === "function"
    ? options.connect
    : () => globalThis.chrome?.runtime?.connect?.({ name: options.name || "sidepanel" });
  const setTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const setRepeatingTimer = options.setInterval || globalThis.setInterval.bind(globalThis);
  const clearRepeatingTimer = options.clearInterval || globalThis.clearInterval.bind(globalThis);
  const requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const keepAliveMs = positiveNumber(options.keepAliveMs, DEFAULT_KEEP_ALIVE_MS);
  const reconnectDelayMs = positiveNumber(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
  const maxReconnectDelayMs = Math.max(
    reconnectDelayMs,
    positiveNumber(options.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS),
  );
  const shouldKeepAlive = typeof options.shouldKeepAlive === "function"
    ? options.shouldKeepAlive
    : () => false;
  const requestPrefix = `ui_req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_`;
  const maxQueuedMessages = options.maxQueuedMessages ?? 256;
  if (!Number.isSafeInteger(maxQueuedMessages) || maxQueuedMessages < 1) throw new TypeError("Invalid Port queue limit");
  const budget = createTransferBudget(options.maxBufferedBytes ?? 2 * MESSAGE_TRANSFER_BYTES);

  const receiveBudget = createReceiveBudget();

  let port: PortLike | null = null;
  let generation = 0;
  let state: PortState = "idle";
  let stopped = true;
  let reconnectAttempt = 0;
  let reconnectTimer: Timer | null = null;
  let keepAliveTimer: Timer | null = null;
  let requestSequence = 0;
  const queue: QueuedMessage[] = [];
  const pendingRequests = new Map<string, PendingRequest>();
  const messageListeners = new Set<(event: unknown) => void>();
  const stateListeners = new Set<(snapshot: PortSnapshot) => void>();
  const portHandlers = new WeakMap<PortLike, { transport: ReturnType<typeof createPortTransport>; onMessageHandler(event: unknown): void; onDisconnectHandler(): void }>();

  const api = {
    start,
    stop,
    send,
    request,
    onMessage,
    onStateChange,
    syncKeepAlive,
    getSnapshot,
  };

  function start() {
    if (!stopped) return api;
    stopped = false;
    connectNow();
    return api;
  }

  function stop(reason = "stopped") {
    if (stopped && state === "stopped") return;
    stopped = true;
    cancelReconnect();
    stopKeepAlive();
    const current = port;
    port = null;
    generation += 1;
    unbindPort(current);
    try {
      current?.disconnect?.();
    } catch (_err) {}

    const error = new PortClientError("PORT_STOPPED", `Port client ${reason}`, { reason });
    rejectQueued(error);
    rejectPending(() => true, error);
    setState("stopped", { reason });
  }

  function send(message: unknown) {
    return enqueue(message, Symbol("port-message"));
  }

  function request(type: string, payload: PortMessage = {}, timeoutMs: number | null = requestTimeoutMs): Promise<PortMessage> {
    const requestType = String(type || "").trim();
    if (!requestType) {
      return Promise.reject(new PortClientError("INVALID_REQUEST_TYPE", "Port request type is required"));
    }
    const sequence = ++requestSequence;
    const suffix = String(options.createRequestId?.(sequence, requestType) || requestType).slice(0, 80);
    const requestId = `${requestPrefix}${sequence}:${suffix}`;
    const token = Symbol(requestId);
    const controller = new AbortController();
    const timeout = timeoutMs === null ? 0 : positiveNumber(timeoutMs, requestTimeoutMs);

    return new Promise<PortMessage>((resolve, reject) => {
      const timer = timeout ? setTimer(() => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        controller.abort();
        removeQueued(token, new PortClientError("PORT_REQUEST_TIMEOUT", `${requestType} timed out`, {
          requestId,
          type: requestType,
          timeoutMs: timeout,
        }));
        reject(new PortClientError("PORT_REQUEST_TIMEOUT", `${requestType} timed out`, {
          requestId,
          type: requestType,
          timeoutMs: timeout,
        }));
      }, timeout) : null;

      pendingRequests.set(requestId, {
        requestId,
        type: requestType,
        generation: 0,
        resolve,
        reject,
        timer,
        token,
        controller,
      });

      enqueue({ ...(isPlainObject(payload) ? payload : {}), type: requestType, requestId }, token, controller)
        .then(({ generation: sentGeneration }) => {
          const pending = pendingRequests.get(requestId);
          if (pending) pending.generation = sentGeneration;
        })
        .catch((error) => settleRequestError(requestId, error));
    });
  }

  function enqueue(message: unknown, token: symbol, controller = new AbortController()): Promise<SentMessage> {
    if (!isPlainObject(message)) {
      return Promise.reject(new PortClientError("INVALID_PORT_MESSAGE", "Port message must be an object"));
    }
    if (stopped) start();
    let prepared: PreparedMessage;
    try { prepared = prepareMessage(message); }
    catch (error) { return Promise.reject(error); }
    if (port && state === "connected" && !queue.length) return transmit(prepared, port, generation, controller.signal);
    return new Promise<SentMessage>((resolve, reject) => {
      if (queue.length >= maxQueuedMessages) throw new TransportError("TRANSPORT_BUSY", { queuedMessages: queue.length, limitMessages: maxQueuedMessages });
      budget.reserve(prepared.bytes);
      queue.push({ prepared, token, controller, resolve, reject });
      flush();
    });
  }

  function connectNow() {
    if (stopped || port || state === "connecting") return;
    cancelReconnect();
    setState("connecting", { attempt: reconnectAttempt + 1 });
    try {
      const nextPort = connect({ name: options.name || "sidepanel" });
      if (!nextPort?.postMessage || !nextPort?.onMessage?.addListener || !nextPort?.onDisconnect?.addListener) {
        throw new PortClientError("INVALID_PORT", "Runtime connect did not return a compatible port");
      }
      port = nextPort;
      generation += 1;
      bindPort(nextPort, generation);
      reconnectAttempt = 0;
      setState("connected", { generation });
      flush();
      syncKeepAlive();
    } catch (error) {
      port = null;
      setState("disconnected", { error: normalizeError(error) });
      scheduleReconnect();
    }
  }

  function bindPort(boundPort: PortLike, boundGeneration: number) {
    const transport = createPortTransport({
      budget,
      receiveBudget,
      limits: { messages: maxQueuedMessages },
      postMessage(message) {
        try { boundPort.postMessage(message); }
        catch (cause) {
          const error = normalizeTransportError(cause);
          // Stop handing offline work to this connection before flush advances.
          if (isConnectionFailure(error)) handleDisconnect(boundPort, boundGeneration, error);
          throw error;
        }
      },
      onMessage: event => handleMessage(boundPort, boundGeneration, event),
      onError: (error, identity) => handleMessage(boundPort, boundGeneration, transportFailure(error, identity, "transport_error")),
    });
    const onMessageHandler = (event: unknown) => transport.receive(event);
    const onDisconnectHandler = () => handleDisconnect(boundPort, boundGeneration);
    portHandlers.set(boundPort, { transport, onMessageHandler, onDisconnectHandler });
    boundPort.onMessage.addListener(onMessageHandler);
    boundPort.onDisconnect.addListener(onDisconnectHandler);
  }

  function unbindPort(boundPort: PortLike | null) {
    if (!boundPort) return;
    const handlers = portHandlers.get(boundPort);
    if (!handlers) return;
    boundPort.onMessage?.removeListener?.(handlers.onMessageHandler);
    boundPort.onDisconnect?.removeListener?.(handlers.onDisconnectHandler);
    handlers.transport.dispose();
    portHandlers.delete(boundPort);
  }

  function handleDisconnect(boundPort: PortLike, boundGeneration: number, cause: unknown = null) {
    if (port !== boundPort || generation !== boundGeneration) return;
    unbindPort(boundPort);
    port = null;
    stopKeepAlive();
    const error = new PortClientError("PORT_DISCONNECTED", productText("Side Panel port disconnected", "Sidebar port disconnected"), {
      generation: boundGeneration,
      ...(cause ? { cause: normalizeError(cause) } : {}),
    });
    rejectPending(pending => pending.generation === boundGeneration, error);
    setState("disconnected", { generation: boundGeneration });
    scheduleReconnect();
  }

  function handleMessage(boundPort: PortLike, boundGeneration: number, event: unknown) {
    if (port !== boundPort || generation !== boundGeneration) return;
    const response = isPlainObject(event) ? event : {};
    const requestId = String(response.requestId || "").trim();
    const pending = requestId ? pendingRequests.get(requestId) : undefined;
    if (pending) {
      pendingRequests.delete(requestId);
      if (pending.timer !== null) clearTimer(pending.timer);
      if (["error", "request_failed", "transport_error"].includes(String(response.type)) || response.ok === false) {
        pending.reject(new PortClientError(
          String(response.code || "PORT_REQUEST_FAILED"),
          String(response.message || response.error || `${pending.type} failed`),
          { requestId, type: pending.type, response: event },
        ));
      } else {
        pending.resolve(response);
      }
      return;
    }
    // Responses to completed, failed or expired local requests are never task events.
    // The namespace and issued sequence avoid retaining a growing tombstone set.
    if (requestId.startsWith(requestPrefix)) {
      const sequence = Number(requestId.slice(requestPrefix.length).split(":", 1)[0]);
      if (Number.isSafeInteger(sequence) && sequence > 0 && sequence <= requestSequence) return;
    }

    for (const listener of messageListeners) {
      try {
        listener(event);
      } catch (error) {
        options.onListenerError?.(error, event);
      }
    }
  }

  function flush() {
    if (!port || state !== "connected") {
      connectNow();
      return;
    }
    while (queue.length && port && state === "connected") {
      const item = queue.shift()!;
      // Only offline work lives here. Online order and transfer ownership belong to the Port.
      budget.release(item.prepared.bytes);
      void transmit(item.prepared, port, generation, item.controller.signal).then(item.resolve, item.reject);
    }
  }

  function transmit(prepared: PreparedMessage, activePort: PortLike, activeGeneration: number, signal?: AbortSignal): Promise<SentMessage> {
    const pending = pendingRequests.get(String(prepared.identity.requestId || ""));
    if (pending) pending.generation = activeGeneration;
    const transport = portHandlers.get(activePort)?.transport;
    const sending = transport ? transport.sendPrepared(prepared, { signal }) : Promise.reject(new TransportError("TRANSPORT_DISCONNECTED"));
    return sending.then(() => ({ generation: activeGeneration }), cause => {
      if (stopped) throw new PortClientError("PORT_STOPPED", "Port client stopped", { generation: activeGeneration });
      const error = normalizeTransportError(cause);
      if (isConnectionFailure(error)) handleDisconnect(activePort, activeGeneration, error);
      throw new PortClientError(isConnectionFailure(error) ? "PORT_SEND_FAILED" : error.code, error.message, {
        generation: activeGeneration, ...error.details,
      });
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = Math.min(maxReconnectDelayMs, reconnectDelayMs * (2 ** Math.max(0, reconnectAttempt - 1)));
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connectNow();
    }, delay);
  }

  function cancelReconnect() {
    if (reconnectTimer) clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  function syncKeepAlive() {
    const enabled = !stopped && state === "connected" && Boolean(shouldKeepAlive());
    if (!enabled) {
      stopKeepAlive();
      return false;
    }
    if (!keepAliveTimer) {
      keepAliveTimer = setRepeatingTimer(() => {
        if (!port || state !== "connected" || !shouldKeepAlive()) {
          syncKeepAlive();
          return;
        }
        void send({ type: "ping" }).catch(() => {});
      }, keepAliveMs);
    }
    return true;
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearRepeatingTimer(keepAliveTimer);
    keepAliveTimer = null;
  }

  function onMessage(listener: (event: unknown) => void) {
    if (typeof listener !== "function") return () => {};
    messageListeners.add(listener);
    return () => messageListeners.delete(listener);
  }

  function onStateChange(listener: (snapshot: PortSnapshot) => void) {
    if (typeof listener !== "function") return () => {};
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  function setState(nextState: PortState, details: PortMessage = {}) {
    if (state === nextState && !Object.keys(details).length) return;
    state = nextState;
    const snapshot = getSnapshot(details);
    for (const listener of stateListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        options.onListenerError?.(error, snapshot);
      }
    }
  }

  function getSnapshot(extra: PortMessage = {}): PortSnapshot {
    return {
      state,
      connected: state === "connected",
      stopped,
      generation,
      queued: queue.length + (port ? portHandlers.get(port)?.transport.snapshot().queued || 0 : 0),
      bufferedBytes: budget.snapshot().reservedBytes,
      pendingRequests: pendingRequests.size,
      reconnectAttempt,
      keepAlive: Boolean(keepAliveTimer),
      ...extra,
    };
  }

  function settleRequestError(requestId: string, error: unknown) {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    if (pending.timer !== null) clearTimer(pending.timer);
    pending.reject(error);
  }

  function rejectPending(predicate: (request: PendingRequest) => boolean, error: unknown) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      if (!predicate(pending)) continue;
      pendingRequests.delete(requestId);
      if (pending.timer !== null) clearTimer(pending.timer);
      pending.reject(error);
    }
  }

  function rejectQueued(error: unknown) {
    for (const item of [...queue]) {
      removeQueued(item.token, error);
    }
  }

  function removeQueued(token: symbol, error: unknown) {
    const index = queue.findIndex(item => item.token === token);
    if (index < 0) return false;
    const [item] = queue.splice(index, 1);
    budget.release(item.prepared.bytes);
    item.controller.abort();
    item.reject(error);
    return true;
  }

  return api;
}

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isPlainObject(value: unknown): value is PortMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeError(error: unknown) {
  const value = isPlainObject(error) ? error : {};
  return {
    name: String(value.name || "Error"),
    code: String(value.code || ""),
    message: String(value.message || error || "Unknown error"),
  };
}

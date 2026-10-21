import { normalizeSvgImage } from "./offscreen-image-conversion.js";
import { requestRuntimeMessage } from "./shared/transport/runtime-request.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
interface PendingRun {
  resolve(result: unknown): void; reject(error: unknown): void;
  sessionId: string; runId: string; depth: number;
  fetches: Map<string, AbortController>;
}

setInterval(() => {
  chrome.runtime.sendMessage({
    type: "offscreen_keepalive",
    at: Date.now(),
  }).catch(() => {
    // The service worker may be restarting; the next tick will reconnect.
  });
}, 10_000);

const HOST_SOURCE = "qz-inner-runner-host";
const SANDBOX_SOURCE = "qz-inner-runner-sandbox";
const SANDBOX_URL = chrome.runtime.getURL("runner-sandbox.html");

let sandboxFrame: HTMLIFrameElement | null = null;
let sandboxReady: Promise<void> | null = null;
let sandboxReadyResolve: (() => void) | null = null;
const pendingRuns = new Map<string, PendingRun>();

chrome.runtime.onMessage.addListener((input: unknown, _sender, sendResponse) => {
  const msg = record(input);
  if (msg?.type === "convert_svg_image_ping") {
    sendResponse({ imageConverterReady: true });
    return false;
  }
  if (msg?.type === "convert_svg_image") {
    if (_sender.id !== chrome.runtime.id) return false;
    normalizeSvgImage(msg.dataUrl, record(msg.options))
      .then(image => sendResponse({ ok: true, image }))
      .catch(error => sendResponse({ ok: false, error: error.message, code: error.code, details: error.details }));
    return true;
  }
  if (msg?.type === "run_script_inner_ping") {
    ensureSandboxFrame()
      .then(() => sendResponse({ ok: true, ready: true, sandboxReady: true, at: Date.now() }))
      .catch((err) => sendResponse({
        ok: false,
        ready: false,
        sandboxReady: false,
        error: messageOf(err),
        code: record(err).code || "INNER_RUNNER_SANDBOX_NOT_READY",
      }));
    return true;
  }
  if (msg?.type === "run_script_inner_execute") {
    traceInnerOffscreen("message.execute", {
      requestId: msg.requestId,
      sourceLength: String(msg.source || "").length,
      sessionId: msg.sessionId || "",
      runId: msg.runId || "",
    });
    sendResponse({ ok: true, accepted: true, requestId: String(msg.requestId || "") });
    runInnerScript(msg)
      .then((result) => publishInnerRunResult(msg.requestId, result))
      .catch((err) => publishInnerRunResult(msg.requestId, {
        __runScriptEnvelope: true,
        ok: false,
        hasResult: false,
        result: null,
        resultType: "error",
        engine: "offscreen_inner",
        execution_world: "inner",
        error: messageOf(err),
        code: record(err).code || "INNER_RUNNER_FAILED",
        details: record(err).details || {},
        trace: [],
        elapsedMs: 0,
      }));
    return false;
  }
  if (msg?.type === "run_script_inner_cancel") {
    cancelInnerRun(String(msg.requestId || ""), "cancelled");
    sendResponse({ ok: true, cancelled: true });
    return false;
  }
  return false;
});

window.addEventListener("message", (event) => {
  if (!sandboxFrame) return;
  if (event.source !== sandboxFrame.contentWindow) return;
  const data = record(event.data);
  if (data.source !== SANDBOX_SOURCE) return;
  traceInnerOffscreen("sandbox.message", {
    type: data.type || "",
    requestId: data.requestId || "",
    callId: data.callId || "",
    resultOk: record(data.result).ok,
    resultCode: record(data.result).code || "",
  });
  if (data.type === "ready") {
    sandboxReadyResolve?.();
    sandboxReadyResolve = null;
    return;
  }
  if (data.type === "trace") {
    traceInnerOffscreen(`sandbox.${data.phase || "trace"}`, record(data.details));
    return;
  }
  if (data.type === "result") {
    const requestId = String(data.requestId || "");
    const pending = pendingRuns.get(requestId);
    if (!pending) return;
    pendingRuns.delete(requestId);
    cancelPendingFetches(requestId, pending);
    pending.resolve(data.result);
    return;
  }
  if (data.type === "tool_call") {
    relayInnerToolCall(data).catch((err) => {
      postToSandbox({
        type: "tool_response",
        requestId: data.requestId,
        callId: data.callId,
        response: {
          ok: false,
          error: messageOf(err),
          code: record(err).code || "INNER_TOOL_CALL_FAILED",
          details: record(err).details || {},
        },
      });
    });
    return;
  }
  if (data.type === "fetch_call") {
    void relayInnerFetchCall(data);
    return;
  }
  if (data.type === "fetch_cancel") {
    relayInnerFetchCancel(data).catch(() => {
      // The request may already have completed; cancellation is best-effort.
    });
  }
});

function runInnerScript(msg: Record<string, unknown>): Promise<unknown> {
  const requestId = String(msg.requestId || "");
  if (!requestId) return Promise.reject(new Error("run_script inner requires requestId"));
  if (pendingRuns.has(requestId)) return Promise.reject(new Error("duplicate inner requestId"));
  return new Promise((resolve, reject) => {
    const pending: PendingRun = { resolve, reject,
      sessionId: String(msg.sessionId || ""), runId: String(msg.runId || ""),
      depth: Math.max(0, Math.floor(Number(msg.depth) || 0)), fetches: new Map() };
    pendingRuns.set(requestId, pending);
    void ensureSandboxFrame().then(() => {
      if (pendingRuns.get(requestId) !== pending) return;
      traceInnerOffscreen("run.start", { requestId });
      postToSandbox({ type: "execute", requestId, scriptSource: String(msg.source || ""),
        scriptArgs: record(msg.scriptArgs), securityGuardrails: record(msg.securityGuardrails),
        fetchBridge: msg.fetchBridge === true });
    }).catch(error => {
      if (pendingRuns.get(requestId) !== pending) return;
      pendingRuns.delete(requestId);
      reject(error);
    });
  });
}

function ensureSandboxFrame(): Promise<void> {
  if (sandboxReady) return sandboxReady;
  traceInnerOffscreen("sandbox.ensure.create", {});
  sandboxFrame?.remove();
  const frame = document.createElement("iframe");
  sandboxFrame = frame;
  frame.src = SANDBOX_URL;
  frame.style.display = "none";
  const ready = new Promise<void>(resolve => { sandboxReadyResolve = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  sandboxReady = Promise.race([ready, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeSandboxReadyTimeoutError()), 3000);
  })]).catch(error => {
    frame.remove();
    sandboxFrame = null;
    sandboxReady = null;
    sandboxReadyResolve = null;
    throw error;
  }).finally(() => clearTimeout(timer));
  document.body.appendChild(frame);
  return sandboxReady;
}

function postToSandbox(payload: Record<string, unknown> = {}) {
  const target = sandboxFrame?.contentWindow;
  if (!target) throw new Error("run_script inner sandbox frame is not available");
  target.postMessage({
    source: HOST_SOURCE,
    ...payload,
  }, "*");
}

function cancelInnerRun(requestId: string, reason = "cancelled") {
  traceInnerOffscreen("run.cancel", { requestId, reason });
  const pending = pendingRuns.get(requestId);
  if (pending) {
    pendingRuns.delete(requestId);
    cancelPendingFetches(requestId, pending);
    const error = Object.assign(new Error(`run_script inner ${reason}`), { code: "OPERATION_ABORTED" });
    pending.reject(error);
  }
  if (sandboxFrame?.contentWindow) postToSandbox({ type: "cancel", requestId });
}

async function relayInnerToolCall(data: Record<string, unknown>) {
  const requestId = String(data.requestId || "");
  const pending = pendingRuns.get(requestId);
  if (!pending) return;
  traceInnerOffscreen("tool.call", {
    requestId,
    callId: data.callId || "",
    toolName: data.toolName || "",
  });
  const response = record(await chrome.runtime.sendMessage({
    type: "run_script_tool_call",
    toolName: String(data.toolName || ""),
    args: data.args && typeof data.args === "object" ? data.args : {},
    sessionId: pending.sessionId,
    runId: pending.runId,
    depth: pending.depth + 1,
    inner: true,
  }));
  if (pendingRuns.get(requestId) !== pending) return;
  traceInnerOffscreen("tool.response", {
    requestId,
    callId: data.callId || "",
    toolName: data.toolName || "",
    ok: response?.ok === true,
    code: response?.code || record(response.result).code || "",
  });
  postToSandbox({
    type: "tool_response",
    requestId,
    callId: data.callId,
    response: response || { ok: false, error: "empty inner tool response" },
  });
}

async function relayInnerFetchCall(data: Record<string, unknown>) {
  const requestId = String(data.requestId || "");
  const pending = pendingRuns.get(requestId);
  if (!pending) return;
  const callId = String(data.callId || "");
  const controller = new AbortController();
  pending.fetches.set(callId, controller);
  let response: Record<string, unknown>;
  try {
    response = await requestRuntimeMessage({
      type: "run_script_inner_fetch", requestId, callId, request: record(data.request),
    }, { signal: controller.signal });
  } catch (err) {
    response = {
      ok: false, error: messageOf(err),
      code: controller.signal.aborted ? "OPERATION_ABORTED" : record(err).code || "SKILL_NETWORK_FETCH_FAILED",
      details: record(err).details || {},
      ...(record(err).diagnostic ? { diagnostic: record(err).diagnostic } : {}),
    };
  } finally {
    if (pending.fetches.get(callId) === controller) pending.fetches.delete(callId);
  }
  if (pendingRuns.get(requestId) !== pending) return;
  postToSandbox({
    type: "fetch_response",
    requestId,
    callId,
    response,
  });
}

async function relayInnerFetchCancel(data: Record<string, unknown>) {
  const requestId = String(data.requestId || "");
  const pending = pendingRuns.get(requestId);
  if (!pending) return;
  const callId = String(data.callId || "");
  pending.fetches.get(callId)?.abort();
  await chrome.runtime.sendMessage({
    type: "run_script_inner_fetch_cancel",
    requestId,
    callId,
  });
}

function cancelPendingFetches(requestId: string, pending: PendingRun) {
  for (const [callId, controller] of pending.fetches) {
    controller.abort();
    void chrome.runtime.sendMessage({ type: "run_script_inner_fetch_cancel", requestId, callId }).catch(() => {});
  }
  pending.fetches.clear();
}

function traceInnerOffscreen(phase: string, details: Record<string, unknown> = {}) {
  try {
    chrome.runtime.sendMessage({
      type: "run_script_inner_trace",
      phase,
      details,
    }).catch(() => {});
  } catch (_err) {
    // Trace must not affect offscreen execution.
  }
}

function makeSandboxReadyTimeoutError() {
  return Object.assign(new Error("run_script inner sandbox did not report ready"), { code: "INNER_RUNNER_SANDBOX_NOT_READY" });
}

function publishInnerRunResult(requestId: unknown, result: unknown) {
  const id = String(requestId || "");
  traceInnerOffscreen("result.publish", {
    requestId: id,
    ok: record(result).ok,
    code: record(result).code || "",
  });
  return chrome.runtime.sendMessage({
    type: "run_script_inner_result",
    requestId: id,
    result,
  });
}

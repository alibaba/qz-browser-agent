import type { InnerWorkerOutput } from './shared/contracts/inner-runner.js';

/** Injected from the separately compiled Worker entry by build-extension.mjs. */
declare const INNER_WORKER_SOURCE: string;

const HOST_SOURCE = "qz-inner-runner-host";
const SANDBOX_SOURCE = "qz-inner-runner-sandbox";

const workers = new Map<string, Worker>();

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent) return;
  if (!event.data || typeof event.data !== "object") return;
  const data = event.data as Record<string, unknown>;
  if (data.source !== HOST_SOURCE) return;
  if (data.type === "execute") {
    startWorkerRun(data);
  } else if (data.type === "tool_response") {
    const worker = workers.get(String(data.requestId || ""));
    worker?.postMessage({
      type: "tool_response",
      callId: data.callId,
      response: data.response,
    });
  } else if (data.type === "fetch_response") {
    const worker = workers.get(String(data.requestId || ""));
    worker?.postMessage({
      type: "fetch_response",
      callId: data.callId,
      response: data.response,
    });
  } else if (data.type === "trace_snapshot") {
    const requestId = String(data.requestId || "");
    workers.get(requestId)?.postMessage({ type: "trace_snapshot", requestId });
  } else if (data.type === "cancel") {
    cancelWorkerRun(String(data.requestId || ""));
  }
});

parent.postMessage({ source: SANDBOX_SOURCE, type: "ready" }, "*");

function startWorkerRun(data: Record<string, unknown>) {
  const requestId = String(data.requestId || "");
  if (!requestId) return;
  cancelWorkerRun(requestId);
  traceInnerSandbox("worker.start", {
    requestId,
    sourceLength: String(data.scriptSource || "").length,
  });
  let workerUrl = "";
  let worker = null;
  try {
    workerUrl = URL.createObjectURL(new Blob([INNER_WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(workerUrl);
  } catch (err) {
    traceInnerSandbox("worker.create_error", {
      requestId,
      message: errorMessage(err),
    });
    parent.postMessage({
      source: SANDBOX_SOURCE,
      type: "result",
      requestId,
      result: {
        __runScriptEnvelope: true,
        ok: false,
        hasResult: false,
        result: null,
        resultType: "error",
        engine: "offscreen_inner",
        execution_world: "inner",
        error: errorMessage(err),
        code: "SCRIPT_CONTEXT_UNAVAILABLE",
        trace: [{ time: new Date().toISOString(), level: "error", message: errorMessage(err) }],
        elapsedMs: 0,
      },
    }, "*");
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    return;
  }
  if (workerUrl) setTimeout(() => URL.revokeObjectURL(workerUrl), 1000);
  workers.set(requestId, worker);
  worker.onmessage = (event: MessageEvent<InnerWorkerOutput>) => {
    if (workers.get(requestId) !== worker) return;
    const message = event.data || {};
    if (message.type === "script_trace") {
      parent.postMessage({ source: SANDBOX_SOURCE, type: "script_trace", requestId, row: message.row }, "*");
      return;
    }
    if (message.type === "tool_call") {
      traceInnerSandbox("worker.tool_call", {
        requestId,
        callId: message.callId || "",
        toolName: message.toolName || "",
      });
      parent.postMessage({
        source: SANDBOX_SOURCE,
        type: "tool_call",
        requestId,
        callId: message.callId,
        toolName: message.toolName,
        args: message.args || {},
      }, "*");
      return;
    }
    if (message.type === "fetch_call") {
      parent.postMessage({
        source: SANDBOX_SOURCE,
        type: "fetch_call",
        requestId,
        callId: message.callId,
        request: message.request || {},
      }, "*");
      return;
    }
    if (message.type === "fetch_cancel") {
      parent.postMessage({
        source: SANDBOX_SOURCE,
        type: "fetch_cancel",
        requestId,
        callId: message.callId,
      }, "*");
      return;
    }
    if (message.type === "trace_snapshot") {
      parent.postMessage({
        source: SANDBOX_SOURCE,
        type: "trace_snapshot",
        requestId,
        trace: Array.isArray(message.trace) ? message.trace.slice(-5) : [],
      }, "*");
      return;
    }
    if (message.type === "result") {
      workers.delete(requestId);
      worker.terminate();
      traceInnerSandbox("worker.result", {
        requestId,
        ok: message.result?.ok,
        code: message.result?.code || "",
        traceCount: Array.isArray(message.result?.trace) ? message.result.trace.length : 0,
      });
      parent.postMessage({
        source: SANDBOX_SOURCE,
        type: "result",
        requestId,
        result: message.result,
      }, "*");
    }
  };
  worker.onerror = (event) => {
    if (workers.get(requestId) !== worker) return;
    workers.delete(requestId);
    worker.terminate();
    traceInnerSandbox("worker.error", {
      requestId,
      message: event.message || "",
    });
    parent.postMessage({
      source: SANDBOX_SOURCE,
      type: "result",
      requestId,
      result: {
        __runScriptEnvelope: true,
        ok: false,
        hasResult: false,
        result: null,
        resultType: "error",
        engine: "offscreen_inner",
        execution_world: "inner",
        error: event.message || "Script execution failed",
        code: "SCRIPT_CONTEXT_UNAVAILABLE",
        trace: [],
        elapsedMs: 0,
      },
    }, "*");
  };
  worker.postMessage({
    type: "execute",
    requestId,
    source: String(data.scriptSource || ""),
    scriptArgs: data.scriptArgs,
    securityGuardrails: data.securityGuardrails && typeof data.securityGuardrails === "object" ? data.securityGuardrails : {},
    fetchBridge: data.fetchBridge === true,
    strictResult: data.strictResult === true,
  });
}

function cancelWorkerRun(requestId: string) {
  const worker = workers.get(requestId);
  if (!worker) return;
  traceInnerSandbox("worker.cancel", { requestId });
  workers.delete(requestId);
  worker.terminate();
}

function traceInnerSandbox(phase: string, details: Record<string, unknown> = {}) {
  try {
    parent.postMessage({
      source: SANDBOX_SOURCE,
      type: "trace",
      phase,
      details,
    }, "*");
  } catch (_err) {
    // Trace must not affect sandbox execution.
  }
}


function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

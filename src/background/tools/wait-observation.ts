import type { ToolContext } from "../../sdk/background.js";
import { isToolFailure, operationErrorDetails } from "../../shared/contracts/tool-error.js";
import { ToolExecutionError } from "./arguments.js";
import { createToolOperation, createToolTimeoutError, withToolOperationFailure } from "./tool-operation.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";

export interface WaitObservation<T> { result: Promise<T>; dispose(): void }
export interface WaitTrigger { name: string; args?: Record<string, unknown> }
export const waitTriggerParameter = { type: "object", properties: {
  name: { type: "string", minLength: 1 }, args: { type: "object" },
}, required: ["name"] } as const;

/** Arm once, then invoke the action; the action and observation share one deadline. */
export async function runWaitWithTrigger<T>({ tool, timeoutMs, trigger, signal, context, details = {} }: {
  tool: string; timeoutMs: number; trigger?: WaitTrigger; signal?: AbortSignal; context: ToolContext;
  details?: Record<string, unknown>;
}, arm: (signal: AbortSignal) => WaitObservation<T> | Promise<WaitObservation<T>>): Promise<T> {
  const controller = new AbortController();
  const current = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const operation = context.operation ?? createToolOperation();
  if (trigger) operation.prepare({ ...operationErrorDetails({}, trigger.args),
    tabRef: trigger.args?.tabRef as string | number | undefined, tool: trigger.name, pending: tool });
  const deadlineAt = Math.min(context.deadlineAt ?? Infinity, Date.now() + timeoutMs);
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  const language = context.language || getLanguage();
  const timeoutError = () => withLanguage(language, () => createToolTimeoutError(tool, remainingMs, details, operation));
  const stopped = () => typeof current.reason?.code === "string" ? current.reason :
    new ToolExecutionError(current.reason?.name === "TimeoutError" ? "TOOL_TIMEOUT" : "OPERATION_ABORTED", `Stopped waiting for ${tool}.`, details);
  const timer = setTimeout(() => controller.abort(timeoutError()), remainingMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(stopped());
  current.addEventListener("abort", onAbort, { once: true });
  let observation: WaitObservation<T> | undefined, finished = false;
  try {
    if (current.aborted) throw stopped();
    if (Date.now() >= deadlineAt) throw timeoutError();
    const armed = await Promise.race([Promise.resolve(arm(current)).then(value => {
      observation = value;
      if (finished) { void value.result.catch(() => {}); value.dispose(); throw stopped(); }
      return value;
    }), aborted]);
    // Observe rejections immediately while the triggering action is still running.
    const outcome = armed.result.then(value => ({ value }), error => ({ error }));
    if (current.aborted) throw stopped();
    if (trigger) {
      if (!context.invokeTool) throw new ToolExecutionError("TOOL_EXECUTION_FAILED", "Nested tool execution is unavailable.");
      const action = await Promise.race([context.invokeTool(trigger.name, trigger.args || {}, { signal: current, operation }), aborted]);
      if (isToolFailure(action)) throw action;
      // A successful no-op or legacy trigger has completed. An explicitly
      // unconfirmed action remains uncertain even when it returned a value.
      if (operation.snapshot().status === "not_started") operation.confirm();
    }
    const settled = await Promise.race([outcome, aborted]);
    if ("error" in settled) throw settled.error;
    return settled.value;
  } catch (error) {
    throw withToolOperationFailure(error, operation);
  } finally {
    finished = true;
    operation.close();
    clearTimeout(timer);
    current.removeEventListener("abort", onAbort);
    observation?.dispose();
    controller.abort();
  }
}

export function waitDelay(delayMs: number, signal?: AbortSignal, details: Record<string, unknown> = {}) {
  if (signal?.aborted) {
    return Promise.reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting", details));
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ToolExecutionError("OPERATION_ABORTED", "Operation aborted while waiting", details));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}


export function pollState<T>(signal: AbortSignal, read: () => Promise<T | undefined>, intervalMs = 100): WaitObservation<T> {
  return { dispose() {}, result: (async () => {
    for (;;) {
      signal.throwIfAborted();
      const value = await read();
      signal.throwIfAborted();
      if (value !== undefined) return value;
      await waitDelay(intervalMs, signal);
    }
  })() };
}

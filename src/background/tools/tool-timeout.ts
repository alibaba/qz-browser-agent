import { copyCreatedTabResult } from "../../shared/contracts/page-observation.js";
import type { ToolContext } from "../../sdk/background.js";
import { ToolExecutionError } from "./arguments.js";
import { diagnosticTrace, formatTraceFields } from "../trace.js";
import { takeTimeoutTrace } from "./script-timeout-trace.js";
import { operationErrorDetails } from "../../shared/contracts/tool-error.js";
import { createToolTimeoutError, withToolOperationFailure } from "./tool-operation.js";
import { getLanguage, withLanguage } from "../../shared/i18n/index.js";

type Fields = Record<string, unknown>;
export interface ToolPartialResult { result: Fields; pending: string }

/** One deadline owns one partial slot. Late handlers have no authority to update it. */
export async function runToolWithTimeout(
  name: string,
  execute: (signal: AbortSignal, reportPartial: NonNullable<ToolContext["reportPartial"]>, deadlineAt: number) => Promise<unknown>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  fallback: (partial: ToolPartialResult, error: ToolExecutionError) => Promise<unknown>,
  context: ToolContext,
  timeoutTrace?: string,
  operationArgs: Readonly<Fields> = {},
): Promise<unknown> {
  const cancelled = () => new ToolExecutionError("OPERATION_ABORTED", `Operation aborted while running ${name}`, { name });
  if (parentSignal?.aborted) throw cancelled();
  const startedAt = Date.now();
  const language = context.language || getLanguage();
  const deadlineAt = Math.min(context.deadlineAt ?? Infinity,
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : Infinity);
  const remainingMs = Math.max(0, deadlineAt - startedAt);
  const timeoutError = () => withLanguage(language, () => createToolTimeoutError(name, remainingMs,
    { name, ...operationErrorDetails(context, operationArgs), ...(partial ? { pending: partial.pending } : {}) }, context.operation));
  const controller = new AbortController();
  let partial: ToolPartialResult | undefined;
  let settled = false, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const reportPartial: NonNullable<ToolContext["reportPartial"]> = (result, pending) => {
    if (settled || timedOut || controller.signal.aborted) return;
    const pageState = (result.tabRef ?? result.tabId) === (partial?.result.tabRef ?? partial?.result.tabId) ? partial?.result.pageState : undefined;
    partial = { result: copyCreatedTabResult(result, structuredClone({ ...(pageState ? { pageState } : {}), ...result })), pending };
  };
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => {
      context.operation?.close();
      const error = withToolOperationFailure(cancelled(), context.operation);
      reject(error); controller.abort(error);
    };
    parentSignal?.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = new Promise<unknown>((resolve, reject) => {
    if (!Number.isFinite(remainingMs)) return;
    timer = setTimeout(() => {
      void (async () => {
        timedOut = true;
        context.operation?.close();
        const error = timeoutError();
        diagnosticTrace(`${timeoutTrace || "tool_timeout"}${formatTraceFields({ phase: "tool.timeout", name,
          session: context.sessionId, run: context.runId, call: context.toolCallId, timeoutMs })}`);
        // Capture the slot before abort listeners run. Timeout owns settlement from this point.
        const saved = partial;
        controller.abort(error);
        try {
          const trace = await takeTimeoutTrace(controller.signal);
          if (saved && Array.isArray(trace) && trace.length) saved.result = copyCreatedTabResult(saved.result, { ...saved.result, trace: trace.slice(-5) });
        } catch { /* A missing trace still settles the deadline. */ }
        if (saved) resolve(fallback(saved, error));
        else reject(error);
      })();
    }, remainingMs);
  });
  const never = () => new Promise<never>(() => {});
  const execution = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw cancelled();
    if (Date.now() >= deadlineAt) throw timeoutError();
    return execute(controller.signal, reportPartial, deadlineAt);
  }).then(value => timedOut ? never() : value, error => timedOut ? never() : Promise.reject(error));
  try { return await Promise.race([execution, timeout, abort]); }
  catch (error) { context.operation?.close(); throw withToolOperationFailure(error, context.operation); }
  finally {
    settled = true;
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

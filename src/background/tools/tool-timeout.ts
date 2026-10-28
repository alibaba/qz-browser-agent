import type { ToolContext } from "../../sdk/background.js";
import { ToolExecutionError } from "./arguments.js";
import { diagnosticTrace, formatTraceFields } from "../trace.js";

type Fields = Record<string, unknown>;
export interface ToolPartialResult { result: Fields; pending: string }

/** One deadline owns one partial slot. Late handlers have no authority to update it. */
export async function runToolWithTimeout(
  name: string,
  execute: (signal: AbortSignal, reportPartial: NonNullable<ToolContext["reportPartial"]>) => Promise<unknown>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  fallback: (partial: ToolPartialResult, error: ToolExecutionError) => Promise<unknown>,
  context: ToolContext,
  timeoutTrace?: string,
): Promise<unknown> {
  const cancelled = () => new ToolExecutionError("OPERATION_ABORTED", `Operation aborted while running ${name}`, { name });
  if (parentSignal?.aborted) throw cancelled();
  const controller = new AbortController();
  let partial: ToolPartialResult | undefined;
  let settled = false, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const reportPartial: NonNullable<ToolContext["reportPartial"]> = (result, pending) => {
    if (settled || timedOut || controller.signal.aborted) return;
    const pageState = result.tabId === partial?.result.tabId ? partial?.result.pageState : undefined;
    partial = { result: structuredClone({ ...(pageState ? { pageState } : {}), ...result }), pending };
  };
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => { reject(cancelled()); controller.abort(cancelled()); };
    parentSignal?.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = new Promise<unknown>((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      const error = new ToolExecutionError("TOOL_TIMEOUT", `${name} timed out after ${timeoutMs}ms`, { name, timeout: timeoutMs });
      diagnosticTrace(`${timeoutTrace || "tool_timeout"}${formatTraceFields({ phase: "tool.timeout", name,
        session: context.sessionId, run: context.runId, call: context.toolCallId, timeoutMs })}`);
      // Capture the slot before abort listeners run. Timeout owns settlement from this point.
      const saved = partial;
      controller.abort(error);
      if (saved) resolve(fallback(saved, error));
      else reject(error);
    }, timeoutMs);
  });
  const never = () => new Promise<never>(() => {});
  const execution = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw cancelled();
    return execute(controller.signal, reportPartial);
  }).then(value => timedOut ? never() : value, error => timedOut ? never() : Promise.reject(error));
  try { return await Promise.race([execution, timeout, abort]); }
  finally {
    settled = true;
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

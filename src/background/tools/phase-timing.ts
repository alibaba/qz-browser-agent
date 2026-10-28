import type { ToolContext, ToolExecutionPhase } from "../../sdk/background.js";
import { diagnosticTrace, formatTraceFields } from "../trace.js";

const phases: readonly ToolExecutionPhase[] = ["injection", "extraction", "cdp", "measurement", "normalization", "postprocess", "readiness"];

/** Sum phase work per call, including in-flight work at settlement, in one bounded trace row. */
export function createToolPhaseTiming(name: string, context: ToolContext) {
  const totals = new Map(phases.map(phase => [phase, { count: 0, ms: 0 }]));
  const active = new Set<{ phase: ToolExecutionPhase; started: number }>();
  let closed = false;
  const end = (entry: { phase: ToolExecutionPhase; started: number }, now: number) => {
    if (!active.delete(entry)) return;
    totals.get(entry.phase)!.ms += Math.max(0, now - entry.started);
  };
  return {
    start(phase: ToolExecutionPhase) {
      if (closed) return () => {};
      totals.get(phase)!.count++;
      const entry = { phase, started: Date.now() };
      active.add(entry);
      return () => { if (!closed) end(entry, Date.now()); };
    },
    finish() {
      if (closed) return;
      closed = true;
      const now = Date.now();
      for (const entry of active) end(entry, now);
      const fields: Record<string, unknown> = { name, session: context.sessionId, run: context.runId,
        call: context.toolCallId || context.callId || "untracked" };
      for (const [phase, total] of totals) {
        fields[`${phase}Count`] = total.count;
        fields[`${phase}Ms`] = total.ms;
      }
      diagnosticTrace(`tool_phase${formatTraceFields(fields)}`);
    },
  };
}

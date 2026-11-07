import { toolError, type ToolError } from './tool-error.js';
import { getToolResultTraces, traceMessages, type ToolResultPresentation } from './tool-result-presentation.js';

export const SCRIPT_API_VERSION = 2;

/** The script-to-model boundary. Script return values never select execution status. */
export type ScriptReceipt =
  | { ok: true; result: unknown; trace: readonly string[] }
  | { ok: false; result: ToolError; trace: readonly string[] };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Format is host-declared; an authored object's keys cannot turn it into an execution envelope. */
export function scriptReceipt(value: unknown, options: {
  format: 'value' | 'receipt'; isError: boolean; presentation?: ToolResultPresentation;
}): ScriptReceipt {
  const source = record(value), details = record(source.details);
  const captured = getToolResultTraces(value, options.presentation);
  const trace = captured.length ? captured : traceMessages(options.isError ? details.trace
    : options.format === 'receipt' ? source.trace : undefined);
  if (!options.isError) return { ok: true,
    result: (options.format === 'receipt' ? source.result : value) ?? null, trace };
  const { trace: _trace, ...recovery } = details;
  return { ok: false, result: toolError(String(source.code || 'SCRIPT_EVALUATION_FAILED'),
    String(source.message || source.error || value || 'Script failed.'), {
      hint: typeof source.hint === 'string' ? source.hint : undefined, details: recovery,
    }), trace };
}

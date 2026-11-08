import { isToolValue, markToolValue } from './tool-error.js';

/** Host-owned presentation travels beside a tool's business result. */
export interface ToolResultPresentation {
  _pageTitle?: string;
  _pageUrl?: string;
  _pageContext?: Readonly<Record<string, string | number | boolean>>;
  _display?: unknown;
  _plugin?: unknown;
  _images?: readonly { mimeType: string; data: string }[];
}

const presentations = new WeakMap<object, ToolResultPresentation>();

export function getToolResultPresentation(result: unknown): ToolResultPresentation {
  return result && typeof result === "object" ? presentations.get(result) || {} : {};
}

export function bindToolResultPresentation<T>(result: T, presentation: ToolResultPresentation): T {
  if (result && typeof result === "object") {
    presentations.set(result, { ...getToolResultPresentation(result), ...presentation });
  }
  return result;
}

export function copyToolResultPresentation<T>(source: unknown, target: T): T {
  if (isToolValue(source)) markToolValue(target);
  return bindToolResultPresentation(target, getToolResultPresentation(source));
}

/** Retain diagnostics when an execution fails after producing a value. */
export function toolFailurePresentation(error: unknown, collected: ToolResultPresentation = {}): ToolResultPresentation {
  const presentation = { ...collected, ...getToolResultPresentation(error) };
  const display = presentation._display as { script?: { valueOnly?: boolean } } | undefined;
  if (display?.script?.valueOnly !== true) return presentation;
  const { valueOnly, ...script } = display.script;
  return { ...presentation, _display: { ...display, script } };
}

/** Return authored diagnostics and errors in execution order. */
export function traceMessages(rows: unknown): readonly string[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (typeof row === "string") return [row];
    if (!row || typeof row !== "object" || typeof row.message !== "string") return [];
    return [row.message];
  });
}

/** Read only host-owned metadata; authored result fields never become execution traces. */
export function getToolResultTraces(result: unknown, collected: ToolResultPresentation = {}): readonly string[] {
  const display = { ...getToolResultPresentation(result), ...collected }._display as { script?: { trace?: unknown } } | undefined;
  return traceMessages(display?.script?.trace);
}

/** Build a UI event from trusted host metadata without changing the model value. */
export function presentToolResult(result: unknown, collected: ToolResultPresentation = {}): unknown {
  const presentation = { ...getToolResultPresentation(result), ...collected };
  const display = presentation._display as { script?: { valueOnly?: boolean } } | undefined;
  if (display?.script?.valueOnly === true) return { result, ...presentation };
  return Object.keys(presentation).length && result && typeof result === "object" && !Array.isArray(result)
    ? { ...result, ...presentation } : result;
}

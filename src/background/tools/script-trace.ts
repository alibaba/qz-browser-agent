import type { ToolContext } from "../../sdk/background.js";
import type { TraceRow } from "../../shared/contracts/inner-runner.js";
import type { ToolResultPresentation } from "../../shared/contracts/tool-result-presentation.js";

const MAX_ROWS = 80;
const MAX_CHARS = 12000;
const MAX_MESSAGE = 1000;
interface TraceScope {
  parent?: TraceScope;
  rows: TraceRow[];
  omitted: number;
  closed: boolean;
}
const scopes = new WeakMap<ToolResultPresentation, TraceScope>();
const requests = new Map<string, { scope: TraceScope; lastIndex: number }>();
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scopeFor = (context?: ToolContext) => context?.resultPresentation ? scopes.get(context.resultPresentation) : undefined;

/** Context copies retain the host-owned presentation object; child calls get a new one. */
export function inheritScriptTrace(parent: ToolContext | undefined, child: ToolContext): void {
  const scope = scopeFor(parent);
  if (scope && child.resultPresentation) {
    scopes.set(child.resultPresentation, scope);
  }
}

export function beginScriptTrace(context: ToolContext, requestId: string) {
  const presentation = context.resultPresentation ??= {};
  const parent = scopes.get(presentation);
  const scope: TraceScope = { parent, rows: [], omitted: 0, closed: false };
  scopes.set(presentation, scope);
  const display = fields(presentation._display);
  presentation._display = { ...display, script: { ...fields(display.script), trace: scope.rows } };
  requests.set(requestId, { scope, lastIndex: 0 });
  return {
    finish(rows: unknown): TraceRow[] {
      // Final rows also cover transports that buffered their diagnostics until completion.
      if (Array.isArray(rows)) for (const row of rows) acceptScriptTrace(requestId, row);
      return scope.rows.slice();
    },
    close() { scope.closed = true; requests.delete(requestId); },
  };
}

/** Only a registered execution can publish its diagnostics. */
export function acceptScriptTrace(requestId: string, value: unknown): void {
  const request = requests.get(requestId);
  if (!request || request.scope.closed) return;
  const row = fields(value), index = Number(row.traceIndex);
  if (Number.isInteger(index) && index > 0) {
    if (index <= request.lastIndex) return;
    request.lastIndex = index;
  }
  append(request.scope, diagnostic(row));
}

/** Page evaluations use the same trusted presentation channel without an offscreen execution. */
export function collectScriptResultTrace(parent: ToolContext | undefined, child: ToolContext): void {
  const scope = scopeFor(parent);
  if (!scope || scopeFor(child) !== scope) return;
  const rows = fields(fields(child.resultPresentation?._display).script).trace;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    append(scope, diagnostic(fields(row)));
  }
}

function diagnostic(row: Record<string, unknown>): TraceRow {
  return { time: typeof row.time === "string" ? row.time.slice(0, 40) : new Date().toISOString(),
    level: typeof row.level === "string" ? row.level.slice(0, 32) : "trace", message: String(row.message ?? ""),
  };
}

function append(scope: TraceScope, row: TraceRow): void {
  if (scope.closed) return;
  const message = row.message.length > MAX_MESSAGE ? row.message.slice(0, MAX_MESSAGE) + "…[truncated]" : row.message;
  const item = { ...row, message };
  for (let current: TraceScope | undefined = scope; current && !current.closed; current = current.parent) {
    const rows = current.rows;
    if (current.omitted) rows.shift();
    rows.push(item);
    let chars = rows.reduce((sum, entry) => sum + entry.message.length, 0);
    while (rows.length > MAX_ROWS - 1 || chars > MAX_CHARS - 100) {
      chars -= rows.shift()!.message.length;
      current.omitted++;
    }
    if (current.omitted) rows.unshift({ time: item.time, level: "trace", message: `[trace truncated: ${current.omitted} earlier entries omitted]` });
  }
}

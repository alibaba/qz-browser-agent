/** Cumulative usage derived from provider usage recorded on each model call. */

const USD_TICKS = 10_000_000_000;
const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_prompt_tokens",
  "total_completion_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cached_tokens",
  "prompt_cache_hit_tokens",
] as const;
const INCOMPLETE_COMPACT = new Set(["running", "failed", "aborted", "error"]);

interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  screenshots: number;
  contextCompressions: number;
}

interface RecordedCall {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costTicks: number | null;
}

/** Keep the provider fields later snapshots need. Nested cache details become cached_tokens. */
export function normalizeRecordedUsage(input: unknown): Record<string, number> | null {
  const usage = asRecord(input);
  const out: Record<string, number> = {};
  for (const key of TOKEN_KEYS) {
    if (!Object.hasOwn(usage, key)) continue;
    const value = finiteToken(usage[key]);
    if (value != null) out[key] = value;
  }
  if (!Object.hasOwn(out, "cached_tokens")) {
    const cached = cachedFromDetails(usage);
    if (cached != null) out.cached_tokens = cached;
  }
  if (Object.hasOwn(usage, "cost_in_usd_ticks")) {
    const ticks = finiteTicks(usage.cost_in_usd_ticks);
    if (ticks != null) out.cost_in_usd_ticks = ticks;
  }
  if (Object.hasOwn(usage, "cost_usd")) {
    const cost = finiteCost(usage.cost_usd);
    if (cost != null) out.cost_usd = cost;
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeSessionUsage({ conversation = null, transcript = null }: {
  conversation?: unknown;
  transcript?: unknown;
} = {}): SessionUsageSummary {
  const messages = messageRecords(conversation);
  const entries = Array.isArray(transcript) ? transcript.map(asRecord).filter(entry => typeof entry.type === "string") : [];
  const summary: SessionUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    toolCalls: 0,
    screenshots: 0,
    contextCompressions: 0,
  };
  let costTicks = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    const call = readRecordedCall(message._usage);
    if (!call) continue;
    summary.inputTokens += call.inputTokens;
    summary.outputTokens += call.outputTokens;
    summary.cachedTokens += call.cachedTokens;
    summary.modelCalls += 1;
    if (call.costTicks != null) costTicks += call.costTicks;
  }
  summary.costUsd = usdFromTicks(costTicks);

  const transcriptHasTools = entries.some(entry => entry.type === "tool");
  const tools = transcriptHasTools ? entries : toolEntriesFromMessages(messages);
  for (const entry of tools) {
    if (!toolInvoked(entry)) continue;
    summary.toolCalls += 1;
    if (capturedScreenshot(entry)) summary.screenshots += 1;
  }
  summary.contextCompressions = contextCompressions(entries, messages);
  return summary;
}

function readRecordedCall(input: unknown): RecordedCall | null {
  const usage = asRecord(input);
  const cacheRead = firstToken(usage, ["cache_read_input_tokens", "cached_tokens", "prompt_cache_hit_tokens", "cacheRead"]) ?? cachedFromDetails(usage);
  const cacheWrite = firstToken(usage, ["cache_creation_input_tokens", "cacheWrite"]);
  const output = firstToken(usage, ["output_tokens", "completion_tokens", "total_completion_tokens", "output"]);
  const prompt = firstToken(usage, ["prompt_tokens", "total_prompt_tokens"]);
  const inputTokens = firstToken(usage, ["input_tokens", "input"]);
  const split = inputTokens != null && ["cache_read_input_tokens", "cache_creation_input_tokens", "cacheRead", "cacheWrite"]
    .some(key => Object.hasOwn(usage, key));
  let promptTokens = 0;
  const cached = cacheRead ?? 0;
  if (split) {
    promptTokens = inputTokens + (cacheWrite ?? 0);
  } else if (prompt != null) {
    promptTokens = Math.max(0, prompt - cached);
  } else if (inputTokens != null) {
    // Responses-style input_tokens includes cache reads. Anthropic and the Codex
    // adapter's disjoint input/cache fields take the split branch above.
    promptTokens = Math.max(0, inputTokens - cached);
  }
  const costTicks = readCostTicks(usage);
  const recorded = inputTokens != null || prompt != null || output != null || cacheRead != null || cacheWrite != null
    || costTicks != null || firstToken(usage, ["total_tokens", "total"]) != null;
  if (!recorded) return null;
  return { inputTokens: promptTokens, outputTokens: output ?? 0, cachedTokens: cached, costTicks };
}

function readCostTicks(usage: Record<string, unknown>): number | null {
  if (Object.hasOwn(usage, "cost_in_usd_ticks")) return finiteTicks(usage.cost_in_usd_ticks);
  if (Object.hasOwn(usage, "cost_usd")) {
    const cost = finiteCost(usage.cost_usd);
    return cost == null ? null : Math.round(cost * USD_TICKS);
  }
  return null;
}

function usdFromTicks(ticks: number): number {
  const rounded = Math.round(ticks);
  if (!Number.isFinite(rounded)) return 0;
  const whole = Math.trunc(rounded / USD_TICKS);
  const fraction = rounded % USD_TICKS;
  return whole + fraction / USD_TICKS;
}

function contextCompressions(entries: Record<string, unknown>[], messages: Record<string, unknown>[]): number {
  const seen = new Set<string>();
  let count = 0;
  const add = (id: string) => {
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    count += 1;
  };
  for (const entry of entries) {
    if (entry.type === "compact" && compactCompleted(entry.status)) add(compactId(entry));
  }
  const transcriptHasCompact = entries.some(entry => entry.type === "compact");
  for (const message of messages) {
    if (!compactMessageCompleted(message)) continue;
    const id = compactId(asRecord(message._compact));
    if (id) add(id);
    else if (!transcriptHasCompact) add("");
  }
  return count;
}

function toolEntriesFromMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const value of message.tool_calls) {
      const call = asRecord(value);
      const fn = asRecord(call.function);
      const id = typeof call.id === "string" ? call.id : "";
      if (!id) continue;
      calls.set(id, {
        name: typeof fn.name === "string" && fn.name ? fn.name : "tool",
        args: asRecord(parseJson(fn.arguments)),
      });
    }
  }
  const tools: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    const call = calls.get(id) || { name: "tool", args: {} };
    const result = asRecord(parseJson(message.content));
    tools.push({
      type: "tool",
      name: call.name,
      args: call.args,
      isError: Boolean(result.error),
      result,
      phase: "done",
    });
  }
  return tools;
}

function toolInvoked(entry: Record<string, unknown>): boolean {
  if (entry.type !== "tool") return false;
  if (typeof entry.startedExecution === "boolean") return entry.startedExecution;
  // Legacy records lack admission facts. Preserve their historical interpretation;
  // an aborted status alone cannot distinguish queued work from interrupted work.
  if (entry.argsGenerating === true) return false;
  const phase = String(entry.phase || "").toLowerCase();
  const argsState = String(entry.argsState || "").toLowerCase();
  return phase !== "preparing" && phase !== "not_executed"
    && argsState !== "generating" && argsState !== "ready" && argsState !== "not_executed"
    && asRecord(parseJson(entry.result)).code !== "TOOL_NOT_EXECUTED";
}

function capturedScreenshot(entry: Record<string, unknown>): boolean {
  if (entry.isError === true) return false;
  if (entry.isRunning === true || String(entry.phase || "").toLowerCase() === "running") return false;
  const name = String(entry.name || "").toLowerCase();
  if (name.includes("screenshot")) return true;
  return argsRecord(entry).returnScreenshot === true;
}

function argsRecord(entry: Record<string, unknown>): Record<string, unknown> {
  const args = asRecord(parseJson(entry.args));
  if (Object.keys(args).length) return args;
  return asRecord(parseJson(entry.argsText));
}

function compactCompleted(status: unknown): boolean {
  return !INCOMPLETE_COMPACT.has(String(status || "done").trim().toLowerCase());
}

function compactMessageCompleted(message: Record<string, unknown>): boolean {
  const compact = asRecord(message._compact);
  const marked = message._kind === "compaction" || message._origin === "compaction" || Object.keys(compact).length > 0;
  return marked && compactCompleted(compact.status);
}

function compactId(value: Record<string, unknown>): string {
  const id = value.compactId || value.id;
  return typeof id === "string" ? id.trim() : "";
}

function messageRecords(conversation: unknown): Record<string, unknown>[] {
  const container = asRecord(conversation);
  const source = Array.isArray(conversation)
    ? conversation
    : Array.isArray(container.entries) ? container.entries
      : Array.isArray(container.messages) ? container.messages
        : [];
  const messages: Record<string, unknown>[] = [];
  for (const item of source) {
    const entry = asRecord(item);
    const message = asRecord(Object.hasOwn(entry, "message") ? entry.message : item);
    if (typeof message.role === "string") messages.push(message);
  }
  return messages;
}

function firstToken(usage: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (!Object.hasOwn(usage, key)) continue;
    return finiteToken(usage[key]);
  }
  return null;
}

function cachedFromDetails(usage: Record<string, unknown>): number | null {
  for (const key of ["prompt_tokens_details", "input_tokens_details"]) {
    const details = asRecord(usage[key]);
    if (!Object.hasOwn(details, "cached_tokens")) continue;
    return finiteToken(details.cached_tokens);
  }
  return null;
}

function finiteToken(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.ceil(number);
}

function finiteTicks(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function finiteCost(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

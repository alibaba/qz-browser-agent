import type { ToolTimeout, ToolTimeoutProfile } from "../../shared/contracts/tool.js";
import { ToolExecutionError } from "./arguments.js";

export const DEFAULT_TOOL_TIMEOUT: ToolTimeoutProfile = { defaultMs: 15_000, maxMs: 30 * 60_000 };
export function positiveSeconds(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number * 1000)) : null;
}

export const DOCUMENT_HOST_TIMEOUT_MS = 120_000;

/** All current script entry points share the same default; parents retain their own deadline. */
export function orchestrationTimeout(args: Record<string, unknown>, name: string): number {
  return scriptTimeout({ ...args, timeout: args.timeout ?? 120 }, name);
}

export function documentHostTimeout(args: Record<string, unknown>, name: string): number {
  if (args.timeout == null || args.timeout === "") return DOCUMENT_HOST_TIMEOUT_MS;
  return scriptTimeout(args, name);
}

export function scriptTimeout(args: Record<string, unknown>, name: string): number {
  const seconds = Number(args.timeout);
  if (!Number.isFinite(seconds)) throw new ToolExecutionError("INVALID_TIMEOUT", `${name} timeout must be a number of seconds`, {
    name, unit: "seconds", value: args.timeout,
  });
  return seconds <= 0 ? 0 : Math.max(1, Math.floor(seconds * 1000));
}

export function sessionWaitTimeout(args: Record<string, unknown>): ToolTimeout {
  if (args.action !== "wait") return DEFAULT_TOOL_TIMEOUT;
  const timeout = positiveSeconds(args.timeout) ?? (positiveSeconds(args.timeoutMs) === null ? null : Math.floor(Number(args.timeoutMs)));
  return timeout === null ? 0 : Math.max(1000, Math.min(timeout, 2 * 60 * 60_000) + 5000);
}

export function pageWaitTimeout(args: Record<string, unknown>): ToolTimeoutProfile {
  return { defaultMs: (positiveSeconds(args.timeout) ?? 10_000) + 2000, maxMs: 10 * 60_000, graceMs: 2000 };
}

export function delayTimeout(args: Record<string, unknown>): ToolTimeoutProfile {
  const value = args.seconds != null ? positiveSeconds(args.seconds) : Number(args.ms) > 0 ? Math.floor(Number(args.ms)) : null;
  return { defaultMs: Math.min((value ?? 1000) + 1000, 10 * 60_000), maxMs: 10 * 60_000 };
}

export function resolveTimeout(policy: ToolTimeout, args: Record<string, unknown>): number {
  if (typeof policy === "number") return policy;
  const explicit = positiveSeconds(args.timeout);
  const timeout = explicit === null ? policy.defaultMs : explicit + (policy.graceMs ?? 0);
  return Math.max(1000, Math.min(policy.maxMs, timeout));
}

/** Public context contracts; collection, budgets and cancellation are enforced by the host. */
import type { TabReference } from "../../shared/tab-utils.js";
import type { getSecurityGuardrails } from "../../shared/security-guardrails.js";

export type ContextReason = "snapshot" | "site-skills" | "tool";
export interface ContextRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly epoch?: number;
  readonly reason: ContextReason;
  readonly signal?: AbortSignal;
}
export interface ContextSource {
  readonly id: string;
  readonly required?: boolean;
  readonly reasons?: readonly ContextReason[];
  readonly timeoutMs?: number;
  readonly maxChars?: number;
  /** A title makes the result a bounded text capsule; other results remain private to the host. */
  readonly title?: string;
  read(request: ContextRequest): unknown | Promise<unknown>;
}
/** Read-only Session ports; capability factories never receive repositories or command objects. */
export interface ContextCapabilityHost {
  getSessionRuntime(sessionId: string): Readonly<{ visitedTaskSites?: unknown; tracker?: unknown; goal?: unknown }> | null;
  canUseSessionGoal(sessionId: string): Promise<boolean>;
  getWorkingTabContext(sessionId: string): Promise<TabReference | null>;
  readonly getSecurityGuardrails: typeof getSecurityGuardrails;
}
export type ContextCapability = (host: ContextCapabilityHost) => readonly ContextSource[];

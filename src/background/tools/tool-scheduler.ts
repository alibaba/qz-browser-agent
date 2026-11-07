export interface ToolDependencies<T> { execution: readonly T[]; commit: readonly T[] }
import type { ToolBatchTabPolicy } from "../../shared/contracts/tool.js";
const MAX_IN_FLIGHT = 10;

type Lane = string | number | object | null;
interface ExecutionScope {
  gate: ExecutionGate; parent?: ExecutionScope; lane: Lane;
  independent: boolean; observer: boolean; orchestration: boolean; container: boolean;
}
const executionScopes = new WeakMap<object, ExecutionScope>();
const ancestorScope = (a: ExecutionScope, b: ExecutionScope) => {
  for (let parent = b.parent; parent; parent = parent.parent) if (parent === a) return true;
  return false;
};

/** Finite batches and dynamic descendants share physical page lanes and one budget. */
class ExecutionGate {
  active = new Set<ExecutionScope>();
  listeners = new Set<() => void>();
  committing = false;
  constructor(readonly limit: number) {}
  wake() { for (const listener of this.listeners) listener(); }
  ready(scope: ExecutionScope) {
    if (scope.observer) return true;
    const active = [...this.active].filter(other => !other.observer);
    // Containers yield capacity; page access and barriers last until execution ends.
    return active.filter(other => !other.container).length < this.limit
      && !active.some(other => !other.orchestration && !ancestorScope(other, scope) && !ancestorScope(scope, other)
      && (!scope.independent || !other.independent || scope.lane !== null && scope.lane === other.lane));
  }
}

function executionScope(gate: ExecutionGate, lane: Lane, independent: boolean, observer: boolean,
  { parent, orchestration = false }: { parent?: object; orchestration?: boolean } = {}) {
  const authority = parent && executionScopes.get(parent);
  const scope = Object.freeze({});
  executionScopes.set(scope, { gate: authority?.gate || gate, parent: authority, lane, independent, observer, orchestration, container: false });
  return scope;
}

function releaseExecution(scope: object) {
  const state = executionScopes.get(scope)!;
  state.gate.active.delete(state);
  state.gate.wake();
}

/** Trusted declarations grant concurrency; an explicit page is still required. */
export function independentToolPolicy(policy: ToolBatchTabPolicy | null | undefined, explicit = true): boolean {
  return policy?.kind === "script" || policy?.kind === "observe" || (policy?.kind === "create" ? policy.parallel === true && (!policy.targeted || explicit)
    : policy?.kind === "target" && (policy.observation || policy.parallel === true) && explicit);
}

/** Ordered wait wrappers keep their dependencies, while descendants acquire execution locks. */
export function isToolOrchestration(policy: ToolBatchTabPolicy | null | undefined): boolean {
  return policy?.kind === "script" || (policy?.kind === "target" || policy?.kind === "create") && policy.orchestration === true;
}

interface Invocation<R> {
  scope: object; group: object | string;
  lane: string | number | null; independent: boolean; observer: boolean; creation: boolean;
  resolveLane(): string | number | null;
  state: "queued" | "running" | "done" | "committing" | "settled";
  previous: Invocation<unknown>[]; error?: unknown; value?: R;
  produces?: string; producer?: Invocation<unknown>; failed: boolean;
  dependencyFailure?(): unknown; isError?(value: R): boolean;
  signal?: AbortSignal; execute(scope: object): Promise<R>; commit?(value: R): Promise<R>;
  resolve(value: R): void; reject(error: unknown): void; cleanup(): void;
}

/**
 * Dynamic descendants use the batch scheduler's trusted roles, lanes and ten-call
 * budget. A parent waiting for descendants becomes a container, rather than
 * holding a slot or waiting behind its own barrier. Ready results commit one at
 * a time, respecting conflicts without waiting for unrelated executions.
 */
export function createNestedToolScheduler(maxInFlight = MAX_IN_FLIGHT) {
  const limit = Math.max(1, Math.min(MAX_IN_FLIGHT, Math.floor(maxInFlight || MAX_IN_FLIGHT)));
  const gate = new ExecutionGate(limit);
  const calls: Invocation<unknown>[] = [];
  const gates = new Map<ExecutionGate, number>();
  let pumping = false;
  const conflict = (a: Invocation<unknown>, b: Invocation<unknown>) =>
    !a.observer && !b.observer && (!a.independent || !b.independent || a.lane !== null && a.lane === b.lane);
  const settled = (call: Invocation<unknown>) => call.state === "settled";
  const executed = (call: Invocation<unknown>) => ["done", "committing", "settled"].includes(call.state);
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      for (const call of calls) {
        if (call.state === "queued") {
          call.lane = call.resolveLane();
          executionScopes.get(call.scope)!.lane = call.lane;
        }
        if (call.state === "queued" && call.signal?.aborted) {
          call.failed = true;
          call.error = call.signal.reason || Object.assign(new Error("Tool call cancelled"), { code: "OPERATION_ABORTED" });
          call.state = "done";
        }
      }
      for (const call of calls) {
        const sharedGate = executionScopes.get(call.scope)!.gate;
        if (call.state !== "done" || sharedGate.committing || call.previous.some(previous =>
          !previous.observer && (!previous.independent || !call.independent || conflict(previous, call)) && !settled(previous))) continue;
        sharedGate.committing = true;
        call.state = "committing";
        void (async () => {
          try {
            if (call.failed) throw call.error;
            if (call.signal?.aborted) throw call.signal.reason || Object.assign(new Error("Tool call cancelled"), { code: "OPERATION_ABORTED" });
            const value = call.commit ? await call.commit(call.value) : call.value;
            call.failed = call.isError?.(value) === true;
            call.resolve(value);
          } catch (error) { call.failed = true; call.reject(error); }
          finally {
            call.state = "settled"; call.cleanup();
            sharedGate.committing = false; sharedGate.wake(); pump();
          }
        })();
      }
      for (const call of calls) {
        if (call.state !== "queued" || call.signal?.aborted) continue;
        if (call.producer && !settled(call.producer)) continue;
        if (call.previous.some(previous => {
          if (previous.observer) return false;
          // Barriers wait for publication; existing page lanes need only the
          // preceding execution. A new alias cannot be used before ownership commits.
          if (!previous.independent || !call.independent) return !settled(previous);
          if (!conflict(previous, call)) return false;
          return previous.creation ? !settled(previous) : !executed(previous);
        })) continue;
        const execution = executionScopes.get(call.scope)!;
        if (!execution.gate.ready(execution)) continue;
        execution.gate.active.add(execution);
        call.state = "running";
        void Promise.resolve().then(() => {
          if (call.producer?.failed) throw call.dependencyFailure?.() || new Error("Tool dependency failed");
          return call.execute(call.scope);
        }).then(value => { call.value = value; }, error => { call.failed = true; call.error = error; })
          .finally(() => { call.state = "done"; releaseExecution(call.scope); pump(); });
      }
      // Settled calls are no longer needed for ordering; active descendants retain
      // their parent through the opaque scope, without retaining a run-long log.
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.state === "settled") calls.splice(i, 1);
    } finally { pumping = false; }
  };
  return {
    run<R>(options: {
      parent?: object; group: object | string; lane: string | number | null | (() => string | number | null);
      policy: ToolBatchTabPolicy | null | undefined; explicit?: boolean; signal?: AbortSignal;
      produces?: string; targetAlias?: string; dependencyFailure?(): unknown; isError?(value: R): boolean;
      execute(scope: object): Promise<R>; commit?(value: R): Promise<R>;
    }): Promise<R> {
      const parent = options.parent && executionScopes.get(options.parent);
      if (parent) parent.container = true;
      const group = options.parent || options.group;
      const previous = calls.filter(call => call.group === group);
      const independent = independentToolPolicy(options.policy, options.explicit);
      const observer = options.policy?.kind === "observe" || options.policy?.kind === "create" && options.policy.passive === true;
      const requestedLane = options.lane;
      const resolveLane = typeof requestedLane === "function" ? requestedLane : () => requestedLane;
      const lane = resolveLane();
      const scope = executionScope(gate, lane, independent, observer, { parent: options.parent, orchestration: isToolOrchestration(options.policy) });
      const sharedGate = executionScopes.get(scope)!.gate;
      if (!gates.has(sharedGate)) sharedGate.listeners.add(pump);
      gates.set(sharedGate, (gates.get(sharedGate) || 0) + 1);
      return new Promise<R>((resolve, reject) => {
        const call: Invocation<R> = {
          scope, group, previous, lane, resolveLane, independent, observer,
          creation: options.policy?.kind === "create",
          state: "queued", signal: options.signal,
          produces: options.produces, producer: options.targetAlias ? [...calls].reverse().find(call => call.produces === options.targetAlias) : undefined,
          failed: false, dependencyFailure: options.dependencyFailure, isError: options.isError,
          execute: options.execute, commit: options.commit, resolve, reject,
          cleanup: () => {
            options.signal?.removeEventListener("abort", pump);
            const remaining = gates.get(sharedGate)! - 1;
            if (remaining) gates.set(sharedGate, remaining);
            else { gates.delete(sharedGate); sharedGate.listeners.delete(pump); }
          },
        };
        calls.push(call as Invocation<unknown>);
        options.signal?.addEventListener("abort", pump, { once: true });
        pump();
        if (parent) parent.gate.wake();
      });
    },
    get pending() { return calls.length; },
  };
}

/** Execute ready data-flow nodes immediately; one independent cursor commits the original order. */
export async function scheduleToolCalls<T, R>(items: readonly T[], options: {
  tab(item: T): number | null;
  lane?(item: T): Lane;
  observer?(item: T): boolean;
  orchestration?(item: T): boolean;
  dependencies?(item: T): ToolDependencies<T>;
  independent?(item: T): boolean;
  execute(item: T, signal: AbortSignal, parallel: boolean, scope: object): Promise<R>;
  completed?(item: T, result: R): void;
  cancelled?(item: T): R;
  commit(result: R): Promise<void>;
  reject?(item: T, error: unknown): R;
  signal: AbortSignal;
  /** Hosts may lower the execution budget; ten remains the hard upper bound. */
  maxInFlight?: number;
}) {
  const limit = Math.max(1, Math.min(MAX_IN_FLIGHT, Math.floor(options.maxInFlight || MAX_IN_FLIGHT)));
  const gate = new ExecutionGate(limit);
  const nodes = items.map(item => {
    const parallel = options.independent?.(item) ?? options.tab(item) !== null;
    // A caller supplying its own graph without policy metadata retains that
    // graph's concurrency; Agent and drive pass their trusted independent role.
    const independent = options.independent ? parallel : options.dependencies ? true : parallel;
    return { item, parallel, scope: executionScope(gate, options.lane?.(item) ?? options.tab(item), independent, options.observer?.(item) === true,
      { orchestration: options.orchestration?.(item) === true }),
      state: "queued" as "queued" | "running" | "done" | "committed" | "skipped", result: undefined as R | undefined, failed: false };
  });
  const byItem = new Map(nodes.map(node => [node.item, node]));
  const lanes = new Map<number, T>();
  let barrier: T | undefined;
  const edges = new Map<T, ToolDependencies<T>>();
  for (const [index, item] of items.entries()) {
    const tab = options.tab(item);
    edges.set(item, options.dependencies?.(item) || {
      execution: tab !== null && lanes.has(tab) ? [lanes.get(tab)!] : [],
      commit: tab === null ? items.slice(0, index) : barrier === undefined ? [] : [barrier],
    });
    if (tab === null) barrier = item; else lanes.set(tab, item);
  }
  let active = 0, cursor = 0, committing = false;
  let wake = () => {};
  const errors: unknown[] = [];
  const abort = () => wake();
  const gateWake = () => wake();
  gate.listeners.add(gateWake);
  options.signal.addEventListener("abort", abort);
  const done = (item: T) => ["done", "committed"].includes(byItem.get(item)!.state);
  const committed = (item: T) => byItem.get(item)!.state === "committed";
  const launch = (node: typeof nodes[number]) => {
    gate.active.add(executionScopes.get(node.scope)!);
    active++; node.state = "running";
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    void (async () => {
      try {
        try { node.result = await options.execute(node.item, controller.signal, node.parallel, node.scope); }
        catch (error) {
          if (!options.reject) throw error;
          node.result = options.reject(node.item, error);
        }
        options.completed?.(node.item, node.result);
      } catch (error) { node.failed = true; errors.push(error); }
      finally {
        options.signal.removeEventListener("abort", cancel);
        active--; node.state = "done"; releaseExecution(node.scope); wake();
      }
    })();
  };
  const drain = async () => {
    committing = true;
    try {
      while (cursor < nodes.length && !gate.committing) {
        const node = nodes[cursor]!;
        if (node.state === "skipped") { cursor++; continue; }
        if (node.state !== "done") break;
        gate.committing = true;
        try { if (!node.failed) await options.commit(node.result!); }
        catch (error) { errors.push(error); }
        finally { node.state = "committed"; cursor++; gate.committing = false; gate.wake(); wake(); }
      }
    } finally { committing = false; wake(); }
  };
  try {
    while (cursor < nodes.length) {
      const changed = new Promise<void>(resolve => { wake = resolve; });
      if (options.signal.aborted) for (const node of nodes) if (node.state === "queued") {
        if (options.cancelled) {
          node.result = options.cancelled(node.item); node.state = "done";
          options.completed?.(node.item, node.result);
        } else node.state = "skipped";
      }
      for (const node of nodes) {
        if (options.signal.aborted) break;
        const deps = edges.get(node.item)!;
        // A provisional creator's private identity becomes available after its
        // execution; resource ownership must use that actual page across entries.
        const scope = executionScopes.get(node.scope)!;
        scope.lane = options.lane?.(node.item) ?? options.tab(node.item);
        if (node.state === "queued" && deps.execution.every(done) && deps.commit.every(committed)
          && gate.ready(scope)) launch(node);
      }
      if (!committing && !gate.committing && ["done", "skipped"].includes(nodes[cursor]?.state || "")) void drain();
      if (cursor === nodes.length) break;
      if (!active && !committing && !gate.committing && !gate.active.size && nodes[cursor]?.state === "queued") throw new Error("Unresolvable tool dependency cycle");
      await changed;
    }
    if (errors.length) throw errors[0];
  } finally { options.signal.removeEventListener("abort", abort); gate.listeners.delete(gateWake); }
}

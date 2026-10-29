export interface ToolDependencies<T> { execution: readonly T[]; commit: readonly T[] }
const MAX_IN_FLIGHT = 10;

/** Execute ready data-flow nodes immediately; one independent cursor commits the original order. */
export async function scheduleToolCalls<T, R>(items: readonly T[], options: {
  tab(item: T): number | null;
  dependencies?(item: T): ToolDependencies<T>;
  independent?(item: T): boolean;
  execute(item: T, signal: AbortSignal, parallel: boolean): Promise<R>;
  completed?(item: T, result: R): void;
  cancelled?(item: T): R;
  commit(result: R): Promise<void>;
  reject?(item: T, error: unknown): R;
  signal: AbortSignal;
  /** Hosts may lower the execution budget; ten remains the hard upper bound. */
  maxInFlight?: number;
}) {
  const limit = Math.max(1, Math.min(MAX_IN_FLIGHT, Math.floor(options.maxInFlight || MAX_IN_FLIGHT)));
  const nodes = items.map(item => ({ item, state: "queued" as "queued" | "running" | "done" | "committed" | "skipped", result: undefined as R | undefined, failed: false }));
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
  options.signal.addEventListener("abort", abort);
  const done = (item: T) => ["done", "committed"].includes(byItem.get(item)!.state);
  const committed = (item: T) => byItem.get(item)!.state === "committed";
  const launch = (node: typeof nodes[number]) => {
    active++; node.state = "running";
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    void (async () => {
      try {
        try { node.result = await options.execute(node.item, controller.signal, options.independent?.(node.item) ?? options.tab(node.item) !== null); }
        catch (error) {
          if (!options.reject) throw error;
          node.result = options.reject(node.item, error);
        }
        options.completed?.(node.item, node.result);
      } catch (error) { node.failed = true; errors.push(error); }
      finally {
        options.signal.removeEventListener("abort", cancel);
        active--; node.state = "done"; wake();
      }
    })();
  };
  const drain = async () => {
    committing = true;
    try {
      while (cursor < nodes.length) {
        const node = nodes[cursor]!;
        if (node.state === "skipped") { cursor++; continue; }
        if (node.state !== "done") break;
        try { if (!node.failed) await options.commit(node.result!); }
        catch (error) { errors.push(error); }
        node.state = "committed"; cursor++; wake();
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
        if (options.signal.aborted || active >= limit) break;
        const deps = edges.get(node.item)!;
        if (node.state === "queued" && deps.execution.every(done) && deps.commit.every(committed)) launch(node);
      }
      if (!committing && ["done", "skipped"].includes(nodes[cursor]?.state || "")) void drain();
      if (cursor === nodes.length) break;
      if (!active && !committing && nodes[cursor]?.state === "queued") throw new Error("Unresolvable tool dependency cycle");
      await changed;
    }
    if (errors.length) throw errors[0];
  } finally { options.signal.removeEventListener("abort", abort); }
}

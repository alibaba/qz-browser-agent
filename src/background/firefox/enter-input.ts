import type { DebuggerCommandScope } from "../tools/cdp-runtime.js";
import { pageInputDelivered } from "../tools/page-input-delivery.js";

interface Press {
  tabId: number;
  frameId: number;
  generations: ReadonlyMap<string, number>;
  dispatched: boolean;
  signal?: AbortSignal;
  dispose(): void;
}

/** An Enter may replace its document before Firefox acknowledges input or accepts keyUp. */
export function createFirefoxEnterInput(generations: ReadonlyMap<string, number>) {
  const presses = new Map<string, Press>();
  const commits = new Set<() => void>();
  const changed = (press: Press) => [0, press.frameId].some(frameId => {
    const key = `${press.tabId}:${frameId}`;
    return (generations.get(key) || 0) !== (press.generations.get(key) || 0);
  });

  async function send(tabId: number, frameId: number, releasing: boolean,
    prepare: () => Promise<number>, dispatch: (frameId: number) => Promise<unknown>, scope: DebuggerCommandScope) {
    check(scope);
    const key = `${tabId}:${frameId}`;
    let press = presses.get(key);
    if (releasing) {
      // Consume the release before any await: keyboard cleanup must not replay it.
      if (!press || press.signal !== scope.signal) return {};
      press.dispose();
    } else {
      press?.dispose();
      const next: Press = {
        tabId, frameId, generations: new Map(generations), dispatched: false, signal: scope.signal,
        dispose() {
          scope.signal?.removeEventListener("abort", next.dispose);
          if (presses.get(key) === next) presses.delete(key);
        },
      };
      presses.set(key, next);
      scope.signal?.addEventListener("abort", next.dispose, { once: true });
      press = next;
    }
    try {
      if (releasing && changed(press)) return {};
      const target = await observe(prepare(), scope);
      if (!releasing) press.frameId = target;
      if (changed(press)) {
        if (releasing) return {};
        throw new Error("Cannot find context");
      }
      // Never retry input, including a keyDown whose reply is lost after submit.
      check(scope);
      press.dispatched = true;
      return await observe(dispatch(target), scope);
    } catch (error) {
      press.dispose();
      check(scope);
      if (!press.dispatched) throw error;
      await waitForCommit(press, scope, error);
      return {};
    }
  }

  async function waitForCommit(press: Press, scope: DebuggerCommandScope, error: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = () => {};
    try {
      await observe(new Promise<void>((resolve, reject) => {
        committed = () => {
          if (pageInputDelivered({ committed: changed(press) })) resolve();
        };
        commits.add(committed);
        timer = setTimeout(() => reject(error), 1000);
        committed();
      }), scope);
    } finally {
      clearTimeout(timer);
      commits.delete(committed);
    }
  }

  return {
    send,
    committed() { for (const notify of commits) notify(); },
    release(tabId: number) {
      for (const press of presses.values()) if (press.tabId === tabId) press.dispose();
    },
  };
}

function check(scope: DebuggerCommandScope) {
  scope.check();
  scope.signal?.throwIfAborted();
}

/** A late browser reply cannot continue a cancelled or superseded command. */
function observe<T>(operation: Promise<T>, scope: DebuggerCommandScope): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => scope.signal?.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); try { check(scope); } catch (error) { reject(error); } };
    scope.signal?.addEventListener("abort", aborted, { once: true });
    operation.then(value => {
      cleanup();
      try { check(scope); resolve(value); } catch (error) { reject(error); }
    }, error => {
      cleanup();
      try { check(scope); reject(error); } catch (error) { reject(error); }
    });
    if (scope.signal?.aborted) aborted();
  });
}

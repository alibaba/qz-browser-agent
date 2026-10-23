export interface IsolatedContext {
  id: number;
  uniqueId: string;
}

/** Isolated extension worlds reported for one tab while its debugger connection is alive. */
export const isolatedByTab = new Map<number, Map<string, Map<string, IsolatedContext>>>();

/** Drop every isolated context recorded for a tab. Connection teardown owns this. */
export function forgetIsolatedContexts(tabId: number) {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  isolatedByTab.delete(tabId);
}

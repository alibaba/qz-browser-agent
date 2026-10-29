/** Self-contained for executeScript serialization; only access document globals inside the function. */
export function documentReadiness(mode?: "probe"): boolean;
export function documentReadiness(mode: "wait"): true | Promise<true>;
export function documentReadiness(mode: "probe" | "wait" = "probe"): boolean | Promise<true> {
  const doc = (globalThis as unknown as { document: {
    readyState: string; addEventListener(type: string, listener: () => void, options: { once: boolean }): void;
  } }).document;
  if (doc.readyState === "complete") return true;
  const navigation = performance.getEntriesByType("navigation")[0] as { domContentLoadedEventStart?: number } | undefined;
  const ready = doc.readyState === "interactive" && (!navigation || Number(navigation.domContentLoadedEventStart) > 0);
  if (ready || mode === "probe") return ready;
  // Parsing/deferred scripts finish here, independently of images, child frames and network idle.
  // The listener only resolves readiness; cancelled callers never resume extraction or capture.
  return new Promise<true>(resolve => doc.addEventListener("DOMContentLoaded", () => resolve(true), { once: true }));
}

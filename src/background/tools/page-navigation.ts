import type { ToolContext } from "../../sdk/background.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";
import { ToolExecutionError } from "./arguments.js";

/** Navigation evidence is owned by the execution host, shared by page capabilities. */
export interface PageState { url: string; title: string }
export interface PreparedNavigation { url: string; rateLimitMatch?: unknown; rateLimit?: unknown }

/** Observe one action; never dispatch or replay it. Document IDs also distinguish same-URL reloads. */
export async function beginPageNavigationObservation(tabId: number, signal?: AbortSignal,
  { settleMs = 180, timeoutMs = 10_000, probeMs = 100 } = {}) {
  let disposed = false, started = false;
  const check = () => {
    if (disposed || signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Page navigation observation cancelled", { tabId });
  };
  const wait = <T>(operation: Promise<T>, ms: number): Promise<T | null> => {
    check();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); reject(new ToolExecutionError("OPERATION_ABORTED", "Page navigation observation cancelled", { tabId })); };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  };
  const documentId = async (ms = probeMs) => {
    check();
    try {
      // This constant probe reads no page content. Chrome supplies the document identity.
      const frames = await wait(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
        injectImmediately: true, func: () => null }), ms);
      return frames?.[0]?.documentId || null;
    } catch { check(); return null; }
  };
  const [baseline, previousId] = await Promise.all([
    wait(chrome.tabs.get(tabId), probeMs), documentId(),
  ]);
  check();
  const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id === tabId && (change.status === "loading" || change.url)) started = true;
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  const dispose = () => {
    disposed = true;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  return {
    dispose,
    async finish(pageBefore: PageState) {
      const dispatchPage = baseline ? { url: baseline.url || "", title: baseline.title || "" } : pageBefore;
      try {
        // A prevented/default-free click stays fast. An in-flight navigation gets its own bounded wait.
        await wait(new Promise<never>(() => {}), settleMs);
        const deadline = Date.now() + timeoutMs;
        let tab: chrome.tabs.Tab | null = null;
        let documentChanged: boolean | null = null;
        for (;;) {
          check();
          const currentId = await documentId(Math.min(probeMs, Math.max(0, deadline - Date.now())));
          tab = await wait(chrome.tabs.get(tabId), Math.max(0, deadline - Date.now()));
          documentChanged = documentChanged === true ? true : previousId && currentId ? previousId !== currentId : null;
          const loading = tab?.status === "loading" || Boolean(tab?.pendingUrl);
          const baselineLoading = !baseline || baseline.status === "loading" || Boolean(baseline.pendingUrl);
          const committed = documentChanged === true || Boolean(tab?.url && tab.url !== dispatchPage.url);
          started ||= committed || Boolean(baseline && tab && (
            (!baselineLoading && loading) || (tab.pendingUrl && tab.pendingUrl !== baseline.pendingUrl)));
          // A request alone is not evidence of navigation. Downloads, 204 responses,
          // and cancelled navigations can finish without replacing the document.
          const pending = !tab || (started && loading);
          if (!pending || Date.now() >= deadline) {
            return {
              pageBefore: dispatchPage,
              pageAfter: tab ? { url: tab.url || "", title: tab.title || "" } : dispatchPage,
              navigationPending: pending,
              documentChanged,
              navigationStarted: started ? true : baselineLoading && loading ? null : false,
            };
          }
          await wait(new Promise<never>(() => {}), Math.min(50, Math.max(0, deadline - Date.now())));
        }
      } finally { dispose(); }
    },
  };
}
export interface PageNavigationHost {
  getTabPageState(tabId: number): Promise<PageState>;
  pageStateDelta(before: PageState, after: PageState): { pageBefore: PageState; pageAfter: PageState; urlChanged: boolean; titleChanged: boolean };
  prepareKnownPageNavigation(input: { url: string; pageBefore: PageState; guardrails: SecurityGuardrails; context: ToolContext;
    signal?: AbortSignal; toolName: string; toolArgs: Record<string, unknown>; tabId: number; source: string }): Promise<PreparedNavigation | null>;
  commitObservedPageNavigation(input: { pageBefore: PageState; pageAfter: PageState; prepared: PreparedNavigation | null;
    guardrails: SecurityGuardrails; toolName: string; tabId: number }): object | null;
}

import type { ToolContext } from "../../sdk/background.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";
import { ToolExecutionError } from "./arguments.js";
import { pollState, type WaitObservation } from "./wait-observation.js";

/** Navigation evidence is owned by the execution host, shared by page capabilities. */
export interface PageState { url: string; title: string }
export interface PreparedNavigation { url: string; rateLimitMatch?: unknown; rateLimit?: unknown }

interface MainNavigationEvent { tabId: number; frameId: number; url: string; timeStamp?: number; documentId?: string; error?: string }
interface NavigationSnapshot {
  tab: chrome.tabs.Tab;
  frame: chrome.webNavigation.GetFrameResultDetails | null;
  started: boolean;
  committed?: MainNavigationEvent;
  failed?: MainNavigationEvent;
}

/** Browser events identify the navigation; a stable frame snapshot confirms its current outcome. */
function observeNavigationEvidence(tabId: number) {
  let version = 0, started = false, closed = false, latestTime = -Infinity;
  let committed: MainNavigationEvent | undefined, failed: MainNavigationEvent | undefined;
  const accept = (event: MainNavigationEvent) => {
    if (event.tabId !== tabId || event.frameId !== 0 || (event.timeStamp != null && event.timeStamp < latestTime)) return false;
    if (event.timeStamp != null) latestTime = event.timeStamp;
    version++;
    return true;
  };
  const before = (event: MainNavigationEvent) => {
    if (!accept(event)) return;
    started = true; committed = failed = undefined;
  };
  const commit = (event: MainNavigationEvent) => {
    if (!accept(event)) return;
    committed = event; failed = undefined;
  };
  const error = (event: MainNavigationEvent) => { if (accept(event)) failed = event; };
  const updated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId) return;
    if (change.status || change.url) version++;
    if (change.status === "loading" || change.url) started = true;
  };
  const removed = (id: number) => { if (id === tabId) { closed = true; version++; } };
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved?.addListener(removed);
  const events = [
    [chrome.webNavigation.onBeforeNavigate, before],
    [chrome.webNavigation.onCommitted, commit],
    [chrome.webNavigation.onHistoryStateUpdated, commit],
    [chrome.webNavigation.onReferenceFragmentUpdated, commit],
    [chrome.webNavigation.onErrorOccurred, error],
  ] as const;
  for (const [event, listener] of events) event.addListener(listener);
  return {
    reset() { started = false; committed = failed = undefined; },
    async read(): Promise<NavigationSnapshot | null> {
      if (closed) throw new ToolExecutionError("TAB_CLOSED", "The page closed while waiting for navigation.");
      const observedVersion = version;
      const [tab, frame] = await Promise.all([
        chrome.tabs.get(tabId), chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
      ]);
      if (closed) throw new ToolExecutionError("TAB_CLOSED", "The page closed while waiting for navigation.");
      return observedVersion === version ? { tab, frame, started, committed, failed } : null;
    },
    dispose() {
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved?.removeListener(removed);
      for (const [event, listener] of events) event.removeListener(listener);
    },
  };
}

function committedNavigation(snapshot: NavigationSnapshot) {
  const { tab, frame, committed } = snapshot;
  return Boolean(committed && frame && !frame.errorOccurred && !tab.pendingUrl
    && (!committed.documentId || committed.documentId === frame.documentId)
    && committed.url === frame.url);
}

function checkNavigationFailure(snapshot: NavigationSnapshot) {
  const { tab, frame, failed } = snapshot;
  // ERR_ABORTED can mean a download or a superseded request. Only the current error document is failure.
  if (failed && frame?.errorOccurred && tab.status === "complete" && !tab.pendingUrl
    && failed.url === frame.url && (!failed.documentId || failed.documentId === frame.documentId)) {
    throw new ToolExecutionError("NAVIGATION_FAILED", "The page navigation failed.", { url: failed.url, cause: failed.error });
  }
}

export function observeNextPageNavigation(tabId: number, signal: AbortSignal): WaitObservation<{ status: string; url: string; title: string }> {
  const controller = new AbortController();
  const current = AbortSignal.any([signal, controller.signal]);
  const evidence = observeNavigationEvidence(tabId);
  const observed = pollState(current, async () => {
    const snapshot = await evidence.read();
    if (!snapshot) return;
    checkNavigationFailure(snapshot);
    if (committedNavigation(snapshot)) return { status: "navigated", url: snapshot.frame!.url, title: snapshot.tab.title || "" };
  });
  return { result: observed.result, dispose() { evidence.dispose(); controller.abort(); } };
}

/** Observe one action; never dispatch or replay it. Document IDs also distinguish same-URL reloads. */
export async function beginPageNavigationObservation(tabId: number, signal?: AbortSignal,
  { settleMs = 180, timeoutMs = 10_000, probeMs = 100, deadlineAt = Infinity } = {}) {
  let disposed = false, started = false;
  const cancelled = () => Object.assign(new ToolExecutionError("OPERATION_ABORTED", "Page navigation observation cancelled"), {
    hint: "Inspect the page state before retrying the action.",
  });
  const check = () => {
    if (disposed || signal?.aborted) throw cancelled();
  };
  const wait = <T>(operation: Promise<T>, ms: number): Promise<T | null> => {
    check();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); reject(cancelled()); };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  };
  const evidence = observeNavigationEvidence(tabId);
  const dispose = () => {
    disposed = true;
    evidence.dispose();
    signal?.removeEventListener("abort", dispose);
  };
  signal?.addEventListener("abort", dispose, { once: true });
  let baselineState: NavigationSnapshot | null;
  try { baselineState = await wait(evidence.read(), probeMs); check(); }
  catch (error) { dispose(); throw error; }
  const baseline = baselineState?.tab;
  const previousId = baselineState?.frame?.documentId || null;
  evidence.reset();
  return {
    dispose,
    async finish(pageBefore: PageState) {
      const dispatchPage = baseline ? { url: baseline.url || "", title: baseline.title || "" } : pageBefore;
      try {
        // Leave one probe interval to return the receipt before the call's hard deadline.
        const deadline = Math.min(Date.now() + timeoutMs, deadlineAt - probeMs);
        await wait(new Promise<never>(() => {}), Math.min(settleMs, Math.max(0, deadline - Date.now())));
        let tab: chrome.tabs.Tab | null = null;
        let documentChanged: boolean | null = null;
        for (;;) {
          check();
          const snapshot = await wait(evidence.read(), Math.max(0, deadline - Date.now()));
          check();
          tab = snapshot?.tab || null;
          if (snapshot) checkNavigationFailure(snapshot);
          const currentId = snapshot?.frame?.documentId || null;
          documentChanged = documentChanged === true ? true : previousId && currentId ? previousId !== currentId : null;
          const loading = tab?.status === "loading" || Boolean(tab?.pendingUrl);
          const baselineLoading = !baseline || baseline.status === "loading" || Boolean(baseline.pendingUrl);
          const committed = Boolean(snapshot && !snapshot.frame?.errorOccurred && (documentChanged === true || committedNavigation(snapshot)));
          started ||= Boolean(snapshot?.started) || committed || Boolean(baseline && tab && (
            (!baselineLoading && loading) || (tab.pendingUrl && tab.pendingUrl !== baseline.pendingUrl)));
          // A request alone is not evidence of navigation. Downloads, 204 responses,
          // and cancelled navigations can finish without replacing the document.
          const pending = !tab || (started && (Boolean(tab.pendingUrl) || loading && !committed || Boolean(snapshot?.frame?.errorOccurred)));
          if (!pending || Date.now() >= deadline) {
            return {
              pageBefore: dispatchPage,
              pageAfter: tab ? { url: tab.url || "", title: tab.title || "" } : dispatchPage,
              navigationPending: pending,
              navigationCommitted: committed,
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

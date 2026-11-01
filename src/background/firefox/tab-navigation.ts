type Request = { tabId: number; requestId: string; url: string; timeStamp?: number };
type Event<T> = { addListener(listener: (details: T) => void, filter?: { urls: string[]; types: string[] }): void };
interface NavigationHost {
  tabs?: {
    get(id: number): Promise<chrome.tabs.Tab>;
    query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
    onRemoved: { addListener(listener: (id: number) => void): void };
  };
  webRequest?: {
    onBeforeRequest: Event<Request>;
    onBeforeRedirect: Event<Request & { redirectUrl: string }>;
    onErrorOccurred: Event<Request>;
    onHeadersReceived: Event<Request & { statusCode: number }>;
  };
  webNavigation?: { onCommitted: Event<{ tabId: number; frameId: number; url: string; timeStamp?: number }> };
}

const COMMIT_HISTORY_LIMIT = 64;
const installed = new WeakSet<object>();
const withoutFragment = (url: string) => url.split("#", 1)[0];

/** Firefox omits Tab.pendingUrl. Supply the browser field until the main document commits. */
export function installFirefoxTabNavigation(browser: NavigationHost) {
  const tabs = browser.tabs, requests = browser.webRequest, navigation = browser.webNavigation;
  if (!tabs?.get || !tabs.query || !requests?.onBeforeRequest || !requests.onBeforeRedirect
    || !requests.onErrorOccurred || !requests.onHeadersReceived || !navigation?.onCommitted || installed.has(tabs)) return;
  installed.add(tabs);
  const pending = new Map<number, Request>();
  // Main-frame commit timestamps, keyed by fragment-stripped URL. Firefox can
  // deliver onCommitted before the matching onBeforeRequest; that request's own
  // timestamp is then at or before the commit and must not re-arm pendingUrl.
  const committedAt = new Map<number, Map<string, number>>();
  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  const alreadyCommitted = (tabId: number, request: Request) => {
    const stamp = committedAt.get(tabId)?.get(withoutFragment(request.url));
    return typeof stamp === "number" && typeof request.timeStamp === "number" && stamp >= request.timeStamp;
  };
  requests.onBeforeRequest.addListener(details => {
    if (details.tabId >= 0 && !alreadyCommitted(details.tabId, details)) pending.set(details.tabId, { ...details });
  }, filter);
  requests.onBeforeRedirect.addListener(details => {
    const current = pending.get(details.tabId);
    if (current?.requestId === details.requestId) pending.set(details.tabId, { ...current, url: details.redirectUrl });
  }, filter);
  const finish = (details: Request) => {
    if (pending.get(details.tabId)?.requestId === details.requestId) pending.delete(details.tabId);
  };
  requests.onErrorOccurred.addListener(finish, filter);
  requests.onHeadersReceived.addListener(details => {
    if (details.statusCode === 204 || details.statusCode === 205) finish(details);
  }, filter);
  navigation.onCommitted.addListener(details => {
    if (details.frameId !== 0) return;
    if (typeof details.timeStamp === "number") {
      let urls = committedAt.get(details.tabId);
      if (!urls) committedAt.set(details.tabId, urls = new Map());
      const key = withoutFragment(details.url);
      const previous = urls.get(key);
      if (previous == null || details.timeStamp >= previous) urls.set(key, details.timeStamp);
      // Retain several destinations for out-of-order requests and redirects, but
      // bound long-lived tabs. Evict by event time, not delivery order.
      if (urls.size > COMMIT_HISTORY_LIMIT) {
        const oldest = [...urls].reduce((a, b) => a[1] <= b[1] ? a : b);
        urls.delete(oldest[0]);
      }
    }
    const current = pending.get(details.tabId);
    if (current && withoutFragment(current.url) === withoutFragment(details.url)
      && (current.timeStamp == null || details.timeStamp == null || alreadyCommitted(details.tabId, current))) pending.delete(details.tabId);
  });
  tabs.onRemoved.addListener(id => {
    pending.delete(id);
    committedAt.delete(id);
  });
  const annotate = (tab: chrome.tabs.Tab) => {
    const id = tab.id;
    const current = id == null ? undefined : pending.get(id);
    if (id == null || !current || tab.pendingUrl) return tab;
    // An existing complete document is not commit evidence for a reload. After
    // adapter startup (or history eviction), unknown timestamps stay pending.
    if (alreadyCommitted(id, current)) {
      pending.delete(id);
      return tab;
    }
    return { ...tab, pendingUrl: current.url };
  };
  const get = tabs.get.bind(tabs), query = tabs.query.bind(tabs);
  tabs.get = async id => annotate(await get(id));
  tabs.query = async options => (await query(options)).map(annotate);
}

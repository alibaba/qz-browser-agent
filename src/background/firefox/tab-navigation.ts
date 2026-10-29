type Request = { tabId: number; requestId: string; url: string };
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
  webNavigation?: { onCommitted: Event<{ tabId: number; frameId: number; url: string }> };
}

const installed = new WeakSet<object>();
const withoutFragment = (url: string) => url.split("#", 1)[0];

/** Firefox omits Tab.pendingUrl. Supply the browser field until the main document commits. */
export function installFirefoxTabNavigation(browser: NavigationHost) {
  const tabs = browser.tabs, requests = browser.webRequest, navigation = browser.webNavigation;
  if (!tabs?.get || !tabs.query || !requests?.onBeforeRequest || !requests.onBeforeRedirect
    || !requests.onErrorOccurred || !requests.onHeadersReceived || !navigation?.onCommitted || installed.has(tabs)) return;
  installed.add(tabs);
  const pending = new Map<number, Request>();
  const filter = { urls: ["<all_urls>"], types: ["main_frame"] };
  requests.onBeforeRequest.addListener(details => {
    if (details.tabId >= 0) pending.set(details.tabId, { ...details });
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
    const current = pending.get(details.tabId);
    if (details.frameId === 0 && current && withoutFragment(current.url) === withoutFragment(details.url)) pending.delete(details.tabId);
  });
  tabs.onRemoved.addListener(id => pending.delete(id));
  const annotate = (tab: chrome.tabs.Tab) => {
    const current = tab.id == null ? undefined : pending.get(tab.id);
    return current && !tab.pendingUrl ? { ...tab, pendingUrl: current.url } : tab;
  };
  const get = tabs.get.bind(tabs), query = tabs.query.bind(tabs);
  tabs.get = async id => annotate(await get(id));
  tabs.query = async options => (await query(options)).map(annotate);
}

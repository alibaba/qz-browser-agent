import assert from "node:assert/strict";
import { test } from "node:test";
import { installFirefoxTabNavigation } from "../../src/background/firefox/tab-navigation.js";

const event = () => {
  const listeners = [];
  return { listeners, addListener: (callback, filter) => listeners.push({ callback, filter }),
    fire: details => listeners.forEach(({ callback }) => callback(details)) };
};
function fixture() {
  const tab = { id: 1, url: "https://old.test/", status: "loading" };
  const browser = {
    tabs: { async get() { return tab; }, async query() { return [tab]; }, onRemoved: event() },
    webRequest: Object.fromEntries(["onBeforeRequest", "onBeforeRedirect", "onErrorOccurred", "onHeadersReceived"].map(name => [name, event()])),
    webNavigation: { onCommitted: event() },
  };
  installFirefoxTabNavigation(browser);
  return { browser, tab, request: { tabId: 1, requestId: "first", url: "https://new.test/" } };
}

test("Firefox exposes pending main navigation in get/query until commit, not until resources finish", async () => {
  const { browser: b, tab, request } = fixture();
  b.webRequest.onBeforeRequest.fire(request);
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
  assert.equal((await b.tabs.query({}))[0].pendingUrl, request.url);
  assert.equal(tab.pendingUrl, undefined, "native browser objects are not mutated");
  assert.deepEqual(b.webRequest.onBeforeRequest.listeners[0].filter.types, ["main_frame"]);
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 1, url: request.url });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "subframes cannot finish a main navigation");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: "about:blank" });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "late initial blank commit cannot erase pendingUrl");
  b.webRequest.onHeadersReceived.fire({ ...request, statusCode: 200 });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "response headers are not document commit");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url + "#part" });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
  assert.equal((await b.tabs.get(1)).status, "loading", "slow resources remain readable");
});

test("Firefox navigation events preserve replacement and same-URL reload identity", async () => {
  const { browser: b, request } = fixture();
  b.webRequest.onBeforeRequest.fire(request);
  const replacement = { ...request, requestId: "replacement" };
  b.webRequest.onBeforeRequest.fire(replacement);
  b.webRequest.onErrorOccurred.fire(request);
  b.webRequest.onHeadersReceived.fire({ ...request, statusCode: 204 });
  b.webRequest.onBeforeRedirect.fire({ ...request, redirectUrl: "https://obsolete.test/" });
  assert.equal((await b.tabs.get(1)).pendingUrl, replacement.url);
  b.webRequest.onBeforeRedirect.fire({ ...replacement, redirectUrl: "https://redirected.test/" });
  assert.equal((await b.tabs.get(1)).pendingUrl, "https://redirected.test/");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url });
  assert.equal((await b.tabs.get(1)).pendingUrl, "https://redirected.test/");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: "https://redirected.test/" });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
});

for (const end of ["error", "204", "205", "close"]) test(`Firefox pending navigation clears on ${end}`, async () => {
  const { browser: b, request } = fixture();
  b.webRequest.onBeforeRequest.fire(request);
  if (end === "error") b.webRequest.onErrorOccurred.fire(request);
  else if (end === "close") b.tabs.onRemoved.fire(1);
  else b.webRequest.onHeadersReceived.fire({ ...request, statusCode: Number(end) });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
});

test("Firefox pending URL adapter is idempotent and preserves native pendingUrl", async () => {
  const { browser: b, request, tab } = fixture();
  installFirefoxTabNavigation(b);
  assert.equal(b.webRequest.onBeforeRequest.listeners.length, 1);
  b.webRequest.onBeforeRequest.fire(request); tab.pendingUrl = "https://native.test/";
  assert.equal((await b.tabs.get(1)).pendingUrl, tab.pendingUrl);
});

test("Firefox ignores a main-frame request delivered after its document committed", async () => {
  const { browser: b, tab, request } = fixture();
  const committed = { ...request, timeStamp: 200 };
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url, timeStamp: committed.timeStamp });
  b.webRequest.onBeforeRequest.fire({ ...request, timeStamp: 100 });
  tab.url = request.url;
  tab.status = "loading";
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
  assert.equal((await b.tabs.query({}))[0].pendingUrl, undefined);
});

test("Firefox subframe commits do not retire a main-frame request", async () => {
  const { browser: b, request } = fixture();
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 1, url: request.url, timeStamp: 500 });
  b.webRequest.onBeforeRequest.fire({ ...request, timeStamp: 100 });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
});

test("Firefox keeps a newer same-URL request pending until that document commits", async () => {
  const { browser: b, tab, request } = fixture();
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url, timeStamp: 100 });
  const reload = { ...request, requestId: "reload", timeStamp: 200 };
  b.webRequest.onBeforeRequest.fire(reload);
  tab.url = request.url;
  tab.status = "complete";
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "status can still be complete when the reload request is recorded");
  tab.status = "loading";
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url + "#part", timeStamp: 250 });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
  assert.equal((await b.tabs.get(1)).status, "loading", "slow resources remain readable");
});

for (const timeStamp of [undefined, 200]) test(`Firefox adapter startup keeps a same-URL reload pending without historical commit evidence (${timeStamp})`, async () => {
  const { browser: b, tab, request } = fixture();
  tab.url = request.url;
  tab.status = 'complete';
  b.webRequest.onBeforeRequest.fire({ ...request, timeStamp });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
  tab.url = "https://old.test/";
  tab.status = "complete";
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "a different completed URL is still navigating");
  tab.url = request.url;
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
  assert.equal((await b.tabs.query({}))[0].pendingUrl, request.url);
  tab.status = "loading";
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "polling the old complete document cannot erase pending evidence");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: request.url, timeStamp: 300 });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
});

test("Firefox bounded commit history retains recent destinations regardless of delivery order", async () => {
  const { browser: b, tab } = fixture();
  const url = index => `https://history.test/?page=${index}`;
  const commit = index => b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: url(index), timeStamp: index * 10 });
  for (let index = 1; index <= 1000; index++) commit(index);
  commit(1); // Late delivery must not evict a recent destination.
  for (const index of [937, 999, 1000]) {
    b.webRequest.onBeforeRequest.fire({ tabId: 1, requestId: `late-${index}`, url: url(index), timeStamp: index * 10 - 1 });
    assert.equal((await b.tabs.get(1)).pendingUrl, undefined, 'recent late requests remain retired');
  }
  tab.url = url(1); tab.status = 'complete';
  b.webRequest.onBeforeRequest.fire({ tabId: 1, requestId: 'evicted', url: url(1), timeStamp: 9 });
  assert.equal((await b.tabs.get(1)).pendingUrl, url(1), 'evicted evidence is unknown, even on a complete tab');
  b.webRequest.onBeforeRedirect.fire({ tabId: 1, requestId: 'evicted', url: url(1), redirectUrl: url(999) });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined, 'retained redirect destination retires the late request');
  b.webRequest.onBeforeRequest.fire({ tabId: 1, requestId: 'reload', url: url(999), timeStamp: 10001 });
  commit(999);
  assert.equal((await b.tabs.get(1)).pendingUrl, url(999), 'an older commit cannot retire a newer reload');
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: url(999), timeStamp: 10002 });
  assert.equal((await b.tabs.get(1)).pendingUrl, undefined);
});

test("Firefox does not let a late previous request replace the current navigation", async () => {
  const { browser: b, request } = fixture();
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: "about:blank", timeStamp: 200 });
  b.webRequest.onBeforeRequest.fire({ ...request, timeStamp: 100 });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "an earlier blank commit does not swallow the target request");
  b.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0, url: "https://old.test/", timeStamp: 100 });
  b.webRequest.onBeforeRequest.fire({ ...request, requestId: "current", timeStamp: 150 });
  b.webRequest.onBeforeRequest.fire({ tabId: 1, requestId: "stale", url: "https://old.test/", timeStamp: 80 });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url);
  b.tabs.onRemoved.fire(1);
  b.webRequest.onBeforeRequest.fire({ ...request, timeStamp: 50 });
  assert.equal((await b.tabs.get(1)).pendingUrl, request.url, "closing the tab forgets commit timestamps");
});

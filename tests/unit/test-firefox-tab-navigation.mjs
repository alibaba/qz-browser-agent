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

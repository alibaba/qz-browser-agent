/** webRequest shaped into the CDP Network events the diagnostics monitor already reads. */

const BODY_LIMIT = 1024 * 1024;
const BODY_COUNT = 200;
const STARTED_LIMIT = 2000;

export interface NetworkWatch {
  enable(tabId: number): void;
  disable(tabId: number): void;
  body(tabId: number, requestId: string): { body: string; base64Encoded: boolean };
}

export function createNetworkWatch(chromeApi: NetworkChrome | undefined, emit: NetworkEmit): NetworkWatch {
  const tabs = new Set<number>();
  const started = new Set<string>();
  const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  let listening = false;
  const webRequest = chromeApi?.webRequest;

  const key = (tabId: number, requestId: string) => `${tabId}:${requestId}`;
  const rememberBody = (id: string, body: string, base64Encoded: boolean) => {
    bodies.set(id, { body, base64Encoded });
    while (bodies.size > BODY_COUNT) {
      const oldest = bodies.keys().next().value;
      if (oldest == null) break;
      bodies.delete(oldest);
    }
  };
  const emitStart = (details: WebRequestDetails, headers?: Record<string, unknown>) => {
    if (!tabs.has(details.tabId) || details.tabId < 0) return;
    const id = key(details.tabId, String(details.requestId));
    if (!noteStarted(id)) return;
    emit(details.tabId, "Network.requestWillBeSent", {
      requestId: String(details.requestId),
      timestamp: seconds(details.timeStamp),
      wallTime: seconds(details.timeStamp),
      type: resourceType(String(details.type || "")),
      initiator: { type: "other" },
      request: {
        url: String(details.url || ""),
        method: String(details.method || "GET"),
        headers: headers || headerMap(details.requestHeaders),
      },
    });
  };
  const onBefore = (details: WebRequestDetails) => {
    if (!tabs.has(details.tabId)) return {};
    if (!webRequest?.filterResponseData) return {};
    try {
      const filter = webRequest.filterResponseData(details.requestId);
      const chunks: Uint8Array[] = [];
      let size = 0;
      filter.ondata = event => {
        const bytes = new Uint8Array(event.data);
        if (size < BODY_LIMIT) {
          const kept = bytes.subarray(0, BODY_LIMIT - size);
          chunks.push(kept);
          size += kept.byteLength;
        }
        filter.write(event.data);
      };
      filter.onstop = () => {
        try { filter.disconnect(); } catch { /* The channel may already be closed. */ }
        const merged = new Uint8Array(Math.min(size, BODY_LIMIT));
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk.subarray(0, merged.length - offset), offset);
          offset += chunk.byteLength;
          if (offset >= merged.length) break;
        }
        const mime = String(details.type || "");
        const text = mime === "xmlhttprequest" || mime === "script" || mime === "stylesheet" || mime === "other";
        const id = key(details.tabId, String(details.requestId));
        if (text) rememberBody(id, new TextDecoder().decode(merged), false);
        else rememberBody(id, bytesToBase64(merged), true);
      };
      filter.onerror = () => { try { filter.disconnect(); } catch { /* already closed */ } };
    } catch { /* Non-blocking listeners cannot read the body. */ }
    return {};
  };
  const onHeaders = (details: WebRequestDetails) => {
    emitStart(details, headerMap(details.requestHeaders));
  };
  const onResponse = (details: WebRequestDetails) => {
    if (!tabs.has(details.tabId)) return;
    emitStart(details);
    emit(details.tabId, "Network.responseReceived", {
      requestId: String(details.requestId),
      timestamp: seconds(details.timeStamp),
      type: resourceType(String(details.type || "")),
      response: {
        url: String(details.url || ""),
        status: Number(details.statusCode || 0),
        statusText: statusText(details.statusLine),
        mimeType: headerValue(details.responseHeaders, "content-type"),
        headers: headerMap(details.responseHeaders),
        fromDiskCache: details.fromCache === true,
        remoteIPAddress: String(details.ip || ""),
      },
    });
  };
  const onCompleted = (details: WebRequestDetails) => {
    if (!tabs.has(details.tabId)) return;
    emitStart(details);
    const length = Number(headerValue(details.responseHeaders, "content-length"));
    emit(details.tabId, "Network.loadingFinished", {
      requestId: String(details.requestId),
      timestamp: seconds(details.timeStamp),
      encodedDataLength: Number.isFinite(length) ? length : 0,
    });
    started.delete(key(details.tabId, String(details.requestId)));
  };
  const onFailed = (details: WebRequestDetails) => {
    if (!tabs.has(details.tabId)) return;
    emitStart(details);
    emit(details.tabId, "Network.loadingFailed", {
      requestId: String(details.requestId),
      timestamp: seconds(details.timeStamp),
      errorText: String(details.error || "net::ERR_FAILED"),
      canceled: details.error === "NS_ERROR_ABORT" || details.error === "net::ERR_ABORTED",
      type: resourceType(String(details.type || "")),
    });
    started.delete(key(details.tabId, String(details.requestId)));
  };
  const noteStarted = (id: string) => {
    if (started.has(id)) return false;
    started.add(id);
    while (started.size > STARTED_LIMIT) {
      const oldest = started.keys().next().value;
      if (oldest == null) break;
      started.delete(oldest);
    }
    return true;
  };

  const ensure = () => {
    if (listening || !webRequest?.onBeforeRequest?.addListener) return;
    const filter = { urls: ["<all_urls>"] };
    const add = (event: WebRequestEvent | undefined, listener: (details: WebRequestDetails) => unknown, extra?: string[]) => {
      if (!event?.addListener) return;
      if (extra) {
        try { event.addListener(listener, filter, extra); return; }
        catch { /* This Firefox build rejected the extra info spec. */ }
      }
      try { event.addListener(listener, filter); }
      catch { /* This event cannot be observed. */ }
    };
    add(webRequest.onBeforeRequest, onBefore, ["blocking"]);
    add(webRequest.onBeforeSendHeaders, onHeaders, ["requestHeaders"]);
    add(webRequest.onHeadersReceived, onResponse, ["responseHeaders"]);
    add(webRequest.onCompleted, onCompleted, ["responseHeaders"]);
    add(webRequest.onErrorOccurred, onFailed);
    listening = true;
  };
  const stop = () => {
    if (!listening || !webRequest) return;
    webRequest.onBeforeRequest.removeListener?.(onBefore);
    webRequest.onBeforeSendHeaders?.removeListener?.(onHeaders);
    webRequest.onHeadersReceived?.removeListener?.(onResponse);
    webRequest.onCompleted?.removeListener?.(onCompleted);
    webRequest.onErrorOccurred?.removeListener?.(onFailed);
    listening = false;
  };

  return {
    enable(tabId: number) {
      if (!Number.isInteger(tabId) || tabId <= 0) return;
      tabs.add(tabId);
      ensure();
    },
    disable(tabId: number) {
      tabs.delete(tabId);
      for (const id of [...started]) if (id.startsWith(`${tabId}:`)) started.delete(id);
      for (const id of [...bodies.keys()]) if (id.startsWith(`${tabId}:`)) bodies.delete(id);
      if (!tabs.size) stop();
    },
    body(tabId: number, requestId: string) {
      const found = bodies.get(key(tabId, requestId));
      if (!found) throw new Error("No data found for resource");
      return found;
    },
  };
}

function seconds(value: unknown): number {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || stamp <= 0) return Date.now() / 1000;
  return stamp > 1_000_000_000_000 ? stamp / 1000 : stamp;
}

function resourceType(type: string): string {
  if (type === "xmlhttprequest") return "XHR";
  if (type === "script") return "Script";
  if (type === "stylesheet") return "Stylesheet";
  if (type === "image") return "Image";
  if (type === "media") return "Media";
  if (type === "font") return "Font";
  if (type === "websocket") return "WebSocket";
  if (type === "main_frame" || type === "sub_frame") return "Document";
  return "Other";
}

function headerMap(headers: WebHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers || []) {
    if (!header?.name) continue;
    out[header.name] = String(header.value ?? "");
  }
  return out;
}

function headerValue(headers: WebHeader[] | undefined, name: string): string {
  const found = (headers || []).find(header => header.name?.toLowerCase() === name);
  return String(found?.value || "");
}

function statusText(statusLine: unknown): string {
  const text = String(statusLine || "");
  const match = /^\S+\s+\d+\s+(.*)$/.exec(text);
  return match ? match[1] : "";
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}

type NetworkEmit = (tabId: number, method: string, params: Record<string, unknown>) => void;
interface WebHeader { name?: string; value?: string }
interface WebRequestDetails {
  requestId: string | number; tabId: number; url?: string; method?: string; type?: string;
  timeStamp?: number; statusCode?: number; statusLine?: string; error?: string; fromCache?: boolean; ip?: string;
  requestHeaders?: WebHeader[]; responseHeaders?: WebHeader[];
}
interface ResponseFilter {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  write(data: ArrayBuffer): void;
  disconnect(): void;
}
interface WebRequestEvent {
  addListener(listener: (details: WebRequestDetails) => unknown, filter: { urls: string[] }, extra?: string[]): void;
  removeListener?(listener: (details: WebRequestDetails) => unknown): void;
}
export interface NetworkChrome {
  webRequest?: {
    onBeforeRequest: WebRequestEvent;
    onBeforeSendHeaders?: WebRequestEvent;
    onHeadersReceived?: WebRequestEvent;
    onCompleted?: WebRequestEvent;
    onErrorOccurred?: WebRequestEvent;
    filterResponseData?(requestId: string | number): ResponseFilter;
  };
}

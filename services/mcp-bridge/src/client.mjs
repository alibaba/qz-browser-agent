import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PACKAGE_VERSION } from "./package-info.mjs";

export const GUIDE_URL = "https://github.com/alibaba/qz-browser-agent/blob/main/services/mcp-bridge/README.md";
export { INSTALL_URL } from "./package-info.mjs";
export const SERVICE_NAME = "qz-browser-agent";
export const PROTOCOL_VERSION = 1;

export class QzError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = String(code || "CONNECTION_ERROR").toUpperCase();
    this.details = details;
  }
}

export function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new QzError("INVALID_ENDPOINT", "The local service URL is invalid."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username || url.password || url.hash || url.search || url.port === "0") {
    throw new QzError("INVALID_ENDPOINT", "Use an HTTP local service URL on 127.0.0.1 or localhost.");
  }
  return url;
}

function responseBody(response) {
  const iterator = response[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() { return this; },
    next: () => iterator.next(),
    return() {
      // An iterator return waits behind a pending read. Destroy the HTTP stream first.
      response.destroy();
      return iterator.return();
    },
  };
}

// node:http does not inherit proxy environment settings. Every MCP request stays on loopback.
export async function localFetch(input, init) {
  const prepared = new Request(input, init);
  const url = localUrl(prepared.url);
  const body = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : null;
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: url.port || 80,
      path: url.pathname, method: prepared.method, signal: prepared.signal,
      headers: { ...Object.fromEntries(prepared.headers), host: url.host } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new QzError("REDIRECT_BLOCKED", "The local service returned a redirect."));
        return;
      }
      try {
        resolve(new Response([204, 304].includes(res.statusCode) ? null : responseBody(res), {
          status: res.statusCode, headers: new Headers(Object.entries(res.headers)
            .flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : value === undefined ? [] : [[key, value]])),
        }));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function readHealth(endpoint, { timeoutMs = 1000, fetch = localFetch, allowIncompatible = false, signal } = {}) {
  signal?.throwIfAborted();
  const url = localUrl(endpoint);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${url.origin}/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new QzError("CONNECTION_UNAVAILABLE", `The qz connection health check failed (${response.status}).`);
    const health = await response.json();
    signal?.throwIfAborted();
    if (health.service !== SERVICE_NAME || !health.instanceId || (!allowIncompatible && health.protocolVersion !== PROTOCOL_VERSION)) {
      throw new QzError("INCOMPATIBLE_SERVICE", "The local service is not a compatible qz installation.");
    }
    return health;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

function restoreCallImages(value, blocks) {
  const tagged = blocks.map((block, position) => ({
    mimeType: block.mimeType,
    data: block.data,
    id: String(block._meta?.id || ""),
    index: Number.isInteger(block._meta?.index) ? block._meta.index : position,
  }));
  const bytes = image => ({ mimeType: image.mimeType, data: image.data });
  if (!Array.isArray(value.results)) return { ...value, images: tagged.map(bytes) };
  const used = new Set();
  const results = value.results.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const id = String(item.id || "");
    const owned = tagged.filter(image => image.id && image.id === id);
    for (const image of owned) used.add(image);
    if (!owned.length) return item;
    owned.sort((left, right) => left.index - right.index);
    return { ...item, images: owned.map(bytes) };
  });
  const leftover = tagged.filter(image => !image.id || !used.has(image));
  return { ...value, results, ...(leftover.length ? { images: leftover.map(bytes) } : {}) };
}

export function resultValue(result) {
  if (result.structuredContent != null) return result.structuredContent;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks.filter(block => block?.type === "text");
  const images = blocks.filter(block => block?.type === "image" && typeof block.data === "string");
  if (texts.length === 1 && images.length + texts.length === blocks.length) {
    let value;
    try { value = JSON.parse(texts[0].text); } catch { value = texts[0].text; }
    if (images.length && value && typeof value === "object" && !Array.isArray(value)) return restoreCallImages(value, images);
    if (!images.length) return value;
  }
  return { content: result.content || [] };
}

function initialize(client, transport, timeoutMs, signal) {
  let timer, aborted;
  return new Promise((resolve, reject) => {
    const fail = error => {
      const failure = new QzError("CONNECTION_ERROR", `Could not initialize the MCP connection: ${error.message}`);
      if (error.name === "AbortError") failure.name = error.name;
      reject(failure);
    };
    aborted = () => fail(signal.reason);
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => fail(new Error("The connection handshake timed out.")), timeoutMs);
    client.connect(transport, { timeout: timeoutMs, signal }).then(resolve, fail);
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); });
}

/** Own one lazily initialized MCP connection for an entire command. */
export async function withToolClient(operation) {
  let client, transport, connecting, endpoint;
  const call = async (target, name, args, { timeoutMs = 180000, signal, fetch = localFetch } = {}) => {
    signal?.throwIfAborted();
    const origin = localUrl(target).origin;
    if (endpoint && endpoint !== origin) throw new QzError("CONNECTION_CHANGED", "The local service changed during the command.");
    if (!client) {
      endpoint = origin;
      client = new Client({ name: "qz-cli", version: PACKAGE_VERSION });
      transport = new StreamableHTTPClientTransport(new URL("/mcp", origin), {
        fetch, requestInit: { redirect: "error" },
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      });
      connecting = initialize(client, transport, timeoutMs, signal);
    }
    await connecting;
    signal?.throwIfAborted();
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal }).catch(error => {
      // The MCP SDK wraps caller cancellation as RequestTimeout; retain the caller's reason.
      signal?.throwIfAborted();
      throw error;
    });
    const value = resultValue(result);
    if (result.isError) {
      if (value && typeof value.code === "string" && typeof value.message === "string") {
        throw Object.assign(new QzError(value.code, value.message,
          value.details && typeof value.details === "object" && !Array.isArray(value.details) ? value.details : {}),
          value.hint ? { hint: value.hint } : {});
      }
      throw new QzError("TOOL_ERROR", typeof value === "string" ? value : "The browser tool failed.", { result: value });
    }
    return value;
  };
  try { return await operation(call); }
  finally {
    if (client) {
      let timer;
      await Promise.race([
        transport.terminateSession().catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
      ]).finally(() => clearTimeout(timer));
      await client.close().catch(() => {});
    }
  }
}

export function callTool(endpoint, name, args, options) {
  return withToolClient(call => call(endpoint, name, args, options));
}

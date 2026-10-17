import { request } from "node:http";
import { Readable } from "node:stream";
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
    this.code = code;
    this.details = details;
  }
}

export function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new QzError("invalid_endpoint", "The local service URL is invalid."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username || url.password || url.hash || url.search || url.port === "0") {
    throw new QzError("invalid_endpoint", "Use an HTTP local service URL on 127.0.0.1 or localhost.");
  }
  return url;
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
        reject(new QzError("redirect_blocked", "The local service returned a redirect."));
        return;
      }
      try {
        resolve(new Response([204, 304].includes(res.statusCode) ? null : Readable.toWeb(res), {
          status: res.statusCode, headers: new Headers(Object.entries(res.headers)
            .flatMap(([key, value]) => Array.isArray(value) ? value.map(item => [key, item]) : value === undefined ? [] : [[key, value]])),
        }));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function readHealth(endpoint, { timeoutMs = 1000, fetch = localFetch } = {}) {
  const url = localUrl(endpoint);
  const response = await fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new QzError("connection_unavailable", `The qz connection health check failed (${response.status}).`);
  const health = await response.json();
  if (health.service !== SERVICE_NAME || health.protocolVersion !== PROTOCOL_VERSION || !health.instanceId) {
    throw new QzError("incompatible_service", "The local service is not a compatible qz installation.");
  }
  return health;
}

export function resultValue(result) {
  if (result.structuredContent != null) return result.structuredContent;
  if (result.content?.length === 1 && result.content[0].type === "text") {
    try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
  }
  return { content: result.content || [] };
}

function initialize(client, transport, timeoutMs, signal) {
  let timer, aborted;
  return new Promise((resolve, reject) => {
    const fail = error => {
      const failure = new QzError("connection_error", `Could not initialize the MCP connection: ${error.message}`);
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
    if (endpoint && endpoint !== origin) throw new QzError("connection_changed", "The local service changed during the command.");
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
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal });
    const value = resultValue(result);
    if (result.isError) {
      if (value && typeof value.code === "string" && typeof value.message === "string") {
        throw new QzError(value.code, value.message,
          value.details && typeof value.details === "object" && !Array.isArray(value.details) ? value.details : {});
      }
      throw new QzError("tool_error", typeof value === "string" ? value : "The browser tool failed.", { result: value });
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

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { BridgeState, PROTOCOL_VERSION } from "./state.mjs";
import { INSTALL_URL } from "./package-info.mjs";
import { createMcpServer } from "./tools.mjs";
import { BrowserRegistry } from "./browser-registry.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CONNECT_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect qz</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:24px;background:#fafafa;color:#202020}h1{font-size:28px;line-height:1.2}a{color:inherit}p{color:#555}</style><h1>Connect qz</h1><p data-qz-connection-status>Connecting to the qz browser extension…</p><p>Keep this page open while qz connects. If qz is not installed, <a href="${INSTALL_URL}" target="_blank" rel="noopener noreferrer">install qz from the Chrome Web Store</a>.</p></html>`;

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

// Chrome origins stay `chrome-extension://` plus 32 characters from a-p.
// Firefox origins are `moz-extension://` plus the lowercase UUID stored for the
// gecko id in `extensions.webextensions.uuids`. The pairing token authenticates the profile.
export function isExtensionBridgeOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
    || /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(origin);
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error("Request body exceeds 32 MiB"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error("JSON object required"), { status: 400 });
  }
}

export async function startBridge({ host = "127.0.0.1", port = 18765, instanceId = randomUUID(), scopeId = "", buildId = "", onClose,
  registryPath, registry, requestTimeoutSeconds = 180, connectWaitMs = 2000, mcpSessionIdleTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("qz bridge must bind to loopback");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid bridge port");
  if (!Number.isFinite(mcpSessionIdleTimeoutMs) || mcpSessionIdleTimeoutMs <= 0) throw new Error("Invalid MCP session idle timeout");
  const state = new BridgeState({ requestTimeoutSeconds, connectWaitMs, instanceId, registry: registry || await BrowserRegistry.open(registryPath) });
  const sessions = new Map();
  const mcpResponses = new Set();
  let actualPort;
  let closing;
  const forgetSession = session => {
    clearTimeout(session.idleTimer);
    session.closed = true;
    if (sessions.get(session.transport.sessionId) === session) sessions.delete(session.transport.sessionId);
  };
  const scheduleSessionCleanup = session => {
    clearTimeout(session.idleTimer);
    if (closing || session.closed || session.activeResponses) return;
    session.idleTimer = setTimeout(() => {
      forgetSession(session);
      void session.mcp.close().catch(() => {});
    }, mcpSessionIdleTimeoutMs);
    session.idleTimer.unref();
  };
  const trackSessionResponse = (session, request, response, body) => {
    clearTimeout(session.idleTimer);
    session.activeResponses += 1;
    const finish = () => {
      response.off("finish", finish);
      response.off("close", disconnected);
      session.activeResponses -= 1;
      scheduleSessionCleanup(session);
    };
    const disconnected = () => {
      if (!response.writableFinished && request.method === "POST" && isJSONRPCRequest(body)) {
        // This bridge has no event store or response resumption. Forward a standard
        // cancellation through the SDK so only the abandoned request loses authority.
        session.transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/cancelled",
          params: { requestId: body.id, reason: "MCP response connection closed" } });
      }
      finish();
    };
    response.once("finish", finish);
    response.once("close", disconnected);
  };
  const server = createServer(async (request, response) => {
    let cors = {};
    try {
      if (closing) return sendJson(response, 503, { error: "The local bridge is stopping" });
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(String(request.headers.host || "").toLowerCase())) {
        return sendJson(response, 421, { error: "invalid bridge host" });
      }
      const path = new URL(request.url, state.endpoint).pathname;
      const origin = String(request.headers.origin || "");
      // Browser sites cannot call the bridge. Extension origins may use poll/result routes.
      // /mcp stays closed to every Origin so a page cannot open an MCP session.
      if (origin && (path === "/mcp" || !isExtensionBridgeOrigin(origin))) {
        return sendJson(response, 403, { error: "invalid bridge origin" });
      }
      cors = origin ? {
        "access-control-allow-origin": origin, vary: "Origin",
        "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type",
      } : {};
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "cache-control": "no-store", ...cors });
        return response.end();
      }
      if (request.method === "GET" && path === "/health") return sendJson(response, 200, {
        ok: true, service: "qz-browser-agent", protocolVersion: PROTOCOL_VERSION, features: { browserPairing: 1 }, instanceId, scopeId, buildId, processId: process.pid, status: state.status(),
      }, cors);
      if (request.method === "GET" && path === "/qz-connect") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        return response.end(CONNECT_PAGE);
      }
      if (request.method === "POST" && String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
        return sendJson(response, 415, { error: "JSON content-type required" }, cors);
      }
      if (path === "/mcp") {
        if (request.method === "POST") {
          let complete;
          const finished = new Promise(resolve => { complete = resolve; });
          const cleanup = () => {
            response.off("finish", cleanup);
            response.off("close", cleanup);
            mcpResponses.delete(finished);
            complete();
          };
          mcpResponses.add(finished);
          response.once("finish", cleanup);
          response.once("close", cleanup);
        }
        const sessionId = request.headers["mcp-session-id"];
        let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        const body = request.method === "POST" ? await readJson(request) : undefined;
        if (!session && !sessionId && request.method === "POST" && isInitializeRequest(body)) {
          const mcp = createMcpServer(state);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => sessions.set(id, session),
            onsessionclosed: () => forgetSession(session),
          });
          session = { mcp, transport, activeResponses: 0, idleTimer: undefined, closed: false };
          await mcp.connect(transport);
          mcp.onclose = () => forgetSession(session);
        }
        if (!session) return sendJson(response, sessionId ? 404 : 400, {
          jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32000, message: sessionId ? "Unknown MCP session" : "Initialize MCP first" },
        });
        if (response.destroyed) { scheduleSessionCleanup(session); return; }
        trackSessionResponse(session, request, response, body);
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method === "POST" && ["/v1/qingzhou/pair", "/v1/qingzhou/rename", "/v1/qingzhou/disconnect"].includes(path)) {
        const body = await readJson(request);
        return sendJson(response, 200, await state[path.split("/").at(-1)](body), cors);
      }
      if (request.method === "POST" && ["/v1/qingzhou/poll", "/v1/qingzhou/result"].includes(path)) {
        const body = await readJson(request);
        if (path.endsWith("/poll")) {
          const controller = new AbortController();
          const disconnected = () => { if (!response.writableEnded) controller.abort(new Error("Polling connection closed")); };
          response.once("close", disconnected);
          try {
            const client = body.client && typeof body.client === "object" && !Array.isArray(body.client) ? body.client : {};
            const requests = await state.poll(client, {
              timeoutMs: client.pollTimeoutMs || body.pollTimeoutMs || 30000,
              maxBatch: client.maxBatch || body.maxBatch || 4, signal: controller.signal,
            });
            if (!response.destroyed) sendJson(response, 200, { requests, ...state.connectionInfo(client) }, cors);
          } finally {
            response.off("close", disconnected);
          }
          return;
        }
        const requestId = String(body.requestId || "").trim();
        if (!requestId) return sendJson(response, 400, { ok: false, error: "requestId is required" }, cors);
        return sendJson(response, 200, { ok: state.complete(requestId, body) }, cors);
      }
      sendJson(response, 404, { error: "not found" }, cors);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) sendJson(response, error.status || (error.code ? 409 : 500), {
        ok: false, ...(error.code ? { code: error.code } : {}), error: error.message,
        ...(error.code === "BRIDGE_CLIENT_IN_USE" && Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      }, cors);
      else if (!response.destroyed) response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  actualPort = server.address().port;
  state.endpoint = `http://${host}:${actualPort}`;
  async function close() {
    return closing ??= (async () => {
      state.close();
      // Deliver the cancellation result before closing SSE, so clients need not wait for their request timeout.
      let timer;
      await Promise.race([
        Promise.allSettled([...mcpResponses]),
        new Promise(resolve => { timer = setTimeout(resolve, 1000); timer.unref(); }),
      ]).finally(() => clearTimeout(timer));
      await Promise.allSettled([...sessions.values()].map(session => {
        forgetSession(session);
        return session.mcp.close();
      }));
      sessions.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await onClose?.();
    })();
  }
  return { endpoint: state.endpoint, server, close, state, instanceId, scopeId, buildId };
}

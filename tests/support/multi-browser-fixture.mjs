import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const contentText = value => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter(part => part.type === "text").map(part => part.text).join("\n") : "";

/** Deterministic model and web pages; the real extension plans/runs tools and persists transcripts. */
export async function multiBrowserFixture() {
  const requests = [], pages = [];
  let endpoint;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      const marker = request.url.split("/").at(-1);
      pages.push({ at: Date.now(), marker });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><title>${marker}</title><main><h1>${marker}</h1><p>Independent profile research fixture ${marker}.</p></main>`);
      return;
    }
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const users = body.messages.filter(message => message.role === "user");
      const marker = users.map(message => contentText(message.content).match(/QZ_MULTI_[A-Z]+_\d+_[A-Z]+/)?.[0]).filter(Boolean).at(-1) || "validation";
      const results = body.messages.filter(message => message.role === "tool");
      const openId = `${marker}_open`, readId = `${marker}_read`;
      requests.push({ at: Date.now(), marker, stream: body.stream, toolIds: results.map(result => result.tool_call_id) });
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "validation", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Connected" }, finish_reason: "stop" }] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const tool = (id, name, args) => {
        send({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        send({}, "tool_calls");
      };
      if (marker.endsWith("_BROWSE") && !results.some(result => result.tool_call_id === openId)) {
        tool(openId, "open_tab", { url: `${endpoint}/page/${marker}` });
      } else if (marker.endsWith("_BROWSE") && !results.some(result => result.tool_call_id === readId)) {
        tool(readId, "read_article", { limit: 1500 });
      } else {
        send({ role: "assistant", content: `${marker}: ` });
        await delay(100);
        send({ content: "Completed the requested research." });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      requests.push({ error: error.message });
      if (!response.headersSent) response.writeHead(500);
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, requests, pages, config: { provider: "custom", customProtocol: "openai", customEndpoint: `${endpoint}/v1/chat/completions`,
    apiKey: "synthetic-multi-browser-key", model: "multi-browser-fixture", contextWindow: 128000,
    trimOldToolResults: true, vision: false, debugMode: false, requestRateLimit: false },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

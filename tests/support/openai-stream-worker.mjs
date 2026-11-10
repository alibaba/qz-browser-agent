import { parentPort, workerData } from "node:worker_threads";
import { loadModelsDevFixture } from "./models-dev-fixture.mjs";
import { createLlmGateway } from "../../src/background/llm/index.js";

/** Streams `workerData.deltas` as OpenAI SSE content deltas through the real gateway. */
await loadModelsDevFixture();
const { provider, deltas } = workerData;
globalThis.fetch = async () => new Response(
  [...deltas.map(content => ({ choices: [{ delta: { content } }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } },
);
const gateway = createLlmGateway({ rateGovernor: null });
const options = { config: { provider, apiKey: "fixture-key", model: "fixture-model" }, sessionId: "stream-session", rateLimit: false, retry: { maxRetries: 0 } };
let text = "";
let thinking = "";
let message = null;
let error = null;
try {
  for await (const event of gateway.chatStream([{ role: "user", content: "Hello" }], [], undefined, options)) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "thinking_delta") thinking += event.delta;
    if (event.type === "done") message = event.message;
  }
} catch (caught) {
  error = { name: caught?.name, code: caught?.code, message: String(caught?.message || caught) };
}
parentPort.postMessage({ text, thinking, content: message?.content ?? null, messageThinking: message?._thinking ?? "", error });

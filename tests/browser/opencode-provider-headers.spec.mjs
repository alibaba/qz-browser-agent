import { chromium } from "playwright";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

/** A real HTTPS receiver observes headers after Chrome's MV3 rules, not fetch arguments. */
test("provider requests send qz client identity and preserve OpenCode conversation routing on the wire", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-provider-headers-"));
  const requests = [];
  let context;
  let receiver;
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
    // Load the shipped gateway in an isolated MV3 worker without unrelated app startup traffic.
    manifest.background.service_worker = "provider-header-test.js";
    await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(extension, "provider-header-test.js"), `
      import { createLlmGateway } from "./background/llm/index.js";
      import { getProviderDef } from "./background/llm/provider-catalog.js";
      import { listProviderModels } from "./background/llm/model-directory.js";
      import { resolveRequestConfig } from "./background/llm/config.js";
      import { initializeProviderHeaderRules } from "./background/services/provider-header-rules.js";
      globalThis.providerHeaderTest = { createLlmGateway, getProviderDef, listProviderModels, resolveRequestConfig,
        ready: initializeProviderHeaderRules({ runtime: chrome.runtime, dnr: chrome.declarativeNetRequest, fetch }) };
    `);

    receiver = createServer({
      key: await readFile(new URL("../fixtures/tls/localhost-key.pem", import.meta.url)),
      cert: await readFile(new URL("../fixtures/tls/localhost-cert.pem", import.meta.url)),
    }, async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const payload = body ? JSON.parse(body) : null;
      requests.push({ host: request.headers.host, path: request.url, headers: request.headers, body: payload });
      if (request.url.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }));
      } else if (payload?.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]", "",
        ].join("\n\n"));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
      }
    });
    await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const port = receiver.address().port;
    context = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(),
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--ignore-certificate-errors",
        // Preserve the provider's original URL for DNR matching; every byte stays on loopback.
        `--host-resolver-rules=${["opencode.ai", "opencode.ai.invalid", "api.kimi.com", "api.kimi.com.invalid", "dashscope.aliyuncs.com", "chatgpt.com"].map(host => `MAP ${host} 127.0.0.1:${port}`).join(", ")}, MAP * ~NOTFOUND`,
      ],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await expect.poll(() => worker.evaluate(() => Boolean(globalThis.providerHeaderTest))).toBe(true);
    const results = await worker.evaluate(async () => {
      await globalThis.providerHeaderTest.ready;
      const { createLlmGateway, getProviderDef, listProviderModels, resolveRequestConfig } = globalThis.providerHeaderTest;
      const config = { provider: "opencodego", apiKey: "offline-fixture-key", model: "fixture-model" };
      const gateway = createLlmGateway({ rateGovernor: null, rateLearning: null, resolveConfig: () => resolveRequestConfig({ config }) });
      const messages = tag => [{ role: "user", content: tag }];
      const replies = [];
      replies.push((await gateway.chat(messages("first"), [], undefined, { sessionId: "conversation-a", runId: "run-1" })).message.content);
      for await (const event of gateway.chatStream(messages("follow-up"), [], undefined, { sessionId: "conversation-a", runId: "run-2" })) {
        if (event.type === "done") replies.push(event.message.content);
      }
      await Promise.all([
        gateway.chat(messages("same-conversation"), [], undefined, { sessionId: "conversation-a" }),
        gateway.chat(messages("independent-conversation"), [], undefined, { sessionId: "conversation-b" }),
      ]);
      await gateway.chat(messages("one-off-a"), []);
      await gateway.chat(messages("one-off-b"), []);
      const catalog = await listProviderModels(config.provider, getProviderDef(config), config.apiKey);

      for (const endpoint of [
        "https://opencode.ai/zen/v1/chat/completions",
        "https://opencode.ai/zen/go/v10/chat/completions",
        "https://opencode.ai.invalid/zen/go/v1/chat/completions",
      ]) {
        const other = createLlmGateway({ rateGovernor: null, rateLearning: null,
          resolveConfig: () => resolveRequestConfig({ config: { ...config, provider: "custom", customProtocol: "openai", customEndpoint: endpoint } }) });
        await other.chat(messages("unrelated-provider"), [], undefined, { sessionId: "unrelated-conversation" });
      }
      return { replies, modelCount: catalog.models.length };
    });
    expect(results.replies).toEqual(["OK", "OK"]);
    expect(results.modelCount).toBeGreaterThan(0);
    expect(requests).toHaveLength(9);
    const scopedRequests = [
      ["https://api.kimi.com/coding/v1/messages", true],
      ["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", true],
      ["https://chatgpt.com/backend-api/codex/responses", true],
      ["https://api.kimi.com/v1/messages", false],
      ["https://api.kimi.com.invalid/coding/v1/messages", false],
      ["https://dashscope.aliyuncs.com/api/v1/chat/completions", false],
      ["https://chatgpt.com/api/responses", false],
    ];
    for (const [url] of scopedRequests) {
      await worker.evaluate(async url => {
        const response = await fetch(url, { method: "POST", body: JSON.stringify({ messages: [] }) });
        if (!response.ok) throw new Error(`Header fixture failed: ${response.status}`);
        await response.text();
      }, url);
    }
    expect(requests).toHaveLength(9 + scopedRequests.length);
    const byMessage = text => requests.find(request => request.body?.messages?.some(message => message.content === text));
    for (const tag of ["first", "follow-up", "same-conversation"]) {
      expect(byMessage(tag).headers["x-opencode-session"], tag).toBe("conversation-a");
    }
    expect(byMessage("independent-conversation").headers["x-opencode-session"]).toBe("conversation-b");
    const oneOff = ["one-off-a", "one-off-b"].map(tag => byMessage(tag).headers["x-opencode-session"]);
    expect(oneOff.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(oneOff[0]).not.toBe(oneOff[1]);
    expect(byMessage("follow-up").body.stream).toBe(true);
    for (const request of requests) {
      const go = request.host === "opencode.ai" && request.path.startsWith("/zen/go/v1/");
      const scoped = scopedRequests.find(([url]) => url === `https://${request.host}${request.path}`)?.[1];
      if (go || scoped) expect(request.headers["user-agent"], `${request.host}${request.path}`).toBe("qz-agent/1.0.0");
      else expect(request.headers["user-agent"], `${request.host}${request.path}`).not.toBe("qz-agent/1.0.0");
      if (!go) expect(request.headers["x-opencode-session"]).toBeUndefined();
    }
    expect(requests.filter(request => request.path.endsWith("/models"))).toEqual([]);
    await testInfo.attach("provider-request-headers.json", {
      body: Buffer.from(JSON.stringify(requests.map(({ host, path, headers, body }) => ({
        host, path, userAgent: headers["user-agent"], sessionId: headers["x-opencode-session"], stream: body?.stream,
      })), null, 2)), contentType: "application/json",
    });
  } finally {
    await context?.close();
    if (receiver) {
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});

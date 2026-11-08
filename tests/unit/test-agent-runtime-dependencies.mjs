import { createTestAgentServices } from "../support/agent-services.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAgentBrowserContext } from "../../src/background/session/browser-context.js";

delete globalThis.chrome;

const { Agent } = await import("../../src/background/agent/agent.js?runtime-dependencies");

const calls = [];
const browserContext = createAgentBrowserContext({
  scripting: {
    executeScript: async options => {
      calls.push(["selection", options.target.tabId]);
      return [{ result: "selected text" }];
    },
  },
  tabs: {
    get: async tabId => {
      calls.push(["tab", tabId]);
      if (tabId === 10) {
        return {
          id: tabId,
          title: "about:blank",
          url: "about:blank",
          pendingUrl: "https://example.test/loading",
        };
      }
      return { id: tabId, title: "Page", url: "https://example.test/page" };
    },
  },
});

assert.equal(await browserContext.readSelectedText(9), "selected text");
assert.deepEqual(await browserContext.getTab(9), { id: 9, title: "Page", url: "https://example.test/page" });
assert.equal(await browserContext.readSelectedText(0), "");
assert.equal(await browserContext.getTab("bad"), null);

const stalledSelectionContext = createAgentBrowserContext({
  scripting: { executeScript: () => new Promise(() => {}) },
  selectionReadTimeoutMs: 10,
});
const stalledSelectionStartedAt = Date.now();
assert.equal(await stalledSelectionContext.readSelectedText(9), "");
assert.ok(Date.now() - stalledSelectionStartedAt < 500, "stalled page injection must fail open promptly");

const agent = new Agent("session-child", {
    services: createTestAgentServices(),
  conversationRepository: {
    readActiveConversation: async () => null,
    writeActiveConversation: async () => true,
    clearActiveConversation: async () => true,
  },
  conversationLease: { sessionId: "session-child", isActive: () => true },
  llm: { chat: async () => ({}), chatStream: async function* () {} },
  tools: { execute: async () => ({}), getIdentity: () => ({}), getSchemas: () => [], getModelPolicy: () => ({ pageContext: "working" }) },
  browserContext,
  sessionPolicy: { canManageSessions: async sessionId => sessionId !== "session-child" },
});

assert.equal(await agent._canManageSessions(), false);
agent.setDynamicContextProvider(async () => ({ userVisibleTab: { id: 9 } }));
assert.equal((await agent._collectDynamicContext()).selectionText, "selected text");
const explicitCalls = [];
agent._toolRuntime.execute = async (_name, args) => { explicitCalls.push(args); return { text: 'page' }; };
agent._dynamicContextSnapshot = { workingTab: { id: 10 }, userVisibleTab: { id: 9 } };
await agent._executeToolCalls([{ id: 'explicit', function: { name: 'read_dom', arguments: '{"tabRef":9}' } },
  { id: 'missing', function: { name: 'read_dom', arguments: '{}' } }], new AbortController().signal);
assert.deepEqual(explicitCalls, [{ tabRef: 9 }, {}], 'Agent forwards caller targets without a context-derived default');
assert.ok(calls.some(call => call[0] === "selection" && call[1] === 9));
assert.ok(calls.some(call => call[0] === "tab" && call[1] === 9));

const document = {
  sessionId: "session-child",
  messageId: "message-1",
  attachmentId: "attachment-1",
  fileId: "file-1",
  docModelId: "model-1",
  filename: "example.py",
  mimeType: "text/x-python",
  format: "code",
  size: 42,
};
const attachmentMessage = agent._buildUserMessage("", [], "message-1", [document]);
const attachmentCapsule = agent._buildDocumentCapsuleMessage([document], "message-1");
assert.deepEqual(attachmentMessage.documents, [document]);
assert.equal(agent._toSendMessage(attachmentMessage, false).content, "请查看附件。");
assert.equal(attachmentCapsule._origin, "context_capsule");
assert.match(attachmentCapsule.content, /当前可用技能.*load_skill/);
assert.doesNotMatch(attachmentCapsule.content, /qingzhou-documents/);
assert.match(attachmentCapsule.content, /docModelId=model-1/);

const emitted = [];
agent._currentRunId = "run-profile";
agent._runProfile = {
  model: {
    provider: "custom",
    id: "example-model-v1",
  },
};
agent.subscribe(event => emitted.push(event));
agent._emit({ type: "message_update", delta: "流式内容" });
agent._emit({ type: "message_end", spanId: "reply-1", message: { role: "assistant", content: "完成" } });
assert.equal(emitted[0].provider, undefined, "stream deltas must not repeat model provenance");
assert.equal(emitted[1].provider, "custom");
assert.equal(emitted[1].model, "example-model-v1");
agent._currentRunId = null;
agent._runProfile = null;

const source = readFileSync(new URL("../../src/background/agent/agent.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /\bchrome\./, "Agent aggregate must not directly access Chrome APIs");
assert.doesNotMatch(source, /\bgetSessions\b/, "Agent aggregate must not read Session metadata storage");

console.log("agent runtime dependency tests passed");

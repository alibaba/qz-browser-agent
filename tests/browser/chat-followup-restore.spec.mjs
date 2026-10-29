import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { analyzeAssistantStreamFrames } from "../support/assistant-stream-fuzz.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`queued message editing · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 720 } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript({ content: `(${installBenchmarkChromeStub})({}); (${installRecallTransport})();` });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await page.evaluate(installRecallBackend);
    });

    for (const queueKind of ["followup", "steering"]) {
      test(`returns ${queueKind} text, image and file to the composer for editing and resending`, async ({ page }) => {
        await seed(page, { queueKind });
        await page.locator(".queued-followup-delete").click();
        await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes");
        await expect(page.locator("#input")).toBeFocused();
        await expect(page.locator(".input-image-attachment img")).toBeVisible();
        await expect(page.locator(".input-document-attachment.is-ready")).toContainText("notes.txt");
        await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
        expect(await page.locator(".input-image-attachment img").evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);

        // Rehydrate through the normal navigation path, including document ownership checks.
        await switchSession(page, "other");
        await switchSession(page, "recall");
        await expect(page.locator(".input-document-attachment.is-ready")).toContainText("notes.txt");
        await page.locator("#input").fill("Edited: check the totals too");
        await page.locator("#btn-send").click();
        await expect.poll(() => page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "prompt").length)).toBe(1);
        const sent = await page.evaluate(() => window.__qzPostedMessages.find(item => item.type === "prompt"));
        expect(sent.text).toBe("Edited: check the totals too");
        expect(sent.images).toHaveLength(1);
        expect(sent.documents).toHaveLength(1);
        expect(sent.documents[0]).toMatchObject({ filename: "notes.txt", messageId: sent.clientMessageId, sessionId: "recall" });
        expect(await page.evaluate(async ref => (await window.__recall.store.getDocumentFile(ref.fileId)).base64, sent.documents[0])).toBe(btoa("original notes"));
      });

      test(`extreme ${queueKind}: a blocked durable write resists repeated clicks, Enter and attachment removal`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.evaluate(() => {
          const b = window.__recall;
          b.persistHook = async () => {
            b.persistHook = null;
            b.writing = true;
            await new Promise(resolve => { b.releaseWrite = resolve; });
          };
        });
        const cancel = page.locator(".queued-followup-delete");
        await cancel.click();
        await page.waitForFunction(() => window.__recall.writing);
        await expect(cancel).toBeDisabled();
        await expect(page.locator("#input")).not.toBeEditable();
        await page.locator("#input").press("Enter");
        await page.evaluate(() => {
          for (let i = 0; i < 40; i++) document.querySelector(".queued-followup-delete").click();
          document.querySelector("[data-remove-document]")?.click();
          document.querySelector("[data-remove-image]")?.click();
        });
        await expect(page.locator(".input-document-attachment")).toHaveCount(1);
        expect(await page.evaluate(() => window.__recall.recallRequests)).toBe(1);
        expect(await page.evaluate(() => window.__qzPostedMessages.filter(m => m.type === "prompt"))).toEqual([]);
        await page.evaluate(() => window.__recall.releaseWrite());
        await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
        await expect(page.locator(".input-image-attachment")).toHaveCount(2);
        await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
        await assertDraftOwnership(page);
      });

      test(`extreme ${queueKind}: switching sessions during a blocked recall keeps both drafts isolated`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.evaluate(() => { window.__recall.delayMs = 800; });
        await page.locator(".queued-followup-delete").click();
        await switchSession(page, "other");
        await page.locator("#input").fill("另一会话的草稿 🐳");
        await page.waitForFunction(() => !window.__recall.agent.findPendingUserMessage("queued"));
        await expect(page.locator("#input")).toHaveValue("另一会话的草稿 🐳");
        await expect(page.locator(".input-document-attachment")).toHaveCount(0);
        await switchSession(page, "recall");
        await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
        await assertDraftOwnership(page);
      });

      test(`extreme ${queueKind}: consumption before the request arrives cannot duplicate the message`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.evaluate(() => { window.__recall.delayMs = 700; });
        await page.locator(".queued-followup-delete").click();
        const consumed = await page.evaluate(kind => {
          const b = window.__recall;
          // The production queue drain is the handoff boundary; the UI request has not reached it yet.
          const messages = (kind === "steering" ? b.agent.steeringQueue : b.agent.followUpQueue).drain();
          b.agent._emitQueueUpdate();
          return messages.map(message => message.clientMessageId);
        }, queueKind);
        expect(consumed).toEqual(["queued"]);
        await expect(page.locator("#input")).toBeEditable();
        await expect(page.locator("#input")).toHaveValue("Unsent draft");
        await expect(page.locator(".input-document-attachment")).toHaveCount(1);
        await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
        expect(await page.evaluate(() => window.__qzPostedMessages.filter(m => m.type === "prompt"))).toEqual([]);
      });

      test(`extreme ${queueKind}: failed attachment copying preserves the queue, then one retry succeeds`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.evaluate(() => { window.__recall.failCopy = true; });
        await page.locator(".queued-followup-delete").click();
        await expect(page.getByText("attachment transaction aborted", { exact: true })).toBeVisible();
        await expect(page.locator("#input")).toHaveValue("Unsent draft");
        await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(1);
        expect(await page.evaluate(async () => Boolean(await window.__recall.store.getDocumentFile("queued-file")))).toBe(true);
        await page.evaluate(() => { window.__recall.failCopy = false; });
        await page.locator(".queued-followup-delete").click();
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
        await assertDraftOwnership(page);
      });

      test(`extreme ${queueKind}: a lost success response recovers the committed draft before further editing`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.evaluate(() => { window.__recall.loseReply = true; window.__recall.failRecoveryReads = 2; });
        await page.locator(".queued-followup-delete").click();
        await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
        await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
        await page.locator("#input").press("ControlOrMeta+End");
        await page.keyboard.insertText(" — 再补充");
        await switchSession(page, "other");
        await switchSession(page, "recall");
        await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft — 再补充");
        await assertDraftOwnership(page);
      });

      test(`extreme ${queueKind}: attachment-only and long Unicode messages retain their exact contents`, async ({ page }) => {
        await seed(page, { queueKind, queuedText: "" });
        const imagePrompt = await page.evaluate(() => [...window.__recall.agent.getPendingFollowUps(),
          ...window.__recall.agent.getPendingSteerings()][0].text);
        await page.locator(".queued-followup-delete").click();
        // Image-only messages already carry the Agent's localized default prompt.
        await expect(page.locator("#input")).toHaveValue(imagePrompt);
        await expect(page.locator(".input-image-attachment")).toHaveCount(1);
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(1);
        await page.locator("#input").fill("");
        const text = "京都 🐳 café e\u0301 | 表格\n".repeat(2048);
        await page.evaluate(async ({ kind, text }) => {
          await window.__recall.agent.followUp(text, [], "long");
          if (kind === "steering") window.__recall.agent.steerFollowUp("long");
        }, { kind: queueKind, text });
        await page.locator('.queued-followup[data-client-message-id="long"] .queued-followup-delete').click();
        await expect(page.locator("#input")).toHaveValue(text);
        await page.locator("#btn-send").click();
        await expect.poll(() => page.evaluate(() => window.__qzPostedMessages.filter(m => m.type === "prompt").length)).toBe(1);
        const sent = await page.evaluate(() => window.__qzPostedMessages.find(m => m.type === "prompt"));
        expect(sent.text).toBe(text.trim());
        expect(sent.images).toHaveLength(1);
        expect(sent.documents).toHaveLength(1);
        expect(sent.documents[0].messageId).toBe(sent.clientMessageId);
        expect(await page.evaluate(async ref => (await window.__recall.store.getDocumentFile(ref.fileId)).base64, sent.documents[0])).toBe(btoa("original notes"));
      });

      test(`extreme ${queueKind}: composition blocks recall until the input method finishes`, async ({ page }) => {
        await seed(page, { queueKind, existingDraft: true });
        await page.locator("#input").evaluate(input => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
        await page.locator(".queued-followup-delete").click();
        await expect(page.locator(".queued-followup-delete")).toBeEnabled();
        expect(await page.evaluate(() => window.__recall.recallRequests || 0)).toBe(0);
        await expect(page.locator("#input")).toHaveValue("Unsent draft");
        await page.locator("#input").evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
        await page.locator(".queued-followup-delete").click();
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
        await assertDraftOwnership(page);
      });
    }

    test("extreme followup: cancelling while conversion to steering is in flight never duplicates work", async ({ page }) => {
      await seed(page, { existingDraft: true });
      await page.evaluate(() => { window.__recall.delayMs = 800; });
      await page.locator(".queued-followup-delete").click();
      await page.locator("[data-steer-follow-up]").click();
      await expect(page.locator(".queued-followup")).toHaveAttribute("data-queue-kind", "steering");
      await expect(page.locator("#input")).toBeEditable();
      await expect(page.locator("#input")).toHaveValue("Unsent draft");
      expect(await page.evaluate(() => window.__recall.agent.getPendingSteerings().length)).toBe(1);
      await page.evaluate(() => { window.__recall.delayMs = 0; });
      await page.locator(".queued-followup-delete").click();
      await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
      await assertDraftOwnership(page);
    });

    test("extreme followup: steering and a second cancel wait behind the first durable recall", async ({ page }) => {
      await seed(page, { existingDraft: true });
      await page.evaluate(async () => {
        const b = window.__recall;
        await b.agent.followUp("second message", [], "second");
        b.persistHook = async () => {
          b.persistHook = null;
          b.writing = true;
          await new Promise(resolve => { b.releaseWrite = resolve; });
        };
      });
      const first = page.locator('.queued-followup[data-client-message-id="queued"]');
      const second = page.locator('.queued-followup[data-client-message-id="second"]');
      await first.locator(".queued-followup-delete").click();
      await page.waitForFunction(() => window.__recall.writing);
      await first.locator("[data-steer-follow-up]").click();
      await second.locator(".queued-followup-delete").click();
      await expect(second.locator(".queued-followup-delete")).toBeEnabled();
      expect(await page.evaluate(() => window.__recall.recallRequests)).toBe(1);
      await page.evaluate(() => window.__recall.releaseWrite());
      await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(1);
      await second.locator(".queued-followup-delete").click();
      await expect(page.locator("#input")).toHaveValue("second message\n\nPlease inspect the screenshot and notes\n\nUnsent draft");
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
      await assertDraftOwnership(page);
    });

    test("merges an existing draft and its attachments without reparsing or losing either file", async ({ page }) => {
      await seed(page, { existingDraft: true });
      await expect(page.locator("#input")).toHaveValue("Unsent draft");
      await page.locator(".queued-followup-delete").click();
      await expect(page.locator("#input")).toHaveValue("Please inspect the screenshot and notes\n\nUnsent draft");
      await expect(page.locator(".input-image-attachment")).toHaveCount(2);
      await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
      const draft = await page.evaluate(() => window.__recall.runtime.composerDrafts[7]);
      expect(draft.messageId).toBe("existing");
      expect(draft.documents.map(item => item.messageId)).toEqual(["existing", "existing"]);
      expect(draft.documents[0].fileId).not.toBe("queued-file");
      expect(await page.evaluate(async () => {
        const { store, runtime } = window.__recall;
        return Promise.all(runtime.composerDrafts[7].documents.map(async item => ({
          bytes: (await store.getDocumentFile(item.fileId)).base64,
          blocks: (await store.getDocumentModel(item.docModelId)).blocks,
        })));
      })).toEqual([
        { bytes: btoa("original notes"), blocks: [{ type: "paragraph", text: "parsed queued notes" }] },
        { bytes: btoa("existing notes"), blocks: [{ type: "paragraph", text: "parsed existing notes" }] },
      ]);
      await page.locator('[data-remove-document]').first().click();
      await expect(page.locator(".input-document-attachment")).toHaveCount(1);
      await expect.poll(() => page.evaluate(async id => Boolean(await window.__recall.store.getDocumentFile(id)), draft.documents[0].fileId)).toBe(false);
      expect(await page.evaluate(async () => Boolean(await window.__recall.store.getDocumentFile("existing-file")))).toBe(true);
    });

    test("leaves the queue and existing draft intact when persistence fails, then retries once", async ({ page }) => {
      await seed(page, { existingDraft: true });
      await page.evaluate(() => { window.__recall.failWrite = true; });
      await page.locator(".queued-followup-delete").click();
      await expect(page.getByText("recall persistence failed", { exact: true })).toBeVisible();
      await expect(page.locator("#input")).toHaveValue("Unsent draft");
      await expect(page.locator("#input")).toBeEditable();
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(1);
      await expect(page.locator(".input-document-attachment")).toHaveCount(1);
      await page.evaluate(() => { window.__recall.failWrite = false; });
      await page.locator(".queued-followup-delete").click();
      await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(0);
    });
    for (const width of [360, 430, 560]) {
      test(`queued recall fuzz · ${width}px`, async ({ page }, testInfo) => {
        await runQueuedRecallFuzz(page, testInfo, { width, colorScheme });
      });
    }

  });
}

async function switchSession(page, sessionId) {
  await page.evaluate(async id => {
    await window.qingzhouConversationBenchmark.seedSession({ sessionId: id, title: id, transcript: [] });
    await window.qingzhouConversationBenchmark.switchToSession(id, { source: "benchmark" });
  }, sessionId);
}

async function seed(page, { queueKind = "followup", existingDraft = false, queuedText = "Please inspect the screenshot and notes" } = {}) {
  await page.evaluate(async ({ queueKind, existingDraft, queuedText }) => {
    const { agent, commands, store } = window.__recall;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d");
    context.fillStyle = "#9876ab";
    context.fillRect(0, 0, 16, 16);
    const image = { dataUrl: canvas.toDataURL(), type: "image/png", name: "screenshot.png" };
    async function documentFor(messageId, bytes) {
      const ref = { sessionId: "recall", messageId, attachmentId: `${messageId}-attachment`, fileId: `${messageId}-file`,
        docModelId: `${messageId}-model`, filename: "notes.txt", mimeType: "text/plain", format: "txt", size: bytes.length };
      await store.saveDocumentFile({ ...ref, id: ref.fileId, sourceTool: "chat_attachment", base64: btoa(bytes) });
      await store.saveDocumentModel({ ...ref, id: ref.docModelId, sourceTool: "chat_attachment", type: "txt",
        blocks: [{ type: "paragraph", text: `parsed ${messageId} notes` }] });
      return ref;
    }
    const queuedDocument = await documentFor("queued", "original notes");
    await agent.followUp(queuedText, [image], "queued", [queuedDocument]);
    if (queueKind === "steering") agent.steerFollowUp("queued");
    if (existingDraft) {
      const document = await documentFor("existing", "existing notes");
      await commands.saveSessionComposerDraftRuntime({ sessionId: "recall", windowId: 7, draft: {
        sessionId: "recall", messageId: "existing", text: "Unsent draft", updatedAt: Date.now(),
        images: [{ ...image, attachmentId: "existing-image" }], documents: [{ ...document, document, status: "ready" }],
      } });
    }
  }, { queueKind, existingDraft, queuedText });
  await switchSession(page, "recall");
  await page.evaluate(() => window.qingzhouConversationBenchmark.configureVisualState({ running: true,
    pendingFollowUps: window.__recall.agent.getPendingFollowUps(), pendingSteerings: window.__recall.agent.getPendingSteerings() }));
}

function installRecallTransport() {
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const post = port.postMessage.bind(port);
    port.postMessage = message => {
      if (!window.__recallTransport || !["restore_queued_message", "steer_follow_up", "get_composer_draft", "sync_composer_draft", "delete_chat_document"].includes(message.type)) return post(message);
      Promise.resolve().then(async () => {
        if (message.type === "get_composer_draft" && window.__recall.failRecoveryReads > 0) {
          window.__recall.failRecoveryReads--;
          throw Object.assign(new Error("recovery connection interrupted"), { code: "PORT_DISCONNECTED" });
        }
        if (message.type === "restore_queued_message") {
          window.__recall.recallRequests = (window.__recall.recallRequests || 0) + 1;
          if (window.__recall.delayMs) await new Promise(resolve => setTimeout(resolve, window.__recall.delayMs));
        }
        return window.__recallTransport.dispatch(message, { postMessage: value => {
          if (message.type === "restore_queued_message" && window.__recall.loseReply) {
            window.__recall.loseReply = false;
            window.__qzEmitPortMessage({ type: "error", requestId: message.requestId, code: "PORT_DISCONNECTED", message: "connection lost after commit" });
          } else window.__qzEmitPortMessage(value);
        } });
      })
        .catch(error => window.__qzEmitPortMessage({ type: "error", requestId: message.requestId, code: error.code || "TEST_FAILURE", message: error.message }));
    };
    return port;
  };
}

async function installRecallBackend() {
  const [{ Agent }, { createSessionCommands }, { createSidepanelTransport }, store, { createSessionSupervisor }] = await Promise.all([
    import("/extension/background/agent/agent.js"), import("/extension/background/session/commands.js"),
    import("/extension/background/transports/sidepanel.js"), import("/extension/shared/documents/document-store.js"),
    import("/extension/background/session/supervisor.js"),
  ]);
  const backend = window.__recall = { runtime: {}, durable: null, failWrite: false, store };
  const supervisor = backend.supervisor = createSessionSupervisor({
    createAgent: lease => new Agent(lease.sessionId, { canStartQueuedRun: () => false, conversationLease: lease }),
    onAgentEvent: (sessionId, event) => {
      if (event.type !== "queue_update") return;
      const runtime = { ...supervisor.getRuntime(sessionId), pendingFollowUps: event.pendingFollowUps, pendingSteerings: event.pendingSteerings,
        pendingFollowUpMessages: event.pendingFollowUpMessages, pendingSteeringMessages: event.pendingSteeringMessages };
      supervisor.setRuntime(sessionId, runtime);
      if (sessionId === "recall") backend.runtime = runtime;
      window.__qzEmitPortMessage({ ...event, sessionId });
    },
  });
  backend.agent = await supervisor.getAgent("recall");
  // This fixture streams an active run. Match that lifecycle in the real Supervisor,
  // whose queue events otherwise correctly report an idle Agent as no longer running.
  backend.agent._activeRun = new Promise(() => {});
  const commands = backend.commands = createSessionCommands({
    runtime: { set: (id, patch) => {
        const runtime = { ...supervisor.getRuntime(id), ...patch };
        supervisor.setRuntime(id, runtime);
        if (id === "recall") backend.runtime = runtime;
      },
      persist: async () => {
        await backend.persistHook?.();
        if (backend.failWrite) throw new Error("recall persistence failed");
        backend.durable = structuredClone(backend.runtime);
      } },
    sessionSupervisor: supervisor,
    sessionRepository: { getMetadata: async id => ({ id }) }, sessionRuntimeReady: Promise.resolve(),
    requireExplicitSessionId: id => { if (!id) throw new Error("missing session"); return id; },
    copyChatMessageDocuments: params => {
      if (backend.failCopy) throw new Error("attachment transaction aborted");
      return store.copyMessageDocuments(params);
    },
    removeChatMessageDocuments: store.deleteMessageDocuments,
  });
  window.__recallTransport = createSidepanelTransport({
    system: { ready: async () => {} }, attachments: { remove: store.deleteMessageDocument },
    sessions: { restoreQueuedMessage: commands.restoreQueuedMessageRuntime, steerFollowUp: commands.steerSessionFollowUpRuntime,
      getDraft: commands.getSessionComposerDraftRuntime, saveDraft: commands.saveSessionComposerDraftRuntime },
  }, { getWindowId: () => 7 });
}

async function assertDraftOwnership(page) {
  const data = await page.evaluate(async () => {
    const { runtime, store } = window.__recall;
    const draft = runtime.composerDrafts[7];
    return Promise.all(draft.documents.map(async ref => {
      const file = await store.getDocumentFile(ref.fileId), model = await store.getDocumentModel(ref.docModelId);
      return { expected: draft.messageId, file: file?.messageId, model: model?.messageId,
        bytes: file?.base64, linked: model?.fileId === file?.id };
    }));
  });
  expect(data).toHaveLength(2);
  expect(data.every(x => x.file === x.expected && x.model === x.expected && x.linked)).toBe(true);
  expect(data.map(x => x.bytes)).toEqual([btoa("original notes"), btoa("existing notes")]);
}

async function runQueuedRecallFuzz(page, testInfo, { width, colorScheme }) {
  test.setTimeout(60_000);
  const seedValue = 0x5eed + width * 7919 + (colorScheme === "dark" ? 104729 : 0) + testInfo.repeatEachIndex * 1000003;
  let state = seedValue >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  const existingDraft = random() > 0.5;
  const actions = [];
  let text = existingDraft ? "Unsent draft" : "";
  let imageCount = Number(existingDraft), documentCount = Number(existingDraft);
  await page.setViewportSize({ width, height: 760 });
  await seed(page, { existingDraft, queueKind: random() > 0.5 ? "steering" : "followup" });
  const planned = Array.from({ length: 5 }, (_, index) => ({ id: `fuzz-${index}`, text: `消息 ${index}：保留图片与附件 ${"补充说明。".repeat(1 + Math.floor(random() * 8))}`,
    images: Number(index % 3 !== 0), documents: Number(index % 3 !== 1) }));
  await page.evaluate(async planned => {
    const { agent, store } = window.__recall;
    const source = agent.findPendingUserMessage("queued");
    const image = { dataUrl: source.content.find(part => part.type === "image_url").image_url.url };
    for (const item of planned) {
      const documents = item.documents ? await store.copyMessageDocuments({ sessionId: "recall", messageId: "queued", targetMessageId: item.id, documents: source.documents }) : [];
      await agent.followUp(item.text, item.images ? [image] : [], item.id, documents);
    }
    const probe = window.__recallProbe = { phase: "interaction", frames: [], inputs: [], seq: 1, content: "正在整理行程。".repeat(130) };
    const publish = () => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: "message_update", sessionId: "recall", runId: "benchmark-visual-run",
      eventSeq: ++probe.seq, spanId: "recall-stream", content: probe.content });
    window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: "message_start", sessionId: "recall", runId: "benchmark-visual-run", eventSeq: 1,
      spanId: "recall-stream", message: { role: "assistant", content: probe.content } });
    probe.timer = setInterval(() => { probe.content += "继续核对。"; publish(); }, 65);
    for (const type of ["click", "wheel"]) document.addEventListener(type, event => {
      if (event.isTrusted) probe.inputs.push({ type, seq: probe.seq, time: performance.now() });
    }, { capture: true });
    const sample = () => {
      const messages = document.querySelector("#messages");
      probe.frames.push({ time: performance.now(), phase: probe.phase, top: messages.scrollTop, height: messages.scrollHeight,
        client: messages.clientHeight, width: messages.clientWidth, tailGap: Math.max(0, messages.scrollHeight - messages.clientHeight - messages.scrollTop),
        contentLength: Number(messages.querySelector('[data-stream-trace-id="recall-stream"]')?.dataset.content?.length || 0) });
      if (!probe.stop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, planned);
  const remaining = [{ id: "queued", text: "Please inspect the screenshot and notes", images: 1, documents: 1 }, ...planned];
  try {
    while (remaining.length) {
      const [item] = remaining.splice(Math.floor(random() * remaining.length), 1);
      const row = page.locator(`#queued-followups .queued-followup[data-client-message-id="${item.id}"]`);
      if (random() > 0.45 && await row.getAttribute("data-queue-kind") === "followup") {
        await row.locator("[data-steer-follow-up]").click();
        await expect(row).toHaveAttribute("data-queue-kind", "steering");
        actions.push({ kind: "steer", id: item.id });
      }
      const doubleClick = random() > 0.4;
      const before = await page.evaluate(() => {
        window.__recall.delayMs = 130;
        return window.__recall.recallRequests || 0;
      });
      if (doubleClick) await row.locator(".queued-followup-delete").dblclick({ delay: 18 });
      else await row.locator(".queued-followup-delete").click();
      text = [item.text, text].filter(Boolean).join("\n\n");
      imageCount += item.images;
      documentCount += item.documents;
      actions.push({ kind: doubleClick ? "double-recall" : "recall", id: item.id });
      await expect(page.locator("#input")).toHaveValue(text);
      await expect(page.locator("#input")).toBeFocused();
      await expect(page.locator(".input-image-attachment")).toHaveCount(imageCount);
      await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(documentCount);
      expect(await page.evaluate(() => window.__recall.recallRequests)).toBe(before + 1);
      await expect(page.locator("#queued-followups .queued-followup")).toHaveCount(remaining.length);
      if (imageCount && random() > 0.6) {
        await page.locator("[data-remove-image]").nth(Math.floor(random() * imageCount)).click();
        imageCount--;
        actions.push({ kind: "remove-image" });
      }
      if (documentCount && random() > 0.6) {
        await page.locator("[data-remove-document]").nth(Math.floor(random() * documentCount)).click();
        documentCount--;
        actions.push({ kind: "remove-document" });
      }
      if (random() > 0.5) {
        const addition = `编辑补充 ${remaining.length}：周末 / café / 🧭`;
        text += `\n${addition}`;
        // Native Firefox's BiDi fill types unmodified Enter for newlines, which submits this
        // composer. Exercise the user's Shift+Enter editing gesture on both engines instead.
        await page.locator("#input").press("ControlOrMeta+End");
        await page.locator("#input").press("Shift+Enter");
        await page.keyboard.insertText(addition);
        await expect(page.locator("#input")).toHaveValue(text);
        actions.push({ kind: "edit" });
      }
      if (random() > 0.55) {
        await switchSession(page, "other");
        await expect(page.locator("#input")).toHaveValue("");
        await switchSession(page, "recall");
        await expect(page.locator("#input")).toHaveValue(text);
        await expect(page.locator(".input-image-attachment")).toHaveCount(imageCount);
        await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(documentCount);
        await page.evaluate(() => window.qingzhouConversationBenchmark.configureVisualState({ running: true,
          pendingFollowUps: window.__recall.agent.getPendingFollowUps(), pendingSteerings: window.__recall.agent.getPendingSteerings() }));
        actions.push({ kind: "switch-away-back" });
      }
      const messages = await page.locator("#messages").boundingBox();
      await page.mouse.move(messages.x + 3, messages.y + messages.height / 2);
      await page.mouse.wheel(0, -150 - Math.floor(random() * 350));
      await page.waitForTimeout(80);
      await page.mouse.wheel(0, 100000);
      await page.waitForTimeout(350);
      await page.evaluate(() => { window.__recallProbe.phase = "tail"; });
      await page.waitForTimeout(200);
      await page.evaluate(() => { window.__recallProbe.phase = "interaction"; });
      actions.push({ kind: "wheel-up-tail" });
    }
    expect(await page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "prompt"))).toEqual([]);
    await page.locator("#btn-send").click();
    await expect.poll(() => page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "prompt").length)).toBe(1);
    const sent = await page.evaluate(() => window.__qzPostedMessages.find(item => item.type === "prompt"));
    expect(sent.text).toBe(text);
    expect(sent.images).toHaveLength(imageCount);
    expect(sent.documents).toHaveLength(documentCount);
    expect(sent.documents.every(item => item.sessionId === "recall" && item.messageId === sent.clientMessageId)).toBe(true);
    const files = await page.evaluate(async documents => Promise.all(documents.map(async ref => {
      const [file, model] = await Promise.all([window.__recall.store.getDocumentFile(ref.fileId), window.__recall.store.getDocumentModel(ref.docModelId)]);
      return { fileOwner: file?.messageId, modelOwner: model?.messageId, expectedOwner: ref.messageId,
        fileId: file?.id, modelFileId: model?.fileId, bytes: file?.base64 };
    })), sent.documents);
    expect(files.every(item => item.fileOwner === item.expectedOwner && item.modelOwner === item.expectedOwner
      && item.fileId === item.modelFileId && [btoa("original notes"), btoa("existing notes")].includes(item.bytes))).toBe(true);
    const result = await page.evaluate(() => ({ frames: window.__recallProbe.frames, inputs: window.__recallProbe.inputs }));
    const analysis = analyzeAssistantStreamFrames(result.frames);
    expect(analysis.coverage.tailFrames).toBeGreaterThan(25);
    expect(analysis.coverage.tailContentChanges).toBeGreaterThan(5);
    expect(result.inputs.filter(item => item.type === "click").length).toBeGreaterThanOrEqual(7);
    expect(result.inputs.filter(item => item.type === "wheel").length).toBeGreaterThanOrEqual(12);
    expect(analysis.failures, JSON.stringify(analysis.failures.slice(0, 5))).toEqual([]);
  } finally {
    const evidence = await page.evaluate(() => {
      const probe = window.__recallProbe;
      clearInterval(probe.timer); probe.stop = true;
      return { frames: probe.frames, inputs: probe.inputs, input: document.querySelector("#input").value,
        queue: [...window.__recall.agent.getPendingFollowUps(), ...window.__recall.agent.getPendingSteerings()] };
    });
    await testInfo.attach("queued-recall-fuzz.json", { body: Buffer.from(JSON.stringify({ seed: seedValue, width, colorScheme, existingDraft, actions, ...evidence })), contentType: "application/json" });
  }
}

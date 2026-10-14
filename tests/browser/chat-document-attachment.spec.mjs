import { expect, test } from "./fixtures.mjs";

test.describe("message-owned document attachments", () => {
  test.use({ viewport: { width: 430, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installAttachmentChromeStub);
    await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  });

  test("gates send while parsing and restores the message-owned draft after a Session switch", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    const filename = "three-image-columns-long-python-source-name.py";
    await page.locator("#messages").evaluate((target, name) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["print('attachment')\n"], name, { type: "text/x-python" }));
      window.__attachmentDropTransfer = transfer;
      target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, filename);

    await expect(page.locator(".input-wrapper")).toHaveClass(/is-file-dragover/);
    await expect(page.locator("#messages")).not.toHaveClass(/is-file-dragover/);
    const lightCue = await readDropCue(page);
    expect(lightCue.boxShadow).not.toBe("none");
    expect(lightCue.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.emulateMedia({ colorScheme: "dark" });
    const darkCue = await readDropCue(page);
    expect(darkCue.boxShadow).not.toBe("none");
    expect(darkCue.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.locator("#messages").evaluate(target => {
      target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: window.__attachmentDropTransfer,
      }));
      delete window.__attachmentDropTransfer;
    });

    const card = page.locator(".input-document-attachment");
    await expect(card).toBeVisible();
    await expect(card.locator(".document-attachment-meta")).toHaveText("解析中…");
    await expect(page.locator("#btn-send")).toBeDisabled();
    await expect(page.locator(".input-wrapper")).not.toHaveClass(/is-file-dragover/);

    await page.evaluate(() => window.__resolveAttachmentStage());
    await expect(card.locator(".document-attachment-meta")).toContainText("已解析");
    await expect(page.locator("#btn-send")).toBeEnabled();
    await page.locator("#input").fill("保留这条未发送消息");

    const layout = await card.evaluate(node => {
      const name = node.querySelector(".document-attachment-name");
      const remove = node.querySelector(".document-attachment-remove");
      return {
        width: node.getBoundingClientRect().width,
        nameOverflow: name.scrollWidth > name.clientWidth,
        textOverflow: getComputedStyle(name).textOverflow,
        dangerClass: remove.classList.contains("qz-icon-btn--danger"),
      };
    });
    expect(layout.width).toBeCloseTo(168, 0);
    expect(layout.nameOverflow).toBe(true);
    expect(layout.textOverflow).toBe("ellipsis");
    expect(layout.dangerClass).toBe(false);

    await switchToSession(page, "another-session", "另一个任务");
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    await expect(page.locator("#input")).toHaveValue("");
    await expect(page.locator("#btn-send")).toBeDisabled();
    await switchToSession(page, "upload-session", "附件任务");
    await expect(page.locator("#input")).toHaveValue("保留这条未发送消息");
    await expect(page.locator(".input-document-attachment")).toHaveCount(1);
    await expect(page.locator(".input-document-attachment .document-attachment-meta")).toContainText("已解析");
    await expect(page.locator("#btn-send")).toBeEnabled();
    await switchToSession(page, "another-session", "另一个任务");
    await switchToSession(page, "upload-session", "附件任务");
    await expect(page.locator(".input-document-attachment")).toHaveCount(1);
    await expect(page.locator("#input")).toHaveValue("保留这条未发送消息");

    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    const created = messages.find(message => message.type === "create_ui_session");
    const staged = messages.find(message => message.type === "stage_chat_document");
    expect(created).toMatchObject({ title: "新会话", firstMessage: "" });
    expect(created.title).not.toContain(filename);
    expect(staged).toBeTruthy();
    expect(messages.some(message => message.type === "delete_chat_document")).toBe(false);
    expect(messages.some(message => message.type === "prompt" || message.type === "follow_up")).toBe(false);
  });

  test("restores an unsent text draft when the Side Panel document reopens", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.locator("#input").fill("写到一半、尚未发送的内容");
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await expect(page.locator("#input")).toHaveValue("写到一半、尚未发送的内容");
    await expect(page.locator("#btn-send")).toBeEnabled();
  });

  test("persists the first draft in the Session when the Side Panel immediately reopens", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.locator("#input").fill("最后一次输入也不能丢");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await expect(page.locator("#input")).toHaveValue("最后一次输入也不能丢");
  });

  test("restores before the Composer is revealed after a delayed window lookup", async ({ page }) => {
    await page.evaluate(() => window.__seedComposerDraft("upload-session", {
      messageId: "delayed-window-message",
      text: "当前窗口自己的草稿",
      updatedAt: Date.now(),
    }));
    await page.goto(
      "/extension/sidepanel/sidepanel.html?draftWindowDelay=350",
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await expect(page.locator("#input")).toHaveValue("当前窗口自己的草稿");
  });

  test("keeps multiple Session drafts after a delayed startup identity lookup", async ({ page }) => {
    await page.goto(
      "/extension/sidepanel/sidepanel.html?draftWindowDelay=600",
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await switchToSession(page, "late-window-first", "第一个任务");
    await page.locator("#input").fill("第一个窗口内草稿");
    await switchToSession(page, "late-window-second", "第二个任务");
    await page.locator("#input").fill("第二个窗口内草稿");

    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await switchToSession(page, "late-window-first", "第一个任务");
    await expect(page.locator("#input")).toHaveValue("第一个窗口内草稿");
    await switchToSession(page, "late-window-second", "第二个任务");
    await expect(page.locator("#input")).toHaveValue("第二个窗口内草稿");
  });

  test("flushes the current text immediately when the Side Panel hides", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.locator("#input").fill("关闭面板前最后输入的内容");
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await window.__lastDraftPersistence;
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await expect(page.locator("#input")).toHaveValue("关闭面板前最后输入的内容");
  });

  test("does not resurrect a sent draft after an immediate reopen", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.locator("#input").fill("已经发送的内容不能恢复");
    await page.locator("#input").press("Enter");
    await page.waitForFunction(() => (
      window.__attachmentPortMessages.some(message => message.type === "prompt")
    ));
    await page.evaluate(() => window.__lastDraftPersistence);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await expect(page.locator("#input")).toHaveValue("");
    await expect(page.locator("#btn-send")).toBeDisabled();
  });

  test("waits for the first Session creation before sending its autosaved draft", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.evaluate(() => { window.__deferSessionCreation = true; });
    await page.locator("#input").fill("hihi");
    await page.waitForFunction(() => window.__pendingSessionCreations.length === 1);

    await page.locator("#input").press("Enter");
    await expect(page.locator("#input")).toHaveJSProperty("readOnly", true);
    expect(await page.evaluate(() => (
      window.__attachmentPortMessages.filter(message => message.type === "prompt").length
    ))).toBe(0);

    expect(await page.evaluate(() => window.__resolveSessionCreation())).toBe(true);
    await page.waitForFunction(() => (
      window.__attachmentPortMessages.filter(message => message.type === "prompt").length === 1
    ));
    await expect(page.locator("#input")).toHaveValue("");
    await expect(page.locator("#input")).toHaveJSProperty("readOnly", false);
    await expect(page.locator(".msg-user")).toHaveCount(1);

    await page.locator("#input").press("Enter");
    expect(await page.evaluate(() => (
      window.__attachmentPortMessages.filter(message => message.type === "prompt").length
    ))).toBe(1);
    await expect(page.locator(".msg-user")).toHaveCount(1);
  });

  test("keeps a submitted draft if the panel closes before Background accepts it", async ({ page }) => {
    await page.waitForFunction(() => window.__attachmentWindowAttached === true);
    await page.locator("#input").fill("后台尚未接纳，必须可重试");
    await page.evaluate(() => { window.__deferDraftAcceptance = true; });
    await page.locator("#input").press("Enter");
    await page.waitForFunction(() => (
      window.__attachmentPortMessages.some(message => message.type === "prompt")
    ));
    const submitted = await page.evaluate(() => (
      window.__attachmentPortMessages.find(message => message.type === "prompt")
    ));
    expect(submitted?.composerDraft).toMatchObject({
      sessionId: "upload-session",
      messageId: submitted.clientMessageId,
      text: "后台尚未接纳，必须可重试",
    });
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await window.__lastDraftPersistence;
      const draft = window.__getComposerDraft("upload-session");
      if (draft?.text !== "后台尚未接纳，必须可重试") {
        throw new Error(`submitted draft was not persisted: ${JSON.stringify(draft)}`);
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await switchToSession(page, "upload-session", "待接纳消息");
    await expect(page.locator("#input")).toHaveValue("后台尚未接纳，必须可重试");
    await expect(page.locator("#btn-send")).toBeEnabled();
  });

  test("resumes an interrupted document parse after the Side Panel document reopens", async ({ page }) => {
    await page.locator("#input").fill("解析完成后继续发送");
    await pasteFile(page, "resume-after-reopen.py", "print('resume')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await switchToSession(page, "upload-session", "恢复解析");

    await expect(page.locator("#input")).toHaveValue("解析完成后继续发送");
    await expect(page.locator(".input-document-attachment")).toHaveClass(/is-parsing/);
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await page.evaluate(() => window.__resolveAttachmentStage());
    await expect(page.locator(".input-document-attachment")).toHaveClass(/is-ready/);
    await expect(page.locator("#btn-send")).toBeEnabled();
  });

  test("marks a restored ready document unavailable when its backing records are missing", async ({ page }) => {
    await page.evaluate(() => {
      window.__seedComposerDraft("missing-document-store", {
        messageId: "missing-message",
        text: "资源必须真实存在",
        documents: [{
          sessionId: "missing-document-store",
          messageId: "missing-message",
          attachmentId: "missing-attachment",
          fileId: "missing-file",
          docModelId: "missing-model",
          filename: "missing.xlsx",
          status: "ready",
          document: {
            sessionId: "missing-document-store",
            messageId: "missing-message",
            attachmentId: "missing-attachment",
            fileId: "missing-file",
            docModelId: "missing-model",
            filename: "missing.xlsx",
          },
        }],
        updatedAt: Date.now(),
      });
    });
    await switchToSession(page, "missing-document-store", "缺失资源");
    const card = page.locator(".input-document-attachment");
    await expect(card).toHaveClass(/is-error/);
    await expect(card).toHaveAttribute("title", /解析结果不可用/);
    await expect(page.locator("#btn-send")).toBeDisabled();
  });

  test("pastes and sends the ready document with the same message identity", async ({ page }) => {
    await page.locator("#input").evaluate(target => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["export const answer = 42;\n"], "pasted-source.js", {
        type: "text/javascript",
      }));
      target.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
    });

    await expect(page.locator(".input-document-attachment")).toBeVisible();
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await page.evaluate(() => window.__resolveAttachmentStage());
    await expect(page.locator("#btn-send")).toBeEnabled();
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => window.__attachmentPortMessages.some(message => message.type === "prompt"));

    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    const staged = messages.find(message => message.type === "stage_chat_document");
    const prompt = messages.find(message => message.type === "prompt");
    expect(prompt).toMatchObject({
      sessionId: staged.sessionId,
      clientMessageId: staged.messageId,
      text: "",
      documents: [{
        sessionId: staged.sessionId,
        messageId: staged.messageId,
        attachmentId: staged.attachmentId,
        fileId: staged.fileId,
        docModelId: staged.docModelId,
        filename: "pasted-source.js",
      }],
    });
    await expect(page.locator(".msg-user .document-attachment-card")).toHaveCount(1);
  });

  test("pastes an image and sends it as the current message payload", async ({ page }) => {
    await page.locator("#input").evaluate(async target => {
      const canvas = new OffscreenCanvas(32, 24);
      const context = canvas.getContext("2d");
      context.fillStyle = "#3b82f6";
      context.fillRect(0, 0, 32, 24);
      const image = await canvas.convertToBlob({ type: "image/png" });
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], "pasted-preview.png", {
        type: "image/png",
      }));
      target.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
    });

    const card = page.locator(".input-image-attachment");
    await expect(card).toBeVisible();
    await expect(card.locator("img")).toHaveAttribute("alt", "pasted-preview.png");
    await expect(card.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/u);
    await expect(page.locator("#btn-send")).toBeEnabled();

    await page.locator("#btn-send").click();
    await page.waitForFunction(() => window.__attachmentPortMessages.some(message => message.type === "prompt"));
    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    const prompt = messages.find(message => message.type === "prompt");
    expect(prompt).toMatchObject({
      sessionId: "upload-session",
      text: "",
      documents: [],
      images: [{ name: "pasted-preview.png", type: "image/png" }],
    });
    expect(prompt.images[0].dataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(messages.some(message => message.type === "stage_chat_document")).toBe(false);
    await expect(page.locator(".input-image-attachment")).toHaveCount(0);
    await expect(page.locator(".msg-user .msg-images img")).toHaveCount(1);
  });

  test("drops images from the whole chat surface and restores them with their Session draft", async ({ page }) => {
    await page.locator("#messages").evaluate(async target => {
      const canvas = new OffscreenCanvas(40, 30);
      const context = canvas.getContext("2d");
      context.fillStyle = "#16a34a";
      context.fillRect(0, 0, 40, 30);
      const image = await canvas.convertToBlob({ type: "image/jpeg" });
      const transfer = new DataTransfer();
      transfer.items.add(new File([image], "dropped-photo.jpg", {
        type: "image/jpeg",
      }));
      window.__imageDropTransfer = transfer;
      target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.locator(".input-wrapper")).toHaveClass(/is-file-dragover/);
    await page.locator("#messages").evaluate(target => {
      target.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: window.__imageDropTransfer,
      }));
      delete window.__imageDropTransfer;
    });

    await expect(page.locator(".input-wrapper")).not.toHaveClass(/is-file-dragover/);
    await expect(page.locator(".input-image-attachment img")).toHaveAttribute("alt", "dropped-photo.jpg");
    await expect(page.locator("#btn-send")).toBeEnabled();

    await switchToSession(page, "image-draft-next-session", "另一个图片任务");
    await expect(page.locator(".input-image-attachment")).toHaveCount(0);
    await expect(page.locator("#btn-send")).toBeDisabled();
    await switchToSession(page, "upload-session", "图片任务");
    await expect(page.locator(".input-image-attachment img")).toHaveAttribute("alt", "dropped-photo.jpg");
    await expect(page.locator(".input-image-attachment img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/u);
    await expect(page.locator("#btn-send")).toBeEnabled();
    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    expect(messages.some(message => message.type === "prompt" || message.type === "follow_up")).toBe(false);
    expect(messages.some(message => message.type === "stage_chat_document")).toBe(false);
  });

  test("removes a parsing attachment immediately and reclaims its late success", async ({ page }) => {
    await pasteFile(page, "late.py", "print('late')\n", "text/x-python");
    await expect(page.locator(".input-document-attachment")).toHaveClass(/is-parsing/);
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);

    await page.locator(".document-attachment-remove").click();
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    await expect(page.locator("#btn-send")).toBeDisabled();
    await page.evaluate(() => window.__resolveAttachmentStage());
    await page.waitForFunction(() => (
      window.__attachmentPortMessages.filter(message => message.type === "delete_chat_document").length >= 2
    ));

    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    const staged = messages.find(message => message.type === "stage_chat_document");
    const removals = messages.filter(message => message.type === "delete_chat_document");
    expect(removals).toHaveLength(2);
    for (const removal of removals) {
      expect(removal).toMatchObject({
        sessionId: staged.sessionId,
        messageId: staged.messageId,
        attachmentId: staged.attachmentId,
        fileId: staged.fileId,
        docModelId: staged.docModelId,
      });
    }
    expect(messages.some(message => message.type === "prompt" || message.type === "follow_up")).toBe(false);
  });

  test("settles a late parse result only into its original Session draft", async ({ page }) => {
    await pasteFile(page, "previous-session.docx", "not-a-real-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    const staged = await page.evaluate(() => (
      window.__attachmentPortMessages.find(message => message.type === "stage_chat_document")
    ));

    await switchToSession(page, "next-session", "下一个任务");
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    await page.evaluate(() => window.__resolveAttachmentStage());
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    await switchToSession(page, "upload-session", "原任务");
    await expect(page.locator(".input-document-attachment")).toHaveCount(1);
    await expect(page.locator(".input-document-attachment .document-attachment-meta")).toContainText("已解析");
    await expect(page.locator("#btn-send")).toBeEnabled();
    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    expect(messages.some(message => message.type === "delete_chat_document")).toBe(false);
    expect(staged.sessionId).toBe("upload-session");
    expect(messages.some(message => message.type === "prompt" || message.type === "follow_up")).toBe(false);
  });

  test("does not recreate a deleted Session draft when its parse settles late", async ({ page }) => {
    await pasteFile(page, "deleted-session.py", "print('deleted')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    const staged = await page.evaluate(() => (
      window.__attachmentPortMessages.find(message => message.type === "stage_chat_document")
    ));
    await switchToSession(page, "surviving-session", "保留任务");
    await page.evaluate(async () => {
      const documents = await import("/extension/shared/documents/document-store.js");
      window.__deleteComposerSession("upload-session");
      window.__emitAttachmentEvent({ type: "session_deleted", sessionId: "upload-session" });
      await window.__resolveAttachmentStage();
      await documents.deleteSessionMessageDocuments("upload-session");
    });

    const state = await page.evaluate(async input => {
      const documents = await import("/extension/shared/documents/document-store.js");
      await new Promise(resolve => setTimeout(resolve, 20));
      return {
        draft: window.__getComposerDraft("upload-session"),
        file: await documents.getDocumentFile(input.fileId),
        model: await documents.getDocumentModel(input.docModelId),
      };
    }, staged);
    expect(state).toEqual({
      draft: null,
      file: undefined,
      model: undefined,
    });
    const messages = await page.evaluate(() => window.__attachmentPortMessages);
    expect(messages.some(message => message.type === "delete_chat_document")).toBe(false);
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
  });

  test("does not save a parse error projection while Background is deleting the Session", async ({ page }) => {
    await pasteFile(page, "deleting-session.py", "print('deleting')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await page.evaluate(() => {
      window.__rejectAttachmentStage("对话已删除，文档解析已停止。", "SESSION_DELETED");
      window.__deleteComposerSession("upload-session");
      window.__emitAttachmentEvent({ type: "session_deleted", sessionId: "upload-session" });
    });
    await page.waitForTimeout(30);
    const draft = await page.evaluate(() => window.__getComposerDraft("upload-session"));
    expect(draft).toBeNull();
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
  });

  test("does not resurrect a parsing attachment removed after restoring its Session draft", async ({ page }) => {
    await pasteFile(page, "restored-then-removed.py", "print('remove me')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await switchToSession(page, "temporary-session", "临时任务");
    await switchToSession(page, "upload-session", "附件任务");
    await expect.poll(() => page.evaluate(() => window.__pendingAttachmentStages.length)).toBe(1);
    await page.locator(".document-attachment-remove").click();
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);

    await page.evaluate(() => {
      while (window.__pendingAttachmentStages.length) window.__resolveAttachmentStage();
    });
    await switchToSession(page, "temporary-session", "临时任务");
    await switchToSession(page, "upload-session", "附件任务");
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    await expect(page.locator("#btn-send")).toBeDisabled();
  });

  test("does not restart parsing on a Session switch or restore the sent draft", async ({ page }) => {
    await page.locator("#input").fill("只发送一次");
    await pasteFile(page, "sent-before-old-result.py", "print('once')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await switchToSession(page, "send-race-session", "临时任务");
    await switchToSession(page, "upload-session", "附件任务");
    await expect.poll(() => page.evaluate(() => window.__pendingAttachmentStages.length)).toBe(1);

    await page.evaluate(() => window.__resolveAttachmentStageAt(0));
    await expect(page.locator(".input-document-attachment")).toHaveClass(/is-ready/);
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => window.__attachmentPortMessages.some(message => message.type === "prompt"));
    await switchToSession(page, "send-race-session", "临时任务");
    await switchToSession(page, "upload-session", "附件任务");

    await expect(page.locator("#input")).toHaveValue("");
    await expect(page.locator(".input-document-attachment")).toHaveCount(0);
    const prompts = await page.evaluate(() => (
      window.__attachmentPortMessages.filter(message => message.type === "prompt")
    ));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe("只发送一次");
  });

  test("does not let an older parse projection overwrite newer restored text", async ({ page }) => {
    await page.locator("#input").fill("旧文本");
    await pasteFile(page, "stale-text.py", "print('stale')\n", "text/x-python");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await switchToSession(page, "text-race-session", "临时任务");
    await switchToSession(page, "upload-session", "附件任务");
    await expect.poll(() => page.evaluate(() => window.__pendingAttachmentStages.length)).toBe(1);
    await page.locator("#input").fill("用户后来输入的新文本");
    await page.waitForTimeout(300);
    const textBeforeOldResult = await page.evaluate(() => (
      window.__getComposerDraft("upload-session")?.text
    ));
    expect(textBeforeOldResult).toBe("用户后来输入的新文本");
    await page.evaluate(() => window.__resolveAttachmentStageAt(0));
    await expect(page.locator(".input-document-attachment")).toHaveClass(/is-ready/);
    await page.waitForTimeout(50);
    const persistedText = await page.evaluate(() => (
      window.__getComposerDraft("upload-session")?.text
    ));
    expect(persistedText).toBe("用户后来输入的新文本");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await switchToSession(page, "upload-session", "附件任务");

    await expect(page.locator("#input")).toHaveValue("用户后来输入的新文本");
    await expect(page.locator(".input-document-attachment")).toHaveCount(1);
  });

  test("keeps multiple parses on one message and waits for out-of-order completion", async ({ page }) => {
    await pasteFiles(page, [
      { filename: "first.py", content: "print('first')\n", mimeType: "text/x-python" },
      { filename: "second.cpp", content: "int main() {}\n", mimeType: "text/x-c++src" },
    ]);
    await expect(page.locator(".input-document-attachment")).toHaveCount(2);
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 2);

    await page.evaluate(() => window.__resolveAttachmentStageAt(1));
    await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(1);
    await expect(page.locator("#btn-send")).toBeDisabled();
    await page.evaluate(() => window.__resolveAttachmentStageAt(0));
    await expect(page.locator(".input-document-attachment.is-ready")).toHaveCount(2);
    await expect(page.locator("#btn-send")).toBeEnabled();
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => window.__attachmentPortMessages.some(message => message.type === "prompt"));

    const prompt = await page.evaluate(() => (
      window.__attachmentPortMessages.find(message => message.type === "prompt")
    ));
    expect(prompt.documents.map(document => document.filename)).toEqual(["first.py", "second.cpp"]);
    expect(new Set(prompt.documents.map(document => document.messageId)).size).toBe(1);
    expect(prompt.documents[0].messageId).toBe(prompt.clientMessageId);
    expect(new Set(prompt.documents.map(document => document.attachmentId)).size).toBe(2);
  });

  test("keeps send gated after parse failure until the failed attachment is removed", async ({ page }) => {
    await page.locator("#input").fill("仍然有文字");
    await pasteFile(page, "broken.pdf", "%PDF-broken", "application/pdf");
    await page.waitForFunction(() => window.__pendingAttachmentStages.length === 1);
    await page.evaluate(() => window.__rejectAttachmentStage("PDF 解析失败"));

    const card = page.locator(".input-document-attachment");
    await expect(card).toHaveClass(/is-error/);
    await expect(card.locator(".document-attachment-meta")).toHaveText("解析失败");
    await expect(card).toHaveAttribute("title", /PDF 解析失败/);
    await expect(page.locator("#btn-send")).toBeDisabled();

    await card.locator(".document-attachment-remove").click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("#btn-send")).toBeEnabled();
  });

  test("deletes only owned document records and keeps batch cleanup atomic", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const store = await import("/extension/shared/documents/document-store.js");
      const suffix = crypto.randomUUID();
      const owner = { sessionId: `owner_${suffix}`, messageId: `message_${suffix}` };

      async function seed({ sessionId, messageId, tag, modelFileId = "", sourceTool = "chat_attachment" }) {
        const attachmentId = `attachment_${tag}_${suffix}`;
        const fileId = `file_${tag}_${suffix}`;
        const docModelId = `model_${tag}_${suffix}`;
        await store.saveDocumentFile({
          id: fileId,
          filename: `${tag}.txt`,
          mimeType: "text/plain",
          extension: "txt",
          size: 1,
          base64: "eA==",
          sessionId,
          messageId,
          attachmentId,
          sourceTool,
        });
        await store.saveDocumentModel({
          id: docModelId,
          fileId: modelFileId || fileId,
          type: "txt",
          title: tag,
          blocks: [{ type: "paragraph", text: tag }],
          sessionId,
          messageId,
          attachmentId,
          sourceTool,
        });
        return {
          sessionId,
          messageId,
          attachmentId,
          fileId,
          docModelId,
          filename: `${tag}.txt`,
          mimeType: "text/plain",
          format: "txt",
          size: 1,
        };
      }

      const first = await seed({ ...owner, tag: "first" });
      const second = await seed({ ...owner, tag: "second" });
      const deleted = await store.deleteMessageDocuments({ ...owner, documents: [first, second] });
      const deletedAgain = await store.deleteMessageDocuments({ ...owner, documents: [first, second] });
      const successfulDeleteGone = !await store.getDocumentFile(first.fileId)
        && !await store.getDocumentModel(first.docModelId)
        && !await store.getDocumentFile(second.fileId)
        && !await store.getDocumentModel(second.docModelId);

      const kept = await seed({ ...owner, tag: "kept" });
      const foreign = await seed({
        sessionId: `foreign_${suffix}`,
        messageId: `foreign_message_${suffix}`,
        tag: "foreign",
      });
      const forgedForeignReference = { ...foreign, ...owner };
      let foreignError = "";
      try {
        await store.deleteMessageDocuments({
          ...owner,
          documents: [kept, forgedForeignReference],
        });
      } catch (error) {
        foreignError = error?.code || "";
      }
      const foreignBatchStayedAtomic = Boolean(
        await store.getDocumentFile(kept.fileId)
        && await store.getDocumentModel(kept.docModelId)
        && await store.getDocumentFile(foreign.fileId)
        && await store.getDocumentModel(foreign.docModelId),
      );

      const mismatched = await seed({
        ...owner,
        tag: "mismatched",
        modelFileId: `different_file_${suffix}`,
      });
      let linkError = "";
      try {
        await store.deleteMessageDocuments({ ...owner, documents: [mismatched] });
      } catch (error) {
        linkError = error?.code || "";
      }
      const mismatchedRecordsStayed = Boolean(
        await store.getDocumentFile(mismatched.fileId)
        && await store.getDocumentModel(mismatched.docModelId),
      );
      const sessionOwner = {
        sessionId: `delete_session_${suffix}`,
        messageId: `delete_session_message_${suffix}`,
      };
      const sessionDocument = await seed({ ...sessionOwner, tag: "session-owned" });
      const nonChatDocument = await seed({
        ...sessionOwner,
        tag: "non-chat",
        sourceTool: "skill_document",
      });
      const sessionDeleted = await store.deleteSessionMessageDocuments(sessionOwner.sessionId);
      const sessionDeleteScoped = Boolean(
        !await store.getDocumentFile(sessionDocument.fileId)
        && !await store.getDocumentModel(sessionDocument.docModelId)
        && await store.getDocumentFile(nonChatDocument.fileId)
        && await store.getDocumentModel(nonChatDocument.docModelId),
      );

      return {
        deleted,
        deletedAgain,
        successfulDeleteGone,
        foreignError,
        foreignBatchStayedAtomic,
        linkError,
        mismatchedRecordsStayed,
        sessionDeleted,
        sessionDeleteScoped,
      };
    });

    expect(result).toEqual({
      deleted: { deletedFileCount: 2, deletedModelCount: 2 },
      deletedAgain: { deletedFileCount: 0, deletedModelCount: 0 },
      successfulDeleteGone: true,
      foreignError: "DOCUMENT_ATTACHMENT_OWNER_MISMATCH",
      foreignBatchStayedAtomic: true,
      linkError: "DOCUMENT_ATTACHMENT_OWNER_MISMATCH",
      mismatchedRecordsStayed: true,
      sessionDeleted: { deletedFileCount: 1, deletedModelCount: 1 },
      sessionDeleteScoped: true,
    });
  });

  test("opens a newer document database without attempting to downgrade it", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const dbName = "qz-browser-agent-documents";
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("files")) {
            const files = db.createObjectStore("files", { keyPath: "id" });
            files.createIndex("updatedAt", "updatedAt", { unique: false });
          }
          if (!db.objectStoreNames.contains("models")) {
            const models = db.createObjectStore("models", { keyPath: "id" });
            models.createIndex("fileId", "fileId", { unique: false });
            models.createIndex("updatedAt", "updatedAt", { unique: false });
          }
          if (!db.objectStoreNames.contains("artifacts")) {
            const artifacts = db.createObjectStore("artifacts", { keyPath: "id" });
            artifacts.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });

      const store = await import(`/extension/shared/documents/document-store.js?newer-db=${Date.now()}`);
      const owner = {
        sessionId: "newer-db-session",
        messageId: "newer-db-message",
        attachmentId: "newer-db-attachment",
        fileId: "newer-db-file",
        docModelId: "newer-db-model",
      };
      await store.saveDocumentFile({
        id: owner.fileId,
        filename: "newer-db.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: "xlsx",
        size: 1,
        base64: "eA==",
        ...owner,
        sourceTool: "chat_attachment",
      });
      await store.saveDocumentModel({
        id: owner.docModelId,
        fileId: owner.fileId,
        type: "xlsx",
        title: "newer db",
        ...owner,
        sourceTool: "chat_attachment",
      });
      const removed = await store.deleteMessageDocument(owner);
      const version = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          const current = request.result.version;
          request.result.close();
          resolve(current);
        };
        request.onerror = () => reject(request.error);
      });
      return {
        version,
        removed,
        file: await store.getDocumentFile(owner.fileId),
        model: await store.getDocumentModel(owner.docModelId),
      };
    });

    expect(result).toEqual({
      version: 3,
      removed: { deletedFile: true, deletedModel: true },
      file: undefined,
      model: undefined,
    });
  });

  test("renders the sent file as a compact token-based message card", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: "rendered-document-session",
      title: "文档消息",
      transcript: [{
        type: "user",
        text: "请检查这份代码",
        clientMessageId: "rendered-document-message",
        documents: [{
          sessionId: "rendered-document-session",
          messageId: "rendered-document-message",
          attachmentId: "rendered-document-attachment",
          fileId: "rendered-document-file",
          docModelId: "rendered-document-model",
          filename: "a-very-long-file-name-that-must-not-stretch-the-message-card.cpp",
          mimeType: "text/x-c++src",
          format: "code",
          size: 2048,
        }],
      }],
    }));

    const card = page.locator(".msg-user .document-attachment-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".document-attachment-type")).toHaveText("CPP");
    await expect(card.locator(".document-attachment-meta")).toHaveText("已解析 · 2 KB");
    await expect(card.locator("button")).toHaveCount(0);
    const layout = await card.evaluate(node => {
      const name = node.querySelector(".document-attachment-name");
      const type = node.querySelector(".document-attachment-type");
      return {
        width: node.getBoundingClientRect().width,
        overflow: name.scrollWidth > name.clientWidth,
        background: getComputedStyle(node).backgroundColor,
        typeBackground: getComputedStyle(type).backgroundColor,
        border: getComputedStyle(node).borderColor,
        separatorWidth: getComputedStyle(type).borderRightWidth,
      };
    });
    expect(layout.width).toBeCloseTo(168, 0);
    expect(layout.overflow).toBe(true);
    expect(layout.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(layout.typeBackground).not.toBe(layout.background);
    expect(layout.border).not.toBe("rgba(0, 0, 0, 0)");
    expect(layout.separatorWidth).toBe("0px");

    await page.emulateMedia({ colorScheme: "light" });
    const lightLayout = await card.evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      typeBackground: getComputedStyle(node.querySelector(".document-attachment-type")).backgroundColor,
      separatorWidth: getComputedStyle(node.querySelector(".document-attachment-type")).borderRightWidth,
    }));
    expect(lightLayout.typeBackground).not.toBe(lightLayout.background);
    expect(lightLayout.separatorWidth).toBe("0px");
  });
});

async function readDropCue(page) {
  return page.locator(".input-wrapper").evaluate(node => ({
    background: getComputedStyle(node).backgroundColor,
    boxShadow: getComputedStyle(node).boxShadow,
  }));
}

async function switchToSession(page, sessionId, title) {
  await page.evaluate(async ({ sessionId: id, title: sessionTitle }) => {
    await window.qingzhouConversationBenchmark.seedSession({
      sessionId: id,
      title: sessionTitle,
      transcript: [],
    });
    await window.qingzhouConversationBenchmark.switchToSession(id, { source: "benchmark" });
  }, { sessionId, title });
}

async function pasteFile(page, filename, content, mimeType) {
  return pasteFiles(page, [{ filename, content, mimeType }]);
}

async function pasteFiles(page, files) {
  await page.locator("#input").evaluate((target, values) => {
    const transfer = new DataTransfer();
    for (const file of values) {
      transfer.items.add(new File([file.content], file.filename, { type: file.mimeType }));
    }
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, files);
}

function installAttachmentChromeStub() {
  const storageKey = "__qingzhou_test_chrome_storage__";
  let storage = { qz_data_consent: { version: 1, acceptedAt: 1 } };
  try { storage = { ...storage, ...JSON.parse(localStorage.getItem(storageKey) || "{}") }; } catch (_error) {}
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const ports = [];
  const draftStorageKey = "__qingzhou_test_composer_drafts__";
  window.__QZ_CONVERSATION_BENCHMARK__ = true;
  window.__attachmentPortMessages = [];
  window.__pendingAttachmentStages = [];
  window.__pendingSessionCreations = [];
  window.__attachmentWindowAttached = false;
  window.__deletedComposerSessions = new Set();
  window.__deferSessionCreation = false;

  const readDrafts = () => {
    try { return JSON.parse(localStorage.getItem(draftStorageKey) || "{}"); } catch (_error) { return {}; }
  };
  const writeDrafts = drafts => localStorage.setItem(draftStorageKey, JSON.stringify(drafts));
  const writeStorage = () => localStorage.setItem(storageKey, JSON.stringify(storage));
  const draftKey = sessionId => `73::${String(sessionId || "")}`;
  const ensureStoredSession = sessionId => {
    if (!sessionId) return;
    storage._sessions ||= {};
    storage._sessions[sessionId] ||= {
      id: sessionId,
      title: "附件任务",
      parentSessionId: "0",
      createdAt: "2026-01-01 00:00:00",
      updatedAt: "2026-01-01 00:00:00",
    };
    writeStorage();
  };
  const getDraft = sessionId => clone(readDrafts()[draftKey(sessionId)] || null);
  const saveDraft = (sessionId, value = {}) => {
    if (window.__deletedComposerSessions.has(sessionId)) return null;
    const drafts = readDrafts();
    const key = draftKey(sessionId);
    const current = drafts[key];
    const draft = { ...clone(value), sessionId };
    if (current && Number(current.updatedAt) > Number(draft.updatedAt)) return clone(current);
    if (draft.text || draft.images?.length || draft.documents?.length) drafts[key] = draft;
    else delete drafts[key];
    writeDrafts(drafts);
    return clone(drafts[key] || null);
  };
  const consumeDraft = (sessionId, messageId) => {
    const drafts = readDrafts();
    const key = draftKey(sessionId);
    if (drafts[key]?.messageId !== messageId) return false;
    delete drafts[key];
    writeDrafts(drafts);
    return true;
  };
  window.__getComposerDraft = getDraft;
  window.__seedComposerDraft = (sessionId, draft) => {
    ensureStoredSession(sessionId);
    storage["qingzhou:workspace-view:73"] = { v: 1, page: "chat", sessionId };
    writeStorage();
    return saveDraft(sessionId, draft);
  };
  window.__deleteComposerSession = sessionId => {
    window.__deletedComposerSessions.add(sessionId);
    const drafts = readDrafts();
    delete drafts[draftKey(sessionId)];
    writeDrafts(drafts);
  };
  window.__resolveSessionCreation = () => {
    const pending = window.__pendingSessionCreations.shift();
    if (!pending) return false;
    queueMicrotask(() => pending.respond(pending.result));
    return true;
  };

  function eventTarget() {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      emit(value) { [...listeners].forEach(listener => listener(value)); },
    };
  }

  function connect() {
    const onMessage = eventTarget();
    const onDisconnect = eventTarget();
    const port = {
      onMessage,
      onDisconnect,
      postMessage(message) {
        window.__attachmentPortMessages.push(clone(message));
        if (message.type === "sync_composer_draft") {
          const draft = saveDraft(message.sessionId, message.draft);
          window.__lastDraftPersistence = Promise.resolve(draft);
          if (message.requestId) queueMicrotask(() => onMessage.emit({
            type: "sync_composer_draft_result",
            requestId: message.requestId,
            sessionId: message.sessionId,
            draft,
          }));
          return;
        }
        if (message.type === "get_composer_draft") {
          queueMicrotask(() => onMessage.emit({
            type: "get_composer_draft_result",
            requestId: message.requestId,
            sessionId: message.sessionId,
            draft: getDraft(message.sessionId),
          }));
          return;
        }
        if (message.type === "prompt" || message.type === "follow_up") {
          if (message.composerDraft) saveDraft(message.sessionId, {
            ...message.composerDraft,
            messageId: message.clientMessageId,
          });
          if (!window.__deferDraftAcceptance) consumeDraft(message.sessionId, message.clientMessageId);
          window.__lastDraftPersistence = Promise.resolve();
          if (message.type === "prompt" && message.requestId && !window.__deferDraftAcceptance) {
            queueMicrotask(() => onMessage.emit({
              type: "prompt_accepted",
              requestId: message.requestId,
              accepted: true,
              sessionId: message.sessionId,
              clientMessageId: message.clientMessageId,
            }));
          }
        }
        if (!message.requestId) return;
        if (message.type === "sidepanel_attach") {
          queueMicrotask(() => onMessage.emit({
            type: "sidepanel_attached",
            requestId: message.requestId,
            windowId: message.windowId,
          }));
          return;
        }
        if (message.type === "create_ui_session") {
          const sessionId = window.__deferSessionCreation
            ? String(message.id || "upload-session")
            : "upload-session";
          ensureStoredSession(sessionId);
          if (message.composerDraft) saveDraft(sessionId, message.composerDraft);
          const result = {
            type: "create_ui_session_result",
            requestId: message.requestId,
            session: { id: sessionId, title: message.title || message.firstMessage || "附件" },
          };
          if (window.__deferSessionCreation) {
            window.__pendingSessionCreations.push({ respond: onMessage.emit, result });
          } else {
            queueMicrotask(() => onMessage.emit(result));
          }
          return;
        }
        if (message.type === "stage_chat_document") {
          window.__pendingAttachmentStages.push({ message: clone(message), respond: onMessage.emit });
          return;
        }
        if (message.type === "delete_chat_document") {
          import("/extension/shared/documents/document-store.js")
            .then(store => store.deleteMessageDocument(message))
            .catch(() => null)
            .then(() => onMessage.emit({
              type: "chat_document_deleted",
              requestId: message.requestId,
              removed: true,
            }));
        }
      },
      disconnect() { onDisconnect.emit(); },
    };
    ports.push(port);
    return port;
  }

  window.__resolveAttachmentStageAt = async (index = 0) => {
    const normalizedIndex = Math.max(0, Math.min(window.__pendingAttachmentStages.length - 1, Number(index) || 0));
    const [pending] = window.__pendingAttachmentStages.splice(normalizedIndex, 1);
    if (!pending) return false;
    const { message } = pending;
    const store = await import("/extension/shared/documents/document-store.js");
    await Promise.all([
      store.saveDocumentFile({
        id: message.fileId,
        filename: message.filename,
        mimeType: message.mimeType,
        size: message.size,
        sessionId: message.sessionId,
        messageId: message.messageId,
        attachmentId: message.attachmentId,
        sourceTool: "chat_attachment",
      }),
      store.saveDocumentModel({
        id: message.docModelId,
        fileId: message.fileId,
        type: "code",
        sessionId: message.sessionId,
        messageId: message.messageId,
        attachmentId: message.attachmentId,
        sourceTool: "chat_attachment",
      }),
    ]);
    pending.respond({
      type: "chat_document_staged",
      requestId: message.requestId,
      document: {
        sessionId: message.sessionId,
        messageId: message.messageId,
        attachmentId: message.attachmentId,
        fileId: message.fileId,
        docModelId: message.docModelId,
        filename: message.filename,
        mimeType: message.mimeType,
        format: "code",
        size: message.size,
      },
    });
    return true;
  };
  window.__resolveAttachmentStage = () => window.__resolveAttachmentStageAt(0);
  window.__emitAttachmentEvent = value => {
    for (const port of ports) port.onMessage.emit(clone(value));
  };

  window.__rejectAttachmentStage = (message = "解析失败", code = "DOCUMENT_PARSE_FAILED") => {
    const pending = window.__pendingAttachmentStages.shift();
    if (!pending) return false;
    pending.respond({
      type: "error",
      requestId: pending.message.requestId,
      code,
      message,
    });
    return true;
  };

  const storageArea = {
    async get(keys) {
      if (keys == null) return clone(storage);
      if (typeof keys === "string") return { [keys]: clone(storage[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, clone(storage[key])]));
      return Object.fromEntries(Object.entries(keys || {}).map(([key, fallback]) => [
        key,
        storage[key] === undefined ? clone(fallback) : clone(storage[key]),
      ]));
    },
    async set(values = {}) {
      Object.assign(storage, clone(values));
      writeStorage();
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      writeStorage();
    },
    async clear() {
      storage = {};
      writeStorage();
    },
  };

  window.chrome = {
    runtime: { connect },
    windows: {
      async getCurrent() {
        const delay = Math.max(
          0,
          Number(new URL(location.href).searchParams.get("draftWindowDelay")) || 20,
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        window.__attachmentWindowAttached = true;
        return { id: 73 };
      },
    },
    storage: {
      local: storageArea,
      session: storageArea,
      onChanged: { addListener() {} },
    },
    downloads: { async download() { return 1; }, async search() { return []; }, open() {}, show() {} },
    tabs: { async create() { return { id: 1 }; }, async query() { return []; } },
    desktopCapture: { chooseDesktopMedia() { return null; } },
  };
}

import { expect, test } from './fixtures.mjs';
import { installBenchmarkChromeStub } from './benchmark-chrome-stub.mjs';

for (const colorScheme of ['light', 'dark']) {
  test.describe(`queued admission presentation · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 720 } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript({ content: `(${installBenchmarkChromeStub})({}); (${installAdmissionGate})();` });
      await page.goto('/extension/sidepanel/sidepanel.html', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    });

    for (const kind of ['image', 'document', 'mixed', 'text']) {
      test(`${kind} waits in the queue without ever creating a temporary transcript bubble`, async ({ page }) => {
        await seedDraft(page, kind);
        await page.evaluate(() => window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
          type: 'agent_start', sessionId: 'admission', runId: 'benchmark-visual-run', eventSeq: 1,
        }));
        await page.locator('#btn-send').click();
        await page.waitForFunction(() => window.__admission.requests.length === 1);
        await page.waitForTimeout(350);
        expect(await page.evaluate(() => window.__admission.probe.bubbleObservations)).toBe(0);
        const row = page.locator('#queued-followups [data-client-message-id="draft-queued"]');
        await expect(row).toBeVisible();
        await expect(row.locator('.queued-followup-delete')).toBeDisabled();
        await expect(row.locator('[data-steer-follow-up]')).toBeDisabled();
        await expect(row.locator('.queued-followup-drag')).toHaveAttribute('draggable', 'false');

        await page.evaluate(() => window.__admission.accept('queued'));
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => window.__admission.probe.bubbleObservations)).toBe(0);
        await expect(row).toBeVisible();
        await expect(row.locator('.queued-followup-delete')).toBeEnabled();
        await expect(row.locator('[data-steer-follow-up]')).toBeEnabled();
        await expect(row.locator('.queued-followup-drag')).toHaveAttribute('draggable', 'true');
        const sent = await page.evaluate(() => window.__admission.requests[0]);
        expect(sent.images).toHaveLength(Number(['image', 'mixed'].includes(kind)));
        expect(sent.documents).toHaveLength(Number(['document', 'mixed'].includes(kind)));
        expect(sent.clientMessageId).toBe('draft-queued');
        if (sent.documents.length) {
          expect(await page.evaluate(async ref => (await window.__admission.store.getDocumentFile(ref.fileId)).base64, sent.documents[0])).toBe(btoa('attachment source'));
        }
        await acceptUserMessage(page, sent);
        await expect(page.locator('#messages .msg-user[data-client-message-id="draft-queued"]')).toHaveCount(1);
        await expect(row).toHaveCount(0);
      });
    }

    test('failed admission keeps all attachments and retries with the same identity', async ({ page }) => {
      await seedDraft(page, 'mixed');
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => window.__admission.requests.length === 1);
      await page.evaluate(() => window.__admission.fail());
      const bubble = page.locator('#messages .msg-user[data-client-message-id="draft-queued"]');
      await expect(bubble.locator('[data-action="retry-user-message"]')).toBeVisible();
      await expect(bubble.locator('.msg-images img')).toHaveCount(1);
      await expect(bubble).toContainText('notes.txt');
      await expect(page.locator('#queued-followups .queued-followup')).toHaveCount(0);
      await bubble.locator('[data-action="retry-user-message"]').click();
      await page.waitForFunction(() => window.__admission.requests.length === 2);
      await expect(bubble).toHaveCount(0);
      await expect(page.locator('#queued-followups .queued-followup')).toHaveCount(1);
      const sent = await page.evaluate(() => window.__admission.requests);
      expect(sent[1].clientMessageId).toBe(sent[0].clientMessageId);
      expect(sent[1].images).toEqual(sent[0].images);
      expect(sent[1].documents).toEqual(sent[0].documents);
      await page.evaluate(() => window.__admission.accept('queued'));
      await expect(bubble).toHaveCount(0);
      await expect(page.locator('#queued-followups .queued-followup-delete')).toBeEnabled();
    });

    test('a run ending before admission does not expose the bubble until Background starts it', async ({ page }) => {
      await seedDraft(page, 'mixed');
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => window.__admission.requests.length === 1);
      await page.evaluate(() => window.qingzhouConversationBenchmark.configureVisualState({ running: false }));
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.__admission.probe.bubbleObservations)).toBe(0);
      await page.evaluate(() => window.__admission.accept('started'));
      const bubble = page.locator('#messages .msg-user[data-client-message-id="draft-queued"]');
      await expect(bubble).toHaveCount(1);
      await expect(bubble.locator('.msg-images img')).toHaveCount(1);
      await expect(bubble).toContainText('notes.txt');
      await expect(page.locator('#queued-followups .queued-followup')).toHaveCount(0);
    });

    test('switching sessions before acknowledgement keeps provisional rows in their source Session', async ({ page }) => {
      await seedDraft(page, 'mixed');
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => window.__admission.requests.length === 1);
      await page.evaluate(async () => {
        await window.qingzhouConversationBenchmark.seedSession({ sessionId: 'other', title: 'other', transcript: [] });
        await window.qingzhouConversationBenchmark.switchToSession('other', { source: 'benchmark' });
      });
      await page.locator('#input').fill('保留另一个会话的草稿');
      await expect(page.locator('#queued-followups .queued-followup')).toHaveCount(0);
      await page.evaluate(() => window.__admission.accept('queued'));
      await expect(page.locator('#input')).toHaveValue('保留另一个会话的草稿');
      await expect(page.locator('#messages .msg-user')).toHaveCount(0);
      await page.evaluate(() => window.qingzhouConversationBenchmark.switchToSession('admission', { source: 'benchmark' }));
      await expect(page.locator('#queued-followups [data-client-message-id="draft-queued"]')).toHaveCount(1);
      await expect(page.locator('#messages .msg-user')).toHaveCount(0);
    });

    test('an accepted user event before the queued acknowledgement stays visible exactly once', async ({ page }) => {
      await seedDraft(page, 'mixed');
      await page.locator('#btn-send').click();
      await page.waitForFunction(() => window.__admission.requests.length === 1);
      const sent = await page.evaluate(() => window.__admission.requests[0]);
      await acceptUserMessage(page, sent);
      const bubble = page.locator('#messages .msg-user[data-client-message-id="draft-queued"]');
      await expect(bubble).toHaveCount(1);
      await expect(page.locator('#queued-followups .queued-followup')).toHaveCount(0);
      await page.evaluate(() => {
        const message = window.__admission.requests[0];
        window.__qzEmitPortMessage({ type: 'prompt_accepted', requestId: message.requestId, sessionId: message.sessionId,
          clientMessageId: message.clientMessageId, accepted: true, disposition: 'queued' });
      });
      await page.waitForTimeout(200);
      await expect(bubble).toHaveCount(1);
      await expect(bubble).toContainText('notes.txt');
    });
  });
}

async function seedDraft(page, kind, { running = true } = {}) {
  await page.evaluate(async ({ kind, running }) => {
    const store = await import('/extension/shared/documents/document-store.js');
    const state = window.__admission;
    state.store = store;
    const images = [], documents = [];
    if (['image', 'mixed'].includes(kind)) {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 160;
      canvas.getContext('2d').fillRect(0, 0, 200, 160);
      images.push({ attachmentId: 'queued-image', dataUrl: canvas.toDataURL(), name: 'sample.png', type: 'image/png' });
    }
    if (['document', 'mixed'].includes(kind)) {
      const ref = { sessionId: 'admission', messageId: 'draft-queued', attachmentId: 'queued-document',
        fileId: 'queued-file', docModelId: 'queued-model', filename: 'notes.txt', mimeType: 'text/plain', format: 'txt', size: 17 };
      await store.saveDocumentFile({ ...ref, id: ref.fileId, sourceTool: 'chat_attachment', base64: btoa('attachment source') });
      await store.saveDocumentModel({ ...ref, id: ref.docModelId, sourceTool: 'chat_attachment', type: 'txt', blocks: [{ type: 'paragraph', text: 'attachment source' }] });
      documents.push({ ...ref, document: ref, status: 'ready' });
    }
    state.drafts.admission = { sessionId: 'admission', messageId: 'draft-queued', text: '稍后检查这条消息', images, documents, updatedAt: Date.now() };
    await window.qingzhouConversationBenchmark.seedSession({ sessionId: 'admission', title: 'queue admission',
      transcript: [{ type: 'assistant', content: '正在执行当前任务。' }] });
    await window.qingzhouConversationBenchmark.switchToSession('admission', { source: 'benchmark' });
    window.qingzhouConversationBenchmark.configureVisualState({ running });
    state.probe = { bubbleObservations: 0 };
    const observe = () => {
      if (document.querySelector('#messages .msg-user[data-client-message-id="draft-queued"]')) state.probe.bubbleObservations++;
    };
    state.observer = new MutationObserver(observe);
    state.observer.observe(document.querySelector('#messages'), { childList: true, subtree: true });
  }, { kind, running });
  await expect(page.locator('#input')).toHaveValue('稍后检查这条消息');
}

async function acceptUserMessage(page, sent) {
  await page.evaluate(sent => {
    window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: 'message_start', sessionId: sent.sessionId,
      runId: 'benchmark-visual-run', eventSeq: 2, clientMessageId: sent.clientMessageId, deliveryStatus: 'accepted',
      message: { role: 'user', clientMessageId: sent.clientMessageId, _origin: 'user', documents: sent.documents,
        content: sent.images.length ? [{ type: 'text', text: sent.text }, ...sent.images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }))] : sent.text } });
  }, sent);
}

function installAdmissionGate() {
  const state = window.__admission = { requests: [], drafts: {}, releases: [] };
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args), post = port.postMessage.bind(port);
    port.postMessage = message => {
      if (message.type === 'get_composer_draft' && state.drafts[message.sessionId]) {
        queueMicrotask(() => window.__qzEmitPortMessage({ type: 'get_composer_draft_result', requestId: message.requestId,
          sessionId: message.sessionId, draft: structuredClone(state.drafts[message.sessionId]) }));
        return;
      }
      if (message.type !== 'prompt') return post(message);
      state.requests.push(structuredClone(message));
      state.releases.push(() => post(message));
    };
    return port;
  };
  state.accept = disposition => {
    window.__qzPromptAcceptance = { disposition };
    state.releases.shift()();
  };
  state.fail = () => {
    const message = state.requests.at(-1);
    state.releases.shift();
    window.__qzEmitPortMessage({ type: 'error', requestId: message.requestId, code: 'PERSIST_FAILED', message: 'admission persistence failed' });
  };
}

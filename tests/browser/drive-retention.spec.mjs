import { test, expect } from './fixtures.mjs';
import { callTool } from '../../services/mcp-bridge/src/client.mjs';

test('drive retention removes old Session stores and owned documents without touching normal or global data', async () => {
  test.setTimeout(180_000);
  const { launchIsolatedExtensionMcp } = await import('../support/isolated-extension-mcp.mjs');
  const environment = await launchIsolatedExtensionMcp({ profilePrefix: 'qz-drive-retention-' });
  try {
    const assets = await environment.page.evaluate(async () => {
      const docs = await import(chrome.runtime.getURL('shared/documents/document-store.js'));
      const images = await import(chrome.runtime.getURL('shared/asset-store.js'));
      const data = await import(chrome.runtime.getURL('shared/data-store.js'));
      const ledger = await import(chrome.runtime.getURL('shared/session/session-resource-ledger.js'));
      const codec = await import(chrome.runtime.getURL('shared/session/session-codec.js'));
      const sessions = Object.fromEntries(Array.from({ length: 201 }, (_, i) => {
        const id = `old-${String(i).padStart(3, '0')}`;
        return [id, { id, title: 'Old drive task', source: 'external-drive', parentSessionId: '0',
          createdAt: '2020-01-01 00:00:00', updatedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString().slice(0, 19).replace('T', ' ') }];
      }));
      sessions.normal = { id: 'normal', title: 'Preserved manual task', source: '', parentSessionId: '0', updatedAt: '2000-01-01 00:00:00' };
      await chrome.storage.local.set({ _sessions: sessions });
      for (const sessionId of ['old-000', 'normal']) {
        for (const sourceTool of ['chat_attachment', 'document_fetch']) {
          await docs.saveDocumentFile({ id: `${sessionId}-${sourceTool}`, sessionId, sourceTool, filename: 'fixture.txt', base64: 'Zml4dHVyZQ==' });
        }
        await docs.saveDocumentModel({ id: `${sessionId}-model`, sessionId, sourceTool: 'document_parse', title: 'Fixture' });
        await docs.saveDocumentArtifact({ id: `${sessionId}-artifact`, sessionId, sourceTool: 'document_create', filename: 'fixture.txt', base64: 'Zml4dHVyZQ==' });
        await ledger.appendSessionResourceArtifacts({ sessionId, artifacts: [{ type: 'file', fileId: `${sessionId}-document_fetch`, filename: 'fixture.txt' }] });
      }
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const urls = ['red', 'blue', 'green'].map(color => { canvas.getContext('2d').fillStyle = color; canvas.getContext('2d').fillRect(0, 0, 1, 1); return canvas.toDataURL(); });
      const [oldImage, normalImage, sharedImage] = await Promise.all(urls.map(images.saveHistoryImage));
      const gallery = await images.saveImageAsset({ dataUrl: urls[0] });
      await data.insertDataRows('global-kept', [{ assetId: gallery.assetId, value: 'Independent shared data' }]);
      const oldRecord = codec.createSessionRecord(null, [{ type: 'tool', toolCallId: 'old', name: 'screenshot', result: { oldImage, sharedImage } }]);
      const normalRecord = codec.createSessionRecord(null, [{ type: 'tool', toolCallId: 'normal', name: 'screenshot', result: { normalImage, sharedImage } }]);
      await chrome.storage.local.set({
        '_session_old-000': oldRecord,
        '_active_conversation_old-000': codec.serializeConversation([{ role: 'user', content: 'old' }]),
        '_session_transcript_checkpoint_old-000': { version: 2, baseRevision: 'old', transcript: [] },
        '_session_runtime_old-000': { sessionId: 'old-000', status: 'idle' },
        '_session_import_dedup_old-000': { old: true },
        _session_runtime: { 'old-000': { sessionId: 'old-000' }, normal: { sessionId: 'normal', status: 'idle' } },
        _session_normal: normalRecord,
        _session_tab_groups: { 'drive:old-000': { windows: {} } },
      });
      return { oldImage, normalImage, sharedImage, galleryId: gallery.assetId };
    });
    const { sessionId } = await callTool(environment.bridge.endpoint, 'qingzhou_create_drive_session', { title: 'Drive retention regression' });
    await expect.poll(() => environment.page.evaluate(async () => Object.values((await chrome.storage.local.get('_sessions'))._sessions)
      .filter(record => record.source === 'external-drive').length)).toBe(200);
    const remaining = await environment.page.evaluate(async assets => {
      const docs = await import(chrome.runtime.getURL('shared/documents/document-store.js'));
      const images = await import(chrome.runtime.getURL('shared/asset-store.js'));
      const data = await import(chrome.runtime.getURL('shared/data-store.js'));
      const ledger = await import(chrome.runtime.getURL('shared/session/session-resource-ledger.js'));
      const stored = await chrome.storage.local.get(null);
      return {
        sessions: stored._sessions,
        oldKeys: Object.keys(stored).filter(key => key.endsWith('old-000')),
        legacy: stored._session_runtime,
        normalRecord: stored._session_normal,
        oldDocuments: await Promise.all([docs.getDocumentFile('old-000-chat_attachment'), docs.getDocumentFile('old-000-document_fetch'), docs.getDocumentModel('old-000-model'), docs.getDocumentArtifact('old-000-artifact')]),
        normalDocuments: await Promise.all([docs.getDocumentFile('normal-chat_attachment'), docs.getDocumentFile('normal-document_fetch'), docs.getDocumentModel('normal-model'), docs.getDocumentArtifact('normal-artifact')]),
        oldLedger: await ledger.listSessionResourceArtifacts('old-000'), normalLedger: await ledger.listSessionResourceArtifacts('normal'),
        oldImage: await images.getHistoryImage(assets.oldImage), normalImage: await images.getHistoryImage(assets.normalImage), sharedImage: await images.getHistoryImage(assets.sharedImage),
        gallery: await images.getImageAssetDataUrl(assets.galleryId), globalRows: await data.queryDataRows({ table: 'global-kept' }),
        oldGroup: stored._session_tab_groups?.['drive:old-000'],
      };
    }, assets);
    expect(Object.values(remaining.sessions).filter(record => record.source === 'external-drive')).toHaveLength(200);
    expect(remaining.sessions[sessionId]).toBeTruthy();
    expect(remaining.sessions['old-000']).toBeUndefined();
    expect(remaining.sessions['old-001']).toBeUndefined();
    expect(remaining.sessions.normal.title).toBe('Preserved manual task');
    expect(remaining.oldKeys).toEqual([]);
    expect(remaining.legacy).toEqual({ normal: { sessionId: 'normal', status: 'idle' } });
    expect(remaining.normalRecord).toBeTruthy();
    expect(remaining.oldDocuments.every(record => record == null)).toBe(true);
    expect(remaining.normalDocuments.every(Boolean)).toBe(true);
    expect(remaining.oldLedger).toEqual([]);
    expect(remaining.normalLedger).toHaveLength(1);
    expect(remaining.oldImage).toBeNull();
    expect(remaining.normalImage).toContain('data:image/png');
    expect(remaining.sharedImage).toContain('data:image/png');
    expect(remaining.gallery).toBeTruthy();
    expect(remaining.globalRows.totalMatched).toBe(1);
    expect(remaining.oldGroup).toBeUndefined();
    await environment.page.locator('[data-tab="sessions"]').click();
    await environment.page.locator('[data-sessions-mode="external-drive"]').click();
    await expect(environment.page.locator('#sessions-list .session-card')).toHaveCount(200);
  } finally { await environment.close(); }
});

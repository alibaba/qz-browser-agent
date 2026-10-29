import { t } from "../../shared/i18n/backend.js";
import {
  assertMessageDocumentOwnership,
  normalizeMessageDocument,
  documentAttachmentKey,
} from "../../shared/documents/document-attachments.js";
import {
  copyMessageDocuments,
  deleteMessageDocument,
  deleteMessageDocuments,
  deleteSessionMessageDocuments,
  saveDocumentFile,
  saveDocumentModel,
} from "../../shared/documents/document-store.js";
import { base64ToBytes } from "../../shared/bytes.js";
import { inferDocumentFormat, parseDocumentBytes } from "../../shared/documents/document-codecs.js";
import { formatTraceFields } from "../trace.js";

import type { MessageDocument } from "../../shared/documents/document-attachments.js";
type Fields = Record<string, unknown>;
interface AttachmentServiceOptions {
  sessionRepository: { getMetadata(sessionId: string): Promise<unknown> };
  parseDocumentBytes?: typeof parseDocumentBytes;
  saveDocumentFile?: typeof saveDocumentFile; saveDocumentModel?: typeof saveDocumentModel;
  deleteMessageDocument?: typeof deleteMessageDocument; deleteMessageDocuments?: typeof deleteMessageDocuments;
  deleteSessionMessageDocuments?: typeof deleteSessionMessageDocuments;
  base64ToBytes?: typeof base64ToBytes;
  trace?(message: string): void;
}
interface StageResult { document: MessageDocument; warnings: string[] }
interface ActiveAttachment { sessionId: string; task: Promise<StageResult>; cancelled: boolean }
const record = (value: unknown): Fields => value && typeof value === "object" ? value as Fields : {};

const SOURCE_TOOL = "chat_attachment";

/** Upload/parse boundary for documents owned by one draft user message. */
export function createChatDocumentAttachmentService(options: AttachmentServiceOptions) {
  const sessionRepository = options.sessionRepository;
  const parse = options.parseDocumentBytes || parseDocumentBytes;
  const saveFile = options.saveDocumentFile || saveDocumentFile;
  const saveModel = options.saveDocumentModel || saveDocumentModel;
  const deleteDocument = options.deleteMessageDocument || deleteMessageDocument;
  const deleteDocuments = options.deleteMessageDocuments || deleteMessageDocuments;
  const deleteSessionDocuments = options.deleteSessionMessageDocuments || deleteSessionMessageDocuments;
  const decode = options.base64ToBytes || base64ToBytes;
  const trace = typeof options.trace === "function" ? options.trace : () => {};
  const blockedSessions = new Set<string>();
  const active = new Map<string, ActiveAttachment>();
  if (!sessionRepository?.getMetadata) throw new TypeError("sessionRepository is required");

  async function stage(input: Fields = {}) {
    const request = normalizeStageRequest(input);
    if (blockedSessions.has(request.sessionId)) throw serviceError(
      "SESSION_DELETED",
      `session was deleted: ${request.sessionId}`,
    );
    const key = documentAttachmentKey(request);
    const running = active.get(key)?.task;
    if (running) {
      recordAttachmentTrace(trace, "stage", "joined", input);
      return running;
    }
    const task = stageOwned(input, request, key);
    const entry = { sessionId: request.sessionId, task, cancelled: false };
    active.set(key, entry);
    try {
      return await task;
    } finally {
      if (active.get(key) === entry) active.delete(key);
    }
  }

  async function stageOwned(input: Fields, request: ReturnType<typeof normalizeStageRequest>, key: string): Promise<StageResult> {
    const startedAt = Date.now();
    let phase = "normalize";
    let fileSaved = false;
    let modelSaved = false;
    try {
      const format = inferDocumentFormat(request);
      recordAttachmentTrace(trace, "stage", "received", input, {
        format,
        elapsedMs: Date.now() - startedAt,
      });

      phase = "session_lookup";
      const session = await sessionRepository.getMetadata(request.sessionId);
      if (!session) throw serviceError("SESSION_NOT_FOUND", `session not found: ${request.sessionId}`);
      assertNotCancelled(key, request.sessionId);
      recordAttachmentTrace(trace, "stage", "session_validated", input, {
        elapsedMs: Date.now() - startedAt,
      });

      phase = "file_save";
      const file = await saveFile({
        id: request.fileId,
        filename: request.filename,
        mimeType: request.mimeType,
        extension: format,
        size: request.size,
        base64: request.base64,
        sessionId: request.sessionId,
        messageId: request.messageId,
        attachmentId: request.attachmentId,
        sourceTool: SOURCE_TOOL,
      });
      fileSaved = true;
      assertNotCancelled(key, request.sessionId);
      recordAttachmentTrace(trace, "stage", "file_saved", input, {
        format: file.extension || format,
        elapsedMs: Date.now() - startedAt,
      });

      phase = "decode";
      const bytes = decode(request.base64);
      assertNotCancelled(key, request.sessionId);
      recordAttachmentTrace(trace, "stage", "decoded", input, {
        bytes: Number(bytes?.byteLength) || 0,
        elapsedMs: Date.now() - startedAt,
      });

      phase = "parse";
      const parseStartedAt = Date.now();
      const parsed = await parse(bytes, {
        filename: request.filename,
        mimeType: request.mimeType,
      });
      assertNotCancelled(key, request.sessionId);
      recordAttachmentTrace(trace, "stage", "parsed", input, {
        type: parsed?.type || format,
        blocks: arrayLength(parsed?.blocks),
        sheets: arrayLength(parsed?.sheets),
        chunks: arrayLength(parsed?.chunks),
        warnings: arrayLength(parsed?.warnings),
        parseMs: Date.now() - parseStartedAt,
        elapsedMs: Date.now() - startedAt,
      });

      phase = "model_save";
      const model = await saveModel({
        ...parsed,
        id: request.docModelId,
        fileId: request.fileId,
        sessionId: request.sessionId,
        messageId: request.messageId,
        attachmentId: request.attachmentId,
        sourceTool: SOURCE_TOOL,
      });
      modelSaved = true;
      assertNotCancelled(key, request.sessionId);
      recordAttachmentTrace(trace, "stage", "model_saved", input, {
        type: model.type || parsed?.type || format,
        elapsedMs: Date.now() - startedAt,
      });

      phase = "reference";
      const document = normalizeMessageDocument({
        ...request,
        fileId: file.fileId,
        docModelId: model.docModelId,
        format: model.type || file.extension,
      });
      if (!document) throw serviceError("DOCUMENT_ATTACHMENT_INVALID", "failed to create document attachment reference");
      recordAttachmentTrace(trace, "stage", "ready", input, {
        type: document.format || model.type || format,
        warnings: arrayLength(model.warnings),
        elapsedMs: Date.now() - startedAt,
      });
      return { document, warnings: model.warnings || [] };
    } catch (error) {
      recordAttachmentTrace(trace, "stage", "failed", input, {
        at: phase,
        code: record(error).code || record(error).name || "ERROR",
        error: record(error).message || String(error),
        elapsedMs: Date.now() - startedAt,
      });
      if (fileSaved || modelSaved) {
        try {
          const cleanup = await removeStored(request);
          recordAttachmentTrace(trace, "stage", "cleanup_completed", input, {
            deletedFile: cleanup?.deletedFile === true,
            deletedModel: cleanup?.deletedModel === true,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (cleanupError) {
          recordAttachmentTrace(trace, "stage", "cleanup_failed", input, {
            code: record(cleanupError).code || record(cleanupError).name || "ERROR",
            error: record(cleanupError).message || String(cleanupError),
            elapsedMs: Date.now() - startedAt,
          });
        }
      }
      throw error;
    }
  }

  async function remove(input: Fields = {}) {
    const startedAt = Date.now();
    try {
      const request = normalizeDeleteRequest(input);
      const key = documentAttachmentKey(request);
      const entry = active.get(key);
      if (entry) entry.cancelled = true;
      recordAttachmentTrace(trace, "remove", "received", input);
      const result = await removeStored(request);
      recordAttachmentTrace(trace, "remove", "completed", input, {
        deletedFile: result?.deletedFile === true,
        deletedModel: result?.deletedModel === true,
        elapsedMs: Date.now() - startedAt,
      });
      return { removed: result.deletedFile || result.deletedModel, ...result };
    } catch (error) {
      recordAttachmentTrace(trace, "remove", "failed", input, {
        code: record(error).code || record(error).name || "ERROR",
        error: record(error).message || String(error),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async function removeMessageDocuments(input: Fields = {}) {
    const startedAt = Date.now();
    try {
      const sessionId = id(input.sessionId);
      const messageId = id(input.messageId || input.clientMessageId);
      const documents = assertMessageDocumentOwnership(input.documents, { sessionId, messageId });
      recordAttachmentTrace(trace, "remove_message", "received", { sessionId, messageId }, {
        attachments: documents.length,
      });
      if (!documents.length) {
        recordAttachmentTrace(trace, "remove_message", "completed", { sessionId, messageId }, {
          attachments: 0,
          elapsedMs: Date.now() - startedAt,
        });
        return { removed: false, attachmentCount: 0, deletedFileCount: 0, deletedModelCount: 0 };
      }
      const result = await deleteDocuments({ sessionId, messageId, documents });
      recordAttachmentTrace(trace, "remove_message", "completed", { sessionId, messageId }, {
        attachments: documents.length,
        deletedFiles: result?.deletedFileCount || 0,
        deletedModels: result?.deletedModelCount || 0,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        removed: result.deletedFileCount > 0 || result.deletedModelCount > 0,
        attachmentCount: documents.length,
        ...result,
      };
    } catch (error) {
      recordAttachmentTrace(trace, "remove_message", "failed", input, {
        code: record(error).code || record(error).name || "ERROR",
        error: record(error).message || String(error),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async function blockSession(sessionId: string) {
    const session = id(sessionId);
    if (!session) return () => {};
    blockedSessions.add(session);
    await Promise.allSettled([...active.values()]
      .filter(entry => entry.sessionId === session)
      .map(entry => entry.task));
    return () => blockedSessions.delete(session);
  }

  const removeSessionDocuments = (sessionId: string) => deleteSessionDocuments(id(sessionId));

  function removeStored(request: ReturnType<typeof normalizeDeleteRequest>) {
    return deleteDocument({
      sessionId: request.sessionId,
      messageId: request.messageId,
      attachmentId: request.attachmentId,
      fileId: request.fileId,
      docModelId: request.docModelId,
    });
  }

  function assertNotCancelled(key: string, sessionId: string) {
    const deleted = blockedSessions.has(sessionId);
    if (!deleted && !active.get(key)?.cancelled) return;
    throw serviceError(
      deleted ? "SESSION_DELETED" : "DOCUMENT_ATTACHMENT_REMOVED",
      deleted ? t("attachment.sessionDeleted") : t("attachment.removed"),
    );
  }

  return Object.freeze({ stage, remove, removeMessageDocuments, copyMessageDocuments, removeSessionDocuments, blockSession });
}

function normalizeStageRequest(input: Fields = {}) {
  const request = normalizeDeleteRequest(input);
  const filename = String(input.filename || "document").trim().slice(0, 240);
  const mimeType = String(input.mimeType || "application/octet-stream").trim().slice(0, 160);
  if (typeof input.base64 !== "string") throw serviceError("DOCUMENT_ATTACHMENT_INVALID", "document base64 is required");
  return {
    ...request,
    filename,
    mimeType,
    size: Math.max(0, Number(input.size) || 0),
    base64: input.base64,
  };
}

function normalizeDeleteRequest(input: Fields = {}) {
  const request = {
    sessionId: id(input.sessionId),
    messageId: id(input.messageId || input.clientMessageId),
    attachmentId: id(input.attachmentId),
    fileId: id(input.fileId),
    docModelId: id(input.docModelId),
  };
  if (Object.values(request).some(value => !value)) {
    throw serviceError("DOCUMENT_ATTACHMENT_INVALID", "document attachment identity is incomplete");
  }
  return request;
}

function id(value: unknown) {
  return String(value || "").trim().slice(0, 160);
}

function serviceError(code: string, message: string) {
  const error = Object.assign(new Error(message), { code });
  return error;
}

function recordAttachmentTrace(trace: (message: string) => void, action: string, phase: string, input: Fields = {}, fields: Fields = {}) {
  try {
    trace(`attachment_trace${formatTraceFields({
      action,
      phase,
      request: id(input.requestId),
      session: id(input.sessionId),
      message: id(input.messageId || input.clientMessageId),
      attachment: id(input.attachmentId),
      file: id(input.fileId),
      model: id(input.docModelId),
      mime: String(input.mimeType || "").trim().slice(0, 160),
      size: Math.max(0, Number(input.size) || 0),
      ...fields,
    })}`);
  } catch (_error) {
    // Diagnostics must never affect attachment ownership or cleanup behavior.
  }
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

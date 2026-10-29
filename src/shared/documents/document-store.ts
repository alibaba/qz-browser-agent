import { requestToPromise, txDone } from "../indexeddb.js";
import type { MessageDocument } from "./document-attachments.js";
import type { DocumentModel } from "./document-codec-registry.js";
interface DocumentOwnership {
  sessionId: string;
  messageId?: string;
  attachmentId?: string;
  runId: string;
  toolCallId: string;
  sourceTool: string;
  createdAt: string;
  updatedAt: string;
}
export interface DocumentFile extends DocumentOwnership {
  id: string;
  filename: string;
  mimeType: string;
  extension: string;
  size: number;
  sourceUrl: string;
  base64: string;
}
export interface SavedDocumentModel extends DocumentModel, DocumentOwnership { id: string; fileId: string }
export interface DocumentArtifact extends DocumentOwnership {
  id: string;
  filename: string;
  mimeType: string;
  format: string;
  size: number;
  sourceFileId: string;
  sourceDocModelId: string;
  base64: string;
}

import { compareBeijingDateTimeDesc, nowBeijingDateTime } from "../time-utils.js";
import { assertMessageDocumentOwnership } from "./document-attachments.js";

const DB_NAME = "qz-browser-agent-documents";
const MIN_DB_VERSION = 1;
const FILES_STORE = "files";
const MODELS_STORE = "models";
const ARTIFACTS_STORE = "artifacts";
let documentDbPromise: Promise<IDBDatabase> | null = null;

export async function saveDocumentFile(file: Partial<DocumentFile> = {}) {
  const now = nowBeijingDateTime();
  const record = {
    id: file.id || createDocumentId("file"),
    filename: String(file.filename || "document").slice(0, 240),
    mimeType: String(file.mimeType || "application/octet-stream").slice(0, 160),
    extension: String(file.extension || "").slice(0, 24),
    size: Number(file.size) || 0,
    sourceUrl: String(file.sourceUrl || "").slice(0, 4000),
    base64: String(file.base64 || ""),
    messageId: String(file.messageId || "").slice(0, 160),
    attachmentId: String(file.attachmentId || "").slice(0, 160),
    ...normalizeDocumentOwnership(file, now),
  };
  const db = await openDocumentDb();
  const tx = db.transaction(FILES_STORE, "readwrite");
  tx.objectStore(FILES_STORE).put(record);
  await txDone(tx);
  return summarizeFileRecord(record)!;
}

export async function getDocumentFile(fileId: string) {
  if (!fileId) throw new Error("fileId is required");
  const db = await openDocumentDb();
  return requestToPromise<DocumentFile | undefined>(db.transaction(FILES_STORE, "readonly").objectStore(FILES_STORE).get(fileId));
}

export async function saveDocumentModel(model: Partial<SavedDocumentModel> = {}) {
  const now = nowBeijingDateTime();
  const record = {
    id: model.id || createDocumentId("model"),
    fileId: String(model.fileId || ""),
    type: String(model.type || "document"),
    title: String(model.title || "Untitled").slice(0, 240),
    blocks: Array.isArray(model.blocks) ? model.blocks : [],
    sheets: Array.isArray(model.sheets) ? model.sheets : [],
    chunks: Array.isArray(model.chunks) ? model.chunks : [],
    chunkSize: clampInt(model.chunkSize, 1000, 50000, 6000),
    outline: Array.isArray(model.outline) ? model.outline : [],
    warnings: Array.isArray(model.warnings) ? model.warnings.map(String).slice(0, 20) : [],
    messageId: String(model.messageId || "").slice(0, 160),
    attachmentId: String(model.attachmentId || "").slice(0, 160),
    ...normalizeDocumentOwnership(model, now),
  };
  const db = await openDocumentDb();
  const tx = db.transaction(MODELS_STORE, "readwrite");
  tx.objectStore(MODELS_STORE).put(record);
  await txDone(tx);
  return summarizeModelRecord(record)!;
}

export async function getDocumentModel(docModelId: string) {
  if (!docModelId) throw new Error("docModelId is required");
  const db = await openDocumentDb();
  return requestToPromise<SavedDocumentModel | undefined>(db.transaction(MODELS_STORE, "readonly").objectStore(MODELS_STORE).get(docModelId));
}

/** Copies queued attachments into an existing draft without changing the queued originals. */
export async function copyMessageDocuments({ sessionId, messageId, targetMessageId, documents }: {
  sessionId: string; messageId: string; targetMessageId: string; documents: unknown;
}): Promise<MessageDocument[]> {
  const refs = assertMessageDocumentOwnership(documents, { sessionId, messageId });
  if (!targetMessageId.trim()) throw new Error("targetMessageId is required");
  if (!refs.length) return [];
  const db = await openDocumentDb();
  const tx = db.transaction([FILES_STORE, MODELS_STORE], "readwrite");
  const completion = txDone(tx);
  const files = tx.objectStore(FILES_STORE);
  const models = tx.objectStore(MODELS_STORE);
  try {
    const copies = await Promise.all(refs.map(async ref => {
      const [file, model] = await Promise.all([
        requestToPromise<DocumentFile | undefined>(files.get(ref.fileId)),
        requestToPromise<SavedDocumentModel | undefined>(models.get(ref.docModelId)),
      ]);
      assertOwnedAttachmentRecord(file, ref, "file");
      assertOwnedAttachmentRecord(model, ref, "model");
      if (!file || !model || model.fileId !== file.id) throw Object.assign(
        new Error("queued document attachment is unavailable"), { code: "DOCUMENT_ATTACHMENT_INVALID" },
      );
      const copy = { ...ref, messageId: targetMessageId, attachmentId: createDocumentId("attachment"),
        fileId: createDocumentId("file"), docModelId: createDocumentId("model") };
      const owner = { messageId: targetMessageId, attachmentId: copy.attachmentId, updatedAt: nowBeijingDateTime() };
      files.put({ ...file, ...owner, id: copy.fileId });
      models.put({ ...model, ...owner, id: copy.docModelId, fileId: copy.fileId });
      return copy;
    }));
    await completion;
    return copies;
  } catch (error) {
    try { tx.abort(); } catch (_abortError) { /* transaction already settled */ }
    await completion.catch(() => null);
    throw error;
  }
}

export async function deleteMessageDocument({ sessionId, messageId, attachmentId, fileId, docModelId }: Partial<MessageDocument> = {}) {
  const result = await deleteMessageDocuments({
    sessionId,
    messageId,
    documents: [{ sessionId, messageId, attachmentId, fileId, docModelId }],
  });
  return {
    deletedFile: result.deletedFileCount > 0,
    deletedModel: result.deletedModelCount > 0,
  };
}

/** Atomically deletes every persisted document owned by one user message. */
export async function deleteMessageDocuments({ sessionId, messageId, documents = [] }: { sessionId?: string; messageId?: string; documents?: unknown } = {}) {
  const owner = {
    sessionId: String(sessionId || "").trim(),
    messageId: String(messageId || "").trim(),
  };
  const refs = assertMessageDocumentOwnership(documents, owner);
  if (!refs.length) return { deletedFileCount: 0, deletedModelCount: 0 };

  const db = await openDocumentDb();
  const tx = db.transaction([FILES_STORE, MODELS_STORE], "readwrite");
  const files = tx.objectStore(FILES_STORE);
  const models = tx.objectStore(MODELS_STORE);
  const completion = txDone(tx);
  try {
    const records = await Promise.all(refs.map(async ref => {
      const [file, model] = await Promise.all([
        requestToPromise<DocumentFile | undefined>(files.get(ref.fileId)),
        requestToPromise<SavedDocumentModel | undefined>(models.get(ref.docModelId)),
      ]);
      const attachmentOwner = { ...owner, attachmentId: ref.attachmentId };
      assertOwnedAttachmentRecord(file, attachmentOwner, "file");
      assertOwnedAttachmentRecord(model, attachmentOwner, "model");
      if (model && model.fileId !== ref.fileId) {
        throw Object.assign(new Error("model does not belong to this message attachment file"), { code: "DOCUMENT_ATTACHMENT_OWNER_MISMATCH" });
      }
      return { file, model };
    }));
    let deletedFileCount = 0;
    let deletedModelCount = 0;
    for (const { file, model } of records) {
      if (file) {
        files.delete(file.id);
        deletedFileCount += 1;
      }
      if (model) {
        models.delete(model.id);
        deletedModelCount += 1;
      }
    }
    await completion;
    return { deletedFileCount, deletedModelCount };
  } catch (error) {
    try { tx.abort(); } catch(_abortError) { /* transaction already settled */ }
    await completion.catch(() => null);
    throw error;
  }
}

/** Deletes all chat attachment records owned by one Session without loading every file body at once. */
export async function deleteSessionMessageDocuments(sessionId: string) {
  const owner = String(sessionId || "").trim();
  if (!owner) return { deletedFileCount: 0, deletedModelCount: 0 };
  const db = await openDocumentDb();
  const tx = db.transaction([FILES_STORE, MODELS_STORE], "readwrite");
  const completion = txDone(tx);
  try {
    const [deletedFileCount, deletedModelCount] = await Promise.all([
      deleteOwnedChatRecords(tx.objectStore(FILES_STORE), owner),
      deleteOwnedChatRecords(tx.objectStore(MODELS_STORE), owner),
    ]);
    await completion;
    return { deletedFileCount, deletedModelCount };
  } catch (error) {
    try { tx.abort(); } catch(_abortError) { /* transaction already settled */ }
    await completion.catch(() => null);
    throw error;
  }
}

export async function saveDocumentArtifact(artifact: Partial<DocumentArtifact> = {}) {
  const now = nowBeijingDateTime();
  const record = {
    id: artifact.id || createDocumentId("artifact"),
    filename: String(artifact.filename || "artifact").slice(0, 240),
    mimeType: String(artifact.mimeType || "application/octet-stream").slice(0, 160),
    format: String(artifact.format || "").slice(0, 24),
    size: Number(artifact.size) || 0,
    sourceFileId: String(artifact.sourceFileId || ""),
    sourceDocModelId: String(artifact.sourceDocModelId || ""),
    base64: String(artifact.base64 || ""),
    ...normalizeDocumentOwnership(artifact, now),
  };
  const db = await openDocumentDb();
  const tx = db.transaction(ARTIFACTS_STORE, "readwrite");
  tx.objectStore(ARTIFACTS_STORE).put(record);
  await txDone(tx);
  return summarizeArtifactRecord(record)!;
}

export async function getDocumentArtifact(artifactId: string) {
  if (!artifactId) throw new Error("artifactId is required");
  const db = await openDocumentDb();
  return requestToPromise<DocumentArtifact | undefined>(db.transaction(ARTIFACTS_STORE, "readonly").objectStore(ARTIFACTS_STORE).get(artifactId));
}

export async function listDocumentArtifacts({ limit = 20, sessionId = "" } = {}) {
  const owner = String(sessionId || "").trim();
  const db = await openDocumentDb();
  const rows = await requestToPromise<DocumentArtifact[]>(db.transaction(ARTIFACTS_STORE, "readonly").objectStore(ARTIFACTS_STORE).getAll());
  return rows
    .filter((record) => !owner || !record.sessionId || record.sessionId === owner)
    .sort((a, b) => compareBeijingDateTimeDesc(a.updatedAt, b.updatedAt))
    .slice(0, clampInt(limit, 1, 100, 20))
    .map(summarizeArtifactRecord);
}

export function summarizeFileRecord(record: DocumentFile | null | undefined) {
  if (!record) return null;
  return {
    fileId: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    extension: record.extension,
    size: record.size,
    sourceUrl: record.sourceUrl || "",
    messageId: record.messageId || "",
    attachmentId: record.attachmentId || "",
    ...summarizeDocumentOwnership(record),
  };
}

export function summarizeModelRecord(record: Partial<SavedDocumentModel> | null | undefined) {
  if (!record) return null;
  return {
    docModelId: record.id,
    fileId: record.fileId,
    type: record.type,
    title: record.title,
    blockCount: record.blocks?.length || 0,
    sheetCount: record.sheets?.length || 0,
    chunkCount: record.chunks?.length || 0,
    chunkSize: clampInt(record.chunkSize, 1000, 50000, 6000),
    outline: (record.outline || []).slice(0, 20),
    sheets: (record.sheets || []).map(sheet => ({
      name: sheet.name,
      columns: Array.isArray(sheet.columns) ? sheet.columns.slice(0, 30) : [],
      rowCount: Array.isArray(sheet.rows) ? sheet.rows.length : 0,
    })),
    warnings: record.warnings || [],
    messageId: record.messageId || "",
    attachmentId: record.attachmentId || "",
    ...summarizeDocumentOwnership(record),
  };
}

export function summarizeArtifactRecord(record: DocumentArtifact | null | undefined) {
  if (!record) return null;
  return {
    artifactId: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    format: record.format,
    size: record.size,
    sourceFileId: record.sourceFileId || "",
    sourceDocModelId: record.sourceDocModelId || "",
    ...summarizeDocumentOwnership(record),
  };
}

function normalizeDocumentOwnership(record: Partial<DocumentOwnership>, now: string) {
  return {
    sessionId: String(record.sessionId || "").slice(0, 120),
    runId: String(record.runId || "").slice(0, 120),
    toolCallId: String(record.toolCallId || "").slice(0, 120),
    sourceTool: String(record.sourceTool || "").slice(0, 120),
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
}

function summarizeDocumentOwnership(record: Partial<DocumentOwnership>) {
  return {
    sessionId: record.sessionId || "",
    runId: record.runId || "",
    toolCallId: record.toolCallId || "",
    sourceTool: record.sourceTool || "",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function openDocumentDb() {
  if (documentDbPromise) return documentDbPromise;
  documentDbPromise = openCompatibleDocumentDb();
  documentDbPromise.catch(() => {
    documentDbPromise = null;
  });
  return documentDbPromise;
}

async function openCompatibleDocumentDb() {
  let db;
  try {
    db = await requestDocumentDb(MIN_DB_VERSION);
  } catch (error) {
    // IndexedDB rejects attempts to open an existing newer database at an
    // older version. Open its current version without downgrading it, then
    // verify that the stores this runtime understands are still compatible.
    if (!error || typeof error !== "object" || !("name" in error) || error.name !== "VersionError") throw error;
    db = await requestDocumentDb();
  }
  try {
    assertCompatibleDocumentDb(db);
  } catch (error) {
    db.close();
    throw error;
  }
  db.onversionchange = () => {
    db.close();
    documentDbPromise = null;
  };
  return db;
}

function assertCompatibleDocumentDb(db: IDBDatabase) {
  const requiredStores = [FILES_STORE, MODELS_STORE, ARTIFACTS_STORE];
  const missingStores = requiredStores.filter(name => !db.objectStoreNames.contains(name));
  if (missingStores.length) {
    throw documentDbSchemaError(`document database is missing stores: ${missingStores.join(", ")}`);
  }
  const tx = db.transaction(requiredStores, "readonly");
  const incompatibleStores = requiredStores.filter(name => tx.objectStore(name).keyPath !== "id");
  if (incompatibleStores.length) {
    throw documentDbSchemaError(`document database has incompatible stores: ${incompatibleStores.join(", ")}`);
  }
}

function documentDbSchemaError(message: string) {
  return Object.assign(new Error(message), { code: "DOCUMENT_DB_SCHEMA_INCOMPATIBLE" });
}

function requestDocumentDb(version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = version == null
      ? indexedDB.open(DB_NAME)
      : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        const files = db.createObjectStore(FILES_STORE, { keyPath: "id" });
        files.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(MODELS_STORE)) {
        const models = db.createObjectStore(MODELS_STORE, { keyPath: "id" });
        models.createIndex("fileId", "fileId", { unique: false });
        models.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) {
        const artifacts = db.createObjectStore(ARTIFACTS_STORE, { keyPath: "id" });
        artifacts.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteOwnedChatRecords(store: IDBObjectStore, sessionId: string) {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(count);
      if (cursor.value.sessionId === sessionId && cursor.value.sourceTool === "chat_attachment") {
        cursor.delete();
        count += 1;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

function createDocumentId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function assertOwnedAttachmentRecord(record: DocumentOwnership | null | undefined, owner: Pick<DocumentOwnership, "sessionId" | "messageId" | "attachmentId">, kind: string) {
  if (!record) return;
  if (
    record.sourceTool !== "chat_attachment"
    || record.sessionId !== owner.sessionId
    || record.messageId !== owner.messageId
    || record.attachmentId !== owner.attachmentId
  ) {
    throw Object.assign(new Error(`${kind} does not belong to this message attachment`), { code: "DOCUMENT_ATTACHMENT_OWNER_MISMATCH" });
  }
}

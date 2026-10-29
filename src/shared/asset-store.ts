import { requestToPromise, txDone } from "./indexeddb.js";
export interface ImageAssetRecord {
  assetId: string;
  blob: Blob;
  thumbBlob: Blob | null;
  sha256: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  pinned: boolean;
}
export interface ImageAssetInput extends Partial<Omit<ImageAssetRecord, "bytes">> {
  dataUrl?: string;
  bytes?: number | Uint8Array<ArrayBuffer> | ArrayBuffer;
  naturalWidth?: number;
  naturalHeight?: number;
}
export interface ImageAssetOptions {
  maxImages?: number;
  maxBytes?: number;
  thumbnail?: boolean;
  thumbMaxSize?: number;
  touch?: boolean;
}

import { nowBeijingDateTime } from "./time-utils.js";

const DB_NAME = "qz-browser-agent-assets";
const DB_VERSION = 2;
const IMAGE_ASSETS_STORE = "image_assets";
const DEFAULT_MAX_IMAGES = 2000;
const DEFAULT_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const DEFAULT_THUMB_MAX_SIZE = 512;
// Durable Session payloads are not a cache: image GC and explicit gallery deletion
// must never evict them. Keep the exact URL spelling for lossless model replay.
const HISTORY_IMAGES_STORE = "history_images";
export const HISTORY_IMAGE_PREFIX = "qz-history-image:v1:";
const assetConnections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

export async function saveHistoryImage(dataUrl: string): Promise<string> {
  const blob = new Blob([dataUrl], { type: "text/plain;charset=utf-8" });
  const assetId = `${HISTORY_IMAGE_PREFIX}${await sha256Blob(blob)}`;
  const db = await openAssetDb();
  // The read and insert share a transaction, including across extension contexts.
  const tx = db.transaction(HISTORY_IMAGES_STORE, "readwrite");
  const done = txDone(tx);
  const store = tx.objectStore(HISTORY_IMAGES_STORE);
  const request = store.getKey(assetId);
  request.onsuccess = () => {
    if (request.result === undefined) store.add({ assetId, blob });
  };
  await done;
  return assetId;
}

export async function getHistoryImage(assetId: string): Promise<string | null> {
  const db = await openAssetDb();
  const tx = db.transaction(HISTORY_IMAGES_STORE, "readonly");
  const done = txDone(tx);
  const [record] = await Promise.all([
    requestToPromise<{ blob: Blob } | undefined>(tx.objectStore(HISTORY_IMAGES_STORE).get(assetId)), done,
  ]);
  return record ? record.blob.text() : null;
}

/** Called only by the repository's exclusive sweep, after marking persisted and in-flight references. */
export async function sweepHistoryImages(references: ReadonlySet<string>): Promise<string[]> {
  const db = await openAssetDb();
  const tx = db.transaction(HISTORY_IMAGES_STORE, "readwrite");
  const done = txDone(tx);
  const store = tx.objectStore(HISTORY_IMAGES_STORE);
  const deleted: string[] = [];
  const request = store.getAllKeys();
  request.onsuccess = () => {
    for (const key of request.result) {
      if (typeof key === "string" && !references.has(key)) {
        store.delete(key);
        deleted.push(key);
      }
    }
  };
  await done;
  return deleted;
}

export async function saveImageAsset(input: ImageAssetInput = {}, options: ImageAssetOptions = {}) {
  const blob = await normalizeImageBlob(input);
  const bytes = Number(blob.size || input.bytes || 0);
  const mimeType = normalizeMimeType(input.mimeType || blob.type || "image/jpeg");
  const hash = input.sha256 || await sha256Blob(blob);
  const now = nowBeijingDateTime();
  const limits = normalizeAssetLimits(options);
  const db = await openAssetDb();
  const refresh = (existing: ImageAssetRecord) => sanitizeAssetRecord({
    ...existing,
    mimeType: existing.mimeType || mimeType,
    bytes: Number(existing.bytes || bytes || 0),
    width: existing.width || input.width,
    height: existing.height || input.height,
    sourceWidth: existing.sourceWidth || input.sourceWidth || input.naturalWidth,
    sourceHeight: existing.sourceHeight || input.sourceHeight || input.naturalHeight,
    updatedAt: now,
    lastAccessedAt: now,
  });
  const existing = await findImageAssetByHash(db, hash);

  if (existing) {
    const tx = db.transaction(IMAGE_ASSETS_STORE, "readwrite");
    const store = tx.objectStore(IMAGE_ASSETS_STORE);
    const next = refresh(existing);
    store.put(next);
    await txDone(tx);
    return { ...stripBinary(next), deduped: true };
  }

  const stats = await getImageAssetStats();
  if (stats.count >= limits.maxImages) {
    throw new Error(`image asset limit exceeded: ${stats.count}/${limits.maxImages}`);
  }
  if (stats.totalBytes + bytes > limits.maxBytes) {
    throw new Error(`image asset storage limit exceeded: ${formatBytes(stats.totalBytes + bytes)}/${formatBytes(limits.maxBytes)}`);
  }

  const thumbBlob = options.thumbnail !== false ? await createThumbnailBlob(blob, {
    maxSize: options.thumbMaxSize || DEFAULT_THUMB_MAX_SIZE,
  }) : null;
  const record = sanitizeAssetRecord({
    assetId: input.assetId || createImageAssetId(),
    blob,
    thumbBlob,
    sha256: hash,
    mimeType,
    bytes,
    width: input.width,
    height: input.height,
    sourceWidth: input.sourceWidth || input.naturalWidth,
    sourceHeight: input.sourceHeight || input.naturalHeight,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  });

  const tx = db.transaction(IMAGE_ASSETS_STORE, "readwrite");
  const done = txDone(tx);
  const store = tx.objectStore(IMAGE_ASSETS_STORE);
  // Other Sessions/contexts can finish the same image while hashing or making
  // its thumbnail. Recheck the unique index inside the insertion transaction.
  let saved = record;
  let deduped = false;
  const request = store.index("sha256").get(hash);
  request.onsuccess = () => {
    if (request.result) {
      saved = refresh(request.result);
      deduped = true;
      store.put(saved);
    } else {
      store.add(record);
    }
  };
  await done;
  return { ...stripBinary(saved), deduped };
}

export async function getImageAsset(assetId: string, options: ImageAssetOptions = {}) {
  const id = normalizeAssetId(assetId);
  const db = await openAssetDb();
  const tx = db.transaction(IMAGE_ASSETS_STORE, options.touch === false ? "readonly" : "readwrite");
  const store = tx.objectStore(IMAGE_ASSETS_STORE);
  const record = await requestToPromise<ImageAssetRecord | undefined>(store.get(id));
  if (record && options.touch !== false) {
    store.put({
      ...record,
      lastAccessedAt: nowBeijingDateTime(),
    });
  }
  await txDone(tx);
  return record || null;
}

export async function getImageAssetDataUrl(assetId: string, options: ImageAssetOptions = {}) {
  const record = await getImageAsset(assetId, options);
  if (!record?.blob) return null;
  return {
    ...stripBinary(record),
    dataUrl: await blobToDataUrl(record.blob),
  };
}

export async function getImageAssetObjectUrl(assetId: string, options: ImageAssetOptions = {}) {
  const record = await getImageAsset(assetId, options);
  const blob = options.thumbnail && record?.thumbBlob ? record.thumbBlob : record?.blob;
  if (!record || !blob) return null;
  return {
    ...stripBinary(record),
    objectUrl: URL.createObjectURL(blob),
    thumbnail: Boolean(options.thumbnail && record?.thumbBlob),
  };
}

export async function getImageAssetStats() {
  const db = await openAssetDb();
  const tx = db.transaction(IMAGE_ASSETS_STORE, "readonly");
  const rows = await requestToPromise<ImageAssetRecord[]>(tx.objectStore(IMAGE_ASSETS_STORE).getAll());
  await txDone(tx);
  return summarizeAssets(rows);
}

export async function deleteImageAsset(assetId: string) {
  const id = normalizeAssetId(assetId);
  const db = await openAssetDb();
  const tx = db.transaction(IMAGE_ASSETS_STORE, "readwrite");
  const store = tx.objectStore(IMAGE_ASSETS_STORE);
  const existing = await requestToPromise<ImageAssetRecord | undefined>(store.get(id));
  if (existing) store.delete(id);
  await txDone(tx);
  return { deleted: Boolean(existing), assetId: id };
}

export async function gcImageAssets({ maxImages = DEFAULT_MAX_IMAGES, maxBytes = DEFAULT_MAX_BYTES, dryRun = true } = {}) {
  const db = await openAssetDb();
  const tx = db.transaction(IMAGE_ASSETS_STORE, dryRun ? "readonly" : "readwrite");
  const store = tx.objectStore(IMAGE_ASSETS_STORE);
  const rows = await requestToPromise<ImageAssetRecord[]>(store.getAll());
  const before = summarizeAssets(rows);
  const candidates = rows
    .filter(row => !row.pinned)
    .sort((a, b) => String(a.lastAccessedAt || a.updatedAt || a.createdAt || "").localeCompare(String(b.lastAccessedAt || b.updatedAt || b.createdAt || "")));
  let count = before.count;
  let totalBytes = before.totalBytes;
  const deleted = [];

  for (const row of candidates) {
    if (count <= maxImages && totalBytes <= maxBytes) break;
    deleted.push(stripBinary(row));
    count -= 1;
    totalBytes -= Number(row.bytes || row.blob?.size || 0);
    if (!dryRun) store.delete(row.assetId);
  }

  await txDone(tx);
  return {
    dryRun: Boolean(dryRun),
    before,
    after: { count, totalBytes },
    deleted,
  };
}

export async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(String(dataUrl || ""));
  return response.blob();
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function normalizeImageBlob(input: ImageAssetInput = {}) {
  if (input.blob instanceof Blob) return input.blob;
  if (input.dataUrl) return dataUrlToBlob(input.dataUrl);
  if (input.bytes instanceof Uint8Array || input.bytes instanceof ArrayBuffer) {
    return new Blob([input.bytes], { type: normalizeMimeType(input.mimeType || "image/jpeg") });
  }
  throw new Error("image asset requires blob, dataUrl, or bytes");
}

async function findImageAssetByHash(db: IDBDatabase, hash: string) {
  if (!hash) return null;
  const tx = db.transaction(IMAGE_ASSETS_STORE, "readonly");
  const store = tx.objectStore(IMAGE_ASSETS_STORE);
  const record = await requestToPromise<ImageAssetRecord | undefined>(store.index("sha256").get(hash));
  await txDone(tx);
  return record || null;
}

async function createThumbnailBlob(blob: Blob, { maxSize = DEFAULT_THUMB_MAX_SIZE } = {}) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const sourceWidth = Math.max(1, bitmap.width || 1);
      const sourceHeight = Math.max(1, bitmap.height || 1);
      const scale = Math.min(1, maxSize / sourceWidth, maxSize / sourceHeight);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    } finally {
      bitmap.close?.();
    }
  } catch(_err) {
    return null;
  }
}

async function sha256Blob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function openAssetDb(): Promise<IDBDatabase> {
  const factory = indexedDB;
  const existing = assetConnections.get(factory);
  if (existing) return existing;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HISTORY_IMAGES_STORE)) {
        db.createObjectStore(HISTORY_IMAGES_STORE, { keyPath: "assetId" });
      }
      if (!db.objectStoreNames.contains(IMAGE_ASSETS_STORE)) {
        const store = db.createObjectStore(IMAGE_ASSETS_STORE, { keyPath: "assetId" });
        store.createIndex("sha256", "sha256", { unique: true });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("lastAccessedAt", "lastAccessedAt", { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const retire = () => {
        db.close();
        if (assetConnections.get(factory) === opening) assetConnections.delete(factory);
      };
      db.onversionchange = retire;
      db.onclose = retire;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("Failed to open asset IndexedDB"));
  });
  assetConnections.set(factory, opening);
  void opening.catch(() => {
    if (assetConnections.get(factory) === opening) assetConnections.delete(factory);
  });
  return opening;
}

function stripBinary(record: ImageAssetRecord) {
  const { blob, thumbBlob, ...rest } = record;
  return rest;
}

function sanitizeAssetRecord(record: Partial<ImageAssetRecord> & { assetId: string; blob: Blob }) {
  return {
    assetId: normalizeAssetId(record.assetId),
    blob: record.blob,
    thumbBlob: record.thumbBlob || null,
    sha256: String(record.sha256 || ""),
    mimeType: normalizeMimeType(record.mimeType || record.blob?.type || "image/jpeg"),
    bytes: Number(record.bytes || record.blob?.size || 0),
    width: positiveInt(record.width),
    height: positiveInt(record.height),
    sourceWidth: positiveInt(record.sourceWidth),
    sourceHeight: positiveInt(record.sourceHeight),
    createdAt: String(record.createdAt || nowBeijingDateTime()),
    updatedAt: String(record.updatedAt || nowBeijingDateTime()),
    lastAccessedAt: String(record.lastAccessedAt || record.updatedAt || nowBeijingDateTime()),
    pinned: Boolean(record.pinned),
  };
}

function summarizeAssets(rows: readonly ImageAssetRecord[] = []) {
  return {
    count: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.bytes || row.blob?.size || 0), 0),
  };
}

function normalizeAssetLimits(options: ImageAssetOptions = {}) {
  return {
    maxImages: clampInt(options.maxImages, 1, 10000, DEFAULT_MAX_IMAGES),
    maxBytes: clampInt(options.maxBytes, 1024 * 1024, 10 * 1024 * 1024 * 1024, DEFAULT_MAX_BYTES),
  };
}

function normalizeAssetId(assetId: unknown) {
  const id = String(assetId || "").trim();
  if (!id) throw new Error("assetId is required");
  return id.slice(0, 180);
}

function createImageAssetId() {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `asset:image:${id}`;
}

function normalizeMimeType(value: unknown = "") {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime || "image/jpeg";
}

function positiveInt(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function formatBytes(bytes: number) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

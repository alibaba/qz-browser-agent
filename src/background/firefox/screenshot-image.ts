import { bytesToBase64 } from "./pdf-raster.js";

export interface ImageClip { x: number; y: number; width: number; height: number; scale: number }

/** Crop a captured viewport image. Coordinates are CSS pixels in that viewport. */
export async function cropDataUrl(dataUrl: string, clip: ImageClip, cssWidth: number, cssHeight: number, format: string): Promise<string> {
  const bytes = decodeDataUrl(dataUrl);
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return stripDataUrl(dataUrl);
  const bitmap = await createImageBitmap(bytesBlob(bytes));
  const scaleX = cssWidth > 0 ? bitmap.width / cssWidth : 1;
  const scaleY = cssHeight > 0 ? bitmap.height / cssHeight : 1;
  const sx = clamp(Math.round(clip.x * scaleX), 0, Math.max(0, bitmap.width - 1));
  const sy = clamp(Math.round(clip.y * scaleY), 0, Math.max(0, bitmap.height - 1));
  const sw = clamp(Math.round(clip.width * scaleX), 1, bitmap.width - sx);
  const sh = clamp(Math.round(clip.height * scaleY), 1, bitmap.height - sy);
  const ratio = clip.scale > 0 ? clip.scale : 1;
  const width = Math.max(1, Math.round(sw / scaleX * ratio));
  const height = Math.max(1, Math.round(sh / scaleY * ratio));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return stripDataUrl(dataUrl);
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  bitmap.close();
  return blobToBase64(await canvas.convertToBlob({ type: imageType(format), quality: 0.9 }));
}

/** Place captured pieces in rows, then apply the screenshot scale. */
export async function stitchTiles(rows: readonly (readonly string[])[], scale: number, format: string): Promise<string> {
  const flat = rows.flatMap(row => row.filter(tile => tile));
  if (!flat.length) return "";
  if (rows.every(row => row.length <= 1)) return stackTiles(flat, scale, format);
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return flat[0];
  const decoded = await Promise.all(rows.map(row => Promise.all(row.map(tile => createImageBitmap(bytesBlob(decodeBase64(tile)))))));
  const rowWidths = decoded.map(row => row.reduce((sum, bitmap) => sum + bitmap.width, 0));
  const rowHeights = decoded.map(row => row.reduce((max, bitmap) => Math.max(max, bitmap.height), 0));
  const width = Math.max(1, ...rowWidths);
  const height = rowHeights.reduce((sum, value) => sum + value, 0) || 1;
  const ratio = scale > 0 ? scale : 1;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
  const context = canvas.getContext("2d");
  if (!context) {
    for (const row of decoded) for (const bitmap of row) bitmap.close();
    return flat[0];
  }
  let y = 0;
  for (let rowIndex = 0; rowIndex < decoded.length; rowIndex += 1) {
    let x = 0;
    for (const bitmap of decoded[rowIndex]) {
      context.drawImage(bitmap, x, y, bitmap.width * ratio, bitmap.height * ratio);
      x += bitmap.width * ratio;
      bitmap.close();
    }
    y += rowHeights[rowIndex] * ratio;
  }
  return blobToBase64(await canvas.convertToBlob({ type: imageType(format), quality: 0.9 }));
}

/** Stack viewport tiles from top to bottom and apply the screenshot scale. */
export async function stackTiles(tiles: readonly string[], scale: number, format: string): Promise<string> {
  if (!tiles.length) return "";
  if (tiles.length === 1 && scale === 1) return tiles[0];
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return tiles[0];
  const bitmaps = await Promise.all(tiles.map(tile => createImageBitmap(bytesBlob(decodeBase64(tile)))));
  const width = Math.max(1, ...bitmaps.map(bitmap => bitmap.width));
  const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0) || 1;
  const ratio = scale > 0 ? scale : 1;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
  const context = canvas.getContext("2d");
  if (!context) return tiles[0];
  let y = 0;
  for (const bitmap of bitmaps) {
    context.drawImage(bitmap, 0, y, bitmap.width * ratio, bitmap.height * ratio);
    y += bitmap.height * ratio;
    bitmap.close();
  }
  return blobToBase64(await canvas.convertToBlob({ type: imageType(format), quality: 0.9 }));
}

export function decodeDataUrl(value: string): Uint8Array {
  return decodeBase64(stripDataUrl(value));
}

export function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return comma >= 0 && value.startsWith("data:") ? value.slice(comma + 1) : value;
}

function bytesBlob(bytes: Uint8Array): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

function imageType(format: string): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

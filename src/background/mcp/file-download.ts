import { bytesToBase64 } from "../../shared/bytes.js";
import { productText } from "../../shared/product-text.js";

interface DownloadInput { bytes: Uint8Array; filename: string; mimeType: string }
type Downloads = Pick<typeof chrome.downloads, "download" | "search">;
interface DownloadWait { waitMs?: number; pollMs?: number }

/** Service Workers use data URLs; binary contents stay out of the MCP response. */
export async function downloadMcpFile(input: DownloadInput, downloads: Downloads = chrome.downloads, wait: DownloadWait = {}) {
  const filename = safeMcpFilename(input.filename);
  const mimeType = input.mimeType;
  const downloadId = await downloads.download({
    url: `data:${mimeType};base64,${bytesToBase64(input.bytes)}`,
    filename, saveAs: false,
  });
  if (!Number.isInteger(downloadId) || downloadId < 0) {
    throw Object.assign(new Error(productText("Chrome did not accept the download.", "Firefox did not accept the download.")), { code: "DOWNLOAD_FAILED" });
  }
  const deadline = Date.now() + Math.min(5_000, Math.max(0, wait.waitMs ?? 5_000));
  let item: chrome.downloads.DownloadItem | undefined;
  do {
    item = await downloads.search({ id: downloadId }).then(items => items[0]).catch(() => undefined);
    if (item?.state === "interrupted" || (item?.state === "complete" && item.filename)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, Math.max(1, wait.pollMs ?? 100))));
  } while (Date.now() < deadline);
  if (item?.state === "interrupted") {
    throw Object.assign(new Error(productText(
      "Chrome interrupted the download. Inspect Chrome downloads before retrying.",
      "Firefox interrupted the download. Inspect Firefox downloads before retrying.",
    )), {
      code: "DOWNLOAD_INTERRUPTED", details: { downloadId, filename, reason: item.error || "unknown" },
    });
  }
  const fileUrl = localFileUrl(item?.filename || "");
  return {
    downloadId, filename, mimeType, bytes: input.bytes.byteLength, state: item?.state || "in_progress",
    ...(fileUrl ? { fileUrl, filepath: item!.filename } : {}),
    ...(item?.state !== "complete" ? { hint: productText("Chrome is still saving this download. Check its status in chrome://downloads.", "Firefox is still saving this download. Check its status in about:downloads.") }
      : !fileUrl ? { hint: productText("Chrome completed the download. Find the file in chrome://downloads.", "Firefox completed the download. Find the file in about:downloads.") } : {}),
  };
}

/** Query accepted downloads without opening them or returning their source data URLs. */
export async function listMcpDownloads(params: Record<string, unknown> = {}, downloads: Pick<Downloads, "search"> = chrome.downloads) {
  const id = params.id;
  const limit = params.limit ?? 20;
  if (id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0)) {
    throw Object.assign(new Error("id must be a non-negative integer."), { code: "INVALID_ARGUMENTS" });
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error("limit must be an integer between 1 and 100."), { code: "INVALID_ARGUMENTS" });
  }
  const items = await downloads.search(id === undefined ? { limit, orderBy: ["-startTime"] } : { id });
  return { downloads: items.map(item => ({
    downloadId: item.id, filename: item.filename.replace(/\\/g, "/").split("/").at(-1) || "",
    filepath: item.filename, fileUrl: localFileUrl(item.filename), state: item.state,
    bytes: item.fileSize >= 0 ? item.fileSize : item.bytesReceived,
    ...(item.error ? { error: item.error } : {}),
  })) };
}

/** Chrome filenames are relative to Downloads; callers cannot select an arbitrary directory. */
export function safeMcpFilename(value: string) {
  let filename = String(value || "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 180);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = `_${filename}`;
  return filename || "qz-export";
}

function localFileUrl(filename: string) {
  const path = filename.replace(/\\/g, "/");
  if (/[\u0000-\u001f\u007f]/.test(path) || (!path.startsWith("/") && !/^[a-z]:\//i.test(path))) return "";
  const encoded = path.split("/").map(encodeURIComponent).join("/").replace(/^([a-z])%3A\//i, "$1:/");
  try {
    return new URL(path.startsWith("//") ? `file:${encoded}` : `file://${path.startsWith("/") ? "" : "/"}${encoded}`).href;
  } catch { return ""; }
}

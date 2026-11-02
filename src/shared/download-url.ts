import { base64ToBytes, bytesToBase64 } from "./bytes.js";

type Content = { text: string } | { base64: string } | { bytes: Uint8Array };
const BLOB_URL_LIFETIME_MS = 60_000;

/**
 * URL for chrome.downloads.download. Firefox rejects data: URLs there ("Access denied for URL data:");
 * its background page has URL.createObjectURL, so it gets a blob: URL that is revoked after the
 * download has had time to start. Chrome's service worker lacks createObjectURL and keeps the data: URL.
 */
export function createDownloadUrl(mimeType: string, content: Content, urlApi: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
  if (typeof urlApi.createObjectURL === "function") {
    const part = "text" in content ? content.text : "bytes" in content ? content.bytes : base64ToBytes(content.base64);
    const url = urlApi.createObjectURL(new Blob([part as BlobPart], { type: mimeType }));
    return { url, release: () => { setTimeout(() => urlApi.revokeObjectURL(url), BLOB_URL_LIFETIME_MS); } };
  }
  const base64 = "text" in content ? btoa(unescape(encodeURIComponent(content.text)))
    : "bytes" in content ? bytesToBase64(content.bytes) : content.base64;
  return { url: `data:${mimeType};base64,${base64}`, release: () => {} };
}

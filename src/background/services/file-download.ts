import { bytesToBase64 } from "../../shared/bytes.js";

type DownloadOptions = Omit<chrome.downloads.DownloadOptions, "url">;

/** Firefox background pages require blob URLs; Chrome service workers use data URLs. */
export async function downloadBytes(
  bytes: Uint8Array,
  mimeType: string,
  options: DownloadOptions,
  downloads: Pick<typeof chrome.downloads, "download"> = chrome.downloads,
) {
  const objectUrl = typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(new Blob([bytes.slice()], { type: mimeType })) : undefined;
  const url = objectUrl || `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  try {
    const id = await downloads.download({ ...options, url });
    // Keep the URL alive through the save dialog and let the accepted download consume it.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return id;
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

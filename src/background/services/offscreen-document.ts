import { productText } from "../../shared/product-text.js";

export interface OffscreenOptions {
  offscreen?: Pick<typeof chrome.offscreen, "createDocument"> & Partial<Pick<typeof chrome.offscreen, "hasDocument" | "Reason">>;
  runtime?: Pick<typeof chrome.runtime, "getURL">;
  clients?: { matchAll(): Promise<readonly { url: string }[]> };
  documentPath?: string;
}
interface OffscreenDocument { existed: boolean }
// All consumers of the same Chrome API share one in-flight creation operation.
const pending = new WeakMap<object, Promise<OffscreenDocument>>();
export function ensureOffscreenDocument({
  offscreen = globalThis.chrome?.offscreen,
  runtime = globalThis.chrome?.runtime,
  clients = (globalThis as { clients?: OffscreenOptions["clients"] }).clients,
  documentPath = "offscreen.html",
}: OffscreenOptions = {}): Promise<OffscreenDocument> {
  if (!offscreen?.createDocument) return Promise.reject(new Error(productText("Chrome offscreen documents are not available.", "Firefox offscreen documents are not available.")));
  const existing = pending.get(offscreen);
  if (existing) return existing;
  const exists = async () => {
    if (await offscreen.hasDocument?.()) return true;
    if (!clients?.matchAll || !runtime?.getURL) return false;
    return (await clients.matchAll()).some(client => client.url === runtime.getURL(documentPath));
  };
  const operation = (async () => {
    if (await exists()) return { existed: true };
    try {
      await offscreen.createDocument({
        url: documentPath,
        reasons: [
          offscreen.Reason?.BLOBS || "BLOBS" as chrome.offscreen.Reason,
          offscreen.Reason?.USER_MEDIA || "USER_MEDIA" as chrome.offscreen.Reason,
          offscreen.Reason?.AUDIO_PLAYBACK || "AUDIO_PLAYBACK" as chrome.offscreen.Reason,
        ],
        justification: "Host internal scripts, image conversion, tab audio capture and session keepalive.",
      });
      return { existed: false };
    } catch (error) {
      if (await exists()) return { existed: true };
      throw error;
    }
  })().finally(() => { pending.delete(offscreen); });
  pending.set(offscreen, operation);
  return operation;
}

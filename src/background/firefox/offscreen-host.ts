/** Host run_script and SVG raster in a hidden frame of the event page. */

export function installOffscreenHost(chromeApi: OffscreenChrome, doc: HostDocument | undefined = hostDocument()): void {
  if (typeof chromeApi.offscreen?.createDocument === "function") return;
  const path = "offscreen.html";
  let frame: HostFrame | null = null;
  let windowId: number | null = null;
  let ready = false;
  let opening: Promise<void> | null = null;
  const url = () => chromeApi.runtime?.getURL?.(path) || path;
  const hasDocument = async () => {
    if (frame && frame.isConnected === false) {
      frame = null;
      ready = false;
    }
    if (ready && frame?.isConnected) return true;
    if (windowId == null || !chromeApi.windows?.get) return false;
    try {
      await chromeApi.windows.get(windowId);
      return true;
    } catch {
      windowId = null;
      return false;
    }
  };
  const createDocument = () => {
    if (!opening) opening = open().finally(() => { opening = null; });
    return opening;
  };
  const open = async () => {
    if (await hasDocument()) return;
    const current = doc?.createElement ? doc : hostDocument();
    const parent = current ? await parentOf(current) : null;
    if (parent && current?.createElement) {
      await loadFrame(parent, current);
      return;
    }
    if (!chromeApi.windows?.create) throw new Error("Firefox offscreen host has no document");
    console.info("[轻舟] firefox offscreen uses a minimized window");
    const created = await chromeApi.windows.create({ url: url(), type: "popup", state: "minimized", focused: false, width: 200, height: 200 });
    const id = Number(created?.id);
    if (!Number.isInteger(id) || id < 0) throw new Error("Firefox offscreen window was not created");
    windowId = id;
  };
  const loadFrame = async (parent: HostParent, current: HostDocument) => {
    const next = current.createElement("iframe");
    if (!next) throw new Error("Firefox offscreen host has no document");
    const expected = url();
    next.src = expected;
    next.hidden = true;
    if (next.style) next.style.cssText = "position:absolute;width:0;height:0;border:0;";
    const loaded = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        next.removeEventListener?.("load", onLoad);
        next.removeEventListener?.("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onLoad = () => {
        const href = frameHref(next);
        if (href === "about:blank") return;
        if (href && href !== expected && !href.endsWith(`/${path}`)) return;
        finish();
      };
      const onError = () => finish(new Error("Firefox offscreen frame failed to load"));
      next.addEventListener?.("load", onLoad);
      next.addEventListener?.("error", onError);
    });
    parent.appendChild(next);
    frame = next;
    ready = false;
    try {
      await loaded;
      if (frame !== next || next.isConnected === false) throw new Error("Firefox offscreen frame failed to load");
      ready = true;
    } catch (error) {
      ready = false;
      if (frame === next) frame = null;
      dropFrame(parent, next);
      throw error;
    }
  };
  chromeApi.offscreen = {
    createDocument,
    hasDocument,
    Reason: { BLOBS: "BLOBS", USER_MEDIA: "USER_MEDIA", AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
  };
}

async function parentOf(current: HostDocument): Promise<HostParent | null> {
  if (current.documentElement) return current.documentElement;
  if (current.readyState === "loading" && current.addEventListener) {
    await new Promise<void>(resolve => {
      current.addEventListener?.("DOMContentLoaded", () => resolve(), { once: true });
    });
  }
  return current.documentElement;
}

function frameHref(frame: HostFrame): string {
  try { return String(frame.contentDocument?.URL || frame.contentWindow?.location?.href || ""); }
  catch { return ""; }
}

function dropFrame(parent: HostParent, frame: HostFrame) {
  try { frame.remove?.(); } catch { /* The frame is already gone. */ }
  try { parent.removeChild?.(frame); } catch { /* The frame is already gone. */ }
}

function hostDocument(): HostDocument | undefined {
  return (globalThis as { document?: HostDocument }).document;
}

interface HostFrame {
  src: string; hidden?: boolean; isConnected?: boolean; style?: { cssText: string };
  contentDocument?: { URL?: string } | null;
  contentWindow?: { location?: { href?: string } } | null;
  addEventListener?(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: string, listener: () => void): void;
  remove?(): void;
}
interface HostParent { appendChild(node: HostFrame): void; removeChild?(node: HostFrame): void }
interface HostDocument {
  documentElement: HostParent | null;
  readyState?: string;
  createElement(tag: string): HostFrame;
  addEventListener?(type: string, listener: () => void, options?: { once?: boolean }): void;
}
interface OffscreenChrome {
  runtime?: { getURL?(path: string): string };
  offscreen?: { createDocument?: () => unknown; hasDocument?: () => unknown; Reason?: unknown };
  windows?: {
    get?(id: number): Promise<unknown>;
    create?(options: { url: string; type: string; state: string; focused: boolean; width: number; height: number }): Promise<{ id?: number } | undefined>;
  };
}
